import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, getLocoMixOverride } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { LOCO_NAMES, LOCO_DIRS, locoClipName, locoClipNames, findLocoClip } from './locoBlend.js';
import { GAIT_PRESETS, TURN_PRESETS, defaultBakePick, bakeGaitToClip, BAKE_MAXSPD } from './clipBake.js';
import type { Clip } from './clipModel.js';

/**
 * ⭐⭐ НАБОР ЗАПЕКАНИЯ И ТО, ЧТО СПРАШИВАЕТ ДВИЖОК, — ОДИН СПИСОК.
 *
 * Они разошлись молча и надолго: запекались `strafe_L`, `strafe_R` и шесть диагоналей, а рантайм
 * просил `walk_strafe_L`, `run_strafe_L`, `run_back`… Из восьми имён набор покрывал ТРИ — то есть
 * «переключил бег на клипы» давало клипы только вперёд, назад и бег вперёд, а страйф и бег назад
 * тихо оставались на планировщике. Ни одна из сторон при этом не была «сломана» — просто некому
 * было сверить.
 */
describe('набор локомоции', () => {
  it('⭐⭐ ВСЁ, ЧТО СПРАШИВАЕТ ДВИЖОК, ЕСТЬ В НАБОРЕ ЗАПЕКАНИЯ — и включено по умолчанию', () => {
    // ⚠ Мутация «убрать любой режим из GAIT_PRESETS» валит это. Ровно этот сторож и отсутствовал.
    const baked = new Set(GAIT_PRESETS.map((s) => s.name));
    const picked = new Set(defaultBakePick());
    for (const n of LOCO_NAMES) {
      expect(baked.has(n), `⚠ движок просит «${n}», а запечь его нечем`).toBe(true);
      expect(picked.has(n), `⚠ «${n}» есть в наборе, но выключен по умолчанию`).toBe(true);
    }
    expect(LOCO_NAMES.length, '4 направления × ходьба/бег').toBe(8);
  });

  it('⭐⭐ И НИЧЕГО СВЕРХ: набор = стойка + ровно 8 имён движка, диагоналей в нём НЕТ', () => {
    // Решение Ф0 замерено и принято: ЧЕТЫРЕ направления, диагональ закрывает доворот таза. Восемь
    // клипов — это 4 направления × ходьба/бег; второго набора на восемь направлений не нужно.
    // ⚠ Мутация «вернуть диагонали в набор» валит это: запекалось бы то, чего никто не читает.
    expect(GAIT_PRESETS.map((s) => s.name).sort()).toEqual(['idle', ...LOCO_NAMES].sort());
    expect(GAIT_PRESETS.some((s) => /diag/i.test(s.name)), '⚠ диагональ вернулась в набор').toBe(false);
    expect(defaultBakePick().length, 'по умолчанию запекается весь набор — походка и повороты на месте').toBe(GAIT_PRESETS.length + TURN_PRESETS.length);
  });

  it('⚠ БЕГОВОЙ РЕЖИМ СНИМАЕТСЯ НА БЕГОВОЙ СКОРОСТИ — иначе каденция клипа разойдётся с фазой', () => {
    // Ходьба/бег выбираются порогом по оси `sb`, то есть по СКОРОСТИ. Клип, который будет играть на
    // беге, обязан быть снят на беговой скорости: снимешь на шаге — стопы поедут.
    const speed = (n: string): number => { const s = GAIT_PRESETS.find((x) => x.name === n)!; return Math.hypot(s.vx, s.vz); };
    for (const d of LOCO_DIRS) {
      expect(speed(locoClipName(d, true)), `⚠ бег «${d}» снят не быстрее шага`).toBeGreaterThan(speed(locoClipName(d, false)));
    }
  });

  it('⚠ ИСТОРИЧЕСКОЕ ИМЯ СТРАЙФА НАХОДИТСЯ — смена конвенции не обнуляет уже запечённое', () => {
    expect(locoClipNames('strafe_L', false)).toEqual(['walk_strafe_L', 'strafe_L']);
    expect(locoClipNames('strafe_R', true), 'один авторский страйф подходит обеим скоростям').toEqual(['run_strafe_R', 'strafe_R']);
    expect(locoClipNames('fwd', false), 'у прямых направлений истории нет').toEqual(['walk_fwd']);
  });
});

describe('набор под оружие', () => {
  const clip = (name: string, weapon: string, character = 'warrior'): Clip =>
    ({ name, character, weapon, loop: true, keys: [{ t: 0, pose: {} }] } as unknown as Clip);

  it('⭐⭐ ЗАПЁК БЕЗ ОРУЖИЯ — РАБОТАЕТ СО ВСЕМИ, а пооружный набор его перекрывает', () => {
    // ⚠ Мутация «искать только по имени» валит это — так и было: `find` отдавал ПЕРВЫЙ подходящий
    // клип, и набор был не «общий» и не «пооружный», а «какой раньше лёг в массив».
    const lib = [clip('run_fwd', 'none'), clip('run_fwd', 'sword'), clip('walk_fwd', 'none')];
    expect(findLocoClip(lib, 'run_fwd', 'warrior', 'sword')?.weapon, '⚠ пооружный набор не выиграл').toBe('sword');
    expect(findLocoClip(lib, 'run_fwd', 'warrior', 'axe')?.weapon, '⚠ безоружный набор не доехал до топора').toBe('none');
    expect(findLocoClip(lib, 'walk_fwd', 'warrior', 'axe+shield')?.weapon).toBe('none');
  });

  it('⚠ ПООРУЖНЫЙ НАБОР НЕ ТЕЧЁТ НА ЧУЖОЕ ОРУЖИЕ, если есть безоружный', () => {
    const lib = [clip('run_fwd', 'sword'), clip('run_fwd', 'none')];
    expect(findLocoClip(lib, 'run_fwd', 'warrior', 'axe')?.weapon).toBe('none');
  });

  it('⚠ нет ни точного, ни безоружного — берём что есть (лучше чужая походка, чем её отсутствие)', () => {
    const lib = [clip('run_fwd', 'sword')];
    expect(findLocoClip(lib, 'run_fwd', 'warrior', 'axe')?.weapon).toBe('sword');
  });

  it('⚠ чужой персонаж не подходит никогда', () => {
    expect(findLocoClip([clip('run_fwd', 'none', 'mage')], 'run_fwd', 'warrior', 'none')).toBe(null);
  });
});

/**
 * ⭐⭐ ДЁРГАНЬЕ НА СМЕНЕ РЕЖИМА. Жалоба была ровно такой: «как-то дёргано они играются».
 *
 * ЗАМЕР (максимальный скачок позы за кадр, воин, запечённый набор, 10 с прогона):
 *
 *            случай            было      стало     планировщик
 *   у порога ходьба/бег        60.84°    28.46°      25.78°
 *   у порога страйфа           51.73°    31.57°      25.78°
 *   разгон шаг→бег             33.66°    30.24°      25.78°
 *
 * И главное: ВЕСЬ максимум приходился на кадр ПОДМЕНЫ клипа — то есть поза менялась целиком за один
 * кадр. Так и работало: клип ВЫБИРАЛСЯ порогом (угол ≥ `strafeFrom` → страйф, `sb > 0.5` → бег), и
 * на пороге происходила мгновенная подмена. Лечится не сглаживанием порога, а тем, что порога быть
 * не должно: клипы БЛЕНДЯТСЯ по непрерывным осям (Blend Space / Blend Tree в индустрии), а фаза у
 * них общая — планировщика (Sync Group).
 *
 * Сторож держит РАВНЕНИЕ НА ПЛАНИРОВЩИКА, а не магическое число: клип-слой не имеет права дёргаться
 * заметно сильнее процедурного на тех же входах.
 */
describe('плавность на смене режима', () => {
  const GAIT0 = { ...GAIT };
  const GX2 = { armDown: 1.35, elbowBend: 0.25 };
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { setLocoMixOverride(null); delete (globalThis as unknown as { localStorage?: Storage }).localStorage; Object.assign(GAIT, GAIT0); });

  /** Запечь набор так же, как это делает кнопка в редакторе. */
  const bakeAll = (): Map<string, Clip> => {
    const h = buildHumanoid({});
    const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX2, emptyGrid());
    const out = new Map<string, Clip>();
    for (const sp of GAIT_PRESETS) out.set(sp.name, bakeGaitToClip(p, h, sp, { character: 'warrior', weapon: 'none' }).clip);
    return out;
  };

  /** Максимальный скачок позы за кадр (град) на заданном ходе. `lib === null` — чистый планировщик. */
  const jerk = (lib: Map<string, Clip> | null, drive: (i: number) => { vx: number; vz: number }): number => {
    const h = buildHumanoid({});
    const base = localStorageContent('warrior');
    const content = lib ? { ...base, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } } : base;
    const p = new PosePlayer(h, () => [], content, 'none', GX2, emptyGrid());
    setLocoMixOverride(lib ? 1 : 0);
    const names = [...h.bones.keys()].sort();
    let prev: number[] | null = null, max = 0;
    for (let i = 0; i < 600; i++) {
      const d = drive(i);
      p.setVel(d.vx, d.vz); p.setYaw(0);
      p.step(1 / 60);
      h.root.updateMatrixWorld(true);
      const cur: number[] = [];
      for (const k of names) { const b = h.bones.get(k)!; cur.push(b.rotation.x, b.rotation.y, b.rotation.z); }
      if (prev && i > 200) for (let j = 0; j < cur.length; j++) max = Math.max(max, Math.abs(cur[j]! - prev[j]!) * 180 / Math.PI);
      prev = cur;
    }
    return max;
  };

  const W = 0.42 * BAKE_MAXSPD, R = 0.85 * BAKE_MAXSPD;
  const CASES: [string, (i: number) => { vx: number; vz: number }][] = [
    ['у порога ходьба/бег', (i) => ({ vx: 0, vz: (W + R) / 2 + Math.sin(i / 40) * 4 })],
    ['у порога страйфа', (i) => { const a2 = (45 + Math.sin(i / 40) * 4) * Math.PI / 180; return { vx: Math.sin(a2) * R, vz: Math.cos(a2) * R }; }],
    ['разгон шаг→бег', (i) => ({ vx: 0, vz: W + (R - W) * Math.min(1, Math.max(0, (i - 120) / 300)) })],
  ];

  it('⭐⭐ НА ПОРОГАХ КЛИПЫ НЕ ДЁРГАЮТСЯ СИЛЬНЕЕ ПЛАНИРОВЩИКА', () => {
    // ⚠ Мутация «вернуть выбор клипа порогом вместо бленда» валит это: было 61° против 26° у планировщика.
    const lib = bakeAll();
    for (const [name, drive] of CASES) {
      const proc = jerk(null, drive), clip = jerk(lib, drive);
      expect(clip, `${name}: клипы ${clip.toFixed(1)}° против ${proc.toFixed(1)}° у планировщика`).toBeLessThan(proc * 1.5);
    }
  });
});

/**
 * ⭐⭐ НАИСКОСОК: ОСТАТОК, КОТОРЫЙ НЕ СНЯЛ ДОВОРОТ ТАЗА, ДОСЫПАЕТ БЛЕНД — И СТОПЫ НЕ СКОЛЬЗЯТ.
 *
 * Жалоба: «бежишь наискосок — таз доворачивает не до конца, и ноги скользят». ЗАМЕР (бег, доворот
 * включён, `warpMax` 50°, боковой снос маховой стопы с линии хода, ед/кадр):
 *
 *      ход   остаток   планировщик   клипы было   клипы стало
 *      65°     15°        0.157         0.399        0.082
 *      80°     30°        0.222         0.770        0.115
 *      90°     40°        0.219         0.991        0.131
 *
 * Причина была в весе страйфа: он брался из стилевого порога колонок планировщика (0 до 45°).
 */
describe('наискосок: стопы не скользят на остатке доворота', () => {
  const GAIT0 = { ...GAIT };
  const GX3 = { armDown: 1.35, elbowBend: 0.25 };
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { setLocoMixOverride(null); delete (globalThis as unknown as { localStorage?: Storage }).localStorage; Object.assign(GAIT, GAIT0); });

  /**
   * Средний боковой снос маховой стопы с линии хода, ед/кадр. `lib === null` — чистый планировщик.
   * ⚠ Маховую ногу берём у ПЛЕЕРА (`groundSupport`), а не у планировщика: на галке «клипами» его нет вовсе, и
   * `driver.swingLegs` там всегда «обе стоят» — выборка была бы пустой, а сторож проходил бы вхолостую нулём.
   */
  const drift = (lib: Map<string, Clip> | null, deg: number): { v: number; n: number } => {
    const h = buildHumanoid({});
    const base = localStorageContent('warrior');
    const content = lib ? { ...base, locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } } : base;
    const p = new PosePlayer(h, () => [], content, 'none', GX3, emptyGrid());
    setLocoMixOverride(lib ? 1 : 0);
    const a = deg * Math.PI / 180, R = 0.85 * BAKE_MAXSPD;
    const prev: ({ x: number; z: number } | null)[] = [null, null];
    let sum = 0, n = 0;
    for (let i = 0; i < 900; i++) {
      p.setVel(Math.sin(a) * R, Math.cos(a) * R); p.setYaw(0);
      p.step(1 / 60);
      h.root.updateMatrixWorld(true);
      for (let leg = 0; leg < 2; leg++) {
        const f = h.bones.get(leg === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(new THREE.Vector3());
        const wx = f.x + p.posX, wz = f.z + p.posZ;
        const q = prev[leg];
        if (i > 240 && q && !p.groundSupport[leg]) { sum += Math.abs(-(wx - q.x) * Math.cos(a) + (wz - q.z) * Math.sin(a)); n++; }
        prev[leg] = { x: wx, z: wz };
      }
    }
    return { v: sum / Math.max(1, n), n };
  };

  it('⭐⭐ НА ХОДУ ПОД 65–90° (остаток 15–40°) КЛИПЫ СНОСЯТ СТОПУ НЕ СИЛЬНЕЕ ПЛАНИРОВЩИКА', () => {
    // ⚠ Мутация «вес страйфа из `st` планировщика» валит это: было в 2.5–4.5 раза хуже.
    GAIT.warpOn = 1; GAIT.warpMax = 50;
    const h0 = buildHumanoid({});
    const p0 = new PosePlayer(h0, () => [], localStorageContent('warrior'), 'none', GX3, emptyGrid());
    const lib = new Map<string, Clip>();
    for (const sp of GAIT_PRESETS) lib.set(sp.name, bakeGaitToClip(p0, h0, sp, { character: 'warrior', weapon: 'none' }).clip);
    for (const deg of [65, 80, 90]) {
      const proc = drift(null, deg), clip = drift(lib, deg);
      expect(clip.n, `ход ${deg}°: ⚠ маховых кадров нет — сторож мерил бы пустоту`).toBeGreaterThan(300);
      expect(clip.v, `ход ${deg}°: клипы ${clip.v.toFixed(3)} против ${proc.v.toFixed(3)} у планировщика`).toBeLessThanOrEqual(proc.v);
    }
  });
});

describe('галка «бег клипами» в настройках клиента', () => {
  const GAIT0 = { ...GAIT };
  const GX = { armDown: 1.35, elbowBend: 0.25 };   // минимальные ручки рук — как в соседних тестах походки
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => {
    setLocoMixOverride(null);
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    Object.assign(GAIT, GAIT0);
  });

  /** Кадр походки с одним клипом локомоции на все направления. Возвращает повороты всех костей. */
  const frame = (locoOf: (names: readonly string[], weapon: string) => Clip | null): number[] => {
    const h = buildHumanoid({});
    const base = localStorageContent('warrior');
    const p = new PosePlayer(h, () => [], { ...base, locoClip: locoOf }, 'sword', GX, emptyGrid());
    p.setVel(0, 115); p.setYaw(0);
    for (let i = 0; i < 90; i++) p.step(1 / 60);
    h.root.updateMatrixWorld(true);
    const out: number[] = [];
    for (const [, b] of [...h.bones].sort((a, b2) => a[0].localeCompare(b2[0]))) out.push(b.rotation.x, b.rotation.y, b.rotation.z);
    return out;
  };

  /** Заведомо НЕ совпадающая с процедуркой поза: все кости в ноль. */
  const flat: Clip = { name: 'run_fwd', character: 'warrior', weapon: 'none', loop: true,
    keys: [{ t: 0, pose: { Spine: [0.4, 0, 0], LeftUpperLeg: [0, 0, 0], RightUpperLeg: [0, 0, 0] } }, { t: 0.5, pose: { Spine: [0.4, 0, 0], LeftUpperLeg: [0, 0, 0], RightUpperLeg: [0, 0, 0] } }] } as unknown as Clip;

  it('⭐⭐ ГАЛКА РЕШАЕТ, ДАЖЕ ЕСЛИ В КОНФИГЕ ПЕРСОНАЖА НАПИСАНО ОБРАТНОЕ', () => {
    // ⚠ Мутация «писать выбор в GAIT.locoMix вместо override» валит это: конфиг куклы перезагружается
    // при каждой смене персонажа/этажа и затёр бы выбор игрока.
    GAIT.locoMix = 0;                                   // редактор: планировщик
    setLocoMixOverride(1);                              // игрок: клипы
    const clips = frame(() => flat);
    setLocoMixOverride(0);                              // игрок: планировщик
    const planner = frame(() => flat);
    expect(clips, '⚠ галка «клипами» ничего не поменяла').not.toEqual(planner);

    GAIT.locoMix = 1;                                   // редактор: клипы…
    expect(frame(() => flat), '⚠ галка «StepPlanner» не перебила настройку редактора').toEqual(planner);
  });

  it('⭐⭐ ПЕРЕКЛЮЧЕНИЕ ГАЛКИ — НЕ РЫВОК: доля клипа разгоняется, а не прыгает', () => {
    // ⚠ Мутация «mix = цель без разгона» валит это: галка в бою дёргала бы позу целиком за кадр.
    GAIT.locoMix = 0;
    const h = buildHumanoid({});
    const base = localStorageContent('warrior');
    const p = new PosePlayer(h, () => [], { ...base, locoClip: () => flat }, 'sword', GX, emptyGrid());
    p.setVel(0, 115); p.setYaw(0);
    setLocoMixOverride(0);
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    const snap = (): number[] => { h.root.updateMatrixWorld(true); const o: number[] = []; for (const [, b] of [...h.bones].sort((a2, b2) => a2[0].localeCompare(b2[0]))) o.push(b.rotation.x, b.rotation.y, b.rotation.z); return o; };
    const before = snap();
    setLocoMixOverride(1);                                     // игрок щёлкнул галкой
    p.step(1 / 60);
    const after = snap();
    let jump = 0;
    for (let i = 0; i < after.length; i++) jump = Math.max(jump, Math.abs(after[i]! - before[i]!) * 180 / Math.PI);
    expect(jump, `⚠ поза прыгнула на ${jump.toFixed(1)}° за один кадр`).toBeLessThan(12);
  });

  it('⚠ НЕ ТРОГАЛ ГАЛКУ — РАБОТАЕТ НАСТРОЙКА РЕДАКТОРА (null ≠ «выключено»)', () => {
    GAIT.locoMix = 1;
    setLocoMixOverride(null);
    const asConfigured = frame(() => flat);
    setLocoMixOverride(1);
    expect(frame(() => flat), '⚠ «не трогал» повело себя не как настройка редактора').toEqual(asConfigured);
    expect(getLocoMixOverride()).toBe(1);
  });
});
