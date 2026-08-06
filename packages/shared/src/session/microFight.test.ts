import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { newBotSave, levelUpBotTo } from '../sim/playerBot.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { townLayout } from '../dungeon/town.js';
import { GameSession } from './session.js';
import { BotController } from './bot.js';
import { simulateMicroFight, microFightStats } from './microFight.js';

const reg = new ConfigRegistry();
reg.loadAll();
const classId = reg.get('classes')[0]!.id;

function botAt(level: number) {
  const save = newBotSave(reg, classId);
  levelUpBotTo(reg, save, level, DEFAULT_BUILD, createRng(level * 7 + 1));
  return save;
}
function mob(baseId: string, depth: number, seed = 1) {
  return generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'), { baseId, depth }, createRng(seed));
}

describe('simulateMicroFight — реальный бой на GameSession', () => {
  it('прокачанный герой убивает слабого моба; удары/TTK/DPS вменяемы', () => {
    const r = simulateMicroFight(reg, { save: botAt(20), monsters: [mob('zombie', 3)], seed: 1 });
    expect(r.killedAll).toBe(true);
    expect(r.playerDied).toBe(false);
    expect(r.hitsToKillAvg).toBeGreaterThan(0);
    expect(r.ttkAvgSec).toBeGreaterThan(0);
    expect(r.dpsOut).toBeGreaterThan(0);
    expect(r.timeSec).toBeLessThan(30); // не таймаут
    expect(r.perMonster).toHaveLength(1);
    expect(r.perMonster[0]!.killed).toBe(true);
  });

  it('детерминизм: один сид → идентичный результат', () => {
    const opts = { save: botAt(15), monsters: [mob('zombie', 5)], seed: 42 };
    expect(simulateMicroFight(reg, opts)).toEqual(simulateMicroFight(reg, opts));
  });

  it('несколько мобов: перебивает всех, у каждого свой TTK', () => {
    const r = simulateMicroFight(reg, { save: botAt(30), monsters: [mob('zombie', 4, 1), mob('zombie', 4, 2), mob('zombie', 4, 3)], seed: 5 });
    expect(r.perMonster).toHaveLength(3);
    expect(r.perMonster.every((m) => m.killed)).toBe(true);
  });

  it('microFightStats: распределение ударов/TTK + kill/death-rate', () => {
    const s = microFightStats(reg, { save: botAt(25), monsters: [mob('zombie', 6)] }, 20);
    expect(s.runs).toBe(20);
    expect(s.killRate).toBeGreaterThan(0.5);
    expect(s.hitsToKill.mean).toBeGreaterThan(0);
    expect(s.hitsToKill.p10).toBeLessThanOrEqual(s.hitsToKill.p90);
    expect(s.ttkSec.p50).toBeGreaterThan(0);
  });
});

describe('GameSession split rewards→sustain/economy', () => {
  it('economy:false — нет золота/XP/дропа/левелапа, но monster-died фаерится', () => {
    const save = botAt(2); // низкий уровень: с наградами моб дал бы левелап
    const startLevel = save.level;
    const startXp = save.xp;
    const session = new GameSession(reg, 1, 'normal', { sustain: true, economy: false });
    const p = session.addPlayer('p1', save);
    const bot = new BotController(reg);
    bot.syncHotbar(save);
    const { grid, spawn } = townLayout(41, 41);
    session.enterFloor(1, { grid, spawn, monsters: [{ def: mob('zombie', 1), x: spawn.x + 96, y: spawn.y }] });

    let died = 0, gold = 0, xp = 0, drops = 0, levelups = 0;
    let t = 0;
    while (session.monstersAlive > 0 && p.alive && t < 30) {
      for (const e of session.tick(1 / 30, { p1: bot.input(session.world, p) })) {
        if (e.type === 'monster-died') died++;
        else if (e.type === 'gold') gold++;
        else if (e.type === 'xp') xp++;
        else if (e.type === 'item-dropped') drops++;
        else if (e.type === 'levelup') levelups++;
      }
      t += 1 / 30;
    }
    expect(died).toBe(1);          // смерть моба детектится
    expect(gold).toBe(0);          // но наград нет
    expect(xp).toBe(0);
    expect(drops).toBe(0);
    expect(levelups).toBe(0);
    expect(save.level).toBe(startLevel); // левелап-хил не сработал → TTK чист
    expect(save.xp).toBe(startXp);
  });

  it('economy:true (дефолт rewards) — награды и XP начисляются', () => {
    const save = botAt(2);
    const session = new GameSession(reg, 1, 'normal'); // дефолт rewards:true → economy:true
    const p = session.addPlayer('p1', save);
    const bot = new BotController(reg);
    bot.syncHotbar(save);
    const { grid, spawn } = townLayout(41, 41);
    session.enterFloor(1, { grid, spawn, monsters: [{ def: mob('zombie', 1), x: spawn.x + 96, y: spawn.y }] });

    let xp = 0;
    let t = 0;
    while (session.monstersAlive > 0 && p.alive && t < 30) {
      for (const e of session.tick(1 / 30, { p1: bot.input(session.world, p) })) if (e.type === 'xp') xp += e.amount;
      t += 1 / 30;
    }
    expect(xp).toBeGreaterThan(0); // с наградами XP капает
  });
});
