import { ALLOC_ATTR_MAX, ATTRIBUTES, type Attribute, type TownCommand } from '@dm/shared';

/**
 * КОМАНДЫ «OK — ПРИМЕНИТЬ» листа персонажа: по одной на атрибут, с числом очков (R2-15) — чистое решение,
 * без DOM, чтобы его проверял node-прогон.
 *
 * ⚠ Раньше — по команде на ОЧКО. После сброса у героя 40-го уровня ≈ 195 очков, и 195 кадров уходили одним
 * циклом: сервер вкладывал ~119 и рвал соединение по потолку кадров (4008 «rate limit»), а две пачки по 100
 * подряд упирались в потолок команд города («Слишком часто»). Теперь кадров не больше четырёх; больше
 * `ALLOC_ATTR_MAX` в один атрибут — несколькими кусками в пределах провода. Мусор в буфере — ноль команд.
 */
export function attrAllocCommands(pending: Readonly<Record<Attribute, number>>): Extract<TownCommand, { cmd: 'allocAttr' }>[] {
  const out: Extract<TownCommand, { cmd: 'allocAttr' }>[] = [];
  for (const attr of ATTRIBUTES as Attribute[]) {
    const want = pending[attr];
    let left = typeof want === 'number' && Number.isFinite(want) ? Math.floor(want) : 0;
    while (left > 0) {
      const n = Math.min(left, ALLOC_ATTR_MAX);
      out.push({ cmd: 'allocAttr', attr, n });
      left -= n;
    }
  }
  return out;
}
