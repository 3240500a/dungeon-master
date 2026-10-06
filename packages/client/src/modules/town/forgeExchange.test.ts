import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, ESSENCE_ID, defaultConfigData, emptyStash, forgeExchange, materialItem, newCharacterSave, parseTownCommand, type Item,
} from '@dm/shared';
import { defaultGive, exchangeModel } from './forgeExchange.js';

/**
 * ⭐ ВКЛАДКА «⇄ ОБМЕН» — модель окна ≡ сервер: что горит, то сервер исполняет ровно по карточке; что погашено — сервер отказывает той же
 * причиной. Стопки — сумка + сундук, эссенции среди них нет; цели — другие семьи того же сорта.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const def = (id: string) => reg.get('craft-materials').find((m) => m.id === id)!;
const stack = (id: string, n: number, x = 0): Item => ({ ...materialItem(def(id), n, `m-${id}-${x}`), pos: { x, y: 0 } });

describe('модель вкладки «Обмен»', () => {
  it('стопки — сумка + сундук, по семьям и сортам; эссенции нет; без выбора — подсказка', () => {
    const m = exchangeModel(reg, [stack('wood-2', 4), stack(ESSENCE_ID, 3, 1)], { 'iron-3': 10, 'wood-2': 2, 'iron-1': 1 }, 500, { from: null, to: null, n: 0 });
    expect(m.sources.map((s) => [s.id, s.have, s.bag, s.stash])).toEqual([['iron-1', 1, 0, 1], ['iron-3', 10, 0, 10], ['wood-2', 6, 4, 2]]);
    expect(m.reason).toBe('Выбери, что отдаёшь');
    expect(m.canSend).toBe(false);
    expect(m.rate).toMatch(/3 → 2/);
    expect(m.goldLine).toMatch(/I 5 · II 12 · III 30 · IV 60 · V 120/);
  });

  it('⭐ выбор → карточка и команда с согласием; сервер исполняет ровно по карточке', () => {
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Окно', 'char-win');
    save.inventory = [stack('iron-3', 5)];
    save.gold = 1000;
    const st = emptyStash(reg);
    st.materials = { 'iron-3': 10, 'wood-3': 1 };
    const sel = { from: 'iron-3', to: 'wood', n: defaultGive(reg, 15) };
    expect(sel.n).toBe(3);
    const m = exchangeModel(reg, save.inventory, st.materials, save.gold, { ...sel, n: 10 });
    expect(m.targets.map((t) => t.family).sort()).toEqual(['cloth', 'hide', 'plate', 'trim', 'wood']);
    expect(m.lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      `Отдашь: ${def('iron-3').name} 9 (есть 15, в сумке 5 — берётся первой) · 1 останется — меньше курса`,
      `Получишь: ${def('wood-3').name} 6 (есть 1) — в сундук`,
      'Золото: 180 (30 за единицу · есть 1000)',
    ]);
    expect(m.canSend).toBe(true);
    expect(m.command).toEqual({ cmd: 'forgeExchange', from: 'iron-3', to: 'wood', n: 9, maxGold: 180, maxMaterials: { 'iron-3': 9 }, minYield: { 'wood-3': 6 } });
    expect(parseTownCommand(m.command).ok, 'команда проходит провод').toBe(true);
    const c = m.command!;
    const r = forgeExchange(reg, save, st, c.from, c.to, c.n, c.maxGold, c.maxMaterials, c.minYield);
    expect(r.ok, r.reason).toBe(true);
    expect(save.gold).toBe(820);
    expect(st.materials).toEqual({ 'iron-3': 6, 'wood-3': 7 });
    expect(save.inventory).toEqual([]);
  });

  it('погашено — той же причиной, что откажет сервер: золото, мало, выключенная цель', () => {
    const m1 = exchangeModel(reg, [], { 'iron-3': 30 }, 100, { from: 'iron-3', to: 'wood', n: 9 });
    expect(m1.canSend).toBe(false);
    expect(m1.reason).toMatch(/Недостаточно золота/);
    expect(m1.lines.find((l) => l.label === 'Золото')!.state).toBe('miss');
    const m2 = exchangeModel(reg, [], { 'iron-3': 30 }, 1000, { from: 'iron-3', to: 'wood', n: 1 });
    expect(m2.reason).toMatch(/Мало/);
    const d = structuredClone(defaultConfigData) as Record<string, unknown>;
    for (const m of d['craft-materials'] as { id: string; enabled: boolean }[]) if (m.id === 'wood-3') m.enabled = false;
    const off = new ConfigRegistry();
    off.loadAll(d);
    const m3 = exchangeModel(off, [], { 'iron-3': 30 }, 1000, { from: 'iron-3', to: 'wood', n: 9 });
    expect(m3.targets.find((t) => t.family === 'wood')).toMatchObject({ ok: false, selected: false });
    expect(m3.reason, 'выключенную цель не выбрать').toBe('Выбери, во что меняешь');
  });

  it('обмен выключен в конфиге — вкладка говорит это, выбора нет', () => {
    const d = structuredClone(defaultConfigData) as Record<string, unknown>;
    (d.balance as { forgePrices: { exchange: { enabled: boolean } } }).forgePrices.exchange.enabled = false;
    const off = new ConfigRegistry();
    off.loadAll(d);
    const m = exchangeModel(off, [], { 'iron-3': 30 }, 1000, { from: 'iron-3', to: 'wood', n: 9 });
    expect(m.closed).toBe('Кузнец сейчас не меняет сырьё');
    expect(m.sources).toEqual([]);
  });

  it('выбор, ставший негодным (стопка кончилась), снимается', () => {
    const m = exchangeModel(reg, [], { 'iron-1': 2 }, 1000, { from: 'iron-3', to: 'wood', n: 9 });
    expect(m.sources.some((s) => s.selected)).toBe(false);
    expect(m.reason).toBe('Выбери, что отдаёшь');
  });
});
