/**
 * ПРОФИЛЬ ТЕЛА (модульные пропорции) — как в системах кастомизации (MMO-слайдеры, MakeHuman, MetaHuman body types):
 * один канонический скелет + множители ДЛИНЫ звеньев (рост/руки/ноги/торс) и ОБХВАТА (толщина = худой/толстый).
 * Меняем длину = локальный офсет кости к ребёнку; толщину = радиус сегмента. Анимация по поворотам → работает на любых.
 * Профиль применяет `buildHumanoid` (наш процедурный риг), а импортный меш конформится к длинам этого рига (retarget3d).
 */

export interface BodyProfile {
  height?: number;   // общий масштаб (1 = база ~1.9м) — высокий/низкий без смены пропорций
  arm?: number;      // длина рук (плечо+предплечье)
  leg?: number;      // длина ног (бедро+голень); задаёт высоту таза (заземление)
  torso?: number;    // длина торса (спина/грудь)
  girth?: number;    // обхват/толщина (худой<1<толстый) — множит толщину сегментов
}

export const DEFAULT_PROFILE: Required<BodyProfile> = { height: 1, arm: 1, leg: 1, torso: 1, girth: 1 };

/** Пер-костный множитель длины (наша кость → scale) — снимается с импорт-ФБХ (measureBoneScales), чтобы наш
 *  процедурный скелет ПОВТОРЯЛ пропорции модели 1:1. Правая сторона берёт левый scale (симметрия). */
export type BoneScale = Record<string, number>;
/** scale кости с зеркалом L→R и дефолтом 1. */
export function boneScaleOf(name: string, bs?: BoneScale): number {
  if (!bs) return 1;
  return bs[name] ?? bs[name.replace('Right', 'Left')] ?? 1;
}

/** Множитель ДЛИНЫ для офсета кости (сегмент, оканчивающийся этой костью). height множит ВСЁ (общий рост),
 *  arm/leg/torso — регион (пропорция). Всё печём в офсеты (не root.scale) — чтобы физ-рагдолл был в тех же размерах. */
export function lenMult(boneName: string, p?: BodyProfile): number {
  if (!p) return 1;
  const h = p.height ?? 1;
  if (boneName === 'LeftLowerArm' || boneName === 'RightLowerArm' || boneName === 'LeftHand' || boneName === 'RightHand') return (p.arm ?? 1) * h;
  if (boneName === 'LeftLowerLeg' || boneName === 'RightLowerLeg' || boneName === 'LeftFoot' || boneName === 'RightFoot') return (p.leg ?? 1) * h;
  if (boneName === 'Spine' || boneName === 'Chest' || boneName === 'UpperChest') return (p.torso ?? 1) * h;
  return h;   // шея/голова/плечи/таз-офсеты/бёдра-офсет — общий рост
}

/** Высота таза в rest-T-позе для заземления стоп. Нога = таз-офсет(2) + бедро(15) + голень(14), каждое ×своим
 *  пер-костным scale (пропорции ФБХ) × leg×height. При дефолте (scale=1, профиль=1) = 1+2+15+14 = 32 (PELVIS_Y базы). */
export function pelvisHeight(p?: BodyProfile, bs?: BoneScale): number {
  const leg = (p?.leg ?? 1) * (p?.height ?? 1);
  const up = boneScaleOf('LeftUpperLeg', bs), th = boneScaleOf('LeftLowerLeg', bs), sh = boneScaleOf('LeftFoot', bs);
  return 1 + (2 * up + 15 * th + 14 * sh) * leg;   // клиренс 1 + (таз-офсет+бедро+голень)·scale·leg·height
}

/** Регион кости — ОДНА таблица для толщины (humanoid.sc) и прочих пер-регионных множителей.
 *  Раньше регион угадывался по подстрокам ('Arm'/'Leg'/…), и любая НОВАЯ кость тихо падала в «торс»:
 *  `LeftThumbProximal` не содержит ни 'Arm', ни 'Leg' → палец толстел вместе с животом. */
export type BoneRegion = 'arm' | 'leg' | 'torso' | 'head';
const FINGER_RE = /(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;
export function boneRegion(name: string): BoneRegion {
  if (name === 'Head' || name === 'Neck') return 'head';
  if (FINGER_RE.test(name)) return 'arm';                                   // пальцы — часть руки
  if (name.includes('Arm') || name.endsWith('Hand') || name.includes('Shoulder')) return 'arm';
  if (name.includes('Leg') || name.includes('Foot') || name.includes('Toes')) return 'leg';
  return 'torso';
}

/** Множитель ТОЛЩИНЫ (girth) поверх per-регионного build-масштаба. */
export function girthMult(p?: BodyProfile): number { return p?.girth ?? 1; }
