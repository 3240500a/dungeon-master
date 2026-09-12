/**
 * НАШ Clip → THREE.AnimationClip И ОБРАТНО (Ф2.2).
 *
 * Это ФОРМАТ ВЫВОЗА, а не второй проигрыватель: в игре и редакторе клип по-прежнему играет наш
 * `clipPoseAt` (одна истина воспроизведения). `AnimationClip` нужен ровно для двух вещей:
 *   • экспорт в glTF/GLB через `GLTFExporter` (клип уезжает в Unity/Unreal/Blender как обычная анимация);
 *   • обратный разбор — чтобы round-trip-тест доказывал, что при вывозе ничего не потерялось.
 *
 * КРИВЫЕ. У нас форма перехода живёт в ключе (`interp`: linear/ease/step/fixed, Ф1.2), а в glTF таких
 * кривых нет — там LINEAR/STEP/CUBICSPLINE на дорожке целиком. Поэтому:
 *   • клип, где ВСЕ ключи линейные → дорожки разрежённые, один в один (ничего не теряется);
 *   • есть `ease` → клип пересемплируется по кривой и прореживается `reduceKeyframes` (форма сохранена
 *     с точностью до `epsDeg`, размер остаётся вменяемым);
 *   • `step` → `InterpolateDiscrete` на дорожке, если ВЕСЬ клип степовый, иначе тоже через пересемпл.
 *
 * ЧЕГО В ЭКСПОРТЕ НЕТ (и не должно быть): спец-ключи `__wpn*`/`__lgrip*`/`__match`/`__pinKp` — это наши
 * авторские/физические каналы, а не кости скелета. `__hipsP` уезжает дорожкой `Hips.position`.
 *
 * Файл ЧИСТЫЙ (THREE + наша математика, без DOM/загрузчиков) — тестируется в node.
 */
import * as THREE from 'three';
import { clipPoseAt, clipDur, hipsOffset, setHipsOffset, rootMotion, setRootMotion, HIPS_REST_Y, type Clip, type Keyframe, type Pose } from './clipModel.js';
import { reduceKeyframes } from './clipBaker.js';

/** Имена дорожек для наших спец-каналов (всё остальное — `<кость>.quaternion`). */
export const HIPS_POS_TRACK = 'Hips.position';
/**
 * КОРЕНЬ — ОТДЕЛЬНЫЙ УЗЕЛ, а не часть таза. Именно так root motion ждёт любой движок: Unreal читает
 * его с корневой кости и вычитает при проигрывании in-place, Unity — с Root Transform. Складывать
 * корень в `Hips` нельзя: там уже лежит перенос веса, и на импорте их стало бы не разделить.
 */
export const ROOT_POS_TRACK = 'Root.position';
export const ROOT_ROT_TRACK = 'Root.quaternion';

export interface ToAnimationOptions {
  /** Частота пересемпла, если в клипе есть кривые (по умолч. 30). */
  fps?: number;
  /** Порог прореживания пересемпленного потока в градусах (по умолч. 0.5 — визуально без потерь). */
  epsDeg?: number;
  /** Какие кости выгружать; не задано — все, что есть в клипе. */
  bones?: readonly string[];
  /** Переименование костей на выходе (канон → имена целевого рига: UE5/Mixamo/исходная модель). */
  renameBone?: (our: string) => string;
  /** Имя клипа (по умолч. `clip.name`). */
  name?: string;
  /** REST-позиция таза целевого скелета. В клипе офсет таза хранится ДЕЛЬТОЙ (переносимость между телами),
   *  а в glTF `Hips.position` — АБСОЛЮТНАЯ локальная позиция, поэтому на выгрузке дельта складывается с rest. */
  hipsRest?: readonly [number, number, number];
}

const _e = new THREE.Euler(), _q = new THREE.Quaternion();

/** Все имена костей, встречающиеся в клипе (спец-ключи `__*` отфильтрованы). */
export function clipBoneNames(c: Clip): string[] {
  const set = new Set<string>();
  for (const k of c.keys) for (const nm in k.pose) if (nm[0] !== '_') set.add(nm);
  return [...set];
}

/** Нужен ли пересемпл: есть хоть один ключ с нелинейной формой перехода. */
const hasCurves = (c: Clip): boolean => c.keys.some((k) => k.interp && k.interp !== 'linear' && k.interp !== 'fixed');
/** Весь клип степовый (кроме последнего ключа — у него исходящего интервала нет). */
const allStep = (c: Clip): boolean => c.keys.length > 1 && c.keys.slice(0, -1).every((k) => k.interp === 'step');

/** Плотный пересемпл клипа по его же кривым (ключи получаются линейными — форма уже «впечена» в значения). */
function resample(c: Clip, fps: number): Keyframe[] {
  const dur = clipDur(c);
  if (dur <= 0) return c.keys.map((k) => ({ t: k.t, pose: k.pose }));
  const dt = 1 / fps, out: Keyframe[] = [];
  for (let t = 0; t < dur + dt * 0.5; t += dt) {
    const tt = Math.min(t, dur);
    out.push({ t: +tt.toFixed(4), pose: clipPoseAt(c, dur > 0 ? tt / dur : 0) });
  }
  return out;
}

/**
 * Собрать `THREE.AnimationClip` из нашего клипа. Кватернионы приводятся к одному полушарию
 * (сосед с dot<0 инвертируется) — иначе интерполятор three пойдёт «длинной дугой» и рука провернётся.
 */
export function poseClipToAnimationClip(c: Clip, opts: ToAnimationOptions = {}): THREE.AnimationClip {
  const fps = Math.max(1, opts.fps ?? 30);
  const epsDeg = opts.epsDeg ?? 0.5;
  const discrete = allStep(c);
  const keys: Keyframe[] = (hasCurves(c) && !discrete)
    ? reduceKeyframes(resample(c, fps), epsDeg)
    : c.keys.map((k) => ({ t: k.t, pose: k.pose }));

  const rename = opts.renameBone ?? ((b: string): string => b);
  const bones = opts.bones ?? clipBoneNames(c);
  const times = keys.map((k) => k.t);
  const tracks: THREE.KeyframeTrack[] = [];
  const interp = discrete ? THREE.InterpolateDiscrete : THREE.InterpolateLinear;

  for (const nm of bones) {
    const vals = new Float32Array(keys.length * 4);
    let prevX = 0, prevY = 0, prevZ = 0, prevW = 1, any = false;
    for (let i = 0; i < keys.length; i++) {
      const p = keys[i]!.pose[nm];
      if (p) { _q.setFromEuler(_e.set(p[0], p[1], p[2], 'XYZ')); any = true; }
      else _q.identity();                                  // кость не в кадре → покой (union как в blendTwo)
      let { x, y, z, w } = _q;
      if (i > 0 && (x * prevX + y * prevY + z * prevZ + w * prevW) < 0) { x = -x; y = -y; z = -z; w = -w; }   // одно полушарие
      vals[i * 4] = x; vals[i * 4 + 1] = y; vals[i * 4 + 2] = z; vals[i * 4 + 3] = w;
      prevX = x; prevY = y; prevZ = z; prevW = w;
    }
    if (!any) continue;                                    // кости нет ни в одном кадре — дорожку не плодим
    tracks.push(new THREE.QuaternionKeyframeTrack(rename(nm) + '.quaternion', times, Array.from(vals), interp));
  }

  // Офсет таза → обычная позиционная дорожка, в АБСОЛЮТНЫХ локальных координатах (так его понимает любой движок).
  // Кадры без ключа берут значение предыдущего.
  const hr = opts.hipsRest ?? [0, HIPS_REST_Y, 0];
  if (keys.some((k) => hipsOffset(k.pose, hr[1]))) {
    const pos: number[] = []; let last: [number, number, number] = [hr[0], hr[1], hr[2]];
    for (const k of keys) {
      const d = hipsOffset(k.pose, hr[1]); if (d) last = [hr[0] + d[0], hr[1] + d[1], hr[2] + d[2]];
      pos.push(last[0], last[1], last[2]);
    }
    tracks.push(new THREE.VectorKeyframeTrack(rename('Hips') + '.position', times, pos, interp));
  }

  // Корень (Ф2). Пишем, только если клип его несёт: пустых дорожек в выгрузке быть не должно.
  if (c.rootPos || c.rootYaw) {
    const pos: number[] = [], rot: number[] = [];
    let lastP: [number, number, number] = [0, 0, 0], lastY = 0;
    for (const k of keys) {
      const r = rootMotion(k.pose);
      if (r) { lastY = r[0]; lastP = [r[1], 0, r[2]]; }
      pos.push(lastP[0], lastP[1], lastP[2]);
      _e.set(0, lastY, 0); _q.setFromEuler(_e);
      rot.push(_q.x, _q.y, _q.z, _q.w);
    }
    if (c.rootPos) tracks.push(new THREE.VectorKeyframeTrack(ROOT_POS_TRACK, times, pos, interp));
    if (c.rootYaw) tracks.push(new THREE.QuaternionKeyframeTrack(ROOT_ROT_TRACK, times, rot, interp));
  }

  const anim = new THREE.AnimationClip(opts.name ?? c.name, clipDur(c), tracks);
  return anim;
}

export interface FromAnimationOptions {
  character: string;
  weapon: string;
  loop?: boolean;
  /** Обратное переименование (имя дорожки → наша кость). */
  renameBone?: (target: string) => string;
  /** REST-позиция таза, от которой считать дельту (симметрично экспорту). */
  hipsRest?: readonly [number, number, number];
}

/** Разобрать `THREE.AnimationClip` обратно в наш `Clip` (для round-trip-проверки экспорта). */
export function animationClipToPoseClip(anim: THREE.AnimationClip, opts: FromAnimationOptions): Clip {
  const rename = opts.renameBone ?? ((b: string): string => b);
  const byTime = new Map<number, Pose>();
  const rootY = new Map<number, number>(), rootP = new Map<number, [number, number]>();
  const at = (t: number): Pose => { const key = +t.toFixed(4); let p = byTime.get(key); if (!p) { p = {}; byTime.set(key, p); } return p; };

  for (const tr of anim.tracks) {
    const dot = tr.name.lastIndexOf('.');
    const target = rename(tr.name.slice(0, dot)), prop = tr.name.slice(dot + 1);
    if (prop === 'quaternion' && target === 'Root') {
      // Корень читаем ДО общей ветки поворотов: иначе он лёг бы костью `Root` в позу и поехал бы в игру.
      for (let i = 0; i < tr.times.length; i++) {
        _q.set(tr.values[i * 4]!, tr.values[i * 4 + 1]!, tr.values[i * 4 + 2]!, tr.values[i * 4 + 3]!);
        _e.setFromQuaternion(_q, 'YXZ');
        rootY.set(+tr.times[i]!.toFixed(4), _e.y);
      }
    } else if (prop === 'position' && target === 'Root') {
      for (let i = 0; i < tr.times.length; i++) rootP.set(+tr.times[i]!.toFixed(4), [tr.values[i * 3]!, tr.values[i * 3 + 2]!]);
    } else if (prop === 'quaternion') {
      for (let i = 0; i < tr.times.length; i++) {
        _q.set(tr.values[i * 4]!, tr.values[i * 4 + 1]!, tr.values[i * 4 + 2]!, tr.values[i * 4 + 3]!);
        _e.setFromQuaternion(_q, 'XYZ');
        at(tr.times[i]!)[target] = [_e.x, _e.y, _e.z];
      }
    } else if (prop === 'position' && target === 'Hips') {
      const hr = opts.hipsRest ?? [0, HIPS_REST_Y, 0];
      for (let i = 0; i < tr.times.length; i++) {
        setHipsOffset(at(tr.times[i]!), [tr.values[i * 3]! - hr[0], tr.values[i * 3 + 1]! - hr[1], tr.values[i * 3 + 2]! - hr[2]]);
      }
    }
  }

  for (const [t, p] of byTime) {
    const y = rootY.get(t), q = rootP.get(t);
    if (y !== undefined || q) setRootMotion(p, y ?? 0, q ? q[0] : 0, q ? q[1] : 0);
  }
  const keys: Keyframe[] = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, pose]) => ({ t, pose }));
  return { name: anim.name, character: opts.character, weapon: opts.weapon, loop: opts.loop ?? false, keys,
    rootYaw: rootY.size ? true : undefined, rootPos: rootP.size ? true : undefined };
}

// ── Профили имён костей для экспорта (Ф3.1: клип уезжает в чужой движок без ретаргета) ───────────────
/** Канон (Unity Humanoid) → UE5 Mannequin. Пальцы/твисты добавятся вместе с Ф3. */
const UE5: Record<string, string> = {
  Root: 'root', Hips: 'pelvis', Spine: 'spine_01', Chest: 'spine_02', UpperChest: 'spine_03', Neck: 'neck_01', Head: 'head',
  LeftShoulder: 'clavicle_l', LeftUpperArm: 'upperarm_l', LeftLowerArm: 'lowerarm_l', LeftHand: 'hand_l',
  RightShoulder: 'clavicle_r', RightUpperArm: 'upperarm_r', RightLowerArm: 'lowerarm_r', RightHand: 'hand_r',
  LeftUpperLeg: 'thigh_l', LeftLowerLeg: 'calf_l', LeftFoot: 'foot_l', LeftToes: 'ball_l',
  RightUpperLeg: 'thigh_r', RightLowerLeg: 'calf_r', RightFoot: 'foot_r', RightToes: 'ball_r',
};
/**
 * Канон → Mixamo. ПРЕФИКС `mixamorig:` НАМЕРЕННО НЕ СТАВИМ.
 * three разбирает имя дорожки как путь, где `:` — РАЗДЕЛИТЕЛЬ «директорий»:
 *   PropertyBinding.parseTrackName('mixamorig:Hips.quaternion') → { nodeName: 'Hips' }
 * То есть экспортёр ищет узел `Hips`, а у нас он назван `mixamorig:Hips` → не находит и ТИХО выбрасывает
 * дорожку. Живая проверка давала 1 канал вместо 24. Сами мы при импорте этот префикс всё равно стрипаем
 * (`retarget3d.stripPrefix`), и большинство ретаргетеров тоже — так что голые имена узнаются не хуже.
 */
const MIXAMO: Record<string, string> = {
  Hips: 'Hips', Spine: 'Spine', Chest: 'Spine1', UpperChest: 'Spine2', Neck: 'Neck', Head: 'Head',
  LeftShoulder: 'LeftShoulder', LeftUpperArm: 'LeftArm', LeftLowerArm: 'LeftForeArm', LeftHand: 'LeftHand',
  RightShoulder: 'RightShoulder', RightUpperArm: 'RightArm', RightLowerArm: 'RightForeArm', RightHand: 'RightHand',
  LeftUpperLeg: 'LeftUpLeg', LeftLowerLeg: 'LeftLeg', LeftFoot: 'LeftFoot', LeftToes: 'LeftToeBase',
  RightUpperLeg: 'RightUpLeg', RightLowerLeg: 'RightLeg', RightFoot: 'RightFoot', RightToes: 'RightToeBase',
};

export type NameProfile = 'canon' | 'ue5' | 'mixamo' | 'model';

/** Функция переименования кости под выбранный профиль. `model` — имена ИСХОДНОЙ модели (через её boneMap). */
export function boneRenamer(profile: NameProfile, boneMap?: Record<string, string>): (our: string) => string {
  if (profile === 'ue5') return (b) => UE5[b] ?? b;
  if (profile === 'mixamo') return (b) => MIXAMO[b] ?? b;
  if (profile === 'model') return (b) => boneMap?.[b] ?? b;
  return (b) => b;
}

/** Обратная функция к `boneRenamer` (для round-trip и разбора чужих клипов). */
export function boneUnrenamer(profile: NameProfile, boneMap?: Record<string, string>): (target: string) => string {
  const inv = new Map<string, string>();
  const src = profile === 'ue5' ? UE5 : profile === 'mixamo' ? MIXAMO : profile === 'model' ? (boneMap ?? {}) : {};
  for (const our in src) inv.set(src[our]!, our);
  return (t) => inv.get(t) ?? t;
}

/** Сводка по клипу для манифеста экспорта (принимающая сторона знает, что чем является). */
export interface ClipManifestEntry { name: string; duration: number; loop: boolean; kind: string; weapon: string; character: string; keys: number }
export function clipManifest(c: Clip): ClipManifestEntry {
  const kind = c.name.startsWith('combat_idle_') ? 'combat_idle'
    : c.name.startsWith('idle_') ? 'idle'
      : c.name.startsWith('s_hit_') ? 'skill_hit'
        : c.name.startsWith('hit_') ? 'hit'
          // Запечённая походка (Ф2.1) идёт без оружейного суффикса — принимающая сторона должна
          // понимать, что это циклы локомоции для бленд-дерева, а не «что-то ещё».
          : /^(idle|walk|run|strafe)(_|$)/.test(c.name) ? 'locomotion' : 'other';
  return { name: c.name, duration: +clipDur(c).toFixed(4), loop: c.loop, kind, weapon: c.weapon, character: c.character, keys: c.keys.length };
}
