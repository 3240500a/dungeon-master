/**
 * ⭐ Стенд сторожей «имя вещи без повтора корня» — ОДИН обход на любой язык (`itemName.en.test.ts`, `itemName.ru.test.ts`). Язык (разрешитель)
 * и правило корня — параметры: обход у языков общий, а «что считать одним корнем» у каждого своё (английскому хватает общего начала, русскому
 * нужны окончания и суффиксы).
 *
 * Обходит ВСЕ сочетания на живых данных, через настоящие швы:
 *  • рар — каждая база × каждая основа × каждый эпитет (`composeItemName`, полный перебор, достижимо ли сочетание броском — неважно);
 *  • магия — каждое слово аффикса × каждая база, которой он выпадает (`affixPool`), и каждая ступень × каждая база;
 *  • дроп — 300 раров и 300 магических (`generateItem` → `itemDisplayName` на языке стенда);
 *  • формула ковки — каждый «ярлык значение» (все значения тега из `formula.refs`, как их пишет `typeFormula`) и сама `typeFormula` на
 *    КАЖДОЙ детали гнезда из ссылок (остальные гнёзда — первой подходящей деталью).
 * ⚠ Не обходит: имена скованной (и затем зачарованной) вещи — их голова ТИП ковки, а не база; магию с префиксом И суффиксом разом — только
 *   выборкой дропа (что там нашла сверка 07.11 — `i18n/README.md`, «Вне обхода сторожа»).
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { ConfigKey } from '../config/schemas.js';
import type { Item } from '../types/items.js';
import { SOURCE_LANG, cfgRowKey, cfgRowTextWith, type Localizer } from '../i18n/index.js';
import { composeItemName, type NameFragment } from './itemName.js';
import { affixPool, affixTargetOfBase, generateItem } from './itemgen.js';
import { itemDisplayName } from './itemDisplay.js';
import { CRAFT_SLOT_LIST, familiesOf, partFits, typeFormula, typesRow, type CraftSlot, type PartSet, type WeaponPart } from './craftType.js';
import { createRng } from './rng.js';

/** Правило корня языка: два значимых слова текста с общим корнем — «слово~слово»; нет — `undefined`. */
export type RootClash = (text: string) => string | undefined;

/** Итог обхода: сколько сочетаний пройдено и какие повторили корень (`слово~слово: текст`). */
export interface Sweep { n: number; clashes: string[] }

/** Дроп обхода: имя, испечённое при рождении, и имя показа на языке стенда. */
export interface Drop { item: Item; shown: string }

/** Кириллица в строке — `code` значения не язык-нейтральный (то же правило, что у `typeFormula`). */
const CYRILLIC = /\p{Script=Cyrillic}/u;

export function nameSweeps(reg: ConfigRegistry, loc: Localizer, rootClash: RootClash) {
  const frag = (table: ConfigKey, row: object, field: string): NameFragment =>
    ({ key: cfgRowKey(reg, table, row, field) ?? '', source: String((row as Record<string, unknown>)[field] ?? '') });
  const gear = reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false);
  const pool = reg.get('rare-names');
  const check = (out: Sweep, text: string, who = text): void => {
    out.n++;
    const c = rootClash(text);
    if (c) out.clashes.push(`${c}: ${who}`);
  };

  /** Рар: каждая база × каждая основа × каждый эпитет. */
  function rare(): Sweep {
    const out: Sweep = { n: 0, clashes: [] };
    for (const b of gear) for (const no of pool.nouns) for (const ep of pool.epithets) {
      check(out, composeItemName(loc, { shape: 'rare', base: frag('items.base', b, 'name'), agreement: b.gender ?? undefined, noun: frag('rare-names', no, 't'), epithet: frag('rare-names', ep, 't') }));
    }
    return out;
  }

  /** Магия и ступень: каждое слово аффикса × каждая база, которой он выпадает; каждая ступень × каждая база. */
  function affixAndTier(): Sweep {
    const out: Sweep = { n: 0, clashes: [] };
    for (const a of reg.get('affixes')) {
      if (!a.word || a.enabled === false) continue;
      for (const b of gear) {
        const fits = (['magic', 'rare'] as const).some((r) => affixPool([a], affixTargetOfBase(b), r, 99).length > 0);
        if (!fits) continue;
        check(out, composeItemName(loc, { shape: 'magic', base: frag('items.base', b, 'name'), agreement: b.gender ?? undefined, [a.kind]: frag('affixes', a, 'word') }));
      }
    }
    for (const b of reg.get('items.base')) for (const t of reg.get('item-tiers')) {
      if (!t.name) continue;
      check(out, composeItemName(loc, { shape: 'tiered', base: frag('items.base', b, 'name'), agreement: b.gender ?? undefined, tier: frag('item-tiers', t, 'name') }));
    }
    return out;
  }

  /** Дроп: 300 раров и 300 магических настоящим `generateItem`, имя показа — `itemDisplayName` на языке стенда. */
  function drops(): Drop[] {
    const IB = reg.get('items.base');
    const common = { tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), rareNames: pool };
    const out: Drop[] = [];
    for (const rarity of ['rare', 'magic'] as const) {
      for (let s = 1; s <= 300; s++) {
        const base = gear[(s * 7) % gear.length]!;
        const lvl = 1 + ((s * 13) % 80);
        const item = generateItem(IB, reg.get('affixes'), reg.get('uniques'), { ...common, dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: base.id, forceRarity: rarity }, createRng(s * 31 + 5));
        out.push({ item, shown: itemDisplayName(reg, item, loc) });
      }
    }
    return out;
  }

  /**
   * Формула ковки: каждый «ярлык значение» — все значения каждого тега из `formula.refs` (так, как их пишет `typeFormula`: латинский `code`
   * на любом языке, кириллический — только на источнике или без перевода имени, иначе имя значения).
   */
  function formulaValues(): Sweep {
    const out: Sweep = { n: 0, clashes: [] };
    const src = loc.lang === SOURCE_LANG;
    for (const anat of reg.get('weapon-anatomy')) {
      const row = reg.get('weapon-types').find((t) => t.id === anat.id);
      for (const ref of row?.formula.refs ?? []) {
        const [slot, key] = ref.split('.') as [CraftSlot, string];
        const def = anat[slot]?.tags.find((t) => t.key === key);
        if (!def) continue;
        const label = def.label ? cfgRowTextWith(loc, reg, 'weapon-anatomy', def, 'label') : cfgRowTextWith(loc, reg, 'weapon-anatomy', def, 'name').toLowerCase();
        for (const v of def.values) {
          const nameKey = v.name ? cfgRowKey(reg, 'weapon-anatomy', v, 'name') : undefined;
          const code = v.code && (src || !CYRILLIC.test(v.code) || !nameKey || !loc.has(nameKey)) ? v.code : '';
          const val = code || (v.name ? cfgRowTextWith(loc, reg, 'weapon-anatomy', v, 'name') : '') || v.id;
          check(out, `${label} ${val}`, `${anat.id} ${ref} ${v.id}: ${label} ${val}`);
        }
      }
    }
    return out;
  }

  /**
   * Формула ковки настоящим швом: `typeFormula` на каждой детали каждого гнезда из ссылок, при каждом хвате класса. Сверяется КАЖДЫЙ кусок
   * «ярлык значение» отдельно: совпадение между кусками — описание разных деталей, а не тавтология («гарда диск · оголовок диск»).
   */
  function formulaParts(): Sweep {
    const out: Sweep = { n: 0, clashes: [] };
    const parts = reg.get('weapon-parts');
    for (const anat of reg.get('weapon-anatomy')) {
      if (anat.enabled === false) continue;
      const row = typesRow(reg, anat.id);
      if (!row) continue;
      const title = row.formula.title ? `${cfgRowTextWith(loc, reg, 'weapon-types', row.formula, 'title')}: ` : '';
      for (const hands of familiesOf(reg, anat.id)) {
        const fits = (slot: CraftSlot): WeaponPart[] => parts.filter((p) => partFits(p, anat.id, slot, hands));
        const first = Object.fromEntries(CRAFT_SLOT_LIST.map((s) => [s, fits(s)[0]])) as Partial<PartSet>;
        if (CRAFT_SLOT_LIST.some((s) => !first[s])) continue;
        const slots = [...new Set(row.formula.refs.map((r) => r.split('.')[0] as CraftSlot))];
        for (const slot of slots) for (const p of fits(slot)) {
          const f = typeFormula(anat, row, { ...first, [slot]: p } as PartSet, { loc, reg });
          const bits = (f.startsWith(title) ? f.slice(title.length) : f).split(' · ');
          for (const bit of bits) check(out, bit, `${anat.id}/${hands} ${slot}=${p.id}: ${bit}`);
        }
      }
    }
    return out;
  }

  return { frag, gear, pool, rare, affixAndTier, drops, formulaValues, formulaParts };
}
