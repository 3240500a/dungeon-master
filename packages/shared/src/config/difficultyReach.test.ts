import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { generateRunPlan, defaultRunConfig, runMaxDepth } from '../dungeon/run/generateRunPlan.js';
import { lockedDifficulties } from '../formulas/power.js';

/**
 * ⭐ R8-13: КАЖДЫЙ ВКЛЮЧЁННЫЙ ТИР СЛОЖНОСТИ ОБЯЗАН ОТКРЫВАТЬСЯ.
 *
 * Прогресс сложности — глубина узла забега, в который вошли (`Room.enterNode`), и больше ничего. Узел не глубже
 * «длина шаблона + финал», поэтому порог `unlockFloor` выше самого глубокого узла — замок НАВСЕГДА, для честного
 * игрока и для читера одинаково. Так и было: «Кошмар» просил 20-й этаж «Сложной», а самый длинный включённый
 * шаблон (`deep-expedition`, 10–14 слоёв) доходит до 15-го — алтарь всем писал «🔒 Пройди этаж 20…», и тир со своими
 * ×1.6 к золоту и находкам не открывался никому.
 *
 * Глубину меряем НАСТОЯЩИМ генератором, а не формулой: сторож обязан видеть то же, что сервер.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Самый глубокий узел, который генератор даёт по включённым шаблонам (сиды 1..200 — длину тянет первый бросок). */
function deepestGenerated(): number {
  let deepest = 0;
  for (const t of reg.get('run-templates').filter((x) => x.enabled !== false)) {
    for (let seed = 1; seed <= 200; seed++) {
      const plan = generateRunPlan(reg, defaultRunConfig(reg, t.id, seed));
      for (const n of plan.nodes) deepest = Math.max(deepest, n.depth);
    }
  }
  return deepest;
}

describe('сложности открываются глубиной, которую даёт генератор забега', () => {
  const deepest = deepestGenerated();

  it('сторож вообще что-то мерит — иначе прошёл бы вхолостую', () => {
    expect(deepest, 'самый глубокий узел').toBeGreaterThan(1);
    expect(reg.get('difficulties').filter((d) => d.enabled !== false && d.unlockFloor > 0).length).toBeGreaterThan(0);
  });

  it('⭐ порог каждого включённого тира не глубже самого глубокого узла забега', () => {
    const locked = reg.get('difficulties')
      .filter((d) => d.enabled !== false && d.unlockFloor > deepest)
      .map((d) => `${d.id}: этаж ${d.unlockFloor}, а забег доходит до ${deepest}`);
    expect(locked, 'тир не откроется никогда').toEqual([]);
  });

  it('формула глубины (`runMaxDepth`) = то, что даёт генератор, — на неё опирается проверка редактора', () => {
    expect(runMaxDepth(reg.get('run-templates'))).toBe(deepest);
  });

  it('проверка редактора (`lockedDifficulties`) на данных игры чиста', () => {
    expect(lockedDifficulties(reg.get('difficulties'), runMaxDepth(reg.get('run-templates')))).toEqual([]);
  });
});
