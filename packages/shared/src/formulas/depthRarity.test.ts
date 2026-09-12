import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { depthRarityBoost, rarityAtDepth, type DepthRarity } from './spawnWeight.js';

/**
 * ГЛУБИНА → РЕДКОСТЬ МОНСТРОВ — задел под бесконечный забег.
 *
 * Два правила: обычные забеги не должны почувствовать вообще ничего, а бесконечный не должен
 * стать фермой (буст обязан упереться). Ступень сырья и качество трофеев едут за редкостью
 * по уже существующему правилу — своего пути у глубины нет намеренно.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const C: DepthRarity = reg.get('balance').loot.depthRarity;

describe('depthRarityBoost', () => {
  it('⭐ обычные забеги НЕ ТРОНУТЫ: до freeDepth множитель ровно 1', () => {
    for (let d = 0; d <= C.freeDepth; d++) expect(depthRarityBoost(d, C)).toBe(1);
  });

  it('самый длинный шаблон забега не достаёт до кривой', () => {
    const maxLen = Math.max(...reg.get('run-templates').filter((t) => t.enabled !== false).map((t) => t.length.max));
    expect(maxLen).toBeLessThanOrEqual(C.freeDepth);   // иначе правка тихо изменит текущий контент
  });

  it('глубже — больше, но с затуханием', () => {
    // ⚠ Шаги обязаны быть РАВНОЙ ширины: сравнивать прирост за 70 этажей с приростом за 100 —
    // значит мерить не затухание, а длину интервала (на этом тест и падал первым заходом).
    const at = (d: number): number => depthRarityBoost(d, C);
    const step = 60;
    const d0 = C.freeDepth + 10;
    const g1 = at(d0 + step) - at(d0);
    const g2 = at(d0 + step * 2) - at(d0 + step);
    expect(at(d0)).toBeGreaterThan(1);
    expect(g1).toBeGreaterThan(0);
    expect(g2).toBeGreaterThan(0);
    expect(g2).toBeLessThan(g1);                       // тот же шаг глубже даёт меньше
  });

  it('⚠ упирается в потолок и дальше не растёт НИКОГДА', () => {
    const cap = 1 + C.maxBoost;
    for (const d of [400, 1000, 100000]) expect(depthRarityBoost(d, C)).toBeLessThanOrEqual(cap);
    expect(depthRarityBoost(100000, C)).toBeCloseTo(depthRarityBoost(400, C), 5);
  });
});

describe('rarityAtDepth', () => {
  const BASE = { magic: 0.12, rare: 0.03 };

  it('на малой глубине отдаёт исходные шансы пачки', () => {
    const r = rarityAtDepth(BASE.magic, BASE.rare, 5, C);
    expect(r.magic).toBeCloseTo(BASE.magic, 5);
    expect(r.rare).toBeCloseTo(BASE.rare, 5);
  });

  it('глубже — чаще магические и редкие', () => {
    const r = rarityAtDepth(BASE.magic, BASE.rare, 200, C);
    expect(r.magic).toBeGreaterThan(BASE.magic * 3);
    expect(r.rare).toBeGreaterThan(BASE.rare * 3);
  });

  it('⚠ обычные монстры не вымирают — иначе умрёт и НИЖНЯЯ ступень сырья', () => {
    for (const d of [200, 1000, 100000]) {
      const r = rarityAtDepth(BASE.magic, BASE.rare, d, C);
      expect(r.magic + r.rare).toBeLessThan(1);
      expect(1 - r.magic - r.rare).toBeGreaterThanOrEqual(C.minNormal - 1e-9);
      expect(r.rare).toBeLessThanOrEqual(C.maxRare);
    }
  });

  it('нулевой шанс в пачке нулём и остаётся (буст ничего не создаёт из воздуха)', () => {
    const r = rarityAtDepth(0, 0, 1000, C);
    expect(r.magic).toBe(0);
    expect(r.rare).toBe(0);
  });
});
