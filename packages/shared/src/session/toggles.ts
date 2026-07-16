import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { StatModifier } from '../types/index.js';

/**
 * Чистые хелперы по активным тоглам (аурам/стойкам): резерв пула, эффективный максимум,
 * стат-моды и инфо для UI. ЕДИНЫЙ источник для сервера (session.tick) и клиента (лист/HUD).
 * Читают единое ДРЕВО СКИЛОВ по id узла (без класса). Ауры резервируют ману, стойки — выносливость
 * (по `resource` способности).
 */

/** Активная способность узла древа скилов (тип из распарсенного конфига). */
type ActiveAbility = NonNullable<ConfigShapes['skill-tree']['nodes'][number]['effect']['active']>;
type ResourcePool = 'mana' | 'stamina';

/** Инфо об активном тогле (для HUD-индикатора и листа персонажа). */
export interface ActiveToggleInfo {
  id: string;
  name: string;
  description: string;
  reservePct: number;
  pool: ResourcePool;
  buffMods: StatModifier[];
}

/** Способность узла древа скилов по id узла. */
export function activeAbilityOf(cfg: ConfigRegistry, nodeId: string): ActiveAbility | undefined {
  return cfg.get('skill-tree').nodes.find((n) => n.id === nodeId)?.effect.active ?? undefined;
}

function isToggle(a: ActiveAbility | undefined): boolean {
  return !!a && (a.category === 'aura' || a.category === 'stance');
}
/** Доля резерва узла (только у аур/стоек). */
function reserveOf(a: ActiveAbility | undefined): number {
  return isToggle(a) ? ((a as { reservePct?: number }).reservePct ?? 0) : 0;
}
/** Пул, который резервирует тогл (мана у аур, выносливость у стоек — по resource). */
function poolOf(a: ActiveAbility | undefined): ResourcePool {
  return a && a.resource === 'stamina' ? 'stamina' : 'mana';
}
/** Стат-моды тогла (ауры/стойки). */
function buffModsOf(a: ActiveAbility | undefined): StatModifier[] {
  return isToggle(a) ? ((a as { buffMods?: StatModifier[] }).buffMods ?? []) : [];
}

/** Доля зарезервированного ПУЛА (mana|stamina) от активных тоглов (кап 0.9 — весь пул занять нельзя). */
export function reservedFrac(cfg: ConfigRegistry, toggles: readonly string[], pool: ResourcePool): number {
  let f = 0;
  for (const id of toggles) {
    const a = activeAbilityOf(cfg, id);
    if (reserveOf(a) > 0 && poolOf(a) === pool) f += reserveOf(a);
  }
  return Math.min(0.9, f);
}

/** Эффективный максимум пула с учётом резерва — пул восстанавливается ТОЛЬКО до него. */
export function effectivePool(max: number, reserveFrac: number): number {
  return max * (1 - reserveFrac);
}

/** Стат-моды активных тоглов (ауры/стойки) — единый источник для боя и отображения. */
export function toggleBuffMods(cfg: ConfigRegistry, toggles: readonly string[]): StatModifier[] {
  const mods: StatModifier[] = [];
  for (const id of toggles) mods.push(...buffModsOf(activeAbilityOf(cfg, id)));
  return mods;
}

/** Инфо об активных тоглах (имя/описание/резерв/пул/бонусы) — для HUD и листа персонажа. */
export function activeToggleInfos(cfg: ConfigRegistry, toggles: readonly string[]): ActiveToggleInfo[] {
  const tree = cfg.get('skill-tree');
  const out: ActiveToggleInfo[] = [];
  for (const id of toggles) {
    const node = tree.nodes.find((n) => n.id === id);
    const a = node?.effect.active;
    if (node && a) {
      out.push({ id, name: node.name, description: node.description, reservePct: reserveOf(a), pool: poolOf(a), buffMods: buffModsOf(a) });
    }
  }
  return out;
}
