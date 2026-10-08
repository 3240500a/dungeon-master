import { describe, it, expect } from 'vitest';
import { generateFloorParams } from './generateFloor.js';
import { obstaclesFromDecor, decorSpecsFor, footprintRect, FloorClaims, type DecorSpec } from './decor.js';
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
    expect(g.clearance).toBe(0);                                          // ⭐ 08.10: нет поля — отступа нет
    expect(decorSpecsFor([{ ...objects[1]!, clearance: 2 }], models, 'crypt')[0]!.clearance).toBe(2);
  });

  it('⭐ 08.10: отступ (`FloorClaims`) — в обе стороны: чужой след в моём кольце и мой след в чужом кольце; отступ 0 — только следы', () => {
    const at = (x: number, y: number, w = 2, h = 2) => ({ x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 });
    const one = (c: number) => { const f = new FloorClaims(); f.claim(at(10, 10), c); return f; };
    expect(one(0).free(at(12, 10), 0), 'вплотную, отступов нет').toBe(true);
    expect(one(0).free(at(11, 10), 0), 'след на след').toBe(false);
    expect(one(1).free(at(12, 10), 0), 'в кольце стоящего').toBe(false);
    expect(one(0).free(at(12, 10), 1), 'своё кольцо задело стоящий').toBe(false);
    expect(one(1).free(at(12, 12), 0), 'угол к углу — тоже касание').toBe(false);
    expect(one(1).free(at(13, 10), 1), 'клетка пола между — можно').toBe(true);
    expect(one(2).free(at(13, 10), 0), 'отступ 2 — нужно две клетки').toBe(false);
    // след по точке декора: как у placeFloorDecor (центр следа) и у костра в комнате нечётной ширины (центр посреди клетки — шире на клетку)
    expect(footprintRect({ x: 6 * TILE, y: 6 * TILE, footprint: { w: 2, h: 2 } })).toEqual({ x0: 5, y0: 5, x1: 6, y1: 6 });
    expect(footprintRect({ x: 6.5 * TILE, y: 6 * TILE, footprint: { w: 2, h: 2 } })).toEqual({ x0: 5, y0: 5, x1: 7, y1: 6 });
    expect(footprintRect({ x: 3.5 * TILE, y: 4.5 * TILE, footprint: { w: 1, h: 1 } })).toEqual({ x0: 3, y0: 4, x1: 3, y1: 4 });
    expect(footprintRect({ x: 3.2 * TILE, y: 4.9 * TILE })).toEqual({ x0: 3, y0: 4, x1: 3, y1: 4 });   // без следа — клетка под точкой
  });

  it('⭐ 08.10: россыпь с отступом 1 — следы не касаются; отступ 0 явно — байт-в-байт как без поля', () => {
    const base: DecorSpec[] = [
      { id: 'rug', footprint: { w: 2, h: 2 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: true, blocks: false, blocksSight: false },
      { id: 'col', footprint: { w: 1, h: 1 }, weight: 1, spawnChance: 1, surface: 'floor', coversFloor: false, blocks: true, blocksSight: true, collider: { shape: 'circle', r: 0.3 } },
    ];
    let pairs = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const a = generateFloorParams(PARAMS, seed, { decorSpecs: base, decorPlace: { maxPerRoom: 8 } });
      const z = generateFloorParams(PARAMS, seed, { decorSpecs: base.map((s) => ({ ...s, clearance: 0 })), decorPlace: { maxPerRoom: 8 } });
      expect(JSON.stringify(z)).toBe(JSON.stringify(a));
      const L = generateFloorParams(PARAMS, seed, { decorSpecs: base.map((s) => ({ ...s, clearance: 1 })), decorPlace: { maxPerRoom: 8 } });
      const rects = L.decor.filter((d) => d.kind === 'obj').map(footprintRect);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const p = rects[i]!, q = rects[j]!;
        const touch = p.x0 - 1 <= q.x1 && q.x0 <= p.x1 + 1 && p.y0 - 1 <= q.y1 && q.y0 <= p.y1 + 1;
        expect(touch, `сид ${seed}: ${JSON.stringify(p)} касается ${JSON.stringify(q)}`).toBe(false);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(40);
  });

  it('⭐ 08.10 (Ф1): коллайдер — объекта, иначе модели, иначе меша collider* из каталога Unity (`art`), иначе нет', () => {
    const o = (id: string, modelId: string, collider?: { shape: 'circle' | 'box'; r?: number; w?: number; h?: number }) =>
      ({ id, modelId, enabled: true, role: 'prop', biomes: [], blocks: true, blocksSight: false, footprint: { w: 1, h: 1 }, ...(collider ? { collider } : {}) });
    const objects = [o('own', 'm1', { shape: 'circle', r: 0.1 }), o('model', 'm1'), o('art', 'm2'), o('none', 'm3')];
    const models = [{ id: 'm1', collider: { shape: 'box' as const, w: 0.5, h: 0.25 } }, { id: 'm2' }, { id: 'm3' }];
    const art = [{ id: 'm1', collider: { shape: 'circle' as const, r: 0.9 } }, { id: 'm2', collider: { shape: 'box' as const, w: 0.7, h: 0.3 } }];
    const by = new Map(decorSpecsFor(objects, models, undefined, art).map((s) => [s.id, s.collider]));
    expect(by.get('own')).toEqual({ shape: 'circle', r: 0.1 });
    expect(by.get('model')).toEqual({ shape: 'box', w: 0.5, h: 0.25 });   // записанный в модель главнее манифеста
    expect(by.get('art')).toEqual({ shape: 'box', w: 0.7, h: 0.3 });
    expect(by.get('none')).toBeUndefined();
    expect(new Map(decorSpecsFor(objects, models, undefined).map((s) => [s.id, s.collider])).get('art')).toBeUndefined();   // без манифеста — как раньше
  });
});
