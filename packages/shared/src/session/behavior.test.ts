import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { makeMonsterEntity } from '../world/state.js';
import { stepMonsterAi } from './ai.js';
import { behaviorFor, DEFAULT_BEHAVIOR } from './behavior.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput, type FloorLayout } from './session.js';

const r = (() => { const c = new ConfigRegistry(); c.loadAll(); return c; })();
const behaviors = r.get('monster-behaviors');
const mrng = createRng(1);
const monster = (baseId: string) =>
  makeMonsterEntity(1, generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng), { x: 100, y: 100 }, 0);

describe('behaviorFor (резолвер профиля по фракции)', () => {
  it('возвращает профиль своей фракции; дефолт для неизвестной', () => {
    expect(behaviorFor('demon', behaviors).faction).toBe('demon');
    expect(behaviorFor('beast', behaviors).fleeHpPct).toBeGreaterThan(0); // звери отступают
    expect(behaviorFor('undead', behaviors).fleeHpPct).toBe(0);           // нежить fearless
    expect(behaviorFor('xxx', behaviors)).toBe(DEFAULT_BEHAVIOR);
  });
});

describe('LoS-гейт дальней атаки (блок A: не стрелять сквозь стену)', () => {
  it('стрелок, сагренный по слуху без LoS — НЕ стреляет; при LoS — стреляет', () => {
    const b = behaviorFor('undead', behaviors);
    const target = { x: 180, y: 100 }; // dist 80 (в пределах слуха 90 → агро) прямо перед монстром
    const roll = (los: boolean): 'attack' | 'shoot' | null => {
      const m = monster('zombie-archer'); m.facing = 0; m.attackCd = 0;
      return stepMonsterAi(m, target, b, los, 1, 1 / 30);
    };
    expect(roll(false)).not.toBe('shoot'); // сагрен слухом, но стены → не палит вслепую
    expect(roll(true)).toBe('shoot');      // видит → стреляет
  });
});

describe('flee (порог отхода fleeHpPct)', () => {
  it('мили с fleeHpPct>0 при низком HP отступает ОТ цели', () => {
    const b = behaviorFor('demon', behaviors); // fleeHpPct 0.35
    const m = monster('zombie'); // melee-chaser
    m.facing = 0; m.hp = m.maxHp * 0.1; // 10% < 35% → отход
    stepMonsterAi(m, { x: 130, y: 100 }, b, true, 1, 1 / 30); // цель справа (dist 30)
    expect(m.vel.x).toBeLessThan(0); // скорость направлена ОТ цели (влево)
  });

  it('fearless-мили (нежить, fleeHpPct=0) при низком HP всё равно идёт К цели', () => {
    const b = behaviorFor('undead', behaviors);
    const m = monster('zombie'); m.facing = 0; m.hp = m.maxHp * 0.05;
    stepMonsterAi(m, { x: 300, y: 100 }, b, true, 1, 1 / 30); // цель далеко справа
    expect(m.vel.x).toBeGreaterThan(0); // прёт вперёд (не отступает)
  });
});

describe('патфайндинг (блок B: обход стены)', () => {
  it('монстр за стеной с проходом переходит на сторону игрока (не застревает)', () => {
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    const cols = 18, rows = 14, wallX = 9;
    const g: Grid = makeGrid(cols, rows, Cell.Floor);
    for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
    for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
    for (let y = 1; y <= 4; y++) g[y]![wallX] = Cell.Wall; // короткая стена сверху, проход снизу
    const spawn = cellToWorld(7, 2);       // игрок слева от стены
    const mAt = cellToWorld(11, 2);        // монстр справа — прямой путь перекрыт
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: 'zombie', depth: 1 }, createRng(3));
    s.enterFloor(1, { grid: g, spawn, monsters: [{ def, x: mAt.x, y: mAt.y }] } as FloorLayout);
    // игрок стоит и машет (шум держит агро); монстр обходит стену через нижний проход
    const swing: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: true, cast: null, interact: false };
    for (let i = 0; i < 400; i++) s.tick(1 / 30, { p1: swing });
    expect(s.world.monsters[0]!.pos.x).toBeLessThan(cellToWorld(wallX, 2).x); // перешёл на сторону игрока
  });
});
