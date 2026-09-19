import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { GAIT, GAIT_BASE, POSE, POSE_BASE, ASYM, STRAFE, BACK, COMBAT, type PoseTargets } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';
import { gaitToHumanoid, localStorageContent, type AttackState } from './poseRuntime.js';
import { groundFeet } from './footIk.js';

/**
 * КУДА СМОТРЯТ КОЛЕНИ И ЛОКТИ.
 *
 * Жалоба: «сейчас только сгиб регулируется» — то есть ВЕЛИЧИНА складывания сустава, но не СТОРОНА,
 * в которую он складывается. Так и было: каналы твиста вышележащей кости (`hipTw` у бедра, `shTw` у
 * плеча) в риге есть давно, но процедурная поза клала в них жёсткий ноль, и колено всегда смотрело
 * строго вперёд, а локоть — строго назад.
 *
 * Направление сгиба двухкостной конечности — это ПОЛЮС: вынос среднего сустава в сторону от прямой
 * «верх → низ». Поэтому и меряем здесь именно его, а не угол ручки: ручка может стоять, а полюс —
 * никуда не уехать (ровно так и выглядела бы «ручка не работает»).
 *
 * ⚠ ЗНАК У РУК ОБРАТЕН ЗНАКУ У НОГ, и это замер, а не догадка: рука опускается поворотом по Z, и
 * тот же твист по Y даёт ей другую сторону. Поэтому в `pose.ts` у рук стоит минус — чтобы ОДИН и тот
 * же «+» разводил наружу и колени, и локти.
 */
const DT = 1 / 60;
const atk: AttackState = { clip: null, t: -1, rate: 1 } as unknown as AttackState;
const KNOBS_G = ['kneeDir', 'kneeDirRun', 'kneeDirMax'] as const;
const KNOBS_P = ['elbowDir', 'elbowDirRun'] as const;

const restore = (): void => {
  for (const k of KNOBS_G) (GAIT as unknown as Record<string, number>)[k] = GAIT_BASE[k]!;
  for (const k of KNOBS_P) (POSE as unknown as Record<string, number>)[k] = POSE_BASE[k]!;
  for (const m of [ASYM as unknown as Record<string, unknown>, STRAFE, BACK, COMBAT]) for (const k of Object.keys(m)) delete m[k];
};
const setKnee = (v: number): void => { GAIT.kneeDir = v; GAIT.kneeDirRun = v; };
const setElbow = (v: number): void => { POSE.elbowDir = v; POSE.elbowDirRun = v; };

/** Полюс: вынос среднего сустава от прямой «верх → низ», в МИРЕ. Модуль ≈ 0 → сустав смотрит «вдоль». */
const pole = (h: ReturnType<typeof buildHumanoid>, a: string, b: string, c: string): THREE.Vector3 => {
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  h.bones.get(a)!.getWorldPosition(A); h.bones.get(b)!.getWorldPosition(B); h.bones.get(c)!.getWorldPosition(C);
  const d = C.clone().sub(A); const t = B.clone().sub(A).dot(d) / (d.lengthSq() || 1);
  return B.clone().sub(A.clone().addScaledVector(d, t));
};

/** Установившаяся ходьба + полный рантайм-ретаргет на кости (именно он и обязан донести твист). */
const walk = (): { h: ReturnType<typeof buildHumanoid>; t: PoseTargets; sw: boolean[] } => {
  const h = buildHumanoid({});
  const d = new PoseDriver();
  let z = 0, t = d.update(DT);
  for (let i = 0; i < 240; i++) { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); t = d.update(DT); }
  gaitToHumanoid(h, [], { armDown: 1.35, elbowBend: 0.25 }, 1, t, localStorageContent('__none__'), 'none', atk, 1, true);
  h.root.updateMatrixWorld(true);
  return { h, t, sw: [...d.swingLegs] };
};
/** Сдвиг полюса по X относительно нулевой ручки: + = наружу для ЛЕВОЙ, − = наружу для ПРАВОЙ. */
const spread = (knee: number, elbow: number, max?: number): { kL: number; kR: number; eL: number; eR: number } => {
  restore(); const z = walk();
  restore(); setKnee(knee); setElbow(elbow); if (max !== undefined) GAIT.kneeDirMax = max; const v = walk();
  const dx = (w: typeof z, a: string, b: string, c: string): number => pole(w.h, a, b, c).x;
  return {
    kL: dx(v, 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot') - dx(z, 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot'),
    kR: dx(v, 'RightUpperLeg', 'RightLowerLeg', 'RightFoot') - dx(z, 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'),
    eL: dx(v, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand') - dx(z, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand'),
    eR: dx(v, 'RightUpperArm', 'RightLowerArm', 'RightHand') - dx(z, 'RightUpperArm', 'RightLowerArm', 'RightHand'),
  };
};

describe('ручка разворачивает сустав, а не только гнёт его', () => {
  beforeEach(restore);

  it('⭐ колени разъезжаются НАРУЖУ обе сразу, а не уезжают вдвоём влево', () => {
    const out = spread(0.4, 0);
    expect(out.kL, 'левое колено ушло наружу (+X)').toBeGreaterThan(0.8);
    expect(out.kR, 'правое — тоже наружу (−X)').toBeLessThan(-0.8);
    expect(Math.abs(out.kL + out.kR), 'зеркально, без перекоса').toBeLessThan(0.05);
  });

  it('⭐ локти — ТЕМ ЖЕ знаком наружу (у рига знак обратный, в коде стоит минус)', () => {
    const out = spread(0, 0.4);
    expect(out.eL, 'левый локоть наружу (+X)').toBeGreaterThan(0.8);
    expect(out.eR, 'правый локоть наружу (−X)').toBeLessThan(-0.8);
  });

  it('минус в ручке сводит суставы ВНУТРЬ — ручка двусторонняя', () => {
    const out = spread(-0.4, -0.4);
    expect(out.kL, 'левое колено внутрь').toBeLessThan(-0.8);
    expect(out.kR, 'правое колено внутрь').toBeGreaterThan(0.8);
    expect(out.eL, 'левый локоть внутрь').toBeLessThan(-0.8);
    expect(out.eR, 'правый локоть внутрь').toBeGreaterThan(0.8);
  });

  it('в нуле колено смотрит РОВНО вперёд — значит до правки ручки и не было', () => {
    const { h } = walk();
    expect(Math.abs(pole(h, 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot').x), 'полюс без бокового выноса').toBeLessThan(1e-6);
    expect(Math.abs(pole(h, 'RightUpperLeg', 'RightLowerLeg', 'RightFoot').x)).toBeLessThan(1e-6);
  });
});

describe('потолок сустава', () => {
  beforeEach(restore);

  it('⚠ поз-угол НИКОГДА не выходит за твист-предел бедра', () => {
    setKnee(3);                                   // заведомо через край
    const d = new PoseDriver();
    let z = 0, peak = 0;
    for (let i = 0; i < 240; i++) { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); const t = d.update(DT); peak = Math.max(peak, Math.abs(t.hipTwL), Math.abs(t.hipTwR)); }
    expect(peak, 'зажат потолком').toBeLessThanOrEqual(GAIT.kneeDirMax + 1e-9);
    expect(peak, 'и потолок реально достигается — иначе проверять нечего').toBeCloseTo(GAIT.kneeDirMax, 6);
  });

  it('потолок настраивается — опускаем ручку, садится и разворот', () => {
    const tight = spread(3, 0, 0.2), wide = spread(3, 0, 0.7);
    expect(Math.abs(wide.kL)).toBeGreaterThan(Math.abs(tight.kL) + 0.5);
  });

  it('у локтя потолка-ручки нет, но за пол-оборота не пускаем', () => {
    setElbow(99);
    const d = new PoseDriver();
    let z = 0, peak = 0;
    for (let i = 0; i < 240; i++) { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); const t = d.update(DT); peak = Math.max(peak, Math.abs(t.shTwL), Math.abs(t.shTwR)); }
    expect(peak, 'по эту сторону π').toBeLessThan(Math.PI);
    expect(peak, 'и вплотную к нему').toBeGreaterThan(Math.PI - 0.01);
  });
});

describe('ручка живёт в общей цепочке колонок (шесть конфигов локомоции)', () => {
  beforeEach(restore);

  it('страйф-колонка перебивает разворот колена', () => {
    setKnee(0.2); STRAFE['kneeDir'] = -0.6; STRAFE['kneeDirRun'] = -0.6;
    const d = new PoseDriver();
    let x = 0, fwd = 0, side = 0;
    for (let i = 0; i < 240; i++) { x += 60 * DT; d.setWorld(x, 0, 0, 60, 0); const t = d.update(DT); side = t.hipTwL; }   // СТРАЙФ: лицом на +Z (yaw=0), едем по +X
    const d2 = new PoseDriver();
    let z = 0;
    for (let i = 0; i < 240; i++) { z += 60 * DT; d2.setWorld(0, z, 0, 0, 60); const t = d2.update(DT); fwd = t.hipTwL; }
    expect(fwd, 'прямо — базовая ручка').toBeCloseTo(0.2, 3);
    expect(side, 'вбок — колонка страйфа').toBeLessThan(-0.3);
  });

  it('боевая колонка тоже видна — иначе бой читал бы мирные числа', () => {
    setKnee(0.1); COMBAT['kneeDir'] = 0.6; COMBAT['kneeDirRun'] = 0.6;
    const d = new PoseDriver(); d.setCombat(1);
    let z = 0, v = 0;
    for (let i = 0; i < 240; i++) { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); v = d.update(DT).hipTwL; }
    expect(v).toBeCloseTo(0.6, 3);
  });
});

describe('рантайм доносит угол до костей и до игры', () => {
  beforeEach(restore);

  it('⭐ угол ложится на кость бедра (сторож против «поза считает, кость не знает»)', () => {
    setKnee(0.3);
    const { h, t } = walk();
    expect(t.hipTwL, 'поза посчитала').toBeCloseTo(0.3, 6);
    expect(h.bones.get('LeftUpperLeg')!.rotation.y, 'и кость это получила').toBeCloseTo(t.hipTwL, 6);
    expect(h.bones.get('RightUpperLeg')!.rotation.y).toBeCloseTo(t.hipTwR, 6);
  });

  it('нули в ручках = прежнее поведение бит в бит (каналы были жёстким нулём)', () => {
    const d = new PoseDriver();
    let z = 0;
    for (let i = 0; i < 240; i++) { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); const t = d.update(DT);
      expect(t.hipTwL + t.hipTwR + t.shTwL + t.shTwR, 'ни один канал не шелохнулся').toBe(0); }
  });

  it('⭐ ЗАЗЕМЛЕНИЕ НЕ СЪЕДАЕТ РАЗВОРОТ ОПОРНОЙ НОГИ (иначе работал бы только мах)', () => {
    // Полюс колена `groundFeet` берёт из ПОЗИРОВАННОГО бедра — ровно затем, чтобы твист пережил
    // прижатие стопы к полу. Проверяем замером: стопа — единственное место, где заземление имеет право
    // переписать позу, и один раз оно уже стёрло ручки голеностопа ([[editor-equals-game]]).
    //
    // ⚠ Мерим РАЗНИЦУ между ручкой и нулём, а не абсолютный полюс: заземление и без всякого
    // твиста уводит колено вбок (замер: 0.08 → 2.24), потому что дотягивает стопу до пола с 24 единиц.
    const at = (v: number): { leg: string; before: number; after: number } => {
      restore(); setKnee(v);
      const h = buildHumanoid({});
      const d = new PoseDriver();
      let z = 0, t = d.update(DT), sw = [...d.swingLegs];
      const step = (): void => { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); t = d.update(DT); sw = [...d.swingLegs]; };
      for (let i = 0; i < 240; i++) step();
      for (let i = 0; i < 60 && sw[0] && sw[1]; i++) step();          // дожидаемся кадра С ОПОРНОЙ НОГОЙ:
      expect(sw[0] && sw[1], 'опорная нога обязана найтись').toBe(false);   // на двух маховых заземление не работает вовсе
      gaitToHumanoid(h, [], { armDown: 1.35, elbowBend: 0.25 }, 1, t, localStorageContent('__none__'), 'none', atk, 1, true);
      h.root.updateMatrixWorld(true);
      const leg = !sw[0] ? 'Left' : 'Right', sign = leg === 'Left' ? 1 : -1;   // знак: «наружу» для этой стороны
      const before = sign * pole(h, `${leg}UpperLeg`, `${leg}LowerLeg`, `${leg}Foot`).x;
      groundFeet(h, h.hipsWorldY(), { off: 0 }, 1e3, () => 0, [!sw[0], !sw[1]]);
      h.root.updateMatrixWorld(true);
      return { leg, before, after: sign * pole(h, `${leg}UpperLeg`, `${leg}LowerLeg`, `${leg}Foot`).x };
    };
    const zero = at(0), out = at(0.5), inw = at(-0.5);
    expect(out.leg, 'сравниваем ОДНУ и ту же ногу').toBe(zero.leg);
    expect(inw.leg).toBe(zero.leg);
    expect(out.before - zero.before, 'до заземления разворот есть').toBeGreaterThan(1);
    expect(out.after - zero.after, '⭐ и ПОСЛЕ заземления колено всё так же развёрнуто наружу').toBeGreaterThan(1);
    // ВНУТРЬ дельта ЗАМЕТНО МЕНЬШЕ (−з0.72 против +5.12 наружу), и это не дефект ручки:
    // нейтральный полюс после заземления и так уже уехал внутрь (−2.24), и с той стороны осталось меньше хода.
    expect(inw.after - zero.after, 'и внутрь — тоже').toBeLessThan(-0.3);
  });
});
