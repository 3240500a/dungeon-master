import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, TILE, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import type { Item } from '../types/items.js';
import type { MonsterFaction } from '../types/world.js';
import { GameSession, type PlayerInput, type SessionEvent, type FloorLayout } from './session.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

/** Открытое поле cols×rows с бордюром-стеной. */
function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}

const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

describe('GameSession — движение', () => {
  it('игрок движется по полю и стоит у стены', () => {
    const r = reg();
    const s = new GameSession(r, 123, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(3, 6);
    s.enterFloor(1, { grid, spawn, monsters: [] });

    const startX = p.pos.x;
    for (let i = 0; i < 30; i++) s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 } } });
    expect(p.pos.x).toBeGreaterThan(startX); // поехал вправо

    // Влево до упора в бордюр (столбец 0 — стена): не проникает за грань.
    for (let i = 0; i < 200; i++) s.tick(1 / 30, { p1: { ...idle, move: { x: -1, y: 0 } } });
    expect(p.pos.x).toBeGreaterThanOrEqual(1 * TILE + p.radius - 0.001);
  });
});

describe('GameSession — бой/лут/прокачка', () => {
  it('убийство монстра даёт события смерти, золота, опыта и зачистки этажа', () => {
    const r = reg();
    const s = new GameSession(r, 777, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);

    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    // Слабый монстр рядом (переопределяем HP, чтобы гарантированно добить).
    const mrng = createRng(9);
    const baseId = r.get('dungeons')[0]!.monsterPool[0]!;
    const def = generateMonster(r.get('monsters'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
    def.hp = 1;
    def.armor = 0;
    const mpos = cellToWorld(7, 6); // на одну клетку правее игрока (в радиусе взмаха)
    const layout: FloorLayout = { grid, spawn, monsters: [{ def, x: mpos.x, y: mpos.y }] };
    s.enterFloor(1, layout);

    const goldBefore = save.gold;
    const all: SessionEvent[] = [];
    for (let i = 0; i < 300 && s.monstersAlive > 0; i++) {
      const m = s.world.monsters[0]!;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      all.push(...s.tick(1 / 30, { p1: { ...idle, facing, attack: true } }));
    }

    expect(s.monstersAlive).toBe(0);
    expect(all.some((e) => e.type === 'monster-died')).toBe(true);
    expect(all.some((e) => e.type === 'gold')).toBe(true);
    expect(all.some((e) => e.type === 'xp')).toBe(true);
    expect(all.some((e) => e.type === 'floor-cleared')).toBe(true);
    expect(save.gold).toBeGreaterThan(goldBefore);
    expect(save.xp).toBeGreaterThan(0);
  });

  it('этаж без монстров сразу считается зачищенным', () => {
    const r = reg();
    const s = new GameSession(r, 1, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(10, 10), spawn: cellToWorld(5, 5), monsters: [] });
    const ev = s.tick(1 / 30, { p1: idle });
    expect(ev.some((e) => e.type === 'floor-cleared')).toBe(true);
  });

  it('монстр бьёт с замахом: в первый кадр замаха урона нет, урон проходит по завершении', () => {
    const r = reg();
    const s = new GameSession(r, 555, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    const mrng = createRng(3);
    const baseId = r.get('dungeons')[0]!.monsterPool[0]!;
    const def = generateMonster(r.get('monsters'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
    // Живучий, точный, медленный ближник — чтобы гарантированно завёл замах и попал.
    def.hp = 9999; def.rarity = 'normal'; def.ai = 'melee-chaser';
    def.attackSpeed = 1; def.accuracy = 1000; def.minDamage = 5; def.maxDamage = 5;
    s.enterFloor(1, { grid, spawn, monsters: [{ def, x: cellToWorld(7, 6).x, y: cellToWorld(7, 6).y }] });
    const m = s.world.monsters[0]!;

    // Игрок стоит и не бьёт; крутим, пока монстр не начнёт замах.
    let ticks = 0;
    while (!m.windup && ticks < 600) { s.tick(1 / 30, { p1: idle }); ticks++; }
    expect(m.windup).not.toBeNull();

    const hpAtWindup = p.hp;
    s.tick(1 / 30, { p1: idle });   // первый кадр замаха — урона ещё нет (раньше бил мгновенно)
    expect(p.hp).toBe(hpAtWindup);

    for (let i = 0; i < 120; i++) s.tick(1 / 30, { p1: idle }); // замах завершается → урон
    expect(p.hp).toBeLessThan(hpAtWindup);
  });
});

// ── Движок active.type (новая боевая модель скиллов) ──────────
// Контента с новыми типами ещё нет (авторится в фазе D), поэтому синтетически
// впрыскиваем узлы в дерево воина и проверяем диспетчеризацию executeAbility.

/** Active-способность (v2) с дефолтами всех полей + переопределения (`over` задаёт category/shape/…).
 * injectSkill кладёт объект в конфиг БЕЗ zod-парсинга, поэтому нужны явные дефолты всех читаемых движком полей. */
function activeFx(over: Record<string, unknown>): Record<string, unknown> {
  return {
    abilityId: 'test', manaCost: 1, resource: 'mana', cooldown: 0, hands: 'any', requiresDual: false,
    speed: 1, damageMult: 1, arcMult: 1, rangeMult: 1, windupSec: 0,
    knockback: 0, shoveChance: 1, stunSec: 0,
    count: 1, spread: 0, pierce: false, hits: 1, radius: 0, durationSec: 10,
    // cast/curse-поля (v3): каст-тайм 0 (мгновенно в тестах), без конверсии стихии, дефолты рывка/прыжка.
    castTimeSec: 0, convertPct: 0, dashDist: 130, dashSpeed: 700, dashWeightBonus: 200, taunt: false,
    ...over,
  };
}

/** Впрыскивает активный узел с заданной механикой в ЕДИНОЕ древо скилов (универсальная ветка). */
function injectSkill(r: ConfigRegistry, _classId: string, id: string, active: Record<string, unknown>): void {
  const tree = r.get('skill-tree');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tree.nodes as any[]).push({
    id, name: id, description: '', cost: { type: 'points', amount: 1 },
    requires: [], maxRank: 1, levelReq: 1, kind: 'active', branchId: tree.branches[0]!.id, notable: false,
    x: 0, y: 0, effect: { active },
  });
}

/** Слабый монстр (hp/armor 0) в точке. */
function weakMon(r: ConfigRegistry, x: number, y: number) {
  const def = generateMonster(r.get('monsters'), r.get('monster-affixes'),
    { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(x + y));
  def.hp = 6; def.armor = 0; def.evade = 0;
  return { def, x, y };
}

describe('GameSession — категории скиллов (attack/cast/curse/aura/stance/buff)', () => {
  it('nova бьёт всех монстров в радиусе вокруг игрока', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_nova', activeFx({ category: 'cast', shape: 'nova', radius: 130, damageMult: 2 }));
    const s = new GameSession(r, 5, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(8, 6);
    // Три монстра в клетках вокруг точки спавна (в пределах radius=130).
    const c = (cx: number, cy: number) => cellToWorld(cx, cy);
    s.enterFloor(1, { grid, spawn, monsters: [
      weakMon(r, c(9, 6).x, c(9, 6).y), weakMon(r, c(7, 6).x, c(7, 6).y), weakMon(r, c(8, 7).x, c(8, 7).y),
    ] });
    for (let i = 0; i < 300 && s.monstersAlive > 0; i++) {
      p.mana = 100; // хватает маны на каст
      s.tick(1 / 30, { p1: { ...idle, cast: 't_nova' } });
    }
    expect(s.monstersAlive).toBe(0); // все трое добиты новой
  });

  it('attack-веер: дальнобойный attack-скилл пускает несколько снарядов в цель', () => {
    const r = reg();
    injectSkill(r, 'archer', 't_fan', activeFx({ category: 'attack', count: 3, spread: 0.2, damageMult: 3 }));
    const s = new GameSession(r, 6, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'archer'));
    const grid = openField(24, 12);
    const spawn = cellToWorld(5, 6);
    const mp = cellToWorld(10, 6); // прямо по +x от игрока
    s.enterFloor(1, { grid, spawn, monsters: [weakMon(r, mp.x, mp.y)] });
    const m = s.world.monsters[0]!;
    for (let i = 0; i < 300 && m.alive; i++) {
      p.mana = 100;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      s.tick(1 / 30, { p1: { ...idle, facing, cast: 't_fan' } });
    }
    expect(m.alive).toBe(false); // центральный снаряд веера долетел и добил
  });

  it('boomerang пробивает несколько целей и не гаснет о первую', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_boom', activeFx({ category: 'cast', shape: 'boomerang', radius: 260, damageMult: 3 }));
    const s = new GameSession(r, 7, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(24, 12);
    const spawn = cellToWorld(5, 6);
    // Две цели на линии полёта (+x): ближняя и дальняя.
    const near = cellToWorld(8, 6), far = cellToWorld(11, 6);
    s.enterFloor(1, { grid, spawn, monsters: [weakMon(r, near.x, near.y), weakMon(r, far.x, far.y)] });
    for (let i = 0; i < 400 && s.monstersAlive > 0; i++) {
      p.mana = 100;
      s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_boom' } });
    }
    expect(s.monstersAlive).toBe(0); // пробил обе, не застряв на первой
    // Досим без каста — последний бумеранг должен вернуться к владельцу и погаснуть.
    for (let i = 0; i < 200 && s.world.projectiles.length > 0; i++) s.tick(1 / 30, { p1: idle });
    expect(s.world.projectiles.length).toBe(0); // бумеранги вернулись/погасли
  });

  it('dash сдвигает игрока вперёд и бьёт монстров на пути', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_dash', activeFx({ category: 'cast', shape: 'dash', damageMult: 3, knockback: 1, dashDist: 130, dashSpeed: 700, dashWeightBonus: 200 }));
    const s = new GameSession(r, 8, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(24, 12);
    const spawn = cellToWorld(5, 6);
    const mp = cellToWorld(7, 6); // на пути рывка
    s.enterFloor(1, { grid, spawn, monsters: [weakMon(r, mp.x, mp.y)] });
    const m = s.world.monsters[0]!;
    const startX = p.pos.x;
    // Рывок теперь ДВИЖЕНИЕ (не телепорт): урон наносится в тик каста, а смещение — за следующие
    // тики. Тикаем фиксированно (не гейтим на m.alive), чтобы рывок успел сдвинуть игрока.
    for (let i = 0; i < 30; i++) {
      p.mana = 100;
      s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_dash' } });
    }
    expect(p.pos.x).toBeGreaterThan(startX); // персонаж рванул вперёд
    expect(m.alive).toBe(false); // и порубил монстра по пути
  });

  it('curse накладывает дебаф на врагов в радиусе', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_curse', activeFx({ category: 'curse', radius: 200, element: 'fire', ailment: { chance: 1, mag: 5, maxStacks: 5, durationMs: 3000 } }));
    const s = new GameSession(r, 9, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(24, 12);
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid, spawn: cellToWorld(5, 6), monsters: [weakMon(r, mp.x, mp.y)] });
    const m = s.world.monsters[0]!;
    p.mana = 100;
    s.tick(1 / 30, { p1: { ...idle, cast: 't_curse' } });
    expect(Object.keys(m.debuffs).length).toBeGreaterThan(0); // статус-дебаф стихии наложен
  });

  it('cast НЕ занимает общий attack-таймер, ставит личный КД', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_cast', activeFx({ category: 'cast', shape: 'nova', radius: 200, cooldown: 5 }));
    const s = new GameSession(r, 10, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(24, 12);
    s.enterFloor(1, { grid, spawn: cellToWorld(5, 6), monsters: [] });
    p.mana = 100;
    s.tick(1 / 30, { p1: { ...idle, cast: 't_cast' } });
    expect(p.attackCd).toBe(0);                     // каст не тронул attack-таймер (атака доступна)
    expect(p.skillCd['t_cast']).toBeGreaterThan(0); // но встал личный КД скилла
  });

  it('базовый удар магическим оружием бесплатен при basicManaCost=0', () => {
    const r = reg();
    const s = new GameSession(r, 11, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'mage'));
    const grid = openField(24, 12);
    s.enterFloor(1, { grid, spawn: cellToWorld(5, 6), monsters: [] });
    expect(p.save.equipment.weapon?.weaponType).toBe('magic'); // предпосылка: оружие мага — магическое
    const manaBefore = p.mana;
    for (let i = 0; i < 60; i++) s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } });
    expect(p.mana).toBe(manaBefore);                    // мана не убывает от базового удара
    expect(s.world.projectiles.length).toBeGreaterThan(0); // болты всё же вылетают
  });

  it('во время замаха игрок идёт медленно, а не стоит колом', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_slowatk', activeFx({ category: 'attack', windupSec: 0.5, damageMult: 3, speed: 0.6 }));
    const s = new GameSession(r, 12, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(24, 12);
    s.enterFloor(1, { grid, spawn: cellToWorld(6, 6), monsters: [] });
    p.mana = 100;
    const startX = p.pos.x;
    // Бьём тяжёлый удар (длинный замах) и одновременно идём вправо.
    for (let i = 0; i < 5; i++) s.tick(1 / 30, { p1: { ...idle, facing: 0, move: { x: 1, y: 0 }, cast: 't_slowatk' } });
    expect(p.windup).not.toBeNull();         // ещё в замахе
    expect(p.pos.x).toBeGreaterThan(startX); // но всё равно сдвинулся (медленно, не колом)
  });

  it('attack-скилл бьёт ВСЕХ монстров в дуге оружия (не одну цель)', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_atk', activeFx({ category: 'attack', weaponTypes: ['melee'], damageMult: 6 }));
    const s = new GameSession(r, 21, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    // Два монстра близко перед игроком (в пределах дуги/дальности оружия), лицом +x.
    s.enterFloor(1, { grid, spawn, monsters: [
      weakMon(r, spawn.x + 40, spawn.y - 10), weakMon(r, spawn.x + 40, spawn.y + 10),
    ] });
    for (let i = 0; i < 60 && s.monstersAlive > 0; i++) {
      p.mana = 100;
      s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_atk' } });
    }
    expect(s.monstersAlive).toBe(0); // обоих задело дугой оружия (как обычный удар)
  });

  it('weapon-restrict блокирует скилл при неподходящем оружии', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_bowonly', activeFx({ category: 'attack', damageMult: 6, weaponTypes: ['ranged'] }));
    const s = new GameSession(r, 22, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior')); // стартовое оружие — мили
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    s.enterFloor(1, { grid, spawn, monsters: [weakMon(r, spawn.x + 40, spawn.y)] });
    const mon = s.world.monsters[0]!;
    for (let i = 0; i < 30; i++) { p.mana = 50; s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_bowonly' } }); }
    expect(mon.alive).toBe(true); // скилл не сработал (нужен лук) — урона нет
  });
});

describe('GameSession — тоглы/стойки/баффы (фаза B)', () => {
  it('тогл резервирует ману и добавляет стат-моды, повторный каст — выключает', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_stance', activeFx({
      category: 'stance', manaCost: 0, reservePct: 0.3,
      buffMods: [{ stat: 'armor', kind: 'flat', value: 100 }],
    }));
    const s = new GameSession(r, 11, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });

    s.tick(1 / 30, { p1: idle }); // базовый снимок
    const baseArmor = s.snapshotOf('p1')!.derived.armor;
    const maxMana = s.snapshotOf('p1')!.derived.maxMana;

    // Включаем стойку.
    s.tick(1 / 30, { p1: { ...idle, cast: 't_stance' } });
    expect(p.toggles).toContain('t_stance');
    s.tick(1 / 30, { p1: idle }); // снимок уже с рантайм-модами
    expect(s.snapshotOf('p1')!.derived.armor).toBe(baseArmor + 100); // buffMods применились
    expect(p.mana).toBeLessThanOrEqual(maxMana * 0.7 + 1e-6); // 30% маны зарезервировано

    // Выключаем — моды и резерв снимаются.
    s.tick(1 / 30, { p1: { ...idle, cast: 't_stance' } });
    expect(p.toggles).not.toContain('t_stance');
    s.tick(1 / 30, { p1: idle });
    expect(s.snapshotOf('p1')!.derived.armor).toBe(baseArmor);
  });

  it('зарезервированная мана регенерируется только до эффективного максимума (не до полного пула)', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_stance', activeFx({ category: 'stance', manaCost: 0, reservePct: 0.3 }));
    const s = new GameSession(r, 12, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });
    s.tick(1 / 30, { p1: idle });
    const maxMana = s.snapshotOf('p1')!.derived.maxMana;

    s.tick(1 / 30, { p1: { ...idle, cast: 't_stance' } }); // включить стойку (резерв 30%)
    expect(p.toggles).toContain('t_stance');
    p.mana = 0;
    for (let i = 0; i < 3000; i++) s.tick(1 / 30, { p1: idle }); // насыщение регена
    expect(p.mana).toBeCloseTo(maxMana * 0.7, 5); // ровно эфф. максимум — НЕ полный пул
  });

  it('эксклюзив-группа: включение второй стойки гасит первую', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_a', activeFx({ category: 'stance', manaCost: 0, reservePct: 0.2, toggleGroup: 'stance' }));
    injectSkill(r, 'warrior', 't_b', activeFx({ category: 'stance', manaCost: 0, reservePct: 0.2, toggleGroup: 'stance' }));
    const s = new GameSession(r, 12, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });

    s.tick(1 / 30, { p1: { ...idle, cast: 't_a' } });
    expect(p.toggles).toEqual(['t_a']);
    s.tick(1 / 30, { p1: { ...idle, cast: 't_b' } });
    expect(p.toggles).toEqual(['t_b']); // первая стойка снята автоматически
  });

  it('бафф действует ограниченное время и истекает', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_buff', activeFx({
      category: 'buff', manaCost: 5, durationSec: 1,
      buffMods: [{ stat: 'moveSpeed', kind: 'increased', value: 50 }],
    }));
    const s = new GameSession(r, 13, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });
    p.mana = 15; // в пределах пула маны воина (не клампится)

    s.tick(1 / 30, { p1: { ...idle, cast: 't_buff' } });
    expect(p.skillBuffs['t_buff']).toBeGreaterThan(0);
    expect(p.mana).toBeCloseTo(10, 0); // списана мана каста (15 − 5)

    // Повторный каст, пока активен — не тратит ману (не рефрешим).
    s.tick(1 / 30, { p1: { ...idle, cast: 't_buff' } });
    expect(p.mana).toBeGreaterThan(9); // не списалось второй раз (учтём мелкий реген)

    // Досим больше секунды — бафф истекает.
    for (let i = 0; i < 40; i++) s.tick(1 / 30, { p1: idle });
    expect(p.skillBuffs['t_buff']).toBeUndefined();
  });
});

// ── Замах/прерывание · аффинити · сет-бонус (фаза C) ─────────
function injectMastery(r: ConfigRegistry, _classId: string, id: string, effect: Record<string, unknown>): void {
  const tree = r.get('skill-tree');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tree.nodes as any[]).push({
    id, name: id, description: '', cost: { type: 'points', amount: 1 },
    requires: [], maxRank: 1, levelReq: 1, kind: 'active', branchId: tree.branches[0]!.id, notable: false,
    x: 0, y: 0, effect,
  });
}

/** Неубиваемый монстр заданной фракции (для сравнения урона). */
function tankMon(r: ConfigRegistry, x: number, y: number, faction: MonsterFaction) {
  const def = generateMonster(r.get('monsters'), r.get('monster-affixes'),
    { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(1));
  def.hp = 1e7; def.armor = 0; def.evade = 0; def.faction = faction;
  return { def, x, y };
}

describe('GameSession — аффинити фракций (фаза C)', () => {
  it('класс наносит больше урона монстрам своей аффинити-фракции', () => {
    // Два одинаковых прогона (один сид → один RNG-поток): разница только во фракции.
    function totalDamage(faction: MonsterFaction): number {
      const r = reg();
      r.get('balance').affinityDamageBonus = 1; // ×2 по нежити — явный сигнал
      const s = new GameSession(r, 30, 'normal');
      const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
      r.get('classes').find((c) => c.id === p.save.classId)!.affinity = ['undead'];
      const grid = openField(20, 12);
      const spawn = cellToWorld(6, 6);
      const mp = cellToWorld(7, 6);
      s.enterFloor(1, { grid, spawn, monsters: [tankMon(r, mp.x, mp.y, faction)] });
      let sum = 0;
      for (let i = 0; i < 200; i++) {
        const m = s.world.monsters[0]!;
        const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
        for (const e of s.tick(1 / 30, { p1: { ...idle, facing, attack: true } })) {
          if (e.type === 'hit' && e.target === 'monster' && e.hit) sum += e.amount;
        }
      }
      return sum;
    }
    const withAff = totalDamage('undead'); // аффинити
    const noAff = totalDamage('beast');    // не аффинити
    expect(withAff).toBeGreaterThan(noAff * 1.8); // ~×2 (бонус 1.0)
    expect(withAff).toBeLessThan(noAff * 2.2);
  });
});

describe('GameSession — замах/прерывание (фаза C)', () => {
  it('удар с замахом срабатывает не сразу, а по завершении', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_heavy', activeFx({ category: 'attack', windupSec: 0.4, damageMult: 3, speed: 0.6 }));
    const s = new GameSession(r, 21, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(16, 12);
    const spawn = cellToWorld(6, 6);
    const mp = cellToWorld(7, 6); // прямо перед игроком (в дуге strike)
    s.enterFloor(1, { grid, spawn, monsters: [{ def: (() => { const d = generateMonster(r.get('monsters'), r.get('monster-affixes'), { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(3)); d.hp = 500; d.armor = 0; d.evade = 0; return d; })(), x: mp.x, y: mp.y }] });
    const m = s.world.monsters[0]!;

    p.mana = 100;
    s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_heavy' } });
    expect(p.windup).not.toBeNull();      // замах начался
    expect(m.hp).toBe(m.maxHp);           // мгновенного урона нет

    // Досим — замах завершается и бьёт (замах теперь = базовая доля цикла + windupSec скилла, длиннее).
    for (let i = 0; i < 90 && p.windup; i++) s.tick(1 / 30, { p1: idle });
    expect(p.windup).toBeNull();
    expect(m.hp).toBeLessThan(m.maxHp);   // удар прошёл по завершении замаха
  });

  it('стан во время замаха прерывает удар (без стойкости к прерыванию)', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_heavy2', activeFx({ category: 'attack', windupSec: 0.6, damageMult: 3 }));
    const s = new GameSession(r, 22, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(16, 12);
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid, spawn: cellToWorld(6, 6), monsters: [{ def: (() => { const d = generateMonster(r.get('monsters'), r.get('monster-affixes'), { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(4)); d.hp = 500; d.armor = 0; return d; })(), x: mp.x, y: mp.y }] });
    const m = s.world.monsters[0]!;

    p.mana = 100;
    s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_heavy2' } });
    expect(p.windup).not.toBeNull();
    const hpAtWindup = m.hp;

    p.stunTimer = 1; // оглушили посреди замаха
    s.tick(1 / 30, { p1: idle });
    expect(p.windup).toBeNull();   // замах сбит
    expect(m.hp).toBe(hpAtWindup); // урон не прошёл
  });
});

describe('GameSession — сет-бонус брони (фаза C)', () => {
  function plate(uid: string, slot: Item['slot']): Item {
    return { uid, baseId: 'plate', name: 'Plate', slot, rarity: 'normal', itemLevel: 1,
      requirements: {}, affixes: [], baseStats: [], gridW: 2, gridH: 2, armorClass: 'plate' };
  }

  it('бонус даётся только при полном латном комплекте', () => {
    const r = reg();
    injectMastery(r, 'warrior', 't_set', {
      setBonus: { requireArmorClass: 'plate', minPieces: 4, mods: [{ stat: 'armor', kind: 'flat', value: 100 }] },
    });
    const s = new GameSession(r, 40, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    p.save.activeSkills['t_set'] = 1; // узел вложен (ранг 1)
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });

    s.tick(1 / 30, { p1: idle });
    const baseArmor = s.snapshotOf('p1')!.derived.armor;

    // 3 части — недобор, бонуса нет.
    p.save.equipment.helm = plate('h', 'helm');
    p.save.equipment.chest = plate('c', 'chest');
    p.save.equipment.gloves = plate('g', 'gloves');
    s.tick(1 / 30, { p1: idle });
    expect(s.snapshotOf('p1')!.derived.armor).toBe(baseArmor);

    // 4-я часть — комплект собран, бонус применился.
    p.save.equipment.boots = plate('b', 'boots');
    s.tick(1 / 30, { p1: idle });
    expect(s.snapshotOf('p1')!.derived.armor).toBe(baseArmor + 100);
  });
});

describe('GameSession — контент Заступника (фаза D)', () => {
  it('класс и дерево загружены, аффинити — нежить/демоны', () => {
    const r = reg();
    const cls = r.get('classes').find((c) => c.id === 'zastupnik');
    expect(cls).toBeDefined();
    expect(cls!.affinity).toEqual(expect.arrayContaining(['undead', 'demon']));
    const tree = r.get('skills-active').find((t) => t.classId === 'zastupnik');
    expect(tree).toBeDefined();
    expect(tree!.nodes.length).toBeGreaterThanOrEqual(28);
  });

  it('«Пламенный удар» Заступника кастуется движком и добивает нежить', () => {
    const r = reg();
    const s = new GameSession(r, 50, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'zastupnik'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    const mp = cellToWorld(7, 6);
    const mon = weakMon(r, mp.x, mp.y);
    expect(mon.def.faction).toBe('undead'); // скелет из пула — нежить (аффинити)
    s.enterFloor(1, { grid, spawn, monsters: [mon] });
    const m = s.world.monsters[0]!;
    const atk = r.get('skill-tree').nodes.find((n) => n.branchId === 'b-class-zastupnik'
      && n.effect.active && (n.effect.active.category === 'attack' || n.effect.active.category === 'cast'))!;
    for (let i = 0; i < 300 && m.alive; i++) {
      p.mana = 100; p.stamina = 100;
      s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: atk.id } });
    }
    expect(m.alive).toBe(false);
  });

  it('«Оглушающий молот» бьёт через замах и оглушает', () => {
    const r = reg();
    const s = new GameSession(r, 51, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'zastupnik'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    const mp = cellToWorld(7, 6);
    const def = generateMonster(r.get('monsters'), r.get('monster-affixes'),
      { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(9));
    def.hp = 5000; def.armor = 0; def.evade = 0; // танк, чтобы дожить до стана
    s.enterFloor(1, { grid, spawn, monsters: [{ def, x: mp.x, y: mp.y }] });
    const m = s.world.monsters[0]!;
    const hammer = r.get('skill-tree').nodes.find((n) => n.branchId === 'b-class-zastupnik'
      && ((n.effect.active as { stunSec?: number } | undefined)?.stunSec ?? 0) > 0)!;
    let stunned = false;
    for (let i = 0; i < 120 && !stunned; i++) {
      p.mana = 100; p.stamina = 100;
      s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: hammer.id } });
      if (m.stunTimer > 0) stunned = true;
    }
    expect(stunned).toBe(true); // гарант. стан по завершении замаха
  });
});

describe('GameSession — реактивные мастерства (триггеры)', () => {
  it('reflect: часть полученного урона возвращается атакующему', () => {
    const r = reg();
    injectMastery(r, 'warrior', 'm_refl', { triggers: [{ on: 'hit-taken', effect: { reflectPct: 0.5, reflectElement: 'fire' } }] });
    const s = new GameSession(r, 42, 'normal');
    const save = newBotSave(r, 'warrior');
    save.activeSkills['m_refl'] = 1;
    const p = s.addPlayer('p1', save);
    const mp = cellToWorld(7, 6);
    const def = generateMonster(r.get('monsters'), r.get('monster-affixes'),
      { baseId: r.get('dungeons')[0]!.monsterPool[0]!, depth: 1 }, createRng(3));
    def.hp = 800; def.minDamage = 2; def.maxDamage = 3; def.armor = 0;
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    const m = s.world.monsters[0]!;
    const hpStart = p.hp;
    for (let i = 0; i < 200 && p.alive; i++) {
      m.alertTimer = 5; m.aiState = 'chase'; // держим монстра в атаке (сами его не бьём)
      s.tick(1 / 30, { p1: { ...idle, facing: 0 } });
    }
    expect(p.hp).toBeLessThan(hpStart); // получили урон
    expect(m.hp).toBeLessThan(def.hp);  // и вернули часть отражением
  });

  it('hit-dealt: +% урона по фракции (детерминированное сравнение)', () => {
    // Два прогона с одним сидом: разница только в ранге мастерства «по нежити».
    const totalDamage = (rank: number): number => {
      const r = reg();
      injectMastery(r, 'warrior', 'm_bane', { triggers: [{ on: 'hit-dealt', condition: { targetFaction: 'undead' }, effect: { bonusDamagePct: 5 } }] });
      const s = new GameSession(r, 99, 'normal');
      const save = newBotSave(r, 'warrior');
      if (rank > 0) save.activeSkills['m_bane'] = rank;
      const p = s.addPlayer('p1', save);
      const mp = cellToWorld(7, 6);
      s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [tankMon(r, mp.x, mp.y, 'undead')] });
      let sum = 0;
      for (let i = 0; i < 150; i++) {
        const facing = Math.atan2(s.world.monsters[0]!.pos.y - p.pos.y, s.world.monsters[0]!.pos.x - p.pos.x);
        for (const e of s.tick(1 / 30, { p1: { ...idle, facing, attack: true } })) {
          if (e.type === 'hit' && e.target === 'monster' && e.hit) sum += e.amount;
        }
      }
      return sum;
    };
    expect(totalDamage(1)).toBeGreaterThan(totalDamage(0) * 1.5); // с мастерством урона заметно больше
  });
});
