import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { GAIT, POSE } from './pose.js';
import { bakeGaitToClip, BAKE_MAXSPD } from './clipBake.js';
import { analyzeGait, gaitSuggestions } from './gaitAnalyze.js';

/**
 * КРУГОВОЙ ТЕСТ: `анализ(запекание(параметры)) ≈ параметры`.
 *
 * У нас есть ОБЕ стороны — запекатель гонит живой планировщик в клип, анализатор читает клип обратно.
 * Это редкая возможность проверить инструмент им же самим, и спрос тут особый: анализатор пишет
 * настройки ДВАДЦАТИ ползунков, и ошибка в нём не видна глазами — она проявится потом, когда
 * подогнанная «под пак» походка окажется чужой.
 *
 * Допуски разные и это честно: период и доля опоры снимаются точно, а ширина стойки и подъём стопы
 * проходят через IK и физическую высоту рига, поэтому мерятся грубее. Числа в допусках — замеренные,
 * а не назначенные.
 */
const GX = { armDown: 1.35, elbowBend: 0.25 };
const mk = (h: Humanoid): PosePlayer => new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', GX, emptyGrid());

describe('анализ запечённой походки', () => {
  const GAIT0 = { ...GAIT }, POSE0 = { ...POSE };
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => { /* */ }, removeItem: () => { /* */ }, clear: () => { /* */ }, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    Object.assign(GAIT, GAIT0); Object.assign(POSE, POSE0);
  });

  /** Запечь клип на известной скорости и прочитать его обратно. */
  const roundTrip = (vz: number): ReturnType<typeof analyzeGait> => {
    const h = buildHumanoid({});
    const r = bakeGaitToClip(mk(h), h, { name: 'walk_fwd', vx: 0, vz }, { character: 'warrior', weapon: 'sword' });
    return analyzeGait(r.clip, { speed: vz * BAKE_MAXSPD, human: buildHumanoid({}) });
  };

  it('ПЕРИОД И ДЛИНА ШАГА сходятся с настройкой: фаза едет от пути, поэтому равенство точное', () => {
    const speed = 0.42 * BAKE_MAXSPD;
    const m = roundTrip(0.42);
    // Шаг занимает stepLen/speed секунд, цикл — вдвое больше. Значит stepLen = speed·период/2.
    expect(m.stepLen).not.toBeNull();
    expect(m.stepLen!).toBeCloseTo(speed * m.periodSec / 2, 6);
    // И это же число обязано совпасть с настройкой, из которой клип и запечён (± прореживание кадров).
    const want = GAIT.stepWalk + (GAIT.stepRun - GAIT.stepWalk) * Math.max(0, Math.min(1, (speed - GAIT.speedWalk) / (GAIT.speedRun - GAIT.speedWalk)));
    expect(Math.abs(m.stepLen! - want) / want, `шаг ${m.stepLen!.toFixed(1)} против ${want.toFixed(1)}`).toBeLessThan(0.12);
  });

  it('ДОЛЯ ОПОРЫ восстанавливается ПОЧТИ ТОЧНО — по высоте И скорости стопы', () => {
    // Допуск узкий нарочно: замер на воине даёт 0.34 при эталоне 0.34 и 0.20 при 0.20. Широкий допуск
    // пропустил бы возврат к признаку «только высота», который режимы вообще не различал.
    expect(Math.abs(roundTrip(0.42).duty - GAIT.dutyWalk)).toBeLessThan(0.04);
    expect(Math.abs(roundTrip(0.95).duty - GAIT.dutyRun)).toBeLessThan(0.04);
  });

  it('на бегу доля опоры МЕНЬШЕ, чем на ходьбе — иначе анализ перепутал бы режимы', () => {
    expect(roundTrip(0.95).duty).toBeLessThan(roundTrip(0.42).duty);
  });

  it('ПОДЪЁМ СТОПЫ на бегу заметно выше, чем на шагу', () => {
    const walk = roundTrip(0.42), run = roundTrip(0.95);
    expect(run.lift).toBeGreaterThan(walk.lift * 1.3);
  });

  it('СКОЛЬЖЕНИЕ — диагностика, а не настройка: у запечённой походки оно мало', () => {
    const m = roundTrip(0.42);
    expect(m.slide).not.toBeNull();
    expect(m.slide!, `размах стопы ${m.footRange.toFixed(1)} против шага ${m.stepLen!.toFixed(1)}`).toBeLessThan(0.5);
  });

  it('амплитуда маха и база плеча восстанавливаются из клипа', () => {
    const m = roundTrip(0.42);
    expect(Math.abs(m.armSwing - POSE.armSwing * 0.85), `мах ${m.armSwing.toFixed(2)}`).toBeLessThan(0.35);
    expect(Math.abs(m.armSh - POSE.armSh), `база ${m.armSh.toFixed(2)}`).toBeLessThan(0.35);
  });

  it('ширина стойки положительна и правдоподобна', () => {
    const m = roundTrip(0.42);
    expect(m.stanceWidth).toBeGreaterThan(1);
    expect(m.stanceWidth).toBeLessThan(30);
  });
});

describe('без скорости честного ответа нет', () => {
  it('нет корня и не сказали скорость — длина шага `null`, а не выдуманное число', () => {
    const m = analyzeGait({ name: 'x', character: 'w', weapon: 'none', loop: true, keys: [
      { t: 0, pose: { LeftUpperLeg: [0.3, 0, 0], RightUpperLeg: [-0.3, 0, 0] } },
      { t: 0.5, pose: { LeftUpperLeg: [-0.3, 0, 0], RightUpperLeg: [0.3, 0, 0] } },
    ] }, { human: buildHumanoid({}) });
    expect(m.speed).toBeNull();
    expect(m.stepLen).toBeNull();
    expect(m.slide).toBeNull();
    expect(m.periodSec, 'период всё равно известен — он равен длительности').toBeCloseTo(0.5, 9);
  });
});

describe('предложения настроек', () => {
  const m = { periodSec: 1, speed: 50, stepLen: 25, footRange: 24, slide: 0.04, duty: 0.3, lift: 9, bob: 2,
    stanceWidth: 7, armSwing: 0.6, armSh: -0.2, armEl: 0.5, turnRad: null, frames: 60 };

  it('ничего не применяют сами — только «было → стало»', () => {
    const s = gaitSuggestions(m, { stepWalk: 35 }, false);
    const step = s.find((x) => x.key === 'stepWalk')!;
    expect(step.was).toBe(35);
    expect(step.now).toBe(25);
  });

  it('беговой клип ложится в БЕГОВУЮ колонку, а не затирает настроенную ходьбу', () => {
    const keys = gaitSuggestions(m, {}, true).map((x) => x.key);
    expect(keys).toContain('stepRun');
    expect(keys).not.toContain('stepWalk');
  });

  it('совпавшее значение в список не попадает — незачем показывать «было 25 → стало 25»', () => {
    expect(gaitSuggestions(m, { stepWalk: 25 }, false).find((x) => x.key === 'stepWalk')).toBeUndefined();
  });
});
