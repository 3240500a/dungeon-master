/** ВРЕМЕННЫЙ ЗОНД (удалить). Проверка утверждения о скольжении правой стопы в walk_strafe_R. */
import { describe, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { openBakeSource, bakeFromSource, type BakeSource } from './clipBaker.js';
import { buildHumanoid } from './humanoid.js';
import { poseRig } from './frameEdit.js';
import { clipPoseAt, clipChannelAt, ROOT_POS, type Clip } from './clipModel.js';

const DIR = 'C:/work/Games_Art/Games_Art/top_down/dungeon/Assets/MovementAnimsetPro/Animations';
const CM2U = 32 / 100;   // источник в СМ (травел 172.45 см/с = 55.2 наших ед/с), TILE = 32 u = 1 м
const FPS = 60;

let cache: BakeSource[] | null = null;
async function openAll(): Promise<BakeSource[]> {
  if (cache) return cache;
  (globalThis as any).window ??= { innerWidth: 1920, innerHeight: 1080 };
  const files = readdirSync(DIR).filter((x) => x.toLowerCase().endsWith('.fbx')).sort();
  const warn = console.warn; console.warn = (): void => {};
  const out: BakeSource[] = [];
  for (const f of files) { const buf = readFileSync(path.join(DIR, f)); out.push(await openBakeSource(new File([buf as unknown as BlobPart], f))); }
  console.warn = warn;
  cache = out; return out;
}
async function find(take: string): Promise<{ src: BakeSource; i: number }> {
  for (const src of await openAll()) { const i = src.animations.findIndex((a) => a.name === take); if (i >= 0) return { src, i }; }
  throw new Error('нет тейка ' + take);
}

interface Frames { ank: THREE.Vector3[]; ball: THREE.Vector3[]; tip: THREE.Vector3[]; mat: THREE.Matrix4[] }
const mkF = (): Frames => ({ ank: [], ball: [], tip: [], mat: [] });
const hyp = (a: THREE.Vector3, b: THREE.Vector3): number => Math.hypot(b.x - a.x, b.z - a.z);
/** Скорость стопы как ЖЁСТКОГО ТЕЛА: максимум по трём суставам (мировой шаг за кадр). */
function speeds(f: Frames): number[] {
  const s = [0];
  for (let i = 1; i < f.ank.length; i++) s.push(Math.max(hyp(f.ank[i - 1]!, f.ank[i]!), hyp(f.ball[i - 1]!, f.ball[i]!), hyp(f.tip[i - 1]!, f.tip[i]!)));
  return s;
}

/** Точки подошвы в ЛОКАЛИ кости стопы — калибровка по НАСТОЯЩЕЙ плоской ОПОРЕ (стопа стоит и ниже всего). */
function calibSole(f: Frames, back: number, stillMax: number): { sole: THREE.Vector3[]; iFlat: number } {
  const sp = speeds(f);
  let iFlat = -1;
  for (let i = 1; i < f.ank.length; i++) if (sp[i]! < stillMax && (iFlat < 0 || f.ank[i]!.y < f.ank[iFlat]!.y)) iFlat = i;
  if (iFlat < 0) throw new Error('нет неподвижного кадра для калибровки');
  const inv = f.mat[iFlat]!.clone().invert();
  const a = f.ank[iFlat]!, b = f.ball[iFlat]!, t = f.tip[iFlat]!;
  const fwd = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
  const w = [
    new THREE.Vector3(a.x - fwd.x * back, 0, a.z - fwd.z * back),
    new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(b.x, 0, b.z), new THREE.Vector3(t.x, 0, t.z),
  ];
  return { sole: w.map((p) => p.applyMatrix4(inv)), iFlat };
}

/** ⭐ СКОЛЬЖЕНИЕ = путь стопы по кадрам, где подошва КАСАЕТСЯ (просвет < thr) И стопа ЕДЕТ (шаг > move). */
function slide(f: Frames, sole: THREE.Vector3[], thr: number, move: number): { fr: number; path: number; maxCl: number } {
  const sp = speeds(f);
  const cl = f.mat.map((m) => Math.min(...sole.map((p) => p.clone().applyMatrix4(m).y)));
  let fr = 0, pathL = 0;
  for (let i = 1; i < f.ank.length; i++) if (cl[i]! < thr && cl[i - 1]! < thr && sp[i]! > move) { fr++; pathL += sp[i]!; }
  return { fr, path: pathL, maxCl: Math.max(...cl) };
}

// ── ИСТОЧНИК ──────────────────────────────────────────────────────────────────────────────────────
async function srcFrames(take: string): Promise<{ F: Record<'Left' | 'Right', Frames>; travel: number }> {
  const { src, i } = await find(take);
  src.restore();
  const byName = new Map<string, THREE.Object3D>();
  src.loaded.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  const g = (n: string): THREE.Object3D => byName.get(n)!;
  const anim = src.animations[i]!;
  const mixer = new THREE.AnimationMixer(src.root);
  const act = mixer.clipAction(anim); act.play(); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true;
  const F: Record<'Left' | 'Right', Frames> = { Left: mkF(), Right: mkF() };
  const h: THREE.Vector3[] = [];
  for (let t = 0; t <= anim.duration + 1e-9; t += 1 / FPS) {
    mixer.setTime(Math.min(t, anim.duration)); src.loaded.updateMatrixWorld(true);
    h.push(g('Hips').getWorldPosition(new THREE.Vector3()));
    for (const side of ['Left', 'Right'] as const) {
      const foot = g(side + 'Foot');
      F[side].ank.push(foot.getWorldPosition(new THREE.Vector3()));
      F[side].ball.push(g(side + 'ToeBase').getWorldPosition(new THREE.Vector3()));
      F[side].tip.push(g(side + 'ToeBase_END').getWorldPosition(new THREE.Vector3()));
      F[side].mat.push(foot.matrixWorld.clone());
    }
  }
  mixer.stopAllAction(); mixer.uncacheClip(anim); mixer.uncacheRoot(src.root); src.restore();
  return { F, travel: hyp(h[0]!, h[h.length - 1]!) };
}

// ── НАШ КЛИП ──────────────────────────────────────────────────────────────────────────────────────
async function ourFrames(take: string, name: string, ground: boolean): Promise<{ F: Record<'Left' | 'Right', Frames>; travel: number; clip: Clip }> {
  const { src, i } = await find(take);
  src.restore();
  const clip = bakeFromSource(src, {
    character: 'mocap', weapon: 'none', animationIndex: i, name, loop: true,
    locoSet: true, bakeId: 20260927, anchorIdle: false, fps: 60, epsDeg: 3,
    hips: 'full', ground, head: 'mocap', limbLock: { LF: false, RF: false },
    rootYaw: false, yawFromFeet: false, rootPos: true,
  }).clip;
  const H = buildHumanoid({});
  const F: Record<'Left' | 'Right', Frames> = { Left: mkF(), Right: mkF() };
  const n = Math.round(clip.keys[clip.keys.length - 1]!.t * FPS);
  const root: THREE.Vector3[] = [];
  for (let f = 0; f <= n; f++) {
    const t01 = f / n;
    poseRig(H, clipPoseAt(clip, t01)); H.root.updateMatrixWorld(true);
    const rp = clipChannelAt(clip, t01, ROOT_POS);
    const off = new THREE.Vector3(rp ? rp[0] : 0, 0, rp ? rp[2] : 0);
    root.push(off.clone());
    const shift = new THREE.Matrix4().makeTranslation(off.x, 0, off.z);
    for (const side of ['Left', 'Right'] as const) {
      const foot = H.bones.get(side + 'Foot')!, toes = H.bones.get(side + 'Toes')!;
      F[side].ank.push(foot.getWorldPosition(new THREE.Vector3()).add(off));
      F[side].ball.push(toes.getWorldPosition(new THREE.Vector3()).add(off));
      F[side].tip.push(new THREE.Vector3(0, 0, 2).applyMatrix4(toes.matrixWorld).add(off));
      F[side].mat.push(shift.clone().multiply(foot.matrixWorld));
    }
  }
  return { F, travel: hyp(root[0]!, root[root.length - 1]!), clip };
}

const PAIRS: [string, string][] = [
  ['StrafeLeftLoop', 'walk_strafe_R'], ['StrafeRightLoop', 'walk_strafe_L'],
  ['WalkFwdLoop', 'walk_fwd'], ['WalkBwdLoop', 'walk_back'],
  ['RunFwdLoop', 'run_fwd'], ['RunLtLoop', 'run_strafe_R'], ['RunRtLoop', 'run_strafe_L'],
];

describe('зонд: скольжение подошвы', () => {
  it('ИСТОЧНИК: подошва калибрована по WalkFwdLoop', async () => {
    const calib = await srcFrames('WalkFwdLoop');
    const sole: Record<'Left' | 'Right', THREE.Vector3[]> = { Left: [], Right: [] };
    for (const side of ['Left', 'Right'] as const) {
      const c = calibSole(calib.F[side], 5, 0.5);
      sole[side] = c.sole;
      console.log(`  калибровка ${side}: кадр ${c.iFlat}, лодыжка ${calib.F[side].ank[c.iFlat]!.y.toFixed(2)} см, плюсна ${calib.F[side].ball[c.iFlat]!.y.toFixed(2)}, носок ${calib.F[side].tip[c.iFlat]!.y.toFixed(2)}`);
    }
    for (const [take] of PAIRS) {
      const { F, travel } = await srcFrames(take);
      for (const side of ['Left', 'Right'] as const) {
        const f = F[side], sp = speeds(f);
        const cl = f.mat.map((m) => Math.min(...sole[side].map((p) => p.clone().applyMatrix4(m).y)));
        const line: string[] = [];
        for (const thr of [1, 2, 3]) {   // см: 1/2/3 см над полом
          const s = slide(f, sole[side], thr, 0.5);
          line.push(`<${thr}см: ${(s.path * CM2U).toFixed(2)} u (${(100 * s.path / travel).toFixed(0)}%, ${s.fr} кадр)`);
        }
        console.log(`  ${take.padEnd(16)} ${side === 'Left' ? 'Л' : 'П'}  травел ${(travel * CM2U).toFixed(1)} u | просвет ${(Math.min(...cl) * CM2U).toFixed(2)}…${(Math.max(...cl) * CM2U).toFixed(2)} u | скольжение ${line.join('  ')} | макс скорость ${(Math.max(...sp) * CM2U).toFixed(2)} u/кадр`);
      }
    }
  }, 300000);

  it('НАШ КЛИП: подошва = −1.5 u под лодыжкой (конвенция SOLE игры) + калибровка по walk_fwd', async () => {
    const cal = await ourFrames('WalkFwdLoop', 'walk_fwd', true);
    const calSole: Record<'Left' | 'Right', THREE.Vector3[]> = { Left: [], Right: [] };
    for (const side of ['Left', 'Right'] as const) {
      const c = calibSole(cal.F[side], 2.4, 0.15);
      calSole[side] = c.sole;
      console.log(`  калибровка ${side}: кадр ${c.iFlat}, лодыжка ${cal.F[side].ank[c.iFlat]!.y.toFixed(3)} u, плюсна ${cal.F[side].ball[c.iFlat]!.y.toFixed(3)}`);
    }
    const conv = [new THREE.Vector3(0, -1.5, -2.4), new THREE.Vector3(0, -1.5, 0), new THREE.Vector3(0, -1.5, 6), new THREE.Vector3(0, -1.5, 8)];
    for (const [take, name] of PAIRS) {
      const { F, travel, clip } = await ourFrames(take, name, true);
      for (const side of ['Left', 'Right'] as const) {
        const f = F[side], sp = speeds(f);
        const cl = f.mat.map((m) => Math.min(...conv.map((p) => p.clone().applyMatrix4(m).y)));
        const out: string[] = [];
        for (const [tag, s0] of [['конв', conv], ['калиб', calSole[side]]] as const) {
          const bits = [0.3, 0.6, 1.0].map((thr) => { const s = slide(f, s0 as THREE.Vector3[], thr, 0.15); return `<${thr}: ${s.path.toFixed(2)} u (${(100 * s.path / travel).toFixed(0)}%, ${s.fr})`; });
          out.push(`${tag} ${bits.join(' ')}`);
        }
        console.log(`  ${name.padEnd(14)} ${side === 'Left' ? 'Л' : 'П'} ключей ${clip.keys.length} травел ${travel.toFixed(1)} | просвет(конв) ${Math.min(...cl).toFixed(2)}…${Math.max(...cl).toFixed(2)} | ${out.join(' || ')}`);
      }
    }
  }, 300000);
});
