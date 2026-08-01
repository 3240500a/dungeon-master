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
    expect(rollAffixes(off, 3, 99, rng)).toEqual([]);
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
