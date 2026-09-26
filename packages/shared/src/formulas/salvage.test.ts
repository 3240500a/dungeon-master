import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  salvageFromMonster, piecesDropped, shiftTier, salvageRuleFor, salvageMult, canSalvage, salvageFromItem,
  type SalvageableGear, type SalvageableItem,
} from './salvage.js';
import type { MonsterGearRoll } from '../types/world.js';

/**
 * ⭐ ГЛАВНЫЙ ТЕСТ ВСЕЙ ЗАТЕИ — правило Р1 из docs/ECONOMY.md: суммарная частота НАГРАД
 * не падает, меняется только их ВИД. Если после правки доля «пустых» убийств вырастет,
 * мы повторим ошибку PoE 2, и никакие материалы этого не искупят.
 */

/** Детерминированный бросок: берём середину диапазона — тест не должен зависеть от везения. */
const midRng = { int: (lo: number, hi: number) => Math.floor((lo + hi) / 2) };
const maxRng = { int: (_lo: number, hi: number) => hi };

const roll = (gearId: string): MonsterGearRoll =>
  ({ slot: 'weapon', gearId, name: gearId, rarity: 'normal', affixes: [], mods: [], base: {} });

const GEAR: Record<string, SalvageableGear> = {
  axe: { id: 'axe', salvageTo: [{ materialId: 'iron-1', min: 1, max: 2 }, { materialId: 'wood-1', min: 1, max: 1 }] },
  rag: { id: 'rag' },                                    // без salvageTo — молча ничего не даёт
  mail: { id: 'mail', salvageTo: [{ materialId: 'plate-1', min: 2, max: 3 }] },
};
const byId = (id: string): SalvageableGear | undefined => GEAR[id];

describe('материалы с надетого снаряжения', () => {
  it('материалы берутся ИМЕННО из того, что на монстре надето', () => {
    expect(salvageFromMonster([roll('axe')], byId, maxRng)).toEqual({ 'iron-1': 2, 'wood-1': 1 });
    expect(salvageFromMonster([roll('mail')], byId, maxRng)).toEqual({ 'plate-1': 3 });
  });

  it('вещь без salvageTo не роняет ничего и не ломает расчёт', () => {
    expect(salvageFromMonster([roll('rag')], byId, maxRng)).toEqual({});
  });

  it('нет снаряжения вообще — пустой результат, а не исключение', () => {
    expect(salvageFromMonster(undefined, byId, maxRng)).toEqual({});
    expect(salvageFromMonster([], byId, maxRng)).toEqual({});
  });

  it('⚠ падает НЕ ВЕСЬ гир: с обычного одна вещь, с уникального две', () => {
    const worn = [roll('axe'), roll('mail'), roll('axe'), roll('mail')];
    expect(salvageFromMonster(worn, byId, maxRng, { rarity: 'normal' })).toEqual({ 'iron-1': 2, 'wood-1': 1 });
    const uniq = salvageFromMonster(worn, byId, maxRng, { rarity: 'unique' });
    expect(uniq).toEqual({ 'iron-1': 2, 'wood-1': 1, 'plate-1': 3 });
  });

  it('редкость задаёт число вещей, и оно не превышает надетого', () => {
    expect(piecesDropped('normal', maxRng)).toBe(1);
    expect(piecesDropped('rare', maxRng)).toBe(2);
    expect(piecesDropped('unique', maxRng)).toBe(2);
    // у монстра надета одна вещь — уникальный не выжмет из неё две
    expect(salvageFromMonster([roll('mail')], byId, maxRng, { rarity: 'unique' })).toEqual({ 'plate-1': 3 });
  });

  it('одинаковые материалы с разных вещей складываются', () => {
    expect(salvageFromMonster([roll('axe'), roll('axe')], byId, maxRng, { rarity: 'unique' }))
      .toEqual({ 'iron-1': 4, 'wood-1': 2 });
  });
});

describe('ступень материала растёт с глубиной', () => {
  const known = (id: string): boolean => ['iron-1', 'iron-2', 'iron-3'].includes(id);

  it('сдвиг поднимает ступень', () => {
    expect(shiftTier('iron-1', 1, known)).toBe('iron-2');
    expect(shiftTier('iron-1', 2, known)).toBe('iron-3');
  });

  it('⚠ прыжок за потолок СПУСКАЕТСЯ до верхней ступени, а не падает к первой', () => {
    // Иначе глубина 24+ роняла бы iron-1 — хуже, чем глубина 16.
    expect(shiftTier('iron-1', 5, known)).toBe('iron-3');
    expect(shiftTier('iron-3', 1, known)).toBe('iron-3');
    expect(shiftTier('strange', 1, () => false)).toBe('strange');
  });

  it('без сдвига и на странном id ничего не портится', () => {
    expect(shiftTier('iron-1', 0, known)).toBe('iron-1');
    expect(shiftTier('strange', 1, known)).toBe('strange');
  });
});

describe('⭐ ПРАВИЛО №1: убийство продолжает платить', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const loot = reg.get('balance').loot;

  it('вещь осталась РЕДКОЙ наградой, а не вернулась к прежним 55 %', () => {
    // ⚠ Точное значение НЕ пиним: это ручка баланса, и тест, прибитый к 0.1, ломался бы на
    // каждой правке, ничего при этом не охраняя. Охраняем смысл: вещь — событие, а не рутина.
    expect(loot.dropChance).toBeLessThan(0.25);
    expect(loot.dropChance).toBeGreaterThan(0);
  });

  it('⭐ доля убийств хоть с какой-то наградой не упала', () => {
    // События независимы: шанс «ничего» = (1−вещь)·(1−материалы)·(1−золото).
    // ⚠ ЗОЛОТО ВХОДИТ В СЧЁТ. Когда тест писался, монета начислялась телепортом и наградой
    // на земле не была; теперь она падает как всё остальное, и считать её отдельно — значит
    // занижать реальную плату за убийство.
    const nothing = (1 - loot.dropChance) * (1 - loot.materials.chance) * (1 - loot.goldChance);
    expect(1 - nothing).toBeGreaterThan(0.55);
  });

  it('⚠ частоту сырья срезали, но не приход: количество за дроп подняли множителем', () => {
    // Иначе «реже» означало бы «беднее», и вся лестница улучшений поехала бы молча.
    expect(loot.materials.chance).toBeLessThan(0.6);
    expect(loot.materials.chance * loot.materials.mult).toBeGreaterThanOrEqual(0.55);
  });

  it('всё снаряжение монстров умеет разбираться — иначе часть убийств пустая', () => {
    const gear = reg.get('monster-gear');
    const mats = new Set(reg.get('craft-materials').map((c) => c.id));
    expect(gear.length).toBeGreaterThan(0);
    for (const g of gear) {
      expect(g.salvageTo, `${g.id} без salvageTo`).toBeTruthy();
      expect(g.salvageTo!.length).toBeGreaterThan(0);
      for (const y of g.salvageTo!) {
        expect(mats.has(y.materialId), `${g.id} → неизвестный материал ${y.materialId}`).toBe(true);
        expect(y.min).toBeLessThanOrEqual(y.max);
      }
    }
  });

  it('на реальном конфиге зомби с топором даёт железо и дерево', () => {
    const byGear = (id: string): SalvageableGear | undefined => reg.get('monster-gear').find((g) => g.id === id);
    const got = salvageFromMonster([roll('u-axe1h')], byGear, midRng);
    expect(Object.keys(got).sort()).toEqual(['iron-1', 'wood-1']);
  });
});

describe('⭐ разбор вещи: поле дешевле, кузница полнее', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const rules = reg.get('salvage-rules');
  const tuning = reg.get('balance').salvage;

  /** Щедрый детерминированный бросок: верх диапазона и остаток всегда в плюс. */
  const rich = { int: (_lo: number, hi: number) => hi, chance: () => true };
  const item = (over: Partial<SalvageableItem> = {}): SalvageableItem =>
    ({ kind: 'weapon', rarity: 'normal', itemLevel: 1, ...over });

  it('правило находится по классу оружия, а класс берётся с БАЗЫ', () => {
    expect(salvageRuleFor(item(), 'axe', rules)?.id).toBe('w-axe');
    expect(salvageRuleFor(item(), 'bow', rules)?.id).toBe('w-bow');
    // класс не передан — ни одно оружейное правило не подходит
    expect(salvageRuleFor(item(), undefined, rules)).toBeUndefined();
  });

  it('правило брони — по классу, а количество правит слот', () => {
    const chest = item({ kind: 'armor', slot: 'chest', armorClass: 'plate' });
    const gloves = item({ kind: 'armor', slot: 'gloves', armorClass: 'plate' });
    expect(salvageRuleFor(chest, undefined, rules)?.id).toBe('a-plate');
    expect(salvageMult(chest, tuning, false)).toBeGreaterThan(salvageMult(gloves, tuning, false));
  });

  it('⭐ ГЛАВНОЕ: в поле выходит МЕНЬШЕ, чем у кузнеца, но не ноль', () => {
    const axe = item({ itemLevel: 1 });
    const forge = salvageFromItem(axe, 'axe', rules, tuning, rich, {});
    const field = salvageFromItem(axe, 'axe', rules, tuning, rich, { inField: true });
    const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
    expect(sum(forge)).toBeGreaterThan(sum(field));
    expect(sum(field)).toBeGreaterThan(0); // иначе нести было бы незачем... и разбирать тоже
  });

  it('⚠ уникальные не разбираются НИГДЕ — нашёл как есть (решение В2)', () => {
    const uniq = item({ rarity: 'unique' });
    expect(canSalvage(uniq, 'axe', rules, tuning, false).ok).toBe(false);
    expect(canSalvage(uniq, 'axe', rules, tuning, true).ok).toBe(false);
    expect(salvageFromItem(uniq, 'axe', rules, tuning, rich, {})).toEqual({});
  });

  it('⚠ СКОВАННОЕ путём «по редкости» не разбирается нигде — только переплавка (иначе прачечная)', () => {
    const forged = { ...item({ rarity: 'rare' }), parts: { strike: { id: 'x', step: 1 } } };
    expect(canSalvage(forged, 'axe', rules, tuning, false).ok).toBe(false);
    expect(canSalvage(forged, 'axe', rules, tuning, true).ok).toBe(false);
    expect(salvageFromItem(forged, 'axe', rules, tuning, rich, {})).toEqual({});
  });

  it('⚠ вещь без правила не разбирается — иначе разбор съел бы её впустую', () => {
    const potion = item({ kind: 'consumable' });
    expect(canSalvage(potion, undefined, rules, tuning, false).ok).toBe(false);
  });

  it('⭐ редкость задаёт СТУПЕНЬ материала, а не количество', () => {
    const known = { knownMaterial: (id: string) => reg.get('craft-materials').some((c) => c.id === id) };
    const white = salvageFromItem(item({ rarity: 'normal' }), 'sword', rules, tuning, rich, known);
    const blue = salvageFromItem(item({ rarity: 'magic' }), 'sword', rules, tuning, rich, known);
    const yellow = salvageFromItem(item({ rarity: 'rare' }), 'sword', rules, tuning, rich, known);
    expect(Object.keys(white)).toEqual(['iron-1']);
    expect(Object.keys(blue)).toEqual(['iron-2']);
    expect(Object.keys(yellow)).toEqual(['iron-3']);
    // ⚠ количество ОДИНАКОВОЕ: дай редкости ещё и его — разбирать стало бы выгоднее, чем носить
    expect(white['iron-1']).toBe(yellow['iron-3']);
  });

  it('уровень вещи на ступень больше НЕ влияет — только редкость', () => {
    const known = { knownMaterial: (id: string) => reg.get('craft-materials').some((c) => c.id === id) };
    const low = salvageFromItem(item({ itemLevel: 1 }), 'sword', rules, tuning, rich, known);
    const high = salvageFromItem(item({ itemLevel: 99 }), 'sword', rules, tuning, rich, known);
    expect(high).toEqual(low);
  });

  it('⭐ с монстра ступень берёт редкость КОНКРЕТНОЙ надетой вещи', () => {
    const byGear = (id: string): SalvageableGear | undefined => reg.get('monster-gear').find((g) => g.id === id);
    const worn = (rarity: string): MonsterGearRoll =>
      ({ slot: 'weapon', gearId: 'u-sword1h', name: 'меч', rarity, affixes: [], mods: [], base: {} } as MonsterGearRoll);
    const opt = { rarityTier: tuning.rarityTier, knownMaterial: (id: string) => reg.get('craft-materials').some((c) => c.id === id) };
    // Меч даёт железо клинка и прибор гарды (F2) — ОБА на ступени редкости этой вещи.
    for (const [rarity, step] of [['normal', 1], ['magic', 2], ['rare', 3]] as const) {
      expect(Object.keys(salvageFromMonster([worn(rarity)], byGear, maxRng, opt)).sort(), rarity).toEqual([`iron-${step}`, `trim-${step}`]);
    }
  });

  it('⚠ у редкого монстра прокачан НЕ ВЕСЬ гир: ржавая броня даёт ржавое', () => {
    const byGear = (id: string): SalvageableGear | undefined => reg.get('monster-gear').find((g) => g.id === id);
    const rolls = [
      { slot: 'weapon', gearId: 'u-sword1h', name: 'меч', rarity: 'rare', affixes: [], mods: [], base: {} },
      { slot: 'armor', gearId: 'u-chain', name: 'кольчуга', rarity: 'normal', affixes: [], mods: [], base: {} },
    ] as MonsterGearRoll[];
    const got = salvageFromMonster(rolls, byGear, maxRng, {
      rarity: 'unique', // две вещи разбираются
      rarityTier: tuning.rarityTier,
      knownMaterial: (id) => reg.get('craft-materials').some((c) => c.id === id),
    });
    // ⚠ Проверяем ПРАВИЛО (ступень берётся с конкретной вещи), а не список выходов: у доспеха их
    // несколько (пластины + поддоспешник), и список меняется при правке данных, а правило — нет.
    const keys = Object.keys(got);
    expect(keys, 'меч редкий → калёная сталь').toContain('iron-3');
    expect(keys, 'меч редкий → и прибор гарды его ступени').toContain('trim-3');
    expect(keys, 'кольчуга обычная → ржавые пластины').toContain('plate-1');
    expect(keys.filter((k) => !k.startsWith('iron') && !k.startsWith('trim')).every((k) => k.endsWith('-1')),
      'всё бронное с обычной вещи — первой ступени').toBe(true);
  });

  it('дробный выход округляется вероятностно: не «всегда ноль» и не «всегда единица»', () => {
    const one = { kind: 'weapon', rarity: 'normal', itemLevel: 1 } as SalvageableItem;
    const never = { int: (_lo: number, hi: number) => hi, chance: () => false };
    const always = { int: (_lo: number, hi: number) => hi, chance: () => true };
    // 3 доски × 0.3 = 0.9 → целая часть 0, остаток 0.9 решает бросок
    expect(salvageFromItem(one, 'wand', rules, tuning, never, { inField: true })).toEqual({});
    expect(salvageFromItem(one, 'wand', rules, tuning, always, { inField: true })['wood-1']).toBe(1);
  });

  it('все правила ссылаются на существующие материалы и осмысленный диапазон', () => {
    const mats = new Set(reg.get('craft-materials').map((c) => c.id));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.yields.length, `${r.id} без выхода`).toBeGreaterThan(0);
      for (const y of r.yields) {
        expect(mats.has(y.materialId), `${r.id} → неизвестный материал ${y.materialId}`).toBe(true);
        expect(y.min).toBeLessThanOrEqual(y.max);
      }
    }
  });

  it('у КАЖДОГО носимого предмета из конфига есть чем разбираться', () => {
    for (const b of reg.get('items.base')) {
      if (b.kind === 'consumable') continue; // зелья не разбираются, и это нормально
      const it: SalvageableItem = { kind: b.kind, slot: b.slot, rarity: 'normal', itemLevel: 1,
        armorClass: b.kind === 'armor' ? b.armorClass : undefined };
      const wc = b.kind === 'weapon' ? b.weaponClass : undefined;
      expect(salvageRuleFor(it, wc, rules)?.yields?.length ?? 0, `${b.id} нечем разбирать`).toBeGreaterThan(0);
    }
  });
});
