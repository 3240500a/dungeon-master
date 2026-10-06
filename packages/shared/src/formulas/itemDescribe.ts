import type { Item } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import { DEFAULT_GRIP, gripAdjust, isVersatile, type GripTuning } from './versatile.js';
import { ESSENCE_ID } from './salvage.js';

/**
 * ЕДИНЫЙ форматтер описания предмета (без DOM/Phaser) — используется и игрой (клиентский itemView),
 * и редактором (генератор предметов), чтобы тултип отображался ОДИНАКОВО. Статические подписи здесь;
 * динамические имена (классы брони/веса/подтипы/скиллы/стихии из конфигов) приходят резолверами `R`.
 * Каждая строка помечена `affix`: базовые свойства (false) рисуются белым, добавленное аффиксами
 * (true) — цветом редкости предмета.
 */
export const STAT_LABEL: Record<string, string> = {
  strength: 'Сила', dexterity: 'Ловкость', intelligence: 'Интеллект', vitality: 'Живучесть',
  maxHp: 'Здоровье', maxMana: 'Мана', maxStamina: 'Выносливость',
  minDamage: 'Мин. урон', maxDamage: 'Макс. урон', attackSpeed: 'Скор. атаки', castSpeed: 'Скор. каста',
  critChance: 'Шанс крита', critMultiplier: 'Множ. крита', armor: 'Броня', moveSpeed: 'Скор. движения',
  accuracy: 'Меткость', evade: 'Уклонение', blockChance: 'Блок', interruptResist: 'Стойк. к прерыв.',
  hpRegen: 'Реген HP', manaRegen: 'Реген маны', staminaRegen: 'Реген выносл.',
  addFire: 'Урон огнём', addCold: 'Урон холодом', addLightning: 'Урон молнией', addPoison: 'Урон ядом',
  resFire: 'Сопр. огню', resCold: 'Сопр. холоду', resLightning: 'Сопр. молнии', resPoison: 'Сопр. яду',
  damagePct: 'Ко всему урону', physPct: 'К физ. урону', firePct: 'К урону огнём', coldPct: 'К урону холодом',
  lightningPct: 'К урону молнией', poisonPct: 'К урону ядом', ailmentPct: 'К наложению статусов',
  lifeLeechPct: 'Вампиризм жизни', manaLeechPct: 'Вампиризм маны', lifeOnKill: 'Жизнь за убийство', manaOnKill: 'Мана за убийство',
  // Статы статусов: ими торгует оголовье скованного оружия (docs/CRAFT_WEAPONS.md §7).
  woundChancePct: 'Шанс раны', bleedChancePct: 'Шанс кровотечения', sunderChancePct: 'Шанс увечья', dazeChancePct: 'Шанс ошеломления',
  burnChancePct: 'Шанс поджига', poisonChancePct: 'Шанс отравления', shockChancePct: 'Шанс шока', freezeChancePct: 'Шанс заморозки',
  woundPowerPct: 'Сила раны', bleedPowerPct: 'Сила кровотечения', sunderPowerPct: 'Сила увечья', dazePowerPct: 'Сила ошеломления',
  burnPowerPct: 'Сила поджига', poisonPowerPct: 'Сила отравления', shockPowerPct: 'Сила шока', freezePowerPct: 'Сила заморозки',
};

export const SLOT_LABEL: Record<string, string> = {
  weapon: 'Оружие', offhand: 'Левая рука', helm: 'Шлем', chest: 'Нагрудник', gloves: 'Перчатки',
  boots: 'Сапоги', belt: 'Пояс', ring: 'Кольцо', amulet: 'Амулет',
};
const ATTACK_LABEL: Record<string, string> = { melee: 'ближний', ranged: 'дальний' };
const DMGKIND_LABEL: Record<string, string> = { physical: 'физический', magical: 'магический' };
const WCLASS_LABEL: Record<string, string> = {
  sword: 'меч', axe: 'топор', mace: 'булава', dagger: 'кинжал', spear: 'копьё', halberd: 'алебарда',
  bow: 'лук', crossbow: 'арбалет', wand: 'жезл', staff: 'посох',
};
const SHIELD_CLASS_LABEL: Record<string, string> = { light: 'лёгкий', medium: 'средний', heavy: 'тяжёлый' };
/** Статы-доли: их плоские модификаторы показываем как проценты. */
export const PERCENT_STATS = new Set([
  'critChance', 'blockChance', 'resFire', 'resCold', 'resLightning', 'resPoison',
  'damagePct', 'physPct', 'firePct', 'coldPct', 'lightningPct', 'poisonPct', 'ailmentPct', 'lifeLeechPct', 'manaLeechPct',
  'interruptResist',
  'woundChancePct', 'bleedChancePct', 'sunderChancePct', 'dazeChancePct', 'burnChancePct', 'poisonChancePct', 'shockChancePct', 'freezeChancePct',
  'woundPowerPct', 'bleedPowerPct', 'sunderPowerPct', 'dazePowerPct', 'burnPowerPct', 'poisonPowerPct', 'shockPowerPct', 'freezePowerPct',
]);

/** Резолверы имён из ЖИВЫХ конфигов (data-driven); дефолт — сырой id. */
export interface ItemLabels {
  /** Цена одноручного хвата у полуторного оружия; нет — умолчание из `versatile.ts`. */
  grip?: GripTuning;
  armorClass: (id: string) => string;
  weight: (id: string) => string;
  physSub: (id: string) => string;
  skill: (id: string) => string;
  dmgShort: (dt: string) => string;
}

/**
 * Вид стопки ЭССЕНЦИИ в подсказке (вместо «Сырьё» у прочих материалов): «Валюта чар · в стеке N». Имени материала здесь нет: его говорит
 * первая строка подсказки (имя вещи из `craft-materials`), а повтор зашитым текстом разошёлся бы с конфигом при первом же переименовании.
 */
export const ESSENCE_KIND = 'Валюта чар';

/** Подпись слота после имени (расходники — без слота). */
export function slotSuffix(item: Item): string {
  return item.slot && item.slot in SLOT_LABEL ? ` · ${SLOT_LABEL[item.slot]}` : '';
}

function fmtMod(m: StatModifier): string {
  const label = STAT_LABEL[m.stat] ?? m.stat;
  // ⚠ Знак — от значения, а не «+» всегда. У 38 аффиксов минусов нет, поэтому раньше это не всплывало;
  // скованное оружие пишет отрицательные моды (лёгкий клинок: −скорость у тяжёлого), и было бы «+-8%».
  const sign = m.value < 0 ? '−' : '+';
  const abs = Math.abs(m.value);
  if (m.kind === 'increased' || PERCENT_STATS.has(m.stat)) {
    // Доли процента (блок точки баланса клинка, §26: +0.4 п.п.) — с десятой, иначе читались бы «+0%».
    const pct = abs * 100;
    return `${sign}${Math.round(pct) === 0 ? pct.toFixed(1) : Math.round(pct)}% ${label}`;
  }
  return `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(2)} ${label}`;
}

/**
 * Вилка одной статы подписью: «(11–14)», а если после множителя концы совпали — одно число. Сравнивать
 * ПОСЛЕ округления: 5 и 6 при ×0.9 оба дают 5, и «(5–5)» читалось бы как ошибка.
 */
export function rangeLabel(r: [number, number], k = 1): string {
  const a = Math.round(r[0] * k), b = Math.round(r[1] * k);
  return a === b ? `${a}` : `(${a}–${b})`;
}

/** Строки эффекта расходника (базовые, без цвета редкости). */
export function consumableLines(item: Item): string[] {
  const u = item.use;
  if (!u) return [];
  const out: string[] = [];
  if (u.heal || u.healPct) out.push(`Восстанавливает ${u.heal ?? 0}${u.healPct ? ` +${Math.round(u.healPct * 100)}% макс.` : ''} HP`);
  if (u.mana || u.manaPct) out.push(`Восстанавливает ${u.mana ?? 0}${u.manaPct ? ` +${Math.round(u.manaPct * 100)}% макс.` : ''} маны`);
  if (u.cure) out.push('Снимает все негативные эффекты');
  if (u.buffMods?.length && u.buffDurationSec) out.push(`Бафф на ${u.buffDurationSec} сек`);
  return out;
}

/** Строка сигнатурной механики оружия (или null). */
function signatureLine(item: Item, R: ItemLabels): string | null {
  const parts: string[] = [];
  if (item.physSub) parts.push(R.physSub(item.physSub));
  if (item.stunChance) parts.push(`оглушение ${Math.round(item.stunChance * 100)}%`);
  if (item.armorPenPct) parts.push(`броня цели −${Math.round(item.armorPenPct * 100)}%`);
  if (item.arcMult && item.arcMult > 1) parts.push('широкая дуга');
  if (item.reachMult && item.reachMult > 1) parts.push(`дальность ×${item.reachMult}`);
  if (item.lowHpBonusPct) parts.push(`+${Math.round(item.lowHpBonusPct * 100)}% по раненым`);
  if (item.knockback) parts.push('отбрасывание');
  return parts.length ? parts.join(', ') : null;
}

export interface ItemLine { text: string; affix: boolean }

/**
 * ЭТАЛОН СКОРОСТИ, как «скорость оружия» в D2: ×1.00 = базовая скорость движка — удар в секунду
 * (`stats.ts`: attackSpeed 1), то есть 60 ударов в минуту без бонусов героя.
 */
export const BASE_ATTACKS_PER_MIN = 60;

/**
 * СОБСТВЕННАЯ СКОРОСТЬ ОРУЖИЯ — множитель к эталону из модов самой вещи (у базы «−15 %», у скованной
 * ещё и вклад клинка). Тем же правилом, что считает бой: `(1 + flat) × (1 + increased)`. Аффиксы и
 * бонусы героя сюда не входят — это свойство оружия, а не билда.
 */
export function weaponSpeedOf(item: Pick<Item, 'baseStats'>): number {
  let flat = 0, inc = 0;
  for (const m of item.baseStats) if (m.stat === 'attackSpeed') { if (m.kind === 'flat') flat += m.value; else inc += m.value; }
  return (1 + flat) * (1 + inc);
}

/** Описание предмета строками с пометкой affix (база=false → белый, аффикс=true → цвет редкости). */
export function describeItem(item: Item, R: ItemLabels): ItemLine[] {
  if (item.kind === 'consumable') return consumableLines(item).map((text) => ({ text, affix: false }));
  // Материал: ни статов, ни требований — только сколько и на что годится.
  // ⚠ Эссенция — НЕ сырьё (валюта чар, своя семья вне лестницы сортов): строкой «Сырьё · в стеке 2» над «Не сырьё — валюта чар» подсказка
  // стопки противоречила сама себе. Вид у неё свой (`ESSENCE_KIND`); откуда, куда и цена — строками `materialNote` клиента, как у сырья.
  if (item.kind === 'material') {
    const kind = item.materialId === ESSENCE_ID ? ESSENCE_KIND : 'Сырьё';
    return [{ text: `${kind} · в стеке ${item.count ?? 1}`, affix: false },
            { text: 'Сдаётся в сундук, тратится у кузнеца', affix: false }];
  }
  const out: ItemLine[] = [];
  const base = (text: string): void => { out.push({ text, affix: false }); };
  const aff = (text: string): void => { out.push({ text, affix: true }); };

  // Сломано — ПЕРВОЙ строкой: это главное, что надо знать о вещи, потому что отменяет
  // всё остальное — надеть нельзя, пока не починишь.
  if (item.broken) base('⚠ Сломано — надеть нельзя, почини у кузнеца или разбери');
  // Перекатки конечны — потраченное показываем рядом с вещью, а не только в кузнице.
  if (item.rerolls) base(`Перекатано раз: ${item.rerolls}`);

  if (item.attackType) {
    const at = ATTACK_LABEL[item.attackType] ?? item.attackType;
    const dk = item.damageKind ? ` · ${DMGKIND_LABEL[item.damageKind] ?? item.damageKind}` : '';
    const cls = item.weaponClass ? ` · ${WCLASS_LABEL[item.weaponClass] ?? item.weaponClass}` : '';
    const wt = item.weight ? ` · ${R.weight(item.weight)}` : '';
    base(`Тип: ${at}${dk}${cls}${wt} · ${item.hands === 2 ? 'двуручное' : 'одноручное'}`);
  }
  if (item.armorClass) base(`Броня: ${R.armorClass(item.armorClass)}`);
  if (item.shieldClass) base(`Щит: ${SHIELD_CLASS_LABEL[item.shieldClass] ?? item.shieldClass}`);
  if (item.beltSlots) base(`Слотов под зелья: ${item.beltSlots}`);
  const minD = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat');
  const maxD = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat');
  const hasDmg = item.attackType && minD && maxD;
  // Урон — уже с множителем удара вещи (форма клинка скованного оружия): приписки «+10 %» нет.
  const hm = item.damageMult ?? 1;
  // Предпросмотр ковки: чисел ещё нет — вилка «(низ–верх)» по каждой границе, как у D2 на базе.
  const rp = item.rollPreview;
  const span = (r: [number, number] | undefined, v: number, k = 1): string => rangeLabel(r ?? [v, v], k);
  if (hasDmg) base(`Урон: ${span(rp?.minDamage, minD!.value, hm)}–${span(rp?.maxDamage, maxD!.value, hm)} (${R.dmgShort(item.damageType ?? 'physical')})`);
  // Скорость оружия — множителем от эталона, а не строкой «−15 % скор. атаки»: собственные моды
  // скорости вещи и есть этот множитель, отдельными строками их не дублируем.
  if (hasDmg) {
    const w = weaponSpeedOf(item);
    base(`Скорость: ×${w.toFixed(2)} · ${Math.round(w * BASE_ATTACKS_PER_MIN)} уд/мин`);
  }
  // ⭐ ПОЛУТОРНОЕ: обе строки сразу, иначе игрок не узнает, что меч можно взять и одной рукой.
  // Режим в подсказке не показываем — он зависит от того, занята ли вторая рука прямо сейчас.
  if (hasDmg && isVersatile(item)) {
    const grip = R.grip ?? DEFAULT_GRIP;
    const one = gripAdjust(item, grip);
    const o1 = one.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat')!.value;
    const o2 = one.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat')!.value;
    const ow = weaponSpeedOf(one);
    // ⚠ V-B3-01: у предпросмотра ковки и одноручный урон — ВИЛКОЙ, тем же правилом, что считает вещь (`gripAdjust`: округление
    // после хвата, затем множитель удара) по каждому краю вилки. Раньше здесь стояло одно число — середина вилки предпросмотра,
    // и скованная вещь (бросок в вилке) почти никогда с ним не совпадала.
    const oneRange = (r: [number, number] | undefined, v: number): string =>
      rangeLabel(r ? [Math.round(r[0] * grip.damage), Math.round(r[1] * grip.damage)] : [v, v], hm);
    base(`Одной рукой (со щитом): ${oneRange(rp?.minDamage, o1)}–${oneRange(rp?.maxDamage, o2)} · ×${ow.toFixed(2)} · ${Math.round(ow * BASE_ATTACKS_PER_MIN)} уд/мин`);
  }
  const sig = signatureLine(item, R);
  if (sig) base(`✦ ${sig}`);
  // Одинаковые моды — одной строкой, суммой: блок базы и блок точки баланса клинка (§26) игрок видит
  // итогом «Шанс блока 9 %», а не двумя слагаемыми. Сумма в ноль строку не печатает.
  const merged: StatModifier[] = [];
  for (const m of item.baseStats) {
    if (hasDmg && (m === minD || m === maxD || m.stat === 'attackSpeed')) continue;
    const same = merged.find((x) => x.stat === m.stat && x.kind === m.kind);
    if (same) same.value = Math.round((same.value + m.value) * 1e4) / 1e4;
    else merged.push({ ...m });
  }
  const isPct = (m: StatModifier): boolean => m.kind === 'increased' || PERCENT_STATS.has(m.stat);
  for (const m of merged) {
    // Ноль и то, что при показе стало бы нулём (меньше 0.05 %), строкой не печатаем.
    if (m.value === 0 || (isPct(m) && Math.abs(m.value) < 0.0005)) continue;
    if (rp?.armor && m.stat === 'armor' && m.kind === 'flat') { base(`+${span(rp.armor, m.value)} ${STAT_LABEL.armor}`); continue; }
    base(fmtMod(m));
  }
  for (const a of item.affixes) {
    if (a.modifier) aff(fmtMod(a.modifier));
    else if (a.proc) aff(`${Math.round(a.proc.chance * 100)}% скаст «${R.skill(a.proc.skillId)}» (ур.${a.proc.level}) ${a.proc.trigger === 'struck' ? 'при получении удара' : 'при ударе'}`);
  }
  const reqs = Object.entries(item.requirements);
  if (reqs.length) base('Требует: ' + reqs.map(([k, v]) => `${STAT_LABEL[k] ?? k} ${v}`).join(', '));
  base(`Уровень предмета: ${item.itemLevel}`);
  return out;
}
