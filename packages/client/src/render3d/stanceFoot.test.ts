import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, POSE } from './pose.js';

/**
 * ⭐ СТОПА В ПОКОЕ = АВТОРСКАЯ СТОЙКА, а не «прямо».
 *
 * Жалоба: «доступил куда надо, а потом в idle-позу раздвигается, ступни скручиваются».
 *
 * ЗАМЕР расхождения поза↔планировщик в покое (углы костей ног, рад): бедро и голень — сотые,
 * а СТОПА: слева рыск **0.502 (28.8°)**, справа −0.296 и наклон −0.314 (18°). То есть «скручивание»
 * — это почти целиком стопа, и расхождение СТАТИЧЕСКОЕ: планты планировщик из авторской стойки брал,
 * а ОРИЕНТАЦИЮ стопы держал нулевой.
 *
 * ⚠ ИМЕННО КРОССФЕЙД, А НЕ ПРИБАВКА. Первая версия прибавляла авторский рыск к ходовой ручке
 * `footTurn` — и в покое та продолжала крутить стопу поверх: при `footTurn` = −0.36 авторские +0.142
 * превращались в −0.218, ровно на ползунок мимо. ЗАМЕР после кроссфейда: расхождение стопы **0.000**
 * по обеим осям, худшее по всей ноге упало 0.502 → 0.124 (голень).
 */
describe('стопа в покое берётся из авторской стойки', () => {
  const saved: Record<string, number> = {};
  const set = (k: string, v: number): void => {
    const g = POSE as unknown as Record<string, number>;
    if (!(k in saved)) saved[k] = g[k]!;
    g[k] = v;
  };
  afterEach(() => {
    const g = POSE as unknown as Record<string, number>;
    for (const k in saved) g[k] = saved[k]!;
    for (const k in saved) delete saved[k];
  });

  const FOOT = { pitchL: -0.048, yawL: 0.142, pitchR: -0.314, yawR: 0.064 };

  /** Прогон: стоим (speed 0) или бежим, вернуть ориентацию стопы на выходе драйвера. */
  function run(moving: boolean): { yawL: number; yawR: number; pitchL: number; pitchR: number } {
    const d = new PoseDriver();
    d.setStance(8, 5.3, -7.4, -2.4, 33.4, FOOT);
    d.setMove(moving ? 1 : 0);
    let z = 0;
    for (let i = 0; i < 400; i++) {
      if (moving) z += 90 / 60;
      d.setWorld(0, z, 0, 0, moving ? 90 : 0);
      d.update(1 / 60);
    }
    return { yawL: d.out.ankYawL, yawR: d.out.ankYawR, pitchL: d.out.ankL, pitchR: d.out.ankR };
  }

  it('⭐ СТОЯ стопа РОВНО авторская (и рыск, и наклон)', () => {
    set('footTurn', -0.36); set('footTurnRun', -0.36);   // ⚠ `footTurn` живёт в POSE, а не в GAIT — ходовая ручка выкручена
    const s = run(false);
    // ⚠ Мутация «прибавлять, а не блендить» валит это: ходовой `footTurn` останется поверх.
    expect(s.yawL, '⚠ рыск ЛЕВОЙ стопы не авторский — на передаче ног позе она довернётся').toBeCloseTo(FOOT.yawL, 6);
    expect(s.yawR, '⚠ рыск ПРАВОЙ стопы не авторский').toBeCloseTo(FOOT.yawR, 6);
    expect(s.pitchL, '⚠ наклон ЛЕВОЙ стопы не авторский').toBeCloseTo(FOOT.pitchL, 6);
    expect(s.pitchR, '⚠ наклон ПРАВОЙ стопы не авторский').toBeCloseTo(FOOT.pitchR, 6);
  });

  it('⭐ НА ХОДУ стопу ведёт походка — авторская стойка не примешивается', () => {
    set('footTurn', -0.36); set('footTurnRun', -0.36);
    const m = run(true);
    // ⚠ Мутация «не гасить авторскую стопу движением» валит это: походка поедет на авторский разворот.
    expect(m.yawL, '⚠ авторский рыск тянется в походку').toBeCloseTo(-0.36, 3);
    expect(m.yawR, '⚠ авторский рыск тянется в походку (правая зеркальна)').toBeCloseTo(0.36, 3);
  });

  it('стойку не задали (golden-харнесс, монстры) — поведение прежнее', () => {
    const d = new PoseDriver();
    d.setMove(0); d.setWorld(0, 0, 0, 0, 0);
    for (let i = 0; i < 200; i++) d.update(1 / 60);
    expect(d.out.ankYawL, '⚠ без стойки ориентация стопы обязана остаться нулевой').toBe(0);
    expect(d.out.ankYawR).toBe(0);
  });
});
