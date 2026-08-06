import type { Item } from '../types/items.js';
import type { StatModifier } from '../types/attributes.js';

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
]);

/** Резолверы имён из ЖИВЫХ конфигов (data-driven); дефолт — сырой id. */
export interface ItemLabels {
  armorClass: (id: string) => string;
  weight: (id: string) => string;
  physSub: (id: string) => string;
  skill: (id: string) => string;
  dmgShort: (dt: string) => string;
}

/** Подпись слота после имени (расходники — без слота). */
export function slotSuffix(item: Item): string {
  return item.slot && item.slot in SLOT_LABEL ? ` · ${SLOT_LABEL[item.slot]}` : '';
}

function fmtMod(m: StatModifier): string {
  const label = STAT_LABEL[m.stat] ?? m.stat;
  if (m.kind === 'increased' || PERCENT_STATS.has(m.stat)) return `+${Math.round(m.value * 100)}% ${label}`;
  return `+${Number.isInteger(m.value) ? m.value : m.value.toFixed(2)} ${label}`;
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

/** Описание предмета строками с пометкой affix (база=false → белый, аффикс=true → цвет редкости). */
export function describeItem(item: Item, R: ItemLabels): ItemLine[] {
  if (item.kind === 'consumable') return consumableLines(item).map((text) => ({ text, affix: false }));
  const out: ItemLine[] = [];
  const base = (text: string): void => { out.push({ text, affix: false }); };
  const aff = (text: string): void => { out.push({ text, affix: true }); };

  if (item.attackType) {
    const at = ATTACK_LABEL[item.attackType] ?? item.attackType;
    const dk = item.damageKind ? ` · ${DMGKIND_LABEL[item.damageKind] ?? item.damageKind}` : '';
    const cls = item.weaponClass ? ` · ${WCLASS_LABEL[item.weaponClass] ?? item.weaponClass}` : '';
    const wt = item.weight ? ` · ${R.weight(item.weight)}` : '';
    base(`Тип: ${at}${dk}${cls}${wt} · ${item.hands === 2 ? 'двуручное' : 'одноручное'}`);
  }
  if (item.armorClass) base(`Броня: ${R.armorClass(item.armorClass)}`);
  if (item.shieldClass) base(`Щит: ${SHIELD_CLASS_LABEL[item.shieldClass] ?? item.shieldClass}`);
  const minD = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat');
  const maxD = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat');
  const hasDmg = item.attackType && minD && maxD;
  if (hasDmg) base(`Урон: ${minD!.value}–${maxD!.value} (${R.dmgShort(item.damageType ?? 'physical')})`);
  const sig = signatureLine(item, R);
  if (sig) base(`✦ ${sig}`);
  for (const m of item.baseStats) { if (hasDmg && (m === minD || m === maxD)) continue; base(fmtMod(m)); }
  for (const a of item.affixes) {
    if (a.modifier) aff(fmtMod(a.modifier));
    else if (a.proc) aff(`${Math.round(a.proc.chance * 100)}% скаст «${R.skill(a.proc.skillId)}» (ур.${a.proc.level}) ${a.proc.trigger === 'struck' ? 'при получении удара' : 'при ударе'}`);
  }
  const reqs = Object.entries(item.requirements);
  if (reqs.length) base('Требует: ' + reqs.map(([k, v]) => `${STAT_LABEL[k] ?? k} ${v}`).join(', '));
  base(`Уровень предмета: ${item.itemLevel}`);
  return out;
}
