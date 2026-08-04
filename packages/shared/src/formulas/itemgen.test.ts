import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { pickDropBase, generateItem, rollRarity, rollAffixes } from './itemgen.js';
import { createRng } from './rng.js';

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const bases = reg.get('items.base');
const affixes = reg.get('affixes');
const uniques = reg.get('uniques');
const rarities = reg.get('rarities');
const tiers = reg.get('item-tiers');

function distribution(weights: Record<string, number>, n: number): Record<string, number> {
  const rng = createRng(12345);
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const b = pickDropBase(bases, weights, rng);
    counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  }
  return counts;
}

describe('pickDropBase (взвешенный дроп по категориям)', () => {
  it('щиты выпадают при shield>0', () => {
    const d = distribution({ weapon: 10, armor: 10, shield: 40, jewelry: 5, consumable: 5 }, 3000);
    expect(d.shield ?? 0).toBeGreaterThan(0);
  });

  it('категория с весом 0 не выпадает', () => {
    const d = distribution({ weapon: 0, armor: 10, shield: 10, jewelry: 10, consumable: 0 }, 3000);
    expect(d.weapon ?? 0).toBe(0);
    expect(d.consumable ?? 0).toBe(0);
  });

  it('вес категории задаёт её долю', () => {
    const d = distribution({ weapon: 10, armor: 10, shield: 80, jewelry: 0, consumable: 0 }, 5000);
    const total = Object.values(d).reduce((s, n) => s + n, 0);
    expect((d.shield ?? 0) / total).toBeGreaterThan(0.5); // 80/100 ≈ 0.8
  });

  it('нулевые веса → фолбэк на равномерный (не падает)', () => {
    const d = distribution({}, 500);
    expect(Object.values(d).reduce((s, n) => s + n, 0)).toBe(500);
  });
});

describe('enabled-фильтры генерации (тумблер активно/неактивно)', () => {
  it('rollRarity: выключенная редкость не выпадает (порог пропускается)', () => {
    const rng = createRng(42);
    const noRare = rarities.map((r) => (r.id === 'rare' ? { ...r, enabled: false } : r));
    for (let i = 0; i < 4000; i++) expect(rollRarity(1.5, rng, noRare)).not.toBe('rare');
  });

  it('rollAffixes: все аффиксы выключены → пустой ролл', () => {
    const rng = createRng(7);
    const off = affixes.map((a) => ({ ...a, enabled: false }));
    const slots = { minAffixes: 3, maxAffixes: 3, maxPrefix: 3, maxSuffix: 3 };
    expect(rollAffixes(off, { kind: 'weapon', slot: 'weapon', attackType: 'melee', damageKind: 'physical' }, 'rare', slots, 99, rng)).toEqual([]);
  });

  describe('rollAffixes: правила D2', () => {
    const wpn = { kind: 'weapon', slot: 'weapon', attackType: 'melee', damageKind: 'physical' };
    const magic = { minAffixes: 2, maxAffixes: 2, maxPrefix: 1, maxSuffix: 1 };
    const rare = { minAffixes: 6, maxAffixes: 6, maxPrefix: 3, maxSuffix: 3 };
    const kindOf = (id: string): string => affixes.find((a) => a.id === id)?.kind ?? '';
    const counts = (r: ReturnType<typeof rollAffixes>): { p: number; s: number } => {
      const ids = new Set(r.map((a) => a.affixId));
      return { p: [...ids].filter((id) => kindOf(id) === 'prefix').length, s: [...ids].filter((id) => kindOf(id) === 'suffix').length };
    };

    it('лимиты префикс/суффикс: magic ≤1+≤1, rare ≤3+3', () => {
      const rng = createRng(11);
      for (let i = 0; i < 300; i++) {
        const m = counts(rollAffixes(affixes, wpn, 'magic', magic, 99, rng));
        expect(m.p).toBeLessThanOrEqual(1); expect(m.s).toBeLessThanOrEqual(1);
        const r = counts(rollAffixes(affixes, wpn, 'rare', rare, 99, rng));
        expect(r.p).toBeLessThanOrEqual(3); expect(r.s).toBeLessThanOrEqual(3);
      }
    });

    it('appliesTo: аффикс только для брони не падает на оружие', () => {
      const armorOnly = affixes.map((a) => (a.kind === 'prefix' ? { ...a, appliesTo: ['armor'] } : a));
      const rng = createRng(5);
      for (let i = 0; i < 100; i++) {
        const r = rollAffixes(armorOnly, wpn, 'rare', rare, 99, rng);
        expect(r.every((x) => armorOnly.find((a) => a.id === x.affixId)?.kind !== 'prefix')).toBe(true);
      }
    });

    it('группа: не больше одного аффикса из одной группы', () => {
      const grouped = affixes.map((a) => (a.kind === 'suffix' ? { ...a, group: 'g1' } : a));
      const rng = createRng(9);
      for (let i = 0; i < 100; i++) {
        const r = rollAffixes(grouped, wpn, 'rare', rare, 99, rng);
        const suf = new Set(r.filter((x) => grouped.find((a) => a.id === x.affixId)?.kind === 'suffix').map((x) => x.affixId));
        expect(suf.size).toBeLessThanOrEqual(1);
      }
    });

    it('имена D2: rare = два слова из пула rare-names', () => {
      const rng = createRng(42);
      const rareNames = reg.get('rare-names');
      let sawRare = false;
      for (let i = 0; i < 2000 && !sawRare; i++) {
        const item = generateItem(bases, affixes, uniques, { dropBias: 4, itemLevel: 40, tiers, rarities, rareNames }, rng);
        if (item.rarity === 'rare') {
          sawRare = true;
          const parts = item.name.split(' ');
          expect(parts).toHaveLength(2);
          expect(rareNames).toContain(parts[0]); expect(rareNames).toContain(parts[1]);
        }
      }
      expect(sawRare).toBe(true);
    });
  });

  it('generateItem: все уники выключены → редкость никогда не unique (даунгрейд до rare)', () => {
    const rng = createRng(3);
    const off = uniques.map((u) => ({ ...u, enabled: false }));
    for (let i = 0; i < 2000; i++) {
      const it = generateItem(bases, affixes, off,
        { dropBias: 50, itemLevel: 80, tiers, rarities, categoryWeights: { weapon: 100, armor: 0, shield: 0, jewelry: 0, consumable: 0 } }, rng);
      expect(it.rarity).not.toBe('unique');
    }
  });

  it('item-tiers: выключенный высший тир не выбирается (нет «Мифического» при отключённом t6)', () => {
    const cw = { weapon: 50, armor: 50, shield: 0, jewelry: 0, consumable: 0 };
    const namesFor = (ts: typeof tiers, seed: number): string => {
      const rng = createRng(seed);
      const s = new Set<string>();
      for (let i = 0; i < 500; i++) s.add(generateItem(bases, affixes, uniques, { dropBias: 1, itemLevel: 95, tiers: ts, rarities, categoryWeights: cw }, rng).name);
      return [...s].join('|');
    };
    expect(namesFor(tiers, 99)).toContain('Мифическ'); // t6 достижим при ilvl 95
    const noT6 = tiers.map((t) => (t.id === 't6' ? { ...t, enabled: false } : t));
    expect(namesFor(noT6, 99)).not.toContain('Мифическ'); // выключён → не выбирается
  });
});

describe('generateItem: колбы дропаются normal без аффиксов', () => {
  it('consumable-вес → выпадают колбы (normal, без аффиксов)', () => {
    const rng = createRng(777);
    let sawConsumable = false;
    for (let i = 0; i < 1500; i++) {
      const it = generateItem(bases, affixes, uniques,
        { dropBias: 1, itemLevel: 3, tiers, rarities, categoryWeights: { weapon: 0, armor: 0, shield: 0, jewelry: 0, consumable: 100 } }, rng);
      if (it.kind === 'consumable') { // (редкий рулон unique остаётся экипом — терпим)
        expect(it.rarity).toBe('normal');
        expect(it.affixes.length).toBe(0);
        sawConsumable = true;
      }
    }
    expect(sawConsumable).toBe(true);
  });
});
