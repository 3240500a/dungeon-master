import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { setBinding } from './townActions.js';
import { newCharacterSave } from './newCharacter.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R3-02: БИНД — ТОЛЬКО ТО, ЧТО ПРЕДЛАГАЕТ ПАНЕЛЬ: `null` (пусто), `'attack'` (базовая атака) или активный узел
 * древа, в который герой вложил хотя бы ранг (выпадающий список веба и Unity строится ровно так).
 *
 * Раньше `setBinding` клал в сейв ЛЮБУЮ строку. `"x\u0000"` или непарный суррогат Postgres в jsonb не принимает —
 * и каждая следующая запись героя падала: он играл из памяти, а рестарт откатывал его к сейву до бинда (дюп вещи
 * через соседа по аккаунту, откат неудачных перекаток и смертей). Схема провода теперь режет такие символы сама,
 * а ядро — всё, чего панель не предлагает: вторая линия не должна зависеть от первой.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800);

/**
 * Герой с одним выученным активным узлом (ветка без класса — доступна любому) и пассивным узлом с рангом: ранг есть,
 * а активки у узла нет — привязывать нечего.
 */
function hero(): { save: SaveState; active: string; unlearned: string | undefined; passive: string | undefined } {
  const tree = reg.get('skill-tree');
  const free = tree.branches.filter((b) => !b.classId).map((b) => b.id);
  const active = tree.nodes.find((n) => free.includes(n.branchId) && n.effect.active)!.id;
  const save = newCharacterSave(reg, 'warrior', 'Бинд', 'bind-1');
  save.skills[active] = 1;
  const unlearned = tree.nodes.find((n) => n.effect.active && n.id !== active)?.id;
  const passive = tree.nodes.find((n) => !n.effect.active)?.id;
  if (passive) save.skills[passive] = 1;
  return { save, active, unlearned, passive };
}

describe('⚠ R3-02: setBinding кладёт в сейв только то, что предлагает панель биндов', () => {
  it('пусто, атака и выученная активка — в любой слот 0…4', () => {
    const { save, active } = hero();
    for (const slot of [0, 1, 2, 3, 4]) {
      for (const value of [null, 'attack', active]) {
        expect(setBinding(reg, save, slot, value), `слот ${slot} ← ${String(value)}`).toEqual({ ok: true });
        const got = slot === 0 ? save.mouseLeft : slot === 1 ? save.mouseRight : save.hotbar[slot - 2];
        expect(got).toBe(value);
      }
    }
  });

  it('⭐ U+0000, непарный суррогат, неизвестный id, невыученная активка, пассивный узел, пустая строка — отказ, сейв байт в байт', () => {
    const { save, active, unlearned, passive } = hero();
    expect(setBinding(reg, save, 4, active).ok).toBe(true);
    const bad = [`x${NUL}`, `${active}${NUL}`, `x${LONE}`, LONE, NUL, '', 'нет-такого-узла', 'Attack', ' attack',
      ...(unlearned ? [unlearned] : []), ...(passive ? [passive] : [])];
    expect(bad.length, 'сторож видит и невыученную, и пассив').toBeGreaterThanOrEqual(10);
    for (const slot of [0, 1, 2, 3, 4]) {
      for (const value of bad) {
        const before = JSON.stringify(save);
        const r = setBinding(reg, save, slot, value);
        expect(r.ok, `слот ${slot} ← ${JSON.stringify(value)}`).toBe(false);
        expect(r.reason).toBeTruthy();
        expect(JSON.stringify(save), `слот ${slot}: сейв не тронут`).toBe(before);
      }
    }
    // Сейв, прошедший все отказы, сериализуется без U+0000 и суррогатов — Postgres его примет.
    expect(JSON.stringify(save)).not.toMatch(/\\u0000|\\ud8|\\udc/);
  });

  it('неверный слот — отказ, как и раньше', () => {
    const { save } = hero();
    const before = JSON.stringify(save);
    for (const slot of [-1, 5, 15]) expect(setBinding(reg, save, slot, 'attack').ok, String(slot)).toBe(false);
    expect(JSON.stringify(save)).toBe(before);
  });
});
