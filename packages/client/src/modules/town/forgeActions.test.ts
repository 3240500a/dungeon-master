import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, canRerollItem, craftAction, createRng, defaultParts, emptyStash, enchantAction, enchantCost, forgeGold, forgeRepair,
  forgeReroll, forgeSalvage, forgeUpgrade, fullJournal, generateItem, newBotSave, retierItem, shapeFoundWeapon,
  type AccountStash, type Item, type SaveState,
} from '@dm/shared';
import { benchActions, benchTarget, diffStrings, type BenchAction } from './forgeActions.js';

/**
 * Верстак кузницы: ЧТО он предлагает делать с вещью. Правило, которое здесь стережётся, —
 * «первая карточка не меняет места, только смысл»: целой вещи «Улучшить», сломанной «Починить».
 * Без него игрок со сломанной сумкой (а после забега она вся сломанная) видит главным действием
 * то, которое ему недоступно.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

/** Вещь из стартового комплекта: настоящая, со своей базой, тиром и правилом разбора. */
function gearItem(broken = false): Item {
  const save = newBotSave(reg, reg.get('classes')[0]!.id);
  const it = save.equipment.weapon!;
  return { ...it, broken: broken || undefined };
}
const RICH = { 'iron-1': 999, 'iron-2': 999, 'iron-3': 999, 'wood-1': 999, 'wood-2': 999, 'wood-3': 999,
  'cloth-1': 999, 'cloth-2': 999, 'cloth-3': 999, 'hide-1': 999, 'hide-2': 999, 'hide-3': 999,
  'plate-1': 999, 'plate-2': 999, 'plate-3': 999 };

describe('benchActions — какое действие главное', () => {
  it('⭐ у ЦЕЛОЙ вещи первая карточка «Улучшить»', () => {
    const a = benchActions(reg, gearItem(), 99999, [], RICH);
    expect(a[0]!.id).toBe('upgrade');
    expect(a[0]!.primary).toBe(true);
    expect(a[0]!.enabled).toBe(true);
  });

  it('⭐ у СЛОМАННОЙ вещи первая карточка «Починить» — на том же месте', () => {
    const a = benchActions(reg, gearItem(true), 99999, [], RICH);
    expect(a[0]!.id).toBe('repair');
    expect(a[0]!.primary).toBe(true);
    expect(a[0]!.enabled).toBe(true);
    // ⚠ Улучшения в списке НЕТ вовсе: сломанное улучшать нельзя, и мёртвая карточка только шумела бы.
    expect(a.some((x) => x.id === 'upgrade')).toBe(false);
  });

  it('порядок карточек фиксирован, разбор ВСЕГДА последний (он уничтожает вещь)', () => {
    for (const broken of [false, true]) {
      const ids = benchActions(reg, gearItem(broken), 99999, [], RICH).map((x) => x.id);
      expect(ids[ids.length - 1]).toBe('salvage');
      expect(ids).toHaveLength(3);
      expect(ids.filter((_, i) => i > 0).every((id) => id !== 'repair' && id !== 'upgrade')).toBe(true);
    }
  });

  it('реролл сломанной гаснет и ГОВОРИТ ПОЧЕМУ, а не просто серый', () => {
    const rr = benchActions(reg, gearItem(true), 99999, [], RICH).find((x) => x.id === 'reroll')!;
    expect(rr.enabled).toBe(false);
    expect(rr.lines.map((l) => l.text).join(' ')).toContain('почини');
  });

  it('⚠ R2-13: у обычной вещи реролл гаснет с причиной — тем же правилом, что отказ сервера', () => {
    const plain = gearItem();
    expect(plain.rarity).toBe('normal');
    const rr = benchActions(reg, plain, 99999, [], RICH).find((x) => x.id === 'reroll')!;
    expect(rr.enabled, 'было: 120 золота за ноль аффиксов').toBe(false);
    expect(rr.lines.map((l) => l.text).join(' ')).toContain('нечего перекатывать');
    expect(rr.lines.map((l) => l.text).join(' ')).toBe(canRerollItem(reg, plain).reason);
    const magic = { ...plain, rarity: 'magic' as const };
    const ok = benchActions(reg, magic, 99999, [], RICH).find((x) => x.id === 'reroll')!;
    expect(ok.enabled).toBe(true);
    expect(ok.lines[0]!.text).toBe(`${forgeGold(reg, magic, 'reroll')} золота`);
  });
});

describe('benchActions — цена построчно', () => {
  it('⭐ нехватка видна СТРОКОЙ с «есть N», а не одной серой кнопкой', () => {
    const a = benchActions(reg, gearItem(), 99999, [], {}); // сырья нет вовсе
    const up = a[0]!;
    expect(up.enabled).toBe(false);
    const miss = up.lines.filter((l) => l.state === 'miss');
    expect(miss.length).toBeGreaterThan(0);
    expect(miss.some((l) => l.text.includes('есть 0'))).toBe(true);
  });

  it('нехватка ЗОЛОТА помечает свою строку, а строки сырья остаются зелёными', () => {
    const up = benchActions(reg, gearItem(), 0, [], RICH)[0]!;
    expect(up.enabled).toBe(false);
    const gold = up.lines.find((l) => l.text.includes('золота'))!;
    expect(gold.state).toBe('miss');
    expect(up.lines.filter((l) => l !== gold).every((l) => l.state === 'ok')).toBe(true);
  });

  it('разбор показывает выход ВИЛКОЙ — он случаен, одно число было бы враньём', () => {
    // Находка той же базы: стартовое кузнец не разбирает (R3-04) — см. ниже.
    const sv = benchActions(reg, { ...gearItem(), origin: 'drop' }, 99999, [], RICH).find((x) => x.id === 'salvage')!;
    expect(sv.enabled).toBe(true);
    expect(sv.lines.length).toBeGreaterThan(0);
    expect(sv.lines.every((l) => l.state === 'gain')).toBe(true);
  });

  it('R3-04: стартовое кузнец не разбирает — карточка разбора гаснет тем же правилом, что отказ сервера', () => {
    const it0 = gearItem();
    expect(it0.origin).toBe('start');
    const sv = benchActions(reg, it0, 99999, [], RICH).find((x) => x.id === 'salvage');
    expect(sv?.enabled ?? false).toBe(false);
  });

  it('⚠ сырьё в СУМКЕ засчитывается наравне с сундуком (кузница тратит оба)', () => {
    const item = gearItem();
    const empty = benchActions(reg, item, 99999, [], {})[0]!;
    expect(empty.enabled).toBe(false);
    // Тот же расчёт, но запас лежит в сумке стеками, а не в сундуке.
    const bag: Item[] = Object.keys(RICH).map((id, i) => ({
      uid: `m${i}`, baseId: id, materialId: id, kind: 'material', name: id, rarity: 'normal',
      itemLevel: 1, count: 999, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1, pos: null,
    } as unknown as Item));
    expect(benchActions(reg, item, 99999, bag, {})[0]!.enabled).toBe(true);
  });
});

/**
 * ⭐ R2-12: КАРТОЧКА НЕ ОБЕЩАЕТ ТОГО, В ЧЁМ СЕРВЕР ОТКАЖЕТ. «Улучшить» считала своё (`nextTierOf` + `upgradeCost`) и
 * скованной вещи не видела: главная карточка горела «до «Отличный» — 640 золота», шапка над ней писала «Кузнец эту
 * вещь не меняет», а сервер всегда отвечал «Скованную вещь поднимает замена детали». Теперь карточка гаснет тем же
 * правилом, что отказ сервера (`canUpgradeItem`), — как реролл (`canRerollItem`) и разбор (`canSalvageItem`).
 */
describe('⭐ R2-12: карточка верстака ≡ ответ сервера', () => {
  const fullWallet = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 5000]));
  let nonce = 0;
  /** Настоящая скованная вещь — ядром сервера (`craftAction`), в сумке настоящего сейва. */
  function craftedIn(save: SaveState, stash: AccountStash, cls = 'sword', hands = 1, step = 2): Item | null {
    const parts = defaultParts(reg, cls, hands, step);
    if (!parts) return null;
    const r = craftAction(reg, save, stash, `bench-nonce-${++nonce}`, { weaponClass: cls, hands, parts }, createRng(nonce), { fullJournal: true });
    return r.ok ? save.inventory.find((i) => i.uid === r.uid)! : null;
  }
  const richSave = (): SaveState => { const s = newBotSave(reg, reg.get('classes')[0]!.id); s.gold = 10_000_000; s.inventory = []; return s; };
  const richStash = (): AccountStash => ({ ...emptyStash(reg), materials: fullWallet(), forgeJournal: fullJournal(reg) });

  it('⭐ скованной вещи «Улучшить» ПОГАШЕНА и говорит почему — и сервер на том же сейве отказывает', () => {
    const save = richSave(), stash = richStash();
    const item = craftedIn(save, stash)!;
    expect(item?.parts).toBeTruthy();
    const up = benchActions(reg, item, save.gold, save.inventory, stash.materials!).find((a) => a.id === 'upgrade')!;
    expect(up.enabled, 'было: карточка горела с ценой').toBe(false);
    expect(up.lines.map((l) => l.text).join(' ')).toContain('замена детали');
    expect(up.sub).not.toMatch(/^до «/);
    expect(forgeUpgrade(reg, save, item.uid, stash.materials!).ok).toBe(false);
    expect(benchTarget(reg, item), 'шапка и карточка говорят одно').toBeUndefined();
  });

  /**
   * Какая серверная команда стоит за карточкой — на КОПИИ сейва и сундука. ⭐ R5-15: с ценой карточки (`maxGold`) — как её
   * шлёт верстак: цена карточки, разошедшаяся с ценой сервера, здесь стала бы отказом «Цена изменилась».
   */
  function server(a: BenchAction, save: SaveState, stash: AccountStash, uid: string): boolean {
    const s = structuredClone(save), st = structuredClone(stash);
    const w = st.materials ?? (st.materials = {});
    switch (a.cmd) {
      case 'forgeUpgrade': return forgeUpgrade(reg, s, uid, w, a.gold).ok;
      case 'forgeRepair': return forgeRepair(reg, s, uid, w, a.gold).ok;
      case 'forgeReroll': return forgeReroll(reg, s, uid, createRng(1), a.gold).ok;
      case 'forgeSalvage': return forgeSalvage(reg, s, st, uid, createRng(1)).ok;
      // R3-09: сервер отказывает зачарованию и при закрытой ковке (`balance.craft.live`) — до ядра.
      case 'forgeEnchant': return reg.get('balance').craft.live && enchantAction(reg, s, uid, a.rarity!, createRng(1), a.gold).ok;
    }
  }

  it('⭐ свойство: над скованными и найденными вещами карточка горит ⇔ сервер на том же сейве не отказывает', () => {
    const items: Item[] = [];
    // Скованные: все семейства, ступени, обе хватки; часть — зачарованы (ёмкость формы у реролла).
    const forge = richSave(), forgeStash = richStash();
    const classes = [...new Set(reg.get('items.base').filter((b) => b.kind === 'weapon').map((b) => b.weaponClass!))];
    for (const cls of classes) for (const hands of [1, 2]) for (const step of [0, 1, 3, 5]) {
      const it = craftedIn(forge, forgeStash, cls, hands, step);
      if (!it) continue;
      items.push(structuredClone(it));
      for (const rar of ['magic', 'rare'] as const) {
        const e = enchantAction(reg, forge, it.uid, rar, createRng(nonce + items.length));
        if (e.ok) items.push(structuredClone(forge.inventory.find((i) => i.uid === (e.uid ?? it.uid))!));
      }
      forge.inventory = [];   // сумка не копит — следующей ковке нужно место
    }
    expect(items.filter((i) => i.parts && i.rarity === 'normal').length).toBeGreaterThan(40);
    expect(items.filter((i) => i.parts && i.affixCap).length, 'зачарованные скованные — с ёмкостью формы').toBeGreaterThan(20);
    // Найденные: уровни 1…99, все редкости, сломанные и с исчерпанными перекатками.
    const bal = reg.get('balance');
    const rng = createRng(12);
    for (let n = 0; n < 160; n++) {
      const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1.5, itemLevel: 1 + ((n * 7) % 99), tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
        maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
      }, rng));
      items.push(n % 5 === 0 ? { ...it, broken: true } : n % 7 === 0 ? { ...it, rerolls: bal.forgePrices.rerollLimit } : it);
    }
    let checked = 0, enabled = 0;
    for (const item of items) {
      for (const [gold, wallet] of [[10_000_000, fullWallet()], [0, fullWallet()], [10_000_000, {}]] as const) {
        const save = richSave();
        save.gold = gold;
        save.inventory = [{ ...structuredClone(item), pos: { x: 0, y: 0 } }];
        const stash: AccountStash = { ...emptyStash(reg), materials: { ...wallet }, forgeJournal: fullJournal(reg) };
        for (const a of benchActions(reg, save.inventory[0]!, save.gold, save.inventory, stash.materials!)) {
          const ok = server(a, save, stash, item.uid);
          expect(a.enabled, `${a.id} «${item.name}» (${item.parts ? 'скованная' : item.rarity}${item.broken ? ', сломана' : ''}), золото ${gold}: ${a.lines.map((l) => l.text).join(' · ')}`).toBe(ok);
          checked++;
          if (a.enabled) enabled++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(enabled, 'свойство не пустое: горящих карточек много').toBeGreaterThan(200);
  });
});

/**
 * ⭐ R3-09: ЗАЧАРОВАТЬ СКОВАННУЮ ВЕЩЬ МОЖНО С ВЕРСТАКА. Единственная кнопка зачарования жила в окне ковки и только для
 * вещи, скованной в ЭТОМ состоянии окна: перезагрузка, другой герой или любой клик по деталям — и зачаровать меч за
 * 3 тыс. было уже негде (верстак предлагал только погашенные «Улучшить» и «Реролл» и разбор). Теперь у скованной вещи
 * на верстаке две карточки — «✦ Магический» и «✦ Редкий», и горят они ТЕМ ЖЕ правилом, которым отказывает сервер
 * (`canEnchantItem` + золото + `balance.craft.live`).
 */
describe('⭐ R3-09: зачарование скованной — с верстака', () => {
  const fullWallet = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 5000]));
  /**
   * Реестры с ковкой открытой и закрытой (`balance.craft.live`) — ЯВНО, а не «как в данных»: с 26.09 ковка в данных
   * открыта (решение владельца), а закрытое поведение по-прежнему обязано быть правдой, если флаг снимут.
   */
  const withLive = (live: boolean): ConfigRegistry => {
    const r = new ConfigRegistry(); r.loadAll();
    const b = r.get('balance');
    r.reload({ balance: { ...b, craft: { ...b.craft, live } } });
    return r;
  };
  const liveReg = withLive(true);
  const closedReg = withLive(false);
  let nonce = 0;
  const richSave = (): SaveState => { const s = newBotSave(reg, reg.get('classes')[0]!.id); s.gold = 10_000_000; s.inventory = []; return s; };
  const richStash = (): AccountStash => ({ ...emptyStash(reg), materials: fullWallet(), forgeJournal: fullJournal(reg) });
  function crafted(cls = 'sword', hands = 1, step = 2): Item | null {
    const save = richSave();
    const parts = defaultParts(reg, cls, hands, step);
    if (!parts) return null;
    const r = craftAction(reg, save, richStash(), `r3-09-nonce-${++nonce}`, { weaponClass: cls, hands, parts }, createRng(nonce), { fullJournal: true });
    return r.ok ? save.inventory.find((i) => i.uid === r.uid)! : null;
  }
  const enchantCards = (a: BenchAction[]): BenchAction[] => a.filter((x) => x.id === 'enchant');

  it('⭐ свежая скованная вещь: на верстаке «✦ Магический» и «✦ Редкий» горят, команда — `forgeEnchant` с редкостью', () => {
    const item = crafted()!;
    expect(item.parts && item.rarity).toBe('normal');
    const cards = enchantCards(benchActions(liveReg, item, 10_000_000, [item], fullWallet()));
    expect(cards.map((c) => [c.cmd, c.rarity, c.enabled]), 'было: карточек зачарования на верстаке нет вовсе').toEqual([
      ['forgeEnchant', 'magic', true], ['forgeEnchant', 'rare', true],
    ]);
  });

  it('ковка закрыта (`craft.live`) — карточки есть, но погашены и говорят почему: сервер откажет', () => {
    const item = crafted()!;
    const cards = enchantCards(benchActions(closedReg, item, 10_000_000, [item], fullWallet()));
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => !c.enabled && c.lines[0]!.state === 'dim')).toBe(true);
  });

  it('⭐ в данных ковка открыта (решение владельца): на реестре «как в игре» карточки зачарования горят', () => {
    expect(reg.get('balance').craft.live, 'balance.craft.live в data/balance.json').toBe(true);
    const item = crafted()!;
    expect(enchantCards(benchActions(reg, item, 10_000_000, [item], fullWallet())).map((c) => c.enabled)).toEqual([true, true]);
  });

  it('карточки не прыгают: у скованной до и после зачарования — тот же порядок; у найденной их нет вовсе', () => {
    const item = crafted()!;
    const ids = (it: Item): string[] => benchActions(liveReg, it, 10_000_000, [it], fullWallet()).map((x) => `${x.id}${x.rarity ? `:${x.rarity}` : ''}`);
    const save = richSave(); save.inventory = [{ ...item, pos: { x: 0, y: 0 } }];
    expect(enchantAction(reg, save, item.uid, 'magic', createRng(3)).ok).toBe(true);
    expect(ids(save.inventory[0]!)).toEqual(ids(item));
    expect(ids(item)).toEqual(['upgrade', 'reroll', 'enchant:magic', 'enchant:rare', 'salvage']);
    expect(ids({ ...gearItem(), origin: 'drop' })).toEqual(['upgrade', 'reroll', 'salvage']);
  });

  it('⭐ свойство: карточка зачарования горит ⇔ сервер на том же сейве не отказывает (живая и закрытая ковка, бедный и богатый, сломанная)', () => {
    const items: Item[] = [];
    const classes = [...new Set(reg.get('items.base').filter((b) => b.kind === 'weapon').map((b) => b.weaponClass!))];
    for (const cls of classes) for (const hands of [1, 2]) for (const step of [0, 2, 5]) {
      const it = crafted(cls, hands, step);
      if (!it) continue;
      items.push(it, { ...it, broken: true });
      const s = richSave(); s.inventory = [{ ...it, pos: { x: 0, y: 0 } }];
      if (enchantAction(reg, s, it.uid, 'rare', createRng(items.length)).ok) items.push(s.inventory[0]!);
    }
    expect(items.filter((i) => i.rarity === 'normal' && !i.broken).length).toBeGreaterThan(20);
    let checked = 0, enabled = 0;
    for (const r of [liveReg, closedReg]) for (const item of items) for (const gold of [10_000_000, 0, enchantCost(reg, item, 'magic')]) {
      const save = richSave();
      save.gold = gold;
      save.inventory = [{ ...structuredClone(item), pos: { x: 0, y: 0 } }];
      for (const a of enchantCards(benchActions(r, save.inventory[0]!, save.gold, save.inventory, {}))) {
        const s = structuredClone(save);
        const ok = r.get('balance').craft.live && enchantAction(reg, s, item.uid, a.rarity!, createRng(1), a.gold).ok;
        expect(a.enabled, `${a.rarity} «${item.name}» (${item.rarity}${item.broken ? ', сломана' : ''}), золото ${gold}, live ${r.get('balance').craft.live}: ${a.lines.map((l) => l.text).join(' · ')}`).toBe(ok);
        checked++;
        if (a.enabled) enabled++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(enabled, 'свойство не пустое').toBeGreaterThan(30);
  });
});

describe('benchTarget — что показывает предпросмотр', () => {
  it('сломанной вещи показывает ПОЧИНКУ, а не улучшение', () => {
    const t = benchTarget(reg, gearItem(true))!;
    expect(t.broken).toBeFalsy();
    expect(t.tier).toBe(gearItem(true).tier); // тир не тронут — чинят, а не улучшают
  });

  it('целой — следующую ступень, и статы там ВЫШЕ', () => {
    const it = gearItem();
    const t = benchTarget(reg, it)!;
    expect(t.tier).not.toBe(it.tier);
    const dmgOf = (x: Item): number => x.baseStats.find((m) => m.stat === 'maxDamage')?.value ?? 0;
    expect(dmgOf(t)).toBeGreaterThan(dmgOf(it));
  });

  it('⭐ кузнечная вещь требует МЕНЬШЕ атрибутов, чем НАЙДЕННАЯ того же тира', () => {
    const it = gearItem();
    const t = benchTarget(reg, it)!;
    const base = reg.get('items.base').find((x) => x.id === it.baseId)!;
    const tier = reg.get('item-tiers').find((x) => x.id === t.tier)!;
    // Тот же тир, тот же расчёт — но БЕЗ скидки: так вещь приходит с дропа.
    const found = retierItem(base, it, tier, { maxReqTotal: reg.get('balance').maxTotalRequirement });
    const sum = (x: Item): number => Object.values(x.requirements).reduce((a, b) => a + b, 0);
    expect(sum(found)).toBeGreaterThan(0);
    expect(sum(t)).toBeLessThan(sum(found));   // ради этого крафт и существует
  });
});

describe('diffStrings — предпросмотр показывает только изменившееся', () => {
  it('одинаковые строки не попадают в дифф', () => {
    expect(diffStrings(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
  it('изменившаяся строка даёт пару «было → станет»', () => {
    expect(diffStrings(['Урон 1–2', 'x'], ['Урон 3–4', 'x'])).toEqual([{ was: 'Урон 1–2', will: 'Урон 3–4' }]);
  });
  it('⚠ ИСЧЕЗНУВШАЯ строка не сдвигает хвост — иначе починка показывала бы «Сломано → Урон»', () => {
    // Ровно случай починки: пропала первая строка, остальные не тронуты.
    expect(diffStrings(['⚠ Сломано', 'Урон 1–2', 'Уровень 5'], ['Урон 1–2', 'Уровень 5']))
      .toEqual([{ was: '⚠ Сломано', will: '' }]);
  });

  it('⭐ реальный дифф улучшения: урон и требования встают своими парами', () => {
    // Совпавшие строки («Тип», «Уровень предмета») — якоря, между ними пары идут по порядку.
    expect(diffStrings(
      ['Тип: рубящее', 'Урон: 9–22', 'Требует: Сила 39', 'Уровень предмета: 12'],
      ['Тип: рубящее', 'Урон: 13–31', 'Требует: Сила 46', 'Уровень предмета: 12'],
    )).toEqual([
      { was: 'Урон: 9–22', will: 'Урон: 13–31' },
      { was: 'Требует: Сила 39', will: 'Требует: Сила 46' },
    ]);
  });

  it('добавленная строка показывается как «было пусто → станет»', () => {
    expect(diffStrings(['x'], ['x', '+2 Броня'])).toEqual([{ was: '', will: '+2 Броня' }]);
  });
});
