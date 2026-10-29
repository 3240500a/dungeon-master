import { describe, it, expect, vi } from 'vitest';
import type * as THREE from 'three';
import { ConfigRegistry, defaultParts } from '@dm/shared';
import type { MeshCtx } from './core.js';
import { buildCraftMesh } from './index.js';

/**
 * ⭐ ПОСТРОИТЕЛЬ УПАЛ ПОСРЕДИ СБОРКИ — МАТЕРИАЛЫ НЕ ВИСЯТ. `buildCraftMesh` заводит кэш материалов до
 * вызова построителя, а освобождал его только когда сборка «не строится» (null). Бросок изнутри
 * построителя уносил кэш с собой: каждая кривая сборка оставляла материалы, которые никто не отпустит.
 * Ошибка при этом идёт наверх как была — решает вызывающий (`craftWeapon3d` помечает сборку несобираемой).
 */

// `vi.mock` поднимается над импортами: построитель меча подменён ещё до того, как `index.js` его возьмёт.
const made = vi.hoisted(() => ({ mats: [] as THREE.Material[], disposed: new Set<THREE.Material>() }));

vi.mock('./blades.js', () => {
  const boom = (ctx: MeshCtx): THREE.Group => {
    for (const m of [ctx.mat('strike'), ctx.mat('grip'), ctx.matOf('iron', 2), ctx.fixed(0x444444)]) {
      made.mats.push(m);
      m.addEventListener('dispose', () => { made.disposed.add(m); });
    }
    throw new Error('построитель сломался');
  };
  return { buildSword: boom, buildDagger: boom };
});

describe('buildCraftMesh — бросок построителя освобождает кэш материалов', () => {
  it('материалы, заведённые до броска, освобождены; ошибка проброшена', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const parts = defaultParts(reg, 'sword', 1, 2)!;
    expect(() => buildCraftMesh(reg, 'sword', 1, parts)).toThrow('построитель сломался');
    expect(made.mats.length, 'построитель успел завести материалы').toBeGreaterThan(0);
    for (const m of made.mats) expect(made.disposed.has(m), `материал ${m.uuid} не освобождён`).toBe(true);
  });
});
