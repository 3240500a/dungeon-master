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
import type { BodyProfile, BoneScale } from './bodyProfile.js';

/** Разрешённая модель для слота (из resolveSlotModels). */
export interface SlotModel { slot: string; url: string; boneMap: Record<string, string>; submeshMaterials?: Record<string, string> }

/** Слоты тела персонажа-атласа (порядок = порядок в UI). helm = шлем/волосы, head = лицо/кожа. */
export const BODY_SLOTS = ['helm', 'head', 'chest', 'gloves', 'boots'] as const;
export type BodySlot = typeof BODY_SLOTS[number];

/** Классификация сабмеша атласа по ИМЕНИ объекта → слот тела ('' = не опознан, скрыть/назначить вручную).
 *  Порядок проверок важен: armor→chest раньше, чем hand→gloves; hair→helm раньше head. */
export function classifySubmesh(name: string): BodySlot | '' {
  const n = name.toLowerCase();
  if (/hair/.test(n)) return 'helm';                                   // волосы = база слота шлема
  if (/helm|hood|\bcap\b|crown|tiara|\bhat\b|coif/.test(n)) return 'helm';
  if (/armor|plate|chest|torso|\bbody\b|cloth|shirt|coat|jacket|tunic|robe|vest|cuirass/.test(n)) return 'chest';
  if (/hand|glove|gaunt|heand|wrist|mitt/.test(n)) return 'gloves';
  if (/\bleg|boot|foot|pant|greave|shoe|trous|calf|thigh|feet/.test(n)) return 'boots';
  if (/head|face|skin/.test(n)) return 'head';
  return '';
}
/** Авто-карта сабмеш→слот для всех мешей атласа (правится в редакторе). */
export function classifyAtlas(meshNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of meshNames) out[n] = classifySubmesh(n);
  return out;
}
export interface AssetConfig { models: ModelCfg[]; materials: MaterialCfg[]; textures: TextureCfg[] }
interface ModelCfg { id: string; url: string; kind?: string; slot?: string; base?: boolean; hideHair?: boolean; slots?: Record<string, string>; body?: BodyProfile; boneScale?: BoneScale; boneMap?: Record<string, string>; submeshMaterials?: Record<string, string> }

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
const EMPTY_CFG = (): AssetConfig => ({ models: [], materials: [], textures: [] });
/** Эффективный конфиг ассетов (модели/материалы/текстуры) — из /api/config, кэш на процесс.
 *  ОШИБКУ НЕ КЭШИРУЕМ: если fetch упал (500 при рестарте tsx-watch / гонка на бусте), сбрасываем кэш, чтобы
 *  следующий вызов ретаил — иначе кукла навсегда осталась бы с пустым конфигом (персонаж-атлас не появился бы). */
export function loadAssetConfig(force = false): Promise<AssetConfig> {
  if (!cfgCache || force) {
    let failed = false;
    const p: Promise<AssetConfig> = fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('config http ' + r.status))))
      .then((d: Record<string, unknown>) => ({
        models: (Array.isArray(d.models) ? d.models : []) as ModelCfg[],
        materials: (Array.isArray(d.materials) ? d.materials : []) as MaterialCfg[],
        textures: (Array.isArray(d.textures) ? d.textures : []) as TextureCfg[],
      }))
      .catch(() => { failed = true; return EMPTY_CFG(); });
    cfgCache = p;
    void p.then(() => { if (failed && cfgCache === p) cfgCache = null; });   // не кэшируем провал → ретрай на след. вызове
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

/** Модель-атлас персонажа (kind:'character') из конфига, если задана. */
export function resolveCharacterModel(cfg: AssetConfig): ModelCfg | undefined {
  return cfg.models.find((m) => m.kind === 'character' && !!m.url);
}

/** Профиль тела персонажа-атласа (модульные пропорции) из конфига — игра строит solid/target с ним, атлас конформится. */
export function resolveBodyProfile(cfg: AssetConfig): BodyProfile | undefined {
  const c = resolveCharacterModel(cfg);
  const b = c?.body;
  return b && Object.keys(b).length ? b : undefined;
}

/** Пер-костные множители длины персонажа-атласа (снятые с ФБХ) — наш физ-скелет строится с ними и повторяет модель 1:1. */
export function resolveBoneScale(cfg: AssetConfig): BoneScale | undefined {
  const c = resolveCharacterModel(cfg);
  const s = c?.boneScale;
  return s && Object.keys(s).length ? s : undefined;
}

/** Скин над источником-мешем `source` (физ-ведомый solid). set(specs) — легаси послотные GLB; setAtlas — ОДИН
 *  GLB-атлас персонажа (submesh-тумблер по слоту). update() ведёт риги. */
export function createModelSkin(parent: THREE.Object3D, source: Humanoid): {
  set(specs: SlotModel[], assets: { materials: MaterialCfg[]; textures: TextureCfg[] }): Promise<void>;
  setAtlas(model: ModelCfg, visible: Record<string, string>, assets: { materials: MaterialCfg[]; textures: TextureCfg[] }, opt?: { hideHair?: boolean }): Promise<string[]>;
  update(): void; count(): number; dispose(): void;
} {
  const worn: Worn[] = [];
  let curKey = '';
  let gen = 0;   // поколение — гонки async-загрузок: применяем только последнюю set()
  let lastAtlasMeshes: string[] = [];   // имена сабмешей последнего загруженного атласа (для UI)

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
        // конформ длин звеньев к source (наш риг с профилем) → повороты 1:1, меш морфится, стопы/кисти совпадают
        const rig = makeRetargetRig(g, map, scaleToSource(g, source), source);
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

  // АТЛАС: ОДИН GLB (скелет + все сабмеши-части), ОДИН риг (конформ к профилю source), submesh-тумблер по слоту.
  // `visible[slot]`: имя сабмеша = показать только его (ВАРИАНТ); '' = скрыть слот; НЕТ ключа = показать все сабмеши слота.
  // `opt.hideHair` = спрятать волосы (сабмеш helm-слота с /hair/ в имени) — надет шлем. Variant-safe: если запрошенный
  // вариант не найден среди сабмешей слота, показываем ВСЕ сабмеши слота (не прячем весь слот из-за незнакомого modelId).
  // Всё авто-садится (общий скелет, засканы на месте). Возвращает список имён сабмешей (для UI редактора).
  async function setAtlas(model: ModelCfg, visible: Record<string, string>, assets: { materials: MaterialCfg[]; textures: TextureCfg[] }, opt?: { hideHair?: boolean }): Promise<string[]> {
    const hideHair = !!opt?.hideHair;
    const key = 'atlas:' + model.url + '|' + JSON.stringify(visible) + '|' + (hideHair ? 'H' : '') + '|' + JSON.stringify(model.slots ?? {}) + '|' + JSON.stringify(model.submeshMaterials ?? {});
    if (key === curKey) return worn.length ? lastAtlasMeshes : [];
    curKey = key;
    const my = ++gen;
    clearWorn();
    const meshNames: string[] = [];
    try {
      const g = await loadModelUrl(model.url);
      if (my !== gen) { g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); return []; }
      const map = resolveBoneMap(g, model.boneMap ?? {});
      g.rotation.set(detectUpZ(g, map) ? -Math.PI / 2 : 0, 0, 0); g.updateMatrixWorld(true);
      const rig = makeRetargetRig(g, map, scaleToSource(g, source), source);
      // Проход 1: собрать сабмеши со слотами. Variant-safe требует знать, ЕСТЬ ли в слоте запрошенный вариант.
      const subs: { mesh: THREE.Mesh; slot: string }[] = [];
      g.traverse((o) => {
        if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
        const mesh = o as THREE.Mesh; meshNames.push(mesh.name);
        subs.push({ mesh, slot: (model.slots?.[mesh.name]) || classifySubmesh(mesh.name) });   // конфиг-карта → авто-классификация
      });
      const hasVariant = new Set<string>();   // слоты, где запрошенный вариант реально присутствует
      for (const { mesh, slot } of subs) { if (slot && visible[slot] && visible[slot] === mesh.name) hasVariant.add(slot); }
      // Проход 2: видимость + материалы.
      for (const { mesh, slot } of subs) {
        let show = !!slot;
        if (slot) {
          const v = visible[slot];
          if (v !== undefined) {
            if (v === '') show = false;                                    // явное скрытие слота
            else show = hasVariant.has(slot) ? (v === mesh.name) : true;   // вариант есть → только он; нет (незнакомый modelId) → все
          }
          if (show && hideHair && /hair/i.test(mesh.name)) show = false;   // шлем надет → волосы прочь
        }
        mesh.visible = show; if (show) mesh.castShadow = true;
        const mid = model.submeshMaterials?.[mesh.name]; if (mid) { const mat = getMaterial(assets, mid); if (mat) mesh.material = mat; }
      }
      parent.add(rig.root); worn.push({ slot: 'atlas', rig });
      showAllProcedural(false);   // атлас = всё тело → процедурный риг прячем целиком
    } catch { /* битый url */ }
    if (my !== gen) { clearWorn(); return []; }
    lastAtlasMeshes = meshNames;
    return meshNames;
  }

  return {
    set,
    setAtlas,
    update() { for (const w of worn) w.rig.drive(source); },
    count: () => worn.length,
    dispose() { gen++; clearWorn(); showAllProcedural(true); },
  };
}
