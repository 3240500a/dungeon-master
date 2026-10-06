import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { emptyJournal, salvageIntoJournal, shapeFoundWeapon, type CraftJournal } from '../formulas/craft.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { newCharacterSave } from './newCharacter.js';
import { salvageJournalGains, salvageJournalPreview } from './salvagePreview.js';
import type { Item } from '../types/items.js';

/**
 * ⭐ РАЗБЕРЁШЬ — ЧТО ОТКРОЕТСЯ (жалоба владельца 06.10: «разобрал топор у кузнеца — детали не открылись»). Топор был не найден, а детали
 * открывает только найденное (`countsAsFind`) — правило верное, но невидимое. Строка карточки обязана сказать это ДО разбора и сказать
 * ровно то, что сделает разбор (`salvageIntoJournal`).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const axe = (origin: Item['origin'], seed = 3): Item => shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
  dropBias: 1, itemLevel: 3, tierLevel: 3, baseId: 'battle-axe', tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
  forceRarity: 'magic', baseRoll: reg.get('balance').loot.baseRoll, origin,
}, createRng(seed)));

describe('salvageJournalPreview — строка разбора у кузнеца', () => {
  it('найденный топор: тип и четыре детали — те же, что откроет разбор', () => {
    const it = axe('drop');
    const p = salvageJournalPreview(reg, it, emptyJournal());
    const u = salvageIntoJournal(reg, emptyJournal(), it);
    expect(p.kind).toBe('found');
    expect(u.unlocked).toHaveLength(4);
    expect(p.gains.filter((g) => g.startsWith('деталь')).length).toBe(4);
    expect(p.line.startsWith('Откроет: тип «')).toBe(true);
    expect(p.tone).toBe('gain');
  });

  it('купленный топор: детали не откроются, откроется только тип — и разбор правда не открывает деталей', () => {
    const it = axe('shop');
    const p = salvageJournalPreview(reg, it, emptyJournal());
    expect(salvageIntoJournal(reg, emptyJournal(), it).unlocked).toEqual([]);
    expect(p.kind).toBe('typeOnly');
    expect(p.why).toBe('вещь куплена');
    expect(p.line).toMatch(/^Детали не откроются: вещь куплена, а детали открывает только найденное \(с монстра, из сундука, с босса\)\. Откроется только тип «/);
    expect(p.tone).toBe('warn');
  });

  it('топор без происхождения (сейв старше поля) и награда — тоже без деталей; тип уже открыт — строка без «откроется»', () => {
    const none = axe('drop'); delete none.origin;
    const known: CraftJournal = { ...emptyJournal(), bases: ['battle-axe'], tierHi: 9 };
    expect(salvageJournalPreview(reg, none, known)).toMatchObject({ kind: 'typeOnly', why: 'вещь без происхождения (из старого сейва)', gains: [] });
    expect(salvageJournalPreview(reg, none, known).line).not.toContain('Откроется');
    expect(salvageJournalPreview(reg, axe('quest'), emptyJournal()).why).toBe('вещь — награда за задание');
  });

  it('всё из найденного уже открыто — «известно»; журнала нет — как пустой', () => {
    const it = axe('chest');
    const j = salvageIntoJournal(reg, emptyJournal(), it).journal;
    expect(salvageJournalPreview(reg, it, j)).toMatchObject({ kind: 'known', gains: [], tone: 'dim' });
    expect(salvageJournalPreview(reg, it, null)).toEqual(salvageJournalPreview(reg, it, emptyJournal()));
    expect(salvageJournalGains(reg, it, null)).toEqual(salvageJournalPreview(reg, it, null).gains);
  });

  it('стартовый набор и броня — молчать (разбор запрещён / журнал не про них)', () => {
    const kit = newCharacterSave(reg, 'warrior', 't', 't');
    for (const it of Object.values(kit.equipment)) if (it) expect(salvageJournalPreview(reg, it, emptyJournal()).kind).toBe('none');
  });
});
