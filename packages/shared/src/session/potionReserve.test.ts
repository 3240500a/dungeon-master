import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { addDebuffStack } from '../world/debuffs.js';
import { Cell, makeGrid, cellToWorld } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import type { Item } from '../types/items.js';
import { effectivePool, reservedFrac } from './toggles.js';
import { GameSession, type PlayerInput } from './session.js';

/**
 * ⭐ C-14: ЗЕЛЬЕ МАНЫ — ДО ЭФФЕКТИВНОГО ПОТОЛКА (ауры резервируют долю пула). `applyConsumable` сравнивал ману с ПОЛНЫМ `maxMana`:
 * у зарезервированного потолка зелье считалось сработавшим и уходило (пояс и команда `useConsumable`), а реген того же тика срезал
 * ману обратно — правило R4-35 «зелье без эффекта не тратится» ломалось. И каст, идущий в тике сразу за поясом, успевал потратить
 * налитое сверх резерва: удар за счёт зелья, которого после тика будто и не было.
 *
 * Сторож — по классу: случайные состояния (аура или нет, здоровье, мана, статусы) × каждый расходник × оба пути (пояс в тике и
 * команда сервера) — зелье уходит тогда и только тогда, когда у него есть действие, и мана зельем не встаёт выше потолка.
 */

const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
const AURAS = ['b-aura-a1', 'b-aura-a2', 'b-aura-a3', 'b-aura-a4', 'b-aura-a5'];

const REG = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

function setup(seed = 9) {
  const r = REG;
  const bases = r.get('items.base');
  const pot = (id: string): Item => itemFromBaseId(bases, id, undefined, 'shop')!;
  const s = new GameSession(r, seed, 'normal');
  const save = newBotSave(r, 'mage');
  save.level = 10;
  for (const id of AURAS) save.skills[id] = 1;
  save.skills['b-class-mage-a1'] = 1;
  save.equipment.belt = itemFromBaseId(bases, 'leather-belt', r.get('item-tiers'), 'drop')!;
  save.belt = [pot('mana-potion'), null, null, null];
  const p = s.addPlayer('p1', save);
  s.enterFloor(1, { grid: makeGrid(12, 12, Cell.Floor), spawn: cellToWorld(5, 5), monsters: [] });
  /** Потолок маны сейчас: полный пул минус резерв включённых аур — по тому же снимку, что у сессии. */
  const cap = (): number => effectivePool(s.snapshotOf('p1')!.derived.maxMana, reservedFrac(r, p.toggles, 'mana'));
  return { r, s, p, save, pot, cap };
}

describe('⭐ C-14: зелье маны при ауре — до зарезервированного потолка', () => {
  it('пояс: мана на потолке ауры — зелье не тратится и маны не прибавляет', () => {
    const { s, p, save, cap } = setup();
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a1' } });
    expect(p.toggles).toEqual(['b-aura-a1']);
    expect(cap()).toBeLessThan(s.snapshotOf('p1')!.derived.maxMana);
    p.mana = cap();
    s.tick(1 / 30, { p1: { ...idle, useBelt: 0 } });
    expect(save.belt[0], 'зелье без эффекта не тратится').not.toBeNull();
    expect(p.mana).toBeCloseTo(cap(), 9);
  });

  it('команда сервера (`drink`): у потолка — «нет эффекта»; ниже — доливает РОВНО до потолка, не выше', () => {
    const { s, p, pot, cap } = setup();
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a2' } });
    const use = pot('mana-potion').use!;
    p.mana = cap();
    expect(s.drink('p1', use)).toBe(false);
    expect(p.mana).toBeCloseTo(cap(), 9);
    p.mana = cap() - 1;
    expect(s.drink('p1', use)).toBe(true);
    expect(p.mana).toBeCloseTo(cap(), 9);   // зелье сильнее единицы — упёрлось в потолок, а не в полный пул
  });

  it('каст в том же тике, что и зелье у потолка, платит из своего пула, а не из налитого сверх резерва', () => {
    const run = (belt: boolean) => {
      const w = setup();
      w.s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a1' } });
      w.p.mana = w.cap();
      const ev = w.s.tick(1 / 30, { p1: { ...idle, cast: 'b-class-mage-a1', ...(belt ? { useBelt: 0 } : {}) } });
      return { mana: w.p.mana, cap: w.cap(), kept: w.save.belt[0] !== null, cast: ev.some((e) => e.type === 'swing' && e.ability === 'b-class-mage-a1') };
    };
    const ctrl = run(false), got = run(true);
    expect(ctrl.cast && got.cast, 'каст состоялся в обоих').toBe(true);
    expect(ctrl.mana, 'каст стоит маны').toBeLessThan(ctrl.cap - 1);
    expect(got.kept, 'зелье у потолка не ушло').toBe(true);
    expect(got.mana).toBeCloseTo(ctrl.mana, 9);   // было: зелье долило сверх резерва, каст съел налитое, реген срезал до потолка — каст даром
  });

  it('класс: зелье уходит ⇔ есть действие, и мана зельем не встаёт выше потолка (все расходники × оба пути, сидированный перебор)', () => {
    const rng = createRng(1514);
    const bad: string[] = [];
    const seen = { used: 0, kept: 0, capped: 0 };
    const ids = ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote'];
    for (let i = 0; i < 240; i++) {
      const w = setup(100 + i);
      const aura = rng.chance(0.75) ? rng.pick(AURAS) : null;
      if (aura) w.s.tick(1 / 30, { p1: { ...idle, cast: aura } });
      else w.s.tick(1 / 30, { p1: idle });
      const d = w.s.snapshotOf('p1')!.derived;
      const cap = w.cap();
      w.p.hp = rng.chance(0.3) ? d.maxHp : rng.float(1, d.maxHp);
      w.p.mana = rng.pick([cap, cap, 0, rng.float(0, cap), rng.float(cap, d.maxMana), d.maxMana]);
      if (rng.chance(0.3)) addDebuffStack(w.p.debuffs, { kind: 'poison', chance: 1, maxStacks: 5, durationMs: 5000, mag: 1 }, w.s.world.timeMs);
      const item = w.pot(rng.pick(ids));
      const u = item.use!;
      const mana0 = w.p.mana, hp0 = w.p.hp, sick = Object.keys(w.p.debuffs).length > 0;
      const effect = ((u.heal ?? 0) + (u.healPct ?? 0) * d.maxHp > 0 && hp0 < d.maxHp)
        || ((u.mana ?? 0) + (u.manaPct ?? 0) * d.maxMana > 0 && mana0 < cap)
        || (!!u.cure && sick);
      const tag = `#${i} ${item.baseId} аура ${aura ?? '—'} hp ${hp0.toFixed(1)}/${d.maxHp.toFixed(1)} мана ${mana0.toFixed(1)} потолок ${cap.toFixed(1)}/${d.maxMana.toFixed(1)}${sick ? ' яд' : ''}`;
      let used: boolean;
      if (rng.chance(0.5)) {
        used = w.s.drink('p1', u);
        if (w.p.mana > Math.max(mana0, cap) + 1e-9) bad.push(`${tag} команда: мана ${w.p.mana.toFixed(2)} выше потолка`);
      } else {
        w.save.belt[0] = item;
        w.s.tick(1 / 30, { p1: { ...idle, useBelt: 0 } });
        used = w.save.belt[0] === null;
        if (w.p.mana > cap + 1e-9) bad.push(`${tag} пояс: мана ${w.p.mana.toFixed(2)} выше потолка после тика`);
      }
      if (used !== effect) bad.push(`${tag}: ${used ? 'ушло' : 'осталось'}, а действие ${effect ? 'было' : 'не было'}`);
      seen[used ? 'used' : 'kept']++;
      if (aura && mana0 >= cap && (u.manaPct ?? 0) > 0) seen.capped++;
    }
    expect(seen.used).toBeGreaterThan(20);
    expect(seen.kept).toBeGreaterThan(20);
    expect(seen.capped, 'перебор видел зелье маны у зарезервированного потолка').toBeGreaterThan(5);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
