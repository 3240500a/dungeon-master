import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type Item } from '@dm/shared';
import { counters } from './metrics.js';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс): тест идёт 0,3–3 с и без нагрузки. Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот
// потолок не прячет — они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Сетевая граница (D11) целиком: кадр приходит СТРОКОЙ, как из сокета, и проходит весь путь
 * менеджера — разбор, лимиты, очередь соединения, комнату. Проверяем, что мусор в кадре ввода
 * отсекается до симуляции, а команда доходит до схемы комнаты, какой бы формы ни был кадр.
 *
 * База замокана тем же способом, что в `room.run.test.ts`: маленькая ЧЕСТНАЯ база — версии сейва
 * (Ф0.3) и сундука (D8) проверяются, как в Postgres. Все персонажи — одного аккаунта (так и нужно
 * для гонок «герой и его сосед по аккаунту»). `gate` задерживает записи, НАЧАТЫЕ пока он стоит, —
 * так тест держит прощальную запись или запись штрафа «в полёте» и смотрит, кто её дождётся.
 */
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: unknown; version: number }>(),
  stash: { data: null as unknown, version: 0 },
  gate: null as Promise<void> | null,
  /** Сколько следующих записей сейва «база» отклонит ошибкой (упала, таймаут) — R2-08. */
  failNext: 0,
  /** Сколько раз сейв читали из «базы» — видно, прочитал ли вход копию до записи. */
  reads: 0,
  log: [] as { charId: string; v: number; ok: boolean; reason: string }[],
  /** Сколько раз спрашивали сессию по токену (R3-14: кривой токен до базы доходить не должен). */
  sessionReads: 0,
  /** Изобразить, что база не отвечает на поиск сессии (R3-14). */
  sessionFault: null as Error | null,
  /** R4-15: сколько следующих записей сейва «база» ПРИМЕНИТ, а ответ на фиксацию потеряет (`CommitUnknown`). */
  unknownNext: 0,
  /** Чья следующая запись сейва упадёт (база упала) — один раз; в отличие от `failNext`, чужая запись её не заберёт. */
  failFor: null as string | null,
  /** R4-10: чья следующая запись сейва упадёт взаимоблокировкой (40P01) — один раз, ничего не записав. */
  deadlockFor: null as string | null,
  /** R5-10: задержать ОТВЕТ на чтение персонажа (запрос исполнен сейчас — ответ позже); первые `readSkip` чтений не держим. */
  readGate: null as Promise<void> | null,
  readSkip: 0,
  /** R5-27: задержать ответ на поиск сессии. */
  sessionGate: null as Promise<void> | null,
  /** R5-25: токены правильного вида, которых в базе нет (сессия не найдена). */
  badTokens: new Set<string>(),
  /** R5-10: строку героя «двигают» сразу после чтения — столько следующих чтений (другой писатель обгоняет запись по строке). */
  moveOnRead: new Map<string, number>(),
}));
/**
 * Как Postgres (R3-02, R3-14): байт 0x00 в текстовом параметре — 22021, U+0000 в jsonb — 22P05, непарный суррогат
 * в jsonb — 22P02. Проверка — до всего остального: база не разберёт такой параметр вовсе.
 */
const pg = vi.hoisted(() => ({
  text(s: string): void {
    if (s.includes(String.fromCharCode(0))) throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
  },
  json(v: unknown): void {
    const json = JSON.stringify(v);
    if (/\\u0000/.test(json)) throw Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
    if (/\\ud[89a-f][0-9a-f]{2}/i.test(json)) throw Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' });
  },
}));
/**
 * Реестр кластера: порядок вызовов и чья нода держит персонажа (`owner`, null — эта). `dbAheadMs` — часы базы
 * впереди часов ноды (R2-17): снятие «не позже момента выхода по часам ноды» тогда не находит строку.
 */
const reg = vi.hoisted(() => ({ calls: [] as string[], owner: null as string | null, dbAheadMs: 0, draining: false, claimGate: null as Promise<void> | null }));
vi.mock('../db/db.js', async () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  getSession: async (token: string) => {
    db.sessionReads++;
    pg.text(token);
    if (db.sessionFault) throw db.sessionFault;
    if (db.sessionGate) await db.sessionGate;
    return db.badTokens.has(token) ? null : 'user-rm';
  },
  getCharacter: async (charId: string) => {
    db.reads++;
    pg.text(charId);
    const r = db.chars.get(charId);
    const out = r ? { userId: 'user-rm', data: structuredClone(r.data), version: r.version } : null;   // запрос исполнен сейчас
    const moves = db.moveOnRead.get(charId);
    if (r && moves) { db.moveOnRead.set(charId, moves - 1); r.version++; }                             // строку тут же обогнали
    if (db.readGate) { if (db.readSkip > 0) db.readSkip--; else await db.readGate; }                     // ответ — позже
    return out;
  },
  putCharacter: async (charId: string, _u: string, data: unknown, v: number, reason = 'autosave') => {
    const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
    pg.json(snap);
    if (db.gate) await db.gate;
    if (db.failNext > 0) { db.failNext--; throw new Error('база упала'); }
    if (db.failFor === charId) { db.failFor = null; throw new Error('база упала'); }
    if (db.deadlockFor === charId) { db.deadlockFor = null; throw Object.assign(new Error('обнаружена взаимоблокировка'), { code: '40P01' }); }
    const r = db.chars.get(charId);
    if (!r || v !== r.version) { db.log.push({ charId, v, ok: false, reason }); return null; }
    r.version = v + 1; r.data = snap;
    db.log.push({ charId, v, ok: true, reason });
    if (db.unknownNext > 0) {
      db.unknownNext--;
      const { CommitUnknown } = await import('../db/errors.js');
      throw new CommitUnknown(new Error('Query read timeout'));
    }
    return r.version;
  },
  putCharacterWithStash: async (charId: string, _u: string, data: unknown, v: number, stash: unknown, sv: number, reason = 'stash') => {
    const snap = structuredClone(data), st = structuredClone(stash);
    pg.json(snap); pg.json(st);
    if (db.gate) await db.gate;
    const r = db.chars.get(charId);
    if (!r || v !== r.version) return { ok: false, conflict: 'save' };
    if (sv !== db.stash.version) return { ok: false, conflict: 'stash' };
    r.version = v + 1; r.data = snap;
    db.stash = { data: st, version: sv + 1 };
    db.log.push({ charId, v, ok: true, reason });
    return { ok: true, version: r.version, stashVersion: db.stash.version };
  },
  getAccountStash: () => Promise.resolve(db.stash.version ? { data: structuredClone(db.stash.data), version: db.stash.version } : null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: (charId: string, _node: string, before?: Date) => {
    // Строку касались «сейчас» по часам базы; условие `touched_at <= before` по часам ноды тогда ложно.
    if (before && reg.dbAheadMs > 0 && Date.now() + reg.dbAheadMs > before.getTime()) return Promise.resolve();
    reg.calls.push(`release ${charId}`);
    return Promise.resolve();
  },
  claimForJoin: async (charId: string, node: string) => { reg.calls.push(`claim ${charId}`); if (reg.claimGate) await reg.claimGate; return reg.owner ?? node; },
  claimOwner: () => Promise.resolve(reg.owner ?? (process.env.DM_NODE_ID ?? 'node-0')),
}));
/** Слив ноды (R3-12): идёт ли он — решает тест. */
vi.mock('../cluster/node.js', () => ({ isDraining: () => reg.draining }));

let RM: typeof import('./roomManager.js').RoomManager;
let cfg: ConfigRegistry;
/** Токен сессии в настоящем формате — `randomBytes(32).toString('hex')` (R3-14: иной схема не пропустит). */
const TOK = 'ab'.repeat(32);

class FakeConn implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  closedWith?: number;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(code?: number): void { if (!this.open) return; this.open = false; this.closedWith = code; this.onEnd(); }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  /** Кадр от «клиента» — строкой, как из сокета. */
  push(frame: unknown): void { this.onMsg(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
  count(t: ServerFrame['t']): number { return this.frames.filter((f) => f.t === t).length; }
}
const settle = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
/**
 * R4-19: кадры ввода — с ходом монотонных часов, как их шлёт клиент (≈30 Гц). Мягкий лимит ввода — бакет с пополнением
 * 40 в секунду: пачка кадров без хода времени упирается во всплеск.
 */
let pacedAt = 0;
function paced(fn: () => void): void {
  // Часы теста идут только вперёд: бакет помнит последний момент, и возврат к настоящим часам не должен его «отмотать».
  let t = Math.max(pacedAt, performance.now());
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => (t += 34));
  try { fn(); } finally { spy.mockRestore(); pacedAt = t; }
}

/** Внутренности комнаты, до которых тесту приходится дотягиваться (это тест). */
type RoomIn = {
  code: string; area: string; size: number;
  step(emit: boolean): void; stop(): void; expireGrace(): void; movedAt: number;
  clients: Map<string, unknown>;
  session: { world: { players: Record<string, { save: SaveState; pos: { x: number; y: number }; hp: number; debuffs: Record<string, unknown> }>; drops: { id: number; kind: string; item?: Item; pos: { x: number; y: number } }[] } };
};
type Inner = {
  rooms: Map<string, RoomIn>;
  graceByChar: Map<string, RoomIn>;
  live: Map<string, GameConn>;
  leaveWaitMs: number;
};
let rm: InstanceType<typeof RM>;
const inner = (): Inner => rm as unknown as Inner;
/** Комната, в которой сидит этот персонаж (живой). */
const roomOf = (charId: string): RoomIn => {
  for (const r of inner().rooms.values()) for (const p of Object.values(r.session.world.players)) if (p.save.charId === charId) return r;
  throw new Error(`${charId} ни в одной комнате`);
};
const pidOf = (room: RoomIn, charId: string): string =>
  Object.entries(room.session.world.players).find(([, p]) => p.save.charId === charId)![0];
const uidsOf = (s: SaveState): string[] => [
  ...Object.values(s.equipment).filter(Boolean).map((i) => i!.uid),
  ...s.inventory.map((i) => i.uid),
  ...s.belt.filter(Boolean).map((i) => i!.uid),
];
const saved = (charId: string): SaveState => db.chars.get(charId)!.data as SaveState;
let seq = 0;
/** Новый персонаж аккаунта в «базе». */
function seedChar(prefix: string, patch?: (s: SaveState) => void): string {
  const charId = `${prefix}-${++seq}`;
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, prefix, charId) as SaveState;
  patch?.(save);
  db.chars.set(charId, { data: save, version: 1 });
  return charId;
}
/** Соединение, уже вошедшее персонажем. */
async function joined(charId: string, extra: Record<string, unknown> = { fresh: true }): Promise<FakeConn> {
  const ws = new FakeConn();
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, ...extra });
  await settle();
  expect(ws.last('joined'), `${charId} вошёл: ${JSON.stringify(ws.last('error'))}`).toBeDefined();
  return ws;
}
/**
 * R5-07: слив (`flushAll`) замораживает менеджер навсегда — процесс после него уходит. Менеджер в файле один на все тесты:
 * тест слива закрывает свои соединения (их комнаты уничтожаются) и снимает флаг, чтобы следующие тесты могли входить.
 */
function thaw(): void { (rm as unknown as { frozen: boolean }).frozen = false; }
/** Задержать все записи, начатые с этого момента; `open()` отпускает их. */
function hold(): () => void {
  let open!: () => void;
  db.gate = new Promise<void>((r) => { open = r; });
  return () => { db.gate = null; open(); };
}
/**
 * Часы бакетов лимитов стоят до конца теста (снимает `afterEach`): бакет пополняется по монотонным часам (1 токен за 0,5–2 с),
 * и тест, считающий «пятый прошёл, шестой — "Слишком часто"», под нагрузкой полного прогона ловил пополнение посреди пачки.
 * Комнаты при этом не тикают — планировщику тоже нужны часы.
 */
function freezeBuckets(): void { vi.spyOn(performance, 'now').mockReturnValue(performance.now()); }

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
  db.chars.set('char-rm', { data: newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Граница', 'char-rm') as SaveState, version: 1 });
  // ⚠ БЕЗ ФОНОВОЙ ДОПИСИ ПО ТАЙМЕРУ (R3-19): раз в 5 с НАСТОЯЩЕГО времени менеджер сам дописывает копии из `unsaved` — и под
  // нагрузкой попадал в окно теста, забирая «следующую запись упадёт» и дописывая копию раньше проверки. Тесты дописывают
  // сами (`retryUnsaved`); интервал заводится на поддельных часах и пропадает с ними. Сам фон — последний тест файла.
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try { rm = new RM(cfg); } finally { vi.useRealTimers(); }
});
// Все герои теста — одного аккаунта: лимит создания комнат (Ф0.5) не должен путать сценарии.
beforeEach(() => {
  limits.roomCreate.reset('user-rm');
  // R4-17, R4-18: вход по коду, промахи кода и лимиты команд — по аккаунту и адресу, а тесты файла — один аккаунт с петли.
  for (const l of [limits.roomJoin, limits.forgeCmd, limits.townCmd, limits.cmdResync, limits.lobby]) l.reset('user-rm');
  limits.roomCodeMiss.reset('ip:127.0.0.1');
  limits.roomCodeMiss.reset('user:user-rm');   // R5-25: промахи кода платит и аккаунт
  limits.lobbyIp.reset('ip:127.0.0.1');        // R5-12: кадры лобби — под потолком адреса
});
afterEach(() => {
  db.gate = null; db.failNext = 0; db.failFor = null; db.sessionFault = null; db.readGate = null; db.readSkip = 0; db.sessionGate = null; db.badTokens.clear(); db.moveOnRead.clear();
  reg.owner = null; reg.dbAheadMs = 0; reg.claimGate = null; vi.restoreAllMocks();
});
afterAll(() => { for (const r of inner().rooms.values()) r.stop(); });

describe('RoomManager — сетевая граница (D11)', () => {
  it('⭐ мусор в кадре ввода не доезжает до симуляции, честный ввод доезжает', async () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId: 'char-rm', fresh: true });
    await settle();
    expect(ws.last('joined'), 'вошли').toBeDefined();
    const room = roomOf('char-rm');

    const bad0 = counters.framesInvalid;
    paced(() => {
      for (const input of [{}, null, 'вперёд', { move: { x: 'a', y: 0 }, facing: 0, attack: false, cast: null, interact: false },
        { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: { id: 1 }, interact: false },
        { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false, useBelt: -3 }]) {
        ws.push({ t: 'input', seq: 1, input });
      }
    });
    expect(counters.framesInvalid - bad0, 'все шесть отброшены').toBe(6);
    // Раньше `input: {}` доезжал до `session.tick`, и шаг комнаты бросал на каждом тике.
    expect(() => { for (let i = 0; i < 3; i++) room.step(false); }).not.toThrow();

    paced(() => { ws.push({ t: 'input', seq: 2, input: { move: { x: 1, y: 0 }, facing: 0, attack: false, cast: null, interact: false } }); });
    expect(counters.framesInvalid - bad0, 'честный кадр не считается невалидным').toBe(6);
    expect(() => room.step(false)).not.toThrow();
    ws.close();
    await settle();
  });

  it('⭐ R4-05: каст НЕВЫУЧЕННОГО узла кадром ввода — ни свинга, ни ауры; выучил — тот же кадр бьёт', async () => {
    const id = seedChar('r405', (s) => { s.classId = 'warrior'; });
    const ws = await joined(id);
    const room = roomOf(id);
    const p = room.session.world.players[pidOf(room, id)]! as unknown as { save: SaveState; toggles: string[]; stamina: number };
    expect(p.save.skills, 'новый герой без скилов').toEqual({});
    const swings = (): number => ws.frames.filter((f) => f.t === 'events')
      .reduce((n, f) => n + (f as Extract<ServerFrame, { t: 'events' }>).events.filter((e) => e.type === 'swing' && e.ability !== 'attack').length, 0);
    const cast = (node: string): void => {
      paced(() => { ws.push({ t: 'input', seq: ++seq, input: { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: node, interact: false } }); });
      for (let i = 0; i < 10; i++) { p.stamina = 50; room.step(false); }
    };
    // Уровень 25 и 40, стойка и аура — прямо с 1-го уровня, без очков: так было до правки.
    for (const node of ['b-axe1h-a1', 'b-class-warrior-a4', 'b-class-warrior-a5', 'b-aura-a1']) cast(node);
    expect(swings(), 'ни одного свинга скила').toBe(0);
    expect(p.toggles, 'аура не включилась').toEqual([]);
    p.save.skills['b-axe1h-a1'] = 1;
    cast('b-axe1h-a1');
    expect(swings(), 'выученное — бьёт').toBeGreaterThan(0);
    ws.close();
    await settle();
  });

  it('⭐ команда любой формы доходит до схемы комнаты и получает cmdResult; мусор не роняет очередь', async () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId: 'char-rm', fresh: true });
    await settle();
    expect(ws.last('joined')).toBeDefined();

    ws.push({ t: 'cmd', command: { cmd: 'respec', all: true }, id: 5 });
    await settle();
    expect(ws.last('cmdResult')).toMatchObject({ id: 5, ok: false, reason: 'Неверная команда' });

    ws.push({ t: 'cmd' });                       // без команды вовсе
    await settle();
    expect(ws.last('cmdResult')).toMatchObject({ ok: false, reason: 'Неверная команда' });

    for (const junk of ['не json', 'null', '[]', '7', '{"t":{"x":1}}']) ws.push(junk);
    ws.push({ t: 'cmd', command: { cmd: 'bind', slot: 0, value: 'attack' }, id: 6 });
    await settle();
    expect(ws.last('cmdResult'), 'после мусора очередь соединения жива').toEqual({ t: 'cmdResult', id: 6, cmd: 'bind', ok: true });
    ws.close();
    await settle();
  });

  it('⭐ R1-10: номер команды — объект без строкового вида: «Неверная команда», без исключения и без console.error', async () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId: 'char-rm', fresh: true });
    await settle();
    const err = vi.spyOn(console, 'error');
    const f0 = counters.cmdFailed;
    for (const id of ['{"toString":1}', '{"valueOf":1,"toString":1}']) {
      ws.frames.length = 0;
      ws.push(`{"t":"cmd","command":{"cmd":"respec"},"id":${id}}`);
      await settle();
      expect(ws.last('cmdResult'), id).toMatchObject({ cmd: 'respec', ok: false, reason: 'Неверная команда' });
      expect(ws.last('error')?.msg, id).toBe('Неверная команда');
    }
    expect(counters.cmdFailed - f0, 'это не ошибка в коде').toBe(0);
    expect(err).not.toHaveBeenCalled();
    ws.close();
    await settle();
  });

  it('⭐ R1-19: кадры вне ввода проходят схему — кривой спуск и голос отброшены до комнаты, без исключения', async () => {
    const a = seedChar('frm-a'), b = seedChar('frm-b');
    const wsA = await joined(a);
    const wsB = await joined(b, { roomCode: roomOf(a).code });
    const room = roomOf(a);
    const err = vi.spyOn(console, 'error');
    const bad0 = counters.framesInvalid;
    wsA.frames.length = 0; wsB.frames.length = 0;
    wsA.push({ t: 'descend', runConfig: { modifiers: 'x' } });
    wsB.push({ t: 'vote', accept: 'no' });
    wsA.push({ t: 'join', token: TOK, charId: a, roomCode: 123 });
    await settle();
    expect(counters.framesInvalid - bad0, 'все три посчитаны').toBe(3);
    expect(wsA.count('voteStart') + wsB.count('voteStart') + wsA.count('voteEnd'), 'голосования не было').toBe(0);
    expect(room.area).toBe('town');
    expect(err, 'кривой кадр — не ошибка в коде').not.toHaveBeenCalled();
    // Команда проходит первую схему «как есть» — ответ ей даёт схема комнаты.
    wsA.push({ t: 'cmd', command: { cmd: 'respec', all: true }, id: 5 });
    await settle();
    expect(wsA.last('cmdResult')).toMatchObject({ id: 5, ok: false, reason: 'Неверная команда' });
    // Честный спуск после мусора проходит.
    wsA.push({ t: 'descend' });
    wsB.push({ t: 'vote', accept: true });
    await settle();
    expect(room.area).toBe('dungeon');
    wsA.close(); wsB.close();
    await settle();
  });
});

describe('RoomManager — прощальные записи, штрафы и закрепления', () => {
  it('⭐ R1-01: «Завершить» ЖИВОГО героя выселяет его сессию ДО штрафа — зомби нет, вещь не задваивается через соседа', async () => {
    const a = seedChar('live-a'), b = seedChar('live-b');
    const wsA = await joined(a);
    wsA.push({ t: 'descend' });
    await settle();
    expect(saved(a).run, 'забег уже в базе').toBeTruthy();
    const room = roomOf(a);
    const wsB = await joined(b, { roomCode: room.code });
    const weapon = saved(a).equipment.weapon!.uid;
    expect(weapon).toBeTruthy();

    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'abandon', token: TOK, charId: a });
    await settle(10);
    expect(wsX.last('abandoned')).toBeDefined();
    expect(wsA.open, 'живая сессия выселена').toBe(false);
    expect(inner().live.has(a), 'живых сессий у героя нет').toBe(false);
    expect(saved(a).run, 'штраф записан и забег снят').toBeUndefined();

    // Попытка «зомби» — снять оружие, бросить его соседу по аккаунту.
    wsA.push({ t: 'cmd', command: { cmd: 'unequip', slot: 'weapon' }, id: 1 });
    await settle();
    wsA.push({ t: 'cmd', command: { cmd: 'drop', uid: weapon }, id: 2 });
    await settle();
    const drop = room.session.world.drops.find((d) => d.item?.uid === weapon);
    if (drop) {
      const pidB = pidOf(room, b);
      room.session.world.players[pidB]!.pos = { ...drop.pos };
      wsB.push({ t: 'cmd', command: { cmd: 'pickup', dropId: drop.id }, id: 1 });
      await settle();
    }
    wsA.close(); wsB.close();
    await settle(10);
    const holders = [a, b].filter((c) => uidsOf(saved(c)).includes(weapon));
    expect(holders, 'вещь ровно у одного героя').toEqual([a]);
  });

  it('⭐ R1-06: переезд старого кошелька — часть входа: drop не обгоняет его, вещь и сырьё существуют ровно раз', async () => {
    const mat = cfg.get('craft-materials').find((m) => m.enabled)!.id;
    let uid = '';
    const c = seedChar('legacy', (s) => {
      s.materials = { [mat]: 5 };
      const w = s.equipment.weapon!;
      delete s.equipment.weapon;
      w.pos = { x: 0, y: 0 };
      s.inventory.push(w);
      uid = w.uid;
    });
    const stash0 = db.stash.version;
    const open = hold();
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId: c, fresh: true });
    ws.push({ t: 'cmd', command: { cmd: 'drop', uid }, id: 1 });
    await settle();
    // Пока переезд ждёт базу, другой герой аккаунта трогает сундук — запись переезда получит отказ.
    db.stash = { data: db.stash.data ?? { version: 1, tabs: [], materials: {} }, version: stash0 + 7 };
    open();
    await settle(10);
    expect(ws.last('joined'), 'вход состоялся и после отказа переезда').toBeDefined();
    const room = roomOf(c);
    const p = room.session.world.players[pidOf(room, c)]!;
    const inBag = p.save.inventory.some((i) => i.uid === uid);
    const onGround = room.session.world.drops.some((d) => d.item?.uid === uid);
    expect(Number(inBag) + Number(onGround), `в сумке ${inBag}, на земле ${onGround}`).toBe(1);
    const stashMats = (db.stash.data as { materials?: Record<string, number> } | null)?.materials?.[mat] ?? 0;
    expect((p.save.materials?.[mat] ?? 0) + stashMats, 'сырьё ровно раз: в сейве или в сундуке').toBe(5);
    ws.close();
    await settle();
  });

  it('⭐ R1-07: вход во время записи штрафа истёкшего грейса ждёт её и читает сейв уже СО штрафом', async () => {
    const a = seedChar('grace', (s) => { s.gold = 10_000; });
    const ws1 = await joined(a);
    ws1.push({ t: 'descend' });
    await settle();
    ws1.close();
    await settle();
    const graceRoom = inner().graceByChar.get(a);
    expect(graceRoom, 'вышел из подземелья — грейс').toBeDefined();
    const open = hold();
    graceRoom!.expireGrace();
    const ws2 = new FakeConn();
    rm.handleConnection(ws2);
    ws2.push({ t: 'join', token: TOK, charId: a, fresh: true });
    await settle();
    expect(ws2.last('joined'), 'вход ждёт запись штрафа').toBeUndefined();
    open();
    await settle(10);
    const j = ws2.last('joined');
    expect(j, JSON.stringify(ws2.last('error'))).toBeDefined();
    expect(j!.save.run, 'забег снят штрафом').toBeUndefined();
    expect(j!.save.gold, 'штраф золотом уже учтён').toBe(saved(a).gold);
    expect(j!.save.gold).toBeLessThan(10_000);
    expect(ws2.open, 'новая сессия не зомби').toBe(true);
    ws2.close();
    await settle();
  });

  it('⭐ R1-07: то же при вайпе пати — штраф отключённого пишется, и вход его дожидается', async () => {
    const a = seedChar('wipe-a', (s) => { s.gold = 10_000; }), b = seedChar('wipe-b');
    const wsA = await joined(a);
    const room = roomOf(a);
    const wsB = await joined(b, { roomCode: room.code });
    wsA.push({ t: 'descend' });
    wsB.push({ t: 'vote', accept: true });
    await settle();
    expect(room.area).toBe('dungeon');
    wsA.close();
    await settle();
    expect(inner().graceByChar.get(a), 'A отключился в подземелье — грейс').toBe(room);
    const open = hold();
    const pb = room.session.world.players[pidOf(room, b)]!;
    pb.hp = 1;
    pb.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 20 && pb.hp > 0; i++) room.step(false);
    expect(wsB.last('died')?.toTown, 'вайп').toBe(true);
    const ws3 = new FakeConn();
    rm.handleConnection(ws3);
    ws3.push({ t: 'join', token: TOK, charId: a, fresh: true });
    await settle();
    expect(ws3.last('joined'), 'вход ждёт запись штрафа').toBeUndefined();
    open();
    await settle(10);
    const j = ws3.last('joined');
    expect(j, JSON.stringify(ws3.last('error'))).toBeDefined();
    expect(j!.save.run).toBeUndefined();
    expect(j!.save.gold).toBe(saved(a).gold);
    expect(j!.save.gold).toBeLessThan(10_000);
    ws3.close(); wsB.close();
    await settle();
  });

  it('⭐ R1-08: закрепление снимается ПОСЛЕ прощальной записи; повторный вход закрепляет заново последним', async () => {
    const a = seedChar('claim');
    const ws1 = await joined(a);
    reg.calls.length = 0;
    const open = hold();
    ws1.close();
    await settle();
    expect(reg.calls, 'пока прощальная запись в полёте — закрепление держится').not.toContain(`release ${a}`);
    const ws2 = new FakeConn();
    rm.handleConnection(ws2);
    ws2.push({ t: 'join', token: TOK, charId: a, fresh: true });
    await settle();
    open();
    await settle(10);
    expect(ws2.last('joined')).toBeDefined();
    const mine = reg.calls.filter((c) => c.endsWith(` ${a}`));
    expect(mine.filter((c) => c.startsWith('release')), 'снято ровно раз').toHaveLength(1);
    expect(mine.at(-1), 'живой герой остался закреплённым').toBe(`claim ${a}`);
    ws2.close();
    await settle(10);
  });

  it('⭐ R1-08: вход, чей герой закреплён за другой живой нодой, отклоняется — и по коду комнаты тоже', async () => {
    const host = seedChar('node-host'), a = seedChar('node-a');
    const wsH = await joined(host);
    reg.owner = 'node-9';
    for (const extra of [{ fresh: true }, { roomCode: roomOf(host).code }]) {
      const ws = new FakeConn();
      rm.handleConnection(ws);
      ws.push({ t: 'join', token: TOK, charId: a, ...extra });
      await settle();
      expect(ws.last('joined'), JSON.stringify(extra)).toBeUndefined();
      expect(ws.last('error')?.code).toBe('wrong-node');
    }
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'abandon', token: TOK, charId: a });
    await settle();
    expect(wsX.last('abandoned'), '«Завершить» — тоже только на своей ноде').toBeUndefined();
    reg.owner = null;
    wsH.close();
    await settle();
  });

  it('⭐ R1-08: сердцебиение держит закрепление и за героем в грейсе — его комната ждёт на ЭТОЙ ноде', async () => {
    const a = seedChar('grace-claim');
    const ws = await joined(a);
    ws.push({ t: 'descend' });
    await settle();
    ws.close();
    await settle(10);
    expect(inner().graceByChar.has(a), 'вышел из подземелья — грейс').toBe(true);
    const { clusterHooks } = await import('./roomManager.js');
    // Раньше продлевались только живые сессии: через 300 с закрепление протухало, а грейс длится час, —
    // и вход через другую ноду обходил штраф брошенного забега (её грейс-комната здесь, штраф потом не записывался).
    expect(clusterHooks.liveCharIds()).toContain(a);
    inner().graceByChar.get(a)!.expireGrace();
    await settle(10);
    expect(clusterHooks.liveCharIds()).not.toContain(a);
  });

  it('⭐ R1-15: зависшая прощальная запись не держит вход вечно — ожидание ограничено', async () => {
    const a = seedChar('hang');
    const ws1 = await joined(a);
    const was = inner().leaveWaitMs;
    inner().leaveWaitMs = 40;
    try {
      db.gate = new Promise<void>(() => { /* база молчит */ });
      ws1.close();
      await settle();
      db.gate = null;
      const ws2 = new FakeConn();
      rm.handleConnection(ws2);
      ws2.push({ t: 'join', token: TOK, charId: a, fresh: true });
      await new Promise((r) => setTimeout(r, 120));
      await settle();
      expect(ws2.last('joined') ?? ws2.last('error'), 'вход ответил, а не повис').toBeDefined();
      ws2.close();
      await settle();
    } finally { inner().leaveWaitMs = was; }
  });

  it('⭐ R1-18: слив ноды дожидается прощальных записей тех, кто уже вышел', async () => {
    try {
      const a = seedChar('drain');
      const ws = await joined(a);
      const open = hold();
      ws.close();
      await settle();
      let flushed = false;
      const { clusterHooks } = await import('./roomManager.js');
      const f = clusterHooks.flushAll().then(() => { flushed = true; });
      await settle();
      expect(flushed, 'сейв ещё не записан — выходить рано').toBe(false);
      open();
      await f;
      expect(db.log.some((l) => l.charId === a && l.ok && l.reason === 'autosave' && l.v >= 2)).toBe(true);
    } finally { thaw(); }
  });
});

describe('RoomManager — раунд 2: кадр-убийца, прощальные записи, закрепления, грейс', () => {
  it('⭐ R2-01: пинг с id глубиной 6000 уровней не бросает из обработчика кадра; честный пинг получает понг', () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    const bad0 = counters.framesInvalid;
    expect(() => ws.push('{"t":"ping","id":' + '['.repeat(6000) + ']'.repeat(6000) + '}')).not.toThrow();
    expect(ws.frames, 'на кривой пинг не отвечаем').toEqual([]);
    expect(counters.framesInvalid - bad0).toBe(1);
    ws.push({ t: 'ping', id: 5 });
    expect(ws.frames).toEqual([{ t: 'pong', id: 5 }]);
    for (const id of ['7', 0.5, 2 ** 60, null, { x: 1 }]) ws.push({ t: 'ping', id });
    expect(ws.frames, 'номер пинга — только целое').toHaveLength(1);
    ws.close();
  });

  it('⭐ R2-01: любое синхронное исключение на кадре гасит ОДИН кадр, а не процесс', () => {
    const ws = new FakeConn();
    ws.send = () => { throw new Error('сокет умер под нами'); };
    rm.handleConnection(ws);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => ws.push({ t: 'ping', id: 1 })).not.toThrow();
    expect(err).toHaveBeenCalled();
  });

  /** Герой, у которого оружие снято в сумку: его можно выбросить командой `drop`. */
  function seedDropper(prefix: string): { charId: string; uid: string } {
    let uid = '';
    const charId = seedChar(prefix, (s) => {
      const w = s.equipment.weapon!;
      delete s.equipment.weapon;
      w.pos = { x: 0, y: 0 };
      s.inventory.push(w);
      uid = w.uid;
    });
    return { charId, uid };
  }

  it('⭐ R2-08: прощальная запись упала — повторный вход НЕ читает сейв до неё: копия дописывается первой', async () => {
    const { charId: a, uid: x } = seedDropper('fw-fail');
    const ws1 = await joined(a);
    db.failFor = a;                               // ⭐ V-B2-04: запись выброса (она — сразу) упала
    ws1.push({ t: 'cmd', command: { cmd: 'drop', uid: x }, id: 1 });
    await settle();
    expect(ws1.last('cmdResult')).toMatchObject({ id: 1, ok: true });
    expect(uidsOf(saved(a)), 'выброс ещё не записан — в базе вещь у героя').toContain(x);
    db.failNext = 1;                              // прощальная запись упадёт
    ws1.close();
    await settle(10);
    const ws2 = await joined(a);
    expect(uidsOf(ws2.last('joined')!.save), 'выброшенное не вернулось в сумку').not.toContain(x);
    expect(uidsOf(saved(a)), 'в базе — состояние на выходе').not.toContain(x);
    ws2.close();
    await settle(10);
  });

  it('⭐ R2-08: прощальная запись висит дольше потолка — вход отвечает «сохраняем», а не входит со старой копией', async () => {
    const { charId: a, uid: x } = seedDropper('fw-hang');
    const ws1 = await joined(a);
    ws1.push({ t: 'cmd', command: { cmd: 'drop', uid: x }, id: 1 });
    await settle();
    const was = inner().leaveWaitMs;
    inner().leaveWaitMs = 40;
    try {
      const open = hold();
      ws1.close();
      await settle();
      db.gate = null;                             // висит только прощальная запись
      const ws2 = new FakeConn();
      rm.handleConnection(ws2);
      ws2.push({ t: 'join', token: TOK, charId: a, fresh: true });
      await new Promise((r) => setTimeout(r, 120));
      await settle();
      expect(ws2.last('joined'), 'со старой копией не входим').toBeUndefined();
      expect(ws2.last('error')?.code).toBe('busy');
      open();
      await settle(10);
      const ws3 = await joined(a);
      expect(uidsOf(ws3.last('joined')!.save)).not.toContain(x);
      expect(uidsOf(saved(a))).not.toContain(x);
      ws3.close();
      await settle(10);
    } finally { inner().leaveWaitMs = was; }
  });

  it('⭐ R2-17: неудавшийся вход и «Завершить» без сессии снимают закрепление', async () => {
    const a = seedChar('rel');
    reg.calls.length = 0;
    const ws = new FakeConn();
    rm.handleConnection(ws);
    ws.push({ t: 'join', token: TOK, charId: a, roomCode: 'AZZZZ' });
    await settle(10);
    expect(ws.last('error')?.code).toBe('no-room');
    expect(reg.calls, 'R4-18: промах кода — до базы, закрепления не было вовсе').toEqual([]);
    ws.push({ t: 'join', token: TOK, charId: a, resume: true });   // забега нет — вход сорвался уже после закрепления
    await settle(10);
    expect(ws.last('error')?.code).toBe('no-run');
    expect(reg.calls, 'вход не состоялся — закрепление снято').toEqual([`claim ${a}`, `release ${a}`]);
    reg.calls.length = 0;
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'abandon', token: TOK, charId: a });
    await settle(10);
    expect(wsX.last('abandoned')).toBeDefined();
    expect(reg.calls, 'после «Завершить» здесь никого — закрепление снято').toEqual([`claim ${a}`, `release ${a}`]);
  });

  it('⭐ R2-17: снятие после выхода не зависит от часов ноды (часы базы впереди)', async () => {
    const a = seedChar('rel-clock');
    const ws = await joined(a);
    reg.calls.length = 0;
    reg.dbAheadMs = 5_000;
    ws.close();
    await settle(10);
    expect(reg.calls).toContain(`release ${a}`);
  });

  it('⭐ R2-05: нода потеряла закрепление живого героя — его сессия снимается без записи (4009)', async () => {
    const a = seedChar('fence');
    const ws = await joined(a);
    await settle();
    const log0 = db.log.length;
    reg.owner = 'node-9';                         // закрепление теперь у другой ноды
    const { clusterHooks } = await import('./roomManager.js');
    clusterHooks.fenceLost([a]);
    await settle(10);
    expect(ws.closedWith).toBe(4009);
    expect(inner().live.has(a), 'живой сессии нет').toBe(false);
    expect(db.log.length - log0, 'проигравшая сессия ничего не пишет').toBe(0);

    // Ждущий реконнекта в грейсе — забывается без штрафа: его забег продолжится там, где он жив.
    reg.owner = null;
    const g = seedChar('fence-grace', (s) => { s.gold = 5_000; });
    const wsG = await joined(g);
    wsG.push({ t: 'descend' });
    await settle();
    wsG.close();
    await settle(10);
    expect(inner().graceByChar.has(g), 'в грейсе').toBe(true);
    const gold0 = saved(g).gold, logG = db.log.length;
    reg.owner = 'node-9';
    clusterHooks.fenceLost([g]);
    await settle(10);
    expect(inner().graceByChar.has(g), 'грейс снят').toBe(false);
    expect(db.log.length - logG, 'штраф не записан').toBe(0);
    expect(saved(g).gold).toBe(gold0);
  });

  it('⭐ R2-19: вход по коду в грейс-комнату снимает паузу; истечение грейса не уничтожает комнату с живым игроком', async () => {
    const { tickScheduler } = await import('./scheduler.js');
    const host = seedChar('gr-host'), friend = seedChar('gr-friend');
    const wsH = await joined(host);
    wsH.push({ t: 'descend' });
    await settle();
    const room = roomOf(host);
    wsH.close();
    await settle(10);
    expect(tickScheduler.has(room as never), 'пустая комната на паузе').toBe(false);
    const wsF = await joined(friend, { roomCode: room.code });
    expect(tickScheduler.has(room as never), 'в комнате живой игрок — она тикает').toBe(true);
    room.expireGrace();
    await settle(10);
    expect(inner().rooms.get(room.code), 'комната с живым игроком не уничтожена').toBe(room);
    expect(inner().graceByChar.has(host), 'отключённый хозяин снят со штрафом').toBe(false);
    expect(wsF.open).toBe(true);
    wsF.close();
    await settle(10);
  });
});

describe('RoomManager — раунд 3: строки кадров и база (R3-02, R3-14)', () => {
  const NUL = String.fromCharCode(0);

  it('⭐ R3-02: бинд с U+0000 — отказ «Неверная команда», hotbar не тронут, запись героя проходит', async () => {
    const a = seedChar('r302-bind');
    const ws = await joined(a);
    const room = roomOf(a);
    const save = room.session.world.players[pidOf(room, a)]!.save;
    const hotbar = JSON.stringify(save.hotbar);
    // Кадр — как с провода: JSON-экран `\u0000`, который `JSON.parse` превращает в символ.
    for (const [i, value] of [`x${NUL}`, `x${String.fromCharCode(0xd800)}`].entries()) {
      ws.push(JSON.stringify({ t: 'cmd', id: 70 + i, command: { cmd: 'bind', slot: 4, value } }));
      await settle();
      expect(ws.last('cmdResult'), JSON.stringify(value)).toMatchObject({ id: 70 + i, cmd: 'bind', ok: false, reason: 'Неверная команда' });
    }
    expect(JSON.stringify(save.hotbar)).toBe(hotbar);
    const v0 = db.chars.get(a)!.version;
    ws.close();
    await settle(10);
    expect(db.chars.get(a)!.version, 'прощальная запись легла — сейв не отравлен').toBe(v0 + 1);
    expect(inner().live.has(a)).toBe(false);
  });

  it('⭐ R3-14: кадры лобби с U+0000 в токене или charId — ответ на каждый, до базы не доходят, лог молчит', async () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad0 = counters.framesInvalid, s0 = db.sessionReads, r0 = db.reads;
    const frames: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      const t = (['runStatus', 'join', 'abandon'] as const)[i % 3];
      frames.push(i % 2 ? { t, token: `a${NUL}`, charId: 'x' } : { t, token: TOK, charId: `x${NUL}` });
    }
    for (const f of frames) ws.push(JSON.stringify(f));
    await settle(10);
    expect(ws.count('error'), 'ответ на каждый кадр').toBe(50);
    expect(ws.frames.every((f) => f.t === 'error')).toBe(true);
    expect(counters.framesInvalid - bad0, 'все посчитаны как кривые').toBe(50);
    expect(db.sessionReads - s0, 'в базу не ходили').toBe(0);
    expect(db.reads - r0).toBe(0);
    expect(err, 'кривой кадр — не ошибка в коде').not.toHaveBeenCalled();
    expect(ws.open, 'соединение живо').toBe(true);
    ws.close();
  });

  it('⭐ R3-14: база не отвечает на кадр лобби — клиенту «занято» на каждый кадр, в лог — не чаще раза в 10 с', async () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const e0 = counters.frameErrors;
    db.sessionFault = new Error('Connection terminated unexpectedly');
    for (let i = 0; i < 30; i++) ws.push({ t: 'runStatus', token: TOK, charId: 'char-rm' });
    await settle(10);
    expect(ws.count('error'), 'ответ на каждый кадр').toBe(30);
    expect(ws.last('error')).toMatchObject({ code: 'busy' });
    expect(counters.frameErrors - e0).toBe(30);
    expect(err.mock.calls.length, 'поток сбоев не топит лог').toBeLessThanOrEqual(1);
    // База ожила — тот же кадр получает настоящий ответ, очередь соединения жива.
    db.sessionFault = null;
    ws.frames.length = 0;
    ws.push({ t: 'runStatus', token: TOK, charId: 'char-rm' });
    await settle(10);
    expect(ws.last('runStatus')).toBeDefined();
    ws.close();
  });
});

describe('RoomManager — раунд 4: вход, выход и лимиты (R4-06, R4-10, R4-15, R4-17, R4-18, R4-19, R4-28)', () => {
  type RunIn = {
    runPlan: { nodes: { id: string; edges: { to: string }[] }[] }; runNodeId: string;
    session: { world: { exits?: { x: number; y: number }[]; timeMs: number } };
  };
  type Vitals = { hp: number; mana: number; stamina: number; alive: boolean; debuffs: Record<string, unknown>; skillCd: Record<string, number> };
  const vitalsOf = (room: RoomIn, charId: string): Vitals => room.session.world.players[pidOf(room, charId)] as unknown as Vitals;
  /** Лимиты R4-17/R4-18 — есть ли они уже (тест пишется раньше правки). */
  const lim = limits as unknown as Record<string, { reset(k: string): void } | undefined>;

  it('⭐ R4-06: выход и «Продолжить» посреди боя не лечат — здоровье, мана, яд и откаты те же; и через второе соединение', async () => {
    const a = seedChar('r406');
    const ws = await joined(a);
    ws.push({ t: 'descend' });
    await settle();
    const room = roomOf(a);
    expect(room.area).toBe('dungeon');
    const p = vitalsOf(room, a);
    p.hp = 1; p.mana = 0; p.stamina = 0; p.skillCd = { 'b-class-warrior-a4': 30 };
    p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: (room as unknown as RunIn).session.world.timeMs + 600_000, mag: 0.001, mag2: 0 };
    const check = (label: string): void => {
      const q = vitalsOf(roomOf(a), a);
      expect(q.hp, label).toBeLessThan(2);
      expect(q.mana, label).toBeLessThan(1);
      expect(q.debuffs.poison, label).toBeDefined();
      expect(q.skillCd['b-class-warrior-a4'] ?? 0, label).toBeGreaterThan(29);
    };
    ws.push({ t: 'leave' });
    await settle(10);
    ws.push({ t: 'join', token: TOK, charId: a, resume: true });
    await settle(10);
    expect(ws.last('joined'), JSON.stringify(ws.last('error'))).toBeDefined();
    check('выход + «Продолжить» тем же соединением');
    const ws2 = new FakeConn();
    rm.handleConnection(ws2);
    ws2.push({ t: 'join', token: TOK, charId: a, resume: true });
    await settle(10);
    expect(ws2.last('joined'), JSON.stringify(ws2.last('error'))).toBeDefined();
    check('вторая вкладка выселила первую');
    ws2.close();
    await settle(10);
  });

  it('⭐ R4-06: погибший в коопе не воскресает входом по коду — ни сразу, ни после «Завершить»; забег у него есть, оживает со спуском пати', async () => {
    const a = seedChar('r406-a'), b = seedChar('r406-b', (s) => { s.gold = 1000; });
    const wsA = await joined(a);
    const room = roomOf(a);
    const wsB = await joined(b, { roomCode: room.code });
    wsA.push({ t: 'descend' });
    wsB.push({ t: 'vote', accept: true });
    await settle();
    expect(room.area).toBe('dungeon');
    const pb = room.session.world.players[pidOf(room, b)]!;
    pb.hp = 1;
    pb.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 20 && pb.hp > 0; i++) room.step(false);
    expect(wsB.last('died')?.toTown, 'кооп: B ждёт пати мёртвым').toBe(false);
    const alive = (): boolean => vitalsOf(room, b).alive;
    // (1) F5 — и вход по коду своей же комнаты.
    wsB.close();
    await settle(10);
    const ws2 = new FakeConn();
    rm.handleConnection(ws2);
    ws2.push({ t: 'join', token: TOK, charId: b, roomCode: room.code });
    await settle(10);
    expect(ws2.last('joined'), JSON.stringify(ws2.last('error'))).toBeDefined();
    expect(alive(), 'по коду в свою комнату — всё ещё мёртв').toBe(false);
    // (2) «Завершить» — и снова по коду.
    ws2.close();
    await settle(10);
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'abandon', token: TOK, charId: b });
    await settle(10);
    expect(wsX.last('abandoned')).toBeDefined();
    const ws3 = new FakeConn();
    rm.handleConnection(ws3);
    ws3.push({ t: 'join', token: TOK, charId: b, roomCode: room.code });
    await settle(10);
    expect(ws3.last('joined'), JSON.stringify(ws3.last('error'))).toBeDefined();
    expect(alive(), 'после «Завершить» — всё ещё мёртв').toBe(false);
    expect(room.session.world.players[pidOf(room, b)]!.save.run, 'в подземелье без забега не бывает — уход снова штрафуется').toBeTruthy();
    // Пати спускается — B оживает на следующем узле.
    const r = room as unknown as RunIn;
    const to = r.runPlan.nodes.find((n) => n.id === r.runNodeId)!.edges[0]!.to;
    room.movedAt = 0;
    room.session.world.players[pidOf(room, a)]!.pos = { ...r.session.world.exits![0]! };
    wsA.push({ t: 'descend', targetNodeId: to });
    ws3.push({ t: 'vote', accept: true });
    await settle();
    expect(r.runNodeId).toBe(to);
    expect(alive(), 'пати спустилась — B ожил').toBe(true);
    wsA.close(); ws3.close();
    await settle(10);
  });

  it('⭐ R4-15: прощальная запись легла, а ответ на фиксацию потерян — «Завершить» всё равно берёт штраф и снимает забег', async () => {
    const a = seedChar('r415', (s) => { s.gold = 10_000; });
    const ws = await joined(a);
    ws.push({ t: 'descend' });
    await settle();
    expect(saved(a).run).toBeTruthy();
    db.unknownNext = 1;
    ws.close();
    await settle(10);
    expect(inner().graceByChar.has(a), 'в грейсе').toBe(true);
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'abandon', token: TOK, charId: a });
    await settle(10);
    expect(wsX.last('abandoned'), JSON.stringify(wsX.last('error'))).toBeDefined();
    expect(saved(a).run, 'забег снят').toBeUndefined();
    expect(saved(a).gold, 'штраф взят').toBeLessThan(10_000);
  });

  it('⭐ R4-15: то же при истечении грейса — «Продолжить» больше не предлагается, штраф в базе', async () => {
    const a = seedChar('r415g', (s) => { s.gold = 10_000; });
    const ws = await joined(a);
    ws.push({ t: 'descend' });
    await settle();
    db.unknownNext = 1;
    ws.close();
    await settle(10);
    await (rm as unknown as { retryUnsaved(): Promise<void> }).retryUnsaved();
    inner().graceByChar.get(a)!.expireGrace();
    await settle(10);
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'runStatus', token: TOK, charId: a });
    await settle(10);
    expect(wsX.last('runStatus'), 'забега нет').toMatchObject({ hasRun: false });
    expect(saved(a).gold).toBeLessThan(10_000);
  });

  it('⭐ R4-15: версию сейва подняли, пока герой в грейсе (отзыв вещи, откат), — «Завершить» всё равно штрафует', async () => {
    const a = seedChar('r415v', (s) => { s.gold = 10_000; });
    const ws = await joined(a);
    ws.push({ t: 'descend' });
    await settle();
    ws.close();
    await settle(10);
    db.chars.get(a)!.version += 1;                       // инструмент администратора переписал строку героя
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'abandon', token: TOK, charId: a });
    await settle(10);
    expect(wsX.last('abandoned'), JSON.stringify(wsX.last('error'))).toBeDefined();
    expect(saved(a).run).toBeUndefined();
    expect(saved(a).gold).toBeLessThan(10_000);
  });

  it('⭐ R4-17: лимиты команд — по аккаунту, а не по входу: выход и вход по коду их не обнуляют; 11-й вход по коду подряд — «rate»', async () => {
    const alt = seedChar('r417-alt'), main = seedChar('r417-main');
    const wsAlt = await joined(alt);
    const code = roomOf(alt).code;
    const ws = await joined(main, { roomCode: code });
    // Часы бакетов стоят с первой команды: «вышел-зашёл — лимит тот же» не должно зависеть от того, прошли ли за выход и вход
    // полсекунды (разбор пополняется 2 в секунду) — под нагрузкой полного прогона проходили, и седьмой разбор пропускался.
    freezeBuckets();
    const salvage = (id: number): void => ws.push({ t: 'cmd', command: { cmd: 'salvage', uid: `no-such-${id}` }, id });
    const limited = (): number => ws.frames.filter((f) => f.t === 'cmdResult' && f.reason === 'Слишком часто').length;
    for (let i = 1; i <= 6; i++) salvage(i);
    await settle(10);
    expect(limited(), 'шестой разбор подряд — «Слишком часто»').toBe(1);
    ws.push({ t: 'leave' });
    await settle(10);
    ws.push({ t: 'join', token: TOK, charId: main, roomCode: code });
    await settle(10);
    expect(ws.last('joined')).toBeDefined();
    salvage(7);
    await settle(10);
    expect(ws.last('cmdResult'), 'вышел-зашёл — лимит тот же').toMatchObject({ id: 7, ok: false, reason: 'Слишком часто' });
    lim.roomJoin?.reset('user-rm');
    // Одиннадцать входов «в одну секунду»: монотонные часы стоят (с начала теста), пока тест ждёт мок базы.
    let rate = 0;
    for (let i = 0; i < 11; i++) {
      ws.push({ t: 'leave' });
      await settle(5);
      ws.frames.length = 0;
      ws.push({ t: 'join', token: TOK, charId: main, roomCode: code });
      await settle(10);
      if (ws.last('error')?.code === 'rate') rate++;
    }
    expect(rate, 'десять входов по коду подряд — можно, одиннадцатый — нет').toBe(1);
    ws.close(); wsAlt.close();
    await settle(10);
  });

  it('⭐ R4-18: промахи кода комнаты упираются в лимит; исчерпан — до базы не доходят (R5-25: сами промахи — после сессии)', async () => {
    const a = seedChar('r418');
    freezeBuckets();
    const ws = new FakeConn();
    rm.handleConnection(ws);
    const s0 = db.sessionReads, r0 = db.reads;
    reg.calls.length = 0;
    for (let i = 0; i < 20; i++) ws.push({ t: 'join', token: TOK, charId: a, roomCode: `Z${String.fromCharCode(65 + i)}QQQQQ` });
    await settle(20);
    const codes = ws.frames.filter((f) => f.t === 'error').map((f) => (f as { code: string }).code);
    expect(codes, 'ответ на каждый').toHaveLength(20);
    expect(codes.filter((c) => c === 'no-room').length, 'промахи — не больше всплеска').toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 'rate').length).toBeGreaterThanOrEqual(15);
    // R5-25: есть ли комната с кодом — только вошедшему: промах идёт после сессии; исчерпанный лимит — отказ до базы.
    expect(db.sessionReads - s0, 'сессию спрашивали только до исчерпания лимита').toBeLessThanOrEqual(5);
    expect(db.reads - r0, 'персонажа читали только до исчерпания лимита').toBeLessThanOrEqual(5);
    expect(reg.calls, 'закрепления не брали').toEqual([]);
    ws.close();
  });

  it('⭐ R4-18: код комнаты — буква ноды и 7 знаков алфавита без двусмысленных, не из Math.random', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.123456);
    const guess = 'A' + (0.123456).toString(36).slice(2, 6).toUpperCase();
    const a = seedChar('r418-code');
    const ws = await joined(a);
    vi.restoreAllMocks();
    const code = ws.last('joined')!.roomCode;
    expect(code).toMatch(/^A[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/);
    expect(code).not.toBe(guess);
    ws.close();
    await settle(10);
  });

  it('⭐ R4-18: в пати не больше четырёх — пятый по коду получает «full»', async () => {
    const chars = [1, 2, 3, 4, 5].map((i) => seedChar(`r418-p${i}`));
    const ws1 = await joined(chars[0]!);
    const code = roomOf(chars[0]!).code;
    const all = [ws1];
    for (const c of chars.slice(1, 4)) all.push(await joined(c, { roomCode: code }));
    const ws5 = new FakeConn();
    rm.handleConnection(ws5);
    ws5.push({ t: 'join', token: TOK, charId: chars[4]!, roomCode: code });
    await settle(10);
    expect(ws5.last('joined')).toBeUndefined();
    expect(ws5.last('error')?.code).toBe('full');
    for (const w of all) w.close();
    await settle(10);
  });

  it('⭐ R4-19: ввод 60 Гц три секунды — принимается около 40 в секунду без провалов длиннее 50 мс', async () => {
    const a = seedChar('r419');
    const ws = await joined(a);
    const room = roomOf(a) as unknown as { setInput(pid: string, input: unknown): void };
    let t = performance.now(), wall = Date.now();
    const at: number[] = [];
    const orig = room.setInput.bind(room);
    room.setInput = (pid, input) => { at.push(t); orig(pid, input); };
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const input = { move: { x: 1, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
    try {
      for (let i = 0; i < 180; i++) { t += 1000 / 60; wall += 1000 / 60; ws.push({ t: 'input', seq: i, input }); }
    } finally { vi.restoreAllMocks(); delete (room as { setInput?: unknown }).setInput; }
    const gaps = at.slice(1).map((x, i) => x - at[i]!);
    expect(Math.max(...gaps), 'провал между принятыми кадрами').toBeLessThanOrEqual(50);
    expect(at.length / 3, 'в секунду').toBeGreaterThan(36);
    expect(at.length / 3).toBeLessThanOrEqual(44);
    ws.close();
    await settle(10);
  });

  it('⭐ R4-19: кадр с нажатием (рывок, каст) мягкий лимит не глушит — даже когда бакет пуст', async () => {
    const a = seedChar('r419-press');
    const ws = await joined(a);
    const room = roomOf(a) as unknown as { setInput(pid: string, input: { dodge?: boolean; cast: string | null }): void };
    const got: { dodge?: boolean; cast: string | null }[] = [];
    const orig = room.setInput.bind(room);
    room.setInput = (pid, input) => { got.push(input); orig(pid, input); };
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_000);   // часы стоят: бакет не пополняется
    const idle = { move: { x: 1, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
    try {
      for (let i = 0; i < 6; i++) ws.push({ t: 'input', seq: i, input: idle });
      ws.push({ t: 'input', seq: 6, input: { ...idle, dodge: true } });
      ws.push({ t: 'input', seq: 7, input: { ...idle, cast: 'b-aura-a1' } });
    } finally { vi.restoreAllMocks(); delete (room as { setInput?: unknown }).setInput; }
    expect(got.length, 'удержания сверх всплеска отброшены, нажатия — нет').toBe(3 + 2);
    expect(got.some((i) => i.dodge === true), 'рывок дошёл').toBe(true);
    expect(got.some((i) => i.cast === 'b-aura-a1'), 'каст дошёл').toBe(true);
    ws.close();
    await settle(10);
  });

  it('⭐ R4-10: запись упала взаимоблокировкой (40P01) — повторяется сразу, и слив ноды её дожидается', async () => {
    try {
      const x = seedChar('r410-x'), y = seedChar('r410-y');
      const wsX = await joined(x);
      const wsY = await joined(y, { roomCode: roomOf(x).code });
      await settle(10);
      const v0 = db.chars.get(y)!.version;
      db.deadlockFor = y;
      await rm.flushAll();
      expect(db.deadlockFor, 'взаимоблокировка случилась').toBeNull();
      expect(db.chars.get(y)!.version, 'Y записан до конца слива').toBeGreaterThan(v0);
      wsX.close(); wsY.close();
      await settle(10);
    } finally { thaw(); }
  });

  it('⭐ R4-28: сердцебиение продлило закрепление героя, который уже ушёл, — нода снимает его снова в очереди героя; живого — нет', async () => {
    const a = seedChar('r428'), b = seedChar('r428-live');
    const wsB = await joined(b);
    reg.calls.length = 0;
    (rm as unknown as { releaseIdle(ids: string[]): void }).releaseIdle([a, b]);
    await settle(10);
    expect(reg.calls).toContain(`release ${a}`);
    expect(reg.calls, 'живого не снимаем').not.toContain(`release ${b}`);
    wsB.close();
    await settle(10);
  });
});

describe('RoomManager — раунд 5: вход, слив и лимиты лобби (R5-07, R5-10, R5-12, R5-13, R5-25, R5-27)', () => {
  const errCodes = (ws: FakeConn): string[] => ws.frames.filter((f) => f.t === 'error').map((f) => (f as { code: string }).code);
  /** Соединение с адресом `ip` (FakeConn — с петли). */
  const connFrom = (ip: string): FakeConn => { const ws = new FakeConn(); Object.defineProperty(ws, 'ip', { value: ip }); rm.handleConnection(ws); return ws; };
  const lim = limits as unknown as Record<string, { reset(k: string): void } | undefined>;
  /** Лимиты лобби этого файла (один аккаунт с петли) — заново. */
  const freshLobby = (): void => { lim.lobby?.reset('user-rm'); lim.lobbyIp?.reset('ip:127.0.0.1'); limits.roomCodeMiss.reset('user:user-rm'); };
  const nodeCap = (): { nodeMaxPlayers: number } => inner() as unknown as { nodeMaxPlayers: number };

  /**
   * ⭐ R5-27: КОМНАТА ИСЧЕЗЛА, ПОКА ВХОД ПО КОДУ ЖДАЛ БАЗУ. Проверка кода была одна — до ожиданий; после них `home`
   * сравнивал `undefined === undefined` и вход уходил в «Продолжить»: «Забег не найден» вместо «Комната не найдена», а
   * герой с припаркованным забегом продолжал СВОЙ забег в новой комнате вместо входа к другу.
   */
  it('⭐ R5-27: комната друга исчезла посреди входа по коду — «Комната не найдена», своей комнаты не заводится', async () => {
    for (const parked of [false, true]) {
      const friend = seedChar(`r527f${parked ? 'p' : ''}`);
      const me = seedChar(`r527m${parked ? 'p' : ''}`);
      if (parked) {
        // Свой забег припаркован в городе: спустился, вышел порталом, закрыл вкладку — в базе `save.run`.
        const wsMe = await joined(me);
        wsMe.push({ t: 'descend' });
        await settle();
        const r = roomOf(me) as RoomIn & { session: { world: { spawn: { x: number; y: number } } } };
        r.session.world.players[pidOf(r, me)]!.pos = { ...r.session.world.spawn };
        r.movedAt = 0;
        wsMe.push({ t: 'return' });
        await settle();
        expect(r.area).toBe('town');
        wsMe.close();
        await settle(10);
        expect(saved(me).run, 'забег припаркован в базе').toBeTruthy();
      }
      const wsF = await joined(friend);
      const code = roomOf(friend).code;
      let open!: () => void;
      reg.claimGate = new Promise<void>((r) => { open = r; });
      const ws = new FakeConn();
      rm.handleConnection(ws);
      ws.push({ t: 'join', token: TOK, charId: me, roomCode: code });
      await settle();
      wsF.close();                                           // друг вышел — комната из города уничтожена
      await settle(10);
      expect(inner().rooms.has(code)).toBe(false);
      const rooms0 = inner().rooms.size;
      reg.claimGate = null; open();
      await settle(10);
      expect(ws.last('joined'), 'вход не состоялся').toBeUndefined();
      expect(errCodes(ws), parked ? 'не продолжение своего забега' : 'не «Забег не найден»').toEqual(['no-room']);
      expect(inner().rooms.size, 'своей комнаты не завелось').toBe(rooms0);
      expect(inner().live.has(me)).toBe(false);
    }
  });

  /**
   * ⭐ R5-10: «ПРОДОЛЖИТЬ», ЧЬЁ ЧТЕНИЕ СЕЙВА СОВПАЛО С ПОХОРОНАМИ ГЕРОЯ. Пока вход ждал ответа базы, комната сама начала
   * прощальную запись того же героя (истёк грейс, пати ушла в город, вайп, финал). Вход её не видел — он проверил её ДО
   * чтения — и собирал сессию из копии до штрафа: забег цел, золото цело; живая сессия держала неоштрафованную копию.
   */
  it('⭐ R5-10: грейс истёк, пока «Продолжить» читал сейв, — «сохраняем, повторите»; штраф в базе, живой копии богаче базы нет', async () => {
    const a = seedChar('r510', (s) => { s.gold = 10_000; });
    const ws1 = await joined(a);
    ws1.push({ t: 'descend' });
    await settle();
    ws1.close();
    await settle(10);
    const grace = inner().graceByChar.get(a)!;
    expect(grace, 'ждёт реконнекта').toBeDefined();
    let openRead!: () => void;
    db.readGate = new Promise<void>((r) => { openRead = r; });
    db.readSkip = 1;                                        // проверку владения не держим — держим чтение сейва входом
    const ws2 = new FakeConn();
    rm.handleConnection(ws2);
    ws2.push({ t: 'join', token: TOK, charId: a, resume: true });
    await settle();
    const release = hold();                                 // запись штрафа ушла в базу и висит
    grace.expireGrace();
    db.readGate = null; openRead();
    await settle(10);
    expect(ws2.last('joined'), 'поверх похорон вход не строится').toBeUndefined();
    expect(ws2.last('error')?.code).toBe('busy');
    release();
    await settle(20);
    const row = saved(a);
    expect(row.gold, 'штраф брошенного забега — в базе').toBeLessThan(10_000);
    expect(row.run, 'забег снят').toBeUndefined();
    ws2.push({ t: 'join', token: TOK, charId: a, resume: true });
    await settle(10);
    expect(ws2.last('error')?.code, 'повтор — забега больше нет').toBe('no-run');
    for (const r of inner().rooms.values()) for (const p of Object.values(r.session.world.players)) {
      if (p.save.charId === a) expect(p.save.gold, 'живой копии богаче базы нет').toBeLessThanOrEqual(row.gold);
    }
  });

  it('⭐ R5-10: штраф по строке базы, которую дважды обогнали, не пропадает молча — копия ждёт дописи, фон её дописывает', async () => {
    const a = seedChar('r510s', (s) => { s.gold = 10_000; });
    const ws = await joined(a);
    ws.push({ t: 'descend' });
    await settle();
    ws.close();
    await settle(10);
    const grace = inner().graceByChar.get(a)!;
    db.chars.get(a)!.version += 1;                         // копия в грейсе устарела (отзыв вещи, откат)
    db.moveOnRead.set(a, 2);                               // и обе попытки штрафа по строке базы обгоняют
    grace.expireGrace();
    await settle(20);
    expect(saved(a).run, 'штраф пока не лёг').toBeTruthy();
    expect(rm.savingChars(), 'но и не пропал: ждёт дописи (раньше — «записано»)').toContain(a);
    await (rm as unknown as { retryUnsaved(now?: number): Promise<void> }).retryUnsaved();
    expect(saved(a).run, 'фон дописал штраф').toBeUndefined();
    expect(saved(a).gold).toBeLessThan(10_000);
    expect(rm.savingChars()).not.toContain(a);
  });

  /**
   * ⭐ R5-12: КАДРЫ ЛОББИ — ПОД ПОТОЛКОМ АККАУНТА. Статус забега, «Завершить» и вход по коду платили только потолок кадров
   * соединения (80/с), а сокетов на адрес сколько угодно: каждый кадр — сессия и сейв из базы (у входа ещё закрепление,
   * выселение и прощальная запись), и один аккаунт держал общую базу всех нод.
   */
  it('⭐ R5-12: 5 сокетов × 50 кадров статуса забега — чтения базы под потолком аккаунта, лишнее — «rate»', async () => {
    const a = seedChar('r512');
    freshLobby();
    freezeBuckets();
    const socks = [0, 1, 2, 3, 4].map(() => { const w = new FakeConn(); rm.handleConnection(w); return w; });
    const r0 = db.reads;
    for (let i = 0; i < 50; i++) for (const w of socks) w.push({ t: 'runStatus', token: TOK, charId: a });
    await settle(20);
    const answered = socks.reduce((n, w) => n + w.count('runStatus'), 0);
    const limited = socks.reduce((n, w) => n + errCodes(w).filter((c) => c === 'rate').length, 0);
    expect(answered + limited, 'ответ на каждый').toBe(250);
    expect(answered, 'ответили не больше всплеска с пополнением').toBeLessThanOrEqual(25);
    expect(db.reads - r0, 'сейв из базы — только отвеченным').toBeLessThanOrEqual(answered * 2);
    for (const w of socks) w.close();
    await settle(10);
    freshLobby();
  });

  it('⭐ R5-12: вход без кода, отклонённый лимитом создания комнат, живую сессию не выселяет и прощальной записи не пишет', async () => {
    const a = seedChar('r512b');
    const ws1 = await joined(a);
    for (let i = 0; i < 40; i++) limits.roomCreate.take('user-rm');
    const writes0 = db.log.length;
    const ws2 = new FakeConn();
    rm.handleConnection(ws2);
    ws2.push({ t: 'join', token: TOK, charId: a, fresh: true });
    await settle(10);
    expect(ws2.last('error')?.code).toBe('rate');
    expect(ws1.open, 'живая сессия цела').toBe(true);
    expect(ws1.closedWith).toBeUndefined();
    expect(inner().live.get(a)).toBe(ws1);
    expect(db.log.length, 'прощальной записи не было').toBe(writes0);
    limits.roomCreate.reset('user-rm');
    ws1.close();
    await settle(10);
  });

  /**
   * ⭐ R5-25: ЕСТЬ ЛИ КОМНАТА С ТАКИМ КОДОМ — ТОЛЬКО ВОШЕДШЕМУ. Поиск кода шёл до проверки сессии: «no-room» против
   * «auth»/«full» отвечал на вопрос любому, без аккаунта, а промах платил только лимит полного адреса — адреса одной
   * IPv6-сети /64 давали каждому свой бакет.
   */
  it('⭐ R5-25: вход по коду с неизвестным токеном — «auth», есть комната или нет', async () => {
    const friend = seedChar('r525');
    const wsF = await joined(friend);
    const code = roomOf(friend).code;
    const bad = 'ef'.repeat(32);
    db.badTokens.add(bad);
    for (const c of [code, 'AZZZZZZZ']) {
      const ws = new FakeConn();
      rm.handleConnection(ws);
      ws.push({ t: 'join', token: bad, charId: friend, roomCode: c });
      await settle(10);
      expect(errCodes(ws), c).toEqual(['auth']);
    }
    wsF.close();
    await settle(10);
  });

  it('⭐ R5-25: промахи кода с двух адресов одной IPv6-сети /64 — один бакет; и аккаунт платит сам', async () => {
    const a = seedChar('r525b');
    freshLobby();
    freezeBuckets();
    const keys = ['ip:2001:db8:1:2::/64', 'ip:2001:db8:9:0::/64'];
    try {
      const w1 = connFrom('2001:db8:1:2::1');
      for (let i = 0; i < 5; i++) w1.push({ t: 'join', token: TOK, charId: a, roomCode: `AQ${i}QQQQQ` });
      await settle(10);
      expect(errCodes(w1), 'всплеск промахов').toEqual(['no-room', 'no-room', 'no-room', 'no-room', 'no-room']);
      const w2 = connFrom('2001:db8:1:2:ffff::abcd');
      w2.push({ t: 'join', token: TOK, charId: a, roomCode: 'AQXQQQQQ' });
      await settle(10);
      expect(errCodes(w2), 'соседний адрес той же /64 — тот же бакет').toEqual(['rate']);
      const w3 = connFrom('2001:db8:9::1');
      w3.push({ t: 'join', token: TOK, charId: a, roomCode: 'AQYQQQQQ' });
      await settle(10);
      expect(errCodes(w3), 'другая сеть, тот же аккаунт — промахи аккаунта исчерпаны').toEqual(['rate']);
      for (const w of [w1, w2, w3]) w.close();
    } finally {
      for (const k of [...keys, 'user:user-rm']) limits.roomCodeMiss.reset(k);
      for (const k of keys) lim.lobbyIp?.reset(k);
      freshLobby();
    }
  });

  /**
   * ⭐ R5-13: ПОТОЛОК ИГРОКОВ — НЕ ТОЛЬКО У ГЕЙТВЕЯ. Очередь на вход держал только маршрут гейтвея; нода принимала вход без
   * кода от любого, кто знает её адрес (или получил его по коду из одной буквы), — потолок, берегущий ноды, был советом.
   */
  it('⭐ R5-13: нода на потолке — новый вход без кода отказан «busy»; вход к другу по коду — в пределах запаса', async () => {
    const was = nodeCap().nodeMaxPlayers;
    const ids = [1, 2, 3].map((i) => seedChar(`r513-${i}`));
    const ws1 = await joined(ids[0]!);
    nodeCap().nodeMaxPlayers = inner().live.size;
    try {
      const ws2 = new FakeConn();
      rm.handleConnection(ws2);
      ws2.push({ t: 'join', token: TOK, charId: ids[1]!, fresh: true });
      await settle(10);
      expect(ws2.last('joined'), 'сверх потолка новая комната не заводится').toBeUndefined();
      expect(ws2.last('error')?.code).toBe('busy');
      const ws3 = await joined(ids[2]!, { roomCode: roomOf(ids[0]!).code });   // к другу — запас на пати
      ws3.close();
      ws2.close();
    } finally { nodeCap().nodeMaxPlayers = was; }
    ws1.close();
    await settle(10);
  });

  it('⭐ R5-14: нода с номером 26 и дальше не поднимается — её коды комнат делили бы букву с node-0', () => {
    const was = process.env.DM_NODE_ID;
    process.env.DM_NODE_ID = 'node-26';
    try {
      expect(() => new RM(cfg)).toThrow(/A–Z/);
    } finally { if (was === undefined) delete process.env.DM_NODE_ID; else process.env.DM_NODE_ID = was; }
  });

  /**
   * ⭐ R5-07: СЛИВ — БАРЬЕР. Слив дописывал снимок сейвов и ждал записей, а комнаты жили дальше: тикали и исполняли
   * команды. Два героя одного аккаунта в одной комнате: сейв A (с мечом) записан сливом — A бросил меч, B поднял и положил
   * в сундук аккаунта, запись B легла до выхода процесса. Меч — и в последнем сейве A, и в сундуке.
   */
  it('⭐ R5-07: после начала слива меч не переходит: drop, pickup, stashMove отказаны, в базе ничего не меняется', async () => {
    let x = '';
    const a = seedChar('r507a', (s) => {
      const w = s.equipment.weapon!;
      delete s.equipment.weapon;
      w.pos = { x: 0, y: 0 };
      s.inventory.push(w);
      x = w.uid;
    });
    const b = seedChar('r507b');
    try {
      const wsA = await joined(a);
      const room = roomOf(a);
      const wsB = await joined(b, { roomCode: room.code });
      const pb = room.session.world.players[pidOf(room, b)]!;
      const bUid = pb.save.equipment.weapon?.uid ?? pb.save.inventory[0]!.uid;
      const release = hold();                                // запись слива в полёте
      reg.draining = true;
      const flushing = rm.flushAll();
      wsA.push({ t: 'cmd', command: { cmd: 'drop', uid: x }, id: 1 });
      await settle();
      expect(wsA.last('cmdResult'), 'бросить после начала слива нельзя').toMatchObject({ id: 1, ok: false });
      expect(room.session.world.drops.some((d) => d.item?.uid === x), 'меча на земле нет').toBe(false);
      const pa = room.session.world.players[pidOf(room, a)]!;
      expect(pa.save.inventory.some((i) => i.uid === x), 'меч у A').toBe(true);
      wsB.push({ t: 'cmd', command: { cmd: 'stashMove', uid: bUid, dst: 'stash', x: 0, y: 0 }, id: 1 });
      wsB.push({ t: 'cmd', command: { cmd: 'pickup', dropId: 1 }, id: 2 });
      await settle();
      expect(wsB.frames.filter((f) => f.t === 'cmdResult').map((f) => (f as { ok: boolean }).ok), 'команды B отказаны').toEqual([false, false]);
      release();
      await flushing;
      const stash0 = JSON.stringify(db.stash);
      const rowA = JSON.stringify(saved(a)), rowB = JSON.stringify(saved(b));
      expect(uidsOf(saved(a)), 'меч — в сейве A').toContain(x);
      wsA.push({ t: 'cmd', command: { cmd: 'drop', uid: x }, id: 2 });
      wsB.push({ t: 'cmd', command: { cmd: 'stashMove', uid: bUid, dst: 'stash', x: 0, y: 0 }, id: 3 });
      await settle(10);
      expect(JSON.stringify(db.stash), 'сундук не тронут').toBe(stash0);
      expect(JSON.stringify(saved(a))).toBe(rowA);
      expect(JSON.stringify(saved(b))).toBe(rowB);
      expect(uidsOf(saved(b))).not.toContain(x);
      const ws3 = new FakeConn();
      rm.handleConnection(ws3);
      ws3.push({ t: 'join', token: TOK, charId: seedChar('r507c'), fresh: true });
      await settle(10);
      expect(ws3.last('error')?.code, 'новых входов после слива нет').toBe('busy');
      wsA.close(); wsB.close();
      await settle(10);
    } finally { reg.draining = false; thaw(); }
  });
});

describe('RoomManager — раунд 3: финал без партнёра, недописанные копии (R3-05, R3-19)', () => {
  type RunIn = {
    runPlan: { nodes: { id: string; edges: { to: string }[] }[] }; runNodeId: string;
    decor: { kind: string; x: number; y: number }[]; session: { world: { exits?: { x: number; y: number }[] } };
  };

  it('⭐ R3-05: пати закончила забег, пока партнёр в грейсе, — статус его забега «нет», в базе забега нет', async () => {
    const a = seedChar('r305-a'), b = seedChar('r305-b');
    const wsA = await joined(a);
    const room = roomOf(a);
    const wsB = await joined(b, { roomCode: room.code });
    wsA.push({ t: 'descend' });
    wsB.push({ t: 'vote', accept: true });
    await settle();
    expect(room.area).toBe('dungeon');
    const r = room as unknown as RunIn;
    const node = (): { id: string; edges: { to: string }[] } => r.runPlan.nodes.find((n) => n.id === r.runNodeId)!;
    const pa = room.session.world.players[pidOf(room, a)]!;
    for (let g = 0; g < 40 && node().edges.length; g++) {
      const to = node().edges[0]!.to;
      room.movedAt = 0;
      pa.pos = { ...r.session.world.exits![0]! };      // спуск — от выхода (R3-01)
      // R5-04: «за» спуск из-под монстра засчитывается только у выхода — B стоит рядом (тик мог натравить монстра у входа).
      room.session.world.players[pidOf(room, b)]!.pos = { ...r.session.world.exits![0]! };
      wsA.push({ t: 'descend', targetNodeId: to });
      wsB.push({ t: 'vote', accept: true });
      await settle();
      expect(r.runNodeId).toBe(to);
    }
    wsB.close();                                       // B отвалился на финале
    await settle(10);
    expect(inner().graceByChar.get(b), 'B ждёт реконнекта').toBe(room);
    expect(saved(b).run, 'прощальная запись — с финалом').toBeTruthy();
    const portal = r.decor.find((d) => d.kind === 'portal')!;
    room.movedAt = 0;
    pa.pos = { x: portal.x, y: portal.y };
    wsA.push({ t: 'descend' });                        // A завершает забег
    await settle(10);
    expect(room.area).toBe('town');
    expect(saved(b).run, 'в базе у B забега нет').toBeUndefined();
    const wsX = new FakeConn();
    rm.handleConnection(wsX);
    wsX.push({ t: 'runStatus', token: TOK, charId: b });
    await settle(10);
    expect(wsX.last('runStatus'), '«Продолжить» не предлагается').toMatchObject({ hasRun: false });
    wsA.close();
    await settle(10);
  });

  it('⭐ R3-15: часы ноды шагнули назад на 5 с — играющего не выкидывает лимитом кадров (4008)', async () => {
    const a = seedChar('r315');
    const ws = await joined(a);
    let wall = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const input = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
    for (let i = 0; i < 90; i++) { wall += 33; ws.push({ t: 'input', seq: i, input }); }   // 3 с ввода на 30 Гц
    wall -= 5_000;
    ws.push({ t: 'input', seq: 90, input });
    expect(ws.open, 'соединение живо').toBe(true);
    expect(ws.closedWith).toBeUndefined();
    vi.restoreAllMocks();
    ws.close();
    await settle(10);
  });

  /**
   * ⭐ R3-08: ВЫСОКИЙ FPS — НЕ ФЛУД. 2D-клиент слал ввод на каждый кадр rAF, а общий потолок кадров (80/с) считал и
   * ввод — раньше мягкого лимита ввода (40/с): монитор 144 Гц рвался кодом 4008 за две секунды. Ввод теперь платит
   * из своего бакета с запасом на любой монитор, лишнее по-прежнему молча отбрасывает мягкий лимит.
   */
  it('⭐ R3-08: 144 кадра ввода в секунду (и пинг) 5 с подряд — соединение живо, в комнату не больше 40 в секунду', async () => {
    const a = seedChar('r308');
    const ws = await joined(a);
    const room = roomOf(a) as unknown as { setInput(pid: string, input: unknown): void };
    let t = performance.now(), wall = Date.now();
    const perSec = new Map<number, number>();
    const orig = room.setInput.bind(room);
    room.setInput = (pid, input) => { const s = Math.floor(wall / 1000); perSec.set(s, (perSec.get(s) ?? 0) + 1); orig(pid, input); };
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const input = { move: { x: 1, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
    try {
      for (let i = 0; i < 144 * 5; i++) {
        t += 1000 / 144; wall += 1000 / 144;
        if (i % 144 === 0) ws.push({ t: 'ping', id: i });
        ws.push({ t: 'input', seq: i, input });
      }
    } finally { vi.restoreAllMocks(); delete (room as { setInput?: unknown }).setInput; }
    expect(ws.closedWith, 'не рвётся потолком кадров').toBeUndefined();
    expect(ws.open).toBe(true);
    // R4-19: мягкий лимит — бакет: 40 в секунду и всплеск 3 (кадры режутся равномерно, а не хвостом секунды).
    expect(Math.max(...perSec.values()), 'мягкий лимит ввода держит 40 в секунду').toBeLessThanOrEqual(43);
    expect([...perSec.values()].reduce((x, y) => x + y, 0), 'ввод доходит').toBeGreaterThan(150);
    ws.close();
    await settle(10);
  });

  it('⭐ R3-08: бакет ввода не открывает дорогу другим кадрам — «ввод» с чужим типом отброшен, флуд ввода рвётся', async () => {
    const ws = new FakeConn();
    rm.handleConnection(ws);
    const before = db.sessionReads;
    // JSON берёт ПОСЛЕДНИЙ из повторённых ключей: кадр начинается как ввод, а тип у него — кадр лобби.
    for (let i = 0; i < 200; i++) ws.push(`{"t":"input","t":"runStatus","token":"${TOK}","charId":"char-rm"}`);
    await settle(10);
    expect(db.sessionReads, 'кадр лобби под видом ввода до базы не дошёл').toBe(before);
    expect(ws.frames, 'и ответа на него нет').toEqual([]);
    const flood = new FakeConn();
    rm.handleConnection(flood);
    for (let i = 0; i < 2_000 && flood.open; i++) flood.push({ t: 'input', seq: i, input: {} });
    expect(flood.closedWith, 'флуд вводом без паузы — всё ещё 4008').toBe(4008);
  });

  it('R3-12: нода сливается — вход и «Завершить» отвечают «перезапускаемся», сессий и закреплений не заводят', async () => {
    const a = seedChar('r312');
    reg.calls.length = 0;
    reg.draining = true;
    try {
      const ws = new FakeConn();
      rm.handleConnection(ws);
      ws.push({ t: 'join', token: TOK, charId: a, fresh: true });
      await settle(10);
      ws.push({ t: 'abandon', token: TOK, charId: a });
      await settle(10);
      expect(ws.last('joined')).toBeUndefined();
      expect(ws.frames.map((f) => f.t === 'error' ? f.code : f.t)).toEqual(['busy', 'busy']);
      expect(inner().live.has(a)).toBe(false);
      expect(reg.calls, 'закрепление за сливаемой нодой не взято').toEqual([]);
    } finally { reg.draining = false; }
  });

  it('⭐ R3-19: прощальная запись упала, а герой не вернулся — копию дописывает фон, закрепление снимается', async () => {
    let x = '';
    const a = seedChar('r319', (s) => {
      const w = s.equipment.weapon!;
      delete s.equipment.weapon;
      w.pos = { x: 0, y: 0 };
      s.inventory.push(w);
      x = w.uid;
    });
    const ws = await joined(a);
    db.failFor = a;                                    // ⭐ V-B2-04: запись выброса (она — сразу) упала
    ws.push({ t: 'cmd', command: { cmd: 'drop', uid: x }, id: 1 });
    await settle();
    expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
    // Сбой — у записи ЭТОГО героя: фон дописывает копии прошлых тестов по таймеру и забрал бы «следующую запись» себе.
    db.failFor = a;                                    // прощальная запись упадёт (короткий сбой базы)
    ws.close();
    await settle(10);
    expect(uidsOf(saved(a)), 'в базе — копия до выброса').toContain(x);
    expect(rm.savingChars(), 'копия ждёт дописи').toContain(a);
    reg.calls.length = 0;
    const retry = rm as unknown as { retryUnsaved(now?: number): Promise<void> };
    await retry.retryUnsaved();                        // база ожила; никто не входит
    expect(uidsOf(saved(a)), 'копия на выходе дописана фоном').not.toContain(x);
    expect(rm.savingChars(), 'дописывать больше нечего').not.toContain(a);
    expect(reg.calls, 'закрепление снято — держать героя здесь незачем').toContain(`release ${a}`);
  });

  it('R3-19: фон повторяет недописанные копии сам — по таймеру, без входа героя', () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(RM.prototype as unknown as { retryUnsaved(): Promise<void> }, 'retryUnsaved').mockResolvedValue(undefined);
      new RM(cfg);                                     // последний тест файла: менеджер процесса подменяется
      expect(spy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(spy).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
