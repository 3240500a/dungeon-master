import type { Item } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';
import { DEFAULT_GRIP, gripAdjust, isVersatile, type GripTuning } from './versatile.js';
import { ESSENCE_ID } from './salvage.js';
import { tr } from '../i18n/tr.js';

/**
 * ЕДИНЫЙ форматтер описания предмета (без DOM/Phaser) — используется и игрой (клиентский itemView),
 * и редактором (генератор предметов), чтобы тултип отображался ОДИНАКОВО. Статические подписи здесь;
 * динамические имена (классы брони/веса/подтипы/скиллы/стихии из конфигов) приходят резолверами `R`.
 * Каждая строка помечена `affix`: базовые свойства (false) рисуются белым, добавленное аффиксами
 * (true) — цветом редкости предмета.
 *
 * ⭐ i18n Ф1 (06.11): подписи таблиц — ГЕТТЕРЫ (`tr` на каждое чтение), а не строки: модуль грузится один раз на процесс, а язык — у
 * каждого игрока свой (область текста сервера). `STAT_LABEL[k]`, `k in SLOT_LABEL`, `Object.keys` работают как прежде.
 */
export const STAT_LABEL: Record<string, string> = {
  get strength() { return tr('srv:stat.strength', 'Сила'); },
  get dexterity() { return tr('srv:stat.dexterity', 'Ловкость'); },
  get intelligence() { return tr('srv:stat.intelligence', 'Интеллект'); },
  get vitality() { return tr('srv:stat.vitality', 'Живучесть'); },
  get maxHp() { return tr('srv:stat.maxHp', 'Здоровье'); },
  get maxMana() { return tr('srv:stat.maxMana', 'Мана'); },
  get maxStamina() { return tr('srv:stat.maxStamina', 'Выносливость'); },
  get minDamage() { return tr('srv:stat.minDamage', 'Мин. урон'); },
  get maxDamage() { return tr('srv:stat.maxDamage', 'Макс. урон'); },
  get attackSpeed() { return tr('srv:stat.attackSpeed', 'Скор. атаки'); },
  get castSpeed() { return tr('srv:stat.castSpeed', 'Скор. каста'); },
  get critChance() { return tr('srv:stat.critChance', 'Шанс крита'); },
  get critMultiplier() { return tr('srv:stat.critMultiplier', 'Множ. крита'); },
  get armor() { return tr('srv:stat.armor', 'Броня'); },
  get moveSpeed() { return tr('srv:stat.moveSpeed', 'Скор. движения'); },
  get accuracy() { return tr('srv:stat.accuracy', 'Меткость'); },
  get evade() { return tr('srv:stat.evade', 'Уклонение'); },
  get blockChance() { return tr('srv:stat.blockChance', 'Блок'); },
  get interruptResist() { return tr('srv:stat.interruptResist', 'Стойк. к прерыв.'); },
  get hpRegen() { return tr('srv:stat.hpRegen', 'Реген HP'); },
  get manaRegen() { return tr('srv:stat.manaRegen', 'Реген маны'); },
  get staminaRegen() { return tr('srv:stat.staminaRegen', 'Реген выносл.'); },
  get addFire() { return tr('srv:stat.addFire', 'Урон огнём'); },
  get addCold() { return tr('srv:stat.addCold', 'Урон холодом'); },
  get addLightning() { return tr('srv:stat.addLightning', 'Урон молнией'); },
  get addPoison() { return tr('srv:stat.addPoison', 'Урон ядом'); },
  get resFire() { return tr('srv:stat.resFire', 'Сопр. огню'); },
  get resCold() { return tr('srv:stat.resCold', 'Сопр. холоду'); },
  get resLightning() { return tr('srv:stat.resLightning', 'Сопр. молнии'); },
  get resPoison() { return tr('srv:stat.resPoison', 'Сопр. яду'); },
  get damagePct() { return tr('srv:stat.damagePct', 'Ко всему урону'); },
  get physPct() { return tr('srv:stat.physPct', 'К физ. урону'); },
  get firePct() { return tr('srv:stat.firePct', 'К урону огнём'); },
  get coldPct() { return tr('srv:stat.coldPct', 'К урону холодом'); },
  get lightningPct() { return tr('srv:stat.lightningPct', 'К урону молнией'); },
  get poisonPct() { return tr('srv:stat.poisonPct', 'К урону ядом'); },
  get ailmentPct() { return tr('srv:stat.ailmentPct', 'К наложению статусов'); },
  get lifeLeechPct() { return tr('srv:stat.lifeLeechPct', 'Вампиризм жизни'); },
  get manaLeechPct() { return tr('srv:stat.manaLeechPct', 'Вампиризм маны'); },
  get lifeOnKill() { return tr('srv:stat.lifeOnKill', 'Жизнь за убийство'); },
  get manaOnKill() { return tr('srv:stat.manaOnKill', 'Мана за убийство'); },
  // Статы статусов: ими торгует оголовье скованного оружия (docs/CRAFT_WEAPONS.md §7).
  get woundChancePct() { return tr('srv:stat.woundChancePct', 'Шанс раны'); },
  get bleedChancePct() { return tr('srv:stat.bleedChancePct', 'Шанс кровотечения'); },
  get sunderChancePct() { return tr('srv:stat.sunderChancePct', 'Шанс увечья'); },
  get dazeChancePct() { return tr('srv:stat.dazeChancePct', 'Шанс ошеломления'); },
  get burnChancePct() { return tr('srv:stat.burnChancePct', 'Шанс поджига'); },
  get poisonChancePct() { return tr('srv:stat.poisonChancePct', 'Шанс отравления'); },
  get shockChancePct() { return tr('srv:stat.shockChancePct', 'Шанс шока'); },
  get freezeChancePct() { return tr('srv:stat.freezeChancePct', 'Шанс заморозки'); },
  get woundPowerPct() { return tr('srv:stat.woundPowerPct', 'Сила раны'); },
  get bleedPowerPct() { return tr('srv:stat.bleedPowerPct', 'Сила кровотечения'); },
  get sunderPowerPct() { return tr('srv:stat.sunderPowerPct', 'Сила увечья'); },
  get dazePowerPct() { return tr('srv:stat.dazePowerPct', 'Сила ошеломления'); },
  get burnPowerPct() { return tr('srv:stat.burnPowerPct', 'Сила поджига'); },
  get poisonPowerPct() { return tr('srv:stat.poisonPowerPct', 'Сила отравления'); },
  get shockPowerPct() { return tr('srv:stat.shockPowerPct', 'Сила шока'); },
  get freezePowerPct() { return tr('srv:stat.freezePowerPct', 'Сила заморозки'); },
};

export const SLOT_LABEL: Record<string, string> = {
  get weapon() { return tr('srv:slot.weapon', 'Оружие'); },
  get offhand() { return tr('srv:slot.offhand', 'Левая рука'); },
  get helm() { return tr('srv:slot.helm', 'Шлем'); },
  get chest() { return tr('srv:slot.chest', 'Нагрудник'); },
  get gloves() { return tr('srv:slot.gloves', 'Перчатки'); },
  get boots() { return tr('srv:slot.boots', 'Сапоги'); },
  get belt() { return tr('srv:slot.belt', 'Пояс'); },
  get ring() { return tr('srv:slot.ring', 'Кольцо'); },
  get amulet() { return tr('srv:slot.amulet', 'Амулет'); },
};
const ATTACK_LABEL: Record<string, string> = { get melee() { return tr('srv:attackKind.melee', 'ближний'); }, get ranged() { return tr('srv:attackKind.ranged', 'дальний'); } };
const DMGKIND_LABEL: Record<string, string> = { get physical() { return tr('srv:dmgKind.physical', 'физический'); }, get magical() { return tr('srv:dmgKind.magical', 'магический'); } };
const WCLASS_LABEL: Record<string, string> = {
  get sword() { return tr('srv:weaponClass.sword', 'меч'); },
  get axe() { return tr('srv:weaponClass.axe', 'топор'); },
  get mace() { return tr('srv:weaponClass.mace', 'булава'); },
  get dagger() { return tr('srv:weaponClass.dagger', 'кинжал'); },
  get spear() { return tr('srv:weaponClass.spear', 'копьё'); },
  get halberd() { return tr('srv:weaponClass.halberd', 'алебарда'); },
  get bow() { return tr('srv:weaponClass.bow', 'лук'); },
  get crossbow() { return tr('srv:weaponClass.crossbow', 'арбалет'); },
  get wand() { return tr('srv:weaponClass.wand', 'жезл'); },
  get staff() { return tr('srv:weaponClass.staff', 'посох'); },
};
const SHIELD_CLASS_LABEL: Record<string, string> = { get light() { return tr('srv:shieldClass.light', 'лёгкий'); }, get medium() { return tr('srv:shieldClass.medium', 'средний'); }, get heavy() { return tr('srv:shieldClass.heavy', 'тяжёлый'); } };
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
  // ⭐ i18n Ф1 (06.11): «+N% макс.» — вариант предложения, а не вставка-кусок
  if (u.heal || u.healPct) {
    out.push(u.healPct
      ? tr('srv:item.healPct', 'Восстанавливает {heal} +{pct}% макс. HP', { heal: u.heal ?? 0, pct: Math.round(u.healPct * 100) })
      : tr('srv:item.heal', 'Восстанавливает {heal} HP', { heal: u.heal ?? 0 }));
  }
  if (u.mana || u.manaPct) {
    out.push(u.manaPct
      ? tr('srv:item.manaPct', 'Восстанавливает {mana} +{pct}% макс. маны', { mana: u.mana ?? 0, pct: Math.round(u.manaPct * 100) })
      : tr('srv:item.mana', 'Восстанавливает {mana} маны', { mana: u.mana ?? 0 }));
  }
  if (u.cure) out.push(tr('srv:item.cure', 'Снимает все негативные эффекты'));
  if (u.buffMods?.length && u.buffDurationSec) out.push(tr('srv:item.buff', 'Бафф на {buffDurationSec} сек', { buffDurationSec: u.buffDurationSec }));
  return out;
}

/** Строка сигнатурной механики оружия (или null). */
function signatureLine(item: Item, R: ItemLabels): string | null {
  const parts: string[] = [];
  if (item.physSub) parts.push(R.physSub(item.physSub));
  if (item.stunChance) parts.push(tr('srv:item.sigStun', 'оглушение {stunChance}%', { stunChance: Math.round(item.stunChance * 100) }));
  if (item.armorPenPct) parts.push(tr('srv:item.sigArmorPen', 'броня цели −{armorPenPct}%', { armorPenPct: Math.round(item.armorPenPct * 100) }));
  if (item.arcMult && item.arcMult > 1) parts.push(tr('srv:item.sigWideArc', 'широкая дуга'));
  if (item.reachMult && item.reachMult > 1) parts.push(tr('srv:item.sigReach', 'дальность ×{reachMult}', { reachMult: item.reachMult }));
  if (item.lowHpBonusPct) parts.push(tr('srv:item.sigLowHp', '+{lowHpBonusPct}% по раненым', { lowHpBonusPct: Math.round(item.lowHpBonusPct * 100) }));
  if (item.knockback) parts.push(tr('srv:item.sigKnockback', 'отбрасывание'));
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
    const kind = item.materialId === ESSENCE_ID ? tr('srv:item.essenceKind', ESSENCE_KIND) : tr('srv:item.materialKind', 'Сырьё');
    return [{ text: tr('srv:item.stack', '{kind} · в стеке {count}', { kind, count: item.count ?? 1 }), affix: false },
            { text: tr('srv:item.materialNote', 'Сдаётся в сундук, тратится у кузнеца'), affix: false }];
  }
  // ⭐⭐ Ф5-1: ПЕЧАТЬ — ДВЕ СТРОКИ СРАЗУ: чем опаснее и чем богаче. Статы в самом предмете НЕ лежат
  // (они в конфиге `seals`), поэтому строки даёт `sealLines` рядом с реестром, а здесь — только то, что видно из вещи.
  if (item.kind === 'seal') {
    const n = item.count ?? 1;
    return [{ text: n > 1 ? tr('srv:item.sealStack', 'Печать отрезка · в стеке {n}', { n }) : tr('srv:item.seal', 'Печать отрезка'), affix: false },
            { text: tr('srv:item.sealNote', 'Вставляется на алтаре метки — опаснее и богаче до следующей метки'), affix: false }];
  }
  const out: ItemLine[] = [];
  const base = (text: string): void => { out.push({ text, affix: false }); };
  const aff = (text: string): void => { out.push({ text, affix: true }); };

  // Сломано — ПЕРВОЙ строкой: это главное, что надо знать о вещи, потому что отменяет
  // всё остальное — надеть нельзя, пока не починишь.
  if (item.broken) base(tr('srv:item.broken', '⚠ Сломано — надеть нельзя, почини у кузнеца или разбери'));
  // Перекатки конечны — потраченное показываем рядом с вещью, а не только в кузнице.
  if (item.rerolls) base(tr('srv:item.rerolled', 'Перекатано раз: {rerolls}', { rerolls: item.rerolls }));

  if (item.attackType) {
    const at = ATTACK_LABEL[item.attackType] ?? item.attackType;
    const dk = item.damageKind ? ` · ${DMGKIND_LABEL[item.damageKind] ?? item.damageKind}` : '';
    const cls = item.weaponClass ? ` · ${WCLASS_LABEL[item.weaponClass] ?? item.weaponClass}` : '';
    const wt = item.weight ? ` · ${R.weight(item.weight)}` : '';
    base(tr('srv:item.typeLine', 'Тип: {at}{dk}{cls}{wt} · {hands}', { at, dk, cls, wt, hands: item.hands === 2 ? tr('srv:item.twoHanded', 'двуручное') : tr('srv:item.oneHanded', 'одноручное') }));
  }
  if (item.armorClass) base(tr('srv:item.armorLine', 'Броня: {cls}', { cls: R.armorClass(item.armorClass) }));
  if (item.shieldClass) base(tr('srv:item.shieldLine', 'Щит: {cls}', { cls: SHIELD_CLASS_LABEL[item.shieldClass] ?? item.shieldClass }));
  if (item.beltSlots) base(tr('srv:item.beltSlots', 'Слотов под зелья: {beltSlots}', { beltSlots: item.beltSlots }));
  const minD = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat');
  const maxD = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat');
  const hasDmg = item.attackType && minD && maxD;
  // Урон — уже с множителем удара вещи (форма клинка скованного оружия): приписки «+10 %» нет.
  const hm = item.damageMult ?? 1;
  // Предпросмотр ковки: чисел ещё нет — вилка «(низ–верх)» по каждой границе, как у D2 на базе.
  const rp = item.rollPreview;
  const span = (r: [number, number] | undefined, v: number, k = 1): string => rangeLabel(r ?? [v, v], k);
  if (hasDmg) base(tr('srv:item.damageLine', 'Урон: {min}–{max} ({type})', { min: span(rp?.minDamage, minD!.value, hm), max: span(rp?.maxDamage, maxD!.value, hm), type: R.dmgShort(item.damageType ?? 'physical') }));
  // Скорость оружия — множителем от эталона, а не строкой «−15 % скор. атаки»: собственные моды
  // скорости вещи и есть этот множитель, отдельными строками их не дублируем.
  if (hasDmg) {
    const w = weaponSpeedOf(item);
    base(tr('srv:item.speedLine', 'Скорость: ×{mult} · {perMin} уд/мин', { mult: w.toFixed(2), perMin: Math.round(w * BASE_ATTACKS_PER_MIN) }));
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
    base(tr('srv:item.oneHandLine', 'Одной рукой (со щитом): {min}–{max} · ×{mult} · {perMin} уд/мин', { min: oneRange(rp?.minDamage, o1), max: oneRange(rp?.maxDamage, o2), mult: ow.toFixed(2), perMin: Math.round(ow * BASE_ATTACKS_PER_MIN) }));
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
    else if (a.proc) {
      const p = { chance: Math.round(a.proc.chance * 100), skill: R.skill(a.proc.skillId), level: a.proc.level };
      aff(a.proc.trigger === 'struck'
        ? tr('srv:item.procStruck', '{chance}% скаст «{skill}» (ур.{level}) при получении удара', p)
        : tr('srv:item.procHit', '{chance}% скаст «{skill}» (ур.{level}) при ударе', p));
    }
  }
  const reqs = Object.entries(item.requirements);
  if (reqs.length) base(tr('srv:item.requires', 'Требует: {list}', { list: reqs.map(([k, v]) => `${STAT_LABEL[k] ?? k} ${v}`).join(', ') }));
  base(tr('srv:item.itemLevel', 'Уровень предмета: {itemLevel}', { itemLevel: item.itemLevel }));
  return out;
}
