import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';

// env3d тянет DOM/GLTFLoader — физмиру от него нужна только высота стены. С этим моком НАСТОЯЩИЕ `ragdoll.ts`
// (initPhysics + PhysWorld) и `makeHumanoidRagdoll` грузятся в node-vitest (риг — процедурный пресет, 17 тел).
vi.mock('./env3d.js', () => ({ WALL_H: 96 }));

import { initPhysics, PhysWorld, jolt, PHYS_H } from './ragdoll.js';
import { makeHumanoidRagdoll, RAG_NAMES, renderRagdollGhost, newGhostGround, type HumanoidRagdoll } from './humanoidRagdoll.js';
import { buildHumanoid } from './humanoid.js';

/**
 * СТОРОЖ KINEMATIC-ТАЗА НА ЖИВОМ JOLT. Ошибка жила с da5f331 по 17.09.2026: кукла звала `MoveKinematic(цель, dt КАДРА)`,
 * а игра шагала фикс-шагом 1/60 — ошибка таза умножалась на (1 − частота/60) на каждом шаге.
 * ЗАМЕР старого кода (скачок +5u): 120 Гц — ±5.00u навсегда; 144 Гц — 2.9e9u; 165/240 Гц — Infinity/NaN.
 * Дрожь торса (RMS второй разности тела Torso по шагам, u/с²; бег 300 u/с): старый код 45 Гц — 10 047,
 * 60 Гц ±2 мс — 13 601, 90 Гц — 30 082, 144 Гц — ∞; «держать цель каждый шаг» — 30 Гц 31 150, 144 Гц 5 997.
 * Сейчас (цели по времени, `PhysWorld.advance`): 225–524 на всех частотах.
 * И то, что ВИДНО: игра рисует куклу до шага физики, поэтому корень призрака берётся из цели таза (`pelvisTarget`), а не
 * из тела — иначе на 120/144 Гц и рваных 60 Гц корень прыгал на шаг движения (бег 300 u/с: 2.5–3.9u за кадр).
 */
const Y0 = 32, RUN_V = 300;
const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
const qYaw = (yaw: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
type Mode = 'advance' | 'step' | 'stepFrame';
interface Tgt { x: number; y: number; yaw: number }

function rnd(seed: number): () => number {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** dt кадров: точные 1/hz или метки rAF i/hz ± джиттер (dt — разность, как в браузере). */
function frames(hz: number, dur: number, jitterMs = 0): number[] {
  const r = rnd(12345), out: number[] = [];
  let prev = 0;
  for (let i = 1; i / hz <= dur; i++) {
    if (!jitterMs) { out.push(1 / hz); continue; }
    const ts = i / hz + (r() * 2 - 1) * jitterMs / 1000;
    out.push(Math.min(0.05, ts - prev)); prev = ts;
  }
  return out;
}

interface World { pw: PhysWorld; rag: HumanoidRagdoll; torso: { t: number; p: number[] }[]; rel: THREE.Vector3[]; pins: (THREE.Vector3 | null)[] }
function world(t0: Tgt): World {
  const pw = new PhysWorld(); pw.addGround(3000);
  const rag = makeHumanoidRagdoll(pw);
  rag.setPelvis(V(t0.x, t0.y, 0), qYaw(t0.yaw)); rag.setPoseTarget({}); rag.snapToPose();
  const h0 = rag.bodyPos('Hips');
  const rel = RAG_NAMES.map((n) => { const p = rag.bodyPos(n); return V(p[0] - h0[0], p[1] - h0[1], p[2] - h0[2]); });
  // Torso после КАЖДОГО шага Jolt (в кадре их 0..4) — дрожь меряется по шагам физики, а не по кадрам
  const torso: { t: number; p: number[] }[] = [];
  const js = pw.jolt.Step.bind(pw.jolt); let clock = 0;
  (pw.jolt as unknown as { Step: (h: number, c: number) => void }).Step = (h: number, c: number): void => { js(h, c); clock += h; torso.push({ t: clock, p: rag.bodyPos('Torso') }); };
  return { pw, rag, torso, rel, pins: RAG_NAMES.map(() => null) };
}
function close(w: World): void { w.rag.dispose(); jolt().destroy(w.pw.jolt); }
/** Кадр куклы, как в gamePlayerDoll: таз + пины на мир-позиции цели → update(dt апдейта). */
function feed(w: World, tg: Tgt, dt: number): void {
  const q = qYaw(tg.yaw), c = V(tg.x, tg.y, 0);
  w.rag.setPelvis(c, q); w.rag.setPoseTarget({});
  for (let i = 1; i < w.rel.length; i++) w.pins[i] = w.rel[i]!.clone().applyQuaternion(q).add(c);
  w.rag.setPinTargets(w.pins);
  w.rag.update(dt);
}
function stepWorld(w: World, mode: Mode, dt: number): void {
  if (mode === 'advance') w.pw.advance(dt);                 // игра (online3d)
  else if (mode === 'step') w.pw.step(Math.min(dt, PHYS_H)); // редактор поз сейчас
  else w.pw.stepFrame(dt);                                  // редактор поз — кадр целиком
}
const hips = (w: World): number[] => w.rag.bodyPos('Hips');
/** RMS второй разности позиции по шагам (u/с²) после `from` с. */
function accRms(s: { t: number; p: number[] }[], from: number): number {
  let sum = 0, n = 0;
  for (let k = 1; k + 1 < s.length; k++) {
    if (s[k - 1]!.t < from) continue;
    const h1 = s[k]!.t - s[k - 1]!.t, h2 = s[k + 1]!.t - s[k]!.t;
    for (let c = 0; c < 3; c++) { const a = ((s[k + 1]!.p[c]! - s[k]!.p[c]!) / h2 - (s[k]!.p[c]! - s[k - 1]!.p[c]!) / h1) / ((h1 + h2) / 2); sum += a * a; }
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
}
/** Прогон: цель во времени, кадры `dts`, апдейт куклы каждые `stride` кадров (temporal-LOD). → макс. |таз − последняя цель| после `from` с. */
function drive(w: World, tgAt: (t: number) => Tgt, dts: number[], mode: Mode, from: number, stride = 1): number {
  let T = 0, acc = 0, err = 0, frame = 0, last = tgAt(0);
  for (const dt of dts) {
    T += dt; acc += dt; frame++;
    if (frame % stride === 0) { last = tgAt(T); feed(w, last, acc); acc = 0; }
    stepWorld(w, mode, dt);
    if (T >= from) { const p = hips(w); const e = Math.hypot(p[0]! - last.x, p[1]! - last.y, p[2]!); err = Number.isFinite(e) ? Math.max(err, e) : Infinity; }
  }
  return err;
}
const run = (t: number): Tgt => ({ x: RUN_V * t, y: Y0 + 2 * Math.sin(2 * Math.PI * 2 * t), yaw: t });

/**
 * Кадр ИГРЫ целиком, в её порядке: кукла (`update`) → призрак (`renderRagdollGhost`, бленд 0.85 как `DEFAULT_MATCH`) →
 * `pw.advance`. Меряем то, что видит игрок относительно камеры (она идёт за целью): смену смещения нарисованного
 * таза от цели за кадр (u, RMS) и рывок кисти — разность её скорости относительно цели за кадр, в долях 1/60 с (u, RMS).
 */
function drawRun(w: World, tgAt: (t: number) => Tgt, dts: number[], from: number): { root: number; hand: number } {
  const mesh = buildHumanoid({ style: 'skeleton' }); mesh.reset();
  const rest = mesh.readPose(), gs = newGhostGround();
  const hp = V(), hd = V();
  let T = 0, prevOff: THREE.Vector3 | null = null, prevRel: THREE.Vector3 | null = null, prevV: THREE.Vector3 | null = null;
  const root: number[] = [], hand: number[] = [];
  for (const dt of dts) {
    T += dt;
    const tg = tgAt(T);
    feed(w, tg, dt);
    renderRagdollGhost(mesh, w.rag, gs, dt, 0, true, { ...rest, Hips: [0, tg.yaw, 0] }, 0.85, undefined, [true, true], true);
    mesh.hips.getWorldPosition(hp); mesh.bones.get('RightHand')!.getWorldPosition(hd);
    w.pw.advance(dt);
    if (T < from) continue;
    const off = V(hp.x - tg.x, 0, hp.z);
    if (prevOff) root.push(off.distanceTo(prevOff));
    prevOff = off;
    const rel = V(hd.x - tg.x, hd.y - tg.y, hd.z);
    if (prevRel) { const v = rel.clone().sub(prevRel).divideScalar(dt); if (prevV) hand.push(v.distanceTo(prevV) / 60); prevV = v; }
    prevRel = rel;
  }
  const rms = (a: number[]): number => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));
  return { root: rms(root), hand: rms(hand) };
}

beforeAll(async () => { await initPhysics(); });

describe('PhysWorld: kinematic-таз куклы ведётся длиной ШАГА, а не кадра (живой Jolt)', () => {
  it('игра: скачок цели +5u — ни раскачки (120 Гц), ни разноса (144/165/240 Гц)', () => {
    for (const hz of [120, 144, 165, 240]) {
      const w = world({ x: 0, y: Y0, yaw: 0 });
      const err = drive(w, (t) => ({ x: 0, y: t < 1 ? Y0 : Y0 + 5, yaw: 0 }), frames(hz, 2), 'advance', 1.5);
      close(w);
      expect(err, `${hz} Гц: |таз − цель| через 0.5 с после скачка`).toBeLessThan(0.05);   // было 5.00 / 2.9e9 / ∞ / ∞
    }
  });

  it('игра: бег 300 u/с — таз не дальше шага от цели, торс без рывков на любой частоте кадра', () => {
    const cases: [string, number[], number, number][] = [   // имя, кадры, stride апдейта, допуск ошибки таза
      ['30 Гц', frames(30, 2.5), 1, 0.1], ['45 Гц', frames(45, 2.5), 1, 5.5], ['60 Гц ±2 мс', frames(60, 2.5, 2), 1, 5.5],
      ['90 Гц', frames(90, 2.5), 1, 5.5], ['144 Гц', frames(144, 2.5), 1, 5.5], ['165 Гц', frames(165, 2.5), 1, 5.5],
      ['60 Гц, апдейт через кадр', frames(60, 2.5), 2, 5.5],
    ];
    for (const [name, dts, stride, tol] of cases) {
      const w = world(run(0));
      const err = drive(w, run, dts, 'advance', 0.3, stride);
      const acc = accRms(w.torso, 0.3);
      close(w);
      expect(err, `${name}: |таз − цель|`).toBeLessThan(tol);
      expect(acc, `${name}: дрожь торса, u/с²`).toBeLessThan(1000);   // сейчас 225–524; старый код 10 047…∞, «держать» 5 997…31 150
    }
  });

  it('игра: корень призрака — из цели таза: без лесенки шагов на 120/144 Гц и рваных 60, и в повороте тоже', () => {
    const turn = (t: number): Tgt => ({ x: 0, y: Y0, yaw: 4 * t });
    const cases: [string, number[]][] = [['120 Гц', frames(120, 1.5)], ['144 Гц', frames(144, 1.5)], ['60 Гц ±2 мс', frames(60, 1.5, 2)]];
    for (const [name, dts] of cases) {
      const a = world(run(0));
      const r = drawRun(a, run, dts, 0.5);
      close(a);
      // корень из ТЕЛА таза: 2.50 / 2.47 / 3.92u — игра рисует до шага, тело двигается только в кадрах с шагом
      expect(r.root, `${name}, бег 300 u/с: смена смещения корня от цели за кадр`).toBeLessThan(0.01);
      const b = world(turn(0));
      const t = drawRun(b, turn, dts, 0.5);
      close(b);
      // поворот таза из ТЕЛА (позиция из цели): 0.62 / 0.68 / 0.47u; из цели — 0.07 / 0.06 / 0.14u
      expect(t.hand, `${name}, разворот 4 рад/с: рывок кисти`).toBeLessThan(0.25);
    }
  });

  it('смерть / окно-culling: цели таза нет — корень призрака рисуется из тела', () => {
    const w = world({ x: 0, y: Y0, yaw: 0 });
    drive(w, () => ({ x: 0, y: Y0, yaw: 0 }), frames(60, 0.3), 'advance', 1);
    expect(w.rag.pelvisTarget(), 'жив, таз ведёт мир').not.toBeNull();
    w.rag.setPinTargets(RAG_NAMES.map(() => null)); w.rag.setPelvis(V(0, 200, 0), qYaw(0)); w.rag.update(1 / 60);   // последняя цель — высоко
    w.rag.setDead(true);
    for (let i = 0; i < 20; i++) { w.rag.update(1 / 60); w.pw.advance(1 / 60); }
    expect(w.rag.pelvisTarget(), 'мёртв').toBeNull();
    const mesh = buildHumanoid({ style: 'skeleton' });
    renderRagdollGhost(mesh, w.rag, newGhostGround(), 1 / 60, 0, false);
    const hp = mesh.hips.getWorldPosition(V()), b = hips(w);
    expect(Math.hypot(hp.x - b[0]!, hp.y - b[1]!, hp.z - b[2]!), 'корень = падающее тело, а не цель 200').toBeLessThan(1e-3);
    w.rag.setDead(false);                                            // конец нокдауна: таз держится там, где лежит
    const pt = w.rag.pelvisTarget();
    expect(pt && Math.hypot(pt.p.x - b[0]!, pt.p.y - b[1]!, pt.p.z - b[2]!), 'оживлён — цель = место тела').toBeLessThan(1e-3);
    w.rag.setSimEnabled(false);
    expect(w.rag.pelvisTarget(), 'вынут из мира').toBeNull();
    close(w);
  });

  it('редактор: таз на цели ПОСЛЕ шага и ниже 60 fps; кадр подшагами — ещё и без рывков', () => {
    for (const hz of [30, 45, 144]) {
      const a = world(run(0));
      const errStep = drive(a, run, frames(hz, 2), 'step', 0.3);   // step(min(dt, 1/60)) — как сейчас в pose-editor
      close(a);
      expect(errStep, `step, ${hz} fps`).toBeLessThan(0.01);      // было 10.03u на 30 fps, 2.23u на 45
      const b = world(run(0));
      const errFrame = drive(b, run, frames(hz, 2), 'stepFrame', 0.3);
      const acc = accRms(b.torso, 0.3);
      close(b);
      expect(errFrame, `stepFrame, ${hz} fps`).toBeLessThan(0.01);
      expect(acc, `stepFrame, ${hz} fps: дрожь торса`).toBeLessThan(1000);   // 30 fps: 522 (подшаги «держать» дали бы ~31 000)
    }
  });

  it('смерть: привод отпущен — труп не тянет к последней цели таза', () => {
    const w = world({ x: 0, y: Y0, yaw: 0 });
    drive(w, () => ({ x: 0, y: Y0, yaw: 0 }), frames(60, 0.3), 'advance', 1);
    // последняя цель таза — высоко над полом (без пинов: их импульсы к высоким целям подбросили бы тело сами)
    w.rag.setPinTargets(RAG_NAMES.map(() => null)); w.rag.setPelvis(V(0, 200, 0), qYaw(0)); w.rag.update(1 / 60);
    w.rag.setDead(true);                          // в том же кадре — умер
    for (let i = 0; i < 30; i++) { w.rag.update(1 / 60); w.pw.advance(1 / 60); }   // мёртвая кукла тоже апдейтится (gamePlayerDoll)
    const y = hips(w)[1]!;
    close(w);
    expect(y).toBeLessThan(Y0 + 0.5);            // падает, а не летит к 200 (без release — 142.6 за 30 шагов)
  });

  it('оживление без update в кадре: таз стоит, скорость падения не наследуется', () => {
    const w = world({ x: 0, y: Y0, yaw: 0 });
    drive(w, () => ({ x: 0, y: Y0, yaw: 0 }), frames(60, 0.3), 'advance', 1);
    w.rag.setDead(true);
    w.rag.hit('Hips', 1, 0, 0, 3);                                     // толчок: у таза реальная скорость
    for (let i = 0; i < 4; i++) { w.rag.update(1 / 60); w.pw.advance(1 / 60); }
    w.rag.setDead(false);                                              // как конец нокдауна: без update в этом кадре
    const p0 = hips(w);
    for (let i = 0; i < 20; i++) w.pw.advance(1 / 60);
    const p1 = hips(w);
    close(w);
    expect(Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!)).toBeLessThan(0.01);
  });

  it('snapToPose: таз остаётся в новой точке, а не едет к цели прошлого update', () => {
    const w = world({ x: 0, y: Y0, yaw: 0 });
    drive(w, () => ({ x: 0, y: Y0, yaw: 0 }), frames(60, 0.3), 'advance', 1);
    w.rag.setPelvis(V(500, Y0, 0), qYaw(0)); w.rag.snapToPose();   // скачок корня БЕЗ update (редактор / хит-реакция)
    for (let i = 0; i < 10; i++) w.pw.advance(1 / 60);
    const x = hips(w)[0]!;
    close(w);
    expect(Math.abs(x - 500)).toBeLessThan(0.01);
  });

  it('окно-culling: вынутое тело мир не ведёт; вернули — стоит до update', () => {
    const w = world({ x: 0, y: Y0, yaw: 0 });
    drive(w, () => ({ x: 0, y: Y0, yaw: 0 }), frames(60, 0.3), 'advance', 1);
    feed(w, { x: 100, y: Y0, yaw: 0 }, 1 / 60);
    w.rag.setSimEnabled(false);                                    // усыпили в том же кадре — цель не отработана
    for (let i = 0; i < 10; i++) w.pw.advance(1 / 60);
    w.rag.setSimEnabled(true);
    for (let i = 0; i < 5; i++) w.pw.advance(1 / 60);
    const x = hips(w)[0]!;
    close(w);
    expect(Math.abs(x)).toBeLessThan(0.01);                        // старая цель (100) не подхвачена
  });

  it('dispose снимает привод с мира: вторая кукла ведётся дальше', () => {
    const w = world({ x: 0, y: Y0, yaw: 0 });
    const other = makeHumanoidRagdoll(w.pw);
    other.setPelvis(V(0, Y0, 50), qYaw(0)); other.setPoseTarget({}); other.snapToPose();
    expect((w.pw as unknown as { kin: unknown[] }).kin.length).toBe(2);
    other.dispose();
    expect((w.pw as unknown as { kin: unknown[] }).kin.length).toBe(1);
    const err = drive(w, run, frames(60, 0.5), 'advance', 0.3);
    close(w);
    expect(err).toBeLessThan(0.1);
  });
});
