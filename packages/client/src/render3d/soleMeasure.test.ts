import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { lowestSkinY, measureFootLift } from './footIk.js';

/**
 * ЗАМЕР ОФСЕТА ЗАЗЕМЛЕНИЯ ПО ПОДОШВЕ МЕША.
 *
 * Офсет (`pe_phys.footLift`) подбирался глазами ползунком, хотя он ИЗМЕРИМ: заземление целит кость
 * лодыжки в `пол + SOLE + офсет`, значит офсет = «высота лодыжки над её собственной подошвой» минус
 * наш процедурный `SOLE` (1.5). У импортного атласа лодыжка сидит выше — без офсета меш тонет.
 *
 * ⚠ Мерить надо по вершинам СТОПЫ, а не по низу модели: у мага пола плаща висит ниже подошвы, и
 * «низ модели» поднял бы персонажа в воздух на длину полы. И не через `Box3` — у скиннед-меша он
 * считается от БИНД-позы и врёт (в Unity-клиенте на этом уже парил персонаж).
 */

/** Минимальный скиннед-меш: вершины по одной на кость, вес 1 на свою. */
const makeSkin = (bones: THREE.Bone[], verts: { y: number; bone: number }[]): THREE.SkinnedMesh => {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [], si: number[] = [], sw: number[] = [];
  for (const v of verts) { pos.push(0, v.y, 0); si.push(v.bone, 0, 0, 0); sw.push(1, 0, 0, 0); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  const root = new THREE.Object3D();
  for (const b of bones) root.add(b);
  root.add(m);
  const sk = new THREE.Skeleton(bones);
  m.bind(sk);
  root.updateMatrixWorld(true);
  return m;
};

describe('низ скина берётся только с нужных костей', () => {
  const foot = Object.assign(new THREE.Bone(), { name: 'Foot' });
  const coat = Object.assign(new THREE.Bone(), { name: 'Coat' });

  it('⭐ пола плаща НИЖЕ подошвы — и она замер не портит', () => {
    const m = makeSkin([foot, coat], [{ y: 2, bone: 0 }, { y: -5, bone: 1 }]);
    const onlyFoot = lowestSkinY([m], (b) => b.name === 'Foot');
    expect(onlyFoot, 'считаем стопу, а не подол').toBeCloseTo(2, 5);
    const anything = lowestSkinY([m], () => true);
    expect(anything, 'без фильтра замер уехал бы на длину полы').toBeCloseTo(-5, 5);
  });

  it('нет подходящих вершин — честный null, а не ноль', () => {
    // Ноль молча сдвинул бы персонажа; null даёт вызывающему оставить ползунок как был.
    const m = makeSkin([foot, coat], [{ y: 2, bone: 0 }]);
    expect(lowestSkinY([m], (b) => b.name === 'НетТакой')).toBeNull();
  });

  it('меш без скин-атрибутов пропускается, а не роняет замер', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -9, 0], 3));
    const plain = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
    expect(lowestSkinY([plain], () => true)).toBeNull();
  });
});

describe('офсет из замера', () => {
  const h = (): ReturnType<typeof buildHumanoid> => { const x = buildHumanoid({}); x.root.updateMatrixWorld(true); return x; };

  it('⭐ ИНВАРИАНТ: подошва ниже на d → офсет больше ровно на d', () => {
    // Главное свойство замера и единственное, что не зависит ни от рига, ни от позы: насколько
    // меш утоплен, ровно настолько и поднимаем цель лодыжки.
    const r = h();
    for (const d of [0.5, 1.4, 3]) {
      expect(measureFootLift(r, -d)! - measureFootLift(r, 0)!, `d=${d}`).toBeCloseTo(d, 6);
    }
  });

  it('знак верный: подошва ВЫШЕ кости → офсет уходит в минус (иначе персонаж парил бы)', () => {
    const r = h();
    expect(measureFootLift(r, 0.8)!).toBeLessThan(measureFootLift(r, 0)!);
  });

  it('⚠ у процедурной ноги лодыжка в покое на 1.0, а заземление целит в SOLE = 1.5', () => {
    // Отсюда −0.5 на нулевой подошве. Это НЕ ошибка замера: процедурные персонажи ставятся с
    // офсетом 0 и живут так всегда, а автозасев их не трогает вовсе — без атласа замер отдаёт null
    // (`measureSoleOffset` в редакторе). Число записано, чтобы расхождение не выглядело сюрпризом,
    // если однажды кто-то захочет свести SOLE и покойную высоту лодыжки.
    expect(measureFootLift(h(), 0)!).toBeCloseTo(-0.5, 3);
  });
});
