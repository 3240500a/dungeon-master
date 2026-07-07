import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { StatModifier } from '../types/index.js';

/**
 * Чистые хелперы по активным тоглам (аурам/стойкам): резерв маны, эффективный
 * максимум, стат-моды и инфо для UI. ЕДИНЫЙ источник для сервера (session.tick) и
 * клиента (лист персонажа + HUD) — чтобы резерв/бонусы считались одинаково везде.
 */

/** Активная способность узла активного дерева (тип из распарсенного конфига). */
type ActiveAbility = NonNullable<
  ConfigShapes['skills-active'][number]['nodes'][number]['effect']['active']
>;

/** Инфо об активном тогле (для HUD-индикатора и листа персонажа). */
export interface ActiveToggleInfo {
  id: string;
  name: string;
  description: string;
  reservePct: number;
  buffMods: StatModifier[];
}

/** Активная способность узла активного дерева класса по id узла. */
export function activeAbilityOf(cfg: ConfigRegistry, classId: string, nodeId: string): ActiveAbility | undefined {
  const tree = cfg.get('skills-active').find((t) => t.classId === classId);
  return tree?.nodes.find((n) => n.id === nodeId)?.effect.active ?? undefined;
}

/** Доля зарезервированной маны от активных тоглов/аур (кап 0.9 — всю ману занять нельзя). */
export function reservedManaFrac(cfg: ConfigRegistry, classId: string, toggles: readonly string[]): number {
  let f = 0;
  for (const id of toggles) f += activeAbilityOf(cfg, classId, id)?.reservePct ?? 0;
  return Math.min(0.9, f);
}

/** Эффективный максимум маны с учётом резерва — мана восстанавливается ТОЛЬКО до него. */
export function effectiveMaxMana(maxMana: number, reserveFrac: number): number {
  return maxMana * (1 - reserveFrac);
}

/** Стат-моды активных тоглов (ауры/стойки) — единый источник для боя и отображения. */
export function toggleBuffMods(cfg: ConfigRegistry, classId: string, toggles: readonly string[]): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const id of toggles) {
    const a = activeAbilityOf(cfg, classId, id);
    if (a?.buffMods) mods.push(...a.buffMods);
  }
  return mods;
}

/** Инфо об активных тоглах (имя/описание/резерв/бонусы) — для HUD и листа персонажа. */
export function activeToggleInfos(cfg: ConfigRegistry, classId: string, toggles: readonly string[]): ActiveToggleInfo[] {
  const tree = cfg.get('skills-active').find((t) => t.classId === classId);
  const out: ActiveToggleInfo[] = [];
  for (const id of toggles) {
    const node = tree?.nodes.find((n) => n.id === id);
    const a = node?.effect.active;
    if (node && a) {
      out.push({ id, name: node.name, description: node.description, reservePct: a.reservePct ?? 0, buffMods: a.buffMods ?? [] });
    }
  }
  return out;
}
