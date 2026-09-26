import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProp } from './propDispose.js';

/**
 * ⭐ R4-38: ОТКРЫТЫЙ СУНДУК (И ОТКРЫТАЯ ДВЕРЬ, ДЁРНУТЫЙ РЫЧАГ) УХОДЯТ СО СЦЕНЫ ВМЕСТЕ С БУФЕРАМИ GPU. У каждого сундука
 * своя геометрия и свой материал; с L1 событие `chest-opened` доходит до веб-3D, и меш снимался с группы пола без
 * `dispose` — а следующая смена области (`clearGroup`) обходит только оставшихся детей группы и его уже не видит. Сотни
 * открытых сундуков за долгую сессию — сотни неосвобождённых буферов.
 */
describe('⭐ R4-38: снятый со сцены предмет пола освобождает своё', () => {
  const chest = (): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(26, 18, 18), new THREE.MeshStandardMaterial({ color: 0x9a7a52 }));

  it('сундук: снят с группы, его геометрия и материал освобождены; соседи не тронуты', () => {
    const floor = new THREE.Group();
    const [a, b, c] = [chest(), chest(), chest()];
    floor.add(a, b, c);
    const spies = [a, b, c].map((m) => ({ g: vi.spyOn(m.geometry, 'dispose'), m: vi.spyOn(m.material as THREE.Material, 'dispose') }));
    removeProp(floor, b);
    expect(floor.children).toEqual([a, c]);
    expect(spies[1]!.g, 'было: геометрия открытого сундука так и висела в памяти').toHaveBeenCalledTimes(1);
    expect(spies[1]!.m).toHaveBeenCalledTimes(1);
    for (const i of [0, 2]) { expect(spies[i]!.g).not.toHaveBeenCalled(); expect(spies[i]!.m).not.toHaveBeenCalled(); }
  });

  it('составной предмет и массив материалов — освобождается всё поддерево; повторный вызов ничего не ломает', () => {
    const floor = new THREE.Group();
    const lever = new THREE.Group();
    const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    const part = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats);
    lever.add(part);
    floor.add(lever);
    const g = vi.spyOn(part.geometry, 'dispose');
    const m = mats.map((x) => vi.spyOn(x, 'dispose'));
    removeProp(floor, lever);
    removeProp(floor, lever);
    expect(floor.children).toEqual([]);
    expect(g).toHaveBeenCalledTimes(1);
    for (const s of m) expect(s).toHaveBeenCalledTimes(1);
  });

  it('веб-3D снимает сундук, дверь и рычаг этим швом, а не голым `remove`', () => {
    const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'online3d.ts'), 'utf8');
    const chestOpened = SRC.slice(SRC.indexOf("if (e.type === 'chest-opened')"), SRC.indexOf("if (e.type === 'hit')"));
    expect(chestOpened).toContain('removeProp(floorGroup, m)');
    expect(chestOpened, '⚠ сундук снова снимается без освобождения').not.toMatch(/floorGroup\.remove\(/);
    const openDoor = SRC.slice(SRC.indexOf('function openDoor('), SRC.indexOf('function openDoor(') + 500);
    expect(openDoor).not.toMatch(/floorGroup\.remove\(/);
    expect(openDoor.match(/removeProp\(floorGroup, /g)).toHaveLength(2);
  });
});
