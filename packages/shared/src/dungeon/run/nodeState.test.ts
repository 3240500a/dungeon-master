import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { newCharacterSave } from '../../economy/newCharacter.js';
import { saveStateSchema } from '../../validation/save.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import { GameSession } from '../../session/session.js';
import { floorInit } from '../../session/serialize.js';
import {
  NODE_STATE_MAX, RUN_NODES_MAX, RUN_VISITED_MAX, copyNodeState, mergeNodeState, nodeStateFor, normalizeNodeState, noteNodeId, sameRun,
  runRecords, visitedNode, foldRunRecords, putRunRecords, putRunRecord, noteVisited, runNodeDepth,
} from './nodeState.js';
import type { RunConfig, RunNodeState, RunState } from './types.js';

/**
 * ⭐ R4-01: запись узла забега — чистые правила. Продолжение припаркованного забега собирает узел из сида заново, и эта
 * запись — единственное, что не даёт ему встать свежим (сундуки, боссы, уники по кругу). Сервер (`Room`) проверен своим
 * прогоном (`room.run.test.ts`, «раунд 4»); здесь — форма, объединение и то, как ядро собирает узел по записи.
 */
const cfgA: RunConfig = { biomeId: 'crypt', tier: 'normal', seed: 12345, modifiers: ['a', 'b'] };
const st = (over: Partial<RunNodeState> = {}): RunNodeState => ({ id: 'n1_0', el: 7, chests: [1], killed: [0, 4], levers: [], ...over });
const run = (node: unknown, over: Partial<RunState> = {}): RunState =>
  ({ config: cfgA, currentNodeId: 'n1_0', visited: ['start', 'n1_0'], node, ...over }) as RunState;

describe('R4-01: запись узла — форма и объединение', () => {
  it('тот же забег — по сиду, шаблону, биому, тиру и набору модификаторов (порядок не важен)', () => {
    expect(sameRun(cfgA, { ...cfgA, modifiers: ['b', 'a'] })).toBe(true);
    for (const other of [{ seed: 1 }, { biomeId: 'x' }, { tier: 'hell' }, { modifiers: ['a'] }]) {
      expect(sameRun(cfgA, { ...cfgA, ...other }), JSON.stringify(other)).toBe(false);
    }
  });

  it('запись из базы: мусор отбрасывается, номера — целые ≥ 0 без повторов по возрастанию, под потолком', () => {
    expect(normalizeNodeState(undefined)).toBeUndefined();
    expect(normalizeNodeState('x')).toBeUndefined();
    expect(normalizeNodeState({ id: '', el: 1 })).toBeUndefined();
    expect(normalizeNodeState({ id: 'n', el: -1 })).toBeUndefined();
    expect(normalizeNodeState({ id: 'n', el: Number.NaN })).toBeUndefined();
    expect(normalizeNodeState({ id: 'n', el: 3, chests: [3, 1, 3, -1, 1.5, '2', null], killed: 'x', levers: [2] }))
      .toEqual({ id: 'n', el: 3, chests: [1, 3], killed: [], levers: [2] });
    const huge = normalizeNodeState({ id: 'n', el: 0, killed: Array.from({ length: NODE_STATE_MAX + 50 }, (_, i) => i) })!;
    expect(huge.killed).toHaveLength(NODE_STATE_MAX);
  });

  it('объединение одного узла: взятое кем-либо взято для всех; мощь — первой записи; чужой узел не смешивается', () => {
    const a = st({ chests: [1], killed: [0, 4], levers: [2] });
    const b = st({ el: 99, chests: [3, 1], killed: [7], levers: [] });
    expect(mergeNodeState(a, b)).toEqual({ id: 'n1_0', el: 7, chests: [1, 3], killed: [0, 4, 7], levers: [2] });
    expect(mergeNodeState(a, st({ id: 'n2_0', chests: [9] }))).toEqual(a);
    expect(mergeNodeState(undefined, b)).toEqual(b);
    expect(mergeNodeState(undefined, undefined)).toBeUndefined();
    const m = mergeNodeState(a, undefined)!;
    m.chests.push(42);
    expect(a.chests, 'объединение — копия, исходник не тронут').toEqual([1]);
    const c = copyNodeState(a);
    c.killed.push(5);
    expect(a.killed).toEqual([0, 4]);
  });

  it('запись для узла — только своего забега и своего узла', () => {
    expect(nodeStateFor(run(st()), cfgA, 'n1_0')).toEqual(st());
    expect(nodeStateFor(run(st()), { ...cfgA, seed: 2 }, 'n1_0'), 'другой забег').toBeUndefined();
    expect(nodeStateFor(run(st()), cfgA, 'n2_0'), 'другой узел').toBeUndefined();
    expect(nodeStateFor(run(st({ id: 'n2_0' })), cfgA, 'n1_0'), 'запись про другой узел').toBeUndefined();
    expect(nodeStateFor(run(undefined), cfgA, 'n1_0'), 'сейв старше записи').toBeUndefined();
    expect(nodeStateFor(run({ id: 'n1_0', el: 'x' }), cfgA, 'n1_0'), 'кривая запись').toBeUndefined();
    expect(nodeStateFor(undefined, cfgA, 'n1_0')).toBeUndefined();
  });

  it('добавление номера: по возрастанию, без повторов и мусора, под потолком', () => {
    const l: number[] = [];
    expect([noteNodeId(l, 5), noteNodeId(l, 1), noteNodeId(l, 3), noteNodeId(l, 3), noteNodeId(l, -1), noteNodeId(l, 1.5)])
      .toEqual([true, true, true, false, false, false]);
    expect(l).toEqual([1, 3, 5]);
    const full = Array.from({ length: NODE_STATE_MAX }, (_, i) => i);
    expect(noteNodeId(full, NODE_STATE_MAX + 1)).toBe(false);
  });

  it('схема сейва несёт запись узла (без неё разбор сейва срезал бы её молча)', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Hero', 'c1');
    save.run = run(st());
    const r = saveStateSchema.safeParse(JSON.parse(JSON.stringify(save)));
    expect(r.success).toBe(true);
    expect((r.data!.run as RunState).node).toEqual(st());
  });
});

describe('R4-04: записи КАЖДОГО пройденного узла', () => {
  it('записи сейва — текущего узла и пройденных, слитые по id; чужой забег — пусто; мусор отброшен', () => {
    const r = run(st({ chests: [1] }), { nodes: [st({ id: 'n2_0', chests: [5] }), st({ chests: [2] }), { id: '', el: 1 }, 'x'] as never });
    const recs = runRecords(r, cfgA);
    expect(recs.map((x) => x.id).sort()).toEqual(['n1_0', 'n2_0']);
    expect(recs.find((x) => x.id === 'n1_0')!.chests, 'одна запись узла — объединение').toEqual([1, 2]);
    expect(nodeStateFor(r, cfgA, 'n2_0')!.chests, 'пройденный узел — тоже по записи').toEqual([5]);
    expect(runRecords(r, { ...cfgA, seed: 9 }), 'чужой забег').toEqual([]);
    const many = run(undefined, { nodes: Array.from({ length: RUN_NODES_MAX + 20 }, (_, i) => st({ id: `n${i}_0` })) });
    expect(runRecords(many, cfgA), 'под потолком').toHaveLength(RUN_NODES_MAX);
  });

  it('пройден ли узел — по `visited` этого забега (пройденный без записи считается взятым целиком)', () => {
    const r = run(undefined, { visited: ['n1_0', 'n2_0'] });
    expect(visitedNode(r, cfgA, 'n2_0')).toBe(true);
    expect(visitedNode(r, cfgA, 'n3_0')).toBe(false);
    expect(visitedNode(r, { ...cfgA, seed: 9 }, 'n2_0'), 'чужой забег').toBe(false);
    expect(visitedNode(undefined, cfgA, 'n1_0')).toBe(false);
  });

  it('свод: вливается НА МЕСТЕ (запись текущего узла держат по ссылке), изменение видно; раскладка по сейву — копиями', () => {
    const ledger = new Map<string, RunNodeState>();
    expect(foldRunRecords(ledger, [st({ chests: [1] })])).toBe(true);
    const cur = ledger.get('n1_0')!;
    expect(foldRunRecords(ledger, [st({ chests: [1] })]), 'нового нет').toBe(false);
    expect(foldRunRecords(ledger, [st({ chests: [3] }), st({ id: 'n2_0' })])).toBe(true);
    expect(ledger.get('n1_0'), 'тот же объект').toBe(cur);
    expect(cur.chests).toEqual([1, 3]);
    const r = run(undefined, { currentNodeId: 'n2_0' });
    putRunRecords(r, ledger.values());
    expect(r.node?.id, 'узел указателя — в node').toBe('n2_0');
    expect(r.nodes?.map((x) => x.id), 'остальные — в nodes').toEqual(['n1_0']);
    r.nodes![0]!.chests.push(99);
    expect(cur.chests, 'в сейве — копии').toEqual([1, 3]);
    putRunRecord(r, st({ id: 'n1_0', killed: [7] }));
    expect(r.nodes![0]!.killed, 'одна запись — объединением').toEqual([0, 4, 7]);
    putRunRecord(r, st({ id: 'n3_0', levers: [2] }));
    expect(r.nodes!.map((x) => x.id)).toEqual(['n1_0', 'n3_0']);
    putRunRecord(r, st({ id: 'n2_0', chests: [8] }));
    expect(r.node!.chests, 'узел указателя — объединением').toEqual([1, 8]);
  });
});

/**
 * ⭐⭐ 13.10 (Г2, Р5): СЕЙВ НЕ РАСТЁТ — ОБА СПИСКА ЗАБЕГА ЕСТЬ ОКНО САМЫХ ГЛУБОКИХ ЗАПИСЕЙ.
 *
 * Было две разные беды с одного корня «забег кончался на 15-м этаже»:
 *  • `visited` — без потолка вовсе: в бесконечном спуске запись за этаж, навсегда, в каждой записи сейва в Postgres;
 *  • `nodes` — потолок 512 ОТКАЗОМ: на 513-м этаже новые записи просто не принимались, то есть сундуки, босс и уники
 *    снова начали бы фармиться продолжением (ровно баг R4-01, против которого записи и заведены).
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ БЛОК ОБЯЗАН ВАЛИТЬ:
 *  • вернуть отказ вместо вытеснения (`if (size >= MAX) continue`) — валит «глубокая запись принимается»;
 *  • вытеснять по порядку, а не по глубине (`slice(0, MAX)`) — валит «в окне остаются САМЫЕ ГЛУБОКИЕ»;
 *  • снять защиту `keep` — валит «запись узла указателя не вытесняется»;
 *  • снять потолок `visited` — валит «список встаёт на полку».
 */
describe('⭐⭐ Г2 (Р5): окно записей — самые глубокие, вытеснением', () => {
  it('глубина узла — из его имени; мусор и чужое имя — −1 (вытесняется первым)', () => {
    expect([runNodeDepth('n1_0'), runNodeDepth('n500_2'), runNodeDepth('n10000_0')]).toEqual([1, 500, 10_000]);
    expect([runNodeDepth(undefined), runNodeDepth('start'), runNodeDepth('n5_'), runNodeDepth('nx_0')]).toEqual([-1, -1, -1, -1]);
  });

  it('`visited` — окно самых глубоких: без повторов, вошедший узел остаётся, длина встаёт на полку', () => {
    expect(noteVisited(['n1_0'], 'n2_0')).toEqual(['n1_0', 'n2_0']);
    expect(noteVisited(['n1_0', 'n2_0'], 'n2_0'), 'повтора нет').toEqual(['n1_0', 'n2_0']);
    expect(noteVisited(['n1_0', 'n1_0', 7, null, ''] as unknown[], 'n1_0'), 'мусор отброшен').toEqual(['n1_0']);
    // Спуск на 400 этажей: список не растёт, в нём — хвост самых глубоких.
    let v: string[] = [];
    for (let d = 1; d <= 400; d++) v = noteVisited(v, `n${d}_0`);
    expect(v, 'полка').toHaveLength(RUN_VISITED_MAX);
    expect(v[0]).toBe(`n${400 - RUN_VISITED_MAX + 1}_0`);
    expect(v.at(-1)).toBe('n400_0');
    // И мелкая запись уходит даже если входим в узел не самый глубокий (догоняющий напарник).
    const mixed = noteVisited([...v], 'n5_0');
    expect(mixed, 'полка держится').toHaveLength(RUN_VISITED_MAX);
    expect(mixed, 'узел, в который вошли, остаётся всегда').toContain('n5_0');
    expect(mixed, 'самый мелкий из прежних вытеснен').not.toContain(`n${400 - RUN_VISITED_MAX + 1}_0`);
  });

  it('⭐ `nodes`: ГЛУБОКАЯ запись принимается и на переполнении, вытесняя самую мелкую (прежде — отказ)', () => {
    const r = run(undefined, { currentNodeId: 'n9999_0', nodes: Array.from({ length: RUN_NODES_MAX }, (_, i) => st({ id: `n${i + 1}_0` })) });
    putRunRecord(r, st({ id: 'n9000_0', chests: [3] }));
    expect(r.nodes, 'полка').toHaveLength(RUN_NODES_MAX);
    expect(r.nodes!.map((x) => x.id), 'новая глубокая запись в сейве').toContain('n9000_0');
    expect(r.nodes!.map((x) => x.id), 'самая мелкая вытеснена').not.toContain('n1_0');
  });

  it('⭐ окно записей сейва и свода — САМЫЕ ГЛУБОКИЕ, и запись узла указателя из него не выпадает', () => {
    const nodes = Array.from({ length: RUN_NODES_MAX + 100 }, (_, i) => st({ id: `n${i + 1}_0` }));
    const recs = runRecords(run(st({ id: 'n3_0' }), { currentNodeId: 'n3_0', nodes }), cfgA);
    expect(recs, 'полка').toHaveLength(RUN_NODES_MAX);
    const depths = recs.map((x) => runNodeDepth(x.id)).sort((a, b) => a - b);
    expect(depths.at(-1), 'самая глубокая на месте').toBe(RUN_NODES_MAX + 100);
    expect(recs.map((x) => x.id), 'узел указателя не вытеснен, хоть и мелкий').toContain('n3_0');

    // Свод комнаты — то же правило, и запись узла, на котором стоит комната, держится по ссылке: вытеснить её нельзя.
    const ledger = new Map<string, RunNodeState>();
    foldRunRecords(ledger, [st({ id: 'n2_0' })], 'n2_0');
    const cur = ledger.get('n2_0')!;
    foldRunRecords(ledger, Array.from({ length: RUN_NODES_MAX + 50 }, (_, i) => st({ id: `n${i + 100}_0` })), 'n2_0');
    expect(ledger.size, 'полка').toBe(RUN_NODES_MAX);
    expect(ledger.get('n2_0'), 'тот же объект, что держит комната').toBe(cur);
    expect(ledger.has(`n${RUN_NODES_MAX + 149}_0`), 'самая глубокая принята').toBe(true);

    // Раскладка по сейву — тем же окном (узел указателя лежит отдельно, в `node`).
    const r2 = run(undefined, { currentNodeId: 'n2_0' });
    putRunRecords(r2, ledger.values());
    expect(r2.node?.id).toBe('n2_0');
    expect(r2.nodes!.length).toBeLessThanOrEqual(RUN_NODES_MAX);
    expect(Math.max(...r2.nodes!.map((x) => runNodeDepth(x.id)))).toBe(RUN_NODES_MAX + 149);
  });

  it('схема сейва стережёт ОБА потолка: сервер длиннее писать не вправе', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const save = newCharacterSave(reg, reg.get('classes')[0]!.id, 'Hero', 'c1');
    let v: string[] = [];
    for (let d = 1; d <= 600; d++) v = noteVisited(v, `n${d}_0`);
    save.run = run(st({ id: 'n600_0' }), { currentNodeId: 'n600_0', visited: v }) as never;
    expect(saveStateSchema.safeParse(JSON.parse(JSON.stringify(save))).success, 'сейв спуска на 600 этажей проходит').toBe(true);
    // А сейв, собранный МИМО окна (как его писал прежний сервер), схема отвергает — это и есть сторож потолка.
    const over = { ...save, run: { ...(save.run as unknown as RunState), visited: Array.from({ length: RUN_VISITED_MAX + 1 }, (_, i) => `n${i + 1}_0`) } };
    expect(saveStateSchema.safeParse(JSON.parse(JSON.stringify(over))).success, 'список длиннее окна — не наш сейв').toBe(false);
  });
});

describe('R4-01: ядро собирает узел по записи', () => {
  const reg = new ConfigRegistry();
  reg.loadAll();
  /** Поле 20×12: дверь в клетке (10,6), её рычаг, два сундука. */
  function layout(opts: { opened?: number[]; used?: number[]; floorLevel?: number } = {}) {
    const grid = makeGrid(20, 12, Cell.Floor);
    grid[6]![10] = Cell.Door;
    const lever = cellToWorld(4, 4);
    return {
      grid, spawn: cellToWorld(2, 2), monsters: [],
      doors: [{ id: 1, cells: [{ cx: 10, cy: 6 }] }],
      levers: [{ id: 1, x: lever.x, y: lever.y, doorId: 1, used: opts.used?.includes(1) }],
      chests: [1, 2].map((id) => ({ id, ...cellToWorld(3 + id, 2), tier: reg.get('chests')[0]!.id, opened: opts.opened?.includes(id) })),
      ...(opts.floorLevel !== undefined ? { floorLevel: opts.floorLevel } : {}),
    };
  }
  function session(): GameSession {
    const s = new GameSession(reg, 3, 'normal', { rewards: true });
    s.addPlayer('p1', newCharacterSave(reg, reg.get('classes')[0]!.id, 'Hero', 'c1'));
    return s;
  }

  it('открытый сундук не открывается второй раз — ни по id, ни ближайший; клиенту приходит открытым (⭐ 13.10)', () => {
    const s = session();
    s.enterFloor(3, layout({ opened: [1] }));
    const p = s.world.players.p1!;
    const c1 = s.world.chests.find((c) => c.id === 1)!;
    p.pos = { ...c1.pos };
    expect(s.openChest('p1', 1)).toBe(false);
    expect(s.world.drops, 'второй добычи нет').toHaveLength(0);
    // ⭐ 13.10 (владелец: «пусть сундук не пропадает»): было — открытый клиенту не приходил вовсе, и после продолжения узла его не было
    expect(floorInit('dungeon', s.world, []).chests.map((c) => [c.id, c.opened])).toEqual([[1, true], [2, undefined]]);
  });

  it('дёрнутый рычаг: дверь открыта с первого кадра, рычаг и дверь клиенту не приходят', () => {
    const s = session();
    s.enterFloor(3, layout({ used: [1] }));
    expect(s.world.grid[6]![10], 'проход открыт').toBe(Cell.Floor);
    expect(s.world.levers[0]!.used).toBe(true);
    const fi = floorInit('dungeon', s.world, []);
    expect(fi.levers).toHaveLength(0);
    expect(fi.doors, 'запертой дверь не рисуется').toHaveLength(0);
    // Без записи — как было: дверь заперта, рычаг есть.
    const t = session();
    t.enterFloor(3, layout());
    expect(t.world.grid[6]![10]).toBe(Cell.Door);
    expect(floorInit('dungeon', t.world, []).doors).toHaveLength(1);
  });

  it('уровень этажа — переданный (по полному заселению), если монстров передано меньше', () => {
    const s = session();
    s.enterFloor(3, layout({ floorLevel: 17 }));
    expect(s.world.floorLevel).toBe(17);
    s.enterFloor(3, layout());
    expect(s.world.floorLevel).toBe(0);
  });

  it('действие между тиками отдаёт свои события вызвавшему, а буфер тика не трогает', () => {
    const s = session();
    s.enterFloor(3, layout());
    const idle = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
    const tickEvents = s.tick(1 / 30, { p1: idle });
    const before = tickEvents.length;
    const p = s.world.players.p1!;
    p.pos = { ...s.world.chests[1]!.pos };
    const got = s.collectEvents(() => { s.openChest('p1', 2); });
    expect(got.some((e) => e.type === 'chest-opened' && e.id === 2), 'событие открытия — вызвавшему').toBe(true);
    expect(got.some((e) => e.type === 'item-dropped'), 'и выпавшее').toBe(true);
    expect(tickEvents, 'разосланный буфер прошлого тика не растёт').toHaveLength(before);
    expect(s.collectEvents(() => { s.openChest('p1', 2); }), 'второй раз — ничего').toHaveLength(0);
  });
});
