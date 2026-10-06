import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CRAFT_SLOT_LIST, ConfigRegistry, baseTierRange, craftTiers, craftWeapon, createRng, defaultParts, emptyJournal, fullJournal,
  generateItem, newBotSave, partsOf, salvageIntoJournal, salvageMean, salvageRange, shapeFoundWeapon, sketchable, tierIndexOfItem, typeOfItem,
  type CraftJournal, type Item,
} from '@dm/shared';
import { askInGame, dismissAsk } from '../../ui/kit.js';
import { confirmAll, confirmAllAsync, disposePrompts, fieldSalvageLines, journalGainsOf, salvageInField } from './disposeConfirm.js';

/**
 * ⭐ ВОПРОСЫ ПЕРЕД ТЕМ, КАК ВЕЩЬ ИСЧЕЗНЕТ (§12.2, §17; предложение «Разбор, сырьё и чары» §9):
 * - полевой разбор и продажа вещи, которую кузнец записал бы в каталог (тип, деталь, кодекс, снаряжение, эскиз) — любого
 *   происхождения (решение D1), — предупреждают: каталог пишет только кузнец (D2), и игрок сжигает носитель детали молча;
 * - разбор и продажа скованного спрашивают дважды.
 * Потолка ступени и мификов в вопросах нет: ковку держит только сырьё (решение D3).
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const PHRASE = 'Разбор в поле журнал кузнеца не пополняет';
const SELL_PHRASE = 'Продажа журнал кузнеца не пополняет';
const TIERS = craftTiers(reg);
const LAST = TIERS.length - 1;

/** Стартовое оружие — со своей базой и записанными деталями. */
const starter = (): Item => newBotSave(reg, reg.get('classes')[0]!.id).equipment.weapon!;
/** Найденное оружие: то же, но с пола — детали журналу открывает только находка (`countsAsFind`). */
const found = (): Item => ({ ...starter(), origin: 'drop' });
/** R8-14: низ вилки выхода разбора в поле — его несёт команда. R9-04: и средний выход (у дробной доли низ — всегда 0). */
const fieldLow = (it: Item): Record<string, number> =>
  Object.fromEntries(Object.entries(salvageRange(reg, it, true).range).map(([id, r]) => [id, r.min]));
const fieldAvg = (it: Item): Record<string, number> => salvageMean(reg, it, true)!;
const crafted = (): Item => {
  const pv = craftWeapon(reg, { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)! }, { rng: createRng(3) });
  if (!pv.item) throw new Error(pv.reason);
  return pv.item;
};
/** Найденный МИФИК (последняя ступень) с пола — как его катает дроп. */
function mythicDrop(): Item {
  const base = reg.get('items.base').find((b) => b.kind === 'weapon' && b.enabled !== false && baseTierRange(reg, b).hi === LAST)!;
  const bal = reg.get('balance');
  for (let s = 1; s < 400; s++) {
    const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 99, tierLevel: 99, baseId: base.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
      forceRarity: 'normal', maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
    }, createRng(s)));
    if (tierIndexOfItem(reg, it) === LAST && partsOf(reg, it)) return it;
  }
  throw new Error('мифик не выкатился');
}
const typesOf = (item: Item): string[] => { const t = typeOfItem(reg, item)?.typeId; return t ? [t] : []; };
/** Журнал, где открыто ровно то, из чего сделана вещь (минус что попросят): база, детали, кодекс, ступень. */
function journalOf(item: Item, drop: { base?: boolean; variant?: boolean } = {}): CraftJournal {
  const parts = partsOf(reg, item)!;
  const variants = CRAFT_SLOT_LIST.map((s) => parts[s].id);
  return {
    ...emptyJournal(), bases: drop.base ? [] : [item.baseId], variants: drop.variant ? variants.slice(1) : variants,
    tierHi: tierIndexOfItem(reg, item), typesSeen: typesOf(item),
  };
}
/** Журнал «всё открыто», которому и эта вещь ничего не даст: `fullJournal` плюс её тип в кодексе. */
const knownAll = (item: Item): CraftJournal => ({ ...fullJournal(reg), typesSeen: typesOf(item) });

describe('journalGainsOf — что засчитал бы журналу разбор у кузнеца', () => {
  it('пустой журнал: неизвестны тип и все детали вещи', () => {
    const it0 = found();
    const u = journalGainsOf(reg, it0, emptyJournal());
    expect(u.some((s) => s.startsWith('тип'))).toBe(true);
    expect(u.filter((s) => s.startsWith('деталь')).length).toBeGreaterThan(0);
  });

  it('всё открыто — неизвестного нет; не хватает одной детали или только типа — есть', () => {
    const it0 = found();
    expect(journalGainsOf(reg, it0, journalOf(it0))).toEqual([]);
    expect(journalGainsOf(reg, it0, journalOf(it0, { variant: true }))).toHaveLength(1);
    expect(journalGainsOf(reg, it0, journalOf(it0, { base: true }))).toEqual([expect.stringMatching(/^тип/)]);
  });

  it('скованное из открытого и уникальное — не предупреждают; броня — её база в каталог снаряжения', () => {
    const c = crafted();
    expect(journalGainsOf(reg, c, salvageIntoJournal(reg, emptyJournal(), c).journal)).toEqual([]);
    expect(journalGainsOf(reg, { ...found(), rarity: 'unique' }, emptyJournal())).toEqual([]);
    const armor = reg.get('items.base').find((b) => b.kind === 'armor' && b.enabled !== false)!;
    const chest = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 10, baseId: armor.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal', origin: 'drop',
    }, createRng(5));
    expect(journalGainsOf(reg, chest, emptyJournal())).toEqual([`снаряжение «${armor.name}»`]);
    expect(journalGainsOf(reg, chest, { ...emptyJournal(), gearSeen: [armor.id] })).toEqual([]);
  });

  it('⭐ купленное и без происхождения — каталог как у находки (D1): тип, детали, кодекс; без детали — только она', () => {
    for (const origin of ['shop', undefined] as const) {
      const it0 = { ...starter(), origin };
      const g = journalGainsOf(reg, it0, emptyJournal());
      expect(g[0], String(origin)).toMatch(/^тип/);
      expect(g.filter((x) => x.startsWith('деталь')).length, String(origin)).toBeGreaterThan(0);
      expect(journalGainsOf(reg, it0, journalOf(it0, { variant: true })), String(origin)).toHaveLength(1);
    }
  });

  it('стартовое кузнец разбирает в каталог (D1) — в поле и в лавке это потеря, вопрос есть', () => {
    expect(starter().origin).toBe('start');
    expect(journalGainsOf(reg, starter(), emptyJournal()).some((x) => x.startsWith('деталь'))).toBe(true);
    expect(journalGainsOf(reg, starter(), journalOf(starter()))).toEqual([]);
  });

  it('журнала нет (кадр сундука не пришёл) — считаем пустым: лишний вопрос дешевле ловушки', () => {
    const it0 = found();
    expect(journalGainsOf(reg, it0, null).length).toBeGreaterThan(0);
    expect(journalGainsOf(reg, it0, undefined)).toEqual(journalGainsOf(reg, it0, emptyJournal()));
  });

  /**
   * ⭐ R2-07 (пересмотрено D3, 06.10): мифик с известными деталями — без вопроса: ворот t6 и потолка ковки больше нет, ковку держит только
   * сырьё. В вопросе — лишь то, что разбор у кузнеца добавил бы в каталог.
   */
  it('⭐ R2-07 + D3: мифик с известными деталями — молчит (ни ступени, ни ворот); купленный — тоже', () => {
    const m = mythicDrop();
    expect(journalGainsOf(reg, m, { ...knownAll(m), tierHi: 0, mythic: 0 })).toEqual([]);
    expect(journalGainsOf(reg, m, knownAll(m))).toEqual([]);
    expect(journalGainsOf(reg, { ...m, origin: 'shop' }, { ...knownAll(m), mythic: 0 })).toEqual([]);
  });

  it('⭐ R2-07: новый тип кодекса — тоже потеря; новая ступень — нет (D3)', () => {
    const it0 = found();
    expect(journalGainsOf(reg, it0, { ...journalOf(it0), tierHi: -1 })).toEqual([]);
    expect(typesOf(it0), 'у стартового топора есть исторический тип').not.toEqual([]);
    expect(journalGainsOf(reg, it0, { ...journalOf(it0), typesSeen: [] })).toEqual([expect.stringMatching(/^кодекс/)]);
  });

  it('⭐ R2-07: разбор, который ДОВОДИТ счёт жалости до эскиза, — спрашивает; эскиз не на что потратить — нет', () => {
    const m = mythicDrop();
    const cls = m.weaponClass!;
    const k = reg.get('balance').craft.journal.sketchAfter;
    const full = knownAll(m);
    const own = new Set(CRAFT_SLOT_LIST.map((s) => partsOf(reg, m)![s].id));
    const spare = full.variants.find((id) => !own.has(id) && sketchable(reg, { ...full, variants: full.variants.filter((v) => v !== id) }, id))!;
    const missing = { ...full, variants: full.variants.filter((v) => v !== spare) };
    expect(journalGainsOf(reg, m, { ...missing, classSalvages: { [cls]: k - 1 } })).toEqual([expect.stringMatching(/^эскиз/)]);
    expect(journalGainsOf(reg, m, { ...missing, classSalvages: { [cls]: k - 2 } }), 'до эскиза ещё разбор').toEqual([]);
    expect(journalGainsOf(reg, m, { ...full, classSalvages: { [cls]: k - 1 } }), 'все детали открыты').toEqual([]);
  });
});

describe('⭐ disposePrompts — что спросить', () => {
  it('полевой разбор найденного с неизвестной деталью — ОДИН вопрос с предупреждением', () => {
    const p = disposePrompts(reg, found(), 'field', emptyJournal());
    expect(p).toHaveLength(1);
    expect(p[0]).toContain(PHRASE);
  });

  it('⭐ D3: полевой разбор найденного мифика с известными деталями — без вопроса (ни ступени, ни ворот); неизвестная деталь — вопрос', () => {
    const m = mythicDrop();
    expect(disposePrompts(reg, m, 'field', { ...knownAll(m), tierHi: 0, mythic: 0 })).toEqual([]);
    const p = disposePrompts(reg, m, 'field', emptyJournal());
    expect(p).toHaveLength(1);
    expect(p[0]).toContain(PHRASE);
    expect(p[0]).not.toMatch(/мифик|ступень/);
  });

  it('⭐ R2-07: продажа — та же потеря для журнала: найденное с тем, что засчитал бы кузнец, спрашивает', () => {
    const it0 = found();
    const p = disposePrompts(reg, it0, 'sell', emptyJournal(), 42);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain(SELL_PHRASE);
    expect(p[0]).toContain('42');
    const m = mythicDrop();
    expect(disposePrompts(reg, m, 'sell', { ...knownAll(m), mythic: 0 })).toEqual([]);
  });

  it('всё известно, или разбор у кузнеца (он сам откроет) — без вопросов', () => {
    const it0 = found();
    expect(disposePrompts(reg, it0, 'field', journalOf(it0))).toEqual([]);
    expect(disposePrompts(reg, it0, 'field', knownAll(it0))).toEqual([]);
    expect(disposePrompts(reg, it0, 'forge', emptyJournal())).toEqual([]);
    expect(disposePrompts(reg, it0, 'sell', journalOf(it0))).toEqual([]);
    expect(disposePrompts(reg, it0, 'sell', knownAll(it0))).toEqual([]);
  });

  it('⭐ скованное спрашивает ДВАЖДЫ — и в поле, и у кузнеца, и в лавке', () => {
    const c = crafted();
    const known = salvageIntoJournal(reg, emptyJournal(), c).journal;   // скованное — из открытого: каталог его знает
    for (const act of ['field', 'forge', 'sell'] as const) {
      const p = disposePrompts(reg, c, act, known, 123);
      expect(p, act).toHaveLength(2);
      expect(p[0]).toContain(c.name);
      expect(p[1]).toMatch(/^Точно\?/);
      expect(p.join('\n')).not.toContain(PHRASE); // скованное из открытого — неизвестного в нём нет
    }
    expect(disposePrompts(reg, c, 'sell', null, 123)[0]).toContain('123');
  });
});

describe('⭐ fieldSalvageLines — карточка разбора в поле у пункта «Разобрать здесь» (§15.2, D2)', () => {
  it('заголовок с долей, «Сырьё: ≈ …», эссенция, эскиз, подсказка «у кузнеца втрое больше» — и НИ строки каталога', () => {
    const it0 = { ...found(), rarity: 'magic' as const };
    const lines = fieldSalvageLines(reg, it0, emptyJournal());
    expect(lines[0]).toEqual({ text: `Разобрать здесь (${Math.round(reg.get('balance').salvage.fieldYield * 100)} %)`, tone: 'title' });
    expect(lines.find((l) => l.text.startsWith('Сырьё: '))?.text).toMatch(/^Сырьё: ≈ /);
    expect(lines.some((l) => l.text.startsWith('Эссенция: '))).toBe(true);
    expect(lines.some((l) => l.text.startsWith('Каталог')), 'разбор в поле каталог не пишет — строки нет (D2)').toBe(false);
    expect(lines.at(-1)).toMatchObject({ tone: 'hint' });
    expect(lines.at(-1)!.text).toMatch(/^У кузнеца сырья и эссенции втрое больше/);
  });

  it('стартовый набор в поле — отказ с причиной первой строкой после заголовка', () => {
    const lines = fieldSalvageLines(reg, starter(), emptyJournal());
    expect(lines[1]).toMatchObject({ tone: 'warn' });
    expect(lines[1]!.text).toMatch(/^Стартовый набор сырья не даёт/);
  });
});

describe('confirmAll — вопросы по очереди', () => {
  it('«нет» на любом вопросе — отказ, дальше не спрашивает', () => {
    const asked: string[] = [];
    const answers = [true, false, true];
    expect(confirmAll(['a', 'b', 'c'], (m) => { asked.push(m); return answers.shift()!; })).toBe(false);
    expect(asked).toEqual(['a', 'b']);
  });

  it('все «да» — согласие; вопросов нет — согласие без вопросов', () => {
    expect(confirmAll(['a', 'b'], () => true)).toBe(true);
    expect(confirmAll([], () => { throw new Error('не должен спрашивать'); })).toBe(true);
  });
});

/**
 * ⭐ R1-14: РАЗБОР В ПОЛЕ СПРАШИВАЕТ В ИГРЕ, НЕ ОСТАНАВЛИВАЯ ЕЁ. `window.confirm` замораживает страницу — ни кадров,
 * ни ввода, — а сервер всё это время гоняет бой с последним полученным вводом: зажатый W идёт, монстры бьют. Вопрос
 * в поле — плашка в DOM с ответом промисом (`askInGame`); `window.confirm` остался только городу (кузница, лавка).
 *
 * DOM-окружения в проекте нет (тесты идут в node) — заглушка ровно тех свойств, которыми пользуется вопрос.
 */
describe('⭐ R1-14: вопрос в поле — в игре, а не window.confirm', () => {
  class El {
    children: El[] = []; style: Record<string, string> = {}; textContent = ''; disabled = false; parent: El | null = null;
    private on = new Map<string, (() => void)[]>();
    constructor(public tag: string) { }
    addEventListener(t: string, f: () => void): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
    append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
    appendChild(c: El): El { this.append(c); return c; }
    remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
    click(): void { for (const f of this.on.get('click') ?? []) f(); }
    all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
    text(): string { return [this.textContent, ...this.all().map((c) => c.textContent)].join(' | '); }
  }
  const G = globalThis as unknown as { document?: unknown; window?: unknown };
  let body: El;
  beforeEach(() => {
    body = new El('body');
    G.document = { createElement: (t: string) => new El(t), body };
    G.window = { confirm: () => { throw new Error('window.confirm в поле замораживает игру'); } };
  });
  afterEach(() => { delete G.document; delete G.window; });

  /** Открытый вопрос и его кнопки «да»/«нет». */
  const asked = (): { box: El; yes: El; no: El } | null => {
    const box = body.children.at(-1);
    if (!box) return null;
    const btns = box.all().filter((e) => e.tag === 'button');
    return { box, yes: btns[0]!, no: btns[1]! };
  };
  function fieldApp(item: Item, journal: CraftJournal = emptyJournal(), reply: { ok: boolean; reason?: string; summary?: string } = { ok: true }) {
    const sent: unknown[] = [];
    const logs: string[] = [];
    const app = {
      config: reg, stash: { forgeJournal: journal },
      state: { area: 'dungeon' as 'town' | 'dungeon', save: { inventory: [item] } },
      // Ответ сервера — промисом, как у `App.request`.
      request: (c: unknown) => { sent.push(c); return Promise.resolve({ t: 'cmdResult', cmd: 'salvage', ...reply }); },
      bus: { emit: (_t: string, e: { text: string }) => { logs.push(e.text); } },
    };
    return { app: app as unknown as Parameters<typeof salvageInField>[0], state: app.state, sent, logs };
  }

  it('⭐ вопрос — плашка в DOM, ответ промисом: синхронно ничего не спрошено и не отправлено; «да» → команда', async () => {
    const it0 = found();
    const { app, sent } = fieldApp(it0);
    const p = salvageInField(app, it0);   // умолчание — вопрос в игре; window.confirm здесь бросил бы
    expect(p).toBeInstanceOf(Promise);
    expect(sent, 'пока вопрос висит, команды нет').toEqual([]);
    await Promise.resolve();
    const q = asked();
    expect(q, 'вопрос на странице').not.toBeNull();
    expect(q!.box.text()).toContain(PHRASE);
    q!.yes.click();
    await expect(p).resolves.toBe(true);
    expect(sent, 'R8-14, R9-04: с низом вилки и средним выходом — меньше сервер не даст').toEqual([{ cmd: 'salvage', uid: it0.uid, minYield: fieldLow(it0), avgYield: fieldAvg(it0) }]);
    expect(body.children, 'ответили — плашка снята').toHaveLength(0);
  });

  it('«нет» — ни команды; вопросов нет (всё известно) — команда сразу, без плашки', async () => {
    const it0 = found();
    const a = fieldApp(it0);
    const p = salvageInField(a.app, it0);
    await Promise.resolve();
    asked()!.no.click();
    await expect(p).resolves.toBe(false);
    expect(a.sent).toEqual([]);
    expect(body.children).toHaveLength(0);

    const b = fieldApp(it0, knownAll(it0));
    await expect(salvageInField(b.app, it0)).resolves.toBe(true);
    expect(b.sent).toEqual([{ cmd: 'salvage', uid: it0.uid, minYield: fieldLow(it0), avgYield: fieldAvg(it0) }]);
    expect(body.children).toHaveLength(0);
  });

  it('пока висел вопрос, игра шла: вещь выбросили или герой ушёл в город — «да» ничего не шлёт', async () => {
    const it0 = found();
    const gone = fieldApp(it0);
    const p1 = salvageInField(gone.app, it0);
    await Promise.resolve();
    gone.state.save.inventory = [];
    asked()!.yes.click();
    await expect(p1).resolves.toBe(false);
    expect(gone.sent).toEqual([]);

    const town = fieldApp(it0);
    const p2 = salvageInField(town.app, it0);
    await Promise.resolve();
    town.state.area = 'town';
    asked()!.yes.click();
    await expect(p2).resolves.toBe(false);
    expect(town.sent).toEqual([]);
  });

  it('⭐ R2-14: отказ сервера («Слишком часто») — строкой в логе игры, а не молчанием; ⭐ §15.2: успех — итоговой строкой сервера', async () => {
    const it0 = found();
    const busy = fieldApp(it0, knownAll(it0), { ok: false, reason: 'Слишком часто' });
    await expect(salvageInField(busy.app, it0)).resolves.toBe(true);
    await Promise.resolve();
    expect(busy.logs).toEqual(['Разбор не удался: Слишком часто']);
    const summary = 'Получено: Болотное железо 1 · каталог пополняет только разбор у кузнеца';
    const fine = fieldApp(it0, knownAll(it0), { ok: true, summary });
    await expect(salvageInField(fine.app, it0)).resolves.toBe(true);
    await Promise.resolve();
    expect(fine.logs, 'было: успех молчал — даже полученное сырьё не показывалось').toEqual([`Разбор «${it0.name}»: ${summary}`]);
    // Сервер старше итоговой строки — успех без неё лог не трогает.
    const old = fieldApp(it0, knownAll(it0));
    await expect(salvageInField(old.app, it0)).resolves.toBe(true);
    await Promise.resolve();
    expect(old.logs).toEqual([]);
  });

  it('askInGame: второй вопрос снимает первый с ответом «нет» — на странице одна плашка', async () => {
    const p1 = askInGame('первый');
    const p2 = askInGame('второй');
    await expect(p1).resolves.toBe(false);
    expect(body.children).toHaveLength(1);
    expect(asked()!.box.text()).toContain('второй');
    asked()!.yes.click();
    await expect(p2).resolves.toBe(true);
    expect(body.children).toHaveLength(0);
  });

  /**
   * ⭐ R3-23: ВОПРОС НЕ ПЕРЕЖИВАЕТ СМЕНУ ОБЛАСТИ. Плашка висела на `document.body` без срока: пати проголосовала в город,
   * герой умер или вышел в меню — вопрос оставался над городом, а «Да» потом молча ничего не делало (перепроверка
   * отказывала без слова). Теперь смена области и выход снимают вопрос (`dismissAsk`) с ответом «нет», а перепроверка
   * после «да» говорит в лог, почему разбора не будет.
   */
  it('⭐ R3-23: dismissAsk снимает открытый вопрос с ответом «нет»; без вопроса — ничего', async () => {
    dismissAsk();                                      // вопроса нет — не бросает
    const p = askInGame('вопрос');
    expect(body.children).toHaveLength(1);
    dismissAsk();
    await expect(p).resolves.toBe(false);
    expect(body.children, 'плашка снята').toHaveLength(0);
    const it0 = found();
    const f = fieldApp(it0);
    const q = salvageInField(f.app, it0);
    await Promise.resolve();
    dismissAsk();                                      // смена области, пока вопрос висит
    await expect(q).resolves.toBe(false);
    expect(f.sent).toEqual([]);
    expect(f.logs, 'вопрос снят игрой, а не игроком, — лог молчит').toEqual([]);
  });

  it('⭐ R3-23: «да» после того, как вещь пропала или герой ушёл в город, — строка в логе, а не молчание', async () => {
    const it0 = found();
    const town = fieldApp(it0);
    const p1 = salvageInField(town.app, it0);
    await Promise.resolve();
    town.state.area = 'town';
    asked()!.yes.click();
    await expect(p1).resolves.toBe(false);
    expect(town.logs).toEqual([expect.stringMatching(/^Разбор отменён: /)]);
    const gone = fieldApp(it0);
    const p2 = salvageInField(gone.app, it0);
    await Promise.resolve();
    gone.state.save.inventory = [];
    asked()!.yes.click();
    await expect(p2).resolves.toBe(false);
    expect(gone.logs).toEqual([expect.stringMatching(/^Разбор отменён: /)]);
    expect([...town.sent, ...gone.sent]).toEqual([]);
  });

  it('confirmAllAsync: «нет» на любом вопросе — отказ, дальше не спрашивает', async () => {
    const q: string[] = [];
    const answers = [true, false, true];
    await expect(confirmAllAsync(['a', 'b', 'c'], async (m) => { q.push(m); return answers.shift()!; })).resolves.toBe(false);
    expect(q).toEqual(['a', 'b']);
    await expect(confirmAllAsync([], () => { throw new Error('не должен спрашивать'); })).resolves.toBe(true);
  });
});
