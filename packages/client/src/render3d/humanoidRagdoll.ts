/**
 * РЭГДОЛЛ НА ГУМАНОИД-СКЕЛЕТЕ (Ф2 системы физ-анимации) — единый риг для редактора и, позже, игры.
 * Строится на пропорциях гуманоида (`humanoid.ts`) в T-ПОЗЕ: 15 физ-костей (таз/торс/голова + по стороне
 * плечо/предплечье/кисть/бедро/голень/стопа). Боксы вместо капсул — сегмент задаётся половинами по осям, не
 * нужен разворот формы (руки идут по X, ноги по −Y). Ведение к позе — штатным `Ragdoll.DriveToPoseUsingMotors`,
 * таз kinematic-авторитет (как в игре). Оси суставов: ноги/торс/голова — как в игровом `ragdoll.ts`; руки в
 * T-позе — плечо twist ±X, локоть — шарнир по Y.
 *
 * Переиспользует Jolt-инстанс и PhysWorld из `ragdoll.ts` (единый wasm). Грабли emscripten — см. шапку
 * `ragdoll.ts`: не destroy'ить временные-по-значению, копировать BodyID, общий кэш форм не трогать.
 */
import * as THREE from 'three';
import { TILE } from '@dm/shared';
import { jolt, type PhysWorld, type JoltNS } from './ragdoll.js';
import type { Humanoid } from './humanoid.js';   // только тип (без цикла: humanoid не импортирует рэгдолл)
import { groundFeet, type GroundQuery, type GroundOpts } from './footIk.js';
import { resolvePhysSet, presetBodies, matchPhysPreset, physCost, type PhysNode } from './physRig.js';   // Ф11: набор тел = данные
import { FINGER_GEO, FINGER_SEG } from './humanoid.js';                                                   // геометрия фаланг — ОДНА на меш и физику
import { EXTRA_JOINTS } from './jointLimits.js';                                                          // пределы пальцев — тоже ОДНИ

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
type Vec3 = [number, number, number];
type Con =
  // swing: диапазоны АСИММЕТРИЧНЫ по осям (planeLim вокруг plane-оси, normalLim вокруг normal=twist×plane, twistLim вокруг twist).
  // Заданы в конвенции КОНКРЕТНОЙ кости (B[] правая сторона зеркальна — см. jointLimitView flip-right).
  | { kind: 'swing'; twist: Vec3; plane: Vec3; planeLim: [number, number]; normalLim: [number, number]; twistLim: [number, number] }
  | { kind: 'hinge'; axis: Vec3; normal: Vec3; lim: [number, number] };
type MGroup = 'leg' | 'arm' | 'core' | 'head';
/**
 * ФОРМА ФИЗ-ТЕЛА (Ф26.5). Цилиндр и капсула в Jolt всегда по оси Y, а наши кости смотрят куда угодно
 * (руки по ±X, ноги по −Y, стопы по +Z) — поэтому форма разворачивается кватернионом в `RotatedTranslatedShapeSettings`
 * (там уже передаётся смещение `off`, раньше ротация там была единичная). Призрак получает тот же разворот,
 * запечённый в геометрию.
 */
export type PhysShape =
  | { k: 'box'; h: Vec3 }
  | { k: 'sphere'; r: number }
  | { k: 'cylinder'; r: number; half: number }
  | { k: 'capsule'; r: number; half: number }
  /**
   * КОНИЧЕСКАЯ КАПСУЛА (Ф28.4) — два разных радиуса по концам. Именно ей ткань аппроксимирует
   * конечности: в Unreal это Tapered Capsule (помечена cloth only), в Unity — пара сфер разного
   * радиуса. Бедро толще колена почти вдвое, и одним радиусом тут либо толсто внизу, либо тонко вверху.
   * `r` — у сустава, `r2` — на дальнем конце (вдоль `off`). В Jolt — `TaperedCapsuleShapeSettings`.
   */
  | { k: 'taper'; r: number; r2: number; half: number };
/**
 * ПЕР-ТЕЛО ОВЕРРАЙД РАЗМЕРОВ (Ф26.5), лежит в `pe_ragdoll.sizes` рядом с набором тел и лимитами.
 * `len` — ПОЛОВИНА длины вдоль оси тела (так же заданы `h` в каталоге), `w`/`d` — МНОЖИТЕЛИ сечения
 * (ширина/толщина; у круглых форм работает `w`). `anchor`/`off` пишет кнопка «снять с костей».
 */
export interface PhysSize { k?: PhysShape['k']; len?: number; w?: number; d?: number; anchor?: Vec3; off?: Vec3; pos?: Vec3; rot?: Vec3 }
export const PHYS_SIZES: Record<string, PhysSize> = {};

interface HBone {
  name: string;
  /** Родитель ПО ИМЕНИ. Индексом он был, пока набор тел был зашит; с редактируемым набором индексы
   *  сдвигаются на каждое выключенное тело, и адресация по имени — единственная, которая это переживает. */
  parent: string | null;
  /** `core` — без этого куклы нет; `extra` — кисти/носки; `opt` — пальцы (по умолчанию выключены). */
  tier: 'core' | 'extra' | 'opt';
  anchor: Vec3;                 // мировой сустав в T-позе покоя = начало тела
  off: Vec3;                    // НАПРАВЛЕНИЕ КОСТИ: смещение центра формы от сустава; задаёт и длинную ось, и разворот
  /**
   * РУЧНАЯ ДОВОДКА ФОРМЫ (Ф28.2) — только геометрия и масса, НИКОГДА не сустав.
   *
   * Двигать ради этого `anchor` НЕЛЬЗЯ: он одновременно origin тела, точка констрейнта
   * (`mPoint1`/`mPosition1`) И рест-трансляция скелета (`anchor − parentAnchor`) — сдвинув его, сдвинешь
   * сустав и всю цепь ниже. Аналог в индустрии — Center/Rotation примитива в Unreal PhysicsAsset:
   * тело стоит на кости, а примитив внутри него двигается своим гизмо.
   * Оба в ФРЕЙМЕ ТЕЛА (= фрейм кости в Т-позе), `rot` — эйлер В РАДИАНАХ.
   */
  pos?: Vec3;
  rot?: Vec3;
  shape: PhysShape;
  con: Con | null;
  group: MGroup;
  damp: number;
  /**
   * Ф28.1 — МНОЖИТЕЛЬ ПРЕДЕЛА НА СЕГМЕНТ. Несколько тел делят ОДИН канон-сустав (три сегмента
   * спины — все `spine`), а диапазон в таблице задан на ВЕСЬ корпус. Без деления суммарный
   * изгиб утроился бы и корпус складывался. Умножается И в констрейнте (`makeCon`), И в виде предела
   * (`jointLimitView`) — иначе физика и клэмп манекена разойдутся.
   */
  limScale?: number;
}
/** Тело АКТИВНОГО набора: родитель уже индексом (требование Jolt) и цепь ретаргета с учётом слияний. */
type ActiveBone = HBone & { parentIdx: number; chain: string[] };

const swing = (planeLim: [number, number], normalLim: [number, number], twistLim: [number, number], twist: Vec3, plane: Vec3): Con =>
  ({ kind: 'swing', twist, plane, planeLim, normalLim, twistLim });
const hinge = (lim: [number, number], axis: Vec3, normal: Vec3): Con => ({ kind: 'hinge', axis, normal, lim });

// ── АУДИТ DOF СУСТАВОВ (наши пределы vs анатомия человека; рад→°: ×57.3) ──────────────────────────────
// Свинг = 3 оси: plane (сгиб/разгиб), normal (отвед/прив или бок), twist (осевая ротация). Hinge = 1 ось (сгиб).
//   Бедро:  сгиб/разг ±52° | отвед/прив ±80° | твист ±40°(★расширен с ±23)   — реально сгиб120/разг20, тв внутр40/внеш45
//   Колено: сгиб −3..126° (hinge)                                            — реально 0..135 (+ротация в сгибе — не моделим)
//   Голень-стоп: питч ±26° | крен ±11° | твист ±10° (swing)                  — реально подошв50/тыл20 (асимм. упрощена)
//   Плечо:  сгиб/разг ±97° | отвед/прив ±69° | твист ±80°(★расширен с ±46)   — реально до 180 / твист ±90
//   Локоть: сгиб −138..6° (hinge, пронации НЕТ — Jolt hinge = 1-DOF)         — реально сгиб145 + пронация ±85 (на запястье)
//   Запястье: сгиб/девиация ±57° | ТВИСТ ±80°(★=ПРОНАЦИЯ, ось предплечья)    — пронация авторится ЗДЕСЬ (локоть-роллом отложено)
//   Спина(3 слиты): сгиб/разг −34..40° | бок ±23° | твист ±29°              — грубо, но ок для игры
//   Шея(2 слиты):   сгиб/разг ±29° | бок ±23° | твист ±40°                  — реально твист ±80, занижено намеренно
// НАМЕРЕННО game-tuned (НЕ баг): бедро сгиб/разг СИММЕТРИЧНО ±0.9 (гейт машет ±0.7, pose.ts — анатом. асимм. разгиб~0.35
//   клипал бы бег); бедро отвед/прив ШИРЕ анатомии (стойка опирается). Jolt-swing-конус СИММЕТРИЧЕН (max полу-угол)
//   → для асимм. дефолтов физика чуть шире клэмпа манекена (<0.1рад, незаметно); полная асимметрия (bias-рамка) отложена —
//   конфликтует с тюнингом бега + нужна верификация в игре. Пределы правятся живьём в редакторе (RB3, pe_ragdoll → jointOv).
// Кости в порядке скелета (родитель раньше ребёнка — требование Jolt). Пропорции = гуманоид T-поза.
/** Доля общего диапазона `spine` на ОДИН сегмент спины (три сегмента в сумме дают анатомию целиком). */
const SPINE_SEG = 1 / 3;
const CATALOG: HBone[] = [
  { name: 'Hips', parent: null, tier: 'core', anchor: [0, 32, 0], off: [0, 0, 0], shape: { k: 'box', h: [5, 3, 3] }, con: null, group: 'core', damp: 1 },
  // СПИНА — ТРИ СЕГМЕНТА (Ф28.1), по одному на кость. Раньше `Spine`+`Chest`+`UpperChest` жили в ОДНОМ
  // теле длиной 17u: форма брала поворот ПОСЛЕДНЕЙ кости цепи, поэтому на любом изгибе корпуса
  // коробка уезжала от меша, а ткань с таким коллайдером протыкала бы спину. Анкеры — ровно на суставах
  // дефолтного рига (`humanoid.ts`: Spine 37, Chest 43, UpperChest 48, Neck 53).
  { name: 'Torso', parent: 'Hips', tier: 'core', anchor: [0, 37, 0], off: [0, 3, 0], shape: { k: 'box', h: [4.6, 3, 3.0] }, con: swing([-0.6, 0.7], [-0.4, 0.4], [-0.5, 0.5], [0, 1, 0], [1, 0, 0]), group: 'core', damp: 1, limScale: SPINE_SEG },
  { name: 'Chest', parent: 'Torso', tier: 'core', anchor: [0, 43, 0], off: [0, 2.5, 0], shape: { k: 'box', h: [5.4, 2.5, 3.2] }, con: swing([-0.6, 0.7], [-0.4, 0.4], [-0.5, 0.5], [0, 1, 0], [1, 0, 0]), group: 'core', damp: 1, limScale: SPINE_SEG },
  { name: 'UpperChest', parent: 'Chest', tier: 'core', anchor: [0, 48, 0], off: [0, 2.5, 0], shape: { k: 'box', h: [5.2, 2.5, 3.2] }, con: swing([-0.6, 0.7], [-0.4, 0.4], [-0.5, 0.5], [0, 1, 0], [1, 0, 0]), group: 'core', damp: 1, limScale: SPINE_SEG },
  { name: 'Head', parent: 'UpperChest', tier: 'core', anchor: [0, 53, 0], off: [0, 4, 0], shape: { k: 'sphere', r: 5 }, con: swing([-0.5, 0.5], [-0.4, 0.4], [-0.7, 0.7], [0, 1, 0], [1, 0, 0]), group: 'head', damp: 1 },
  // КЛЮЧИЦЫ ОТДЕЛЬНЫМИ ТЕЛАМИ (Ф28.1). Жалоба «руки съехали»: тело `ArmL` покрывало КЛЮЧИЦУ И ПЛЕЧО
  // разом (замер на атласе: анкер на ключице, длина 19.7u при плече→локоть 15.1u и ключице 4.6u), а поворот
  // брало с плеча — в Т-позе всё сходилось, а при опущенной руке форма вылезала за локоть ровно на длину ключицы.
  // Предел берётся из готовой анатомичной записи `clavicleJoints()` (`jointLimits.ts`): ±20° вперёд-назад,
  // ±15° подъём, ±10° твист; оси те же (twist вдоль ±X, plane = Y).
  { name: 'ClavL', parent: 'UpperChest', tier: 'core', anchor: [3, 51, 0], off: [2, 0, 0], shape: { k: 'capsule', r: 1.5, half: 0.5 }, con: swing([-0.35, 0.35], [-0.26, 0.26], [-0.17, 0.17], [1, 0, 0], [0, 1, 0]), group: 'core', damp: 1 },
  { name: 'ClavR', parent: 'UpperChest', tier: 'core', anchor: [-3, 51, 0], off: [-2, 0, 0], shape: { k: 'capsule', r: 1.5, half: 0.5 }, con: swing([-0.35, 0.35], [-0.26, 0.26], [-0.17, 0.17], [-1, 0, 0], [0, 1, 0]), group: 'core', damp: 1 },
  // Плечо: твист ±1.4≈±80° (внутр/внеш ротация плеча, реально ~±90°; было ±0.8≈±46° — мало). Свинг ±1.7/±1.2 game-широкий.
  // ПЛЕЧО (Ф26.7): подъём/опускание ±69° было МЕНЬШЕ АНАТОМИИ: от T-позы до «рука над головой» ровно 90°,
  // до «рука вдоль тела» тоже 90° — то есть ОБА крайних бытовых положения были ЗА ПРЕДЕЛОМ. Оттуда шли две жалобы:
  // кисть к бедру не дотягивалась (Ф25) и локоть при поднятой руке уходил за спину (Ф26.7) — клэмп выбирал
  // единственную доступную сторону круга свивеля (замер: без клэмпа локоть встаёт вперёд на +6.8u, с клэмпом — −14.1u).
  // Стало ±109° подъём и ±92° твист (наружная ротация плеча у человека ~90°). Это ДЕФОЛТ — пер-сустав тюн в панели перебивает.
  // ⚠ ТВИСТ ПЛЕЧА ±180°, А НЕ «АНАТОМИЧЕСКИЕ» ±92° — И ЭТО НЕ ОПЕЧАТКА.
  // Твист меряется ОТ T-ПОЗЫ (рест-фрейм, перенесённый минимальной дугой), а этот отсчёт для руки НАД ГОЛОВОЙ не
  // анатомичен: минимальная дуга «рука вбок → рука вверх» уносит ось локтя так, что бытовой ЗАМАХ ТОПОРОМ (кисть за
  // голову, локоть вперёд) требует РОВНО 180° доворота. ЗАМЕР: при ±91.7° клэмп срезал 88.3° и возвращал предплечье
  // к голове — жалоба «не даёт сделать замах» (одинаково в обеих версиях лимитов, т.к. это ДАННЫЕ, а не алгоритм).
  // Плечу нужен полный оборот параметризации; настоящее анатомическое ограничение даёт КОНУС свинга, он и остался.
  // ⚠ ТВИСТ ПЛЕЧА ОГРАНИЧЕН ±1.7, А НЕ ±π. `±3.14` — это «предела нет»: суставу разрешено намотать
  // ПОЛ-ОБОРОТА. После нескольких «дёрг/упасть» рука и правда наматывалась, а на подъёме мотор тянул
  // её к цели ПО КРАТЧАЙШЕЙ ДУГЕ — из-за пол-оборота кратчайший путь ведёт в ЗЕРКАЛЬНУЮ ориентацию,
  // и рука оставалась перекрученной (та же семья, что `armSwingMax`: у ориентации нет «дальше 180°»).
  // ±1.7 рад = ±97°, это полный анатомический размах ротации плеча в каждую сторону, и наши позы
  // в него укладываются (ручка «разворот локтя» ходит до ±1.6, боевой гард — около нуля).
  { name: 'ArmL', parent: 'ClavL', tier: 'core', anchor: [7, 51, 0], off: [6.5, 0, 0], shape: { k: 'capsule', r: 2.6, half: 3.9 }, con: swing([-1.7, 1.7], [-1.9, 1.9], [-1.7, 1.7], [1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.9 },
  { name: 'ArmR', parent: 'ClavR', tier: 'core', anchor: [-7, 51, 0], off: [-6.5, 0, 0], shape: { k: 'capsule', r: 2.6, half: 3.9 }, con: swing([-1.7, 1.7], [-1.9, 1.9], [-1.7, 1.7], [-1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.9 },
  { name: 'ForeL', parent: 'ArmL', tier: 'core', anchor: [20, 51, 0], off: [5.5, 0, 0], shape: { k: 'capsule', r: 2.2, half: 3.3 }, con: hinge([-2.4, 0.1], [0, 1, 0], [1, 0, 0]), group: 'arm', damp: 0.9 },
  { name: 'ForeR', parent: 'ArmR', tier: 'core', anchor: [-20, 51, 0], off: [-5.5, 0, 0], shape: { k: 'capsule', r: 2.2, half: 3.3 }, con: hinge([-0.1, 2.4], [0, 1, 0], [-1, 0, 0]), group: 'arm', damp: 0.9 },
  // Бедро: твист (внутр/внеш ротация) ±0.7≈±40° — анатомично (было ±0.4≈±23°, вдвое мало). Бокс НЕквадратный (X>Z, колено
  // «смотрит» вперёд) → осевой твист ВИДЕН на призраке (квадрат его прятал). ab/ad ±1.4 оставлено ШИРЕ анатомии — game-tuned
  // (стойка опирается на него; сужать = клипать гейт). Сгиб/разгиб ±0.9 симметрично — асимметрию даёт Ф2 (bias-рамка).
  { name: 'ThighL', parent: 'Hips', tier: 'core', anchor: [4, 30, 0], off: [0, -7.5, 0], shape: { k: 'capsule', r: 3.4, half: 4.1 }, con: swing([-0.9, 0.9], [-1.4, 1.4], [-0.7, 0.7], [0, -1, 0], [1, 0, 0]), group: 'leg', damp: 1 },
  { name: 'ThighR', parent: 'Hips', tier: 'core', anchor: [-4, 30, 0], off: [0, -7.5, 0], shape: { k: 'capsule', r: 3.4, half: 4.1 }, con: swing([-0.9, 0.9], [-1.4, 1.4], [-0.7, 0.7], [0, -1, 0], [1, 0, 0]), group: 'leg', damp: 1 },
  { name: 'ShinL', parent: 'ThighL', tier: 'core', anchor: [4, 15, 0], off: [0, -7, 0], shape: { k: 'capsule', r: 2.9, half: 4.1 }, con: hinge([-0.05, 2.2], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  { name: 'ShinR', parent: 'ThighR', tier: 'core', anchor: [-4, 15, 0], off: [0, -7, 0], shape: { k: 'capsule', r: 2.9, half: 4.1 }, con: hinge([-0.05, 2.2], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  // Голеностоп — SWING (малый многоосевой ход): twist вдоль голени = лево-право (рыск), plane=питч (плантар/дорси), normal=крен.
  { name: 'FootL', parent: 'ShinL', tier: 'core', anchor: [4, 1, 0], off: [0, 0, 3], shape: { k: 'box', h: [3, 1.5, 5.5] }, con: swing([-0.45, 0.45], [-0.2, 0.2], [-0.18, 0.18], [0, -1, 0], [1, 0, 0]), group: 'leg', damp: 1 },
  { name: 'FootR', parent: 'ShinR', tier: 'core', anchor: [-4, 1, 0], off: [0, 0, 3], shape: { k: 'box', h: [3, 1.5, 5.5] }, con: swing([-0.45, 0.45], [-0.2, 0.2], [-0.18, 0.18], [0, -1, 0], [1, 0, 0]), group: 'leg', damp: 1 },
  // Запястье: twist-ось [±1,0,0] = ось предплечья → его твист = ПРОНАЦИЯ/СУПИНАЦИЯ (реально сустав предплечья, но локоть у нас
  // чистый hinge, а асимм. L/R swing не калиброван — jointLimitView; отд. кость-ролл отложена). ±1.4≈±80° = полная пронация.
  { name: 'HandL', parent: 'ForeL', tier: 'extra', anchor: [31, 51, 0], off: [2, 0, 0], shape: { k: 'sphere', r: 2.6 }, con: swing([-1.0, 1.0], [-1.0, 1.0], [-1.4, 1.4], [1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.8 },
  { name: 'HandR', parent: 'ForeR', tier: 'extra', anchor: [-31, 51, 0], off: [-2, 0, 0], shape: { k: 'sphere', r: 2.6 }, con: swing([-1.0, 1.0], [-1.0, 1.0], [-1.4, 1.4], [-1, 0, 0], [0, 1, 0]), group: 'arm', damp: 0.8 },
  // Носок — HINGE (сгиб вверх на отталкивании), крошечное тело спереди стопы. Даёт носку физику + предел.
  { name: 'ToeL', parent: 'FootL', tier: 'extra', anchor: [4, 0.5, 6], off: [0, 0, 1.5], shape: { k: 'box', h: [2.6, 1, 2] }, con: hinge([-0.15, 0.6], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
  { name: 'ToeR', parent: 'FootR', tier: 'extra', anchor: [-4, 0.5, 6], off: [0, 0, 1.5], shape: { k: 'box', h: [2.6, 1, 2] }, con: hinge([-0.15, 0.6], [1, 0, 0], [0, -1, 0]), group: 'leg', damp: 1 },
];

/**
 * ФАЛАНГИ КАК ФИЗ-ТЕЛА (Ф11). Строятся из ТОЙ ЖЕ геометрии, что меш (`FINGER_GEO`), и берут пределы из
 * `EXTRA_JOINTS` — то есть у пальца ОДНИ пределы, есть у него тело или нет. Иначе включение физики кисти
 * молча меняло бы допустимый сгиб. Имя физ-тела = имя humanoid-кости (ретаргет 1:1, слитых цепей нет).
 * По умолчанию ВЫКЛЮЧЕНЫ (tier `opt`): +30 тел и +30 констрейнтов — это осознанный выбор, а не дефолт.
 */
function fingerPhysBodies(): HBone[] {
  const out: HBone[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    for (const [chain, base, lens] of FINGER_GEO) {
      let px = 31 * sx + base[0] * sx, py = 51 + base[1], pz = base[2];   // запястье физ-рига = [±31, 51, 0]
      for (let i = 0; i < 3; i++) {
        const name = side + chain + FINGER_SEG[i];
        const len = lens[i] ?? 1, half = Math.max(0.35, len * 0.5), r = chain === 'Thumb' ? 0.62 : 0.55;
        const ej = EXTRA_JOINTS[name];
        out.push({
          name, tier: 'opt', group: 'arm', damp: 0.7,
          parent: i === 0 ? (side === 'Left' ? 'HandL' : 'HandR') : side + chain + FINGER_SEG[i - 1],
          anchor: [px, py, pz], off: [half * sx, 0, 0],
          shape: { k: 'box', h: [half, r, r] },
          con: ej ? swing([ej.def.planeMin!, ej.def.planeMax!], [ej.def.normalMin!, ej.def.normalMax!], [ej.def.twistMin!, ej.def.twistMax!], ej.twist, ej.plane) : null,
        });
        px += len * sx;
      }
    }
  }
  return out;
}
CATALOG.push(...fingerPhysBodies());
const _catBone = new Map(CATALOG.map((b) => [b.name, b]));
/**
 * КАТАЛОЖНОЕ (авторское) смещение тела — эталон длины для тел, которым скелет длины НЕ ДАЁТ:
 * листья цепи (голова, кисти, носки) и ступицы без выноса (таз). Ф26.8: авто-подгонка обязана
 * читать ЕГО, а не текущее `off` живого тела, иначе замер кормится собственным выходом.
 */
export function physCatalogOff(name: string): Vec3 | undefined { return _catBone.get(name)?.off; }
/**
 * КАТАЛОЖНЫЕ ПОЛУОСИ тела в его собственном базисе: `along` — вдоль оси, `u`/`v` — поперёк (Ф28.3).
 * Нужны, чтобы замер по вершинам (абсолютные юниты) перевести в МНОЖИТЕЛИ `w`/`d`, в которых хранятся размеры.
 */
export function physCatalogHalf(name: string): { along: number; u: number; v: number } | undefined {
  const b = _catBone.get(name); if (!b) return undefined;
  const ax = bodyAxis(b), s = b.shape;
  if (s.k === 'box') return { along: s.h[ax]!, u: s.h[(ax + 1) % 3]!, v: s.h[(ax + 2) % 3]! };
  if (s.k === 'sphere') return { along: s.r, u: s.r, v: s.r };
  // `along` — ПОЛНАЯ полудлина, как `h[ax]` у бокса: в самой форме `half` шапочки не считает,
  // а обжатие по вершинам делит на эти числа измеренные юниты.
  const cap = s.k === 'capsule' ? s.r : s.k === 'taper' ? Math.max(s.r, s.r2) : 0;
  return { along: s.half + cap, u: s.r, v: s.r };   // cylinder/capsule/taper — круглые, поперечник один
}
/** Ось тела (0=X, 1=Y, 2=Z): куда оно тянется от сустава. Берётся из `off`, а если он нулевой (таз) — из самой длинной полуоси. */
export function bodyAxis(b: { off: Vec3; shape: PhysShape }): 0 | 1 | 2 {
  const o = b.off.map(Math.abs);
  let i: 0 | 1 | 2 = o[0]! >= o[1]! && o[0]! >= o[2]! ? 0 : o[1]! >= o[2]! ? 1 : 2;
  if (o[0]! + o[1]! + o[2]! < 1e-6 && b.shape.k === 'box') { const h = b.shape.h; i = h[0]! >= h[1]! && h[0]! >= h[2]! ? 0 : h[1]! >= h[2]! ? 1 : 2; }
  return i;
}
/** Применить оверрайд размеров к телу каталога (Ф26.5). Отсутствующие поля — из каталога, то есть «сброс» = удалить ключ. */
function sized(src: HBone): HBone {
  const ov = PHYS_SIZES[src.name]; if (!ov) return src;
  const b: HBone = { ...src, anchor: [...(ov.anchor ?? src.anchor)] as Vec3, off: [...(ov.off ?? src.off)] as Vec3 };
  if (ov.pos) b.pos = [...ov.pos] as Vec3;      // Ф28.2: ручная доводка формы — мимо сустава
  if (ov.rot) b.rot = [...ov.rot] as Vec3;
  // Ось берётся из ФАКТИЧЕСКОГО (уже переопределённого) смещения — ровно как в `shapeRot`. По каталожному
  // `off` она могла разойтись с разворотом формы, и «длина» ложилась бы на поперечную полуось.
  const ax = bodyAxis({ off: b.off, shape: src.shape });
  const w = ov.w ?? 1, d = ov.d ?? 1;
  // У КАПСУЛЫ И КОНУСА `half` в форме — БЕЗ ШАПОЧЕК (так их задаёт Jolt), а `len`
  // в оверрайде и `h[ax]` в боксе — ПОЛНАЯ полудлина. Не вернув шапочку здесь, любой оверрайд
  // (даже один `w`) укорачивал бы капсулу на радиус при каждом чтении каталога.
  const baseHalf = src.shape.k === 'box' ? src.shape.h[ax]!
    : src.shape.k === 'sphere' ? src.shape.r
      : src.shape.k === 'capsule' ? src.shape.half + src.shape.r
        : src.shape.k === 'taper' ? src.shape.half + Math.max(src.shape.r, src.shape.r2)
          : src.shape.half;
  const baseR = src.shape.k === 'box' ? (src.shape.h[(ax + 1) % 3]! + src.shape.h[(ax + 2) % 3]!) / 2 : src.shape.k === 'sphere' ? src.shape.r : src.shape.r;
  const half = ov.len ?? baseHalf;
  const k = ov.k ?? src.shape.k;
  if (k === 'box') {
    const h: Vec3 = [0, 0, 0];
    h[ax] = half;
    h[(ax + 1) % 3] = (src.shape.k === 'box' ? src.shape.h[(ax + 1) % 3]! : baseR) * w;
    h[(ax + 2) % 3] = (src.shape.k === 'box' ? src.shape.h[(ax + 2) % 3]! : baseR) * w * d;
    b.shape = { k: 'box', h };
  } else if (k === 'sphere') b.shape = { k: 'sphere', r: baseR * w };
  // У конуса `d` НЕ толщина, а СУЖЕНИЕ: отношение дальнего радиуса к ближнему. У круглых форм
  // второй поперечник бессмыслен, так что поле простаивало — заводить новое ради одной формы не стал.
  else if (k === 'taper') { const r0 = baseR * w, r1 = baseR * w * d; b.shape = { k, r: r0, r2: r1, half: Math.max(0.05, half - Math.max(r0, r1)) }; }
  else b.shape = { k, r: baseR * w, half: Math.max(0.05, k === 'capsule' ? half - baseR * w : half) };   // капсула: half — без шапочек
  return b;
}
/**
 * СКОЛЬКО ТЕЛ ГОДЯТСЯ ПОД ТКАНЬ (Ф28.4). Ткань везде сталкивается ТОЛЬКО со сферами
 * и капсулами (коническая = пара сфер), боксы она не видит; бюджет порядка 32 штук.
 * Значит плащ и юбка будут проваливаться сквозь всё, что осталось боксом — читаут показывает это заранее.
 */
export function clothColliderCount(): { ok: number; box: number; limit: number } {
  let ok = 0, box = 0;
  for (const b of B) { if (b.shape.k === 'box') box++; else ok++; }
  return { ok, box, limit: 32 };
}
/** Активные тела только на чтение — редактору для авто-подгонки по костям и центра масс. */
export const physBodies = (): readonly ActiveBone[] => B;

/** Каталог для UI/пересборки: только то, что нужно чистому ядру (`physRig.ts`). */
export const PHYS_CATALOG: PhysNode[] = CATALOG.map((b) => ({ name: b.name, parent: b.parent, tier: b.tier, chain: [] }));
/** Читаемая подпись тела в панели (по-русски, чтобы галки не были загадкой). */
export const PHYS_LABEL: Record<string, string> = {
  Hips: 'таз', Torso: 'поясница', Chest: 'грудь', UpperChest: 'верх груди', ClavL: 'ключица Л', ClavR: 'ключица П', Head: 'голова', ArmL: 'плечо Л', ArmR: 'плечо П', ForeL: 'предплечье Л', ForeR: 'предплечье П',
  HandL: 'кисть Л', HandR: 'кисть П', ThighL: 'бедро Л', ThighR: 'бедро П', ShinL: 'голень Л', ShinR: 'голень П',
  FootL: 'стопа Л', FootR: 'стопа П', ToeL: 'носок Л', ToeR: 'носок П',
};

// АКТИВНЫЙ набор. Пересобирается `applyPhysProfile`; `makeHumanoidRagdoll` читает его при СОЗДАНИИ,
// поэтому смена набора — это та же пересборка куклы, что и смена лимитов (`rebuildRagdoll`).
const B: ActiveBone[] = [];
/** Текущий профиль: id пресета (или `custom`) и список включённых тел. Персист в `pe_ragdoll.physrig`. */
export const PHYS_SET: { id: string; bodies: string[] } = { id: 'base', bodies: [] };

/** Имя физ-кости → индекс В АКТИВНОМ НАБОРЕ. Пересобирается вместе с ним (объект тот же — ссылки живы). */
export const RAG_INDEX: Record<string, number> = {};
/** Имена физ-костей по порядку индексов (массив тот же — длина меняется на месте). */
export const RAG_NAMES: string[] = [];

/**
 * Собрать активный набор. `bodies` — явный список, иначе берётся пресет `id`.
 * ЗВАТЬ ДО создания рэгдолла (как и `loadRagdollConfig`): Jolt читает дерево при создании.
 */
export function applyPhysProfile(bodies?: readonly string[], id?: string): void {
  const names = bodies ? [...bodies] : presetBodies(PHYS_CATALOG, id ?? PHYS_SET.id);
  const active = resolvePhysSet(PHYS_CATALOG, names);
  B.length = 0;
  for (const a of active) {
    const src = _catBone.get(a.name); if (!src) continue;
    B.push({ ...sized(src), parentIdx: a.parent, chain: a.chain });
  }
  RAG_NAMES.length = 0;
  for (const k in RAG_INDEX) delete RAG_INDEX[k];
  B.forEach((b, i) => { RAG_NAMES.push(b.name); RAG_INDEX[b.name] = i; });
  PHYS_SET.bodies = names;
  PHYS_SET.id = matchPhysPreset(PHYS_CATALOG, names);
}
/** Стоимость текущего набора — тел и констрейнтов (шаг в мс меряет редактор). */
export const physSetCost = (): { bodies: number; constraints: number } => physCost(B);

/**
 * Ретаргет: физ-кость ← сумма локальных углов гуманоид-костей под-цепочки. Все rest-фреймы мировые/identity
 * (и у гуманоида, и у физ-рига в T-позе), поэтому локальные эйлеры складываются напрямую (для мелких/соосных
 * поворотов — точно; для крупных — приближение, физика/лимиты сглаживают). Слитые кости: торс = Spine+Chest+
 * UpperChest, голова = Neck+Head, плечо = Shoulder+UpperArm.
 */
const RETARGET: Record<string, string[]> = {
  Torso: ['Spine'], Chest: ['Chest'], UpperChest: ['UpperChest'], Head: ['Neck', 'Head'],
  ClavL: ['LeftShoulder'], ClavR: ['RightShoulder'],
  ArmL: ['LeftUpperArm'], ArmR: ['RightUpperArm'],
  ForeL: ['LeftLowerArm'], ForeR: ['RightLowerArm'],
  ThighL: ['LeftUpperLeg'], ThighR: ['RightUpperLeg'],
  ShinL: ['LeftLowerLeg'], ShinR: ['RightLowerLeg'],
  FootL: ['LeftFoot'], FootR: ['RightFoot'], HandL: ['LeftHand'], HandR: ['RightHand'],
  ToeL: ['LeftToes'], ToeR: ['RightToes'],
};
for (const b of CATALOG) if (b.tier === 'opt') RETARGET[b.name] = [b.name];   // фаланги — ретаргет 1:1
PHYS_CATALOG.forEach((n, i) => { n.chain = RETARGET[CATALOG[i]!.name] ?? []; });
const _rtQ = new THREE.Quaternion(), _rtQ2 = new THREE.Quaternion(), _rtE = new THREE.Euler();
export function retargetHumanoidPose(pose: Record<string, [number, number, number]>): (Vec3 | null)[] {
  return B.map((b) => {
    const src = b.chain; if (!src.length) return null;   // ЦЕПЬ АКТИВНОГО тела: если предка выключили, его углы уже внутри
    // КОМПОЗИЦИЯ кватернионов под-цепочки (parent→child), а не сумма эйлеров: для КРУПНЫХ углов
    // (занос топора, глубокий присед) сумма промахивалась — физика целилась мимо позы. Кватернионы точны.
    _rtQ.identity();
    for (const nm of src) { const p = pose[nm]; if (p) { _rtE.set(p[0], p[1], p[2]); _rtQ2.setFromEuler(_rtE); _rtQ.multiply(_rtQ2); } }
    _rtE.setFromQuaternion(_rtQ);
    return [_rtE.x, _rtE.y, _rtE.z];
  });
}
/** Инверсный ретаргет (для запекания): физ-кость → ОСНОВНАЯ humanoid-кость, куда лечь её локальному повороту.
 *  Слитые кости пишутся в одну (торс→Spine, голова→Neck, плечо→UpperArm); остальные при applyPose = покой. */
const PRIMARY: Record<string, string> = {
  Torso: 'Spine', Chest: 'Chest', UpperChest: 'UpperChest', Head: 'Neck',
  ClavL: 'LeftShoulder', ClavR: 'RightShoulder', ArmL: 'LeftUpperArm', ArmR: 'RightUpperArm', ForeL: 'LeftLowerArm', ForeR: 'RightLowerArm',
  ThighL: 'LeftUpperLeg', ThighR: 'RightUpperLeg', ShinL: 'LeftLowerLeg', ShinR: 'RightLowerLeg',
  FootL: 'LeftFoot', FootR: 'RightFoot', HandL: 'LeftHand', HandR: 'RightHand', ToeL: 'LeftToes', ToeR: 'RightToes',
};
/** Цель ПИНА (позиц. подтяжка тела к анимации, идея PuppetMaster): физ-кость → humanoid-сустав (его мир-позиция). */
export const PIN_SRC: Record<string, string> = {
  Torso: 'Spine', Chest: 'Chest', UpperChest: 'UpperChest', Head: 'Neck',
  ClavL: 'LeftShoulder', ClavR: 'RightShoulder', ArmL: 'LeftUpperArm', ArmR: 'RightUpperArm', ForeL: 'LeftLowerArm', ForeR: 'RightLowerArm',
  ThighL: 'LeftUpperLeg', ThighR: 'RightUpperLeg', ShinL: 'LeftLowerLeg', ShinR: 'RightLowerLeg',
  FootL: 'LeftFoot', FootR: 'RightFoot', HandL: 'LeftHand', HandR: 'RightHand', ToeL: 'LeftToes', ToeR: 'RightToes',
};
for (const b of CATALOG) if (b.tier === 'opt') { PRIMARY[b.name] = b.name; PIN_SRC[b.name] = b.name; }
applyPhysProfile(undefined, 'base');   // дефолт — тот же набор 17 тел, что был зашит
/** Живые тюн-параметры физики (панель редактора). Пины = пружина к позиции цели; muscle = вес ведения к позе;
 *  match = вес совпадения РЕНДЕРА с манекеном (0 физика … 1 ровно поза-цель) — обрабатывается в renderRagdollGhost. */
export const PHYS = { pin: 1, pinKp: 4200, pinKd: 260, muscle: 1, load: 1, match: 0 };
/** Масса оружия (условные кг) → доп. вес на кисть, оттягивает руку (Ragdoll Animator «item heaviness»). */
export { WEAPON_MASS, weaponHandMasses } from './weaponMass.js';   // ⚠ вынесено: чистая таблица, а этот модуль в node-vitest не грузится

const LAYER_DOLL = 1;                                     // как в PhysWorld (STATIC=0, DOLL=1)
const DENSITY = 1000 / (TILE * TILE * TILE);              // настоящие кг при метре=32u (см. ragdoll.ts)
const PELVIS_Y = 32;
const GRAV = 9.81 * TILE;                                 // u/с² (метр=32u) — для веса оружия на кисти
// «Сила мышц» и жёсткость по группам (кг·u²/с², Гц) — ЖИВОЙ тюн (панель редактора, RB3), применяется ПЕРЕСБОРКОЙ куклы.
// Ноги сильные; руки крепкие — держат T-позу горизонтально. Экспорт мутабелен: правит редактор/игра перед созданием рэгдолла.
export const MOTOR: Record<MGroup, [number, number]> = { leg: [20, 6e6], arm: [20, 6e6], core: [15, 3e6], head: [13, 2e5] };
// ЛИМИТЫ суставов — МНОЖИТЕЛЬ конусов swing / диапазонов hinge по группам (RB3): >1 = сгибается сильнее (дотянуться до
// экстремальных поз), <1 = жёстче. Применяется при СОЗДАНИИ (makeCon) → смена = пересборка куклы. Глобально на всех гуманоидов.
export const LIMITS: Record<MGroup, number> = { leg: 1, arm: 1, core: 1, head: 1 };

// ── ПЕР-СУСТАВ ЛИМИТЫ (симметрия L/R) ──────────────────────────────────────────────────────
// Канон-id объединяет левую/правую кость в ОДИН сустав → правишь один раз, применяется к обеим сторонам.
// Оси/знак сгиба остаются per-bone в B[] (они зеркальны), тут храним только УГЛЫ в «канон-форме».
export const CANON: Record<string, string> = {
  Torso: 'spine', Chest: 'spine', UpperChest: 'spine', Head: 'head',
  ClavL: 'clavicle', ClavR: 'clavicle', ArmL: 'shoulder', ArmR: 'shoulder', ForeL: 'elbow', ForeR: 'elbow',
  HandL: 'wrist', HandR: 'wrist', ThighL: 'hip', ThighR: 'hip', ShinL: 'knee', ShinR: 'knee',
  FootL: 'ankle', FootR: 'ankle', ToeL: 'toe', ToeR: 'toe',
};
export interface JointLim {
  kind: 'swing' | 'hinge'; group: MGroup;
  // swing: АСИММЕТРИЧНЫЙ диапазон по осям (в конвенции ЛЕВОЙ канон-кости). ± = раскрытие вперёд/назад независимо.
  planeMin?: number; planeMax?: number; normalMin?: number; normalMax?: number; twistMin?: number; twistMax?: number;
  flex?: number; hyperext?: number;   // hinge: осн. сгиб + малый переразгиб (знак → из базы B[])
}
const _cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Пределы НЕ зависят от того, включено ли тело: это канал АВТОРИНГА (Ф3.3), а набор тел — выбор симуляции.
const _bBone = _catBone;
// hinge [min,max] в конвенции КОНКРЕТНОЙ кости из канон-формы {flex,hyperext} (знак = как в базе baseLim).
function hingeLimits(baseLim: [number, number], e: JointLim | null): [number, number] {
  if (!e || e.flex === undefined) return baseLim;
  const flex = e.flex, hyper = e.hyperext ?? 0;
  return Math.abs(baseLim[0]) >= Math.abs(baseLim[1]) ? [-flex, hyper] : [-hyper, flex];   // сгиб в ту же сторону, что и база
}
// Дефолты по канон-суставу (из B[], первое вхождение = ЛЕВАЯ кость → канон-конвенция).
export const JOINT_DEF: Record<string, JointLim> = (() => {
  const out: Record<string, JointLim> = {};
  for (const b of CATALOG) {
    const canon = CANON[b.name]; if (!canon || !b.con || out[canon]) continue;
    const c = b.con;
    if (c.kind === 'swing') out[canon] = { kind: 'swing', group: b.group, planeMin: c.planeLim[0], planeMax: c.planeLim[1], normalMin: c.normalLim[0], normalMax: c.normalLim[1], twistMin: c.twistLim[0], twistMax: c.twistLim[1] };
    else out[canon] = { kind: 'hinge', group: b.group, flex: Math.max(Math.abs(c.lim[0]), Math.abs(c.lim[1])), hyperext: Math.min(Math.abs(c.lim[0]), Math.abs(c.lim[1])) };
  }
  return out;
})();
export const jointOv: Record<string, Partial<JointLim>> = {};   // оверрайды сустава (pe_ragdoll.joints)
export function effJoint(canon: string): JointLim { return { ...JOINT_DEF[canon]!, ...(jointOv[canon] || {}) }; }
// humanoid-кость → rag-кость (инверсия RETARGET) → канон-сустав. Для гизмо/панели по выбранной кости манекена.
export const RAG_OF_HUMAN: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const rag in RETARGET) for (const h of RETARGET[rag]!) out[h] = rag;
  return out;
})();
export function canonOfHuman(humanBone: string): string | null { const r = RAG_OF_HUMAN[humanBone]; return r ? (CANON[r] ?? null) : null; }
/** Предел ЛЮБОЙ кости манекена (Ф3.3): сначала физ-риг (там оси зеркальны и выверены),
    затем без-физическая таблица (`jointLimits.EXTRA_JOINTS` — пальцы и всё, чего в рэгдолле нет).
    Заведено ленивым импортом-хуком, чтобы не создавать цикл модулей (jointLimits типы берёт отсюда). */
let _extraLimit: ((bone: string) => LimitView | null) | null = null;
export function registerExtraLimits(fn: (bone: string) => LimitView | null): void { _extraLimit = fn; }
export function limitViewForBone(humanBone: string): LimitView | null {
  // Ф21.4: ЯВНАЯ ТАБЛИЦА ВЫИГРЫВАЕТ у физ-рига. Раньше было наоборот, и это врало на костях,
  // КОТОРЫЕ ФИЗИКА СЛИВАЕТ В ОДНО ТЕЛО: `RETARGET.ArmR = [RightShoulder, RightUpperArm]`, поэтому КЛЮЧИЦА
  // получала пределы ПЛЕЧЕВОГО сустава (±97° сгиб, ±69° развод) и работала как второе плечо.
  // ЗАМЕР: тянешь правую кисть налево — ключица выкручивалась на 89.5°, а спина — на 0°. Отсюда «корпус не скручивается».
  // Порядок безопасен: в явной таблице лежат только кости, чьи пределы заданы анатомично и адресно.
  const own = _extraLimit ? _extraLimit(humanBone) : null;
  if (own) return own;
  const rag = RAG_OF_HUMAN[humanBone];
  return rag ? jointLimitView(rag) : null;
}
/** Всё для клэмпа/гизмо предела на суставе `ragName`: оси (лок., T-поза) + ЭФФЕКТИВНЫЕ диапазоны (× групповой LIMITS). */
export interface LimitView {
  kind: 'swing' | 'hinge'; group: MGroup; canon: string;
  twist?: Vec3; plane?: Vec3; normal?: Vec3;   // swing оси (лок. фрейм родителя, T-поза)
  planeMin?: number; planeMax?: number; normalMin?: number; normalMax?: number; twistMin?: number; twistMax?: number;   // swing диапазоны
  axis?: Vec3; hingeNormal?: Vec3; min?: number; max?: number;   // hinge
}
export function jointLimitView(ragName: string): LimitView | null {
  const b = _bBone.get(ragName); if (!b || !b.con) return null;
  const canon = CANON[ragName]; if (!canon) return null;
  const e = effJoint(canon), c = b.con, L = LIMITS[b.group] * (b.limScale ?? 1);   // Ф28.1: доля сегмента — и в клэмпе манекена тоже
  if (c.kind === 'swing') {
    // Оси — этой кости (правая уже зеркальна в B[]). Диапазоны — канон (левая конвенция) × L. Для СИММЕТРИЧНЫХ
    // дефолтов зеркальные оси дают верное L/R автоматически; асимметрия (юзер-тюн) калибруется отдельно (Ф5).
    return {
      kind: 'swing', group: b.group, canon, twist: c.twist, plane: c.plane, normal: _cross(c.twist, c.plane),
      planeMin: e.planeMin! * L, planeMax: e.planeMax! * L, normalMin: e.normalMin! * L, normalMax: e.normalMax! * L, twistMin: e.twistMin! * L, twistMax: e.twistMax! * L,
    };
  }
  const [lo, hi] = hingeLimits(c.lim, e);
  return { kind: 'hinge', group: b.group, canon, axis: c.axis, hingeNormal: c.normal, min: lo * L, max: hi * L };
}
/** Загрузить лимиты/моторы (localStorage `pe_ragdoll`, ГЛОБАЛЬНО на всех) в LIMITS/MOTOR — ЗВАТЬ ДО создания рэгдолла. */
export function loadRagdollConfig(): void {
  try {
    const c = JSON.parse(localStorage.getItem('pe_ragdoll') || '{}') as { limits?: Partial<Record<MGroup, number>>; motor?: Partial<Record<MGroup, [number, number]>>; joints?: Record<string, Record<string, number>>; physrig?: { id?: string; bodies?: string[] }; sizes?: Record<string, PhysSize> };
    for (const k in PHYS_SIZES) delete PHYS_SIZES[k];
    if (c.sizes) for (const k in c.sizes) PHYS_SIZES[k] = { ...c.sizes[k]! };   // РАЗМЕРЫ ЧИТАЮТСЯ ДО applyPhysProfile — именно он их впекает в активный набор
    // Набор тел живёт ЗДЕСЬ, а не отдельным ключом: у него тот же жизненный цикл, что у лимитов и моторов
    // (правка = пересборка куклы), и лишний round-trip на сервер не нужен.
    // МИГРАЦИЯ Ф28.1: список тел, сохранённый ДО разделения, новых имён не знает — без этого
    // ключицы и сегменты спины молча остались бы выключены, и цепи слились бы обратно (`resolvePhysSet`
    // складывает цепь выключенного предка в потомка) — то есть правка бы «не применилась» без всякой ошибки.
    const saved = c.physrig?.bodies?.length ? [...c.physrig.bodies] : null;
    if (saved && !saved.includes('ClavL')) for (const n of ['Chest', 'UpperChest', 'ClavL', 'ClavR']) if (!saved.includes(n)) saved.push(n);
    if (saved) applyPhysProfile(saved);
    else applyPhysProfile(undefined, c.physrig?.id ?? 'base');   // пресет по тирам — новые core-тела попадают сами
    const gs: MGroup[] = ['leg', 'arm', 'core', 'head'];
    if (c.limits) for (const g of gs) if (typeof c.limits[g] === 'number') LIMITS[g] = c.limits[g]!;
    if (c.motor) for (const g of gs) if (Array.isArray(c.motor[g])) MOTOR[g] = c.motor[g]!;
    for (const k in jointOv) delete jointOv[k];
    if (c.joints) for (const k in c.joints) {
      const j = { ...c.joints[k]! } as Record<string, number>;
      if (j.pCone !== undefined) { j.planeMin = -j.pCone; j.planeMax = j.pCone; delete j.pCone; }   // миграция: старый симм. конус → асимм.
      if (j.nCone !== undefined) { j.normalMin = -j.nCone; j.normalMax = j.nCone; delete j.nCone; }
      jointOv[k] = j as Partial<JointLim>;
    }
  } catch { /* */ }
}
export function saveRagdollConfig(): void {
  try { localStorage.setItem('pe_ragdoll', JSON.stringify({ limits: { ...LIMITS }, motor: { ...MOTOR }, joints: { ...jointOv }, physrig: { id: PHYS_SET.id, bodies: PHYS_SET.bodies }, sizes: { ...PHYS_SIZES } })); } catch { /* */ }
}

export interface HumanoidRagdoll {
  group: THREE.Group;                                     // призрак-меши (полупрозрачные)
  /** Задать целевые локальные повороты физ-костей (эйлер по индексу). null-элемент = покой. */
  setTarget(target: (Vec3 | null)[]): void;
  /** Цель из АВТОРСКОЙ humanoid-позы (эйлеры костей) через ретаргет. */
  setPoseTarget(pose: Record<string, [number, number, number]>): void;
  /** Мировой транзформ таза (kinematic-авторитет) — обычно = Hips манекена. */
  setPelvis(pos: THREE.Vector3, quat: THREE.Quaternion): void;
  /** Мировые цели ПИНОВ по индексу физ-кости (обычно = мир-позиции суставов манекена). null = без пина. */
  setPinTargets(targets: (THREE.Vector3 | null)[]): void;
  /** Per-bone веса: pin (позиц. подтяжка) и muscle (ведение к позе), по имени физ-кости. */
  setWeights(name: string, pin: number, muscle: number): void;
  /** Доп. вес (кг) на кость — вес оружия оттягивает кисть. */
  setLoad(name: string, kg: number): void;
  /** Дёрг: импульс в кость (мир-направление·сила). */
  hit(name: string, dx: number, dy: number, dz: number, power?: number): void;
  /** Смерть: моторы off + таз dynamic + пины off → свободный коллапс (и обратно). */
  setDead(d: boolean): void;
  /** Жёстко поставить тела на текущую позу-цель + обнулить скорости (спавн без перехлёста T-поза→стойка). */
  snapToPose(): void;
  /**
   * Ф27.6 — ПОКАЗАТЬ ФОРМЫ НА ЗАДАННОМ СКЕЛЕТЕ (отладочный оверлей редактора), а не в СЫРОМ
   * физ-пространстве. Сырые тела НЕ заземлены и не блендятся к позе по `match`, поэтому оверлей
   * висел ниже призрака и стоял под другим углом (замер: 1.15u по высоте, 1.2–14.8° по углу).
   * `null` — вернуться к сырому физ-состоянию (дебаг взрывов куклы).
   */
  poseShapes(src: Humanoid | null): void;
  /** Окно-culling: on=false → RemoveFromPhysicsSystem (тела вон из pw.step); on=true → AddToPhysicsSystem+Activate. */
  setSimEnabled(on: boolean): void;
  update(dt: number): void;                               // ведём к цели + двигаем kinematic-таз + синк мешей
  bodyPos(name: string): [number, number, number];        // мировая позиция тела (дебаг/тест)
  /** Снять ФИЗ-результат как humanoid-позу (локальные эйлеры костей) — для запекания. */
  readBakedPose(): Record<string, [number, number, number]>;
  dispose(): void;
}

const _AX_V: THREE.Vector3[] = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const _UP_SHAPE = new THREE.Vector3(0, 1, 0);
/**
 * Разворот формы — ВДОЛЬ ФАКТИЧЕСКОГО НАПРАВЛЕНИЯ ТЕЛА (`off`), а не по доминантной оси.
 *
 * Цилиндр и капсула в Jolt и three заданы по Y — их исходная ось Y. У БОКСА исходная ось — его СОБСТВЕННАЯ
 * длинная полуось (`bodyAxis`), туда же `sized()` кладёт длину. Сфера симметрична — её не крутим.
 *
 * БОКС РАНЬШЕ НЕ КРУТИЛСЯ ВОВСЕ, и это было видно на глаз: у атласного рига бедро идёт
 * `[3.03, −16.27, 2.59]` (наискосок внаружу и вперёд), а бокс висел СТРОГО ВЕРТИКАЛЬНО — жалоба
 * «физ-тела должны повторять угол поворота кости, а не просто боксиком быть вертикальным».
 */
export function shapeOff(b: { off: Vec3; pos?: Vec3 }): Vec3 {
  const p = b.pos; return p ? [b.off[0] + p[0], b.off[1] + p[1], b.off[2] + p[2]] : b.off;
}
const _srE = new THREE.Euler(), _srQ = new THREE.Quaternion();
function shapeRot(b: { off: Vec3; shape: PhysShape; rot?: Vec3 }): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (b.shape.k === 'sphere') return q;                       // шар симметричен — разворот бессмыслен
  const round = b.shape.k === 'cylinder' || b.shape.k === 'capsule' || b.shape.k === 'taper';
  const from = round ? _UP_SHAPE : _AX_V[bodyAxis(b)]!;       // исходная ось формы
  const d = new THREE.Vector3(b.off[0], b.off[1], b.off[2]);
  if (d.lengthSq() > 1e-8) q.setFromUnitVectors(from, d.normalize());
  else if (round) q.setFromUnitVectors(_UP_SHAPE, _AX_V[bodyAxis(b)]!);   // тело без выноса (таз): по доминантной
  // Ручной доворот (Ф28.2) — СЛЕВА, то есть в ФРЕЙМЕ ТЕЛА (оси кости), а не в собственных осях формы:
  // так «повернуть вокруг X» значит вокруг X КОСТИ и не зависит от выбранной формы.
  if (b.rot && (b.rot[0] || b.rot[1] || b.rot[2])) { _srE.set(b.rot[0], b.rot[1], b.rot[2]); q.premultiply(_srQ.setFromEuler(_srE)); }
  return q;
}
export function makeHumanoidRagdoll(pw: PhysWorld): HumanoidRagdoll {
  const J = jolt();
  const group = new THREE.Group();

  // ── Формы (смещённые от сустава) ──
  const shapes = B.map((b) => {
    const s = b.shape;
    let inner;
    if (s.k === 'sphere') inner = new J.SphereShapeSettings(s.r);
    else if (s.k === 'capsule') inner = new J.CapsuleShapeSettings(s.half, s.r);
    else if (s.k === 'cylinder') inner = new J.CylinderShapeSettings(s.half, s.r);
    // ВЕРХ КОНУСА — ДАЛЬНИЙ КОНЕЦ: `shapeRot` ведёт +Y формы на направление `off`, то есть от сустава наружу.
    else if (s.k === 'taper') inner = new J.TaperedCapsuleShapeSettings(s.half, s.r2, s.r);
    else { const h = new J.Vec3(s.h[0], s.h[1], s.h[2]); inner = new J.BoxShapeSettings(h, 0.2); J.destroy(h); }
    inner.mDensity = DENSITY;
    const so = shapeOff(b);                                  // Ф28.2: кость + ручная доводка
    const off = new J.Vec3(so[0], so[1], so[2]);
    const rq = shapeRot(b);
    const rot = new J.Quat(rq.x, rq.y, rq.z, rq.w);
    const shape = new J.RotatedTranslatedShapeSettings(off, rot, inner).Create().Get();
    J.destroy(rot); J.destroy(off);
    return shape;
  });

  // ── Скелет ──
  const skeleton = new J.Skeleton();
  for (const b of B) { const nm = new J.JPHString(b.name, b.name.length); skeleton.AddJoint(nm, b.parentIdx); J.destroy(nm); }

  // ── Суставы ──
  const makeCon = (b: ActiveBone): InstanceType<JoltNS['TwoBodyConstraintSettings']> => {
    const [ax, ay, az] = b.anchor;
    const [freq, torque] = MOTOR[b.group]; const L = LIMITS[b.group] * (b.limScale ?? 1);   // множитель группы (RB3) × доля сегмента (Ф28.1)
    const c = b.con!;
    const canon = CANON[b.name]; const e = canon ? effJoint(canon) : null;   // пер-сустав оверрайд (симметрия L/R) поверх базы
    const spring = (m: InstanceType<JoltNS['MotorSettings']>): void => {
      m.mSpringSettings.mMode = J.ESpringMode_FrequencyAndDamping;
      m.mSpringSettings.mFrequency = freq; m.mSpringSettings.mDamping = b.damp;
      m.mMinTorqueLimit = -torque; m.mMaxTorqueLimit = torque;
    };
    if (c.kind === 'hinge') {
      const s = new J.HingeConstraintSettings();
      const p1 = new J.RVec3(ax, ay, az), p2 = new J.RVec3(ax, ay, az);
      const h1 = new J.Vec3(...c.axis), h2 = new J.Vec3(...c.axis);
      const n1 = new J.Vec3(...c.normal), n2 = new J.Vec3(...c.normal);
      s.mPoint1 = p1; s.mPoint2 = p2; s.mHingeAxis1 = h1; s.mHingeAxis2 = h2; s.mNormalAxis1 = n1; s.mNormalAxis2 = n2;
      const [lo, hi] = hingeLimits(c.lim, e);
      s.mLimitsMin = clamp(lo * L, -3.1, 3.1); s.mLimitsMax = clamp(hi * L, -3.1, 3.1);
      spring(s.mMotorSettings);
      J.destroy(p1); J.destroy(p2); J.destroy(h1); J.destroy(h2); J.destroy(n1); J.destroy(n2);
      return s;
    }
    const s = new J.SwingTwistConstraintSettings();
    const p1 = new J.RVec3(ax, ay, az), p2 = new J.RVec3(ax, ay, az);
    const t1 = new J.Vec3(...c.twist), t2 = new J.Vec3(...c.twist);
    const pl1 = new J.Vec3(...c.plane), pl2 = new J.Vec3(...c.plane);
    s.mPosition1 = p1; s.mPosition2 = p2; s.mTwistAxis1 = t1; s.mTwistAxis2 = t2; s.mPlaneAxis1 = pl1; s.mPlaneAxis2 = pl2;
    s.mSwingType = J.ESwingType_Pyramid;
    // Jolt-конус СИММЕТРИЧЕН по осям — берём макс. полу-угол из асимм. диапазона (физика приближённо; точный
    // асимм. предел — на манекене через FK-клэмп/гизмо). Твист Jolt поддерживает асимметрию напрямую.
    const pMin = e?.planeMin ?? c.planeLim[0], pMax = e?.planeMax ?? c.planeLim[1];
    const nMin = e?.normalMin ?? c.normalLim[0], nMax = e?.normalMax ?? c.normalLim[1];
    const tmin = e?.twistMin ?? c.twistLim[0], tmax = e?.twistMax ?? c.twistLim[1];
    s.mPlaneHalfConeAngle = clamp(Math.max(Math.abs(pMin), Math.abs(pMax)) * L, 0, 3.0);
    s.mNormalHalfConeAngle = clamp(Math.max(Math.abs(nMin), Math.abs(nMax)) * L, 0, 3.0);
    s.mTwistMinAngle = clamp(tmin * L, -3.1, 3.1); s.mTwistMaxAngle = clamp(tmax * L, -3.1, 3.1);
    spring(s.mSwingMotorSettings); spring(s.mTwistMotorSettings);
    J.destroy(p1); J.destroy(p2); J.destroy(t1); J.destroy(t2); J.destroy(pl1); J.destroy(pl2);
    return s;
  };

  // ── Части ──
  const settings = new J.RagdollSettings();
  settings.mSkeleton = skeleton;
  settings.mParts.resize(B.length);
  for (let i = 0; i < B.length; i++) {
    const b = B[i]!;
    const part = settings.mParts.at(i);
    const pos = new J.RVec3(b.anchor[0], b.anchor[1], b.anchor[2]);
    const rot = new J.Quat(0, 0, 0, 1);
    part.SetShape(shapes[i]!);
    part.mPosition = pos; part.mRotation = rot;
    part.mMotionType = i === 0 ? J.EMotionType_Kinematic : J.EMotionType_Dynamic;
    part.mObjectLayer = LAYER_DOLL;
    part.mAllowSleeping = false;
    if (b.con) part.mToParent = makeCon(b);
    J.destroy(rot); J.destroy(pos);
  }
  settings.Stabilize();
  settings.DisableParentChildCollisions();
  settings.CalculateBodyIndexToConstraintIndex();
  const ragdoll = settings.CreateRagdoll(0, 0, pw.system);
  ragdoll.AddToPhysicsSystem(J.EActivation_Activate);

  const ids = B.map((_, i) => new J.BodyID(ragdoll.GetBodyID(i).GetIndexAndSequenceNumber()));   // копируем BodyID

  // ── Поза покоя (локальные смещения костей) ──
  const pose = new J.SkeletonPose();
  pose.SetSkeleton(skeleton);
  for (let i = 0; i < B.length; i++) {
    const b = B[i]!;
    const p: Vec3 = b.parentIdx < 0 ? [0, 0, 0] : B[b.parentIdx]!.anchor;
    const js = pose.GetJoint(i);
    js.mTranslation.Set(b.anchor[0] - p[0], b.anchor[1] - p[1], b.anchor[2] - p[2]);
    js.mRotation.Set(0, 0, 0, 1);
  }

  // ── Призрак-меши (полупрозрачные, поверх кинематического манекена) ──
  const ghostMat = new THREE.MeshStandardMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.45, roughness: 0.5 });
  const meshes = B.map((b) => {
    const s = b.shape;
    const geo = s.k === 'sphere' ? new THREE.SphereGeometry(s.r, 12, 10)
      : s.k === 'capsule' ? new THREE.CapsuleGeometry(s.r, s.half * 2, 4, 10)
      : s.k === 'cylinder' ? new THREE.CylinderGeometry(s.r, s.r, s.half * 2, 12)
      : s.k === 'taper' ? new THREE.CylinderGeometry(s.r2, s.r, s.half * 2, 12)
      : new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2);
    if (s.k !== 'sphere') geo.applyQuaternion(shapeRot(b));   // разворот запекаем в геометрию (И ДЛЯ БОКСА) — меш ведётся кватернионом тела
    const m = new THREE.Mesh(geo, ghostMat); group.add(m); return m;
  });
  const offs = B.map((b) => new THREE.Vector3(...shapeOff(b)));   // Ф28.2: то же смещение, что у физ-формы

  const kPos = new J.RVec3(0, 0, 0), kRot = new J.Quat(0, 0, 0, 1), force = new J.Vec3(0, 0, 0);
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion(), e = new THREE.Euler(), tmp = new THREE.Vector3();
  const _psP = new THREE.Vector3();   // Ф27.6: мир-позиция кости-анкера для `poseShapes`
  const wq = B.map(() => new THREE.Quaternion()), invQ = new THREE.Quaternion(), locQ = new THREE.Quaternion(), eb = new THREE.Euler();
  let target: (Vec3 | null)[] = B.map(() => null);
  let pinTargets: (THREE.Vector3 | null)[] = B.map(() => null);
  const pinW = B.map(() => 1), muscleW = B.map(() => 1);   // per-bone веса
  const limp = B.map(() => 0);                             // 0..1 временная «отпущенность» (дёрг от удара, затухает)
  const load = B.map(() => 0);                             // доп. вес (кг) на кость — оружие оттягивает кисть
  let dead = false;
  const pelvisPos = new THREE.Vector3(0, PELVIS_Y, 0), pelvisQuat = new THREE.Quaternion();
  const conState = (c: ReturnType<typeof ragdoll.GetConstraint>, state: number): void => {
    if (c.GetSubType() === J.EConstraintSubType_SwingTwist) { const st = J.castObject(c, J.SwingTwistConstraint); st.SetSwingMotorState(state); st.SetTwistMotorState(state); }
    else if (c.GetSubType() === J.EConstraintSubType_Hinge) J.castObject(c, J.HingeConstraint).SetMotorState(state);
  };
  const setMotors = (state: number): void => { for (let i = 0; i < ragdoll.GetConstraintCount(); i++) conState(ragdoll.GetConstraint(i), state); };
  // Мотор одной кости (индекс сустава = индекс кости − 1, т.к. таз без сустава). Off = кость свободна (дёрг виден).
  const setBoneMotor = (bi: number, on: boolean): void => conState(ragdoll.GetConstraint(bi - 1), on ? J.EMotorState_Position : J.EMotorState_Off);

  /**
   * Ф27.6 — формы на КОСТЯХ заданного рига. Фрейм тела: ПОЗИЦИЯ — первая кость его цепи
   * (там же анкер), ПОВОРОТ — ПОСЛЕДНЯЯ (именно её мировой угол ведёт `retargetHumanoidPose`).
   * Смещение формы крутится тем же кватернионом — ровно как в `sync()` с физ-телом.
   */
  function poseShapes(src: Humanoid | null): void {
    if (!src) { sync(); return; }
    for (let i = 0; i < meshes.length; i++) {
      const b = B[i]!, chain = RETARGET[b.name] ?? [b.name];
      const first = src.bones.get(chain[0]!); if (!first) continue;
      const last = src.bones.get(chain[chain.length - 1]!) ?? first;
      const m = meshes[i]!;
      last.getWorldQuaternion(m.quaternion);
      first.getWorldPosition(_psP);
      tmp.copy(offs[i]!).applyQuaternion(m.quaternion);
      m.position.set(_psP.x + tmp.x, _psP.y + tmp.y, _psP.z + tmp.z);
    }
  }
  function sync(): void {
    for (let i = 0; i < meshes.length; i++) {
      const p = pw.bi.GetPosition(ids[i]!), r = pw.bi.GetRotation(ids[i]!);
      const m = meshes[i]!;
      m.quaternion.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
      tmp.copy(offs[i]!).applyQuaternion(m.quaternion);
      m.position.set(p.GetX() + tmp.x, p.GetY() + tmp.y, p.GetZ() + tmp.z);
    }
  }
  sync();
  let simOn = true;   // окно-culling: тела в физ-мире (pw.step считает). false → RemoveFromPhysicsSystem, меш замерзает.

  return {
    group,
    setTarget(t) { target = t; },
    setPoseTarget(p) { target = retargetHumanoidPose(p); },
    setPelvis(pos, quat) { if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) { pelvisPos.copy(pos); pelvisQuat.copy(quat); } },
    setPinTargets(t) { pinTargets = t; },
    poseShapes,
    setWeights(name, pin, muscle) { const i = RAG_INDEX[name]; if (i !== undefined) { pinW[i] = pin; muscleW[i] = muscle; } },
    setLoad(name, kg) { const i = RAG_INDEX[name]; if (i !== undefined) load[i] = kg; },
    hit(name, dx, dy, dz, power = 1) {
      const i = RAG_INDEX[name]; if (i === undefined) return;
      const s = 9000 * power; force.Set(dx * s, dy * s, dz * s); pw.bi.AddImpulse(ids[i]!, force);
      // «отпустить» задетую зону (верх тела), чтобы дёрг был виден и затем вернулся пинами
      for (const n of ['Torso', 'Chest', 'UpperChest', 'Head', 'ClavL', 'ClavR', 'ArmL', 'ArmR', 'ForeL', 'ForeR', 'HandL', 'HandR']) { const k = RAG_INDEX[n]; if (k !== undefined) limp[k] = 1; }
    },
    setDead(d) {
      if (d === dead) return; dead = d;
      setMotors(d ? J.EMotorState_Off : J.EMotorState_Position);
      pw.bi.SetMotionType(ids[0]!, d ? J.EMotionType_Dynamic : J.EMotionType_Kinematic, J.EActivation_Activate);
    },
    snapToPose() {   // жёстко на позу-цель (SetPose) + скорости в ноль — старт сразу в стойке, без флейла
      const root = pose.GetJoint(0);
      root.mTranslation.Set(pelvisPos.x, pelvisPos.y, pelvisPos.z); root.mRotation.Set(pelvisQuat.x, pelvisQuat.y, pelvisQuat.z, pelvisQuat.w);
      for (let i = 1; i < B.length; i++) {
        const t = target[i];
        if (t) { e.set(t[0], t[1], t[2]); q.setFromEuler(e); pose.GetJoint(i).mRotation.Set(q.x, q.y, q.z, q.w); }
        else pose.GetJoint(i).mRotation.Set(0, 0, 0, 1);
      }
      kPos.Set(0, 0, 0); pose.SetRootOffset(kPos); pose.CalculateJointMatrices();
      ragdoll.SetPose(pose, true);
      force.Set(0, 0, 0);
      for (let i = 0; i < B.length; i++) { pw.bi.SetLinearVelocity(ids[i]!, force); pw.bi.SetAngularVelocity(ids[i]!, force); }
    },
    setSimEnabled(on) {   // окно-culling: вон из/в физ-мир (pw.step). Пробуждённого тут же активируем — снап к позе делает вызывающий (snapNext).
      if (on === simOn) return; simOn = on;
      if (on) ragdoll.AddToPhysicsSystem(J.EActivation_Activate);
      else ragdoll.RemoveFromPhysicsSystem();
    },
    update(dt) {
      for (let i = 0; i < B.length; i++) if (limp[i]! > 0) limp[i] = Math.max(0, limp[i]! - dt / 0.4);   // дёрг затухает ~0.4с
      const root = pose.GetJoint(0);
      root.mTranslation.Set(pelvisPos.x, pelvisPos.y, pelvisPos.z); root.mRotation.Set(pelvisQuat.x, pelvisQuat.y, pelvisQuat.z, pelvisQuat.w);
      for (let i = 1; i < B.length; i++) {
        const t = target[i];
        if (t) {
          e.set(t[0], t[1], t[2]); q.setFromEuler(e);
          const mw = clamp(muscleW[i]! * PHYS.muscle * (1 - limp[i]!), 0, 1);   // вес мышцы (и временный дёрг): слабая мышца ведёт меньше
          if (mw < 0.999) { qi.identity(); qi.slerp(q, mw); q.copy(qi); }
          pose.GetJoint(i).mRotation.Set(q.x, q.y, q.z, q.w);
        } else pose.GetJoint(i).mRotation.Set(0, 0, 0, 1);
      }
      kPos.Set(0, 0, 0); pose.SetRootOffset(kPos); pose.CalculateJointMatrices();
      if (!dead) {
        ragdoll.DriveToPoseUsingMotors(pose);
        for (let i = 1; i < B.length; i++) setBoneMotor(i, limp[i]! < 0.5);   // отпущенные кости — мотор off (дёрг), вернулись — on
      }
      // ПИНЫ (PuppetMaster-стиль): пружина AddForce тянет тело к позиции цели — держит силуэт, убирает провисание.
      if (!dead && PHYS.pin > 0) {
        for (let i = 1; i < B.length; i++) {
          const tp = pinTargets[i]; const w = pinW[i]! * PHYS.pin * (1 - limp[i]!);
          if (!tp || w <= 0) continue;
          const bp = pw.bi.GetPosition(ids[i]!), bv = pw.bi.GetLinearVelocity(ids[i]!);
          force.Set(((tp.x - bp.GetX()) * PHYS.pinKp - bv.GetX() * PHYS.pinKd) * w * dt,   // импульс = сила·dt (AddImpulse надёжнее биндинга AddForce)
            ((tp.y - bp.GetY()) * PHYS.pinKp - bv.GetY() * PHYS.pinKd) * w * dt,
            ((tp.z - bp.GetZ()) * PHYS.pinKp - bv.GetZ() * PHYS.pinKd) * w * dt);
          pw.bi.AddImpulse(ids[i]!, force);
        }
      }
      if (!dead && PHYS.load > 0) {   // вес оружия: доп. гравитация на нагруженную кисть → руку оттягивает
        for (let i = 1; i < B.length; i++) { const ld = load[i]!; if (ld > 0) { force.Set(0, -ld * GRAV * PHYS.load * dt, 0); pw.bi.AddImpulse(ids[i]!, force); } }
      }
      kPos.Set(pelvisPos.x, pelvisPos.y, pelvisPos.z); kRot.Set(pelvisQuat.x, pelvisQuat.y, pelvisQuat.z, pelvisQuat.w);
      if (!dead) pw.bi.MoveKinematic(ids[0]!, kPos, kRot, dt);
      sync();
    },
    // ⚠ БЕЗ ОКРУГЛЕНИЯ. Было `toFixed(1)` — и это ловушка: функция задумывалась «дебаг/тест», но
    // `renderRagdollGhost` строит на ней МИРОВУЮ ВЫСОТУ ТАЗА призрака, то есть того, что видит игрок.
    // ЗАМЕР на бегу: таз призрака принимал 6 РАЗНЫХ значений на 181 кадр (манекен — 176), то есть боб
    // шёл лестницей по 0.1 ед. Это и читалось как «боб происходит резко».
    bodyPos(name) { const i = RAG_INDEX[name]!; const p = pw.bi.GetPosition(ids[i]!); return [p.GetX(), p.GetY(), p.GetZ()]; },
    readBakedPose() {
      const out: Record<string, [number, number, number]> = {};
      for (let i = 0; i < B.length; i++) { const r = pw.bi.GetRotation(ids[i]!); wq[i]!.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW()); }
      eb.setFromQuaternion(wq[0]!); out['Hips'] = [eb.x, eb.y, eb.z];   // таз (мировой = кинематический)
      for (let i = 1; i < B.length; i++) {
        invQ.copy(wq[B[i]!.parentIdx]!).invert(); locQ.copy(invQ).multiply(wq[i]!);   // локальный поворот = parent⁻¹·world
        eb.setFromQuaternion(locQ);
        const prim = PRIMARY[B[i]!.name]; if (prim) out[prim] = [+eb.x.toFixed(4), +eb.y.toFixed(4), +eb.z.toFixed(4)];
      }
      return out;
    },
    dispose() {
      if (simOn) ragdoll.RemoveFromPhysicsSystem();   // спящий (окно-culling) уже вынут — второй Remove крашит wasm
      // формы/settings/ragdoll не destroy'им (кэш/крэш wasm) — утечка копеечная
      J.destroy(pose);
      for (const m of meshes) m.geometry.dispose();
      group.clear();
    },
  };
}

// ── ЕДИНЫЙ РЕНДЕР ФИЗ-ПРИЗРАКА (редактор + игра) ─────────────────────────────────────
const _gq = new THREE.Quaternion(), _gqT = new THREE.Quaternion(), _geu = new THREE.Euler();
// Кости ног МЕША — их ведём ровно позой (match=1), а не физ-блендом: рагдолл фикс-геометрии искажает ноги splay-меша (P4).
const LEG_MESH = new Set(['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes']);

/** Состояние заземления призрака — сглаженный вертикальный сдвиг корня. По одному на куклу/призрак. */
export interface GhostGround { off: number }
export const newGhostGround = (): GhostGround => ({ off: 0 });


/**
 * Ведём humanoid-МЕШ результатом рэгдолла: `readBakedPose()` → локальные повороты костей,
 * `bodyPos('Hips')` → мир-позиция корня, + ЗАЗЕМЛЕНИЕ низшей стопы к полу. Реконструкция 21-костного
 * меша из 15-костной физики чуть промахивается по длине ног (стопа уходит вниз) — прижим корня по
 * низшей стопе это чинит (сглажено, чтобы не дёргалось). ОДИН код для редакторного призрака и игровой куклы.
 * @param floorY уровень пола (0 в редакторе и в игре — верх статики на y=0).
 * @param ground true на стоянке/беге (клампить стопу к полу); false на смерти/полёте (прижим затухает, физика летит).
 * @param targetPose 21-костная поза-цель (манекен) для бленда; null → чистая физика.
 * @param match 0..1 — вес совпадения с манекеном (RB2): 0 = физрезультат, 1 = ровно поза-цель (физика лишь для реакций/ударов).
 * @param groundAt высота пола (мир) в точке XZ — рейкаст. Не задан → плоский floorY. FOOT-IK ставит стопу на этот пол.
 * @param support [лев, прав] — какая нога ОПОРНАЯ (из позы: !swing). Заземляем/кладём плоско ТОЛЬКО опорные, маховую
 *   ведёт поза (носок задран). Не задан → эвристика по высоте стопы.
 */
export function renderRagdollGhost(
  mesh: Humanoid, rag: HumanoidRagdoll, gs: GhostGround, dt: number, floorY = 0, ground = true,
  targetPose: Record<string, [number, number, number]> | null = null, match = 0, groundAt?: GroundQuery,
  support?: [boolean, boolean], footIk = true, gOpts?: GroundOpts,
): void {
  const gnd = groundAt ?? ((): number => floorY);
  const bp = rag.readBakedPose(); mesh.reset();
  if (match > 0.001 && targetPose) {   // БЛЕНД физрезультат → цель по match: точное совпадение с манекеном
    for (const nm in targetPose) {
      const b = mesh.bones.get(nm); if (!b) continue;
      const t = targetPose[nm]!; _geu.set(t[0], t[1], t[2]); _gqT.setFromEuler(_geu);   // цель (манекен)
      const baked = bp[nm];
      if (baked) { _geu.set(baked[0], baked[1], baked[2]); _gq.setFromEuler(_geu); } else _gq.copy(b.quaternion);   // физика (или покой у слитых костей)
      // НОГИ — ровно по позе (match=1): физ-рагдолл строится ФИКС-геометрией (ноги вертикально x=±4), а меш — со своей
      // (boneOffsets/приведение). readBakedPose даёт повороты относит. вертикального рест-рагдолла → на splay-меше ноги
      // РАСШИРЯЮТСЯ и «плывут пропорции» при match<1. Пока рагдолл не пересобран под геометрию (P4) — ведём ноги позой
      // (как в редакторе-манекене), верх тела — физ-бленд по match. Смерть/коллапс идут отдельной веткой (match=0, ниже).
      const m = LEG_MESH.has(nm) ? 1 : match;
      b.quaternion.copy(_gq).slerp(_gqT, m);
    }
  } else {
    for (const nm in bp) { const b = mesh.bones.get(nm); if (b) b.rotation.set(bp[nm]![0], bp[nm]![1], bp[nm]![2]); }
  }
  const hp = rag.bodyPos('Hips');
  if (!ground) gs.off += (0 - gs.off) * Math.min(1, dt * 8);         // смерть/полёт: прижим затухает
  mesh.setHipsWorld(hp[0], hp[1] + gs.off, hp[2]);   // Root ≠ таз: физика задаёт положение ТАЗА, корень вычисляется из него
  mesh.root.updateMatrixWorld(true);
  if (ground && footIk) groundFeet(mesh, hp[1], gs, dt, gnd, support, gOpts);   // FOOT-IK: заземляем ОПОРНЫЕ стопы (poseLod дальних → пропуск)
}

/**
 * КИНЕМАТИЧЕСКИЙ рендер меша ПРЯМО из позы манекена (без физики) — debug-режим «кинематика монстров»:
 * повороты костей = `targetPose`, позиция корня = `hipWorld` (мир-таз позируемого манекена), + FOOT-IK опорных
 * стоп. Тела рэгдолла при этом ВОН из `pw.step`; физика включается лишь транзиентно на удар/смерть. Тот же
 * силуэт, что физ-путь при match=1 (kinematic-таз = авторитет), но без per-тело моторов/пинов и интеграции.
 */
export function renderKinematicPose(
  mesh: Humanoid, targetPose: Record<string, [number, number, number]>, hipWorld: THREE.Vector3,
  gs: GhostGround, dt: number, gnd: GroundQuery, support?: [boolean, boolean], footIk = true, gOpts?: GroundOpts,
): void {
  mesh.reset();
  for (const nm in targetPose) { const b = mesh.bones.get(nm); if (b) b.rotation.set(targetPose[nm]![0], targetPose[nm]![1], targetPose[nm]![2]); }
  mesh.setHipsWorld(hipWorld.x, hipWorld.y + gs.off, hipWorld.z);   // то же для кинематической ветки (без физики)
  mesh.root.updateMatrixWorld(true);
  if (footIk) groundFeet(mesh, hipWorld.y, gs, dt, gnd, support, gOpts);   // FOOT-IK (poseLod дальних → пропуск: детали стоп не видно)
}
