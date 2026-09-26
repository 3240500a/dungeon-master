import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { newBotSave } from '../sim/playerBot.js';
import { materialItem } from './materials.js';
import { applyDeathPenalty } from './death.js';
import type { Item } from '../types/items.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
const PENALTY = { goldPercent: 0.25, inventoryDropPercent: 0.3, materialStackLossPercent: 0.5 };
const IRON = { id: 'iron-1', name: 'Ржавое железо', family: 'iron', tier: 1 };

describe('applyDeathPenalty (штраф смерти, авторитетно над save)', () => {
  it('списывает долю золота и часть инвентаря; экипировку сохраняет', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.gold = 1000;
    const weapon = save.equipment.weapon!;
    for (let i = 0; i < 10; i++) save.inventory.push({ ...weapon, uid: `inv${i}` });
    const equipBefore = { ...save.equipment };

    const res = applyDeathPenalty(save, PENALTY, createRng(1));

    expect(res.goldLost).toBe(250);
    expect(save.gold).toBe(750);
    expect(res.itemsLost).toBe(3); // floor(10 * 0.3)
    expect(save.inventory.length).toBe(7);
    expect(save.equipment).toEqual(equipBefore); // экипировка не теряется
  });

  it('0% штраф — ничего не теряется', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.gold = 500;
    const res = applyDeathPenalty(save, { ...PENALTY, goldPercent: 0, inventoryDropPercent: 0 }, createRng(1));
    expect(res).toEqual({ goldLost: 0, itemsLost: 0, materialsLost: 0 });
    expect(save.gold).toBe(500);
  });

  it('⭐ стек сырья теряет ПОЛОВИНУ, а не пропадает целиком', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.inventory = [materialItem(IRON, 800, 'm1')];
    const res = applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 1 }, createRng(1));
    expect(save.inventory).toHaveLength(1);          // стек остался
    expect(save.inventory[0]!.count).toBe(400);      // но похудел вдвое
    expect(res.materialsLost).toBe(400);
    expect(res.itemsLost).toBe(0);                   // стек — не «потерянный предмет»
  });

  it('⚠ жертвы выбираются СЛУЧАЙНО, а не «первые по списку»', () => {
    const r = reg();
    const survivors = new Set<string>();
    // Прежний `splice(0, N)` всегда съедал первые — тогда uid «i0» не выжил бы НИ РАЗУ.
    for (let seed = 1; seed <= 40; seed++) {
      const save = newBotSave(r, 'warrior');
      const weapon = save.equipment.weapon!;
      save.inventory = Array.from({ length: 6 }, (_, i) => ({ ...weapon, uid: `i${i}` } as Item));
      applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 0.5 }, createRng(seed));
      for (const it of save.inventory) survivors.add(it.uid);
    }
    expect(survivors.has('i0')).toBe(true);
    expect(survivors.size).toBe(6);                  // за 40 смертей выживал каждый
  });

  it('⚠ доля теряемого сырья настраивается и считается от КАЖДОГО стека', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.inventory = [materialItem(IRON, 100, 'a'), materialItem({ ...IRON, id: 'wood-1' }, 40, 'b')];
    const res = applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 1, materialStackLossPercent: 0.25 }, createRng(3));
    expect(res.materialsLost).toBe(35);              // 25 + 10
    expect(save.inventory.map((i) => i.count).sort((x, y) => (y ?? 0) - (x ?? 0))).toEqual([75, 30]);
  });

  it('⚠ маленький стек теряет хотя бы единицу, а не ноль от округления', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.inventory = [materialItem(IRON, 1, 'a')];
    const res = applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 1 }, createRng(1));
    expect(res.materialsLost).toBe(1);
    expect(save.inventory).toHaveLength(0);          // стек кончился — ушёл из сумки
  });
});

/**
 * ⚠ R5-21: ДОЛЯ ПОТЕРЬ ОКРУГЛЯЕТСЯ БРОСКОМ, А НЕ ВНИЗ. `floor(n × доля)` при доле 0.5 оставлял сумку из одной вещи без
 * риска вовсе (0 потерь), из трёх — с потерей одной (33 %), из пяти — двух (40 %): нечётная сумка всегда теряла меньше
 * настроенного, а одна ценная находка в пустой сумке переносилась через смерть бесплатно.
 */
describe('⚠ R5-21: потери смерти — настроенная доля при любом размере сумки', () => {
  const r = reg();
  const PEN = { goldPercent: 0, inventoryDropPercent: 0.5, materialStackLossPercent: 0.5 };
  function bag(n: number) {
    const save = newBotSave(r, 'warrior');
    const weapon = save.equipment.weapon!;
    save.inventory = Array.from({ length: n }, (_, i) => ({ ...weapon, uid: `b${i}` } as Item));
    return save;
  }

  it('⭐ одна вещь в сумке теряется в половине смертей (±3 %), а не никогда', () => {
    let lost = 0;
    for (let seed = 1; seed <= 2000; seed++) lost += applyDeathPenalty(bag(1), PEN, createRng(seed)).itemsLost;
    expect(lost / 2000).toBeGreaterThan(0.47);
    expect(lost / 2000).toBeLessThan(0.53);
  });

  it('⭐ из трёх вещей в среднем теряется полторы (а не ровно одна); чётная сумка — ровно половина', () => {
    let lost = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const n = applyDeathPenalty(bag(3), PEN, createRng(seed)).itemsLost;
      expect([1, 2]).toContain(n);
      lost += n;
    }
    expect(lost / 2000).toBeGreaterThan(1.45);
    expect(lost / 2000).toBeLessThan(1.55);
    for (let seed = 1; seed <= 50; seed++) expect(applyDeathPenalty(bag(4), PEN, createRng(seed)).itemsLost).toBe(2);
  });

  it('тот же сид — те же потери (детерминизм для записи и сима)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const a = bag(5), b = bag(5);
      expect(applyDeathPenalty(a, PEN, createRng(seed))).toEqual(applyDeathPenalty(b, PEN, createRng(seed)));
      expect(a.inventory.map((i) => i.uid)).toEqual(b.inventory.map((i) => i.uid));
    }
  });
});
