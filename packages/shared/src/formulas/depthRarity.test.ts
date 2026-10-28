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

  it('⭐⭐ 13.10 (Г2): кривая начинается НЕ РАНЬШЕ прежнего дна мира (15) — тот контент не тронут, глубже она живая', () => {
    // До Г2 забег кончался на 15-м этаже (`length.max` самого длинного шаблона + финал), и «задел под бесконечный
    // забег» не действовал нигде. Шаблоны потеряли длину (спуск бесконечен), сравнивать стало не с чем — порог
    // держим числом: мельче 15-го этажа множитель обязан быть ровно 1, иначе правка кривой тихо изменит ВЕСЬ
    // нынешний контент, а не только бездну за ним.
    const PRE_G2_WORLD = 15;
    expect(C.freeDepth, 'кривая не смеет начинаться внутри прежнего мира').toBeGreaterThanOrEqual(PRE_G2_WORLD);
    expect(depthRarityBoost(PRE_G2_WORLD, C)).toBe(1);
    // А за порогом она теперь ДОСТИЖИМА (в этом и смысл Г2): буст есть и растёт.
    expect(depthRarityBoost(C.freeDepth + C.step, C)).toBeGreaterThan(1);
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
