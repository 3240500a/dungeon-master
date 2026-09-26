import { describe, it, expect } from 'vitest';
import { ConfigRegistry, parseTownCommand, stashDims } from '@dm/shared';
import { dropCell } from './heldItem.js';

/**
 * ⭐ R2-35: БРОШЕННЫЙ ПРЕДМЕТ — ЛИБО ЦЕЛИКОМ В СЕТКЕ, ЛИБО КОМАНДЫ НЕТ. Строгая схема сервера (`parseTownCommand`)
 * считает клетку < 0 «неверной командой»: сервер пишет в лог «невалидная команда … от <героя>» и растит
 * `dm_cmd_invalid_total` — честный игрок, бросивший вещь, взятую за правый край, у левого края сетки, выглядел бы
 * читером. Веб проверял это в двух местах своими строками, Unity не проверял вовсе; теперь правило одно
 * (`dropCell`), и Unity сверяет свой порт с ним по эталону (`town/__golden__/unity_town.json`).
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const bag = reg.get('balance').inventory;
const GRIDS = [{ cols: bag.cols, rows: bag.rows }, stashDims(reg)];
const SIZES = [[1, 1], [1, 2], [2, 2], [2, 3], [1, 4], [2, 4]] as const;

describe('⭐ R2-35: dropCell — куда ляжет держимый предмет', () => {
  it('случай из находки: 2×3, взят за правый столбец, брошен в столбец 0 — команды нет (x = −1 сервер счёл бы читом)', () => {
    expect(dropCell({ gridW: 2, gridH: 3 }, 1, 0, 0, 0, GRIDS[0]!)).toBeNull();
    expect(parseTownCommand({ cmd: 'moveItem', uid: 'u', x: -1, y: 0 }).ok, 'без проверки ушла бы невалидная команда').toBe(false);
    expect(parseTownCommand({ cmd: 'stashMove', uid: 'u', dst: 0, x: -1, y: 0 }).ok).toBe(false);
  });

  it('⭐ свойство: во всех сетках, размерах, точках захвата и клетках — либо null, либо команда проходит схему и вещь влезает', () => {
    let sent = 0, held = 0;
    for (const dims of GRIDS) for (const [w, h] of SIZES) {
      for (let gx = 0; gx < w; gx++) for (let gy = 0; gy < h; gy++) {
        for (let col = 0; col < dims.cols; col++) for (let row = 0; row < dims.rows; row++) {
          const at = dropCell({ gridW: w, gridH: h }, gx, gy, col, row, dims);
          const raw = { x: col - gx, y: row - gy };
          if (!at) {
            held++;
            // Отказ — только там, где вещь правда не легла бы целиком.
            expect(raw.x < 0 || raw.y < 0 || raw.x + w > dims.cols || raw.y + h > dims.rows).toBe(true);
            continue;
          }
          sent++;
          expect(at).toEqual(raw);
          expect(at.x + w <= dims.cols && at.y + h <= dims.rows).toBe(true);
          for (const cmd of [{ cmd: 'moveItem', uid: 'u', ...at }, { cmd: 'stashMove', uid: 'u', dst: 'inv', ...at }, { cmd: 'stashMove', uid: 'u', dst: 1, ...at }]) {
            expect(parseTownCommand(cmd).ok, JSON.stringify(cmd)).toBe(true);
          }
        }
      }
    }
    expect(sent).toBeGreaterThan(1000);
    expect(held, 'края сетки — есть и отказы').toBeGreaterThan(100);
  });
});
