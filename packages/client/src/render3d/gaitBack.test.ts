import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GAIT, POSE, ASYM, STRAFE, BACK, COMBAT, sideLerp, locoVal, strafeMix, backMix, PoseDriver, type LocoMix } from './pose.js';
import { applyGaitConfig } from './poseRuntime.js';

/**
 * ХОД СПИНОЙ — СВОЯ КОЛОНКА, И У КАЖДОЙ КОЛОНКИ СВОЯ ПАРА ХОДЬБА/БЕГ.
 *
 * Жалоба, из которой это выросло: наклон корпуса, настроенный для бега ВПЕРЁД, при беге НАЗАД
 * складывается с посадкой физ-тела, и персонаж горбится. Одним числом два движения не описать —
 * ровно та же причина, по которой в своё время отделили страйф.
 *
 * Отсюда «шесть конфигов локомоции»: вперёд / назад / страйф, каждый со своей ходьбой и своим бегом.
 * Раньше у колонки было ОДНО число на обе скорости, и настроить бег назад отдельно от шага назад
 * было негде.
 */
const DT = 1 / 60;
const mix = (sb: number, st = 0, bt = 0, ct = 0, stR = 0, stL = 0): LocoMix => ({ sb, st, stR, stL, bt, ct });
const clearAll = (): void => {
  for (const m of [ASYM as unknown as Record<string, unknown>, STRAFE, BACK, COMBAT]) for (const k of Object.keys(m)) delete m[k];
};

describe('назадность считается через боковитость, а не своим порогом', () => {
  beforeEach(clearAll);

  it('ход вперёд — ровно ноль, что бы ни творилось вбок', () => {
    for (const lat of [0, 10, 50, 200]) expect(backMix(100, lat)).toBe(0);
  });

  it('чистый ход спиной — единица', () => {
    expect(backMix(-100, 0)).toBeCloseTo(1, 6);
  });

  it('чистый бок — ноль: там распоряжается страйф-колонка', () => {
    // Ровно на боку продольной составляющей нет, и «назад» не за что зацепиться.
    expect(backMix(-1e-9, 100)).toBeLessThan(0.01);
  });

  it('⭐ сумма колонок НИКОГДА не превышает единицу — они не могут наложиться', () => {
    // Две независимые шкалы рано или поздно перекрыли бы друг друга, и ключ получил бы
    // полторы поправки. Здесь это исключено по построению, и проверяется по всей окружности.
    for (let a = 0; a < 360; a += 3) {
      const r = a * Math.PI / 180;
      const f = Math.cos(r) * 100, l = Math.sin(r) * 100;
      expect(strafeMix(f, l) + backMix(f, l), `угол ${a}°`).toBeLessThanOrEqual(1.0001);
    }
  });

  it('⭐ переход вперёд↔назад НЕПРЕРЫВЕН — ступенька читалась бы как рывок корпуса', () => {
    // Проходим границу бока с обеих сторон вплотную: скачка быть не должно ни при каких порогах.
    for (const to of [60, 80, 95, 120]) {
      GAIT.strafeTo = to;
      const before = backMix(1e-6, 100), after = backMix(-1e-6, 100);
      expect(Math.abs(after - before), `strafeTo=${to}`).toBeLessThan(0.01);
    }
    GAIT.strafeTo = 80;
  });
});

describe('колонка «назад» — разрежённая, как и остальные', () => {
  beforeEach(clearAll);

  it('карта пуста → значение бит в бит прежнее при любой назадности', () => {
    for (const bt of [0, 0.3, 1]) {
      expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0.5, 0, bt)))
        .toBe(sideLerp('stepWalk', 'stepRun', 35, 44, 0, 0.5));
    }
  });

  it('задана — подмешивается по назадности', () => {
    BACK['leanWalk'] = 0;
    expect(locoVal('leanWalk', 'leanWalkRun', 0.05, 0.05, 0, mix(0, 0, 0)), 'вперёд').toBeCloseTo(0.05, 6);
    expect(locoVal('leanWalk', 'leanWalkRun', 0.05, 0.05, 0, mix(0, 0, 1)), 'спиной').toBeCloseTo(0, 6);
    expect(locoVal('leanWalk', 'leanWalkRun', 0.05, 0.05, 0, mix(0, 0, 0.5)), 'на полпути').toBeCloseTo(0.025, 6);
  });

  it('стороны разводятся своим суффиксом `@b`, не мешая страйфу', () => {
    STRAFE['stepWalk'] = 12;
    ASYM['stepWalk@b'] = [5, 9];
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 0, 1)), 'левая назад').toBe(5);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 1, mix(0, 0, 1)), 'правая назад').toBe(9);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1, 0)), 'страйф не задет').toBe(12);
  });
});

describe('⭐ у колонки СВОЯ пара ходьба/бег — это и есть шесть конфигов', () => {
  beforeEach(clearAll);

  it('задана только ходьба — она работает на обеих скоростях (прежнее поведение)', () => {
    BACK['stepWalk'] = 20;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 0, 1)), 'шагом назад').toBe(20);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 0, 1)), 'бегом назад').toBe(20);
  });

  it('заданы обе — внутри колонки интерполируются той же скоростью', () => {
    BACK['stepWalk'] = 20; BACK['stepRun'] = 40;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 0, 1)), 'шагом назад').toBe(20);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 0, 1)), 'бегом назад').toBe(40);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0.5, 0, 1)), 'между').toBe(30);
  });

  it('задан только БЕГ — он же работает и на ходьбе (пара неполная, но не пустая)', () => {
    BACK['stepRun'] = 40;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 0, 1))).toBe(40);
  });

  it('то же верно для страйфа — колонки устроены одинаково, без особых случаев', () => {
    STRAFE['stepWalk'] = 12; STRAFE['stepRun'] = 24;
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(0, 1)), 'страйф шагом').toBe(12);
    expect(locoVal('stepWalk', 'stepRun', 35, 44, 0, mix(1, 1)), 'страйф бегом').toBe(24);
  });
});

describe('порядок колонок: бой перекрывает направление', () => {
  beforeEach(clearAll);

  it('бой ложится ПОВЕРХ хода спиной', () => {
    BACK['stanceWidth'] = 10; COMBAT['stanceWidth'] = 18;
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 1, 0)), 'спиной вне боя').toBe(10);
    expect(locoVal('stanceWidth', 'stanceWidthRun', 6, 6, 0, mix(0, 0, 1, 1)), 'спиной в бою').toBe(18);
  });
});

describe('⚠ потери, найденные при этой правке', () => {
  beforeEach(() => {
    clearAll();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => JSON.stringify({
        warrior: { strafe: { stepWalk: 12 }, back: { leanWalk: 0 }, combat: { stanceWidth: 18 } },
      }),
      setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('ИГРА грузит ВСЕ колонки, а не только страйф', () => {
    // Боевая колонка (Ф6) здесь отсутствовала: редактор её писал, игра не читала — то есть настройка
    // боя жила только в редакторе. Правило: карта есть в редакторе → она грузится здесь.
    applyGaitConfig('warrior', { armDown: 1.35, elbowBend: 0.25 });
    expect(STRAFE['stepWalk'], 'страйф').toBe(12);
    expect(BACK['leanWalk'], 'назад').toBe(0);
    expect(COMBAT['stanceWidth'], 'бой').toBe(18);
  });
});

describe('⚠ ручки ТЕЛА видят колонки направления и боя', () => {
  beforeEach(clearAll);

  /** Живой прогон: бежим по прямой указанное число кадров и снимаем наклон корпуса. */
  const runLean = (vz: number, combat: number): number => {
    const d = new PoseDriver();
    d.setCombat(combat);
    let x = 0, z = 0;
    let lean = 0;
    for (let i = 0; i < 120; i++) {
      z += vz * DT;
      d.setWorld(x, z, 0, 0, vz);   // курс ВСЕГДА 0: назад — это отрицательная скорость, а не разворот
      lean = d.update(DT).lean;
    }
    return lean;
  };

  it('⚠ наклон корпуса читает БОЕВУЮ колонку — этот путь шёл мимо неё', () => {
    // Ручки тела (наклон, вся скрутка) звались цепочкой БЕЗ боевой оси: панель их писала, рантайм
    // читал мирные числа. Мутация «убрать бой из вызова body()» обязана валить именно этот тест.
    POSE.leanWalk = 0.05; POSE.leanWalkRun = 0.05; POSE.leanSpeed = 0; POSE.leanSpeedRun = 0;
    COMBAT['leanWalk'] = -0.03; COMBAT['leanWalkRun'] = -0.03;
    const peace = runLean(115, 0), fight = runLean(115, 1);
    expect(peace, 'вне боя — авторский наклон').toBeCloseTo(0.05, 3);
    expect(fight, 'в бою — боевой').toBeCloseTo(-0.03, 3);
  });

  it('⭐ наклон при беге НАЗАД берётся из своей колонки, а не из бега вперёд', () => {
    POSE.leanWalk = 0.05; POSE.leanWalkRun = 0.05; POSE.leanSpeed = 0; POSE.leanSpeedRun = 0;
    BACK['leanWalk'] = -0.02; BACK['leanWalkRun'] = -0.02;
    const fwd = runLean(115, 0), back = runLean(-115, 0);
    expect(fwd, 'бег вперёд — как настроен').toBeCloseTo(0.05, 3);
    expect(back, 'бег назад — своя колонка, корпус больше не складывается').toBeCloseTo(-0.02, 3);
  });

  it('колонка «назад» действительно ГАСИТ наклон, когда назадность единица', () => {
    POSE.leanWalk = 0.05; POSE.leanWalkRun = 0.05;
    BACK['leanWalk'] = -0.02; BACK['leanWalkRun'] = -0.02;
    expect(locoVal('leanWalk', 'leanWalkRun', POSE.leanWalk, POSE.leanWalkRun, 0, mix(1, 0, 0)), 'бег вперёд').toBeCloseTo(0.05, 6);
    expect(locoVal('leanWalk', 'leanWalkRun', POSE.leanWalk, POSE.leanWalkRun, 0, mix(1, 0, 1)), 'бег назад').toBeCloseTo(-0.02, 6);
  });
});
