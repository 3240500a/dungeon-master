import { describe, it, expect } from 'vitest';
import { buildInventory, inventorySummary, stateClipName, REQUIRED, type InvClip } from './animInventory.js';

/**
 * ИНВЕНТАРЬ АНИМАЦИЙ.
 *
 * Он отвечает на три вопроса, ответа на которые не было нигде: полный ли набор, нет ли дублей, не
 * ссылается ли что-нибудь в никуда. Самый вредный из трёх — дубли: рантайм берёт ПЕРВОЕ совпадение,
 * поэтому семь копий из восьми мертвы, и править можно совсем не ту запись, которую читает игра.
 * Инвентарь, который это проглядит, хуже отсутствующего — на него будут ссылаться как на проверку.
 */
const clip = (name: string, character = 'warrior', weapon = 'none', keys = 1): InvClip =>
  ({ name, character, weapon, keys: Array.from({ length: keys }, () => ({})) });

describe('контракт набора', () => {
  it('пустая библиотека — всё в недостаче, и это видно числом', () => {
    const need = REQUIRED.reduce((s, g) => s + g.names.length, 0);
    const rows = buildInventory({ clips: [clip('idle_relax')] });
    expect(rows[0]!.done).toBe(1);
    expect(rows[0]!.need).toBe(need);
    expect(rows[0]!.groups.find((g) => g.group === 'бег')!.missing).toHaveLength(4);
  });

  it('персонажи разделены — у каждого свой набор', () => {
    const rows = buildInventory({ clips: [clip('idle_relax', 'warrior'), clip('run_fwd', 'mage')] });
    expect(rows.map((r) => r.character)).toEqual(['mage', 'warrior']);
    expect(rows.find((r) => r.character === 'mage')!.done).toBe(1);
  });

  it('оружейные клипы в контракт не входят, но в общий счёт — да', () => {
    const rows = buildInventory({ clips: [clip('idle_sword', 'warrior', 'sword'), clip('idle_relax')] });
    expect(rows[0]!.total).toBe(2);
    expect(rows[0]!.done, 'в контракте только базовая стойка').toBe(1);
  });
});

describe('дубли — самая вредная находка', () => {
  it('считаются по той же тройке имя+персонаж+оружие, по которой ищет рантайм', () => {
    const rows = buildInventory({ clips: [clip('idle_dual'), clip('idle_dual'), clip('idle_dual')] });
    expect(rows[0]!.dups).toEqual([{ key: 'idle_dual·none', count: 3 }]);
  });

  it('РАЗНОЕ ОРУЖИЕ — не дубль: рантайм различает их и берёт своё', () => {
    const rows = buildInventory({ clips: [clip('idle', 'warrior', 'sword'), clip('idle', 'warrior', 'axe')] });
    expect(rows[0]!.dups).toEqual([]);
  });

  it('итог называет число ЛИШНИХ копий, а не число дублирующихся имён', () => {
    // Восемь копий одного имени — это семь лишних. Показать «1 дубль» значило бы сильно преуменьшить.
    const rows = buildInventory({ clips: Array.from({ length: 8 }, () => clip('hit_dual')) });
    expect(inventorySummary(rows)).toContain('ЛИШНИХ КОПИЙ 7');
  });
});

describe('битые ссылки', () => {
  it('состояние ссылается на несуществующий клип — видно, откуда и куда', () => {
    const rows = buildInventory({
      clips: [clip('attack')],
      anim: { warrior: { states: { stagger: { clip: 'которого_нет' } } } },
    });
    expect(rows[0]!.broken).toEqual([{ where: 'состояние «stagger»', ref: 'которого_нет' }]);
  });

  it('состояние без привязки ищет клип по своему имени — и это тоже проверяется', () => {
    const rows = buildInventory({ clips: [clip('attack')], anim: { warrior: { states: { getup: {} } } } });
    expect(rows[0]!.broken[0]!.ref).toBe('getup');
  });

  it('сторонние ссылки (pe_loco, pe_attacks) проверяются так же', () => {
    const rows = buildInventory({
      clips: [clip('run_fwd')],
      refs: [{ where: 'pe_loco', character: 'warrior', ref: 'бег' }],
    });
    expect(rows[0]!.broken).toEqual([{ where: 'pe_loco', ref: 'бег' }]);
  });

  it('чужого персонажа ссылки не приписываются', () => {
    const rows = buildInventory({
      clips: [clip('run_fwd', 'warrior')],
      refs: [{ where: 'pe_loco', character: 'mage', ref: 'нет' }],
    });
    expect(rows[0]!.broken).toEqual([]);
  });
});

describe('пустые клипы', () => {
  it('запись есть, кадров нет — выглядит готовой, а не играет', () => {
    const rows = buildInventory({ clips: [clip('idle_relax', 'warrior', 'none', 0)] });
    expect(rows[0]!.empty).toEqual(['idle_relax']);
    expect(inventorySummary(rows)).toContain('пустых 1');
  });
});

describe('чтение привязки состояния', () => {
  it('строка — это имя клипа, объект — поле clip, ничего — имя состояния', () => {
    expect(stateClipName('attack', 'hit_sword_01')).toBe('hit_sword_01');
    expect(stateClipName('attack', { clip: 'hit_axe' })).toBe('hit_axe');
    expect(stateClipName('attack', {})).toBe('attack');
    expect(stateClipName('attack', undefined)).toBe('attack');
  });
});
