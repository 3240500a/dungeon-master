/**
 * ЗАПЕКАТЕЛЬ КЛИПОВ (Фаза 1, docs/ANIM_AI_RESEARCH.md ЧАСТЬ II): анимированный FBX/GLB/BVH → наш `Clip`.
 * Мост под мокап/AI-BVH (Mixamo, MDM и т.п.): loader (modelAssets) + обратный ретаргет (retarget3d.makeBakeRig) уже
 * есть — здесь только семплирование по кадрам + ПРОРЕЖИВАНИЕ в наши разрежённые ключи.
 *
 * Физика НЕ трогается: клип = поза-ЦЕЛЬ, рэгдолл догоняет её моторами (DriveToPoseUsingMotors) — как Puppet Master
 * (кинематическая цель + мышцы). Плотность ключей влияет только на редактируемость/размер, не на физику.
 *
 * Чистые функции (reduceKeyframes/poseReconstructError) — без loader'ов/DOM (тестируются в node). Оркестратор
 * bakeAnimationToClip тянет modelAssets ДИНАМИЧЕСКИ (FBXLoader тяжёлый, только в браузере-редакторе).
 */
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { makeBakeRig, autoBoneMap, OUR_BONES } from './retarget3d.js';
import type { Clip, Keyframe, Pose } from './poseRuntime.js';

const RAD2DEG = 180 / Math.PI;
const clonePose = (p: Pose): Pose => { const o: Pose = {}; for (const k in p) { const v = p[k]!; o[k] = [v[0], v[1], v[2]]; } return o; };
const cloneKey = (k: Keyframe): Keyframe => ({ t: k.t, pose: clonePose(k.pose) });
const readOurPose = (H: Humanoid): Pose => { const f = H.readPose(); const o: Pose = {}; for (const b of OUR_BONES) if (f[b]) o[b] = f[b]!; return o; };

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _ea = new THREE.Euler(), _eb = new THREE.Euler(), _ec = new THREE.Euler();
/** Макс. (по костям) угловая ошибка (°) slerp-реконструкции кадра `c` из соседних ключей `a`,`b`.
 *  Мера в углах КВАТЕРНИОНОВ (не эйлер-дельте) — так же, как интерполирует наш плеер (blendTwo slerp'ом). */
export function poseReconstructError(a: Keyframe, b: Keyframe, c: Keyframe): number {
  const span = b.t - a.t;
  const u = span > 1e-9 ? (c.t - a.t) / span : 0;
  let maxDeg = 0;
  for (const k in c.pose) {
    const pc = c.pose[k]!, pa = a.pose[k] ?? pc, pb = b.pose[k] ?? pc;
    _qa.setFromEuler(_ea.set(pa[0], pa[1], pa[2]));
    _qb.setFromEuler(_eb.set(pb[0], pb[1], pb[2]));
    _qa.slerp(_qb, u);                                           // реконструкция в момент c.t
    _qc.setFromEuler(_ec.set(pc[0], pc[1], pc[2]));
    const deg = _qa.angleTo(_qc) * RAD2DEG;
    if (deg > maxDeg) maxDeg = deg;
  }
  return maxDeg;
}

/** Прореживание плотного потока в разрежённые ключи (Ramer–Douglas–Peucker по позам). Оставляет кадр, только если
 *  без него slerp-реконструкция ошибётся > `epsDeg`. `epsDeg<=0` (или ≤2 кадра) → без прореживания (все кадры). */
export function reduceKeyframes(dense: Keyframe[], epsDeg: number): Keyframe[] {
  const n = dense.length;
  if (n <= 2 || epsDeg <= 0) return dense.map(cloneKey);
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const seg = stack.pop()!; const a = seg[0], b = seg[1];
    if (b - a < 2) continue;
    let worst = -1, worstErr = epsDeg;
    for (let i = a + 1; i < b; i++) {
      const e = poseReconstructError(dense[a]!, dense[b]!, dense[i]!);
      if (e > worstErr) { worstErr = e; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out: Keyframe[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(cloneKey(dense[i]!));
  return out;
}

export interface BakeOptions {
  character: string;
  weapon: string;
  animationIndex?: number;                       // какой клип из файла (по умолч. 0)
  fps?: number;                                  // частота семплирования (по умолч. 30)
  epsDeg?: number;                               // порог прореживания в °, 0 = все кадры (по умолч. 3)
  loop?: boolean;                                // цикл; не задан → эвристика по имени (walk/run/idle)
  boneMap?: Record<string, string>;              // ручная карта костей; не задана → autoBoneMap
  name?: string;                                 // имя клипа; не задано → имя анимации/файла
}
export interface BakeResult {
  clip: Clip;
  boneMap: Record<string, string>;
  frames: number;                                // сколько плотных кадров семплировано
  keys: number;                                  // сколько ключей после прореживания
  animations: string[];                          // имена всех анимаций файла (для выбора в UI)
}

/** Список имён анимаций в файле — для дропдауна в UI до запекания. */
export async function listAnimations(file: File): Promise<string[]> {
  const { loadAnimatedModelFile } = await import('./modelAssets.js');
  const { animations } = await loadAnimatedModelFile(file);
  return animations.map((a, i) => a.name || `anim ${i}`);
}

/** Запечь анимацию из файла в наш `Clip`. Оркестрация: загрузка → нормализация Y-up → autoBoneMap → семпл по кадрам
 *  (обратный ретаргет) → прореживание → сборка Clip (t от нуля). Root-motion (позиция таза) отбрасывается — наши
 *  клипы это ТОЛЬКО повороты костей (позицию держит игра/гейт), как Puppet Master отдаёт root motion контроллеру. */
export async function bakeAnimationToClip(file: File, opts: BakeOptions): Promise<BakeResult> {
  const { loadAnimatedModelFile, skeletonBoneNames } = await import('./modelAssets.js');
  const { root, animations } = await loadAnimatedModelFile(file);
  if (!animations.length) throw new Error('В файле нет анимаций (нужен FBX/GLB/BVH с треками).');
  const idx = Math.min(Math.max(0, opts.animationIndex ?? 0), animations.length - 1);
  const anim = animations[idx]!;

  // bind-поза → корректный restW (модель может прийти уже на кадре 0).
  root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
  root.updateMatrixWorld(true);

  const boneMap = opts.boneMap ?? autoBoneMap(skeletonBoneNames(root));

  // Нормализация Z-up→Y-up (CC/AccuRIG): обратный ретаргет наследует канон-фрейм нашего рига (Y-up/+Z).
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o); });
  if (byName.size === 0) root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  let loaded: THREE.Object3D = root;
  const hip = byName.get(boneMap['Hips'] ?? ''), head = byName.get(boneMap['Head'] ?? '');
  if (hip && head) {
    const ph = hip.getWorldPosition(new THREE.Vector3()), pd = head.getWorldPosition(new THREE.Vector3());
    if (Math.abs(pd.z - ph.z) > Math.abs(pd.y - ph.y)) { const wrap = new THREE.Group(); wrap.rotation.x = -Math.PI / 2; wrap.add(root); loaded = wrap; }
  }
  loaded.updateMatrixWorld(true);

  const bake = makeBakeRig(loaded, boneMap);
  const H = buildHumanoid();
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(anim); action.play();

  const fps = Math.max(1, opts.fps ?? 30), dt = 1 / fps, dur = anim.duration;
  const dense: Keyframe[] = [];
  for (let t = 0; t < dur + dt * 0.5; t += dt) {
    const tt = Math.min(t, dur);
    mixer.setTime(tt);
    loaded.updateMatrixWorld(true);
    bake.sampleInto(H);
    dense.push({ t: tt, pose: readOurPose(H) });
  }
  mixer.stopAllAction();

  const reduced = reduceKeyframes(dense, opts.epsDeg ?? 3);
  const t0 = reduced.length ? reduced[0]!.t : 0;
  const keys: Keyframe[] = reduced.map((k) => ({ t: +(k.t - t0).toFixed(4), pose: k.pose }));
  const loop = opts.loop ?? /walk|run|idle|цикл|loop|ход|бег/i.test(anim.name || '');
  const clip: Clip = {
    name: opts.name ?? (anim.name || file.name.replace(/\.[^.]+$/, '')),
    character: opts.character, weapon: opts.weapon, loop, keys,
  };
  return { clip, boneMap, frames: dense.length, keys: keys.length, animations: animations.map((a, i) => a.name || `anim ${i}`) };
}
