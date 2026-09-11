import { describe, it, expect, afterEach } from 'vitest';
import { PoseDriver, GAIT, HIP_DX } from './pose.js';

/**
 * РЕЗКАЯ СМЕНА НАПРАВЛЕНИЯ: «шагает неестественно широко» и «шагает на скрещенных ногах».
 *
 * Жалоба была про ритм: водишь точку по паду влево-вправо — и если попасть в такт шагу, нога
 * вылетает на полную длину, а в другом такте ноги скрещиваются. Ритм тут не случайность, а
 * резонанс: фаза походки едет от ПРОЙДЕННОГО ПУТИ, а путь при перекладке набегает в обе стороны.
 *
 * Механика поломки. В ровном ходе стопа ставится на `lead` впереди бедра, за окно опоры тело
 * проезжает два `lead`, и нога уходит на столько же назад — вынос симметричен и мал. На развороте
 * тело уезжает в сторону, которую нога не предполагала, и ВЕСЬ проезд ложится в одну сторону:
 * вынос удваивается, упирается в длину ноги (28.5), IK выпрямляет её в палку. Скрещивание — та же
 * причина с другой стороны: пока просроченная опорная стоит на старом месте, маховая уже ставится
 * на новую сторону, и ноги оказываются перекрещены относительно тела.
 *
 * Лечится двумя ручками:
 *   `planSmooth` — стопа ставится под УСРЕДНЁННОЕ направление (у мечущегося вектора среднее само
 *      сжимается к нулю → стопа встаёт под таз, а не улетает туда, откуда тело ушло);
 *   `stepSlack`/`stepUrge` — просроченный шаг ускоряет фазу, маховая садится раньше и снимает
 *      нагрузку с растянутой опорной (в робототехнике — step timing adaptation; в анимации ту же
 *      работу делает отдельный клип pivot, обрывающий текущий шаг).
 *
 * Тесты сравнивают ОДИН И ТОТ ЖЕ прогон с ручками и без — магических чисел нет, и правка не может
 * «пройти» за счёт того, что кто-то подкрутил пороги.
 */
const DT = 1 / 60;
const LEG = 28.5;                  // L_THIGH + L_SHIN (pose.ts) — за этим пределом нога выпрямлена в палку
const DEF = { planSmooth: GAIT.planSmooth, stepSlack: GAIT.stepSlack, stepUrge: GAIT.stepUrge };
const OFF = { planSmooth: 0, stepSlack: DEF.stepSlack, stepUrge: 0 };
afterEach(() => Object.assign(GAIT, DEF));

type Run = { spread: number; reach: number; crossPct: number; jerk: number };

/**
 * Прогон с перекладкой направления между `dirA` и `dirB` каждые `halfSec` (>1e3 = ровный ход).
 * Меряем то, что видно глазом: вынос опорной от своего бедра, разъезд стоп, долю кадров
 * с перекрёстом и пиковую угловую скорость бедра (рывок).
 */
function flip(dirA: number, dirB: number, halfSec: number, secs = 4, speed = GAIT.speedRun): Run {
  const d = new PoseDriver();
  let x = 0, z = 0, t = 0, spread = 0, reach = 0, cross = 0, n = 0, jerk = 0, prevHip = 0;
  for (let i = 0; i < Math.round((secs + 2) * 60); i++) {
    const dir = Math.floor(t / halfSec) % 2 ? dirB : dirA;
    const vx = speed * Math.sin(dir), vz = speed * Math.cos(dir);
    x += vx * DT; z += vz * DT; t += DT;
    d.setWorld(x, z, 0, vx, vz);
    const p0 = d.plantTarget(0), p1 = d.plantTarget(1);
    d.setFeet(p0[0], p0[1], p1[0], p1[1]);       // физики здесь нет — щиколотки берём расчётные
    const o = d.update(DT);
    if (i > 120) jerk = Math.max(jerk, Math.abs(o.hipL - prevHip) / DT);
    prevHip = o.hipL;
    if (i < 120) continue;                        // разгон не меряем
    const a = d.plantTarget(0), b = d.plantTarget(1);
    spread = Math.max(spread, Math.hypot(a[0] - b[0], a[1] - b[1]));
    reach = Math.max(reach, Math.hypot(a[0] - (x + HIP_DX), a[1] - z), Math.hypot(b[0] - (x - HIP_DX), b[1] - z));
    if (a[0] - x < b[0] - x) cross++;             // нога 0 (левая, +X) оказалась ПРАВЕЕ правой
    n++;
  }
  return { spread, reach, crossPct: 100 * cross / n, jerk };
}

/** Худшее по всем перекладкам, которые способен выдать живой человек на паде. */
function worstFlip(): Run & { reachByFreq: number[] } {
  let w: Run = { spread: 0, reach: 0, crossPct: 0, jerk: 0 };
  const reachByFreq: number[] = [];
  for (const [a, b] of [[-Math.PI / 2, Math.PI / 2], [-Math.PI / 4, Math.PI / 4], [0, Math.PI]] as [number, number][]) {
    for (const ms of [1000, 700, 500, 400, 330, 260, 200, 150, 100]) {
      const r = flip(a, b, ms / 1000);
      w = { spread: Math.max(w.spread, r.spread), reach: Math.max(w.reach, r.reach), crossPct: Math.max(w.crossPct, r.crossPct), jerk: Math.max(w.jerk, r.jerk) };
      if (a < -1) reachByFreq.push(r.reach);      // страйф Л↔П — на нём и ловили резонанс
    }
  }
  return { ...w, reachByFreq };
}

/** Тот же замер с выключенными ручками — «как было». */
const asWas = <T>(f: () => T): T => { Object.assign(GAIT, OFF); const r = f(); Object.assign(GAIT, DEF); return r; };

describe('перекладка направления не ломает шаг', () => {
  it('нога перестала вытягиваться в палку', () => {
    const was = asWas(worstFlip), now = worstFlip();
    expect(was.reach, 'до правки нога уходила почти на всю длину').toBeGreaterThan(LEG * 0.9);
    expect(now.reach, `было ${was.reach.toFixed(1)}, стало ${now.reach.toFixed(1)} при длине ноги ${LEG}`)
      .toBeLessThan(LEG * 0.7);
  });

  it('стопы не разъезжаются вдвое против ровного бега', () => {
    const straight = flip(0, 0, 1e4).spread;
    const was = asWas(worstFlip), now = worstFlip();
    expect(was.spread / straight, 'до правки разъезд был вдвое больше ровного').toBeGreaterThan(1.9);
    expect(now.spread, `было ${was.spread.toFixed(1)}, стало ${now.spread.toFixed(1)}, ровный бег ${straight.toFixed(1)}`)
      .toBeLessThan(straight * 1.4);
  });

  it('перекрёста стало заметно меньше', () => {
    // Перекрёст в РОВНОМ страйфе — отдельная история: он лечится авторскими точками обвода (via),
    // так решил юзер, автоматических ограничителей-полусфер тут быть не должно. Здесь чиним только
    // ДОБАВКУ от разворота: пока просроченная опорная стоит на старом месте, ноги перекрещены.
    const was = asWas(worstFlip), now = worstFlip();
    expect(now.crossPct, `было ${was.crossPct.toFixed(0)} %, стало ${now.crossPct.toFixed(0)} %`)
      .toBeLessThan(was.crossPct * 0.85);
  });

  it('рывок в бедре упал вдвое', () => {
    const was = asWas(worstFlip), now = worstFlip();
    expect(now.jerk, `было ${was.jerk.toFixed(0)} рад/с, стало ${now.jerk.toFixed(0)} рад/с`)
      .toBeLessThan(was.jerk * 0.7);
  });

  it('РИТМ БОЛЬШЕ НИЧЕГО НЕ РЕШАЕТ: разброс по частотам перекладки упал', () => {
    // Суть жалобы — «если попасть в ритм». Значит мерить надо не худший случай, а РАЗБРОС: пока он
    // большой, всегда найдётся частота, на которой персонажа корёжит.
    const span = (r: number[]): number => Math.max(...r) - Math.min(...r);
    const was = span(asWas(worstFlip).reachByFreq), now = span(worstFlip().reachByFreq);
    expect(now, `разброс выноса был ${was.toFixed(1)}, стал ${now.toFixed(1)}`).toBeLessThan(was * 0.6);
  });
});

describe('РОВНЫЙ ХОД НЕ ЗАДЕТ — ни на одной скорости', () => {
  /**
   * Главный сторож всей правки: обе ручки обязаны молчать, пока направление не меняется.
   * Сравниваем КАДР В КАДР с выключенными ручками — расхождение должно быть ровно нулевым,
   * иначе мы поменяли походку, а не починили разворот.
   */
  const trace = (dir: number, speed: number, frames: number, accel: boolean): number[][] => {
    const d = new PoseDriver(); let x = 0, z = 0; const out: number[][] = [];
    for (let i = 0; i < frames; i++) {
      const sp = accel ? Math.min(speed, i * 4) : speed;          // разгон с места: 0 → полный ход
      const vx = sp * Math.sin(dir), vz = sp * Math.cos(dir);
      x += vx * DT; z += vz * DT;
      d.setWorld(x, z, 0, vx, vz);
      const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
      const o = d.update(DT);
      out.push([o.hipL, o.hipR, o.knL, o.knR, o.hipLatL, o.hipLatR, o.bobY]);
    }
    return out;
  };
  const cases: [string, number, number, boolean][] = [
    ['бег вперёд', 0, 115, false], ['ходьба', 0, 40, false], ['медленный шаг', 0, 15, false],
    ['очень быстрый бег', 0, 160, false], ['страйф', Math.PI / 2, 115, false],
    ['диагональ', Math.PI / 4, 90, false], ['назад', Math.PI, 60, false],
    ['разгон с места', 0, 115, true], ['разгон вбок', Math.PI / 2, 115, true],
  ];
  for (const [name, dir, sp, acc] of cases) {
    it(`${name}: кадр в кадр как без ручек`, () => {
      Object.assign(GAIT, OFF);
      const was = trace(dir, sp, 400, acc);
      Object.assign(GAIT, DEF);
      const now = trace(dir, sp, 400, acc);
      let worst = 0;
      for (let i = 0; i < was.length; i++) for (let j = 0; j < was[i]!.length; j++) worst = Math.max(worst, Math.abs(was[i]![j]! - now[i]![j]!));
      expect(worst).toBe(0);
    });
  }
});
