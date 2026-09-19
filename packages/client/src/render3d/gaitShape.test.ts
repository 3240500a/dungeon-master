import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, POSE, POSE_BASE, GAIT, GAIT_BASE } from './pose.js';

/**
 * ⭐ ШЕСТЬ НОВЫХ РУЧЕК ФОРМЫ ПОХОДКИ — И НИ ОДНА НЕ МЕНЯЕТ ПОВЕДЕНИЕ ПО УМОЛЧАНИЮ.
 *
 * Запрос: «по стопам внутрь-наружу, и по бёдрам — сейчас только колени регулируются, этого не
 * хватает; таз при беге должен чуть опускаться от idle (в idle он почти на прямых ногах); и
 * качание влево-право таза, и наклоны в двух плоскостях. Главное — не поломай что работает».
 *
 * Что было: у стопы в рантайме стоял ЖЁСТКИЙ НОЛЬ по Y (`blendBone('LeftFoot', [t.ankL, 0, 0])`),
 * поэтому носок было нечем развернуть, а таз умел только вверх-вниз (`bobY`).
 *
 * ЗАМЕРЫ в живом редакторе (рыцарь, бег):
 *   носок  −0.6 → вынос пальца от лодыжки −1.01, 0 → +2.02, +0.6 → +4.39 (обе стороны зеркальны);
 *   бёдра  +0.3 → колено 3.46 → 9.43, стопа 3.08 → 10.44 (нога разводится ЦЕЛИКОМ);
 *   просадка 4 → таз на ходу 34.549 → 30.508 (ровно 4.04), а СТОЯ 34.769 → 34.769 (не тронут);
 *   качание 3 → размах X 6.06; крен 0.3 → размах rot.z 0.606; наклон 0.3 → размах rot.x 0.606.
 */
describe('форма походки: стопа, бедро и таз в двух плоскостях', () => {
  const savedP: Record<string, number> = {}, savedG: Record<string, number> = {};
  const setP = (k: string, v: number): void => {
    const o = POSE as unknown as Record<string, number>;
    if (!(k in savedP)) savedP[k] = o[k]!;
    o[k] = v;
  };
  const setG = (k: string, v: number): void => {
    const o = GAIT as unknown as Record<string, number>;
    if (!(k in savedG)) savedG[k] = o[k]!;
    o[k] = v;
  };
  afterEach(() => {
    const p = POSE as unknown as Record<string, number>, g = GAIT as unknown as Record<string, number>;
    for (const k in savedP) p[k] = savedP[k]!;
    for (const k in savedG) g[k] = savedG[k]!;
    for (const k in savedP) delete savedP[k];
    for (const k in savedG) delete savedG[k];
  });

  /** Прогон бега; вернуть кадры привода. */
  function run(speed = 90, frames = 200): PoseDriver['out'][] {
    const d = new PoseDriver();
    d.setMove(1);
    let z = 0;
    const out: PoseDriver['out'][] = [];
    for (let i = 0; i < frames + 120; i++) {
      z += speed / 60;
      d.setWorld(0, z, 0, 0, speed);
      d.update(1 / 60);
      if (i >= 120) out.push({ ...d.out });
    }
    return out;
  }
  /** Числовые поля целей позы. ⚠ `mix` — не число, а смесь направлений (её читают ручки, живущие в рантайме). */
  type NumKey = Exclude<{ [K in keyof PoseDriver['out']]: PoseDriver['out'][K] extends number | undefined ? K : never }[keyof PoseDriver['out']], undefined>;
  const col = (f: PoseDriver['out'][], k: NumKey): number[] => f.map((o) => (o[k] as number | undefined) ?? 0);
  const rng = (f: PoseDriver['out'][], k: NumKey): number => {
    const c = col(f, k); return Math.max(...c) - Math.min(...c);
  };
  const avg = (f: PoseDriver['out'][], k: NumKey): number =>
    col(f, k).reduce((s, v) => s + v, 0) / f.length;

  it('умолчания — ровный ноль: ни одна новая ручка не трогает прежнюю походку', () => {
    for (const k of ['footTurn', 'footTurnRun', 'hipSplay', 'hipSplayRun',
      'hipSway', 'hipSwayRun', 'hipsRollSwing', 'hipsRollSwingRun', 'hipsPitchSwing', 'hipsPitchSwingRun'] as const) {
      expect((POSE_BASE as unknown as Record<string, number>)[k], `⚠ ${k} по умолчанию не 0`).toBe(0);
    }
    expect(GAIT_BASE.crouchWalk).toBe(0);
    expect(GAIT_BASE.crouchRun).toBe(0);
    const f = run();
    for (const k of ['ankYawL', 'ankYawR', 'hipSplayL', 'hipSplayR', 'bobX', 'hipsRoll', 'hipsPitch'] as const) {
      expect(rng(f, k) + Math.abs(avg(f, k)), `⚠ канал ${k} шевелится при нулевых ручках`).toBeLessThan(1e-9);
    }
  });

  it('⭐ НОСОК: зеркально и с верным знаком (+ наружу)', () => {
    setP('footTurn', 0.6); setP('footTurnRun', 0.6);
    const f = run();
    // Зеркало: у правой стопы тот же угол с обратным знаком (риг зеркальный).
    expect(avg(f, 'ankYawL')).toBeCloseTo(0.6, 6);
    expect(avg(f, 'ankYawR')).toBeCloseTo(-0.6, 6);
  });

  it('⭐ БЁДРА: свой канал, а не прибавка к решению IK', () => {
    // Прибавка к `hipLat` уводила стопу с планта на 19 ед — теперь развод идёт отдельным доворотом.
    const before = run();
    setP('hipSplay', 0.3); setP('hipSplayRun', 0.3);
    const after = run();
    expect(avg(after, 'hipSplayL')).toBeCloseTo(0.3, 6);
    expect(Math.abs(avg(after, 'hipLatL') - avg(before, 'hipLatL')),
      '⚠ развод бёдер снова течёт в решение IK').toBeLessThan(1e-9);
  });

  it('⭐ ПРОСАДКА ТАЗА: на ходу опускает, СТОЯ не трогает', () => {
    const moving0 = avg(run(), 'bobY');
    setG('crouchWalk', 4); setG('crouchRun', 4);
    const moving1 = avg(run(), 'bobY');
    expect(moving0 - moving1, '⚠ просадка не опускает таз на ходу').toBeGreaterThan(2);
    // Стоим: moveAmt → 0, значит просадки быть не должно вовсе.
    const stand = (): number => {
      const d = new PoseDriver(); d.setMove(0);
      for (let i = 0; i < 200; i++) { d.setWorld(0, 0, 0, 0, 0); d.update(1 / 60); }
      return d.out.bobY;
    };
    const s1 = stand();
    setG('crouchWalk', 0); setG('crouchRun', 0);
    expect(s1, '⚠ просадка опускает таз даже стоя — стойка обязана остаться нетронутой').toBeCloseTo(stand(), 9);
  });

  it('⭐ ТАЗ В ДВУХ ПЛОСКОСТЯХ + качание вбок — каждая ручка правит СВОЙ канал', () => {
    setP('hipSway', 3); setP('hipSwayRun', 3);
    setP('hipsRollSwing', 0.3); setP('hipsRollSwingRun', 0.3);
    setP('hipsPitchSwing', 0.2); setP('hipsPitchSwingRun', 0.2);
    const f = run();
    expect(rng(f, 'bobX'), '⚠ качание таза вбок не работает').toBeGreaterThan(1);
    expect(rng(f, 'hipsRoll'), '⚠ крен таза не работает').toBeGreaterThan(0.1);
    expect(rng(f, 'hipsPitch'), '⚠ наклон таза не работает').toBeGreaterThan(0.05);
  });

  it('ручки независимы: крен не течёт в наклон и наоборот', () => {
    setP('hipsRollSwing', 0.4); setP('hipsRollSwingRun', 0.4);
    const f = run();
    expect(rng(f, 'hipsRoll')).toBeGreaterThan(0.1);
    expect(rng(f, 'hipsPitch'), '⚠ крен течёт в наклон').toBeLessThan(1e-9);
    expect(rng(f, 'bobX'), '⚠ крен течёт в боковое смещение').toBeLessThan(1e-9);
  });
});
