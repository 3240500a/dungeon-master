// ── Общий runtime-пайплайн позинга (Ф5): редактор И игра гонят бег/idle-стойки/удары ОДНИМ кодом ──
// Чистые функции: берут human (humanoid.ts), меши оружия, крутилки GX и провайдер контента ЯВНЫМИ параметрами
// (без модульных глобалов), поэтому переиспользуются и в pose-editor.ts (превью), и в игре (gamePlayerDoll.ts, per игрок).
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { GAIT, POSE, GAIT_BASE, POSE_BASE, HIP_DX, FOOT_Y, ASYM, STRAFE, STRAFE_R, STRAFE_L, BACK, COMBAT, sideLerp, foldElbow, type PoseTargets, type StanceFoot, locoVal } from './gaitKnobs.js';
import { resolveStancePose, stancePoseAt, splitHands, type StanceLayerInfo } from './poseLayers.js';
import { locoClipNames, locoPhaseU, stepLocoSection, sectionClipTime, findLocoClip, blendLocoPose, locoDirWeights, bakedLocoSpeed, locoRunWeight, type LocoSectionState, type LocoSection, type LocoDir, type LocoAxes } from './locoBlend.js';
import { pickTurn, turnYawAt, turnSupportAt, shouldCommitTurn, TURN_NAMES, SWING_KEY } from './turnInPlace.js';
import { clipSections } from './clipModel.js';   // re-export выше только реэкспортит, в модуле имени не создаёт
import { legGroundIK, legGeomFor, legBones, LEG_COUNT } from './footIk.js';   // footIk ничего у нас не импортирует — цикла нет
import { readAnimCfg } from './animConfig.js';

// Модель клипа (типы + интерполяция) живёт в ОДНОМ месте — clipModel.ts (Ф1.1): и игра, и редактор берут её оттуда.
// Здесь только ре-экспорт, чтобы прежние импортёры (`from './poseRuntime.js'`) не переписывать.
export type { Pose, Keyframe, Clip, Interp, Mark, MarkType, MarkTrack, MarkEvent } from './clipModel.js';
export { blendTwo, clipPoseAt, clipSegmentAt, clipDur, clipSections, isAngleKey, easeU, migrateClip, migratePose, mirrorSide, flipPose, hipsOffset, setHipsOffset, normalizeClipHips } from './clipModel.js';
import { hipsOffset } from './clipModel.js';   // Ф12: офсет таза читаем только через него (дельта + терпимость к легаси-абсолюту)
import { pelvisToWorld, pelvisHeading } from './pelvisFrame.js';   // ⭐ таз кадра персонажа → мир: одна композиция с запекателем, импортом и шарниром редактора
import { blendTwo, clipPoseAt, clipDur, impactSec, markSec, marksInRange, loopMarksInRange, hasMark, comboWindow, type Mark, type MarkEvent } from './clipModel.js';
// Коридор скорости тайм-варпа удара. Нижняя граница НИЖЕ единицы осознанно: контакт в мокапе
// обычно на ~60 % клипа, а вайндап сервера — ~35 % окна, то есть хвост обязан уметь РАСТЯГИВАТЬСЯ.
const WARP_MIN = 0.35, WARP_MAX = 8;
/** Кроссфейд между ударами цепочки (сек). Короткий: удары должны читаться отдельными, а не смазываться. */
const XFADE_SEC = 0.12;   // умолчание кроссфейда; конкретное состояние может задать своё (`AnimState.blendSec`)
import { WPN_KEYS, WPN_POS } from './clipModel.js';
import { maskBones, boneWeight, type BoneMask } from './boneMask.js';
import { resolveGripPose, EMPTY_GRIP_CONFIG, type GripConfig } from './gripPoses.js';   // ⭐ ЖИВОЙ хват — тот же резолвер, что у редактора
import { deriveFingerAxes, type FingerAxes } from './fingerAxes.js';                    // оси сгиба выводятся из геометрии ЭТОГО рига
import { fingersAnimated } from './clipModel.js';
import type { Pose, Keyframe, Clip } from './clipModel.js';
import { blendArmKey, swingRefOf, type ArmWeights } from './armBlend.js';
import { lookupItemSwing, readSwingStore, ARM_BONE_OF, TWO_HANDED_ITEMS, type SwingSet, type SwingStore } from './layerWeights.js';   // ⭐ мах по ПРЕДМЕТУ в руке   // ⭐⭐ якорь + аддитивный мах (см. шапку armBlend.ts)
import { lookupLayers, resolveLayers, fillLayers, newResolvedLayers, readLayerStore, LAYER_LEGACY_DEFAULT, LAYER_PARTS, type LayerEntry, type LayerStore, type ResolvedLayers, type SwayStore } from './layerWeights.js';   // ⭐ веса «локомоция ↔ стойка» по частям тела
export interface UpperPose {
  pose: Pose; swing: number;                 // idle-поза верха + остаточный мах (0..1) — ЛЕГАСИ: одно число на весь верх
  /**
   * ⭐ ВЕСА ПО ЧАСТЯМ ТЕЛА (`pe_layers`, см. `layerWeights.ts`): доля ЛОКОМОЦИИ на руку / кисть / грудь / голову, парой
   * ходьба/бег и с колонкой боя. Есть — решает она, `swing` остаётся умолчанием для частей без записи. Нет поля
   * (тесты, чужой контент) — все части верха = `swing`, голова — как была: поведение прежнее бит в бит.
   */
  layers?: LayerEntry | null;
  /** Имя клипа-стойки: по нему берётся хват КЛИПА (`GripConfig.byClip`), если он задан. */
  clipName?: string;
  /** У стойки анимированы сами пальцы — тогда живой хват её не перебивает (см. `fingersAnimated`). */
  fingersAnimated?: boolean;
  /**
   * ⭐ ЧТО В КАКОЙ РУКЕ — по разбору САМОЙ сборки стойки (`resolveStancePose`), а не по повторному разбору ключа
   * оружия: рука предмета решается там (`pe_anim.items[*].hand` умеет сказать «факел в левой» при пустой правой),
   * и второй разбор разошёлся бы с первым молча. По этому полю резолвится мах руки (`pe_swing`).
   * Нет поля (чужой контент, тесты) — обе руки считаются ПУСТЫМИ, то есть верх идёт клипом: прежнее поведение
   * ветки «стойки нет» и уж точно не молчаливое приглушение.
   */
  hands?: { main: string; off: string };
}

/**
 * ЧТО СЕЙЧАС ИГРАЕТ И С КАКИМ ВЕСОМ — одна строка на слой, за текущий кадр.
 *
 * Зачем вообще: слоёв пять, веса считаются в трёх разных местах, и на вопрос «почему персонаж
 * выглядит так» ответа не было НИГДЕ — ни в редакторе, ни в игре. В Unreal ровно эту дырку закрывает
 * дорожка Blend Weights в Animation Insights, в Unity — подсветка активного состояния в окне Animator.
 *
 * ⚠ ЗАПОЛНЯЕТСЯ ТАМ ЖЕ, ГДЕ СЧИТАЕТСЯ ВЕС. Соблазн собрать эти числа заново на стороне окна большой и
 * ошибочный: это вторая правда, и разойдётся она молча — врать начнёт именно окно отладки, которому
 * верят. Поэтому строки пишет сам рантайм, а окно их только рисует.
 *
 * Выключено по умолчанию: пока `on` = false, в кадре не собирается ни одной строки и мусора нет.
 */
export interface TraceRow {
  /** Слой стека: «НОГИ / ТАЗ», «ПОЗА ВЕРХА», «ГЛАВНАЯ РУКА», «ДЕЙСТВИЕ»… */
  layer: string;
  /** Кто его сейчас наполняет: имя клипа, «планировщик шагов», «нет». */
  src: string;
  /** Вес 0..1 — с ним слой и лёг. */
  w: number;
  /** Подробность в одну фразу: приоритет, замок, владение ногами. */
  note?: string;
}
export interface LayerTrace {
  on: boolean;
  /** Метка последнего заполнения (мс) — по ней видно, живая трасса или застывшая. */
  t: number;
  speed: number; sb: number; st: number; moveMag: number; legMag: number; combat: number;
  /** Скрутка корпуса: от походки (в такт шагу) и от прицела (torso-lead) — разные вещи, путать нельзя. */
  twistGait: number; twistAim: number;
  rows: TraceRow[];
  items: StanceLayerInfo[];
}
export const layerTrace: LayerTrace = {
  on: false, t: 0, speed: 0, sb: 0, st: 0, moveMag: 0, legMag: 0, combat: 0,
  twistGait: 0, twistAim: 0, rows: [], items: [],
};
const traceRow = (layer: string, src: string, w: number, note?: string): void => {
  if (layerTrace.on) layerTrace.rows.push({ layer, src, w, note });
};
export interface GXKnobs { armDown: number; elbowBend: number; armDownRun?: number; elbowBendRun?: number }   // *Run — раздельно для бега (интерп по sb); нет → = ходьба. legWidth убран (дубль stanceWidth)
/**
 * Скрутка корпуса (torso-lead): голова/плечи ведут за ПРИЦЕЛОМ, таз догоняет прицел. ОДНА система стоя и на бегу.
 * `threshold` — мёртвая зона (рад): пока |прицел−таз| ≤ неё, таз ДЕРЖИТСЯ, разница «размазана» по позвоночнику (голова ведёт).
 * `turnRate` — скорость доворота таза (рад/с). КРИТИЧНО для стоп-шагов: таз кормит планировщик; слишком быстро →
 *   обе стопы за кадр = прыжок; слишком медленно + лаг → семенит. ~3 рад/с: за приставной шаг (0.18с) таз повернётся
 *   < turnStepDist → стопы переступают поочерёдно и успевают.
 * `maxTwist` — кламп скрутки ВЕРХА (рад): голова/спина не выворачиваются сверх порога.
 * `relaxTime` — сек: если прицел стабилен столько, а таз лагает (скрутка есть) — таз доворачивается к прицелу (скрутка→0,
 *   выравнивание в нейтраль). Т.е. torso-lead = лид ТОЛЬКО пока активно водишь прицелом; замер на цели → корпус выравнивается.
 * `weights` — распределение скрутки по цепочке [Spine, Chest, UpperChest, Neck, Head] (в сумме ~1 → голова доходит до прицела).
 * ПОД БУДУЩЕЕ: профиль умножается на модификатор класса брони (латы → меньше сегментов/порог, лёгкая → свободнее).
 */
export interface TwistProfile { threshold: number; turnRate: number; maxTwist: number; relaxTime: number; weights: [number, number, number, number, number]; headLook: number; headPitch: number }
// headLook 0..1: стабилизация ГОЛОВЫ на прицел в МИР-yaw (компенсирует свинг корпуса от удара). 1 = строго на курсор, 0 = голова
// целиком едет с телом (старое поведение). ~0.85 = смотрит на курсор + чуть гуляет (подмес движения). Зовётся ПОСЛЕ applyTorsoTwist.
// headPitch (рад): ЦЕЛЕВОЙ кивок головы (0 = ровно/горизонт, <0 = смотрит вниз). Убирает НАСЛЕДОВАННЫЙ кивок от свинга корпуса
// (удар качает грудь/спину → голова-ребёнок ныряет). Тем же весом headLook голова уводится к этому кивку, а не к свинг-нырку.
export const TWIST_DEFAULT = (): TwistProfile => ({ threshold: 0.70, turnRate: 3, maxTwist: 1.4, relaxTime: 1.2, weights: [0.15, 0.25, 0.30, 0.15, 0.15], headLook: 0.85, headPitch: 0 });
// Скрутка корпуса настраивается ПО СОСТОЯНИЮ ДВИЖЕНИЯ (стой/ходьба/бег) — в игре эффективный профиль блендится ПЛАВНО
// по скорости (3 якоря), в редакторе каждая кнопка правит свой профиль. Хранилище pe_twist: либо плоский (легаси —
// применяется на все 3), либо { stand?, walk?, run? } частичных профилей.
export type TwistState = 'stand' | 'walk' | 'run';
export interface TwistStates { stand: TwistProfile; walk: TwistProfile; run: TwistProfile }
export const TWIST_STATES_DEFAULT = (): TwistStates => ({ stand: TWIST_DEFAULT(), walk: TWIST_DEFAULT(), run: TWIST_DEFAULT() });
type TwistPartial = Partial<TwistProfile>;
export type TwistCfgStored = TwistPartial & Partial<Record<TwistState, TwistPartial>>;
const mergeTwist = (c: TwistPartial | undefined): TwistProfile => {
  const d = TWIST_DEFAULT();
  return { ...d, ...c, weights: (c?.weights && c.weights.length === 5 ? [...c.weights] as TwistProfile['weights'] : d.weights) };
};
const isPerStateTwist = (raw: TwistCfgStored | undefined): boolean => !!raw && ('stand' in raw || 'walk' in raw || 'run' in raw);
/** Развернуть хранимый конфиг pe_twist в 3 полных профиля. Легаси плоский → на все 3; per-state с пропусками: бег←ходьба←стой. */
export function resolveTwistStates(raw: TwistCfgStored | undefined): TwistStates {
  if (isPerStateTwist(raw)) {
    const r = raw as Partial<Record<TwistState, TwistPartial>>;
    const stand = mergeTwist(r.stand);
    const walk = r.walk ? mergeTwist(r.walk) : { ...stand };
    const run = r.run ? mergeTwist(r.run) : { ...walk };
    return { stand, walk, run };
  }
  const flat = mergeTwist(raw as TwistPartial | undefined);
  return { stand: flat, walk: { ...flat }, run: { ...flat } };
}
const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Записать смешанный профиль скрутки в out (in-place, БЕЗ аллокаций — для горячего цикла). */
function lerpTwistInto(out: TwistProfile, a: TwistProfile, b: TwistProfile, t: number): TwistProfile {
  out.threshold = lerpN(a.threshold, b.threshold, t); out.turnRate = lerpN(a.turnRate, b.turnRate, t);
  out.maxTwist = lerpN(a.maxTwist, b.maxTwist, t); out.relaxTime = lerpN(a.relaxTime, b.relaxTime, t);
  out.headLook = lerpN(a.headLook, b.headLook, t); out.headPitch = lerpN(a.headPitch, b.headPitch, t);
  for (let i = 0; i < 5; i++) out.weights[i] = lerpN(a.weights[i]!, b.weights[i]!, t);
  return out;
}
/** Линейно смешать два профиля скрутки в НОВЫЙ объект (тесты/редкие вызовы). */
export function lerpTwist(a: TwistProfile, b: TwistProfile, t: number): TwistProfile { return lerpTwistInto(TWIST_DEFAULT(), a, b, t); }
const _twBlend = TWIST_DEFAULT();   // scratch: blendTwist зовётся на каждого актёра каждый кадр → пишем сюда, результат потребляется СИНХРОННО в step (не удерживается)
/** Эффективный профиль скрутки по скорости: 3 якоря (стой@0, ходьба@speedWalk, бег@speedRun), кусочно-линейно.
 *  Пишет в общий scratch БЕЗ аллокаций (результат используется сразу в том же кадре — между актёрами не пересекается). */
export function blendTwist(s: TwistStates, speed: number): TwistProfile {
  const w = GAIT.speedWalk, r = Math.max(w + 1, GAIT.speedRun);
  if (speed <= w) return lerpTwistInto(_twBlend, s.stand, s.walk, clamp(speed / Math.max(1, w), 0, 1));
  return lerpTwistInto(_twBlend, s.walk, s.run, clamp((speed - w) / (r - w), 0, 1));
}
/** Цепочка скрутки корпуса — ОДНА истина для походки и ручного позинга (веса всегда в этом порядке). */
export const TWIST_BONES = ['Spine', 'Chest', 'UpperChest', 'Neck', 'Head'] as const;
/** Провайдер контента: даёт idle-стойку (полная поза) + swing по оружию. Редактор — из живой библиотеки; игра — из localStorage.
 *  `shieldOverlay` — отдельная поза щита (левая рука+корпус из `стойка_shield`) + вес подмешивания (авторится в редакторе). */
export interface PoseContent {
  /** Чей это контент — ключ `pe_swing` и прочих пер-персонажных настроек. Нет поля (тесты) — умолчания класса предмета. */
  charId?: string;
  /** Персонаж-донор (монстры → воин): у него ищутся и клипы, и настройки. */
  fallbackId?: string;
  /**
   * ⭐⭐ ДОНОР ТОЛЬКО ПОХОДКИ — последняя ступень поиска клипа локомоции, и БОЛЬШЕ НИЧЕГО.
   *
   * Нужен игрокам: `fallbackId` подменяет весь контент персонажа (стойки, удары, привязки, вид
   * предметов), и раздать его классам значило бы молча отдать магу воинские стойки. А без всякого
   * донора класс без своего `run_fwd` уезжает на процедурный планировщик прямо в игре.
   */
  gaitFallbackId?: string;
  resolveUpper(weapon: string, combat?: number, t?: number): UpperPose | null;   // combat 0..1 — блендит relaxed idle ↔ combat_idle; t — время живой стойки (сек), 0 = первый кадр
  shieldOverlay?(weaponKey: string): { pose: Pose; mix: number } | null;   // per-оружие: поза стойка_<wk> (фолбэк стойка_shield) + mix
  /** Клип состояния (`stagger`, `knockdown_fall`, `getup`…) по привязке из `pe_anim`. Нет клипа → null. */
  stateClip?(state: string): Clip | null;
  /** Клип локомоции по имени конвенции (`run_fwd`, `walk_strafe_L`…). Нет — ползунок Ф4 просто молчит. */
  /** Клип локомоции: имена-кандидаты в порядке приоритета + оружие (набор `none` работает на всех). */
  locoClip?(names: readonly string[], weapon: string): Clip | null;
  /** Настройка состояния: приоритет, прерываемость, кроссфейд, владение ногами. */
  stateCfg?(state: string): { priority: number; interruptible: boolean; blendSec: number; legs: 'auto' | 'never' | 'always' };
  /** ⭐ ЖИВОЙ ХВАТ из `pe_gripposes` (см. `liveGrip`). Нет метода — хват только запечённый, как раньше. */
  gripPose?(weapon: string, axes: Record<string, FingerAxes> | null, clipName?: string): Pose | null;
}
/** Активный удар: клип + время (сек). Верх наложится поверх idle/маха с огибающей. */
export interface AttackState {
  clip: Clip | null;
  t: number;
  /** Владение ногами этим состоянием (Ф1.3a). Нет → `auto` = по скорости, как было. */
  legs?: 'auto' | 'never' | 'always';
  /** Приоритет и прерываемость — чтобы следующее состояние знало, можно ли перебить это. */
  prio?: number;
  lock?: boolean;
}

export { WPN_KEYS, WPN_POS } from './clipModel.js';          // спец-ключи позы: поворот/позиция оружия (одна копия — clipModel)

// ── СЛОИ РАНТАЙМА НА ТОМ ЖЕ ТИПЕ МАСКИ, что импорт и правка (`boneMask.ts`) ──────────────────────
// Было: три ЗАХАРДКОЖЕННЫХ списка костей + отдельная карта затухания. Одно и то же понятие («какие кости
// берёт этот слой и с каким весом») в четырёх видах, и ни один нельзя было ни увидеть, ни настроить.
// Стало: `BoneMask` с по-костными весами — ровно `Layered blend per bone` + `Blend Mask` из Unreal.
// Списки/веса РАЗВЁРНУТЫ ОДИН РАЗ на старте модуля: горячие циклы бегут по массиву, как и раньше.
const w1 = (bones: readonly string[]): Record<string, number> => Object.fromEntries(bones.map((b) => [b, 1]));
/** Слой «верх idle»: корпус + плечи + кисти (остальное ведёт гейт). */
const UPPER_MASK: BoneMask = { parts: {}, weights: w1(['Chest', 'UpperChest', 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand']) };
/** Слой удара: обе руки целиком + корпус. */
const ATK_MASK: BoneMask = { parts: {}, weights: w1(['LeftUpperArm', 'RightUpperArm', 'LeftLowerArm', 'RightLowerArm', 'Chest', 'UpperChest', 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand', 'Spine']) };
/**
 * Слой ЩИТА: левая рука (держит щит) + корпус, с затуханием ПО ДИСТАНЦИИ ОТ ЩИТА (кисть 1.0 → спина ~0).
 * Вес применяется ТОЛЬКО во время удара (× огибающая): в покое щит держит всё (guard), на ударе кисть
 * держит щит, а локоть/плечо/корпус свободны для маха. Это и есть Blend Mask — просто раньше он был зашит в код.
 */
const SHIELD_MASK: BoneMask = { parts: {}, weights: { LeftHand: 1, LeftLowerArm: 0.38, LeftUpperArm: 0.22, LeftShoulder: 0.15, UpperChest: 0.1, Chest: 0.07, Spine: 0.04 } };
/**
 * НОГИ СЛОТА ДЕЙСТВИЯ (Ф1.4). Удар с места — это не только руки: автор кладёт в клип перенос веса и
 * ПОДШАГ, и стоя они обязаны играть. На ходу ими владеет локомоция, поэтому вес этого слоя = `1 − moveMag`,
 * ровно тот же гейт, что уже стоит на тазе удара (`applyAttackPelvis`). Отдельная маска, а не расширение
 * `ATK_MASK`: у верха и низа РАЗНЫЕ веса, в этом вся суть — руки бьют и на бегу, ноги только стоя.
 */
const ATK_LEGS_MASK: BoneMask = { parts: {}, weights: w1(['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes']) };
const layerBones = (m: BoneMask): string[] => [...maskBones(m)];
/**
 * ⭐⭐ ХВАТ (ФАЛАНГИ) — СВОЙ СЛОЙ, ВЕСОМ 1, ПОВЕРХ ВСЕГО.
 *
 * Хват уезжает в игру ЗАПЕЧЁННЫМ В КЛИПЫ (запекание на публикации, см. поз-редактор), и запекание
 * работает: ЗАМЕР опубликованных клипов — по **30 фаланг в кадре**. А в игре пальцы всё равно
 * прямые, и причин было ДВЕ:
 *  • у игровой куклы НЕ БЫЛО КОСТЕЙ ПАЛЬЦЕВ (`buildHumanoid` без `fingers`) — каналу некуда
 *    приземляться, `bones.get(...)` отдаёт `undefined`, и канал молча теряется;
 *  • слои позы и удара идут по ЯВНЫМ спискам костей (`UPPER_BONES` — ровно 6 штук, `ATK_BONES` — 11),
 *    и фаланг в них нет.
 *
 * ⚠ ВЕС 1, А НЕ ВЕС СЛОЯ: хват — статичная поза кисти, а не мах. Блендить его к нулю по ходу значило
 * бы РАСПРЯМЛЯТЬ пальцы на бегу тем сильнее, чем быстрее бежишь.
 */
const FINGER_RE = /^(Left|Right)(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;
function applyGripChannels(human: Humanoid, pose: Pose | null | undefined): void {
  if (!pose) return;
  for (const nm in pose) {
    if (nm.charCodeAt(0) === 95 || !FINGER_RE.test(nm)) continue;   // `__hipsP` и прочие спец-ключи мимо
    const b = human.bones.get(nm); const v = pose[nm];
    if (b && v) b.rotation.set(v[0], v[1], v[2]);
  }
}
/**
 * ⭐⭐ ЖИВОЙ ХВАТ: ИГРА РЕЗОЛВИТ КОНФИГ САМА, а не ждёт запечённого в клип.
 *
 * Жалоба «хват так и не появился нигде». ЗАМЕР расставил всё по местам:
 *  • на СЕРВЕРЕ в каждом клипе по **30 ненулевых каналов фаланг** (запекание на публикации работает);
 *  • в ЛОКАЛЬНОМ `pe_clips` — **0**;
 *  • а игра читает клипы ИМЕННО ИЗ localStorage (`localStorageContent` → `readJSON('pe_clips')`).
 *
 * То есть запечённый хват физически не доезжал ни до игры, ни до вкладки «Тест»: обе читают локальную
 * рабочую копию, а запекание живёт только в кнопке «Опубликовать». И протухало бы вдобавок: правка
 * хвата не появилась бы в игре, пока не опубликуешь заново.
 *
 * Поэтому хват резолвится В РАНТАЙМЕ из `pe_gripposes` — тем же `resolveGripPose`, что рисует
 * редактор. Запекание остаётся для тех, кто умеет читать ТОЛЬКО клипы (Unity, экспорт).
 */
const _axCache = new WeakMap<Humanoid, Record<string, FingerAxes>>();
function fingerAxesOf(human: Humanoid): Record<string, FingerAxes> {
  let a = _axCache.get(human);
  if (!a) {
    a = deriveFingerAxes((b) => { const g = human.bones.get(b); return g ? [g.position.x, g.position.y, g.position.z] : null; });
    _axCache.set(human, a);
  }
  return a;
}
/** Поза хвата из живого конфига для этой куклы/оружия/клипа. Контент без метода (тесты, чужой источник) — null. */
function liveGrip(human: Humanoid, content: PoseContent, weapon: string, clipName?: string): Pose | null {
  return content.gripPose ? content.gripPose(weapon, fingerAxesOf(human), clipName) : null;
}
export const UPPER_BONES = layerBones(UPPER_MASK);
const ATK_BONES = layerBones(ATK_MASK);
const ATK_LEG_BONES = layerBones(ATK_LEGS_MASK);
export const SHIELD_BONES = layerBones(SHIELD_MASK);
const SHIELD_FALLOFF: Record<string, number> = Object.fromEntries(SHIELD_BONES.map((b) => [b, boneWeight(SHIELD_MASK, b)]));
/** Убрать суффикс '+shield' — позы/удары берём по БАЗОВОМУ оружию, щит идёт отдельным оверлеем. */
export const baseWeapon = (w: string): string => (w.endsWith('+shield') ? w.slice(0, -'+shield'.length) : w);
/** Миграция старой конвенции имён клипов на новую (idle_/hit_): стойка_<w>→idle_<w>, удар_<w>→hit_<w>.
 *  Применяется при чтении, чтобы старые сохранённые клипы/ссылки (poseClips) работали без разрушительной миграции.
 *  Новые префиксы (idle_/hit_/s_hit_) и произвольные имена не трогаются. */
export const migratePoseName = (name: string): string =>
  name.startsWith('стойка_') ? 'idle_' + name.slice('стойка_'.length)
    : name.startsWith('удар_') ? 'hit_' + name.slice('удар_'.length)
      : name;
/** Ретаргет имени клипа при копировании в другое оружие: конвенционное `<idle_|hit_|s_hit_><fromW>` → `<prefix><toW>`;
 *  иначе если имя содержит подстроку fromW — заменить первое вхождение; иначе имя без изменений. */
export function retargetClipName(name: string, fromW: string, toW: string): string {
  for (const p of ['combat_idle_', 'idle_', 'hit_', 's_hit_']) if (name === p + fromW) return p + toW;
  return fromW && name.includes(fromW) ? name.replace(fromW, toW) : name;
}
const AB_IN = 0.1, AB_OUT = 0.14;                              // огибающая входа/выхода удара (сек)

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

// ── Общий two-bone IK (закон косинусов) — для off-hand хвата (двуручное) и переиспользования редактором ──
const _ik0 = new THREE.Vector3(), _ik1 = new THREE.Vector3(), _ik2 = new THREE.Vector3(), _ik3 = new THREE.Vector3(), _ik4 = new THREE.Vector3(), _ik5 = new THREE.Vector3(), _ik6 = new THREE.Vector3();
const _ikA = new THREE.Vector3(), _ikB = new THREE.Vector3(), _ikq = new THREE.Quaternion(), _ikq2 = new THREE.Quaternion();
/** Аналитический two-bone IK: root/mid/end к targetWorld; pole — сторона изгиба сустава; endQuatWorld (опц.) — мировая
 *  ориентация конца (кисть). Длины и оси костей берутся из локальных оффсетов рига, поэтому работает и для руки, и для ноги. */
/** `guard` — запас до полного выпрямления (юниты). 0.5 в игре, чтобы локоть/колено не вставало в замок;
 *  на ЗАПЕКАНИИ нужен маленький (та же грабля, что у `footIk.legGeomFor`): прямая рука, стоящая ровно в цели,
 *  иначе даёт постоянный промах в полюнита. */
export function solveTwoBoneIK(human: Humanoid, rootN: string, midN: string, endN: string, targetWorld: THREE.Vector3, endQuatWorld: THREE.Quaternion | null, pole: THREE.Vector3, guard = 0.5): void {
  const root = human.bones.get(rootN), mid = human.bones.get(midN), end = human.bones.get(endN);
  if (!root || !mid || !end) return;
  const aimRoot = _ik0.copy(mid.position).normalize(), aimMid = _ik1.copy(end.position).normalize();
  const L1 = mid.position.length(), L2 = end.position.length();
  root.updateMatrixWorld();
  const rp = root.getWorldPosition(_ik2);
  const dir = _ik3.copy(targetWorld).sub(rp);
  let d = dir.length(); d = clamp(d, Math.abs(L1 - L2) + guard, L1 + L2 - guard); dir.normalize();
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const bend = _ik4.crossVectors(dir, pole); if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1); else bend.normalize();
  const midPos = _ik5.copy(rp).addScaledVector(_ik6.copy(dir).applyAxisAngle(bend, a), L1);
  aimBone(root, aimRoot, midPos); aimBone(mid, aimMid, targetWorld);
  if (endQuatWorld) { end.updateMatrixWorld(); end.quaternion.copy(end.parent!.getWorldQuaternion(_ikq).invert().multiply(endQuatWorld)); end.updateMatrixWorld(); }
}
function aimBone(bone: THREE.Object3D, aim: THREE.Vector3, t: THREE.Vector3): void {   // повернуть кость так, чтобы её локальная ось aim смотрела в мир-точку t
  bone.updateMatrixWorld();
  const bp = bone.getWorldPosition(_ikA);
  const pq = bone.parent!.getWorldQuaternion(_ikq2).invert();
  const desired = _ikB.copy(t).sub(bp).normalize().applyQuaternion(pq);
  bone.quaternion.setFromUnitVectors(aim, desired); bone.updateMatrixWorld();
}

// ── temp-объекты (общие, без аллокаций в кадре) ──
const _wX = new THREE.Vector3(1, 0, 0), _qd = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _ed = new THREE.Euler();
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qSh = new THREE.Quaternion(), _euH = new THREE.Euler();
function qEuler(e: [number, number, number] | undefined, out: THREE.Quaternion): void { if (e) { _euH.set(e[0], e[1], e[2]); out.setFromEuler(_euH); } else out.identity(); }
function gaitArm(bone: THREE.Object3D | undefined, side: number, sh: number, sp: number, tw: number, armDown: number): void {
  if (!bone) return;
  _ed.set(0, tw, side * armDown + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh);   // рука ВНИЗ + мах вокруг X
  bone.quaternion.multiplyQuaternions(_qs, _qd);
}
function blendBone(human: Humanoid, name: string, gaitE: [number, number, number], idle: Pose | null, mag: number): void {
  const b = human.bones.get(name); if (!b) return;
  const held = idle ? idle[name] : undefined;
  if (!held) { b.rotation.set(gaitE[0], gaitE[1], gaitE[2]); return; }   // нет idle → чистый гейт
  qEuler(gaitE, _qA); qEuler(held, _qB); b.quaternion.copy(_qB).slerp(_qA, mag);   // idle(0) → гейт(1)
}
function blendArm(bone: THREE.Object3D | undefined, side: number, sh: number, sp: number, tw: number, held: [number, number, number] | undefined, hw: number, armDown: number): void {
  if (!bone) return;
  _ed.set(0, tw, side * armDown + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh); _qA.multiplyQuaternions(_qs, _qd);
  qEuler(held, _qB); bone.quaternion.copy(_qA).slerp(_qB, hw);
}
function blendEuler(bone: THREE.Object3D | undefined, gaitE: [number, number, number], held: [number, number, number] | undefined, hw: number): void {
  if (!bone) return;
  qEuler(gaitE, _qA); qEuler(held, _qB); bone.quaternion.copy(_qA).slerp(_qB, hw);
}
/**
 * Оружие: БАЗА хвата; поза с `__wpnOverride` доредактирует её весом стойки НА КИСТИ ЭТОЙ РУКИ — группа 0 висит на
 * главной (правой) кисти, группа 1 — на офф-руке (левой). Поворот предмета в кулаке обязан идти тем же весом, что и
 * сама кисть: разойдись они — меч довернётся под стойку, а запястье останется в позе клипа.
 */
function applyWeaponUpper(weaponGroups: THREE.Group[], pose: Pose, hwMain: number, hwOff: number = hwMain): void {
  const ovr = !!pose['__wpnOverride'];   // нет флага → жёстко база (единый хват во всех анимациях)
  weaponGroups.forEach((g, i) => {
    const hw = i === 0 ? hwMain : hwOff;
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    const br = g.userData.baseRot as THREE.Euler | undefined, bp = g.userData.basePos as THREE.Vector3 | undefined;
    if (ovr && rk && pose[rk] && br) { const h = pose[rk]!; g.rotation.set(br.x + (h[0] - br.x) * hw, br.y + (h[1] - br.y) * hw, br.z + (h[2] - br.z) * hw); }
    else if (br) g.rotation.copy(br);   // база (нет override) — хват держится жёстко
    if (ovr && pk && pose[pk] && bp) { const h = pose[pk]!; g.position.set(bp.x + (h[0] - bp.x) * hw, bp.y + (h[1] - bp.y) * hw, bp.z + (h[2] - bp.z) * hw); }
    else if (bp) g.position.copy(bp);
  });
}
/** Сколько свинг сервера считается «тем же самым», что наша автосцепка по окну комбо (сек). */
const COMBO_REGRAB = 0.2;
/**
 * ⭐⭐ КОМУ ПРИНАДЛЕЖАТ НОГИ ВО ВРЕМЯ УДАРА. Правило ДВОИЧНОЕ, а не пропорция:
 * **стоим и не крутимся — ноги у анимации; идём или крутимся — ноги живут своей жизнью.**
 *
 * Было `1 − moveMag`, то есть ПЛАВНАЯ доля. На шаге (moveMag ≈ 0.5) это давало ровно половину
 * статичной позы клипа поверх шагающей походки: ноги «то шаг делают, то резко улетают». А затвор
 * планировщика при этом стоял на TRUE — тот переставал возвращать стопу домой, и в конце удара
 * догонял разом. Полумеры тут не бывает: нога либо идёт по клипу, либо по планировщику.
 *
 * ⚠ ПОВОРОТ НА МЕСТЕ — ЭТО ТОЖЕ «НОГИ ЗАНЯТЫ». `moveMag` его не видит (скорость нулевая), и клип
 * забирал ноги, пока планировщик пытался переступать: подшагов нет, стопы ПЛЫВУТ за тазом. Признак
 * поворота уже есть — защёлка torso-lead (`turning`), у неё свой порог входа и выхода.
 *
 * ⚠ И НЕ ОТБИРАЕМ НОГУ ПОСРЕДИ ШАГА: пока планировщик несёт стопу (свинг), она его.
 */
const STILL_ON = 0.06, STILL_OFF = 0.16;   // гистерезис «стоим»: войти ниже ON, выйти выше OFF
const LEGS_FADE = 0.12;                     // за сколько секунд поза ног клипа гаснет/проступает
function attackEnv(tt: number, dur: number): number {
  const s = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
  if (tt < AB_IN) return s(tt / AB_IN);
  if (tt > dur - AB_OUT) return s((dur - tt) / AB_OUT);
  return 1;
}
function overlayAttack(human: Humanoid, weaponGroups: THREE.Group[], atk: AttackState, w = 1, legW = 0, grip: Pose | null = null): void {   // наложить позу удара по времени с огибающей
  const clip = atk.clip; if (!clip) return;
  const dur = clipDur(clip) || 0.001;
  const ab = attackEnv(atk.t, dur) * w;
  const ap = clipPoseAt(clip, atk.t / dur);
  const H = human.bones;
  for (const nm of ATK_BONES) { const e = ap[nm]; if (!e) continue; const b = H.get(nm); if (!b) continue; qEuler(e, _qB); b.quaternion.slerp(_qB, ab); }
  // НИЗ — своим весом: стоя клип владеет ногами (подшаг), на ходу ими владеет локомоция.
  const lw = ab * legW;
  if (lw > 1e-3) for (const nm of ATK_LEG_BONES) { const e = ap[nm]; if (!e) continue; const b = H.get(nm); if (!b) continue; qEuler(e, _qB); b.quaternion.slerp(_qB, lw); }
  applyGripChannels(human, ap);     // ⭐ ХВАТ УДАРА поверх хвата стойки (см. `applyGripChannels`): вес 1, не бленд
  if (grip) applyGripChannels(human, grip);   // ⚠ живой конфиг СИЛЬНЕЕ запечённого слепка, но не сильнее анимации пальцев (см. `liveGrip`)
  const ovr = !!ap['__wpnOverride'];   // удар двигает хват ТОЛЬКО если у кадра-удара стоит галка override; иначе хват жёсткий (база)
  if (ovr) weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk && ap[rk]) { const h = ap[rk]!; g.rotation.set(g.rotation.x + (h[0] - g.rotation.x) * ab, g.rotation.y + (h[1] - g.rotation.y) * ab, g.rotation.z + (h[2] - g.rotation.z) * ab); }
    if (pk && ap[pk]) { const h = ap[pk]!; g.position.set(g.position.x + (h[0] - g.position.x) * ab, g.position.y + (h[1] - g.position.y) * ab, g.position.z + (h[2] - g.position.z) * ab); }
  });
}

const _apE = new THREE.Euler(), _apQ = new THREE.Quaternion(), _apI = new THREE.Quaternion();
/** ОВЕРЛЕЙ ТАЗА УДАРА (in-place, Root ≠ Pelvis). hit_* может авторить МАХ/СКРУТКУ таза: дельта поворота (ключ 'Hips' euler)
 *  + смещение таза (ключ '__hipsP') — ПОВЕРХ facing, × огибающая удара. Тело крутится вокруг Root (контейнера),
 *  логическая позиция НЕ едет: позиция персонажа живёт на Root, а не на тазе.
 *  Смещение берётся как ДЕЛЬТА `__hipsP` кадра от `__hipsP` ПЕРВОГО кадра клипа — у ударов первый кадр это idle-стойка
 *  (`idleEnds`), значит дельта = «насколько таз ушёл от стойки». Отдельный ключ для этого не нужен.
 *  Зовётся ПОСЛЕ applyTorsoTwist (facing уже на тазе) и ДО applyHeadLookAt. Аддитивно: нет ключа → no-op. */
export function applyAttackPelvis(human: Humanoid, atk: AttackState, rootYaw: number, w = 1): void {
  if (!atk.clip || atk.t < 0) return;
  const dur = clipDur(atk.clip) || 0.001;
  const ab = attackEnv(atk.t, dur) * w;
  if (ab <= 1e-3) return;
  const hips = human.bones.get('Hips'); if (!hips) return;
  const ap = clipPoseAt(atk.clip, atk.t / dur);
  const e = ap['Hips'];
  if (e) { _apQ.setFromEuler(_apE.set(e[0], e[1], e[2], 'XYZ')); hips.quaternion.multiply(_apI.set(0, 0, 0, 1).slerp(_apQ, ab)); }   // поворот таза = дельта поверх facing × огибающая
  // Офсет таза кадра и стойки (body-кадр: X вбок-вправо, Y вверх, Z вперёд). Оба через hipsOffset:
  // дельта считается от ОДНОГО нуля, даже если кадры клипа в разных формах (часть перезаписана в редакторе).
  const restY = human.hipsRest.y;
  const mv = hipsOffset(ap, restY), basePose = atk.clip.keys[0]?.pose, base = basePose ? hipsOffset(basePose, restY) : null;
  if (mv && base) {
    const dx = (mv[0] - base[0]) * ab, dy = (mv[1] - base[1]) * ab, dz = (mv[2] - base[2]) * ab;
    const s = Math.sin(rootYaw), c = Math.cos(rootYaw);
    hips.position.x += dz * s + dx * c; hips.position.y += dy; hips.position.z += dz * c - dx * s;
  }
}
/**
 * ⭐⭐ ВЕСА СЛОЁВ ЭТОГО КАДРА (доля ЛОКОМОЦИИ на часть тела, см. `layerWeights.ts`) — scratch с тем же контрактом, что
 * `_stancePelvis`: пишет `gaitToHumanoid` из уже разобранной стойки, читает СИНХРОННО `applyUpper` того же вызова.
 * Голова нужна раньше рук (её кладёт сам `gaitToHumanoid`), поэтому разбор один и стоит в начале кадра.
 */
const _lw: ResolvedLayers = newResolvedLayers();
/**
 * ⭐⭐ ЗАПЕКАНИЕ СНИМАЕТ ЛОКОМОЦИЮ ЧИСТОЙ — БЕЗ СТОЙКИ В РУКАХ (перекрытие, тем же приёмом, что `setStancePelvisOverride`).
 *
 * ЗАМЕР (опубликованный воин, `run_fwd`, размах плеча по клипу): опубликованный клип 60.1°; свежий съём при
 * `pe_sway.none` 1.0 / 0.5 / 0.2 / 0 — 119.1° / 60.0° / 24.1° / 0.0°. То есть стойка ЗАПЕКАЛАСЬ в руки клипа долей
 * `1 − sway` того оружия, что было выбрано в редакторе на момент съёма, а при проигрывании клип смешивался со
 * стойкой ЕЩЁ РАЗ: под мечом (0.2) от маха оставалось 0.2 × 0.5 = 10 %, и вдобавок в позу меча подмешивалось
 * 10 % БЕЗОРУЖНОЙ стойки. Ровно та же грабля, что у таза стойки: дело рантайма, попав в клип, применяется дважды.
 *
 * Под перекрытием на ходу стойка частями верха не владеет вовсе (вес локомоции 1 и ворота 1: скорость съёма ходьбы
 * даёт `moveMag` 1 только при `speedWalk ≤ 40`, а зависеть от этого клипу незачем); стоя (клип `idle`, повороты) —
 * владеет целиком, как и было. Голова — как в смешанном режиме по умолчанию (вес 1), то есть каналы головы в клипах
 * не меняются. Клип помечается `Clip.upperPure` — редактор по метке предлагает перезапечь старые.
 */
let layerBakeOverride = false;
/**
 * ⭐ ЖИВОЙ ИСТОЧНИК ВЕСОВ ДЛЯ РЕДАКТОРА. Контент игровой куклы (`localStorageContent`) — СНИМОК localStorage на момент
 * сборки, а панель весов стоит на вкладке «Тест» рядом с этой самой куклой: ползунок обязан действовать на бегу, а
 * пересборка куклы на каждый `input` (физика + GLB) — это секунды. Поэтому редактор отдаёт сюда свои живые сторы, и
 * контент, пока источник задан, ищет веса в них, а не в снимке. В игре источника нет (`null`) — там снимок, как и было.
 * ⚠ Функцией, а не объектом: редактор свои сторы ПЕРЕПРИСВАИВАЕТ (подтянул с сервера — новый объект).
 */
let layerSource: (() => { layers: LayerStore; sway: SwayStore; swing?: SwingStore }) | null = null;
export function setLayerSource(src: (() => { layers: LayerStore; sway: SwayStore; swing?: SwingStore }) | null): void { layerSource = src; }
export function setLayerBakeOverride(on: boolean): void { layerBakeOverride = on; }
export function getLayerBakeOverride(): boolean { return layerBakeOverride; }
/**
 * ⭐⭐ МАХ РУК ЭТОГО КАДРА — ПО ПРЕДМЕТУ В КАЖДОЙ РУКЕ (`pe_swing`, см. `layerWeights.lookupItemSwing`). Scratch с тем
 * же контрактом, что `_lw`: пишет `gaitToHumanoid`, читает СИНХРОННО `applyUpper` того же вызова.
 */
const _swMain: SwingSet = { arm: { a: 0, k: 1 }, elbow: { a: 0, k: 1 }, wrist: { a: 0, k: 1 } };
const _swOff: SwingSet = { arm: { a: 0, k: 1 }, elbow: { a: 0, k: 1 }, wrist: { a: 0, k: 1 } };
/**
 * Источник `pe_swing`: игра — снимок localStorage (как весь остальной контент куклы), редактор — ЖИВОЙ стор через
 * `setLayerSource`, чтобы ползунок панели действовал на бегу без пересборки куклы.
 */
let swingSnapshot: SwingStore | null = null;
const swingStore = (): SwingStore => layerSource?.()?.swing ?? (swingSnapshot ??= readSwingStore(readJSON<unknown>('pe_swing', {})));
/** Забыть снимок `pe_swing` (публикация, смена персонажа в редакторе). */
export function resetSwingSnapshot(): void { swingSnapshot = null; }
/**
 * Разобрать махи рук кадра.
 * ⚠ ПОД ПЕРЕКРЫТИЕМ ЗАПЕКАНИЯ ОБЕ РУКИ СЧИТАЮТСЯ ПУСТЫМИ — иначе мах, ужатый под меч, запёкся бы в клип и лёг
 * ВТОРОЙ раз при проигрывании. Ровно та же грабля, что уже была у таза стойки и у весов частей.
 */
function frameSwing(up: UpperPose | null, charId: string, sb: number, combat: number, fallbackId?: string): void {
  const m = layerBakeOverride ? 'none' : (up?.hands?.main ?? 'none');
  // ⭐ ДВУРУЧНОЕ ЗАНИМАЕТ ОБЕ РУКИ. В составе стойки его слой ОДИН (`override` на весь верх, офф-рука не участвует —
  // см. `resolveStancePose`), поэтому вторая рука приехала бы сюда «пустой» и махала бы как свободная. Правило
  // принадлежит КЛАССУ предмета, поэтому живёт здесь, а не в контенте: иначе его пришлось бы повторить в редакторе.
  const o = layerBakeOverride ? 'none' : (TWO_HANDED_ITEMS.has(m) ? m : (up?.hands?.off ?? 'none'));
  Object.assign(_swMain, lookupItemSwing(swingStore(), charId, m, sb, combat, fallbackId));
  Object.assign(_swOff, lookupItemSwing(swingStore(), charId, o, sb, combat, fallbackId));
}
/** Разобрать веса кадра в `_lw`. `clipHead` — режим «только клипы» (умолчание головы 0), иначе смешанный (1). */
function frameLayers(up: UpperPose | null, sb: number, combat: number, clipHead: boolean): void {
  if (layerBakeOverride) { fillLayers(_lw, 1); return; }
  resolveLayers(up?.layers ?? null, sb, combat, up ? up.swing : LAYER_LEGACY_DEFAULT, clipHead ? 0 : 1, _lw);
}
/** Кости головы: в «только клипы» берутся из клипа долей `_lw.head` (в `LOCO_BONES` их нет — головой владеет стойка). */
const HEAD_BONES = ['Neck', 'Head'] as const;
/** Кости рук, которые в «только клипы» без авторской стойки берутся из клипа (корпус уже положил слой бега). */
const CLIP_ARM_BONES = ['LeftUpperArm', 'RightUpperArm', 'LeftLowerArm', 'RightLowerArm', 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand'] as const;
/**
 * ⭐ КОСТИ, КОТОРЫМИ ВЛАДЕЕТ ШОВ РУК (`applyUpper`) — ровно те десять, что он вёл и раньше.
 *
 * ⚠ ШЕИ И ГОЛОВЫ ЗДЕСЬ НЕТ, И ЭТО НЕСУЩЕЕ. Их кладёт `gaitToHumanoid` СВОИМ весом (`_lw.head`, там же клип головы в
 * «только клипы»), а `applyUpper` идёт ПОСЛЕ него и затёр бы их. Плюс `hwOf` решает сторону по первой букве имени —
 * `Neck`/`Head` попали бы в «правую руку» (поймано сторожом изоляции частей: вес руки двигал голову).
 */
const ARM_SEAM_BONES = ['LeftUpperArm', 'RightUpperArm', 'LeftLowerArm', 'RightLowerArm', ...UPPER_BONES] as const;
function applyUpper(human: Humanoid, weaponGroups: THREE.Group[], gx: GXKnobs, moveMag: number, t: PoseTargets, content: PoseContent, weapon: string, atk: AttackState, combat = 0, fade?: AttackFade | null, idleT = 0, atkLegs?: number, armsFrom: Pose | null = null, refFrom: Pose | null = null): void {
  const H = human.bones;
  const up = content.resolveUpper(weapon, combat, idleT);
  // Раздельные руки ходьба↔бег: armDown/elbowBend блендятся walk→run по t.sb (POSE armSh/armEl/armSwing уже слиты в pose.ts).
  const sb = t.sb ?? 0;
  const eDownB = gx.armDown + ((gx.armDownRun ?? gx.armDown) - gx.armDown) * sb;
  const eBendB = gx.elbowBend + ((gx.elbowBendRun ?? gx.elbowBend) - gx.elbowBend) * sb;
  // Те же две ручки на сторону (ASYM пуст → обе = общей, числа прежние).
  // ⚠⚠ ЧЕРЕЗ `locoVal`, А НЕ `sideLerp`: «руки вниз» — последняя из шести ручек, которые не спрашивали КОЛОНКУ
  // направления вовсе, хотя редактор честно рисовал их на вкладках «НАЗАД»/«СТРАЙФ»/«БОЙ». Смесь приезжает полем
  // `t.mix` (её кладёт планировщик); поля нет — колонок нет и работает база, то есть прежнее поведение.
  const mix = t.mix ?? { sb, st: t.st ?? 0, stR: 0, stL: 0, bt: t.bt ?? 0, ct: combat };
  const eDownL = locoVal('armDown', 'armDownRun', gx.armDown, gx.armDownRun ?? gx.armDown, 0, mix);
  const eDownR = locoVal('armDown', 'armDownRun', gx.armDown, gx.armDownRun ?? gx.armDown, 1, mix);
  const eBendL = sideLerp('elbowBend', 'elbowBendRun', gx.elbowBend, gx.elbowBendRun ?? gx.elbowBend, 0, sb);
  const eBendR = sideLerp('elbowBend', 'elbowBendRun', gx.elbowBend, gx.elbowBendRun ?? gx.elbowBend, 1, sb);
  void eDownB; void eBendB;
  // Ключицы: своя поза из гейта вместо прежнего «сводим в ноль».
  const shoL: [number, number, number] = [t.shoLX, t.shoLY, t.shoLZ];
  const shoR: [number, number, number] = [t.shoRX, t.shoRY, t.shoRZ];
  // ⭐ ВЕС СТОЙКИ НА ЧАСТЬ ТЕЛА: `1 − доля локомоции × ворота`. Ворота — ход (`moveMag`; в «только клипы» сюда приходит
  // сглаженная доля клипа). Под перекрытием запекания на ходу ворота = 1 (см. `setLayerBakeOverride`).
  const gate = layerBakeOverride ? (moveMag > 1e-3 ? 1 : 0) : moveMag;
  // ⚠ У РУК ЗДЕСЬ ВЕСА БОЛЬШЕ НЕТ: они резолвятся по ПРЕДМЕТУ в руке (`_swMain`/`_swOff`, см. `wOf` ниже).
  // Тут остаётся только грудь — часть, которая предмету не принадлежит.
  const hwChest = clamp(1 - _lw.chest * gate, 0, 1);
  /**
   * ⭐⭐ ДОЛЯ СТОЙКИ И ДОЛЯ МАХА НА КОСТЬ — ДВА ЧИСЛА (`armBlend`), а не одно.
   *
   * РУКИ резолвятся по ПРЕДМЕТУ В НИХ (`_swMain`/`_swOff` ← `pe_swing`): пустая рука без единой записи получает
   * `a=0, k=1` и машет ровно как в клипе, занятая — как настроено под этот предмет.
   * ГРУДЬ предмету не принадлежит: у неё по-прежнему один вес части (`pe_layers`), развёрнутый в пару
   * `a = 1 − доля`, `k = доля` — оба конца там точны так же (доля 1 → клип, доля 0 → стойка).
   *
   * ⚠⚠ ВОРОТА ХОДА — И НА МАХ РУК ТОЖЕ. Настроенная пара описывает руку НА ПОЛНОМ ХОДУ; стоя локомоции нет вовсе, и
   * рука обязана быть в авторской стойке. Без этого стоящий персонаж держал беговую позу, на остановке щёлкал в
   * стойку (замер: 34.4° за кадр), а запечённая стойка `idle` уезжала от авторской на 47°.
   */
  const wOf = (nm: string): ArmWeights => {
    const b = ARM_BONE_OF[nm];
    if (b) {
      const p = (b.hand === 'main' ? _swMain : _swOff)[b.part];
      return { a: 1 - (1 - p.a) * gate, k: p.k * gate };
    }
    return { a: hwChest, k: 1 - hwChest };
  };
  /** Доля СТОЙКИ на кисти своей руки — ею же доворачивается предмет в кулаке (`applyWeaponUpper`): разойдись они,
   *  меч довернулся бы под стойку, а запястье осталось в позе клипа. */
  const hwWrist = (hand: 'main' | 'off'): number => clamp(wOf(hand === 'main' ? 'RightHand' : 'LeftHand').a, 0, 1);
  if (layerTrace.on) {
    // Строка слоя — как была (средний вес стойки; при одном числе на весь верх — ровно оно), под ней — части.
    // Средняя доля СТОЙКИ по костям руки и груди — одна строка «сколько верха сейчас держит стойка».
    const parts = ['LeftUpperArm', 'RightUpperArm', 'LeftHand', 'RightHand', 'Chest'].map((nm) => wOf(nm).a);
    const mean = parts.reduce((x, y) => x + y, 0) / parts.length;
    traceRow('ПОЗА ВЕРХА', up ? (combat > 0.001 ? `стойка (бой ${(combat * 100) | 0}%)` : 'стойка') : 'нет — чистый мах',
      up ? mean : 0, up ? undefined : 'авторской стойки для этого оружия нет');
    if (up) {
      const src = armsFrom ? 'клип хода' : 'мах походки';
      // Руки — по предмету в них; в подписи виден и сам предмет, иначе непонятно, откуда взялось число.
      for (const [label, hand, item] of [['рука Л', 'off', up.hands?.off ?? 'none'], ['рука П', 'main', up.hands?.main ?? 'none']] as const) {
        const w = wOf(hand === 'main' ? 'RightUpperArm' : 'LeftUpperArm');
        traceRow('↳ ' + label, item === 'none' ? src + ' (рука пуста)' : `${src} + «${item}»`, clamp(w.k, 0, 1),
          `мах ${w.k.toFixed(2)} · покой у стойки ${w.a.toFixed(2)} · ход ${gate.toFixed(2)}`);
      }
      traceRow('↳ грудь', src, clamp(_lw.chest * gate, 0, 1), `вес ${_lw.chest.toFixed(2)} × ход ${gate.toFixed(2)}`);
    }
  }
  for (const it of layerTrace.items) {
    traceRow(it.hand === 'main' ? 'ГЛАВНАЯ РУКА' : 'ВТОРАЯ РУКА', it.item, it.weight,
      it.kind === 'override' ? 'замена верха целиком (двуручное)' : 'дельта к безоружной базе');
  }
  // ⭐ РЕЖИМ «ТОЛЬКО КЛИПЫ»: «походная» сторона каждой кости руки — поворот ИЗ КЛИПА, а не процедурный мах.
  // Смешивание со стойкой то же самое (`hw`), поэтому оружие, `pe_sway` и хват работают как раньше.
  // Кости, которой в клипе нет, клип не трогает: её «походная» сторона — сама стойка (иначе клип без каналов
  // рук ставил бы руки в ноль, то есть в Т-позу).
  if (armsFrom && !up) {
    // Стойки нет: покой — та же процедурная рука, что в ветке ниже (мах в «только клипы» нулевой), а к клипу — ПО МЕРЕ
    // ХОДА. ⚠ Было «клип целиком»: стоя фаза клипа замирает, и рука висела на махе, пока доля клипа не угаснет, а
    // потом щёлкала в покой — 41° за кадр (замер остановки с бега).
    gaitArm(H.get('LeftUpperArm'), -1, t.shL, t.shSpL, t.shTwL, eDownL);
    gaitArm(H.get('RightUpperArm'), 1, t.shR, t.shSpR, t.shTwR, eDownR);
    H.get('LeftLowerArm')!.rotation.set(0, -(Math.abs(t.elL) + eBendL), 0);
    H.get('RightLowerArm')!.rotation.set(0, Math.abs(t.elR) + eBendR, 0);
    const w = clamp(moveMag, 0, 1);
    for (const nm of CLIP_ARM_BONES) {
      const b = H.get(nm), e = armsFrom[nm];
      if (b && e) { qEuler(e, _qB); b.quaternion.slerp(_qB, w); }
    }
  } else if (armsFrom && up) {
    // ⭐⭐ ШОВ: якорь (нейтраль клипа ↔ стойка) + аддитивный мах. Нейтраль — смешанная теми же весами колонок, что и
    // поза (`refFrom`); её нет (клипов в смеси не нашлось) — берём сам клип, тогда `Δswing` тождественна и рука
    // садится в якорь, а не дёргается.
    for (const nm of ARM_SEAM_BONES) {
      const b = H.get(nm); if (!b) continue;
      const v = blendArmKey(nm, refFrom?.[nm] ?? armsFrom[nm], armsFrom[nm], up.pose[nm], wOf(nm));
      if (v) b.rotation.set(v[0], v[1], v[2]);
    }
    applyGripChannels(human, up.pose);
    applyWeaponUpper(weaponGroups, up.pose, hwWrist('main'), hwWrist('off'));
  } else if (!up) {   // нет idle-позы → полный мах гейта
    gaitArm(H.get('LeftUpperArm'), -1, t.shL, t.shSpL, t.shTwL, eDownL);
    gaitArm(H.get('RightUpperArm'), 1, t.shR, t.shSpR, t.shTwR, eDownR);
    // Локоть гнётся вокруг ЛОКАЛЬНОЙ Y (лево −Y / право +Y): кисть форерукава лежит на локальной +X, поэтому X =
    // ТВИСТ вдоль кости (кисть не двигается), а сгиб — вокруг Y (замерено; так же в правильных авторских idle_*).
    H.get('LeftLowerArm')!.rotation.set(0, -(Math.abs(t.elL) + eBendL), 0);
    H.get('RightLowerArm')!.rotation.set(0, Math.abs(t.elR) + eBendR, 0);
  } else {
    // ⭐⭐ ТОТ ЖЕ ШОВ НА ПРОЦЕДУРНОМ ПУТИ (превью вкладки «Бег» и запекатель). Два разных закона для одной ручки —
    // это вторая правда: автор крутил бы её на «Беге» и видел другое на «Тесте». Роль клипа здесь играет поза гейта,
    // роль его нейтрали — ТА ЖЕ поза с НУЛЕВЫМ махом (рука опущена по `armDown`, локоть согнут на базу): это ровно
    // «где рука стоит, когда не машет», то есть процедурный аналог средней позы цикла.
    const gaitArmPose = (side: number, sh: number, sp: number, tw: number, down: number): [number, number, number] => {
      _ed.set(0, tw, side * down + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh);
      _euH.setFromQuaternion(_qA.multiplyQuaternions(_qs, _qd), 'XYZ');
      return [_euH.x, _euH.y, _euH.z];
    };
    const proc: Pose = {
      LeftUpperArm: gaitArmPose(-1, t.shL, t.shSpL, t.shTwL, eDownL),
      RightUpperArm: gaitArmPose(1, t.shR, t.shSpR, t.shTwR, eDownR),
      LeftLowerArm: [0, -(Math.abs(t.elL) + eBendL), 0],
      RightLowerArm: [0, Math.abs(t.elR) + eBendR, 0],
    };
    const procRef: Pose = {
      LeftUpperArm: gaitArmPose(-1, 0, 0, 0, eDownL),
      RightUpperArm: gaitArmPose(1, 0, 0, 0, eDownR),
      LeftLowerArm: [0, -eBendL, 0],
      RightLowerArm: [0, eBendR, 0],
    };
    for (const nm of ARM_SEAM_BONES) {
      const b = H.get(nm); if (!b) continue;
      // Кости вне рук (грудь, шея, голова, кисти) гейт не ведёт — у них «походная» сторона это ноль, как было.
      const v = blendArmKey(nm, procRef[nm] ?? ZERO3, proc[nm] ?? ZERO3, up.pose[nm], wOf(nm));
      if (v) b.rotation.set(v[0], v[1], v[2]);
    }
    applyGripChannels(human, up.pose);   // ⭐ ХВАТ СТОЙКИ: фаланг нет ни в одном слое-списке (см. `applyGripChannels`)
    applyWeaponUpper(weaponGroups, up.pose, hwWrist('main'), hwWrist('off'));
  }
  // ⭐⭐ ЖИВОЙ ХВАТ ПОВЕРХ ЗАПЕЧЁННОГО — и в ветке «стойки нет» тоже: кисть держит оружие всегда.
  if (!up?.fingersAnimated) applyGripChannels(human, liveGrip(human, content, weapon, up?.clipName));
  // Кроссфейд цепочки: УХОДЯЩИЙ удар кладём первым с затухающим весом, входящий — поверх него.
  // Без этого второй `triggerAttack` жёстко подменял первый и на стыке комбо был рывок.
  // ПЛЕЧЕВОЙ ПОЯС — поверх всего, что легло на ключицу (авторская стойка или ноль), по мере хода:
  // стоим → ровно авторская стойка, разгоняемся → проступают настройки походки. Нули = ничего не делает.
  const shoW = clamp(moveMag, 0, 1);
  traceRow('ПОЯС И СКРУТКА', 'походка (в такт шагу)', shoW, 'поверх авторской стойки, по мере хода');
  // СКРУТКА КОРПУСА В ТАКТ ШАГУ кладётся ЗДЕСЬ, а не в `blendBone('Spine')`, по одной причине: цикл
  // `UPPER_BONES` выше принудительно ставит Chest/UpperChest в авторскую стойку (или в ноль), поэтому
  // всё, что легло на них раньше, было бы стёрто. Аддитивно и по мере хода — стоим, значит ровно
  // авторская стойка. Нули = прежнее поведение (скрутка жила только в пояснице).
  if (t.twChest) addEuler(H.get('Chest'), [0, t.twChest, 0], shoW);
  if (t.twUpper) addEuler(H.get('UpperChest'), [0, t.twUpper, 0], shoW);
  addEuler(H.get('LeftShoulder'), shoL, shoW);
  addEuler(H.get('RightShoulder'), shoR, shoW);
  // Вес НИЗА у слота действия: стоим — клип владеет ногами целиком, идём — ни на сколько.
  // Тот же множитель, что у таза удара; порог движения там же и описан (`moveMag`, а не `legMag`).
  // `auto` — по скорости (как было); `never` — слот низом не владеет; `always` — владеет всегда.
  // ⚠ ВЕС СЧИТАЕТ ПРОИГРЫВАТЕЛЬ (`PosePlayer.atkLegsW`), а не эта функция: правило двоичное и с
  // защёлками (стоим / крутимся / несём стопу), а здесь нет ни истории, ни поворота. Вызов без веса
  // (редакторский манекен, тесты) ведёт себя как раньше — по доле скорости.
  const legsOf = (a: AttackState): number =>
    a.legs === 'never' ? 0 : a.legs === 'always' ? 1 : (atkLegs ?? clamp(1 - moveMag, 0, 1));
  const legW = legsOf(atk);
  if (layerTrace.on) {
    const env = atk.clip && atk.t >= 0 ? attackEnv(atk.t, clipDur(atk.clip) || 0.001) : 0;
    const mode = atk.legs === 'never' ? 'только верх' : atk.legs === 'always' ? 'всегда низ' : 'ноги по скорости';
    traceRow('ДЕЙСТВИЕ', atk.clip ? atk.clip.name : 'пусто', env,
      atk.clip ? `${mode} · низ ${(legW * 100) | 0}%${atk.lock ? ' · ЗАМОК' : ''}${atk.prio ? ` · prio ${atk.prio}` : ''}` : undefined);
    if (fade && fade.atk.clip && fade.w > 0.001) traceRow('↳ уходящее', fade.atk.clip.name, fade.w, 'кроссфейд цепочки');
  }
  const atkGrip = (a: AttackState): Pose | null => (fingersAnimated(a.clip) ? null : liveGrip(human, content, weapon, a.clip?.name));
  if (fade && fade.atk.clip && fade.w > 0.001) overlayAttack(human, weaponGroups, fade.atk, fade.w, legsOf(fade.atk), atkGrip(fade.atk));
  if (atk.clip && atk.t >= 0) overlayAttack(human, weaponGroups, atk, 1, legW, atkGrip(atk));   // удар поверх idle/маха
}
const _wsP = new THREE.Vector3(), _wsT = new THREE.Vector3(), _wsPole = new THREE.Vector3();
const _wsQ = new THREE.Quaternion(), _wsFace = new THREE.Quaternion(), _wsFwd = new THREE.Vector3();
const _WS_UP = new THREE.Vector3(0, 1, 0);
/**
 * STRIDE WARPING: ОПОРНУЮ стопу тянем к планту планировщика весом `mix` (Ф4).
 *
 * Без этого ползунок «процедурно ↔ клип» кончился бы скольжением: у чужого клипа своя длина шага, и
 * на единице стопа поехала бы по полу. Планты ставит планировщик, поэтому подтягивать надо к ним.
 *
 * ⚠ ТОЛЬКО ОПОРНУЮ. Маховую планировщик ведёт К её будущему планту, и притягивать её туда посреди
 * переноса — значит выпрямить дугу шага в прямую и убить ровно ту форму, ради которой клип и брали.
 */
export function warpStanceFeet(human: Humanoid, target: readonly [readonly [number, number], readonly [number, number]], swing: readonly [boolean, boolean], mix: number): void {
  if (mix <= 0.001) return;
  for (let i = 0; i < LEG_COUNT; i++) {
    if (swing[i]) continue;
    const leg = legBones(i);
    const ub = human.bones.get(leg.u), lb = human.bones.get(leg.l), fb = human.bones.get(leg.f);
    if (!ub || !lb || !fb) continue;
    fb.getWorldPosition(_wsP);
    const t = target[i]!;
    // Высоту не трогаем: её держат поза и заземление. Тянем только по полу, и на долю `mix`.
    _wsT.set(_wsP.x + (t[0] - _wsP.x) * mix, _wsP.y, _wsP.z + (t[1] - _wsP.z) * mix);
    ub.getWorldQuaternion(_wsQ); _wsPole.set(0, 0, 1).applyQuaternion(_wsQ); _wsPole.y = 0;
    if (_wsPole.lengthSq() < 1e-6) _wsPole.set(0, 0, 1); else _wsPole.normalize();
    fb.getWorldQuaternion(_wsQ); _wsFwd.set(0, 0, 1).applyQuaternion(_wsQ);
    if (_wsFwd.x * _wsFwd.x + _wsFwd.z * _wsFwd.z < 1e-8) _wsFace.copy(_wsQ);
    else _wsFace.setFromAxisAngle(_WS_UP, Math.atan2(_wsFwd.x, _wsFwd.z));
    legGroundIK(ub, lb, fb, _wsT, _wsPole, _wsFace, legGeomFor(human, i));
  }
}

/** Полный ретаргет вывода гейта на humanoid: ноги/торс блендятся idle-стойка↔гейт по legMag (сглажен), верх — idle+мах+удар
 *  по armMag (мгновенная скорость: в покое = 0 → руки ТОЧНО idle; иначе — legMag). Раздельно, т.к. legMag оседает медленно. */
/** Компенсация A-стойки бинда ФБХ для ПРОЦЕДУРНОЙ реконструкции: её ik() считает «поворот бедра 0 = нога прямо вниз», а бинд
 *  splay-ит наружу → доворачиваем БЕДРО внутрь на human.legAdduct, нога вертикальна, стопы в планты. Компонентно к Z бедра.
 *  ⚠ `scale`=вес гейта (legMag): АВТОРСКАЯ idle-поза сделана НА бинде (Позы-таб рисует её БЕЗ аддукта) — ей компенсация НЕ нужна,
 *  иначе её сводит ýже, чем автор видел (баг «узкая стойка в игре/локо»). Поэтому аддукт масштабируем: idle(m=0)=0 (ширина автора),
 *  гейт(m=1)=полный (реконструкция компенсирована). measureStancePlants аддукт НЕ зовёт → планты = авторская ширина. */
export function applyLegAdduct(human: Humanoid, scale = 1): void {
  const at = (human.legAdduct ?? 0) * scale;                  // splay бедра (hip→колено) × вес гейта
  const kc = at - (human.legAdductKnee ?? 0) * scale;         // коррекция колена = splayБедра − splayГолени: доворот бедра УЖЕ
  if (Math.abs(at) < 1e-4 && Math.abs(kc) < 1e-4) return;     // повернул голень (она ребёнок) → на колене добираем только разницу,
  const lu = human.bones.get('LeftUpperLeg'), ru = human.bones.get('RightUpperLeg');   // чтобы голень стала ПАРАЛЛЕЛЬНА бедру (как у базового = прямая нога).
  const ll = human.bones.get('LeftLowerLeg'), rl = human.bones.get('RightLowerLeg');
  if (lu) lu.rotation.z -= at; if (ru) ru.rotation.z += at;   // бедро: Left splay +X → −Z сводит вертикально (риг: Left на +X, см. [[humanoid-rig-mirror]])
  if (ll) ll.rotation.z += kc; if (rl) rl.rotation.z -= kc;   // колено: голень ∥ бедру → нога вертикальна В ЛЮБОМ сгибе колена
}
/**
 * РАЗВОД БЁДЕР: колени наружу (+) или внутрь (−) при НЕПОДВИЖНОЙ стопе.
 *
 * БОКОВАЯ ось бедра (Z) — НЕ то же, что `kneeDir` (твист бедра, Y). Голень доворачиваем обратно,
 * чтобы нога разводилась КАК ЦЕЛОЕ, а не ломалась в колене.
 *
 * ⚠ СТОПА ПРИ ЭТОМ УЕЗЖАЕТ — и это неизбежно: с прибитой стопой любой доворот бедра — это полюс
 * колена, то есть `kneeDir`. ЗАМЕР: компенсация голени сокращает смещение стопы с 19.0 до 9.6 ед
 * при 0.4 рад и делает ногу прямой. Сам `kneeDir` ведёт себя так же (замер: +0.6 → стопа 3.09 → −2.58).
 *
 * ⚠ Первая версия просто прибавляла угол к решению IK (`hipLat`) — ЗАМЕР: стопа уезжала с планта
 * на 19 ед при 0.4 рад, то есть ручка ломала походку вместо того, чтобы менять её форму.
 * Знаки зеркала — как у аддукта: у ЛЕВОГО бедра +Z наружу (риг: Left на +X, см. [[humanoid-rig-mirror]]).
 */
export function applyHipSplay(human: Humanoid, l: number, r: number): void {
  if (Math.abs(l) < 1e-4 && Math.abs(r) < 1e-4) return;
  const lu = human.bones.get('LeftUpperLeg'), ru = human.bones.get('RightUpperLeg');
  const ll = human.bones.get('LeftLowerLeg'), rl = human.bones.get('RightLowerLeg');
  if (lu) lu.rotation.z += l; if (ll) ll.rotation.z -= l;
  if (ru) ru.rotation.z -= r; if (rl) rl.rotation.z += r;
}
/**
 * КРЕН И НАКЛОН ТАЗА НЕ ТАЩАТ ЗА СОБОЙ КОРПУС И НОГИ.
 *
 * `Hips` — корневая кость, `Spine` и оба бедра её прямые дети, поэтому поворот таза наследуется
 * телом один в один (ЗАМЕР: крен 0.3 → грудь тоже 34.7°, колено гуляет на 8.86). Компенсация —
 * вычесть тот же угол у прямых детей: корпус остаётся вертикальным и живёт своим «боковым
 * качанием», ноги держат направление, которое им дал IK.
 *
 * ⚠ Ставится ПОСЛЕ `blendBone`, а не внутрь него: бленд с авторской стойкой разбавил бы компенсацию,
 * а таз повёрнут жёстко. Тот же приём, что у `applyLegAdduct` и `applyHipSplay`.
 * ⚠ `twistTorso` ниже по потоку работает через `rotateY` (композиция), поэтому наш X/Z переживает её.
 * ⚠ Смещение самих ТАЗОБЕДРЕННЫХ СУСТАВОВ этим не убрать (2.73 ед при крене 0.3) — это и есть крен;
 * его отрабатывают ноги, стопу переставляет заземление.
 *
 * ⭐⭐ РЫСК (`yaw`) ДЕРЖИТСЯ ТОЛЬКО У НОГ, И ЭТО НЕ НЕДОДЕЛКА. Анатомически так и есть: на шаге таз крутится в
 * поперечной плоскости, а опорная нога стоит — угол уходит в ротацию бедра. А КОРПУС от рыска таза отворачивает
 * уже `applyTorsoTwist` (аргумент встречного отворота: рыск вычтен из бюджета скрутки и разложен по
 * Spine..UpperChest) — добавь его ещё и сюда, и отворот посчитается ДВАЖДЫ.
 * ЗАМЕР (рыцарь, процедурка, 120 u/с вбок, качание рыска 0.25): сырое скольжение стопы за 200 кадров опоры
 * 23.99 без держания ног против 19.33 с ним (при 9.56 у ровного таза), а с поворотом 20° — 22.11 против 13.71; цели плантов не дрожат ни там, ни там.
 */
const _htQ = new THREE.Quaternion(), _htH0 = new THREE.Quaternion(), _htS = new THREE.Vector3();
const _htUp = new THREE.Vector3(0, 1, 0);
/**
 * ⭐⭐ АВТОРСКИЙ ПОВОРОТ ТАЗА (`POSE.hipsTurn`) — ЧИСТО ВИДИМЫЙ: таз и корпус крутятся, НОГИ НЕТ.
 *
 * Требование автора (19.09): «сделай так, чтобы поворот таза не влиял на планты и на движение ног». Раньше угол
 * жил в КУРСЕ планировщика и ломал три вещи разом (ячейка плант-сетки, направление шага, `st` сама на себя).
 *
 * ⚠ ДЕРЖАНИЕ НОГ ЗДЕСЬ ТОЧНОЕ, А НЕ ВЫЧИТАНИЕМ ИЗ СЛОТА Y, как у крена/наклона (`applyHipsTiltHold`). Вычитание
 * из эйлера — не обратный поворот: `Rx(a)·Ry(b−t)·Rz(c) ≠ Ry(−t)·Rx(a)·Ry(b)·Rz(c)` при ненулевых `a`/`c`, а на
 * ходу они ненулевые ВСЕГДА. Здесь мы левым умножением крутим таз (`Ry(t)·H0`) и тем же сопряжением возвращаем
 * бедро: `L' = H1⁻¹·H0·L` — МИРОВАЯ ориентация ноги сохраняется БИТ В БИТ, а значит стопа не «доворачивается».
 *
 * ⚠ ЧТО ЭТИМ УБРАТЬ НЕЛЬЗЯ И НЕ НУЖНО: сами ТАЗОБЕДРЕННЫЕ СУСТАВЫ уезжают, потому что таз — твёрдое тело
 * (у рыцаря полутаз 3.6 → при 35° сустав идёт на 2.07 вбок и 0.65 вперёд). Это и ЕСТЬ поворот таза. Смещение
 * возвращается РОВНО (`H1·s − H0·s`) и вычитается из фидбэка стоп — иначе планировщик увидел бы уехавшую стопу,
 * прибил бы плант к ней и погнался за собственным хвостом (ЗАМЕР без вычета: расхождение плантов 0 → 28 ед. за 8 с).
 *
 * Возвращает смещение стопы каждой ноги в МИРОВЫХ X/Z: `[l.x, l.z, r.x, r.z]` (буфер переиспользуется).
 */
const _turnShift: [number, number, number, number] = [0, 0, 0, 0];
export function applyHipsTurn(human: Humanoid, turn: number): readonly [number, number, number, number] {
  _turnShift[0] = _turnShift[1] = _turnShift[2] = _turnShift[3] = 0;
  if (!turn) return _turnShift;
  const hb = human.bones.get('Hips'); if (!hb) return _turnShift;
  _htH0.copy(hb.quaternion);
  hb.quaternion.premultiply(_htQ.setFromAxisAngle(_htUp, turn));
  // Сопряжение: `H1⁻¹·H0` в кадре таза. Считаем один раз — обеим ногам оно одно.
  const conj = _htQ.copy(hb.quaternion).invert().multiply(_htH0);
  const legs = ['LeftUpperLeg', 'RightUpperLeg'] as const;
  for (let i = 0; i < 2; i++) {
    const b = human.bones.get(legs[i]!); if (!b) continue;
    b.quaternion.premultiply(conj);
    // Смещение сустава: `H1·s − H0·s` (s — положение бедра в кадре таза, константа рига).
    const after = _htS.copy(b.position).applyQuaternion(hb.quaternion);
    const ax = after.x, az = after.z;
    const before = _htS.copy(b.position).applyQuaternion(_htH0);
    _turnShift[i * 2] = ax - before.x; _turnShift[i * 2 + 1] = az - before.z;
  }
  return _turnShift;
}
export function applyHipsTiltHold(human: Humanoid, roll: number, pitch: number): void {
  const hb = clamp(POSE.hipsTiltHoldBody, 0, 1), hl = clamp(POSE.hipsTiltHoldLegs, 0, 1);
  const bz = roll * hb, bx = pitch * hb, lz = roll * hl, lx = pitch * hl;
  if (Math.abs(bz) > 1e-6 || Math.abs(bx) > 1e-6) {
    const sp = human.bones.get('Spine');
    if (sp) { sp.rotation.z -= bz; sp.rotation.x -= bx; }
  }
  if (Math.abs(lz) > 1e-6 || Math.abs(lx) > 1e-6) {
    for (const n of ['LeftUpperLeg', 'RightUpperLeg']) {
      const b = human.bones.get(n);
      if (b) { b.rotation.z -= lz; b.rotation.x -= lx; }
    }
  }
}
/**
 * ⭐⭐ КАЧАНИЕ РЫСКА ТАЗА (`POSE.hipsYawSwing`) — ТОЖЕ ЧИСТО ВИДИМОЕ: таз и корпус качаются, НОГИ НЕТ.
 *
 * Жалоба автора (19.09, тюн новых ручек таза): «если я делаю, чтобы таз доворачивался, когда передняя нога идёт
 * вперёд, нога начинает ходить по дуге — надо, чтобы колено и ступня держались так, как настроено». То же
 * требование, что у СТАТИЧЕСКОГО поворота (`applyHipsTurn`), и держание здесь ТО ЖЕ САМОЕ — сопряжение
 * `L' = H1⁻¹·H0·L`. Разница ровно одна: угол МЕНЯЕТСЯ КАЖДЫЙ КАДР, поэтому неизменного смещения, которое глаз
 * не видит, здесь не бывает — оно и читается как «дуга».
 *
 * ⚠⚠ ПОЭТОМУ СУСТАВ ПРИБИВАЕТСЯ, А НЕ ВЫЧИТАЕТСЯ ИЗ ФИДБЭКА, КАК У ПОВОРОТА. Тем же сопряжением, но к ПОЗИЦИИ
 * кости бедра: `p' = H1⁻¹·H0·s` даёт `H1·p' = H0·s`, то есть сустав стоит РОВНО там, где стоял бы при качании 0.
 * У статического поворота смещение сустава ПОСТОЯННО (таз развёрнут и не крутится) — там его честно отрабатывают
 * ноги, а из фидбэка планировщика оно вычитается. У качания оно ОСЦИЛЛИРУЕТ в такт шагу, и это ровно вторая часть
 * дуги. ЗАМЕР (рыцарь `knight_06` + опубликованный воин, бег 120, качание 0.1 рад, разомкнутая геометрия):
 * дуга стопы 1.902 ед, из них поворот самой ноги 1.856 и снос сустава 0.389 — то есть сустав даёт пятую часть,
 * и держать надо ОБА слагаемых. Прибитый сустав уезжает от таза не больше чем на этот же снос (0.39 ед при 0.1,
 * 0.78 при 0.2 на полутазе 4.15) — на бедре шириной ~7 ед это доли процента скина.
 *
 * ⚠ ЧТО ЭТО ЗАМЕНИЛО: вычитание `yaw` из слота Y эйлера бедра (было внутри `applyHipsTiltHold`, ручкой
 * `hipsTiltHoldLegs`). Вычитание из эйлера обратным поворотом НЕ является — та же грабля, что расписана у
 * `applyHipsTurn`, — и сустав не трогало вовсе. ЗАМЕР (бег 120, качание 0.1): с ним стопа уезжала от траектории
 * качания 0 на 3.185 ед (RMS 2.014), курс стопы на 11.18°, полюс колена на 11.92°, а сами цели плантов — на 3.53 ед.
 * Больше геометрии (1.902) это потому, что повёрнутые стопы уходили в `setFeet` и планировщик гнался за ними.
 *
 * ⚠ РУЧКОЙ НЕ МАСШТАБИРУЕТСЯ И ГЕЙТОМ НЕ РАЗБАВЛЯЕТСЯ: это не стилевая ручка, а требование «качание не влияет на
 * ноги». `hipsTiltHoldLegs` осталась ровно тем, чем была названа, — держанием от КРЕНА и НАКЛОНА.
 * ⚠ КОРПУС сюда НЕ добавляется: его отворачивает `applyTorsoTwist` (рыск вычтен из бюджета скрутки), иначе дважды.
 */
const _hyhQ = new THREE.Quaternion(), _hyhH0 = new THREE.Quaternion(), _hyhE = new THREE.Euler();
export function applyHipsYawHold(human: Humanoid, pitch: number, yaw: number, roll: number): void {
  if (!yaw) return;
  const hb = human.bones.get('Hips'); if (!hb) return;
  // H0 — таз этого кадра БЕЗ рыска: ТА ЖЕ композиция `Rx·Ry·Rz`, что кладёт `gaitToHumanoid`, со снятым Y.
  _hyhH0.setFromEuler(_hyhE.set(pitch, 0, roll, 'XYZ'));
  const conj = _hyhQ.copy(hb.quaternion).invert().multiply(_hyhH0);   // `H1⁻¹·H0` — одно на обе ноги
  for (const n of ['LeftUpperLeg', 'RightUpperLeg']) {
    const b = human.bones.get(n); if (!b) continue;
    b.quaternion.premultiply(conj);     // ориентация ноги в мире — бит в бит как при качании 0
    b.position.applyQuaternion(conj);   // и сам сустав: `H1·(H1⁻¹·H0·s) = H0·s`
  }
}
// Приведение РУК в рантайме НЕ делаем: модели биндятся в T-позе (руки горизонт = поза покоя клипов). A-позный бинд корёжит
// ретаргет (46° доворота от бинда скин не тянет) → требуем экспорт скелета в T-позе. См. render3d/README.

/** Уходящий удар цепочки: его поза подмешивается с весом `w`, пока он не затух. */
export interface AttackFade {
  atk: AttackState;
  w: number;
  /** Темп УХОДЯЩЕГО клипа — он продолжает играть, пока гаснет. Не путать с длительностью кроссфейда. */
  rate: number;
  /** Длительность кроссфейда, сек. Нет → общее умолчание (`XFADE_SEC`). */
  fadeSec?: number;
}
/**
 * Кости, которые берёт на себя слой локомоции: ноги, таз и позвоночник. Руки и ключицы СОЗНАТЕЛЬНО
 * не входят — ими владеют стойка и предметы (слои 2–4), и клип локомоции не имеет права их трогать,
 * иначе меч в руке заживёт чужой жизнью.
 */
export const LOCO_BONES = [
  'Hips', 'Spine', 'Chest', 'UpperChest',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes',
] as const;

/**
 * ⭐ ПЕРЕКРЫТИЕ ДОЛИ КЛИПА ЛОКОМОЦИИ: клипы (1) ↔ планировщик (0), `null` — как настроено в редакторе (`pe_gait.locoMix`).
 * С 19.09 ИГРА СТАВИТ ЕГО В 1 НАСОВСЕМ (`online3d`: планировщик из игры убран, галки в настройках клиента больше нет);
 * редактор пользуется им для A/B на вкладке «Тест», запекатель — чтобы снимать процедурку (0).
 *
 * ⚠ Отдельным полем, а НЕ записью в `GAIT.locoMix`: та — контент (правится в редакторе, приезжает с конфигом персонажа и
 * перезаписывается при каждой смене куклы) — перекрытие обязано пережить загрузку конфига.
 */
/** Разгон доли клипа локомоции, сек: переключение «клипы ↔ планировщик» не должно быть рывком. */
const LOCO_FADE = 0.25;
/**
 * ⚠⚠ ВОРОТА ПО ДВИЖЕНИЮ: слой клипов бега ведёт ноги ТОЛЬКО на ходу; полный вес — с этой доли скорости
 * ходьбы (`moveMag`). Без них клип «вперёд» накрывал ноги и СТОЯ — застывшим кадром ходьбы на фазе, где
 * планировщик остановился, — и съедал подшаги поворота на месте: ЗАМЕР — подъём стопы 0.00 против 6.5
 * у планировщика, хотя шаги он делал те же (2 / 3 / 6 на 45° / 90° / 180°).
 */
const LOCO_MOVE_FULL = 0.25;
/** Гашение клипа поворота, если на середине поворота пошли (сек). */
const TURN_FADE = 0.15;
/**
 * ⭐⭐ РЕЖИМ «ТОЛЬКО КЛИПЫ» — клиент без StepPlanner. С 19.09 это ЕДИНСТВЕННЫЙ режим игры.
 *
 * Включается, когда доля клипа локомоции равна единице (игра — всегда, перекрытием; в редакторе — ползунок на 1 или
 * выбор «как в игре» на вкладке «Тест») И у куклы есть запечённый набор (`hasLocoSet`). Тогда планировщик НЕ ОБНОВЛЯЕТСЯ и НИ ОДИН его выход не читается — это
 * стережётся тестом, который подменяет выходы планировщика на исключения. Всё, что он давал, берётся так:
 *
 *   что давал планировщик                  чем заменено
 *   часы клипов (фаза шага)                фаза ПО ПРОЙДЕННОМУ ПУТИ: длина цикла = скорость запекания × период
 *   ходьба ↔ бег (`sb`)                    вес бега клипов по скорости (`locoRunWeight`: 0 до 40, 1 с 80 u/с)
 *   опорная нога (флаги переноса)          канал `__swing` клипа; нет его — окна опоры по фазе и доле опоры
 *   подтяжка стопы к его плантам           ФИКСАЦИЯ СТОПЫ: где коснулась пола — там и держим, пока опора
 *   мах рук, плечевой пояс                 руки и пояс ИЗ КЛИПА, смешанные со стойкой по `pe_sway` как раньше
 *   веса заземления                        единицы (опору решает контакт)
 *   подшаги стоя                           только клипы поворота (нет их — ноги стоят, таз крутится: видно)
 *
 * Всё, чего здесь нет, — это и есть список того, что предстоит закрыть до вырезания планировщика.
 */
const CLIP_ONLY_TG = (): PoseTargets => ({
  hipL: 0, hipR: 0, knL: 0, knR: 0, hipLatL: 0, hipLatR: 0, ankL: 0, ankR: 0, shL: 0, shR: 0, elL: 0, elR: 0,
  lean: 0, twist: 0, bobY: 0, splay: 0, twChest: 0, twUpper: 0,
  shTwL: 0, shTwR: 0, shSpL: 0, shSpR: 0, hipTwL: 0, hipTwR: 0, leanSide: 0, headNod: 0, headTurn: 0, headTilt: 0,
  ankYawL: 0, ankYawR: 0, hipSplayL: 0, hipSplayR: 0, bobX: 0, hipsRoll: 0, hipsPitch: 0, hipsYaw: 0,
  toeCurlL: 0, toeCurlR: 0,
  shoLX: 0, shoLY: 0, shoLZ: 0, shoRX: 0, shoRY: 0, shoRZ: 0,
  wLX: 0, wLY: 0, wLZ: 0, wRX: 0, wRY: 0, wRZ: 0, sb: 0, st: 0, bt: 0,
});
const _lockV = new THREE.Vector3();
/**
 * Переход между режимами (планировщик ↔ «только клипы»), сек. Смешивать ДВА ИСТОЧНИКА здесь нечем —
 * в «только клипы» планировщик не считается вовсе, — поэтому поза в момент переключения ЗАПОМИНАЕТСЯ и
 * новая перетекает из неё (инерциализация «на бедность», как узел `Inertialization` в UE: гасим разницу,
 * а не держим оба источника). Иначе щелчок галки в настройках был бы рывком позы на 100°.
 */
const MODE_FADE = 0.25;
// ⚠ ОТВЕТЫ ШВОВ БЕЗ ПЛАНИРОВЩИКА — ОБЩИЕ КОНСТАНТЫ, а не свежие массивы: кадр куклы не должен
// аллокировать, а швы читаются по несколько раз за кадр на каждую куклу сцены. Читатели их НЕ МУТИРУЮТ.
const NO_SWING: readonly [boolean, boolean] = [false, false];
const NO_PLANT: readonly [number, number] = [0, 0];
const ONE_ONE: readonly [number, number] = [1, 1];
/**
 * ⭐ ДОЛЯ КЛИПА, ПРИ КОТОРОЙ КАДР СЧИТАЕТСЯ «ТОЛЬКО КЛИПЫ». Игра ставит 1 безусловно;
 * промежуточные доли бывают только в редакторе (A/B на вкладке «Тест») и в запекателе.
 */
const CLIP_ONLY_MIX = 0.999;
/**
 * ⭐ ДОЛЯ, С КОТОРОЙ ПОВОРОТЫ НА МЕСТЕ ИГРАЮТСЯ КЛИПАМИ — НИЖЕ, чем `CLIP_ONLY_MIX`, и нарочно.
 *
 * ⚠ Разница видна только в редакторе: там надо сравнивать поворот клипами с процедурным на
 * промежуточных долях. В игре оба порога всегда истинны одновременно.
 */
const CLIP_TURN_MIX = 0.5;
/**
 * ⭐⭐ «НАБОРА НЕТ» — ОДИН РАЗ НА ПАРУ (персонаж, оружие), А НЕ КАЖДЫЙ КАДР.
 *
 * До Э13б кукла без набора молча уезжала на процедурный планировщик — выглядело это как
 * «просто другая походка», и дыру в контенте было нечем заметить. Теперь персонаж просто скользит
 * в стойке — тоже молча, если не сказать. Сообщение называет КОГО и ПОД ЧТО не хватает — именно эти
 * два ключа нужны, чтобы найти строку в панели покрытия.
 */
const noSetWarned = new Set<string>();
export function warnNoLocoSet(charId: string, weapon: string): void {
  // ⚠ Разделитель — ОБЫЧНЫЙ символ. Здесь стоял NUL и попал в файл НАСТОЯЩИМ байтом:
  // git счёл исходник БИНАРНЫМ (эвристика «NUL в первых 8 КБ»), перестал нормализовать переводы строк,
  // и коммит показал дифф на ВЕСЬ файл (6748 строк) вместо десятка правок.
  const k = charId + ' / ' + weapon;
  if (noSetWarned.has(k)) return;
  noSetWarned.add(k);
  console.warn(`[loco] нет набора хода: персонаж «${charId || '?'}», оружие «${weapon || 'none'}» — персонаж будет скользить в стойке. Запеки ему набор либо проверь донора (панель «ПОКРЫТИЕ НАБОРА»).`);
}
/** Только для тестов: забыть, кому уже говорили. */
export function resetNoLocoSetWarnings(): void { noSetWarned.clear(); noPlannerWarned = false; }
/**
 * ⭐⭐ КУКЛА БЕЗ ПЛАНИРОВЩИКА ПОПАЛА В ПРОЦЕДУРНУЮ ВЕТКУ — ГРОМКО, А НЕ МОЛЧА.
 *
 * После Э12 швы `planner*` в базе — пустышки. В игре до них не дойти (доля клипа всегда 1), но если
 * кто-то построит голый `PosePlayer` и пустит его без перекрытия — ноги просто замрут, без единой ошибки.
 * ⚠ Это уже случилось при самом Э12: два теста процедурной ветки не упали на компиляции, а тихо
 * поменяли числа (0.15 вместо 0.3) — то есть отлавливалось только порогами, а не типом. Нужен планировщик
 * — строй `BakePlayer`.
 */
let noPlannerWarned = false;
function warnNoPlanner(): void {
  if (noPlannerWarned) return;
  noPlannerWarned = true;
  console.warn('[loco] процедурная ветка у куклы БЕЗ планировщика (доля клипа < 1 у `PosePlayer`): ноги замрут. Нужен планировщик — строй `BakePlayer`.');
}
/**
 * ⭐⭐ ШАГИ (звук): ОДИН ШОВ НА ВСЕ РЕЖИМЫ — `onMark` с меткой `footstep`, той же, что ставится в клипе руками.
 *
 *   кто ведёт ноги            откуда шаг
 *   поворот клипом            метки шага клипа поворота; не размечены — касания его канала `__swing`
 *   «только клипы», на ходу   метки шага ВЕДУЩЕГО клипа бега; не размечены — касания клипа (`clipContact`)
 *   планировщик               его постановка стопы (перенос → опора)
 *
 * Касание берётся ровно из той опоры, что заземляет ноги (`groundSupport`), поэтому звук и стопа на полу —
 * одно и то же событие, а не два похожих расчёта. ⚠ Размеченный клип касаний НЕ озвучивает: иначе на один шаг
 * звучало бы два — метка автора и касание рядом с ней.
 *
 * Метки бега берутся с ВЕДУЩЕГО клипа (у кого колонка весит больше) — как Blend Space в Unreal с режимом
 * «Highest Weighted Animation»: клипы синхронны по фазе, и шаги со всех колонок сразу звучали бы пачкой.
 *
 * `STEP_MIN_GAP` — не чаще раза на ногу: два источника на одном касании (смена ведущего клипа, смена режима)
 * звучат одним шагом.
 */
const STEP_MIN_GAP = 0.12;
const STEP_MARKS: readonly [Mark, Mark] = [{ type: 'footstep', foot: 'L' }, { type: 'footstep', foot: 'R' }];
/** Кости, которыми владеет клип поворота: таз и ноги. Корпус — нет, его ведёт живая скрутка к прицелу. */
const TURN_BONES = ['Hips', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'] as const;
const _qT1 = new THREE.Quaternion(), _qT2 = new THREE.Quaternion(), _eT = new THREE.Euler(), _qSeam = new THREE.Quaternion();
/**
 * Подмешать кости клипа с весом `w` (slerp) + офсет таза. Общий шов для бега (`gaitToHumanoid`) и поворота.
 *
 * `yBase` / `yFrom`: высота таза клипа ложится ПРИРАЩЕНИЕМ — `y = yBase + hd.y − yFrom` (у поворота `yFrom` — таз его
 * первого ключа, `yBase` — высота стоя), а не абсолютом `hipsRest.y + hd.y`. `yBase` null — абсолют, как у бега.
 *
 * ⭐ ЗАЧЕМ ПОВОРОТУ ПРИРАЩЕНИЕ. Повороты запекаются ОДНИ на все стойки — в релакс-стойке (у набора нет боевой оси), и
 * абсолютная высота клипа поднимала боевого персонажа на весь поворот. ЗАМЕР (опубликованный warrior, рыцарь, бой, все
 * шесть поворотов): таз стоя 33.83, клип держал его на релакс-высоте 34.97 — в смешанном режиме скачок 1.14–1.46 за кадр
 * туда и назад (размах 1.14–1.82), в «только клипы» подъём ~0.9 на весь поворот. Стало: разрыва на старте нет ни в какой
 * стойке, режиме и риге; размах за поворот 0.14–0.54 — собственное движение таза клипа, как в релаксе.
 *
 * ⚠ Таз (кость и X/Z `rest + __hipsD`) кладётся В КАДРЕ ПЕРСОНАЖА, без курса: курс позже докладывает `applyTorsoTwist`
 * одним поворотом (`pelvisToWorld`). Повернуть здесь — и курс ляжет дважды.
 */
function blendClipBones(human: Humanoid, pose: Pose, w: number, bones: readonly string[], yBase: number | null = null, yFrom = 0, withHips = true): void {
  if (w <= 0.001) return;
  for (const nm of bones) {
    const b = human.bones.get(nm); const want = pose[nm];
    if (!b || !want) continue;
    _eT.set(b.rotation.x, b.rotation.y, b.rotation.z); _qT1.setFromEuler(_eT);
    _eT.set(want[0], want[1], want[2]); _qT2.setFromEuler(_eT);
    b.quaternion.copy(_qT1).slerp(_qT2, w);
  }
  const hd = withHips ? hipsOffset(pose, human.hipsRest.y) : null;
  if (hd) {
    const hp = human.bones.get('Hips')!.position;
    const ty = yBase === null ? human.hipsRest.y + hd[1] : yBase + hd[1] - yFrom;
    hp.set(hp.x + (human.hipsRest.x + hd[0] - hp.x) * w,
      hp.y + (ty - hp.y) * w,
      hp.z + (human.hipsRest.z + hd[2] - hp.z) * w);
  }
}
let locoMixOverride: number | null = null;
export function setLocoMixOverride(v: number | null): void { locoMixOverride = v; }
/** Текущий override (для UI и тестов). */
export function getLocoMixOverride(): number | null { return locoMixOverride; }
/**
 * ⭐⭐ ПЕРЕКРЫТИЕ ТАЗА АВТОРСКОЙ СТОЙКИ (`null` — как настроено в `GAIT.stancePelvis`). Нужно ЗАПЕКАТЕЛЮ: таз стойки —
 * дело РАНТАЙМА, и попав внутрь клипа он применился бы ВТОРОЙ РАЗ при проигрывании (см. `clipBake.procedural`).
 * ⚠ Отдельным полем, а не записью в `GAIT`: ручка — контент редактора, запекание не должно её портить (как `setDirWarpOverride`).
 */
let stancePelvisOverride: number | null = null;
export function setStancePelvisOverride(v: number | null): void { stancePelvisOverride = v; }
export function getStancePelvisOverride(): number | null { return stancePelvisOverride; }
/** Доля таза стойки этого кадра до гейтов (ручка либо перекрытие запекания). */
const stancePelvisKnob = (): number => clamp(stancePelvisOverride ?? GAIT.stancePelvis, 0, 1);
/**
 * ⭐ ТАЗ АВТОРСКОЙ СТОЙКИ ЭТОГО КАДРА — scratch, ровно тот же контракт, что у `_twBlend`: пишет `gaitToHumanoid` из уже
 * разобранной стойки (третьего `resolveUpper` заводить не надо — он не бесплатный), читает СИНХРОННО `PosePlayer.step`
 * в том же кадре. Числа КОПИРУЮТСЯ: ссылку на позу держать нельзя, её следующий кадр перезапишет.
 * Всё — В КАДРЕ ПЕРСОНАЖА (курс докладывает `applyTorsoTwist`). Высота (`__hipsD.y`) сюда НЕ кладётся: она уже
 * приезжает путём `standY` → `bobY` (см. `GAIT.stancePelvis`).
 */
const _stancePelvis = { has: false, rx: 0, ry: 0, rz: 0, dx: 0, dz: 0 };
/**
 * ⭐ ПРИЛОЖЕННЫЙ РЫСК ТАЗА ПРОЦЕДУРНОГО КАЧАНИЯ (рад) — scratch с тем же контрактом, что `_stancePelvis`: пишет
 * `gaitToHumanoid`, читает СИНХРОННО `PosePlayer.step` того же кадра. Это ЗАМЕР (`pelvisHeading` до/после), а не
 * `t.hipsYaw`: при ненулевом наклоне таза слот Y эйлера и курс композиции — разные числа.
 */
const _hipsYawApplied = { v: 0 };
const _hyE = new THREE.Euler(), _hyQ = new THREE.Quaternion();
function readStancePelvis(idle: Pose | null, restY: number): void {
  const e = idle ? idle['Hips'] : null;
  const d = idle ? hipsOffset(idle, restY) : null;
  _stancePelvis.has = !!(e || d);
  _stancePelvis.rx = e?.[0] ?? 0; _stancePelvis.ry = e?.[1] ?? 0; _stancePelvis.rz = e?.[2] ?? 0;
  _stancePelvis.dx = d?.[0] ?? 0; _stancePelvis.dz = d?.[2] ?? 0;
}
const _spE = new THREE.Euler(), _spQ = new THREE.Quaternion();
/**
 * Поворот таза стойки с весом: `Rx(x·w)·Ry(y·wYaw)·Rz(z·w)` — покомпонентное масштабирование эйлера, как у `addEuler`
 * (у обоих весах 1 это РОВНО авторский поворот, а это и есть контракт «включил ручку — вижу свою стойку»).
 */
const stancePelvisQuat = (rx: number, ry: number, rz: number, w: number, wYaw: number): THREE.Quaternion =>
  _spQ.setFromEuler(_spE.set(rx * w, ry * wYaw, rz * w, 'XYZ'));

export function gaitToHumanoid(human: Humanoid, weaponGroups: THREE.Group[], gx: GXKnobs, legMag: number, t: PoseTargets, content: PoseContent, weapon: string, atk: AttackState, armMag: number = legMag, noIk = false, combat = 0, fade?: AttackFade | null, idleT = 0, locoPose: Pose | null = null, locoMix = 0, atkLegs?: number, clipOnly = false, locoRef: Pose | null = null): void {
  human.reset();
  const up0 = content.resolveUpper(weapon, combat, idleT);
  const idle = up0?.pose ?? null;   // ПОЛНАЯ idle-стойка (ноги+торс+верх), боевая при combat>0
  frameLayers(up0, t.sb ?? 0, combat, clipOnly);   // ⭐ веса «локомоция ↔ стойка» по частям → `_lw` (читает и `applyUpper` ниже)
  frameSwing(up0, content.charId ?? '', t.sb ?? 0, combat, content.fallbackId);   // ⭐ мах каждой руки по предмету в ней → `_sw*`
  readStancePelvis(idle, human.hipsRest.y);   // ⭐ таз стойки → scratch; кладёт его `PosePlayer.step` ПОСЛЕ клипов и шва (см. `_stancePelvis`)
  const m = legMag;
  // Трасса собирается СНИЗУ ВВЕРХ, в порядке наложения слоёв — так же, как её показывает корень графа.
  if (layerTrace.on) { layerTrace.rows.length = 0; layerTrace.t = Date.now(); }
  traceRow('НОГИ / ТАЗ', 'планировщик шагов', m, m < 0.99 ? 'остальное — ноги из стойки' : undefined);
  human.bones.get('Hips')!.position.set(0, 30 + t.bobY, 0);   // боб таза (множитель ходьба/бег уже в bobY)
  // КРЕН И НАКЛОН ТАЗА (две плоскости) — в кадре персонажа. Ставим ДО `applyTorsoTwist`: курс он кладёт СЛЕВА
  // (`pelvisFrame.pelvisToWorld`), и наклон остаётся наклоном вперёд на любом курсе. Боковое смещение `bobX` — отдельно, в кадре ТЕЛА.
  // ⭐ РЫСК — ТРЕТЬЯ ОСЬ ТОГО ЖЕ ПОВОРОТА, и приложенный угол ИЗМЕРЯЕТСЯ, а не берётся из слота Y: эйлер
  // здесь `Rx(наклон)·Ry(рыск)·Rz(крен)`, и при ненулевом наклоне курс композиции слоту Y не равен
  // (ЗАМЕР — README, «РЫСК ТАЗА»). Число кладём в модульный scratch, читает его СИНХРОННО `PosePlayer.step`
  // того же кадра (тот же контракт, что у `_stancePelvis`): ему рыск нужен для бюджета скрутки и отворота.
  { const hb = human.bones.get('Hips')!;
    hb.rotation.x = t.hipsPitch; hb.rotation.y = t.hipsYaw; hb.rotation.z = t.hipsRoll;
    if (t.hipsYaw === 0) _hipsYawApplied.v = 0;
    else {
      const after = pelvisHeading(hb.quaternion);
      _hyQ.setFromEuler(_hyE.set(t.hipsPitch, 0, t.hipsRoll, 'XYZ'));
      _hipsYawApplied.v = wrapPi(after - pelvisHeading(_hyQ));
    } }
  blendBone(human, 'LeftUpperLeg', [t.hipL, t.hipTwL, t.hipLatL], idle, m);
  blendBone(human, 'RightUpperLeg', [t.hipR, t.hipTwR, t.hipLatR], idle, m);
  blendBone(human, 'LeftLowerLeg', [t.knL, 0, 0], idle, m);
  blendBone(human, 'RightLowerLeg', [t.knR, 0, 0], idle, m);
  // Стопа. Раньше здесь стоял жёсткий ноль — она не анимировалась ВООБЩЕ, и носок маховой ноги
  // чиркал по полу. Опорную всё равно перезапишет заземление (`groundFeet`), маховую ведёт поза.
  // ⚠ У СТОПЫ БЫЛ ЖЁСТКИЙ НОЛЬ ПО Y — носок нечем было развернуть, и «наружу/внутрь» правилось только
  // коленом (твист бедра), который уводит ВСЮ ногу. Теперь рыск стопы — свой канал (`POSE.footTurn`).
  // Заземление его НЕ съедает: `groundFeet` берёт рыск опорной стопы ИЗ ПОЗЫ (см. footIk.ts).
  blendBone(human, 'LeftFoot', [t.ankL, t.ankYawL, 0], idle, m); blendBone(human, 'RightFoot', [t.ankR, t.ankYawR, 0], idle, m);
  // ⚠ У НОСКА ТОЖЕ БЫЛ ЖЁСТКИЙ НОЛЬ — та же беда, что была у рыска стопы. Носок следовал за стопой и
  // уходил под пол на перекате (замер: до −1.567, ниже нуля 59 кадров из 300). Теперь у него свой
  // канал (`GAIT.toeOff`), а знак ЗАМЕРЕН по высоте кости, а не выведен.
  blendBone(human, 'LeftToes', [t.toeCurlL, 0, 0], idle, m); blendBone(human, 'RightToes', [t.toeCurlR, 0, 0], idle, m);
  // Аддукт масштабируем ТОЛЬКО когда idle АВТОРИТ ноги (тогда idle m=0 = авторская ширина, гейт m=1 = компенсирован). Без
  // авторских ног (монстры/процедурка, idle не задаёт LeftUpperLeg) ноги ВСЕГДА реконструкция → аддукт полный (иначе splay бинда).
  applyLegAdduct(human, (idle && idle['LeftUpperLeg']) ? m : 1);
  applyHipSplay(human, t.hipSplayL * m, t.hipSplayR * m);   // развод бёдер — поверх аддукта, тем же приёмом
  // ТОРС/ШЕЯ держат idle-стойку при ПОВОРОТЕ НА МЕСТЕ: блендим к гейту по МГНОВЕННОЙ скорости (armMag=0 стоя/крутясь), а не по
  // legMag (=1 на подшаге) — иначе спина разгибалась/клонило назад при развороте. При движении (armMag→1) — гейт-наклон. Скрутка
  // к прицелу (applyTorsoTwist) и head-look-at идут ОТДЕЛЬНО поверх этого.
  // В режиме «только клипы» корпус и шея — из стойки (вес 0), поверх ляжет клип: процедурного наклона нет.
  const torsoMag = clipOnly ? 0 : armMag;
  blendBone(human, 'Spine', [t.lean, t.twist, t.leanSide], idle, torsoMag);
  // ⚠ ДЕРЖИМ КОРПУС И НОГИ ПРИ КРЕНЕ/НАКЛОНЕ ТАЗА — и именно ЗДЕСЬ, ПОСЛЕ бленда, а не внутри его
  // тройки. `blendBone` подмешивает авторскую стойку весом `armMag`, а таз повёрнут ЖЁСТКО: вычитание
  // внутри тройки разбавилось бы вместе со стойкой, и стоя корпус всё равно кренился бы.
  applyHipsTiltHold(human, t.hipsRoll, t.hipsPitch);
  // ⭐⭐ А ОТ КАЧАНИЯ РЫСКА НОГИ ДЕРЖАТСЯ ТОЧНО — сопряжением и с прибитым суставом (см. `applyHipsYawHold`).
  // ⚠ ПОСЛЕ `applyHipsTiltHold`, а не до: тот правит эйлер бедра покомпонентно (`rotation.x -=`), и сопряжение,
  // положенное раньше, он бы разобрал и собрал заново — то есть уничтожил. Порядок здесь несущий.
  applyHipsYawHold(human, t.hipsPitch, t.hipsYaw, t.hipsRoll);
  // ⭐ ГОЛОВА — ЧАСТЬ С ВЕСОМ (`_lw.head`). Смешанный режим: доля ручек походки по ходу, умолчание 1 — как было бит в
  // бит. «Только клипы»: здесь стойка (`torsoMag` 0), а клип головы ложится ниже, сразу за слоем бега.
  blendBone(human, 'Neck', [t.headNod, t.headTurn, t.headTilt], idle, torsoMag * _lw.head);
  blendBone(human, 'Head', [0, 0, 0], idle, torsoMag * _lw.head);
  // ── ПОЛЗУНОК «ПРОЦЕДУРНО ↔ КЛИП» (Ф4) ──
  // Кладётся ЗДЕСЬ: ноги и торс уже процедурные, а верх (стойка, предметы, слот действия) идёт ниже
  // и ложится ПОВЕРХ — то есть ровно в том порядке, что и в стеке слоёв. Положи раньше — затрут ноги;
  // позже — клип съест стойку с оружием, и меч в руке начнёт жить чужой жизнью.
  if (locoMix > 0.001 && locoPose) blendClipBones(human, locoPose, locoMix, LOCO_BONES);
  // ⭐ ГОЛОВА ИЗ КЛИПА — только в «только клипы» и только долей `_lw.head` (умолчание 0 — головой владеет стойка, как
  // было). В смешанном режиме головой клипа никто не владел и не владеет: там её ведут ручки походки (выше).
  // ⚠ БЕЗ ТАЗА: офсет таза клипа уже положен строкой выше, второй вызов довёл бы его к цели ещё раз.
  if (clipOnly && locoMix > 0.001 && locoPose && _lw.head > 0.001) blendClipBones(human, locoPose, locoMix * _lw.head, HEAD_BONES, null, 0, false);
  if (layerTrace.on && idle) {
    const hg = clipOnly ? locoMix : torsoMag;
    traceRow('↳ голова', clipOnly ? 'клип хода' : 'ручки походки', clamp(_lw.head * hg, 0, 1), `вес ${_lw.head.toFixed(2)} × ход ${hg.toFixed(2)} · поверх — взгляд на прицел`);
  }
  // Руки — по МГНОВЕННОЙ скорости (в покое точная idle). В «только клипы» — мах ИЗ КЛИПА и вес — ДОЛЯ КЛИПА: она
  // сглажена (`LOCO_FADE`) и та же, что у ног. ⚠ Мгновенная скорость там не годится: на остановке она падает в ноль
  // за кадр, а фаза клипа замирает — рука щёлкала бы со взмаха в стойку.
  applyUpper(human, weaponGroups, gx, clipOnly ? locoMix : armMag, t, content, weapon, atk, combat, fade, idleT, atkLegs,
    clipOnly && locoMix > 0.001 ? locoPose : null, clipOnly && locoMix > 0.001 ? locoRef : null);
  // ЩИТ: подмешать позу левой руки+корпуса + хват щита ПОВЕРХ (после удара). В покое держит guard; на ударе — по спаду
  // от щита (кисть держит, корпус/плечо свободны для маха), огибающая удара плавно вводит/выводит это.
  // ⭐⭐ ЩИТ: ПОЗА — ТОЛЬКО НА УДАРЕ, ХВАТ — ВСЕГДА.
  //
  // ⚠ ЭТО БЫЛА СПЯЩАЯ МИНА ДВОЙНОГО ПРИМЕНЕНИЯ. Поза щита уже подмешана АДДИТИВНОЙ дельтой офф-руки внутри
  // `resolveStancePose` (слой предмета `none+shield`), а этот оверлей клал ТУ ЖЕ позу ВТОРОЙ раз, поверх всего и
  // весом `mix` (0.85), не зная ни про веса слоёв, ни про мах руки. Вне удара он ещё и плоский: маска
  // `SHIELD_FALLOFF` умножается на огибающую удара, то есть при `aenv = 0` не действует вовсе. Итог был бы «левая
  // рука встала колом»: мах 0.2 × остаток 0.15 ≈ 3 %.
  //
  // На живых данных оверлей МОЛЧАЛ (`shieldOverlay` ищет клип по ТОЧНОМУ имени конвенции — `idle_sword+shield`
  // либо `idle_shield`, а авторский называется `idle_none+shield_relax` и находится только по привязке `pe_anim`).
  // То есть беды не было видно — она ждала первого клипа, названного по-старому.
  //
  // ЧТО ОСТАЁТСЯ ЗА ОВЕРЛЕЕМ: только УДАР. Там у него настоящая работа, которой нет ни у кого другого, — маска по
  // расстоянию от щита: кисть держит щит, а локоть, плечо и корпус освобождаются под мах (`SHIELD_FALLOFF` ×
  // огибающая). Локомоцией же щита теперь заведует обычный слой предмета и ручка его руки.
  if (weapon.endsWith('+shield')) {
    const ov = content.shieldOverlay?.(weapon);
    if (ov) {
      const aenv = (atk.clip && atk.t >= 0) ? attackEnv(atk.t, clipDur(atk.clip) || 0.001) : 0;
      applyShieldOverlay(human, weaponGroups, ov.pose, ov.mix, aenv);
      if (layerTrace.on) {
        traceRow('ЩИТ', aenv > 0.001 ? 'поза щита на ударе' : 'только хват (позу ведёт слой предмета)',
          aenv > 0.001 ? clamp(ov.mix * aenv, 0, 1) : 0,
          'вне удара поза щита НЕ кладётся: она уже в стойке аддитивной дельтой офф-руки');
      }
    }
  }
  // ДВУРУЧНЫЙ ХВАТ: левая кисть IK-ом держит точку __lgripP на оружии (едет с оружием). Точка покадрово: idle → перехват в
  // ударе (берём кадр удара, иначе idle). Только когда левая рука СВОБОДНА (нет офф-руки: щита/дуала).
  if (!noIk && idle && weaponGroups.length && !weapon.includes('+')) {   // noIk (поза-LOD дальних) → пропуск off-hand IK
    const src = (atk.clip && atk.t >= 0) ? clipPoseAt(atk.clip, atk.t / (clipDur(atk.clip) || 1)) : idle;
    const lgP = src['__lgripP'] ?? idle['__lgripP'];
    if (lgP) applyOffhandGrip(human, weaponGroups, lgP, src['__lgripR'] ?? idle['__lgripR'] ?? [0, 0, 0]);
  }
}
// Двуручный off-hand хват: цель = RightHand.world ∘ грип-оружия(локал груп[0]) ∘ __lgrip; pole локтя — из авторской позы левой руки.
const _ogP = new THREE.Vector3(), _ogQ = new THREE.Quaternion(), _ogQ2 = new THREE.Quaternion(), _ogEu = new THREE.Euler();
const _ogSh = new THREE.Vector3(), _ogEl = new THREE.Vector3(), _ogLine = new THREE.Vector3(), _ogPole = new THREE.Vector3();
function applyOffhandGrip(human: Humanoid, weaponGroups: THREE.Group[], lgP: [number, number, number], lgR: [number, number, number]): void {
  const wg = weaponGroups[0]; const rh = human.bones.get('RightHand'); const lua = human.bones.get('LeftUpperArm'); const lla = human.bones.get('LeftLowerArm');
  if (!wg || !rh || !lua || !lla) return;
  human.root.updateMatrixWorld(true);
  const p = _ogP.set(lgP[0], lgP[1], lgP[2]).applyQuaternion(wg.quaternion).add(wg.position);   // __lgrip → space RightHand → мир
  rh.localToWorld(p);
  _ogEu.set(lgR[0], lgR[1], lgR[2]); _ogQ2.setFromEuler(_ogEu);
  const q = rh.getWorldQuaternion(_ogQ).multiply(wg.quaternion).multiply(_ogQ2);               // ориентация кисти в мире
  const sh = lua.getWorldPosition(_ogSh); const line = _ogLine.copy(p).sub(sh); const toEl = _ogPole.copy(lla.getWorldPosition(_ogEl)).sub(sh);
  toEl.addScaledVector(line, -(toEl.dot(line) / Math.max(1e-6, line.lengthSq())));               // pole = перпендикуляр локтя к линии плечо→цель
  const pole = toEl.lengthSq() > 0.5 ? toEl.normalize() : _ogPole.set(0, -1, -0.4);
  solveTwoBoneIK(human, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', p, q, pole);
}
/** Щит-оверлей: слерп костей SHIELD_BONES к позе щита + перенос ХВАТА щита (поворот/позиция). Вес кости = mix, а НА ВРЕМЯ
 *  удара (aenv 0..1) падает по спаду от щита: кисть держит, корпус свободен. Хват щита в клипе: у `idle_<оружие>+shield`
 *  щит — офф-рука (index-1 → __wpnOff), у базового `idle_shield` щит — единственное (index-0 → __wpnMain); в игре щит —
 *  группа[1], переносим полностью. Читаем __wpnOff, иначе __wpnMain (иначе брали бы грип ОРУЖИЯ и щит улетал). */
export function applyShieldOverlay(human: Humanoid, weaponGroups: THREE.Group[], pose: Pose, mix: number, aenv = 0): void {
  const H = human.bones;
  // ⚠⚠ ПОЗА — ТОЛЬКО ПОД ОГИБАЮЩЕЙ УДАРА. Вне удара её кладёт слой предмета в `resolveStancePose`, и второй раз
  // класть нельзя (см. вызывающий). Вес падает по расстоянию от щита: кисть держит его до конца, локоть и плечо
  // освобождаются под мах — в этом вся работа оверлея и она есть ТОЛЬКО на ударе.
  for (const nm of aenv > 0.001 ? SHIELD_BONES : []) {
    const e = pose[nm]; if (!e) continue; const b = H.get(nm); if (!b) continue;
    const w = clamp(mix * aenv * (SHIELD_FALLOFF[nm] ?? 0.1), 0, 1);
    if (w < 0.002) continue;
    qEuler(e, _qSh); b.quaternion.slerp(_qSh, w);
  }
  const g = weaponGroups[1];   // щит для '+shield'-оружия — вторая группа (первая — оружие в правой руке)
  if (g) {   // ХВАТ щита — ВСЕГДА И ПОЛНОСТЬЮ: щит сидит в кулаке как выставлено, что бы ни делала рука
    const r = pose['__wpnOff'] ?? pose['__wpnMain'], p = pose['__wpnOffP'] ?? pose['__wpnMainP'];
    if (r) g.rotation.set(r[0], r[1], r[2]);
    if (p) g.position.set(p[0], p[1], p[2]);
  }
}

// ── Плант-сетка стоп: 8 направлений × 2 скорости (шаг/бег) авторского сдвига цели ноги (body-local fwd,lat) ──
// lVia/rVia — упорядоченные body-local (fwd,lat) точки ОБВОДА свинга (нога облетает опорную, не сквозь). Пусто = прямой свинг.
type XY = [number, number];
export type Leg2 = { l: XY; r: XY; lVia?: XY[]; rVia?: XY[] };
export type PlantGrid = { walk: Leg2[]; run: Leg2[] };         // walk/run — по 8 ячеек (0=вперёд, шаг 45°)
export const DIR_STEP = Math.PI / 4;   // шаг ячейки плант-сетки (8 направлений); читает и `BakePlayer`
const STEP_HOLD = 0.35;   // сек: держим ноги на гейте после подшага (settled мерцает → иначе мигание idle↔гейт)
const zeroLeg = (): Leg2 => ({ l: [0, 0], r: [0, 0], lVia: [], rVia: [] });
export const emptyGrid = (): PlantGrid => ({ walk: Array.from({ length: 8 }, zeroLeg), run: Array.from({ length: 8 }, zeroLeg) });
const cloneVia = (v: XY[] | undefined): XY[] => (v ?? []).map((p) => [p[0], p[1]] as XY);
/** Прочитать сохранённую сетку (новый {walk,run} ИЛИ старый {l,r} → размазать во все ячейки). via опциональны (нет → []). */
export function loadPlantGrid(p: (Partial<PlantGrid> & { l?: [number, number]; r?: [number, number] }) | undefined): PlantGrid {
  const g = emptyGrid();
  if (p?.walk && p?.run) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) { const e = p[sp]![i]; if (e) g[sp][i] = { l: [...(e.l ?? [0, 0])] as XY, r: [...(e.r ?? [0, 0])] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }; } }
  else if (p?.l && p?.r) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) g[sp][i] = { l: [...p.l] as XY, r: [...p.r] as XY, lVia: [], rVia: [] }; }
  return g;
}
/** Билинейная интерполяция списка via-точек ноги по 4 ячейкам (walk/run × i0/i1 по ft, затем шаг↔бег по spB).
 *  Разная длина списков → паддинг [0,0] до max длины. Пусто везде → []. */
export function blendVia(grid: PlantGrid, key: 'lVia' | 'rVia', i0: number, i1: number, ft: number, spB: number): XY[] {
  const cells = [grid.walk[i0], grid.walk[i1], grid.run[i0], grid.run[i1]];
  const n = Math.max(0, ...cells.map((c) => c?.[key]?.length ?? 0));
  const get = (c: Leg2 | undefined, k: number, comp: 0 | 1): number => c?.[key]?.[k]?.[comp] ?? 0;
  const out: XY[] = [];
  for (let k = 0; k < n; k++) {
    const comp = (c: 0 | 1): number => {
      const w = get(grid.walk[i0], k, c) + (get(grid.walk[i1], k, c) - get(grid.walk[i0], k, c)) * ft;
      const r = get(grid.run[i0], k, c) + (get(grid.run[i1], k, c) - get(grid.run[i0], k, c)) * ft;
      return w + (r - w) * spB;
    };
    out.push([comp(0), comp(1)]);
  }
  return out;
}
/**
 * ⭐ ЗЕРКАЛО ПЛАНТ-СЕТКИ (сагиттальная плоскость тела): направление `i` ↔ `(8 − i) % 8`, левая нога ↔ правая, боковой
 * сдвиг (и у точек обвода) — с минусом. Сдвиги в осях тела АБСОЛЮТНЫЕ (`lat` к +X, где левая нога), см. `plant` в `pose.ts`.
 *
 * ЗАЧЕМ. Сетка — данные автора, а страйф-клипы снимаются ровно по ячейкам 2 (+X, `strafe_R`) и 6 (−X, `strafe_L`).
 * ЗАМЕР опубликованного воина: ходьба, ячейка 2 = Л [−9, 1.86] / П [5, 1.10], ячейка 6 — пустая. Разнос стоп вдоль
 * хода есть только у правого страйфа: манекен, доворот выкл — `walk_strafe_R` ширина 12.5 без касания голеней,
 * `walk_strafe_L` ширина 1.1 и голени касаются в 48 % кадров. Пока клипы шли диагональю, это было не видно.
 */
export const mirrorPlantDir = (i: number): number => (8 - (((i % 8) + 8) % 8)) % 8;
export function mirrorPlantCell(c: Leg2): Leg2 {
  const m = (v: XY[] | undefined): XY[] => (v ?? []).map((p) => [p[0], -p[1]] as XY);
  return { l: [c.r[0], -c.r[1]], r: [c.l[0], -c.l[1]], lVia: m(c.rVia), rVia: m(c.lVia) };
}
/** Где сетка НЕ зеркальна: пары (i, зеркало i) с расхождением больше `eps` ед. Ячейки 0 и 4 сверяются сами с собой. */
export function plantMirrorGaps(g: PlantGrid, eps = 0.5): { speed: 'walk' | 'run'; i: number; j: number; diff: number }[] {
  const out: { speed: 'walk' | 'run'; i: number; j: number; diff: number }[] = [];
  const cellDiff = (a: Leg2, b: Leg2): number => {
    let d = Math.max(Math.abs(a.l[0] - b.l[0]), Math.abs(a.l[1] - b.l[1]), Math.abs(a.r[0] - b.r[0]), Math.abs(a.r[1] - b.r[1]));
    for (const k of ['lVia', 'rVia'] as const) {
      const va = a[k] ?? [], vb = b[k] ?? [];
      if (va.length !== vb.length) return Infinity;
      for (let n = 0; n < va.length; n++) d = Math.max(d, Math.abs(va[n]![0] - vb[n]![0]), Math.abs(va[n]![1] - vb[n]![1]));
    }
    return d;
  };
  for (const speed of ['walk', 'run'] as const) {
    for (let i = 0; i <= 4; i++) {
      const j = mirrorPlantDir(i), a = g[speed][i], b = g[speed][j];
      if (!a || !b) continue;
      const diff = cellDiff(b, mirrorPlantCell(a));
      if (diff > eps) out.push({ speed, i, j, diff });
    }
  }
  return out;
}

// ── Провайдер контента из localStorage (same-origin с редактором): idle-стойки + удары + sway по классу ──
export interface GamePoseContent extends PoseContent {
  attackClip(weapon: string): Clip | null;
  clipByName(name: string): Clip | null;
  /** Поза скила под ЭКИПИРОВАННОЕ оружие: авторскую позу ретаргетит на текущее оружие (семейство), фолбэк — авторская. */
  resolveAbilityClip(name: string, weapon: string): Clip | null;
  /** Все hit_*-клипы данного оружия (для чередования базовой атаки), с фолбэком по оружию/персонажу. */
  attackClips(weapon: string): Clip[];
}
/** Главная рука ключа оружия (`sword+shield`→`sword`). */
const mainWeapon = (w: string): string => w.split('+')[0] ?? w;

/**
 * ЦЕПОЧКА НАСЛЕДОВАНИЯ КЛЮЧА ОРУЖИЯ — от точного к общему.
 *
 * `sword+shield` → `sword`: удары со щитом авторить НЕ НАДО, играют те же, что без щита, а щит
 * подмешивается отдельным оверлеем. Именно это правило и делает библиотеку конечной — иначе на
 * каждую пару рук пришлось бы заводить свой набор ударов.
 *
 * Вынесено отдельно, потому что по ней ищет ИГРА, а показывать её обязан РЕДАКТОР: без этого
 * список клипов на `sword+shield` пуст, и автор считает, что удары пропали (так и было).
 */
export const weaponChain = (w: string): string[] => {
  const out: string[] = [];
  for (const c of [w, baseWeapon(w), mainWeapon(w)]) if (!out.includes(c)) out.push(c);
  return out;
};
const readJSON = <T,>(key: string, fb: T): T => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : fb; } catch { return fb; } };
/** Контент (стойка/удар/sway) по charId; если у него нет клипа — берём у fallbackId (монстры → Волкодав). */
export function localStorageContent(charId: string, fallbackId?: string, gaitFallbackId?: string): GamePoseContent {
  // Имена клипов нормализуем на чтении (старая конвенция стойка_/удар_ → idle_/hit_), чтобы старые данные работали сразу.
  const clips = readJSON<Clip[]>('pe_clips', []).map((c) => (c && typeof c.name === 'string' ? { ...c, name: migratePoseName(c.name) } : c));
  const sway = readJSON<SwayStore>('pe_sway', {});
  // ⭐ ВЕСА СЛОЁВ ПО ЧАСТЯМ (`pe_layers`) + легаси `pe_sway` — поиск ОДНИМ швом с редактором (`lookupLayers`).
  // Контент — снимок localStorage на момент сборки куклы, поэтому ответ на ключ оружия считается один раз.
  const layerStore = readLayerStore(readJSON<unknown>('pe_layers', {}));
  const layerMemo = new Map<string, ReturnType<typeof lookupLayers>>();
  const layersOf = (w: string): ReturnType<typeof lookupLayers> => {
    if (layerSource) { const live = layerSource(); return lookupLayers(live.layers, live.sway, charId, w, fallbackId); }   // редактор: живые сторы (см. `setLayerSource`)
    let r = layerMemo.get(w);
    if (!r) { r = lookupLayers(layerStore, sway, charId, w, fallbackId); layerMemo.set(w, r); }
    return r;
  };
  const shieldCfg = readJSON<Record<string, { mix?: number; perWeapon?: Record<string, number> }>>('pe_shield', {});   // щит: базовый mix + per-оружие
  const find = (kind: string, id: string, w: string): Clip | null => clips.find((c) => c.name === kind + '_' + w && c.character === id && c.weapon === w) ?? null;
  const stance = (w: string): Clip | null => find('idle', charId, w) ?? (fallbackId ? find('idle', fallbackId, w) : null);
  const combatStance = (w: string): Clip | null => find('combat_idle', charId, w) ?? (fallbackId ? find('combat_idle', fallbackId, w) : null);   // боевая стойка (нет → null → фолбэк на relaxed idle)
  const atk = (w: string): Clip | null => find('hit', charId, w) ?? (fallbackId ? find('hit', fallbackId, w) : null);
  const anim = readAnimCfg(readJSON<unknown>('pe_anim', {}), charId, fallbackId);   // контроллер: предметы + привязки клипов
  // ⭐ ХВАТ ЖИВЁТ ЗДЕСЬ, А НЕ В КЛИПЕ (см. `liveGrip`). Ключ `pe_gripposes` — тот же, что у редактора.
  const gripCfg = readJSON<GripConfig>('pe_gripposes', EMPTY_GRIP_CONFIG());
  const gripMemo = new WeakMap<object, Map<string, Pose>>();
  const AXES_NONE: Record<string, FingerAxes> = {};   // ключ мемо для «осей нет»
  /** Клип стойки ПО ИМЕНИ ИЗ КОНФИГА: привязка сильнее конвенции, поэтому переименовывать ничего не надо. */
  const bound = (kind: 'idle' | 'combat_idle', item: string): Clip | null => {
    // ⚠ ПО ВСЕМ КАНДИДАТАМ: привязка → нынешняя конвенция (`idle_<оружие>_relax`) → историческая.
    // Смена конвенции не должна обнулять уже сделанное.
    for (const nm of anim.clipNames(kind, item)) {
      const byName = clips.find((c) => c.name === nm && c.character === charId) ?? (fallbackId ? clips.find((c) => c.name === nm && c.character === fallbackId) : undefined);
      if (byName) return byName;
    }
    return kind === 'idle' ? stance(item) : combatStance(item);   // нет привязки/клипа — конвенция, как было
  };
  // Клип по имени (нормализуем старое удар_→hit_) — свой персонаж, иначе фолбэк.
  const byName = (name: string): Clip | null => { const nm = migratePoseName(name); return clips.find((c) => c.name === nm && c.character === charId) ?? (fallbackId ? clips.find((c) => c.name === nm && c.character === fallbackId) ?? null : null); };
  /** Состав рук последнего разбора — заполняет `resolveStancePose`. Переиспользуемый: два вызова за кадр на куклу. */
  const layersOut: StanceLayerInfo[] = [];
  return {
    charId, fallbackId, gaitFallbackId,
    // Idle-стойка: ПОЛНАЯ авторская поза per-оружие (idle_<weapon>) в приоритете — так стойка с щитом/дуалом целиком как в
    // редакторе (оба оружия + грипы). Нет полной → по БАЗОВОМУ оружию (axe+shield → axe) + щит идёт оверлеем.
    /**
     * Стойка под экипировку. Авторская поза на точный ключ побеждает всегда; нет её — стойка
     * СОБИРАЕТСЯ из безоружной базы и дельт предметов по рукам (`resolveStancePose`). Тот же вызов
     * стоит в редакторе — правило «редактор ≡ игра» держится кодом, а не дисциплиной.
     */
    resolveUpper(weapon: string, combat = 0, t = 0): UpperPose | null {
      // ⚠⚠ ЗДЕСЬ СТОЯЛ ФОЛБЭК «нет позы на точный ключ — возьми БАЗОВОЕ оружие» (`sword+shield` →
      // `sword`), и он УБИВАЛ ВСЮ СБОРКУ СЛОЯМИ. Резолвер спрашивает точный ключ ПЕРВЫМ и, получив
      // ответ, возвращает его сразу — то есть на `sword+shield` приходила чистая стойка меча, и щит
      // не подмешивался НИКОГДА, если у меча была своя стойка. Жалоба «сделал idle щиту, а к мечу не
      // прицепилось» — ровно про это.
      //
      // Фолбэк не нужен: у сборки он уже есть и правильный — нет безоружной базы, берётся стойка
      // предмета главной руки (ветка 3 в `resolveStancePose`). Разница в том, что там он НЕ мешает
      // подмешать офф-руку.
      const look = (kind: 'idle' | 'combat_idle', item: string, tt: number): Pose | null => {
        const c = bound(kind, item);
        return c ? stancePoseAt(c, tt) : null;   // многокадровая стойка играет циклом, однокадровая держит кадр
      };
      // ⚠ Состав рук нужен ВСЕГДА (по нему резолвится мах руки), а инспектору — только когда он открыт. Поэтому
      // разбор ОДИН, а в инспектор состав КОПИРУЕТСЯ: отдать ему сам массив значило бы, что тот живёт до след. кадра.
      const pose = resolveStancePose(look, weapon, combat,
        { weight: (it) => anim.weightOf(it), kind: (it) => anim.kindOf(it), hand: (it) => anim.handOf(it),
          trace: layersOut }, t);
      if (layerTrace.on) { layerTrace.items.length = 0; for (const l of layersOut) layerTrace.items.push(l); }
      if (!pose) return null;
      const full = stance(weapon);
      // Ведущий клип стойки — по нему берётся хват КЛИПА и решается, анимированы ли пальцы.
      const lead = (combat > 0.5 ? bound('combat_idle', weapon) : bound('idle', weapon)) ?? full;
      // ⚠ Ключ весов больше НЕ зависит от того, есть ли полная стойка на точный ключ: это условие проверялось здесь по
      // историческому имени `idle_<w>`, а в редакторе — по привязке, и для `none+shield` они расходились (0.5 против 0.2).
      const lk = layersOf(weapon);
      let main = 'none', off = 'none';
      for (const l of layersOut) { if (l.hand === 'main') main = l.item; else off = l.item; }
      return { pose, swing: lk.swing, layers: lk.entry, hands: { main, off },
               clipName: lead?.name, fingersAnimated: fingersAnimated(lead) };
    },
    attackClip(weapon: string): Clip | null { return atk(baseWeapon(weapon)); },
    /** Клип состояния по привязке (`pe_anim.states`), иначе по имени состояния как есть. */
    stateClip(state: string): Clip | null { return byName(anim.stateName(state)); },
    /**
     * Клип локомоции (Ф4). Привязка `pe_anim` главнее (имя — лишь умолчание), затем кандидаты имени,
     * и на каждом — набор ПОД ОРУЖИЕ: точный → безоружный → любой (`findLocoClip`).
     */
    locoClip(names: readonly string[], weapon: string): Clip | null {
      const bound = names[0] ? anim.stateName(names[0]) : '';
      for (const n of [bound, ...names]) {
        if (!n) continue;
        const nm = migratePoseName(n);
        // ⭐⭐ ТРИ СТУПЕНИ ПЕРСОНАЖА: свой → общий донор контента → ДОНОР ТОЛЬКО ПОХОДКИ.
        // Третья — последняя надежда не уехать на процедурный планировщик. Она нарочно узкая: одалживает
        // ровно клип хода и ничего больше (см. `BASE_GAIT_CHAR`), поэтому стойки, удары и привязки у
        // персонажа остаются свои. Порядок важен: свой набор всегда бьёт донорский.
        const c = findLocoClip(clips, nm, charId, weapon)
          ?? (fallbackId ? findLocoClip(clips, nm, fallbackId, weapon) : null)
          ?? (gaitFallbackId && gaitFallbackId !== charId && gaitFallbackId !== fallbackId
            ? findLocoClip(clips, nm, gaitFallbackId, weapon) : null);
        if (c) return c;
      }
      return null;
    },
    stateCfg(state: string) { const c = anim.stateCfg(state); return { priority: c.priority, interruptible: c.interruptible, blendSec: c.blendSec, legs: c.legs }; },
    /** Живой хват: цепочка клип → оружие → авто (`effectiveWeaponGrip`). Считается один раз на (оси, оружие, клип). */
    gripPose(weapon: string, axes: Record<string, FingerAxes> | null, clipName?: string): Pose | null {
      const k: object = axes ?? AXES_NONE;
      let m = gripMemo.get(k); if (!m) { m = new Map(); gripMemo.set(k, m); }
      const key = weapon + '|' + (clipName ?? '');
      let pose = m.get(key);
      if (!pose) { pose = resolveGripPose(gripCfg, charId, weapon, axes, clipName); m.set(key, pose); }
      return pose;
    },
    clipByName(name: string): Clip | null { return byName(name); },
    // Поза скила под экип. оружие: если авторская на другом оружии — ретаргетим семейство (по clip.weapon) на текущее/базовое/главное; иначе авторская как есть.
    resolveAbilityClip(name: string, weapon: string): Clip | null {
      const orig = byName(name);
      if (!orig || orig.weapon === weapon) return orig;
      for (const cand of [weapon, baseWeapon(weapon), mainWeapon(weapon)]) { const c = byName(retargetClipName(name, orig.weapon, cand)); if (c) return c; }
      return orig;
    },
    // Базовая атака: ВСЕ hit_*-клипы оружия (стабильный цикл по имени), фолбэк по оружию (экип→база→главная) и персонажу.
    attackClips(weapon: string): Clip[] {
      const pick = (id: string): Clip[] => { for (const cand of weaponChain(weapon)) { const set = clips.filter((c) => c.character === id && c.weapon === cand && c.name.startsWith('hit_')); if (set.length) return set.slice().sort((a, b) => a.name.localeCompare(b.name)); } return []; };
      const own = pick(charId); return own.length ? own : (fallbackId ? pick(fallbackId) : []);
    },
    // Поза щита per-оружие: idle_<weaponKey> (фолбэк idle_shield) + вес (perWeapon[wk] ?? базовый mix). Нет клипа — нет оверлея.
    shieldOverlay(weaponKey: string): { pose: Pose; mix: number } | null { const c = stance(weaponKey) ?? stance('shield'); if (!c || !c.keys.length) return null; const cfg = shieldCfg[charId] ?? (fallbackId ? shieldCfg[fallbackId] : undefined); const mix = cfg?.perWeapon?.[weaponKey] ?? cfg?.mix ?? 0.85; return { pose: c.keys[0]!.pose, mix }; },
  };
}
type GaitCfg = { gait?: Record<string, number>; pose?: Record<string, number>; gx?: Record<string, number>; plant?: Partial<PlantGrid> & { l?: [number, number]; r?: [number, number] }; asym?: Record<string, [number, number]>; strafe?: Record<string, number>; strafeR?: Record<string, number>; strafeL?: Record<string, number>; back?: Record<string, number>; combat?: Record<string, number> };
export type { GaitCfg };
/**
 * ⭐⭐ МИГРАЦИЯ «ТАЗ ОТКРЫТ» → ПОВОРОТ ТАЗА (19.09). Конфиг с `hipsMode` 1 обязан ВЫГЛЯДЕТЬ ТАК ЖЕ: раскрытие было
 * ±угол по СТОРОНЕ хода (`openFrac`: +1 в секторе +X, −1 в −X), поэтому оно переезжает в ручку `hipsTurn` ОБЕИХ
 * сторон страйфа со своими знаками — общей колонкой «СТРАЙФ» знак стороны не выразить в принципе.
 * `hipsOpen` — угол на БЕГУ, `hipsOpenWalk` — на ходьбе: ровно пара ходьба/бег обычной ручки.
 *
 * ⚠ ОДИН ШОВ НА ИГРУ И РЕДАКТОР (иначе «редактор ≡ игра» рвётся ровно на миграции): зовут оба, до наката карт.
 * ⚠ Идемпотентна и НЕ ЗАТИРАЕТ уже настроенное: ключ `hipsTurn*` в колонке стороны уже есть — значит автор её
 * трогал после миграции, и лезть туда нельзя. Режим из `gait` вычищается — второй раз переносить нечего.
 * Возвращает true, если что-то перенесла (редактор на это пишет заметку «перенесено, перезапеки»).
 */
export function migrateHipsOpen(c: GaitCfg | undefined): boolean {
  const g = c?.gait; if (!g) return false;
  const D = Math.PI / 180;
  const on = ((g['hipsMode'] ?? 0) | 0) === 1;
  const run = (g['hipsOpen'] ?? 0) * D, walk = (g['hipsOpenWalk'] ?? 0) * D;
  // ⚠ Ключи снятого режима вычищаем ВСЕГДА, а не только при `hipsMode` 1: иначе `Object.assign(GAIT, c.gait)` тащил бы
  // мёртвые поля в живой `GAIT` до первой пересохранённой настройки.
  delete g['hipsMode']; delete g['hipsOpen']; delete g['hipsOpenWalk'];
  if (!on) return false;
  if (Math.abs(run) < 1e-6 && Math.abs(walk) < 1e-6) return false;
  let did = false;
  for (const [key, sign] of [['strafeR', 1], ['strafeL', -1]] as const) {
    const m = (c[key] ??= {});
    if (m['hipsTurn'] === undefined) { m['hipsTurn'] = walk * sign; did = true; }        // ⚠ БЕЗ округления: «тот же угол» значит ТОТ ЖЕ
    if (m['hipsTurnRun'] === undefined) { m['hipsTurnRun'] = run * sign; did = true; }
  }
  return did;
}
/** Ручка панели «Бег»: объект-хозяин и пара ключей «ходьба/бег». `kr === null` — ручка одна на обе скорости. */
export interface GaitSpeedKey { obj: Record<string, number>; kw: string; kr: string | null }

/**
 * ⭐⭐ СБРОС НАСТРОЕК БЕГА ПО ВЫБОРУ — ОДИН РЕЖИМ, ОДНА СКОРОСТЬ (просьба автора 20.09: «сброс пусть не
 * сбрасывает все настройки в каждой вкладке, а только в той, которая выбрана»).
 *
 * Функция ЧИСТАЯ по входу (никакого DOM и никаких глобалов): что чистить — приходит списком ручек, ровно
 * тем, который панель собрала, пока рисовала свои строки. Второй, отдельно поддерживаемый список ключей
 * неминуемо разошёлся бы с первым, и сброс молча перестал бы доставать до новых ручек.
 *
 * ДВЕ РАЗНЫЕ ОПЕРАЦИИ, и путать их нельзя:
 *  • КОЛОНКА (страйф / его сторона / назад / бой) — РАЗРЕЖЁННАЯ: ключ УДАЛЯЕТСЯ. «Записи нет» значит
 *    «работает уровень ниже» (сторона → общая колонка → база). ⚠ Записать сюда дефолт нельзя: колонка
 *    перестала бы откатываться вовсе, и это тихо — глазами не видно, пока не покрутишь соседний уровень.
 *  • БАЗА («вперёд») — ПЛОТНАЯ: ключ возвращается к ДЕФОЛТУ КОДА (`defOf`), колонки не трогаются вовсе.
 *
 * ⚠ РУЧКА БЕЗ RUN-ТВИНА (`kr === null`) живёт на обеих скоростях — её сбрасывает и «ходьба», и «бег»,
 * ровно как её и правит один и тот же ползунок на любой из скоростей.
 * ⚠ Run-твин без своего дефолта берёт дефолт ходьбы — та же посадка, что делает панель на входе.
 *
 * @returns сколько записей реально изменилось (для сторожа и для подписи кнопки).
 */
export function resetGaitScope(
  keys: readonly GaitSpeedKey[],
  o: {
    /** Выбрана скорость «бег»? */
    run: boolean;
    /** Разрежённая карта колонки, либо `null` — правим базу. */
    column: Record<string, number> | null;
    /** Суффикс пар Л/П этой колонки (`''` у базы). */
    sfx: string;
    /** Карта асимметрии Л/П (та же, что читает игра). */
    asym: Record<string, [number, number]>;
    /** Дефолты кода для объекта-хозяина ручки. Нужны только базе. */
    defOf: (obj: Record<string, number>) => Record<string, number>;
  },
): number {
  let n = 0;
  for (const { obj, kw, kr } of keys) {
    const key = o.run && kr ? kr : kw;               // тот же выбор ключа, что у самого ползунка
    const pair = o.column ? key + o.sfx : key;
    if (o.column) { if (key in o.column) { delete o.column[key]; n++; } }
    else {
      const d = o.defOf(obj);
      const v = d[key] ?? (key === kr ? d[kw] : undefined);
      if (v !== undefined && obj[key] !== v) { obj[key] = v; n++; }
    }
    if (o.asym[pair] !== undefined) { delete o.asym[pair]; n++; }
  }
  return n;
}

/** Загрузить тюн бега класса (pe_gait[charId]) в ГЛОБАЛЬНЫЕ GAIT/POSE и переданный gx; вернуть плант-сетку. Для ИГРОКА. */
export function applyGaitConfig(charId: string, gx: GXKnobs): PlantGrid {
  const cfgs = readJSON<Record<string, GaitCfg>>('pe_gait', {});
  const c = cfgs[charId];
  migrateHipsOpen(c);   // ⭐ старый «таз открыт» → ручка поворота таза, ТЕМ ЖЕ швом, что в редакторе
  // СБРОС К ДЕФОЛТАМ перед накатом конфига (как в редакторе): иначе ключи, которых в конфиге нет,
  // остаются от прошлого персонажа, а свёртка локтя прибавляла бы себя при каждой пересборке куклы.
  Object.assign(GAIT, GAIT_BASE); Object.assign(POSE, POSE_BASE);
  if (c?.gait) Object.assign(GAIT, c.gait);
  if (c?.pose) {
    Object.assign(POSE, c.pose);
    // RUN-твины рук: если конфиг задал walk-значение, но не задал run — run = walk (иначе run брал бы глобал-дефолт).
    if (c.pose['armShRun'] === undefined) POSE.armShRun = POSE.armSh;
    if (c.pose['armElRun'] === undefined) POSE.armElRun = POSE.armEl;
    if (c.pose['armSwingRun'] === undefined) POSE.armSwingRun = POSE.armSwing;
  }
  if (c?.gx) Object.assign(gx, c.gx);
  // АСИММЕТРИЯ И КОЛОНКИ НАПРАВЛЕНИЯ — ровно те же разреженные карты, что правит редактор.
  // ⚠ Загружать их ВСЕ обязательно: боевая колонка (Ф6) здесь отсутствовала, и настройка боя жила
  // только в редакторе — в игру не доезжала вовсе. Правило простое: карта есть в редакторе → она
  // грузится здесь, иначе редактор показывает одно, а игрок видит другое.
  for (const k of Object.keys(ASYM)) delete ASYM[k];
  for (const [k, v] of Object.entries(c?.asym ?? {})) if (Array.isArray(v) && v.length === 2) ASYM[k] = [v[0]!, v[1]!];
  for (const [map, src] of [[STRAFE, c?.strafe], [STRAFE_R, c?.strafeR], [STRAFE_L, c?.strafeL], [BACK, c?.back], [COMBAT, c?.combat]] as const) {
    for (const k of Object.keys(map)) delete map[k];
    for (const [k, v] of Object.entries(src ?? {})) if (typeof v === 'number') map[k] = v;
  }
  // Три места сгиба локтя → одна база. Тот же вызов в редакторе — иначе игра и редактор разъедутся.
  foldElbow(gx);
  return loadPlantGrid(c?.plant);
}
/** Загрузить ЛОКАЛЬНО gx + плант-сетку (БЕЗ записи в глобальные GAIT/POSE — их монстр делит с игроком).
 *  charId нет в pe_gait → берём fallbackId (монстры до тюнинга → плант Волкодава). Для МОНСТРОВ. */
export function loadGaitLocal(charId: string, gx: GXKnobs, fallbackId?: string): PlantGrid {
  const cfgs = readJSON<Record<string, GaitCfg>>('pe_gait', {});
  const c = cfgs[charId] ?? (fallbackId ? cfgs[fallbackId] : undefined);
  if (c?.gx) Object.assign(gx, c.gx);
  return loadPlantGrid(c?.plant);
}
/** Дефолт веса совпадения рендера с манекеном (RB2). ЕДИНЫЙ для игры (loadMatch) и редактора (loadPhys) → редактор =
 *  игра при нетюненом персонаже. 0.85 (не 0): без тюна рендер вёлся ЧИСТОЙ физикой — быстрый бег моторы не догоняют +
 *  реконструкция 21-кости из 15-тел укорачивает ноги (стопы вниз/провал). Высокий match → рендер ведёт аналит-поза. */
export const DEFAULT_MATCH = 0.85;
export const ATK_MATCH = 0.92;   // пиковый вес совпадения с авторской позой во время удара (физика одна не доводит быстрый замах до конечных кадров)
/** ЕДИНЫЙ вес совпадения РЕНДЕРА с позой-целью (физика→поза-бленд) для игры И редактора-локо → атлас-скин 1:1. Авторский
 *  per-кадр __match (если задан в кадре удара), иначе max(база персонажа, ATK_MATCH·огибающая удара). */
export function renderMatchWeight(base: number, attackWeight: number, attackMatch: number | null): number {
  return attackMatch != null ? attackMatch : Math.max(base, ATK_MATCH * attackWeight);
}
/** Вес совпадения РЕНДЕРА с манекеном (RB2, 0..1) per-char из pe_phys; фолбэк (монстры → Волкодав). Для ИГРЫ. */
export function loadMatch(charId: string, fallbackId?: string): number {
  const cfg = readJSON<Record<string, { match?: number }>>('pe_phys', {});
  return cfg[charId]?.match ?? (fallbackId ? cfg[fallbackId]?.match : undefined) ?? DEFAULT_MATCH;
}
/** Подъём стопы (юниты) per-char из pe_phys.footLift; фолбэк (монстры → gaitFallback). 0 = процедурная стопа на полу.
 *  Ставится на solid/target куклы → measureStancePlants (standY) и footIk.groundFeet поднимают цель заземления, чтобы
 *  ПОДОШВА МЕША атласа (лодыжка выше FOOT_Y) легла на пол. Редактор пишет тем же ключом → редактор ≡ игра. */
export function loadFootLift(charId: string, fallbackId?: string): number {
  const cfg = readJSON<Record<string, { footLift?: number }>>('pe_phys', {});
  return cfg[charId]?.footLift ?? (fallbackId ? cfg[fallbackId]?.footLift : undefined) ?? 0;
}
type GripSlot = { r: [number, number, number]; p: [number, number, number] };
/** БАЗОВЫЙ хват оружия/щита per-(char, weapon) из pe_grip (редактор пишет). Слоты [main(RightHand), off(LeftHand)].
 *  Это ЕДИНАЯ база хвата: применяется во ВСЕХ анимациях (idle/бег/удар) одинаково — оружие не «плавает» покадрово.
 *  Поза с флагом `__wpnOverride` может доредактировать хват поверх базы (галка в редакторе); без флага — жёстко база. */
export function loadGrip(charId: string, weapon: string, fallbackId?: string): (GripSlot | null)[] {
  const cfg = readJSON<Record<string, Record<string, { main?: GripSlot; off?: GripSlot }>>>('pe_grip', {});
  const slot = (k: string): { main?: GripSlot; off?: GripSlot } | undefined =>
    cfg[charId]?.[k] ?? (fallbackId ? cfg[fallbackId]?.[k] : undefined);
  const exact = slot(weapon);
  // ⭐⭐ ХВАТ РУКИ НАСЛЕДУЕТСЯ С ТОГО КЛЮЧА, ГДЕ ЭТА РУКА НАСТРОЕНА ОДНА — ровно как стойка предмета.
  //
  // Жалоба: «настроил хват щита для idle со щитом без оружия, а в игре с мечом щит висит криво».
  // Хват ключевался ПОЛНЫМ ключом (`sword+shield`), и настройка, сделанная на `none+shield`, не
  // находилась. Теперь: нет записи на точный ключ — берём с «меч один» для главной руки и со
  // «щит один» (`none+shield`) для второй.
  const [m, o] = splitHands(weapon);
  const mainAlone = m !== 'none' ? slot(m) : undefined;
  const offAlone = o !== 'none' ? slot('none+' + o) : undefined;
  return [
    exact?.main ?? mainAlone?.main ?? null,
    // ⚠ `offAlone?.main` — ЛЕГАСИ: пока пустая рука не занимала свой слот, щит при пустой главной
    // записывался в `main`. Читаем обе записи, чтобы уже сделанные настройки не пропали.
    exact?.off ?? offAlone?.off ?? offAlone?.main ?? null,
  ];
}
/** Поставить базовый хват pe_grip на `g.userData.baseRot/basePos` групп оружия (поверх weapon-type дефолта из attachWeapons).
 *  Зови ПОСЛЕ attachWeapons и при смене оружия. Нет базы в конфиге → остаётся weapon-type дефолт. */
export function applyBaseGrip(weaponGroups: THREE.Group[], charId: string, weapon: string, fallbackId?: string): void {
  const base = loadGrip(charId, weapon, fallbackId);
  weaponGroups.forEach((g, i) => {
    const b = base[i]; if (!b) return;
    const br = g.userData.baseRot as THREE.Euler | undefined, bp = g.userData.basePos as THREE.Vector3 | undefined;
    if (br) br.set(b.r[0], b.r[1], b.r[2]);
    if (bp) bp.set(b.p[0], b.p[1], b.p[2]);
  });
}
/** Профили скрутки корпуса per-state (стой/ходьба/бег) per-char из pe_twist; фолбэк (монстры → Волкодав). */
export function loadTwistStates(charId: string, fallbackId?: string): TwistStates {
  const cfg = readJSON<Record<string, TwistCfgStored>>('pe_twist', {});
  const raw = cfg[charId] ?? (fallbackId ? cfg[fallbackId] : undefined);
  return resolveTwistStates(raw);
}
/** Обёртка угла в (−π, π]. */
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Шаг torso-lead: таз догоняет ПРИЦЕЛ удержанием в зоне + ПЛАВНЫМ доворотом с защёлкой. ОДНА система стоя и на бегу.
 * Скрутка ВЕРХА = (прицел − таз), клампится `maxTwist`. Возвращает yaw таза, остаток скрутки и состояние защёлки.
 * ОБЩИЙ код игры и редактора. Чистая математика — тестируемо.
 *
 * ЛОГИКА: пока |прицел−таз| ≤ порога и защёлка выкл — таз ДЕРЖИТСЯ (голова ведёт, планировщик не шагает). За зоной
 * защёлка ВКЛ: таз плавно доворачивается со скоростью `turnRate` рад/с, пока не догонит (|разница| ≤ SETTLE) → ВЫКЛ,
 * держит. Плавный доворот (не мгновенный) → стопы переступают ПООЧЕРЁДНО (не прыжок); ~3 рад/с → успевают (не семенят).
 *
 * ⭐⭐ 18.09: У СКОРОСТИ ЕСТЬ РАЗГОН (`TURN_ACCEL_SEC`) И У ЗАЩЁЛКИ — ПОЛОСА (`TWIST_RELAX_ON`). Оба числа
 * пришли из замера подёргивания корпуса на бегу: без них таз включался и обрывался за один кадр, а защёлка
 * щёлкала тем чаще, чем выше частота кадров. Состояние скорости живёт у звонящего (`prevRate` → `rate`):
 * функция осталась чистой.
 */
const TWIST_SETTLE = 0.03; // рад (~1.7°): таз догнал прицел → гасим защёлку
/**
 * ⭐ ГИСТЕРЕЗИС ВЕТКИ ВЫРАВНИВАНИЯ (`relax`): включаемся на 0.06 рад (3.4°), гасимся на `TWIST_SETTLE`.
 *
 * Было одно число на вход и на выход, то есть защёлка щёлкала на КАЖДОМ пересечении 1.7° — а прицел
 * ходит через него постоянно. ЗАМЕР (стенд `torsoJitter`, прямой бег вперёд 80 ед/с): переключений
 * `turning` 5.8 / 7.2 / 8.8 в секунду при 60 / 120 / 144 → 3.2 / 3.8 / 4.0 с полосой. Защёлка — СОСТОЯНИЕ,
 * и её частота не должна зависеть ни от частоты кадров, ни от шума в 1.7°.
 */
const TWIST_RELAX_ON = TWIST_SETTLE * 2;
/**
 * ⭐⭐ ЗА СТОЛЬКО СЕКУНД ТАЗ РАЗГОНЯЕТСЯ С НУЛЯ ДО `turnRate` — и ровно столько же тормозит.
 *
 * Рейт-лимит без разгона — это скорость 0 → 172 °/с ЗА ОДИН КАДР и обратно: у мирового курса корпуса
 * получается пила из прямых отрезков, а её вторая разность (рывок) растёт с частотой кадров по построению.
 * ЗАМЕР (стенд `torsoJitter`, рывок груди p99, °/с² при 60 / 120 / 144; контроль — путь редактора 500):
 *   прямой бег вперёд   5185 / 14002 / 17178 → 3670 / 6877 / 7858
 *   бег назад под 45°   4389 / 13649 / 16306 → 2525 / 2472 / 2357   (рост с кадрами исчез вовсе)
 *   сближение 400 ед    4809 / 14909 / 18136 → 3909 / 7352 / 8865
 * ЦЕНА — отставание ТАЗА (не прицела: грудь остаётся на цели через `residual`): +1.7° там, где таз почти
 * догнал, и +4.4° на быстром развороте мимо курсора. ЗАМЕР при `0.10` давал рывок ещё вдвое ниже, но
 * отставание +8.6° — выбрано `0.06`: отзывчивость таза дороже последних 25 % рывка.
 *
 * ⚠⚠ РАЗГОН — ТОЛЬКО НА ХОДУ (`PosePlayer.step`, поле `turnAccelHold`). Причина не в «на ходу заметнее»,
 * а в том, что СТОЯ ЭТИМ ЖЕ ПРИВОДОМ СНИМАЕТСЯ НАБОР ПОВОРОТОВ (`bakeTurnToClip` крутит ровно
 * `stepTorsoLead` при нулевой скорости). Разгон стоя меняет снятые клипы, и это не «чуть другие числа»:
 * ЗАМЕР на опубликованном воине — у `turn_L_90` ключей 11 против 16, курс гладкого набора расходится с
 * плотным на 2.61° (порог 2.5), размах таза за поворот 0.291 против порога 0.2, а подшагов в 90° клипе
 * становится ОДИН вместо двух. Это перепечка набора и решение автора, а не побочный эффект правки бега.
 *
 * ⚠⚠ И ПЕРЕКЛЮЧАЕТСЯ РАЗГОН НЕ ПО СКОРОСТИ НОГ, А ПО ОСТАНОВКЕ САМОГО ТАЗА (`turnAccelHold`). Прежний
 * порог «`spd > MOVE_EPS_WARP`» обещал непрерывность и НЕ ДАВАЛ ЕЁ: инерции в балансе нет вовсе
 * (`moveInertia.enabled` false), скорость падает 80 → 0 ЗА ТИК, и таз посреди доворота перескакивал с
 * разогнанной скорости на полный `turnRate`. ЗАМЕР (стенд `torsoJitter`, сцена `stop_face` — «встал и
 * довернулся к монстру»): шаг скорости таза 255 / 270 / 273 °/с за кадр при 60 / 120 / 144, то есть
 * рывок 15 000 / 32 000 / 39 000 °/с². Теперь разгон доживает до `rate === 0`: на остановке ничего не
 * щёлкает, а следующий поворот С МЕСТА снова идёт прежним законом — тем самым, которым снят набор.
 */
export const TURN_ACCEL_SEC = 0.06;
/**
 * ⭐⭐ «ПРИЦЕЛ СТОИТ» — ПОРОГ В СЕКУНДУ, А НЕ НА КАДР (рад/с).
 *
 * Было `|Δприцел| < 0.01` — сравнение с приращением ЗА КАДР, то есть порог 0.6 рад/с на 60 Гц, 1.2 на 120
 * и 1.44 на 144. Одно и то же движение мыши на быстрой машине считалось «прицел стоит», а на медленной —
 * «едет», и дальше это решало `relax` в `stepTorsoLead` и `shouldCommitTurn`.
 *
 * ЗАМЕР (стенд `torsoJitter.test.ts`, рыцарь `knight_06`, 80 ед/с, сближение на 133 ед — скорость прицела
 * ровно в полосе между 0.6 и 1.44 рад/с): сбросов «прицел стоит» 0.7 → 0.0 → 0.0 в секунду при 60 / 120 / 144,
 * защёлка `turning` щёлкала 8.6 → 19.2 → 23.0 раз в секунду, кадров с тазом на упоре рейт-лимита 3.5 → 8.0 → 8.0 %,
 * рывок груди 8842 → 19918 → 26476 °/с². СЧЁТЧИКИ ЛОГИКИ, растущие с частотой кадров, — и есть подпись бага.
 *
 * Значение — РОВНО сегодняшнее при 60 Гц (0.01 рад за кадр = 0.6 рад/с), поэтому на 60 Гц правка бит в бит,
 * а 120 / 144 подтягиваются к ней. Тот же класс, что `driveActor.VEL_TAU` и `netInterp.VEL_TAU`.
 */
export const AIM_STILL_RATE = 0.6;
/**
 * ⭐⭐ И ЗНАМЕНАТЕЛЬ СКОРОСТИ ПРИЦЕЛА — ИНТЕРВАЛ МЕЖДУ ЕГО ИЗМЕНЕНИЯМИ, А НЕ КАДР (`PosePlayer.aimGap`).
 *
 * Порог-в-секунду починил СРАВНЕНИЕ, но не МЕРКУ: делить приращение на кадр можно только при РАВНОМЕРНОМ
 * вводе, а ввод событийный. Обычная мышь шлёт 125 отчётов в секунду, и кадр на 240 Гц видит либо ноль,
 * либо ЦЕЛОЕ событие — тогда `|Δ| / dt` это не скорость прицела, а частота кадров, делённая на частоту мыши.
 * ЗАМЕР (стенд `torsoJitter`, сцена `mouse125_w04`: стоим, мышь 125 Гц ведёт прицел 0.4 рад/с — заведомо
 * «стоит»): сбросов «прицел стоит» 0.0 / 5.0 / 0.0 / 115.0 в секунду при 60 / 120 / 144 / 240 и отставание
 * таза p99 47.5 / 101.5 / 47.4 / 133.8° — одно и то же движение мыши включало выравнивание таза на одной
 * машине и не включало на другой. Стало 0.0 / 0.0 / 0.0 / 0.0 и 47.5 / 47.4 / 47.4 / 47.4°.
 *
 * КАК: копим время, пока прицел НЕ МЕНЯЛСЯ, и когда он меняется — делим приращение на это время. При
 * непрерывном вводе (пеленг на курсор считается каждый кадр) знаменатель равен кадру, то есть правило
 * прежнее БИТ В БИТ; при событийном — настоящему интервалу события. Нулевое приращение — скорость 0,
 * поэтому у замороженного прицела счёт «сколько стоит» начинается там же, где раньше, и ЗАПЕЧЁННЫЙ
 * НАБОР не двигается (сторож — хэш всего набора).
 * ⚠ ОТВЕРГНУТО ЗАМЕРОМ: «дырявое ведро» (копить перебег сверх порога, опустошать на срабатывании). Для
 * ровного быстрого увода прицела оно ДРЕБЕЗЖИТ: ведро наполняется и опустошается циклом, и сбросов
 * «прицел стоит» на проходе мимо курсора стало 1.6 / 5.4 / 5.8 в секунду вместо 0.1 / 0.1 / 0.1.
 */
/**
 * ⚠ И ЗНАМЕНАТЕЛЬ ОГРАНИЧЕН СВЕРХУ (сек). Прицел может простоять секунду, а потом РЫВКОМ уехать на 45°
 * — это «прицел едет», а не «0.8 рад/с за секунду». Потолок — темп самого медленного мыслимого потока
 * ввода (20 отчётов в секунду; у обычной мыши 125, у игровой 1000): всё, что реже, — не поток, а скачок.
 * ЗАМЕР: без потолка запечённый набор поворотов расходится (у поворота на 45° прицел «не едет»,
 * включается выравнивание) — хэш набора это ловит.
 */
export const AIM_GAP_MAX = 0.05;
/**
 * ⭐ ОКНО СРЕДНЕЙ СКОРОСТИ ПРИЦЕЛА (сек) — ВТОРАЯ МЕРКА, и «едет» объявляется, только когда СОГЛАСНЫ ОБЕ.
 *
 * Одного интервала события мало: сам интервал наблюдается КАДРАМИ. Мышь 125 Гц на 240 кадрах ложится то в
 * один кадр от прошлого события, то в два, и мгновенная оценка скачет 0.77 ↔ 0.38 рад/с вокруг истинных 0.4
 * — половина отсчётов перелетает порог 0.6. ЗАМЕР: сбросов «прицел стоит» 115 → 10 в секунду (одного
 * интервала мало) → 0 (обе мерки). Средняя за окно этой дроби не видит вовсе.
 * ⚠ ПОЧЕМУ «И», А НЕ «ИЛИ» И НЕ ОДНА СРЕДНЯЯ. У средней есть память: после скачка прицела она спадает
 * `AIM_RATE_TAU`-экспонентой, и счёт «прицел стоит» начинался бы на 0.2–0.3 с позже — а на нём стоит
 * `relax`, которым СНИМАЕТСЯ НАБОР ПОВОРОТОВ. Мгновенная мерка у замороженного прицела ровно 0, поэтому
 * «И» возвращает «стоит» в том же кадре, что и раньше, и набор остаётся бит в бит (сторож — хэш набора).
 */
export const AIM_RATE_TAU = 0.05;
export function stepTorsoLead(
  prevRoot: number, aimYaw: number, twist: TwistProfile, dt: number, prevTurning: boolean, relax = false,
  /** Скорость таза прошлого кадра (рад/с) — состояние разгона. Не передали — считаем, что таз уже разогнан. */
  prevRate = twist.turnRate,
  /** За сколько секунд таз разгоняется до `turnRate` (см. `TURN_ACCEL_SEC`). 0 — без предела, как было. */
  accelSec = 0,
): { rootYaw: number; residual: number; turning: boolean; rate: number } {
  const err = wrapPi(aimYaw - prevRoot);
  let turning = prevTurning;
  if (Math.abs(err) > twist.threshold) turning = true;      // вышли за зону → начинаем доворот
  else if (relax && Math.abs(err) > TWIST_RELAX_ON) turning = true;   // прицел стабилен relaxTime → доворот к нейтрали (выравнивание)
  else if (Math.abs(err) <= TWIST_SETTLE) turning = false;  // догнали → держим (deadzone)
  // ⭐⭐ РЕЙТ-ЛИМИТ С РАЗГОНОМ (см. `TURN_ACCEL_SEC`). Целевая скорость умеет затормозить к остатку
  // (`sqrt(2·a·err)` — та же формула, что у любого сервопривода с пределом ускорения), сама скорость
  // меняется не быстрее `a`. Потолок скорости остался прежний — `turnRate`, менять его тут нечего.
  //
  // ⚠⚠ ПЕРЕКЛЮЧАЕТСЯ ТОЛЬКО ПРЕДЕЛ ПРИРАЩЕНИЯ `acc`, А НЕ САМА СКОРОСТЬ. `accelSec` 0 — предел
  // бесконечен, и тогда `rate` = цель, то есть в точности прежний голый рейт-лимит (путь запекания).
  // Раньше эти две ветки писались как разные ЗАКОНЫ, и переключение между ними на ходу щёлкало скоростью
  // таза на 124–275 °/с за кадр (см. `PosePlayer.step`, `turnAccelHold`).
  // ⚠ Бесконечный предел — отдельной строкой, а не `clamp(…, -Infinity, Infinity)`: `prevRate +
  // (want − prevRate)` отличается от `want` на последние биты, а запечённый набор обязан быть бит в бит.
  const acc = accelSec > 0 ? twist.turnRate / accelSec : Infinity;
  const want = !turning ? 0
    : accelSec > 0 ? Math.min(twist.turnRate, Math.sqrt(2 * acc * Math.abs(err))) : twist.turnRate;
  const rate = accelSec > 0 ? prevRate + clamp(want - prevRate, -acc * dt, acc * dt) : want;
  // ⭐⭐ ВЕДЁТ ТАЗ СКОРОСТЬ, А НЕ ЗАЩЁЛКА (см. `TWIST_SETTLE`): пока `rate` ещё не упала в ноль, таз
  // продолжает идти — иначе торможение обрывается на полпути и это САМ ПО СЕБЕ рывок.
  let root = prevRoot;
  if (rate > 0) root += Math.sign(err) * Math.min(Math.abs(err), rate * dt);   // без перелёта
  let residual = wrapPi(aimYaw - root);                     // скрутка ВЕРХА к прицелу
  if (Math.abs(residual) > twist.maxTwist) residual = Math.sign(residual) * twist.maxTwist;   // кламп (не выворачивать шею)
  return { rootYaw: root, residual, turning, rate };
}
/**
 * ДОВОРОТ ТАЗА ПОД НАПРАВЛЕНИЕ ДВИЖЕНИЯ (orientation warping) — ЧЕТЫРЕ СЕКТОРА, доворачивается только ОСТАТОК.
 *
 * ЗАЧЕМ. Без него диагональ — это отдельная анимация, и библиотека растёт вдвое: восемь направлений
 * на каждую скорость. С ним низ доворачивается к ближайшему кардинальному клипу, верх отворачивается
 * обратно к прицелу — диагоналей как клипов не нужно вовсе.
 *
 * ⭐⭐ КАНОН (Lyra / UE Orientation Warping): ход складывается к БЛИЖАЙШЕЙ ИЗ ЧЕТЫРЁХ ОСЕЙ — вперёд, +X
 * (`strafe_R`), назад, −X (`strafe_L`) — и доворачивается ТОЛЬКО ОСТАТОК до неё. Чистый бок = доворот 0 и
 * страйф-клип целиком. ⚠ Было две оси (вперёд/назад): на чистых 90° таз всегда уезжал на потолок (40°), ноги
 * шли под 50° к тазу, а бленд давал 0.54 страйфа + 0.46 вперёд. ЗАМЕР (рыцарь, клипы, 90° @80): скольжение
 * опорной стопы 65 % скорости, ошибка направления +20°, верх груди 19° от прицела. Сектора — см. README.
 *
 * ОГРАНИЧИТЕЛИ, и все обязательны:
 *  1. СЕКТОР С ГИСТЕРЕЗИСОМ `SECTOR_HYST` на границах ±45°/±135°, но ТОЛЬКО ПОКА ИДЁМ (`moving` прошлого кадра,
 *     как `bWasMovingLastUpdate` у Lyra): встали — сектор забыт, следующий старт берёт ближайший. Иначе он
 *     залипал через остановку — тот же класс утечки, что флаг «назад» между запеканиями (замер: 60° → стоп →
 *     35° шёл сектором R с доворотом −45 на весь забег).
 *  2. НИЧЬЯ РОВНО НА ±45°/±135° — ЯВНОЕ ПРАВИЛО, зеркальное по знаку и одинаковое в JS и C#: `|d|` сравнивается
 *     с 45°/135° с допуском, ничья отдаётся оси вперёд/назад (`nearestWarpSector`). Не `Math.round` — он
 *     ломал зеркальность (+135 → назад, −135 → L) и в C# округляет половину к чётному.
 *  3. ПОТОЛОК `warpMax` — дальше низ читается вывернутым; остаток сверх потолка доедает бленд клипов.
 *  4. БЮДЖЕТ СКРУТКИ. Верх обязан отвернуться ровно на угол доворота, иначе персонаж перестанет
 *     целиться туда, куда целится на самом деле. Поэтому доворот урезается так, чтобы остаточная скрутка
 *     влезла в `maxTwist` профиля.
 *  5. ⭐ ПРЕДЕЛ СКОРОСТИ `rateDeg` (°/с) — ХЛЫСТ НА ПЕРЕБРОСЕ СЕКТОРА. На смене сектора ЦЕЛЬ доворота
 *     прыгает: на границе 45° + гистерезис остаток к старой оси +55° (подрезан потолком до +50°), к новой
 *     −35°, то есть цель за кадр уезжает на 85°. Сглаживание `smooth` берёт от этого долю ЗА КАДР, а не
 *     скорость: 85° / 0.12 с ≈ 700 °/с — вчетверо выше физического потолка torso-lead (172 °/с).
 *     ЗАМЕР (стенд `torsoJitter.test.ts`, рыцарь, прямой бег вперёд 80 ед/с, 2 переброса за 10 с):
 *     канал доворота p99 400–435 °/с, пик 795 — САМЫЙ БОЛЬШОЙ одиночный рывок таза на прямом беге.
 *     Предел режет ровно прыжки цели: обычное ведение идёт медленнее его и не задето вовсе
 *     (30° за `warpSmooth` — это 250 °/с, ниже умолчания 300).
 *
 * `cfg.sectors === false` — СТАРАЯ складка вперёд/назад (гистерезис 90° ± `BACK_HYST`). Рантайм берёт её, только
 * пока клипы страйфа не перезапечены (`isLocoClipFresh`): со старыми клипами (ноги под 126°) сектора хуже, чем было.
 *
 * Чистая функция (только числа) — проверяется в node без сцены.
 */
/** Сектор хода: 0 вперёд, 1 +X (`strafe_R`), 2 назад, 3 −X (`strafe_L`). */
export type WarpSector = 0 | 1 | 2 | 3;
/**
 * ⚠ ДОЛИ РАСКРЫТИЯ (`open`, `openFrac`) ЗДЕСЬ БОЛЬШЕ НЕТ — режим «таз открыт» снят 19.09 целиком. Поворот таза
 * стал обычной ручкой походки (`POSE.hipsTurn`), она печётся прямо в клипы страйфа и секторного гашения не
 * требует: у ручки уже есть колонки, и «ход назад-вбок» получает свои числа колонкой «назад».
 */
export type DirWarp = { warp: number; sector: WarpSector; moving: boolean; rate: number };
export const DIR_WARP0: DirWarp = { warp: 0, sector: 0, moving: false, rate: 0 };
/** Полуширина зоны нерешительности вокруг 90° у СТАРОЙ складки: вошли в «назад» на 102°, вышли на 78°. */
const BACK_HYST = 12 * Math.PI / 180;
/** Гистерезис сектора: держим сектор, пока ход в пределах 45° + этого от его оси (Lyra CardinalDirectionDeadZone 10). */
export const SECTOR_HYST = 10 * Math.PI / 180;
/** Ось сектора (рад, от таза): вперёд, +X, назад, −X. */
export const SECTOR_AXIS: readonly number[] = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** Допуск ничьей на границе сектора (рад). Отдаёт ничью оси вперёд/назад — зеркально по знаку. */
const SECTOR_TIE = 1e-6;
/** Ближайший сектор без памяти. `d` — угол хода от таза в (−π, π]. */
export function nearestWarpSector(d: number): WarpSector {
  const a = Math.abs(d);
  if (a <= Math.PI / 4 + SECTOR_TIE) return 0;
  if (a >= 3 * Math.PI / 4 - SECTOR_TIE) return 2;
  return d > 0 ? 1 : 3;
}

export function stepDirWarp(
  prev: DirWarp, rootYaw: number, aimYaw: number, vx: number, vz: number,
  maxTwist: number, dt: number,
  cfg: { on: number; maxDeg: number; smooth: number; sectors?: boolean; rateDeg?: number },
): DirWarp {
  let want = 0, sector = prev.sector, prevRateOut = 0;
  const moving = Math.hypot(vx, vz) > MOVE_EPS_WARP;
  if (cfg.on > 0.5 && moving) {
    const d = wrapPi(Math.atan2(vx, vz) - rootYaw);
    if (cfg.sectors ?? true) {
      // Гистерезис — только на ходу: после остановки сектор выбирается заново, без памяти.
      if (!prev.moving || Math.abs(wrapPi(d - SECTOR_AXIS[sector]!)) > Math.PI / 4 + SECTOR_HYST) sector = nearestWarpSector(d);
    } else {
      // ⚠ ФЛАГ «НАЗАД» ПОМНИТСЯ ЧЕРЕЗ ОСТАНОВКУ — это ПРЕЖНЕЕ поведение, и трогать его тут нельзя: ветка живёт
      // ровно для неперезапечённых наборов, которым обещано «как было». Забывание флага на старте (как у секторов)
      // на 78–102° даёт ДРУГОЙ знак доворота, и не на кадр: гистерезис тут же залипает на новом выборе и держит его
      // весь забег. ЗАМЕР (потолок 50°): шёл спиной → стоп → пошёл под 85° — доворот −50° (помним) против +50°
      // (забыли). Забывание — свойство СЕКТОРОВ (`prev.moving` выше), у них своя причина (см. ограничитель 1).
      const wasBack = prev.sector === 2;
      sector = Math.abs(d) > Math.PI / 2 + (wasBack ? -BACK_HYST : BACK_HYST) ? 2 : 0;
    }
    const rel = wrapPi(d - SECTOR_AXIS[sector]!);   // доворачиваем только остаток до оси сектора
    const cap = Math.abs(cfg.maxDeg) * Math.PI / 180;
    want = clamp(rel, -cap, cap);
    // Бюджет: после доворота верх крутится на (residual − want) и обязан влезть в maxTwist.
    // Остаток берём УЖЕ подрезанным — ровно то число, что отдаёт `stepTorsoLead` и что реально
    // ляжет на позвоночник. Считать от сырого значит разрешить доворот, который при отставшем
    // тазе (прицел дальше предела скрутки) утащит верх за предел.
    const residual = clamp(wrapPi(aimYaw - rootYaw), -maxTwist, maxTwist);
    // ⚠ ПОВОРОТ ТАЗА (`POSE.hipsTurn`) В ЭТОТ БЮДЖЕТ НЕ ВХОДИТ и входить не должен: он приходит от ручки
    // походки и живёт ТОЛЬКО на кости таза, а его собственный предел — отказ ЗАПЕКАНИЯ по
    // «макс. скрутке верха» (`clipBake.assertYawBudget`, проверяется на КАЖДОМ кадре, то есть по ПИКУ качания).
    want = clamp(want, residual - maxTwist, residual + maxTwist);
  }
  const k = cfg.smooth > 1e-4 ? Math.min(1, dt / cfg.smooth) : 1;
  // ⭐⭐ ПРЕДЕЛ СКОРОСТИ ДОВОРОТА (°/с) — против ХЛЫСТА НА ПЕРЕБРОСЕ СЕКТОРА (ограничитель 5, см. шапку).
  // Сглаживание `smooth` — доля пути за кадр, и на ПРЫЖКЕ цели она даёт скорость «прыжок / smooth»,
  // а не «сглаженную». Предел режет ровно эти прыжки и не трогает обычное ведение.
  const lim = (cfg.rateDeg ?? 0) > 0 ? (cfg.rateDeg as number) * Math.PI / 180 * dt : Infinity;
  /**
   * ⭐⭐ У ПРЕДЕЛА ЕСТЬ РАЗГОН — ТОТ ЖЕ, ЧТО У ПРИВОДА ТАЗА (`TURN_ACCEL_SEC`). Голый предел режет ШАГ, и
   * ВХОД в него — обрыв: на перебросе сектора скорость доворота прыгала с 17 до 300 °/с ЗА КАДР. ЗАМЕР
   * (стенд `torsoJitter`, прямой бег вперёд): рывок таза max 18 994 / 38 865 / 46 065 °/с² при 60 / 120 / 144
   * — ровно `warpRate × Гц`, то есть подпись однокадрового скачка, и именно она оставалась самой большой
   * после всех прочих правок. Со скоростью-состоянием: 5 002 на ВСЕХ частотах (это и есть `warpRate/0.06`).
   * ⚠ Тормозить умеет: цель скорости подрезана `sqrt(2·a·|ошибка|)`, поэтому перелёта нет — иначе
   * пропорциональный регулятор с пределом ускорения проскакивает цель на `v²/2a` (для 300 °/с это 8°) и звенит.
   * ЦЕНА — ЗАМЕР (переброс на 30° при `warpSmooth` 0.12): 90 % пути 267 / 267 / 271 мс → 267 / 283 / 285 мс
   * при 60 / 120 / 144, перелёт 0.00 % там и там; отставание таза от прицела p99 не меняется вовсе (37.6°).
   */
  const errW = want - prev.warp;
  let step: number;
  if (lim < Infinity) {
    const accW = lim / dt / WARP_ACCEL_SEC;                    // рад/с²: потолок скорости за `WARP_ACCEL_SEC`
    const vCap = Math.min(lim / dt, Math.sqrt(2 * accW * Math.abs(errW)));
    const vWant = Math.sign(errW) * Math.min(Math.abs(errW) * k / dt, vCap);
    const v = prev.rate + clamp(vWant - prev.rate, -accW * dt, accW * dt);
    step = Math.sign(v) * Math.min(Math.abs(errW), Math.abs(v) * dt);
    prevRateOut = v;
  } else { step = errW * k; prevRateOut = k > 0 ? step / dt : 0; }   // предела нет — прежнее сглаживание бит в бит
  /**
   * ⚠ ДОЛЯ РАСКРЫТИЯ БОЛЬШЕ НЕ РЕЖЕТСЯ ЗДЕСЬ ВМЕСТЕ С ДОВОРОТОМ (раньше предел скорости накрывал обе части
   * одним множителем, иначе раскрытие на перебросе сектора везло таз 350–369 °/с при потолке 300). Поворот таза
   * теперь НЕ прыгает на перебросе: он не привязан к сектору вовсе, а едет непрерывной долей страйфа `st`
   * (и её сторонами), которая сама меняется не быстрее хода. Предел остаётся на довороте — там прыжок цели и есть.
   */
  return { warp: prev.warp + step, sector, moving, rate: prevRateOut };
}
/**
 * ⭐ ЗА СТОЛЬКО СЕКУНД ДОВОРОТ ТАЗА РАЗГОНЯЕТСЯ ДО `GAIT.warpRate` — и ровно столько же тормозит.
 * Одно число с `TURN_ACCEL_SEC` по смыслу и по величине: оба ограничивают ПРИРАЩЕНИЕ скорости таза,
 * просто у разных его слагаемых. См. подробности у самого ограничителя в `stepDirWarp`.
 */
export const WARP_ACCEL_SEC = 0.06;
/** Ниже этой скорости (u/с) направление хода — шум, доворачивать не по чему. */
const MOVE_EPS_WARP = 4;
/**
 * ⭐ ПЕРЕКРЫТИЕ ДОВОРОТА ТАЗА, рад (`null` — как настроено в `GAIT`). Число — доворот РОВНО такой, без секторов,
 * сглаживания и раскрытия. Нужно ЗАПЕКАТЕЛЮ: кардинальный клип снимается с 0 (иначе в клип впекается скрутка
 * корпуса, а ноги идут под 90° ± доворот), набор «таз открыт» — с ±раскрытием.
 * ⚠ Отдельным полем, а не записью в `GAIT.warpOn`: тумблер — контент редактора, запекание не должно его портить.
 * ⚠ Имя не `setWarpOverride`: `PosePlayer.warp` — это ВРЕМЕННОЙ варп удара, путать нельзя.
 */
let dirWarpOverride: number | null = null;
export function setDirWarpOverride(v: number | null): void { dirWarpOverride = v; }
export function getDirWarpOverride(): number | null { return dirWarpOverride; }
/**
 * ⭐⭐ РЕВИЗИЯ ЗАПЕКАНИЯ КЛИПОВ ХОДА. Пишет запекатель (`Clip.bakeRev`), читают рантайм (сектора доворота включаются
 * только на свежих страйфах) и редактор (предупреждение «перезапеки»).
 *   2 — кардинальный клип: снят без доворота таза и со свежим состоянием доворота на каждый пресет (до неё страйфы
 *       шли под ±126° к тазу со впечённой скруткой ±40°);
 *   3 — плюс КАНАЛ ОПОРЫ `__swing` (окно опоры больше не угадывается по доле `dutyWalk/dutyRun`: щелчок голеностопа
 *       боком и спиной был 43.6° / 42.9° за кадр) и НЕЙТРАЛЬ МАХА `swingRef`, снятая по плотному потоку.
 */
export const LOCO_BAKE_REV = 3;
/**
 * Клип хода годится секторам: снят нашим запекателем на ревизии ≥ `LOCO_BAKE_REV` — или снят НЕ им (импорт мокапа:
 * `bakeSpeed` пишет только запекатель, а чужой кардинальный клип доворота в себе не несёт).
 * ⚠ Запечённое до 17.09 (без `bakeSpeed`) отсюда не отличить от импорта; его и так выдаёт метка «снят на 50».
 */
export const isLocoClipFresh = (c: { bakeRev?: number; bakeSpeed?: number } | null | undefined): boolean =>
  !!c && (c.bakeSpeed === undefined || (c.bakeRev ?? 0) >= LOCO_CARDINAL_REV);
/**
 * ⚠⚠ ДВЕ РАЗНЫЕ ВЕЩИ, КОТОРЫЕ НЕЛЬЗЯ МЕРИТЬ ОДНИМ ЧИСЛОМ.
 *
 * `LOCO_CARDINAL_REV` (2) — с какой ревизии клип КАРДИНАЛЬНЫЙ, то есть снят без впечённого доворота. На этом висит
 * ВКЛЮЧЕНИЕ СЕКТОРОВ доворота: на старых страйфах (ноги под ±126° к тазу) сектора хуже старой складки, поэтому
 * гейт настоящий и нужный.
 * `LOCO_BAKE_REV` (3) — ТЕКУЩАЯ ревизия запекателя: плюс канал опоры `__swing` и нейтраль маха `swingRef`. У обоих
 * есть мягкий фолбэк (окна по доле, ленивая нейтраль), поэтому гейтить по ней НЕЧЕГО — она только подсказка
 * редактора «перезапеки, станет лучше».
 *
 * ⚠ Их слияние — регрессия, которая уже случалась: подъём `LOCO_BAKE_REV` 2 → 3 разом сделал ВЕСЬ опубликованный
 * набор «несвежим» и молча выключил сектора доворота, хотя с клипами ничего не случилось. Автор при этом ничего
 * не перезапекал и увидел бы, что страйф «сам собой откатился».
 */
export const LOCO_CARDINAL_REV = 2;
/**
 * Доли отворота доворота/поворота таза по Spine / Chest / UpperChest — веса скрутки, перенормированные на их сумму
 * (та же раскладка, что в `twistTorso(…, warp)`). `null` — у профиля нет веса на спине, раскладывать нечем.
 */
export function yawCounterWeights(w: readonly number[]): [number, number, number] | null {
  const c3 = (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0);
  return c3 > 1e-3 ? [(w[0] ?? 0) / c3, (w[1] ?? 0) / c3, (w[2] ?? 0) / c3] : null;
}
/**
 * ⚠ СУФФИКС `_open` (набор `*_strafe_*_open`) СНЯТ 19.09 вместе с режимом «таз открыт». Рантайм таких клипов больше
 * не ищет ВООБЩЕ (имена он берёт из `locoClipNames`, а поиск точный — `findLocoClip`), так что уже запечённые
 * лежат в библиотеке мёртвым грузом; редактор предлагает их снести.
 */
export const LEGACY_OPEN_SUFFIX = '_open';
/**
 * ⭐ РЫСК ТАЗА КЛИПА: КУРС ЕГО `Hips` (рад), ИЗМЕРЕННЫЙ, а не прочитанный из слота Y эйлера — при ненулевом
 * наклоне таза это разные числа. Им живут и снятие запечённого отворота, и бюджет скрутки.
 */
const _phE = new THREE.Euler(), _phQ = new THREE.Quaternion();
export function poseHipsYaw(p: Pose): number {
  const h = p['Hips']; if (!h) return 0;
  if (h[0] === 0 && h[2] === 0) return h[1];                 // чистый рыск — курс равен слоту Y точно
  return pelvisHeading(_phQ.setFromEuler(_phE.set(h[0], h[1], h[2], 'XYZ')));
}
/**
 * ⭐ СНЯТЬ ЗАПЕЧЁННЫЙ ВСТРЕЧНЫЙ ОТВОРОТ С КЛИПА ПЕРЕД СМЕШИВАНИЕМ СО СТОЙКОЙ.
 *
 * Клип страйфа с повёрнутым тазом КАНОНИЧЕСКИЙ: таз повёрнут на `a`, отворот `−a × w` запечён в Spine..UpperChest — такой клип
 * любой движок сыграет как есть, и грудь останется на прицеле. У НАС Chest/UpperChest дальше смешиваются со стойкой по
 * `pe_sway` (`UPPER_BONES`, в «только клипы» от клипа остаётся доля `swing`), и отворот разбавился бы вместе с ними —
 * ЗАМЕР прототипа B: грудь мимо прицела на 41 % угла (12.3° при 30°). Поэтому здесь отворот снимаем, а после всех
 * слоёв его кладёт `applyTorsoTwist` рантаймовыми весами. Поза — копия: ключ клипа может прийти по ссылке.
 * ⚠ `a` — ПОКАДРОВЫЙ курс таза этого клипа (`poseHipsYaw`), а не одно число на клип: с качанием рыска угол за цикл
 * меняется, и константа снимала бы отворот не тот, что запечён.
 */
const OPEN_SPINE = ['Spine', 'Chest', 'UpperChest'] as const;
const _obE = new THREE.Euler(), _obQ = new THREE.Quaternion(), _obR = new THREE.Quaternion(), _obY = new THREE.Vector3(0, 1, 0);
export function unbakeYawCounter(p: Pose, a: number, w: readonly number[]): Pose {
  if (!a || w.length < 3) return p;
  const out: Pose = { ...p };
  for (let i = 0; i < 3; i++) {
    const nm = OPEN_SPINE[i]!, v = p[nm];
    if (!v || !w[i]) continue;
    _obQ.setFromEuler(_obE.set(v[0], v[1], v[2], 'XYZ')).multiply(_obR.setFromAxisAngle(_obY, a * w[i]!));
    _obE.setFromQuaternion(_obQ, 'XYZ');
    out[nm] = [_obE.x, _obE.y, _obE.z];
  }
  return out;
}
/** Как часто перепроверяется ревизия запечённых страйфов (сек) — см. `strafeClipsFresh`. */
const FRESH_TTL = 0.25;
/** Кроссфейд при ДИСКРЕТНОЙ смене колонки клипов (сторона страйфа, вперёд↔назад, мгновенный разворот), сек. */
const COL_FADE = 0.1;
/** Скачок весов колонок за кадр, который считается подменой (мгновенный разворот). Перебросу сектора он не грозит:
 *  доворот едет за `warpSmooth`, и `st` меняется не больше ~0.2 за кадр даже на 90° переброса. */
const COL_JUMP = 0.3;

/**
 * ТОЛЬКО АДДИТИВНАЯ скрутка цепочки [Spine..Head] (веса сумм.=1), БЕЗ таза.
 *
 * Отделено от `applyTorsoTwist` ради РУЧНОГО ПОЗИНГА (Ф21.4): в редакторе таз АВТОРСКИЙ,
 * его `rotation.y` перезаписывать нельзя — а сама развёртка остатка по спине нужна та же самая,
 * что и в походке. Один шов — одинаковый вид скрутки в анимации и в ручной позе.
 */
export function twistTorso(human: Humanoid, residual: number, weights: [number, number, number, number, number], warp = 0): void {
  const H = human.bones;
  // ⭐ ОТВОРОТ ОТ ДОВОРОТА ТАЗА (`warp`, уже ВЫЧТЕН из `residual`) ПЕРЕРАСПРЕДЕЛЯЕТСЯ на Spine..UpperChest (веса
  // перенормированы на их сумму `c3`). Иначе грудь — и оружие на ней — отставала бы от прицела на долю шеи и головы:
  // при весах 0.15/0.25/0.3 это (1 − c3) × доворот = 0.3 × 45° = 13.5° на потолке. Голову всё равно ставит look-at.
  // Добавка `warp·(w − ww)` в сумме по цепочке НОЛЬ (Σw = Σww = 1): итог скрутки прежний, меняется только раскладка.
  // ⚠ При `warp === 0` — ровно прежняя формула бит в бит (ручной позинг, доворот выкл, стойка).
  const c3 = (weights[0] ?? 0) + (weights[1] ?? 0) + (weights[2] ?? 0);
  // rotateY аддитивен поверх авторской позы; цепочка Spine→…→Head накапливает → плечи/голова ведут, оружие (на UpperChest) следом.
  for (let i = 0; i < TWIST_BONES.length; i++) {
    const b = H.get(TWIST_BONES[i]!); if (!b) continue;
    const w = weights[i] ?? 0;
    let a = residual * w;
    if (warp !== 0 && c3 > 1e-3) a += warp * (w - (i < 3 ? w / c3 : 0));
    if (a) b.rotateY(a);
  }
}
/**
 * КОРПУС В ТРЁХ СТЕПЕНЯХ СВОБОДЫ (Ф26.6) — расширение `twistTorso` на наклоны. Аддитивно поверх
 * авторской позы, БЕЗ таза — та же конвенция, что у скрутки, поэтому редактор и игра гнут спину ОДНИМ швом.
 *
 * Зачем: до Ф26.6 корпус умел ТОЛЬКО осевую скрутку (`rotateY`), и замах «рука вверх-назад» физически
 * не мог выгнуть спину назад — не было такой степени свободы вообще.
 *
 * Оси — локальные кости (спина смотрит вверх): Y = скрутка, X = сгиб/разгиб (плюс — вперёд, минус — прогиб
 * назад), Z = боковой наклон. Веса У НАКЛОНОВ СВОИ: в скрутке ведёт грудной отдел, а в прогибе/наклоне —
 * поясничный (анатомия: поясница гнётся сильно, но почти не крутится — фасеточные суставы стоят сагиттально).
 */
export const BEND_W: [number, number, number, number, number] = [0.45, 0.35, 0.2, 0, 0];   // прогиб/наклон: поясница ведёт
export function bendTorso(human: Humanoid, twist: number, pitch: number, roll: number,
                          wTwist: [number, number, number, number, number] = PULL_W_DEF,
                          wBend: [number, number, number, number, number] = BEND_W): void {
  const H = human.bones;
  for (let i = 0; i < TWIST_BONES.length; i++) {
    const b = H.get(TWIST_BONES[i]!); if (!b) continue;
    if (twist && wTwist[i]) b.rotateY(twist * wTwist[i]!);
    if (pitch && wBend[i]) b.rotateX(pitch * wBend[i]!);
    if (roll && wBend[i]) b.rotateZ(roll * wBend[i]!);
  }
}
const ZERO3: [number, number, number] = [0, 0, 0];
const _addE = new THREE.Euler(), _addQ = new THREE.Quaternion();
/**
 * Доложить поворот ПОВЕРХ того, что уже стоит на кости (аддитивно, в локальных осях кости).
 *
 * Нужен ключицам. Их базовая поза приходит из АВТОРСКОГО idle-клипа оружия, и заменять её настройками
 * походки нельзя — стойка перестанет быть той, что нарисовал автор. А раньше было наоборот: гейт клал
 * туда [0,0,0] с весом хода, то есть пояс просто гасился тем сильнее, чем быстрее бежишь, и настроить
 * в нём было нечего. Аддитивно — автор задаёт стойку, ползунки добавляют к ней движение.
 */
function addEuler(bone: THREE.Object3D | undefined, e: [number, number, number], w: number): void {
  if (!bone || w <= 1e-4 || (e[0] === 0 && e[1] === 0 && e[2] === 0)) return;
  _addQ.setFromEuler(_addE.set(e[0] * w, e[1] * w, e[2] * w, 'XYZ'));
  bone.quaternion.multiply(_addQ);
}
const PULL_W_DEF: [number, number, number, number, number] = [0.2, 0.4, 0.4, 0, 0];
/**
 * Навесить скрутку на риг: таз на курс `rootYaw` + остаток размазан по цепочке [Spine..Head] (веса сумм.=1). Звать ПОСЛЕ
 * gaitToHumanoid и клипа поворота — таз к этому моменту собран В КАДРЕ ПЕРСОНАЖА (процедурный наклон/крен, кости и
 * `__hipsD` клипов бега и поворота, шов поворота), и курс кладётся на него ОДНИМ жёстким поворотом (`pelvisToWorld`).
 *
 * ⚠ БЫЛО `Hips.rotation.y = rootYaw` — курс в слот Y эйлера: наклон таза вперёд-назад оставался в мировой оси X, свой рыск
 * таза клипа выпадал, X/Z таза не поворачивались с телом (замеры — в шапке `pelvisFrame.ts`). Поверх `human.reset()` каждого
 * кадра это по-прежнему «курс абсолютно»: база таза свежая, дважды курс не накапливается.
 * ⚠ СТРАЙФ С ОТКРЫТЫМ ТАЗОМ В КЛИПЕ: рыск таза клипа теперь СОХРАНЯЕТСЯ — прибавлять его к курсу ещё раз нельзя (посчитается
 * дважды). Запекатель кардинального клипа вычитает `pelvisYaw` (там он равен прицельному корню — доворот на съёме 0), а
 * набора `*_strafe_*_open` — ТОЛЬКО прицельный корень (`aimRootYaw`), так что раскрытие остаётся в клипе ровно один раз:
 * сюда оно приходит слагаемым `clipHipsOpen` в `rootYaw` и `warp` (см. `step`), а не вторым поворотом таза.
 * ⚠ И ОБРАТНО: если когда-нибудь таз станет собираться из клипа хода С ЕГО РЫСКОМ АВТОМАТИЧЕСКИ (как `frameEdit.turnPelvisGameGap`
 *   просит для клипов поворота), раскрытие набора `_open` посчитается ДВАЖДЫ (35° → 70°): здесь рыск таза клипа уже входит
 *   в `rootYaw` (`clipHipsOpen` в `step`). Сторож — `hipsYaw.test.ts` (прицел 137°/−100° и наклон таза в клипе).
 */
export function applyTorsoTwist(human: Humanoid, rootYaw: number, residual: number, weights: [number, number, number, number, number], warp = 0): void {
  pelvisToWorld(human.bones.get('Hips')!, rootYaw);           // facing таза (углы ног body-local → корень на rootYaw)
  twistTorso(human, residual, weights, warp);
}
const _UP_Y = new THREE.Vector3(0, 1, 0);
const _hlCur = new THREE.Quaternion(), _hlDes = new THREE.Quaternion(), _hlP = new THREE.Quaternion();
const _hlWas = new THREE.Quaternion(), _hlD = new THREE.Quaternion(), _hlI = new THREE.Quaternion(), _hlNW = new THREE.Quaternion();
const _hlFwd = new THREE.Vector3(), _hlR = new THREE.Vector3(), _hlU = new THREE.Vector3();
const _hlM = new THREE.Matrix4();
/** Head look-at + ВЕРТИКАЛЬ: стабилизация головы на ПРИЦЕЛ (мир-yaw), вертикально (up=мир-вверх → нет бокового наклона/ролла) И
 *  на ЗАДАННЫЙ кивок `pitch` (не наследованный свинг-нырок от удара). weight 0..1: 1 = строго на курсор+вертикаль+кивок, 0 = как
 *  есть (голова с телом), ~0.85 = держит + чуть гуляет (подмес). pitch (рад): 0 = ровно, <0 = вниз. Зови ПОСЛЕ applyTorsoTwist/overlayAttack. */
export function applyHeadLookAt(human: Humanoid, aimYaw: number, weight: number, pitch = 0, neckShare = 0): void {
  if (weight <= 0.001) return;
  const head = human.bones.get('Head'); if (!head) return;
  head.updateWorldMatrix(true, false);                         // мир головы = итог цепочки (после твиста/удара)
  head.getWorldQuaternion(_hlCur);
  _hlWas.copy(_hlCur);                                          // мир головы ДО коррекции (для доли шеи)
  const cp = Math.cos(pitch), sp = Math.sin(pitch);            // ЦЕЛЕВОЙ кивок: forward.y = sin(pitch) (<0 = вниз), горизонт = cos(pitch)
  _hlFwd.set(Math.sin(aimYaw) * cp, sp, Math.cos(aimYaw) * cp).normalize();   // yaw→прицел, pitch→ЗАДАННЫЙ (убирает свинг-нырок корпуса)
  _hlR.crossVectors(_UP_Y, _hlFwd);                            // right = up × fwd (горизонт, без ролла)
  if (_hlR.lengthSq() < 1e-6) _hlR.set(1, 0, 0);              // смотрит строго вверх/вниз → произвольный right
  _hlR.normalize(); _hlU.crossVectors(_hlFwd, _hlR).normalize();   // up = fwd × right (в плоскости fwd–мирВверх → нет наклона вбок)
  _hlM.makeBasis(_hlR, _hlU, _hlFwd); _hlDes.setFromRotationMatrix(_hlM);   // целевая: смотрит на прицел, ВЕРТИКАЛЬНА
  _hlCur.slerp(_hlDes, weight);                                // бленд итог→цель по весу (0.85 = держит + чуть гуляет)
  // ДОЛЯ ШЕИ. Вся коррекция целиком в кости головы = «голова набок» на резком замахе: гасить размах корпуса
  // одним суставом анатомически нечем. Отдаём шее часть ДЕЛЬТЫ (мировой), а голову потом добираем ТОЧНО до цели —
  // направление взгляда не меняется, меняется только распределение по цепи. Нужно на ЗАПЕКАНИИ (там weight = 1
  // и коррекция максимальна); в рантайме `neckShare = 0` → поведение байт-в-байт прежнее.
  if (neckShare > 0.001) {
    const neck = human.bones.get('Neck');
    if (neck) {
      _hlD.copy(_hlCur).multiply(_hlWas.invert());             // D = целевой·текущий⁻¹ (мировая дельта)
      _hlI.identity().slerp(_hlD, Math.min(1, neckShare));
      neck.updateWorldMatrix(true, false);
      neck.getWorldQuaternion(_hlNW);
      const np = neck.parent;
      neck.quaternion.copy(np ? np.getWorldQuaternion(_hlP).invert().multiply(_hlI.multiply(_hlNW)) : _hlI.multiply(_hlNW));
      neck.updateWorldMatrix(false, true);                     // дети (голова) — на новый мир шеи
    }
  }
  const par = head.parent;
  head.quaternion.copy(par ? par.getWorldQuaternion(_hlP).invert().multiply(_hlCur) : _hlCur);   // → локаль родителя
}

// ── Замер ТОЧНЫХ плантов стоп из авторской idle-позы (для приставного шага при повороте на месте) ──
const STANCE_LEG_BONES = ['LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg', 'LeftFoot', 'RightFoot'];
const _ms0 = new THREE.Vector3(), _ms1 = new THREE.Vector3(), _ms2 = new THREE.Vector3();
/** Плант ноги = ТОЧНАЯ позиция стопы в idle-стойке отн. таза (body-local, yaw 0): lat (X, + = сторона своей кости) + fwd (Z).
 *  Позируем ноги авторской стойкой, читаем мировые стопы отн. таза → по каждой ноге СВОЙ (lat, fwd) СО ЗНАКОМ (не усредняем).
 *  Планировщик (setStance) при повороте держит стопы В ЭТИХ точках и переступает ровно в них (idl-стойка в новом фейсинге).
 *  Нет клипа стойки → фолбэк ±полуширина таза РИГА (нога 0/левая на +X — под её кость LeftUpperLeg, см. [[humanoid-rig-mirror]]).
 *  Мутирует human (reset + поза ног) — зови вне кадра рендера (спавн/смена оружия); следующий полный step перепозирует. */
/**
 * Планты стоп из idle-стойки + высота таза + ⭐ ОРИЕНТАЦИЯ СТОПЫ (наклон X и рыск Y, как их поставил автор).
 *
 * ⚠ ЗАЧЕМ ОРИЕНТАЦИЯ. Планты планировщик уже брал отсюда, а стопу держал «прямо» (рыск 0) — и на
 * передаче ног авторской позе стопы ДОВОРАЧИВАЛИСЬ. ЗАМЕР расхождения поза↔планировщик в покое:
 * левая стопа по рыску **0.502 рад (28.8°)**, правая −0.296 (17°) и по наклону −0.314 (18°); у бедра
 * и голени — сотые. То есть «доступил, а потом раздвигается и ступни скручиваются» — это почти
 * целиком стопа, и расхождение СТАТИЧЕСКОЕ, не от поворота.
 */
/**
 * `pelvisW` — ДОЛЯ ТАЗА АВТОРСКОЙ СТОЙКИ, с которой мерить (0 = как было, бит в бит: таз занулён).
 *
 * ⭐ МЕРИМ С ПОВОРОТОМ ТАЗА, НО БЕЗ СДВИГА. Планты — это цели ПЛАНИРОВЩИКА, и если игра рисует стопы под повёрнутым
 * авторским тазом, а планты сняты под ровным, цели и нарисованные стопы расходятся ровно на авторский поворот. Сдвиг
 * (`__hipsD` X/Z) сюда, наоборот, НЕ идёт: стопы — дети таза, и в разности `стопа − таз` он сокращается по построению
 * (сторож — `stancePelvis.test.ts`). Вес — тот же, что ляжет в кадре стоя (там `legMag` = 0 и клипа хода нет, то есть
 * ровно ручка `GAIT.stancePelvis`).
 */
export function measureStancePlants(human: Humanoid, idle: Pose | null, pelvisW = 0): { latL: number; fwdL: number; latR: number; fwdR: number; standY: number; foot: StanceFoot } {
  const hw = human.legRest?.hipHalfW ?? HIP_DX;   // полутаз — из рига; HIP_DX остаётся только процедурному манекену
  const noFoot: StanceFoot = { pitchL: 0, yawL: 0, pitchR: 0, yawR: 0, liftL: 0, liftR: 0 };
  if (!idle) return { latL: hw, fwdL: 0, latR: -hw, fwdR: 0, standY: GAIT.standY, foot: noFoot };
  human.reset();
  const hips = human.bones.get('Hips')!;
  hips.position.set(0, 30, 0); hips.rotation.set(0, 0, 0);
  const sp = idle['Hips'];
  if (sp && pelvisW > 1e-4) hips.quaternion.copy(stancePelvisQuat(sp[0], sp[1], sp[2], pelvisW, pelvisW * clamp(GAIT.stancePelvisYaw, 0, 1)));
  for (const nm of STANCE_LEG_BONES) { const e = idle[nm]; if (e) { const b = human.bones.get(nm); if (b) b.rotation.set(e[0], e[1], e[2]); } }
  // Аддукт НЕ применяем: планты = АВТОРСКАЯ ширина стойки (как Позы-таб рисует idle, БЕЗ аддукта). idle в gaitToHumanoid тоже без
  // аддукта (legMag=0), так что стойка ≡ планты. Реконструкция при подшаге (legMag→1) добирает аддукт и всё равно попадает в план.
  human.root.updateMatrixWorld(true);
  const h = hips.getWorldPosition(_ms0);
  const fl = human.bones.get('LeftFoot')!.getWorldPosition(_ms1);
  const fr = human.bones.get('RightFoot')!.getWorldPosition(_ms2);   // yaw 0 → world X = body-lateral, world Z = forward
  // Высота таза стойки. ПРИОРИТЕТ — авторская `__hipsP[1]` из idle-позы (где юзер поставил таз = ИСТИНА): и стойка, и бег,
  // и восстановление на applyPose берут ОДНУ величину → нет провала после бега и рассинхрона бег↔стойка (редактор ≡ игра).
  // (Старые ключи `__hipsY`/`__hipsP` приводятся к дельте в `hipsOffset` — оттого здесь прибавляется rest-высота.)
  // Фолбэк (позы вообще без офсета таза): расчёт из стоп — таз так, чтобы стопы idle стояли на полу (FOOT_Y + footLift).
  const authored = hipsOffset(idle, human.hipsRest.y);
  const standY = authored ? human.hipsRest.y + authored[1] : (human.ankleRest ?? (FOOT_Y + (human.footLift ?? 0))) + (h.y - (fl.y + fr.y) / 2);   // пол — из рига (`ankleRest`), см. poseRuntime.update
  const fL = idle['LeftFoot'], fR = idle['RightFoot'];
  // ⚠ ВЫСОТА — ОТ ПОЛА ЛОДЫЖКИ РИГА (`ankleRest`), а не абсолютная: иначе она поедет за морфом.
  // Нет замера пола (урезанные скелеты/тесты) — считаем стойку стоящей на полу, то есть подъём 0.
  const floor = human.ankleRest ?? null;
  const foot: StanceFoot = {
    pitchL: fL?.[0] ?? 0, yawL: fL?.[1] ?? 0, pitchR: fR?.[0] ?? 0, yawR: fR?.[1] ?? 0,
    liftL: floor === null ? 0 : fl.y - floor, liftR: floor === null ? 0 : fr.y - floor,
  };
  return { latL: fl.x - h.x, fwdL: fl.z - h.z, latR: fr.x - h.x, fwdR: fr.z - h.z, standY, foot };
}

// ── PosePlayer: драйвер гейта для ИГРЫ (владеет своим состоянием) — тредмил-ноги + idle-стойка + физ-удар ──
const _vfl = new THREE.Vector3(), _vfr = new THREE.Vector3();
export class PosePlayer {
  // ⚠⚠ ЗДЕСЬ БЫЛО `readonly driver = new PoseDriver()` — НА КАЖДОЙ КУКЛЕ СЦЕНЫ, включая монстров
  // и чужих игроков. Планировщик живёт в `BakePlayer` (`bakePlayer.ts`): граница проведена ВЛАДЕНИЕМ,
  // а не флагом — тогда «вырезан ли планировщик» доказывает тип, а не дисциплина.
  protected px = 0; protected pz = 0; private vx = 0; private vz = 0;   // px/pz — шов `plannerFeed` отдаёт мир планировщику
  protected aimYaw = 0;  // прицел (курсор/facing с сервера); читает шов `plannerFeed`
  private rootYaw = 0;   // таз — догоняет aimYaw с задержкой (torso-lead)
  private yawInit = false;
  private turning = false;   // защёлка доворота таза (torso-lead): вкл за порогом, выкл когда догнал
  private leadRate = 0;      // скорость доворота таза, рад/с (состояние разгона — см. `TURN_ACCEL_SEC`)
  /** Взведён ли разгон таза: взводит ходьба, снимает ОСТАНОВКА ТАЗА (не ног) — см. `TURN_ACCEL_SEC`. */
  private turnAccelHold = false;
  private prevAim = 0; private aimStableFor = 0;   // сколько прицел стабилен (для relaxTime — доворот таза к нейтрали)
  private aimGap = 0;        // сколько прицел НЕ МЕНЯЛСЯ (сек) — знаменатель его скорости, см. `AIM_STILL_RATE`
  private aimRate = 0;       // средняя скорость прицела за окно `AIM_RATE_TAU` (рад/с)
  moveMag = 0; atkSpeed = 1;
  /** Множитель темпа удара ПОВЕРХ расчётной скорости (ползунок редактора).
   *  Отдельным полем, а не записью в `atkSpeed`: та затирала расчёт `triggerAttack`, и превью редактора
   *  расходилось с игрой (требование «редактор ≡ игра»). */
  atkTempo = 1;
  /** Двухотрезковый тайм-варп под серверный вайндап; null — метки нет, играем ровной скоростью. */
  private warp: { impact: number; pre: number; post: number } | null = null;
  /** Уходящий удар цепочки — доигрывает с затухающим весом, пока входящий набирает свой. */
  private fade: AttackFade | null = null;
  private atkPrevT = 0;   // время клипа на прошлом кадре — по этому интервалу ищем метки
  /** Куда уходят метки кадров (звук/VFX/тряска/шаги). Клип говорит ЧТО и КОГДА, обработчик решает КАК. */
  onMark: ((e: MarkEvent) => void) | null = null;
  /** Шаги (см. `STEP_MIN_GAP`): опора прошлого кадра (null — ещё не следили), время последнего шага на ногу, часы. */
  private stepSup: [boolean, boolean] | null = null;
  private stepAt: [number, number] = [-1e9, -1e9];
  private stepClock = 0;
  /** Ведущий клип бега на прошлом кадре: его время, фаза цикла и секция — отсюда пройденный отрезок меток. */
  private locoMark: { clip: Clip; t: number; phaseU: number; section: LocoSection } | null = null;
  /**
   * ⭐⭐ АТАКА ЗАЖАТА. Пока true, конец окна комбо НЕ отпускает удар в стойку, а начинает следующий
   * (`comboNext`). Нет метки `combo` или не зажато — поведение прежнее бит в бит.
   */
  attackHold = false;
  /** Кто даёт следующий клип цепочки. Ставит кукла: пул ударов и чередование — её дело, не наше. */
  comboNext: (() => Clip | null) | null = null;
  private atkWindow = 0; private atkWindup = 0;          // тайминг последнего свинга — автосцепка продолжает с ним же
  private atkState: { priority: number; interruptible: boolean; blendSec: number; legs: 'auto' | 'never' | 'always' } | undefined;
  private atkAuto = -1;                                   // сек с момента АВТОСЦЕПКИ (<0 — её не было)
  private legsHeld = false;                               // ноги сейчас у клипа удара (см. `step`)
  private still = false;                                  // защёлка «стоим» (гистерезис STILL_ON/OFF)
  private atkLegsW = 0;                                   // плавный вес позы ног клипа (авторитет — мгновенный, поза — нет)
  combat = 0;                     // боевой айдл 0..1 (сглажен, кроссфейд за GAIT.combatBlend сек)
  private combatTarget = 0;
  setCombat(on: boolean): void { this.combatTarget = on ? 1 : 0; }   // вход/выход боевой стойки (сервер-авторитетный флаг)
  private stunned = false; private downed = false;
  /**
   * СОСТОЯНИЯ С СЕРВЕРА (Ф1.5): оглушён / сбит с ног.
   *
   * До этого их не видел никто: у монстров `stun` только рисовал иконку над головой, `downed` не
   * читался вообще, а у игрока поля стана в снапшоте не было — свой стан анимация не замечала.
   * Теперь ВХОД в состояние запускает свой клип через тот же слот действия, что и удар: он уже умеет
   * огибающую, кроссфейд и владение низом тела. Нет клипа — состояние просто не отыгрывается, и
   * ничего не ломается: это ровно сегодняшнее поведение.
   */
  setState(stunned: boolean, downed: boolean): void {
    // Порядок здесь — только про то, КАКОЕ событие произошло. Кто кого перебивает, решают приоритеты
    // состояний (`pe_anim.states[*].priority`), а не последовательность этих `if`-ов.
    if (downed && !this.downed) this.playState('knockdown_fall');
    else if (!downed && this.downed) this.playState('getup');
    else if (stunned && !this.stunned) this.playState('stagger');
    this.stunned = stunned; this.downed = downed;
  }
  get isStunned(): boolean { return this.stunned; }
  get isDowned(): boolean { return this.downed; }
  /**
   * Войти в состояние слота действия.
   *
   * Раньше любое новое действие безусловно подменяло текущее. Теперь у состояния есть приоритет и
   * прерываемость: непрерываемое состояние (например, падение) не перебьётся тем, что слабее, —
   * и это авторится, а не зашито.
   */
  playState(state: string): void {
    const cfg = this.content.stateCfg?.(state);
    const c = this.content.stateClip?.(state);
    if (!c) return;                                            // клипа нет — состояние не отыгрывается
    const playing = !!this.atk.clip && this.atk.t >= 0;
    if (playing && this.atk.lock && (cfg?.priority ?? 0) <= (this.atk.prio ?? 0)) return;   // текущее не перебить
    this.triggerAttack(c, 0, 0, cfg);
  }
  private noIk = false;   // поза-LOD: пропуск off-hand IK (FOOT-IK пропускает рендер отдельно)
  setNoIk(on: boolean): void { this.noIk = on; }
  /** Вес ГЕЙТА в ногах (0 = поза idle-стойки, 1 = шаг планировщика). Сглажен: резкий скачок = дребезг ног. */
  legMag = 0;
  private stepHold = 0;   // остаточное удержание «ноги ведёт гейт» после подшага (антидребезг мерцающего settled)
  /** Текущий (сглаженный) доворот таза под направление хода + выбор оси «вперёд/назад». */
  private dirWarp: DirWarp = { ...DIR_WARP0 };
  /** Часы ЖИВОЙ СТОЙКИ (сек). Многокадровый idle играет по ним циклом; однокадровый их не замечает. */
  private idleT = 0;
  /** Секция локомоции (Ф5б): разгон / цикл / остановка. Меток в клипе нет — всегда цикл. */
  private locoSec: LocoSectionState = { section: 'idle', t: 0 };
  /** Текущая доля клипа локомоции (едет к цели за `LOCO_FADE`) — см. комментарий на месте чтения. */
  private locoW = 0;
  /**
   * Идёт клип поворота на месте (`turnInPlace.ts`): время, курс таза на старте, вес, гасится ли. Для высоты таза
   * (приращение, см. `blendClipBones`): `hy0` — таз ПЕРВОГО КЛЮЧА клипа (дельта от rest; null — клип таз не трогает),
   * `lift` — таз до клипа поворота минус высота стойки `clipStandY`: в «только клипы» — ЖИВОЙ, каждый кадр; в смешанном —
   * запомненный на первом кадре поворота (null — ещё не играл ни кадра). Почему по-разному — на месте чтения.
   */
  private turn: { clip: Clip; t: number; startYaw: number; w: number; out: boolean; hy0: number | null; lift: number | null } | null = null;
  /** Сколько секунд верх упирается в предел скрутки, пока поворот не начат (правило 2 `shouldCommitTurn`). */
  private turnPinnedFor = 0;
  /**
   * Поворотами на месте на этом кадре распоряжаются клипы — и когда клип играет, и когда ЖДЁМ решения.
   * ⚠ Ноги планировщику не отдаём и в ожидании: он целит подшаг в стойку на ПРИЦЕЛЕ (`setGoalYaw`) и за
   * 0.1 с ожидания успевал начать свой шаг — поймано тестом «планировщик шагал поверх клипа».
   */
  private turnMode = false;
  /** Имя играющего поворота — окну слоёв и тестам. null = не поворачиваемся клипом. */
  get turnClipName(): string | null { return this.turn && !this.turn.out ? this.turn.clip.name : null; }
  /**
   * Оборвать поворот сразу, без гашения (запекание, телепорт). ⚠ Шов поворота (`seamW`) тоже сбрасываем: обрыв снаружи
   * `step` — это снап по смыслу, и недогашенная разница (или «показанная поза» до телепорта) не должна доехать до
   * следующего кадра. Зовётся и из `snapYaw`.
   */
  cancelTurn(): void { if (this.turn) { this.turn = null; this.replantPlanner(); } this.seamW = 0; this.shownOk = false; }
  /**
   * Режим «только клипы» на этом кадре (см. `CLIP_ONLY_TG`): планировщик не обновлялся и не читался.
   * ⚠ `null` — кадров ещё не было, режим НЕИЗВЕСТЕН. Было `false` — и каждая кукла на первом же кадре
   * «меняла режим», снимала снимок всех костей и четверть секунды перетекала из позы, оставленной конструктором.
   */
  private clipOnlyNow: boolean | null = null;
  get clipOnly(): boolean { return this.clipOnlyNow === true; }
  /**
   * ⭐⭐ ЕСТЬ ЛИ У ЭТОГО КАДРА НАСТОЯЩИЙ КЛИП ХОДА — не «набор где-то есть», а поза в руках.
   *
   * Это замена снятому `hasLocoSet`. Разница принципиальная: старая проверка спрашивала библиотеку про
   * `run_fwd` и по одному ответу переключала ВЕСЬ режим куклы; эта смотрит, что реально собралось В ЭТОМ
   * кадре, и гасит только то, что без клипа бессмысленно (фиксацию стоп).
   */
  private clipLoco = false;

  // ── ⭐⭐ ШВЫ ПЛАНИРОВЩИКА (Э12) ───────────────────────────────────────────────────
  //
  // Базовый `PosePlayer` — ИГРОВОЙ: он не знает про `PoseDriver` ВООБЩЕ, и именно это делает
  // вырезание доказуемым: нет ссылки — нет класса в бандле. Планировщик живёт в `BakePlayer`
  // (`bakePlayer.ts`) — его строят редактор и запекатель.
  //
  // ⚠⚠ ГРАНИЦА — ВЛАДЕНИЕМ, А НЕ ФЛАГОМ, и `step()` ОСТАЁТСЯ ОДИН. Переопределить `step()` целиком
  // было бы копией кадрового конвейера — второй правдой на самом горячем месте. Поэтому
  // тернарники `clipOnly ? … : шов` остаются в `step()` как были: в базе вторая ветка просто не берётся.
  //
  // ⚠ ПОРЯДОК ЧТЕНИЙ — КОНТРАКТ, а не стиль. `plannerSwing` читается ДВАЖДЫ за кадр с РАЗНЫМ
  // смыслом: до `plannerUpdate` — состояние прошлого кадра (им считаются `busy`/`legsHeld`), после — свежее
  // (им `warpStanceFeet` выбирает ногу). Кэш на кадр тихо меняет поведение на границе переноса ноги.
  // То же про `plannerHipsTurn`: угол считается ВНУТРИ `plannerUpdate`, читать его раньше — угол прошлого кадра.

  /** Есть ли у этой куклы планировщик вообще. У игровой — нет, и это не режим, а тип. */
  protected get hasPlanner(): boolean { return false; }
  /** Переставить стопы планировщика на место (поворот, возврат из «только клипы»). */
  protected plannerReplant(): void { /* игра: планировщика нет */ }
  /** Выбросить состояние походки целиком (запекание). */
  protected plannerReset(): void { /* игра: нечего сбрасывать */ }
  /** Замеренная стойка → планировщику. ⚠ Зовётся ИЗ КОНСТРУКТОРА БАЗЫ — см. `BakePlayer.driver`. */
  protected plannerStance(_p: ReturnType<typeof measureStancePlants>): void { /* игра */ }
  /** Боевая колонка настроек → планировщику. ⚠ СТРОГО ДО `plannerStance` в кадре: внутри `StepPlanner` порядок значим. */
  protected plannerCombat(_c: number): void { /* игра */ }
  /** Весь вход кадра: пол, длины рига, мир, прицел, смещения и обводы плантов. */
  protected plannerFeed(_yaw: number, _vx: number, _vz: number, _spd: number, _fwdC: number, _latC: number): void { /* игра */ }
  /** Идёт ли сейчас подшаг. */
  protected get plannerStepping(): boolean { return false; }
  /** Какие ноги в переносе. ⚠ МЕТОД, а не кэш: читается до и после `plannerUpdate` с разным смыслом. */
  protected plannerSwing(): readonly [boolean, boolean] { return NO_SWING; }
  /** Ноги отобраны слоем действия / поворотом + фидбэк фактических стоп. */
  protected plannerLegs(_held: boolean, _feedback: boolean): void { /* игра */ }
  /** Шаг планировщика → цели позы. В базе недостижим — ветка за ним прячется за `clipOnly`. */
  protected plannerUpdate(_dt: number): PoseTargets { return CLIP_ONLY_TG(); }
  /** Фаза походки планировщика — часы съёма у запекателя. */
  protected get plannerPhase(): number { return 0; }
  /** Поворот таза этого кадра. ⚠ Считается внутри `plannerUpdate` — читать ТОЛЬКО после него. */
  protected get plannerHipsTurn(): number { return 0; }
  /** Плант-цель ноги в мире. */
  protected plannerPlant(_i: 0 | 1): readonly [number, number] { return NO_PLANT; }
  /** Веса заземления / постановки от планировщика. */
  protected plannerGroundW(): readonly [number, number] { return ONE_ONE; }
  protected plannerPlantW(): readonly [number, number] { return ONE_ONE; }
  /** Пересадить стопы планировщика после поворота — только если он в деле: в «только клипы» его не трогаем вовсе. */
  private replantPlanner(): void { if (!this.clipOnly) this.plannerReplant(); }
  /** Часы клипов в режиме «только клипы»: фаза по пройденному пути (рад, π на шаг — как у планировщика). */
  private clipPhase = 0;
  /** Поза в момент смены режима и доля, с которой она ещё держится (см. `MODE_FADE`). */
  private modeSnap: { rot: Map<string, THREE.Quaternion>; hips: THREE.Vector3 } | null = null;
  private modeBlend = 0;
  /** Опорные стопы клипа (true = на полу) и точки, где они коснулись пола (мир), — фиксация стопы. */
  private clipContact: [boolean, boolean] = [true, true];
  private footLock: [{ x: number; z: number } | null, { x: number; z: number } | null] = [null, null];
  /** Вес фиксации стоп (см. место чтения): на ходу 1, встали — гаснет за `LOCO_FADE`. */
  private lockW = 0;
  /** Веса заземления: в «только клипы» опору решает контакт, окон планировщика нет. */
  get groundWeights(): [number, number] { const w = this.clipOnly ? ONE_ONE : this.plannerGroundW(); return [w[0], w[1]]; }
  get plantWeights(): [number, number] { const w = this.clipOnly ? ONE_ONE : this.plannerPlantW(); return [w[0], w[1]]; }
  /**
   * КАКИЕ СТОПЫ ЗАЗЕМЛЯТЬ. Обычно — опорные по планировщику; на время клипа поворота — по флагам
   * переноса ИЗ КЛИПА: ноги у планировщика отобраны, он считает обе опорными и положил бы маховую
   * ногу клипа плоско на пол (подъём стопы из клипа не был бы виден вовсе).
   */
  get groundSupport(): [boolean, boolean] {
    if (this.turn && this.turn.w > 0.5) return turnSupportAt(this.turn.clip, this.turn.t);
    if (this.clipOnly) return [this.clipContact[0], this.clipContact[1]];
    const sw = this.plannerSwing();
    return [!sw[0], !sw[1]];
  }
  /** Доворот таза этого кадра — редактору для читаута. */
  get dirWarpDeg(): number { return this.dirWarp.warp * 180 / Math.PI; }
  /** Идём ли спиной вперёд (доворот меряется от хвоста) — редактору для читаута. */
  get dirWarpBack(): boolean { return this.dirWarp.sector === 2; }
  /** Сектор доворота: 0 вперёд, 1 +X (strafe_R), 2 назад, 3 −X (strafe_L). */
  get dirWarpSector(): WarpSector { return this.dirWarp.sector; }
  /** Сектора (true) или старая складка вперёд/назад (false, пока страйфы не перезапечены) на этом кадре. */
  get dirWarpSectors(): boolean { return this.warpSectorsNow; }
  private warpSectorsNow = true;
  /**
   * Все запечённые страйфы (ходьба/бег, обе стороны) текущего оружия — кардинальные, ревизии `LOCO_BAKE_REV`.
   *
   * ⚠ РЕЗУЛЬТАТ КЭШИРУЕТСЯ: это ЧЕТЫРЕ поиска по библиотеке (привязка `pe_anim` → `migratePoseName` → скан
   * `findLocoClip` дважды), а шагает этим кодом КАЖДАЯ кукла на сцене — монстры и чужие игроки тоже. Пересчёт: смена
   * оружия (сразу) и не чаще `FRESH_TTL`. Задержка видна только в редакторе сразу после перезапекания набора — четверть
   * секунды, дальше сектора включаются сами.
   */
  private freshCache = { weapon: '', at: -1e9, val: true, has: false };
  private strafeClipsFresh(): boolean {
    const lc = this.content.locoClip; if (!lc) return true;
    const c = this.freshCache;
    if (c.has && c.weapon === this.weapon && this.stepClock - c.at < FRESH_TTL) return c.val;
    let val = true;
    for (const d of ['strafe_L', 'strafe_R'] as const) for (const fast of [false, true]) {
      const cl = lc(locoClipNames(d, fast), this.weapon);
      if (cl && !isLocoClipFresh(cl)) { val = false; break; }
    }
    c.weapon = this.weapon; c.at = this.stepClock; c.val = val; c.has = true;
    return val;
  }
  /**
   * ⚠⚠ ЗДЕСЬ ЖИЛ `hasLocoSet()` — ПОСЛЕДНЯЯ ЖИВАЯ ТОЧКА ВХОДА ПЛАНИРОВЩИКА В ИГРУ (снят Э13б).
   *
   * Он спрашивал библиотеку про `run_fwd`/`walk_fwd` ПОД ТЕКУЩЕЕ ОРУЖИЕ и по одному этому ответу
   * переключал ВЕСЬ режим куклы — молча и прямо в бою, потому что ключ кэша — оружие.
   * Заменен не пустотой, а `clipLoco`: проверкой того, что клип РЕАЛЬНО собрался в ЭТОМ кадре.
   * См. `clipLoco` выше и место решения `clipOnly` в `step`.
   */
  /** Забыть доворот (запекание, телепорт): таз ровно, сектор «вперёд». */
  resetDirWarp(): void { this.dirWarp = { ...DIR_WARP0 }; }
  /** Курс таза БЕЗ доворота и поворота таза (прицельный корень): ровно его вычитает запекатель из клипа страйфа. */
  get aimRootYaw(): number { return this.rootYaw; }
  /**
   * ⭐⭐ СТАТИЧЕСКАЯ ЧАСТЬ рыска таза этого кадра (рад) — В КОСТИ, как и качание, а НЕ в курсе.
   *
   * ⚠ ЭТО ДИАГНОСТИКА И ПОДПИСЬ КЛИПА (`hipsYawDeg`), а не отдельный источник поворота: угол уже посчитан
   * внутри `hipsYawSwingRad` (тот меряет ВЕСЬ рыск кости — качание плюс поворот). Складывать их — считать
   * дважды; сторож съёма `assertPelvis` именно поэтому перечисляет только `hipsYawSwingRad`.
   */
  get hipsTurnRad(): number { return this.turnNow; }
  private turnNow = 0;
  /** Насколько ПОВОРОТ ТАЗА этого кадра сдвинул стопы в мире (X/Z на ногу) — ровно это вычитается из фидбэка. */
  protected turnFeet: [number, number, number, number] = [0, 0, 0, 0];   // читает шов `plannerLegs` (вычет своего поворота)
  /** ЗАМЕРЕННЫЙ рыск таза, который в этом кадре положила на кость ПОХОДКА (качание + статический поворот), рад. */
  get hipsYawSwingRad(): number { return this.hipsYawNow; }
  private hipsYawNow = 0;
  /** ЗАМЕРЕННЫЙ рыск таза, пришедший ИЗ КЛИПОВ хода этого кадра (уже с весом клипа `mix`), рад. */
  get clipHipsYawRad(): number { return this.clipHipsYaw; }
  private clipHipsYaw = 0;
  /** Нашёлся ли в этом кадре клип хода с запечённым поворотом таза (метка `Clip.hipsYawW`). */
  private clipYawMeta = false;
  /**
   * Колонка клипов прошлого кадра и уходящая колонка (кроссфейд `COL_FADE`). Поля ПЕРЕИСПОЛЬЗУЮТСЯ (`has`/`w` вместо
   * null): кадр куклы не должен аллоцировать — этим кодом шагают и монстры, и чужие игроки.
   */
  private colPrev = { axes: { sb: 0, st: 0, bt: 0 } as LocoAxes, latPlusX: false, has: false };
  private colFade = { axes: { sb: 0, st: 0, bt: 0 } as LocoAxes, latPlusX: false, w: 0 };
  /** Мемо разбора клипов `_open` НА ОДИН КАДР: слот = сторона (+X / −X) | бег·2, маска — что уже посчитано (см. `findOpen`). */
  readonly atk: AttackState = { clip: null, t: -1 };
  constructor(
    protected human: Humanoid,
    private weaponGroups: () => THREE.Group[],
    private content: PoseContent,
    public weapon: string,
    public gx: GXKnobs,
    public plant: PlantGrid,
    public twistStates: TwistStates = TWIST_STATES_DEFAULT(),
  ) { this.measureStance(); }
  /** Combat, при котором мерили стойку: −1 = ещё не мерили (первый замер в конструкторе). */
  private stanceCombat = -1;
  /**
   * Доля таза стойки, С КОТОРОЙ мерены нынешние планты (−1 = ещё не мерили). Ею `step` ловит и ползунок редактора,
   * и перекрытие запекания: `combat` внутри съёма ПОСТОЯНЕН, и автоматический пере-замер по нему не сработал бы
   * никогда — планировщик весь съём целился бы в планты, снятые под ДРУГИМ тазом.
   * ⚠ Почему не явный вызов из `clipBake`: `setStance` снапает `hipY`/`hipWant` планировщика, и лишний вызов между
   * клипами набора менял бы сами клипы (ЗАМЕР: до 3.46° на колене `run_fwd`). Здесь он случается ровно один раз —
   * на первом кадре разогрева, до которого планировщик ещё ничего не решил.
   */
  private stanceKnob = -1;
  /**
   * Замерить планты стоп и высоту таза из idle-стойки текущего оружия и отдать планировщику
   * (подшаг при повороте идёт в эти точки).
   *
   * ⭐ МЕРИМ НА ТЕКУЩЕЙ БОЕВОЙ ОСИ. Раньше `resolveUpper(weapon)` звался БЕЗ `combat`, то есть с
   * умолчанием 0 — планировщик всегда получал РЕЛАКС-стойку. ЗАМЕР на топоре: релакс даёт таз
   * **31.72** и стойку 3.86 / −3.27, бой — **30.72** и 6.74 / −5.62. Пока ноги ведёт сама поза,
   * расхождение не видно; но на ПОВОРОТЕ НА МЕСТЕ ноги забирает планировщик (`legMag` → 1) — и таз
   * поднимался ровно на эту единицу, а стопы сводились. Жалоба была именно такой.
   *
   * ⚠ Время живой стойки берём 0, а не `idleT`: `standY` — БАЗА для планировщика, и дышащий
   * многокадровый idle не должен перенастраивать её каждый кадр.
   *
   * ⚠ Замер мутирует риг (`human.reset()` + ноги стойки), и с 17.09 — в ОБОИХ режимах: в «только клипы» он нужен ради
   * `clipStandY`. Вызов снаружи `step` (`setWeapon`) оставляет риг сброшенным до следующего шага (таз рыцаря 35.13 → 30.00);
   * у планировщика так было всегда, а оба живых вызывающих (`gamePlayerDoll.setWeapon`, превью редактора) шагают до
   * рендера — на экран это не попадает.
   */
  measureStance(): void {
    // ⚠ Планты — С ТАЗОМ СТОЙКИ (его поворотом), тем же весом, что ляжет в кадре стоя: иначе цели планировщика и
    // нарисованные стопы разойдутся ровно на авторский поворот таза (см. `measureStancePlants`).
    this.stanceKnob = stancePelvisKnob();
    const p = measureStancePlants(this.human, this.content.resolveUpper(this.weapon, this.combat, 0)?.pose ?? null, this.stanceKnob);
    this.clipStandY = p.standY;
    // «Только клипы»: планировщику стойку НЕ отдаём (в этом режиме к нему ни одного обращения), но высоту таза
    // держим сами — см. `clipStandY`. −1 = при возврате в планировщик замерить заново.
    if (this.clipOnly) { this.stanceCombat = -1; this.clipStanceCombat = this.combat; return; }
    this.plannerStance(p);
    this.stanceCombat = this.combat; this.clipStanceCombat = -1;
  }
  /**
   * ⭐⭐ ВЫСОТА ТАЗА СТОЯ В «ТОЛЬКО КЛИПЫ» — та же `standY`, что планировщик получает из стойки.
   *
   * ⚠ Без неё таз стоя стоял на голой базе `gaitToHumanoid` (30 + bobY, bobY = 0 у `CLIP_ONLY_TG`), а клип
   * поворота кладёт таз на `hipsRest.y + __hipsD` (рыцарь: 35.049 − 0.081 = 34.968). ЗАМЕР, опубликованный
   * warrior, turn_R_90: таз 30.000 → 34.968 за кадр на старте клипа и 34.809 → 30.000 на конце (заземлённый
   * +3.74 / −3.57, размах 6.1) — «при повороте дёргается вверх-вниз». До ea59571 locoMix = 1 шёл через
   * планировщик, и его bobY = standY − 30 — отсюда и прежняя гладкость (≤ 0.18 за кадр).
   */
  private clipStandY = GAIT.standY;
  /** Combat, при котором мерили `clipStandY` в «только клипы»: −1 = замерить на ближайшем кадре. */
  private clipStanceCombat = -1;
  /**
   * ⭐⭐ ШОВ КЛИПА ПОВОРОТА — ИНЕРЦИАЛИЗАЦИЯ ТАЗА И НОГ (`TURN_BONES` + позиция таза).
   *
   * Клип забирает таз и ноги весом 1 в кадр решения и отдаёт в кадр конца, а его крайние кадры стоят не ровно в стойке:
   *  • таз — конец клипа не на высоте начала (запечённый рыцарь: старт −0.081, конец turn_R_90 −0.247);
   *  • ноги — первый ключ держит ноги ПЛАНИРОВЩИКА стоя (при опубликованном `idleSettle` 0 он в idle-позу не уходит:
   *    колено 0.411 рад), а «только клипы» стоит в АВТОРСКОЙ idle-позе (колено 0.023). В смешанном режиме стойка —
   *    та же реконструкция планировщика, отсюда там 0.03°, а в «только клипы» 23.4° за кадр и стопа на 1.25 вбок.
   *    Конец клипа против планировщика, забирающего ноги после `replant`, — 4.7–9.8° и стопа до 4.6 даже в смешанном.
   * Разницу, скакнувшую в кадр смены, гасим за `TURN_FADE` (smoothstep): в кадр смены запоминаем СМЕЩЕНИЕ «показанное
   * минус новое» и затухаем его ПОВЕРХ живого источника — как узел `Inertialization` в UE (у `modeSnap` — замершая
   * поза; здесь клип с первого же кадра ведёт маховую ногу, и замершая поза её бы держала).
   * ⚠ Весь клип целиком НЕ гасим (так пробовали): вес клипа < 1 на опоре уводил стопу — смешанный 45° уезжал на 2.44.
   * `shown*` — показанная поза прошлого кадра; `seam*` — смещение и доля.
   *
   * ⭐ ДВЕ СТУПЕНИ. Таз (`easeSeamHips`) — сразу после клипа поворота, ДО скрутки корпуса: та ставит тазу курс
   * абсолютно, и шов не должен с ней спорить. Ноги (`easeSeamLegs`) — В КОНЦЕ НОЖНОГО КОНВЕЙЕРА, после подтяжек стоп
   * (`warpStanceFeet`). ⚠ Иначе шов не видел подтяжку: она перерешает ногу IK ЦЕЛИКОМ при любом весе > 0.001 (вес
   * двигает только цель; бедро/голень ставятся заново, стопа кладётся плашмя), а при весе 0 не трогает вовсе — выключение
   * подтяжки само щёлкает. Поэтому ещё и: ПОКА ИДЁТ КЛИП ПОВОРОТА (включая гашение), ПОДТЯЖЕК НЕТ — ногами владеет клип,
   * а включение/выключение подтяжки приходится ровно на кадр смены, который шов и покрывает. Точку фиксации стопы
   * («только клипы») на это время тоже бросаем: её снимут заново с позы того кадра, когда подтяжка вернётся.
   * ЗАМЕР (рыцарь, опубликованный warrior; шли 40, встали и прицел +90 в тот же кадр: клип стартует на f7, `lockW` / `locoW`
   * гаснет на f14): ноги в кадр гашения 28.6° → 3.4° («только клипы»), 29.5° → 4.1° (смешанный), дальше — свой ход клипа
   * (≤ 21.6°); на 120 u/с смешанный 41.1° → 27.7° (это уже кадр остановки). Пошли посреди поворота — подтяжка включалась
   * посреди гашения: 28.6° → 7.9°, конец гашения 0°. Стоячие повороты, ход без поворота и процедурка — бит в бит.
   * ⚠ НЕ ЗАКРЫТО (и не про поворот): подтяжка так же щёлкает при остановке без поворота (смешанный, гаснет `locoW`), при
   * смене опорной ноги на ходу и на первом отрыве стопы после старта в «только клипы» (фиксация отпускает ногу) — 20–37°
   * и в ходьбе без всякого поворота. Шов покрывает только кадры смены клипа поворота; корень — вес подтяжки не
   * непрерывен по повороту костей.
   *
   * ЗАМЕР (рыцарь, опубликованный warrior, шесть поворотов, мгновенный и плавный прицел):
   *  • таз за кадр в «только клипы» (со стойкой `clipStandY`): 0.16–0.34 → ≤ 0.063; смешанный 0.05–0.30 → ≤ 0.063;
   *  • ноги: кадр смены 23.4° / 22.9–24.8° → 0°, хвост конца ≤ 4.1° за кадр; смешанный конец 4.7–9.8° → ≤ 1.6° (в бою
   *    10.3–14.5° → ≤ 2.4°);
   *  • опорная стопа за кадр: «только клипы» старт 1.25 → ≤ 0.24, конец до 4.66 → ≤ 0.81; в бою 3.69 → ≤ 0.62 и до 7.31 →
   *    ≤ 1.22. ⚠ ПУТЬ стопы прежний (это разница стоек, её шов не убирает) — он проходится за 0.15 с, а не за кадр.
   * Процедурка (доля 0) — бит в бит: поворот клипом там не играет, шов только запоминает позу.
   */
  private seamRot = TURN_BONES.map(() => new THREE.Quaternion());
  private seamPos = new THREE.Vector3();
  private seamW = 0;
  private shownRot = TURN_BONES.map(() => new THREE.Quaternion());
  private shownPos = new THREE.Vector3();
  private shownOk = false;
  /** Кадр смены: ступень ног снимет своё смещение в этом же кадре (решает ступень таза). */
  private seamFresh = false;
  /** Доля шва этого кадра после smoothstep — одна на обе ступени. */
  private seamS = 0;
  /** Сменили оружие, пока шов идёт: на ближайшем кадре шов снимается заново (см. `setWeapon`). */
  private seamRestart = false;
  /**
   * Шов поворота, ступень ТАЗА (см. `seamW`): `changed` — клип поворота сменился на этом кадре (начался / кончился /
   * погас). ⚠ `TURN_BONES[0]` — `Hips`, остальные — ноги (их ведёт `easeSeamLegs`).
   */
  private easeSeamHips(changed: boolean): void {
    const hb = this.human.bones.get('Hips')!, hp = hb.position;
    this.seamFresh = (changed || this.seamRestart) && this.shownOk;
    this.seamRestart = false;
    if (this.seamFresh) {
      this.seamRot[0]!.copy(hb.quaternion).invert().premultiply(this.shownRot[0]!);   // показанная · новая⁻¹
      this.seamPos.copy(this.shownPos).sub(hp);
      this.seamW = 1;
    }
    const w = this.seamW;
    this.seamS = w * w * (3 - 2 * w);
    if (w > 0) {
      hb.quaternion.premultiply(_qSeam.identity().slerp(this.seamRot[0]!, this.seamS));
      hp.addScaledVector(this.seamPos, this.seamS);
    }
    this.shownRot[0]!.copy(hb.quaternion); this.shownPos.copy(hp);
  }
  /** Шов поворота, ступень НОГ: после подтяжек стоп — показанная поза ног и есть итог конвейера. Здесь же доля убывает. */
  private easeSeamLegs(dt: number): void {
    for (let i = 1; i < TURN_BONES.length; i++) {
      const b = this.human.bones.get(TURN_BONES[i]!);
      if (!b) continue;
      if (this.seamFresh) this.seamRot[i]!.copy(b.quaternion).invert().premultiply(this.shownRot[i]!);
      if (this.seamW > 0) b.quaternion.premultiply(_qSeam.identity().slerp(this.seamRot[i]!, this.seamS));
      this.shownRot[i]!.copy(b.quaternion);
    }
    this.seamFresh = false;
    if (this.seamW > 0) this.seamW = Math.max(0, this.seamW - dt / TURN_FADE);
    this.shownOk = true;
  }
  private stanceYawNow = 0; private stanceWNow = 0;
  /**
   * ⭐⭐ ТАЗ АВТОРСКОЙ СТОЙКИ В ИГРЕ (`GAIT.stancePelvis`). Возвращает РЫСК, который реально лёг (рад) — его вызывающий
   * вычитает из бюджета скрутки и отдаёт в отворот, как раскрытие `_open`.
   *
   * ГДЕ ЗОВЁТСЯ: в `step` ПОСЛЕ шва поворота (`easeSeamHips`) и ДО `applyTorsoTwist`. Позже — курс уже на тазе, и
   * авторский наклон лёг бы в мировых осях; раньше (внутри `gaitToHumanoid`) — таз следом перезапишут клипы
   * (`Hips` входит и в `LOCO_BONES`, и в `TURN_BONES`). Шов от вставки не страдает: он снимает смещение ДО нас, и
   * наша дельта есть в обеих его половинах — сокращается.
   *
   * ВЕС — ТОТ ЖЕ, ЧТО У НОГ СТОЙКИ: `ручка × (1 − legMag) × (1 − доля клипа хода)`. Ноги идут `blendBone(…, idle, legMag)`,
   * поверх ложится клип (`blendClipBones`) — значит авторская доля равна ровно этому произведению, и таз берёт её же.
   * Новых ворот не заводим НАРОЧНО: оба множителя уже сглажены по времени (`legMag` — свой лаг, `locoW` — `LOCO_FADE`),
   * поэтому кинематический таз физ-куклы не получает ступенек (ради этого был `9c1bb6b`).
   *
   * ⚠ РЫСК МЕРИМ, А НЕ СЧИТАЕМ. `wS·Hips[1]` — не тот угол, который лёг: авторский эйлер с наклоном и креном
   * композицией даёт свой курс (`pelvisFrame.pelvisHeading` не равен слоту Y эйлера). Берём разность курса таза
   * ДО и ПОСЛЕ умножения — тогда отворот груди точен на любой стойке.
   *
   * ⚠ ВЫСОТУ НА КОСТЬ НЕ КЛАДЁМ (`__hipsD.y`): она уже приезжает `standY` → `bobY` (и `clipStandY` в «только клипы»).
   * ⚠ X/Z — ДЕЛЬТОЙ поверх того, что положил конвейер (0 стоя, `hipsRest + __hipsD` клипа под клипом), а не
   * присвоением: клип поворота снят БЕЗ таза стойки (см. `clipBake.procedural`), его сдвиг — собственное движение.
   */
  private applyStancePelvis(legFree: number, clipFree: number): number {
    const st = _stancePelvis;
    const w = stancePelvisKnob() * clamp(legFree, 0, 1) * clamp(clipFree, 0, 1);
    this.stanceWNow = w; this.stanceYawNow = 0;
    if (!st.has || w <= 1e-4) return 0;
    const hb = this.human.bones.get('Hips')!;
    const before = pelvisHeading(hb.quaternion);
    hb.quaternion.premultiply(stancePelvisQuat(st.rx, st.ry, st.rz, w, w * clamp(GAIT.stancePelvisYaw, 0, 1)));
    this.stanceYawNow = wrapPi(pelvisHeading(hb.quaternion) - before);
    hb.position.x += st.dx * w; hb.position.z += st.dz * w;
    return this.stanceYawNow;
  }
  /**
   * Сменить оружие: стойка — его (`measureStance`).
   * ⚠ ПОСРЕДИ ШВА ПОВОРОТА (`seamW` > 0) ШОВ НАЧИНАЕТСЯ ЗАНОВО — с показанной позы на новую стойку, как новый переход
   * у `Inertialization` в UE. Иначе смещение, снятое против ног СТАРОЙ стойки, ложилось на ноги новой (idle-ноги меча
   * другие — 39.7° за кадр в «только клипы») и уводило опорную стопу дальше, чем сама смена. ЗАМЕР (рыцарь, опубликованный
   * warrior, «только клипы», поворот +90, меч через 1 / 2 / 4 кадра после конца клипа): опорная стопа за кадр 3.53 / 3.26 /
   * 2.35 → 0 в кадр смены и ≤ 0.1 дальше; в бою, где ноги у меча те же, 0.18 / 0.50 / 0.86 → 0 и ≤ 0.2 дальше; смешанный —
   * таз 0.38 / 0.34 / 0.29 за кадр → 0. ⚠ «Просто погасить шов» (`seamW` = 0) пробовали: остаток шва щёлкал вместе со сменой —
   * 2.09 / 2.03 / 1.60, а в бою при тех же ногах 5.41 (весь щелчок конца клипа). Вне шва смена — снап, как и была.
   */
  setWeapon(w: string): void {
    if (w !== this.weapon && this.seamW > 0) this.seamRestart = true;
    this.weapon = w; this.measureStance();
  }
  setVel(vx: number, vz: number): void { this.vx = vx; this.vz = vz; }
  setYaw(yaw: number): void { this.aimYaw = yaw; if (!this.yawInit) { this.rootYaw = yaw; this.yawInit = true; } }
  /** Снять лаг таза (спавн/пробуждение/телепорт): таз мгновенно = прицел, без доворота-«юлы». */
  snapYaw(): void { this.cancelTurn(); this.rootYaw = this.aimYaw; this.turning = false; }
  /**
   * ⭐⭐ СОСТОЯНИЕ ПОХОДКИ С НУЛЯ — ДЛЯ ЗАПЕКАНИЯ: каждый пресет снимается НЕЗАВИСИМО ОТ ПОРЯДКА.
   *
   * ⚠ ЗАЧЕМ (ЗАМЕР 19.09, найдено при правке страйфов): `bakeGaitSet` гоняет весь набор через ОДИН плеер, а
   * разогрев 2 с НЕ обнуляет ни фазу планировщика, ни его планты, ни сглаженные веса плеера. Из-за этого правка
   * ОДНОЙ ручки чуть двигала КАЖДЫЙ клип, снятый ПОСЛЕ неё: ручка колонки `STRAFE_L` уводила `run_back` на 22.48°
   * и `walk_strafe_R` на 2.22°, тогда как всё, снятое ДО, оставалось ровно 0.00°. Контроль с посторонней ручкой
   * колонки `BACK` дал ту же картину — беда общая, не в сторонах.
   * ⚠ Сбрасываем ВЕСЬ свой набор сглаженных состояний, а не только планировщик: доля клипа, вес ног, «стоим»,
   * фиксация стоп, шов поворота, скорость прицела и разгон таза тоже переживают разогрев и тоже зависят от
   * того, что снималось до этого.
   */
  resetGaitState(): void {
    this.cancelTurn();
    this.plannerReset();
    this.dirWarp = { ...DIR_WARP0 };
    this.turnNow = 0; this.turnFeet = [0, 0, 0, 0]; this.hipsYawNow = 0; this.clipHipsYaw = 0; this.clipYawMeta = false;
    this.legMag = 0; this.moveMag = 0; this.stepHold = 0; this.locoW = 0; this.clipPhase = 0;
    this.still = false; this.lockW = 0; this.footLock = [null, null]; this.clipContact = [true, true];
    this.locoSec = { section: 'idle', t: 0 }; this.locoMark = null;
    this.colPrev.has = false; this.colFade.w = 0;
    this.leadRate = 0; this.turnAccelHold = false; this.turnPinnedFor = 0; this.turning = false;
    this.prevAim = this.aimYaw; this.aimStableFor = 0; this.aimGap = 0; this.aimRate = 0;
    this.idleT = 0; this.atkLegsW = 0; this.legsHeld = false;
    this.modeSnap = null; this.modeBlend = 0;
    this.freshCache.has = false;
  }
  /**
   * ⭐⭐ ПОВОРОТ НА МЕСТЕ КЛИПАМИ (см. `turnInPlace.ts`). Возвращает доворот таза на этот кадр — или
   * `null`, если поворот клипами сейчас неприменим и таз ведёт обычный `stepTorsoLead`.
   *
   * Режим включается, когда локомоция клипами (цель доли ≥ 0.5), персонаж СТОИТ и у него запечён хоть
   * один поворот. Тогда таз НЕ догоняет прицел сам — копится остаток (его несёт скрутка корпуса), и по
   * порогу играет клип нужной величины, ведущий таз по своей кривой. Клипов нет — ровно прежнее
   * поведение: процедурный доворот и подшаги планировщика.
   */
  private stepTurn(dt: number, twist: TwistProfile): { rootYaw: number; residual: number; turning: boolean; rate?: number } | null {
    this.turnMode = false;
    const clampTw = (r: number): number => Math.abs(r) > twist.maxTwist ? Math.sign(r) * twist.maxTwist : r;
    const t = this.turn;
    if (t) {
      const dur = clipDur(t.clip) || 1;
      if (!t.out && this.moveMag >= STILL_OFF) t.out = true;          // пошли посреди поворота — гасим, ноги отдаём ходу
      if (t.out) {
        t.w -= dt / TURN_FADE;
        if (t.w <= 0) { this.turn = null; this.replantPlanner(); }
        return null;                                                  // курс — снова у обычного доворота, от текущего
      }
      this.turnMode = true;
      t.t += dt;
      this.rootYaw = t.startYaw + turnYawAt(t.clip, t.t);
      if (t.t >= dur) { this.turn = null; this.replantPlanner(); }   // встал в стойку на новом курсе → стопы туда же
      return { rootYaw: this.rootYaw, residual: clampTw(wrapPi(this.aimYaw - this.rootYaw)), turning: true };
    }
    // ⚠⚠ ПОРОГ ЗДЕСЬ НАРОЧНО НИЖЕ, ЧЕМ У РЕЖИМА КАДРА — и это НЕ рассогласованность.
    //
    // План требовал свести два гейта в один, но реальный дефект был другой: этот гейт не спрашивал `hasLocoSet`,
    // а тот — спрашивал. С удалением `hasLocoSet` (Э13б) расхождение исчезло само.
    //
    // А оставшаяся разница порогов РАБОТАЕТ НА АВТОРА: смешанный режим бывает только в редакторе (игра
    // ставит долю в 1 безусловно), и там повороты ОБЯЗАНЫ играть клипами уже на половинной доле — иначе
    // сравнивать A/B нечего. Попытка свести пороги к одному сломала 5 тестов на доле 0.99 — они эту
    // границу и стерегут. Что было настоящей бедой — безымянные числа в четырёх местах; имена ниже.
    const clipMode = clamp(locoMixOverride ?? GAIT.locoMix, 0, 1) >= CLIP_TURN_MIX;
    if (!clipMode || !this.still || this.atk.clip || !this.content.locoClip) return null;
    const has = (name: string): boolean => !!this.content.locoClip!([name], this.weapon);
    if (!this.content.locoClip(TURN_NAMES, this.weapon)) return null;     // поворотов не запекали — процедурный доворот
    this.turnMode = true;
    const residual = wrapPi(this.aimYaw - this.rootYaw);
    this.turnPinnedFor = Math.abs(residual) >= twist.maxTwist ? this.turnPinnedFor + dt : 0;
    // ⚠ РЕШАЕМ ПО ИТОГУ ДВИЖЕНИЯ ПРИЦЕЛА, А НЕ ПО ПЕРВОМУ КАДРУ (см. шапку `turnInPlace.ts`): иначе рывок
    // мышью на 180° запускал 45° на 0.07 с и доворачивал ещё двумя клипами.
    const pick = shouldCommitTurn(residual, this.aimStableFor, this.turnPinnedFor, twist) ? pickTurn(residual, has) : null;
    if (pick) {
      this.turnPinnedFor = 0;
      const clip = this.content.locoClip([pick.name], this.weapon)!;
      this.turn = { clip, t: 0, startYaw: this.rootYaw, w: 1, out: false, hy0: hipsOffset(clipPoseAt(clip, 0), this.human.hipsRest.y)?.[1] ?? null, lift: null };
      return { rootYaw: this.rootYaw, residual: clampTw(residual), turning: true };
    }
    // Стоим ниже порога: таз держит курс, верх докручивается к прицелу скруткой.
    // ⭐ НО ЕСЛИ ТАЗ ЕЩЁ ЕХАЛ (встали посреди доворота) — он ДОТОРМАЖИВАЕТ тем же пределом, а не встаёт
    // насмерть: иначе передача таза приводу поворотов на месте сама по себе рывок. ЗАМЕР (сцена
    // `stop_face`): 13 369 °/с² на кадре передачи против 0 с доторможением. Тот же закон, что в
    // `stepTorsoLead`, и ровно он же копил `leadRate` до этого кадра.
    if (this.leadRate > 0 && this.turnAccelHold) {
      const rate = Math.max(0, this.leadRate - twist.turnRate / TURN_ACCEL_SEC * dt);
      if (rate > 0) this.rootYaw += Math.sign(residual) * Math.min(Math.abs(residual), rate * dt);
      return { rootYaw: this.rootYaw, residual: clampTw(wrapPi(this.aimYaw - this.rootYaw)), turning: false, rate };
    }
    return { rootYaw: this.rootYaw, residual: clampTw(residual), turning: false };
  }
  /**
   * Запустить удар. `windowSec` — окно атаки (attack-лок с сервера): клип ужимается, чтобы отыграть ЦЕЛИКОМ за
   * это окно (быстрее бьёшь — быстрее клип, но всегда до конечных кадров). Без метки медленнее авторского темпа
   * не растягиваем (min 1×) — прежнее поведение байт-в-байт.
   *
   * `windupSec` — вайндап с сервера (`swing.windupMs`): урон наносится РОВНО в конце вайндапа
   * (`session.stepWindup` → `executeBasicAttack`). Если в клипе размечен кадр `impact`, клип играется ДВУМЯ
   * отрезками, чтобы этот кадр пришёлся ровно на `windupSec`, а клип целиком уложился в `windowSec`.
   * ⚠ Пост-импактный отрезок обязан уметь РАСТЯГИВАТЬСЯ: контакт в мокапе обычно на ~60 % клипа, а вайндап
   * сервера — ~35 % окна, поэтому коридор скорости `[0.35, 8]`, а не `max(1, …)`.
   */
  triggerAttack(clip: Clip | null, windowSec = 0, windupSec = 0, st?: { priority: number; interruptible: boolean; blendSec: number; legs: 'auto' | 'never' | 'always' }): boolean {
    if (!clip) return false;
    // ⚠ СВИНГ, ПРИШЕДШИЙ СРАЗУ ПОСЛЕ АВТОСЦЕПКИ, НЕ ПЕРЕЗАПУСКАЕТ КЛИП. Пока атака зажата, работают ДВА
    // источника: наша сцепка по концу окна комбо и настоящий свинг сервера. Разнести их по времени нельзя
    // (темп атаки — серверный), а перезапуск на 0.1 с позже собственной сцепки читается как лишний рывок.
    // Поэтому свинг в этом окне только УТОЧНЯЕТ ТЕМП уже играющего удара — момент урона всё равно садится
    // на размеченный `impact`.
    if (this.atkAuto >= 0 && this.atkAuto < COMBO_REGRAB && this.atk.clip) {
      this.atkWindow = windowSec; this.atkWindup = windupSec;
      this.retime(this.atk.clip, this.atk.t, windowSec, windupSec);
      return false;                                 // ⚠ клип НЕ запускался — значит и удар из очереди не израсходован
    }
    // ЦЕПОЧКА (атака зажата): новый свинг пришёл, пока предыдущий ещё играет. Уходящий клип кроссфейдим,
    // а входящий стартуем с ЗАМАХА, минуя idle-вход — это Montage Sections из Unreal, только разметкой внутри
    // клипа, а не резкой клипов. idle-выход при этом играет только ПОСЛЕДНИЙ удар: у прерванных он не наступает.
    const chain = !!this.atk.clip && this.atk.t >= 0;
    // Уходящее состояние уносит с собой СВОЁ владение ногами, иначе на стыке низ дёрнется.
    this.fade = chain ? { atk: { clip: this.atk.clip, t: this.atk.t, legs: this.atk.legs }, w: 1, rate: this.atkRate(), fadeSec: st?.blendSec } : null;
    // ⚠ ПОРЯДОК ЗАПАСНЫХ ВАРИАНТОВ ВАЖЕН. `windup` — явная авторская точка «отсюда стартует второй и
    // следующие удары», она и главнее. Нет её — входим в НАЧАЛО ОКНА КОМБО: тогда зажатая атака живёт
    // ровно внутри размеченной границы и не выходит из неё ни входом, ни выходом.
    const start = chain ? (markSec(clip, 'windup') ?? comboWindow(clip)?.start ?? (clip.idleEnds ? clip.keys[1]?.t ?? 0 : 0)) : 0;
    this.atk.clip = clip; this.atk.t = start; this.atkPrevT = start;
    this.atk.legs = st?.legs; this.atk.prio = st?.priority ?? 0; this.atk.lock = st ? !st.interruptible : false;
    this.atkWindow = windowSec; this.atkWindup = windupSec; this.atkState = st; this.atkAuto = -1;
    this.retime(clip, start, windowSec, windupSec);
    return true;
  }
  /**
   * Пересчитать темп клипа от точки `start`: с меткой `impact` — двумя отрезками, чтобы контакт пришёлся
   * ровно на вайндап сервера. Вынесено из `triggerAttack`, потому что зовётся ещё и при ПЕРЕХВАТЕ
   * автосцепки (см. `COMBO_REGRAB`): там клип уже играет, и перезапускать его нельзя, а уточнить темп надо.
   */
  private retime(clip: Clip, start: number, windowSec: number, windupSec: number): void {
    this.warp = null;
    const dur = clipDur(clip);
    const imp = windupSec > 0 ? impactSec(clip) : null;
    if (imp !== null && dur > 0 && windupSec > 0 && imp > start && imp < dur) {
      const c = (v: number): number => Math.min(WARP_MAX, Math.max(WARP_MIN, v));
      const pre = c((imp - start) / windupSec);
      // Окна атаки нет (телеграф монстра шлёт только вайндап) → после импакта держим ТУ ЖЕ скорость:
      // момент удара всё равно попадает точно, а хвост доигрывается в авторском темпе, сжатом так же, как замах.
      this.warp = { impact: imp, pre, post: windowSec > windupSec ? c((dur - imp) / (windowSec - windupSec)) : pre };
      this.atkSpeed = pre;
    } else this.atkSpeed = windowSec > 0 && dur > 0 ? Math.max(1, (dur - start) / windowSec) : 1;
  }
  /** Скорость проигрывания удара в текущий момент: с меткой — свой множитель до и после импакта. */
  private atkRate(): number {
    const w = this.warp;
    return (w ? (this.atk.t < w.impact ? w.pre : w.post) : this.atkSpeed) * this.atkTempo;
  }
  get attacking(): boolean { return !!this.atk.clip; }
  /** Имя играющего клипа удара — окну слоёв и сторожам цепочки. null = удара нет. */
  get attackClipName(): string | null { return this.atk.clip?.name ?? null; }
  /** Время внутри клипа удара (сек). −1 = удара нет. */
  get attackTime(): number { return this.atk.t; }
  /** Затвор «ноги принадлежат клипу удара» — окну слоёв и сторожу дребезга. */
  get attackLegsHeld(): boolean { return this.legsHeld; }
  /** Вес авторской позы удара в кадре (огибающая attackEnv): 0 в покое, 1 на пике замаха. Для буста match-веса рендера —
   *  физика одна не доводит быстрый замах до конечных кадров, поэтому во время удара видимый меш сильнее тянем к позе-цели. */
  get attackWeight(): number { return this.atk.clip && this.atk.t >= 0 ? attackEnv(this.atk.t, clipDur(this.atk.clip) || 0.001) : 0; }
  /** Per-кадр физ-ключ удара (интерполированный по времени клипа), напр. '__match'/'__pinKp'. null = не авторено (фолбэк рантайма). */
  private atkPhys(key: string): number | null {
    if (!this.atk.clip || this.atk.t < 0) return null;
    const v = clipPoseAt(this.atk.clip, this.atk.t / (clipDur(this.atk.clip) || 1))[key];
    return v ? v[0] : null;
  }
  /** Авторский per-кадр вес совпадения удара (__match). null → рантайм берёт свою огибающую. */
  get attackMatch(): number | null { return this.atkPhys('__match'); }
  /** Авторская per-кадр жёсткость пинов удара (__pinKp). null → дефолт. */
  get attackPinKp(): number | null { return this.atkPhys('__pinKp'); }
  /** Видимый facing (радианы) = ПРИЦЕЛ (куда целится корпус/голова), не таз. */
  get facing(): number { return this.aimYaw; }
  /**
   * ⭐ КУРС, ПРИЛОЖЕННЫЙ К ТАЗУ, — для отладки/редактора И ДЛЯ ЗАПЕКАНИЯ.
   * Отдаём РЕАЛЬНО ПРИМЕНЁННЫЙ угол, вместе с доворотом: ровно его `pelvisToWorld` кладёт слева (`Ry(yaw)`), и ровно
   * его снимает `neutralizeFacing` при запекании клипа (обратной композицией, `pelvisPoseToChar`). Поле `rootYaw` живёт
   * без доворота по другой причине (обратная связь `stepTorsoLead`), и отдавать наружу его было бы ложью.
   *
   * ⚠ ЭТО НЕ МИРОВОЙ РЫСК ТАЗА В «ТОЛЬКО КЛИПЫ» + «ОТКРЫТ». Там раскрытие сидит в СОБСТВЕННОМ рыске клипа
   * (`clipHipsOpen`), который `pelvisToWorld` сохраняет, а не в курсе, — и прибавлять его сюда нельзя: запекателю
   * (`neutralizeFacing`, `assertWarp`) нужен именно приложенный курс, иначе раскрытие вычтется из клипа, в котором
   * оно и должно остаться. Мировой угол — `pelvisYawWorld`.
   */
  get pelvisYaw(): number { return this.rootYaw + this.dirWarp.warp; }
  /**
   * ⭐ МИРОВОЙ РЫСК ТАЗА этого кадра = курс + рыск таза из клипа. Читают те, кому нужен НАСТОЯЩИЙ разворот таза:
   * плант-сетка редактора (какая ячейка активна), читауты, пробы. ЗАМЕР: «только клипы» + «открыт», страйф вправо
   * 35° — `pelvisYaw` 0°, мир 35°, и ячейка сетки подсвечивалась на целое раскрытие мимо.
   */
  get pelvisYawWorld(): number { return this.pelvisYaw + this.hipsYawNow + this.clipHipsYaw + this.stanceYawNow + this.turnNow; }
  /** Рыск, который таз авторской стойки РЕАЛЬНО добавил в этом кадре (рад) — читаут редактора и замеров. */
  get stancePelvisYaw(): number { return this.stanceYawNow; }
  /** Вес таза авторской стойки в этом кадре (0..1) — та же величина, что стоит в `wS`. */
  get stancePelvisW(): number { return this.stanceWNow; }
  /** Пройденный путь тредмила (интеграл скорости) — редактору для скролла пола/оффсета маркеров. */
  /** ⭐ Фаза цикла клипа (рад, π на шаг) — ею клип и сэмплируется. Наружу нужна ЗАМЕРАМ: эталон паритета обязан
   *  браться на ТОЙ ЖЕ фазе, иначе мерка покажет расхождение там, где его нет (это сдвиг во времени). */
  get clipPhaseNow(): number { return this.clipPhase; }
  get posX(): number { return this.px; }
  get posZ(): number { return this.pz; }
  /** Сбросить путь тредмила в 0 (редактор: рестарт превью). */
  resetPos(): void { this.px = 0; this.pz = 0; }
  /** Вес совпадения рендера с позой на этом кадре (для физ-бленда атласа) — ЕДИНО с игрой. base = match персонажа. */
  matchWeight(base: number): number { return renderMatchWeight(base, this.attackWeight, this.attackMatch); }
  /** Позировать this.human: тредмил-ноги (idle↔гейт по скорости) + верх (idle-стойка + мах + удар).
   *  Кормим гейт РЕАЛЬНЫМ yaw — StepPlanner видит смену facing и делает подшаг при повороте на месте; узость ног
   *  держит ЧИСТАЯ скорость (p.vel), а не дёрганая Δpos (её джиттер в vLat = ложный страйф разводил ноги). */
  step(dt: number): void {
    if (this.atk.clip) {
      const clip = this.atk.clip;
      this.atkPrevT = this.atk.t;
      this.atk.t += dt * this.atkRate();
      // Метки ищем ПО ПРОЙДЕННОМУ ИНТЕРВАЛУ (на сжатом клипе кадр между вызовами проскакивает целиком),
      // а на первом кадре — включая саму ноль, иначе метка на t=0 не сработала бы никогда.
      if (this.onMark) for (const e of marksInRange(clip, this.atkPrevT > 0 ? this.atkPrevT : -1e-9, this.atk.t)) this.onMark(e);
      if (this.atkAuto >= 0) this.atkAuto += dt;
      // ⭐⭐ КОНЕЦ ОКНА КОМБО ПРИ ЗАЖАТОЙ АТАКЕ = НАЧАЛО СЛЕДУЮЩЕГО УДАРА. Это и есть branch point:
      // отпускаем — доигрывает хвост и уходит в стойку, держим — цепочка идёт дальше, а хвост не наступает.
      const cw = comboWindow(clip);
      if (cw && this.attackHold && this.atkPrevT < cw.end && this.atk.t >= cw.end) {
        const nxt = this.comboNext?.() ?? null;
        if (nxt) {
          this.triggerAttack(nxt, this.atkWindow, this.atkWindup, this.atkState);
          this.atkAuto = 0;                     // отметка: этот удар начат НАМИ, а не свингом сервера
        }
      }
      if (this.atk.clip && this.atk.t > clipDur(this.atk.clip)) { this.atk.clip = null; this.atk.t = -1; this.warp = null; this.atkAuto = -1; }
    }
    if (this.fade) {                                   // уходящий удар доигрывает и гаснет
      this.fade.atk.t += dt * this.fade.rate;
      this.fade.w -= dt / Math.max(0.01, this.fade.fadeSec ?? XFADE_SEC);   // длительность входа задаёт СОСТОЯНИЕ
      if (this.fade.w <= 0) this.fade = null;
    }
    const cstep = dt / Math.max(0.01, GAIT.combatBlend);   // кроссфейд боевой стойки (линейно за combatBlend сек)
    this.combat += clamp(this.combatTarget - this.combat, -cstep, cstep);
    // ⭐⭐ «ТОЛЬКО КЛИПЫ»: доля клипа ровно 1 и контенту есть откуда брать клипы. Решается ПЕРВЫМ — от него зависит,
    // трогаем ли планировщик на этом кадре вообще: в этом режиме ему не уходит НИ ОДИН вызов, даже сеттер
    // (и если режим включён с первого кадра, планировщик так и не создаётся — `PoseDriver.setWorld` его не позовёт).
    // ⚠⚠ ЗДЕСЬ СТОЯЛО `&& this.hasLocoSet()` — ПОСЛЕДНЯЯ ЖИВАЯ ТОЧКА ВХОДА ПЛАНИРОВЩИКА В ИГРУ, и срабатывала
    // она МОЛЧА: нет запечённого `run_fwd` — вся кукла уезжает на процедурную походку, причём достижимо это
    // сменой оружия прямо в бою (ключ кэша — оружие). Убрана вместе с самой проверкой.
    //
    // ⚠ ЧЕМ ЗАМЕНЕНА, А НЕ «ПРОСТО УБРАНА». Наивное снятие даёт не «столб», а куклу, ВОЛОЧАЩУЮ НОГИ:
    // без клипа `clipContact` навсегда [true, true], `lockW` на ходу равен 1, замок не снимается — и
    // `warpStanceFeet` прибивает ОБЕ стопы к точке первого кадра, пока персонаж от неё уезжает. Поэтому
    // условие не исчезло, а переехало ТУДА, ГДЕ ОНО ЧЕСТНОЕ: фиксация стоп требует РЕАЛЬНОГО клипа этого
    // кадра (`clipLoco` ниже), а не «набор где-то есть». Руки чинить не пришлось — аддитивный шов при
    // `locoPose = null` сам отдаёт авторскую стойку (дельта маха вырождается в единицу).
    const clipOnly = clamp(locoMixOverride ?? GAIT.locoMix, 0, 1) >= CLIP_ONLY_MIX;
    // ⚠ Первый кадр куклы: режим ещё НЕ ИЗВЕСТЕН (`null`), а не «был процедурным». Иначе каждая кукла
    // начинала жизнь со снимка позы, оставленной `measureStance` в конструкторе, и 0.25 с перетекала из неё —
    // плюс аллокация карты кватернионов ВСЕХ костей ровно там, где кадр куклы не должен аллоцировать.
    if (this.clipOnlyNow !== null && clipOnly !== this.clipOnlyNow) {
      this.footLock = [null, null]; this.clipContact = [true, true];
      // Поза прошлого кадра ещё на гуманоиде — её и запоминаем, из неё новый режим и перетечёт.
      const rot = new Map<string, THREE.Quaternion>();
      for (const [nm, b] of this.human.bones) rot.set(nm, b.quaternion.clone());
      this.modeSnap = { rot, hips: this.human.bones.get('Hips')!.position.clone() };
      this.modeBlend = 1;
      // Назад к планировщику: его планты остались там, где он их бросил (за метры отсюда), — ставим стопы заново.
      // ⚠ НЕ `replantPlanner()`: тот смотрит на `clipOnlyNow`, а здесь он ещё СТАРЫЙ (true) — и реплант стал бы
      // no-op ровно в кадр возврата к планировщику, оставив планты там, где он их бросил — за метры отсюда.
      if (!clipOnly) this.plannerReplant();
    }
    // ⚠ ГРОМКО О МОЛЧАЛИВОЙ ЛОВУШКЕ: у базы швы планировщика — пустышки, и процедурная ветка
    // даст замершие ноги без единой ошибки. В игре сюда не попасть (доля всегда 1).
    if (!clipOnly && !this.hasPlanner) warnNoPlanner();
    this.clipOnlyNow = clipOnly;
    // Доля таза стойки поменялась (ползунок редактора / перекрытие запекания) → планты сняты под другим тазом (см. `stanceKnob`).
    const knobStale = this.stanceKnob !== stancePelvisKnob();
    if (!clipOnly) {
      this.plannerCombat(this.combat);   // боевая колонка настроек (Ф6) — тот же плавный combat, что блендит стойку
      // ⭐ …и СТОЙКА ПЛАНИРОВЩИКА следует за той же осью: иначе поворот на месте в бою поднимал бы таз
      // на релакс-высоту (см. `measureStance`). Порог 0.02 — чтобы не мерить каждый кадр кроссфейда:
      // замер зовёт `human.reset()`, а поза всё равно собирается заново в `gaitToHumanoid`.
      if (knobStale || Math.abs(this.combat - this.stanceCombat) > 0.02) this.measureStance();
    } else if (knobStale || Math.abs(this.combat - this.clipStanceCombat) > 0.02) this.measureStance();   // высота таза стоя — та же ось (см. `clipStandY`)
    const vx = this.vx, vz = this.vz, spd = Math.hypot(vx, vz);
    this.moveMag = clamp(spd / GAIT.speedWalk, 0, 1);
    const twist = blendTwist(this.twistStates, spd);   // скрутка корпуса по состоянию (стой/ходьба/бег), плавно по скорости
    // Torso-lead: таз (rootYaw) догоняет прицел (aimYaw) с задержкой (голова/плечи ведут). rootYaw кормит и StepPlanner,
    // и Hips → приставной шаг случается ровно когда таз доворачивает. Остаток `tw` размажем по позвоночнику после позинга.
    // Таз догоняет прицел (одна система стоя и на бегу): голова ведёт, таз держится в зоне и плавно доворачивает.
    // relaxTime: прицел стабилен долго и есть скрутка → таз доворачивается к нейтрали (не держим лид вечно).
    // «Прицел стоит»: скорость мерится по интервалу МЕЖДУ ИЗМЕНЕНИЯМИ ПРИЦЕЛА, а не по кадру (см. `AIM_STILL_RATE`).
    const dAim = Math.abs(wrapPi(this.aimYaw - this.prevAim));
    this.aimGap = Math.min(this.aimGap + dt, AIM_GAP_MAX);
    const aimNow = dAim > 0 ? dAim / this.aimGap : 0;       // по интервалу СОБЫТИЯ, а не кадра
    if (dAim > 0) this.aimGap = 0;
    this.aimRate += (dAim / dt - this.aimRate) * (1 - Math.exp(-dt / AIM_RATE_TAU));   // средняя за окно
    // «Едет» — только если ОБЕ мерки согласны (см. `AIM_STILL_RATE`).
    this.aimStableFor = aimNow >= AIM_STILL_RATE && this.aimRate >= AIM_STILL_RATE ? 0 : this.aimStableFor + dt;
    this.prevAim = this.aimYaw;
    const turnWas = this.turn, turnT0 = this.turn?.t ?? 0;   // поворот ДО шага: по пройденному отрезку ищем его метки
    // ⭐⭐ РАЗГОН ТАЗА ВЗВОДИТСЯ ХОДЬБОЙ, А СНИМАЕТСЯ ОСТАНОВКОЙ ТАЗА (см. `TURN_ACCEL_SEC`). Снимать его
    // по скорости ног нельзя: она падает в ноль ЗА ОДИН ТИК, и предел приращения исчезал посреди доворота.
    // Пока таз ещё едет (`leadRate > 0`), закон не меняется; когда встал — оба закона дают одно и то же,
    // и переключение бесплатно. Запекание (скорость ровно 0 с первого кадра) сюда не попадает никогда.
    if (spd > MOVE_EPS_WARP) this.turnAccelHold = true;
    else if (this.leadRate <= 0) this.turnAccelHold = false;
    const tl = this.stepTurn(dt, twist) ?? stepTorsoLead(this.rootYaw, this.aimYaw, twist, dt, this.turning,
      this.aimStableFor > twist.relaxTime, this.leadRate, this.turnAccelHold ? TURN_ACCEL_SEC : 0);
    // ⚠ ВЕТКА КЛИПА ПОВОРОТА СВОЕЙ СКОРОСТИ НЕ ИМЕЕТ: таз там ведёт клип, а не сервопривод. Разгон начинается
    // заново, когда таз снова отдан `stepTorsoLead` — иначе после поворота он дёрнулся бы с чужой скоростью.
    this.leadRate = (tl as { rate?: number }).rate ?? 0;
    // ⚠ КОПИМ БЕЗ ДОВОРОТА. `stepTorsoLead` получает свой прошлый результат как вход; запиши сюда
    // доворот — и он на следующем кадре станет базой для нового доворота, то есть закрутится сам.
    this.rootYaw = tl.rootYaw; this.turning = tl.turning;
    // ⭐ СЕКТОРА ДОВОРОТА — только на СВЕЖИХ страйфах, если клипы хода в деле. Старый страйф (ноги под ±126° к
    // тазу, скрутка ±40° впечена) на секторах играет хуже, чем со старой складкой: там его целиком ставит чистый
    // бок. Пока набор не перезапечён — прежнее поведение, редактор при этом просит «перезапеки».
    const clipsInUse = clamp(locoMixOverride ?? GAIT.locoMix, 0, 1) > 0.001 && !!this.content.locoClip;
    this.warpSectorsNow = !clipsInUse || this.strafeClipsFresh();
    if (dirWarpOverride !== null) this.dirWarp = { ...DIR_WARP0, warp: dirWarpOverride };   // съём: доворот ровно заданный
    else this.dirWarp = stepDirWarp(this.dirWarp, tl.rootYaw, this.aimYaw, vx, vz, twist.maxTwist, dt,
      { on: GAIT.warpOn, maxDeg: GAIT.warpMax, smooth: GAIT.warpSmooth, sectors: this.warpSectorsNow, rateDeg: GAIT.warpRate });
    const warp = this.dirWarp.warp;
    /**
     * ⭐⭐ КУРС ТАЗА = КОРЕНЬ + ДОВОРОТ, И БОЛЬШЕ НИЧЕГО.
     *
     * ⚠ СЮДА НЕЛЬЗЯ КЛАСТЬ АВТОРСКИЙ ПОВОРОТ ТАЗА (`POSE.hipsTurn`). Сутки (19.09) он тут лежал — и это ровно
     * три жалобы автора: ячейка плант-сетки ищется по ходу В ЭТОМ курсе, вынос ноги раскладывается по ЕГО осям,
     * и повёрнутый таз уводил и ячейку (вес авторской 1.0000 → 0.2222 при 35°), и сам шаг (плант уезжал от хода
     * ровно на угол ручки). Теперь поворот — ТОЛЬКО КОСТЬ (`PoseTargets.hipsYaw`), и в курс он не приходит
     * ни одним путём; гашение долей клипа ему тоже не нужно — процедурный рыск кости и так делится на `1 − mix`
     * ниже, ровно как качание.
     */
    // Таз уезжает к ходу, верх на столько же отворачивается обратно — прицел остаётся на месте.
    // Подрезка — страховка на ПЕРЕХОДЕ: доворот сглаживается за `warpSmooth`, и если прицел за это
    // время улетел, сумма успевает вылезти за предел. Шею не выворачиваем ни на кадр.
    const yaw = tl.rootYaw + warp;
    let tw = clamp(tl.residual - warp, -twist.maxTwist, twist.maxTwist);
    this.px += vx * dt; this.pz += vz * dt;
    // ⚠ ОДИН ПОЛ НА ПЛАНИРОВЩИК, ЗАЗЕМЛЕНИЕ И СТОЙКУ — И БЕРЁТСЯ ОН ИЗ РИГА (`ankleRest`).
    //
    // Было `FOOT_Y + footLift`: константа процедурного манекена плюс сохранённое число. Оба НЕ едут
    // за морфом. ЗАМЕР в живом редакторе: рост 1.16 поднял таз 35.05 → 40.66 и всю цепь ноги, лодыжка
    // рига встала на 3.355, а `FOOT_Y + footLift` остался 2.900 — персонаж уезжал в пол на 0.455.
    // `ankleRest` считается по САМОМУ ригу, поэтому следует и за моделью, и за телосложением.
    const fwdC = vx * Math.sin(yaw) + vz * Math.cos(yaw), latC = vx * Math.cos(yaw) - vz * Math.sin(yaw);
    if (!clipOnly) {
      this.plannerFeed(yaw, vx, vz, spd, fwdC, latC);
    }
    // Вес гейта в ногах: идём/подшагиваем (разворот на месте) → ноги ведёт планировщик, иначе — поза idle-стойки.
    // Без этого при стоянии ноги целиком из idle: подшаг НЕ виден, а фидбэк setFeet отдаёт планировщику чужие стопы.
    // ⚠ `stepping` МЕРЦАЕТ (settled щёлкает по гистерезису) → держим ещё STEP_HOLD после конца подшага, иначе ноги
    // мигают idle↔гейт = тик при развороте на месте.
    if (!clipOnly && this.plannerStepping) this.stepHold = STEP_HOLD; else this.stepHold = Math.max(0, this.stepHold - dt);
    const want = clipOnly ? 0 : this.stepHold > 0 ? 1 : this.moveMag;   // «только клипы»: процедурных ног нет вовсе
    // Асимметрия скорости: ВХОД в гейт (шаг) — резво (отзывчивый подшаг); ВЫХОД в idle (конец поворота) — мягче, иначе поза
    // «оседает» рывком при остановке (ноги морфятся гейт→idle-стойка плавно). Резкое переключение idle↔гейт дребезжит.
    this.legMag += (want - this.legMag) * Math.min(1, dt * (want >= this.legMag ? 6 : 3.5));
    this.human.root.updateMatrixWorld(true);
    // НОГИ У СЛОТА ДЕЙСТВИЯ? Стоячий удар авторит подшаг, и пока он играет, стопы ведёт клип.
    // Тогда фидбэк отключается: иначе планировщик увидит уехавшую стопу, решит, что она «не дома»,
    // и погонится за ней — то есть подерётся с клипом за ту же ногу.
    // ⭐⭐ ПРАВИЛО ВЛАДЕНИЯ НОГАМИ (см. `STILL_ON`): стоим и не крутимся — ноги у клипа удара;
    // идём, крутимся или несём стопу — у планировщика.
    // ⚠ Гистерезис на «стоим» обязателен: скорость шумит (снапшоты реже кадров), и один порог
    // дребезжал — ЗАМЕР давал 107–119 переключений за пару секунд.
    this.still = this.still ? this.moveMag < STILL_OFF : this.moveMag < STILL_ON;
    const sw = clipOnly ? [!this.clipContact[0], !this.clipContact[1]] : this.plannerSwing();
    const busy = !this.still || this.turning || sw[0] || sw[1];
    const legsHeld = !!this.atk.clip && this.atk.t >= 0
      && (this.atk.legs === 'always' || (this.atk.legs !== 'never' && !busy));
    this.legsHeld = legsHeld;
    // ⚠ АВТОРИТЕТ ОТДАЁМ МГНОВЕННО, А ПОЗУ ГАСИМ ПЛАВНО. Планировщик должен получить ногу в тот же
    // кадр, когда пошёл поворот (иначе подшаг опоздает), а вот поза ног обязана перетечь — иначе
    // на каждом входе-выходе был бы щелчок.
    this.atkLegsW += ((legsHeld ? 1 : 0) - this.atkLegsW) * Math.min(1, dt / LEGS_FADE);
    const turnLegs = this.turnMode;                               // поворот клипами (идёт или ждём решения): планировщик шагов не начинает
    // ⚠ Фидбэк стоп даётся ТОЛЬКО когда ноги ведёт гейт (иначе шпагат) — условие считается ЗДЕСЬ,
    // чтобы шов не лез в состояние базы, а база не знала про планировщик.
    if (!clipOnly) this.plannerLegs(legsHeld || turnLegs, this.legMag > 0.5 && !legsHeld && !turnLegs);
    this.idleT += dt;
    // ⚠ В «только клипы» планировщик НЕ ОБНОВЛЯЕТСЯ: цели нейтральные, а ось ходьба↔бег — ВЕС БЕГА КЛИПОВ по скорости.
    // ⭐ Было `(v − speedWalk) / (speedRun − speedWalk)` — ось планировщика 40…115, а клипы сняты на 50.4 / 102: свой
    // темп клип получал только ВНЕ своей скорости (замер: цикл на 50.4 длиннее планировщика на 6.2 %, на 102 короче
    // на 5.9 %), а на игровых 80 u/с бег весил 53 % и целиком не был виден никогда. Решение автора: набор 40 / 120,
    // бег на 100 % с 80 (`locoRunWeight`). Планировщиковую ось не трогаем — вне «только клипы» всё как было.
    const tg = clipOnly ? CLIP_ONLY_TG() : this.plannerUpdate(dt);
    // ⚠ ТАЗ СТОЯ — НА ВЫСОТЕ СТОЙКИ, а не на базе 30 из `gaitToHumanoid` (см. `clipStandY`): иначе клип поворота и клип
    // хода, кладущие таз на `hipsRest.y + __hipsD`, дёргали его вверх на входе и вниз на выходе.
    if (clipOnly) { tg.sb = locoRunWeight(spd); tg.bobY = this.clipStandY - 30; }
    // ── ПОЛЗУНОК «ПРОЦЕДУРНО ↔ КЛИП» (Ф4) ──
    // Клипы БЛЕНДЯТСЯ по тем же осям, что и колонки настроек (`sb`/`st`/`bt`), и сэмплируются ОДНОЙ
    // фазой планировщика: у клипа нет своего таймера, иначе настройки персонажа перестали бы на него
    // влиять, а разные клипы разъехались бы ногами на бленде (это и есть Sync Group из индустрии).
    //
    // ⚠ ДОЛЯ КЛИПА ЕДЕТ ПЛАВНО (`locoW`), а не скачком: галка в настройках и смена конфига куклы
    // меняют цель мгновенно, и без разгона переключение само было бы рывком.
    const mixTarget = clamp(locoMixOverride ?? GAIT.locoMix, 0, 1) * clamp(this.moveMag / LOCO_MOVE_FULL, 0, 1);   // ⚠ ворота по движению — см. LOCO_MOVE_FULL
    this.locoW += clamp(mixTarget - this.locoW, -dt / LOCO_FADE, dt / LOCO_FADE);
    const mix = this.locoW;
    let locoPose: Pose | null = null;
    let locoRef: Pose | null = null;   // нейтраль маха смеси (см. `armBlend.swingRefOf`)
    let leadSwing: [number, number, number] | undefined;   // опора ВЕДУЩЕГО клипа (бинарный канал смешивать нельзя)
    let leadNow: LeadMark | null = null;   // ведущий клип бега в «только клипы» — с него звучат метки (см. `emitSteps`)
    let clipDuty = -1;                     // доля опоры смеси клипов (см. окна опоры ниже); −1 — не считалась
    if (mix > 0.001 && this.content.locoClip) {
      // ⚠ НАПРАВЛЕНИЕ — ГЕОМЕТРИЯ, А НЕ СТИЛЬ (`locoDirWeights`): `st`/`bt` планировщика — пороги его
      // колонок настроек (0 до 45°), и клип под ними отыгрывал чистый бег вперёд, пока тело ехало вбок.
      // `fwdC`/`latC` уже в осях ДОВЁРНУТОГО таза — доворот снимает сколько может, бленд досыпает остаток.
      // Ось ходьба↔бег остаётся общей с планировщиком: это скорость, у неё мёртвой зоны нет.
      const dir = locoDirWeights(fwdC, latC);
      const axes = { sb: tg.sb ?? 0, st: dir.st, bt: dir.bt };
      // ⚠⚠ ИМЯ ЧЕСТНОЕ, А НЕ «ВПРАВО». `latC ≥ 0` — ход вдоль ЛОКАЛЬНОГО +X, а +X — это сторона костей
      // `Left*`, то есть СВОЯ ЛЕВАЯ сторона персонажа (модель смотрит в +Z; правая тройка Three). Клип и карта
      // настроек, которые здесь выбираются, исторически названы `strafe_R`/`STRAFE_R` — имена зеркальны анатомии
      // и НЕ переименовываются (опубликованные данные). Полная таблица — «ТАБЛИЦА ИСТИНЫ «СТОРОНА»» в `pose.ts`.
      const latPlusX = latC >= 0;
      // ⭐ КРОССФЕЙД ПРИ ДИСКРЕТНОЙ СМЕНЕ КОЛОНКИ. Сторона страйфа и вперёд↔назад выбираются дискретно; на
      // непрерывном повороте хода вес колонки в точке смены нулевой, и подмены не видно. Но инерции хода нет
      // (`moveInertia` выключена), и мгновенный разворот (R90→L90, 0→180) менял клип за кадр: ЗАМЕР (критика O2)
      // скачок ноги 90° за кадр. Поэтому уходящая колонка доигрывает `COL_FADE` той же фазой (Sync Group) и гаснет.
      {
        const pc = this.colPrev;
        const sideFlip = pc.has && pc.latPlusX !== latPlusX && pc.axes.st * (1 - pc.axes.bt) > 0.05;
        const jump = pc.has && Math.abs(axes.st - pc.axes.st) + Math.abs(axes.bt - pc.axes.bt) > COL_JUMP;
        if (sideFlip || jump) {
          const f = this.colFade;
          f.axes.sb = pc.axes.sb; f.axes.st = pc.axes.st; f.axes.bt = pc.axes.bt; f.latPlusX = pc.latPlusX; f.w = 1;
        }
        pc.axes.sb = axes.sb; pc.axes.st = axes.st; pc.axes.bt = axes.bt; pc.latPlusX = latPlusX; pc.has = true;
      }
      const clipOf = (dir: LocoDir, fast: boolean): Clip | null =>
        this.content.locoClip!(locoClipNames(dir, fast), this.weapon);
      const sd: LocoDir = latPlusX ? 'strafe_R' : 'strafe_L';   // ⚠ `strafe_R` = ход в +X = в СВОЮ ЛЕВУЮ (см. выше)
      this.clipYawMeta = false;
      const domDir: LocoDir = axes.bt > axes.st ? 'back' : axes.st > 0.5 ? sd : 'fwd';
      const lead = clipOf(domDir, axes.sb > 0.5) ?? clipOf(domDir, axes.sb <= 0.5);
      // ЧАСЫ: у планировщика — его фаза; в «только клипы» — фаза по ПРОЙДЕННОМУ ПУТИ. Длина цикла = скорость, на
      // которой клип снят (`bakedLocoSpeed`: из клипа, у старых — по имени), × его период: столько пути проходит тело за
      // один цикл клипа. Смесь колонок — весами бленда. ⭐ Поэтому на 80 u/с бег, снятый на 120, играет с циклом
      // 120 × период, то есть в темпе 80/120 — медленнее, но стопа стоит: путь за цикл совпадает с шагом клипа.
      if (clipOnly) {
        // Величина клипа, смешанная ТЕМИ ЖЕ весами, что и поза: ходьба↔бег по `sb`, колонки по `st`/`bt`. Колонки без
        // клипов в смесь не входят (их вес не должен тянуть число к нулю); не нашлось ни одной — `null`.
        // Клипы колонок ищутся ОДИН раз на кадр: поиск идёт по библиотеке, а смесей две (цикл и доля опоры).
        const cols: readonly (readonly [Clip | null, Clip | null, number])[] = [
          [clipOf('fwd', false), clipOf('fwd', true), (1 - axes.st) * (1 - axes.bt)],
          [clipOf(sd, false), clipOf(sd, true), axes.st * (1 - axes.bt)],
          [clipOf('back', false), clipOf('back', true), axes.bt],
        ];
        const mixed = (of: (c: Clip) => number): number | null => {
          let sum = 0, sumW = 0;
          for (const [w, r, k] of cols) {
            if (!w && !r) continue;
            sum += (w && r ? of(w) + (of(r) - of(w)) * axes.sb : of((w ?? r)!)) * k; sumW += k;
          }
          return sumW > 1e-6 ? sum / sumW : null;
        };
        const cycle = mixed((c) => bakedLocoSpeed(c) * (clipDur(c) || 1)) ?? 0;
        if (cycle > 1e-3) this.clipPhase += (2 * Math.PI) * spd * dt / cycle;
        // ⭐ ДОЛЯ ОПОРЫ — ТА, С КОТОРОЙ КЛИП СНЯТ: ось планировщика на СКОРОСТИ ЗАПЕКАНИЯ клипа, а не на текущей скорости.
        // Чистый набор (40 / 120 при speedWalk ≥ 40, speedRun ≤ 120) даёт ровно dutyWalk / dutyRun, и смесь равна
        // `lerp(dutyWalk, dutyRun, вес бега)`. Старый клип (50.4 / 102) — свою смесь 0.139 / 0.827.
        // ⚠ Было `lerp(dutyWalk, dutyRun, sb планировщика на ТЕКУЩЕЙ скорости)` — верно, пока вес клипов был той же осью.
        // С весом 40…80 это окно уже не про позу на экране. ЗАМЕР (манекен, вперёд, 80 u/с; «по текущей скорости» против
        // этой формулы; уход стопы за окно опоры БЕЗ фиксации, u / скольжение прижатой стопы С фиксацией, u/с):
        // чистый набор 2.94 / 0.10 → 1.22 / 0; старый набор 3.36 / 0.06 → 2.13 / 0 (боком 4.02 / 0.12 → 2.53 / 0.01).
        // Голый `lerp(dutyWalk, dutyRun, вес бега)` на СТАРОМ наборе боком на 80–102 недодаёт опоры (0.2 против 0.224
        // снятой), и стопа едет у пола вне окна 0.14–0.19 u/с; эта формула — 0. На чистом наборе они совпадают бит в бит.
        const plannerSb = (v: number): number => clamp((v - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
        // ⚠ ДОЛЯ ОПОРЫ КОЛОНКИ «НАЗАД» СЮДА НЕ БЕРЁТСЯ, хотя планировщик снимал клип «назад» с ней (у воина 0.64 / 0.34
        // против основных 0.52 / 0.29). ЗАМЕР (рыцарь, чистый набор, 135–180° @40/80/120): окна по доле колонки дают
        // скольжение опорной стопы 10.4–13.7 % против 6.3–10.1 %, пик фиксации 7–23 u/с против 0–13 и скачок ноги
        // 34–41° против 24–30°. Флаг опоры планировщика — не «стопа стоит»: при крошечном подъёме назад он держит ногу
        // «опорной», когда клип уже несёт её, и фиксация тянет стопу, а на отпускании бьёт.
        clipDuty = mixed((c) => lerpN(GAIT.dutyWalk, GAIT.dutyRun, plannerSb(bakedLocoSpeed(c)))) ?? lerpN(GAIT.dutyWalk, GAIT.dutyRun, axes.sb);
      }
      let u = locoPhaseU(clipOnly ? this.clipPhase : this.plannerPhase);
      if (lead && lead.keys.length) {
        const dur = clipDur(lead) || 1;
        const sc = clipSections(lead);
        const phaseU = u;
        this.locoSec = stepLocoSection(this.locoSec, this.moveMag > 0.05, dt, { ...sc, dur });
        u = sectionClipTime(this.locoSec, u, sc, dur) / dur;
        if (clipOnly) leadNow = { clip: lead, t: u * dur, phaseU, section: this.locoSec.section, loopStart: sc.loopStart, loopEnd: sc.loopEnd };
      }
      // ⚠ ОДНО НОРМАЛИЗОВАННОЕ ВРЕМЯ НА ВСЕ КЛИПЫ — это и есть синхронизация фаз: у клипов разная
      // длительность, и блендить их по СЕКУНДАМ значило бы смешивать «левая нога на земле» с «правая».
      const pickPose = (dir: LocoDir, fast: boolean): Pose | null => {
        const c = clipOf(dir, fast);
        if (!c || !c.keys.length) return null;
        const p = clipPoseAt(c, u);
        // ⭐ ЗАПЕЧЁННЫЙ ПОВОРОТ ТАЗА: встречный отворот снимаем ДО смешивания со стойкой — его кладёт `applyTorsoTwist`
        // рантаймовыми весами (см. `unbakeYawCounter`). Угол — ПОКАДРОВЫЙ курс таза самого клипа: с качанием рыска он
        // за цикл меняется. Метки `hipsYawW` нет (клип импортный или снят до 19.09) — трогать нечего, как было.
        if (!c.hipsYawW) return p;
        const a = poseHipsYaw(p);
        this.clipYawMeta = true;
        return a ? unbakeYawCounter(p, a, c.hipsYawW) : p;
      };
      locoPose = blendLocoPose(pickPose, axes, latPlusX, blendTwo);
      // ⭐ НЕЙТРАЛЬ МАХА — ТЕМ ЖЕ БЛЕНДОМ И ТЕМИ ЖЕ ВЕСАМИ, что и поза: смешай её иначе — и `Δswing = ref⁻¹·клип`
      // перестанет быть дельтой К СВОЕЙ опоре, то есть на бленде колонок рука поедет. Один вызов на кадр.
      locoRef = blendLocoPose((dir, fast) => { const c = clipOf(dir, fast); return c && c.keys.length ? swingRefOf(c) : null; },
        axes, latPlusX, blendTwo);
      // ⭐⭐ КАНАЛ ОПОРЫ БЕРЁТСЯ С ВЕДУЩЕГО КЛИПА, А НЕ ИЗ СМЕСИ. `__swing` — БИНАРНЫЙ флаг («нога в воздухе»), и
      // бленд колонок размазывает его в дробь: порог 0.5 тогда срабатывает не там, где у самих клипов. ЗАМЕР на
      // диагонали 60°: скольжение опорной стопы 10.4 % из смеси против 4.8 % у прямого хода. Ровно так же решает
      // Blend Space в Unreal (режим «Highest Weighted Animation»), и ровно так же у нас уже берутся МЕТКИ ШАГОВ.
      if (lead) { const lp = clipPoseAt(lead, u)[SWING_KEY]; if (lp) leadSwing = [lp[0], lp[1], lp[2]]; }
      if (this.colFade.w > 0 && locoPose) {
        const f = this.colFade;
        // ⚠ УХОДЯЩАЯ КОЛОНКА ДОИГРЫВАЕТ СО СВОИМ ВЕСОМ БЕГА, а не с нынешним `axes.sb`. Инерции хода нет: остановка
        // роняет скорость в ноль за кадр, вес бега — тоже, и страйф/назад догорал бы как ХОДЬБА. ЗАМЕР (манекен,
        // «только клипы», 120 u/с вбок → стоп): с `sb` нынешним таз 35.0 → 8.1 → 6.0° (26.9°/кадр) и скачок ноги
        // 32.2° (на ходу 13.8°); со своим — 28.1 → 20.8 → 13.2° (7.6°/кадр) и 11.6°. В «ровно» скачок ноги 27.1 → 15.2°.
        const old = blendLocoPose(pickPose, f.axes, f.latPlusX, blendTwo);
        if (old) locoPose = blendTwo(locoPose, old, f.w * f.w * (3 - 2 * f.w));   // smoothstep: без излома на входе и выходе
        f.w = Math.max(0, f.w - dt / COL_FADE);
      }
      // ⭐ РЫСК ТАЗА ИЗ КЛИПА (запечён от прицельного корня) — СКЛАДЫВАЕТСЯ с курсом в `applyTorsoTwist`, а не
      // затирается им. ИЗМЕРЯЕТСЯ по смешанной позе (`poseHipsYaw`), а не читается из слота Y, и только когда в
      // смеси ЕСТЬ клип с меткой `hipsYawW`: рыск импортного/старого клипа затирается курсом, ровно как было.
      this.clipHipsYaw = this.clipYawMeta && locoPose ? poseHipsYaw(locoPose) * mix : 0;
      // ⚠ Ветка «клипов в позе нет» (доля ≤ 0.001 — стоим или процедурка): колонки нет, старт в любую сторону
      // вырастает из стойки, и рыск клипа с прошлого кадра тащить некуда.
    } else { this.colPrev.has = false; this.colFade.w = 0; this.clipHipsYaw = 0; this.clipYawMeta = false; }
    // ОПОРНЫЕ СТОПЫ В «ТОЛЬКО КЛИПЫ»: из канала `__swing` клипа, а если его нет (клип запечён до канала) — окна
    // опоры по фазе с долей опоры, с которой клипы сняты (`clipDuty` выше): клипы сняты по фазе планировщика, так что
    // для запечённых это та же разметка. Стоим — обе на полу.
    if (clipOnly) {
      // ⭐⭐ ЕСТЬ ЛИ КЛИП В ЭТОМ КАДРЕ. От этого зависит фиксация стоп ниже: без клипа она прибивает
      // ОБЕ стопы к точке первого кадра, пока персонаж от неё уезжает (`clipContact` навсегда [true,true],
      // `lockW` на ходу = 1, замок не снимается) — то есть кукла не «стоит столбом», а ВОЛОЧИТ НОГИ.
      this.clipLoco = mix > 0.001 && !!locoPose;
      // Предупреждаем только тогда, когда клип ДОЛЖЕН был быть: идём (доля выросла), а позы нет.
      if (mix > 0.001 && !locoPose) warnNoLocoSet(this.content.charId ?? '', this.weapon);
      if (this.clipLoco && locoPose) {
        const s = leadSwing ?? locoPose[SWING_KEY];
        if (s) this.clipContact = [s[0] < 0.5, s[1] < 0.5];
        else {
          const duty = clipDuty >= 0 ? clipDuty : lerpN(GAIT.dutyWalk, GAIT.dutyRun, tg.sb ?? 0);
          const inStance = (i: number): boolean => Math.abs(wrapPi(this.clipPhase - i * Math.PI)) <= Math.PI * duty;
          this.clipContact = [inStance(0), inStance(1)];
        }
      } else this.clipContact = [true, true];
    }
    gaitToHumanoid(this.human, this.weaponGroups(), this.gx, this.legMag, tg, this.content, this.weapon, this.atk, this.moveMag, this.noIk, this.combat, this.fade, this.idleT, locoPose, mix, this.atkLegsW, clipOnly, locoRef);
    if (layerTrace.on) {
      layerTrace.speed = Math.hypot(this.vx, this.vz);
      layerTrace.sb = tg.sb ?? 0; layerTrace.st = tg.st ?? 0;
      layerTrace.moveMag = this.moveMag; layerTrace.legMag = this.legMag; layerTrace.combat = this.combat;
      layerTrace.twistGait = tg.twist; layerTrace.twistAim = tw;
    }
    // ПОВОРОТ НА МЕСТЕ: таз и ноги из клипа. ДО `applyTorsoTwist` — тот кладёт курс на таз клипа слева, а
    // курс на время поворота уже идёт по кривой клипа (`stepTurn`), так что они не спорят. Таз клипа (наклон, свой
    // рыск, `__hipsD`) остаётся в кадре персонажа — ровно так его показывает шарнир корня в редакторе.
    // Таз клипа — ПРИРАЩЕНИЕМ от его первого ключа (`hy0`) поверх высоты стоя `clipStandY + lift`, едущей за стойкой
    // (`clipStandY`: вход в бой посреди поворота).
    // ⭐ В «ТОЛЬКО КЛИПЫ» `lift` ЖИВОЙ: таз до клипа здесь — это стойка плюс ДОГАСАЮЩИЙ клип хода (`locoW` гаснет за
    // `LOCO_FADE`), и больше ничего, двойной просадки неоткуда взяться. ⚠ Запомненный на первом кадре, он замораживал
    // догасание на весь поворот: встал и сразу повернулся — клип стартует на f7 при `locoW` 0.53, и поворот шёл в
    // полуприседе, а в конце таз вставал. ЗАМЕР (рыцарь, опубликованный warrior, шли 40, встали и прицел в тот же кадр):
    // таз посреди поворота ниже стойки на 0.63 (+90) / 0.62 (180) → 0.07 / 0.06 — ровно как у поворота с места; подъём
    // после клипа 0.72 → 0.16 (свой конец клипа); наибольший шаг таза за кадр после клипа 0.120 → 0.026 (заземлённый
    // 0.143 → 0.094); прицел через 3 кадра — 0.080 → 0.026; с 80 u/с — 0.113 → 0.026. Повороты с места — бит в бит.
    // ⚠ В СМЕШАННОМ — запомненный на первом кадре, НЕ живой: планировщик с отобранными ногами сам проседает, пока таз
    // крутится (ЗАМЕР, рыцарь, −180°: 34.97 → 34.57), и клип ложился бы на эту просадку второй раз — размах таза 0.14 →
    // 0.59. ⚠ Гасить его к 0 за `LOCO_FADE` (так пробовали) — размен, а не выигрыш: встал и повернулся — подъём после
    // клипа 0.15–0.31 → 0.01–0.12 за кадр, зато цепочка поворотов в бою 0.063 → 0.094, телепорт после поворота 0.065 →
    // 0.218, размах поворота с места 0.21 → 0.29. Просадка там — самого планировщика после хода (встал с 80 без всякого
    // поворота — таз и через 3 с на 1.54 ниже стойки), и лечится она в планировщике, не здесь.
    if (this.turn) {
      const t = this.turn;
      const live = this.human.bones.get('Hips')!.position.y - this.clipStandY;
      if (clipOnly || t.lift === null) t.lift = live;
      blendClipBones(this.human, clipPoseAt(t.clip, Math.min(1, t.t / (clipDur(t.clip) || 1))), t.w, TURN_BONES,
        t.hy0 === null ? null : this.clipStandY + t.lift, t.hy0 ?? 0);
    }
    this.easeSeamHips(this.turn !== turnWas);   // клип сменился — таз продолжает с показанной позы (см. `seamW`); ноги — ниже
    // ⭐⭐ РЫСК ТАЗА, КОТОРЫЙ СИДИТ В КОСТИ, В КУРС НЕ ПРИБАВЛЯЕТСЯ — ОН УЖЕ В ТАЗЕ.
    // `pelvisToWorld` кладёт курс `Ry(yaw)` СЛЕВА и СОХРАНЯЕТ собственный рыск таза (см. `pelvisFrame.ts`), а клип
    // страйфа снят с вычетом только прицельного корня — поворот сидит прямо в его `Hips`. Прибавь его к курсу
    // ещё раз — посчитается ДВАЖДЫ: ЗАМЕР (рыцарь, клипы, 120 u/с вбок, 35°) — таз 70.0° вместо 35.0°, сторож
    // `hipsYaw.test.ts`. ⚠ До 17.09 (`Hips.rotation.y = rootYaw` затирал рыск клипа) складывать было ОБЯЗАТЕЛЬНО —
    // при возврате к той композиции эту строку надо менять вместе с ней.
    // В БЮДЖЕТ И В ОТВОРОТ он входит как обычно: верх обязан отвернуться и на него тоже, иначе грудь и оружие
    // уедут от прицела на весь угол.
    // ⭐ ДВА СЛАГАЕМЫХ, И ОБА ЗАМЕРЕНЫ: ПРОЦЕДУРНЫЙ рыск (`_hipsYawApplied`, его положил `gaitToHumanoid` — это
    // качание ПЛЮС статический поворот таза; клип разбавляет его своей долей, ровно как процедурную позу) и рыск,
    // пришедший ИЗ КЛИПОВ (`clipHipsYaw`, уже с `mix`).
    // ⚠ ГАШЕНИЕ ДОЛЕЙ КЛИПА ЗДЕСЬ ОДНО НА ВЕСЬ РЫСК — отдельного `1 − locoW` у поворота больше нет и быть не
    // должно: он гасил ДРУГИМ числом (`locoW` прошлого кадра против `mix` этого) и на середине бленда просаживал
    // ручку (ЗАМЕР 19.09: 35° → 30.8° при `locoMix` 0.5).
    this.hipsYawNow = tg.hipsYaw === 0 ? 0 : _hipsYawApplied.v * (1 - mix);
    // ⭐⭐ СТАТИЧЕСКИЙ ПОВОРОТ ТАЗА — третий источник рыска кости, и гаснет он ТЕМ ЖЕ `1 − mix`, что процедурная
    // поза: в смешанном режиме тот же угол уже запечён в клипе страйфа и приходит через `clipHipsYaw`.
    // ⚠ ГАСИМ ТЕМ ЖЕ `mix`, ЧТО И ПОЗУ, а не своим `1 − locoW` (доля ПРОШЛОГО кадра): на установившемся
    // бленде оба числа совпадают, но во время САМОГО перехода `locoW` отстаёт на кадр, и держать два разных
    // множителя на одно и то же гашение не за что. ЗАМЕР ручки 20° при `locoMix` 0 / .25 / .5 / .75 / 1:
    // 20.000 / 19.999 / 19.998 / 19.997 / 19.996 — ровная линия. Без гашения вовсе — двойной счёт (сторож).
    const wantTurn = clipOnly ? 0 : this.plannerHipsTurn * (1 - mix);
    const boneYaw = this.hipsYawNow + this.clipHipsYaw;
    // ⭐⭐ ТАЗ АВТОРСКОЙ СТОЙКИ — ЗДЕСЬ (после шва, до курса), см. `applyStancePelvis`. Его рыск идёт ТЕМ ЖЕ каналом,
    // что раскрытие `_open`: к курсу НЕ прибавляется (он уже в тазе, `pelvisToWorld` его сохраняет), но вычитается из
    // бюджета скрутки и уходит в отворот — грудь и оружие остаются на прицеле.
    const stanceYaw = this.applyStancePelvis(1 - this.legMag, 1 - mix);
    if (boneYaw || stanceYaw || wantTurn) tw = clamp(tl.residual - warp - boneYaw - stanceYaw - wantTurn, -twist.maxTwist, twist.maxTwist);
    applyTorsoTwist(this.human, yaw, tw, twist.weights, warp + boneYaw + stanceYaw + wantTurn);   // таз на курс + доворот; скрутка к прицелу, отворот — по Spine..UpperChest
    // ⭐⭐ ПОВОРОТ ТАЗА — ПОСЛЕДНИМ, И ИМЕННО ЗДЕСЬ. Он обязан лечь ПОСЛЕ `applyTorsoTwist` (тот крутит весь риг
    // курсом) и ПОСЛЕ того, как выше снят фидбэк фактических стоп: планировщик не должен увидеть повёрнутые ноги.
    // Угол ИЗМЕРЯЕТСЯ по кости (`pelvisHeading` до/после), а не берётся с ручки — протокол рыска, как у таза стойки.
    // Встречный отворот уже разложен по Spine..UpperChest строкой выше, поэтому грудь и оружие остаются на прицеле.
    if (wantTurn === 0) { this.turnNow = 0; this.turnFeet[0] = this.turnFeet[1] = this.turnFeet[2] = this.turnFeet[3] = 0; }
    else {
      const hb0 = this.human.bones.get('Hips')!;
      const before = pelvisHeading(hb0.quaternion);
      const d = applyHipsTurn(this.human, wantTurn);
      this.turnNow = wrapPi(pelvisHeading(hb0.quaternion) - before);
      this.turnFeet[0] = d[0]; this.turnFeet[1] = d[1]; this.turnFeet[2] = d[2]; this.turnFeet[3] = d[3];
    }
    // КАЧАНИЕ ТАЗА ВБОК — В КАДРЕ ТЕЛА, и именно ЗДЕСЬ, а не в `gaitToHumanoid`. `Hips.position` живёт в кадре
    // РОДИТЕЛЯ и рыском самой кости НЕ поворачивается — без доворота на `yaw` качание уехало бы в мировые оси
    // (та же грабля, что у переноса веса в `applyAttackPelvis`). Правая ось тела = (cos yaw, −sin yaw) — тот же
    // `Ry(yaw)`, которым `pelvisToWorld` крутит X/Z таза клипа выше: кадр у качания, клипа и удара один.
    if (tg.bobX !== 0) {
      const hb = this.human.bones.get('Hips')!;
      hb.position.x += tg.bobX * Math.cos(yaw); hb.position.z += -tg.bobX * Math.sin(yaw);
    }
    if (clipOnly) {
      // ⭐ ФИКСАЦИЯ СТОПЫ вместо подтяжки к плантам планировщика: где стопа коснулась пола — там и держим, пока
      // клип говорит «опора». Точка берётся в момент касания из самой позы, поэтому на касании рывка нет.
      // Тоже ПОСЛЕ `applyTorsoTwist` (он крутит весь риг). Мир ↔ риг — через позицию персонажа, как у плантов.
      // ⚠ ВЕС ФИКСАЦИИ СВОЙ, А НЕ ДОЛЯ КЛИПА. Доля на старте растёт четверть секунды, и опорная стопа, державшаяся
      // её долей, ехала за позой — замер старта с места в бег: 2.62 ед. Идём — держим целиком (точка берётся в
      // кадр, когда вес поднялся, поэтому рывка нет); встали — отпускаем за то же время, что гаснет клип.
      // На ОСТАНОВКЕ это всё равно скольжение: шагнуть в стойку нечем — нужен клип остановки, его пока нет.
      // ⚠⚠ И «КЛИПА НЕТ» ОТПУСКАЕТ ТАК ЖЕ, КАК ОСТАНОВКА. Опору называет КЛИП; нет клипа — нет
      // и опоры, о которой он мог бы говорить. Без этого условия кукла без набора не «стоит столбом»,
      // а ВОЛОЧИТ НОГИ: `clipContact` навсегда [true,true], вес на ходу 1, замок не снимается никогда —
      // и обе стопы прибиты к точке первого кадра, пока персонаж от неё уезжает.
      this.lockW = (this.still || !this.clipLoco) ? Math.max(0, this.lockW - dt / LOCO_FADE) : 1;
      this.human.root.updateMatrixWorld(true);
      const tgt: [[number, number], [number, number]] = [[0, 0], [0, 0]];
      for (let i = 0; i < 2; i++) {
        // ⚠ Клип поворота (и его гашение) — ноги его: фиксации нет, и точку не держим — после поворота её снимут заново
        // с той позы, что будет тогда, а не со стоп-кадра до поворота (см. `seamW`, ступень ног).
        // ⚠ Про «клипа нет» здесь НЕ спрашиваем второй раз: без клипа `lockW` уже гаснет до нуля выше,
        // и этот же `lockW <= 0.001` снимает замок. Две защёлки на одно условие — это два места правды,
        // и проверить ни одну из них нельзя: мутация любой по отдельности проходит мимо сторожа (проверено).
        if (!this.clipContact[i] || this.lockW <= 0.001 || this.turn) { this.footLock[i] = null; continue; }
        if (!this.footLock[i]) {
          const f = this.human.bones.get(i === 0 ? 'LeftFoot' : 'RightFoot')!.getWorldPosition(_lockV);
          this.footLock[i] = { x: f.x + this.px, z: f.z + this.pz };
        }
        tgt[i] = [this.footLock[i]!.x - this.px, this.footLock[i]!.z - this.pz];
      }
      warpStanceFeet(this.human, tgt, [!this.footLock[0], !this.footLock[1]], this.lockW);
    } else if (locoPose && !this.turn) {   // ⚠ клип поворота владеет ногами — подтяжки нет (см. `seamW`)
      // ⚠ ПОСЛЕ `applyTorsoTwist`, А НЕ ДО. Он ставит тазу фейсинг, то есть ПОВОРАЧИВАЕТ ВЕСЬ РИГ, и
      // подтяжка, сделанная раньше, была бы посчитана в другом кадре и уехала бы вместе с поворотом.
      // Планты у планировщика в МИРЕ, риг локальный → вычитаем позицию персонажа.
      const p0 = this.plannerPlant(0), p1 = this.plannerPlant(1);
      warpStanceFeet(this.human,
        [[p0[0] - this.px, p0[1] - this.pz], [p1[0] - this.px, p1[1] - this.pz]],
        this.plannerSwing() as [boolean, boolean], mix);
    }
    this.easeSeamLegs(dt);   // шов поворота, ноги — ПОСЛЕ подтяжек: смещение снимается с того, что реально показано
    // ТАЗ УДАРА ГАСНЕТ ЛОКОМОЦИЕЙ. Удар — слой ВЕРХА, низом владеет походка (в Unreal такой слой кладут
    // `Layered blend per bone` с исключённым тазом, в Unity — маской слоя). Наша маска удара таз и так не
    // содержит (`Hips` нет в `ATK_BONES`), но `applyAttackPelvis` добавляет его ОТДЕЛЬНО — ради маха таза
    // у СТОЯЧЕГО удара. На бегу этот мах ложится ПОВЕРХ жёстко поставленного гейтом боба (`hips.position.set`
    // в `gaitToHumanoid`, дальше здесь `+=`) и читается как рывок.
    // Гейт по `moveMag` (насколько персонаж ДВИЖЕТСЯ), а НЕ по `legMag`. Пробовал `legMag` — тесты поймали
    // две беды: (1) он держится высоким ещё ~0.3 с после того, как планировщик устаканился, и стоячий удар
    // терял мах таза на старте; (2) он поднимается на ПОДШАГЕ при развороте на месте, а бить с разворотом
    // персонаж имеет право. `moveMag` = скорость/шаговая, ровно то условие, которое и требовалось.
    const pelvisW = 1 - this.moveMag;
    if (this.fade) applyAttackPelvis(this.human, this.fade.atk, yaw, this.fade.w * pelvisW);   // таз уходящего удара — тоже с кроссфейдом
    applyAttackPelvis(this.human, this.atk, yaw, pelvisW);   // мах/скрутка таза удара in-place (поверх facing; Root≠Pelvis) — аддитивно
    applyHeadLookAt(this.human, this.aimYaw, twist.headLook, twist.headPitch);   // голова на ПРИЦЕЛ + ЗАДАННЫЙ кивок (убирает свинг-нырок от удара)
    if (this.modeSnap) {                                             // смена режима: новая поза перетекает из запомненной
      for (const [nm, b] of this.human.bones) { const q = this.modeSnap.rot.get(nm); if (q) b.quaternion.slerp(q, this.modeBlend); }
      this.human.bones.get('Hips')!.position.lerp(this.modeSnap.hips, this.modeBlend);
      this.modeBlend -= dt / MODE_FADE;
      if (this.modeBlend <= 0) this.modeSnap = null;
    }
    this.stepClock += dt;
    this.emitSteps(turnWas, turnT0, clipOnly && mix > 0.001 ? leadNow : null, spd);
  }
  /**
   * Шаги и прочие метки того, кто ведёт ноги (см. `STEP_MIN_GAP`). Без подписчика — только забыть прошлое: иначе
   * подписка посреди бега выстрелила бы разом всем «накопленным» касанием.
   */
  private emitSteps(turn: PosePlayer['turn'], turnT0: number, lead: LeadMark | null, spd: number): void {
    const on = this.onMark;
    if (!on) { this.stepSup = null; this.locoMark = null; return; }
    const pace = clamp(spd / Math.max(1, GAIT.speedRun), 0, 1);
    const step = (leg: 0 | 1, e: MarkEvent): void => {
      if (this.stepClock - this.stepAt[leg] < STEP_MIN_GAP) return;
      this.stepAt[leg] = this.stepClock;
      on({ ...e, pace });
    };
    const pass = (evs: readonly MarkEvent[]): void => {
      for (const e of evs) if (e.mark.type === 'footstep') { if (e.phase === 'point') step(e.mark.foot === 'R' ? 1 : 0, e); } else on(e);
    };
    let authored = false;
    if (turn && !turn.out) {
      // Поворот клипом ведёт ноги сам: его метки по пройденному отрезку. Кончился на этом кадре — хвост до конца клипа.
      pass(marksInRange(turn.clip, turnT0 > 0 ? turnT0 : -1e-9, Math.min(turn.t, clipDur(turn.clip))));
      authored = hasMark(turn.clip, 'footstep');
    } else if (lead) {
      const prev = this.locoMark;
      // Тот же клип и секция — время прошлого кадра как есть. Сменился ведущий посреди цикла — клипы синхронны
      // по фазе, и прошлое время переводится ЧЕРЕЗ ФАЗУ: иначе на смене ведущего шаг терялся бы или звучал дважды.
      const tPrev = !prev ? null
        : prev.clip === lead.clip && prev.section === lead.section ? prev.t
          : prev.section === 'loop' && lead.section === 'loop' ? lead.loopStart + prev.phaseU * (lead.loopEnd - lead.loopStart)
            : null;
      if (tPrev !== null) pass(lead.section === 'loop' ? loopMarksInRange(lead.clip, tPrev, lead.t, lead.loopStart, lead.loopEnd) : marksInRange(lead.clip, tPrev, lead.t));
      authored = hasMark(lead.clip, 'footstep');
    }
    this.locoMark = lead ? { clip: lead.clip, t: lead.t, phaseU: lead.phaseU, section: lead.section } : null;
    const sup = this.groundSupport;
    if (this.stepSup && !authored) for (const leg of [0, 1] as const) if (sup[leg] && !this.stepSup[leg]) step(leg, { mark: STEP_MARKS[leg], phase: 'point', t: 0 });
    this.stepSup = [sup[0], sup[1]];
  }
}
/** Ведущий клип бега на кадре: время в клипе, фаза цикла до секций, секция и границы цикла. */
interface LeadMark { clip: Clip; t: number; phaseU: number; section: LocoSection; loopStart: number; loopEnd: number }
