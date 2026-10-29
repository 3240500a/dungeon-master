import { describe, it, expect } from 'vitest';
import { ALLOC_ATTR_MAX, ATTRIBUTES, allocAttr, parseTownCommand, type Attribute, type SaveState } from '@dm/shared';
import { attrAllocCommands } from './allocAttrs.js';

/**
 * ⚠ R2-15: «OK — применить (N)» на листе персонажа. Слало по команде на очко: после сброса у героя 40-го
 * уровня ≈ 195 очков, и 195 кадров разом рвали соединение на 121-м (потолок кадров, 4008 «rate limit»), а
 * две пачки по 100 подряд упирались в потолок команд города. Теперь — команда на атрибут с числом очков.
 */
const staged = (p: Partial<Record<Attribute, number>>): Record<Attribute, number> =>
  ({ strength: 0, dexterity: 0, intelligence: 0, vitality: 0, ...p });

describe('attrAllocCommands — набранное в листе персонажа одной пачкой', () => {
  it('300 очков по четырём атрибутам — не больше четырёх команд, и каждую пропустит провод', () => {
    const cmds = attrAllocCommands(staged({ strength: 120, dexterity: 80, intelligence: 60, vitality: 40 }));
    expect(cmds.length).toBeLessThanOrEqual(ATTRIBUTES.length);
    for (const c of cmds) expect(parseTownCommand(c).ok, JSON.stringify(c)).toBe(true);
    const sum = (a: Attribute): number => cmds.filter((c) => c.attr === a).reduce((s, c) => s + (c.n ?? 1), 0);
    expect({ s: sum('strength'), d: sum('dexterity'), i: sum('intelligence'), v: sum('vitality') }).toEqual({ s: 120, d: 80, i: 60, v: 40 });
  });

  it('все 300 в один атрибут — одна команда; ядро сервера вкладывает её целиком', () => {
    const cmds = attrAllocCommands(staged({ vitality: 300 }));
    expect(cmds).toEqual([{ cmd: 'allocAttr', attr: 'vitality', n: 300 }]);
    const save = { attributes: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 }, unspentAttributePoints: 300 } as unknown as SaveState;
    for (const c of cmds) expect(allocAttr(save, c.attr, c.n).ok).toBe(true);
    expect(save.unspentAttributePoints).toBe(0);
    expect(save.attributes.vitality).toBe(305);
  });

  it('больше потолка одной команды — делится на куски, каждый в пределах провода', () => {
    const cmds = attrAllocCommands(staged({ strength: ALLOC_ATTR_MAX * 2 + 7 }));
    expect(cmds.map((c) => c.n)).toEqual([ALLOC_ATTR_MAX, ALLOC_ATTR_MAX, 7]);
    for (const c of cmds) expect(parseTownCommand(c).ok).toBe(true);
  });

  it('ничего не набрано (и мусор в буфере) — ни одной команды', () => {
    expect(attrAllocCommands(staged({}))).toEqual([]);
    expect(attrAllocCommands(staged({ strength: -3, dexterity: Number.NaN, intelligence: 0.4 }))).toEqual([]);
  });
});
