import { describe, it, expect } from 'vitest';
import { SnapshotDelta, applyWorldDelta } from './delta.js';
import type { WorldSnapshot, PlayerView, MonsterView } from './netTypes.js';

/**
 * Дельта-снапшоты (Ф1.3). Главное требование: применение дельты к прошлому снапшоту даёт
 * ровно новый снапшот. Всё остальное — про то, чтобы дельта была маленькой.
 */
function player(id: string, x: number, over: Partial<PlayerView> = {}): PlayerView {
  return { id, x, y: 0, facing: 0, hp: 100, mana: 50, stamina: 30, alive: true, inCombat: false, stun: false, debuffs: {}, toggles: [], ...over };
}
function monster(id: number, x: number, over: Partial<MonsterView> = {}): MonsterView {
  return { id, x, y: 0, facing: 0, hp: 50, maxHp: 50, alive: true, stun: false, downed: false, debuffs: {}, r: 12, aiState: 'idle', ...over };
}
function snap(tick: number, players: PlayerView[], monsters: MonsterView[], over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { tick, players, monsters, projectiles: [], drops: [], ...over };
}

/** Сравнение по содержимому без учёта порядка сущностей. */
function sameWorld(a: WorldSnapshot, b: WorldSnapshot): void {
  const key = (e: { id: string | number }): string => String(e.id);
  expect([...a.players].sort((x, y) => key(x).localeCompare(key(y))))
    .toEqual([...b.players].sort((x, y) => key(x).localeCompare(key(y))));
  expect([...a.monsters].sort((x, y) => key(x).localeCompare(key(y))))
    .toEqual([...b.monsters].sort((x, y) => key(x).localeCompare(key(y))));
  expect(a.projectiles).toEqual(b.projectiles);
  expect([...a.drops].sort((x, y) => key(x).localeCompare(key(y))))
    .toEqual([...b.drops].sort((x, y) => key(x).localeCompare(key(y))));
}

describe('SnapshotDelta', () => {
  it('без базиса дельту не считает — нужен полный кадр', () => {
    const d = new SnapshotDelta();
    expect(d.ready).toBe(false);
    expect(d.next(snap(1, [player('p1', 0)], []))).toBeNull();
  });

  it('применение дельты воспроизводит новый снапшот точь-в-точь', () => {
    const d = new SnapshotDelta();
    const s1 = snap(1, [player('p1', 0)], [monster(1, 0), monster(2, 100)]);
    d.prime(s1);
    const s2 = snap(2, [player('p1', 5, { hp: 90 })], [monster(1, 7, { aiState: 'chase' }), monster(2, 100)]);
    const delta = d.next(s2)!;
    sameWorld(applyWorldDelta(s1, delta), s2);
  });

  it('неподвижные сущности в дельту не попадают', () => {
    const d = new SnapshotDelta();
    // Один монстр гонится, девятнадцать стоят в покое — типовая картина этажа.
    const idle = Array.from({ length: 19 }, (_, i) => monster(i + 2, 100 + i));
    d.prime(snap(1, [player('p1', 0)], [monster(1, 0), ...idle]));
    const delta = d.next(snap(2, [player('p1', 0)], [monster(1, 3), ...idle]))!;
    expect(delta.mu).toHaveLength(1);
    expect(delta.mu![0]!.id).toBe(1);
    expect(delta.mu![0]!.x).toBe(3);
    expect(delta.pu).toBeUndefined(); // игрок не двигался
  });

  it('в патч попадают только изменившиеся поля', () => {
    const d = new SnapshotDelta();
    d.prime(snap(1, [player('p1', 0)], []));
    const delta = d.next(snap(2, [player('p1', 0, { hp: 42 })], []))!;
    expect(delta.pu![0]).toEqual({ id: 'p1', hp: 42 });
  });

  it('ловит изменение дебаффов, хотя снапшот держит ССЫЛКУ на живой объект', () => {
    const d = new SnapshotDelta();
    // Именно так ведёт себя serializeWorld: кладёт ссылку, а не копию.
    const live = {} as Record<string, { stacks: number; until: number }>;
    const p = player('p1', 0, { debuffs: live });
    d.prime(snap(1, [p], []));
    live.bleed = { stacks: 2, until: 5000 };          // мутация НА МЕСТЕ
    const delta = d.next(snap(2, [p], []))!;
    expect(delta.pu?.[0]?.debuffs).toBe(live);
  });

  it('ловит смену тоглов', () => {
    const d = new SnapshotDelta();
    d.prime(snap(1, [player('p1', 0, { toggles: [] })], []));
    const delta = d.next(snap(2, [player('p1', 0, { toggles: ['aura-x'] })], []))!;
    expect(delta.pu![0]!.toggles).toEqual(['aura-x']);
  });

  it('появление и уход сущностей', () => {
    const d = new SnapshotDelta();
    d.prime(snap(1, [player('p1', 0)], [monster(1, 0)]));
    const s2 = snap(2, [player('p1', 0), player('p2', 9)], []);
    const delta = d.next(s2)!;
    expect(delta.pu!.map((p) => p.id)).toEqual(['p2']);
    expect(delta.md).toEqual([1]);
    sameWorld(applyWorldDelta(snap(1, [player('p1', 0)], [monster(1, 0)]), delta), s2);
  });

  it('дропы: только приход и уход, позиции не пересылаются', () => {
    const d = new SnapshotDelta();
    const drop = { id: 7, x: 1, y: 2, kind: 'item' as const, item: { uid: 'i1' } as never };
    d.prime(snap(1, [], [], { drops: [] }));
    const add = d.next(snap(2, [], [], { drops: [drop] }))!;
    expect(add.du).toEqual([drop]);
    const keep = d.next(snap(3, [], [], { drops: [drop] }))!;
    expect(keep.du).toBeUndefined();
    expect(keep.dd).toBeUndefined();
    const gone = d.next(snap(4, [], [], { drops: [] }))!;
    expect(gone.dd).toEqual([7]);
  });

  it('reset снимает базис', () => {
    const d = new SnapshotDelta();
    d.prime(snap(1, [player('p1', 0)], []));
    expect(d.ready).toBe(true);
    d.reset();
    expect(d.ready).toBe(false);
    expect(d.next(snap(2, [player('p1', 0)], []))).toBeNull();
  });

  it('серия из десяти дельт сходится к тому же миру, что и прямая сборка', () => {
    const d = new SnapshotDelta();
    let cur = snap(0, [player('p1', 0)], [monster(1, 0), monster(2, 50)]);
    d.prime(cur);
    let applied = cur;
    for (let i = 1; i <= 10; i++) {
      const next = snap(i, [player('p1', i, { hp: 100 - i })], [monster(1, i * 2), monster(2, 50)]);
      applied = applyWorldDelta(applied, d.next(next)!);
      cur = next;
      sameWorld(applied, cur);
    }
  });
});

describe('стан игрока переживает дельту', () => {
  /**
   * ⚠ Ровно тот класс бага, что уже ловили на `inCombat`: если флаг не попадает в подпись строки,
   * «погас» по дельте не доедет, и клиент останется оглушённым навсегда. Замер тогда был
   * 594 расхождения из 602 сверок — поэтому поле обязательное и сверяется здесь.
   */
  it('поднялся и погас — оба перехода доезжают', () => {
    const d = new SnapshotDelta();
    const a = snap(1, [player('p', 0)], []);
    const b = snap(2, [player('p', 0, { stun: true })], []);
    const c = snap(3, [player('p', 0, { stun: false })], []);
    d.prime(a);
    const toB = d.next(b)!;
    expect(JSON.stringify(toB), 'подъём флага попал в дельту').toContain('stun');
    sameWorld(applyWorldDelta(a, toB), b);
    const toC = d.next(c)!;
    expect(JSON.stringify(toC), 'и падение флага тоже').toContain('stun');
    sameWorld(applyWorldDelta(b, toC), c);
  });

  it('флаг не менялся — в дельту не лезет', () => {
    const d = new SnapshotDelta();
    const a = snap(1, [player('p', 0, { stun: true })], []);
    d.prime(a);
    const same = d.next(snap(2, [player('p', 0, { stun: true })], []));
    expect(JSON.stringify(same ?? {})).not.toContain('stun');
  });
});
