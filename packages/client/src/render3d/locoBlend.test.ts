import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, type PoseContent } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { locoClipName, locoDir, locoPhaseU } from './locoBlend.js';
import { bakeGaitToClip, BAKE_MAXSPD } from './clipBake.js';
import type { Clip } from './clipModel.js';

/**
 * ПОЛЗУНОК «ПРОЦЕДУРНО ↔ КЛИП» (Ф4).
 *
 * Ставка фазы: планировщик остаётся ЧАСАМИ и опорой даже на единице. Клип сэмплируется его фазой, а
 * не своим таймером — иначе настройки персонажа перестали бы на клип влиять, и «из двух купленных
 * паков неограниченное число вариантов» не получилось бы: пак остался бы ровно тем, чем куплен.
 *
 * И главное требование, на котором стоит всё остальное: НА НУЛЕ — СЕГОДНЯШНЯЯ ПОХОДКА БИТ В БИТ.
 * Без него ползунок нельзя было бы даже показать: любая жалоба на походку стала бы спором о том,
 * не он ли виноват.
 */
const DT = 1 / 60;
const GX = { armDown: 1.35, elbowBend: 0.25 };
const GAIT0 = { ...GAIT };

describe('фаза и выбор клипа', () => {
  it('π на шаг, 2π на цикл: фаза планировщика → время клипа', () => {
    expect(locoPhaseU(0)).toBeCloseTo(0, 12);
    expect(locoPhaseU(Math.PI), 'полшага — середина клипа').toBeCloseTo(0.5, 12);
    expect(locoPhaseU(Math.PI * 2), 'цикл замкнулся').toBeCloseTo(0, 12);
    expect(locoPhaseU(Math.PI * 5), 'фаза копится и не переполняется').toBeCloseTo(0.5, 12);
  });

  it('отрицательная фаза (пятимся) не ломает выборку', () => {
    expect(locoPhaseU(-Math.PI)).toBeCloseTo(0.5, 12);
  });

  it('четыре направления, а не восемь: диагональ — это ВПЕРЁД (её закрывает доворот таза)', () => {
    expect(locoDir(1, 0, 45)).toBe('fwd');
    expect(locoDir(1, 0.9, 45), '42° — ещё вперёд').toBe('fwd');
    expect(locoDir(-1, 0, 45), 'спиной — шаг назад, а не разворот').toBe('back');
    expect(locoDir(0, 1, 45)).toBe('strafe_R');
    expect(locoDir(0, -1, 45)).toBe('strafe_L');
  });

  it('граница страйфа — ОБЩАЯ с колонкой настроек, а не своя', () => {
    // Передаём тот же порог, что и у страйф-колонки: две расходящиеся границы дали бы клип страйфа
    // на одних числах и настройки бега на других — ровно на стыке, где и так тяжелее всего.
    expect(locoDir(1, 1, 45), 'ровно 45° — уже вбок').toBe('strafe_R');
    expect(locoDir(1, 1, 80), 'подняли порог — снова вперёд').toBe('fwd');
  });

  it('имена по конвенции плана', () => {
    expect(locoClipName('fwd', false)).toBe('walk_fwd');
    expect(locoClipName('strafe_L', true)).toBe('run_strafe_L');
  });
});

describe('смешивание в рантайме', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    Object.assign(GAIT, GAIT0);
  });

  /** Контент с одним клипом локомоции на все направления — этого хватает, чтобы шов сработал. */
  const withLoco = (clip: Clip): PoseContent => {
    const base = localStorageContent('warrior');
    return { ...base, locoClip: () => clip };
  };

  const run = (content: PoseContent, frames = 120): { bones: number[]; feet: number[] } => {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], content, 'sword', GX, emptyGrid());
    p.setVel(0, 115); p.setYaw(0);
    for (let i = 0; i < frames; i++) p.step(DT);
    h.root.updateMatrixWorld(true);
    const bones: number[] = [];
    for (const [, b] of [...h.bones].sort((a, b2) => a[0].localeCompare(b2[0]))) bones.push(b.rotation.x, b.rotation.y, b.rotation.z);
    const v = new THREE.Vector3();
    const feet = [h.bones.get('LeftFoot')!.getWorldPosition(v).clone(), h.bones.get('RightFoot')!.getWorldPosition(v).clone()]
      .flatMap((q) => [q.x, q.y, q.z]);
    return { bones, feet };
  };

  it('НА НУЛЕ — БИТ В БИТ сегодняшняя походка, даже когда клип привязан', () => {
    const h = buildHumanoid({});
    const src = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'run_fwd', vx: 0, vz: 0.95 }, { character: 'warrior', weapon: 'sword' }).clip;
    GAIT.locoMix = 0;
    const plain = run(localStorageContent('warrior'));
    const bound = run(withLoco(src));
    expect(bound.bones).toEqual(plain.bones);
  });

  it('клипа нет — ползунок молчит, а не роняет кадр', () => {
    GAIT.locoMix = 1;
    const plain = run(localStorageContent('warrior'));
    expect(plain.bones.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('на единице поза МЕНЯЕТСЯ — иначе ползунок был бы декоративным', () => {
    const h = buildHumanoid({});
    // Клип другой скорости: его форма заведомо не совпадает с текущей процедурной.
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    GAIT.locoMix = 0;
    const at0 = run(withLoco(other));
    GAIT.locoMix = 1;
    const at1 = run(withLoco(other));
    let diff = 0;
    for (let i = 0; i < at0.bones.length; i++) diff = Math.max(diff, Math.abs(at0.bones[i]! - at1.bones[i]!));
    expect(diff, 'поза поехала за клипом').toBeGreaterThan(0.05);
  });

  it('ОПОРНАЯ СТОПА ДЕРЖИТСЯ У ПЛАНТА даже на чужом клипе — иначе ползунок кончился бы скольжением', () => {
    const h = buildHumanoid({});
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    const content = withLoco(other);
    const hh = buildHumanoid({});
    const p = new PosePlayer(hh, () => [], content, 'sword', GX, emptyGrid());
    GAIT.locoMix = 1;
    let worst = 0, seen = 0;
    const v = new THREE.Vector3();
    p.setVel(0, 115); p.setYaw(0);
    for (let i = 0; i < 200; i++) {
      p.step(DT);
      hh.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        if (p.driver.swingLegs[leg]) continue;
        // Риг локальный, планировщик — в мире: сравниваем в ЕГО системе (плант минус позиция персонажа).
        const f = hh.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(v);
        const t = p.driver.plantTarget(leg);
        if (i > 60) { seen++; worst = Math.max(worst, Math.hypot(f.x - (t[0] - p.posX), f.z - (t[1] - p.posZ))); }
      }
    }
    // Планировщик работает в своих единицах, риг крупнее — идеального нуля тут не бывает. Требование
    // слабее и честнее: опорная стопа НЕ УЛЕТАЕТ от планта, то есть держится в пределах длины шага.
    expect(seen, 'опорные кадры вообще были — иначе проверка пустая').toBeGreaterThan(20);
    expect(worst, `максимальное отставание опорной стопы ${worst.toFixed(1)} за ${seen} кадров`).toBeLessThan(0.5);
  });

  it('НА ПОВОРОТЕ подтяжка обязана идти ПОСЛЕ доворота таза, иначе стопа уезжает с ригом', () => {
    // ⚠ Постоянного угла тут МАЛО, и это выяснилось мутацией: `applyTorsoTwist` ставит тазу рыск
    // АБСОЛЮТНО, поэтому на неизменном курсе он уже стоит правильно ещё с прошлого кадра и порядок
    // ничего не решает. Разница появляется только когда курс МЕНЯЕТСЯ: подтяжка, сделанная до
    // доворота, уезжает вместе с ригом на приращение угла за кадр.
    const h = buildHumanoid({});
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    const hh = buildHumanoid({});
    const p = new PosePlayer(hh, () => [], withLoco(other), 'sword', GX, emptyGrid());
    GAIT.locoMix = 1;
    const v = new THREE.Vector3();
    let worst = 0, seen = 0;
    for (let i = 0; i < 260; i++) {
      const yaw = i * 0.02;                       // ~1.2 рад/с — обычный доворот на бегу
      p.setVel(115 * Math.sin(yaw), 115 * Math.cos(yaw)); p.setYaw(yaw);
      p.step(DT);
      hh.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        if (p.driver.swingLegs[leg]) continue;
        const f = hh.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(v);
        const t = p.driver.plantTarget(leg);
        if (i > 120) { seen++; worst = Math.max(worst, Math.hypot(f.x - (t[0] - p.posX), f.z - (t[1] - p.posZ))); }
      }
    }
    expect(seen, 'опорные кадры на повороте были — иначе проверка пустая').toBeGreaterThan(20);
    expect(worst, `на повороте отставание ${worst.toFixed(2)} за ${seen} кадров`).toBeLessThan(0.5);
  });

  it('под постоянным углом — то же самое', () => {
    // На прямом ходу (yaw = 0) поворот рига единичный, и ошибка порядка не видна ВООБЩЕ. Поэтому
    // отдельный прогон под углом: `applyTorsoTwist` крутит весь риг, и подтяжка, сделанная раньше,
    // уехала бы вместе с поворотом.
    const h = buildHumanoid({});
    const other = bakeGaitToClip(new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid()), h,
      { name: 'walk_fwd', vx: 0, vz: 0.3 }, { character: 'warrior', weapon: 'sword' }).clip;
    const hh = buildHumanoid({});
    const p = new PosePlayer(hh, () => [], withLoco(other), 'sword', GX, emptyGrid());
    GAIT.locoMix = 1;
    const yaw = Math.PI / 3;
    p.setVel(115 * Math.sin(yaw), 115 * Math.cos(yaw)); p.setYaw(yaw);
    const v = new THREE.Vector3();
    let worst = 0, seen = 0;
    for (let i = 0; i < 200; i++) {
      p.step(DT);
      hh.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        if (p.driver.swingLegs[leg]) continue;
        const f = hh.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(v);
        const t = p.driver.plantTarget(leg);
        if (i > 90) { seen++; worst = Math.max(worst, Math.hypot(f.x - (t[0] - p.posX), f.z - (t[1] - p.posZ))); }
      }
    }
    expect(seen, 'опорные кадры под углом были — иначе проверка пустая').toBeGreaterThan(20);
    expect(worst, `под углом отставание ${worst.toFixed(1)} за ${seen} кадров`).toBeLessThan(0.5);
  });
});
