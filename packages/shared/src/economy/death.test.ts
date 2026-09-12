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
