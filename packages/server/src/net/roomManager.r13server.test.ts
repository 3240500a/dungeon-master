import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';
import { counters } from './metrics.js';
import { setRoutePassKey, routePass } from './authSession.js';

// Слив ждёт свои круги и паузы (секунды бюджета); исходы решает мок базы (висит, падает), а не скорость машины.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 13 (сервер), граница менеджера комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии сейва), умеет
 * «висеть» (запись героя не отвечает, пока тест не отпустит) и «падать» (отказ соединения N раз подряд).
 *  • R13-06: одна зависшая запись слива больше не съедает весь бюджет: герой, чья запись упала сразу, дописывается следующим кругом;
 *  • R13-08: сессия, которую гейтвей уже проверил (пропуск маршрута в адресе сокета), на лобби ноды не платит бакет сети адреса.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  sessions: new Map<string, string>(),
  /** Этот герой: следующая запись висит, пока не отпустят. */
  hang: new Map<string, Promise<void>>(),
  /** Этот герой: столько следующих записей падают отказом соединения. */
  fail: new Map<string, number>(),
  /** Попытки записи по героям. */
  puts: new Map<string, number>(),
}));
vi.mock('../db/db.js', () => {
  const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  return {
    getRunLedger: async () => [],
    mergeRunLedger: async () => {},
    getSession: async (token: string) => db.sessions.get(token) ?? null,
    getCharacter: async (charId: string) => {
      const r = db.chars.get(charId);
      return r ? { userId: 'user-r13rm', data: structuredClone(r.data), version: r.version } : null;
    },
    putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
      const snap = structuredClone(data);
      db.puts.set(charId, (db.puts.get(charId) ?? 0) + 1);
      const gate = db.hang.get(charId);
      if (gate) { db.hang.delete(charId); await gate; }
      const n = db.fail.get(charId) ?? 0;
      if (n > 0) { db.fail.set(charId, n - 1); throw refused(); }
      const r = db.chars.get(charId);
      if (!r || v !== r.version) return null;
      r.version = v + 1; r.data = snap;
      return r.version;
    },
    putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
    getAccountStash: async () => null,
    putAccountStash: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: async (_c: string, node: string) => node,
  claimOwner: async () => process.env.DM_NODE_ID ?? 'node-0',
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

const TOK = 'f3'.repeat(32);
class FakeConn implements GameConn {
  open = true;
  frames: ServerFrame[] = [];
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  constructor(readonly ip = '127.0.0.1', readonly routePass?: string) {}
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { if (!this.open) return; this.open = false; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type RoomIn = { code: string; stop(): void; session: { world: { players: Record<string, { save: SaveState }> } } };
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>;
  handleConnection(ws: GameConn): void;
  flushAll(budgetMs?: number): Promise<unknown>;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  db.sessions.set(TOK, 'user-r13rm');
});
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19)
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
afterEach(() => {
  db.hang.clear(); db.fail.clear();
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});
for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync]) l.reset('user-r13rm');
let seq = 0;
function seed(id: string): void {
  db.chars.set(id, { data: newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState, version: 1 });
}
async function joinFresh(rm: RMIn, charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++seq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  expect(ws.last('error'), JSON.stringify(ws.last('error'))).toBeUndefined();
  return ws;
}
const row = (id: string): SaveState => db.chars.get(id)!.data as SaveState;

describe('⭐ R13-06: зависшая запись слива не съедает бюджет — упавшая сразу дописывается следующим кругом', () => {
  it('H висит, F упала дважды (база тут же вернулась) — прогресс F в базе; ИНЦИДЕНТ и счётчик — только H', async () => {
    const rm = manager();
    const H = 'R13D-hung', F = 'R13D-fast';
    seed(H); seed(F);
    const wsH = await joinFresh(rm, H);
    const wsF = await joinFresh(rm, F, wsH.last('joined')!.roomCode);
    await until('записи входа легли', () => !rm.inflight.size);
    const room = rm.rooms.get(wsH.last('joined')!.roomCode)!;
    room.session.world.players[wsF.last('joined')!.playerId]!.save.gold = 31_337;
    let release!: () => void;
    db.hang.set(H, new Promise<void>((r) => { release = r; }));
    db.fail.set(F, 2);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const forgot0 = counters.farewellForgotten;
    try {
      await rm.flushAll(3_000);
    } finally { release(); }
    expect(row(F).gold, `попыток записи F: ${db.puts.get(F)}`).toBe(31_337);
    const incidents = errors.filter((l) => l.includes('ИНЦИДЕНТ'));
    expect(incidents.some((l) => l.includes(H)), incidents.join('\n')).toBe(true);
    expect(incidents.some((l) => l.includes(F)), `F записан, а назван: ${incidents.join('\n')}`).toBe(false);
    expect(counters.farewellForgotten - forgot0, 'забыт только H').toBe(1);
  });
});

describe('⭐ R13-08: пропуск маршрута гейтвея — сессия, выданная после старта ноды, не заперта троллем за общим адресом', () => {
  const junk = (): string => randomBytes(32).toString('hex');
  /** Бакет адреса пуст (часы стоят — не пополнится). */
  const drain = (ip: string): void => {
    for (let i = 0; i < 5_000 && limits.lobbyIp.peek(`ip:${ip}`); i++) limits.lobbyIp.take(`ip:${ip}`);
    expect(limits.lobbyIp.peek(`ip:${ip}`)).toBe(false);
  };
  const reply = (ws: FakeConn): ServerFrame | undefined => ws.frames.find((f) => f.t === 'runStatus' || f.t === 'error' || f.t === 'joined');
  beforeAll(() => { setRoutePassKey('5a'.repeat(32)); });

  /** Живая в базе сессия, которую нода не видела (выдана после её старта), и сокет с адреса, чей бакет опустошил тролль. */
  async function frame(ip: string, token: string, pass: string | undefined, f: object, rm = manager()): Promise<ServerFrame | undefined> {
    const ws = new FakeConn(ip, pass);
    rm.handleConnection(ws);
    ws.push({ ...f, token });
    await until('ответ', () => !!reply(ws));
    return reply(ws);
  }

  it('с пропуском маршрута: статус забега и вход проходят при пустом бакете адреса', async () => {
    const ip = '100.64.13.8';
    const good = junk();
    db.sessions.set(good, 'user-r13rm');
    seed('R13L-routed');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      drain(ip);
      const pass = routePass(good)!;
      expect((await frame(ip, good, pass, { t: 'runStatus', charId: 'R13L-routed' }))?.t).toBe('runStatus');
      limits.lobby.reset('user-r13rm');
      const joined = await frame(ip, good, pass, { t: 'join', charId: 'R13L-routed', fresh: true });
      expect(joined?.t, JSON.stringify(joined)).toBe('joined');
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });

  it('контроль: без пропуска, с чужим, поддельным или просроченным — «rate» до базы, как R12-05', async () => {
    const ip = '100.64.13.9';
    const good = junk(), other = junk();
    db.sessions.set(good, 'user-r13rm');
    seed('R13L-denied');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      drain(ip);
      const real = routePass(good)!;
      const [exp] = real.split('.');
      const passes = [
        undefined,
        routePass(other),                                    // чужому токену
        `${exp}.${'A'.repeat(43)}`,                          // подпись не та
        routePass(good, Date.now() - 11 * 60_000),           // срок вышел
      ];
      for (const pass of passes) {
        const r = await frame(ip, good, pass, { t: 'runStatus', charId: 'R13L-denied' });
        expect((r as { code?: string } | undefined)?.code, `пропуск ${pass}`).toBe('rate');
      }
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });

  it('контроль: сессию отозвали после маршрута — «вход нужен», и дальше этот пропуск бакет адреса не обходит', async () => {
    const ip = '100.64.13.10';
    const gone = junk();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      const pass = routePass(gone)!;
      const rm = manager();   // одна нода — как в жизни (отказанный пропуск она помнит)
      const first = await frame(ip, gone, pass, { t: 'runStatus', charId: 'R13L-gone' }, rm);
      expect((first as { code?: string } | undefined)?.code).toBe('auth');
      drain(ip);
      const again = await frame(ip, gone, pass, { t: 'runStatus', charId: 'R13L-gone' }, rm);
      expect((again as { code?: string } | undefined)?.code).toBe('rate');
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });
});
