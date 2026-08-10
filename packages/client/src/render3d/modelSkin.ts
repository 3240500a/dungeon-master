/**
 * СЛОЙ СКИНОВ (C6b) — надевает импортные GLB-модели по слотам на игровую куклу. Ретаргет ведётся физ-ведомым
 * мешем `solid` (тот же контракт, что в поз-редакторе): наш риг — драйвер, GLB — визуал. Покрытые слотом
 * процедурные части `solid` прячутся (регион по кости). Модели/материалы — из config-секций (кэш assetCache).
 *
 * Контракт загрузки (общий с poseModelsTab): loadModelUrl → detectUpZ(доворот −90°X если Z-up) → autoScale(→58u)
 * → makeRetargetRig. GLB послотных баз экспортит поз-редактор (C6a: экспорт по слотам).
 */
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { loadModelUrl, skeletonBoneNames } from './modelAssets.js';
import { makeRetargetRig, autoBoneMap, type RetargetRig } from './retarget3d.js';
import { getMaterial, type MaterialCfg, type TextureCfg } from './assetCache.js';

/** Разрешённая модель для слота (из resolveSlotModels). */
export interface SlotModel { slot: string; url: string; boneMap: Record<string, string>; submeshMaterials?: Record<string, string> }
export interface AssetConfig { models: ModelCfg[]; materials: MaterialCfg[]; textures: TextureCfg[] }
interface ModelCfg { id: string; url: string; slot?: string; base?: boolean; hideHair?: boolean; boneMap?: Record<string, string>; submeshMaterials?: Record<string, string> }

// Кость нашего рига → регион экипировки: покрытый слотом регион прячет свои процедурные меши.
const BONE_REGION: Record<string, 'head' | 'chest' | 'gloves' | 'boots'> = {
  Head: 'head', Neck: 'head',
  Spine: 'chest', Chest: 'chest', UpperChest: 'chest',
  LeftShoulder: 'chest', RightShoulder: 'chest', LeftUpperArm: 'chest', RightUpperArm: 'chest', LeftLowerArm: 'chest', RightLowerArm: 'chest',
  LeftHand: 'gloves', RightHand: 'gloves',
  Hips: 'boots', LeftUpperLeg: 'boots', RightUpperLeg: 'boots', LeftLowerLeg: 'boots', RightLowerLeg: 'boots',
  LeftFoot: 'boots', RightFoot: 'boots', LeftToes: 'boots', RightToes: 'boots',
};
// Слот экипировки → регион тела (helm=голова: шлем/волосы прячут голову-верх; но лицо оставляем — helm НЕ в маппинге прятанья).
const SLOT_REGION: Record<string, 'head' | 'chest' | 'gloves' | 'boots'> = { chest: 'chest', gloves: 'gloves', boots: 'boots', head: 'head' };

/** BBox позиций КОСТЕЙ (полный скелет есть в каждом послотном GLB — надёжнее меш-bbox одного сабмеша). */
function skeletonBox(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3(); const v = new THREE.Vector3();
  obj.traverse((o) => { if ((o as THREE.Bone).isBone) box.expandByPoint(o.getWorldPosition(v)); });
  return box;
}
/** Ось «вверх» по СКЕЛЕТУ: вектор Hips→Head (позвоночник). Z-доминанта → модель Z-up («лежит»). Надёжно для любого сабмеша. */
function detectUpZ(obj: THREE.Object3D, boneMap: Record<string, string>): boolean {
  const r = obj.rotation.clone(); obj.rotation.set(0, 0, 0); obj.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Bone>(); obj.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
  const hips = byName.get(boneMap.Hips ?? ''); const top = byName.get(boneMap.Head ?? '') ?? byName.get(boneMap.Neck ?? '') ?? byName.get(boneMap.Chest ?? '');
  let up = false;
  if (hips && top) { const a = hips.getWorldPosition(new THREE.Vector3()), b = top.getWorldPosition(new THREE.Vector3()); up = Math.abs(b.z - a.z) > Math.abs(b.y - a.y); }
  else { const bb = skeletonBox(obj); up = (bb.max.z - bb.min.z) > (bb.max.y - bb.min.y); }
  obj.rotation.copy(r); obj.updateMatrixWorld(true);
  return up;
}
/** Высота источника (наш Humanoid): его «кости» — THREE.Group (не Bone), меряем по карте bones. */
function humanoidHeight(h: Humanoid): number {
  const box = new THREE.Box3(); const v = new THREE.Vector3();
  for (const b of h.bones.values()) box.expandByPoint(b.getWorldPosition(v));
  return box.max.y - box.min.y;
}
/** Масштаб: подгон высоты скелета импорта (THREE.Bone) под рост куклы-источника (solid) — модель точно в рост. */
function scaleToSource(obj: THREE.Object3D, source: Humanoid): number {
  const imp = skeletonBox(obj); const ih = imp.max.y - imp.min.y; const sh = humanoidHeight(source);
  return (sh > 1e-3 && ih > 1e-3) ? sh / ih : 1;
}

/** Карта костей под ФАКТИЧЕСКИ загруженный скелет: авто по именам (нормализует суффиксы экспорта CC_Base_Hip_4) +
 *  сохранённый boneMap как override, если такое имя реально присутствует. Иначе стор с исходными именами не матчится. */
function resolveBoneMap(g: THREE.Object3D, stored: Record<string, string>): Record<string, string> {
  const names = skeletonBoneNames(g);
  const out: Record<string, string> = { ...(autoBoneMap(names) as Record<string, string>) };
  const have = new Set(names);
  for (const [our, tgt] of Object.entries(stored)) if (tgt && have.has(tgt)) out[our] = tgt;
  return out;
}

let cfgCache: Promise<AssetConfig> | null = null;
/** Эффективный конфиг ассетов (модели/материалы/текстуры) — из /api/config, кэш на процесс. */
export function loadAssetConfig(force = false): Promise<AssetConfig> {
  if (!cfgCache || force) {
    cfgCache = fetch('/api/config').then((r) => r.ok ? r.json() : {}).then((d: Record<string, unknown>) => ({
      models: (Array.isArray(d.models) ? d.models : []) as ModelCfg[],
      materials: (Array.isArray(d.materials) ? d.materials : []) as MaterialCfg[],
      textures: (Array.isArray(d.textures) ? d.textures : []) as TextureCfg[],
    })).catch(() => ({ models: [], materials: [], textures: [] }));
  }
  return cfgCache;
}

/** Разрешить модель на каждый слот: надетый предмет (modelId) → base-модель слота → ничего. equipment опц. (C6c). */
export function resolveSlotModels(cfg: AssetConfig, equipment?: Record<string, { modelId?: string } | undefined>): SlotModel[] {
  const out: SlotModel[] = [];
  for (const slot of ['helm', 'head', 'chest', 'gloves', 'boots']) {
    const eqId = equipment?.[slot]?.modelId;
    let m = eqId ? cfg.models.find((x) => x.id === eqId) : undefined;
    if (!m) m = cfg.models.find((x) => x.base && x.slot === slot);
    if (m?.url) out.push({ slot, url: m.url, boneMap: m.boneMap ?? {}, submeshMaterials: m.submeshMaterials });
  }
  return out;
}

interface Worn { slot: string; rig: RetargetRig }

/** Скин над источником-мешем `source` (физ-ведомый solid). set(specs,assets) грузит/ретаргетит слоты, update() ведёт. */
export function createModelSkin(parent: THREE.Object3D, source: Humanoid): {
  set(specs: SlotModel[], assets: { materials: MaterialCfg[]; textures: TextureCfg[] }): Promise<void>; update(): void; count(): number; dispose(): void;
} {
  const worn: Worn[] = [];
  let curKey = '';
  let gen = 0;   // поколение — гонки async-загрузок: применяем только последнюю set()

  function showAllProcedural(v: boolean): void { for (const m of source.meshes) m.visible = v; }
  function hideCovered(slots: Set<string>): void {
    const regions = new Set<string>();
    for (const s of slots) { const r = SLOT_REGION[s]; if (r) regions.add(r); }
    for (const m of source.meshes) { const reg = BONE_REGION[(m.userData.bone as string) ?? '']; m.visible = !(reg && regions.has(reg)); }
  }
  function clearWorn(): void { for (const w of worn) { parent.remove(w.rig.root); w.rig.dispose(); } worn.length = 0; }

  async function set(specs: SlotModel[], assets: { materials: MaterialCfg[]; textures: TextureCfg[] }): Promise<void> {
    const key = specs.map((s) => s.slot + ':' + s.url).sort().join('|');
    if (key === curKey) return;
    curKey = key;
    const my = ++gen;
    clearWorn();
    if (!specs.length) { showAllProcedural(true); return; }
    for (const spec of specs) {
      try {
        const g = await loadModelUrl(spec.url);
        if (my !== gen) { g.traverse((o) => { const mm = o as THREE.Mesh; if (mm.geometry) mm.geometry.dispose(); }); return; }   // устарело
        // D0: карту костей ВЫВОДИМ из ФАКТИЧЕСКИ загруженного скелета (экспорт-GLB суффиксит имена → сохранённый
        // boneMap с исходными именами не матчится). autoBoneMap нормализует (CC_Base_Hip_4→Hips); сохранённый — override.
        const map = resolveBoneMap(g, spec.boneMap);
        g.rotation.set(detectUpZ(g, map) ? -Math.PI / 2 : 0, 0, 0); g.updateMatrixWorld(true);
        const rig = makeRetargetRig(g, map, scaleToSource(g, source));
        g.traverse((o) => {
          if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
          const mid = spec.submeshMaterials?.[o.name]; if (!mid) return;
          const mat = getMaterial(assets, mid); if (mat) (o as THREE.Mesh).material = mat;
        });
        rig.root.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
        parent.add(rig.root);
        worn.push({ slot: spec.slot, rig });
      } catch { /* битый url — пропускаем слот */ }
    }
    if (my !== gen) { clearWorn(); return; }
    hideCovered(new Set(specs.map((s) => s.slot)));
  }

  return {
    set,
    update() { for (const w of worn) w.rig.drive(source); },
    count: () => worn.length,
    dispose() { gen++; clearWorn(); showAllProcedural(true); },
  };
}
