import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// env3d тянет DOM/GLTFLoader — физмиру от него нужна только высота стены (как в kinematicDrive.test.ts).
vi.mock('./env3d.js', () => ({ WALL_H: 96 }));

import { initPhysics, PhysWorld, jolt, type RagdollHandle } from './ragdoll.js';
import type { HumanoidRagdoll } from './humanoidRagdoll.js';
import type { Humanoid } from './humanoid.js';
import { makeHumanoidDoll } from './gamePlayerDoll.js';
import { driveActor, type DriveState } from './driveActor.js';
import { cullActor, type CullActor } from './windowCull.js';
import { corpseStart, collapseCorpses, type Corpse } from './corpseCollapse.js';

/**
 * СТОРОЖ ОКНО-CULLING'а (живой Jolt, кукла монстра целиком, КАДР `online3d` целиком: `cullActor` → `driveActor` →
 * `collapseCorpses` → `pw.advance`).
 *
 * Ошибка: нокдаун спящей куклы. Событие `knockdown` будило куклу (`simEnabled = true`), а `a.dormant` у клиента
 * оставался true — и луп монстров её больше не вёл: часы нокдауна стояли, тела лежали в `pw.step` за окном, смерть без
 * удара (DoT) падала с места нокдауна. ЗАМЕР старого кода на этих же сценариях (сбит спящим за окном; физ / kinematic,
 * 60 / 144 Гц): труп запечён в **634–639u** от точки смерти (стало 4.9–9.6u), тела двигались в физике во сне
 * **73–91 кадр** (стало 0), а вернувшись в окно, кукла ЛОЖИЛАСЬ и доигрывала нокдаун на глазах — **70 / 169 кадров**
 * после того, как сервер её поднял (стало 0).
 *
 * Теперь один инвариант: `a.dormant` === «кукла спит», сон снимают только окно (`cullActor`) и смерть (`corpseStart`);
 * нокдаун спящую не будит (`fallPending` в кукле), а часы ей крутит `update(dt)` из `cullActor`.
 */
const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
const frames = (hz: number, dur: number): number[] => Array.from({ length: Math.round(dur * hz) }, () => 1 / hz);
const WIN_R = 400, WIN_HYST = 140;      // окно вокруг игрока (полуширина) и полоса гистерезиса — как в `online3d`
const WAKE_BUDGET = 3;                  // пробуждений за кадр — как в `online3d`
const DOWN_SEC = 1.1, RISE_SEC = 0.8;   // длительности нокдауна из `balance.knockdown`
const LYING = 30;                       // голова меша: лёжа 5–8u, стоя 56.2u

type Mode = 'physics' | 'kinematic';
interface Act extends DriveState, Corpse, CullActor { d: RagdollHandle }
interface Mon { pw: PhysWorld; d: RagdollHandle; solid: Humanoid; rag: HumanoidRagdoll; a: Act; actors: Map<number, Act> }

function monster(mode: Mode): Mon {
  const pw = new PhysWorld(); pw.addGround(6000);
  const d = makeHumanoidDoll(pw, { x: 0, z: 0, weapon: 'none', gaitId: 'monster', gaitFallback: 'warrior' });
  if (mode === 'kinematic') d.setPhysicsMode?.('kinematic');   // физ-LOD дальних: тела вон из `pw.step`, рисуем из позы
  const g = d._dbg as { solid: Humanoid; ragdoll: HumanoidRagdoll };
  const a: Act = { d, vx: 0, vz: 0, lx: 0, lz: 0 };
  return { pw, d, solid: g.solid, rag: g.ragdoll, a, actors: new Map([[1, a]]) };
}
const boneAt = (h: Humanoid, b: string): THREE.Vector3 => { h.root.updateMatrixWorld(true); return h.bones.get(b)!.getWorldPosition(V()); };

/** Сценарий: где игрок и где монстр (сервер) во времени + когда сбит с ног и когда убит. */
interface Scen { dur: number; px: (t: number) => number; mx: (t: number) => number; knockAt?: number; dieAt?: number }
interface Out {
  lateLying: number;    // кадров, где меш ЛЕЖИТ в окне уже после серверного подъёма (было 70 / 169)
  downLying: number;    // кадров, где меш лежит в окне во время нокдауна (нокдаун реально показан)
  physFrames: number;   // кадров, где тело таза двигалось, пока кукла СПИТ — тела обязаны быть вне `pw.step` (было 73–91)
  baked: { head: number; off: number } | null;   // запечённый труп: голова (лежит?) и таз от точки смерти
}

/**
 * Кадр `online3d` целиком: окно-culling живого (`cullActor` + `driveActor`), коллапс-луп трупов (`collapseCorpses`),
 * шаг физики. Возвращает замеры сценария.
 */
function run(mode: Mode, hz: number, s: Scen): Out {
  const m = monster(mode);
  const wake = { wake: 0 };
  const out: Out = { lateLying: 0, downLying: 0, physFrames: 0, baked: null };
  const knockEnd = (s.knockAt ?? -1) + DOWN_SEC + RISE_SEC;
  let T = 0, deathX = NaN, deathZ = 0, prevBody: number[] | null = null;
  for (const dt of frames(hz, s.dur)) {
    T += dt;
    const px = s.px(T), mx = s.mx(T), vx = (mx - s.mx(T - dt)) / dt;
    if (s.knockAt != null && T >= s.knockAt && T - dt < s.knockAt) {
      // Событие `knockdown` из `online3d`: спящую куклу НЕ будим и `dormant` не трогаем (сон снимают только окно и смерть).
      m.a.d.knockdown?.(1, 0, DOWN_SEC, RISE_SEC);
    }
    if (s.dieAt != null && T >= s.dieAt && T - dt < s.dieAt) { deathX = mx; corpseStart(m.a); }   // `markDead`
    // ── кадр: живой монстр ───────────────────────────────────────────────────
    const dist = Math.abs(mx - px);
    const inWin = dist <= WIN_R, inBand = dist <= WIN_R + WIN_HYST;
    wake.wake = WAKE_BUDGET;
    if (m.a.dead == null) {
      const active = cullActor(m.a, inWin, inBand, dt, wake);
      driveActor(m.a, mx, 0, 0, true, dt, { doUpdate: active, vel: { x: vx, z: 0 } });
    }
    // ── кадр: трупы ──────────────────────────────────────────────────────────
    collapseCorpses(m.actors, dt, () => inWin, (id, a) => {
      const hd = boneAt(m.solid, 'Head'), hp = boneAt(m.solid, 'Hips');
      out.baked = { head: hd.y, off: Math.hypot(hp.x - deathX, hp.z - deathZ) };
      m.actors.delete(id); void a;
      return true;
    });
    m.pw.advance(dt);
    // ── замеры ───────────────────────────────────────────────────────────────
    const body = m.rag.bodyPos('Hips');
    if (m.a.dormant && prevBody && Math.hypot(body[0]! - prevBody[0]!, body[1]! - prevBody[1]!, body[2]! - prevBody[2]!) > 0.05) out.physFrames++;
    prevBody = body;
    if (m.a.dead == null && inWin && !m.a.dormant) {
      const head = boneAt(m.solid, 'Head').y;
      if (head < LYING) { if (T > knockEnd + 0.35) out.lateLying++; else if (s.knockAt != null && T >= s.knockAt) out.downLying++; }
    }
    if (out.baked) break;
  }
  m.d.dispose(); jolt().destroy(m.pw.jolt);
  return out;
}

beforeAll(async () => { await initPhysics(); });

describe('окно-culling: нокдаун спящего монстра (кадр `online3d` целиком, живой Jolt)', () => {
  it('сбит за окном — часы идут во сне: вернулся в окно уже СТОЯЩИМ (и тела не крутятся в физике)', () => {
    for (const mode of ['physics', 'kinematic'] as const) for (const hz of [60, 144]) {
      // Ушёл за окно (x > 540 от игрока) → уснул → сбит с ног спящим (2.0 с) → сервер держит его 1.9 с → идёт назад,
      // в окно (4.9 с). Без часов во сне кукла просыпалась лежащей и доигрывала нокдаун на глазах.
      const o = run(mode, hz, {
        dur: 6, knockAt: 2, px: () => 0,
        mx: (t) => (t <= 2 ? 300 * t : t <= 3.9 ? 600 : Math.max(200, 600 - 300 * (t - 3.9))),
      });
      expect(o.lateLying, `${mode}, ${hz} Гц: кадров лёжа в окне после серверного подъёма`).toBe(0);   // было 70 / 169
      expect(o.physFrames, `${mode}, ${hz} Гц: кадров с движением тел во сне`).toBe(0);                // было 73–91
    }
  });

  it('вернулся в окно ПОСРЕДИ нокдауна и снова ушёл: падение показано, подъём — в фазе сервера', () => {
    for (const mode of ['physics', 'kinematic'] as const) for (const hz of [60, 144]) {
      // Сбит спящим (2.0 с); игрок подошёл (2.3–2.8) — монстр в окне, ЛЕЖИТ; игрок отошёл (3.2–3.7) — снова сон в
      // середине подъёма; вернулся (4.4–4.9) — монстр обязан уже СТОЯТЬ (сервер поднял его в 3.9 с).
      const o = run(mode, hz, {
        dur: 6, knockAt: 2, mx: (t) => (t <= 2 ? 300 * t : 600),
        px: (t) => (t <= 2.3 ? 0 : t <= 2.8 ? 600 * (t - 2.3) : t <= 3.2 ? 300 : t <= 3.7 ? 300 - 600 * (t - 3.2) : t <= 4.4 ? 0 : Math.min(300, 600 * (t - 4.4))),
      });
      expect(o.downLying, `${mode}, ${hz} Гц: кадров лёжа в окне во время нокдауна`).toBeGreaterThan(5);
      expect(o.lateLying, `${mode}, ${hz} Гц: кадров лёжа в окне после серверного подъёма`).toBe(0);
    }
  });

  it('⭐ нокдаун за окном → подъём → ушёл на 600u → смерть: труп печётся ЛЁЖА у монстра (за окном и в окне)', () => {
    for (const where of ['смерть за окном', 'смерть в окне'] as const) for (const mode of ['physics', 'kinematic'] as const) for (const hz of [60, 144]) {
      // Сбит спящим (2.0), сервер поднял (3.9), монстр ушёл ещё на 600u и умер (5.9) — за окном или в окне (игрок
      // догнал его к 4.6 с и до смерти видит идущим).
      const inWin = where === 'смерть в окне';
      const o = run(mode, hz, {
        dur: 8, knockAt: 2, dieAt: 5.9,
        mx: (t) => (t <= 2 ? 300 * t : t <= 3.9 ? 600 : 600 + 300 * (t - 3.9)),
        px: (t) => (inWin && t > 4 ? 700 * (t - 4) : 0),
      });
      expect(o.baked, `${where}, ${mode}, ${hz} Гц: труп запечён`).not.toBeNull();
      expect(o.lateLying, `${where}, ${mode}, ${hz} Гц: кадров лёжа в окне после серверного подъёма`).toBe(0);   // было 70 / 169
      expect(o.physFrames, `${where}, ${mode}, ${hz} Гц: кадров с движением тел во сне`).toBe(0);                // было 73–91
      expect(o.baked!.head, `${where}, ${mode}, ${hz} Гц: голова запечённого меша`).toBeLessThan(LYING);         // 5.4–8.3u (стоя 56.2u)
      // Труп, убитый ЗА окном, падает у монстра (старым кодом — в 634–639u от точки смерти). В окне он умирает на бегу и скользит по
      // инерции (285u при 300 u/с) — так было и до правки: тела живого монстра идут со скоростью бега.
      if (!inWin) expect(o.baked!.off, `${where}, ${mode}, ${hz} Гц: таз меша от точки смерти`).toBeLessThan(40);   // 4.9–9.6u; было 634–639u
    }
  });

  it('бюджет пробуждений, сон за полосой и часы спящего (пачка из 8 — без физики, чистая логика шва)', () => {
    const log: string[] = [];
    const mk = (i: number): CullActor => ({ d: { update: () => log.push(`u${i}`), setSimEnabled: (on) => log.push(`${on ? 'on' : 'off'}${i}`) }, dormant: true });
    const acts = Array.from({ length: 8 }, (_, i) => mk(i));
    const frame = (inWin: boolean, inBand: boolean): number => {
      const budget = { wake: WAKE_BUDGET };
      let n = 0;
      for (const a of acts) if (cullActor(a, inWin, inBand, 1 / 60, budget)) n++;
      return n;
    };
    const woke = [frame(true, true), frame(true, true), frame(true, true), frame(true, true)];
    expect(woke, 'проснувшихся по кадрам').toEqual([3, 6, 8, 8]);   // без бюджета — 8 в первый же кадр
    log.length = 0;
    expect(frame(false, true), 'в полосе гистерезиса бодрствующий не засыпает').toBe(8);
    expect(log, 'в полосе — ни сна, ни лишних `update`').toEqual([]);
    expect(frame(false, false), 'вышли за полосу — все спят').toBe(0);
    expect(log.filter((s) => s.startsWith('off')).length, 'усыплены все').toBe(8);
    expect(log.filter((s) => s.startsWith('u')).length, '⭐ спящему крутятся часы нокдауна').toBe(8);
  });

  it('⭐ луп монстров `online3d` решает сон/пробуждение через `cullActor`, а трупы — через `collapseCorpses`', () => {
    const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'online3d.ts'), 'utf8');
    expect(SRC).toMatch(/const active = cullActor\(a, inWin, inBand, dt, wakeBudget\);/);
    expect(SRC, 'бюджет пробуждений заводится ДО лупа монстров, а не на монстра').toMatch(/wakeBudget\.wake = WAKE_BUDGET;[\s\S]{0,400}?for \(const mv of latest\.monsters\)/);
    expect(SRC, 'старый инлайн-culling вернулся').not.toMatch(/a\.dormant = false; a\.d\.setSimEnabled\?\.\(true\)/);
    expect(SRC, 'нокдаун снова трогает `dormant` мимо шва').not.toMatch(/knockdown\?\.\([\s\S]{0,200}?dormant/);
  });
});
