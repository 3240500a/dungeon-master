import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { Attributes, DerivedStats } from '../types/attributes.js';
import type { Item } from '../types/items.js';
import { attackByType, estimateAttack } from './playerCombat.js';
import { createRng } from './rng.js';
import { statusKindOf } from './craft.js';

/**
 * КАРТОЧКА ОРУЖИЯ — «всё, что у нас есть» о вещи в руках конкретного героя (docs/CRAFT_WEAPONS.md,
 * окно ковки). Считается ТЕМИ ЖЕ функциями, что и бой (`attackByType`, `estimateAttack`), поэтому
 * карточка и игра не могут разойтись. Входом служит модель игрока (`makePlayerModel`) — сюда её
 * не импортируем, чтобы формулы не зависели от симулятора.
 *
 * ⚠ Это ЗАКРЫТАЯ ФОРМУЛА. Честный ДПС с промахами, статусами, ИИ и геометрией даёт только
 * настоящий бой (`microFightStats`) — окно показывает обе цифры рядом.
 */

type WeaponWeights = ConfigShapes['weapon-weights'];

export interface WeaponCardInput {
  derived: DerivedStats;
  attrs: Attributes;
  weapon?: Item;
  scaling: number;
  weights: WeaponWeights;
  /** Секунд между ударами (из модели игрока: учитывает дуал). */
  attackInterval: number;
}

export interface WeaponStatus {
  kind: string;
  name: string;
  /** Шанс оружия из `debuffs` до бонусов. */
  baseChance: number;
  /** Итоговый шанс за попадание: база × (1 + ailmentPct + шанс-бонус статуса). */
  chance: number;
  /** ⚠ Шанс не клампится в бою: выше 100 % статус вешается каждый удар (долг §20). */
  over100: boolean;
  maxStacks: number;
  durationSec: number;
  /** Среднее число стаков на цели при ударах в темпе героя — по реальной механике общего таймера. */
  avgStacks: number;
}

export interface WeaponCard {
  hitMin: number;
  hitMax: number;
  /** Средний удар без крита — ровно то, что считает `estimateAttack`. */
  hitAvg: number;
  /** Ударов в секунду. */
  aps: number;
  critChance: number;
  critMult: number;
  /** ДПС по формуле: средний удар × темп × крит. Без промахов и статусов. */
  dps: number;
  /** Плоский вклад атрибутов в удар (до множителей). */
  attrBonus: number;
  attackType: 'melee' | 'ranged';
  /** Ближний бой: дальность взмаха, px. */
  rangePx?: number;
  /** Ближний бой: полный угол взмаха, градусы (в коде хранится ПОЛУугол). */
  arcDeg?: number;
  /** Площадь сектора `дуга × дальность²` относительно оружия без множителей. */
  area?: number;
  block: number;
  interruptResist: number;
  status?: WeaponStatus;
  /** Шанс сбить с ног цель массой 100 — по живой формуле нокдауна. */
  knockdown: number;
  /** Масса оружия из лестницы весов. */
  mass: number;
  requirements: Partial<Record<'strength' | 'dexterity' | 'intelligence', number>>;
  reqTotal: number;
}

const DEBUFF_NAME: Record<string, string> = {
  wound: 'рана', bleed: 'кровотечение', sunder: 'увечье', daze: 'ошеломление',
  burn: 'поджиг', poison: 'отравление', shock: 'шок', freeze: 'заморозка',
};

/**
 * Среднее число стаков статуса на цели. ⭐ Модель ОБЩЕГО таймера — как `addDebuffStack` в бою:
 * каждое наложение добавляет стак (до капа) и продлевает ВЕСЬ стак; сбрасывается он целиком,
 * только если пауза между наложениями длиннее длительности. Наивное «шанс × темп × длительность»
 * занижает стаки в 1.5–2 раза именно на этом (§7.1).
 */
export function avgStatusStacks(chance: number, aps: number, durationSec: number, maxStacks: number, seed = 1): number {
  if (chance <= 0 || aps <= 0 || maxStacks <= 0) return 0;
  const p = Math.min(1, chance);
  const dt = 1 / aps;
  const T = 120;
  const runs = 24;
  let acc = 0;
  for (let r = 0; r < runs; r++) {
    const rng = createRng(seed + r * 7919);
    let stacks = 0, expires = -1, sum = 0, n = 0;
    for (let t = 0; t < T; t += dt) {
      if (t > expires) stacks = 0;
      if (rng.chance(p)) { stacks = Math.min(maxStacks, stacks + 1); expires = t + durationSec; }
      if (t >= 10) { sum += stacks; n++; } // первые 10 с — разгон, не считаем
    }
    acc += n ? sum / n : 0;
  }
  return acc / runs;
}

export function weaponCard(reg: ConfigRegistry, input: WeaponCardInput): WeaponCard {
  const { derived: d, attrs, weapon, scaling, weights } = input;
  const byType = attackByType(d, attrs, weapon, scaling, weights);
  let hitMin = 0, hitMax = 0;
  for (const r of Object.values(byType)) { hitMin += r.min; hitMax += r.max; }
  const hitAvg = estimateAttack(d, attrs, weapon, scaling, weights);
  const aps = 1 / Math.max(0.05, input.attackInterval);
  const critFactor = 1 + d.critChance * (d.critMultiplier - 1);
  const w = weights.find((x) => x.id === weapon?.weight);
  const attrBonus = w ? (attrs.strength * w.strength + attrs.dexterity * w.dexterity + attrs.intelligence * w.intelligence) * scaling : 0;
  const at = weapon?.attackType ?? 'melee';

  const card: WeaponCard = {
    hitMin, hitMax, hitAvg, aps,
    critChance: d.critChance, critMult: d.critMultiplier,
    dps: hitAvg * aps * critFactor,
    attrBonus,
    attackType: at,
    block: d.blockChance,
    interruptResist: d.interruptResist,
    knockdown: 0,
    mass: w?.weight ?? 0,
    requirements: { ...(weapon?.requirements ?? {}) },
    reqTotal: Object.values(weapon?.requirements ?? {}).reduce((s, v) => s + (v ?? 0), 0),
  };

  if (at === 'melee') {
    const mel = reg.get('balance').melee;
    const reach = weapon?.reachMult ?? 1;
    const arc = weapon?.arcMult ?? 1;
    card.rangePx = mel.baseRange * reach;
    card.arcDeg = (2 * mel.baseArc * arc * 180) / Math.PI;
    card.area = arc * reach * reach;
  }

  // Статус своей грани/стихии — тем же правилом, что `resolvePlayerHit`.
  const kind = weapon ? statusKindOf(reg, weapon) : undefined;
  const deb = kind ? reg.get('debuffs').find((x) => x.id === kind) : undefined;
  if (kind && deb?.weapon) {
    const dd = d as unknown as Record<string, number>;
    const cMul = 1 + (d.ailmentPct ?? 0) + (dd[`${kind}ChancePct`] ?? 0);
    const chance = deb.weapon.chance * cMul;
    const dur = (deb.weapon.durationMs / 1000) * (1 + (dd[`${kind}DurPct`] ?? 0));
    card.status = {
      kind, name: DEBUFF_NAME[kind] ?? kind,
      baseChance: deb.weapon.chance, chance, over100: chance > 1,
      maxStacks: deb.weapon.maxStacks, durationSec: dur,
      avgStacks: avgStatusStacks(chance, aps, dur, deb.weapon.maxStacks),
    };
  }

  // Нокдаун по живой формуле: min(потолок, база + масса×k) × (1 − min(0.95, масса_цели × сопр)).
  const kd = reg.get('balance').knockdown;
  const raw = Math.min(kd.maxChance, kd.chanceBase + card.mass * kd.weaponWeightMult);
  card.knockdown = raw * (1 - Math.min(0.95, 100 * kd.targetWeightResist));
  return card;
}
