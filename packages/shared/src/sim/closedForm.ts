import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { ScaledMonster } from '../types/world.js';
import type { DamageType } from '../types/combat.js';
import { hitChance, armorMitigation } from '../formulas/combat.js';
import { estimateAttack } from '../formulas/playerCombat.js';
import { makePlayerModel, estimateLearnedSkills } from './playerBot.js';

/**
 * Закрытая (аналитическая) оценка TTK игрок→монстр — БЫСТРОЕ ПРЕВЬЮ и база кросс-чека.
 * Считает ожидаемые средние по тем же под-формулам, что и движок `resolveAttack` (hitChance/armor/
 * resist/crit/block), но без стохастики/DoT/ИИ/геометрии. Настоящий TTK меряет `simulateMicroFight`
 * (реальный бой). Кросс-чек (`sim/crosscheck.test.ts`) держит формулу и движок в согласии — расхождение = баг.
 */
export interface ClosedFormTtk {
  /** Ожидаемое число ЗАМАХОВ до смерти (вкл. промахи/блок) — как в TTK-калькуляторе. */
  swingsToKill: number;
  /** Ожидаемое число ПОПАВШИХ ударов до смерти — сравнимо с `hitsToKill` движка. */
  landedHitsToKill: number;
  ttkSec: number;
  dpsOut: number;
  /** Средний урон за ПОПАВШИЙ удар (крит усреднён, минус митигация). */
  perHit: number;
}

/** Закрытая оценка TTK для (сейв, монстр); `skillNodeId` — считать по скиллу, иначе базовая атака. */
export function closedFormTtk(reg: ConfigRegistry, save: SaveState, mon: ScaledMonster, skillNodeId?: string): ClosedFormTtk {
  const m = makePlayerModel(reg, save, { useSkills: true });
  const c = m.combat;
  const learned = estimateLearnedSkills(reg, save, m.derived, m.attrs);
  const sk = skillNodeId ? learned.find((l) => l.nodeId === skillNodeId) ?? null : null;

  const atkType: DamageType = sk ? sk.sim.element : (m.weapons[0]?.damageType ?? 'physical');
  const resOf: Record<DamageType, number> = { physical: 0, fire: mon.resFire, cold: mon.resCold, lightning: mon.resLightning, poison: mon.resPoison };
  // Митигация как в resolveAttack: физ — броня по уровню атакующего; стихии — сопр. с капом ±75%.
  const mit = atkType === 'physical' ? armorMitigation(mon.armor, save.level) : Math.min(0.75, Math.max(-0.75, resOf[atkType]));
  const hit = sk ? sk.sim.magnitude : estimateAttack(m.derived, m.attrs, m.weapons[0], m.scaling, m.weights);
  const interval = sk && sk.sim.cooldown > 0 ? Math.max(sk.sim.cooldown, m.attackInterval) : m.attackInterval;

  const critF = 1 + Math.min(1, c.critChance) * (c.critMultiplier - 1);
  const perHit = Math.max(0.5, hit * critF * (1 - mit));                       // урон за ПОПАВШИЙ удар
  const pHit = hitChance(c.accuracy, mon.evade);
  const perSwing = perHit * pHit * (1 - Math.min(0.75, mon.blockChance));      // урон за ЗАМАХ (вкл. промах/блок)
  const dps = perSwing / Math.max(0.01, interval);
  return {
    swingsToKill: Math.ceil(mon.hp / Math.max(0.01, perSwing)),
    landedHitsToKill: mon.hp / perHit,
    ttkSec: mon.hp / Math.max(0.01, dps),
    dpsOut: dps,
    perHit,
  };
}
