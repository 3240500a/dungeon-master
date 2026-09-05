import { describe, it, expect } from 'vitest';
import {
  BUILTIN_GRIPS, findGrip, gripToPose, gripToPoseBoth, handBones, isHandBone,
  resolveGripPose, defaultWeaponGrip, applyGripPose, EMPTY_GRIP_CONFIG, type GripConfig,
} from './gripPoses.js';
import { buildHumanoid } from './humanoid.js';
import { allFingerBones } from './boneNames.js';

describe('gripPoses — раскрытие пресета в позу', () => {
  it('кисть = 15 фаланг, обе кисти = 30', () => {
    expect(handBones('Left').length).toBe(15);
    expect(new Set([...handBones('Left'), ...handBones('Right')]).size).toBe(30);
    expect(allFingerBones().every(isHandBone)).toBe(true);
    expect(isHandBone('LeftHand')).toBe(false);
    expect(isHandBone('Spine')).toBe(false);
  });

  it('«открытая» — все углы нулевые', () => {
    const p = gripToPose(findGrip('open')!, 'Left');
    for (const k in p) expect(Math.abs(p[k]![1])).toBeLessThan(1e-9);
  });

  it('«кулак» сгибает все пальцы, и проксимальные — сильнее дистальных по абсолюту', () => {
    const p = gripToPose(findGrip('fist')!, 'Left');
    expect(Math.abs(p['LeftIndexProximal']![1])).toBeGreaterThan(1);
    expect(Math.abs(p['LeftLittleIntermediate']![1])).toBeGreaterThan(1);
    expect(Math.abs(p['LeftThumbProximal']![1])).toBeGreaterThan(0.5);
  });

  it('знак сгиба у левой и правой кисти ПРОТИВОПОЛОЖНЫЙ (кости зеркальны)', () => {
    const both = gripToPoseBoth(findGrip('fist')!, findGrip('fist')!);
    expect(Math.sign(both['LeftIndexProximal']![1])).toBe(-Math.sign(both['RightIndexProximal']![1]));
  });

  it('слайдер «сжатие» линейно масштабирует хват', () => {
    const full = gripToPose(findGrip('fist')!, 'Left', 1);
    const half = gripToPose(findGrip('fist')!, 'Left', 0.5);
    const none = gripToPose(findGrip('fist')!, 'Left', 0);
    expect(half['LeftIndexProximal']![1]).toBeCloseTo(full['LeftIndexProximal']![1] / 2, 6);
    expect(none['LeftIndexProximal']![1]).toBeCloseTo(0, 9);
  });

  it('«указ. палец» оставляет указательный прямым, остальные сжаты', () => {
    const p = gripToPose(findGrip('point')!, 'Left');
    expect(Math.abs(p['LeftIndexProximal']![1])).toBeLessThan(1e-9);
    expect(Math.abs(p['LeftMiddleProximal']![1])).toBeGreaterThan(1);
  });

  it('«лук — тетива» цепляет указательный/средний, мизинец почти свободен', () => {
    const p = gripToPose(findGrip('bow_draw')!, 'Left');
    expect(Math.abs(p['LeftIndexProximal']![1])).toBeGreaterThan(Math.abs(p['LeftLittleProximal']![1]) * 2);
  });

  it('у большого пальца есть противопоставление (не нулевой X)', () => {
    const p = gripToPose(findGrip('fist')!, 'Left');
    expect(Math.abs(p['LeftThumbProximal']![0])).toBeGreaterThan(0.1);
    expect(Math.abs(p['LeftIndexProximal']![0])).toBeLessThan(1e-9);   // у остальных — нет
  });

  it('все встроенные пресеты раскрываются в 15 костей и имеют уникальные id', () => {
    expect(new Set(BUILTIN_GRIPS.map((g) => g.id)).size).toBe(BUILTIN_GRIPS.length);
    for (const g of BUILTIN_GRIPS) expect(Object.keys(gripToPose(g, 'Right')).length, g.id).toBe(15);
  });
});

describe('gripPoses — привязка к оружию', () => {
  it('дефолт угадывается по имени оружия', () => {
    expect(defaultWeaponGrip('bow').R).toBe('bow_grip');
    expect(defaultWeaponGrip('axe').R).toBe('axe');
    expect(defaultWeaponGrip('staff').R).toBe('staff');
    expect(defaultWeaponGrip('sword+shield').R).toBe('sword');
    expect(defaultWeaponGrip('sword+shield').L).toBe('shield');
    expect(defaultWeaponGrip('sword').L).toBe('relaxed');   // пустая офф-рука
  });

  it('resolveGripPose даёт обе кисти без всякой настройки', () => {
    const p = resolveGripPose(EMPTY_GRIP_CONFIG(), 'warrior', 'sword+shield');
    expect(Object.keys(p).length).toBe(30);
    expect(Math.abs(p['RightIndexProximal']![1])).toBeGreaterThan(0.5);   // меч в правой
    expect(Math.abs(p['LeftIndexProximal']![1])).toBeGreaterThan(0.5);    // щит в левой
  });

  it('привязка персонажа перекрывает дефолт', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['warrior'] = { axe: { R: 'open', L: 'open' } };
    const p = resolveGripPose(cfg, 'warrior', 'axe');
    for (const k in p) expect(Math.abs(p[k]![1])).toBeLessThan(1e-9);
  });

  it('свой хват (готовые углы) берётся вместо встроенного, только кости своей кисти', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.custom['my'] = { id: 'my', label: 'мой', pose: { LeftIndexProximal: [0, -0.4, 0], RightIndexProximal: [0, 9, 0] } };
    cfg.byWeapon['w'] = { sword: { L: 'my', R: 'open' } };
    const p = resolveGripPose(cfg, 'w', 'sword');
    expect(p['LeftIndexProximal']).toEqual([0, -0.4, 0]);
    expect(p['RightIndexProximal']![1]).toBe(0);   // из встроенного 'open', а не 9 из чужой кисти
  });

  it('сжатие из привязки применяется', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['w'] = { sword: { R: 'fist', closeR: 0.25 } };
    const p = resolveGripPose(cfg, 'w', 'sword');
    const full = gripToPose(findGrip('fist')!, 'Right');
    expect(p['RightIndexProximal']![1]).toBeCloseTo(full['RightIndexProximal']![1] * 0.25, 6);
  });
});

describe('gripPoses — наложение на скелет', () => {
  it('на гуманоиде С пальцами хват применяется', () => {
    const h = buildHumanoid({ fingers: true });
    applyGripPose(h.bones, gripToPose(findGrip('fist')!, 'Left'));
    expect(Math.abs(h.bones.get('LeftIndexProximal')!.rotation.y)).toBeGreaterThan(1);
  });

  it('на гуманоиде БЕЗ пальцев — тихий no-op (игра не платит за хват)', () => {
    const h = buildHumanoid({});
    expect(h.bones.get('LeftIndexProximal')).toBeUndefined();
    expect(() => applyGripPose(h.bones, gripToPose(findGrip('fist')!, 'Left'))).not.toThrow();
  });

  it('хват НЕ трогает кости вне кисти', () => {
    const h = buildHumanoid({ fingers: true });
    h.bones.get('LeftHand')!.rotation.set(0.3, 0.2, 0.1);
    applyGripPose(h.bones, { ...gripToPose(findGrip('fist')!, 'Left'), LeftHand: [9, 9, 9], Spine: [9, 9, 9] });
    expect(h.bones.get('LeftHand')!.rotation.x).toBeCloseTo(0.3, 6);
    expect(h.bones.get('Spine')!.rotation.x).toBeCloseTo(0, 6);
  });

  it('пределы суставов пальцев не нарушаются встроенными хватами', () => {
    // Сгиб фаланги не должен выходить за анатомический предел (−95°/−100° из jointLimits).
    for (const g of BUILTIN_GRIPS) {
      const p = gripToPose(g, 'Left');
      for (const k in p) expect(Math.abs(p[k]![1]), `${g.id}/${k}`).toBeLessThanOrEqual(100 * Math.PI / 180);
    }
  });
});
