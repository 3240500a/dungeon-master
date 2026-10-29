/**
 * ВЫВОЗ КЛИПОВ НАРУЖУ (Ф2.3): наши `Clip` → GLB с анимациями + JSON-манифест.
 *
 * Это финальная точка пайплайна «редактор — источник анимаций для любого движка»:
 * процедурка запеклась в клипы (clipBake.ts) → клипы стали дорожками (clipToAnimation.ts) → здесь они
 * уезжают одним файлом, который Unity/Unreal/Blender открывают как обычную анимацию, без нашего кода.
 *
 * ГРАБЛЯ, из-за которой такие экспорты чаще всего выходят пустыми: `GLTFExporter` кладёт дорожку в файл,
 * ТОЛЬКО если её имя резолвится в узел экспортируемого графа. Поэтому имена костей в дорожках обязаны
 * совпадать с именами узлов скелета, который отдаём: канон-манекен → профиль `canon`, импортный
 * атлас → профиль `model` (переименование по его `boneMap`). Несовпадение = молча нет анимации.
 * `checkTracksResolve` ловит это ДО экспорта и возвращает список потерянных дорожек.
 */
import * as THREE from 'three';
import { exportGLB } from './modelAssets.js';
import { poseClipToAnimationClip, boneRenamer, boneUnrenamer, clipManifest, type NameProfile, type ClipManifestEntry } from './clipToAnimation.js';
import type { Clip } from './clipModel.js';

export interface ExportOptions {
  profile: NameProfile;                     // в каких именах костей отдавать дорожки
  boneMap?: Record<string, string>;         // для profile='model' — карта наша кость → кость модели
  /** КАК НАЗВАНЫ УЗЛЫ ЦЕЛИ: наш манекен — 'canon', загруженный атлас — 'model'. По умолчанию 'canon'. */
  nativeProfile?: NameProfile;
  fps?: number;
  epsDeg?: number;
}

/** Имена узлов графа (то, во что `GLTFExporter` может целиться дорожкой). */
export function nodeNames(root: THREE.Object3D): Set<string> {
  const s = new Set<string>();
  root.traverse((o) => { if (o.name) s.add(o.name); });
  return s;
}

/** Дорожки, которые НЕ найдут свой узел (то есть тихо пропадут при экспорте). */
export function checkTracksResolve(root: THREE.Object3D, anims: THREE.AnimationClip[]): string[] {
  const names = nodeNames(root);
  const lost: string[] = [];
  for (const a of anims) for (const t of a.tracks) {
    const node = t.name.slice(0, t.name.lastIndexOf('.'));
    if (!names.has(node)) lost.push(a.name + ' → ' + t.name);
  }
  return lost;
}

/** Собрать AnimationClip'ы под выбранный профиль имён. */
export function buildAnimations(clips: readonly Clip[], opts: ExportOptions): THREE.AnimationClip[] {
  const rename = boneRenamer(opts.profile, opts.boneMap);
  return clips.map((c) => poseClipToAnimationClip(c, { renameBone: rename, fps: opts.fps, epsDeg: opts.epsDeg }));
}

export interface ExportResult {
  glb: ArrayBuffer;
  manifest: ExportManifest;
  lostTracks: string[];                     // непустой список = принимающая сторона недосчитается костей
}
export interface ExportManifest {
  generator: string;
  profile: NameProfile;
  createdAt: string;
  unitsPerMeter: number;                    // наш риг: TILE = 32 юнита = 1 м
  clips: ClipManifestEntry[];
}

/**
 * Экспорт: скелет `root` + выбранные клипы одним GLB, плюс манифест.
 *
 * Переименовывать надо ОБОИХ сторон: и дорожки, и УЗЛЫ скелета. Если переименовать только дорожки
 * (напр. в UE5-имена), экспортер не найдёт для них узлов и ТИХО выбросит все — GLB приедет без анимаций.
 * Имена узлов меняем временно и возвращаем в finally — сцена редактора не должна пострадать.
 */
export async function exportClipsToGLB(root: THREE.Object3D, clips: readonly Clip[], opts: ExportOptions): Promise<ExportResult> {
  const anims = buildAnimations(clips, opts);
  const native = opts.nativeProfile ?? 'canon';
  // имя узла (в родном профиле) → канон → целевой профиль
  const toCanon = boneUnrenamer(native, opts.boneMap);
  const toTarget = boneRenamer(opts.profile, opts.boneMap);
  const restore: [THREE.Object3D, string][] = [];
  if (opts.profile !== native) {
    root.traverse((o) => { if (!o.name) return; const n = toTarget(toCanon(o.name)); if (n !== o.name) { restore.push([o, o.name]); o.name = n; } });
  }
  const lostTracks = checkTracksResolve(root, anims);
  let glb: ArrayBuffer;
  try { glb = await exportGLB(root, anims); }
  finally { for (const [o, n] of restore) o.name = n; }
  const manifest: ExportManifest = {
    generator: 'dungeon-master pose-editor',
    profile: opts.profile,
    createdAt: new Date().toISOString(),
    unitsPerMeter: 32,
    clips: clips.map(clipManifest),
  };
  return { glb, manifest, lostTracks };
}

/** Скачать бинарь/текст файлом (локальный дев-редактор, обычная ссылка с download). */
export function downloadFile(name: string, data: ArrayBuffer | string, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
