import { describe, it, expect } from 'vitest';
import { createTestScene, TEST_TICK_DT } from './testScene.js';
import { moveFromKeys, facingFrom, CAM_AZ } from './playerInput.js';
import { driveActor, facingToYaw, type DriveState, type DrivenDoll } from './driveActor.js';
import type { PlayerInput } from '@dm/shared';

/**
 * ВКЛАДКА «ТЕСТ» ОБЯЗАНА ВЕСТИ СЕБЯ 1:1 С КЛИЕНТОМ.
 *
 * Держится это не обещанием, а тем, что кода ОДИН экземпляр: движение — настоящий `GameSession`
 * (то же ядро, что у сервера), ввод — `playerInput`, привод куклы — `driveActor`. Здесь проверяется
 * то, что от «одного экземпляра» ещё не следует: что фиксированный шаг действительно фиксированный,
 * что поворот WASD под камеру не перевёрнут, и что скорость доезжает до куклы — именно на ней живёт
 * вся походка, и обнулись она, настройщик увидел бы idle вместо бега и пошёл бы чинить исправное.
 */
const idle: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
const go = (x: number, y: number): PlayerInput => ({ ...idle, move: { x, y } });

describe('ядро сцены — серверное, а не своё', () => {
  it('персонаж едет туда, куда сказали', () => {
    const s = createTestScene('warrior');
    const x0 = s.view.x;
    for (let i = 0; i < 30; i++) s.step(TEST_TICK_DT, go(1, 0));
    expect(s.view.x).toBeGreaterThan(x0 + 10);
  });

  it('упирается в стену, а не проходит сквозь неё', () => {
    const s = createTestScene('warrior');
    for (let i = 0; i < 600; i++) s.step(TEST_TICK_DT, go(-1, 0));
    const stuck = s.view.x;
    for (let i = 0; i < 60; i++) s.step(TEST_TICK_DT, go(-1, 0));
    expect(Math.abs(s.view.x - stuck), 'дальше стены не уехал').toBeLessThan(0.01);
    expect(s.view.x).toBeGreaterThan(0);
  });

  it('ШАГ ФИКСИРОВАННЫЙ: два кадра по 1/60 дают ровно один тик, как у сервера', () => {
    const a = createTestScene('warrior');
    const b = createTestScene('warrior');
    for (let i = 0; i < 60; i++) a.step(TEST_TICK_DT, go(1, 0));
    for (let i = 0; i < 120; i++) b.step(1 / 60, go(1, 0));
    // Одно и то же ВРЕМЯ, разной нарезкой: 60 кадров по тику против 120 по полтика. Накопитель
    // обязан выдать те же 60 тиков — иначе на 144 Гц мир поедет не так, как на 30.
    expect(b.view.x).toBeCloseTo(a.view.x, 9);
  });

  it('рваный кадр не разгоняет и не тормозит мир', () => {
    const a = createTestScene('warrior');
    const b = createTestScene('warrior');
    for (let i = 0; i < 90; i++) a.step(TEST_TICK_DT, go(0, 1));
    // Те же 90 тиков, но кадры приходят рывками: два пустых, третий — за все три.
    let acc = 0;
    for (let i = 0; i < 90; i++) {
      acc += TEST_TICK_DT;
      if (i % 3 === 2) { b.step(acc, go(0, 1)); acc = 0; } else b.step(0, go(0, 1));
    }
    expect(b.view.z).toBeCloseTo(a.view.z, 6);
  });

  it('сброс возвращает в центр', () => {
    const s = createTestScene('warrior');
    for (let i = 0; i < 60; i++) s.step(TEST_TICK_DT, go(1, 1));
    const moved = { x: s.view.x, z: s.view.z };
    s.reset();
    expect(s.view.x).not.toBeCloseTo(moved.x, 1);
  });

  it('персонаж редактора может быть монстром — тогда играем за воина, а не падаем', () => {
    expect(() => createTestScene('zombie-brute')).not.toThrow();
  });
});

describe('ввод — общий с клиентом', () => {
  it('W — «вверх по экрану» при повороте камеры на 45°, а не по мировой оси', () => {
    const w = moveFromKeys(new Set(['KeyW']), CAM_AZ);
    expect(w.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(w.y).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('A и D строго противоположны, диагональ не нормализуется (это делает сервер)', () => {
    const a = moveFromKeys(new Set(['KeyA']), CAM_AZ), d = moveFromKeys(new Set(['KeyD']), CAM_AZ);
    expect(a.x).toBeCloseTo(-d.x, 9); expect(a.y).toBeCloseTo(-d.y, 9);
    expect(Math.hypot(...Object.values(moveFromKeys(new Set(['KeyW', 'KeyD']), CAM_AZ)))).toBeCloseTo(Math.SQRT2, 9);
  });

  it('курсор ведёт прицел, но только за мёртвой зоной — иначе он дрожит у самых ног', () => {
    expect(facingFrom(0.5, { x: 100, y: 0 }, 0, 0, { x: 0, y: 0 }, true)).toBeCloseTo(0, 9);
    expect(facingFrom(0.5, { x: 3, y: 0 }, 0, 0, { x: 0, y: 0 }, true), 'в зоне — прежний угол').toBeCloseTo(0.5, 9);
  });

  it('мышь ещё не трогали — смотрим туда, куда идём', () => {
    expect(facingFrom(0, null, 0, 0, { x: 0, y: 1 }, false)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('стоим и мышь не трогали — угол держится, а не сваливается в ноль', () => {
    expect(facingFrom(1.23, null, 0, 0, { x: 0, y: 0 }, false)).toBeCloseTo(1.23, 9);
  });
});

describe('привод куклы', () => {
  const doll = (): { d: DrivenDoll; log: { move: number[]; yaw: number[]; vel: [number, number][] } } => {
    const log = { move: [] as number[], yaw: [] as number[], vel: [] as [number, number][] };
    return {
      log,
      d: {
        setPose: (_x, _z, y) => log.yaw.push(y),
        setWorldVel: (vx, vz) => log.vel.push([vx, vz]),
        setMove: (m) => log.move.push(m),
        setDead: () => { /* не интересует */ },
        update: () => { /* не интересует */ },
      },
    };
  };

  it('серверный facing переводится в yaw куклы одной формулой', () => {
    expect(facingToYaw(0)).toBeCloseTo(Math.PI / 2, 9);
    expect(facingToYaw(Math.PI / 2)).toBeCloseTo(0, 9);
  });

  it('СКОРОСТЬ СЧИТАЕТСЯ ИЗ ПОЗИЦИЙ — сервер её не шлёт, а без неё походки нет', () => {
    const { d, log } = doll();
    const a: DriveState = { d, vx: 0, vz: 0, lx: 0, lz: 0 };
    for (let i = 1; i <= 40; i++) driveActor(a, i * 2, 0, 0, true, 1 / 30, {});
    expect(a.vx, 'пришли к 2 ед за 1/30 с = 60 ед/с').toBeGreaterThan(55);
    expect(log.move.at(-1), 'доля хода = 60/120').toBeCloseTo(0.5, 1);
  });

  it('низкочастотный фильтр гасит рывок снапшота, а не пропускает его в позу', () => {
    const { d } = doll();
    const a: DriveState = { d, vx: 0, vz: 0, lx: 0, lz: 0 };
    driveActor(a, 0, 0, 0, true, 1 / 30, {});
    driveActor(a, 30, 0, 0, true, 1 / 30, {});   // мгновенный скачок на 30 ед
    expect(a.vx, 'в позу ушла четверть скачка, а не весь').toBeCloseTo(30 * 30 * 0.25, 6);
  });

  it('сцена и привод стыкуются: пробежка даёт кукле ненулевой ход', () => {
    const s = createTestScene('warrior');
    const { d, log } = doll();
    const a: DriveState = { d, vx: 0, vz: 0, lx: s.view.x, lz: s.view.z };
    for (let i = 0; i < 60; i++) { s.step(TEST_TICK_DT, go(1, 0)); driveActor(a, s.view.x, s.view.z, s.view.facing, s.view.alive, TEST_TICK_DT, {}); }
    expect(log.move.at(-1), 'кукла знает, что бежит').toBeGreaterThan(0.2);
  });
});
