import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { Cell, makeGrid, cellToWorld, type Grid } from '../world/grid.js';
import { newBotSave } from '../sim/playerBot.js';
import { GameSession, type PlayerInput, type FloorLayout } from './session.js';

/**
 * ⭐⭐ ИНЕРЦИЯ ПЕРЕМЕЩЕНИЯ (`balance.moveInertia`).
 *
 * Зачем она вообще: сервер считает позицию 30 раз в секунду, а клиент между снапшотами
 * ПРЕДСКАЗЫВАЕТ её по последней известной скорости. Пока персонаж встаёт КАК ВКОПАННЫЙ,
 * предсказание промахивается вперёд, и разницу приходится отдавать — персонаж заметно «сдаёт
 * назад» (ЗАМЕР на клиенте: перелёт 4.5 ед и 1.3 с отката). С инерцией остановка перестаёт быть
 * разрывом, и предсказывать её нечего.
 *
 * ⚠ ВЫКЛЮЧЕНА ПО УМОЛЧАНИЮ. Это изменение ГЕЙМПЛЕЯ (дистанции в бою, кайт, уклонения), а не
 * косметика, поэтому галка в конфиг-редакторе, а не константа.
 */
describe('инерция перемещения', () => {
  function reg(inertia?: { enabled: boolean; accel?: number; decel?: number }): ConfigRegistry {
    const r = new ConfigRegistry(); r.loadAll();
    if (inertia) {
      const b = r.get('balance') as unknown as { moveInertia: { enabled: boolean; accel: number; decel: number } };
      b.moveInertia = { enabled: inertia.enabled, accel: inertia.accel ?? 900, decel: inertia.decel ?? 300 };
    }
    return r;
  }
  function open(cols: number, rows: number): Grid {
    const g = makeGrid(cols, rows, Cell.Floor);
    for (let x = 0; x < cols; x++) { g[0]![x] = Cell.Wall; g[rows - 1]![x] = Cell.Wall; }
    for (let y = 0; y < rows; y++) { g[y]![0] = Cell.Wall; g[y]![cols - 1] = Cell.Wall; }
    return g;
  }
  const go: PlayerInput = { move: { x: 1, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
  const stop: PlayerInput = { ...go, move: { x: 0, y: 0 } };

  /** Прогон: N тиков бега, затем M тиков «отпустил». Возвращает путь по X после отпускания. */
  function run(r: ConfigRegistry, ticks = 40, after = 20): { path: number[]; speed: number } {
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: open(60, 20), spawn: cellToWorld(5, 10), monsters: [] } as unknown as FloorLayout);
    for (let i = 0; i < ticks; i++) s.tick(1 / 30, { p1: go });
    const p = s.world.players.p1!;
    const speed = Math.hypot(p.vel.x, p.vel.y);
    const path: number[] = [p.pos.x];
    for (let i = 0; i < after; i++) { s.tick(1 / 30, { p1: stop }); path.push(s.world.players.p1!.pos.x); }
    return { path, speed };
  }

  it('умолчание — ВЫКЛЮЧЕНА (геймплей не меняется молча)', () => {
    const b = reg().get('balance') as unknown as { moveInertia: { enabled: boolean } };
    expect(b.moveInertia.enabled).toBe(false);
  });

  it('⭐⭐ ВЫКЛЮЧЕНА — остановка мгновенная, как было', () => {
    const { path } = run(reg({ enabled: false }));
    expect(path[1]! - path[0]!, '⚠ персонаж проехал после отпускания при выключенной инерции').toBeCloseTo(0, 6);
  });

  it('⭐⭐ ВКЛЮЧЕНА — персонаж ПРОЕЗЖАЕТ и плавно встаёт', () => {
    // ⚠ Мутация «не применять инерцию» валит это: путь после отпускания будет нулевым.
    const { path, speed } = run(reg({ enabled: true, decel: 300 }));
    const slide = path[path.length - 1]! - path[0]!;
    expect(slide, '⚠ инерции нет — персонаж встал колом').toBeGreaterThan(1);
    // Тормозной путь ПО ФОРМУЛЕ, а не по волшебному числу. ⚠ Формула ДИСКРЕТНАЯ: позиция считается
    // скоростью УЖЕ ПОСЛЕ торможения за этот тик, поэтому от непрерывного `v²/(2a)` отнимается
    // ровно полшага `v·dt/2`. Замер сходится с точностью до сотых (9.33 против 9.33).
    const dt = 1 / 30;
    expect(slide, '⚠ тормозной путь не совпал с заданным ускорением')
      .toBeCloseTo(speed * speed / (2 * 300) - speed * dt / 2, 1);
    // И это именно торможение: каждый следующий шаг короче предыдущего.
    for (let i = 2; i < 8; i++) {
      expect(path[i]! - path[i - 1]!, '⚠ шаг не убывает — это не торможение').toBeLessThanOrEqual(path[i - 1]! - path[i - 2]! + 1e-9);
    }
  });

  it('⭐ РАЗГОН тоже не мгновенный', () => {
    const mk = (en: boolean): number => {
      const r = reg({ enabled: en, accel: 900 });
      const s = new GameSession(r, 7, 'normal');
      s.addPlayer('p1', newBotSave(r, 'warrior'));
      s.enterFloor(1, { grid: open(60, 20), spawn: cellToWorld(5, 10), monsters: [] } as unknown as FloorLayout);
      const x0 = s.world.players.p1!.pos.x;
      s.tick(1 / 30, { p1: go });
      return s.world.players.p1!.pos.x - x0;
    };
    expect(mk(true), '⚠ с инерцией первый тик обязан быть короче').toBeLessThan(mk(false));
  });

  it('⚠ СТАН УКОРЕНЯЕТ МГНОВЕННО — оглушённый не проезжает по инерции', () => {
    // Иначе «оглушён» перестаёт означать «стоит»: персонаж ещё полметра едет после удара.
    const r = reg({ enabled: true });
    const s = new GameSession(r, 7, 'normal');
    s.addPlayer('p1', newBotSave(r, 'warrior'));
    s.enterFloor(1, { grid: open(60, 20), spawn: cellToWorld(5, 10), monsters: [] } as unknown as FloorLayout);
    for (let i = 0; i < 40; i++) s.tick(1 / 30, { p1: go });
    const p = s.world.players.p1!;
    p.stunTimer = 1;
    const x0 = p.pos.x;
    s.tick(1 / 30, { p1: stop });
    expect(s.world.players.p1!.pos.x - x0, '⚠ оглушённый проехал по инерции').toBeCloseTo(0, 6);
  });
});
