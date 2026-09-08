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
import { makeBakeRig, autoBoneMap, enforceTPose, FULL_AIM_CHILD, OUR_BONES, OUR_FINGERS, type BakeRig } from './retarget3d.js';
import { boneWeight, partWeight, setPartWeight, maskFromBody, hasPart, type BoneMask } from './boneMask.js';
import { rigSignature, isStaticBake, type ImportReport, type BakeStats } from './clipImport.js';
import { slerpEuler, setHipsOffset } from './clipModel.js';
import { groundBakeOffset } from './footIk.js';
import { detrendTravel, refPose, readLimbTarget, groundTargets, clampHipsToFeet, lockLimb, limbBones, LIMBS, type Vec3, type FootTarget, type LimbId } from './footLock.js';
import { applyHeadLookAt } from './poseRuntime.js';
import type { Clip, Keyframe, Pose } from './poseRuntime.js';

const RAD2DEG = 180 / Math.PI;
const clonePose = (p: Pose): Pose => { const o: Pose = {}; for (const k in p) { const v = p[k]!; o[k] = [v[0], v[1], v[2]]; } return o; };
const cloneKey = (k: Keyframe): Keyframe => ({ t: k.t, pose: clonePose(k.pose) });
/**
 * Снять позу НАШЕГО рига через МАСКУ (`boneMask.ts` — один тип на импорт/правку/рантайм).
 * Вес 1 — берём из мокапа, 0 — из базовой позы (`base`, бывший `idlePose`), между — slerp:
 * это и есть Blend Mask из Unreal, мягкий стык на границе зоны. Нет базовой позы → кость просто не попадает в клип
 * (её ведёт другой клип/гейт) — прежнее поведение.
 */
const _bwQ = new THREE.Quaternion(), _bwE = new THREE.Euler();
const readOurPose = (H: Humanoid, mask: BoneMask, base: Pose | undefined, fingers: boolean): Pose => {
  const f = H.readPose(); const o: Pose = {};
  const bones = fingers ? [...OUR_BONES, ...OUR_FINGERS] as string[] : OUR_BONES as readonly string[];
  for (const b of bones) {
    const w = boneWeight(mask, b);
    const src = f[b], bs = base?.[b];
    if (w >= 1) { if (src) o[b] = src; else if (bs) o[b] = [bs[0], bs[1], bs[2]]; }
    else if (w <= 0) { if (bs) o[b] = [bs[0], bs[1], bs[2]]; }
    else if (src && bs) { slerpEuler(_bwQ, bs, src, w); _bwE.setFromQuaternion(_bwQ); o[b] = [_bwE.x, _bwE.y, _bwE.z]; }
    else if (src) o[b] = src;
  }
  return o;
};

/** Доля доворота головы, которую на запекании отдаём ШЕЕ. Одним суставом размах корпуса не гасят. */
const HEAD_NECK_SHARE = 0.5;
/** Размах смещения таза по осям — число для панели: видно, что «сила переноса веса» реально делает. */
const hipsSpan = (h: readonly (readonly [number, number, number])[]): [number, number, number] => {
  if (!h.length) return [0, 0, 0];
  const r: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    let lo = Infinity, hi = -Infinity;
    for (const v of h) { lo = Math.min(lo, v[a]!); hi = Math.max(hi, v[a]!); }
    r[a] = +(hi - lo).toFixed(2);
  }
  return r;
};
/** Положить готовую позу (то, что уйдёт в клип) в наш риг — дальше по нему меряем заземление и голову. */
function applyPoseTo(H: Humanoid, p: Pose, hipsD: readonly [number, number, number]): void {
  for (const nm in p) { if (nm[0] === '_') continue; const b = H.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
  H.hips.position.set(H.hipsRest.x + hipsD[0], H.hipsRest.y + hipsD[1], H.hipsRest.z + hipsD[2]);
  H.root.updateMatrixWorld(true);
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _ea = new THREE.Euler(), _eb = new THREE.Euler(), _ec = new THREE.Euler();
/**
 * Какие позиционные каналы участвуют в прореживании и почём юнит смещения в «градусах».
 * ⚙ ГРАБЛЯ: раньше функция гнала ЛЮБУЮ тройку через `setFromEuler().angleTo()`. Пока в клип писались только
 * кости, это спало; с появлением офсета таза (`__hipsD`) смещение [0,−1.5,0] читалось бы как ~86° ошибки НА КАЖДОМ
 * кадре — и прореживание перестало бы прореживать. Скаляры (`__match`, `__pinKp` до 12000) в меру НЕ входят вообще:
 * плотность ключей задаёт движение, а не настройки физики.
 */
const POS_KEYS = new Set(['__hipsD', '__hipsP', '__wpnMainP', '__wpnOffP', '__lgripP']);
/** 1 юнит смещения ≈ 5° поворота. При дефолтном пороге 3° это значит «боб таза от 0.6 юнита сохраняется»
 *  (рост таза у нас 32 юнита, то есть чувствительность ≈ 2 % высоты таза). */
export const POS_DEG_PER_UNIT = 5;

/** Макс. (по костям) угловая ошибка (°) slerp-реконструкции кадра `c` из соседних ключей `a`,`b`.
 *  Мера в углах КВАТЕРНИОНОВ (не эйлер-дельте) — так же, как интерполирует наш плеер (blendTwo slerp'ом);
 *  позиционные каналы — линейно, через `POS_DEG_PER_UNIT` (тоже как у плеера). */
export function poseReconstructError(a: Keyframe, b: Keyframe, c: Keyframe): number {
  const span = b.t - a.t;
  const u = span > 1e-9 ? (c.t - a.t) / span : 0;
  let maxDeg = 0;
  for (const k in c.pose) {
    const pc = c.pose[k]!, pa = a.pose[k] ?? pc, pb = b.pose[k] ?? pc;
    let deg: number;
    if (k[0] === '_') {
      if (!POS_KEYS.has(k)) continue;                            // скаляр настроек — не движение
      let e = 0;
      for (let i = 0; i < 3; i++) e = Math.max(e, Math.abs(pa[i]! + (pb[i]! - pa[i]!) * u - pc[i]!));
      deg = e * POS_DEG_PER_UNIT;
    } else {
      _qa.setFromEuler(_ea.set(pa[0], pa[1], pa[2]));
      _qb.setFromEuler(_eb.set(pb[0], pb[1], pb[2]));
      _qa.slerp(_qb, u);                                         // реконструкция в момент c.t
      _qc.setFromEuler(_ec.set(pc[0], pc[1], pc[2]));
      deg = _qa.angleTo(_qc) * RAD2DEG;
    }
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
  /** МАСКА: что забираем из мокапа, остальное — из базовой позы. Не задана → всё тело без пальцев. */
  mask?: BoneMask;
  /** ЛЕГАСИ-вид маски. Учитывается, только если `mask` не задана. */
  body?: 'full' | 'upper' | 'lower';
  /** Базовая поза («base layer» из Unity): заполняет НЕ взятые маской кости + идёт первым/последним кадром при `anchorIdle`. */
  basePose?: Pose;
  /** Легаси-имя `basePose`. */
  idlePose?: Pose;
  anchorIdle?: boolean;                          // клип idle→движение→idle: добавить базовую позу первым и последним ключом
  /** Обрезка ПО ИСХОДНИКУ (сек): границы цикла семплирования. Прореживание идёт уже по обрезанному,
   *  поэтому концы RDP ложатся ровно на границы (обрезать готовый клип — `clipImport.trimClip`). */
  startSec?: number;
  endSec?: number;
  /**
   * ТАЗ, СМЕЩЕНИЕ. `none` — не брать вовсе; `vertical` — только присед/подскок; `full` — вертикаль +
   * ПЕРЕНОС ВЕСА (горизонталь ОТНОСИТЕЛЬНО ОПОРЫ, поэтому травел бегущего клипа вычитается по построению).
   * Дефолт `full`.
   * ⚠ Это ОТДЕЛЬНЫЙ КАНАЛ, а не часть маски: часть маски «таз» — это ПОВОРОТ кости `Hips`, а `__hipsD` —
   * СМЕЩЕНИЕ. Раньше смещение было загейчено маской, и с пресетом «верх» таз не ездил вообще. В UE эти вещи
   * тоже разведены: `Pelvis Motion` — отдельная операция ретаргета, а не часть маски костей.
   */
  hips?: 'none' | 'vertical' | 'full';
  /** Сила переноса веса 0..1: множитель смещения таза. 1 = как в мокапе, 0 = таз стоит. Дефолт 1. */
  hipsWeight?: number;
  /** ЗАЗЕМЛЕНИЕ: каждый кадр приподнять таз так, чтобы нижняя стопа стояла на полу. Дефолт вкл. */
  ground?: boolean;
  /**
   * ГОЛОВА. `mocap` — как в источнике; `aim` — ЗАПЕЧЬ фиксированной на прицел (гасит и мокап-болтанку, и
   * нырок от свинга корпуса — дрожи не остаётся в ДАННЫХ); `none` — не брать. Дефолт `mocap`.
   * Режим `aim` сам включает часть «голова» в маске: иначе запекать нечего.
   */
  head?: 'mocap' | 'aim' | 'none';
  /** Целевой кивок для `head:'aim'` (рад, 0 = горизонт, <0 = вниз). */
  headPitch?: number;
  /**
   * ОПОРА (пины): какие концы держать на месте, пока корпус живёт своей жизнью. Ключи и подписи — те же
   * четыре, что в редакторе («ПИНЫ (закрепить точку)»). Дефолт — как у эффекторов редактора: стопы да,
   * кисти нет; у HumanIK по умолчанию приколоты и запястья тоже («wrists and ankles remain in place even
   * when the Hips are translated»), но у нас кисть чаще должна идти за мокапом.
   */
  limbLock?: Partial<Record<LimbId, boolean>>;
  /** Сила привязки 0..1 — **Reach** из HumanIK: 1 = держит намертво, 0 = конец едет за телом. Дефолт 1. */
  lockWeight?: number;
}
export interface BakeResult {
  clip: Clip;
  boneMap: Record<string, string>;
  frames: number;                                // сколько плотных кадров семплировано
  keys: number;                                  // сколько ключей после прореживания
  animations: string[];                          // имена всех анимаций файла (для выбора в UI)
  /** Числа этого запекания для панели: движение позы, статичность. */
  stats: BakeStats;
}

/**
 * ОТКРЫТЫЙ ИСТОЧНИК — то, что делается ОДИН РАЗ на файл: загрузка, карта костей, приведение к T-позе,
 * обратный ретаргет. Живое превью пере-запекает клип на каждое переключение галки, и без этого разделения
 * каждое нажатие перепарсивало бы FBX заново (секунды на клип).
 */
export interface BakeSource {
  fileName: string;
  root: THREE.Object3D;
  loaded: THREE.Object3D;                        // root или Z-up-обёртка над ним
  animations: THREE.AnimationClip[];
  boneMap: Record<string, string>;
  bake: BakeRig;
  report: ImportReport;
  /** Ключ набора костей: под ним редактор хранит ручную карту (следующий файл того же пакета подхватит её). */
  signature: string;
  /**
   * Вернуть источник в снятую T-позу. ЗВАТЬ ПЕРЕД КАЖДЫМ ПЕРЕЗАПЕКАНИЕМ.
   * ⚠ `enforceTPose` пишет ЛОКАЛЬНЫЕ повороты, а микшер перетирает только кости, у которых есть дорожки:
   * без восстановления при смене анимации (или галки) в клип протекает последний кадр предыдущего прогона.
   */
  restore(): void;
}

/** Список имён анимаций в файле — для дропдауна в UI до запекания. */
export async function listAnimations(file: File): Promise<string[]> {
  const { loadAnimatedModelFile } = await import('./modelAssets.js');
  const { animations } = await loadAnimatedModelFile(file);
  return animations.map((a, i) => a.name || `anim ${i}`);
}

/** Направление кости→ребёнок в мире, строкой (для отчёта: в T-позе рука [±1,0,0], нога [0,−1,0]). */
function restDir(root: THREE.Object3D, byName: Map<string, THREE.Object3D>, bm: Record<string, string>, a: string, b: string): string {
  const ba = byName.get(bm[a] ?? ''), bb = byName.get(bm[b] ?? '');
  if (!ba || !bb) return '—';
  root.updateMatrixWorld(true);
  const v = bb.getWorldPosition(new THREE.Vector3()).sub(ba.getWorldPosition(new THREE.Vector3())).normalize();
  return `[${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}]`;
}

/** Открыть файл как источник запекания: загрузка → карта костей → диагностика → канон-T → обратный ретаргет. */
export async function openBakeSource(file: File, boneMap?: Record<string, string>): Promise<BakeSource> {
  const { loadAnimatedModelFile, skeletonBoneNames } = await import('./modelAssets.js');
  const { root, animations } = await loadAnimatedModelFile(file);
  if (!animations.length) throw new Error('В файле нет анимаций (нужен FBX/GLB/BVH с треками).');

  // bind-поза → корректный restW (модель может прийти уже на кадре 0).
  root.traverse((o) => { const sm = o as THREE.SkinnedMesh; if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.pose(); });
  root.updateMatrixWorld(true);

  const map = boneMap ?? autoBoneMap(skeletonBoneNames(root));

  // ⚠ ФОЛБЭК НА ИМЕНОВАННЫЕ УЗЛЫ обязателен и здесь, а не только в `makeBakeRig`. BVH-риги и GLB, выгнанные
  // из редакторов (в т.ч. НАШ экспорт клипов), несут скелет обычными `Object3D`, у которых `isBone === false`.
  // Замер на своём же экспорте: костей 0 → сигнатура рига вырождалась в одну и ту же для ВСЕХ таких файлов,
  // и ручная карта костей одного пакета подхватывалась бы в другом.
  const allBones: string[] = []; root.traverse((o) => { if ((o as THREE.Bone).isBone) allBones.push(o.name); });
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o); });
  if (byName.size === 0) {
    root.traverse((o) => { if (o.name && !byName.has(o.name)) { byName.set(o.name, o); allBones.push(o.name); } });
  }

  const restBefore = { arm: restDir(root, byName, map, 'LeftUpperArm', 'LeftLowerArm'), leg: restDir(root, byName, map, 'LeftUpperLeg', 'LeftLowerLeg') };
  // Ставим ИСТОЧНИК в канон-T (руки ±X) ПЕРЕД снятием rest: обратный ретаргет считает дельты ОТ rest-позы. Если rest =
  // кадр-0/A-поза (частый случай анимационных ФБХ) → дельты рук огромные от нашей T → «тело в T, руки мельницей».
  enforceTPose(root, map, FULL_AIM_CHILD);
  const restAfter = { arm: restDir(root, byName, map, 'LeftUpperArm', 'LeftLowerArm'), leg: restDir(root, byName, map, 'LeftUpperLeg', 'LeftLowerLeg') };

  // Нормализация Z-up→Y-up (CC/AccuRIG): обратный ретаргет наследует канон-фрейм нашего рига (Y-up/+Z).
  let loaded: THREE.Object3D = root;
  const hip = byName.get(map['Hips'] ?? ''), head = byName.get(map['Head'] ?? '');
  if (hip && head) {
    const ph = hip.getWorldPosition(new THREE.Vector3()), pd = head.getWorldPosition(new THREE.Vector3());
    if (Math.abs(pd.z - ph.z) > Math.abs(pd.y - ph.y)) { const wrap = new THREE.Group(); wrap.rotation.x = -Math.PI / 2; wrap.add(root); loaded = wrap; }
  }
  loaded.updateMatrixWorld(true);

  const bake = makeBakeRig(loaded, map);

  // Снимок канон-T СРАЗУ после makeBakeRig (restW снят с этой же позы) — точка возврата перед каждым запеканием.
  const snap: { o: THREE.Object3D; q: THREE.Quaternion; p: THREE.Vector3 }[] = [];
  loaded.traverse((o) => snap.push({ o, q: o.quaternion.clone(), p: o.position.clone() }));
  const restore = (): void => {
    for (const s of snap) { s.o.quaternion.copy(s.q); s.o.position.copy(s.p); }
    loaded.updateMatrixWorld(true);
  };

  const anim0 = animations[0]!;
  const report: ImportReport = {
    file: file.name,
    animations: animations.map((a, i) => ({ name: a.name || `anim ${i}`, dur: a.duration, tracks: a.tracks.length })),
    bones: allBones.length,
    dupNames: [...new Set(allBones.filter((n, i) => allBones.indexOf(n) !== i))],
    mapped: (OUR_BONES as readonly string[]).filter((b) => map[b]),
    unmapped: (OUR_BONES as readonly string[]).filter((b) => !map[b]),
    fingers: OUR_FINGERS.filter((b) => map[b]).length,
    tracks: anim0.tracks.map((t) => t.name).slice(0, 24),
    restBefore, restAfter,
  };
  return { fileName: file.name, root, loaded, animations, boneMap: map, bake, report, signature: rigSignature(allBones), restore };
}

/**
 * Запечь ОДНУ анимацию открытого источника в наш `Clip`: семпл по кадрам (обратный ретаргет) → прореживание →
 * сборка Clip (t от нуля). Root-motion (позиция таза) отбрасывается — наши клипы это ТОЛЬКО повороты костей
 * (позицию держит игра/гейт), как Puppet Master отдаёт root motion контроллеру.
 * Дёшево звать многократно: тяжёлое (парс, карта, T-поза) сделано в `openBakeSource`.
 */
export function bakeFromSource(src: BakeSource, opts: BakeOptions): BakeResult {
  src.restore();                                  // иначе в клип протечёт последний кадр прошлого прогона
  const idx = Math.min(Math.max(0, opts.animationIndex ?? 0), src.animations.length - 1);
  const anim = src.animations[idx]!;
  const head = opts.head ?? 'mocap';
  // Режим «зафиксировать на прицел» подразумевает, что голова в клипе ЕСТЬ (мы её сами и напишем);
  // режим «не брать» — что её нет. Маска и режим головы обязаны сходиться, иначе одно молча съест другое.
  const mask0 = opts.mask ?? maskFromBody(opts.body);
  const mask: BoneMask = head === 'aim' ? setPartWeight(mask0, 'head', 1)
    : head === 'none' ? setPartWeight(mask0, 'head', 0)
      : mask0;
  const fingers = hasPart(mask, 'handL') || hasPart(mask, 'handR');
  const base = opts.basePose ?? opts.idlePose;
  const hipsMode = opts.hips ?? 'full';
  const takeHips = hipsMode !== 'none';
  const hipsW = Math.min(1, Math.max(0, opts.hipsWeight ?? 1));
  const ground = opts.ground ?? true;
  const lock: Record<LimbId, boolean> = { LH: false, RH: false, LF: true, RF: true, ...opts.limbLock };
  const pinW = Math.min(1, Math.max(0, opts.lockWeight ?? 1));

  const H = buildHumanoid();
  const mixer = new THREE.AnimationMixer(src.root);
  const action = mixer.clipAction(anim); action.play();

  const fps = Math.max(1, opts.fps ?? 30), dt = 1 / fps, dur = anim.duration;
  const t0s = Math.max(0, Math.min(dur, opts.startSec ?? 0));
  const t1s = Math.max(t0s, Math.min(dur, opts.endSec ?? dur));
  // ── ПРОХОД 1: позы + СЫРЫЕ смещения таза ──
  // Смещения не сворачиваем покадрово: травел это ТРЕНД по всему клипу, а не положение стоп в кадре
  // (см. `footLock.detrendTravel` — там числа, почему покадровое вычитание опоры выдумывает качание).
  const times: number[] = [], poses: Pose[] = [], rawHips: Vec3[] = [];
  for (let t = t0s; t < t1s + dt * 0.5; t += dt) {
    const tt = Math.min(t, t1s);
    mixer.setTime(tt);
    src.loaded.updateMatrixWorld(true);
    src.bake.sampleInto(H, fingers);
    times.push(tt);
    poses.push(readOurPose(H, mask, base, fingers));
    rawHips.push(src.bake.sampleHipsDelta(H) ?? [0, 0, 0]);
  }
  mixer.stopAllAction(); mixer.uncacheClip(anim); mixer.uncacheRoot(src.root);
  src.restore();

  // ── СМЕЩЕНИЕ ТАЗА: снимаем ТРЕНД (перенос персонажа), оставляем осцилляцию (перенос веса) ──
  // Это смещение при ПОЛНОМ весе — от него считаются и финальное (×hipsW), и опорная поза для целей пинов.
  const hipsFull = takeHips ? detrendTravel(rawHips, hipsMode) : rawHips.map(() => [0, 0, 0] as [number, number, number]);

  // ── ПРОХОД 2: заземление, голова, опора стоп ──
  // Вес ноги задаёт, сколько смещения таза ей «принадлежит»: нога, взятая из мокапа на 100 %, имеет право
  // уехать вместе с тазом целиком; нога из базовой стойки (вес 0) — не имеет права вовсе. Всё, что автор
  // добавил переносом веса СВЕРХ этого, ноги обязаны отработать сгибом.
  const held = LIMBS.filter((L) => lock[L.id] && pinW > 0.001);
  const feetHeld = held.some((L) => L.leg);
  let worstMiss = 0;
  const dense: Keyframe[] = [];
  for (let i = 0; i < times.length; i++) {
    const pose = poses[i]!, full = hipsFull[i]!;
    const hipsD: [number, number, number] = [full[0] * hipsW, full[1] * hipsW, full[2] * hipsW];

    // ── ЦЕЛИ ПИНОВ: у каждой конечности СВОЯ опорная поза ──
    // Вес части задаёт, сколько движения РОДИТЕЛЬСКОЙ ЦЕПИ конечность «заказывала»: и смещение таза,
    // и ПОВОРОТЫ цепи (у ноги это таз, у руки — таз и позвоночник). Всё, что сверх этого, конечность
    // обязана отработать сгибом. Ставим риг один раз на каждую пару (цепь, вес) — обычно их две.
    const targets = new Map<LimbId, FootTarget | null>();
    let placed = '';
    for (const L of held) {
      const w = partWeight(mask, L.part);
      const key = L.chain.join('|') + ':' + w;
      if (key !== placed) { applyPoseTo(H, refPose(pose, base, L.chain, w), [full[0] * w, full[1] * w, full[2] * w]); placed = key; }
      targets.set(L.id, readLimbTarget(H, L));
    }
    // Заземляем ЦЕЛИ СТОП, а не таз: с пинами лифт таза бессмыслен — ноги всё равно вернут стопы в цели.
    const feet: (FootTarget | null)[] = [targets.get('LF') ?? null, targets.get('RF') ?? null];
    if (ground && feetHeld) groundTargets(feet, H.footLift ?? 0);

    applyPoseTo(H, pose, hipsD);
    if (ground && !feetHeld) hipsD[1] += groundBakeOffset(H);     // стопы не держим → заземление прежнее, лифтом таза
    if (held.length) {
      if (feetHeld) {                                            // таз двигаем только ради СТОП: ради кисти уводить всю фигуру нельзя
        clampHipsToFeet(H, feet);                                // «дальше не пущу»: перенос веса упирается в длину ноги
        hipsD[0] = H.hips.position.x - H.hipsRest.x; hipsD[1] = H.hips.position.y - H.hipsRest.y; hipsD[2] = H.hips.position.z - H.hipsRest.z;
      }
      for (const L of held) worstMiss = Math.max(worstMiss, lockLimb(H, L, targets.get(L.id) ?? null, pinW));
      // Кости конечности пишем БЕЗУСЛОВНО: если пин их подогнул, автор этих углов — он, и в клипе они
      // обязаны быть. Гейт «только если кость уже в позе» терял бы компенсацию там, где часть не взята.
      for (const L of held) for (const nm of limbBones(L)) { const g = H.bones.get(nm); if (g) pose[nm] = [g.rotation.x, g.rotation.y, g.rotation.z]; }
    }
    if (head === 'aim') {
      // aimYaw = 0: в клип-спейсе «прицел» это просто «вперёд по фейсингу», а фейсинг накладывает рантайм на корне.
      // Та же функция, что и в игре (требование «редактор ≡ игра»); доля шеи 0.5 — чтобы погашенный размах
      // корпуса не выкидывал локаль головы в «набок» на резком замахе.
      applyHeadLookAt(H, 0, 1, opts.headPitch ?? 0, HEAD_NECK_SHARE);
      for (const b of ['Neck', 'Head']) { const g = H.bones.get(b); if (g) pose[b] = [g.rotation.x, g.rotation.y, g.rotation.z]; }
    }
    if (takeHips || ground) setHipsOffset(pose, hipsD);
    dense.push({ t: times[i]!, pose });
  }

  // Вариативность семпла: макс. движение позы по кадрам. ≈0 → анимация НЕ дошла до снимаемых костей (карта/дубль-скелет/
  // применение микшера) → клип схлопнется в бинд/idle (первый=последний). Прямой сигнал корня проблемы «2 кадра».
  let maxMoveDeg = 0, worstBone = '—';
  { const p0 = dense[0]?.pose ?? {};
    for (const k of dense) for (const b in k.pose) { const a0 = p0[b]; if (!a0 || b[0] === '_') continue; const c = k.pose[b]!;
      _qa.setFromEuler(_ea.set(a0[0], a0[1], a0[2])); _qc.setFromEuler(_ec.set(c[0], c[1], c[2]));
      const d = _qa.angleTo(_qc) * RAD2DEG; if (d > maxMoveDeg) { maxMoveDeg = d; worstBone = b; } } }

  const reduced = reduceKeyframes(dense, opts.epsDeg ?? 3);
  const t0 = reduced.length ? reduced[0]!.t : 0;
  let keys: Keyframe[] = reduced.map((k) => ({ t: +(k.t - t0).toFixed(4), pose: k.pose }));
  // ЯКОРЬ IDLE: клип idle→движение→idle. Первый и последний ключ = базовая поза (по костям, что есть в клипе) → атака
  // бесшовно входит из стойки и возвращается в неё. Импортные ключи сдвигаем на переход. Середину юзер докручивает.
  if (opts.anchorIdle && base && keys.length) {
    const trans = 0.12, lastT = keys[keys.length - 1]!.t;
    const idleKey = (): Pose => { const o: Pose = {}; for (const b of Object.keys(keys[0]!.pose)) { const v = base[b]; if (v) o[b] = [v[0], v[1], v[2]]; } return o; };
    keys = [{ t: 0, pose: idleKey() },
      ...keys.map((k) => ({ t: +(k.t + trans).toFixed(4), pose: k.pose })),
      { t: +(lastT + 2 * trans).toFixed(4), pose: idleKey() }];
  }
  const loop = opts.loop ?? /walk|run|idle|цикл|loop|ход|бег/i.test(anim.name || '');
  const clip: Clip = {
    name: opts.name ?? (anim.name || src.fileName.replace(/\.[^.]+$/, '')),
    character: opts.character, weapon: opts.weapon, loop, keys,
    idleEnds: !!(opts.anchorIdle && base),   // концы = idle → редактор блокирует их и синкает из стойки (как удары)
  };
  const stats: BakeStats = { frames: dense.length, keys: keys.length, maxMoveDeg, worstBone, footMiss: +worstMiss.toFixed(2), hipsRange: hipsSpan(hipsFull.map((h) => [h[0] * hipsW, h[1] * hipsW, h[2] * hipsW])) };
  return { clip, boneMap: src.boneMap, frames: dense.length, keys: keys.length, stats, animations: src.report.animations.map((a) => a.name) };
}

/** Открыть файл и сразу запечь — тонкая обёртка (скриптовый путь и старые вызовы). */
export async function bakeAnimationToClip(file: File, opts: BakeOptions): Promise<BakeResult> {
  const src = await openBakeSource(file, opts.boneMap);
  logSourceReport(src);
  const r = bakeFromSource(src, opts);
  console.log(`[clipBaker] семпл: ${r.stats.frames} кадров | макс.движение позы = ${r.stats.maxMoveDeg.toFixed(1)}° (${r.stats.worstBone})`,
    isStaticBake(r.stats) ? '← ⚠ СТАТИЧНО: анимация не дошла до костей (см. карту/дубль/треки выше)' : '✓ движение есть → прореживание в ключи');
  return r;
}

/** Тот же отчёт, что раньше уходил в консоль. Панель импорта показывает `src.report` как ДАННЫЕ. */
export function logSourceReport(src: BakeSource): void {
  const r = src.report, a0 = r.animations[0];
  console.log(`[clipBaker] «${a0?.name}» dur=${(a0?.dur ?? 0).toFixed(2)}s треков=${a0?.tracks} | костей=${r.bones}${r.dupNames.length ? ` ⚠ДУБЛЬ-ИМЁН=${r.dupNames.length}` : ''} | риг=${src.signature}`);
  console.log('[clipBaker] карта костей:', r.mapped.length + '/' + OUR_BONES.length, r.unmapped.length ? '⚠ НЕ смаплено: ' + r.unmapped.join(',') : '(все смаплены)', `| пальцы ${r.fingers}/${OUR_FINGERS.length}`);
  console.log('[clipBaker] rest ДО enforce: рука', r.restBefore.arm, 'нога', r.restBefore.leg, '→ ПОСЛЕ: рука', r.restAfter.arm, 'нога', r.restAfter.leg, '(T-поза: рука [±1,0,0], нога [0,-1,0])');
  console.log('[clipBaker] треки анимации:', r.tracks.join(' | '));
}
