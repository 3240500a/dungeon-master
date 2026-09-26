import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../../config/registry.js';
import { newCharacterSave } from '../../economy/newCharacter.js';
import { saveStateSchema } from '../../validation/save.js';
import { Cell, makeGrid, cellToWorld } from '../../world/grid.js';
import { GameSession } from '../../session/session.js';
import { floorInit } from '../../session/serialize.js';
import {
  NODE_STATE_MAX, RUN_NODES_MAX, copyNodeState, mergeNodeState, nodeStateFor, normalizeNodeState, noteNodeId, sameRun,
  runRecords, visitedNode, foldRunRecords, putRunRecords, putRunRecord,
} from './nodeState.js';
import type { RunConfig, RunNodeState, RunState } from './types.js';

/**
 * ⭐ R4-01: запись узла забега — чистые правила. Продолжение припаркованного забега собирает узел из сида заново, и эта
 * запись — единственное, что не даёт ему встать свежим (сундуки, боссы, уники по кругу). Сервер (`Room`) проверен своим
 * прогоном (`room.run.test.ts`, «раунд 4»); здесь — форма, объединение и то, как ядро собирает узел по записи.
 */
const cfgA: RunConfig = { templateId: 'dungeon-standard', biomeId: 'crypt', tier: 'normal', seed: 12345, modifiers: ['a', 'b'] };
const st = (over: Partial<RunNodeState> = {}): RunNodeState => ({ id: 'n1_0', el: 7, chests: [1], killed: [0, 4], levers: [], ...over });
const run = (node: unknown, over: Partial<RunState> = {}): RunState =>
  ({ templateId: cfgA.templateId, config: cfgA, currentNodeId: 'n1_0', visited: ['start', 'n1_0'], node, ...over }) as RunState;

describe('R4-01: запись узла — форма и объединение', () => {
  it('тот же забег — по сиду, шаблону, биому, тиру и набору модификаторов (порядок не важен)', () => {
    expect(sameRun(cfgA, { ...cfgA, modifiers: ['b', 'a'] })).toBe(true);
    for (const other of [{ seed: 1 }, { templateId: 'x' }, { biomeId: 'x' }, { tier: 'hell' }, { modifiers: ['a'] }]) {
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

  it('открытый сундук не открывается второй раз — ни по id, ни ближайший; клиенту не приходит', () => {
    const s = session();
    s.enterFloor(3, layout({ opened: [1] }));
    const p = s.world.players.p1!;
    const c1 = s.world.chests.find((c) => c.id === 1)!;
    p.pos = { ...c1.pos };
    expect(s.openChest('p1', 1)).toBe(false);
    expect(s.world.drops, 'второй добычи нет').toHaveLength(0);
    expect(floorInit('dungeon', s.world, []).chests.map((c) => c.id)).toEqual([2]);
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
