/** Стихии + физический. */
export type DamageType = 'physical' | 'fire' | 'cold' | 'lightning' | 'poison';

export const DAMAGE_TYPES: DamageType[] = ['physical', 'fire', 'cold', 'lightning', 'poison'];

/** Урон, разложенный по типам. */
export interface DamagePacket {
  physical: number;
  fire: number;
  cold: number;
  lightning: number;
  poison: number;
}

/** Пустой пакет. */
export function emptyPacket(): DamagePacket {
  return { physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
}

/** Сумма пакета. */
export function packetTotal(p: DamagePacket): number {
  return p.physical + p.fire + p.cold + p.lightning + p.poison;
}

/**
 * Единый боевой стат-блок для игрока И монстра — то, что читает resolveAttack.
 * Сам пакет урона строится отдельно (от оружия/способности).
 */
export interface CombatStats {
  accuracy: number;
  evade: number;
  armor: number;
  blockChance: number;
  critChance: number;
  critMultiplier: number;
  resFire: number;
  resCold: number;
  resLightning: number;
  resPoison: number;
  /** % к наложению статусов/дебафов этим атакующим (шанс/магнитуда × (1+ailmentPct)). */
  ailmentPct: number;
  level: number;
}
