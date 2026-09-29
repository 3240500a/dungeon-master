import {
  emptyPacket,
  packetTotal,
  type CombatStats,
  type DamagePacket,
  type DamageType,
} from '../types/combat.js';
import type { Rng } from './rng.js';

export interface AttackResult {
  hit: boolean;
  blocked: boolean;
  crit: boolean;
  byType: DamagePacket;
  total: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Полу-ширина «коридора» удара по размаху: сектор радиуса `range` и полу-угла `arc` даёт на радиусе
 * поперечную полу-ширину `range·sin(arc)`. Одна формула для сервера (попадание рывка) и клиента
 * (VFX-полоса) — ширина рывка совпадает с размахом обычного удара тем же оружием×скиллом.
 */
export function swingHalfWidth(range: number, arc: number): number {
  return range * Math.sin(clamp(arc, 0, Math.PI / 2));
}

/** Снижение физ. урона бронёй с учётом уровня атакующего. */
export function armorMitigation(armor: number, attackerLevel: number): number {
  return armor / (armor + 30 + 5 * attackerLevel);
}

/** Шанс попасть: меткость против уклонения (0.05..0.95). */
export function hitChance(accuracy: number, evade: number): number {
  return clamp(accuracy / (accuracy + Math.max(1, evade)), 0.05, 0.95);
}

/** Множитель урона способности от ранга (+12% за ранг). */
export function abilityRankMult(rank: number): number {
  return 1 + 0.12 * (Math.max(1, rank) - 1);
}

/** Перезарядка способности от ранга: падает с прокачкой (−3%/ранг, минимум 35% базовой). */
export function abilityCooldown(base: number, rank: number): number {
  return Math.round(base * Math.max(0.35, 1 - 0.03 * (Math.max(1, rank) - 1)) * 100) / 100;
}

/**
 * ⚠ R19-03: НАИМЕНЬШИЙ ОТДЫХ ВРЕМЕННОГО БАФФА — доля его действия. Откат баффа не короче `действие × (1 + BUFF_MIN_REST)`: под баффом —
 * не больше 1 / (1 + 0.25) = 80 % времени при любом ранге и любой вставке.
 */
export const BUFF_MIN_REST = 0.25;

/**
 * ⚠ R19-03: ОТКАТ ВРЕМЕННОГО БАФФА. Ранг режет откат (`abilityCooldown`, до 35 % базы), а действие (`durationSec`) — нет: с ранга, где
 * откат ≤ действия, повтор в кадр истечения держал бафф 100 % времени (клич воина и щит бури — с 13-го, мантия — с 11-го, «Огненные чары»
 * с откатом 12 с на 12 с действия — с первого). Теперь откат не короче действия с отдыхом (`BUFF_MIN_REST`): где он и так длиннее (первые
 * ранги всех баффов с откатом ≥ 1.25 действия), он прежний, дальше ранг перестаёт укорачивать его ниже этой черты.
 */
export function buffCooldown(base: number, durationSec: number, rank: number): number {
  return Math.max(abilityCooldown(base, rank), Math.round(Math.max(0, durationSec) * (1 + BUFF_MIN_REST) * 100) / 100);
}

/**
 * Единый расчёт удара для игрока и монстра. Порядок: попадание → блок (полное
 * гашение, как в D2) → крит → снижение (физ. бронёй, стихии сопротивлениями, кап 75%).
 */
export function resolveAttack(
  attacker: CombatStats,
  defender: CombatStats,
  packet: DamagePacket,
  rng: Rng,
): AttackResult {
  const miss = { hit: false, blocked: false, crit: false, byType: emptyPacket(), total: 0 };

  // 1. Попадание.
  if (!rng.chance(hitChance(attacker.accuracy, defender.evade))) return miss;

  // 2. Блок.
  if (rng.chance(clamp(defender.blockChance, 0, 0.75))) {
    return { hit: true, blocked: true, crit: false, byType: emptyPacket(), total: 0 };
  }

  // 3. Крит.
  const crit = rng.chance(clamp(attacker.critChance, 0, 1));
  const mult = crit ? attacker.critMultiplier : 1;

  // 4. Снижение по типам. Пробой брони атакующего снижает эффективную броню защитника.
  const effArmor = defender.armor * (1 - clamp(attacker.armorPen, 0, 1));
  const physMit = 1 - armorMitigation(effArmor, attacker.level);
  const resOf = (t: DamageType): number => {
    switch (t) {
      case 'fire': return defender.resFire;
      case 'cold': return defender.resCold;
      case 'lightning': return defender.resLightning;
      case 'poison': return defender.resPoison;
      default: return 0;
    }
  };
  const byType = emptyPacket();
  byType.physical = packet.physical * mult * physMit;
  for (const t of ['fire', 'cold', 'lightning', 'poison'] as const) {
    byType[t] = packet[t] * mult * (1 - clamp(resOf(t), -0.75, 0.75));
  }

  const raw = packetTotal(byType);
  const hadDamage = packetTotal(packet) > 0;
  const total = hadDamage ? Math.max(1, Math.round(raw)) : 0;
  return { hit: true, blocked: false, crit, byType, total };
}
