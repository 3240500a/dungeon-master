import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, isDifficultyUnlocked, type ServerFrame, type SaveState, type RunConfig } from '@dm/shared';
import { limits } from './rateLimit.js';
import { counters } from './metrics.js';

// Тесты ждут комнату оборотами цикла; под нагрузкой полного прогона умолчание 5 с — лотерея. Исходы решают мок базы и шаги комнаты.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ ФАЗЗЕРЫ, ПРОХОД ПРАВОК 2 (сервер), комната. Комната настоящая; база — маленькая честная (версии сейва), умеет лежать (запись падает
 * сразу, как при отказе соединения).
 *  • C-03: смена этажа оживляет и ждущих реконнекта — «мёртв, оплачено» (`paid`, `run.deadAt`) с них снимается, как с присутствующих:
 *    «Завершить» и похороны после этого берут штраф, как с любого живого; смерть в ЧУЖОМ комнате забеге свой забег оплаченным не метит;
 *  • C-04: забег комнаты — только её: комната, взявшая другой забег, отпускает припаркованных чужого; похороны (вайп, грейс) чужой
 *    забег не штрафуют и не снимают;
 *  • C-07: сбой записи сейва — в лог не чаще раза в 10 с, выброс вещи при лежащей базе не ставит запись на каждый выброс;
 *  • C-12: тир нового забега на момент перехода открыт хоть одному из голосовавших — позвавший «сложную» и ушедший её не оставляет.
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, SaveState>(),
  /** База лежит: запись падает сразу (соединение отказано, пул не соединяется). */
  down: false,
  /** Попыток записи сейва. */
  writes: 0,
}));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    db.writes++;
    if (db.down) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
  },
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async (charId: string) => {
    const d = db.data.get(charId);
    return d ? { userId: 'user-f2r', data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Pt = { x: number; y: number };
type P = { alive: boolean; hp: number; pos: Pt; save: SaveState; debuffs: Record<string, unknown> };
type Info = { save: SaveState; paid: boolean; safe?: boolean };
type Farewell = { saved: boolean };
type RoomIn = {
  code: string; area: string; movedAt: number; difficultyId: string;
  runConfig: RunConfig | null; runNodeId: string | null;
  runPlan: { nodes: { id: string; edges: { to: string }[] }[] } | null;
  disconnected: Map<string, Info>;
  session: { world: { players: Record<string, P>; drops: { id: number; item?: { uid: string }; heldBy?: string; pos: Pt }[]; monsters: { alive: boolean }[]; spawn: Pt; exits?: Pt[]; timeMs: number } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<Farewell>;
  abandonAsDead(charId: string, insurance?: boolean): Promise<Farewell>;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  descend(pid: string, difficultyId?: string, targetNodeId?: string): void;
  castVote(pid: string, yes: boolean): void;
  returnTown(pid: string): void;
  persist(pid: string): Promise<string>;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
  db.down = false;
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
  errors(): string[] { return this.frames.filter((f): f is Extract<ServerFrame, { t: 'error' }> => f.t === 'error').map((f) => f.msg); }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };
const USER = 'user-f2r';
let seq = 0;
/** Прощальные записи, начатые комнатой (`onFarewell`), — тест их дожидается. */
const farewells: Promise<Farewell>[] = [];
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {}, onFarewell: (_c: string, w: Promise<Farewell>) => { farewells.push(w); } };
async function landed(): Promise<void> { await Promise.all(farewells.splice(0)); await settle(); }

function hero(patch?: (s: SaveState) => void): SaveState {
  const charId = `char-f2r-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `H${seq}`, charId);
  s.level = 30; s.attributes.vitality = 60; s.gold = 5000;
  patch?.(s);
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const row = (s: SaveState): SaveState => db.data.get(s.charId)!;
function room(): RoomIn {
  const r = new RoomCtor(`F2R${++seq}`, cfg, hooks);
  rooms.push(r);
  return r;
}
/** Пати спустилась: монстры «спят», тик — только шагами теста, все у точки входа. */
async function descendAll(r: RoomIn, by: string, others: string[]): Promise<void> {
  r.movedAt = 0; r.descend(by);
  for (const o of others) r.castVote(o, true);
  expect(r.area, 'пати в подземелье').toBe('dungeon');
  r.stop();
  await settle();
  const w = r.session.world;
  for (const m of w.monsters) m.alive = false;
  for (const p of Object.values(w.players)) p.pos = { ...w.spawn };
}
/** Кооп A + B в подземелье. */
async function coop(): Promise<{ r: RoomIn; pa: string; pb: string; a: SaveState; b: SaveState }> {
  const r = room();
  const a = hero(), b = hero();
  const pa = r.addPlayer(new FakeWs(), USER, a, 1);
  const pb = r.addPlayer(new FakeWs(), USER, b, 1);
  await settle();
  await descendAll(r, pa, [pb]);
  return { r, pa, pb, a, b };
}
/** Герой погиб в бою (смертельный яд — весь путь «событие → штраф → ожидание мёртвым»). */
function kill(r: RoomIn, pid: string): void {
  const p = r.session.world.players[pid]!;
  p.hp = 1;
  p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: r.session.world.timeMs + 60_000, mag: 9999, mag2: 0 };
  for (let t = 0; t < 10 && p.alive; t++) r.step();
  expect(p.alive, 'погиб').toBe(false);
}
/** Уход пати по ребру графа: зовущий — у выхода ребра. */
function nextNode(r: RoomIn, pid: string): string {
  const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
  const to = node.edges[0]!.to;
  r.session.world.players[pid]!.pos = { ...r.session.world.exits![0]! };
  r.movedAt = 0; r.descend(pid, undefined, to);
  expect(r.runNodeId, 'пати спустилась').toBe(to);
  return to;
}
/** Чужой забег: тот же шаблон и биом, другой сид (`sameRun` — нет) и своя личность. */
function foreignRun(of: RunConfig, node: string): NonNullable<SaveState['run']> {
  const config: RunConfig = { ...of, seed: of.seed + 7, id: `foreign-${++seq}` };
  return { templateId: config.templateId, config, currentNodeId: node, visited: [node] };
}

describe('⭐ C-03: смена этажа оживляет и ждущих реконнекта — «мёртв, оплачено» с них снимается', () => {
  it('⭐ погибший вышел, пати ушла в город — «Завершить» из грейса берёт штраф, как с любого живого', async () => {
    const { r, pa, pb, b } = await coop();
    kill(r, pb);
    const afterDeath = r.session.world.players[pb]!.save.gold;
    expect(afterDeath, 'штраф смерти взят').toBeLessThan(5000);
    await r.removePlayer(pb);
    expect(r.disconnected.get(b.charId)).toMatchObject({ paid: true });
    r.movedAt = 0; r.returnTown(pa);
    expect(r.area, 'пати в городе').toBe('town');
    const info = r.disconnected.get(b.charId)!;
    expect(info.safe, 'забег припаркован').toBe(true);
    expect(info.paid, 'город оживил — смерть позади').toBe(false);
    expect(info.save.run?.deadAt, 'и метка смерти снята').toBeUndefined();
    await r.abandonAsDead(b.charId);
    expect(row(b).run, 'забег завершён').toBeUndefined();
    expect(row(b).gold, '«Завершить» ожившего — штраф').toBeLessThan(afterDeath);
  });

  it('⭐ погибший вышел, пати спустилась на новый узел — «Завершить» из грейса берёт штраф', async () => {
    const { r, pa, pb, b } = await coop();
    kill(r, pb);
    const afterDeath = r.session.world.players[pb]!.save.gold;
    await r.removePlayer(pb);
    nextNode(r, pa);
    const info = r.disconnected.get(b.charId)!;
    expect(info.paid, 'новый узел оживил').toBe(false);
    expect(info.save.run?.deadAt, 'метка смерти снята').toBeUndefined();
    await r.abandonAsDead(b.charId);
    expect(row(b).run).toBeUndefined();
    expect(row(b).gold, '«Завершить» ожившего — штраф').toBeLessThan(afterDeath);
  });

  it('контроль: погибший вышел, пати на том же узле — «Завершить» второго штрафа не берёт', async () => {
    const { r, pb, b } = await coop();
    kill(r, pb);
    const afterDeath = r.session.world.players[pb]!.save.gold;
    await r.removePlayer(pb);
    await r.abandonAsDead(b.charId);
    expect(row(b).run).toBeUndefined();
    expect(row(b).gold, 'смерть уже оплачена').toBe(afterDeath);
  });

  it('⭐ смерть в подземелье ЧУЖОГО забега (гость со своим припаркованным) свой забег оплаченным не метит', async () => {
    const r = room();
    const a = hero();
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    await settle();
    await descendAll(r, pa, []);
    const b = hero();
    b.run = foreignRun(r.runConfig!, r.runNodeId!);
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    expect(r.session.world.players[pb]!.save.run?.config.id, 'гость — со своим забегом').toBe(b.run.config.id);
    r.session.world.players[pb]!.pos = { ...r.session.world.spawn };
    kill(r, pb);
    expect(r.session.world.players[pb]!.save.run?.deadAt, 'чужой комнате забег — не «мёртв, оплачено»').toBeUndefined();
  });

  it('⭐ …и «Завершить» своего забега из грейса после такой смерти — штраф: смерть оплатила забег комнаты, а не его', async () => {
    const r = room();
    const a = hero();
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    await settle();
    await descendAll(r, pa, []);
    const b = hero();
    b.run = foreignRun(r.runConfig!, r.runNodeId!);
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    r.session.world.players[pb]!.pos = { ...r.session.world.spawn };
    kill(r, pb);
    const afterDeath = r.session.world.players[pb]!.save.gold;
    expect(afterDeath, 'штраф смерти взят').toBeLessThan(5000);
    await r.removePlayer(pb);
    expect(r.disconnected.get(b.charId)).toMatchObject({ paid: true });
    await r.abandonAsDead(b.charId);
    expect(row(b).run, 'его забег завершён').toBeUndefined();
    expect(row(b).gold, 'брошенный свой забег — штраф').toBeLessThan(afterDeath);
  });

  it('контроль: погибший в СВОЁМ забеге «Завершить» из грейса второго штрафа не платит', async () => {
    const { r, pb, b } = await coop();
    kill(r, pb);
    const afterDeath = r.session.world.players[pb]!.save.gold;
    await r.removePlayer(pb);
    await r.abandonAsDead(b.charId);
    expect(row(b).gold).toBe(afterDeath);
  });
});

describe('⭐ C-04: забег комнаты — только её', () => {
  it('⭐ комната взяла другой забег — припаркованный с прежним отпущен без штрафа, его забег цел', async () => {
    const { r, pa, pb, b } = await coop();
    const x = r.runConfig!;
    await r.removePlayer(pb);   // спокойно, у точки входа
    r.movedAt = 0; r.returnTown(pa);
    expect(r.disconnected.get(b.charId)?.safe, 'пати в городе — забег B припаркован').toBe(true);
    delete r.session.world.players[pa]!.save.run;   // A свой забег завершил
    await descendAll(r, pa, []);
    expect(r.runConfig!.id, 'новый забег').not.toBe(x.id);
    expect(r.disconnected.has(b.charId), 'B отпущен: его забег — не этот').toBe(false);
    await landed();
    expect(row(b).run?.config.id, 'забег B цел').toBe(x.id);
    expect(row(b).gold, 'без штрафа').toBe(5000);
  });

  it('контроль: пати продолжила ТОТ ЖЕ забег — припаркованный с ним ждёт дальше', async () => {
    const { r, pa, pb, b } = await coop();
    const x = r.runConfig!;
    await r.removePlayer(pb);
    r.movedAt = 0; r.returnTown(pa);
    r.movedAt = 0; r.descend(pa);
    await settle(30);
    expect(r.area, 'продолжение').toBe('dungeon');
    expect(r.runConfig!.id).toBe(x.id);
    expect(r.disconnected.has(b.charId), 'участник забега ждёт').toBe(true);
  });

  it('⭐ вайп пати: ждущий реконнекта гость со СВОИМ забегом не хоронится — без штрафа, забег цел', async () => {
    const r = room();
    const a = hero();
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    await settle();
    await descendAll(r, pa, []);
    const b = hero();
    b.run = foreignRun(r.runConfig!, r.runNodeId!);
    const foreign = b.run.config.id;
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    r.session.world.players[pb]!.pos = { ...r.session.world.spawn };
    await r.removePlayer(pb);   // спокойно
    expect(r.disconnected.has(b.charId)).toBe(true);
    kill(r, pa);   // последний живой погиб — вайп
    await landed();
    expect(r.disconnected.has(b.charId), 'отпущен').toBe(false);
    expect(row(b).run?.config.id, 'его забег цел').toBe(foreign);
    expect(row(b).gold, 'без штрафа').toBe(5000);
  });

  it('контроль: вайп хоронит ждущего участника СВОЕГО забега — штраф, забег снят', async () => {
    const { r, pa, pb, b } = await coop();
    await r.removePlayer(pb);
    kill(r, pa);
    await landed();
    expect(row(b).run, 'забег снят').toBeUndefined();
    expect(row(b).gold, 'штраф').toBeLessThan(5000);
  });

  it('⭐ «вход в новую комнату» (страховка) гостя со своим забегом — отпускает, а не штрафует', async () => {
    const r = room();
    const a = hero();
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    await settle();
    await descendAll(r, pa, []);
    const b = hero();
    b.run = foreignRun(r.runConfig!, r.runNodeId!);
    const foreign = b.run.config.id;
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    r.session.world.players[pb]!.pos = { ...r.session.world.spawn };
    await r.removePlayer(pb);
    await r.abandonAsDead(b.charId, true);
    expect(r.disconnected.has(b.charId)).toBe(false);
    expect(row(b).run?.config.id, 'его забег цел').toBe(foreign);
    expect(row(b).gold, 'без штрафа').toBe(5000);
  });
});

describe('⭐ C-12: тир нового забега открыт хоть одному из голосовавших на момент перехода', () => {
  const hardOpen = (s: SaveState): boolean => {
    const ds = cfg.get('difficulties');
    return isDifficultyUnlocked(ds, ds.findIndex((d) => d.id === 'hard'), s.difficultyProgress);
  };

  it('⭐ ветеран позвал «сложную» и ушёл из города — свежий «за» один: голосование отменено, тир не начат', async () => {
    const r = room();
    const vet = hero((s) => { s.difficultyProgress = { easy: 20, normal: 20 }; });
    const fresh = hero((s) => { s.difficultyProgress = {}; });
    expect(hardOpen(vet)).toBe(true);
    expect(hardOpen(fresh)).toBe(false);
    const wsF = new FakeWs();
    const pf = r.addPlayer(wsF, USER, fresh, 1);
    const pv = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.stop();
    r.movedAt = 0;
    r.descend(pv, 'hard');
    expect(wsF.frames.filter((f) => f.t === 'voteStart').at(-1)).toMatchObject({ difficultyId: 'hard' });
    await r.removePlayer(pv);
    r.castVote(pf, true);
    await settle();
    expect(r.area, 'в «сложную» один свежий не ушёл').toBe('town');
    expect(r.session.world.players[pf]!.save.difficultyProgress.hard ?? 0, 'прогресса «сложной» нет').toBe(0);
    expect(wsF.errors().join(' | '), 'ему сказали позвать заново').toMatch(/Пати изменилась/);
  });

  it('контроль: ветеран остался — несёт свежего в «сложную» (R9-08)', async () => {
    const r = room();
    const vet = hero((s) => { s.difficultyProgress = { easy: 20, normal: 20 }; });
    const fresh = hero((s) => { s.difficultyProgress = {}; });
    const pf = r.addPlayer(new FakeWs(), USER, fresh, 1);
    const pv = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.stop();
    r.movedAt = 0;
    r.descend(pv, 'hard');
    r.castVote(pf, true);
    expect(r.area).toBe('dungeon');
    expect(r.runConfig!.tier).toBe('hard');
  });

  it('контроль: позвавший ушёл, но «сложная» открыта другому голосовавшему — переход идёт', async () => {
    const r = room();
    const vet = hero((s) => { s.difficultyProgress = { easy: 20, normal: 20 }; });
    const vet2 = hero((s) => { s.difficultyProgress = { easy: 20, normal: 12 }; });
    const pv2 = r.addPlayer(new FakeWs(), USER, vet2, 1);
    const pv = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.stop();
    r.movedAt = 0;
    r.descend(pv, 'hard');
    await r.removePlayer(pv);
    r.castVote(pv2, true);
    expect(r.area).toBe('dungeon');
    expect(r.runConfig!.tier).toBe('hard');
  });
});

describe('⭐ C-07: лежащая база — лог и записи выброса в меру', () => {
  async function solo(): Promise<{ r: RoomIn; pid: string; save: SaveState; uid: string }> {
    const r = room();
    const save = hero((s) => {
      const w = s.equipment.weapon!;
      delete s.equipment.weapon;
      w.pos = { x: 0, y: 0 };
      s.inventory.push(w);
    });
    const pid = r.addPlayer(new FakeWs(), USER, save, 1);
    await settle();
    r.stop();
    for (const l of [limits.townCmd, limits.cmdResync]) l.reset(USER);
    return { r, pid, save: r.session.world.players[pid]!.save, uid: save.inventory.at(-1)!.uid };
  }

  it('⭐ 50 «выбросил — поднял» при лежащей базе: строка сбоя записи в логе — одна, записей — не на каждый выброс', async () => {
    const { r, pid, uid } = await solo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const e0 = counters.saveErrors;
    db.down = true;
    const w0 = db.writes;
    let id = 1;
    for (let k = 0; k < 50; k++) {
      await r.handleCmd(pid, { cmd: 'drop', uid }, id++);
      await settle(2);
      const d = r.session.world.drops.find((x) => x.item?.uid === uid);
      expect(d, 'вещь на земле').toBeDefined();
      await r.handleCmd(pid, { cmd: 'pickup', dropId: d!.id }, id++);
      await settle(2);
    }
    await settle();
    const lines = err.mock.calls.filter((c) => String(c[0]).includes('запись сейва')).length;
    expect(lines, 'сбой записи в логе — не на каждый').toBeLessThanOrEqual(1);
    expect(counters.saveErrors - e0, 'каждый сбой — в счётчике').toBe(db.writes - w0);
    expect(db.writes - w0, 'выброс при лежащей базе запись не множит').toBeLessThanOrEqual(3);
  });

  it('контроль: база ожила — выброшенное снимается с удержания ближайшей записью; следующий выброс пишется сразу', async () => {
    const { r, pid, uid, save } = await solo();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.down = true;
    await r.handleCmd(pid, { cmd: 'drop', uid }, 1);
    await settle();
    const d = r.session.world.drops.find((x) => x.item?.uid === uid)!;
    expect(d.heldBy, 'удержана выбросившим').toBe(save.charId);
    db.down = false;
    expect(await r.persist(pid), 'автосейв лёг').toBe('ok');
    expect(d.heldBy, 'удержание снято').toBeUndefined();
    // Запись легла — пауза после сбоя кончилась: следующий выброс пишется сразу.
    await r.handleCmd(pid, { cmd: 'pickup', dropId: d.id }, 2);
    const w0 = db.writes;
    await r.handleCmd(pid, { cmd: 'drop', uid }, 3);
    await settle();
    expect(db.writes - w0, 'выброс записан сразу').toBe(1);
    expect(r.session.world.drops.find((x) => x.item?.uid === uid)?.heldBy, 'и удержание снято').toBeUndefined();
  });

  it('⭐ копии ждущих реконнекта при лежащей базе — сбой их записи в логе тоже в меру', async () => {
    const r = room();
    const hs = [hero(), hero(), hero(), hero()];
    const pids = hs.map((h) => r.addPlayer(new FakeWs(), USER, h, 1));
    await settle();
    await descendAll(r, pids[0]!, pids.slice(1));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.down = true;
    for (const pid of pids.slice(1)) await r.removePlayer(pid);
    for (const h of hs.slice(1)) await r.abandonAsDead(h.charId);
    await settle();
    const lines = err.mock.calls.filter((c) => /запись сейва/.test(String(c[0]))).length;
    expect(lines, 'не на каждую копию').toBeLessThanOrEqual(1);
  });
});
