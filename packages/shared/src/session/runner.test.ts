import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { availableMaterials, giveMaterialsTo } from '../economy/materials.js';
import { sellItem } from '../economy/townActions.js';
import type { SaveState } from '../types/save.js';
import { runSessionSim } from './runner.js';

describe('runSessionSim — настоящий сим на GameSession', () => {
  it('воин прокачивается, дерётся, собирает лут и билд', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const r = runSessionSim(reg, {
      classId: 'warrior',
      difficultyId: 'normal',
      seed: 42,
      targetLevel: 5,
      maxHours: 1,
      build: DEFAULT_BUILD,
    });
    expect(r.kills).toBeGreaterThan(0);
    expect(r.xpEarned).toBeGreaterThan(0);
    expect(r.totalTimeSec).toBeGreaterThan(0);
    expect(r.finalBuild.level).toBeGreaterThanOrEqual(3);
    expect(r.finalBuild.equipment.length).toBeGreaterThan(0);
    expect(r.finalBuild.derived.maxHp).toBeGreaterThan(0);
    expect(r.levelCurve.length).toBeGreaterThan(0);
  });

  it('детерминизм: один сид → одинаковый итог', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const opts = { classId: 'warrior', difficultyId: 'normal', seed: 99, targetLevel: 4, maxHours: 1, build: DEFAULT_BUILD };
    const a = runSessionSim(reg, opts);
    const b = runSessionSim(reg, opts);
    expect(a.kills).toBe(b.kills);
    expect(a.totalTimeSec).toBe(b.totalTimeSec);
    expect(a.finalBuild.level).toBe(b.finalBuild.level);
  });

  it('⚠ R3-20: сырьё в отчёте — и в золоте лавки: бот его не продаёт, но кран обязан быть виден', () => {
    // С врезки ковки лавка платит за сырьё поштучно, и сданный стек с тел — настоящий доход (на 10-м уровне
    // ≈ четверть золота с убийств). Бот сырьё копит на кузницу, и до R3-20 отчёт этого крана не видел вовсе.
    const reg = new ConfigRegistry();
    reg.loadAll();
    const r = runSessionSim(reg, { classId: 'warrior', difficultyId: 'normal', seed: 42, targetLevel: 4, maxHours: 1, build: DEFAULT_BUILD });
    const m = r.craft.materials;
    expect(m.in.monsters, 'с тел что-то упало').toBeGreaterThan(0);
    // Мерка — НАСТОЯЩАЯ продажа, как у сервера: сырьё стеками в сумку, каждый стек — `sellItem`.
    const bal = reg.get('balance');
    const sellAll = (mats: Record<string, number>): number => {
      const save = { gold: 0, inventory: [] } as unknown as SaveState;
      let n = 0;
      const left = giveMaterialsTo(save.inventory, mats, reg.get('craft-materials'), { ...bal.inventory, cols: 60, rows: 60 },
        bal.inventory.materialStack, () => `m${n++}`);
      expect(left, 'всё легло в сумку').toEqual({});
      for (const it of [...save.inventory]) expect(sellItem(reg, save, it.uid).ok).toBe(true);
      return save.gold;
    };
    expect(m.sellWorth.monsters, 'всё сырьё с тел в ценах лавки').toBe(sellAll(r.loot.materials));
    expect(m.sellWorth.monsters, 'единица — не дешевле золотого').toBeGreaterThanOrEqual(m.in.monsters);
    // Запас на конец — то, что бот так и не потратил: столько золота сверх `goldEnd` взял бы игрок, сдавший излишек.
    expect(m.sellWorth.end, 'запас на конец в ценах лавки').toBe(sellAll(availableMaterials(r.finalSave.inventory, r.finalStash.materials ?? {})));
    expect(m.sellWorth.end).toBeGreaterThan(0);
  });
});
