import { describe, it, expect } from 'vitest';
import {
  MASK_PARTS, ALL_PARTS, MASK_PRESETS, PART_OF_BONE, MASKABLE_BONES,
  presetMask, fullMask, maskFromBody, togglePart, setPartWeight, partWeight, hasPart, weightsOf,
  boneWeight, maskBones, isFullMask, maskLabel, maskBodyBones, maskFingers, type BoneMask,
} from './boneMask.js';
import { OUR_BONES, OUR_FINGERS } from './retarget3d.js';
import { UPPER_BONES, SHIELD_BONES } from './poseRuntime.js';

describe('boneMask — части покрывают риг ровно один раз', () => {
  it('каждая кость рига попала РОВНО в одну часть (иначе вес зависел бы от порядка)', () => {
    const seen = new Map<string, string>();
    for (const p of MASK_PARTS) for (const b of p.bones) {
      expect(seen.has(b), `${b} уже в части ${seen.get(b)}`).toBe(false);
      seen.set(b, p.id);
    }
    for (const b of [...OUR_BONES, ...OUR_FINGERS]) expect(seen.has(b), b).toBe(true);
    expect(seen.size).toBe(MASKABLE_BONES.length);
  });

  it('Root в маску НЕ входит — его никогда не анимируем (контракт клипа)', () => {
    expect(MASKABLE_BONES).not.toContain('Root');
    expect(PART_OF_BONE['Root']).toBeUndefined();
  });

  it('запястье — в РУКЕ, фаланги — в ПАЛЬЦАХ (иначе мах руки тащит покадровый хват)', () => {
    expect(PART_OF_BONE['LeftHand']).toBe('armL');
    expect(PART_OF_BONE['LeftIndexProximal']).toBe('handL');
    expect(PART_OF_BONE['RightThumbDistal']).toBe('handR');
  });
});

describe('boneMask — пресеты и развёртка в кости', () => {
  it('«всё» = все кости рига, включая пальцы', () => {
    const m = fullMask();
    expect(isFullMask(m)).toBe(true);
    expect(maskBones(m).size).toBe(MASKABLE_BONES.length);
  });

  it('«верх» = старый body:upper 1-в-1 (низ = таз+ноги, всё остальное — верх)', () => {
    const LOWER = ['Hips', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'];
    const up = maskBodyBones(presetMask('upper'));
    expect([...up].sort()).toEqual((OUR_BONES as readonly string[]).filter((b) => !LOWER.includes(b)).sort());
    expect([...maskBodyBones(presetMask('lower'))].sort()).toEqual([...LOWER].sort());
  });

  it('старый enum body переводится один-в-один — ПО ТЕЛУ, БЕЗ пальцев', () => {
    // Старый запекатель фаланги не снимал вовсе → перевод не имеет права добавить 30 каналов хвата.
    for (const [body, preset] of [['full', 'all'], ['upper', 'upper'], ['lower', 'lower']] as const) {
      expect(maskBodyBones(maskFromBody(body))).toEqual(maskBodyBones(presetMask(preset)));
      expect(maskFingers(maskFromBody(body)).size, body).toBe(0);
    }
    expect(maskBodyBones(maskFromBody(undefined))).toEqual(maskBodyBones(fullMask()));
  });

  it('«без пальцев» отдаёт тело целиком и ни одной фаланги', () => {
    const m = presetMask('noFingers');
    expect(maskFingers(m).size).toBe(0);
    expect(maskBodyBones(m).size).toBe(OUR_BONES.length);
    expect(isFullMask(m)).toBe(false);
  });

  it('неизвестный пресет — «всё», а не пустая маска (пустая молча съела бы весь клип)', () => {
    expect(isFullMask(presetMask('нет такого'))).toBe(true);
  });
});

describe('boneMask — веса (Blend Mask из Unreal)', () => {
  it('вес части = 1/0, кость вне рига = 0', () => {
    const m: BoneMask = { parts: { armR: 1 } };
    expect(boneWeight(m, 'RightUpperArm')).toBe(1);
    expect(boneWeight(m, 'LeftUpperArm')).toBe(0);
    expect(boneWeight(m, 'CC_Base_Bogus')).toBe(0);
  });

  it('явный вес СИЛЬНЕЕ части — в обе стороны (так выражается SHIELD_FALLOFF)', () => {
    const m: BoneMask = { parts: { armL: 1 }, weights: { LeftUpperArm: 0.22, Spine: 0.04 } };
    expect(boneWeight(m, 'LeftUpperArm')).toBeCloseTo(0.22);   // часть взята, но затухает
    expect(boneWeight(m, 'Spine')).toBeCloseTo(0.04);          // часть НЕ взята, но вес есть
    expect(boneWeight(m, 'LeftHand')).toBe(1);                 // без веса — по части
    expect(maskBones(m).has('Spine')).toBe(true);
  });

  it('вес 0 ВЫЧЁРКИВАЕТ кость из взятой части', () => {
    const m: BoneMask = { parts: { legL: 1 }, weights: { LeftToes: 0 } };
    expect(boneWeight(m, 'LeftToes')).toBe(0);
    expect(maskBones(m).has('LeftToes')).toBe(false);
    expect(maskBones(m).has('LeftFoot')).toBe(true);
  });

  it('вес зажимается в 0..1 (мусор из UI не разгоняет бленд)', () => {
    const m: BoneMask = { parts: {}, weights: { Spine: 5, Chest: -3 } };
    expect(boneWeight(m, 'Spine')).toBe(1);
    expect(boneWeight(m, 'Chest')).toBe(0);
  });

  it('все части взяты, но есть частичный вес → маска НЕ полная (быстрый путь запрещён)', () => {
    expect(isFullMask({ parts: weightsOf(ALL_PARTS), weights: { Spine: 0.5 } })).toBe(false);
    expect(isFullMask({ parts: weightsOf(ALL_PARTS), weights: { Spine: 1 } })).toBe(true);
  });
});

describe('boneMask — пикер', () => {
  it('переключение части не мутирует исходную маску (она лежит в undo)', () => {
    const a = presetMask('upper');
    const b = togglePart(a, 'legL');
    expect(hasPart(a, 'legL')).toBe(false);
    expect(partWeight(b, 'legL')).toBe(1);
    expect(hasPart(togglePart(b, 'legL'), 'legL')).toBe(false);
  });

  it('веса переживают переключение части', () => {
    const m = togglePart({ parts: { armL: 1 }, weights: { Spine: 0.3 } }, 'armR');
    expect(m.weights?.['Spine']).toBeCloseTo(0.3);
  });

  it('подпись: пресет узнаётся, произвольный набор перечисляется, пустая маска названа', () => {
    expect(maskLabel(fullMask())).toBe('всё');
    expect(maskLabel(presetMask('upper'))).toBe('верх');
    expect(maskLabel({ parts: {} })).toBe('ничего');
    expect(maskLabel({ parts: { head: 1, legR: 1 } })).toBe('голова+нога П');
    expect(maskLabel({ parts: { head: 1, armR: 0.4 } })).toBe('голова · рука П 40%');
  });

  it('у каждого пресета части реальные (опечатка в id ловится тут)', () => {
    for (const p of MASK_PRESETS) for (const id of p.parts) expect(ALL_PARTS).toContain(id);
  });
});

describe('boneMask — слои рантайма', () => {
  it('слои дают РОВНО те же кости, что захардкоженные списки до Ф8', () => {
    // Страховка перевода: списки были зашиты в poseRuntime, теперь они разворачиваются из масок.
    expect([...UPPER_BONES].sort()).toEqual(['Chest', 'UpperChest', 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand'].sort());
    expect([...SHIELD_BONES].sort()).toEqual(['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'Spine', 'Chest', 'UpperChest'].sort());
  });
});

describe('boneMask — ВЕС на часть (Blend Mask из Unreal, не да/нет)', () => {
  it('вес части раздаётся ВСЕМ её костям — это «Recursively Set Blend Scales»', () => {
    const m = setPartWeight(presetMask('upper'), 'armR', 0.4);
    for (const b of ['RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand']) expect(boneWeight(m, b), b).toBeCloseTo(0.4);
    expect(boneWeight(m, 'Chest')).toBe(1);            // соседняя часть не тронута
    expect(boneWeight(m, 'LeftUpperLeg')).toBe(0);     // невзятая — по-прежнему 0
  });

  it('порядок разрешения: явный вес КОСТИ > вес ЧАСТИ > 0', () => {
    const m: BoneMask = { parts: { armL: 0.5 }, weights: { LeftHand: 0.9 } };
    expect(boneWeight(m, 'LeftHand')).toBeCloseTo(0.9);      // кость перекрыла часть
    expect(boneWeight(m, 'LeftLowerArm')).toBeCloseTo(0.5);  // часть
    expect(boneWeight(m, 'Spine')).toBe(0);                  // ни того, ни другого
  });

  it('вес 0 = части нет (отсутствие ключа и ноль — одно и то же)', () => {
    const m = setPartWeight(presetMask('all'), 'head', 0);
    expect(hasPart(m, 'head')).toBe(false);
    expect(m.parts['head']).toBeUndefined();
    expect(maskBones(m).has('Head')).toBe(false);
  });

  it('вес зажимается в 0..1 и не мутирует исходную маску', () => {
    const a = presetMask('upper');
    expect(partWeight(setPartWeight(a, 'head', 5), 'head')).toBe(1);
    expect(partWeight(setPartWeight(a, 'head', -2), 'head')).toBe(0);
    expect(partWeight(a, 'head')).toBe(1);
  });

  it('частичный вес делает маску НЕ полной (быстрый путь запрещён)', () => {
    expect(isFullMask(setPartWeight(fullMask(), 'legR', 0.99))).toBe(false);
    expect(isFullMask(fullMask())).toBe(true);
  });

  it('часть с дробным весом ОСТАЁТСЯ в наборе костей (её надо семплить, чтобы было что смешивать)', () => {
    const m = setPartWeight(presetMask('upper'), 'legL', 0.3);
    expect(maskBones(m).has('LeftUpperLeg')).toBe(true);
  });
});
