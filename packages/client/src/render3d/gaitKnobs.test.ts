import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GAIT, POSE, ASYM, STRAFE, BACK, COMBAT, sideLerp, locoVal, strafeMix, backMix, foldElbow, type LocoMix } from './gaitKnobs.js';
import { PoseDriver } from './stepPlanner.js';

/** Смесь кадра одной строкой — в тестах читается лучше, чем четыре позиционных аргумента. */
const mix = (sb: number, st = 0, bt = 0, ct = 0, stR = 0, stL = 0): LocoMix => ({ sb, st, stR, stL, bt, ct });

/**
 * ЧЕТЫРЕ НОВЫЕ РУЧКИ ПОХОДКИ — и одно требование ко всем четырём.
 *
 * ФАЗА (рук и плеч), АМПЛИТУДА ЛОКТЯ, АМПЛИТУДА БЕДРА и СТРАЙФ-КОЛОНКА добавлены затем, чтобы
 * настраивалось то, что раньше было зашито. Общее требование: на дефолтах походка обязана остаться
 * ПРЕЖНЕЙ до последнего знака — иначе новая ручка не «добавила возможность», а сломала настроенное.
 *
 * Отдельно проверяется СВЁРТКА ЛОКТЯ. Она единственная меняет данные (три слагаемых в одно), поэтому
 * с неё спрос двойной: тот же угол на выходе И идемпотентность, потому что зовётся она при каждой
 * загрузке конфига и при каждой пересборке куклы.
 */
const DT = 1 / 60;
const POSE0 = { ...POSE }, GAIT0 = { ...GAIT };
const clear = (): void => {
  for (const k of Object.keys(ASYM)) delete ASYM[k];
  for (const k of Object.keys(STRAFE)) delete STRAFE[k];
  for (const k of Object.keys(COMBAT)) delete COMBAT[k];
};
afterEach(() => { clear(); Object.assign(POSE, POSE0); Object.assign(GAIT, GAIT0); });

/** Прогон с заданной скоростью и направлением (vx вбок, vz вперёд); след выбранных полей по кадрам. */
function run(vx: number, vz: number, frames = 240, pick: (o: Record<string, number>) => number[] = (o) => [o.hipL!, o.hipR!, o.knL!, o.knR!]): number[][] {
  const d = new PoseDriver(); let x = 0, z = 0; const out: number[][] = [];
  for (let i = 0; i < frames; i++) {
    x += vx * DT; z += vz * DT;
    d.setWorld(x, z, 0, vx, vz);
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
/** Размах ряда — «насколько эта ось вообще качается». */
const span = (rows: number[][], j: number): number => {
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { lo = Math.min(lo, r[j]!); hi = Math.max(hi, r[j]!); }
  return hi - lo;
};
const ARMS = (o: Record<string, number>): number[] => [o.shL!, o.shR!, o.elL!, o.elR!, o.shoLY!, o.shoRY!];

describe('свёртка трёх сгибов локтя в один', () => {
  it('угол локтя не изменился: то, что убрали из двух ручек, приехало в базу', () => {
    const gx = { elbowBend: 0.25, elbowBendRun: 0.4 };
    const before = { el: POSE.armEl, elRun: POSE.armElRun, walk: POSE.armElWalk, eb: gx.elbowBend, ebRun: gx.elbowBendRun };
    // Прежняя формула: база + ретаргет + добавка×амплитуда хода. Амплитуда в якорях панели — 0.85 / 1.01.
    const wasWalk = before.el + before.eb + before.walk * 0.85;
    const wasRun = before.elRun + before.ebRun + before.walk * 1.01;
    foldElbow(gx);
    expect(POSE.armEl).toBeCloseTo(wasWalk, 10);
    expect(POSE.armElRun).toBeCloseTo(wasRun, 10);
    expect(gx.elbowBend, 'слагаемое обнулено').toBe(0);
    expect(POSE.armElWalk, 'слагаемое обнулено').toBe(0);
  });

  it('ИДЕМПОТЕНТНА: зовётся при каждой пересборке куклы — второй раз обязана прибавить ноль', () => {
    const gx = { elbowBend: 0.25, elbowBendRun: 0.4 };
    foldElbow(gx);
    const once = { el: POSE.armEl, run: POSE.armElRun };
    for (let i = 0; i < 5; i++) foldElbow(gx);
    expect(POSE.armEl).toBe(once.el);
    expect(POSE.armElRun).toBe(once.run);
  });

  it('разведённые стороны складываются ПО СТОРОНАМ, а не по общему числу', () => {
    ASYM['elbowBend'] = [0.1, 0.5];
    ASYM['armElWalk'] = [0, 0.2];
    const gx = { elbowBend: 0.25 };
    foldElbow(gx);
    expect(ASYM['armEl']![0]).toBeCloseTo(POSE0.armEl + 0.1, 10);
    expect(ASYM['armEl']![1]).toBeCloseTo(POSE0.armEl + 0.5 + 0.2 * 0.85, 10);
    expect(ASYM['elbowBend'], 'источник убран, иначе сложится второй раз').toBeUndefined();
  });

  it('симметричный результат схлопывается в одно число, а не оставляет мёртвую пару', () => {
    ASYM['elbowBend'] = [0.3, 0.3];
    foldElbow({ elbowBend: 0 });
    expect(ASYM['armEl']).toBeUndefined();
    expect(POSE.armEl).toBeCloseTo(POSE0.armEl + 0.3 + POSE0.armElWalk * 0.85, 10);
  });
});

describe('страйф — третья колонка', () => {
  it('нет записи — ровно прежнее число, при любой боковитости', () => {
    for (const st of [0, 0.5, 1]) expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0.5, st))).toBe(sideLerp('stepWalk', 'stepRun', 35, 44, 0, 0.5));
  });

  it('есть запись — на чистом боку берётся она, а бег остаётся нетронутым', () => {
    STRAFE['stepWalk'] = 12;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 0)), 'боковитости нет → бег как настроен').toBe(44);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 1)), 'чистый бок → страйф-значение').toBe(12);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 0.5)), 'между — линейно').toBe(28);
  });

  it('стороны страйфа разводятся своим ключом и не трогают асимметрию бега', () => {
    ASYM['stepWalk'] = [30, 40];
    ASYM['stepWalk@s'] = [5, 9];
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1))).toBe(5);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 1, mix(0, 1))).toBe(9);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 0)), 'без боковитости — асимметрия ходьбы').toBe(30);
  });

  it('боковитость: ход вперёд и ход НАЗАД одинаково не страйф, чистый бок — страйф', () => {
    expect(strafeMix(1, 0)).toBe(0);
    expect(strafeMix(-1, 0), 'спиной вперёд — это не страйф, а шаг назад').toBe(0);
    expect(strafeMix(0, 1)).toBe(1);
    expect(strafeMix(0, -1), 'влево и вправо одинаково боком').toBe(1);
  });

  it('диагональ 45° страйфом НЕ считается — её закрывает доворот таза (Ф0)', () => {
    const d = Math.SQRT1_2;
    expect(strafeMix(d, d)).toBe(0);
    expect(strafeMix(Math.cos(1.15), Math.sin(1.15)), '66° — уже наполовину').toBeGreaterThan(0.2);
  });

  it('порог настраивается: сдвинули границы — диагональ стала страйфом', () => {
    GAIT.strafeFrom = 10; GAIT.strafeTo = 40;
    expect(strafeMix(Math.SQRT1_2, Math.SQRT1_2)).toBe(1);
  });

  it('ПОХОДКА ВБОК меняется от страйф-колонки, а походка ВПЕРЁД — нет', () => {
    const fwd0 = run(0, 115), side0 = run(115, 0);
    STRAFE['stanceWidth'] = 14;   // шире расставить ноги только в боковом ходе
    expect(maxDiff(run(0, 115), fwd0), 'бег вперёд не тронут').toBe(0);
    expect(maxDiff(run(115, 0), side0), 'ход вбок изменился').toBeGreaterThan(0.02);
  });
});

describe('фаза маха', () => {
  it('дефолт +1 — ровно прежние руки и плечи', () => {
    const a = run(0, 115, 240, ARMS);
    POSE.armPhase = 1; POSE.armPhaseRun = 1; POSE.shoPhase = 1; POSE.shoPhaseRun = 1;
    expect(maxDiff(run(0, 115, 240, ARMS), a)).toBe(0);
  });

  it('−1 переворачивает мах руки: та же амплитуда, противоположный знак', () => {
    const a = run(0, 115, 240, (o) => [o.shL! - POSE.armShRun, o.shR! - POSE.armShRun]);
    POSE.armPhase = -1; POSE.armPhaseRun = -1;
    const b = run(0, 115, 240, (o) => [o.shL! - POSE.armShRun, o.shR! - POSE.armShRun]);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < 2; j++) expect(b[i]![j]!).toBeCloseTo(-a[i]![j]!, 10);
  });

  it('0 гасит мах: руки стоят на базе', () => {
    POSE.armPhase = 0; POSE.armPhaseRun = 0;
    const r = run(0, 115, 240, (o) => [o.shL!, o.shR!]);
    expect(span(r, 0)).toBeLessThan(1e-9);
    expect(span(r, 1)).toBeLessThan(1e-9);
  });

  it('фаза РУКИ тащит за собой пояс — иначе плечо уедет от своей руки', () => {
    POSE.shoSwing = 0.5; POSE.shoSwingRun = 0.5;
    const a = run(0, 115, 240, (o) => [o.shoLY!]);
    POSE.armPhase = -1; POSE.armPhaseRun = -1;
    const b = run(0, 115, 240, (o) => [o.shoLY!]);
    for (let i = 0; i < a.length; i++) expect(b[i]![0]!).toBeCloseTo(-a[i]![0]!, 10);
  });

  it('фаза ПЛЕЧ разворачивает ТОЛЬКО пояс — рука остаётся где была', () => {
    POSE.shoSwing = 0.5; POSE.shoSwingRun = 0.5;
    const a = run(0, 115, 240, (o) => [o.shoLY!, o.shL!]);
    POSE.shoPhase = -1; POSE.shoPhaseRun = -1;
    const b = run(0, 115, 240, (o) => [o.shoLY!, o.shL!]);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]![0]!, 'пояс перевернулся').toBeCloseTo(-a[i]![0]!, 10);
      expect(b[i]![1]!, 'рука не тронута').toBe(a[i]![1]!);
    }
  });
});

describe('амплитуда локтя', () => {
  it('0 — прежнее поведение: локоть не качается, только база', () => {
    const r = run(0, 115, 240, (o) => [o.elL!, o.elR!]);
    expect(span(r, 0)).toBeLessThan(1e-9);
  });

  it('локоть гнётся В ТАКТ МАХУ: сильнее всего там, где рука ушла вперёд', () => {
    POSE.armElAmp = 0.6; POSE.armElAmpRun = 0.6;
    // Плечо «вперёд» — это МЕНЬШИЙ угол (замер: −0.5 уводит кисть на +11.2 по Z). Значит локоть должен
    // быть согнут максимально ровно в том кадре, где shL минимален — это и есть «в какой момент».
    const r = run(0, 115, 240, (o) => [o.shL!, o.elL!]).slice(60);
    let iMin = 0, iMax = 0;
    r.forEach((v, i) => { if (v[0]! < r[iMin]![0]!) iMin = i; if (v[0]! > r[iMax]![0]!) iMax = i; });
    expect(r[iMin]![1]!, 'рука впереди — локоть подобран').toBeGreaterThan(r[iMax]![1]!);
    expect(span(r, 1)).toBeGreaterThan(0.1);
  });

  it('стороны качаются в противофазу друг другу, как и сами руки', () => {
    POSE.armElAmp = 0.6; POSE.armElAmpRun = 0.6;
    const r = run(0, 115, 240, (o) => [o.elL! - POSE.armElRun, o.elR! - POSE.armElRun]).slice(60);
    for (const v of r) expect(v[0]!).toBeCloseTo(-v[1]!, 10);
  });
});

describe('амплитуда бедра', () => {
  it('1 — прежние ноги до последнего знака', () => {
    const a = run(0, 115);
    GAIT.hipSwing = 1; GAIT.hipSwingRun = 1;
    expect(maxDiff(run(0, 115), a)).toBe(0);
  });

  it('больше 1 — бедро маховой ноги уходит дальше, колено остаётся своим', () => {
    const a = run(0, 115);
    GAIT.hipSwing = 2; GAIT.hipSwingRun = 2;
    const b = run(0, 115);
    expect(span(b, 0), 'бедро качается сильнее').toBeGreaterThan(span(a, 0) * 1.05);
    expect(span(b, 2), 'колено не тронуто').toBeCloseTo(span(a, 2), 10);
  });

  it('на ОТРЫВЕ и ПРИЗЕМЛЕНИИ добавки нет — иначе нога дёргалась бы в момент контакта', () => {
    // Ключевое свойство: амплитуда масштабирует ТО, ЧТО ДАЁТ ПОДЪЁМ СТОПЫ, а не угол бедра целиком.
    // Подъём равен нулю в начале и в конце переноса, значит там добавка тоже ноль и нога входит в
    // контакт ровно туда, куда её поставил планировщик. Масштабируй угол целиком — на границе переноса
    // появился бы скачок, и стопа приземлялась бы не в плант.
    // Ловим ИМЕННО первый кадр переноса: стопа там ещё на полу, значит подъёма нет, значит и добавки
    // быть не должно НИ ПРИ КАКОЙ амплитуде. Если масштабировать угол бедра целиком, здесь появится
    // ступенька в разы — и стопа отрывается не оттуда, где стояла.
    const atLiftoff = (): number[] => {
      const d = new PoseDriver(); let z = 0; const out: number[] = []; let prev = false;
      for (let i = 0; i < 240; i++) {
        z += 115 * DT;
        d.setWorld(0, z, 0, 0, 115);
        const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
        const o = d.update(DT);
        const sw = d.swingLegs[0];
        if (sw && !prev && i > 60) out.push(o.hipL);
        prev = sw;
      }
      return out;
    };
    const a = atLiftoff();
    GAIT.hipSwing = 3; GAIT.hipSwingRun = 3;
    const b = atLiftoff();
    expect(a.length, 'отрывы нашлись').toBeGreaterThan(1);
    // Допуск 0.04 рад (2.3°) — это остаток от того, что первый кадр переноса уже чуть после нуля.
    // Масштабирование угла целиком даёт здесь 0.33 рад (19°), то есть разница видна с запасом ×18.
    for (let i = 0; i < a.length; i++) expect(Math.abs(b[i]! - a[i]!), 'на отрыве бедро то же').toBeLessThan(0.04);
  });

  it('ОПОРНАЯ нога не трогается вовсе: стопа на полу — добавка ровно ноль', () => {
    // Стоим: обе стопы на земле, значит любое значение амплитуды обязано дать один и тот же кадр.
    const still = (): number[][] => run(0, 0, 90);
    const a = still();
    GAIT.hipSwing = 3; GAIT.hipSwingRun = 3;
    expect(maxDiff(still(), a)).toBe(0);
  });
});

describe('боевая ось — четвёртая колонка (Ф6)', () => {
  it('нет записи — бой ничего не меняет, при любом боевом состоянии', () => {
    for (const ct of [0, 0.5, 1]) expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 0, 0, ct))).toBe(35);
  });

  it('есть запись — в бою берётся она, а вне боя всё как было', () => {
    COMBAT['stanceWidth'] = 18;
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 0, 0)), 'вне боя').toBe(6);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 0, 1)), 'в бою').toBe(18);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 0, 0.5)), 'на входе в бой — на полпути').toBe(12);
  });

  it('бой накладывается ПОВЕРХ страйфа, а не вместо него', () => {
    // Порядок цепочки: ходьба→бег, потом вперёд→вбок, потом мирно→бой. Каждая следующая колонка
    // перекрывает предыдущую там, где задана, — иначе «боевой страйф» пришлось бы заводить пятой.
    STRAFE['stepWalk'] = 20;
    COMBAT['stepWalk'] = 10;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 0, 0)), 'страйф вне боя').toBe(20);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 0, 1)), 'страйф в бою').toBe(10);
  });

  it('стороны боя разводятся своим ключом и не трогают ни бег, ни страйф', () => {
    ASYM['stanceWidth'] = [4, 8];
    ASYM['stanceWidth@c'] = [14, 20];
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 0, 1))).toBe(14);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 1, mix(0, 0, 0, 1))).toBe(20);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 0, 0)), 'вне боя — асимметрия ходьбы').toBe(4);
  });
});

describe('⭐⭐ «ДЛИНА ШАГА»: КОНТРАКТ ДЕРЖИТСЯ У БАЗЫ, А КОЛОНКА ДВИГАЕТ ТОЛЬКО ВЫНОС', () => {
  /**
   * ЖАЛОБА АВТОРА (19.09): «длина шага странно работает: вперёд-назад всё норм, а на страйфах что-то странное».
   *
   * ЭТО НЕ БАГ, А ДВЕ РАЗНЫЕ ВЕЩИ ПОД ОДНИМ ИМЕНЕМ, и сторож их разводит:
   *  • РИТМ (сколько тело проезжает за шаг) считается от БАЗОВОЙ пары `GAIT.stepWalk/stepRun`, без колонок;
   *  • ВЫНОС ноги (`sl(i)` в `plant`) — от колоночного значения.
   * Вперёд колонка И ЕСТЬ база, поэтому ручка двигает и то и другое, и контракт «шаг = скорость × период / 2»
   * виден глазами. В колонке «СТРАЙФ»/«НАЗАД» ручка меняет только вынос — а на чистом боку вынос уходит ВБОК
   * (`reach·mFwd` при `mFwd` = 0), то есть шире/уже разводит стопы. Отсюда «что-то странное».
   *
   * ⚠ ПОЧЕМУ РИТМ НЕ ОТДАЛИ КОЛОНКАМ (пробовали, замерено, откатили) — см. `StepPlanner.update`: доли
   * направления ездят вместе с доворотом таза, и на опубликованном воине (`back.stepWalk` 18.5 против базы 25)
   * рывок груди p99 шёл 2062 → 16437 °/с² при 60 Гц на стенде `torsoJitter`.
   */
  const stride = (col: Record<string, number> | null, knob: number | null, vx: number, vz: number): { spacing: number; reach: number } => {
    clear();
    if (knob !== null) {
      if (col) { col['stepWalk'] = knob; col['stepRun'] = knob; }
      else { GAIT.stepWalk = knob; GAIT.stepRun = knob; }
    }
    const d = new PoseDriver();
    let x = 0, z = 0, prev = false;
    const plants: [number, number][] = []; let rSum = 0, rN = 0;
    for (let i = 0; i < 900; i++) {
      x += vx * DT; z += vz * DT;
      d.setWorld(x, z, 0, vx, vz);
      const p0 = d.plantTarget(0), p1 = d.plantTarget(1);
      d.setFeet(p0[0], p0[1], p1[0], p1[1]);
      d.update(DT);
      const sw = d.swingLegs[0];
      if (sw && !prev && i > 300) { const t = d.plantTarget(0); plants.push([t[0], t[1]]); rSum += Math.hypot(t[0] - x, t[1] - z); rN++; }
      prev = sw;
    }
    let s = 0;
    for (let k = 1; k < plants.length; k++) s += Math.hypot(plants[k]![0] - plants[k - 1]![0], plants[k]![1] - plants[k - 1]![1]);
    return { spacing: s / Math.max(1, plants.length - 1), reach: rSum / Math.max(1, rN) };
  };

  it('ВПЕРЁД (базовая колонка): шаг тела за полцикла РАВЕН ручке — контракт виден', () => {
    for (const knob of [15, 25, 45]) {
      const r = stride(null, knob, 0, 40);
      expect(r.spacing / 2, `ручка ${knob} → шаг ${(r.spacing / 2).toFixed(2)}`).toBeCloseTo(knob, 0);
    }
  });

  it('⚠ СТРАЙФ (колонка): ритм НЕ меняется, меняется ВЫНОС — и это задокументировано, а не случайно', () => {
    GAIT.stepWalk = 25; GAIT.stepRun = 25;
    const base = stride(STRAFE, null, 40, 0);
    const small = stride(STRAFE, 15, 40, 0);
    const big = stride(STRAFE, 45, 40, 0);
    // ⚠ ДОПУСК 8 %, А НЕ НОЛЬ: при выносе сильно не по шагу включается СРОЧНОСТЬ (`urgency`) и поджимает цикл
    // на единицы процентов (замер: 50.0 → 47.4 при ручке 45 против базы 25). Это не ручка ритма, а страховка
    // от перетянутой опорной ноги; мутация «отдать ритм колонкам» даёт 30.0 и 90.0, то есть валит обе строки с запасом.
    expect(Math.abs(small.spacing / base.spacing - 1), `ритм от колонки НЕ зависит: ${small.spacing.toFixed(2)} против ${base.spacing.toFixed(2)}`).toBeLessThan(0.08);
    expect(Math.abs(big.spacing / base.spacing - 1), `и на большой ручке тоже: ${big.spacing.toFixed(2)} против ${base.spacing.toFixed(2)}`).toBeLessThan(0.08);
    // А вынос — зависит, и монотонно: ручка не «ничего не делает», она делает ДРУГОЕ.
    expect(small.reach, `вынос ${small.reach.toFixed(2)} против ${big.reach.toFixed(2)}`).toBeLessThan(big.reach - 1);
  });

  it('панель «Бег» говорит об этом автору прямо под ползунком', () => {
    // ⚠ Мутация «убрать пояснение» валит это: молчаливая ручка, которая на страйфе делает не то, что на
    // «вперёд», — ровно та беда, с которой автор пришёл.
    const SRC = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
    const i = SRC.indexOf('stepNote.textContent');
    expect(i, 'пояснение про длину шага написано').toBeGreaterThan(0);
    expect(SRC.slice(i, i + 900), '… и рассказывает именно про ритм против выноса').toMatch(/РИТМ[\s\S]{0,400}ВЫНОС/);
    expect(SRC.slice(i, i + 900), '⚠ и ДЕЙСТВИТЕЛЬНО показывается, а не лежит мёртвым текстом').toMatch(/box\.append\(stepNote\);/);
  });
});
