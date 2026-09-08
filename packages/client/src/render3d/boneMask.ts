/**
 * МАСКА КОСТЕЙ — ОДИН тип на три места: импорт клипа, правка в редакторе, слои рантайма.
 *
 * ЗАЧЕМ. Сейчас «взять из анимации только часть тела» решается у нас тремя несовместимыми кусками:
 * на импорте — enum из трёх значений (`BakeOptions.body: full|upper|lower`), в рантайме — три ЗАХАРДКОЖЕННЫХ
 * списка костей (`UPPER_BONES`, `ATK_BONES`, `SHIELD_BONES` в `poseRuntime.ts`) плюс по-костное затухание
 * `SHIELD_FALLOFF`. Одно и то же понятие, три реализации, ни одну нельзя настроить из UI.
 *
 * КАК В ИНДУСТРИИ. Unity — **Avatar Mask**: части гуманоида (`Head`, `Left Arm`, `Right Arm`, `Left Hand`,
 * `Right Hand`, `Left Leg`, `Right Leg`, `Root`), применяется И в настройках импорта анимации, И на слоях
 * Animator Controller; но там часть — БУЛЕВА, а вес 0..1 живёт на СЛОЕ аниматора.
 * Unreal — **`Layered blend per bone` + Blend Mask**: «define **weight influences**, disabling animation from
 * playing **partially or fully** on specific bones», в API `blend_masks: Array(BlendProfile)` = per-bone alphas;
 * авторят их «Recursively Set Blend Scales» — ставят значение на кость и раздают всем детям, то есть НА ЦЕПЬ.
 *
 * БЕРЁМ МОДЕЛЬ UNREAL: **вес 0..1 на КАЖДУЮ часть** (наша «часть» = их «цепь») + по-костный слой поверх для
 * мягкого стыка. Вес — это «сколько взять из мокапа»: 1 = мокап, 0 = базовая поза, между — slerp
 * (см. `readOurPose` в `clipBaker.ts`). `SHIELD_FALLOFF` — это уже фактически Blend Mask, просто зашитый в код.
 *
 * ОТЛИЧИЯ ОТ UNITY, осознанные:
 * - добавлена часть «торс» (у Unity спина сидит в `Root`/`Body`, а нам нужно брать корпус отдельно от таза);
 * - «таз» отделён от ног: есть клипы, где ноги стоят, а таз подаётся вперёд-назад (перенос веса) — его берём,
 *   а настоящий перенос персонажа отсекается не маской, а вычитанием опоры (см. `clipBaker`);
 * - кисть = ПАЛЬЦЫ (30 костей), а сама кость запястья лежит в «руке» — иначе нельзя взять мах рукой, не
 *   затащив покадровый хват (`gripPoses.ts`).
 *
 * Чистый модуль: только имена костей, ни THREE, ни DOM → тестируется в node.
 */
import { OUR_BONES, OUR_FINGERS } from './retarget3d.js';

export type MaskPart = 'head' | 'torso' | 'hips' | 'armL' | 'armR' | 'handL' | 'handR' | 'legL' | 'legR';

/** Части в порядке показа в UI: id → подпись → кости. Порядок = сверху вниз по телу. */
export const MASK_PARTS: readonly { id: MaskPart; label: string; bones: readonly string[] }[] = [
  { id: 'head', label: 'голова', bones: ['Neck', 'Head'] },
  { id: 'torso', label: 'торс', bones: ['Spine', 'Chest', 'UpperChest'] },
  { id: 'hips', label: 'таз', bones: ['Hips'] },
  { id: 'armL', label: 'рука Л', bones: ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand'] },
  { id: 'armR', label: 'рука П', bones: ['RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand'] },
  { id: 'handL', label: 'пальцы Л', bones: OUR_FINGERS.filter((b) => b.startsWith('Left')) },
  { id: 'handR', label: 'пальцы П', bones: OUR_FINGERS.filter((b) => b.startsWith('Right')) },
  { id: 'legL', label: 'нога Л', bones: ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes'] },
  { id: 'legR', label: 'нога П', bones: ['RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'] },
];

export const ALL_PARTS: readonly MaskPart[] = MASK_PARTS.map((p) => p.id);

/** Вес части 0..1. НЕТ КЛЮЧА = 0 (часть не берём) — отсутствие и ноль означают одно и то же. */
export type PartWeights = Partial<Record<MaskPart, number>>;
/**
 * Маска: вес на часть + необязательные по-костные веса поверх.
 * `weights` ПЕРЕКРЫВАЕТ часть: кость с весом 0.4 берётся на 40 %, даже если её часть выключена целиком.
 * Так `SHIELD_FALLOFF` выражается без единой ветки в коде.
 */
export interface BoneMask {
  parts: PartWeights;
  weights?: Record<string, number>;
}

/** Кость → часть, которой она принадлежит (для пикера по манекену: кликнул кость — подсветилась часть). */
export const PART_OF_BONE: Readonly<Record<string, MaskPart>> = (() => {
  const o: Record<string, MaskPart> = {};
  for (const p of MASK_PARTS) for (const b of p.bones) o[b] = p.id;
  return o;
})();

/** Все кости, которые маска вообще может описывать (тело + пальцы) — область определения. */
export const MASKABLE_BONES: readonly string[] = MASK_PARTS.flatMap((p) => [...p.bones]);

// ── Пресеты ──────────────────────────────────────────────────────────────────────────────────────
// «верх» и «низ» — ровно то, что делал старый `BakeOptions.body: upper|lower`, чтобы старые вызовы
// переводились один-в-один и запечённые раньше клипы не поменялись.
const UPPER: MaskPart[] = ['head', 'torso', 'armL', 'armR', 'handL', 'handR'];
const LOWER: MaskPart[] = ['hips', 'legL', 'legR'];
export const MASK_PRESETS: readonly { id: string; label: string; parts: MaskPart[] }[] = [
  { id: 'all', label: 'всё', parts: [...ALL_PARTS] },
  { id: 'upper', label: 'верх', parts: UPPER },
  { id: 'lower', label: 'низ', parts: LOWER },
  { id: 'arms', label: 'только руки', parts: ['armL', 'armR', 'handL', 'handR'] },
  { id: 'noFingers', label: 'без пальцев', parts: ALL_PARTS.filter((p) => p !== 'handL' && p !== 'handR') },
];

/** Список частей → веса по 1 (пресет всегда «взять целиком»; дальше крутится ползунками). */
export const weightsOf = (parts: readonly MaskPart[]): PartWeights => {
  const o: PartWeights = {};
  for (const p of parts) o[p] = 1;
  return o;
};
export const presetMask = (id: string): BoneMask => {
  const p = MASK_PRESETS.find((x) => x.id === id);
  return { parts: weightsOf(p ? p.parts : ALL_PARTS) };
};
export const fullMask = (): BoneMask => ({ parts: weightsOf(ALL_PARTS) });

/**
 * Прежний enum `body` → маска (старые сохранённые настройки импорта и дефолт запекателя).
 * ПАЛЬЦЫ НЕ ВХОДЯТ ни в один из вариантов: старый запекатель фаланги не снимал вообще, и перевод
 * обязан быть один-в-один, иначе перезапечённый старый клип получит 30 новых каналов и перетрёт авторский хват.
 */
export const maskFromBody = (body?: 'full' | 'upper' | 'lower'): BoneMask => ({
  parts: weightsOf((body === 'upper' ? UPPER : body === 'lower' ? LOWER : ALL_PARTS).filter((p) => p !== 'handL' && p !== 'handR')),
});

// ── Применение ───────────────────────────────────────────────────────────────────────────────────
/** Вес части 0..1 (нет ключа = 0). */
export const partWeight = (m: BoneMask, p: MaskPart): number => Math.min(1, Math.max(0, m.parts[p] ?? 0));
/** Часть вообще берётся (вес > 0)? Для гейтов «есть ли этот канал в клипе». */
export const hasPart = (m: BoneMask, p: MaskPart): boolean => partWeight(m, p) > 0;

/** Задать вес части. Возвращает НОВУЮ маску — маска иммутабельна, её кладут в undo. */
export function setPartWeight(m: BoneMask, p: MaskPart, w: number): BoneMask {
  const parts: PartWeights = { ...m.parts };
  if (w <= 0) delete parts[p]; else parts[p] = Math.min(1, w);
  return m.weights ? { parts, weights: { ...m.weights } } : { parts };
}
/** Переключить часть целиком (клик по чипу или по кости манекена): 0 ↔ 1. */
export const togglePart = (m: BoneMask, p: MaskPart): BoneMask => setPartWeight(m, p, hasPart(m, p) ? 0 : 1);

/**
 * Вес кости 0..1. Явный вес из `weights` сильнее части; иначе 1 для взятой части и 0 для остальных.
 * Кость вне области определения маски (не гуманоидная) — 0: маска описывает только наш риг.
 */
export function boneWeight(m: BoneMask, bone: string): number {
  const w = m.weights?.[bone];
  if (w !== undefined) return Math.min(1, Math.max(0, w));
  const part = PART_OF_BONE[bone];
  return part ? partWeight(m, part) : 0;
}

/** Кости с ненулевым весом — быстрая проверка «берём ли эту кость» в горячем цикле семплирования. */
export function maskBones(m: BoneMask): Set<string> {
  const out = new Set<string>();
  for (const p of MASK_PARTS) if (hasPart(m, p.id)) for (const b of p.bones) out.add(b);
  if (m.weights) for (const b in m.weights) { if ((m.weights[b] ?? 0) > 0) out.add(b); else out.delete(b); }
  return out;
}

/** Взяты ли ВСЕ части ПОЛНОСТЬЮ и нет ли частичных по-костных весов — тогда маску можно не применять. */
export function isFullMask(m: BoneMask): boolean {
  for (const p of ALL_PARTS) if (partWeight(m, p) < 1) return false;
  if (m.weights) for (const b in m.weights) if ((m.weights[b] ?? 1) < 1) return false;
  return true;
}

/** Короткая подпись для UI/логов: «верх», «голова+нога П», «верх · рука П 40%». */
export function maskLabel(m: BoneMask): string {
  if (isFullMask(m)) return 'всё';
  const taken = MASK_PARTS.filter((p) => hasPart(m, p.id));
  if (!taken.length) return 'ничего';
  const partial = taken.filter((p) => partWeight(m, p.id) < 1);
  const full = taken.filter((p) => partWeight(m, p.id) >= 1).map((p) => p.id);
  const preset = MASK_PRESETS.find((p) => p.parts.length === full.length && p.parts.every((x) => full.includes(x)));
  const head = full.length ? (preset && !m.weights ? preset.label : MASK_PARTS.filter((p) => full.includes(p.id)).map((p) => p.label).join('+')) : '';
  const tail = partial.map((p) => `${p.label} ${Math.round(partWeight(m, p.id) * 100)}%`).join(', ');
  return [head, tail].filter(Boolean).join(' · ') || 'ничего';
}

/** Только кости тела (без пальцев) — `OUR_BONES` под маской. Пальцы идут отдельным списком (`maskFingers`). */
export const maskBodyBones = (m: BoneMask): Set<string> => {
  const all = maskBones(m);
  return new Set((OUR_BONES as readonly string[]).filter((b) => all.has(b)));
};
/** Только пальцевые кости под маской. */
export const maskFingers = (m: BoneMask): Set<string> => {
  const all = maskBones(m);
  return new Set(OUR_FINGERS.filter((b) => all.has(b)));
};
