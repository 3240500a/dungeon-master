/**
 * ХВАТ КИСТИ — ОТДЕЛЬНЫЙ КАНАЛ, а не часть клипа (Ф3.5).
 *
 * Индустриальный паттерн (UE Pose Asset, VR grip states): поза пальцев хранится отдельно от анимации
 * и накладывается поверх неё. Зачем именно так:
 *   • клипы НЕ переписываются при смене оружия — меч→лук меняет только хват;
 *   • клип остаётся лёгким и переносимым (30 лишних дорожек на каждую анимацию — это дорого и бессмысленно);
 *   • один и тот же удар работает с любым хватом.
 * На экспорте хват при желании ВПЕКАЕТСЯ в клип, чтобы принимающему движку не нужна была наша система.
 *
 * Хват описывается не таблицей из 30 углов, а СЖАТИЕМ по пальцам (`curl` 0..1) — так пресет читается
 * глазами, правится одним числом и корректно масштабируется слайдером «сжатие». Ручная правка каждой
 * фаланги тоже возможна (Про-режим) — тогда хват хранится готовыми углами.
 *
 * Знак сгиба: у нас Left = +X, пальцы смотрят наружу и сгибаются к ладони вращением вокруг Y.
 * У правой руки кости зеркальны, поэтому знак противоположный.
 *
 * Файл ЧИСТЫЙ — тестируется в node.
 */
import { FINGER_CHAINS, FINGER_SEGMENTS, type FingerChain } from './boneNames.js';
import type { Pose } from './clipModel.js';

/** Сколько радиан «полного сжатия» на каждую фалангу (проксимальная/средняя/дистальная). */
const CURL_MAX: readonly number[] = [1.45, 1.55, 1.15];
/** У большого пальца своя механика: меньше сгиб, зато есть противопоставление (твист). */
const THUMB_CURL_MAX: readonly number[] = [0.85, 0.95, 0.8];
const THUMB_OPPOSE = 0.6;

export type Curls = Partial<Record<FingerChain, number>>;

export interface GripSpec {
  id: string;
  label: string;
  /** Сжатие 0..1 по цепям. Не указанная цепь = 0 (прямой палец). */
  curls: Curls;
  /** Противопоставление большого (0..1) — поворот поперёк ладони. */
  oppose?: number;
}

/** Встроенные хваты. `открытая` первым — это «нет хвата». */
export const BUILTIN_GRIPS: readonly GripSpec[] = [
  { id: 'open', label: 'открытая', curls: {} },
  { id: 'fist', label: 'кулак', curls: { Thumb: 0.85, Index: 1, Middle: 1, Ring: 1, Little: 1 }, oppose: 0.8 },
  { id: 'sword', label: 'меч (одноруч.)', curls: { Thumb: 0.7, Index: 0.72, Middle: 0.88, Ring: 0.94, Little: 1 }, oppose: 0.7 },
  { id: 'sword2h', label: 'меч (двуруч.)', curls: { Thumb: 0.8, Index: 0.85, Middle: 0.95, Ring: 1, Little: 1 }, oppose: 0.85 },
  { id: 'axe', label: 'топор', curls: { Thumb: 0.8, Index: 0.9, Middle: 0.96, Ring: 1, Little: 1 }, oppose: 0.8 },
  { id: 'staff', label: 'посох', curls: { Thumb: 0.7, Index: 0.85, Middle: 0.85, Ring: 0.85, Little: 0.85 }, oppose: 0.7 },
  { id: 'shield', label: 'щит', curls: { Thumb: 0.75, Index: 0.9, Middle: 0.92, Ring: 0.92, Little: 0.9 }, oppose: 0.75 },
  { id: 'bow_grip', label: 'лук — рукоять', curls: { Thumb: 0.35, Index: 0.5, Middle: 0.78, Ring: 0.82, Little: 0.85 }, oppose: 0.45 },
  { id: 'bow_draw', label: 'лук — тетива', curls: { Thumb: 0.2, Index: 1, Middle: 1, Ring: 0.9, Little: 0.4 }, oppose: 0.2 },
  { id: 'point', label: 'указ. палец', curls: { Thumb: 0.6, Index: 0, Middle: 1, Ring: 1, Little: 1 }, oppose: 0.7 },
  { id: 'relaxed', label: 'расслабленная', curls: { Thumb: 0.25, Index: 0.3, Middle: 0.33, Ring: 0.36, Little: 0.4 }, oppose: 0.3 },
] as const;

export const findGrip = (id: string): GripSpec | null => BUILTIN_GRIPS.find((g) => g.id === id) ?? null;

/** Имена костей одной кисти (15 фаланг). */
export function handBones(side: 'Left' | 'Right'): string[] {
  const out: string[] = [];
  for (const ch of FINGER_CHAINS) for (const sg of FINGER_SEGMENTS) out.push(side + ch + sg);
  return out;
}
const ALL_HAND_BONES = new Set([...handBones('Left'), ...handBones('Right')]);
/** Это кость кисти (фаланга)? */
export const isHandBone = (name: string): boolean => ALL_HAND_BONES.has(name);

/**
 * Развернуть хват в позу пальцев. `close` 0..1 — общий множитель («слайдер сжатия»):
 * 0 отдаёт прямую кисть, 1 — пресет как есть, промежуточное — плавно между ними.
 */
export function gripToPose(spec: GripSpec, side: 'Left' | 'Right', close = 1): Pose {
  const sx = side === 'Left' ? -1 : 1;   // сгиб к ладони: у левой −Y, у правой +Y (кости зеркальны)
  const out: Pose = {};
  for (const ch of FINGER_CHAINS) {
    const c = (spec.curls[ch] ?? 0) * close;
    const max = ch === 'Thumb' ? THUMB_CURL_MAX : CURL_MAX;
    for (let i = 0; i < 3; i++) {
      const bend = max[i]! * c * sx;
      const opp = ch === 'Thumb' && i === 0 ? (spec.oppose ?? 0) * close * THUMB_OPPOSE * sx : 0;
      out[side + ch + FINGER_SEGMENTS[i]] = [opp, bend, 0];
    }
  }
  return out;
}

/** Обе кисти разом. */
export function gripToPoseBoth(specL: GripSpec, specR: GripSpec, closeL = 1, closeR = 1): Pose {
  return { ...gripToPose(specL, 'Left', closeL), ...gripToPose(specR, 'Right', closeR) };
}

// ── Персист: библиотека своих хватов + привязка к оружию ─────────────────────────────────────────
/** Свой хват хранится готовыми углами (Про-режим правил фаланги руками). */
export interface CustomGrip { id: string; label: string; pose: Pose }
/** Привязка хватов к ключу оружия (`main+off`): что в правой, что в левой, и насколько сжато. */
export interface WeaponGrip { L?: string; R?: string; closeL?: number; closeR?: number }
export interface GripConfig {
  custom: Record<string, CustomGrip>;                        // id → свой хват
  byWeapon: Record<string, Record<string, WeaponGrip>>;      // персонаж → ключ оружия → привязка
}

export const EMPTY_GRIP_CONFIG = (): GripConfig => ({ custom: {}, byWeapon: {} });

/** Разумный хват по умолчанию для ключа оружия — чтобы «из коробки» руки не были растопырены. */
export function defaultWeaponGrip(weaponKey: string): WeaponGrip {
  const [main, off] = weaponKey.includes('+') ? [weaponKey.slice(0, weaponKey.lastIndexOf('+')), weaponKey.slice(weaponKey.lastIndexOf('+') + 1)] : [weaponKey, 'none'];
  const byName = (w: string): string => {
    if (/bow/.test(w)) return 'bow_grip';
    if (/staff|spear|polearm|pike/.test(w)) return 'staff';
    if (/axe|hammer|mace|club/.test(w)) return 'axe';
    if (/shield/.test(w)) return 'shield';
    if (/sword|dagger|blade|knife/.test(w)) return 'sword';
    if (w === 'none') return 'relaxed';
    return 'sword';
  };
  return { R: byName(main), L: byName(off), closeL: 1, closeR: 1 };
}

/** Итоговая поза пальцев для персонажа+оружия (учитывая свои хваты и привязку). */
export function resolveGripPose(cfg: GripConfig, charId: string, weaponKey: string): Pose {
  const bind = cfg.byWeapon[charId]?.[weaponKey] ?? defaultWeaponGrip(weaponKey);
  const side = (id: string | undefined, s: 'Left' | 'Right', close: number): Pose => {
    if (!id) return {};
    const custom = cfg.custom[id];
    if (custom) {                                     // свой хват: берём только кости нужной кисти
      const out: Pose = {};
      for (const k in custom.pose) if (k.startsWith(s)) { const v = custom.pose[k]!; out[k] = [v[0], v[1], v[2]]; }
      return out;
    }
    const g = findGrip(id); return g ? gripToPose(g, s, close) : {};
  };
  return { ...side(bind.L, 'Left', bind.closeL ?? 1), ...side(bind.R, 'Right', bind.closeR ?? 1) };
}

/** Впечь позу пальцев в клип: кадры, где фаланги НЕ заданы явно, получают хват.
 *  Нужно на экспорте — принимающему движку не должна быть нужна наша система хватов. */
export function bakeGripIntoClip<T extends { keys: { pose: Pose }[] }>(clip: T, grip: Pose): T {
  for (const k of clip.keys) for (const nm in grip) if (k.pose[nm] === undefined) { const v = grip[nm]!; k.pose[nm] = [v[0], v[1], v[2]]; }
  return clip;
}

/** Наложить позу пальцев на скелет. Кости, которых нет (гуманоид без пальцев), молча пропускаются. */
export function applyGripPose(bones: Map<string, { rotation: { set(x: number, y: number, z: number): void } }>, pose: Pose): void {
  for (const nm in pose) {
    if (!isHandBone(nm)) continue;
    const b = bones.get(nm); if (!b) continue;
    const v = pose[nm]!;
    b.rotation.set(v[0], v[1], v[2]);
  }
}
