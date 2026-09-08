import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { GameSession } from './session.js';
import { serializeWorld } from './serialize.js';
import { SnapshotDelta, applyWorldDelta, worldChecksum } from './delta.js';
import { encodeWorldFrame, decodeWorldFrame, snapshotToDelta, emptySnapshot, WIRE_FULL, WIRE_DELTA } from './wire.js';
import { newBotSave } from '../sim/playerBot.js';
import { generateMonster } from '../formulas/monstergen.js';
import { createRng } from '../formulas/rng.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import type { PlayerInput } from './session.js';
import type { WorldSnapshot } from './netTypes.js';

/**
 * Сквозная проверка сетевого пути на РЕАЛЬНОМ движке: серверный цикл (снапшот → дельта →
 * бинарный кадр) против клиентского (раскодировать → применить) с точной сверкой по
 * контрольной сумме.
 *
 * Живой стенд показывает расхождения как число, но не говорит где; этот тест воспроизводит
 * ту же цепочку офлайн и детерминированно, поэтому отлаживать надо здесь.
 */
describe('сквозной путь снапшот → дельта → бинарь → применение', () => {
  /** Открытое поле со стенами по краю — как в других тестах сессии. */
  function field(cols: number, rows: number): Grid {
    const g = makeGrid(cols, rows, Cell.Floor);
    for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
    for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
    return g;
  }

  function makeSession(): { s: GameSession; inputs: Record<string, PlayerInput> } {
    const r = new ConfigRegistry();
    r.loadAll();
    const s = new GameSession(r, 12345, 'normal', { rewards: true });
    const grid = field(30, 20);
    s.enterFloor(0, { grid, spawn: cellToWorld(4, 4), monsters: [] });
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.addPlayer('p2', newBotSave(r, 'mage'));
    const rng = createRng(7);
    const monsters = Array.from({ length: 6 }, (_, i) => {
      const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
        { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, rng);
      const at = cellToWorld(6 + i * 2, 6);
      return { def, x: at.x, y: at.y };
    });
    s.enterFloor(1, { grid, spawn: cellToWorld(4, 4), monsters });
    const inputs: Record<string, PlayerInput> = {
      p1: { move: { x: 0.7, y: 0.3 }, facing: 0.4, attack: true, cast: null, interact: false },
      p2: { move: { x: -0.5, y: 0.8 }, facing: 2.1, attack: true, cast: null, interact: false },
    };
    return { s, inputs };
  }

  /**
   * Прогон серверного цикла против клиентского. `aoiRadius > 0` включает область интереса
   * (Ф1.2) с тем же гистерезисом, что на сервере: именно она — главный подозреваемый, когда
   * офлайн всё сходится, а на живом сервере расхождения есть.
   */
  function runPipeline(ticks: number, aoiRadius: number): { bad: number; firstBad: string } {
    const { s, inputs } = makeSession();
    const delta = new SnapshotDelta();
    let mine: WorldSnapshot | undefined;
    let visible = new Set<number>();
    let bad = 0;
    let firstBad = '';

    for (let tick = 1; tick <= ticks; tick++) {
      s.tick(1 / 30, inputs);
      const full0 = serializeWorld(s.world);
      // Персональный вид как в Room.viewFor: игроки всегда, остальное по радиусу с гистерезисом.
      const me = s.world.players['p1']!;
      const rIn2 = aoiRadius * aoiRadius;
      const rOut2 = (aoiRadius * 1.2) * (aoiRadius * 1.2);
      const near = (x: number, y: number, r2: number): boolean => {
        const dx = x - me.pos.x, dy = y - me.pos.y;
        return dx * dx + dy * dy <= r2;
      };
      const view: WorldSnapshot = aoiRadius <= 0 ? full0 : {
        tick: full0.tick,
        players: full0.players,
        monsters: full0.monsters.filter((m) => near(m.x, m.y, visible.has(m.id) ? rOut2 : rIn2)),
        projectiles: full0.projectiles.filter((r) => near(r.x, r.y, rIn2)),
        drops: full0.drops.filter((d) => near(d.x, d.y, rIn2)),
      };
      visible = new Set(view.monsters.map((m) => m.id));
      const sum = worldChecksum(view);

      // Полный кадр на старте и раз в 100 тиков — как на сервере (страховка от расхождения).
      const full = tick === 1 || tick % 100 === 0;
      const buf = full
        ? encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(view), sum })
        : encodeWorldFrame({ kind: WIRE_DELTA, delta: (delta.ready ? delta.next(view)! : snapshotToDelta(view)), sum });
      if (full) delta.prime(view);

      const f = decodeWorldFrame(buf);
      const base = f.kind === WIRE_FULL ? emptySnapshot() : mine;
      expect(base).toBeDefined();
      mine = applyWorldDelta(base!, f.delta);

      if (worldChecksum(mine) !== f.sum) {
        bad++;
        if (!firstBad) {
          // Первое расхождение — показать, ЧТО именно не сошлось.
          const diff: string[] = [];
          const byId = <T extends { id: string | number }>(a: readonly T[]): Map<string, T> =>
            new Map(a.map((e) => [String(e.id), e]));
          const mm = byId(mine.monsters), vm = byId(view.monsters);
          for (const [id, v] of vm) {
            const m = mm.get(id);
            if (!m) { diff.push(`монстр ${id} потерян клиентом`); continue; }
            for (const k of Object.keys(v) as (keyof typeof v)[]) {
              if (JSON.stringify(m[k]) !== JSON.stringify(v[k])) diff.push(`монстр ${id}.${String(k)}: ${JSON.stringify(m[k])} против ${JSON.stringify(v[k])}`);
            }
          }
          const mp = byId(mine.players), vp = byId(view.players);
          for (const [id, v] of vp) {
            const p = mp.get(id);
            if (!p) { diff.push(`игрок ${id} потерян клиентом`); continue; }
            for (const k of Object.keys(v) as (keyof typeof v)[]) {
              if (JSON.stringify(p[k]) !== JSON.stringify(v[k])) diff.push(`игрок ${id}.${String(k)}: ${JSON.stringify(p[k])} против ${JSON.stringify(v[k])}`);
            }
          }
          if (mine.projectiles.length !== view.projectiles.length) diff.push(`снарядов ${mine.projectiles.length} против ${view.projectiles.length}`);
          if (mine.drops.length !== view.drops.length) diff.push(`дропов ${mine.drops.length} против ${view.drops.length}`);
          firstBad = `тик ${tick}: ${diff.slice(0, 6).join(' | ') || 'состав совпал, разошлась только сумма'}`;
        }
      }
    }

    return { bad, firstBad };
  }

  it('300 тиков без области интереса: клиент восстанавливает мир бит-в-бит', () => {
    const r = runPipeline(300, 0);
    expect(r.bad, r.firstBad).toBe(0);
  });

  it('300 тиков С областью интереса: сущности входят и выходят, мир всё равно сходится', () => {
    const r = runPipeline(300, 260);   // радиус мал специально — чтобы монстры сновали через границу
    expect(r.bad, r.firstBad).toBe(0);
  });
});
