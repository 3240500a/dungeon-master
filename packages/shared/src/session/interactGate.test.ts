import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { itemFromBaseId } from '../formulas/itemgen.js';
import { Cell, makeGrid, cellToWorld } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import type { PlayerEntity } from '../world/state.js';
import { GameSession, type PlayerInput } from './session.js';

/**
 * ⭐ C-13: КОМАНДЫ ПО ID — ПОД ТЕМ ЖЕ ПРАВИЛОМ, ЧТО [E] ТИКА. Тик пропускает мёртвых (`if (!p.alive) continue`) и после стана
 * возвращается до взаимодействия (`if (stunned) return`). Команды веб-3D по id шли мимо: рычаг (`openLever`) не смотрел, жив ли
 * герой, — труп у рычага открывал дверь всей пати; сундук по id (`openChest`) и подбор по id (`pickupDropById`) проверяли жизнь, но
 * не стан. R4-35 поставил то же правило зелью (`useConsumable`), а эти три пути остались.
 *
 * Сторож — по классу: КАЖДЫЙ путь взаимодействия с миром × КАЖДОЕ состояние «не может действовать» → отказ, мир не тронут; тот же
 * герой в силах — проходит (иначе отказ значил бы лишь «далеко»).
 */

type State = { name: string; put: (p: PlayerEntity) => void };
const DOWN: State[] = [
  { name: 'мёртв', put: (p) => { p.alive = false; p.hp = 0; } },
  { name: 'оглушён', put: (p) => { p.stunTimer = 5; } },
];

function setup() {
  const r = new ConfigRegistry();
  r.loadAll();
  const s = new GameSession(r, 5, 'normal');
  const g = makeGrid(20, 12, Cell.Floor);
  for (let x = 0; x < 20; x++) { g[0]![x] = Cell.Wall; g[11]![x] = Cell.Wall; }
  for (let y = 0; y < 12; y++) { g[y]![0] = Cell.Wall; g[y]![19] = Cell.Wall; g[y]![10] = Cell.Wall; }
  g[6]![10] = Cell.Door;
  s.addPlayer('A', newBotSave(r, 'warrior'));
  const lp = cellToWorld(8, 3), cp = cellToWorld(4, 3), dp = cellToWorld(6, 8);
  s.enterFloor(1, {
    grid: g, spawn: cellToWorld(3, 6), monsters: [],
    doors: [{ id: 1, cells: [{ cx: 10, cy: 6 }] }], levers: [{ id: 7, x: lp.x, y: lp.y, doorId: 1 }],
    chests: [{ id: 3, x: cp.x, y: cp.y, tier: r.get('chests')[0]!.id }],
  });
  const item = itemFromBaseId(r.get('items.base'), 'short-sword', r.get('item-tiers'), 'drop')!;
  s.world.drops.push({ id: 900, pos: dp, kind: 'item', item });
  const p = s.world.players['A']!;
  return { s, g, p, lp, cp, dp, item };
}
type W = ReturnType<typeof setup>;

/** Пути взаимодействия с миром: встать рядом → действие → что изменилось бы в мире. */
const PATHS: { name: string; at: (w: W) => { x: number; y: number }; act: (w: W) => unknown; changed: (w: W) => boolean }[] = [
  { name: 'рычаг по id', at: (w) => w.lp, act: (w) => w.s.openLever('A', 7), changed: (w) => w.s.world.levers[0]!.used || w.g[6]![10] !== Cell.Door },
  { name: 'сундук по id', at: (w) => w.cp, act: (w) => w.s.collectEvents(() => { w.s.openChest('A', 3); }), changed: (w) => w.s.world.chests[0]!.opened },
  { name: 'ближний сундук', at: (w) => w.cp, act: (w) => w.s.collectEvents(() => { w.s.openChest('A'); }), changed: (w) => w.s.world.chests[0]!.opened },
  { name: 'подбор по id', at: (w) => w.dp, act: (w) => w.s.pickupDropById('A', 900), changed: (w) => !w.s.world.drops.some((d) => d.id === 900) || w.p.save.inventory.some((i) => i.uid === w.item.uid) },
];

describe('⭐ C-13: мёртвый и оглушённый не взаимодействуют с миром ни одной командой', () => {
  for (const path of PATHS) {
    for (const st of DOWN) {
      it(`${path.name}: ${st.name} — отказ, мир не тронут`, () => {
        const w = setup();
        const at = path.at(w);
        w.p.pos = { x: at.x + 10, y: at.y };
        st.put(w.p);
        const res = path.act(w);
        expect(res === null || res === false || (Array.isArray(res) && res.length === 0), `ответ ${JSON.stringify(res)?.slice(0, 80)}`).toBe(true);
        expect(path.changed(w)).toBe(false);
      });
    }
    it(`${path.name}: в силах — проходит (контроль постановки)`, () => {
      const w = setup();
      const at = path.at(w);
      w.p.pos = { x: at.x + 10, y: at.y };
      path.act(w);
      expect(path.changed(w)).toBe(true);
    });
  }

  it('контроль правила тика: [E] оглушённого сундук не открывает', () => {
    const w = setup();
    w.p.pos = { x: w.cp.x + 10, y: w.cp.y };
    w.p.stunTimer = 5;
    const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: true };
    const ev = w.s.tick(1 / 30, { A: idle });
    expect(ev.some((e) => e.type === 'chest-opened')).toBe(false);
  });
});
