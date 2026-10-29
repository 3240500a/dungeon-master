/**
 * ⭐ ЦЕНА ВИДА = ФАКТ КОМАНДЫ. Клиент больше ничего не считает: согласие команды (`maxGold`, `maxMaterials`, `minYield`, `avgYield`, `minGold`)
 * он копирует из вида. Здесь каждое такое согласие уходит в ТУ ЖЕ функцию, которой сервер исполняет команду (`room.ts` → townActions /
 * exchange), на копии сейва и сундука: горящая карточка исполняется, а согласие ниже названного (на единицу) — «Цена изменилась».
 * Вещи — все вещи эталона панелей (найденные, сломанные, скованные, зачарованные, стартовые, уник, сырьё…), конфиг — его снимок.
 */
import { describe, it, expect } from 'vitest';
import type { AccountStash, Item, SaveState } from '../types/index.js';
import { createRng } from '../formulas/rng.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import {
  PRICE_CHANGED, allocPassive, buyItem, enchantAction, fieldSalvage, forgeRepair, forgeReroll, forgeSalvage, forgeUpgrade, respec,
  respecPassives, respecSkills, sellItem, serverMaterialsConsent, setBinding, socketClear, socketInsert,
} from '../economy/townActions.js';
import { forgeExchange } from '../economy/exchange.js';
import { GOLDEN, readGolden, registryFromGolden } from './town.testkit.js';
import { bindView, exchangeView, forgeBenchView, itemMenuView, respecView, shopView, socketsView, type BenchAction } from './town.js';

type Golden = { config: Record<string, unknown>; items: { item: Item }[]; bags: { stacks200: Item[] }; sockets: { name: string; save: SaveState }[] };
const g = readGolden<Golden>(GOLDEN.panels);
const clone = <T>(v: T): T => structuredClone(v);
const minus = (m: Record<string, number> | undefined): Record<string, number> | undefined => {
  const k = m && Object.keys(m).find((id) => m[id]! > 0);
  return k ? { ...m, [k]: m[k]! - 1 } : undefined;
};

describe.skipIf(!g)('цена вида = факт команды сервера', () => {
  const reg = registryFromGolden(g!.config);
  const rich = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1000]));
  const heroWith = (item: Item, gold = 10_000_000): { save: SaveState; stash: AccountStash } => {
    const save = newCharacterSave(reg, 'warrior', 'consent', 'consent');
    save.gold = gold;
    save.inventory = [{ ...clone(item), pos: { x: 9, y: 5 } }, ...clone(g!.bags.stacks200)];
    return { save, stash: { version: 1, tabs: [], materials: { ...rich } } as AccountStash };
  };
  /** Команда верстака — так, как её исполняет сервер (`room.ts` dispatch): согласие на сырьё обязательно (`serverMaterialsConsent`). */
  const run = (a: BenchAction, save: SaveState, stash: AccountStash, uid: string, gold = a.gold, mats = a.materials, low = a.minYield): { ok: boolean; reason?: string } => {
    const w = stash.materials!;
    switch (a.cmd) {
      case 'forgeUpgrade': return forgeUpgrade(reg, save, uid, w, gold, serverMaterialsConsent(mats));
      case 'forgeRepair': return forgeRepair(reg, save, uid, w, gold, serverMaterialsConsent(mats));
      case 'forgeReroll': return forgeReroll(reg, save, uid, createRng(7), gold, w, serverMaterialsConsent(mats));
      case 'forgeEnchant': return enchantAction(reg, save, uid, a.rarity!, createRng(7), gold, w, serverMaterialsConsent(mats));
      case 'forgeSalvage': return forgeSalvage(reg, save, stash, uid, createRng(7), low, a.avgYield);
    }
  };

  it('верстак: горящая карточка исполняется со своим согласием, согласие ниже — «Цена изменилась»', () => {
    let fired = 0, refused = 0;
    for (const { item } of g!.items) {
      const { save, stash } = heroWith(item);
      const v = forgeBenchView(reg, save, stash, item.uid)!;
      for (const a of v.actions.filter((x) => x.enabled)) {
        const who = `${item.uid} ${a.cmd}${a.rarity ? `:${a.rarity}` : ''}`;
        const ok = run(a, clone(save), clone(stash), item.uid);
        expect(ok.ok, `${who}: ${ok.reason}`).toBe(true);
        fired++;
        if (a.gold !== undefined && a.gold > 0) {
          expect(run(a, clone(save), clone(stash), item.uid, a.gold - 1).reason ?? '', `${who} maxGold−1`).toMatch(new RegExp(`^${PRICE_CHANGED}`));
          refused++;
        }
        const lessMats = minus(a.materials);
        if (lessMats) { expect(run(a, clone(save), clone(stash), item.uid, a.gold, lessMats).reason ?? '', `${who} maxMaterials−1`).toMatch(new RegExp(`^${PRICE_CHANGED}`)); refused++; }
        const k = a.minYield && Object.keys(a.minYield)[0];
        if (k) {
          const more = { ...a.minYield, [k]: a.minYield![k]! + 1 };
          expect(run(a, clone(save), clone(stash), item.uid, a.gold, a.materials, more).reason ?? '', `${who} minYield+1`).toMatch(new RegExp(`^${PRICE_CHANGED}`));
          refused++;
        }
      }
    }
    expect(fired).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
  });

  it('разбор в поле из меню сумки: команда вида исполняется (`fieldSalvage`)', () => {
    let n = 0;
    for (const { item } of g!.items) {
      const { save } = heroWith(item);
      save.inventory = [save.inventory[0]!];   // сумка пустая — место под выход есть
      const sv = itemMenuView(reg, save, null, item.uid, false).find((m) => m.act === 'salvage');
      if (!sv) continue;
      const c = sv.command!;
      expect(fieldSalvage(reg, clone(save), c.uid, createRng(3), c.minYield, c.avgYield).ok, item.uid).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(50);
  });

  it('прилавок: купит по цене вида (`buy` с `maxGold`), продаст по цене вида (`sell` с `minGold`); отказ вида = отказ сервера', () => {
    const items = g!.items.map((c) => c.item);
    const { save, stash } = heroWith(items[0]!, 5_000);
    save.inventory = items.slice(0, 40).map((it, i) => ({ ...clone(it), uid: `bag-${i}`, pos: null }));
    const stock = [...items.slice(40, 80), itemFromBaseId(reg.get('items.base'), 'healing-potion', undefined, 'shop')!].map((it, i) => ({ ...clone(it), uid: `st-${i}` }));
    const v = shopView(reg, save, stash, stock);
    for (const it of stock) {
      const o = v.buy[it.uid]!;
      const r = buyItem(reg, clone(save), clone(it), o.price);
      expect(r.ok ? null : r.reason, it.uid).toBe(o.refusal);
      if (o.price > 0) expect(buyItem(reg, { ...clone(save), gold: 1e9 }, clone(it), o.price - 1).reason ?? '', it.uid).toMatch(new RegExp(`^${PRICE_CHANGED}`));
    }
    for (const it of save.inventory) {
      const o = v.sell[it.uid]!;
      const r = sellItem(reg, clone(save), it.uid, o.price);
      expect(r.ok ? null : r.reason, it.uid).toBe(o.refusal);
      expect(sellItem(reg, clone(save), it.uid, o.price + 1).reason ?? '', it.uid).toMatch(new RegExp(`^${PRICE_CHANGED}`));
    }
  });

  it('обмен: команда вида исполняется (`forgeExchange`)', () => {
    const { save, stash } = heroWith(g!.items[0]!.item, 100_000);
    let n = 0;
    const first = exchangeView(reg, save, stash, { from: null, to: null });
    for (const src of first.sources.slice(0, 20)) {
      const withTargets = exchangeView(reg, save, stash, { from: src.id, to: null });
      for (const t of withTargets.targets.filter((x) => x.ok)) {
        const v = exchangeView(reg, save, stash, { from: src.id, to: t.family });
        if (!v.canSend) continue;
        const c = v.command!;
        expect(forgeExchange(reg, clone(save), clone(stash), c.from, c.to, c.n, c.maxGold, c.maxMaterials, c.minYield).ok, `${c.from}→${c.to}`).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it('мастер: сбросы и ранг узла мастерства по цене вида; отказ вида = отказ сервера', () => {
    const s = newCharacterSave(reg, 'warrior', 'm', 'm');
    s.gold = 1_000_000;
    s.attributes.strength += 5;
    const nodes = reg.get('skill-tree').nodes.slice(0, 3);
    for (const nd of nodes) s.skills[nd.id] = 2;
    const tree = reg.get('mastery-tree');
    const entry = tree.nodes.find((nd) => nd.cost.type === 'gold' && nd.maxRank >= 2)!.id;   // ранг уже есть — смежность не нужна
    s.masteries[entry] = 1;
    s.unspentMasteryPoints = 5;
    s.level = 99;
    const v = respecView(reg, s);
    expect(v.attrs.refusal).toBeNull();
    expect(respec(reg, clone(s), v.attrs.cost).ok).toBe(true);
    expect(respecSkills(reg, clone(s), v.skills.fee).ok).toBe(v.skills.refusal === null);
    expect(respecSkills(reg, clone(s), v.skills.fee - 1).reason ?? '').toMatch(new RegExp(`^${PRICE_CHANGED}`));
    expect(respecPassives(reg, clone(s), v.masteries.fee).ok).toBe(v.masteries.refusal === null);
    const cost = v.nodeCosts[entry]!;
    expect(allocPassive(reg, clone(s), entry, cost).ok).toBe(true);
    expect(allocPassive(reg, clone(s), entry, cost - 1).reason ?? '').toMatch(new RegExp(`^${PRICE_CHANGED}`));
    const poor = { ...clone(s), gold: 0 };
    const pv = respecView(reg, poor);
    expect(pv.skills.refusal).toBe(respecSkills(reg, clone(poor), pv.skills.fee).reason);
    expect(pv.masteries.refusal).toBe(respecPassives(reg, clone(poor), pv.masteries.fee).reason);
  });

  it('сборка скилов и бинды: каждый предложенный вариант сервер исполняет (`socketInsert` / `socketClear` / `bind`)', () => {
    let n = 0;
    for (const sc of g!.sockets) {
      for (const l of socketsView(reg, sc.save).learned) {
        l.cells.forEach((c, slot) => {
          for (const o of c.options) {
            const r = o.insertId ? socketInsert(reg, clone(sc.save), l.id, slot, o.insertId) : socketClear(reg, clone(sc.save), l.id, slot);
            expect(r.ok, `${sc.name} ${l.id}[${slot}] ${o.label}: ${r.reason}`).toBe(true);
            n++;
          }
        });
      }
      const full = { ...newCharacterSave(reg, 'warrior', 'b', 'b'), ...clone(sc.save) };
      for (const o of bindView(reg, full).options) expect(setBinding(reg, clone(full), 2, o.id).ok, `${sc.name} bind ${o.id}`).toBe(true);
    }
    expect(n).toBeGreaterThan(100);
  });
});
