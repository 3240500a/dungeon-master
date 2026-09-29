import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, addToInventory, equip, itemFromBaseId, materialItem, newCharacterSave, parseTownCommand, type EquipSlot, type Item,
  type SaveState, type TownCommand,
} from '@dm/shared';
import { GameState } from '../../core/gameState.js';
import { El, installDom } from '../town/uiParity.fuzzKit.js';
import { paperdollCommand, paperdollEquip } from './equip.js';
import { beginHold, clearHeld, getHeld } from './heldItem.js';
import { inventoryPanel } from './inventoryPanel.js';

/**
 * ⭐ R11-02: ПУПСИК И СЕРВЕР НАДЕВАЮТ В ОДНУ И ТУ ЖЕ ЯЧЕЙКУ. Ячейка «Левая рука» принимала одноручное оружие (дуал-вилд),
 * но слала `{cmd:'equip', uid}` без цели — и сервер надевал кинжал в РОДНОЙ слот: кинжал менял меч в основной руке, вторая
 * рука оставалась пустой, ветка «Парное оружие» не открывалась никогда. А своя проверка пупсика не пускала щит под
 * полуторный, который сервер надевает (§25). Теперь правило второй руки одно (`offhandRefusal`), а команда несёт цель.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const mk = (baseId: string, uid = baseId): Item => ({ ...itemFromBaseId(reg.get('items.base'), baseId, reg.get('item-tiers'), 'drop')!, uid, requirements: {} });
/** Герой с атрибутами «на всё» и пустой сумкой, кроме `bag` в углу; в руках — `main` и `off`. */
const hero = (main: string | null, off: string | null, bag: string): SaveState => {
  const s = newCharacterSave(reg, 'warrior', 'Пупсик', 'r1102-doll');
  s.attributes = { strength: 999, dexterity: 999, intelligence: 999, vitality: 999 } as SaveState['attributes'];
  s.equipment = {};
  if (main) s.equipment.weapon = { ...mk(main, 'main'), pos: null };
  if (off) s.equipment.offhand = { ...mk(off, 'off'), pos: null };
  s.belt = [];
  s.inventory = [{ ...mk(bag, 'held'), pos: { x: 0, y: 0 } }];
  return s;
};

describe('⭐ R11-02: пупсик — клик по ячейке с вещью на курсоре', () => {
  it('случай из находки: меч в руке, кинжал на ячейку второй руки — команда с целью, сервер кладёт кинжал во вторую руку', () => {
    const s = hero('short-sword', null, 'dagger');
    const cmd = paperdollCommand(s.inventory[0]!, 'offhand', s.equipment.weapon);
    expect(cmd, 'было: {cmd:"equip", uid} — без цели').toEqual({ cmd: 'equip', uid: 'held', slot: 'offhand' });
    const parsed = parseTownCommand(cmd);
    expect(parsed.ok, 'строгая схема сервера пропускает').toBe(true);
    if (!parsed.ok || parsed.command.cmd !== 'equip') return;
    expect(equip(reg, s, parsed.command.uid, parsed.command.slot).ok).toBe(true);
    expect([s.equipment.weapon?.uid, s.equipment.offhand?.uid]).toEqual(['main', 'held']);
  });

  it('⭐ пупсик шлёт ⇔ сервер надевает, и вещь встаёт ровно в ту ячейку, куда её бросили (руки × вещь × ячейка)', () => {
    const hands: [string | null, string | null][] = [
      [null, null], ['short-sword', null], ['short-sword', 'wooden-shield'], ['short-sword', 'dagger'], [null, 'dagger'],
      ['greatsword', null], ['greatsword', 'wooden-shield'], ['claymore', null],
    ];
    const items = ['dagger', 'hand-crossbow', 'apprentice-wand', 'long-sword', 'greatsword', 'claymore', 'buckler', 'leather-cap'];
    const cells: EquipSlot[] = ['weapon', 'offhand', 'helm'];
    let sent = 0, refused = 0;
    for (const [main, off] of hands) for (const bag of items) for (const cell of cells) {
      const s = hero(main, off, bag);
      const why = `${main ?? '—'}+${off ?? '—'} ← ${bag} в ${cell}`;
      const cmd = paperdollCommand(s.inventory[0]!, cell, s.equipment.weapon);
      if (typeof cmd === 'string') {
        refused++;
        // Отказ ячейки второй руки — и отказ сервера на ту же цель: пупсик не прячет то, что сервер надел бы туда.
        if (cell === 'offhand') expect(equip(reg, s, 'held', 'offhand').ok, why).toBe(false);
        continue;
      }
      sent++;
      const parsed = parseTownCommand(cmd);
      expect(parsed.ok, why).toBe(true);
      if (!parsed.ok || parsed.command.cmd !== 'equip') continue;
      const r = equip(reg, s, parsed.command.uid, parsed.command.slot);
      expect(r.ok, `${why}: ${r.reason}`).toBe(true);
      expect(s.equipment[cell]?.uid, why).toBe('held');
    }
    expect(sent).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
    // Щит под полуторный — пупсик пускает, как сервер (было: «Занято двумя руками» на любом `hands ≥ 2`).
    const s = hero('greatsword', null, 'buckler');
    expect(paperdollCommand(s.inventory[0]!, 'offhand', s.equipment.weapon)).toEqual({ cmd: 'equip', uid: 'held', slot: 'offhand' });
  });
});

/**
 * ⭐ R16-08: ПУПСИК ОТКАЗЫВАЕТ РОВНО ТАМ, ГДЕ СЕРВЕР. Пред-проверка пупсика снимала с героя только вещь ЦЕЛЕВОЙ ячейки
 * (`effectiveAttributes`) — а сервер (`equip`) снимает и вторую руку под двуручником и держит требования ВСЕГО надетого (R4-08). Меч и
 * щит +10 Силы, двуручник, которому хватает только со щитом: пупсик пускал, вещь слетала с курсора, сервер отказывал «Недостаточно
 * атрибутов», а окно молчало (строка — только в логе игры). Теперь решение одно — `equipRefusal` ядра (его же зовёт `equip`).
 * Пупсик — настоящий (`inventoryPanel` в DOM-заглушке фаззера паритета), вещь — на настоящем курсоре (`heldItem`).
 */
describe('⭐ R16-08: пупсик ≡ сервер — требования после смены и место под снятое', () => {
  /** Воин (Сила 20) без стартового комплекта; `worn` — надето, `bag` — в сумке. */
  const warrior = (worn: Partial<Record<EquipSlot, Item>>, bag: Item[]): SaveState => {
    const s = newCharacterSave(reg, 'warrior', 'Пупсик', 'r1608-doll');
    s.equipment = {};
    for (const [slot, it] of Object.entries(worn)) s.equipment[slot as EquipSlot] = { ...it, pos: null };
    s.belt = [];
    s.inventory = [];
    for (const it of bag) expect(addToInventory(s.inventory, { ...it }, reg.get('balance').inventory), `${it.uid} в сумку`).toBe(true);
    return s;
  };
  const withStr = (it: Item, str: number): Item => ({ ...it, baseStats: [...it.baseStats, { stat: 'strength', kind: 'flat', value: str }] });
  const needStr = (it: Item, str: number): Item => ({ ...it, requirements: { strength: str } });

  /** Случай находки: меч + щит +10 Силы (Сила 30), двуручник требует 25 — хватает только со щитом, а двуручник щит снимает. */
  const probe = (): SaveState => warrior(
    { weapon: mk('short-sword', 'sword'), offhand: withStr(mk('wooden-shield', 'shield'), 10) },
    [needStr(mk('claymore', 'twoh'), 25)],
  );
  /** Шлем +15 Силы держит двуручник (требует 30), на ячейку шлема брошен простой шлем. */
  const helmProbe = (): SaveState => warrior(
    { helm: withStr(mk('leather-cap', 'helm'), 15), weapon: { ...needStr(mk('claymore', 'twoh'), 30), name: 'Двуручник' } },
    [mk('leather-cap', 'helm2')],
  );

  /** Клик пупсика: вещь `uid` на курсоре, клик по ячейке `cell`. Что ушло на сервер, что появилось в окне и осталась ли вещь на курсоре. */
  function click(save: SaveState, uid: string, cell: EquipSlot): { sent: TownCommand[]; msg: string; held: boolean } {
    const dom = installDom(() => true);
    const sent: TownCommand[] = [];
    try {
      const app = {
        config: reg, state: new GameState(save), stash: null, bus: { emit: () => {} }, net: { on: () => () => {} },
        sendCmd: (c: TownCommand) => { sent.push(c); return sent.length; }, request: () => Promise.resolve(null),
      };
      const body = new El('div');
      inventoryPanel(app as never, {} as never).render(body as never);
      const texts = (): string[] => body.all().map((e) => e.textContent);
      const before = new Set(texts());
      beginHold(app as never, save.inventory.find((i) => i.uid === uid)!, 0, 0, 'inv');
      const target = body.all().find((e) => e.dataset.eqslot === cell);
      expect(target, `ячейка ${cell} нарисована`).toBeTruthy();
      target!.dispatch('click', { clientX: 5, clientY: 5 });
      const held = getHeld() !== null;
      return { sent, msg: texts().filter((t) => t && !before.has(t)).join(' | '), held };
    } finally {
      clearHeld();
      dom.restore();
    }
  }

  it('случай находки: двуручник, которому хватает Силы только со щитом, — пупсик не шлёт и пишет отказ сервера; вещь на курсоре', () => {
    const twoH = probe().inventory[0]!;
    expect((twoH.hands ?? 1) >= 2 && !twoH.versatile, 'настоящий двуручник — снимает щит').toBe(true);
    const r = click(probe(), 'twoh', 'weapon');
    expect(r.sent, 'было: {cmd:"equip", uid:"twoh"} — и сервер отказывал').toEqual([]);
    expect(r.msg).toBe('Недостаточно атрибутов');
    expect(r.held, 'вещь не слетает с курсора молча').toBe(true);
    expect(equip(reg, probe(), 'twoh'), 'сервер отказывает тем же').toEqual({ ok: false, reason: 'Недостаточно атрибутов' });
    expect(paperdollEquip(reg, probe(), twoH, 'weapon')).toBe('Недостаточно атрибутов');
  });

  it('смена шлема оставила бы двуручник без Силы — пупсик пишет, что сперва снять, и не шлёт', () => {
    const r = click(helmProbe(), 'helm2', 'helm');
    expect(r.sent, 'было: {cmd:"equip", uid:"helm2"}').toEqual([]);
    expect(r.msg).toBe('Не хватит атрибутов на «Двуручник» — сперва сними её');
    expect(equip(reg, helmProbe(), 'helm2')).toEqual({ ok: false, reason: 'Не хватит атрибутов на «Двуручник» — сперва сними её' });
  });

  it('снятому некуда лечь (сумка полна) — пупсик не шлёт, отказ «Нет места для снятого», как у сервера', () => {
    const full = (): SaveState => {
      const s = warrior({ weapon: mk('short-sword', 'sword'), offhand: mk('wooden-shield', 'shield') }, [needStr(mk('claymore', 'twoh'), 0)]);
      const dims = reg.get('balance').inventory;
      for (let k = 0; k < dims.cols * dims.rows; k++) if (!addToInventory(s.inventory, mk('leather-cap', `junk-${k}`), dims)) break;
      return s;
    };
    expect(equip(reg, full(), 'twoh')).toEqual({ ok: false, reason: 'Нет места для снятого' });
    const r = click(full(), 'twoh', 'weapon');
    expect(r.sent).toEqual([]);
    expect(r.msg).toBe('Нет места для снятого');
  });

  it('контроль: хватает и без щита — пупсик шлёт, вещь с курсора, сервер надевает, щит в сумке', () => {
    const honest = (): SaveState => warrior(
      { weapon: mk('short-sword', 'sword'), offhand: withStr(mk('wooden-shield', 'shield'), 10) },
      [needStr(mk('claymore', 'twoh'), 20)],
    );
    const r = click(honest(), 'twoh', 'weapon');
    expect(r.sent).toEqual([{ cmd: 'equip', uid: 'twoh' }]);
    expect(r.held).toBe(false);
    const s = honest();
    expect(equip(reg, s, 'twoh')).toEqual({ ok: true });
    expect(s.equipment.weapon?.uid).toBe('twoh');
    expect(s.equipment.offhand).toBeUndefined();
  });

  /** Меню ПКМ по вещи `uid` в сумке: пункты, как их видит игрок, и что уходит на сервер по клику пункта про «Надеть». */
  async function menu(save: SaveState, uid: string): Promise<{ labels: string[]; sent: TownCommand[] }> {
    const dom = installDom(() => true);
    const sent: TownCommand[] = [];
    try {
      const state = new GameState(save);
      state.area = 'town';
      const app = { config: reg, state, stash: null, bus: { emit: () => {} }, sendCmd: (c: TownCommand) => { sent.push(c); return 1; }, request: () => Promise.resolve(null) };
      const body = new El('div');
      inventoryPanel(app as never, {} as never).render(body as never);
      const item = save.inventory.find((i) => i.uid === uid)!;
      const cell = body.all().find((e) => e.listens('contextmenu') && (e.style.cssText ?? '').startsWith(`grid-column:${item.pos!.x + 1} / span`)
        && (e.style.cssText ?? '').includes(`grid-row:${item.pos!.y + 1} / span`))!;
      cell.dispatch('contextmenu', { clientX: 10, clientY: 10 });
      const opts = dom.body.children.at(-1)?.children ?? [];
      opts.find((o) => o.textContent.startsWith('Надеть'))?.click();
      await new Promise((r) => setTimeout(r, 0));   // меню вешает закрытие по клику таймером — пусть отработает при живом `window`
      return { labels: opts.map((o) => o.textContent), sent };
    } finally {
      dom.restore();
    }
  }

  it('меню ПКМ «Надеть» — тем же решением: откажет сервер — пункт говорит почему и ничего не шлёт; сырью пункта нет', async () => {
    const no = await menu(probe(), 'twoh');
    expect(no.labels, 'было: «Надеть» — и отказ сервера только в логе').toContain('Надеть нельзя: Недостаточно атрибутов');
    expect(no.labels).not.toContain('Надеть');
    expect(no.sent).toEqual([]);
    const yes = await menu(warrior({}, [needStr(mk('claymore', 'twoh'), 20)]), 'twoh');
    expect(yes.labels).toContain('Надеть');
    expect(yes.sent).toEqual([{ cmd: 'equip', uid: 'twoh' }]);
    const mat = reg.get('craft-materials')[0]!;
    const s = warrior({}, [materialItem(mat, 3, 'mat')]);
    expect(equip(reg, s, 'mat').ok, 'сырьё сервер не надевает').toBe(false);
    expect((await menu(s, 'mat')).labels.some((l) => l.startsWith('Надеть')), 'было: «Надеть» у стека сырья').toBe(false);
  });

  it('⭐ решение пупсика ≡ сервер: руки × вещь × ячейка × Сила от надетого (шлёт ⇔ сервер надевает туда; отказ ⇔ сервер отказывает)', () => {
    const hands: [string | null, string | null][] = [
      [null, null], ['short-sword', null], ['short-sword', 'wooden-shield'], ['short-sword', 'dagger'], ['greatsword', 'buckler'], ['claymore', null],
    ];
    const items = ['dagger', 'long-sword', 'greatsword', 'claymore', 'buckler', 'wooden-shield', 'leather-cap'];
    const cells: EquipSlot[] = ['weapon', 'offhand', 'helm'];
    let sent = 0, refused = 0;
    for (const str of [0, 8, 14]) for (const [main, off] of hands) for (const bag of items) for (const cell of cells) {
      // Руки дают Силу (`str` каждая), брошенная требует ровно столько, сколько даёт весь комплект: пупсик и сервер обязаны сосчитать одинаково.
      const worn: Partial<Record<EquipSlot, Item>> = {};
      if (main) worn.weapon = needStr(withStr(mk(main, 'main'), str), 0);
      if (off) worn.offhand = needStr(withStr(mk(off, 'off'), str), 0);
      const s = warrior(worn, [needStr(mk(bag, 'held'), 20 + (main ? str : 0) + (off ? str : 0))]);
      const why = `Сила +${str}: ${main ?? '—'}+${off ?? '—'} ← ${bag} в ${cell}`;
      const snap = JSON.stringify(s);
      const cmd = paperdollEquip(reg, s, s.inventory[0]!, cell);
      expect(JSON.stringify(s), `${why}: решение без записи`).toBe(snap);
      if (typeof cmd === 'string') {
        refused++;
        // Отказ ячейки, куда сервер надел бы брошенное (своя ячейка или вторая рука с целью), — и отказ сервера.
        const target = cell === 'offhand' ? 'offhand' : s.inventory[0]!.slot === cell ? undefined : null;
        if (target !== null) expect(equip(reg, s, 'held', target).ok, `${why}: пупсик отказал «${cmd}», а сервер надевает`).toBe(false);
        continue;
      }
      sent++;
      const parsed = parseTownCommand(cmd);
      expect(parsed.ok, why).toBe(true);
      if (!parsed.ok || parsed.command.cmd !== 'equip') continue;
      const r = equip(reg, s, parsed.command.uid, parsed.command.slot);
      expect(r.ok, `${why}: пупсик шлёт, сервер отказал «${r.reason}»`).toBe(true);
      expect(s.equipment[cell]?.uid, why).toBe('held');
    }
    expect(sent).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
  });
});
