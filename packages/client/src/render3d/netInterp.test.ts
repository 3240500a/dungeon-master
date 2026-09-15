import { describe, it, expect } from 'vitest';
import { makeNetInterp, EXTRAP_MAX, TELEPORT } from './netInterp.js';

/**
 * ⭐⭐ СНАПШОТ 30 ГЦ → ГЛАДКИЙ КАДР.
 *
 * Жалоба: «персонаж чуть-чуть поддёргивается». ЗАМЕР старого способа (гнаться за последним снапшотом
 * экспоненциальным фильтром): вторая разность отрисованной позиции — **0.37 от шага кадра** на 60 fps
 * и **0.59 на 144 fps**. Фильтр не может сделать из лесенки прямую, он её только размазывает.
 *
 * Здесь проверяется то, ради чего заводился модуль: при ровном ходе кадры должны ложиться на ПРЯМУЮ,
 * на смене направления не должно быть скачка, а провал связи не должен уносить актёра в стену.
 */
describe('интерполяция снапшотов', () => {
  const TICK = 1 / 30, FRAME = 1 / 60, SPEED = 120;

  /** Прогон: сервер шлёт 30 Гц, рисуем 60 fps. Возвращает нарисованные Z и «истинные» Z. */
  function run(sec: number, speed = SPEED): { drawn: number[]; truth: number[] } {
    const ip = makeNetInterp();
    const drawn: number[] = [], truth: number[] = [];
    let srvZ = 0, nextTick = 0;
    ip.push('a', 0, 0, 0);
    for (let t = 0; t <= sec; t += FRAME) {
      while (t >= nextTick + TICK) { nextTick += TICK; srvZ += speed * TICK; ip.push('a', 0, srvZ, nextTick); }
      drawn.push(ip.at('a', t).z);
      truth.push(speed * t);
    }
    return { drawn, truth };
  }

  /** Худшая вторая разность, в долях шага кадра (0 = идеально ровное движение). */
  const jerk = (v: number[], speed = SPEED): number => {
    let w = 0;
    for (let i = 2; i < v.length; i++) w = Math.max(w, Math.abs(v[i]! - 2 * v[i - 1]! + v[i - 2]!) / (speed * FRAME));
    return w;
  };

  it('⭐⭐ РОВНЫЙ ХОД — КАДРЫ ЛОЖАТСЯ НА ПРЯМУЮ', () => {
    // ⚠ Мутация «не экстраполировать (рисовать последнюю серверную)» валит это: вернётся лесенка.
    const { drawn } = run(3);
    const tail = drawn.slice(Math.round(drawn.length * 0.5));
    expect(jerk(tail), `⚠ движение рваное: вторая разность ${jerk(tail).toFixed(3)} шага (у старого способа было 0.37)`).toBeLessThan(0.02);
  });

  it('⭐ ОТСТАВАНИЯ ОТ ПРАВДЫ ПОЧТИ НЕТ — экстраполяция не добавляет лага', () => {
    const { drawn, truth } = run(3);
    const i0 = Math.round(drawn.length * 0.5);
    let worst = 0;
    for (let i = i0; i < drawn.length; i++) worst = Math.max(worst, Math.abs(drawn[i]! - truth[i]!));
    expect(worst, '⚠ картинка отстала от истинной позиции').toBeLessThan(SPEED * TICK);   // меньше одного серверного шага
  });

  it('⭐⭐ НОВЫЙ СНАПШОТ НЕ ДЁРГАЕТ КАРТИНКУ — ошибка гасится, а не щёлкает', () => {
    // ⚠ Мутация «не запоминать расхождение» валит это: на каждом снапшоте был бы скачок.
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0);
    ip.push('a', 0, 4, TICK);
    ip.push('a', 0, 8, 2 * TICK);              // шёл ровно…
    const before = ip.at('a', 3 * TICK).z;
    ip.push('a', 0, 8, 3 * TICK);              // …и встал как вкопанный
    const after = ip.at('a', 3 * TICK).z;
    expect(after, '⚠ СКАЧОК на снапшоте').toBeCloseTo(before, 9);
  });

  it('⭐ СВЯЗЬ ПРОПАЛА — актёр не улетает: экстраполяция ограничена', () => {
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('a', 0, 4, TICK); ip.push('a', 0, 8, 2 * TICK);
    const far = ip.at('a', 2 * TICK + 5).z;                    // пять секунд тишины
    expect(far, '⚠ актёр уехал за горизонт').toBeLessThanOrEqual(8 + SPEED * EXTRAP_MAX + 1e-6);
  });

  it('⭐ ТЕЛЕПОРТ — СНАП, а не плавный переезд через полкомнаты', () => {
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('a', 0, 4, TICK);
    ip.push('a', 500, 500, 2 * TICK);
    const p = ip.at('a', 2 * TICK);
    expect(Math.hypot(p.x - 500, p.z - 500), '⚠ после телепорта картинка едет со старого места').toBeLessThan(1);
    expect(Math.hypot(p.vx, p.vz), '⚠ телепорт посчитали за скорость').toBe(0);
  });

  it('порог телепорта не срабатывает на обычном беге', () => {
    expect(SPEED * TICK, 'шаг за тик обязан быть сильно меньше порога').toBeLessThan(TELEPORT / 4);
  });

  it('⭐ ВСТАЛ — скорость уходит в ноль', () => {
    const ip = makeNetInterp();
    let z = 0;
    for (let i = 0; i < 20; i++) { z += SPEED * TICK; ip.push('a', 0, z, i * TICK); }
    for (let i = 20; i < 40; i++) ip.push('a', 0, z, i * TICK);       // стоим
    expect(Math.abs(ip.at('a', 40 * TICK).vz), '⚠ скорость не затухла — походка продолжит шагать').toBeLessThan(1);
  });

  it('⚠ СКОРОСТЬ СЧИТАЕТСЯ ПО ИНТЕРВАЛУ СНАПШОТОВ, а не по кадру', () => {
    // Ровно та причина, по которой рябила походка: частота кадров не должна влиять на ответ.
    const mk = (): number => {
      const ip = makeNetInterp();
      let z = 0;
      for (let i = 0; i < 30; i++) { z += SPEED * TICK; ip.push('a', 0, z, i * TICK); }
      return ip.at('a', 30 * TICK).vz;
    };
    expect(mk()).toBeCloseTo(SPEED, 1);
  });

  it('незнакомый актёр — нули, а не падение', () => {
    expect(makeNetInterp().at('нет такого', 1)).toEqual({ x: 0, z: 0, vx: 0, vz: 0 });
  });

  it('учёт актёров: добавили и забыли', () => {
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('b', 0, 0, 0);
    expect(ip.size).toBe(2);
    ip.drop('a');
    expect(ip.size).toBe(1);
  });
});
