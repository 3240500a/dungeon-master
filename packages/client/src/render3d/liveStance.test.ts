/**
 * ⭐⭐ СТОЙКА С ОРУЖИЕМ = БЕЗОРУЖНАЯ СТОЙКА + РУКА ПРЕДМЕТА (правило владельца, 06.10).
 *
 * «В безоружном есть спокойная и боевая, с оружием берутся ОНИ, но подмешивается рука, в которой что-то есть, — щит или
 * оружие». До 06.10 одиночный предмет со своей стойкой (`sword`, `none+shield`) отдавал её ЦЕЛИКОМ (якорь + дыхание базы
 * дельтой полной маски): ноги брались из стойки оружия, и дельта дыхания на чужих ногах уводила опорные стопы на 2–4 u за
 * 10 с покоя (безоружный — 0.15–0.35). Теперь тело — всегда безоружное, от стойки предмета только его рука (с пальцами).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { resolveStancePose, type StanceLookup } from './poseLayers.js';
import { PosePlayer, emptyGrid, type PoseContent, type UpperPose } from './poseRuntime.js';
import { makeStand } from './parityHarness.js';
import type { Pose } from './clipModel.js';

/** Безоружная база: «дышит» — грудь, шея, ноги и таз ходят по синусу. */
const liveBase = (t: number): Pose => ({
  Hips: [0.02 * Math.sin(t), 0, 0],
  Spine: [0.02 * Math.sin(t), 0, 0],
  Chest: [0.06 * Math.sin(t), 0, 0],
  Neck: [0.20 * Math.sin(t), 0, 0],
  LeftUpperArm: [0, 0, 0.05 * Math.sin(t)],
  RightUpperArm: [0, 0, -0.05 * Math.sin(t)],
  LeftUpperLeg: [0.04 * Math.sin(t), 0, 0.05], RightUpperLeg: [-0.03 * Math.sin(t), 0, -0.05],
  LeftLowerLeg: [0.05, 0, 0], RightLowerLeg: [0.05 + 0.02 * Math.sin(t), 0, 0],
  LeftFoot: [-0.05, 0.1, 0], RightFoot: [-0.05, -0.1, 0],
  LeftIndexProximal: [0.1, 0, 0], RightIndexProximal: [0.1, 0, 0],
  __hipsD: [0.5 * Math.sin(t), -0.2, 0],
  __swing: [1, 0, 0],            // служебный канал набора хода — у стойки с предметом ровно тот же, что у безоружной
});
/** Боевая база — однокадровая, со своими ногами и тазом. */
const combatBase: Pose = { ...liveBase(0), LeftUpperLeg: [0.3, 0, 0.1], RightUpperLeg: [-0.25, 0, -0.1], LeftLowerLeg: [0.4, 0, 0], __hipsD: [-1, -1.06, 0.65] };
/**
 * Авторская поза меча — ОДИН кадр, снятый когда-то от ДРУГОЙ безоружной базы: у неё свои ноги, таз и голова (как у
 * контента владельца: бёдра 29°/41°, смещение таза (−1, 0.25, 0.65)), а рука держит меч, пальцы обеих рук — свои.
 */
const swordPose: Pose = {
  Hips: [0, 0.1, 0], Spine: [0.3, 0, 0], Chest: [0.2, 0, 0], Neck: [0, 0, 0], Head: [0.17, 0, 0],
  LeftUpperLeg: [0.5, 0, 0.2], RightUpperLeg: [-0.7, 0, -0.1], LeftLowerLeg: [0.25, 0, 0], RightFoot: [0.2, 0.3, 0],
  RightUpperArm: [0.4, 0, 0.9], RightLowerArm: [0, 0, 1.1], RightIndexProximal: [1.2, 0, 0.1], LeftIndexProximal: [0.7, 0, 0],
  __wpnMain: [0, 0.2, 0], __hipsD: [-1, 0.25, 0.65],
};
const swordCombat: Pose = { ...swordPose, RightUpperArm: [0.9, 0.1, 0.5], LeftUpperLeg: [0.6, 0, 0.3] };
/** Щит в слоте офф-руки (`none+shield`) — тоже со своими ногами и тазом. */
const shieldPose: Pose = { ...swordPose, RightUpperArm: [0, 0, -0.3], LeftUpperArm: [-1.1, -0.1, -0.6], LeftLowerArm: [0, -1.4, 0], __wpnOff: [0.3, 0.3, 0.3] };

/** Резолвер: `none` — живая база (боевая — однокадровая), `sword` / `none+shield` — статичные авторские. */
const look: StanceLookup = (kind, item, t) => {
  if (item === 'none') return kind === 'idle' ? liveBase(t) : combatBase;
  if (item === 'sword') return kind === 'idle' ? swordPose : swordCombat;
  return item === 'none+shield' && kind === 'idle' ? shieldPose : null;
};
const BODY = ['Hips', 'Neck', 'Head', 'LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg', 'LeftFoot', 'RightFoot', '__hipsD', '__swing'];
const near = (a: readonly number[] | undefined, b: readonly number[] | undefined, eps: number, what: string): void => {
  expect(!!a, `${what}: канал есть у одной стороны`).toBe(!!b);
  if (a && b) for (let j = 0; j < 3; j++) expect(Math.abs(a[j]! - b[j]!), `${what}[${j}]`).toBeLessThan(eps);
};

describe('стойка с оружием = безоружная стойка + рука предмета', () => {
  it('⭐⭐ ТЕЛО С ОРУЖИЕМ — тело БЕЗОРУЖНОЙ стойки: ноги, таз, шея, голова бит в бит (и в бою)', () => {
    for (const w of ['sword', 'none+shield', 'sword+shield']) for (const c of [0, 1]) for (const t of [0, 0.7, 2.1, 4.4]) {
      const p = resolveStancePose(look, w, c, {}, t)!, free = resolveStancePose(look, 'none', c, {}, t)!;
      for (const k of BODY) near(p[k], free[k], 1e-12, `${w} бой=${c} t=${t} ${k}`);
    }
  });

  it('⭐ РУКА ПРЕДМЕТА — авторская на нуле цикла: плечо, локоть, хват и пальцы ЭТОЙ руки', () => {
    const p = resolveStancePose(look, 'sword', 0, {}, 0)!;
    for (const k of ['RightUpperArm', 'RightLowerArm', 'RightIndexProximal', '__wpnMain']) near(p[k], swordPose[k], 1e-9, k);
    // а пальцы ПУСТОЙ руки — базы: стойка меча её не держит
    near(p['LeftIndexProximal'], liveBase(0)['LeftIndexProximal'], 1e-12, 'LeftIndexProximal');
    const s = resolveStancePose(look, 'none+shield', 0, {}, 0)!;
    for (const k of ['LeftUpperArm', 'LeftLowerArm', '__wpnOff']) near(s[k], shieldPose[k], 1e-9, `щит ${k}`);
    near(s['RightUpperArm'], liveBase(0)['RightUpperArm'], 1e-12, 'щит: правая рука пустая — базы');
  });

  it('⭐ дыхание базы проступает сквозь руку с предметом, а не гасится ею', () => {
    const a = resolveStancePose(look, 'sword', 0, {}, 0)!, b = resolveStancePose(look, 'sword', 0, {}, Math.PI / 2)!;
    const d = Math.hypot(...[0, 1, 2].map((j) => b['RightUpperArm']![j]! - a['RightUpperArm']![j]!));
    expect(d, 'рука с мечом дышит вместе с базой').toBeGreaterThan(0.02);
  });

  it('⚠ ТАЗ СТОЙКИ ПРЕДМЕТА в тело не уезжает — и у пары рук он не удваивается', () => {
    for (const w of ['sword', 'none+shield', 'sword+shield']) {
      near(resolveStancePose(look, w, 0, {}, 1.3)!['__hipsD'], liveBase(1.3)['__hipsD'], 1e-12, `${w} __hipsD`);
    }
  });

  it('нет безоружной базы — стойка предмета целиком, как до слоёв', () => {
    const noBase: StanceLookup = (k, i, t) => (i === 'none' ? null : look(k, i, t));
    expect(resolveStancePose(noBase, 'sword', 0, {}, 0)).toBe(swordPose);
  });

  it('⭐⭐ НА КУКЛЕ: опорные стопы с мечом идут ровно как без оружия', () => {
    // Настоящий `PosePlayer`: контент отдаёт собранную стойку под оружие. Ноги, таз и стопы с мечом обязаны совпасть
    // с безоружными на каждом кадре — иначе «с оружием стопы плавают» вернётся.
    const content = (): PoseContent => ({
      charId: 'warrior',
      resolveUpper: (w: string, c = 0, t = 0): UpperPose | null => { const pose = resolveStancePose(look, w, c, {}, t); return pose ? { swing: 0, pose } : null; },
    } as unknown as PoseContent);
    const feet = (w: string): THREE.Vector3[][] => {
      const st = makeStand({ content: content(), grid: emptyGrid(), mix: 1, weapon: w });
      const fr = st.run({ warm: 10, frames: 240, at: (pl, i) => { if (i === 120) pl.setCombat(true); } });
      st.dispose();
      return fr.map((f) => [f.foot[0].clone(), f.foot[1].clone()]);
    };
    const a = feet('sword'), b = feet('none');
    let worst = 0;
    for (let i = 0; i < a.length; i++) for (const k of [0, 1]) worst = Math.max(worst, a[i]![k]!.distanceTo(b[i]![k]!));
    expect(worst, 'стопа с мечом разошлась с безоружной').toBeLessThan(1e-9);
  });
});

/**
 * ⭐ СОБСТВЕННАЯ ФАЗА ЖИВОЙ СТОЙКИ. Пока стойки были однокадровыми, общие часы никому не мешали; с живой
 * стойкой стая, заспавненная одним тиком, озиралась бы ХОРОМ (голова ходит на 21–56°).
 * ⚠ Умолчание — НОЛЬ: на этом стоит запекание, оно обязано стартовать с нуля.
 */
describe('фаза живой стойки', () => {
  /** Контент с ЖИВОЙ стойкой: поза зависит от времени `t`, как многокадровый клип. */
  const liveContent = (): PoseContent => ({
    charId: 'warrior',
    resolveUpper: (_w: string, _c?: number, t = 0): UpperPose => ({
      swing: 0, pose: { Chest: [0.5 * Math.sin(t), 0, 0], Hips: [0, 0, 0] },
    }),
  } as unknown as PoseContent);
  const chestAt = (phase: number): number => {
    const st = makeStand({ content: liveContent(), grid: emptyGrid(), mix: 1 });
    st.player.setIdlePhase(phase);
    const f = st.run({ vz: 0, frames: 1 });
    const q = f[f.length - 1]!.local.get('Chest')!;
    st.dispose();
    return q.x;
  };

  it('⭐⭐ ДВЕ КУКЛЫ С РАЗНОЙ ФАЗОЙ стоят по-разному — стая не озирается хором', () => {
    const a = chestAt(0), b = chestAt(1.6);
    expect(Math.abs(a - b), `фаза не развела кукол: ${a} против ${b}`).toBeGreaterThan(1e-3);
  });

  it('умолчание — НОЛЬ: запекание обязано стартовать с нуля', () => {
    // Сравниваем с ЯВНО выставленным нулём, а не с абсолютным числом: поза проходит через весь конвейер,
    // и её значение зависит от ручек. Инвариант же ровно один — «не звали ручку» ≡ «выставили 0».
    const st = makeStand({ content: liveContent(), grid: emptyGrid(), mix: 1 });
    const dflt = st.run({ vz: 0, frames: 1 });
    st.dispose();
    expect(Math.abs(dflt[dflt.length - 1]!.local.get('Chest')!.x - chestAt(0)), 'умолчание разошлось с явным нулём').toBeLessThan(1e-9);
  });

  it('⚠ СБРОС возвращает в СВОЮ фазу, а не в ноль — иначе стая снова сойдётся', () => {
    const body = String(Object.getOwnPropertyDescriptor(PosePlayer.prototype, 'resetGaitState')?.value ?? '');
    expect(body, 'сброс обязан класть idlePhase0, а не литеральный 0').toMatch(/idleT = this\.idlePhase0/);
  });
});

/**
 * ⭐⭐ РЕДКАЯ ВСТАВКА В ПОКОЙ на том же шве. Два класса: подмена БАЗЫ (играет со всем оружием) и поза
 * С ПРЕДМЕТОМ (прокрут меча). Проверяем ровно то, на чём этот шов ломается.
 */
describe('вставка в покой на шве стойки', () => {
  const fgPose: Pose = {
    Chest: [0.9, 0, 0], Neck: [0.8, 0, 0], LeftUpperLeg: [0.3, 0, 0], RightUpperArm: [0.2, 0.1, -0.4],
    __swing: [0, 1, 0],            // служебные каналы набора хода — в стойку попасть НЕ ДОЛЖНЫ
    __rootY: [2.5, 0, 0],
  };
  const withFg = (scope: 'base' | 'item', w: number, weapon = 'sword'): Pose =>
    resolveStancePose(look, weapon, 0, { fidget: { pose: fgPose, scope, w } }, 0.7)!;
  const q = (e: readonly number[]): THREE.Quaternion => new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'));

  it('⭐ БАЗОВАЯ вставка доезжает до тела С ОРУЖИЕМ — оно и есть безоружное', () => {
    const off = resolveStancePose(look, 'sword', 0, {}, 0.7)!;
    const on = withFg('base', 1);
    expect(Math.abs(on['Neck']![0] - off['Neck']![0]), 'шея обязана уехать во вставку').toBeGreaterThan(0.3);
    expect(Math.abs(on['LeftUpperLeg']![0] - off['LeftUpperLeg']![0]), 'ноги тоже — стойка это всё тело').toBeGreaterThan(0.1);
    const free = withFg('base', 1, 'none');
    for (const k of ['Neck', 'LeftUpperLeg', 'Hips', '__hipsD']) near(on[k], free[k], 1e-12, `тело с мечом = безоружное со вставкой: ${k}`);
  });

  it('⭐⭐ РУКА ПРЕДМЕТА ЛОЖИТСЯ ПОВЕРХ ВСТАВКИ: дельта меча к безоружной руке та же, что без вставки', () => {
    // референс дельты — ЧИСТАЯ база на нуле: посчитай его от подменённой базы — и вставка с оружием пропала бы
    const want = q(liveBase(0)['RightUpperArm']!).invert().multiply(q(swordPose['RightUpperArm']!));
    const got = q(withFg('base', 1, 'none')['RightUpperArm']!).invert().multiply(q(withFg('base', 1)['RightUpperArm']!));
    expect(got.angleTo(want), 'дельта руки с мечом поверх вставки').toBeLessThan(1e-6);
  });

  it('⚠ СЛУЖЕБНЫЕ КАНАЛЫ вставки в стойку не пускаются', () => {
    const on = withFg('base', 1);
    expect(on['__swing']?.[1], '⚠ канал опоры вставки подменил бы опорную ногу').not.toBe(1);
    expect(on['__rootY'], '⚠ канал курса развернул бы персонажа').toBeUndefined();
  });

  it('ВЕС огибающей работает как доля: 0 — прежняя поза, 1 — вставка целиком', () => {
    const off = resolveStancePose(look, 'sword', 0, {}, 0.7)!;
    expect(withFg('base', 0)['Neck']![0], 'нулевой вес = ветка не берётся').toBeCloseTo(off['Neck']![0]!, 6);
    const half = withFg('base', 0.5)['Neck']![0]!;
    const full = withFg('base', 1)['Neck']![0]!;
    expect(Math.abs(half - off['Neck']![0]!)).toBeLessThan(Math.abs(full - off['Neck']![0]!));
  });

  it('⭐ ПОЗА С ПРЕДМЕТОМ (прокрут меча) кладётся ПОВЕРХ собранной стойки', () => {
    const on = withFg('item', 1);
    expect(on['Chest']![0], 'корпус обязан уехать в позу вставки').toBeCloseTo(fgPose['Chest']![0]!, 3);
    expect(on['RightUpperArm']![0], '⚠ рука тоже — иначе мечом крутить нечем').toBeCloseTo(fgPose['RightUpperArm']![0]!, 3);
  });

  it('БЕЗ поля `fidget` поведение прежнее БИТ В БИТ', () => {
    const a = resolveStancePose(look, 'sword', 0, {}, 0.7)!;
    const b = resolveStancePose(look, 'sword', 0, { fidget: { pose: fgPose, scope: 'base', w: 0 } }, 0.7)!;
    for (const k in a) for (let j = 0; j < 3; j++) expect(b[k]![j]).toBeCloseTo(a[k]![j]!, 9);
  });
});
