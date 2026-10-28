import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { rewardScaleOf, rewardRolls } from './lootRate.js';
import { generateMonster } from './monstergen.js';
import { createRng } from './rng.js';
import { buildBotAt } from '../session/aggregate.js';
import { closedFormTtk } from '../sim/closedForm.js';
import { DEFAULT_BUILD } from '../sim/types.js';

/**
 * ⭐⭐ 13.10 ПОТОК НАГРАД НЕ ПРОСЕДАЕТ С ГЛУБИНОЙ (шаг 8 плана «Монстры: план по силе»).
 *
 * Решение владельца: «глубина так или иначе становится фармом, нужно просто сделать это интересным» —
 * значит спускаться обязано быть ВЫГОДНО. Жизнь монстров подняли ×160 за 10→80, время убийства выросло
 * ×16.5, и при плоском шансе дропа поток вещей падал ровно во столько же. Сторож держит само правило:
 * ВЕЩЕЙ В ЧАС на 80 уровне не меньше, чем на 10-м (с запасом на шум измерения).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const med = (x: number[]): number => { const s = [...x].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

describe('⭐⭐ награда за убийство едет по кривой жизни монстра', () => {
  it('точка опоры — 10 уровень: там масштаб ровно 1 при любой степени', () => {
    for (const p of [0, 0.5, 1.35, 3]) expect(rewardScaleOf(10, 1, p), `степень ${p}`).toBeCloseTo(1, 9);
  });

  it('степень 0 — награда плоская, как было до плана', () => {
    for (const lv of [1, 10, 50, 200]) expect(rewardScaleOf(lv, 7, 0)).toBe(1);
  });

  it('масштаб растёт с уровнем и с тиром (босс с ×10 жизни заслужил ×10 награды)', () => {
    expect(rewardScaleOf(80, 1, 1.35)).toBeGreaterThan(rewardScaleOf(40, 1, 1.35));
    expect(rewardScaleOf(40, 10, 1.35) / rewardScaleOf(40, 1, 1.35)).toBeCloseTo(10, 6);
  });

  it('броски: целая часть гарантирована, остаток — вероятностный', () => {
    expect(rewardRolls(0.12, 1, () => false), 'остаток не выпал').toBe(0);
    expect(rewardRolls(0.12, 1, () => true), 'остаток выпал').toBe(1);
    expect(rewardRolls(0.12, 20, () => false), '0.12×20 = 2.4 → две гарантированных').toBe(2);
    expect(rewardRolls(0.12, 20, () => true)).toBe(3);
    // Средний выход совпадает с ожидаемым: прогоняем честный rng.
    const rng = createRng(11);
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += rewardRolls(0.12, 20, (p) => rng.chance(p));
    expect(Math.abs(sum / 4000 / 2.4 - 1), `средний выход ${(sum / 4000).toFixed(3)} против 2.4`).toBeLessThan(0.05);
  });

  it('⭐⭐ вещей В ЧАС на 80 уровне не меньше, чем на 10-м (замер на боте сима)', () => {
    const monsters = reg.get('monsters');
    const loot = reg.get('balance').loot;
    const classId = reg.get('classes')[0]!.id;
    const flow = (lv: number): number => {
      const save = buildBotAt(reg, classId, lv, DEFAULT_BUILD, 7);
      const mons = monsters.map((b) => generateMonster(monsters, reg.get('monster-gear'), reg.get('monster-affixes'),
        { baseId: b.id, depth: lv - 1, mderive: reg.get('monster-derive'), gearTiers: reg.get('monster-gear-tiers') }, createRng(7)));
      const ttk = med(mons.map((m) => closedFormTtk(reg, save, m).ttkSec).filter((t) => Number.isFinite(t) && t > 0));
      return (3600 / Math.max(0.01, ttk)) * loot.dropChance * rewardScaleOf(lv, 1, loot.rewardPower);
    };
    const at10 = flow(10), at80 = flow(80), at40 = flow(40);
    expect(at80 / at10, `вещей/ч: ${at10.toFixed(1)} на 10 ур. против ${at80.toFixed(1)} на 80`).toBeGreaterThan(0.75);
    expect(at40 / at10, `вещей/ч: ${at10.toFixed(1)} на 10 ур. против ${at40.toFixed(1)} на 40`).toBeGreaterThan(0.75);
    // И сторож на зубы: при плоском шансе (степень 0) поток обязан провалиться — иначе проверять нечего.
    const flat = (lv: number): number => flow(lv) / rewardScaleOf(lv, 1, loot.rewardPower);
    expect(flat(80) / flat(10), 'плоский шанс обязан проваливаться — иначе сторож ничего не мерит').toBeLessThan(0.3);
  }, 120_000);
});
