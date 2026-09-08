import type { PoolClient } from 'pg';
import { tx } from './pool.js';
import type { SaveState, AccountStash, Item } from '@dm/shared';
import { isUuid } from '@dm/shared';

/**
 * Предметы как данные (Ф2): леджер `items` + журнал `item_events`.
 *
 * КАК ЭТО УСТРОЕНО И ПОЧЕМУ ИМЕННО ТАК.
 *
 * Оперативная форма предмета осталась прежней — вещи лежат в сейве персонажа и в сундуке.
 * Переписывать всю экономику (`townActions`, `stashActions`, инвентарь-сетка) на работу через
 * базу значило бы переписать и клиент, и симулятор, и тесты; выигрыша по надёжности это не
 * дало бы, потому что источник правды всё равно один — сервер.
 *
 * Вместо этого база ведёт ПРОЕКЦИЮ: при каждой записи сейва мы сравниваем, какие вещи у
 * персонажа (и в сундуке) есть сейчас, с тем, что записано в леджере, и записываем РАЗНИЦУ
 * переходами в журнал. Проекция считается в ТОЙ ЖЕ транзакции, что и сейв, поэтому разъехаться
 * они не могут: либо записано и то и другое, либо ничего.
 *
 * Что это даёт:
 *  • у вещи ровно одна строка и ровно одно место — «быть в двух местах» физически негде;
 *  • любое перемещение попадает в журнал, который нельзя переписать (триггер в базе);
 *  • приход вещи из ЧУЖОГО аккаунта — жёсткая ошибка: торговли в игре нет, значит такой
 *    переход означает либо дюп, либо ошибку в нашем коде, и запись отклоняется целиком.
 *
 * Чего это НЕ даёт: причины перехода журнал знает лишь настолько, насколько её передали
 * (`reason`), и видит мир с точностью до автосейва — между сохранениями истина в памяти.
 */

/** Место вещи в леджере. `char:<charId>` — у персонажа, `stash` — в сундуке аккаунта. */
export type ItemLoc = string;
export const LOC_STASH = 'stash';
/** Ушла от аккаунта: продана, выброшена на землю, уничтожена. Возврат оттуда возможен. */
export const LOC_WORLD = 'world';
/**
 * Отозвана администрацией (дюп, разбор инцидента). Возврат НЕВОЗМОЖЕН: попытка записать такую
 * вещь в сейв отклоняется. Иначе отзыв по живому серверу не имел бы смысла — ближайший
 * автосейв игрока вписал бы вещь обратно.
 */
export const LOC_REVOKED = 'revoked';
export const locOfChar = (charId: string): ItemLoc => `char:${charId}`;

/** Все вещи персонажа: экипировка + инвентарь + пояс. Сундук сюда НЕ входит. */
export function itemsOfSave(save: SaveState): Item[] {
  const out: Item[] = [];
  for (const it of Object.values(save.equipment)) if (it) out.push(it);
  for (const it of save.inventory) out.push(it);
  for (const it of save.belt) if (it) out.push(it);
  return out;
}

/** Все вещи сундука аккаунта (по всем вкладкам). */
export function itemsOfStash(stash: AccountStash): Item[] {
  const out: Item[] = [];
  for (const tab of stash.tabs) for (const it of tab) out.push(it);
  return out;
}

interface Row { id: string; loc: string; user_id: string; data: Item }

/** Нарушение инварианта леджера. Запись сейва отменяется целиком. */
export class LedgerViolation extends Error {}

/**
 * Свести леджер с тем, что реально лежит у персонажа (и, если передан, в сундуке).
 *
 * Зовётся ВНУТРИ транзакции записи сейва — свой клиент обязателен: уйди запрос в другое
 * соединение пула, и он окажется вне транзакции, а «атомарность» станет ложной.
 *
 * `stash === undefined` означает «сундук в этой записи не участвует»: тогда вещи, лежащие
 * в сундуке, не считаются пропавшими. Без этой оговорки обычный автосейв персонажа объявлял
 * бы весь сундук утраченным.
 */
export async function syncItems(
  c: PoolClient, userId: string, charId: string, save: SaveState,
  stash: AccountStash | undefined, reason: string,
): Promise<void> {
  const charLoc = locOfChar(charId);
  // Что должно быть: id → место.
  const want = new Map<string, { loc: ItemLoc; item: Item }>();
  for (const it of itemsOfSave(save)) want.set(it.uid, { loc: charLoc, item: it });
  if (stash) for (const it of itemsOfStash(stash)) want.set(it.uid, { loc: LOC_STASH, item: it });

  // Старые сейвы (до Ф2) несут id вида `it_…`. Их в леджер не пускаем: он про UUID.
  // Тихо пропускаем, но считаем — число видно в аудите.
  for (const id of [...want.keys()]) if (!isUuid(id)) want.delete(id);

  // Что записано: только те места, которые эта запись имеет право менять.
  const locs = stash ? [charLoc, LOC_STASH] : [charLoc];
  const have = new Map<string, Row>();
  // Фильтр по аккаунту ОБЯЗАТЕЛЕН: место `stash` одинаково у всех пользователей, и без него
  // автосейв одного игрока объявил бы «пропавшими» сундуки всех остальных.
  const rows = await c.query<Row>(
    'SELECT id, loc, user_id, data FROM items WHERE user_id = $2 AND loc = ANY($1)', [locs, userId]);
  for (const r of rows.rows) have.set(r.id, r);

  const ids = [...want.keys()];
  // Вещи, которых в наших местах нет: либо новые, либо пришли откуда-то ещё (земля, сундук).
  const foreign = ids.length
    ? (await c.query<Row>('SELECT id, loc, user_id, data FROM items WHERE id = ANY($1)', [ids])).rows
    : [];
  const known = new Map<string, Row>(foreign.map((r) => [r.id, r]));

  for (const [id, w] of want) {
    const cur = known.get(id);
    if (!cur) {
      await c.query(
        `INSERT INTO items (id, user_id, loc, base_id, data) VALUES ($1, $2, $3, $4, $5)`,
        [id, userId, w.loc, w.item.baseId, JSON.stringify(w.item)]);
      await event(c, id, 'created', userId, null, w.loc, reason, w.item);
      continue;
    }
    if (cur.loc === LOC_REVOKED) {
      throw new LedgerViolation(`вещь ${id} отозвана и не может вернуться в игру (${reason})`);
    }
    if (cur.user_id !== userId) {
      // Торговли между игроками нет, значит вещь не может законно сменить аккаунт.
      throw new LedgerViolation(
        `вещь ${id} числится за аккаунтом ${cur.user_id}, а появилась у ${userId} (${reason})`);
    }
    if (cur.loc !== w.loc) {
      await c.query('UPDATE items SET loc = $2, data = $3, moved_at = now() WHERE id = $1',
        [id, w.loc, JSON.stringify(w.item)]);
      await event(c, id, 'moved', userId, cur.loc, w.loc, reason, null);
      continue;
    }
    // Место то же — но вещь могли перековать/перекатать. Сравниваем содержимое.
    const before = JSON.stringify(cur.data);
    const after = JSON.stringify(w.item);
    if (before !== after) {
      await c.query('UPDATE items SET data = $2 WHERE id = $1', [id, after]);
      await event(c, id, 'changed', userId, w.loc, w.loc, reason, w.item);
    }
  }

  // Пропавшие из наших мест: продана, выброшена, уничтожена.
  for (const [id, r] of have) {
    if (want.has(id)) continue;
    await c.query('UPDATE items SET loc = $2, moved_at = now() WHERE id = $1', [id, LOC_WORLD]);
    await event(c, id, 'gone', userId, r.loc, LOC_WORLD, reason, null);
  }
}

async function event(
  c: PoolClient, itemId: string, kind: string, userId: string,
  from: string | null, to: string | null, reason: string, data: Item | null,
): Promise<void> {
  await c.query(
    `INSERT INTO item_events (item_id, kind, user_id, from_loc, to_loc, reason, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [itemId, kind, userId, from, to, reason, data ? JSON.stringify(data) : null]);
}

/**
 * Отозвать вещь: вынуть её из сейва/сундука, где бы она ни лежала, и закрыть ей путь назад.
 * Одной транзакцией — иначе игрок с открытой сессией впишет её обратно между нашими запросами.
 */
export async function revokeItem(id: string, reason: string): Promise<{ user: string; from: string; touched: string[] } | null> {
  return tx(async (c) => {
    const cur = await c.query<{ user_id: string; loc: string }>(
      'SELECT user_id, loc FROM items WHERE id = $1 FOR UPDATE', [id]);
    const row = cur.rows[0];
    if (!row) return null;

    // Из сейвов персонажей.
    const chars = await c.query<{ char_id: string; data: SaveState; version: number }>(
      'SELECT char_id, data, version FROM characters WHERE user_id = $1', [row.user_id]);
    const touched: string[] = [];
    for (const ch of chars.rows) {
      const before = JSON.stringify(ch.data);
      const save = ch.data;
      save.inventory = save.inventory.filter((i) => i.uid !== id);
      save.belt = save.belt.map((i) => (i && i.uid === id ? null : i));
      for (const [slot, it] of Object.entries(save.equipment)) {
        if (it && it.uid === id) delete save.equipment[slot as keyof typeof save.equipment];
      }
      if (JSON.stringify(save) !== before) {
        await c.query('UPDATE characters SET data = $1, version = version + 1, updated_at = now() WHERE char_id = $2',
          [JSON.stringify(save), ch.char_id]);
        touched.push(ch.char_id);
      }
    }

    // Из сундука аккаунта.
    const st = await c.query<{ data: { tabs: { uid: string }[][] } }>(
      'SELECT data FROM account_stash WHERE user_id = $1', [row.user_id]);
    if (st.rows[0]) {
      const data = st.rows[0].data;
      const before = JSON.stringify(data);
      data.tabs = data.tabs.map((tab) => tab.filter((i) => i.uid !== id));
      if (JSON.stringify(data) !== before) {
        await c.query('UPDATE account_stash SET data = $1, updated_at = now() WHERE user_id = $2',
          [JSON.stringify(data), row.user_id]);
        touched.push('сундук');
      }
    }

    await c.query('UPDATE items SET loc = $2, moved_at = now() WHERE id = $1', [id, LOC_REVOKED]);
    await c.query(
      `INSERT INTO item_events (item_id, kind, user_id, from_loc, to_loc, reason)
       VALUES ($1, 'revoked', $2, $3, $4, $5)`,
      [id, row.user_id, row.loc, LOC_REVOKED, reason]);
    return { user: row.user_id, from: row.loc, touched };
  });
}
