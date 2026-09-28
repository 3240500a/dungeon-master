import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { MAX_FRAME_BYTES } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, clientFrameSchema, validateInput, shopBuyPrice, ATTRIBUTES, stashDims, emptyStash,
  generateItem, createRng, addToInventory, materialItem, uuidv7,
  type SaveState, type Item, type TownCommand,
} from '@dm/shared';
import { counters } from './metrics.js';
import { limits, known, ipBucket } from './rateLimit.js';
import { sessionKey } from './authSession.js';
import { Prng, mutateFrame, junkText, junkBytes, shrinkOps } from './protocolFuzz.frames.js';

/**
 * ⭐ B3 — ФАЗЗЕР ПРОТОКОЛА. Вместо разбора правок по одной — модель: несколько соединений (честные с героями в комнатах,
 * соседняя вкладка того же аккаунта, чужой аккаунт за тем же NAT, анонимы), случайная по сиду последовательность операций и
 * ИНВАРИАНТЫ ПОСЛЕ КАЖДОЙ. Всё настоящее: транспорт uWS (`gameWsBehavior`: двоичные кадры, закрытие), менеджер комнат (`accept`,
 * лимиты, очереди, лобби), комнаты и ядро (`handleCmd`, голосования, забег). База — маленькая честная (версии сейва и сундука,
 * кодировка как у Postgres), часы — виртуальные, случайность — по сиду (крипто и `Math.random` подменены): прогон по сиду
 * повторяется, и нарушение ужимается выбросом операций до минимальной последовательности.
 *
 * ИНВАРИАНТЫ:
 *  I1 — ничего не бросает из транспорта, `accept`, `handleCmd`: ни `frameErrors`, ни `cmdFailed`, ни `console.error`, ни
 *       необработанного отказа промиса; база не отвергает ни одной записи по кодировке (мусор с провода не доехал до сейва).
 *  I2 — кривой кадр (не проходит договор протокола) не меняет ни сейвов, ни сундука, ни состояния комнат; отказанная команда
 *       не меняет экономики героя (золото, вещи, сырьё, сундук).
 *  I3 — мусор одного соединения не закрывает, не упирает в лимит и не запирает другое честное (с того же адреса, того же
 *       аккаунта — кроме документированных лимитов АККАУНТА).
 *  I4 — исходящее на входящий кадр ограничено: кривой кадр — не больше пары маленьких кадров; сейв в ответ на отказ — только в
 *       меру `limits.cmdResync`.
 *  I5 — честные кадры в честном темпе принимаются всегда: у каждого — свой ответ, не «часто», не «неверно», не «занято».
 *  I6 — после закрытия соединений карты на соединение и на адрес подметены: ни очередей, ни бакетов, ни комнат без людей; через
 *       11 минут простоя пусты и все лимитеры (рост ограничен временем, а не числом соединений).
 *  I7 — ни одна вещь (uid) не живёт в двух местах сразу (герои, сундуки, земля); золото — целое ≥ 0.
 *  I8 — застрявших нет: после последовательности каждый вошедший герой входит снова («Продолжить» или новая комната).
 *  I9 — закрытое соединение не действует: закрытое сервером не остаётся игроком и его кадры вдогонку ничего не меняют; ⭐ C-06: закрытое
 *       клиентом снимается с игры сразу, по событию закрытия, а не в конце очереди своих кадров.
 * HTTP-ручки аккаунта — свой блок в конце файла (H1–H4).
 *
 * МОДЕЛЬ. Сценарии: «смесь» (честный один или с другом, соседняя вкладка аккаунта, чужие аккаунты, анонимы, мусор всех видов) и
 * «пати с чужими» (в комнате честного — его вторая вкладка другим героем или тем же героем-«двойником», чужой аккаунт; упор на обмен
 * вещами). Транспорт — настоящий uWS (`gameWsBehavior`) или повторение `ws` (закрытие — рукопожатием позже, двоичный кадр — текстом),
 * медленные читатели (1013). База отвечает с задержкой в обороты цикла, а часть операций — «гонки» (не ждут базы): кадры разных
 * соединений перемешиваются с ожиданием записей; инварианты судятся в тишине.
 *
 * ПЕРЕМЕННЫЕ: прогон по умолчанию — фиксированный набор сидов (укладывается в минуту полного прогона); `DM_FUZZ_SEEDS=N` — N сидов
 * (`DM_FUZZ_FROM` — с какого), `DM_FUZZ_OPS` — длина последовательности, `DM_FUZZ_HTTP_SEEDS`/`DM_FUZZ_HTTP_FROM` — то же для HTTP,
 * `DM_FUZZ_STATS=1` — покрытие (исходы кадров) и время, `DM_FUZZ_TRACE=1` — след операций, `DM_FUZZ_REPLAY=<файл.json>` — повтор
 * ужатой последовательности, `DM_FUZZ_SELFTEST=<имя>` — самопроверка (фаззер обязан найти внесённый дефект), `DM_FUZZ_SHRINK=1` —
 * ужимать и известные. Нарушение печатается с сидом и УЖАТОЙ последовательностью.
 */

// Прогон — сотни последовательностей по оборотам цикла (`setImmediate`), а не по часам; потолок — только от зависания.
vi.setConfig({ testTimeout: 60 * 60_000, hookTimeout: 60_000 });

// ── База, реестр, планировщик, случайность ──────────────────────────────────
// Потолок неотправленного — наименьший допустимый (64 КБ, `conn.ts`): медленный читатель упирается в него за пару кадров, и путь
// «закрыть посреди рассылки» (1013) идёт в каждой такой последовательности. Ставится до импорта `conn.ts`.
vi.hoisted(() => { process.env.DM_MAX_BACKPRESSURE = String(64 * 1024); });
const db = vi.hoisted(() => ({
  sessions: new Map<string, string>(),
  chars: new Map<string, { userId: string; data: unknown; version: number }>(),
  stash: new Map<string, { data: unknown; version: number }>(),
  /** Записи, которые «база» отвергла по кодировке (U+0000, непарный суррогат): мусор с провода доехал до сейва (R3-02). */
  pgRejects: [] as string[],
  /**
   * ЗАДЕРЖКА БАЗЫ в оборотах цикла (`setImmediate`): запрос исполняется через `lat()` оборотов, ответ приходит ещё через `lat()`.
   * Ноль — база «мгновенная» (всё решается микрозадачами); иначе кадры других соединений успевают вклиниться в ожидание базы.
   */
  lat: (): number => 0,
  /** Запросов в полёте — прогон ждёт тишины (`quiesce`), прежде чем судить инварианты. */
  pending: 0,
  /** HTTP-часть: аккаунты по нику (без регистра) и журнал того, что ручки аккаунта в базе создали и удалили. */
  users: new Map<string, { id: string; username: string; passHash: string; passSalt: string; net: string }>(),
  mut: [] as string[],
}));
/** Поток случайных чисел для подменённого `node:crypto` — свой у каждой последовательности (по сиду). */
const rnd = vi.hoisted(() => ({ next: (): number => Math.random() }));
/** Комнаты «на тике»: планировщик подменён, тик делает сам фаззер (операция `tick`). */
const sched = vi.hoisted(() => ({ rooms: new Set<{ step(emit: boolean): void }>() }));

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const fill = (b: Uint8Array): void => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd.next() * 256); };
  return {
    ...real,
    default: real,
    randomInt: (a: number, b?: number): number => {
      const lo = b === undefined ? 0 : a;
      const hi = b === undefined ? a : b;
      return lo + Math.floor(rnd.next() * (hi - lo));
    },
    randomBytes: (n: number): Buffer => { const b = Buffer.alloc(n); fill(b); return b; },
    randomFillSync: <T extends ArrayBufferView>(buf: T): T => { fill(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); return buf; },
    randomUUID: (): string => {
      const b = new Uint8Array(16);
      fill(b);
      b[6] = 0x40 | (b[6]! & 0x0f);
      b[8] = 0x80 | (b[8]! & 0x3f);
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
});
vi.mock('../db/db.js', () => {
  /** Снимок как у настоящей записи (`snapshotOf`): JSON, а не structuredClone — функция в сейве уйдёт `null`, а не броском. */
  const snap = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown;
  /** Как Postgres с jsonb (R3-02): U+0000 — 22P05, непарный суррогат — 22P02. */
  const pgJson = (what: string, v: unknown): void => {
    const json = JSON.stringify(v);
    const nul = /\\u0000/.test(json);
    if (nul || /\\ud[89a-f][0-9a-f]{2}/i.test(json)) {
      db.pgRejects.push(what);
      throw Object.assign(new Error('invalid input syntax for type json'), { code: nul ? '22P05' : '22P02' });
    }
  };
  /** Байт 0x00 в текстовом параметре — 22021. */
  const pgText = (s: string): void => {
    if (s.includes(String.fromCharCode(0))) throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
  };
  const turns = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };
  /** Запрос с задержкой: `run` исполняется в «базе» через `lat()` оборотов, ответ — ещё через `lat()`. */
  const q = async <T>(run: () => T): Promise<T> => {
    db.pending++;
    try {
      await turns(db.lat());
      const out = run();
      await turns(db.lat());
      return out;
    } finally { db.pending--; }
  };
  return {
    getRunLedger: () => q(() => []),
    mergeRunLedger: () => q(() => undefined),
    getSession: (token: string) => q(() => { pgText(token); return db.sessions.get(token) ?? null; }),
    getCharacter: (charId: string) => q(() => {
      pgText(charId);
      const r = db.chars.get(charId);
      return r ? { userId: r.userId, data: snap(r.data), version: r.version } : null;
    }),
    putCharacter: (charId: string, userId: string, data: unknown, v: number) => {
      const s = snap(data);   // снимок — в момент вызова, как `snapshotOf`
      return q(() => {
        pgJson(`сейв ${charId}`, s);
        const r = db.chars.get(charId);
        if (!r || r.userId !== userId || r.version !== v) return null;
        r.version = v + 1; r.data = s;
        return r.version;
      });
    },
    landedVersion: () => q(() => null),
    putCharacterWithStash: (charId: string, userId: string, data: unknown, v: number, stash: unknown, sv: number) => {
      const s = snap(data), st = snap(stash);
      return q(() => {
        pgJson(`сейв ${charId}`, s);
        pgJson(`сундук ${userId}`, st);
        const r = db.chars.get(charId);
        if (!r || r.userId !== userId || r.version !== v) return { ok: false, conflict: 'save' };
        if ((db.stash.get(userId)?.version ?? 0) !== sv) return { ok: false, conflict: 'stash' };
        r.version = v + 1; r.data = s;
        db.stash.set(userId, { data: st, version: sv + 1 });
        return { ok: true, version: r.version, stashVersion: sv + 1 };
      });
    },
    getAccountStash: (userId: string) => q(() => {
      const r = db.stash.get(userId);
      return r ? { data: snap(r.data), version: r.version } : null;
    }),
    putAccountStash: (userId: string, data: unknown) => {
      const d = snap(data);
      return q(() => { db.stash.set(userId, { data: d, version: (db.stash.get(userId)?.version ?? 0) + 1 }); });
    },
    // ── Ручки аккаунта (HTTP-часть фаззера) ──
    createUser: (username: string, passHash: string, passSalt: string, _ip?: string, net?: string) => q(() => {
      pgText(username);
      const id = `u-${username.toLowerCase()}`;
      db.users.set(username.toLowerCase(), { id, username, passHash, passSalt, net: net ?? '' });
      db.mut.push(`createUser ${id}`);
      return id;
    }),
    getUserByName: (username: string) => q(() => { pgText(username); return db.users.get(username.toLowerCase()) ?? null; }),
    getUserById: (id: string) => q(() => [...db.users.values()].find((u) => u.id === id) ?? null),
    createSession: (userId: string) => q(() => {
      let t = '';
      for (let i = 0; i < 32; i++) t += Math.floor(rnd.next() * 256).toString(16).padStart(2, '0');
      db.sessions.set(t, userId);
      db.mut.push(`createSession ${userId}`);
      return t;
    }),
    deleteSession: (token: string) => q(() => {
      pgText(token);
      const u = db.sessions.get(token);
      if (u) db.mut.push(`deleteSession ${u}`);
      return db.sessions.delete(token);
    }),
    deleteSessionsOfUser: (userId: string) => q(() => {
      let n = 0;
      for (const [t, u] of db.sessions) if (u === userId) { db.sessions.delete(t); n++; }
      db.mut.push(`deleteSessionsOfUser ${userId}`);
      return n;
    }),
    countRecentRegistrations: (net: string) => q(() => [...db.users.values()].filter((u) => u.net === net).length),
    listCharacters: (userId: string) => q(() => [...db.chars].filter(([, r]) => r.userId === userId).map(([charId, r]) => ({ charId, name: (r.data as { name?: string }).name }))),
    createCharacter: (charId: string, userId: string, data: unknown, max?: number) => q(() => {
      pgText(charId);
      pgJson(`герой ${charId}`, data);
      if (max !== undefined && [...db.chars.values()].filter((r) => r.userId === userId).length >= max) return null;
      db.chars.set(charId, { userId, data: snap(data), version: 1 });
      db.mut.push(`createCharacter ${userId}`);
      return 1;
    }),
    deleteCharacter: (charId: string, userId: string) => q(() => {
      pgText(charId);
      const r = db.chars.get(charId);
      if (r && r.userId === userId) { db.chars.delete(charId); db.mut.push(`deleteCharacter ${userId}`); }
    }),
    countCharacters: (userId: string) => q(() => [...db.chars.values()].filter((r) => r.userId === userId).length),
    listLiveSessions: () => q(() => [...db.sessions].map(([token, userId]) => ({ token, userId }))),
    listUsernames: () => q(() => [...db.users.keys()]),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));
vi.mock('./scheduler.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./scheduler.js')>();
  return {
    ...real,
    tickScheduler: {
      add: (r: { step(emit: boolean): void }) => { sched.rooms.add(r); },
      remove: (r: { step(emit: boolean): void }) => { sched.rooms.delete(r); },
      has: (r: { step(emit: boolean): void }) => sched.rooms.has(r),
      get size() { return sched.rooms.size; },
      stop: () => { sched.rooms.clear(); },
      droppedTicks: 0,
    },
  };
});

// ── Внутренности, до которых дотягивается проверка (это тест) ────────────────
type Pt = { x: number; y: number };
type PlayerIn = { id: string; save: SaveState; pos: Pt; hp: number; alive: boolean };
type ClientIn = { ws: GameConn; input: { dodge?: boolean; cast: string | null; useBelt?: number }; userId: string; saveVersion: number };
type RoomIn = {
  code: string; area: 'town' | 'dungeon' | 'arena'; depth: number; runNodeId: string | null; movedAt: number; frozen: boolean;
  vote: { kind: string; by: string; yes: Set<string>; no: Set<string> } | null;
  clients: Map<string, ClientIn>; disconnected: Map<string, { save: SaveState }>; lingering: Map<string, { p: PlayerIn }>;
  peerSent: Map<string, string>; staleFarewells: Map<string, unknown>;
  shop: Item[]; consumables: Item[]; questBoard: { id: string }[]; nodeState: unknown;
  graceTimer: ReturnType<typeof setTimeout> | null;
  session: {
    world: {
      players: Record<string, PlayerIn>;
      drops: { id: number; item?: Item; pos: Pt; owner?: string }[];
      levers: { id: number; pos: Pt; used?: boolean }[]; chests: { id: number; pos: Pt; opened?: boolean }[];
      exits?: Pt[]; spawn: Pt;
    };
  };
  step(emit: boolean): void; stop(): void; expireGrace(): void;
};
type RMIn = {
  rooms: Map<string, RoomIn>; conns: Map<GameConn, { pid: string; room: RoomIn }>; live: Map<string, GameConn>;
  graceByChar: Map<string, RoomIn>; inputRate: Map<GameConn, unknown>; charOps: Map<string, unknown>;
  sessionLookups: Map<string, unknown>; leaving: Map<string, unknown>; inflight: Map<string, unknown>; unsaved: Map<string, unknown>;
  farewellSeq: Map<string, unknown>; unsavedBackoff: Map<string, unknown>; unsavedRetrying: Set<string>;
  connKeys: WeakMap<GameConn, string>;
  handleConnection(ws: GameConn): void;
  retryUnsaved(now?: number): Promise<void>;
};
type Behavior = {
  open(ws: FakeUwsSocket): void;
  message(ws: FakeUwsSocket, msg: ArrayBuffer, isBinary: boolean): void;
  close(ws: FakeUwsSocket, code?: number, msg?: ArrayBuffer): void;
};
/** Внутренности лимитера: карта бакетов (у `NetLimiter` — ступени). */
const bucketsOf = (l: unknown): Map<string, unknown>[] => {
  const t = (l as { tiers?: unknown[] }).tiers;
  return t ? t.map((x) => (x as { buckets: Map<string, unknown> }).buckets) : [(l as { buckets: Map<string, unknown> }).buckets];
};
const keysOf = (l: unknown): string[] => bucketsOf(l).flatMap((m) => [...m.keys()]);

// ── Модель: аккаунты, роли, адреса ──────────────────────────────────────────
type Role = 'honest' | 'sibling' | 'attacker' | 'anon';
type Mode = 'uws' | 'ws';
interface Acct { user: string; token: string; heroes: readonly string[] }
const tok = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
/** Токен правильного вида, которого в базе нет. */
const TOK_UNKNOWN = 'ee'.repeat(32);
const ACCTS: Record<string, Acct> = {
  h1: { user: 'u-h1', token: tok(0x11), heroes: ['h1'] },
  /** Вторая сессия ТОГО ЖЕ аккаунта (вторая вкладка, альт): её лимиты аккаунта — общие с честным `h1`. */
  h1b: { user: 'u-h1', token: tok(0x12), heroes: ['h1b'] },
  /** Вторая вкладка ТОГО ЖЕ героя честного (сценарий «двойник»): её вход по праву вытесняет его сессию (4001, Ф0.3). */
  h1t: { user: 'u-h1', token: tok(0x13), heroes: ['h1'] },
  h2: { user: 'u-h2', token: tok(0x21), heroes: ['h2'] },
  a: { user: 'u-a', token: tok(0xa1), heroes: ['a1', 'a1b'] },
  a2: { user: 'u-a2', token: tok(0xa2), heroes: ['a2'] },
};
/** Слоты соединений: 0, 1 — честные; 2 — соседняя сессия аккаунта честного; 3, 4 — чужие аккаунты; 5–7 — анонимы. */
const SLOT_ROLE: readonly Role[] = ['honest', 'honest', 'sibling', 'attacker', 'attacker', 'anon', 'anon', 'anon'];
const SLOT_ACCT: readonly (Acct | null)[] = [ACCTS.h1!, ACCTS.h2!, ACCTS.h1b!, ACCTS.a!, ACCTS.a2!, null, null, null];
/** Адреса: общий NAT (честный, сосед, тролль), другой адрес, IPv6, без адреса. */
const IPS = ['198.51.100.7', '203.0.113.9', '2001:db8:1:2::77', ''] as const;
/** Адрес по номеру: первые четыре — `IPS`, дальше — каждый свой (IPv4 и IPv6 в своих /48): рост карт «на адрес» (I6). */
const ipOf = (i: number): string => (i < IPS.length ? IPS[i]! : i % 2 ? `2001:db8:${(i & 0xffff).toString(16)}::${(i >> 16) + 1}` : `192.0.2.${i % 250}`);

type FrameKind = 'join' | 'joinCode' | 'resume' | 'runStatus' | 'abandon' | 'cmd' | 'input' | 'ping' | 'descend' | 'vote'
  | 'lever' | 'chest' | 'arena' | 'return' | 'leave';
const FRAME_KINDS: readonly (readonly [number, FrameKind])[] = [
  [25, 'cmd'], [20, 'input'], [10, 'join'], [5, 'joinCode'], [4, 'resume'], [6, 'runStatus'], [3, 'abandon'], [6, 'ping'],
  [6, 'descend'], [4, 'vote'], [2, 'lever'], [2, 'chest'], [2, 'arena'], [2, 'return'], [3, 'leave'],
];
type CmdKind = TownCommand['cmd'];
const CMD_KINDS: readonly CmdKind[] = [
  'buy', 'sell', 'forgeUpgrade', 'forgeReroll', 'forgeSalvage', 'forgeRepair', 'craft', 'forgeEnchant', 'forgeSketch', 'depositMaterials',
  'salvage', 'equip', 'unequip', 'allocAttr', 'respec', 'respecPassives', 'respecSkills', 'allocPassive', 'allocSkill', 'socketInsert',
  'socketClear', 'useConsumable', 'moveBelt', 'moveItem', 'stashOpen', 'stashMove', 'bind', 'pickup', 'drop', 'acceptQuest', 'turnInQuest',
];
/** Честные команды — те, что шлют клиенты по клику человека (без ковки: у неё свой темп и свой тест). */
const HONEST_CMDS: readonly (readonly [number, CmdKind])[] = [
  [8, 'bind'], [8, 'moveItem'], [5, 'allocAttr'], [6, 'stashOpen'], [4, 'stashMove'], [4, 'unequip'], [4, 'equip'], [4, 'buy'],
  [3, 'sell'], [3, 'drop'], [3, 'pickup'], [2, 'useConsumable'], [2, 'moveBelt'], [3, 'acceptQuest'], [1, 'respec'],
  [1, 'depositMaterials'], [1, 'forgeRepair'], [1, 'salvage'],
];

type HonestAct =
  | { a: 'enter'; p: number } | { a: 'joinFriend' } | { a: 'ping' } | { a: 'runStatus' } | { a: 'leave' }
  | { a: 'input'; n: number; hz: 30 | 60; press: 0 | 1 | 2 | 3; mv: number }
  | { a: 'cmd'; cmd: CmdKind; pick: number }
  | { a: 'descend'; alt: boolean } | { a: 'return' } | { a: 'arena' } | { a: 'lever' } | { a: 'chest' }
  | { a: 'reconnect'; mode: Mode; p: number }
  | { a: 'flap'; mode: Mode; p: number };
type Junk =
  | { j: 'mutate'; base: FrameKind; seed: number }
  | { j: 'text'; seed: number; len: number }
  | { j: 'binary'; seed: number; len: number }
  | { j: 'oversize'; seed: number; len: number }
  | { j: 'flood'; base: FrameKind; n: number; seed: number; mutate: boolean }
  | { j: 'valid'; base: FrameKind; seed: number }
  | { j: 'foreign'; what: 'join' | 'runStatus' | 'abandon'; seed: number }
  | { j: 'cmd'; cmd: CmdKind; pick: number; seed: number };
type Op =
  | { k: 'open'; s: number; mode: Mode; ip: number; slow?: true; twin?: true }
  | { k: 'close'; s: number; race?: true }
  | { k: 'honest'; s: number; act: HonestAct; race?: true }
  | { k: 'junk'; s: number; junk: Junk; race?: true }
  | { k: 'wait'; ms: number }
  | { k: 'tick'; n: number }
  | { k: 'wsClose' }
  | { k: 'expire' };

interface Violation {
  /** Ключ для отбора одинаковых: инвариант и вид (без чисел и id). */
  key: string;
  inv: string;
  detail: string;
  op: number;
}

// ── Транспорт ────────────────────────────────────────────────────────────────
/** Кадр, полученный клиентом: тип, размер, разобранный JSON (для маленьких). */
interface Got { t: string; bytes: number; f?: Record<string, unknown>; op: number }

/** Сокет uWS для настоящего `gameWsBehavior`: `end`/`close` зовут обработчик закрытия сразу — как uWS. */
class FakeUwsSocket {
  closed = false;
  constructor(readonly h: Run, readonly slot: SlotRt, readonly ip: string) {}
  getRemoteAddressAsText(): ArrayBuffer { return new TextEncoder().encode(this.ip).buffer as ArrayBuffer; }
  getUserData(): { ip?: string; pass?: string } { return { ip: this.ip }; }
  send(data: string | ArrayBufferView): number {
    if (this.closed) throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.');
    this.h.record(this.slot, data);
    if (this.slot.slow) this.slot.buffered += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    return 1;
  }
  /** Медленный читатель (`slow`) не читает вовсе: очередь только растёт. */
  getBufferedAmount(): number { return this.slot.slow ? this.slot.buffered : 0; }
  end(code?: number): void {
    if (this.closed) throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.');
    this.closed = true;
    if (!this.slot.clientClosing) this.slot.serverClosed = code ?? 1000;
    this.h.behavior.close(this, code ?? 1000, new ArrayBuffer(0));
  }
  close(): void { this.end(1006); }
}

/**
 * Сокет библиотеки `ws` под НАСТОЯЩЕЙ обёрткой транспорта (`WsConn`, `wsServer.ts`): закрытие сервером — только начало рукопожатия
 * (`CLOSING`: кадры клиента библиотека отдаёт и дальше, событие `close` — позже, операцией `wsClose`: клиент ответил или вышел
 * `closeTimeout`); обрыв клиентом — событие сразу; двоичный кадр библиотека отдаёт буфером, обёртка — текстом (`Buffer.toString`);
 * медленный читатель (`slow`) копит `bufferedAmount`, и обёртка закрывает его сама (1013). Раньше здесь жила копия обёртки — и фаззер
 * проверял копию: правка транспорта (B3-V1, B3-V2) её не касалась.
 */
class FakeWsSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  constructor(readonly h: Run, readonly slot: SlotRt) { super(); }
  get bufferedAmount(): number { return this.slot.slow ? this.slot.buffered : 0; }
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    this.h.record(this.slot, data);
    if (this.slot.slow) this.slot.buffered += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  }
  close(code?: number): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    if (!this.slot.clientClosing) this.slot.serverClosed = code ?? 1000;
    this.h.pendingWsClose.add(this);
  }
  /** Кадр клиента: библиотека отдаёт его, пока не пришло событие `close` (и в `CLOSING` тоже). */
  deliver(data: Buffer): void {
    if (this.readyState === 3) return;
    try { this.emit('message', data); } catch (e) { this.h.violate('I1', 'бросок из обработчика кадра (ws)', String(e)); }
  }
  /** Событие закрытия транспорта (рукопожатие кончилось, обрыв, ошибка). */
  end(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.h.pendingWsClose.delete(this);
    this.emit('close');
  }
}

interface SlotRt {
  n: number; role: Role; acct: Acct | null; mode: Mode; ip: string;
  conn: GameConn; sock?: FakeUwsSocket; ws?: FakeWsSocket;
  frames: Got[];
  clientClosing: boolean;
  /** Код, которым сокет закрыл сервер (транспорт или игра). */
  serverClosed?: number;
  gone: boolean;
  cmdId: number; seq: number; pingId: number;
  nextAt: number;
  /** Голосование (объект комнаты), на которое честный уже ответил. */
  voted?: object;
  /** Закрытие сервером уже разобрано (одно нарушение на закрытие). */
  closeJudged?: boolean;
  /** Честный послал «выйти» и ещё не входил заново. */
  leaving?: boolean;
  /** I9 по этому соединению уже отмечен. */
  zombieJudged?: boolean;
  /** Медленный читатель: исходящее копится (`buffered`), пока транспорт не закроет сокет (1013). */
  slow: boolean;
  buffered: number;
}

let RoomManagerCtor: new (cfg: ConfigRegistry) => unknown;
let RoomProto: Record<string, (...a: unknown[]) => unknown>;
let gameWsBehavior: (u: { DISABLED: number }, onConn: (c: GameConn) => void) => Record<string, unknown>;
/** Настоящая обёртка транспорта `ws` (B3-V1, B3-V2). */
let WsConnCtor: new (ws: WebSocket, ip: string) => GameConn;
let cfg: ConfigRegistry;
const DATE0 = Date.UTC(2026, 8, 1);
/** Виртуальные часы (мс) — монотонные на весь файл: каждая последовательность начинается через час после прошлой. */
let clock = 1_000_000;
const unhandled: string[] = [];
const onUnhandled = (e: unknown): void => { unhandled.push(String(e instanceof Error ? e.stack ?? e.message : e)); };

beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js') as unknown as { RoomManager: typeof RoomManagerCtor });
  ({ gameWsBehavior } = await import('./uwsServer.js') as unknown as { gameWsBehavior: typeof gameWsBehavior });
  ({ WsConn: WsConnCtor } = await import('./wsServer.js') as unknown as { WsConn: typeof WsConnCtor });
  RoomProto = (await import('./room.js')).Room.prototype as unknown as typeof RoomProto;
  cfg = new ConfigRegistry();
  cfg.loadAll();
  process.on('unhandledRejection', onUnhandled);
});
afterAll(() => { process.off('unhandledRejection', onUnhandled); });

/** Оборот цикла без часов: `setImmediate` не ждёт шага системного таймера (на Windows setTimeout(0) — это ~15 мс). */
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── Оракул договора протокола ────────────────────────────────────────────────
/**
 * Годен ли кадр по ДОГОВОРУ протокола (`clientFrameSchema` + ручные проверки горячего пути). Годен — сервер вправе его исполнить;
 * не годен — не вправе ничего менять (I2). `seq` ввода сервер не читает (горячий путь) — договор его не спрашивает; номер пинга —
 * безопасное целое (эхо, R2-01); номер команды — безопасное целое ≥ 0 (`cmdIdOf`).
 */
function contractValid(raw: string): boolean {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return false; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  const o = j as Record<string, unknown>;
  if (o.t === 'input') return validateInput(o.input) !== null;
  if (o.t === 'ping') return typeof o.id === 'number' && Number.isSafeInteger(o.id);
  if (!clientFrameSchema.safeParse(j).success) return false;
  if (o.t === 'cmd' && o.id !== undefined && !(typeof o.id === 'number' && Number.isSafeInteger(o.id) && o.id >= 0)) return false;
  return true;
}

/** Экономика героя — то, что отказанная команда менять не вправе (I2). */
function econ(s: SaveState | undefined): string {
  if (!s) return '-';
  return JSON.stringify({
    gold: s.gold, level: s.level, xp: s.xp,
    inv: s.inventory.map((i) => [i.uid, i.count ?? 1, !!i.broken, i.rarity, i.itemLevel, i.affixes?.length ?? 0, i.rerolls ?? 0]),
    eq: Object.entries(s.equipment ?? {}).map(([k, v]) => [k, v?.uid ?? null, !!v?.broken, v?.affixes?.length ?? 0]),
    belt: (s.belt ?? []).map((b) => b?.uid ?? null), stash: (s.stash ?? []).map((i) => i.uid),
    mats: s.materials ?? {}, attrs: s.attributes, pts: [s.unspentAttributePoints, s.unspentSkillPoints, s.unspentMasteryPoints],
    skills: s.skills, masteries: s.masteries, sockets: s.sockets ?? {},
  });
}

/** Отказы, которые честный кадр получать не должен (I3/I5). */
const LIMIT_REASONS = new Set(['Слишком часто', 'Неверная команда', 'Ошибка сервера, попробуйте ещё раз', 'Команда уже получена', 'Нет персонажа']);
/** Отказ голосования по паузе после перехода — правило игры (`voteAllowed`), а не лимит. */
const VOTE_COOLDOWN_MSG = 'Подождите немного';

// ── Один прогон последовательности ──────────────────────────────────────────
class Run {
  rm!: RMIn;
  behavior!: Behavior;
  slots: (SlotRt | undefined)[] = [];
  pendingWsClose = new Set<FakeWsSocket>();
  violations: Violation[] = [];
  errors: string[] = [];
  opIndex = -1;
  /** Байты и кадры, ушедшие клиентам за текущую операцию (кроме тика). */
  opOut = { bytes: 0, frames: [] as { slot: number; t: string; bytes: number }[] };
  ticking = false;
  /** Была ли активность «чужих» слотов (мусор, соседняя сессия), и когда в последний раз — сосед аккаунта. */
  junkSeen = false;
  siblingAt = -Infinity;
  /** I4: теневой бакет `cmdResync` (5 подряд, 1/с) на аккаунт — сколько сейвов в ответ на отказ сервер вправе прислать. */
  resyncShadow = new Map<string, { tokens: number; at: number }>();
  counters0 = { frameErrors: 0, cmdFailed: 0 };
  unhandled0 = 0;
  /** Статистика усиления: вид кадра → [кадров, байт входа, байт выхода]. */
  amp = new Map<string, [number, number, number]>();
  /** Покрытие: честный кадр → исход (для отчёта `DM_FUZZ_STATS=1`). */
  stats = new Map<string, number>();
  note(frame: Record<string, unknown>, got: Got[], who: string): void {
    const res = got.find((g) => g.t === 'cmdResult')?.f;
    const err = got.find((g) => g.t === 'error')?.f;
    const key = frame.t === 'cmd'
      ? `${who} cmd:${String((frame.command as { cmd?: unknown } | undefined)?.cmd)} ${res ? (res.ok ? 'ok' : `x ${String(res.reason)}`) : '-'}`
      : `${who} ${String(frame.t)} -> ${err ? `error:${String(err.code)}` : [...new Set(got.map((g) => g.t))].slice(0, 3).join(',') || '-'}`;
    this.stats.set(key, (this.stats.get(key) ?? 0) + 1);
  }
  private restore: (() => void)[] = [];

  constructor(readonly seed: number) {}

  get now(): number { return clock; }

  /** Поднять мир последовательности: база, лимиты, часы, случайность, менеджер и транспорт. */
  setup(): void {
    const envRng = new Prng(this.seed ^ 0xc0ffee);
    rnd.next = () => envRng.next();
    // База: треть последовательностей — мгновенная, прочие — с задержкой 0–1 или 0–4 оборота на запрос и на ответ.
    const latRng = new Prng(this.seed ^ 0x1a7e);
    const lat = latRng.int(3);
    db.lat = lat === 0 ? () => 0 : () => latRng.int(lat === 1 ? 2 : 5);
    db.pending = 0;
    const mathRng = new Prng(this.seed ^ 0xbeef);
    const sMath = vi.spyOn(Math, 'random').mockImplementation(() => mathRng.next());
    clock += 3_600_000;
    const sPerf = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const sDate = vi.spyOn(Date, 'now').mockImplementation(() => DATE0 + clock);
    const log = (kind: string) => (...a: unknown[]): void => {
      if (kind === 'error') this.errors.push(a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 400));
    };
    const sErr = vi.spyOn(console, 'error').mockImplementation(log('error'));
    const sWarn = vi.spyOn(console, 'warn').mockImplementation(log('warn'));
    const sLog = vi.spyOn(console, 'log').mockImplementation(log('log'));
    this.restore.push(() => { sMath.mockRestore(); sPerf.mockRestore(); sDate.mockRestore(); sErr.mockRestore(); sWarn.mockRestore(); sLog.mockRestore(); });
    // Лимиты процесса — с чистого листа (они модульные: живут между последовательностями).
    for (const l of Object.values(limits)) for (const m of bucketsOf(l)) m.clear();
    for (const k of [...(known.sessions as unknown as { seen: Map<string, unknown> }).seen.keys()]) known.sessions.delete(k);
    db.sessions.clear(); db.chars.clear(); db.stash.clear(); db.pgRejects.length = 0;
    sched.rooms.clear();
    // Сессии аккаунтов «вошли через этот процесс» (HTTP-вход кладёт их в `known.sessions`, R10-04).
    const gear = new Prng(this.seed ^ 0x9ea5);
    for (const a of Object.values(ACCTS)) {
      db.sessions.set(a.token, a.user);
      known.sessions.add(sessionKey(a.token), a.user);
      for (const id of a.heroes) {
        if (db.chars.has(id)) continue;   // герой двойника — тот же герой
        const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, id, id) as SaveState;
        s.gold = 3000;
        s.unspentAttributePoints = 5;
        // Сумка не пустая: снаряжение, зелья, сырьё — командам есть над чем работать (и что задвоить).
        for (let i = 0; i < 3; i++) addToInventory(s.inventory, fuzzItem(gear, 'gear'), cfg.get('balance').inventory);
        for (let i = 0; i < 3; i++) addToInventory(s.inventory, fuzzItem(gear, 'consumable'), cfg.get('balance').inventory);
        const mat = cfg.get('craft-materials').find((m) => m.enabled !== false);
        if (mat) addToInventory(s.inventory, materialItem(mat, 5, uuidv7()), cfg.get('balance').inventory, cfg.get('balance').inventory.materialStack);
        db.chars.set(id, { userId: a.user, data: s, version: 1 });
      }
      if (!db.stash.has(a.user)) {
        const st = emptyStash(cfg);
        const d = stashDims(cfg);
        for (let i = 0; i < 2; i++) {
          const it = fuzzItem(gear, 'gear');
          const at = { x: (i * 3) % d.cols, y: 0 };
          it.pos = at;
          (st.tabs[0] ??= []).push(it);
        }
        db.stash.set(a.user, { data: st, version: 1 });
      }
    }
    this.counters0 = { frameErrors: counters.frameErrors, cmdFailed: counters.cmdFailed };
    this.unhandled0 = unhandled.length;
    // Фоновая дописка копий (R3-19) — по своему таймеру процесса; фаззер зовёт её сам (конец последовательности).
    const si = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({ unref() { return this; } })) as never);
    try { this.rm = new RoomManagerCtor(cfg) as RMIn; } finally { si.mockRestore(); }
    if (SELFTEST) this.restore.push(injectBug(SELFTEST, this.rm));
    this.behavior = gameWsBehavior({ DISABLED: 0 }, (conn) => {
      const slot = this.opening;
      if (slot) slot.conn = conn;
      this.rm.handleConnection(conn);
    }) as unknown as Behavior;
  }

  teardown(): void {
    db.lat = () => 0;
    for (const room of this.rm?.rooms.values() ?? []) {
      if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
      room.stop();
    }
    sched.rooms.clear();
    for (const f of this.restore.splice(0).reverse()) f();
  }

  violate(inv: string, kind: string, detail: string): void {
    this.violations.push({ key: `${inv}: ${kind}`, inv, detail: detail.slice(0, 600), op: this.opIndex });
  }

  // ── Исходящее ──
  record(slot: SlotRt, data: string | ArrayBufferView): void {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    let t = 'binary';
    let f: Record<string, unknown> | undefined;
    if (typeof data === 'string') {
      t = /^\{"t":"([a-zA-Z]+)"/.exec(data)?.[1] ?? '?';
      if (data.length < 8192) { try { f = JSON.parse(data) as Record<string, unknown>; } catch { /* не JSON — видно по типу */ } }
    }
    slot.frames.push({ t, bytes, f, op: this.opIndex });
    if (!this.ticking) { this.opOut.bytes += bytes; this.opOut.frames.push({ slot: slot.n, t, bytes }); }
  }

  // ── Время ──
  advance(ms: number): void { if (ms > 0) clock += ms; }
  /** `n` тиков всех комнат на тике (снапшот — на последнем, как у планировщика при догоне). Исходящее тика — не ответ на кадр. */
  tickRooms(n: number): void {
    if (n <= 0) return;
    this.ticking = true;
    try {
      for (let i = 0; i < n; i++) {
        this.advance(1000 / 30);
        for (const room of [...sched.rooms]) room.step(i === n - 1);
      }
    } finally { this.ticking = false; }
  }
  /**
   * Дать миру доработать: в обычной операции — до ТИШИНЫ (ни одного запроса к базе в полёте); в «гоночной» (`race`) — один оборот:
   * следующая операция вклинивается в ожидание базы, как кадр другого соединения на живой ноде.
   */
  async settle(): Promise<void> { if (this.racing) await turn(); else await this.quiesce(); }
  async quiesce(): Promise<void> {
    let calm = 0;
    for (let i = 0; i < 5000 && calm < 3; i++) {
      await turn();
      calm = db.pending === 0 ? calm + 1 : 0;
    }
    if (calm < 3) this.violate('I1', 'мир не затихает (запросы к базе без конца)', `в полёте ${db.pending}`);
  }
  racing = false;
  /** Ответы честным, которые «гоночная» операция не дождалась, — судятся в ближайшей тишине. */
  deferred: { s: SlotRt; frame: Record<string, unknown>; from: number; expect: (got: Got[]) => string | null }[] = [];
  judgeDeferred(): void {
    for (const d of this.deferred.splice(0)) {
      const got = d.s.frames.slice(d.from);
      this.note(d.frame, got, 'honest~');
      this.judgeHonest(d.s, d.frame, got, d.expect(got));
    }
  }

  // ── Соединения ──
  private opening: SlotRt | undefined;
  open(n: number, mode: Mode, ipIdx: number, slow = false, twin = false): void {
    const old = this.slots[n];
    if (old && !old.gone) return;
    const role = SLOT_ROLE[n]!;
    const ip = role === 'honest' && n === 0 ? IPS[0] : role === 'sibling' || role === 'attacker' ? IPS[0] : ipOf(ipIdx);
    const acct = twin && n === 2 ? ACCTS.h1t! : SLOT_ACCT[n] ?? null;
    this.slots[n] = this.connect(n, role, acct, mode, ip, slow && role !== 'honest', old);
  }
  /** Когда в последний раз действовал двойник (вторая вкладка того же героя, `h1t`). */
  twinAt = -Infinity;
  /** Новое соединение через транспорт (uWS — настоящим `gameWsBehavior`, `ws` — повторением `WsConn`). */
  connect(n: number, role: Role, acct: Acct | null, mode: Mode, ip: string, slow: boolean, old?: SlotRt): SlotRt {
    const slot: SlotRt = {
      n, role, acct, mode, ip, conn: undefined as unknown as GameConn, frames: [], clientClosing: false, gone: false,
      slow, buffered: 0,
      cmdId: old?.cmdId ?? 0, seq: 0, pingId: old?.pingId ?? 0, nextAt: old?.nextAt ?? 0,
    };
    if (mode === 'uws') {
      slot.sock = new FakeUwsSocket(this, slot, ip);
      this.opening = slot;
      this.behavior.open(slot.sock);
      this.opening = undefined;
    } else {
      slot.ws = new FakeWsSocket(this, slot);
      slot.conn = new WsConnCtor(slot.ws as unknown as WebSocket, ip);
      this.rm.handleConnection(slot.conn);
    }
    return slot;
  }
  /** Клиент закрыл сокет. */
  close(n: number): void {
    const s = this.slots[n];
    if (!s || s.gone) return;
    s.clientClosing = true;
    s.gone = true;
    if (s.sock && !s.sock.closed) { s.sock.closed = true; this.behavior.close(s.sock, 1000, new ArrayBuffer(0)); }
    if (s.ws) s.ws.end();
    // ⭐ C-06 (I9): закрытое клиентом — не игрок СРАЗУ, по событию закрытия, а не в конце очереди кадров соединения: за кадром, ждущим базу,
    // закрытая вкладка держала место, голос и живую сессию, а стоявшие за ним команды исполнялись после закрытия.
    const e = this.rm.conns.get(s.conn);
    if (e) this.violate('I9', `закрытое клиентом соединение осталось игроком до конца своей очереди (${s.mode})`, `слот ${s.n} (${s.role}), комната ${e.room.code}`);
  }
  /** Сокет ещё принимает кадры клиента? (uWS — до закрытия; `ws` — до события `close`.) */
  alive(s: SlotRt | undefined): s is SlotRt {
    if (!s || s.gone) return false;
    if (s.sock) return !s.sock.closed;
    return s.ws!.readyState !== 3;
  }
  /** Текстовый кадр клиента — через транспорт: больше потолка — транспорт закрывает сокет, кадр не доходит (R2-18). */
  deliver(s: SlotRt, raw: string): void {
    if (!this.alive(s)) return;
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      // uWS (`maxPayloadLength`) и `ws` (`maxPayload`, 1009 + событие ошибки) рвут соединение до разбора.
      s.serverClosed ??= 1009;
      if (s.sock) { s.sock.closed = true; this.behavior.close(s.sock, 1009, new ArrayBuffer(0)); } else s.ws!.end();
      s.gone = true;
      return;
    }
    if (s.sock) {
      const ab = new TextEncoder().encode(raw);
      this.behavior.message(s.sock, ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength) as ArrayBuffer, false);
    } else s.ws!.deliver(Buffer.from(raw, 'utf8'));
  }
  deliverBinary(s: SlotRt, bytes: Uint8Array): void {
    if (!this.alive(s)) return;
    if (s.sock) this.behavior.message(s.sock, bytes.slice().buffer as ArrayBuffer, true);
    else s.ws!.deliver(Buffer.from(bytes));
  }

  // ── Взгляд внутрь ──
  me(s: SlotRt): { room: RoomIn; pid: string; p: PlayerIn; c: ClientIn } | undefined {
    const e = this.rm.conns.get(s.conn);
    if (!e) return undefined;
    const p = e.room.session.world.players[e.pid];
    const c = e.room.clients.get(e.pid);
    return p && c ? { room: e.room, pid: e.pid, p, c } : undefined;
  }
  heroSave(charId: string): SaveState | undefined {
    for (const r of this.rm.rooms.values()) {
      for (const p of Object.values(r.session.world.players)) if (p.save.charId === charId) return p.save;
      const d = r.disconnected.get(charId);
      if (d) return d.save;
    }
    return db.chars.get(charId)?.data as SaveState | undefined;
  }

  // ── I2: снимок состояния ──
  digest(): Map<string, string> {
    const m = new Map<string, string>();
    for (const [id, r] of db.chars) m.set(`db:${id}`, `${r.version}|${JSON.stringify(r.data)}`);
    for (const [u, r] of db.stash) m.set(`stash:${u}`, `${r.version}|${JSON.stringify(r.data)}`);
    for (const room of this.rm.rooms.values()) {
      const w = room.session.world;
      m.set(`room:${room.code}`, JSON.stringify({
        area: room.area, depth: room.depth, node: room.runNodeId, movedAt: room.movedAt,
        vote: room.vote && { kind: room.vote.kind, by: room.vote.by, yes: [...room.vote.yes], no: [...room.vote.no] },
        shop: room.shop.map((i) => i.uid), cons: room.consumables.map((i) => i.uid), board: room.questBoard.map((q) => q.id),
        state: room.nodeState, drops: w.drops.map((d) => [d.id, d.item?.uid, d.pos.x, d.pos.y]),
        disc: [...room.disconnected.keys()], ling: [...room.lingering.keys()], clients: [...room.clients.keys()],
        levers: (w.levers ?? []).map((l) => !!l.used), chests: (w.chests ?? []).map((c) => !!c.opened),
      }));
      for (const [pid, p] of Object.entries(w.players)) {
        const c = room.clients.get(pid);
        m.set(`hero:${room.code}:${p.save.charId}`, JSON.stringify({ pid, save: p.save, pos: p.pos, hp: p.hp, alive: p.alive, input: c?.input, v: c?.saveVersion }));
      }
    }
    m.set('rm', JSON.stringify({ live: [...this.rm.live.keys()].sort(), grace: [...this.rm.graceByChar.keys()].sort(), rooms: [...this.rm.rooms.keys()].sort() }));
    return m;
  }
  /** Разница снимков; `skip` — ключи, которые менять можно (комната ушедшего и он сам). */
  diff(a: Map<string, string>, b: Map<string, string>, skip: (k: string) => boolean): string[] {
    const out: string[] = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      if (skip(k)) continue;
      const x = a.get(k), y = b.get(k);
      if (x !== y) out.push(`${k}: ${firstDiff(x, y)}`);
    }
    return out;
  }

  // ── Инварианты после операции ──
  checkAfterOp(): void {
    const fe = counters.frameErrors - this.counters0.frameErrors;
    const cf = counters.cmdFailed - this.counters0.cmdFailed;
    if (fe > 0) this.violate('I1', 'кадр погашен исключением (frameErrors)', `frameErrors +${fe}; ${this.errors.join(' | ')}`);
    if (cf > 0) this.violate('I1', 'команда упала (cmdFailed)', `cmdFailed +${cf}; ${this.errors.join(' | ')}`);
    this.counters0 = { frameErrors: counters.frameErrors, cmdFailed: counters.cmdFailed };
    for (const e of this.errors.splice(0)) this.violate('I1', `console.error: ${errorClass(e)}`, e);
    if (unhandled.length > this.unhandled0) {
      for (const e of unhandled.slice(this.unhandled0)) this.violate('I1', `необработанный отказ: ${errorClass(e)}`, e);
      this.unhandled0 = unhandled.length;
    }
    for (const w of db.pgRejects.splice(0)) this.violate('I1', 'база отвергла запись по кодировке (мусор в сейве)', w);
    for (const s of this.slots) {
      if (!s || s.serverClosed === undefined || s.zombieJudged || !this.rm.conns.has(s.conn)) continue;
      s.zombieJudged = true;
      const e = this.rm.conns.get(s.conn)!;
      this.violate('I9', `закрытое сервером соединение осталось игроком в комнате (${s.mode})`,
        `код закрытия ${s.serverClosed}; слот ${s.n} (${s.role}), комната ${e.room.code}, область ${e.room.area}; игрок в комнате: ${e.room.clients.has(e.pid)}`);
    }
    for (const s of this.slots) {
      if (!s || s.role !== 'honest' || s.serverClosed === undefined || s.closeJudged) continue;
      s.closeJudged = true;
      this.refused(s, 'сервер закрыл честное соединение', `код ${s.serverClosed}`, 'close');
    }
    this.checkItems();
  }

  /** I7: вещь — в одном месте; золото — целое ≥ 0. */
  checkItems(): void {
    const where = new Map<string, string>();
    const seen = (uid: string, at: string): void => {
      const was = where.get(uid);
      if (was && was !== at) this.violate('I7', 'вещь в двух местах', `${uid}: ${was} и ${at}`);
      else if (was === at) this.violate('I7', 'вещь дважды у одного героя', `${uid}: ${at}`);
      where.set(uid, at);
    };
    const heroes = new Set<string>();
    for (const a of Object.values(ACCTS)) for (const id of a.heroes) heroes.add(id);
    for (const id of heroes) {
      const s = this.heroSave(id);
      if (!s) continue;
      if (!Number.isInteger(s.gold) || s.gold < 0) this.violate('I7', 'золото не целое ≥ 0', `${id}: ${s.gold}`);
      for (const it of Object.values(s.equipment ?? {})) if (it) seen(it.uid, `${id}.eq`);
      for (const it of s.inventory) seen(it.uid, `${id}.inv`);
      for (const it of s.belt ?? []) if (it) seen(it.uid, `${id}.belt`);
      for (const it of s.stash ?? []) seen(it.uid, `${id}.stash`);
    }
    for (const [u, r] of db.stash) {
      const st = r.data as { tabs?: Item[][] };
      for (const tab of st.tabs ?? []) for (const it of tab) seen(it.uid, `stash:${u}`);
    }
    for (const room of this.rm.rooms.values()) for (const d of room.session.world.drops) if (d.item) seen(d.item.uid, `ground:${room.code}`);
  }

  // ── Честный клиент ──
  /** Честный темп: ждать до своего следующего разрешённого момента (как ждал бы человек и клиент). */
  pace(s: SlotRt, gapMs: number): void {
    if (this.now < s.nextAt) this.advance(s.nextAt - this.now);
    s.nextAt = this.now + gapMs;
  }
  /** Кадр честного клиента + проверка ответа (I3/I5). */
  async honestSend(s: SlotRt, frame: Record<string, unknown>, expect: (got: Got[]) => string | null): Promise<Got[]> {
    if (!this.alive(s) || s.serverClosed !== undefined) return [];
    const from = s.frames.length;
    const raw = JSON.stringify(frame);
    this.deliver(s, raw);
    if (this.racing) { this.deferred.push({ s, frame, from, expect }); await turn(); return []; }
    await this.settle();
    const got = s.frames.slice(from);
    this.note(frame, got, 'honest');
    this.judgeHonest(s, frame, got, expect(got));
    return got;
  }
  /** Разбор ответа честному: закрыт сервером, лимит, «неверно», нет ответа. */
  judgeHonest(s: SlotRt, frame: Record<string, unknown>, got: Got[], missing: string | null): void {
    const what = `${String(frame.t)}${frame.t === 'cmd' ? `:${String((frame.command as { cmd?: unknown })?.cmd)}` : ''}`;
    if (s.serverClosed !== undefined) {
      if (!s.closeJudged) this.refused(s, 'сервер закрыл честное соединение', `код ${s.serverClosed} после ${what}`, 'close');
      s.closeJudged = true;
      return;
    }
    for (const g of got) {
      const f = g.f;
      if (!f) continue;
      if (g.t === 'error') {
        const code = String(f.code), msg = String(f.msg);
        if (code === 'rate' && msg === VOTE_COOLDOWN_MSG) continue;
        if (['rate', 'bad-frame', 'auth', 'busy', 'forbidden', 'wrong-node', 'ledger'].includes(code)) this.refused(s, `отказ ${code}`, `${what}: ${msg}`, code === 'rate' ? msg : code);
        else if (code === 'cmd' && LIMIT_REASONS.has(msg)) this.refused(s, `отказ команды «${msg}»`, what, msg);
      }
      if (g.t === 'cmdResult' && f.ok === false && typeof f.reason === 'string' && (LIMIT_REASONS.has(f.reason) || f.reason === 'Не удалось сохранить, попробуйте ещё раз')) {
        this.refused(s, `cmdResult «${f.reason}»`, what, f.reason);
      }
    }
    if (missing) this.refused(s, `нет ответа (${missing})`, what, 'missing');
  }
  /**
   * Честному отказали. Лимит АККАУНТА при живой соседней сессии того же аккаунта — документирован (I3 разрешает); лимит, который
   * честный исчерпал сам в честном темпе, — нарушение I5 (или темп модели не честный — это видно по ключу); всё прочее — I3, если
   * рядом был мусор, иначе I5.
   */
  refused(s: SlotRt, kind: string, detail: string, why: string): void {
    const acct = s.acct!;
    const key = this.rm.connKeys.get(s.conn) ?? '';
    const net = `ip:${s.ip ? ipBucket(s.ip) : key}`;
    const exhausted: string[] = [];
    if (!limits.lobbyConn.peek(key)) exhausted.push('lobbyConn(соединение)');
    if (!limits.wsFrames.peek(key)) exhausted.push('wsFrames(соединение)');
    if (!limits.lobby.peek(acct.user)) exhausted.push('lobby(аккаунт)');
    if (!limits.townCmd.peek(acct.user)) exhausted.push('townCmd(аккаунт)');
    if (!limits.stashRead.peek(acct.user)) exhausted.push('stashRead(аккаунт)');
    if (!limits.forgeCmd.peek(acct.user)) exhausted.push('forgeCmd(аккаунт)');
    if (!limits.roomJoin.peek(acct.user)) exhausted.push('roomJoin(аккаунт)');
    if (!limits.roomCreate.peek(acct.user)) exhausted.push('roomCreate(аккаунт)');
    if (!limits.roomCodeMiss.peek(`user:${acct.user}`)) exhausted.push('roomCodeMiss(аккаунт)');
    if (!limits.roomCodeMissIp.peek(net)) exhausted.push('roomCodeMissIp(адрес)');
    if (!limits.lobbyIp.peek(net)) exhausted.push('lobbyIp(адрес)');
    const accountOnly = exhausted.length > 0 && exhausted.every((e) => e.includes('(аккаунт)'));
    const siblingNear = this.now - this.siblingAt < 120_000;
    // D8: сундук аккаунта обогнала соседняя сессия — «не удалось сохранить», документировано (R1-05, D8).
    const stashRace = why === 'Не удалось сохранить, попробуйте ещё раз' && siblingNear;
    if ((accountOnly && siblingNear) || stashRace) return;
    // Ф0.3: вход того же героя из второй вкладки вытесняет первую (4001) — документировано; ответы, оборванные вытеснением, — тоже.
    const twinNear = this.now - this.twinAt < 120_000 && s.n === 0;
    if (twinNear && (s.serverClosed === 4001 || why === 'missing')) return;
    const inv = this.junkSeen ? 'I3' : 'I5';
    this.violate(inv, `честный ${s.n === 0 ? 'h1' : 'h2'}: ${kind}`, `${detail}; исчерпано: ${exhausted.join(', ') || '—'}; адрес ${s.ip || '(нет)'}`);
  }

  async honest(s: SlotRt | undefined, act: HonestAct): Promise<void> {
    // Вытеснен двойником (4001) — человек переподключается: новый сокет и вход (вытеснит уже двойника).
    if (s && s.serverClosed === 4001 && s.n === 0 && this.now - this.twinAt < 120_000 && !MULTI_STEP.has(act.a)) {
      this.close(s.n);
      await this.quiesce();
      this.open(s.n, s.mode, 0);
      await this.quiesce();
      await this.honest(this.slots[s.n], { a: 'enter', p: 1 });
      s = this.slots[s.n];
    }
    if (!this.alive(s) || s.serverClosed !== undefined) return;
    const acct = s.acct!;
    const hero = acct.heroes[0]!;
    // Послал «выйти» — до нового входа клиент кадров игры не шлёт (сервер ещё мог не дойти до «выйти» в очереди соединения).
    const me = s.leaving ? undefined : this.me(s);
    const expectT = (t: string, ok?: (f: Record<string, unknown>) => boolean) => (got: Got[]): string | null =>
      got.some((g) => g.t === t && (!ok || (g.f && ok(g.f)))) ? null : t;
    switch (act.a) {
      case 'enter':
      case 'joinFriend': {
        const friend = act.a === 'joinFriend' && s.n === 1 ? this.slots[0] : undefined;
        const code = friend && this.alive(friend) ? this.rm.conns.get(friend.conn)?.room.code : undefined;
        if (me) {
          if (!code || me.room.code === code) return;   // уже в игре (или уже у друга)
          this.pace(s, 400);
          await this.honestSend(s, { t: 'leave' }, () => null);
          s.leaving = true;
        }
        // Как `EntryFlow`: статус забега → «Продолжить» (или «Завершить» и новая комната) → вход.
        this.pace(s, 2500);
        const st = await this.honestSend(s, { t: 'runStatus', token: acct.token, charId: hero }, expectT('runStatus'));
        const hasRun = st.find((g) => g.t === 'runStatus')?.f?.hasRun === true;
        this.advance(150);
        s.leaving = false;
        const join: Record<string, unknown> = { t: 'join', token: acct.token, charId: hero };
        if (code) join.roomCode = code;
        else if (hasRun && (act.a !== 'enter' || act.p % 5 !== 0)) join.resume = true;
        else {
          if (hasRun) {
            await this.honestSend(s, { t: 'abandon', token: acct.token, charId: hero }, expectT('abandoned'));
            this.advance(150);
          }
          join.fresh = true;
        }
        await this.honestSend(s, join, (got) => {
          if (got.some((g) => g.t === 'joined')) return null;
          const e = got.find((g) => g.t === 'error')?.f;
          // Правила игры, а не лимиты: пати полна, комната исчезла, забега уже нет.
          if (e && ['full', 'no-room', 'no-run'].includes(String(e.code))) return null;
          return 'joined';
        });
        return;
      }
      case 'ping': {
        this.pace(s, 200);
        const id = ++s.pingId;
        await this.honestSend(s, { t: 'ping', id }, expectT('pong', (f) => f.id === id));
        return;
      }
      case 'runStatus': {
        this.pace(s, 1500);
        await this.honestSend(s, { t: 'runStatus', token: acct.token, charId: hero }, expectT('runStatus'));
        return;
      }
      case 'leave': {
        if (!me) return;
        s.leaving = true;
        this.pace(s, 1000);
        await this.honestSend(s, { t: 'leave' }, () => null);
        return;
      }
      case 'input': {
        if (!me) return;
        const period = 1000 / act.hz;
        for (let i = 0; i < act.n; i++) {
          if (act.hz === 30 || i % 2 === 1) this.tickRooms(1); else this.advance(period);
          if (!this.alive(s) || s.serverClosed !== undefined) break;
          const cur = this.me(s);
          if (!cur) break;
          const press = i === 0 ? act.press : 0;
          const ang = (act.mv % 8) * (Math.PI / 4);
          const move = cur.room.area === 'town' && act.mv >= 8 ? { x: Math.cos(ang), y: Math.sin(ang) } : { x: 0, y: 0 };
          const input: Record<string, unknown> = { move, facing: ang - Math.PI, attack: act.mv % 3 === 0, cast: press === 2 ? 'b-aura-a1' : null, interact: false };
          if (s.mode === 'ws' || act.hz === 60) input.dodge = press === 1;   // Unity (Newtonsoft) шлёт `dodge` всегда
          else if (press === 1) input.dodge = true;
          if (press === 3) input.useBelt = 0;
          const from = s.frames.length;
          this.deliver(s, JSON.stringify({ t: 'input', seq: ++s.seq, input }));
          // Нажатие (рывок, каст, пояс) мягкий лимит не глушит (R4-19): оно обязано дойти до комнаты этим же кадром.
          if (press) {
            const now = this.me(s);
            const applied = now && (press === 1 ? now.c.input.dodge === true : press === 2 ? now.c.input.cast === 'b-aura-a1' : now.c.input.useBelt === 0);
            if (!applied && !now?.room.frozen) this.judgeHonest(s, { t: 'input' }, s.frames.slice(from), 'нажатие не дошло до комнаты');
          }
          if (s.serverClosed !== undefined) { this.judgeHonest(s, { t: 'input' }, s.frames.slice(from), null); break; }
        }
        await this.settle();
        return;
      }
      case 'cmd': {
        if (!me) return;
        const command = this.honestCmd(s, act.cmd, act.pick);
        if (!command) return;
        const forge = ['forgeRepair', 'forgeUpgrade', 'forgeReroll', 'forgeSalvage', 'salvage', 'craft', 'forgeEnchant', 'forgeSketch'].includes(command.cmd);
        this.pace(s, forge ? 800 : 300);
        const id = ++s.cmdId;
        await this.cmdWithEcon(s, command, id, true);
        return;
      }
      case 'descend': {
        if (!me || me.room.area !== 'town') return;
        this.pace(s, 2000);
        const biome = cfg.get('biomes').find((b) => b.enabled !== false)?.id;
        const tpl = cfg.get('run-templates').find((t) => t.enabled !== false)?.id;
        await this.honestSend(s, act.alt ? { t: 'descend' } : { t: 'descend', difficultyId: 'normal', runConfig: { biomeId: biome, templateId: tpl, modifiers: [] } }, () => null);
        return;
      }
      case 'return': {
        if (!me || me.room.area === 'town') return;
        this.pace(s, 2000);
        await this.honestSend(s, { t: 'return' }, () => null);
        return;
      }
      case 'arena': {
        if (!me || me.room.area !== 'town') return;
        this.pace(s, 2000);
        await this.honestSend(s, { t: 'arena' }, () => null);
        return;
      }
      case 'lever': case 'chest': {
        if (!me || me.room.area !== 'dungeon') return;
        const w = me.room.session.world;
        const list = act.a === 'lever' ? w.levers ?? [] : w.chests ?? [];
        const near = [...list].sort((x, y) => Math.hypot(x.pos.x - me.p.pos.x, x.pos.y - me.p.pos.y) - Math.hypot(y.pos.x - me.p.pos.x, y.pos.y - me.p.pos.y))[0];
        if (!near) return;
        this.pace(s, 500);
        await this.honestSend(s, act.a === 'lever' ? { t: 'lever', leverId: near.id } : { t: 'chest', chestId: near.id }, () => null);
        return;
      }
      case 'reconnect': {
        this.close(s.n);
        await this.settle();
        this.advance(800);
        this.open(s.n, act.mode, s.n === 1 ? (s.ip === IPS[1] ? 1 : 0) : 0);
        await this.settle();
        await this.honest(this.slots[s.n], { a: 'enter', p: act.p });
        return;
      }
      case 'flap': {
        // Обрыв связи посреди входа: сокет упал (без `leave`), клиент переподключился, спросил статус забега, послал вход — и связь
        // упала снова, пока вход ждал базу. Потом — честное переподключение до конца.
        this.close(s.n);
        await this.settle();
        this.advance(500);
        const ip = s.n === 1 ? (s.ip === IPS[1] ? 1 : 0) : 0;
        this.open(s.n, act.mode, ip);
        const f = this.slots[s.n]!;
        this.pace(f, 2500);
        this.deliver(f, JSON.stringify({ t: 'runStatus', token: acct.token, charId: hero }));
        await this.quiesce();
        const hasRun = f.frames.find((g) => g.t === 'runStatus')?.f?.hasRun === true;
        this.advance(150);
        this.deliver(f, JSON.stringify({ t: 'join', token: acct.token, charId: hero, ...(hasRun ? { resume: true } : { fresh: true }) }));
        for (let i = act.p % 4; i > 0; i--) await turn();
        this.close(s.n);
        await this.quiesce();
        this.advance(1500);
        this.open(s.n, act.mode, ip);
        await this.quiesce();
        await this.honest(this.slots[s.n], { a: 'enter', p: act.p });
        return;
      }
    }
  }
  lastOf(s: SlotRt, t: string): Record<string, unknown> | undefined {
    for (let i = s.frames.length - 1; i >= 0; i--) if (s.frames[i]!.t === t) return s.frames[i]!.f;
    return undefined;
  }

  /** Команда и проверка экономики на отказ (I2) и сейва в ответ на отказ — в меру `cmdResync` (I4). */
  async cmdWithEcon(s: SlotRt, command: unknown, id: number | undefined, honest: boolean): Promise<void> {
    const me = this.me(s);
    const charId = me?.p.save.charId;
    const user = s.acct?.user;
    const before = charId ? { live: econ(me.p.save), db: dbRow(charId), stash: user ? dbStash(user) : '' } : undefined;
    const frame: Record<string, unknown> = { t: 'cmd', command };
    if (id !== undefined) frame.id = id;
    const from = s.frames.length;
    if (honest) {
      await this.honestSend(s, frame, (got) => (got.some((g) => g.t === 'cmdResult' && (id === undefined || g.f?.id === id)) ? null : 'cmdResult'));
    } else {
      this.deliver(s, JSON.stringify(frame));
      await this.settle();
      this.note(frame, s.frames.slice(from), `${s.role}/valid`);
    }
    if (this.racing) return;
    const got = s.frames.slice(from);
    const res = got.find((g) => g.t === 'cmdResult' && (id === undefined || g.f?.id === id))?.f;
    if (!res || res.ok !== false || !charId || !before) return;
    const now = this.me(s);
    // Отказ: экономика героя и сундук аккаунта — как были (сток прилавка и забег — не экономика команды, R8-01).
    const after = { live: now && now.p.save.charId === charId ? econ(now.p.save) : before.live, db: dbRow(charId), stash: user ? dbStash(user) : '' };
    if (after.live !== before.live) this.violate('I2', `отказанная команда изменила экономику (${String((command as { cmd?: unknown }).cmd)})`, `${String(res.reason)}: ${firstDiff(before.live, after.live)}`);
    if (after.db !== before.db && !this.dbWriteOk(charId)) this.violate('I2', `отказанная команда изменила строку героя (${String((command as { cmd?: unknown }).cmd)})`, `${String(res.reason)}: ${firstDiff(before.db, after.db)}`);
    if (after.stash !== before.stash) this.violate('I2', `отказанная команда изменила сундук (${String((command as { cmd?: unknown }).cmd)})`, `${String(res.reason)}: ${firstDiff(before.stash, after.stash)}`);
    // I4: сейв и прилавок в ответ на отказ — в меру теневого бакета `cmdResync`.
    const heavy = got.filter((g) => g.t === 'saveUpdate' || g.t === 'shop').length;
    if (heavy && user) {
      const b = this.resyncShadow.get(user) ?? { tokens: 5, at: this.now };
      b.tokens = Math.min(5, b.tokens + (this.now - b.at) / 1000);
      b.at = this.now;
      b.tokens -= heavy;
      this.resyncShadow.set(user, b);
      if (b.tokens < -0.001) this.violate('I4', 'сейв/прилавок в ответ на отказ сверх cmdResync', `${String((command as { cmd?: unknown }).cmd)} «${String(res.reason)}»: ${heavy} тяжёлых кадра`);
    }
  }
  /** Запись строки героя при отказе допустима только прощальная/автосейв — отказ её не вызывает; оставлено для ясности. */
  dbWriteOk(_charId: string): boolean { return false; }

  /** Честная команда из живого сейва: то, что клиент послал бы по клику. `null` — сейчас такую не послать. */
  honestCmd(s: SlotRt, kind: CmdKind, pick: number): TownCommand | null {
    const me = this.me(s);
    if (!me) return null;
    const save = me.p.save;
    const town = me.room.area === 'town';
    const inv = save.inventory;
    const nth = <T>(a: readonly T[]): T | undefined => (a.length ? a[pick % a.length] : undefined);
    switch (kind) {
      case 'bind': return { cmd: 'bind', slot: pick % 5, value: pick % 3 === 0 ? null : 'attack' };
      case 'moveItem': { const it = nth(inv.filter((i) => i.pos)); return it?.pos ? { cmd: 'moveItem', uid: it.uid, x: it.pos.x, y: it.pos.y } : null; }
      case 'allocAttr': return { cmd: 'allocAttr', attr: ATTRIBUTES[pick % ATTRIBUTES.length]!, n: 1 };
      case 'stashOpen': return town ? { cmd: 'stashOpen' } : null;
      case 'stashMove': {
        if (!town) return null;
        const st = this.lastOf(s, 'stash') as { tabs?: Item[][] } | undefined;
        const inStash = (st?.tabs ?? []).flat();
        const d = stashDims(cfg);
        if (pick % 2 === 0 && inStash.length) { const it = nth(inStash)!; return { cmd: 'stashMove', uid: it.uid, dst: 'inv', x: pick % 10, y: pick % 4 }; }
        const it = nth(inv.filter((i) => i.kind !== 'material'));
        return it ? { cmd: 'stashMove', uid: it.uid, dst: 0, x: pick % d.cols, y: (pick >> 3) % d.rows } : null;
      }
      case 'unequip': { const slot = nth(Object.keys(save.equipment).filter((k) => save.equipment[k as keyof typeof save.equipment])); return slot ? { cmd: 'unequip', slot } : null; }
      case 'equip': { const it = nth(inv.filter((i) => i.slot)); return it ? { cmd: 'equip', uid: it.uid } : null; }
      case 'buy': { if (!town) return null; const it = nth(me.room.shop); return it ? { cmd: 'buy', uid: it.uid, maxGold: shopBuyPrice(cfg, it) } : null; }
      case 'sell': { if (!town) return null; const it = nth(inv); return it ? { cmd: 'sell', uid: it.uid, minGold: 0 } : null; }
      case 'drop': { const it = nth(inv); return it ? { cmd: 'drop', uid: it.uid } : null; }
      case 'pickup': {
        const d = me.room.session.world.drops.filter((x) => x.item && (x.owner === undefined || x.owner === s.acct?.user))
          .sort((x, y) => Math.hypot(x.pos.x - me.p.pos.x, x.pos.y - me.p.pos.y) - Math.hypot(y.pos.x - me.p.pos.x, y.pos.y - me.p.pos.y))[0];
        return d ? { cmd: 'pickup', dropId: d.id } : null;
      }
      case 'useConsumable': { const it = nth([...inv, ...(save.belt ?? []).filter((b): b is Item => !!b)].filter((i) => i.use)); return it ? { cmd: 'useConsumable', uid: it.uid } : null; }
      case 'moveBelt': { const it = nth(inv.filter((i) => i.kind === 'consumable')); return it ? { cmd: 'moveBelt', uid: it.uid } : null; }
      case 'acceptQuest': { const q = nth(me.room.questBoard); return q ? { cmd: 'acceptQuest', questId: q.id } : null; }
      case 'turnInQuest': { const q = nth(save.activeQuestDefs ?? []); return q ? { cmd: 'turnInQuest', questId: q.id } : null; }
      case 'respec': return { cmd: 'respec', maxGold: save.gold };
      case 'respecPassives': return { cmd: 'respecPassives', maxGold: save.gold };
      case 'respecSkills': return { cmd: 'respecSkills', maxGold: save.gold };
      case 'depositMaterials': return town ? { cmd: 'depositMaterials' } : null;
      case 'forgeRepair': case 'forgeUpgrade': case 'forgeReroll': {
        if (!town) return null;
        const it = nth([...Object.values(save.equipment).filter((x): x is Item => !!x), ...inv.filter((i) => i.slot)]);
        return it ? { cmd: kind, uid: it.uid, maxGold: save.gold } as TownCommand : null;
      }
      case 'salvage': case 'forgeSalvage': {
        const it = nth(inv.filter((i) => i.kind !== 'consumable' && i.kind !== 'material'));
        return it && (kind === 'salvage' || town) ? { cmd: kind, uid: it.uid } as TownCommand : null;
      }
      case 'forgeEnchant': { const it = nth(inv.filter((i) => i.slot)); return it && town ? { cmd: 'forgeEnchant', uid: it.uid, rarity: pick % 2 ? 'magic' : 'rare', maxGold: save.gold } : null; }
      case 'forgeSketch': return town ? { cmd: 'forgeSketch', variantId: `v-${pick % 7}` } : null;
      case 'allocPassive': { const n = nth(cfg.get('skill-tree').nodes); return n ? { cmd: 'allocPassive', nodeId: n.id, maxGold: save.gold } : null; }
      case 'allocSkill': { const n = nth(cfg.get('skill-tree').nodes); return n ? { cmd: 'allocSkill', nodeId: n.id } : null; }
      case 'socketInsert': { const n = nth(cfg.get('skill-tree').nodes); return n ? { cmd: 'socketInsert', nodeId: n.id, slot: pick % 3, insertId: `ins-${pick % 5}` } : null; }
      case 'socketClear': { const n = nth(cfg.get('skill-tree').nodes); return n ? { cmd: 'socketClear', nodeId: n.id, slot: pick % 3 } : null; }
      case 'craft': return town ? { cmd: 'craft', nonce: `nonce-${pick.toString(36).padStart(8, '0')}`, input: { weaponClass: 'sword', hands: 1, parts: { strike: { id: 'x', step: 1 }, grip: { id: 'x', step: 1 }, bind: { id: 'x', step: 1 }, head: { id: 'x', step: 1 } } } } : null;
    }
    return null;
  }

  // ── Кадры чужих слотов ──
  /** Честный по форме кадр вида `kind` в контексте слота (свой токен и герой; у анонима — чужой токен). */
  baseFrame(s: SlotRt, kind: FrameKind, r: Prng): Record<string, unknown> {
    const acct = s.acct;
    const token = acct ? acct.token : r.pick([TOK_UNKNOWN, 'ab'.repeat(32), 'cd'.repeat(32), [...Array(64)].map(() => r.pick([...'0123456789abcdef'])).join('')]);
    const charId = acct ? r.pick(acct.heroes) : r.pick(['anon-1', 'h1x', 'c-0', 'x']);
    const code = (() => { const h = this.slots[0]; return h && this.alive(h) ? this.rm.conns.get(h.conn)?.room.code : undefined; })();
    switch (kind) {
      case 'join': return { t: 'join', token, charId, fresh: true };
      case 'joinCode': return { t: 'join', token, charId, roomCode: code ?? r.pick(['A2345678', 'a2345678', 'ZZZZZZZZ']) };
      case 'resume': return { t: 'join', token, charId, resume: true };
      case 'runStatus': return { t: 'runStatus', token, charId };
      case 'abandon': return { t: 'abandon', token, charId };
      case 'cmd': {
        const k = r.pick(CMD_KINDS);
        return { t: 'cmd', command: this.honestCmd(s, k, r.int(1000)) ?? { cmd: 'bind', slot: 0, value: 'attack' }, id: r.int(50) };
      }
      case 'input': return {
        t: 'input', seq: r.int(10_000),
        input: { move: { x: r.next() * 2 - 1, y: r.next() * 2 - 1 }, facing: r.next() * 6 - 3, attack: r.chance(0.5), cast: r.chance(0.1) ? 'b-aura-a1' : null, interact: r.chance(0.2), dodge: r.chance(0.1) },
      };
      case 'ping': return { t: 'ping', id: r.int(1_000_000) };
      case 'descend': {
        const me = this.me(s);
        const w = me?.room.session.world;
        const plan = (me?.room as unknown as { runPlan?: { nodes: { id: string; edges: { to: string }[] }[] } } | undefined)?.runPlan;
        const node = plan?.nodes.find((n) => n.id === me?.room.runNodeId);
        if (w && node?.edges.length && r.chance(0.5)) return { t: 'descend', targetNodeId: r.pick(node.edges).to };
        return r.chance(0.5) ? { t: 'descend' } : { t: 'descend', difficultyId: r.pick(['normal', 'nightmare', 'hell', 'x']), runConfig: { biomeId: 'crypt', templateId: 'default', modifiers: ['m1', 'm2'] } };
      }
      case 'vote': return { t: 'vote', accept: r.chance(0.5) };
      case 'lever': return { t: 'lever', leverId: r.int(8) };
      case 'chest': return { t: 'chest', chestId: r.int(8) };
      case 'arena': return { t: 'arena' };
      case 'return': return { t: 'return' };
      case 'leave': return { t: 'leave' };
    }
  }

  async junk(s: SlotRt | undefined, j: Junk): Promise<void> {
    if (!this.alive(s)) return;
    // ⭐ I9: сокет уже закрыт сервером, но транспорт ещё отдаёт его кадры (у `ws` — до конца рукопожатия закрытия, до 30 с): они
    // не вправе ничего менять — ни войти заново, ни сыграть командой.
    const zombie = s.serverClosed !== undefined && !this.racing ? this.digest() : undefined;
    const seated = this.rm.conns.get(s.conn);
    const seatedHero = seated?.room.session.world.players[seated.pid]?.save.charId;
    await this.junkFrames(s, j);
    if (!zombie) return;
    await this.quiesce();
    // Снятие уже сидевшего «мертвеца» (его кадр упёрся в потолок, и `accept` снял сессию) — не действие, а уборка (это I9 «остался
    // игроком», у него свой ключ): его комната, сейв и карты менеджера меняться вправе.
    const removed = !!seated && !this.rm.conns.has(s.conn);
    const d = this.diff(zombie, this.digest(), (k) => removed && (k === 'rm' || k.includes(`:${seated.room.code}`) || k === `db:${seatedHero}`));
    if (d.length) {
      this.violate('I9', `кадр закрытого сервером соединения подействовал (${s.mode})`,
        `код закрытия ${s.serverClosed}; слот ${s.n} (${s.role}), кадр ${j.j === 'valid' || j.j === 'cmd' ? `${j.j}:${j.j === 'valid' ? j.base : j.cmd}` : j.j}; изменилось [${d.map((x) => x.split(': ')[0]).join(', ')}]: ${d.slice(0, 2).join(' ; ')}`);
    }
  }

  async junkFrames(s: SlotRt, j: Junk): Promise<void> {
    this.junkSeen = true;
    if (s.role === 'sibling') this.siblingAt = this.now;
    if (s.acct === ACCTS.h1t) this.twinAt = this.now;
    const r = new Prng(j.seed);
    const frames: { raw?: string; bytes?: Uint8Array; how: string; kind: string }[] = [];
    switch (j.j) {
      case 'mutate': { const m = mutateFrame(this.baseFrame(s, j.base, r), j.seed); frames.push({ raw: m.raw, how: m.how, kind: `mutate:${j.base}` }); break; }
      case 'text': { const m = junkText(j.seed, j.len); frames.push({ raw: m.raw, how: m.how, kind: 'text' }); break; }
      case 'binary': { const b = junkBytes(j.seed, j.len, JSON.stringify(this.baseFrame(s, 'ping', r))); frames.push({ bytes: b.bytes, how: b.how, kind: 'binary' }); break; }
      case 'oversize': {
        const base = JSON.stringify(this.baseFrame(s, r.pick(['cmd', 'join', 'input'] as const), r));
        frames.push({ raw: `${base.slice(0, -1)},"pad":"${'x'.repeat(j.len)}"}`, how: `oversize ${j.len}`, kind: 'oversize' });
        break;
      }
      case 'flood': {
        for (let i = 0; i < j.n; i++) {
          const f = this.baseFrame(s, j.base, r);
          const m = j.mutate ? mutateFrame(f, j.seed + i) : { raw: JSON.stringify(f), how: 'as is' };
          frames.push({ raw: m.raw, how: m.how, kind: `flood:${j.base}` });
        }
        break;
      }
      case 'cmd': {
        // Команда героя слота «по клику» (выброс, подбор, сундук, лавка) — в пати с честным это обмен вещами внутри аккаунта и мимо.
        const command = this.honestCmd(s, j.cmd, j.pick);
        if (command) await this.cmdWithEcon(s, command, 1 + r.int(1 << 20), false);
        return;
      }
      case 'valid': {
        const f = this.baseFrame(s, j.base, r);
        if (f.t === 'cmd') { await this.cmdWithEcon(s, f.command, f.id as number, false); return; }
        frames.push({ raw: JSON.stringify(f), how: 'valid', kind: `valid:${j.base}` });
        break;
      }
      case 'foreign': {
        // Чужие id: честного героя своим токеном (или без токена) — отказ «недоступен», честному — ничего.
        const f = this.baseFrame(s, j.what, r);
        f.charId = r.pick(Object.values(ACCTS).filter((a) => a.user !== s.acct?.user).flatMap((a) => a.heroes));
        frames.push({ raw: JSON.stringify(f), how: `foreign ${String(f.charId)}`, kind: `foreign:${j.what}` });
        break;
      }
    }
    // Оракул судит то, что увидит игра, — текст ПОСЛЕ транспорта (uWS снимает BOM, непарный суррогат клиент кодирует как U+FFFD).
    const allInvalid = frames.every((f) => (f.raw !== undefined ? !contractValid(onWire(s.mode, f.raw)) : s.mode === 'uws' || !contractValid(Buffer.from(f.bytes!).toString())));
    const before = allInvalid && !this.racing ? this.digest() : undefined;
    const senderRoom = this.rm.conns.get(s.conn)?.room;
    const senderHero = this.me(s)?.p.save.charId;
    // Уход закрытого отправителя законно двигает его комнату: голос без него проходит, переход пишет сейвы всех, кто в ней.
    const roomHeroes = new Set(senderRoom ? Object.values(senderRoom.session.world.players).map((p) => p.save.charId) : []);
    const bytesIn = frames.reduce((n, f) => n + (f.raw !== undefined ? Buffer.byteLength(f.raw) : f.bytes!.byteLength), 0);
    this.opOut = { bytes: 0, frames: [] };
    const from = s.frames.length;
    for (const f of frames) {
      if (!this.alive(s)) break;
      if (f.raw !== undefined) this.deliver(s, f.raw); else this.deliverBinary(s, f.bytes!);
    }
    await this.settle();
    const closed = s.serverClosed !== undefined || s.gone;
    if (j.j === 'valid' || j.j === 'foreign') {
      try { this.note(JSON.parse(frames[0]!.raw!) as Record<string, unknown>, s.frames.slice(from), `${s.role}/${j.j}`); } catch { /* не бывает */ }
    }
    // Статистика усиления (для отчёта).
    const kind = frames[0]?.kind ?? j.j;
    const a = this.amp.get(kind) ?? [0, 0, 0];
    this.amp.set(kind, [a[0] + frames.length, a[1] + bytesIn, a[2] + this.opOut.bytes]);
    if (!before) return;
    // I2: кривое ничего не меняет. Закрытое за мусор соединение уходит — его уход (прощальная запись, место в комнате) законен.
    const after = this.digest();
    const skip = (k: string): boolean => closed && (k === 'rm' || (!!senderRoom && k.includes(`:${senderRoom.code}`))
      || (!!senderHero && k === `db:${senderHero}`) || (k.startsWith('db:') && roomHeroes.has(k.slice(3))));
    const d = this.diff(before, after, skip);
    if (d.length) {
      this.violate('I2', `кривой кадр изменил состояние (${kind.split(':')[0]})`,
        `${frames.map((f) => f.how).join(' / ')}; отправитель ${closed ? `закрыт (${s.serverClosed ?? 'транспорт'})` : 'жив'}; изменилось [${d.map((x) => x.split(': ')[0]).join(', ')}]: ${d.slice(0, 2).join(' ; ')}`);
    }
    // I4: на кривой кадр — не больше пары маленьких кадров (ошибка + итог команды), и никаких тяжёлых.
    if (!closed && !this.racing) {
      const heavy = this.opOut.frames.filter((f) => f.bytes > 1024);
      if (this.opOut.bytes > 600 * frames.length || heavy.length) {
        this.violate('I4', `кривой кадр — много исходящего (${kind.split(':')[0]})`, `${this.opOut.bytes} Б на ${frames.length} кадр(ов): ${this.opOut.frames.slice(0, 6).map((f) => `${f.t}:${f.bytes}`).join(', ')}`);
      }
    }
  }

  /** Честные отвечают на голосование «за» (как человек, нажавший «Да»). */
  async autoVote(): Promise<void> {
    for (const s of this.slots) {
      if (!s || s.role !== 'honest' || !this.alive(s) || s.serverClosed !== undefined) continue;
      const me = this.me(s);
      const v = me?.room.vote;
      if (!me || !v || v.yes.has(me.pid) || v.no.has(me.pid) || s.voted === v) continue;
      s.voted = v;
      await this.honestSend(s, { t: 'vote', accept: true }, () => null);
    }
  }

  async exec(op: Op): Promise<void> {
    this.opIndex++;
    // Вход и переподключение честного — несколько кадров с ожиданием ответа между ними (как `EntryFlow`): гонкой они не бывают.
    this.racing = (op.k === 'honest' || op.k === 'junk' || op.k === 'close') && op.race === true && !(op.k === 'honest' && MULTI_STEP.has(op.act.a));
    // Не гонка — сперва тишина: прошлые гоночные операции доработали, их ответы судятся ДО новой (иначе чужое исходящее и чужие
    // записи легли бы на счёт этой операции). Гонки между собой — вперемешку, как кадры разных соединений на живой ноде.
    if (!this.racing) { await this.quiesce(); this.judgeDeferred(); }
    this.opOut = { bytes: 0, frames: [] };
    switch (op.k) {
      case 'open': this.open(op.s, op.mode, op.ip, op.slow === true, op.twin === true); break;
      case 'close': this.close(op.s); break;
      case 'honest': await this.honest(this.slots[op.s], op.act); break;
      case 'junk': {
        const s = this.slots[op.s];
        if (s?.role === 'sibling') this.siblingAt = this.now;
        if (s?.acct === ACCTS.h1t) this.twinAt = this.now;
        await this.junk(s, op.junk);
        break;
      }
      case 'wait': {
        // Мир живёт своим тиком (30 Гц): ожидание — это и тики (до трёх секунд мира), остаток — просто время.
        const n = Math.min(90, Math.floor(op.ms / (1000 / 30)));
        this.tickRooms(n);
        this.advance(op.ms - n * (1000 / 30));
        break;
      }
      case 'tick': this.tickRooms(op.n); break;
      case 'wsClose': for (const w of [...this.pendingWsClose]) w.end(); break;
      case 'expire': {
        // Прошёл час: грейс-таймеры комнат (их ставит `enterGrace` на `reconnectGraceSec`) срабатывают.
        for (const room of [...this.rm.rooms.values()]) {
          if (!room.graceTimer) continue;
          clearTimeout(room.graceTimer);
          room.expireGrace();
        }
        break;
      }
    }
    if (this.racing) {
      await turn();
      this.racing = false;
    } else {
      await this.quiesce();
      this.judgeDeferred();
      await this.autoVote();
      await this.quiesce();
      this.checkAfterOp();
    }
    if (TRACE) {
      const st = this.slots.map((s) => (s ? `${s.n}${s.gone ? 'x' : ''}${this.me(s) ? `@${this.me(s)!.room.area}` : ''}${s.serverClosed ? `!${s.serverClosed}` : ''}` : '-')).join(' ');
      TRACE_LINES.push(`${String(this.opIndex).padStart(3)} ${JSON.stringify(op).slice(0, 140)} | out ${this.opOut.bytes} | ${st} | v${this.violations.length}`);
    }
  }

  /** I6: закрыть всё и проверить, что подметено. */
  async finish(): Promise<void> {
    this.opIndex++;
    this.racing = false;
    await this.quiesce();
    this.judgeDeferred();
    this.checkAfterOp();   // до закрытий и хода часов: последние гонки судятся в своём времени
    for (let n = 0; n < this.slots.length; n++) this.close(n);
    for (const w of [...this.pendingWsClose]) w.end();
    this.racing = false;
    await this.quiesce();
    this.judgeDeferred();
    await this.quiesce();
    // Подметание номеров прощальных записей (R11-12) — фоном, раз в 5 с; прошло 11 минут.
    this.advance(11 * 60_000);
    await this.rm.retryUnsaved();
    await this.settle();
    this.checkAfterOp();
    const rm = this.rm;
    const left = (what: string, n: number): void => { if (n > 0) this.violate('I6', `после закрытия всех соединений осталось: ${what}`, `${n}`); };
    left('conns', rm.conns.size);
    left('live', rm.live.size);
    left('inputRate', rm.inputRate.size);
    left('charOps', rm.charOps.size);
    left('sessionLookups', rm.sessionLookups.size);
    left('leaving', rm.leaving.size);
    left('inflight', rm.inflight.size);
    left('unsaved', rm.unsaved.size);
    left('unsavedRetrying', rm.unsavedRetrying.size);
    for (const room of rm.rooms.values()) {
      if (room.clients.size) this.violate('I6', 'в комнате остались клиенты без соединений', `${room.code}: ${room.clients.size}`);
      if (!room.disconnected.size) this.violate('I6', 'пустая комната без ждущих не уничтожена', room.code);
      else if (!room.graceTimer) this.violate('I6', 'комната ждущих без грейс-таймера (висит вечно)', room.code);
      if (room.peerSent.size) this.violate('I6', 'peerSent комнаты не подметён', `${room.code}: ${room.peerSent.size}`);
    }
    for (const [id, room] of rm.graceByChar) if (!rm.rooms.has(room.code) || !room.disconnected.has(id)) this.violate('I6', 'graceByChar указывает на комнату без него', id);
    for (const id of rm.farewellSeq.keys()) if (!rm.graceByChar.has(id)) this.violate('I6', 'номер прощальной записи не подметён', id);
    left('комнат на тике', sched.rooms.size);
    left('бакеты wsFrames', limits.wsFrames.size);
    left('бакеты wsInput', limits.wsInput.size);
    left('бакеты lobbyConn', limits.lobbyConn.size);
    left('бакеты промахов кода на соединение', keysOf(limits.roomCodeMiss).filter((k) => k.startsWith('conn:')).length);
    left('бакеты «адреса» соединений без адреса', [...keysOf(limits.lobbyIp), ...keysOf(limits.roomCodeMissIp)].filter((k) => /^ip:c\d+$/.test(k)).length);
    // Прошло 11 минут простоя: ленивое подметание лимитеров (раз в минуту, на `take`) — записей о ключах не остаётся ни на соединение,
    // ни на адрес, ни на аккаунт (рост карт ограничен временем, а не числом соединений). Проба — ключом IPv6 /64: он трогает все ступени сети.
    const probe = 'ip:2001:db8:ffff:ffff::/64';
    for (const [name, l] of Object.entries(limits)) {
      if (name === 'charCreate') continue;   // запись живёт час — по замыслу (R3-04)
      l.take(probe);
      l.reset(probe);
      if (l.size > 0) this.violate('I6', `после 11 минут простоя в лимитере остались ключи (${name})`, `${l.size}: ${keysOf(l).slice(0, 4).join(', ')}`);
    }
    if (known.sessions.size > Object.keys(ACCTS).length) this.violate('I6', 'known.sessions выросла сверх живых сессий', `${known.sessions.size}`);
    await this.reenter();
  }

  /**
   * I8: ЗАСТРЯВШИХ НЕТ — каждый герой (и честный, и тот, кто слал мусор) после всего входит снова, как `EntryFlow`: статус забега, затем
   * «Продолжить» или новая комната. «Сохраняем, повторите», «занято», «другой узел» или молчание здесь — герой заперт.
   */
  async reenter(): Promise<void> {
    for (const a of Object.values(ACCTS)) {
      for (const hero of a.heroes) {
        // Только те, кто за последовательность хоть раз вошёл (первый вход пишет сейв): вход нетронутого героя проверять незачем.
        if ((db.chars.get(hero)?.version ?? 1) <= 1 && !this.rm.graceByChar.has(hero)) continue;
        this.opIndex++;
        const s = this.connect(99, 'honest', a, 'uws', IPS[1], false);
        this.deliver(s, JSON.stringify({ t: 'runStatus', token: a.token, charId: hero }));
        await this.quiesce();
        const st = s.frames.find((g) => g.t === 'runStatus')?.f;
        this.advance(200);
        this.deliver(s, JSON.stringify({ t: 'join', token: a.token, charId: hero, ...(st?.hasRun === true ? { resume: true } : { fresh: true }) }));
        await this.quiesce();
        if (!s.frames.some((g) => g.t === 'joined')) {
          const err = s.frames.filter((g) => g.t === 'error').map((g) => `${String(g.f?.code)}: ${String(g.f?.msg)}`).join(' | ');
          this.violate('I8', `герой не входит снова после последовательности${st ? '' : ' (нет статуса забега)'}`, `${hero} (забег: ${String(st?.hasRun)}): ${err || 'молчание'}; закрыт ${String(s.serverClosed ?? '-')}`);
        }
        this.close99(s);
        await this.quiesce();
        this.advance(3000);
      }
    }
    this.checkAfterOp();
  }
  close99(s: SlotRt): void {
    s.clientClosing = true;
    s.gone = true;
    if (s.sock && !s.sock.closed) { s.sock.closed = true; this.behavior.close(s.sock, 1000, new ArrayBuffer(0)); }
    if (s.ws) s.ws.end();
  }
}

/** Вещь для сумки героя: снаряжение (обычное или магическое) или зелье — по сиду. */
function fuzzItem(r: Prng, kind: 'gear' | 'consumable'): Item {
  const bases = cfg.get('items.base').filter((b) => b.enabled !== false && (kind === 'consumable' ? b.kind === 'consumable' : b.kind !== 'consumable'));
  const base = r.pick(bases);
  return generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
    dropBias: 1, itemLevel: r.range(1, 8), baseId: base.id, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'),
    forceRarity: kind === 'consumable' ? 'normal' : r.pick(['normal', 'magic'] as const), maxReqTotal: cfg.get('balance').maxTotalRequirement, origin: 'drop',
  }, createRng(r.fork()));
}

/** Текст кадра, каким его получит игра после транспорта: клиент кодирует строку в UTF-8, uWS декодирует `TextDecoder` (BOM снимается), `ws` — `Buffer.toString`. */
function onWire(mode: Mode, raw: string): string {
  const bytes = Buffer.from(raw, 'utf8');
  return mode === 'uws' ? new TextDecoder().decode(bytes) : bytes.toString('utf8');
}

function dbRow(charId: string): string { const r = db.chars.get(charId); return r ? `${r.version}|${econ(r.data as SaveState)}` : '-'; }
function dbStash(user: string): string { const r = db.stash.get(user); return r ? `${r.version}|${JSON.stringify(r.data)}` : '-'; }
/** Первое расхождение двух строк — с окрестностью, для отчёта. */
function firstDiff(a: string | undefined, b: string | undefined): string {
  if (a === undefined || b === undefined) return `${a === undefined ? 'не было' : 'было'} → ${b === undefined ? 'не стало' : 'стало'}`;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `@${i}: «${a.slice(Math.max(0, i - 40), i + 60)}» → «${b.slice(Math.max(0, i - 40), i + 60)}»`;
}
/** Вид ошибки для ключа: без чисел, uid и кодов комнат — одинаковые сбои схлопываются. */
function errorClass(e: string): string {
  return e.replace(/\[room [A-Z0-9]+\]/g, '[room]').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uid>').replace(/\d+/g, 'N').slice(0, 120);
}

/**
 * ⭐ САМОПРОВЕРКА ФАЗЗЕРА: `DM_FUZZ_SELFTEST=<имя>` вносит в менеджер или комнату ИЗВЕСТНЫЙ дефект (подменой метода на время
 * прогона), и прогон обязан его найти, — иначе инвариант ничего не ловит. Продукт не меняется: подмена живёт в памяти теста.
 *  • `i1-throw`   — обработка кадра `vote` бросает (I1);
 *  • `i2-mutate`  — кривой кадр со словом `constructor` добавляет золота первому герою (I2);
 *  • `i4-resync`  — на каждую кривую команду — полный сейв (I4);
 *  • `i5-rate`    — потолок команд города аккаунта: одна в 5 с (I3/I5);
 *  • `i6-leak`    — закрытие соединения не снимает его бакеты (I6);
 *  • `i7-dupe`    — выброшенная вещь остаётся и в сумке (I7);
 *  • `i8-stuck`   — прощальная запись героя h1 «не легла» навсегда: вход — «сохраняем, повторите» (I8).
 */
const SELFTEST = process.env.DM_FUZZ_SELFTEST ?? '';
function injectBug(name: string, rm: RMIn): () => void {
  const R = RoomProto;
  const M = rm as unknown as Record<string, (...a: unknown[]) => unknown>;
  const spies: { mockRestore(): void }[] = [];
  switch (name) {
    case 'i1-throw': {
      const orig = M.onFrame!;
      spies.push(vi.spyOn(M, 'onFrame').mockImplementation(function (this: unknown, ws: unknown, frame: unknown) {
        if ((frame as { t?: unknown }).t === 'vote') return Promise.reject(new Error('самопроверка: vote'));
        return orig.call(this, ws, frame);
      }));
      break;
    }
    case 'i2-mutate': {
      const orig = M.accept!;
      spies.push(vi.spyOn(M, 'accept').mockImplementation(function (this: unknown, ws: unknown, raw: unknown) {
        if (typeof raw === 'string' && raw.includes('constructor')) {
          const room = rm.rooms.values().next().value;
          const p = room && Object.values(room.session.world.players)[0];
          if (p) p.save.gold += 1;
        }
        return orig.call(this, ws, raw);
      }));
      break;
    }
    case 'i4-resync': {
      const orig = R.warnInvalid!;
      spies.push(vi.spyOn(R, 'warnInvalid').mockImplementation(function (this: { sendSave(pid: string): void }, c: unknown, ...rest: unknown[]) {
        this.sendSave((c as { pid: string }).pid);
        return orig.call(this, c, ...rest);
      }));
      break;
    }
    case 'i5-rate': {
      const orig = limits.townCmd.take.bind(limits.townCmd);
      let last = -Infinity;
      spies.push(vi.spyOn(limits.townCmd, 'take').mockImplementation((key: string, now?: number) => {
        const t = now ?? performance.now();
        if (t - last < 5000) return false;
        last = t;
        return orig(key, now);
      }));
      break;
    }
    case 'i6-leak': spies.push(vi.spyOn(M, 'forgetConn').mockImplementation(() => undefined)); break;
    case 'i8-stuck': {
      const orig = M.settleFarewell!;
      spies.push(vi.spyOn(M, 'settleFarewell').mockImplementation(function (this: unknown, charId: unknown) {
        return charId === 'h1' ? Promise.resolve(false) : orig.call(this, charId);
      }));
      break;
    }
    case 'i7-dupe': {
      const orig = R.dispatch!;
      spies.push(vi.spyOn(R, 'dispatch').mockImplementation(async function (this: unknown, c: unknown, pid: unknown, save: unknown, command: unknown) {
        const cmd = command as { cmd: string; uid?: string };
        const sv = save as SaveState;
        const it = cmd.cmd === 'drop' ? sv.inventory.find((i) => i.uid === cmd.uid) : undefined;
        const out = await orig.call(this, c, pid, save, command) as { ok: boolean };
        if (it && out.ok && !sv.inventory.includes(it)) sv.inventory.push(it);
        return out;
      }));
      break;
    }
    default: throw new Error(`неизвестная самопроверка ${name}`);
  }
  return () => { for (const sp of spies) sp.mockRestore(); };
}

/** `DM_FUZZ_STATS=1` — и время по видам операций (вид → [сколько, мс]). */
const PROFILE: Map<string, [number, number]> | null = process.env.DM_FUZZ_STATS === '1' ? new Map() : null;

/** `DM_FUZZ_TRACE=1` — построчный след операций (отладка модели). */
const TRACE = process.env.DM_FUZZ_TRACE === '1';
const TRACE_LINES: string[] = [];

// ── Генератор последовательности ────────────────────────────────────────────
const OPS_PER_SEQ = Math.max(10, Number(process.env.DM_FUZZ_OPS ?? 60) || 60);
/** Действия честного из нескольких кадров с ожиданием ответа между ними — гонкой не исполняются. */
const MULTI_STEP: ReadonlySet<string> = new Set(['enter', 'joinFriend', 'reconnect', 'flap', 'input']);

function genOps(seed: number, len = OPS_PER_SEQ): Op[] {
  const r = new Prng(seed);
  if (r.chance(0.4)) return genPartyOps(r, len);
  const ops: Op[] = [];
  const mode = (): Mode => (r.chance(0.5) ? 'uws' : 'ws');
  const party = r.chance(0.5);
  const others: number[] = [];
  if (r.chance(0.35)) others.push(2);
  if (r.chance(0.7)) others.push(3);
  if (r.chance(0.25)) others.push(4);
  for (let a = r.int(4); a > 0; a--) others.push(5 + a - 1);
  if (!others.length) others.push(5);
  const honest = party ? [0, 1] : [0];
  ops.push({ k: 'open', s: 0, mode: mode(), ip: 0 });
  ops.push({ k: 'honest', s: 0, act: { a: 'enter', p: r.int(1000) } });
  if (party) {
    ops.push({ k: 'open', s: 1, mode: mode(), ip: r.chance(0.5) ? 0 : 1 });
    ops.push({ k: 'honest', s: 1, act: r.chance(0.6) ? { a: 'joinFriend' } : { a: 'enter', p: r.int(1000) } });
  }
  const openOp = (s: number): Op => (r.chance(0.12) ? { k: 'open', s, mode: mode(), ip: r.int(IPS.length), slow: true } : { k: 'open', s, mode: mode(), ip: r.int(IPS.length) });
  for (const s of others) ops.push(openOp(s));
  const honestAct = (s: number): HonestAct => r.weighted<HonestAct>([
    [10, { a: 'ping' }],
    [14, { a: 'input', n: r.range(1, 20), hz: r.chance(0.5) ? 30 : 60, press: r.pick([0, 0, 1, 2, 3] as const), mv: r.int(16) }],
    [24, { a: 'cmd', cmd: r.weighted(HONEST_CMDS), pick: r.int(1 << 16) }],
    [4, { a: 'enter', p: r.int(1000) }],
    [s === 1 ? 4 : 0, { a: 'joinFriend' }],
    [6, { a: 'descend', alt: r.chance(0.5) }],
    [5, { a: 'return' }],
    [2, { a: 'arena' }],
    [3, { a: 'lever' }],
    [3, { a: 'chest' }],
    [3, { a: 'leave' }],
    [3, { a: 'reconnect', mode: mode(), p: r.int(1000) }],
    [2, { a: 'flap', mode: mode(), p: r.int(1000) }],
    [3, { a: 'runStatus' }],
  ]);
  const junk = (): Junk => r.weighted<Junk>([
    [40, { j: 'mutate', base: r.weighted(FRAME_KINDS), seed: r.fork() }],
    [8, { j: 'text', seed: r.fork(), len: r.pick([1, 16, 200, 1000, 5000]) }],
    [5, { j: 'binary', seed: r.fork(), len: r.pick([0, 1, 30, 500]) }],
    [3, { j: 'oversize', seed: r.fork(), len: r.pick([16_400, 40_000]) }],
    [10, { j: 'flood', base: r.weighted(FRAME_KINDS), n: r.pick([10, 50, 130, 320]), seed: r.fork(), mutate: r.chance(0.5) }],
    [25, { j: 'valid', base: r.weighted(FRAME_KINDS), seed: r.fork() }],
    [9, { j: 'foreign', what: r.pick(['join', 'runStatus', 'abandon'] as const), seed: r.fork() }],
  ]);
  for (let i = 0; i < len; i++) {
    const what = r.weighted([[38, 'honest'], [40, 'junk'], [5, 'enterOther'], [4, 'churn'], [8, 'wait'], [4, 'tick'], [1.5, 'wsClose'], [0.5, 'expire']] as const);
    switch (what) {
      case 'enterOther': {
        // Чужой аккаунт (или соседняя сессия) входит честным кадром: в свою комнату или к честному по коду (приглашённый в пати).
        const withAcct = others.filter((s) => SLOT_ACCT[s]);
        if (!withAcct.length) break;
        ops.push({ k: 'junk', s: r.pick(withAcct), junk: { j: 'valid', base: r.pick(['join', 'joinCode', 'joinCode', 'resume'] as const), seed: r.fork() } });
        break;
      }
      case 'honest': {
        const s = r.pick(honest);
        const act = honestAct(s);
        // Одиночный кадр честного может уйти, не дожидаясь базы (гонка с кадрами других соединений); вход и переподключение — нет.
        const single = !MULTI_STEP.has(act.a);
        ops.push(single && r.chance(0.3) ? { k: 'honest', s, act, race: true } : { k: 'honest', s, act });
        break;
      }
      case 'junk': { const j = junk(); ops.push(r.chance(0.25) ? { k: 'junk', s: r.pick(others), junk: j, race: true } : { k: 'junk', s: r.pick(others), junk: j }); break; }
      case 'churn': {
        const s = r.pick(others);
        ops.push(r.chance(0.4) ? { k: 'close', s, race: true } : { k: 'close', s }, openOp(s));
        break;
      }
      case 'wait': ops.push({ k: 'wait', ms: r.pick([50, 200, 1000, 3000, 12_000, 20_000]) }); break;
      case 'tick': ops.push({ k: 'tick', n: r.pick([1, 5, 30, 90]) }); break;
      case 'wsClose': ops.push({ k: 'wsClose' }); break;
      case 'expire': ops.push({ k: 'expire' }); break;
    }
  }
  return ops;
}

/**
 * ⭐ СЦЕНАРИЙ «ПАТИ С ЧУЖИМИ»: в комнате честного — вторая сессия его же аккаунта (другой герой), чужой аккаунт и, иногда, друг. Упор —
 * на ВЕЩИ между ними: выброс, подбор, сундук аккаунта, лавка — вперемешку с уходами, обрывами, переходами и гонками с ожиданием базы.
 * Здесь живут дюпы через соседа по аккаунту (R1-01, R2-08, R14-04 …): I7 ловит вещь в двух местах.
 */
const TRADE_CMDS: readonly (readonly [number, CmdKind])[] = [
  [8, 'drop'], [8, 'pickup'], [6, 'stashMove'], [3, 'stashOpen'], [3, 'sell'], [3, 'buy'], [2, 'moveItem'], [2, 'useConsumable'],
  [2, 'moveBelt'], [2, 'equip'], [2, 'unequip'], [1, 'salvage'], [1, 'depositMaterials'],
];
function genPartyOps(r: Prng, len: number): Op[] {
  const ops: Op[] = [];
  const mode = (): Mode => (r.chance(0.5) ? 'uws' : 'ws');
  const friend = r.chance(0.4);
  // Двойник: слот 2 — вторая вкладка ТОГО ЖЕ героя (вытеснение туда-обратно посреди обмена вещами).
  const twin = r.chance(0.3);
  const open2 = (): Op => (twin ? { k: 'open', s: 2, mode: mode(), ip: 0, twin: true } : { k: 'open', s: 2, mode: mode(), ip: 0 });
  ops.push({ k: 'open', s: 0, mode: mode(), ip: 0 }, { k: 'honest', s: 0, act: { a: 'enter', p: r.int(1000) } });
  ops.push(open2(), { k: 'junk', s: 2, junk: { j: 'valid', base: 'joinCode', seed: r.fork() } });
  ops.push({ k: 'open', s: 3, mode: mode(), ip: 0 }, { k: 'junk', s: 3, junk: { j: 'valid', base: 'joinCode', seed: r.fork() } });
  if (friend) ops.push({ k: 'open', s: 1, mode: mode(), ip: 1 }, { k: 'honest', s: 1, act: { a: 'joinFriend' } });
  const honest = friend ? [0, 1] : [0];
  const maybeRace = <T extends Op>(op: T): Op => (r.chance(0.4) && (op.k === 'junk' || op.k === 'close' || (op.k === 'honest' && !MULTI_STEP.has(op.act.a))) ? { ...op, race: true } as Op : op);
  for (let i = 0; i < len; i++) {
    const what = r.weighted([
      [26, 'honestTrade'], [22, 'siblingTrade'], [6, 'attackerTrade'], [8, 'junk'], [7, 'honestMove'], [6, 'siblingMove'],
      [6, 'vote'], [4, 'input'], [6, 'wait'], [3, 'tick'], [1.5, 'wsClose'], [0.5, 'expire'],
    ] as const);
    switch (what) {
      case 'honestTrade': ops.push(maybeRace({ k: 'honest', s: r.pick(honest), act: { a: 'cmd', cmd: r.weighted(TRADE_CMDS), pick: r.int(1 << 16) } })); break;
      case 'siblingTrade': ops.push(maybeRace({ k: 'junk', s: 2, junk: { j: 'cmd', cmd: r.weighted(TRADE_CMDS), pick: r.int(1 << 16), seed: r.fork() } })); break;
      case 'attackerTrade': ops.push(maybeRace({ k: 'junk', s: 3, junk: { j: 'cmd', cmd: r.weighted(TRADE_CMDS), pick: r.int(1 << 16), seed: r.fork() } })); break;
      case 'junk': ops.push(maybeRace({ k: 'junk', s: r.pick([2, 3]), junk: r.chance(0.7) ? { j: 'mutate', base: r.weighted(FRAME_KINDS), seed: r.fork() } : { j: 'flood', base: r.weighted(FRAME_KINDS), n: r.pick([10, 50, 130]), seed: r.fork(), mutate: r.chance(0.5) } })); break;
      case 'honestMove': {
        const s = r.pick(honest);
        ops.push(maybeRace({ k: 'honest', s, act: r.weighted<HonestAct>([
          [3, { a: 'leave' }], [3, { a: 'reconnect', mode: mode(), p: r.int(1000) }], [3, { a: 'flap', mode: mode(), p: r.int(1000) }],
          [3, { a: 'enter', p: r.int(1000) }], [s === 1 ? 3 : 0, { a: 'joinFriend' }], [2, { a: 'runStatus' }],
        ]) }));
        break;
      }
      case 'siblingMove': {
        // Вторая вкладка аккаунта уходит и возвращается — к честному по коду, в свою комнату или «Продолжить», иногда обрывом.
        const s = r.pick([2, 3]);
        if (r.chance(0.5)) ops.push(maybeRace({ k: 'close', s }), s === 2 ? open2() : { k: 'open', s, mode: mode(), ip: 0 });
        else ops.push(maybeRace({ k: 'junk', s, junk: { j: 'valid', base: 'leave', seed: r.fork() } }));
        ops.push(maybeRace({ k: 'junk', s, junk: { j: 'valid', base: r.pick(['joinCode', 'joinCode', 'join', 'resume', 'abandon'] as const), seed: r.fork() } }));
        break;
      }
      case 'vote': ops.push(maybeRace(r.chance(0.6)
        ? { k: 'honest', s: r.pick(honest), act: r.weighted<HonestAct>([[3, { a: 'descend', alt: r.chance(0.5) }], [3, { a: 'return' }], [1, { a: 'arena' }], [1, { a: 'chest' }], [1, { a: 'lever' }]]) }
        : { k: 'junk', s: r.pick([2, 3]), junk: { j: 'valid', base: r.pick(['vote', 'vote', 'descend', 'return', 'arena'] as const), seed: r.fork() } })); break;
      case 'input': ops.push({ k: 'honest', s: r.pick(honest), act: { a: 'input', n: r.range(1, 20), hz: r.chance(0.5) ? 30 : 60, press: r.pick([0, 0, 1, 3] as const), mv: r.int(16) } }); break;
      case 'wait': ops.push({ k: 'wait', ms: r.pick([50, 200, 1000, 3000, 12_000]) }); break;
      case 'tick': ops.push({ k: 'tick', n: r.pick([1, 5, 30]) }); break;
      case 'wsClose': ops.push({ k: 'wsClose' }); break;
      case 'expire': ops.push({ k: 'expire' }); break;
    }
  }
  return ops;
}

/** Прогнать последовательность с миром сида `seed`. */
async function runOps(ops: readonly Op[], seed: number): Promise<Run> {
  const run = new Run(seed);
  run.setup();
  try {
    for (const op of ops) {
      const t = process.hrtime.bigint();
      await run.exec(op);
      if (PROFILE) {
        const k = op.k === 'honest' ? `honest:${op.act.a}` : op.k === 'junk' ? `junk:${op.junk.j}` : op.k;
        const e = PROFILE.get(k) ?? [0, 0];
        PROFILE.set(k, [e[0] + 1, e[1] + Number(process.hrtime.bigint() - t) / 1e6]);
      }
    }
    const tf = process.hrtime.bigint();
    await run.finish();
    if (PROFILE) { const e = PROFILE.get('finish') ?? [0, 0]; PROFILE.set('finish', [e[0] + 1, e[1] + Number(process.hrtime.bigint() - tf) / 1e6]); }
  } catch (e) {
    run.violate('I1', `бросок из прогона: ${errorClass(String(e))}`, e instanceof Error ? e.stack ?? e.message : String(e));
  } finally {
    run.teardown();
  }
  return run;
}

// ── Прогон и отчёт ──────────────────────────────────────────────────────────
/**
 * ⚠ ИЗВЕСТНЫЕ НАРУШЕНИЯ — найденные этим фаззером и ждущие правки продукта: ключ (`Violation.key`) → причина. Пока запись здесь,
 * основной прогон их печатает, но не падает на них; ниже — `it.fails` с ужатой последовательностью на каждое (правка продукта
 * снимает и запись, и `.fails`).
 */
const KNOWN: Record<string, string> = {
  // B3-V1 (кадры сокета `ws` в `CLOSING` действовали) и B3-V2 (снятие сессии ждало события `close` транспорта) исправлены: закрытие,
  // начатое сервером, окончательно сразу (`WsConn.close`), менеджер кадров закрытого соединения не исполняет и на мёртвый сокет не садит
  // (`RoomManager.handleConnection`, `join`). Их воспроизведения ниже — обычные тесты, а ключи I9 стережёт основной прогон.
};

/** B3-V1: закрытый за поток (4008) сокет `ws` через 3 с (бакет пополнился) входил заново и выбрасывал вещь. */
const V1_OPS: Op[] = [
  { k: 'open', s: 3, mode: 'ws', ip: 1 },
  { k: 'junk', s: 3, junk: { j: 'valid', base: 'join', seed: 11 } },
  { k: 'junk', s: 3, junk: { j: 'flood', base: 'ping', n: 130, seed: 12, mutate: false } },
  { k: 'wait', ms: 3000 },
  { k: 'junk', s: 3, junk: { j: 'valid', base: 'join', seed: 13 } },
  { k: 'junk', s: 3, junk: { j: 'cmd', cmd: 'drop', pick: 1, seed: 14 } },
];
/** B3-V2: 320 входов подряд — после 120-го закрытие за поток (4008), а первый вход из очереди соединения садил игрока уже после снятия. */
const V2_OPS: Op[] = [
  { k: 'open', s: 3, mode: 'ws', ip: 1 },
  { k: 'junk', s: 3, junk: { j: 'flood', base: 'join', n: 320, seed: 2185022913, mutate: false }, race: true },
];

const DEFAULT_SEEDS = Array.from({ length: 32 }, (_, i) => 0x1000 + i * 7919);
function seedsToRun(): number[] {
  const n = Number(process.env.DM_FUZZ_SEEDS ?? 0);
  if (!n) return DEFAULT_SEEDS;
  const from = Number(process.env.DM_FUZZ_FROM ?? 1);
  return Array.from({ length: n }, (_, i) => from + i);
}

/**
 * Повтор ужатой последовательности из отчёта: `DM_FUZZ_REPLAY=<файл.json>` (`{ "seed": N, "ops": [...] }`) — прогон со следом
 * операций (`DM_FUZZ_TRACE=1`) и перечнем нарушений. Для разбора и для шага правки.
 */
describe.runIf(!!process.env.DM_FUZZ_REPLAY)('B3: повтор последовательности', () => {
  it('повтор', async () => {
    const { readFileSync } = await import('node:fs');
    const { seed, ops } = JSON.parse(readFileSync(process.env.DM_FUZZ_REPLAY!, 'utf8')) as { seed: number; ops: Op[] };
    const run = await runOps(ops, seed);
    console.info(`${TRACE_LINES.join('\n')}\n${run.violations.map((v) => `#${v.op} ${v.key}: ${v.detail}`).join('\n') || 'нарушений нет'}`);
  });
});

describe.skipIf(!!process.env.DM_FUZZ_REPLAY)('⭐ B3: фаззер протокола — инварианты целостности на случайных последовательностях кадров', () => {
  it('ни одного нарушения I1–I8 на наборе сидов (нарушение — сид и ужатая последовательность в отчёте)', async () => {
    const seeds = seedsToRun();
    const found = new Map<string, { seed: number; v: Violation; ops: Op[]; count: number }>();
    const amp = new Map<string, [number, number, number]>();
    const stats = new Map<string, number>();
    const t0 = process.hrtime.bigint();
    const slow: [number, number][] = [];
    for (const seed of seeds) {
      const ops = genOps(seed);
      const ts = process.hrtime.bigint();
      const run = await runOps(ops, seed);
      slow.push([Number(process.hrtime.bigint() - ts) / 1e6, seed]);
      for (const [k, v] of run.amp) { const a = amp.get(k) ?? [0, 0, 0]; amp.set(k, [a[0] + v[0], a[1] + v[1], a[2] + v[2]]); }
      for (const [k, v] of run.stats) stats.set(k, (stats.get(k) ?? 0) + v);
      for (const v of run.violations) {
        const f = found.get(v.key);
        if (f) f.count++; else found.set(v.key, { seed, v, ops, count: 1 });
      }
    }
    const report: string[] = [];
    for (const [key, f] of found) {
      if (KNOWN[key] && process.env.DM_FUZZ_SHRINK !== '1') { report.push(`── [известное] ${key}   (сид ${f.seed}, встреч ${f.count})\n   ${f.v.detail}`); continue; }
      const min = await shrinkOps(f.ops.slice(0, f.v.op + 1), async (o) => (await runOps(o, f.seed)).violations.some((v) => v.key === key), 250);
      const again = await runOps(min, f.seed);
      const v = again.violations.find((x) => x.key === key) ?? f.v;
      report.push([
        `── ${KNOWN[key] ? '[известное] ' : ''}${key}   (сид ${f.seed}, встреч ${f.count}, ужато ${f.ops.length} → ${min.length} операций)`,
        `   ${v.detail}`,
        ...min.map((o, i) => `   ${String(i).padStart(3)} ${JSON.stringify(o)}`),
      ].join('\n'));
    }
    const ampLines = [...amp].sort((a, b) => b[1][2] / Math.max(1, b[1][1]) - a[1][2] / Math.max(1, a[1][1])).slice(0, 12)
      .map(([k, [n, i, o]]) => `   ${k.padEnd(22)} кадров ${String(n).padStart(6)}  вход ${String(i).padStart(9)} Б  выход ${String(o).padStart(9)} Б  ×${(o / Math.max(1, i)).toFixed(2)}`);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.info(`[fuzz] сидов ${seeds.length} × ${OPS_PER_SEQ} операций за ${(ms / 1000).toFixed(1)} с; разных нарушений: ${found.size}\n${report.join('\n')}\n[fuzz] усиление по видам мусора:\n${ampLines.join('\n')}`);
    if (PROFILE) console.info(`[fuzz] время по операциям: ${[...PROFILE].sort((a, b) => b[1][1] - a[1][1]).map(([k, [n, t]]) => `${k} ${n}×${(t / n).toFixed(1)}=${(t / 1000).toFixed(1)}с`).join(', ')}`);
    if (process.env.DM_FUZZ_STATS === '1') console.info(`[fuzz] самые долгие сиды: ${slow.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([t, sd]) => `${sd}:${t.toFixed(0)}мс`).join(', ')}`);
    if (process.env.DM_FUZZ_STATS === '1') console.info([...stats].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(7)}  ${k}`).join(String.fromCharCode(10)));
    if (TRACE) console.info(TRACE_LINES.join('\n'));
    const unknown = [...found.keys()].filter((k) => !KNOWN[k]);
    expect(unknown, report.join('\n')).toEqual([]);
  });

  // B3-V1, B3-V2 — найденное фаззером и исправленное (см. `KNOWN`): ужатые последовательности держат правку.
  const i9 = (run: Run): string[] => run.violations.filter((v) => v.inv === 'I9').map((v) => `${v.key}: ${v.detail}`);
  it('B3-V1 (ws): закрытый за поток кадров (4008) сокет не входит заново тем же соединением и не выбрасывает вещь', async () => {
    expect(i9(await runOps(V1_OPS, 7))).toEqual([]);
  });
  it('B3-V2 (ws): вход из очереди соединения, закрытого за поток (4008), не садит игрока на мёртвый сокет', async () => {
    expect(i9(await runOps(V2_OPS, 40014))).toEqual([]);
  });
  it('B3-V2 (ws): медленный читатель закрыт (1013) — игрок снят сразу, а не по концу рукопожатия закрытия', async () => {
    expect(i9(await runOps([
      { k: 'open', s: 3, mode: 'ws', ip: 3, slow: true },
      { k: 'junk', s: 3, junk: { j: 'valid', base: 'join', seed: 106966162 } },
      { k: 'junk', s: 3, junk: { j: 'flood', base: 'cmd', n: 10, seed: 1848656462, mutate: false } },
    ], 40068))).toEqual([]);
  });
  // ⭐ E2E 28.09 (большой прогон, сид 50734): медленный читатель упёрся в потолок неотправленного ПОСРЕДИ кадров входа (`addPlayer` шлёт
  // десятки КБ: этаж, сейв, лавка) — транспорт закрыл его (1013) и позвал `onClose`, пока соединение ещё не записано игроком, а вход
  // записывал его следом: призрак в комнате честного навсегда (место в пати, живая сессия, комната на тике). На обоих транспортах.
  it('E2E 28.09: закрытый посреди кадров входа (1013) — не игрок; комната честного без призрака и подметается (ws и uWS)', async () => {
    for (const mode of ['ws', 'uws'] as const) {
      const run = await runOps([
        { k: 'open', s: 0, mode: 'uws', ip: 0 },
        { k: 'honest', s: 0, act: { a: 'enter', p: 858 } },
        { k: 'open', s: 3, mode, ip: 3, slow: true },
        { k: 'junk', s: 3, junk: { j: 'valid', base: 'joinCode', seed: 2204480449 } },
        { k: 'junk', s: 3, junk: { j: 'valid', base: 'leave', seed: 1868398087 } },
        { k: 'junk', s: 3, junk: { j: 'valid', base: 'joinCode', seed: 2293392711 } },
      ], 50734);
      expect(run.violations.map((v) => `${mode} #${v.op} ${v.key}: ${v.detail}`)).toEqual([]);
    }
  });
  it('контроль: те же последовательности на uWS — закрытие окончательно, нарушений нет', async () => {
    const uws = (ops: Op[]): Op[] => ops.map((o) => (o.k === 'open' ? { ...o, mode: 'uws' } : o));
    expect(i9(await runOps(uws(V1_OPS), 7))).toEqual([]);
    expect(i9(await runOps(uws(V2_OPS), 40014))).toEqual([]);
  });

  /**
   * I6 В МАСШТАБЕ: сотни «открыл — пара кадров — закрыл» (аноним, чужой аккаунт; с одного адреса и с сотен разных; оба транспорта;
   * иногда закрытие посреди ожидания базы). Карты на соединение после закрытий пусты; карты на адрес — не больше ступеней сети на
   * адрес (с одного адреса — не растут вовсе); через 11 минут простоя подметено всё.
   */
  it('I6: 600 циклов «открыл — кадры — закрыл» не оставляют следов ни на соединение, ни на адрес', async () => {
    const r = new Prng(0xc1c1e);
    const ops: Op[] = [];
    const kinds: FrameKind[] = ['runStatus', 'join', 'joinCode', 'abandon', 'ping', 'input', 'cmd', 'vote'];
    for (let i = 0; i < 600; i++) {
      const s = r.pick([3, 5, 6, 7]);
      // Первая половина — с одного адреса (NAT), вторая — каждый со своего.
      ops.push({ k: 'open', s, mode: r.chance(0.5) ? 'uws' : 'ws', ip: i < 300 ? 0 : 4 + i, ...(r.chance(0.05) ? { slow: true as const } : {}) });
      for (let n = r.range(1, 3); n > 0; n--) {
        const base = r.pick(kinds);
        const junk: Junk = r.chance(0.5) ? { j: 'valid', base, seed: r.fork() } : r.chance(0.7) ? { j: 'mutate', base, seed: r.fork() } : { j: 'text', seed: r.fork(), len: 64 };
        ops.push(r.chance(0.3) ? { k: 'junk', s, junk, race: true } : { k: 'junk', s, junk });
      }
      ops.push(r.chance(0.3) ? { k: 'close', s, race: true } : { k: 'close', s });
      if (i % 50 === 49) ops.push({ k: 'wsClose' });
    }
    const run = new Run(0xc1c1e);
    run.setup();
    const sizes: Record<string, number> = {};
    try {
      for (const op of ops) await run.exec(op);
      await run.exec({ k: 'wsClose' });
      await run.quiesce();
      // До подметания по времени: на соединение — пусто, на адрес — ступени сети адресов, с которых были мусорные токены и промахи.
      const addrs = new Set(ops.filter((o): o is Extract<Op, { k: 'open' }> => o.k === 'open').map((o) => ipOf(o.ip)));
      for (const [name, l] of Object.entries(limits)) sizes[name] = l.size;
      const rm = run.rm;
      expect({ conns: rm.conns.size, inputRate: rm.inputRate.size, charOps: rm.charOps.size, sessionLookups: rm.sessionLookups.size })
        .toEqual({ conns: 0, inputRate: 0, charOps: 0, sessionLookups: 0 });
      expect({ wsFrames: sizes.wsFrames, wsInput: sizes.wsInput, lobbyConn: sizes.lobbyConn }).toEqual({ wsFrames: 0, wsInput: 0, lobbyConn: 0 });
      expect(keysOf(limits.roomCodeMiss).filter((k) => k.startsWith('conn:')), 'промахи кода на соединение').toEqual([]);
      expect(sizes.lobbyIp!, 'бакеты адреса: не больше трёх ступеней на адрес').toBeLessThanOrEqual(3 * addrs.size);
      expect(keysOf(limits.lobbyIp).filter((k) => k.includes('198.51.100.7')).length, 'NAT: 300 соединений — один бакет').toBeLessThanOrEqual(1);
      await run.finish();
    } finally { run.teardown(); }
    console.info(`[fuzz] I6-циклы: размеры лимитеров до подметания: ${JSON.stringify(sizes)}`);
    expect(run.violations.map((v) => `${v.key}: ${v.detail}`)).toEqual([]);
  });
});

// ── HTTP: ручки аккаунта ─────────────────────────────────────────────────────
/**
 * ⭐ B3/HTTP — ТЕ ЖЕ ИНВАРИАНТЫ НА РУЧКАХ АККАУНТА (`installAccountRoutes` за настоящим express, запросы — по сети на порт 0 петли;
 * адрес клиента — `X-Forwarded-For` от прокси на петле, как за Caddy). Честный — известная сессия, устройство, где он уже входил;
 * тролль — свой аккаунт за тем же NAT; анонимы — без сессии, с чужих адресов. Кривые тела (мутации честных), мусорные заголовки
 * `Authorization`, чужие id в пути, тела больше потолка, не тот `Content-Type`.
 *  H1 — ни одного 500 и `console.error`;
 *  H2 — чужие запросы не трогают честного (его герои, сессии, пароль);
 *  H3 — честный в честном темпе получает свой ответ (429 — только по документированному потолку НИКА, R3-07, когда тролль бил в его ник);
 *  H4 — запрос, не прошедший разбор (ник, пароль, имя, id), ничего в базе не создаёт и не удаляет.
 */
type HttpWho = 'honest' | 'troll' | 'anon';
interface HttpOp { who: HttpWho; kind: string; seed: number }
const HTTP_IP = { honest: '198.51.100.7', troll: '198.51.100.7' } as const;
const HONEST_PASS = 'honest-pass-1';
const TROLL_PASS = 'troll-pass-1';
const TOK_H = 'a1'.repeat(32);
const TOK_T = 'b2'.repeat(32);
/** Покрытие HTTP-части: «кто:что статус» → сколько (`DM_FUZZ_STATS=1`). */
const HTTP_STATS = new Map<string, number>();

function genHttpOps(seed: number, len = 40): HttpOp[] {
  const r = new Prng(seed);
  const ops: HttpOp[] = [];
  for (let i = 0; i < len; i++) {
    const who = r.weighted<HttpWho>([[30, 'honest'], [45, 'troll'], [25, 'anon']]);
    const kind = who === 'honest'
      ? r.weighted([[5, 'roster'], [2, 'create'], [2, 'delete'], [1, 'login']] as const)
      : r.weighted([[4, 'register'], [4, 'login'], [who === 'troll' ? 3 : 0, 'loginHonest'], [4, 'create'], [3, 'delete'], [who === 'troll' ? 3 : 0, 'deleteForeign'],
        [3, 'roster'], [1, 'logout'], [1, 'logoutAll'], [3, 'raw'], [1, 'big'], [2, 'ctype'], [2, 'auth']] as const);
    ops.push({ who, kind, seed: r.fork() });
  }
  return ops;
}

describe.skipIf(!!process.env.DM_FUZZ_REPLAY)('⭐ B3: фаззер HTTP-ручек аккаунта', () => {
  let base = '';
  let server: import('node:http').Server | undefined;
  let hashes: { h: { hash: string; salt: string }; t: { hash: string; salt: string } };
  let mod: {
    deviceToken(who: string): string;
    parseCreds(b: unknown, m: 'register' | 'login'): { ok: boolean };
    parseNewCharacter(b: unknown): { ok: boolean };
    isCharId(v: unknown): boolean;
    noteSession(token: string, userId: string): void;
  };
  beforeAll(async () => {
    const express = (await import('express')).default;
    const acc = await import('./accountRoutes.js');
    const { httpErrors } = await import('./asyncRoute.js');
    const { hashPassword } = await import('../auth/password.js');
    const { deviceToken } = await import('./deviceToken.js');
    const { noteSession } = await import('./authSession.js');
    mod = { deviceToken, parseCreds: acc.parseCreds, parseNewCharacter: acc.parseNewCharacter, isCharId: acc.isCharId, noteSession };
    const app = express();
    acc.installAccountRoutes(app, { config: cfg });
    app.use(httpErrors);
    const srv = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server = srv;
    base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    hashes = { h: await hashPassword(HONEST_PASS), t: await hashPassword(TROLL_PASS) };
  });
  afterAll(() => { server?.close(); });

  async function call(method: string, path: string, o: { body?: string; token?: string; auth?: string; ip: string; ct?: string }): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'x-forwarded-for': o.ip };
    if (o.ct !== '') headers['content-type'] = o.ct ?? 'application/json';
    if (o.auth !== undefined) headers.authorization = o.auth; else if (o.token) headers.authorization = `Bearer ${o.token}`;
    const r = await fetch(base + path, { method, headers, body: o.body });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* не JSON */ }
    return { status: r.status, json };
  }

  /** Одна последовательность HTTP: нарушения (ключ — вид, как у сокетной части). */
  async function runHttp(ops: readonly HttpOp[], seed: number): Promise<Violation[]> {
    const out: Violation[] = [];
    const violate = (inv: string, kind: string, detail: string, op: number): void => { out.push({ key: `${inv}: ${kind}`, inv, detail: detail.slice(0, 400), op }); };
    for (const l of Object.values(limits)) for (const m of bucketsOf(l)) m.clear();
    for (const k of [...(known.sessions as unknown as { seen: Map<string, unknown> }).seen.keys()]) known.sessions.delete(k);
    for (const k of [...(known.names as unknown as { seen: Map<string, unknown> }).seen.keys()]) known.names.delete(k);
    db.sessions.clear(); db.chars.clear(); db.users.clear(); db.mut.length = 0; db.pgRejects.length = 0; db.lat = () => 0;
    const envRng = new Prng(seed ^ 0x77);
    rnd.next = () => envRng.next();
    db.users.set('honest', { id: 'u-honest', username: 'honest', passHash: hashes.h.hash, passSalt: hashes.h.salt, net: HTTP_IP.honest });
    db.users.set('troll', { id: 'u-troll', username: 'troll', passHash: hashes.t.hash, passSalt: hashes.t.salt, net: HTTP_IP.troll });
    db.sessions.set(TOK_H, 'u-honest');
    db.sessions.set(TOK_T, 'u-troll');
    mod.noteSession(TOK_H, 'u-honest');
    mod.noteSession(TOK_T, 'u-troll');
    known.names.add('honest'); known.names.add('troll');
    db.chars.set('hc-1', { userId: 'u-honest', data: newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Честный', 'hc-1'), version: 1 });
    db.chars.set('tc-1', { userId: 'u-troll', data: newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Тролль', 'tc-1'), version: 1 });
    const device = mod.deviceToken('honest');
    const cls = cfg.get('classes').find((c) => c.enabled !== false)!.id;
    const errors: string[] = [];
    const sErr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ').slice(0, 300)); });
    const sWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const honestDigest = (): string => JSON.stringify({
      chars: [...db.chars].filter(([, r]) => r.userId === 'u-honest').map(([id]) => id).sort(),
      sessions: [...db.sessions].filter(([, u]) => u === 'u-honest').map(([t]) => t).sort(),
      pass: db.users.get('honest')?.passHash,
    });
    const created: string[] = [];
    let honestLogins = 0;
    let createdTotal = 0;
    let trollHitHonestNick = false;
    try {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        const r = new Prng(op.seed);
        const maybeMutate = (v: unknown): { body: string; parsed: unknown } => {
          const body = r.chance(0.65) ? mutateFrame(v, op.seed).raw : JSON.stringify(v);
          // Оракул судит то, что разберёт express: тело уходит в UTF-8 (непарный суррогат — U+FFFD), `body-parser` снимает BOM.
          let wire = Buffer.from(body, 'utf8').toString('utf8');
          if (wire.charCodeAt(0) === 0xfeff) wire = wire.slice(1);
          let parsed: unknown;
          try { parsed = JSON.parse(wire); } catch { parsed = undefined; }
          return { body, parsed };
        };
        const ip = op.who === 'anon' ? r.pick(['203.0.113.50', '2001:db8:9:9::1', '192.0.2.77']) : HTTP_IP[op.who];
        const token = op.who === 'honest' ? TOK_H : op.who === 'troll' ? TOK_T : r.pick([TOK_UNKNOWN, 'cd'.repeat(32), 'nope']);
        const before = honestDigest();
        const mut0 = db.mut.length;
        const err0 = errors.length;
        let res: { status: number; json: Record<string, unknown> };
        let parseInvalid = false;
        let what = `${op.who}:${op.kind}`;
        if (op.who === 'honest') {
          if (op.kind === 'roster') {
            res = await call('GET', '/api/characters', { token, ip });
            if (res.status !== 200) violate('H3', `честный: ростер ${res.status}`, JSON.stringify(res.json), i);
          } else if (op.kind === 'create') {
            // Честный темп: героев создают единицы (потолок аккаунта — 5 разом, дальше один в 10 минут, R3-04).
            if (created.length >= 2 || createdTotal >= 3) continue;
            createdTotal++;
            res = await call('POST', '/api/characters', { token, ip, body: JSON.stringify({ classId: cls, name: `Герой${created.length}` }) });
            if (res.status === 200) created.push(String((res.json.character as { charId?: string } | undefined)?.charId));
            else violate('H3', `честный: создание героя ${res.status}`, JSON.stringify(res.json), i);
          } else if (op.kind === 'delete') {
            const id = created.pop();
            if (!id) continue;
            res = await call('DELETE', `/api/characters/${encodeURIComponent(id)}`, { token, ip });
            if (res.status !== 200) violate('H3', `честный: удаление своего героя ${res.status}`, JSON.stringify(res.json), i);
          } else {
            if (honestLogins++ >= 1) continue;
            res = await call('POST', '/api/login', { ip, body: JSON.stringify({ username: 'honest', password: HONEST_PASS, device }) });
            // R3-07: потолок НИКА — цена защиты от перебора: тролль, бивший в ник честного, запирает его вход на время (документировано).
            const nickLocked = res.status === 429 && trollHitHonestNick && !limits.loginUser.peek('honest');
            if (res.status !== 200 && !nickLocked) violate('H3', `честный: вход с устройства ${res.status}`, JSON.stringify(res.json), i);
          }
        } else {
          switch (op.kind) {
            case 'register': {
              const b = maybeMutate({ username: `tr${r.int(1e6)}`, password: 'pass-12345' });
              parseInvalid = !mod.parseCreds(b.parsed, 'register').ok;
              res = await call('POST', '/api/register', { ip, body: b.body });
              break;
            }
            case 'login': case 'loginHonest': {
              const nick = op.kind === 'loginHonest' ? 'honest' : r.pick(['troll', 'troll', `nobody${r.int(100)}`]);
              if (nick === 'honest') trollHitHonestNick = true;
              const b = maybeMutate({ username: nick, password: r.chance(0.3) && nick === 'troll' ? TROLL_PASS : 'wrong-pass-1' });
              parseInvalid = !mod.parseCreds(b.parsed, 'login').ok;
              res = await call('POST', '/api/login', { ip, body: b.body });
              break;
            }
            case 'create': {
              const b = maybeMutate({ classId: cls, name: `Т${r.int(100)}` });
              const pc = mod.parseNewCharacter(b.parsed);
              parseInvalid = !pc.ok || !cfg.get('classes').some((c) => c.id === (b.parsed as { classId?: unknown } | undefined)?.classId && c.enabled !== false);
              res = await call('POST', '/api/characters', { token, ip, body: b.body });
              break;
            }
            case 'delete': case 'deleteForeign': {
              const id = op.kind === 'deleteForeign' ? r.pick(['hc-1', ...created]) : r.pick(['tc-1', 'x'.repeat(65), 'a b', '..%2F..', '%00', 'hc-1%00', String.fromCharCode(0x0444)]);
              parseInvalid = !mod.isCharId(decodeURIComponentSafe(id));
              res = await call('DELETE', `/api/characters/${id.includes('%') ? id : encodeURIComponent(id)}`, { token, ip });
              break;
            }
            case 'roster': res = await call('GET', '/api/characters', { token, ip }); break;
            case 'logout': res = await call('POST', '/api/logout', { token, ip }); break;
            case 'logoutAll': res = await call('POST', '/api/logout-all', { token, ip }); break;
            case 'raw': {
              const j = junkText(op.seed, r.pick([0, 10, 300, 4000]));
              const path = r.pick(['/api/register', '/api/login', '/api/characters', '/api/logout']);
              parseInvalid = path !== '/api/logout';
              res = await call('POST', path, { ip, token, body: j.raw });
              what += ` ${path} ${j.how}`;
              break;
            }
            case 'big': {
              parseInvalid = true;
              res = await call('POST', r.pick(['/api/register', '/api/login', '/api/characters']), { ip, token, body: JSON.stringify({ username: 'troll', password: 'x'.repeat(9000) }) });
              break;
            }
            case 'ctype': {
              const b = JSON.stringify({ username: 'troll', password: TROLL_PASS });
              parseInvalid = true;
              res = await call('POST', r.pick(['/api/login', '/api/register', '/api/characters']), { ip, token, body: b, ct: r.pick(['text/plain', '', 'application/x-www-form-urlencoded', 'application/json; charset=utf-16']) });
              break;
            }
            default: {
              const auth = r.pick(['Bearer', 'Bearer ', `Bearer ${'a'.repeat(63)}`, `Bearer ${TOK_H.slice(0, 63)}X`, `Basic ${TOK_H}`, 'bearer   x', `Bearer ${'z'.repeat(64)}`, `${TOK_H}`]);
              res = await call(r.pick(['GET', 'POST']), r.pick(['/api/characters', '/api/logout-all']), { ip, auth });
              break;
            }
          }
          if (honestDigest() !== before) violate('H2', `чужой запрос изменил честного (${op.kind})`, `${what}: ${firstDiff(before, honestDigest())}`, i);
          if (parseInvalid && db.mut.length > mut0) violate('H4', `запрос, не прошедший разбор, изменил базу (${op.kind})`, `${what}: ${db.mut.slice(mut0).join(', ')}`, i);
        }
        HTTP_STATS.set(`${op.who}:${op.kind} ${res.status}`, (HTTP_STATS.get(`${op.who}:${op.kind} ${res.status}`) ?? 0) + 1);
        if (res.status >= 500 && res.status !== 503) violate('H1', `ответ ${res.status} (${what.split(' ')[0]})`, JSON.stringify(res.json), i);
        for (const e of errors.slice(err0)) violate('H1', `console.error: ${errorClass(e)}`, `${what}: ${e}`, i);
        for (const w of db.pgRejects.splice(0)) violate('H1', 'база отвергла запись по кодировке', `${what}: ${w}`, i);
      }
    } finally { sErr.mockRestore(); sWarn.mockRestore(); sLog.mockRestore(); }
    return out;
  }

  it('ни одного нарушения H1–H4 на наборе сидов', async () => {
    const n = Number(process.env.DM_FUZZ_HTTP_SEEDS ?? 0) || 8;
    const from = Number(process.env.DM_FUZZ_HTTP_FROM ?? 1);
    const found = new Map<string, { seed: number; v: Violation; ops: HttpOp[]; count: number }>();
    for (let seed = from; seed < from + n; seed++) {
      const ops = genHttpOps(seed);
      for (const v of await runHttp(ops, seed)) {
        const f = found.get(v.key);
        if (f) f.count++; else found.set(v.key, { seed, v, ops, count: 1 });
      }
    }
    const report: string[] = [];
    for (const [key, f] of found) {
      const min = await shrinkOps(f.ops.slice(0, f.v.op + 1), async (o) => (await runHttp(o, f.seed)).some((v) => v.key === key), 120);
      report.push([`── ${key}   (сид ${f.seed}, встреч ${f.count}, ужато ${f.ops.length} → ${min.length})`, `   ${f.v.detail}`, ...min.map((o, i) => `   ${String(i).padStart(3)} ${JSON.stringify(o)}`)].join('\n'));
    }
    if (process.env.DM_FUZZ_STATS === '1') console.info([...HTTP_STATS].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${String(c).padStart(6)}  ${k}`).join(String.fromCharCode(10)));
    console.info(`[fuzz-http] сидов ${n}; разных нарушений: ${found.size}\n${report.join('\n')}`);
    expect([...found.keys()].filter((k) => !KNOWN[k]), report.join('\n')).toEqual([]);
  });
});

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
