import { describe, it, expect } from 'vitest';
import { makeStubBvh } from './stubBvh.js';
import { autoBoneMap, boneMapReport, OUR_BONES } from '../../packages/client/src/render3d/retarget3d.js';

/** Имена суставов из секции HIERARCHY — ровно то, что увидит `BVHLoader`, а за ним `autoBoneMap`. */
const jointNames = (bvh: string): string[] =>
  [...bvh.matchAll(/^\s*(?:ROOT|JOINT)\s+(\S+)/gm)].map((m) => m[1]!);

/** Число чисел в каждой строке кадра — обязано совпасть с числом каналов иерархии. */
const frameWidths = (bvh: string): number[] =>
  bvh.split(/\r?\n/).slice(bvh.split(/\r?\n/).findIndex((l) => l.startsWith('Frame Time')) + 1)
    .filter((l) => l.trim()).map((l) => l.trim().split(/\s+/).length);

describe('заглушечный BVH (фикстура канала генерации)', () => {
  it('разбирается как BVH: есть HIERARCHY, MOTION и заявленное число кадров', () => {
    const bvh = makeStubBvh({ seconds: 2, fps: 30 });
    expect(bvh).toMatch(/^HIERARCHY/);
    expect(bvh).toMatch(/\nMOTION\n/);
    expect(/Frames:\s*(\d+)/.exec(bvh)?.[1]).toBe('60');
    // Тот же признак, по которому редактор отличает BVH от мусора (`poseAiTab.looksLikeBvh`).
    expect(/^\s*HIERARCHY/i.test(bvh) && /MOTION/i.test(bvh)).toBe(true);
  });

  it('ЧИСЛО КАНАЛОВ СХОДИТСЯ С ДАННЫМИ — рассинхрон здесь ломает разбор молча', () => {
    const bvh = makeStubBvh({ seconds: 1, fps: 30 });
    const n = jointNames(bvh).length;
    const expected = 6 + (n - 1) * 3;          // корень 6 каналов, остальные по 3
    const widths = frameWidths(bvh);
    expect(widths.length).toBe(30);
    expect(new Set(widths)).toEqual(new Set([expected]));
  });

  it('длительность приходит из запроса — иначе заглушка не проверяет передачу параметров', () => {
    expect(/Frames:\s*(\d+)/.exec(makeStubBvh({ seconds: 1, fps: 30 }))?.[1]).toBe('30');
    expect(/Frames:\s*(\d+)/.exec(makeStubBvh({ seconds: 3, fps: 30 }))?.[1]).toBe('90');
    expect(/Frames:\s*(\d+)/.exec(makeStubBvh({ seconds: 2, fps: 60 }))?.[1]).toBe('120');
  });

  it('РАДИ ЭТОГО ВСЁ И НУЖНО: скелет заглушки полностью ложится на наши кости', () => {
    const map = autoBoneMap(jointNames(makeStubBvh()));
    const rep = boneMapReport(map);
    expect(rep.missing).toEqual([]);
    expect(rep.core).toBe(OUR_BONES.length);
  });

  it('движение НЕ статично — иначе «клип приехал» ничего не доказывает', () => {
    const rows = makeStubBvh({ seconds: 1, fps: 30 }).split(/\r?\n/).filter((l) => /^-?\d/.test(l));
    expect(new Set(rows).size).toBeGreaterThan(10);
  });

  it('вырожденные запросы не роняют: длительность зажимается в разумные границы', () => {
    expect(() => makeStubBvh({ seconds: 0 })).not.toThrow();
    expect(() => makeStubBvh({ seconds: -5 })).not.toThrow();
    expect(() => makeStubBvh({ seconds: 1e6 })).not.toThrow();
    expect(Number(/Frames:\s*(\d+)/.exec(makeStubBvh({ seconds: 1e6 }))?.[1])).toBeLessThanOrEqual(30 * 30);
  });
});
