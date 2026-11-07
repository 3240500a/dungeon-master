/**
 * ⭐⭐ i18n Ф2 (06.11): ИМЯ ВЕЩИ ДЛЯ ПОКАЗА — на языке игрока.
 *
 * Имя вещи ПЕЧЁТСЯ при рождении языком-источником и уезжает в сейв (`Item.name`): испеки его на английском — и оно уехало бы в сейв
 * русского. Поэтому печать не трогаем, а ПОКАЗ пересобирает имя из данных самой вещи (база, ступень, аффиксы, уник, бросок рарного имени
 * `nameRoll`, тип и детали скованной, вид и ступень печати, сырьё) тем же швом `composeItemName` — с переведёнными фрагментами.
 *
 * ⚠⚠ ОРАКУЛ НА КАЖДОМ ПОКАЗЕ. Рецепт сперва собирается ЯЗЫКОМ-ИСТОЧНИКОМ и сверяется с испечённым именем; язык игрока — только если
 * сошлось слово в слово. Не сошлось (база переименована после рождения вещи, вещь из сейва старше `nameRoll`, ступень сменили, а имя
 * осталось старым) — показ отдаёт испечённое имя как есть: честный запас, а не чужое имя. Так сборка показа не может назвать вещь иначе,
 * чем её назвал сервер при рождении, — только перевести то же самое имя.
 *
 * Язык — ОБЛАСТЬ текста (`textLocalizer`, как у `tr`); язык-источник — `item.name` без единой операции (горячий путь русского игрока).
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigKey, ConfigShapes } from '../config/schemas.js';
import type { Item, RolledAffix } from '../types/items.js';
import { Localizer, SOURCE_LANG, cfgRowKey, cfgRowTextWith, textLocalizer, trWith } from '../i18n/index.js';
import { composeItemName, type NameFragment } from './itemName.js';
import { craftedName, partsOf, resolveParts } from './craft.js';
import { resolveType, typeDisplay, type TypeInfo } from './craftType.js';

/** Разрешитель языка-источника без таблицы — ровно тот, которым имя печётся при рождении (`itemgen.srcLoc`). */
const SRC = new Localizer(undefined, SOURCE_LANG);

/** Строка таблицы по `id` — индекс на массив таблицы (новый на каждую перезагрузку конфига, значит индекс не устаревает). */
const byIdCache = new WeakMap<readonly unknown[], Map<string, unknown>>();
function rowById<T extends { id: string }>(rows: readonly T[], id: string | undefined): T | undefined {
  if (id === undefined) return undefined;
  let m = byIdCache.get(rows);
  if (!m) { m = new Map(rows.map((r) => [r.id, r])); byIdCache.set(rows, m); }
  return m.get(id) as T | undefined;
}

/** Фрагмент имени по САМОЙ строке таблицы: ключ — тот, что у извлекателя (`rowPathOf`), исходник — поле строки. */
function rowFrag(reg: ConfigRegistry, table: ConfigKey, row: object, field = 'name'): NameFragment {
  return { key: cfgRowKey(reg, table, row, field) ?? '', source: String((row as Record<string, unknown>)[field] ?? '') };
}

/** Рецепт имени на одном языке: `L` — разрешитель (источник для сверки или язык игрока). */
type Recipe = (L: Localizer) => string;

type Base = ConfigShapes['items.base'][number];

/** Первый префикс и первый суффикс вещи — те, чьи слова встают в имя магической вещи (`itemgen.magicName`). */
function affixWords(reg: ConfigRegistry, rolled: readonly RolledAffix[]): { pre?: NameFragment; suf?: NameFragment } {
  const affixes = reg.get('affixes');
  const word = (id: string | undefined): NameFragment | undefined => {
    const a = rowById(affixes, id);
    return a?.word ? rowFrag(reg, 'affixes', a, 'word') : undefined;
  };
  return { pre: word(rolled.find((a) => a.kind === 'prefix')?.affixId), suf: word(rolled.find((a) => a.kind === 'suffix')?.affixId) };
}

/**
 * Рецепты имени снаряжения и расходников (всё, что родилось от `items.base`): главный по редкости и запасной «по ступени» (рар без пула
 * основ, магия без слов). Порядок важен: сверка берёт первый, сошедшийся с испечённым именем.
 */
function gearRecipes(reg: ConfigRegistry, item: Item): Recipe[] {
  const base = rowById(reg.get('items.base'), item.baseId) as Base | undefined;
  if (!base) return [];
  const baseFrag = rowFrag(reg, 'items.base', base);
  const tier = rowById(reg.get('item-tiers'), item.tier);
  const tierFrag = tier?.name ? rowFrag(reg, 'item-tiers', tier) : undefined;

  // ── скованная: голова — ТИП по деталям («Ранний меч»), а не база (`enchantItem`, `craftWeapon`) ──
  let type: TypeInfo | undefined;
  let typeName: Recipe | undefined;
  if (item.parts && base.kind === 'weapon') {
    const picks = partsOf(reg, item);
    const res = picks ? resolveParts(reg, base.weaponClass, base.hands ?? 1, picks, { recorded: true }) : undefined;
    if (res?.ok) {
      const t = resolveType(reg, base.weaponClass, base.hands ?? 1, res.parts);
      if (t.ok) {
        type = t;
        typeName = (L) => (L === SRC ? t.name : typeDisplay(reg, base.weaponClass, base.hands ?? 1, res.parts, t, L).name);
      }
    }
    if (!type) return [];   // тип больше не собирается из записанных деталей — имя не пересобрать
  }
  const agreement = type ? type.gender : base.gender ?? undefined;
  const head = (L: Localizer): NameFragment => (typeName ? { key: '', source: typeName(L) } : baseFrag);

  const tierName: Recipe = (L) => {
    if (type && typeName) {
      if (!tier) return typeName(L);
      // печать — ровно `craftedName`; показ — шаблон «ступень + база» языка с переведённым типом во главе
      return L === SRC ? craftedName(tier, type) : composeItemName(L, { shape: 'tiered', base: head(L), agreement, tier: tierFrag });
    }
    return composeItemName(L, { shape: 'tiered', base: baseFrag, agreement: base.gender ?? undefined, tier: tierFrag });
  };

  switch (item.rarity) {
    case 'magic': {
      const { pre, suf } = affixWords(reg, item.affixes);
      const magic: Recipe = (L) => {
        const h = head(L);
        // как у дропа: слов нет — имя ступени (`mn === base.name ? tierName : mn`)
        if (composeItemName(SRC, { shape: 'magic', base: head(SRC), agreement, prefix: pre, suffix: suf }) === head(SRC).source) return tierName(L);
        return composeItemName(L, { shape: 'magic', base: h, agreement, prefix: pre, suffix: suf });
      };
      return [magic, tierName];
    }
    case 'rare': {
      const pool = reg.get('rare-names');
      const noun = item.nameRoll?.noun ? rowById(pool.nouns, item.nameRoll.noun) : undefined;
      const ep = item.nameRoll?.epithet ? rowById(pool.epithets, item.nameRoll.epithet) : undefined;
      if (!noun) return [tierName];   // бросок имени не записан (сейв старше поля) или пула основ нет — имя ступени
      const nounFrag = rowFrag(reg, 'rare-names', noun, 't');
      const epFrag = ep ? rowFrag(reg, 'rare-names', ep, 't') : undefined;
      return [(L) => composeItemName(L, { shape: 'rare', base: head(L), agreement, noun: nounFrag, epithet: epFrag }), tierName];
    }
    case 'unique': {
      const u = rowById(reg.get('uniques'), item.affixes[0]?.affixId);
      if (!u) return [];
      const title = rowFrag(reg, 'uniques', u);
      return [(L) => composeItemName(L, { shape: 'titled', base: baseFrag, agreement: base.gender ?? undefined, title: u.name ? title : undefined })];
    }
    default:
      return [tierName];
  }
}

/**
 * Рецепты печати: «Вид Ступень» (`sealName`) и вид без ступени (печать, собранная без неё).
 * ⭐ 07.11: на языке игрока «вид + ступень» — фразой-шаблоном языка (`srv:seal.nameTier`, как `sealTierPhrase`), а не склейкой пробелом;
 * сверка с испечённым (источник) — РОВНО прежняя склейка `sealName`.
 */
function sealRecipes(reg: ConfigRegistry, item: Item): Recipe[] {
  const def = rowById(reg.get('seals'), item.sealId);
  if (!def) return [];
  const tier = reg.get('balance').seals.tiers.find((t) => t.id === item.sealTier);
  const name: Recipe = (L) => cfgRowTextWith(L, reg, 'seals', def);
  if (!tier) return [name];
  return [(L) => (L === SRC
    ? `${name(L)} ${cfgRowTextWith(L, reg, 'balance', tier)}`
    : trWith(L, 'srv:seal.nameTier', '{name} {tier}', { name: name(L), tier: cfgRowTextWith(L, reg, 'balance', tier) })), name];
}

/** Рецепты вещи по её виду. */
function recipesOf(reg: ConfigRegistry, item: Item): Recipe[] {
  if (item.kind === 'material') {
    const def = rowById(reg.get('craft-materials'), item.materialId ?? item.baseId);
    return def ? [(L) => cfgRowTextWith(L, reg, 'craft-materials', def)] : [];
  }
  if (item.kind === 'seal') return sealRecipes(reg, item);
  return gearRecipes(reg, item);
}

/**
 * Память показа: вещь → (испечённое имя, разрешитель, реестр и его поколение, итог). Сверка дорогая, а одна вещь в кадре сумки, подсказки и
 * верстака — одна. ⭐ 07.11: разрешитель меняется только с таблицей `locales`, а рецепт читает и `items.base`, ступени, аффиксы, уники, рарные
 * имена, тип ковки, печати, сырьё — поэтому в подписи и ПОКОЛЕНИЕ реестра (`generation`): правка любой таблицы без `locales` иначе
 * оставила бы иноязычным прежнее имя до смены вещи.
 */
const memo = new WeakMap<object, { sig: string; loc: Localizer; reg: ConfigRegistry; gen: number; out: string }>();
const sigOf = (item: Item): string => `${item.name}|${item.tier ?? ''}|${item.rarity}|${item.affixes.length}|${item.nameRoll?.noun ?? ''}|${item.nameRoll?.epithet ?? ''}`;

/**
 * ⭐ Имя вещи на языке ОБЛАСТИ текста. Источник — `item.name` как есть; иначе рецепт, сошедшийся с испечённым именем, на языке игрока;
 * ни один не сошёлся — испечённое имя (запас). Никогда не бросает: показ имени не вправе уронить кадр.
 */
export function itemDisplayName(reg: ConfigRegistry, item: Item, loc: Localizer | null = textLocalizer()): string {
  if (!loc || loc.lang === SOURCE_LANG) return item.name;
  const sig = sigOf(item);
  const gen = reg.generation();
  const was = memo.get(item);
  if (was && was.loc === loc && was.reg === reg && was.gen === gen && was.sig === sig) return was.out;
  let out = item.name;
  try {
    for (const r of recipesOf(reg, item)) {
      if (r(SRC) !== item.name) continue;
      out = r(loc) || item.name;
      break;
    }
  } catch {
    out = item.name;
  }
  memo.set(item, { sig, loc, reg, gen, out });
  return out;
}

/**
 * Сверка рецепта с испечённым именем (для оракула и отчёта): `'ok'` — рецепт собирает ровно испечённое имя, `'fallback'` — ни один не
 * сошёлся (показ отдаст испечённое как есть).
 */
export function itemNameRecomposes(reg: ConfigRegistry, item: Item): 'ok' | 'fallback' {
  return recipesOf(reg, item).some((r) => r(SRC) === item.name) ? 'ok' : 'fallback';
}

/** Вещь для провода на языке области: имя другое — копия с ним, то же — сама вещь (источник не копирует ничего). */
export function localizeItem<T extends Item>(reg: ConfigRegistry, item: T, loc: Localizer | null = textLocalizer()): T {
  if (!loc || loc.lang === SOURCE_LANG) return item;
  const name = itemDisplayName(reg, item, loc);
  return name === item.name ? item : { ...item, name };
}

/** Похоже ли значение на вещь (`Item`): так узнаются вещи внутри кадров, где их тип не назван (виды, события, дроп мира). */
export function isItemLike(v: unknown): v is Item {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.uid === 'string' && typeof o.baseId === 'string' && typeof o.name === 'string' && typeof o.rarity === 'string' && Array.isArray(o.affixes);
}
