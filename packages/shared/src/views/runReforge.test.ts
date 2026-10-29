import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import type { AccountStash } from '../types/stash.js';
import { createRng } from '../formulas/rng.js';
import { SEAL_REFORGE_FEW, canReforgeSeals, reforgeSeals } from '../economy/seals.js';
import { sealReforge } from '../economy/townActions.js';
import { RUN_REFORGE_TEXT, runReforgeHead, runReforgeTake, runReforgeView, type RunReforgeModel } from './runReforge.js';

/**
 * ⭐⭐ С-views (29.10): ВКЛАДКА «🔮 Печати» — случаи `ReforgeCheck.cs` Unity на виде сервера, плюс ВЫБОР ПЕЧАТЕЙ СЕРВЕРОМ
 * (`runReforgeTake` вместо `SealReforgeView.Take` клиента): связка, которую он собирает, ядро принимает как есть.
 */

type Raw = Record<string, unknown>;
const BASE = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.snapshot() as unknown as Raw; })();

/** Стенд `ReforgeCheck.Cfg(...)`: два вида, лестница из трёх ступеней с порогами глубины, перековка «три в одну». */
function cfg(mode: 'sameKind' | 'sameTier' = 'sameTier', o: { on?: boolean; goldCost?: number; gate?: boolean; patch?: (c: Raw) => void } = {}): ConfigRegistry {
  const c = structuredClone(BASE);
  c['run-mod-stats'] = [
    { id: 'packSize', name: 'Размер пачки', enabled: true, cap: 2.4 },
    { id: 'itemRolls', name: 'Число вещей', enabled: true, cap: 1.8 },
    { id: 'monsterHp', name: 'Жизнь монстров', enabled: true, cap: 3 },
    { id: 'xp', name: 'Опыт', enabled: true, cap: 2.4 },
  ];
  c.seals = [
    { id: 'swarming', name: 'Кишащий', danger: { stat: 'packSize', value: 0.2 }, reward: { stat: 'itemRolls', value: 0.15 } },
    { id: 'enduring', name: 'Стойкие', danger: { stat: 'monsterHp', value: 0.25 }, reward: { stat: 'xp', value: 0.2 } },
  ];
  const b = c.balance as Raw;
  b.seals = {
    ...(b.seals as Raw), enabled: o.on ?? true, stackMax: 20,
    tiers: [{ id: 't1', name: 'I', mul: 1, minDepth: 1 }, { id: 't2', name: 'II', mul: 2.2, minDepth: 8 }, { id: 't3', name: 'III', mul: 4, minDepth: 16 }],
    reroll: { enabled: true, goldCost: 400, differs: true },
    reforge: { enabled: true, need: 3, mode, goldCost: o.goldCost ?? 0, gateByRecord: o.gate ?? true },
  };
  o.patch?.(c);
  const r = new ConfigRegistry();
  r.loadAll(c, { cross: false });
  return r;
}

let uidN = 0;
const seal = (sealId: string, sealTier: string, count: number): Item => ({ uid: `s${uidN++}`, kind: 'seal', sealId, sealTier, count } as unknown as Item);
/** Сейв `ReforgeCheck.Save(record, gold, seals…)`. */
function save(record: number, gold: number, ...seals: [string, string, number][]): SaveState {
  return {
    version: 1, name: 'Стенд', charId: 'c1', createdAt: 0, classId: 'warrior', level: 10, xp: 0, gold,
    attributes: { strength: 0, dexterity: 0, intelligence: 0, vitality: 0 }, unspentAttributePoints: 0, unspentSkillPoints: 0,
    unspentMasteryPoints: 0, skills: {}, masteries: {}, equipment: {}, inventory: seals.map(([k, t, n]) => seal(k, t, n)), stash: [], belt: [],
    mouseLeft: null, mouseRight: null, hotbar: [], quests: [], activeQuestDefs: [], maxDepth: 0,
    difficultyProgress: record > 0 ? { normal: record } : {}, lastDifficulty: 'normal',
  } as SaveState;
}
const stashOf = (...tabs: [string, string, number][][]): AccountStash => ({ version: 1, tabs: tabs.map((t) => t.map(([k, s, n]) => seal(k, s, n))) } as unknown as AccountStash);
const find = (m: RunReforgeModel, key: string) => m.cards.find((c) => c.key === key);

const FIELDS = {
  ReforgeModelView: ['note', 'need', 'off', 'cards', 'rerollOff', 'rerollNote', 'rerolls'],
  ReforgeCard: ['key', 'keys', 'name', 'result', 'reason', 'carried', 'need', 'can'],
  RerollCard: ['key', 'name', 'reason', 'carried', 'gold', 'can'],
};
function shape(m: RunReforgeModel): RunReforgeModel {
  expect(Object.keys(m)).toEqual(FIELDS.ReforgeModelView);
  for (const c of m.cards) expect(Object.keys(c)).toEqual(FIELDS.ReforgeCard);
  for (const c of m.rerolls) expect(Object.keys(c)).toEqual(FIELDS.RerollCard);
  expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  return m;
}

describe('С-views: вкладка перековки (ReforgeCheck)', () => {
  it('целевая (sameKind): карточка на пару; три — можно с результатом; две — причина словами', () => {
    const m = shape(runReforgeView(cfg('sameKind'), save(40, 0, ['swarming', 't1', 3], ['enduring', 't1', 2]), null));
    expect(m.cards.length).toBe(2);
    expect(find(m, 'swarming@t1')).toEqual({ key: 'swarming@t1', keys: ['swarming@t1'], name: 'Кишащий I', result: '→ II', reason: null, carried: 3, need: 3, can: true });
    expect(find(m, 'enduring@t1')).toEqual({ key: 'enduring@t1', keys: ['enduring@t1'], name: 'Стойкие I', result: '→ II', reason: 'Печатей не хватает: нужно 3', carried: 2, need: 3, can: false });
    expect(m.note).toBe(RUN_REFORGE_TEXT.noteKind);
    expect(m.cards.map((c) => c.name)).toEqual(['Кишащий I', 'Стойкие I']);
  });

  it('ворота ступени по рекорду; ручка gateByRecord их снимает', () => {
    expect(find(runReforgeView(cfg('sameKind'), save(7, 0, ['swarming', 't1', 3]), null), 'swarming@t1')).toMatchObject({ can: false, reason: RUN_REFORGE_TEXT.deep });
    expect(find(runReforgeView(cfg('sameKind'), save(8, 0, ['swarming', 't1', 3]), null), 'swarming@t1')!.can).toBe(true);
    expect(find(runReforgeView(cfg('sameKind', { gate: false }), save(0, 0, ['swarming', 't1', 3]), null), 'swarming@t1')!.can).toBe(true);
  });

  it('⚠ порядок отказов — как у сервера: мелкий рекорд называется РАНЬШЕ нехватки (окно Unity говорило «не хватает»)', () => {
    const card = find(runReforgeView(cfg('sameKind'), save(7, 0, ['swarming', 't1', 2]), null), 'swarming@t1')!;
    expect(card.reason).toBe(RUN_REFORGE_TEXT.deep);
    // а сервер на такую заявку отвечает именно воротами
    const r = cfg('sameKind');
    const s = save(7, 0, ['swarming', 't1', 2]);
    expect(canReforgeSeals(r, s.inventory, { 'swarming@t1': 2 }, 0, 7)).toEqual({ ok: false, reason: RUN_REFORGE_TEXT.deep });
  });

  it('конец лестницы, пошлина, тумблер, пустая сумка', () => {
    expect(find(runReforgeView(cfg('sameKind'), save(100, 0, ['swarming', 't3', 3]), null), 'swarming@t3')).toMatchObject({ can: false, reason: RUN_REFORGE_TEXT.top, result: null });
    expect(find(runReforgeView(cfg('sameKind', { goldCost: 300 }), save(40, 299, ['swarming', 't1', 3]), null), 'swarming@t1')!.reason).toBe(RUN_REFORGE_TEXT.gold);
    expect(find(runReforgeView(cfg('sameKind', { goldCost: 300 }), save(40, 300, ['swarming', 't1', 3]), null), 'swarming@t1')!.can).toBe(true);
    const off = shape(runReforgeView(cfg('sameKind', { on: false }), save(40, 0, ['swarming', 't1', 3]), null));
    expect(off).toEqual({ note: RUN_REFORGE_TEXT.off, need: 3, off: true, cards: [], rerollOff: false, rerollNote: null, rerolls: [] });
    const empty = runReforgeView(cfg('sameKind'), save(40, 0), null);
    expect([empty.cards.length, empty.note]).toEqual([0, RUN_REFORGE_TEXT.empty]);
  });

  it('sameTier: карточка на СТУПЕНЬ (ключ «ступень|привязка»), считает все виды, перечисляет ключи', () => {
    const m = shape(runReforgeView(cfg('sameTier'), save(40, 0, ['swarming', 't1', 2], ['enduring', 't1', 1], ['swarming', 't2', 1]), null));
    expect(m.cards.length).toBe(2);
    expect(find(m, 't1|')).toEqual({ key: 't1|', keys: ['swarming@t1', 'enduring@t1'], name: 'Любые печати I', result: '→ II', reason: null, carried: 3, need: 3, can: true });
    expect(find(m, 't2|')!.can).toBe(false);
    expect(m.note).toBe(RUN_REFORGE_TEXT.noteTier);
  });

  it('запас = сумка + сундук; сундук не загрузился — шапка говорит это строкой', () => {
    const r = cfg('sameKind');
    const bagOnly = save(40, 0, ['swarming', 't1', 1]);
    expect(find(runReforgeView(r, bagOnly, null), 'swarming@t1')!.can).toBe(false);
    const st = stashOf([['swarming', 't1', 2]]);
    const card = find(runReforgeView(r, bagOnly, st), 'swarming@t1')!;
    expect([card.carried, card.can]).toEqual([3, true]);
    expect(runReforgeHead(r, runReforgeView(r, bagOnly, null), false)).toEqual({ fee: null, feeGold: 0, source: RUN_REFORGE_TEXT.noStash });
    expect(runReforgeHead(r, runReforgeView(r, bagOnly, st), true)).toEqual({ fee: null, feeGold: 0, source: RUN_REFORGE_TEXT.source });
    const paid = cfg('sameKind', { goldCost: 300 });
    expect(runReforgeHead(paid, runReforgeView(paid, save(40, 0), stashOf([])), true)).toEqual({ fee: 'Пошлина кузнеца: 300 золота', feeGold: 300, source: null });
    expect(runReforgeHead(paid, runReforgeView(paid, save(40, 0), st), true)).toEqual({ fee: 'Пошлина кузнеца: 300 золота', feeGold: 300, source: RUN_REFORGE_TEXT.source });
  });

  it('привязка к биому — отдельные карточки, каждая считает только своё', () => {
    const r = cfg('sameTier', { patch: (c) => { (c.seals as Raw[])[0]!.biomes = ['crypt']; } });
    const m = runReforgeView(r, save(40, 0, ['swarming', 't1', 3], ['enduring', 't1', 3]), null);
    expect(m.cards.length).toBe(2);
    expect(find(m, 't1|crypt')).toMatchObject({ carried: 3, can: true, name: 'Печати I (crypt)' });
    expect(find(m, 't1|')).toMatchObject({ carried: 3, can: true, name: 'Любые печати I' });
  });

  it('перекат: карточка на пару, пошлина × множитель ступени, отказы словами', () => {
    const m = shape(runReforgeView(cfg('sameTier'), save(40, 10000, ['swarming', 't1', 1], ['enduring', 't2', 1]), null));
    expect(m.rerolls).toEqual([
      { key: 'swarming@t1', name: 'Кишащий I', reason: null, carried: 1, gold: 400, can: true },
      { key: 'enduring@t2', name: 'Стойкие II', reason: null, carried: 1, gold: 880, can: true },
    ]);
    expect(m.rerollNote).toBe(RUN_REFORGE_TEXT.rerollNote);
    const poor = runReforgeView(cfg('sameTier'), save(40, 399, ['swarming', 't1', 1]), null);
    expect(poor.rerolls).toEqual([{ key: 'swarming@t1', name: 'Кишащий I', reason: RUN_REFORGE_TEXT.gold, carried: 1, gold: 400, can: false }]);
    const solo = runReforgeView(cfg('sameTier', { patch: (c) => { (c.seals as Raw[])[1]!.enabled = false; } }), save(40, 10000, ['swarming', 't1', 1]), null);
    expect(solo.rerolls.map((x) => x.reason)).toEqual([RUN_REFORGE_TEXT.rerollAlone]);
    const off = runReforgeView(cfg('sameTier', { patch: (c) => { (((c.balance as Raw).seals as Raw).reroll as Raw).enabled = false; } }), save(40, 10000, ['swarming', 't1', 1]), null);
    expect([off.rerollOff, off.rerolls.length, off.rerollNote]).toEqual([true, 0, RUN_REFORGE_TEXT.rerollOff]);
    const byBiome = runReforgeView(cfg('sameTier', { patch: (c) => { (c.seals as Raw[])[0]!.biomes = ['crypt']; } }), save(40, 10000, ['swarming', 't1', 1]), null);
    expect(byBiome.rerolls.map((x) => x.reason)).toEqual([RUN_REFORGE_TEXT.rerollAlone]);
  });
});

describe('С-views: КАКИЕ ПЕЧАТИ СЖЕЧЬ — решает сервер (runReforgeTake вместо SealReforgeView.Take)', () => {
  it('sameTier: набирает ровно need по порядку карточки — сначала сумка, потом сундук', () => {
    const r = cfg('sameTier');
    const s = save(40, 0, ['swarming', 't1', 2], ['enduring', 't1', 5]);
    expect(runReforgeTake(r, s, null, 't1|')).toEqual({ 'swarming@t1': 2, 'enduring@t1': 1 });
    const bagLight = save(40, 0, ['enduring', 't1', 1]);
    expect(runReforgeTake(r, bagLight, stashOf([['swarming', 't1', 4]]), 't1|')).toEqual({ 'enduring@t1': 1, 'swarming@t1': 2 });
  });

  it('связка сервера проходит ядро как есть — и перековка исполняется', () => {
    const r = cfg('sameTier');
    const s = save(40, 0, ['swarming', 't1', 2], ['enduring', 't1', 1]);
    const picks = runReforgeTake(r, s, null, 't1|')!;
    expect(canReforgeSeals(r, s.inventory, picks, s.gold, 40).ok).toBe(true);
    const res = reforgeSeals(r, s.inventory, picks, s.gold, { cols: 10, rows: 6 }, createRng(7), () => 'new', 40);
    expect(res.ok && res.item.sealTier).toBe('t2');
    // и через команду города (как зовёт `Room.handleCmd`): тот же исход
    const st = save(40, 0, ['swarming', 't1', 2], ['enduring', 't1', 1]);
    const out = sealReforge(r, st, null, runReforgeTake(r, st, null, 't1|')!, createRng(9));
    expect(out.ok).toBe(true);
  });

  it('карточка, которую не собрать, — null (сервер ответит «не хватает»), чужая привязка и режим не подмешиваются', () => {
    const r = cfg('sameTier', { patch: (c) => { (c.seals as Raw[])[0]!.biomes = ['crypt']; } });
    const s = save(40, 0, ['swarming', 't1', 3], ['enduring', 't1', 2]);
    expect(runReforgeTake(r, s, null, 't1|crypt')).toEqual({ 'swarming@t1': 3 });
    expect(runReforgeTake(r, s, null, 't1|')).toBeNull();
    expect(runReforgeTake(r, s, null, 'swarming@t1')).toBeNull();   // ключ режима sameKind в режиме sameTier
    expect(runReforgeTake(r, s, null, 'мусор')).toBeNull();
    expect(SEAL_REFORGE_FEW).toBe(RUN_REFORGE_TEXT.few);
  });

  it('sameKind: карточка «вид@ступень» — need штук этой пары (сумка + сундук)', () => {
    const r = cfg('sameKind');
    const s = save(40, 0, ['swarming', 't1', 1]);
    expect(runReforgeTake(r, s, stashOf([['swarming', 't1', 5]]), 'swarming@t1')).toEqual({ 'swarming@t1': 3 });
    expect(runReforgeTake(r, s, null, 'swarming@t1')).toBeNull();
    expect(runReforgeTake(r, s, null, 't1|')).toBeNull();
    expect(runReforgeTake(cfg('sameKind', { on: false }), s, stashOf([['swarming', 't1', 5]]), 'swarming@t1')).toBeNull();
  });
});
