import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { ATTRIBUTES } from '../types/attributes.js';
import { newCharacterSave } from './newCharacter.js';
import { PRICE_CHANGED, allocAttr, respec, respecRefusal } from './townActions.js';
import type { Item } from '../types/items.js';

/**
 * ⭐ R19-07: `respecRefusal` — ОДНО РЕШЕНИЕ ДЛЯ ЯДРА И КНОПКИ. Кнопка «Сбросить атрибуты» гасла только по возврату и золоту, а ядро `respec`
 * отказывает ещё и тогда, когда надетое держится на вложенных очках (R4-08): горящая кнопка кончалась отказом «сперва сними её». Теперь кнопка
 * спрашивает `respecRefusal` — проверки ядра без записи, в том же порядке. Сверка на случайных героях: причина та же, что у `respec`, `null` ⇔
 * сброс прошёл, отказ сейва не трогает.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const cost = reg.get('balance').respecCost;

describe('⭐ R19-07: respecRefusal ≡ respec', () => {
  it('случайные герои: вложенные очки, надетое на грани требований, золото и согласие на цену у края — причина та же, что у ядра', () => {
    const r = createRng(1907);
    const classes = reg.get('classes').map((c) => c.id);
    const kinds: Record<string, number> = {};
    for (let n = 0; n < 600; n++) {
      const s = newCharacterSave(reg, r.pick(classes), `Герой ${n}`, `r1907-${n}`);
      if (r.chance(0.1)) s.classId = 'нет-такого';
      if (r.chance(0.2)) delete s.startAttributes;   // сейв старше R18-07 (R19-01)
      s.unspentAttributePoints = r.int(0, 40);
      for (let k = r.int(0, 3); k > 0 && s.unspentAttributePoints > 0; k--) {
        allocAttr(s, r.pick(ATTRIBUTES), r.int(1, s.unspentAttributePoints));
      }
      // Надетое — на грани: требование вокруг нынешнего атрибута (держится на вложенных очках или нет).
      for (const it of Object.values(s.equipment).filter(Boolean) as Item[]) {
        if (!r.chance(0.6)) continue;
        const a = r.pick(ATTRIBUTES);
        it.requirements = { ...it.requirements, [a]: Math.max(0, s.attributes[a] + r.pick([-3, -1, 0, 0, 1])) };
      }
      s.gold = r.pick([0, cost - 1, cost, cost + 1, cost * 20]);
      const maxGold = r.pick([undefined, cost, cost - 1, cost + 100, Number.NaN]);
      const before = JSON.stringify(s);
      const said = respecRefusal(reg, s, maxGold);
      expect(JSON.stringify(s), 'проверка без записи').toBe(before);
      const res = respec(reg, s, maxGold);
      expect(said, `герой ${n}: кнопка и ядро решили по-разному`).toBe(res.ok ? null : res.reason);
      if (!res.ok) expect(JSON.stringify(s), `герой ${n}: отказ сейв не трогает`).toBe(before);
      const kind = said === null ? 'ok' : said.startsWith(PRICE_CHANGED) ? 'price' : said.startsWith('После сброса') ? 'worn' : said;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    // Свойство не пустое: встретились все исходы, и отказ «сперва сними её» — тоже.
    for (const k of ['ok', 'price', 'worn', 'Недостаточно золота', 'Атрибуты не вложены', 'Класс не найден']) expect(kinds[k] ?? 0, `${k}: ${JSON.stringify(kinds)}`).toBeGreaterThan(0);
  });
});
