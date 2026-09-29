import type { SaveState, Item, AccountStash } from '@dm/shared';
import { tx } from './pool.js';
import { LOC_STASH, LOC_WORLD, LOC_REVOKED, locOfChar, itemsOfSave, itemsOfStash, lockAccount } from './items.js';

/**
 * Точечный откат аккаунта по журналу (Ф2.7).
 *
 * ЗАЧЕМ ИМЕННО ТОЧЕЧНЫЙ. Откат всей базы карает невиновных: у сотни человек пропадает вечер
 * игры из-за одного дупера. Отраслевой опыт тут единодушен — хранить журнал и откатывать
 * выборочно. Журнал у нас есть с Ф2, значит и откат возможен.
 *
 * ЧТО ОТКАТЫВАЕТСЯ: где лежали вещи аккаунта на заданный момент. Вещь, которой на тот момент
 * ещё не было, — исчезает; вещь, лежавшая в сундуке, — возвращается в сундук.
 *
 * ЧЕГО ОТКАТ НЕ ДЕЛАЕТ, И ЭТО ВАЖНО ЗНАТЬ:
 *  • ЗОЛОТО И ОПЫТ не откатываются — журнала для них нет, есть только журнал предметов.
 *    Врать в этом месте опаснее, чем признать границу;
 *  • ⚠ ВЫХОД КУЗНИЦЫ не откатывается (R2-32): разобранная или переплавленная после отсечки вещь ВОЗВРАЩАЕТСЯ,
 *    а сырьё с неё (в сумке и в кошельке сундука, до 108 золота за единицу в лавке) и то, что разбор открыл в
 *    журнале кузнеца (базы, детали, эскизы, счётчик мификов — ворота t6), остаются. Выход разбора катается и в
 *    журнал вещей не пишется — вычесть его нечем. Поэтому план ПЕРЕЧИСЛЯЕТ такие разборы (`forge`) и счётчик
 *    мификов журнала (`journalMythic`): дюп через разбор окупается, пока человек не сверит это руками;
 *  • ЭКИПИРОВКА не восстанавливается по слотам: журнал пишет место («у персонажа»), но не
 *    слот. Всё возвращённое кладётся в инвентарь, игрок надевает сам;
 *  • отозванные вещи (`revoked`) откат НЕ воскрешает: отзыв — это решение человека,
 *    и оно сильнее восстановления по времени;
 *  • ⭐ R16-03: вещи, лежавшие на отсечке у героя, которого с тех пор УДАЛИЛИ, откат не трогает — возвращать их некуда (строки героя
 *    нет), а где они сейчас (сундук, другой герой, `world` — удаление уводит туда его вещи, R15-03), там и остаются. Раньше их вынимали
 *    отовсюду и не клали никуда: вещь, законно ушедшая в сундук, пропадала, а леджер снова числил всё за удалённым (вечные «lost»
 *    ночного аудита до `items:orphans --fix`). План перечисляет их (`deletedHero`) — к ручной сверке.
 *
 * Работает ОДНОЙ транзакцией и по умолчанию только показывает, что сделает.
 */

export interface RollbackPlan {
  userId: string;
  at: Date;
  /** Куда какая вещь должна вернуться. */
  restore: { id: string; to: string; item: Item }[];
  /** Вещи, которых на тот момент не существовало — их надо забрать. */
  remove: { id: string; from: string }[];
  /** Что осталось без изменений — для отчёта. */
  untouched: number;
  /** Персонажи и сундук, которые придётся переписать. */
  touched: string[];
  /**
   * R2-32: разборы и переплавки ПОСЛЕ отсечки — их вещи откат вернёт, а выход (сырьё, открытия журнала кузнеца)
   * останется. К ручной сверке: откат этого не вычитает.
   */
  forge: { id: string; reason: string; at: Date }[];
  /** Счётчик мификов журнала кузнеца сейчас (ворота t6) — откат его не трогает. */
  journalMythic: number;
  /**
   * ⭐ R16-03: вещи, лежавшие на отсечке у героя, которого с тех пор удалили (`char` — его id): вернуть их некуда, откат их не трогает. К
   * ручной сверке.
   */
  deletedHero: { id: string; char: string }[];
}

interface EventRow { item_id: string; kind: string; to_loc: string | null; data: Item | null }

/**
 * Построить план: где вещи аккаунта лежали на момент `at`, и чем это отличается от «сейчас».
 * Ничего не меняет — план можно показать человеку и только потом применять.
 */
export async function planRollback(userId: string, at: Date): Promise<RollbackPlan> {
  return tx(async (c) => {
    // Состояние на момент времени: последнее событие каждой вещи до отсечки.
    const evts = await c.query<EventRow>(
      `SELECT item_id, kind, to_loc, data FROM item_events
       WHERE user_id = $1 AND at <= $2 ORDER BY seq`, [userId, at]);

    const locAt = new Map<string, string>();
    const dataAt = new Map<string, Item>();
    for (const e of evts.rows) {
      if (e.to_loc) locAt.set(e.item_id, e.to_loc);
      // Снимок вещи пишется на рождении и на изменении — берём самый свежий до отсечки.
      if (e.data) dataAt.set(e.item_id, e.data);
    }

    // Что лежит сейчас.
    const chars = await c.query<{ char_id: string; data: SaveState }>(
      'SELECT char_id, data FROM characters WHERE user_id = $1', [userId]);
    const stash = await c.query<{ data: AccountStash }>(
      'SELECT data FROM account_stash WHERE user_id = $1', [userId]);

    const now = new Map<string, string>();
    for (const ch of chars.rows) for (const it of itemsOfSave(ch.data)) now.set(it.uid, locOfChar(ch.char_id));
    /** ⭐ R16-03: места, куда вернуть можно: герои аккаунта, что есть сейчас, и сундук. */
    const heroes = new Set(chars.rows.map((ch) => locOfChar(ch.char_id)));
    if (stash.rows[0]) for (const it of itemsOfStash(stash.rows[0].data)) now.set(it.uid, LOC_STASH);

    const restore: RollbackPlan['restore'] = [];
    const remove: RollbackPlan['remove'] = [];
    const deletedHero: RollbackPlan['deletedHero'] = [];
    let untouched = 0;
    const touched = new Set<string>();

    // Вещь была где-то на момент отсечки, но лежит не там (или пропала) — вернуть.
    for (const [id, was] of locAt) {
      if (was === LOC_WORLD || was === LOC_REVOKED) continue;      // тогда её у аккаунта и не было
      // ⭐ R16-03: лежала у героя, которого удалили, — вернуть некуда: не вынимаем оттуда, где она сейчас, и леджер не переписываем.
      if (was !== LOC_STASH && !heroes.has(was)) { deletedHero.push({ id, char: was.slice(locOfChar('').length) }); continue; }
      const isNow = now.get(id);
      if (isNow === was) { untouched++; continue; }
      const item = dataAt.get(id);
      if (!item) continue;                                          // снимка нет — восстанавливать нечего
      restore.push({ id, to: was, item });
      touched.add(was);
      if (isNow) touched.add(isNow);
    }

    // Вещь есть сейчас, но на момент отсечки её не существовало — забрать.
    for (const [id, isNow] of now) {
      if (locAt.has(id)) continue;
      remove.push({ id, from: isNow });
      touched.add(isNow);
    }

    // R2-32: выход кузницы в журнал вещей не пишется — план хотя бы называет разборы, которые откат «вернёт».
    const forge = await c.query<{ item_id: string; reason: string; at: Date }>(
      `SELECT item_id, reason, at FROM item_events
       WHERE user_id = $1 AND at > $2 AND kind = 'gone' AND reason IN ('salvage', 'melt') ORDER BY seq`, [userId, at]);
    const journalMythic = Number(stash.rows[0]?.data.forgeJournal?.mythic ?? 0) || 0;

    return {
      userId, at, restore, remove, untouched, touched: [...touched],
      forge: forge.rows.map((r) => ({ id: r.item_id, reason: r.reason, at: r.at })), journalMythic, deletedHero,
    };
  });
}

/**
 * Применить план. Одной транзакцией: половина отката хуже, чем его отсутствие.
 * Возвращает, сколько вещей вернули и сколько забрали.
 */
export async function applyRollback(plan: RollbackPlan, reason: string): Promise<{ restored: number; removed: number }> {
  return tx(async (c) => {
    // R1-17: строки персонажей и сундука — `FOR UPDATE` и в порядке записи игры (см. `lockAccount`): чтение ждёт
    // открытую запись живой сессии и видит её итог, а не затирает его старой копией.
    const locked = await lockAccount(c, plan.userId);
    const chars = locked.chars;

    const saves = new Map(chars.map((r) => [locOfChar(r.char_id), r]));
    const stash = locked.stash;

    /** Вынуть вещь отовсюду, где она сейчас лежит. */
    const pull = (id: string): void => {
      for (const r of chars) {
        const s = r.data;
        s.inventory = s.inventory.filter((i) => i.uid !== id);
        s.belt = s.belt.map((i) => (i && i.uid === id ? null : i));
        for (const [slot, it] of Object.entries(s.equipment)) {
          if (it && it.uid === id) delete s.equipment[slot as keyof typeof s.equipment];
        }
      }
      if (stash) stash.tabs = stash.tabs.map((tab) => tab.filter((i) => i.uid !== id));
    };

    for (const r of plan.remove) pull(r.id);

    // ⭐ R16-03: СТОРОЖ — возврат туда, чего под блокировкой нет (герой удалён после плана, сундука нет), пропускается ЦЕЛИКОМ: ни выемки
    // оттуда, где вещь сейчас, ни записи леджера и журнала. Раньше вещь вынималась и не клалась никуда, а леджер числил её за местом, которого нет.
    const restore = plan.restore.filter((r) => (r.to === LOC_STASH ? !!stash?.tabs[0] : saves.has(r.to)));
    for (const r of restore) {
      pull(r.id);
      if (r.to === LOC_STASH) {
        // Возврат в сундук: позиция из снимка. Наложения лечит `sanitizeStash` при выдаче.
        stash!.tabs[0]!.push(r.item);
      } else {
        // ВСЁ кладём в инвентарь, а не в слоты: журнал знает место, но не слот экипировки.
        saves.get(r.to)!.data.inventory.push({ ...r.item, pos: r.item.pos ?? null });
      }
    }

    for (const r of chars) {
      await c.query('UPDATE characters SET data = $1, version = version + 1, updated_at = now() WHERE char_id = $2',
        [JSON.stringify(r.data), r.char_id]);
    }
    if (stash) {
      // Версию поднимаем (D8): живая сессия со старой копией сундука получит отказ, а не затрёт откат.
      await c.query('UPDATE account_stash SET data = $1, version = version + 1, updated_at = now() WHERE user_id = $2',
        [JSON.stringify(stash), plan.userId]);
    }

    // Леджер и журнал приводим в то же состояние: иначе ближайший аудит объявит откат нарушением.
    for (const r of restore) {
      await c.query('UPDATE items SET loc = $2, data = $3, moved_at = now() WHERE id = $1',
        [r.id, r.to, JSON.stringify(r.item)]);
      await c.query(
        `INSERT INTO item_events (item_id, kind, user_id, from_loc, to_loc, reason, data)
         VALUES ($1, 'rollback', $2, NULL, $3, $4, $5)`,
        [r.id, plan.userId, r.to, reason, JSON.stringify(r.item)]);
    }
    for (const r of plan.remove) {
      await c.query('UPDATE items SET loc = $2, moved_at = now() WHERE id = $1', [r.id, LOC_WORLD]);
      await c.query(
        `INSERT INTO item_events (item_id, kind, user_id, from_loc, to_loc, reason)
         VALUES ($1, 'rollback', $2, $3, $4, $5)`,
        [r.id, plan.userId, r.from, LOC_WORLD, reason]);
    }

    return { restored: restore.length, removed: plan.remove.length };
  });
}
