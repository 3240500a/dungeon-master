import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { PoseDriver, GAIT, POSE, ASYM, STRAFE, type PoseTargets } from './pose.js';
import { buildHumanoid } from './humanoid.js';
import { gaitToHumanoid, type PoseContent, type GXKnobs } from './poseRuntime.js';

/**
 * КАЖДЫЙ ПОЛЗУНОК ОБЯЗАН ЧТО-ТО ДЕЛАТЬ.
 *
 * Требование прямое: «главное сделай, чтобы они работали». Мёртвая ручка хуже отсутствующей — её
 * крутят, ничего не происходит, и виноватым оказывается не ползунок, а вся система. Ровно это и
 * случилось с «фазой плеч»: она множитель, а качание пояса стояло в нуле, и множить было нечего.
 *
 * Поэтому здесь перечислены ВСЕ ручки панели «Бег», и на каждую один и тот же спрос: сдвинули —
 * кадр обязан измениться. У множителей (фаза) в таблице есть `pre`: то, что надо включить, чтобы
 * ручке было на что множиться. Если такой ручки в панели нет и в таблице — тест об этом не узнает,
 * поэтому список сверяется глазами с `renderGaitTune`, а не выводится автоматически.
 */
const DT = 1 / 60;
const POSE0 = { ...POSE }, GAIT0 = { ...GAIT };
afterEach(() => {
  for (const k of Object.keys(ASYM)) delete ASYM[k];
  for (const k of Object.keys(STRAFE)) delete STRAFE[k];
  Object.assign(POSE, POSE0); Object.assign(GAIT, GAIT0);
});

/** Все числа кадра подряд — ручка «работает», если изменила хоть одно из них. */
const flat = (o: PoseTargets): number[] => Object.values(o as unknown as Record<string, number>).filter((v) => typeof v === 'number');

/**
 * РЕЖИМЫ ПРОГОНА. Ручка проверяется на той скорости и в том направлении, где она вообще работает:
 * на полном бегу walk-число полностью интерполировано прочь (`sb` = 1), и объявлять его мёртвым
 * там — та же ошибка, из-за которой «фаза плеч» выглядела сломанной: смотрели не туда, где живёт.
 */
type Move = 'walk' | 'run' | 'strafeWalk' | 'strafeRun' | 'diag' | 'idle' | 'stop' | 'zigzag';
const LEG: Record<Move, (i: number) => [number, number]> = {
  walk: () => [0, 41], run: () => [0, 115],
  strafeWalk: () => [41, 0], strafeRun: () => [115, 0],
  diag: () => [81, 81],
  idle: () => [0, 0],
  stop: (i) => (i < 120 ? [0, 41] : [0, 0]),                  // дошли и встали: стопы остались разъехавшимися
  zigzag: (i) => [Math.floor(i / 12) % 2 ? 90 : -90, 60],     // перекладка направления — ручки «резкой смены»
};

function trace(move: Move, frames = 240): number[][] {
  const d = new PoseDriver(); let x = 0, z = 0; const out: number[][] = [];
  for (let i = 0; i < frames; i++) {
    const [vx, vz] = LEG[move](i);
    x += vx * DT; z += vz * DT;
    d.setWorld(x, z, 0, vx, vz);
    const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
    const t = d.update(DT);
    out.push([...flat(t), ...d.plantTarget(0), ...d.plantTarget(1)]);
  }
  return out;
}
const diff = (a: number[][], b: number[][]): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[i]!.length; j++) m = Math.max(m, Math.abs(a[i]![j]! - b[i]![j]!));
  return m;
};

type Obj = Record<string, number>;
const G = GAIT as unknown as Obj, PS = POSE as unknown as Obj;
interface Knob { label: string; obj: Obj; key: string; to: number; pre?: () => void; move?: Move }

/** Таблица повторяет порядок панели — так её проще сверять глазами при добавлении ручки. */
const KNOBS: Knob[] = [
  // поза (ретаргет) — armDown/elbowBend живут в GX и проверяются отдельным тестом ниже
  // руки (мах)
  { label: 'база плеча', obj: PS, key: 'armSh', to: 0.5 },
  { label: 'база плеча (бег)', obj: PS, key: 'armShRun', to: 0.5 },
  { label: 'амплитуда маха', obj: PS, key: 'armSwing', to: 1.4 },
  { label: 'амплитуда маха (бег)', obj: PS, key: 'armSwingRun', to: 1.4 },
  { label: 'фаза маха рук', obj: PS, key: 'armPhase', to: -1 },
  { label: 'фаза маха рук (бег)', obj: PS, key: 'armPhaseRun', to: -1 },
  { label: 'локоть — база', obj: PS, key: 'armEl', to: 1.2 },
  { label: 'локоть — база (бег)', obj: PS, key: 'armElRun', to: 1.2 },
  { label: 'локоть — амплитуда', obj: PS, key: 'armElAmp', to: 0.8 },
  { label: 'локоть — амплитуда (бег)', obj: PS, key: 'armElAmpRun', to: 0.8 },
  // плечи (ключицы)
  { label: 'подъём плеча', obj: PS, key: 'shoUp', to: 0.4 },
  { label: 'подъём плеча (бег)', obj: PS, key: 'shoUpRun', to: 0.4 },
  { label: 'вынос вперёд', obj: PS, key: 'shoFwd', to: 0.4 },
  { label: 'вынос вперёд (бег)', obj: PS, key: 'shoFwdRun', to: 0.4 },
  { label: 'скрутка ключицы', obj: PS, key: 'shoTw', to: 0.4 },
  { label: 'скрутка ключицы (бег)', obj: PS, key: 'shoTwRun', to: 0.4 },
  { label: 'качание за рукой', obj: PS, key: 'shoSwing', to: 0.6 },
  { label: 'качание за рукой (бег)', obj: PS, key: 'shoSwingRun', to: 0.6 },
  { label: 'подъём за рукой', obj: PS, key: 'shoLift', to: 0.6 },
  { label: 'подъём за рукой (бег)', obj: PS, key: 'shoLiftRun', to: 0.6 },
  { label: 'фаза плеч', obj: PS, key: 'shoPhase', to: -1, pre: () => { POSE.shoSwing = 0.6; POSE.shoSwingRun = 0.6; } },
  { label: 'фаза плеч (бег)', obj: PS, key: 'shoPhaseRun', to: -1, pre: () => { POSE.shoSwing = 0.6; POSE.shoSwingRun = 0.6; } },
  // корпус: скрутка
  { label: 'скрутка — поясница', obj: PS, key: 'twistSwing', to: 0.6 },
  { label: 'скрутка — поясница (бег)', obj: PS, key: 'twistSwingRun', to: 0.6 },
  { label: 'скрутка — грудь', obj: PS, key: 'twistChest', to: 0.4 },
  { label: 'скрутка — грудь (бег)', obj: PS, key: 'twistChestRun', to: 0.4 },
  { label: 'скрутка — верхняя грудь', obj: PS, key: 'twistUpper', to: 0.4 },
  { label: 'скрутка — верхняя грудь (бег)', obj: PS, key: 'twistUpperRun', to: 0.4 },
  { label: 'фаза скрутки', obj: PS, key: 'twistPhase', to: -1 },
  { label: 'фаза скрутки (бег)', obj: PS, key: 'twistPhaseRun', to: -1 },
  // корпус: наклон и живость
  { label: 'наклон вперёд на ходу', obj: PS, key: 'leanWalk', to: 0.4 },
  { label: 'наклон вперёд на ходу (бег)', obj: PS, key: 'leanWalkRun', to: 0.4 },
  { label: 'наклон от скорости', obj: PS, key: 'leanSpeed', to: 0.4 },
  { label: 'наклон от скорости (бег)', obj: PS, key: 'leanSpeedRun', to: 0.4 },
  { label: 'боковое качание', obj: PS, key: 'leanSideSwing', to: 0.4 },
  { label: 'боковое качание (бег)', obj: PS, key: 'leanSideSwingRun', to: 0.4 },
  { label: 'наклон стоя', obj: PS, key: 'leanIdle', to: 0.3, move: 'idle' },
  { label: 'амплитуда качания: база', obj: PS, key: 'swingBase', to: 0.9 },
  { label: 'амплитуда качания: от скорости', obj: PS, key: 'swingSpeed', to: 0.9 },
  // ноги / посадка
  { label: 'присед (мин. таз)', obj: G, key: 'pelvisMin', to: 34 },
  { label: 'присед (бег)', obj: G, key: 'pelvisMinRun', to: 34 },
  { label: 'длина шага', obj: G, key: 'stepWalk', to: 70, move: 'walk' },
  { label: 'длина шага (бег)', obj: G, key: 'stepRun', to: 80 },
  { label: 'боб таза', obj: G, key: 'bobWalk', to: 3, move: 'walk' },
  { label: 'боб таза (бег)', obj: G, key: 'bobRun', to: 3 },
  { label: 'подъём стопы', obj: G, key: 'liftWalk', to: 22, move: 'walk' },
  { label: 'подъём стопы (бег)', obj: G, key: 'liftRun', to: 30 },
  { label: 'доля опоры', obj: G, key: 'dutyWalk', to: 0.5, move: 'walk' },
  { label: 'доля опоры (бег)', obj: G, key: 'dutyRun', to: 0.45 },
  { label: 'потолок бедра', obj: G, key: 'hipFwdLim', to: 0.4, move: 'walk' },
  { label: 'потолок бедра (бег)', obj: G, key: 'hipFwdLimRun', to: 0.4 },
  { label: 'амплитуда бедра', obj: G, key: 'hipSwing', to: 2.2, move: 'walk' },
  { label: 'амплитуда бедра (бег)', obj: G, key: 'hipSwingRun', to: 2.2 },
  { label: 'ширина стойки', obj: G, key: 'stanceWidth', to: 16, move: 'walk' },
  { label: 'ширина стойки (бег)', obj: G, key: 'stanceWidthRun', to: 16 },
  { label: 'вынос вбок (страйф)', obj: G, key: 'strafeReach', to: 2, move: 'strafeWalk' },
  { label: 'вынос вбок (страйф, бег)', obj: G, key: 'strafeReachRun', to: 2, move: 'strafeRun' },
  { label: 'предел кроссовера', obj: G, key: 'crossClamp', to: 0, move: 'strafeWalk' },
  { label: 'предел кроссовера (бег)', obj: G, key: 'crossClampRun', to: 0, move: 'strafeRun' },
  { label: 'мягкость потолка бедра', obj: G, key: 'hipFwdSoft', to: 0.03, move: 'run', pre: () => { GAIT.hipFwdLim = 0.4; GAIT.hipFwdLimRun = 0.4; } },
  { label: 'вынос стопы вперёд ×шаг', obj: G, key: 'aheadMul', to: 0.5, move: 'run' },
  { label: 'предсказание по скорости', obj: G, key: 'predictSec', to: 0.2, move: 'run' },
  { label: 'цель фиксируется на отрыве', obj: G, key: 'fixTarget', to: 1, move: 'run' },
  { label: 'зазор между стопами', obj: G, key: 'footClear', to: 22, move: 'strafeWalk' },
  // общее
  { label: 'скорость анимации бега', obj: G, key: 'cadence', to: 2, move: 'run' },
  { label: 'порог ходьбы', obj: G, key: 'speedWalk', to: 70, move: 'walk' },
  { label: 'порог бега', obj: G, key: 'speedRun', to: 200, move: 'run' },
  { label: 'страйф от (°)', obj: G, key: 'strafeFrom', to: 5, move: 'diag', pre: () => { STRAFE['stanceWidth'] = 20; } },
  { label: 'страйф до (°)', obj: G, key: 'strafeTo', to: 20, move: 'diag', pre: () => { STRAFE['stanceWidth'] = 20; GAIT.strafeFrom = 5; } },
  // резкая смена направления
  { label: 'усреднение направления', obj: G, key: 'planSmooth', to: 0.8, move: 'zigzag' },
  { label: 'запас выноса', obj: G, key: 'stepSlack', to: 0.15, move: 'run', pre: () => { GAIT.stepUrge = 14; } },
  { label: 'ускорение просроченного шага', obj: G, key: 'stepUrge', to: 25, move: 'run', pre: () => { GAIT.stepSlack = 0.15; } },
];

describe('ни одной мёртвой ручки', () => {
  for (const k of KNOBS) {
    it(`«${k.label}» меняет кадр`, () => {
      // Умолчание: ключ с суффиксом Run живёт на бегу, без суффикса — на ходьбе. Как и в панели.
      const mv: Move = k.move ?? (k.key.endsWith('Run') ? 'run' : 'walk');
      k.pre?.();
      const before = trace(mv);
      const was = k.obj[k.key];
      expect(was, `ключа ${k.key} нет в объекте — ползунок пишет в пустоту`).toBeTypeOf('number');
      expect(k.to, 'таблица должна двигать ручку, а не оставлять её на месте').not.toBe(was);
      k.obj[k.key] = k.to;
      expect(diff(trace(mv), before), `ползунок ничего не изменил на прогоне «${mv}»`).toBeGreaterThan(1e-6);
    });
  }
});

/**
 * ДВЕ РУЧКИ ЖИВУТ НЕ В ДРАЙВЕРЕ, А В РЕТАРГЕТЕ, и там же — единственный новый шов: скрутка груди
 * кладётся аддитивно ПОСЛЕ того, как цикл `UPPER_BONES` ставит Chest/UpperChest в авторскую стойку.
 * Положи её раньше — она молча сотрётся, и ползунок снова окажется мёртвым. Проверяем на костях.
 */
const stubContent = (): PoseContent => ({ resolveUpper: () => null });
const gxDefault = (): GXKnobs => ({ armDown: 1.35, elbowBend: 0.25 });

function boneY(set: (p: typeof POSE) => void, gx: GXKnobs = gxDefault()): { chest: number; upper: number; hand: number; elbow: number } {
  Object.assign(POSE, POSE0); Object.assign(GAIT, GAIT0);
  set(POSE);
  const h = buildHumanoid({});
  const d = new PoseDriver();
  let z = 0; let t: PoseTargets | null = null;
  for (let i = 0; i < 120; i++) {
    z += 115 * DT;
    d.setWorld(0, z, 0, 0, 115);
    const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
    t = d.update(DT);
  }
  h.reset();
  gaitToHumanoid(h, [], gx, 1, t!, stubContent(), 'none', { clip: null, t: -1 }, 1);
  h.root.updateMatrixWorld(true);
  return {
    chest: h.bones.get('Chest')!.rotation.y,
    upper: h.bones.get('UpperChest')!.rotation.y,
    hand: h.bones.get('LeftHand')!.getWorldPosition(new THREE.Vector3()).z,
    elbow: h.bones.get('LeftLowerArm')!.rotation.y,
  };
}

/**
 * ДВЕ РУЧКИ ПАНЕЛИ ЖИВУТ НЕ В `POSE`, А В `GX` (ретаргет), и до кадра драйвера не доходят вовсе —
 * табличный тест выше их увидеть не может по устройству. Поэтому им отдельный спрос, на костях.
 */
describe('ручки ретаргета (GX) доходят до костей', () => {
  it('«руки вниз» разводит руку', () => {
    const a = boneY(() => { /* дефолты */ }, { armDown: 1.35, elbowBend: 0.25 });
    const b = boneY(() => { /* дефолты */ }, { armDown: 0.6, elbowBend: 0.25 });
    expect(Math.abs(b.hand - a.hand), 'кисть переехала').toBeGreaterThan(0.5);
  });

  it('«сгиб локтя» гнёт локоть', () => {
    const a = boneY(() => { /* дефолты */ }, { armDown: 1.35, elbowBend: 0 });
    const b = boneY(() => { /* дефолты */ }, { armDown: 1.35, elbowBend: 1.2 });
    expect(Math.abs(b.elbow - a.elbow), 'локоть согнулся').toBeGreaterThan(1);
  });
});

describe('скрутка корпуса доезжает до костей', () => {
  it('в нуле грудь не тронута — прежнее поведение', () => {
    const b = boneY(() => { /* дефолты */ });
    expect(Math.abs(b.chest)).toBeLessThan(1e-9);
    expect(Math.abs(b.upper)).toBeLessThan(1e-9);
  });

  it('«скрутка — грудь» крутит ГРУДЬ, «верхняя грудь» — ВЕРХНЮЮ, и не наоборот', () => {
    const c = boneY((p) => { p.twistChest = 0.5; p.twistChestRun = 0.5; });
    expect(Math.abs(c.chest), 'грудь повернулась').toBeGreaterThan(0.05);
    expect(Math.abs(c.upper), 'верхняя не тронута').toBeLessThan(1e-9);
    const u = boneY((p) => { p.twistUpper = 0.5; p.twistUpperRun = 0.5; });
    expect(Math.abs(u.upper), 'верхняя повернулась').toBeGreaterThan(0.05);
    expect(Math.abs(u.chest), 'грудь не тронута').toBeLessThan(1e-9);
  });

  it('фаза скрутки переворачивает знак — тем же ползунком чинится «крутится не в ту сторону»', () => {
    const a = boneY((p) => { p.twistUpper = 0.5; p.twistUpperRun = 0.5; });
    const b = boneY((p) => { p.twistUpper = 0.5; p.twistUpperRun = 0.5; p.twistPhase = -1; p.twistPhaseRun = -1; });
    expect(b.upper).toBeCloseTo(-a.upper, 9);
  });

  it('скрутка РАЗВОДИТ ПЛЕЧИ: кисть уезжает, хотя сама рука не тронута', () => {
    const a = boneY(() => { /* дефолты */ });
    const b = boneY((p) => { p.twistUpper = 0.6; p.twistUpperRun = 0.6; });
    expect(Math.abs(b.hand - a.hand), 'плечо поехало вместе с грудью').toBeGreaterThan(0.5);
  });
});
