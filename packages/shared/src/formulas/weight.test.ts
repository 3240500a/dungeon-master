import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { playerWeight, type WeightTables } from './stats.js';
import type { Item, SaveState } from '../types/index.js';

const r = (() => { const x = new ConfigRegistry(); x.loadAll(); return x; })();
const bal = r.get('balance');
const wt: WeightTables = {
  base: bal.weight.base,
  shield: bal.weight.shield,
  armorClasses: r.get('armor-classes'),
  weaponWeights: r.get('weapon-weights'),
};

let uid = 0;
function item(p: Partial<Item>): Item {
  return { uid: `u${uid++}`, baseId: 'b', name: 'x', rarity: 'normal', itemLevel: 1, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, ...p };
}
const save = (equipment: SaveState['equipment']): SaveState => ({ equipment } as unknown as SaveState);

describe('playerWeight', () => {
  it('без экипировки = база', () => {
    expect(playerWeight(save({}), wt)).toBe(bal.weight.base);
  });

  it('тяжёлая броня + тяжёлый щит тяжелее лёгких', () => {
    const heavy = save({ chest: item({ kind: 'armor', armorClass: 'plate' }), offhand: item({ kind: 'shield', shieldClass: 'heavy' }) });
    const light = save({ chest: item({ kind: 'armor', armorClass: 'leather' }), offhand: item({ kind: 'shield', shieldClass: 'light' }) });
    expect(playerWeight(heavy, wt)).toBeGreaterThan(playerWeight(light, wt));
  });

  it('вес оружия добавляется из weapon-weights', () => {
    const heavyW = r.get('weapon-weights').find((w) => w.id === 'heavy')!.weight;
    expect(playerWeight(save({ weapon: item({ kind: 'weapon', weight: 'heavy' }) }), wt)).toBe(bal.weight.base + heavyW);
  });
});
