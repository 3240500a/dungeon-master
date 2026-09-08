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
import { mergedConfig } from './configEdits.js';
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
interface ModelCfg { id: string; url: string; kind?: string; slot?: string; classId?: string; weaponType?: string; scale?: number; base?: boolean; hideHair?: boolean; slots?: Record<string, string>; body?: BodyProfile; boneScale?: BoneScale; boneOffsets?: Record<string, number[]>; boneMap?: Record<string, string>; submeshMaterials?: Record<string, string> }

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
/** Доворот X для приведения оси «вверх» к +Y по вектору Hips→Head (позвоночник). ЗНАКО-ЗАВИСИМО: Z-up бывает +Z (голова к +Z)
 *  → −90°X, и −Z (голова к −Z, Character Creator/AccuRIG) → +90°X (иначе модель ВВЕРХ НОГАМИ). Перевёрнутый Y (голова вниз) → 180°X.
 *  Y-up → 0. Возвращает угол (рад) для obj.rotation.x. Надёжно для любого сабмеша. */
function detectUpFixX(obj: THREE.Object3D, boneMap: Record<string, string>): number {
  const r = obj.rotation.clone(); obj.rotation.set(0, 0, 0); obj.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Bone>(); obj.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
  const hips = byName.get(boneMap.Hips ?? ''); const top = byName.get(boneMap.Head ?? '') ?? byName.get(boneMap.Neck ?? '') ?? byName.get(boneMap.Chest ?? '');
  let ax = 0;
  if (hips && top) {
    const a = hips.getWorldPosition(new THREE.Vector3()), b = top.getWorldPosition(new THREE.Vector3());
    const dy = b.y - a.y, dz = b.z - a.z;
    if (Math.abs(dz) > Math.abs(dy)) ax = dz > 0 ? -Math.PI / 2 : Math.PI / 2;   // Z-up: +Z→−90°X, −Z→+90°X (CC/AccuRIG обычно −Z)
    else if (dy < 0) ax = Math.PI;                                              // перевёрнутый Y-up (голова вниз) → 180°X
  } else { const bb = skeletonBox(obj); if ((bb.max.z - bb.min.z) > (bb.max.y - bb.min.y)) ax = -Math.PI / 2; }   // без костей — знак не определить, дефолт +Z
  obj.rotation.copy(r); obj.updateMatrixWorld(true);
  return ax;
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
/** Последний известный серверный конфиг из localStorage — то, на чём работаем без сервера. */
const cachedConfigSnapshot = (): Record<string, unknown> => {
  try { return JSON.parse(localStorage.getItem('pe_config') || '{}') as Record<string, unknown>; } catch { return {}; }
};
/** Эффективный конфиг ассетов (модели/материалы/текстуры) — из /api/config, кэш на процесс.
 *  ОШИБКУ НЕ КЭШИРУЕМ: если fetch упал (500 при рестарте tsx-watch / гонка на бусте), сбрасываем кэш, чтобы
 *  следующий вызов ретаил — иначе кукла навсегда осталась бы с пустым конфигом (персонаж-атлас не появился бы). */
export function loadAssetConfig(force = false): Promise<AssetConfig> {
  if (!cfgCache || force) {
    let failed = false;
    // Ф12: сервер — не единственный источник. Порядок слоёв: живой `/api/config` → кэш `pe_config` (офлайн)
    // → локальные правки (`pe_config_edits`). Иначе без сервера вкладка «Модели» открывалась пустой и
    // настроенные сабмеши было негде взять.
    const p: Promise<AssetConfig> = fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('config http ' + r.status))))
      .catch(() => { failed = true; return cachedConfigSnapshot(); })
      .then((d: Record<string, unknown>) => mergedConfig(d) as Record<string, unknown>)
      .then((d: Record<string, unknown>) => ({
        models: (Array.isArray(d.models) ? d.models : []) as ModelCfg[],
        materials: (Array.isArray(d.materials) ? d.materials : []) as MaterialCfg[],
        textures: (Array.isArray(d.textures) ? d.textures : []) as TextureCfg[],
      }));
    cfgCache = p;
    void p.then(() => { if (failed && cfgCache === p) cfgCache = null; });   // не кэшируем провал → ретрай на след. вызове
                                                                                              // (данные при этом взяты из локального кэша, а не потеряны)
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

/** Модель-атлас персонажа (kind:'character') из конфига по КЛЮЧУ (id класса игрока ИЛИ семья монстра =
 *  subfaction||faction). Есть атлас с этим classId → он. `allowFallback` (игрок): фолбэк на глобальный атлас
 *  (без classId) или первый — одиночный атлас работает как раньше. `allowFallback=false` (монстр): нет своего
 *  атласа → undefined (рисуем процедурно, а не глобальным knight'ом). */
export function resolveCharacterModel(cfg: AssetConfig, key?: string, allowFallback = true): ModelCfg | undefined {
  const chars = cfg.models.filter((m) => m.kind === 'character' && !!m.url);
  if (key) { const own = chars.find((m) => m.classId === key); if (own) return own; }
  if (!allowFallback) return undefined;
  return chars.find((m) => !m.classId) ?? chars[0];
}

/** Профиль тела персонажа-атласа (модульные пропорции) из конфига — игра строит solid/target с ним, атлас конформится. */
export function resolveBodyProfile(cfg: AssetConfig, classId?: string): BodyProfile | undefined {
  const c = resolveCharacterModel(cfg, classId);
  const b = c?.body;
  return b && Object.keys(b).length ? b : undefined;
}

/** Пер-костные множители длины персонажа-атласа (снятые с ФБХ) — наш физ-скелет строится с ними и повторяет модель 1:1. */
export function resolveBoneScale(cfg: AssetConfig, classId?: string): BoneScale | undefined {
  const c = resolveCharacterModel(cfg, classId);
  const s = c?.boneScale;
  return s && Object.keys(s).length ? s : undefined;
}

/** ПОЛНЫЕ rest-офсеты костей ФБХ персонажа-атласа (вектор) — приоритет над boneScale, наш скелет повторяет геометрию 1:1. */
export function resolveBoneOffsets(cfg: AssetConfig, classId?: string): Record<string, number[]> | undefined {
  const c = resolveCharacterModel(cfg, classId);
  const o = c?.boneOffsets;
  return o && Object.keys(o).length ? o : undefined;
}

/** Ф3: свап процедурных мешей оружия на импортные GLB (kind:'weapon'). Группы (из attachWeapons) с
 *  `userData.weaponModelId` → грузим модель, заменяем ВИЗУАЛЬНЫХ детей группы на GLB. Трансформ/хват группы
 *  (baseRot/basePos, pe_grip) и хост-синк не трогаем — статичный меш крепится к кисти как процедурный. Оружие
 *  ОБЩЕЕ на всех персонажей; масштаб/материалы — из конфига модели. Нет модели/битый url → остаётся процедурка. */
export async function applyWeaponModels(weaponGroups: THREE.Group[], cfg: AssetConfig, assets: { materials: MaterialCfg[]; textures: TextureCfg[] }): Promise<void> {
  for (const g of weaponGroups) {
    const modelId = g.userData.weaponModelId as string | undefined;
    if (!modelId) continue;
    const m = cfg.models.find((x) => x.kind === 'weapon' && x.id === modelId && !!x.url);
    if (!m) continue;                                                  // нет модели оружия → процедурный фолбэк
    const my = (g.userData.weaponGen = ((g.userData.weaponGen as number) ?? 0) + 1);   // анти-гонка смены оружия
    try {
      const glb = await loadModelUrl(m.url);
      if (g.userData.stale || g.userData.weaponGen !== my) { glb.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); return; }
      for (let i = g.children.length - 1; i >= 0; i--) { const c = g.children[i]!; c.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); g.remove(c); }   // снести процедурные дети
      if (m.scale && m.scale !== 1) glb.scale.multiplyScalar(m.scale);
      glb.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; const mid = m.submeshMaterials?.[o.name]; if (mid) { const mat = getMaterial(assets, mid); if (mat) o.material = mat; } } });
      g.add(glb);
    } catch { /* битый url — оставляем процедурку */ }
  }
}

/** Скин над источником-мешем `source` (физ-ведомый solid). set(specs) — легаси послотные GLB; setAtlas — ОДИН
 *  GLB-атлас персонажа (submesh-тумблер по слоту). update() ведёт риги. */
export function createModelSkin(parent: THREE.Object3D, source: Humanoid): {
  set(specs: SlotModel[], assets: { materials: MaterialCfg[]; textures: TextureCfg[] }): Promise<void>;
  setAtlas(model: ModelCfg, visible: Record<string, string>, assets: { materials: MaterialCfg[]; textures: TextureCfg[] }, opt?: { hideHair?: boolean; matBySlot?: Record<string, string> }): Promise<string[]>;
  update(): void; count(): number; atlasBone(our: string): THREE.Object3D | null;
  /** Корень и карта костей ЗАГРУЖЕННОГО атласа — цель экспорта GLB со скином (Ф2.3). */
  atlasExport(): { root: THREE.Object3D; boneMap: Record<string, string> } | null;
  dispose(): void;
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
        g.rotation.set(detectUpFixX(g, map), 0, 0); g.updateMatrixWorld(true);
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
  async function setAtlas(model: ModelCfg, visible: Record<string, string>, assets: { materials: MaterialCfg[]; textures: TextureCfg[] }, opt?: { hideHair?: boolean; matBySlot?: Record<string, string> }): Promise<string[]> {
    const hideHair = !!opt?.hideHair;
    const matBySlot = opt?.matBySlot;   // слот → materialId: пер-предметный материал экипа (перекрывает материал сабмеша атласа)
    const key = 'atlas:' + model.url + '|' + JSON.stringify(visible) + '|' + (hideHair ? 'H' : '') + '|' + JSON.stringify(model.slots ?? {}) + '|' + JSON.stringify(model.submeshMaterials ?? {}) + '|' + JSON.stringify(matBySlot ?? {});
    if (key === curKey) return worn.length ? lastAtlasMeshes : [];
    curKey = key;
    const my = ++gen;
    clearWorn();
    const meshNames: string[] = [];
    try {
      const g = await loadModelUrl(model.url);
      if (my !== gen) { g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); return []; }
      const map = resolveBoneMap(g, model.boneMap ?? {});
      g.rotation.set(detectUpFixX(g, map), 0, 0); g.updateMatrixWorld(true);
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
        const mid = (slot && matBySlot?.[slot]) || model.submeshMaterials?.[mesh.name];   // пер-предметный (по слоту) > пер-сабмеш атласа
        if (mid) { const mat = getMaterial(assets, mid); if (mat) mesh.material = mat; }
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
    atlasExport: () => { const w = worn.find((x) => x.slot === 'atlas'); return w ? { root: w.rig.root, boneMap: w.rig.boneMap } : null; },
    atlasBone: (our) => worn.find((w) => w.slot === 'atlas')?.rig.targetBone(our) ?? null,   // кисть ВИДИМОГО атласа (для оружия)
    dispose() { gen++; clearWorn(); showAllProcedural(true); },
  };
}
