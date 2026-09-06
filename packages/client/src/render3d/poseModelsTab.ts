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
import { autoBoneMap, makeRetargetRig, measureBoneScales, measureBoneOffsets, enforceTPose, OUR_BONES, OUR_FINGERS, type RetargetRig } from './retarget3d.js';
const FINGER_SET = new Set<string>(OUR_FINGERS);   // Ф14.2: быстрая проверка «это фаланга?» для само-лечения замеров
import { getMaterial, type MaterialCfg, type TextureCfg } from './assetCache.js';
import { createModelSkin, resolveCharacterModel, classifyAtlas, classifySubmesh, BODY_SLOTS, type BodySlot } from './modelSkin.js';
import { DEFAULT_PROFILE, type BodyProfile, type BoneScale } from './bodyProfile.js';

/** Запись меша в конфиге (зеркало modelsSchema; истина — config-секция `models`). character = атлас (один GLB + slots). */
interface ModelEntry {
  id: string; name: string; url: string; kind: 'character' | 'part' | 'weapon';
  classId?: string;                  // character: ключ атласа (класс игрока / фракция монстра, напр. 'undead'); пусто = глоб. игрок
  slot?: 'helm' | 'chest' | 'gloves' | 'boots' | 'head'; weaponType?: string;
  slots?: Record<string, string>;   // character: сабмеш → слот
  body?: BodyProfile;                // character: модульные пропорции (слайдеры конструктора)
  boneScale?: BoneScale;             // character: пер-костные множители из ФБХ (физ-скелет 1:1)
  boneOffsets?: Record<string, number[]>;   // character: ПОЛНЫЕ rest-офсеты из ФБХ (приоритет; геометрия 1:1)
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
  boneOffsets(): Record<string, number[]> | undefined;   // ПОЛНЫЕ rest-офсеты ФБХ текущего атласа (приоритет; геометрия 1:1)
  profile(): BodyProfile | undefined;       // профиль тела (модульные пропорции) — редактор/игра строят тело им (единый opts)
  handBone(our: string): THREE.Object3D | null;   // кисть ВИДИМОГО атласа (для крепления оружия к мешу, не к манекену)
  /** НАСТОЯЩАЯ кость модели по нашему имени (Ф20.3): то же, что `handBone`, но без врущего «кисть» в имени —
   *  вид скелета спрашивает её для всех 52 костей, а не для кистей. */
  atlasBone(our: string): THREE.Object3D | null;
  /** Загруженный атлас как ЦЕЛЬ ЭКСПОРТА (скин + его скелет) и карта наша кость→кость модели; null — атлас не загружен. */
  exportTarget(): { root: THREE.Object3D; boneMap: Record<string, string> } | null;
  /** Есть ли у ЗАГРУЖЕННОГО атласа кости пальцев — строить ли их в манекене (Ф3.1). */
  hasFingers(): boolean;
  /** Ф15.1: пересобрать риг-источник под новый морф персонажа (скелет и меш обязаны ехать вместе). */
  refreshProfile(): void;
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

/**
 * Ф15.1: МОРФ ДВИГАЕТ И КОСТИ, И МЕШ (как параметры тела в MetaHuman).
 * `charProfile` — телосложение атласа × морф ПЕРСОНАЖА, тот же, которым редактор строит манекен.
 * Раньше риг-источник строился только профилем атласа, поэтому морф ехал на скелет и не ехал на меш —
 * замерено: все кости манекена были ×1.08 от модели. Теперь конформ длин тянет кости модели тем же
 * профилем, и скин едет следом.
 */
/**
 * `charProfile`/`charBoneScale` — ГЕОМЕТРИЯ МАНЕКЕНА, переданная снаружи. Риг-источник `asmSrc` ОБЯЗАН
 * строиться ТЕМ ЖЕ, чем манекен, иначе кости модели встают НЕ там, где нарисованы кости редактора.
 */
export function createModelsTab(scene: THREE.Scene, charProfile?: () => BodyProfile | undefined, charBoneScale?: () => BoneScale | undefined): ModelsTabHandle {
  let cfg: AssetCfg = { models: [], materials: [], textures: [] };
  let loaded: THREE.Group | null = null;
  let rig: RetargetRig | null = null;
  let entry: ModelEntry | null = null;         // редактируемая запись (метаданные)
  let submeshes: THREE.Mesh[] = [];            // скинед-меши импорта (для назначения материалов)
  let hideMan = false;                         // прятать манекен (виден только импорт)
  let exporting = false;                       // на время экспорта не ведём (bind-поза)
  let status = '';                             // строка статуса под кнопками
  let bodyRef: HTMLElement | null = null;
  let upFixX = 0;                              // импорт: доворот X к Y-up (знако-зависимо по костям: +Z→−90°, −Z→+90°)

  // ── КОНСТРУКТОР ПЕРСОНАЖА (атлас: ОДИН GLB, submesh-тумблер по слоту + профиль тела) — превью через modelSkin ──
  const asmProfile: BodyProfile = { ...DEFAULT_PROFILE };
  let asmSrc: Humanoid | null = null;            // источник-риг превью (с профилем), позу копируем с манекена editor'а
  let asmSkin: ReturnType<typeof createModelSkin> | null = null;
  let asmOn = true;                              // конструктор — основной режим вкладки
  let asmAtlas: ModelEntry | null = null;        // текущий атлас (character-запись); из импорта или конфига
  let asmMeshes: string[] = [];                  // имена сабмешей атласа (для UI)
  const asmVisible: Record<string, string> = {}; // слот → выбранный сабмеш ('' = скрыть; НЕТ ключа = показать все)
  let asmStatus = '';
  let asmKey = '';                               // ключ атласа при импорте: пусто=игрок, для монстра=фракция ('undead' и т.п.)
  let wpnStatus = '';                            // статус импорта оружия (один FBX → GLB на каждое)

  /** Текущий атлас: свежий импорт → character из конфига. */
  function curAtlas(): ModelEntry | null { return asmAtlas ?? (resolveCharacterModel(cfg) as ModelEntry | undefined) ?? null; }

  /** (Пере)собрать источник-риг под профиль + перезагрузить атлас (конформ к профилю, submesh-видимость).
   *  ВАЖНО: пересобираем И asmSkin — он привязан к КОНКРЕТНОМУ asmSrc (source в замыкании: конформ + drive идут по
   *  нему). Иначе слайдеры строят новый asmSrc, а скин конформит/ведёт СТАРЫЙ (дефолт-профиль) → морф не виден. */
  function rebuildAsm(): void {
    if (asmSkin) { asmSkin.dispose(); asmSkin = null; }
    if (asmSrc) { scene.remove(asmSrc.root); asmSrc.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
    // Ф20.1: `boneScale` тоже берётся СНАРУЖИ. Раньше здесь стоял голый `curAtlas()?.boneScale`, то есть
    // ПЕР-КОСТНЫЙ МОРФ персонажа (шея/голова/плечи/таз/кисти/стопы) до модели НЕ ДОЕЗЖАЛ: манекен
    // строился `mergeBoneScale(atlasBS(), morphToBoneScale(curMorph()))`, а источник — только атласным.
    // Замерено на knight_05 (физика ВЫКЛ, то есть без заземления): расходилась КАЖДАЯ кость тела —
    // колено 2.37u, кисть 0.93u, стопа 0.76u, таз/спина 0.29u. Это было больше всего остального вместе взятого.
    //
    // `fingers: true` ОБЯЗАТЕЛЕН (Ф14.1): без него `asmSrc.boneNames` не содержит фаланг, поэтому
    // driveAsm ниже не копирует их повороты, а `RetargetRig.drive` молча делает `continue`.
    asmSrc = buildHumanoid({ profile: charProfile?.() ?? asmProfile, boneScale: charBoneScale?.() ?? curAtlas()?.boneScale, boneOffsets: curAtlas()?.boneOffsets, fingers: true });
    asmSrc.root.visible = false;                  // источник невидим — видим меши атласа поверх
    scene.add(asmSrc.root);
    asmSkin = createModelSkin(scene, asmSrc);     // новый скин на НОВЫЙ источник (конформ к профилю с нуля)
    void applyAsm();
  }
  async function applyAsm(): Promise<void> {
    if (!asmSkin) return;
    const atlas = curAtlas();
    if (!atlas) return;
    asmMeshes = await asmSkin.setAtlas(atlas, asmVisible, { materials: cfg.materials, textures: cfg.textures });
    await healFingerOffsets(atlas);
  }

  /**
   * Ф14.2: САМО-ЛЕЧЕНИЕ ЗАМЕРОВ ПАЛЬЦЕВ.
   * До Ф14.2 `measureBoneOffsets` шёл только по `OUR_BONES`, поэтому у всех уже импортированных
   * моделей в конфиге лежат замеры БЕЗ фаланг (18 офсетов), и скелет рисовал хардкод-кисть.
   * Переимпортировать руками не надо: если в записи пальцев нет, а в скелете они есть — замеряем и дописываем.
   * Телесные замеры НЕ трогаем — только добавляем отсутствующие ключи.
   * Замер делается ПО БИНД-ПОЗЕ (`skeleton.pose()`), иначе мы бы замерили текущую позу,
   * в которую его уже ведёт риг; следующий `drive()` позу вернёт.
   */
  async function healFingerOffsets(atlas: ModelEntry): Promise<void> {
    const t = asmSkin?.atlasExport(); if (!t) return;
    const isFinger = (n: string): boolean => FINGER_SET.has(n);
    if (Object.keys(atlas.boneOffsets ?? {}).some(isFinger)) return;         // уже вылечено
    if (!Object.keys(t.boneMap).some(isFinger)) return;                      // у модели нет пальцев — нечего лечить
    t.root.traverse((o) => { const sk = (o as THREE.SkinnedMesh).skeleton; if (sk) sk.pose(); });
    t.root.updateMatrixWorld(true);
    const off = measureBoneOffsets(t.root, t.boneMap);
    const add: Record<string, [number, number, number]> = {};
    for (const k of OUR_FINGERS) { const v = off[k]; if (v) add[k] = v; }
    if (!Object.keys(add).length) return;
    atlas.boneOffsets = { ...(atlas.boneOffsets ?? {}), ...add };            // НОВЫЙ объект → редактор увидит смену по ссылке
    asmStatus = `\u0434\u043e\u0437\u0430\u043c\u0435\u0440\u0435\u043d\u044b \u043f\u0430\u043b\u044c\u0446\u044b: +${Object.keys(add).length} \u043e\u0444\u0441\u0435\u0442\u043e\u0432`;
    try {
      const models = cfg.models as ModelEntry[];
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models }) });
    } catch { /* конфиг-сервер мог быть недоступен — в памяти замеры всё равно уже применены */ }
    rebuildAsm();                                                            // source-риг построен со старой геометрией
    renderBody();
  }

  /** Импорт АТЛАСА: FBX/GLB (скелет + все части) → авто-классификация сабмешей → ОДИН GLB → конфиг character → превью. */
  async function importAtlas(get: () => Promise<THREE.Group>, name: string, atlasKey = ''): Promise<void> {
    asmStatus = 'импорт атласа…'; renderBody();
    try {
      const g = await get();
      const meshNames: string[] = []; g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshNames.push(o.name); });
      const slots = classifyAtlas(meshNames);
      const _map = autoBoneMap(skeletonBoneNames(g));
      g.traverse((o) => { const s = (o as THREE.SkinnedMesh).skeleton; if (s) s.pose(); });   // → чистая bind-поза ДО правки
      enforceTPose(g, _map);   // «Enforce T-pose» (как Unity): доворот рук в канон-T, из ЛЮБОЙ позы источника (A/T/гуляющий скелет AccuRIG) → как рыцарь
      const boneScale = measureBoneScales(g, _map);   // ДЛИНЫ костей ФБХ (пропорции) → скелет масштабируется ими
      const boneOffsets = measureBoneOffsets(g, _map);   // rest-офсеты (Y-up) уже в T-позе (руки горизонт) → скелет и клипы совпадают, без A-косяка
      const id = (name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'character');
      const glb = await exportGLB(g);   // экспортим T-позную модель (T-поза в нодах) → рантайм грузит уже канон-T
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });   // g больше не нужен (превью грузит из url)
      const up = await uploadAsset(id, glb, 'model/gltf-binary');
      const key = atlasKey.trim() || undefined;   // пусто = глоб. игрок; для монстра = фракция (напр. 'undead')
      // Ф14.2: карта сохраняется, а не выбрасывается в `{}` — иначе её негде посмотреть и нечем править.
      const e: ModelEntry = { id, name, url: up.url, kind: 'character', classId: key, slots, body: { ...asmProfile }, boneScale, boneOffsets, base: false, hideHair: false, scale: 1, boneMap: _map, submeshMaterials: {} };
      // КОПИЛКА: атласы копятся по ИМЕНИ (id). Заменяем лишь одноимённый (переимпорт того же файла) — все прочие целы.
      const models = (cfg.models as ModelEntry[]).filter((m) => m.id !== id).concat(e);
      const bodyJson = JSON.stringify({ models });
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
      await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
      cfg.models = models; asmAtlas = e;
      rebuildAsm();   // ВСЕГДА пересобираем скин: setAtlas дедуплицирует по URL, а переимпорт того же файла URL не меняет → иначе превью зависло бы на старом GLB
      asmStatus = `атлас «${id}» [${key ?? 'игрок'}]: ${meshNames.length} частей → ${meshNames.map((n) => (slots[n] || '?')).join('/')}`;
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
  /** ЯВНЫЙ ЭКСПОРТ: записать ВСЕ атласы/модели (как есть в cfg.models) в конфиг. Ничего не стирает — просто флаш. */
  async function exportAllAtlases(): Promise<void> {
    const models = cfg.models as ModelEntry[];
    const bodyJson = JSON.stringify({ models });
    await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    const chars = models.filter((m) => m.kind === 'character');
    asmStatus = `📤 экспортировано атласов: ${chars.length} — ${chars.map((m) => `${m.id}[${m.classId ?? 'игрок'}]`).join(', ')}`;
    renderBody();
  }
  /** Сменить ключ (classId) атласа в списке — не переимпортируя файл (пусто = игрок, иначе фракция монстра). */
  async function setAtlasKey(id: string, key: string): Promise<void> {
    const k = key.trim() || undefined;
    const models = (cfg.models as ModelEntry[]).map((m) => (m.id === id ? { ...m, classId: k } : m));
    if (asmAtlas?.id === id) asmAtlas = { ...asmAtlas, classId: k };
    const bodyJson = JSON.stringify({ models });
    await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    cfg.models = models; renderBody();
  }
  /** Выбрать атлас из списка для ПРЕВЬЮ: делаем активным → пересобираем источник+скин под его пропорции, грузим его GLB. */
  function selectAtlas(id: string): void {
    const m = (cfg.models as ModelEntry[]).find((x) => x.id === id && x.kind === 'character');
    if (!m) return;
    asmAtlas = m;
    for (const k of Object.keys(asmVisible)) delete asmVisible[k];   // сброс submesh-тумблеров под новый атлас
    syncProfileFromAtlas();   // слайдеры тела = профиль выбранного (curAtlas теперь = m)
    asmKey = m.classId ?? '';   // поле «Ключ атласа» = ключ выбранного (переимпорт того же файла обновит его)
    asmStatus = `показан атлас «${m.id}» [${m.classId ?? 'игрок'}]`;
    rebuildAsm();             // источник+скин под boneScale/boneOffsets выбранного + загрузка его GLB
    renderBody();
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

  // ── Ось «вверх» → доворот X к +Y. ЗНАКО-ЗАВИСИМО по костям (Hips→Head): +Z→−90°, −Z→+90° (CC/AccuRIG обычно −Z, иначе вверх
  //    ногами), перевёрнутый Y→180°. Без костей — bbox-эвристика «лежит» с дефолтом +Z. Возвращает угол (рад). ──
  function detectUpFixX(obj: THREE.Object3D, boneMap?: Record<string, string>): number {
    obj.rotation.set(0, 0, 0); obj.updateMatrixWorld(true);
    const byName = new Map<string, THREE.Object3D>(); obj.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o); });
    const hips = boneMap ? byName.get(boneMap.Hips ?? '') : undefined;
    const top = boneMap ? (byName.get(boneMap.Head ?? '') ?? byName.get(boneMap.Neck ?? '') ?? byName.get(boneMap.Chest ?? '')) : undefined;
    if (hips && top) {
      const a = hips.getWorldPosition(new THREE.Vector3()), b = top.getWorldPosition(new THREE.Vector3());
      const dy = b.y - a.y, dz = b.z - a.z;
      if (Math.abs(dz) > Math.abs(dy)) return dz > 0 ? -Math.PI / 2 : Math.PI / 2;
      return dy < 0 ? Math.PI : 0;
    }
    const box = new THREE.Box3().setFromObject(obj);
    return (box.max.z - box.min.z) > 1.4 * (box.max.y - box.min.y) ? -Math.PI / 2 : 0;
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
    loaded.rotation.set(upFixX, 0, 0);
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
      upFixX = detectUpFixX(loaded, auto);
      loaded.rotation.set(upFixX, 0, 0); loaded.updateMatrixWorld(true);   // измерять масштаб в стоящей позе
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
      status = `загружено: ${submeshes.length} сабмеш(ей), карта костей ${mapped}/${OUR_BONES.length + OUR_FINGERS.length}, масштаб ${entry.scale}`;
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

  // ── ОРУЖИЕ: один FBX со всеми оружиями → GLB на каждый меш (kind='weapon' + weaponType). ОБЩЕЕ на всех
  //    персонажей (per-char только хват pe_grip). Тип авто-по имени, правится в списке. Как атлас-броня, но per-меш. ──
  const WEAPON_TYPES = ['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff', 'shield'];
  /** Имя меша → weaponType. Порядок важен: узкие перед общими (crossbow до bow, halberd/spear до др.). */
  function classifyWeapon(name: string): string {
    const n = name.toLowerCase();
    if (/shield|buckler|targe|kite|heater/.test(n)) return 'shield';
    if (/crossbow|xbow|arbalest/.test(n)) return 'crossbow';
    if (/bow|longbow|shortbow/.test(n)) return 'bow';
    if (/dagger|knife|dirk|kris/.test(n)) return 'dagger';
    if (/halberd|glaive|poleaxe|pole|bardiche/.test(n)) return 'halberd';
    if (/spear|(?<!s)pike|lance|javelin/.test(n)) return 'spear';   // (?<!s)pike: ловить «pike», но не «spike» (mace_spiked)
    if (/staff|stave|rod/.test(n)) return 'staff';
    if (/wand|scepter|sceptre/.test(n)) return 'wand';
    if (/axe|hatchet|cleaver/.test(n)) return 'axe';
    if (/mace|hammer|maul|club|flail|morningstar/.test(n)) return 'mace';
    if (/sword|blade|falchion|scimitar|katana|sabre|saber|rapier/.test(n)) return 'sword';
    return 'sword';
  }
  async function importWeaponSet(get: () => Promise<THREE.Group>, srcName: string): Promise<void> {
    void srcName; wpnStatus = 'импорт оружия…'; renderBody();
    try {
      const g = await get();
      g.rotation.set(detectUpFixX(g), 0, 0); g.updateMatrixWorld(true);   // Z-up FBX → Y-up (weapon: без костей, bbox-эвристика)
      const meshes: THREE.Mesh[] = [];
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      if (!meshes.length) { wpnStatus = 'в файле нет мешей'; renderBody(); return; }
      const models = cfg.models.slice();
      const made: string[] = [];
      for (const wm of meshes) {
        const weaponType = classifyWeapon(wm.name);
        const clone = g.clone(true) as THREE.Object3D;               // клон сцены → оставить только целевой меш
        const drop: THREE.Object3D[] = [];
        clone.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name !== wm.name) drop.push(o); });
        for (const o of drop) o.parent?.remove(o);
        clone.updateMatrixWorld(true);
        const c = new THREE.Box3().setFromObject(clone).getCenter(new THREE.Vector3());   // рецентр меша в origin (грип позиционирует)
        clone.position.sub(c); clone.updateMatrixWorld(true);
        const glb = await exportGLB(clone);
        clone.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry && m.name !== wm.name) m.geometry.dispose(); });
        const id = ('weapon_' + (wm.name || weaponType)).replace(/[^a-zA-Z0-9_-]/g, '') || ('weapon_' + weaponType);
        const up = await uploadAsset(id, glb, 'model/gltf-binary');
        const e: ModelEntry = { id, name: wm.name || weaponType, url: up.url, kind: 'weapon', weaponType, base: false, hideHair: false, scale: 1, boneMap: {}, submeshMaterials: {} };
        const i = models.findIndex((x) => x.id === id);
        if (i >= 0) models[i] = e; else models.push(e);
        made.push(`${weaponType}:${wm.name}`);
      }
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
      const body = JSON.stringify({ models });
      await fetch('/api/dev/config-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      await fetch('/api/dev/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      cfg.models = models;
      wpnStatus = `оружие: ${meshes.length} → ${made.join(', ')}`;
    } catch (e) { wpnStatus = 'ошибка: ' + (e as Error).message; }
    renderBody();
  }
  /** Сменить weaponType оружия-модели в конфиге (правка авто-классификации). */
  async function setWeaponType(id: string, weaponType: string): Promise<void> {
    const models = (cfg.models as ModelEntry[]).map((m) => (m.id === id ? { ...m, weaponType } : m));
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
    // Ключ атласа: ПУСТО = глобальный игрок; для МОНСТРА = его фракция (напр. 'undead' — все зомби).
    // Так игрок и семьи монстров сосуществуют: импорт заменяет лишь атлас с тем же ключом.
    const keyIn = document.createElement('input'); keyIn.type = 'text'; keyIn.value = asmKey;
    keyIn.placeholder = 'ключ: пусто=игрок, монстр=фракция (undead)'; keyIn.style.cssText = css.input + ';width:100%;margin:3px 0';
    keyIn.oninput = () => { asmKey = keyIn.value; };
    imp.append(el('div', lblCss, 'Ключ атласа (класс/фракция)'), keyIn);
    // Поза источника (A/T) обрабатывается САМА: скелет строится канонически, поза бинда живёт в R_restTarget меш-ретаргета
    // (как Unity Humanoid). Никакого поля угла/выпрямления при импорте не нужно — любой скелет отображается правильно.
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.fbx,.glb,.gltf'; file.style.display = 'none';
    file.onchange = () => { const f = file.files?.[0]; if (f) void importAtlas(() => loadModelFile(f), f.name, keyIn.value); };
    const urlIn = document.createElement('input'); urlIn.type = 'text'; urlIn.value = '/assets/knight_02_modular_rig.fbx'; urlIn.style.cssText = css.input + ';width:100%;margin:3px 0';
    imp.append(btn('📁 Импорт из файла', () => file.click()), file);
    imp.append(urlIn, btn('🌐 Импорт из URL', () => { const u = urlIn.value.trim(); if (u) void importAtlas(() => loadModelUrl(u), u.split('/').pop() ?? 'character', keyIn.value); }));
    body.append(imp);
    if (asmStatus) body.append(el('div', 'color:#c8b06a;font-size:10px;margin:2px 0 6px', asmStatus));

    // КОПИЛКА атласов: ВСЕ сохранённые character-атласы (игрок + семьи монстров) — правка ключа, удаление, явный экспорт.
    const charModels = (cfg.models as ModelEntry[]).filter((m) => m.kind === 'character');
    const curId = curAtlas()?.id;   // активный атлас превью (подсветим ▶)
    const abox = el('div', boxCss);
    abox.append(el('div', headCss, `Атласы-персонажи (${charModels.length}) — 👁 показать · ключ (пусто=игрок) · ✕`));
    if (!charModels.length) abox.append(el('div', 'color:#6b7180;font-size:10px', 'пока пусто — импортни атлас выше'));
    for (const m of charModels) {
      const r = el('div', rowFlex);
      const cur = m.id === curId;
      r.append(el('span', `color:${cur ? '#8fd18f' : '#c0c6d4'};font-size:10px;min-width:100px;overflow:hidden;text-overflow:ellipsis`, (cur ? '▶ ' : '') + m.id));
      const kin = document.createElement('input'); kin.type = 'text'; kin.value = m.classId ?? '';
      kin.placeholder = 'игрок'; kin.style.cssText = css.input + ';flex:1';
      kin.onchange = () => { void setAtlasKey(m.id, kin.value); };
      r.append(btn('👁', () => selectAtlas(m.id)), el('span', lblCss, 'ключ'), kin, btn('✕', () => void deleteModel(m.id)));
      abox.append(r);
    }
    abox.append(btn('📤 Экспорт всех атласов', () => void exportAllAtlases()));
    body.append(abox);

    // Импорт ОРУЖИЯ (один FBX со всеми оружиями → GLB на каждый меш). Доступен всегда (не зависит от атласа).
    const wimp = el('div', boxCss);
    wimp.append(el('div', headCss, 'Оружие (один FBX со всеми → GLB на каждое, kind=weapon; ОБЩЕЕ на всех, хват per-char)'));
    const wfile = document.createElement('input'); wfile.type = 'file'; wfile.accept = '.fbx,.glb,.gltf'; wfile.style.display = 'none';
    wfile.onchange = () => { const f = wfile.files?.[0]; if (f) void importWeaponSet(() => loadModelFile(f), f.name); };
    const wurl = document.createElement('input'); wurl.type = 'text'; wurl.placeholder = '/assets/weapons.fbx'; wurl.style.cssText = css.input + ';width:100%;margin:3px 0';
    wimp.append(btn('📁 Импорт оружия (файл)', () => wfile.click()), wfile);
    wimp.append(wurl, btn('🌐 Импорт оружия (URL)', () => { const u = wurl.value.trim(); if (u) void importWeaponSet(() => loadModelUrl(u), u.split('/').pop() ?? 'weapons'); }));
    body.append(wimp);
    if (wpnStatus) body.append(el('div', 'color:#c8b06a;font-size:10px;margin:2px 0 6px', wpnStatus));
    const weaponModels = (cfg.models as ModelEntry[]).filter((m) => m.kind === 'weapon');
    if (weaponModels.length) {
      const wbox = el('details', boxCss);
      const wsum = document.createElement('summary'); wsum.textContent = `Оружие-модели (${weaponModels.length}) — тип + удалить`; wsum.style.cssText = 'color:#8fa0c0;font-size:11px;cursor:pointer'; wbox.append(wsum);
      for (const w of weaponModels) {
        const r = el('div', rowFlex);
        r.append(el('span', 'color:#c0c6d4;font-size:10px;min-width:90px;overflow:hidden;text-overflow:ellipsis', w.id));
        const tSel = mkSelect(WEAPON_TYPES, w.weaponType ?? 'sword', (v) => { void setWeaponType(w.id, v); }); tSel.style.flex = '1';
        r.append(tSel, btn('✕', () => void deleteModel(w.id)));
        wbox.append(r);
      }
      body.append(wbox);
    }

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

  // Сборка: копируем ПОЗУ манекена editor'а в источник-риг сборки → меш СОВПАДАЕТ с манекеном. Корень (таз) ведём за
  // манекеном (position тоже, не только rotation) — иначе меш стоит в origin, а манекен уезжает при IK-перетаскивании
  // таза → тело «не движется за тазом» + оружие (на кисти манекена) висит мимо меша. Совпадение = обе проблемы решены.
  function driveAsm(source: Humanoid): void {
    if (!asmOn || !asmSrc || !asmSkin) return;
    asmSrc.root.position.copy(source.root.position);       // корень: позиция персонажа
    asmSrc.hips.position.copy(source.hips.position);       // таз ОТДЕЛЬНО (Root ≠ таз): боб/присед/авторский мах таза
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
    boneOffsets: () => curAtlas()?.boneOffsets,   // полные rest-офсеты ФБХ для манекена/призрака (приоритет)
    profile: () => curAtlas()?.body,          // профиль тела атласа (как игра: solid/target с profile) → редактор строит тело им
    refreshProfile: () => { if (asmSkin || asmSrc) rebuildAsm(); },
    hasFingers: () => { const t = asmSkin?.atlasExport(); return !!t && Object.keys(t.boneMap).some((b) => /(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/.test(b)); },
    exportTarget: () => asmSkin?.atlasExport() ?? null,   // Ф2.3: экспорт со скином, если атлас загружен
    handBone: (our) => asmSkin?.atlasBone(our) ?? null,   // кисть ВИДИМОГО атласа (asmSkin) → оружие крепим к мешу, не к манекену
    atlasBone: (our) => asmSkin?.atlasBone(our) ?? null,

    debug: () => ({
      status: asmStatus, atlas: asmAtlas ? { id: asmAtlas.id, url: asmAtlas.url, slots: asmAtlas.slots } : null,
      asmMeshes, asmVisible: { ...asmVisible }, asmProfile: { ...asmProfile }, asmSkinCount: asmSkin ? asmSkin.count() : 0,
      configModels: cfg.models.map((m) => `${m.id}:${m.kind}`),
    }),
    dispose() { if (asmSkin) asmSkin.dispose(); if (asmSrc) scene.remove(asmSrc.root); },
  };
}
