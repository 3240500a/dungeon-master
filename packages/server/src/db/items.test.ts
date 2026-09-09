import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigRegistry, newCharacterSave, emptyStash, uuidv7, type SaveState, type AccountStash, type Item } from '@dm/shared';

/**
 * Леджер предметов и журнал происхождения (Ф2) — против НАСТОЯЩЕЙ базы.
 *
 * Мокать здесь нечего: проверяется ровно то, что делает Postgres (транзакция, первичный ключ,
 * триггер запрета переписывания журнала). Без базы тест пропускается — `DM_PG` или локальный
 * PostgreSQL на 5432, см. `loadtest/README.md`.
 */
const PG = process.env.DM_PG ?? 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test';
process.env.DM_PG = PG;

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let alive = false;
let cfg: ConfigRegistry;

beforeAll(async () => {
  pool = await import('./pool.js');
  try {
    await pool.initSchema();
    alive = true;
  } catch {
    alive = false;   // базы нет — тесты ниже пропустятся
    return;
  }
  db = await import('./db.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterAll(async () => { if (alive) await pool.closePool(); });

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

    const v = await db.putCharacterWithStash(charId, userId, save, 1, stash);
    expect(v).toBe(2);

    const row = await pool.q1<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [item.uid]);
    expect(row?.loc).toBe('stash');
    expect((await events(item.uid)).map((e) => e.kind)).toEqual(['created', 'moved']);
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

    const r = await runAudit();
    const dupe = r.findings.find((f) => f.kind === 'dupe');
    const legacy = r.findings.find((f) => f.kind === 'legacy');
    expect(dupe, 'дубль обязан быть найден').toBeTruthy();
    expect(dupe!.examples.join(' ')).toContain(shared.uid);
    expect(legacy, 'старый id обязан быть замечен').toBeTruthy();
    expect(r.incidents, 'дубль это инцидент, а не замечание').toBeGreaterThan(0);

    // Убираем за собой, иначе следующий прогон аудита будет вечно красным.
    await pool.q('DELETE FROM characters WHERE char_id = $1', [b.charId]);
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
