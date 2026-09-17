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
import { corpseStart, corpseFrame, collapseCorpses, CORPSE_FALL_SEC, type Corpse } from './corpseCollapse.js';

/**
 * СТОРОЖ ТРУПА (живой Jolt, кукла монстра целиком, привод `driveActor`, кадр трупа — настоящий `corpseFrame`, луп
 * кадра — настоящий `collapseCorpses` с ЕГО бюджетами: тесты бюджет НЕ подставляют, иначе мутация в константе прошла бы).
 * Ошибка: за окном коллапс-луп `online3d` сразу усыплял труп, а через 1.1 с `bakeCorpse` пёк ЗАМОРОЖЕННЫЙ меш — стоя,
 * там, где монстра усыпили. ЗАМЕР старого лупа (100 u/с; 60 / 144 Гц; голова стоящего меша 56.2u): убит за окном —
 * голова запечённого 55.5 / 55.4u, таз меша в 203 / 200u от точки смерти; умер в окне и через 0.2 с ушёл за окно —
 * голова 48.8 / 48.2u. Теперь 5.9 / 6.0u (таз в 16 / 15u) и 5.5 / 5.4u; эталон в окне 5.5 / 5.3u.
 */
const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
const frames = (hz: number, dur: number): number[] => Array.from({ length: Math.floor(dur * hz) }, () => 1 / hz);
const WALK = 100, LYING = 20;   // голова меша лёжа 5–7u, стоя 56u
const FALL = 3;                 // = `OFFSCREEN_FALL_BUDGET`; ЛИТЕРАЛ, а не константа модуля: иначе её мутация прошла бы

interface Act extends DriveState, Corpse { d: RagdollHandle }
interface Mon { pw: PhysWorld; d: RagdollHandle; solid: Humanoid; rag: HumanoidRagdoll; a: Act; x: number; z: number; deathX: number }
function monster(pw: PhysWorld, z = 0): Mon {
  const d = makeHumanoidDoll(pw, { x: 0, z, weapon: 'none', gaitId: 'monster', gaitFallback: 'warrior' });
  const g = d._dbg as { solid: Humanoid; ragdoll: HumanoidRagdoll };
  return { pw, d, solid: g.solid, rag: g.ragdoll, a: { d, vx: 0, vz: 0, lx: 0, lz: z }, x: 0, z, deathX: NaN };
}
const world = (): PhysWorld => { const pw = new PhysWorld(); pw.addGround(4000); return pw; };
const boneAt = (h: Humanoid, b: string): THREE.Vector3 => { h.root.updateMatrixWorld(true); return h.bones.get(b)!.getWorldPosition(V()); };
/** Живой кадр монстра, как в online3d: спит (`dormant`) — только дешёвые сеттеры. */
function walk(m: Mon, dt: number): void {
  m.x += WALK * dt;
  driveActor(m.a, m.x, m.z, 0, true, dt, { doUpdate: !m.a.dormant, vel: { x: WALK, z: 0 } });
}
/** Ушёл за окно — online3d усыпляет. */
function sleep(m: Mon): void { m.a.dormant = true; m.d.setSimEnabled!(false); }
/** `markDead` из online3d (`corpseStart` будит уснувшего и снимает `dormant`). */
function kill(m: Mon): void { m.deathX = m.x; corpseStart(m.a); }
/** Запечённый меш: голова (лежит?) и таз от точки смерти. */
function baked(m: Mon): { head: number; off: number } {
  const hd = boneAt(m.solid, 'Head'), hp = boneAt(m.solid, 'Hips');
  return { head: hd.y, off: Math.hypot(hp.x - m.deathX, hp.z - m.z) };
}

/** Масс-килл: N монстров, все умирают разом; кадры гонит НАСТОЯЩИЙ `collapseCorpses` (бюджеты — его собственные). */
function massKill(N: number, inWin: boolean, dur: number): { heads: number[]; bakeT: number[]; maxFalling: number; waitingHead: number; left: number } {
  const hz = 60;
  const pw = new PhysWorld(); pw.addGround(8000);
  const ms = Array.from({ length: N }, (_, i) => monster(pw, i * 100));
  const byId = new Map(ms.map((m, i) => [i, m]));
  const actors = new Map(ms.map((m, i) => [i, m.a]));
  for (const dt of frames(hz, 1)) { for (const m of ms) walk(m, dt); pw.advance(dt); }
  if (!inWin) { for (const m of ms) sleep(m); for (const dt of frames(hz, 1)) { for (const m of ms) walk(m, dt); pw.advance(dt); } }
  for (const m of ms) kill(m);
  const heads: number[] = [], bakeT: number[] = [];
  let maxFalling = 0, waitingHead = Infinity, T = 0;
  for (const dt of frames(hz, dur)) {
    T += dt;
    collapseCorpses(actors, dt, () => inWin, (id) => { const m = byId.get(id)!; heads.push(baked(m).head); bakeT.push(T); actors.delete(id); return true; });
    const left = [...actors.keys()].map((id) => byId.get(id)!);
    maxFalling = Math.max(maxFalling, left.filter((m) => !m.a.dormant).length);
    for (const m of left) if (m.a.dormant) waitingHead = Math.min(waitingHead, m.rag.bodyPos('Head')[1]!);
    pw.advance(dt);
    if (!actors.size) break;
  }
  const left = actors.size;
  for (const m of ms) m.d.dispose();
  jolt().destroy(pw.jolt);
  return { heads, bakeT, maxFalling, waitingHead, left };
}

beforeAll(async () => { await initPhysics(); });

describe('труп монстра: падение → запекание (`corpseFrame`, живой Jolt)', () => {
  it('убит за окном и там остался / умер в окне и ушёл за окно на лету — запекается ЛЁЖА, там, где умер', () => {
    for (const scen of ['убит за окном', 'ушёл за окно на лету'] as const) for (const hz of [60, 144]) {
      const pw = world(), m = monster(pw);
      let T = 0, inWin = true, out: { head: number; off: number } | null = null;
      const tDeath = scen === 'убит за окном' ? 3 : 1.5;
      for (const dt of frames(hz, 6)) {
        T += dt;
        if (m.a.dead == null) {
          if (scen === 'убит за окном' && T >= 1 && inWin) { inWin = false; sleep(m); }   // ушёл за окно живым, 2 с спит
          if (T >= tDeath) kill(m); else walk(m, dt);
        }
        if (m.a.dead != null) {
          if (scen === 'ушёл за окно на лету' && T >= tDeath + 0.2) inWin = false;
          if (corpseFrame(m.a, dt, inWin, { draw: 6, fall: FALL })) { out = baked(m); break; }
        }
        pw.advance(dt);
      }
      m.d.dispose(); jolt().destroy(pw.jolt);
      expect(out, `${scen}, ${hz} Гц: запёкся`).not.toBeNull();
      expect(out!.head, `${scen}, ${hz} Гц: голова запечённого меша`).toBeLessThan(LYING);   // было 55.5 / 55.4 (стоя) и 48.8 / 48.2 (на лету)
      if (scen === 'убит за окном') expect(out!.off, `${hz} Гц: таз меша от точки смерти`).toBeLessThan(40);   // было 203 / 200u
    }
  });

  it('масс-килл ЗА ОКНОМ: падают не больше `OFFSCREEN_FALL_BUDGET` разом, очередь ждёт СТОЯ (часы стоят) и тоже ложится', () => {
    // 8 трупов разом, очередь по 3: запекаются волнами на 1.1 / 2.2 / 3.3 с, все лёжа (голова 5.9–6.4u); ждущие — тела вне
    // мира, голова тела 50.6u (не падает). Без бюджета — все 8 в `pw.step` разом (падение трупа в node ~0.3 мс на кадр).
    const N = 8;
    const o = massKill(N, false, 5);
    expect(o.left, 'запеклись все').toBe(0);
    expect(o.maxFalling, 'за окном падают разом').toBeLessThanOrEqual(FALL);   // без бюджета (или бюджет на труп) — 8
    expect(Math.max(...o.heads), 'голова запечённых').toBeLessThan(LYING);     // часы очереди шли бы — 3..8 запеклись бы стоя
    expect(o.waitingHead, 'голова тела в очереди').toBeGreaterThan(40);        // ждёт вне мира, а не падает
    expect(Math.max(...o.bakeT), 'последняя волна').toBeGreaterThan(3 * CORPSE_FALL_SEC - 0.05);
  });

  it('⭐ масс-килл В ОКНЕ: очередь за окном не тратится — 8 трупов ложатся все и разом (1.1 с), никто не стоит замороженным', () => {
    // Очередь `budget.fall` — только для трупов ЗА окном: там задержки не видно. В окне падение видно, и трупы 4-й и
    // дальше не имеют права ждать: с `if (budget.fall-- <= 0)` (тратит бюджет и в окне) 5 из 8 замирали СТОЯ на экране
    // навсегда — часы им останавливались, `bakeCorpse` до них не доходил вовсе. Рисование сверх `COLLAPSE_BUDGET` = 6
    // пропускается (тело падает в `pw.step`), но перед запеканием кадр дорисовывается — потому лёжа все восемь.
    const N = 8;
    const o = massKill(N, true, 3);
    expect(o.left, 'запеклись все').toBe(0);                                      // с тратой бюджета в окне — 5 замороженных
    expect(Math.max(...o.heads), 'голова запечённых').toBeLessThan(LYING);
    expect(Math.max(...o.bakeT), 'последний запечён').toBeLessThan(CORPSE_FALL_SEC + 0.1);   // все на 1.1 с, волн нет
    expect(o.maxFalling, 'в окне падают все разом').toBe(N);
  });

  it('⭐ коллапс-луп `online3d` — это `collapseCorpses` (бюджеты кадра внутри него, проверены выше)', () => {
    const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'online3d.ts'), 'utf8');
    expect(SRC).toMatch(/collapseCorpses\(monsters, dt, corpseInWin, bakeMonsterCorpse\);/);
    expect(SRC, 'старое «труп вне окна → заморозить» вернулось').not.toMatch(/труп вне окна → заморозить/);
    expect(SRC, 'бюджеты кадра снова заводятся в клиенте').not.toMatch(/draw: COLLAPSE_BUDGET/);
    expect(SRC, 'смерть монстра идёт мимо `corpseStart` (а он снимает `dormant`)').toMatch(/const markDead = \(a: Actor\): void => \{ if \(corpseStart\(a\)/);
  });
});
