import { resolveAttack } from '../formulas/combat.js';
import { emptyPacket } from '../types/combat.js';
import type { CombatStats, DamagePacket } from '../types/combat.js';
import type { Rng } from '../formulas/rng.js';
import { addDebuffStack, debuffMods, type DebuffApply, type DebuffKind, type DebuffState } from './debuffs.js';

/**
 * Чистое разрешение удара игрока по цели (headless боевое ядро). Учитывает
 * дебаффы цели (снижение брони/повышение получаемого урона), сигнатуры оружия
 * (броне-пробитие, добивание, прямой стан) и накладывает дебаффы подтипа урона.
 * Мутирует `target.hp` и `target.debuffs`. Клиент/сервер/сим вызывают одинаково.
 */

export interface HitTarget {
  hp: number;
  maxHp: number;
  stats: CombatStats;
  debuffs: DebuffState;
}

export interface PlayerHitOptions {
  /** Плоское броне-пробитие оружия (0..1), сверх дебафф-снижения. */
  armorPen?: number;
  /** Доп. урон по целям с низким HP (0..1). */
  lowHpBonusPct?: number;
  /** Прямой шанс стана оружия (булава), сверх накопленного ошеломления. */
  stunChance?: number;
  /** Дебаффы подтипа урона (с уже посчитанными шансами/магнитудой). */
  onHit?: DebuffApply[];
}

export interface PlayerHitResult {
  hit: boolean;
  blocked: boolean;
  crit: boolean;
  /** Фактически нанесённый урон (с учётом дебаффов). */
  damage: number;
  /** Разбивка урона по типам (для фидбэка/цвета). */
  byType: DamagePacket;
  died: boolean;
  stunned: boolean;
  appliedDebuffs: DebuffKind[];
}

export function resolvePlayerHit(
  target: HitTarget,
  attacker: CombatStats,
  packet: DamagePacket,
  opts: PlayerHitOptions,
  rng: Rng,
  now: number,
): PlayerHitResult {
  const mods = debuffMods(target.debuffs);
  // Броня цели = дебафф-снижение (ошеломление) × (1 − броне-пробитие оружия).
  const armor = target.stats.armor * mods.armorMult * (1 - (opts.armorPen ?? 0));
  const res = resolveAttack(attacker, { ...target.stats, armor }, packet, rng);
  if (!res.hit || res.blocked) {
    return { hit: res.hit, blocked: res.blocked, crit: false, damage: 0, byType: emptyPacket(), died: false, stunned: false, appliedDebuffs: [] };
  }

  let dmg = res.total * mods.recvDamageMult; // увечье: +получаемый урон
  if (opts.lowHpBonusPct && target.hp / Math.max(1, target.maxHp) < 0.35) dmg *= 1 + opts.lowHpBonusPct;
  dmg = Math.round(dmg);
  target.hp -= dmg;
  const died = target.hp <= 0;

  const applied: DebuffKind[] = [];
  let stunned = false;
  if (!died) {
    // ailmentPct атакующего усиливает наложение: и шанс, и магнитуду статуса.
    const ap = 1 + (attacker.ailmentPct ?? 0);   // глобальный %-статусов (шанс+сила)
    const am = attacker.ailment;                  // per-kind бонусы (шанс/сила/длительность)
    for (const a of opts.onHit ?? []) {
      const cMul = ap + (am?.chance[a.kind] ?? 0);
      if (!rng.chance(a.chance * cMul)) continue;
      const pMul = ap + (am?.power[a.kind] ?? 0);
      const dMul = 1 + (am?.dur[a.kind] ?? 0);
      // DoT: сила = доля от нанесённого урона; шанс/сила/длит. усилены глобальным+per-kind.
      const baseMag = a.mag + (a.magPerDamage ?? 0) * dmg;
      const eff: DebuffApply = { ...a, mag: baseMag * pMul, mag2: a.mag2 === undefined ? undefined : a.mag2 * pMul, durationMs: a.durationMs * dMul };
      addDebuffStack(target.debuffs, eff, now);
      applied.push(a.kind);
    }
    // Стан = прямой (булава) + накопленный от ошеломления (после свежих стаков).
    const stunChance = (opts.stunChance ?? 0) + debuffMods(target.debuffs).dazeStunChance;
    if (stunChance > 0 && rng.chance(stunChance)) stunned = true;
  }
  return { hit: true, blocked: false, crit: res.crit, damage: dmg, byType: res.byType, died, stunned, appliedDebuffs: applied };
}
