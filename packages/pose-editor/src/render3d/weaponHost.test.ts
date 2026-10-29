import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildHumanoid } from './humanoid.js';
import { hostWeaponOnHand } from './weapon3d.js';

/**
 * ОРУЖИЕ КРУТИТСЯ ВМЕСТЕ С КИСТЬЮ (жалоба 17.09.2026: «угол оружия запоминается в мировых координатах — кисть его не
 * крутит, а только двигает»). `hostWeaponOnHand` вешает оружие на кисть ВИДИМОГО атлас-меша (позиция), а поворот берёт
 * у «авторской» кисти процедурного рига (`fallback`). Редактор отдавал туда `ghostHuman ?? human` — призрак, если он
 * вообще есть. Выключенная физика призрака не удаляет, а замораживает: меш шёл за манекеном, поворот — за застывшим
 * призраком. Источник обязан быть тем же, что ведёт меш (`viewRig`).
 */
const deg = (r: number): number => (r * 180) / Math.PI;

describe('hostWeaponOnHand: поворот оружия — от переданной кисти', () => {
  /** Кисть атласа = отдельный объект, повторяющий мировой трансформ живой кисти (как `modelsTab.drive`). */
  function setup(): { live: ReturnType<typeof buildHumanoid>; stale: ReturnType<typeof buildHumanoid>; atlasHand: THREE.Object3D; follow: () => void; g: THREE.Group } {
    const live = buildHumanoid({}), stale = buildHumanoid({});
    const scene = new THREE.Scene(); scene.add(live.root, stale.root);
    const atlasHand = new THREE.Object3D(); scene.add(atlasHand);
    const follow = (): void => {
      live.root.updateMatrixWorld(true);
      live.bones.get('RightHand')!.matrixWorld.decompose(atlasHand.position, atlasHand.quaternion, atlasHand.scale);
      atlasHand.updateMatrixWorld(true);
    };
    const g = new THREE.Group(); g.rotation.set(-1.571, 0, 0);   // базовый хват меча из pe_grip
    follow();
    return { live, stale, atlasHand, follow, g };
  }
  const worldQ = (o: THREE.Object3D): THREE.Quaternion => { o.updateWorldMatrix(true, false); return o.getWorldQuaternion(new THREE.Quaternion()); };

  it('от ЖИВОЙ кисти: поворот кисти на 40° поворачивает оружие на те же 40°', () => {
    const s = setup();
    hostWeaponOnHand(s.g, s.atlasHand, s.live.bones.get('RightHand')!);
    const q0 = worldQ(s.g);
    s.live.bones.get('RightHand')!.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (40 * Math.PI) / 180));
    s.follow();
    hostWeaponOnHand(s.g, s.atlasHand, s.live.bones.get('RightHand')!);
    expect(deg(q0.angleTo(worldQ(s.g)))).toBeCloseTo(40, 3);
  });

  it('от ЗАСТЫВШЕЙ кисти (физика выкл, призрак остался): оружие держит мировой угол — это и была жалоба', () => {
    const s = setup();
    hostWeaponOnHand(s.g, s.atlasHand, s.stale.bones.get('RightHand')!);
    const q0 = worldQ(s.g), p0 = s.g.getWorldPosition(new THREE.Vector3());
    s.live.bones.get('RightUpperArm')!.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.6));
    s.live.bones.get('RightHand')!.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.7));
    s.follow();
    hostWeaponOnHand(s.g, s.atlasHand, s.stale.bones.get('RightHand')!);
    expect(deg(q0.angleTo(worldQ(s.g)))).toBeLessThan(1e-3);                          // угол не сдвинулся
    expect(s.g.getWorldPosition(new THREE.Vector3()).distanceTo(p0)).toBeGreaterThan(1);   // а место поехало с кистью
  });
});

describe('редактор: оружие и меш берут позу из одного источника', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pose-editor.ts'), 'utf8');
  const fnBody = (name: string): string => {
    const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{`).exec(SRC); expect(m, name).not.toBeNull();
    let i = SRC.indexOf('{', m!.index), depth = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
    return SRC.slice(m!.index, i + 1);
  };
  it('viewRig — «призрак только при включённой физике»', () => {
    expect(fnBody('viewRig')).toMatch(/physOn && ghostHuman \? ghostHuman : human/);
  });
  it('syncWeaponHost и updateWeapon не берут «призрак, если он есть»', () => {
    for (const nm of ['syncWeaponHost', 'updateWeapon']) {
      // Без комментариев и ВООБЩЕ без `ghostHuman` в коде: `(ghostHuman || viewRig())` и `ghostHuman ? … : human` возвращали
      // застывший призрак так же, а проверка на одну форму `?? human` их пропускала (мутации проверяющего).
      const b = fnBody(nm).replace(/\/\/.*$/gm, '');
      expect(b, `${nm}: ghostHuman в коде — при выключенной физике это застывший призрак`).not.toMatch(/\bghostHuman\b/);
      expect(b, nm).toMatch(/viewRig\(\)/);
    }
  });
  it('меш модели ведётся тем же viewRig', () => {
    expect(SRC).toMatch(/modelsTab\.drive\(viewRig\(\)\)/);
  });
});
