import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput } from './session.js';

/**
 * ⭐⭐ СОБЫТИЕ УДАРА НЕСЁТ, ВО ЧТО ПОПАЛИ. Жалоба: «звук удара играет всегда, даже если никого не
 * бьёшь; и надо привязать его к типу брони на монстре — латы один звук, кожа другой».
 *
 * «Только при попадании» чинится на КЛИЕНТЕ (звук уехал с метки клипа на событие — `animSfx`), а
 * «во что попали» обязано приехать с сервера: класс брони знает он, и выводить его в каждом клиенте
 * заново — это две правды об одном.
 */
function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }

function openField(cols: number, rows: number): Grid {
  const g = makeGrid(cols, rows, Cell.Floor);
  for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
  for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
  return g;
}
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

describe('материал цели в событии удара', () => {
  it('⭐ МОНСТР НЕСЁТ КЛАСС СВОЕЙ БРОНИ — латник латный, кожаный кожаный', () => {
    // ⚠ Мутация «не заполнять `armorClass` в `generateMonster`» валит это: все монстры зазвучали бы телом.
    const r = reg();
    const mk = (baseId: string): string | undefined => generateMonster(
      r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'), { baseId, depth: 1 }, createRng(3)).armorClass;
    expect(mk('zombie-knight'), '«Латы павшего рыцаря» — это латы').toBe('plate');
    expect(mk('zombie-raider')).toBe('leather');
    expect(mk('zombie-warlock')).toBe('quilted');
  });

  it('⭐⭐ УДАР ПО МОНСТРУ КЛАДЁТ ЕГО МАТЕРИАЛ В СОБЫТИЕ (и промах тоже — звук решает клиент)', () => {
    // ⚠ Мутация «слать `flesh` всегда» валит это: привязка звука к броне стала бы декорацией.
    const r = reg();
    const s = new GameSession(r, 5, 'normal', { rewards: false });
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);
    const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
      { baseId: 'zombie-knight', depth: 1 }, createRng(3));
    def.hp = 1e9;
    const m = cellToWorld(7, 6);
    s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: m.x, y: m.y }] });
    const facing = Math.atan2(m.y - p.pos.y, m.x - p.pos.x);
    const mats = new Set<string>();
    for (let i = 0; i < 240; i++) {
      for (const e of s.tick(1 / 60, { p1: { ...idle, facing, attack: true } })) {
        if (e.type === 'hit' && e.target === 'monster') mats.add(e.mat);
      }
    }
    expect(mats, '⚠ материал цели в событии не тот').toEqual(new Set(['plate']));
  });

  it('⭐ ПО ИГРОКУ — КЛАСС ЕГО БРОНИ: надел латы — звенит, снял — тело', () => {
    const r = reg();
    const plate = r.get('items.base').find((b) => b.kind === 'armor' && b.armorClass === 'plate' && b.slot === 'chest');
    const run = (wear: boolean): Set<string> => {
      const s = new GameSession(r, 9, 'normal', { rewards: false });
      const save = newBotSave(r, 'warrior');
      if (wear) save.equipment.chest = itemFromBaseId(r.get('items.base'), plate!.id, r.get('item-tiers'))!;
      const p = s.addPlayer('p1', save);
      p.hp = 1e9;
      const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
        { baseId: 'zombie-raider', depth: 1 }, createRng(3));
      def.hp = 1e9;
      const m = cellToWorld(7, 6);
      s.enterFloor(1, { grid: openField(20, 12), spawn: cellToWorld(6, 6), monsters: [{ def, x: m.x, y: m.y }] });
      const out = new Set<string>();
      for (let i = 0; i < 60 * 20; i++) {
        p.hp = 1e9;
        for (const e of s.tick(1 / 60, { p1: idle })) if (e.type === 'hit' && e.target === 'player') out.add(e.mat);
      }
      return out;
    };
    expect(plate, 'в базах должен быть латный нагрудник').toBeTruthy();
    expect(run(true), '⚠ латы на игроке не доехали до события').toEqual(new Set(['plate']));
    expect(run(false), '⚠ без брони это тело').toEqual(new Set(['flesh']));
  });
});
