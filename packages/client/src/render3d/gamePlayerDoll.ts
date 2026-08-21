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
import { PosePlayer, localStorageContent, applyGaitConfig, loadGaitLocal, loadPlantGrid, loadMatch, loadFootLift, loadTwistStates, applyBaseGrip, type GXKnobs } from './poseRuntime.js';
import { attachWeapons } from './weapon3d.js';
import { charFor } from './chars3d.js';
import { createModelSkin, loadAssetConfig, resolveSlotModels, resolveCharacterModel, applyWeaponModels } from './modelSkin.js';
import type { BodyProfile, BoneScale } from './bodyProfile.js';

const GX_DEFAULT = (): GXKnobs => ({ armDown: 1.35, elbowBend: 0.25 });   // legWidth/bob убраны (дубль stanceWidth / боб в GAIT)
const PELVIS_Y = 32;
const KNOCK = 3.5;   // сила отброса трупа при frac=1 — ~1.5 м макс (32 ед = 1 м) при 100% урона от HP; меньше урон — ближе
const ATK_MATCH = 0.92;   // пиковый вес совпадения с авторской позой во время удара (фолбэк, если у кадра нет авторского __match)
const HIT_PHYS_DUR = 0.5;   // сек транзиентной физики в kinematic-режиме на хит-реакцию (перекрывает limp ~0.4с), потом назад в кинематику
const GROUND0 = (): number => 0;   // плоский пол y=0 (как в физ-рендере при groundAt=undefined) для kinematic FOOT-IK
const DEF_PINKP = PHYS.pinKp;   // дефолт жёсткости пинов — восстанавливаем вне удара (PHYS глобальна, шарится дллами: каждая dll ставит своё перед update)
const DEF_MUSCLE = PHYS.muscle; // дефолт силы моторов — рампим во время подъёма из нокдауна, потом восстанавливаем

export interface HumanoidDollOpts {
  x: number; z: number;
  weapon: string;                                    // редакторный ключ оружия ('axe','staff','none',…)
  weaponModels?: { main?: string; off?: string };    // Ф3: id 3D-моделей оружия (kind:'weapon') на main/off руки → GLB вместо процедурки (общее на всех)
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
  const content = opts.classId ? localStorageContent(opts.classId)
    : opts.gaitId ? localStorageContent(opts.gaitId, opts.gaitFallback)
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
  const solid = buildHumanoid({ gender, build, body: col.body ?? 0x8a93ad, limb: col.limb ?? 0x6f7690, head: col.head, profile, boneScale, boneOffsets });
  if (opts.scale && opts.scale !== 1) solid.root.scale.setScalar(opts.scale);   // визуальный масштаб (физика базовая)
  solid.root.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });   // тени от факелов (вкл. по тумблеру) — актёр отбрасывает
  group.add(solid.root);
  const gripChar = opts.classId ?? opts.gaitId ?? '';   // ключ для базового хвата pe_grip (игрок→class, монстр→gaitId)
  let weaponModels = opts.weaponModels;   // id GLB-моделей оружия (main/off) — общие на всех; меняются со сменой оружия
  let weaponGroups = attachWeapons(solid, weapon, weaponModels); applyBaseGrip(weaponGroups, gripChar, weapon, opts.gaitFallback);   // единый базовый хват
  // Ф3: свап процедурных мешей на GLB (если у экипа задан modelId оружия). Дёшево-ноуп без моделей (монстры/без GLB).
  const syncWeaponModels = (): void => { if (!(weaponModels?.main || weaponModels?.off)) return; void loadAssetConfig().then((cfg) => applyWeaponModels(weaponGroups, cfg, { materials: cfg.materials, textures: cfg.textures })); };
  syncWeaponModels();
  // target — НЕВИДИМЫЙ манекен-источник позы: PosePlayer его позирует, с него кормим физику (цель + пины).
  const target = buildHumanoid({ gender, build, profile, boneScale, boneOffsets });
  target.root.visible = false; group.add(target.root);
  // Подъём стопы per-персонаж (pe_phys.footLift): поднимает цель стойки (standY) и заземления → подошва МЕША атласа на полу
  // (лодыжка выше FOOT_Y, иначе тонет). solid грунтится footIk, target даёт standY через PosePlayer → оба должны совпадать.
  solid.footLift = target.footLift = opts.classId ? loadFootLift(opts.classId) : opts.gaitId ? loadFootLift(opts.gaitId, opts.gaitFallback) : 0;
  // физ-рэгдолл — единый риг. Собственные полупрозрачные боксы не показываем (рисуем solid).
  const ragdoll = makeHumanoidRagdoll(pw);
  ragdoll.group.visible = false; group.add(ragdoll.group);
  ragdoll.setPelvis(new THREE.Vector3(opts.x, PELVIS_Y, opts.z), new THREE.Quaternion());

  const player = new PosePlayer(target, () => weaponGroups, content, weapon, gx, plant, twistStates);
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
  function atlasVisible(): Record<string, string> {
    const visible: Record<string, string> = {};
    // Пустой слот → базовый submesh-вид класса (baseAppearance); надетый предмет (modelId) перекрывает; нет ни того ни
    // другого → ключ не задаём (setAtlas покажет все submesh слота, как раньше). hair→helm-слот (причёска без шлема).
    const baseBySlot: Record<string, string | undefined> = baseApp ? { helm: baseApp.hair, head: baseApp.head, gloves: baseApp.hands, chest: baseApp.body, boots: baseApp.feet } : {};
    for (const slot of ['helm', 'head', 'chest', 'gloves', 'boots']) { const id = equipModels?.[slot]?.modelId ?? baseBySlot[slot]; if (id) visible[slot] = id; }
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
      if (char) { void skin.setAtlas(char, atlasVisible(), assets, { matBySlot: atlasMaterials() }); return; }   // = превью редактора (без hideHair) + пер-предметный материал
      if (atlasStrict) return;   // монстр без своего атласа → процедурный меш (не подмешивать легаси base-парты)
      void skin.set(resolveSlotModels(cfg, equipModels), assets);   // легаси: послотные GLB
    });
  }
  refreshSkin();

  // ── состояние синхронизации ──
  let tx = opts.x, tz = opts.z, tyaw = 0, lastX = opts.x, lastZ = opts.z, first = true, dead = false;
  let simEnabled = true, snapNext = false;   // окно-culling: вне экрана усыпляем физику (тела вон из pw.step), меш замерзает
  let kinematic = false, physHold = 0;       // debug-режим «кинематика»: рисуем из позы, физика лишь транзиентно (physHold сек) на удар/смерть
  let poseLod = false;                        // поза-LOD дальних монстров: пропуск FOOT-IK (заземления стоп) — дёшево, детали стоп вдали не видно
  // Нокдаун (сбить с ног): downT>0 — идёт коллапс+подъём (не смерть). downRise — длительность фазы подъёма; riseInit —
  // однократный переход коллапс→подъём (записываем упавшую позицию таза + возвращаем моторы). risePos — таз на полу.
  let downT = 0, downRise = 0.8, riseInit = false;
  const risePos = new THREE.Vector3();
  // Членство тел в pw.step: активны только если кукла не усыплена окном И (мертва | нокдаун | физрежим | транзиентная физика удара).
  const syncRagdollSim = (): void => ragdoll.setSimEnabled(simEnabled && (dead || downT > 0 || !kinematic || physHold > 0));
  let atkClipIdx = 0;   // индекс чередования poseClips скила (замах справа→слева→…)
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
  const _wsA = new THREE.Vector3(), _wsF = new THREE.Vector3();
  function syncWeaponHost(): void {
    for (const g of weaponGroups) {
      const hn = g.userData.handBone as string | undefined; if (!hn) continue;
      const fallback = solid.bones.get(hn);
      const atlasHand = skin?.atlasBone(hn) ?? null;
      const target = atlasHand ?? fallback;
      if (target && g.parent !== target) target.add(g);
      // Компенсация масштаба: кисть атласа несёт импорт-скейл → оружие мельчает. Держим размер как на solid.
      if (atlasHand && fallback) {
        atlasHand.updateWorldMatrix(true, false); fallback.updateWorldMatrix(true, false);
        atlasHand.getWorldScale(_wsA); fallback.getWorldScale(_wsF);
        if (_wsA.x > 1e-6 && _wsA.y > 1e-6 && _wsA.z > 1e-6) g.scale.set(_wsF.x / _wsA.x, _wsF.y / _wsA.y, _wsF.z / _wsA.z);
      } else if (g.scale.x !== 1) g.scale.set(1, 1, 1);
    }
  }

  return {
    group,
    setPose(x, z, yaw) { if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(yaw)) { tx = x; tz = z; tyaw = yaw; } },
    setMove(_s) { /* магнитуда не нужна: скорость из setWorldVel или дельты позиции */ },
    setWorldVel(vx, vz) { if (Number.isFinite(vx) && Number.isFinite(vz)) { wvx = vx; wvz = vz; hasWvel = true; } },
    attack(clips, windowSec) {   // скил с poseClips → его позы (адаптированные под оружие); иначе базовая атака = все hit_-клипы оружия. Цикл по кругу.
      const pool = (clips && clips.length)
        ? clips.map((n) => content.resolveAbilityClip(n, weapon)).filter((c): c is NonNullable<typeof c> => !!c)
        : content.attackClips(weapon);
      if (pool.length) { player.triggerAttack(pool[atkClipIdx % pool.length]!, windowSec); atkClipIdx++; }
      else player.triggerAttack(content.attackClip(weapon), windowSec);   // ничего не авторено → прежний фолбэк
    },
    setDead(d) {
      if (d && !simEnabled) { simEnabled = true; snapNext = true; }   // умер спящим (вне окна) → будим, чтоб коллапс отыгрался
      if (d) { downT = 0; riseInit = false; }   // смерть главнее нокдауна: обрываем подъём, дальше свободный коллапс
      if (d === dead) return; dead = d;
      syncRagdollSim();          // dead → тела в pw.step (коллапс) в ЛЮБОМ режиме (в т.ч. kinematic)
      ragdoll.setDead(d);
    },
    setSimEnabled(on) {   // окно-culling: on=false → тела вон из физ-мира (pw.step их не считает), меш замерзает; on=true → вернуть + снап к цели
      if (on === simEnabled) return; simEnabled = on;
      if (on) snapNext = true;
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
      if (!simEnabled) { simEnabled = true; snapNext = true; }   // сбит спящим (вне окна) → будим
      downRise = Math.max(0.05, riseSec);
      downT = Math.max(0.1, downSec) + downRise;
      riseInit = false;
      syncRagdollSim();          // тела в pw.step на весь нокдаун
      ragdoll.setDead(true);     // моторы off + таз dynamic → падение. Горизонт. отлёт даёт СЕРВЕР (глайд позиции); тут только опрокидывание.
      ragdoll.hit('Torso', dx, 0.12, dz, 0.5);   // мягкий толчок верха назад → валится ОТ атакующего (не «взрыв»)
    },
    setWeapon(key, models) {   // сменить оружие/щит: снести старые меши, собрать новые, обновить PosePlayer (стойка/удар по оружию)
      if (key === weapon) return;
      if (models !== undefined) weaponModels = models;   // Ф3: новые id GLB-моделей оружия (self); пиры — undefined (нужна сеть)
      for (const g of weaponGroups) { g.userData.stale = true; g.parent?.remove(g); g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
      weapon = key; weaponGroups = attachWeapons(solid, weapon, weaponModels); applyBaseGrip(weaponGroups, gripChar, weapon, opts.gaitFallback); player.setWeapon(weapon);
      syncWeaponModels();
    },
    setAppearance(equip) { equipModels = equip; refreshSkin(); },   // C6c: слоты брони (modelId) → пересобрать скин-слой

    setCombat(on) { player.setCombat(on); },   // боевой айдл (сервер-авторитетный флаг → боевая стойка)
    update(dt) {
      if (!simEnabled) return;                               // спит (вне окна): физика вынута, меш заморожен в позе — не считаем
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
          if (!riseInit) { const hp = ragdoll.bodyPos('Hips'); risePos.set(rx, hp[1], rz); ragdoll.setDead(false); riseInit = true; }   // подъём из СЕРВЕРНОЙ позиции (XZ=rx/rz), Y с пола → без «прыжка»
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
        if (downT <= 0) { downT = 0; if (!riseInit) ragdoll.setDead(false); riseInit = false; snapNext = true; }   // встал → обычный режим (гарантируем оживление физики)
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
      const sw = player.driver.swingLegs;   // опора = !swing → заземляем только стоящую ногу (иначе «лыжник» на спуске)
      if (kinematic && physHold <= 0) {                      // KINEMATIC: рисуем ПРЯМО из позы манекена, физику монстра не считаем
        target.root.updateMatrixWorld(true);
        const hips = target.bones.get('Hips')!;
        hips.getWorldPosition(pelWorld); pelWorld.x += rx; pelWorld.z += rz;   // мир-таз позы + оффсет сглаженной позиции
        renderKinematicPose(solid, target.readPose(), pelWorld, ground, dt, GROUND0, [!sw[0], !sw[1]], !poseLod);
        skin?.update(); syncWeaponHost();
        return;
      }
      driveRagdollToPose();                                  // кормим физику позой-целью + пины на мир-позиции
      PHYS.pinKp = player.attackPinKp ?? DEF_PINKP;          // per-кадр жёсткость пинов удара (авторская) / дефолт. PHYS глобальна — ставим перед СВОИМ update
      ragdoll.update(dt);                                    // шаг физики (моторы к позе + пины + вес оружия + kinematic-таз)
      // солид = физрезультат + заземление ОПОРНЫХ стоп (маховую ведёт поза) + БЛЕНД к позе-цели по matchWeight.
      // Во время удара вес совпадения = АВТОРСКИЙ per-кадр __match (задан в редакторе покадрово), иначе фолбэк — огибающая
      // ATK_MATCH·attackWeight (physics один не доводит замах до конца). В покое/беге — базовый matchWeight (физ-ведомая походка).
      const am = player.attackMatch;
      const effMatch = am != null ? am : Math.max(matchWeight, ATK_MATCH * player.attackWeight);
      renderRagdollGhost(solid, ragdoll, ground, dt, 0, true, effMatch > 0.001 ? target.readPose() : null, effMatch, undefined, [!sw[0], !sw[1]], !poseLod);
      skin?.update(); syncWeaponHost();                                        // GLB-слои ведутся solid (после физрезультата + бленда к позе)
      if (physHold > 0) { physHold -= dt; if (physHold <= 0) { snapNext = true; syncRagdollSim(); } }   // транзиентная физика удара кончилась → назад в кинематику
    },
    dispose() {
      skin?.dispose();
      ragdoll.dispose();
      // solid/target — ПРОЦЕДУРНЫЕ меши (материалы создаются per-кукла, buildHumanoid) → освобождаем и геометрию, И
      // материалы (иначе утечка ~3 MeshStandardMaterial на каждого убитого → рост кучи → GC-разгон ms_world). Скин
      // (атлас) и оружейные GLB могут делить ОБЩИЕ материалы из assetCache — их материалы НЕ трогаем (skin.dispose сам).
      for (const h of [solid, target]) h.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mm = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mm)) mm.forEach((x) => x.dispose()); else mm?.dispose?.(); });
      for (const g of weaponGroups) g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
      group.clear();
    },
    _dbg: { player, ragdoll, get solid() { return solid; }, get target() { return target; } },
  };
}

/** Игрок — тонкая обёртка над единой куклой: внешность/оружие класса из CLASS_CHARS. */
export interface GamePlayerOpts { classId: string; weapon: string; weaponModels?: { main?: string; off?: string }; baseAppearance?: HumanoidDollOpts['baseAppearance']; x: number; z: number; profile?: BodyProfile; boneScale?: BoneScale; boneOffsets?: Record<string, number[]> }
export function makeGamePlayerDoll(pw: PhysWorld, opts: GamePlayerOpts): RagdollHandle {
  return makeHumanoidDoll(pw, { x: opts.x, z: opts.z, weapon: opts.weapon, weaponModels: opts.weaponModels, baseAppearance: opts.baseAppearance, classId: opts.classId, profile: opts.profile, boneScale: opts.boneScale, boneOffsets: opts.boneOffsets, colors: { body: 0x8a93ad, limb: 0x6f7690 } });
}
