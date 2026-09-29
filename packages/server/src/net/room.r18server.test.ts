import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type SaveState } from '@dm/shared';

/**
 * ⭐ РАУНД 18 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), без часов.
 *  • R18-01: СОКЕТ, ЗАКРЫТЫЙ ТРАНСПОРТОМ ПОСРЕДИ РАССЫЛКИ МИРА ТОГО ЖЕ ТИКА, ГДЕ ГЕРОЙ ПОГИБ. Тик сессии убивал героя и клал «погиб» в события,
 *    дальше шла рассылка мира (`emitWorld`) — и лишь потом события (`absorb` → `onPlayerDeath`: штраф и метка «оплачено»). Очередь сокета выше
 *    потолка (связь встала или модифицированный клиент перестал читать) — транспорт закрывал сокет прямо в отправке, а закрытие звало снятие
 *    сессии синхронно (B3-V2): `removePlayer` строил копию ждущего реконнекта с «смерть оплачена» по `!p.alive`, сущность уходила — и
 *    `onPlayerDeath` не находил ни её, ни клиента: штрафа не было вовсе, а «оплачено» дальше верили все (`paidOf`: «Завершить», истёкший грейс,
 *    вайп, реконнект). Теперь смерти тика оплачиваются сразу после тика, до любой рассылки (`chargeDeaths`), а снятие, догнавшее смерть без
 *    штрафа, берёт его само; транспорт зовёт снятие сессии не изнутри отправки, а ближайшей микрозадачей (`wsServer.ts`, `uwsServer.ts`).
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, unknown>(),
  /** R18-03: закрепления героев (`char_claims`): чья нода держит героя. Нет строки — ничья. */
  claims: new Map<string, string>(),
  /** R18-03: записи по строке базы с проверкой владения (`putCharacterOwned`), отказанные — чужая нода. */
  foreign: 0,
}));
vi.mock('../db/db.js', () => {
  const put = (charId: string, data: SaveState, v: number): Promise<number | null> => {
    const snap = structuredClone(data);
    if (v !== (db.versions.get(charId) ?? 1)) return Promise.resolve(null);
    db.versions.set(charId, v + 1); db.data.set(charId, snap);
    return Promise.resolve(v + 1);
  };
  return {
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => put(charId, data, v),
  // ⭐ R18-03: как в базе — проверка владения тем же запросом, что и запись: закрепление героя не за этой нодой — отказ `foreign`, без записи.
  putCharacterOwned: (charId: string, _u: string, data: SaveState, v: number, owner: { node: string }) => {
    if (db.claims.get(charId) !== owner.node) { db.foreign++; return Promise.resolve('foreign'); }
    return put(charId, data, v);
  },
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: (charId: string) => {
    const d = db.data.get(charId);
    return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null);
  },
  landedVersion: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Info = { paid: boolean; fled: boolean; save: SaveState };
type Pl = { hp: number; alive: boolean; debuffs: Record<string, unknown>; save: SaveState };
type RoomIn = {
  area: string;
  snapAcc: number;
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string): void;
  castVote(pid: string, yes: boolean): void;
  returnTown(pid: string): void;
  removePlayer(pid: string): Promise<unknown>;
  abandonAsDead(charId: string): Promise<unknown>;
  step(emit?: boolean): void;
  stop(): void;
  movedAt: number;
  session: { world: { players: Record<string, Pl & { pos: { x: number; y: number } }>; timeMs: number; spawn: { x: number; y: number } } };
  disconnected: Map<string, Info>;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let setRowOwner: (o: { node: string; leased: boolean } | null) => void;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor, setRowOwner } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor; setRowOwner: typeof setRowOwner });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); setRowOwner(null); db.claims.clear(); vi.restoreAllMocks(); });

/** Соединение глазами комнаты. `onSend` зовётся ВНУТРИ `send` — как закрытие транспорта на переполнении очереди до правки (B3-V2). */
class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  onSend?: (raw: string | Uint8Array) => void;
  send(raw: string | Uint8Array): void { if (this.open) this.onSend?.(raw); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
let seq = 0;
function newRoom(): RoomIn {
  const room = new RoomCtor(`R18R${++seq}`, cfg, hooks);
  rooms.push(room);
  room.stop();   // тик — только шагами теста
  return room;
}
function hero(gold = 100_000): SaveState {
  const charId = `char-r18r-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.gold = gold;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
/** Смертельный яд: герой гибнет в тике сессии следующего шага. */
function poison(room: RoomIn, pid: string): void {
  room.session.world.players[pid]!.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: room.session.world.timeMs + 60_000, mag: 1e9, mag2: 0 };
}
/** Следующий шаг рассылает мир (снапшот по своей частоте: 20 Гц против 60 Гц тика). */
const broadcastsNext = (room: RoomIn): void => { room.snapAcc = 1 / 20 - 1 / 60; };
/** Транспорт: первый двоичный кадр мира закрывает сокет (очередь выше потолка), а закрытие СИНХРОННО снимает сессию (`onClose`). */
function dropOnWorldFrame(room: RoomIn, ws: FakeWs, pid: string): () => boolean {
  let dropped = false;
  ws.onSend = (raw) => {
    if (dropped || typeof raw === 'string') return;
    dropped = true;
    ws.open = false;
    void room.removePlayer(pid);
  };
  return () => dropped;
}

describe('⭐ R18-01: смерть тика оплачена до рассылки мира — закрытие сокета посреди неё штраф не отменяет', () => {
  it('соло: сокет закрыт кадром мира тика смерти — копия ждущего со штрафом, «Завершить» пишет урезанное золото', async () => {
    const room = newRoom();
    const save = hero();
    const charId = save.charId;
    const ws = new FakeWs();
    const pid = room.addPlayer(ws, `user-${charId}`, save, 1);
    await settle();
    room.descend(pid);   // соло: голос проходит сразу
    await settle();
    expect(room.area, 'в подземелье').toBe('dungeon');
    const goldBefore = room.session.world.players[pid]!.save.gold;
    broadcastsNext(room);
    poison(room, pid);
    const dropped = dropOnWorldFrame(room, ws, pid);
    room.step(true);
    await settle();
    expect(dropped(), 'кадр мира тика смерти закрыл сокет').toBe(true);
    const info = room.disconnected.get(charId);
    expect(info, 'ждёт реконнекта').toBeTruthy();
    expect(info!.paid, '«смерть оплачена»').toBe(true);
    expect(info!.save.gold, 'штраф смерти — в копии ждущего').toBeLessThan(goldBefore);
    expect(info!.save.run?.deadAt, 'и метка «оплачено» — в сейве, одной записью со штрафом (V1)').toBeDefined();
    const copyGold = info!.save.gold;
    await room.abandonAsDead(charId);
    await settle();
    const row = db.data.get(charId) as SaveState;
    expect(row.gold, '«Завершить» — без второго штрафа, но и не бесплатно').toBe(copyGold);
    expect(row.gold).toBeLessThan(goldBefore);
    expect(row.run, 'забег снят').toBeUndefined();
  });

  it('кооп: двое гибнут в одном тике, у второго сокет закрыт кадром мира — штраф ровно один у каждого', async () => {
    const room = newRoom();
    const a = hero(), b = hero();
    const wsA = new FakeWs(), wsB = new FakeWs();
    const pidA = room.addPlayer(wsA, `user-${a.charId}`, a, 1);
    const pidB = room.addPlayer(wsB, `user-${b.charId}`, b, 1);
    await settle();
    room.movedAt = 0;
    room.descend(pidA); room.castVote(pidB, true);
    await settle();
    expect(room.area).toBe('dungeon');
    const goldA = room.session.world.players[pidA]!.save.gold;
    const goldB = room.session.world.players[pidB]!.save.gold;
    const once = (g: number): number => g - Math.floor(g * cfg.get('balance').deathPenalty.goldPercent);   // золото штрафа — доля, без броска
    broadcastsNext(room);
    poison(room, pidA); poison(room, pidB);
    const dropped = dropOnWorldFrame(room, wsB, pidB);
    room.step(true);
    await settle();
    expect(dropped()).toBe(true);
    const pa = room.session.world.players[pidA]!;
    expect(pa.alive).toBe(false);
    expect(pa.save.gold, 'A: штраф взят, и один').toBe(once(goldA));
    // Погибли все — вайп: ждущий реконнекта B похоронен (копия — «оплачено», второго штрафа нет) и записан.
    expect(room.disconnected.has(b.charId), 'B похоронен вайпом').toBe(false);
    const rowB = db.data.get(b.charId) as SaveState;
    expect(rowB.gold, 'B: штраф взят до снятия, и один').toBe(once(goldB));
    expect(rowB.run, 'B: забег снят').toBeUndefined();
  });
});

describe('⭐ R18-03: запись по строке базы — только пока героя держит эта нода', () => {
  /**
   * Нода A: пати в подземелье, H ушёл посреди боя (ждёт реконнекта, `fled`). Машина A стояла дольше `NODE_DEAD_SEC` с остановленными часами:
   * H взяла нода B — закрепление за ней, тот же забег, и она писала его строку. A оттаяла: аренда по часам процесса цела, и до её удара сердца
   * кадры в очереди исполняются — «в город» напарника хоронит сбежавшего. Копия отклонена по версии, и действие ложилось по СВЕЖЕЙ строке
   * (`settleStored`): штраф и снятие забега, который H играет на B. Теперь запись по строке — с проверкой закрепления тем же запросом
   * (`putCharacterOwned`): героя держит другая нода — отказ, копия забыта (ИНЦИДЕНТ), строка цела.
   */
  async function thawBury(claim: string): Promise<{ goldOnB: number; after: SaveState; warn: string[] }> {
    setRowOwner({ node: 'node-A', leased: true });
    const room = newRoom();
    const a = hero(), h = hero();
    db.claims.set(a.charId, 'node-A'); db.claims.set(h.charId, 'node-A');
    const pidA = room.addPlayer(new FakeWs(), `user-${a.charId}`, a, 1);
    const pidH = room.addPlayer(new FakeWs(), `user-${h.charId}`, h, 1);
    await settle();
    room.movedAt = 0;
    room.descend(pidA); room.castVote(pidH, true);
    await settle();
    expect(room.area).toBe('dungeon');
    await room.removePlayer(pidH);   // H отвалился; прощальная легла
    await settle();
    room.disconnected.get(h.charId)!.fled = true;   // ушёл посреди боя (R4-14)
    // «Нода B»: H продолжил ТОТ ЖЕ забег там, строка сдвинута (жив, забег цел, его золото).
    const row = structuredClone(db.data.get(h.charId) as SaveState);
    expect(row.run).toBeTruthy();
    db.data.set(h.charId, row); db.versions.set(h.charId, (db.versions.get(h.charId) ?? 1) + 3);
    db.claims.set(h.charId, claim);
    const warn: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...x: unknown[]) => { warn.push(x.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...x: unknown[]) => { warn.push(x.map(String).join(' ')); });
    // «Оттаяла»: «в город» напарника (кадр ждал в очереди сокета) исполняется до удара сердца.
    room.movedAt = 0;
    room.session.world.players[pidA]!.pos = { ...room.session.world.spawn };
    room.returnTown(pidA);
    await settle();
    return { goldOnB: row.gold, after: db.data.get(h.charId) as SaveState, warn };
  }

  it('героя держит другая нода — ни штрафа, ни снятия забега на его строке; ИНЦИДЕНТ в лог', async () => {
    const { goldOnB, after, warn } = await thawBury('node-B');
    expect(after.run, 'забег, который H играет на B, цел').toBeTruthy();
    expect(after.gold, 'штрафа на чужой строке нет').toBe(goldOnB);
    expect(db.foreign, 'запись по строке отказана проверкой владения').toBeGreaterThan(0);
    expect(warn.some((l) => /ИНЦИДЕНТ/.test(l)), warn.join(' | ')).toBe(true);
  });

  it('живая сессия, чьего героя держит другая нода: её запись отказана тем же запросом — сессия снята (4009) без записи, ИНЦИДЕНТ', async () => {
    setRowOwner({ node: 'node-A', leased: true });
    const room = newRoom();
    const h = hero();
    db.claims.set(h.charId, 'node-A');
    const ws = new FakeWs();
    const closed: number[] = [];
    ws.close = (code?: number): void => { ws.open = false; if (code !== undefined) closed.push(code); };
    const pid = room.addPlayer(ws, `user-${h.charId}`, h, 1);
    await settle();
    const v0 = db.versions.get(h.charId);
    db.claims.set(h.charId, 'node-B');   // героя забрала другая нода (эта простояла дольше срока смерти)
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...x: unknown[]) => { errs.push(x.map(String).join(' ')); });
    const r = await (room as unknown as { persist(pid: string): Promise<string> }).persist(pid);
    expect(r).toBe('conflict');
    expect(db.versions.get(h.charId), 'строка не тронута').toBe(v0);
    expect(closed, 'сессия снята устаревшей').toContain(4009);
    expect(room.disconnected.has(h.charId), 'и не ждёт реконнекта: правда о герое — там').toBe(false);
    expect(errs.some((l) => /ИНЦИДЕНТ/.test(l)), errs.join(' | ')).toBe(true);
  });

  it('контроль (R4-15): героя держит эта нода — штраф и снятие забега ложатся по строке базы, как прежде', async () => {
    const { goldOnB, after } = await thawBury('node-A');
    expect(after.run, 'забег снят').toBeUndefined();
    expect(after.gold, 'штраф взят').toBeLessThan(goldOnB);
  });
});
