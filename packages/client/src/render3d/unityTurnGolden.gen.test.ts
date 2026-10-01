/**
 * ПРОДЮСЕР golden-эталона «ПОВОРОТЫ — ЧИСТЫЕ ФУНКЦИИ» для Unity-клиента (шаг U4d, класс G1: вектора по функциям). На каждом
 * `npm test` перегенерирует `__golden__/unity_anim_turn.json` из ТЕКУЩЕГО кода веба. Покадровый эталон G2 (`unity_anim_g2.json`)
 * проверяет повороты в сборе, но не достаёт до краёв правил — здесь они перебираются напрямую:
 *  • `sector` — `nearestWarpSector`: ничьи ровно на ±45°/±135° и в долях допуска вокруг них (правило явное: ничья — оси
 *    вперёд/назад, зеркально по знаку; `Math.Round` C# округляет половину к чётному — им здесь пользоваться нельзя);
 *  • `dirWarp` — цепочки `stepDirWarp` (сектора с гистерезисом и забыванием на остановке, старая складка, потолок со знаком,
 *    бюджет скрутки, сглаживание, предел скорости с разгоном) при 60 и 144 Гц;
 *  • `torsoLead` — цепочки `stepTorsoLead` (порог, выравнивание с полосой включения, гашение, разгон и торможение, без разгона,
 *    переход через ±π);
 *  • `pickTurn` / `commit` — выбор величины поворота (ближайший, ничья — больший, набор неполный) и три правила решения;
 *  • `names` — имена поворотов; `fresh` — `isLocoClipFresh`; `clipYaw` — `turnYawAt` / `turnSupportAt` на клипах мокапа Kubold и
 *    синтетике (сплайн, канал опоры, время за краями).
 * Unity: `Assets/DM/PoseEditor/Tests/TurnCheck.cs` (меню DM ▸ Verify Turning).
 * Скопировать в Unity: `python tools/unity-check/golden_sync.py` (репо Unity) → Assets/DM/PoseEditor/Tests/unity_anim_turn_golden.json.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nearestWarpSector, stepDirWarp, DIR_WARP0, stepTorsoLead, TWIST_DEFAULT, isLocoClipFresh, TURN_ACCEL_SEC, type DirWarp } from './poseRuntime.js';
import { pickTurn, shouldCommitTurn, turnClipName, TURN_NAMES, TURN_ANGLES_DEG, turnYawAt, turnSupportAt } from './turnInPlace.js';
import { type Clip } from './clipModel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
type RawClip = { name: string; character: string; weapon: string; loop: boolean; keys: { t: number; pose: Record<string, number[]>; interp?: string }[]; [k: string]: unknown };
const CORE = JSON.parse(readFileSync(join(HERE, '..', '..', 'public', 'mocap', 'mocap_core.json'), 'utf8')) as RawClip[];
const DEG = Math.PI / 180;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Выходы цепочек — с точностью 1e-12 (проверка Unity — 1e-9): эталон вчетверо легче, а сравнение то же. */
const r12 = (x: number): number => { const v = Math.round(x * 1e12) / 1e12; return Object.is(v, -0) ? 0 : v; };

/** Детерминированный шум (без Math.random): одни и те же входы на каждом прогоне — эталон бит в бит. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ── nearestWarpSector ─────────────────────────────────────────────────────────────────────────────
function sectorRows(): [number, number][] {
  const ds: number[] = [];
  for (const b of [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI])
    for (const o of [0, 5e-7, -5e-7, 1e-6, -1e-6, 2e-6, -2e-6, 1e-5, -1e-5]) { ds.push(b + o); ds.push(-(b + o)); }
  for (let k = -24; k <= 24; k++) ds.push(k * 7.5 * DEG);
  ds.push(Math.atan2(1, 1), Math.atan2(-1, 1), Math.atan2(1, -1), Math.atan2(-1, -1), Math.atan2(80 / Math.SQRT2, 80 / Math.SQRT2));
  return ds.map((d) => [d, nearestWarpSector(d)]);
}

// ── stepDirWarp ───────────────────────────────────────────────────────────────────────────────────
type WarpCfg = { on: number; maxDeg: number; smooth: number; sectors: boolean; rateDeg: number };
/** Вход кадра доворота: курс таза, прицел, скорость. */
type WarpIn = [number, number, number, number];
function warpTrajectories(): { id: string; steps: WarpIn[] }[] {
  const v = (deg: number, spd = 80): [number, number] => [spd * Math.sin(deg * DEG), spd * Math.cos(deg * DEG)];
  const sweep: WarpIn[] = Array.from({ length: 150 }, (_, i) => { const [x, z] = v(i * 2.4); return [0, 0, x, z]; });
  const jumps: WarpIn[] = [];
  const seg = (n: number, deg: number | null, root = 0, aim = 0, spd = 80): void => {
    for (let i = 0; i < n; i++) { const [x, z] = deg === null ? [0, 0] : v(deg, spd); jumps.push([root, aim, x, z]); }
  };
  seg(30, 60); seg(25, 40); seg(25, 30); seg(10, null); seg(25, 50); seg(20, -170); seg(5, null);
  seg(20, 45); seg(5, null); seg(20, -45); seg(5, null); seg(20, 135); seg(5, null); seg(20, -135);
  seg(15, 54.9); seg(15, 101.9); seg(15, 102.1); seg(15, 78.1); seg(15, 77.9); seg(10, null); seg(15, 95);
  seg(10, 90, 0, 0, 4); seg(10, 90, 0, 0, 4.0001); seg(10, 90, 0, 0, 3.9);
  const budget: WarpIn[] = [];
  const r = rng(7);
  let root = 0;
  for (let i = 0; i < 140; i++) {
    root += (r() - 0.5) * 0.05;
    const aim = root + Math.sin(i / 17) * 1.9;            // прицел за пределом скрутки — бюджет режет доворот
    const [x, z] = v(Math.sin(i / 23) * 160 + root / DEG, 40 + 80 * r());
    budget.push([root, aim, x, z]);
  }
  const wrap: WarpIn[] = Array.from({ length: 70 }, (_, i) => { const rr = 3.0 + i * 0.01; const [x, z] = v(rr / DEG + 100); return [rr, rr + 0.3, x, z]; });
  return [{ id: 'sweep', steps: sweep }, { id: 'jumps', steps: jumps }, { id: 'budget', steps: budget }, { id: 'wrap', steps: wrap }];
}
const WARP_CFGS: WarpCfg[] = [
  { on: 1, maxDeg: 50, smooth: 0.12, sectors: true, rateDeg: 300 },
  { on: 1, maxDeg: 45, smooth: 0.12, sectors: true, rateDeg: 0 },
  { on: 1, maxDeg: 50, smooth: 0, sectors: true, rateDeg: 300 },
  { on: 1, maxDeg: -40, smooth: 0.2, sectors: false, rateDeg: 300 },
  { on: 1, maxDeg: 50, smooth: 0.12, sectors: false, rateDeg: 0 },
  { on: 0.4, maxDeg: 50, smooth: 0.12, sectors: true, rateDeg: 300 },
];

// ── stepTorsoLead ─────────────────────────────────────────────────────────────────────────────────
/** Вход кадра torso-lead: прицел и «прицел стоит дольше relaxTime». */
type LeadIn = [number, boolean];
function leadTrajectories(): { id: string; steps: LeadIn[] }[] {
  const out: { id: string; steps: LeadIn[] }[] = [];
  const stepTo: LeadIn[] = [...Array.from({ length: 10 }, (): LeadIn => [0, false]), ...Array.from({ length: 80 }, (): LeadIn => [1.2, false])];
  out.push({ id: 'step', steps: stepTo });
  const ramp: LeadIn[] = Array.from({ length: 150 }, (_, i): LeadIn => [Math.min(2.5, i * 0.03), i > 120]);
  out.push({ id: 'ramp_relax', steps: ramp });
  const osc: LeadIn[] = Array.from({ length: 150 }, (_, i): LeadIn => [0.7 + Math.sin(i / 9) * 0.08, (i % 50) > 30]);
  out.push({ id: 'threshold_osc', steps: osc });
  const small: LeadIn[] = Array.from({ length: 120 }, (_, i): LeadIn => [i < 5 ? 0 : i < 60 ? 0.05 : 0.025, i >= 20]);
  out.push({ id: 'relax_band', steps: small });
  const wrap: LeadIn[] = Array.from({ length: 160 }, (_, i): LeadIn => [i < 20 ? 3.0 : -3.0 + Math.min(0.2, i * 0.002), i > 140]);
  out.push({ id: 'wrap_pi', steps: wrap });
  const r = rng(11);
  let aim = 0;
  const noisy: LeadIn[] = Array.from({ length: 160 }, (_, i): LeadIn => { aim += (r() - 0.45) * 0.12; return [aim, i % 70 > 50]; });
  out.push({ id: 'noisy', steps: noisy });
  return out;
}
const LEAD_PROFILES = [
  { threshold: 0.7, turnRate: 3, maxTwist: 1.4 },
  { threshold: 0.35, turnRate: 4.5, maxTwist: 0.9 },
  { threshold: 1.2, turnRate: 1.5, maxTwist: 1.1 },
];

describe('эталон поворотов (чистые функции) для Unity', () => {
  it('пишет __golden__/unity_anim_turn.json', () => {
    const sector = sectorRows();

    // Прогоны: каждая траектория × набор (настройка, частота, предел скрутки); 144 Гц и узкий предел — не на всех настройках.
    const warpTr = warpTrajectories();
    const warpRuns: unknown[] = [];
    for (const tr of warpTr) for (const [ci, cfg] of WARP_CFGS.entries()) for (const dt of [1 / 60, 1 / 144]) for (const maxTwist of [1.4, 0.5]) {
      if (dt !== 1 / 60 && ci !== 0 && ci !== 3) continue;
      if (maxTwist !== 1.4 && !(tr.id === 'budget' && (ci === 0 || ci === 3))) continue;
      let st: DirWarp = { ...DIR_WARP0 };
      const outs: (number | boolean)[][] = [];
      for (const [root, aim, vx, vz] of tr.steps) {
        st = stepDirWarp(st, root, aim, vx, vz, maxTwist, dt, cfg);
        outs.push([r12(st.warp), st.sector, st.moving, r12(st.rate)]);
      }
      warpRuns.push({ id: `${tr.id}/c${ci}/${dt === 1 / 60 ? 60 : 144}/${maxTwist}`, traj: tr.id, cfg, maxTwist, dt, out: outs });
    }
    const dirWarp = { trajectories: Object.fromEntries(warpTr.map((t) => [t.id, t.steps])), runs: warpRuns };

    // Прогоны: профиль 0 — все разгоны на 60 и 144 Гц, прочие профили — разгон игры на 60 Гц.
    const leadTr = leadTrajectories();
    const leadRuns: unknown[] = [];
    for (const tr of leadTr) for (const [pi, pf] of LEAD_PROFILES.entries()) for (const accelSec of [0, TURN_ACCEL_SEC, 0.15]) for (const dt of [1 / 60, 1 / 144]) {
      if (pi !== 0 && (accelSec !== TURN_ACCEL_SEC || dt !== 1 / 60)) continue;
      const twist = { ...TWIST_DEFAULT(), ...pf };
      let root = 0, turning = false, rate = 0;
      const outs: (number | boolean)[][] = [];
      for (const [aim, relax] of tr.steps) {
        const r = stepTorsoLead(root, aim, twist, dt, turning, relax, rate, accelSec);
        root = r.rootYaw; turning = r.turning; rate = r.rate;
        outs.push([r12(r.rootYaw), r12(r.residual), r.turning, r12(r.rate)]);
      }
      leadRuns.push({ id: `${tr.id}/p${pi}/a${accelSec}/${dt === 1 / 60 ? 60 : 144}`, traj: tr.id, profile: pf, accelSec, dt, out: outs });
    }
    const torsoLead = { trajectories: Object.fromEntries(leadTr.map((t) => [t.id, t.steps])), runs: leadRuns };

    // Наборы запечённых поворотов: имена → есть ли.
    const SETS: Record<string, string[]> = {
      all: [...TURN_NAMES], none: [],
      only90: [turnClipName(90, false), turnClipName(90, true)],
      only45: [turnClipName(45, false), turnClipName(45, true)],
      no90: TURN_NAMES.filter((n) => !n.includes('_90')),
      rightOnly: TURN_NAMES.filter((n) => n.startsWith('turn_R')),
    };
    const pickRows: unknown[] = [];
    const resDeg = [0, 20, 34.9999, 35, 35.0001, 40, 60, 67.5, 67.4999, 67.5001, 70, 100, 120, 134.9999, 135, 135.0001, 150, 179, 180, 200];
    for (const [set, names] of Object.entries(SETS)) for (const d of resDeg) for (const sgn of [1, -1]) {
      const residual = sgn * d * DEG;
      const p = pickTurn(residual, (n) => names.includes(n));
      pickRows.push([residual, set, p ? p.name : null, p ? p.deg : null, p ? p.right : null]);
    }
    const pick = { sets: SETS, rows: pickRows };

    const commit: unknown[] = [];
    const minTurn = (Math.min(...TURN_ANGLES_DEG) - 10) * DEG;
    for (const residual of [0, 0.3, minTurn - 1e-9, minTurn, 0.6, 0.7 - 1e-12, 0.7, 1.0, -0.7, -1.39, 1.4, -2.5])
      for (const stableFor of [0, 0.05, 0.1 - 1e-12, 0.1, 0.5, 1.0, 1.2, 1.5])
        for (const pinnedFor of [0, 0.11, 0.12, 0.3])
          for (const tw of [{ threshold: 0.7, relaxTime: 1.2 }, { threshold: 0.6, relaxTime: 1.0 }]) {
            commit.push([residual, stableFor, pinnedFor, tw.threshold, tw.relaxTime, shouldCommitTurn(residual, stableFor, pinnedFor, tw)]);
          }

    const names = { turnNames: [...TURN_NAMES], clip: [45, 90, 180].flatMap((d) => [false, true].map((r) => [d, r, turnClipName(d, r)])) };

    // Свежесть клипа хода для секторов: импорт (нет `bakeSpeed`), запекатель до/после кардинальной ревизии, пустые поля.
    const freshClips: RawClip[] = [
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }] },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeSpeed: 55, bakeRev: 1 },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeSpeed: 55, bakeRev: 2 },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeSpeed: 55, bakeRev: 3 },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeSpeed: 55 },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeSpeed: null, bakeRev: 1 },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeRev: 0 },
      { name: 'walk_strafe_R', character: 'x', weapon: 'none', loop: true, keys: [{ t: 0, pose: {} }], bakeSpeed: 120.5, bakeRev: 1.9 },
    ];
    const fresh = { clips: freshClips, out: freshClips.map((c) => isLocoClipFresh(c as unknown as Clip)) };

    // Курс и опора клипа поворота по времени: мокап (линейные ключи) и синтетика (сплайн `smooth`, канал опоры, ступень).
    const turnR90 = clone(CORE.find((c) => c.name === 'turn_R_90')!);
    const turnL180 = clone(CORE.find((c) => c.name === 'turn_L_180')!);
    const syn: RawClip = {
      name: 'turn_R_45', character: 'syn', weapon: 'none', loop: false, rootYaw: true,
      keys: [
        { t: 0, pose: { __rootY: [0, 0, 0], __swing: [0, 0, 0] }, interp: 'smooth' },
        { t: 0.2, pose: { __rootY: [0.1, 0, 0], __swing: [0.9, 0, 0] }, interp: 'smooth' },
        { t: 0.37, pose: { __rootY: [0.45, 0, 0], __swing: [0, 0.7, 0] }, interp: 'step' },
        { t: 0.5, pose: { __rootY: [0.7, 0, 0] } },
        { t: 0.65, pose: { __rootY: [0.7853981633974483, 0, 0], __swing: [0, 0, 0] } },
      ],
    };
    const noChan: RawClip = { name: 'turn_L_45', character: 'syn', weapon: 'none', loop: false, keys: [{ t: 0, pose: { Hips: [0, 0, 0] } }, { t: 0.4, pose: { Hips: [0, 0.1, 0] } }] };
    const ycl = [turnR90, turnL180, syn, noChan];
    const clipYaw = {
      clips: ycl,
      samples: ycl.map((c) => {
        const dur = c.keys[c.keys.length - 1]!.t;
        const ts = [-0.1, 0, 0.013, 0.05, 0.1, 0.21, 0.3, 0.33, 0.4, 0.55, dur * 0.5, dur - 0.01, dur, dur + 0.5];
        return ts.map((t) => { const s = turnSupportAt(c as unknown as Clip, t); return [t, turnYawAt(c as unknown as Clip, t), s[0], s[1]]; });
      }),
    };

    // Сторож сути: ничьи на ±45°/±135° — вперёд/назад, зеркально; доворот и torso-lead реально что-то делали.
    expect(nearestWarpSector(Math.PI / 4)).toBe(0); expect(nearestWarpSector(-Math.PI / 4)).toBe(0);
    expect(nearestWarpSector(3 * Math.PI / 4)).toBe(2); expect(nearestWarpSector(-3 * Math.PI / 4)).toBe(2);
    expect(new Set(sector.map((r) => r[1]))).toEqual(new Set([0, 1, 2, 3]));
    expect((warpRuns as { out: number[][] }[]).some((c) => c.out.some((o) => Math.abs(o[0]!) > 0.5))).toBe(true);
    expect((leadRuns as { out: (number | boolean)[][] }[]).some((c) => c.out.some((o) => o[2] === true))).toBe(true);
    expect(pickRows.some((p) => (p as unknown[])[2] === 'turn_R_180')).toBe(true);

    const golden = {
      note: 'Эталон поворотов (U4d) — чистые функции веба: nearestWarpSector, stepDirWarp, stepTorsoLead, pickTurn, shouldCommitTurn, turnClipName, isLocoClipFresh, turnYawAt, turnSupportAt. Генерит packages/client/src/render3d/unityTurnGolden.gen.test.ts.',
      sector, dirWarp, torsoLead, pick, commit, names, fresh, clipYaw,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_anim_turn.json'), JSON.stringify(golden));
  }, 120_000);
});
