import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConfigRegistry } from '../config/registry.js';
import { artDecorSchema, DECOR_CONTEXTS, type ArtDecor, type Biome, type Floor } from '../config/schemas.js';
import { createRng } from '../formulas/rng.js';
import { Cell, TILE, makeGrid, worldToCell, type Grid } from '../world/grid.js';
import { buildNavMask, NAV_CELL, NAV_DOWN, NAV_RIGHT } from '../world/pathfind.js';
import { validate, type DungeonLayout, type Room } from './floorCommon.js';
import {
  decorSpecsFor, decorWarnings, footprintRect, obstaclesFromDecor, placeableObjects, placeFloorDecor, placeWallProps, rotatedFootprint,
  type ArtRowLite, type DecorSpec, type ObjCfgLite,
} from './decor.js';
import { floorInputs, generateFloorFor, type FloorConfig } from './floorInputs.js';
import { resolveFloorSpec } from './floorSpec.js';
import { generateFloorParams } from './generateFloor.js';

/**
 * ⭐ 12.10 (Ф1 «Паспорт», план декора): ПАСПОРТ ДЕКОРА и НЕЯВНЫЕ ОБЪЕКТЫ. Сторожа:
 *  • без паспортов этажи БАЙТ-В-БАЙТ прежние: путь сервера на замороженных входах дня Ф1 даёт ровно этажи снимка кода до Ф1
 *    (`__golden__/floors_pre_passport.json`), а плотность россыпи из `data/biomes.json` — то же, что без поля;
 *  • ключ манифеста с паспортом без строки `objects` — неявный объект (строка перекрывает, выключенная — выключает); паспорт без биома/контекстов
 *    и роль `decor` — предупреждения редактора (G15);
 *  • с паспортами Ф1 ставит только прежними проходами (контекст `floor` — россыпь, `wall` — грани), веса из конфига и по комнатам (G2), след с
 *    поворотом (G3), преграды не отрезают ни клетки этажа (правило кольца, G11) — на живых этажах крипты с паспортами семени Unity;
 *  • грани стен (ревью 12.10): у прохода граней нет бюджета — неявный объект туда не допускается (с частотой 1 он занимал 82 % граней), строка
 *    `objects` ставится своей частотой и с весами паспорта по месту грани (`corridor: 0` — не в коридорах);
 *  • игровая ревизия: паспорт — игра, разброс `variance` — картинка.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const balance = reg.get('balance');
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')!;
const digestOf = (L: DungeonLayout, obstacles: unknown): string => createHash('sha256').update(JSON.stringify({ L, obstacles })).digest('hex').slice(0, 20);
const GOLDEN = new URL('./__golden__/floors_pre_passport.json', import.meta.url);

/** Таблицы конфига как их видит генерация — с манифестом без паспортов (замороженные входы снимка — `inputs` эталона). */
function frozenInputs(r: FloorConfig): Record<string, unknown> {
  return {
    biomes: r.get('biomes'),
    floors: r.get('floors'),
    objects: r.get('objects'),
    models: r.get('models').map((m) => (m.collider ? { id: m.id, collider: m.collider } : { id: m.id })),
    art: r.get('art').map((a) => (a.collider ? { id: a.id, kind: a.kind, group: a.group, collider: a.collider } : { id: a.id, kind: a.kind, group: a.group })),
    'room-prefabs': r.get('room-prefabs'),
    chests: r.get('chests'),
    balance: { camera: { azimuthDeg: r.get('balance').camera.azimuthDeg }, loot: { chestsPerFloor: r.get('balance').loot.chestsPerFloor } },
  };
}
const asCfg = (t: Record<string, unknown>): FloorConfig => ({ get: (k: string) => t[k] }) as unknown as FloorConfig;

/** Этажи пути сервера (`generateFloorFor`): каждый биом × каждый его этаж × сиды — как в снимке. */
function serverFloors(cfg: FloorConfig, seeds: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of cfg.get('biomes')) {
    for (const f of cfg.get('floors').filter((x) => x.biomeId === b.id)) {
      for (let seed = 1; seed <= seeds; seed++) {
        const spec = resolveFloorSpec(b, f, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) });
        const { layout, obstacles } = generateFloorFor(cfg, spec, b);
        out.set(`${b.id}/${f.id}/${seed}`, digestOf(layout, obstacles));
      }
    }
  }
  return out;
}

describe('⭐ 12.10 (Ф1): без паспортов — этажи байт-в-байт прежние', () => {
  it('снимок кода до Ф1: путь сервера на замороженных входах — те же этажи (все биомы × все этажи × 6 сидов)', () => {
    if (process.env.DM_DECOR_GOLDEN === 'write') {   // намеренная правка генерации — пересобрать снимок (входы — живой конфиг без паспортов)
      const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { note: string; seeds: number };
      const inputs = frozenInputs(reg);
      writeFileSync(GOLDEN, JSON.stringify({ note: g.note, seeds: g.seeds, digests: Object.fromEntries(serverFloors(asCfg(inputs), g.seeds)), inputs }) + '\n');
    }
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { seeds: number; digests: Record<string, string>; inputs: Record<string, unknown> };
    const got = serverFloors(asCfg(g.inputs), g.seeds);
    expect(got.size, 'этажей в снимке').toBe(Object.keys(g.digests).length);
    expect(got.size).toBeGreaterThan(100);
    const diff = [...got].filter(([k, v]) => g.digests[k] !== v).map(([k]) => k);
    expect(diff, 'этажи, ставшие другими').toEqual([]);
  });

  it('плотность россыпи из data/biomes.json (decorDensity) — та же, что без поля (1 / 2 / 60): живой конфиг, все биомы × этажи × 6 сидов', () => {
    for (const b of reg.get('biomes')) expect(b.decorDensity, `${b.id}: плотность — в data`).toEqual({ chancePerRoom: 1, maxPerRoom: 2, areaPerSlot: 60 });
    const live = frozenInputs(reg);
    const bare = { ...live, biomes: (live.biomes as Biome[]).map(({ decorDensity: _d, ...b }) => b) };
    expect([...serverFloors(asCfg(live), 6)]).toEqual([...serverFloors(asCfg(bare), 6)]);
  });
});

// ── паспорта ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const P = (p: Partial<ArtDecor>): ArtDecor => artDecorSchema.parse(p);
const obj = (id: string, modelId: string, o: Partial<ObjCfgLite> = {}): ObjCfgLite =>
  ({ id, modelId, enabled: true, role: 'prop', surface: 'floor', biomes: ['crypt'], blocks: false, blocksSight: false, footprint: { w: 1, h: 1 }, spawnChance: 0.35, clearance: 0, ...o });

describe('⭐ 12.10 (Ф1): неявные объекты паспортов (`placeableObjects` / `decorSpecsFor`)', () => {
  const art: ArtRowLite[] = [
    { id: 'table', kind: 'env', group: 'biome_crypt', collider: { shape: 'box', w: 1.4, h: 3 }, decor: P({ contexts: ['floor', 'againstWall'], footprint: { w: 2, h: 3 }, blocks: true, clearance: 1, weight: 0.5, rooms: { small: 0, large: 1, treasure: 1, boss: 1, corridor: 0 } }) },
    { id: 'torch2', kind: 'env', group: 'biome_crypt', decor: P({ contexts: ['wall'] }) },
    { id: 'insert', kind: 'env', group: 'biome_crypt', decor: P({ contexts: ['wall', 'wallInsert'] }) },
    { id: 'mixed', kind: 'prop', group: 'props', decor: P({ contexts: ['wall', 'floor'], biomes: ['caves'] }) },
    { id: 'nobiome', kind: 'prop', group: 'props', decor: P({}) },
    { id: 'empty', kind: 'env', group: 'biome_crypt', decor: P({ contexts: [] }) },
    { id: 'mat', kind: 'material', group: 'mat_crypt', decor: P({}) },
    { id: 'hero', kind: 'character', group: 'char', decor: P({}) },
    { id: 'claimed', kind: 'env', group: 'biome_crypt', decor: P({ contexts: ['floor'], weight: 7, rooms: { small: 2, large: 1, treasure: 1, boss: 1, corridor: 1 } }) },
    { id: 'off', kind: 'env', group: 'biome_crypt', decor: P({}) },
    { id: 'byid', kind: 'env', group: 'biome_crypt', decor: P({}) },
    { id: 'plain', kind: 'env', group: 'biome_crypt', collider: { shape: 'circle', r: 0.3 } },
  ];
  const objects: ObjCfgLite[] = [
    obj('row_claimed', 'claimed', { footprint: { w: 1, h: 1 }, blocks: true, spawnChance: 0.2 }),
    obj('row_off', 'off', { enabled: false }),
    obj('byid', 'other_model'),
    obj('row_plain', 'plain', { weight: 3 }),
  ];

  it('ключ с паспортом без строки objects — объект: id = модель = ключ, роль prop, поверхность по контекстам, биом папки, частота 1', () => {
    const all = placeableObjects(objects, art);
    expect(all.map((o) => o.id)).toEqual(['row_claimed', 'row_off', 'byid', 'row_plain', 'empty', 'insert', 'mixed', 'nobiome', 'table', 'torch2']);   // неявные — по ключу
    const by = new Map(all.map((o) => [o.id, o]));
    expect(by.get('table')).toMatchObject({ modelId: 'table', role: 'prop', surface: 'floor', biomes: ['crypt'], blocks: true, footprint: { w: 2, h: 3 }, spawnChance: 1, clearance: 1, weight: 0.5, implicit: true });
    expect(by.get('torch2')!.surface).toBe('wall');
    expect(by.get('insert')!.surface).toBe('wall');
    expect(by.get('mixed')).toMatchObject({ surface: 'floor', biomes: ['caves'] });   // свой биом паспорта главнее папки
    expect(by.get('nobiome')!.biomes).toEqual([]);
    expect(by.get('row_claimed')!.passport?.weight).toBe(7);                           // строке objects — паспорт её модели
    expect(by.get('row_claimed')!.implicit).toBeUndefined();
  });

  it('спеки: строка главнее паспорта (поля строки, свой вес), паспорт даёт контексты, веса по комнатам и вес; выключенная строка выключает ключ', () => {
    const specs = decorSpecsFor(objects, [], 'crypt', art);
    expect(specs.map((s) => s.id)).toEqual(['row_claimed', 'byid', 'row_plain', 'empty', 'insert', 'table', 'torch2']);   // без чужого биома и без биома
    const by = new Map(specs.map((s) => [s.id, s]));
    expect(by.get('row_claimed')).toMatchObject({ footprint: { w: 1, h: 1 }, blocks: true, spawnChance: 0.2, weight: 7, contexts: ['floor'], rooms: { small: 2 } });
    expect(by.get('row_plain')).toMatchObject({ weight: 3, collider: { shape: 'circle', r: 0.3 } });   // свой вес строки; коллайдер манифеста
    expect(by.get('row_plain')!.contexts).toBeUndefined();                                             // без паспорта — как прежде
    expect(by.get('table')).toMatchObject({ weight: 0.5, spawnChance: 1, clearance: 1, collider: { shape: 'box', w: 1.4, h: 3 }, implicit: true });
    expect(by.get('byid')!.contexts, 'строка с id ключа, но другой моделью — ключ занят, паспорта нет').toBeUndefined();
    expect(decorSpecsFor(objects, [], 'caves', art).map((s) => s.id)).toEqual(['mixed']);
    expect(decorSpecsFor(objects, [], undefined, art).map((s) => s.id)).toEqual(['row_claimed', 'byid', 'row_plain', 'empty', 'insert', 'mixed', 'table', 'torch2']);   // все биомы — кроме объекта без биома
    // без паспортов спеки те же, что прежде: вес 1, ни контекстов, ни весов по комнатам
    for (const s of decorSpecsFor(reg.get('objects'), reg.get('models'), 'crypt', reg.get('art').map(({ decor: _d, ...a }) => a))) {
      expect(s.weight).toBe(1); expect(s.contexts).toBeUndefined(); expect(s.rooms).toBeUndefined();
    }
  });

  it('G15: роль decor, паспорт без биома и без контекстов — предупреждения; живой конфиг чист', () => {
    const w = decorWarnings([...objects, obj('ghost', 'x', { role: 'decor' })], art);
    expect(w.map((x) => `${x.section}:${x.id}`).sort()).toEqual(['art:empty', 'art:nobiome', 'objects:ghost']);
    expect(decorWarnings(reg.get('objects'), reg.get('art'))).toEqual([]);
  });

  it('схема: имена контекстов — как у Unity; пустой паспорт — умолчания (контекст floor, след 1×1, веса 1); чужое имя — отказ', () => {
    expect(DECOR_CONTEXTS).toEqual(['floor', 'againstWall', 'wall', 'wallInsert', 'corner', 'doorFlank', 'doorway', 'socket', 'scatter']);
    expect(P({})).toEqual({
      contexts: ['floor'], footprint: { w: 1, h: 1 }, anchor: 'center', backOffset: 0, facing: 'quad', clearance: 0, keepPath: false, blocks: false,
      blocksSight: false, tall: false, tags: [], rooms: { small: 1, large: 1, treasure: 1, boss: 1, corridor: 1 }, weight: 1,
      variance: { yawJitterDeg: 0, scaleMin: 1, scaleMax: 1 }, biomes: [],
    });
    expect(artDecorSchema.safeParse({ contexts: ['onCeiling'] }).success).toBe(false);
  });
});

// ── расстановка Ф1 с паспортами ──────────────────────────────────────────────────────────────────────────────────────────
/** Синтетический этаж: стены, комнаты пола; спавн и выход — в первой комнате. */
function layout(cols: number, rows: number, rooms: Room[]): DungeonLayout {
  const grid: Grid = makeGrid(cols, rows, Cell.Wall);
  for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y]![x] = Cell.Floor;
  const c = { x: (rooms[0]!.x + 1) * TILE + 16, y: (rooms[0]!.y + 1) * TILE + 16 };
  return { grid, rooms, spawn: c, stairsDown: c, exits: [c], decor: [], doors: [], levers: [], chests: [] };
}
const spec = (id: string, s: Partial<DecorSpec>): DecorSpec =>
  ({ id, footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: false, blocksSight: false, ...s });
/** Место настенного пропа: клетка перед гранью (точка — на грани, лицо `rot` — в проход) → тип комнаты (первой по прямоугольнику) или коридор. */
function facePlace(L: DungeonLayout, d: { x: number; y: number; rot?: number }): string {
  const c = worldToCell(d.x + Math.round(Math.sin(d.rot ?? 0)) * 16, d.y + Math.round(Math.cos(d.rot ?? 0)) * 16);
  return L.rooms.find((r) => c.cx >= r.x && c.cx < r.x + r.w && c.cy >= r.y && c.cy < r.y + r.h)?.type ?? 'corridor';
}
/** Открытые грани стен этажа (как их обходит `placeWallProps`: стена с проходимой соседкой). */
function wallFaceCount(L: DungeonLayout): number {
  let n = 0;
  for (let y = 0; y < L.grid.length; y++) for (let x = 0; x < L.grid[0]!.length; x++) {
    if (L.grid[y]![x] !== Cell.Wall) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const c = L.grid[y + dz]?.[x + dx]; if (c !== undefined && c !== Cell.Wall) n++; }
  }
  return n;
}

/** Клетки, достижимые от спавна по маске навигации преград (`buildNavMask`, как путь монстров); двери проходимы. */
function reach(L: DungeonLayout, obstacles: Parameters<typeof buildNavMask>[2]): { seen: Uint8Array; cell: (x: number, y: number) => boolean } {
  const rows = L.grid.length, cols = L.grid[0]!.length;
  const mask = buildNavMask(cols, rows, obstacles);
  const bits = (x: number, y: number): number => mask?.bits[y * cols + x] ?? 0;
  const walk = (x: number, y: number): boolean => { const c = L.grid[y]?.[x]; return c !== undefined && c !== Cell.Wall && c !== Cell.Pillar; };
  const cell = (x: number, y: number): boolean => walk(x, y) && !(bits(x, y) & NAV_CELL);
  const seen = new Uint8Array(cols * rows);
  const s = worldToCell(L.spawn.x, L.spawn.y);
  const q: [number, number][] = [[s.cx, s.cy]];
  seen[s.cy * cols + s.cx] = 1;
  while (q.length) {
    const [x, y] = q.pop()!;
    const go = (nx: number, ny: number, blocked: boolean): void => {
      if (blocked || !cell(nx, ny) || seen[ny * cols + nx]) return;
      seen[ny * cols + nx] = 1; q.push([nx, ny]);
    };
    go(x + 1, y, !!(bits(x, y) & NAV_RIGHT));
    go(x - 1, y, x > 0 && !!(bits(x - 1, y) & NAV_RIGHT));
    go(x, y + 1, !!(bits(x, y) & NAV_DOWN));
    go(x, y - 1, y > 0 && !!(bits(x, y - 1) & NAV_DOWN));
  }
  return { seen, cell };
}
/** Клетки этажа, которые декор отрезал: достижимы без преград, не под преградой — и недостижимы с ними. */
function cutOff(L: DungeonLayout, specs: DecorSpec[]): string[] {
  const obstacles = obstaclesFromDecor(L.decor, new Map(specs.map((s) => [s.id, s])));
  const free = reach(L, []), withDecor = reach(L, obstacles);
  const cols = L.grid[0]!.length, out: string[] = [];
  for (let y = 0; y < L.grid.length; y++) for (let x = 0; x < cols; x++) {
    if (free.seen[y * cols + x] && withDecor.cell(x, y) && !withDecor.seen[y * cols + x]) out.push(`${x},${y}`);
  }
  return out;
}

describe('⭐ 12.10 (Ф1): расстановка прежними проходами — контексты, веса, повёрнутый след, проходимость', () => {
  it('G3: неквадратный след — в клетках с поворотом (`rotatedFootprint`), запись — в осях модели; следы не пересекаются и лежат на полу', () => {
    expect(rotatedFootprint({ w: 1, h: 3 }, 0)).toEqual({ w: 1, h: 3 });
    expect(rotatedFootprint({ w: 1, h: 3 }, Math.PI / 2)).toEqual({ w: 3, h: 1 });
    expect(rotatedFootprint({ w: 1, h: 3 }, Math.PI)).toEqual({ w: 1, h: 3 });
    expect(rotatedFootprint({ w: 1, h: 3 }, -Math.PI / 2)).toEqual({ w: 3, h: 1 });
    expect(rotatedFootprint({ w: 2, h: 2 }, Math.PI / 2)).toEqual({ w: 2, h: 2 });
    expect(footprintRect({ x: 5.5 * TILE, y: 5 * TILE, footprint: { w: 2, h: 3 }, rot: Math.PI / 2 })).toEqual({ x0: 4, y0: 4, x1: 6, y1: 5 });   // 2×3 лёжа — 3×2
    expect(footprintRect({ x: 5 * TILE, y: 5.5 * TILE, footprint: { w: 2, h: 3 }, rot: Math.PI })).toEqual({ x0: 4, y0: 4, x1: 5, y1: 6 });
    const PARAMS = { algorithm: 'rooms' as const, cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest' as const, shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0, largeRoomArea: 80 };
    const bench = spec('bench', { footprint: { w: 1, h: 3 }, contexts: ['floor'] });
    let turned = 0, upright = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const L = generateFloorParams(PARAMS, seed, { decorSpecs: [bench], decorPlace: { maxPerRoom: 6 } });
      const rects = L.decor.filter((d) => d.kind === 'obj').map((d) => {
        expect(d.footprint).toEqual({ w: 1, h: 3 });
        if (Math.abs(Math.sin(d.rot ?? 0)) > 0.5) turned++; else upright++;
        return footprintRect(d);
      });
      for (const r of rects) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) expect(L.grid[y]![x], `сид ${seed}: след на ${x},${y}`).toBe(Cell.Floor);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const p = rects[i]!, q = rects[j]!;
        expect(p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1, `сид ${seed}: следы пересеклись`).toBe(false);
      }
    }
    expect(turned).toBeGreaterThan(20);
    expect(upright).toBeGreaterThan(20);
  });

  it('контексты: россыпь пола — только `floor`, грани стен — только `wall`; у стены/угол/проём/сокет Ф1 не ставит', () => {
    const L0 = (): DungeonLayout => layout(30, 20, [{ x: 2, y: 2, w: 12, h: 10, type: 'large' }, { x: 16, y: 2, w: 10, h: 10, type: 'small' }]);
    const specs = [
      spec('rug', { contexts: ['floor'] }), spec('shelf', { contexts: ['againstWall'] }), spec('crate', { contexts: ['corner', 'againstWall'] }),
      spec('arch', { contexts: ['doorway'] }), spec('books', { contexts: ['socket'] }), spec('banner', { surface: 'wall', contexts: ['wall'] }),
      spec('insert', { surface: 'wall', contexts: ['wallInsert'] }),
      spec('banner_implicit', { surface: 'wall', contexts: ['wall'], implicit: true, blocks: true }),   // неявный настенный — граням без бюджета не дан
    ];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const L = L0();
      placeFloorDecor(L, specs, createRng(seed), { maxPerRoom: 6 });
      placeWallProps(L, specs, createRng(seed ^ 0x3a11));
      for (const d of L.decor) seen.add(d.objectId!);
    }
    expect([...seen].sort()).toEqual(['banner', 'rug']);
  });

  it('грани стен (ревью 12.10): неявный объект — ни на одной грани; строка objects — своей частотой и с весами паспорта по месту грани', () => {
    // две комнаты и коридор между ними (клетки пола вне прямоугольников комнат)
    const mk = (): DungeonLayout => {
      const L = layout(34, 16, [{ x: 2, y: 2, w: 10, h: 10, type: 'large' }, { x: 20, y: 2, w: 10, h: 10, type: 'small' }]);
      for (let x = 12; x < 20; x++) L.grid[6]![x] = Cell.Floor;
      return L;
    };
    const total = wallFaceCount(mk()) * 40;
    const run = (s: DecorSpec): Map<string, number> => {
      const got = new Map<string, number>();
      for (let seed = 1; seed <= 40; seed++) {
        const L = mk();
        placeWallProps(L, [s], createRng(seed));
        for (const d of L.decor) { const k = facePlace(L, d); got.set(k, (got.get(k) ?? 0) + 1); }
      }
      return got;
    };
    const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
    // неявный (частота 1, без бюджета граней) — ни одной грани: ждёт слотов стены Ф2
    expect(sum(run(spec('ban_i', { surface: 'wall', contexts: ['wall'], implicit: true, blocks: true })))).toBe(0);
    // строка objects с паспортом: своя частота 0.35 — доля граней около неё, коридор 0 — ни одной в коридоре
    const row = run(spec('ban', { surface: 'wall', contexts: ['wall'], spawnChance: 0.35, rooms: { small: 1, large: 1, treasure: 1, boss: 1, corridor: 0 } }));
    expect(row.get('corridor') ?? 0).toBe(0);
    expect(sum(row) / total).toBeGreaterThan(0.15);
    expect(sum(row) / total).toBeLessThan(0.45);
    // маленькая комната 0 — не в ней; коридор 1 — в коридоре есть
    const big = run(spec('ban', { surface: 'wall', contexts: ['wall'], spawnChance: 0.35, rooms: { small: 0, large: 1, treasure: 1, boss: 1, corridor: 1 } }));
    expect(big.get('small') ?? 0).toBe(0);
    expect(big.get('corridor') ?? 0).toBeGreaterThan(0);
    // без паспорта — как прежде: и в коридоре, и в обеих комнатах (место не считается вовсе)
    const plain = run(spec('ban', { surface: 'wall', spawnChance: 0.35 }));
    for (const k of ['corridor', 'small', 'large']) expect(plain.get(k) ?? 0, k).toBeGreaterThan(0);
  });

  it('G2: вес 0 — никогда; множитель комнаты 0 — не в этой комнате; вес из конфига смещает выбор', () => {
    const L0 = (): DungeonLayout => layout(40, 16, [{ x: 2, y: 2, w: 16, h: 12, type: 'large' }, { x: 21, y: 2, w: 16, h: 12, type: 'small' }]);
    const specs = [
      spec('never', { weight: 0 }), spec('bigOnly', { rooms: { small: 0 } }), spec('heavy', { weight: 9 }),
    ];
    const count = new Map<string, number>();
    for (let seed = 1; seed <= 60; seed++) {
      const L = L0();
      placeFloorDecor(L, specs, createRng(seed), { maxPerRoom: 4 });
      for (const d of L.decor) {
        count.set(d.objectId!, (count.get(d.objectId!) ?? 0) + 1);
        if (d.objectId === 'bigOnly') expect(worldToCell(d.x, d.y).cx < 20, 'bigOnly в маленькой комнате').toBe(true);
      }
    }
    expect(count.get('never') ?? 0).toBe(0);
    expect(count.get('bigOnly') ?? 0).toBeGreaterThan(0);
    expect(count.get('heavy')!).toBeGreaterThan((count.get('bigOnly') ?? 0) * 3);
  });

  it('G11: преграждающая россыпь не отрезает ни клетки — даже в узкой комнате-«Г», где стол раньше перегораживал рукав', () => {
    const table = spec('table', { footprint: { w: 3, h: 2 }, blocks: true, collider: { shape: 'box', w: 3, h: 2 } });
    // «Г»: широкая часть 8 × 6 и рукав в 3 клетки — ровно по ширине стола; одна комната (её прямоугольник шире пола)
    const ell = (): DungeonLayout => {
      const L = layout(24, 20, [{ x: 2, y: 2, w: 8, h: 6, type: 'large' }, { x: 2, y: 8, w: 3, h: 10, type: 'large' }]);
      L.rooms = [{ x: 2, y: 2, w: 8, h: 16, type: 'large' }];
      return L;
    };
    // зубы сторожа: стол поперёк рукава (так его ставило правило «на клетку от стен») — низ рукава отрезан
    const bad = ell();
    bad.decor.push({ x: 3.5 * TILE, y: 13 * TILE, kind: 'obj', objectId: 'table', rot: 0, footprint: { w: 3, h: 2 } });
    expect(cutOff(bad, [table]).length).toBeGreaterThan(5);
    let placed = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const L = ell();
      placeFloorDecor(L, [table], createRng(seed), { maxPerRoom: 8, areaPerSlot: 4 });
      placed += L.decor.length;
      expect(cutOff(L, [table]), `сид ${seed}`).toEqual([]);
    }
    expect(placed).toBeGreaterThan(40);
  });
});

/** Паспорта первых пропов крипты — как семя Unity (`Assets/DM/Art/Editor/decor_seed.json`); след — по габариту манифеста (⌈размер − 0.1⌉). */
const SEED: Record<string, Partial<ArtDecor>> = {
  crypt_wooden_shelf_01: { contexts: ['againstWall'], anchor: 'back', backOffset: 0.25, facing: 'room', keepPath: true, blocks: true, blocksSight: true, tall: true, tags: ['furniture', 'storage'], rooms: { small: 1, large: 1, treasure: 1, boss: 0, corridor: 0 } },
  crypt_wooden_table_3x_01: { contexts: ['floor', 'againstWall'], clearance: 1, keepPath: true, blocks: true, tags: ['furniture', 'table'], rooms: { small: 0, large: 1, treasure: 0.5, boss: 0, corridor: 0 } },
  crypt_wooden_table_2x_01: { contexts: ['againstWall', 'floor'], facing: 'along', clearance: 1, keepPath: true, blocks: true, tags: ['furniture', 'table'], rooms: { small: 1, large: 1, treasure: 0.5, boss: 0, corridor: 0 } },
  crypt_wooden_chair_01: { contexts: ['floor'], blocks: true, weight: 0.3, tags: ['furniture', 'seat'], rooms: { small: 1, large: 1, treasure: 0, boss: 0, corridor: 0 } },
  crypt_wooden_stool_01: { contexts: ['floor'], facing: 'free', blocks: true, weight: 0.3, tags: ['furniture', 'seat'], rooms: { small: 1, large: 1, treasure: 0, boss: 0, corridor: 0 } },
  crypt_wooden_crate_01: { contexts: ['corner', 'againstWall'], keepPath: true, blocks: true, stack: { max: 3 }, tags: ['storage', 'crate'], rooms: { small: 1, large: 1, treasure: 1.5, boss: 0, corridor: 0 } },
  crypt_wooden_crate_02: { contexts: ['corner', 'againstWall'], keepPath: true, blocks: true, stack: { max: 3 }, tags: ['storage', 'crate'], rooms: { small: 1, large: 1, treasure: 1.5, boss: 0, corridor: 0 } },
  crypt_stone_01: { contexts: ['corner', 'againstWall', 'floor'], keepPath: true, blocks: true, weight: 0.6, tags: ['rubble'], rooms: { small: 1, large: 1, treasure: 0.5, boss: 1, corridor: 0 } },
  crypt_stone_02: { contexts: ['corner', 'againstWall', 'floor'], keepPath: true, blocks: true, weight: 0.6, tags: ['rubble'], rooms: { small: 1, large: 1, treasure: 0.5, boss: 1, corridor: 0 } },
  crypt_arch_01: { contexts: ['doorway'], facing: 'room', doorway: { width: 3 }, tall: true, tags: ['arch', 'frame'] },
  crypt_arch_04: { contexts: ['doorway'], facing: 'room', doorway: { width: 4 }, tall: true, tags: ['arch', 'frame'] },
  crypt_books_01: { contexts: ['socket'], anchor: 'back', backOffset: 0.25, facing: 'room', hosts: ['crypt_wooden_shelf_01'], tall: true, tags: ['clutter', 'books'] },
};
/** Живой конфиг с паспортами семени в манифесте — через настоящий загрузчик (`reload`: схема и перекрёстные правила, как файл с диска).
 *  `extra` — паспорта сверх семени (ключ → поля), `rows` — строки `objects` сверх живых. */
function withSeed(extra: Record<string, Partial<ArtDecor>> = {}, rows: Record<string, unknown>[] = []): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  const seed = { ...SEED, ...extra };
  const art = structuredClone(r.get('art')).map((a) => {
    const s = seed[a.id];
    if (!s || a.kind === 'material' || !a.bounds) return a;
    const fp = { w: Math.max(1, Math.ceil(a.bounds.max[0]! - a.bounds.min[0]! - 0.1 - 1e-4)), h: Math.max(1, Math.ceil(a.bounds.max[2]! - a.bounds.min[2]! - 0.1 - 1e-4)) };
    return { ...a, decor: { ...s, footprint: fp } };
  });
  if (rows.length) r.reload({ art, objects: [...structuredClone(r.get('objects')), ...rows] as never });
  else r.reload({ art });
  return r;
}

describe('⭐ 12.10 (Ф1): живые этажи крипты с паспортами семени Unity', () => {
  const r = withSeed();
  const biome = r.get('biomes').find((b) => b.id === 'crypt')!;
  const floors = r.get('floors').filter((f) => f.biomeId === 'crypt' && f.role !== 'rest');
  const runs: { L: DungeonLayout; specs: DecorSpec[]; obstacles: ReturnType<typeof obstaclesFromDecor> }[] = [];
  for (const f of floors) for (let seed = 1; seed <= 12; seed++) {
    const spec = resolveFloorSpec(biome, f as Floor, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) });
    const g = generateFloorFor(r, spec, biome);
    runs.push({ L: g.layout, specs: g.inputs.decorSpecs, obstacles: g.obstacles });
  }

  it('паспорта проходят загрузчик; неявные объекты — 12 ключей семени (без сундука и arch_02); следы — по габариту', () => {
    const imp = decorSpecsFor(r.get('objects'), r.get('models'), 'crypt', r.get('art')).filter((s) => s.implicit);
    expect(imp.map((s) => s.id).sort()).toEqual(Object.keys(SEED).sort());
    const fp = new Map(imp.map((s) => [s.id, `${s.footprint.w}×${s.footprint.h}`]));
    expect(Object.fromEntries(fp)).toMatchObject({
      crypt_wooden_table_3x_01: '2×3', crypt_wooden_table_2x_01: '1×2', crypt_wooden_shelf_01: '2×1', crypt_stone_01: '2×1', crypt_stone_02: '2×2',
      crypt_wooden_chair_01: '1×1', crypt_wooden_crate_01: '1×1', crypt_arch_01: '3×1', crypt_arch_04: '4×1', crypt_books_01: '2×1',
    });
    expect(decorWarnings(r.get('objects'), r.get('art'))).toEqual([]);
    // спеки — те же у сервера и редактора (`floorInputs`): плотность из data, оформление крипты
    const inp = floorInputs(r, biome);
    expect(inp.decorPlace).toEqual({ chancePerRoom: 1, maxPerRoom: 2, areaPerSlot: 60 });
    expect(inp.dressing?.rules).toBe(biome.dressing);
  });

  it('порядок строк манифеста не важен: экспорт Unity их переставляет — неявные по ключу, спеки и этажи те же', () => {
    const shuffled = withSeed();
    shuffled.reload({ art: [...structuredClone(shuffled.get('art'))].reverse() });
    const ids = (cfg: ConfigRegistry): string[] => decorSpecsFor(cfg.get('objects'), cfg.get('models'), 'crypt', cfg.get('art')).map((s) => s.id);
    expect(ids(shuffled)).toEqual(ids(r));
    const imp = decorSpecsFor(r.get('objects'), r.get('models'), 'crypt', r.get('art')).filter((s) => s.implicit).map((s) => s.id);
    expect(imp).toEqual([...imp].sort());
    const digest = (cfg: ConfigRegistry): string[] => floors.slice(0, 4).flatMap((f) => [1, 2, 3].map((seed) => {
      const g = generateFloorFor(cfg, resolveFloorSpec(biome, f as Floor, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 }), biome);
      return createHash('sha256').update(JSON.stringify({ d: g.layout.decor, o: g.obstacles })).digest('hex').slice(0, 16);
    }));
    expect(digest(shuffled)).toEqual(digest(r));
  });

  it('ставятся только пропы с контекстом floor; не в коридорах и не в чужих типах комнат; этаж проходим, декор не отрезает ни клетки', () => {
    const floorCtx = new Set(Object.entries(SEED).filter(([, s]) => s.contexts?.includes('floor')).map(([k]) => k));
    const placed = new Map<string, number>();
    for (const { L, specs } of runs) {
      expect(validate(L)).toBe(true);
      for (const d of L.decor) {
        if (d.kind !== 'obj' || !d.objectId || !SEED[d.objectId]) continue;
        expect(floorCtx.has(d.objectId), `${d.objectId} — без контекста floor`).toBe(true);
        placed.set(d.objectId, (placed.get(d.objectId) ?? 0) + 1);
        const c = worldToCell(d.x, d.y);
        const room = L.rooms.find((q) => c.cx >= q.x && c.cx < q.x + q.w && c.cy >= q.y && c.cy < q.y + q.h);
        expect(room, `${d.objectId} вне комнаты`).toBeDefined();
        expect(SEED[d.objectId]!.rooms?.[room!.type as 'small'] ?? 1, `${d.objectId} в комнате ${room!.type}`).toBeGreaterThan(0);
      }
      expect(cutOff(L, specs)).toEqual([]);
    }
    expect(placed.get('crypt_wooden_table_3x_01') ?? 0).toBeGreaterThan(0);
    expect(placed.get('crypt_wooden_table_2x_01') ?? 0).toBeGreaterThan(0);
    expect(placed.get('crypt_stone_02') ?? 0).toBeGreaterThan(0);
  });

  it('ревью 12.10: настенный паспорт без строки objects — ни одной грани (было 82 % граней, коридоры тоже); со строкой — её частота, коридор 0 соблюдён', () => {
    // проба ревью: ключ окружения крипты без строки и без паспорта семени (`crypt_arch_02`) получает паспорт «на стене, преграда»
    const wallKey = 'crypt_arch_02';
    expect(r.get('objects').some((o) => o.id === wallKey || o.modelId === wallKey), 'ключ пробы без строки objects').toBe(false);
    const passport: Partial<ArtDecor> = { contexts: ['wall'], blocks: true, rooms: { small: 1, large: 1, treasure: 1, boss: 1, corridor: 0 } };
    const floorsOf = (cfg: ConfigRegistry): DungeonLayout[] => {
      const b = cfg.get('biomes').find((x) => x.id === 'crypt')!;
      const out: DungeonLayout[] = [];
      for (const f of cfg.get('floors').filter((x) => x.biomeId === 'crypt' && x.role !== 'rest')) for (let seed = 1; seed <= 5; seed++) {
        out.push(generateFloorFor(cfg, resolveFloorSpec(b, f as Floor, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) }), b).layout);
      }
      return out;
    };
    const implicitCfg = withSeed({ [wallKey]: passport });
    expect(decorSpecsFor(implicitCfg.get('objects'), implicitCfg.get('models'), 'crypt', implicitCfg.get('art')).find((s) => s.id === wallKey))
      .toMatchObject({ implicit: true, surface: 'wall', blocks: true });   // объект есть (кит Unity его знает) …
    for (const L of floorsOf(implicitCfg)) expect(L.decor.filter((d) => d.objectId === wallKey)).toEqual([]);   // … но на грани не ставится
    // та же модель строкой objects (настенная, частота 0.1): ставится, но не в коридорах (вес паспорта `corridor: 0`) и не гуще своей частоты
    const torch = structuredClone(r.get('objects').find((o) => o.id === 'crypt_wall_torch_01')!) as Record<string, unknown>;
    delete torch.fx; delete torch.light;
    const rowCfg = withSeed({ [wallKey]: passport }, [{ ...torch, id: 'row_arch_wall', name: 'проба ревью', modelId: wallKey, spawnChance: 0.1 }]);
    let placed = 0, open = 0;
    for (const L of floorsOf(rowCfg)) {
      open += wallFaceCount(L);
      for (const d of L.decor) {
        if (d.objectId !== 'row_arch_wall') continue;
        placed++;
        expect(facePlace(L, d), `грань у ${d.x},${d.y}`).not.toBe('corridor');
      }
    }
    expect(placed).toBeGreaterThan(0);
    expect(placed / open).toBeLessThan(0.1);
  });

  it('сундуки, выходы, рычаги и спавн — не под преградой паспорта; монстры не заселены в стол', () => {
    for (const { L, obstacles } of runs) {
      const reachable = reach(L, obstacles);
      const cols = L.grid[0]!.length;
      for (const p of [L.spawn, ...L.exits, ...L.levers, ...L.chests]) {
        const c = worldToCell(p.x, p.y);
        expect(reachable.seen[c.cy * cols + c.cx], `точка ${c.cx},${c.cy} недостижима`).toBe(1);
      }
    }
  });
});

describe('⭐ 12.10 (Ф1): игровая ревизия — паспорт игра, разброс картинка', () => {
  it('новый паспорт и правка контекстов сдвигают игровую ревизию; правка разброса `variance` — нет (полная — да); вес объекта — игра', () => {
    const fresh = withSeed();
    const game = fresh.gameRevision(), full = fresh.revision();
    const edit = (f: (t: unknown) => void, k: 'art' | 'objects' = 'art'): ConfigRegistry => {
      const x = withSeed(); const t = structuredClone(x.get(k)); f(t); x.reload(k === 'art' ? { art: t } : { objects: t }); return x;
    };
    const vis = edit((t) => { const a = (t as { id: string; decor?: ArtDecor }[]).find((x) => x.decor)!; a.decor!.variance = { yawJitterDeg: 33, scaleMin: 0.9, scaleMax: 1.1 }; });
    expect(vis.gameRevision()).toBe(game);
    expect(vis.revision()).not.toBe(full);
    const ctx = edit((t) => { const a = (t as { id: string; decor?: ArtDecor }[]).find((x) => x.decor)!; a.decor!.contexts = ['corner']; });
    expect(ctx.gameRevision()).not.toBe(game);
    const bare = withSeed(); bare.reload({ art: bare.get('art').map(({ decor: _d, ...a }) => a) });
    expect(bare.gameRevision(), 'без паспортов — другая игровая ревизия').not.toBe(game);
    const plain = new ConfigRegistry(); plain.loadAll(); plain.reload({ art: plain.get('art').map(({ decor: _d, ...a }) => a) });
    expect(bare.gameRevision(), 'манифест без паспортов — та же ревизия, что у живого конфига без них').toBe(plain.gameRevision());
    const w = edit((t) => { (t as { weight?: number }[])[0]!.weight = 2; }, 'objects');
    expect(w.gameRevision()).not.toBe(game);
  });
});
