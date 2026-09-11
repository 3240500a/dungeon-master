import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  addMaterials, canAfford, spendMaterials, missingFor, materialCount, totalMaterials, walletOf,
} from './materials.js';
import type { SaveState } from '../types/save.js';

/**
 * Кошелёк материалов маленький, но у него три свойства, которые нельзя терять:
 *  • списание АТОМАРНО — иначе неудачный крафт съедает ресурсы и ничего не даёт;
 *  • старый сейв без поля читается как пустой кошелёк, без миграции;
 *  • нули из карты уходят, иначе интерфейс покажет «Ржавое железо: 0» вечно.
 */

const save = (materials?: Record<string, number>): SaveState =>
  ({ materials } as unknown as SaveState);

describe('кошелёк материалов', () => {
  it('сейв без поля — пустой кошелёк, а не падение', () => {
    const s = save();
    expect(walletOf(s)).toEqual({});
    expect(materialCount(s, 'iron-1')).toBe(0);
    expect(totalMaterials(s)).toBe(0);
    expect(canAfford(s, {})).toBe(true);
  });

  it('начисление складывается, а не перезаписывает', () => {
    const s = save({ 'iron-1': 3 });
    addMaterials(s, { 'iron-1': 2, 'wood-1': 5 });
    expect(s.materials).toEqual({ 'iron-1': 5, 'wood-1': 5 });
  });

  it('приход НЕ умеет списывать: ноль и минус игнорируются', () => {
    const s = save({ 'iron-1': 3 });
    addMaterials(s, { 'iron-1': -10, 'wood-1': 0 });
    expect(s.materials).toEqual({ 'iron-1': 3 });
  });

  it('⭐ списание атомарно: не хватило одной позиции — не списано НИЧЕГО', () => {
    const s = save({ 'iron-1': 5, 'wood-1': 1 });
    expect(spendMaterials(s, { 'iron-1': 2, 'wood-1': 3 })).toBe(false);
    expect(s.materials).toEqual({ 'iron-1': 5, 'wood-1': 1 });
  });

  it('успешное списание уносит ровно запрошенное', () => {
    const s = save({ 'iron-1': 5, 'wood-1': 4 });
    expect(spendMaterials(s, { 'iron-1': 2, 'wood-1': 4 })).toBe(true);
    expect(s.materials).toEqual({ 'iron-1': 3 });   // wood-1 ушёл в ноль и удалён
  });

  it('нули не остаются в кошельке — иначе интерфейс покажет пустые строки', () => {
    const s = save({ 'iron-1': 2 });
    spendMaterials(s, { 'iron-1': 2 });
    expect(s.materials).toEqual({});
    expect(Object.keys(walletOf(s))).toHaveLength(0);
  });

  it('нехватка называется поимённо — отказ должен быть понятным', () => {
    const s = save({ 'iron-1': 1 });
    expect(missingFor(s, { 'iron-1': 4, 'plate-2': 2 })).toEqual({ 'iron-1': 3, 'plate-2': 2 });
    expect(missingFor(s, { 'iron-1': 1 })).toEqual({});
  });

  it('бесплатный крафт возможен: пустая стоимость списывается успешно', () => {
    const s = save({ 'iron-1': 1 });
    expect(spendMaterials(s, {})).toBe(true);
    expect(s.materials).toEqual({ 'iron-1': 1 });
  });
});

describe('секция конфига craft-materials', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();
  const mats = reg.get('craft-materials');

  it('15 базовых видов: 2 семьи на оружие × 3 тира + 3 семьи на броню × 3 тира', () => {
    expect(mats).toHaveLength(15);
    const byFamily = new Map<string, number>();
    for (const m of mats) byFamily.set(m.family, (byFamily.get(m.family) ?? 0) + 1);
    expect([...byFamily.keys()].sort()).toEqual(['cloth', 'hide', 'iron', 'plate', 'wood']);
    for (const [, n] of byFamily) expect(n).toBe(3);
  });

  it('у каждой семьи ровно три ступени 1-2-3 и растущая цена', () => {
    for (const fam of ['iron', 'wood', 'cloth', 'hide', 'plate']) {
      const tiers = mats.filter((m) => m.family === fam).sort((a, b) => a.tier - b.tier);
      expect(tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
      expect(tiers[0]!.sellPrice).toBeLessThan(tiers[2]!.sellPrice);
    }
  });

  it('id уникальны, иначе кошелёк схлопнет два материала в один', () => {
    expect(new Set(mats.map((m) => m.id)).size).toBe(mats.length);
  });

  it('⚠ продажа держится дешёвой: золото должно оставаться дефицитным', () => {
    for (const m of mats) expect(m.sellPrice).toBeLessThanOrEqual(12);
  });
});
