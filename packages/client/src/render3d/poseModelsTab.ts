/**
 * ВКЛАДКА «МОДЕЛИ» поз-редактора (C5) — рабочий стол импорта скинед-мешей персонажа/оружия.
 * Поток: FBX/GLB (AccuRIG/CC) → `autoBoneMap` → `makeRetargetRig` → ЖИВОЙ ретаргет ведётся нашей позой
 * (`drive(human)` в loop) → правка карты костей / масштаба / материалов по сабмешам → Экспорт GLB
 * (`exportGLB`→`uploadAsset`) + запись `models`-записи в конфиг (`/api/dev/config-file` + live `/api/dev/config`).
 * Игра берёт GLB из конфига (`models[].url`). Редактор = конвертер; тяжёлый FBXLoader только тут, в игре — GLB.
 */
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { loadModelFile, loadModelUrl, exportGLB, uploadAsset, skeletonBoneNames } from './modelAssets.js';
import { autoBoneMap, makeRetargetRig, measureBoneScales, OUR_BONES, type RetargetRig } from './retarget3d.js';
import { getMaterial, type MaterialCfg, type TextureCfg } from './assetCache.js';
import { createModelSkin, resolveCharacterModel, classifyAtlas, classifySubmesh, BODY_SLOTS, type BodySlot } from './modelSkin.js';
import { DEFAULT_PROFILE, type BodyProfile, type BoneScale } from './bodyProfile.js';

/** Запись меша в конфиге (зеркало modelsSchema; истина — config-секция `models`). character = атлас (один GLB + slots). */
interface ModelEntry {
  id: string; name: string; url: string; kind: 'character' | 'part' | 'weapon';
  slot?: 'helm' | 'chest' | 'gloves' | 'boots' | 'head'; weaponType?: string;
  slots?: Record<string, string>;   // character: сабмеш → слот
  body?: BodyProfile;                // character: модульные пропорции (слайдеры конструктора)
  boneScale?: BoneScale;             // character: пер-костные множители из ФБХ (физ-скелет 1:1)
  base: boolean; hideHair: boolean; scale: number;
  boneMap: Record<string, string>; submeshMaterials: Record<string, string>;
}
interface AssetCfg { models: ModelEntry[]; materials: MaterialCfg[]; textures: TextureCfg[] }

export interface ModelsTabHandle {
  render(body: HTMLElement): void;         // отрисовать UI вкладки в панель
  drive(source: Humanoid): void;           // per-кадр из loop(): наша поза ведёт импортный скелет
  hideMannequin(): boolean;                 // прятать ли манекен/призрак (чтобы виден был импорт)
  importUrl(url: string): Promise<void>;    // импорт атласа по URL (тесты/дебаг — то же, что кнопка «Импорт из URL»)
  boneScale(): BoneScale | undefined;       // пер-костные пропорции текущего атласа → редактор строит манекен/призрак ими (совпадение с мешем)
  debug(): Record<string, unknown>;         // состояние (тесты/дебаг): атлас, сабмеши, видимость слотов, профиль
  dispose(): void;
}

const css = {
  input: 'box-sizing:border-box;padding:3px 6px;background:#0f1119;color:#dfe3ee;border:1px solid #39415a;border-radius:4px;font:11px monospace',
  btn: 'margin:2px 3px 2px 0;padding:3px 8px;background:#2a3350;color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace',
  btnOn: 'margin:2px 3px 2px 0;padding:3px 8px;background:#3a5030;color:#dfe8d8;border:1px solid #5a7048;border-radius:4px;cursor:pointer;font:11px monospace',
};
const el = (tag: string, style = '', text = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = style; if (text) e.textContent = text; return e; };
const btn = (label: string, fn: () => void, on = false): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = on ? css.btnOn : css.btn; b.onclick = fn; return b; };

/** Инференс слота по имени сабмеша AccuRIG-модуляра. Волосы→helm (база слота шлема: видны, пока шлем не надет);
 *  голова/лицо→head (всегда). plate_armor→chest, legs→boots, hand→gloves. */
function slotOfSubmesh(name: string): ModelEntry['slot'] | undefined {
  const n = name.toLowerCase();
  if (/hair/.test(n)) return 'helm';                                   // волосы = база слота шлема (снимаются надетым helm+hideHair)
  if (/helm|hood|cap|crown|tiara/.test(n)) return 'helm';
  if (/armor|plate|body|chest|torso|cloth|shirt|coat/.test(n)) return 'chest';
  if (/hand|glove|gaunt|heand/.test(n)) return 'gloves';
  if (/leg|boot|foot|pant|greave/.test(n)) return 'boots';
  if (/head|face|skin/.test(n)) return 'head';
  return undefined;
}

export function createModelsTab(scene: THREE.Scene): ModelsTabHandle {
  let cfg: AssetCfg = { models: [], materials: [], textures: [] };
  let loaded: THREE.Group | null = null;
  let rig: RetargetRig | null = null;
  let entry: ModelEntry | null = null;         // редактируемая запись (метаданные)
  let submeshes: THREE.Mesh[] = [];            // скинед-меши импорта (для назначения материалов)
  let hideMan = false;                         // прятать манекен (виден только импорт)
  let exporting = false;                       // на время экспорта не ведём (bind-поза)
  let status = '';                             // строка статуса под кнопками
  let bodyRef: HTMLElement | null = null;
  let upZ = false;                             // импорт Z-up (CC/AccuRIG FBX «лежит») → доворот −90°X в стойку Y-up

  // ── КОНСТРУКТОР ПЕРСОНАЖА (атлас: ОДИН GLB, submesh-тумблер по слоту + профиль тела) — превью через modelSkin ──
  const asmProfile: BodyProfile = { ...DEFAULT_PROFILE };
  let asmSrc: Humanoid | null = null;            // источник-риг превью (с профилем), позу копируем с манекена editor'а
  let asmSkin: ReturnType<typeof createModelSkin> | null = null;
  let asmOn = true;                              // конструктор — основной режим вкладки
  let asmAtlas: ModelEntry | null = null;        // текущий атлас (character-запись); из импорта или конфига
  let asmMeshes: string[] = [];                  // имена сабмешей атласа (для UI)
  const asmVisible: Record<string, string> = {}; // слот → выбранный сабмеш ('' = скрыть; НЕТ ключа = показать все)
  let asmStatus = '';

  /** Текущий атлас: свежий импорт → character из конфига. */
  function curAtlas(): ModelEntry | null { return asmAtlas ?? (resolveCharacterModel(cfg) as ModelEntry | undefined) ?? null; }

  /** (Пере)собрать источник-риг под профиль + перезагрузить атлас (конформ к профилю, submesh-видимость).
   *  ВАЖНО: пересобираем И asmSkin — он привязан к КОНКРЕТНОМУ asmSrc (source в замыкании: конформ + drive идут по
   *  нему). Иначе слайдеры строят новый asmSrc, а скин конформит/ведёт СТАРЫЙ (дефолт-профиль) → морф не виден. */
  function rebuildAsm(): void {
    if (asmSkin) { asmSkin.dispose(); asmSkin = null; }
    if (asmSrc) { scene.remove(asmSrc.root); asmSrc.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
    asmSrc = buildHumanoid({ profile: asmProfile, boneScale: curAtlas()?.boneScale });   // boneScale = пропорции ФБХ → source=физ-скелет 1:1
    asmSrc.root.visible = false;                  // источник невидим — видим меши атласа поверх
    scene.add(asmSrc.root);
    asmSkin = createModelSkin(scene, asmSrc);     // новый скин на НОВЫЙ источник (конформ к профилю с нуля)
    void applyAsm();
  }
  async function applyAsm(): Promise<void> {
    if (!asmSkin) return;
    const atlas = curAtlas();
    if (atlas) asmMeshes = await asmSkin.setAtlas(atlas, asmVisible, { materials: cfg.materials, textures: cfg.textures });
  }
  /** Импорт АТЛАСА: FBX/GLB (скелет + все части) → авто-классификация сабмешей → ОДИН GLB → конфиг character → превью. */
  async function importAtlas(get: () => Promise<THREE.Group>, name: string): Promise<void> {
    asmStatus = 'импорт атласа…'; renderBody();
    try {
      const g = await get();
      const meshNames: string[] = []; g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshNames.push(o.name); });
      const slots = classifyAtlas(meshNames);
      const boneScale = measureBoneScales(g, autoBoneMap(skeletonBoneNames(g)));   // пер-костные пропорции ФБХ → физ-скелет 1:1
      const id = (name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'character');
      g.traverse((o) => { const s = (o as THREE.SkinnedMesh).skeleton; if (s) s.pose(); });   // bind-поза для чистого GLB
      const glb = await exportGLB(g);
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });   // g больше не нужен (превью грузит из url)
      const up = await uploadAsset(id, glb, 'model/gltf-binary');
      const e: ModelEntry = { id, name, url: up.url, kind: 'character', slots, body: { ...asmProfile }, boneScale, base: false, hideHair: false, scale: 1, boneMap: {}, submeshMaterials: {} };
      const models = (cfg.models as ModelEntry[]).filter((m) => m.kind !== 'character').concat(e);   // один персонаж-атлас
      const bodyJson = JSON.stringify({ models });
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
      await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
      cfg.models = models; asmAtlas = e;
      if (!asmSkin) rebuildAsm(); else await applyAsm();   // гарантируем построенный превью-скин
      asmStatus = `атлас «${id}»: ${meshNames.length} частей → ${meshNames.map((n) => (slots[n] || '?')).join('/')}`;
    } catch (err) { asmStatus = 'ошибка: ' + (err as Error).message; }
    renderBody();
  }
  /** Сохранить правки атласа (классификация/материалы) в конфиг. */
  async function saveAtlas(): Promise<void> {
    if (!asmAtlas) return;
    const models = (cfg.models as ModelEntry[]).map((m) => (m.id === asmAtlas!.id ? asmAtlas! : m));
    const bodyJson = JSON.stringify({ models });
    await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    cfg.models = models;
  }
  /** Сохранить профиль тела (F2) в character-запись → игра строит solid/target с ним (превью = игра). */
  async function saveProfile(): Promise<void> {
    const atlas = curAtlas(); if (!atlas) return;
    atlas.body = { ...asmProfile };
    asmAtlas = atlas;                    // saveAtlas персистит asmAtlas (ссылка = запись в cfg.models)
    await saveAtlas();
  }
  /** Подтянуть профиль из сохранённого атласа (при открытии вкладки — слайдеры = сохранённые пропорции). */
  function syncProfileFromAtlas(): void {
    const b = curAtlas()?.body; if (!b) return;
    for (const k of Object.keys(DEFAULT_PROFILE) as (keyof BodyProfile)[]) asmProfile[k] = b[k] ?? DEFAULT_PROFILE[k];
  }

  // ── Загрузка эффективного конфига (истина — /api/config: дефолты + правки редактора) ──
  async function fetchCfg(): Promise<void> {
    try {
      const r = await fetch('/api/config'); if (!r.ok) return;
      const d = await r.json() as Record<string, unknown>;
      cfg = {
        models: Array.isArray(d.models) ? d.models as ModelEntry[] : [],
        materials: Array.isArray(d.materials) ? d.materials as MaterialCfg[] : [],
        textures: Array.isArray(d.textures) ? d.textures as TextureCfg[] : [],
      };
    } catch { /* сервер недоступен — пустой конфиг */ }
  }

  // ── Ось «вверх»: Z-up (глубина ≫ высоты у стоящего гуманоида) → модель лежит, доворачиваем в стойку ──
  function detectUpZ(obj: THREE.Object3D): boolean {
    obj.rotation.set(0, 0, 0); obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    return (box.max.z - box.min.z) > 1.4 * (box.max.y - box.min.y);
  }
  // ── Оценка масштаба: высота bbox (при текущем довороте) → к высоте манекена (TILE=32u=1м, гуманоид ~58u) ──
  function autoScale(obj: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(obj); const h = box.max.y - box.min.y;
    if (!(h > 1e-3)) return 1;
    return +(58 / h).toFixed(4);
  }

  // ── Собрать риг из загруженной сцены (доворот оси + масштаб + карта костей); заменить прежний.
  //    Доворот −90°X ставит Z-up модель в Y-up стойку ДО запекания rest-оффсетов (иначе ретаргет борется с осью). ──
  function buildRig(boneMap: Record<string, string>, scale: number): void {
    if (rig) { scene.remove(rig.root); rig.dispose(); rig = null; }
    if (!loaded) return;
    loaded.rotation.set(upZ ? -Math.PI / 2 : 0, 0, 0);
    rig = makeRetargetRig(loaded, { ...boneMap }, scale);
    scene.add(rig.root);
    submeshes = [];
    loaded.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) submeshes.push(o as THREE.Mesh); });
  }

  // preset — существующая config-запись (кнопка «загрузить»): сохраняем её метаданные/карту, иначе авто-инференс.
  async function importFrom(get: () => Promise<THREE.Group>, srcLabel: string, preset?: ModelEntry): Promise<void> {
    status = 'загрузка ' + srcLabel + '…'; renderBody();
    try {
      if (rig) { scene.remove(rig.root); rig.dispose(); rig = null; }
      loaded = await get();
      const boneNames = skeletonBoneNames(loaded);
      const auto = autoBoneMap(boneNames);
      upZ = detectUpZ(loaded);
      loaded.rotation.set(upZ ? -Math.PI / 2 : 0, 0, 0); loaded.updateMatrixWorld(true);   // измерять масштаб в стоящей позе
      if (preset) {
        entry = { ...preset, boneMap: { ...preset.boneMap }, submeshMaterials: { ...preset.submeshMaterials } };
        if (!Object.keys(entry.boneMap).length) entry.boneMap = auto;
      } else {
        const meshNames: string[] = []; loaded.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshNames.push(o.name); });
        const slot = meshNames.map(slotOfSubmesh).find(Boolean);
        entry = {
          id: srcLabel.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'model',
          name: srcLabel, url: '', kind: 'part', slot, base: false, hideHair: false, scale: autoScale(loaded),
          boneMap: auto, submeshMaterials: {},
        };
      }
      buildRig(entry.boneMap, entry.scale);
      for (const mesh of submeshes) { const mid = entry.submeshMaterials[mesh.name]; if (mid) applyMaterial(mesh, mid); }   // восстановить материалы
      const mapped = Object.values(entry.boneMap).filter(Boolean).length;
      status = `загружено: ${submeshes.length} сабмеш(ей), карта костей ${mapped}/${OUR_BONES.length}, масштаб ${entry.scale}`;
    } catch (e) { status = 'ошибка: ' + (e as Error).message; loaded = null; rig = null; }
    renderBody();
  }

  // ── Экспорт: bind-поза → GLB → upload → запись в config `models` ──
  async function exportToConfig(): Promise<void> {
    if (!rig || !loaded || !entry) return;
    status = 'экспорт…'; renderBody();
    exporting = true;
    try {
      for (const m of submeshes) { const s = (m as THREE.SkinnedMesh).skeleton; if (s) s.pose(); }   // bind-поза для чистого GLB
      // Экспорт с ЗАПЕЧЁННЫМ авторским трансформом (доворот оси Y-up + масштаб ~58u = наш рост): GLB сразу игро-размерный.
      // Игра грузит его как есть (makeRetargetRig scale=1 — уже нужного размера); config.scale — опц. доводка.
      loaded.updateMatrixWorld(true);
      const glb = await exportGLB(loaded);
      const up = await uploadAsset(entry.id, glb, 'model/gltf-binary');
      entry.url = up.url;
      entry.boneMap = { ...rig.boneMap };
      // В конфиг пишем scale=1: авторский масштаб/ось уже запечены в GLB (игра грузит как есть).
      const persisted: ModelEntry = { ...entry, scale: 1 };
      const models = cfg.models.slice();
      const i = models.findIndex((m) => m.id === persisted.id);
      if (i >= 0) models[i] = persisted; else models.push(persisted);
      const body = JSON.stringify({ models });
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });   // персист в data/models.json
      await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });         // live-оверрайд
      cfg.models = models;
      status = `сохранено: ${entry.id} → ${up.url} (${(glb.byteLength / 1024).toFixed(0)} КБ)`;
    } catch (e) { status = 'ошибка экспорта: ' + (e as Error).message; }
    exporting = false;
    renderBody();
  }

  // ── C6a: экспорт-СПЛИТ модульного меша на послотные базы. Каждый сабмеш → свой GLB (скелет + один SkinnedMesh
  //    через SkeletonUtils.clone) → отдельная `models`-запись base=true со своим слотом. Игра свапит слоты независимо. ──
  async function exportSplitBySlot(): Promise<void> {
    if (!loaded || !rig || !entry || !submeshes.length) return;
    status = 'сплит-экспорт по слотам…'; renderBody();
    exporting = true;
    try {
      for (const m of submeshes) { const s = (m as THREE.SkinnedMesh).skeleton; if (s) s.pose(); }   // bind-поза
      loaded.updateMatrixWorld(true);
      const models = cfg.models.slice();
      const boneMap = { ...rig.boneMap };
      const made: string[] = [];
      for (const sm of submeshes) {
        const slot = slotOfSubmesh(sm.name) ?? 'chest';
        const clone = skeletonClone(loaded) as THREE.Object3D;   // клон со СВОИМ скелетом (перепривязывает скиннинг)
        const drop: THREE.Object3D[] = [];
        clone.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name !== sm.name) drop.push(o); });
        for (const o of drop) o.parent?.remove(o);               // оставить только целевой сабмеш (+ полный скелет)
        const glb = await exportGLB(clone);
        const id = (entry.id + '_' + sm.name).replace(/[^a-zA-Z0-9_-]/g, '');
        const up = await uploadAsset(id, glb, 'model/gltf-binary');
        const mid = entry.submeshMaterials[sm.name];
        const e: ModelEntry = {
          id, name: sm.name, url: up.url, kind: 'part', slot, base: true, hideHair: false, scale: 1,
          boneMap, submeshMaterials: mid ? { [sm.name]: mid } : {},
        };
        const i = models.findIndex((x) => x.id === id);
        if (i >= 0) models[i] = e; else models.push(e);
        made.push(`${slot}:${sm.name}`);
      }
      const body = JSON.stringify({ models });
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      cfg.models = models;
      status = `сплит готов: ${made.join(', ')}`;
    } catch (e) { status = 'ошибка сплита: ' + (e as Error).message; }
    exporting = false;
    renderBody();
  }

  async function deleteModel(id: string): Promise<void> {
    const models = cfg.models.filter((m) => m.id !== id);
    const body = JSON.stringify({ models });
    await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    cfg.models = models; renderBody();
  }

  // ── Назначить материал (из config `materials`) сабмешу ──
  function applyMaterial(mesh: THREE.Mesh, matId: string): void {
    if (!entry) return;
    if (!matId) { delete entry.submeshMaterials[mesh.name]; return; }
    const mat = getMaterial(cfg, matId);
    if (mat) { mesh.material = mat; entry.submeshMaterials[mesh.name] = matId; }
  }

  // ── UI ──
  function renderBody(): void { if (bodyRef) render(bodyRef); }

  // ── КОНСТРУКТОР ПЕРСОНАЖА (единственный экран вкладки): атлас (один FBX/GLB) + слоты + пропорции ──
  const rowFlex = 'display:flex;align-items:center;gap:6px;margin:2px 0';
  const lblCss = 'color:#8b93a6;font-size:10px;min-width:64px';
  const boxCss = 'border:1px solid #2c3350;border-radius:6px;padding:6px;margin-bottom:6px';
  const headCss = 'color:#8fa0c0;font-size:11px;margin-bottom:4px';

  function render(body: HTMLElement): void {
    bodyRef = body; body.innerHTML = '';
    if (!asmSrc) rebuildAsm();

    // Импорт АТЛАСА (скелет + все части одним файлом)
    const imp = el('div', boxCss);
    imp.append(el('div', headCss, 'Персонаж-атлас (FBX/GLB: скелет + все части в одном файле)'));
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.fbx,.glb,.gltf'; file.style.display = 'none';
    file.onchange = () => { const f = file.files?.[0]; if (f) void importAtlas(() => loadModelFile(f), f.name); };
    const urlIn = document.createElement('input'); urlIn.type = 'text'; urlIn.value = '/assets/knight_02_modular_rig.fbx'; urlIn.style.cssText = css.input + ';width:100%;margin:3px 0';
    imp.append(btn('📁 Импорт из файла', () => file.click()), file);
    imp.append(urlIn, btn('🌐 Импорт из URL', () => { const u = urlIn.value.trim(); if (u) void importAtlas(() => loadModelUrl(u), u.split('/').pop() ?? 'character'); }));
    body.append(imp);
    if (asmStatus) body.append(el('div', 'color:#c8b06a;font-size:10px;margin:2px 0 6px', asmStatus));

    const atlas = curAtlas();
    if (!atlas) { body.append(el('div', 'color:#6b7180;font-size:10px;padding:8px', 'Импортируй FBX-атлас персонажа — части (голова/тело/руки/ноги/волосы) авто-разложатся по слотам и соберутся на скелете.')); return; }

    // сгруппировать сабмеши по слоту (карта конфига → авто-классификация)
    const bySlot: Record<string, string[]> = {};
    for (const m of asmMeshes) { const s = (atlas.slots?.[m]) || classifySubmesh(m); (bySlot[s] ??= []).push(m); }

    // Части по слотам — тумблер видимости (вариант / все / скрыть)
    const slotsBox = el('div', boxCss);
    slotsBox.append(el('div', headCss, 'Части по слотам (что показывать):'));
    for (const slot of BODY_SLOTS) {
      const parts = bySlot[slot] ?? [];
      const r = el('div', rowFlex);
      r.append(el('span', lblCss, `${slot} (${parts.length})`));
      const opts = ['(все)', '(скрыть)', ...parts];
      const cur = asmVisible[slot] === '' ? '(скрыть)' : (asmVisible[slot] ?? '(все)');
      const sel = mkSelect(opts, cur, (v) => { if (v === '(все)') delete asmVisible[slot]; else asmVisible[slot] = (v === '(скрыть)' ? '' : v); void applyAsm(); });
      sel.style.flex = '1'; r.append(sel); slotsBox.append(r);
    }
    body.append(slotsBox);

    // Классификация частей (переназначить слот + материал) — свёрнуто
    const clsBox = el('details', boxCss);
    const sum = document.createElement('summary'); sum.textContent = `Части атласа (${asmMeshes.length}) — слот + материал`; sum.style.cssText = 'color:#8fa0c0;font-size:11px;cursor:pointer'; clsBox.append(sum);
    const matIds = ['', ...cfg.materials.map((m) => m.id)];
    for (const m of asmMeshes) {
      const r = el('div', rowFlex);
      r.append(el('span', 'color:#c0c6d4;font-size:10px;min-width:90px;overflow:hidden;text-overflow:ellipsis', m));
      const sSel = mkSelect(['', ...BODY_SLOTS], (atlas.slots?.[m]) ?? classifySubmesh(m), (v) => { atlas.slots = { ...(atlas.slots ?? {}), [m]: v }; void saveAtlas(); void applyAsm(); });
      const mSel = mkSelect(matIds, atlas.submeshMaterials?.[m] ?? '', (v) => { atlas.submeshMaterials = { ...(atlas.submeshMaterials ?? {}), [m]: v }; void saveAtlas(); void applyAsm(); }); mSel.style.flex = '1';
      r.append(sSel, mSel); clsBox.append(r);
    }
    body.append(clsBox);

    // Пропорции тела (морф)
    const prof = el('div', boxCss);
    prof.append(el('div', headCss, 'Пропорции тела (морф всего персонажа):'));
    const slider = (label: string, key: keyof BodyProfile, min: number, max: number): void => {
      const r = el('div', rowFlex);
      r.append(el('span', lblCss, label));
      const s = document.createElement('input'); s.type = 'range'; s.min = String(min); s.max = String(max); s.step = '0.02'; s.value = String(asmProfile[key] ?? 1); s.style.flex = '1';
      const v = el('span', 'color:#c8b06a;font-size:10px;min-width:30px', (asmProfile[key] ?? 1).toFixed(2));
      s.oninput = () => { v.textContent = parseFloat(s.value).toFixed(2); };
      s.onchange = () => { asmProfile[key] = parseFloat(s.value); rebuildAsm(); void saveProfile(); };
      r.append(s, v); prof.append(r);
    };
    slider('рост', 'height', 0.7, 1.4); slider('руки', 'arm', 0.6, 1.6); slider('ноги', 'leg', 0.6, 1.6); slider('торс', 'torso', 0.7, 1.4); slider('толщина', 'girth', 0.6, 1.8);
    body.append(prof);
  }

  function mkSelect(opts: string[], val: string, on: (v: string) => void): HTMLSelectElement {
    const s = document.createElement('select'); s.style.cssText = css.input;
    for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o || '—'; if (o === val) op.selected = true; s.append(op); }
    s.onchange = () => on(s.value); return s;
  }
  function mkCheck(val: boolean, on: (v: boolean) => void): HTMLElement {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = val; c.onchange = () => on(c.checked);
    const w = el('div', 'display:flex'); w.append(c); return w;
  }

  // Конфиг загружен → подтянуть сохранённый профиль тела в слайдеры и пересобрать превью (превью = игра).
  void fetchCfg().then(() => { syncProfileFromAtlas(); if (asmSrc) rebuildAsm(); renderBody(); });

  // Сборка: копируем ПОЗУ (повороты) манекена editor'а в источник-риг сборки (таз держим на своей высоте профиля), ведём скин.
  function driveAsm(source: Humanoid): void {
    if (!asmOn || !asmSrc || !asmSkin) return;
    for (const nm of asmSrc.boneNames) { const sb = source.bones.get(nm); const tb = asmSrc.bones.get(nm); if (sb && tb) tb.rotation.copy(sb.rotation); }
    asmSrc.root.updateMatrixWorld(true);
    asmSkin.update();
  }

  return {
    render,
    drive(source) { driveAsm(source); },
    hideMannequin: () => false,   // показываем И скелет-манекен, И меш (позинг импортного персонажа: кости поверх модели)
    importUrl: (url) => importAtlas(() => loadModelUrl(url), url.split('/').pop() ?? 'character'),   // тест/дебаг: импорт атласа
    boneScale: () => curAtlas()?.boneScale,   // пропорции ФБХ текущего атласа для манекена/призрака редактора

    debug: () => ({
      status: asmStatus, atlas: asmAtlas ? { id: asmAtlas.id, url: asmAtlas.url, slots: asmAtlas.slots } : null,
      asmMeshes, asmVisible: { ...asmVisible }, asmProfile: { ...asmProfile }, asmSkinCount: asmSkin ? asmSkin.count() : 0,
      configModels: cfg.models.map((m) => `${m.id}:${m.kind}`),
    }),
    dispose() { if (asmSkin) asmSkin.dispose(); if (asmSrc) scene.remove(asmSrc.root); },
  };
}
