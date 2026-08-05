import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { schemeRequirements } from './itemReq.js';

const reg = new ConfigRegistry(); reg.loadAll();
const ww = reg.get('weapon-weights'); const ac = reg.get('armor-classes');
const t2h = reg.get('balance').twoHandReqMult; // как в игре — из конфига (1.5)
const r = (b: Parameters<typeof schemeRequirements>[0]): ReturnType<typeof schemeRequirements> => schemeRequirements(b, ww, ac, t2h);

describe('schemeRequirements — авто-требования по весу/классу', () => {
  it('оружие: атрибут по долям weapon-weights, магнитуда reqBase (одноатр.18/двухатр.35), 2H ×1.5', () => {
    expect(r({ kind: 'weapon', weight: 'superlight', hands: 1 })).toEqual({ dexterity: 18 }); // reqBase 18, доля dex 1.0
    expect(r({ kind: 'weapon', weight: 'heavy', hands: 2 })).toEqual({ strength: 27 }); // 18×1.5, доля str 1.0
    expect(r({ kind: 'weapon', weight: 'magical', hands: 2 })).toEqual({ intelligence: 27 }); // 18×1.5, доля int 1.0
    const light = r({ kind: 'weapon', weight: 'light', hands: 1 }); // двухатрибутное reqBase 35
    expect(light.dexterity ?? 0).toBeGreaterThan(light.strength ?? 0); // лёгкое = ловк + чуть силы
    // twoHandMult (из balance.twoHandReqMult) масштабирует 2H: reqBase 18 × 2 = 36.
    expect(schemeRequirements({ kind: 'weapon', weight: 'heavy', hands: 2 }, ww, ac, 2)).toEqual({ strength: 36 });
  });

  it('броня: кольчуга 50/50, сегментная 75/25, лёгкая — чистая ловк, стёганая — свободна', () => {
    const chain = r({ kind: 'armor', armorClass: 'chain', slot: 'chest' });
    expect(chain.strength).toBe(chain.dexterity); // 50/50
    const seg = r({ kind: 'armor', armorClass: 'segmented', slot: 'chest' });
    expect(seg.strength! / (seg.strength! + seg.dexterity!)).toBeCloseTo(0.75, 1);
    expect(r({ kind: 'armor', armorClass: 'plate', slot: 'chest' })).toEqual({ strength: 18 }); // сила (одноатр.)
    expect(r({ kind: 'armor', armorClass: 'leather', slot: 'chest' })).toEqual({ dexterity: 18 }); // лёгкая = чистая ловк
    expect(r({ kind: 'armor', armorClass: 'quilted', slot: 'chest' })).toEqual({}); // ткань — без требований
  });

  it('щиты — по классу; слот брони масштабирует магнитуду', () => {
    expect(r({ kind: 'shield', shieldClass: 'light' })).toEqual({ dexterity: 12 });
    expect(r({ kind: 'shield', shieldClass: 'heavy' })).toEqual({ strength: 24 });
    const helm = r({ kind: 'armor', armorClass: 'plate', slot: 'helm' }); // 18×0.8 = 14.4
    expect(helm.strength).toBe(14);
  });
});
