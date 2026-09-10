import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { addDebuffStack } from '../world/debuffs.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave, levelUpBotTo } from '../sim/playerBot.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { GameSession, type PlayerInput } from './session.js';

/**
 * УСЛОВНЫЕ ВСТАВКИ (тип «Охота»). Надбавка зависит от СОСТОЯНИЯ МИРА, а `resolveActive` — чистая
 * функция без мира, поэтому условие считает сессия. Проверяем не «функция посчитала», а что
 * надбавка ДОЛЕТЕЛА до боя: замеряем `attackCd` после каста — из скорости он и получается
 * (`session.ts:665`). Первая версия механизма применяла условие только на ударе, и надбавка
 * к скорости не доезжала никуда: `attackCd` к тому моменту уже выставлен.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}

const CARRIER = 'b-sword1h-a1';          // «Град ударов» — мечевая активка, куда вставка влезает
const INSERT = 'ins-blood-rhythm';

/** Сессия с воином при мече, N монстрами рядом; `bleeding` — скольким из них навесить кровотечение. */
function scene(withInsert: boolean, monsters: number, bleeding: number): { s: GameSession; cd: () => number } {
  const s = new GameSession(reg, 5, 'normal', { rewards: false });
  const save = newBotSave(reg, 'warrior');
  // Поднимаем бота как остальные симы. Просто `save.level = 30` оставляет атрибуты первого уровня:
  // пул выносливости выходит игрушечным, каст не проходит по ресурсу, и тест меряет пустоту —
  // ровно так первая версия этого файла и «прошла» с `attackCd === 0`.
  levelUpBotTo(reg, save, 30, DEFAULT_BUILD, createRng(4242));
  // Воин стартует с ТОПОРОМ, а носитель — мечевой: без меча в руках скил не срабатывает вовсе,
  // и замер молча меряет ноль. Выдаём меч явно — тест про механизм, а не про стартовый гир класса.
  const sword = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && b.hands === 1)!;
  save.equipment.weapon = itemFromBaseId(reg.get('items.base'), sword.id, reg.get('item-tiers'))!;
  save.skills = { [CARRIER]: 20 };
  if (withInsert) {
    const donor = reg.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === INSERT)!;
    save.skills[donor.id] = 1;
    save.sockets = { [CARRIER]: [INSERT] };
  }
  s.addPlayer('p1', save);

  const grid = openField(24, 16);
  const spawn = cellToWorld(6, 8);
  const baseId = reg.get('biomes')[0]!.monsterPool[0]!;
  const mons = Array.from({ length: monsters }, (_, i) => {
    const def = generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'),
      { baseId, depth: 1 }, createRng(11 + i));
    def.hp = 100000;
    return { def, x: spawn.x + 70 + i * 6, y: spawn.y };
  });
  s.enterFloor(1, { grid, spawn, monsters: mons });
  for (let i = 0; i < bleeding; i++) {
    addDebuffStack(s.world.monsters[i]!.debuffs, { kind: 'bleed', chance: 1, mag: 1, maxStacks: 5, durationMs: 60000 }, s.world.timeMs);
  }
  return { s, cd: () => s.world.players.p1!.attackCd };
}

/** Один каст и `attackCd` сразу после него: он и есть скорость замаха. */
function cdAfterCast(sc: { s: GameSession; cd: () => number }): number {
  sc.s.tick(1 / 30, { p1: { ...idle, cast: CARRIER } });
  const cd = sc.cd();
  // Каст мог не пройти (не то оружие, не хватило ресурса) — тогда `attackCd` остаётся нулём,
  // и сравнение нулей «проходит», ничего не проверив. Ловим это здесь, а не в каждом тесте.
  if (cd <= 0) throw new Error('каст не прошёл: attackCd = 0, мерить нечего');
  return cd;
}

describe('«Кровавый ритм» — надбавка от состояния мира', () => {
  it('носитель существует и вставка в него влезает', () => {
    const node = reg.get('skill-tree').nodes.find((n) => n.id === CARRIER);
    expect(node?.effect.active?.category, 'Град ударов — атака').toBe('attack');
    const ins = reg.get('skill-inserts').find((i) => i.id === INSERT)!;
    expect(ins.tune?.when?.kind).toBe('bleedingNearby');
  });

  it('РЯДОМ КРОВОТОЧАЩИЕ → бьём быстрее; их нет → скорость обычная', () => {
    const bare = cdAfterCast(scene(false, 4, 4));
    const noBleed = cdAfterCast(scene(true, 4, 0));
    const bleeding = cdAfterCast(scene(true, 4, 4));

    expect(noBleed, 'без кровоточащих вставка скорость не трогает').toBeCloseTo(bare, 5);
    expect(bleeding, 'с кровоточащими замах короче').toBeLessThan(noBleed);
  });

  it('НАДБАВКА РАСТЁТ С ЧИСЛОМ кровоточащих и упирается в потолок', () => {
    const one = cdAfterCast(scene(true, 8, 1));
    const four = cdAfterCast(scene(true, 8, 4));
    const eight = cdAfterCast(scene(true, 8, 8));
    expect(four, 'четверо быстрее одного').toBeLessThan(one);
    // maxStacks: 5 — восьмой кровоточащий уже ничего не добавляет.
    const five = cdAfterCast(scene(true, 8, 5));
    expect(eight).toBeCloseTo(five, 5);
  });

  it('условие смотрит только на ЖИВЫХ и только на кровоточащих', () => {
    const sc = scene(true, 4, 4);
    for (const m of sc.s.world.monsters) m.alive = false;
    const dead = cdAfterCast(sc);
    const none = cdAfterCast(scene(true, 4, 0));
    expect(dead, 'мёртвые не считаются').toBeCloseTo(none, 5);
  });
});
