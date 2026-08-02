import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PoseDriver, GAIT } from './pose.js';
import { migratePoseName, retargetClipName, localStorageContent, solveTwoBoneIK } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import * as THREE from 'three';

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

  it('высота таза из idle-стойки (standY): бег/подшаг НЕ поднимают таз выше базы, стоя — на базе', () => {
    const d = new PoseDriver(); d.setStance(9, 0, -9, 0, 26);   // база таза = 26 (как в стойке)
    let maxHipY = -Infinity, pz = 0;
    for (let i = 0; i < 120; i++) { pz += 90 / 60; d.setWorld(0, pz, 0, 0, 90); const t = d.update(1 / 60); maxHipY = Math.max(maxHipY, 30 + t.bobY); }  // бег вперёд (hipY = 30 + bobY)
    expect(maxHipY).toBeLessThan(26.6);   // таз не подскочил выше базы стойки (был бы ~29 при standY=30)
    let yaw = 0, maxHipYturn = -Infinity;
    for (let i = 0; i < 120; i++) { yaw -= 0.03; d.setWorld(0, pz, yaw, 0, 0); const t = d.update(1 / 60); maxHipYturn = Math.max(maxHipYturn, 30 + t.bobY); }  // подшаги на повороте
    expect(maxHipYturn).toBeLessThan(26.6);
    for (let i = 0; i < 60; i++) { d.setWorld(0, pz, yaw, 0, 0); d.update(1 / 60); }   // стоя
    const t = d.update(1 / 60);
    expect(30 + t.bobY).toBeGreaterThan(24); expect(30 + t.bobY).toBeLessThan(26.6);   // таз на базе стойки (~26)
  });

  it('дефолтная стойка (без setStance) — как раньше: узко, без развода', () => {
    expect(standLat(3.6)).toBeLessThan(0.05);
    const d = new PoseDriver();   // setStance не звали → планты = ±полуширина таза
    let t = d.update(1 / 60);
    for (let i = 0; i < 60; i++) { d.setWorld(0, 0, 0, 0, 0); t = d.update(1 / 60); }
    expect(Math.abs(t.hipLatL)).toBeLessThan(0.05);
  });
});

// Ч2: GAIT.cadence — множитель частоты цикла ног (короче шаг → чаще семенит). Путь (px) задаётся снаружи и не меняется.
describe('StepPlanner — GAIT.cadence меняет частоту шага (антискольз-тюн), не путь', () => {
  const saved = GAIT.cadence;
  afterEach(() => { GAIT.cadence = saved; });
  // «Переступы» = число разворотов знака приращения hipL (пики/впадины маха бедра) за прогон.
  const reversals = (rows: Leg[]): number => {
    let n = 0;
    for (let i = 2; i < rows.length; i++) {
      const a = rows[i - 1]!.hipL - rows[i - 2]!.hipL, b = rows[i]!.hipL - rows[i - 1]!.hipL;
      if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) n++;
    }
    return n;
  };
  it('cadence=2 → цикл ног заметно чаще, чем cadence=1 (та же скорость/путь)', () => {
    GAIT.cadence = 1; const slow = reversals(runGait({ vx: 0, vz: 100, frames: 200 }));
    GAIT.cadence = 2; const fast = reversals(runGait({ vx: 0, vz: 100, frames: 200 }));
    expect(slow).toBeGreaterThan(2);
    expect(fast).toBeGreaterThan(slow * 1.5);   // ~×2 в идеале — семенит чаще на той же дистанции
  });
  it('cadence=1 — дефолт нейтрален (детерминированный тот же вывод)', () => {
    GAIT.cadence = 1;
    expect(runGait({ vx: 0, vz: 100, frames: 40 })).toEqual(runGait({ vx: 0, vz: 100, frames: 40 }));
  });
});

// Обвод свинга (via): маховая нога летит через авторские точки, огибая опорную (анти-кросс на уровне бедра).
describe('StepPlanner — обвод свинга через via', () => {
  // Среднее hipLatR ТОЛЬКО в фазе переноса правой ноги (via влияет только на свинг, не на опору).
  const swingMeanLatR = (via: [[number, number][], [number, number][]] | null): number => {
    const d = new PoseDriver(); d.setStance(9, 0, -9, 0);
    let px = 0, pz = 0, sum = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      px += 80 / 60; pz += 80 / 60;                 // страйф: yaw=0, движемся по диагонали (vx=vz=80) → большой боковой mLat
      d.setWorld(px, pz, 0, 80, 80);
      if (via) d.setPlantVia(via[0], via[1]);
      const t = d.update(1 / 60);
      if (d.swingLegs[1]) { sum += t.hipLatR; n++; }
    }
    return n ? sum / n : 0;
  };
  it('via=[] нейтрально — тот же вывод, что без setPlantVia (прямой свинг)', () => {
    expect(swingMeanLatR([[], []])).toBeCloseTo(swingMeanLatR(null), 6);
  });
  it('наружный via уводит маховое правое бедро НАРУЖУ (−lat) — анти-кросс на уровне бедра', () => {
    const off = swingMeanLatR(null);
    const on = swingMeanLatR([[[0, 6]], [[0, -16]]]);   // правую ногу (пересекает при +X-страйфе) уводим наружу (−lat)
    expect(on).toBeLessThan(off - 0.05);   // в переносе правое бедро заметно наружу (более отрицательный lat)
  });
});

// Ходьба: таз опускается по геометрии (плавно), а ВВЕРХ при смене опорной ноги — сглажено (нет резкого дёрга).
describe('StepPlanner — ходьба: подъём таза сглажен (нет резкого дёрга вверх)', () => {
  it('на шаге max прирост высоты таза за кадр мал (вверх плавно); вниз может быть быстрее', () => {
    const d = new PoseDriver(); d.setStance(9, 0, -9, 0, 26);   // база таза 26
    const spd = 35;   // < speedWalk(40) → ветка ХОДЬБЫ (там раньше lag=1 давал мгновенный скачок вверх)
    let pz = 0, prev = -1, maxUp = 0;
    for (let i = 0; i < 240; i++) {
      pz += spd / 60; d.setWorld(0, pz, 0, 0, spd);
      const hy = 30 + d.update(1 / 60).bobY;   // высота таза (RIG_PELVIS_Y=30 + bobY)
      if (prev >= 0 && hy > prev) maxUp = Math.max(maxUp, hy - prev);
      prev = hy;
    }
    expect(maxUp).toBeLessThan(0.6);   // подъём сглажен; без фикса скачок был бы ~1–2 ед/кадр
  });
});

describe('migratePoseName (старая конвенция → idle_/hit_)', () => {
  it('стойка_<w> → idle_<w>, удар_<w> → hit_<w>', () => {
    expect(migratePoseName('стойка_sword')).toBe('idle_sword');
    expect(migratePoseName('стойка_sword+shield')).toBe('idle_sword+shield');
    expect(migratePoseName('удар_axe')).toBe('hit_axe');
  });
  it('новые префиксы и произвольные имена не трогает (идемпотентно)', () => {
    for (const n of ['idle_sword', 'hit_axe', 's_hit_mace', 'замах_лево', 'idle_shield']) {
      expect(migratePoseName(n)).toBe(n);
    }
  });
});

describe('retargetClipName (копир позы в другое оружие)', () => {
  it('конвенционные префиксы idle_/hit_/s_hit_ переносят суффикс оружия', () => {
    expect(retargetClipName('idle_sword', 'sword', 'axe')).toBe('idle_axe');
    expect(retargetClipName('hit_sword', 'sword', 'mace')).toBe('hit_mace');
    expect(retargetClipName('s_hit_sword', 'sword', 'axe')).toBe('s_hit_axe');
  });
  it('неконвенционное имя с подстрокой оружия — замена первого вхождения', () => {
    expect(retargetClipName('замах_sword_L', 'sword', 'axe')).toBe('замах_axe_L');
  });
  it('имя без оружия остаётся без изменений', () => {
    expect(retargetClipName('замах1', 'sword', 'axe')).toBe('замах1');
  });
});

describe('solveTwoBoneIK (off-hand two-bone IK)', () => {
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  it('кисть достаёт цель в пределах длины руки (13+11)', () => {
    const h = buildHumanoid({}); h.root.updateMatrixWorld(true);
    const sh = h.bones.get('LeftUpperArm')!.getWorldPosition(V(0, 0, 0));
    const target = sh.clone().add(V(10, -5, 3));   // |Δ|≈11.6 — в досягаемости
    solveTwoBoneIK(h, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', target, null, V(0, -1, -0.4));
    h.root.updateMatrixWorld(true);
    const hand = h.bones.get('LeftHand')!.getWorldPosition(V(0, 0, 0));
    expect(hand.distanceTo(target)).toBeLessThan(1);   // дотянулась (ед. ≈ 1/32 м)
  });
  it('цель вне досягаемости → рука вытянута к ней, клампится по длине', () => {
    const h = buildHumanoid({}); h.root.updateMatrixWorld(true);
    const sh = h.bones.get('LeftUpperArm')!.getWorldPosition(V(0, 0, 0));
    const dir = V(1, -0.2, 0.1).normalize();
    solveTwoBoneIK(h, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', sh.clone().addScaledVector(dir, 100), null, V(0, -1, -0.4));
    h.root.updateMatrixWorld(true);
    const hand = h.bones.get('LeftHand')!.getWorldPosition(V(0, 0, 0));
    const reach = hand.distanceTo(sh);
    expect(reach).toBeGreaterThan(20); expect(reach).toBeLessThan(24.5);   // ~13+11
    expect(hand.clone().sub(sh).normalize().dot(dir)).toBeGreaterThan(0.9);   // в сторону цели
  });
});

describe('localStorageContent: адаптация позы под оружие + цикл hit', () => {
  const mk = (name: string, weapon: string) => ({ name, character: 'warrior', weapon, loop: false, keys: [{ pose: {}, t: 0 }] });
  const CLIPS = [mk('idle_sword', 'sword'), mk('hit_sword', 'sword'), mk('hit_sword_2', 'sword'), mk('s_hit_sword', 'sword'), mk('s_hit_axe', 'axe'), mk('s_hit_sword+dagger', 'sword+dagger')];
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (k === 'pe_clips' ? JSON.stringify(CLIPS) : null), setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  it('resolveAbilityClip ретаргетит семейство на экип. оружие; фолбэк — авторская', () => {
    const c = localStorageContent('warrior');
    expect(c.resolveAbilityClip('s_hit_sword', 'sword')?.name).toBe('s_hit_sword');   // точное оружие
    expect(c.resolveAbilityClip('s_hit_sword', 'axe')?.name).toBe('s_hit_axe');        // топор → своя s_hit_axe
    expect(c.resolveAbilityClip('s_hit_sword', 'mace')?.name).toBe('s_hit_sword');     // нет s_hit_mace → авторская
    expect(c.resolveAbilityClip('s_hit_sword', 'sword+dagger')?.name).toBe('s_hit_sword+dagger'); // дуал → своя
    expect(c.resolveAbilityClip('s_hit_sword', 'sword+shield')?.name).toBe('s_hit_sword');        // щит → база sword (оверлей поверх)
  });
  it('attackClips = все hit_* оружия, стабильный цикл; щит→база; нет → пусто', () => {
    const c = localStorageContent('warrior');
    expect(c.attackClips('sword').map((x) => x.name)).toEqual(['hit_sword', 'hit_sword_2']);
    expect(c.attackClips('sword+shield').map((x) => x.name)).toEqual(['hit_sword', 'hit_sword_2']);   // база sword
    expect(c.attackClips('axe')).toEqual([]);   // нет hit_axe и нет фолбэк-персонажа
  });
});
