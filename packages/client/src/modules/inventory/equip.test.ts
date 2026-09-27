import { describe, it, expect } from 'vitest';
import {
  ConfigRegistry, equip, itemFromBaseId, newCharacterSave, parseTownCommand, type EquipSlot, type Item, type SaveState,
} from '@dm/shared';
import { paperdollCommand } from './equip.js';

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
