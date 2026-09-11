import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { salvageFromMonster, piecesDropped, shiftTier, type SalvageableGear } from './salvage.js';
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

  it('⚠ несуществующая ступень НЕ выдаётся — иначе материал молча пропал бы', () => {
    expect(shiftTier('iron-1', 5, known)).toBe('iron-1');
    expect(shiftTier('iron-3', 1, known)).toBe('iron-3');
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

  it('вещь стала редкой, но материалы заняли её место', () => {
    expect(loot.dropChance).toBeCloseTo(0.1, 5);
    expect(loot.materials.chance).toBeGreaterThanOrEqual(0.55);
  });

  it('доля убийств хоть с какой-то наградой осталась прежней (~0.6), а не упала к 0.1', () => {
    // события независимы: шанс «ничего» = (1−вещь)·(1−материалы)
    const nothing = (1 - loot.dropChance) * (1 - loot.materials.chance);
    const withReward = 1 - nothing;
    expect(withReward).toBeGreaterThan(0.55);
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
