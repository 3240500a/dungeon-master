/** Общие подписи видов героя: имя и цвет канала урона, стихия узла древа. */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import { abilityElementOf } from '../session/session.js';

type SkillNode = ConfigShapes['skill-tree']['nodes'][number];
type ActiveAbility = NonNullable<SkillNode['effect']['active']>;

/** Имя и цвет канала урона (веб `core/damageTypes.ts`): `damage-kinds` physical, поверх — `magic-subtypes` (последняя строка id). */
function dmgMeta(cfg: ConfigRegistry, id: string): { name: string; color: string } | undefined {
  let m: { name: string; color: string } | undefined;
  if (id === 'physical') m = cfg.get('damage-kinds').find((k) => k.id === 'physical');
  for (const s of cfg.get('magic-subtypes')) if (s.id === id) m = s;
  return m;
}
export function dmgName(cfg: ConfigRegistry, id: string): string { return dmgMeta(cfg, id)?.name ?? id; }
export function dmgColor(cfg: ConfigRegistry, id: string): string { return dmgMeta(cfg, id)?.color ?? '#c9c9d4'; }

/** Стихия узла (веб `skills/skillIcon.ts` elementOf): явная `element` наступательной активки, иначе — по `abilityId`; без активки — «mastery». */
export function elementOf(node: SkillNode): string {
  const a = node.effect.active as (ActiveAbility & { element?: string }) | undefined;
  if (!a) return 'mastery';
  if ((a.category === 'attack' || a.category === 'cast' || a.category === 'curse') && a.element) return a.element;
  return abilityElementOf(a.abilityId);
}
