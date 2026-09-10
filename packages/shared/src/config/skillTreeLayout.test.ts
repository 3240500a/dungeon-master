import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigRegistry } from './registry.js';

/**
 * РАСКЛАДКА ДРЕВА СКИЛОВ НЕ ДОЛЖНА НАЛЕЗАТЬ САМА НА СЕБЯ.
 *
 * Замер до перекройки: 128 пар квадратов реально перекрывались, задето 189 узлов из 367 видимых,
 * минимальное расстояние 0.00 — `b-aura-e` и `b-armor-plate-e` стояли в одной точке. Причина была
 * арифметическая: шаблон клал по три узла на ярус, и на кольце радиуса ~177 оказывалось 96 узлов.
 *
 * Проверка живёт ЗДЕСЬ, а не только в генераторе, потому что дерево можно подвинуть мышью
 * в редакторе конфигов и записать обратно в файл (`POST /api/dev/config-file`). Генератор про такую
 * правку не узнает — а этот тест узнает.
 */
let cfg: ConfigRegistry;
beforeAll(() => { cfg = new ConfigRegistry(); cfg.loadAll(); });

/** Тот же порог, что и в `scripts/gen-skill-tree.mjs`. */
const MIN_GAP = 30;

describe('древо скилов: узлы не налезают', () => {
  /**
   * Игрок видит общие ветки плюс ОДНУ свою классовую, поэтому и проверять надо каждый такой набор
   * отдельно. Классовые ветки делят вершину дерева между собой — наложение, которого никто никогда
   * не увидит, и проверка «всё дерево разом» падала бы на нём, ничего не говоря о деле.
   */
  it('в каждом видимом наборе нет пары ближе 30 единиц', () => {
    const tree = cfg.get('skill-tree');
    const universal = tree.branches.filter((b) => !b.classId).map((b) => b.id);
    const classes = tree.branches.filter((b) => b.classId).map((b) => b.id);
    expect(classes.length, 'классовые ветки вообще есть').toBeGreaterThan(0);

    let worst = { d: Infinity, a: '', b: '', set: '' };
    for (const cls of classes) {
      const vis = new Set([...universal, cls]);
      const ns = tree.nodes.filter((n) => vis.has(n.branchId));
      expect(ns.length, `набор ${cls} не пуст`).toBeGreaterThan(100);
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const d = Math.hypot(ns[i]!.x - ns[j]!.x, ns[i]!.y - ns[j]!.y);
          if (d < worst.d) worst = { d, a: ns[i]!.id, b: ns[j]!.id, set: cls };
        }
      }
    }
    expect(worst.d, `ближайшая пара: ${worst.a} ↔ ${worst.b} в наборе ${worst.set}`)
      .toBeGreaterThanOrEqual(MIN_GAP);
  });

  it('у каждого узла есть координаты и они конечны', () => {
    for (const n of cfg.get('skill-tree').nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y), n.id).toBe(true);
    }
  });
});

describe('описания собраны из чисел, а не «Активный скилл: X»', () => {
  /**
   * Жалоба была прямая: «половина скилов вообще непонятно что делают». Генератор писал буквально
   * `Активный скилл: <имя>` — то есть не говорил ничего. Тест держит планку: в описании обязано
   * быть ЧИСЛО, иначе оно снова ни о чём.
   */
  it('у каждого узла описание непустое и содержит число', () => {
    const bad: string[] = [];
    for (const n of cfg.get('skill-tree').nodes) {
      if (!n.description.trim() || !/\d/.test(n.description)) bad.push(`${n.id}: «${n.description}»`);
    }
    expect(bad, `узлов без внятного описания: ${bad.length}`).toEqual([]);
  });

  it('узел-вставка говорит, ЧТО открывает и чем за это платят', () => {
    const donors = cfg.get('skill-tree').nodes.filter((n) => n.effect.grantsInsert);
    expect(donors.length).toBeGreaterThan(0);
    for (const n of donors) {
      const ins = cfg.get('skill-inserts').find((i) => i.id === n.effect.grantsInsert)!;
      expect(n.description, n.id).toContain(ins.name);
      expect(n.description, `${n.id}: сказано про ранг`).toContain('Ранг');
    }
  });
});

describe('лестница уровней: вехи для приёмов, ровный подъём для процентов', () => {
  /**
   * Раньше уровень считался ПО ЯРУСУ — то есть по геометрии, как далеко узел от центра. Выходило
   * криво: первая активка ждала шестого уровня, пока рядом открывались проценты. Теперь уровень
   * зависит от РОЛИ узла: приёмы приходят редкими вехами, проценты подтягиваются ровно.
   */
  const nodesOf = (pred: (n: { effect: { active?: unknown; grantsInsert?: string } }) => boolean) =>
    cfg.get('skill-tree').nodes.filter(pred);

  it('активки открываются только на 2, 7, 15, 25 и 40', () => {
    const actives = nodesOf((n) => !!n.effect.active);
    expect(actives.length).toBeGreaterThan(50);
    const levels = [...new Set(actives.map((n) => n.levelReq))].sort((a, b) => a - b);
    expect(levels).toEqual([2, 7, 15, 25, 40]);
  });

  it('вставки стоят МЕЖДУ активками — вставку некуда девать без скила-носителя', () => {
    const donors = nodesOf((n) => !!n.effect.grantsInsert);
    expect(donors.length).toBeGreaterThan(0);
    for (const d of donors) {
      expect(d.levelReq, d.id).toBeGreaterThanOrEqual(5);
      expect(d.levelReq, d.id).toBeLessThanOrEqual(40);
    }
  });

  it('КАЖДАЯ ветка доходит ровно до 40 и начинается с 1', () => {
    const tree = cfg.get('skill-tree');
    for (const b of tree.branches) {
      const ns = tree.nodes.filter((n) => n.branchId === b.id);
      if (!ns.length) continue;
      const lv = ns.map((n) => n.levelReq);
      expect(Math.min(...lv), `${b.id}: вход на первом уровне`).toBe(1);
      expect(Math.max(...lv), `${b.id}: последний узел на 40-м`).toBe(40);
    }
  });

  it('подъём РОВНЫЙ: между соседними ступенями пассивов не больше 8 уровней', () => {
    const tree = cfg.get('skill-tree');
    for (const b of tree.branches) {
      const lv = tree.nodes
        .filter((n) => n.branchId === b.id && !n.effect.active && !n.effect.grantsInsert)
        .map((n) => n.levelReq).sort((x, y) => x - y);
      for (let i = 1; i < lv.length; i++) {
        expect(lv[i]! - lv[i - 1]!, `${b.id}: провал между ур.${lv[i - 1]} и ур.${lv[i]}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it('УРОВЕНЬ ПО ЦЕПОЧКЕ НЕ ПАДАЕТ', () => {
    // Узлы берутся по смежности, поэтому ребёнок с уровнем ниже родителя — обещание, которого
    // игра не сдержит: до него всё равно не дотянуться раньше родителя.
    const tree = cfg.get('skill-tree');
    const by = new Map(tree.nodes.map((n) => [n.id, n]));
    for (const [a, b] of tree.edges) {
      const pa = by.get(a), ch = by.get(b);
      if (!pa || !ch) continue;
      expect(ch.levelReq, `${a} (ур.${pa.levelReq}) → ${b}`).toBeGreaterThanOrEqual(pa.levelReq);
    }
  });
});
