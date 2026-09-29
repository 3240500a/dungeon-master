import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, TILE, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { insertById } from './inserts.js';
import { carriedMaterials } from '../economy/materials.js';
import type { Item } from '../types/items.js';
import type { MonsterFaction } from '../types/world.js';
import { GameSession, type PlayerInput, type SessionEvent, type FloorLayout } from './session.js';
import { serializeWorld } from './serialize.js';
import { respecSkills, equip, unequip, allocAttr, respec, socketInsert, socketClear } from '../economy/townActions.js';
import { addDebuffStack } from '../world/debuffs.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { BUFF_MIN_REST, buffCooldown } from '../formulas/combat.js';
import { xpForLevel } from '../formulas/xp.js';
import { addToInventory } from '../inventory/grid.js';
import { playerSnapshot } from './derive.js';
import { effectivePool, reservedFrac, toggleBuffMods } from './toggles.js';

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
  it('⭐ КОЛБЫ ПАДАЮТ СВОИМ КАНАЛОМ, а не через дроп вещей', () => {
    const r = reg();
    const s = new GameSession(r, 555, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);

    // ⚠ Дроп вещей и золото ВЫКЛЮЧЕНЫ: проверяем именно канал расходников. Он и появился из-за
    // того, что трофей с тела исключает `kind: 'consumable'`, а `trophyChance` = 1.0 —
    // то есть колбам взяться было неоткуда вовсе.
    const loot = r.get('balance').loot as { dropChance: number; goldChance: number; potions: { chance: number }; materials: { chance: number } };
    loot.dropChance = 0; loot.goldChance = 0; loot.materials.chance = 0; loot.potions.chance = 1;

    const mrng = createRng(4);
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
    def.hp = 1; def.armor = 0;
    const mpos = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mpos.x, y: mpos.y }] });

    for (let i = 0; i < 300 && s.monstersAlive > 0; i++) {
      const m = s.world.monsters[0]!;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      s.tick(1 / 30, { p1: { ...idle, facing, attack: true } });
    }
    expect(s.monstersAlive).toBe(0);

    const drops = s.world.drops.filter((d) => d.kind === 'item');
    expect(drops.length).toBe(1);
    expect(drops[0]!.kind === 'item' && drops[0]!.item.kind).toBe('consumable');
  });

  it('убийство монстра даёт события смерти, золота, опыта и зачистки этажа', () => {
    const r = reg();
    const s = new GameSession(r, 777, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);

    // Здесь проверяется МЕХАНИЗМ дропа золота, а не его частота: шанс жёстко в 1,
    // иначе тест разваливался бы при каждой правке баланса `loot.goldChance`.
    (r.get('balance').loot as { goldChance: number }).goldChance = 1;
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    // Слабый монстр рядом (переопределяем HP, чтобы гарантированно добить).
    const mrng = createRng(9);
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
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
    expect(all.some((e) => e.type === 'xp')).toBe(true);
    expect(all.some((e) => e.type === 'floor-cleared')).toBe(true);
    expect(save.xp).toBeGreaterThan(0);

    // ⭐ Золото ПАДАЕТ, а не начисляется телепортом: на тике убийства кошелёк ещё не тронут,
    // на земле лежит монета. Раньше здесь ждали событие `gold` прямо с убийства — и это ровно
    // то, что скрывало отсутствие монеты в мире (docs/ECONOMY.md, Ч2).
    expect(s.world.drops.some((d) => d.kind === 'gold')).toBe(true);
    expect(all.some((e) => e.type === 'gold')).toBe(false);
    expect(save.gold).toBe(goldBefore);

    // ⭐ И МОНЕТА ЛЕЖИТ НЕ ПОД НОГАМИ. Разброс был ±10 (треть клетки): в ближнем бою награда
    // падала на убийцу и исчезала автоподбором в том же кадре — игрок видел растущее число
    // в углу, но не видел, что вообще что-то выпало. Теперь бросок идёт ПРОЧЬ от убийцы.
    const coin = s.world.drops.find((d) => d.kind === 'gold')!;
    const sc = r.get('balance').loot.scatter;
    const fromCorpse = Math.hypot(coin.pos.x - mpos.x, coin.pos.y - mpos.y);
    expect(fromCorpse).toBeGreaterThanOrEqual(sc.min - 0.001);
    expect(fromCorpse).toBeLessThanOrEqual(sc.max + 0.001);
    // Прежний разброс не мог унести монету дальше 10 от трупа — этот порог и есть регрессия.
    expect(Math.hypot(coin.pos.x - p.pos.x, coin.pos.y - p.pos.y)).toBeGreaterThan(TILE + 10);

    // Стоим на месте — монета так и лежит (её надо дойти и поднять).
    for (let i = 0; i < 10; i++) all.push(...s.tick(1 / 30, { p1: idle }));
    expect(save.gold).toBe(goldBefore);

    // ...и приходит автоподбором, когда игрок ДОШЁЛ.
    p.pos.x = coin.pos.x; p.pos.y = coin.pos.y;
    all.push(...s.tick(1 / 30, { p1: idle }));
    expect(all.some((e) => e.type === 'gold')).toBe(true);
    expect(save.gold).toBeGreaterThan(goldBefore);
  });

  it('автоподбор: золото и материалы сами, вещь остаётся лежать', () => {
    const r = reg();
    const s = new GameSession(r, 5, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [] });

    const at = { x: p.pos.x + 8, y: p.pos.y + 8 }; // заведомо внутри радиуса автоподбора
    const item = { uid: 'x1', baseId: 'b', name: 'Хлам', rarity: 'normal', pos: null } as unknown as Item;
    s.world.drops.push({ id: 901, pos: { ...at }, kind: 'gold', gold: 50 });
    s.world.drops.push({ id: 902, pos: { ...at }, kind: 'materials', mats: { 'iron-1': 3 } });
    s.world.drops.push({ id: 903, pos: { ...at }, kind: 'item', item });

    const goldBefore = save.gold;
    for (let i = 0; i < 5; i++) s.tick(1 / 30, { p1: idle });

    expect(save.gold).toBe(goldBefore + 50);
    // ⚠ Материалы теперь ЗАНИМАЮТ МЕСТО и приходят в сумку стеком, а не в кошелёк.
    expect(carriedMaterials(save.inventory)['iron-1']).toBe(3);
    // ⚠ Вещь НЕ подбирается сама: `autoPickup.rarities` пуст намеренно — выбор «взять или
    // оставить» и есть добыча. Иначе полевой разбор (Ч3) остался бы без решения игрока.
    expect(s.world.drops.map((d) => d.id)).toEqual([903]);
    expect(save.inventory.some((it) => it.uid === 'x1')).toBe(false);
  });

  it('этаж без монстров сразу считается зачищенным', () => {
    const r = reg();
    const s = new GameSession(r, 1, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(10, 10), spawn: cellToWorld(5, 5), monsters: [] });
    const ev = s.tick(1 / 30, { p1: idle });
    expect(ev.some((e) => e.type === 'floor-cleared')).toBe(true);
  });

  // Гоняет игрока в атаку по монстру `monHp` HP; опц. вешает аффикс-стат на оружие; возвращает итог HP игрока.
  function attackLoop(affix: { stat: string; value: number } | null, monHp: number, ticks: number): number {
    const r = reg();
    const s = new GameSession(r, 55, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);
    if (affix && save.equipment.weapon) save.equipment.weapon.affixes.push({ affixId: 'test', kind: 'suffix', modifier: { stat: affix.stat, kind: 'flat', value: affix.value } });
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(3));
    def.hp = monHp; def.armor = 0; def.evade = 0; def.accuracy = 0; def.minDamage = 0; def.maxDamage = 0; // не бьёт в ответ
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    p.hp = 1; // низко — есть запас до максимума, кламп не скрывает эффект
    for (let i = 0; i < ticks && s.monstersAlive > 0; i++) {
      const m = s.world.monsters[0]; if (!m) break;
      s.tick(1 / 30, { p1: { ...idle, facing: Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x), attack: true } });
    }
    return p.hp;
  }

  it('вампиризм жизни: HP растёт от ударов сильнее, чем без аффикса', () => {
    const withLeech = attackLoop({ stat: 'lifeLeechPct', value: 0.9 }, 99999, 150);
    const without = attackLoop(null, 99999, 150);
    expect(withLeech).toBeGreaterThan(without + 5);
  });

  it('восстановление за убийство: HP подскакивает при килле', () => {
    const withKill = attackLoop({ stat: 'lifeOnKill', value: 15 }, 1, 200);
    const without = attackLoop(null, 1, 200);
    expect(withKill).toBeGreaterThan(without + 8);
  });

  it('прок «шанс каста при ударе»: скилл срабатывает при ударе (спавнит снаряды)', () => {
    const r = reg();
    const s = new GameSession(r, 55, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);
    // прок 100% каста «Волшебных снарядов» (boomerang → снаряды) при ударе, минуя оружие/ресурс
    save.equipment.weapon!.affixes.push({ affixId: 'test-proc', kind: 'suffix', proc: { skillId: 'b-wand-a2', level: 1, chance: 1 } });
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(3));
    def.hp = 99999; def.armor = 0; def.evade = 0; def.accuracy = 0; def.minDamage = 0; def.maxDamage = 0;
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    let hadProj = false;
    for (let i = 0; i < 120 && !hadProj; i++) {
      const m = s.world.monsters[0]; if (!m) break;
      s.tick(1 / 30, { p1: { ...idle, facing: Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x), attack: true } });
      if (s.world.projectiles.length > 0) hadProj = true;
    }
    expect(hadProj).toBe(true);
  });

  it('прок «при получении удара»: скилл срабатывает, когда бьют игрока', () => {
    const r = reg();
    const s = new GameSession(r, 55, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);
    // struck-прок 100% каста при ПОЛУЧЕНИИ удара (на оружии — триггер решает, не слот)
    save.equipment.weapon!.affixes.push({ affixId: 'test-struck', kind: 'suffix', proc: { skillId: 'b-wand-a2', level: 1, chance: 1, trigger: 'struck' } });
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(3));
    def.hp = 99999; def.ai = 'melee-chaser'; def.accuracy = 1000; def.minDamage = 3; def.maxDamage = 3; // бьёт слабо, но точно
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    let hadProj = false;
    for (let i = 0; i < 400 && !hadProj && p.alive; i++) {
      s.tick(1 / 30, { p1: idle });   // игрок стоит; монстр подходит и бьёт → срабатывает прок
      if (s.world.projectiles.length > 0) hadProj = true;
    }
    expect(hadProj).toBe(true);
  });

  it('монстр бьёт с замахом: в первый кадр замаха урона нет, урон проходит по завершении', () => {
    const r = reg();
    const s = new GameSession(r, 555, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const grid = openField(20, 12);
    const spawn = cellToWorld(6, 6);
    const mrng = createRng(3);
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, mrng);
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

/** Выучить узлы рангом 1: сессия кастует ТОЛЬКО выученное (R4-05), как игра после `allocActive`. */
function learn(p: { save: { skills: Record<string, number> } }, ...ids: string[]): void {
  for (const id of ids) p.save.skills[id] = 1;
}

/** Слабый монстр (hp/armor 0) в точке. */
function weakMon(r: ConfigRegistry, x: number, y: number) {
  const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
    { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(x + y));
  def.hp = 6; def.armor = 0; def.evade = 0;
  return { def, x, y };
}

describe('GameSession — категории скиллов (attack/cast/curse/aura/stance/buff)', () => {
  it('nova бьёт всех монстров в радиусе вокруг игрока', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_nova', activeFx({ category: 'cast', shape: 'nova', radius: 130, damageMult: 2 }));
    const s = new GameSession(r, 5, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    learn(p, 't_nova');
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
    learn(p, 't_fan');
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
    learn(p, 't_boom');
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
    learn(p, 't_dash');
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
    learn(p, 't_curse');
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
    learn(p, 't_cast');
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
    expect(p.save.equipment.weapon?.damageKind).toBe('magical'); // предпосылка: оружие мага — магическое
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
    learn(p, 't_slowatk');
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
    injectSkill(r, 'warrior', 't_atk', activeFx({ category: 'attack', attackTypes: ['melee'], damageMult: 6 }));
    const s = new GameSession(r, 21, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    learn(p, 't_atk');
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
    injectSkill(r, 'warrior', 't_bowonly', activeFx({ category: 'attack', damageMult: 6, attackTypes: ['ranged'] }));
    const s = new GameSession(r, 22, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior')); // стартовое оружие — мили
    learn(p, 't_bowonly');
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
    learn(p, 't_stance');
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
    learn(p, 't_stance');
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
    learn(p, 't_a', 't_b');
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
    learn(p, 't_buff');
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
  const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
    { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(1));
  def.hp = 1e7; def.armor = 0; def.evade = 0; def.faction = faction;
  return { def, x, y };
}

describe('GameSession — аффинити фракций (фаза C)', () => {
  it('класс наносит больше урона монстрам своей аффинити-фракции', () => {
    // Изолируем БОНУС аффинити: монстр ВСЕГДА undead → одинаковый профиль ИИ/позиционирование и RNG-поток в обоих прогонах,
    // меняем ЛИШЬ аффинити класса. (Раньше меняли фракцию монстра undead↔beast, но фракция задаёт ещё и профиль ИИ (behaviorFor)
    // → монстр двигался иначе → разное число попаданий гасило чистый ×2 до ~1.55, и тест краснел без реального бага.)
    function totalDamage(hasAffinity: boolean): number {
      const r = reg();
      r.get('balance').affinityDamageBonus = 1; // ×2 по аффинити-фракции — явный сигнал
      const s = new GameSession(r, 30, 'normal');
      const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
      r.get('classes').find((c) => c.id === p.save.classId)!.affinity = hasAffinity ? ['undead'] : [];
      const grid = openField(20, 12);
      const spawn = cellToWorld(6, 6);
      const mp = cellToWorld(7, 6);
      s.enterFloor(1, { grid, spawn, monsters: [tankMon(r, mp.x, mp.y, 'undead')] });
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
    const withAff = totalDamage(true);  // аффинити (класс бьёт свою фракцию)
    const noAff = totalDamage(false);   // без аффинити (та же фракция, тот же ИИ) → разница только в бонусе
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
    learn(p, 't_heavy');
    const grid = openField(16, 12);
    const spawn = cellToWorld(6, 6);
    const mp = cellToWorld(7, 6); // прямо перед игроком (в дуге strike)
    s.enterFloor(1, { grid, spawn, monsters: [{ def: (() => { const d = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(3)); d.hp = 500; d.armor = 0; d.evade = 0; return d; })(), x: mp.x, y: mp.y }] });
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
    learn(p, 't_heavy2');
    const grid = openField(16, 12);
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid, spawn: cellToWorld(6, 6), monsters: [{ def: (() => { const d = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(4)); d.hp = 500; d.armor = 0; return d; })(), x: mp.x, y: mp.y }] });
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
    p.save.skills['t_set'] = 1; // узел вложен (ранг 1)
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
    const tree = r.get('skill-tree');
    const branch = tree.branches.find((b) => b.classId === 'zastupnik');
    expect(branch).toBeDefined();
    const nodes = tree.nodes.filter((n) => n.branchId === branch!.id);
    expect(nodes.length).toBeGreaterThanOrEqual(8);
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
    learn(p, atk.id);
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
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
      { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(9));
    def.hp = 5000; def.armor = 0; def.evade = 0; // танк, чтобы дожить до стана
    s.enterFloor(1, { grid, spawn, monsters: [{ def, x: mp.x, y: mp.y }] });
    const m = s.world.monsters[0]!;
    const hammer = r.get('skill-tree').nodes.find((n) => n.branchId === 'b-class-zastupnik'
      && ((n.effect.active as { stunSec?: number } | undefined)?.stunSec ?? 0) > 0)!;
    learn(p, hammer.id);
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
    save.skills['m_refl'] = 1;
    const p = s.addPlayer('p1', save);
    const mp = cellToWorld(7, 6);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
      { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(3));
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
      if (rank > 0) save.skills['m_bane'] = rank;
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

describe('GameSession — боевой айдл (combatTimer)', () => {
  it('своя атака → combatTimer>0, затем тает после линги', () => {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(3, 6), monsters: [] });
    for (let i = 0; i < 6; i++) s.tick(1 / 30, { p1: { ...idle, attack: true } });   // замах базовой атаки → в бою
    expect(p.combatTimer).toBeGreaterThan(0);
    const linger = r.get('balance').melee.combatLingerSec;
    for (let i = 0; i < Math.ceil((linger + 1) * 30); i++) s.tick(1 / 30, { p1: idle });   // стоим смирно дольше линги
    expect(p.combatTimer).toBe(0);   // вышли из боя
  });

  it('монстр аггрится на игрока → игрок «в бою»', () => {
    const r = reg();
    const s = new GameSession(r, 9, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const mp = cellToWorld(8, 6);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(4));
    s.enterFloor(1, { grid: openField(24, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    for (let i = 0; i < 120; i++) s.tick(1 / 30, { p1: idle });   // монстр рядом замечает игрока → chase → игрок в бою
    expect(p.combatTimer).toBeGreaterThan(0);
  });
});

describe('GameSession — уклонение (dodge-рывок)', () => {
  /** Игрок в большом открытом поле по центру. */
  function loneField(): { s: GameSession; p: ReturnType<GameSession['addPlayer']>; r: ConfigRegistry } {
    const r = reg();
    const s = new GameSession(r, 555, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(40, 40), spawn: cellToWorld(20, 20), monsters: [] });
    return { s, p, r };
  }

  it('пробел рвёт в направлении WASD на дистанцию из конфига', () => {
    const { s, p, r } = loneField();
    const dist = r.get('balance').dodge.distance;
    const startX = p.pos.x;
    const startY = p.pos.y;
    const ev = s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 }, dodge: true } });   // фронт нажатия
    expect(ev.some((e) => e.type === 'dodge')).toBe(true);
    expect(p.dash).not.toBeNull();
    for (let i = 0; i < 30 && p.dash; i++) s.tick(1 / 30, { p1: idle });   // рывок доезжает
    expect(p.dash).toBeNull();
    expect(p.pos.x - startX).toBeGreaterThan(dist * 0.7);   // уехал вправо близко к дистанции
    expect(Math.abs(p.pos.y - startY)).toBeLessThan(1);     // строго по X
  });

  it('стоя (без WASD) рывок идёт к прицелу (facing)', () => {
    const { s, p, r } = loneField();
    const dist = r.get('balance').dodge.distance;
    const startY = p.pos.y;
    s.tick(1 / 30, { p1: { ...idle, move: { x: 0, y: 0 }, facing: Math.PI / 2, dodge: true } });   // прицел вниз (+Y)
    for (let i = 0; i < 30 && p.dash; i++) s.tick(1 / 30, { p1: idle });
    expect(p.pos.y - startY).toBeGreaterThan(dist * 0.7);   // уехал вниз ~на дистанцию
  });

  it('кулдаун гейтит спам: второй рывок в окне КД не срабатывает, после КД — снова', () => {
    const { s, p, r } = loneField();
    const cd = r.get('balance').dodge.cooldownSec;
    const dist = r.get('balance').dodge.distance;
    s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 }, dodge: true } });
    for (let i = 0; i < 30 && p.dash; i++) s.tick(1 / 30, { p1: idle });   // домчали
    expect(p.dodgeCd).toBeGreaterThan(0);
    const xAfter1 = p.pos.x;
    const ev2 = s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 }, dodge: true } });   // ещё в КД
    expect(ev2.some((e) => e.type === 'dodge')).toBe(false);
    expect(p.dash).toBeNull();
    // Ждём истечения КД (стоим смирно), затем рвём снова.
    for (let i = 0; i < Math.ceil(cd * 30) + 2; i++) s.tick(1 / 30, { p1: idle });
    expect(p.dodgeCd).toBe(0);
    const ev3 = s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 }, dodge: true } });
    expect(ev3.some((e) => e.type === 'dodge')).toBe(true);
    for (let i = 0; i < 30 && p.dash; i++) s.tick(1 / 30, { p1: idle });
    expect(p.pos.x).toBeGreaterThan(xAfter1 + dist * 0.7);   // второй рывок реально сдвинул
  });

  it('стан блокирует уклонение', () => {
    const { s, p } = loneField();
    p.stunTimer = 1;
    const ev = s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 }, dodge: true } });
    expect(ev.some((e) => e.type === 'dodge')).toBe(false);
    expect(p.dash).toBeNull();
  });

  it('рывок НЕ разворачивает игрока: прыжок назад держит прицел (facing)', () => {
    const { s, p } = loneField();
    p.facing = 0;   // смотрит вправо (+X, к «врагу»)
    // Прыжок ВЛЕВО (от врага) с прицелом вправо: кайт-отскок, лицо не должно развернуться назад.
    s.tick(1 / 30, { p1: { ...idle, move: { x: -1, y: 0 }, facing: 0, dodge: true } });
    for (let i = 0; i < 30 && p.dash; i++) s.tick(1 / 30, { p1: { ...idle, facing: 0 } });
    expect(p.facing).toBeCloseTo(0, 5);   // прицел удержан (не atan2(0,-1)=π)
  });
});

describe('GameSession — нокдаун (сбить с ног)', () => {
  /** Игрок + один монстр вплотную справа (в радиусе взмаха). hp/weight/vision — по опциям. */
  function arena(opts?: { hp?: number; weight?: number; vision?: number }): { r: ConfigRegistry; s: GameSession; p: ReturnType<GameSession['addPlayer']>; m: import('../world/state.js').MonsterEntity } {
    const r = reg();
    const s = new GameSession(r, 42, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, createRng(3));
    def.hp = opts?.hp ?? 800; def.armor = 0;
    if (opts?.weight != null) def.weight = opts.weight;
    if (opts?.vision != null) def.vision = opts.vision;
    const mp = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mp.x, y: mp.y }] });
    return { r, s, p, m: s.world.monsters[0]! };
  }
  const face = (p: { pos: { x: number; y: number } }, m: { pos: { x: number; y: number } }): number => Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);

  it('сбитый с ног монстр беспомощен (рут, без атаки/регена) и восстаёт по таймеру', () => {
    const { s, p, m } = arena();
    m.downTimer = 0.5;
    const x0 = m.pos.x, y0 = m.pos.y;
    for (let i = 0; i < 6; i++) s.tick(1 / 30, { p1: { ...idle, facing: face(p, m) } });   // ~0.2с — ещё лежит
    expect(m.downTimer).toBeGreaterThan(0);
    expect(m.windup).toBeNull();                                        // не замахивается
    expect(Math.hypot(m.pos.x - x0, m.pos.y - y0)).toBeLessThan(1);     // рутнут (не идёт к игроку)
    expect(serializeWorld(s.world).monsters[0]!.downed).toBe(true);     // флаг в снапшоте
    for (let i = 0; i < 25; i++) s.tick(1 / 30, { p1: idle });          // добить таймер
    expect(m.downTimer).toBe(0);                                        // встал
    expect(serializeWorld(s.world).monsters[0]!.downed).toBe(false);
  });

  it('шанс роняет: chanceBase=1 → удар сбивает и поглощает стан (взаимоискл.)', () => {
    const { r, s, p, m } = arena();
    const kd = r.get('balance').knockdown;
    kd.chanceBase = 1; kd.maxChance = 1; kd.targetWeightResist = 0;   // гарантируем ролл
    const evs: SessionEvent[] = [];
    for (let i = 0; i < 90 && m.downTimer <= 0; i++) evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: face(p, m), attack: true } }));
    expect(m.downTimer).toBeGreaterThan(0);                            // сбит первым же попаданием
    expect(evs.some((e) => e.type === 'knockdown')).toBe(true);        // событие ушло
    expect(m.stunTimer).toBe(0);                                       // нокдаун вместо стана
  });

  it('нокдаун отталкивает монстра ОТ атакующего (авторитетный глайд позиции)', () => {
    const { r, s, p, m } = arena();
    const kd = r.get('balance').knockdown;
    kd.chanceBase = 1; kd.maxChance = 1; kd.targetWeightResist = 0;   // гарантируем ролл
    let xKnock = NaN;
    for (let i = 0; i < 90 && Number.isNaN(xKnock); i++) { s.tick(1 / 30, { p1: { ...idle, facing: face(p, m), attack: true } }); if (m.downTimer > 0) xKnock = m.pos.x; }
    expect(m.downTimer).toBeGreaterThan(0);
    expect(m.pos.x - p.pos.x).toBeGreaterThan(0);                     // санити: монстр справа от игрока → толкать вправо (+x)
    for (let i = 0; i < Math.ceil(kd.knockbackSec * 30) + 3; i++) s.tick(1 / 30, { p1: idle });   // прогон окна отлёта
    expect(m.pos.x).toBeGreaterThan(xKnock + 5);                      // сместился ДАЛЬШЕ вправо = ОТ игрока (сервер сам двигает pos)
    expect(m.knock).toBeNull();                                      // глайд отлёта завершился
  });

  it('лежачий уязвим: удар по нему бьёт сильнее (+vulnBonusPct)', () => {
    // Одна сессия (RNG непрерывен, без десинка): собираем урон по монстру не-лежачему и лежачему, сравниваем максимумы.
    const { r, s, p, m } = arena({ vision: 0, hp: 9_999_999 });   // слеп (не мешает ИИ-рнг) + бессмертен на время теста
    r.get('balance').knockdown.chanceBase = 0;   // изолируем: случайный нокдаун не должен вмешиваться (мы держим downed вручную)
    const collect = (downed: boolean, ticks: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < ticks; i++) {
        m.downTimer = downed ? 5 : 0;                          // держим нужное состояние (перед тиком; гейт не даёт встать)
        for (const e of s.tick(1 / 30, { p1: { ...idle, facing: face(p, m), attack: true } })) {
          if (e.type === 'hit' && e.target === 'monster' && e.hit && !e.blocked && e.amount > 0) out.push(e.amount);
        }
      }
      return out;
    };
    const up = collect(false, 400), down = collect(true, 400);
    const avg = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
    expect(up.length).toBeGreaterThan(5); expect(down.length).toBeGreaterThan(5);   // атака редкая: ~10 ударов за 400 тиков
    expect(avg(down)).toBeGreaterThan(avg(up) * 1.1);   // средний урон по лежачему выше (~×(1+vuln)=1.25), запас против крит-шума
  });
});

// ── Ресурсы вставок: магия берёт ману ───────────────────────────────────────────
describe(`GameSession — ${'⭐ ВСТАВКА ПЛАТИТ СВОИМ РЕСУРСОМ'}`, () => {
  /** Вставить вставку в гнездо узла: гнездо открывается рангом узла, сама вставка — рангом донора. */
  function socket(r: ConfigRegistry, save: ReturnType<typeof newBotSave>, nodeId: string, insertId: string): void {
    save.skills[nodeId] = 1;
    save.sockets = { ...(save.sockets ?? {}), [nodeId]: [insertId] };
    const donor = r.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === insertId)!;
    save.skills[donor.id] = 1;
  }
  /** Поле с игроком и одним впрыснутым скилом наготове. */
  function arena(r: ConfigRegistry, nodeId: string, insertId: string) {
    const s = new GameSession(r, 21, 'normal');
    const save = newBotSave(r, 'warrior');
    socket(r, save, nodeId, insertId);
    const p = s.addPlayer('p1', save);
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });
    return { s, p };
  }

  it('огонь в мече: выносливость как у голого скила, мана убывает', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_fire', activeFx({ category: 'attack', resource: 'stamina', manaCost: 6 }));
    const { s, p } = arena(r, 't_fire', 'ins-flame-edge');
    p.stamina = 30; p.mana = 25;   // ⚠ в пределах пулов воина (30/35) — иначе тик подрежет их к максимуму

    s.tick(1 / 30, { p1: { ...idle, cast: 't_fire' } });

    const extra = insertById(r, 'ins-flame-edge')!.cost;   // плоский ценник вставки, один на все скилы
    expect(p.stamina, 'выносливость — только цена носителя').toBeCloseTo(30 - 6, 0);
    expect(p.mana, 'а надбавка ушла в ману').toBeCloseTo(25 - extra, 0);
  });

  it('⭐ ПОГАСШАЯ ВСТАВКА: маны нет — удар всё равно проходит и мана не уходит в минус', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_fire', activeFx({ category: 'attack', resource: 'stamina', manaCost: 6 }));
    const { s, p } = arena(r, 't_fire', 'ins-flame-edge');
    p.stamina = 30; p.mana = 0;

    const evs = s.tick(1 / 30, { p1: { ...idle, cast: 't_fire' } });

    expect(evs.some((e) => e.type === 'swing' && e.ability === 't_fire'), 'скил сработал').toBe(true);
    expect(p.stamina, 'списана только выносливость носителя').toBeCloseTo(30 - 6, 0);
    expect(p.mana, 'мана не уходит в минус').toBeLessThan(0.5);
    expect(p.mana).toBeGreaterThanOrEqual(0);
  });

  it('не хватает СВОЕГО пула — скил не срабатывает вовсе (такого теста не было)', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_fire', activeFx({ category: 'attack', resource: 'stamina', manaCost: 6 }));
    const { s, p } = arena(r, 't_fire', 'ins-flame-edge');
    p.stamina = 1; p.mana = 25;

    const evs = s.tick(1 / 30, { p1: { ...idle, cast: 't_fire' } });

    expect(evs.some((e) => e.type === 'swing' && e.ability === 't_fire')).toBe(false);
    expect(p.mana, 'и вторая цена не списана').toBeGreaterThan(24.5);
  });

  it('на мана-скиле ценник вставки просто прибавляется к цене носителя', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_ward', activeFx({ category: 'attack', resource: 'mana', manaCost: 1 }));
    const { s, p } = arena(r, 't_ward', 'ins-ward');
    p.mana = 12;

    // ⚠ Печать кладётся не на нажатии, а по завершении ЗАМАХА (0.35 шага) — одного тика мало.
    for (let i = 0; i < 20; i++) s.tick(1 / 30, { p1: { ...idle, cast: 't_ward' } });

    expect(p.skillBuffs['ins:ins-ward'], 'печать сработала').toBeGreaterThan(0);
    expect(p.mana, 'один платёж: носитель плюс ценник вставки').toBeCloseTo(12 - 1 - insertById(r, 'ins-ward')!.cost, 0);
  });

  it('⭐ печать гаснет вместе со вставкой: на боевом скиле без маны прока нет, а удар есть', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_ward_s', activeFx({ category: 'attack', resource: 'stamina', manaCost: 4 }));
    const { s, p } = arena(r, 't_ward_s', 'ins-ward');
    p.stamina = 30; p.mana = 0;

    const evs: SessionEvent[] = [];
    for (let i = 0; i < 20; i++) evs.push(...s.tick(1 / 30, { p1: { ...idle, cast: 't_ward_s' } }));

    expect(evs.some((e) => e.type === 'swing' && e.ability === 't_ward_s'), 'удар прошёл').toBe(true);
    expect(p.skillBuffs['ins:ins-ward'], 'а печати нет — вставка не оплачена').toBeUndefined();
    expect(p.stamina, 'списана только цена носителя').toBeCloseTo(30 - 4, 0);
  });
});

describe('⚠ R4-05: кастуется только ВЫУЧЕННОЕ', () => {
  /** Воин 1-го уровня без единого скила (как новый герой) на пустом поле. */
  function fresh(seed: number) {
    const r = reg();
    const s = new GameSession(r, seed, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [] });
    s.tick(1 / 30, { p1: idle });   // первый снимок
    return { r, s, p };
  }
  const swings = (evs: SessionEvent[], id: string): number => evs.filter((e) => e.type === 'swing' && e.ability === id).length;

  it('⭐ невыученная атака не срабатывает и не тратит ресурс; выучил — та же команда бьёт', () => {
    const { s, p } = fresh(41);
    expect(p.save.skills, 'новый герой без скилов').toEqual({});
    let evs: SessionEvent[] = [];
    p.stamina = 20;
    evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 'b-axe1h-a1' } }));
    expect(p.stamina, 'ресурс не списан').toBeGreaterThanOrEqual(20);
    for (let i = 0; i < 60; i++) evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 'b-axe1h-a1' } }));
    expect(swings(evs, 'b-axe1h-a1'), 'невыученная атака').toBe(0);

    p.save.skills['b-axe1h-a1'] = 1;
    evs = [];
    for (let i = 0; i < 60; i++) { p.stamina = 50; evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 'b-axe1h-a1' } })); }
    expect(swings(evs, 'b-axe1h-a1'), 'выученная — бьёт').toBeGreaterThan(0);
  });

  it('⭐ невыученная аура не включается, невыученный бафф 40-го уровня не вешается', () => {
    const { s, p } = fresh(42);
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a1' } });
    expect(p.toggles, 'аура не включилась').toEqual([]);
    p.stamina = 50;
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-class-warrior-a5' } });
    expect(p.skillBuffs, 'бафф не повешен').toEqual({});

    p.save.skills['b-aura-a1'] = 1;
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a1' } });
    expect(p.toggles, 'выученная — включилась').toEqual(['b-aura-a1']);
  });

  it('⭐ сброс скилов гасит включённую ауру и бафф: бонусы и резерв уходят со следующего тика', () => {
    const { r, s, p } = fresh(43);
    const base = s.snapshotOf('p1')!.derived.damagePct;
    p.save.skills['b-aura-a1'] = 1;
    p.save.skills['b-class-warrior-a5'] = 1;
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-aura-a1' } });
    p.stamina = 50;
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-class-warrior-a5' } });
    s.tick(1 / 30, { p1: idle });
    expect(p.toggles).toEqual(['b-aura-a1']);
    expect(p.skillBuffs['b-class-warrior-a5']).toBeGreaterThan(0);
    expect(s.snapshotOf('p1')!.derived.damagePct, 'аура даёт урон').toBeGreaterThan(base);

    p.save.gold = 1_000_000;
    expect(respecSkills(r, p.save).ok).toBe(true);
    s.tick(1 / 30, { p1: idle });
    expect(p.toggles, 'аура погашена').toEqual([]);
    expect(p.skillBuffs, 'бафф снят').toEqual({});
    expect(s.snapshotOf('p1')!.derived.damagePct, 'бонус ауры ушёл').toBe(base);
    const maxMana = s.snapshotOf('p1')!.derived.maxMana;
    p.mana = 0;
    for (let i = 0; i < 3000; i++) s.tick(1 / 30, { p1: idle });
    expect(p.mana, 'резерв маны снят — пул снова полный').toBeCloseTo(maxMana, 5);
  });
});

describe('⚠ R4-07: рывок, его урон и отброс не проходят сквозь закрытую дверь и стену', () => {
  /** Поле 26×12 с перегородкой во всю высоту в столбце 10 (x 320..352). */
  function barrier(cell: Cell): Grid {
    const g = openField(26, 12);
    for (let y = 1; y < 11; y++) g[y]![10] = cell;
    return g;
  }

  for (const rank of [1, 5, 20]) {
    it(`⭐ рывок ранга ${rank} в закрытую дверь: герой на своей стороне, монстр в двух клетках за дверью цел`, () => {
      const r = reg();
      const s = new GameSession(r, 60 + rank, 'normal');
      const save = newBotSave(r, 'warrior');
      save.skills['b-shield-a2'] = rank;
      const p = s.addPlayer('p1', save);
      const behind = cellToWorld(12, 6);
      s.enterFloor(1, { grid: barrier(Cell.Door), spawn: cellToWorld(8, 6), monsters: [tankMon(r, behind.x, behind.y, 'undead')] });
      const m = s.world.monsters[0]!;
      for (let i = 0; i < 30; i++) s.tick(1 / 30, { p1: { ...idle, move: { x: 1, y: 0 } } });
      expect(p.pos.x, 'герой упёрся в дверь').toBeCloseTo(10 * TILE - p.radius, 6);
      m.pos = { ...behind }; m.vel = { x: 0, y: 0 };
      const hp0 = m.hp;
      const evs: SessionEvent[] = [];
      p.stamina = 50;
      evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 'b-shield-a2' } }));
      expect(evs.some((e) => e.type === 'swing' && e.ability === 'b-shield-a2'), 'рывок сработал').toBe(true);
      for (let i = 0; i < 30; i++) evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0 } }));
      expect(p.pos.x, 'не прошёл дверь').toBeLessThanOrEqual(10 * TILE - p.radius + 1e-6);
      expect(s.world.grid[6]![10], 'дверь закрыта').toBe(Cell.Door);
      expect(evs.some((e) => e.type === 'hit' && e.target === 'monster'), 'урон рывка не прошёл за дверь').toBe(false);
      expect(m.hp).toBe(hp0);
    });
  }

  it('⭐ отброс не выталкивает монстра сквозь стену в одну клетку', () => {
    const r = reg();
    r.get('balance').knockdown.enabled = false;   // проверяем отброс, а не падение
    injectSkill(r, 'warrior', 't_shove', activeFx({ category: 'attack', attackTypes: ['melee'], damageMult: 0.01, knockback: 400, shoveChance: 1 }));
    const s = new GameSession(r, 70, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    learn(p, 't_shove');
    const spawn = cellToWorld(8, 6);
    s.enterFloor(1, { grid: barrier(Cell.Wall), spawn, monsters: [tankMon(r, spawn.x + 20, spawn.y, 'undead')] });
    const m = s.world.monsters[0]!;
    let hit = false;
    for (let i = 0; i < 60 && !hit; i++) {
      p.mana = 100; p.stamina = 100;
      hit = s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_shove' } }).some((e) => e.type === 'hit' && e.target === 'monster' && e.hit);
    }
    expect(hit, 'удар прошёл').toBe(true);
    expect(m.pos.x, 'монстр у стены, а не за ней').toBeLessThanOrEqual(10 * TILE - m.radius + 1e-6);
  });
});

describe('⚠ R4-09: город безопасен — вход в него снимает дебаффы, стан и замах', () => {
  /** Герой на этаже `depth` с 5 HP, смертельным кровотечением и ядом, в стане и посреди замаха. */
  function doomed(seed: number) {
    const r = reg();
    const s = new GameSession(r, seed, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(3, { grid: openField(20, 12), spawn: cellToWorld(5, 5), monsters: [] });
    s.tick(1 / 30, { p1: idle });
    p.hp = 5;
    addDebuffStack(p.debuffs, { kind: 'bleed', chance: 1, mag: 40, maxStacks: 5, durationMs: 4000 }, s.world.timeMs);
    addDebuffStack(p.debuffs, { kind: 'poison', chance: 1, mag: 40, maxStacks: 5, durationMs: 4000 }, s.world.timeMs);
    p.stunTimer = 3;
    p.windup = { kind: 'attack', remaining: 1, loadout: '' };
    return { s, p };
  }

  it('⭐ смертельный DoT с этажа (или арены) не доезжает до города: жив, ни одного player-died', () => {
    const { s, p } = doomed(80);
    s.enterFloor(0, { grid: openField(20, 12), spawn: cellToWorld(3, 3), monsters: [] });   // город
    expect(p.debuffs, 'дебаффы сняты').toEqual({});
    expect(p.stunTimer).toBe(0);
    expect(p.windup).toBeNull();
    const evs: SessionEvent[] = [];
    for (let i = 0; i < 150; i++) evs.push(...s.tick(1 / 30, { p1: idle }));
    expect(p.alive).toBe(true);
    expect(evs.some((e) => e.type === 'player-died')).toBe(false);
  });

  it('следующий этаж подземелья — ещё бой: там дебаффы едут дальше', () => {
    const { s, p } = doomed(81);
    s.enterFloor(4, { grid: openField(20, 12), spawn: cellToWorld(3, 3), monsters: [] });
    expect(p.debuffs.bleed?.stacks).toBe(1);
    expect(p.debuffs.poison?.stacks).toBe(1);
  });
});

/**
 * ⚠ R5-02: здоровье не держится выше максимума, когда максимум упал. Максимум пересчитывался каждый тик, а текущее
 * только росло: надел +жизнь (или включил стойку), налился, снял — и «танковое» здоровье жило на стеклянной пушке весь
 * бой, через этажи и город. Мана и выносливость подрезались и раньше.
 */
describe('⚠ R5-02: здоровье не выше максимума — снял +жизнь, выключил стойку, сбросил живучесть', () => {
  /** Воин на пустом поле; первый снимок снят. */
  function hero(seed: number) {
    const r = reg();
    const s = new GameSession(r, seed, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [] });
    s.tick(1 / 30, { p1: idle });
    return { r, s, p };
  }
  /** Несколько тиков, в каждом — здоровье не выше максимума этого снимка. */
  function holds(s: GameSession, p: { hp: number; maxHp: number }, ticks: number, input: PlayerInput = idle): void {
    for (let i = 0; i < ticks; i++) {
      s.tick(1 / 30, { p1: input });
      expect(p.hp, `тик ${i}: ${p.hp} при максимуме ${p.maxHp}`).toBeLessThanOrEqual(p.maxHp);
    }
  }

  it('⭐ амулет +45 к жизни: надел, налился, снял — со следующего тика здоровье не выше нового максимума', () => {
    const { r, s, p } = hero(90);
    const max0 = p.maxHp;
    const base = r.get('items.base').find((b) => (b as { slot?: string }).slot === 'amulet' && b.enabled !== false)!;
    const amu = itemFromBaseId(r.get('items.base'), base.id, r.get('item-tiers'), 'drop')!;
    amu.affixes.push({ affixId: 'hearty', kind: 'prefix', modifier: { stat: 'maxHp', kind: 'flat', value: 45 } });
    amu.requirements = {};
    expect(addToInventory(p.save.inventory, amu, r.get('balance').inventory)).toBe(true);
    expect(equip(r, p.save, amu.uid).ok).toBe(true);
    s.tick(1 / 30, { p1: idle });
    expect(p.maxHp, 'амулет поднял максимум').toBe(max0 + 45);
    p.hp = p.maxHp;                                   // налился: зелье, реген, левелап — итог один
    expect(unequip(r, p.save, 'amulet').ok).toBe(true);
    holds(s, p, 90);
    expect(p.maxHp).toBe(max0);
    expect(p.hp, 'прибавка ушла вместе с амулетом').toBe(max0);
  });

  it('⭐ стойка +15 % к жизни: включил, налился, выключил — прибавка ушла со следующего тика', () => {
    const { s, p } = hero(91);
    const max0 = p.maxHp;
    p.save.skills['b-stance-a5'] = 1;
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-stance-a5' } });
    s.tick(1 / 30, { p1: idle });
    expect(p.toggles).toEqual(['b-stance-a5']);
    expect(p.maxHp, 'стойка подняла максимум').toBeGreaterThan(max0);
    p.hp = p.maxHp;
    holds(s, p, 1, { ...idle, cast: 'b-stance-a5' });   // выключил
    expect(p.toggles).toEqual([]);
    holds(s, p, 60);
    expect(p.maxHp).toBe(max0);
    expect(p.hp).toBe(max0);
  });

  it('⭐ сброс атрибутов из Живучести: максимум упал — упало и здоровье', () => {
    const { r, s, p } = hero(92);
    const max0 = p.maxHp;
    p.save.unspentAttributePoints = 20;
    expect(allocAttr(p.save, 'vitality', 20).ok).toBe(true);
    s.tick(1 / 30, { p1: idle });
    expect(p.maxHp, 'Живучесть подняла максимум').toBeGreaterThan(max0);
    p.hp = p.maxHp;
    p.save.gold = 1_000_000;
    expect(respec(r, p.save).ok).toBe(true);
    holds(s, p, 30);
    expect(p.maxHp).toBe(max0);
    expect(p.hp).toBe(max0);
  });

  it('раненого не лечит: здоровье ниже нового максимума остаётся как было (подрезка, а не выравнивание)', () => {
    const { s, p } = hero(93);
    p.save.unspentAttributePoints = 20;
    allocAttr(p.save, 'vitality', 20);
    s.tick(1 / 30, { p1: idle });
    p.hp = 10;
    const regen = s.snapshotOf('p1')!.derived.hpRegen;
    s.tick(1 / 30, { p1: idle });
    expect(p.hp).toBeCloseTo(10 + regen / 30, 6);
  });
});

/**
 * ⚠ R5-05: УДАР И КАСТ ИГРОКА НЕ ПРОХОДЯТ СКВОЗЬ СТЕНУ И ЗАКРЫТУЮ ДВЕРЬ. Монстр отвечает только по прямой видимости
 * (удар и выстрел её требуют), а нова, земля, метеор, бумеранг и проклятие игрока видимости не спрашивали: маг из
 * коридора выжигал комнату босса за запертой рычагом дверью, и никто не мог ему ответить. Туда же — ближний удар
 * длинным древком, рывок вдоль тонкой стены и прыжок в стену (R4-07 оставил их урон без проверки видимости).
 */
describe('⚠ R5-05: удар и каст игрока не проходят сквозь стену и закрытую дверь', () => {
  /** Поле 30×13 с перегородкой во всю высоту в столбце 12 (x 384..416) из `cell`. */
  function split(cell: Cell): Grid {
    const g = openField(30, 13);
    for (let y = 1; y < 12; y++) g[y]![12] = cell;
    return g;
  }
  /** Герой класса `cls` у перегородки (столбец 10), неубиваемый монстр за ней (столбец 14), скилл `nodeId` выучен. */
  function across(seed: number, cls: string, nodeId: string, layout: Partial<FloorLayout> = {}, r = reg()) {
    const s = new GameSession(r, seed, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, cls));
    p.save.skills[nodeId] = 5;
    const behind = cellToWorld(14, 6);
    s.enterFloor(1, { grid: split(Cell.Wall), spawn: cellToWorld(10, 6), monsters: [tankMon(r, behind.x, behind.y, 'undead')], ...layout });
    return { r, s, p, m: s.world.monsters[0]! };
  }
  /** Жмёт каст каждый второй тик `ticks` тиков с полным ресурсом; события — все. */
  function castFor(s: GameSession, p: { mana: number; stamina: number }, nodeId: string, ticks: number): SessionEvent[] {
    const evs: SessionEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      p.mana = 999; p.stamina = 999;
      evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: i % 2 === 0 ? nodeId : null } }));
    }
    return evs;
  }
  const swings = (evs: SessionEvent[], id: string): number => evs.filter((e) => e.type === 'swing' && e.ability === id).length;
  const monsterHits = (evs: SessionEvent[]): number => evs.filter((e) => e.type === 'hit' && e.target === 'monster').length;

  for (const nodeId of ['b-class-mage-a2', 'b-fire-a2', 'b-fire-a1']) {
    it(`⭐ ${nodeId} сквозь стену в клетку: скилл срабатывает, а монстр за стеной цел и без статусов`, () => {
      const { s, p, m } = across(100, 'mage', nodeId);
      const hp0 = m.hp;
      const evs = castFor(s, p, nodeId, 300);
      expect(swings(evs, nodeId), 'скилл кастовался').toBeGreaterThan(0);
      expect(monsterHits(evs), 'ни одного попадания за стену').toBe(0);
      expect(m.hp).toBe(hp0);
      expect(m.debuffs).toEqual({});
    });
  }

  it('⭐ проклятие не вешается сквозь стену', () => {
    const { s, p, m } = across(101, 'mage', 'b-curse-a4');
    const evs = castFor(s, p, 'b-curse-a4', 30);
    expect(swings(evs, 'b-curse-a4')).toBeGreaterThan(0);
    expect(m.debuffs, 'яд проклятия за стеной не висит').toEqual({});
  });

  it('контроль: без перегородки та же нова, тот же бумеранг и то же проклятие достают', () => {
    for (const nodeId of ['b-class-mage-a2', 'b-fire-a1', 'b-curse-a4']) {
      const { s, p, m } = across(102, 'mage', nodeId, { grid: openField(30, 13) });
      const hp0 = m.hp;
      const evs = castFor(s, p, nodeId, 120);
      if (nodeId === 'b-curse-a4') { expect(m.debuffs.poison, nodeId).toBeTruthy(); continue; }
      expect(monsterHits(evs), nodeId).toBeGreaterThan(0);
      expect(m.hp, nodeId).toBeLessThan(hp0);
    }
  });

  it('⭐ бумеранг о стену разворачивается к владельцу и гаснет у него, а не улетает сквозь', () => {
    const { s, p } = across(103, 'mage', 'b-fire-a1');
    castFor(s, p, 'b-fire-a1', 1);
    for (let i = 0; i < 30 && !s.world.projectiles.length; i++) s.tick(1 / 30, { p1: idle });   // каст-тайм
    expect(s.world.projectiles.length, 'бумеранг вылетел').toBe(1);
    let maxX = 0;
    for (let i = 0; i < 200 && s.world.projectiles.length; i++) {
      s.tick(1 / 30, { p1: idle });
      for (const pr of s.world.projectiles) maxX = Math.max(maxX, pr.pos.x);
    }
    expect(maxX, 'не залетел в стену').toBeLessThan(12 * TILE);
    expect(s.world.projectiles.length, 'вернулся и погас').toBe(0);
  });

  it('⭐ закрытая дверь рычага держит нову; рычаг дёрнут — та же нова достаёт', () => {
    const doorCells = Array.from({ length: 11 }, (_, i) => ({ cx: 12, cy: i + 1 }));
    const lever = cellToWorld(10, 5);
    const { s, p, m } = across(104, 'mage', 'b-class-mage-a2', {
      grid: split(Cell.Door), doors: [{ id: 1, cells: doorCells }], levers: [{ id: 7, x: lever.x, y: lever.y, doorId: 1 }],
    });
    const hp0 = m.hp;
    const shut = castFor(s, p, 'b-class-mage-a2', 90);
    expect(swings(shut, 'b-class-mage-a2')).toBeGreaterThan(0);
    expect(monsterHits(shut), 'сквозь закрытую дверь — ничего').toBe(0);
    expect(m.hp).toBe(hp0);
    p.pos = cellToWorld(10, 6);
    expect(s.openLever('p1', 7), 'рычаг открыл дверь').toBe(1);
    m.pos = cellToWorld(14, 6); m.vel = { x: 0, y: 0 };
    const open = castFor(s, p, 'b-class-mage-a2', 90);
    expect(monsterHits(open), 'дверь открыта — попадает').toBeGreaterThan(0);
    expect(m.hp).toBeLessThan(hp0);
  });

  it('⭐ PvP: нова и проклятие не достают соперника за стеной', () => {
    const r = reg();
    const s = new GameSession(r, 105, 'normal');
    const p1 = s.addPlayer('p1', newBotSave(r, 'mage'));
    const p2 = s.addPlayer('p2', newBotSave(r, 'warrior'));
    p1.save.skills['b-class-mage-a2'] = 5; p1.save.skills['b-curse-a4'] = 5;
    s.enterFloor(1, { grid: split(Cell.Wall), spawn: cellToWorld(10, 6), monsters: [], pvp: true });
    p1.pos = cellToWorld(11, 6); p2.pos = cellToWorld(13, 6);
    const evs: SessionEvent[] = [];
    for (let i = 0; i < 120; i++) {
      p1.mana = 999;
      const cast = i % 4 === 0 ? 'b-class-mage-a2' : i % 4 === 2 ? 'b-curse-a4' : null;
      evs.push(...s.tick(1 / 30, { p1: { ...idle, cast }, p2: idle }));
    }
    expect(swings(evs, 'b-class-mage-a2')).toBeGreaterThan(0);
    expect(swings(evs, 'b-curse-a4')).toBeGreaterThan(0);
    expect(evs.filter((e) => e.type === 'hit' && e.target === 'player').length, 'соперник за стеной не задет').toBe(0);
    expect(p2.debuffs).toEqual({});
  });

  it('⭐ ближний удар пикой (досягаемость ×1.8) не проходит стену в клетку; без стены — проходит', () => {
    for (const walled of [true, false]) {
      const r = reg();
      const s = new GameSession(r, 106, 'normal');
      const save = newBotSave(r, 'warrior');
      save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'pike', r.get('item-tiers'), 'drop')!;
      const p = s.addPlayer('p1', save);
      const at = { x: 12 * TILE - p.radius - 1, y: cellToWorld(0, 6).y };
      const mx = 13 * TILE + 13;
      s.enterFloor(1, { grid: walled ? split(Cell.Wall) : openField(30, 13), spawn: at, monsters: [tankMon(r, mx, at.y, 'undead')] });
      const m = s.world.monsters[0]!;
      const evs: SessionEvent[] = [];
      for (let i = 0; i < 60; i++) {
        p.pos = { ...at }; m.pos = { x: mx, y: at.y }; m.vel = { x: 0, y: 0 };
        evs.push(...s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } }));
      }
      expect(evs.some((e) => e.type === 'swing' && e.ability === 'attack'), 'удар был').toBe(true);
      if (walled) expect(monsterHits(evs), 'сквозь стену — ничего').toBe(0);
      else expect(monsterHits(evs), 'в открытую — достаёт').toBeGreaterThan(0);
    }
  });

  it('⭐ прыжок в стену: удар приземления не достаёт монстра за ней', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_leap', activeFx({ category: 'cast', shape: 'leap', radius: 120, dashDist: 150, damageMult: 3 }));
    const { s, p, m } = across(107, 'warrior', 't_leap', {}, r);
    const hp0 = m.hp;
    const evs = castFor(s, p, 't_leap', 60);
    expect(swings(evs, 't_leap')).toBeGreaterThan(0);
    expect(monsterHits(evs)).toBe(0);
    expect(m.hp).toBe(hp0);
  });

  it('⭐ рывок вдоль тонкой стены не рубит монстра по ту сторону', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_dash', activeFx({ category: 'cast', shape: 'dash', damageMult: 3, dashDist: 130, dashSpeed: 700 }));
    const s = new GameSession(r, 108, 'normal');
    const save = newBotSave(r, 'warrior');
    // Широкий и длинный замах: полуширина коридора рывка больше двух клеток — раньше доставал через стену.
    save.equipment.weapon = { ...save.equipment.weapon!, reachMult: 2, arcMult: 1.5 };
    const p = s.addPlayer('p1', save);
    learn(p, 't_dash');
    const g = openField(30, 13);
    for (let x = 1; x < 29; x++) g[6]![x] = Cell.Wall;           // стена во всю ширину по строке 6
    const mp = cellToWorld(8, 7);
    s.enterFloor(1, { grid: g, spawn: cellToWorld(5, 5), monsters: [tankMon(r, mp.x, mp.y, 'undead')] });
    const m = s.world.monsters[0]!;
    const hp0 = m.hp;
    p.mana = 999;
    const evs = s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: 't_dash' } });
    expect(swings(evs, 't_dash'), 'рывок сработал').toBe(1);
    expect(monsterHits(evs)).toBe(0);
    expect(m.hp).toBe(hp0);
  });
});

/**
 * ⚠ R5-06: ДОБИТОЕ СТАТУСОМ — ТОМУ, КТО СТАТУС ПОВЕСИЛ. Смерть от тика кровотечения, яда или поджига записывалась первому
 * в комнате: опыт, левелапы, «Уничтожить N» и лечение за убийство уходили хозяину — простаивающему у входа или вовсе
 * мёртвому альту, — а игрок статус-билда, вошедший вторым, не получал ничего. Тот же ярлык брал шум брони хозяина.
 */
describe('⚠ R5-06: добитое статусом — тому, кто статус повесил', () => {
  /** Хозяин (вошёл первым) и основной герой-маг с проклятием яда; монстр на 500 опыта у основного. */
  function coop(seed: number) {
    const r = reg();
    const s = new GameSession(r, seed, 'normal', { rewards: true });
    const host = s.addPlayer('host', newBotSave(r, 'mage'));
    const main = s.addPlayer('main', newBotSave(r, 'mage'));
    // У каждого героя комнаты свой charId (комната держит ровно одну сущность на charId); боты сима все — 'bot'.
    host.save.charId = 'char-host'; main.save.charId = 'char-main';
    main.save.skills['b-curse-a4'] = 1;
    const mp = cellToWorld(20, 6);
    const mon = tankMon(r, mp.x, mp.y, 'undead');
    mon.def.hp = 30; mon.def.xp = 500; mon.def.hpRegen = 0;
    s.enterFloor(1, { grid: openField(30, 13), spawn: cellToWorld(3, 6), monsters: [mon] });
    main.pos = cellToWorld(18, 6);
    return { r, s, host, main, m: s.world.monsters[0]! };
  }
  /** Тикает до смерти монстра; основной герой не умирает (здоровье доливается), хозяин стоит. */
  function untilDead(s: GameSession, main: { hp: number; maxHp: number; mana: number }, m: { alive: boolean }, first: PlayerInput, ids = ['host', 'main']): SessionEvent[] {
    const evs: SessionEvent[] = [];
    for (let i = 0; i < 600 && m.alive; i++) {
      main.hp = main.maxHp; main.mana = 999;
      const inputs: Record<string, PlayerInput> = {};
      for (const id of ids) inputs[id] = id === 'main' && i === 0 ? first : idle;
      evs.push(...s.tick(1 / 30, inputs));
    }
    return evs;
  }
  const died = (evs: SessionEvent[]) => evs.find((e) => e.type === 'monster-died') as Extract<SessionEvent, { type: 'monster-died' }> | undefined;
  const xpTo = (evs: SessionEvent[], id: string): number => evs.filter((e) => e.type === 'xp' && e.playerId === id).reduce((a, e) => a + (e as { amount: number }).amount, 0);

  for (const hostDead of [true, false]) {
    it(`⭐ яд проклятия второго героя добил монстра — убийство и опыт его; хозяин (${hostDead ? 'мёртв' : 'жив, стоит у входа'}) не получает ничего`, () => {
      const { s, host, main, m } = coop(hostDead ? 110 : 111);
      if (hostDead) { host.alive = false; host.hp = 0; }
      const evs = untilDead(s, main, m, { ...idle, cast: 'b-curse-a4' });
      expect(m.alive, 'яд добил').toBe(false);
      expect(evs.some((e) => e.type === 'hit' && e.target === 'monster'), 'прямого удара не было — только яд').toBe(false);
      expect(died(evs)?.by).toBe('main');
      expect(xpTo(evs, 'main')).toBe(500);
      expect(xpTo(evs, 'host')).toBe(0);
      expect(host.save.xp).toBe(0);
      expect(main.save.xp).toBe(500);
    });
  }

  it('⭐ кровотечение от удара оружием (через попадание) — тоже тому, кто ударил', () => {
    const r = reg();
    injectSkill(r, 'warrior', 't_bleed', activeFx({ category: 'attack', damageMult: 1, ailment: { kind: 'bleed', chance: 1, mag: 5, maxStacks: 5, durationMs: 4000 } }));
    const s = new GameSession(r, 112, 'normal', { rewards: true });
    const host = s.addPlayer('host', newBotSave(r, 'warrior'));
    const main = s.addPlayer('main', newBotSave(r, 'warrior'));
    learn(main, 't_bleed');
    const mp = cellToWorld(20, 6);
    const mon = tankMon(r, mp.x, mp.y, 'undead');
    mon.def.xp = 500; mon.def.hpRegen = 0;
    s.enterFloor(1, { grid: openField(30, 13), spawn: cellToWorld(3, 6), monsters: [mon] });
    const m = s.world.monsters[0]!;
    main.pos = { x: mp.x - 30, y: mp.y };
    for (let i = 0; i < 120 && !m.debuffs.bleed; i++) {
      main.hp = main.maxHp; main.stamina = 999; main.mana = 999;
      s.tick(1 / 30, { host: idle, main: { ...idle, facing: 0, cast: 't_bleed' } });
    }
    expect(m.debuffs.bleed, 'кровотечение повешено ударом').toBeTruthy();
    m.hp = 0.01;                                        // следующий тик кровотечения добивает
    const evs = s.tick(1 / 30, { host: idle, main: idle });
    expect(m.alive).toBe(false);
    expect(died(evs)?.by).toBe('main');
    expect(xpTo(evs, 'main')).toBe(500);
    expect(host.save.xp).toBe(0);
  });

  it('повесивший ушёл из комнаты — добитое статусом не засчитывается никому (и не первому в комнате)', () => {
    const { s, host, main, m } = coop(113);
    for (let i = 0; i < 40 && !m.debuffs.poison; i++) {
      main.mana = 999; main.hp = main.maxHp;
      s.tick(1 / 30, { host: idle, main: { ...idle, cast: i === 0 ? 'b-curse-a4' : null } });
    }
    expect(m.debuffs.poison, 'яд повешен').toBeTruthy();
    s.removePlayer('main');
    const evs = untilDead(s, host, m, idle, ['host']);
    expect(m.alive).toBe(false);
    expect(died(evs)?.by).toBeUndefined();
    expect(xpTo(evs, 'host')).toBe(0);
    expect(host.save.xp).toBe(0);
  });

  /**
   * ⚠ R9-06: УШЁЛ ХОЗЯИН СТАТУСА — НАГРАДЫ НЕТ, НО ДОБЫЧА ПАДАЕТ. Добитое ядом или кровотечением ушедшего (разрыв, выход) не
   * давало вовсе ничего: `killMonster` без убийцы выходил до бросков золота, сырья, колб и вещей, а запись узла помечала
   * монстра убитым навсегда — партия, оставшаяся в комнате, теряла добычу босса, и лишить её было можно нарочно: повесил
   * яд — вышел. Теперь без убийцы нет только его наград (опыт, лечение за убийство, «Уничтожить N»); добыча — та же и в том
   * же порядке бросков, что при нём.
   */
  it('⭐ R9-06: повесивший ушёл — опыта и убийства нет, а добыча падает та же, что при нём', () => {
    const run = (away: boolean) => {
      const r = reg();
      const loot = r.get('balance').loot;
      loot.goldChance = 1; loot.dropChance = 1; loot.materials.chance = 1; loot.potions.chance = 1;
      const s = new GameSession(r, 118, 'normal', { rewards: true });
      const host = s.addPlayer('host', newBotSave(r, 'mage'));
      const main = s.addPlayer('main', newBotSave(r, 'mage'));
      host.save.charId = 'char-host'; main.save.charId = 'char-main';
      const mp = cellToWorld(20, 6);
      const mon = tankMon(r, mp.x, mp.y, 'undead');
      mon.def.xp = 500; mon.def.hpRegen = 0;
      s.enterFloor(1, { grid: openField(30, 13), spawn: cellToWorld(3, 6), monsters: [mon] });
      main.pos = cellToWorld(3, 10);
      const m = s.world.monsters[0]!;
      addDebuffStack(m.debuffs, { kind: 'poison', chance: 1, maxStacks: 1, durationMs: 60_000, mag: 50 }, s.world.timeMs);
      m.dotBy = { poison: 'main' }; m.dotHero = { poison: 'char-main' };
      m.hp = 0.01;                                        // следующий тик яда добивает
      if (away) s.removePlayer('main');
      const evs = s.tick(1 / 30, away ? { host: idle } : { host: idle, main: idle });
      // Что упало — без мест (разлёт «прочь от убийцы» у ушедшего не от кого) и без uid вещей (их даёт не кубик).
      const drops = s.world.drops.map((d) => JSON.stringify({ ...d, pos: undefined, id: undefined }, (k, v) => (k === 'uid' ? undefined : v)));
      return { m, evs, host, main, drops };
    };
    const here = run(false), gone = run(true);
    expect(here.m.alive).toBe(false);
    expect(died(here.evs)?.by).toBe('main');
    expect(xpTo(here.evs, 'main')).toBe(500);
    expect(here.drops.length, 'при хозяине — золото, сырьё, колба, вещь').toBeGreaterThanOrEqual(3);

    expect(gone.m.alive).toBe(false);
    expect(died(gone.evs)?.by, 'убийства никому').toBeUndefined();
    expect(gone.evs.some((e) => e.type === 'xp'), 'опыта никому').toBe(false);
    expect(gone.host.save.xp).toBe(0);
    expect(gone.drops, 'было: ни золота, ни вещи — добыча босса пропадала для всей партии').toEqual(here.drops);
    expect(gone.evs.filter((e) => e.type === 'item-dropped').length).toBe(here.evs.filter((e) => e.type === 'item-dropped').length);
  });

  /**
   * ⚠ R7-07: ВЕРНУЛСЯ — ЭТО ТОТ ЖЕ ГЕРОЙ. Комната даёт каждому входу новый id (`p_<uuid>`), и хозяин статуса, отвалившийся
   * и вернувшийся («Продолжить»; соло-комната на грейсе стоит, и яд ждёт его), искался по старому id: добитое ядом уходило
   * «никому» — ни опыта, ни добычи, ни «Уничтожить N», а запись узла помечала монстра убитым навсегда (босс — с его уником).
   */
  for (const same of [true, false]) {
    it(`⭐ R7-07: повесивший вернулся под новым id (${same ? 'тот же объект сейва' : 'сейв из базы'}) — добитое ядом его`, () => {
      const { s, host, main, m } = coop(116);
      for (let i = 0; i < 40 && !m.debuffs.poison; i++) {
        main.mana = 999; main.hp = main.maxHp;
        s.tick(1 / 30, { host: idle, main: { ...idle, cast: i === 0 ? 'b-curse-a4' : null } });
      }
      expect(m.debuffs.poison, 'яд повешен').toBeTruthy();
      const at = { ...main.pos };
      s.removePlayer('main');
      const save = same ? main.save : structuredClone(main.save);
      const back = s.addPlayer('main-2', save, at);
      const evs = untilDead(s, back, m, idle, ['host', 'main-2']);
      expect(m.alive).toBe(false);
      expect(died(evs)?.by, 'было: undefined — смерть без наград').toBe('main-2');
      expect(xpTo(evs, 'main-2')).toBe(500);
      expect(save.xp).toBe(500);
      expect(xpTo(evs, 'host'), 'соседу — ничего').toBe(0);
      expect(host.save.xp).toBe(0);
    });
  }

  it('R7-07: при хозяине статуса на месте — решает его id, а не совпавший charId соседа (боты сима все «bot»)', () => {
    const { s, host, main, m } = coop(117);
    host.save.charId = main.save.charId;               // как у ботов сима: charId один на всех
    const evs = untilDead(s, main, m, { ...idle, cast: 'b-curse-a4' });
    expect(died(evs)?.by).toBe('main');
    expect(host.save.xp).toBe(0);
  });

  it('⭐ шум брони — у ЦЕЛИ монстра, а не у первого в комнате: латник-хозяин вдали не делает тихого соседа слышным', () => {
    for (const [hostPlate, mainPlate, heard] of [[true, false, false], [false, true, true]] as const) {
      const r = reg();
      (r.get('armor-classes').find((c) => c.id === 'plate') as { noise: number }).noise = 0.8;   // латы: слышно ×1.8
      const s = new GameSession(r, 114, 'normal');
      const host = s.addPlayer('host', newBotSave(r, 'warrior'));
      const main = s.addPlayer('main', newBotSave(r, 'warrior'));
      const plate = itemFromBaseId(r.get('items.base'), 'plate-armor', r.get('item-tiers'), 'drop')!;
      if (hostPlate) host.save.equipment.chest = plate;
      if (mainPlate) main.save.equipment.chest = plate;
      const mp = cellToWorld(20, 6);
      const mon = tankMon(r, mp.x, mp.y, 'undead');
      mon.def.hearing = 100; mon.def.vision = 0;             // только слух
      s.enterFloor(1, { grid: openField(30, 13), spawn: cellToWorld(2, 2), monsters: [mon] });
      host.pos = cellToWorld(2, 2);
      main.pos = { x: mp.x - 150, y: mp.y };                 // 150: тихого не слышно (100), латника — да (180)
      const m = s.world.monsters[0]!;
      for (let i = 0; i < 5; i++) { m.pos = { ...mp }; s.tick(1 / 30, { host: idle, main: idle }); }
      expect(m.aiState, `латы: хозяин ${hostPlate}, сосед ${mainPlate}`).toBe(heard ? 'chase' : 'idle');
    }
  });
});

/**
 * ⭐ R9-02: ПОТОК БРОСКОВ СЕССИИ — ВНЕДРЯЕМЫЙ. У комнаты сервера поток сессии был mulberry32 с 32-битным состоянием, и его
 * выход виден с первого снимка (взгляд каждого монстра — `rng.float(0, 2π)`): состояние подбиралось перебором за секунды,
 * а дальше изменённый клиент считал сундук и дроп наперёд тем же `GameSession` и крутил их ударами в воздух (удар — ровно
 * один бросок). Сессия берёт источник из опций — сервер кормит её криптоисточником (`sessionRng`); сим, боты, тесты и клиент
 * по-прежнему сеют mulberry32 — их воспроизводимость на сиде не меняется.
 */
describe('⭐ R9-02: поток бросков сессии — внедряемый', () => {
  /** Источник по списку чисел — тот же интерфейс, что у `createRng`. */
  function listRng(vals: readonly number[]) {
    let k = 0;
    const next = (): number => vals[k++ % vals.length]!;
    return {
      next,
      int: (a: number, b: number) => Math.floor(next() * (b - a + 1)) + a,
      float: (a: number, b: number) => next() * (b - a) + a,
      pick: <T,>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)]!,
      chance: (p: number) => next() < p,
    };
  }
  const floorOf = (r: ConfigRegistry): FloorLayout => ({
    grid: openField(30, 13), spawn: cellToWorld(3, 6),
    monsters: [10, 12, 14].map((cx) => { const p = cellToWorld(cx, 6); return tankMon(r, p.x, p.y, 'undead'); }),
  });

  it('⭐ источник из опций ведёт броски сессии: взгляды заселения — его числа, а не поток сида', () => {
    const r = reg();
    const vals = [0.125, 0.5, 0.875];
    const s = new GameSession(r, 5, 'normal', { rng: listRng(vals) });
    s.enterFloor(1, floorOf(r));
    expect(s.world.monsters.map((m) => m.facing), 'было: опция не читалась — поток сида').toEqual(vals.map((v) => v * Math.PI * 2));
  });

  it('без источника — сидовый mulberry32, как было: сим и тесты на сиде воспроизводимы', () => {
    const r = reg();
    const s = new GameSession(r, 5, 'normal');
    s.enterFloor(1, floorOf(r));
    const ref = createRng(5);
    expect(s.world.monsters.map((m) => m.facing)).toEqual([0, 1, 2].map(() => ref.float(0, Math.PI * 2)));
  });
});

/**
 * ⚠ R6-02: ЗАМАХ ПОМНИТ, ЧЕМ ОН НАЧАТ. Скорость удара решается на старте замаха, а урон считался на ударе — по ЖИВОМУ сейву.
 * Команды экипировки и гнёзд ходят где угодно (scope 'any') и приходят между тиками: изменённый клиент замахивался кинжалом
 * и бил молотом (темп кинжала, урон/дальность/вес молота — ×1.17–1.25 к лучшему честному), кастовал с пустыми гнёздами
 * (цена голого скила) и вставлял «пламенное лезвие» до удара — огонь без маны; та же щель — аура скорости на замахе и аура
 * урона к удару. Теперь снаряжение или ауры сменились за замах — удар пропал (цена и откат уже списаны); вставки удара — те,
 * что оплачены на касте.
 */
describe('⚠ R6-02: смена снаряжения, аур и вставок за время замаха не доезжает до удара', () => {
  /** Воин (все атрибуты 120) с кинжалом в руке, молотом и кольцом в сумке; перед ним неубиваемый манекен без уворота. */
  function rig(seed: number, mut?: (r: ConfigRegistry) => void) {
    const r = reg();
    mut?.(r);
    const s = new GameSession(r, seed, 'normal');
    const save = newBotSave(r, 'warrior');
    for (const k of Object.keys(save.attributes) as (keyof typeof save.attributes)[]) save.attributes[k] = 120;
    delete save.equipment.offhand;
    const tiers = r.get('item-tiers');
    const [dagger, maul, ring] = ['dagger', 'maul', 'simple-ring'].map((id) => itemFromBaseId(r.get('items.base'), id, tiers, 'drop')!);
    save.inventory = [];
    for (const it of [dagger!, maul!, ring!]) expect(addToInventory(save.inventory, it, r.get('balance').inventory)).toBe(true);
    expect(equip(r, save, dagger!.uid).ok).toBe(true);
    const p = s.addPlayer('p1', save);
    const spawn = cellToWorld(6, 6);
    const at = { x: spawn.x + 34, y: spawn.y };
    s.enterFloor(1, { grid: openField(20, 12), spawn, monsters: [tankMon(r, at.x, at.y, 'beast')] });
    const m = s.world.monsters[0]!;
    /** Тик с манекеном на месте (ИИ его не уводит) и полными пулами. */
    const tick = (input: PlayerInput): SessionEvent[] => { m.pos = { ...at }; p.pos = { ...spawn }; return s.tick(1 / 30, { p1: { ...input, facing: 0 } }); };
    /** Дотикать, пока идёт замах (и ещё кадр), — всё, что он успел нанести. */
    const settle = (): SessionEvent[] => { const evs: SessionEvent[] = []; for (let i = 0; i < 90 && (i === 0 || p.windup); i++) evs.push(...tick(idle)); return evs; };
    return { r, s, p, save, dagger: dagger!, maul: maul!, ring: ring!, tick, settle };
  }
  const monsterHits = (evs: SessionEvent[]) => evs.filter((e): e is Extract<SessionEvent, { type: 'hit' }> => e.type === 'hit' && e.target === 'monster');

  it('⭐ замах кинжалом, молот в руку до удара — удар пропал; честный замах тем же кинжалом — попал', () => {
    for (const swap of [false, true]) {
      const { r, p, save, maul, tick, settle } = rig(61);
      const evs = tick({ ...idle, attack: true });
      expect(evs.some((e) => e.type === 'swing' && e.ability === 'attack'), 'замах пошёл').toBe(true);
      expect(p.windup, 'удар — по завершении замаха').not.toBeNull();
      if (swap) expect(equip(r, save, maul.uid).ok, 'команда города между тиками').toBe(true);
      const hits = monsterHits(settle());
      if (swap) expect(hits, 'ни урона молота темпом кинжала, ни удара вообще').toEqual([]);
      else expect(hits.length, 'контроль: без подмены удар есть').toBe(1);
    }
  });

  it('⭐ смена ЛЮБОЙ надетой вещи за замах гасит удар: кольцо на скорость на замахе, на урон — к удару', () => {
    const { r, save, ring, tick, settle } = rig(62);
    tick({ ...idle, attack: true });
    expect(equip(r, save, ring.uid).ok).toBe(true);
    expect(monsterHits(settle())).toEqual([]);
    // Следующий замах — уже с кольцом с самого начала: бьёт как обычно.
    const after: SessionEvent[] = [];
    for (let i = 0; i < 90; i++) after.push(...tick({ ...idle, attack: true }));
    expect(monsterHits(after).length, 'удары вернулись со следующего замаха').toBeGreaterThan(0);
  });

  it('⭐ аура скорости на замахе, аура урона к удару (тогл — вводом в любой кадр) — удар пропал', () => {
    for (const swap of [false, true]) {
      const { p, tick, settle } = rig(67);
      learn(p, 'b-aura-a5', 'b-aura-a1');
      tick({ ...idle, cast: 'b-aura-a5' });
      for (let i = 0; i < 30; i++) tick(idle);   // аура включена задолго до замаха
      expect(p.toggles).toEqual(['b-aura-a5']);
      tick({ ...idle, attack: true });
      expect(p.windup).not.toBeNull();
      const evs = swap ? tick({ ...idle, cast: 'b-aura-a1' }) : [];
      if (swap) expect(p.toggles, 'эксклюзив-группа: скорость сменилась уроном').toEqual(['b-aura-a1']);
      const hits = monsterHits([...evs, ...settle()]);
      if (swap) expect(hits, 'темп ауры скорости с уроном ауры урона не бьёт').toEqual([]);
      else expect(hits.length, 'контроль').toBe(1);
    }
  });

  it('⭐ каст, который разрешает только кинжал: за каст-тайм молот в руку — каст не исполнился', () => {
    for (const swap of [false, true]) {
      const { r, p, save, maul, tick, settle } = rig(63, (rr) => injectSkill(rr, 'warrior', 't_dagger_nova',
        activeFx({ category: 'cast', shape: 'nova', radius: 130, damageMult: 2, castTimeSec: 0.6, weaponClasses: ['dagger'] })));
      learn(p, 't_dagger_nova');
      p.mana = 30;
      const evs = tick({ ...idle, cast: 't_dagger_nova' });
      expect(evs.some((e) => e.type === 'swing' && e.ability === 't_dagger_nova'), 'каст начат с кинжалом').toBe(true);
      expect(p.windup).not.toBeNull();
      if (swap) expect(equip(r, save, maul.uid).ok).toBe(true);
      const hits = monsterHits(settle());
      if (swap) expect(hits, 'кинжального каста с молотом в руке нет').toEqual([]);
      else expect(hits.length, 'контроль: без подмены нова бьёт').toBe(1);
    }
  });

  /** Атака-скил на выносливости + «пламенное лезвие» (мана); гнездо — по флагу `socketed` на касте. */
  function insertRig(seed: number, insertId: string, socketed: boolean) {
    const k = rig(seed, (rr) => injectSkill(rr, 'warrior', 't_edge', activeFx({ category: 'attack', resource: 'stamina', manaCost: 6, damageMult: 2 })));
    const { r, p, save } = k;
    learn(p, 't_edge');
    save.skills[r.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === insertId)!.id] = 1;   // донор вставки
    if (socketed) expect(socketInsert(r, save, 't_edge', 0, insertId).ok).toBe(true);
    p.stamina = 30; p.mana = 25;
    return k;
  }

  it('⭐ каст с пустым гнездом, «пламенное лезвие» вставлено до удара — удар без огня и без траты маны', () => {
    const { r, p, save, tick, settle } = insertRig(64, 'ins-flame-edge', false);
    const evs = tick({ ...idle, cast: 't_edge' });
    expect(evs.some((e) => e.type === 'swing' && e.ability === 't_edge')).toBe(true);
    const manaAfterCast = p.mana;
    expect(socketInsert(r, save, 't_edge', 0, 'ins-flame-edge').ok, 'вставка — командой между тиками').toBe(true);
    const hits = monsterHits(settle());
    expect(hits.length).toBe(1);
    expect(hits[0]!.byType.fire, 'огня, за который не платили, нет').toBe(0);
    expect(p.mana, 'мана за вставку не списана задним числом').toBeGreaterThanOrEqual(manaAfterCast);
  });

  it('обратное: оплаченная вставка, вынутая до удара, удару всё равно достаётся', () => {
    const { r, save, tick, settle } = insertRig(65, 'ins-flame-edge', true);
    tick({ ...idle, cast: 't_edge' });
    expect(socketClear(r, save, 't_edge', 0).ok).toBe(true);
    const hits = monsterHits(settle());
    expect(hits.length).toBe(1);
    expect(hits[0]!.byType.fire, 'заплачено на касте — огонь есть').toBeGreaterThan(0);
  });

  it('⭐ печать, вставленная за замах, не срабатывает: прок — только у оплаченного на касте', () => {
    const { r, p, save, tick, settle } = insertRig(66, 'ins-ward', false);
    tick({ ...idle, cast: 't_edge' });
    expect(socketInsert(r, save, 't_edge', 0, 'ins-ward').ok).toBe(true);
    settle();
    expect(p.skillBuffs['ins:ins-ward'], 'печати нет').toBeUndefined();
  });
});

/**
 * ⚠ R6-15: У БАФФА ЕСТЬ ОТКАТ. Ветка `buff` отказывала только пока бафф висит, а `skillCd` не читала и не ставила: у всех
 * пяти баффов игры откат длиннее действия (воин a5 — 12 с на 8 с), и повтор в кадр истечения держал бафф 100 % времени.
 */
describe('⚠ R6-15: бафф держит свой откат', () => {
  it('⭐ «b-class-warrior-a5» зажат 40 с: касты не чаще отката (12 с), откат встаёт сразу, клиенту — событие отката (не свинг, R8-15)', () => {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    p.save.skills['b-class-warrior-a5'] = 1;
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });
    const node = r.get('skill-tree').nodes.find((n) => n.id === 'b-class-warrior-a5')!;
    const a = node.effect.active!;
    expect(a.category).toBe('buff');
    const cd = a.cooldown;
    expect(cd, 'предпосылка: откат длиннее действия').toBeGreaterThan(a.category === 'buff' ? a.durationSec : Infinity);
    const casts: number[] = [];
    const cds: Extract<SessionEvent, { type: 'cooldown' }>[] = [];
    let swings = 0;
    let up = 0;
    const dt = 1 / 30, T = 40 * 30;
    for (let i = 0; i < T; i++) {
      p.stamina = 50; p.mana = 50;
      const had = (p.skillBuffs['b-class-warrior-a5'] ?? 0) > 0;
      const evs = s.tick(dt, { p1: { ...idle, cast: 'b-class-warrior-a5' } });
      const has = (p.skillBuffs['b-class-warrior-a5'] ?? 0) > 0;
      if (has) up++;
      if (!had && has) {
        casts.push(i * dt);
        expect(p.skillCd['b-class-warrior-a5'], 'откат встал в кадр каста').toBeGreaterThan(cd - 0.1);
      }
      for (const e of evs) {
        if (e.type === 'cooldown' && e.ability === 'b-class-warrior-a5') cds.push(e);
        if (e.type === 'swing') swings++;
      }
    }
    expect(casts.length, 'касты были').toBeGreaterThan(1);
    for (let k = 1; k < casts.length; k++) expect(casts[k]! - casts[k - 1]!, `промежуток ${k}`).toBeGreaterThanOrEqual(cd - 1e-6);
    expect(up / T, 'время под баффом — действие/откат, а не 100 %').toBeLessThan(0.75);
    expect(cds.length, 'событие отката на каждый каст — клиент заливает откат слота').toBe(casts.length);
    expect(cds[0]!.cooldownMs).toBeCloseTo(cd * 1000, 0);
    expect(cds[0]!.playerId).toBe('p1');
    // ⚠ R8-15: бафф — не удар. Свинг клиенты играют ударом оружия (кукла, «слэш», свист) и ставят им общий attack-лок:
    // бафф посреди замаха обнулял лок (слоты атак переставали сереть) и перезапускал удар куклы.
    expect(swings, 'бафф не шлёт свинг').toBe(0);
  });

  it('⚠ R8-15: бафф посреди замаха удара — свинг один (удар), бафф — только событие отката', () => {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    p.save.skills['b-class-warrior-a5'] = 1;
    s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });
    p.stamina = 50; p.mana = 50;
    const evs = [...s.tick(1 / 30, { p1: { ...idle, attack: true } }), ...s.tick(1 / 30, { p1: { ...idle, attack: true, cast: 'b-class-warrior-a5' } })];
    expect(evs.filter((e) => e.type === 'swing').map((e) => (e as { ability: string }).ability)).toEqual(['attack']);
    expect(evs.filter((e) => e.type === 'cooldown').map((e) => (e as { ability: string }).ability)).toEqual(['b-class-warrior-a5']);
    expect((p.skillBuffs['b-class-warrior-a5'] ?? 0) > 0, 'бафф встал').toBe(true);
  });

  /**
   * ⚠ R19-03: РАНГ РЕЖЕТ ОТКАТ, А НЕ ДЕЙСТВИЕ. `abilityCooldown` снимает 3 % за ранг (до 35 % базы), `durationSec` не меняется: с ранга,
   * где откат ≤ действия, повтор в кадр истечения держал бафф 100 % времени — ровно то, что закрывал R6-15. «Огненные чары» (откат 12 с
   * на 12 с действия) — с первого ранга (99.8 %), клич воина и щит бури — с 13-го, мантия — с 11-го, прицельный выстрел — с 15-го.
   */
  it('⭐ каждый бафф игры на каждом ранге: под баффом меньше 90 % времени (повтор каждый кадр, ресурс бесконечен)', () => {
    const r = reg();
    const tree = r.get('skill-tree');
    const buffs = tree.nodes.filter((n) => n.effect.active?.category === 'buff');
    expect(buffs.length, 'баффы в игре есть').toBeGreaterThan(0);
    const dt = 1 / 30;
    const over: string[] = [];
    const honest: string[] = [];
    for (const node of buffs) {
      const a = node.effect.active!;
      if (a.category !== 'buff') continue;
      const cls = tree.branches.find((b) => b.id === node.branchId)?.classId ?? 'warrior';
      for (let rank = 1; rank <= node.maxRank; rank++) {
        const s = new GameSession(r, 7, 'normal');
        const p = s.addPlayer('p1', newBotSave(r, cls));
        p.save.level = 99;
        p.save.skills[node.id] = rank;
        s.enterFloor(1, { grid: openField(12, 12), spawn: cellToWorld(5, 5), monsters: [] });
        // Два полных цикла «каст → каст → каст»: доля времени под баффом между первым и третьим кастом — без хвоста окна.
        const casts: number[] = [];
        let up = 0;
        for (let i = 0; i < 60 * 30; i++) {
          p.stamina = 1e6; p.mana = 1e6;
          const had = (p.skillBuffs[node.id] ?? 0) > 0;
          s.tick(dt, { p1: { ...idle, cast: node.id } });
          const has = (p.skillBuffs[node.id] ?? 0) > 0;
          if (!had && has) { casts.push(i); if (casts.length === 3) break; }
          if (casts.length && has) up++;
        }
        const span = casts.length === 3 ? casts[2]! - casts[0]! : 0;
        if (!span || up / span >= 0.9) over.push(`${node.id} ранг ${rank}: ${span ? `${(100 * up / span).toFixed(1)} %` : `кастов за минуту ${casts.length}`}`);
        // Честная игра прежняя: на первом ранге бафф с откатом длиннее действия (с запасом) кастуется ровно по своему откату.
        if (rank === 1 && a.cooldown >= a.durationSec * 1.25 && span && Math.abs((casts[1]! - casts[0]!) * dt - a.cooldown) > dt + 1e-6) {
          honest.push(`${node.id}: каст раз в ${((casts[1]! - casts[0]!) * dt).toFixed(2)} с при откате ${a.cooldown}`);
        }
      }
    }
    expect(over, 'бафф висит (почти) всё время — или не встал вовсе').toEqual([]);
    expect(honest, 'первый ранг — по откату из данных').toEqual([]);
  }, 60_000);   // ~100 сессий по два цикла баффа: работа, а не ожидание

  it('R19-03: у каждого баффа в данных откат не короче действия с отдыхом — откат из описания и есть настоящий на первом ранге', () => {
    const bad = reg().get('skill-tree').nodes.flatMap((n) => {
      const a = n.effect.active;
      return a?.category === 'buff' && buffCooldown(a.cooldown, a.durationSec, 1) !== a.cooldown ? [`${n.id}: откат ${a.cooldown} с на ${a.durationSec} с действия`] : [];
    });
    expect(bad).toEqual([]);
    expect(buffCooldown(12, 12, 1), '«Огненные чары» до правки данных: 12 с на 12 с').toBe(12 * (1 + BUFF_MIN_REST));
    expect(buffCooldown(12, 8, 20), 'ранг режет откат не ниже действия с отдыхом').toBe(8 * (1 + BUFF_MIN_REST));
    expect(buffCooldown(12, 8, 1)).toBe(12);
  });
});

/**
 * ⚠ R6-26: ДОБЫЧА НЕ ПЕРЕЛЕТАЕТ СТЕНУ И НЕ БЕРЁТСЯ СКВОЗЬ НЕЁ. Бросок наград (44–84 px прочь от убившего) проверял лишь
 * клетку приземления: убитый у стены в клетку или у закрытой двери ронял добычу в соседнюю комнату, а то и в запечатанную
 * область. Подбор (клик, [E], автоподбор) мерил только расстояние — вещь и золото за стеной брались сквозь неё.
 */
describe('⚠ R6-26: добыча и стена', () => {
  /** Поле 20×12, стена во всю высоту по столбцу 10: правая половина запечатана. */
  function walled(): Grid { const g = openField(20, 12); for (let y = 0; y < 12; y++) g[y]![10] = Cell.Wall; return g; }
  const wallX = 10 * TILE;

  it('⭐ убитый у стены монстр: ни золото, ни сырьё, ни вещь не ложатся за стеной (40 сидов)', () => {
    let drops = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = reg();
      const loot = r.get('balance').loot as { dropChance: number; goldChance: number; potions: { chance: number }; materials: { chance: number } };
      loot.dropChance = 1; loot.goldChance = 1; loot.materials.chance = 1; loot.potions.chance = 1;
      const s = new GameSession(r, seed, 'normal');
      const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
      const pp = cellToWorld(8, 6), mp = cellToWorld(9, 6);
      s.enterFloor(1, { grid: walled(), spawn: pp, monsters: [weakMon(r, mp.x, mp.y)] });
      const m = s.world.monsters[0]!;
      for (let i = 0; i < 300 && m.alive; i++) { m.pos = { ...mp }; p.pos = { ...pp }; s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } }); }
      expect(m.alive, `сид ${seed}`).toBe(false);
      // Кадр смерти: всё, что упало, ещё лежит (автоподбор — со следующего тика).
      for (const d of s.world.drops) { drops++; expect(d.pos.x, `сид ${seed}: ${d.kind} за стеной`).toBeLessThan(wallX); }
    }
    expect(drops, 'сторож не выродился').toBeGreaterThan(80);
  });

  it('⭐ подбор по клику, [E] и автоподбор сквозь стену — нет; без стены те же точки — да', () => {
    for (const wall of [true, false]) {
      const r = reg();
      const s = new GameSession(r, 5, 'normal');
      const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
      const y = cellToWorld(9, 6).y;
      s.enterFloor(1, { grid: wall ? walled() : openField(20, 12), spawn: cellToWorld(9, 6), monsters: [] });
      const at = { x: wallX - 14, y };                         // вплотную к стене
      p.pos = { ...at };
      const item = itemFromBaseId(r.get('items.base'), 'dagger', r.get('item-tiers'), 'drop')!;
      s.world.drops.push({ id: 900, kind: 'item', pos: { x: wallX + TILE + 1, y }, item });          // 47 px — в радиусе клика (48)
      s.world.drops.push({ id: 901, kind: 'gold', pos: { x: wallX + TILE + 1, y: y + 20 }, gold: 10 }); // ≈51 px — в радиусе автоподбора (56)
      const got = s.pickupDropById('p1', 900);
      p.pos = { ...at };
      s.tick(1 / 30, { p1: { ...idle, interact: true } });   // [E] + автоподбор
      const left = s.world.drops.map((d) => d.id).sort();
      if (wall) {
        expect(got, 'клик сквозь стену').toBeNull();
        expect(left, '[E] и автоподбор сквозь стену').toEqual([900, 901]);
      } else {
        expect(got?.item?.uid, 'контроль: без стены клик берёт').toBe(item.uid);
        expect(left, 'контроль: золото подобрано само').toEqual([]);
      }
    }
  });

  it('⭐ сундук и рычаг за стеной не открываются; стоя рядом — открываются', () => {
    const r = reg();
    const s = new GameSession(r, 6, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const y = cellToWorld(9, 6).y;
    const beyond = { x: wallX + TILE + 8, y };                // клетка за стеной, 54 px от игрока: в радиусе 56
    s.enterFloor(1, {
      grid: walled(), spawn: cellToWorld(9, 6), monsters: [],
      chests: [{ id: 1, x: beyond.x, y: beyond.y, tier: 'plain' }],
      levers: [{ id: 1, x: beyond.x, y: beyond.y + 10, doorId: 1 }],
      doors: [{ id: 1, cells: [{ cx: 15, cy: 2 }] }],
    });
    p.pos = { x: wallX - 14, y };
    expect(s.openChest('p1', 1), 'сундук сквозь стену').toBe(false);
    expect(s.openLever('p1', 1), 'рычаг сквозь стену').toBeNull();
    p.pos = { x: beyond.x + 20, y: beyond.y + 5 };            // по ту сторону, рядом с обоими
    expect(s.openChest('p1', 1)).toBe(true);
    expect(s.openLever('p1', 1)).toBe(1);
  });
});

/**
 * ⚠ R7-01: ОГРОМНЫЙ ВЗГЛЯД — НЕ КРУГ 360°. Изменённый клиент слал `facing: 1e17` (конечное число — проверку провода проходило),
 * ядро клало его в `p.facing` как есть, а `wrapAngle(угол − 1e17)` на такой величине точности не имеет и отдаёт 0 для ЛЮБОГО
 * угла: каждый взмах и каждое ударное умение били всех в досягаемости со всех сторон, на арене — и игроков за спиной.
 * Ядро приводит взгляд само (боты и сим идут мимо провода), провод — тоже (`validateInput`).
 */
describe('⚠ R7-01: взгляд любой величины бьёт конусом, а не кругом', () => {
  /** Воин в центре, восемь неубиваемых монстров кольцом на 40 px (в досягаемости взмаха); сколько разных задето за 1 с. */
  function ring(facing: number): number {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const c = cellToWorld(10, 10);
    const at = (k: number) => ({ x: c.x + Math.cos((k / 8) * Math.PI * 2) * 40, y: c.y + Math.sin((k / 8) * Math.PI * 2) * 40 });
    s.enterFloor(1, { grid: openField(20, 20), spawn: c, monsters: Array.from({ length: 8 }, (_, k) => tankMon(r, at(k).x, at(k).y, 'undead')) });
    const hit = new Set<string | number>();
    for (let i = 0; i < 30; i++) {
      s.world.monsters.forEach((m, k) => { m.pos = at(k); m.vel = { x: 0, y: 0 }; m.windup = null; });   // стоят на местах
      p.pos = { ...c }; p.hp = p.maxHp;
      for (const e of s.tick(1 / 30, { p1: { ...idle, facing, attack: true } })) {
        if (e.type === 'hit' && e.target === 'monster' && e.by === 'p1') hit.add(e.id);
      }
    }
    return hit.size;
  }

  it('⭐ взмах с facing 1e17 / 1e20 / 1e300 / 2^60 задевает столько же, сколько честный прицел в ту же сторону', () => {
    const honest = ring(0);
    expect(honest, 'контроль: конус задевает часть кольца').toBeGreaterThan(0);
    expect(honest, 'контроль: конус — не круг').toBeLessThan(8);
    for (const f of [1e17, 1e20, 1e300, 2 ** 60, -1e17]) {
      const n = ring(f);
      expect(n, `facing ${f}: было 8 из 8`).toBeLessThan(8);
      expect(n, `facing ${f}`).toBe(ring(Math.atan2(Math.sin(f), Math.cos(f))));
    }
  });

  it('⭐ арена: игрок за спиной не ранен ни при каком facing', () => {
    for (const f of [0, 1e17, 1e20, 1e300, 2 ** 60]) {
      const r = reg();
      const s = new GameSession(r, 42, 'normal');
      const p1 = s.addPlayer('p1', newBotSave(r, 'warrior'));
      const p2 = s.addPlayer('p2', newBotSave(r, 'warrior'));
      s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(8, 6), monsters: [], pvp: true });
      const c = cellToWorld(8, 6);
      // Прицел «в спину» соседу: он стоит по направлению, противоположному приведённому взгляду.
      const aim = Math.atan2(Math.sin(f), Math.cos(f));
      const behind = { x: c.x - Math.cos(aim) * 30, y: c.y - Math.sin(aim) * 30 };
      const hits: SessionEvent[] = [];
      for (let i = 0; i < 60; i++) {
        p1.pos = { ...c }; p2.pos = { ...behind }; p1.hp = p1.maxHp; p2.spawnImmuneUntil = 0;
        hits.push(...s.tick(1 / 30, { p1: { ...idle, facing: f, attack: true }, p2: idle }).filter((e) => e.type === 'hit' && e.target === 'player' && e.id === 'p2'));
      }
      expect(hits.length, `facing ${f}: удар в спину`).toBe(0);
      // Контроль: тот же сосед спереди — задет.
      const front = { x: c.x + Math.cos(aim) * 30, y: c.y + Math.sin(aim) * 30 };
      let got = 0;
      for (let i = 0; i < 60; i++) {
        p1.pos = { ...c }; p2.pos = { ...front }; p2.hp = p2.maxHp; p2.spawnImmuneUntil = 0;
        got += s.tick(1 / 30, { p1: { ...idle, facing: f, attack: true }, p2: idle }).filter((e) => e.type === 'hit' && e.target === 'player' && e.id === 'p2').length;
      }
      expect(got, `facing ${f}: контроль — спереди бьёт`).toBeGreaterThan(0);
    }
  });

  it('ядро приводит взгляд само: в `p.facing` — угол в [−π, π] того же направления', () => {
    const r = reg();
    const s = new GameSession(r, 3, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(8, 6), monsters: [] });
    for (const f of [1e17, -1e300, 7]) {
      s.tick(1 / 30, { p1: { ...idle, facing: f } });
      expect(p.facing).toBe(Math.atan2(Math.sin(f), Math.cos(f)));
    }
    s.tick(1 / 30, { p1: { ...idle, facing: 1.25 } });
    expect(p.facing, 'честный угол — бит в бит').toBe(1.25);
  });
});

/**
 * ⚠ R7-19: УНИК С ТЕЛА НЕ ЛОМАЕТСЯ. Трофей ломался с `brokenChance` без оглядки на редкость, и ~1,9 % трофеев выпадали
 * сломанными униками (комнаты боссов их форсят), а уник кузницу не проходит вовсе (docs/ECONOMY.md §1: «Нашёл — носи как
 * есть») — чинился он за одно золото. Теперь уник падает целым; прочие трофеи ломаются как прежде (и тем же броском `rng`).
 */
describe('⚠ R7-19: уник-трофей падает целым', () => {
  /** Трофеи с тел при шансах 1: вещь всегда, трофей всегда, сломан всегда; `rarity` — какую редкость форсить порогами. */
  function trophies(rarity: 'unique' | 'rare', seed: number): Item[] {
    const r = reg();
    const loot = r.get('balance').loot as { dropChance: number; trophyChance: number; brokenChance: number; goldChance: number };
    loot.dropChance = 1; loot.trophyChance = 1; loot.brokenChance = 1; loot.goldChance = 0;
    for (const x of r.get('rarities')) (x as { threshold: number }).threshold = x.id === rarity ? 1e9 : 0;   // бросок любой — эта редкость
    const s = new GameSession(r, seed, 'normal', { rewards: true });
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    const baseId = r.get('biomes')[0]!.monsterPool[0]!;
    const monsters = Array.from({ length: 12 }, (_, k) => {
      const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 3 }, createRng(seed * 10 + k));
      def.hp = 1; def.armor = 0; def.evade = 0;
      const at = cellToWorld(7, 6);
      return { def, x: at.x, y: at.y };
    });
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters });
    const out: Item[] = [];
    for (let i = 0; i < 600 && s.monstersAlive > 0; i++) {
      const m = s.world.monsters.find((x) => x.alive)!;
      m.pos = cellToWorld(7, 6);
      p.pos = cellToWorld(6, 6); p.hp = p.maxHp;
      for (const e of s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } })) {
        if (e.type === 'item-dropped' && e.from === 'monster' && e.item.kind !== 'consumable') out.push(e.item);   // колбы — свой канал
      }
    }
    return out;
  }

  it('⭐ форсированный уник при brokenChance 1 — ни одного сломанного; контроль: редкий трофей ломается', () => {
    const u = [...trophies('unique', 1), ...trophies('unique', 2)];
    expect(u.filter((it) => it.rarity === 'unique').length, 'сторож не выродился').toBeGreaterThan(10);
    expect(u.filter((it) => it.rarity === 'unique' && it.broken).length, 'было: каждый сломан').toBe(0);
    const rare = trophies('rare', 3);
    expect(rare.length).toBeGreaterThan(5);
    expect(rare.every((it) => it.rarity === 'rare' && it.broken), 'прочие трофеи — сломаны, как прежде').toBe(true);
  });
});

/**
 * ⚠ R10-02: СНАРЯД НЕ ПРОЛЕТАЕТ ДИАГОНАЛЬНЫЙ ШОВ — угол, где касаются две клетки пола, а обе боковые — стены. Подшаг снаряда
 * (≤ 8 px) проверял только клетку, куда попал: у самого угла он перескакивал из клетки в клетку по диагонали, минуя обе стены,
 * и стрела героя из угла шва била монстра, который ни видеть его, ни дойти напрямую не мог. Теперь угол держит и снаряд —
 * то же правило, что у взгляда (`diagonalSealed`).
 */
describe('⚠ R10-02: снаряд не пролетает диагональный шов', () => {
  /** Комнаты (1..4)² и (5..8)², касаются только углом (4,4)↔(5,5); `open` — прорезать боковую (5,4): шва нет. */
  function seam(open: boolean): Grid {
    const g = makeGrid(12, 10, Cell.Wall);
    for (let y = 1; y <= 8; y++) for (let x = 1; x <= 8; x++) if ((x <= 4 && y <= 4) || (x >= 5 && y >= 5)) g[y]![x] = Cell.Floor;
    if (open) g[4]![5] = Cell.Floor;
    return g;
  }
  /** Лучник у угла шва стреляет ровно по диагонали через угол в неподвижного монстра; → [вылетело стрел, попаданий]. */
  function shoot(open: boolean): [number, number] {
    const r = reg();
    const s = new GameSession(r, 9, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'archer'));
    const mAt = cellToWorld(6, 6);
    const target = tankMon(r, mAt.x, mAt.y, 'undead');
    target.def.ai = 'stationary';
    const at = { x: 5 * TILE - 15, y: 5 * TILE - 15 };
    s.enterFloor(1, { grid: seam(open), spawn: at, monsters: [target] });
    const seen = new Set<number>();
    let hits = 0;
    for (let i = 0; i < 120; i++) {
      p.pos = { ...at };
      for (const e of s.tick(1 / 30, { p1: { ...idle, facing: Math.PI / 4, attack: true } })) {
        if (e.type === 'hit' && e.target === 'monster') hits++;
      }
      for (const pr of s.world.projectiles) if (pr.owner === 'player') seen.add(pr.id);
    }
    return [seen.size, hits];
  }

  it('⭐ через шов — ни одного попадания; стрелы при этом летят', () => {
    const [shots, hits] = shoot(false);
    expect(shots, 'лучник стрелял').toBeGreaterThan(0);
    expect(hits, 'сквозь угол шва').toBe(0);
  });

  it('контроль: одна боковая клетка открыта — те же выстрелы попадают', () => {
    const [shots, hits] = shoot(true);
    expect(shots).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
  });
});

/**
 * ⚠ C-10: СНАРЯД ГАСНЕТ О ПРЕГРАДУ ДЕКОРА, ЗАКРЫВАЮЩУЮ ОБЗОР (`blocksSight`). Подшаг снаряда смотрел только клетки сетки: стрела и
 * выстрел жезла пролетали высокую колонну насквозь, а удар, нова, проклятие, прыжок и рывок её уважают (R5-05: «только то, что
 * видишь»), монстр за ней героя не видит (ИИ без видимости) и выстрелить в ответ не может. Тем же путём и снаряд монстра летел
 * сквозь колонну в героя, успевшего за неё зайти. Низкий декор (`blocksSight: false`) обзор не трогает — над ним снаряд летит.
 * (Скрытое: в `objects` сегодня нет преграждающих объектов; его включит первая же правка редактора.)
 */
describe('⚠ C-10: снаряд не пролетает преграду декора, закрывающую обзор', () => {
  /** Коридор 20×7: герой класса `cls` в (3,3), неподвижный неубиваемый монстр в (12,3), колонна r=14 в (8,3) — между ними. */
  function corridor(blocksSight: boolean, cls = 'archer') {
    const r = reg();
    const s = new GameSession(r, 11, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, cls));
    const g = makeGrid(20, 7, Cell.Wall);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 19; x++) g[y]![x] = Cell.Floor;
    const at = cellToWorld(3, 3), mAt = cellToWorld(12, 3), pillar = cellToWorld(8, 3);
    const target = tankMon(r, mAt.x, mAt.y, 'undead');
    target.def.ai = 'stationary';
    s.enterFloor(1, { grid: g, spawn: at, monsters: [target], obstacles: [{ x: pillar.x, y: pillar.y, shape: 'circle', r: 14, blocksSight }] });
    return { s, p, at, m: s.world.monsters[0]!, pillar };
  }
  /** Лучник стреляет вдоль коридора `ticks` тиков (стоит на месте); → [вылетело стрел, попаданий по монстру, дальний x стрелы]. */
  function volley(blocksSight: boolean, ticks = 150): [number, number, number] {
    const { s, p, at } = corridor(blocksSight);
    const seen = new Set<number>();
    let hits = 0, maxX = 0;
    for (let i = 0; i < ticks; i++) {
      p.pos = { ...at };
      for (const e of s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } })) if (e.type === 'hit' && e.target === 'monster') hits++;
      for (const pr of s.world.projectiles) if (pr.owner === 'player') { seen.add(pr.id); maxX = Math.max(maxX, pr.pos.x); }
    }
    return [seen.size, hits, maxX];
  }

  it('⭐ стрела гаснет о колонну: ни одного попадания по монстру за ней, дальше колонны не летит', () => {
    const [shots, hits, maxX] = volley(true);
    expect(shots, 'лучник стрелял').toBeGreaterThan(0);
    expect(hits, 'сквозь колонну, закрывающую обзор').toBe(0);
    expect(maxX, 'стрела не за колонной').toBeLessThan(cellToWorld(8, 3).x);
  });

  it('контроль: низкий декор (обзор не закрывает) — те же стрелы летят над ним и попадают', () => {
    const [shots, hits] = volley(false);
    expect(shots).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
  });

  /** Снаряд монстра из-за колонны в героя: выпущен вдоль коридора (как выстрел по герою, пока тот был виден) — → попаданий. */
  function monsterShot(blocksSight: boolean): number {
    const { s, p, at, m } = corridor(blocksSight);
    for (let i = 0; i < 60 && !s.world.projectiles.length; i++) { p.pos = { ...at }; s.tick(1 / 30, { p1: { ...idle, facing: 0, attack: true } }); }
    const pr = s.world.projectiles[0]!;
    expect(pr, 'заготовка снаряда').toBeTruthy();
    s.world.projectiles = [Object.assign(pr, { owner: 'monster' as const, ownerId: m.id, pos: { x: m.pos.x - 20, y: m.pos.y }, vel: { x: -260, y: 0 }, ttl: 2.5 })];
    let hits = 0;
    for (let i = 0; i < 60; i++) {
      p.pos = { ...at };
      for (const e of s.tick(1 / 30, { p1: idle })) if (e.type === 'hit' && e.target === 'player') hits++;
    }
    return hits;
  }

  it('⭐ снаряд монстра тоже гаснет о колонну; без неё — попадает', () => {
    expect(monsterShot(true), 'сквозь колонну в героя').toBe(0);
    expect(monsterShot(false), 'контроль: над низким декором').toBeGreaterThan(0);
  });

  it('⭐ бумеранг о колонну разворачивается к владельцу, а не бьёт монстра за ней', () => {
    const { s, p, at, m, pillar } = corridor(true, 'mage');
    p.save.skills['b-fire-a1'] = 5;   // «Огненный шар» — бумеранг (shape boomerang)
    const hp0 = m.hp;
    let cast = false, maxX = 0, turned = false, hits = 0;
    for (let i = 0; i < 240; i++) {
      p.pos = { ...at }; p.mana = 999;
      const ev = s.tick(1 / 30, { p1: { ...idle, facing: 0, cast: cast ? null : 'b-fire-a1' } });
      if (s.world.projectiles.length) cast = true;
      for (const e of ev) if (e.type === 'hit' && e.target === 'monster') hits++;
      for (const pr of s.world.projectiles) { maxX = Math.max(maxX, pr.pos.x); if (pr.returning) turned = true; }
      if (cast && !s.world.projectiles.length) break;
    }
    expect(cast, 'бумеранг вылетел').toBe(true);
    expect(turned, 'развернулся').toBe(true);
    expect(maxX, 'не за колонной').toBeLessThan(pillar.x);
    expect(hits, 'монстр за колонной не задет').toBe(0);
    expect(m.hp).toBe(hp0);
    expect(s.world.projectiles.length, 'вернулся к владельцу и погас').toBe(0);
  });
});

/**
 * ⭐ R14-05: МЁРТВЫЙ ВЕЩЕЙ НЕ БРОСАЕТ. Вещь на курсоре в момент смерти и клик по миру мимо окна смерти (или «Выбросить» из меню)
 * клали её к трупу: поднять её мёртвый не может (`pickupDropById`), чужой аккаунт — тоже (R2-02), а смена этажа и вайп стирают землю.
 */
describe('⭐ R14-05: мёртвый вещей не бросает', () => {
  it('мёртвый — `dropToGround` отказывает, вещь в сумке, земля пуста; ожил — бросает', () => {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(5, 6), monsters: [] });
    const item = itemFromBaseId(r.get('items.base'), 'dagger', r.get('item-tiers'), 'drop')!;
    expect(addToInventory(p.save.inventory, item, r.get('balance').inventory)).toBeTruthy();
    p.alive = false; p.hp = 0;
    expect(s.dropToGround('p1', item.uid)).toBeNull();
    expect(p.save.inventory.some((i) => i.uid === item.uid), 'вещь в сумке').toBe(true);
    expect(s.world.drops.length, 'земля пуста').toBe(0);
    p.alive = true; p.hp = 10;
    expect(s.dropToGround('p1', item.uid)?.uid, 'контроль: живой бросает').toBe(item.uid);
    expect(s.world.drops.length).toBe(1);
  });
});

/**
 * ⚠ R15-10: ЛЕВЕЛАП ЛЕЧИТ ДО НАСТОЯЩЕГО МАКСИМУМА. Полное лечение считало снимок из одного сейва — без рантайм-модов (аура,
 * стойка, бафф, бафф зелья): герой в стойке +15 % к жизни вставал на ~87 %, а до конца тика этот же голый снимок лежал в
 * `snaps` — замах, удар монстра по броне/сопротивлениям/блоку и потолок вампиризма шли без аур и стоек.
 */
describe('⚠ R15-10: левелап — полный максимум с аурами/стойками/баффами, и снимок тика их держит', () => {
  it('⭐ стойка +15 % к жизни, 20 % здоровья, убийство через порог уровня: здоровье = максимуму со стойкой', () => {
    const r = reg();
    const s = new GameSession(r, 7, 'normal');
    const save = newBotSave(r, 'warrior');
    save.level = 40; save.skills['b-stance-a5'] = 1;
    const p = s.addPlayer('p1', save);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(9));
    def.hp = 1; def.armor = 0; def.evade = 0; def.xp = 50;
    const far = cellToWorld(25, 6);   // монстр далеко: сначала включаем стойку
    s.enterFloor(1, { grid: openField(30, 12), spawn: cellToWorld(3, 6), monsters: [{ def, x: far.x, y: far.y }] });
    s.tick(1 / 30, { p1: { ...idle, cast: 'b-stance-a5' } });
    s.tick(1 / 30, { p1: idle });
    expect(p.toggles).toEqual(['b-stance-a5']);
    const m = s.world.monsters[0]!;
    m.pos = { x: p.pos.x + 30, y: p.pos.y };
    save.xp = xpForLevel(41, r.get('balance').xpTable) - 1;
    p.hp = p.maxHp * 0.2;
    let leveled = false;
    for (let i = 0; i < 300 && !leveled; i++) {
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      leveled = s.tick(1 / 30, { p1: { ...idle, facing, attack: true } }).some((e) => e.type === 'levelup' && e.playerId === 'p1');
    }
    expect(leveled, 'убил и поднял уровень').toBe(true);
    expect(save.level).toBe(41);
    const inTick = s.snapshotOf('p1')!;
    const want = playerSnapshot(save, r, toggleBuffMods(r, p.toggles));
    expect(inTick.derived, 'снимок до конца тика левелапа — со стойкой').toEqual(want.derived);
    expect(inTick.combat).toEqual(want.combat);
    expect(p.maxHp, 'максимум тика левелапа — со стойкой').toBe(want.derived.maxHp);
    expect(p.hp, 'вылечен до максимума со стойкой').toBe(want.derived.maxHp);
    s.tick(1 / 30, { p1: idle });
    expect(p.maxHp).toBe(want.derived.maxHp);
    expect(p.hp, 'и на следующем тике — полон').toBe(p.maxHp);
    expect(p.stamina, 'выносливость — до резерва стойки').toBeCloseTo(effectivePool(want.derived.maxStamina, reservedFrac(r, p.toggles, 'stamina')), 6);
  });
});
