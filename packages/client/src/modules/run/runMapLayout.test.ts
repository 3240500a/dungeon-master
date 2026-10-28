/**
 * ⭐⭐ Г5 (14.10): СТОРОЖ РАСКЛАДКИ КАРТЫ ЗАБЕГА (`runMapLayout.runMapView`).
 *
 * ЗАЧЕМ. Раскладка перестала быть частью панели и стала ЕДИНСТВЕННЫМ источником чисел, которые сверяет порт Unity
 * (`RunMapLayout.Build` против раздела `runMap` эталона). Пока она жила внутри `render(body)`, её нельзя было позвать
 * из теста вовсе — проверялась только копия в генераторе, то есть не то, что рисует игра.
 *
 * Что файл обязан валить: абсолютные столбцы вместо относительных (окно на 500-м этаже уехало бы за 48 000 px);
 * порядок столбцов «как пришли узлы» вместо возрастания глубины; потерю полосы номеров; метку-привал не по каденции
 * баланса; «до метки» от края окна вместо текущего узла; обещание метки, когда текущего узла нет.
 */
import { describe, it, expect } from 'vitest';
import type { RunPlan } from '@dm/shared';
import { runMapView, MAP_GEOM, MAP_EMPTY } from './runMapLayout.js';

/** ⭐⭐ Г8-2: цикл контента. Раскладке он нужен только для метки-привала (место в полосе), и в этом файле
 * он стоит ЯВНЫМ числом: сторож раскладки не должен зависеть от того, что сейчас в конфиге. */
const CYCLE = 20;

type Node = RunPlan['nodes'][number];
const node = (id: string, type: string, depth: number, lane: number, to: string[] = [], mods: string[] = []): Node =>
  ({ id, type, depth, lane, biomeId: 'crypt', floorSpec: {}, modifiers: mods, edges: to.map((t) => ({ to: t })) } as unknown as Node);

/** Окно трёх слоёв на произвольной глубине: слой `d` шириной 1, `d+1` шириной 2, `d+2` шириной 1. */
function plan(d: number): RunPlan {
  return {
    biomeId: 'crypt', tier: 'normal', seed: 7, startId: `n${d}_0`, runModifiers: [],
    nodes: [
      // ⚠ Порядок узлов НАМЕРЕННО не по глубине: план приходит кадром, и порядок в нём ничем не обещан.
      node(`n${d + 2}_0`, 'combat', d + 2, 0),
      node(`n${d}_0`, 'combat', d, 0, [`n${d + 1}_0`, `n${d + 1}_1`]),
      node(`n${d + 1}_1`, 'elite', d + 1, 1, [`n${d + 2}_0`], ['boon-cache']),
      node(`n${d + 1}_0`, 'rest', d + 1, 0, [`n${d + 2}_0`]),
    ],
  } as unknown as RunPlan;
}

describe('⭐⭐ Г5: раскладка карты забега', () => {
  it('ЗАБЕГА НЕТ: только подпись — остальное не считается', () => {
    const v = runMapView(null, null, 3, CYCLE);
    expect(v.empty).toBe(MAP_EMPTY);
    expect([v.cols.length, v.nodes.length, v.edges.length]).toEqual([0, 0, 0]);
  });

  it('СТОЛБЦЫ — ОТ ПЕРВОГО СЛОЯ ОКНА: раскладка этажа 500 бит в бит как этажа 1 (сдвинут только номер)', () => {
    const shallow = runMapView(plan(1), 'n1_0', 3, CYCLE);
    const deep = runMapView(plan(500), 'n500_0', 3, CYCLE);
    const geom = (v: ReturnType<typeof runMapView>): unknown => ({
      width: v.width, height: v.height,
      cols: v.cols.map((c) => ({ x: c.x, current: c.current })),
      nodes: v.nodes.map((n) => ({ x: n.x, y: n.y, fill: n.fill, label: n.label, cur: n.cur, next: n.next })),
    });
    expect(geom(deep)).toEqual(geom(shallow));
    expect(deep.width).toBe(MAP_GEOM.pad * 2 + 2 * MAP_GEOM.colW);
    // ⚠ Номера — настоящие глубины, а не 1,2,3: иначе игрок не знает, где он.
    expect(deep.cols.map((c) => c.label)).toEqual(['500', '501', '502']);
    console.log(`\nГ5 РАСКЛАДКА\nэтаж 1: ${shallow.width}×${shallow.height}, столбцы ${shallow.cols.map((c) => c.label).join(',')}`
      + `\nэтаж 500: ${deep.width}×${deep.height}, столбцы ${deep.cols.map((c) => c.label).join(',')}`);
  });

  it('ПОЛОСА НОМЕРОВ — ПО ВОЗРАСТАНИЮ ГЛУБИНЫ, а не в порядке узлов кадра', () => {
    const v = runMapView(plan(10), 'n10_0', 3, CYCLE);
    expect(v.cols.map((c) => c.depth)).toEqual([10, 11, 12]);
    expect(v.cols.filter((c) => c.current).map((c) => c.depth)).toEqual([10]);
  });

  it('ПРИВАЛ — ПО КАДЕНЦИИ БАЛАНСА: шаг 3 метит 12-й, шаг 2 — 10-й и 12-й', () => {
    const three = runMapView(plan(10), 'n10_0', 3, CYCLE).cols.filter((c) => c.waypoint).map((c) => c.depth);
    const two = runMapView(plan(10), 'n10_0', 2, CYCLE).cols.filter((c) => c.waypoint).map((c) => c.depth);
    expect([three, two]).toEqual([[12], [10, 12]]);
    // Мусорный шаг — как шаг 1 (вторая линия к схеме): метка на каждом этаже, а не «ни одной».
    expect(runMapView(plan(10), 'n10_0', Number.NaN, CYCLE).cols.every((c) => c.waypoint)).toBe(true);
  });

  it('«ДО МЕТКИ» В ШАПКЕ — ОТ ТЕКУЩЕГО УЗЛА; его нет (план из города) — про метку молчим', () => {
    expect(runMapView(plan(10), 'n10_0', 3, CYCLE).head).toContain('до метки 2 эт.');
    expect(runMapView(plan(12), 'n12_0', 3, CYCLE).head).toContain('метка здесь');
    const fromTown = runMapView(plan(10), null, 3, CYCLE).head;
    expect(fromTown).toContain('этажи 10–12');
    expect(fromTown).not.toContain('метк');
    // Узел, которого в окне нет (кадр отстал) — тот же случай «текущего нет».
    expect(runMapView(plan(10), 'ghost', 3, CYCLE).head).not.toContain('метк');
  });

  it('ТЕКУЩИЙ, ДОСТИЖИМЫЕ И ЗВЕЗДА: кольцо у текущего, золотая обводка у следующих, ★ у узла с модификаторами', () => {
    const v = runMapView(plan(10), 'n10_0', 3, CYCLE);
    const by = (id: string): (typeof v.nodes)[number] => v.nodes.find((n) => n.id === id)!;
    expect(by('n10_0').ring).not.toBeNull();
    expect([by('n11_0').next, by('n11_1').next, by('n12_0').next]).toEqual([true, true, false]);
    expect(by('n11_1').star).toBe(true);
    // Рёбра из текущего — «горячие», остальные нет; ребро в узел вне окна отброшено.
    const hot = v.edges.filter((e) => e.width === 2.5);
    expect(hot.map((e) => e.to).sort()).toEqual(['n11_0', 'n11_1']);
  });

  it('УЗЕЛ НЕИЗВЕСТНОГО ТИПА не ломает раскладку: своя подпись и серая заливка', () => {
    const p = plan(5);
    (p.nodes as Node[]).push(node('n5_9', 'mystery', 5, 9));
    const v = runMapView(p, 'n5_0', 3, CYCLE);
    const m = v.nodes.find((n) => n.id === 'n5_9')!;
    expect([m.label, m.fill]).toEqual(['mystery', '#8a8f9a']);
  });
});
