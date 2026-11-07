import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { Localizer, SOURCE_LANG, cfgRowKey, cfgRowTextWith, localizerFor } from '../i18n/index.js';
import { composeItemName, type NameFragment } from './itemName.js';
import { affixPool, affixTargetOfBase, generateItem } from './itemgen.js';
import { itemDisplayName } from './itemDisplay.js';
import { createRng } from './rng.js';

/**
 * ⭐ i18n Ф3, этап 3 (07.11): АНГЛИЙСКИЕ ИМЕНА ВЕЩЕЙ БЕЗ ПОВТОРА КОРНЯ. Русский бросок имени переводился слово в слово, и английский
 * повторял корень базы: «Storm Secrets Storm Staff» (Гроза + Посох бури), «Plated Plate Helm» (Обшитый + Латный шлем), «Flaming Flame
 * Staff», «Tower Shield of Shielding»; в формуле ковки — «lugs no lugs», «poll long poll», «hold held at the heel». Лечится данными языка
 * (слова `en` и шаблон `item.rare` — «{epithet} {noun} {base}», как у Diablo II: «Blood Fang Dagger»), код сборки не тронут.
 * Сторож обходит ВСЕ сочетания на живых данных: база × основа × эпитет, база × слово аффикса, база × ступень, ярлык × значение формулы.
 * ⚠ Только английский: у русского свои совпадения («Ядовитый жезл яда», «щекавицы без щекавиц») — их решает владелец, не перевод.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const EN = localizerFor(reg.get('locales'), 'en')!;
const SRC = new Localizer(undefined, SOURCE_LANG);

/** Значимые слова имени: строчные, без «'s» и служебных слов; составное «Two-Handed» — два слова. */
const STOP = new Set(['of', 'the', 'a', 'an', 'with', 'and', 'on', 'at', 'to', 'in']);
/** Неправильные формы, которых не видит сравнение начал (hold/held — «hold held at the heel»). */
const LEMMA: Readonly<Record<string, string>> = { held: 'hold' };
const words = (s: string): string[] => s.toLowerCase().replace(/'s\b/g, '').split(/[^a-z]+/).filter((w) => w && !STOP.has(w)).map((w) => LEMMA[w] ?? w);
const prefixLen = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/**
 * Общий корень: то же слово; общее начало ≥ 4 букв и ≥ 60 % короткого (plate/plated, flame/flaming); короткое (≥ 3) — начало
 * длинного (hand/handed, hunt/hunting); короткое (≥ 4) — хвост составного (stock/buttstock, guard/crossguard).
 * ⚠ war ⊂ ward — разные слова (Ward рядом с War Axe, of Fire Warding у War Girdle).
 */
function sameRoot(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s === 'war' && l.startsWith('ward')) return false;
  const p = prefixLen(s, l);
  return s === l || (p >= 4 && p >= 0.6 * s.length) || (s.length >= 3 && p === s.length) || (s.length >= 4 && l.endsWith(s));
}
function rootClash(name: string): string | undefined {
  const w = words(name);
  for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) if (sameRoot(w[i]!, w[j]!)) return `${w[i]}~${w[j]}`;
  return undefined;
}
const frag = (table: Parameters<typeof cfgRowKey>[1], row: object, field: string): NameFragment =>
  ({ key: cfgRowKey(reg, table, row, field) ?? '', source: String((row as Record<string, unknown>)[field] ?? '') });

const gear = reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false);
const pool = reg.get('rare-names');

describe('⭐ i18n Ф3, этап 3: английские имена вещей без повтора корня', () => {
  it('сторож корня ловит прежние беды (иначе он ничего не доказывает)', () => {
    for (const bad of ['Storm Secrets Storm Staff', 'Plated Plate Helm', 'Flaming Flame Staff', 'Tower Shield of Shielding', 'Hand Blood Hand Axe',
      'Ash Hunt Hunting Bow', 'Ash Execution Executioner\'s Axe', 'Hand Thirst Two-Handed Sword', 'lugs no lugs', 'poll long poll',
      'hold held at the heel', 'stock schnepper with buttstock', 'crossguard claymore guard', 'crossguard guard plate']) {
      expect(rootClash(bad), bad).toBeDefined();
    }
    for (const ok of ['Blood Fang Dagger', 'Ward Bite War Axe', 'War Girdle of Fire Warding', 'Soul Edge Long Sword']) expect(rootClash(ok), ok).toBeUndefined();
  });

  it('⭐ рар: каждая база × каждая основа × каждый эпитет — ни одно слово не повторяет корень другого', () => {
    const clashes: string[] = [];
    let n = 0;
    for (const b of gear) for (const no of pool.nouns) for (const ep of pool.epithets) {
      const name = composeItemName(EN, { shape: 'rare', base: frag('items.base', b, 'name'), agreement: b.gender ?? undefined, noun: frag('rare-names', no, 't'), epithet: frag('rare-names', ep, 't') });
      n++;
      const c = rootClash(name);
      if (c) clashes.push(`${c}: ${name}`);
    }
    expect(n).toBeGreaterThan(100_000);
    expect(clashes.slice(0, 5)).toEqual([]);
  });

  it('⭐ рар: основы и эпитеты различны между собой (было два «Fury»: Ярость и Гнев), эпитет — впереди основы', () => {
    const nouns = pool.nouns.map((x) => cfgRowTextWith(EN, reg, 'rare-names', x, 't'));
    const eps = pool.epithets.map((x) => cfgRowTextWith(EN, reg, 'rare-names', x, 't'));
    const all = [...nouns, ...eps];
    expect(all.filter((w, i) => all.indexOf(w) !== i)).toEqual([]);
    const pairs = nouns.flatMap((a) => eps.filter((b) => sameRoot(a.toLowerCase(), b.toLowerCase())).map((b) => `${a}/${b}`));
    expect(pairs).toEqual([]);
    // «Клык крови» → «Blood Fang»: английский ставит определяющее слово впереди, русский шаблон прежний
    const dagger = gear.find((b) => b.id === 'dagger')!;
    const klyk = pool.nouns.find((x) => x.id === 'klyk')!, krovi = pool.epithets.find((x) => x.id === 'krovi')!;
    const spec = { shape: 'rare' as const, base: frag('items.base', dagger, 'name'), agreement: dagger.gender ?? undefined, noun: frag('rare-names', klyk, 't'), epithet: frag('rare-names', krovi, 't') };
    expect(composeItemName(EN, spec)).toBe('Blood Fang Dagger');
    expect(composeItemName(SRC, spec)).toBe('Кинжал Клык крови');
  });

  it('⭐ магия и ступень: каждое слово аффикса × каждая база, которой он выпадает; каждая ступень × каждая база', () => {
    const clashes: string[] = [];
    let n = 0;
    for (const a of reg.get('affixes')) {
      if (!a.word || a.enabled === false) continue;
      for (const b of gear) {
        const fits = (['magic', 'rare'] as const).some((r) => affixPool([a], affixTargetOfBase(b), r, 99).length > 0);
        if (!fits) continue;
        const name = composeItemName(EN, { shape: 'magic', base: frag('items.base', b, 'name'), agreement: b.gender ?? undefined, [a.kind]: frag('affixes', a, 'word') });
        n++;
        const c = rootClash(name);
        if (c) clashes.push(`${c}: ${name}`);
      }
    }
    for (const b of reg.get('items.base')) for (const t of reg.get('item-tiers')) {
      if (!t.name) continue;
      const name = composeItemName(EN, { shape: 'tiered', base: frag('items.base', b, 'name'), agreement: b.gender ?? undefined, tier: frag('item-tiers', t, 'name') });
      n++;
      const c = rootClash(name);
      if (c) clashes.push(`${c}: ${name}`);
    }
    expect(n).toBeGreaterThan(2_000);
    expect(clashes).toEqual([]);
  });

  it('⭐ настоящий шов: дроп рара и магии → `itemDisplayName` на английском — пересобран, без повтора корня', () => {
    const IB = reg.get('items.base');
    const common = { tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), rareNames: pool };
    const bad: string[] = [];
    let n = 0;
    for (const rarity of ['rare', 'magic'] as const) {
      for (let s = 1; s <= 300; s++) {
        const base = gear[(s * 7) % gear.length]!;
        const lvl = 1 + ((s * 13) % 80);
        const it = generateItem(IB, reg.get('affixes'), reg.get('uniques'), { ...common, dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: base.id, forceRarity: rarity }, createRng(s * 31 + 5));
        const en = itemDisplayName(reg, it, EN);
        n++;
        if (en === it.name || rootClash(en)) bad.push(`${it.name} → ${en}`);
      }
    }
    expect(n).toBe(600);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('⭐ формула ковки: ярлык и значение не повторяют друг друга («lugs none», не «lugs no lugs»)', () => {
    const clashes: string[] = [];
    let n = 0;
    for (const anat of reg.get('weapon-anatomy')) {
      const row = reg.get('weapon-types').find((t) => t.id === anat.id);
      for (const ref of row?.formula.refs ?? []) {
        const [slot, key] = ref.split('.') as ['strike' | 'grip' | 'bind' | 'head', string];
        const def = anat[slot]?.tags.find((t) => t.key === key);
        if (!def) continue;
        const label = def.label ? cfgRowTextWith(EN, reg, 'weapon-anatomy', def, 'label') : cfgRowTextWith(EN, reg, 'weapon-anatomy', def, 'name').toLowerCase();
        for (const v of def.values) {
          // как у `typeFormula`: латинский `code` — как есть, иначе имя значения
          const val = v.code && !/\p{Script=Cyrillic}/u.test(v.code) ? v.code : (v.name ? cfgRowTextWith(EN, reg, 'weapon-anatomy', v, 'name') : v.id);
          n++;
          const c = rootClash(`${label} ${val}`);
          if (c) clashes.push(`${anat.id} ${ref} ${v.id}: ${label} ${val}`);
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(clashes).toEqual([]);
  });
});
