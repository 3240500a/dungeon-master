import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { CYRILLIC, Localizer, pseudoLocales, withTextLang, localizerFor, cfgRowTextWith } from '../i18n/index.js';
import { createRng } from './rng.js';
import { generateItem, itemFromBaseId, retierItem } from './itemgen.js';
import { craftWeapon, enchantItem, shapeFoundWeapon } from './craft.js';
import { CRAFT_SLOT_LIST, familiesOf, partFits } from './craftType.js';
import { itemDisplayName, itemNameRecomposes, localizeItem } from './itemDisplay.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { rollShopGear } from '../economy/shopGear.js';
import { buildSeal, sealBundleLine, sealItem, sealTiers } from '../economy/seals.js';
import { materialItem } from '../economy/materials.js';
import { upgradedItem } from '../economy/townActions.js';
import type { Item, Rarity } from '../types/items.js';
import type { CraftParts } from '../types/items.js';

/**
 * ⭐⭐ i18n Ф2 (06.11): ОРАКУЛ ИМЕНИ ПОКАЗА. Имя вещи печётся языком-источником при рождении (`Item.name`), показ пересобирает его из данных
 * вещи на языке игрока (`itemDisplayName`). Сторож: на ЯЗЫКЕ-ИСТОЧНИКЕ рецепт показа собирает РОВНО испечённое имя — для каждого пути
 * рождения вещи (дроп всех редкостей с пулом имён и без, уники, найденное оружие с деталями, ковка всех семейств, зачарование, подъём
 * ступени, лавка, расходники, стартовый набор, награда, печати, сырьё). Не сошлось — показ отдаёт испечённое (запас), и такие случаи
 * перечислены здесь явно; на псевдоязыке сошедшиеся имена не несут ни одной кириллической буквы.
 */
const cfg = new ConfigRegistry();
cfg.loadAll();
const xx = pseudoLocales(cfg.get('locales'), defaultConfigData);
const XX = localizerFor(xx, 'xx')!;

/** Образец: путь рождения → вещи. */
function sample(): Record<string, Item[]> {
  const out: Record<string, Item[]> = {};
  const put = (k: string, it: Item | null | undefined): void => { if (it) (out[k] ??= []).push(it); };
  const bases = cfg.get('items.base');
  const common = { tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), maxReqTotal: cfg.get('balance').maxTotalRequirement };
  const rng = createRng(20261106);
  // дроп: все редкости × уровни, с пулом рарных имён (как у сессии) и без (как у эталона окон)
  for (const rarity of ['normal', 'magic', 'rare', 'unique'] as Rarity[]) {
    for (let i = 0; i < 260; i++) {
      const level = 1 + (i % 60);
      const it = generateItem(bases, cfg.get('affixes'), cfg.get('uniques'), {
        ...common, dropBias: 0, itemLevel: level, tierLevel: level, forceRarity: rarity,
        rareNames: i % 5 === 0 ? undefined : cfg.get('rare-names'), categoryWeights: cfg.get('balance').loot.categoryWeights,
      }, rng);
      put(`drop.${it.rarity}`, it);
      put('drop.foundShaped', shapeFoundWeapon(cfg, it));
    }
  }
  // явная база каждой базы (лавка/награда/старт)
  for (const b of bases) put(`base.${b.kind}`, itemFromBaseId(bases, b.id, cfg.get('item-tiers'), 'quest'));
  for (const b of bases.filter((x) => x.kind === 'consumable')) put('consumable.untiered', itemFromBaseId(bases, b.id, undefined, 'shop'));
  // лавка — несколько поколений и уровней
  for (let s = 1; s <= 12; s++) for (const it of rollShopGear(cfg, s * 7919, 1 + s * 4)) put('shop', it);
  // стартовый набор каждого класса
  for (const c of cfg.get('classes')) {
    const save = newCharacterSave(cfg, c.id, 'x', `c-${c.id}`);
    for (const it of [...Object.values(save.equipment), ...save.inventory, ...save.belt]) put('start', it ?? undefined);
  }
  // подъём ступени у кузнеца (обычная получает новое имя ступени, прочие — своё)
  for (const it of [...(out['drop.normal'] ?? []), ...(out['drop.magic'] ?? []), ...(out['drop.rare'] ?? [])].slice(0, 400)) put('upgraded', upgradedItem(cfg, it));
  for (const it of (out['drop.normal'] ?? []).slice(0, 120)) {
    const base = bases.find((b) => b.id === it.baseId)!;
    for (const t of cfg.get('item-tiers').slice(0, 3)) put('retier', retierItem(base, it, t));
  }
  // ковка: все семейства, случайные детали в окне ступеней; часть — зачарована
  const parts = cfg.get('weapon-parts');
  for (const anat of cfg.get('weapon-anatomy')) {
    for (const hands of familiesOf(cfg, anat.id)) {
      for (let i = 0; i < 40; i++) {
        const pick = {} as CraftParts;
        let ok = true;
        for (const slot of CRAFT_SLOT_LIST) {
          const pool = parts.filter((p) => partFits(p, anat.id, slot, hands));
          if (!pool.length) { ok = false; break; }
          const p = pool[rng.int(0, pool.length - 1)]!;
          pick[slot] = { id: p.id, step: rng.int(p.stepMin, p.stepMax) };
        }
        if (!ok) continue;
        const r = craftWeapon(cfg, { weaponClass: anat.id, hands, parts: pick }, { rng });
        if (!r.ok || !r.item) continue;
        put('craft', r.item);
        if (i % 3 === 0) put('craft.magic', enchantItem(cfg, r.item, 'magic', rng));
        if (i % 3 === 1) put('craft.rare', enchantItem(cfg, r.item, 'rare', rng));
      }
    }
  }
  // зачарование найденного
  for (const it of (out['drop.normal'] ?? []).slice(0, 200)) put('enchant', enchantItem(cfg, it, rng.chance(0.5) ? 'magic' : 'rare', rng));
  // печати (со ступенью — как с алтаря и с убитого; без — образец окна) и сырьё
  for (const s of cfg.get('seals')) {
    for (const t of sealTiers(cfg)) put('seal', buildSeal(cfg, s.id, t.id, 2, `s-${s.id}-${t.id}`));
    put('seal.noTier', sealItem(s, sealTiers(cfg)[0]!.id, 1, `s-${s.id}`));
  }
  for (const m of cfg.get('craft-materials')) put('material', materialItem(m, 5, `m-${m.id}`));
  return out;
}

describe('⭐⭐ i18n Ф2: имя вещи для показа (`itemDisplayName`)', () => {
  const byKind = sample();
  const all = Object.values(byKind).flat();

  it('⭐⭐ ОРАКУЛ: на языке-источнике рецепт показа = испечённое имя — на каждом пути рождения вещи', () => {
    const report: Record<string, { n: number; fallback: number; examples: string[] }> = {};
    for (const [k, items] of Object.entries(byKind)) {
      const bad = items.filter((it) => itemNameRecomposes(cfg, it) !== 'ok');
      report[k] = { n: items.length, fallback: bad.length, examples: bad.slice(0, 3).map((it) => `${it.baseId} «${it.name}»`) };
    }
    // ⚠ запас (рецепт не сошёлся) допускается ТОЛЬКО там, где он объясним; сегодня таких путей рождения нет
    const fallbacks = Object.fromEntries(Object.entries(report).filter(([, r]) => r.fallback > 0));
    expect(fallbacks).toEqual({});
    expect(all.length, 'образец — тысячи вещей').toBeGreaterThan(2000);
    for (const k of ['drop.normal', 'drop.magic', 'drop.rare', 'drop.unique', 'craft', 'craft.magic', 'craft.rare', 'enchant', 'upgraded', 'shop', 'start', 'seal', 'seal.noTier', 'material', 'consumable.untiered']) {
      expect(byKind[k]?.length ?? 0, `путь «${k}» в образце`).toBeGreaterThan(0);
    }
  });

  it('⭐ язык-источник: показ — само испечённое имя, вещь не копируется', () => {
    for (const it of all.slice(0, 300)) {
      expect(itemDisplayName(cfg, it)).toBe(it.name);
      expect(localizeItem(cfg, it)).toBe(it);
      expect(itemDisplayName(cfg, it, new Localizer(cfg.get('locales'), 'ru'))).toBe(it.name);
    }
  });

  it('⭐⭐ на псевдоязыке имя каждой вещи — без кириллицы (все фрагменты пришли переводом)', () => {
    const leaks: string[] = [];
    for (const it of all) {
      const shown = itemDisplayName(cfg, it, XX);
      if (CYRILLIC.test(shown)) leaks.push(`${it.kind}/${it.rarity} ${it.baseId}: «${it.name}» → «${shown}»`);
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    // и областью — тем же путём, что сервер
    const it = byKind['drop.rare']![0]!;
    expect(withTextLang(xx, 'xx', () => itemDisplayName(cfg, it))).toBe(itemDisplayName(cfg, it, XX));
    expect(withTextLang(xx, 'xx', () => localizeItem(cfg, it)).name).not.toBe(it.name);
  });

  it('⚠ запас: имя, которого рецепт не собирает (база переименована после рождения), показывается как испечено', () => {
    const it = { ...byKind['drop.normal']![0]!, name: 'Меч, переименованный руками' };
    expect(itemNameRecomposes(cfg, it)).toBe('fallback');
    expect(itemDisplayName(cfg, it, XX)).toBe('Меч, переименованный руками');
    const old = { ...byKind['drop.rare']!.find((x) => x.nameRoll)!, nameRoll: undefined };
    expect(itemDisplayName(cfg, old, XX), 'рар старше `nameRoll`: основу и эпитет не вывести — испечённое').toBe(old.name);
  });
});

describe('⭐ i18n (07.11, хвосты Ф1): печать — шаблоном языка, память показа — с поколением реестра, имя героя по умолчанию', () => {
  it('⭐ «вид + ступень» печати на другом языке — фразой-шаблоном (`srv:seal.nameTier`), источник — прежняя склейка пробелом', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    const loc = structuredClone(xx) as Record<string, { strings: Record<string, unknown>; grammar: Record<string, unknown> }>;
    // язык с другим порядком и без пробела (как `zh`): ступень впереди, разделитель — «·»
    loc.xx!.strings['srv:seal.nameTier'] = '{tier}·{name}';
    r.reload({ locales: loc });
    const L = localizerFor(r.get('locales'), 'xx')!;
    const def = r.get('seals')[0]!, tier = sealTiers(r)[0]!;
    const it = buildSeal(r, def.id, tier.id, 1, 'seal-tpl')!;
    expect(it.name, 'печать — языком-источником, склейкой пробелом').toBe(`${def.name} ${tier.name}`);
    expect(itemNameRecomposes(r, it)).toBe('ok');
    const shown = itemDisplayName(r, it, L);
    expect(shown).toBe(`${cfgRowTextWith(L, r, 'balance', tier)}·${cfgRowTextWith(L, r, 'seals', def)}`);
    expect(shown).not.toMatch(CYRILLIC);
    // строка связки окна алтаря (`sealBundleLine` → `sealNameText`) — тем же шаблоном, а русский — побайтово прежний
    const key = `${def.id}@${tier.id}`;
    expect(withTextLang(r.get('locales'), 'xx', () => sealBundleLine(r, { [key]: 2 }))).toBe(`${shown} ×2`);
    expect(sealBundleLine(r, { [key]: 2 })).toBe(`${def.name} ${tier.name} ×2`);
  });

  it('⭐ память показа помнит ПОКОЛЕНИЕ реестра: правка `items.base` без `locales` не оставляет иноязычному прежнее имя', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    r.reload({ locales: xx });
    const L = localizerFor(r.get('locales'), 'xx')!;
    const it = itemFromBaseId(r.get('items.base'), 'healing-potion', undefined, 'shop')!;
    const before = itemDisplayName(r, it, L);
    expect(before).not.toBe(it.name);
    expect(itemDisplayName(r, it, L), 'та же вещь, тот же реестр — из памяти').toBe(before);
    // база переименована (новая таблица, `locales` — та же): рецепт больше не собирает испечённое — показ обязан дать запас
    const gen = r.generation();
    const bases = structuredClone(r.get('items.base')).map((b) => (b.id === 'healing-potion' ? { ...b, name: `${b.name} (новое)` } : b));
    r.reload({ 'items.base': bases });
    expect(r.generation()).toBeGreaterThan(gen);
    expect(localizerFor(r.get('locales'), 'xx'), 'разрешитель — тот же объект: память по нему одному устарела бы').toBe(L);
    expect(itemDisplayName(r, it, L), 'после правки базы — испечённое (рецепт не сошёлся), а не прежний перевод').toBe(it.name);
  });

  it('⭐ имя героя по умолчанию — на языке области создания; источник — «Герой»', () => {
    const cls = cfg.get('classes')[0]!.id;
    expect(newCharacterSave(cfg, cls, '  ', 'h-ru').name).toBe('Герой');
    const en = withTextLang(xx, 'xx', () => newCharacterSave(cfg, cls, '', 'h-xx').name);
    expect(en).toBe(XX.text('srv:hero.defaultName', 'Герой'));
    expect(en).not.toMatch(CYRILLIC);
    expect(withTextLang(xx, 'xx', () => newCharacterSave(cfg, cls, 'Вася', 'h-v').name), 'набранное игроком — как есть').toBe('Вася');
  });
});
