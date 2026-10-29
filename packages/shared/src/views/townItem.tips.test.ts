/**
 * ⭐ С-аудит (29.10): ПОДСКАЗКИ ВЕЩЕЙ (`item/tips`) — НАДЕТОЕ ОДИН РАЗ НА СЛОТ. Раньше каждая подсказка несла строки надетого в её слот
 * целиком (`worn: {name, lines}`), и 400 подсказок повторяли одни и те же девять вещей: ≈ 40 КБ на токен лимита при правиле ≈ 11 КБ.
 * Теперь ответ — `{ tips, worn }`: подсказка ссылается на слот (`wornSlot`), а строки надетого лежат в `worn[слот]` один раз. Что игрок
 * видит — то же: подсказка + «Сейчас надето» восстанавливаются до прежней модели буква в букву.
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import type { Item } from '../types/items.js';
import type { EquipSlot } from '../types/index.js';
import { itemDescLines, itemTipView, itemTipsView, wornFor } from './townItem.js';

const cfg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

function setup(n: number) {
  const cls = cfg.get('classes').find((c) => c.enabled !== false) ?? cfg.get('classes')[0]!;
  const save = newCharacterSave(cfg, cls.id, 'Образец', 'char-tips');
  const rng = createRng(4242);
  const items: Item[] = Array.from({ length: n }, (_, i) => ({
    ...generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'), {
      dropBias: 0, itemLevel: 30, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: i % 2 ? 'rare' : 'magic', noUnique: true,
    }, rng),
    uid: `t-${i}`,
  }));
  const worn = Object.values(save.equipment).filter((x): x is Item => !!x);
  return { save, items, worn };
}

describe('⭐ С-аудит: подсказки — `{ tips, worn }`, надетое по разу на слот', () => {
  it('форма: у подсказки `wornSlot` вместо `worn`; надетое — в `worn[слот]` (имя и строки), только то, на что ссылаются', () => {
    const { save, items, worn } = setup(60);
    const v = itemTipsView(cfg, save, [...items, ...worn]);
    expect(Object.keys(v)).toEqual(['tips', 'worn']);
    expect(Object.keys(v.tips).length).toBe(items.length + worn.length);
    const used = new Set<string>();
    for (const [uid, tip] of Object.entries(v.tips)) {
      expect(tip.uid).toBe(uid);
      expect(tip, 'старого поля нет').not.toHaveProperty('worn');
      const it = [...items, ...worn].find((x) => x.uid === uid)!;
      const w = wornFor(save, it);
      // ⚠ прежнее правило сравнения: есть надетое в слот вещи и это ДРУГАЯ вещь
      expect(tip.wornSlot, uid).toBe(w && w.uid !== it.uid ? it.slot! : null);
      if (tip.wornSlot) used.add(tip.wornSlot);
    }
    expect(Object.keys(v.worn).sort(), 'надетое — ровно то, на что ссылаются').toEqual([...used].sort());
    expect(used.size).toBeGreaterThan(0);
    for (const slot of used) {
      const w = save.equipment[slot as EquipSlot]!;
      expect(v.worn[slot]).toEqual({ name: w.name, lines: itemDescLines(cfg, w) });
    }
    // надетая вещь сама с собой не сравнивается
    for (const w of worn) expect(v.tips[w.uid]!.wornSlot).toBeNull();
  });

  it('что видит игрок — прежнее: подсказка + `worn[wornSlot]` = прежняя модель; байт — заметно меньше', () => {
    const { save, items, worn } = setup(120);
    const all = [...items, ...worn];
    const v = itemTipsView(cfg, save, all);
    let oldBytes = 0;
    for (const it of all) {
      const tip = v.tips[it.uid]!;
      const { wornSlot, ...rest } = tip;
      const w = wornFor(save, it);
      const was = { ...rest, worn: w && w.uid !== it.uid ? { name: w.name, lines: itemDescLines(cfg, w) } : null };
      expect({ ...rest, worn: wornSlot ? v.worn[wornSlot]! : null }, it.uid).toEqual(was);
      expect(itemTipView(cfg, it, w), 'одиночная подсказка — та же').toEqual(tip);
      oldBytes += JSON.stringify([it.uid, was]).length;
    }
    expect(JSON.stringify(v).length, 'повторы надетого ушли').toBeLessThan(oldBytes * 0.8);
  });

  it('пусто — пусто', () => {
    const { save } = setup(0);
    expect(itemTipsView(cfg, save, [])).toEqual({ tips: {}, worn: {} });
  });
});
