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
import { PosePlayer, localStorageContent, applyGaitConfig, loadGaitLocal, loadPlantGrid, loadMatch, type GXKnobs } from './poseRuntime.js';
import { attachWeapons } from './weapon3d.js';
import { charFor } from './chars3d.js';

const GX_DEFAULT = (): GXKnobs => ({ armDown: 1.35, elbowBend: 0.25 });   // legWidth/bob убраны (дубль stanceWidth / боб в GAIT)
const PELVIS_Y = 32;
const KNOCK = 3.5;   // сила отброса трупа при frac=1 — ~1.5 м макс (32 ед = 1 м) при 100% урона от HP; меньше урон — ближе
const ATK_MATCH = 0.92;   // пиковый вес совпадения с авторской позой во время удара (фолбэк, если у кадра нет авторского __match)
const HIT_PHYS_DUR = 0.5;   // сек транзиентной физики в kinematic-режиме на хит-реакцию (перекрывает limp ~0.4с), потом назад в кинематику
const GROUND0 = (): number => 0;   // плоский пол y=0 (как в физ-рендере при groundAt=undefined) для kinematic FOOT-IK
const DEF_PINKP = PHYS.pinKp;   // дефолт жёсткости пинов — восстанавливаем вне удара (PHYS глобальна, шарится дллами: каждая dll ставит своё перед update)

export interface HumanoidDollOpts {
  x: number; z: number;
  weapon: string;                                    // редакторный ключ оружия ('axe','staff','none',…)
  classId?: string;                                  // задан → ИГРОК (гейт класса → global GAIT + контент класса)
  gaitId?: string;                                   // задан (без classId) → МОНСТР: локальный plant/gx + контент этого id
  gaitFallback?: string;                             // фолбэк для gaitId, если он ещё не настроен (монстры → 'warrior')
  colors?: { body?: number; limb?: number; head?: number };
  scale?: number;                                    // масштаб меша (чемпионы крупнее); физика — в базовом размере
  gender?: 'male' | 'female'; build?: BuildScale;    // если не заданы и есть classId — из charFor
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
  let weapon = opts.weapon;
  const ch = opts.classId ? charFor(opts.classId) : null;
  const gender = opts.gender ?? ch?.gender ?? 'male';
  const build = opts.build ?? ch?.build ?? {};
  const col = opts.colors ?? {};

  const group = new THREE.Group();
  // solid — ВИДИМЫЙ humanoid-меш, ведём результатом физики (как призрак в редакторе). Оружие на кистях.
  const solid = buildHumanoid({ gender, build, body: col.body ?? 0x8a93ad, limb: col.limb ?? 0x6f7690, head: col.head });
  if (opts.scale && opts.scale !== 1) solid.root.scale.setScalar(opts.scale);   // визуальный масштаб (физика базовая)
  solid.root.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });   // тени от факелов (вкл. по тумблеру) — актёр отбрасывает
  group.add(solid.root);
  let weaponGroups = attachWeapons(solid, weapon);
  // target — НЕВИДИМЫЙ манекен-источник позы: PosePlayer его позирует, с него кормим физику (цель + пины).
  const target = buildHumanoid({ gender, build });
  target.root.visible = false; group.add(target.root);
  // физ-рэгдолл — единый риг. Собственные полупрозрачные боксы не показываем (рисуем solid).
  const ragdoll = makeHumanoidRagdoll(pw);
  ragdoll.group.visible = false; group.add(ragdoll.group);
  ragdoll.setPelvis(new THREE.Vector3(opts.x, PELVIS_Y, opts.z), new THREE.Quaternion());

  const player = new PosePlayer(target, () => weaponGroups, content, weapon, gx, plant);
  const ground = newGhostGround();     // сглаженный прижим низшей стопы к полу (общий с редактором)

  // ── состояние синхронизации ──
  let tx = opts.x, tz = opts.z, tyaw = 0, lastX = opts.x, lastZ = opts.z, first = true, dead = false;
  let simEnabled = true, snapNext = false;   // окно-culling: вне экрана усыпляем физику (тела вон из pw.step), меш замерзает
  let kinematic = false, physHold = 0;       // debug-режим «кинематика»: рисуем из позы, физика лишь транзиентно (physHold сек) на удар/смерть
  let poseLod = false;                        // поза-LOD дальних монстров: пропуск FOOT-IK (заземления стоп) — дёшево, детали стоп вдали не видно
  // Членство тел в pw.step: активны только если кукла не усыплена окном И (мертва | физрежим | идёт транзиентная физика удара).
  const syncRagdollSim = (): void => ragdoll.setSimEnabled(simEnabled && (dead || !kinematic || physHold > 0));
  let atkClipIdx = 0;   // индекс чередования poseClips скила (замах справа→слева→…)
  let wvx = 0, wvz = 0, hasWvel = false, vxS = 0, vzS = 0;
  let rx = opts.x, rz = opts.z;            // сглаженная мир-позиция (сим 30Гц телепортит tx/tz)
  const off = new THREE.Vector3(), pelWorld = new THREE.Vector3(), hipsQ = new THREE.Quaternion();
  const pinVecs = RAG_NAMES.map(() => new THREE.Vector3());
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
    setWeapon(key) {   // сменить оружие/щит: снести старые меши, собрать новые, обновить PosePlayer (стойка/удар по оружию)
      if (key === weapon) return;
      for (const g of weaponGroups) { g.parent?.remove(g); g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
      weapon = key; weaponGroups = attachWeapons(solid, weapon); player.setWeapon(weapon);
    },
    update(dt) {
      if (!simEnabled) return;                               // спит (вне окна): физика вынута, меш заморожен в позе — не считаем
      if (dead) {                                            // мёртв — свободный коллапс, рендерим без прижима
        ragdoll.update(dt);
        renderRagdollGhost(solid, ragdoll, ground, dt, 0, false);
        return;
      }
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
      player.step(dt);                                       // позирует target (гейт+idle-стойка+удар) + грип оружия на solid — дёшево, в обоих режимах
      const sw = player.driver.swingLegs;   // опора = !swing → заземляем только стоящую ногу (иначе «лыжник» на спуске)
      if (kinematic && physHold <= 0) {                      // KINEMATIC: рисуем ПРЯМО из позы манекена, физику монстра не считаем
        target.root.updateMatrixWorld(true);
        const hips = target.bones.get('Hips')!;
        hips.getWorldPosition(pelWorld); pelWorld.x += rx; pelWorld.z += rz;   // мир-таз позы + оффсет сглаженной позиции
        renderKinematicPose(solid, target.readPose(), pelWorld, ground, dt, GROUND0, [!sw[0], !sw[1]], !poseLod);
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
      if (physHold > 0) { physHold -= dt; if (physHold <= 0) { snapNext = true; syncRagdollSim(); } }   // транзиентная физика удара кончилась → назад в кинематику
    },
    dispose() {
      ragdoll.dispose();
      for (const h of [solid, target]) h.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
      for (const g of weaponGroups) g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
      group.clear();
    },
    _dbg: { player, ragdoll, get solid() { return solid; }, get target() { return target; } },
  };
}

/** Игрок — тонкая обёртка над единой куклой: внешность/оружие класса из CLASS_CHARS. */
export interface GamePlayerOpts { classId: string; weapon: string; x: number; z: number }
export function makeGamePlayerDoll(pw: PhysWorld, opts: GamePlayerOpts): RagdollHandle {
  return makeHumanoidDoll(pw, { x: opts.x, z: opts.z, weapon: opts.weapon, classId: opts.classId, colors: { body: 0x8a93ad, limb: 0x6f7690 } });
}
