import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { ESSENCE_FAMILY, ESSENCE_ID } from '../formulas/salvage.js';
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
  const all = reg.get('craft-materials');
  /** Сырьё — без эссенции: у неё своя семья и одна строка. */
  const mats = all.filter((m) => m.id !== ESSENCE_ID);

  it('восемь семей по пять сортов (docs/CRAFT_WEAPONS.md §10) и одна эссенция своей семьёй', () => {
    expect(mats).toHaveLength(40);
    const byFamily = new Map<string, number>();
    for (const m of mats) byFamily.set(m.family, (byFamily.get(m.family) ?? 0) + 1);
    expect([...byFamily.keys()].sort()).toEqual(['cloth', 'focus', 'hide', 'iron', 'plate', 'stave', 'trim', 'wood']);
    for (const [, n] of byFamily) expect(n).toBe(5);
    const ess = all.filter((m) => m.family === ESSENCE_FAMILY);
    expect(ess.map((m) => m.id)).toEqual([ESSENCE_ID]);
  });

  it('⭐ D4: у каждой семьи сорта 1…5, и ВСЕ продаются — дёшево: 1 · 2 · 5 · 10 · 15 (не дороже вещи, из которой вышли)', () => {
    for (const fam of new Set(mats.map((m) => m.family))) {
      const steps = mats.filter((m) => m.family === fam).sort((a, b) => a.tier - b.tier);
      expect(steps.map((t) => t.tier)).toEqual([1, 2, 3, 4, 5]);
      expect(steps.map((t) => t.sellPrice)).toEqual([1, 2, 5, 10, 15]);
    }
    // Эссенция тоже продаётся (решение D4), но дёшево: ценна она для чар, а не лавке.
    const ess = all.find((m) => m.id === ESSENCE_ID)!;
    expect(ess.sellPrice).toBeGreaterThan(0);
    expect(ess.sellPrice).toBeLessThanOrEqual(5);
  });

  it('⭐ в игре все 40 материалов и эссенция: разбор отдаёт все пять сортов (по ступени вещи), прибор, плечи, фокус', () => {
    // Раньше жили 15: склад рисовал три столбца «обычные / магические / редкие», и полки, которые ничто не
    // наполняет, были бы враньём. Разбор отдаёт сорт рецепта ступени вещи — им наполняются все пять сортов (D18, К2).
    expect(mats.filter((m) => m.enabled)).toHaveLength(40);
    expect(all.find((m) => m.id === ESSENCE_ID)?.enabled).toBe(true);
  });

  it('id уникальны, иначе кошелёк схлопнет два материала в один', () => {
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
  });

  it('⚠ продажа держится дешёвой: золото должно оставаться дефицитным', () => {
    for (const m of all) expect(m.sellPrice).toBeLessThanOrEqual(15);
    // Сорт с тел монстров — только первый: дорогие сорта даёт лишь разбор вещей высоких ступеней (сторож — `materialsLive.test.ts`).
    expect(reg.get('balance').salvage.nonFindMaxGrade, 'купленное — не выше III').toBeLessThanOrEqual(3);
  });
});
