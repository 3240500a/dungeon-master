import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import {
  MYTHIC_ORIGINS, baseTierRange, countsAsMythicFind, craftTiers, craftWeapon, defaultParts, emptyJournal, partById,
  partsOf, resolveParts, restepParts, salvageIntoJournal, shapeFoundWeapon, tierIndex, tierOfSteps,
} from './craft.js';
import { keySlotOf } from './craftType.js';
import { bladeStats } from './bladeStats.js';
import { bakedExtras, generateItem, itemFromBase, itemFromBaseId } from './itemgen.js';
import { generateMonster } from './monstergen.js';
import { createRng } from './rng.js';
import { canUpgradeItem, craftAction, forgeSalvage, forgeUpgrade, unequip, upgradedItem } from '../economy/townActions.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { acceptQuest, trackObjective, turnInQuest } from '../economy/questLogic.js';
import { emptyStash } from '../economy/stashActions.js';
import { GameSession, type SessionEvent } from '../session/session.js';
import { BotController } from '../session/bot.js';
import { townLayout } from '../dungeon/town.js';
import { Cell, cellToWorld, makeGrid, type Grid } from '../world/grid.js';
import { newBotSave, levelUpBotTo } from '../sim/playerBot.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import type { Item, ItemOrigin, Rarity } from '../types/items.js';
import type { QuestDef } from '../types/quest.js';
import type { SaveState } from '../types/save.js';
import type { SalvageRng } from './salvage.js';

/**
 * ⭐ К2: ОТКУДА ВЕЩЬ (D16) и ЗАМОРОЖЕННЫЕ ДЕТАЛИ (D17).
 * - `origin` пишет тот путь кода, что родил вещь; ворота t6 считают только найденное (`drop`/`chest`/`boss`),
 *   не поднятое кузнецом; вещь без поля не считается никогда.
 * - детали записываются у ЛЮБОГО найденного оружия (дроп, сундук, старт, квест), а статы не-клинка от этого
 *   не меняются ни на единицу — ни при форме, ни при подъёме ступени в кузнице.
 */

type Data = Record<string, unknown> & typeof defaultConfigData;
function regWith(patch: (d: Data) => void = () => {}): ConfigRegistry {
  const d = structuredClone(defaultConfigData) as Data;
  patch(d);
  const r = new ConfigRegistry();
  r.loadAll(d);
  return r;
}
const reg = regWith();
const ROLL = reg.get('balance').loot.baseRoll;
const LAST = craftTiers(reg).length - 1;
const MAX: SalvageRng = { int: (_a, b) => b, chance: () => true };

const drop = (baseId: string, level: number, seed: number, origin?: ItemOrigin, forceRarity: Rarity = 'normal', r = reg): Item =>
  generateItem(r.get('items.base'), r.get('affixes'), r.get('uniques'), {
    dropBias: 1, itemLevel: level, tierLevel: level, baseId, tiers: r.get('item-tiers'), rarities: r.get('rarities'),
    forceRarity, maxReqTotal: r.get('balance').maxTotalRequirement, baseRoll: ROLL, origin,
  }, createRng(seed));

const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
/** Первая включённая база оружия, доходящая до мифической ступени. */
const mythicBase = weapons.find((b) => baseTierRange(reg, b).hi === LAST)!;
const t6 = craftTiers(reg)[LAST]!;
const t5 = craftTiers(reg)[LAST - 1]!;
/** Ударная часть без геометрии — вещь, чьи статы от деталей не зависят. */
const isBlade = (it: Item): boolean => {
  const base = reg.get('items.base').find((b) => b.id === it.baseId);
  const picks = partsOf(reg, it);
  if (!base || base.kind !== 'weapon' || !picks) return false;
  const res = resolveParts(reg, base.weaponClass, base.hands ?? 1, picks);
  return res.ok && !!bladeStats(reg, res.parts.strike);
};

describe('D16: происхождение пишет тот, кто родил вещь', () => {
  it('генератор: поле ставится только по просьбе вызывающего — у обычной, редкой и уникальной', () => {
    expect(drop(mythicBase.id, 30, 1).origin).toBeUndefined();
    for (const o of ['drop', 'chest', 'boss', 'shop'] as const) {
      expect(drop(mythicBase.id, 30, 2, o).origin).toBe(o);
      expect(drop(mythicBase.id, 30, 3, o, 'rare').origin).toBe(o);
    }
    const u = drop(mythicBase.id, 30, 4, 'boss', 'unique');
    expect(u.rarity).toBe('unique');
    expect(u.origin).toBe('boss');
  });

  it('itemFromBase / itemFromBaseId передают происхождение; без него поля нет', () => {
    const base = reg.get('items.base').find((b) => b.kind === 'consumable')!;
    expect(itemFromBase(base).origin).toBeUndefined();
    expect(itemFromBase(base, undefined, 'shop').origin).toBe('shop');
    expect(itemFromBaseId(reg.get('items.base'), base.id, reg.get('item-tiers'), 'drop')!.origin).toBe('drop');
  });

  it('скованное — `craft`: и предпросмотр, и настоящая ковка', () => {
    const parts = defaultParts(reg, 'sword', 1, 2)!;
    expect(craftWeapon(reg, { weaponClass: 'sword', hands: 1, parts }).item!.origin).toBe('craft');
    const save = { gold: 1_000_000, inventory: [] } as unknown as SaveState;
    const stash = { ...emptyStash(reg), materials: Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999])) };
    const r = craftAction(reg, save, stash, 'nonce-origin-1', { weaponClass: 'sword', hands: 1, parts }, createRng(1), { fullJournal: true });
    expect(r.ok, r.reason).toBe(true);
    expect(save.inventory.find((i) => i.uid === r.uid)!.origin).toBe('craft');
  });

  it('стартовый комплект — `start`, оружие с записанными деталями', () => {
    for (const cls of reg.get('classes')) {
      const save = newCharacterSave(reg, cls.id, 'Тест', 'c1');
      const all = [...Object.values(save.equipment), ...save.inventory].filter(Boolean) as Item[];
      expect(all.length, cls.id).toBeGreaterThan(0);
      for (const it of all) expect(it.origin, `${cls.id}/${it.baseId}`).toBe('start');
      const w = save.equipment.weapon;
      if (w && w.kind === 'weapon') expect(w.foundParts, `${cls.id}/${w.baseId}`).toBeTruthy();
    }
  });

  describe('награда квеста', () => {
    const weaponId = mythicBase.id;
    const quest: QuestDef = {
      id: 'q-origin', name: 'Тест', description: '',
      objectives: [{ id: 'o1', type: 'kill', target: 'skeleton', amount: 1 }],
      reward: { gold: 40, itemBaseId: weaponId },
    };
    const done = (): SaveState => {
      const save = newBotSave(reg, 'warrior');
      acceptQuest(save, quest);
      trackObjective(save, 'kill', 'skeleton');
      return save;
    };

    it('`quest`, оружие — с записанными деталями', () => {
      const save = done();
      expect(turnInQuest(reg, save, 'q-origin').ok).toBe(true);
      const it = save.inventory.find((i) => i.baseId === weaponId)!;
      expect(it.origin).toBe('quest');
      expect(it.foundParts).toBeTruthy();
    });

    it('⚠ сумка полна — отказ ДО выдачи: ни золота, ни вещи, квест ждёт сдачи (раньше награда молча пропадала)', () => {
      const save = done();
      const dims = reg.get('balance').inventory;
      const filler = itemFromBaseId(reg.get('items.base'), 'healing-potion')!;
      for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) save.inventory.push({ ...filler, uid: `f-${x}-${y}`, pos: { x, y } });
      const before = JSON.stringify(save);
      const r = turnInQuest(reg, save, 'q-origin');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/места/);
      expect(JSON.stringify(save)).toBe(before);
      save.inventory = save.inventory.filter((i) => i.pos!.x >= 4);   // освободил четыре столбца — сдаётся
      expect(turnInQuest(reg, save, 'q-origin').ok).toBe(true);
    });
  });

  describe('сессия: дроп, босс, сундук', () => {
    /** Дроп с каждого, трофеем; зелья — тоже с каждого. */
    const rich = regWith((d) => {
      const loot = (d.balance as { loot: { dropChance: number; trophyChance: number; potions: { chance: number } } }).loot;
      loot.dropChance = 1; loot.potions.chance = 1;
    });
    function killDrops(rarity: 'normal' | 'unique', seed: number): Item[] {
      const save = newBotSave(rich, 'warrior');
      levelUpBotTo(rich, save, 40, DEFAULT_BUILD, createRng(seed));
      const s = new GameSession(rich, seed, 'normal');
      const p = s.addPlayer('p1', save);
      const bot = new BotController(rich);
      bot.syncHotbar(save);
      const mob = generateMonster(rich.get('monsters'), rich.get('monster-gear'), rich.get('monster-affixes'), { baseId: 'zombie', depth: 1, rarity }, createRng(seed));
      mob.hp = 1;
      mob.rarity = rarity;                            // редкость — то, что читает дроп (`m.def.rarity`); гир не важен                                     // бой не предмет теста — только рождение добычи
      const { grid, spawn } = townLayout(41, 41);
      s.enterFloor(1, { grid, spawn, monsters: [{ def: mob, x: spawn.x + 48, y: spawn.y }] });
      const out: Item[] = [];
      for (let t = 0; t < 20 * 30 && s.monstersAlive > 0; t++) {
        for (const e of s.tick(1 / 30, { p1: bot.input(s.world, p) }) as SessionEvent[]) if (e.type === 'item-dropped') out.push(e.item);
      }
      expect(s.monstersAlive).toBe(0);
      return out;
    }

    it('с обычного монстра — `drop` (и вещь, и зелье); оружие несёт детали', () => {
      const items = killDrops('normal', 3);
      expect(items.length).toBeGreaterThanOrEqual(2);
      for (const it of items) expect(it.origin, it.baseId).toBe('drop');
      for (const it of items.filter((x) => x.kind === 'weapon' && x.rarity !== 'unique')) expect(it.foundParts, it.baseId).toBeTruthy();
    });

    it('с монстра уникальной редкости (комнаты босса и уника) — `boss`; зелье — `drop`', () => {
      const items = killDrops('unique', 5);
      expect(items.some((i) => i.origin === 'boss')).toBe(true);
      for (const it of items) expect(it.origin, it.baseId).toBe(it.kind === 'consumable' ? 'drop' : 'boss');
    });

    it('сундук — `chest`', () => {
      const g: Grid = makeGrid(20, 12, Cell.Floor);
      for (let x = 0; x < 20; x++) { g[0]![x] = Cell.Wall; g[11]![x] = Cell.Wall; }
      for (let y = 0; y < 12; y++) { g[y]![0] = Cell.Wall; g[y]![19] = Cell.Wall; }
      let n = 0, armed = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const s = new GameSession(reg, seed, 'normal');
        s.addPlayer('p1', newBotSave(reg, 'warrior'));
        const c = cellToWorld(6, 7);
        s.enterFloor(1, { grid: g, spawn: cellToWorld(6, 6), monsters: [], chests: [{ id: 1, x: c.x, y: c.y, tier: 'rare' }] });
        expect(s.openChest('p1', 1)).toBe(true);
        for (const d of s.world.drops) if (d.kind === 'item') {
          n++;
          expect(d.item.origin).toBe('chest');
          if (d.item.kind === 'weapon' && d.item.rarity !== 'unique') { armed++; expect(d.item.foundParts).toBeTruthy(); }
        }
      }
      expect(n).toBeGreaterThan(0);
      expect(armed, 'R4-32: проверка деталей видела хоть одно оружие из сундука').toBeGreaterThan(0);
    });
  });
});

describe('D16: ворота t6 считают только НАЙДЕННЫЕ мифики', () => {
  const ALL: (ItemOrigin | undefined)[] = ['drop', 'chest', 'boss', 'shop', 'quest', 'start', 'craft', undefined];

  it('счётчик растёт только у drop / chest / boss; потолок ступени — у всех', () => {
    expect([...MYTHIC_ORIGINS].sort()).toEqual(['boss', 'chest', 'drop']);
    for (const o of ALL) {
      const it = shapeFoundWeapon(reg, drop(mythicBase.id, t6.minItemLevel, 7, o));
      expect(it.tier).toBe(t6.id);
      const u = salvageIntoJournal(reg, emptyJournal(), it);
      const counts = o === 'drop' || o === 'chest' || o === 'boss';
      expect(u.mythic, String(o)).toBe(counts);
      expect(u.journal.mythic, String(o)).toBe(counts ? 1 : 0);
      expect(u.journal.tierHi, String(o)).toBe(LAST);
    }
  });

  it('⚠ подделку поля не спасает ничто: мусор в origin — не счётчик', () => {
    const it = shapeFoundWeapon(reg, drop(mythicBase.id, t6.minItemLevel, 8, 'drop'));
    for (const junk of ['DROP', 'loot', '', '__proto__', 'constructor']) {
      expect(countsAsMythicFind({ origin: junk as ItemOrigin }), junk).toBe(false);
      expect(salvageIntoJournal(reg, emptyJournal(), { ...it, origin: junk as ItemOrigin }).journal.mythic, junk).toBe(0);
    }
  });

  it('⭐ подъём t5 → t6 у кузнеца метит вещь: такой мифик воротам не засчитывается, потолок ступени — да', () => {
    // Форма, чьи детали дотягиваются до t6 (R4-31: иначе выше t5 она не куётся).
    let found = shapeFoundWeapon(reg, drop(mythicBase.id, t5.minItemLevel, 9, 'drop'));
    for (let seed = 10; !upgradedItem(reg, found) && seed < 60; seed++) found = shapeFoundWeapon(reg, drop(mythicBase.id, t5.minItemLevel, seed, 'drop'));
    expect(found.tier).toBe(t5.id);
    const save = { gold: 1_000_000, inventory: [{ ...found, pos: null }] } as unknown as SaveState;
    const wallet = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999]));
    expect(forgeUpgrade(reg, save, found.uid, wallet).ok).toBe(true);
    const up = save.inventory.find((i) => i.uid === found.uid)!;
    expect(up.tier).toBe(t6.id);
    expect(up.tierForged).toBe(true);
    expect(up.origin).toBe('drop');                     // происхождение не переписывается
    expect(upgradedItem(reg, found)!.tierForged).toBe(true); // предпросмотр = то, за что платят

    const stash = emptyStash(reg);
    const r = forgeSalvage(reg, save, stash, up.uid, MAX);
    expect(r.ok, r.reason).toBe(true);
    expect(stash.forgeJournal!.mythic).toBe(0);
    expect(stash.forgeJournal!.tierHi).toBe(LAST);
    expect((r.unlocked ?? []).some((s) => /Мифических/.test(s))).toBe(false);
  });

  it('разбор у кузнеца end-to-end: мифик из лавки — ноль, с пола — единица и строка в окне', () => {
    for (const [o, want] of [['shop', 0], ['drop', 1], ['chest', 1], ['boss', 1], [undefined, 0]] as const) {
      const it = shapeFoundWeapon(reg, drop(mythicBase.id, t6.minItemLevel, 11, o));
      const save = { gold: 0, inventory: [{ ...it, pos: null }] } as unknown as SaveState;
      const stash = emptyStash(reg);
      const r = forgeSalvage(reg, save, stash, it.uid, MAX);
      expect(r.ok, `${o}: ${r.reason}`).toBe(true);
      expect(stash.forgeJournal!.mythic, String(o)).toBe(want);
      expect((r.unlocked ?? []).some((s) => /Мифических/.test(s)), String(o)).toBe(want === 1);
    }
  });
});

describe('D17: детали замораживаются у любого найденного оружия, статы не-клинка не меняются', () => {
  const SAME = ['baseStats', 'requirements', 'damageMult', 'spreadMult', 'reachMult', 'arcMult', 'name', 'affixes', 'tier', 'itemLevel', 'baseRoll'] as const;
  const pick = (it: Item) => Object.fromEntries(SAME.map((k) => [k, it[k]]));

  it('⭐ форма и подъём ступени: с деталями и без — одни и те же числа (все не-клинки × ступени × редкости)', () => {
    let checked = 0, upgraded = 0;
    for (const b of weapons) for (const lvl of [1, 18, 45, 62]) for (const rar of ['normal', 'magic', 'rare'] as const) {
      const raw = drop(b.id, lvl, lvl * 31 + b.id.length, 'drop', rar);
      const shaped = shapeFoundWeapon(reg, raw);
      if (isBlade(shaped)) continue;
      const tag = `${b.id} ур.${lvl} ${rar}`;
      expect(shaped.foundParts, tag).toBeTruthy();
      expect(raw.foundParts, `${tag}: исходная вещь не мутирует`).toBeUndefined();
      expect(pick(shaped), tag).toEqual(pick(raw));
      expect(partsOf(reg, shaped), tag).toEqual(shaped.foundParts);
      checked++;
      const a = upgradedItem(reg, raw), c = upgradedItem(reg, shaped);
      // R4-31: форма, чьи ЗАПИСАННЫЕ детали до следующей ступени не дотягиваются, выше не куётся; у вещи без записи
      // (сейв старше неё) детали выводятся под любую ступень заново — ей подъём есть.
      expect(!c || !!a, tag).toBe(true);
      if (a && c) { expect(pick(c), `${tag}: подъём`).toEqual(pick(a)); upgraded++; }
    }
    expect(checked).toBeGreaterThan(50);
    expect(upgraded).toBeGreaterThan(20);
  });

  it('детали держатся при правке пула: `rarityWeight` другой — записанное то же, выводимое (старый сейв) переехало бы', () => {
    const skewed = regWith((d) => {
      const w = (d.balance as { craft: { rarityWeight: Record<string, number> } }).craft.rarityWeight;
      w.common = 1; w.rare = 50;
    });
    let moved = 0;
    for (const b of weapons.slice(0, 12)) {
      const shaped = shapeFoundWeapon(reg, drop(b.id, 30, 17 + b.id.length, 'drop'));
      if (!shaped.foundParts) continue;
      expect(partsOf(skewed, shaped), b.id).toEqual(shaped.foundParts);
      const { foundParts: _fp, ...old } = shaped;
      if (JSON.stringify(partsOf(skewed, old)) !== JSON.stringify(partsOf(reg, old))) moved++;
    }
    expect(moved, 'сторож проверяет то, что обещает: без записи детали бы переехали').toBeGreaterThan(0);
  });

  it('не оружие, уникальное, скованное — без деталей найденного', () => {
    const armor = reg.get('items.base').find((b) => b.kind === 'armor')!;
    expect(shapeFoundWeapon(reg, drop(armor.id, 30, 1, 'drop')).foundParts).toBeUndefined();
    // ⚠ R4-32: уникальное ОРУЖИЕ — предпосылка без `if`. Уник берётся из пула уников, а не по `baseId`: прежний бросок
    // давал уникальные ЛАТЫ, и проверку проходил выход «не оружие» — выкинь из формы гард уника, тест бы не заметил.
    let u = drop(mythicBase.id, 30, 1, 'drop', 'unique');
    for (let seed = 2; (u.kind !== 'weapon' || u.rarity !== 'unique') && seed < 100; seed++) u = drop(mythicBase.id, 30, seed, 'drop', 'unique');
    expect(u.kind, 'нашёлся уник-оружие').toBe('weapon');
    expect(u.rarity).toBe('unique');
    expect(shapeFoundWeapon(reg, u), 'уник не перешивается').toBe(u);
    expect(u.foundParts).toBeUndefined();
    const crafted = craftWeapon(reg, { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)! }).item!;
    expect(shapeFoundWeapon(reg, crafted)).toBe(crafted);
    expect(partById(reg, crafted.parts!.strike.id)).toBeTruthy();
  });
});

describe('⚠ R1-04: жалость и детали — только у НАЙДЕННОГО; бесплатное и купленное учит лишь типу и ступени', () => {
  const k = reg.get('balance').craft.journal;
  /** Восемь разборов ОДНОГО класса у кузнеца в один сундук — ровно порог эскиза. */
  function salvageEight(origin: ItemOrigin | undefined): ReturnType<typeof emptyStash> {
    const stash = emptyStash(reg);
    for (let i = 0; i < k.sketchAfter; i++) {
      const it = shapeFoundWeapon(reg, drop(mythicBase.id, 20 + i, 300 + i, origin));
      const save = { gold: 0, inventory: [{ ...it, pos: null }] } as unknown as SaveState;
      const r = forgeSalvage(reg, save, stash, it.uid, MAX);
      expect(r.ok, `${String(origin)}: ${r.reason}`).toBe(true);
    }
    return stash;
  }

  it('⭐ найденное (drop / chest / boss): эскиз за восемь разборов класса, детали и кодекс открыты', () => {
    for (const o of ['drop', 'chest', 'boss'] as const) {
      const j = salvageEight(o).forgeJournal!;
      expect(j.sketches, o).toBe(1);
      expect(j.variants.length, o).toBeGreaterThan(0);
      expect(j.bases, o).toEqual([mythicBase.id]);
    }
  });

  it('⚠ наградное, купленное, «скованное» без деталей и вещь без поля — ни эскиза, ни счёта, ни деталей', () => {
    // Стартовое кузнец не разбирает вовсе (R3-04) — см. «ферму стартовых наборов» ниже.
    for (const o of ['quest', 'shop', 'craft', undefined] as const) {
      const j = salvageEight(o).forgeJournal!;
      const tag = String(o);
      expect(j.sketches, tag).toBe(0);
      expect(j.classSalvages, tag).toEqual({});
      expect(j.variants, `${tag}: детали узнаются только из найденного`).toEqual([]);
      expect(j.typesSeen, `${tag}: кодекс — тоже`).toEqual([]);
      expect(j.mythic, tag).toBe(0);
      // Тип и потолок ступени — «что это за вещь и какой ступени»: за ними честно ходят в лавку (§12.4).
      expect(j.bases, tag).toEqual([mythicBase.id]);
      expect(j.tierHi, tag).toBeGreaterThanOrEqual(0);
    }
  });

  it('⚠ ферма стартовых наборов: создал героя → снял оружие → к кузнецу → удалил — разбор отказан, журнал пуст', () => {
    // R3-04: кузнец стартовое не разбирает вовсе — ни эскизов, ни сырья (раньше оно было краном первой ступени).
    const classes = reg.get('classes').filter((c) => c.enabled !== false);
    const stash = emptyStash(reg);
    let tried = 0;
    for (const cls of classes) {
      for (let i = 0; i < k.sketchAfter * 2; i++) {
        const save = newCharacterSave(reg, cls.id, 'Альт', `alt-${cls.id}-${i}`);
        const w = save.equipment.weapon;
        if (!w || w.kind !== 'weapon') break;
        expect(w.origin).toBe('start');
        expect(unequip(reg, save, 'weapon').ok).toBe(true);
        expect(forgeSalvage(reg, save, stash, w.uid, MAX).ok, cls.id).toBe(false);
        expect(save.inventory.some((x) => x.uid === w.uid), `${cls.id}: вещь цела`).toBe(true);
        tried++;
      }
    }
    expect(tried, 'сторож видит хоть один класс').toBeGreaterThanOrEqual(k.sketchAfter * 2);
    expect(stash.forgeJournal).toEqual(emptyJournal());
    expect(stash.materials ?? {}).toEqual({});
  });
});

describe('⚠ R4-31: подъём найденного оружия — детали всегда той ступени, что вещь', () => {
  const tiers = craftTiers(reg);
  const WALLET = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1_000_000]));

  it('⭐ каждая база × ступень × сид, подъём цепочкой до потолка: либо отказ, либо детали ровно новой ступени', () => {
    let n = 0, refusedTop = 0;
    const bad: string[] = [];
    for (const b of weapons) {
      const { lo, hi } = baseTierRange(reg, b);
      for (let t = lo; t < hi; t++) for (let seed = 1; seed <= 6; seed++) {
        const found = shapeFoundWeapon(reg, drop(b.id, tiers[t]!.minItemLevel, 1000 * t + seed * 37 + b.id.length, 'drop'));
        if (!found.foundParts || found.tier !== tiers[t]!.id) continue;
        const save = { gold: 1e12, inventory: [{ ...found, pos: null }] } as unknown as SaveState;
        const wallet = WALLET();
        for (;;) {
          const cur = save.inventory.find((i) => i.uid === found.uid)!;
          const from = tierIndex(reg, cur.tier);
          const r = forgeUpgrade(reg, save, found.uid, wallet);
          if (!r.ok) {
            if (from < hi) { expect(r.reason, `${b.id} t${from}`).toBe('Эта форма выше не куётся'); if (from === LAST - 1) refusedTop++; }
            break;
          }
          const up = save.inventory.find((i) => i.uid === found.uid)!;
          n++;
          const parts = tierOfSteps(reg, up.foundParts!).tier;
          if (parts !== tierIndex(reg, up.tier)) bad.push(`${b.id} t${from}→${up.tier}: детали t${parts}`);
        }
      }
    }
    expect(bad.slice(0, 12), `${bad.length} расхождений`).toEqual([]);
    expect(n, 'сторож не выродился').toBeGreaterThan(5000);
    expect(refusedTop, 'хотя бы одна форма не доходит до t6 — и ей отказано').toBeGreaterThan(0);
  });

  it('карточка и сервер согласны: отказ — до траты, сейв байт в байт', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const b = weapons[seed % weapons.length]!;
      if (baseTierRange(reg, b).hi !== LAST) continue;
      const found = shapeFoundWeapon(reg, drop(b.id, t5.minItemLevel, seed, 'drop'));
      if (!found.foundParts || found.tier !== t5.id || upgradedItem(reg, found)) continue;
      const save = { gold: 1e12, inventory: [{ ...found, pos: null }] } as unknown as SaveState;
      const wallet = WALLET();
      const before = JSON.stringify([save, wallet]);
      const r = forgeUpgrade(reg, save, found.uid, wallet);
      expect(r).toEqual({ ok: false, reason: 'Эта форма выше не куётся' });
      expect(JSON.stringify([save, wallet])).toBe(before);
      return;
    }
    throw new Error('нет ни одной формы, не доходящей до t6: сторож без зубов');
  });
});

/**
 * ⚠ R5-09: ОТКАЗ R4-31 БИЛ ПО НАХОДКАМ, ЧЬИ ЧИСЛА ОТ ДЕТАЛЕЙ НЕ ЗАВИСЯТ. Детали найденного записываются навсегда, и
 * 15–52 % найденных t5 посохов, жезлов, арбалетов, топоров, кинжалов навсегда не поднимались до t6 («Эта форма выше не
 * куётся»): окно материала рукояти или обвязки кончалось на ступени 4. Числа этих вещей от деталей не зависят вовсе, а
 * кузница — главный путь к t6 до 80-го уровня. Теперь держится то, что несёт тип и числа (ключ; у клинка с геометрией
 * ещё и оголовье — точка баланса), прочее перебирается под ступень; отказ — только когда не дотягивается и оно.
 */
describe('⚠ R5-09: подъём найденного до t6 — отказ только там, где не дотягивается сама форма', () => {
  const top = weapons.filter((b) => baseTierRange(reg, b).hi === LAST);
  const NUMBERS = ['baseStats', 'requirements', 'damageMult', 'spreadMult', 'reachMult', 'arcMult', 'name', 'affixes', 'tier', 'itemLevel', 'baseRoll', 'tierForged'] as const;
  const numbers = (it: Item) => Object.fromEntries(NUMBERS.map((k) => [k, it[k]]));
  /** Найденные t5 этой базы, по 60 сидов. */
  function* finds(b: (typeof weapons)[number]): Generator<Item> {
    for (let seed = 1; seed <= 60; seed++) {
      const raw = drop(b.id, t5.minItemLevel, seed * 7919 + LAST - 1, 'drop');
      if (raw.tier !== t5.id) continue;
      const it = shapeFoundWeapon(reg, raw);
      if (it.foundParts) yield it;
    }
  }

  it('⭐ не-клинок: каждая база × 60 находок t5 поднимается до t6; числа — как у вещи без деталей, ключ тот же, детали ровно t6', () => {
    let n = 0, repicked = 0;
    for (const b of top) for (const found of finds(b)) {
      if (isBlade(found)) continue;
      const tag = `${b.id} ${found.uid}`;
      const can = canUpgradeItem(reg, found);
      expect(can.reason, tag).not.toBe('Эта форма выше не куётся');
      const up = upgradedItem(reg, found)!;
      expect(up, tag).toBeTruthy();
      const { foundParts: _fp, ...bare } = found;
      expect(numbers(up), `${tag}: числа как у подъёма без деталей`).toEqual(numbers(upgradedItem(reg, bare)!));
      expect(tierOfSteps(reg, up.foundParts!).tier, `${tag}: детали ступени t6`).toBe(LAST);
      const key = keySlotOf(reg, b.kind === 'weapon' ? b.weaponClass : '');
      expect(up.foundParts![key].id, `${tag}: ключ (тип) не меняется`).toBe(found.foundParts![key].id);
      if (!restepParts(reg, found.foundParts!, LAST)) repicked++;
      n++;
    }
    expect(n, 'сторож не выродился').toBeGreaterThan(1000);
    expect(repicked, 'правка проверена там, где прежде был отказ').toBeGreaterThan(50);
  });

  it('⭐ клинок с геометрией: отказов меньше, чем было; поднятый держит клинок и оголовье (от них его числа)', () => {
    let before = 0, after = 0, n = 0;
    for (const b of top) for (const found of finds(b)) {
      if (!isBlade(found)) continue;
      n++;
      if (!restepParts(reg, found.foundParts!, LAST)) before++;
      const up = upgradedItem(reg, found);
      if (!up) { after++; continue; }
      expect(up.foundParts!.strike.id, b.id).toBe(found.foundParts!.strike.id);
      expect(up.foundParts!.head.id, b.id).toBe(found.foundParts!.head.id);
      expect(tierOfSteps(reg, up.foundParts!).tier, b.id).toBe(LAST);
    }
    expect(n).toBeGreaterThan(100);
    expect(before, 'было кому отказывать').toBeGreaterThan(0);
    expect(after, `отказов стало меньше: было ${before}, стало ${after}`).toBeLessThan(before);
  });

  it('подъём детерминирован: предпросмотр = то, за что платят; одна и та же находка — одни и те же детали', () => {
    for (const b of top) for (const found of finds(b)) {
      if (restepParts(reg, found.foundParts!, LAST) || !upgradedItem(reg, found)) continue;
      expect(upgradedItem(reg, structuredClone(found))!.foundParts).toEqual(upgradedItem(reg, found)!.foundParts);
      const save = { gold: 1e12, inventory: [{ ...found, pos: null }] } as unknown as SaveState;
      const wallet = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1_000_000]));
      expect(forgeUpgrade(reg, save, found.uid, wallet).ok).toBe(true);
      expect(save.inventory[0]!.foundParts).toEqual(upgradedItem(reg, found)!.foundParts);
      return;
    }
    throw new Error('нет находки, которой нужен перебор деталей');
  });
});

/**
 * ⚠ R6-10: ПОДЪЁМ НАЙДЕННОГО МЕЧА, ЧЬЮ ДЕТАЛЬ ВЫКЛЮЧИЛИ ПОСЛЕ НАХОДКИ. `retierItem` оставляет `damageMult`/`spreadMult` вещи и
 * собирает статы от базы, а `shapeFoundWeapon` не собирал выключенную деталь (`resolveParts` её отвергает) и возвращал вещь
 * как есть: t3 с множителем удара клинка (1.05), но без его платы скоростью (−0.04) и без блока/укуса оголовья — форма, какой
 * не даёт ни ковка, ни дроп. Ось удара нулевая по сумме; такой подъём — +5..10 % урона даром, а обратные клинки не поднимали.
 * Теперь: выключенный держак/обвязка заменяются включённым (числа — как при живой детали), выключенный клинок или оголовье
 * (на них числа) — подъём отказан; деталь убрана совсем (запечь нечем) — ось снимается целиком.
 */
describe('⚠ R6-10: подъём найденного меча с выключенной деталью — ось удара целиком или никак', () => {
  const t2 = craftTiers(reg)[2]!;
  const WALLET = (r: ConfigRegistry): Record<string, number> => Object.fromEntries(r.get('craft-materials').map((m) => [m.id, 1_000_000]));
  /** Найденные t2 длинные мечи: клинок с геометрией, множитель удара > 1, подъём при живом конфиге есть. */
  const finds: Item[] = [];
  for (let seed = 1; seed < 800 && finds.length < 5; seed++) {
    const it = shapeFoundWeapon(reg, drop('long-sword', t2.minItemLevel, seed, 'drop'));
    if (it.tier === t2.id && it.foundParts && isBlade(it) && (it.damageMult ?? 1) > 1 && upgradedItem(reg, it)) finds.push({ ...it, pos: null });
  }
  /** Реестр, где записанная деталь гнезда `slot` выключена (`off`) или убрана из конфига вовсе (`gone`). */
  const regOff = (it: Item, slot: 'strike' | 'grip' | 'bind' | 'head', how: 'off' | 'gone'): ConfigRegistry => {
    const r = regWith();
    const id = it.foundParts![slot].id;
    const parts = structuredClone(r.get('weapon-parts'));
    r.reload({ 'weapon-parts': how === 'gone' ? parts.filter((p) => p.id !== id) : parts.map((p) => (p.id === id ? { ...p, enabled: false } : p)) });
    return r;
  };
  const upgrade = (r: ConfigRegistry, it: Item) => {
    const save = { gold: 1e12, inventory: [structuredClone(it)] } as unknown as SaveState;
    const res = forgeUpgrade(r, save, it.uid, WALLET(r));
    return { res, up: save.inventory.find((i) => i.uid === it.uid)! };
  };
  const numbers = (it: Item) => ({ tier: it.tier, damageMult: it.damageMult, spreadMult: it.spreadMult, baseStats: it.baseStats });

  it('⭐ выключен клинок или оголовье (на них числа) — отказ, вещь как была; держак или обвязка — заменены включённым, числа как при живой детали', () => {
    expect(finds.length, 'сторож не выродился').toBeGreaterThanOrEqual(3);
    for (const it of finds) {
      const live = upgradedItem(reg, it)!;
      for (const slot of ['strike', 'head'] as const) {
        const { res, up } = upgrade(regOff(it, slot, 'off'), it);
        expect(res, `${it.uid} ${slot}`).toEqual({ ok: false, reason: 'Эта форма выше не куётся' });
        expect(up, 'вещь не тронута').toEqual(it);
      }
      for (const slot of ['grip', 'bind'] as const) {
        const r = regOff(it, slot, 'off');
        const { res, up } = upgrade(r, it);
        expect(res.ok, `${it.uid} ${slot}: ${res.reason}`).toBe(true);
        expect(numbers(up), `${slot}: клинок и оголовье те же — числа те же, обе стороны оси`).toEqual(numbers(live));
        expect(r.get('weapon-parts').find((p) => p.id === up.foundParts![slot].id)?.enabled, 'на месте выключенной — включённая').not.toBe(false);
      }
    }
  });

  it('⭐ клинок убран из конфига совсем — запечь нечем: ни `damageMult`, ни `spreadMult`, ни вклада клинка в статы', () => {
    for (const it of finds) {
      const r = regOff(it, 'strike', 'gone');
      const { res, up } = upgrade(r, it);
      expect(res.ok, res.reason).toBe(true);
      expect(up.tier, 'ступень поднята').not.toBe(it.tier);
      expect(up.damageMult, 'было: 1.05 без платы скоростью').toBeUndefined();
      expect(up.spreadMult).toBeUndefined();
      const base = r.get('items.base').find((b) => b.id === it.baseId)!;
      expect(bakedExtras(base.baseStats, up.baseStats), 'в статах — только база').toEqual([]);
    }
  });
});
