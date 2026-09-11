import { describe, it, expect } from 'vitest';
import { graphEdges, graphNodes, graphStates, BUILTIN_STATES } from './animGraphModel.js';
import type { AnimStore } from './animConfig.js';

/**
 * МОДЕЛЬ ГРАФА АНИМАЦИЙ.
 *
 * Узловой редактор легко превращается в «нарисовали и надеемся». Самое ценное в нём — рёбра
 * `interrupt`: их никто не рисует руками, они ВЫВОДЯТСЯ из приоритетов и показывают то, что иначе
 * выяснилось бы только в бою — «ты пометил падение непрерываемым, но вот это его всё равно перебьёт».
 * Поэтому вся логика живёт отдельно от DOM и проверяется здесь.
 */
const st = (states: AnimStore['x']['states']): AnimStore => ({ warrior: { states } });

describe('состояния графа', () => {
  it('встроенные есть всегда, даже при пустом конфиге', () => {
    const ids = graphStates({}, 'warrior');
    for (const b of BUILTIN_STATES) expect(ids).toContain(b);
  });

  it('заведённые автором добавляются, дублей нет', () => {
    const ids = graphStates(st({ attack: {}, cast_release: {} }), 'warrior');
    expect(ids.filter((i) => i === 'attack')).toHaveLength(1);
    expect(ids).toContain('cast_release');
  });
});

describe('узлы', () => {
  it('служебные узлы базы идут первыми и не редактируются', () => {
    const ns = graphNodes({}, 'warrior', []);
    expect(ns[0]!.id).toBe('#stance');
    expect(ns[1]!.id).toBe('#loco');
    expect(ns[0]!.base).toBe(true);
    expect(ns.find((n) => n.id === 'attack')!.base).toBe(false);
  });

  it('битая привязка видна: клипа нет — узел помечен', () => {
    const ns = graphNodes(st({ stagger: { clip: 'которого_нет' } }), 'warrior', ['stagger', 'attack']);
    expect(ns.find((n) => n.id === 'stagger')!.missing, 'привязка в никуда').toBe(true);
    expect(ns.find((n) => n.id === 'attack')!.missing, 'клип есть').toBe(false);
  });

  it('узел несёт разобранную настройку, а не сырой JSON', () => {
    const n = graphNodes(st({ knockdown_fall: { priority: 9, interruptible: false, legs: 'always' } }), 'warrior', ['knockdown_fall'])
      .find((x) => x.id === 'knockdown_fall')!;
    expect(n.priority).toBe(9);
    expect(n.interruptible).toBe(false);
    expect(n.legs).toBe('always');
    expect(n.clip, 'клип по имени состояния').toBe('knockdown_fall');
  });
});

describe('рёбра', () => {
  const kinds = (store: AnimStore, kind: string): string[] =>
    graphEdges(store, 'warrior').filter((e) => e.kind === kind).map((e) => `${e.from}→${e.to}`);

  it('из стойки идёт ребро в каждое состояние', () => {
    const from = kinds({}, 'from-base');
    for (const b of BUILTIN_STATES) expect(from).toContain(`#stance→${b}`);
  });

  it('цепочка — авторское ребро', () => {
    expect(kinds(st({ attack: { next: ['stagger'] } }), 'chain')).toContain('attack→stagger');
  });

  it('цепочка в несуществующее состояние отбрасывается, а не рисует висящее ребро', () => {
    expect(kinds(st({ attack: { next: ['нет_такого'] } }), 'chain')).toEqual([]);
  });

  it('ВЫВОДИМОЕ «перебьёт»: сильный ломает непрерываемого — это и надо увидеть', () => {
    const store = st({
      knockdown_fall: { priority: 5, interruptible: false },
      attack: { priority: 9 },
      stagger: { priority: 1 },
    });
    const ints = kinds(store, 'interrupt');
    expect(ints, 'удар сильнее падения → падение НЕ защищено').toContain('attack→knockdown_fall');
    expect(ints, 'стаггер слабее → не перебьёт').not.toContain('stagger→knockdown_fall');
  });

  it('прерываемое состояние рёбер «перебьёт» не собирает — иначе граф превратится в решётку', () => {
    const ints = kinds(st({ attack: { priority: 9 }, stagger: { priority: 1 } }), 'interrupt');
    expect(ints).toEqual([]);
  });

  it('равный приоритет непрерываемое НЕ ломает', () => {
    const ints = kinds(st({ a: { priority: 3 }, b: { priority: 3, interruptible: false } }), 'interrupt');
    expect(ints).not.toContain('a→b');
  });

  it('пустой конфиг — только служебные рёбра, ничего тревожного', () => {
    expect(graphEdges({}, 'warrior').every((e) => e.kind === 'from-base')).toBe(true);
  });
});
