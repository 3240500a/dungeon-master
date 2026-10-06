import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { defaultConfigData } from './defaults.js';
import { configCrossIssues, crossIssuesWorse, CONFIG_CROSS_RULES, type ConfigCrossIssue, type ConfigKey, type ConfigShapes } from './schemas.js';
import { upgradeStoredOverride } from './storedOverride.js';
import { ESSENCE_ID } from '../formulas/salvage.js';
import { SELL_FLOOR_SLACK } from '../formulas/salvageGuard.js';
import { salvageGrades, tierIndex } from '../formulas/craft.js';
import type { Item } from '../types/items.js';

/**
 * ⭐ ПРАВИЛА ПОВЕРХ ТАБЛИЦ: КАЖДОЕ — ПО СВОИМ ТАБЛИЦАМ, ОТКАЗ — ТОЛЬКО НОВОМУ ИЛИ УГЛУБЛЁННОМУ (рецензия 06.10, правила разбора и D4).
 *
 * Прежде правка любой таблицы из общего списка будила ВСЕ правила, и проверка шла «всё или ничего» над итогом: нарушение, уже лежащее в
 * живом конфиге (старый оверрайд `craft-materials` с ценами 1/4/12/36/108 без эссенции, сборка приняла его с инцидентом), запирало
 * сохранение древа скилов, а нарушение баффа — сохранение ступеней и сырья. Правило цен D4 не имело допуска — правка окна лута, порога
 * ступени или единиц разбора отказывала словами «снизь цену сырья»; правило рецепта требовало «строк ровно по ступеням» — добавить ступень
 * было нельзя ни в каком порядке (редактор сохраняет по таблице).
 */
type Tables = Record<string, unknown>;
const files = (): Tables => structuredClone(defaultConfigData) as Tables;
const regOf = (t: Tables = files()): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(t); return r; };
const refused = (fn: () => void): string | null => { try { fn(); return null; } catch (e) { return (e as Error).message; } };

/** Таблица сырья, как её сохранил редактор ДО эссенции и цен D4 (оверрайд базы — таблицей целиком). */
function staleCraftMaterials(): ConfigShapes['craft-materials'] {
  const old = [0, 1, 4, 12, 36, 108];
  return (structuredClone(defaultConfigData['craft-materials']) as ConfigShapes['craft-materials'])
    .filter((m) => m.id !== ESSENCE_ID)
    .map((m) => ({ ...m, sellPrice: old[m.tier] ?? m.sellPrice }));
}

/** Живой реестр, в котором правило цен D4 УЖЕ нарушено (как после сборки с инцидентом: `loadAll(…, { cross: false })`). */
function liveWithBadPrices(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll({ ...files(), 'craft-materials': staleCraftMaterials() }, { cross: false });
  expect(configCrossIssues((k) => r.get(k)).some((i) => i.rule === 'salvage-sell'), 'нарушение лежит').toBe(true);
  return r;
}

describe('⭐ правило — по своим таблицам (`CONFIG_CROSS_RULES`)', () => {
  it('каждое правило объявляет свои таблицы; правка чужой таблицы его не будит', () => {
    expect(CONFIG_CROSS_RULES.buff).toEqual(['balance', 'skill-tree', 'skill-inserts']);
    expect(CONFIG_CROSS_RULES['salvage-sell']).toEqual(['balance', 'item-tiers', 'craft-materials', 'salvage-rules']);
    const r = liveWithBadPrices();
    const get = (k: ConfigKey): unknown => r.get(k);
    expect(configCrossIssues(get, ['skill-tree']), 'древо цен сырья не читает').toEqual([]);
    expect(configCrossIssues(get, ['skill-inserts'])).toEqual([]);
    expect(configCrossIssues(get, ['craft-materials']).length).toBeGreaterThan(0);
  });

  it('⭐ лежащее нарушение цен не запирает: древо, вставки, ступени, правила разбора и несвязанная правка баланса сохраняются', () => {
    const r = liveWithBadPrices();
    expect(refused(() => r.reload({ 'skill-tree': structuredClone(r.get('skill-tree')) })), 'было: «skill-tree … craft-materials: ⭐ D4 …»').toBeNull();
    expect(refused(() => r.reload({ 'skill-inserts': structuredClone(r.get('skill-inserts')) }))).toBeNull();
    expect(refused(() => r.reload({ 'item-tiers': structuredClone(r.get('item-tiers')) }))).toBeNull();
    expect(refused(() => r.reload({ 'salvage-rules': structuredClone(r.get('salvage-rules')) }))).toBeNull();
    expect(refused(() => r.reload({ balance: { ...structuredClone(r.get('balance')), respecCost: 4321 } }))).toBeNull();
    // Галка сырья хозяина (R2-28) — правка той же таблицы, нарушение не углубляет: проходит.
    const toggled = structuredClone(r.get('craft-materials')).map((m) => (m.id === 'iron-5' ? { ...m, enabled: !m.enabled } : m));
    expect(refused(() => r.reload({ 'craft-materials': toggled }))).toBeNull();
  });

  it('⭐ а НОВОЕ или УГЛУБЛЁННОЕ нарушение — отказ, как прежде', () => {
    const r = liveWithBadPrices();
    const dearer = structuredClone(r.get('craft-materials')).map((m) => (m.tier === 5 ? { ...m, sellPrice: m.sellPrice * 2 } : m));
    expect(refused(() => r.reload({ 'craft-materials': dearer })), 'углубление').toMatch(/craft-materials[\s\S]*D4/);
    // На чистом конфиге — любое нарушение новое.
    const clean = regOf();
    const bad = structuredClone(clean.get('craft-materials')).map((m) => (m.tier === 4 ? { ...m, sellPrice: 500 } : m));
    expect(refused(() => clean.reload({ 'craft-materials': bad }))).toMatch(/D4/);
    expect(clean.get('craft-materials').find((m) => m.id === 'iron-4')!.sellPrice, 'отказ — ничего не легло').not.toBe(500);
  });

  it('⭐ лежащее нарушение баффа не запирает ступени, сырьё и правила разбора', () => {
    const t = files();
    const tree = t['skill-tree'] as { nodes: { effect: { active?: { category?: string; cooldown: number; durationSec: number } } }[] };
    const buff = tree.nodes.find((n) => n.effect.active?.category === 'buff')!;
    buff.effect.active!.cooldown = buff.effect.active!.durationSec;   // откат = действию: правило баффа нарушено
    const r = new ConfigRegistry();
    r.loadAll(t, { cross: false });
    expect(configCrossIssues((k) => r.get(k)).some((i) => i.rule === 'buff')).toBe(true);
    expect(refused(() => r.reload({ 'item-tiers': structuredClone(r.get('item-tiers')) }))).toBeNull();
    expect(refused(() => r.reload({ 'craft-materials': structuredClone(r.get('craft-materials')) }))).toBeNull();
    expect(refused(() => r.reload({ 'salvage-rules': structuredClone(r.get('salvage-rules')) }))).toBeNull();
  });

  it('`loadAll` целиком — по-прежнему всё нарушенное: файлы с нарушением не грузятся', () => {
    expect(refused(() => regOf({ ...files(), 'craft-materials': staleCraftMaterials() }))).toMatch(/D4/);
  });

  it('`crossIssuesWorse`: то же правило и строка — не новое; глубже — новое; шум плавающей точки — не углубление', () => {
    const i = (id: string, sev: number[], rule: ConfigCrossIssue['rule'] = 'salvage-sell'): ConfigCrossIssue => ({ key: 'craft-materials', msg: id, rule, id, severity: sev });
    expect(crossIssuesWorse([i('a', [2])], [i('a', [2 + 1e-12])])).toEqual([]);
    expect(crossIssuesWorse([i('a', [2])], [i('a', [1.5])])).toEqual([]);
    expect(crossIssuesWorse([i('a', [2])], [i('a', [2.5])]).map((x) => x.id)).toEqual(['a']);
    expect(crossIssuesWorse([i('a', [2])], [i('b', [1])]).map((x) => x.id)).toEqual(['b']);
    expect(crossIssuesWorse([i('a', [2], 'buff')], [i('a', [2])]).map((x) => x.rule), 'другое правило — новое').toEqual(['salvage-sell']);
    // Бафф: глубже — раньше первый негодный ранг ([-ранг, нехватка]).
    expect(crossIssuesWorse([i('x', [-6, 1], 'buff')], [i('x', [-4, 0.5], 'buff')]).length, 'раньше ранг — глубже').toBe(1);
    expect(crossIssuesWorse([i('x', [-6, 1], 'buff')], [i('x', [-8, 5], 'buff')]).length, 'позже ранг — мельче').toBe(0);
  });
});

describe('⭐ D4 цен — с допуском и с именами ручек (правка лута и ступеней не запирается словами «снизь цену сырья»)', () => {
  const balanceWith = (patch: (b: ConfigShapes['balance']) => void): ConfigShapes['balance'] => {
    const b = structuredClone(regOf().get('balance'));
    patch(b);
    return b;
  };
  it('окно лута over 5 → 6, единицы удара 3 → 4, порог t1 8 → 7 — принимаются (ядро и так держит D4 полом цены)', () => {
    const r = regOf();
    expect(refused(() => r.reload({ balance: balanceWith((b) => { b.loot.tierWindow.over = 6; }) }))).toBeNull();
    expect(refused(() => regOf().reload({ balance: balanceWith((b) => { b.craft.salvage.units.strike = 4; }) }))).toBeNull();
    const tiers = structuredClone(regOf().get('item-tiers')).map((t) => (t.id === 't1' ? { ...t, minItemLevel: 7 } : t));
    expect(refused(() => regOf().reload({ 'item-tiers': tiers }))).toBeNull();
  });

  it('старые цены (36/108) по-прежнему не пускаются — и текст называет ручки, из которых складывается неравенство', () => {
    const why = refused(() => regOf().reload({ 'craft-materials': staleCraftMaterials() }));
    expect(why).toMatch(/craft-materials\.sellPrice/);
    expect(why).toMatch(/balance\.loot\.tierWindow\.over/);
    expect(why).toMatch(/item-tiers\.minItemLevel/);
    expect(why).toMatch(/balance\.craft\.salvage\.units|salvage-rules/);
    expect(why).toMatch(new RegExp(`${Math.round(SELL_FLOOR_SLACK * 100)} %`));
  });

  it('и сильная правка лута, при которой пол цены задирал бы цены вещей больше допуска, — отказ', () => {
    // Окно вниз на 40 уровней: самая дешёвая t6 — с уровня 40, её цена — треть сырья с разбора.
    expect(refused(() => regOf().reload({ balance: balanceWith((b) => { b.loot.tierWindow.over = 40; }) }))).toMatch(/D4/);
  });
});

describe('⭐ ступень можно добавить и убрать по одной таблице (рецепт не требует «строк ровно столько»)', () => {
  const t7 = (r: ConfigRegistry): ConfigShapes['item-tiers'] =>
    [...structuredClone(r.get('item-tiers')), { ...structuredClone(r.get('item-tiers').at(-1)!), id: 't7', name: 'Легендарный', minItemLevel: 95, statMult: 7, reqMult: 12 }];
  it('сперва ступень, потом строка рецепта — оба шага проходят', () => {
    const r = regOf();
    expect(refused(() => r.reload({ 'item-tiers': t7(r) })), 'было: «7 строк, а ступеней 8»').toBeNull();
    const b = structuredClone(r.get('balance'));
    b.salvage.recipeByTier.push([5, 5, 5, 5]);
    // Строка t7 [5,5,5,5] куётся в t6 — правило «своей ступени» её честно не пускает; без строки ступень берёт последнюю.
    expect(refused(() => r.reload({ balance: b }))).toMatch(/рецепт разбора ступени t7/);
  });
  it('сперва строка, потом ступень — тоже; лишняя строка не читается', () => {
    const r = regOf();
    const b = structuredClone(r.get('balance'));
    b.salvage.recipeByTier.push([5, 5, 5, 5]);
    expect(refused(() => r.reload({ balance: b })), 'было: «8 строк, а ступеней 7»').toBeNull();
  });
  it('ступень без своей строки разбирается ПОСЛЕДНЕЙ строкой — сорт ниже своей ступени, насоса нет', () => {
    const r = regOf();
    r.reload({ 'item-tiers': t7(r) });
    const item = { baseId: 'long-sword', kind: 'weapon', tier: 't7', origin: 'drop', rarity: 'normal', itemLevel: 96, affixes: [], baseStats: [] } as unknown as Item;
    const g = salvageGrades(r, item);
    expect(g.tier).toBe(tierIndex(r, 't7'));
    expect(g.row).toEqual(r.get('balance').salvage.recipeByTier.at(-1));
  });
});

describe('⭐ оверрайд `craft-materials`, сохранённый до эссенции и цен D4, приводится при сборке', () => {
  it('нет строки эссенции — дописана из файла, цены — файла; галки и имена хозяина остаются', () => {
    const stale = staleCraftMaterials().map((m) => (m.id === 'iron-5' ? { ...m, enabled: false, name: 'Булат хозяина' } : m));
    const { value, fixes } = upgradeStoredOverride('craft-materials', stale);
    const rows = value as ConfigShapes['craft-materials'];
    const file = defaultConfigData['craft-materials'] as ConfigShapes['craft-materials'];
    expect(rows.find((m) => m.id === ESSENCE_ID), 'эссенция на месте').toEqual(file.find((m) => m.id === ESSENCE_ID));
    for (const f of file) expect(rows.find((m) => m.id === f.id)!.sellPrice, f.id).toBe(f.sellPrice);
    expect(rows.find((m) => m.id === 'iron-5')).toMatchObject({ enabled: false, name: 'Булат хозяина' });
    expect(fixes.some((l) => l.includes(ESSENCE_ID))).toBe(true);
    expect(fixes.some((l) => /iron-5\.sellPrice: 108 → 15/.test(l))).toBe(true);
    // Приведённое годно вместе с прочими таблицами файлов.
    expect(refused(() => regOf({ ...files(), 'craft-materials': rows }))).toBeNull();
  });
  it('таблица с эссенцией (сохранена после правила) не трогается — её цены решает хозяин и держит правило', () => {
    const own = structuredClone(defaultConfigData['craft-materials']) as ConfigShapes['craft-materials'];
    own[0]!.sellPrice = 2;
    expect(upgradeStoredOverride('craft-materials', own)).toEqual({ value: own, fixes: [] });
  });
});
