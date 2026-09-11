import { describe, it, expect } from 'vitest';
import { encodeWorldFrame, decodeWorldFrame, snapshotToDelta, emptySnapshot, WIRE_FULL, WIRE_DELTA, posQ, posU, angQ, angU } from './wire.js';
import { applyWorldDelta, worldChecksum } from './delta.js';
import type { WorldSnapshot, PlayerView, MonsterView } from './netTypes.js';

/**
 * Бинарный кадр (Ф1.4). Главное требование: закодировать → раскодировать → применить даёт
 * ровно тот мир, который отправляли. Величины уже проквантованы `serializeWorld`, поэтому
 * сравнение должно быть ТОЧНЫМ, а не «примерно равно».
 */
function player(id: string, x: number, over: Partial<PlayerView> = {}): PlayerView {
  return { id, x, y: 8, facing: 1.25, hp: 100, mana: 50, stamina: 30, alive: true, inCombat: false, stun: false, debuffs: {}, toggles: [], ...over };
}
function monster(id: number, x: number, over: Partial<MonsterView> = {}): MonsterView {
  return { id, x, y: 16, facing: 0.5, hp: 40, maxHp: 50, alive: true, stun: false, downed: false, debuffs: {}, r: 12, aiState: 'idle', ...over };
}
/** Величины, уже прошедшие квантование — так их кладёт serializeWorld. */
function quantized(s: WorldSnapshot): WorldSnapshot {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, x: posU(posQ(p.x)), y: posU(posQ(p.y)), facing: angU(angQ(p.facing)), hp: Math.round(p.hp), mana: Math.round(p.mana), stamina: Math.round(p.stamina) })),
    monsters: s.monsters.map((m) => ({ ...m, x: posU(posQ(m.x)), y: posU(posQ(m.y)), facing: angU(angQ(m.facing)), hp: Math.round(m.hp), maxHp: Math.round(m.maxHp) })),
  };
}

describe('квантование', () => {
  it('позиция переживает провод точно', () => {
    for (const v of [0, 0.25, 100.5, -12.75, 2239.75]) expect(posU(posQ(v))).toBe(v);
  });
  it('угол переживает провод с точностью лучше сотой градуса', () => {
    for (const a of [0, 0.5, 3.14159, 6.28, -1.5]) {
      const back = angU(angQ(a));
      const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      expect(Math.abs(back - norm)).toBeLessThan(1e-4);
    }
  });
  it('позиция вне диапазона зажимается, а не заворачивается', () => {
    expect(posQ(1e9)).toBe(32767);
    expect(posQ(-1e9)).toBe(-32768);
  });
});

describe('бинарный кадр мира', () => {
  it('полный кадр восстанавливается точь-в-точь', () => {
    const s = quantized({
      tick: 42,
      players: [player('p_abc', 100.25), player('p_def', 7.5, { alive: false, inCombat: true, toggles: ['aura'] })],
      monsters: [monster(1, 33.5), monster(70000, 12.25, { aiState: 'chase', stun: true, debuffs: { bleed: { stacks: 2 } } as never })],
      projectiles: [{ id: 5, x: 1.25, y: 2.5, owner: 'player', dom: 'fire', r: 3 }],
      drops: [{ id: 9, x: 4.75, y: 6, item: { uid: 'it_1', name: 'Меч' } as never }],
    });
    const buf = encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(s), sum: worldChecksum(s) });
    const f = decodeWorldFrame(buf);
    expect(f.kind).toBe(WIRE_FULL);
    expect(f.sum).toBe(worldChecksum(s));
    const back = applyWorldDelta(emptySnapshot(), f.delta);
    expect(back.tick).toBe(42);
    expect(back.players.sort((a, b) => a.id.localeCompare(b.id))).toEqual(s.players.sort((a, b) => a.id.localeCompare(b.id)));
    expect(back.monsters.sort((a, b) => a.id - b.id)).toEqual(s.monsters.sort((a, b) => a.id - b.id));
    expect(back.projectiles).toEqual(s.projectiles);
    expect(back.drops).toEqual(s.drops);
  });

  it('идентификатор сущности переживает 32 бита — id растут всю жизнь комнаты', () => {
    const s = quantized({ tick: 1, players: [], monsters: [monster(4_000_000_000, 10)], projectiles: [], drops: [] });
    const f = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(s), sum: 0 }));
    expect(f.delta.mu![0]!.id).toBe(4_000_000_000);
  });

  it('дельта с частичными полями восстанавливает только их', () => {
    const d = { t: 7, mu: [{ id: 3, x: 12.5, hp: 17 }], md: [4], pd: ['p_gone'] };
    const f = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: d, sum: 123 }));
    expect(f.kind).toBe(WIRE_DELTA);
    expect(f.sum).toBe(123);
    expect(f.delta.mu).toEqual([{ id: 3, x: 12.5, hp: 17 }]);
    expect(f.delta.md).toEqual([4]);
    expect(f.delta.pd).toEqual(['p_gone']);
    expect(f.delta.pu).toBeUndefined();
  });

  it('флаги не путаются между собой', () => {
    const d = { t: 1, mu: [{ id: 1, alive: false, stun: true, downed: false }] };
    const f = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: d, sum: 0 }));
    expect(f.delta.mu![0]).toEqual({ id: 1, alive: false, stun: true, downed: false });
  });

  it('патч одного флага НЕ гасит соседние (регрессия: их паковали в байт без маски присутствия)', () => {
    // Меняется только alive — inCombat в патче отсутствует и обязан остаться отсутствующим,
    // иначе клиент погасит у себя боевую стойку.
    const onlyAlive = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: { t: 1, pu: [{ id: 'p1', alive: false }] }, sum: 0 }));
    expect(onlyAlive.delta.pu![0]).toEqual({ id: 'p1', alive: false });

    const onlyCombat = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: { t: 1, pu: [{ id: 'p1', inCombat: true }] }, sum: 0 }));
    expect(onlyCombat.delta.pu![0]).toEqual({ id: 'p1', inCombat: true });

    // То же для трёх флагов монстра.
    const onlyStun = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: { t: 1, mu: [{ id: 5, stun: true }] }, sum: 0 }));
    expect(onlyStun.delta.mu![0]).toEqual({ id: 5, stun: true });

    const onlyDowned = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: { t: 1, mu: [{ id: 5, downed: true }] }, sum: 0 }));
    expect(onlyDowned.delta.mu![0]).toEqual({ id: 5, downed: true });
  });

  it('пул на проводе беззнаковый — отрицательное HP обязано зажиматься В ИСТОЧНИКЕ', () => {
    // Регрессия: при добивании hp уходит в минус, кодек пишет u32 и зажимал бы в 0 у себя —
    // сервер считал бы сумму по −2, клиент восстанавливал 0. Зажим делает serializeWorld,
    // поэтому здесь проверяем сам факт: то, что попало в кадр, переживает провод точно.
    const d = { t: 1, mu: [{ id: 2, hp: 0, alive: false }] };
    const f = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: d, sum: 0 }));
    expect(f.delta.mu![0]).toEqual({ id: 2, hp: 0, alive: false });
  });

  it('пустая дельта кодируется и раскодируется', () => {
    const f = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: { t: 0 }, sum: 0 }));
    expect(f.delta).toEqual({ t: 0 });
  });

  it('бинарный кадр заметно короче того же JSON', () => {
    const s = quantized({
      tick: 1, players: [player('p_abcdef012345', 10)],
      monsters: Array.from({ length: 30 }, (_, i) => monster(i + 1, i * 10)),
      projectiles: [], drops: [],
    });
    const delta = { t: 1, mu: s.monsters.map((m) => ({ id: m.id, x: m.x, y: m.y, facing: m.facing })) };
    const bin = encodeWorldFrame({ kind: WIRE_DELTA, delta, sum: 0 }).length;
    const json = JSON.stringify({ t: 'snapDelta', delta, sum: 0 }).length;
    expect(bin).toBeLessThan(json / 3);
  });

  it('серия дельт поверх полного кадра сходится к истине', () => {
    let truth = quantized({ tick: 0, players: [player('p1', 0)], monsters: [monster(1, 0), monster(2, 100)], projectiles: [], drops: [] });
    let mine = applyWorldDelta(emptySnapshot(), decodeWorldFrame(
      encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(truth), sum: worldChecksum(truth) }),
    ).delta);
    for (let i = 1; i <= 5; i++) {
      truth = quantized({ ...truth, tick: i, monsters: [monster(1, i * 2.25), monster(2, 100)] });
      const d = { t: i, mu: [{ id: 1, x: truth.monsters[0]!.x }] };
      const f = decodeWorldFrame(encodeWorldFrame({ kind: WIRE_DELTA, delta: d, sum: worldChecksum(truth) }));
      mine = applyWorldDelta(mine, f.delta);
      expect(worldChecksum(mine)).toBe(f.sum);
    }
  });
});
