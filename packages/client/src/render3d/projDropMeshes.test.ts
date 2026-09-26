import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projMesh, dropMesh } from './projDropMeshes.js';

/**
 * ⭐ R6-12: СНАРЯДЫ И ДРОПЫ ВЕБ-3D НЕ КОПЯТ БУФЕРЫ GPU. Каждый снаряд снапшота получал свою `SphereGeometry` и свой
 * материал, каждый дроп — свой `OctahedronGeometry` и материал; ушедший из снапшота (и все — на смене области и
 * переподключении, `clearActors`) снимался с группы голым `remove`, без `dispose`. В three 0.171 геометрия держит VAO и
 * буферы GL, пока её не освободят: час лука, жезла или этажа стрелков — десятки тысяч геометрий, рост памяти GPU, на
 * слабых видеокартах — фризы и потеря контекста. Тот же класс утечки, что R4-38 (сундуки, двери, рычаги), но на каждый
 * выстрел. Теперь у мешей нет своих ресурсов: геометрия одна на вид, материал — один на цвет; снимать их — голым `remove`.
 */
describe('⭐ R6-12: меши снарядов и дропов — на общих геометриях и материалах', () => {
  /** Цвета снарядов, как их выбирает веб-3D: монстр — красный, игрок — по типу урона. */
  const TINTS = [0xff8080, 0xffe680, 0xff6a2a, 0x7ad0ff, 0xc9a0ff, 0x7fdc4f];

  it('⭐ тысяча снарядов, пришедших и ушедших из снапшота, — одна геометрия и по материалу на цвет (было: по тысяче)', () => {
    const group = new THREE.Group();
    const geoms = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
    for (let i = 0; i < 1000; i++) {
      const m = projMesh(TINTS[i % TINTS.length]!);
      group.add(m);
      geoms.add(m.geometry); mats.add(m.material as THREE.Material);
      group.remove(m);                                  // ушёл из снапшота — голый remove: освобождать нечего
    }
    expect(geoms.size).toBe(1);
    expect(mats.size, 'материал — один на цвет').toBe(TINTS.length);
    expect(group.children).toEqual([]);
  });

  it('⭐ тысяча дропов — одна геометрия гема, материал на цвет (вещь, золото, сырьё)', () => {
    const geoms = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
    for (let i = 0; i < 1000; i++) {
      const g = dropMesh([0xdcc060, 0xffd24a, 0x9aa6b2][i % 3]!);
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { geoms.add(m.geometry); mats.add(m.material as THREE.Material); } });
    }
    expect(geoms.size).toBe(1);
    expect(mats.size).toBe(3);
  });

  it('вид как был: сфера r=5 с самосветом 0.7, гем-октаэдр r=6 на высоте 12 с самосветом 0.9', () => {
    const p = projMesh(0xff8080);
    expect(p.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect((p.geometry as THREE.SphereGeometry).parameters).toMatchObject({ radius: 5, widthSegments: 8, heightSegments: 8 });
    const pm = p.material as THREE.MeshStandardMaterial;
    expect(pm.color.getHex()).toBe(0xff8080);
    expect(pm.emissive.getHex()).toBe(0xff8080);
    expect(pm.emissiveIntensity).toBe(0.7);
    const d = dropMesh(0xffd24a);
    const gem = d.children[0] as THREE.Mesh;
    expect(gem.geometry).toBeInstanceOf(THREE.OctahedronGeometry);
    expect((gem.geometry as THREE.OctahedronGeometry).parameters.radius).toBe(6);
    expect(gem.position.y).toBe(12);
    expect((gem.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.9);
    expect((gem.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0xffd24a);
  });

  it('общее не освобождается ничьим снятием: следующий снаряд берёт живую геометрию', () => {
    const a = projMesh(0xff8080);
    const spy = vi.spyOn(a.geometry, 'dispose');
    new THREE.Group().add(a).remove(a);
    expect(projMesh(0xff8080).geometry).toBe(a.geometry);
    expect(spy).not.toHaveBeenCalled();
  });

  it('веб-3D строит снаряды и дропы этим швом — своих геометрий и материалов на спавн больше нет', () => {
    const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'online3d.ts'), 'utf8');
    expect(SRC, 'было: new SphereGeometry + MeshStandardMaterial на каждый снаряд').not.toMatch(/new THREE\.SphereGeometry\(5, 8, 8\)/);
    expect(SRC, 'было: new OctahedronGeometry + материал на каждый дроп').not.toMatch(/new THREE\.OctahedronGeometry\(6\)/);
    expect(SRC).toMatch(/m = projMesh\(tint\)/);
    expect(SRC).toMatch(/const g = dropMesh\(col\)/);
  });
});
