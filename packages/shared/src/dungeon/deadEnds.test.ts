import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { Biome, Floor, FloorAlgoParams } from '../config/schemas.js';
import type { Rng } from '../formulas/rng.js';
import { Cell, worldToCell, type Grid } from '../world/grid.js';
import {
  connectRooms, corridorTips, cutsFloor, floorReachable, mendCorridors, roomCenter, roomInterior, validate, type DungeonLayout, type Room,
} from './floorCommon.js';
import { generateFloorParams } from './generateFloor.js';
import { generateFloorFor } from './floorInputs.js';
import { resolveFloorSpec } from './floorSpec.js';
import { generateRunPlan } from './run/generateRunPlan.js';
import type { FloorSpec } from './run/types.js';

/**
 * ⭐ 15.10 (тупики, скрин владельца: крипта, этаж 7, катакомбы — коридор шириной 2 из комнаты 37,33 9×6 ушёл вниз (x 44–45, y 39–42) к
 * фигурной комнате 34,41 12×6 и упёрся в стену y 43, хотя пол комнаты — крест y 44 — в одной клетке). Причина и правка (`floorCommon.ts`):
 *  • КАРМАН формы: два укуса blob (или укус и край рамки) отрезают угол рамки комнаты от интерьера. Грань у кармана — пол, `pickStrip`
 *    брал её как годную, стаб `connectRooms` вставал на ПЕРВОЙ клетке пола — полу кармана, коридор кончался в нём. Теперь (`reachInterior`)
 *    стаб, не дошедший до пола, связного с центром комнаты (`roomInterior`), идёт дальше сквозь укус;
 *  • карман, куда не зашёл ни один коридор (cat436, cat492), — лоскут пола в стенах: подстраховка `mendCorridors` заделывает недостижимый пол
 *    и тупики коридоров (дотянуть до пола в паре клеток или заделать назад); колонна `decorate` не отрезает пол (`cutsFloor`);
 *  • «тупики» босс-этажей замера (~9 %) — ВОРОТА замка комнаты босса (`Cell.Door`, рычаг снаружи): детектор рисовал дверь стеной. Дверь —
 *    не тупик: сторож отличает проход к воротам (дверь впереди или сбоку полосы) сам.
 * Этажи без тупиков и карманов — байт-в-байт прежние (сверка кода HEAD со срезом вне репо; здесь — снимки `__golden__/floors_pre_*`).
 */
const reg = new ConfigRegistry();
reg.loadAll();
const biomes = reg.get('biomes') as Biome[];
const floors = reg.get('floors') as Floor[];
const crypt = biomes.find((b) => b.id === 'crypt')!;

/** Сетка из строк: '#' стена, '.' пол, 'P' колонна. */
const parse = (rows: string[]): Grid => rows.map((r) => [...r].map((ch) => (ch === '#' ? Cell.Wall : ch === 'P' ? Cell.Pillar : Cell.Floor)));
const copy = (g: Grid): Grid => g.map((r) => r.slice());

/**
 * НЕЗАВИСИМЫЙ замер владельца (детектор 15.10, `deadends.mts`): полоса пола поперёк хода 1…4, впереди и по концам — не пол, позади — две
 * такие же полосы в боковых стенах, хоть одна клетка позади — вне рамок комнат. Дверь здесь — не пол (как у детектора); `door` — у полосы
 * дверь впереди или сбоку: это проход к воротам замка, не тупик.
 */
function deadEnds(g: Grid, rooms: readonly Room[]): { x: number; y: number; w: number; door: boolean }[] {
  const F = (x: number, y: number): boolean => (g[y]?.[x] ?? Cell.Wall) === Cell.Floor;
  const D = (x: number, y: number): boolean => g[y]?.[x] === Cell.Door;
  const inRoom = (x: number, y: number): boolean => rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const out: { x: number; y: number; w: number; door: boolean }[] = [];
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const px = dy !== 0 ? 1 : 0, py = dx !== 0 ? 1 : 0;
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0]!.length; x++) {
      if (!F(x, y) || F(x - px, y - py)) continue;
      let w = 0; while (w < 6 && F(x + px * w, y + py * w)) w++;
      if (w < 1 || w > 4) continue;
      let ok = true;
      for (let k = 0; k < w && ok; k++) if (F(x + px * k + dx, y + py * k + dy) || !F(x + px * k - dx, y + py * k - dy)) ok = false;
      for (let s = 1; s <= 2 && ok; s++) {
        const bx = x - dx * s, by = y - dy * s;
        for (let k = 0; k < w && ok; k++) if (!F(bx + px * k, by + py * k)) ok = false;
        if (F(bx - px, by - py) || F(bx + px * w, by + py * w)) ok = false;
      }
      if (!ok) continue;
      let outside = false;
      for (let s = 1; s <= 3 && !outside; s++) if (!inRoom(x - dx * s, y - dy * s)) outside = true;
      if (!outside || F(x + px * w, y + py * w)) continue;
      let door = D(x - px, y - py) || D(x + px * w, y + py * w);
      for (let k = 0; k < w; k++) if (D(x + px * k + dx, y + py * k + dy)) door = true;
      out.push({ x, y, w, door });
    }
  }
  return out;
}

/** Пол вне компоненты спавна (двери проходимы, колонны — нет). */
function strayFloor(L: DungeonLayout): number {
  const g = L.grid.map((r) => r.map((c) => (c === Cell.Door ? Cell.Floor : c)));
  const s = worldToCell(L.spawn.x, L.spawn.y);
  const main = floorReachable(g, s.cx, s.cy);
  let n = 0;
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0]!.length; x++) if (L.grid[y]![x] === Cell.Floor && !main.has(`${x},${y}`)) n++;
  return n;
}

/**
 * Глухой карман комнаты: связный кусок пола рамки, не связный внутри рамки с её центром (колонны — часть комнаты), в который коридор входит
 * В ЛОБ и только с одной стороны рамки: снаружи к куску примыкает один отрезок пола на одной стороне, а клетки стороны сразу за отрезком — не пол
 * (боковые стены коридора). Так кончался коридор у скрина и у crypt-elite/178 (коридор уже кармана — признак тупиков его не видит). Коридор,
 * что идёт сквозь угол рамки (Г-коридор мимо скошенного угла round) или вдоль стороны, касается куска с двух сторон или отрезком без стен
 * по краям — это проход, не карман. Карман без хода — пол вне спавна (`strayFloor`).
 */
function deadPockets(L: DungeonLayout): number {
  const g = L.grid.map((r) => r.map((c) => (c === Cell.Pillar ? Cell.Floor : c)));
  const F = (x: number, y: number): boolean => (g[y]?.[x] ?? Cell.Wall) === Cell.Floor;
  let n = 0;
  for (const r of L.rooms) {
    const inner = roomInterior(g, r);
    if (!inner) continue;
    const inBox = (x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const seen = new Set<string>();
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (!F(x, y) || inner(x, y) || seen.has(`${x},${y}`)) continue;
      const comp: [number, number][] = [[x, y]]; seen.add(`${x},${y}`);
      for (let h = 0; h < comp.length; h++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = comp[h]![0] + dx, ny = comp[h]![1] + dy;
        if (inBox(nx, ny) && F(nx, ny) && !inner(nx, ny) && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); comp.push([nx, ny]); }
      }
      // устья: пол снаружи рамки у куска — по сторонам рамки
      const mouths = new Map<string, number[]>();
      for (const [cx, cy] of comp) for (const [dx, dy, side] of [[0, -1, 'top'], [0, 1, 'bot'], [-1, 0, 'left'], [1, 0, 'right']] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (inBox(nx, ny) || !F(nx, ny)) continue;
        mouths.set(side, [...(mouths.get(side) ?? []), dx ? ny : nx]);
      }
      if (mouths.size !== 1) continue;                     // нет устья — `strayFloor`; две стороны — проход сквозь угол
      const [side, at] = [...mouths][0]!;
      const lo = Math.min(...at), hi = Math.max(...at);
      if (hi - lo + 1 !== new Set(at).size) continue;      // не один отрезок
      const line = side === 'top' ? r.y - 1 : side === 'bot' ? r.y + r.h : side === 'left' ? r.x - 1 : r.x + r.w;
      const out = (k: number): boolean => (side === 'top' || side === 'bot' ? F(k, line) : F(line, k));
      if (out(lo - 1) || out(hi + 1)) continue;            // за отрезком пол — коридор идёт вдоль стороны
      n += comp.length;
    }
  }
  return n;
}

/**
 * ⭐ ревью: ВИСЯЧИЙ ХОД — связный кусок проходимого (пол и двери; колонны — нет) вне интерьеров комнат (интерьер — проходимое рамки, связное
 * с центром внутри рамки), который касается интерьера не больше чем одной комнаты: коридор, что ведёт из комнаты в никуда (в стену, в карман,
 * в колонну). Связка двух комнат касается двух. Так ловится и тупик, которого признак полосы не видит: коридор ширины 3 кончился колонной
 * `decorate` и стеной укуса (rift-halls, забег deep-expedition/46, n13_2), коридор уже кармана (crypt-elite/178). Ответ — клеток в таких кусках.
 */
function hangingCells(L: DungeonLayout): number {
  const g = L.grid, H = g.length, W = g[0]!.length;
  const pass = (c: number | undefined): boolean => c === Cell.Floor || c === Cell.Door;
  const owner = new Int32Array(W * H).fill(-1);
  L.rooms.forEach((r, ri) => {
    const c = roomCenter(r);
    if (!pass(g[c.cy]?.[c.cx])) return;
    const q = [c.cy * W + c.cx]; owner[q[0]!] = ri;
    for (let h = 0; h < q.length; h++) {
      const i = q[h]!, x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < r.x || ny < r.y || nx >= r.x + r.w || ny >= r.y + r.h) continue;
        const j = ny * W + nx;
        if (owner[j] === -1 && pass(g[ny]![nx])) { owner[j] = ri; q.push(j); }
      }
    }
  });
  const seen = new Uint8Array(W * H);
  let n = 0;
  for (let i0 = 0; i0 < W * H; i0++) {
    if (seen[i0] || owner[i0] !== -1 || !pass(g[(i0 / W) | 0]![i0 % W])) continue;
    const q = [i0]; seen[i0] = 1;
    const touch = new Set<number>();
    for (let h = 0; h < q.length; h++) {
      const i = q[h]!, x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !pass(g[ny]![nx])) continue;
        const j = ny * W + nx;
        if (owner[j] !== -1) touch.add(owner[j]!);
        else if (!seen[j]) { seen[j] = 1; q.push(j); }
      }
    }
    if (touch.size <= 1) n += q.length;
  }
  return n;
}

const ROOM_ALGOS = new Set(['bsp', 'rooms']);

describe('⭐ 15.10: тупики коридоров — источник (стаб до настоящего пола комнаты)', () => {
  // Окно грида этажа владельца (x 30–49, y 31–47) — ДО прорезки связки 37,33 ↔ 34,41: клетки зазора (44–45, 39–40) — стена.
  const OX = 30, OY = 31;
  const WINDOW = [
    '.............#######',   // 31
    '########.....#######',   // 32
    '#######.........####',   // 33
    '#######.........####',   // 34
    '#######.............',   // 35
    '#######.............',   // 36
    '#######..##.....####',   // 37
    '#######..##.....####',   // 38
    '####################',   // 39 (у владельца — коридор в x 44–45)
    '####################',   // 40
    '####.......###..####',   // 41
    '####.......###..####',   // 42
    '..............######',   // 43
    '................####',   // 44
    '####............####',   // 45
    '####............####',   // 46
    '####################',   // 47
  ];
  const top: Room = { x: 37 - OX, y: 33 - OY, w: 9, h: 6, type: 'small', shape: 'blob' };
  const bot: Room = { x: 34 - OX, y: 41 - OY, w: 12, h: 6, type: 'small', shape: 'blob' };
  /** `pickStrip` выбирает последнее / первое годное место полосы. */
  const pickLast = { int: (_a: number, b: number): number => b } as unknown as Rng;
  const pickFirst = { int: (a: number): number => a } as unknown as Rng;
  /** Тупики у двух комнат скрина (ходы, ушедшие за край окна, — не в счёт). */
  const near = <T extends { x: number; y: number }>(ts: T[]): T[] => ts.filter((t) => t.x + OX >= 34 && t.x + OX <= 46 && t.y + OY >= 33 && t.y + OY <= 46);

  it('карман: угол рамки нижней комнаты (44–45, 41–42) отрезан укусами от интерьера; грань у кармана — пол, и `pickStrip` берёт его', () => {
    const g = parse(WINDOW);
    const inner = roomInterior(g, bot)!;
    expect(inner(40 - OX, 44 - OY), 'центр — интерьер').toBe(true);
    for (const [x, y] of [[44, 41], [45, 41], [44, 42], [45, 42]] as const) {
      expect(g[y - OY]![x - OX], `${x},${y} — пол`).toBe(Cell.Floor);
      expect(inner(x - OX, y - OY), `${x},${y} — не интерьер`).toBe(false);
    }
    expect(inner(40 - OX, 41 - OY), 'левый верх комнаты — интерьер').toBe(true);
  });

  it('скрин владельца: связка встала на карман — стаб идёт сквозь укус до креста (44–45, 43); тупика нет, нижняя комната достижима', () => {
    const g = parse(WINDOW);
    connectRooms(g, top, bot, [top, bot], 2, pickLast);
    for (const [x, y] of [[44, 39], [45, 40], [44, 43], [45, 43]] as const) expect(g[y - OY]![x - OX], `${x},${y}`).toBe(Cell.Floor);
    expect(near(corridorTips(g, [top, bot]))).toEqual([]);
    expect(near(deadEnds(g, [top, bot]))).toEqual([]);
    const c = roomCenter(top), b = roomCenter(bot);
    expect(floorReachable(g, c.cx, c.cy).has(`${b.cx},${b.cy}`)).toBe(true);
    // прорублено ровно: зазор (39–40) и укус (43) в обоих столбцах
    const was = parse(WINDOW), changed: string[] = [];
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0]!.length; x++) if (g[y]![x] !== was[y]![x]) changed.push(`${x + OX},${y + OY}`);
    expect(changed.sort()).toEqual(['44,39', '44,40', '44,43', '45,39', '45,40', '45,43']);
  });

  it('без кармана на пути — прорезка та же, что прежде: связка в x 37–38 режет только зазор (стаб встал на пол интерьера)', () => {
    const g = parse(WINDOW), was = parse(WINDOW);
    connectRooms(g, top, bot, [top, bot], 2, pickFirst);
    const changed: string[] = [];
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0]!.length; x++) if (g[y]![x] !== was[y]![x]) changed.push(`${x + OX},${y + OY}`);
    expect(changed.sort()).toEqual(['37,39', '37,40', '38,39', '38,40']);
  });

  it('у замера владельца на гриде с прорезкой по-старому этот коридор — тупик (признак сторожа ловит случай скрина)', () => {
    const g = parse(WINDOW);
    for (const x of [44, 45]) for (const y of [39, 40]) g[y - OY]![x - OX] = Cell.Floor;   // как у владельца: стаб встал на (x, 42)
    expect(near(deadEnds(g, [top, bot])).map((t) => [t.x + OX, t.y + OY, t.w])).toEqual([[44, 42, 2]]);
    expect(near(corridorTips(g, [top, bot])).map((t) => [t.x + OX, t.y + OY, t.w, t.dx, t.dy])).toEqual([[44, 42, 2, 0, 1]]);
  });
});

describe('⭐ 15.10: подстраховка `mendCorridors` и колонна `cutsFloor`', () => {
  const R1: Room = { x: 1, y: 1, w: 4, h: 4, type: 'entrance' };
  it('тупик в клетке от пола — дотянуть: прорублена стена до комнаты, тупика нет, дальняя комната достижима', () => {
    const g = parse([
      '##################',
      '#....#######....##',
      '#..........#....##',
      '#..........#....##',
      '#....#######....##',
      '##################',
    ]);
    const R2: Room = { x: 12, y: 1, w: 4, h: 4, type: 'small' };
    expect(corridorTips(g, [R1, R2]).length).toBe(1);
    expect(mendCorridors(g, [R1, R2], roomCenter(R1))).toEqual({ sealed: 0, dug: 2 });
    expect(g[2]![11]).toBe(Cell.Floor); expect(g[3]![11]).toBe(Cell.Floor);
    expect(corridorTips(g, [R1, R2])).toEqual([]);
    expect(floorReachable(g, 3, 3).has('13,3')).toBe(true);
  });

  it('коридор никуда не ведёт — заделан назад до комнаты; комната цела', () => {
    const want = [
      '##############',
      '#....#########',
      '#....#########',
      '#....#########',
      '#....#########',
      '##############',
    ];
    const g = parse([
      '##############',
      '#....#########',
      '#..........###',
      '#..........###',
      '#....#########',
      '##############',
    ]);
    expect(mendCorridors(g, [R1], roomCenter(R1))).toEqual({ sealed: 12, dug: 0 });
    expect(g).toEqual(parse(want));
  });

  it('⭐ ревью: в комнату босса, уже связанную со спавном, тупик не прорубается (второй вход = лишние ворота) — заделан; в несвязанную — дотянут', () => {
    const B: Room = { x: 12, y: 1, w: 4, h: 4, type: 'boss' };
    const rows = [
      '##################',
      '#....#######....##',
      '#..........#....##',   // тупик (10, 2–3) в клетке от стены комнаты босса
      '#..........#....##',
      '#....#######....##',
      '##.#########.#####',   // связь спавна с комнатой босса — в обход
      '##...........#####',
      '##################',
    ];
    const g = parse(rows);
    expect(corridorTips(g, [R1, B]).map((t) => [t.x, t.y, t.w])).toEqual([[10, 2, 2]]);
    expect(mendCorridors(g, [R1, B], roomCenter(R1))).toEqual({ sealed: 12, dug: 0 });
    for (let x = 5; x <= 11; x++) { expect(g[2]![x], `${x},2`).toBe(Cell.Wall); expect(g[3]![x], `${x},3`).toBe(Cell.Wall); }
    expect(floorReachable(g, 2, 2).has('13,2'), 'босс достижим прежним ходом').toBe(true);
    // без обхода связка в комнату босса — сам этот коридор: дотягиваем
    const lone = parse(rows.map((r, y) => (y === 5 ? '##################' : y === 6 ? '##################' : r)));
    expect(mendCorridors(lone, [R1, B], roomCenter(R1))).toEqual({ sealed: 0, dug: 2 });
    expect(floorReachable(lone, 2, 2).has('13,2')).toBe(true);
  });

  it('карман без хода (cat436: угол blob за двумя укусами) — недостижимый пол заделан; достижимое не тронуто', () => {
    const rows = [
      '##########',
      '#......#.#',
      '#......###',
      '#........#',
      '#........#',
      '##########',
    ];
    const g = parse(rows);
    const room: Room = { x: 1, y: 1, w: 8, h: 4, type: 'small', shape: 'blob' };
    expect(mendCorridors(g, [room], roomCenter(room))).toEqual({ sealed: 1, dug: 0 });
    const want = parse(rows); want[1]![8] = Cell.Wall;
    expect(g).toEqual(want);
  });

  it('чистый этаж — подстраховка ничего не меняет (rooms и bsp × 40 сидов, двери открыты)', () => {
    const BSP: FloorAlgoParams = { algorithm: 'bsp', cols: 56, rows: 42, splitDepth: 4, minLeaf: 9, roomPad: 1, loops: 0.45, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 0, largeRoomArea: 80 };
    const ROOMS: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 4, ell: 2, blob: 2, round: 2, hall: 2 }, prefabChance: 0, largeRoomArea: 80 };
    for (const p of [BSP, ROOMS]) {
      for (let seed = 1; seed <= 40; seed++) {
        const L = generateFloorParams(p, seed * 7919 + 13);
        const g = L.grid.map((r) => r.map((c) => (c === Cell.Door ? Cell.Floor : c)));
        const before = copy(g);
        const s = worldToCell(L.spawn.x, L.spawn.y);
        expect(mendCorridors(g, L.rooms, s), `${p.algorithm}/${seed}`).toEqual({ sealed: 0, dug: 0 });
        expect(g).toEqual(before);
      }
    }
  });

  it('колонна не отрезает пол: единственный ход в угол — режет; посреди зала — нет', () => {
    const g = parse([
      '#######',
      '#..#..#',
      '#.....#',
      '#..#..#',
      '#######',
    ]);
    expect(cutsFloor(g, 3, 2)).toBe(true);    // между двумя половинами — одна клетка
    expect(cutsFloor(g, 1, 2)).toBe(false);   // у стены зала — обход рядом
    const hall = parse(['#####', '#...#', '#...#', '#...#', '#####']);
    expect(cutsFloor(hall, 2, 2)).toBe(false);
    expect(cutsFloor(hall, 2, 2, { x: 1, y: 1, w: 3, h: 3 })).toBe(false);
  });

  it('⭐ ревью: колонна не отрезает коридор от пола комнаты, даже если кругом через другие комнаты обход есть (связность — в рамке)', () => {
    // забег deep-expedition/46 (rift-halls, n13_2): коридор ширины 3 вошёл в рамку комнаты blob за укусом; колонна (w−3, h−3) встала
    // между ним и полом комнаты — по этажу соседи связны (кругом), а коридор кончался колонной и стеной укуса
    const g = parse([
      '#########',
      '#.......#',   // обход кругом — вне рамки комнаты
      '#.##.##.#',
      '#.......#',   // (3, 3) — клетка колонны; рамка комнаты — x 1–4, y 3–4
      '#..##.###',
      '#########',
    ]);
    const room = { x: 1, y: 3, w: 4, h: 2 };
    expect(cutsFloor(g, 3, 3), 'по всему этажу — не режет').toBe(false);
    expect(cutsFloor(g, 3, 3, room), 'в рамке — режет: (4, 3) отрезана от пола комнаты').toBe(true);
  });
});

describe('⭐ 15.10: сторож — на сотнях этажей всех биомов (забеги, катакомбы, босс-этажи) тупиков и карманов ноль', () => {
  type Case = { id: string; spec: FloorSpec; biome: Biome };
  const cases: Case[] = [];
  // забеги крипты (как замер владельца, режим run): шаблоны × сиды × глубина в сиде
  for (const tpl of reg.get('run-templates')) for (const seed of [1, 2, 3]) for (const depth of [3, 7, 11]) {
    const plan = generateRunPlan(reg, { templateId: tpl.id, biomeId: 'crypt', tier: 'normal', seed: seed * 7919 + depth, modifiers: [] });
    for (const nd of plan.nodes) if (nd.floorSpec && nd.biomeId === 'crypt' && nd.floorSpec.kind !== 'town') cases.push({ id: `${tpl.id}/${seed}/${depth}/${nd.id}`, spec: nd.floorSpec, biome: crypt });
  }
  // катакомбы, глубина 7, два выхода (этаж скрина; режим cat замера)
  const cat = floors.find((f) => f.id === 'crypt-catacombs')!;
  for (let i = 0; i < 300; i++) cases.push({ id: `cat${i}`, spec: resolveFloorSpec(crypt, cat, 7, (i * 2654435761 + 977) >>> 0, [], { exitCount: 2 }), biome: crypt });
  // каждый биом × каждый его этаж (и отдых, и босс)
  for (const b of biomes) for (const f of floors.filter((x) => x.biomeId === b.id && x.enabled !== false)) for (let seed = 1; seed <= 12; seed++) {
    cases.push({ id: `${b.id}/${f.id}/${seed}`, spec: resolveFloorSpec(b, f, f.minDepth, seed * 7919 + 13, [], { exitCount: 1 + (seed % 3) }), biome: b });
  }
  // этажи, где у кода до правки был тупик или карман (сверка HEAD ↔ срез 15.10)
  const plan = (tpl: string, seed: number, depth: number, node: string): Case => {
    const nd = generateRunPlan(reg, { templateId: tpl, biomeId: 'crypt', tier: 'normal', seed: seed * 7919 + depth, modifiers: [] }).nodes.find((n) => n.id === node)!;
    return { id: `${tpl}/${seed}/${depth}/${node}`, spec: nd.floorSpec!, biome: crypt };
  };
  const one = (bid: string, fid: string, i: number): Case => {
    const b = biomes.find((x) => x.id === bid)!, f = floors.find((x) => x.id === fid)!;
    return { id: `${bid}/${fid}/${i}`, spec: resolveFloorSpec(b, f, f.minDepth, (i * 7919 + 13) >>> 0, [], { exitCount: 1 + (i % 3) }), biome: b };
  };
  const known: Case[] = [
    plan('deep-expedition', 5, 5, 'n8_1'),        // коридор ширины 4 в карман катакомб
    plan('dungeon-standard', 38, 9, 'n4_1'),      // ширины 3 в карман сокровищницы blob
    plan('deep-expedition', 29, 11, 'n5_0'),      // босс-этаж: тупик не у ворот, а в кармане
    { id: 'cat436', spec: resolveFloorSpec(crypt, cat, 7, (436 * 2654435761 + 977) >>> 0, [], { exitCount: 2 }), biome: crypt },   // карман без хода
    one('crypt', 'crypt-elite', 178),             // коридор уже кармана: замер его не видит, карман — видит
    one('crypt', 'crypt-boss', 2),                // карман 4×2 (снимок floors_pre_statue_sets переснят по нему)
    one('labyrinth', 'rift-halls', 97),           // колонна `decorate` отрезала угол 2×3
    (() => {                                      // ⭐ ревью: колонна отрезала коридор ширины 3 от пола комнаты blob (обход кругом был)
      const nd = generateRunPlan(reg, { templateId: 'deep-expedition', biomeId: 'labyrinth', tier: 'normal', seed: 46 * 7919 + 3, modifiers: [] }).nodes.find((x) => x.id === 'n13_2')!;
      return { id: 'labyrinth/deep-expedition/46/n13_2', spec: nd.floorSpec!, biome: biomes.find((b) => b.id === nd.biomeId)! };
    })(),
    // и проходы сквозь угол рамки — не карманы (Г-коридор мимо скошенного угла round, коридор вдоль стороны blob)
    { id: 'cat666', spec: resolveFloorSpec(crypt, cat, 7, (666 * 2654435761 + 977) >>> 0, [], { exitCount: 2 }), biome: crypt },
    one('crypt', 'crypt-catacombs', 287),
    plan('deep-expedition', 17, 11, 'n8_1'),
  ];

  it('проходимость цела, тупиков (не у ворот) и пола вне спавна — ноль; у комнат rooms / bsp нет глухих карманов; ворота замка — у каждой рычаг', () => {
    let n = 0, doorEnds = 0, bossFloors = 0;
    const bad: string[] = [];
    for (const c of [...cases, ...known]) {
      const { layout: L } = generateFloorFor(reg, c.spec, c.biome);
      n++;
      expect(validate(L), c.id).toBe(true);
      const ends = deadEnds(L.grid, L.rooms);
      doorEnds += ends.filter((e) => e.door).length;
      if (L.doors.length) bossFloors++;
      const walls = ROOM_ALGOS.has(c.spec.algoParams.algorithm) ? ends.filter((e) => !e.door) : [];   // лабиринт и пещеры: глухие ходы — их рисунок
      const stray = strayFloor(L), pocket = ROOM_ALGOS.has(c.spec.algoParams.algorithm) ? deadPockets(L) : 0;
      const hanging = ROOM_ALGOS.has(c.spec.algoParams.algorithm) ? hangingCells(L) : 0;
      if (walls.length || stray || pocket || hanging) bad.push(`${c.id} (${c.spec.floorId}): тупиков ${walls.length} ${JSON.stringify(walls.slice(0, 2))}, пола вне спавна ${stray}, глухих карманов ${pocket}, висячих ходов ${hanging}`);
    }
    expect(bad, 'этажи с тупиком или карманом').toEqual([]);
    expect(n).toBeGreaterThan(900);
    expect(bossFloors, 'босс-этажи с замком в выборке').toBeGreaterThan(40);
    expect(doorEnds, '«тупики» замера у ворот замка (дверь — не тупик) в выборке есть').toBeGreaterThan(40);
  }, 180_000);
});
