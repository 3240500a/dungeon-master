import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, fullJournal, keySlotOf, keyVariantsByBase, newBotSave, variantsFor, CRAFT_SLOT_LIST,
  type CraftJournal, type WeaponPart,
} from '@dm/shared';
import { craftWindow, initialCraftState, type CraftHost, type CraftReply } from './craftPanel.js';

/**
 * ⭐ R3-11: ЭСКИЗ ТРАТИТСЯ В ОКНЕ КОВКИ. Разбор обещал «эскиз — деталь на выбор», журнал их копил, а окна, где их
 * потратить, не было. Теперь окно показывает, сколько эскизов, закрытую деталь ОТКРЫТОГО типа делает кликабельной (✦),
 * а трата — после подтверждения (эскиз не вернуть) и командой хозяина. Ключевую форму неоткрытого типа эскиз не
 * открывает — такая строка остаётся запертой (🔒).
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
  text(): string { return [this.html, this.textContent, ...this.all().map((c) => `${c.html} ${c.textContent}`)].join(' | '); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
  /** Строка списка деталей по имени детали (её разметка — в innerHTML). */
  row(name: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.innerHTML.includes(`${name}</span>`)); }
}

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const keySlot = keySlotOf(reg, 'sword');
/** Закрытая к эскизу деталь — не ключевая: её тип знать не нужно. */
const target: WeaponPart = variantsFor(reg, 'sword', CRAFT_SLOT_LIST.find((s) => s !== keySlot)!, 1).at(-1)!;
const groups = keyVariantsByBase(reg, 'sword', 1);

function setup(sketches: number, opts: { withSketch?: boolean; closedBase?: string } = {}) {
  const full = fullJournal(reg);
  let journal: CraftJournal = {
    ...full, sketches,
    // Закрытый тип — закрыт честно: ни базы, ни её ключевых форм в журнале.
    variants: full.variants.filter((v) => v !== target.id && !groups.find((g) => g.baseId === opts.closedBase)?.variants.some((p) => p.id === v)),
    bases: full.bases.filter((b) => b !== opts.closedBase),
  };
  const save = newBotSave(reg, 'warrior');
  const calls: string[] = [];
  const host: CraftHost = {
    wallet: () => ({}), gold: () => 0, journal: () => journal, save: () => save,
    craft: () => ({ ok: false, reason: 'не в этом тесте' }), enchant: () => ({ ok: false, reason: 'не в этом тесте' }),
  };
  if (opts.withSketch !== false) {
    host.sketch = vi.fn((id: string): CraftReply => {
      calls.push(id);
      journal = { ...journal, variants: [...journal.variants, id], sketches: journal.sketches - 1 };
      return { ok: true };
    });
  }
  const st = initialCraftState(reg, 'sword', 1);
  const app = { config: reg } as never;
  const root = craftWindow(app, host, st) as unknown as El;
  return { root, st, host, calls };
}

describe('⚠ R3-11: окно ковки тратит эскиз', () => {
  const G = globalThis as unknown as { document?: unknown };
  beforeEach(() => { G.document = { createElement: (t: string) => new El(t), body: new El('body') }; });
  afterEach(() => { delete G.document; });

  it('⭐ эскиз есть — окно его показывает; закрытая деталь кликабельна (✦); трата — после подтверждения, одной командой', () => {
    const { root, st, calls } = setup(1);
    expect(root.text()).toContain('Эскизов: 1');
    const row = root.row(target.name)!;
    expect(row, 'строка детали в списке').toBeDefined();
    expect(row.innerHTML).toContain(`✦ ${target.name}`);
    expect(row.disabled, 'закрытая, но открываемая эскизом — не погашена').toBe(false);
    row.click();
    expect(calls, 'клик по строке эскиз не тратит — только выбирает').toEqual([]);
    expect(st.sketchPick).toBe(target.id);
    expect(root.text()).toContain(`Открыть «${target.name}» эскизом?`);
    root.button('Открыть эскизом')!.click();
    expect(calls).toEqual([target.id]);
    expect(st.sketchPick).toBeUndefined();
    expect(st.message).toBe(`Открыто эскизом: ${target.name}`);
    expect(root.text(), 'эскизов не осталось — плашки нет').not.toContain('Эскизов:');
    expect(root.row(target.name)!.innerHTML, 'деталь открыта').not.toContain('✦');
  });

  it('«Отмена» ничего не тратит', () => {
    const { root, st, calls } = setup(2);
    root.row(target.name)!.click();
    root.button('Отмена')!.click();
    expect(st.sketchPick).toBeUndefined();
    expect(calls).toEqual([]);
    expect(root.text()).toContain('Эскизов: 2');
  });

  it('эскизов нет или хозяин эскизы не тратит — закрытая деталь заперта (🔒), плашки нет', () => {
    for (const s of [setup(0), setup(3, { withSketch: false })]) {
      expect(s.root.text()).not.toContain('Эскизов:');
      const row = s.root.row(target.name)!;
      expect(row.innerHTML).toContain(`🔒 ${target.name}`);
      expect(row.disabled).toBe(true);
    }
  });

  it('⭐ ключевая форма НЕОТКРЫТОГО типа эскизом не открывается — строка заперта и при эскизах', () => {
    const closed = groups.find((g) => g.variants.length > 0 && g.baseId !== groups[0]!.baseId)!;
    const { root } = setup(3, { closedBase: closed.baseId });
    let seen = 0;
    for (const p of closed.variants) {
      const row = root.row(p.name);
      if (!row) continue;   // одно имя может встречаться в нескольких типах — проверяем то, что видно
      expect(row.innerHTML, p.id).toContain(`🔒 ${p.name}`);
      expect(row.disabled, p.id).toBe(true);
      seen++;
    }
    expect(seen, 'сторож видит формы закрытого типа').toBeGreaterThan(0);
    expect(root.text(), 'эскизы при этом есть').toContain('Эскизов: 3');
  });
});
