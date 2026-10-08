import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { biomeDressingSchema, type BiomeDressing } from '../config/schemas.js';
import { createRng } from '../formulas/rng.js';
import { Cell, TILE, makeGrid, worldToCell, type Grid } from '../world/grid.js';
import { pushOutObstacle } from '../world/movement.js';
import { validate, type DecorObject, type DungeonLayout, type Room } from './floorCommon.js';
import { decorSpecsFor, footprintRect, obstaclesFromDecor, type DecorSpec } from './decor.js';
import { dressingObjectIds, dressingOf, dressingWarnings, isFarFace, placeDressing, toCameraXY, wallRuns, type DressingOpts } from './dressing.js';
import { generateFloor, generateFloorParams } from './generateFloor.js';
import { resolveFloorSpec } from './floorSpec.js';
import { spawnPacksEl } from './floor.js';

/**
 * ⭐ 08.10: оформление биома по правилу (`dressing.ts`) — факелы с шагом, ниши дальних стен, костры. Сторожа: знак «дальней» стены
 * (тот же, что у камеры и фейда стен), правила шага/отступа/косяков, ниши только на дальних гранях с факелами по бокам, костры в центре
 * больших комнат, проходимость и преграды; биомы без оформления — байт-в-байт прежние.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const balance = reg.get('balance');
const crypt = reg.get('biomes').find((b) => b.id === 'crypt')!;
const TORCH = 'crypt_wall_torch_01';

/** Точка грани в мире — как у `placeWallProps`/`placeDressing`. */
const facePt = (x: number, y: number, dx: number, dz: number): { x: number; y: number } => ({ x: x * TILE + 16 + dx * 16, y: y * TILE + 16 + dz * 16 });
/** Грань настенного объекта по его точке и повороту: обратная к `facePt` + `rot = atan2(dx, dz)`. */
function faceOf(d: DecorObject): [number, number, number, number] {
  const dx = Math.round(Math.sin(d.rot ?? 0)), dz = Math.round(Math.cos(d.rot ?? 0));
  return [Math.round((d.x - 16 - dx * 16) / TILE), Math.round((d.y - 16 - dz * 16) / TILE), dx, dz];
}

/** Синтетический этаж: стены, вырезанные прямоугольники пола, комнаты; спавн/выход — в первой комнате. */
function layout(cols: number, rows: number, rooms: Room[], extraFloor: [number, number, number, number][] = []): DungeonLayout {
  const grid: Grid = makeGrid(cols, rows, Cell.Wall);
  for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y]![x] = Cell.Floor;
  for (const [x0, y0, w, h] of extraFloor) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) grid[y]![x] = Cell.Floor;
  const c = { x: (rooms[0]!.x + 1) * TILE + 16, y: (rooms[0]!.y + 1) * TILE + 16 };
  return { grid, rooms, spawn: c, stairsDown: c, exits: [c], decor: [], doors: [], levers: [], chests: [] };
}
const opts = (rules: BiomeDressing, camAzimuthDeg = -45): DressingOpts => ({ rules, camAzimuthDeg });
const torchRule = { objectId: TORCH, spacing: 3, cornerGap: 1, corridorSpacing: 6 };
const torchesOf = (L: DungeonLayout): DecorObject[] => L.decor.filter((d) => d.objectId === TORCH);

describe('⭐ 08.10: дальняя стена — знак от азимута камеры', () => {
  it('азимут −45°: камера на (−x, +y) от героя; дальние грани — лицом к ней (север n=(0,+1), восток n=(−1,0))', () => {
    // Камера: веб `placeCamera` и Unity `CameraRig.Place` ставят её в target + hor·(sin az, cos az) мира сервера (x — столбец, y — строка).
    const t = toCameraXY(-45);
    expect(t.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(t.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(isFarFace(0, 1, t)).toBe(true);    // стена на строке ВЫШЕ комнаты, лицом вниз — к камере
    expect(isFarFace(-1, 0, t)).toBe(true);   // стена СПРАВА от комнаты, лицом влево — к камере
    expect(isFarFace(0, -1, t)).toBe(false);
    expect(isFarFace(1, 0, t)).toBe(false);
  });

  it('дальняя грань дальше от камеры, чем противоположная; фейд стен (WallFadeRules / шейдер веба) снимает только ближние', () => {
    const room = { x: 10, y: 10, w: 8, h: 6 };
    for (const az of [-45, -10, 30, 100, 170, -135]) {
      const t = toCameraXY(az);
      const hero = { x: (room.x + room.w / 2) * TILE, y: (room.y + room.h / 2) * TILE };
      const cam = { x: hero.x + t.x * 400, y: hero.y + t.y * 400 };
      const view = { x: hero.x - cam.x, y: hero.y - cam.y };   // взгляд камера→герой (`viewDir`, `FadeAmount` vx/vz)
      // Середины четырёх стен комнаты и нормали их граней (в комнату).
      const walls: [number, number, number, number][] = [
        [hero.x, room.y * TILE, 0, 1], [hero.x, (room.y + room.h) * TILE, 0, -1],
        [room.x * TILE, hero.y, 1, 0], [(room.x + room.w) * TILE, hero.y, -1, 0],
      ];
      for (const [wx, wy, dx, dz] of walls) {
        const opp = walls.find((w) => w[2] === -dx && w[3] === -dz)!;
        const d = Math.hypot(wx - cam.x, wy - cam.y), dOpp = Math.hypot(opp[0] - cam.x, opp[1] - cam.y);
        const fades = dx * view.x + dz * view.y > 0;   // ближняя: лицо смотрит ОТ камеры
        if (isFarFace(dx, dz, t)) {
          expect(d, `az ${az}: дальняя (${dx},${dz}) дальше противоположной`).toBeGreaterThan(dOpp);
          expect(fades, `az ${az}: дальняя (${dx},${dz}) не тает`).toBe(false);
        }
      }
    }
  });

  it('dressingOf: азимут — из balance.camera; биом без оформления — undefined', () => {
    expect(dressingOf(crypt, balance)?.camAzimuthDeg).toBe(balance.camera.azimuthDeg);
    for (const b of reg.get('biomes').filter((x) => x.id !== 'crypt')) expect(dressingOf(b, balance)).toBeUndefined();
  });
});

describe('⭐ 08.10: конфиг оформления крипты', () => {
  it('значения — в data/biomes.json; объекты есть в objects и выпадают из случайной россыпи', () => {
    const d = crypt.dressing!;
    expect(d.torch).toEqual(torchRule);
    expect(d.statues).toEqual({ objectIds: ['crypt_wall_statue_01', 'crypt_wall_statue_02', 'crypt_wall_statue_03', 'crypt_wall_statue_04'], min: 1, max: 2, corridorChance: 0.15, width: 2 });
    expect(d.firePits).toEqual({ objectIds: ['crypt_fire_pit_01', 'crypt_fire_pit_02'], minRoom: 7, chance: 0.6 });
    const objs = new Map(reg.get('objects').map((o) => [o.id, o]));
    for (const id of dressingObjectIds(d)) expect(objs.get(id)?.biomes, id).toContain('crypt');
    expect(objs.get('crypt_wall_statue_01')).toMatchObject({ role: 'prop', surface: 'wall', blocks: true, footprint: { w: 2, h: 1 }, collider: { shape: 'box', w: 2, h: 0.45 }, spawnChance: 0 });
    expect(objs.get('crypt_fire_pit_01')).toMatchObject({ role: 'prop', surface: 'floor', blocks: true, footprint: { w: 2, h: 2 }, collider: { shape: 'circle', r: 0.9 }, light: { color: '#ff9739', intensity: 6000, distance: 640, flicker: true } });
    expect(objs.get(TORCH)?.light).toEqual({ color: '#ffa860', intensity: 2000, distance: 640, flicker: true });
  });

  it('схема: max статуй меньше min — отказ; пустые правила — можно', () => {
    expect(biomeDressingSchema.safeParse({ statues: { objectIds: ['a'], min: 3, max: 1 } }).success).toBe(false);
    expect(biomeDressingSchema.safeParse({}).success).toBe(true);
  });
});

describe('⭐ 08.10: факелы по правилу', () => {
  it('эталонная комната 20×10: факел каждые 3 грани, не ближе cornerGap к углу, узор по центру', () => {
    const L = layout(26, 16, [{ x: 2, y: 2, w: 20, h: 10, type: 'large' }]);
    placeDressing(L, opts({ torch: torchRule }), createRng(1));
    const byFace = new Set(torchesOf(L).map((d) => faceOf(d).join(',')));
    // север (стена y=1, лицом вниз): грани x=2..21 → индексы 2,5,…,17 → x = 4,7,10,13,16,19
    for (const x of [4, 7, 10, 13, 16, 19]) expect(byFace.has(`${x},1,0,1`), `север x=${x}`).toBe(true);
    // запад (стена x=1, лицом вправо): грани y=2..11 → a=1,b=8, k=3, индексы 1,4,7 → y = 3,6,9
    for (const y of [3, 6, 9]) expect(byFace.has(`1,${y},1,0`), `запад y=${y}`).toBe(true);
    expect(torchesOf(L).length).toBe(6 * 2 + 3 * 2);
    for (const d of torchesOf(L)) expect(d).toMatchObject({ kind: 'obj', footprint: { w: 1, h: 1 } });
  });

  it('на каждом пробеге: соседние факелы — от spacing до 2·spacing−1, у концов — не ближе cornerGap; короткая стена комнаты — хоть один', () => {
    for (const [w, h] of [[3, 3], [4, 7], [5, 9], [11, 6], [16, 13]] as const) {
      const L = layout(w + 4, h + 4, [{ x: 2, y: 2, w, h, type: 'small' }]);
      placeDressing(L, opts({ torch: torchRule }), createRng(1));
      const lit = new Set(torchesOf(L).map((d) => faceOf(d).join(',')));
      for (const r of wallRuns(L)) {
        const idx = r.faces.map((f, i) => (lit.has(`${f.x},${f.y},${f.dx},${f.dz}`) ? i : -1)).filter((i) => i >= 0);
        if (r.faces.length >= 3) expect(idx.length, `комната ${w}×${h}, пробег ${r.faces.length}`).toBeGreaterThan(0);
        for (const i of idx) { expect(i).toBeGreaterThanOrEqual(1); expect(i).toBeLessThanOrEqual(r.faces.length - 2); }
        for (let k = 1; k < idx.length; k++) { expect(idx[k]! - idx[k - 1]!).toBeGreaterThanOrEqual(3); expect(idx[k]! - idx[k - 1]!).toBeLessThanOrEqual(5); }
      }
    }
  });

  it('косяк двери — не грань, рвёт пробег; у проёма отступ cornerGap', () => {
    const L = layout(26, 16, [{ x: 2, y: 2, w: 20, h: 10, type: 'large' }], [[10, 0, 2, 2]]);
    L.grid[1]![10] = Cell.Door; L.grid[1]![11] = Cell.Door;
    L.doors.push({ id: 1, cells: [{ cx: 10, cy: 1 }, { cx: 11, cy: 1 }] });
    placeDressing(L, opts({ torch: torchRule }), createRng(1));
    const faces = torchesOf(L).map(faceOf);
    for (const [x, y, dx, dz] of faces) {
      const o = L.grid[y + dz]![x + dx];
      expect(o, `факел ${x},${y} смотрит в дверь`).not.toBe(Cell.Door);
    }
    expect(faces.some(([x, y, dx, dz]) => y === 1 && dz === 1 && dx === 0 && (x === 9 || x === 12)), 'вплотную к проёму').toBe(false);
    const north = wallRuns(L).filter((r) => r.dz === 1 && r.faces[0]!.y === 1 && r.zone === 0);
    expect(north.map((r) => r.faces.length).sort((x, y) => x - y)).toEqual([8, 10]);   // x=2..9 и x=12..21
  });

  it('коридор: шаг corridorSpacing (только целый шаг), 0 — без факелов', () => {
    const rooms: Room[] = [{ x: 2, y: 2, w: 8, h: 8, type: 'small' }];
    const L = layout(40, 12, rooms, [[10, 5, 26, 2]]);   // коридор шириной 2 вдоль x, 26 клеток
    placeDressing(L, opts({ torch: torchRule }), createRng(1));
    const corridor = torchesOf(L).filter((d) => worldToCell(d.x, d.y).cx >= 11);
    expect(corridor.length).toBeGreaterThan(0);
    const north = corridor.filter((d) => faceOf(d)[1] === 4).map((d) => faceOf(d)[0]).sort((a, b) => a - b);
    for (let k = 1; k < north.length; k++) expect(north[k]! - north[k - 1]!).toBe(6);
    const L0 = layout(40, 12, rooms, [[10, 5, 26, 2]]);
    placeDressing(L0, opts({ torch: { ...torchRule, corridorSpacing: 0 } }), createRng(1));
    expect(torchesOf(L0).filter((d) => worldToCell(d.x, d.y).cx >= 11).length).toBe(0);
  });
});

describe('⭐ 08.10: статуи в нишах и костры (синтетика)', () => {
  const statues = { objectIds: ['st_a', 'st_b'], min: 2, max: 2, corridorChance: 0, width: 2 };
  it('ниши — только на дальних гранях, по центру пробега, с факелом по обе стороны; wallFaces — клетки-стены подряд', () => {
    for (const az of [-45, 45, 135, -135]) {
      const L = layout(26, 16, [{ x: 2, y: 2, w: 20, h: 10, type: 'large' }]);
      placeDressing(L, opts({ torch: torchRule, statues }, az), createRng(3));
      const st = L.decor.filter((d) => d.wallFaces);
      expect(st.length, `az ${az}: две дальние стены — две ниши`).toBe(2);
      const lit = new Set(torchesOf(L).map((d) => faceOf(d).join(',')));
      for (const s of st) {
        const f = s.wallFaces!;
        expect(f.length).toBe(2);
        const [dx, dz] = [f[0]![2], f[0]![3]];
        expect(isFarFace(dx, dz, toCameraXY(az)), `az ${az}: грань (${dx},${dz}) дальняя`).toBe(true);
        expect(s.rot).toBeCloseTo(Math.atan2(dx, dz), 12);
        expect(s.footprint).toEqual({ w: 2, h: 1 });
        for (const [cx, cy, ex, ez] of f) {
          expect(L.grid[cy]![cx]).toBe(Cell.Wall);
          expect(L.grid[cy + ez]![cx + ex]).not.toBe(Cell.Wall);
          expect([ex, ez]).toEqual([dx, dz]);
          expect(lit.has(`${cx},${cy},${ex},${ez}`), 'факел на месте ниши').toBe(false);
        }
        const tx = dz !== 0 ? 1 : 0, ty = dz !== 0 ? 0 : 1;
        expect([f[1]![0] - f[0]![0], f[1]![1] - f[0]![1]]).toEqual([tx, ty]);
        const p = [facePt(...f[0]!), facePt(...f[1]!)];
        expect(s.x).toBe((p[0]!.x + p[1]!.x) / 2); expect(s.y).toBe((p[0]!.y + p[1]!.y) / 2);
        expect(lit.has(`${f[0]![0] - tx},${f[0]![1] - ty},${dx},${dz}`), 'факел слева').toBe(true);
        expect(lit.has(`${f[1]![0] + tx},${f[1]![1] + ty},${dx},${dz}`), 'факел справа').toBe(true);
      }
    }
  });

  it('число ниш на комнату — в [min, max], пока хватает дальних пробегов; у двери/выхода/рычага ниши нет', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 30; seed++) {
      const L = layout(26, 16, [{ x: 2, y: 2, w: 20, h: 10, type: 'large' }]);
      placeDressing(L, opts({ torch: torchRule, statues: { ...statues, min: 1, max: 2 } }), createRng(seed));
      const n = L.decor.filter((d) => d.wallFaces).length;
      expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(2);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([1, 2]);
    // Выход у середины северной стены и дверь у середины восточной — обе дальние стены без ниш.
    const L = layout(26, 16, [{ x: 2, y: 2, w: 20, h: 10, type: 'large' }], [[22, 6, 2, 2]]);
    L.exits = [{ x: 12 * TILE + 16, y: 2 * TILE + 16 }];
    L.grid[6]![22] = Cell.Door; L.grid[7]![22] = Cell.Door;
    L.doors.push({ id: 1, cells: [{ cx: 22, cy: 6 }, { cx: 22, cy: 7 }] });
    placeDressing(L, opts({ torch: torchRule, statues }), createRng(1));
    expect(L.decor.filter((d) => d.wallFaces).length).toBe(0);
  });

  it('костёр — в центре большой не-входной комнаты, footprint и кольцо — пол без спавна/выхода/рычага; маленькая и вход — без', () => {
    const pits = { objectIds: ['pit'], minRoom: 7, chance: 1 };
    const rooms: Room[] = [{ x: 2, y: 2, w: 6, h: 6, type: 'entrance' }, { x: 10, y: 2, w: 9, h: 8, type: 'large' }, { x: 21, y: 2, w: 6, h: 9, type: 'small' }, { x: 2, y: 12, w: 10, h: 7, type: 'large' }];
    const L = layout(30, 21, rooms);
    const res = placeDressing(L, opts({ firePits: pits }), createRng(5));
    const pit = L.decor.filter((d) => d.objectId === 'pit');
    expect(pit.map((d) => [d.x / TILE, d.y / TILE])).toEqual([[14.5, 6], [7, 15.5]]);   // центры комнат 9×8 и 10×7
    for (const d of pit) expect(d.footprint).toEqual({ w: 2, h: 2 });
    expect(res.floorCells.has('14,5') && res.floorCells.has('15,6') && res.floorCells.has('13,6')).toBe(true);   // нечётная сторона — 3 клетки
    // Выход в центре — костра нет.
    const L2 = layout(30, 21, rooms);
    L2.exits = [{ x: 14 * TILE + 16, y: 5 * TILE + 16 }];
    placeDressing(L2, opts({ firePits: pits }), createRng(5));
    expect(L2.decor.filter((d) => d.objectId === 'pit').map((d) => d.x / TILE)).toEqual([7]);
  });

  it('пустые правила и объекты вне спек — ничего; спеки фильтруют выключенные/чужие объекты', () => {
    const L = layout(26, 16, [{ x: 2, y: 2, w: 20, h: 10, type: 'large' }]);
    placeDressing(L, opts({ torch: { ...torchRule, objectId: '' }, statues: { ...statues, objectIds: [] }, firePits: { objectIds: [], minRoom: 1, chance: 1 } }), createRng(1));
    expect(L.decor).toEqual([]);
    placeDressing(L, opts({ torch: torchRule, statues }), createRng(1), new Map<string, DecorSpec>());
    expect(L.decor).toEqual([]);
  });
});

/** Этажи крипты, как их собирает `Room.enterNode`: каждый этаж каждого типа × сиды. `objects` — подменить таблицу объектов (сторож отступа). */
function cryptFloors(seeds: number, objects = reg.get('objects')): { L: DungeonLayout; bare: DungeonLayout; specs: DecorSpec[] }[] {
  const specs = decorSpecsFor(objects, reg.get('models'), 'crypt', reg.get('art'));
  const chests = { tiers: reg.get('chests'), perFloor: balance.loot.chestsPerFloor };
  const out: { L: DungeonLayout; bare: DungeonLayout; specs: DecorSpec[] }[] = [];
  for (const f of reg.get('floors').filter((x) => x.biomeId === 'crypt' && x.role !== 'rest')) {
    for (let seed = 1; seed <= seeds; seed++) {
      const spec = resolveFloorSpec(crypt, f, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) });
      out.push({
        L: generateFloor(spec, reg.get('room-prefabs'), specs, undefined, chests, dressingOf(crypt, balance)),
        bare: generateFloor(spec, reg.get('room-prefabs'), specs, undefined, chests),
        specs,
      });
    }
  }
  return out;
}

describe('⭐ 08.10: этажи крипты целиком', () => {
  const floors = cryptFloors(12);
  const byId = new Map(floors[0]!.specs.map((s) => [s.id, s]));
  const statueIds = new Set(crypt.dressing!.statues!.objectIds);
  const pitIds = new Set(crypt.dressing!.firePits!.objectIds);

  it('детерминизм: тот же сид — тот же этаж', () => {
    const a = cryptFloors(3).map((x) => JSON.stringify(x.L));
    const b = cryptFloors(3).map((x) => JSON.stringify(x.L));
    expect(a).toEqual(b);
  });

  it('проходимость и геометрия — как без оформления: сетка, спавн, выходы, двери, рычаги, комнаты те же; validate()', () => {
    for (const { L, bare } of floors) {
      expect(validate(L)).toBe(true);
      expect(L.grid).toEqual(bare.grid);
      expect({ s: L.spawn, e: L.exits, d: L.doors, l: L.levers, r: L.rooms }).toEqual({ s: bare.spawn, e: bare.exits, d: bare.doors, l: bare.levers, r: bare.rooms });
      expect(L.decor.filter((d) => d.kind !== 'obj')).toEqual(bare.decor.filter((d) => d.kind !== 'obj'));
    }
  });

  it('статуи только на дальних гранях; факелы по бокам; грани оформления не пересекаются', () => {
    const t = toCameraXY(balance.camera.azimuthDeg);
    let statues = 0, torches = 0, pits = 0;
    for (const { L } of floors) {
      const used = new Map<string, string>();
      for (const d of L.decor) {
        if (d.objectId === TORCH) {
          torches++;
          const [x, y, dx, dz] = faceOf(d);
          expect(L.grid[y]![x]).toBe(Cell.Wall);
          expect(L.grid[y + dz]![x + dx]).not.toBe(Cell.Wall);
          expect(L.grid[y + dz]![x + dx]).not.toBe(Cell.Door);
          const k = `${x},${y},${dx},${dz}`; expect(used.has(k), `грань ${k} дважды`).toBe(false); used.set(k, 'torch');
        } else if (d.wallFaces) {
          statues++;
          expect(statueIds.has(d.objectId!)).toBe(true);
          for (const [x, y, dx, dz] of d.wallFaces) {
            expect(isFarFace(dx, dz, t)).toBe(true);
            expect(L.grid[y]![x]).toBe(Cell.Wall);
            const k = `${x},${y},${dx},${dz}`; expect(used.has(k), `грань ${k} дважды`).toBe(false); used.set(k, 'statue');
          }
        } else if (pitIds.has(d.objectId ?? '')) pits++;
      }
      for (const d of L.decor.filter((x) => x.wallFaces)) {
        const f = d.wallFaces!, [dx, dz] = [f[0]![2], f[0]![3]], tx = dz !== 0 ? 1 : 0, ty = dz !== 0 ? 0 : 1;
        expect(used.get(`${f[0]![0] - tx},${f[0]![1] - ty},${dx},${dz}`), 'факел слева от ниши').toBe('torch');
        const e = f[f.length - 1]!;
        expect(used.get(`${e[0] + tx},${e[1] + ty},${dx},${dz}`), 'факел справа от ниши').toBe('torch');
      }
      // ни одного случайного (россыпного) объекта оформления: каждый факел — на позиции правила (без соседей ближе шага)
      for (const r of wallRuns(L)) {
        const idx = r.faces.map((f, i) => (used.get(`${f.x},${f.y},${f.dx},${f.dz}`) === 'torch' ? i : -1)).filter((i) => i >= 0);
        for (let k = 1; k < idx.length; k++) expect(idx[k]! - idx[k - 1]!).toBeGreaterThanOrEqual(3);
      }
    }
    expect(statues).toBeGreaterThan(0); expect(torches).toBeGreaterThan(statues * 2); expect(pits).toBeGreaterThan(0);
  });

  it('костры — в центре комнат от minRoom, не у входа; сундуки и монстры не под костром; бокс ниши лежит вдоль стены', () => {
    let pitsSeen = 0, boxes = 0;
    for (const { L, specs } of floors) {
      const obst = obstaclesFromDecor(L.decor, new Map(specs.map((s) => [s.id, s])));
      for (const d of L.decor.filter((x) => pitIds.has(x.objectId ?? ''))) {
        pitsSeen++;
        const room = L.rooms.find((r) => d.x === (r.x + r.w / 2) * TILE && d.y === (r.y + r.h / 2) * TILE);
        expect(room, 'костёр в центре комнаты').toBeDefined();
        expect(Math.min(room!.w, room!.h)).toBeGreaterThanOrEqual(7);
        expect(room!.type).not.toBe('entrance');
        for (const p of [L.spawn, ...L.exits, ...L.levers]) expect(Math.hypot(p.x - d.x, p.y - d.y)).toBeGreaterThan(TILE);
      }
      const pitObst = obst.filter((o) => o.shape === 'circle' && L.decor.some((d) => pitIds.has(d.objectId ?? '') && d.x === o.x && d.y === o.y));
      for (const c of L.chests) for (const o of pitObst) expect(pushOutObstacle(c.x, c.y, TILE / 4, o), 'сундук под костром').toBeNull();
      const mons = spawnPacksEl(reg, L, 3, 'normal', createRng(7), 10, crypt.monsterPool, 1, 'crypt-halls');
      for (const m of mons) for (const o of pitObst) expect(pushOutObstacle(m.x, m.y, TILE / 4, o), 'монстр в костре').toBeNull();
      for (const d of L.decor.filter((x) => x.wallFaces)) {
        const o = obst.find((q) => q.x === d.x && q.y === d.y)!;
        expect(o.shape).toBe('box'); boxes++;
        const [, , dx, dz] = d.wallFaces![0]!;
        expect(Math.abs(Math.cos(o.yaw!) * dx + Math.sin(o.yaw!) * dz), 'длинная ось бокса — вдоль стены').toBeLessThan(1e-9);
        expect(o.hw).toBeCloseTo(TILE, 9); expect(o.hh).toBeCloseTo(0.225 * TILE, 9);
        for (const [cx, cy] of d.wallFaces!) {
          const fp = facePt(cx, cy, dx, dz);
          expect(pushOutObstacle(fp.x + dx * 2, fp.y + dz * 2, 0, o), 'перед нишей — преграда').not.toBeNull();
          expect(pushOutObstacle(fp.x + dx * 16, fp.y + dz * 16, TILE / 4, o), 'центр клетки перед нишей свободен').toBeNull();
        }
      }
    }
    expect(pitsSeen).toBeGreaterThan(0); expect(boxes).toBeGreaterThan(0);
  });
});

describe('⭐ 08.10: отступ напольного декора (`objects[].clearance`) на этажах крипты', () => {
  const types = reg.get('floors').filter((x) => x.biomeId === 'crypt' && x.role !== 'rest').length;
  const seeds = Math.ceil(200 / Math.max(1, types));
  const GRILLE = 'crypt_floor_grille_01';
  const pitIds = new Set(crypt.dressing!.firePits!.objectIds);
  /** Нарушения кольца в клетку: костёр/решётка и любой другой напольный декор (объект пола или точечный — портал, лавка). */
  function violations(L: DungeonLayout, specs: DecorSpec[]): string[] {
    const by = new Map(specs.map((s) => [s.id, s]));
    const floorDecor = L.decor.filter((d) => d.kind !== 'obj' || by.get(d.objectId ?? '')?.surface === 'floor');
    const out: string[] = [];
    for (const a of floorDecor.filter((d) => d.objectId === GRILLE || pitIds.has(d.objectId ?? ''))) {
      const p = footprintRect(a);
      for (const b of floorDecor) {
        if (b === a) continue;
        const q = footprintRect(b);
        if (p.x0 - 1 <= q.x1 && q.x0 <= p.x1 + 1 && p.y0 - 1 <= q.y1 && q.y0 <= p.y1 + 1) out.push(`${a.objectId} ${JSON.stringify(p)} ↔ ${b.objectId ?? b.kind} ${JSON.stringify(q)}`);
      }
    }
    return out;
  }

  it('костёр и решётка не касаются ни друг друга, ни прочего напольного декора (≥ 200 этажей); validate()', () => {
    const floors = cryptFloors(seeds);
    expect(floors.length).toBeGreaterThanOrEqual(200);
    let pits = 0, grilles = 0, both = 0;
    for (const { L, specs } of floors) {
      expect(validate(L)).toBe(true);
      expect(violations(L, specs)).toEqual([]);
      const np = L.decor.filter((d) => pitIds.has(d.objectId ?? '')).length, ng = L.decor.filter((d) => d.objectId === GRILLE).length;
      pits += np; grilles += ng; if (np && ng) both++;
    }
    expect(pits).toBeGreaterThan(50); expect(grilles).toBeGreaterThan(50); expect(both).toBeGreaterThan(20);
  });

  it('сторож сторожа: без отступа (clearance 0) решётка вставала вплотную к костру — то, что владелец видел на скриншоте', () => {
    const bare = reg.get('objects').map((o) => ({ ...o, clearance: 0 }));
    const bad = cryptFloors(seeds, bare).reduce((n, { L, specs }) => n + violations(L, specs).length, 0);
    expect(bad).toBeGreaterThan(0);
  });

  it('отступ — из конфига: костёр и решётка крипты — 1 клетка', () => {
    const o = new Map(reg.get('objects').map((x) => [x.id, x]));
    for (const id of [GRILLE, ...pitIds]) expect(o.get(id)?.clearance, id).toBe(1);
  });
});

describe('⭐ 08.10: предупреждение редактора — ширина ниши против модели статуи', () => {
  it('живой конфиг чист; ширина ниши ≠ габарит модели (манифест арта) — предупреждение; без габарита — не судим', () => {
    expect(dressingWarnings(reg.get('biomes'), reg.get('objects'), reg.get('art'))).toEqual([]);
    const wide = reg.get('biomes').map((b) => (b.dressing?.statues ? { ...b, dressing: { ...b.dressing, statues: { ...b.dressing.statues, width: 3 } } } : b));
    const w = dressingWarnings(wide, reg.get('objects'), reg.get('art'));
    const measured = reg.get('art').filter((a) => a.bounds && a.kind !== 'material' && crypt.dressing!.statues!.objectIds.includes(a.id)).length;
    expect(measured, 'в манифесте есть габарит хоть одной статуи').toBeGreaterThan(0);
    expect(w.length).toBe(measured);
    expect(w[0]!.biomeId).toBe('crypt');
    expect(w[0]!.msg).toContain('statues.width = 3');
    expect(dressingWarnings(wide, reg.get('objects'), [])).toEqual([]);
  });
});

describe('⭐ 08.10: биомы без оформления — байт-в-байт прежние', () => {
  it('каждый биом без dressing × каждый его этаж × 40 сидов: с опцией оформления этаж тот же, что без неё', () => {
    const chests = { tiers: reg.get('chests'), perFloor: balance.loot.chestsPerFloor };
    let n = 0;
    for (const b of reg.get('biomes').filter((x) => !x.dressing)) {
      const specs = decorSpecsFor(reg.get('objects'), reg.get('models'), b.id, reg.get('art'));
      for (const f of reg.get('floors').filter((x) => x.biomeId === b.id).slice(0, 2)) {
        for (let seed = 1; seed <= 40; seed++) {
          const spec = resolveFloorSpec(b, f, f.minDepth, seed, [], { exitCount: 1 });
          const a = generateFloor(spec, reg.get('room-prefabs'), specs, undefined, chests, dressingOf(b, balance));
          expect(JSON.stringify(a)).toBe(JSON.stringify(generateFloor(spec, reg.get('room-prefabs'), specs, undefined, chests)));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(3 * 40);
  });

  it('оформление без правил ничего не сдвигает: тот же этаж байт-в-байт (свой поток rng, россыпь та же)', () => {
    const PARAMS = { algorithm: 'rooms' as const, cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest' as const, shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0, largeRoomArea: 80 };
    const specs: DecorSpec[] = [
      { id: 'col', footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: true, blocksSight: true, collider: { shape: 'circle', r: 0.3 } },
      { id: 'banner', footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 0.2, surface: 'wall', coversFloor: false, blocks: false, blocksSight: false },
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const a = generateFloorParams(PARAMS, seed, { decorSpecs: specs, dressing: opts({}) });
      const b = generateFloorParams(PARAMS, seed, { decorSpecs: specs });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
