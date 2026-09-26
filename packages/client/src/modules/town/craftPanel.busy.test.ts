import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConfigRegistry, CRAFT_SLOT_LIST, anatomyOf, craftWeapon, createRng, enchantCost, fullJournal, keySlotOf, newBotSave, partById, stepLabel, variantsFor,
  type CraftInput, type Item,
} from '@dm/shared';
import { craftWindow, initialCraftState, type CraftHost, type CraftReply } from './craftPanel.js';

/**
 * ⭐ R3-22: ПОКА КОВКА В ПОЛЁТЕ, ВЫБОР СБОРКИ ЗАМОРОЖЕН. «Ковать» гасла и писала «куём…», а выбор класса, «Вся вещь из»,
 * строки деталей, чипы материала и доводки оставались живыми и сбрасывали окно: ответ сервера потом клал скованную
 * вещь рядом с ДРУГОЙ сборкой — имя «Получилось», ступень, цена и чипы описывали не то, что лежит в сумке.
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется окно.
 */
class El {
  children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; title = ''; colSpan = 1;
  parent: El | null = null; isConnected = true;
  private html = '';
  private on = new Map<string, (() => void)[]>();
  constructor(public tag: string) { }
  set innerHTML(v: string) { this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  get lastChild(): El | null { return this.children[this.children.length - 1] ?? null; }
  addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  append(...c: (El | string)[]): void { for (const x of c) { if (typeof x === 'string') continue; x.parent = this; this.children.push(x); } }
  appendChild(c: El): El { this.append(c); return c; }
  click(): void { for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
  row(name: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.innerHTML.includes(`${name}</span>`)); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const rich = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 999]));

describe('⭐ R3-22: выбор сборки, пока ковка в полёте', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('⭐ классы, «Вся вещь из», детали, материал и доводка погашены и ничего не меняют; ответ ложится рядом со СВОЕЙ сборкой', async () => {
    const save = newBotSave(reg, 'warrior');
    const sent: CraftInput[] = [];
    let answer!: (r: CraftReply) => void;
    const host: CraftHost = {
      wallet: rich, gold: () => 9_999_999, journal: () => fullJournal(reg), save: () => save,
      craft: (input) => { sent.push(structuredClone(input)); return new Promise<CraftReply>((res) => { answer = res; }); },
      enchant: () => ({ ok: false, reason: 'не в этом тесте' }),
    };
    const st = initialCraftState(reg, 'sword', 1);
    const root = craftWindow({ config: reg } as never, host, st) as unknown as El;
    root.button('Ковать')!.click();
    expect(st.busy, 'заявка в полёте').toBe('craft');
    const build = structuredClone({ weaponClass: st.weaponClass, hands: st.hands, parts: st.parts, finish: st.finish });

    // Всё, что раньше сбрасывало окно посреди ковки.
    const keySlot = keySlotOf(reg, 'sword');
    const other = CRAFT_SLOT_LIST.find((s) => s !== keySlot)!;
    const otherPart = variantsFor(reg, 'sword', other, 1).find((p) => p.id !== st.parts[other].id)!;
    const sel = partById(reg, st.parts[other].id)!;
    const otherStep = [1, 2, 3, 4, 5].find((k) => k !== st.parts[other].step && k >= sel.stepMin && k <= sel.stepMax)!;
    const matLabel = stepLabel(reg, anatomyOf(reg, 'sword')!, other, sel, otherStep);
    const exact = (t: string): El | undefined => root.all().find((e) => e.tag === 'button' && e.textContent === t);
    const pickers = [
      root.button('Топор'), root.button('ст. 4'), root.row(otherPart.name), exact(matLabel),
      exact(reg.get('balance').craft.finish[1]!.name),
    ];
    expect(pickers.every(Boolean), 'все выборы нарисованы').toBe(true);
    for (const b of pickers) {
      expect(b!.disabled, `«${b!.textContent || b!.innerHTML.slice(0, 40)}» погашен, пока куём`).toBe(true);
      b!.click();
    }
    expect({ weaponClass: st.weaponClass, hands: st.hands, parts: st.parts, finish: st.finish }, 'было: клик сбрасывал сборку посреди ковки').toEqual(build);
    expect(st.message).toBe('');

    const item: Item = craftWeapon(reg, sent[0]!, { journal: fullJournal(reg), rng: createRng(5) }).item!;
    answer({ ok: true, item });
    await new Promise((r) => setTimeout(r, 0));
    expect(st.busy).toBeUndefined();
    expect(st.crafted?.uid).toBe(item.uid);
    expect({ weaponClass: st.weaponClass, hands: st.hands, parts: st.parts, finish: st.finish }, 'скованная — рядом со своей сборкой').toEqual(build);
    expect(root.button('Топор')!.disabled, 'ответ пришёл — выбор снова живой').toBe(false);
  });
});

describe('⭐ R5-15: ковка и зачарование уходят с ценой, которую показало окно', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('«Ковать» — со строкой «Золото — N» окна; «✦ Редкий» — с ценой на кнопке', async () => {
    const save = newBotSave(reg, 'warrior');
    const prices: (number | undefined)[] = [];
    let crafted!: Item;
    const host: CraftHost = {
      wallet: rich, gold: () => 9_999_999, journal: () => fullJournal(reg), save: () => save,
      craft: (input, maxGold) => {
        prices.push(maxGold);
        crafted = craftWeapon(reg, input, { journal: fullJournal(reg), rng: createRng(5) }).item!;
        return { ok: true, item: crafted };
      },
      enchant: (_item, _rarity, maxGold) => { prices.push(maxGold); return { ok: false, reason: 'хватит' }; },
      find: (uid) => (uid === crafted?.uid ? { item: crafted, inBag: true } : null),
    };
    const st = initialCraftState(reg, 'sword', 1);
    const root = craftWindow({ config: reg } as never, host, st) as unknown as El;
    const shown = craftWeapon(reg, { weaponClass: st.weaponClass, hands: st.hands, parts: st.parts, finish: st.finish }, { journal: fullJournal(reg) }).cost!.gold;
    expect(root.all().some((e) => e.textContent.startsWith(`Золото — ${shown}`)), 'окно показывает эту цену').toBe(true);
    root.button('Ковать')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(prices, 'было: ковка уходила без цены — сервер брал по своему конфигу').toEqual([shown]);
    const rare = root.button('Редкий')!;
    const label = Number(/· (\d+) з\./.exec(rare.textContent)?.[1]);
    rare.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(prices).toEqual([shown, enchantCost(reg, crafted, 'rare')]);
    expect(prices[1]).toBe(label);
  });
});
