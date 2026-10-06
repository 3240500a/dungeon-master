import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  STARTER_FIELD, STARTER_KNOWN, canSalvageItem, equip, fieldSalvage, forgeSalvage, forgeUpgrade, salvageRange, salvageWorth, sellItem, shopSellPrice,
  unequip, upgradedItem,
} from './townActions.js';
import { newCharacterSave } from './newCharacter.js';
import { emptyStash, stashMove } from './stashActions.js';
import { createRng } from '../formulas/rng.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { emptyJournal, normalizeJournal, salvageIntoJournal, shapeFoundWeapon } from '../formulas/craft.js';
import { unmetWorn } from '../formulas/stats.js';
import { newBotSave } from '../sim/playerBot.js';
import type { Attribute } from '../types/attributes.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R3-04: СТАРТОВЫЙ КОМПЛЕКТ НЕ ПЕЧАТАЕТ ЗОЛОТО И СЫРЬЁ.
 *
 * Комплект (оружие класса + четыре кожаные вещи, `origin: 'start'`) бесплатен и бесконечен: создал героя, снял
 * комплект, переложил в сундук аккаунта (или бросил соседу), удалил героя — и заново. Слот героя освобождается
 * сразу, лимита на создание нет. Лавка платила 35 золота за комплект, разбор давал 11–21 единицу сырья первой
 * ступени — ровно той, что ест лестница подъёма. Скрипт гонял круг за 2–3 с: 40–60 тыс. золота в час на аккаунт,
 * больше, чем дают убийства на низких и средних уровнях.
 *
 * Теперь стартовая вещь за пределами своего героя ничего не стоит: лавка берёт её за 1, а кузнец разбирает её ТОЛЬКО В КАТАЛОГ
 * (решение владельца D1, предложение «Разбор, сырьё и чары» §9.3): ни сырья, ни эссенции, ни эскиза. Каталог конечен — детали стартового
 * оружия одни на класс, — поэтому второй такой же комплект кузнец не берёт: отказ с причиной ДО разбора («разобрать и не получить ничего
 * нельзя»). В поле — отказ всегда: сырья комплект не даёт, а каталог пишет только кузнец (D2).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const classes = reg.get('classes').filter((c) => c.enabled !== false);
const kitOf = (s: SaveState): Item[] => [...Object.values(s.equipment).filter((i): i is Item => !!i), ...s.inventory];
const MAX = { int: (_a: number, b: number) => b, chance: () => true };

describe('⚠ R3-04: стартовый комплект вне своего героя ничего не стоит', () => {
  it('⭐ у каждого класса: продажа комплекта ≤ 5 золота, сырья — ноль; у кузнеца — только каталог, в поле — отказ', () => {
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Альт', `alt-${cls.id}`);
      const kit = kitOf(save);
      expect(kit.length, cls.id).toBe(5);
      for (const it of kit) expect(it.origin, `${cls.id}: ${it.baseId}`).toBe('start');
      const sell = kit.reduce((s, it) => s + shopSellPrice(reg, it), 0);
      expect(sell, `${cls.id}: лавка за комплект`).toBeLessThanOrEqual(5);
      for (const it of kit) {
        expect(salvageWorth(reg, it), `${cls.id}: ${it.baseId}`).toBe(0);
        // У кузнеца — разбор в каталог: сырья нет, вилка пустая.
        expect(canSalvageItem(reg, it, false, emptyJournal()).ok, `${cls.id}: ${it.baseId} кузница, каталог пуст`).toBe(true);
        expect(salvageRange(reg, it, false), `${cls.id}: ${it.baseId}`).toEqual({ ok: true, range: {} });
        // Всё уже в каталоге — отказ ДО нажатия, с причиной.
        const known = salvageIntoJournal(reg, emptyJournal(), it).journal;
        expect(canSalvageItem(reg, it, false, known), `${cls.id}: ${it.baseId} — всё известно`).toEqual({ ok: false, reason: STARTER_KNOWN });
        // В поле — отказ всегда.
        expect(canSalvageItem(reg, it, true), `${cls.id}: ${it.baseId} поле`).toEqual({ ok: false, reason: STARTER_FIELD });
        expect(salvageRange(reg, it, true).ok).toBe(false);
      }
    }
  });

  it('⭐ разбор стартовой вещи у кузнеца: в каталог тип/детали (снаряжение), ни сырья, ни эскиза; второй такой же комплект — отказ ДО траты', () => {
    for (const cls of classes) {
      const stash = emptyStash(reg);
      for (const round of [0, 1]) {
        const save = newCharacterSave(reg, cls.id, 'Альт', `alt2-${cls.id}-${round}`);
        for (const slot of Object.keys(save.equipment)) expect(unequip(reg, save, slot).ok, `${cls.id} ${slot}`).toBe(true);
        for (const it of [...save.inventory]) {
          expect(fieldSalvage(reg, save, it.uid, createRng(1)).ok, `${cls.id}: ${it.baseId} в поле`).toBe(false);
          const before = JSON.stringify([save, stash]);
          const r = forgeSalvage(reg, save, stash, it.uid, MAX);
          if (round === 0) {
            expect(r.ok, `${cls.id}: ${it.baseId} — первый комплект в каталог`).toBe(true);
            expect(r.summary, `${cls.id}: итоговая строка`).toMatch(/^Получено: сырья нет · Каталог: \+/);
            expect(save.inventory.some((i) => i.kind === 'material'), `${cls.id}: сырья в сумке нет`).toBe(false);
            expect(stash.materials ?? {}, `${cls.id}: сырья в сундуке нет`).toEqual({});
            const j = normalizeJournal(stash.forgeJournal);
            if (it.kind === 'weapon') expect(j.bases, `${cls.id}: тип в каталоге`).toContain(it.baseId);
            else expect(j.gearSeen, `${cls.id}: снаряжение в каталоге`).toContain(it.baseId);
            expect(j.sketches, 'эскиза нет').toBe(0);
            expect(j.classSalvages, 'жалость не копится').toEqual({});
          } else {
            expect(r, `${cls.id}: ${it.baseId} — второй комплект`).toEqual({ ok: false, reason: STARTER_KNOWN });
            expect(JSON.stringify([save, stash]), `${cls.id}: ${it.baseId} — ничего не тронуто`).toBe(before);
          }
        }
      }
    }
  });

  it('⭐ круг «создал → снял → в сундук → удалил» ×3 на каждом классе: главный герой выручает ≤ 5 золота за круг и ноль сырья', () => {
    for (const cls of classes) {
      const stash = emptyStash(reg);
      const main = newCharacterSave(reg, cls.id, 'Главный', `main-${cls.id}`);
      main.inventory = [];
      main.gold = 0;
      const forge = emptyStash(reg);
      for (let round = 0; round < 3; round++) {
        const alt = newCharacterSave(reg, cls.id, 'Альт', `churn-${cls.id}-${round}`);
        for (const slot of Object.keys(alt.equipment)) expect(unequip(reg, alt, slot).ok).toBe(true);
        const kit = [...alt.inventory];
        kit.forEach((it, i) => expect(stashMove(reg, alt, stash, it.uid, 0, i * 3, 0).ok, `${cls.id}: в сундук`).toBe(true));
        // Альта удалили — комплект у аккаунта. Главный забирает и сдаёт.
        kit.forEach((it, i) => expect(stashMove(reg, main, stash, it.uid, 'inv', i * 2, 0).ok, `${cls.id}: из сундука`).toBe(true));
        // Разбор у кузнеца: первый круг — в каталог, дальше — отказ; сырья — ноль всегда.
        for (const it of kit) expect(forgeSalvage(reg, main, forge, it.uid, MAX).ok, `${cls.id}: разбор, круг ${round}`).toBe(round === 0);
        expect(forge.materials ?? {}).toEqual({});
        expect(main.inventory.some((i) => i.kind === 'material')).toBe(false);
        for (const it of main.inventory.filter((i) => kit.some((k) => k.uid === i.uid))) expect(sellItem(reg, main, it.uid).ok).toBe(true);
      }
      expect(main.gold, `${cls.id}: золото за три круга`).toBeLessThanOrEqual(15);
      expect(main.inventory).toEqual([]);
      expect(normalizeJournal(forge.forgeJournal).sketches).toBe(0);
    }
  });

  it('обычная находка той же базы продаётся и разбирается как прежде — правило только про происхождение', () => {
    const save = newCharacterSave(reg, classes[0]!.id, 'Сверка', 'check-1');
    const kit = kitOf(save);
    for (const it of kit) {
      const found: Item = { ...it, origin: 'drop' };
      expect(shopSellPrice(reg, found), it.baseId).toBeGreaterThan(1);
    }
    const weapon = kit.find((i) => i.kind === 'weapon')!;
    expect(canSalvageItem(reg, { ...weapon, origin: 'drop' }, false).ok, 'найденное оружие той же базы разбирается').toBe(true);
    const legacy: Item = { ...weapon };
    delete legacy.origin;
    expect(canSalvageItem(reg, legacy, false).ok, 'вещь без происхождения (старый сейв) — как раньше').toBe(true);
  });
});

describe('⚠ R4-34: стартовая вещь, поднятая у кузнеца, — уже не бесплатный комплект', () => {
  const mats = reg.get('craft-materials');
  const worth = (w: Record<string, number>): number => Object.entries(w).reduce((s, [id, n]) => s + n * (mats.find((m) => m.id === id)?.sellPrice ?? 0), 0);
  const fullWallet = (): Record<string, number> => Object.fromEntries(mats.map((m) => [m.id, 10_000]));

  it('⭐ поднял стартовый меч за золото и сырьё — продаётся по формуле вещи и разбирается (вложенное не пропадает)', () => {
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Новичок', `up-${cls.id}`);
      expect(unequip(reg, save, 'weapon').ok).toBe(true);
      const w = save.inventory.find((i) => i.kind === 'weapon')!;
      save.gold = 100_000;
      expect(forgeUpgrade(reg, save, w.uid, fullWallet()).ok, cls.id).toBe(true);
      const up = save.inventory.find((i) => i.uid === w.uid)!;
      expect(up.origin, 'происхождение не переписывается').toBe('start');
      expect(up.tierForged).toBe(true);
      expect(shopSellPrice(reg, up), `${cls.id}: продажа`).toBeGreaterThan(1);
      expect(canSalvageItem(reg, up, false).ok, `${cls.id}: разбор у кузнеца`).toBe(true);
      expect(salvageWorth(reg, up)).toBeGreaterThan(0);
    }
  });

  it('⭐ не кран: на КАЖДОЙ ступени цепочки вложенное в подъём бесплатной вещи больше, чем она даст продажей или разбором', () => {
    let n = 0;
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Альт', `farm-${cls.id}`);
      for (const slot of Object.keys(save.equipment)) expect(unequip(reg, save, slot).ok).toBe(true);
      for (const it of [...save.inventory]) {
        const wallet = fullWallet();
        save.gold = 1e9;
        let spent = 0;
        for (;;) {
          const g0 = save.gold, w0 = worth(wallet);
          if (!forgeUpgrade(reg, save, it.uid, wallet).ok) break;
          spent += (g0 - save.gold) + (w0 - worth(wallet));
          const up = save.inventory.find((i) => i.uid === it.uid)!;
          const back = Math.max(shopSellPrice(reg, up), salvageWorth(reg, up));
          expect(back, `${cls.id} ${it.baseId} → ${up.tier}: вложено ${spent}`).toBeLessThan(spent);
          n++;
        }
      }
    }
    expect(n, 'сторож не выродился').toBeGreaterThan(100);
  });
});

/**
 * ⚠ V-B2-02 (фаззер экономики B2): КОМПЛЕКТ ДЕРЖИТСЯ НА СТАРТОВЫХ АТРИБУТАХ СВОЕГО КЛАССА. Требования ступени t0 и
 * `classes.startAttributes` правятся порознь и разъехались: пять классов из семи выходили в оружии, которого сами не держат
 * (Ловчая — короткий лук на 29 Ловкости при 17). Правило R4-08 нарушалось с первой секунды: бой брал оружие в полную силу, а
 * снятое обратно не надевалось. Теперь вещь комплекта выдаётся по руке классу (`fitToClass`): держится при любых данных.
 */
describe('⚠ V-B2-02: стартовый комплект держится на атрибутах своего класса', () => {
  const worn = (s: SaveState): Item[] => Object.values(s.equipment).filter((i): i is Item => !!i);
  const unmet = (s: SaveState): string[] => unmetWorn(s.attributes, worn(s)).map((i) => `${i.baseId} ${JSON.stringify(i.requirements)}`);
  /** Как найденная вещь той же базы, без подгонки под класс. */
  const plainOf = (r: ConfigRegistry, it: Item): Item => shapeFoundWeapon(r, itemFromBaseId(r.get('items.base'), it.baseId, r.get('item-tiers'), 'start')!);
  /** Надетое держится, и каждую вещь можно снять и надеть обратно тем же честным путём, что у игрока. */
  const holdsAndReequips = (r: ConfigRegistry, s: SaveState, who: string): void => {
    expect(worn(s).length, `${who}: комплект надет`).toBeGreaterThan(0);
    expect(unmet(s), `${who}: не держится`).toEqual([]);
    for (const [slot, it] of Object.entries(s.equipment)) {
      if (!it) continue;
      expect(unequip(r, s, slot).ok, `${who}: снять ${it.baseId}`).toBe(true);
      expect(equip(r, s, it.uid), `${who}: надеть обратно ${it.baseId}`).toEqual({ ok: true });
      expect(s.equipment[slot as keyof SaveState['equipment']]?.uid, `${who}: ${it.baseId} на месте`).toBe(it.uid);
    }
    expect(unmet(s), `${who}: после перенадевания`).toEqual([]);
  };

  it('⭐ живой конфиг: у каждого класса комплект держится, снятое надевается обратно; бот прогона держит то же оружие', () => {
    expect(classes.length).toBeGreaterThan(1);
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Новичок', `v-b2-02-${cls.id}`);
      expect(save.equipment.weapon?.baseId, `${cls.id}: оружие класса`).toBe(cls.startWeaponId);
      holdsAndReequips(reg, save, cls.id);
      const bot = newBotSave(reg, cls.id);
      expect(unmet(bot), `бот ${cls.id}`).toEqual([]);
      expect(bot.equipment.weapon?.requirements, `бот ${cls.id}: та же вещь, что у героя`).toEqual(save.equipment.weapon?.requirements);
    }
  });

  it('честный старт прежний: база, ступень, статы и детали — как у находки той же базы; требование срезано лишь сверх атрибута', () => {
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Сверка', `v-b2-02-same-${cls.id}`);
      for (const it of [...worn(save), ...save.inventory]) {
        const plain = plainOf(reg, it);
        const strip = ({ uid: _u, pos: _p, requirements: _r, ...rest }: Item) => rest;
        expect(strip(it), `${cls.id}: ${it.baseId}`).toEqual(strip(plain));
        const start = cls.startAttributes as Record<Attribute, number>;
        const want = Object.fromEntries(Object.entries(plain.requirements).map(([a, v]) => [a, Math.min(v!, start[a as Attribute])]));
        expect(it.requirements, `${cls.id}: ${it.baseId}`).toEqual(want);
        // Вещь, которую класс и так держал (Волкодав, Заклинатель, кожаный комплект), не изменилась ни в одном числе.
        if (Object.entries(plain.requirements).every(([a, v]) => v! <= start[a as Attribute])) expect(it.requirements).toEqual(plain.requirements);
      }
    }
  });

  it('⭐ правка хозяина живьём не ломает комплект: требования задраны, оружие класса выключено (замена родственной), старт опущен', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    const starterWeapons = new Set(classes.map((c) => c.startWeaponId));
    const armor = new Set(['leather-cap', 'leather-armor', 'leather-boots', 'leather-belt']);
    // ⚠ R18-07: дробный старт (было «Ловкость + 0.5») схема больше не пускает — половину очка после сброса не вложить никогда.
    const halfDex = r.get('classes').map((c) => ({ ...c, startAttributes: { ...c.startAttributes, dexterity: c.startAttributes.dexterity + 0.5 } }));
    expect(() => r.reload({ classes: halfDex }), 'дробный старт').toThrow(/не прошёл валидацию/);
    r.reload({
      'items.base': r.get('items.base').map((b) => {
        if (b.kind !== 'weapon' && !armor.has(b.id)) return b;
        return { ...b, requirements: { strength: 55, dexterity: 55, intelligence: 55 }, ...(starterWeapons.has(b.id) ? { enabled: false } : {}) };
      }),
      classes: r.get('classes').map((c) => ({ ...c, startAttributes: { ...c.startAttributes, dexterity: Math.max(0, c.startAttributes.dexterity - 3) } })),
    });
    for (const cls of r.get('classes').filter((c) => c.enabled !== false)) {
      const save = newCharacterSave(r, cls.id, 'Альт', `v-b2-02-edit-${cls.id}`);
      const w = save.equipment.weapon;
      expect(w, `${cls.id}: оружие-замена выдано`).toBeDefined();
      expect(w!.baseId, `${cls.id}: выключенное оружие класса не выдаётся (R14-08)`).not.toBe(cls.startWeaponId);
      for (const it of [...worn(save), ...save.inventory]) {
        expect(it.origin).toBe('start');
        for (const [a, v] of Object.entries(it.requirements)) {
          expect(Number.isInteger(v), `${cls.id}: ${it.baseId} ${a}=${v} — целое`).toBe(true);
          expect(v, `${cls.id}: ${it.baseId} ${a}`).toBeLessThanOrEqual(cls.startAttributes[a as Attribute]);
        }
        expect(it.requirements, `${cls.id}: ${it.baseId} — задранное требование срезано`).not.toEqual(plainOf(r, it).requirements);
      }
      holdsAndReequips(r, save, cls.id);
      expect(unmet(newBotSave(r, cls.id)), `бот ${cls.id}`).toEqual([]);
    }
  });

  it('скидка живёт только на нетронутой вещи комплекта: подъём у кузнеца пересобирает требования от базы, как у находки', () => {
    for (const cls of classes) {
      const w = newCharacterSave(reg, cls.id, 'Новичок', `v-b2-02-up-${cls.id}`).equipment.weapon!;
      const up = upgradedItem(reg, w);
      expect(up, cls.id).toBeDefined();
      expect(up!.requirements, cls.id).toEqual(upgradedItem(reg, plainOf(reg, w))!.requirements);
    }
  });
});
