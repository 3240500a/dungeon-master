/**
 * РАЗБОР ИМЁН КОСТЕЙ (Ф3.2) — вместо плоской таблицы подстрок.
 *
 * Для торса/конечностей хватало «найди самое длинное совпадение ядра» (`retarget3d.CORE`). Для ПАЛЬЦЕВ
 * этого мало: у пальца три независимых признака — сторона, ЦЕПЬ (thumb/index/…) и НОМЕР СЕГМЕНТА,
 * и конвенции по каждому расходятся:
 *
 *   CC / AccuRIG    CC_Base_L_Thumb1..3        L_Index1..3   L_Mid1..3     L_Ring1..3   L_Pinky1..3
 *   Mixamo          LeftHandThumb1..4 (!)      LeftHandIndex1..4           …            LeftHandPinky1..4
 *   UE5 Mannequin   thumb_01_l..03_l           index_01_l    middle_01_l   ring_01_l    pinky_01_l
 *   Unity Humanoid  LeftThumbProximal/Intermediate/Distal    LeftMiddle*   LeftRing*    LeftLittle* (!)
 *   VRM 1.0         leftThumbMetacarpal (!)/Proximal/Distal  …
 *   Blender Rigify  thumb.01.L                 f_index.01.L  f_middle.01.L f_ring.01.L  f_pinky.01.L
 *   Daz G8/G9       lThumb1..3                 lIndex1..3    lMid1..3      lRing1..3    lPinky1..3
 *
 * Три ловушки, из-за которых плоская таблица промахивается:
 *   1. `mid` vs `middle`, `pinky` vs `little` — синонимы цепи;
 *   2. у Mixamo ЧЕТЫРЕ сегмента, четвёртый — кончик-нуб (если взять его за Distal, вся кисть съедет);
 *   3. у VRM 1.0 большой палец начинается с `Metacarpal`, а не с `Proximal`.
 *
 * Решение, которое закрывает все три разом: НЕ пытаться понять семантику сегмента, а ОТСОРТИРОВАТЬ
 * найденные кости цепи и взять ПЕРВЫЕ ТРИ как Proximal/Intermediate/Distal. Именно так поступают
 * и штатные импортёры (в т.ч. Unity с VRM).
 *
 * Файл ЧИСТЫЙ — тестируется в node.
 */

/** Цепи пальцев в нашем каноне (имена Unity Humanoid). */
export const FINGER_CHAINS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
export type FingerChain = typeof FINGER_CHAINS[number];
/** Сегменты пальца в каноне, по порядку. */
export const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;

/** Синонимы имени цепи → канон. `mid`/`middle`, `pinky`/`little`/`pinkie` и т.п. */
const CHAIN_ALIAS: Record<string, FingerChain> = {
  thumb: 'Thumb', thumb0: 'Thumb',
  // БЕЗ синонимов fore/pointer: 'fore' есть в Forearm — предплечье уезжало в указательный палец
  // и пропадало из карты (LeftLowerArm === undefined на всех трёх CC/Mixamo/Explosive).
  index: 'Index',
  middle: 'Middle', mid: 'Middle',
  ring: 'Ring',
  little: 'Little', pinky: 'Little', pinkie: 'Little', pink: 'Little',
};
/** Порядок именованных сегментов (когда номера в имени нет). */
const SEG_ORDER: Record<string, number> = { metacarpal: 0, meta: 0, proximal: 1, intermediate: 2, middle: 2, distal: 3, tip: 4, end: 4, nub: 4 };

/** Известные префиксы экспортёров, которые надо снять перед разбором. */
export const stripBonePrefix = (s: string): string =>
  s.toLowerCase().replace(/^(cc_base_|mixamorig[:_]?|bip0?1[_:]?|bip_?|b_|def-|armature\|)/, '');

const SEP = '[_.:| -]';

/** Сторона кости: явный сегмент l/r либо слово left/right. Детектится ДО снятия разделителей. */
export function sideOfName(raw: string): '' | 'l' | 'r' {
  const s = stripBonePrefix(raw);
  if (/left|lft/.test(s) || new RegExp(`(^|${SEP})l($|${SEP})`).test(s)) return 'l';
  if (/right|rgt/.test(s) || new RegExp(`(^|${SEP})r($|${SEP})`).test(s)) return 'r';
  // Daz/иные: одиночная буква-приставка перед заглавной (lThumb1 / rIndex2) — ловим по ИСХОДНОМУ регистру
  if (/^l[A-Z]/.test(raw)) return 'l';
  if (/^r[A-Z]/.test(raw)) return 'r';
  return '';
}

export interface ParsedBone {
  raw: string;
  side: '' | 'l' | 'r';
  /** Цепь пальца, если это палец. */
  chain: FingerChain | null;
  /** Порядковый ключ сегмента внутри цепи (число из имени либо порядок именованного сегмента). */
  segment: number | null;
  /** Индекс твист-кости (`…Twist01` → 1), если это твист. */
  twist: number | null;
  /** Ядро имени без стороны, разделителей, цифр — для обычного словарного матча. */
  core: string;
}

/** Ядро: без стороны, без разделителей. */
export function coreOfName(raw: string): string {
  return stripBonePrefix(raw)
    .replace(/left|right|lft|rgt/g, '')
    .replace(new RegExp(`(^|${SEP})[lr]($|${SEP})`, 'g'), '$1')
    .replace(/[\s_.:|-]/g, '');
}

export function parseBoneName(raw: string): ParsedBone {
  const side = sideOfName(raw);
  const core = coreOfName(raw);

  // ── твист ───────────────────────────────────────────────────────────────────
  let twist: number | null = null;
  const tw = /twist0*(\d+)?/.exec(core);
  if (tw) twist = tw[1] ? parseInt(tw[1], 10) : 1;

  // ── палец: цепь + номер сегмента ───────────────────────────────────────────
  let chain: FingerChain | null = null;
  let chainKey = '';
  for (const k of Object.keys(CHAIN_ALIAS)) {
    if (core.includes(k) && k.length > chainKey.length) { chainKey = k; chain = CHAIN_ALIAS[k]!; }
  }
  let segment: number | null = null;
  if (chain) {
    // «index_01», «Index2», «f_index.03» → номер; иначе именованный сегмент.
    const after = core.slice(core.indexOf(chainKey) + chainKey.length);
    const num = /^0*(\d+)/.exec(after);
    if (num) segment = parseInt(num[1]!, 10);
    else {
      for (const nm in SEG_ORDER) if (after.includes(nm)) { segment = SEG_ORDER[nm]!; break; }
      if (segment === null) { const anyNum = /(\d+)/.exec(core); if (anyNum) segment = parseInt(anyNum[1]!, 10); }
    }
    // «hand» в имени (Mixamo LeftHandIndex1) не должно мешать — цепь уже определена.
  }
  return { raw, side, chain, segment, twist, core };
}

/** Каноническое имя пальцевой кости. */
export const fingerBoneName = (side: 'l' | 'r', chain: FingerChain, segIdx: 0 | 1 | 2): string =>
  (side === 'l' ? 'Left' : 'Right') + chain + FINGER_SEGMENTS[segIdx];

/** Полный список канон-имён пальцев (30 костей). */
export function allFingerBones(): string[] {
  const out: string[] = [];
  for (const side of ['l', 'r'] as const) for (const ch of FINGER_CHAINS) for (let i = 0; i < 3; i++) out.push(fingerBoneName(side, ch, i as 0 | 1 | 2));
  return out;
}

/**
 * Сопоставить имена скелета канон-именам ПАЛЬЦЕВ.
 * Сортируем кости каждой цепи по номеру сегмента и берём первые три → Proximal/Intermediate/Distal.
 * Это разом решает 4-сегментный Mixamo (лишний кончик отбрасывается) и VRM-большой-палец с Metacarpal.
 */
export function mapFingerBones(names: readonly string[]): Record<string, string> {
  const buckets = new Map<string, ParsedBone[]>();
  for (const raw of names) {
    const p = parseBoneName(raw);
    if (!p.chain || !p.side || p.twist !== null) continue;
    const key = p.side + '|' + p.chain;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(p);
  }
  const out: Record<string, string> = {};
  for (const [key, arr] of buckets) {
    const [side, chain] = key.split('|') as ['l' | 'r', FingerChain];
    arr.sort((a, b) => (a.segment ?? 99) - (b.segment ?? 99) || a.raw.localeCompare(b.raw));
    for (let i = 0; i < Math.min(3, arr.length); i++) out[fingerBoneName(side, chain, i as 0 | 1 | 2)] = arr[i]!.raw;
  }
  return out;
}
