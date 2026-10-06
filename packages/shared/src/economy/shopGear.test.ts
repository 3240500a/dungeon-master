import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { craftTiers, tierIndex } from '../formulas/craft.js';
import { rollShopGear, shopTierCap } from './shopGear.js';

/**
 * ⭐ ЛАВКА НЕ ВЫШЕ t4 (`balance.shop.maxTier`, предложение «Разбор, сырьё и чары» §8.1). Раньше прилавок с 76-го уровня выставлял t6
 * (≈ 1,5 штуки за завоз на 80-м), и «купить и разобрать» было краном сырья V. Сторож — по ИТОГОВОЙ ступени вещи на уровнях 1..100 (а не по
 * броску уровня ступени): база с `minTier` выше потолка иначе прошла бы мимо зажатого броска.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const regWith = (patch: (raw: Record<string, unknown>) => void): ConfigRegistry => {
  const r = new ConfigRegistry();
  r.loadAll();
  const raw: Record<string, unknown> = { balance: structuredClone(r.get('balance')), 'items.base': structuredClone(r.get('items.base')) };
  patch(raw);
  r.reload(raw as never);
  return r;
};
const idx = (r: ConfigRegistry, id: string | undefined): number => tierIndex(r, id);

describe('⭐ лавка не выше `balance.shop.maxTier` (§8.1)', () => {
  it('потолок по конфигу: t4, следующий порог — t5 (уровень ступени зажат под него)', () => {
    const cap = shopTierCap(reg);
    const tiers = craftTiers(reg);
    expect(cap.id).toBe('t4');
    expect(cap.index).toBe(tiers.findIndex((t) => t.id === 't4'));
    expect(cap.levelCap).toBe(tiers[cap.index + 1]!.minItemLevel - 1);
  });

  it('⭐ уровни 1..100 × несколько завозов: ни одной вещи на прилавке выше t4 (по итоговой ступени); t4 на глубине — есть', () => {
    const cap = shopTierCap(reg);
    let n = 0, atCap = 0;
    for (let level = 1; level <= 100; level++) {
      for (const seed of [1, 77, 4242]) {
        for (const it of rollShopGear(reg, seed * 1000 + level, level)) {
          n++;
          expect(idx(reg, it.tier), `ур.${level} «${it.baseId}» ${it.tier}`).toBeLessThanOrEqual(cap.index);
          expect(it.origin).toBe('shop');
          expect(it.rarity).not.toBe('unique');
          if (idx(reg, it.tier) === cap.index) atCap++;
        }
      }
    }
    expect(n).toBeGreaterThan(5000);
    expect(atCap, 'сторож не выродился: на глубине t4 продаётся').toBeGreaterThan(100);
  });

  it('⭐ база, что бывает только выше потолка (`minTier` t5), на прилавок не попадает вовсе; база «до t3» не выходит за свой потолок', () => {
    const r = regWith((raw) => {
      const bases = raw['items.base'] as { id: string; kind: string; minTier?: string; maxTier?: string; enabled?: boolean }[];
      const w = bases.filter((b) => b.kind === 'weapon' && b.enabled !== false);
      w[0]!.minTier = 't5';
      w[1]!.maxTier = 't3';
    });
    const bases = r.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
    const high = bases[0]!.id, low = bases[1]!.id;
    let lows = 0;
    for (let level = 1; level <= 100; level += 3) {
      for (const it of rollShopGear(r, level * 31, level)) {
        expect(it.baseId, `ур.${level}: база только t5+`).not.toBe(high);
        expect(idx(r, it.tier)).toBeLessThanOrEqual(shopTierCap(r).index);
        if (it.baseId === low) { lows++; expect(idx(r, it.tier)).toBeLessThanOrEqual(idx(r, 't3')); }
      }
    }
    expect(lows).toBeGreaterThan(0);
  });

  it('потолок поднят до t6 — прилавок прежний; ниже потолка бросок не меняется (зерно завоза и купленное остаются верными)', () => {
    const open = regWith((raw) => { (raw.balance as { shop: { maxTier: string } }).shop.maxTier = 't6'; });
    let higher = 0;
    for (const level of [1, 10, 25, 40]) {
      // На уровнях, где окно ступени не доходит до t5, вещи с потолком и без — одни и те же (кроме uid).
      const strip = (xs: ReturnType<typeof rollShopGear>): string => JSON.stringify(xs.map(({ uid: _u, ...rest }) => rest));
      expect(strip(rollShopGear(reg, 99 + level, level)), `ур.${level}`).toBe(strip(rollShopGear(open, 99 + level, level)));
    }
    for (let level = 70; level <= 100; level++) for (const it of rollShopGear(open, level, level)) if (idx(open, it.tier) > 4) higher++;
    expect(higher, 'без потолка на глубине t5–t6 бывают — потолок что-то держит').toBeGreaterThan(0);
  });

  it('⭐ ступени нет в конфиге (опечатка, переименование) — ЗАКРЫТО запасной ступенью, а не «без лимита»; реестр такой конфиг пускает', () => {
    // Прежде `null` — потолка нет: «T4» вместо «t4» проходил реестр (и с проверкой поверх таблиц), и прилавок на 90-м уровне выкладывал t6.
    for (const typo of ['T4', 'no-such-tier']) {
      const r = regWith((raw) => { (raw.balance as { shop: { maxTier: string } }).shop.maxTier = typo; });
      const cap = shopTierCap(r);
      expect(cap.fallback, typo).toBe(true);
      expect(cap.id, typo).toBe('t4');
      let n = 0;
      for (let level = 60; level <= 100; level += 5) {
        for (const seed of [1, 2, 3]) {
          for (const it of rollShopGear(r, seed * 1000 + level, level)) { n++; expect(idx(r, it.tier), `${typo} ур.${level} ${it.tier}`).toBeLessThanOrEqual(cap.index); }
        }
      }
      expect(n).toBeGreaterThan(0);
    }
    expect(shopTierCap(reg).fallback, 'свой потолок — не запасной').toBe(false);
  });

  it('⭐ нет ни потолка, ни запасной ступени (ступени переименованы) — нижняя ступень: лавка закрыта, а не открыта', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    const tiers = structuredClone(r.get('item-tiers')).map((t, i) => ({ ...t, id: `s${i}` }));
    const items = structuredClone(r.get('items.base')).map((b) => ({ ...b, minTier: 's0', maxTier: `s${tiers.length - 1}` }));
    r.reload({ 'item-tiers': tiers, 'items.base': items } as never);
    const cap = shopTierCap(r);
    expect(cap).toMatchObject({ fallback: true, index: 0, id: 's0' });
    for (const it of rollShopGear(r, 7, 90)) expect(idx(r, it.tier), it.tier).toBe(0);
  });
});
