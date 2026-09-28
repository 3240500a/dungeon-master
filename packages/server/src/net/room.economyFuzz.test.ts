import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { GameConn } from './conn.js';
import { addToInventory, createRng, type ServerFrame, type SaveState, type AccountStash, type Item } from '@dm/shared';
import { limits } from './rateLimit.js';
import {
  OP_WEIGHTS, census, foundItem, genOps, newWorld, plan, stateInvariants, stepInvariants,
  type Census, type FuzzWorld, type Op, type OpKind, type Plan, type Res, type Violation,
} from '../../../shared/src/economy/fuzz/economyFuzz.js';

// Комната ждёт базу оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решает мок базы.
// Большой прогон (`DM_FUZZ_ROOM_SEEDS`) — потолок по числу цепочек: под нагрузкой цепочка — до полусекунды, и 1600 цепочек упирались в 600 с
// (итог печатается только в конце — терялось всё).
vi.setConfig({ testTimeout: Math.max(600_000, (Number(process.env.DM_FUZZ_ROOM_SEEDS) || 0) * (Number(process.env.DM_FUZZ_ROOM_LEN) || 60) * 40) });

/**
 * ⭐ B2 (сервер): ТОТ ЖЕ ФАЗЗЕР ЭКОНОМИКИ — ЧЕРЕЗ `Room.handleCmd`. Модель и инварианты — общие (`shared/.../fuzz/economyFuzz.ts`):
 * шаг строит ТУ ЖЕ заявку, но исполняет её настоящая комната — схема команды, лимиты, транзакция «сейв + сундук» с версиями
 * (мок базы — маленькая честная база, как в `room.run.test.ts`), откат при неудаче записи, прилавок и доска стока. Два героя ОДНОГО
 * аккаунта в одной комнате делят сундук в базе. Сверх общих шагов — то, чего нет у чистого ядра:
 *  • `drop`/`pickup` — вещь через землю соседу по аккаунту (перепись видит и землю);
 *  • `fault` — следующая транзакция упирается в сундук, обогнанный другим героем (откат в памяти), или база падает на записи;
 *  • `stale` — срок стока вышел: покупка и доска сперва катают новый прилавок (R5-19, R7-18);
 *  • `race` — два героя шлют команды сундука РАЗОМ (одна из транзакций проигрывает версию);
 *  • `persist` — автосейв героя; `crash` — процесс умер: новая комната читает героев и сундук из базы; снятую сессию (4009) клиент
 *    сам входит заново из базы.
 * Сверх общих инвариантов — ЗАПИСАННОЕ (P1): в базе (сейвы обоих героев + сундук) ни одна вещь не лежит дважды — иначе падение
 * процесса в этот миг раздаёт копию.
 *
 * Бросок сервера криптографический (`townRng`), поэтому сжатия здесь нет: печатается сид и хвост журнала шагов. Больше цепочек —
 * `DM_FUZZ_ROOM_SEEDS`, длина — `DM_FUZZ_ROOM_LEN`, первый сид — `DM_FUZZ_ROOM_FROM`, сводка в файл — `DM_FUZZ_ROOM_OUT`.
 */
const db = vi.hoisted(() => ({
  saves: new Map<string, number>(),
  data: new Map<string, SaveState>(),
  stashes: new Map<string, { data: AccountStash; version: number }>(),
  /** Сундук обогнан другим героем аккаунта — следующая запись «сейв + сундук» получит конфликт версии. */
  failStash: false,
  /** База упала: следующая запись (любая) бросает, не записав ничего. */
  throwNext: false,
}));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    if (db.throwNext) { db.throwNext = false; return Promise.reject(new Error('база недоступна')); }
    const snap = structuredClone(data);
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, snap);
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: (charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number) => {
    if (db.throwNext) { db.throwNext = false; return Promise.reject(new Error('база недоступна')); }
    const snap = structuredClone(data), st = structuredClone(stash);
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve({ ok: false, conflict: 'save' });
    if (db.failStash || sv !== (db.stashes.get(userId)?.version ?? 0)) return Promise.resolve({ ok: false, conflict: 'stash' });
    db.saves.set(charId, v + 1);
    db.data.set(charId, snap);
    db.stashes.set(userId, { data: st, version: sv + 1 });
    return Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 });
  },
  createCharacter: () => Promise.resolve(1),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: (userId: string) => {
    const row = db.stashes.get(userId);
    return Promise.resolve(row ? { data: structuredClone(row.data), version: row.version } : null);
  },
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: () => Promise.resolve(null),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {}
  onClose(): void {}
}

type Drop = { id: number; kind: string; item?: Item; owner?: string; pos: { x: number; y: number } };
type P = { save: SaveState; hp: number; alive: boolean; pos: { x: number; y: number }; stunTimer: number };
type RoomIn = {
  shop: Item[]; consumables: Item[]; questBoard: import('@dm/shared').QuestDef[]; stock: { at: number } | null;
  session: { world: { players: Record<string, P>; drops: Drop[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  persist(pid: string): Promise<unknown>;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: unknown, hooks: object) => RoomIn;
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

// Мок базы отвечает готовыми промисами: хватает оборотов `setImmediate` (на Windows `setTimeout(0)` — шаг таймера ~15,6 мс).
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };

const env = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const SEEDS = env('DM_FUZZ_ROOM_SEEDS', 4);
const FROM = env('DM_FUZZ_ROOM_FROM', 1);
const LEN = env('DM_FUZZ_ROOM_LEN', 60);

/** Шаги комнаты сверх общих. */
type RoomKind = 'drop' | 'pickup' | 'fault' | 'race' | 'persist' | 'crash' | 'stale';
type RoomOp = { k: OpKind | RoomKind; h: 0 | 1; s: number };
/** Общие шаги (без `restock`: сток катает сама комната по сроку; без `newHero`: герой комнаты — живая сессия) и свои — по весам. */
function genRoomOps(seed: number, len: number): RoomOp[] {
  const base = genOps(seed, len, { ...OP_WEIGHTS, restock: 0, newHero: 0 });
  const r = createRng((seed * 40503) >>> 0 || 3);
  return base.map((op): RoomOp => {
    const x = r.next();
    const k: RoomKind | undefined = x < 0.05 ? 'drop' : x < 0.1 ? 'pickup' : x < 0.13 ? 'fault' : x < 0.19 ? 'race' : x < 0.23 ? 'persist'
      : x < 0.245 ? 'crash' : x < 0.26 ? 'stale' : undefined;
    return k ? { ...op, k } : op;
  });
}
const SHARED_KINDS = new Set<string>(Object.keys(OP_WEIGHTS));

/** Что лежит в БАЗЕ: сейвы обоих героев и сундук — одна ли там каждая вещь (P1). */
function persistedDupes(charIds: string[], userId: string): Violation[] {
  const seen = new Map<string, string>();
  const out: Violation[] = [];
  const see = (it: Item | null | undefined, where: string): void => {
    if (!it || it.kind === 'material') return;
    const was = seen.get(it.uid);
    if (was) out.push({ inv: 'P1', code: 'persisted-dup', id: it.uid, msg: `в базе вещь «${it.name}» [${it.uid.slice(-6)}] лежит дважды: ${was} и ${where}` });
    seen.set(it.uid, where);
  };
  for (const id of charIds) {
    const s = db.data.get(id);
    if (!s) continue;
    for (const it of s.inventory) see(it, `${id}.сумка`);
    for (const it of Object.values(s.equipment)) see(it, `${id}.надето`);
    for (const it of s.belt) see(it, `${id}.пояс`);
  }
  for (const [t, tab] of (db.stashes.get(userId)?.data.tabs ?? []).entries()) for (const it of tab) see(it, `сундук.${t}`);
  return out;
}

interface Hit { seed: number; at: number; v: Violation; key: string; log: string[] }

/** Одна цепочка через комнату. Возвращает нарушения (первое по каждому ключу). */
async function runRoom(seed: number, ops: RoomOp[]): Promise<{ hits: Hit[]; stats: Record<string, { ok: number; no: number }> }> {
  const w: FuzzWorld = newWorld(seed);
  const userId = `user-fz-${seed}`;
  const charIds = [w.heroes[0].charId, w.heroes[1].charId];
  for (const [i, s] of w.heroes.entries()) { db.saves.set(charIds[i]!, 1); db.data.set(charIds[i]!, structuredClone(s)); }
  db.stashes.set(userId, { data: structuredClone(w.stash), version: 1 });
  db.failStash = false;
  const freshLimits = (): void => { for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync, limits.stashRead]) l.reset(userId); };
  freshLimits();

  let room!: RoomIn;
  const ws: FakeWs[] = [];
  const pids: string[] = [];
  const open = async (): Promise<void> => {
    room = new RoomCtor(`FZ${seed}`, w.reg, hooks);
    rooms.push(room);
    pids.length = 0; ws.length = 0;
    for (const id of charIds) {
      const c = new FakeWs();
      ws.push(c);
      pids.push(room.addPlayer(c, userId, structuredClone(db.data.get(id)!), db.saves.get(id)!));
    }
    await settle();
    room.stop();   // тик — нет: автосейв только шагом `persist`, окно «память впереди базы» держится, пока его не закроют
  };
  await open();
  const live = (h: 0 | 1): P => room.session.world.players[pids[h]!]!;
  /** Сессию сняли (устарела, 4009) — клиент входит заново: из базы, как вход менеджера. */
  const rejoin = async (): Promise<boolean> => {
    let again = false;
    for (const hh of [0, 1] as const) {
      if (room.session.world.players[pids[hh]!]) continue;
      const c = new FakeWs();
      ws[hh] = c;
      pids[hh] = room.addPlayer(c, userId, structuredClone(db.data.get(charIds[hh]!)!), db.saves.get(charIds[hh]!)!);
      again = true;
    }
    if (again) { await settle(); room.stop(); }
    return again;
  };
  /** Мир модели ← комната и база: живые сейвы, сундук из базы, прилавок и доска стока, земля аккаунта. */
  const refresh = (): void => {
    w.heroes = [live(0).save, live(1).save];
    w.stash = structuredClone(db.stashes.get(userId)!.data);
    w.potions = [...room.consumables];
    w.shop = room.shop.filter((i) => !room.consumables.includes(i));
    w.board = room.questBoard;
    w.boardAt = room.stock?.at ?? Date.now();
    w.now = Date.now();
    w.ground = room.session.world.drops.filter((d) => d.kind === 'item' && d.item && d.owner === userId).map((d) => d.item!);
  };
  let cmdId = 0;
  const send = async (h: 0 | 1, cmd: unknown): Promise<Res> => {
    freshLimits();
    const id = ++cmdId;
    await room.handleCmd(pids[h]!, cmd, id);
    await settle();
    const f = ws[h]!.frames.filter((x): x is Extract<ServerFrame, { t: 'cmdResult' }> => x.t === 'cmdResult' && x.id === id).at(-1);
    return f ? { ok: f.ok, reason: f.reason, uid: f.uid } : { ok: false, reason: 'нет ответа' };
  };

  const hits: Hit[] = [];
  const keys = new Set<string>();
  const log: string[] = [];
  const stats: Record<string, { ok: number; no: number }> = {};
  const note = (k: string, ok: boolean): void => { const t = (stats[k] ??= { ok: 0, no: 0 }); if (ok) t.ok++; else t.no++; };
  const zodFor = { hero: [true, true], stash: true };
  refresh();
  let before: Census = census(w);
  let prevState = new Set(stateInvariants(w, before, zodFor).map((x) => `${x.inv}:${x.code}:${x.id ?? x.msg}`));
  let prevPersisted = new Set(persistedDupes(charIds, userId).map((x) => x.id!));
  let faultNext = false;
  /** Вещи, прошедшие через землю от одного героя к другому: у их дублей в базе одна причина — ключ дедупа свой. */
  const thrown = new Set<string>();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const h = op.h;
    const r = createRng(op.s);
    let p: Plan | undefined;
    let res: Res = { ok: true };
    let aggregateOnly = false;
    try {
      if (op.k === 'drop') {
        const inv = live(h).save.inventory.filter((it) => it.kind !== 'material');
        const uid = inv.length ? r.pick(inv).uid : 'нет';
        log.push(`#${i} drop/${h}: бросить ${uid.slice(-6)}`);
        res = await send(h, { cmd: 'drop', uid });
        p = { desc: 'бросить', kind: 'town', run: () => res, spec: () => ({}) };
      } else if (op.k === 'pickup') {
        const drops = room.session.world.drops.filter((d) => d.kind === 'item' && d.owner === userId);
        const d = drops.length ? r.pick(drops) : undefined;
        if (d) live(h).pos = { ...d.pos };   // подойти к вещи
        log.push(`#${i} pickup/${h}: поднять ${d?.item?.name ?? '—'}`);
        res = await send(h, { cmd: 'pickup', dropId: d?.id ?? 999_999 });
        if (res.ok && d?.item) thrown.add(d.item.uid);
        p = { desc: 'поднять', kind: 'town', run: () => res, spec: () => ({}) };
      } else if (op.k === 'fault') {
        if (r.chance(0.7)) { faultNext = true; log.push(`#${i} fault: следующая запись сундука проиграет версию`); }
        else { db.throwNext = true; log.push(`#${i} fault: база упадёт на следующей записи`); }
        note(op.k, true);
        continue;
      } else if (op.k === 'stale') {
        // Срок стока вышел (в город с тех пор не заходили): покупка и доска сперва катают новый (R5-19, R7-18).
        if (room.stock) room.stock.at -= 3_600_000;
        log.push(`#${i} stale: срок стока вышел`);
        note(op.k, true);
        continue;
      } else if (op.k === 'persist') {
        log.push(`#${i} persist/${h}: автосейв`);
        await room.persist(pids[h]!);
        await settle();
        p = { desc: 'автосейв', kind: 'meta', run: () => res, spec: () => ({}) };
      } else if (op.k === 'crash') {
        log.push(`#${i} crash: процесс умер, новая комната читает базу`);
        room.stop();
        await open();
        aggregateOnly = true;
      } else if (op.k === 'race') {
        refresh();
        const town: OpKind[] = ['stashMove', 'craft', 'deposit', 'forgeSalvage', 'upgrade', 'repair', 'sketch', 'enchant', 'sell', 'buy'];
        const pa = plan(w, { k: r.pick(town), h: 0, s: r.int(1, 2 ** 31 - 1) });
        const pb = plan(w, { k: r.pick(town), h: 1, s: r.int(1, 2 ** 31 - 1) });
        log.push(`#${i} race: [0] ${pa.desc} ‖ [1] ${pb.desc}`);
        freshLimits();
        const ia = ++cmdId, ib = ++cmdId;
        await Promise.all([pa.cmd ? room.handleCmd(pids[0]!, pa.cmd, ia) : null, pb.cmd ? room.handleCmd(pids[1]!, pb.cmd, ib) : null]);
        await settle();
        const got = (hh: 0 | 1, id: number): string => { const f = ws[hh]!.frames.find((x) => x.t === 'cmdResult' && (x as { id?: number }).id === id) as { ok?: boolean; reason?: string } | undefined; return f ? (f.ok ? 'ок' : `отказ «${f.reason}»`) : '—'; };
        log.push(`    → [0] ${got(0, ia)} ‖ [1] ${got(1, ib)}`);
        aggregateOnly = true;
      } else if (SHARED_KINDS.has(op.k)) {
        refresh();
        before = census(w);
        p = plan(w, op as Op);
        const ph = p.h ?? h;
        if (p.cmd) {
          if (op.k === 'useConsumable' && r.chance(0.8)) live(ph).hp = 1;   // зелье с эффектом: герой ранен
          if (faultNext) db.failStash = true;
          res = await send(ph, p.cmd);
          db.failStash = false;
          faultNext = false;
        } else {
          const stash0 = JSON.stringify(w.stash);
          res = p.run();
          // Впрыск в сундук (добыча прошлых забегов, сданная в сундук) — прямо в базу.
          if (JSON.stringify(w.stash) !== stash0) db.stashes.get(userId)!.data = structuredClone(w.stash);
        }
        log.push(`#${i} ${op.k}/${ph}: ${p.desc} → ${res.ok ? 'ок' : `отказ «${res.reason}»`}`);
      } else continue;
    } catch (e) {
      const v: Violation = { inv: 'crash', code: String((e as Error)?.message ?? e).slice(0, 60), msg: String((e as Error)?.stack ?? e).slice(0, 500) };
      const key = `crash:${v.code}:${op.k}`;
      if (!keys.has(key)) { keys.add(key); hits.push({ seed, at: i, v, key, log: log.slice(-20) }); }
      break;
    }
    note(op.k, res.ok);
    db.throwNext = false;
    if (await rejoin()) { log.push('    (сессию сняли — вход заново из базы)'); aggregateOnly = true; }
    refresh();
    const after = census(w);
    zodFor.hero = [after.heroJson[0] !== before.heroJson[0], after.heroJson[1] !== before.heroJson[1]];
    zodFor.stash = after.stashJson !== before.stashJson;
    const state = stateInvariants(w, after, zodFor);
    // После падения процесса состояние — ПРОШЛОЕ из базы: его нарушения (кроме дублей) уже ловились, когда оно было текущим.
    const vs: Violation[] = state.filter((x) => !prevState.has(`${x.inv}:${x.code}:${x.id ?? x.msg}`) && (op.k !== 'crash' || x.inv === 'I3'));
    prevState = new Set(state.map((x) => `${x.inv}:${x.code}:${x.id ?? x.msg}`));
    if (!aggregateOnly && p) vs.unshift(...stepInvariants(w, p, res, before, after));
    else if (aggregateOnly && op.k === 'race') {
      // Гонка: только сводно — ценность аккаунта от двух шагов города не растёт.
      if (after.value > before.value + 1e-6) vs.push({ inv: 'I5', code: 'ledger', msg: `гонка подняла ценность ${before.value} → ${after.value}` });
    }
    const persisted = persistedDupes(charIds, userId);
    for (const x of persisted) if (!prevPersisted.has(x.id!)) vs.push(x);
    prevPersisted = new Set(persisted.map((x) => x.id!));
    for (const v of vs) {
      const viaGround = (v.inv === 'P1' || v.inv === 'I3') && v.id !== undefined && thrown.has(v.id);
      const key = `${v.inv}:${v.code}:${viaGround ? 'via-ground' : op.k}`;
      if (keys.has(key)) continue;
      keys.add(key);
      hits.push({ seed, at: i, v, key, log: log.slice(-25) });
    }
    before = after;
  }
  return { hits, stats };
}

describe('⭐ B2 (сервер): фаззер экономики через Room.handleCmd — два героя одного аккаунта, общий сундук в базе', () => {
  it(`${SEEDS} цепочек по ${LEN} шагов (сиды ${FROM}…${FROM + SEEDS - 1})`, async () => {
    const found = new Map<string, Hit>();
    const stats: Record<string, { ok: number; no: number }> = {};
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const out = await runRoom(seed, genRoomOps(seed, LEN));
      for (const [k, v] of Object.entries(out.stats)) { const t = (stats[k] ??= { ok: 0, no: 0 }); t.ok += v.ok; t.no += v.no; }
      for (const h of out.hits) if (!found.has(h.key)) found.set(h.key, h);
      for (const r of rooms.splice(0)) r.stop();
    }
    const lines = [...found.values()].map((h) => [`✗ ${h.key} — сид ${h.seed}, шаг ${h.at}`, `  ${h.v.inv}/${h.v.code}: ${h.v.msg}`, ...h.log.map((l) => `    ${l}`)].join('\n'));
    if (lines.length) console.log(lines.join('\n\n'));
    if (process.env.DM_FUZZ_VERBOSE) console.log(Object.entries(stats).sort().map(([k, v]) => `${k.padEnd(15)} ок ${v.ok} отказ ${v.no}`).join('\n'));
    if (process.env.DM_FUZZ_ROOM_OUT) writeFileSync(process.env.DM_FUZZ_ROOM_OUT, JSON.stringify({ from: FROM, seeds: SEEDS, len: LEN, stats, found: [...found.values()] }, null, 1));
    const unknown = [...found.keys()].filter((k) => !knownRoom(k));
    expect(unknown, lines.join('\n\n')).toEqual([]);
  });

  /**
   * НАЙДЕННОЕ ФАЗЗЕРОМ И ИСПРАВЛЕННОЕ. V-B2-04: герой A бросал вещь (только в памяти — запись A была бы автосейвом, до 10 с), сосед по
   * аккаунту B её поднимал, и ЛЮБАЯ запись B (автосейв, перекладка в сундук, ковка, разбор) клала вещь в строку B, пока строка A её ещё
   * держала. Падение процесса в этом окне — вещь у обоих (перепись после `crash` это и видела: I3 via-ground), а ночной аудит видел «ОДНА
   * ВЕЩЬ В ДВУХ МЕСТАХ» и без падения. Теперь выброшенное помечено выбросившим, его запись встаёт в очередь сразу, а подъём соседа ждёт её
   * (`Room.holdThrown`, `heldSettled`).
   */
  it('V-B2-04: вещь, переданная через землю соседу по аккаунту, не лежит в базе у обоих после его записи', async () => {
    const w = newWorld(7);
    const userId = 'user-v-b2-04';
    const [a, b] = w.heroes;
    const x = foundItem(w.reg, createRng(1), { weapon: true });
    delete x.broken;
    a.inventory = a.inventory.filter((i) => i.kind === 'material');
    expect(addToInventory(a.inventory, x, w.reg.get('balance').inventory), 'вещь в сумке A').toBe(true);
    for (const s of [a, b]) { db.saves.set(s.charId, 1); db.data.set(s.charId, structuredClone(s)); }
    db.stashes.set(userId, { data: structuredClone(w.stash), version: 1 });
    for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync, limits.stashRead]) l.reset(userId);
    const room = new RoomCtor('FZ-V4', w.reg, hooks);
    rooms.push(room);
    const pa = room.addPlayer(new FakeWs(), userId, structuredClone(a), 1);
    const pb = room.addPlayer(new FakeWs(), userId, structuredClone(b), 1);
    await settle();
    room.stop();
    await room.handleCmd(pa, { cmd: 'drop', uid: x.uid }, 1);
    const d = room.session.world.drops.find((q) => q.item?.uid === x.uid)!;
    expect(d, 'вещь на земле').toBeDefined();
    room.session.world.players[pb]!.pos = { ...d.pos };
    await room.handleCmd(pb, { cmd: 'pickup', dropId: d.id }, 2);
    expect(room.session.world.players[pb]!.save.inventory.some((i) => i.uid === x.uid), 'B поднял').toBe(true);
    await room.persist(pb);   // автосейв B (или его транзакция кузницы/сундука) — раньше очередного автосейва A
    await settle();
    const inA = db.data.get(a.charId)!.inventory.some((i) => i.uid === x.uid);
    const inB = db.data.get(b.charId)!.inventory.some((i) => i.uid === x.uid);
    expect(inA && inB, 'в базе вещь у обоих — падение процесса сейчас раздаёт копию').toBe(false);
  });
});

/**
 * Известные нарушения (образец ключа → id в отчёте) — ждут правки; у нарушений ядра — в `shared/src/economy/economyFuzz.test.ts`. После
 * правки строку убрать (V-B2-01 и V-B2-03 поправлены в ядре, V-B2-04 — в комнате: убраны).
 */
const KNOWN_ROOM: [RegExp, string][] = [];
const knownRoom = (key: string): string | undefined => KNOWN_ROOM.find(([re]) => re.test(key))?.[1];
