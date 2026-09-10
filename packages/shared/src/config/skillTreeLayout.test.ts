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
