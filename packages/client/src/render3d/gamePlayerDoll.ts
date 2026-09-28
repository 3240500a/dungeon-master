/**
 * ЕДИНАЯ ГУМАНОИД-КУКЛА (Ф5/U3) — ОДИН риг для игрока И монстров: `humanoid`-меш, ведомый физ-рэгдоллом
 * `humanoidRagdoll` ВСЕГДА (как полупрозрачный призрак в редакторе), рисуется общим `renderRagdollGhost`
 * (readBakedPose + заземление стопы). Никакой кинематики/боксов/второго рига. Удар/дёрг/смерть — из физики.
 *
 * Отличие игрок↔монстр только во ВХОДЕ:
 *  • игрок  (`classId` задан) — грузит тюн бега класса (pe_gait→global GAIT/POSE) + стойки/удары класса + оружие класса;
 *  • монстр (`classId` нет)   — общий (уже загруженный) GAIT/POSE, пустой контент (дефолт-стойка), цвета фракции, масштаб.
 * `applyGaitConfig` пишет в ГЛОБАЛЬНЫЕ GAIT/POSE — это и есть «настроить один раз для всех»: монстры делят тюн игрока.
 * API = `RagdollHandle` — game3d.sync/события/камера без переписывания.
 */
import * as THREE from 'three';
import { buildHumanoid, type BuildScale } from './humanoid.js';
import { PhysWorld, type RagdollHandle } from './ragdoll.js';
import { makeHumanoidRagdoll, PIN_SRC, RAG_NAMES, weaponHandMasses, renderRagdollGhost, renderKinematicPose, newGhostGround, PHYS } from './humanoidRagdoll.js';
import { pickAttack, ATTACK_VARY } from './attackPick.js';   // ⭐ очередь ударов: порядок + шанс разнообразия
import { GAIT } from './gaitKnobs.js';
import { BASE_GAIT_CHAR } from './locoBlend.js';   // ⭐ донор набора хода — один на игроков и монстров
import { PosePlayer, localStorageContent, applyGaitConfig, loadGaitLocal, loadPlantGrid, loadMatch, loadFootLift, loadTwistStates, applyBaseGrip, renderMatchWeight, type GXKnobs } from './poseRuntime.js';
import { attachWeapons , hostWeaponOnHand, disposeWeaponGroup} from './weapon3d.js';
import { applyCraftLooks } from './craftWeapon3d.js';
import { weaponLookSig, type ConfigRegistry, type WeaponLook } from '@dm/shared';
import { charFor } from './chars3d.js';
import { createModelSkin, loadAssetConfig, resolveSlotModels, resolveCharacterModel, applyWeaponModels } from './modelSkin.js';
import type { BodyProfile, BoneScale } from './bodyProfile.js';

const GX_DEFAULT = (): GXKnobs => ({ armDown: 1.35, elbowBend: 0.25 });   // legWidth/bob убраны (дубль stanceWidth / боб в GAIT)
const PELVIS_Y = 32;
const KNOCK = 3.5;   // сила отброса трупа при frac=1 — ~1.5 м макс (32 ед = 1 м) при 100% урона от HP; меньше урон — ближе
const HIT_PHYS_DUR = 0.5;   // сек транзиентной физики в kinematic-режиме на хит-реакцию (перекрывает limp ~0.4с), потом назад в кинематику
const GROUND0 = (): number => 0;   // плоский пол y=0 (как в физ-рендере при groundAt=undefined) для kinematic FOOT-IK
const DEF_PINKP = PHYS.pinKp;   // дефолт жёсткости пинов — восстанавливаем вне удара (PHYS глобальна, шарится дллами: каждая dll ставит своё перед update)
const DEF_MUSCLE = PHYS.muscle; // дефолт силы моторов — рампим во время подъёма из нокдауна, потом восстанавливаем

export interface HumanoidDollOpts {
  x: number; z: number;
  weapon: string;                                    // редакторный ключ оружия ('axe','staff','none',…)
  weaponModels?: { main?: string; off?: string };    // Ф3: id 3D-моделей оружия (kind:'weapon') на main/off руки → GLB вместо процедурки (общее на всех)
  weaponLook?: WeaponLook;                           // D22: из чего сделано оружие (база + детали по рукам) → модель ковки вместо процедурки
  craftReg?: ConfigRegistry;                         // реестр для модели ковки; нет — вид не строится (монстры, стенды)
  classId?: string;                                  // задан → ИГРОК (гейт класса → global GAIT + контент класса)
  atlasKey?: string;                                 // ключ атласа для МОНСТРА (семья subfaction||faction): скин по нему БЕЗ глобал-фолбэка (нет атласа→процедурка)
  baseAppearance?: { hair?: string; head?: string; hands?: string; body?: string; feet?: string };   // submesh-вид пустых слотов (нет экипа): hair→helm/head/gloves(hands)/chest(body)/boots(feet)
  gaitId?: string;                                   // задан (без classId) → МОНСТР: локальный plant/gx + контент этого id
  gaitFallback?: string;                             // фолбэк для gaitId, если он ещё не настроен (монстры → 'warrior')
  colors?: { body?: number; limb?: number; head?: number };
  scale?: number;                                    // масштаб меша (чемпионы крупнее); физика — в базовом размере
  gender?: 'male' | 'female'; build?: BuildScale;    // если не заданы и есть classId — из charFor
  profile?: BodyProfile;                             // модульные пропорции (рост/руки/ноги/торс/толщина); импорт-меш конформится
  boneScale?: BoneScale;                             // пер-костные множители из ФБХ → наш физ-скелет 1:1 повторяет модель
  boneOffsets?: Record<string, number[]>;            // ПОЛНЫЕ rest-офсеты из ФБХ (приоритет над boneScale) — геометрия 1:1
}

export function makeHumanoidDoll(pw: PhysWorld, opts: HumanoidDollOpts): RagdollHandle {
  const gx = GX_DEFAULT();
  // Игрок: тюн бега класса → global GAIT/POSE + плант + стойки/удары класса.
  // Монстр (gaitId): локальный plant/gx (global GAIT делит с игроком) + контент gaitId с фолбэком (→ Волкодав).
  const plant = opts.classId ? applyGaitConfig(opts.classId, gx)
    : opts.gaitId ? loadGaitLocal(opts.gaitId, gx, opts.gaitFallback)
      : loadPlantGrid(undefined);
  // ⭐⭐ ДОНОР ПОХОДКИ ЕСТЬ У ВСЕХ, включая игроков. До 19.09 класс собирался БЕЗ донора вовсе, и класс
  // без своего запечённого `run_fwd` уезжал в игре на процедурный планировщик (`clipOnly` требует
  // `hasLocoSet()`). ⚠ Донор ХОДА узкий и подменяет ТОЛЬКО клип локомоции: обычный `fallbackId` отдал бы
  // магу ещё и воинские стойки, удары и классификацию предметов (`readAnimCfg` берёт конфиг целиком).
  const content = opts.classId ? localStorageContent(opts.classId, undefined, BASE_GAIT_CHAR)
    : opts.gaitId ? localStorageContent(opts.gaitId, opts.gaitFallback, BASE_GAIT_CHAR)
      : localStorageContent('__none__');
  // Вес совпадения рендера с манекеном (RB2) — настроенный в редакторе per-персонаж (pe_phys). Монстр → фолбэк.
  const matchWeight = opts.classId ? loadMatch(opts.classId) : opts.gaitId ? loadMatch(opts.gaitId, opts.gaitFallback) : 0;
  // Профили скрутки корпуса (torso-lead) per-персонаж, ПО СОСТОЯНИЮ (стой/ходьба/бег): игрок → по classId, монстр → по gaitId с фолбэком.
  const twistStates = opts.classId ? loadTwistStates(opts.classId) : opts.gaitId ? loadTwistStates(opts.gaitId, opts.gaitFallback) : loadTwistStates('__none__');
  let weapon = opts.weapon;
  const ch = opts.classId ? charFor(opts.classId) : null;
  const gender = opts.gender ?? ch?.gender ?? 'male';
  const build = opts.build ?? ch?.build ?? {};
  const col = opts.colors ?? {};

  const profile = opts.profile;   // модульные пропорции: solid/target строятся с ним, импорт-скин конформится к solid
  const boneScale = opts.boneScale;   // пер-костные множители из ФБХ → физ-скелет повторяет модель 1:1
  const boneOffsets = opts.boneOffsets;   // ПОЛНЫЕ rest-офсеты из ФБХ (приоритет) — точная геометрия скелета
  const group = new THREE.Group();
  // solid — ВИДИМЫЙ humanoid-меш, ведём результатом физики (как призрак в редакторе). Оружие на кистях.
  // ⭐ `fingers: true` ОБЯЗАТЕЛЕН: хват приезжает ЗАПЕЧЁННЫМ В КЛИПЫ (30 каналов фаланг в кадре), но
  // без КОСТЕЙ ему некуда приземляться — `bones.get(...)` отдаёт undefined, и канал молча теряется.
  // Раньше здесь стояло «в игре пальцы не нужны, хват впечён в клип» — впечён, да только в пустоту.
  // Мешей у фаланг в solid-стиле нет (см. `buildHumanoid`), так что это +30 пустых групп, не геометрия.
  const solid = buildHumanoid({ gender, build, body: col.body ?? 0x8a93ad, limb: col.limb ?? 0x6f7690, head: col.head, profile, boneScale, boneOffsets, fingers: true });
  if (opts.scale && opts.scale !== 1) solid.root.scale.setScalar(opts.scale);   // визуальный масштаб (физика базовая)
  solid.root.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });   // тени от факелов (вкл. по тумблеру) — актёр отбрасывает
  group.add(solid.root);
  const gripChar = opts.classId ?? opts.gaitId ?? '';   // ключ для базового хвата pe_grip (игрок→class, монстр→gaitId)
  let weaponModels = opts.weaponModels;   // id GLB-моделей оружия (main/off) — общие на всех; меняются со сменой оружия
  let weaponLook = opts.weaponLook;       // D22: вид из деталей по рукам — у себя из сейва, у пиров из `peerInfo`; один путь
  const craftReg = opts.craftReg;
  const craftOf = (): { reg: ConfigRegistry; look?: WeaponLook } | undefined => (craftReg && weaponLook ? { reg: craftReg, look: weaponLook } : undefined);
  /** Подпись вида: смена оружия — по ней, а не только по ключу (у всех одноручных мечей ключ один — `sword`). */
  const lookKey = (l: WeaponLook | undefined): string => `${weaponLookSig(l?.main)}#${weaponLookSig(l?.off)}`;
  let weaponGroups = attachWeapons(solid, weapon, weaponModels, craftOf()); applyBaseGrip(weaponGroups, gripChar, weapon, opts.gaitFallback);   // единый базовый хват
  // Ф3: свап процедурных мешей на GLB (если у экипа задан modelId оружия). Дёшево-ноуп без моделей (монстры/без GLB).
  const syncWeaponModels = (): void => { if (!(weaponModels?.main || weaponModels?.off)) return; void loadAssetConfig().then((cfg) => applyWeaponModels(weaponGroups, cfg, { materials: cfg.materials, textures: cfg.textures })); };
  syncWeaponModels();
  // D22: построитель модели ковки грузится лениво — руки, которые встали процедурными, доснабжаются по загрузке.
  const syncCraftLooks = (): void => { if (craftReg && weaponLook) void applyCraftLooks(weaponGroups, craftReg); };
  syncCraftLooks();
  // target — НЕВИДИМЫЙ манекен-источник позы: PosePlayer его позирует, с него кормим физику (цель + пины).
  const target = buildHumanoid({ gender, build, profile, boneScale, boneOffsets, fingers: true });   // цель позы — тот же набор костей, что у solid
  target.root.visible = false; group.add(target.root);
  // Подъём стопы per-персонаж (pe_phys.footLift): поднимает цель стойки (standY) и заземления → подошва МЕША атласа на полу
  // (лодыжка выше FOOT_Y, иначе тонет). solid грунтится footIk, target даёт standY через PosePlayer → оба должны совпадать.
  solid.footLift = target.footLift = opts.classId ? loadFootLift(opts.classId) : opts.gaitId ? loadFootLift(opts.gaitId, opts.gaitFallback) : 0;
  // физ-рэгдолл — единый риг. Собственные полупрозрачные боксы не показываем (рисуем solid).
  const ragdoll = makeHumanoidRagdoll(pw);
  ragdoll.group.visible = false; group.add(ragdoll.group);
  ragdoll.setPelvis(new THREE.Vector3(opts.x, PELVIS_Y, opts.z), new THREE.Quaternion());

  const player = new PosePlayer(target, () => weaponGroups, content, weapon, gx, plant, twistStates);
  /**
   * ⭐ ФАЗА ЖИВОЙ СТОЙКИ — ОТ ТОЧКИ СПАВНА, а не от случайного числа: то же место даёт ту же фазу, значит
   * кадр воспроизводим, и сторожа не начинают мигать. Разброс 0…20 с перекрывает самый длинный айдл
   * пакета (15.8 с); `stancePoseAt` всё равно берёт остаток от длительности.
   */
  player.setIdlePhase(((Math.abs(Math.sin(opts.x * 12.9898 + opts.z * 78.233)) * 43758.5453) % 20));
  player.setIdleBreaks(true);   // редкие вставки в покой — только у игровых кукол; запекатель их не включает
  const ground = newGhostGround();     // сглаженный прижим низшей стопы к полу (общий с редактором)

  // ── C6b: слой скинов (импортные GLB по слотам) поверх процедурного solid — только для игрока (classId).
  //    Ретаргет ведётся solid (физ-результат). База слотов из config `models` (base=true); свап по экипу — setAppearance. ──
  // Ключ атласа: игрок = classId (фолбэк на глобальный ок); монстр = atlasKey (СТРОГО — нет атласа → процедурка).
  const atlasKey = opts.classId ?? opts.atlasKey;
  const atlasStrict = !opts.classId && !!opts.atlasKey;   // монстр: без своего атласа не подмешиваем глобальный/легаси
  const skin = atlasKey ? createModelSkin(group, solid) : null;
  const baseApp = opts.baseAppearance;   // submesh пустых слотов (нет экипа)
  let equipModels: Record<string, { modelId?: string; materialId?: string } | undefined> | undefined;
  // Экипировка → выбор сабмеш-варианта по слоту атласа (modelId = имя сабмеша-варианта). Незнакомый id безопасен
  // (setAtlas variant-safe: покажет все сабмеши слота). Волосы прячет ТОЛЬКО показ реальной модели шлема (=выбор
  // helm-варианта в атласе), а НЕ сам факт надетого шлема-предмета — иначе стат-шлем без модели балдил бы голову
  // (и расходился с редактором, где волосы всегда видны в базе).
  function atlasVisible(atlas?: { slots?: Record<string, string> }): Record<string, string> {
    const visible: Record<string, string> = {};
    // Пустой слот → базовый submesh-вид класса (baseAppearance); надетый предмет (modelId) перекрывает.
    const baseBySlot: Record<string, string | undefined> = baseApp ? { helm: baseApp.hair, head: baseApp.head, gloves: baseApp.hands, chest: baseApp.body, boots: baseApp.feet } : {};
    // ⚠ А ЕСЛИ ВЫБОРА НЕТ ВООБЩЕ — БЕРЁМ ПЕРВУЮ ДЕТАЛЬ СЛОТА, А НЕ ВСЕ.
    //
    // Здесь стояло «ключ не задаём → setAtlas покажет все submesh слота, как раньше». На атласе из двух-трёх
    // деталей это было незаметно, а на живом (38 частей) даёт кашу: ЗАМЕР в игре — видимых сабмешей 38 из 38,
    // из них 16 шлемов на одной голове, 12 нагрудников, 7 сапог. Глазами это «какая-то непонятная модель»:
    // белый ком вместо рыцаря. Надеть шестнадцать шлемов нельзя ни при каких данных, поэтому «все» — не
    // разумное умолчание ни для одного слота. Порядок берём СТАБИЛЬНЫЙ (сортировка по имени), иначе вид
    // персонажа менялся бы от загрузки к загрузке вместе с порядком ключей в конфиге.
    const firstOf = (slot: string): string | undefined => {
      const sl = atlas?.slots; if (!sl) return undefined;
      return Object.keys(sl).filter((n) => sl[n] === slot).sort()[0];
    };
    for (const slot of ['helm', 'head', 'chest', 'gloves', 'boots']) {
      const id = equipModels?.[slot]?.modelId ?? baseBySlot[slot] ?? firstOf(slot);
      if (id) visible[slot] = id;
    }
    return visible;
  }
  // Пер-предметный материал по слоту (materialByClass надетого предмета) → override материала сабмеша атласа.
  function atlasMaterials(): Record<string, string> {
    const mats: Record<string, string> = {};
    for (const slot of ['helm', 'head', 'chest', 'gloves', 'boots']) { const mid = equipModels?.[slot]?.materialId; if (mid) mats[slot] = mid; }
    return mats;
  }
  function refreshSkin(): void {
    if (!skin) return;
    void loadAssetConfig().then((cfg) => {
      const assets = { materials: cfg.materials, textures: cfg.textures };
      const char = resolveCharacterModel(cfg, atlasKey, !atlasStrict);   // E3: атлас по ключу (класс/семья); монстр строго (нет→процедурка)
      if (char) { void skin.setAtlas(char, atlasVisible(char), assets, { matBySlot: atlasMaterials() }); return; }   // = превью редактора (без hideHair) + пер-предметный материал
      if (atlasStrict) return;   // монстр без своего атласа → процедурный меш (не подмешивать легаси base-парты)
      void skin.set(resolveSlotModels(cfg, equipModels), assets);   // легаси: послотные GLB
    });
  }
  refreshSkin();

  // ── состояние синхронизации ──
  let tx = opts.x, tz = opts.z, tyaw = 0, lastX = opts.x, lastZ = opts.z, first = true, dead = false;
  let simEnabled = true, snapNext = false;   // окно-culling: вне экрана усыпляем физику (тела вон из pw.step), меш замерзает
  // Пробуждение из окна-culling: поставить ТЕЛА на позу (не только rx/rz). Без снапа kinematic-таз за один шаг летел
  // через весь путь, пройденный во сне, и тащил верх. ЗАМЕР (живой Jolt, скачок 200u, 30/60/144 Гц): голова
  // 176–193u от своего места у таза, к <10u — через 0.95–1.3 с; со снапом — 0.0u, 0 кадров. Отдельный флаг:
  // snapNext ставят ещё конец нокдауна и конец транзиентной физики удара — там тела уже на месте, лишний SetPose
  // съел бы импульс.
  let wakeSnap = false;
  let kinematic = false, physHold = 0;       // debug-режим «кинематика»: рисуем из позы, физика лишь транзиентно (physHold сек) на удар/смерть
  let poseLod = false;                        // поза-LOD дальних монстров: пропуск FOOT-IK (заземления стоп) — дёшево, детали стоп вдали не видно
  // Нокдаун (сбить с ног): downT>0 — идёт коллапс+подъём (не смерть). downRise — длительность фазы подъёма; riseInit —
  // однократный переход коллапс→подъём (записываем упавшую позицию таза + возвращаем моторы). risePos — таз на полу.
  let downT = 0, downRise = 0.8, riseInit = false;
  const risePos = new THREE.Vector3();
  // ⭐ Нокдаун СПЯЩЕЙ куклы (вне окна): её не будим, часы нокдауна идут в `update` и во сне, а падение отложено до
  // пробуждения — `fallPending` + направление толчка. Было: `knockdown` будил куклу, а `a.dormant` у клиента оставался
  // true → луп монстров её больше не вёл: часы нокдауна стояли, тела лежали в `pw.step` на месте нокдауна, и смерть за
  // окном без удара (DoT) падала оттуда. ЗАМЕР (копия кадра online3d, живой Jolt, кукла монстра; сбит спящим → встал →
  // ушёл на 300u → DoT за окном; 60 / 144 Гц, физ / kinematic): труп запечён в 316 / 314u от монстра, тела в физике за
  // окном 325 / 777 кадров. И часы: кукла, уснувшая лёжа (или сбитая во сне), просыпалась в окне уже после подъёма
  // сервера и доигрывала нокдаун у игрока на глазах — лёжа 47–171 кадр, пока монстр шёл.
  let fallPending = false, fallDx = 0, fallDz = 0;
  // Членство тел в pw.step: активны только если кукла не усыплена окном И (мертва | нокдаун | физрежим | транзиентная физика удара).
  // → true, если тела ТОЛЬКО ЧТО вернулись в мир: они там, где их вынули (сон окна / kinematic-режим), а не где кукла сейчас.
  let simIn = true;
  const syncRagdollSim = (): boolean => {
    const was = simIn;
    simIn = simEnabled && (dead || downT > 0 || !kinematic || physHold > 0);
    ragdoll.setSimEnabled(simIn);
    return simIn && !was;
  };
  // ⚠ Тела вернулись на СМЕРТЬ/НОКДАУН — сначала на текущую позу, потом коллапс: иначе труп падает с места, где тела
  // вынули, и рисуется оттуда (из тела, `pelvisTarget` = null). ЗАМЕР (живой Jolt, кукла монстра, 100 u/с 2–2.5 с до
  // события): смерть спящего — труп в 200u от сервера, kinematic-режима — 250u (стало 0); нокдаун — тело таза лёжа в
  // 177–221u от сервера (стало 19–23u, отлёт падения), голова тела на подъёме от позы 163–223u (стало 17–23u). Спящему (`culled`)
  // ещё и мир-позицию на сервер: во сне `update` не шёл, rx/rz стухли вместе с телами.
  const snapStaleBodies = (culled: boolean): void => {
    if (culled) { rx = tx; rz = tz; }
    driveRagdollToPose(); ragdoll.snapToPose();
  };
  // Нокдаун кончился (встал) → обычный режим. Зовётся и во сне (часы идут и там): тела тогда вне мира — `setDead(false)`
  // меняет только тип тела таза, Jolt не активирует тело вне broadphase (замер), тела в мир вернёт пробуждение.
  const endKnockdown = (): void => {
    downT = 0; fallPending = false;
    if (!riseInit) ragdoll.setDead(false);
    riseInit = false; snapNext = true; syncRagdollSim();
  };
  let atkLast: string | null = null;   // ПОСЛЕДНИЙ СЫГРАННЫЙ удар — по нему считается следующий (см. `attackPick`)
  let wvx = 0, wvz = 0, hasWvel = false, vxS = 0, vzS = 0;
  let rx = opts.x, rz = opts.z;            // сглаженная мир-позиция (сим 30Гц телепортит tx/tz)
  const off = new THREE.Vector3(), pelWorld = new THREE.Vector3(), hipsQ = new THREE.Quaternion();
  const pinVecs = RAG_NAMES.map(() => new THREE.Vector3());
  const NO_PINS: (THREE.Vector3 | null)[] = RAG_NAMES.map(() => null);   // подъём из нокдауна: без мир-пинов (иначе тянут конечности к стоячим позициям при низком тазе)
  const pinArr: (THREE.Vector3 | null)[] = RAG_NAMES.map(() => null);

  function applyWeaponLoad(): void {   // вес оружия оттягивает держащую кисть (для физ-реакций/маха)
    const [mHR, mHL] = weaponHandMasses(weapon);   // main+off: главное → правая, щит/второе оружие → левая
    ragdoll.setLoad('HandR', mHR); ragdoll.setLoad('HandL', mHL);
  }

  // Прогнать физику к позе-цели на мир-позиции (таз + пины). Не зовём на смерти (там свободный коллапс).
  function driveRagdollToPose(): void {
    off.set(rx, 0, rz);
    target.root.updateMatrixWorld(true);
    const hips = target.bones.get('Hips')!;
    hips.getWorldPosition(pelWorld).add(off); hips.getWorldQuaternion(hipsQ);
    ragdoll.setPelvis(pelWorld, hipsQ);
    ragdoll.setPoseTarget(target.readPose());
    for (let i = 0; i < RAG_NAMES.length; i++) {
      const src = PIN_SRC[RAG_NAMES[i]!]; const b = src ? target.bones.get(src) : undefined;
      if (b) { b.getWorldPosition(pinVecs[i]!).add(off); pinArr[i] = pinVecs[i]!; } else pinArr[i] = null;
    }
    ragdoll.setPinTargets(pinArr);
    applyWeaponLoad();
  }

  // Kinematic-режим: включить транзиентную физику на хит-реакцию — вернуть тела в pw.step, поставить их на ТЕКУЩУЮ
  // позу (иначе импульс дёрнет стухшие тела), завести окно physHold. Дальше физ-путь ведёт моторами, потом снап назад.
  function startHitPhysics(): void {
    physHold = HIT_PHYS_DUR;
    syncRagdollSim();          // тела → в pw.step
    driveRagdollToPose();      // загрузить текущую позу-цель + пины + таз
    ragdoll.snapToPose();      // тела на позу, скорости 0 (импульс ниже даст чистый дёрг)
  }

  // СПАВН: сразу поставить рэгдолл в idle-стойку (иначе перехлёст T-поза→стойка болтает верх тела ~1с).
  player.setVel(0, 0); player.setYaw(0); player.step(1 / 60);
  driveRagdollToPose(); ragdoll.snapToPose();
  // И СРАЗУ отрисовать СОЛИД в позу — иначе монстр, заспавненный ВНЕ окна (сразу усыплён, update() не зовётся),
  // висит в сырой T-позе из buildHumanoid до первого пробуждения. Виден за стеной (нет тумана) как «Т-поза».
  renderRagdollGhost(solid, ragdoll, ground, 1 / 60, 0, true, null, 0);

  // 2B: оружие крепим к кисти ВИДИМОГО атлас-меша (skin.atlasBone), не к solid — иначе offset ретаргета (solid≠атлас).
  // `.add` сохраняет локаль (авторский хват). Нет атласа/не загружен → на solid (как было). Зовём после skin.update().
  /** 2B: каждый кадр оружие висит на кисти видимого меша. Вся логика (и почему она такая) — в `weapon3d.hostWeaponOnHand`. */
  function syncWeaponHost(): void {
    for (const g of weaponGroups) {
      const hn = g.userData.handBone as string | undefined; if (!hn) continue;
      hostWeaponOnHand(g, skin?.atlasBone(hn) ?? null, solid.bones.get(hn) ?? null);
    }
  }

  return {
    group,
    setPose(x, z, yaw) { if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(yaw)) { tx = x; tz = z; tyaw = yaw; } },
    setMove(_s) { /* магнитуда не нужна: скорость из setWorldVel или дельты позиции */ },
    setWorldVel(vx, vz) { if (Number.isFinite(vx) && Number.isFinite(vz)) { wvx = vx; wvz = vz; hasWvel = true; } },
    attack(clips, windowSec, windupSec) {   // скил с poseClips → его позы (адаптированные под оружие); иначе базовая атака = все hit_-клипы оружия. Цикл по кругу.
      const pool = (clips && clips.length)
        ? clips.map((n) => content.resolveAbilityClip(n, weapon)).filter((c): c is NonNullable<typeof c> => !!c)
        : content.attackClips(weapon);
      // ⭐ ОДНО ПРАВИЛО ОЧЕРЕДИ НА ОБА ИСТОЧНИКА (свинг сервера и автосцепка по окну комбо), и состояние
      // у него — ПОСЛЕДНИЙ СЫГРАННЫЙ клип. Счётчик тут не годится: его крутили двое, на пуле из двух
      // ударов «+2» за цикл — тождество, и потому зажатая мышь повторяла один и тот же удар.
      const names = pool.map((c) => c.name);
      const take = (): (typeof pool)[number] | null => {
        const i = pickAttack(names, atkLast, ATTACK_VARY);
        return i < 0 ? null : pool[i]!;
      };
      player.comboNext = pool.length ? () => { const c = take(); if (c) atkLast = c.name; return c; } : null;
      if (pool.length) {
        const c = take();
        // ⚠ СЧИТАЕМ УДАР СЫГРАННЫМ ТОЛЬКО ЕСЛИ ОН ДЕЙСТВИТЕЛЬНО ЗАПУСТИЛСЯ: свинг, подавленный
        // перехватом автосцепки, ничего не играет — и очередь двигать не должен.
        if (c && player.triggerAttack(c, windowSec, windupSec)) atkLast = c.name;
      } else player.triggerAttack(content.attackClip(weapon), windowSec, windupSec);   // ничего не авторено → прежний фолбэк
    },
    /** Атака зажата: пока true, удар на конце окна комбо переходит в следующий, а не в стойку. */
    setAttackHold(on) { player.attackHold = on; },
    /** Метки кадров — просто пробрасываем наружу: кукла не знает ни про звук, ни про VFX. */
    get onMark() { return player.onMark; },
    set onMark(fn) { player.onMark = fn ?? null; },
    setDead(d) {
      const culled = d && !simEnabled;
      if (culled) { simEnabled = true; snapNext = true; }   // умер спящим (вне окна) → будим, чтоб коллапс отыгрался
      if (d) { downT = 0; riseInit = false; fallPending = false; }   // смерть главнее нокдауна: обрываем подъём, дальше свободный коллапс
      if (d === dead) return; dead = d;
      const back = syncRagdollSim();   // dead → тела в pw.step (коллапс) в ЛЮБОМ режиме (в т.ч. kinematic)
      if (d && back) snapStaleBodies(culled);   // ДО `setDead(true)`: снап ставит цель таза, смерть её отпускает
      ragdoll.setDead(d);
    },
    setSimEnabled(on) {   // окно-culling: on=false → тела вон из физ-мира (pw.step их не считает), меш замерзает; on=true → вернуть + снап к цели
      if (on === simEnabled) return; simEnabled = on;
      if (on) { snapNext = true; wakeSnap = true; }
      if (on && fallPending) {   // сбит во сне: тела на позу в НОВОЙ точке; лежать ещё есть когда → падение отсюда, иначе сразу подъём из стойки
        fallPending = false;
        if (syncRagdollSim()) snapStaleBodies(true);
        if (downT > downRise) { ragdoll.setDead(true); ragdoll.hit('Torso', fallDx, 0.12, fallDz, 0.5); }
        return;
      }
      syncRagdollSim();
    },
    setPhysicsMode(mode) {   // debug: 'kinematic' = рисуем из позы (тела вон из pw.step), физика лишь транзиентно на удар/смерть; 'physics' = обычно
      const kin = mode === 'kinematic';
      if (kin === kinematic) return;
      kinematic = kin; physHold = 0; snapNext = true;
      syncRagdollSim();
      if (!kinematic && simEnabled && !dead) { driveRagdollToPose(); ragdoll.snapToPose(); }   // назад в физику: тела на текущую позу (без флейла)
    },
    setPoseLod(on) { poseLod = on; player.setNoIk(on); },   // дальний монстр в кадре → без FOOT-IK (рендер) + off-hand IK (поза)
    hitReact(dx, dz, power = 1) {   // дёрг → из физики (солид = физрезультат); в kinematic — поднимаем физику на HIT_PHYS_DUR
      if (kinematic && !dead && physHold <= 0) startHitPhysics();
      ragdoll.hit('Torso', dx, 0.35, dz, power);
    },
    knockback(dx, dz, frac) {   // отброс трупа: сильный горизонтальный импульс в таз+торс, дальность ∝ доле урона
      if (kinematic && !dead && physHold <= 0) startHitPhysics();   // (обычно knockback на смерти → dead=true, физика уже поднята)
      const p = Math.max(0, Math.min(1, frac)) * KNOCK;
      ragdoll.hit('Hips', dx, 0.1, dz, p); ragdoll.hit('Torso', dx, 0.18, dz, p * 0.5);
    },
    knockdown(dx, dz, downSec, riseSec) {   // сбит с ног: коллапс рагдоллом в (dx,dz), лежит, потом ВСТАЁТ (см. ветку downT в update)
      if (dead) return;
      downRise = Math.max(0.05, riseSec);
      downT = Math.max(0.1, downSec) + downRise;
      riseInit = false;
      // Сбит спящим (вне окна) → НЕ будим: часы пошли, падение — при пробуждении (`setSimEnabled`), если ещё лежать.
      if (!simEnabled) { fallPending = true; fallDx = dx; fallDz = dz; return; }
      fallPending = false;
      if (syncRagdollSim()) snapStaleBodies(false);   // тела в pw.step на весь нокдаун; вернулись стухшими (kinematic-режим) → на позу
      ragdoll.setDead(true);     // моторы off + таз dynamic → падение. Горизонт. отлёт даёт СЕРВЕР (глайд позиции); тут только опрокидывание.
      ragdoll.hit('Torso', dx, 0.12, dz, 0.5);   // мягкий толчок верха назад → валится ОТ атакующего (не «взрыв»)
    },
    setWeapon(key, models, look) {   // сменить оружие/щит: снести старые меши, собрать новые, обновить PosePlayer (стойка/удар по оружию)
      // ⚠ МОДЕЛИ ЧИТАЕМ ДО РАННЕГО ВЫХОДА, И ВЫХОДИМ ТОЛЬКО ЕСЛИ НЕ ИЗМЕНИЛОСЬ НИЧЕГО.
      //
      // Было `if (key === weapon) return;` СТРОКОЙ ВЫШЕ присваивания — а ключ строится из КЛАССА оружия
      // и числа рук (`weapon3dKeyFromEquipment`), то есть у всех одноручных мечей он один: `sword`.
      // Сменил меч на другой меч (другая база → другой `modelId`, обычное дело в лутовой игре) — ключ
      // прежний, функция выходила, и на персонаже оставалась модель ПРЕДЫДУЩЕГО клинка до конца сессии.
      // То же на офф-руке: сменил щит при том же мече — ключ `sword+shield` не менялся.
      // D22: то же с видом из деталей — сковал другой меч того же класса, ключ прежний, а подпись деталей другая.
      const sameModels = models === undefined || JSON.stringify(models) === JSON.stringify(weaponModels);
      const nextLook = look === undefined ? weaponLook : look ?? undefined;   // undefined — вид не трогаем, null — снять
      if (key === weapon && sameModels && lookKey(nextLook) === lookKey(weaponLook)) return;
      if (models !== undefined) weaponModels = models;   // Ф3: новые id GLB-моделей оружия (self); пиры — undefined (нужна сеть)
      weaponLook = nextLook;
      // Новые руки — ДО сноса старых: тот же вид (сменил только щит) берётся из кэша, а не строится заново.
      const old = weaponGroups;
      weapon = key; weaponGroups = attachWeapons(solid, weapon, weaponModels, craftOf()); applyBaseGrip(weaponGroups, gripChar, weapon, opts.gaitFallback); player.setWeapon(weapon);
      for (const g of old) disposeWeaponGroup(g);
      syncWeaponModels();
      syncCraftLooks();
    },
    setAppearance(equip) { equipModels = equip; refreshSkin(); },   // C6c: слоты брони (modelId) → пересобрать скин-слой

    setCombat(on) { player.setCombat(on); },   // боевой айдл (сервер-авторитетный флаг → боевая стойка)
    setState(stunned, downed) { player.setState(stunned, downed); },   // стан/нокдаун → клип реакции (Ф1.5)
    update(dt) {
      // Спит (вне окна): физика вынута, меш заморожен в позе — не считаем. Но часы нокдауна идут (клиент зовёт `update`
      // и спящему — см. `windowCull`): проснётся в той же фазе, что сервер, а не доигрывать встающего на глазах.
      if (!simEnabled) { if (downT > 0 && (downT -= dt) <= 0) endKnockdown(); return; }
      const woke = wakeSnap; wakeSnap = false;               // гасим в ЛЮБОЙ ветке: запоздалый снап съел бы импульс удара позже
      if (dead) {                                            // мёртв — свободный коллапс, рендерим без прижима
        ragdoll.update(dt);
        renderRagdollGhost(solid, ragdoll, ground, dt, 0, false);
        skin?.update(); syncWeaponHost();                                      // GLB-слои ведутся solid (после позирования физрезультатом)
        return;
      }
      if (downT > 0) {                                       // НОКДАУН: лежит (свободный коллапс) → встаёт (таз лерпит к стойке). dead отсечён выше.
        downT -= dt;
        if (snapNext) { rx = tx; rz = tz; snapNext = false; }
        rx += (tx - rx) * 0.12; rz += (tz - rz) * 0.12;      // мир-позиция плавно к цели (сервер держит монстра на месте, пока лежит)
        player.setVel(0, 0); player.setYaw(tyaw); if (first) { player.snapYaw(); first = false; } player.step(dt);   // манекен в idle-стойку — цель подъёма
        if (downT > downRise) {                              // ЛЕЖИТ: свободный коллапс (поза/падение — физика), но КОРЕНЬ по серверной позиции
          ragdoll.update(dt);
          renderRagdollGhost(solid, ragdoll, ground, dt, 0, false);
          solid.root.position.x = rx; solid.root.position.z = rz; solid.root.updateMatrixWorld(true);   // XZ = серверная позиция (авторитетный отлёт), Y от физики (падение) → без рассинхрона
        } else {                                             // ВСТАЁТ: таз обратно kinematic и лерпит с пола к стойке, верх блендит физику→позу
          // Подъём из СЕРВЕРНОЙ позиции (XZ = rx/rz), Y с пола. ⚠ Лёжа корень рисовался по rx/rz, а труп скользил дальше
          // (скорость бега, отлёт падения) — kinematic-таз рвал его к rx/rz за кадр. Сначала сдвигаем ВСЕ тела под
          // нарисованный корень (поза та же — на экране ничего не прыгает), потом оживляем. ЗАМЕР (живой Jolt, кукла
          // монстра, нокдаун на бегу 300 / 80 / 0 u/с, 60–144 Гц): рывок тела таза в первый кадр подъёма 196–299 / 51–69 /
          // 23–29u; голова тела от позы на подъёме 245–290 / 66–84 / 13–17u → со сдвигом 27–30 / 26–31 / 13–16u.
          if (!riseInit) { const hp = ragdoll.bodyPos('Hips'); ragdoll.shiftBodies(rx - hp[0], 0, rz - hp[2]); risePos.set(rx, hp[1], rz); ragdoll.setDead(false); riseInit = true; }
          const t = 1 - Math.max(0, downT) / downRise;       // прогресс подъёма 0→1
          const e = t * t * (3 - 2 * t);                     // smoothstep — мягкий старт/финиш
          // Кормим рагдолл ТОЛЬКО углами позы (моторы распрямляют тело) + kinematic-таз, БЕЗ мир-пинов (пины на стоячих
          // позициях при низком тазе растянули бы конечности). Таз лерпит с пола к стойке — тело физически поднимается.
          ragdoll.setPoseTarget(target.readPose());
          ragdoll.setPinTargets(NO_PINS);
          target.root.updateMatrixWorld(true);
          const hb = target.bones.get('Hips')!; hb.getWorldPosition(pelWorld); pelWorld.x += rx; pelWorld.z += rz; hb.getWorldQuaternion(hipsQ);
          pelWorld.lerp(risePos, 1 - e);                     // стойка→пол на долю (1−e): e=1 стойка, e=0 пол
          ragdoll.setPelvis(pelWorld, hipsQ);
          PHYS.muscle = DEF_MUSCLE * (0.15 + 0.85 * e);      // рампа силы моторов (слабо→сильно): тело подбирается, а не дёргается
          ragdoll.update(dt);
          PHYS.muscle = DEF_MUSCLE;                           // PHYS глобальна — вернуть дефолт для других кукол
          renderRagdollGhost(solid, ragdoll, ground, dt, 0, true, target.readPose(), e * matchWeight, undefined, undefined, !poseLod);
        }
        skin?.update(); syncWeaponHost();
        // Встал → обычный режим (гарантируем оживление физики). ⚠ И членство тел — заново: в kinematic-режиме нокдаун был
        // единственной причиной держать их в мире. Без `syncRagdollSim` тела так и стояли в мире там, где кончился подъём
        // (kinematic-ветка их не ведёт), и смерть без удара (DoT: `killMonster` не шлёт `hit`) не получала «тела вернулись»
        // → без снапа → труп падал со старого места. ЗАМЕР (живой Jolt, кукла монстра, встал → ушёл на 300u → DoT; физ-LOD перевёл в kinematic лёжа /
        // нокдаун в kinematic без удара; 60 / 144 Гц): нарисованный труп от сервера в 1-й кадр 300u, тело таза через 1 с
        // 290–297u → 0 и 9–14u.
        if (downT <= 0) endKnockdown();
        return;
      }
      const yawSnap = snapNext || first;                     // телепорт/спавн/пробуждение → таз мгновенно к прицелу (без «юлы»)
      if (snapNext) { rx = tx; rz = tz; snapNext = false; }  // пробуждение — снап к текущей цели (без слайда со старой позиции)
      // сглаживание мир-позиции (сим 30Гц телепортит tx/tz): предсказание по чистой скорости + мягкая коррекция
      if (!first) { rx += wvx * dt; rz += wvz * dt; }
      rx += (tx - rx) * 0.12; rz += (tz - rz) * 0.12;
      if (hasWvel) { player.setVel(wvx, wvz); }              // чистая скорость → узкие ноги как в редакторе
      else {
        let vx = 0, vz = 0;
        if (!first && dt > 1e-4) { vx = (tx - lastX) / dt; vz = (tz - lastZ) / dt; }
        const a = 1 - Math.pow(0.02, dt);
        vxS += (vx - vxS) * a; vzS += (vz - vzS) * a;
        player.setVel(vxS, vzS);
      }
      first = false; lastX = tx; lastZ = tz;
      player.setYaw(tyaw);
      if (yawSnap) player.snapYaw();                          // после setYaw: снять лаг таза на телепорте/пробуждении
      player.step(dt);                                       // позирует target (гейт+idle-стойка+удар) + грип оружия на solid — дёшево, в обоих режимах
      const sup = player.groundSupport;   // опора → заземляем только стоящую ногу (иначе «лыжник» на спуске); на повороте клипом — из клипа
      if (kinematic && physHold <= 0) {                      // KINEMATIC: рисуем ПРЯМО из позы манекена, физику монстра не считаем
        target.root.updateMatrixWorld(true);
        const hips = target.bones.get('Hips')!;
        hips.getWorldPosition(pelWorld); pelWorld.x += rx; pelWorld.z += rz;   // мир-таз позы + оффсет сглаженной позиции
        renderKinematicPose(solid, target.readPose(), pelWorld, ground, dt, GROUND0, sup, !poseLod);
        skin?.update(); syncWeaponHost();
        return;
      }
      driveRagdollToPose();                                  // кормим физику позой-целью + пины на мир-позиции
      if (woke) ragdoll.snapToPose();                        // проснулся (окно-culling) → тела сразу на позу в НОВОЙ точке
      PHYS.pinKp = player.attackPinKp ?? DEF_PINKP;          // per-кадр жёсткость пинов удара (авторская) / дефолт. PHYS глобальна — ставим перед СВОИМ update
      ragdoll.update(dt);                                    // шаг физики (моторы к позе + пины + вес оружия + kinematic-таз)
      // солид = физрезультат + заземление ОПОРНЫХ стоп (маховую ведёт поза) + БЛЕНД к позе-цели по matchWeight.
      // Во время удара вес совпадения = АВТОРСКИЙ per-кадр __match (задан в редакторе покадрово), иначе фолбэк — огибающая
      // ATK_MATCH·attackWeight (physics один не доводит замах до конца). В покое/беге — базовый matchWeight (физ-ведомая походка).
      const effMatch = renderMatchWeight(matchWeight, player.attackWeight, player.attackMatch);   // ЕДИНО с редактором-локо
      renderRagdollGhost(solid, ragdoll, ground, dt, 0, true, effMatch > 0.001 ? target.readPose() : null, effMatch, undefined, sup, !poseLod,
        { w: player.groundWeights, lag: GAIT.gndLag, flat: player.plantWeights, still: player.moveMag < 0.02 });   // окно/плавность/укладка/«стоим» — те же, что в редакторе; веса через плеер (в «только клипы» планировщика нет)
      skin?.update(); syncWeaponHost();                                        // GLB-слои ведутся solid (после физрезультата + бленда к позе)
      if (physHold > 0) { physHold -= dt; if (physHold <= 0) { snapNext = true; syncRagdollSim(); } }   // транзиентная физика удара кончилась → назад в кинематику
    },
    dispose() {
      // ⚠ ОРУЖИЕ — ПЕРВЫМ (R1-23). Руки висят на кистях solid или атласа, а модель ковки в них — ОБЩАЯ на всех кукол
      // с тем же видом (кэш `craftWeapon3d`). Обходы ниже освобождают всё, до чего дотянутся: снятая раньше них рука
      // уже вернула модель в кэш и ушла с кисти, иначе снос одной куклы освобождал бы геометрию и материалы у всех.
      for (const g of weaponGroups) disposeWeaponGroup(g);   // модель ковки — назад в кэш (общая геометрия), процедурная — освободить
      skin?.dispose();
      ragdoll.dispose();
      // solid/target — ПРОЦЕДУРНЫЕ меши (материалы создаются per-кукла, buildHumanoid) → освобождаем и геометрию, И
      // материалы (иначе утечка ~3 MeshStandardMaterial на каждого убитого → рост кучи → GC-разгон ms_world). Скин
      // (атлас) и оружейные GLB могут делить ОБЩИЕ материалы из assetCache — их материалы НЕ трогаем (skin.dispose сам).
      for (const h of [solid, target]) h.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mm = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mm)) mm.forEach((x) => x.dispose()); else mm?.dispose?.(); });
      group.clear();
    },
    _dbg: { player, ragdoll, get solid() { return solid; }, get target() { return target; } },
  };
}

/** Игрок — тонкая обёртка над единой куклой: внешность/оружие класса из CLASS_CHARS. */
export interface GamePlayerOpts { classId: string; weapon: string; weaponModels?: { main?: string; off?: string }; weaponLook?: WeaponLook; craftReg?: ConfigRegistry; baseAppearance?: HumanoidDollOpts['baseAppearance']; x: number; z: number; profile?: BodyProfile; boneScale?: BoneScale; boneOffsets?: Record<string, number[]> }
export function makeGamePlayerDoll(pw: PhysWorld, opts: GamePlayerOpts): RagdollHandle {
  return makeHumanoidDoll(pw, { x: opts.x, z: opts.z, weapon: opts.weapon, weaponModels: opts.weaponModels, weaponLook: opts.weaponLook, craftReg: opts.craftReg, baseAppearance: opts.baseAppearance, classId: opts.classId, profile: opts.profile, boneScale: opts.boneScale, boneOffsets: opts.boneOffsets, colors: { body: 0x8a93ad, limb: 0x6f7690 } });
}
