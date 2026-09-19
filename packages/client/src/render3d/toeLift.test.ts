import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { GAIT, GAIT_BASE, ASYM, STRAFE, BACK, COMBAT, locoVal, toeCurve, type LocoMix, type PoseTargets } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';
import { gaitToHumanoid, localStorageContent, type AttackState } from './poseRuntime.js';

/**
 * ГОЛЕНОСТОП: СТОПА ДЕРЖИТ ПОДОШВУ, А НЕ ЕДЕТ ЗА ГОЛЕНЬЮ.
 *
 * Жалоба: «стопа в планировщике шагов не работает вообще», носок чиркает по полу, когда нога идёт
 * вперёд. Так и было буквально: поза ставила кости стопы жёсткий ноль, то есть голеностопа НЕ
 * СУЩЕСТВОВАЛО — стопа наследовала ориентацию голени как приваренная.
 *
 * ⚠ Причина оказалась НЕ в том, что «носок мало поднимается». Замер покадрово: наклон стопы =
 * `бедро + колено + константа рига` (расхождение 0.165 рад держится и на отрыве, и на приземлении).
 * На отрыве голень наклонена на 54°, и стопа вместе с ней разворачивалась носком вниз на 82°.
 * Поэтому главная ручка — УДЕРЖАНИЕ подошвы (`ankLevel`), гасящее сумму бедра и колена, а подъём
 * носка (`toeLift`) — уже добавка стиля поверх неё.
 *
 * ⚠ Правится ТОЛЬКО маховая нога: заземление (`footIk.groundFeet`) владеет опорной и кладёт её
 * плоско, а маховую сознательно оставляет позе. Ручка «носок в опоре» была бы мёртвой.
 */
const DT = 1 / 60;
const mix = (sb: number, st = 0, bt = 0, ct = 0, stR = 0, stL = 0): LocoMix => ({ sb, st, stR, stL, bt, ct });
const KNOBS = ['ankLevel', 'ankLevelRun', 'toeLift', 'toeLiftRun', 'toeLiftPhase', 'toeLiftPhaseRun', 'ankMax'] as const;

const clearCols = (): void => {
  for (const m of [ASYM as unknown as Record<string, unknown>, STRAFE, BACK, COMBAT]) for (const k of Object.keys(m)) delete m[k];
};
const restoreGait = (): void => { for (const k of KNOBS) (GAIT as unknown as Record<string, number>)[k] = (GAIT_BASE as unknown as Record<string, number>)[k]!; };
const killAnkle = (): void => { for (const k of KNOBS) if (k !== 'toeLiftPhase' && k !== 'toeLiftPhaseRun') (GAIT as unknown as Record<string, number>)[k] = 0; };

/**
 * КЛИРЕНС НОСКА — главный показатель этой правки.
 *
 * Меряем высоту носка в переносе относительно ЕГО ЖЕ высоты, когда стопа стоит на полу. Это и есть
 * «чиркает или нет», и это единственный честный эталон: абсолютные высоты здесь не годятся, потому
 * что в живом кадре весь риг ещё подтягивает заземление, а «носок над лодыжкой» смешан с наклоном
 * всей ноги (на бегу колено согнуто сильнее — замер давал −0.27 там, где подъём БОЛЬШЕ).
 */
const toeClearance = (speed: number): { gap: number; tiltDeg: number; frames: number } => {
  const h = buildHumanoid({});
  const d = new PoseDriver();
  const hips = h.bones.get('Hips')!, foot = h.bones.get('LeftFoot')!, toe = h.bones.get('LeftToes')!;
  const up = h.bones.get('LeftUpperLeg')!, lo = h.bones.get('LeftLowerLeg')!;
  const pt = new THREE.Vector3(), pf = new THREE.Vector3();
  let z = 0, minSwing = Infinity, minStance = Infinity, maxTilt = -Infinity, frames = 0;
  for (let i = 0; i < 300; i++) {
    z += speed * DT;
    d.setWorld(0, z, 0, 0, speed);
    const t = d.update(DT);
    hips.position.y = 30 + t.bobY;
    up.rotation.set(t.hipL, t.hipTwL, t.hipLatL);
    lo.rotation.set(t.knL, 0, 0);
    foot.rotation.set(t.ankL, 0, 0);
    h.root.updateMatrixWorld(true);
    if (i <= 150) continue;                       // разгон пропускаем: там ещё приставные шаги и осадка стойки
    toe.getWorldPosition(pt); foot.getWorldPosition(pf);
    if (d.swingLegs[0]) {
      minSwing = Math.min(minSwing, pt.y);
      maxTilt = Math.max(maxTilt, Math.atan2(pf.y - pt.y, Math.abs(pt.z - pf.z)));   // + = носком ВНИЗ
      frames++;
    } else minStance = Math.min(minStance, pt.y);
  }
  return { gap: minSwing - minStance, tiltDeg: maxTilt * 180 / Math.PI, frames };
};

describe('замер: носок больше не волочится по полу', () => {
  beforeEach(() => { clearCols(); restoreGait(); });

  it('⭐ клиренс носка вырос на КАЖДОЙ скорости, и сильнее всего там, где было хуже всего', () => {
    for (const sp of [50, 110, 160]) {
      restoreGait();
      const after = toeClearance(sp);
      killAnkle();
      const before = toeClearance(sp);
      restoreGait();
      expect(after.frames, `${sp}: маховых кадров должно набраться`).toBeGreaterThan(30);
      expect(after.gap, `${sp} ед/с: клиренс ${before.gap.toFixed(2)} -> ${after.gap.toFixed(2)}`).toBeGreaterThan(before.gap + 1.5);
      expect(after.gap, `${sp} ед/с: запас должен быть ощутимым`).toBeGreaterThan(2.5);
    }
  });

  it('⭐ стопа больше не заваливается носком вниз вслед за голенью', () => {
    // Было 82-85°: стопа приварена к голени. Стало ~57° — и это ПРЕДЕЛ СУСТАВА, а не недоработка:
    // `ankMax` держит поз-угол в ±0.45. Сустав `FootL/FootR` с 17.09.2026 шире (вверх 0.7 / вниз 1.05), так что
    // теперь держит именно `ankMax` походки. Без предела вышло бы 9°. Хочешь ровнее — поднимай `ankMax`
    // (не дальше сустава в `humanoidRagdoll`, иначе манекен попросит того, чего призрак не даст).
    const after = toeClearance(110);
    killAnkle();
    const before = toeClearance(110);
    restoreGait();
    expect(before.tiltDeg, 'до правки стопа заваливалась носком вниз').toBeGreaterThan(60);
    expect(before.tiltDeg - after.tiltDeg, 'завал уменьшился заметно').toBeGreaterThan(20);
    expect(after.tiltDeg, 'но не ниже, чем позволяет сустав').toBeLessThan(65);
  });

  it('⚠ поз-угол НИКОГДА не выходит за предел сустава', () => {
    // Ровно это и было жалобой «настройки на стопу не влияют»: поза просила до −1.40 рад (−80°),
    // призрак упирался в ±0.45, и ручка визуально не делала ничего.
    GAIT.ankLevel = 3; GAIT.ankLevelRun = 3; GAIT.toeLift = 1.2; GAIT.toeLiftRun = 1.2;   // заведомо через край
    const d = new PoseDriver();
    let z = 0, peak = 0, seen = 0;
    for (let i = 0; i < 260; i++) {
      z += 60 * DT;
      d.setWorld(0, z, 0, 0, 60);
      const t = d.update(DT);
      peak = Math.max(peak, Math.abs(t.ankL), Math.abs(t.ankR));
      if (d.swingLegs[0]) seen++;
    }
    expect(seen, 'перенос должен был случиться').toBeGreaterThan(40);
    expect(peak, 'угол зажат потолком').toBeLessThanOrEqual(GAIT.ankMax + 1e-9);
    expect(peak, 'и потолок реально достигается — иначе проверять нечего').toBeCloseTo(GAIT.ankMax, 6);
  });

  it('нули в ручках = прежнее поведение бит в бит', () => {
    killAnkle();
    const d = new PoseDriver();
    let z = 0, seen = 0;
    for (let i = 0; i < 240; i++) {
      z += 60 * DT;
      d.setWorld(0, z, 0, 0, 60);
      const t = d.update(DT);
      expect(Math.abs(t.ankL)).toBe(0); expect(Math.abs(t.ankR)).toBe(0);
      if (d.swingLegs[0]) seen++;
    }
    expect(seen, 'перенос должен был случиться').toBeGreaterThan(40);
  });
});

describe('кривая подъёма', () => {
  it('ноль на отрыве и ноль на приземлении — иначе стопа дёрнется в обоих концах', () => {
    for (const ph of [0.2, 0.45, 0.8]) {
      expect(toeCurve(0, ph), `пик ${ph}`).toBeCloseTo(0, 6);
      expect(toeCurve(1, ph), `пик ${ph}`).toBeCloseTo(0, 6);
    }
  });

  it('единица ровно в заданной точке пика', () => {
    for (const ph of [0.2, 0.45, 0.5, 0.8]) expect(toeCurve(ph, ph), `пик ${ph}`).toBeCloseTo(1, 6);
  });

  it('нигде не вылезает за 0..1 — иначе ползунок врал бы про амплитуду', () => {
    for (const ph of [0.05, 0.3, 0.95]) {
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const v = toeCurve(t, ph);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('пик сдвигается ползунком, а не стоит намертво в середине', () => {
    expect(toeCurve(0.25, 0.25), 'ранний пик').toBeCloseTo(1, 6);
    expect(toeCurve(0.25, 0.75), 'поздний пик — в той же точке ещё не пик').toBeLessThan(0.8);
  });
});

describe('опорная нога стопу не наклоняет', () => {
  beforeEach(() => { clearCols(); restoreGait(); });

  it('пока нога на земле, угол стопы РОВНО ноль', () => {
    const d = new PoseDriver();
    let z = 0, checked = 0;
    for (let i = 0; i < 240; i++) {
      z += 60 * DT;
      d.setWorld(0, z, 0, 0, 60);
      const t = d.update(DT);
      const sw = d.swingLegs;
      if (!sw[0]) { expect(t.ankL, 'левая опорная').toBe(0); checked++; }
      if (!sw[1]) { expect(t.ankR, 'правая опорная').toBe(0); checked++; }
    }
    expect(checked, 'опорных кадров должно набраться').toBeGreaterThan(100);
  });

  it('стоя на месте обе стопы плоские', () => {
    const d = new PoseDriver();
    for (let i = 0; i < 120; i++) { d.setWorld(0, 0, 0, 0, 0); const t = d.update(DT); expect(t.ankL).toBe(0); expect(t.ankR).toBe(0); }
  });
});

describe('ручки живут в общей системе колонок', () => {
  beforeEach(() => { clearCols(); restoreGait(); });

  it('подъём носка настраивается отдельно для хода спиной', () => {
    BACK['toeLift'] = 0.5;
    expect(locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, 0, mix(0, 0, 0)), 'вперёд').toBeCloseTo(GAIT.toeLift, 6);
    expect(locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, 0, mix(0, 0, 1)), 'спиной').toBeCloseTo(0.5, 6);
  });

  it('и отдельно для страйфа, и отдельно для боя — как все остальные ручки', () => {
    STRAFE['toeLift'] = 0.1; COMBAT['toeLift'] = 0.7;
    expect(locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, 0, mix(0, 1, 0, 0))).toBeCloseTo(0.1, 6);
    expect(locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, 0, mix(0, 0, 0, 1))).toBeCloseTo(0.7, 6);
  });

  it('стороны разводятся — хромота бывает и по стопе', () => {
    ASYM['toeLift'] = [0.1, 0.6];
    expect(locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, 0, mix(0))).toBeCloseTo(0.1, 6);
    expect(locoVal('toeLift', 'toeLiftRun', GAIT.toeLift, GAIT.toeLiftRun, 1, mix(0))).toBeCloseTo(0.6, 6);
  });
});

describe('⚠ угол стопы доезжает до КОСТИ, а не только до целей позы', () => {
  beforeEach(() => { clearCols(); restoreGait(); });

  /**
   * Замер через НАСТОЯЩИЙ рантайм-шов. Отдельный тест нужен потому, что предыдущие кладут углы на риг
   * руками — и мутация «в рантайме снова жёсткий ноль» через них проходит незамеченной. Ровно этот
   * разрыв («значение посчитали, но не передали») уже стоил одной правки в этот же день.
   */
  const bake = (ank: number): number => {
    const h = buildHumanoid({});
    const d = new PoseDriver();
    d.setWorld(0, 0, 0, 0, 0);
    const t = d.update(DT) as PoseTargets;
    t.ankL = ank; t.ankR = ank;
    const atk: AttackState = { clip: null, t: 0 };
    gaitToHumanoid(h, [], { armDown: 1.35, elbowBend: 0.25 }, 1, t, localStorageContent('__none__'), 'none', atk, 1, true);
    return h.bones.get('LeftFoot')!.rotation.x;
  };

  it('ненулевой угол виден на кости стопы', () => {
    expect(bake(-0.3), 'рантайм обязан положить угол на кость').toBeCloseTo(-0.3, 6);
    expect(bake(0), 'ноль остаётся нулём').toBeCloseTo(0, 6);
  });
});
