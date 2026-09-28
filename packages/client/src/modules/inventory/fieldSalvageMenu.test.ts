import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, FIELD_SALVAGE_FULL, addToInventory, createRng, fieldSalvage, itemFromBaseId, materialItem, newBotSave, salvageRange,
  type Item, type SalvageRng, type SaveState,
} from '@dm/shared';
import { GameState } from '../../core/gameState.js';
import { inventoryPanel } from './inventoryPanel.js';
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

/** Пункты меню ПКМ по стилету — так, как их видит игрок. */
async function menuOf(save: SaveState, area: 'town' | 'dungeon' = 'dungeon'): Promise<string[]> {
  const dom = installDom(() => true);
  try {
    const state = new GameState(save);
    state.area = area;
    const app = { config: reg, state, stash: null, sendCmd: () => {}, request: () => Promise.resolve(null), bus: { emit: () => {} } };
    const body = new El('div');
    inventoryPanel(app as never, {} as never).render(body as never);
    const item = save.inventory.find((i) => i.uid === 'stiletto')!;
    const cell = body.all().find((e) => e.listens('contextmenu') && (e.style.cssText ?? '').startsWith(`grid-column:${item.pos!.x + 1} / span`)
      && (e.style.cssText ?? '').includes(`grid-row:${item.pos!.y + 1} / span`))!;
    cell.dispatch('contextmenu', { clientX: 10, clientY: 10 });
    const labels = (dom.body.children.at(-1)?.children ?? []).map((c) => c.textContent);
    await new Promise((r) => setTimeout(r, 0));   // меню вешает закрытие по клику таймером — пусть отработает при живом `window`
    return labels;
  } finally {
    dom.restore();
  }
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
