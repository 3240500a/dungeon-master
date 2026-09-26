import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { emptyJournal, keyVariantsByBase, normalizeJournal, salvageIntoJournal, shapeFoundWeapon, sketchable, variantsFor } from '../formulas/craft.js';
import { keySlotOf } from '../formulas/craftType.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { forgeSalvage, sketchAction } from './townActions.js';
import { emptyStash } from './stashActions.js';
import type { AccountStash } from '../types/stash.js';
import type { CraftJournal } from '../formulas/craft.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R3-11: ЭСКИЗ ТРАТИТСЯ. Жалость разбора (§12: каждые `sketchAfter` разборов класса — эскиз, «деталь на выбор»)
 * копилась в журнале, окно разбора её обещало, а потратить было нечем: ни команды, ни окна. Без траты жалость не режет
 * хвост ожидания редкой детали (95-й перцентиль 36 ч → ≈ 6 ч), ради которого и заведена.
 *
 * `sketchAction` — одно ядро на сервер (`forgeSketch`) и мост калькулятора: все отказы ДО изменения журнала.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const MAX = { int: (_a: number, b: number) => b, chance: () => true };
const swordBase = reg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && b.enabled !== false)!;

/** Сундук, в котором разобраны `n` найденных мечей одной базы (жалость копится честно, через разбор). */
function salvaged(n: number): AccountStash {
  const stash = emptyStash(reg);
  for (let i = 0; i < n; i++) {
    const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 5 + i, baseId: swordBase.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
      forceRarity: 'normal', maxReqTotal: reg.get('balance').maxTotalRequirement, origin: 'drop',
    }, createRng(100 + i)));
    const save = { gold: 0, inventory: [{ ...it, pos: null }] } as unknown as SaveState;
    expect(forgeSalvage(reg, save, stash, it.uid, MAX).ok).toBe(true);
  }
  return stash;
}
/** Закрытая деталь, которую эскиз открыть может (не ключевая — её класс не важен). */
const openable = (j: CraftJournal): string => reg.get('weapon-parts').find((p) => p.enabled !== false && sketchable(reg, j, p.id))!.id;

describe('⚠ R3-11: эскиз — открыть деталь на выбор (`sketchAction`)', () => {
  it('⭐ восемь разборов класса → эскиз; тратится на закрытую деталь: деталь открыта, эскизов на один меньше', () => {
    const k = reg.get('balance').craft.journal;
    const stash = salvaged(k.sketchAfter);
    const j0 = normalizeJournal(stash.forgeJournal);
    expect(j0.sketches, 'жалость дала эскиз').toBe(1);
    const id = openable(j0);
    const r = sketchAction(reg, stash, id);
    expect(r.ok, r.reason).toBe(true);
    expect(r.unlocked?.[0]).toMatch(/Деталь/);
    const j1 = normalizeJournal(stash.forgeJournal);
    expect(j1.variants).toContain(id);
    expect(j1.sketches).toBe(0);
    expect({ ...j1, variants: j0.variants, sketches: j0.sketches }, 'прочее в журнале не тронуто').toEqual(j0);
  });

  it('⭐ отказы — ДО изменения: эскизов нет, деталь уже открыта, ключевая форма неоткрытого типа, выключенная, чужой id', () => {
    const base = keyVariantsByBase(reg, 'sword', 1)[0]!;
    const other = keyVariantsByBase(reg, 'sword', 1).find((g) => g.baseId !== base.baseId)!;
    const nonKey = variantsFor(reg, 'sword', (['strike', 'grip', 'bind', 'head'] as const).find((s) => s !== keySlotOf(reg, 'sword'))!, 1)[0]!;
    const journal = (sketches: number): CraftJournal => ({ ...emptyJournal(), bases: [base.baseId], variants: [nonKey.id], tierHi: 0, sketches });
    const cases: [string, CraftJournal, unknown, RegExp][] = [
      ['эскизов нет', journal(0), openable(journal(1)), /Эскизов нет/],
      ['уже открыта', journal(2), nonKey.id, /уже открыт/],
      ['ключевая форма неоткрытого типа', journal(2), other.variants[0]!.id, /не открыть/],
      ['нет такой детали', journal(2), 'нет-такой-детали', /Нет такой детали/],
      ['не строка', journal(2), 42, /Нет такой детали/],
    ];
    for (const [why, j, id, reason] of cases) {
      const stash: AccountStash = { ...emptyStash(reg), forgeJournal: structuredClone(j) };
      const before = JSON.stringify(stash);
      const r = sketchAction(reg, stash, id);
      expect(r.ok, why).toBe(false);
      expect(r.reason, why).toMatch(reason);
      expect(JSON.stringify(stash), `${why}: сундук байт в байт`).toBe(before);
    }
    // Ключевая форма ОТКРЫТОГО типа — можно: тип уже знают, форма — деталь как деталь.
    const own = base.variants.find((v) => v.enabled !== false)!;
    const stash: AccountStash = { ...emptyStash(reg), forgeJournal: journal(1) };
    expect(sketchAction(reg, stash, own.id).ok).toBe(true);
  });

  it('выключенную деталь эскиз не открывает: он пропал бы зря — ковать из неё нельзя', () => {
    const r2 = new ConfigRegistry();
    r2.loadAll();
    const parts = structuredClone(r2.get('weapon-parts'));
    const j: CraftJournal = { ...emptyJournal(), sketches: 1 };
    const target = parts.find((p) => p.enabled !== false && sketchable(r2, j, p.id))!;
    target.enabled = false;
    r2.reload({ 'weapon-parts': parts });
    expect(sketchable(r2, j, target.id)).toBe(false);
    const stash: AccountStash = { ...emptyStash(r2), forgeJournal: structuredClone(j) };
    const before = JSON.stringify(stash);
    expect(sketchAction(r2, stash, target.id).ok).toBe(false);
    expect(JSON.stringify(stash)).toBe(before);
  });

  it('журнал без поля или битый — нормализуется, эскизов у него нет', () => {
    for (const raw of [undefined, null, { sketches: -3 }, { sketches: 'много' }, []]) {
      const stash = { ...emptyStash(reg), forgeJournal: raw } as unknown as AccountStash;
      expect(sketchAction(reg, stash, openable({ ...emptyJournal(), sketches: 1 })).reason, JSON.stringify(raw)).toMatch(/Эскизов нет/);
    }
  });

  it('разбор, доведший счёт до эскиза, говорит о нём строкой — эскиз теперь есть на что потратить', () => {
    const j: CraftJournal = { ...emptyJournal(), classSalvages: { sword: reg.get('balance').craft.journal.sketchAfter - 1 } };
    const it = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 5, baseId: swordBase.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
      forceRarity: 'normal', maxReqTotal: reg.get('balance').maxTotalRequirement, origin: 'drop',
    }, createRng(7)));
    expect(salvageIntoJournal(reg, j, it).sketch).toBe(true);
  });
});
