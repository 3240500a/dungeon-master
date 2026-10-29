import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MORPH_PRESETS, MORPH_KEYS, MORPH_REGIONS, DEFAULT_MORPH,
  morphToProfile, morphToBuild, morphToBoneScale, mergeBoneScale,
  findShapeMorphs, weightToShapes, volumeLayer, applyMorphChange,
  sampleMorph, seedRandom, rangeWarnings, type BodyMorph, type MorphRange,
} from './bodyMorph.js';
import { buildHumanoid } from './humanoid.js';
import { clipPoseAt, type Clip, type Pose } from './clipModel.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;

describe('bodyMorph — пресеты и раскладка на механизмы скелета', () => {
  it('пресетов ровно 3×3, id уникальны', () => {
    expect(MORPH_PRESETS.length).toBe(9);
    expect(new Set(MORPH_PRESETS.map((p) => p.id)).size).toBe(9);
    expect(MORPH_PRESETS.find((p) => p.id === 'tall_heavy')!.morph.height).toBeGreaterThan(1);
    expect(MORPH_PRESETS.find((p) => p.id === 'low_thin')!.morph.weight).toBeLessThan(1);
  });

  it('регионы Про-режима покрывают все ручки, кроме двух глобальных', () => {
    const inRegions = new Set(MORPH_REGIONS.flatMap((r) => r.keys));
    for (const k of MORPH_KEYS) {
      if (k === 'height' || k === 'weight') continue;
      expect(inRegions.has(k), k).toBe(true);
    }
  });

  it('морф раскладывается в профиль/толщину/пер-костные длины', () => {
    const m: BodyMorph = { height: 1.1, weight: 1.2, legs: 1.05, arms: 0.95, torso: 1.02, neck: 1.3, shoulders: 1.15, hands: 0.8 };
    const prof = morphToProfile(m);
    expect(prof.height).toBe(1.1); expect(prof.leg).toBe(1.05); expect(prof.arm).toBe(0.95); expect(prof.girth).toBe(1.2);
    const build = morphToBuild(m);
    expect(build.arm).toBeCloseTo(1.2, 6);            // armGirth=1 × weight
    const bs = morphToBoneScale(m);
    expect(bs['Neck']).toBe(1.3);
    expect(bs['LeftShoulder']).toBe(1.15); expect(bs['RightShoulder']).toBe(1.15);
    expect(bs['LeftHand']).toBe(0.8);
    expect(bs['Head']).toBeUndefined();                // не менялось → в карту не пишем
  });

  it('морф ПЕРЕМНОЖАЕТСЯ с пропорциями, снятыми с модели', () => {
    const atlas = { Neck: 1.2, LeftUpperArm: 0.9 };
    const merged = mergeBoneScale(atlas, morphToBoneScale({ neck: 1.5 }));
    expect(merged['Neck']).toBeCloseTo(1.8, 6);        // 1.2 × 1.5
    expect(merged['LeftUpperArm']).toBe(0.9);          // морф её не трогал
  });
});

describe('bodyMorph — реальное влияние на скелет', () => {
  const height = (m: BodyMorph): number => {
    const h = buildHumanoid({ profile: morphToProfile(m), build: morphToBuild(m), boneScale: morphToBoneScale(m) });
    h.root.updateMatrixWorld(true);
    return h.bones.get('Head')!.getWorldPosition(new THREE.Vector3()).y;
  };

  it('рост реально меняет высоту головы', () => {
    expect(height({ height: 1.15 })).toBeGreaterThan(height(DEFAULT_MORPH) + 3);
    expect(height({ height: 0.85 })).toBeLessThan(height(DEFAULT_MORPH) - 3);
  });

  it('«полнота» через кости не меняет рост (объём ≠ пропорции)', () => {
    expect(height({ weight: 1.4 })).toBeCloseTo(height({ weight: 1 }), 1);
  });

  it('ширина плеч меняет расстояние между плечами', () => {
    const span = (m: BodyMorph): number => {
      const h = buildHumanoid({ profile: morphToProfile(m), boneScale: morphToBoneScale(m) });
      h.root.updateMatrixWorld(true);
      return h.bones.get('LeftShoulder')!.getWorldPosition(new THREE.Vector3())
        .distanceTo(h.bones.get('RightShoulder')!.getWorldPosition(new THREE.Vector3()));
    };
    expect(span({ shoulders: 1.5 })).toBeGreaterThan(span({}) + 1);
  });
});

describe('bodyMorph — морф-таргеты меша', () => {
  it('находит морфы модели по синонимам', () => {
    const f = findShapeMorphs(['Body_Heavy', 'Body_Skinny', 'Muscular_Upper', 'Eye_Blink_L']);
    expect(f['weight']).toBe('Body_Heavy');
    expect(f['thin']).toBe('Body_Skinny');
    expect(f['muscular']).toBe('Muscular_Upper');
  });

  it('слой объёма честно определяется: есть морфы → shapes, нет → кости', () => {
    expect(volumeLayer(findShapeMorphs(['Body_Heavy']))).toBe('shapes');
    expect(volumeLayer(findShapeMorphs(['Eye_Blink_L', 'Jaw_Open']))).toBe('bones');
  });

  it('«полнота» разводится на две стороны (полный/худой)', () => {
    const f = { weight: 'Heavy', thin: 'Thin' };
    expect(weightToShapes({ weight: 1.35 }, f)['Heavy']).toBeCloseTo(1, 3);
    expect(weightToShapes({ weight: 0.75 }, f)['Thin']).toBeCloseTo(1, 3);
    expect(weightToShapes({ weight: 1 }, f)).toEqual({});
  });

  it('явные ручки Про перекрывают вычисленные', () => {
    const out = weightToShapes({ weight: 1.35, shapes: { Heavy: 0.2 } }, { weight: 'Heavy' });
    expect(out['Heavy']).toBe(0.2);
  });
});

describe('bodyMorph — закрепление параметра (pin)', () => {
  it('закреплённая ручка не перезаписывается пресетом', () => {
    const cur: BodyMorph = { height: 1.2, weight: 1 };
    const next = applyMorphChange(cur, { height: 0.9, weight: 1.3 }, new Set(['height']));
    expect(next.height).toBe(1.2);   // закреплён — не тронут
    expect(next.weight).toBe(1.3);
  });

  it('без закрепления применяется всё', () => {
    const next = applyMorphChange({ height: 1.2 }, { height: 0.9 }, new Set());
    expect(next.height).toBe(0.9);
  });

  it('морф-таргеты тоже закрепляются', () => {
    const next = applyMorphChange({ shapes: { Heavy: 0.5 } }, { shapes: { Heavy: 1 } }, new Set(['shape:Heavy']));
    expect(next.shapes!['Heavy']).toBe(0.5);
  });
});

describe('bodyMorph — разброс монстров', () => {
  const range: MorphRange = { height: [0.94, 1.08], weight: [0.85, 1.15], shapes: { Heavy: [0, 0.4] } };

  it('сид детерминирован: один id → всегда один и тот же вид', () => {
    const a = sampleMorph(range, 'zombie_17');
    const b = sampleMorph(range, 'zombie_17');
    expect(a).toEqual(b);
  });

  it('разные id дают разный вид', () => {
    const ids = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6'].map((i) => sampleMorph(range, i).height!);
    expect(new Set(ids.map((h) => h.toFixed(4))).size).toBeGreaterThan(4);
  });

  it('значения не выходят за диапазон', () => {
    for (let i = 0; i < 200; i++) {
      const m = sampleMorph(range, 'm' + i);
      expect(m.height!).toBeGreaterThanOrEqual(0.94); expect(m.height!).toBeLessThanOrEqual(1.08);
      expect(m.weight!).toBeGreaterThanOrEqual(0.85); expect(m.weight!).toBeLessThanOrEqual(1.15);
      expect(m.shapes!['Heavy']!).toBeGreaterThanOrEqual(0); expect(m.shapes!['Heavy']!).toBeLessThanOrEqual(0.4);
    }
  });

  it('ГПСЧ равномерен и не вырождается', () => {
    const r = seedRandom('seed');
    const xs = Array.from({ length: 500 }, () => r());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.42); expect(mean).toBeLessThan(0.58);
    expect(new Set(xs).size).toBeGreaterThan(490);
  });

  it('слишком широкий разброс даёт предупреждение', () => {
    expect(rangeWarnings({ height: [0.98, 1.02] })).toEqual([]);
    expect(rangeWarnings({ height: [0.6, 1.4] }).length).toBe(1);
  });
});

describe('bodyMorph — инвариант Ф1.6: клип не зависит от телосложения', () => {
  it('один клип играет на двух вариациях с ИДЕНТИЧНЫМИ углами', () => {
    const clip: Clip = {
      name: 'hit_axe', character: 'a', weapon: 'axe', loop: false,
      keys: [
        { pose: P({ Spine: [0.1, 0, 0], RightUpperArm: [-1, 0.4, 0.9] }), t: 0 },
        { pose: P({ Spine: [-0.2, 0.3, 0], RightUpperArm: [0.7, -0.3, -0.5] }), t: 0.4 },
      ],
    };
    const mk = (m: BodyMorph): ReturnType<typeof buildHumanoid> =>
      buildHumanoid({ profile: morphToProfile(m), build: morphToBuild(m), boneScale: morphToBoneScale(m) });
    const a = mk({ height: 0.9, weight: 0.85, legs: 0.9 });
    const b = mk({ height: 1.15, weight: 1.25, legs: 1.2, shoulders: 1.3 });
    for (const u of [0, 0.5, 1]) {
      const p = clipPoseAt(clip, u);
      for (const h of [a, b]) { h.reset(); for (const nm in p) { if (nm[0] === '_') continue; const bo = h.bones.get(nm); if (bo) bo.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); } }
      for (const nm of a.boneNames) {
        expect(a.bones.get(nm)!.quaternion.angleTo(b.bones.get(nm)!.quaternion), nm).toBeLessThan(1e-6);
      }
    }
  });
});
