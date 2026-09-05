/**
 * МОРФИНГ ТЕЛА (Ф8) — пер-персонажные пропорции, как в MetaHuman.
 *
 * ДВА СПОСОБА поменять форму тела, и мы используем оба:
 *
 *  1. КОСТИ. Меш прибит к костям скиннингом: удлинил бедро — нога длиннее, меш поехал следом; раздул
 *     кость по толщине — тело вокруг неё толще. Работает на ЛЮБОЙ модели, ничего от неё не требуя.
 *     Это фундамент и дефолт. Ограничение: объём получается «надуванием цилиндров».
 *
 *  2. МОРФ-ТАРГЕТЫ (blend shapes). Вторая версия позиций вершин того же меша, хранящаяся дельтами:
 *     вес 0 — исходный меш, 1 — целевой. Мы их НЕ создаём — их делает художник в CC/Daz/Blender,
 *     они приезжают внутри GLB. Наше дело — водить веса. Ограничение: их может не быть.
 *
 * Пропорции (рост, длины, ширины) — всегда костями. Объём (худой↔полный, мускулистость) — морфами,
 * если модель их несёт; иначе падаем на костный girth. UI честно показывает, какой слой активен.
 *
 * СТРУКТУРА как у MetaHuman Body Params: сначала пресеты (3×3), потом глобальные параметры, потом
 * замеры по РЕГИОНАМ; параметр можно ЗАКРЕПИТЬ (pin) — тогда пересчёт остальных его не трогает.
 *
 * ВАЖНО (инвариант Ф1.6): морф — свойство ПЕРСОНАЖА, а не анимации. В клип он не едет никогда,
 * иначе анимация «толстого» не ляжет на худого. Вариация персонажа = КОНФИГ на том же меше.
 *
 * Файл ЧИСТЫЙ — тестируется в node.
 */
import type { BodyProfile, BoneScale } from './bodyProfile.js';
import type { BuildScale } from './humanoid.js';

/** Все ручки морфа. Всё — множители вокруг 1 (1 = как в модели). */
export interface BodyMorph {
  // глобальные
  height?: number;          // общий рост
  weight?: number;          // худой ↔ полный (объём)
  // пропорции (длины звеньев)
  legs?: number; arms?: number; torso?: number; neck?: number;
  shoulders?: number;       // ширина плеч
  hips?: number;            // ширина таза
  // обхваты (толщина по регионам)
  chest?: number; waist?: number; armGirth?: number; legGirth?: number;
  // детали
  head?: number; hands?: number; feet?: number;
  // веса морф-таргетов меша по ИМЕНИ морфа в модели
  shapes?: Record<string, number>;
}

export const MORPH_KEYS = ['height', 'weight', 'legs', 'arms', 'torso', 'neck', 'shoulders', 'hips',
  'chest', 'waist', 'armGirth', 'legGirth', 'head', 'hands', 'feet'] as const;
export type MorphKey = typeof MORPH_KEYS[number];

/** Регионы для Про-панели — как «замеры по регионам» у MetaHuman. */
export const MORPH_REGIONS: readonly { label: string; keys: readonly MorphKey[] }[] = [
  { label: 'пропорции', keys: ['legs', 'arms', 'torso', 'neck', 'shoulders', 'hips'] },
  { label: 'обхваты', keys: ['chest', 'waist', 'armGirth', 'legGirth'] },
  { label: 'детали', keys: ['head', 'hands', 'feet'] },
];

export const DEFAULT_MORPH: Required<Omit<BodyMorph, 'shapes'>> = {
  height: 1, weight: 1, legs: 1, arms: 1, torso: 1, neck: 1, shoulders: 1, hips: 1,
  chest: 1, waist: 1, armGirth: 1, legGirth: 1, head: 1, hands: 1, feet: 1,
};

const val = (m: BodyMorph, k: MorphKey): number => m[k] ?? 1;

// ── Пресеты 3×3 (Простой режим: «всё меняется сразу») ────────────────────────────────────────────
export interface MorphPreset { id: string; label: string; morph: BodyMorph }
const H = { low: 0.92, mid: 1, tall: 1.08 };
const W = { thin: 0.85, mid: 1, heavy: 1.2 };
export const MORPH_PRESETS: readonly MorphPreset[] = (() => {
  const out: MorphPreset[] = [];
  for (const [hk, hv] of Object.entries(H)) for (const [wk, wv] of Object.entries(W)) {
    const hl = hk === 'low' ? 'низкий' : hk === 'mid' ? 'средний' : 'высокий';
    const wl = wk === 'thin' ? 'худой' : wk === 'mid' ? 'обычный' : 'плотный';
    out.push({ id: `${hk}_${wk}`, label: `${hl}/${wl}`, morph: { height: hv, weight: wv } });
  }
  return out;
})();

// ── Морф → существующие механизмы скелета ────────────────────────────────────────────────────────
/** Глобальный профиль (то, что уже умеет buildHumanoid). */
export function morphToProfile(m: BodyMorph): BodyProfile {
  return {
    height: val(m, 'height'),
    arm: val(m, 'arms'),
    leg: val(m, 'legs'),
    torso: val(m, 'torso'),
    girth: val(m, 'weight'),
  };
}

/** Толщина по группам (buildHumanoid.build). Вес множит всё, регионы уточняют. */
export function morphToBuild(m: BodyMorph): BuildScale {
  const w = val(m, 'weight');
  return {
    arm: val(m, 'armGirth') * w,
    leg: val(m, 'legGirth') * w,
    torso: ((val(m, 'chest') + val(m, 'waist')) / 2) * w,
    head: val(m, 'head'),
  };
}

/** Пер-костные множители ДЛИН для регионов, которых нет в общем профиле (шея/плечи/таз/кисти/стопы). */
export function morphToBoneScale(m: BodyMorph): BoneScale {
  const bs: BoneScale = {};
  const set = (bone: string, v: number): void => { if (Math.abs(v - 1) > 1e-6) bs[bone] = v; };
  set('Neck', val(m, 'neck'));
  set('Head', val(m, 'head'));
  set('LeftShoulder', val(m, 'shoulders')); set('RightShoulder', val(m, 'shoulders'));
  set('LeftUpperLeg', val(m, 'hips')); set('RightUpperLeg', val(m, 'hips'));   // офсет бедра = ширина таза
  set('LeftHand', val(m, 'hands')); set('RightHand', val(m, 'hands'));
  set('LeftToes', val(m, 'feet')); set('RightToes', val(m, 'feet'));
  return bs;
}

/** Слить морф с пропорциями, снятыми с модели (атлас), — они перемножаются. */
export function mergeBoneScale(atlas: BoneScale | undefined, morph: BoneScale): BoneScale {
  const out: BoneScale = { ...(atlas ?? {}) };
  for (const k in morph) out[k] = (out[k] ?? 1) * morph[k]!;
  return out;
}

// ── Слой морф-таргетов меша ──────────────────────────────────────────────────────────────────────
/** Синонимы имён морфов: что обычно называют «полнотой»/«мускулистостью» в CC/Daz/Blender. */
const SHAPE_ALIAS: Record<string, RegExp> = {
  weight: /(weight|fat|heavy|bulk|obese|body\s*size)/i,
  thin: /(thin|skinny|slim|lean)/i,
  muscular: /(muscul|muscl|athlet|ripped|buff)/i,   // 'muscl' НЕ ловит 'Muscular' (есть 'u' между c и l)
  pregnant: /(pregnan|belly)/i,
};
/** Найти в модели морфы, которыми мы умеем управлять: наша ручка → реальное имя морфа. */
export function findShapeMorphs(morphNames: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key in SHAPE_ALIAS) {
    const re = SHAPE_ALIAS[key]!;
    const hit = morphNames.find((n) => re.test(n));
    if (hit) out[key] = hit;
  }
  return out;
}
/**
 * Веса морф-таргетов из ручки «полнота». Если у модели есть отдельные `weight` и `thin`,
 * используем обе стороны; если только одна — работает половина диапазона, остальное добирает костный girth.
 */
export function weightToShapes(m: BodyMorph, found: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  const w = val(m, 'weight') - 1;                       // −0.15 худой … +0.2 полный
  if (found['weight'] && w > 0) out[found['weight']] = Math.min(1, w / 0.35);
  if (found['thin'] && w < 0) out[found['thin']] = Math.min(1, -w / 0.25);
  for (const k in m.shapes) out[k] = m.shapes[k]!;      // явные ручки Про-режима поверх
  return out;
}
/** Какой слой объёма реально работает для этой модели — это надо честно показывать в UI. */
export function volumeLayer(found: Record<string, string>): 'shapes' | 'bones' {
  return found['weight'] || found['thin'] ? 'shapes' : 'bones';
}

// ── Закрепление параметра (pin), как Body Params у MetaHuman ────────────────────────────────────
/**
 * Применить изменение одной ручки, не сдвигая ЗАКРЕПЛЁННЫЕ.
 * У нас ручки независимы, поэтому «закрепить» = запретить пресету/глобальной ручке их перезаписывать.
 */
export function applyMorphChange(cur: BodyMorph, patch: BodyMorph, pinned: ReadonlySet<string>): BodyMorph {
  const out: BodyMorph = { ...cur, shapes: { ...(cur.shapes ?? {}) } };
  for (const k of MORPH_KEYS) {
    if (patch[k] === undefined || pinned.has(k)) continue;
    out[k] = patch[k];
  }
  if (patch.shapes) for (const k in patch.shapes) if (!pinned.has('shape:' + k)) out.shapes![k] = patch.shapes[k]!;
  return out;
}

// ── Разброс для монстров: диапазоны + детерминированный сид ──────────────────────────────────────
export type MorphRange = Partial<Record<MorphKey, [number, number]>> & { shapes?: Record<string, [number, number]> };

/** Детерминированный ГПСЧ из строки: клиент и сервер получают ОДНОГО И ТОГО ЖЕ монстра по его id. */
export function seedRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => {
    h += 0x6d2b79f5; h >>>= 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Экземпляр морфа из диапазона по сиду (id монстра). Один id → всегда один и тот же вид. */
export function sampleMorph(range: MorphRange, seed: string): BodyMorph {
  const rnd = seedRandom(seed);
  const out: BodyMorph = {};
  for (const k of MORPH_KEYS) {
    const r = range[k]; if (!r) continue;
    out[k] = r[0] + (r[1] - r[0]) * rnd();
  }
  if (range.shapes) { out.shapes = {}; for (const k in range.shapes) { const r = range.shapes[k]!; out.shapes[k] = r[0] + (r[1] - r[0]) * rnd(); } }
  return out;
}

/** Слишком широкий разброс заметно меняет стойку/заземление — предупреждаем автора. */
export function rangeWarnings(range: MorphRange): string[] {
  const out: string[] = [];
  for (const k of MORPH_KEYS) {
    const r = range[k]; if (!r) continue;
    const spread = Math.abs(r[1] - r[0]) / 2;
    if (spread > 0.15) out.push(`${k}: разброс ±${(spread * 100).toFixed(0)}% — стойка и заземление будут заметно разными`);
  }
  return out;
}

// ── Вариация персонажа = КОНФИГ на том же меше ───────────────────────────────────────────────────
/** Персонаж-вариация: та же модель + набор чисел. Меш на сервере один, персонажей на нём сколько угодно. */
export interface MorphVariant { model: string; morph: BodyMorph }
export const isSameModel = (a: MorphVariant, b: MorphVariant): boolean => a.model === b.model;
