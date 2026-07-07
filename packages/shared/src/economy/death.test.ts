import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newBotSave } from '../sim/playerBot.js';
import { applyDeathPenalty } from './death.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

describe('applyDeathPenalty (штраф смерти, авторитетно над save)', () => {
  it('списывает долю золота и часть инвентаря; экипировку сохраняет', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.gold = 1000;
    const weapon = save.equipment.weapon!;
    for (let i = 0; i < 10; i++) save.inventory.push({ ...weapon, uid: `inv${i}` });
    const equipBefore = { ...save.equipment };

    const res = applyDeathPenalty(save, { goldPercent: 0.25, inventoryDropPercent: 0.3 });

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
    const res = applyDeathPenalty(save, { goldPercent: 0, inventoryDropPercent: 0 });
    expect(res).toEqual({ goldLost: 0, itemsLost: 0 });
    expect(save.gold).toBe(500);
  });
});
