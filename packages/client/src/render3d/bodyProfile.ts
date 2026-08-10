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

/** Высота таза в rest-T-позе для заземления стоп (нога = бедро15+голень14 + таз-офсет2). Держит стопы у пола при любых leg/height. */
export function pelvisHeight(p?: BodyProfile): number {
  const leg = (p?.leg ?? 1) * (p?.height ?? 1);
  return 3 + 29 * leg;   // 3(зазор+таз-офсет) + (15+14)·leg·height; при 1 = 32 (= PELVIS_Y базы)
}

/** Множитель ТОЛЩИНЫ (girth) поверх per-регионного build-масштаба. */
export function girthMult(p?: BodyProfile): number { return p?.girth ?? 1; }
