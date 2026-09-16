import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// humanoidRagdoll тянет Jolt через ragdoll.ts (wasm + DOM) — стенду нужны только пределы.
vi.mock('./ragdoll.js', () => ({ jolt: () => { throw new Error('jolt is not available in node'); } }));

import { buildHumanoid } from './humanoid.js';
import { limitViewForBone, registerExtraLimits } from './humanoidRagdoll.js';
import { extraLimitView } from './jointLimits.js';
import { clampLocalToLimit } from './jointClamp.js';
import { armPoleAnatomical, armPoleLegacy } from './limbIk.js';
import { runArm, runArmSuite, ARM_PATHS, type ArmRunOpts, type ArmPath } from './armIkHarness.js';

/**
 * СТОРОЖ ЛОКТЯ ПРИ ТЯГЕ КИСТИ (жалоба 16.09.2026: «тяну руку за кисть — локоть держит место и выкручивает руку;
 * при сгибе локоть должен уходить назад»). Солв и полюс — тот же код, что в поз-редакторе (`limbSolve`, `limbIk`),
 * риг — процедурный, пределы — настоящие. Числа порогов — из разбора (три независимых варианта полюса + судья).
 */
registerExtraLimits((b) => extraLimitView(b));
const env: ArmRunOpts['env'] = { limits: limitViewForBone, clamp: (q, v) => clampLocalToLimit(q, v) };
const NOW: ArmRunOpts = { env, pole: armPoleAnatomical, twistGuard: true, planeFromTwist: true };
const rig = (): ReturnType<typeof buildHumanoid> => buildHumanoid({});

describe('стенд видит жалобу: прежний полюс без защиты', () => {
  it('туда-обратно «вниз → к груди → вниз»: перескок плеча и локоть не возвращается', () => {
    const outBack = ARM_PATHS.find((p) => p.name === 'outBack')!;
    const old = runArm(rig(), 1, outBack, { env, pole: armPoleLegacy, twistGuard: false, planeFromTwist: false });
    expect(old.maxRoll).toBeGreaterThan(100);        // замер: 159° за кадр
    expect(old.closure).toBeGreaterThan(5);          // замер: 7.3u
    const guarded = runArm(rig(), 1, outBack, { env, pole: armPoleLegacy, twistGuard: true, planeFromTwist: false });
    expect(guarded.maxRoll).toBeLessThan(12);        // защита сама по себе убирает перескок (9.4°)…
    expect(guarded.closure).toBeLessThan(0.05);
    expect(guarded.lowElbowFwdMax).toBeGreaterThan(5);   // …но локоть у опущенной кисти всё ещё впереди плеча (5.75u)
  });
  it('защита свивеля на всех путях: без перескоков и недолёта', () => {
    // Сторож самой `swivelFeasible`. У анатомического полюса требование твиста на стандартных путях в предел плеча не
    // выходит (замер: 0 срабатываний на всём наборе) — выключенная защита «сейчас»-тесты не роняет. Замер: прокрутка ≤ 10.0°
    // (row), недолёт ≤ 0.10u; без защиты — sideIn 91.7°, outBack 159°, недолёт 1.26u; без бисекции края — hipTouch 164°.
    for (const r of runArmSuite(rig, { env, pole: armPoleLegacy, twistGuard: true, planeFromTwist: true })) for (const m of [r.L, r.R]) {
      expect(m.maxRoll, `${r.path}: прокрутка за кадр`).toBeLessThan(12);
      expect(m.maxMiss, `${r.path}: недолёт`).toBeLessThan(0.2);
    }
  });
});

describe('локоть сейчас: анатомический полюс + свивель в пределах плеча', () => {
  const rows = runArmSuite(rig, NOW);
  const by = (name: string): (typeof rows)[number] => rows.find((r) => r.path === name)!;

  it('плечо не прокручивается рывками, кисть на ручке, зеркало точное', () => {
    for (const r of rows) for (const m of [r.L, r.R]) {
      expect(m.maxRoll, `${r.path}: прокрутка за кадр`).toBeLessThanOrEqual(5);
      expect(m.maxMiss, `${r.path}: недолёт`).toBeLessThan(1e-3);
      expect(m.minElbowOut, `${r.path}: локоть в рёбрах`).toBeGreaterThanOrEqual(-2.5);
    }
    for (const r of rows) expect(r.mirror, r.path).toBeLessThan(1e-4);
  });
  it('туда-обратно и петли возвращают локоть на место', () => {
    for (const n of ['outBack', 'loop3']) expect(by(n).L.closure, n).toBeLessThan(0.05);
  });
  it('сгиб к плечу почти без прокрутки плеча вокруг себя (было 102° и 130°)', () => {
    expect(by('curl').L.totalRoll).toBeLessThan(20);            // замер: 8.1°
    expect(by('outBack').L.totalRoll).toBeLessThan(60);
  });
  it('кисть низко — локоть сзади или у плеча; перед грудью — не выше плеча', () => {
    // «Строго за плечом» на каждом кадре недостижимо для ЛЮБОГО полюса: перебор всех углов свивеля по кадрам
    // даёт лучшее возможное row 0.06, curl 2.91, outBack 0.65, loop3 3.46 (u впереди). Было 5.75 на всех.
    const cap: Record<string, number> = { row: 0.5, curl: 3.4, outBack: 1.5, loop3: 4.2, hipTouch: 0 };
    for (const n in cap) {
      expect(Number.isFinite(by(n).L.lowElbowFwdMax), `${n}: нет кадров с опущенной кистью — проверка пустая`).toBe(true);
      expect(by(n).L.lowElbowFwdMax, n).toBeLessThanOrEqual(cap[n]!);
    }
    for (const r of rows) if (Number.isFinite(r.L.frontElbowUpMax)) expect(r.L.frontElbowUpMax, r.path).toBeLessThanOrEqual(0);
  });
  it('при сгибе руки локоть уходит НАЗАД', () => {
    const bends: ArmPath[] = [
      { name: 'bendDown', closed: false, frames: 41, keys: [[0.05, -0.98, 0.05], [0.05, -0.3, 0.1]] },
      { name: 'bendFrontLow', closed: false, frames: 41, keys: [[0.05, -0.7, 0.68], [0.05, -0.2, 0.2]] },
      { name: 'bendSideLow', closed: false, frames: 41, keys: [[0.68, -0.7, 0.05], [0.2, -0.2, 0.05]] },
    ];
    for (const p of bends) {
      const m = runArm(rig(), 1, p, NOW);
      expect(m.elbows[m.elbows.length - 1]!.z - m.elbows[0]!.z, p.name).toBeLessThan(-5);   // замер: −6.5 … −9.9u
      expect(m.maxRoll, p.name).toBeLessThan(2);
    }
  });
});

describe('правка плоскости локтя затухает по ходу кисти', () => {
  const row = ARM_PATHS.find((p) => p.name === 'row')!, loop3 = ARM_PATHS.find((p) => p.name === 'loop3')!;
  it('правка 60°: держится без затухания, слабеет по пути с ним', () => {
    const kept = runArm(rig(), 1, row, { ...NOW, swivel: 1.05, tweakAfterApproach: true });
    const faded = runArm(rig(), 1, row, { ...NOW, swivel: 1.05, swivelFade: 25, tweakAfterApproach: true });
    expect(kept.endPlaneDev).toBeGreaterThan(55);
    expect(faded.travel).toBeGreaterThan(25);
    expect(faded.endPlaneDev).toBeLessThan(25);                 // замер: 20.7° после 26.7u (60·e^(−26.7/25))
    // затухает ПО ПУТИ, а не по кадрам и не сильнее: 20.70° против 20.66° по формуле
    expect(Math.abs(faded.endPlaneDev - kept.endPlaneDev * Math.exp(-faded.travel / 25))).toBeLessThan(1.5);
    const long = runArm(rig(), 1, loop3, { ...NOW, swivel: 1.05, swivelFade: 25, tweakAfterApproach: true });
    expect(long.endPlaneDev).toBeLessThan(2);                   // 113u пути — анатомия вернулась
  });
  it('правка −60° (упирается в предел плеча): кисть на ручке, без перескоков', () => {
    // Здесь защита свивеля работает на АНАТОМИЧЕСКОМ полюсе (row, toChest, overhead, outBack, behindHead). Замер: прокрутка
    // ≤ 12.3° (outBack — быстрая, не перескок), недолёт ≤ 0.13u; без защиты недолёт до 1.14u (behindHead), «дальний допустимый» — 178°.
    for (const p of ARM_PATHS) {
      const m = runArm(rig(), 1, p, { ...NOW, swivel: -1.05, swivelFade: 25, tweakAfterApproach: true });
      expect(m.maxRoll, p.name).toBeLessThan(15);
      expect(m.maxMiss, p.name).toBeLessThan(0.2);
    }
  });
  it('большая правка за пределом: выбор не перескакивает с края на край запрещённой зоны', () => {
    // Желаемая плоскость идёт сквозь зону, куда плечо не пускает. Без тяги к текущей плоскости (`GUARD_STAY`) выбор
    // перескакивал на её середине. Замер: за головой после −92° — 153° → 2.6° за кадр, вверх после −115° — 112° → 4°.
    const cases: [string, number, number][] = [['behindHead', -1.6, 5], ['overhead', -2.0, 6]];
    for (const [name, sw, cap] of cases) {
      const m = runArm(rig(), 1, ARM_PATHS.find((p) => p.name === name)!, { ...NOW, swivel: sw, swivelFade: 25, tweakAfterApproach: true });
      expect(m.maxRoll, `${name} ${sw}`).toBeLessThan(cap);
    }
  });
  it('захват плоскости с позы (клик по кисти) не дёргает руку', () => {
    // Как `syncEff` → `swivelFromHinge`: поза поставлена ПРЕЖНИМ полюсом, угол снимается с твиста плеча и применяется тем же
    // `limbNaturalPole`. Разойдутся знак или фрейм захвата и применения — плечо провернётся на старте на двойной угол.
    // Замер: захват до 101° (curl), старт 0.00°, по пути ≤ 4.1°, недолёт ≤ 0.015u; без затухания behindHead — 43°.
    let widest = 0;
    for (const p of ARM_PATHS) {
      const m = runArm(rig(), 1, p, { ...NOW, approachPole: armPoleLegacy, captureSwivel: true, swivelFade: 25 });
      widest = Math.max(widest, Math.abs(m.startSwivel));
      expect(m.startRoll, `${p.name}: рывок на старте`).toBeLessThan(0.1);
      expect(m.maxRoll, p.name).toBeLessThanOrEqual(5);
      expect(m.maxMiss, p.name).toBeLessThan(0.05);
    }
    expect(widest).toBeGreaterThan(1.5);                         // захват не пустой: проверка видит знак
  });
});

describe('поле полюса гладкое', () => {
  it('соседние направления кисти в 1° дают полюс, отличающийся не больше чем на 6° (вне особой точки)', () => {
    const s = Math.SQRT1_2, sing = new THREE.Vector3(-s, 0, -s);   // антипод опоры: кисть назад-внутрь сквозь спину
    const polar = (lat: number, lon: number): THREE.Vector3 => new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
    const pole = (u: THREE.Vector3, side: 1 | -1, reach: number): THREE.Vector3 => {
      const p = armPoleAnatomical(u, side, reach); return p.addScaledVector(u, -p.dot(u)).normalize();
    };
    const D = Math.PI / 180;
    let worst = 0;
    for (let lat = -86; lat <= 86; lat += 4) for (let lon = 0; lon < 360; lon += 4) {
      const u = polar(lat * D, lon * D);
      if (u.angleTo(sing) < 30 * D) continue;
      for (const reach of [0.3, 0.6, 1]) {
        const p = pole(u, 1, reach);
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
        for (const n of [polar((lat + 1) * D, lon * D), polar(lat * D, (lon + 1) * D)]) worst = Math.max(worst, p.angleTo(pole(n, 1, reach)) / D);
        const r = pole(new THREE.Vector3(-u.x, u.y, u.z), -1, reach);   // правая рука — зеркало левой
        expect(Math.abs(r.x + p.x) + Math.abs(r.y - p.y) + Math.abs(r.z - p.z)).toBeLessThan(1e-9);
      }
    }
    expect(worst).toBeLessThan(6);
    for (const reach of [NaN, 0, 2]) expect(Number.isFinite(armPoleAnatomical(new THREE.Vector3(0, -1, 0), 1, reach).length())).toBe(true);
  });
});
