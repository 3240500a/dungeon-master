import { describe, it, expect } from 'vitest';
import { generateFloorParams } from './generateFloor.js';
import { obstaclesFromDecor, decorSpecsFor, type DecorSpec } from './decor.js';
import type { FloorAlgoParams } from '../config/schemas.js';
import { moveWithCollision } from '../world/movement.js';
import { TILE } from '../world/grid.js';

const PARAMS: FloorAlgoParams = {
  algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5,
  spawnMode: 'farthest', shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0, largeRoomArea: 80,
};

const SPECS: DecorSpec[] = [
  { id: 'column', footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: true, blocksSight: true, collider: { shape: 'circle', r: 0.3 } },
];

describe('напольный декор — расстановка на сервере', () => {
  it('генератор размещает kind:obj декор, когда переданы спеки', () => {
    const L = generateFloorParams(PARAMS, 12345, { decorSpecs: SPECS, decorPlace: { chancePerRoom: 1, maxPerRoom: 2 } });
    const objs = L.decor.filter((d) => d.kind === 'obj');
    expect(objs.length).toBeGreaterThan(0);
    for (const o of objs) {
      expect(o.objectId).toBe('column');
      expect(typeof o.rot).toBe('number');
    }
  });

  it('детерминизм: тот же сид → тот же расклад декора', () => {
    const a = generateFloorParams(PARAMS, 777, { decorSpecs: SPECS, decorPlace: { chancePerRoom: 1 } });
    const b = generateFloorParams(PARAMS, 777, { decorSpecs: SPECS, decorPlace: { chancePerRoom: 1 } });
    expect(JSON.stringify(a.decor)).toBe(JSON.stringify(b.decor));
  });

  it('деривит препятствие из блокирующего декора → игрок не проходит сквозь', () => {
    const L = generateFloorParams(PARAMS, 999, { decorSpecs: SPECS, decorPlace: { chancePerRoom: 1, maxPerRoom: 1 } });
    const obstacles = obstaclesFromDecor(L.decor, new Map(SPECS.map((s) => [s.id, s])));
    expect(obstacles.length).toBeGreaterThan(0);
    const ob = obstacles[0]!;
    expect(ob.shape).toBe('circle');
    expect(ob.blocksSight).toBe(true);
    // Наезжаем на центр препятствия — выталкивает наружу (не залезаем внутрь).
    const R = 14;
    let p = { x: ob.x - TILE, y: ob.y };
    for (let i = 0; i < 60; i++) p = moveWithCollision(p, { x: 300, y: 0 }, R, L.grid, 1 / 30, obstacles);
    const dist = Math.hypot(p.x - ob.x, p.y - ob.y);
    expect(dist).toBeGreaterThanOrEqual(R + (ob.r ?? 0) - 1);
  });

  it('мульти-тайл footprint: клетки резервируются, куски не накладываются', () => {
    const big: DecorSpec[] = [{ id: 'statue', footprint: { w: 2, h: 2 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: true, blocks: true, blocksSight: false, collider: { shape: 'box', w: 1.6, h: 1.6 } }];
    const L = generateFloorParams(PARAMS, 4242, { decorSpecs: big, decorPlace: { chancePerRoom: 1, maxPerRoom: 3 } });
    const objs = L.decor.filter((d) => d.kind === 'obj');
    expect(objs.length).toBeGreaterThan(0);
    // Каждый 2×2 занимает 4 клетки; проверяем, что footprint'ы не пересекаются (центры не ближе 2 тайлов по обеим осям).
    for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
      const a = objs[i]!, b = objs[j]!;
      const overlap = Math.abs(a.x - b.x) < 2 * 32 && Math.abs(a.y - b.y) < 2 * 32;
      expect(overlap).toBe(false);
    }
    for (const o of objs) expect(o.footprint).toEqual({ w: 2, h: 2 });
  });

  it('decorSpecsFor: placeable = prop + floor-россыпь(footprint>1); коллайдер/surface/coversFloor', () => {
    const objects = [
      { id: 'a', modelId: 'ma', enabled: true, role: 'prop', surface: 'wall' as const, biomes: ['crypt'], blocks: true, blocksSight: false, footprint: { w: 1, h: 1 } },
      { id: 'grille', modelId: 'mg', enabled: true, role: 'floor', biomes: ['crypt'], blocks: false, blocksSight: false, footprint: { w: 2, h: 2 } },   // floor-россыпь
      { id: 'base', modelId: 'mb', enabled: true, role: 'floor', biomes: ['crypt'], blocks: false, blocksSight: false, footprint: { w: 1, h: 1 } },      // базовый тайл — НЕ placeable
      { id: 'w', modelId: 'mw', enabled: true, role: 'wall', biomes: ['crypt'], blocks: false, blocksSight: false, footprint: { w: 1, h: 1 } },          // стена — НЕ placeable
      { id: 'c', modelId: 'mc', enabled: false, role: 'prop', biomes: ['crypt'], blocks: true, blocksSight: false, footprint: { w: 1, h: 1 } },          // выключен
      { id: 'd', modelId: 'md', enabled: true, role: 'decor', biomes: ['crypt'], blocks: true, blocksSight: false, footprint: { w: 1, h: 1 } },          // decor отложен — НЕ placeable
    ];
    const models = [{ id: 'ma', collider: { shape: 'circle' as const, r: 0.35 } }];
    const specs = decorSpecsFor(objects, models, 'crypt');
    expect(specs.map((s) => s.id).sort()).toEqual(['a', 'grille']);       // prop + floor-россыпь; базовый пол/стена/decor/выключенный отсеяны
    const a = specs.find((s) => s.id === 'a')!, g = specs.find((s) => s.id === 'grille')!;
    expect(a.surface).toBe('wall'); expect(a.coversFloor).toBe(false); expect(a.collider).toEqual({ shape: 'circle', r: 0.35 });
    expect(g.surface).toBe('floor'); expect(g.coversFloor).toBe(true);    // floor-россыпь заменяет тайл пола
  });
});
