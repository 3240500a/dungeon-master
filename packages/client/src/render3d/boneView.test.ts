import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeBoneView, mappedParent, type BoneSource } from './boneView.js';
import { boneWidth } from './humanoid.js';

/** Мини-скелет «модели»: плоская карта имя → мировая позиция, разложенная по объектам. */
function src(pos: Record<string, [number, number, number]>, parent: Record<string, string>): BoneSource {
  const objs: Record<string, THREE.Object3D> = {};
  for (const k in pos) { const o = new THREE.Object3D(); o.position.set(...pos[k]!); o.updateMatrixWorld(true); objs[k] = o; }
  return {
    names: Object.keys(parent),
    parentOf: (n) => parent[n] ?? null,
    boneOf: (n) => objs[n] ?? null,
  };
}

const PARENT: Record<string, string> = { Hips: '', Spine: 'Hips', UpperChest: 'Spine', Neck: 'UpperChest', Head: 'Neck' };

describe('boneView — рисуем ТОЛЬКО то, что есть у модели', () => {
  it('несмапленная кость не рисуется, а цепь НЕ рвётся — сегмент идёт до ближайшего смапленного предка', () => {
    // У CC/AccuRIG нет `UpperChest`. Без пропуска промежуточного шея повисла бы в воздухе.
    const s = src({ Hips: [0, 0, 0], Spine: [0, 5, 0], Neck: [0, 16, 0], Head: [0, 20, 0] }, PARENT);
    expect(mappedParent(s, 'Neck')).toBe('Spine');
    const v = makeBoneView(); v.rebuild(s);
    expect(v.mapped).toEqual(['Hips', 'Spine', 'Neck', 'Head']);
    expect(v.joints.length).toBe(4);                      // шар на каждую СМАПЛЕННУЮ кость
    expect(v.meshes.length).toBe(4 + 3);                  // + сегменты Hips→Spine, Spine→Neck, Neck→Head
    expect(v.meshes.some((m) => m.userData.bone === 'UpperChest')).toBe(false);
    v.dispose();
  });

  it('у корня сегмента нет — рисуется только шар', () => {
    const s = src({ Hips: [0, 0, 0] }, { Hips: '' });
    const v = makeBoneView(); v.rebuild(s);
    expect(v.joints.length).toBe(1);
    expect(v.meshes.length).toBe(1);
    v.dispose();
  });
});

describe('boneView — геометрия берётся из МИРОВЫХ позиций костей', () => {
  const s = src({ Hips: [0, 0, 0], Spine: [0, 5, 0], Neck: [0, 16, 0], Head: [0, 20, 0] }, PARENT);
  const v = makeBoneView(); v.rebuild(s); v.update(s);
  const seg = (from: string): THREE.Mesh => v.meshes.filter((m) => !m.userData.joint).find((m) => m.userData.bone === from)!;

  it('сегмент начинается в родителе и имеет длину РОВНО до ребёнка', () => {
    const m = seg('Spine');                               // Spine(0,5,0) → Neck(0,16,0), длина 11
    expect(m.position.y).toBeCloseTo(5, 6);
    expect(m.scale.y).toBeCloseTo(11, 6);
    expect(m.scale.x).toBeCloseTo(boneWidth(11), 6);      // толщина — общая формула, не своя
  });

  it('кость смотрит НА ребёнка, а не вдоль оси по умолчанию', () => {
    const side = src({ A: [0, 0, 0], B: [7, 0, 0] }, { A: '', B: 'A' });
    const w = makeBoneView(); w.rebuild(side); w.update(side);
    const m = w.meshes.filter((x) => !x.userData.joint)[0]!;
    const tip = new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion).multiplyScalar(m.scale.y).add(m.position);
    expect(tip.x).toBeCloseTo(7, 5); expect(tip.y).toBeCloseTo(0, 5);
    w.dispose();
  });

  it('шар садится РОВНО на кость, а его масштаб не трогается (им владеет scaleJointsToScreen)', () => {
    const j = v.joints.find((x) => x.userData.bone === 'Head')!;
    j.scale.setScalar(0.42);                              // «экранный» масштаб, выставленный снаружи
    v.update(s);
    expect(j.position.y).toBeCloseTo(20, 6);
    expect(j.scale.x).toBeCloseTo(0.42, 6);
  });

  it('ключи userData — те же, что у манекена (иначе выбор и подсветка перестанут работать)', () => {
    for (const m of v.meshes) expect(typeof m.userData.bone).toBe('string');
    for (const j of v.joints) { expect(j.userData.joint).toBe(true); expect(typeof j.userData.jr).toBe('number'); }
  });

  it('каждому мешу СВОЙ материал — иначе подсветка одной кости зажгла бы весь скелет', () => {
    const mats = new Set(v.meshes.map((m) => m.material));
    expect(mats.size).toBe(v.meshes.length);
  });
});

describe('boneView — кость исчезла (свап атласа)', () => {
  it('пропавшая кость прячется, а не роняет обновление', () => {
    const full = src({ A: [0, 0, 0], B: [0, 3, 0] }, { A: '', B: 'A' });
    const v = makeBoneView(); v.rebuild(full); v.update(full);
    const gone: BoneSource = { names: full.names, parentOf: full.parentOf, boneOf: (n) => (n === 'B' ? null : full.boneOf(n)) };
    expect(() => v.update(gone)).not.toThrow();
    expect(v.joints.find((j) => j.userData.bone === 'B')!.visible).toBe(false);
    expect(v.meshes.filter((m) => !m.userData.joint)[0]!.visible).toBe(false);
    v.dispose();
  });
});
