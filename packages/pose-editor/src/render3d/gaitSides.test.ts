import { describe, it, expect, afterEach } from 'vitest';
import { GAIT, POSE, ASYM, sideOf, sideLerp } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

/**
 * РАЗДЕЛЬНЫЕ СТОРОНЫ И ПЛЕЧЕВОЙ ПОЯС.
 *
 * Две вещи, которых в тюнинге походки не было. Первая: любой параметр можно развести на левую и правую
 * сторону — до этого всё было жёстко симметрично, и «перекос» персонажа авторить было нечем. Вторая:
 * ключицы. Они двигались, но настроить в них было НЕЧЕГО — `applyUpper` на ходу блендил их в [0,0,0],
 * то есть плечевой пояс просто выключался тем сильнее, чем быстрее бежишь.
 *
 * Главное требование к обеим: пока ничего не разведено и ручки плеч в нуле, походка обязана остаться
 * ПРЕЖНЕЙ до последнего знака. Симметрия ничего не стоит, платит только тот, кто её нарушил.
 */
const DT = 1 / 60;
const clearAsym = (): void => { for (const k of Object.keys(ASYM)) delete ASYM[k]; };
const POSE0 = { ...POSE };
afterEach(() => { clearAsym(); Object.assign(POSE, POSE0); });

/** Прогон вперёд с заданной скоростью; возвращает след выбранных полей позы по кадрам. */
function run(speed: number, frames = 300, pick: (o: Record<string, number>) => number[] = (o) => [o.hipL!, o.hipR!, o.knL!, o.knR!]): number[][] {
  const d = new PoseDriver(); let x = 0, z = 0; const out: number[][] = [];
  for (let i = 0; i < frames; i++) {
    z += speed * DT;
    d.setWorld(x, z, 0, 0, speed);
    const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
    out.push(pick(d.update(DT) as unknown as Record<string, number>));
  }
  return out;
}
const maxDiff = (a: number[][], b: number[][]): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[i]!.length; j++) m = Math.max(m, Math.abs(a[i]![j]! - b[i]![j]!));
  return m;
};

describe('выбор значения по стороне', () => {
  it('пустая карта — обе стороны берут общее число', () => {
    expect(sideOf('stepRun', 44, 0)).toBe(44);
    expect(sideOf('stepRun', 44, 1)).toBe(44);
  });

  it('заполненная — каждая сторона свою', () => {
    ASYM['stepRun'] = [30, 50];
    expect(sideOf('stepRun', 44, 0)).toBe(30);
    expect(sideOf('stepRun', 44, 1)).toBe(50);
  });

  it('интерполяция ходьба→бег идёт ПО СТОРОНЕ, а не по общему числу', () => {
    ASYM['stepWalk'] = [10, 20]; ASYM['stepRun'] = [30, 60];
    expect(sideLerp('stepWalk', 'stepRun', 35, 44, 0, 0.5)).toBe(20);   // (10+30)/2
    expect(sideLerp('stepWalk', 'stepRun', 35, 44, 1, 0.5)).toBe(40);   // (20+60)/2
  });
});

describe('походка без асимметрии не изменилась', () => {
  it('пустая карта = ровно прежние углы (бег, ходьба, медленный шаг)', () => {
    for (const sp of [15, 40, 115]) {
      const a = run(sp);
      ASYM['stepRun'] = [GAIT.stepRun, GAIT.stepRun];     // «развели», но в одинаковые числа
      const b = run(sp);
      clearAsym();
      expect(maxDiff(a, b), `скорость ${sp}`).toBe(0);
    }
  });

  it('run-двойники формы по умолчанию равны ходьбе → бег не поехал', () => {
    expect(GAIT.pelvisMinRun).toBe(GAIT.pelvisMin);
    expect(GAIT.hipFwdLimRun).toBe(GAIT.hipFwdLim);
    expect(GAIT.stanceWidthRun).toBe(GAIT.stanceWidth);
    expect(GAIT.strafeReachRun).toBe(GAIT.strafeReach);
    expect(GAIT.crossClampRun).toBe(GAIT.crossClamp);
  });
});

describe('асимметрия реально доезжает до ног', () => {
  it('разная длина шага Л/П → одна нога выносится дальше вперёд другой', () => {
    // ⚠ Размах бедра тут ни при чём: фаза ОДНА на обе ноги, поэтому за цикл они обязаны покрыть один
    // и тот же путь — иначе персонаж разъедется. Асимметрия длины шага сдвигает не размах, а ЦЕНТР:
    // короткий шаг = стопа ставится ближе под таз и дольше уезжает назад. Это и есть хромота.
    // Меряем ПИК выноса вперёд (hip < 0 = нога вперёд) — он приходит раз за цикл, поэтому от длины
    // окна замера не зависит, в отличие от среднего.
    const fwdPeak = (r: number[][], k: number): number => Math.min(...r.map((f) => f[k]!));
    // Сравниваем КАЖДУЮ ногу С САМОЙ СОБОЙ до и после — так замер не зависит от того, насколько
    // симметричен сам планировщик (а он симметричен не идеально).
    const sym = run(115, 400, (o) => [o.hipL!, o.hipR!]);
    ASYM['stepRun'] = [GAIT.stepRun * 0.4, GAIT.stepRun];
    const asy = run(115, 400, (o) => [o.hipL!, o.hipR!]);
    expect(fwdPeak(asy, 0) - fwdPeak(sym, 0), 'левая с коротким шагом стала выноситься ближе').toBeGreaterThan(0.1);
    expect(Math.abs(fwdPeak(asy, 1) - fwdPeak(sym, 1)), 'правую не тронули').toBeLessThan(0.05);
  });

  it('разный подъём стопы Л/П → одна нога поднимается выше', () => {
    ASYM['liftRun'] = [4, 20];
    const r = run(115, 300, (o) => [o.knL!, o.knR!]);
    const kL = Math.max(...r.map((f) => f[0]!)), kR = Math.max(...r.map((f) => f[1]!));
    expect(kR, 'правая с подъёмом 20 гнёт колено сильнее левой с 4').toBeGreaterThan(kL);
  });

  it('разная доля опоры Л/П → одна нога стоит дольше другой', () => {
    ASYM['dutyRun'] = [0.12, 0.34];
    const d = new PoseDriver(); let z = 0; let swL = 0, swR = 0;
    for (let i = 0; i < 600; i++) {
      z += 115 * DT; d.setWorld(0, z, 0, 0, 115);
      const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
      d.update(DT);
      if (i > 120) { const [a, b] = d.swingLegs; if (a) swL++; if (b) swR++; }
    }
    expect(swL, 'левая с малой долей опоры больше времени в воздухе').toBeGreaterThan(swR * 1.2);
  });
});

describe('плечевой пояс', () => {
  const sho = (frames = 200, speed = 115): number[][] =>
    run(speed, frames, (o) => [o.shoLX!, o.shoLY!, o.shoLZ!, o.shoRX!, o.shoRY!, o.shoRZ!]);

  it('нули в ручках — ключицы ровно в нуле (как было до правки)', () => {
    for (const f of sho()) for (const v of f) expect(Math.abs(v)).toBe(0);   // ±0 — знак стороны на нуле
  });

  it('база поднимает/выносит/скручивает плечо и ЗЕРКАЛЬНО на второй стороне', () => {
    POSE.shoUpRun = 0.2; POSE.shoFwdRun = 0.1; POSE.shoTwRun = 0.05;
    const f = sho(200)[199]!;
    expect(f[2], 'левая: подъём вокруг +Z').toBeCloseTo(0.2, 6);
    expect(f[5], 'правая: то же движение — противоположный знак').toBeCloseTo(-0.2, 6);
    expect(f[1]).toBeCloseTo(-0.1, 6);
    expect(f[4]).toBeCloseTo(0.1, 6);
    expect(f[0]).toBeCloseTo(0.05, 6);
    expect(f[3]).toBeCloseTo(-0.05, 6);
  });

  it('качание и подъём идут ОТ МАХА СВОЕЙ РУКИ — в противофазе между сторонами', () => {
    POSE.shoSwingRun = 0.5; POSE.shoLiftRun = 0.5;
    const r = sho(300);
    const swingL = Math.max(...r.map((f) => f[1]!)) - Math.min(...r.map((f) => f[1]!));
    const liftL = Math.max(...r.map((f) => f[2]!)) - Math.min(...r.map((f) => f[2]!));
    expect(swingL, 'пояс качается, а не стоит').toBeGreaterThan(0.05);
    expect(liftL, 'и поднимается').toBeGreaterThan(0.05);
    // Противофаза. ⚠ В СЫРОМ эйлере она выглядит как РАВЕНСТВО: «вперёд» у левой ключицы — это −Y,
    // у правой +Y (риг зеркальный). Левая впереди и правая сзади ⇒ fwdL = −fwdR ⇒ shoLY = shoRY.
    const worst = Math.max(...r.map((f) => Math.abs(f[1]! - f[4]!)));
    expect(worst, 'левая впереди ⇔ правая сзади').toBeLessThan(1e-9);
    // А если бы они шли синхронно (оба вперёд), сырые Y были бы противоположны — проверим, что это не так.
    expect(Math.max(...r.map((f) => Math.abs(f[1]!)))).toBeGreaterThan(0.05);
  });

  it('стоя пояс не качается (мах руки нулевой)', () => {
    POSE.shoSwing = 0.5; POSE.shoLift = 0.5; POSE.shoSwingRun = 0.5; POSE.shoLiftRun = 0.5;
    const r = sho(200, 0);
    const span = Math.max(...r.map((f) => f[1]!)) - Math.min(...r.map((f) => f[1]!));
    expect(span).toBeLessThan(1e-9);
  });

  it('стороны разводятся и у плеч тоже', () => {
    POSE.shoUpRun = 0; ASYM['shoUpRun'] = [0.3, 0];
    const f = sho(200)[199]!;
    expect(f[2], 'левое плечо поднято').toBeCloseTo(0.3, 6);
    expect(f[5], 'правое — нет').toBeCloseTo(0, 6);
  });
});
