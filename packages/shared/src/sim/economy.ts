import { ConfigRegistry } from '../config/registry.js';
import { generateItem } from '../formulas/itemgen.js';
import { meetsRequirements } from '../formulas/stats.js';
import { estimateAttack } from '../formulas/playerCombat.js';
import type { Rng } from '../formulas/rng.js';
import type { StatModifier } from '../types/attributes.js';
import type { Item, Rarity, WeaponType } from '../types/items.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import { botAttrs, botDerived } from './playerBot.js';
import type { BuildPolicy } from './types.js';

/**
 * Экономика бота: скоринг предметов (лучший DPS для оружия, взвешенно для брони),
 * решение экип/продать, магазин, вложение очков скиллов и золота в пассивы.
 * Все веса — грубые, доводятся на калибровке (Фаза D). Approx: дуал-вилд/двуручное
 * в экипе не различаем (сравниваем по слоту), смежность пассивов учитываем.
 */

type Rarities = ConfigShapes['rarities'];
const priceMult = (rarities: Rarities, id: Rarity): number => rarities.find((r) => r.id === id)?.priceMult ?? 1;

const OFFENSE_STATS = new Set([
  'minDamage', 'maxDamage', 'critChance', 'critMultiplier', 'accuracy',
  'addFire', 'addCold', 'addLightning', 'addPoison', 'attackSpeed',
]);
const DEFENSE_STATS = new Set([
  'armor', 'maxHp', 'blockChance', 'evade', 'hpRegen', 'manaRegen',
  'resFire', 'resCold', 'resLightning', 'resPoison',
]);

const FLAT_WEIGHT: Record<string, number> = {
  armor: 1, maxHp: 0.5, evade: 0.5, blockChance: 40, hpRegen: 2, manaRegen: 1,
  resFire: 60, resCold: 60, resLightning: 60, resPoison: 60,
  minDamage: 3, maxDamage: 3, accuracy: 0.3, critChance: 80, critMultiplier: 20,
  addFire: 3, addCold: 3, addLightning: 3, addPoison: 3,
  strength: 2, dexterity: 2, intelligence: 2, vitality: 3,
};
const INC_WEIGHT: Record<string, number> = {
  attackSpeed: 60, moveSpeed: 8, maxHp: 20, armor: 8, minDamage: 20, maxDamage: 20,
};

export function sellValue(item: Item, rarities: Rarities): number {
  return Math.round((15 + item.itemLevel * 4) * priceMult(rarities, item.rarity) * 0.35);
}
export function buyPrice(item: Item, rarities: Rarities): number {
  return Math.round((15 + item.itemLevel * 4) * priceMult(rarities, item.rarity));
}

function itemMods(item: Item): StatModifier[] {
  return [...item.baseStats, ...item.affixes.map((a) => a.modifier)];
}

/** Взвешенная оценка «полезности» набора модификаторов с учётом уклона урон/защита. */
function scoreMods(mods: StatModifier[], offenseBias: number): number {
  let s = 0;
  for (const m of mods) {
    const w = m.kind === 'flat' ? (FLAT_WEIGHT[m.stat] ?? 0) : (INC_WEIGHT[m.stat] ?? 0);
    let val = m.value * w;
    if (OFFENSE_STATS.has(m.stat)) val *= 0.5 + offenseBias;
    else if (DEFENSE_STATS.has(m.stat)) val *= 0.5 + (1 - offenseBias);
    s += val;
  }
  return s;
}

/** Профильный тип оружия класса (по стартовому оружию). */
export function classWeaponType(reg: ConfigRegistry, classId: string): WeaponType {
  const cls = reg.get('classes').find((c) => c.id === classId);
  const w = cls ? reg.get('items.base').find((b) => b.id === cls.startWeaponId) : undefined;
  return (w?.kind === 'weapon' ? w.weaponType : 'melee') as WeaponType;
}

function isWeaponLike(item: Item): boolean {
  return item.slot === 'weapon' || (item.slot === 'offhand' && !!item.weaponType);
}

/** Скор предмета для решения экипа. Оружие — по фактическому DPS (мягко к своему типу). */
export function scoreItem(reg: ConfigRegistry, save: SaveState, item: Item, policy: BuildPolicy): number {
  if (isWeaponLike(item)) {
    const d = botDerived(reg, save);
    const attrs = botAttrs(reg, save);
    const scaling = reg.get('balance').weaponAttrScaling;
    const avg = estimateAttack(d, attrs, item, scaling, reg.get('weapon-weights'));
    let incAps = 0;
    for (const m of itemMods(item)) if (m.stat === 'attackSpeed' && m.kind === 'increased') incAps += m.value;
    const dps = avg * (1 + incAps);
    const onType = item.weaponType === classWeaponType(reg, save.classId) ? 1.1 : 1.0;
    return dps * onType + scoreMods(itemMods(item), policy.offenseBias) * 0.1;
  }
  return scoreMods(itemMods(item), policy.offenseBias);
}

/**
 * Рассматривает подобранный предмет: если по скору лучше надетого и проходит
 * требования — надевает (старое продаёт); иначе продаёт. Мутирует save.
 * Возвращает true, если предмет надет.
 */
export function considerDrop(reg: ConfigRegistry, save: SaveState, item: Item, policy: BuildPolicy): boolean {
  const rarities = reg.get('rarities');
  // Расходники бот не экипирует — сразу в золото (нет слота).
  if (!item.slot || !meetsRequirements(item, save.attributes)) {
    save.gold += sellValue(item, rarities);
    return false;
  }
  const cur = save.equipment[item.slot];
  const curScore = cur ? scoreItem(reg, save, cur, policy) : -Infinity;
  if (scoreItem(reg, save, item, policy) > curScore) {
    if (cur) save.gold += sellValue(cur, rarities);
    save.equipment[item.slot] = item;
    return true;
  }
  save.gold += sellValue(item, rarities);
  return false;
}

/** Магазин: генерит сток на (level+1), покупает апгрейды по карману. Мутирует save. */
export function visitShop(reg: ConfigRegistry, save: SaveState, level: number, rng: Rng, policy: BuildPolicy): void {
  const itemsBase = reg.get('items.base');
  const affixes = reg.get('affixes');
  const uniques = reg.get('uniques');
  const rarities = reg.get('rarities');
  for (let i = 0; i < 8; i++) {
    const item = generateItem(itemsBase, affixes, uniques,
      { dropBias: 1.3, itemLevel: level + 1, tiers: reg.get('item-tiers'), rarities }, rng);
    const price = buyPrice(item, rarities);
    if (!item.slot || save.gold < price || !meetsRequirements(item, save.attributes)) continue;
    const cur = save.equipment[item.slot];
    const curScore = cur ? scoreItem(reg, save, cur, policy) : -Infinity;
    if (scoreItem(reg, save, item, policy) > curScore) {
      save.gold -= price;
      if (cur) save.gold += sellValue(cur, rarities);
      save.equipment[item.slot] = item;
    }
  }
}

// ── Скиллы и пассивы ─────────────────────────────────────────────────────────

/** Вкладывает очки скиллов в одну ветку активного дерева (с разбросом выбора ветки). */
function allocateActivePoints(reg: ConfigRegistry, save: SaveState, policy: BuildPolicy, rng: Rng): void {
  const tree = reg.get('skills-active').find((t) => t.classId === save.classId);
  if (!tree || tree.branches.length === 0) return;
  const branchId = policy.variance > 0 && rng.chance(policy.variance)
    ? rng.pick(tree.branches).id
    : tree.branches[0]!.id;

  const pick = (branch: string | null) => {
    const cands = tree.nodes.filter((n) => {
      if (branch && n.branchId !== branch) return false;
      const rank = save.activeSkills[n.id] ?? 0;
      if (rank >= n.maxRank) return false;
      if (n.levelReq > save.level) return false;
      if (!n.requires.every((r) => (save.activeSkills[r] ?? 0) > 0)) return false;
      return n.cost.amount <= save.unspentSkillPoints;
    });
    cands.sort((a, b) => a.levelReq - b.levelReq || (save.activeSkills[a.id] ?? 0) - (save.activeSkills[b.id] ?? 0));
    return cands[0];
  };

  for (let guard = 0; guard < 500 && save.unspentSkillPoints > 0; guard++) {
    const node = pick(branchId) ?? pick(null);
    if (!node) break;
    save.activeSkills[node.id] = (save.activeSkills[node.id] ?? 0) + 1;
    save.unspentSkillPoints -= node.cost.amount;
  }
}

function neighborMap(edges: readonly (readonly [string, string])[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (map.get(a) ?? map.set(a, []).get(a)!).push(b);
    (map.get(b) ?? map.set(b, []).get(b)!).push(a);
  }
  return map;
}

/** Тратит очки пассивов + золото жадно (польза/цена), уважая смежность и резерв на магазин. */
function allocatePassives(reg: ConfigRegistry, save: SaveState, policy: BuildPolicy, rng: Rng): void {
  const tree = reg.get('skills-passive');
  const mult = reg.get('balance').passiveRankCostMult;
  const nbr = neighborMap(tree.edges);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const unlocked = new Set<string>(tree.entryNodes);
  for (const [id, r] of Object.entries(save.passiveSkills)) {
    if (r > 0) { unlocked.add(id); for (const n of nbr.get(id) ?? []) unlocked.add(n); }
  }
  const reserve = 60 + save.level * 12; // держим золото на магазин
  void rng;

  for (let guard = 0; guard < 1000 && save.unspentPassivePoints > 0; guard++) {
    let best: { id: string; cost: number } | null = null;
    let bestVal = 0;
    for (const id of unlocked) {
      const node = byId.get(id);
      if (!node) continue;
      const rank = save.passiveSkills[id] ?? 0;
      if (rank >= node.maxRank) continue;
      const cost = Math.round(node.cost.amount * Math.pow(mult, rank));
      if (save.gold - cost < reserve) continue;
      const val = scoreMods(node.effect.modifiers ?? [], policy.offenseBias) / Math.max(1, cost);
      if (val > bestVal) { bestVal = val; best = { id, cost }; }
    }
    if (!best) break;
    save.passiveSkills[best.id] = (save.passiveSkills[best.id] ?? 0) + 1;
    save.gold -= best.cost;
    save.unspentPassivePoints -= 1;
    for (const n of nbr.get(best.id) ?? []) unlocked.add(n);
  }
}

/** Тратит доступные очки скиллов и золото в пассивы (если политика разрешает). */
export function allocateSkillsAndPassives(reg: ConfigRegistry, save: SaveState, policy: BuildPolicy, rng: Rng): void {
  if (!policy.useSkills) return;
  allocateActivePoints(reg, save, policy, rng);
  allocatePassives(reg, save, policy, rng);
}
