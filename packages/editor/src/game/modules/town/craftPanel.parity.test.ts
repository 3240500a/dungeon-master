import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CRAFT_SLOT_LIST, ConfigRegistry, addToInventory, availableMaterials, craftAction, craftTiers, craftWeapon, createRng, defaultParts, emptyStash, fullJournal,
  materialItem, newBotSave, normalizeJournal, type AccountStash, type CraftInput, type Item, type SaveState,
} from '@dm/shared';
import { craftWindow, initialCraftState, normalizeCraftState, type CraftHost, type CraftWindowState } from './craftPanel.js';

/**
 * ⭐ B3: ОКНО КОВКИ ≡ СЕРВЕР — две находки фаззера паритета (`uiParity.fuzz.test.ts`):
 *  • V-B3-03 — «Ковать» горела при полной сумке: окно считало цену (сырьё, золото), а сервер ещё и примерял вещь в сумку ПОСЛЕ
 *    списания (`craftAction`) и отказывал «Нет места в сумке». Теперь примерка одна (`craftFits`), окно зовёт её сумкой хозяина.
 *  • V-B3-06 — хозяин выключил в редакторе все варианты одного гнезда класса (схема это разрешает): `defaultParts` → null, и окно
 *    падало TypeError на каждой перерисовке (вкладка «Ковка» — «Окно ковки не открылось» до конца сессии). Теперь окно говорит
 *    «Кузнец сейчас не куёт…» и гасит «Ковать».
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
  /** Клик как у браузера: погашенная кнопка его не получает. */
  click(): void { if (!this.disabled) for (const f of this.on.get('click') ?? []) f(); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.html, this.textContent, ...this.all().map((c) => `${c.html} ${c.textContent}`)].join(' | '); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const dims = reg.get('balance').inventory;
const inputOf = (st: CraftWindowState): CraftInput => ({ weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 });

/** Хозяин как игровой (`gameCraftHost`): сырьё — сумка и сундук, вещь ложится в сумку героя (`bag`). */
function gameLike(r: ConfigRegistry, save: SaveState, stash: AccountStash): CraftHost & { craft: ReturnType<typeof vi.fn> } {
  return {
    wallet: () => availableMaterials(save.inventory, stash.materials ?? {}),
    gold: () => save.gold,
    journal: () => normalizeJournal(stash.forgeJournal),
    save: () => save,
    bag: () => save.inventory,
    craft: vi.fn(() => ({ ok: false, reason: 'не в этом тесте' })),
    enchant: () => ({ ok: false, reason: 'не в этом тесте' }),
  };
}
const richStash = (r: ConfigRegistry): AccountStash => ({
  ...emptyStash(r), materials: Object.fromEntries(r.get('craft-materials').map((m) => [m.id, 5_000])), forgeJournal: fullJournal(r),
});

describe('⭐ V-B3-03: «Ковать» гаснет, если вещь не ляжет в сумку — тем же правилом, что сервер', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  /** Сумка героя, забитая до последней клетки стеками сырья, которого ковка не касается (сырьё цены — в сундуке). */
  function fullBag(save: SaveState, avoid: readonly string[]): void {
    const def = reg.get('craft-materials').find((m) => !avoid.includes(m.id))!;
    for (let k = 0; k < dims.cols * dims.rows; k++) if (!addToInventory(save.inventory, materialItem(def, dims.materialStack, `junk-${k}`), dims)) break;
  }

  it('полная сумка: кнопка погашена «Нет места в сумке», сервер отказывает тем же; освободили клетки — горит, сервер куёт', () => {
    const save = newBotSave(reg, 'warrior');
    save.gold = 1_000_000;
    const stash = richStash(reg);
    const host = gameLike(reg, save, stash);
    const st = initialCraftState(reg, 'sword', 1);
    normalizeCraftState(reg, st, fullJournal(reg));
    const pv = craftWeapon(reg, inputOf(st), { journal: fullJournal(reg), materialsOn: true });
    expect(pv.ok, pv.reason).toBe(true);
    fullBag(save, Object.keys(pv.cost!.materials));

    const root = craftWindow({ config: reg } as never, host, st) as unknown as El;
    const btn = root.button('Ковать')!;
    expect(btn.disabled, 'было: горела — окно не смотрело на сумку').toBe(true);
    expect(btn.title).toBe('Нет места в сумке');
    btn.click();
    expect(host.craft).not.toHaveBeenCalled();
    // Сервер — тем же ядром и тем же сейвом.
    expect(craftAction(reg, structuredClone(save), structuredClone(stash), 'parity-000000001', inputOf(st), createRng(1)))
      .toEqual({ ok: false, reason: 'Нет места в сумке' });

    // Выложили хлам из сумки — места хватает: кнопка горит, и сервер куёт.
    save.inventory = save.inventory.filter((i) => !i.uid.startsWith('junk-'));
    const again = craftWindow({ config: reg } as never, host, st) as unknown as El;
    expect(again.button('Ковать')!.disabled).toBe(false);
    expect(craftAction(reg, structuredClone(save), structuredClone(stash), 'parity-000000002', inputOf(st), createRng(2)).ok).toBe(true);
  });

  it('хозяин без сумки (песочница редактора: вещь живёт в окне) — место не проверяется', () => {
    const save = newBotSave(reg, 'warrior');
    save.gold = 1_000_000;
    const stash = richStash(reg);
    const { bag: _bag, ...host } = gameLike(reg, save, stash);
    fullBag(save, []);
    const st = initialCraftState(reg, 'sword', 1);
    const root = craftWindow({ config: reg } as never, host, st) as unknown as El;
    expect(root.button('Ковать')!.disabled).toBe(false);
  });
});

describe('⭐ V-B3-06: гнездо класса снято с игры целиком — окно не падает и говорит «кузнец сейчас не куёт»', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  /** Конфиг, где все рукояти меча (одноручного — или обоих семейств) выключены — как из редактора. */
  function gripsOff(hands: readonly number[]): ConfigRegistry {
    const r = new ConfigRegistry();
    r.loadAll();
    const parts = structuredClone(r.get('weapon-parts'));
    for (const p of parts) if (p.slot === 'grip' && (p.classes as string[]).includes('sword') && p.hands.some((h) => hands.includes(h))) p.enabled = false;
    r.reload({ 'weapon-parts': parts });
    return r;
  }
  const sword = (r: ConfigRegistry): Item => {
    const st = initialCraftState(reg, 'sword', 1);
    return craftWeapon(r, inputOf(st), { rng: createRng(4) }).item!;
  };

  it('⭐ класс без рукоятей: состояние без null, окно рисуется, «Ковать» погашена с причиной, заявка не уходит', () => {
    const off = gripsOff([1, 2]);
    const save = newBotSave(off, 'warrior');
    save.gold = 1_000_000;
    const host = gameLike(off, save, richStash(off));
    const st = initialCraftState(off, 'sword');
    expect(st.parts, 'было: `defaultParts(…)!` — null').not.toBeNull();
    for (const s of CRAFT_SLOT_LIST) expect(st.parts[s], s).toBeDefined();
    let root!: El;
    expect(() => { root = craftWindow({ config: off } as never, host, st) as unknown as El; }, 'было: TypeError в normalizeCraftState').not.toThrow();
    const btn = root.button('Ковать')!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Кузнец сейчас не куёт этот класс');
    expect(root.text()).toContain('Кузнец сейчас не куёт этот класс');
    btn.click();
    expect(host.craft).not.toHaveBeenCalled();
    // Перерисовка (кадр сейва) и нормализация состояния без деталей — тоже без броска.
    expect(() => craftWindow({ config: off } as never, host, st)).not.toThrow();
    const bare = { ...initialCraftState(reg, 'sword'), parts: null } as unknown as CraftWindowState;
    expect(() => normalizeCraftState(off, bare, fullJournal(off))).not.toThrow();
    expect(bare.parts).not.toBeNull();
  });

  it('вид зачарования скованного меча — рисуется и в таком конфиге (кнопки зачарования на месте)', () => {
    const off = gripsOff([1, 2]);
    const save = newBotSave(off, 'warrior');
    const item = sword(reg);
    save.inventory.push(item);
    const host = { ...gameLike(off, save, richStash(off)), find: (uid: string) => (uid === item.uid ? { item, inBag: true } : null) };
    const st = initialCraftState(off, 'sword', 1);
    st.crafted = item;
    let root!: El;
    expect(() => { root = craftWindow({ config: off } as never, host, st) as unknown as El; }).not.toThrow();
    expect(root.button('✦ Магический'), 'кнопка зачарования').toBeDefined();
  });

  it('одно семейство без рукоятей: окно открывается на другом, у погашенного — «не куёт это семейство»', () => {
    const off = gripsOff([1]);
    const host = gameLike(off, newBotSave(off, 'warrior'), richStash(off));
    const st = initialCraftState(off, 'sword');
    expect(st.hands, 'без семейства — первое, которое кузнец куёт').toBe(2);
    const root = craftWindow({ config: off } as never, host, st) as unknown as El;
    expect(root.button('Ковать')!.title).not.toContain('не куёт');
    const one = initialCraftState(off, 'sword', 1);
    const r1 = craftWindow({ config: off } as never, host, one) as unknown as El;
    expect(r1.button('Ковать')!.disabled).toBe(true);
    expect(r1.button('Ковать')!.title).toBe('Кузнец сейчас не куёт это семейство');
  });
});

/**
 * ⚠ R17-03: ЗАЧАРОВАНИЕ ФОРМЫ БЕЗ ЦЕНЫ — окно гасит «✦ Редкий» тем же правилом, что сервер (`canEnchantItem` → «Форма без цены»).
 * Законный путь к такой вещи: хозяин опустил ёмкость до 4 и убрал строки 3+2/2+3 (схема пускает), а меч 3+2 уже скован. Раньше
 * зачарование шло по ×1 (дешевле вшестеро); без цены у формы окно показывало бы «NaN з.» на живой кнопке.
 */
describe('⚠ R17-03: зачарование формы без цены — окно гасит, как сервер', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('меч 3+2 при ёмкости до 4: «✦ Редкий» погашен «Форма без цены», «✦ Магический» (катает 1+1) — с ценой', () => {
    const input: CraftInput = { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 5)! };
    const item = craftWeapon(reg, input, { rng: createRng(5) }).item;
    expect(item?.affixCap, 'предусловие: скован меч 3+2').toEqual({ prefix: 3, suffix: 2 });
    const low = new ConfigRegistry();
    low.loadAll();
    const bal = structuredClone(low.get('balance'));
    bal.craft.capacityByTier = bal.craft.capacityByTier.map((n) => Math.min(n, 4));
    delete bal.craft.formMult['3+2'];
    delete bal.craft.formMult['2+3'];
    low.reload({ balance: bal });
    const save = newBotSave(low, 'warrior');
    save.gold = 9_999_999;
    save.inventory.push(item!);
    const host = { ...gameLike(low, save, richStash(low)), find: (uid: string) => (uid === item!.uid ? { item: item!, inBag: true } : null) };
    const st = initialCraftState(low, 'sword', 1);
    st.crafted = item!;
    const root = craftWindow({ config: low } as never, host, st) as unknown as El;
    const rare = root.button('✦ Редкий')!;
    expect(rare.disabled, `«${rare.textContent}» — было: зачарование по ×1`).toBe(true);
    expect(rare.title).toMatch(/без цены/);
    expect(rare.textContent).not.toContain('NaN');
    const magic = root.button('✦ Магический')!;
    expect(magic.disabled).toBe(false);
    expect(magic.textContent).toMatch(/· \d+ з\./);
  });
});

/**
 * ⭐ 06.10: «разобрал топор у кузнеца — детали не открылись». После первого разбора вещи ступени t0 окно вставало на эталонную «ст. 2»
 * с красным «Кузнец ещё не работал со ступенью Крепкий» и погашенной «Ковать» — при открытых деталях. ⭐ D3 (решение владельца 06.10):
 * ворот ступени у ковки нет вовсе — окно с любым журналом (прежний потолок t0, «мифики» 0) куёт открытые детали на любой ступени,
 * а держит его только сырьё.
 */
describe('⭐ D3: у ковки нет ворот ступени — окно не встаёт красным ни при каком журнале', () => {
  const t0 = { ...fullJournal(reg), tierHi: 0, mythic: 0 };
  const reasonOf = (st: CraftWindowState, j: typeof t0): string => {
    normalizeCraftState(reg, st, j);
    return craftWeapon(reg, inputOf(st), { journal: j, materialsOn: true }).reason ?? '';
  };
  it('первый разбор t0 (прежний потолок t0, мификов 0): окно топора ст. 2 куётся — отказа «не работал со ступенью» нет', () => {
    const st = initialCraftState(reg, 'axe', 1);
    expect(CRAFT_SLOT_LIST.map((s) => st.parts[s].step).every((k) => k === 2)).toBe(true);
    expect(reasonOf(st, t0)).toBe('');
  });
  it('мифическая ступень из открытых деталей — без счётчика разобранных мификов', () => {
    const last = craftTiers(reg).length - 1;
    let mythic = 0;
    for (const a of reg.get('weapon-anatomy')) {
      for (const hands of [1, 2]) {
        const parts = defaultParts(reg, a.id, hands, 5);
        if (!parts) continue;
        const pv = craftWeapon(reg, { weaponClass: a.id, hands, parts }, { journal: t0, materialsOn: true });
        expect(pv.reason ?? '', `${a.id}/${hands}: отказа ворот нет`).not.toMatch(/мифическ|не работал со ступенью/i);
        if (pv.ok && pv.tier === last) mythic++;
      }
    }
    expect(mythic, 'мифик куётся из открытых деталей при журнале «потолок t0, мификов 0»').toBeGreaterThan(0);
  });
});
