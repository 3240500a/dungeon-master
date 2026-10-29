import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, runNodeDepth, runNodeLane, type SaveState, type ServerFrame, type RunConfig } from '@dm/shared';
import { counters } from './metrics.js';

// Замеры — настоящая генерация этажей и заселение; умолчание 5 с тут лотерея.
vi.setConfig({ testTimeout: 180_000 });

/**
 * ⭐⭐ 14.10 (Г4, круг охоты): ВХОД В УЗЕЛ НЕ БЫВАЕТ ТУПИКОМ — имя не из окна плана чинится ПОЛОСОЙ, а не молчанием.
 *
 * ЧТО НАШЛА ОХОТА (замер на живой `Room`, не чтение кода). Указатель забега — `n<глубина>_<полоса>`, и ФОРМУ его Г4
 * уже стережёт (`RoomManager.runUnusable`: не имя, глубина < 1 или глубже потолка доверия — забег снимается). А ПОЛОСА
 * формой годна всегда, и существует она ровно пока слой такой ширины: ширину решает ЖИВОЙ конфиг
 * (`generateRunPlan.layerWidth` — `balance.dungeonAccess.width`; привал и босс форсируют 1, то есть ширину меняют и каденция
 * метки `waypointStep`, и лестница боссов полосы `bossLadder`).
 * Хозяин сужает забег правкой редактора — и у припаркованного героя полосы в слое больше нет:
 *   «Продолжить» → голосование ПРОШЛО (`voteEnd{passed:true}`), а комната осталась в городе (`enterNode` молча
 *   выходил на `if (!node) return`), указатель цел, окно плана `n4_0, n5_0, n6_0` — полосы 1 в нём нет. Второй и
 *   третий заход — то же. Выхода не было: «Завершить» вне подземелья отказывает, оставалось «Забросить» — ШТРАФ
 *   СМЕРТИ за правку конфига (ровно то «правка конфига не отнимает», от чего сторожит R9-05). Побочно `resumeRun`
 *   успевал ВЗЯТЬ забег на комнату (`takeRun`), и строка забега в кластере висела за комнатой, стоящей в городе.
 *
 * ПРАВИЛО (`Room.nodeFor`): ГЛУБИНА — КАК В ИМЕНИ (она заработана: на ней уровень монстров, награда и рекорд),
 * ПОЛОСА — БЛИЖАЙШАЯ СУЩЕСТВУЮЩАЯ; слоя нет вовсе — начало окна. Починка кричит инцидентом и считается тем же
 * счётчиком, что починка входом (`counters.saveRepaired`), и ложится в сейв первой же записью.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 14.10: наложить → прогнать → вернуть, md5
 * сверен до и после):
 *  • возврат молчаливого выхода (`const node = this.runPlan.nodes.find(…); if (!node) return;`) — валит «пати вошла»
 *    и «указатель починен» в обоих случаях (город и подземелье);
 *  • зажим не в тот слой (`near = plan.nodes[plan.nodes.length - 1]` — самый глубокий узел окна) — валит «глубина
 *    та же»: правка конфига ДАРИЛА БЫ `lookahead` этажей;
 *  • «первая полоса слоя» вместо ближайшей — валит «полоса 1 — ближайшая к пятой»;
 *  ⚠ А «зажим в начало окна» (`plan.nodes.find(startId)`) зубом НЕ ЯВЛЯЕТСЯ и отброшен: окно пересобирается от
 *    глубины узла (`windowAt(d)` → `startId = n{d}_0`), то есть на этом пути начало окна — тот же слой, и мутация
 *    отличается от правила только при ширине слоя > 1 (это и мерит замер «ближайшая полоса»);
 *  • починка без инцидента и счётчика — валит «одна строка, счётчик +1»;
 *  • инцидент на ЛЮБОМ входе (не только на починке) — валит «честный спуск не шумит».
 *
 * База замокана: `db.ts` открывает пул к Postgres при импорте.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, SaveState>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async (charId: string) => {
    const d = db.data.get(charId);
    return d ? { userId: USER, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Pt = { x: number; y: number };
type P = { alive: boolean; hp: number; pos: Pt; save: SaveState };
type RoomIn = {
  code: string; area: string; movedAt: number; difficultyId: string;
  runConfig: RunConfig | null; runNodeId: string | null;
  runPlan: { nodes: { id: string; depth: number; lane: number; edges: { to: string }[] }[]; startId: string } | null;
  session: { world: { players: Record<string, P>; monsters: { alive: boolean }[]; spawn: Pt; exits?: Pt[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: unknown, startDepth?: number): void;
  castVote(pid: string, yes: boolean): void;
  returnTown(pid: string): void;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const USER = 'user-g4node';
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
  cfg.loadAll();   // живая правка конфига — только внутри своего замера
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };
let seq = 0;
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
function hero(): SaveState {
  const charId = `char-g4node-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `G4N-${seq}`, charId);
  s.level = 30; s.attributes.vitality = 60;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const room = (): RoomIn => { const r = new RoomCtor(`G4N${++seq}`, cfg, hooks); rooms.push(r); return r; };
const depthNow = (r: RoomIn): number => runNodeDepth(r.runNodeId ?? undefined);
/** Инциденты комнаты — те же строки, которыми кричит сервер (`console.error` с префиксом `[room …]`). */
function watchIncidents(): { lines: string[] } {
  const box = { lines: [] as string[] };
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const s = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (s.includes('ИНЦИДЕНТ')) box.lines.push(s);
  });
  return box;
}
/** Один этаж ногами; `prefer` — предпочесть ребро в полосу с этим номером (если есть). */
function walk(r: RoomIn, by: string, others: string[], prefer?: number): string {
  const w = r.session.world;
  for (const m of w.monsters) m.alive = false;
  const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
  const want = prefer === undefined ? undefined : node.edges.find((e) => e.to.endsWith(`_${prefer}`));
  const to = (want ?? node.edges[0]!).to;
  const idx = node.edges.findIndex((e) => e.to === to);
  for (const p of Object.values(w.players)) p.pos = { ...w.exits![idx]! };
  r.movedAt = 0;
  r.descend(by, undefined, to);
  for (const pid of others) r.castVote(pid, true);
  expect(r.runNodeId, 'пати спустилась на выбранный узел').toBe(to);   // иначе поиск нужного узла ниже крутился бы на месте
  return r.runNodeId!;
}
/**
 * Живая правка конфига: ширина слоёв забега ровно `n` полос (та же ручка, что в редакторе).
 * ⚠ Ф1 (16.10): ручка переехала из шаблона забега в `balance.dungeonAccess.width` — шаблонов больше нет.
 */
function setWidth(n: number): void {
  const base = cfg.get('balance');
  cfg.reload({ balance: { ...base, dungeonAccess: { ...base.dungeonAccess, width: { min: n, max: n } } } });
}
/** Забег сужается до одной полосы — самая частая правка (и та, с которой дыра нашлась). */
const narrowToOneLane = (): void => setWidth(1);
/** Довести солиста до узла с полосой > 0 (живой шаблон даёт слои ширины 1–2). */
function walkToLane1(r: RoomIn, pid: string): string {
  for (let i = 0; i < 24 && !(runNodeLane(r.runNodeId ?? undefined) > 0); i++) walk(r, pid, [], 1);
  expect(runNodeLane(r.runNodeId ?? undefined), 'дошли до узла полосы 1').toBeGreaterThan(0);
  return r.runNodeId!;
}

describe('⭐⭐ Г4 (круг охоты): полоса узла пропала — пати входит на ту же глубину, а не в тупик', () => {
  it('⭐ ПРИПАРКОВАННЫЙ ЗАБЕГ: «Продолжить» после правки конфига входит ближайшей полосой той же глубины', async () => {
    const r = room();
    const h = hero();
    const pid = r.addPlayer(new FakeWs(), USER, h, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    expect(r.area, 'забег начался').toBe('dungeon');
    const parked = walkToLane1(r, pid);
    const depth = depthNow(r);

    // уход в город ПАРКУЕТ забег (В4): указатель остаётся на узле полосы 1
    const w = r.session.world;
    for (const p of Object.values(w.players)) p.pos = { ...w.spawn };
    r.movedAt = 0;
    r.returnTown(pid);
    expect(r.area).toBe('town');
    expect(h.run?.currentNodeId, 'указатель припаркован на полосе 1').toBe(parked);

    narrowToOneLane();   // ⚠ правка хозяина: полосы 1 больше нет ни в одном слое
    const inc = watchIncidents();
    const was = counters.saveRepaired;
    const ws2 = new FakeWs();
    const pid2 = r.addPlayer(ws2, USER, hero(), 1);
    await settle();
    ws2.frames.length = 0;
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    r.castVote(pid2, true);
    await settle(16);

    console.log(`\nГ4 ПОЛОСА ПРОПАЛА (припаркованный забег)\nбыл указатель ${parked} → вошли в ${r.runNodeId} (область ${r.area}, глубина ${depthNow(r)})\nуказатель сейва починен: ${h.run?.currentNodeId}\nинцидент: ${inc.lines.join(' | ') || '(тишина)'}\nсчётчик saveRepaired: ${was} → ${counters.saveRepaired}`);

    expect(r.area, '⭐ голосование прошло — и пати ВОШЛА, а не осталась в городе').toBe('dungeon');
    expect(depthNow(r), '⭐ глубина — ТА ЖЕ: заработанный этаж не отнят').toBe(depth);
    expect(runNodeLane(r.runNodeId ?? undefined), 'полоса — существующая (слой сузился до одной)').toBe(0);
    expect(h.run?.currentNodeId, 'указатель сейва починен тем же узлом').toBe(r.runNodeId);
    expect(inc.lines.length, 'ровно одна строка инцидента').toBe(1);
    expect(inc.lines[0], 'и в ней — что было').toContain(JSON.stringify(parked));
    expect(inc.lines[0], 'и куда вошли').toContain(r.runNodeId!);
    expect(counters.saveRepaired, 'счётчик вырос ровно на одну починку').toBe(was + 1);

    // ВТОРОЙ ЗАХОД: сейв уже починен — шуметь больше нечем
    for (const p of Object.values(r.session.world.players)) p.pos = { ...r.session.world.spawn };
    r.movedAt = 0;
    r.returnTown(pid);
    r.castVote(pid2, true);
    await settle();
    expect(r.area, 'ушли в город').toBe('town');
    inc.lines.length = 0;
    const was2 = counters.saveRepaired;
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    r.castVote(pid2, true);
    await settle(16);
    expect(r.area, 'продолжение работает как обычно').toBe('dungeon');
    expect(inc.lines.length, 'починка уже легла в сейв — второй раз тишина').toBe(0);
    expect(counters.saveRepaired, 'и счётчик стоит').toBe(was2);
  });

  /**
   * ⚠ ЗАМЕР ГРАНИЦЫ ДЫРЫ: спуск ПО РЕБРУ правка конфига не ломает, и это не везение, а устройство окна — слои, уже
   * построенные в `runPlan`, живут в памяти комнаты (`growWindow` их не пересобирает: сид слоя от глубины, Р1).
   * Поэтому цель голосования остаётся в плане, даже если живой конфиг сузил бы её слой, и чинить тут нечего. Дыра
   * живёт РОВНО там, где план пересобирается от ЖИВОГО конфига, — у продолжения припаркованного забега
   * (`resumeRun` → `runPlanOf`). Сторож держит обе половины: там починка, здесь тишина.
   */
  it('СПУСК ПО РЕБРУ: окно в памяти переживает правку — ни тупика, ни починки', async () => {
    const r = room();
    const a = hero(); const b = hero();
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    const pb = r.addPlayer(new FakeWs(), 'user-g4node-2', b, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 1);
    r.castVote(pb, true);
    expect(r.area).toBe('dungeon');
    // ищем развилку, у которой есть ребро в полосу 1
    let target: string | undefined;
    for (let i = 0; i < 24; i++) {
      const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
      const edge = node.edges.find((e) => runNodeLane(e.to) > 0);
      if (edge) { target = edge.to; break; }
      walk(r, pa, [pb]);
    }
    expect(target, 'нашли ребро в полосу 1').toBeTruthy();
    const from = depthNow(r);
    // голосование открыто за узел полосы 1 — и в это окно хозяин сужает забег
    const w = r.session.world;
    for (const m of w.monsters) m.alive = false;
    const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
    const idx = node.edges.findIndex((e) => e.to === target);
    for (const p of Object.values(w.players)) p.pos = { ...w.exits![idx]! };
    r.movedAt = 0;
    r.descend(pa, undefined, target);
    expect(r.area, 'голос напарника ещё не подан — пати на месте').toBe('dungeon');
    narrowToOneLane();
    const inc = watchIncidents();
    const was = counters.saveRepaired;
    r.castVote(pb, true);
    await settle();
    console.log(`\nГ4 СПУСК ПО РЕБРУ ПОСЛЕ ПРАВКИ\nцель ${target} → вошли в ${r.runNodeId} (глубина ${from} → ${depthNow(r)})\nинцидент: ${inc.lines.join(' | ') || '(тишина)'} · счётчик ${was} → ${counters.saveRepaired}`);
    expect(r.runNodeId, '⭐ вошли РОВНО в ту цель, за которую голосовали').toBe(target);
    expect(depthNow(r), 'и это этаж глубже').toBe(from + 1);
    expect(a.run?.currentNodeId, 'указатель ведущего — на том же узле').toBe(r.runNodeId);
    expect(b.run?.currentNodeId, 'и напарника').toBe(r.runNodeId);
    expect(inc.lines.length, 'чинить нечего — окно держит слой, построенный до правки').toBe(0);
    expect(counters.saveRepaired, 'и счётчик стоит').toBe(was);
  });

  it('⭐ ТА ЖЕ ПОЧИНКА ОТ ДРУГОЙ РУЧКИ: каденция метки форсирует ширину 1 — полоса пропадает так же', async () => {
    const r = room();
    const h = hero();
    const pid = r.addPlayer(new FakeWs(), USER, h, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    // нужен узел с ЧЁТНОЙ глубиной и полосой 1: шаг метки 2 форсирует там ширину 1 (привал)
    for (let i = 0; i < 24; i++) {
      // ⚠ 29.10: ровно полоса 1 (ниже её и ждём): граф забега случаен (сид и ключ — на каждый забег), и на широком слое шаг мог встать на 2-ю
      if (runNodeLane(r.runNodeId ?? undefined) === 1 && depthNow(r) % 2 === 0) break;
      walk(r, pid, [], 1);
    }
    const parked = r.runNodeId!;
    const depth = depthNow(r);
    expect(runNodeLane(parked), 'полоса 1').toBe(1);
    expect(depth % 2, 'глубина чётная').toBe(0);
    const w = r.session.world;
    for (const p of Object.values(w.players)) p.pos = { ...w.spawn };
    r.movedAt = 0;
    r.returnTown(pid);
    // ⚠ правка хозяина: метки на ЧЁТНЫХ местах полосы — слой чётной глубины стал привалом (ширина 1)
    const bal = structuredClone(cfg.get('balance')) as { dungeonAccess: { portalsAt: number[] } };
    bal.dungeonAccess.portalsAt = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    cfg.reload({ balance: bal });
    const inc = watchIncidents();
    const was = counters.saveRepaired;
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    await settle(16);
    console.log(`\nГ4 ПОЛОСА ПРОПАЛА (каденция метки 3 → 2)\nбыл ${parked} → вошли в ${r.runNodeId} (область ${r.area}, глубина ${depthNow(r)})\nинцидент: ${inc.lines.join(' | ') || '(тишина)'} · счётчик ${was} → ${counters.saveRepaired}`);
    expect(r.area, 'пати вошла').toBe('dungeon');
    expect(depthNow(r), 'глубина та же').toBe(depth);
    expect(runNodeLane(r.runNodeId ?? undefined), 'полоса — единственная существующая').toBe(0);
    expect(h.run?.currentNodeId, 'указатель починен').toBe(r.runNodeId);
    expect(inc.lines.length, 'одна строка инцидента').toBe(1);
    expect(counters.saveRepaired).toBe(was + 1);
  });

  it('⭐ ПОЛОСА — БЛИЖАЙШАЯ, А НЕ ПЕРВАЯ: слой 6 полос сузили до 2, стоял на 5-й', async () => {
    setWidth(6);   // широкий забег: полосы 0…5
    const r = room();
    const h = hero();
    const pid = r.addPlayer(new FakeWs(), USER, h, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    // к самой дальней полосе: рёбра ведут к БЛИЖАЙШЕЙ полосе следующего слоя, поэтому идём к краю шагами
    for (let i = 0; i < 24 && runNodeLane(r.runNodeId ?? undefined) < 5; i++) {
      const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
      const best = node.edges.map((e) => runNodeLane(e.to)).reduce((m, l) => Math.max(m, l), -1);
      walk(r, pid, [], best);
    }
    const parked = r.runNodeId!;
    const depth = depthNow(r);
    expect(runNodeLane(parked), 'стоим на дальней полосе').toBe(5);
    const w = r.session.world;
    for (const p of Object.values(w.players)) p.pos = { ...w.spawn };
    r.movedAt = 0;
    r.returnTown(pid);
    setWidth(2);   // ⚠ правка хозяина: полос стало две (0 и 1)
    const inc = watchIncidents();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    await settle(16);
    console.log(`\nГ4 БЛИЖАЙШАЯ ПОЛОСА\nбыл ${parked} (полоса 5 из 6) → при двух полосах вошли в ${r.runNodeId}\nинцидент: ${inc.lines.join(' | ') || '(тишина)'}`);
    expect(r.area).toBe('dungeon');
    expect(depthNow(r), 'глубина та же').toBe(depth);
    expect(runNodeLane(r.runNodeId ?? undefined), '⭐ полоса 1 — ближайшая к пятой, а не первая попавшаяся').toBe(1);
    expect(h.run?.currentNodeId, 'указатель починен').toBe(r.runNodeId);
  });

  it('ЧЕСТНЫЙ СПУСК НЕ ШУМИТ: ни строки инцидента, ни единицы счётчика', async () => {
    const r = room();
    const h = hero();
    const pid = r.addPlayer(new FakeWs(), USER, h, 1);
    await settle();
    const inc = watchIncidents();
    const was = counters.saveRepaired;
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    const trail = [r.runNodeId!];
    for (let i = 0; i < 6; i++) trail.push(walk(r, pid, [], i % 2 ? 1 : 0));
    // уход в город и продолжение — указатель годен, полоса на месте
    for (const p of Object.values(r.session.world.players)) p.pos = { ...r.session.world.spawn };
    r.movedAt = 0;
    r.returnTown(pid);
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    await settle(16);
    console.log(`\nГ4 ТИШИНА НА ЧЕСТНОМ ПУТИ\nтропа ${trail.join(' → ')} · продолжение в ${r.runNodeId} (область ${r.area})\nинциденты ${inc.lines.length} · счётчик ${was} → ${counters.saveRepaired}`);
    expect(r.area).toBe('dungeon');
    expect(inc.lines.length, 'ни одной строки').toBe(0);
    expect(counters.saveRepaired, 'счётчик не двинулся').toBe(was);
  });
});
