import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { skillWeaponAllowed } from '../formulas/skills.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput, type SessionEvent } from './session.js';

/**
 * ДОП. ЭФФЕКТЫ ВСТАВОК в живой сессии. Резолв проверяется отдельно (`inserts.test.ts`) — здесь
 * важно ДРУГОЕ: что эффект долетает до мира и что он не рекурсит. Гоняем настоящий `GameSession`,
 * а не приватный метод: баг такого рода живёт в сцеплении «каст → носитель → прок → мир».
 *
 * ЗАМЕРЯЕМ НАКОПЛЕННЫЙ УРОН ЗА МНОГО КАСТОВ, а не исход одного. Одиночный удар проходит через
 * бросок на попадание, и первая версия теста падала просто потому, что один каст промахнулся, —
 * это проверяло удачу, а не механику.
 */
function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

interface Scene {
  s: GameSession;
  nodeId: string;
  monHp: () => number;
  player: () => { skillBuffs: Record<string, number>; skillCd: Record<string, number> };
  /** Один каст + догон тиков, пока замах и откат не отыграют. Возвращает события за всё это время. */
  cast: () => SessionEvent[];
}

/**
 * Узел, которым бот РЕАЛЬНО может бить своим оружием — той же проверкой, что и сессия.
 * Первая версия брала «скил без ограничений по оружию» и получала ЩИТОВОЙ, который без щита
 * не срабатывает вовсе: тест тихо проверял пустоту.
 */
function usableAttackNode(r: ConfigRegistry, save: ReturnType<typeof newBotSave>): string {
  const n = r.get('skill-tree').nodes.find((x) => {
    const a = x.effect.active;
    // СОБСТВЕННЫЙ КД > 0 обязателен: без него `skillCd` не выставляется вовсе, и проверять рост отката не на чём.
    return a?.category === 'attack' && a.cooldown > 0
      && skillWeaponAllowed(a, save.equipment.weapon, save.equipment.offhand);
  });
  return n!.id;
}

/** Открыть вставку игроку: подставляем донора в дерево этого реестра и вкладываем в него ранг. */
function unlock(r: ConfigRegistry, save: { skills: Record<string, number> }, insertId: string): void {
  const donor = r.get('skill-tree').nodes.find((n) => !n.effect.active && !n.effect.grantsInsert)!;
  donor.effect.grantsInsert = insertId;
  save.skills[donor.id] = 1;
}

function scene(insertId: string | null): Scene {
  const r = reg();
  const s = new GameSession(r, 7, 'normal', { rewards: false });
  const save = newBotSave(r, 'warrior');
  const nodeId = usableAttackNode(r, save);
  save.skills[nodeId] = 20;                      // максимальный ранг — все гнёзда открыты
  if (insertId) { unlock(r, save, insertId); save.sockets = { [nodeId]: [insertId] }; }
  s.addPlayer('p1', save);
  const grid = openField(24, 16);
  const spawn = cellToWorld(6, 8);
  const baseId = r.get('biomes')[0]!.monsterPool[0]!;
  const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, createRng(11));
  // Толстый и без брони: замеряем НАКОПЛЕННЫЙ урон, монстр не должен умереть посреди замера.
  def.hp = 100000; def.armor = 0;
  s.enterFloor(1, { grid, spawn, monsters: [{ def, x: spawn.x + 120, y: spawn.y }] });
  return {
    s, nodeId,
    monHp: () => s.world.monsters[0]!.hp,
    player: () => s.world.players.p1!,
    cast: () => {
      const ev = [...s.tick(1 / 30, { p1: { ...idle, cast: nodeId } })];
      // Дотикиваем ДО КОНЦА отката: иначе следующий каст отбросит `attackCd`, и цикл из 25 кастов
      // на деле сделает ОДИН — именно так первая версия замеряла ноль.
      for (let i = 0; i < 70; i++) ev.push(...s.tick(1 / 30, { p1: idle }));
      return ev;
    },
  };
}

/** Суммарный урон монстру за `casts` использований скила. */
function damageOver(sc: Scene, casts: number): number {
  const hp0 = sc.monHp();
  for (let i = 0; i < casts; i++) sc.cast();
  return hp0 - sc.monHp();
}

describe('вставка-спутник в живой сессии', () => {
  it('ВОЛНА ХОЛОДА добавляет урон поверх носителя', () => {
    const bare = damageOver(scene(null), 12);
    const wave = damageOver(scene('ins-cold-wave'), 12);
    expect(bare, 'сам скил бьёт — иначе сравнивать не с чем').toBeGreaterThan(0);
    expect(wave, 'со вставкой урона больше').toBeGreaterThan(bare);
  });

  it('ПЕЧАТЬ вешает бафф на СЕБЯ', () => {
    const sc = scene('ins-ward');
    sc.cast();
    expect(Object.keys(sc.player().skillBuffs).some((k) => k.startsWith('ins:')), 'бафф вставки повешен').toBe(true);
  });

  it('НЕ РЕКУРСИТ: число попаданий растёт ЛИНЕЙНО по кастам, а не лавиной', () => {
    const sc = scene('ins-cold-wave');
    const CASTS = 6;
    let hits = 0;
    for (let i = 0; i < CASTS; i++) {
      hits += sc.cast().filter((e) => e.type === 'hit' && e.target === 'monster').length;
    }
    expect(hits, 'сам скил и волна отработали').toBeGreaterThan(0);
    // За каст возможны удар носителя и волна — единицы, и рост обязан быть ЛИНЕЙНЫМ по кастам.
    // ЧЕСТНО О ГРАНИЦАХ ЭТОГО ТЕСТА: сегодня пути «прок вызывает сам себя» нет вовсе — вставки
    // стреляют только из `castSkill`/замаха, и снятие гарда `procActive` этот тест не уронит (проверено).
    // Гард здесь держит ДРУГОЕ: чтобы удары самой вставки не запускали проки аффиксов и чтобы будущий
    // `on:'hit'` не замкнулся. А сам этот тест — сторож на случай, если такая петля когда-нибудь появится.
    expect(hits).toBeLessThanOrEqual(CASTS * 4);
  });

  it('ОТКАТ НОСИТЕЛЯ ВЫРОС — сборка не бесплатна', () => {
    // Проверяем КД, а не разность ресурса до/после: ресурс за тик РЕГЕНЕРИРУЕТ, и такая разность
    // им загрязнена — первая версия этого теста так и прошла при неработающем скиле.
    const cdAfterCast = (sc: Scene): number => {
      sc.s.tick(1 / 30, { p1: { ...idle, cast: sc.nodeId } });
      return sc.player().skillCd[sc.nodeId] ?? 0;
    };
    const withIns = cdAfterCast(scene('ins-cold-wave'));
    const bare = cdAfterCast(scene(null));
    expect(withIns, 'вставка удлиняет откат').toBeGreaterThan(bare);
  });
});
