import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  BUILTIN_GRIPS, findGrip, gripToPose, gripToPoseBoth, handBones, isHandBone,
  resolveGripPose, defaultWeaponGrip, applyGripPose, EMPTY_GRIP_CONFIG, type GripConfig,
} from './gripPoses.js';
import { buildHumanoid } from './humanoid.js';
import { allFingerBones } from './boneNames.js';
import { extraLimitView } from './jointLimits.js';
import { decomposeToLimit } from './jointClamp.js';
import { mirrorSide, type Pose } from './clipModel.js';

/**
 * Ф14.4: сгиб живёт на ВЫВЕДЕННОЙ оси, а не в фиксированной компоненте эйлера, поэтому проверяем
 * СМЫСЛ (сколько согнуто вокруг своей оси), а не число в ячейке. Раньше тесты смотрели в `[1]` (Y),
 * и после переноса оси они бы либо падали, либо — хуже — молча позеленели бы на нулях.
 */
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
const dec = (p: Pose, bone: string): { rP: number; rN: number; twist: number } => {
  const v = p[bone]!; const view = extraLimitView(bone)!;
  _q.setFromEuler(_e.set(v[0], v[1], v[2], 'XYZ'));
  return decomposeToLimit(_q, view);
};
/** Сгиб «в кулак» вокруг собственной оси пальца (положительный = к ладони). */
const curl = (p: Pose, bone: string): number => dec(p, bone).rP;

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
    for (const k in p) for (const c of p[k]!) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('«кулак» реально сгибает пальцы К ЛАДОНИ, а не разводит вбок', () => {
    const p = gripToPose(findGrip('fist')!, 'Left');
    expect(curl(p, 'LeftIndexProximal')).toBeGreaterThan(1);
    expect(curl(p, 'LeftLittleIntermediate')).toBeGreaterThan(1);
    expect(curl(p, 'LeftThumbProximal')).toBeGreaterThan(0.5);
    expect(Math.abs(dec(p, 'LeftIndexProximal').rN)).toBeLessThan(1e-4);   // боковой развод — ноль (1e-4 = округление позы до 5 знаков)
  });

  it('ГЛАВНОЕ: правая кисть — точное зеркало левой (канон-зеркало `mirrorSide`)', () => {
    // Этот тест — спецификация знаков. Ось сгиба сама зеркальна (plane_R = −plane_L), поэтому у сгиба
    // пер-стороннего множителя быть НЕ должно; ось твиста полярна, поэтому у противопоставления — должен.
    for (const g of BUILTIN_GRIPS) {
      const l = gripToPose(g, 'Left'), r = gripToPose(g, 'Right');
      const m = mirrorSide(l, 'Left');
      for (const k in r) for (let i = 0; i < 3; i++) expect(r[k]![i]!, `${g.id}/${k}[${i}]`).toBeCloseTo(m[k]![i]!, 6);
    }
  });

  it('обе кисти сгибаются в кулак ОДИНАКОВО (знак сидит в оси, а не в множителе)', () => {
    const both = gripToPoseBoth(findGrip('fist')!, findGrip('fist')!);
    expect(curl(both, 'LeftIndexProximal')).toBeGreaterThan(1);
    expect(curl(both, 'RightIndexProximal')).toBeGreaterThan(1);
  });

  it('слайдер «сжатие» линейно масштабирует хват', () => {
    const full = gripToPose(findGrip('fist')!, 'Left', 1);
    const half = gripToPose(findGrip('fist')!, 'Left', 0.5);
    const none = gripToPose(findGrip('fist')!, 'Left', 0);
    expect(curl(half, 'LeftIndexProximal')).toBeCloseTo(curl(full, 'LeftIndexProximal') / 2, 5);
    expect(curl(none, 'LeftIndexProximal')).toBeCloseTo(0, 9);
  });

  it('«указ. палец» оставляет указательный прямым, остальные сжаты', () => {
    const p = gripToPose(findGrip('point')!, 'Left');
    expect(Math.abs(curl(p, 'LeftIndexProximal'))).toBeLessThan(1e-9);
    expect(curl(p, 'LeftMiddleProximal')).toBeGreaterThan(1);
  });

  it('«лук — тетива» цепляет указательный/средний, мизинец почти свободен', () => {
    const p = gripToPose(findGrip('bow_draw')!, 'Left');
    expect(curl(p, 'LeftIndexProximal')).toBeGreaterThan(curl(p, 'LeftLittleProximal') * 2);
  });

  it('у большого пальца есть противопоставление (твист вокруг своей оси), у прочих — нет', () => {
    const p = gripToPose(findGrip('fist')!, 'Left');
    expect(Math.abs(dec(p, 'LeftThumbProximal').twist)).toBeGreaterThan(0.1);
    expect(Math.abs(dec(p, 'LeftIndexProximal').twist)).toBeLessThan(1e-4);   // 1e-4 = округление позы до 5 знаков
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
    expect(curl(p, 'RightIndexProximal')).toBeGreaterThan(0.5);   // меч в правой
    expect(curl(p, 'LeftIndexProximal')).toBeGreaterThan(0.5);    // щит в левой
  });

  it('привязка персонажа перекрывает дефолт', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['warrior'] = { axe: { R: 'open', L: 'open' } };
    const p = resolveGripPose(cfg, 'warrior', 'axe');
    for (const k in p) for (const c of p[k]!) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('свой хват (готовые углы) берётся вместо встроенного, только кости своей кисти', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.custom['my'] = { id: 'my', label: 'мой', pose: { LeftIndexProximal: [0, -0.4, 0], RightIndexProximal: [0, 9, 0] } };
    cfg.byWeapon['w'] = { sword: { L: 'my', R: 'open' } };
    const p = resolveGripPose(cfg, 'w', 'sword');
    expect(p['LeftIndexProximal']).toEqual([0, -0.4, 0]);
    for (const c of p['RightIndexProximal']!) expect(c).toBe(0);   // из встроенного 'open', а не 9 из чужой кисти
  });

  it('сжатие из привязки применяется', () => {
    const cfg: GripConfig = EMPTY_GRIP_CONFIG();
    cfg.byWeapon['w'] = { sword: { R: 'fist', closeR: 0.25 } };
    const p = resolveGripPose(cfg, 'w', 'sword');
    const full = gripToPose(findGrip('fist')!, 'Right');
    expect(curl(p, 'RightIndexProximal')).toBeCloseTo(curl(full, 'RightIndexProximal') * 0.25, 5);
  });
});

describe('gripPoses — наложение на скелет', () => {
  it('на гуманоиде С пальцами хват применяется и кончик уходит К ЛАДОНИ', () => {
    const h = buildHumanoid({ fingers: true });
    const tipBefore = h.bones.get('LeftIndexDistal')!.getWorldPosition(new THREE.Vector3());
    applyGripPose(h.bones, gripToPose(findGrip('fist')!, 'Left'));
    h.root.updateMatrixWorld(true);
    const tipAfter = h.bones.get('LeftIndexDistal')!.getWorldPosition(new THREE.Vector3());
    expect(tipAfter.y).toBeLessThan(tipBefore.y - 0.5);            // вниз, к ладони (она смотрит в −Y)
    expect(Math.abs(tipAfter.z - tipBefore.z)).toBeLessThan(1.0);  // а не вбок, как было при сгибе вокруг Y
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

  it('встроенные хваты укладываются В ПРЕДЕЛЫ суставов пальцев (по их собственным осям)', () => {
    // Раньше этот тест мерил |euler.y| против 100° и после смены оси стал бы вечнозелёным нулём.
    // Теперь он раскладывает поворот по осям сустава и сверяет с реальными planeMin/planeMax.
    for (const g of BUILTIN_GRIPS) {
      for (const side of ['Left', 'Right'] as const) {
        const p = gripToPose(g, side);
        for (const k in p) {
          const view = extraLimitView(k)!;
          const d = dec(p, k);
          expect(d.rP, `${g.id}/${k} сгиб`).toBeLessThanOrEqual(view.planeMax! + 1e-6);
          expect(d.rP, `${g.id}/${k} переразгиб`).toBeGreaterThanOrEqual(view.planeMin! - 1e-6);
          expect(Math.abs(d.twist), `${g.id}/${k} твист`).toBeLessThanOrEqual(Math.max(Math.abs(view.twistMin!), Math.abs(view.twistMax!)) + 1e-6);
        }
      }
    }
  });
});
