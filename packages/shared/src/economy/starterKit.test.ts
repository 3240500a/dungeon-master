import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { canSalvageItem, fieldSalvage, forgeSalvage, forgeUpgrade, salvageRange, salvageWorth, sellItem, shopSellPrice, unequip } from './townActions.js';
import { newCharacterSave } from './newCharacter.js';
import { emptyStash, stashMove } from './stashActions.js';
import { createRng } from '../formulas/rng.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R3-04: СТАРТОВЫЙ КОМПЛЕКТ НЕ ПЕЧАТАЕТ ЗОЛОТО И СЫРЬЁ.
 *
 * Комплект (оружие класса + четыре кожаные вещи, `origin: 'start'`) бесплатен и бесконечен: создал героя, снял
 * комплект, переложил в сундук аккаунта (или бросил соседу), удалил героя — и заново. Слот героя освобождается
 * сразу, лимита на создание нет. Лавка платила 35 золота за комплект, разбор давал 11–21 единицу сырья первой
 * ступени — ровно той, что ест лестница подъёма. Скрипт гонял круг за 2–3 с: 40–60 тыс. золота в час на аккаунт,
 * больше, чем дают убийства на низких и средних уровнях. Журнал R1-04 закрыл (`countsAsFind`), золото и сырьё — нет.
 *
 * Теперь стартовая вещь за пределами своего героя ничего не стоит: лавка берёт её за 1, кузнец не разбирает.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const classes = reg.get('classes').filter((c) => c.enabled !== false);
const kitOf = (s: SaveState): Item[] => [...Object.values(s.equipment).filter((i): i is Item => !!i), ...s.inventory];
const MAX = { int: (_a: number, b: number) => b, chance: () => true };

describe('⚠ R3-04: стартовый комплект вне своего героя ничего не стоит', () => {
  it('⭐ у каждого класса: продажа комплекта ≤ 5 золота, разбор — ноль сырья (у кузнеца и в поле)', () => {
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
        for (const inField of [false, true]) {
          expect(canSalvageItem(reg, it, inField).ok, `${cls.id}: ${it.baseId} ${inField ? 'поле' : 'кузница'}`).toBe(false);
          expect(salvageRange(reg, it, inField).ok).toBe(false);
        }
      }
    }
  });

  it('⭐ разбор стартовой вещи — отказ ДО траты: вещь цела, сырья и журнала нет', () => {
    for (const cls of classes) {
      const save = newCharacterSave(reg, cls.id, 'Альт', `alt2-${cls.id}`);
      for (const slot of Object.keys(save.equipment)) expect(unequip(reg, save, slot).ok, `${cls.id} ${slot}`).toBe(true);
      for (const it of [...save.inventory]) {
        const stash = emptyStash(reg);
        const before = JSON.stringify([save, stash]);
        const r = forgeSalvage(reg, save, stash, it.uid, MAX);
        expect(r.ok, `${cls.id}: ${it.baseId}`).toBe(false);
        expect(r.reason).toMatch(/стартов/i);
        expect(fieldSalvage(reg, save, it.uid, createRng(1)).ok).toBe(false);
        expect(JSON.stringify([save, stash]), `${cls.id}: ${it.baseId} — ничего не тронуто`).toBe(before);
      }
    }
  });

  it('⭐ круг «создал → снял → в сундук → удалил» ×3 на каждом классе: главный герой выручает ≤ 5 золота за круг и ноль сырья', () => {
    for (const cls of classes) {
      const stash = emptyStash(reg);
      const main = newCharacterSave(reg, cls.id, 'Главный', `main-${cls.id}`);
      main.inventory = [];
      main.gold = 0;
      for (let round = 0; round < 3; round++) {
        const alt = newCharacterSave(reg, cls.id, 'Альт', `churn-${cls.id}-${round}`);
        for (const slot of Object.keys(alt.equipment)) expect(unequip(reg, alt, slot).ok).toBe(true);
        const kit = [...alt.inventory];
        kit.forEach((it, i) => expect(stashMove(reg, alt, stash, it.uid, 0, i * 3, 0).ok, `${cls.id}: в сундук`).toBe(true));
        // Альта удалили — комплект у аккаунта. Главный забирает и сдаёт.
        kit.forEach((it, i) => expect(stashMove(reg, main, stash, it.uid, 'inv', i * 2, 0).ok, `${cls.id}: из сундука`).toBe(true));
        for (const it of kit) {
          const st = emptyStash(reg);
          expect(forgeSalvage(reg, main, st, it.uid, MAX).ok, `${cls.id}: разбор`).toBe(false);
          expect(st.materials ?? {}).toEqual({});
        }
        for (const it of kit) expect(sellItem(reg, main, it.uid).ok).toBe(true);
      }
      expect(main.gold, `${cls.id}: золото за три круга`).toBeLessThanOrEqual(15);
      expect(main.inventory).toEqual([]);
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
