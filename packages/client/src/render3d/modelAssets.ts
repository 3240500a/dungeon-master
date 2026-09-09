/**
 * ЗАГРУЗКА/ЭКСПОРТ 3D-моделей для поз-редактора (B0). Редактор=конвертер: грузим FBX (AccuRIG-риг), настраиваем
 * ретаргет/тип/хват, экспортируем компактный GLB и заливаем на сервер (`POST /api/dev/assets/<id>`). Игра берёт
 * GLB (быстрый парс). FBXLoader тяжёлый — только авторинг; в игре — только GLTFLoader.
 */
import * as THREE from 'three';
import { getAsset, putAsset } from './assetStore.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';
import { devFetch } from '../devAuth.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { dedupeSkeletons, type DedupeReport } from './skeletonDedupe.js';

/** Отчёт схлопывания по последней разобранной модели (для панели «Модели» — там видно, чем выгнали ассет). */
let _lastDedupe: DedupeReport | null = null;
export function lastDedupeReport(): DedupeReport | null { return _lastDedupe; }

/**
 * Разобрать буфер по расширению → корневой Object3D (FBX через FBXLoader, GLB/GLTF через GLTFLoader).
 * СРАЗУ схлопываем дубликаты скелетов: конвертеры FBX→glTF выписывают каждому мешу свой скин, и наш рыцарь
 * приезжал с 38 копиями по 100 суставов (см. `skeletonDedupe.ts`). Делать это надо ЗДЕСЬ — единственная точка,
 * через которую модель попадает и в редактор, и в игру.
 */
async function parseModel(buf: ArrayBuffer, ext: string): Promise<THREE.Group> {
  const root = ext === 'fbx'
    ? (new FBXLoader().parse(buf, '') as unknown as THREE.Group)
    : await new Promise<THREE.Group>((resolve, reject) =>
      new GLTFLoader().parse(buf, '', (g) => resolve(g.scene as unknown as THREE.Group), reject));
  _lastDedupe = dedupeSkeletons(root);
  if (_lastDedupe.skins > 1) {
    console.warn(`[модель] пришла с ${_lastDedupe.skins} скелетами → схлопнуто в 1 `
      + `(костей ${_lastDedupe.bonesBefore} → ${_lastDedupe.bonesAfter}). Перевыгоняйте с ОБЩИМ скелетом: `
      + `все меши должны ссылаться на один skin.`);
  }
  return root;
}

/** Загрузить модель из выбранного файла (.fbx / .glb / .gltf) → корневой Object3D (со скелетом/скиннед-мешами). */
export async function loadModelFile(file: File): Promise<THREE.Group> {
  return parseModel(await file.arrayBuffer(), file.name.toLowerCase().split('.').pop() ?? '');
}

/** Модель + её анимационные клипы (для запекателя поз). Общий парс FBX/GLB/BVH → скелет-корень + `AnimationClip[]`.
 *  FBX несёт `.animations` на Group; GLTFLoader кладёт их в `g.animations` (НЕ в scene — loadModelFile их терял);
 *  BVH даёт `{ skeleton, clip }` — корень = корневая кость скелета. */
export interface AnimatedModel { root: THREE.Group; animations: THREE.AnimationClip[] }
export async function loadAnimatedModelFile(file: File): Promise<AnimatedModel> {
  const buf = await file.arrayBuffer();
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'fbx') {
    const g = new FBXLoader().parse(buf, '') as unknown as THREE.Group;
    return { root: g, animations: ((g as unknown as { animations?: THREE.AnimationClip[] }).animations) ?? [] };
  }
  if (ext === 'bvh') {
    const txt = new TextDecoder().decode(buf);
    const res = new BVHLoader().parse(txt);   // { skeleton, clip }
    const root = new THREE.Group();
    root.add(res.skeleton.bones[0]!);         // корневая кость (Hips) со всей иерархией
    return { root, animations: [res.clip] };
  }
  return await new Promise<AnimatedModel>((resolve, reject) =>
    new GLTFLoader().parse(buf, '', (g) => resolve({ root: g.scene as unknown as THREE.Group, animations: g.animations ?? [] }), reject));
}

/**
 * Загрузить модель по URL (FBX/GLB/GLTF — расширение из URL). Для игры/редактора из /assets/<id>.<ext>.
 *
 * Ф12.5: успешная загрузка оседает в IndexedDB, а при недоступной сети модель берётся оттуда — иначе без
 * сервера редактор открывался без единой модели и настраивать сабмеши было не на чем. Сеть выигрывает у
 * кэша (модель могли перезалить), кэш — страховка, а не истина.
 */
export async function loadModelUrl(url: string): Promise<THREE.Group> {
  const ext = (url.toLowerCase().split('?')[0] ?? '').split('.').pop() ?? '';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('load ' + r.status + ' ' + url);
    const buf = await r.arrayBuffer();
    void putAsset(url, buf.slice(0));            // копия: парсер вправе забрать буфер себе
    return parseModel(buf, ext);
  } catch (e) {
    const cached = await getAsset(url);
    if (!cached) throw e;
    return parseModel(cached.slice(0), ext);     // офлайн: та же модель из локального кэша
  }
}

/** Экспорт объекта в бинарный GLB (ArrayBuffer).
 *  Вторым аргументом — анимации (Ф2.3): GLTFExporter кладёт их в тот же файл, и клип уезжает
 *  в Unity/Unreal/Blender как обычная анимация — без нашего кода. Имена дорожек должны совпадать
 *  с именами УЗЛОВ экспортируемого графа, иначе экспортер тихо выбросит дорожку (частая грабля). */
export function exportGLB(obj: THREE.Object3D, animations?: THREE.AnimationClip[]): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) =>
    new GLTFExporter().parse(obj, (res) => resolve(res as ArrayBuffer), (e) => reject(e),
      animations && animations.length ? { binary: true, animations } : { binary: true }));
}

/** Залить бинарь (GLB/PNG/JPG) на сервер под id → { url }. DEV-only (в проде 403). contentType задаёт расширение. */
export async function uploadAsset(id: string, data: ArrayBuffer, contentType = 'application/octet-stream'): Promise<{ ok: boolean; id: string; url: string; bytes: number }> {
  const r = await devFetch('/api/dev/assets/' + encodeURIComponent(id), {
    method: 'POST', headers: { 'content-type': contentType }, body: data,
  });
  if (!r.ok) throw new Error('upload failed: ' + r.status);
  return r.json() as Promise<{ ok: boolean; id: string; url: string; bytes: number }>;
}

/** Имена всех костей скелета в загруженной модели (для карты ретаргета). */
export function skeletonBoneNames(root: THREE.Object3D): string[] {
  const names: string[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) names.push(o.name); });
  // Анимация-ФБХ БЕЗ скина (Explosive и т.п.): «кости» = обычные Object3D-узлы (B_Pelvis…), isBone нет → берём все именованные
  // не-меш узлы, чтобы autoBoneMap имел что мапить. Скинутые модели (атлас) сюда не попадают — там isBone есть.
  if (names.length === 0) root.traverse((o) => { const m = o as THREE.Mesh; if (o.name && !m.isMesh) names.push(o.name); });
  return names;
}
