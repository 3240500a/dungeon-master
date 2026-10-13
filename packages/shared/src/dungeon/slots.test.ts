import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConfigRegistry } from '../config/registry.js';
import { biomeDressingSchema, type ArtDecor, type Biome, type Floor } from '../config/schemas.js';
import { Cell, TILE, makeGrid, worldToCell, type Grid } from '../world/grid.js';
import { PLAYER_RADIUS, type Obstacle } from '../world/state.js';
import { buildNavMask, NAV_CELL, NAV_DOWN, NAV_RIGHT, segmentHits } from '../world/pathfind.js';
import { validate, type DecorObject, type DungeonLayout, type Room } from './floorCommon.js';
import { FOOTPRINT_SNAP, footprintRect, obstaclesFromDecor, type DecorSpec } from './decor.js';
import { isFarFace, toCameraXY } from './dressing.js';
import { generateFloorFor, type FloorConfig } from './floorInputs.js';
import { resolveFloorSpec } from './floorSpec.js';
import { generateFloorParams } from './generateFloor.js';
import { archOf, Passability, placeSlots, roomDoorways, slotSeed, SLOT_STREAMS, type Doorway, type PropRules } from './slots.js';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора): СТОРОЖА РАССТАНОВКИ ПРОПОВ ПО СЛОТАМ (`slots.ts`, правило биома `dressing.props`):
 *  • биом без правил пропов — этаж Ф1 байт-в-байт (снимок кода Ф1 на замороженных входах с паспортами, `__golden__/floors_pre_slots.json`);
 *  • проёмы комнат — сущность (`roomDoorways`: клетки, устье, ширина, сторона, дверь, рама);
 *  • на живых этажах крипты с семенем Ф2 (сотни сидов): полосы без преград и пропов «не запирать проход», якоря свободны, связность
 *    с декором радиусом героя (независимый оракул — `buildNavMask` с запасом `PLAYER_RADIUS`, двери открыты и закрыты), детерминизм,
 *    высокие только у дальних стен, арки только в проёмах своей ширины (дальних, с рамой), стулья/табуреты/книги не ставятся (наборы Ф4),
 *    бюджет и доля пустых, «одинаковое не рядом», решётка вернула слоты россыпи;
 *  • Р6: преграда, отрезающая проход, откатывается (`Passability`), с зубами на ручной раскладке; ⭐ 13.10 (ревью): преграда на спавне — отказ,
 *    отказ закрытой проверки не портит кэш открытой, фаззер против оракула (решения и маска);
 *  • ⭐ 13.10 (ревью): у стены спинка МОДЕЛИ на линии стены (пивот — полглубины коллайдера при повороте; живые этажи — по габариту манифеста),
 *    след записи — клетки слота (`FOOTPRINT_SNAP`);
 *  • потоки rng по комнатам: правка правила одного прохода не трогает другие проходы; правила — игровая ревизия;
 *  • ⭐ 13.10 (отзыв владельца по скринам Ф2): обе арки крипты — только в проём 3 (на 4 — никогда), обе встают; след записи арки — проём
 *    (`archOf`), паспорт большой — колонны косяков снимает Unity (`doorway.jambs`); выбор — по весу паспорта.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')!;
const toCam = toCameraXY(reg.get('balance').camera.azimuthDeg);
const asCfg = (t: Record<string, unknown>): FloorConfig => ({ get: (k: string) => t[k] }) as unknown as FloorConfig;
const digestOf = (L: DungeonLayout, obstacles: unknown): string => createHash('sha256').update(JSON.stringify({ L, obstacles })).digest('hex').slice(0, 20);
const GOLDEN = new URL('./__golden__/floors_pre_slots.json', import.meta.url);

/** Этажи пути сервера (`generateFloorFor`) по замороженным входам: каждый биом × каждый его этаж × сиды — как в снимке. */
function serverFloors(cfg: FloorConfig, seeds: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of cfg.get('biomes')) for (const f of cfg.get('floors').filter((x) => x.biomeId === b.id)) for (let seed = 1; seed <= seeds; seed++) {
    const spec = resolveFloorSpec(b, f, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) });
    const { layout, obstacles } = generateFloorFor(cfg, spec, b);
    out.set(`${b.id}/${f.id}/${seed}`, digestOf(layout, obstacles));
  }
  return out;
}

/** Биомы без правил пропов (путь Ф1). */
const stripRules = (biomes: readonly Biome[]): Biome[] => biomes.map((b) => (b.dressing?.props ? { ...b, dressing: (({ props: _p, ...d }) => d)(b.dressing) } : b));

describe('⭐ 12.10 (Ф2): биом без правил пропов — этаж Ф1 байт-в-байт', () => {
  it('снимок кода Ф1 (08f73d0, паспорта россыпью): путь сервера на замороженных входах — те же этажи (все биомы × все этажи × 6 сидов)', () => {
    if (process.env.DM_SLOTS_GOLDEN === 'write') {   // намеренная правка генерации пути Ф1 — пересобрать снимок (живой конфиг без правил пропов)
      const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { note: string; seeds: number };
      const inputs = {
        biomes: stripRules(reg.get('biomes')), floors: reg.get('floors'), objects: reg.get('objects'),
        models: reg.get('models').map((m) => (m.collider ? { id: m.id, collider: m.collider } : { id: m.id })),
        art: reg.get('art').map((a) => ({ id: a.id, kind: a.kind, group: a.group, ...(a.collider ? { collider: a.collider } : {}), ...(a.decor ? { decor: (({ variance: _v, ...d }) => d)(a.decor) } : {}) })),
        'room-prefabs': reg.get('room-prefabs'), chests: reg.get('chests'),
        balance: { camera: { azimuthDeg: reg.get('balance').camera.azimuthDeg }, loot: { chestsPerFloor: reg.get('balance').loot.chestsPerFloor } },
      };
      writeFileSync(GOLDEN, JSON.stringify({ note: g.note, seeds: g.seeds, digests: Object.fromEntries(serverFloors(asCfg(inputs), g.seeds)), inputs }) + '\n');
    }
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { seeds: number; digests: Record<string, string>; inputs: Record<string, unknown> };
    expect((g.inputs.biomes as Biome[]).some((b) => b.dressing?.props), 'входы снимка — без правил пропов').toBe(false);
    expect((g.inputs.art as { decor?: unknown }[]).filter((a) => a.decor).length, 'входы снимка — с паспортами').toBeGreaterThan(5);
    const got = serverFloors(asCfg(g.inputs), g.seeds);
    expect(got.size).toBe(Object.keys(g.digests).length);
    expect(got.size).toBeGreaterThan(100);
    expect([...got].filter(([k, v]) => g.digests[k] !== v).map(([k]) => k), 'этажи, ставшие другими').toEqual([]);
  });

  it('у биома без правил нет полей Ф2 в раскладке (проёмы, полосы, журнал); с правилами — есть', () => {
    const bare = new ConfigRegistry(); bare.loadAll(); bare.reload({ biomes: stripRules(bare.get('biomes')) });
    for (const cfg of [bare, reg]) for (const b of cfg.get('biomes')) {
      const f = cfg.get('floors').find((x) => x.biomeId === b.id && x.role !== 'rest')!;
      const L = generateFloorFor(cfg, resolveFloorSpec(b, f, f.minDepth, 77, [], { exitCount: 1 }), b).layout;
      const want = !!b.dressing?.props;
      expect('doorways' in L, `${b.id}`).toBe(want); expect('lanes' in L).toBe(want); expect('slotLog' in L).toBe(want);
    }
    expect(crypt.dressing?.props, 'у крипты в data правила есть').toBeDefined();
  });
});

// ── проёмы ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Сетка из строк: '#' стена, '.' пол, 'D' дверь. */
const parse = (rows: string[]): Grid => rows.map((r) => [...r].map((ch) => (ch === '#' ? Cell.Wall : ch === 'D' ? Cell.Door : Cell.Floor)));
function synth(rows: string[], rooms: Room[], spawn?: { cx: number; cy: number }): DungeonLayout {
  const grid = parse(rows);
  const s = spawn ?? { cx: rooms[0]!.x + 1, cy: rooms[0]!.y + 1 };
  const c = { x: s.cx * TILE + 16, y: s.cy * TILE + 16 };
  return { grid, rooms, spawn: c, stairsDown: c, exits: [c], decor: [], doors: [], levers: [], chests: [] };
}

describe('⭐ 12.10 (Ф2): проёмы комнат — сущность (`roomDoorways`)', () => {
  // комната 8 × 6 в (4, 4): сверху проём 4 (рама), справа 3, снизу дверь 2, слева — коридор вдоль всей стороны (без рамы)
  const L = synth([...Array(13)].map(() => '#'.repeat(20)), [{ x: 4, y: 4, w: 8, h: 6, type: 'large' }]);
  const set = (x: number, y: number, c: Cell): void => { L.grid[y]![x] = c; };
  for (let y = 4; y < 10; y++) for (let x = 4; x < 12; x++) set(x, y, Cell.Floor);
  for (let y = 1; y < 4; y++) for (let x = 6; x < 10; x++) set(x, y, Cell.Floor);      // верх: проём (6…9, 3) и коридор
  for (let y = 5; y < 8; y++) for (let x = 12; x < 15; x++) set(x, y, Cell.Floor);     // право: проём (12, 5…7)
  set(6, 10, Cell.Door); set(7, 10, Cell.Door);                                         // низ: дверь рычага
  for (let y = 3; y < 12; y++) set(3, y, Cell.Floor);                                   // лево: коридор вдоль стороны

  it('клетки, устье, ширина, сторона, дверь, рама — по порядку сторон верх/низ/лево/право', () => {
    const d = roomDoorways(L);
    expect(d.map((x) => ({ w: x.width, dir: x.dir, door: x.door, framed: x.framed }))).toEqual([
      { w: 4, dir: { dx: 0, dy: -1 }, door: false, framed: true },
      { w: 2, dir: { dx: 0, dy: 1 }, door: true, framed: true },
      { w: 6, dir: { dx: -1, dy: 0 }, door: false, framed: false },
      { w: 3, dir: { dx: 1, dy: 0 }, door: false, framed: true },
    ]);
    expect(d[0]!.cells).toEqual([6, 7, 8, 9].map((x) => ({ cx: x, cy: 3 })));
    expect(d[0]!.inner).toEqual([6, 7, 8, 9].map((x) => ({ cx: x, cy: 4 })));
    expect(d[3]!.cells).toEqual([5, 6, 7].map((y) => ({ cx: 12, cy: y })));
    expect(d.every((x) => x.room === 0 && x.width === x.cells.length && x.inner.length === x.width)).toBe(true);
  });

  it('живые этажи крипты: клетка проёма — вне прямоугольника комнаты и проходима, устье — внутри; у связного этажа у каждой комнаты есть проём', () => {
    let n = 0;
    for (const f of reg.get('floors').filter((x) => x.biomeId === 'crypt')) for (let seed = 1; seed <= 6; seed++) {
      const L2 = generateFloorFor(reg, resolveFloorSpec(crypt, f as Floor, f.minDepth, seed * 31 + 5, [], { exitCount: 1 }), crypt).layout;
      const doors = L2.doorways ?? roomDoorways(L2);
      for (const d of doors) {
        n++;
        const r = L2.rooms[d.room]!;
        const inside = (c: { cx: number; cy: number }): boolean => c.cx >= r.x && c.cx < r.x + r.w && c.cy >= r.y && c.cy < r.y + r.h;
        for (const c of d.cells) { expect(inside(c)).toBe(false); expect([Cell.Floor, Cell.Door]).toContain(L2.grid[c.cy]![c.cx]); }
        for (const c of d.inner) expect(inside(c)).toBe(true);
      }
      if (L2.rooms.length > 1) for (let i = 0; i < L2.rooms.length; i++) expect(doors.some((d) => d.room === i), `${f.id}/${seed}: комната ${i} без проёма`).toBe(true);
    }
    expect(n).toBeGreaterThan(100);
  });
});

// ── правила в данных ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('⭐ 12.10 (Ф2): правила пропов — в data, схема, игровая ревизия', () => {
  it('крипта: 3–6 на 100 клеток, 25 % пустых, у стены шаг 3, угол 0.5, арки, полосы 2, одинаковое не ближе 4 — все поля в data/biomes.json', () => {
    const raw = (JSON.parse(readFileSync(new URL('../config/data/biomes.json', import.meta.url), 'utf8')) as { id: string; dressing?: { props?: unknown } }[]).find((b) => b.id === 'crypt')!.dressing!.props;
    expect(raw, 'числа — в файле данных, не в .default() схемы').toEqual(crypt.dressing!.props);
    expect(crypt.dressing!.props).toMatchObject({
      density: { min: 3, max: 6, perArea: 100 }, emptyRoomShare: 0.25, sameNotNear: 4, lanes: { width: 2 },
      againstWall: { on: true, step: 3 }, corner: { on: true, chance: 0.5 }, doorway: { on: true },
      // ⭐ 13.10 (ревью): грани стены выключены, пока нет настенного паспорта (лишь wall / wallInsert) — иначе вечное предупреждение редактора;
      // коридоры — на потом
      wall: { on: false, corridors: true },
    });
  });

  it('схема: max меньше min — отказ; пустые правила — умолчания (страховка миграции)', () => {
    expect(biomeDressingSchema.safeParse({ props: { density: { min: 5, max: 2 } } }).success).toBe(false);
    const p = biomeDressingSchema.parse({ props: {} }).props!;
    expect(p.density).toEqual({ min: 3, max: 6, perArea: 100 });
    expect(p.lanes.width).toBe(2);
  });

  it('правка правил пропов сдвигает игровую ревизию (меняет этажи)', () => {
    const a = new ConfigRegistry(); a.loadAll();
    const b = new ConfigRegistry(); b.loadAll();
    b.reload({ biomes: b.get('biomes').map((x) => (x.dressing?.props ? { ...x, dressing: { ...x.dressing, props: { ...x.dressing.props, sameNotNear: 5 } } } : x)) });
    expect(b.gameRevision()).not.toBe(a.gameRevision());
  });
});

// ── живые этажи крипты с семенем Ф2 ──────────────────────────────────────────────────────────────────────────────────────
/** Семя паспортов Ф2 — как `Assets/DM/Art/Editor/decor_seed.json` Unity после правки 12.10 (отзыв владельца): стулья и табуреты — только сокет
 *  стола (ждут наборов Ф4), стол 3x — у стены и центр большой комнаты, стол 2x — у стены, камни и ящики — угол/у стены, полка — у дальней стены,
 *  арки — в проём своей ширины, книги — сокет полки. ⭐ 13.10 (отзыв владельца по скринам Ф2): обе арки — проём 3, большая (arch_04) стоит на
 *  косяках вместо колонн (`jambs: 'replace'`), при малой (arch_01) колонны косяков стоят (keep — без поля, как пишет `DecorPassport.ToJson`). */
const SEED_F2: Record<string, Partial<ArtDecor>> = {
  crypt_wooden_shelf_01: { contexts: ['againstWall'], anchor: 'back', backOffset: 0.25, facing: 'room', keepPath: true, blocks: true, blocksSight: true, tall: true, tags: ['furniture', 'storage'], rooms: { small: 1, large: 1, treasure: 1, boss: 0, corridor: 0 } },
  crypt_wooden_table_3x_01: { contexts: ['againstWall', 'floor'], facing: 'quad', clearance: 1, keepPath: true, blocks: true, tags: ['furniture', 'table'], rooms: { small: 0, large: 1, treasure: 0.5, boss: 0, corridor: 0 } },
  crypt_wooden_table_2x_01: { contexts: ['againstWall'], facing: 'along', clearance: 1, keepPath: true, blocks: true, tags: ['furniture', 'table'], rooms: { small: 1, large: 1, treasure: 0.5, boss: 0, corridor: 0 } },
  crypt_wooden_chair_01: { contexts: ['socket'], hosts: ['crypt_wooden_table_3x_01', 'crypt_wooden_table_2x_01'], blocks: true, weight: 0.3, tags: ['furniture', 'seat'], rooms: { small: 1, large: 1, treasure: 0, boss: 0, corridor: 0 } },
  crypt_wooden_stool_01: { contexts: ['socket'], hosts: ['crypt_wooden_table_3x_01', 'crypt_wooden_table_2x_01'], facing: 'free', blocks: true, weight: 0.3, tags: ['furniture', 'seat'], rooms: { small: 1, large: 1, treasure: 0, boss: 0, corridor: 0 } },
  crypt_wooden_crate_01: { contexts: ['corner', 'againstWall'], keepPath: true, blocks: true, stack: { max: 3 }, tags: ['storage', 'crate'], rooms: { small: 1, large: 1, treasure: 1.5, boss: 0, corridor: 0 } },
  crypt_wooden_crate_02: { contexts: ['corner', 'againstWall'], keepPath: true, blocks: true, stack: { max: 3 }, tags: ['storage', 'crate'], rooms: { small: 1, large: 1, treasure: 1.5, boss: 0, corridor: 0 } },
  crypt_stone_01: { contexts: ['corner', 'againstWall'], keepPath: true, blocks: true, weight: 0.6, tags: ['rubble'], rooms: { small: 1, large: 1, treasure: 0.5, boss: 1, corridor: 0 } },
  crypt_arch_01: { contexts: ['doorway'], facing: 'room', doorway: { width: 3 }, tall: true, tags: ['arch', 'frame'] },
  crypt_arch_04: { contexts: ['doorway'], facing: 'room', doorway: { width: 3, jambs: 'replace' }, tall: true, tags: ['arch', 'frame'] },
  crypt_books_01: { contexts: ['socket'], anchor: 'back', backOffset: 0.25, facing: 'room', hosts: ['crypt_wooden_shelf_01'], tall: true, tags: ['clutter', 'books'] },
};
/** Живой конфиг с паспортами семени Ф2 (через загрузчик); `rules` — правка правил пропов крипты. */
function withSeedF2(rules?: (p: PropRules) => PropRules): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  const art = structuredClone(r.get('art')).map((a) => {
    const s = SEED_F2[a.id];
    if (!s || a.kind === 'material' || !a.bounds) return a;
    const fp = { w: Math.max(1, Math.ceil(a.bounds.max[0]! - a.bounds.min[0]! - 0.1 - 1e-4)), h: Math.max(1, Math.ceil(a.bounds.max[2]! - a.bounds.min[2]! - 0.1 - 1e-4)) };
    return { ...a, decor: { ...s, footprint: fp } };
  });
  r.reload({ art });
  if (rules) r.reload({ biomes: r.get('biomes').map((b) => (b.dressing?.props ? { ...b, dressing: { ...b.dressing, props: rules(b.dressing.props) } } : b)) });
  return r;
}
type Run = { L: DungeonLayout; specs: DecorSpec[]; obstacles: Obstacle[]; id: string };
function cryptRuns(cfg: ConfigRegistry, seeds: number): Run[] {
  const b = cfg.get('biomes').find((x) => x.id === 'crypt')!;
  const out: Run[] = [];
  for (const f of cfg.get('floors').filter((x) => x.biomeId === 'crypt' && x.role !== 'rest')) for (let seed = 1; seed <= seeds; seed++) {
    const g = generateFloorFor(cfg, resolveFloorSpec(b, f as Floor, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) }), b);
    out.push({ L: g.layout, specs: g.inputs.decorSpecs, obstacles: g.obstacles, id: `${f.id}/${seed}` });
  }
  return out;
}

/** Достижимое от спавна по маске преград радиусом героя (оракул — `buildNavMask` с запасом `PLAYER_RADIUS`, не `Passability`). */
function reachHero(L: DungeonLayout, obstacles: readonly Obstacle[], open: boolean): { seen: Uint8Array; walk: (i: number) => boolean } {
  const rows = L.grid.length, cols = L.grid[0]!.length;
  const bits = buildNavMask(cols, rows, obstacles, PLAYER_RADIUS)?.bits ?? new Uint8Array(cols * rows);
  const walk = (i: number): boolean => { const c = L.grid[(i / cols) | 0]![i % cols]; return (c === Cell.Floor || (open && c === Cell.Door)) && !(bits[i]! & NAV_CELL); };
  const seen = new Uint8Array(cols * rows);
  const s = worldToCell(L.spawn.x, L.spawn.y), start = s.cy * cols + s.cx;
  if (!walk(start)) return { seen, walk };
  const q = [start]; seen[start] = 1;
  while (q.length) {
    const i = q.pop()!, x = i % cols, y = (i / cols) | 0;
    const go = (j: number, edge: boolean): void => { if (edge && !seen[j] && walk(j)) { seen[j] = 1; q.push(j); } };
    if (x + 1 < cols) go(i + 1, !(bits[i]! & NAV_RIGHT));
    if (x > 0) go(i - 1, !(bits[i - 1]! & NAV_RIGHT));
    if (y + 1 < rows) go(i + cols, !(bits[i]! & NAV_DOWN));
    if (y > 0) go(i - cols, !(bits[i - cols]! & NAV_DOWN));
  }
  return { seen, walk };
}
/** Клетки, которые пропы слотов отрезали: достижимы без них (тот же этаж, прочий декор), проходимы с ними — и недостижимы (двери открыты/закрыты). */
function cutBySlots(L: DungeonLayout, specs: DecorSpec[], slotIds: ReadonlySet<string>): string[] {
  const by = new Map(specs.map((s) => [s.id, s]));
  const all = obstaclesFromDecor(L.decor, by), base = obstaclesFromDecor(L.decor.filter((d) => !slotIds.has(d.objectId ?? '')), by);
  const out: string[] = [];
  const cols = L.grid[0]!.length;
  for (const open of [true, false]) {
    const a = reachHero(L, all, open), b = reachHero(L, base, open);
    for (let i = 0; i < a.seen.length; i++) if (b.seen[i] && a.walk(i) && !a.seen[i]) out.push(`${open ? 'open' : 'closed'}:${i % cols},${(i / cols) | 0}`);
  }
  return out;
}

describe('⭐ 12.10 (Ф2): живые этажи крипты — слоты и полосы (семя Ф2)', () => {
  const cfg = withSeedF2();
  const runs = cryptRuns(cfg, 40);
  const passports = new Map(runs[0]!.specs.filter((s) => s.passport).map((s) => [s.id, s]));
  const slotIds = new Set(passports.keys());
  const slotDecor = (L: DungeonLayout): DecorObject[] => L.decor.filter((d) => d.kind === 'obj' && slotIds.has(d.objectId ?? ''));
  /** ⭐ 12.10 (ревью): доля цели бюджета, которую слоты выбирают (с возвратом недобора углов; без него было 80 %). */
  const FILL_MIN = 0.85;

  it('этажей — сотни; детерминизм: тот же сид — та же раскладка целиком (пропы, проёмы, полосы, журнал)', () => {
    expect(runs.length).toBeGreaterThanOrEqual(200);
    const again = cryptRuns(withSeedF2(), 3).map((r) => JSON.stringify(r.L));
    expect(again).toEqual(runs.filter((r) => /\/(1|2|3)$/.test(r.id)).map((r) => JSON.stringify(r.L)));
  });

  it('полосы: ни след преграды, ни проп «не запирать проход», ни коллайдер пропа не лежит на клетке полосы; устья проёмов — в полосах', () => {
    let lanes = 0;
    for (const { L, obstacles } of runs) {
      const cols = L.grid[0]!.length;
      const lane = new Set((L.lanes ?? []).flatMap((x) => x.cells));
      lanes += lane.size;
      // ⭐ 12.10 (ревью): на клетке полосы можно стоять — центр не под коллайдером ЛЮБОГО декора радиусом героя (ниши статуй сужали полосу 2 до 1;
      // замер ревью — 499 клеток на 300 этажей). Устье проёма — полоса всегда (ряд проёма держится свободным), его мимо
      const mouth = new Set((L.doorways ?? []).flatMap((d) => d.inner.map((c) => c.cy * cols + c.cx)));
      for (const i of lane) {
        if (mouth.has(i)) continue;
        const x = (i % cols) * TILE + 16, y = ((i / cols) | 0) * TILE + 16;
        expect(obstacles.some((o) => segmentHits(o, x, y, x, y, PLAYER_RADIUS)), `полоса под коллайдером ${i % cols},${(i / cols) | 0}`).toBe(false);
      }
      for (const d of L.doorways ?? []) for (const c of d.inner) expect(lane.has(c.cy * cols + c.cx), 'устье проёма — полоса').toBe(true);
      for (const d of slotDecor(L)) {
        const s = passports.get(d.objectId!)!;
        if (!s.blocks && !s.passport?.keepPath) continue;
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (L.grid[y]![x] === Cell.Floor) expect(lane.has(y * cols + x), `${d.objectId} на полосе ${x},${y}`).toBe(false);
        for (const o of obstaclesFromDecor([d], passports as Map<string, DecorSpec>)) {
          const c = worldToCell(o.x, o.y);
          for (let y = c.cy - 3; y <= c.cy + 3; y++) for (let x = c.cx - 3; x <= c.cx + 3; x++) {
            if (!lane.has(y * cols + x)) continue;
            expect(segmentHits(o, x * TILE + 16, y * TILE + 16, x * TILE + 16, y * TILE + 16), `коллайдер ${d.objectId} на центре клетки полосы ${x},${y}`).toBe(false);
          }
        }
      }
    }
    expect(lanes).toBeGreaterThan(1000);
  });

  it('якоря свободны: спавн, выходы, рычаги, двери, сундуки — не на следе пропа и достижимы радиусом героя; validate()', () => {
    for (const { L, obstacles } of runs) {
      expect(validate(L)).toBe(true);
      const cols = L.grid[0]!.length;
      const open = reachHero(L, obstacles, true), closed = reachHero(L, obstacles, false);
      const feet = new Set<number>();
      for (const d of slotDecor(L)) { const r = footprintRect(d); for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) feet.add(y * cols + x); }
      for (const p of [L.spawn, ...L.exits, ...L.chests]) { const c = worldToCell(p.x, p.y), i = c.cy * cols + c.cx; expect(feet.has(i)).toBe(false); expect(open.seen[i], `точка ${c.cx},${c.cy}`).toBe(1); }
      for (const lv of L.levers) { const c = worldToCell(lv.x, lv.y), i = c.cy * cols + c.cx; expect(feet.has(i)).toBe(false); expect(closed.seen[i], 'рычаг — при закрытых дверях').toBe(1); }
      for (const d of L.doors) for (const c of d.cells) expect(feet.has(c.cy * cols + c.cx)).toBe(false);
    }
  });

  it('Р6: пропы слотов не отрезают ни клетки (радиус героя, двери открыты и закрыты) — откаты проверки случаются и считаются', () => {
    let rejected = 0;
    for (const { L, specs, id } of runs) {
      expect(cutBySlots(L, specs, slotIds), id).toEqual([]);
      rejected += Object.values(L.slotLog!.passes).reduce((s, p) => s + p.rejected, 0);
    }
    expect(rejected, 'проверка срабатывала (иначе сторож без зубов)').toBeGreaterThan(20);
  });

  it('высокие — только у дальних стен (полка спиной к дальней стене, в 0.25 м от линии); арки — в проёме своей ширины, дальнем, с рамой, не дверь', () => {
    let shelves = 0, arches = 0;
    for (const { L } of runs) {
      for (const d of slotDecor(L)) {
        const s = passports.get(d.objectId!)!;
        const n = { x: Math.round(Math.sin(d.rot ?? 0)), y: Math.round(Math.cos(d.rot ?? 0)) };
        if (d.objectId === 'crypt_wooden_shelf_01') {
          shelves++;
          expect(isFarFace(n.x, n.y, toCam), 'полка у ближней стены').toBe(true);
          const w = worldToCell(d.x - n.x * (0.25 + 0.5) * TILE, d.y - n.y * (0.25 + 0.5) * TILE);
          expect(L.grid[w.cy]![w.cx], 'за полкой — стена').toBe(Cell.Wall);
          // пивот — в 0.25 клетки от линии стены
          const line = n.x !== 0 ? (n.x > 0 ? (w.cx + 1) * TILE : w.cx * TILE) : (n.y > 0 ? (w.cy + 1) * TILE : w.cy * TILE);
          expect(Math.abs((n.x !== 0 ? d.x : d.y) - line)).toBeCloseTo(0.25 * TILE, 6);
        }
        if (s.passport?.doorway) {
          arches++;
          const door = (L.doorways ?? []).find((q) => {
            const xs = [...q.cells, ...q.inner];
            const mx = xs.reduce((a, c) => a + c.cx * TILE + 16, 0) / xs.length, my = xs.reduce((a, c) => a + c.cy * TILE + 16, 0) / xs.length;
            return Math.abs(mx - d.x) < 1e-6 && Math.abs(my - d.y) < 1e-6;
          });
          expect(door, `арка ${d.objectId} не в проёме`).toBeDefined();
          expect(door!.width).toBe(s.passport.doorway.width);
          expect(door!.framed && !door!.door).toBe(true);
          expect(isFarFace(-door!.dir.dx, -door!.dir.dy, toCam), 'арка в ближнем проёме').toBe(true);
          expect(Math.abs(Math.sin((d.rot ?? 0) - Math.atan2(-door!.dir.dx, -door!.dir.dy)))).toBeLessThan(1e-9);   // поперёк проёма
          // ⭐ 12.10 (ревью): тень арки — от середины линии проёма в сторону от камеры на clearBeyond клеток — не на полу другой комнаты
          const mi = (door!.cells.length - 1) >> 1;
          const ox = (door!.cells[mi]!.cx + door!.inner[mi]!.cx) / 2 + 0.5, oy = (door!.cells[mi]!.cy + door!.inner[mi]!.cy) / 2 + 0.5;
          for (let t = 0.25; t <= crypt.dressing!.props!.doorway.clearBeyond; t += 0.25) {
            const cx = Math.floor(ox - toCam.x * t), cy = Math.floor(oy - toCam.y * t);
            if (L.grid[cy]?.[cx] !== Cell.Floor) continue;
            const other = L.rooms.findIndex((r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h);
            expect(other < 0 || other === door!.room, `тень арки ${d.objectId} на комнате ${other} (${cx},${cy})`).toBe(true);
          }
        }
        if (s.passport?.tall && !s.passport.doorway && d.objectId !== 'crypt_wooden_shelf_01') throw new Error(`высокий ${d.objectId} вне правил`);
      }
    }
    expect(shelves).toBeGreaterThan(10);
    expect(arches).toBeGreaterThan(100);
  });

  it('⭐ 13.10 (ревью): у стены и в углу спинка МОДЕЛИ — на линии стены (габарит манифеста, не коллайдер); след записи — клетки слота, без ряда стены', () => {
    // габарит модели (м, оси модели) — строка манифеста, независимо от коллайдера, по которому сервер ставит пивот (`wallPivot`). До правки
    // (полглубины СЛЕДА) зазор был: стол 3x длинной стороной вдоль стены 0.30 м, камень длинной стороной поперёк 0.25, ящики 0.14
    const bounds = new Map(cfg.get('art').filter((a) => a.bounds && a.kind !== 'material').map((a) => [a.id, a.bounds!]));
    const worst = new Map<string, number>();
    let n = 0, shifted = 0, corner2 = 0;
    for (const { L } of runs) {
      for (const d of slotDecor(L)) {
        const s = passports.get(d.objectId!)!;
        if (s.passport?.doorway || s.passport?.anchor === 'back' || s.surface === 'wall') continue;
        const b = bounds.get(d.objectId!);
        if (!b) continue;
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(L.grid[y]![x], `${d.objectId}: след записи на не-полу ${x},${y}`).toBe(Cell.Floor);
        const rot = d.rot ?? 0;
        const ax = { x: Math.cos(rot), y: -Math.sin(rot) }, az = { x: Math.sin(rot), y: Math.cos(rot) };   // оси X и Z модели в мире сервера
        let gap = Infinity;
        const gaps: number[] = [], norms: [number, number][] = [];
        for (const [nx, ny] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
          // стена со стороны −n вдоль всего края следа (у угла — две; проп прижат к одной из них)
          let wall = true;
          if (nx) { const wx = nx > 0 ? r.x0 - 1 : r.x1 + 1; for (let y = r.y0; y <= r.y1; y++) if (L.grid[y]![wx] !== Cell.Wall) wall = false; }
          else { const wy = ny > 0 ? r.y0 - 1 : r.y1 + 1; for (let x = r.x0; x <= r.x1; x++) if (L.grid[wy]![x] !== Cell.Wall) wall = false; }
          if (!wall) continue;
          const line = nx ? (nx > 0 ? r.x0 : r.x1 + 1) * TILE : (ny > 0 ? r.y0 : r.y1 + 1) * TILE;
          let back = Infinity;   // спинка — ближняя к стене точка габарита, вдоль нормали от пивота
          for (const X of [b.min[0]!, b.max[0]!]) for (const Z of [b.min[2]!, b.max[2]!]) back = Math.min(back, (ax.x * X + az.x * Z) * nx + (ax.y * X + az.y * Z) * ny);
          const g = (((nx ? d.x : d.y) - line) * (nx || ny)) / TILE + back;
          gaps.push(g); norms.push([nx, ny]);
          if (Math.abs(g) < Math.abs(gap)) gap = g;
        }
        if (gap === Infinity) continue;   // центр комнаты — без стены за следом
        n++;
        // ⭐ 13.10 (ревью): клетка 1 × 1 у двух СМЕЖНЫХ стен — угол; модель прижата к ОБЕИМ (было: ящик в 0.14 м от второй стены). ⭐ 13.10
        // (коридоры 2…4): две стены НАПРОТИВ (щель в клетку — у фигурной комнаты бывает: 1 место на 200 этажей) — проп прижат к одной
        const perp = gaps.length === 2 && norms[0]![0] * norms[1]![0] + norms[0]![1] * norms[1]![1] === 0;
        if (r.x0 === r.x1 && r.y0 === r.y1 && perp) { corner2++; gap = Math.max(...gaps.map(Math.abs)); }
        worst.set(d.objectId!, Math.max(worst.get(d.objectId!) ?? 0, Math.abs(gap)));
        if (Math.hypot(d.x - ((r.x0 + r.x1 + 1) / 2) * TILE, d.y - ((r.y0 + r.y1 + 1) / 2) * TILE) > 0.1 * TILE) shifted++;
      }
    }
    for (const [id, g] of worst) expect(g, `${id}: зазор спинки модели до линии стены, м`).toBeLessThan(0.01);
    expect([...worst.keys()].sort()).toEqual(['crypt_stone_01', 'crypt_wooden_crate_01', 'crypt_wooden_crate_02', 'crypt_wooden_table_2x_01', 'crypt_wooden_table_3x_01']);
    expect(n).toBeGreaterThan(2000);
    expect(corner2, 'угловые клетки 1 × 1 у двух стен').toBeGreaterThan(200);
    // зубы: пивот прижатого пропа — не центр слота (до правки был им у всех, кроме полки): ящики 0.14, камень 0.25, стол 3x 0.30 клетки
    expect(shifted / n).toBeGreaterThan(0.5);
  });

  it('⭐ ревью: правило тени арок с зубами — без него (clearBeyond 0) арок больше, и часть их ложится тенью на другую комнату', () => {
    const bare = cryptRuns(withSeedF2((p) => ({ ...p, doorway: { ...p.doorway, clearBeyond: 0 } })), 8);
    const count = (rs: Run[]): number => rs.reduce((n, { L }) => n + slotDecor(L).filter((d) => passports.get(d.objectId!)!.passport?.doorway).length, 0);
    const live = runs.filter((r) => Number(r.id.split('/')[1]) <= 8);
    expect(count(bare)).toBeGreaterThan(count(live) * 1.3);
    // бюджеты комнат — те же (свой поток бюджета; пропы у стен комнаты правка арок двигать может — устья арок заняты, README)
    expect(bare.map((r) => r.L.slotLog!.rooms.map((x) => x.target).join())).toEqual(live.map((r) => r.L.slotLog!.rooms.map((x) => x.target).join()));
  });

  it('стулья, табуреты и книги не ставятся (сокет — наборы Ф4); в коридорах из паспортов — только арки; в каждой комнате — не больше одного центра', () => {
    const seen = new Map<string, number>();
    for (const { L } of runs) {
      const zone = (d: DecorObject): number => { const c = worldToCell(d.x, d.y); return L.rooms.findIndex((r) => c.cx >= r.x && c.cx < r.x + r.w && c.cy >= r.y && c.cy < r.y + r.h); };
      for (const d of slotDecor(L)) {
        seen.set(d.objectId!, (seen.get(d.objectId!) ?? 0) + 1);
        if (!passports.get(d.objectId!)!.passport?.doorway) expect(zone(d), `${d.objectId} в коридоре`).toBeGreaterThanOrEqual(0);
      }
      expect(L.slotLog!.passes.center.placed).toBeLessThanOrEqual(L.rooms.length);
    }
    for (const k of ['crypt_wooden_chair_01', 'crypt_wooden_stool_01', 'crypt_books_01', 'crypt_wooden_chest_01']) expect(seen.get(k) ?? 0, k).toBe(0);
    for (const k of ['crypt_wooden_table_2x_01', 'crypt_wooden_table_3x_01', 'crypt_wooden_crate_01', 'crypt_wooden_crate_02', 'crypt_stone_01', 'crypt_arch_04']) expect(seen.get(k) ?? 0, k).toBeGreaterThan(0);
  });

  it('бюджет: поставлено не больше цели комнаты; вход — пуст; доля пустых ≈ emptyRoomShare; «одинаковое не рядом»', () => {
    let rooms = 0, empty = 0, placed = 0;
    const R = crypt.dressing!.props!.sameNotNear;
    for (const { L } of runs) {
      for (const r of L.slotLog!.rooms) {
        expect(r.placed).toBeLessThanOrEqual(r.target);
        if (r.type === 'entrance') { expect(r.target).toBe(0); continue; }
        rooms++; if (r.empty) { empty++; expect(r.placed).toBe(0); } placed += r.placed;
      }
      // «одинаковое не рядом» — между ТОЧКАМИ СЛОТОВ (центр следа записи — клетки слота); ⭐ 13.10: пивот у стены — по глубине модели, правило его не читает
      const ds = slotDecor(L).filter((d) => !passports.get(d.objectId!)!.passport?.doorway);
      const pt = (d: DecorObject): { x: number; y: number } => { const r = footprintRect(d); return { x: ((r.x0 + r.x1 + 1) / 2) * TILE, y: ((r.y0 + r.y1 + 1) / 2) * TILE }; };
      for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
        if (ds[i]!.objectId !== ds[j]!.objectId) continue;
        const p = pt(ds[i]!), q = pt(ds[j]!);
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${ds[i]!.objectId} ближе ${R}`).toBeGreaterThan(R * TILE);
      }
    }
    expect(empty / rooms).toBeGreaterThan(0.18); expect(empty / rooms).toBeLessThan(0.32);
    expect(placed / rooms).toBeGreaterThan(1);
    // ⭐ 12.10 (ревью): недобор углов возвращается «спиной к стене» — цель почти выбрана (без возврата было 80 %)
    const t = runs.reduce((n, { L }) => n + L.slotLog!.rooms.reduce((m, r) => m + r.target, 0), 0);
    const p = runs.reduce((n, { L }) => n + L.slotLog!.rooms.reduce((m, r) => m + r.placed, 0), 0);
    expect(p / t, `поставлено ${p} из цели ${t}`).toBeGreaterThan(FILL_MIN);
  });

  it('решётка пола вернула слоты россыпи: паспорта ей больше не соседи по россыпи (Ф1: ~1.5 на этаж)', () => {
    const grilles = runs.reduce((n, { L }) => n + L.decor.filter((d) => d.objectId === 'crypt_floor_grille_01').length, 0);
    expect(grilles / runs.length).toBeGreaterThan(3);
  });

  it('⭐ ревью: преграда россыпи строки без паспорта (решётка, сделанная твёрдой) не встаёт на полосы и не режет проход', () => {
    const hard = withSeedF2();
    hard.reload({ objects: hard.get('objects').map((o) => (o.id === 'crypt_floor_grille_01' ? { ...o, blocks: true } : o)) });
    let grilles = 0;
    for (const { L, specs, id } of cryptRuns(hard, 8)) {
      const cols = L.grid[0]!.length;
      const lane = new Set((L.lanes ?? []).flatMap((x) => x.cells));
      for (const d of L.decor.filter((x) => x.objectId === 'crypt_floor_grille_01')) {
        grilles++;
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(lane.has(y * cols + x), `${id}: решётка на полосе ${x},${y}`).toBe(false);
      }
      expect(cutBySlots(L, specs, new Set(['crypt_floor_grille_01'])), id).toEqual([]);
    }
    expect(grilles).toBeGreaterThan(30);
  });
});

// ── Р6 и у стены: синтетика ──────────────────────────────────────────────────────────────────────────────────────────────
const spec = (id: string, s: Partial<DecorSpec>): DecorSpec =>
  ({ id, footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: false, blocksSight: false, ...s });
const rules = (p: Record<string, unknown> = {}): PropRules => biomeDressingSchema.parse({ props: p }).props!;

describe('⭐ 12.10 (Ф2): Р6 — преграда, отрезающая проход, откатывается (`Passability`)', () => {
  // две комнаты, связанные одной клеткой прохода (3, 2)
  const ROWS = ['#######', '#.#...#', '#.....#', '#.#...#', '#######'];
  it('бокс на единственном проходе — отказ и откат битов; тот же бокс в открытом месте — принят', () => {
    const L = synth(ROWS, [{ x: 1, y: 1, w: 1, h: 3, type: 'small' }, { x: 3, y: 1, w: 3, h: 3, type: 'large' }], { cx: 1, cy: 1 });
    // оракул (зубы): бокс клетки на проходе (2, 2) отрезает правую комнату
    const gate: Obstacle = { x: 2 * TILE + 16, y: 2 * TILE + 16, shape: 'box', hw: 14, hh: 14, yaw: 0 };
    expect(reachHero(L, [gate], true).seen[2 * 7 + 4]).toBe(0);
    const p = new Passability(L, []);
    const before = p.bits.slice();
    expect(p.tryAdd([gate])).toBe(false);
    expect([...p.bits]).toEqual([...before]);
    expect(p.tryAdd([{ x: 5 * TILE + 16, y: 1 * TILE + 16, shape: 'circle', r: 10 }])).toBe(true);
    expect(p.reached(2 * 7 + 4, true)).toBe(true);
  });

  it('закрытая дверь: преграда, после которой рычаг достижим только сквозь его дверь, — отказ', () => {
    // спавн слева внизу, дверь D внизу посередине, рычаг справа внизу: при закрытой двери к рычагу — только верхом, через клетку (3, 1)
    const L = synth(['#######', '#.....#', '#.###.#', '#..D..#', '#######'], [{ x: 1, y: 1, w: 5, h: 3, type: 'large' }], { cx: 1, cy: 3 });
    L.doors = [{ id: 1, cells: [{ cx: 3, cy: 3 }] }];
    L.levers = [{ id: 1, x: 5 * TILE + 16, y: 3 * TILE + 16, doorId: 1 }];
    const p = new Passability(L, []);
    const top: Obstacle = { x: 3 * TILE + 16, y: 1 * TILE + 16, shape: 'box', hw: 14, hh: 14, yaw: 0 };
    expect(reachHero(L, [top], true).seen[3 * 7 + 5], 'при открытой двери — достижим').toBe(1);
    expect(reachHero(L, [top], false).seen[3 * 7 + 5], 'при закрытой — нет').toBe(0);
    expect(p.tryAdd([top])).toBe(false);
  });

  it('⭐ 13.10 (ревью): преграда на клетке спавна — отказ (быстрый путь её пропускал: спавн выпадал из нужных клеток рамки); рядом — принята', () => {
    const L = synth(['#######', '#.....#', '#.....#', '#.....#', '#######'], [{ x: 1, y: 1, w: 5, h: 3, type: 'large' }], { cx: 3, cy: 2 });
    const p = new Passability(L, []);
    const before = p.bits.slice();
    const onSpawn: Obstacle = { x: 3 * TILE + 16, y: 2 * TILE + 16, shape: 'circle', r: 6 };
    // оракул: спавн под ней непроходим — от него не достижимо ничего, хотя соседние клетки проходимы и связаны кольцом
    expect(reachHero(L, [onSpawn], true).seen.reduce((a, b) => a + b, 0)).toBe(0);
    expect(reachHero(L, [onSpawn], true).walk(2 * 7 + 4)).toBe(true);
    expect(p.tryAdd([onSpawn])).toBe(false);
    expect([...p.bits]).toEqual([...before]);
    expect(p.reached(2 * 7 + 3, true) && p.reached(2 * 7 + 3, false)).toBe(true);
    expect(p.tryAdd([{ x: 5 * TILE + 16, y: 1 * TILE + 16, shape: 'circle', r: 6 }])).toBe(true);
  });

  it('⭐ 13.10 (ревью): отказ закрытой проверки не портит кэш открытой — клетки отвергнутой преграды остаются под охраной', () => {
    // спавн (1, 1); к нижнему ряду — правым коридором (8, 2…3) и левым через дверь (1, 3). Пробка в (8, 2): при открытых дверях низ достижим
    // в обход (обход этажа — рамка не связна), при закрытых — нет: отказ. Раньше кэш открытой записывался ДО закрытой — (8, 2) в нём терялась
    const L = synth(['##########', '#........#', '#.######.#', '#D######.#', '#........#', '##########'], [{ x: 1, y: 1, w: 8, h: 4, type: 'large' }], { cx: 1, cy: 1 });
    const p = new Passability(L, []);
    const plug: Obstacle = { x: 8 * TILE + 16, y: 2 * TILE + 16, shape: 'circle', r: 4 };
    expect(reachHero(L, [plug], true).seen[4 * 10 + 8], 'открытые двери — низ достижим').toBe(1);
    expect(reachHero(L, [plug], false).seen[4 * 10 + 8], 'закрытые — нет').toBe(0);
    expect(p.tryAdd([plug])).toBe(false);
    expect(p.globalChecks, 'открытая проверка дошла до обхода этажа (её кэш и портился)').toBeGreaterThanOrEqual(2);
    expect(p.reached(2 * 10 + 8, true), 'клетка отвергнутой пробки — снова достижима в кэше открытых').toBe(true);
    expect(p.reached(2 * 10 + 8, false)).toBe(true);
  });

  it('⭐ 13.10 (ревью): фаззер против оракула — решения `tryAdd` = полный пересчёт (`buildNavMask` + обход), маска та же', () => {
    // случайные сетки 6…14 × 6…12 со стенами и дверями, по 12 преград подряд (круги и боксы, повороты); оракул: принять ⇔ ничто достижимое
    // и проходимое не отрезано (двери открыты и закрыты) и спавн не лёг под преграду
    let seed = 12345;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
    let calls = 0, accepted = 0, onSpawn = 0, cutting = 0;
    for (let t = 0; t < 300; t++) {
      const cols = ri(6, 14), rows = ri(6, 12);
      const g: string[] = [];
      for (let y = 0; y < rows; y++) g.push([...Array(cols)].map((_, x) => (x === 0 || y === 0 || x === cols - 1 || y === rows - 1 || rnd() < 0.18 ? '#' : '.')).join(''));
      const chars = g.map((r) => [...r]);
      for (let k = 0; k < 2; k++) { const x = ri(1, cols - 2), y = ri(1, rows - 2); if (rnd() < 0.5) chars[y]![x] = 'D'; }
      let sx = 1, sy = 1;
      for (let k = 0; k < 50 && chars[sy]![sx] !== '.'; k++) { sx = ri(1, cols - 2); sy = ri(1, rows - 2); }
      if (chars[sy]![sx] !== '.') continue;
      const L = synth(chars.map((r) => r.join('')), [{ x: 1, y: 1, w: cols - 2, h: rows - 2, type: 'large' }], { cx: sx, cy: sy });
      const p = new Passability(L, []);
      const obs: Obstacle[] = [];
      const si = sy * cols + sx;
      for (let k = 0; k < 12; k++) {
        const o: Obstacle = rnd() < 0.5
          ? { x: ri(1, cols - 2) * TILE + ri(0, 32), y: ri(1, rows - 2) * TILE + ri(0, 32), shape: 'circle', r: ri(4, 24) }
          : { x: ri(1, cols - 2) * TILE + ri(0, 32), y: ri(1, rows - 2) * TILE + ri(0, 32), shape: 'box', hw: ri(4, 34), hh: ri(4, 20), yaw: [0, Math.PI / 2, Math.PI / 4, 0.3][ri(0, 3)]! };
        let cuts = false, spawnLost = false;
        for (const open of [true, false]) {
          const a = reachHero(L, obs, open), b = reachHero(L, [...obs, o], open);
          for (let i = 0; i < a.seen.length && !cuts; i++) if (a.seen[i] && b.walk(i) && !b.seen[i]) cuts = true;
          if (a.walk(si) && !b.walk(si)) spawnLost = true;
        }
        const want = !cuts && !spawnLost;
        if (spawnLost) onSpawn++;
        if (cuts) cutting++;
        calls++;
        expect(p.tryAdd([o]), `сетка ${t}, преграда ${k}: ${JSON.stringify(o)}`).toBe(want);
        if (want) { accepted++; obs.push(o); }
        const ref = buildNavMask(cols, rows, obs, PLAYER_RADIUS)?.bits ?? new Uint8Array(cols * rows);
        expect([...p.bits].map((v) => v & 7), `маска, сетка ${t}`).toEqual([...ref].map((v) => v & 7));
      }
    }
    expect(calls).toBeGreaterThan(3000);
    // зубы: преграды на спавне и отрезающие — есть (без правки 1 быстрый путь принимал преграду на спавне)
    expect(onSpawn).toBeGreaterThan(20);
    expect(cutting).toBeGreaterThan(200);
    expect(accepted).toBeGreaterThan(1000);
  });
});

describe('⭐ 12.10 (Ф2): у стены, углы, шаг — синтетика `placeSlots`', () => {
  // одна большая комната 14 × 10 и выход в верхнюю стену (проём 4)
  const room = (): DungeonLayout => {
    const rows: string[] = [];
    for (let y = 0; y < 14; y++) rows.push([...Array(20)].map((_, x) => (x >= 3 && x < 17 && y >= 2 && y < 12) || (y < 2 && y > 0 && x >= 8 && x < 12) ? '.' : '#').join(''));
    return synth(rows, [{ x: 3, y: 2, w: 14, h: 10, type: 'large' }], { cx: 10, cy: 7 });
  };
  const shelf = spec('shelf', { footprint: { w: 2, h: 1 }, blocks: true, contexts: ['againstWall'], collider: { shape: 'box', w: 2, h: 0.4 }, passport: { contexts: ['againstWall'], footprint: { w: 2, h: 1 }, anchor: 'back', backOffset: 0.25, facing: 'room', blocks: true, blocksSight: true, tall: true } });
  const table = spec('table', { footprint: { w: 1, h: 2 }, blocks: true, contexts: ['againstWall'], collider: { shape: 'box', w: 1, h: 2 }, passport: { contexts: ['againstWall'], footprint: { w: 1, h: 2 }, facing: 'along', blocks: true, blocksSight: false, keepPath: true } });
  const crate = spec('crate', { blocks: true, contexts: ['corner'], collider: { shape: 'circle', r: 0.36 }, passport: { contexts: ['corner'], footprint: { w: 1, h: 1 }, blocks: true, blocksSight: false } });
  const run = (specs: DecorSpec[], p: Record<string, unknown>, seed: number): DungeonLayout => {
    const L = room();
    placeSlots(L, rules({ emptyRoomShare: 0, sameNotNear: 0, density: { min: 12, max: 12, perArea: 100 }, center: { on: false }, ...p }), specs, seed, { camAzimuthDeg: -45, known: new Map(specs.map((s) => [s.id, s])) });
    return L;
  };

  it('спиной к стене: полка — к дальней стене, в 0.25 клетки от линии, лицом в комнату; стол «вдоль» — длинной стороной по стене; шаг — центры не ближе step', () => {
    let shelves = 0, tables = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const L = run([shelf, table], { corner: { on: false }, againstWall: { on: true, step: 3 } }, seed);
      const ds = L.decor;
      for (const d of ds) {
        const n = { x: Math.round(Math.sin(d.rot!)), y: Math.round(Math.cos(d.rot!)) };
        if (d.objectId === 'shelf') {
          shelves++;
          expect(isFarFace(n.x, n.y, toCam)).toBe(true);
          // верхняя стена — линия y = 2, правая — x = 17
          if (n.y === 1) expect(d.y).toBeCloseTo((2 + 0.25) * TILE, 6); else expect(d.x).toBeCloseTo((17 - 0.25) * TILE, 6);
        } else {
          tables++;
          // стол прислонён: след касается ровно одной стены комнаты, длинной стороной вдоль неё
          const r = footprintRect(d), w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
          const tb = r.y0 === 2 || r.y1 === 11, side = r.x0 === 3 || r.x1 === 16;
          expect(tb !== side, 'стол у одной стены').toBe(true);
          expect(tb ? w : h, 'длинной стороной вдоль стены').toBe(2);
        }
      }
      // шаг: центры соседей на одной стене (одна нормаль — у прямоугольной комнаты одна стена) не ближе 3 клеток
      const nrm = (d: DecorObject): string => `${Math.round(Math.sin(d.rot!))},${Math.round(Math.cos(d.rot!))}`;
      const back = (d: DecorObject): string => (d.objectId === 'table' ? (() => { const r = footprintRect(d); return r.y0 === 2 ? '0,1' : r.y1 === 11 ? '0,-1' : r.x0 === 3 ? '1,0' : '-1,0'; })() : nrm(d));
      for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i]!, b = ds[j]!;
        if (back(a) !== back(b)) continue;
        const along = back(a).endsWith(',0') ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
        expect(along, `${a.objectId}/${b.objectId} ближе шага`).toBeGreaterThanOrEqual(3 * TILE - 1e-6);
      }
    }
    expect(shelves).toBeGreaterThan(10); expect(tables).toBeGreaterThan(10);
  });

  it('⭐ 13.10 (ревью): пивот у стены — полглубины МОДЕЛИ при этом повороте (бокс: h или w, круг: r), не полглубины следа; след — клетки слота', () => {
    // камень: след 2 × 1, бокс 1.5 × 0.9 (X × Z), все четыре поворота; ящик: круг r 0.36
    const stone = spec('stone', { footprint: { w: 2, h: 1 }, blocks: true, contexts: ['againstWall'], collider: { shape: 'box', w: 1.5, h: 0.9 }, passport: { contexts: ['againstWall'], footprint: { w: 2, h: 1 }, facing: 'quad', blocks: true, blocksSight: false } });
    const box = spec('box', { blocks: true, contexts: ['againstWall'], collider: { shape: 'circle', r: 0.36 }, passport: { contexts: ['againstWall'], footprint: { w: 1, h: 1 }, blocks: true, blocksSight: false } });
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const L = run([stone, box], { corner: { on: false }, againstWall: { on: true, step: 3 } }, seed);
      for (const d of L.decor) {
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(L.grid[y]![x], `${d.objectId}: след записи на не-полу`).toBe(Cell.Floor);
        // стена, к которой прижат след (комната 3…16 × 2…11: линии y = 2, y = 12, x = 3, x = 17); у концов пробега отступ — угла не касается
        const n = r.y0 === 2 ? { x: 0, y: 1 } : r.y1 === 11 ? { x: 0, y: -1 } : r.x0 === 3 ? { x: 1, y: 0 } : { x: -1, y: 0 };
        const line = n.y === 1 ? 2 : n.y === -1 ? 12 : n.x === 1 ? 3 : 17;
        const dist = n.x !== 0 ? (d.x / TILE - line) * n.x : (d.y / TILE - line) * n.y;
        const zAcross = Math.abs(Math.cos((d.rot ?? 0) - Math.atan2(n.x, n.y))) > 0.5;   // ось Z модели — поперёк стены (лицом/спиной)
        expect(dist, `${d.objectId} rot ${d.rot}`).toBeCloseTo(d.objectId === 'box' ? 0.36 : zAcross ? 0.45 : 0.75, 6);
        seen.add(`${d.objectId}:${zAcross}`);
      }
    }
    expect([...seen].sort()).toEqual(['box:false', 'box:true', 'stone:false', 'stone:true']);
  });

  it('⭐ 13.10 (ревью): след записи прижатого пропа — клетки слота (допуск `FOOTPRINT_SNAP`); узлы и полуузлы — как прежде', () => {
    expect(FOOTPRINT_SNAP).toBeLessThan(0.5);
    // ящик 1 × 1 у верхней стены (линия y = 2), пивот в 0.36 от линии — клетка (5, 2), без ряда стены (5, 1)
    expect(footprintRect({ x: 5.5 * TILE, y: 2.36 * TILE, footprint: { w: 1, h: 1 } })).toEqual({ x0: 5, y0: 2, x1: 5, y1: 2 });
    // стол 2 × 3 длинной стороной вдоль левой стены (линия x = 3, поворот π: X модели поперёк), пивот в 0.7 от линии — столбцы 3…4
    expect(footprintRect({ x: 3.7 * TILE, y: 6.5 * TILE, footprint: { w: 2, h: 3 }, rot: Math.PI })).toEqual({ x0: 3, y0: 5, x1: 4, y1: 7 });
    // ⭐ 13.10 (ревью): сдвиг у самого предела (FOOTPRINT_SNAP − SNAP_MARGIN, как `wallPivot` и угол) — всё ещё клетка слота
    expect(footprintRect({ x: 5.5 * TILE, y: (2.5 - FOOTPRINT_SNAP + 1e-6) * TILE, footprint: { w: 1, h: 1 } })).toEqual({ x0: 5, y0: 2, x1: 5, y1: 2 });
    expect(footprintRect({ x: (3.5 - FOOTPRINT_SNAP + 1e-6) * TILE, y: (2.5 - FOOTPRINT_SNAP + 1e-6) * TILE, footprint: { w: 1, h: 1 } })).toEqual({ x0: 3, y0: 2, x1: 3, y1: 2 });
    // за допуском (0.46 от центра клетки к стене) — след снова тянется в ряд стены: допуск не шире нужного
    expect(footprintRect({ x: 5.5 * TILE, y: (2.5 - 0.46) * TILE, footprint: { w: 1, h: 1 } })).toEqual({ x0: 5, y0: 1, x1: 5, y1: 2 });
    // узел и полуузел (центр посреди клетки — след на клетку шире, костёр) — те же клетки, что при прежнем eps 1e-9
    expect(footprintRect({ x: 6 * TILE, y: 6 * TILE, footprint: { w: 2, h: 2 } })).toEqual({ x0: 5, y0: 5, x1: 6, y1: 6 });
    expect(footprintRect({ x: 6.5 * TILE, y: 6 * TILE, footprint: { w: 2, h: 2 } })).toEqual({ x0: 5, y0: 5, x1: 7, y1: 6 });
    expect(footprintRect({ x: 6.5 * TILE, y: 6.5 * TILE, footprint: { w: 3, h: 1 }, rot: Math.PI / 2 })).toEqual({ x0: 6, y0: 5, x1: 6, y1: 7 });
  });

  it('углы: проп в угловую клетку (клетка по диагонали блока свободна), пара — по другой стене; угол у проёма — нет (устье)', () => {
    let corners = 0, pairs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const L = run([crate], { againstWall: { on: false }, corner: { on: true, chance: 1, pair: 1 } }, seed);
      const cells = new Set(L.decor.map((d) => { const c = worldToCell(d.x, d.y); return `${c.cx},${c.cy}`; }));
      for (const [cx, cy, dx, dy] of [[3, 2, 1, 1], [16, 2, -1, 1], [3, 11, 1, -1], [16, 11, -1, -1]] as const) {
        if (!cells.has(`${cx},${cy}`)) continue;
        corners++;
        expect(cells.has(`${cx + dx},${cy + dy}`), 'диагональ блока занята').toBe(false);
        if (cells.has(`${cx + dx},${cy}`) || cells.has(`${cx},${cy + dy}`)) pairs++;
      }
      for (const d of L.decor) { const c = worldToCell(d.x, d.y); expect(c.cy === 2 && c.cx >= 7 && c.cx <= 12, 'проп в устье проёма').toBe(false); }
    }
    expect(corners).toBeGreaterThan(60); expect(pairs).toBeGreaterThan(30);
  });

  it('⭐ 13.10 (ревью): в углу модель прижата к обеим стенам — ящик в угловой клетке, камень 2 × 1 торцом ко второй стене; колышек у предела сдвига — след в клетках слота', () => {
    // комната 3…16 × 2…11: линии стен x = 3, x = 17, y = 2, y = 12; ящик r 0.36 — пивот в 0.36 от обеих; камень 2 × 1, бокс 1.5 × 0.9 — торец в 0.75
    const stone = spec('stone', { footprint: { w: 2, h: 1 }, blocks: true, contexts: ['corner'], collider: { shape: 'box', w: 1.5, h: 0.9 }, passport: { contexts: ['corner'], footprint: { w: 2, h: 1 }, facing: 'quad', blocks: true, blocksSight: false } });
    const peg = spec('peg', { blocks: true, contexts: ['corner'], collider: { shape: 'circle', r: 0.01 }, passport: { contexts: ['corner'], footprint: { w: 1, h: 1 }, blocks: true, blocksSight: false } });
    const edge = (v: number, lo: number, hi: number): number => Math.min(v - lo, hi - v);   // до ближней из двух линий, клеток
    let crates = 0, stones = 0, pegs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (const s of [crate, stone, peg]) {
        const L = run([s], { againstWall: { on: false }, corner: { on: true, chance: 1, pair: 0 } }, seed);
        for (const d of L.decor) {
          const r = footprintRect(d), px = d.x / TILE, py = d.y / TILE;
          for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(L.grid[y]![x], `${d.objectId}: след на не-полу`).toBe(Cell.Floor);
          if (s === crate) { crates++; expect(edge(px, 3, 17)).toBeCloseTo(0.36, 6); expect(edge(py, 2, 12)).toBeCloseTo(0.36, 6); }
          if (s === stone) {
            stones++;
            const longX = r.x1 > r.x0;   // длинная сторона следа — вдоль стены y; торец — к стене x (и наоборот)
            expect(longX ? edge(px, 3, 17) : edge(py, 2, 12), 'торец камня — ко второй стене').toBeCloseTo(0.75, 6);
            expect(longX ? edge(py, 2, 12) : edge(px, 3, 17), 'спинка камня — к стене').toBeCloseTo(0.45, 6);
          }
          if (s === peg) { pegs++; expect(edge(px, 3, 17)).toBeCloseTo(0.05, 4); expect(edge(py, 2, 12)).toBeCloseTo(0.05, 4); expect(r.x1 - r.x0 + r.y1 - r.y0).toBe(0); }
        }
      }
    }
    expect(crates).toBeGreaterThan(60); expect(stones).toBeGreaterThan(30); expect(pegs).toBeGreaterThan(60);
  });

  it('⭐ ревью: недобор углов возвращается «спиной к стене» — заявки углов не встали, цель всё равно выбрана', () => {
    // проп угла с весом 0 в large — заявки углов есть (шанс 1: все четыре), а встать некому; у стены — ящик
    const ghost = spec('ghost', { contexts: ['corner'], rooms: { large: 0 }, passport: { contexts: ['corner'], footprint: { w: 1, h: 1 }, blocks: false, blocksSight: false } });
    const box = spec('box', { blocks: true, contexts: ['againstWall'], collider: { shape: 'circle', r: 0.36 }, passport: { contexts: ['againstWall'], footprint: { w: 1, h: 1 }, blocks: true, blocksSight: false } });
    for (let seed = 1; seed <= 10; seed++) {
      const L = run([ghost, box], { density: { min: 4, max: 4, perArea: 100 }, corner: { on: true, chance: 1, pair: 0 }, againstWall: { on: true, step: 3 } }, seed);
      const r = L.slotLog!.rooms[0]!;
      expect(r.target).toBe(6);   // round(4 · 140 / 100)
      expect(L.slotLog!.passes.corner.placed).toBe(0);
      expect(r.placed, 'без возврата было бы 6 − 4 заявки = 2').toBe(6);
      expect(L.decor.filter((d) => d.objectId === 'box').length).toBe(6);
    }
  });
});

// ── ⭐ ревью Ф2: арки и тень на другой комнате; грани стен (контекст wall) — синтетика ─────────────────────────────────────────
describe('⭐ 12.10 (ревью Ф2): арка не ставится, если её тень ложится на другую комнату (`doorway.clearBeyond`)', () => {
  // комната A (3…16 × 6…13): проём 4 в верхней (дальней) стене прямо в комнату B (3…16 × 1…4) и проём 4 в правой (дальней) стене — в коридор
  const layout = (): DungeonLayout => {
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) rows.push([...Array(30)].map((_, x) => {
      const A = x >= 3 && x < 17 && y >= 6 && y < 14, B = x >= 3 && x < 17 && y >= 1 && y < 5;
      const top = y === 5 && x >= 8 && x < 12, east = x >= 17 && x < 28 && y >= 7 && y < 11;
      return A || B || top || east ? '.' : '#';
    }).join(''));
    return synth(rows, [{ x: 3, y: 6, w: 14, h: 8, type: 'large' }, { x: 3, y: 1, w: 14, h: 4, type: 'small' }], { cx: 10, cy: 10 });
  };
  const arch = spec('arch', { footprint: { w: 4, h: 1 }, contexts: ['doorway'], passport: { contexts: ['doorway'], footprint: { w: 4, h: 1 }, blocks: false, blocksSight: false, tall: true, doorway: { width: 4 } } });
  const arches = (clearBeyond: number): { x: number; y: number }[] => {
    const L = layout();
    placeSlots(L, rules({ emptyRoomShare: 0, center: { on: false }, corner: { on: false }, againstWall: { on: false }, wall: { on: false }, doorway: { on: true, chance: 1, clearBeyond } }), [arch], 1, { camAzimuthDeg: -45, known: new Map([[arch.id, arch]]) });
    return L.decor.filter((d) => d.objectId === 'arch').map((d) => ({ x: d.x / TILE, y: d.y / TILE }));
  };

  it('проём дальней стены в соседнюю комнату (для неё — ближняя стена) — без арки; проём в коридор — в арке; правило выключено — обе', () => {
    expect(arches(6)).toEqual([{ x: 17, y: 9 }]);                       // правая стена: линия x = 17, проём y 7…10
    expect(arches(0)).toEqual([{ x: 10, y: 6 }, { x: 17, y: 9 }]);      // верх: на линии стены y = 6 (между проёмом и устьем)
    expect(arches(1)).toEqual([{ x: 10, y: 6 }, { x: 17, y: 9 }]);      // тень в клетку — ещё в проёме (луч по диагонали от камеры)
    expect(arches(2)).toEqual([{ x: 17, y: 9 }]);                       // две — уже пол комнаты B
  });
});

describe('⭐ 12.10 (ревью Ф2): грани стен (контекст wall) — шаг, высокие у дальних, факел и ниша, коридоры, Р6', () => {
  // комната 14 × 10 (3…16 × 2…11) и коридор над проёмом (8…11 × 1)
  const room = (): DungeonLayout => {
    const rows: string[] = [];
    for (let y = 0; y < 14; y++) rows.push([...Array(20)].map((_, x) => (x >= 3 && x < 17 && y >= 2 && y < 12) || (y === 1 && x >= 8 && x < 12) ? '.' : '#').join(''));
    return synth(rows, [{ x: 3, y: 2, w: 14, h: 10, type: 'large' }], { cx: 10, cy: 7 });
  };
  const wallSpec = (id: string, s: Partial<DecorSpec> = {}, tall = false): DecorSpec =>
    spec(id, { surface: 'wall', contexts: ['wall'], passport: { contexts: ['wall'], footprint: { w: 1, h: 1 }, blocks: !!s.blocks, blocksSight: false, tall }, ...s });
  const banner = wallSpec('banner'), tallBanner = wallSpec('tallbanner', {}, true);
  // смешанный паспорт (грань + у стены) — поверхность пол: граням не годится
  const mixed = spec('mixed', { contexts: ['wall', 'againstWall'], passport: { contexts: ['wall', 'againstWall'], footprint: { w: 1, h: 1 }, blocks: false, blocksSight: false } });
  const torch = spec('torch', { surface: 'wall' }), statue = spec('statue', { surface: 'wall' });
  /** Грань записи декора: клетка-стена и нормаль (как `placeSlots` читает стоящий настенный декор). */
  const faceOf = (d: DecorObject): string => {
    const dx = Math.round(Math.sin(d.rot ?? 0)), dz = Math.round(Math.cos(d.rot ?? 0));
    return [Math.round((d.x - 16 - dx * 16) / TILE), Math.round((d.y - 16 - dz * 16) / TILE), dx, dz].join(',');
  };
  const place = (L: DungeonLayout, specs: DecorSpec[], wall: Record<string, unknown>, seed: number): void => {
    placeSlots(L, rules({ emptyRoomShare: 0, sameNotNear: 0, center: { on: false }, corner: { on: false }, againstWall: { on: false }, doorway: { on: false }, wall: { on: true, chance: 1, ...wall } }), specs, seed,
      { camAzimuthDeg: -45, known: new Map([...specs, torch, statue].map((s) => [s.id, s])) });
  };

  it('проп на грани, позиции с шагом по пробегу, высокий — только дальняя стена, не на грани факела и ниши; смешанный паспорт — не на гранях', () => {
    let n = 0, tall = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const L = room();
      // факел — на грани (4, 1) верхней стены (позиция 1 левого пробега), ниша — грани (13, 1) и (14, 1) (позиция 1 правого)
      L.decor.push({ x: 4 * TILE + 16, y: 2 * TILE, kind: 'obj', objectId: 'torch', rot: 0 });
      L.decor.push({ x: 14 * TILE, y: 2 * TILE, kind: 'obj', objectId: 'statue', rot: 0, wallFaces: [[13, 1, 0, 1], [14, 1, 0, 1]] });
      place(L, [banner, tallBanner, mixed], { step: 3, corridors: true }, seed);
      const ds = L.decor.filter((d) => d.objectId === 'banner' || d.objectId === 'tallbanner');
      expect(L.decor.some((d) => d.objectId === 'mixed'), 'смешанный паспорт на грани').toBe(false);
      const faces = ds.map(faceOf);
      for (const [k, d] of ds.entries()) {
        n++;
        const [x, y, dx, dz] = faces[k]!.split(',').map(Number) as [number, number, number, number];
        expect(L.grid[y]![x], 'за пропом — стена').toBe(Cell.Wall);
        expect(L.grid[y + dz]![x + dx], 'перед гранью — пол').toBe(Cell.Floor);
        expect(['4,1,0,1', '13,1,0,1', '14,1,0,1']).not.toContain(faces[k]);
        if (d.objectId === 'tallbanner') { tall++; expect(isFarFace(dx, dz, toCam), 'высокий у ближней стены').toBe(true); }
      }
      // шаг: на одной стене (та же нормаль и линия) позиции не ближе 3 граней
      for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
        const [ax, ay, adx, adz] = faces[i]!.split(',').map(Number) as number[], [bx, by, bdx, bdz] = faces[j]!.split(',').map(Number) as number[];
        if (adx !== bdx || adz !== bdz || (adx !== 0 ? ax !== bx : ay !== by)) continue;
        expect(Math.abs(adx !== 0 ? ay! - by! : ax! - bx!), `${faces[i]} / ${faces[j]}`).toBeGreaterThanOrEqual(3);
      }
      // коридор (зона −1): верхняя стена коридора — одна позиция (грань 9, 0)
      expect(faces.filter((f) => f.endsWith(',0,1') && f.split(',')[1] === '0')).toEqual(['9,0,0,1']);
      expect(L.slotLog!.passes.wall.placed).toBe(ds.length);
    }
    expect(n).toBeGreaterThan(60); expect(tall).toBeGreaterThan(5);
  });

  it('corridors: false — в коридорах граней нет', () => {
    const L = room();
    place(L, [banner], { step: 3, corridors: false }, 1);
    expect(L.decor.filter((d) => d.objectId === 'banner').map(faceOf).filter((f) => f.split(',')[1] === '0')).toEqual([]);
    expect(L.decor.length).toBeGreaterThan(5);
  });

  it('Р6: настенная преграда, запирающая тупик коридора, откатывается; проходимость радиусом героя цела', () => {
    // комната 3…16 × 7…13 и тупик-коридор шириной в клетку (9, 1…6); бокс глубиной 2 клетки на грани коридора перекрывает его
    const rows: string[] = [];
    for (let y = 0; y < 15; y++) rows.push([...Array(20)].map((_, x) => (x >= 3 && x < 17 && y >= 7 && y < 14) || (x === 9 && y >= 1 && y < 7) ? '.' : '#').join(''));
    const box = wallSpec('wallbox', { blocks: true, collider: { shape: 'box', w: 1, h: 2 } });
    for (let seed = 1; seed <= 6; seed++) {
      const L = synth(rows, [{ x: 3, y: 7, w: 14, h: 7, type: 'large' }], { cx: 10, cy: 10 });
      place(L, [box], { step: 3, corridors: true }, seed);
      expect(L.slotLog!.passes.wall.rejected, 'откаты в коридоре').toBeGreaterThan(0);
      expect(L.decor.filter((d) => d.objectId === 'wallbox' && worldToCell(d.x, d.y).cy < 7), 'преграда в тупике').toEqual([]);
      const obs = obstaclesFromDecor(L.decor, new Map([[box.id, box]]));
      const { seen, walk } = reachHero(L, obs, true);
      for (let i = 0; i < seen.length; i++) if (walk(i)) expect(seen[i], `клетка ${i % 20},${(i / 20) | 0} отрезана`).toBe(1);
    }
  });
});

describe('⭐ 12.10 (Ф2): потоки rng по комнатам и проходам', () => {
  it('под-сид: разный у прохода и у комнаты, тот же — у того же входа', () => {
    expect(slotSeed(7, SLOT_STREAMS.corner, 1)).toBe(slotSeed(7, SLOT_STREAMS.corner, 1));
    expect(new Set([slotSeed(7, SLOT_STREAMS.corner, 1), slotSeed(7, SLOT_STREAMS.corner, 2), slotSeed(7, SLOT_STREAMS.againstWall, 1), slotSeed(8, SLOT_STREAMS.corner, 1)]).size).toBe(4);
  });

  it('правка шанса угла не трогает арки и центр (свои потоки), а пропы углов меняет', () => {
    const a = cryptRuns(withSeedF2(), 6), b = cryptRuns(withSeedF2((p) => ({ ...p, corner: { ...p.corner, chance: 0.9 } })), 6);
    const archesOf = (L: DungeonLayout): string => JSON.stringify(L.decor.filter((d) => d.objectId?.startsWith('crypt_arch')));
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      expect(archesOf(b[i]!.L)).toBe(archesOf(a[i]!.L));
      expect(b[i]!.L.slotLog!.passes.center.placed).toBe(a[i]!.L.slotLog!.passes.center.placed);
      if (JSON.stringify(a[i]!.L.decor) !== JSON.stringify(b[i]!.L.decor)) changed++;
    }
    expect(changed).toBeGreaterThan(a.length / 2);
  });

  it('правила крипты не меняют этажи других биомов', () => {
    const a = new ConfigRegistry(); a.loadAll();
    const b = withSeedF2((p) => ({ ...p, density: { min: 9, max: 9, perArea: 50 } }));
    for (const biome of a.get('biomes').filter((x) => x.id !== 'crypt')) {
      const f = a.get('floors').find((x) => x.biomeId === biome.id)!;
      const s = resolveFloorSpec(biome, f, f.minDepth, 99, [], { exitCount: 1 });
      expect(JSON.stringify(generateFloorFor(b, s, b.get('biomes').find((x) => x.id === biome.id)).layout)).toBe(JSON.stringify(generateFloorFor(a, s, biome).layout));
    }
  });
});

// без правил пропов генератор не зовёт слоты: синтетический этаж с паспортной спекой и оформлением без props — как без оформления
describe('⭐ 12.10 (Ф2): опция оформления без правил пропов — слоты не участвуют', () => {
  it('generateFloorParams: dressing без props — этаж байт-в-байт тот же, что без dressing (паспортная спека россыпью)', () => {
    const PARAMS = { algorithm: 'rooms' as const, cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest' as const, shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0, largeRoomArea: 80 };
    const s = [spec('rug', { contexts: ['floor'], passport: { contexts: ['floor'], footprint: { w: 1, h: 1 }, blocks: false, blocksSight: false } })];
    for (let seed = 1; seed <= 20; seed++) {
      expect(JSON.stringify(generateFloorParams(PARAMS, seed, { decorSpecs: s, dressing: { rules: {}, camAzimuthDeg: -45 } })))
        .toBe(JSON.stringify(generateFloorParams(PARAMS, seed, { decorSpecs: s })));
    }
  });
});

// ── ⭐ 13.10: арки — обе в проём 3, на 4 никогда; след записи — проём; колонны косяков — флаг паспорта (Unity) ─────────────────────
/** Арка в проёме сервера: точка — середина проёма и его устья (`archOf`). */
const doorOfArch = (L: DungeonLayout, d: DecorObject): Doorway | undefined => (L.doorways ?? []).find((q) => {
  const xs = [...q.cells, ...q.inner];
  const mx = xs.reduce((a, c) => a + c.cx * TILE + 16, 0) / xs.length, my = xs.reduce((a, c) => a + c.cy * TILE + 16, 0) / xs.length;
  return Math.abs(mx - d.x) < 1e-6 && Math.abs(my - d.y) < 1e-6;
});

describe('⭐ 13.10 (отзыв владельца по скринам Ф2): арки по проёму 3 и колонны косяков', () => {
  const ARCHES = ['crypt_arch_01', 'crypt_arch_04'];
  const cfg = withSeedF2();
  const runs = cryptRuns(cfg, 24);

  it('живая крипта (коридоры 2…4): обе арки — только в проёмах ширины 3, в проём 4 — никогда; обе встают, по весу поровну', () => {
    const by = new Map<string, number>();
    let open3 = 0, open4 = 0, arch4 = 0;
    for (const { L, id } of runs) {
      for (const q of L.doorways ?? []) { if (q.width === 3) open3++; if (q.width === 4) open4++; }
      for (const d of L.decor.filter((x) => ARCHES.includes(x.objectId ?? ''))) {
        const door = doorOfArch(L, d);
        expect(door, `${id}: арка ${d.objectId} не в проёме`).toBeDefined();
        expect(door!.width, `${id}: ${d.objectId} в проёме ${door!.width}`).toBe(3);
        if (door!.width === 4) arch4++;
        by.set(d.objectId!, (by.get(d.objectId!) ?? 0) + 1);
      }
    }
    expect(open4, 'проёмы 4 есть (коридоры 4) — и все без арки').toBeGreaterThan(200);
    expect(open3).toBeGreaterThan(200);
    expect(arch4).toBe(0);
    const a1 = by.get('crypt_arch_01') ?? 0, a4 = by.get('crypt_arch_04') ?? 0;
    expect(a1, 'малая').toBeGreaterThan(50); expect(a4, 'большая').toBeGreaterThan(50);
    expect(Math.abs(a1 - a4) / (a1 + a4), `малых ${a1}, больших ${a4} — вес паспортов поровну`).toBeLessThan(0.2);
  });

  it('след записи арки — проём (ширина × 1 по линии стены): `footprintRect` — ровно ряд проёма и устье, не стены косяков; у большой модель шире', () => {
    const bounds = new Map(cfg.get('art').filter((a) => a.bounds && a.kind !== 'material').map((a) => [a.id, a.bounds!]));
    let n = 0;
    for (const { L } of runs) {
      for (const d of L.decor.filter((x) => ARCHES.includes(x.objectId ?? ''))) {
        const door = doorOfArch(L, d)!;
        expect(d.footprint).toEqual({ w: door.width, h: 1 });
        expect(footprintRect(d)).toEqual(archOf(L, door).rect);
        const r = footprintRect(d);
        for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(L.grid[y]![x], 'след арки — на проходимом').not.toBe(Cell.Wall);
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
    // модель большой — 4.06 м на проём 3 (ноги над косяками), малой — 3 м: в проём впору
    const b4 = bounds.get('crypt_arch_04')!, b1 = bounds.get('crypt_arch_01')!;
    expect(b4.max[0]! - b4.min[0]!).toBeGreaterThan(4);
    expect(b1.max[0]! - b1.min[0]!).toBeCloseTo(3, 2);
  });

  it('флаг колонн косяков — в паспорте (большая replace, малая — без поля = keep); сервер его не читает: раскладка с ним и без — та же', () => {
    const passports = new Map(runs[0]!.specs.filter((s) => s.passport).map((s) => [s.id, s.passport!]));
    expect(passports.get('crypt_arch_04')!.doorway).toEqual({ width: 3, jambs: 'replace' });
    expect(passports.get('crypt_arch_01')!.doorway).toEqual({ width: 3 });
    const plain = new ConfigRegistry(); plain.loadAll();
    plain.reload({ art: structuredClone(cfg.get('art')).map((a) => (a.id === 'crypt_arch_04' && a.decor?.doorway ? { ...a, decor: { ...a.decor, doorway: { width: 3 } } } : a)) });
    const again = cryptRuns(plain, 6);
    expect(again.map((r) => JSON.stringify(r.L))).toEqual(runs.filter((r) => Number(r.id.split('/')[1]) <= 6).map((r) => JSON.stringify(r.L)));
  });

  // синтетика: комната 3…16 × 6…13; вверху (дальняя стена) проём 3 (x 8…10) в коридор до y 1, справа (дальняя) — проём 4 (y 7…10) в коридор на восток
  const layout = (): DungeonLayout => {
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) rows.push([...Array(30)].map((_, x) => {
      const A = x >= 3 && x < 17 && y >= 6 && y < 14, top = x >= 8 && x < 11 && y >= 1 && y < 6, east = x >= 17 && x < 28 && y >= 7 && y < 11;
      return A || top || east ? '.' : '#';
    }).join(''));
    return synth(rows, [{ x: 3, y: 6, w: 14, h: 8, type: 'large' }], { cx: 10, cy: 10 });
  };
  const arch = (id: string, width: number, weight = 1, jambs?: 'keep' | 'replace'): DecorSpec => spec(id, {
    footprint: { w: width + 1, h: 1 }, contexts: ['doorway'], weight,
    passport: { contexts: ['doorway'], footprint: { w: width + 1, h: 1 }, blocks: false, blocksSight: false, tall: true, doorway: { width, ...(jambs ? { jambs } : {}) } },
  });
  const place = (specs: DecorSpec[], seed = 1): DecorObject[] => {
    const L = layout();
    placeSlots(L, rules({ emptyRoomShare: 0, center: { on: false }, corner: { on: false }, againstWall: { on: false }, wall: { on: false }, doorway: { on: true, chance: 1, clearBeyond: 6 } }), specs, seed,
      { camAzimuthDeg: -45, known: new Map(specs.map((s) => [s.id, s])) });
    return L.decor.filter((d) => d.kind === 'obj');
  };

  it('правило — ширина паспорта = ширине проёма: арки 3 — в проём 3, проём 4 — без арки; арка 4 — в проём 4; вес 0 — никогда; след — проём', () => {
    const got = place([arch('big', 3, 1, 'replace'), arch('small', 3, 1)]);
    expect(got.map((d) => [d.x / TILE, d.y / TILE, d.footprint])).toEqual([[9.5, 6, { w: 3, h: 1 }]]);   // верх: середина x 8…10, линия y = 6
    expect(['big', 'small']).toContain(got[0]!.objectId);
    const four = place([arch('big', 3), arch('wide', 4)]);
    expect(four.map((d) => [d.objectId, d.x / TILE, d.y / TILE, d.footprint])).toEqual([['big', 9.5, 6, { w: 3, h: 1 }], ['wide', 17, 9, { w: 4, h: 1 }]]);
    for (let seed = 1; seed <= 20; seed++) expect(place([arch('never', 3, 0), arch('always', 3, 1)], seed).map((d) => d.objectId)).toEqual(['always']);
    // поровну по весу: на 60 сидах встают обе
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) for (const d of place([arch('big', 3, 1, 'replace'), arch('small', 3, 1)], seed)) seen.add(d.objectId!);
    expect([...seen].sort()).toEqual(['big', 'small']);
  });

  it('`archOf`: на любой стороне и ширине 2…4 след записи — ряд проёма и устье, точка — на линии стены, лицом в комнату', () => {
    // комната 4…11 × 4…9: верх проём 2 (x 6…7), низ 4 (x 5…8), лево 3 (y 5…7), право 3 (y 6…8)
    const rows: string[] = [];
    for (let y = 0; y < 14; y++) rows.push([...Array(16)].map((_, x) => {
      const R = x >= 4 && x < 12 && y >= 4 && y < 10;
      const t = y < 4 && y >= 1 && x >= 6 && x < 8, b = y >= 10 && y < 13 && x >= 5 && x < 9, l = x < 4 && x >= 1 && y >= 5 && y < 8, r = x >= 12 && x < 15 && y >= 6 && y < 9;
      return R || t || b || l || r ? '.' : '#';
    }).join(''));
    const L = synth(rows, [{ x: 4, y: 4, w: 8, h: 6, type: 'large' }]);
    const doors = roomDoorways(L);
    expect(doors.map((d) => d.width)).toEqual([2, 4, 3, 3]);
    for (const d of doors) {
      const a = archOf(L, d);
      const rec = { x: a.x, y: a.y, rot: a.rot, footprint: a.foot };
      const cells = [...d.cells, ...d.inner];
      expect(footprintRect(rec)).toEqual({ x0: Math.min(...cells.map((c) => c.cx)), y0: Math.min(...cells.map((c) => c.cy)), x1: Math.max(...cells.map((c) => c.cx)), y1: Math.max(...cells.map((c) => c.cy)) });
      // лицо (+Z модели) — в комнату: (sin rot, cos rot) = −dir
      expect(Math.round(Math.sin(a.rot)) + 0).toBe(-d.dir.dx + 0); expect(Math.round(Math.cos(a.rot)) + 0).toBe(-d.dir.dy + 0);
      // точка — на линии стены (между рядом проёма и устьем)
      const line = d.dir.dy !== 0 ? Math.max(d.cells[0]!.cy, d.inner[0]!.cy) * TILE : Math.max(d.cells[0]!.cx, d.inner[0]!.cx) * TILE;
      expect(d.dir.dy !== 0 ? a.y : a.x).toBe(line);
    }
  });
});
