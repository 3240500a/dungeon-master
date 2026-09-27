import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { limits, known } from './rateLimit.js';
import { sessionKey } from './authSession.js';
import { counters } from './metrics.js';

// Менеджер ждётся оборотами цикла, слив — своими паузами между кругами; под нагрузкой полного прогона умолчание 5 с — лотерея.
// Исходы решает мок базы (лежит или нет), а не время: база «поднимается» флагом, а тест ждёт итог слива, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 12 (сервер), граница менеджера комнат. Менеджер и комнаты — настоящие; база — маленькая честная (версии сейва), умеет
 * «лежать» (ECONNREFUSED на каждом запросе) и ронять фиксацию с неизвестным исходом.
 *  • R12-04: слив ноды при моргнувшей базе больше не сдаётся за миллисекунды: дописывает кругами до её возвращения (в пределах
 *    предохранителя), а что так и не легло — ИНЦИДЕНТ в лог и `dm_farewell_forgotten_total`;
 *  • R12-05: кадр лобби с НЕЗНАКОМЫМ токеном платит бакет сети адреса ДО базы — и на свежем сокете: поток «открыл — кадр — закрыл»
 *    с мусорными токенами больше не стоит запроса сессии в общую базу на каждый сокет;
 *  • R12-06: соединение, раз предъявившее мёртвый токен, после входа с живым не заперто бакетом адреса (тролль за общим NAT).
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  sessions: new Map<string, string>(),
  /** База лежит: каждый запрос — отказ соединения. */
  down: false,
  /** Эти герои: следующая запись падает на фиксации с неизвестным исходом и НЕ ложится (один раз). */
  unknownOnce: new Set<string>(),
  sessionLookups: 0,
}));
vi.mock('../db/db.js', () => {
  const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  return {
    getRunLedger: async () => { if (db.down) throw refused(); return []; },
    mergeRunLedger: async () => { if (db.down) throw refused(); },
    getSession: async (token: string) => { db.sessionLookups++; if (db.down) throw refused(); return db.sessions.get(token) ?? null; },
    getCharacter: async (charId: string) => {
      if (db.down) throw refused();
      const r = db.chars.get(charId);
      return r ? { userId: 'user-r12rm', data: structuredClone(r.data), version: r.version } : null;
    },
    putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
      const snap = structuredClone(data);
      await new Promise((res) => setTimeout(res, 1));   // круг базы
      if (db.down) throw refused();
      if (db.unknownOnce.delete(charId)) {
        const { CommitUnknown } = await import('../db/errors.js');
        throw new CommitUnknown(new Error('Connection terminated unexpectedly'), false);
      }
      const r = db.chars.get(charId);
      if (!r || v !== r.version) return null;
      r.version = v + 1; r.data = snap;
      return r.version;
    },
    putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
    getAccountStash: async () => { if (db.down) throw refused(); return null; },
    putAccountStash: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: async (_c: string, node: string) => node,
  // Закрепление читается из той же базы: лежит она — не выяснить и его.
  claimOwner: async () => {
    if (db.down) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    return process.env.DM_NODE_ID ?? 'node-0';
  },
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

const TOK = 'e1'.repeat(32);
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
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}

type RoomIn = {
  code: string; stop(): void;
  session: { world: { players: Record<string, { save: SaveState }> } };
};
type RMIn = {
  rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; unsaved: Map<string, unknown>; charOps: Map<string, unknown>;
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
});
/** Свой менеджер на тест: слив замораживает его навсегда (как процесс, который уходит). */
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });   // без фоновой дописи копий по таймеру (R3-19)
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
afterEach(() => {
  db.down = false;
  db.unknownOnce.clear();
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.restoreAllMocks();
});

let seq = 0;
function seed(id: string): void {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  db.chars.set(id, { data: s, version: 1 });
}
for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync]) l.reset('user-r12rm');
async function joinFresh(rm: RMIn, charId: string, roomCode?: string): Promise<FakeConn> {
  const ws = new FakeConn(`198.51.100.${++seq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...(roomCode ? { roomCode } : { fresh: true }) });
  await until(`${charId} вошёл`, () => !!ws.last('joined') || !!ws.last('error'));
  expect(ws.last('error'), JSON.stringify(ws.last('error'))).toBeUndefined();
  return ws;
}
const row = (id: string): SaveState => db.chars.get(id)!.data as SaveState;

describe('⭐ R12-04: слив ноды при моргнувшей базе дописывает, а не сдаётся', () => {
  beforeAll(() => { db.sessions.set(TOK, 'user-r12rm'); });

  /** Два героя одной комнаты; база легла; первый ушёл (его копия не легла), у второго — прогресс после последней записи. */
  async function scene(tag: string): Promise<{ rm: RMIn; gone: string; stay: string; goneV: number }> {
    const rm = manager();
    const gone = `R12D-${tag}-gone`, stay = `R12D-${tag}-stay`;
    seed(gone); seed(stay);
    const wsG = await joinFresh(rm, gone);
    const wsS = await joinFresh(rm, stay, wsG.last('joined')!.roomCode);
    await until('записи входа легли', () => !rm.inflight.size);
    const room = rm.rooms.get(wsG.last('joined')!.roomCode)!;
    room.session.world.players[wsS.last('joined')!.playerId]!.save.gold = 777;
    const goneV = db.chars.get(gone)!.version;
    db.down = true;
    wsG.close();
    await until('копия ушедшего не легла', () => rm.unsaved.has(gone) && !rm.inflight.has(gone));
    return { rm, gone, stay, goneV };
  }

  it('база лежит первые ~0,6 с слива — слив дожидается её: копия ушедшего и прогресс оставшегося — в базе', async () => {
    const { rm, gone, stay, goneV } = await scene('up');
    const t0 = Date.now();
    setTimeout(() => { db.down = false; }, 600);
    await rm.flushAll(20_000);
    expect(Date.now() - t0, 'слив не вышел, пока база лежала').toBeGreaterThanOrEqual(500);
    expect(rm.unsaved.size, 'недописанных копий нет').toBe(0);
    expect(db.chars.get(gone)!.version, 'копия ушедшего записана').toBeGreaterThan(goneV);
    expect(row(stay).gold, 'прогресс оставшегося записан').toBe(777);
  });

  it('база лежит дольше бюджета — каждая потерянная копия: ИНЦИДЕНТ в лог и +1 к dm_farewell_forgotten_total', async () => {
    const { rm, gone, stay } = await scene('down');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const forgot0 = counters.farewellForgotten;
    await rm.flushAll(400);
    expect(counters.farewellForgotten - forgot0, 'ушедший и оставшийся').toBe(2);
    const incidents = errors.filter((l) => l.includes('ИНЦИДЕНТ'));
    expect(incidents.some((l) => l.includes(gone)), incidents.join('\n')).toBe(true);
    expect(incidents.some((l) => l.includes(stay)), incidents.join('\n')).toBe(true);
  });

  it('запись самого слива кончилась «исход неизвестен» — копия дописывается следующим кругом, а не теряется', async () => {
    const rm = manager();
    const id = 'R12D-unknown';
    seed(id);
    const ws = await joinFresh(rm, id);
    await until('запись входа легла', () => !rm.inflight.size);
    const room = rm.rooms.get(ws.last('joined')!.roomCode)!;
    room.session.world.players[ws.last('joined')!.playerId]!.save.gold = 4242;
    db.unknownOnce.add(id);
    await rm.flushAll(20_000);
    await until('закрытие снятой сессии дошло до менеджера', () => !rm.charOps.has(id) && !rm.inflight.has(id));
    expect(rm.unsaved.has(id), 'копия не осталась «на дописать»').toBe(false);
    expect(row(id).gold, 'последнее состояние в базе').toBe(4242);
  });
});

describe('⭐ R12-05, R12-06: бакет сети адреса — незнакомым токенам до базы, знакомым — никогда', () => {
  const junk = (): string => randomBytes(32).toString('hex');
  /** Бакет адреса пуст (часы стоят — не пополнится). */
  const drain = (ip: string): void => {
    for (let i = 0; i < 5_000 && limits.lobbyIp.peek(`ip:${ip}`); i++) limits.lobbyIp.take(`ip:${ip}`);
    expect(limits.lobbyIp.peek(`ip:${ip}`)).toBe(false);
  };
  const reply = (ws: FakeConn): ServerFrame | undefined => ws.frames.find((f) => f.t === 'runStatus' || f.t === 'error' || f.t === 'joined');

  it('R12-05: бакет адреса пуст — 200 свежих сокетов с мусорными токенами получают «часто», и ни один не идёт в базу', async () => {
    const rm = manager();
    const ip = '203.0.113.77';
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      drain(ip);
      const n0 = db.sessionLookups;
      const socks: FakeConn[] = [];
      for (let i = 0; i < 200; i++) {
        const ws = new FakeConn(ip);
        rm.handleConnection(ws);
        ws.push({ t: (['runStatus', 'join', 'abandon'] as const)[i % 3], token: junk(), charId: 'R12L-x', ...(i % 3 === 1 ? { fresh: true } : {}) });
        socks.push(ws);
      }
      await until('ответы', () => socks.every((w) => !!reply(w)));
      expect(db.sessionLookups - n0, 'запросов сессии в базу').toBe(0);
      expect(socks.every((w) => (reply(w) as { code?: string }).code === 'rate')).toBe(true);
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });

  it('R12-05, контроль: при том же пустом бакете знакомый токен с того же адреса проходит (R6-09, R11-05)', async () => {
    const rm = manager();
    const ip = '203.0.113.78';
    const good = junk();
    db.sessions.set(good, 'user-r12rm');
    known.sessions.add(sessionKey(good), 'user-r12rm');
    seed('R12L-known');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    try {
      drain(ip);
      const ws = new FakeConn(ip);
      rm.handleConnection(ws);
      ws.push({ t: 'runStatus', token: good, charId: 'R12L-known' });
      await until('ответ', () => !!reply(ws));
      expect(reply(ws)?.t, JSON.stringify(reply(ws))).toBe('runStatus');
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });

  it('R12-05, контроль: платят только неудачи — 150 живых незнакомых токенов с одного адреса (часы стоят) проходят все', async () => {
    const rm = manager();
    const ip = '203.0.113.79';
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    limits.lobbyIp.reset(`ip:${ip}`);
    seed('R12L-many');
    try {
      const socks: FakeConn[] = [];
      // Друг за другом, как приходят люди за общим NAT: бакет пополниться не может (часы стоят) — держится он только возвратом.
      for (let i = 0; i < 150; i++) {
        const t = junk();
        db.sessions.set(t, `user-r12rm-${i}`);
        const ws = new FakeConn(ip);
        rm.handleConnection(ws);
        ws.push({ t: 'runStatus', token: t, charId: 'R12L-many' });
        socks.push(ws);
        await until('ответ', () => !!reply(ws));
      }
      // Чужой аккаунт героя — «недоступен», но это уже после сессии: бакет адреса живые токены не расходуют.
      expect(socks.filter((w) => (reply(w) as { code?: string }).code === 'rate'), 'отказов «часто»').toEqual([]);
      expect(limits.lobbyIp.peek(`ip:${ip}`), 'бакет адреса цел').toBe(true);
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });

  it('R12-06: соединение получило «вход нужен», тролль за тем же адресом опустошил бакет — после входа статус и вход проходят', async () => {
    const rm = manager();
    const ip = '198.51.100.207';
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    seed('R12L-relogin');
    try {
      const ws = new FakeConn(ip);
      rm.handleConnection(ws);
      ws.push({ t: 'runStatus', token: junk(), charId: 'R12L-relogin' });   // сохранённый токен протух
      await until('«вход нужен»', () => !!ws.last('error'));
      expect(ws.last('error')?.code).toBe('auth');
      drain(ip);   // тролль за тем же NAT
      // Вошёл заново на этом же сокете (клиент переиспользует соединение): процесс видел сессию живой (вход — `noteSession`).
      const fresh = junk();
      db.sessions.set(fresh, 'user-r12rm');
      known.sessions.add(sessionKey(fresh), 'user-r12rm');
      limits.lobby.reset('user-r12rm');
      ws.frames.length = 0;
      ws.push({ t: 'runStatus', token: fresh, charId: 'R12L-relogin' });
      await until('статус', () => !!reply(ws));
      expect(reply(ws)?.t, JSON.stringify(reply(ws))).toBe('runStatus');
      ws.frames.length = 0;
      ws.push({ t: 'join', token: fresh, charId: 'R12L-relogin', fresh: true });
      await until('вход', () => !!reply(ws));
      expect(reply(ws)?.t, JSON.stringify(reply(ws))).toBe('joined');
      ws.close();
    } finally {
      clock.mockRestore();
      limits.lobbyIp.reset(`ip:${ip}`);
    }
  });
});
