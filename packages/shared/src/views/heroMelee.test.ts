import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { meleeGeometry } from '../formulas/combat.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput, type SessionEvent } from '../session/session.js';
import type { SaveState } from '../types/save.js';
import { heroMelee } from './hero.js';

/**
 * ⭐ С-аудит (29.10): КОНУС ВЗМАХА В КАДРЕ ГЕРОЯ (`hero.melee`) — ТОТ, КОТОРЫМ БЬЁТ СЕРВЕР. Дебаг-слой F3 Unity считал конус сам
 * (`baseRange × reachMult`, `baseArc × arcMult`) и рисовал половину угла — сектор вдвое уже настоящего. Теперь числа шлёт сервер, и сторож
 * сверяет их с боем: монстр у самой кромки (дальность и полуугол) — попадание, чуть за кромкой — нет.
 */
const reg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

/** Попал ли базовый удар героя с `save` по монстру на расстоянии `dist` под углом `ang` к взгляду (взгляд — 0). */
function hits(r: ConfigRegistry, save: SaveState, dist: number, ang: number): boolean {
  const s = new GameSession(r, 77, 'normal');
  const p = s.addPlayer('p1', save);
  const at = cellToWorld(15, 10);
  const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
    { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(1));
  def.hp = 1e7; def.armor = 0; def.evade = 0;
  const mp = { x: at.x + Math.cos(ang) * dist, y: at.y + Math.sin(ang) * dist };
  s.enterFloor(1, { grid: openField(30, 20), spawn: at, monsters: [{ def, x: mp.x, y: mp.y }] });
  const m = s.world.monsters[0]!;
  const evs: SessionEvent[] = [];
  for (let i = 0; i < 60; i++) {
    p.pos = { ...at }; m.pos = { ...mp }; m.vel = { x: 0, y: 0 };
    evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } }));
  }
  expect(evs.some((e) => e.type === 'swing' && e.ability === 'attack'), 'удар был').toBe(true);
  return evs.some((e) => e.type === 'hit' && e.target === 'monster');
}

describe('⭐ С-аудит: `hero.melee` — конус сервера', () => {
  it('числа — `meleeGeometry` баланса и оружия основной руки; `halfArc` — ПОЛУугол', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    const mel = r.get('balance').melee;
    const w = save.equipment.weapon;
    expect(heroMelee(r, save)).toEqual({ range: mel.baseRange * (w?.reachMult ?? 1), halfArc: mel.baseArc * (w?.arcMult ?? 1) });
    expect(heroMelee(r, save)).toEqual(meleeGeometry(mel, w));
    delete save.equipment.weapon;
    expect(heroMelee(r, save), 'без оружия — база баланса').toEqual({ range: mel.baseRange, halfArc: mel.baseArc });
  });

  it('оружие снарядом (лук) — `null`: взмаха нет', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    const bow = r.get('items.base').find((b) => (b as { attackType?: string }).attackType && (b as { attackType?: string }).attackType !== 'melee');
    expect(bow, 'в базах есть оружие снарядом').toBeTruthy();
    save.equipment.weapon = itemFromBaseId(r.get('items.base'), bow!.id, r.get('item-tiers'), 'drop')!;
    expect(heroMelee(r, save)).toBeNull();
  });

  it('бой бьёт ровно по конусу кадра: у кромки дальности и полуугла — попадание, за кромкой — нет (меч и пика)', () => {
    const r = reg();
    for (const base of [null, 'pike'] as const) {
      const mk = (): SaveState => {
        const s = newBotSave(r, 'warrior');
        if (base) s.equipment.weapon = itemFromBaseId(r.get('items.base'), base, r.get('item-tiers'), 'drop')!;
        return s;
      };
      const g = heroMelee(r, mk())!;
      expect(g.range).toBeGreaterThan(30);
      expect(hits(r, mk(), g.range - 2, 0), `${base ?? 'меч'}: у кромки дальности`).toBe(true);
      expect(hits(r, mk(), g.range + 3, 0), `${base ?? 'меч'}: за кромкой дальности`).toBe(false);
      const d = Math.min(g.range - 4, 40);
      expect(hits(r, mk(), d, g.halfArc - 0.03), `${base ?? 'меч'}: у кромки полуугла (старый F3 рисовал здесь «мимо»)`).toBe(true);
      expect(hits(r, mk(), d, g.halfArc + 0.05), `${base ?? 'меч'}: за кромкой полуугла`).toBe(false);
    }
  });
});
