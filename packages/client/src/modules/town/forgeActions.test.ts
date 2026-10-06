import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, STARTER_KNOWN, buildCraftShell, canRerollItem, canSalvageItem, emptyJournal, salvageIntoJournal, salvagePreview, salvageRange, canUpgradeItem, craftAction, createRng, defaultParts, emptyStash, enchantAction, enchantCost, forgeGold, forgeRepair,
  forgeReroll, forgeSalvage, forgeUpgrade, fullJournal, generateItem, itemFromBaseId, newBotSave, retierItem, salvageMean, shapeFoundWeapon, tierMatters,
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
/**
 * Кошелёк «всего вдоволь»: §7 — подъём и починка платят сырьём семей ДЕТАЛЕЙ вещи (у меча — железо, кожа, прибор) по сорту ступени,
 * §6.2 — перекатка и зачарование ещё и эссенцией. Поэтому — каждый материал конфига, а не железо, дерево, ткань, кожа и пластины I–III.
 */
const RICH: Record<string, number> = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999]));

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
  it('⭐ нехватка видна СТРОКОЙ с «есть N — не хватает», а не одной серой кнопкой', () => {
    const a = benchActions(reg, gearItem(), 99999, [], {}); // сырья нет вовсе
    const up = a[0]!;
    expect(up.enabled).toBe(false);
    const miss = up.lines.filter((l) => l.state === 'miss');
    expect(miss.length).toBeGreaterThan(0);
    expect(miss.some((l) => l.text.includes('есть 0'))).toBe(true);
    expect(miss.filter((l) => !l.text.endsWith('золота')).every((l) => l.text.endsWith(' — не хватает'))).toBe(true);
  });

  it('⭐ §15.4: «есть N» — у КАЖДОЙ строки сырья, и когда хватает («Кордован 3 (есть 999)»): цена и запас рядом', () => {
    for (const a of benchActions(reg, { ...gearItem(), rarity: 'magic' as const }, 99999, [], RICH)) {
      for (const l of a.lines.filter((x) => x.state === 'ok' && !x.text.endsWith('золота'))) expect(l.text, a.id).toMatch(/^.+ \d+ \(есть 999\)$/);
    }
  });

  it('нехватка ЗОЛОТА помечает свою строку, а строки сырья остаются зелёными', () => {
    const up = benchActions(reg, gearItem(), 0, [], RICH)[0]!;
    expect(up.enabled).toBe(false);
    const gold = up.lines.find((l) => l.text.includes('золота'))!;
    expect(gold.state).toBe('miss');
    expect(up.lines.filter((l) => l !== gold).every((l) => l.state === 'ok')).toBe(true);
  });

  it('⭐ §15.2: разбор — ЧЕТЫРЕ строки всегда (сырьё вилкой, эссенция, каталог, эскиз) — те же, что карточка `salvagePreview`', () => {
    // Находка той же базы: у стартового сырья нет (R3-04) — см. ниже.
    const it0 = { ...gearItem(), origin: 'drop' as const };
    const sv = benchActions(reg, it0, 99999, [], RICH).find((x) => x.id === 'salvage')!;
    expect(sv.enabled).toBe(true);
    expect(sv.title).toBe('♻ Разобрать');
    expect(sv.lines.map((l) => l.label)).toEqual(['Сырьё', 'Эссенция', 'Каталог', 'Эскиз']);
    const card = salvagePreview(reg, it0, null, false);
    expect(sv.lines.map((l) => [l.text, l.state])).toEqual([card.materials, card.essence, card.catalog!, card.sketch!].map((l) => [l.text, l.tone]));
    // Выход — вилкой по `salvageRange`: он случаен, одно число было бы враньём.
    for (const [id, r] of Object.entries(salvageRange(reg, it0, false).range)) {
      const name = reg.get('craft-materials').find((m) => m.id === id)!.name;
      expect(sv.lines[0]!.text).toContain(`+ ${name} ${r.min === r.max ? r.min : `${r.min}–${r.max}`}`);
    }
    // У обычной вещи эссенции нет — сказано почему; каталог пуст — «+ тип…»; эскиз копится.
    expect(sv.lines[1]).toMatchObject({ text: 'нет — у обычной вещи чар нет', state: 'dim' });
    expect(sv.lines[2]!.state).toBe('gain');
  });

  it('⭐ купленная: сырьё «не выше III сорта», «Эссенция: нет — вещь куплена» (оговорка), эскиз копят только находки', () => {
    const shop = { ...gearItem(), origin: 'shop' as const, rarity: 'rare' as const };
    const sv = benchActions(reg, shop, 99999, [], RICH).find((x) => x.id === 'salvage')!;
    expect(sv.lines[0]!.text).toContain('вещь куплена — не выше III сорта');
    expect(sv.lines[1]).toMatchObject({ label: 'Эссенция', text: 'нет — вещь куплена', state: 'warn' });
    expect(sv.lines.find((l) => l.label === 'Эскиз')?.text).toBe('копят только находки');
  });

  it('⭐ скованную ПЕРЕПЛАВЛЯЮТ: заголовок «♻ Переплавить», эссенция не вернётся, детали уже в каталоге', () => {
    const save = newBotSave(reg, reg.get('classes')[0]!.id);
    save.gold = 9_999_999; save.inventory = [];
    const stash = { ...emptyStash(reg), materials: { ...RICH }, forgeJournal: fullJournal(reg) };
    const r = craftAction(reg, save, stash, 'bench-melt', { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)! }, createRng(3), { fullJournal: true });
    if (!r.ok) throw new Error(r.reason);
    const forged = save.inventory.find((i) => i.uid === r.uid)!;
    const sv = benchActions(reg, forged, 99999, save.inventory, RICH, stash.forgeJournal).find((x) => x.id === 'salvage')!;
    expect(sv.title).toBe('♻ Переплавить');
    expect(sv.lines.map((l) => l.label)).toEqual(['Сырьё', 'Эссенция', 'Каталог']);
    expect(sv.lines[1]!.text).toBe('нет — переплавка эссенцию не возвращает');
    expect(sv.lines[2]!.text).toMatch(/^все детали уже в каталоге \(меч: \d+ из \d+\)$/);
  });

  it('⭐ §9.3: стартовый набор, из которого всё уже в каталоге, — карточка гаснет ДО нажатия с причиной сервера и строкой каталога', () => {
    const kit = gearItem();
    const known = salvageIntoJournal(reg, emptyJournal(), kit).journal;
    const sv = benchActions(reg, kit, 99999, [], RICH, known).find((x) => x.id === 'salvage')!;
    expect(sv.enabled).toBe(false);
    expect(sv.lines[0]).toEqual({ text: STARTER_KNOWN, state: 'dim' });
    expect(sv.lines[1]?.label).toBe('Каталог');
    expect(sv.lines[1]?.text).toMatch(/^всё из этой вещи уже в каталоге/);
    // Первый разбор у нового аккаунта — горит: в каталог ляжет тип и детали, сырья нет.
    const first = benchActions(reg, kit, 99999, [], RICH, emptyJournal()).find((x) => x.id === 'salvage')!;
    expect(first.enabled).toBe(true);
    expect(first.lines[0]!.text).toBe('сырья нет — стартовый набор бесплатный');
    expect(first.minYield).toEqual({});
  });

  it('⭐ R9-04: пояс и перчатки — вилка «0–2», а не пустая карточка; в команду — низ вилки и средний выход', () => {
    for (const baseId of ['leather-belt', 'leather-gloves']) {
      const it0 = { ...itemFromBaseId(reg.get('items.base'), baseId, reg.get('item-tiers'), 'drop')!, uid: `sv-${baseId}` };
      const sv = benchActions(reg, it0, 99999, [], RICH).find((x) => x.id === 'salvage')!;
      expect(sv.enabled, baseId).toBe(true);
      // Кожа 0–2 (побочные Плечи кожаной брони сняты 06.10 вместе с семьёй).
      const name = (id: string): string => reg.get('craft-materials').find((m) => m.id === id)!.name;
      expect(sv.lines[0]!.text, `${baseId}: было — ни строки выхода`).toBe(`+ ${name('hide-1')} 0–2`);
      expect(sv.minYield).toEqual({ 'hide-1': 0 });
      expect(sv.avgYield, 'R9-04: у дробного выхода низ правку не видит — среднее видит').toEqual(salvageMean(reg, it0, false));
      expect(sv.avgYield!['hide-1']).toBeCloseTo(1, 9);
    }
  });

  it('R3-04 + D1: стартовое кузнец разбирает только в каталог — карточка тем же правилом, что сервер (`canSalvageItem`); сырья в ней нет', () => {
    const it0 = gearItem();
    expect(it0.origin).toBe('start');
    const sv = benchActions(reg, it0, 99999, [], RICH).find((x) => x.id === 'salvage');
    expect(sv?.enabled ?? false).toBe(canSalvageItem(reg, it0, false).ok);
    expect(salvageRange(reg, it0, false).range, 'сырья стартовое не даёт').toEqual({});
    // Всё из вещи уже в каталоге — отказ с причиной ДО нажатия (журнал кузнеца — с кадра сундука).
    expect(canSalvageItem(reg, it0, false, salvageIntoJournal(reg, emptyJournal(), it0).journal).ok).toBe(false);
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
      // R8-14: и со сырьём карточки (`materials`) и низом вилки разбора (`minYield`) — как их шлёт верстак. R9-04: и средним выходом.
      case 'forgeUpgrade': return forgeUpgrade(reg, s, uid, w, a.gold, a.materials).ok;
      case 'forgeRepair': return forgeRepair(reg, s, uid, w, a.gold, a.materials).ok;
      // §6.2: перекатка и зачарование — с эссенцией карточки (`materials` → `maxMaterials`) из того же кошелька сундука.
      case 'forgeReroll': return forgeReroll(reg, s, uid, createRng(1), a.gold, w, a.materials).ok;
      case 'forgeSalvage': return forgeSalvage(reg, s, st, uid, createRng(1), a.minYield, a.avgYield).ok;
      // R3-09: сервер отказывает зачарованию и при закрытой ковке (`balance.craft.live`) — до ядра.
      case 'forgeEnchant': return reg.get('balance').craft.live && enchantAction(reg, s, uid, a.rarity!, createRng(1), a.gold, w, a.materials).ok;
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
        const e = enchantAction(reg, forge, it.uid, rar, createRng(nonce + items.length), undefined, forgeStash.materials);
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
    expect(enchantAction(reg, save, item.uid, 'magic', createRng(3), undefined, fullWallet()).ok).toBe(true);
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
      if (enchantAction(reg, s, it.uid, 'rare', createRng(items.length), undefined, fullWallet()).ok) items.push(s.inventory[0]!);
    }
    expect(items.filter((i) => i.rarity === 'normal' && !i.broken).length).toBeGreaterThan(20);
    let checked = 0, enabled = 0;
    // §6.2: и кошелёк — с эссенцией и без неё (тогда карточка гаснет «не хватает», как отказ сервера).
    for (const r of [liveReg, closedReg]) for (const item of items) for (const gold of [10_000_000, 0, enchantCost(reg, item, 'magic')]) for (const wal of [fullWallet(), {}]) {
      const save = richSave();
      save.gold = gold;
      save.inventory = [{ ...structuredClone(item), pos: { x: 0, y: 0 } }];
      for (const a of enchantCards(benchActions(r, save.inventory[0]!, save.gold, save.inventory, wal))) {
        const s = structuredClone(save);
        const ok = r.get('balance').craft.live && enchantAction(reg, s, item.uid, a.rarity!, createRng(1), a.gold, structuredClone(wal), a.materials).ok;
        expect(a.enabled, `${a.rarity} «${item.name}» (${item.rarity}${item.broken ? ', сломана' : ''}), золото ${gold}, live ${r.get('balance').craft.live}: ${a.lines.map((l) => l.text).join(' · ')}`).toBe(ok);
        checked++;
        if (a.enabled) enabled++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(enabled, 'свойство не пустое').toBeGreaterThan(30);
  });
});

/**
 * ⚠ R7-19: СЛОМАННЫЙ УНИК КУЗНЕЦ НЕ ЧИНИТ (уник кузницу не проходит вовсе) — карточка «Починить» гаснет ТЕМ ЖЕ правилом, что
 * отказ сервера (`canRepairItem`), и говорит почему. Прежде горела с ценой в одно золото, и сервер её исполнял.
 */
describe('⚠ R7-19: сломанный уник — карточка «Починить» погашена, как отказ сервера', () => {
  it('⭐ карточка погашена с причиной, предпросмотра починки нет; сервер на том же сейве отказывает', () => {
    const it = { ...generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 30, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'unique',
      maxReqTotal: reg.get('balance').maxTotalRequirement, origin: 'drop',
    }, createRng(5)), broken: true, pos: { x: 0, y: 0 } } as Item;
    const a = benchActions(reg, it, 10_000_000, [], RICH);
    const rep = a.find((x) => x.id === 'repair')!;
    expect(rep.primary, 'на своём месте').toBe(true);
    expect(rep.enabled, 'было: горела за одно золото').toBe(false);
    expect(rep.gold).toBeUndefined();
    expect(rep.lines.map((l) => l.text)).toEqual(['Уникальную вещь кузнец не чинит']);
    expect(benchTarget(reg, it), 'шапка и карточка говорят одно').toBeUndefined();
    const save = { gold: 10_000_000, inventory: [it] } as unknown as SaveState;
    expect(forgeRepair(reg, save, it.uid, { ...RICH }).ok).toBe(false);
  });
});

/**
 * ⭐ R14-12: ПОДПИСЬ КАРТОЧКИ И ШАПКА — ТЕМ ЖЕ ОТВЕТОМ, ЧТО ОТКАЗ. С R12-03 кузнец кольцо и амулет не поднимает («Ступень этой вещи
 * ничего не меняет», `tierMatters`), а подпись «Улучшить» шла от `nextTierOf` (о `tierMatters` он не знает) — «до «Отличный»» над
 * погашенной карточкой, и шапка верстака (`benchTarget` → `upgradedItem`) писала «после улучшения» над «Кузнец эту вещь не меняет».
 */
describe('⭐ R14-12: «Улучшить» не обещает ступени, которую кузнец не поднимет', () => {
  const ladder = [...reg.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
  const at = (id: string | undefined, dflt: number): number => { const i = ladder.findIndex((t) => t.id === id); return i < 0 ? dflt : i; };
  const inGame = reg.get('items.base').filter((b) => b.kind !== 'consumable' && b.enabled !== false);
  /** Найденная вещь базы на ступени `t` (как в `tierNoop.test.ts`). */
  const onTier = (base: (typeof inGame)[number], t: number, rarity: 'normal' | 'magic'): Item => ({
    ...buildCraftShell(base, ladder[t]!, reg.get('balance').maxTotalRequirement), rarity, origin: 'drop', uid: `r14-${base.id}-${t}`, pos: { x: 0, y: 0 },
  });

  it('⭐ каждая база в игре, которую ступень не меняет, на каждой ступени: карточка погашена без «до «…»», предпросмотра нет', () => {
    let n = 0;
    for (const base of inGame.filter((b) => !tierMatters(b))) {
      for (let t = at(base.minTier, 0); t <= at(base.maxTier, ladder.length - 1); t++) {
        const item = onTier(base, t, 'magic');
        const up = benchActions(reg, item, 10_000_000, [], RICH)[0]!;
        const why = `${base.id} ${ladder[t]!.id}`;
        expect(up.id, why).toBe('upgrade');
        expect(up.enabled, why).toBe(false);
        expect(up.sub, `${why}: было «до «Отличный»» над погашенной карточкой`).not.toContain('до «');
        expect(up.lines.map((l) => l.text), why).toEqual(['Ступень этой вещи ничего не меняет']);
        expect(benchTarget(reg, item), `${why}: было — шапка «после улучшения»`).toBeUndefined();
        n++;
      }
    }
    expect(n, 'кольца и амулеты есть в игре').toBeGreaterThanOrEqual(2 * 6);
  });

  it('свойство по всем базам в игре: «до «…»» и предпросмотр улучшения — ровно когда кузнец поднимает (`canUpgradeItem`)', () => {
    let yes = 0, no = 0;
    for (const base of inGame) {
      for (let t = at(base.minTier, 0); t <= at(base.maxTier, ladder.length - 1); t++) {
        const item = onTier(base, t, 'normal');
        const can = canUpgradeItem(reg, item).ok;
        const up = benchActions(reg, item, 10_000_000, [], RICH)[0]!;
        const why = `${base.id} ${ladder[t]!.id}: ${up.sub} · ${up.lines.map((l) => l.text).join(' · ')}`;
        expect(up.sub.startsWith('до «'), why).toBe(can);
        expect(benchTarget(reg, item) !== undefined, why).toBe(can);
        if (can) yes++; else no++;
      }
    }
    expect(yes, 'настоящие подъёмы — по-прежнему с подписью и предпросмотром').toBeGreaterThan(100);
    expect(no).toBeGreaterThan(0);
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
