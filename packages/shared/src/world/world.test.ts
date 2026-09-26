import { describe, it, expect } from 'vitest';
import { createRng, type Rng } from '../formulas/rng.js';
import type { CombatStats, DamagePacket } from '../types/combat.js';
import {
  newDebuffState, addDebuffStack, tickDebuffs, debuffMods, statusChance, STATUS_CHANCE_CAP, type DebuffApply,
} from './debuffs.js';
import { resolvePlayerHit, type HitTarget } from './combat.js';

/** Rng, всегда возвращающий 0 → любые chance(p>0) успешны, попадание гарантировано. */
const hitRng: Rng = { next: () => 0, int: (a) => a, float: (a) => a, pick: (arr) => arr[0]!, chance: (p) => 0 < p };

function stats(over: Partial<CombatStats> = {}): CombatStats {
  return {
    accuracy: 1000, evade: 0, armor: 0, armorPen: 0, blockChance: 0, critChance: 0, critMultiplier: 1.5,
    resFire: 0, resCold: 0, resLightning: 0, resPoison: 0, ailmentPct: 0, level: 1, ...over,
  };
}
function target(over: Partial<HitTarget> = {}): HitTarget {
  return { hp: 1000, maxHp: 1000, stats: stats(), debuffs: newDebuffState(), ...over };
}
const phys = (v: number): DamagePacket => ({ physical: v, fire: 0, cold: 0, lightning: 0, poison: 0 });

const apply = (over: Partial<DebuffApply> = {}): DebuffApply =>
  ({ kind: 'wound', chance: 1, maxStacks: 4, durationMs: 3000, mag: 0.06, mag2: 0.1, ...over });

describe('debuffs', () => {
  it('стаки копятся до максимума и обновляют таймер', () => {
    const s = newDebuffState();
    for (let i = 0; i < 10; i++) addDebuffStack(s, apply({ maxStacks: 4 }), 0);
    expect(s.wound!.stacks).toBe(4);
  });

  it('debuffMods агрегирует эффекты', () => {
    const s = newDebuffState();
    addDebuffStack(s, apply({ kind: 'sunder', mag: 0.05 }), 0);
    addDebuffStack(s, apply({ kind: 'daze', mag: 0.05, mag2: 0.04 }), 0);
    const m = debuffMods(s);
    expect(m.recvDamageMult).toBeCloseTo(1.05);
    expect(m.hpRegenMult).toBe(0.5);
    expect(m.armorMult).toBeCloseTo(0.95);
    expect(m.dazeStunChance).toBeCloseTo(0.04);
  });

  it('tickDebuffs снимает истёкшие и копит DoT кровотечения', () => {
    const s = newDebuffState();
    addDebuffStack(s, apply({ kind: 'bleed', mag: 5, durationMs: 1000 }), 0);
    expect(tickDebuffs(s, 1, 500)).toBeCloseTo(5); // 1 стак × 5/сек × 1с
    tickDebuffs(s, 1, 2000);
    expect(s.bleed).toBeUndefined(); // истёк
  });

  it('стихийные статусы: поджиг/яд — DoT; шок — +урон; заморозка — замедление/сков', () => {
    const s = newDebuffState();
    addDebuffStack(s, apply({ kind: 'burn', mag: 3, durationMs: 1000 }), 0);
    addDebuffStack(s, apply({ kind: 'poison', mag: 2, durationMs: 1000 }), 0);
    expect(tickDebuffs(s, 1, 500)).toBeCloseTo(5); // поджиг 3 + яд 2

    const s2 = newDebuffState();
    addDebuffStack(s2, apply({ kind: 'shock', mag: 0.1 }), 0);
    addDebuffStack(s2, apply({ kind: 'freeze', mag: 0.15, mag2: 0.05 }), 0);
    const m = debuffMods(s2);
    expect(m.recvDamageMult).toBeCloseTo(1.1); // шок: +10% получаемого урона
    expect(m.moveMult).toBeCloseTo(0.85); // заморозка: −15% скорости
    expect(m.freezeChance).toBeCloseTo(0.05);
  });
});

describe('resolvePlayerHit', () => {
  it('наносит урон и применяет дебафф подтипа', () => {
    const t = target();
    const r = resolvePlayerHit(t, stats(), phys(100), { onHit: [apply({ kind: 'bleed', mag: 5 })] }, hitRng, 0);
    expect(r.hit).toBe(true);
    expect(r.damage).toBe(100);
    expect(t.hp).toBe(900);
    expect(r.appliedDebuffs).toContain('bleed');
  });

  it('увечье повышает получаемый урон', () => {
    const t = target();
    for (let i = 0; i < 5; i++) addDebuffStack(t.debuffs, apply({ kind: 'sunder', mag: 0.05, maxStacks: 5 }), 0);
    const r = resolvePlayerHit(t, stats(), phys(100), {}, hitRng, 0);
    expect(r.damage).toBe(125); // 100 × (1 + 5×0.05)
  });

  it('броне-пробитие и ошеломление снижают броню цели', () => {
    const base = resolvePlayerHit(target({ stats: stats({ armor: 100 }) }), stats({ level: 1 }), phys(100), {}, hitRng, 0);
    const pen = resolvePlayerHit(target({ stats: stats({ armor: 100 }) }), stats({ level: 1 }), phys(100), { armorPen: 0.5 }, hitRng, 0);
    expect(pen.damage).toBeGreaterThan(base.damage); // меньше брони → больше урона
  });

  it('стан срабатывает по шансу', () => {
    const r = resolvePlayerHit(target(), stats(), phys(100), { stunChance: 0.2 }, hitRng, 0);
    expect(r.stunned).toBe(true);
  });

  it('ailmentPct усиливает магнитуду наложенного статуса', () => {
    const t = target();
    resolvePlayerHit(t, stats({ ailmentPct: 1 }), phys(100), { onHit: [apply({ kind: 'bleed', mag: 5 })] }, hitRng, 0);
    expect(t.debuffs.bleed?.mag).toBe(10); // 5 × (1 + 1)
  });

  it('ailmentPct повышает шанс наложения статуса', () => {
    const thr: Rng = { ...hitRng, chance: (p) => p >= 0.6 };
    const on = { onHit: [apply({ kind: 'bleed', chance: 0.4 })] };
    const weak = resolvePlayerHit(target(), stats(), phys(100), on, thr, 0);
    expect(weak.appliedDebuffs).not.toContain('bleed'); // 0.40 < 0.6 → мимо
    const strong = resolvePlayerHit(target(), stats({ ailmentPct: 0.6 }), phys(100), on, thr, 0);
    expect(strong.appliedDebuffs).toContain('bleed'); // 0.40×1.6 = 0.64 ≥ 0.6 → наложен
  });
});

/**
 * ⭐ ПОТОЛОК ШАНСА СТАТУСА (docs/CRAFT_WEAPONS.md §20). Деревья дают `ailmentPct` до ~1.8, и
 * ошеломление с базой 0.60 уходило за 1.0 — «статус каждым ударом». Сервер обязан катать не выше
 * 0.95 при ЛЮБЫХ бонусах, а окна — показывать ровно это число (одна функция `statusChance`).
 */
describe('⭐ потолок шанса статуса 0.95', () => {
  /** Rng-самописец: пишет шанс каждого броска; успех как у hitRng (попадание гарантировано). */
  const recorder = (): { log: number[]; rng: Rng } => {
    const log: number[] = [];
    return { log, rng: { ...hitRng, chance: (p) => { log.push(p); return 0 < p; } } };
  };
  /** Сколько бросков делает сам удар (попадание/блок/крит) — бросок статуса идёт следующим. */
  const rollsBeforeStatus = (): number => {
    const r = recorder();
    resolvePlayerHit(target(), stats(), phys(100), {}, r.rng, 0);
    return r.log.length;
  };

  it('statusChance: база × множитель, зажатая в [0, 0.95]; мусор на входе → 0', () => {
    expect(STATUS_CHANCE_CAP).toBe(0.95);
    expect(statusChance(0.4)).toBeCloseTo(0.4, 12);
    expect(statusChance(0.4, 1.5)).toBeCloseTo(0.6, 12);
    expect(statusChance(0.6, 2.788)).toBe(0.95);          // ошеломление × максимум деревьев
    expect(statusChance(1)).toBe(0.95);
    expect(statusChance(Infinity)).toBe(0.95);
    expect(statusChance(0)).toBe(0);
    expect(statusChance(NaN)).toBe(0);
    expect(statusChance(0.5, NaN)).toBe(0);
    expect(statusChance(-0.3)).toBe(0);
    expect(statusChance(0.5, -2)).toBe(0);
    expect(statusChance(-Infinity)).toBe(0);
  });

  it('сервер катает статус не выше 0.95 при любых бонусах — и ровно statusChance', () => {
    const n0 = rollsBeforeStatus();
    for (const base of [0.1, 0.6, 0.95, 1, 1.5]) {
      for (const ap of [0, 0.5, 1.788, 5]) {
        for (const kc of [0, 0.4, 2]) {
          const r = recorder();
          const atk = stats({ ailmentPct: ap, ailment: { chance: { wound: kc }, power: {}, dur: {} } });
          resolvePlayerHit(target(), atk, phys(100), { onHit: [apply({ kind: 'wound', chance: base })] }, r.rng, 0);
          expect(r.log.length, 'бросок статуса не случился').toBe(n0 + 1);
          const p = r.log[n0]!;
          expect(p, `база ${base}, ailmentPct ${ap}, шанс вида ${kc}`).toBeLessThanOrEqual(STATUS_CHANCE_CAP);
          expect(p).toBe(statusChance(base, 1 + ap + kc));
        }
      }
    }
  });

  it('бросок 0.97 не вешает статус даже при «шансе 300 %» — эксплойт долга §20 закрыт', () => {
    const n0 = rollsBeforeStatus();
    let i = 0;
    // Удар попадает (бросок 0), а бросок статуса выпадает 0.97 — выше потолка.
    const rng: Rng = { ...hitRng, chance: (p) => (i++ === n0 ? 0.97 : 0) < p };
    const r = resolvePlayerHit(target(), stats({ ailmentPct: 4 }), phys(100), { onHit: [apply({ kind: 'daze', chance: 0.6 })] }, rng, 0);
    expect(r.hit).toBe(true);
    expect(r.appliedDebuffs).not.toContain('daze');
  });

  it('на живом ГПСЧ частота наложения ≈ 95 % от попаданий, а не 100 %', () => {
    const rng = createRng(12345);
    let hits = 0, applied = 0;
    for (let k = 0; k < 20000; k++) {
      const r = resolvePlayerHit(target(), stats({ ailmentPct: 10 }), phys(1), { onHit: [apply({ kind: 'wound', chance: 1 })] }, rng, 0);
      if (!r.hit || r.blocked) continue;
      hits++;
      if (r.appliedDebuffs.includes('wound')) applied++;
    }
    expect(hits).toBeGreaterThan(15000);
    expect(applied).toBeLessThan(hits);                    // хоть один промах статуса обязан быть
    expect(applied / hits).toBeGreaterThan(0.94);
    expect(applied / hits).toBeLessThan(0.96);
  });
});
