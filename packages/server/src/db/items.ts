import type { PoolClient } from 'pg';
import { q, tx } from './pool.js';
import type { SaveState, AccountStash, Item } from '@dm/shared';
import { isUuid } from '@dm/shared';
import { LedgerViolation } from './errors.js';

export { LedgerViolation };

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

/**
 * ⚠ СЫРЬЁ — НЕ ВЕЩЬ ДЛЯ ЛЕДЖЕРА. Стек материалов живёт в сумке как предмет, но леджер строится
 * на «одна вещь = один вечный uid»: стеки сливаются, делятся пополам при смерти и тратятся
 * кузницей до нуля. Каждая такая правка выглядела бы в леджере как рождение и пропажа вещи, а
 * ночной аудит записывал бы её в инциденты. Кошелёк сырья в сундуке аккаунта по той же причине
 * лежит отдельным полем, а не вкладкой `tabs`.
 *
 * Проверять надо ИМЕННО вид предмета: сейчас стек получает uid `<uuid>_0`, который не проходит
 * `isUuid` ниже и отсеивается сам собой — но это совпадение, а не правило. Оно рассыплется от
 * любой правки генерации uid, и рассыплется молча.
 */
const forLedger = (it: Item): boolean => it.kind !== 'material';

/** Все вещи персонажа: экипировка + инвентарь + пояс. Сундук сюда НЕ входит. */
export function itemsOfSave(save: SaveState): Item[] {
  const out: Item[] = [];
  for (const it of Object.values(save.equipment)) if (it && forLedger(it)) out.push(it);
  for (const it of save.inventory) if (forLedger(it)) out.push(it);
  for (const it of save.belt) if (it && forLedger(it)) out.push(it);
  return out;
}

/** Все вещи сундука аккаунта (по всем вкладкам). */
export function itemsOfStash(stash: AccountStash): Item[] {
  const out: Item[] = [];
  for (const tab of stash.tabs) for (const it of tab) if (forLedger(it)) out.push(it);
  return out;
}

interface Row { id: string; loc: string; user_id: string }

/**
 * Свести леджер с тем, что реально лежит у персонажа (и, если передан, в сундуке).
 *
 * Зовётся ВНУТРИ транзакции записи сейва — свой клиент обязателен: уйди запрос в другое
 * соединение пула, и он окажется вне транзакции, а «атомарность» станет ложной.
 *
 * `stash === undefined` означает «сундук в этой записи не участвует»: тогда вещи, лежащие
 * в сундуке, не считаются пропавшими. Без этой оговорки обычный автосейв персонажа объявлял
 * бы весь сундук утраченным.
 *
 * ⭐ R2-21: `reasons` — причина ПО ВЕЩИ. Действие кузницы подписывает свою вещь (скованную, разобранную), а всё,
 * что запись заодно застала (купленное, поднятое с тех пор), идёт автосейвом. Раньше одна причина ложилась на
 * всё новое: покупка перед ковкой считалась ковкой, ночной аудит видел «кузнеца-выброс» и терял её из добычи.
 * Без карты — старое правило: одна причина на всю запись (вход, новый персонаж, инструменты).
 */
export async function syncItems(
  c: PoolClient, userId: string, charId: string, save: SaveState,
  stash: AccountStash | undefined, reason: string, reasons?: ReadonlyMap<string, string>,
): Promise<void> {
  const why = (id: string): string => (reasons ? reasons.get(id) ?? 'autosave' : reason);
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
  // Фильтр по аккаунту ОБЯЗАТЕЛЕН: место `stash` одинаково у всех пользователей, и без него
  // автосейв одного игрока объявил бы «пропавшими» сундуки всех остальных.
  // Данных вещей здесь не читаем: содержимое сравнивает сама база (см. ниже), тащить сюда весь инвентарь незачем.
  const mine = await c.query<{ id: string }>(
    'SELECT id FROM items WHERE user_id = $2 AND loc = ANY($1)', [locs, userId]);

  // ⭐ R4-10: БЛОКИРОВКИ СТРОК ВЕЩЕЙ — ВСЕ СРАЗУ И В ОДНОМ ПОРЯДКЕ (по id), до любой правки. Раньше строки брались по ходу
  // дела: сперва нужные (в порядке сейва), потом пропавшие из наших мест. Два героя аккаунта, обменявшиеся вещами (выбросил
  // — поднял сосед), писались встречно: X держал I2 и ждал I1, Y — наоборот, и база обрывала одного взаимоблокировкой. А
  // слив ноды в этом окне оставлял отданную вещь у обоих, полученную — ни у кого. Под блокировкой строки читаются заново:
  // пока ждали, соседняя запись могла вещь забрать — тогда она уже не «наша» и пропавшей не считается.
  const ids = [...new Set([...want.keys(), ...mine.rows.map((r) => r.id)])];
  const locked = ids.length
    ? (await c.query<Row>('SELECT id, loc, user_id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])).rows
    : [];
  // Все строки — и нужные (новые, пришедшие с земли и из сундука), и лежащие в наших местах.
  const known = new Map<string, Row>(locked.map((r) => [r.id, r]));
  const have = new Map<string, Row>();
  for (const r of locked) if (r.user_id === userId && locs.includes(r.loc)) have.set(r.id, r);

  // Нарушения — ВСЕ сразу и до единой записи (R2-02): комната вынимает вещи-нарушители из сейва и пишет остальное.
  // Раньше бросок шёл на первой, и вещь чужого аккаунта в сумке молча губила каждую следующую запись игрока.
  const bad: string[] = [];
  const said: string[] = [];
  for (const id of want.keys()) {
    const cur = known.get(id);
    if (!cur) continue;
    if (cur.loc === LOC_REVOKED) {
      bad.push(id); said.push(`вещь ${id} отозвана и не может вернуться в игру (${reason})`);
    } else if (cur.user_id !== userId) {
      // Торговли между игроками нет, значит вещь не может законно сменить аккаунт.
      bad.push(id); said.push(`вещь ${id} числится за аккаунтом ${cur.user_id}, а появилась у ${userId} (${reason})`);
    }
  }
  if (bad.length) throw new LedgerViolation(said.join('; '), bad);

  // Место то же — вещь могли перековать или перекатать: содержимое сравнивается ПАКЕТОМ ниже.
  const same: { id: string; data: Item }[] = [];
  for (const [id, w] of want) {
    const cur = known.get(id);
    if (!cur) {
      await c.query(
        `INSERT INTO items (id, user_id, loc, base_id, data) VALUES ($1, $2, $3, $4, $5)`,
        [id, userId, w.loc, w.item.baseId, JSON.stringify(w.item)]);
      await event(c, id, 'created', userId, null, w.loc, why(id), w.item);
      continue;
    }
    if (cur.loc !== w.loc) {
      await c.query('UPDATE items SET loc = $2, data = $3, moved_at = now() WHERE id = $1',
        [id, w.loc, JSON.stringify(w.item)]);
      await event(c, id, 'moved', userId, cur.loc, w.loc, why(id), null);
      continue;
    }
    same.push({ id, data: w.item });
  }

  // ⭐ R2-06: СОДЕРЖИМОЕ СРАВНИВАЕТ БАЗА. `items.data` — jsonb, а jsonb хранит ключи в своём порядке (короткие
  // первыми): строковое сравнение с вещью в порядке JS не совпадало почти никогда, и КАЖДАЯ запись переписывала
  // каждую вещь сейва (и сундука) с полным снимком в вечный журнал. `IS DISTINCT FROM` у jsonb — по смыслу.
  // Один запрос на всю запись, а не запрос на вещь.
  if (same.length) {
    const changed = await c.query<{ id: string }>(
      `UPDATE items i SET data = u.data
       FROM jsonb_to_recordset($1::jsonb) AS u(id uuid, data jsonb)
       WHERE i.id = u.id AND i.data IS DISTINCT FROM u.data
       RETURNING i.id`,
      [JSON.stringify(same)]);
    for (const r of changed.rows) {
      const w = want.get(r.id)!;
      await event(c, r.id, 'changed', userId, w.loc, w.loc, why(r.id), w.item);
    }
  }

  // Пропавшие из наших мест: продана, выброшена, уничтожена.
  for (const [id, r] of have) {
    if (want.has(id)) continue;
    await c.query('UPDATE items SET loc = $2, moved_at = now() WHERE id = $1', [id, LOC_WORLD]);
    await event(c, id, 'gone', userId, r.loc, LOC_WORLD, why(id), null);
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
 * ⭐ R1-17: БЛОКИРОВКИ ИНСТРУМЕНТА — В ПОРЯДКЕ ЗАПИСИ ИГРЫ. Игра пишет строку персонажа, потом сундук, потом
 * строки вещей (`putCharacterWithStash` → `syncItems`); инструмент по живому серверу берёт ВСЕ строки персонажей
 * аккаунта (по `char_id`, всегда в одном порядке) и сундук `FOR UPDATE` раньше вещей. Раньше строки читались без
 * блокировки и писались безусловно: запись игры, успевшая между чтением и записью, затиралась старой копией
 * (вещь, только что ушедшая в сундук, оказывалась и там, и в сейве), а порядок «вещь → персонаж» против игрового
 * «персонаж → вещь» давал взаимную блокировку. Под `FOR UPDATE` чтение ждёт открытую запись игры и видит её итог.
 * Живая сессия с устаревшей копией после этого получит отказ по версии и будет снята (`Room.dropStale`, R1-01).
 */
export async function lockAccount(c: PoolClient, userId: string): Promise<{
  chars: { char_id: string; data: SaveState; version: number }[];
  stash: AccountStash | undefined;
}> {
  const chars = await c.query<{ char_id: string; data: SaveState; version: number }>(
    'SELECT char_id, data, version FROM characters WHERE user_id = $1 ORDER BY char_id FOR UPDATE', [userId]);
  const st = await c.query<{ data: AccountStash }>('SELECT data FROM account_stash WHERE user_id = $1 FOR UPDATE', [userId]);
  return { chars: chars.rows, stash: st.rows[0]?.data };
}

/**
 * Отозвать вещь: вынуть её из сейва/сундука, где бы она ни лежала, и закрыть ей путь назад.
 * Одной транзакцией — иначе игрок с открытой сессией впишет её обратно между нашими запросами.
 */
export async function revokeItem(id: string, reason: string): Promise<{ user: string; from: string; touched: string[] } | null> {
  return tx(async (c) => {
    // Владелец — без блокировки: аккаунт у вещи не меняется никогда (такой переход леджер отклоняет).
    const owner = (await c.query<{ user_id: string }>('SELECT user_id FROM items WHERE id = $1', [id])).rows[0];
    if (!owner) return null;
    const locked = await lockAccount(c, owner.user_id);
    // Строка вещи — последней (порядок записи игры), и уже под блокировкой перечитываем, где она.
    const cur = await c.query<{ user_id: string; loc: string }>(
      'SELECT user_id, loc FROM items WHERE id = $1 FOR UPDATE', [id]);
    const row = cur.rows[0];
    if (!row) return null;

    // Из сейвов персонажей.
    const touched: string[] = [];
    for (const ch of locked.chars) {
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
    if (locked.stash) {
      const data = locked.stash;
      const before = JSON.stringify(data);
      data.tabs = data.tabs.map((tab) => tab.filter((i) => i.uid !== id));
      if (JSON.stringify(data) !== before) {
        // Версию поднимаем (D8): живая сессия, прочитавшая сундук до отзыва, получит отказ,
        // а не впишет свою копию поверх.
        await c.query('UPDATE account_stash SET data = $1, version = version + 1, updated_at = now() WHERE user_id = $2',
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

/**
 * ⭐ R15-03: ВЕЩИ ГЕРОЕВ, УДАЛЁННЫХ ДО ПРАВКИ `deleteCharacter`, — навсегда у «char:<удалённого>»: героя нет, а ночной аудит каждую ночь
 * числит их «потерянными» (инциденты, вытесняющие настоящие). Показать (`fix` — нет) или увести их в `world` событием `gone`
 * (`charDeleted`) — так теперь уводит сама транзакция удаления. Строки вещей — под блокировкой и в одном порядке (по id), место —
 * перепроверяется: вещь, которую тем временем увела запись игры, не трогается.
 */
export async function releaseOrphans(fix: boolean): Promise<{ items: number; chars: string[] }> {
  const orphans = `SELECT i.id, i.loc, i.user_id FROM items i
     WHERE i.loc LIKE 'char:%' AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.char_id = substring(i.loc from 6))`;
  const sum = (rows: readonly Row[]): { items: number; chars: string[] } =>
    ({ items: rows.length, chars: [...new Set(rows.map((r) => r.loc.slice('char:'.length)))].sort() });
  if (!fix) return sum(await q<Row>(orphans));
  return tx(async (c) => {
    const rows = (await c.query<Row>(`${orphans} ORDER BY i.id FOR UPDATE OF i`)).rows;
    const moved: Row[] = [];
    for (const r of rows) {
      const u = await c.query('UPDATE items SET loc = $2, moved_at = now() WHERE id = $1 AND loc = $3', [r.id, LOC_WORLD, r.loc]);
      if (!u.rowCount) continue;
      await event(c, r.id, 'gone', r.user_id, r.loc, LOC_WORLD, 'charDeleted', null);
      moved.push(r);
    }
    return sum(moved);
  });
}
