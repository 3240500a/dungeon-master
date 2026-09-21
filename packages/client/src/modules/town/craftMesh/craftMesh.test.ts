import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  ConfigRegistry, clampStep, defaultParts, familiesOf, keySlotOf, keyVariantsByBase, variantsFor,
  type CraftParts, type CraftSlot,
} from '@dm/shared';
import { buildCraftMesh } from './index.js';
import { SLOT_NAMES } from './core.js';

/**
 * Сторожа параметрической модели (docs/CRAFT_WEAPONS.md §18): модель собирается из ТЕХ ЖЕ деталей,
 * что и вещь, и РАЗНЫЕ детали обязаны выглядеть по-разному — иначе игрок не видит, что собирает.
 */

const reg = new ConfigRegistry();
reg.loadAll();
// CRAFT_MESH_ONLY=sword,dagger — гонять только свои классы (удобно, пока остальные построители — заглушки).
const ONLY = (typeof process !== 'undefined' ? process.env.CRAFT_MESH_ONLY : undefined)?.split(',').filter(Boolean);
const CLASSES = reg.get('weapon-anatomy').map((a) => a.id).filter((c) => !ONLY?.length || ONLY.includes(c));

/** Подпись группы гнезда: габарит в мире (до 0.05 см) + число вершин. */
function signature(o: THREE.Object3D): string {
  o.updateWorldMatrix(true, true);
  const bb = new THREE.Box3().setFromObject(o);
  let verts = 0;
  o.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) verts += m.geometry.getAttribute('position').count; });
  const r = (v: number): string => (Math.round(v * 20) / 20).toFixed(2);
  return `${r(bb.min.x)},${r(bb.min.y)},${r(bb.min.z)}|${r(bb.max.x)},${r(bb.max.y)},${r(bb.max.z)}|${verts}`;
}

function build(cls: string, hands: number, parts: CraftParts) {
  const res = buildCraftMesh(reg, cls, hands, parts);
  expect(res, `${cls}/${hands}`).toBeTruthy();
  return res!;
}

/** Все сборки «эталон + одна деталь заменена» по семейству. */
function* variations(cls: string, hands: number): Generator<{ slot: CraftSlot; id: string; parts: CraftParts }> {
  const def = defaultParts(reg, cls, hands, 3)!;
  const keySlot = keySlotOf(reg, cls);
  for (const slot of SLOT_NAMES) {
    const pool = slot === keySlot ? keyVariantsByBase(reg, cls, hands).flatMap((g) => g.variants) : variantsFor(reg, cls, slot, hands);
    for (const p of pool) {
      const parts = structuredClone(def);
      parts[slot] = { id: p.id, step: clampStep(p, 3) };
      yield { slot, id: p.id, parts };
    }
  }
}

describe('модель оружия из деталей (craftMesh)', () => {
  it('у каждой сборки всех 15 семейств — четыре группы гнёзд, конечная геометрия, габарит 10…700 см', () => {
    for (const cls of CLASSES) for (const hands of familiesOf(reg, cls)) for (const v of variations(cls, hands)) {
      const res = build(cls, hands, v.parts);
      const names = res.group.children.map((c) => c.name);
      for (const s of SLOT_NAMES) expect(names, `${cls}/${hands} ${v.id}`).toContain(s);
      res.group.updateWorldMatrix(true, true);
      let meshes = 0;
      res.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        meshes++;
        const pos = m.geometry.getAttribute('position');
        for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i]!)) throw new Error(`${cls} ${v.id}: NaN в геометрии`);
      });
      expect(meshes, `${cls} ${v.id}`).toBeGreaterThanOrEqual(4);
      for (const s of SLOT_NAMES) {
        const sub = res.group.getObjectByName(s)!;
        let n = 0; sub.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
        expect(n, `${cls}/${hands} ${v.id}: гнездо ${s} пустое`).toBeGreaterThan(0);
      }
      const size = new THREE.Box3().setFromObject(res.group).getSize(new THREE.Vector3());
      const big = Math.max(size.x, size.y, size.z);
      expect(big, `${cls} ${v.id}`).toBeGreaterThan(10);
      expect(big, `${cls} ${v.id}`).toBeLessThan(700);
      res.dispose();
    }
  });

  it('рукоять — в начале координат, рабочий конец — в −Y', () => {
    for (const cls of CLASSES) for (const hands of familiesOf(reg, cls)) {
      const res = build(cls, hands, defaultParts(reg, cls, hands, 3)!);
      res.group.updateWorldMatrix(true, true);
      const grip = new THREE.Box3().setFromObject(res.group.getObjectByName('grip')!);
      expect(grip.clone().expandByScalar(5).containsPoint(new THREE.Vector3()), `${cls}/${hands}: рукоять не в начале координат`).toBe(true);
      if (cls !== 'bow') {
        const strike = new THREE.Box3().setFromObject(res.group.getObjectByName('strike')!);
        const cy = (b: THREE.Box3): number => (b.min.y + b.max.y) / 2;
        expect(cy(strike), `${cls}/${hands}: ударная часть не в −Y`).toBeLessThan(cy(grip) - 1);
      }
      res.dispose();
    }
  });

  it('⭐ разные детали одного гнезда выглядят по-разному — у каждого варианта своя геометрия', () => {
    const clashes: string[] = [];
    for (const cls of CLASSES) for (const hands of familiesOf(reg, cls)) {
      const seen = new Map<string, string>();
      for (const v of variations(cls, hands)) {
        const res = build(cls, hands, v.parts);
        const sig = `${v.slot}#${signature(res.group.getObjectByName(v.slot)!)}`;
        const prev = seen.get(sig);
        if (prev && prev !== v.id) clashes.push(`${cls}/${hands} ${v.slot}: ${prev} = ${v.id}`);
        seen.set(sig, v.id);
        res.dispose();
      }
    }
    expect(clashes, clashes.slice(0, 20).join('\n')).toEqual([]);
  });

  it('материал видно: ступени одной детали дают разный цвет', () => {
    const def = defaultParts(reg, 'sword', 1, 1)!;
    const colors = new Set<number>();
    for (const step of [1, 2, 3]) {
      const parts = structuredClone(def);
      parts.strike.step = step;
      const res = build('sword', 1, parts);
      res.group.getObjectByName('strike')!.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) colors.add((m.material as THREE.MeshStandardMaterial).color.getHex());
      });
      res.dispose();
    }
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });
});
