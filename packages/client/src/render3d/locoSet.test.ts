import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHumanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride, getLocoMixOverride } from './poseRuntime.js';
import { GAIT } from './pose.js';
import { LOCO_NAMES, LOCO_DIRS, locoClipName, locoClipNames, findLocoClip } from './locoBlend.js';
import { GAIT_PRESETS, defaultBakePick } from './clipBake.js';
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
    expect(defaultBakePick().length, 'по умолчанию запекается весь набор').toBe(GAIT_PRESETS.length);
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

  it('⚠ НЕ ТРОГАЛ ГАЛКУ — РАБОТАЕТ НАСТРОЙКА РЕДАКТОРА (null ≠ «выключено»)', () => {
    GAIT.locoMix = 1;
    setLocoMixOverride(null);
    const asConfigured = frame(() => flat);
    setLocoMixOverride(1);
    expect(frame(() => flat), '⚠ «не трогал» повело себя не как настройка редактора').toEqual(asConfigured);
    expect(getLocoMixOverride()).toBe(1);
  });
});
