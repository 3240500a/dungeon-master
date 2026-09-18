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

  it('⭐⭐ ГАШЕНИЕ ПО СВОЕМУ ВВОДУ УБИРАЕТ ПЕРЕЛЁТ', () => {
    // Жалоба: «отпускаешь бег — он останавливается и чуть назад двигается». Клиент предсказывал бег,
    // пока сервер не подтвердил остановку, и разницу приходилось отдавать движением НАЗАД.
    // ⚠ Мутация «не гасить по вводу» валит это: перелёт возвращается впятеро.
    const mk = (brake: boolean): { over: number; back: number } => {
      const ip = makeNetInterp();
      let srv = 0, next = 0, t = 0, over = 0, back = 0, prev = 0;
      ip.push('a', 0, 0, 0);
      const STOP = 1.2, RTT = 0.03;
      for (let k = 0; k < 150; k++) {
        t += FRAME;
        if (brake && t >= STOP) ip.brake('a', Infinity, t, FRAME);       // отпустил кнопку
        while (t >= next + TICK) { next += TICK; if (next < STOP + RTT) srv += SPEED * TICK; ip.push('a', 0, srv, next); }
        const z = ip.at('a', t).z;
        if (k) { over = Math.max(over, z - srv); back = Math.min(back, z - prev); }
        prev = z;
      }
      return { over, back };
    };
    const off = mk(false), on = mk(true);
    // ЗАМЕР в этом прогоне: 4.7 → 2.0 (в живой модели с реальным пингом было 4.5 → 0.9).
    expect(on.over, `⚠ перелёт не уменьшился: было ${off.over.toFixed(1)}, стало ${on.over.toFixed(1)}`).toBeLessThan(off.over * 0.5);
    expect(-on.back, '⚠ откат назад не уменьшился').toBeLessThan(-off.back);
  });

  it('⚠ ГАСИМ, А НЕ СНАПИМ — картинка не дёргается в момент гашения', () => {
    // ⚠ Мутация «обнулить скорость без записи ошибки» валит это: кадр гашения дал бы скачок назад
    // на весь накопленный перелёт.
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('a', 0, 4, TICK); ip.push('a', 0, 8, 2 * TICK);
    const t = 2 * TICK + 0.02;
    const before = ip.at('a', t).z;
    ip.brake('a', Infinity, t, FRAME);
    expect(ip.at('a', t).z, '⚠ СКАЧОК в момент гашения').toBeCloseTo(before, 9);
  });

  it('⭐ темп гашения уважается: с инерцией скорость падает постепенно', () => {
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('a', 0, 4, TICK); ip.push('a', 0, 8, 2 * TICK);
    const v0 = ip.at('a', 2 * TICK).vz;
    ip.brake('a', 300, 2 * TICK, FRAME);
    const v1 = ip.at('a', 2 * TICK).vz;
    expect(v1, '⚠ скорость не упала').toBeLessThan(v0);
    expect(v1, '⚠ скорость обнулилась вместо плавного гашения').toBeGreaterThan(0);
    expect(v0 - v1, '⚠ гасим не с заданным ускорением').toBeCloseTo(300 * FRAME, 6);
  });

  it('гашение стоящего актёра — ноль работы', () => {
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('a', 0, 0, TICK);
    const z = ip.at('a', 2 * TICK).z;
    ip.brake('a', Infinity, 2 * TICK, FRAME);
    expect(ip.at('a', 2 * TICK).z).toBe(z);
  });

  it('незнакомый актёр — нули, а не падение', () => {
    expect(makeNetInterp().at('нет такого', 1)).toEqual({ x: 0, z: 0, vx: 0, vz: 0 });
  });

  /**
   * ⭐⭐ СКОРОСТЬ СЧИТАЕТСЯ ПО ЧАСАМ СЕРВЕРА (`tick`), А НЕ ПО ИНТЕРВАЛУ ПРИХОДА.
   *
   * Приход дрожит вместе с сетью, а ±10 мс на 33 мс — это ±30 % мгновенной оценки скорости.
   * ЗАМЕР (стенд `torsoJitter.test.ts`, бег 80 ед/с): рябь 11.2–11.8 % по приходу и 0.3–0.4 % по тику.
   * Рябью живёт всё, что растёт из скорости: `moveMag`, оси бленда, часы клипа, планировщик.
   */
  it('⭐⭐ с тиком скорость ровная даже при дрожании прихода ±5 мс, без тика — рябит', () => {
    // ⚠ Мутация ·знаменатель — интервал прихода· валит этот сторож (и сторожа стенда).
    const err = (withTick: boolean): number => {
      const ip = makeNetInterp();
      let seed = 1;
      const jit = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 0x100000000 - 0.5) * 0.010; };
      let worst = 0;
      for (let k = 0; k < 120; k++) {
        const at = Math.max(0, k * TICK + (k ? jit() : 0));
        if (withTick) ip.push('a', 0, SPEED * k * TICK, at, k);
        else ip.push('a', 0, SPEED * k * TICK, at);
        if (k > 40) worst = Math.max(worst, Math.abs(ip.at('a', at).vz - SPEED) / SPEED * 100);
      }
      return worst;
    };
    expect(err(true), 'по тику').toBeLessThan(1.5);
    expect(err(false), 'по приходу — как было, с рябью').toBeGreaterThan(5);
  });

  it('калибровка «секунд в тике» сама находит темп сервера и не верит константе', () => {
    // Снапшоты 20 Гц при симе 30 Гц — тики идут неровно (2, 1, 2, 1…), и именно они различают
    // длинный интервал от короткого. Сгладить сам интервал прихода было бы неверно.
    const ip = makeNetInterp();
    const SIM = 1 / 30;
    let t = 0, z = 0, tick = 0;
    for (let k = 0; k < 80; k++) {
      const d = k % 2 ? 1 : 2;                       // 2, 1, 2, 1 … — ровно так шлёт `room.step` при 20 Гц
      tick += d; t += d * SIM; z += SPEED * d * SIM;
      ip.push('a', 0, z, t, tick);
    }
    expect(ip.tickSec, 'замеренный тик').toBeCloseTo(SIM, 4);
    expect(ip.at('a', t).vz).toBeCloseTo(SPEED, 2);
  });

  it('⚠ тик сброшен в ноль (смена этажа, `session.ts` `w.tick = 0`) — падаем на прежний путь, а не врём', () => {
    const ip = makeNetInterp();
    for (let k = 0; k < 40; k++) ip.push('a', 0, SPEED * k * TICK, k * TICK, k);
    const cal = ip.tickSec;
    // Новый этаж: тик с нуля, позиция рядом (не телепорт по мерке `TELEPORT`).
    let t = 40 * TICK, z = SPEED * 40 * TICK;
    for (let k = 0; k < 10; k++) { t += TICK; z += SPEED * TICK; ip.push('a', 0, z, t, k); }
    expect(Number.isFinite(ip.at('a', t).vz), 'скорость осталась числом').toBe(true);
    expect(ip.at('a', t).vz).toBeCloseTo(SPEED, 1);
    expect(ip.tickSec, 'калибровка не сломалась откатом тика').toBeCloseTo(cal, 4);
  });

  it('снапшот с десятком актёров не забивает окно калибровки копиями ОДНОГО интервала', () => {
    // ⚠ Мутация ·замер берётся с КАЖДОГО актёра· валит это (рябь 3.7 % при 20 актёрах): окно на 32 снапшота становится окном на один,
    // и один дрожащий приход сдвигает масштаб скорости всем актёрам сразу.
    const ip = makeNetInterp();
    let seed = 7;
    const jit = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 0x100000000 - 0.5) * 0.010; };
    let worst = 0;
    for (let k = 0; k < 120; k++) {
      const at = Math.max(0, k * TICK + (k ? jit() : 0));
      for (let a = 0; a < 20; a++) ip.push('a' + a, 0, SPEED * k * TICK, at, k);
      if (k > 40) worst = Math.max(worst, Math.abs(ip.at('a3', at).vz - SPEED) / SPEED * 100);
    }
    expect(worst, 'рябь при 20 актёрах в снапшоте').toBeLessThan(1.5);
  });

  it('учёт актёров: добавили и забыли', () => {
    const ip = makeNetInterp();
    ip.push('a', 0, 0, 0); ip.push('b', 0, 0, 0);
    expect(ip.size).toBe(2);
    ip.drop('a');
    expect(ip.size).toBe(1);
  });
});
