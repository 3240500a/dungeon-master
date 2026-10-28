/**
 * ⭐⭐ Г6, кооп (15.10, решение владельца): МОНСТР ЖИРНЕЕ ЗА КАЖДОГО ЛИШНЕГО ИГРОКА — и БОЛЬШЕ НИЧЕГО НЕ МЕНЯЕТСЯ.
 *
 * ЗАЧЕМ ЭТОТ СТОРОЖ. Прибавка к жизни от числа игроков — единственное место, где заселение узла зависит не от сида и
 * глубины, а от того, сколько людей вошло. С Г2 узел обязан быть ЧИСТОЙ функцией сида и глубины: иначе продолжение
 * того же забега вдвоём дало бы другие монстры, другие редкости и другой дроп, чем соло, а запись узла в сейве
 * (`visited`, сундуки) перестала бы значить одно и то же. Поэтому множитель кладётся ПОСЛЕ `generateMonster`, и
 * сторож проверяет ровно это: совпадают id, редкости, уровни, места и число — расходится ТОЛЬКО жизнь.
 *
 * Что файл обязан валить: множитель внутри генерации (поток rng сдвинется — поедут id/редкости/места); множитель на
 * урон или число монстров (владелец просил «жирнее», а не «больнее»); соло-множитель не равный 1; потолок жизни
 * (`Math.max(1, …)`), снятый так, что монстр получает 0 жизни.
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { Cell, makeGrid } from '../world/grid.js';
import type { DungeonLayout } from './floorCommon.js';
import { spawnPacksEl } from './floor.js';

const SEED = 20251015;
const DIFF = 'normal';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}

/** Несколько залов: заселение зависит только от сида, глубины и числа игроков. */
function hall(): DungeonLayout {
  const grid = makeGrid(44, 24, Cell.Floor);
  const rooms = [
    { x: 1, y: 1, w: 8, h: 8, type: 'small', content: undefined },
    { x: 11, y: 1, w: 8, h: 8, type: 'small', content: undefined },
    { x: 21, y: 1, w: 10, h: 10, type: 'large', content: undefined },
    { x: 1, y: 12, w: 8, h: 8, type: 'small', content: undefined },
  ];
  return { grid, rooms } as unknown as DungeonLayout;
}

/** Заселение узла на `depth` для пати из `players` человек. */
function spawn(r: ConfigRegistry, depth: number, players: number): { id: string; rarity: string; level: number; hp: number; x: number; y: number }[] {
  const pool = r.get('biomes')[0]!.monsterPool;
  return spawnPacksEl(r, hall(), depth, DIFF, createRng(SEED), pool, 1, '', players).map((s) => ({
    id: s.def.id, rarity: s.def.rarity, level: s.def.level, hp: s.def.hp, x: s.x, y: s.y,
  }));
}

describe('⭐⭐ Г6, кооп: монстр жирнее за каждого игрока', () => {
  it('ЖИЗНЬ — РОВНО `1 + 0.5×(n−1)`: соло как было, вдвоём ×1.5, втроём ×2, впятером ×3', () => {
    const r = reg();
    const k = r.get('balance').coop.hpPerExtraPlayer;
    expect(k, 'штатная ручка — +50 % за лишнего игрока').toBe(0.5);
    const solo = spawn(r, 30, 1);
    expect(solo.length, 'зал заселён — иначе сторож проходит впустую').toBeGreaterThan(3);
    const rows: string[] = [];
    for (const n of [1, 2, 3, 5]) {
      const got = spawn(r, 30, n);
      const want = 1 + k * (n - 1);
      expect(got.length, `число монстров у пати ${n} — то же`).toBe(solo.length);
      got.forEach((m, i) => {
        expect(Math.round(solo[i]!.hp * want), `жизнь монстра ${i} у пати ${n}`).toBe(m.hp);
      });
      rows.push(`пати ${n}: жизнь ×${want} (первый монстр ${solo[0]!.hp} → ${got[0]!.hp}), монстров ${got.length}`);
    }
    console.log('Г6 КООП — ЖИЗНЬ ПО ЧИСЛУ ИГРОКОВ\n' + rows.join('\n'));
  });

  it('⚠⚠ МИР УЗЛА НЕ ЗАВИСИТ ОТ ЧИСЛА ИГРОКОВ: id, редкости, уровни и места — бит в бит, расходится только жизнь', () => {
    const r = reg();
    const solo = spawn(r, 47, 1), five = spawn(r, 47, 5);
    const strip = (xs: typeof solo): unknown => xs.map(({ hp, ...rest }) => rest);
    expect(strip(five), 'поток rng тот же — узел остаётся чистой функцией сида и глубины (Г2)').toEqual(strip(solo));
    expect(five.some((m, i) => m.hp !== solo[i]!.hp), 'а жизнь — другая').toBe(true);
  });

  it('ВЫКЛЮЧАЕТСЯ ОДНИМ ЧИСЛОМ: `coop.hpPerExtraPlayer: 0` — кооп жизнь не трогает', () => {
    const r = reg();
    r.reload({ balance: { ...r.get('balance'), coop: { hpPerExtraPlayer: 0 } } });
    expect(spawn(r, 30, 5)).toEqual(spawn(r, 30, 1));
  });

  it('МУСОР НА ВХОДЕ: 0 и дробное число игроков — как соло (пати меньше одного не бывает)', () => {
    const r = reg();
    const solo = spawn(r, 12, 1);
    expect(spawn(r, 12, 0)).toEqual(solo);
    expect(spawn(r, 12, 1.9)).toEqual(solo);
  });
});
