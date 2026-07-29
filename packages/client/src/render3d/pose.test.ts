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
