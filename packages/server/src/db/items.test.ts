import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, emptyStash, emptyJournal, uuidv7, materialItem, type SaveState, type AccountStash, type Item } from '@dm/shared';
import { itemsOfSave, itemsOfStash } from './items.js';

/**
 * Леджер предметов и журнал происхождения (Ф2) — против НАСТОЯЩЕЙ базы.
 *
 * Мокать здесь нечего: проверяется ровно то, что делает Postgres (транзакция, первичный ключ,
 * триггер запрета переписывания журнала). Без базы тест пропускается — `DM_PG_TEST` или локальный
 * PostgreSQL на 5432 с базой `dungeon_test`, см. `loadtest/README.md`.
 *
 * ⚠ АДРЕС БАЗЫ — В `vi.hoisted`, до всех импортов. Статический `import './items.js'` выше тянет
 * `pool.js`, а тот читает `DM_PG` в момент загрузки; импорты в ESM исполняются ДО тела модуля.
 * Пока присваивание стояло обычной строкой, пул успевал открыться на DEV-базе (`dungeon`), и
 * тесты писали пользователей, персонажей и подсаженные «дюпы» прямо в базу разработки.
 *
 * ⭐ СВОЯ СХЕМА НА ФАЙЛ (`testDb.ts`): аудит здесь читает всю базу, и в общей схеме дюпы соседних файлов и упавших
 * прогонов вытесняли из десяти примеров находки дюп этого теста — он падал «сам по себе», в том числе поодиночке.
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('items'));

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let alive = false;
let cfg: ConfigRegistry;

beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  if (!alive) return;   // базы нет — тесты ниже пропустятся
  // Обе схемы, как у процессов, гоняющих аудит (гейтвей, `items:audit`): аудит читает и закрепления кластера.
  await pool.initSchema();
  await (await import('../cluster/registry.js')).initClusterSchema();
  db = await import('./db.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

/** Свежий аккаунт с персонажем: у него уже есть стартовый комплект вещей. */
async function freshChar(): Promise<{ userId: string; charId: string; save: SaveState }> {
  // Ник из ХВОСТА uuid: начало v7 — это время, у соседних вызовов оно совпадает.
  const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
  const charId = uuidv7();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Тест', charId);
  await db.createCharacter(charId, userId, save);
  return { userId, charId, save };
}

/**
 * Взять вещь из стартового комплекта и СНЯТЬ её с персонажа (у нового героя всё надето,
 * инвентарь пуст). Возвращает саму вещь — дальше тест решает, куда она денется.
 */
function takeEquipped(save: SaveState): Item {
  const slot = (Object.keys(save.equipment) as (keyof typeof save.equipment)[])[0]!;
  const item = save.equipment[slot]!;
  delete save.equipment[slot];
  return item;
}

const events = async (itemId: string): Promise<{ kind: string; from_loc: string | null; to_loc: string | null }[]> =>
  pool.q('SELECT kind, from_loc, to_loc FROM item_events WHERE item_id = $1 ORDER BY seq', [itemId]);

describe.runIf(process.env.DM_SKIP_PG !== '1')('леджер предметов', () => {
  it('стартовый комплект попадает в леджер и журнал', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const first = Object.values(save.equipment)[0];
    expect(first, 'у нового персонажа должен быть стартовый комплект').toBeTruthy();

    const row = await pool.q1<{ loc: string; user_id: string }>(
      'SELECT loc, user_id FROM items WHERE id = $1', [first!.uid]);
    expect(row?.loc).toBe(`char:${charId}`);
    expect(row?.user_id).toBe(userId);
    expect((await events(first!.uid)).map((e) => e.kind)).toEqual(['created']);
  });

  it('перенос в сундук — ОДНО перемещение, а не пропажа и находка', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const item = takeEquipped(save);
    const stash: AccountStash = emptyStash(cfg);
    stash.tabs[0]!.push({ ...item, pos: { x: 0, y: 0 } });

    const v = await db.putCharacterWithStash(charId, userId, save, 1, stash, 0);
    expect(v).toEqual({ ok: true, version: 2, stashVersion: 1 });

    const row = await pool.q1<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [item.uid]);
    expect(row?.loc).toBe('stash');
    expect((await events(item.uid)).map((e) => e.kind)).toEqual(['created', 'moved']);
  });

  it('⭐ D8: сундук под версией — вторая запись со старой версией не пишет НИЧЕГО, ни сундук, ни сейв', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const stash: AccountStash = emptyStash(cfg);
    stash.materials = { 'iron-1': 10 };
    expect(await db.putCharacterWithStash(charId, userId, save, 1, stash, 0)).toEqual({ ok: true, version: 2, stashVersion: 1 });

    // Второй герой того же аккаунта читал сундук ДО этой записи (версия 0 — строки не было)
    // и тоже пытается его записать: вставка без затирания обязана отказать.
    const other = { ...stash, materials: { 'iron-1': 999 } };
    save.gold = 123_456;
    expect(await db.putCharacterWithStash(charId, userId, save, 2, other, 0)).toEqual({ ok: false, conflict: 'stash' });
    // И обновление по устаревшей версии — тоже.
    expect(await db.putCharacterWithStash(charId, userId, save, 2, other, 7)).toEqual({ ok: false, conflict: 'stash' });

    const row = await db.getAccountStash(userId);
    expect(row?.version, 'версия сундука не сдвинулась').toBe(1);
    expect(row?.data.materials?.['iron-1'], 'сундук не затёрт').toBe(10);
    const ch = await db.getCharacter(charId);
    expect(ch?.version, 'сейв откатился вместе с сундуком').toBe(2);
    expect(ch?.data.gold).not.toBe(123_456);

    // С верной версией — проходит и поднимает обе.
    expect(await db.putCharacterWithStash(charId, userId, save, 2, other, 1)).toEqual({ ok: true, version: 3, stashVersion: 2 });
  });

  it('исчезнувшая вещь помечается ушедшей из аккаунта', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const item = takeEquipped(save);
    await db.putCharacter(charId, userId, save, 1, 'cmd:sell');

    const row = await pool.q1<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [item.uid]);
    expect(row?.loc).toBe('world');
    expect((await events(item.uid)).map((e) => e.kind)).toEqual(['created', 'gone']);
  });

  it('вещь чужого аккаунта отклоняется ЦЕЛИКОМ: сейв не записывается', async () => {
    if (!alive) return;
    const a = await freshChar();
    const b = await freshChar();
    const stolen = Object.values(a.save.equipment)[0]!;
    b.save.inventory.push(stolen);          // как будто предмет «переехал» между аккаунтами
    b.save.gold = 999_999;                   // заодно проверим, что сейв не сохранился

    await expect(db.putCharacter(b.charId, b.userId, b.save, 1)).rejects.toThrow(/числится за аккаунтом/);

    const ch = await db.getCharacter(b.charId);
    expect(ch?.version, 'версия не выросла — транзакция откатилась').toBe(1);
    expect(ch?.data.gold).not.toBe(999_999);
    const row = await pool.q1<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [stolen.uid]);
    expect(row?.loc, 'вещь осталась у законного владельца').toBe(`char:${a.charId}`);
  });

  it('журнал нельзя переписать — это запрещает сама база', async () => {
    if (!alive) return;
    const { save } = await freshChar();
    const id = Object.values(save.equipment)[0]!.uid;
    await expect(pool.q('UPDATE item_events SET kind = $1 WHERE item_id = $2', ['подделка', id]))
      .rejects.toThrow(/только на дозапись/);
    await expect(pool.q('DELETE FROM item_events WHERE item_id = $1', [id]))
      .rejects.toThrow(/только на дозапись/);
  });

  it('отзыв вынимает вещь из сейва и закрывает ей путь назад', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const item = Object.values(save.equipment)[0]!;

    const { revokeItem } = await import('./items.js');
    const res = await revokeItem(item.uid, 'дюп через сундук');
    expect(res?.touched).toContain(charId);

    const ch = await db.getCharacter(charId);
    const stillThere = Object.values(ch!.data.equipment).some((i) => i?.uid === item.uid);
    expect(stillThere, 'вещь вычищена из сейва').toBe(false);

    // Игрок с открытой сессией держит СВОЮ копию сейва и попытается вписать вещь обратно.
    save.inventory.push(item);
    await expect(db.putCharacter(charId, userId, save, ch!.version)).rejects.toThrow(/отозвана/);
    expect((await events(item.uid)).map((e) => e.kind)).toEqual(['created', 'revoked']);
  });

  it('аудит ловит одну вещь в двух сейвах и старые id', async () => {
    if (!alive) return;
    const { runAudit } = await import('./audit.js');

    const a = await freshChar();
    const b = await freshChar();
    const shared = Object.values(a.save.equipment)[0]!;

    // Подсаживаем нарушения ПРЯМО В БАЗУ, мимо кода игры: аудит обязан ловить и то,
    // что записал не наш сервер, — иначе он проверяет лишь собственную аккуратность.
    b.save.inventory.push(shared);                                   // одна вещь в двух сейвах
    b.save.inventory.push({ ...shared, uid: 'it_старый_формат' });   // id до Ф2
    await pool.q('UPDATE characters SET data = $1 WHERE char_id = $2',
      [JSON.stringify(b.save), b.charId]);

    try {
      const r = await runAudit();
      const dupe = r.findings.find((f) => f.kind === 'dupe');
      const legacy = r.findings.find((f) => f.kind === 'legacy');
      expect(dupe, 'дубль обязан быть найден').toBeTruthy();
      expect(dupe!.examples.join(' ')).toContain(shared.uid);
      expect(legacy, 'старый id обязан быть замечен').toBeTruthy();
      expect(r.incidents, 'дубль это инцидент, а не замечание').toBeGreaterThan(0);
    } finally {
      // Убираем за собой — и когда проверка упала: иначе следующий прогон аудита будет вечно красным (примеров в отчёте
      // десять, и дубли упавших прогонов вытесняют из них дубль этого).
      await pool.q('DELETE FROM characters WHERE char_id = $1', [b.charId]);
    }
  });

  it('откат возвращает вещь на место и забирает появившуюся позже', async () => {
    if (!alive) return;
    const { planRollback, applyRollback } = await import('./rollback.js');

    const { userId, charId, save } = await freshChar();
    const kept = Object.values(save.equipment)[0]!;

    // Момент отсечки: всё, что было ДО него, считается законным.
    await new Promise((r) => setTimeout(r, 50));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 50));

    // После отсечки: одну вещь потеряли, другая появилась из ниоткуда.
    const appeared = { ...kept, uid: uuidv7(), name: 'Появилась позже' };
    const gone = Object.keys(save.equipment)[0] as keyof typeof save.equipment;
    delete save.equipment[gone];
    save.inventory.push(appeared);
    await db.putCharacter(charId, userId, save, 1, 'cmd:test');

    const plan = await planRollback(userId, cutoff);
    expect(plan.restore.map((r) => r.id), 'потерянная вещь должна вернуться').toContain(kept.uid);
    expect(plan.remove.map((r) => r.id), 'появившаяся позже должна быть забрана').toContain(appeared.uid);

    const done = await applyRollback(plan, 'тест');
    expect(done.restored).toBeGreaterThan(0);

    const after = await db.getCharacter(charId);
    const uids = [
      ...after!.data.inventory.map((i) => i.uid),
      ...Object.values(after!.data.equipment).map((i) => i?.uid),
    ];
    expect(uids, 'вещь на месте').toContain(kept.uid);
    expect(uids, 'лишней вещи нет').not.toContain(appeared.uid);

    // Леджер обязан согласиться с сейвом, иначе ближайший аудит назовёт откат нарушением.
    const row = await pool.q1<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [kept.uid]);
    expect(row?.loc).toBe(`char:${charId}`);
  });

  it('перековка записывается изменением, а не новой вещью', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const item = Object.values(save.equipment)[0]!;
    item.name = `${item.name} (перекован)`;
    await db.putCharacter(charId, userId, save, 1, 'cmd:forgeUpgrade');
    expect((await events(item.uid)).map((e) => e.kind)).toEqual(['created', 'changed']);
  });
});

/** Все uid персонажа: надетое, сумка, пояс. */
const uidsOf = (s: SaveState): string[] => [
  ...Object.values(s.equipment).filter(Boolean).map((i) => i!.uid),
  ...s.inventory.map((i) => i.uid),
  ...s.belt.filter(Boolean).map((i) => i!.uid),
];
/**
 * Сколько сеансов ЭТОГО файла сейчас ждут блокировку. Свои — по `application_name` (имя схемы файла, `testDb.ts`): база
 * общая, и ожидание блокировки в соседнем файле раньше давало ложное «отзыв уже ждёт».
 */
async function ourLockWaiters(): Promise<number> {
  const r = await pool.q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND application_name = current_setting('application_name')
       AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
  return r?.n ?? 0;
}
/** Дождаться, пока запрос этого файла встанет в ожидание блокировки строки. */
async function lockWait(ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ourLockWaiters() > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}
/**
 * Открыть «запись игры», не закрывая её: перенос вещи из снаряжения в сундук, как это делает
 * `putCharacterWithStash`, — строка персонажа уже под блокировкой, фиксации ещё нет.
 */
async function gameMovesToStash(userId: string, charId: string, save: SaveState, slot: keyof SaveState['equipment']) {
  const y = save.equipment[slot]!;
  const moved = structuredClone(save);
  delete moved.equipment[slot];
  const stash = emptyStash(cfg);
  stash.tabs[0]!.push({ ...y, pos: { x: 0, y: 0 } });
  const gc = await pool.pool.connect();
  await gc.query('BEGIN');
  await gc.query('UPDATE characters SET data = $1, version = version + 1, updated_at = now() WHERE char_id = $2', [JSON.stringify(moved), charId]);
  await gc.query('INSERT INTO account_stash (user_id, data, updated_at, version) VALUES ($1, $2, now(), 1)', [userId, JSON.stringify(stash)]);
  return { gc, y };
}

/**
 * ⭐ R1-17: ИНСТРУМЕНТЫ АДМИНА ПО ЖИВОМУ СЕРВЕРУ. Отзыв и откат читали строки персонажей и сундука без
 * блокировки, а писали безусловно: запись игры, успевшая между их чтением и записью, затиралась старой
 * копией (вещь, только что ушедшая в сундук, оказывалась и там, и в сейве). И брали блокировки в обратном
 * порядке: вещи → персонажи, тогда как игра пишет персонажа → сундук → вещи, — взаимная блокировка.
 */
describe.runIf(process.env.DM_SKIP_PG !== '1')('R1-17: отзыв и откат против живой записи игры', () => {
  it('⭐ отзыв ждёт открытую запись игры и не затирает её старой копией', async () => {
    if (!alive) return;
    const { revokeItem } = await import('./items.js');
    const { userId, charId, save } = await freshChar();
    const slots = Object.keys(save.equipment) as (keyof SaveState['equipment'])[];
    const x = save.equipment[slots[0]!]!;
    const { gc, y } = await gameMovesToStash(userId, charId, save, slots[1]!);
    try {
      const revoking = revokeItem(x.uid, 'тест гонки');
      expect(await lockWait(), 'отзыв ждёт блокировку').toBe(true);
      await gc.query('COMMIT');
      await revoking;
    } finally { gc.release(); }
    const inChar = uidsOf((await db.getCharacter(charId))!.data);
    expect(inChar, 'X отозван').not.toContain(x.uid);
    expect(inChar, 'Y ушёл в сундук — отзыв его не вернул в сейв').not.toContain(y.uid);
    expect((await db.getAccountStash(userId))!.data.tabs.flat().map((i) => i.uid)).toContain(y.uid);
  });

  it('⭐ откат ждёт открытую запись игры и не затирает её старой копией', async () => {
    if (!alive) return;
    const { planRollback, applyRollback } = await import('./rollback.js');
    const { userId, charId, save } = await freshChar();
    await new Promise((r) => setTimeout(r, 30));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 30));
    const appeared = { ...Object.values(save.equipment)[0]!, uid: uuidv7(), name: 'Появилась позже', pos: { x: 0, y: 0 } };
    save.inventory.push(appeared);
    await db.putCharacter(charId, userId, save, 1, 'cmd:test');
    const plan = await planRollback(userId, cutoff);
    expect(plan.remove.map((r) => r.id)).toContain(appeared.uid);

    const slots = Object.keys(save.equipment) as (keyof SaveState['equipment'])[];
    const { gc, y } = await gameMovesToStash(userId, charId, save, slots[1]!);
    try {
      const applying = applyRollback(plan, 'тест гонки');
      expect(await lockWait(), 'откат ждёт блокировку').toBe(true);
      await gc.query('COMMIT');
      await applying;
    } finally { gc.release(); }
    const inChar = uidsOf((await db.getCharacter(charId))!.data);
    expect(inChar, 'появившаяся позже забрана').not.toContain(appeared.uid);
    expect(inChar, 'Y ушёл в сундук — откат его не вернул в сейв').not.toContain(y.uid);
    expect((await db.getAccountStash(userId))!.data.tabs.flat().map((i) => i.uid)).toContain(y.uid);
  });

  it('⭐ отзыв берёт блокировки в порядке записи игры — взаимной блокировки нет', async () => {
    if (!alive) return;
    const { revokeItem } = await import('./items.js');
    const { charId, save } = await freshChar();
    const x = Object.values(save.equipment)[0]!;
    const gc = await pool.pool.connect();
    let gameErr: unknown = null;
    let revokeErr: unknown = null;
    try {
      await gc.query('BEGIN');
      // Запись игры: сперва строка персонажа, потом строки вещей (`syncItems`) — ровно в этом порядке.
      await gc.query('UPDATE characters SET updated_at = now(), version = version + 1 WHERE char_id = $1', [charId]);
      const revoking = revokeItem(x.uid, 'тест порядка').then(() => null, (e: unknown) => e);
      expect(await lockWait()).toBe(true);
      try {
        await gc.query('UPDATE items SET moved_at = now() WHERE id = $1', [x.uid]);
        await gc.query('COMMIT');
      } catch (e) {
        gameErr = e;
        await gc.query('ROLLBACK').catch(() => undefined);
      }
      revokeErr = await revoking;
    } finally { gc.release(); }
    expect(String(gameErr ?? ''), 'запись игры не убита').toBe('');
    expect(String(revokeErr ?? ''), 'отзыв не убит').toBe('');
  });
});

describe('леджер не видит сырьё (чистая проверка, базы не требует)', () => {
  const IRON = { id: 'iron-1', name: 'Ржавое железо', family: 'iron', tier: 1 };

  it('⭐ стеки материалов не попадают в леджер, обычные вещи попадают', () => {
    const sword: Item = {
      uid: uuidv7(), baseId: 'b', name: 'Меч', slot: 'weapon', rarity: 'normal', itemLevel: 1,
      requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: { x: 0, y: 0 },
    };
    const save = {
      equipment: {}, belt: [],
      inventory: [sword, materialItem(IRON, 200, uuidv7()), materialItem(IRON, 40, uuidv7())],
    } as unknown as SaveState;

    // ⚠ Отсекать обязано ПРАВИЛО (kind), а не формат uid: uid здесь — настоящий UUID,
    // то есть случайная защита через `isUuid` тут не срабатывает вовсе.
    expect(itemsOfSave(save).map((i) => i.uid)).toEqual([sword.uid]);
  });

  it('и в сундуке тоже — если стек туда всё же попадёт, леджер его не подхватит', () => {
    const stash = { version: 1, tabs: [[materialItem(IRON, 10, uuidv7())]] } as unknown as AccountStash;
    expect(itemsOfStash(stash)).toEqual([]);
  });

  it('пояс и экипировка фильтруются тем же правилом', () => {
    const save = {
      equipment: { weapon: materialItem(IRON, 5, uuidv7()) },
      belt: [materialItem(IRON, 5, uuidv7()), null],
      inventory: [],
    } as unknown as SaveState;
    expect(itemsOfSave(save)).toEqual([]);
  });
});

/** Сколько событий вида `kind` у этих вещей. */
const countEvents = async (kind: string, ids: readonly string[]): Promise<number> =>
  (await pool.q1<{ n: number }>('SELECT count(*)::int AS n FROM item_events WHERE kind = $1 AND item_id = ANY($2)', [kind, ids]))!.n;
const createdReason = async (id: string): Promise<string | null> =>
  (await pool.q1<{ reason: string | null }>(`SELECT reason FROM item_events WHERE item_id = $1 AND kind = 'created'`, [id]))?.reason ?? null;
/** Копия вещи с новым uid — «другая вещь» того же вида. */
const copyOf = (it: Item, x: number, name?: string): Item => ({ ...structuredClone(it), uid: uuidv7(), pos: { x, y: 0 }, ...(name ? { name } : {}) });

describe.runIf(process.env.DM_SKIP_PG !== '1')('раунд 2: журнал вещей, сброс забегов, схема', () => {
  it('⭐ R2-06: неизменный сейв и сундук не пишут в журнал НИЧЕГО — порядок ключей jsonb не «изменение»', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const first = Object.values(save.equipment)[0]!;
    const stash = emptyStash(cfg);
    for (let k = 0; k < 6; k++) stash.tabs[0]!.push(copyOf(first, k * 2));
    const ids = [...itemsOfSave(save), ...itemsOfStash(stash)].map((i) => i.uid);
    let v = 1;
    for (let i = 0; i < 3; i++) v = (await db.putCharacter(charId, userId, save, v))!;
    let sv = 0;
    for (let i = 0; i < 3; i++) {
      const r = await db.putCharacterWithStash(charId, userId, save, v, stash, sv);
      if (!r.ok) throw new Error(`запись не прошла: ${r.conflict}`);
      v = r.version; sv = r.stashVersion;
    }
    expect(await countEvents('changed', ids), 'ничего не менялось — изменений в журнале нет').toBe(0);

    stash.tabs[0]![0]!.name = `${stash.tabs[0]![0]!.name} (зачарован)`;
    const r = await db.putCharacterWithStash(charId, userId, save, v, stash, sv);
    expect(r.ok).toBe(true);
    expect(await countEvents('changed', ids), 'изменилась одна вещь — одно событие').toBe(1);
  });

  it('⭐ R2-21: причины по uid — «ковкой» подписана только скованная вещь, остальные новые идут автосейвом', async () => {
    if (!alive) return;
    const { userId, charId, save } = await freshChar();
    const first = Object.values(save.equipment)[0]!;
    const bought = copyOf(first, 0, 'Куплена в лавке'), forged = copyOf(first, 2, 'Скована');
    save.inventory.push(bought, forged);
    const r = await db.putCharacterWithStash(charId, userId, save, 1, emptyStash(cfg), 0, 'craft', new Map([[forged.uid, 'craft']]));
    expect(r.ok).toBe(true);
    expect(await createdReason(forged.uid)).toBe('craft');
    expect(await createdReason(bought.uid), 'купленное до ковки — не ковка').toBe('autosave');
  });

  it('⭐ R2-32: откат видит разбор и переплавку после отсечки — сырьё и журнал кузнеца он не вернёт, и план это говорит', async () => {
    if (!alive) return;
    const { planRollback } = await import('./rollback.js');
    const { userId, charId, save } = await freshChar();
    const slot = Object.keys(save.equipment)[0] as keyof SaveState['equipment'];
    const w = save.equipment[slot]!;
    await new Promise((r) => setTimeout(r, 50));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 50));
    delete save.equipment[slot];
    const stash = emptyStash(cfg);
    stash.forgeJournal = { ...emptyJournal(), mythic: 1 };
    stash.materials = { 'iron-1': 7 };
    const r = await db.putCharacterWithStash(charId, userId, save, 1, stash, 0, 'salvage', new Map([[w.uid, 'salvage']]));
    expect(r.ok).toBe(true);
    const plan = await planRollback(userId, cutoff);
    expect(plan.restore.map((x) => x.id), 'разобранная вещь вернётся').toContain(w.uid);
    expect(plan.forge.map((f) => [f.id, f.reason]), 'а её выход — нет: план обязан это назвать').toContainEqual([w.uid, 'salvage']);
    expect(plan.journalMythic, 'мифики журнала — к ручной сверке').toBe(1);
  });

  it('⭐ R2-11: сброс забегов на старте ноды не трогает героя, живого на ДРУГОЙ ноде; ничей — сбрасывает', async () => {
    if (!alive) return;
    const reg = await import('../cluster/registry.js');
    await reg.initClusterSchema();
    const tag = `r211${Date.now().toString(36)}`;
    const other = `${tag}-a`, self = `${tag}-b`;
    await reg.heartbeat(other, 'ws://a', { players: 0, rooms: 0, cpuSeconds: 0, rssBytes: 0, loopP99: 0, tickHz: 0, draining: false });
    try {
      const run = { templateId: 't', config: { templateId: 't', biomeId: 'b', tier: 'normal', seed: 1, modifiers: [] }, currentNodeId: 'start', visited: [] } as unknown as SaveState['run'];
      const live = await freshChar(), idle = await freshChar();
      for (const c of [live, idle]) { c.save.run = run; await db.putCharacter(c.charId, c.userId, c.save, 1); }
      expect(await reg.claimForJoin(live.charId, other)).toBe(other);
      const v0 = (await db.getCharacter(live.charId))!.version;
      await db.clearAllRuns(self);
      const after = (await db.getCharacter(live.charId))!;
      expect(after.data.run, 'забег героя на живой ноде цел').toBeTruthy();
      expect(after.version, 'и версия его сессии не сбита').toBe(v0);
      expect((await db.getCharacter(idle.charId))!.data.run, 'ничей забег сброшен').toBeUndefined();
    } finally {
      await pool.q('DELETE FROM char_claims WHERE node_id LIKE $1', [`${tag}-%`]);
      await pool.q('DELETE FROM cluster_nodes WHERE id LIKE $1', [`${tag}-%`]);
    }
  });

  it('⭐ R2-22: схема на месте — повторный старт не встаёт в очередь за долгим читателем и не держит чтение сундука', async () => {
    if (!alive) return;
    await pool.initSchema();                     // схема и её отпечаток на месте
    const { default: pg } = await import('pg');
    const reader = new pg.Client({ connectionString: process.env.DM_PG });
    await reader.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT count(*) FROM account_stash');     // долгий читатель — ночной аудит
      // Без часов: ALTER правки схемы встал бы в ожидание блокировки за читателем (до `lock_timeout`, и так пять попыток),
      // а чтение сундука — за ним. Наблюдатель опрашивает, не ждёт ли блокировку хоть один сеанс файла, пока старт и
      // чтение идут; читатель держит транзакцию всё это время — закончиться «после него» им не дано.
      let waited = 0, done = false;
      const watch = (async () => {
        while (!done) { waited = Math.max(waited, await ourLockWaiters()); await new Promise((r) => setTimeout(r, 20)); }
      })();
      const work = Promise.all([pool.initSchema(), db.getAccountStash('нет-такого-аккаунта')]);
      const finished = await Promise.race([work.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
      done = true;
      await watch;
      expect(finished, 'старт и чтение сундука закончились, пока долгий читатель держит транзакцию').toBe(true);
      expect(waited, 'ни старт, ни чтение сундука не ждали блокировку за читателем').toBe(0);
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await reader.end();
    }
  }, 30_000);
});

describe.runIf(process.env.DM_SKIP_PG !== '1')('раунд 4: одновременные записи героев аккаунта, потолок ростера', () => {
  it('⭐ R4-10: два героя аккаунта обменялись вещами — одновременные записи не взаимоблокируются, вещь ровно у одного', async () => {
    if (!alive) return;
    const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
    const cls = cfg.get('classes')[0]!.id;
    const X = uuidv7(), Y = uuidv7();
    const sx = newCharacterSave(cfg, cls, 'Икс', X), sy = newCharacterSave(cfg, cls, 'Игрек', Y);
    await db.createCharacter(X, userId, sx);
    await db.createCharacter(Y, userId, sy);
    // По вещи из комплекта каждого — в сумку: их и будем передавать друг другу.
    const i1 = takeEquipped(sx), i2 = takeEquipped(sy);
    sx.inventory.push(i1); sy.inventory.push(i2);
    let vx = (await db.putCharacter(X, userId, sx, 1))!, vy = (await db.putCharacter(Y, userId, sy, 1))!;
    const deadlocks: string[] = [];
    for (let round = 0; round < 20; round++) {
      // Обмен: у X — вещь Y, у Y — вещь X (и обратно на следующем круге). Записи — разом, как `persistAll`.
      const [a, b] = round % 2 === 0 ? [i2, i1] : [i1, i2];
      sx.inventory = [a]; sy.inventory = [b];
      const [rx, ry] = await Promise.allSettled([db.putCharacter(X, userId, sx, vx), db.putCharacter(Y, userId, sy, vy)]);
      for (const r of [rx, ry]) if (r.status === 'rejected') deadlocks.push(String((r.reason as { code?: string }).code ?? r.reason));
      if (rx.status === 'fulfilled' && rx.value) vx = rx.value;
      if (ry.status === 'fulfilled' && ry.value) vy = ry.value;
    }
    expect(deadlocks, 'ни одной взаимоблокировки').toEqual([]);
    const rows = await pool.q<{ id: string; loc: string }>('SELECT id, loc FROM items WHERE id = ANY($1)', [[i1.uid, i2.uid]]);
    const at = new Map(rows.map((r) => [r.id, r.loc]));
    const [dx, dy] = [(await db.getCharacter(X))!.data, (await db.getCharacter(Y))!.data];
    for (const it of [i1, i2]) {
      const holders = [dx, dy].filter((s) => s.inventory.some((i) => i.uid === it.uid)).map((s) => `char:${s.charId}`);
      expect(holders, `вещь ${it.uid} ровно в одном сейве`).toHaveLength(1);
      expect(at.get(it.uid), 'леджер согласен с сейвом').toBe(holders[0]);
    }
  }, 30_000);

  it('⭐ R4-30: потолок ростера держит сама база — пять одновременных созданий пятого героя дают ровно одного', async () => {
    if (!alive) return;
    const userId = await db.createUser(`t_${uuidv7().slice(-12)}`, 'h', 's');
    const cls = cfg.get('classes')[0]!.id;
    for (let i = 0; i < 4; i++) { const id = uuidv7(); await db.createCharacter(id, userId, newCharacterSave(cfg, cls, `Г${i}`, id), 5); }
    const tries = await Promise.all([0, 1, 2, 3, 4].map(() => {
      const id = uuidv7();
      return db.createCharacter(id, userId, newCharacterSave(cfg, cls, 'Лишний', id), 5);
    }));
    expect(tries.filter((v) => v !== null), 'создан ровно один').toHaveLength(1);
    expect(await db.countCharacters(userId)).toBe(5);
  }, 30_000);
});
