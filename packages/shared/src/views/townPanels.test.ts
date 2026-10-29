/**
 * Виды города ⇄ эталон панелей Unity (`unity_panels.json`, PanelsCheck.cs): реестр — из снимка `config` эталона, каждый кейс разделов
 * `items` (верстак в трёх кошельках, подпись предпросмотра, глиф, вопросы, «что добавил бы в каталог»), `menu`, `materials`, `sockets`,
 * `prices`, `attrs.respec`, `quests`, `bind` — до буквы. Отличия от эталона (вид шлёт больше полей) — сняты явно и перечислены.
 * Не покрыты (не вид города): `attrs.alloc` (нарезка команд из ввода клиента), `belt` (поле сейва), `debuffs`, `auras` (HUD).
 */
import { describe, it, expect } from 'vitest';
import type { Item, QuestDef, SaveState, EquipSlot } from '../types/index.js';
import { emptyJournal, fullJournal, type CraftJournal } from '../formulas/craft.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { respecRefusal } from '../economy/townActions.js';
import { GOLDEN, readGolden, registryFromGolden } from './town.testkit.js';
import {
  benchActions, benchTargetLabel, benchTarget, disposePrompts, forgeBenchView, glyphOf, itemMenuView, journalGainsOf, materialNote,
  materialsView, priceText, questLines, questsView, respecView, socketsView, bindSlotView, abbrev, itemTipView,
} from './town.js';

type Golden = {
  config: Record<string, unknown>;
  items: { item: Item; parts: Record<string, { id: string; step: number }> | null; type: { id: string | null; name: string } | null; tierIndex: number;
    label: string; glyph: string; bench: { wallet: string; actions: Record<string, unknown>[] }[]; journal: { name: string; gains: string[] }[];
    prompts: { field: string[]; forge: string[]; sell: string[]; sellNull: string[] } }[];
  bags: { stacks200: Item[]; stacks150: Item[]; some: Item[] };
  menuSave: Pick<SaveState, 'equipment' | 'belt'>;
  menu: { uid: string; bag: string; town: boolean; attributes: SaveState['attributes']; labels: string[]; live: boolean[]; tip?: { text: string; tone: string }[] }[];
  materials: { cases: { wallet: Record<string, number>; inventory: Item[]; view: Record<string, unknown> }[]; notes: { id: string; note: unknown }[] };
  sockets: { name: string; save: SaveState; learned: Record<string, unknown>[] }[];
  prices: { id: string; carrier: 'mana' | 'stamina'; text: string }[];
  attrs: { respec: { name: string; save: SaveState; refund: number; refusal: string | null; refusalHigh: string | null }[] };
  quests: { board: QuestDef[]; saves: { name: string; save: Pick<SaveState, 'quests' | 'activeQuestDefs'>; rival: unknown[]; blocks: unknown[] }[]; boardBlocks: unknown[] };
  bind: { kits: { name: string; weapon: Item | null; offhand: Item | null }[]; nodes: { id: string; abbrev: string; attackLike: boolean; element: string; fits: boolean[] }[] };
};
const g = readGolden<Golden>(GOLDEN.panels);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe.skipIf(!g)('виды города ⇄ unity_panels.json', () => {
  const reg = registryFromGolden(g!.config);
  const dims = reg.get('balance').inventory;
  const potion = itemFromBaseId(reg.get('items.base'), 'healing-potion', undefined, 'shop')!;
  /** «Полная» сумка эталона (`fullBag`): свободные клетки вокруг вещей — зелья 1×1. */
  const fullBag = (items: Item[]): Item[] => {
    const bag = items.map((it) => ({ ...it }));
    let k = 0;
    for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
      const free = bag.every((o) => !o.pos || x >= o.pos.x + o.gridW || x + 1 <= o.pos.x || y >= o.pos.y + o.gridH || y + 1 <= o.pos.y);
      if (free) bag.push({ ...potion, uid: `fill-${k++}`, pos: { x, y } });
    }
    return bag;
  };
  const rich = Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1000]));
  const wallets: Record<string, { gold: number; extra: Item[]; wallet: Record<string, number> }> = {
    broke: { gold: 0, extra: [], wallet: {} },
    rich: { gold: 10_000_000, extra: g!.bags.stacks200, wallet: rich },
    some: { gold: 500, extra: g!.bags.some, wallet: { 'iron-1': 5, 'plate-1': 30, 'iron-2': 1 } },
  };
  /** Карточка без поля, которого эталон не знает: вопросы перед разбором (`prompts`, новое поле DTO). */
  const asGolden = (a: object): Record<string, unknown> => { const { prompts: _p, ...rest } = a as Record<string, unknown>; return rest; };

  it('верстак: карточки в трёх кошельках, подпись предпросмотра, глиф', () => {
    let n = 0;
    for (const c of g!.items) {
      const bagItem = { ...c.item, pos: { x: 9, y: 5 } };
      expect(benchTargetLabel(reg, c.item, benchTarget(reg, c.item)), `${c.item.uid} label`).toBe(c.label);
      expect(glyphOf(c.item), `${c.item.uid} glyph`).toBe(c.glyph);
      const tip = itemTipView(reg, c.item, c.item);
      expect(tip.glyph).toBe(c.glyph);
      expect(tip.wornSlot, 'та же вещь — без сравнения').toBeNull();
      expect(tip.note === null).toBe(c.item.kind !== 'material');
      for (const b of c.bench) {
        const w = wallets[b.wallet]!;
        const got = benchActions(reg, c.item, w.gold, [bagItem, ...w.extra], w.wallet).map(asGolden);
        expect(json(got), `${c.item.uid} bench[${b.wallet}]`).toEqual(b.actions);
        n++;
      }
    }
    expect(n).toBe(g!.items.length * 3);
  });

  it('верстак сервером (`forgeBenchView`): тот же расчёт из сейва и сундука; вопросы разбора — у карточки', () => {
    for (const c of g!.items.slice(0, 80)) {
      const w = wallets.rich!;
      const bagItem = { ...c.item, pos: { x: 9, y: 5 } };
      const save = { gold: w.gold, inventory: [bagItem, ...w.extra] } as unknown as SaveState;
      const v = forgeBenchView(reg, save, { materials: w.wallet }, c.item.uid)!;
      // Сундук пришёл (журнал — пустой: `normalizeJournal`), эталон считал без журнала: стартовому набору всё равно есть что дать.
      expect(json(v.actions.map(asGolden)), c.item.uid).toEqual(c.bench.find((b) => b.wallet === 'rich')!.actions);
      expect(v.actions.find((a) => a.id === 'salvage')!.prompts).toEqual(c.prompts.forge);
      expect(v.preview.label).toBe(c.label);
    }
    expect(forgeBenchView(reg, { gold: 0, inventory: [] } as unknown as SaveState, null, 'nope')).toBeNull();
  });

  it('вопросы перед разбором и продажей; «что добавил бы в каталог» в десяти журналах', () => {
    const full = fullJournal(reg);
    const k = reg.get('balance').craft.journal;
    const journalFor = (c: Golden['items'][number], name: string): CraftJournal | null => {
      if (name === 'null') return null;
      if (name === 'empty') return emptyJournal();
      const variants = ['strike', 'grip', 'bind', 'head'].map((s) => c.parts![s]!.id);
      const types = c.type?.id ? [c.type.id] : [];
      const known: CraftJournal = { ...emptyJournal(), bases: [c.item.baseId], variants, tierHi: c.tierIndex, typesSeen: types };
      const all: CraftJournal = { ...full, typesSeen: types };
      const base = reg.get('items.base').find((b) => b.id === c.item.baseId);
      const sk = base?.kind === 'weapon' ? { [base.weaponClass]: k.sketchAfter - 1 } : {};
      const table: Record<string, CraftJournal> = {
        known, 'no-variant': { ...known, variants: variants.slice(1) }, 'no-base': { ...known, bases: [] }, all,
        'all-low': { ...all, tierHi: 0, mythic: 0 }, 'all-gate': { ...all, mythic: 0 }, sketch: { ...known, classSalvages: sk }, 'sketch-all': { ...all, classSalvages: sk },
      };
      return table[name]!;
    };
    for (const c of g!.items) {
      for (const j of c.journal) expect(journalGainsOf(reg, c.item, journalFor(c, j.name)), `${c.item.uid} journal[${j.name}]`).toEqual(j.gains);
      expect(disposePrompts(reg, c.item, 'field', emptyJournal()), `${c.item.uid} prompts.field`).toEqual(c.prompts.field);
      expect(disposePrompts(reg, c.item, 'forge', emptyJournal()), `${c.item.uid} prompts.forge`).toEqual(c.prompts.forge);
      expect(disposePrompts(reg, c.item, 'sell', emptyJournal(), 37), `${c.item.uid} prompts.sell`).toEqual(c.prompts.sell);
      expect(disposePrompts(reg, c.item, 'sell', null), `${c.item.uid} prompts.sellNull`).toEqual(c.prompts.sellNull);
    }
  });

  it('меню вещи сумки: пункты, живые ли, подсказка пункта разбора; у живого разбора — вопросы и команда с согласием', () => {
    const byUid = new Map(g!.items.map((c) => [c.item.uid, c.item]));
    for (const m of g!.menu) {
      const item = { ...byUid.get(m.uid)!, pos: { x: 9, y: 5 } };
      const bag = m.bag === 'full' ? fullBag([item]) : [item];
      const save = { ...json(g!.menuSave), inventory: bag, attributes: m.attributes } as unknown as SaveState;
      const menu = itemMenuView(reg, save, null, item.uid, m.town);
      const who = `${m.uid} ${m.bag} town=${m.town}`;
      expect(menu.map((x) => x.label), who).toEqual(m.labels);
      expect(menu.map((x) => x.act !== null), who).toEqual(m.live);
      expect(menu.at(-1)!.tip ?? null, who).toEqual(m.tip ?? null);
      const sv = menu.find((x) => x.act === 'salvage');
      if (sv) {
        expect(sv.command!.uid).toBe(item.uid);
        expect(sv.prompts).toEqual(disposePrompts(reg, item, 'field', undefined));
      }
    }
  });

  it('«Ресурсы» сундука и подсказка стопки сырья', () => {
    for (const m of g!.materials.cases) {
      const { carried, ...v } = materialsView(reg, m.wallet, m.inventory);
      expect(json(v)).toEqual(m.view);
      expect(carried > 0).toBe((m.view.tab as string).includes('+'));
    }
    for (const nt of g!.materials.notes) expect(json(materialNote(reg, { kind: 'material', materialId: nt.id })), nt.id).toEqual(nt.note);
  });

  it('сборка скилов: выученные, клетки, выбор вставки, итог; ценники вставок', () => {
    // ⚠ ОТКЛОНЕНИЕ (сервер ≠ эталон): вариант вставки, чей тип уже стоит в гнезде ЗА ПРЕДЕЛОМ открытых, сервер (`socketInsert`) отвергает —
    // вид его не предлагает. Эталон (веб смотрел только открытые гнёзда) — минус ровно такие варианты; их число сверено явно.
    let dropped = 0;
    const serverSide = (sc: Golden['sockets'][number]): Record<string, unknown>[] => json(sc.learned).map((l) => {
      const slots = sc.save.sockets?.[l.id as string] ?? [];
      const cells = (l.cells as { options: { insertId: string | null }[] }[]).map((c, i) => {
        const used = new Set(slots.filter((_, j) => j !== i).map((id) => (id ? reg.get('skill-inserts').find((x) => x.id === id && x.enabled !== false)?.type : undefined)).filter(Boolean));
        const options = c.options.filter((o) => !o.insertId || !used.has(reg.get('skill-inserts').find((x) => x.id === o.insertId)!.type));
        dropped += c.options.length - options.length;
        return { ...c, options };
      });
      return { ...l, cells };
    });
    for (const sc of g!.sockets) {
      const v = socketsView(reg, sc.save);
      // Вид → форма эталона: у клетки и варианта — ещё `insertId`/`rank`/`price` (подсказка вставки), итог — полями C# `SocketSummary`.
      const got = v.learned.map((l) => ({
        id: l.id, label: l.label,
        cells: l.cells.map((c) => ({ head: c.head, text: c.text, price: c.price, options: c.options.map((o) => ({ label: o.label, insertId: o.insertId })) })),
        summary: l.summary ? {
          baseCost: l.summary.baseCost, cost: l.summary.cost, baseCd: l.summary.baseCd, cd: l.summary.cd, resource: l.summary.resource,
          extra: l.summary.extraPool ? { pool: l.summary.extraPool, amount: l.summary.extraAmount } : null, procs: l.summary.procs,
        } : null,
      }));
      expect(json(got), sc.name).toEqual(serverSide(sc));
      expect(v.hint === null).toBe(v.learned.length > 0);
    }
    expect(dropped, 'вариантов, которые сервер отверг бы, в эталоне (18 клеток)').toBe(33);
    for (const p of g!.prices) {
      const ins = reg.get('skill-inserts').find((x) => x.id === p.id)!;
      expect(priceText(ins, p.carrier), `${p.id}/${p.carrier}`).toBe(p.text);
    }
  });

  it('сброс атрибутов у мастера: сколько вернёт и почему нельзя (по цене вида и по цене выше)', () => {
    const cost = reg.get('balance').respecCost;
    for (const r of g!.attrs.respec) {
      const save = { ...json(r.save), skills: {}, masteries: {} } as SaveState;   // эталон снял с сейва только поля сброса атрибутов
      const v = respecView(reg, save);
      expect(v.attrs.cost).toBe(cost);
      expect(v.attrs.refund, r.name).toBe(r.refund);
      expect(v.attrs.refusal, r.name).toBe(r.refusal);
      expect(respecRefusal(reg, save, cost - 1), r.name).toBe(r.refusalHigh);   // согласие ниже цены — «Цена изменилась: N золота»
    }
  });

  it('журнал заданий: соперник того же шаблона и строки блока', () => {
    const board = g!.quests.board;
    for (const qs of g!.quests.saves) {
      const save = json(qs.save) as unknown as SaveState;
      const v = questsView(save, board);
      expect(json(v.board.map((e) => e.rival)), qs.name).toEqual(qs.rival);
      const blocks = save.quests.filter((q) => q.status !== 'turned-in').map((q) => {
        const e = v.active.find((x) => x.questId === q.questId);
        return e ? { questId: e.questId, status: e.status, objectives: e.objectives, reward: e.reward } : null;
      });
      expect(blocks, qs.name).toEqual(qs.blocks);
    }
    expect(board.map((d) => questLines(d, undefined))).toEqual(g!.quests.boardBlocks);
  });

  it('панель биндов: две буквы, стихия, «атака», гейт оружия на восьми наборах', () => {
    for (const node of g!.bind.nodes) {
      const def = reg.get('skill-tree').nodes.find((n) => n.id === node.id)!;
      expect(abbrev(def.name)).toBe(node.abbrev);
      g!.bind.kits.forEach((k, i) => {
        const eq: Partial<Record<EquipSlot, Item>> = {};
        if (k.weapon) eq.weapon = k.weapon;
        if (k.offhand) eq.offhand = k.offhand;
        const s = bindSlotView(reg, { equipment: eq }, node.id);
        expect(s.fits, `${node.id} @ ${k.name}`).toBe(node.fits[i]);
        expect(s.attackLike).toBe(node.attackLike);
        expect(s.element).toBe(node.element);
        expect(s.text).toBe(node.abbrev);
      });
    }
  });
});
