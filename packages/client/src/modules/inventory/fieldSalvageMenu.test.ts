import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, FIELD_SALVAGE_FULL, STARTER_FIELD, UNIQUE_NO_SALVAGE, addToInventory, canSalvageItem, createRng, fieldSalvage, generateItem,
  itemFromBaseId, materialItem, newBotSave, salvageRange,
  type Item, type SalvageRng, type SaveState,
} from '@dm/shared';
import { GameState } from '../../core/gameState.js';
import { inventoryPanel } from './inventoryPanel.js';
import { fieldSalvageEntry, fieldSalvageLines } from './disposeConfirm.js';
import { El, installDom } from '../town/uiParity.fuzzKit.js';

/**
 * ⭐ V-B3-04: «РАЗОБРАТЬ ЗДЕСЬ» ПРЕДЛАГАЕТСЯ, ТОЛЬКО ЕСЛИ СЫРЬЁ ВЛЕЗЕТ. Меню инвентаря в подземелье спрашивало лишь «разбирается
 * ли вещь» (`canSalvageItem`), а сервер ещё и примерял выход в сумку — ВЫПАВШИЙ бросок — и отказывал «Сумка полна» после того,
 * как игрок ответил на оба вопроса о скованной вещи. Теперь примерка одна и по лучшему броску (`fieldSalvageFits`): меню и сервер
 * отвечают одинаково, и ответ сервера от кубика не зависит. Нашёл фаззер паритета (`town/uiParity.fuzz.test.ts`).
 *
 * Меню — настоящее (`inventoryPanel` → ПКМ по клетке → `showContextMenu`) в DOM-заглушке фаззера.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const dims = reg.get('balance').inventory;
const LO: SalvageRng = { int: (a) => a, chance: () => false };
const HI: SalvageRng = { int: (_a, b) => b, chance: (p) => p > 1e-9 };

/** Стилет в поле: вилка «0–1» по четырём материалам — лучшему броску нужны четыре клетки, худшему — ни одной. */
const stiletto = (): Item => ({ ...itemFromBaseId(reg.get('items.base'), 'stiletto', reg.get('item-tiers'), 'drop')!, uid: 'stiletto' });
const gains = Object.keys(salvageRange(reg, stiletto(), true).range);
const needCells = gains.length;

/** Сумка: стилет и полные стеки чужого сырья, свободных клеток — `spare`. */
function heroWith(spare: number): SaveState {
  const save = newBotSave(reg, 'warrior');
  save.inventory = [];
  addToInventory(save.inventory, stiletto(), dims);
  const junk = reg.get('craft-materials').find((m) => !gains.includes(m.id))!;
  for (let k = 0; k < dims.cols * dims.rows; k++) if (!addToInventory(save.inventory, materialItem(junk, dims.materialStack, `junk-${k}`), dims)) break;
  for (let k = 0; k < spare; k++) save.inventory.pop();
  return save;
}

/** Пункт меню так, как его видит игрок: подпись, живой ли (отвечает на клик), погашен ли видом, и подсказка строками (`null` — её нет). */
interface MenuSeen { label: string; live: boolean; dim: boolean; tip: string[] | null }

/** Строки подсказки текстом: по строке на `<div>`, без разметки. */
const textLines = (html: string): string[] => html.split('</div>').map((x) => x.replace(/<[^>]+>/g, '')).filter(Boolean);

/**
 * Что легло в ОБЩУЮ подсказку (kit `attachTooltip` пишет её `innerHTML` на `mouseenter`) за время `run`; не легло ничего — `null`.
 * ⚠ Наличие слушателя `mouseenter` подсказки не доказывает: у ЖИВОГО пункта он есть всегда (подсветка строки) — потому читаем, что показано.
 */
function tipShown(run: () => void): string[] | null {
  const desc = Object.getOwnPropertyDescriptor(El.prototype, 'innerHTML')!;
  let html: string | null = null;
  Object.defineProperty(El.prototype, 'innerHTML', { ...desc, set(this: El, v: string) { html = v; desc.set!.call(this, v); } });
  try { run(); } finally { Object.defineProperty(El.prototype, 'innerHTML', desc); }
  return html === null ? null : textLines(html);
}

/** Пункты меню ПКМ по вещи `uid` (по умолчанию стилет): у каждого — навести мышь и прочитать подсказку, как игрок. */
async function menuItems(save: SaveState, area: 'town' | 'dungeon' = 'dungeon', uid = 'stiletto'): Promise<MenuSeen[]> {
  const dom = installDom(() => true);
  try {
    const state = new GameState(save);
    state.area = area;
    const app = { config: reg, state, stash: null, sendCmd: () => {}, request: () => Promise.resolve(null), bus: { emit: () => {} } };
    const body = new El('div');
    inventoryPanel(app as never, {} as never).render(body as never);
    const item = save.inventory.find((i) => i.uid === uid)!;
    const cell = body.all().find((e) => e.listens('contextmenu') && (e.style.cssText ?? '').startsWith(`grid-column:${item.pos!.x + 1} / span`)
      && (e.style.cssText ?? '').includes(`grid-row:${item.pos!.y + 1} / span`))!;
    cell.dispatch('contextmenu', { clientX: 10, clientY: 10 });
    const out = (dom.body.children.at(-1)?.children ?? []).map((c): MenuSeen => {
      const tip = tipShown(() => c.dispatch('mouseenter', { clientX: 10, clientY: 10 }));
      c.dispatch('mouseleave');
      return { label: c.textContent, live: c.listens('click'), dim: (c.style.cssText ?? '').includes('cursor:default'), tip };
    });
    await new Promise((r) => setTimeout(r, 0));   // меню вешает закрытие по клику таймером — пусть отработает при живом `window`
    return out;
  } finally {
    dom.restore();
  }
}
const menuOf = async (save: SaveState, area: 'town' | 'dungeon' = 'dungeon'): Promise<string[]> => (await menuItems(save, area)).map((m) => m.label);

/** Сумка из одной вещи `it` (uid `x`). */
function heroHolding(it: Item): SaveState {
  const save = newBotSave(reg, 'warrior');
  save.inventory = [];
  addToInventory(save.inventory, { ...it, uid: 'x' }, dims);
  return save;
}

describe('⭐ V-B3-04: меню «Разобрать здесь» ≡ сервер (место по лучшему броску)', () => {
  const cells = stiletto().gridW * stiletto().gridH;

  it('лучший бросок не влезет: пункта нет (вместо него — «сумка полна»), и сервер отказывает при любом броске', async () => {
    const spare = needCells - cells - 1;
    expect(spare).toBeGreaterThanOrEqual(0);
    const menu = await menuOf(heroWith(spare));
    expect(menu.some((l) => l.startsWith('Разобрать здесь')), `было: пункт предлагался — ${menu.join(' · ')}`).toBe(false);
    expect(menu).toContain('Разобрать нельзя: сумка полна');
    for (const rng of [LO, HI, createRng(3)]) expect(fieldSalvage(reg, heroWith(spare), 'stiletto', rng)).toEqual({ ok: false, reason: FIELD_SALVAGE_FULL });
  });

  it('влезет: пункт есть, и сервер разбирает при любом броске', async () => {
    const spare = needCells - cells;
    const menu = await menuOf(heroWith(spare));
    expect(menu.some((l) => l.startsWith('Разобрать здесь'))).toBe(true);
    expect(menu).not.toContain('Разобрать нельзя: сумка полна');
    for (const rng of [LO, HI, createRng(3)]) expect(fieldSalvage(reg, heroWith(spare), 'stiletto', rng).ok).toBe(true);
  });

  it('в городе пункта нет вовсе — там разбирает кузнец', async () => {
    const menu = await menuOf(heroWith(needCells), 'town');
    expect(menu.some((l) => l.startsWith('Разобрать'))).toBe(false);
  });
});

/**
 * ⭐ ОТКАЗ РАЗБОРА В ПОЛЕ — ПУНКТОМ С ПРИЧИНОЙ, А НЕ ТИШИНОЙ. Было: стартовый набор (`STARTER_FIELD`) и любой другой отказ `canSalvageItem`
 * убирали пункт «Разобрать» из меню молча — игрок не знал, почему стартовый меч в подземелье не разбирается. Теперь пункт погашен
 * («Разобрать нельзя: …», как «Надеть нельзя: …»), на клик не отвечает, а подсказка — «Разобрать нельзя» и причина (у «сумка полна» — и
 * карточка поля целиком: разбор возможен, мешает место). Подсказку читаем ПОКАЗАННОЙ (`tipShown`), а не по слушателю наведения.
 */
describe('⭐ меню в поле: «Разобрать нельзя: причина» вместо пропавшего пункта', () => {
  const kit = (): Item => newBotSave(reg, 'warrior').equipment.weapon!;
  const gen = (baseId: string, forceRarity: 'normal' | 'magic' | 'rare' | 'unique', seed: number): Item =>
    generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 30, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity, origin: 'drop',
    }, createRng(seed));

  const PCT = `${Math.round(reg.get('balance').salvage.fieldYield * 100)} %`;
  /** Карточка разбора в поле текстом — как её кладёт `fieldSalvageTip`. */
  const card = (it: Item, refusal?: string): string[] => fieldSalvageLines(reg, it, null, refusal).map((l) => l.text);

  it('стартовый набор: пункт погашен, подсказка — ТОЛЬКО «Разобрать нельзя» и причина `STARTER_FIELD`', async () => {
    expect(canSalvageItem(reg, kit(), true)).toEqual({ ok: false, reason: STARTER_FIELD });
    const menu = await menuItems(heroHolding(kit()), 'dungeon', 'x');
    const salv = menu.find((m) => m.label.startsWith('Разобрать'));
    // ⚠ Было: заголовок «Разобрать здесь (30 %)» и под причиной «Сырьё / Эссенция / Эскиз: копит только разбор у кузнеца (меч 0/8)» — у
    // вещи, которую в поле не разобрать вовсе.
    expect(salv, `пункт пропал: ${menu.map((m) => m.label).join(' · ')}`).toEqual({
      label: `Разобрать нельзя: ${STARTER_FIELD}`, live: false, dim: true, tip: ['Разобрать нельзя', STARTER_FIELD],
    });
  });

  it('уник: «Разобрать нельзя: …» с причиной `UNIQUE_NO_SALVAGE` — и в подсказке только она (ни «Эссенция: нет — материал выключен»)', async () => {
    const u = gen('short-sword', 'unique', 5);
    expect(u.rarity).toBe('unique');
    expect(await menuItems(heroHolding(u), 'dungeon', 'x')).toContainEqual({
      label: `Разобрать нельзя: ${UNIQUE_NO_SALVAGE}`, live: false, dim: true, tip: ['Разобрать нельзя', UNIQUE_NO_SALVAGE],
    });
  });

  it('сумка полна: погашен; подсказка — «Разобрать нельзя», «Сумка полна…» и карточка целиком (что вышло бы, освободи место)', async () => {
    const menu = await menuItems(heroWith(needCells - stiletto().gridW * stiletto().gridH - 1));
    const salv = menu.find((m) => m.label.startsWith('Разобрать'))!;
    expect(salv).toMatchObject({ label: 'Разобрать нельзя: сумка полна', live: false, dim: true });
    expect(salv.tip).toEqual(card(stiletto(), FIELD_SALVAGE_FULL));
    expect(salv.tip!.slice(0, 2)).toEqual(['Разобрать нельзя', FIELD_SALVAGE_FULL]);
    expect(salv.tip!.slice(2), 'строки карточки — те же, что у живого пункта').toEqual(card(stiletto()).slice(1));
    expect(salv.tip!.some((l) => l.startsWith('Сырьё: ≈ '))).toBe(true);
    expect(card(stiletto()).some((l) => l === FIELD_SALVAGE_FULL || l === 'Разобрать нельзя'), 'без отказа — без них').toBe(false);
  });

  it('можно: «Разобрать здесь (N %)» живой, не погашен, подсказка — карточка поля; прочие живые пункты — без подсказки и не погашены', async () => {
    const menu = await menuItems(heroWith(needCells));
    const salv = menu.find((m) => m.label.startsWith('Разобрать здесь'))!;
    expect(salv).toMatchObject({ label: `Разобрать здесь (${PCT})`, live: true, dim: false });
    expect(salv.tip).toEqual(card(stiletto()));
    expect(salv.tip![0]).toBe(`Разобрать здесь (${PCT})`);
    // Живой пункт слушает `mouseenter` ради подсветки — подсказкой это не считается, и погашенным он не выглядит.
    expect(menu.find((m) => m.label === 'Выбросить')).toEqual({ label: 'Выбросить', live: true, dim: false, tip: null });
    // Погашен ⇔ не живой — у каждого пункта (здесь погашен только «Надеть нельзя: …»: героя-бота не хватает на стилет).
    expect(menu.filter((m) => m.live === m.dim).map((m) => m.label)).toEqual([]);
    expect(menu.filter((m) => m.dim).map((m) => m.label).every((l) => l.startsWith('Надеть нельзя: '))).toBe(true);
  });

  it('КАЖДЫЙ отказ поля у вещей игры — пунктом с причиной (`canSalvageItem` ≡ подпись); зелья и сырьё пункта не имеют вовсе', () => {
    const items: Item[] = [];
    let seed = 1;
    for (const b of reg.get('items.base').filter((x) => x.enabled !== false)) {
      for (const r of ['normal', 'magic', 'rare', 'unique'] as const) {
        const it = gen(b.id, r, seed++);
        items.push(it, { ...it, origin: 'start' });
      }
    }
    for (const m of reg.get('craft-materials')) items.push(materialItem(m, 3, `m-${m.id}`));
    const reasons = new Set<string>();
    let consumables = 0;
    for (const it of items) {
      const e = fieldSalvageEntry(reg, [it], it);
      if (it.kind === 'consumable' || it.kind === 'material') { consumables++; expect(e, `${it.baseId ?? it.materialId}`).toBeNull(); continue; }
      const can = canSalvageItem(reg, it, true);
      if (can.ok) { expect(e!.ok, it.baseId).toBe(true); continue; }
      reasons.add(can.reason!);
      expect(e, it.baseId).toEqual({ label: `Разобрать нельзя: ${can.reason}`, ok: false, reason: can.reason });
      // Подсказка отказа — заголовок по отказу и та же причина, что в подписи; строк «что вышло бы» нет (как у верстака кузницы).
      expect(fieldSalvageLines(reg, it, null, e!.reason), it.baseId).toEqual([
        { text: 'Разобрать нельзя', tone: 'title' }, { text: can.reason, tone: 'warn' },
      ]);
    }
    expect(consumables).toBeGreaterThan(0);
    expect([...reasons]).toEqual(expect.arrayContaining([STARTER_FIELD, UNIQUE_NO_SALVAGE]));
  });
});
