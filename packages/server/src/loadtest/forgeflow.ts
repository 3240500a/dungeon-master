import WebSocket from 'ws';
import pg from 'pg';
import {
  CONFIG_REV_HEADER, CRAFT_SLOT_LIST, ConfigRegistry, WIRE_FULL, applyWorldDelta, availableMaterials, craftWeapon, decodeWorldFrame,
  emptyJournal, emptySnapshot, emptyStash, enchantCost, keySlotOf, keyVariantsByBase, normalizeJournal, salvageRange, sketchable, variantsFor,
  type CraftInput, type FloorInit, type SaveState, type ServerFrame, type WorldSnapshot,
} from '@dm/shared';

/**
 * ⭐ КРАЯ КУЗНИЦЫ ЖИВЬЁМ (E2E 29.09) — против ЖИВОГО сервера и ТЕСТОВОЙ базы, без охоты (журнал и сырьё засеваются в базу).
 *
 *   npm run loadtest:server   (в другом окне; база dungeon_test)
 *   npm run poc:forge [-- --base=http://127.0.0.1:3999 --pg=postgresql://dm:dmpass@127.0.0.1:5432/dungeon_test --keep]
 *
 * `poc:craft` идёт путём игрока от находки; здесь — то, чего на том пути нет, настоящими кадрами протокола:
 *   0) ревизия конфига: заголовок сервера (`x-config-rev`) = ревизия реестра клиента из того же тела; условный запрос — 304;
 *   1) согласие на конфиг: ковка с `cfgRev` сервера проходит, с чужим — «Цена изменилась» (и у зачарования, и у переплавки), ничего не списано;
 *   2) конвейер: четыре заявки разом при кошельке на три — ровно три вещи, по цене на каждую;
 *   3) зачарование и переплавка одной вещи подряд, не дожидаясь ответа, — обе по очереди, золото и сырьё сходятся;
 *   4) надетую и лежащую в сундуке скованную не разобрать (у кузнеца и на месте) и не зачаровать;
 *   5) эскиз открывает деталь, второй — «Эскизов нет»;
 *   6) переплавка в полёте и обрыв сокета без `leave` — вещь или цела, или переплавлена; повтор ключа после обрыва — прежний uid без траты;
 *      проданная скованная: повтор её ключа — прежний uid, вещь не возвращается, золото не тронуто;
 *   7) подземелье: разбор скованной на месте (вилка поля не щедрее кузницы), выброс и подъём скованной;
 *   8) сверка с базой: сейв, кошелёк, ключи заявок, леджер каждой скованной, и ТЕЛЕМЕТРИЯ кузницы в `play_sessions` — ровно состоявшееся
 *      (живьём здесь найдено: эскиз писался причиной `craft` и считался ковкой — «сковано 5» при четырёх ковках).
 * Неожиданное закрытие сокета (4008/4009) и кадр `error` — провал. Кластер — тот же запуск с `--base=` гейтвея.
 *
 * ⚠ Стенд ПИШЕТ в базу (золото, сырьё, журнал, удаление своего аккаунта) — поэтому работает ТОЛЬКО с базой `*_test`.
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
/** Ревизия правильного вида, которой у сервера нет (схема `cfgRev`: `[0-9a-z]{1,13}-[0-9a-z]{1,13}`). */
const STALE_REV = 'vn-0000000';

if (!/\/[A-Za-z0-9_]+_test(\?|$)/.test(PG)) {
  console.error(`✗ poc:forge пишет в базу и работает только с тестовой (…_test), а не ${PG.replace(/:[^:@/]+@/, ':***@')}`);
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
/** Адрес игрового сокета — у маршрута, как у настоящего клиента (гейтвей кластера отвечает адресом ноды, одиночный сервер — собой). */
async function nodeUrl(token: string, charId: string): Promise<string> {
  const r = await fetch(`${BASE}/api/route?charId=${encodeURIComponent(charId)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`/api/route → ${r.status} ${await r.text()}`);
  return ((await r.json()) as { url: string }).url;
}

type CmdResult = Extract<ServerFrame, { t: 'cmdResult' }>;
type StashFrame = Extract<ServerFrame, { t: 'stash' }>;

/** Одно соединение героя: сейв, сундук, мир и ответы на команды — ровно то, что видит клиент. */
class Conn {
  ws!: WebSocket;
  save?: SaveState;
  floor?: FloorInit;
  stash?: StashFrame;
  world?: WorldSnapshot;
  playerId = '';
  closeCode?: number;
  readonly errors: string[] = [];
  readonly results = new Map<number, CmdResult>();
  private nextId = 1;
  private seq = 0;

  async open(token: string, charId: string): Promise<void> {
    this.ws = new WebSocket(await nodeUrl(token, charId));
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
      case 'joined': this.playerId = f.playerId; this.save = f.save; this.floor = f.floor; break;
      case 'areaChanged': this.floor = f.floor; break;
      case 'saveUpdate': this.save = f.save; break;
      case 'stash': this.stash = f; break;
      case 'cmdResult': if (f.id !== undefined) this.results.set(f.id, f); break;
      case 'voteStart': this.ws.send(JSON.stringify({ t: 'vote', accept: true })); break;
      case 'error': this.errors.push(`${f.code}: ${f.msg}`); break;
      default: break;
    }
  }
  send(frame: unknown): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame)); }
  idle(): void { this.send({ t: 'input', seq: this.seq++, input: { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false } }); }
  id(): number { return this.nextId++; }
  async wait(id: number): Promise<CmdResult> {
    if (!(await until(() => this.results.has(id), 10_000))) throw new Error(`нет cmdResult на #${id}`);
    return this.results.get(id)!;
  }
  async cmd(command: Record<string, unknown>): Promise<CmdResult> {
    const id = this.id();
    this.send({ t: 'cmd', id, command });
    return this.wait(id);
  }
  /** Отказ, которого стенд ЖДЁТ: на него сервер шлёт и старый кадр `error` — он ожидаемый и из счёта ошибок соединения убирается. */
  async expectRefusal(command: Record<string, unknown>): Promise<CmdResult> {
    const before = this.errors.length;
    const r = await this.cmd(command);
    if (!r.ok) await this.dropErr(before, r.reason);
    return r;
  }
  async dropErr(before: number, reason?: string): Promise<void> {
    if (await until(() => this.errors.length > before, 1000)) {
      const i = this.errors.findIndex((e, k) => k >= before && e.endsWith(reason ?? ''));
      if (i >= 0) this.errors.splice(i, 1);
    }
  }
  /** Свежий слепок сундука: `stashOpen` отвечает кадром `stash` ДО своего `cmdResult`. */
  async refreshStash(): Promise<StashFrame> { await this.cmd({ cmd: 'stashOpen' }); return this.stash!; }
  async leave(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((r) => this.ws.once('close', () => r()));
      this.send({ t: 'leave' });
      this.ws.close();
      await Promise.race([closed, sleep(3000)]);
    }
  }
}

/** Честная заявка из конфига сервера: одноручный меч, в каждом гнезде первая форма, чьё окно берёт ступень 1. */
function honestInput(reg: ConfigRegistry): CraftInput {
  const cls = 'sword', hands = 1, step = 1;
  const keySlot = keySlotOf(reg, cls);
  const group = keyVariantsByBase(reg, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax));
  const parts = {} as CraftInput['parts'];
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group?.variants ?? [] : variantsFor(reg, cls, slot, hands);
    const v = pool.find((p) => p.stepMin <= step && step <= p.stepMax);
    if (!v) throw new Error(`в конфиге нет детали гнезда ${slot} для ступени 1`);
    parts[slot] = { id: v.id, step };
  }
  return { weaponClass: cls, hands, parts };
}

/** Скованные у героя — в сумке и на нём. */
const forged = (s?: SaveState): string[] => [
  ...(s?.inventory ?? []).filter((i) => i.parts).map((i) => i.uid),
  ...Object.values(s?.equipment ?? {}).filter((i) => !!i?.parts).map((i) => i!.uid),
];

async function main(): Promise<void> {
  // ── 0. Ревизия конфига ───────────────────────────────────────────────────
  console.log('[0] ревизия конфига');
  const reg = new ConfigRegistry();
  reg.loadAll();
  const cr = await fetch(BASE + '/api/config');
  const rev = cr.headers.get(CONFIG_REV_HEADER) ?? '';
  const etag = cr.headers.get('etag') ?? '';
  reg.reload((await cr.json()) as Parameters<ConfigRegistry['reload']>[0]);
  check(!!rev && reg.revision() === rev, `ревизия клиента из тела = заголовку сервера (${reg.revision()} / ${rev || '—'})`);
  const c304 = await fetch(BASE + '/api/config', { headers: { 'if-none-match': etag } });
  check(c304.status === 304, `условный запрос с ETag → ${c304.status}`);
  if (!reg.get('balance').craft.live) { console.error('✗ ковка на сервере закрыта (balance.craft.live = false)'); process.exit(1); }

  const input = honestInput(reg);
  const pv = craftWeapon(reg, input, { materialsOn: true });
  const baseId = pv.type?.baseId;
  if (!pv.ok || !pv.cost || !baseId) throw new Error(`предпросмотр честной заявки: ${pv.reason ?? '?'}`);
  const cost = pv.cost;
  console.log(`    заявка ${baseId}: ${cost.gold} зол., ${JSON.stringify(cost.materials)}`);

  const db = new pg.Pool({ connectionString: PG, max: 2 });
  const username = `frg_${Math.random().toString(36).slice(2, 8)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name: 'Подмастерье' }, token);
  const userId = (await db.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])).rows[0]?.id;
  if (!userId) throw new Error('аккаунт не найден в базе — стенд смотрит не в ту базу, что сервер?');
  console.log(`    аккаунт ${username} (${userId}), герой ${character.charId}, база ${PG.replace(/:[^:@/]+@/, ':***@')}`);
  const nonces = new Map<string, string>();   // ключ заявки → uid скованной
  const melted = new Set<string>();
  let crafted = 0;
  let enchanted = 0;
  const closes: number[] = [];

  try {
    // Первый вход заводит героя в игре; строки сундука у нового аккаунта ещё нет — стенд её заводит.
    let c = new Conn();
    await c.open(token, character.charId);
    await c.leave();
    closes.push(c.closeCode ?? -1);
    await sleep(800);
    // Засев, пока героя нет в игре: золото, кошелёк ровно на четыре ковки, журнал базы и её деталей, один эскиз.
    const GOLD = 50_000;
    await db.query(`UPDATE characters SET data = jsonb_set(data, '{gold}', to_jsonb($2::int)), version = version + 1 WHERE char_id = $1`, [character.charId, GOLD]);
    const wallet = Object.fromEntries(Object.entries(cost.materials).map(([id, n]) => [id, 4 * n]));
    const journal = { ...emptyJournal(), bases: [baseId], variants: CRAFT_SLOT_LIST.map((s) => input.parts[s].id), tierHi: 0, sketches: 1 };
    await db.query(`INSERT INTO account_stash (user_id, data, updated_at, version) VALUES ($1, $2, now(), 1) ON CONFLICT (user_id) DO NOTHING`,
      [userId, JSON.stringify(emptyStash(reg))]);
    await db.query(`UPDATE account_stash SET data = data || jsonb_build_object('materials', $2::jsonb, 'forgeJournal', $3::jsonb), version = version + 1 WHERE user_id = $1`,
      [userId, JSON.stringify(wallet), JSON.stringify(journal)]);

    c = new Conn();
    await c.open(token, character.charId);
    check(c.save!.gold === GOLD, `золото после входа ${c.save!.gold} = засеянному`);

    // ── 1. Согласие на конфиг ──────────────────────────────────────────────
    console.log('\n[1] согласие на конфиг (cfgRev)');
    const n1 = `frg1-${Math.random().toString(36).slice(2, 12)}`;
    const r1 = await c.cmd({ cmd: 'craft', nonce: n1, input, maxGold: cost.gold, maxMaterials: cost.materials, cfgRev: rev });
    if (check(r1.ok && !!r1.uid, `ковка с cfgRev сервера — ok (${r1.reason ?? r1.uid})`)) { nonces.set(n1, r1.uid!); crafted++; }
    check(c.save!.gold === GOLD - cost.gold, `золото ${GOLD} → ${c.save!.gold}`);
    const g1 = c.save!.gold, bag1 = c.save!.inventory.length;
    const rb = await c.expectRefusal({ cmd: 'craft', nonce: `${n1}-stale`, input, maxGold: cost.gold, maxMaterials: cost.materials, cfgRev: STALE_REV });
    check(!rb.ok && /Цена изменилась/.test(rb.reason ?? '') && c.save!.gold === g1 && c.save!.inventory.length === bag1, `чужой cfgRev — «${rb.reason}», ничего не списано`);
    const re0 = await c.expectRefusal({ cmd: 'forgeEnchant', uid: r1.uid, rarity: 'magic', maxGold: 1_000_000, cfgRev: STALE_REV });
    const rs0 = await c.expectRefusal({ cmd: 'forgeSalvage', uid: r1.uid, cfgRev: STALE_REV });
    check(!re0.ok && !rs0.ok && c.save!.inventory.some((i) => i.uid === r1.uid && i.rarity === 'normal') && c.save!.gold === g1,
      `зачарование и переплавка с чужим cfgRev — отказы (${re0.reason} · ${rs0.reason})`);

    // ── 2. Конвейер ────────────────────────────────────────────────────────
    console.log('\n[2] конвейер: четыре заявки разом при кошельке на три');
    await sleep(2600);   // лимит кузницы: запас 5, +2 в секунду (R4-17)
    const w2 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const can = Math.min(...Object.entries(cost.materials).map(([id, n]) => Math.floor((w2[id] ?? 0) / n)));
    check(can === 3, `в кошельке ровно на ${can} ковки`);
    const g2 = c.save!.gold;
    const pipe = Array.from({ length: 4 }, (_, i) => ({ id: c.id(), nonce: `frg2-${i}-${Math.random().toString(36).slice(2, 10)}` }));
    for (const p of pipe) {
      c.send({ t: 'cmd', id: p.id, command: { cmd: 'craft', nonce: p.nonce, input, maxGold: cost.gold, maxMaterials: cost.materials, cfgRev: rev } });
    }
    const e2 = c.errors.length;
    const pr = await Promise.all(pipe.map((p) => c.wait(p.id)));
    for (const r of pr) if (!r.ok) await c.dropErr(e2, r.reason);
    pr.forEach((r, i) => { if (r.ok) { nonces.set(pipe[i]!.nonce, r.uid!); crafted++; } });
    const okN = pr.filter((r) => r.ok).length;
    check(okN === 3, `сковано ${okN} из 4: ${pr.map((r) => (r.ok ? 'ok' : r.reason)).join(' | ')}`);
    check(new Set(pr.filter((r) => r.ok).map((r) => r.uid)).size === okN, 'у скованных разные uid');
    check(c.save!.gold === g2 - okN * cost.gold, `золото ${g2} → ${c.save!.gold} (${okN} × ${cost.gold})`);
    const w2b = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    check(Object.entries(cost.materials).every(([id, n]) => (w2[id] ?? 0) - (w2b[id] ?? 0) === okN * n), `сырьё списано ровно ${okN} раза`);
    const made = pr.filter((r) => r.ok).map((r) => r.uid!);
    if (made.length < 3) throw new Error('конвейер не сковал трёх вещей — дальше проверять нечем');
    const [u4, u5, u6] = made as [string, string, string];

    // ── 3. Зачарование и переплавка подряд ──────────────────────────────────
    console.log('\n[3] зачарование и переплавка одной вещи подряд, не дожидаясь ответа');
    await sleep(2600);
    const u3 = r1.uid!;
    const it3 = c.save!.inventory.find((i) => i.uid === u3)!;
    const eCost = enchantCost(reg, it3, 'magic');
    const g3 = c.save!.gold;
    const m3 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const idE = c.id(), idM = c.id();
    const e3 = c.errors.length;
    c.send({ t: 'cmd', id: idE, command: { cmd: 'forgeEnchant', uid: u3, rarity: 'magic', maxGold: eCost, cfgRev: rev } });
    c.send({ t: 'cmd', id: idM, command: { cmd: 'forgeSalvage', uid: u3, cfgRev: rev } });
    const rE = await c.wait(idE), rM = await c.wait(idM);
    if (!rE.ok) await c.dropErr(e3, rE.reason);
    if (!rM.ok) await c.dropErr(e3, rM.reason);
    if (rE.ok) enchanted++;
    if (rM.ok) melted.add(u3);
    check(rE.ok && rM.ok, `зачарование ${rE.ok ? 'ok' : rE.reason}, переплавка ${rM.ok ? 'ok' : rM.reason}`);
    check(!c.save!.inventory.some((i) => i.uid === u3), 'переплавленной в сумке нет');
    check(c.save!.gold === g3 - (rE.ok ? eCost : 0), `золото ${g3} → ${c.save!.gold} (зачарование ${eCost})`);
    const m3b = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const back3 = Object.fromEntries(Object.keys(cost.materials).map((id) => [id, (m3b[id] ?? 0) - (m3[id] ?? 0)]));
    const rng3 = salvageRange(reg, it3, false).range;
    check(Object.entries(rng3).every(([id, r]) => back3[id]! >= r.min && back3[id]! <= r.max), `переплавка вернула ${JSON.stringify(back3)} в вилке карточки`);

    // ── 4. Надетая и в сундуке ──────────────────────────────────────────────
    console.log('\n[4] надетая и лежащая в сундуке скованная');
    await sleep(2600);
    const eq = await c.cmd({ cmd: 'equip', uid: u4 });
    check(eq.ok && c.save!.equipment.weapon?.uid === u4, `надета (${eq.reason ?? 'ok'})`);
    const g4 = c.save!.gold;
    const s4 = await c.expectRefusal({ cmd: 'forgeSalvage', uid: u4, cfgRev: rev });
    const f4 = await c.expectRefusal({ cmd: 'salvage', uid: u4, cfgRev: rev });
    const e4 = await c.expectRefusal({ cmd: 'forgeEnchant', uid: u4, rarity: 'magic', maxGold: 1_000_000, cfgRev: rev });
    check(!s4.ok && !f4.ok && !e4.ok && c.save!.equipment.weapon?.uid === u4 && c.save!.equipment.weapon?.rarity === 'normal' && c.save!.gold === g4,
      `надетую — ни разобрать, ни зачаровать (${s4.reason} · ${f4.reason} · ${e4.reason})`);
    const mv = await c.cmd({ cmd: 'stashMove', uid: u5, dst: 0, x: 0, y: 0 });
    check(mv.ok && !c.save!.inventory.some((i) => i.uid === u5), `в сундук (${mv.reason ?? 'ok'})`);
    await sleep(2600);
    const s5 = await c.expectRefusal({ cmd: 'forgeSalvage', uid: u5, cfgRev: rev });
    const e5 = await c.expectRefusal({ cmd: 'forgeEnchant', uid: u5, rarity: 'magic', maxGold: 1_000_000, cfgRev: rev });
    check(!s5.ok && !e5.ok && c.save!.gold === g4, `из сундука — ни разобрать, ни зачаровать (${s5.reason} · ${e5.reason})`);
    const mb = await c.cmd({ cmd: 'stashMove', uid: u5, dst: 'inv', x: 0, y: 2 });
    check(mb.ok && c.save!.inventory.some((i) => i.uid === u5), `из сундука назад (${mb.reason ?? 'ok'})`);

    // ── 5. Эскиз ────────────────────────────────────────────────────────────
    console.log('\n[5] эскиз');
    const variant = reg.get('weapon-parts').find((p) => sketchable(reg, normalizeJournal(journal), p.id));
    if (check(!!variant, `есть деталь, которую открывает эскиз (${variant?.id ?? '—'})`)) {
      const k1 = await c.cmd({ cmd: 'forgeSketch', variantId: variant!.id, cfgRev: rev });
      const jr = normalizeJournal((await c.refreshStash()).forgeJournal);
      check(k1.ok && jr.variants.includes(variant!.id) && jr.sketches === 0, `эскиз открыл ${variant!.id} (${k1.reason ?? 'ok'}), эскизов ${jr.sketches}`);
      const next = reg.get('weapon-parts').find((p) => !jr.variants.includes(p.id) && sketchable(reg, { ...jr, sketches: 1 }, p.id));
      const k2 = await c.expectRefusal({ cmd: 'forgeSketch', variantId: next?.id ?? variant!.id, cfgRev: rev });
      check(!k2.ok, `второй эскиз — отказ (${k2.reason})`);
    }

    // ── 6. Обрыв сокета посреди переплавки; повтор ключей ─────────────────
    console.log('\n[6] переплавка в полёте + обрыв сокета; повтор ключей');
    await sleep(2600);
    const m6 = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    c.send({ t: 'cmd', id: c.id(), command: { cmd: 'forgeSalvage', uid: u6, cfgRev: rev } });
    c.ws.terminate();
    await sleep(300);
    closes.push(c.closeCode ?? -1);
    c = new Conn();
    await c.open(token, character.charId);
    const still6 = c.save!.inventory.some((i) => i.uid === u6);
    const m6b = availableMaterials(c.save!.inventory, (await c.refreshStash()).materials);
    const moved6 = Object.keys(cost.materials).some((id) => (m6b[id] ?? 0) !== (m6[id] ?? 0));
    check(still6 !== moved6, `после обрыва: вещь ${still6 ? 'цела' : 'переплавлена'}, сырьё ${moved6 ? 'вернулось' : 'не менялось'}`);
    if (!still6) melted.add(u6);
    const gR = c.save!.gold;
    const rr = await c.cmd({ cmd: 'craft', nonce: pipe[0]!.nonce, input, maxGold: cost.gold, maxMaterials: cost.materials, cfgRev: rev });
    check(rr.ok && rr.uid === nonces.get(pipe[0]!.nonce) && c.save!.gold === gR, `повтор ключа после обрыва — прежний uid (${rr.uid})`);
    // Проданная скованная: повтор её ключа отвечает прежним uid, но вещь не возвращается и ничего не списывается.
    if (still6) {
      const sold = await c.cmd({ cmd: 'sell', uid: u6 });
      check(sold.ok && !c.save!.inventory.some((i) => i.uid === u6), `скованная продана (${sold.reason ?? 'ok'})`);
      const g6 = c.save!.gold, bag6 = c.save!.inventory.length;
      const n6 = [...nonces].find(([, uid]) => uid === u6)![0];
      await sleep(600);
      const r6 = await c.cmd({ cmd: 'craft', nonce: n6, input, maxGold: cost.gold, maxMaterials: cost.materials, cfgRev: rev });
      check(r6.ok && r6.uid === u6 && !c.save!.inventory.some((i) => i.uid === u6) && c.save!.gold === g6 && c.save!.inventory.length === bag6,
        `повтор ключа проданной — прежний uid, вещь не вернулась, золото ${g6} → ${c.save!.gold}`);
    }

    // ── 7. Подземелье ───────────────────────────────────────────────────────
    console.log('\n[7] подземелье: разбор скованной на месте, выброс и подъём');
    c.send({ t: 'descend', difficultyId: 'normal' });
    check(await until(() => c.floor?.area === 'dungeon', 8000), `спуск (${c.floor?.area})`);
    for (let i = 0; i < 10; i++) { c.idle(); await sleep(33); }
    const m7 = availableMaterials(c.save!.inventory, {});
    const it7 = c.save!.inventory.find((i) => i.uid === u5)!;
    const f7 = await c.cmd({ cmd: 'salvage', uid: u5, cfgRev: rev });
    check(f7.ok && !c.save!.inventory.some((i) => i.uid === u5), `разбор скованной на месте (${f7.reason ?? 'ok'})`);
    if (f7.ok) melted.add(u5);
    const m7b = availableMaterials(c.save!.inventory, {});
    const got7 = Object.fromEntries(Object.keys({ ...m7, ...m7b }).map((id): [string, number] => [id, (m7b[id] ?? 0) - (m7[id] ?? 0)]).filter(([, n]) => n !== 0));
    const field = salvageRange(reg, it7, true).range, smith = salvageRange(reg, it7, false).range;
    check(Object.entries(got7).every(([id, n]) => n >= (field[id]?.min ?? Infinity) && n <= (field[id]?.max ?? -1)), `на месте выход ${JSON.stringify(got7)} в вилке поля`);
    check(Object.entries(field).every(([id, r]) => r.max <= (smith[id]?.max ?? 0)), 'вилка поля не щедрее кузницы');
    const un = await c.cmd({ cmd: 'unequip', slot: 'weapon' });
    check(un.ok && c.save!.inventory.some((i) => i.uid === u4), `снята (${un.reason ?? 'ok'})`);
    const dr = await c.cmd({ cmd: 'drop', uid: u4 });
    check(dr.ok && !c.save!.inventory.some((i) => i.uid === u4), `выброшена (${dr.reason ?? 'ok'})`);
    let dropId: number | undefined;
    await until(() => { dropId = c.world?.drops.find((d) => d.kind === 'item' && d.item.uid === u4)?.id; return dropId !== undefined; }, 3000);
    const pk = dropId !== undefined ? await c.cmd({ cmd: 'pickup', dropId }) : undefined;
    await until(() => !!c.save?.inventory.some((i) => i.uid === u4), 2000);
    check(!!pk?.ok && c.save!.inventory.some((i) => i.uid === u4), `поднята обратно (${pk ? pk.reason ?? 'ok' : 'на земле не видна'})`);
    await sleep(1700);   // пауза переходов (VOTE_COOLDOWN_MS, 1,5 с)
    for (let i = 0; i < 5 && c.floor?.area !== 'town'; i++) {
      const e7 = c.errors.length;
      c.send({ t: 'return' });
      if (await until(() => c.floor?.area === 'town', 3000)) break;
      console.log(`    «в город» не прошёл: ${c.errors.slice(e7).join(' | ') || 'без ответа'}`);
      c.errors.splice(e7);
    }
    check(c.floor?.area === 'town', `в город (${c.floor?.area})`);
    await sleep(300);
    check(c.errors.length === 0, `кадров error: ${c.errors.length}${c.errors.length ? ` — ${c.errors.join(' | ')}` : ''}`);
    const finalSave = structuredClone(c.save!);
    const finalStash = structuredClone(await c.refreshStash());
    await c.leave();
    closes.push(c.closeCode ?? -1);

    // ── 8. Сверка с базой ────────────────────────────────────────────────────
    console.log('\n[8] сверка с базой');
    let saved: SaveState | undefined;
    for (let i = 0; i < 60 && !saved; i++) {
      const r = (await db.query<{ data: SaveState }>('SELECT data FROM characters WHERE char_id = $1', [character.charId])).rows[0];
      if (r && r.data.gold === finalSave.gold && forged(r.data).sort().join() === forged(finalSave).sort().join()) saved = r.data;
      else await sleep(250);
    }
    check(!!saved, `сейв в базе: золото ${saved?.gold ?? '—'} = ${finalSave.gold}, скованных ${forged(finalSave).length}`);
    if (saved) check(saved.inventory.map((i) => i.uid).sort().join() === finalSave.inventory.map((i) => i.uid).sort().join(), 'сумка в базе = последний saveUpdate');
    const acc = (await db.query<{ data: { craftNonces?: { n: string; uid: string }[]; materials?: Record<string, number> } }>(
      'SELECT data FROM account_stash WHERE user_id = $1', [userId])).rows[0]?.data;
    check([...nonces].every(([n, uid]) => acc?.craftNonces?.some((e) => e.n === n && e.uid === uid)), `ключи заявок в базе (${nonces.size})`);
    check(JSON.stringify(Object.entries(acc?.materials ?? {}).sort()) === JSON.stringify(Object.entries(finalStash.materials).sort()), 'кошелёк в базе = последний stash');
    for (const uid of new Set(nonces.values())) {
      const ev = (await db.query<{ kind: string; reason: string | null }>('SELECT kind, reason FROM item_events WHERE item_id = $1 ORDER BY seq', [uid]))
        .rows.map((r) => `${r.kind}:${r.reason ?? ''}`);
      const loc = (await db.query<{ loc: string }>('SELECT loc FROM items WHERE id = $1', [uid])).rows[0]?.loc;
      const gone = melted.has(uid) || !forged(finalSave).includes(uid);
      const ok = ev[0] === 'created:craft' && ev.filter((e) => e.startsWith('created:')).length === 1
        && (gone ? ev.at(-1)!.startsWith('gone:') && loc === 'world' : !ev.at(-1)!.startsWith('gone:') && !!loc && loc !== 'world');
      check(ok, `леджер …${uid.slice(-8)}: ${ev.join(' → ')} · ${loc}`);
    }
    // ⭐ E2E 29.09 (шестой прогон): строку телеметрии сессия пишет при снятии, рядом с прощальной записью, — одно чтение сразу за сверкой
    // сейва могло её не застать (в кластере `poc:craft` так и упал: «сковано 0» при верном `/metrics`). Ждём, пока сойдётся и все сессии закрыты.
    type Tel = { crafted: number; melted: number; enchanted: number; sessions: number; open: number };
    let tel: Tel | undefined;
    const telOk = (): boolean => !!tel && tel.open === 0 && tel.crafted === crafted && tel.melted === melted.size && tel.enchanted === enchanted;
    for (const end = Date.now() + 10_000; ; await sleep(200)) {
      const r = (await db.query<Record<keyof Tel, string>>(
        `SELECT sum(crafted) crafted, sum(melted) melted, sum(enchanted) enchanted, count(*) sessions, count(*) FILTER (WHERE ended_at IS NULL) open
         FROM play_sessions WHERE char_id = $1`, [character.charId])).rows[0];
      tel = r && { crafted: Number(r.crafted), melted: Number(r.melted), enchanted: Number(r.enchanted), sessions: Number(r.sessions), open: Number(r.open) };
      if (telOk() || Date.now() > end) break;
    }
    check(telOk(), `телеметрия: сковано ${tel?.crafted} (ждём ${crafted}), переплавлено ${tel?.melted} (${melted.size}), зачаровано ${tel?.enchanted} (${enchanted})`
      + ` — эскиз и повторы не в счёт; сессий ${tel?.sessions}, открытых ${tel?.open}`);
    check(closes.every((x) => x !== 4008 && x !== 4009), `закрытия сокета без 4008/4009: ${closes.join(', ')}`);
  } finally {
    if (!KEEP) {
      await sleep(500);
      await db.query('DELETE FROM items WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM play_sessions WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM char_claims WHERE char_id = $1', [character.charId]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);   // сессии, герой и сундук — каскадом
      console.log(`\nаккаунт ${username} удалён (журнал item_events — только на дозапись, его строки остаются)`);
    }
    await db.end();
  }
}

main().then(() => {
  console.log(fails.length ? `\n✗ Провалов: ${fails.length}\n  - ${fails.join('\n  - ')}` : '\n✓ Края кузницы держатся, база и телеметрия сошлись.');
  process.exit(fails.length ? 1 : 0);
}, (e: unknown) => {
  console.error('\n✗ Стенд упал:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
