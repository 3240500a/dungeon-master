import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from './rng.js';
import { effTierLevel, rollTierLevel, pickTierClamped, type TierWindow } from './itemgen.js';

/**
 * ОКНО СТУПЕНИ и РУЧНИК. Два правила, которые здесь стерегутся:
 *  1) ступень катается, а не назначается по уровню — иначе «повезло, выпал Мифический» невозможно;
 *  2) глубина/уровень монстра НЕ становятся краном верхней ступени — иначе бесконечный забег
 *     превратится в ферму мификов (в Д4 ту же дыру закрыли капом уровня предмета в Яме).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const W: TierWindow = reg.get('balance').loot.tierWindow;
const TIERS = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
const TOP = TIERS[TIERS.length - 1]!;

/** Доля бросков, давших верхнюю ступень, на монстре такого уровня. */
function topShare(mlvl: number, n = 20000): number {
  const rng = createRng(mlvl * 7 + 1);
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const t = pickTierClamped(TIERS, rollTierLevel(mlvl, W, rng), 't0', 't6')!;
    if (t.id === TOP.id) hit++;
  }
  return hit / n;
}

describe('effTierLevel — ручник против фермы верхней ступени', () => {
  it('до порога уровень не трогается вовсе', () => {
    for (const m of [1, 10, 40, W.softCap]) expect(effTierLevel(m, W)).toBeCloseTo(m, 5);
  });

  it('⭐ выше порога растёт всё медленнее, но растёт', () => {
    const a = effTierLevel(W.softCap, W), b = effTierLevel(150, W), c = effTierLevel(200, W);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // Прибавка за вторую сотню уровней меньше, чем за первую — в этом весь смысл.
    expect(c - b).toBeLessThan(b - a);
  });

  it('⚠ жёсткий потолок не пробивается НИКАКИМ уровнем', () => {
    for (const m of [200, 1000, 100000]) expect(effTierLevel(m, W)).toBeLessThanOrEqual(W.hardCap);
  });
});

describe('rollTierLevel — окно вокруг уровня монстра', () => {
  it('бросок не выходит за окно [низ, уровень+над]', () => {
    const rng = createRng(5);
    for (const m of [10, 40, 80, 150]) {
      const eff = effTierLevel(m, W);
      const lo = Math.max(1, Math.round(eff * W.low));
      for (let i = 0; i < 2000; i++) {
        const v = rollTierLevel(m, W, rng);
        expect(v).toBeGreaterThanOrEqual(Math.min(lo, 1) === 1 ? 1 : lo);
        expect(v).toBeLessThanOrEqual(Math.round(eff + W.over));
      }
    }
  });

  it('⭐ выборка СМЕЩЕНА ВНИЗ: средний бросок ниже середины окна', () => {
    const rng = createRng(9);
    const m = 80, eff = effTierLevel(m, W);
    const lo = Math.round(eff * W.low), hi = eff + W.over;
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += rollTierLevel(m, W, rng);
    expect(W.bias).toBeGreaterThan(1);                 // иначе смещения нет по построению
    expect(sum / n).toBeLessThan((lo + hi) / 2);
  });

  it('⚠ ступень НЕ детерминирована — на одном уровне монстра их несколько', () => {
    const rng = createRng(3);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) seen.add(pickTierClamped(TIERS, rollTierLevel(70, W, rng), 't0', 't6')!.id);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('⭐ верхняя ступень остаётся редкой на любой глубине', () => {
  it('на уровне монстра, где она только открылась, — редкость', () => {
    expect(topShare(TOP.minItemLevel)).toBeLessThan(0.12);
  });

  it('на 150–200 чаще, но всё ещё редкость', () => {
    const at150 = topShare(150), at200 = topShare(200);
    expect(at150).toBeGreaterThan(topShare(TOP.minItemLevel));   // «чуть больше», как и задумано
    expect(at200).toBeLessThan(0.25);
  });

  it('⚠ ГЛАВНОЕ: дальше не растёт — ферма глубины невозможна', () => {
    const at300 = topShare(300), at5000 = topShare(5000);
    expect(at5000).toBeLessThan(0.25);
    expect(Math.abs(at5000 - at300)).toBeLessThan(0.02);         // упёрлось в потолок
  });
});
