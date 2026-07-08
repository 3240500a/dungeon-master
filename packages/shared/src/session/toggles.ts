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

/** Доля резерва маны узла (только у аур/стоек). */
function reserveOf(a: ActiveAbility | undefined): number {
  return a && (a.category === 'aura' || a.category === 'stance') ? (a.reservePct ?? 0) : 0;
}
/** Стат-моды тогла (ауры/стойки). */
function buffModsOf(a: ActiveAbility | undefined): StatModifier[] {
  return a && (a.category === 'aura' || a.category === 'stance') ? (a.buffMods ?? []) : [];
}

/** Доля зарезервированной маны от активных тоглов/аур (кап 0.9 — всю ману занять нельзя). */
export function reservedManaFrac(cfg: ConfigRegistry, classId: string, toggles: readonly string[]): number {
  let f = 0;
  for (const id of toggles) f += reserveOf(activeAbilityOf(cfg, classId, id));
  return Math.min(0.9, f);
}

/** Эффективный максимум маны с учётом резерва — мана восстанавливается ТОЛЬКО до него. */
export function effectiveMaxMana(maxMana: number, reserveFrac: number): number {
  return maxMana * (1 - reserveFrac);
}

/** Стат-моды активных тоглов (ауры/стойки) — единый источник для боя и отображения. */
export function toggleBuffMods(cfg: ConfigRegistry, classId: string, toggles: readonly string[]): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const id of toggles) mods.push(...buffModsOf(activeAbilityOf(cfg, classId, id)));
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
      out.push({ id, name: node.name, description: node.description, reservePct: reserveOf(a), buffMods: buffModsOf(a) });
    }
  }
  return out;
}
