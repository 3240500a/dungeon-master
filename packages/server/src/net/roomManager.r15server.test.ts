import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, itemFromBaseId, findFree, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

// Менеджер ждётся оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы, а не часы.
vi.setConfig({ testTimeout: 60_000 });

/**
 * ⭐ РАУНД 15 (СЕРВЕР), менеджер и комната — настоящие, база — маленькая честная (версии строк) с воротами записи по попытке.
 *  • R15-02: прощальная запись уходящего — последняя запись его сессии. Раньше она склеивалась с ждущим автосейвом (R16 C-06), а запись
 *    выброса, вставшая за ним, ложилась после прощания: вход заново (F5, вторая вкладка) читал строку до неё — и его первая запись
 *    получала отказ по версии, сессию снимали (4009).
 *  • R15-04: обрыв связи без закрытия сокета (роуминг Wi-Fi, смена соты) — клиент копит ввод, и TCP отдаёт его разом: 10 с на вебе (30 Гц)
 *    и 5 с на Unity (60 Гц) — больше 300 кадров подряд, и честного рвало кодом 4008 на 301-м. Теперь лишний ввод отбрасывается, а рвёт —
 *    только поток.
 *  • R15-08: забег, который комната отпустила, пока его взятие или продление шло в базу (вставка ложилась после её `DELETE`), — отпускается
 *    снова: строка в `run_locks` без комнаты вела «Продолжить» на соседней ноде к исчезнувшей комнате.
 */
const TOK = 'f7'.repeat(32);
const USER = 'user-r15rm';
const db = vi.hoisted(() => ({
  chars: new Map<string, { data: SaveState; version: number }>(),
  /** Ворота записи строки героя — по попытке (снимок уже снят): `null` — без ожидания. */
  holds: new Map<string, (Promise<void> | null)[]>(),
  /** Чтения и записи строк — по порядку. */
  log: [] as string[],
}));
vi.mock('../db/db.js', () => ({
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  landedVersion: async () => null,
  getSession: async (token: string) => (token === 'f7'.repeat(32) ? 'user-r15rm' : null),
  getCharacter: async (charId: string) => {
    const r = db.chars.get(charId);
    db.log.push(`read v${r?.version}`);
    return r ? { userId: 'user-r15rm', data: structuredClone(r.data), version: r.version } : null;
  },
  putCharacter: async (charId: string, _u: string, data: SaveState, v: number) => {
    const json = JSON.stringify(data);   // снимок — в момент вызова
    const g = db.holds.get(charId)?.shift();
    if (g) await g;
    const r = db.chars.get(charId);
    if (!r || v !== r.version) { db.log.push(`put v${v} -> CONFLICT (row v${r?.version})`); return null; }
    r.version = v + 1; r.data = JSON.parse(json) as SaveState;
    db.log.push(`put v${v} -> v${r.version}`);
    return r.version;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

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
  result(id: number): Extract<ServerFrame, { t: 'cmdResult' }> | undefined {
    return this.frames.find((f): f is Extract<ServerFrame, { t: 'cmdResult' }> => f.t === 'cmdResult' && f.id === id);
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(what: string, ok: () => boolean, turns = 5_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (ok()) return; await tick(); }
  throw new Error(`не дождались: ${what}`);
}
const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

type ClientIn = { pid: string; saveVersion: number; input: { facing: number } };
type RoomIn = {
  code: string; clients: Map<string, ClientIn>;
  stop(): void; persistAll(): Promise<unknown>;
};
type RMIn = { rooms: Map<string, RoomIn>; inflight: Map<string, unknown>; handleConnection(ws: GameConn): void };
type RoomProto = {
  removePlayer(this: RoomIn, pid: string): Promise<{ saved: boolean }>;
  write(this: RoomIn, c: ClientIn, ...rest: unknown[]): Promise<string>;
};
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let proto: RoomProto;
let cfg: ConfigRegistry;
const managers: RMIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  proto = (await import('./room.js')).Room.prototype as unknown as RoomProto;
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
/** Свой менеджер на тест, без фоновой дописки копий по таймеру (R3-19). */
function manager(): RMIn {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    const rm = new RoomManagerCtor(cfg) as unknown as RMIn;
    managers.push(rm);
    return rm;
  } finally { vi.useRealTimers(); }
}
beforeEach(() => {
  for (const l of [limits.roomJoin, limits.roomCreate, limits.lobby, limits.townCmd, limits.cmdResync, limits.stashRead]) l.reset(USER);
  for (let i = 1; i <= 400; i++) for (const l of [limits.wsFrames, limits.wsInput, limits.wsInputOver, limits.lobbyConn]) l.reset(`c${i}`);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db.holds.clear(); db.log = [];
});
afterEach(() => {
  for (const rm of managers.splice(0)) for (const r of rm.rooms.values()) r.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Герой в базе с двумя мечами в сумке — их uid. */
function seed(id: string): string[] {
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
  s.level = 30; s.gold = 5000;
  const uids: string[] = [];
  for (let k = 0; k < 2; k++) {
    const sword = itemFromBaseId(cfg.get('items.base'), 'long-sword', cfg.get('item-tiers'), 'drop')!;
    s.inventory.push({ ...sword, pos: findFree(s.inventory, sword.gridW, sword.gridH, cfg.get('balance').inventory) });
    uids.push(sword.uid);
  }
  db.chars.set(id, { data: s, version: 1 });
  return uids;
}
let ipSeq = 0;
function join(rm: RMIn, charId: string): FakeConn {
  const ws = new FakeConn(`198.51.100.${++ipSeq % 250}`);
  rm.handleConnection(ws);
  ws.push({ t: 'join', token: TOK, charId, fresh: true });
  return ws;
}
/** Ворота на следующие записи строки героя (по порядку попыток; `false` — без ожидания). Возвращает, чем их открыть. */
function holds(charId: string, pattern: boolean[]): (() => void)[] {
  const opens: (() => void)[] = [];
  db.holds.set(charId, pattern.map((h) => (h ? new Promise<void>((r) => { opens.push(r); }) : null)));
  return opens;
}
/**
 * Наблюдатель инварианта «после прощания сессия не пишет»: прощание сессии (промис `removePlayer`) разрешилось «записано» — ни одна
 * запись этой сессии (`write` с её клиентом) после него не ложится.
 */
function watchFarewells(): string[] {
  const bad: string[] = [];
  const said = new WeakSet<ClientIn>();
  const origRemove = proto.removePlayer;
  const origWrite = proto.write;
  vi.spyOn(proto, 'removePlayer').mockImplementation(function (this: RoomIn, pid: string) {
    const c = this.clients.get(pid);
    const done = origRemove.call(this, pid);
    if (c) void done.then((f) => { if (f.saved) said.add(c); });
    return done;
  });
  vi.spyOn(proto, 'write').mockImplementation(async function (this: RoomIn, c: ClientIn, ...rest: unknown[]) {
    const r = await origWrite.call(this, c, ...rest);
    if (r === 'ok' && said.has(c)) bad.push(`запись сессии ${c.pid} легла после её прощания (${db.log.join(' | ')})`);
    return r;
  });
  return bad;
}

describe('⭐ R15-02: прощальная запись — последняя запись сессии', () => {
  it('город: выброс в пути, автосейв ждёт, второй выброс за ним; вход заново (вторая вкладка) — не снят по версии, старая сессия после прощания не пишет', async () => {
    const bad = watchFarewells();
    const rm = manager();
    const X = 'R15FW1';
    const [a, b] = seed(X);
    const ws1 = join(rm, X);
    await until('вход', () => ws1.frames.some((f) => f.t === 'joined'));
    const room = [...rm.rooms.values()][0]!;
    room.stop();
    await until('запись входа легла', () => !rm.inflight.size && db.chars.get(X)!.version === 2);
    db.log = [];
    // Попытки: W0 (выброс a) ждёт ворот, J1 (автосейв) — нет, третья и четвёртая — ворота (до правки: W1 — выброс b старой сессии и
    // первая запись новой; после — прощальная и первая запись новой).
    const [open0, open2, open3] = holds(X, [true, false, true, true]);
    ws1.push({ t: 'cmd', id: 1, command: { cmd: 'drop', uid: a } });
    await until('выброс a', () => !!ws1.result(1));
    await turns(10);
    void room.persistAll();                                            // автосейв, пока W0 в пути: J1 ждёт очереди (`persisting`)
    ws1.push({ t: 'cmd', id: 2, command: { cmd: 'drop', uid: b } });   // W1 — за J1
    await until('выброс b', () => !!ws1.result(2));
    await turns(10);
    // Вторая вкладка: новый вход снимает ws1 — прощальная запись его сессии.
    const ws2 = join(rm, X);
    await turns(20);
    open0!();
    // До правки прощание разрешалось с J1, и вход заново читал строку (второе чтение: первое — до ожидания прощания) раньше, чем ложился
    // W1; после — чтение ждёт прощальную (ворота 3).
    await until('вход заново прочитал строку', () => db.log.filter((l) => l.startsWith('read')).length >= 2, 60).catch(() => undefined);
    open2!();
    await until('третья попытка записи', () => db.log.filter((l) => l.startsWith('put')).length >= 3, 2_000);
    await turns(20);
    open3!();
    await until('новая сессия вошла и записалась', () => !ws2.open || (ws2.frames.some((f) => f.t === 'joined') && !rm.inflight.size), 20_000);
    await turns(100);
    expect(ws2.closedWith, `вход заново не снят как устаревший (${db.log.join(' | ')})`).toBeUndefined();
    expect(ws2.frames.some((f) => f.t === 'joined'), 'вход заново состоялся').toBe(true);
    expect(db.log.some((l) => l.includes('CONFLICT')), `ни одной записи мимо версии: ${db.log.join(' | ')}`).toBe(false);
    expect(bad, 'после прощания сессия не пишет').toEqual([]);
    const live = [...rm.rooms.values()].flatMap((r) => [...r.clients.values()]);
    expect(live.map((c) => c.saveVersion), 'живая сессия держит версию строки').toEqual([db.chars.get(X)!.version]);
    // Оба выброса — в строке: мечей в сумке нет.
    expect(db.chars.get(X)!.data.inventory.some((i) => i.uid === a || i.uid === b), 'выброшенное — не в сумке строки').toBe(false);
  });
});

describe('⭐ R15-04: хвост обрыва связи (накопленный ввод разом) не рвёт честного', () => {
  const idle = (facing = 0): Record<string, unknown> => ({ move: { x: 1, y: 0 }, facing, attack: false, cast: null, interact: false });
  /** Вошедший герой, часы монотонные — в руках теста. */
  async function playing(id: string): Promise<{ ws: FakeConn; c: () => ClientIn | undefined; tick: (ms: number) => void }> {
    const rm = manager();
    seed(id);
    const ws = join(rm, id);
    await until('вход', () => ws.frames.some((f) => f.t === 'joined'));
    const room = [...rm.rooms.values()][0]!;
    room.stop();
    await until('запись входа легла', () => !rm.inflight.size);
    const pid = (ws.frames.find((f) => f.t === 'joined') as { playerId: string }).playerId;
    let t = performance.now() + 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    return { ws, c: () => room.clients.get(pid), tick: (ms) => { t += ms; } };
  }
  let seq = 0;
  const input = (ws: FakeConn, facing = 0): void => ws.push({ t: 'input', seq: ++seq, input: idle(facing) });

  it('веб, 30 Гц: 3 с игры, 15 с обрыва — 450 кадров разом; соединение живо, свежий ввод после — в комнате', async () => {
    const { ws, c, tick } = await playing('R15IN1');
    for (let i = 0; i < 90; i++) { tick(1000 / 30); input(ws); }
    tick(15_000);
    for (let i = 0; i < 450; i++) input(ws);   // TCP отдал накопленное за 15 с разом
    expect(ws.closedWith, 'хвост обрыва не рвёт соединение').toBeUndefined();
    tick(1000 / 30);
    input(ws, 1.25);
    expect(ws.open).toBe(true);
    expect(c()?.input.facing, 'свежий ввод после хвоста — в комнате').toBe(1.25);
  });

  it('Unity, 60 Гц: 30 с обрыва (до `idleTimeout` транспорта) — 1800 кадров разом; соединение живо', async () => {
    const { ws, c, tick } = await playing('R15IN2');
    for (let i = 0; i < 120; i++) { tick(1000 / 60); input(ws); }
    tick(30_000);
    for (let i = 0; i < 1800; i++) input(ws);
    expect(ws.closedWith, 'хвост обрыва не рвёт соединение').toBeUndefined();
    for (let i = 0; i < 60; i++) { tick(1000 / 60); input(ws, 2.5); }   // (60 Гц — выше мягкого лимита 40/с: доходит не каждый кадр)
    expect(ws.closedWith).toBeUndefined();
    expect(c()?.input.facing, 'ввод идёт дальше').toBe(2.5);
  });

  it('поток ввода 1000 кадров в секунду — по-прежнему 4008 (за секунды, а не на 301-м кадре)', async () => {
    const { ws, tick } = await playing('R15IN3');
    let sent = 0;
    for (; sent < 5_000 && ws.open; sent++) { tick(1); input(ws); }
    expect(ws.closedWith, 'поток — 4008').toBe(4008);
    expect(sent, 'не на хвосте обрыва, а на потоке').toBeGreaterThan(1_800);
  });
});

describe('⭐ R15-08: забег, отпущенный комнатой, пока его вставка шла в базу, — отпускается снова', () => {
  type Hooks = { runTaken(key: string, r: unknown): void; runDropped(key: string, r: unknown): void };
  type Held = { code: string; hooks: Hooks; stop(): void };
  /** Хранилище держаний кластера: строка забега — комната; взятие ждёт ворот (вставка ложится после отпуска). */
  function store(): { locks: Map<string, string>; gate: (() => void) | null; log: string[]; api: import('./roomManager.js').RunLockStore } {
    const st = {
      locks: new Map<string, string>(), gate: null as (() => void) | null, log: [] as string[],
      api: {
        claim: async (key: string, room: string): Promise<string | null> => {
          await new Promise<void>((r) => { st.gate = r; });
          st.locks.set(key, room); st.log.push(`claim ${key}@${room}`);
          return null;
        },
        release: async (key: string, room: string): Promise<void> => {
          if (st.locks.get(key) === room) st.locks.delete(key);
          st.log.push(`release ${key}@${room}`);
        },
      },
    };
    return st;
  }

  it('взятие забега комнатой ждёт базу, комната его уже отпустила (отпуск лёг раньше вставки) — после вставки забег отпущен снова', async () => {
    const { setRunLockStore } = await import('./roomManager.js');
    const st = store();
    setRunLockStore(st.api);
    try {
      const rm = manager() as unknown as { createRoom(): Held };
      const room = rm.createRoom();
      room.stop();
      room.hooks.runTaken('run-k', room);      // вставка держания в пути
      room.hooks.runDropped('run-k', room);    // забег кончился — отпуск лёг первым (строки ещё нет)
      await turns(5);
      st.gate?.();                             // вставка легла после отпуска
      await turns(20);
      expect(st.locks.has('run-k'), `строка забега без комнаты не осталась (${st.log.join(' → ')})`).toBe(false);
    } finally { setRunLockStore(null); }
  });

  it('сердцебиение продлило отпущенный забег (`runsGone`) — менеджер отпускает его снова', async () => {
    const { setRunLockStore, clusterHooks } = await import('./roomManager.js');
    const st = store();
    setRunLockStore(st.api);
    try {
      manager();
      st.locks.set('run-g', 'GONE');             // продление вставило строку ушедшей комнаты заново
      clusterHooks.releaseRuns([{ key: 'run-g', room: 'GONE' }]);
      await turns(5);
      expect(st.locks.has('run-g'), 'отпущен снова').toBe(false);
    } finally { setRunLockStore(null); }
  });
});

/**
 * ⭐ ПЕРЕПРОГОН ФАЗЗЕРОВ ПОСЛЕ ПРАВОК РАУНДА 15 (фаззер кластера, сиды 7200355 и 7201016): R15-08 закрыл не всё.
 *  • Повторный отпуск мог не дойти (раздел ноды с базой, обрыв, ответ потерян) — сбой глушился, и строка без комнаты жила до `CLAIM_IDLE_SEC`.
 *    Теперь неудавшийся отпуск повторяет каждый удар сердца (`heldRuns`), пока он не ляжет. И взятие, чей ответ потерян (оно могло лечь), —
 *    тоже сверка, а не «сердцебиение продлит»: продлевать ушедшей комнаты нечего.
 *  • Позднее продление (или взятие) назвало прежнюю комнату ноды, а забег к тому времени взяла ДРУГАЯ её комната («Продолжить» того же героя):
 *    строка указывала на комнату, забег не держащую, до следующего удара. Теперь строка тут же переписывается на держателя.
 */
describe('⭐ перепрогон R15: строка забега сверяется с держателем, пока не сойдётся', () => {
  type Hooks = { runTaken(key: string, r: unknown): void; runDropped(key: string, r: unknown): void };
  type Held = { code: string; hooks: Hooks; stop(): void; holdsRun(key: string): boolean };
  /** Хранилище держаний: `failReleases` — столько отпусков подряд упадут (раздел с базой); `claimLost` — взятие ляжет, а ответ потеряется. */
  function store(): {
    locks: Map<string, string>; log: string[]; failReleases: number; claimLost: boolean; gate: Promise<void> | null;
    api: import('./roomManager.js').RunLockStore;
  } {
    const st = {
      locks: new Map<string, string>(), log: [] as string[], failReleases: 0, claimLost: false, gate: null as Promise<void> | null,
      api: {
        claim: async (key: string, room: string): Promise<string | null> => {
          if (st.gate) await st.gate;
          st.locks.set(key, room); st.log.push(`claim ${key}@${room}`);
          if (st.claimLost) { st.claimLost = false; throw new Error('ответ на фиксацию потерян'); }
          return null;
        },
        release: async (key: string, room: string): Promise<void> => {
          if (st.failReleases > 0) { st.failReleases--; st.log.push(`release ${key}@${room} — упал`); throw new Error('нет связи с базой'); }
          if (st.locks.get(key) === room) st.locks.delete(key);
          st.log.push(`release ${key}@${room}`);
        },
      },
    };
    return st;
  }

  it('повторный отпуск упал (нода отрезана от базы) — его повторяет удар сердца, пока не ляжет', async () => {
    const { setRunLockStore, clusterHooks } = await import('./roomManager.js');
    const st = store();
    setRunLockStore(st.api);
    try {
      const rm = manager() as unknown as { createRoom(): Held };
      const room = rm.createRoom();
      room.stop();
      let open!: () => void;
      st.gate = new Promise<void>((r) => { open = r; });
      room.hooks.runTaken('run-p', room);        // вставка держания в пути
      room.hooks.runDropped('run-p', room);      // вайп: отпуск лёг первым
      st.failReleases = 2;                       // …а раздел начался: повтор после вставки и повтор первого удара падают
      open(); st.gate = null;
      await turns(20);
      expect(st.locks.get('run-p'), `вставка легла после отпуска (${st.log.join(' → ')})`).toBe(room.code);
      clusterHooks.heldRuns(); await turns(5);   // удар в разделе — повтор снова падает
      expect(st.locks.has('run-p')).toBe(true);
      clusterHooks.heldRuns(); await turns(5);   // раздел кончился — ближайший удар отпускает
      expect(st.locks.has('run-p'), `строка без комнаты снята ударом (${st.log.join(' → ')})`).toBe(false);
      clusterHooks.heldRuns(); await turns(5);
      expect(st.log.filter((l) => l.startsWith('release')), 'лёгший отпуск больше не повторяется').toHaveLength(4);
    } finally { setRunLockStore(null); }
  });

  it('взятие легло, ответ потерян, а комната забег уже отпустила — отпуск, а не «сердцебиение продлит»', async () => {
    const { setRunLockStore } = await import('./roomManager.js');
    const st = store();
    setRunLockStore(st.api);
    try {
      const rm = manager() as unknown as { createRoom(): Held };
      const room = rm.createRoom();
      room.stop();
      let open!: () => void;
      st.gate = new Promise<void>((r) => { open = r; });
      st.claimLost = true;
      room.hooks.runTaken('run-l', room);
      room.hooks.runDropped('run-l', room);
      open(); st.gate = null;
      await turns(20);
      expect(st.locks.has('run-l'), `строка без комнаты снята (${st.log.join(' → ')})`).toBe(false);
    } finally { setRunLockStore(null); }
  });

  it('позднее продление назвало прежнюю комнату, а забег уже держит другая комната ноды — строка переписана на держателя', async () => {
    const { setRunLockStore, clusterHooks } = await import('./roomManager.js');
    const st = store();
    setRunLockStore(st.api);
    try {
      const rm = manager() as unknown as { createRoom(): Held };
      const old = rm.createRoom();
      const cur = rm.createRoom();
      old.stop(); cur.stop();
      cur.holdsRun = (key: string): boolean => key === 'run-s';   // «Продолжить» того же героя: забег взяла новая комната
      cur.hooks.runTaken('run-s', cur);
      await turns(10);
      expect(st.locks.get('run-s')).toBe(cur.code);
      st.locks.set('run-s', old.code);                              // позднее продление снимка удара легло с прежней комнатой
      clusterHooks.releaseRuns([{ key: 'run-s', room: old.code }]);
      await turns(10);
      expect(st.locks.get('run-s'), `строка — за держателем (${st.log.join(' → ')})`).toBe(cur.code);
    } finally { setRunLockStore(null); }
  });

  it('продолжение из города ждало взятие (оно легло поздно — поверх строки держателя), а забег уже у другой комнаты ноды — строка на держателя', async () => {
    const { setRunLockStore } = await import('./roomManager.js');
    const st = store();
    setRunLockStore(st.api);
    try {
      const rm = manager() as unknown as { createRoom(): Held };
      const old = rm.createRoom();
      const cur = rm.createRoom();
      old.stop(); cur.stop();
      cur.holdsRun = (key: string): boolean => key === 'run-d';   // «Продолжить» героя: забег взяла новая комната
      cur.hooks.runTaken('run-d', cur);
      await turns(10);
      st.locks.set('run-d', old.code);                              // взятие прежней комнаты (R9-01, `runClaim`) легло поздно, поверх
      old.hooks.runDropped('run-d', old);                           // её продолжения нет (все ушли) — «взятое на ожидание назад»
      await turns(10);
      expect(st.locks.get('run-d'), `строка — за держателем, а не за ушедшей (${st.log.join(' → ')})`).toBe(cur.code);
    } finally { setRunLockStore(null); }
  });
});
