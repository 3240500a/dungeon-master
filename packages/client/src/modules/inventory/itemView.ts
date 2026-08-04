import type { Item, StatModifier } from '@dm/shared';
import { rarityHex } from '../loot/rarity.js';
import { dmgShort } from '../../core/damageTypes.js';

/** Человекочитаемые названия статов. */
export const STAT_LABEL: Record<string, string> = {
  strength: 'Сила',
  dexterity: 'Ловкость',
  intelligence: 'Интеллект',
  vitality: 'Живучесть',
  maxHp: 'Здоровье',
  maxMana: 'Мана',
  minDamage: 'Мин. урон',
  maxDamage: 'Макс. урон',
  attackSpeed: 'Скор. атаки',
  castSpeed: 'Скор. каста',
  critChance: 'Шанс крита',
  critMultiplier: 'Множ. крита',
  armor: 'Броня',
  moveSpeed: 'Скор. движения',
  accuracy: 'Меткость',
  evade: 'Уклонение',
  blockChance: 'Блок',
  interruptResist: 'Стойк. к прерыв.',
  hpRegen: 'Реген HP',
  manaRegen: 'Реген маны',
  addFire: 'Урон огнём',
  addCold: 'Урон холодом',
  addLightning: 'Урон молнией',
  addPoison: 'Урон ядом',
  resFire: 'Сопр. огню',
  resCold: 'Сопр. холоду',
  resLightning: 'Сопр. молнии',
  resPoison: 'Сопр. яду',
  // Множители исходящего урона / наложения статусов (доля → показываем как %).
  damagePct: 'Ко всему урону',
  physPct: 'К физ. урону',
  firePct: 'К урону огнём',
  coldPct: 'К урону холодом',
  lightningPct: 'К урону молнией',
  poisonPct: 'К урону ядом',
  ailmentPct: 'К наложению статусов',
  lifeLeechPct: 'Вампиризм жизни',
  manaLeechPct: 'Вампиризм маны',
  lifeOnKill: 'Жизнь за убийство',
  manaOnKill: 'Мана за убийство',
};

const SLOT_LABEL: Record<string, string> = {
  weapon: 'Оружие',
  offhand: 'Левая рука',
  helm: 'Шлем',
  chest: 'Нагрудник',
  gloves: 'Перчатки',
  boots: 'Сапоги',
  belt: 'Пояс',
  ring: 'Кольцо',
  amulet: 'Амулет',
};

const ATTACK_LABEL: Record<string, string> = {
  melee: 'ближний',
  ranged: 'дальний',
};
const DMGKIND_LABEL: Record<string, string> = {
  physical: 'физический',
  magical: 'магический',
};

/** Подпись слота после имени (расходники — без слота). */
function slotSuffix(item: Item): string {
  return item.slot && item.slot in SLOT_LABEL ? ` · ${SLOT_LABEL[item.slot]}` : '';
}

/** Строки описания эффекта расходника для тултипа. */
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

/** Статы-доли: их плоские модификаторы показываем как проценты. */
const PERCENT_STATS = new Set([
  'critChance', 'blockChance',
  'resFire', 'resCold', 'resLightning', 'resPoison',
  'damagePct', 'physPct', 'firePct', 'coldPct', 'lightningPct', 'poisonPct', 'ailmentPct',
  'lifeLeechPct', 'manaLeechPct',
]);

function fmtMod(m: StatModifier): string {
  const label = STAT_LABEL[m.stat] ?? m.stat;
  if (m.kind === 'increased') return `+${Math.round(m.value * 100)}% ${label}`;
  if (PERCENT_STATS.has(m.stat)) return `+${Math.round(m.value * 100)}% ${label}`;
  const val = Number.isInteger(m.value) ? m.value : m.value.toFixed(2);
  return `+${val} ${label}`;
}

const WCLASS_LABEL: Record<string, string> = {
  sword: 'меч', axe: 'топор', mace: 'булава', dagger: 'кинжал', spear: 'копьё',
  bow: 'лук', crossbow: 'арбалет', wand: 'жезл', staff: 'посох',
};
// Имена классов брони / весов / физ-подтипов берутся из ЖИВЫХ конфигов (data-driven).
// App ставит резолверы при старте; до этого — сырой id.
export interface ItemLabelResolvers {
  armorClass: (id: string) => string;
  weight: (id: string) => string;
  physSub: (id: string) => string;
  /** Имя активного скилла по id узла (для прока «шанс каста»). */
  skill: (id: string) => string;
}
let labels: ItemLabelResolvers = { armorClass: (id) => id, weight: (id) => id, physSub: (id) => id, skill: (id) => id };
export function setItemLabelResolvers(r: ItemLabelResolvers): void {
  labels = r;
}
const SHIELD_CLASS_LABEL: Record<string, string> = {
  light: 'лёгкий', medium: 'средний', heavy: 'тяжёлый',
};

/** Строка сигнатурной механики оружия (или null). */
function signatureLine(item: Item): string | null {
  const parts: string[] = [];
  if (item.physSub) parts.push(labels.physSub(item.physSub));
  if (item.stunChance) parts.push(`оглушение ${Math.round(item.stunChance * 100)}%`);
  if (item.armorPenPct) parts.push(`броня цели −${Math.round(item.armorPenPct * 100)}%`);
  if (item.arcMult && item.arcMult > 1) parts.push('широкая дуга');
  if (item.reachMult && item.reachMult > 1) parts.push(`дальность ×${item.reachMult}`);
  if (item.lowHpBonusPct) parts.push(`+${Math.round(item.lowHpBonusPct * 100)}% по раненым`);
  if (item.knockback) parts.push('отбрасывание');
  return parts.length ? parts.join(', ') : null;
}

/** Строки для тултипа предмета (без HTML). */
export function itemLines(item: Item): string[] {
  if (item.kind === 'consumable') return consumableLines(item); // расходники — только эффект
  const lines: string[] = [];
  if (item.attackType) {
    const at = ATTACK_LABEL[item.attackType] ?? item.attackType;
    const dk = item.damageKind ? ` · ${DMGKIND_LABEL[item.damageKind] ?? item.damageKind}` : '';
    const cls = item.weaponClass ? ` · ${WCLASS_LABEL[item.weaponClass] ?? item.weaponClass}` : '';
    const wt = item.weight ? ` · ${labels.weight(item.weight)}` : '';
    const hnd = ` · ${item.hands === 2 ? 'двуручное' : 'одноручное'}`;
    lines.push(`Тип: ${at}${dk}${cls}${wt}${hnd}`);
  }
  if (item.armorClass) lines.push(`Броня: ${labels.armorClass(item.armorClass)}`);
  if (item.shieldClass) lines.push(`Щит: ${SHIELD_CLASS_LABEL[item.shieldClass] ?? item.shieldClass}`);
  // Базовый урон оружия — одной строкой с типом стихии (у жезла огня — огонь).
  const minD = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat');
  const maxD = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat');
  const hasDmg = item.attackType && minD && maxD;
  if (hasDmg) {
    const dt = item.damageType ?? 'physical';
    lines.push(`Урон: ${minD!.value}–${maxD!.value} (${dmgShort(dt)})`);
  }
  const sig = signatureLine(item);
  if (sig) lines.push(`✦ ${sig}`);
  for (const m of item.baseStats) {
    if (hasDmg && (m === minD || m === maxD)) continue;
    lines.push(fmtMod(m));
  }
  for (const a of item.affixes) {
    if (a.modifier) lines.push(fmtMod(a.modifier));
    else if (a.proc) lines.push(`${Math.round(a.proc.chance * 100)}% скаст «${labels.skill(a.proc.skillId)}» (ур.${a.proc.level}) ${a.proc.trigger === 'struck' ? 'при получении удара' : 'при ударе'}`);
  }
  const reqs = Object.entries(item.requirements);
  if (reqs.length) {
    lines.push(
      'Требует: ' +
        reqs.map(([k, v]) => `${STAT_LABEL[k] ?? k} ${v}`).join(', '),
    );
  }
  lines.push(`Уровень предмета: ${item.itemLevel}`);
  return lines;
}

/** DOM-элемент карточки предмета с тултипом. */
export function itemCard(item: Item, onClick?: () => void): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    border: `1px solid ${rarityHex(item.rarity)}`,
    borderRadius: '6px',
    padding: '6px 8px',
    margin: '4px 0',
    cursor: onClick ? 'pointer' : 'default',
    background: '#171b24',
  } satisfies Partial<CSSStyleDeclaration>);

  const title = document.createElement('div');
  title.textContent = `${item.name}${slotSuffix(item)}`;
  title.style.color = rarityHex(item.rarity);
  title.style.fontWeight = 'bold';
  el.appendChild(title);

  for (const line of itemLines(item)) {
    const p = document.createElement('div');
    p.textContent = line;
    p.style.fontSize = '12px';
    p.style.color = '#c4bca8';
    el.appendChild(p);
  }

  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** HTML для тултипа предмета; при `compareTo` показывает, что сейчас надето. */
export function itemTooltipHtml(item: Item, compareTo?: Item | null): string {
  const color = rarityHex(item.rarity);
  const head = `<div style="color:${color};font-weight:bold;margin-bottom:4px">${item.name}${slotSuffix(item)}</div>`;
  const lines = itemLines(item)
    .map((l) => `<div style="color:#c4bca8">${l}</div>`)
    .join('');
  let cmp = '';
  if (compareTo && compareTo.uid !== item.uid) {
    const cLines = itemLines(compareTo)
      .map((l) => `<div style="color:#6a655c">${l}</div>`)
      .join('');
    cmp =
      `<div style="margin-top:6px;border-top:1px solid #2b323f;padding-top:4px">` +
      `<div style="color:#8f897c">Сейчас надето: ${compareTo.name}</div>${cLines}</div>`;
  }
  return head + lines + cmp;
}

export { SLOT_LABEL };
