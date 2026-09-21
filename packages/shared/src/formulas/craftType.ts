import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';

/**
 * КЛАССИФИКАТОР ТИПОВ ОРУЖИЯ (docs/CRAFT_WEAPONS.md §3.3) — «что за меч получился».
 *
 * Два слоя, и они не смешиваются:
 * 1. МЕХАНИКА. Ключевой тег ключевой детали по таблице `weapon-types.bases` выбирает существующую
 *    базу целиком: урон, скорость, вес, требования, грань. Выбор лёгкого клинка — это ровно прежний
 *    выбор лёгкого чертежа, только сделанный одним кликом вместе с точкой оси.
 * 2. ИМЯ. Упорядоченные правила по тегам всех четырёх гнёзд: первое совпадение даёт историческое
 *    имя («Каролингский меч»), иначе имя собирается шаблоном. Ни одного числа имя не несёт.
 *
 * Чистый модуль: конфиг + детали → база и имя. Его зовут ядро ковки, окно и редактор.
 */

export type CraftSlot = 'strike' | 'grip' | 'bind' | 'head';
export const CRAFT_SLOT_LIST: readonly CraftSlot[] = ['strike', 'grip', 'bind', 'head'];

export type WeaponPart = ConfigShapes['weapon-parts'][number];
export type WeaponAnatomy = ConfigShapes['weapon-anatomy'][number];
export type WeaponTypes = ConfigShapes['weapon-types'][number];
export type TypeRule = WeaponTypes['names'][number];
type SlotAnatomy = WeaponAnatomy['strike'];
type TagDef = SlotAnatomy['tags'][number];
type TagValue = TagDef['values'][number];
type Gender = 'm' | 'f' | 'n' | 'p';

/** Четыре выбранные детали, уже прочитанные из конфига. */
export type PartSet = Record<CraftSlot, WeaponPart>;

export function anatomyRow(reg: ConfigRegistry, weaponClass: string | undefined): WeaponAnatomy | undefined {
  return reg.get('weapon-anatomy').find((a) => a.id === weaponClass && a.enabled !== false);
}

export function typesRow(reg: ConfigRegistry, weaponClass: string | undefined): WeaponTypes | undefined {
  return reg.get('weapon-types').find((t) => t.id === weaponClass && t.enabled !== false);
}

/** Какие семейства (хват) есть у класса: [1], [2] или [1, 2]. */
export function familiesOf(reg: ConfigRegistry, weaponClass: string): number[] {
  return [...new Set((typesRow(reg, weaponClass)?.bases ?? []).map((b) => b.hands))].sort();
}

/** Ключевое гнездо класса: по нему выбирается база. */
export function keySlotOf(reg: ConfigRegistry, weaponClass: string): CraftSlot {
  return (anatomyRow(reg, weaponClass)?.keySlot ?? 'strike') as CraftSlot;
}

/** Имя гнезда с учётом хвата: у булавы «Рукоять» одноручная и «Древко» двуручное. */
export function slotName(anat: WeaponAnatomy, slot: CraftSlot, hands: number): string {
  const s = anat[slot];
  return hands === 2 && s.name2h ? s.name2h : s.name;
}

export function keyTagOf(anat: WeaponAnatomy): TagDef | undefined {
  return anat[anat.keySlot as CraftSlot].tags.find((t) => t.role === 'key');
}

/** Подходит ли вариант гнезду, классу и хвату. */
export function partFits(p: WeaponPart, weaponClass: string, slot: CraftSlot, hands: number): boolean {
  return p.enabled !== false && p.slot === slot && (p.classes as string[]).includes(weaponClass) && (!p.hands.length || p.hands.includes(hands));
}

/** Значение тега у варианта: своё или умолчание словаря. */
export function tagValue(anat: WeaponAnatomy, slot: CraftSlot, p: WeaponPart, key: string): string {
  return p.tags[key] ?? anat[slot].tags.find((t) => t.key === key)?.default ?? '';
}

function tagEntry(anat: WeaponAnatomy, slot: CraftSlot, key: string, id: string): TagValue | undefined {
  return anat[slot].tags.find((t) => t.key === key)?.values.find((v) => v.id === id);
}

/** База ключевого варианта в семействе (или undefined — вариант не ключевой / не в таблице). */
export function baseOfKeyPart(reg: ConfigRegistry, weaponClass: string, hands: number, p: WeaponPart): string | undefined {
  const anat = anatomyRow(reg, weaponClass);
  const row = typesRow(reg, weaponClass);
  const kt = anat && keyTagOf(anat);
  if (!anat || !row || !kt) return undefined;
  const v = tagValue(anat, anat.keySlot as CraftSlot, p, kt.key);
  return row.bases.find((b) => b.hands === hands && b.key === v)?.base;
}

// ── Условия правил ───────────────────────────────────────────────────────────────────────────────

/** Совпадает ли условие правила со сборкой. Ключи: `hands`, `<гнездо>.<тег>`, `<гнездо>.id`. */
export function matchWhen(anat: WeaponAnatomy, when: Record<string, string[]>, hands: number, parts: PartSet): boolean {
  for (const [k, vals] of Object.entries(when)) {
    if (!vals.length) continue;
    if (k === 'hands') { if (!vals.includes(String(hands))) return false; continue; }
    const [slot, key] = k.split('.') as [CraftSlot, string];
    const p = parts[slot];
    if (!p) return false;
    const got = key === 'id' ? p.id : tagValue(anat, slot, p, key);
    if (!vals.includes(got)) return false;
  }
  return true;
}

// ── Грамматика ───────────────────────────────────────────────────────────────────────────────────

const HARD_STEM = /[кгхжшчщ]$/;

/**
 * Согласует прилагательное в МУЖСКОМ роде с родом имени: «поздний» → «поздняя», «широкий» →
 * «широкое». Слова, которые не прилагательные («с», «долом»), не трогает. Работает по словам.
 */
export function agree(phrase: string, gender: string | undefined): string {
  if (!phrase || !gender || gender === 'm') return phrase;
  return phrase.split(' ').map((w) => {
    const m = /^(.*?)(ый|ий|ой)$/.exec(w);
    if (!m || m[1]!.length < 2) return w;
    const stem = m[1]!, end = m[2]!;
    const soft = end === 'ий' && !HARD_STEM.test(stem); // поздний, ранний, синий
    if (gender === 'f') return stem + (soft ? 'яя' : 'ая');
    if (gender === 'n') return stem + (soft ? 'ее' : end !== 'ой' && /[жшчщ]$/.test(stem) ? 'ее' : 'ое');
    if (gender === 'p') return stem + (soft || HARD_STEM.test(stem) ? 'ие' : 'ые');
    return w;
  }).join(' ');
}

const upFirst = (s: string): string => {
  const i = s.search(/[A-Za-zА-Яа-яЁё]/);
  return i < 0 ? s : s.slice(0, i) + s[i]!.toUpperCase() + s.slice(i + 1);
};
const lowFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const tidy = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();

/**
 * Подставляет значения тегов в шаблон: `{noun}`, `{base}`, `{гнездо.тег}` (= имя значения),
 * `{гнездо.тег.поле}` (name / code / adj / with / epoch). Прилагательное (`adj`) согласуется по
 * роду имени; эпоха (`epoch`) — оборот в родительном («каролингской эпохи») и не склоняется.
 */
function fill(tpl: string, anat: WeaponAnatomy, parts: PartSet, gender: Gender, extra: { noun?: string; base?: string }): string {
  const out = tpl.replace(/\{([^}]+)\}/g, (_, ref: string) => {
    if (ref === 'noun') return extra.noun ?? '';
    if (ref === 'base') return lowFirst(extra.base ?? '');
    const [slot, key, field = 'name'] = ref.split('.') as [CraftSlot, string, string];
    const p = parts[slot];
    if (!p || !anat[slot]) return '';
    const id = tagValue(anat, slot, p, key);
    const v = tagEntry(anat, slot, key, id);
    if (!v) return '';
    const raw = String((v as Record<string, unknown>)[field] ?? '');
    return field === 'adj' ? agree(raw, gender) : raw || (field === 'name' ? v.id : '');
  });
  return upFirst(tidy(out));
}

// ── Тип сборки ───────────────────────────────────────────────────────────────────────────────────

export interface TypeInfo {
  ok: boolean;
  reason?: string;
  /** База — механика: урон, скорость, вес, требования, грань. */
  baseId?: string;
  /** id сработавшего правила имени. Нет — имя собрано шаблоном. */
  typeId?: string;
  name: string;
  gender: Gender;
  subtitle: string;
  source: string;
  fantasy: boolean;
  /** Строка-формула: «Окшотт: клинок XI · перекрестье 1 · навершие G». */
  formula: string;
  fallback: boolean;
}

const EMPTY: TypeInfo = { ok: false, name: '', gender: 'm', subtitle: '', source: '', fantasy: false, formula: '', fallback: true };

/** Строка-формула по ссылкам классификатора. */
export function typeFormula(anat: WeaponAnatomy, row: WeaponTypes, parts: PartSet): string {
  const bits = row.formula.refs.map((ref) => {
    const [slot, key] = ref.split('.') as [CraftSlot, string];
    const def = anat[slot]?.tags.find((t) => t.key === key);
    const p = parts[slot];
    if (!def || !p) return '';
    const v = def.values.find((x) => x.id === tagValue(anat, slot, p, key));
    const label = def.label || def.name.toLowerCase();
    return v ? `${label} ${v.code || v.name || v.id}` : '';
  }).filter(Boolean);
  return (row.formula.title ? `${row.formula.title}: ` : '') + bits.join(' · ');
}

/**
 * ⭐ ЧТО ПОЛУЧИЛОСЬ: база (механика) и историческое имя по четырём деталям семейства.
 * База — из ключевой детали; имя — первое сработавшее правило или шаблон-фолбэк.
 */
export function resolveType(reg: ConfigRegistry, weaponClass: string, hands: number, parts: PartSet): TypeInfo {
  const anat = anatomyRow(reg, weaponClass);
  const row = typesRow(reg, weaponClass);
  if (!anat || !row) return { ...EMPTY, reason: 'Классификатора для этого класса нет' };
  const keyPart = parts[anat.keySlot as CraftSlot];
  const baseId = keyPart ? baseOfKeyPart(reg, weaponClass, hands, keyPart) : undefined;
  const base = reg.get('items.base').find((b) => b.id === baseId && b.enabled !== false);
  if (!base || base.kind !== 'weapon' || base.weaponClass !== weaponClass || (base.hands ?? 1) !== hands) {
    return { ...EMPTY, reason: `«${keyPart?.name ?? '?'}» не задаёт тип в этом семействе` };
  }
  const formula = typeFormula(anat, row, parts);
  const rule = row.names.find((r) => r.enabled !== false && matchWhen(anat, r.when, hands, parts));
  if (rule) {
    const g = rule.gender as Gender;
    return {
      ok: true, baseId: base.id, typeId: rule.id, gender: g, fallback: false, formula,
      name: fill(rule.name, anat, parts, g, { base: base.name }),
      subtitle: rule.subtitle ? fill(rule.subtitle, anat, parts, g, { base: base.name }) : '',
      source: rule.source, fantasy: rule.fantasy,
    };
  }
  const noun = row.fallback.noun.find((n) => matchWhen(anat, n.when, hands, parts));
  const g = (noun?.gender ?? base.gender ?? 'm') as Gender;
  const extra = { noun: noun?.text, base: base.name };
  return {
    ok: true, baseId: base.id, gender: g, fallback: true, formula, source: '', fantasy: false,
    name: fill(row.fallback.template, anat, parts, g, extra) || base.name,
    subtitle: row.fallback.subtitle ? fill(row.fallback.subtitle, anat, parts, g, extra) : '',
  };
}

// ── Кодекс типов: что игрок уже может собрать ────────────────────────────────────────────────────

export interface TypeReach {
  available: boolean;
  /** Чего не хватает, по-человечески: «Гарда: кольца и крюки». */
  missing: string[];
}

/**
 * ДОСТУПЕН ли тип при открытых базах и вариантах (§12, «кодекс типов»): для каждого гнезда с
 * условием нужен открытый вариант, который условию удовлетворяет, а у ключевого — ещё и открытая
 * база. Возвращает, чего не хватает, — для подсказки «Цвайхендер: нет гарды „кольца и крюки“».
 */
export function typeReach(reg: ConfigRegistry, open: { bases: string[]; variants: string[] }, weaponClass: string, rule: TypeRule): TypeReach {
  const anat = anatomyRow(reg, weaponClass);
  if (!anat) return { available: false, missing: ['нет анатомии класса'] };
  const handsList = familiesOf(reg, weaponClass).filter((h) => !rule.when.hands?.length || rule.when.hands.includes(String(h)));
  let best: string[] | null = null;
  for (const h of handsList) {
    const missing: string[] = [];
    for (const slot of CRAFT_SLOT_LIST) {
      const conds = Object.entries(rule.when).filter(([k, v]) => k.startsWith(`${slot}.`) && v.length);
      const isKey = slot === anat.keySlot;
      if (!conds.length && !isKey) continue;
      const pool = reg.get('weapon-parts').filter((p) => partFits(p, weaponClass, slot, h));
      const ok = (p: WeaponPart): boolean => conds.every(([k, vals]) => {
        const key = k.slice(slot.length + 1);
        return vals.includes(key === 'id' ? p.id : tagValue(anat, slot, p, key));
      });
      const hit = pool.some((p) => open.variants.includes(p.id) && ok(p) && (!isKey || open.bases.includes(baseOfKeyPart(reg, weaponClass, h, p) ?? '')));
      if (!hit) {
        const want = conds.map(([k, vals]) => {
          const key = k.slice(slot.length + 1);
          return vals.map((v) => (key === 'id' ? pool.find((p) => p.id === v)?.name : tagEntry(anat, slot, key, v)?.name) || v).join(' / ');
        }).join(', ');
        missing.push(`${slotName(anat, slot, h)}: ${want || 'нет открытой детали'}`);
      }
    }
    if (!missing.length) return { available: true, missing: [] };
    if (!best || missing.length < best.length) best = missing;
  }
  return { available: false, missing: best ?? ['нет семейства'] };
}
