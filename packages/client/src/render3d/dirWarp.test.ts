import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, stepDirWarp, DIR_WARP0, localStorageContent, emptyGrid } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import { GAIT } from './pose.js';

/**
 * ДОВОРОТ ТАЗА ПОД НАПРАВЛЕНИЕ ДВИЖЕНИЯ (Ф0, прототип orientation warping).
 *
 * Ставка простая: если низ доворачивается к ходу и играет «вперёд», то диагональ перестаёт быть
 * отдельной анимацией — восемь направлений на скорость схлопываются в четыре, и покупной пак
 * локомоции сокращается вдвое. Прежде чем на это закладываться, прототип обязан вести себя
 * предсказуемо в цифрах, а не «вроде повернулось».
 *
 * Отдельно стережём главное: доворот по умолчанию ВЫКЛЮЧЕН и без тумблера не меняет НИЧЕГО.
 */
const D = Math.PI / 180;
const CFG = { on: 1, maxDeg: 50, smooth: 0 };   // smooth=0 → мгновенно, видно чистое решение без сглаживания
const TWIST = 80 * D;                           // запас скрутки корпуса профиля по умолчанию (1.4 рад)

/** Прогнать функцию до установившегося значения (сглаживание — экспонента, за секунду сходится). */
const settle = (rootYaw: number, aimYaw: number, vx: number, vz: number,
  cfg = CFG, maxTwist = TWIST): number => {
  let w = { ...DIR_WARP0 };
  for (let i = 0; i < 240; i++) w = stepDirWarp(w, rootYaw, aimYaw, vx, vz, maxTwist, 1 / 60, cfg);
  return w.warp;
};
/** Скорость 100 u/с под углом `deg` в мировых осях. */
const vel = (deg: number): [number, number] => [100 * Math.sin(deg * D), 100 * Math.cos(deg * D)];

describe('доворот таза: чистая функция', () => {
  it('выключенный доворот — ровно ноль, чем его ни корми', () => {
    expect(settle(0, 0, 100, 100, { on: 0, maxDeg: 50, smooth: 0 })).toBe(0);
    // и накопленный доворот гасится, а не залипает: тумблер выключили — таз вернулся.
    let w = { warp: 40 * D, back: false };
    for (let i = 0; i < 240; i++) w = stepDirWarp(w, 0, 0, 100, 100, TWIST, 1 / 60, { on: 0, maxDeg: 50, smooth: 0.12 });
    expect(Math.abs(w.warp)).toBeLessThan(1e-6);
  });

  it('стоим — доворачивать не по чему (направление на нулевой скорости это шум)', () => {
    expect(settle(0, 0, 0, 0)).toBe(0);
    expect(settle(0, 0, 2, 2)).toBe(0);          // 2.8 u/с — ниже порога MOVE_EPS_WARP
  });

  it('диагональ 45° — таз доворачивается ровно на 45°, потолок не мешает', () => {
    const w = settle(0, 0, 100, 100);            // движение вправо-вперёд
    expect(w / D).toBeCloseTo(45, 3);
  });

  it('знак: идём влево — таз уходит влево', () => {
    expect(settle(0, 0, -100, 100) / D).toBeCloseTo(-45, 3);
  });

  it('чистый бок — упирается в потолок, остаток ОСТАЁТСЯ боковым (это и есть страйф)', () => {
    const w = settle(0, 0, 100, 0);              // 90° вправо
    expect(w / D).toBeCloseTo(50, 3);            // потолок
    expect(90 - w / D).toBeCloseTo(40, 3);       // 40° так и уезжают вбок — отдельный порог не нужен
  });

  it('ХОД СПИНОЙ — это шаг назад, а не разворот: таз НЕ трогаем', () => {
    // Замер на живом плеере до этой складки: на 180° доворот уводил таз на 50° в произвольную
    // сторону, ноги скрещивались 28 % кадров (без доворота — 0 %). Теперь ровно ноль.
    expect(Math.abs(settle(0, 0, ...vel(180)))).toBe(0);
    // А остаток от «назад» доворачивается: ход 135° = спиной и на 45° вбок.
    expect(settle(0, 0, ...vel(135)) / D).toBeCloseTo(-45, 3);
    expect(settle(0, 0, ...vel(-135)) / D).toBeCloseTo(45, 3);
  });

  it('ГИСТЕРЕЗИС у 90°: выбор «вперёд/назад» не щёлкает на границе', () => {
    const run = (deg: number, from: { warp: number; back: boolean }): { warp: number; back: boolean } => {
      let w = from;
      for (let i = 0; i < 240; i++) w = stepDirWarp(w, 0, 0, ...vel(deg), TWIST, 1 / 60, CFG);
      return w;
    };
    // Подошли к 95° СПЕРЕДИ (с 80°) — всё ещё «вперёд»: порог входа 102°.
    const fromFwd = run(95, run(80, { ...DIR_WARP0 }));
    expect(fromFwd.back).toBe(false);
    // Подошли к 85° СЗАДИ (со 120°) — всё ещё «назад»: порог выхода 78°.
    const fromBack = run(85, run(120, { ...DIR_WARP0 }));
    expect(fromBack.back).toBe(true);
    // Ровно на границе состояние зависит от истории — и это правильно, иначе дрожь каждый кадр.
    expect(fromFwd.warp).not.toBeCloseTo(fromBack.warp, 3);
  });

  it('БЮДЖЕТ СКРУТКИ: верх обязан суметь отвернуться обратно к прицелу', () => {
    // Скрутки почти нет (10°) — значит и доворота не больше 10°, иначе персонаж перестанет целиться.
    const tight = settle(0, 0, 100, 100, CFG, 10 * D);
    expect(tight / D).toBeCloseTo(10, 3);
    // Прицел уведён на 30° в ТУ ЖЕ сторону — бюджет сдвигается за ним. Но остаток корпуса УЖЕ
    // подрезан пределом (10°), поэтому окно доворота = [0°, 20°], а не [20°, 40°]: считаем от того
    // числа, которое реально ляжет на позвоночник, а не от недостижимого «хочу 30».
    const helped = settle(0, 30 * D, 100, 100, CFG, 10 * D);
    expect(helped / D).toBeCloseTo(20, 3);
    // И он же запрещает доворот В ПРОТИВОХОД: прицел ушёл направо, идём налево, скрутка уже на
    // пределе — уводить таз ещё левее некуда, верх за ним не успеет отвернуться.
    const against = settle(0, 30 * D, -100, 100, CFG, 10 * D);
    expect(against).toBe(0);
  });

  it('после доворота остаточная скрутка ВСЕГДА влезает в предел', () => {
    const maxTwist = 35 * D;
    for (let aim = -180; aim <= 180; aim += 15) {
      for (let dir = -180; dir < 180; dir += 15) {
        const vx = 100 * Math.sin(dir * D), vz = 100 * Math.cos(dir * D);
        const w = settle(0, aim * D, vx, vz, CFG, maxTwist);
        const residual = Math.max(-maxTwist, Math.min(maxTwist, Math.atan2(Math.sin(aim * D), Math.cos(aim * D))));
        expect(Math.abs(residual - w), `прицел ${aim}°, ход ${dir}°`).toBeLessThanOrEqual(maxTwist + 1e-9);
      }
    }
  });

  it('сглаживание: за кадр проходит долю пути, а не щёлкает', () => {
    const one = stepDirWarp({ ...DIR_WARP0 }, 0, 0, 100, 100, TWIST, 1 / 60, { on: 1, maxDeg: 50, smooth: 0.12 }).warp;
    expect(one / D).toBeCloseTo(45 * (1 / 60) / 0.12, 3);          // ≈ 6.25° за первый кадр
    expect(settle(0, 0, 100, 100, { on: 1, maxDeg: 50, smooth: 0.12 }) / D).toBeCloseTo(45, 2);   // но сходится туда же
  });

  it('доворот считается ОТ ТАЗА, а не от мира', () => {
    // Таз уже смотрит на 45°, туда же и бежим → доворачивать нечего.
    expect(Math.abs(settle(45 * D, 45 * D, 100, 100))).toBeLessThan(1e-9);
  });
});

describe('доворот таза: живой плеер', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    GAIT.warpOn = 0;                       // тумблер глобальный — не тащим его в соседние тесты
  });

  const mk = (): PosePlayer =>
    new PosePlayer(buildHumanoid({}), () => [], localStorageContent('warrior'), 'sword',
      { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
  /** Бежать под углом `dir` при прицеле строго вперёд; вернуть угол таза. */
  const run = (dir: number): { pelvis: number; warp: number } => {
    const p = mk(); p.setYaw(0);
    p.setVel(GAIT.speedRun * Math.sin(dir), GAIT.speedRun * Math.cos(dir));
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    return { pelvis: p.pelvisYaw, warp: p.dirWarpDeg };
  };

  it('ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ: диагональный бег идёт как раньше', () => {
    expect(GAIT.warpOn).toBe(0);
    const r = run(45 * D);
    expect(r.warp).toBe(0);
    expect(Math.abs(r.pelvis)).toBeLessThan(1e-6);   // таз держит прицел, движение его не крутит
  });

  it('включён: на диагонали таз развёрнут к ходу, а прицел остаётся прицелом', () => {
    GAIT.warpOn = 1;
    const r = run(45 * D);
    expect(r.warp).toBeCloseTo(45, 0);               // низ повернулся к движению
    expect(r.pelvis / D).toBeCloseTo(45, 0);         // и это ВИДНО снаружи (в Hips уходит именно он)
    const p = mk(); p.setYaw(0);
    p.setVel(GAIT.speedRun * Math.sin(45 * D), GAIT.speedRun * Math.cos(45 * D));
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    expect(p.facing).toBe(0);                        // прицел не сдвинулся ни на градус
  });

  it('включён: прямой бег вперёд таз НЕ трогает', () => {
    GAIT.warpOn = 1;
    const r = run(0);
    expect(Math.abs(r.warp)).toBeLessThan(0.5);
  });

  it('включён: бег СПИНОЙ таз не трогает — иначе ноги скрещивались бы', () => {
    GAIT.warpOn = 1;
    const r = run(180 * D);
    expect(Math.abs(r.warp)).toBeLessThan(0.5);
  });
});
