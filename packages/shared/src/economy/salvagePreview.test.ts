import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { craftTiers, emptyJournal, salvageIntoJournal, shapeFoundWeapon, type CraftJournal } from '../formulas/craft.js';
import { generateItem } from '../formulas/itemgen.js';
import { createRng } from '../formulas/rng.js';
import { ESSENCE_ID } from '../formulas/salvage.js';
import { newCharacterSave } from './newCharacter.js';
import { itemOriginNote, salvageJournalGains, salvagePreview } from './salvagePreview.js';
import { STARTER_KNOWN, STARTER_FIELD, salvageRange, upgradedItem } from './townActions.js';
import type { Item } from '../types/items.js';

/**
 * ⭐ КАРТОЧКА РАЗБОРА — ЧЕТЫРЕ СТРОКИ ВСЕГДА (предложение «Разбор, сырьё и чары» §15.2): сырьё, эссенция, каталог, эскиз, и у нулевой строки —
 * причина. Жалоба владельца 06.10 («разобрал топор у кузнеца — детали не открылись») закрыта правилом D1: ЛЮБАЯ разобранная у кузнеца вещь
 * пополняет каталог, а карточка говорит это ДО разбора — ровно то, что сделает разбор (`salvageIntoJournal`, `salvageRange`).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const axe = (origin: Item['origin'], rarity: Item['rarity'] = 'magic', lvl = 3, seed = 3): Item => shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
  dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId: 'battle-axe', tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
  forceRarity: rarity, baseRoll: reg.get('balance').loot.baseRoll, origin,
}, createRng(seed)));

describe('salvageJournalGains — что добавит в каталог разбор у кузнеца', () => {
  it('найденный и КУПЛЕННЫЙ топор (и награда, и без происхождения) — тип, четыре детали, кодекс: каталог пишет любая вещь (D1)', () => {
    for (const origin of ['drop', 'shop', 'quest', undefined] as const) {
      const it = axe(origin);
      if (origin === undefined) delete it.origin;
      const g = salvageJournalGains(reg, it, emptyJournal());
      const u = salvageIntoJournal(reg, emptyJournal(), it);
      expect(u.unlocked, String(origin)).toHaveLength(4);
      expect(g.filter((x) => x.startsWith('деталь')).length, String(origin)).toBe(4);
      expect(g[0], String(origin)).toMatch(/^тип «/);
    }
  });

  it('всё уже в каталоге — пусто; журнала нет — как пустой; потолка ступени и мификов в строках нет (D3)', () => {
    const it = axe('chest');
    const j = salvageIntoJournal(reg, emptyJournal(), it).journal;
    expect(salvageJournalGains(reg, it, j)).toEqual([]);
    expect(salvageJournalGains(reg, it, null)).toEqual(salvageJournalGains(reg, it, emptyJournal()));
    for (const g of salvageJournalGains(reg, it, { ...j, tierHi: -1, mythic: 0 })) expect(g).not.toMatch(/ступень|мифик/);
  });

  it('броня — снаряжение в каталог; стартовый набор — его тип и детали', () => {
    const kit = newCharacterSave(reg, 'warrior', 't', 't');
    const w = kit.equipment.weapon!;
    expect(salvageJournalGains(reg, w, emptyJournal()).some((g) => g.startsWith('деталь'))).toBe(true);
    const chest = kit.equipment.chest!;
    expect(salvageJournalGains(reg, chest, emptyJournal())).toEqual([`снаряжение «${reg.get('items.base').find((b) => b.id === chest.baseId)!.name}»`]);
  });
});

describe('salvagePreview — карточка разбора: четыре строки, у нуля — причина', () => {
  it('найденный редкий топор у кузнеца: сырьё по ступени, эссенция 2, каталог с прогрессом класса, эскиз 1/8', () => {
    const it = axe('drop', 'rare', 31);
    const c = salvagePreview(reg, it, emptyJournal(), false);
    expect(c.ok).toBe(true);
    expect(c.verb).toBe('salvage');
    expect(c.title).toBe('Разобрать — вещь исчезнет');
    expect(c.range).toEqual(salvageRange(reg, it, false).range);
    expect(c.range[ESSENCE_ID]).toEqual({ min: 2, max: 2 });
    expect(c.essence).toMatchObject({ text: '+ 2', tone: 'gain' });
    expect(c.materials.text).toMatch(/^\+ /);
    expect(c.catalog?.tone).toBe('gain');
    expect(c.catalog?.text).toMatch(/\(топор: \d+ из \d+\)$/);
    expect(c.sketch?.text).toBe(`топор 1/${reg.get('balance').craft.journal.sketchAfter}`);
  });

  it('купленный: сырьё не выше III — сказано; эссенции нет — сказано почему; эскиз копят только находки', () => {
    const it = axe('shop', 'rare', 50);
    const c = salvagePreview(reg, it, emptyJournal(), false);
    expect(c.ok).toBe(true);
    expect(c.materials.text).toContain('вещь куплена — не выше III сорта');
    expect(c.essence).toMatchObject({ text: 'нет — вещь куплена', tone: 'warn' });
    expect(c.sketch?.text).toBe('копят только находки');
    expect(c.range[ESSENCE_ID]).toBeUndefined();
    for (const id of Object.keys(c.range)) expect(Number(id.split('-').pop())).toBeLessThanOrEqual(3);
    const old = { ...it };
    delete old.origin;
    expect(salvagePreview(reg, old, emptyJournal(), false).essence.text).toBe('нет — вещь из прежней версии');
  });

  it('всё в каталоге — строка «всё уже в каталоге (топор: N из M)», тон пояснения', () => {
    const it = axe('drop');
    const j: CraftJournal = salvageIntoJournal(reg, emptyJournal(), it).journal;
    const c = salvagePreview(reg, it, j, false);
    expect(c.catalog?.tone).toBe('dim');
    expect(c.catalog?.text).toMatch(/^всё из этой вещи уже в каталоге \(топор: \d+ из \d+\)$/);
  });

  it('в поле (D2): доля «≈ 0–1», строки каталога НЕТ; эскиз — только у кузнеца; подсказка «у кузнеца втрое больше» и что легло бы в каталог', () => {
    const it = axe('drop', 'rare', 31);
    const c = salvagePreview(reg, it, emptyJournal(), true);
    expect(c.ok).toBe(true);
    expect(c.title).toBe(`Разобрать здесь (${Math.round(reg.get('balance').salvage.fieldYield * 100)} %)`);
    expect(c.materials.text).toMatch(/^≈ /);
    expect(c.essence.text).toBe('≈ 0–1');
    expect(c.catalog, 'разбор в поле каталог не пишет — и строки нет').toBeNull();
    expect(c.sketch?.text).toMatch(/^копит только разбор у кузнеца/);
    expect(c.hint).toMatch(/^у кузнеца сырья и эссенции втрое больше, и в каталог легло бы: тип «/);
    // Всё уже в каталоге — подсказка про выход остаётся, про каталог — общая фраза.
    const j = salvageIntoJournal(reg, emptyJournal(), it).journal;
    expect(salvagePreview(reg, it, j, true).hint).toBe('у кузнеца сырья и эссенции втрое больше, и вещь попала бы в каталог');
    // Обычная низкая вещь, чей каталог уже открыт, — без подсказки: разница копеечная.
    const plain = axe('drop', 'normal', 3);
    expect(salvagePreview(reg, plain, salvageIntoJournal(reg, emptyJournal(), plain).journal, true).hint).toBeUndefined();
  });

  it('стартовый набор: сырья нет — сказано; у второго героя — отказ ДО нажатия; в поле — отказ', () => {
    const w = newCharacterSave(reg, 'warrior', 't', 't').equipment.weapon!;
    const first = salvagePreview(reg, w, emptyJournal(), false);
    expect(first.ok).toBe(true);
    expect(first.materials.text).toBe('сырья нет — стартовый набор бесплатный');
    expect(first.essence.text).toBe('нет — стартовый набор');
    const known = salvageIntoJournal(reg, emptyJournal(), w).journal;
    expect(salvagePreview(reg, w, known, false)).toMatchObject({ ok: false, reason: STARTER_KNOWN });
    expect(salvagePreview(reg, w, emptyJournal(), true)).toMatchObject({ ok: false, reason: STARTER_FIELD });
  });

  it('поднятый кузнецом: сырьё «как у вещи <исходная ступень>»', () => {
    const it = axe('drop', 'normal', 31);
    const up = upgradedItem(reg, it)!;
    expect(up.bornTier).toBe(it.tier);
    const c = salvagePreview(reg, up, emptyJournal(), false);
    const born = craftTiers(reg).find((t) => t.id === it.tier)!;
    expect(c.materials.text).toContain(`как у вещи «${born.name}»: ступень поднята кузнецом`);
    expect(c.range).toEqual(salvageRange(reg, it, false).range);
  });

  it('строка происхождения подсказки (§15.3): у всего, что не находка; находка и сырьё — молча', () => {
    const name = (id: string): string | undefined => craftTiers(reg).find((t) => t.id === id)?.name;
    const it = axe('drop', 'magic', 31);
    expect(itemOriginNote(it, name)).toBeNull();
    expect(itemOriginNote({ ...it, origin: 'chest' }, name)).toBeNull();
    expect(itemOriginNote({ ...it, origin: 'shop' }, name)).toBe('Куплено в лавке');
    expect(itemOriginNote({ ...it, origin: 'quest' }, name)).toBe('Награда за задание');
    expect(itemOriginNote({ ...it, origin: 'start' }, name)).toBe('Стартовый набор');
    expect(itemOriginNote({ ...it, origin: 'craft' }, name)).toBe('Скована кузнецом');
    const old = { ...it };
    delete old.origin;
    expect(itemOriginNote(old, name)).toBe('Вещь из прежней версии');
    const up = upgradedItem(reg, it)!;
    expect(itemOriginNote(up, name)).toBe(`Ступень поднята кузнецом (была «${name(it.tier!)}»)`);
    expect(itemOriginNote({ ...upgradedItem(reg, { ...it, origin: 'shop' })! }, name)).toBe(`Куплено в лавке · ступень поднята кузнецом (была «${name(it.tier!)}»)`);
    expect(itemOriginNote({ ...it, tierForged: true }, name), 'поднята до учёта исходной ступени').toBe('Ступень поднята кузнецом');
    expect(itemOriginNote({ ...it, kind: 'material', origin: 'shop' }, name)).toBeNull();
  });

  it('уникальное — отказ с причиной; строки всё равно заполнены', () => {
    const it = { ...axe('drop'), rarity: 'unique' as const };
    const c = salvagePreview(reg, it, emptyJournal(), false);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/Уникальные вещи не разбираются/);
    expect(c.materials.label).toBe('Сырьё');
  });
});
