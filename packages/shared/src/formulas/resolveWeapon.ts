import type { DebuffApply } from '../world/debuffs.js';
import type { Item, WeaponWeight } from '../types/items.js';
import type { ConfigShapes } from '../config/schemas.js';

type PhysSubtypes = ConfigShapes['phys-subtypes'];
type WeaponWeights = ConfigShapes['weapon-weights'];

/**
 * Вывод боевых свойств оружия из осей (вес/подтип урона). Таблицы весов
 * (`weapon-weights`: power/finesse/доли Сила-Ловк) и подтипов (`phys-subtypes`)
 * — data-driven, правятся в редакторе. Чистые функции — общие для игры/сима/сервера.
 */

function weightOf(weights: WeaponWeights, id: WeaponWeight | undefined): WeaponWeights[number] | undefined {
  return id ? weights.find((w) => w.id === id) : undefined;
}

/** Доли скейла урона по весу: сколько от Силы / Ловкости / Интеллекта (magical-вес = Инт). */
export function weightScaleSplit(weight: WeaponWeight, weights: WeaponWeights): { strength: number; dexterity: number; intelligence: number } {
  const w = weightOf(weights, weight);
  return w ? { strength: w.strength, dexterity: w.dexterity, intelligence: w.intelligence } : { strength: 1, dexterity: 0, intelligence: 0 };
}

/** Множитель силовых сигнатур (2H — ещё ×balance.twoHandedPowerMult). */
export function weaponPowerFactor(item: Pick<Item, 'weight' | 'hands'>, weights: WeaponWeights, twoHandMult: number): number {
  const w = weightOf(weights, item.weight);
  if (!w) return 1;
  return w.power * (item.hands === 2 ? twoHandMult : 1);
}

/** Множитель finesse-сигнатур по весу (обратный power). */
export function weaponFinesseFactor(item: Pick<Item, 'weight'>, weights: WeaponWeights): number {
  return weightOf(weights, item.weight)?.finesse ?? 1;
}

/**
 * Стаковые дебаффы удара оружием (по подтипу физ. урона + весу). Таблица подтипов
 * (какой статус + числа + как масштабируются весом) — data-driven (`phys-subtypes`).
 * Шанс/сила множатся на Power (тяжелее→сильнее) или Finesse (легче→чаще) по конфигу.
 */
export function weaponDebuffs(item: Item, physSubs: PhysSubtypes, weights: WeaponWeights, twoHandMult: number): DebuffApply[] {
  if (!item.physSub || !item.weight) return [];
  const sub = physSubs.find((s) => s.id === item.physSub);
  if (!sub) return [];
  const p = weaponPowerFactor(item, weights, twoHandMult);
  const f = weaponFinesseFactor(item, weights);
  const sc = (mode: string): number => (mode === 'power' ? p : mode === 'finesse' ? f : 1);
  const w = sub.weapon;
  const out: DebuffApply = {
    kind: sub.kind,
    chance: Math.min(1, w.chance * sc(w.chanceScale)),
    maxStacks: w.maxStacks,
    durationMs: w.durationMs,
    mag: w.mag * sc(w.magScale),
  };
  if (w.mag2 != null) out.mag2 = w.mag2 * sc(w.mag2Scale);
  return [out];
}
