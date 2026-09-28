import WebSocket from 'ws';
import pg from 'pg';
import {
  applyWorldDelta, decodeWorldFrame, emptySnapshot, findPath, WIRE_FULL,
  type FloorInit, type PlayerInput, type SaveState, type ServerFrame, type WorldSnapshot,
} from '@dm/shared';

/**
 * ⭐ ЖИВЫЕ СЦЕНАРИИ ПАТИ И ВЫХОДА ПОСРЕДИ БОЯ (E2E 28.09) — против ЖИВОГО сервера и ТЕСТОВОЙ базы.
 *
 *   npm run loadtest:server   (в другом окне; база dungeon_test)
 *   npm run poc:party [-- --base=http://127.0.0.1:3999 --pg=postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test --only=s1,s4 --keep]
 *
 * Правила кругов 12–14 (R12-07, R13-01…R13-05, R14-01, R14-02) проверены юнит-тестами комнаты с моком базы; здесь — то же
 * настоящими кадрами протокола, через транспорт, менеджер комнат, маршрут гейтвея и настоящую базу:
 *   s1 — соло закрыл вкладку посреди боя: мир на паузе, «Продолжить» — тем же телом, без штрафа (R14-01);
 *   s2 — пати, B закрыл вкладку посреди боя при живом A: тело B стоит в бою, A его видит; B вернулся тем телом (R13-03);
 *   s3a — A погиб, B ушёл спокойно: через ~15 с A с пати в городе, окно смерти — статус без потерь, забег B припаркован (R12-07,
 *         R13-05);
 *   s3b — A погиб, B закрыл вкладку посреди боя: A получает статус с «В город» (canLeave) и уводит пати сам, B похоронен
 *         (R13-01, R13-05, R4-14);
 *   s4 — A мёртв и подключён, B закрыл вкладку посреди боя: мир стоит, тело B цело; B вернулся — мир снова идёт (R14-01);
 *   s5 — (E2E 28.09, четвёртый прогон) гость с припаркованным забегом по коду в подземелье чужого забега — отказ `run`, его забег цел
 *        (R16 C-03);
 *   s6 — A погиб в пати и закрыл вкладку: статус забега — «мёртв, оплачено» (`runStatus.dead`), «Завершить» — без второго штрафа
 *        (R16 C-09, V1);
 *   s7 — два героя одного аккаунта: A выбросил вещь, A и B разом поднимают — поднимает один, вещь ровно в одной строке базы и в леджере
 *        у него (K3, R2-02);
 *   drain — ТОЛЬКО кластер (от двух нод): пати (одно тело в бою) и соло посреди подземелья, слив их ноды; сейвы в базе не
 *         меньше увиденного, «Продолжить» сразу — на живой ноде тот же узел забега, и подъём слитой ноды его не сбрасывает.
 *   drainDead — ТОЛЬКО кластер: A погиб в пати, их ноду сливают; статус через гейтвей — «мёртв, оплачено», B продолжает на живой ноде,
 *         A «Продолжить» — к нему мёртвым ждать пати, без второго штрафа (K1, R16 C-09).
 * Бот простой: идёт к монстру, не бьёт (или бьёт — где нужно, чтобы шли опыт и добыча). Случай, ломающий посылку сценария
 * (вайп пати, пока ждали погоню), — повтор сценария, до трёх раз. Неожиданное закрытие (4008/4009) и кадр `error` — провал.
 *
 * ⚠ Стенд заводит аккаунты и удаляет их за собой (`--keep` — оставить) — поэтому работает ТОЛЬКО с базой `*_test`.
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
const ONLY = args.get('only')?.split(',');

if (!/\/[A-Za-z0-9_]+_test(\?|$)/.test(PG)) {
  console.error(`✗ poc:party заводит и удаляет аккаунты и работает только с тестовой базой (…_test), а не ${PG.replace(/:[^:@/]+@/, ':***@')}`);
  process.exit(1);
}

const fails: string[] = [];
const created: string[] = [];
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
interface Hero { token: string; charId: string }
async function hero(tag: string): Promise<Hero> {
  const username = `pty_${tag}_${Math.random().toString(36).slice(2, 7)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  created.push(username);
  const { character } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name: `P${tag}` }, token);
  return { token, charId: character.charId };
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Адрес ноды (Ф4.1): гейтвей выдаёт ноду героя или комнаты друга, одиночный сервер — себя. */
async function nodeUrl(h: Hero, roomCode?: string): Promise<string> {
  const q = `charId=${encodeURIComponent(h.charId)}${roomCode ? `&roomCode=${roomCode}` : ''}`;
  const r = await fetch(`${BASE}/api/route?${q}`, { headers: { authorization: `Bearer ${h.token}` } });
  if (!r.ok) throw new Error(`/api/route → ${r.status} ${await r.text()}`);
  return ((await r.json()) as { url: string }).url;
}

/** Одно соединение героя — ровно то, что видит клиент: сейв, этаж, мир, окна смерти. */
class Conn {
  ws!: WebSocket;
  save?: SaveState;
  floor?: FloorInit;
  world?: WorldSnapshot;
  playerId = '';
  roomCode = '';
  closeCode?: number;
  /** Когда герою последний раз снесли здоровье (по кадрам мира): бьют — значит, монстр до него точно дошёл. */
  hurtAt = 0;
  readonly errors: string[] = [];
  readonly died: Extract<ServerFrame, { t: 'died' }>[] = [];
  /** Ответы на команды по номеру (D3). */
  readonly results = new Map<number, Extract<ServerFrame, { t: 'cmdResult' }>>();
  private seq = 0;
  private cmdSeq = 0;
  private lastHp = Infinity;
  constructor(readonly name: string) {}

  async open(h: Hero, opts: { roomCode?: string; resume?: boolean; fresh?: boolean } = { fresh: true }): Promise<void> {
    this.ws = new WebSocket(await nodeUrl(h, opts.roomCode));
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('close', (code) => { this.closeCode = code; });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    this.ws.send(JSON.stringify({ t: 'join', token: h.token, charId: h.charId, ...opts }));
    if (!(await until(() => (!!this.save && !!this.floor) || this.errors.length > 0, 10_000))) throw new Error(`${this.name}: нет joined за 10 с`);
    if (!this.save) throw new Error(`${this.name}: вход отклонён — ${this.errors.join(' | ')}`);
  }
  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const f = decodeWorldFrame(new Uint8Array(data));
      const base = f.kind === WIRE_FULL ? emptySnapshot() : this.world;
      if (base) this.world = applyWorldDelta(base, f.delta);
      const hp = this.me()?.hp ?? Infinity;
      if (Number.isFinite(this.lastHp) && hp < this.lastHp) this.hurtAt = Date.now();
      this.lastHp = hp;
      return;
    }
    const f = JSON.parse(data.toString()) as ServerFrame;
    switch (f.t) {
      case 'joined': this.playerId = f.playerId; this.roomCode = f.roomCode; this.save = f.save; this.floor = f.floor; break;
      case 'areaChanged': this.floor = f.floor; this.world = undefined; break;
      case 'saveUpdate': this.save = f.save; break;
      case 'voteStart': this.send({ t: 'vote', accept: true }); break;
      case 'died': this.died.push(f); break;
      case 'error': this.errors.push(`${f.code}: ${f.msg}`); break;
      case 'cmdResult': if (f.id !== undefined) this.results.set(f.id, f); break;
      default: break;
    }
  }
  /** Команда города с номером — ответ (или `undefined` через 5 с). */
  async cmd(command: Record<string, unknown>): Promise<Extract<ServerFrame, { t: 'cmdResult' }> | undefined> {
    const id = 7000 + ++this.cmdSeq;
    this.send({ t: 'cmd', id, command });
    await until(() => this.results.has(id), 5000);
    return this.results.get(id);
  }
  send(frame: unknown): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame)); }
  input(input: Partial<PlayerInput>): void {
    this.send({ t: 'input', seq: this.seq++, input: { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false, ...input } });
  }
  me() { return this.world?.players.find((p) => p.id === this.playerId); }
  /** Закрыть вкладку: обрыв без `leave` и без кадра закрытия. */
  kill(): void { this.ws.terminate(); }
  async leave(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const closed = new Promise<void>((r) => this.ws.once('close', () => r()));
    this.send({ t: 'leave' });
    this.ws.close();
    await Promise.race([closed, sleep(3000)]);
  }
}

/** Идти к ближайшему живому монстру (бить — если `attack`), пока не выполнится `stop`. */
async function approach(c: Conn, ms: number, stop: () => boolean, attack = false): Promise<boolean> {
  const end = Date.now() + ms;
  let path: { x: number; y: number }[] = [];
  let pathAt = 0;
  while (Date.now() < end) {
    await sleep(33);
    if (stop()) return true;
    const me = c.me();
    if (!me || !c.floor || !c.world) continue;
    const m = c.world.monsters.filter((x) => x.alive).sort((a, b) => dist(a, me) - dist(b, me))[0];
    if (!m) { c.input({}); continue; }
    if (Date.now() - pathAt > 600 || path.length === 0) { path = findPath(c.floor.grid, me, m); pathAt = Date.now(); }
    while (path.length && dist(me, path[0]!) < 12) path.shift();
    const to = path[0] ?? m;
    const d = dist(me, to), dm = dist(me, m);
    const move = (attack && dm < 45) || d < 1 ? { x: 0, y: 0 } : { x: (to.x - me.x) / d, y: (to.y - me.y) / d };
    c.input({ move, facing: Math.atan2(m.y - me.y, m.x - me.x), attack: attack && dm < 75 });
  }
  return stop();
}
/**
 * `c` ПОСРЕДИ БОЯ по мере сервера (`inDanger`): рядом монстр в погоне, `c` — ближайший к нему живой, и `c` только что ранили.
 * Одной погони мало: монстр «гонится» и на слух за стеной (R7-08), а сервер считает опасностью только того, кто дойдёт; удар —
 * доказательство, что дошёл.
 */
function chased(c: Conn, others: Conn[] = []): boolean {
  const me = c.me();
  if (!me?.alive || !c.world || Date.now() - c.hurtAt > 800) return false;
  return c.world.monsters.some((m) => m.alive && m.aiState === 'chase' && dist(m, me) < 90
    && others.every((o) => { const p = c.world!.players.find((x) => x.id === o.playerId); return !p?.alive || dist(p, m) > dist(me, m); }));
}
/**
 * `c` не у выхода с этажа: у точки входа и у портала узла уход из боя — не бегство (R4-14, `Room.canLeave`: 64 px и короткий путь). Посылка
 * «сбежал посреди боя» без этой проверки не складывалась, когда монстр догонял героя у самого портала (E2E 28.09, четвёртый прогон: сервер
 * честно счёл уход спокойным, забег парковал, а мёртвый напарник получал «возвращаетесь в город» вместо «В город» сам).
 */
function awayFromExits(c: Conn): boolean {
  const me = c.me();
  if (!me || !c.floor) return false;
  return [c.floor.spawn, ...c.floor.decor.filter((d) => d.kind === 'portal')].every((e) => dist(e, me) > 100);
}
/** Стоять и отбиваться от подошедших. */
function guard(c: Conn): ReturnType<typeof setInterval> {
  let potAt = 0;
  return setInterval(() => {
    const me = c.me();
    const m = me && c.world?.monsters.filter((x) => x.alive).sort((a, b) => dist(a, me) - dist(b, me))[0];
    const belt = me && me.hp < 25 && Date.now() - potAt > 1500 ? c.save?.belt.findIndex((b) => !!b?.use) ?? -1 : -1;
    if (belt >= 0) potAt = Date.now();
    const drink = belt >= 0 ? { useBelt: belt } : {};
    if (me && m && dist(m, me) < 110) c.input({ facing: Math.atan2(m.y - me.y, m.x - me.x), attack: dist(m, me) < 75, ...drink });
    else c.input({ ...drink });
  }, 33);
}
/** Стоять на месте, как открытая вкладка: кадры ввода идут с частотой клиента. */
const idle = (c: Conn): ReturnType<typeof setInterval> => setInterval(() => c.input({}), 33);
async function toDungeon(host: Conn, all: Conn[]): Promise<boolean> {
  host.send({ t: 'descend', difficultyId: 'normal' });
  return until(() => all.every((c) => c.floor?.area === 'dungeon' && !!c.me()), 15_000);
}
async function party(tag: string): Promise<{ A: Conn; B: Conn; ha: Hero; hb: Hero } | undefined> {
  const ha = await hero(`${tag}a`), hb = await hero(`${tag}b`);
  const A = new Conn('A'), B = new Conn('B');
  await A.open(ha);
  await B.open(hb, { roomCode: A.roomCode });
  if (!check(B.roomCode === A.roomCode, `B в комнате A (${B.roomCode})`) || !check(await toDungeon(A, [A, B]), 'пати в подземелье')) {
    await A.leave(); await B.leave();
    return undefined;
  }
  return { A, B, ha, hb };
}
const noKick = (...cs: Conn[]): boolean =>
  check(cs.every((c) => c.closeCode !== 4008 && c.closeCode !== 4009), `закрытия без 4008/4009: ${cs.map((c) => c.closeCode ?? 'открыто').join(', ')}`);
const noErrors = (...cs: Conn[]): boolean =>
  check(cs.every((c) => c.errors.length === 0), `кадров error: ${cs.flatMap((c) => c.errors).join(' | ') || 0}`);

type Outcome = 'done' | 'retry';
/** Посылка сценария не состоялась (случай боя, а не сервер) — повтор; причина — в лог. */
function retry(why: string): Outcome {
  console.log(`    ⚠ ${why}`);
  return 'retry';
}

async function s1(): Promise<Outcome> {
  console.log('\n[s1] соло: закрыл вкладку посреди боя → «Продолжить»');
  const h = await hero('s1');
  const c = new Conn('A');
  await c.open(h);
  if (!check(await toDungeon(c, [c]), 'спуск в подземелье')) return 'done';
  if (!(await approach(c, 60_000, () => chased(c)))) { await c.leave(); return retry('монстр так и не дошёл до героя'); }
  await sleep(300);
  const hp0 = c.me()!.hp, node0 = c.floor!.runNodeId, gold0 = c.save!.gold;
  if (!c.me()!.alive) { await c.leave(); return retry('герой погиб раньше, чем закрыл вкладку'); }
  c.kill();
  await sleep(4000);
  const d = new Conn('A2');
  await d.open(h, { resume: true });
  await until(() => !!d.me(), 5000);
  const me = d.me();
  check(d.floor?.area === 'dungeon' && d.floor.runNodeId === node0, `вернулся на тот же узел ${d.floor?.runNodeId} (был ${node0})`);
  check(!!me?.alive && Math.abs(me.hp - hp0) <= Math.max(3, hp0 * 0.1), `тем же телом: HP ${me?.hp} (ушёл с ${hp0}) — мир стоял`);
  check(d.save!.gold === gold0 && d.died.length === 0, `без штрафа: золото ${gold0} → ${d.save!.gold}, окон смерти ${d.died.length}`);
  noErrors(d);
  await d.leave();
  noKick(c, d);
  return 'done';
}

async function s2(): Promise<Outcome> {
  console.log('\n[s2] пати: B закрыл вкладку посреди боя при живом A → тело в бою → B вернулся');
  const p = await party('s2');
  if (!p) return 'done';
  const { A, B, hb } = p;
  const keepA = idle(A);
  try {
    if (!(await approach(B, 60_000, () => chased(B, [A])))) return retry('монстр так и не дошёл до B');
    await sleep(200);
    const bPid = B.playerId, hp0 = B.me()!.hp;
    B.kill();
    await sleep(1500);
    const body = A.world?.players.find((x) => x.id === bPid);
    check(!!body, `A видит тело B в мире через 1,5 с после выхода (HP ${body?.hp ?? '—'}, ушёл с ${hp0})`);
    const B2 = new Conn('B2');
    await B2.open(hb, { resume: true });
    await until(() => !!B2.me(), 5000);
    const body2 = A.world?.players.find((x) => x.id === bPid);
    const me = B2.me();
    check(B2.roomCode === A.roomCode, `B вернулся в комнату пати (${B2.roomCode})`);
    check(!!me && (!me.alive || me.hp <= hp0 + 3), `встал тем телом: HP ${me?.hp}, жив ${me?.alive} (ушёл с ${hp0}, тело перед входом ${body2?.hp ?? '—'})`);
    noErrors(A, B2);
    await B2.leave();
    noKick(B, B2);
    return 'done';
  } finally {
    clearInterval(keepA);
    await A.leave();
    noKick(A);
  }
}

async function s3(calm: boolean): Promise<Outcome> {
  console.log(`\n[s3${calm ? 'a' : 'b'}] пати: A погиб, B ${calm ? 'ушёл спокойно → A в городе через ~15 с' : 'закрыл вкладку посреди боя → A жмёт «В город»'}`);
  const p = await party(calm ? 's3a' : 's3b');
  if (!p) return 'done';
  const { A, B, hb } = p;
  let keepB: ReturnType<typeof setInterval> | undefined = guard(B);
  let keepA: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => { clearInterval(keepB); clearInterval(keepA); };
  try {
    if (!(await approach(A, 120_000, () => !!A.me() && !A.me()!.alive))) return retry(`A не погиб за 2 мин (B погиб: ${B.died.length > 0})`);
    keepA = idle(A);
    await until(() => A.died.length > 0, 3000);   // кадр `died` идёт после кадра мира с alive=false
    if (B.died.length > 0) return retry('B погиб раньше A — вайп');
    check(A.died.length === 1 && !A.died[0]!.status && A.died[0]!.toTown === false, `первое окно смерти A — «ждите» (${JSON.stringify(A.died[0])})`);
    let ready: boolean;
    if (calm) {
      // Отбиться и выждать 2 с без погони: уход «не в бою».
      let quietFrom = 0;
      ready = await until(() => {
        if (!B.me()?.alive || B.died.length > 0 || B.floor?.area !== 'dungeon') return false;
        if ((B.world?.monsters ?? []).some((m) => m.alive && m.aiState === 'chase')) { quietFrom = 0; return false; }
        quietFrom ||= Date.now();
        return Date.now() - quietFrom > 2000;
      }, 90_000);
    } else {
      clearInterval(keepB); keepB = undefined;
      ready = await approach(B, 90_000, () => chased(B) && awayFromExits(B));
    }
    clearInterval(keepB); keepB = undefined;
    if (!ready || B.died.length > 0 || B.floor?.area !== 'dungeon') return retry(`B не ${calm ? 'отбился' : 'дождался удара'} (погиб: ${B.died.length > 0}, область ${B.floor?.area})`);
    if (calm) await B.leave(); else B.kill();
    const t0 = Date.now();
    if (!calm) {
      check(await until(() => A.died.some((d) => d.status && d.canLeave), 5000), `A получил статус с «В город» (canLeave): ${JSON.stringify(A.died.slice(1))}`);
      await sleep(500);
      A.send({ t: 'return' });
    }
    const home = await until(() => A.floor?.area === 'town', 25_000);
    const took = (Date.now() - t0) / 1000;
    check(home && (calm ? took >= 12 && took <= 22 : took < 5), `A в городе через ${took.toFixed(1)} с (ждём ${calm ? '~15' : 'сразу'})`);
    check(await until(() => !!A.me()?.alive, 3000), `A в городе жив (HP ${A.me()?.hp})`);
    check(A.died.slice(1).every((d) => d.status && d.goldLost === 0 && d.itemsLost === 0), `дальнейшие окна A — статус без потерь (${JSON.stringify(A.died.slice(1))})`);
    // Спокойный B — забег припаркован (пати ушла в город, R7-03); бежавший из боя — похоронен (R4-14).
    const B2 = new Conn('B2');
    await B2.open(hb, { fresh: true });
    check(B2.floor?.area === 'town', `B входит в город (${B2.floor?.area})`);
    check(calm ? !!B2.save?.run : !B2.save?.run, calm ? 'забег B припаркован' : 'забег B снят (похоронен как сбежавший из боя)');
    noErrors(A, B, B2);
    await B2.leave();
    noKick(B, B2);
    return 'done';
  } finally {
    stop();
    await A.leave(); await B.leave();
    noKick(A);
  }
}

async function s4(): Promise<Outcome> {
  console.log('\n[s4] пати: A мёртв и подключён, B закрыл вкладку посреди боя → мир стоит → B вернулся');
  const p = await party('s4');
  if (!p) return 'done';
  const { A, B, hb } = p;
  const keepB = guard(B);
  let keepA: ReturnType<typeof setInterval> | undefined;
  try {
    const dead = await approach(A, 120_000, () => !!A.me() && !A.me()!.alive);
    clearInterval(keepB);
    if (!dead || B.died.length > 0) return retry(`A не погиб или B погиб раньше (A мёртв: ${dead}, B погиб: ${B.died.length > 0})`);
    keepA = idle(A);
    if (!(await approach(B, 60_000, () => chased(B))) || B.died.length > 0) return retry('до B не дошёл монстр или B погиб');
    await sleep(200);
    const bPid = B.playerId;
    B.kill();
    await sleep(1000);
    const t1 = A.world?.tick ?? 0, body1 = A.world?.players.find((x) => x.id === bPid);
    await sleep(3000);
    const t2 = A.world?.tick ?? 0, body2 = A.world?.players.find((x) => x.id === bPid);
    check(!!body2?.alive && body1?.hp === body2.hp && t1 === t2, `мир стоит: тик ${t1} → ${t2}, тело B ${body1?.hp ?? '—'} → ${body2?.hp ?? '—'}`);
    const B2 = new Conn('B2');
    await B2.open(hb, { resume: true });
    await until(() => !!B2.me(), 5000);
    check(B2.roomCode === A.roomCode && !!B2.me()?.alive, `B вернулся в бой живым (HP ${B2.me()?.hp})`);
    const t3 = A.world?.tick ?? 0;
    await sleep(1500);
    check((A.world?.tick ?? 0) > t3, `мир снова идёт (${t3} → ${A.world?.tick})`);
    noErrors(A, B2);
    await B2.leave();
    noKick(B, B2);
    return 'done';
  } finally {
    clearInterval(keepB); clearInterval(keepA);
    await A.leave();
    noKick(A);
  }
}

/** Лобби-кадр без входа (`runStatus`, `abandon`): ответ сервера — нужный кадр или `error`; нет ответа за 5 с — `undefined`. */
async function lobby<T extends ServerFrame['t']>(h: Hero, t: 'runStatus' | 'abandon', want: T): Promise<Extract<ServerFrame, { t: T | 'error' }> | undefined> {
  const ws = new WebSocket(await nodeUrl(h));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const got = new Promise<Extract<ServerFrame, { t: T | 'error' }> | undefined>((res) => {
    const timer = setTimeout(() => res(undefined), 5000);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const f = JSON.parse(data.toString()) as ServerFrame;
      if (f.t === want || f.t === 'error') { clearTimeout(timer); res(f as Extract<ServerFrame, { t: T | 'error' }>); }
    });
  });
  ws.send(JSON.stringify({ t, token: h.token, charId: h.charId }));
  const f = await got;
  ws.close();
  return f;
}
/** Золото героя в базу, пока он вне игры (версия +1, как правка сейва): смерть должна стоить видимых денег. */
async function seedGold(db: pg.Pool, h: Hero, gold: number): Promise<void> {
  await db.query(`UPDATE characters SET data = jsonb_set(data, '{gold}', to_jsonb($2::int)), version = version + 1 WHERE char_id = $1`, [h.charId, gold]);
}
const rowOf = async (db: pg.Pool, h: Hero): Promise<SaveState | undefined> =>
  (await db.query<{ data: SaveState }>('SELECT data FROM characters WHERE char_id = $1', [h.charId])).rows[0]?.data;
/** Пати A+B с золотом у A (штраф смерти видно) — в подземелье. */
async function paidParty(db: pg.Pool, tag: string): Promise<{ A: Conn; B: Conn; ha: Hero; hb: Hero } | undefined> {
  const ha = await hero(`${tag}a`), hb = await hero(`${tag}b`);
  await seedGold(db, ha, 10_000);
  const A = new Conn('A'), B = new Conn('B');
  await A.open(ha);
  await B.open(hb, { roomCode: A.roomCode });
  if (!check(B.roomCode === A.roomCode && A.save?.gold === 10_000, `B в комнате A (${B.roomCode}), у A золото ${A.save?.gold}`)
    || !check(await toDungeon(A, [A, B]), 'пати в подземелье')) {
    await A.leave(); await B.leave();
    return undefined;
  }
  return { A, B, ha, hb };
}
/** A идёт к монстрам без удара, B отбивается: A погиб, B жив. Золото A после штрафа — или `undefined`, если посылка не сложилась. */
async function aDies(A: Conn, B: Conn): Promise<number | undefined> {
  const keepB = guard(B);
  try {
    const dead = await approach(A, 120_000, () => !!A.me() && !A.me()!.alive);
    if (!dead || B.died.length > 0 || !B.me()?.alive || !(await until(() => A.died.length > 0, 3000))) return undefined;
    return 10_000 - A.died[0]!.goldLost;
  } finally { clearInterval(keepB); }
}

/**
 * ⭐ s5 — R16 C-03: в подземелье — только участники его забега. C с припаркованным забегом (спуск и портал входа — город, забег цел) входит по
 * коду в комнату A, которая в подземелье ДРУГОГО забега: отказ `run`, а забег C цел и комната A его не посадила.
 */
async function s5(): Promise<Outcome> {
  console.log('\n[s5] гость с припаркованным забегом — по коду в подземелье чужого забега (R16 C-03)');
  const hc = await hero('s5c');
  const C = new Conn('C');
  await C.open(hc);
  if (!check(await toDungeon(C, [C]), 'C спустился соло')) { await C.leave(); return 'done'; }
  const cRun = C.floor!.runNodeId;
  await sleep(2000);   // голос — не раньше `VOTE_COOLDOWN_MS` после перехода (иначе «Подождите немного»)
  C.send({ t: 'return' });   // у точки входа, где спустился: голос соло проходит сам
  if (!check(await until(() => C.floor?.area === 'town', 5000), `C вернулся в город порталом (${C.floor?.area})`)) { await C.leave(); return 'done'; }
  await until(() => !!C.save?.run, 2000);
  check(!!C.save?.run, `забег C припаркован (узел ${C.save?.run?.currentNodeId ?? '—'}, был ${cRun})`);
  await C.leave();
  const ha = await hero('s5a');
  const A = new Conn('A');
  await A.open(ha);
  try {
    if (!check(await toDungeon(A, [A]), 'A спустился — своя комната в подземелье своего забега')) return 'done';
    const C2 = new Conn('C2');
    let refused = '';
    try { await C2.open(hc, { roomCode: A.roomCode }); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(refused !== '' && C2.errors.some((m) => m.startsWith('run:')), `вход C по коду ${A.roomCode} — отказ run (${refused || `вошёл в ${C2.roomCode}, область ${C2.floor?.area}`})`);
    if (!refused) await C2.leave();
    await sleep(500);
    check((A.world?.players ?? []).every((p) => p.id === A.playerId), `в мире A только A (${A.world?.players.length ?? 0} героев)`);
    const C3 = new Conn('C3');
    await C3.open(hc, { fresh: true });
    check(C3.floor?.area === 'town' && !!C3.save?.run, `забег C цел после отказа (область ${C3.floor?.area}, забег ${C3.save?.run ? 'есть' : 'НЕТ'})`);
    noErrors(A, C3);
    await C3.leave();
    noKick(C, C3);
    return 'done';
  } finally {
    await A.leave();
    noKick(A);
  }
}

/**
 * ⭐ s6 — R16 C-09 (одна нода): A погиб в пати и закрыл вкладку; экран входа знает, что смерть оплачена (`runStatus.dead`), и «Завершить» второго
 * штрафа не берёт (V1).
 */
async function s6(db: pg.Pool): Promise<Outcome> {
  console.log('\n[s6] пати: A погиб и закрыл вкладку → статус «мёртв, оплачено» → «Завершить» без второго штрафа (R16 C-09, V1)');
  const p = await paidParty(db, 's6');
  if (!p) return 'done';
  const { A, B, ha } = p;
  let keepB: ReturnType<typeof setInterval> | undefined;
  try {
    const gold = await aDies(A, B);
    if (gold === undefined) return retry(`A не погиб или B погиб раньше (A: ${A.me()?.alive}, B погиб: ${B.died.length > 0})`);
    keepB = guard(B);
    await until(() => A.save?.gold === gold, 2000);
    check(A.died[0]!.goldLost > 0 && !A.died[0]!.toTown && A.save?.gold === gold, `штраф смерти взят: −${A.died[0]!.goldLost}, золото ${A.save?.gold} (окно «ждите»)`);
    A.kill();
    await sleep(1000);
    const st = await lobby(ha, 'runStatus', 'runStatus');
    check(st?.t === 'runStatus' && st.hasRun && st.dead === true, `статус забега A: ${JSON.stringify(st)} (ждём hasRun, dead)`);
    const ab = await lobby(ha, 'abandon', 'abandoned');
    check(ab?.t === 'abandoned', `«Завершить» — ${JSON.stringify(ab)}`);
    await sleep(1000);
    const row = await rowOf(db, ha);
    check(row?.gold === gold && !row.run, `в базе без второго штрафа: золото ${row?.gold} (после смерти ${gold}), забег ${row?.run ? 'ЕСТЬ' : 'снят'}`);
    noErrors(B);
    return 'done';
  } finally {
    clearInterval(keepB);
    await A.leave(); await B.leave();
    noKick(B);
  }
}

/**
 * ⭐ s7 — K3 (проход правок 2), R2-02: передача вещи через землю — две записи, а вещь ровно в одном месте. Два героя ОДНОГО аккаунта в одной
 * комнате города: A снял шлем и выбросил его, A и B разом жмут «поднять» — поднимает ровно один; вещь в его сумке и в его строке базы, у
 * другого — нигде; леджер (`items.loc`) — у поднявшего.
 */
async function s7(db: pg.Pool): Promise<Outcome> {
  console.log('\n[s7] передача вещи через землю: A выбросил, A и B одного аккаунта разом поднимают (K3, R2-02)');
  const username = `pty_s7_${Math.random().toString(36).slice(2, 7)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  created.push(username);
  const mk = async (name: string): Promise<Hero> => {
    const { character } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name }, token);
    return { token, charId: character.charId };
  };
  const ha = await mk('P7a'), hb = await mk('P7b');
  const A = new Conn('A'), B = new Conn('B');
  await A.open(ha);
  await B.open(hb, { roomCode: A.roomCode });
  try {
    if (!check(B.roomCode === A.roomCode && A.floor?.area === 'town', `A и B одного аккаунта в одной комнате города (${B.roomCode})`)) return 'done';
    const un = await A.cmd({ cmd: 'unequip', slot: 'helm' });
    await until(() => !!A.save?.inventory.some((i) => i.baseId === 'leather-cap'), 3000);
    const uid = A.save?.inventory.find((i) => i.baseId === 'leather-cap')?.uid;
    if (!check(!!un?.ok && !!uid, `A снял шлем в сумку (${un?.reason ?? 'ok'})`)) return 'done';
    const dr = await A.cmd({ cmd: 'drop', uid });
    await until(() => (A.world?.drops ?? []).some((d) => d.kind === 'item' && d.item.uid === uid) && !A.save?.inventory.some((i) => i.uid === uid), 3000);
    const drop = (A.world?.drops ?? []).find((d) => d.kind === 'item' && d.item.uid === uid);
    if (!check(!!dr?.ok && !!drop, `A выбросил шлем на землю (дроп ${drop?.id ?? '—'})`)) return 'done';
    await sleep(1500);   // запись выброса легла — вещь отпущена (V-B2-04)
    const [ra, rb] = await Promise.all([A.cmd({ cmd: 'pickup', dropId: drop!.id }), B.cmd({ cmd: 'pickup', dropId: drop!.id })]);
    check([ra, rb].filter((r) => r?.ok).length === 1, `поднял ровно один: A ${ra?.ok ? 'да' : `нет (${ra?.reason})`}, B ${rb?.ok ? 'да' : `нет (${rb?.reason})`}`);
    const [who, other, hw, ho] = rb?.ok ? [B, A, hb, ha] : [A, B, ha, hb];
    await until(() => !!who.save?.inventory.some((i) => i.uid === uid), 3000);
    await sleep(1500);
    check(!!who.save?.inventory.some((i) => i.uid === uid) && !other.save?.inventory.some((i) => i.uid === uid)
      && !(who.world?.drops ?? []).some((d) => d.kind === 'item' && d.item.uid === uid), `вещь в сумке ${who.name}, у ${other.name} и на земле её нет`);
    const rw = JSON.stringify(await rowOf(db, hw) ?? {}), ro = JSON.stringify(await rowOf(db, ho) ?? {});
    const n = (s: string): number => s.split(uid!).length - 1;
    check(n(rw) === 1 && n(ro) === 0, `в базе: строка ${who.name} — ${n(rw)}, строка ${other.name} — ${n(ro)}`);
    const loc = (await db.query<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [uid])).rows[0]?.loc;
    check(loc === `char:${hw.charId}`, `леджер: вещь у ${who.name} (${loc ?? 'нет строки'})`);
    // Передача: поднявший выбрасывает снова, поднимает ДРУГОЙ герой — вещь уходит из строки одного и ложится в строку другого.
    const dr2 = await who.cmd({ cmd: 'drop', uid });
    await until(() => (other.world?.drops ?? []).some((d) => d.kind === 'item' && d.item.uid === uid), 3000);
    const drop2 = (other.world?.drops ?? []).find((d) => d.kind === 'item' && d.item.uid === uid);
    await sleep(1500);
    const rt = drop2 ? await other.cmd({ cmd: 'pickup', dropId: drop2.id }) : undefined;
    await until(() => !!other.save?.inventory.some((i) => i.uid === uid), 3000);
    await sleep(1500);
    const tw = JSON.stringify(await rowOf(db, hw) ?? {}), to = JSON.stringify(await rowOf(db, ho) ?? {});
    const loc2 = (await db.query<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [uid])).rows[0]?.loc;
    check(!!dr2?.ok && !!rt?.ok && n(tw) === 0 && n(to) === 1 && loc2 === `char:${ho.charId}`,
      `передача ${who.name} → ${other.name} через землю: выброс ${dr2?.ok ? 'ok' : dr2?.reason}, подъём ${rt?.ok ? 'ok' : rt?.reason}; в базе ${n(tw)} / ${n(to)}, леджер ${loc2 === `char:${ho.charId}` ? `у ${other.name}` : loc2}`);
    // Отказ проигравшему гонку приходит и кадром `error` (код `cmd`, как всякий отказ команды) — он ожидаем; прочих быть не должно.
    const lost = `cmd: ${(rb?.ok ? ra : rb)?.reason ?? ''}`;
    const extra = [...A.errors, ...B.errors].filter((e) => e !== lost);
    check(extra.length === 0, `кадров error, кроме отказа проигравшему: ${extra.join(' | ') || 0}`);
    return 'done';
  } finally {
    await A.leave(); await B.leave();
    noKick(A, B);
  }
}

/**
 * ⭐ drainDead — ТОЛЬКО кластер (K1, R16 C-09): A погиб в пати (штраф взят, B жив), их ноду сливают. Комнаты, помнившей смерть, больше нет —
 * правда в строке (`run.deadAt`): статус через гейтвей — «мёртв, оплачено», B продолжает на живой ноде, A «Продолжить» — в комнату B МЁРТВЫМ
 * ждать пати, без второго штрафа. Раньше новая комната ставила погибшего живым на узел смерти.
 */
async function drainDead(db: pg.Pool): Promise<Outcome> {
  console.log('\n[drainDead] A погиб в пати, слив ноды → «Продолжить»: B — жив на живой ноде, A — мёртвым ждать пати (K1, R16 C-09)');
  const key = process.env.DM_METRICS_KEY ?? '';
  const cl = await fetch(`${BASE}/api/cluster`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
    .then((r) => (r.ok ? r.json() as Promise<{ nodes: { id: string; url: string; draining: boolean }[] }> : undefined)).catch(() => undefined);
  const live = cl?.nodes.filter((n) => !n.draining) ?? [];
  if (live.length < 2) { console.log('    (не кластер или живых нод меньше двух — пропуск)'); return 'done'; }
  const p = await paidParty(db, 'dd');
  if (!p) return 'done';
  const { A, B, ha, hb } = p;
  const gold = await aDies(A, B);
  if (gold === undefined) { await A.leave(); await B.leave(); return retry(`A не погиб или B погиб раньше (A: ${A.me()?.alive}, B погиб: ${B.died.length > 0})`); }
  const keepA = idle(A), keepB = guard(B);
  const node0 = B.floor!.runNodeId;
  await sleep(1500);
  const victim = live.find((n) => n.id === `node-${A.roomCode.charCodeAt(0) - 65}`);
  if (!victim) { clearInterval(keepA); clearInterval(keepB); await A.leave(); await B.leave(); return 'done'; }
  const r = await fetch(`http://127.0.0.1:${new URL(victim.url).port}/internal/drain`, { method: 'POST' });
  check(r.ok, `слив ${victim.id}: ответ ${r.status}`);
  await until(() => A.closeCode !== undefined && B.closeCode !== undefined, 15_000);
  clearInterval(keepA); clearInterval(keepB);
  noKick(A, B);
  const rowA = await rowOf(db, ha);
  check(rowA?.run?.deadAt !== undefined && rowA.gold === gold, `A в базе после слива: «мёртв, оплачено» ${rowA?.run?.deadAt !== undefined}, золото ${rowA?.gold} (после смерти ${gold})`);
  const st = await lobby(ha, 'runStatus', 'runStatus');
  check(st?.t === 'runStatus' && st.hasRun && st.dead === true, `статус забега A через гейтвей: ${JSON.stringify(st)} (ждём hasRun, dead)`);
  const B2 = new Conn('B2'), A2 = new Conn('A2');
  try {
    await B2.open(hb, { resume: true });
    await until(() => !!B2.me(), 5000);
    check(B2.floor?.area === 'dungeon' && B2.floor.runNodeId === node0 && !!B2.me()?.alive && B2.roomCode[0] !== A.roomCode[0],
      `B продолжил на ${B2.roomCode}: узел ${B2.floor?.runNodeId} (был ${node0}), жив ${B2.me()?.alive}`);
    await A2.open(ha, { resume: true });
    await until(() => !!A2.me(), 5000);
    check(A2.roomCode === B2.roomCode && A2.floor?.area === 'dungeon', `A продолжил в комнату B (${A2.roomCode}, область ${A2.floor?.area})`);
    check(!!A2.me() && !A2.me()!.alive, `A — мёртвым ждать пати (жив ${A2.me()?.alive}, HP ${A2.me()?.hp})`);
    await sleep(1500);
    check(A2.save?.gold === gold && A2.died.every((d) => d.goldLost === 0 && d.itemsLost === 0), `без второго штрафа: золото ${A2.save?.gold} (после смерти ${gold}), окна ${JSON.stringify(A2.died)}`);
    noErrors(A2, B2);
  } catch (e) {
    check(false, `drainDead: «Продолжить» — ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await A2.leave().catch(() => undefined); await B2.leave().catch(() => undefined);
  }
  noKick(A2, B2);
  return 'done';
}

/** Бить ближайшего и идти к нему — чтобы шли опыт, золото, подбор; пить зелья на пороге. */
function fight(c: Conn): ReturnType<typeof setInterval> {
  let path: { x: number; y: number }[] = [];
  let at = 0;
  return setInterval(() => {
    const me = c.me();
    if (!me?.alive || !c.floor || !c.world) { c.input({}); return; }
    const m = c.world.monsters.filter((x) => x.alive).sort((a, b) => dist(a, me) - dist(b, me))[0];
    if (!m) { c.input({}); return; }
    const dm = dist(m, me);
    if (Date.now() - at > 600 || !path.length) { path = findPath(c.floor.grid, me, m); at = Date.now(); }
    while (path.length && dist(me, path[0]!) < 12) path.shift();
    const to = path[0] ?? m;
    const d = dist(me, to);
    const belt = me.hp < 20 ? c.save?.belt.findIndex((b) => !!b?.use) ?? -1 : -1;
    c.input({
      move: dm < 45 || d < 1 ? { x: 0, y: 0 } : { x: (to.x - me.x) / d, y: (to.y - me.y) / d },
      facing: Math.atan2(m.y - me.y, m.x - me.x), attack: dm < 75, ...(belt >= 0 ? { useBelt: belt } : {}),
    });
  }, 33);
}

async function drain(db: pg.Pool): Promise<Outcome> {
  console.log('\n[drain] слив ноды посреди подземелья: пати (тело B в бою) и соло → «Продолжить» сразу на живой ноде');
  // Состав кластера — служебная ручка: с машины сервера или с ключом чтения метрик (R6-20); слив — только с самой машины.
  const key = process.env.DM_METRICS_KEY ?? '';
  const cl = await fetch(`${BASE}/api/cluster`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
    .then((r) => (r.ok ? r.json() as Promise<{ nodes: { id: string; url: string; draining: boolean }[] }> : undefined)).catch(() => undefined);
  const live = cl?.nodes.filter((n) => !n.draining) ?? [];
  if (live.length < 2) { console.log('    (не кластер или живых нод меньше двух — пропуск)'); return 'done'; }
  const p = await party('dr');
  if (!p) return 'done';
  const { A, B, ha, hb } = p;
  // Соло — на ту же ноду (первая буква кода комнаты называет ноду, R5-14): гейтвей раскладывает по нагрузке.
  let hc = await hero('drc');
  let C = new Conn('C');
  await C.open(hc);
  for (let i = 0; i < 8 && C.roomCode[0] !== A.roomCode[0]; i++) { await C.leave(); hc = await hero('drc'); C = new Conn('C'); await C.open(hc); }
  if (!check(C.roomCode[0] === A.roomCode[0] && await toDungeon(C, [C]), `соло C на ноде пати (${C.roomCode}) и в подземелье`)) {
    await A.leave(); await B.leave(); await C.leave();
    return 'done';
  }
  const timers = [fight(A), fight(B), fight(C)];
  const stopAll = (): void => { for (const t of timers) clearInterval(t); };
  await sleep(15_000);
  clearInterval(timers[1]);
  const hot = await approach(B, 30_000, () => chased(B, [A]));
  const heroes = [['A', A, ha], ['B', B, hb], ['C', C, hc]] as const;
  if (!hot || heroes.some(([, c]) => c.floor?.area !== 'dungeon' || c.died.length > 0)) {
    stopAll(); await A.leave(); await B.leave(); await C.leave();
    return retry('до B не дошёл монстр, или кто-то погиб до слива');
  }
  const seen = new Map(heroes.map(([n, c]) => [n, { xp: c.save!.xp, gold: c.save!.gold, node: c.floor!.runNodeId }]));
  B.kill();
  await sleep(300);
  const victim = live.find((n) => n.id === `node-${A.roomCode.charCodeAt(0) - 65}`);
  if (!victim) { stopAll(); await A.leave(); await C.leave(); return 'done'; }
  const r = await fetch(`http://127.0.0.1:${new URL(victim.url).port}/internal/drain`, { method: 'POST' });
  check(r.ok, `слив ${victim.id}: ответ ${r.status}`);
  await until(() => A.closeCode !== undefined && C.closeCode !== undefined, 15_000);
  stopAll();
  noKick(A, B, C);
  for (const [n, , h] of heroes) {
    const row = (await db.query<{ data: SaveState }>('SELECT data FROM characters WHERE char_id = $1', [h.charId])).rows[0];
    const s = seen.get(n)!;
    check(!!row?.data.run && row.data.xp >= s.xp, `${n} в базе после слива: опыт ${row?.data.xp} (видели ${s.xp}), забег ${row?.data.run ? 'есть' : 'НЕТ'}`);
  }
  const back: Conn[] = [];
  for (const [n, , h] of heroes) {
    const x = new Conn(`${n}2`);
    try { await x.open(h, { resume: true }); } catch (e) { check(false, `${n}: «Продолжить» на живой ноде — ${e instanceof Error ? e.message : String(e)}`); continue; }
    back.push(x);
    await until(() => !!x.me(), 5000);
    check(x.floor?.area === 'dungeon' && x.floor.runNodeId === seen.get(n)!.node && x.roomCode[0] !== A.roomCode[0],
      `${n}: продолжил на ${x.roomCode} — узел ${x.floor?.runNodeId} (был ${seen.get(n)!.node}), HP ${x.me()?.hp}`);
  }
  // Слитая нода поднимается (супервизор) и сбрасывает незавершённые забеги «ничьих» героев — продолживших это не касается.
  await sleep(8000);
  for (const [n, , h] of heroes) {
    const row = (await db.query<{ data: SaveState }>('SELECT data FROM characters WHERE char_id = $1', [h.charId])).rows[0];
    check(!!row?.data.run, `${n}: забег в базе цел после подъёма слитой ноды`);
  }
  noErrors(...back);
  for (const x of back) await x.leave();
  noKick(...back);
  return 'done';
}

async function main(): Promise<void> {
  const db = new pg.Pool({ connectionString: PG, max: 2 });
  const all: [string, () => Promise<Outcome>][] = [
    ['s1', s1], ['s2', s2], ['s3a', () => s3(true)], ['s3b', () => s3(false)], ['s4', s4], ['s5', s5], ['s6', () => s6(db)], ['s7', () => s7(db)],
    ['drain', () => drain(db)], ['drainDead', () => drainDead(db)],
  ];
  try {
    for (const [id, fn] of all) {
      if (ONLY && !ONLY.includes(id)) continue;
      let out: Outcome = 'retry';
      for (let i = 0; i < 3 && out === 'retry'; i++) {
        if (i > 0) console.log(`    ⚠ повтор ${id}: ${i}`);
        try { out = await fn(); } catch (e) { check(false, `${id} упал: ${e instanceof Error ? e.stack : String(e)}`); out = 'done'; }
      }
      if (out === 'retry') check(false, `${id}: посылка сценария не состоялась за три попытки`);
    }
  } finally {
    if (!KEEP && created.length) {
      await sleep(1000);
      const ids = (await db.query<{ id: string }>('SELECT id FROM users WHERE username = ANY($1)', [created])).rows.map((r) => r.id);
      const chars = (await db.query<{ char_id: string }>('SELECT char_id FROM characters WHERE user_id = ANY($1)', [ids])).rows.map((r) => r.char_id);
      await db.query('DELETE FROM items WHERE user_id = ANY($1)', [ids]);
      await db.query('DELETE FROM play_sessions WHERE user_id = ANY($1)', [ids]);
      await db.query('DELETE FROM char_claims WHERE char_id = ANY($1)', [chars]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [ids]);   // сессии, герои и сундук — каскадом
      console.log(`\nаккаунтов удалено: ${ids.length} (журнал item_events — только на дозапись, его строки остаются)`);
    }
    await db.end();
  }
}

main().then(() => {
  console.log(fails.length ? `\n✗ Провалов: ${fails.length}\n  - ${fails.join('\n  - ')}` : '\n✓ Пати и выход посреди боя — как задумано.');
  process.exit(fails.length ? 1 : 0);
}, (e: unknown) => {
  console.error('\n✗ Стенд упал:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
