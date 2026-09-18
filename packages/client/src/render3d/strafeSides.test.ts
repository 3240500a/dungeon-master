import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GAIT, POSE, ASYM, STRAFE, STRAFE_R, STRAFE_L, BACK, COMBAT,
  sideLerp, locoVal, strafeMix, strafeSide, strafeSideOf, STRAFE_SIDE_BAND, PoseDriver, type LocoMix,
} from './pose.js';
import { applyGaitConfig } from './poseRuntime.js';

/**
 * ⭐⭐ СТРАЙФ НАСТРАИВАЕТСЯ ПО СТОРОНАМ — И ЗЕРКАЛА ЛЕВОГО СТРАЙФА БОЛЬШЕ НЕТ.
 *
 * Жалоба автора (19.09): «по страйфу настройка только в одну сторону происходит… у нас есть кнопка страйф
 * влево, свой съём, а настроить его нельзя». ЗАМЕР причины — две:
 *  1. ось страйфовости `st` считается по МОДУЛЮ боковой скорости (`strafeMix`), а сторона (`latPlusX`) в
 *     `pose.ts` не приезжала вовсе: одна колонка «СТРАЙФ» обслуживала обе стороны;
 *  2. съём левого страйфа подменялся ЗЕРКАЛОМ правого (`strafeMirror`), поэтому правка левого физически
 *     не могла никуда попасть — левый клип получался отражением правого, что в него ни пиши.
 *
 * Лечение: `st` делится на доли сторон `stR`/`stL` (сумма = `st`), поверх общей колонки ложатся две
 * разрежённые карты `STRAFE_R`/`STRAFE_L` (суффиксы `@sr`/`@sl`), а зеркало убрано целиком.
 *
 * ⚠ Существующий `ASYM` для этого НЕ ГОДИТСЯ: он про левую/правую НОГУ, а не про сторону ДВИЖЕНИЯ.
 */
const DT = 1 / 60;
const mix = (sb: number, st = 0, stR = 0, stL = 0, bt = 0, ct = 0): LocoMix => ({ sb, st, stR, stL, bt, ct });
const clearAll = (): void => {
  for (const m of [ASYM as unknown as Record<string, unknown>, STRAFE, STRAFE_R, STRAFE_L, BACK, COMBAT]) for (const k of Object.keys(m)) delete m[k];
};
const GAIT0 = { ...GAIT }, POSE0 = { ...POSE };
afterEach(() => { clearAll(); Object.assign(GAIT, GAIT0); Object.assign(POSE, POSE0); });

// ── ДОЛЯ СТОРОНЫ ──────────────────────────────────────────────────────────────────────────────────

describe('доля стороны страйфа — smoothstep по узкой полосе, а не знак', () => {
  beforeEach(clearAll);

  it('⭐ РОВНО НА ПЕРЕХОДЕ обе доли равны: сторона там ничего не решает', () => {
    expect(strafeSide(0)).toBeCloseTo(0.5, 12);
  });

  it('чистый бок — доля своей стороны ровно 1, чужой ровно 0', () => {
    expect(strafeSide(1)).toBe(1);
    expect(strafeSide(-1)).toBe(0);
  });

  it('⭐ ПОЛОСА ДЕЙСТВИТЕЛЬНО УЗКАЯ — настоящий страйф получает СВОЙ вес целиком, а не размазанный', () => {
    // Полоса в единицах направления: за её краем доля уже насыщена. sin(3.4°) ≈ 0.06 — то есть любое
    // движение, отклонённое от продольной оси больше чем на ~3.5°, целиком принадлежит своей стороне.
    expect(STRAFE_SIDE_BAND).toBeLessThan(0.1);
    expect(strafeSide(STRAFE_SIDE_BAND)).toBe(1);
    expect(strafeSide(-STRAFE_SIDE_BAND)).toBe(0);
    const degOfBand = Math.asin(STRAFE_SIDE_BAND) * 180 / Math.PI;
    expect(degOfBand, `полоса ${degOfBand.toFixed(2)}° — меньше самого узкого порога страйфа`).toBeLessThan(5);
  });

  it('⭐ СУММА ДОЛЕЙ = БОКОВИТОСТЬ по всему кругу направлений — сторона не может подмешать БОЛЬШЕ страйфа', () => {
    for (let a = 0; a < 360; a += 3) {
      const r = a * Math.PI / 180, f = Math.cos(r), l = Math.sin(r);
      const st = strafeMix(f, l), sr = strafeSide(l);
      expect(st * sr + st * (1 - sr), `угол ${a}°`).toBeCloseTo(st, 12);
    }
  });

  it('⚠ НЕПРЕРЫВНОСТЬ САМОЙ ДОЛИ: тонкая развёртка через ноль не даёт ступеньки (мутация «знак» валит это)', () => {
    let step = 0, prev = strafeSide(-0.5);
    for (let x = -0.5; x <= 0.5; x += 0.002) { const v = strafeSide(x); step = Math.max(step, Math.abs(v - prev)); prev = v; }
    // У знака (`mLat >= 0 ? 1 : 0`) шаг был бы ровно 1 — прыжок настроек за один кадр.
    expect(step, `макс. шаг доли ${step.toFixed(4)} на 0.002 направления`).toBeLessThan(0.05);
  });
});

// ── КОЛОНКИ СТОРОН ────────────────────────────────────────────────────────────────────────────────

describe('колонки сторон — разрежённые ДОБАВКИ поверх общей «СТРАЙФ»', () => {
  beforeEach(clearAll);

  it('⭐⭐ ПУСТЫЕ КАРТЫ СТОРОН = БИТ В БИТ ПРЕЖНЕЕ ЗНАЧЕНИЕ при любых долях сторон', () => {
    // ⚠ Мутация `v += ((c ?? 0) - v) * m.stR` (читать пустую карту как ноль) валит это.
    STRAFE['stepWalk'] = 12; STRAFE['stepRun'] = 24;
    for (const [sr, sl] of [[1, 0], [0, 1], [0.5, 0.5], [0.3, 0.7]] as const) {
      for (const sb of [0, 0.37, 1]) {
        const withSides = locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(sb, 1, sr, sl));
        const without = locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(sb, 1, 0, 0));
        expect(withSides, `sb=${sb} доли ${sr}/${sl}`).toBe(without);
      }
    }
  });

  it('⭐ ЗАДАННАЯ СТОРОНА МЕНЯЕТ ТОЛЬКО СВОЮ — вторая остаётся ровно как была', () => {
    STRAFE['stanceWidth'] = 10;
    STRAFE_L['stanceWidth'] = 22;
    const right = locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 1, 0));
    const left = locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 0, 1));
    expect(right, 'вправо — общая колонка').toBe(10);
    expect(left, 'влево — своя').toBe(22);
    STRAFE_R['stanceWidth'] = 4;
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 0, 1)), 'левая не задета правой').toBe(22);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 1, 0)), 'правая — своя').toBe(4);
  });

  it('⭐ ОБЩАЯ КОЛОНКА ПРОДОЛЖАЕТ РАБОТАТЬ НА ОБЕ СТОРОНЫ — миграции данных не нужно', () => {
    STRAFE['stepWalk'] = 12;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 1, 0)), 'вправо').toBe(12);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 0, 1)), 'влево').toBe(12);
  });

  it('у стороны СВОЯ пара ходьба/бег — как у любой колонки, без особых случаев', () => {
    STRAFE_L['stepWalk'] = 20; STRAFE_L['stepRun'] = 40;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 0, 1)), 'шагом влево').toBe(20);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 1, 0, 1)), 'бегом влево').toBe(40);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0.5, 1, 0, 1)), 'между').toBe(30);
    STRAFE_R['stepRun'] = 8;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 1, 0)), 'задан только бег — он же на ходьбе').toBe(8);
  });

  it('стороны разводятся Л/П ноги своими суффиксами `@sr`/`@sl`, не мешая ни друг другу, ни общей', () => {
    STRAFE['stepWalk'] = 12;
    ASYM['stepWalk@sl'] = [5, 9];
    ASYM['stepWalk@sr'] = [30, 31];
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 0, 1)), 'влево, левая нога').toBe(5);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 1, mix(0, 1, 0, 1)), 'влево, правая нога').toBe(9);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 1, 0)), 'вправо, левая нога').toBe(30);
    expect(strafeSideOf('stepWalk', false, 1), 'панель читает ту же пару').toBe(9);
    expect(strafeSideOf('stepWalk', true, 0)).toBe(30);
    expect(strafeSideOf('stepWalk', true, 1)).toBe(31);
  });

  it('ПОРЯДОК: сторона ложится ПОВЕРХ общей, но ПОД «назад» и бой', () => {
    STRAFE['stanceWidth'] = 10; STRAFE_R['stanceWidth'] = 14; BACK['stanceWidth'] = 20; COMBAT['stanceWidth'] = 18;
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 1, 0)), 'страйф вправо').toBe(14);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 1, 0, 1)), 'назад перекрывает сторону').toBe(20);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 1, 0, 0, 1)), 'бой перекрывает всё').toBe(18);
  });

  it('доля стороны ЧАСТИЧНАЯ — добавка подмешивается ею, а не включается ступенькой', () => {
    STRAFE_R['stanceWidth'] = 10;
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 1, 0.5, 0.5))).toBeCloseTo(8, 9);
  });

  it('база без колонок не сдвинулась ни на знак (сторона без страйфа ничего не делает)', () => {
    STRAFE_R['stepWalk'] = 99; STRAFE_L['stepWalk'] = 1;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0.5)))
      .toBe(sideLerp('stepWalk', 'stepRun', 35, 44, 0, 0.5));
  });
});

// ── ЖИВАЯ ПОХОДКА ─────────────────────────────────────────────────────────────────────────────────

/** Прогон планировщика с постоянным вектором скорости; возвращает след углов ног по кадрам. */
function runDir(vx: number, vz: number, frames = 300): number[][] {
  const d = new PoseDriver(); let x = 0, z = 0; const out: number[][] = [];
  for (let i = 0; i < frames; i++) {
    x += vx * DT; z += vz * DT;
    d.setWorld(x, z, 0, vx, vz);
    const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
    const o = d.update(DT) as unknown as Record<string, number>;
    out.push([o.hipL!, o.hipR!, o.knL!, o.knR!, o.hipLatL!, o.hipLatR!, o.bobY!]);
  }
  return out;
}
const maxDiff = (a: number[][], b: number[][]): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[i]!.length; j++) m = Math.max(m, Math.abs(a[i]![j]! - b[i]![j]!));
  return m;
};
/** Максимальный ШАГ следа ЗА КАДР — та самая «ступенька настроек», которая читается как рывок. */
const maxStep = (a: number[][]): number => {
  let m = 0;
  for (let i = 1; i < a.length; i++) for (let j = 0; j < a[i]!.length; j++) m = Math.max(m, Math.abs(a[i]![j]! - a[i - 1]![j]!));
  return m;
};

describe('живая походка: ручка стороны меняет ТОЛЬКО свою сторону', () => {
  beforeEach(clearAll);
  const SPD = 80;

  it('⭐⭐ РУЧКА ЛЕВОГО СТРАЙФА НЕ ТРОГАЕТ ПРАВЫЙ (и наоборот) — это и есть жалоба автора', () => {
    const r0 = runDir(SPD, 0), l0 = runDir(-SPD, 0);
    STRAFE_L['stepWalk'] = 12; STRAFE_L['stepRun'] = 12; STRAFE_L['stanceWidth'] = 16; STRAFE_L['stanceWidthRun'] = 16;
    const r1 = runDir(SPD, 0), l1 = runDir(-SPD, 0);
    expect(maxDiff(r0, r1), 'правый страйф не шелохнулся').toBe(0);
    expect(maxDiff(l0, l1), 'левый — изменился').toBeGreaterThan(0.05);
    clearAll();
    STRAFE_R['stepWalk'] = 12; STRAFE_R['stepRun'] = 12; STRAFE_R['stanceWidth'] = 16; STRAFE_R['stanceWidthRun'] = 16;
    const r2 = runDir(SPD, 0), l2 = runDir(-SPD, 0);
    expect(maxDiff(l0, l2), 'левый страйф не шелохнулся').toBe(0);
    expect(maxDiff(r0, r2), 'правый — изменился').toBeGreaterThan(0.05);
  });

  it('⭐⭐ КАРТЫ СТОРОН НЕ ПРОТЕКАЮТ В ХОД ВПЕРЁД И СПИНОЙ — там боковитости нет, значит и долей нет', () => {
    // ⚠ Мутация «применять сторону мимо `st`» (например, доля от одной только `strafeSide`) валит это:
    // настройка страйфа полезла бы в обычный бег, которого автор в этой колонке не трогал.
    const f0 = runDir(0, SPD, 200), b0 = runDir(0, -SPD, 200), w0 = runDir(0, 35, 200);
    for (const k of ['stepWalk', 'stepRun', 'stanceWidth', 'stanceWidthRun', 'liftRun']) { STRAFE_R[k] = 40; STRAFE_L[k] = 1; }
    expect(maxDiff(f0, runDir(0, SPD, 200)), 'бег вперёд').toBe(0);
    expect(maxDiff(b0, runDir(0, -SPD, 200)), 'бег спиной').toBe(0);
    expect(maxDiff(w0, runDir(0, 35, 200)), 'ходьба вперёд').toBe(0);
  });

  it('⭐ СТОРОНЫ, ЗАДАННЫЕ ТЕМ ЖЕ ЧИСЛОМ, ЧТО И ОБЩАЯ, — походка БИТ В БИТ (доли делят ровно боковитость)', () => {
    // Прямое следствие `stR + stL = st`: накрыть уже применённое значение им же нельзя отличить от «не накрывать».
    // Заодно это гоняет ОБА новых пути `locoVal` с НЕПУСТЫМИ картами — то есть проверяет не только ранний выход.
    const col = { stepWalk: 20, stepRun: 26, stanceWidth: 14, stanceWidthRun: 14 };
    for (const [k, v] of Object.entries(col)) STRAFE[k] = v;
    for (const [vx, vz] of [[SPD, 0], [-SPD, 0], [40, 0], [-40, 0], [SPD, SPD], [-SPD, SPD]] as const) {
      const a = runDir(vx, vz, 200);
      for (const [k, v] of Object.entries(col)) { STRAFE_R[k] = v; STRAFE_L[k] = v; }
      expect(maxDiff(a, runDir(vx, vz, 200)), `${vx},${vz}`).toBe(0);
      for (const k of Object.keys(col)) { delete STRAFE_R[k]; delete STRAFE_L[k]; }
    }
  });
});

describe('⚠ НЕПРЕРЫВНОСТЬ НА ПЕРЕХОДЕ СТОРОНЫ (у процедурного пути кроссфейда нет)', () => {
  beforeEach(clearAll);

  const N = 480, MID = Math.round((N - 1) / 2);
  type Priv = { planner: { st: number; stR: number; stL: number } | null };
  /**
   * Развёртка направления хода: чистый правый страйф → продольная ось → чистый левый.
   * Возвращает И след позы, И ФАКТИЧЕСКОЕ ЗНАЧЕНИЕ РУЧКИ на каждом кадре — то есть ровно то число,
   * которым планировщик в этом кадре пользовался.
   */
  function sweep(): { pose: number[][]; knob: number[] } {
    const d = new PoseDriver(); let x = 0, z = 0;
    const pose: number[][] = [], knob: number[] = [];
    for (let i = 0; i < N; i++) {
      const th = (Math.PI / 2) - (Math.PI * i / (N - 1));   // +90° → −90°, через 0 (ход вперёд)
      const vx = Math.sin(th) * 80, vz = Math.cos(th) * 80;
      x += vx * DT; z += vz * DT;
      d.setWorld(x, z, 0, vx, vz);
      const p0 = d.plantTarget(0), p1 = d.plantTarget(1); d.setFeet(p0[0], p0[1], p1[0], p1[1]);
      const o = d.update(DT) as unknown as Record<string, number>;
      pose.push([o.hipL!, o.hipR!, o.knL!, o.knR!, o.hipLatL!, o.hipLatR!, o.bobY!]);
      const pl = (d as unknown as Priv).planner!;
      knob.push(locoVal('stanceWidth', 'stanceWidthRun', GAIT.stanceWidth, GAIT.stanceWidthRun, 0,
        { sb: o.sb!, st: pl.st, stR: pl.stR, stL: pl.stL, bt: o.bt!, ct: 0 }));
    }
    return { pose, knob };
  }
  const setSides = (): void => {
    STRAFE_R['stanceWidth'] = 2; STRAFE_R['stanceWidthRun'] = 2; STRAFE_R['stepRun'] = 20;
    STRAFE_L['stanceWidth'] = 24; STRAFE_L['stanceWidthRun'] = 24; STRAFE_L['stepRun'] = 70;
  };
  const span = (a: number[]): number => Math.max(...a) - Math.min(...a);
  const step1 = (a: number[]): number => Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i]!)));

  /**
   * ⭐⭐ МЕРИМ САМУ НАСТРОЙКУ, А НЕ ПОЗУ. Ступенька, которой боится план, — это ступенька ЧИСЛА, которым
   * пользуется планировщик. Поза для этого плохой измеритель: разные стороны настроены на разную длину шага,
   * и следы «с настройками» и «без» просто расходятся по фазе — их разность шумит на всю амплитуду маха и
   * ступеньку в 22 единицы ширины стойки в себе не видно.
   */
  it('⭐⭐ ЗНАЧЕНИЕ РУЧКИ ПЕРЕТЕКАЕТ ПЛАВНО через переход стороны, а не прыгает', () => {
    setSides();
    const { knob } = sweep();
    const sp = span(knob), st = step1(knob);
    expect(sp, 'стороны настроены по-разному — иначе мерить нечего').toBeGreaterThan(10);
    // ⚠ Мутация `strafeSide = (l) => (l >= 0 ? 1 : 0)` валит это: весь размах набегает ЗА ОДИН КАДР.
    expect(st / sp, `ЗАМЕР: шаг ручки ${st.toFixed(4)} при размахе ${sp.toFixed(2)} → ${(st / sp * 100).toFixed(1)} %`).toBeLessThan(0.2);
  });

  it('⭐⭐ ВЫРОЖДЕННЫЕ ПОРОГИ (`strafeFrom` = `strafeTo` = 0 → боковитость 1 ВЕЗДЕ) — и там без ступеньки', () => {
    // ⚠ ЭТО И ЕСТЬ СЛУЧАЙ, РАДИ КОТОРОГО ПОЛОСА. При обычных порогах переход стороны стоит ровно там, где
    // боковитость 0, и жёсткий знак прошёл бы незамеченным: умножать на ноль можно любую ерунду. Выкрутив
    // пороги в ноль (ползунки это позволяют), автор получает страйф-колонку ВЕЗДЕ — и знак дал бы прыжок
    // настроек с одной стороны на другую за один кадр.
    // ⚠ ЗАМЕР мутации «знак» на этом же прогоне: шаг ручки 22.00 из 22.00 = 100 %.
    GAIT.strafeFrom = 0; GAIT.strafeTo = 0;
    setSides();
    const { knob } = sweep();
    const sp = span(knob), st = step1(knob);
    expect(sp).toBeGreaterThan(10);
    expect(st / sp, `ЗАМЕР: шаг ручки ${st.toFixed(4)} при размахе ${sp.toFixed(2)} → ${(st / sp * 100).toFixed(1)} %`).toBeLessThan(0.2);
  });

  it('⭐ ПОЗА У САМОГО ПЕРЕХОДА НЕ ДЁРГАЕТСЯ: шаг за кадр не больше, чем у прямого бега', () => {
    // Окно ±60 кадров вокруг перехода. Дальше от него стороны настроены на РАЗНЫЙ шаг (20 против 70), и
    // походка там честно живее — мерить туда бессмысленно, ступенька ищется на переходе.
    const base = maxStep(runDir(0, 80, N));
    setSides();
    const { pose } = sweep();
    const near = pose.slice(MID - 60, MID + 60);
    const s = maxStep(near);
    expect(s, `ЗАМЕР: у перехода ${s.toFixed(4)}, прямой бег ${base.toFixed(4)}`).toBeLessThanOrEqual(base);
  });
});

// ── pe_gait ───────────────────────────────────────────────────────────────────────────────────────

describe('pe_gait: новые разделы едут в игру', () => {
  beforeEach(() => {
    clearAll();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => JSON.stringify({
        warrior: { strafe: { stepWalk: 12 }, strafeR: { stanceWidth: 4 }, strafeL: { stanceWidth: 22 }, back: { leanWalk: 0 } },
        clean: { strafe: { stepWalk: 12 } },
      }),
      setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('⭐ ИГРА ГРУЗИТ ОБЕ СТОРОНЫ — иначе настройка жила бы только в редакторе (уже было с боевой колонкой)', () => {
    // ⚠ Мутация «убрать `STRAFE_L` из списка карт в `applyGaitConfig`» валит это.
    applyGaitConfig('warrior', { armDown: 1.35, elbowBend: 0.25 });
    expect(STRAFE['stepWalk'], 'общая').toBe(12);
    expect(STRAFE_R['stanceWidth'], 'вправо').toBe(4);
    expect(STRAFE_L['stanceWidth'], 'влево').toBe(22);
  });

  it('⚠ КОНФИГ БЕЗ НОВЫХ РАЗДЕЛОВ — карты ПУСТЫ, а не унаследованы от прошлого персонажа', () => {
    applyGaitConfig('warrior', { armDown: 1.35, elbowBend: 0.25 });
    applyGaitConfig('clean', { armDown: 1.35, elbowBend: 0.25 });
    expect(Object.keys(STRAFE_R).length, 'вправо').toBe(0);
    expect(Object.keys(STRAFE_L).length, 'влево').toBe(0);
    expect(STRAFE['stepWalk'], 'общая — своя').toBe(12);
  });
});

// ── ИСХОДНИКИ: ЗЕРКАЛА НЕТ, РЕДАКТОР ПИШЕТ В СВОЮ КАРТУ ───────────────────────────────────────────

const SRC_ED = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
const SRC_BAKE = readFileSync(path.join(__dirname, 'clipBake.ts'), 'utf8');
const SRC_POSE = readFileSync(path.join(__dirname, 'pose.ts'), 'utf8');

describe('⭐⭐ ЗЕРКАЛА ЛЕВОГО СТРАЙФА БОЛЬШЕ НЕТ', () => {
  it('ни ручки, ни функций, ни обвязки — ни в одном из трёх файлов', () => {
    // ⚠ Мутация «вернуть `GAIT.strafeMirror`» валит это. Зеркало и делало левую сторону ненастраиваемой:
    // что ни пиши в настройки, левый клип получался отражением правого.
    // Ищем ВЫЗОВ/ОБЪЯВЛЕНИЕ (со скобкой), а не упоминание: в комментариях снесённые имена остаются нарочно —
    // это единственный след того, почему левый страйф когда-то был ненастраиваемым.
    for (const [name, src] of [['pose.ts', SRC_POSE], ['clipBake.ts', SRC_BAKE], ['pose-editor.ts', SRC_ED]] as const) {
      for (const bad of ['mirrorStrafeL(', 'withMirroredStrafeL(', 'mirrorIfAsked(', 'specsForBake(', 'gaitIsAsymmetric(']) {
        expect(src.includes(bad), `${name}: ${bad}`).toBe(false);
      }
      expect(src, `${name}: импорта снесённого зеркала нет`).not.toMatch(/import \{[^}]*(mirrorStrafeL|withMirroredStrafeL|gaitIsAsymmetric)/);
    }
    // `strafeMirror` остаётся только в поясняющих комментариях — но не как ключ и не как чтение.
    expect(SRC_POSE, 'ключа в GAIT нет').not.toMatch(/strafeMirror:/);
    expect(SRC_ED, 'чтения ручки нет').not.toMatch(/GAIT\.strafeMirror/);
    expect(SRC_ED, "в GAIT_KEYS ключа нет").not.toMatch(/'strafeMirror'/);
  });

  it('⭐ ЛЕВЫЙ СТРАЙФ СНИМАЕТСЯ СВОИМ ПРОХОДОМ — фильтра спеков больше нет', () => {
    const i = SRC_ED.indexOf('const out = withRootViewOff(() => {');
    expect(i).toBeGreaterThan(0);
    const body = SRC_ED.slice(i, SRC_ED.indexOf('});', i) + 3);
    expect(body, 'весь набор идёт в съём как есть').toMatch(/bakeGaitSet\(player, human, opts, GAIT_PRESETS\.filter/);
    expect(body).not.toMatch(/specsForBake/);
    // ⚠ И отдельного набора «таз открыт» больше нет вовсе (снят 19.09) — поворот таза печётся в эти же клипы.
    expect(SRC_ED, 'второго съёма нет').not.toMatch(/openStrafePresets/);
  });

  it('⚠ КНОПКА «⇆ В ЗЕРКАЛЬНУЮ» ЯЧЕЙКУ ОСТАЛАСЬ (удобная авторская операция), а предупреждение — нет', () => {
    expect(SRC_ED, 'копирование ячейки').toMatch(/rtMirrorPlantCell\(selCell\(\)\)/);
    expect(SRC_ED, 'предупреждения «не зеркально» больше нет').not.toMatch(/не зеркально:/);
    expect(SRC_ED, 'и его источник не читается').not.toMatch(/rtPlantMirrorGaps/);
  });
});

describe('⭐ РЕДАКТОР: выбранная сторона ведёт И КАРТУ, И ПРЕВЬЮ', () => {
  it('«обе» → общая колонка, «Л»/«П» → своя карта и свой суффикс', () => {
    // ⚠ Мутация «`colMapOf` не смотрит на `gaitStrSide`» валит это: ползунки стороны писали бы в общую колонку.
    // ⚠⚠ 20.09 ЯРЛЫК ЗЕРКАЛЕН ХРАНИЛИЩУ НАРОЧНО: «Л» — это СВОЯ ЛЕВАЯ сторона персонажа, то есть локальный
    // +X, а он исторически лежит в `STRAFE_R`/`@sr`. Имена карт — данные автора, их не переименовывали;
    // полная цепь и замеры — `strafeTruth.test.ts` и «ТАБЛИЦА ИСТИНЫ «СТОРОНА»» в `pose.ts`.
    expect(SRC_ED).toMatch(/: gaitStrSide === 'L' \? gaitStrafeOwnL : gaitStrSide === 'R' \? gaitStrafeOwnR : gaitStrafe\)/);
    expect(SRC_ED).toMatch(/: gaitStrSide === 'L' \? '@sr' : gaitStrSide === 'R' \? '@sl' : '@s'\)/);
    expect(SRC_ED, 'карты — те же объекты, что читает игра').toMatch(/const gaitStrafeOwnL = STRAFE_R;/);
    expect(SRC_ED).toMatch(/const gaitStrafeOwnR = STRAFE_L;/);
  });

  it('⭐⭐ У КАЖДОЙ СТОРОНЫ СВОЙ ЗНАК СКОРОСТИ И СВОЯ ЯЧЕЙКА ПЛАНТА (а не жёсткая 2 на обе)', () => {
    // ⚠ Мутация «`locoVx = v; plantDirSel = 2`» валит это: правишь одну сторону, а перед тобой едет другая —
    // ровно то, на что жаловался автор. ⚠⚠ 20.09 стороны названы ПО АНАТОМИИ: «Л» = +X = ячейка 2.
    const i = SRC_ED.indexOf('const applyView = (): void => {');
    expect(i).toBeGreaterThan(0);
    const body = SRC_ED.slice(i, SRC_ED.indexOf('\n  };', i));
    expect(body).toMatch(/const ownRight = gaitStrSide === 'R';/);
    expect(body).toMatch(/locoVx = ownRight \? -v : v; locoVz = 0; plantDirSel = ownRight \? 6 : 2;/);
    expect(SRC_ED, 'переключатель стороны зовёт тот же `applyView`').toMatch(/const setStrSide = \(s: 'both' \| 'L' \| 'R'\): void => \{ gaitStrSide = s; applyView\(\); \};/);
  });

  it('сброс колонок и чип «Л≠П» знают новые суффиксы', () => {
    expect(SRC_ED, 'суффиксы сторон в общем списке колонок').toMatch(/const COL_SFX = \['@s', '@sr', '@sl', '@b', '@c'\] as const;/);
    // ⚠ 20.09 пять поколоночных кнопок «сброс страйфа / Л / П / назад / бой» свёрнуты в ОДНУ по выбору
    // (`resetScope`, режим + скорость; сторож — `gaitResetScope.test.ts`). Колонку и суффикс она берёт из
    // тех же `colMapOf`/`colSfxOf`, что и ползунки, поэтому область сброса не может разойтись с правкой.
    expect(SRC_ED, 'сброс идёт по выбранной колонке').toMatch(/column: onCol \? colMapOf\(gaitDir\) : null,/);
    expect(SRC_ED, 'и по её суффиксу').toMatch(/sfx: onCol \? colSfxOf\(gaitDir\) : '',/);
    // `@sr`/`@sl` не оканчиваются на `@s` — «сброс страйфа» не уносит стороны молча.
    expect('stepRun@sr'.endsWith('@s')).toBe(false);
    expect('stepRun@sl'.endsWith('@s')).toBe(false);
  });

  it('⚠ НОВЫЕ РАЗДЕЛЫ ПИШУТСЯ И ЧИТАЮТСЯ В `pe_gait` — иначе настройка пропадала бы на перезагрузке', () => {
    expect(SRC_ED, 'запись').toMatch(/asym, strafe, strafeR, strafeL, back, combat \};/);
    expect(SRC_ED, 'чтение').toMatch(/Object\.entries\(c\?\.strafeR \?\? \{\}\)/);
    expect(SRC_ED).toMatch(/Object\.entries\(c\?\.strafeL \?\? \{\}\)/);
  });
});

describe('⭐⭐ ОБЕ СТОРОНЫ СРАЗУ: на переходе ручка не проседает', () => {
  beforeEach(clearAll);

  it('обе стороны по 30° дают 30° при ЛЮБОМ делении долей', () => {
    // ⚠ БЫЛО ДВА ШАГА ПОДРЯД (правая, потом левая), и второй тянул уже к результату первого: на самом переходе
    // (`stR = stL = 0.5`) «обе по 30°» давали 22.5°, то есть ручка проваливалась ровно там, где обе стороны
    // просят ОДНО И ТО ЖЕ. Мутация «вернуть два последовательных шага» валит эту строку.
    STRAFE_R['hipsTurn'] = 30; STRAFE_R['hipsTurnRun'] = 30;
    STRAFE_L['hipsTurn'] = 30; STRAFE_L['hipsTurnRun'] = 30;
    for (const sr of [1, 0.75, 0.5, 0.25, 0]) {
      const v = locoVal('hipsTurn', 'hipsTurnRun', 0, 0, 0, mix(1, 1, sr, 1 - sr));
      expect(v, `stR ${sr}: ${v.toFixed(4)}`).toBeCloseTo(30, 10);
    }
  });

  it('⭐ ПОРЯДОК КАРТ НИЧЕГО НЕ РЕШАЕТ: ±20° на переходе дают ровно середину, а не «последнюю»', () => {
    STRAFE_R['hipsTurn'] = 20; STRAFE_R['hipsTurnRun'] = 20;
    STRAFE_L['hipsTurn'] = -20; STRAFE_L['hipsTurnRun'] = -20;
    expect(locoVal('hipsTurn', 'hipsTurnRun', 0, 0, 0, mix(1, 1, 0.5, 0.5)), 'ровно на оси таз прямой').toBeCloseTo(0, 10);
    // И симметрия: доли, зеркальные относительно середины, дают зеркальные углы.
    const a = locoVal('hipsTurn', 'hipsTurnRun', 0, 0, 0, mix(1, 1, 0.75, 0.25));
    const b = locoVal('hipsTurn', 'hipsTurnRun', 0, 0, 0, mix(1, 1, 0.25, 0.75));
    expect(a, 'симметрия сторон').toBeCloseTo(-b, 10);
  });

  it('одна сторона задана — считается РОВНО как раньше (пустая вторая карта ничего не добавляет)', () => {
    STRAFE_R['stepWalk'] = 40;
    for (const sr of [1, 0.5, 0.25]) {
      const v = locoVal('stepWalk', 'stepRun', 20, 20, 0, mix(0, 1, sr, 1 - sr));
      expect(v, `stR ${sr}`).toBeCloseTo(20 + (40 - 20) * sr, 10);
    }
  });
});

describe('⭐⭐ ЯЧЕЙКУ ПЛАНТ-СЕТКИ РЕДАКТОР ИЩЕТ В КАДРЕ ПЛАНИРОВЩИКА', () => {
  it('подсветка идёт по `pelvisYaw`, а не по мировому рыску таза', () => {
    // ЖАЛОБА-ПРИЧИНА (19.09): кнопка «Л/П» ставит ячейку 6/2, а через кадр автослежение переставляло её по
    // `pelvisYawWorld` — и при повороте таза больше 22.5° подсветка перепрыгивала на диагональ (1/7). Автор правил
    // НЕ ТУ ячейку, что названа на кнопке. Сетку ищет ПЛАНИРОВЩИК и ровно в своём кадре (корень + доворот);
    // рыск, сидящий в кости (поворот таза, качание, рыск клипа), до него не доезжает вовсе.
    const SRC = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
    const i = SRC.indexOf('активная ячейка плант-сетки следит за падом');
    expect(i, 'блок автослежения ячейки на месте').toBeGreaterThan(0);
    const blk = SRC.slice(i, i + 1200);
    expect(blk, '⚠ ячейка обязана считаться от курса ПЛАНИРОВЩИКА').toMatch(/const gy = player\.pelvisYaw;/);
    expect(blk, '⚠ и именно от него, а не от зеркала мирового рыска').toMatch(/fwdC = vx \* Math\.sin\(gy\)/);
  });
});
