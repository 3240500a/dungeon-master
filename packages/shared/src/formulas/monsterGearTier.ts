import type { ConfigShapes } from '../config/schemas.js';

/**
 * СТУПЕНЬ СНАРЯЖЕНИЯ МОНСТРА — по СВОЕЙ лестнице `monster-gear-tiers`, отдельной от игроковой.
 *
 * ⚠ ЗАЧЕМ ВООБЩЕ СТУПЕНИ. До них `resolveGear` брал вещь строго по id шаблона и уровня не видел,
 * поэтому Зомби 40 уровня бил тем же «Ржавым топором» 4–9, что Зомби 2 уровня: атрибуты росли, а
 * оружие стояло. Урон монстра на лестнице уровней вырастал ×3.3 против ×17 у его же hp — отсюда
 * жалоба «бьют по 2–3, а надо 10–15».
 *
 * ⚠⚠ ЗАЧЕМ ЛЕСТНИЦА СВОЯ, А НЕ `item-tiers`. Сначала брали игроковую целиком — переиспользование
 * механизма казалось бесплатным. Два изъяна, оба замерены:
 *  1. ПОРОГИ СОВПАДАЛИ с игроковыми (8/18/30/45/62/80): весь этаж дорожал на +44 % урона ровно в
 *     тот уровень, когда игрок только начал собирать новую ступень. Кривая урон/hp из монотонной
 *     становилась пилой с размахом 1.4× внутри зуба. Хуже: уровень монстра считается от
 *     `effectiveLevel`, куда входят вещи В СУМКЕ, так что поднятая с пола находка переводила весь
 *     следующий этаж через порог.
 *  2. ЛЕСТНИЦА ИГРОКА КОНЧАЕТСЯ: t6 с 80 ур. и дальше флэт ×6, а забег идёт глубже. Выше 80
 *     монстры переставали расти по снаряжению вовсе, хотя игрок расти не переставал.
 * И главное — игрок растёт не только шмотом: у него скилы и пассивки, которых у монстра НЕТ, так
 * что разрыв копится в его пользу с каждым уровнем. Поэтому у монстров своя лестница: 20 ступеней,
 * порог у каждой свой, ранняя игра совпадает с прежней, а глубже они переодеваются чаще игрока.
 *
 * Множится то же, что у игрока (`TIER_SCALED` в `itemgen.ts`): урон оружия и защита брони.
 * ⚠ БЛОК ЩИТА — ПРОЦЕНТ, и ступенью НЕ множится: иначе лестница сама довела бы щит до 100 % блока,
 * а блок — один из трёх перемножающихся слоёв снижения.
 */

type GearTiers = ConfigShapes['monster-gear-tiers'];
type Gear = ConfigShapes['monster-gear'][number];
type GearWeapon = Extract<Gear, { kind: 'weapon' }>;
type GearArmor = Extract<Gear, { kind: 'armor' }>;
type GearShield = Extract<Gear, { kind: 'shield' }>;

/** Выбранная ступень: id и имя — для тултипа, `statMult` — множитель статов базы. */
export interface GearTier {
  id: string;
  name: string;
  statMult: number;
}

/** Поля ряда ступеней — есть у всех трёх видов снаряжения (`monsterGearSchema`). */
export interface TieredPiece {
  minGearTier: string;
  maxGearTier: string;
  withLevel: boolean;
}

/** Границы ряда по умолчанию — литералы без полей ступени ведут себя как полная лестница. */
const DEF_MIN = 'm0';
const DEF_MAX = 'm19';

/**
 * Ступень вещи по уровню монстра, зажатая её рядом [minGearTier, maxGearTier].
 *
 * Лестницы нет в вызове (тесты, старые инструменты) → `undefined`, и дальше ничего не множится:
 * поведение ровно такое, каким было до ступеней. `withLevel: false` прибивает вещь к её нижней
 * ступени — так «Костяной кинжал» остаётся хламом на любой глубине.
 *
 * ⚠ Ряд зажимается ПО ПОЛНОЙ лестнице, включая выключенные ступени, — как `pickTierClamped` у
 * игрока: иначе выключенный `maxGearTier` не находился бы и потолок вещи молча пропадал. А вот
 * ВЫБИРАЕТСЯ внутри ряда только включённая ступень (выключенную монстр не носит).
 */
export function pickGearTier(ladder: GearTiers | undefined, piece: Partial<TieredPiece>, level: number): GearTier | undefined {
  if (!ladder?.length) return undefined;
  // Порядок перекладин — по порогу, а не по порядку строк в конфиге.
  const rungs = [...ladder].sort((a, b) => a.fromLevel - b.fromLevel);
  const loRaw = rungs.findIndex((t) => t.id === (piece.minGearTier ?? DEF_MIN));
  const hiRaw = rungs.findIndex((t) => t.id === (piece.maxGearTier ?? DEF_MAX));
  const lo = loRaw < 0 ? 0 : loRaw;
  const hi = hiRaw < 0 ? rungs.length - 1 : hiRaw;
  const range = rungs.slice(Math.min(lo, hi), Math.max(lo, hi) + 1);
  const on = range.filter((t) => t.enabled !== false);
  const pool = on.length ? on : range;

  // Высшая доступная ступень ряда с порогом ≤ уровня; `withLevel: false` — всегда низшая в ряду.
  let pick = pool[0]!;
  if (piece.withLevel !== false) for (const t of pool) if (t.fromLevel <= level) pick = t;
  return { id: pick.id, name: pick.name, statMult: pick.statMult };
}

/** Ступень не выбрана или ничего не меняет — отдаём ту же вещь (ноль аллокаций на горячем пути). */
const flat = (t: GearTier | undefined): boolean => !t || t.statMult === 1;

/**
 * Урон оружия по ступени.
 *
 * ⚠⚠ ЗДЕСЬ НЕ ОКРУГЛЯЕМ, И ЭТО ВАЖНО. Ступень — ПРОМЕЖУТОЧНЫЙ МНОЖИТЕЛЬ, а не хранимая вещь:
 * квантовать её в целые незачем, а вред измерим. Округление на шве держалось «чтобы урон был
 * целым», но давало двум ДВОЙНИКАМ разную ошибку середины вилки: меч 4–8 ×1.3 → 5–10 (ДПС 7.50),
 * булава 5–10 ×1.3 → 7–13 (ДПС 8.00) при точных 7.8 у обоих — расхождение 6.7 % против правила
 * владельца ±5 %, а после деривации худший уровень давал 10.0 % против капа ±8 %. Без округления
 * здесь — 6.7 % и 0.17 % среднего, то есть ровно прежний шум деривации, под который кап и писался.
 * Целые числа приходят ниже по потоку: `deriveMonsterStats` округляет урон и сумму брони сам.
 *
 * ⚠ Округлять сумму вилки и разносить её по концам НЕЛЬЗЯ: проект это уже отверг для игрока
 * (`itemgen.ts`, «вещь выкатывалась за показанную вилку»), и монстры стали бы округляться иначе,
 * чем игрок.
 */
export function tierWeapon(w: GearWeapon, t: GearTier | undefined): GearWeapon {
  if (flat(t)) return w;
  return { ...w, minDamage: w.minDamage * t!.statMult, maxDamage: w.maxDamage * t!.statMult };
}

/** Защита брони/шлема по ступени (сумму брони округляет `deriveMonsterStats`). */
export function tierArmor(a: GearArmor, t: GearTier | undefined): GearArmor {
  if (flat(t) || !a.defense) return a;
  return { ...a, defense: a.defense * t!.statMult };
}

/** Защита щита по ступени; `block` — процент, не множится. */
export function tierShield(s: GearShield, t: GearTier | undefined): GearShield {
  if (flat(t) || !s.defense) return s;
  return { ...s, defense: s.defense * t!.statMult };
}
