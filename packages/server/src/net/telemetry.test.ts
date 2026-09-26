import { describe, it, expect } from 'vitest';
import { SessionTelemetry, forgeOpOf, tallyForge } from './telemetry.js';
import { counters } from './metrics.js';

/**
 * Телеметрия сессии (Ф3.2) и счётчики кузницы рядом с убийствами (K7, §22). Причина записи (D9) —
 * единственный вход: она уже различает переплавку скованного и разбор найденного.
 */
describe('SessionTelemetry: кузница рядом с killsPerHour', () => {
  it('причина записи → действие кузницы; не кузница — мимо', () => {
    expect(forgeOpOf('craft')).toBe('crafted');
    expect(forgeOpOf('melt')).toBe('melted');
    expect(forgeOpOf('salvage')).toBe('salvaged');
    expect(forgeOpOf('enchant')).toBe('enchanted');
    for (const other of ['forge', 'stash', 'autosave', '', 'craft ', 'CRAFT', '__proto__', 'constructor', 'toString']) {
      expect(forgeOpOf(other), other).toBeNull();
    }
  });

  it('tallyForge пишет и в сессию, и в /metrics; чужая причина не трогает ни то, ни другое', () => {
    const tm = new SessionTelemetry();
    const g0 = { ...counters };
    tallyForge(tm, 'craft');
    tallyForge(tm, 'craft');
    tallyForge(tm, 'melt');
    tallyForge(tm, 'salvage');
    tallyForge(tm, 'enchant');
    tallyForge(tm, 'forge');
    tallyForge(tm, 'stash');
    tallyForge(tm, '__proto__');
    expect({ c: tm.crafted, m: tm.melted, s: tm.salvaged, e: tm.enchanted }).toEqual({ c: 2, m: 1, s: 1, e: 1 });
    expect(counters.forgeCrafted - g0.forgeCrafted).toBe(2);
    expect(counters.forgeMelted - g0.forgeMelted).toBe(1);
    expect(counters.forgeSalvaged - g0.forgeSalvaged).toBe(1);
    expect(counters.forgeEnchanted - g0.forgeEnchanted).toBe(1);
    // Остальные счётчики не тронуты.
    for (const k of Object.keys(g0) as (keyof typeof counters)[]) {
      if (!k.startsWith('forge')) expect(counters[k], k).toBe(g0[k]);
    }
  });

  it('в час — те же единицы, что у убийств: делим на часы сессии, на первой минуте не на ноль', () => {
    const tm = new SessionTelemetry();
    const at = tm.startedAt + 30 * 60_000;   // полчаса
    tm.kills = 100;
    tm.crafted = 2; tm.melted = 1; tm.salvaged = 10; tm.enchanted = 1;
    const ph = tm.perHour(at);
    expect(ph.killsPerHour).toBeCloseTo(200);
    expect(ph.craftedPerHour).toBeCloseTo(4);
    expect(ph.meltedPerHour).toBeCloseTo(2);
    expect(ph.salvagedPerHour).toBeCloseTo(20);
    expect(ph.enchantedPerHour).toBeCloseTo(2);
    const early = tm.perHour(tm.startedAt);
    expect(Number.isFinite(early.craftedPerHour)).toBe(true);
  });
});
