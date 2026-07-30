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

/**
 * Стаковые дебаффы удара оружием (по подтипу физ. урона). База шанса/силы/длительности ВШИТА в подтип
 * (`phys-subtypes`, блок `weapon`), БЕЗ веса-множителей — скейлинг статусов идёт от скиллов (ailment-статы).
 * `magPerDamage` (DoT: кровотечение) — доля от урона удара, добавляется к силе при наложении.
 */
export function weaponDebuffs(item: Item, physSubs: PhysSubtypes): DebuffApply[] {
  if (!item.physSub) return [];
  const sub = physSubs.find((s) => s.id === item.physSub);
  if (!sub) return [];
  const w = sub.weapon;
  const out: DebuffApply = { kind: sub.kind, chance: Math.min(1, w.chance), maxStacks: w.maxStacks, durationMs: w.durationMs, mag: w.mag };
  if (w.mag2 != null) out.mag2 = w.mag2;
  if (w.magPerDamage != null) out.magPerDamage = w.magPerDamage;
  return [out];
}
