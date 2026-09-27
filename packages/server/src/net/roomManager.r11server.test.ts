import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

// Тест ждёт менеджер оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Гонок этот потолок не прячет:
// исходы решает мок базы (упала ли фиксация), а не время.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 11 (сервер), граница менеджера комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии сейва), её
 * фиксация умеет «упасть с неизвестным исходом» (`CommitUnknown`): легла или нет — решает тест.
 *  • R11-03: живая сессия, чья запись кончилась `CommitUnknown`, снимается — но её копия не выбрасывается: менеджер держит её «на
 *    дописать», вход отвечает «сохраняем», пока она не ляжет, и отданное соседу по аккаунту не остаётся у двоих;
 *  • R11-06: кадры лобби с одним токеном с N сокетов — сессия из базы не на каждый кадр (потолок аккаунта — ДО базы);
 *  • R11-12: номер прощальной записи (`farewellSeq`) героя, ушедшего насовсем, не живёт вечно.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  /** Запись героя падает на фиксации: `lost` — не легла, `landed` — легла, но ответ потерян. Пока стоит — каждая. */
  fail: new Map<string, 'lost' | 'landed'>(),
  sessionLookups: 0,
  log: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  getSession: async () => { db.sessionLookups++; return 'user-r11rm'; },
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: 'user-r11rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);
    await new Promise((res) => setTimeout(res, 2));   // круг базы
    const r = db.chars.get(charId);
    const how = db.fail.get(charId);
    if (how) {
      const { CommitUnknown } = await import('../db/errors.js');
      if (how === 'landed' && r && v === r.version) { r.version = v + 1; r.data = snap; }
      db.log.push(`${charId} v${v} COMMIT-UNKNOWN (${how})`);
      throw new CommitUnknown(new Error('Connection terminated unexpectedly'), false);
    }
    if (!r || v !== r.version) { db.log.push(`${charId} v${v} CONFLICT`); return null; }
    r.version = v + 1; r.data = snap;
    db.log.push(`${charId} v${v}->v${r.version}`);
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

const TOK = 'cd'.repeat(32);
class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  closedWith?: number;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1') {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(code?: number): void { if (!this.open) return; this.open = false; this.closedWith = code; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Ждать условия оборотами цикла (не часами): записи мока идут кругами по несколько мс. */
async function until(what: string, ok: () => boolean, turns = 3_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type Drop = { id: number; pos: { x: number; y: number }; item?: { uid: string } };
type RoomIn = {
  code: string; area: string; movedAt: number; stop(): void;
  persist(pid: string): Promise<string>;
  session: { world: { drops: Drop[]; players: Record<string, { pos: { x: number; y: number }; save: SaveState }> } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; graceByChar: Map<string, RoomIn>; inflight: Map<string, unknown>; live: Map<string, unknown>;
  unsaved: Map<string, unknown>; charOps: Map<string, unknown>; farewellSeq: Map<string, unknown>;
  retryUnsaved(now?: number): Promise<void>;
};
let rm: InstanceType<typeof import('./roomManager.js').RoomManager>;
let cfg: ConfigRegistry;
const mgr = (): RMIn => rm as unknown as RMIn;
beforeAll(async () => {
  const { RoomManager } = await import('./roomManager.js');
  cfg = new ConfigRegistry();
  cfg.loadAll();
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19): её зовёт тест
  try { rm = new RoomManager(cfg); } finally { vi.useRealTimers(); }
});
afterAll(() => { for (const r of mgr().rooms.values()) r.stop(); });
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync]) l.reset('user-r11rm');
});

function seed(id: string, patch?: (s: SaveState) => void): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  patch?.(s);
  db.chars.set(id, { data: s, version: 1 });
}
const uidsOf = (s: SaveState): string[] => [
  ...Object.values(s.equipment).filter(Boolean).map((i) => i!.uid), ...s.inventory.map((i) => i.uid), ...s.belt.filter(Boolean).map((i) => i!.uid),
];
let ipSeq = 0;
function conn(): FakeConn { const ws = new FakeConn(`198.51.100.${++ipSeq}`); rm.handleConnection(ws); return ws; }
async function joinFresh(charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = conn();
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  return ws;
}

/**
 * Герои A и B одного аккаунта в одной комнате: A бросает вещь X, B поднимает, запись B ложится (X в строке B). Затем запись A
 * падает на фиксации с неизвестным исходом (`how`). Возвращает, что нужно тесту.
 */
async function handOffThenUnknown(a: string, b: string, how: 'lost' | 'landed'): Promise<{ X: string; room: RoomIn; wsA: FakeConn }> {
  let X = '';
  seed(a, (s) => { const w = s.equipment.weapon!; delete s.equipment.weapon; w.pos = { x: 0, y: 0 }; s.inventory.push(w); X = w.uid; });
  seed(b);
  const wsA = await joinFresh(a);
  const code = wsA.last('joined')!.roomCode;
  const pidA = wsA.last('joined')!.playerId;
  const wsB = await joinFresh(b, code);
  const pidB = wsB.last('joined')!.playerId;
  const room = mgr().rooms.get(code)!;
  await until('записи входа легли', () => !mgr().inflight.size);
  for (let i = 0; i < 30; i++) await tick();
  wsA.push({ t: 'cmd', command: { cmd: 'drop', uid: X }, id: 1 });
  await until('X на земле', () => room.session.world.drops.some((d) => d.item?.uid === X));
  const drop = room.session.world.drops.find((d) => d.item?.uid === X)!;
  room.session.world.players[pidB]!.pos = { ...drop.pos };
  wsB.push({ t: 'cmd', command: { cmd: 'pickup', dropId: drop.id }, id: 1 });
  await until('X у B', () => uidsOf(room.session.world.players[pidB]!.save).includes(X));
  expect(await room.persist(pidB)).toBe('ok');
  expect(uidsOf(db.chars.get(b)!.data as SaveState), 'X в строке B').toContain(X);
  db.fail.set(a, how);
  expect(await room.persist(pidA)).toBe('unknown');
  await until('A снят (4009)', () => wsA.closedWith === 4009);
  await until('менеджер отпустил A', () => !mgr().live.has(a) && !mgr().inflight.has(a) && !mgr().charOps.has(a));
  return { X, room, wsA };
}

describe('⭐ R11-03: `CommitUnknown` у живой сессии — копия не выброшена, а «на дописать»', () => {
  it('фиксация НЕ легла: копия у менеджера, вход «сохраняем», пока база лежит; легла копия — X только у B', async () => {
    const { X } = await handOffThenUnknown('R11A', 'R11B', 'lost');
    expect(mgr().unsaved.has('R11A'), 'копия A — на дописать').toBe(true);

    // База ещё лежит: вход не читает строку до копии.
    const ws1 = await joinFresh('R11A');
    expect(ws1.last('joined'), 'вход со старой строкой').toBeUndefined();
    expect(ws1.last('error')?.code, '«сохраняем, повторите»').toBe('busy');

    // База поднялась: вход дописывает копию и только потом читает строку.
    db.fail.delete('R11A');
    const ws2 = await joinFresh('R11A');
    expect(ws2.last('error'), JSON.stringify(ws2.last('error'))).toBeUndefined();
    const aRow = db.chars.get('R11A')!.data as SaveState;
    const bRow = db.chars.get('R11B')!.data as SaveState;
    expect(uidsOf(aRow).includes(X) && uidsOf(bRow).includes(X), `X у двоих: ${db.log.slice(-8).join(' | ')}`).toBe(false);
    expect(uidsOf(ws2.last('joined')!.save as SaveState), 'X не в живом сейве A').not.toContain(X);
    ws2.close();
    await until('A вышел', () => !mgr().inflight.has('R11A') && !mgr().charOps.has('R11A'));
  });

  it('контроль: фиксация ЛЕГЛА (ответ потерян) — дописка получает отказ по версии, дважды ничего не пишется, вход пускает', async () => {
    const { X } = await handOffThenUnknown('R11C', 'R11D', 'landed');
    const landed = db.chars.get('R11C')!.version;
    db.fail.delete('R11C');
    const ws = await joinFresh('R11C');
    expect(ws.last('error'), JSON.stringify(ws.last('error'))).toBeUndefined();
    expect(db.log.filter((l) => l.startsWith(`R11C v${landed - 1}->`)), 'та же версия второй раз не записана').toEqual([]);
    expect(uidsOf(db.chars.get('R11C')!.data as SaveState), 'в строке — легшая копия (без X)').not.toContain(X);
    expect(mgr().unsaved.has('R11C')).toBe(false);
    ws.close();
    await until('C вышел', () => !mgr().inflight.has('R11C') && !mgr().charOps.has('R11C'));
  });
});

describe('⭐ R11-06: кадры лобби с одним токеном с пяти сокетов — сессия из базы не на каждый кадр', () => {
  it('5 сокетов × 40 кадров «статус забега» — запросов сессии в базу не больше ~25', async () => {
    seed('R11L');
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    try {
      db.sessionLookups = 0;
      const socks: FakeConn[] = [];
      for (let c = 0; c < 5; c++) {
        const ws = conn();
        socks.push(ws);
        for (let i = 0; i < 40; i++) ws.push({ t: 'runStatus', token: TOK, charId: 'R11L' });
      }
      // Каждый кадр лобби получает ровно один ответ (статус или отказ «часто»).
      await until('ответы на все кадры', () => socks.every((w) => w.frames.length >= 40), 20_000);
      const answered = socks.flatMap((w) => w.frames).filter((f) => f.t === 'runStatus').length;
      expect(answered, 'статус получили').toBeGreaterThan(0);
      expect(db.sessionLookups, `запросов сессии: ${db.sessionLookups}`).toBeLessThanOrEqual(25);
      for (const ws of socks) ws.close();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('⭐ R11-12: номер прощальной записи героя, ушедшего насовсем, не живёт вечно', () => {
  it('5 героев ушли из подземелья, грейс истёк — после срока подметания их номеров нет; живой герой свой сохраняет', async () => {
    const bal = cfg.get('balance') as { reconnectGraceSec: number };
    const grace = bal.reconnectGraceSec;
    bal.reconnectGraceSec = 0.05;
    try {
      for (let k = 0; k < 5; k++) {
        const id = `R11S${k}`;
        seed(id);
        const ws = await joinFresh(id);
        const room = mgr().rooms.get(ws.last('joined')!.roomCode)!;
        room.movedAt = 0;
        ws.push({ t: 'descend' });
        await until('подземелье', () => room.area === 'dungeon');
        ws.close();
        await until('грейс', () => mgr().graceByChar.get(id) === room);
        await until('грейс истёк, запись легла', () => !mgr().graceByChar.has(id) && !mgr().inflight.has(id) && !mgr().charOps.has(id), 20_000);
      }
      // Живой герой со своим номером: второй вход выселил первый (прощальная запись), сессия жива.
      seed('R11T');
      await joinFresh('R11T');
      const live = await joinFresh('R11T');
      await until('записи входа T', () => !mgr().inflight.has('R11T') && !mgr().charOps.has('R11T'));
      expect(mgr().farewellSeq.has('R11T')).toBe(true);
      const gone = (): string[] => [...mgr().farewellSeq.keys()].filter((k) => k.startsWith('R11S'));
      expect(gone().length, 'номера записей есть, пока свежие').toBeGreaterThan(0);
      await mgr().retryUnsaved(Date.now() + 11 * 60_000);   // фон менеджера — после срока подметания
      expect(gone(), 'номера ушедших героев подметены').toEqual([]);
      expect(mgr().live.has('R11T') && mgr().farewellSeq.has('R11T'), 'номер живого героя цел').toBe(true);
      live.close();
      await until('T вышел', () => !mgr().inflight.has('R11T') && !mgr().charOps.has('R11T'));
    } finally {
      bal.reconnectGraceSec = grace;
    }
  });
});
