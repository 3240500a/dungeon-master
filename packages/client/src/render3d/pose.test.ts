import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PoseDriver, GAIT } from './pose.js';

// Ноги гейта считает StepPlanner (детерминирован: своя фаза с 0, без Math.random). Читаем ТОЛЬКО ножные поля —
// они не зависят от случайной инициализации фазы рук. Феча 1 (плант-цель) обязана быть НЕЙТРАЛЬНА к игре при
// дефолтах: новые GAIT-поля + setPlantOffset при [0,0] дают прежний вывод (ортонормир. базис facing).

type Leg = { hipL: number; hipR: number; knL: number; knR: number; hipLatL: number; hipLatR: number; bobY: number };
function runGait(opts?: { off?: [number, number, number, number]; vx?: number; vz?: number; frames?: number }): Leg[] {
  const d = new PoseDriver();
  const dt = 1 / 60, vx = opts?.vx ?? 0, vz = opts?.vz ?? 100, frames = opts?.frames ?? 40;
  const rows: Leg[] = [];
  let px = 0, pz = 0;
  for (let i = 0; i < frames; i++) {
    px += vx * dt; pz += vz * dt;
    d.setWorld(px, pz, 0, vx, vz);
    if (opts?.off) d.setPlantOffset(...opts.off);
    const t = d.update(dt);
    const r = (n: number): number => Math.round(n * 1e4) / 1e4;
    rows.push({ hipL: r(t.hipL), hipR: r(t.hipR), knL: r(t.knL), knR: r(t.knR), hipLatL: r(t.hipLatL), hipLatR: r(t.hipLatR), bobY: r(t.bobY) });
  }
  return rows;
}

describe('StepPlanner — плант-цель (Феча 1) нейтральна к игре при дефолтах', () => {
  const snapshot = { standY: GAIT.standY, stanceWidth: GAIT.stanceWidth, strafeReach: GAIT.strafeReach, crossClamp: GAIT.crossClamp };
  beforeEach(() => { GAIT.stanceWidth = 0; GAIT.strafeReach = 1; GAIT.crossClamp = 99; });
  afterEach(() => { Object.assign(GAIT, snapshot); });

  it('дефолты GAIT — нейтральные (0 / 1 / 99)', () => {
    expect(snapshot.stanceWidth).toBe(0);
    expect(snapshot.strafeReach).toBe(1);
    expect(snapshot.crossClamp).toBe(99);
  });

  it('setPlantOffset([0,0,0,0]) идентичен отсутствию вызова — хук нейтрален', () => {
    expect(runGait({ off: [0, 0, 0, 0], vx: 80, vz: 40 })).toEqual(runGait({ vx: 80, vz: 40 }));
  });

  it('детерминизм: два прогона совпадают (ноги без случайной фазы)', () => {
    expect(runGait({ vx: 60, vz: 60 })).toEqual(runGait({ vx: 60, vz: 60 }));
  });

  it('ненулевой offset МЕНЯЕТ вывод (хук реально подключён)', () => {
    expect(runGait({ off: [6, 6, 6, 6], vx: 0, vz: 100 })).not.toEqual(runGait({ vx: 0, vz: 100 }));
  });

  it('stanceWidth/strafeReach МЕНЯЮТ страйф, forward-run при дефолтах не трогают', () => {
    const fwd = runGait({ vx: 0, vz: 100 });
    GAIT.strafeReach = 0.5; GAIT.stanceWidth = 4;
    const fwdAfter = runGait({ vx: 0, vz: 100 });   // чистый вперёд: mLat=0 → strafeReach не влияет, но stanceWidth разводит вбок
    const strafeAfter = runGait({ vx: 100, vz: 0 });
    GAIT.strafeReach = 1; GAIT.stanceWidth = 0;
    const strafeBefore = runGait({ vx: 100, vz: 0 });
    expect(strafeAfter).not.toEqual(strafeBefore);   // страйф изменился
    expect(fwdAfter).not.toEqual(fwd);               // stanceWidth развёл ноги и на forward — ожидаемо
  });
});

// Поворот на месте: РАССТАВЛЕННАЯ стойка (setStance) должна держаться, а не сводиться под таз — и переступать вбок.
describe('StepPlanner — поворот на месте держит стойку и переступает вбок', () => {
  // Боковой угол бедра стоя (после устаканивания): 0 = ноги под тазом, >0 = реально разведены.
  const standLat = (half: number): number => {
    const d = new PoseDriver();
    d.setStance(half, 0, -half, 0);   // нога 0/левая на +half (+X), нога 1/правая на −half
    let t = d.update(1 / 60);
    for (let i = 0; i < 120; i++) { d.setWorld(0, 0, 0, 0, 0); t = d.update(1 / 60); }
    return Math.abs(t.hipLatL);
  };

  it('узкая стойка (=таз) сводит ноги под таз; широкая — держит развод', () => {
    expect(standLat(3.6)).toBeLessThan(0.05);    // под таз — бокового угла почти нет
    expect(standLat(11)).toBeGreaterThan(0.15);  // расставленная стойка — ноги реально разведены
  });

  // Прогон поворота на месте: вернуть первую переступившую ногу (0=лев,1=прав) и было ли скрещивание (стопа за средней линией).
  const turnRun = (dir: number): { first: number; crossed: boolean; stepped: boolean } => {
    const d = new PoseDriver(); d.setStance(11, 0, -11, 0);   // планты: левая +11, правая −11
    for (let i = 0; i < 40; i++) { d.setWorld(0, 0, 0, 0, 0); d.update(1 / 60); }   // устаканиться стоя
    let yaw = 0, first = -1, crossed = false, stepped = false;
    for (let i = 0; i < 260; i++) {
      yaw += dir * 0.05;                                                            // ~3 рад/с — быстро крутимся (стресс)
      d.setWorld(0, 0, yaw, 0, 0);
      const t = d.update(1 / 60);
      const [sl, sr] = d.swingLegs;
      if (first < 0 && (sl || sr)) first = sl ? 0 : 1;
      if (d.stepping) stepped = true;
      // Нога 0 (левая) в норме на +X (её кость LeftUpperLeg на +X): hipLatL>0. Скрещивание = левая ушла на −X (hipLatL<0)
      // или правая на +X (hipLatR>0).
      if (t.hipLatL < -0.2 || t.hipLatR > 0.2) crossed = true;
    }
    return { first, crossed, stepped };
  };

  // Ведущая нога по стороне поворота (в игре: против часовой сверху → первой ЛЕВАЯ, по часовой → правая).
  it('yaw↓ (по часовой в игре) → первой переступает ПРАВАЯ нога, без скрещивания', () => {
    const r = turnRun(-1);
    expect(r.stepped).toBe(true);
    expect(r.first).toBe(1);         // правая первой
    expect(r.crossed).toBe(false);   // ноги не скрестились за среднюю линию
  });

  it('yaw↑ (против часовой в игре) → первой переступает ЛЕВАЯ нога, без скрещивания', () => {
    const r = turnRun(1);
    expect(r.stepped).toBe(true);
    expect(r.first).toBe(0);         // левая первой
    expect(r.crossed).toBe(false);
  });

  it('МЕДЛЕННЫЙ поворот (ниже turnStep) → опорная стопа ПРИБИТА (не скользит), но подшаг всё равно происходит', () => {
    const d = new PoseDriver(); d.setStance(9, 0, -9, 0);
    for (let i = 0; i < 40; i++) { d.setWorld(0, 0, 0, 0, 0); d.update(1 / 60); }   // устаканиться
    let yaw = 0, firstStep = -1, maxSlide = 0;
    let prev0 = d.plantTarget(0), prevSw0 = d.swingLegs[0];
    for (let i = 0; i < 400; i++) {
      yaw -= 0.006;                                                                 // ~0.36 рад/с — НИЖЕ turnStep(0.45)
      d.setWorld(0, 0, yaw, 0, 0); d.update(1 / 60);
      const sw0 = d.swingLegs[0];
      if (firstStep < 0 && (sw0 || d.swingLegs[1])) firstStep = i;                  // первый реальный перенос ноги
      const p0 = d.plantTarget(0);
      if (!sw0 && !prevSw0) maxSlide = Math.max(maxSlide, Math.hypot(p0[0] - prev0[0], p0[1] - prev0[1]));  // опорная не едет
      prev0 = p0; prevSw0 = sw0;
    }
    // Шаг ПО ДИСТАНЦИИ (turnStepDist), а не по страховке-скрещиванию (та сработала бы ~90° ≈ кадр 260). Ждём ≈ кадр 70.
    expect(firstStep).toBeGreaterThan(0); expect(firstStep).toBeLessThan(150);
    expect(maxSlide).toBeLessThan(0.02); // опорная стопа прибита к миру — между кадрами не скользит (было бы ~0.05)
  });

  it('дефолтная стойка (без setStance) — как раньше: узко, без развода', () => {
    expect(standLat(3.6)).toBeLessThan(0.05);
    const d = new PoseDriver();   // setStance не звали → планты = ±полуширина таза
    let t = d.update(1 / 60);
    for (let i = 0; i < 60; i++) { d.setWorld(0, 0, 0, 0, 0); t = d.update(1 / 60); }
    expect(Math.abs(t.hipLatL)).toBeLessThan(0.05);
  });
});
