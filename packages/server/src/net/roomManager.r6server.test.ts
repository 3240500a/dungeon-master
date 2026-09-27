import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState } from '@dm/shared';
import { counters } from './metrics.js';
import { limits, known } from './rateLimit.js';
import { sessionKey } from './authSession.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс): тест идёт 0,3–3 с и без нагрузки. Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот
// потолок не прячет — они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Раунд 6 (сервер), граница менеджера комнат: кадр ввода не разбирается до входа и не бывает большим (R6-05); копия
 * героя, закреплённого за чужой нодой, не пишет штраф в его строку (R6-06); поток кадров лобби без входа не запирает
 * соседей по адресу, а промахи кода одного аккаунта — вход по коду другим (R6-09); ушедший спокойно не держит место в пати
 * после ухода с этажа (R6-14).
 *
 * База — маленькая честная (версии сейва, как Postgres), у каждого героя СВОЙ аккаунт и свой токен сессии (`tok`).
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  /** Токен → аккаунт. Нет в карте — сессии нет. */
  sessions: new Map<string, string>(),
  /** Сколько раз спрашивали сессию по токену. */
  sessionReads: 0,
  /** Чья следующая запись сейва упадёт (база упала) — один раз. */
  failFor: null as string | null,
  log: [] as { charId: string; v: number; ok: boolean }[],
}));
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  getSession: async (token: string) => { db.sessionReads++; return db.sessions.get(token) ?? null; },
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    return r ? { userId: r.userId, data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number) => {
    const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
    if (db.failFor === charId) { db.failFor = null; throw new Error('база упала'); }
    const r = db.chars.get(charId);
    if (!r || v !== r.version) { db.log.push({ charId, v, ok: false }); return null; }
    r.version = v + 1; r.data = snap;
    db.log.push({ charId, v, ok: true });
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
/** Реестр кластера: чья нода держит героя (`owner`, null — эта). */
const reg = vi.hoisted(() => ({ owner: null as string | null }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(reg.owner ?? node),
  claimOwner: () => Promise.resolve(reg.owner ?? (process.env.DM_NODE_ID ?? 'node-0')),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

let RM: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
/** Токен сессии аккаунта — настоящего вида (64 hex). */
const tok = (userId: string): string => createHash('sha256').update(userId).digest('hex');

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
  push(frame: unknown): void { this.onMsg(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
  codes(): string[] { return this.frames.filter((f) => f.t === 'error').map((f) => (f as { code: string }).code); }
}
const settle = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

type Pt = { x: number; y: number };
type RoomIn = {
  code: string; area: string; movedAt: number;
  stop(): void; expireGrace(): void; setInput(pid: string, input: unknown): void;
  session: { world: { spawn: Pt; players: Record<string, { save: SaveState; pos: Pt }> } };
};
type Inner = {
  rooms: Map<string, RoomIn>;
  graceByChar: Map<string, RoomIn>;
  unsaved: Map<string, unknown>;
  retryUnsaved(now?: number): Promise<void>;
  frozen: boolean;
};
let rm: InstanceType<typeof RM>;
const inner = (): Inner => rm as unknown as Inner;
const roomOf = (charId: string): RoomIn => {
  for (const r of inner().rooms.values()) for (const p of Object.values(r.session.world.players)) if (p.save.charId === charId) return r;
  throw new Error(`${charId} ни в одной комнате`);
};
const pidOf = (room: RoomIn, charId: string): string =>
  Object.entries(room.session.world.players).find(([, p]) => p.save.charId === charId)![0];
const saved = (charId: string): SaveState => db.chars.get(charId)!.data as SaveState;

let seq = 0;
/** Новый герой своего аккаунта в «базе»; сессия аккаунта заведена. */
function seedChar(prefix: string, patch?: (s: SaveState) => void): { charId: string; userId: string; token: string } {
  const charId = `${prefix}-${++seq}`;
  const userId = `user-${charId}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix.slice(0, 12), charId) as SaveState;
  patch?.(save);
  db.chars.set(charId, { userId, data: save, version: 1 });
  db.sessions.set(tok(userId), userId);
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
  limits.roomCodeMiss.reset(`user:${userId}`);
  return { charId, userId, token: tok(userId) };
}
function connFrom(ip: string): FakeConn { const ws = new FakeConn(ip); rm.handleConnection(ws); return ws; }
/** Соединение, уже вошедшее героем. */
async function joined(h: { charId: string; token: string }, extra: Record<string, unknown> = { fresh: true }, ip = '127.0.0.1'): Promise<FakeConn> {
  const ws = connFrom(ip);
  ws.push({ t: 'join', token: h.token, charId: h.charId, ...extra });
  await settle(10);
  expect(ws.last('joined'), `${h.charId} вошёл: ${JSON.stringify(ws.last('error'))}`).toBeDefined();
  return ws;
}
/** Кадры ввода — с ходом монотонных часов (мягкий лимит ввода — бакет, R4-19). */
let pacedAt = 0;
function paced(fn: () => void): void {
  let t = Math.max(pacedAt, performance.now());
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => (t += 34));
  try { fn(); } finally { spy.mockRestore(); pacedAt = t; }
}
const lim = limits as unknown as Record<string, { reset(k: string): void; take(k: string): boolean } | undefined>;
/** Лимиты адреса — заново (адреса тестов свои, но бакеты общие на процесс). */
function freshIp(...ips: string[]): void {
  for (const ip of ips) for (const name of ['lobbyIp', 'roomCodeMiss', 'roomCodeMissIp']) lim[name]?.reset(`ip:${ip}`);
}

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  // ⚠ БЕЗ ФОНОВОЙ ДОПИСИ ПО ТАЙМЕРУ (R3-19): менеджер раз в 5 с НАСТОЯЩЕГО времени сам дописывает копии из `unsaved`, а
  // тесты R6-06 держат копию «на дописать» между шагами и дописывают её сами (`retryUnsaved`, статус забега, слив). Под
  // нагрузкой полного прогона фон попадал в окно теста: штраф ложился раньше, чем тест подменял строку героя, — «штраф ждёт
  // дописи: false». Интервал заводится на поддельных часах и с ними же пропадает; сам фон проверяет `roomManager.test.ts`.
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
beforeEach(() => { freshIp('127.0.0.1'); });
afterEach(() => { db.failFor = null; reg.owner = null; vi.restoreAllMocks(); });
afterAll(() => { for (const r of inner().rooms.values()) r.stop(); });

describe('⭐ R6-05: кадр ввода — не разбирается до входа и не бывает большим', () => {
  /** «Ввод» на 64 КБ сплошной вложенности: разбор такого стоил ~3 мс главного потока. */
  const NESTED_INPUT = '{"t":"input","pad":' + '['.repeat(32_000) + ']'.repeat(32_000) + '}';
  const bigParses = (spy: { mock: { calls: unknown[][] } }): number =>
    spy.mock.calls.filter(([s]) => typeof s === 'string' && s.length > 1024).length;

  it('соединение без входа: 300 «кадров ввода» по 64 КБ — ни одного разбора JSON, главный поток свободен', () => {
    const ws = connFrom('198.51.100.5');
    const parse = vi.spyOn(JSON, 'parse');
    // Время процессора, а не часов: под нагрузкой полного прогона процесс вытесняют, и настенные 50 мс «съедало» ожидание
    // своей очереди на ядро. Разбор такого кадра — ~3 мс процессора, 300 разборов — около секунды; без разбора — единицы мс.
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 300; i++) ws.push(NESTED_INPUT);
    const cpu = process.cpuUsage(cpu0);
    expect(bigParses(parse), 'разборов').toBe(0);
    expect((cpu.user + cpu.system) / 1000, 'процессорное время на 300 кадров, мс').toBeLessThan(250);
    ws.close();
  });

  it('вошедший прислал «ввод» больше потолка ввода — соединение закрыто (4008) без разбора', async () => {
    const h = seedChar('r605big');
    const ws = await joined(h);
    const parse = vi.spyOn(JSON, 'parse');
    ws.push('{"t":"input","seq":1,"input":{"move":{"x":0,"y":0},"facing":0,"attack":false,"cast":null,"interact":false},"pad":"' + 'a'.repeat(4000) + '"}');
    expect(bigParses(parse)).toBe(0);
    expect(ws.closedWith).toBe(4008);
    await settle(10);
  });

  it('кадр любого типа со вложенностью глубже разумной — не разбирается, считается кривым', () => {
    const ws = connFrom('198.51.100.6');
    const bad0 = counters.framesInvalid;
    const parse = vi.spyOn(JSON, 'parse');
    ws.push('{"t":"ping","id":' + '['.repeat(6000) + ']'.repeat(6000) + '}');
    expect(bigParses(parse)).toBe(0);
    expect(counters.framesInvalid - bad0).toBe(1);
    expect(ws.open, 'пинг-мусор соединение не рвёт').toBe(true);
    ws.close();
  });

  it('честный ввод веб-клиента, Unity (Newtonsoft) и стенда dmload доходит до комнаты', async () => {
    const h = seedChar('r605ok');
    const ws = await joined(h);
    const room = roomOf(h.charId);
    const got: unknown[] = [];
    const orig = room.setInput.bind(room);
    room.setInput = (pid, input) => { got.push(input); orig(pid, input); };
    const web = JSON.stringify({ t: 'input', seq: 5, input: { move: { x: 0.7071, y: -0.7071 }, facing: 1.2, attack: true, cast: 'b-aura-a1', interact: false, dodge: false } });
    const unity = '{"t":"input","seq":12,"input":{"move":{"x":0.70710677,"y":-0.70710677},"facing":-0.785398,"attack":false,"cast":null,"interact":false,"dodge":true}}';
    const dmload = JSON.stringify({ t: 'input', seq: 0, input: { move: { x: Math.cos(1), y: Math.sin(1) }, facing: 1, attack: true, cast: null, interact: false } });
    try { paced(() => { for (const raw of [web, unity, dmload]) ws.push(raw); }); }
    finally { delete (room as { setInput?: unknown }).setInput; }
    expect(got, 'все три дошли').toHaveLength(3);
    expect(ws.open).toBe(true);
    ws.close();
    await settle(10);
  });

  it('потолок кадра транспорта — не больше 16 КБ, а самый большой честный кадр (спуск с 32 модификаторами) влезает вдвое', async () => {
    const { MAX_FRAME_BYTES } = await import('./conn.js');
    expect(MAX_FRAME_BYTES).toBeLessThanOrEqual(16 * 1024);
    const id = (i: number): string => `мод-${i}-`.padEnd(64, 'ы');   // кириллица — два байта на знак
    const descend = { t: 'descend', difficultyId: 'н'.repeat(32), targetNodeId: 'n'.repeat(64), runConfig: { biomeId: id(99), templateId: id(98), modifiers: Array.from({ length: 32 }, (_, i) => id(i)) } };
    const raw = JSON.stringify(descend);
    expect(Buffer.byteLength(raw) * 2).toBeLessThan(MAX_FRAME_BYTES);
    const ws = connFrom('198.51.100.7');
    const bad0 = counters.framesInvalid;
    ws.push(raw);
    expect(counters.framesInvalid - bad0, 'честный кадр не отброшен ни вложенностью, ни схемой').toBe(0);
    ws.close();
  });
});

describe('⭐ R6-06: копия героя, закреплённого за другой нодой, не пишет штраф в его строку', () => {
  /**
   * Герой в грейсе здесь; истёк грейс — запись штрафа упала (база лежит) и ждёт дописи. Пока база лежала, героя взяла
   * нода B (закрепление протухло): он продолжает ТОТ ЖЕ забег там, его строка ушла вперёд, золото на месте.
   */
  async function lostToOtherNode(prefix: string): Promise<string> {
    const h = seedChar(prefix, (s) => { s.gold = 5000; });
    const ws = await joined(h);
    ws.push({ t: 'descend' });
    await settle(10);
    expect(roomOf(h.charId).area).toBe('dungeon');
    ws.close();
    await settle(10);
    expect(inner().graceByChar.has(h.charId), 'в грейсе').toBe(true);
    db.failFor = h.charId;
    inner().graceByChar.get(h.charId)!.expireGrace();
    await settle(10);
    expect(inner().unsaved.has(h.charId), 'штраф ждёт дописи').toBe(true);
    const row = db.chars.get(h.charId)!;
    (row.data as SaveState).gold = 5000;
    row.version += 3;
    reg.owner = 'node-9';
    return h.charId;
  }

  for (const via of ['fenceLost', 'retryUnsaved', 'runStatus', 'flushAll'] as const) {
    it(`через ${via}: строка героя на node-9 не тронута, копия здесь забыта`, async () => {
      const g = await lostToOtherNode(`r606-${via}`);
      const run0 = JSON.stringify(saved(g).run);
      expect(saved(g).run, 'забег идёт на node-9').toBeTruthy();
      const log0 = db.log.length;
      try {
        if (via === 'fenceLost') {
          const { clusterHooks } = await import('./roomManager.js');
          clusterHooks.fenceLost([g]);
        } else if (via === 'retryUnsaved') {
          await inner().retryUnsaved();
        } else if (via === 'runStatus') {
          const h = { charId: g, token: tok(`user-${g}`) };
          const ws = connFrom('127.0.0.1');
          ws.push({ t: 'runStatus', token: h.token, charId: g });
        } else {
          await rm.flushAll();
        }
        await settle(20);
      } finally { inner().frozen = false; }
      expect(saved(g).gold, 'штрафа нет').toBe(5000);
      expect(JSON.stringify(saved(g).run), 'забег цел').toBe(run0);
      expect(db.log.slice(log0).filter((e) => e.charId === g), 'ни одной записи в строку чужого героя').toEqual([]);
      expect(inner().unsaved.has(g), 'копия забыта').toBe(false);
    });
  }

  it('закрепление наше, но в строке уже ДРУГОЙ забег — штраф старого забега его не трогает (снимается только тот же забег)', async () => {
    const h = seedChar('r606-run', (s) => { s.gold = 5000; });
    const ws = await joined(h);
    ws.push({ t: 'descend' });
    await settle(10);
    ws.close();
    await settle(10);
    db.failFor = h.charId;
    inner().graceByChar.get(h.charId)!.expireGrace();
    await settle(10);
    expect(inner().unsaved.has(h.charId)).toBe(true);
    const row = db.chars.get(h.charId)!;
    const s = row.data as SaveState;
    s.gold = 5000;
    s.run = { ...s.run!, config: { ...s.run!.config, seed: (s.run!.config.seed + 1) >>> 0 } };   // новый забег
    row.version += 2;
    const run0 = JSON.stringify(s.run);
    await inner().retryUnsaved();
    await settle(10);
    expect(saved(h.charId).gold, 'за чужой забег не штрафуют').toBe(5000);
    expect(JSON.stringify(saved(h.charId).run), 'новый забег цел').toBe(run0);
    expect(inner().unsaved.has(h.charId), 'дописывать нечего').toBe(false);
  });
});

describe('⭐ R6-09: поток кадров лобби без входа не запирает соседей по адресу', () => {
  const badTok = (i: number): string => (0x5000_0000 + i).toString(16).padStart(64, '0');

  it('4 сокета льют статус забега с чужими токенами — сосед по адресу со своей сессией получает ответ; льющие закрыты', async () => {
    const ip = '100.64.0.1';
    freshIp(ip);
    const h = seedChar('r609');
    const atk = [0, 1, 2, 3].map(() => connFrom(ip));
    const s0 = db.sessionReads;
    for (let i = 0; i < 40; i++) for (const w of atk) w.push({ t: 'runStatus', token: badTok(i), charId: 'x' });
    await settle(30);
    expect(db.sessionReads - s0, 'в базу — лишь несколько неудач с каждого сокета').toBeLessThanOrEqual(4 * 5);
    for (const w of atk) expect(w.closedWith, 'поток чужих токенов стоит сокета').toBe(4008);
    const v = connFrom(ip);
    v.push({ t: 'runStatus', token: h.token, charId: h.charId });
    await settle(10);
    expect(v.codes(), 'соседа по адресу не запирает').toEqual([]);
    expect(v.last('runStatus')).toBeDefined();
    v.close();
  });

  // ⭐ R12-05: первая попытка чужого токена на СВЕЖЕМ сокете больше не идёт в базу мимо бакета (раньше — «auth», и так на каждом
  // новом сокете: поток «открыл — кадр — закрыл» стоил запроса сессии на сокет). Живая сессия, знакомая процессу (вход, регистрация,
  // старт процесса — R11-05, R12-05), бакета адреса не платит по-прежнему.
  it('бакет адреса исчерпан: знакомая сессия — ответ; чужой токен — «rate» сразу, без похода в базу', async () => {
    const ip = '100.64.0.9';
    freshIp(ip);
    vi.spyOn(performance, 'now').mockReturnValue(performance.now());   // часы бакетов стоят: пополнения за время теста нет
    for (let i = 0; i < 300; i++) lim.lobbyIp!.take(`ip:${ip}`);
    const h = seedChar('r609b');
    known.sessions.add(sessionKey(h.token), h.userId);
    const v = connFrom(ip);
    v.push({ t: 'runStatus', token: h.token, charId: h.charId });
    await settle(10);
    expect(v.codes(), 'живая сессия не платит бакет адреса').toEqual([]);
    expect(v.last('runStatus')).toBeDefined();
    const bad = connFrom(ip);
    const s0 = db.sessionReads;
    bad.push({ t: 'runStatus', token: badTok(900), charId: 'x' });
    await settle(10);
    bad.push({ t: 'runStatus', token: badTok(901), charId: 'x' });
    await settle(10);
    expect(bad.codes()).toEqual(['rate', 'rate']);
    expect(db.sessionReads - s0, 'в базу — ни одного').toBe(0);
    v.close(); bad.close();
  });

  it('промахи кода одного аккаунта не запирают вход по коду другому аккаунту с того же адреса', async () => {
    const ip = '100.64.0.2';
    freshIp(ip, '198.51.100.20');
    const friend = seedChar('r609f'), attacker = seedChar('r609a'), victim = seedChar('r609v');
    const wf = await joined(friend, { fresh: true }, '198.51.100.20');
    const code = roomOf(friend.charId).code;
    // Часы бакетов стоят: «пять промахов — и хватит» не зависит от того, успел ли бакет пополниться под нагрузкой (1 за 2 с).
    vi.spyOn(performance, 'now').mockReturnValue(performance.now());
    const atk = connFrom(ip);
    for (let i = 0; i < 6; i++) atk.push({ t: 'join', token: attacker.token, charId: attacker.charId, roomCode: `AZ${i}ZZZZZ` });
    await settle(20);
    expect(atk.codes(), 'пять промахов — и хватит этому аккаунту').toEqual(['no-room', 'no-room', 'no-room', 'no-room', 'no-room', 'rate']);
    const wv = await joined(victim, { roomCode: code }, ip);
    expect(roomOf(victim.charId)).toBe(roomOf(friend.charId));
    wf.close(); wv.close(); atk.close();
    await settle(10);
  });
});

describe('⭐ R6-14: ушедший спокойно не держит место в пати после ухода с этажа', () => {
  it('четверо по коду, четвёртый отвалился у портала, пати ушла в город — пятый по коду входит; четвёртый возвращается «Продолжить»', async () => {
    const hs = [1, 2, 3, 4, 5].map((i) => seedChar(`r614-${i}`));
    const ws1 = await joined(hs[0]!);
    const room = roomOf(hs[0]!.charId);
    const party = [ws1];
    for (const h of hs.slice(1, 4)) party.push(await joined(h, { roomCode: room.code }));
    ws1.push({ t: 'descend' });
    for (const w of party.slice(1)) w.push({ t: 'vote', accept: true });
    await settle(10);
    expect(room.area).toBe('dungeon');
    const w = room.session.world;
    for (const h of hs.slice(0, 4)) w.players[pidOf(room, h.charId)]!.pos = { ...w.spawn };   // все у портала: уход спокойный
    party[3]!.close();
    await settle(10);
    expect(inner().graceByChar.get(hs[3]!.charId), 'четвёртый ждёт реконнекта').toBe(room);
    room.movedAt = 0;
    ws1.push({ t: 'return' });
    party[1]!.push({ t: 'vote', accept: true });
    party[2]!.push({ t: 'vote', accept: true });
    await settle(10);
    expect(room.area).toBe('town');
    const ws5 = connFrom('127.0.0.1');
    ws5.push({ t: 'join', token: hs[4]!.token, charId: hs[4]!.charId, roomCode: room.code });
    await settle(10);
    expect(ws5.codes(), 'место свободно').toEqual([]);
    expect(ws5.last('joined')).toBeDefined();
    const back = connFrom('127.0.0.1');
    back.push({ t: 'join', token: hs[3]!.token, charId: hs[3]!.charId, resume: true });
    await settle(10);
    expect(back.last('joined'), JSON.stringify(back.last('error'))).toBeDefined();
    expect(roomOf(hs[3]!.charId)).toBe(room);
    for (const c of [...party.slice(0, 3), ws5, back]) c.close();
    await settle(10);
  });
});
