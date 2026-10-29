import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { PosePlayer, stepDirWarp, nearestWarpSector, DIR_WARP0, SECTOR_HYST, localStorageContent, emptyGrid, type DirWarp } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import { GAIT } from './gaitKnobs.js';

/**
 * ДОВОРОТ ТАЗА ПОД НАПРАВЛЕНИЕ ДВИЖЕНИЯ — ЧЕТЫРЕ СЕКТОРА (Lyra / UE Orientation Warping).
 *
 * Ход складывается к БЛИЖАЙШЕЙ из четырёх осей (вперёд, +X = strafe_R, назад, −X = strafe_L), доворачивается
 * только остаток. ⚠ Было две оси (вперёд/назад): на чистых 90° таз уезжал на потолок, ноги шли под 50° к тазу,
 * а бленд клипов играл 0.54 страйфа + 0.46 вперёд — «страйф выглядит как диагональ 45°».
 *
 * Отдельно стережём главное: доворот по умолчанию ВЫКЛЮЧЕН и без тумблера не меняет НИЧЕГО.
 */
const D = Math.PI / 180;
const CFG = { on: 1, maxDeg: 50, smooth: 0 };   // smooth=0 → мгновенно, видно чистое решение без сглаживания
const TWIST = 80 * D;                           // запас скрутки корпуса профиля по умолчанию (1.4 рад)

/** Прогнать функцию до установившегося значения (сглаживание — экспонента, за секунду сходится). */
const settleW = (rootYaw: number, aimYaw: number, vx: number, vz: number,
  cfg: Parameters<typeof stepDirWarp>[7] = CFG, maxTwist = TWIST, from: DirWarp = { ...DIR_WARP0 }): DirWarp => {
  let w = from;
  for (let i = 0; i < 240; i++) w = stepDirWarp(w, rootYaw, aimYaw, vx, vz, maxTwist, 1 / 60, cfg);
  return w;
};
const settle = (rootYaw: number, aimYaw: number, vx: number, vz: number, cfg: Parameters<typeof stepDirWarp>[7] = CFG, maxTwist = TWIST): number =>
  settleW(rootYaw, aimYaw, vx, vz, cfg, maxTwist).warp;
/** Скорость 100 u/с под углом `deg` в мировых осях. */
const vel = (deg: number): [number, number] => [100 * Math.sin(deg * D), 100 * Math.cos(deg * D)];

describe('доворот таза: чистая функция', () => {
  it('выключенный доворот — ровно ноль, чем его ни корми', () => {
    expect(settle(0, 0, 100, 100, { on: 0, maxDeg: 50, smooth: 0 })).toBe(0);
    // и накопленный доворот гасится, а не залипает: тумблер выключили — таз вернулся.
    let w: DirWarp = { warp: 40 * D, sector: 0, moving: true, rate: 0 };
    for (let i = 0; i < 240; i++) w = stepDirWarp(w, 0, 0, 100, 100, TWIST, 1 / 60, { on: 0, maxDeg: 50, smooth: 0.12 });
    expect(Math.abs(w.warp)).toBeLessThan(1e-6);
  });

  it('стоим — доворачивать не по чему (направление на нулевой скорости это шум)', () => {
    expect(settle(0, 0, 0, 0)).toBe(0);
    expect(settle(0, 0, 2, 2)).toBe(0);          // 2.8 u/с — ниже порога MOVE_EPS_WARP
  });

  it('⭐⭐ ЧИСТЫЙ БОК — ДОВОРОТ 0, сектор strafe_R / strafe_L (было: потолок 50° и ноги под 40° к тазу)', () => {
    // ⚠ Мутация «складывать только к вперёд/назад» валит это: 90° давали +50.
    const r = settleW(0, 0, ...vel(90));
    expect(Math.abs(r.warp)).toBeLessThan(1e-9);
    expect(r.sector).toBe(1);
    const l = settleW(0, 0, ...vel(-90));
    expect(Math.abs(l.warp)).toBeLessThan(1e-9);
    expect(l.sector).toBe(3);
  });

  it('остаток до ближайшей оси: 30 → +30, 60 → −30, 120 → +30, 150 → −30, 180 → 0', () => {
    expect(settle(0, 0, ...vel(30)) / D).toBeCloseTo(30, 3);
    expect(settle(0, 0, ...vel(60)) / D).toBeCloseTo(-30, 3);
    expect(settle(0, 0, ...vel(120)) / D).toBeCloseTo(30, 3);
    expect(settle(0, 0, ...vel(150)) / D).toBeCloseTo(-30, 3);
    expect(Math.abs(settle(0, 0, ...vel(180)))).toBe(0);   // ход спиной — шаг назад, а не разворот
    // знак: влево — зеркально
    expect(settle(0, 0, ...vel(-30)) / D).toBeCloseTo(-30, 3);
    expect(settle(0, 0, ...vel(-60)) / D).toBeCloseTo(30, 3);
    expect(settle(0, 0, ...vel(-150)) / D).toBeCloseTo(30, 3);
  });

  it('⭐ НИЧЬЯ РОВНО НА ±45° / ±135° — явное правило, зеркальное по знаку: отдаётся оси вперёд/назад', () => {
    // ⚠ Мутация «ближайшая ось по Math.round» валит это: +135 уходило назад, −135 — в L (таз −45 в обоих случаях),
    // а C# `Mathf.RoundToInt` округляет половину к чётному — порт разошёлся бы на самой границе.
    expect(nearestWarpSector(45 * D)).toBe(0);
    expect(nearestWarpSector(-45 * D)).toBe(0);
    expect(nearestWarpSector(135 * D)).toBe(2);
    expect(nearestWarpSector(-135 * D)).toBe(2);
    expect(nearestWarpSector(Math.PI)).toBe(2);
    expect(nearestWarpSector(45.01 * D)).toBe(1);
    expect(nearestWarpSector(-134.99 * D)).toBe(3);
    // со старта (без памяти) — доворот тоже зеркальный
    expect(settle(0, 0, ...vel(45)) / D).toBeCloseTo(45, 3);
    expect(settle(0, 0, ...vel(-45)) / D).toBeCloseTo(-45, 3);
    expect(settle(0, 0, ...vel(135)) / D).toBeCloseTo(-45, 3);
    expect(settle(0, 0, ...vel(-135)) / D).toBeCloseTo(45, 3);
  });

  it('⭐ ГИСТЕРЕЗИС на ±45° ОДНОСТОРОННИЙ: «вперёд/назад» держится до 45° + SECTOR_HYST, бок отдаёт их сразу, дрожь не щёлкает', () => {
    const H = SECTOR_HYST / D;
    const go = (deg: number, from: DirWarp): DirWarp => settleW(0, 0, ...vel(deg), CFG, TWIST, from);
    // Подошли к 50° СПЕРЕДИ (с 30°) — всё ещё «вперёд» (порог 45 + 10), доворот упёрся в 50.
    const fromFwd = go(50, go(30, { ...DIR_WARP0 }));
    expect(fromFwd.sector).toBe(0);
    expect(fromFwd.warp / D).toBeCloseTo(50, 3);
    // ⭐⭐ Подошли к 40° СБОКУ (с 90°) — уже «вперёд» с доворотом +40 (решение автора 07.10: бок не держится против
    // «вперёд/назад»; раньше strafe_R держался до 35° с доворотом −50). Ровно на 45° — ничья, тоже «вперёд»; на 46° — бок.
    const fromSide = go(40, go(90, { ...DIR_WARP0 }));
    expect(fromSide.sector).toBe(0);
    expect(fromSide.warp / D).toBeCloseTo(40, 3);
    expect(go(45, go(90, { ...DIR_WARP0 })).sector).toBe(0);
    expect(go(46, go(90, { ...DIR_WARP0 })).sector).toBe(1);
    // За порогом — перебрасывается.
    expect(go(45 + H + 1, go(30, { ...DIR_WARP0 })).sector).toBe(1);
    expect(go(45 - H - 1, go(90, { ...DIR_WARP0 })).sector).toBe(0);
    // Дрожь 45 ± 6° (меньше гистерезиса) — ни одного переброса.
    let w = go(45, { ...DIR_WARP0 }), flips = 0;
    for (let i = 0; i < 600; i++) {
      const s = w.sector;
      w = stepDirWarp(w, 0, 0, ...vel(45 + Math.sin(i * 1.7) * 6), TWIST, 1 / 60, CFG);
      if (w.sector !== s) flips++;
    }
    expect(flips).toBe(0);
    // На ±135 — то же, с обеих сторон.
    expect(go(128, go(170, { ...DIR_WARP0 })).sector).toBe(2);
    expect(go(142, go(100, { ...DIR_WARP0 })).sector, 'бок отдаёт «назад» сразу, как оно ближе').toBe(2);
    expect(go(132, go(100, { ...DIR_WARP0 })).sector).toBe(1);
    expect(go(142, go(170, { ...DIR_WARP0 })).sector).toBe(2);
  });

  it('⭐ ГИСТЕРЕЗИС ТОЛЬКО НА ХОДУ: встали — сектор забыт, старт берёт ближайший (Lyra bWasMovingLastUpdate)', () => {
    // ⚠ Мутация «гистерезис без условия движения» валит это: 60° → стоп → 35° шёл сектором R с доворотом −55.
    const side = settleW(0, 0, ...vel(60));
    expect(side.sector).toBe(1);
    const stop = settleW(0, 0, 0, 0, CFG, TWIST, side);
    expect(stop.moving).toBe(false);
    const go = settleW(0, 0, ...vel(35), CFG, TWIST, stop);
    expect(go.sector).toBe(0);
    expect(go.warp / D).toBeCloseTo(35, 3);
  });

  it('СТАРАЯ СКЛАДКА (sectors:false — пока страйфы не перезапечены): вперёд/назад с гистерезисом 90° ± 12°', () => {
    const LEG = { ...CFG, sectors: false };
    expect(settle(0, 0, 100, 0, LEG) / D).toBeCloseTo(50, 3);                 // чистый бок — потолок, как было
    expect(settle(0, 0, ...vel(135), LEG) / D).toBeCloseTo(-45, 3);
    const run = (deg: number, from: DirWarp): DirWarp => settleW(0, 0, ...vel(deg), LEG, TWIST, from);
    expect(run(95, run(80, { ...DIR_WARP0 })).sector).toBe(0);                // спереди — вход в «назад» на 102°
    expect(run(85, run(120, { ...DIR_WARP0 })).sector).toBe(2);               // сзади — выход на 78°
    // ⭐ ФЛАГ «НАЗАД» ПОМНИТСЯ ЧЕРЕЗ ОСТАНОВКУ — это ПРЕЖНЕЕ поведение, и ветка живёт ровно для неперезапечённых
    // наборов, которым обещано «как было». ⚠ Мутация «на старте считать флаг заново по текущему ходу» (как у
    // СЕКТОРОВ, где забывание нарочное) даёт другой ЗНАК доворота, и не на кадр: гистерезис тут же залипает на
    // новом выборе и держит его весь забег. ЗАМЕР (потолок 50°): спиной → стоп → 85° = −50° против +50°.
    const back = run(120, { ...DIR_WARP0 });
    const stopped = settleW(0, 0, 0, 0, LEG, TWIST, back);
    expect(stopped.moving, 'встали').toBe(false);
    const again = run(85, stopped);
    expect(again.sector, 'после остановки «назад» помнится — выход по-прежнему на 78°').toBe(2);
    expect(again.warp / D).toBeCloseTo(-50, 3);
  });

  it('БЮДЖЕТ СКРУТКИ: верх обязан суметь отвернуться обратно к прицелу', () => {
    // Скрутки почти нет (10°) — значит и доворота не больше 10°, иначе персонаж перестанет целиться.
    const tight = settle(0, 0, ...vel(30), CFG, 10 * D);
    expect(tight / D).toBeCloseTo(10, 3);
    // Прицел уведён на 30° в ТУ ЖЕ сторону — бюджет сдвигается за ним. Остаток корпуса УЖЕ подрезан пределом (10°),
    // поэтому окно доворота = [0°, 20°]: считаем от того числа, которое реально ляжет на позвоночник.
    const helped = settle(0, 30 * D, ...vel(30), CFG, 10 * D);
    expect(helped / D).toBeCloseTo(20, 3);
    // И он же запрещает доворот В ПРОТИВОХОД: прицел ушёл направо, идём налево, скрутка уже на пределе.
    const against = settle(0, 30 * D, ...vel(-30), CFG, 10 * D);
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

  it('потолок: остаток больше потолка подрезается (он доедается блендом клипов)', () => {
    expect(settle(0, 0, ...vel(44), { on: 1, maxDeg: 40, smooth: 0 }) / D).toBeCloseTo(40, 3);
  });

  it('сглаживание: за кадр проходит долю пути, а не щёлкает', () => {
    const one = stepDirWarp({ ...DIR_WARP0 }, 0, 0, ...vel(30), TWIST, 1 / 60, { on: 1, maxDeg: 50, smooth: 0.12 }).warp;
    expect(one / D).toBeCloseTo(30 * (1 / 60) / 0.12, 3);          // 4.17° за первый кадр
    expect(settle(0, 0, ...vel(30), { on: 1, maxDeg: 50, smooth: 0.12 }) / D).toBeCloseTo(30, 2);   // но сходится туда же
  });

  it('доворот считается ОТ ТАЗА, а не от мира', () => {
    // Таз уже смотрит на 45°, туда же и бежим → доворачивать нечего.
    expect(Math.abs(settle(45 * D, 45 * D, 100, 100))).toBeLessThan(1e-9);
    // Таз на 90°, бежим на 90° мира — это «вперёд» для таза, а не страйф.
    expect(settleW(90 * D, 90 * D, ...vel(90)).sector).toBe(0);
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
  const run = (dir: number): { pelvis: number; warp: number; sector: number } => {
    const p = mk(); p.setYaw(0);
    p.setVel(GAIT.speedRun * Math.sin(dir), GAIT.speedRun * Math.cos(dir));
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    return { pelvis: p.pelvisYaw, warp: p.dirWarpDeg, sector: p.dirWarpSector };
  };

  it('ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ: диагональный бег идёт как раньше', () => {
    expect(GAIT.warpOn).toBe(0);
    const r = run(45 * D);
    expect(r.warp).toBe(0);
    expect(Math.abs(r.pelvis)).toBeLessThan(1e-6);   // таз держит прицел, движение его не крутит
  });

  it('включён: на диагонали таз развёрнут к ходу, а прицел остаётся прицелом', () => {
    GAIT.warpOn = 1;
    const r = run(30 * D);
    expect(r.warp).toBeCloseTo(30, 0);               // низ повернулся к движению
    expect(r.pelvis / D).toBeCloseTo(30, 0);         // и это ВИДНО снаружи (в Hips уходит именно он)
    const p = mk(); p.setYaw(0);
    p.setVel(GAIT.speedRun * Math.sin(30 * D), GAIT.speedRun * Math.cos(30 * D));
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    expect(p.facing).toBe(0);                        // прицел не сдвинулся ни на градус
  });

  it('⭐⭐ включён: ЧИСТЫЙ БОК — таз ровно на прицеле (|доворот| < 0.5°), сектор страйфа', () => {
    GAIT.warpOn = 1;
    const r = run(90 * D);
    expect(Math.abs(r.warp)).toBeLessThan(0.5);
    expect(Math.abs(r.pelvis / D)).toBeLessThan(0.5);
    expect(r.sector).toBe(1);
    expect(run(-90 * D).sector).toBe(3);
  });

  it('включён: прямой бег вперёд и бег СПИНОЙ таз не трогают', () => {
    GAIT.warpOn = 1;
    expect(Math.abs(run(0).warp)).toBeLessThan(0.5);
    expect(Math.abs(run(180 * D).warp)).toBeLessThan(0.5);
  });

  it('⭐ ГРУДЬ НА ПРИЦЕЛЕ И НА ДИАГОНАЛИ: отворот доворота лежит на Spine..UpperChest, а не на шее с головой', () => {
    // ⚠ Мутация «отворот теми же весами, что и скрутка к прицелу» валит это: UpperChest отстаёт на (1 − 0.7) × 45° ≈ 13.5°.
    GAIT.warpOn = 1;
    const q = new THREE.Quaternion(), f = new THREE.Vector3();
    for (const deg of [45, -45, 135, -135]) {
      const h = buildHumanoid({});
      const p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'sword', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid());
      p.setYaw(0);
      p.setVel(GAIT.speedRun * Math.sin(deg * D), GAIT.speedRun * Math.cos(deg * D));
      let sum = 0, n = 0;
      for (let i = 0; i < 180; i++) {
        p.step(1 / 60);
        if (i < 120) continue;
        h.root.updateMatrixWorld(true);
        h.bones.get('UpperChest')!.getWorldQuaternion(q);
        f.set(0, 0, 1).applyQuaternion(q);
        sum += Math.atan2(f.x, f.z); n++;
      }
      expect(Math.abs(p.dirWarpDeg), `${deg}°: доворот действительно на потолке`).toBeGreaterThan(40);
      expect(Math.abs(sum / n / D), `${deg}°: грудь от прицела`).toBeLessThan(3);
    }
  });
});
