import { describe, it, expect } from 'vitest';
import { ConfigRegistry, ESSENCE_ID, itemFromBaseId, materialItem, upgradedItem, type Item } from '@dm/shared';
import { ESSENCE_HEX, GRADE_HEX, SALVAGE_RULE, gradeSourceText, materialNote, materialsModel } from './materialsModel.js';
import { itemTooltipHtml, setItemLabelResolvers } from './itemView.js';

/**
 * ⭐ СКЛАД «РЕСУРСЫ» — СОРТА I–V (предложение «Разбор, сырьё и чары» §15.1). Жалоба, с которой всё началось: столбцы «обычные / магические /
 * редкие» в цветах редкостей читались как «жёлтая вещь → жёлтое сырьё», а сорт сырья на деле — ступень вещи. Стережём: подписи — сорта, и под
 * ними «с каких вещей» ИЗ РЕЦЕПТА (правка рецепта в редакторе меняет подпись); цвета — металлическая шкала без цветов редкостей; эссенция —
 * плашкой, не строкой сетки; подсказки говорят откуда, куда и почём (D4: всё сырьё и эссенция продаются).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

describe('materialsModel — склад сырья', () => {
  const m = materialsModel(reg, { 'iron-1': 40, 'hide-4': 2, [ESSENCE_ID]: 7 }, []);

  it('столбцы — «I сорт … V сорт», под ними — с каких ступеней вещей идёт сорт (по рецепту разбора)', () => {
    expect(m.heads.map((h) => h.label)).toEqual(['I сорт', 'II сорт', 'III сорт', 'IV сорт', 'V сорт']);
    expect(m.heads.map((h) => h.sub)).toEqual([
      'Убогий, Старый · тела монстров',
      'Старый (боевая часть), Крепкий',
      'Отличный, Мастерский',
      'Мастерский (боевая часть), Элитный',
      'Мифический',
    ]);
    expect(m.heads.map((h) => h.bold)).toEqual([false, false, false, false, true]);
  });

  it('подписи живут рецептом: правка `salvage.recipeByTier` в редакторе меняет «с каких вещей»', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    const bal = r.get('balance');
    // t4 — целиком IV (как t5): «Мастерский» уходит из III в IV без «боевой части».
    const rows = bal.salvage.recipeByTier.map((row, i) => (i === 4 ? [4, 4, 4, 4] : row));
    r.reload({ balance: { ...bal, salvage: { ...bal.salvage, recipeByTier: rows } } }, { cross: false });
    expect(gradeSourceText(r, 3)).toBe('Отличный');
    expect(gradeSourceText(r, 4)).toBe('Мастерский, Элитный');
  });

  it('цвета — металлическая шкала: ни одного цвета редкости, ни меди, ни красного; эссенция — сиреневая', () => {
    const rarity = new Set(reg.get('rarities').map((x) => x.color.toLowerCase()));
    for (const c of [...GRADE_HEX, ESSENCE_HEX]) expect(rarity.has(c.toLowerCase()), c).toBe(false);
    expect(m.heads.map((h) => h.color)).toEqual([...GRADE_HEX]);
    // Серая шкала: R ≈ G ≈ B у каждого сорта (никакой меди и красного) и светлеет к V.
    const lum = GRADE_HEX.map((h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(24); return r! + g! + b!; });
    expect([...lum].sort((a, b) => a - b)).toEqual(lum);
  });

  it('⭐ эссенция — плашкой под сеткой, не строкой: в сетке её прочли бы как сырьё I сорта', () => {
    expect(m.rows.some((r) => r.cells.some((c) => c?.id === ESSENCE_ID))).toBe(false);
    expect(m.essence).toMatchObject({ id: ESSENCE_ID, stash: 7, color: ESSENCE_HEX });
    expect(m.essence!.tip.join(' ')).toMatch(/магическая 1, редкая 2; в поле — 30 %/);
    expect(m.essence!.tip.join(' ')).toContain('Куда: зачарование скованной вещи и перекатка свойств');
    expect(m.rule).toBe(SALVAGE_RULE);
  });

  it('клетка — сундук и сумка; выключенный сорт — пустое место того же столбца, а не сдвиг строки', () => {
    const iron = m.rows.find((r) => r.family === 'iron')!;
    expect(iron.cells[0]).toMatchObject({ id: 'iron-1', stash: 40, hand: 0, have: true, grade: 1 });
    const r = new ConfigRegistry();
    r.loadAll();
    r.reload({ 'craft-materials': r.get('craft-materials').map((x) => (x.id === 'iron-2' ? { ...x, enabled: false } : x)) }, { cross: false });
    const off = materialsModel(r, {}, [materialItem(r.get('craft-materials').find((x) => x.id === 'iron-3')!, 5, 'st')]).rows.find((x) => x.family === 'iron')!;
    expect(off.cells.map((c) => c?.id ?? null)).toEqual(['iron-1', null, 'iron-3', 'iron-4', 'iron-5']);
    expect(off.cells[2]).toMatchObject({ hand: 5, have: true });
  });

  it('подсказка: семья и сорт, откуда, куда, где лежит, цена (D4 — всё продаётся); IV–V — только с найденных', () => {
    const hide4 = m.rows.find((r) => r.family === 'hide')!.cells[3]!;
    expect(hide4.tip).toEqual([
      'Кордован',
      'Кожа · IV сорт',
      'Откуда: разбор найденных вещей «Мастерский» (боевая часть), «Элитный»',
      'Купленные вещи и вещи прежней версии дают не выше III сорта',
      'Куда: ковка, подъём и починка — ступени «Мастерский», «Элитный»',
      'В сундуке 2',
      'Продажа: 10 за штуку',
    ]);
    const plate1 = m.rows.find((r) => r.family === 'plate')!.cells[0]!;
    expect(plate1.tip).toContain('Расходник любого подъёма и починки');
    expect(plate1.tip.some((l) => l.includes('ковкой не используется'))).toBe(true);
    expect(plate1.tip.some((l) => l.endsWith('тела монстров'))).toBe(true);
  });

  it('несомое — «+N» и строка «В сумке N — часть потеряешь при смерти»', () => {
    const st = materialItem(reg.get('craft-materials').find((x) => x.id === 'wood-3')!, 12, 'st');
    const wood3 = materialsModel(reg, {}, [st]).rows.find((r) => r.family === 'wood')!.cells[2]!;
    expect(wood3).toMatchObject({ stash: 0, hand: 12, have: true });
    expect(wood3.tip).toContain('В сумке 12 — часть потеряешь при смерти');
  });
});

describe('подсказка вещи — сырьё цветом сорта и строка происхождения (§15.3, §15.4)', () => {
  setItemLabelResolvers({
    armorClass: (id) => id, weight: (id) => id, physSub: (id) => id, skill: (id) => id,
    tierName: (id) => reg.get('item-tiers').find((t) => t.id === id)?.name,
    materialNote: (item) => materialNote(reg, item),
  });

  it('стопка сырья: имя цветом сорта, «семья · сорт», откуда, куда, цена', () => {
    const st = materialItem(reg.get('craft-materials').find((x) => x.id === 'iron-5')!, 3, 'st');
    const html = itemTooltipHtml(st);
    expect(html).toContain(`color:${GRADE_HEX[4]}`);
    expect(html).toContain('Железо · V сорт');
    expect(html).toContain('Продажа: 15 за штуку');
    expect(materialNote(reg, materialItem(reg.get('craft-materials').find((x) => x.id === ESSENCE_ID)!, 1, 'e'))?.color).toBe(ESSENCE_HEX);
  });

  it('купленная, поднятая кузнецом, вещь прежней версии — строкой; находка — молча', () => {
    const drop = itemFromBaseId(reg.get('items.base'), 'short-sword', reg.get('item-tiers'), 'drop')!;
    expect(itemTooltipHtml(drop)).not.toMatch(/Куплено|прежней версии|поднята кузнецом/);
    expect(itemTooltipHtml({ ...drop, origin: 'shop' })).toContain('Куплено в лавке');
    const old: Item = { ...drop };
    delete old.origin;
    expect(itemTooltipHtml(old)).toContain('Вещь из прежней версии');
    const up = upgradedItem(reg, drop)!;
    const was = reg.get('item-tiers').find((t) => t.id === drop.tier)!.name;
    expect(itemTooltipHtml(up)).toContain(`Ступень поднята кузнецом (была «${was}»)`);
  });
});
