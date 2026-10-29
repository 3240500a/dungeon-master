import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { detrendTravel, readFootTargets, readLimbTarget, groundTargets, clampHipsToFeet, lockFeet, lockLimb, refPose, LIMBS, type Vec3 } from './footLock.js';
import type { Pose } from './clipModel.js';
import { legReach } from './footIk.js';

describe('footLock — травел снимается ТРЕНДОМ, а не опорой стоп', () => {
  it('IN-PLACE источник (таз стоит) остаётся НА МЕСТЕ — ничего не выдумываем', () => {
    // Это и есть замер, который развернул решение: у нашего `walk_fwd` сырое смещение таза ровно 0
    // на всех кадрах, а стопы ходят ±12. Покадровое вычитание опоры давало 3.95 (по среднему) и 21.68
    // (по опорной) юнита качания из ниоткуда.
    const hips: Vec3[] = Array.from({ length: 30 }, () => [0, 0, 0]);
    for (const h of detrendTravel(hips, 'full')) { expect(h[0]).toBeCloseTo(0, 6); expect(h[2]).toBeCloseTo(0, 6); }
  });

  it('РАВНОМЕРНЫЙ ТРАВЕЛ снимается целиком', () => {
    const hips: Vec3[] = Array.from({ length: 30 }, (_, i) => [0, 0, i * 4]);
    for (const h of detrendTravel(hips, 'full')) expect(h[2]).toBeCloseTo(0, 6);
  });

  it('ПЕРЕНОС ВЕСА (ушёл вперёд и вернулся) ОСТАЁТСЯ целиком', () => {
    // Именно здесь МНК был бы неправ: он видит в дуге наклон и срезает часть размаха.
    const hips: Vec3[] = Array.from({ length: 41 }, (_, i) => [0, 0, Math.sin(i / 40 * Math.PI * 2) * 5]);
    const out = detrendTravel(hips, 'full');
    const span = Math.max(...out.map((h) => h[2])) - Math.min(...out.map((h) => h[2]));
    expect(span).toBeCloseTo(10, 0);
  });

  it('травел И перенос веса вместе: тренд ушёл, качание цело', () => {
    const hips: Vec3[] = Array.from({ length: 41 }, (_, i) => [0, 0, i * 3 + Math.sin(i / 40 * Math.PI * 2) * 5]);
    const out = detrendTravel(hips, 'full');
    expect(Math.abs(out[out.length - 1]![2] - out[0]![2])).toBeLessThan(1);      // тренда нет
    expect(Math.max(...out.map((h) => h[2])) - Math.min(...out.map((h) => h[2]))).toBeGreaterThan(8);
  });

  it('постоянный офсет (мокап снят в стороне от нуля) — это не движение', () => {
    const hips: Vec3[] = Array.from({ length: 10 }, () => [120, -2, -80]);
    for (const h of detrendTravel(hips, 'full')) { expect(h[0]).toBeCloseTo(0, 6); expect(h[2]).toBeCloseTo(0, 6); }
  });

  it('ВЕРТИКАЛЬ не трогаем никогда — присед это движение тела', () => {
    const hips: Vec3[] = Array.from({ length: 10 }, (_, i) => [i, -3 - i * 0.1, i]);
    const out = detrendTravel(hips, 'full');
    expect(out[5]![1]).toBeCloseTo(-3.5, 6);
    expect(detrendTravel(hips, 'vertical')[5]).toEqual([0, -3.5, 0]);
    expect(detrendTravel(hips, 'none')[5]).toEqual([0, 0, 0]);
  });

  it('один кадр и пустой клип не роняют расчёт', () => {
    expect(detrendTravel([[5, 1, 5]], 'full')[0]).toEqual([0, 1, 0]);
    expect(detrendTravel([], 'full')).toEqual([]);
  });
});

describe('footLock — пины стоп', () => {
  const hipsAt = (H: ReturnType<typeof buildHumanoid>, d: [number, number, number]): void => {
    H.hips.position.set(H.hipsRest.x + d[0], H.hipsRest.y + d[1], H.hipsRest.z + d[2]);
    H.root.updateMatrixWorld(true);
  };
  /**
   * Риг в РЕАЛЬНОЙ СТОЙКЕ: колени чуть согнуты. Пины проверять на T-позе нельзя — там нога выпрямлена
   * ровно на свою длину, и ЛЮБОЙ горизонтальный сдвиг таза недосягаем по построению (это не дефект
   * солвера, а геометрия). В авторских стойках слабина в колене есть всегда.
   */
  const stance = (): ReturnType<typeof buildHumanoid> => {
    const H = buildHumanoid();
    for (const s of [-1, 1]) {
      H.bones.get(s < 0 ? 'LeftUpperLeg' : 'RightUpperLeg')!.rotation.x = -0.35;
      H.bones.get(s < 0 ? 'LeftLowerLeg' : 'RightLowerLeg')!.rotation.x = 0.7;
      H.bones.get(s < 0 ? 'LeftFoot' : 'RightFoot')!.rotation.x = -0.35;
    }
    H.root.updateMatrixWorld(true);
    return H;
  };

  it('ЦЕЛЬ ДЕРЖИТСЯ: таз подали вперёд — стопы остались на месте', () => {
    const H = stance();
    const targets = readFootTargets(H);                       // цели сняты в стойке
    hipsAt(H, [0, -2, 6]);                                    // перенос веса вперёд с приседом
    const before = H.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).distanceTo(targets[0]!.pos);
    expect(before).toBeGreaterThan(5);                        // без пина стопа уехала за тазом
    const miss = lockFeet(H, targets, 1);
    expect(miss).toBeLessThan(0.2);                           // с пином — вернулась в цель
  });

  it('СИЛА (Reach): 0 — стопа едет за телом, 0.5 — на полпути', () => {
    const mk = (w: number): number => {
      const H = stance();
      const t = readFootTargets(H);
      hipsAt(H, [0, 0, 4]);
      const away = H.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).distanceTo(t[0]!.pos);
      lockFeet(H, t, w);
      return H.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).distanceTo(t[0]!.pos) / away;
    };
    expect(mk(0)).toBeCloseTo(1, 1);
    expect(mk(0.5)).toBeCloseTo(0.5, 1);
    expect(mk(1)).toBeLessThan(0.05);
  });

  it('«ДАЛЬШЕ НЕ ПУЩУ»: недосягаемый перенос веса УКОРАЧИВАЕТСЯ, стопа не отрывается', () => {
    const H = stance();
    const t = readFootTargets(H);
    hipsAt(H, [0, 0, 400]);                                   // абсурдный сдвиг
    const moved = clampHipsToFeet(H, t);
    expect(moved).toBeGreaterThan(300);                        // таз честно оттащили назад
    for (let i = 0; i < 2; i++) {
      const root = H.bones.get(i ? 'RightUpperLeg' : 'LeftUpperLeg')!.getWorldPosition(new THREE.Vector3());
      expect(root.distanceTo(t[i]!.pos)).toBeLessThanOrEqual(legReach(H, i) + 1e-3);   // нога не длиннее себя
    }
    expect(lockFeet(H, t, 1)).toBeLessThan(0.6);
  });

  it('достижимый сдвиг клэмп НЕ трогает', () => {
    const H = stance();
    const t = readFootTargets(H);
    hipsAt(H, [0, -3, 0]);                                     // присед — ноги легко достают
    expect(clampHipsToFeet(H, t)).toBeCloseTo(0, 3);
  });

  it('заземляем ЦЕЛИ, а не таз: нижняя цель встаёт на подошву', () => {
    const H = stance();
    hipsAt(H, [0, -9, 0]);
    const t = readFootTargets(H);
    expect(Math.min(...t.map((x) => x!.pos.y))).toBeLessThan(0);
    groundTargets(t);
    expect(Math.min(...t.map((x) => x!.pos.y))).toBeCloseTo(1.5, 5);   // 1.5 = SOLE
  });

  it('пропущенная нога (пин только на одну) вторую не трогает', () => {
    const H = stance();
    const t = readFootTargets(H); t[1] = null;                 // держим только левую
    hipsAt(H, [0, 0, 3]);
    const rBefore = H.bones.get('RightFoot')!.getWorldPosition(new THREE.Vector3()).clone();
    lockFeet(H, t, 1);
    expect(H.bones.get('RightFoot')!.getWorldPosition(new THREE.Vector3()).distanceTo(rBefore)).toBeCloseTo(0, 5);
    expect(H.bones.get('LeftFoot')!.getWorldPosition(new THREE.Vector3()).distanceTo(t[0]!.pos)).toBeLessThan(0.2);
  });

  it('вес 0 = пинов нет вовсе (ни одной кости не тронули)', () => {
    const H = stance();
    const t = readFootTargets(H);
    hipsAt(H, [0, 0, 4]);
    const q = H.bones.get('LeftUpperLeg')!.quaternion.clone();
    expect(lockFeet(H, t, 0)).toBe(0);
    expect(H.bones.get('LeftUpperLeg')!.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });

  it('rest-поза с пинами — НЕ ШЕВЕЛИТСЯ (нога выпрямлена ровно на свою длину, но это достижимо)', () => {
    // Регрессия: `legGeom().max` = thigh+shin−0.5 — солверный запас; если брать его как досягаемость,
    // клэмп срабатывал бы в покое и дёргал таз на ровном месте.
    const H = buildHumanoid();
    const t = readFootTargets(H);
    expect(clampHipsToFeet(H, t)).toBeCloseTo(0, 4);
  });
});

describe('footLock — опорная поза: сколько цепи принадлежит конечности', () => {
  const P = (o: Record<string, [number, number, number]>): Pose => o;

  it('вес 1 — цепь как в мокапе (опорная поза = финальной, пин это no-op)', () => {
    const pose = P({ Hips: [0, 0.6, 0], LeftUpperLeg: [0.2, 0, 0] });
    expect(refPose(pose, P({ Hips: [0, 0, 0] }), ['Hips'], 1)).toBe(pose);
  });

  it('вес 0 — цепь из БАЗОВОЙ позы (конечность её не заказывала)', () => {
    const r = refPose(P({ Hips: [0, 0.6, 0], LeftUpperLeg: [0.2, 0, 0] }), P({ Hips: [0, -0.1, 0] }), ['Hips'], 0);
    expect(r['Hips']).toEqual([0, -0.1, 0]);
    expect(r['LeftUpperLeg']).toEqual([0.2, 0, 0]);      // сама конечность не тронута
  });

  it('вес 0.5 — ровно посередине', () => {
    const r = refPose(P({ Hips: [0, 0.8, 0] }), P({ Hips: [0, 0, 0] }), ['Hips'], 0.5);
    expect(r['Hips']![1]).toBeCloseTo(0.4, 3);
  });

  it('нет базовой позы → цепь приводится к покою (rest), а не остаётся мокапом', () => {
    expect(refPose(P({ Spine: [0, 0.9, 0] }), undefined, ['Spine'], 0)['Spine']).toEqual([0, 0, 0]);
  });

  it('исходная поза НЕ мутируется (она уходит в клип)', () => {
    const pose = P({ Hips: [0, 0.6, 0] });
    refPose(pose, P({ Hips: [0, 0, 0] }), ['Hips'], 0);
    expect(pose['Hips']).toEqual([0, 0.6, 0]);
  });

  it('цепь руки длиннее ноги: у руки весь позвоночник, у ноги только таз', () => {
    const arm = LIMBS.find((L) => L.id === 'RH')!, leg = LIMBS.find((L) => L.id === 'RF')!;
    expect([...arm.chain]).toEqual(['Hips', 'Spine', 'Chest', 'UpperChest']);
    expect([...leg.chain]).toEqual(['Hips']);
  });
});

describe('footLock — пин КИСТИ (жалоба «рукам понижаю силу — уезжают от синих хелперов»)', () => {
  const armPose = (): ReturnType<typeof buildHumanoid> => {
    const H = buildHumanoid();
    H.bones.get('RightUpperArm')!.rotation.z = -0.5;      // рука опущена и согнута — как в стойке
    H.bones.get('RightLowerArm')!.rotation.y = 0.6;
    H.root.updateMatrixWorld(true);
    return H;
  };
  const RH = LIMBS.find((L) => L.id === 'RH')!;
  const handAt = (H: ReturnType<typeof buildHumanoid>): THREE.Vector3 =>
    H.bones.get('RightHand')!.getWorldPosition(new THREE.Vector3());

  it('корпус скрутился — кисть ОСТАЛАСЬ на месте', () => {
    const H = armPose();
    const t = readLimbTarget(H, RH);
    H.bones.get('Spine')!.rotation.y = 0.25; H.bones.get('Chest')!.rotation.y = 0.2;   // скрутка корпуса
    H.root.updateMatrixWorld(true);
    expect(handAt(H).distanceTo(t!.pos)).toBeGreaterThan(3);        // без пина кисть уехала со скруткой
    expect(lockLimb(H, RH, t, 1)).toBeLessThan(0.2);               // с пином — вернулась
  });

  it('сила 0.5 — на полпути (тот же Reach, что у стоп)', () => {
    const H = armPose();
    const t = readLimbTarget(H, RH);
    H.bones.get('Spine')!.rotation.y = 0.4; H.root.updateMatrixWorld(true);
    const away = handAt(H).distanceTo(t!.pos);
    lockLimb(H, RH, t, 0.5);
    expect(handAt(H).distanceTo(t!.pos) / away).toBeCloseTo(0.5, 1);
  });

  it('кисть УЖЕ в цели → рука не пересчитывается вхолостую', () => {
    const H = armPose();
    const q = H.bones.get('RightUpperArm')!.quaternion.clone();
    expect(lockLimb(H, RH, readLimbTarget(H, RH), 1)).toBe(0);
    expect(H.bones.get('RightUpperArm')!.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });
});
