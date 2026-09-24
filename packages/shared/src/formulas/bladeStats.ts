import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';

/**
 * ⭐ КЛИНОК ИЗ ГЕОМЕТРИИ (docs/CRAFT_WEAPONS.md §26) — чистые формулы, без Phaser/DOM и без ковки.
 *
 * У ударной части с измеренной моделью (`weapon-parts[].geom`) статы выводятся из самой модели:
 * - ДЛИНА ставит клинок на место внутри его вилки: −1 самый короткий (быстрее, удар мельче), +1 самый
 *   длинный. Это ТА ЖЕ ось, что у ручной разметки, и те же ручки `balance.craft.strike`, только число
 *   теперь измерено, а не проставлено на глаз;
 * - ШИРИНА разводит мин и макс урона вокруг той же середины: широкий бьёт ровно, узкий вразнобой.
 *   Среднее не меняется — ДПС ширина не двигает;
 * - ЦЕНТР ТЯЖЕСТИ силуэта даёт баланс клинка: вес у руки — упор (блок), вес к концу — укус
 *   (кровотечение). Вместе с оголовьем он образует ОДНУ точку баланса вещи в ±1 — один продавец
 *   блока и статуса, а не два (иначе §23: вклады складывались бы).
 *
 * Деталь без `geom` живёт по-старому: ось из данных, баланс = ось оголовья.
 */

type WeaponPart = ConfigShapes['weapon-parts'][number];
export type BladeTuning = ConfigShapes['balance']['craft']['blade'];
export type BladeBracket = BladeTuning['brackets'][number];
export type BladeGeom = NonNullable<WeaponPart['geom']>;
export type BladeForm = 'falchion' | 'sabre';

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const r4 = (x: number): number => Math.round(x * 10000) / 10000;

/** Вилка клинка — по значению его тега `blade` (архаичный, короткий, длинный, …). */
export function bracketOf(k: BladeTuning, part: { tags: Record<string, string> }): BladeBracket | undefined {
  const tag = part.tags.blade;
  return tag ? k.brackets.find((b) => b.tag === tag) : undefined;
}

/** Место по длине внутри вилки: −1 у нижней границы, +1 у верхней, 0 — середина. Вне вилки — упор в ±1. */
export function lengthPlace(br: BladeBracket, len: number): number {
  const half = (br.hi - br.lo) / 2;
  return half > 0 ? clamp((len - (br.lo + br.hi) / 2) / half, -1, 1) : 0;
}

/** Разброс от ширины: s = clamp(1 − k·ln(ширина / эталон), min, max). «Вдвое шире» и «вдвое уже» — равные шаги. */
export function spreadOfWidth(k: BladeTuning, br: BladeBracket, width: number): number {
  if (!(width > 0) || !(br.width > 0)) return 1;
  return r4(clamp(1 - k.spread.k * Math.log(width / br.width), k.spread.min, k.spread.max));
}

/** Баланс КЛИНКА по центру тяжести силуэта: +1 — вес у руки (сужается от гарды), −1 — вес к концу. */
export function balanceOfBlade(k: BladeTuning, bal: number): number {
  return k.balance.span > 0 ? clamp((k.balance.center - bal) / k.balance.span, -1, 1) : 0;
}

/** Объявленная форма детали (фальшион / сабля) или ничего. */
export function bladeFormOf(part: { form?: string }): BladeForm | undefined {
  return part.form === 'falchion' || part.form === 'sabre' ? part.form : undefined;
}

export interface BladeStats {
  /** Вилка по тегу `blade`; нет — клинок вне классификации (ось длины 0, разброс ×1). */
  bracket?: BladeBracket;
  /** Место по длине до поправки формы. */
  place: number;
  /** ⭐ Итоговая ось ударной части (урон ↔ скорость): место + поправка формы, в ±1. */
  axis: number;
  /** Разброс мин–макс вокруг той же середины (×1 — числа базы). */
  spread: number;
  /** Баланс самого клинка (до оголовья и формы). */
  balance: number;
  /** Сдвиг баланса от формы. */
  formBalance: number;
  form?: BladeForm;
  /** Длина вне своей вилки (или вилки нет) — клинок упёрся в край, редактор это подсвечивает. */
  outOfBracket: boolean;
}

/**
 * ⭐ СТАТЫ КЛИНКА из его геометрии. Нет `geom` (или это не ударная часть) — `undefined`: такая деталь
 * живёт на ручной оси. Ручки — `balance.craft.blade`, их можно крутить в редакторе без кода.
 */
export function bladeStatsOf(k: BladeTuning, part: Pick<WeaponPart, 'slot' | 'tags' | 'geom' | 'form'>): BladeStats | undefined {
  if (part.slot !== 'strike' || !part.geom) return undefined;
  const g = part.geom;
  const br = bracketOf(k, part);
  const form = bladeFormOf(part);
  const fk = form ? k.forms[form] : undefined;
  const place = br ? lengthPlace(br, g.len) : 0;
  return {
    bracket: br,
    place: r4(place),
    axis: r4(clamp(place + (fk?.length ?? 0), -1, 1)),
    spread: br ? spreadOfWidth(k, br, g.width) : 1,
    balance: r4(balanceOfBlade(k, g.bal)),
    formBalance: fk?.balance ?? 0,
    form,
    outOfBracket: !br || g.len < br.lo || g.len > br.hi,
  };
}

/** То же по реестру. */
export function bladeStats(reg: ConfigRegistry, part: Pick<WeaponPart, 'slot' | 'tags' | 'geom' | 'form'>): BladeStats | undefined {
  return bladeStatsOf(reg.get('balance').craft.blade, part);
}

/** ⭐ Ось ударной части: измеренная, если у детали есть геометрия, иначе ручная. */
export function strikeAxisOf(reg: ConfigRegistry, part: WeaponPart): number {
  return bladeStats(reg, part)?.axis ?? part.axis;
}

/**
 * Ось варианта В СВОЁМ ГНЕЗДЕ — для сортировки пула и выбора «эталона» (ближе всего к нулю). У клинков
 * с геометрией — выведенная, иначе окно ковки сортировало бы по числу, которое больше ничего не значит.
 */
export function axisOf(reg: ConfigRegistry, part: WeaponPart): number {
  return part.slot === 'strike' ? strikeAxisOf(reg, part) : part.axis;
}

/**
 * ⭐ ТОЧКА БАЛАНСА ВЕЩИ (§26): доля клинка × его баланс + остальное × ось оголовья + поправка формы, в ±1.
 * Один рычаг на двоих: крайний клинок с крайним оголовьем дают ровно тот потолок, что раньше давало
 * одно оголовье, а детали вразнобой гасят друг друга. Клинок без геометрии — ось оголовья, как было.
 */
export function balanceAxisOf(reg: ConfigRegistry, strike: WeaponPart, head: WeaponPart): number {
  const k = reg.get('balance').craft.blade;
  const b = bladeStatsOf(k, strike);
  if (!b) return head.axis;
  const s = clamp(k.balance.bladeShare, 0, 1);
  return r4(clamp(s * b.balance + (1 - s) * head.axis + b.formBalance, -1, 1));
}

// ── Подсказки измерителя ─────────────────────────────────────────────────────────────────────────

/** В какую вилку просится клинок этой длины. Вне всех — ближайшая, с пометкой «в зазоре». */
export function suggestBracket(k: BladeTuning, len: number): { bracket?: BladeBracket; gap: boolean; dist: number } {
  let best: BladeBracket | undefined;
  let bestD = Infinity;
  for (const b of k.brackets) {
    const d = len < b.lo ? b.lo - len : len > b.hi ? len - b.hi : 0;
    if (d < bestD) { bestD = d; best = b; }
  }
  return { bracket: best, gap: bestD > 0, dist: bestD === Infinity ? 0 : r4(bestD) };
}

/**
 * Какую форму подсказать по замеру. Заточку по сетке не увидеть, поэтому однолезвийность — от человека
 * (тег `edge`), а замер решает только «какая»: расширение к концу — фальшион, изгиб спинки — сабля.
 */
export function suggestForm(k: BladeTuning, geom: Pick<BladeGeom, 'flare' | 'spine'>, edge: string | undefined): BladeForm | undefined {
  if (edge !== 'single') return undefined;
  if ((geom.flare ?? 1) >= k.detect.flare) return 'falchion';
  if ((geom.spine ?? 0) >= k.detect.spine) return 'sabre';
  return undefined;
}

// ── Подпись для окна ковки ──────────────────────────────────────────────────────────────────────

const FORM_TEXT: Record<BladeForm, string> = {
  falchion: 'фальшион: тяжелее прямого — удар крупнее, взмахов меньше',
  sabre: 'сабля: легче прямой — взмахов больше, удар мельче',
};

/**
 * Подпись-следствие клинка ИЗ ЕГО ЧИСЕЛ (§17): что даёт длина, ширина и баланс. Ручная подпись в данных
 * писалась под ручную ось и после замера могла бы врать («самый быстрый» у клинка, который длиннее всех
 * в вилке), поэтому у клинков с геометрией окно берёт эту. Длина — по НАСТОЯЩЕМУ месту в вилке, а сдвиг
 * формы — своей фразой: фальшион на 73 см из 70–80 короткий, хоть и бьёт как тяжёлый.
 */
export function bladeCaption(b: BladeStats): string {
  const out: string[] = [];
  if (b.form) out.push(FORM_TEXT[b.form]);
  const lenWord = b.place >= 0.35 ? 'длинный для вилки' : b.place <= -0.35 ? 'короткий для вилки' : 'средней длины';
  out.push(b.form ? lenWord : b.place >= 0.35 ? `${lenWord}: удар крупнее, взмахов меньше`
    : b.place <= -0.35 ? `${lenWord}: взмахов больше, удар мельче` : lenWord);
  if (b.spread <= 0.8) out.push('широкий: урон ровный');
  else if (b.spread >= 1.2) out.push('узкий: урон вразнобой');
  const bal = b.balance + b.formBalance;
  if (bal >= 0.35) out.push('вес у руки: крепче держит удар');
  else if (bal <= -0.35) out.push('вес к концу: чаще пускает кровь');
  return out.join(' · ');
}
