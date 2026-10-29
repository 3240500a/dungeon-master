import { describe, it, expect } from 'vitest';
import { graphEdges, graphNodes, graphStates, levelEdges, levelNodes, BUILTIN_STATES } from './animGraphModel.js';
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

/**
 * УРОВНИ ГРАФА. Их смысл не косметический: корень показывает СТЕК СЛОЁВ, то есть тот самый контракт
 * «нижний слой не знает о верхних», ради которого Ф1 и затевалась. Если корень врёт про порядок или
 * про то, что внутри слоя пусто, — граф перестаёт быть картой системы и становится картинкой.
 */
describe('уровни (подмашины)', () => {
  it('корень — стек слоёв снизу вверх, а не куча состояний', () => {
    const ids = levelNodes({}, 'warrior', [], '').map((n) => n.id);
    expect(ids).toEqual(['#loco', '#stance', '#main', '#off', '#action']);
  });

  it('в корне ребро = «ложится поверх», цепочкой по всему стеку', () => {
    const es = levelEdges({}, 'warrior', '');
    expect(es.map((e) => `${e.from}→${e.to}`)).toEqual(['#loco→#stance', '#stance→#main', '#main→#off', '#off→#action']);
  });

  it('слой пускает внутрь, а локомоция — нет: её ручки на другой вкладке', () => {
    const ns = levelNodes({}, 'warrior', [], '');
    expect(ns.find((n) => n.id === '#action')!.enter).toBe('action');
    expect(ns.find((n) => n.id === '#loco')!.enter, 'планировщик графом не авторится').toBeUndefined();
  });

  it('счётчик на слое показывает, есть ли внутри что смотреть', () => {
    const store: AnimStore = { warrior: { items: { sword: { hand: 'main' }, shield: { hand: 'off' } } } };
    const sub = (id: string): string => levelNodes(store, 'warrior', [], '').find((n) => n.id === id)!.sub!;
    expect(sub('#main'), 'база + меч').toContain('2');
    expect(sub('#off'), 'база + щит').toContain('2');
  });

  it('предмет попадает в СВОЙ слой руки и несёт разобранную настройку', () => {
    const store: AnimStore = { warrior: { items: { torch: { hand: 'off', kind: 'additive', weight: 0.4 } } } };
    expect(levelNodes(store, 'warrior', [], 'main').map((n) => n.id), 'факел не в правой').toEqual(['#base']);
    const n = levelNodes(store, 'warrior', [], 'off').find((x) => x.id === 'torch')!;
    expect(n.sub).toContain('дельта');
    expect(n.sub).toContain('0.40');
  });

  it('в слое руки ребро идёт ОТ безоружной базы — дельта считается от неё', () => {
    const store: AnimStore = { warrior: { items: { sword: { hand: 'main' } } } };
    expect(levelEdges(store, 'warrior', 'main').map((e) => `${e.from}→${e.to}`)).toEqual(['#base→sword']);
  });

  it('битая привязка видна и на уровне стоек', () => {
    const ns = levelNodes({}, 'warrior', ['idle_none_relax'], 'stance');   // конвенция: действие_оружие_состояние
    expect(ns.find((n) => n.id === '#relax')!.missing, 'клип есть').toBe(false);
    expect(ns.find((n) => n.id === '#incombat')!.missing, 'боевой базы нет').toBe(true);
  });

  it('уровень действия — ровно тот же граф, что и раньше', () => {
    const store: AnimStore = { warrior: { states: { attack: { priority: 9 } } } };
    expect(levelNodes(store, 'warrior', [], 'action')).toEqual(graphNodes(store, 'warrior', []));
    expect(levelEdges(store, 'warrior', 'action')).toEqual(graphEdges(store, 'warrior'));
  });
});
