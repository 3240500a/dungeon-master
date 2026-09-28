import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng, rngFrom } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { buildAttackPacket } from '../formulas/playerCombat.js';
import { skillWeaponAllowed } from '../formulas/skills.js';
import { asHeld, gripOf } from '../formulas/versatile.js';
import { packetTotal, type DamagePacket } from '../types/combat.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import type { SaveState } from '../types/save.js';
import { GameSession, type PlayerInput } from './session.js';

/**
 * ⭐ C-11 / C-15: ПОЛУТОРНЫЙ ХВАТ — В КАЖДОМ УДАРЕ, И ПО ЖИВОЙ РУЧКЕ (docs/CRAFT_WEAPONS.md §25).
 *
 * Полуторный меч со щитом держат одной рукой: урон × `balance.versatile.oneHandDamage`, темп × `oneHandSpeed`. Урезанную копию
 * вещи видели деривация (`equippedItems`) и базовый удар (`attackWeaponsOf`), а скилы — нет: `weaponAttack` и `castPacket` брали
 * сырое двуручное оружие из сейва, и гейт `hands:'two'` смотрел на родной хват вещи. Итог — «Рассечение» двуручного меча на
 * полный двуручный урон при щите в другой руке (C-11). И базовый удар брал зашитое 0.88, мимо ручки, которую двигает редактор
 * (C-15): панели и скорость следовали ручке, урон сервера — нет.
 *
 * Сторожа — по классу, а не по одному скилу: КАЖДЫЙ наступательный скил, доступный одноручному хвату, обязан дешеветь вместе с
 * ручкой; базовый удар — совпадать с формулой от вещи «как держат» по ручке конфига.
 */

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

/** Конфиг с ручкой одноручного хвата (`undefined` — как в поставке). */
function regWith(knob?: number): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  if (knob !== undefined) r.reload({ balance: { ...structuredClone(r.get('balance')), versatile: { oneHandDamage: knob, oneHandSpeed: knob } } });
  return r;
}

function hero(r: ConfigRegistry, shield: boolean, cls = 'warrior'): SaveState {
  const save = newBotSave(r, cls);
  save.level = 30;
  save.attributes = { strength: 80, dexterity: 60, intelligence: 60, vitality: 60 };
  save.equipment.weapon = itemFromBaseId(r.get('items.base'), 'greatsword', r.get('item-tiers'), 'drop')!;
  if (shield) save.equipment.offhand = itemFromBaseId(r.get('items.base'), 'wooden-shield', r.get('item-tiers'), 'drop')!;
  else delete save.equipment.offhand;
  return save;
}

interface Hit { total: number; packet: DamagePacket; swung: boolean; save: SaveState; s: GameSession }

/**
 * Первый пакет, дошедший до монстра, от базового удара (`how = 'attack'`) или скила (id узла; классовая ветка — героем своего
 * класса). Бросок постоянный (0.5): пакет — функция одних чисел, и две сессии с разной ручкой сравнимы до бита. Монстр и герой не
 * получают урона (удар перехвачен).
 */
function firstHit(r: ConfigRegistry, shield: boolean, how: string): Hit {
  const s = new GameSession(r, 777, 'normal', { rng: rngFrom(() => 0.5) });
  const save = hero(r, shield, /^b-class-([a-z]+)-/.exec(how)?.[1]);
  if (how !== 'attack') save.skills[how] = 1;
  const p = s.addPlayer('p1', save);
  const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(4));
  const mpos = cellToWorld(7, 6);
  s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: mpos.x, y: mpos.y }] });
  const got: DamagePacket[] = [];
  const priv = s as unknown as { hitMonster: (p: unknown, m: unknown, packet: DamagePacket) => void; hitPlayer: (...a: unknown[]) => void };
  priv.hitMonster = (_p, _m, packet) => { got.push({ ...packet }); };
  priv.hitPlayer = () => {};
  let swung = false;
  for (let i = 0; i < 120 && got.length === 0; i++) {
    const m = s.world.monsters[0]!;
    const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
    const ev = s.tick(1 / 30, { p1: { ...idle, facing, attack: how === 'attack', cast: how === 'attack' ? null : how } });
    if (ev.some((e) => e.type === 'swing' && e.ability === how)) swung = true;
  }
  return { total: got[0] ? packetTotal(got[0]) : NaN, packet: got[0]!, swung, save, s };
}

describe('⭐ C-11: скилы бьют полуторным «как его держат», гейт рук — по хвату', () => {
  const r = regWith();
  const bases = r.get('items.base');
  const gs = itemFromBaseId(bases, 'greatsword', r.get('item-tiers'), 'drop')!;
  const shield = itemFromBaseId(bases, 'wooden-shield', r.get('item-tiers'), 'drop')!;

  it('гейт рук: полуторное со щитом — одна рука (двуручные скилы нельзя, одноручные можно); без щита — две', () => {
    expect(gs.versatile && gs.hands).toBe(2);
    expect(skillWeaponAllowed({ hands: 'two', weaponClasses: ['sword'] }, gs)).toBe(true);
    expect(skillWeaponAllowed({ hands: 'two', weaponClasses: ['sword'] }, gs, shield)).toBe(false);
    expect(skillWeaponAllowed({ hands: 'one', weaponClasses: ['sword'] }, gs)).toBe(false);
    expect(skillWeaponAllowed({ hands: 'one', weaponClasses: ['sword'] }, gs, shield)).toBe(true);
  });

  it('«Рассечение» двуручного меча (hands:two) со щитом не исполняется; без щита — бьёт', () => {
    const node = 'b-sword2h-a1';
    expect(r.get('skill-tree').nodes.find((n) => n.id === node)?.effect.active).toMatchObject({ hands: 'two' });
    const two = firstHit(r, false, node);
    expect(two.swung).toBe(true);
    expect(two.total).toBeGreaterThan(0);
    const one = firstHit(r, true, node);
    expect(one.swung, 'скил двух рук со щитом в другой руке').toBe(false);
    expect(Number.isNaN(one.total)).toBe(true);
  });

  it('КАЖДЫЙ наступательный скил одноручного хвата дешевеет с ручкой oneHandDamage (1 → 0.5), как и базовый удар', () => {
    const full = regWith(1), half = regWith(0.5);
    const offensive = r.get('skill-tree').nodes.filter((n) => {
      const a = n.effect.active;
      return a && (a.category === 'attack' || a.category === 'cast') && skillWeaponAllowed(a, gs, shield);
    });
    const compared: string[] = [];
    const bad: string[] = [];
    for (const how of ['attack', ...offensive.map((n) => n.id)]) {
      const a = firstHit(full, true, how), b = firstHit(half, true, how);
      if (Number.isNaN(a.total) && Number.isNaN(b.total)) continue;   // не дотянулся в этой постановке (условие цели и т.п.)
      compared.push(how);
      if (!(b.total < a.total - 1e-9)) bad.push(`${how}: ×1 → ${a.total.toFixed(2)}, ×0.5 → ${b.total.toFixed(2)}`);
    }
    // Все формы: взмах серии, рывок, нова, метеор, бумеранг, «земля» — через классовые ветки (каждая — героем своего класса).
    expect(compared, 'в сравнении — базовый удар, одноручные мечи, щит и классовые').toEqual(expect.arrayContaining([
      'attack', 'b-sword1h-a1', 'b-shield-a2', 'b-class-warrior-a4', 'b-class-mage-a2', 'b-class-mage-a3', 'b-class-mage-a5', 'b-class-archer-a3',
    ]));
    expect(compared.length).toBeGreaterThanOrEqual(20);
    expect(bad).toEqual([]);
  });
});

describe('⭐ C-15: базовый удар — по живой ручке balance.versatile, как деривация и панели', () => {
  it('пакет базового удара = формула от вещи «как держат» по ручке конфига (0.88 поставки и 0.5 правки)', () => {
    for (const knob of [undefined, 0.5]) {
      const r = regWith(knob);
      const h = firstHit(r, true, 'attack');
      const snap = h.s.snapshotOf('p1')!;
      const held = asHeld(h.save.equipment.weapon, h.save, gripOf(r.get('balance').versatile));
      const want = buildAttackPacket(snap.derived, snap.attrs, held, r.get('balance').weaponAttrScaling, r.get('weapon-weights'), rngFrom(() => 0.5));
      expect(h.packet, `ручка ${knob ?? 'поставки'}`).toEqual(want);
    }
    // И ручка действительно двигает урон (0.88 → 0.5), а не только скорость.
    expect(firstHit(regWith(0.5), true, 'attack').total).toBeLessThan(firstHit(regWith(), true, 'attack').total);
  });
});
