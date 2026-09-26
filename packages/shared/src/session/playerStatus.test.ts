import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { STATUS_CHANCE_CAP, statusChance, type DebuffApply } from '../world/debuffs.js';
import { armorPoise } from '../formulas/resolveArmor.js';
import type { Rng } from '../formulas/rng.js';
import type { CombatStats, DamagePacket } from '../types/combat.js';
import { newBotSave } from '../sim/playerBot.js';
import type { PlayerEntity } from '../world/state.js';
import { equippedItems } from './derive.js';
import { GameSession, type FloorLayout } from './session.js';

/**
 * ⭐ ПОТОЛОК ШАНСА СТАТУСА ПО ИГРОКУ (D19, docs/CRAFT_WEAPONS.md §20). `resolvePlayerHit` (игрок → монстр)
 * зажат `statusChance` давно, а `hitPlayer` (монстр → игрок и PvP) катал `chance × (1 − выдержка)` без
 * потолка: прок монстра или оружия соперника с шансом ≥ 1 вешал статус КАЖДЫМ ударом. Один источник
 * шанса на бой — `statusChance`: не выше 0.95 при любых числах, мусор на входе → 0.
 */

function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }
function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}

/** Доступ к закрытому: сам бросок и путь удара по игроку (тот же у монстра и у PvP). */
type Priv = {
  rng: Rng;
  hitPlayer(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, onHit: DebuffApply[], by: string, source?: unknown): void;
};

const attacker: CombatStats = {
  accuracy: 1e6, evade: 0, armor: 0, armorPen: 0, blockChance: 0, critChance: 0, critMultiplier: 1.5,
  resFire: 0, resCold: 0, resLightning: 0, resPoison: 0, ailmentPct: 0, level: 1,
};
const packet: DamagePacket = { physical: 1, fire: 0, cold: 0, lightning: 0, poison: 0 };
const wound = (chance: number): DebuffApply => ({ kind: 'wound', chance, maxStacks: 4, durationMs: 3000, mag: 0.06, mag2: 0.1 });

/**
 * Бросок-сценарист: первый бросок (попадание) — 0, бросок статуса (№ `at`) — `roll`, прочие (блок, крит) —
 * 0.999, чтобы удар точно дошёл до статуса. Пишет шанс каждого броска.
 */
function scripted(at: number, roll: number): { log: number[]; rng: Rng } {
  const log: number[] = [];
  let i = 0;
  const rng: Rng = {
    next: () => 0, int: (a) => a, float: (a) => a, pick: (arr) => arr[0]!,
    chance: (p) => { const k = i++; log.push(p); return (k === 0 ? 0 : k === at ? roll : 0.999) < p; },
  };
  return { log, rng };
}

function setup(): { s: GameSession; priv: Priv; p: PlayerEntity; poise: number } {
  const r = reg();
  const s = new GameSession(r, 7, 'normal');
  const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
  s.addPlayer('p2', newBotSave(r, 'warrior'));
  const layout: FloorLayout = { grid: openField(16, 10), spawn: cellToWorld(5, 5), monsters: [], pvp: true };
  s.enterFloor(1, layout);
  s.tick(1 / 30, {});   // снимки игроков (derived/combat) строит тик — без них удар по игроку не катается
  p.spawnImmuneUntil = 0;
  const poise = armorPoise(equippedItems(p.save), 'wound', r.get('armor-classes'));
  return { s, priv: s as unknown as Priv, p, poise };
}

/** Сколько бросков делает сам удар до броска статуса. */
function rollsBeforeStatus(): number {
  const { priv, p } = setup();
  const r = scripted(-1, 0);
  priv.rng = r.rng;
  priv.hitPlayer(p, packet, attacker, [], 'Враг');
  expect(p.alive).toBe(true);
  return r.log.length;
}

describe('⭐ D19: статус по игроку — не выше 0.95 (монстр → игрок и PvP)', () => {
  const n0 = rollsBeforeStatus();

  for (const by of ['monster', 'pvp'] as const) {
    it(`${by}: бросок статуса = statusChance(шанс, 1 − выдержка) при любом шансе`, () => {
      for (const chance of [0.1, 0.6, 1, 1.5, 50, Infinity]) {
        const { priv, p, poise } = setup();
        const r = scripted(n0, 0.5);
        priv.rng = r.rng;
        priv.hitPlayer(p, packet, attacker, [wound(chance)], by === 'pvp' ? 'p2' : 'Враг', by === 'pvp' ? undefined : {});
        expect(r.log.length, `шанс ${chance}: бросок статуса не случился`).toBe(n0 + 1);
        const rolled = r.log[n0]!;
        expect(rolled, `шанс ${chance}`).toBeLessThanOrEqual(STATUS_CHANCE_CAP);
        expect(rolled, `шанс ${chance}`).toBe(statusChance(chance, 1 - poise));
      }
    });
  }

  it('бросок 0.97 не вешает статус даже при «шансе 5000 %» — а 0.5 вешает', () => {
    const miss = setup();
    miss.priv.rng = scripted(n0, 0.97).rng;
    miss.priv.hitPlayer(miss.p, packet, attacker, [wound(50)], 'Враг', {});
    expect(miss.p.debuffs.wound, 'выше потолка — мимо').toBeUndefined();

    const hit = setup();
    hit.priv.rng = scripted(n0, 0.5).rng;
    hit.priv.hitPlayer(hit.p, packet, attacker, [wound(50)], 'Враг', {});
    expect(hit.p.debuffs.wound?.stacks, 'ниже потолка — наложен').toBe(1);
  });

  it('мусор в шансе (NaN, отрицательный) статус не вешает даже броском 0', () => {
    for (const chance of [NaN, -1, -Infinity]) {
      const { priv, p } = setup();
      const r = scripted(n0, 0);
      priv.rng = r.rng;
      priv.hitPlayer(p, packet, attacker, [wound(chance)], 'Враг', {});
      expect(r.log[n0], `шанс ${chance}`).toBe(0);
      expect(p.debuffs.wound, `шанс ${chance}`).toBeUndefined();
    }
  });
});
