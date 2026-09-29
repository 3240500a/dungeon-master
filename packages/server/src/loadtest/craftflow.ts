import WebSocket from 'ws';
import pg from 'pg';
import {
  Cell, ConfigRegistry, CRAFT_SLOT_LIST, FIND_ORIGINS, applyWorldDelta, availableMaterials, canSalvageItem, craftWeapon,
  decodeWorldFrame, emptySnapshot, enchantCost, findPath, normalizeJournal, salvageMean, salvageRange, WIRE_FULL,
  type CraftInput, type CraftJournal, type FloorInit, type Item, type PlayerInput, type SaveState, type ServerFrame,
  type TownCommand, type WorldSnapshot,
} from '@dm/shared';

/**
 * ⭐ ЖИВАЯ КОВКА ОТ НАЧАЛА ДО КОНЦА (E2E) — против ЖИВОГО сервера и ТЕСТОВОЙ базы.
 *
 *   npm run loadtest:server   (в другом окне; база dungeon_test)
 *   npm run poc:craft [-- --base=http://127.0.0.1:3999 --pg=postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test --keep]
 *
 * Сценарий — ровно путь игрока, настоящими кадрами протокола:
 *   1) новый аккаунт и воин по HTTP;
 *   2) спуск в подземелье, бот ходит по сетке (BFS), бьёт подошедших, открывает сундуки и подбирает вещи, пока в сумке
 *      не окажется НАЙДЕННОЕ оружие (`drop`/`chest`/`boss`); у портала входа — в город;
 *   3) разбор находки у кузнеца (`forgeSalvage` с вилкой и средним карточки) — журнал обязан открыть базу и четыре детали;
 *   4) выход, в базе героя — золото, в кошельке аккаунта — недостающее сырьё (фарм сырья стенд не проверяет), вход заново;
 *   5) ковка из деталей находки с ценой карточки, повтор ТОГО ЖЕ ключа (та же вещь, ничего не списано), зачарование,
 *      повторное зачарование (отказ), переплавка; изменённый клиент: цена ниже, сырья меньше, повтор переплавки — отказы;
 *   6) выход — и сверка с базой: сейв героя, сундук аккаунта (журнал, ключ заявки, кошелёк), леджер вещей с причинами
 *      (`craft` → `enchant` → `melt`, находка — `salvage`), телеметрия ковки в `play_sessions`;
 *   7) второй герой аккаунта: кошелёк ровно на одну ковку, обе заявки в один миг (в кластере — на РАЗНЫХ нодах) — сковалась
 *      одна; ключ первой ковки с другого героя — прежний uid без траты;
 *   8) ковка и переплавка «в полёте», пока тот же герой входит из второй вкладки (первая вытесняется, 4001): одна вещь, одна
 *      цена, ровно одна переплавка.
 * Каждая команда проверяется по своему `cmdResult`; неожиданное закрытие сокета (4008/4009) — провал. Кластер — тот же
 * запуск с `--base=` гейтвея: адрес ноды стенд берёт у `/api/route`.
 *
 * ⚠ Стенд ПИШЕТ в базу (золото, сырьё, удаление своего аккаунта) — поэтому работает ТОЛЬКО с базой `*_test`.
 * Код выхода: 0 — всё сошлось, 1 — провал (список ниже вердикта).
 */
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a) ?? /^--([^=]+)$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const BASE = args.get('base') ?? 'http://127.0.0.1:3999';
const PG = args.get('pg') ?? 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test';
const KEEP = args.get('keep') === 'true';
const HUNT_SECS = Number(args.get('secs') ?? 420);
const SEED_GOLD = Number(args.get('gold') ?? 20_000);

if (!/\/[A-Za-z0-9_]+_test(\?|$)/.test(PG)) {
  console.error(`✗ poc:craft пишет в базу и работает только с тестовой (…_test), а не ${PG.replace(/:[^:@/]+@/, ':***@')}`);
  process.exit(1);
}

const fails: string[] = [];
function check(ok: boolean, what: string): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) fails.push(what);
  return ok;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(50); }
  return pred();
}
async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/**
 * Куда подключаться (Ф4.1): гейтвей отвечает адресом ноды, а одиночный сервер — самим собой. Так стенд одинаково гоняет
 * и один процесс, и кластер — где два героя одного аккаунта (шаг 6) сидят на РАЗНЫХ нодах, а сундук у них один.
 */
async function nodeUrl(token: string, charId: string): Promise<string> {
  let ticket = '';
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/api/route?charId=${encodeURIComponent(charId)}${ticket ? `&ticket=${ticket}` : ''}`,
      { headers: { authorization: `Bearer ${token}` } });
    if (r.ok) return ((await r.json()) as { url: string }).url;
    const b = (await r.json().catch(() => ({}))) as { queue?: { ticket: string } };
    if (r.status === 503 && b.queue) { ticket = b.queue.ticket; await sleep(1000); continue; }
    throw new Error(`/api/route → ${r.status} ${JSON.stringify(b)}`);
  }
  throw new Error('очередь на вход не подошла за минуту');
}

/** Адреса живых нод кластера (`/api/cluster` — служебная ручка, отвечает самой машине). Одиночный сервер — пусто. */
async function clusterNodes(): Promise<string[]> {
  const r = await fetch(`${BASE}/api/cluster`).catch(() => undefined);
  if (!r?.ok) return [];
  const body = (await r.json().catch(() => ({}))) as { nodes?: { url: string; draining: boolean }[] };
  return (body.nodes ?? []).filter((n) => !n.draining).map((n) => n.url);
}

type CmdResult = Extract<ServerFrame, { t: 'cmdResult' }>;
type StashFrame = Extract<ServerFrame, { t: 'stash' }>;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const sumOf = (w: Record<string, number>): number => Object.values(w).reduce((s, n) => s + n, 0);

/** Одно соединение героя: сейв, сундук, мир и ответы на команды — ровно то, что видит клиент. */
class Conn {
  ws!: WebSocket;
  /** Адрес ноды, который выдал гейтвей (в одиночном режиме — сам сервер). */
  url = '';
  save?: SaveState;
  floor?: FloorInit;
  stash?: StashFrame;
  world?: WorldSnapshot;
  playerId = '';
  maxHp = 1;
  closeCode?: number;
  readonly errors: string[] = [];
  readonly results = new Map<number, CmdResult>();
  readonly opened = new Set<number>();
  died = 0;
  private nextId = 1;
  private seq = 0;

  /** `url` — подключиться прямо к этой ноде, мимо маршрута гейтвея (шаг 6 кластера: героев — на РАЗНЫЕ ноды). */
  async open(token: string, charId: string, url?: string): Promise<void> {
    this.url = url ?? await nodeUrl(token, charId);
    this.ws = new WebSocket(this.url);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('close', (code) => { this.closeCode = code; });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    this.ws.send(JSON.stringify({ t: 'join', token, charId, fresh: true }));
    if (!(await until(() => !!this.save && !!this.floor && !!this.stash, 8000))) throw new Error('нет joined/stash за 8 с');
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const f = decodeWorldFrame(new Uint8Array(data));
      const base = f.kind === WIRE_FULL ? emptySnapshot() : this.world;
      if (base) this.world = applyWorldDelta(base, f.delta);
      return;
    }
    const f = JSON.parse(data.toString()) as ServerFrame;
    switch (f.t) {
      case 'joined':
        this.playerId = f.playerId; this.save = f.save; this.floor = f.floor;
        this.maxHp = f.peers.find((p) => p.id === f.playerId)?.maxHp ?? this.maxHp;
        break;
      case 'areaChanged': this.floor = f.floor; this.opened.clear(); break;
      case 'saveUpdate': this.save = f.save; break;
      case 'stash': this.stash = f; break;
      case 'peerInfo': { const me = f.peers.find((p) => p.id === this.playerId); if (me) this.maxHp = me.maxHp; break; }
      case 'cmdResult': if (f.id !== undefined) this.results.set(f.id, f); break;
      case 'voteStart': this.ws.send(JSON.stringify({ t: 'vote', accept: true })); break;
      case 'doorOpened': {
        const door = this.floor?.doors.find((d) => d.id === f.doorId);
        for (const c of door?.cells ?? []) { const row = this.floor!.grid[c.cy]; if (row) row[c.cx] = Cell.Floor; }
        break;
      }
      case 'events':
        for (const e of f.events) if (e.type === 'chest-opened') this.opened.add(e.id);
        break;
      case 'died': this.died++; break;
      case 'error': this.errors.push(`${f.code}: ${f.msg}`); break;
      default: break;
    }
  }

  send(frame: unknown): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame)); }
  input(input: PlayerInput): void { this.send({ t: 'input', seq: this.seq++, input }); }

  /** Команда города с номером — и её `cmdResult` (к нему `saveUpdate` уже пришёл). */
  async cmd(command: TownCommand | Record<string, unknown>, id = this.nextId++): Promise<CmdResult> {
    this.send({ t: 'cmd', id, command });
    if (!(await until(() => this.results.has(id), 10_000))) throw new Error(`нет cmdResult на ${JSON.stringify(command).slice(0, 80)}`);
    return this.results.get(id)!;
  }
  /**
   * Команда, которую стенд ЖДЁТ отклонённой: на отказ сервер шлёт и старый кадр `error` — он ожидаемый и из счёта
   * ошибок соединения убирается (прочие `error` остаются провалом).
   */
  async expectRefusal(command: TownCommand | Record<string, unknown>): Promise<CmdResult> {
    const before = this.errors.length;
    const r = await this.cmd(command);
    if (!r.ok && (await until(() => this.errors.length > before, 1000))) {
      const i = this.errors.findIndex((e, k) => k >= before && e.endsWith(r.reason ?? ''));
      if (i >= 0) this.errors.splice(i, 1);
    }
    return r;
  }
  /** Свежий слепок сундука: `stashOpen` отвечает кадром `stash` ДО своего `cmdResult`. */
  async refreshStash(): Promise<StashFrame> {
    await this.cmd({ cmd: 'stashOpen' });
    return this.stash!;
  }
  me() { return this.world?.players.find((p) => p.id === this.playerId); }
  get connected(): boolean { return this.ws.readyState === WebSocket.OPEN; }
  async leave(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((r) => this.ws.once('close', () => r()));
      this.send({ t: 'leave' });
      this.ws.close();
      await Promise.race([closed, sleep(3000)]);
    }
  }
}

/** Найденное оружие, которое кузнец разберёт в журнал: найдено, не уник, не скованное, разбор возможен. */
function foundWeapon(reg: ConfigRegistry, save: SaveState | undefined): Item | undefined {
  return save?.inventory.find((i) => i.kind === 'weapon' && !i.parts && i.rarity !== 'unique'
    && !!i.origin && FIND_ORIGINS.has(i.origin) && canSalvageItem(reg, i, false).ok);
}

/**
 * ОХОТА: бот ходит по сетке этажа, пока в сумке нет найденного оружия, — потом к порталу входа и в город.
 * Не стратег: ближайший подошедший монстр → бить; иначе вещь на земле → сундук → рычаг → выход на следующий этаж.
 */
async function hunt(c: Conn, reg: ConfigRegistry): Promise<boolean> {
  const end = Date.now() + HUNT_SECS * 1000;
  const tries = new Map<string, number>();
  const skipUntil = new Map<string, number>();
  let path: { x: number; y: number }[] = [];
  let pathKey = '';
  let pathAt = 0;
  let facing = 0;
  let lastPotion = 0;
  let lastAction = 0;
  let lastDescend = 0;
  let stuckFrom = { x: 0, y: 0, at: Date.now() };
  let jitterUntil = 0;
  let jitter = { x: 0, y: 0 };
  let floorAt = Date.now();
  let floorKey = '';
  let lastLog = 0;

  const navigate = (from: { x: number; y: number }, goal: { x: number; y: number }, key: string): { x: number; y: number } | null => {
    const now = Date.now();
    if (key !== pathKey || now - pathAt > 700 || path.length === 0) {
      path = findPath(c.floor!.grid, from, goal);
      pathKey = key; pathAt = now;
      if (path.length === 0 && dist(from, goal) > 40) return null;   // недостижимо (дверь, стена)
    }
    while (path.length && dist(from, path[0]!) < 12) path.shift();
    const to = path[0] ?? goal;
    const d = dist(from, to);
    return d < 1 ? { x: 0, y: 0 } : { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
  };
  const act = (key: string, fn: () => void): void => {
    const now = Date.now();
    if (now - lastAction < 450) return;
    lastAction = now;
    const n = (tries.get(key) ?? 0) + 1;
    tries.set(key, n);
    fn();
  };
  // Портал домой — без предела попыток: «в город» отказывают, пока рядом монстр (R4-14), и это не повод остаться на этаже.
  const usable = (key: string): boolean => (key === 'home' || (tries.get(key) ?? 0) < 4) && (skipUntil.get(key) ?? 0) < Date.now();

  while (Date.now() < end) {
    await sleep(33);
    const now = Date.now();
    const fl = c.floor, save = c.save, me = c.me();
    if (!fl || !save) continue;
    const found = foundWeapon(reg, save);
    if (fl.area === 'town') {
      if (found) return true;
      if (now - lastDescend > 3000) { lastDescend = now; c.send({ t: 'descend', difficultyId: 'normal' }); }
      continue;
    }
    if (!me) continue;
    if (me.hp > c.maxHp) c.maxHp = me.hp;   // свой `peerInfo` после уровня может не прийти — максимум видно по здоровью
    const key = `${fl.runNodeId ?? fl.depth}`;
    if (key !== floorKey) { floorKey = key; floorAt = now; tries.clear(); skipUntil.clear(); path = []; }
    if (now - lastLog > 10_000) {
      lastLog = now;
      console.log(`  … этаж ${fl.depth} (${fl.runNodeId ?? '—'}), HP ${Math.round(me.hp)}/${c.maxHp}, в сумке ${save.inventory.length}, `
        + `сундуков ${fl.chests.length - [...c.opened].length}, смертей ${c.died}`);
    }
    if (!me.alive) { c.input({ move: { x: 0, y: 0 }, facing, attack: false, cast: null, interact: false }); continue; }
    const pos = { x: me.x, y: me.y };

    let useBelt: number | undefined;
    if (me.hp < c.maxHp * 0.45 && now - lastPotion > 1500) {
      const slot = save.belt.findIndex((b) => !!b?.use);
      if (slot >= 0) { useBelt = slot; lastPotion = now; }
    }

    let move = { x: 0, y: 0 };
    let attack = false;
    const threat = (c.world?.monsters ?? []).filter((m) => m.alive).map((m) => ({ m, d: dist(m, pos) }))
      .sort((a, b) => a.d - b.d)[0];
    if (threat && threat.d < 150) {
      facing = Math.atan2(threat.m.y - pos.y, threat.m.x - pos.x);
      attack = threat.d < 75;
      if (threat.d > 45) move = navigate(pos, threat.m, `m${threat.m.id}`) ?? { x: 0, y: 0 };
    } else {
      // Цель: домой с находкой; иначе вещь на земле → сундук → рычаг → выход.
      type Goal = { key: string; at: { x: number; y: number }; reach: number; act: () => void };
      const goals: Goal[] = [];
      if (found) {
        goals.push({ key: 'home', at: fl.spawn, reach: 40, act: () => c.send({ t: 'return' }) });
      } else {
        for (const d of c.world?.drops ?? []) {
          if (d.kind === 'item') goals.push({ key: `d${d.id}`, at: d, reach: 36, act: () => { void c.cmd({ cmd: 'pickup', dropId: d.id }).catch(() => undefined); } });
        }
        for (const ch of fl.chests) {
          if (!c.opened.has(ch.id)) goals.push({ key: `c${ch.id}`, at: ch, reach: 42, act: () => c.send({ t: 'chest', chestId: ch.id }) });
        }
        if (!goals.some((g) => usable(g.key))) {
          for (const lv of fl.levers) goals.push({ key: `l${lv.id}`, at: lv, reach: 44, act: () => c.send({ t: 'lever', leverId: lv.id }) });
          for (const [i, ex] of (fl.exits ?? (fl.stairs ? [fl.stairs] : [])).entries()) {
            goals.push({ key: `x${i}`, at: ex, reach: 44, act: () => c.send({ t: 'descend' }) });
          }
        }
      }
      const goal = goals.filter((g) => usable(g.key)).sort((a, b) => dist(a.at, pos) - dist(b.at, pos))[0];
      if (goal) {
        if (dist(goal.at, pos) <= goal.reach) {
          act(goal.key, goal.act);
        } else {
          const v = navigate(pos, goal.at, goal.key);
          if (v) move = v; else skipUntil.set(goal.key, now + 5000);
        }
        if (move.x || move.y) facing = Math.atan2(move.y, move.x);
      }
    }
    // Застрял (декор, угол) — полсекунды вбок и новый путь.
    if (move.x || move.y) {
      if (dist(stuckFrom, pos) > 10) stuckFrom = { ...pos, at: now };
      else if (now - stuckFrom.at > 2000) {
        const a = Math.random() * Math.PI * 2;
        jitter = { x: Math.cos(a), y: Math.sin(a) }; jitterUntil = now + 500; path = []; stuckFrom = { ...pos, at: now };
      }
    } else stuckFrom = { ...pos, at: now };
    if (now < jitterUntil) move = jitter;
    c.input({ move, facing, attack, cast: null, interact: false, ...(useBelt !== undefined ? { useBelt } : {}) });
    if (now - floorAt > 240_000) { floorAt = now; tries.clear(); }   // этаж не отпускает — всё заново
  }
  return false;
}

async function main(): Promise<void> {
  const reg = new ConfigRegistry();
  reg.loadAll();
  reg.reload((await (await fetch(BASE + '/api/config')).json()) as Parameters<ConfigRegistry['reload']>[0]);
  if (!reg.get('balance').craft.live) { console.error('✗ ковка на сервере закрыта (balance.craft.live = false)'); process.exit(1); }

  const db = new pg.Pool({ connectionString: PG, max: 2 });
  const username = `e2e_${Math.random().toString(36).slice(2, 8)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name: 'Кузнец' }, token);
  const userId = (await db.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])).rows[0]?.id;
  if (!userId) throw new Error('аккаунт не найден в базе — стенд смотрит не в ту базу, что сервер?');
  console.log(`E2E ковки: ${username} (${userId}), герой ${character.charId}, база ${PG.replace(/:[^:@/]+@/, ':***@')}`);
  const closes: number[] = [];
  const charIds = [character.charId];

  try {
    // ── 1. Охота за найденным оружием ────────────────────────────────────────
    let c = new Conn();
    await c.open(token, character.charId);
    console.log('\n[1] охота: подземелье → найденное оружие → портал входа');
    const got = await hunt(c, reg);
    if (!check(got, `найденное оружие в сумке и герой в городе (смертей ${c.died})`)) return;
    const find = foundWeapon(reg, c.save)!;
    const base = reg.get('items.base').find((b) => b.id === find.baseId)!;
    console.log(`    находка: ${find.name} (${find.baseId}, ${find.rarity}, ${find.origin}, тир ${find.tier ?? '—'})`);

    // ── 2. Разбор у кузнеца → журнал ─────────────────────────────────────────
    console.log('\n[2] разбор находки у кузнеца');
    const st0 = await c.refreshStash();
    const mats0 = availableMaterials(c.save!.inventory, st0.materials);
    const range = salvageRange(reg, find, false);
    const minYield = Object.fromEntries(Object.entries(range.range).map(([id, r]) => [id, r.min]));
    const avgYield = salvageMean(reg, find, false) ?? undefined;
    const rs = await c.cmd({ cmd: 'forgeSalvage', uid: find.uid, minYield, ...(avgYield ? { avgYield } : {}) });
    check(rs.ok, `forgeSalvage ok (${rs.reason ?? 'ok'})`);
    check(!c.save!.inventory.some((i) => i.uid === find.uid), 'находка ушла из сумки');
    const st1 = await c.refreshStash();
    const mats1 = availableMaterials(c.save!.inventory, st1.materials);
    const gained: Record<string, number> = {};
    for (const id of new Set([...Object.keys(mats0), ...Object.keys(mats1)])) {
      const d = (mats1[id] ?? 0) - (mats0[id] ?? 0);
      if (d) gained[id] = d;
    }
    check(Object.entries(gained).every(([id, n]) => n >= (range.range[id]?.min ?? Infinity) && n <= (range.range[id]?.max ?? -1))
      && Object.keys(range.range).every((id) => (range.range[id]!.max === 0) || id in gained),
    `сырьё разбора в вилке карточки: ${JSON.stringify(gained)}`);
    const parts = find.foundParts!;
    const journal: CraftJournal = normalizeJournal(st1.forgeJournal);
    check(journal.bases.includes(find.baseId), `журнал открыл базу ${find.baseId}`);
    check(CRAFT_SLOT_LIST.every((s) => journal.variants.includes(parts[s].id)), 'журнал открыл четыре детали находки');
    check((rs.unlocked ?? []).length > 0, `ответ назвал открытое: ${(rs.unlocked ?? []).join('; ')}`);

    // ── 3. Золото и сырьё — в базу, пока героя нет в игре ────────────────────
    if (base.kind !== 'weapon') throw new Error(`база находки ${find.baseId} — не оружие`);
    const input: CraftInput = { weaponClass: base.weaponClass, hands: base.hands ?? 1, parts: structuredClone(parts) };
    const pv = craftWeapon(reg, input, { journal, materialsOn: true });
    if (!check(pv.ok && !!pv.cost, `предпросмотр ковки из деталей находки (${pv.reason ?? `${pv.cost?.gold} зол., ${JSON.stringify(pv.cost?.materials)}`})`)) return;
    const cost = pv.cost!;
    const lack: Record<string, number> = {};
    for (const [id, n] of Object.entries(cost.materials)) if ((mats1[id] ?? 0) < n) lack[id] = n - (mats1[id] ?? 0);
    await c.leave();
    closes.push(c.closeCode ?? -1);
    await sleep(500);
    const v0 = (await db.query<{ version: number }>('SELECT version FROM characters WHERE char_id = $1', [character.charId])).rows[0]!.version;
    await db.query(`UPDATE characters SET data = jsonb_set(data, '{gold}', to_jsonb($2::int)), version = version + 1 WHERE char_id = $1`,
      [character.charId, SEED_GOLD]);
    const stRow = (await db.query<{ data: { materials?: Record<string, number> } }>('SELECT data FROM account_stash WHERE user_id = $1', [userId])).rows[0];
    const wallet = { ...(stRow?.data.materials ?? {}) };
    for (const [id, n] of Object.entries(lack)) wallet[id] = (wallet[id] ?? 0) + n;
    await db.query(`UPDATE account_stash SET data = jsonb_set(data, '{materials}', $2::jsonb), version = version + 1 WHERE user_id = $1`,
      [userId, JSON.stringify(wallet)]);
    console.log(`\n[3] в базу (герой вне игры, версия ${v0}): золото ${SEED_GOLD}, недостающее сырьё ${JSON.stringify(lack)}`);

    // ── 4. Ковка, повтор ключа, зачарование, переплавка ──────────────────────
    c = new Conn();
    await c.open(token, character.charId);
    check(c.save!.gold === SEED_GOLD, `после входа золото ${c.save!.gold} = засеянному`);
    console.log('\n[4] ковка → повтор ключа → зачарование → переплавка');
    const nonce = `e2e-${Math.random().toString(36).slice(2, 14)}`;
    const gold0 = c.save!.gold;
    const m0 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const rc = await c.cmd({ cmd: 'craft', nonce, input, maxGold: cost.gold, maxMaterials: cost.materials });
    check(rc.ok && !!rc.uid, `craft ok (${rc.reason ?? rc.uid})`);
    const crafted = c.save!.inventory.find((i) => i.uid === rc.uid);
    check(!!crafted?.parts && crafted.origin === 'craft', `скованная в сумке: ${crafted?.name ?? 'НЕТ'} (origin ${crafted?.origin})`);
    check(c.save!.gold === gold0 - cost.gold, `золото ${gold0} → ${c.save!.gold} (цена ${cost.gold})`);
    const m1 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    check(Object.entries(cost.materials).every(([id, n]) => (m0[id] ?? 0) - (m1[id] ?? 0) === n), `списано сырьё ровно по цене ${JSON.stringify(cost.materials)}`);

    const rr = await c.cmd({ cmd: 'craft', nonce, input, maxGold: cost.gold, maxMaterials: cost.materials });
    check(rr.ok && rr.uid === rc.uid, `повтор ключа — та же вещь (${rr.uid})`);
    check(c.save!.gold === gold0 - cost.gold && c.save!.inventory.filter((i) => i.parts).length === 1, 'повтор ключа ничего не списал и не сковал');

    await sleep(600);   // лимит кузницы (запас 5, +2/с) — честный клиент чаще не жмёт
    const eCost = enchantCost(reg, crafted!, 'magic');
    const gold1 = c.save!.gold;
    const re = await c.cmd({ cmd: 'forgeEnchant', uid: rc.uid!, rarity: 'magic', maxGold: eCost });
    const ench = c.save!.inventory.find((i) => i.uid === re.uid);
    check(re.ok && ench?.rarity === 'magic' && ench.affixes.length > 0, `forgeEnchant ok: ${ench?.rarity}, аффиксов ${ench?.affixes.length ?? 0} (${re.reason ?? 'ok'})`);
    check(c.save!.gold === gold1 - eCost, `зачарование стоило ровно ${eCost}: ${gold1} → ${c.save!.gold}`);
    const re2 = await c.expectRefusal({ cmd: 'forgeEnchant', uid: re.uid ?? rc.uid!, rarity: 'rare', maxGold: 1_000_000 });
    check(!re2.ok && c.save!.gold === gold1 - eCost, `второе зачарование — отказ (${re2.reason})`);

    await sleep(600);
    const meltUid = re.uid ?? rc.uid!;
    const meltItem = c.save!.inventory.find((i) => i.uid === meltUid)!;
    const mRange = salvageRange(reg, meltItem, false);
    const m2 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const rm = await c.cmd({
      cmd: 'forgeSalvage', uid: meltUid,
      minYield: Object.fromEntries(Object.entries(mRange.range).map(([id, r]) => [id, r.min])),
      ...(salvageMean(reg, meltItem, false) ? { avgYield: salvageMean(reg, meltItem, false)! } : {}),
    });
    check(rm.ok && !c.save!.inventory.some((i) => i.uid === meltUid), `переплавка ok (${rm.reason ?? 'ok'})`);
    const m3 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const back: Record<string, number> = {};
    for (const id of new Set([...Object.keys(m2), ...Object.keys(m3)])) { const d = (m3[id] ?? 0) - (m2[id] ?? 0); if (d) back[id] = d; }
    check(Object.keys(mRange.range).every((id) => back[id] === mRange.range[id]!.min && mRange.range[id]!.min === mRange.range[id]!.max)
      && Object.keys(back).every((id) => id in mRange.range), `переплавка вернула ровно обещанное ${JSON.stringify(back)}`);
    check(Object.entries(back).every(([id, n]) => n < (cost.materials[id] ?? Infinity)) && sumOf(back) < sumOf(cost.materials),
      `переплавка вернула меньше заплаченного (${sumOf(back)} < ${sumOf(cost.materials)})`);

    // Изменённый клиент: цена ниже настоящей, сырья меньше настоящего, переплавка уже переплавленного.
    await sleep(1100);
    const gold2 = c.save!.gold, bag2 = c.save!.inventory.length;
    const cheap = await c.expectRefusal({ cmd: 'craft', nonce: `${nonce}-cheap`, input, maxGold: cost.gold - 1, maxMaterials: cost.materials });
    const [mid, mn] = Object.entries(cost.materials)[0]!;
    const thin = await c.expectRefusal({ cmd: 'craft', nonce: `${nonce}-thin`, input, maxGold: cost.gold, maxMaterials: { ...cost.materials, [mid]: mn - 1 } });
    const again = await c.expectRefusal({ cmd: 'forgeSalvage', uid: meltUid });
    check(!cheap.ok && !thin.ok && !again.ok && c.save!.gold === gold2 && c.save!.inventory.length === bag2,
      `цена ниже / сырья меньше / повтор переплавки — отказы, ничего не списано (${cheap.reason} · ${thin.reason} · ${again.reason})`);
    // Сырьё из сумки — в кошелёк аккаунта: гонке двух героев (шаг 6) делить только кошелёк.
    const dep = await c.cmd({ cmd: 'depositMaterials' });
    check(dep.ok || dep.reason === 'Сырья в сумке нет', `сырьё сдано в сундук (${dep.reason ?? 'ok'})`);
    await c.refreshStash();
    const finalSave = structuredClone(c.save!);
    const finalStash = structuredClone(c.stash!);
    check(c.errors.length === 0, `кадров error: ${c.errors.length}${c.errors.length ? ` — ${c.errors.slice(0, 3).join(' | ')}` : ''}`);
    await c.leave();
    closes.push(c.closeCode ?? -1);

    // ── 5. Сверка с базой ────────────────────────────────────────────────────
    console.log('\n[5] сверка с базой');
    // Прощальная запись идёт после закрытия сокета — ждём её, а не спим наугад.
    let saved: SaveState | undefined;
    for (let i = 0; i < 60 && !saved; i++) {
      const r = (await db.query<{ data: SaveState }>('SELECT data FROM characters WHERE char_id = $1', [character.charId])).rows[0];
      if (r && r.data.gold === finalSave.gold && !r.data.inventory.some((it) => it.uid === meltUid)) saved = r.data;
      else await sleep(250);
    }
    check(!!saved, `сейв героя в базе: золото ${saved?.gold ?? '—'} = ${finalSave.gold}, скованной нет`);
    if (saved) {
      const a = saved.inventory.map((i) => i.uid).sort().join(), b = finalSave.inventory.map((i) => i.uid).sort().join();
      check(a === b, 'сумка в базе = последний saveUpdate');
    }
    const acc = (await db.query<{ data: { forgeJournal?: unknown; craftNonces?: { n: string; uid: string }[]; materials?: Record<string, number> } }>(
      'SELECT data FROM account_stash WHERE user_id = $1', [userId])).rows[0]?.data;
    const dj = normalizeJournal(acc?.forgeJournal);
    check(dj.bases.includes(find.baseId) && CRAFT_SLOT_LIST.every((s) => dj.variants.includes(parts[s].id)), 'журнал в базе: база и детали находки');
    check(!!acc?.craftNonces?.some((e) => e.n === nonce && e.uid === rc.uid), 'ключ заявки в базе указывает на скованную вещь');
    check(JSON.stringify(Object.entries(acc?.materials ?? {}).sort()) === JSON.stringify(Object.entries(finalStash.materials).sort()),
      'кошелёк сырья в базе = последний кадр stash');
    const ev = async (uid: string): Promise<string[]> => (await db.query<{ kind: string; reason: string | null }>(
      'SELECT kind, reason FROM item_events WHERE item_id = $1 ORDER BY seq', [uid])).rows.map((r) => `${r.kind}:${r.reason ?? ''}`);
    const loc = async (uid: string): Promise<string | undefined> => (await db.query<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [uid])).rows[0]?.loc;
    const evFind = await ev(find.uid), evCraft = await ev(rc.uid!);
    check(evFind.includes('gone:salvage') && (await loc(find.uid)) === 'world', `леджер находки: ${evFind.join(' → ')}`);
    check(evCraft[0] === 'created:craft' && evCraft.includes('changed:enchant') && evCraft.at(-1) === 'gone:melt' && (await loc(rc.uid!)) === 'world',
      `леджер скованной: ${evCraft.join(' → ')}`);
    const tel = (await db.query<{ crafted: string; melted: string; salvaged: string; enchanted: string }>(
      `SELECT sum(crafted) crafted, sum(melted) melted, sum(salvaged) salvaged, sum(enchanted) enchanted FROM play_sessions WHERE char_id = $1`,
      [character.charId])).rows[0];
    check(Number(tel?.crafted) === 1 && Number(tel?.melted) === 1 && Number(tel?.salvaged) === 1 && Number(tel?.enchanted) === 1,
      `телеметрия: сковано ${tel?.crafted}, переплавлено ${tel?.melted}, разобрано ${tel?.salvaged}, зачаровано ${tel?.enchanted}`);

    // ── 6. Два героя одного аккаунта — один кошелёк на одну ковку ────────────
    // Сырьё общее (сундук аккаунта), герои — в разных комнатах. Обе заявки уходят в один миг: сковаться обязана ровно одна,
    // списаться — ровно одна цена; проигравшая — отказ (нехватка или конфликт версии сундука), сессии живы.
    console.log('\n[6] два героя одного аккаунта делят кошелёк на одну ковку');
    const { character: second } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name: 'Подмастерье' }, token);
    charIds.push(second.charId);
    await db.query(`UPDATE characters SET data = jsonb_set(data, '{gold}', to_jsonb($2::int)), version = version + 1 WHERE char_id = $1`,
      [second.charId, SEED_GOLD]);
    const exact = { ...(acc?.materials ?? {}) };
    for (const id of Object.keys(cost.materials)) exact[id] = cost.materials[id]!;
    await db.query(`UPDATE account_stash SET data = jsonb_set(data, '{materials}', $2::jsonb), version = version + 1 WHERE user_id = $1`,
      [userId, JSON.stringify(exact)]);
    const a = new Conn();
    let b = new Conn();
    await a.open(token, character.charId);
    await b.open(token, second.charId);
    // На кластере гейтвей мог положить обоих на одну ноду (показатели нод отстают на сердцебиение) — тогда B переходит на
    // ДРУГУЮ ноду прямым подключением: делить кошелёк через две ноды и одну базу — главный случай кластера.
    // ⭐ E2E 29.09: ноду сравниваем БЕЗ строки запроса — с R13-08 маршрут отдаёт адрес с пропуском (`?lp=…`), и `a.url !== b.url` на одной
    // ноде: стенд считал их разными, и гонка шага 6 в кластере шла на ОДНОЙ ноде, а отчёт писал «на разных».
    const bare = (u: string): string => u.split('?')[0]!;
    const others = (await clusterNodes()).filter((u) => bare(u) !== bare(a.url));
    if (bare(b.url) === bare(a.url) && others.length) {
      await b.leave();
      closes.push(b.closeCode ?? -1);
      await sleep(500);
      b = new Conn();
      await b.open(token, second.charId, others[0]);
    }
    const sameNode = bare(a.url) === bare(b.url);
    console.log(`    A на ${bare(a.url)}, B на ${bare(b.url)}${sameNode ? ' (одна нода — одиночный сервер)' : ''}`);
    if (others.length) check(!sameNode, 'кластер: герои на РАЗНЫХ нодах');
    const bagA = availableMaterials(a.save!.inventory, {}), bagB = availableMaterials(b.save!.inventory, {});
    check(Object.keys(cost.materials).every((id) => !bagA[id] && !bagB[id]), 'в сумках героев нужного сырья нет — делят только кошелёк');
    const goldA = a.save!.gold, goldB = b.save!.gold;
    const craftedIn = (s: SaveState | undefined): number => s?.inventory.filter((i) => i.parts).length ?? 0;
    const [ra, rb] = await Promise.all([
      a.expectRefusal({ cmd: 'craft', nonce: `${nonce}-a`, input, maxGold: cost.gold, maxMaterials: cost.materials }),
      b.expectRefusal({ cmd: 'craft', nonce: `${nonce}-b`, input, maxGold: cost.gold, maxMaterials: cost.materials }),
    ]);
    const winners = [ra, rb].filter((r) => r.ok).length;
    check(winners === 1, `сковалась ровно одна: A ${ra.ok ? 'ok' : ra.reason}, B ${rb.ok ? 'ok' : rb.reason}`);
    const loser = ra.ok ? b : a;
    const loserNonce = ra.ok ? `${nonce}-b` : `${nonce}-a`;
    await sleep(600);
    // Честный клиент повторяет отказ ТЕМ ЖЕ ключом: второй вещи это не даёт.
    const retry = await loser.expectRefusal({ cmd: 'craft', nonce: loserNonce, input, maxGold: cost.gold, maxMaterials: cost.materials });
    check(!retry.ok, `повтор проигравшего тем же ключом — отказ (${retry.reason})`);
    const wA = (await a.refreshStash()).materials, wB = (await b.refreshStash()).materials;
    check(Object.keys(cost.materials).every((id) => !wA[id] && !wB[id]), 'кошелёк списан ровно один раз (нужного сырья 0)');
    check(craftedIn(a.save) + craftedIn(b.save) === 1, `скованных у двух героев вместе: ${craftedIn(a.save) + craftedIn(b.save)}`);
    const spent = (goldA - a.save!.gold) + (goldB - b.save!.gold);
    check(spent === cost.gold, `золота списано ${spent} = одна цена ${cost.gold}`);
    // Ключ заявки — на АККАУНТЕ: чужой герой, повторив ключ первой ковки, получает её uid и ничего не платит.
    const goldB1 = b.save!.gold, bagB1 = b.save!.inventory.length;
    const cross = await b.cmd({ cmd: 'craft', nonce, input, maxGold: cost.gold, maxMaterials: cost.materials });
    check(cross.ok && cross.uid === rc.uid && b.save!.gold === goldB1 && b.save!.inventory.length === bagB1,
      `ключ первой ковки с другого героя — прежний uid, ничего не сковано и не списано (${cross.reason ?? cross.uid})`);
    check(a.connected && b.connected, 'оба героя в игре после гонки');
    for (const x of [a, b]) {
      check(x.errors.length === 0, `кадров error у ${x === a ? 'A' : 'B'}: ${x.errors.length}${x.errors.length ? ` — ${x.errors.join(' | ')}` : ''}`);
    }
    const finalA = structuredClone(a.save!), finalB = structuredClone(b.save!);
    await a.leave(); await b.leave();
    closes.push(a.closeCode ?? -1, b.closeCode ?? -1);
    let both = false;
    for (let i = 0; i < 60 && !both; i++) {
      const rows = (await db.query<{ char_id: string; data: SaveState }>('SELECT char_id, data FROM characters WHERE char_id = ANY($1)',
        [[character.charId, second.charId]])).rows;
      const sa = rows.find((r) => r.char_id === character.charId)?.data, sb = rows.find((r) => r.char_id === second.charId)?.data;
      both = sa?.gold === finalA.gold && sb?.gold === finalB.gold && craftedIn(sa) + craftedIn(sb) === 1;
      if (!both) await sleep(250);
    }
    check(both, 'в базе: золото обоих = последним saveUpdate, скованная одна на двоих');
    const w = (await db.query<{ data: { materials?: Record<string, number> } }>('SELECT data FROM account_stash WHERE user_id = $1', [userId])).rows[0]?.data.materials ?? {};
    check(Object.keys(cost.materials).every((id) => !w[id]), 'кошелёк в базе: нужного сырья 0');

    // ── 7. Ковка в полёте + мгновенный вход тем же героем из второй вкладки ──
    // Заявка ушла, и тут же тот же герой входит заново (старое соединение вытесняется, 4001). Вторая вкладка повторяет
    // ТОТ ЖЕ ключ. Сырья в кошельке на ДВЕ ковки — чтобы вторая вещь, если бы ключ не удержал, была видна, а не упёрлась
    // в нехватку. Обязано: одна вещь, одна цена — как бы ни легли вытеснение, прощальная запись и транзакция ковки.
    console.log('\n[7] ковка в полёте + вход тем же героем из второй вкладки');
    const double = { ...w };
    for (const [id, n] of Object.entries(cost.materials)) double[id] = 2 * n;
    await db.query(`UPDATE account_stash SET data = jsonb_set(data, '{materials}', $2::jsonb), version = version + 1 WHERE user_id = $1`,
      [userId, JSON.stringify(double)]);
    // Лимит кузницы — на АККАУНТ (5 сразу, дальше 2 в секунду, R4-17), и гонка шага 6 его почти выбрала: без паузы заявка
    // первой вкладки получала «Слишком часто», и ковка в полёте не проверялась вовсе.
    await sleep(2600);
    const t1 = new Conn();
    await t1.open(token, character.charId);
    const before7 = new Set(t1.save!.inventory.filter((i) => i.parts).map((i) => i.uid));
    const gold7 = t1.save!.gold;
    const n7 = `${nonce}-relog`;
    t1.send({ t: 'cmd', id: 7001, command: { cmd: 'craft', nonce: n7, input, maxGold: cost.gold, maxMaterials: cost.materials } });
    const t2 = new Conn();
    await t2.open(token, character.charId);
    await sleep(600);
    const r7 = await t2.expectRefusal({ cmd: 'craft', nonce: n7, input, maxGold: cost.gold, maxMaterials: cost.materials });
    const new7 = t2.save!.inventory.filter((i) => i.parts && !before7.has(i.uid)).map((i) => i.uid);
    const first7 = t1.results.get(7001);
    check(first7?.reason !== 'Слишком часто', `заявка первой вкладки дошла до кузнеца (${first7 ? (first7.ok ? 'ok' : first7.reason) : 'без ответа — вытеснена раньше'})`);
    check(r7.ok && new7.length === 1 && new7[0] === r7.uid && (!first7?.ok || first7.uid === r7.uid),
      `одна вещь на ключ: вкладка 1 — ${first7 ? (first7.ok ? first7.uid : first7.reason) : 'без ответа'}, вкладка 2 — ${r7.ok ? r7.uid : r7.reason}, новых ${new7.length}`);
    check(t2.save!.gold === gold7 - cost.gold, `золото ${gold7} → ${t2.save!.gold}: одна цена`);
    const w7 = (await t2.refreshStash()).materials;
    check(Object.entries(cost.materials).every(([id, n]) => (w7[id] ?? 0) === n), `кошелёк: списана одна ковка из двух (${JSON.stringify(w7)})`);
    check(t1.closeCode === 4001, `первая вкладка вытеснена (4001), закрыта кодом ${t1.closeCode}`);

    // ── 8. Переплавка в полёте + вход заново: вещь или цела, или переплавлена — не то и другое ──
    console.log('\n[8] переплавка в полёте + вход заново');
    const u8 = r7.uid!;
    const m8 = availableMaterials(t2.save!.inventory, w7);
    await sleep(2600);
    t2.send({ t: 'cmd', id: 8001, command: { cmd: 'forgeSalvage', uid: u8 } });
    const t3 = new Conn();
    await t3.open(token, character.charId);
    await sleep(600);
    const still = t3.save!.inventory.some((i) => i.uid === u8);
    const m8b = availableMaterials(t3.save!.inventory, (await t3.refreshStash()).materials);
    const moved8 = Object.keys(cost.materials).some((id) => (m8b[id] ?? 0) !== (m8[id] ?? 0));
    check(still !== moved8, `после входа: вещь ${still ? 'цела' : 'переплавлена'}, сырьё ${moved8 ? 'вернулось' : 'не менялось'} (ответ вкладки 1: ${t2.results.get(8001)?.ok ?? 'нет'})`);
    if (still) {
      const rm8 = await t3.cmd({ cmd: 'forgeSalvage', uid: u8 });
      check(rm8.ok, `переплавка со второй вкладки (${rm8.reason ?? 'ok'})`);
    }
    const m8c = availableMaterials(t3.save!.inventory, (await t3.refreshStash()).materials);
    const back8 = Object.fromEntries(Object.keys(cost.materials).map((id) => [id, (m8c[id] ?? 0) - (m8[id] ?? 0)]));
    check(Object.entries(back).every(([id, n]) => back8[id] === n), `вернулось ровно одна переплавка: ${JSON.stringify(back8)}`);
    check(t2.closeCode === 4001, `вкладка переплавки вытеснена (4001), закрыта кодом ${t2.closeCode}`);
    check(t3.errors.length === 0 && t2.errors.length === 0, `кадров error: ${[...t2.errors, ...t3.errors].join(' | ') || 0}`);
    const gold8 = t3.save!.gold;
    await t3.leave();
    closes.push(t3.closeCode ?? -1);
    let saved8 = false;
    for (let i = 0; i < 60 && !saved8; i++) {
      const r = (await db.query<{ data: SaveState }>('SELECT data FROM characters WHERE char_id = $1', [character.charId])).rows[0];
      saved8 = !!r && r.data.gold === gold8 && !r.data.inventory.some((it) => it.uid === u8);
      if (!saved8) await sleep(250);
    }
    check(saved8, 'в базе: золото = последнему saveUpdate, переплавленной нет');
    check(closes.every((code) => code !== 4008 && code !== 4009), `закрытия сокета без 4008/4009: ${closes.join(', ')}`);
  } finally {
    if (!KEEP) {
      await sleep(500);
      await db.query('DELETE FROM items WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM play_sessions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM char_claims WHERE char_id = ANY($1)', [charIds]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);   // сессии, герои и сундук — каскадом
      console.log(`\nаккаунт ${username} удалён (журнал item_events — только на дозапись, его строки остаются)`);
    }
    await db.end();
  }
}

main().then(() => {
  console.log(fails.length ? `\n✗ Провалов: ${fails.length}\n  - ${fails.join('\n  - ')}` : '\n✓ Ковка прошла от находки до переплавки, база сошлась.');
  process.exit(fails.length ? 1 : 0);
}, (e: unknown) => {
  console.error('\n✗ Стенд упал:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
