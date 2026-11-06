/** Общие подписи видов героя: имя и цвет канала урона, стихия узла древа. */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import { abilityElementOf } from '../session/session.js';
import { cfgRowText } from '../i18n/tr.js';

type SkillNode = ConfigShapes['skill-tree']['nodes'][number];
type ActiveAbility = NonNullable<SkillNode['effect']['active']>;

/** Имя и цвет канала урона (веб `core/damageTypes.ts`): `damage-kinds` physical, поверх — `magic-subtypes` (последняя строка id). */
function dmgMeta(cfg: ConfigRegistry, id: string): { name: string; color: string; table: 'damage-kinds' | 'magic-subtypes' } | undefined {
  let m: { name: string; color: string; table: 'damage-kinds' | 'magic-subtypes' } | undefined;
  if (id === 'physical') { const k = cfg.get('damage-kinds').find((x) => x.id === 'physical'); if (k) m = { name: k.name, color: k.color, table: 'damage-kinds' }; }
  for (const s of cfg.get('magic-subtypes')) if (s.id === id) m = { name: s.name, color: s.color, table: 'magic-subtypes' };
  return m;
}
/** ⭐ i18n Ф1 (06.11): имя канала — на языке игрока (строка той таблицы, из которой взято, `cfgRowText`). */
export function dmgName(cfg: ConfigRegistry, id: string): string {
  const m = dmgMeta(cfg, id);
  if (!m) return id;
  const rows: readonly { id: string }[] = cfg.get(m.table);
  const row = m.table === 'damage-kinds' ? rows.find((x) => x.id === 'physical') : [...rows].reverse().find((x) => x.id === id);
  return cfgRowText(cfg, m.table, row) ?? m.name;
}
export function dmgColor(cfg: ConfigRegistry, id: string): string { return dmgMeta(cfg, id)?.color ?? '#c9c9d4'; }

/** Стихия узла (веб `skills/skillIcon.ts` elementOf): явная `element` наступательной активки, иначе — по `abilityId`; без активки — «mastery». */
export function elementOf(node: SkillNode): string {
  const a = node.effect.active as (ActiveAbility & { element?: string }) | undefined;
  if (!a) return 'mastery';
  if ((a.category === 'attack' || a.category === 'cast' || a.category === 'curse') && a.element) return a.element;
  return abilityElementOf(a.abilityId);
}
