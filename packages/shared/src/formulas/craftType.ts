import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import { ruAgree } from './ruAgree.js';
import { cfgRowKey, cfgRowText, cfgRowTextWith, textLocalizer, tr } from '../i18n/tr.js';
import { SOURCE_LANG } from '../i18n/keys.js';
import { normalizeAgreement } from '../i18n/forms.js';
import type { Localizer } from '../i18n/index.js';

/**
 * КЛАССИФИКАТОР ТИПОВ ОРУЖИЯ (docs/CRAFT_WEAPONS.md §3.3) — «что за меч получился».
 *
 * Два слоя, и они не смешиваются:
 * 1. МЕХАНИКА. Ключевой тег ключевой детали по таблице `weapon-types.bases` выбирает существующую
 *    базу целиком: урон, скорость, вес, требования, грань. Выбор лёгкого клинка — это ровно прежний
 *    выбор лёгкого чертежа, только сделанный одним кликом вместе с точкой оси.
 * 2. ИМЯ. Упорядоченные правила по тегам всех четырёх гнёзд: первое совпадение даёт историческое
 *    имя («Ранний меч», «Клеймор»), иначе имя собирается шаблоном. Ни одного числа имя не несёт.
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
export function slotName(anat: WeaponAnatomy, slot: CraftSlot, hands: number, reg?: ConfigRegistry): string {
  const s = anat[slot];
  const field = hands === 2 && s.name2h ? 'name2h' : 'name';
  // ⭐ i18n Ф1 (06.11): с реестром — на языке игрока (`cfgRowText` по самой строке анатомии); без — исходник, как было
  return reg ? cfgRowText(reg, 'weapon-anatomy', s, field) : s[field] ?? s.name;
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

/**
 * ⚠ АРИФМЕТИКА РУССКИХ ОКОНЧАНИЙ ЖИВЁТ В ОДНОМ МЕСТЕ — `formulas/ruAgree.ts`, и она ЗАПАС, а не
 * правило: правило теперь данные (`i18n/forms.ts`, фрагмент несёт свои формы). Копий было четыре,
 * в паритете их держали только золотые эталоны, и две из них расходились («падающое» против
 * «падающее»). Здесь остался переходник — на имя `agree` ссылаются тесты ковки и `craftedName`.
 */
export const agree = ruAgree;

/**
 * ⚠ ЗАГЛАВНАЯ — ТОЛЬКО У БУКВЫ В НАЧАЛЕ (Ф3, 07.11, поймал английский перевод). Прежде искалась ПЕРВАЯ латинская/кириллическая буква
 * где угодно: «16th c.» → «16Th c.», «諸葛弩: короб…» → «諸葛弩: Короб…», а «à moulinet» → «à Moulinet» (à в диапазон не входила).
 * Теперь пропускаются только пробелы, кавычки и скобки («kidney dagger» → «Kidney dagger», как было); первая значимая — не буква
 * (цифра, тире, значок) — регистр не трогаем. Буква — любая `\p{L}`: à поднимается в À, у иероглифа регистра нет — остаётся.
 */
const LEAD_SKIP = /^[\s"'«»„“”‘’‹›()[\]{}<>]*/u;
const upFirst = (s: string): string => {
  const i = LEAD_SKIP.exec(s)![0].length;
  const cp = s.codePointAt(i);
  if (cp === undefined) return s;
  const ch = String.fromCodePoint(cp);
  return /\p{L}/u.test(ch) ? s.slice(0, i) + ch.toUpperCase() + s.slice(i + ch.length) : s;
};
const lowFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const tidy = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
/** Кириллица в строке — `code` значения не язык-нейтральный (см. `typeFormula`). */
const CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * ⭐ i18n Ф2 (06.11): ЯЗЫК ТЕКСТА ТИПА — разрешитель и реестр (ключ фрагмента берётся по самой строке таблицы, `cfgRowKey`). Нет —
 * исходник как есть: имя типа ПЕЧЁТСЯ в имя скованной вещи (`craftedName`) и потому собирается языком-источником; показ на языке игрока
 * собирает тот же шаблон с переведёнными фрагментами (`typeDisplay`, `itemDisplayName`).
 */
export interface TypeLang { loc: Localizer; reg: ConfigRegistry }

/**
 * Подставляет значения тегов в шаблон: `{noun}`, `{base}`, `{гнездо.тег}` (= имя значения),
 * `{гнездо.тег.поле}` (name / code / adj / with / epoch). Прилагательное (`adj`) согласуется по
 * роду имени; эпоха (`epoch`) — оборот в родительном («ранней эпохи») и не склоняется.
 * ⭐ i18n Ф2: `L` — язык фрагментов (шаблон и `extra` зовущий переводит сам); прилагательное — формой перевода под род, запас арифметикой
 * — только на языке-источнике (как у `composeItemName`).
 * ⚠ Ф3 (07.11): строчная у `{base}` — ПРАВИЛО РУССКОГО (база внутри фразы: «Ранний меч», «Узкий ручной топор»), а не сборки: английская
 * база держит свой регистр («Bearded War Axe», не «Bearded war Axe»), иначе переводчику приходилось ставить `{base}` в начало шаблона.
 * Правило — у ТЕКСТА базы (`extra.baseLow`, решает `typeTexts`): база без перевода — русский запас и строчная на любом языке (es/zh без
 * строк — «Узкий ручной топор», а не «Узкий Ручной топор»).
 */
function fill(tpl: string, anat: WeaponAnatomy, parts: PartSet, gender: Gender, extra: { noun?: string; base?: string; baseLow: boolean }, L?: TypeLang): string {
  const src = !L || L.loc.lang === SOURCE_LANG;
  const out = tpl.replace(/\{([^}]+)\}/g, (_, ref: string) => {
    if (ref === 'noun') return extra.noun ?? '';
    if (ref === 'base') return extra.baseLow ? lowFirst(extra.base ?? '') : extra.base ?? '';
    const [slot, key, field = 'name'] = ref.split('.') as [CraftSlot, string, string];
    const p = parts[slot];
    if (!p || !anat[slot]) return '';
    const id = tagValue(anat, slot, p, key);
    const v = tagEntry(anat, slot, key, id);
    if (!v) return '';
    const raw = String((v as Record<string, unknown>)[field] ?? '');
    if (src) return field === 'adj' ? agree(raw, gender) : raw || (field === 'name' ? v.id : '');
    const k = raw ? cfgRowKey(L.reg, 'weapon-anatomy', v, field) : undefined;
    if (field === 'adj') return k && L.loc.forms(k) !== undefined ? L.loc.form(k, normalizeAgreement(gender), raw) : (k ? L.loc.text(k, raw) : raw);
    return (k ? L.loc.text(k, raw) : raw) || (field === 'name' ? v.id : '');
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

/**
 * Строка-формула по ссылкам классификатора. ⭐ i18n Ф2: `L` — язык подписей (заголовок свода, подпись тега, имя значения; код — как есть).
 * ⚠ Ф3 (07.11): `code` — внутреннее поле (`I18N_INTERNAL_FIELDS`), то есть каталожная метка вне языка («XI», «G», «3»). Кириллический код
 * (13 значений: «Падающий», «фальшион» у мечей — копия имени; «Ирзи», «Кум-Дарья» у накладок лука) на ином языке — уже не метка, а русское
 * слово: там встаёт переведённое имя значения. Русская формула прежняя; переводить `code` целиком — 49 кодов в корпус ради 13.
 * Замена — только когда у имени значения ЕСТЬ перевод: язык без строк (es/zh сегодня) читает формулу русским запасом, и код в ней —
 * прежний («накладки Ирзи», а не «накладки 4 концевые»).
 */
export function typeFormula(anat: WeaponAnatomy, row: WeaponTypes, parts: PartSet, L?: TypeLang): string {
  const txt = (table: 'weapon-anatomy' | 'weapon-types', r: object, field: string, raw: string): string =>
    (L && raw ? cfgRowTextWith(L.loc, L.reg, table, r, field) : raw);
  const src = !L || L.loc.lang === SOURCE_LANG;
  const bits = row.formula.refs.map((ref) => {
    const [slot, key] = ref.split('.') as [CraftSlot, string];
    const def = anat[slot]?.tags.find((t) => t.key === key);
    const p = parts[slot];
    if (!def || !p) return '';
    const v = def.values.find((x) => x.id === tagValue(anat, slot, p, key));
    const label = def.label ? txt('weapon-anatomy', def, 'label', def.label) : txt('weapon-anatomy', def, 'name', def.name).toLowerCase();
    const nameKey = L && !src && v?.name ? cfgRowKey(L.reg, 'weapon-anatomy', v, 'name') : undefined;
    const code = v?.code && (src || !CYRILLIC.test(v.code) || !nameKey || !L?.loc.has(nameKey)) ? v.code : '';
    return v ? `${label} ${code || (v.name ? txt('weapon-anatomy', v, 'name', v.name) : '') || v.id}` : '';
  }).filter(Boolean);
  return (row.formula.title ? `${txt('weapon-types', row.formula, 'title', row.formula.title)}: ` : '') + bits.join(' · ');
}

/**
 * ⭐ ЧТО ПОЛУЧИЛОСЬ: база (механика) и историческое имя по четырём деталям семейства.
 * База — из ключевой детали; имя — первое сработавшее правило или шаблон-фолбэк.
 */
export function resolveType(reg: ConfigRegistry, weaponClass: string, hands: number, parts: PartSet): TypeInfo {
  const anat = anatomyRow(reg, weaponClass);
  const row = typesRow(reg, weaponClass);
  if (!anat || !row) return { ...EMPTY, reason: tr('srv:forge.noClassifier', 'Классификатора для этого класса нет') };
  const keyPart = parts[anat.keySlot as CraftSlot];
  const baseId = keyPart ? baseOfKeyPart(reg, weaponClass, hands, keyPart) : undefined;
  const base = reg.get('items.base').find((b) => b.id === baseId && b.enabled !== false);
  if (!base || base.kind !== 'weapon' || base.weaponClass !== weaponClass || (base.hands ?? 1) !== hands) {
    return { ...EMPTY, reason: tr('srv:forge.partNoType', '«{name}» не задаёт тип в этом семействе', { name: cfgRowText(reg, 'weapon-parts', keyPart) ?? '?' }) };
  }
  const formula = typeFormula(anat, row, parts);
  const t = typeTexts(anat, row, base, hands, parts);
  // ⚠ порядок полей — прежний (тип уезжает в модели окон, эталон Unity сверяет JSON побайтово)
  if (!t.fallback) {
    return {
      ok: true, baseId: base.id, typeId: t.typeId, gender: t.gender, fallback: false, formula,
      name: t.name, subtitle: t.subtitle, source: t.source, fantasy: t.fantasy,
    };
  }
  return { ok: true, baseId: base.id, gender: t.gender, fallback: true, formula, source: '', fantasy: false, name: t.name, subtitle: t.subtitle };
}

/**
 * ИМЯ И ПОДЗАГОЛОВОК ТИПА по деталям — одно правило на печать (`L` нет — язык-источник, `resolveType`) и на показ (`typeDisplay`): первое
 * сработавшее правило `names` или шаблон-фолбэк. ⭐ i18n Ф2 (06.11): с `L` шаблон, существительное и имя базы — переводом своих строк.
 */
function typeTexts(
  anat: WeaponAnatomy, row: WeaponTypes, base: { name: string; gender?: string | null }, hands: number, parts: PartSet, L?: TypeLang,
): Pick<TypeInfo, 'typeId' | 'gender' | 'fallback' | 'name' | 'subtitle' | 'source' | 'fantasy'> {
  const txt = (r: object, field: string, raw: string): string => (L && raw ? cfgRowTextWith(L.loc, L.reg, 'weapon-types', r, field) : raw);
  const baseName = L ? cfgRowTextWith(L.loc, L.reg, 'items.base', base) : base.name;
  // ⚠ Ф3 (07.11, ревью): строчная — у русского ТЕКСТА базы: язык-источник или база без перевода на языке игрока (запас — русское имя)
  const baseKey = L && L.loc.lang !== SOURCE_LANG ? cfgRowKey(L.reg, 'items.base', base) : undefined;
  const baseLow = !baseKey || !L?.loc.has(baseKey);
  const rule = row.names.find((r) => r.enabled !== false && matchWhen(anat, r.when, hands, parts));
  if (rule) {
    const g = rule.gender as Gender;
    return {
      typeId: rule.id, gender: g, fallback: false,
      name: fill(txt(rule, 'name', rule.name), anat, parts, g, { base: baseName, baseLow }, L),
      subtitle: rule.subtitle ? fill(txt(rule, 'subtitle', rule.subtitle), anat, parts, g, { base: baseName, baseLow }, L) : '',
      source: rule.source, fantasy: rule.fantasy,
    };
  }
  const noun = row.fallback.noun.find((n) => matchWhen(anat, n.when, hands, parts));
  const g = (noun?.gender ?? base.gender ?? 'm') as Gender;
  const extra = { noun: noun?.text !== undefined ? txt(noun, 'text', noun.text) : undefined, base: baseName, baseLow };
  return {
    gender: g, fallback: true, source: '', fantasy: false,
    name: fill(txt(row.fallback, 'template', row.fallback.template), anat, parts, g, extra, L) || baseName,
    subtitle: row.fallback.subtitle ? fill(txt(row.fallback, 'subtitle', row.fallback.subtitle), anat, parts, g, extra, L) : '',
  };
}

/**
 * ⭐ i18n Ф2 (06.11): ТИП ДЛЯ ПОКАЗА — имя, подзаголовок и строка-формула на языке ОБЛАСТИ (`textLocalizer`; нет области — ровно поля
 * `type`). `type` — итог `resolveType` по тем же деталям: от него берутся проверка (тип собрался) и база.
 */
export function typeDisplay(
  reg: ConfigRegistry, weaponClass: string, hands: number, parts: PartSet, type: TypeInfo, loc: Localizer | null = textLocalizer(),
): Pick<TypeInfo, 'name' | 'subtitle' | 'formula' | 'gender'> {
  const same = { name: type.name, subtitle: type.subtitle, formula: type.formula, gender: type.gender };
  if (!type.ok || !loc || loc.lang === SOURCE_LANG) return same;
  const anat = anatomyRow(reg, weaponClass);
  const row = typesRow(reg, weaponClass);
  const base = reg.get('items.base').find((b) => b.id === type.baseId);
  if (!anat || !row || !base) return same;
  const L: TypeLang = { loc, reg };
  const t = typeTexts(anat, row, base, hands, parts, L);
  return { name: t.name, subtitle: t.subtitle, formula: typeFormula(anat, row, parts, L), gender: t.gender };
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
  if (!anat) return { available: false, missing: [tr('srv:forge.noAnatomy', 'нет анатомии класса')] };
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
          return vals.map((v) => (key === 'id' ? cfgRowText(reg, 'weapon-parts', pool.find((p) => p.id === v)) : cfgRowText(reg, 'weapon-anatomy', tagEntry(anat, slot, key, v))) || v).join(' / ');
        }).join(', ');
        missing.push(`${slotName(anat, slot, h, reg)}: ${want || tr('srv:forge.noOpenPart', 'нет открытой детали')}`);
      }
    }
    if (!missing.length) return { available: true, missing: [] };
    if (!best || missing.length < best.length) best = missing;
  }
  return { available: false, missing: best ?? [tr('srv:forge.noFamily', 'нет семейства')] };
}
