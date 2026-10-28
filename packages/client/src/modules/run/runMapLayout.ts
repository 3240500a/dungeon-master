import { isWaypoint, type RunPlan, type WaypointPlaces } from '@dm/shared';
import { RUN_NODE_COLOR, runNodeLabel, waypointHint } from './runLabels.js';

/**
 * ⭐⭐ Г5 (14.10): РАСКЛАДКА КАРТЫ ЗАБЕГА — ЧИСТАЯ, БЕЗ DOM. Панель (`runMapPanel.ts`) только рисует то, что здесь
 * посчитано, а эталон порта Unity (`unityRunUiGolden.gen.test.ts` → `RunMapLayout.Build`) ЗОВЁТ ЭТУ ЖЕ ФУНКЦИЮ.
 *
 * ⚠⚠ ЗАЧЕМ ВЫНЕСЕНО. До Г5 раскладка жила внутри `render(body)` вперемешку со SVG, и генератор эталона держал её
 * КОПИЮ, а от расхождения копии с оригиналом сторожил список строк исходника (`SRC`): правка панели валила сторож, и
 * копию правили руками. Это второй источник правды о числах, которые сверяет Unity, — ровно то, чего проект не
 * допускает в других местах («редактор ≡ игра — общим обязан быть РАЗБОР входов»). Теперь источник один.
 *
 * ⚠ СТОЛБЦЫ — ОТНОСИТЕЛЬНО ПЕРВОГО СЛОЯ ОКНА (Г2): план — окно слоёв бесконечного спуска, и `depth` в нём настоящая
 * глубина. От абсолютной полотно на 500-м этаже уехало бы на 48 000 пикселей вправо, а панель выглядела бы пустой.
 */
const COL_W = 96;
const ROW_H = 66;
const PAD = 28;
const R = 16;
/**
 * ⭐ Г5: ПОЛОСА НОМЕРОВ ЭТАЖЕЙ СВЕРХУ. В конечном забеге номер был не нужен — слоёв 15, и «третий столбец» читался
 * глазами. В бесконечном спуске окно из трёх слоёв сидит на произвольной глубине, и без номера карта не отвечает на
 * единственный вопрос, который у неё спрашивают: «на каком я этаже и что на следующем».
 */
const HEAD_H = 20;
const GOLD = '#dca94b';
const EDGE_COLD = '#4a4640';
const STROKE_COLD = '#1a1a1a';
const LABEL_COLD = '#c4bca8';
export const MAP_EMPTY = 'Забег не активен — карта появится в подземелье.';
/** Типы узлов в легенде, в этом порядке. ⚠ `finale` снят: генератор таких узлов не ставит с Г2 (легенда обещала узел, которого не бывает). */
export const LEGEND_TYPES = ['combat', 'elite', 'boss', 'treasure', 'rest'] as const;

export const MAP_GEOM = { colW: COL_W, rowH: ROW_H, pad: PAD, r: R, headH: HEAD_H } as const;

export interface MapCol {
  depth: number;
  x: number;
  /** Подпись столбца — номер этажа («этаж» словом не пишем: столбцов до трёх, место дорогое). */
  label: string;
  /** Столбец узла, на котором стоит пати. */
  current: boolean;
  /** Этаж метки (привал + портал в город) — та же каденция, что у генератора и HUD. */
  waypoint: boolean;
}
export interface MapNode {
  id: string;
  type: string;
  x: number;
  y: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  ring: { r: number; stroke: string; width: number } | null;
  label: string;
  labelY: number;
  labelColor: string;
  star: boolean;
  cur: boolean;
  next: boolean;
}
export interface MapEdge { from: string; to: string; stroke: string; width: number; opacity: number }
export interface RunMapView {
  /** Забега нет — только подпись, остального не считаем. */
  empty?: string;
  head: string;
  width: number;
  height: number;
  r: number;
  cols: MapCol[];
  nodes: MapNode[];
  edges: MapEdge[];
}

function hex(n: number): string { return '#' + n.toString(16).padStart(6, '0'); }

/**
 * Схема карты по плану забега и текущему узлу. `step` — каденция меток (`balance.dungeonAccess.waypointStep`):
 * ею помечаются столбцы-привалы, и она же даёт в шапке «до метки N эт.» (общий шов с HUD — `waypointHint`).
 */
export function runMapView(plan: RunPlan | null | undefined, currentNodeId: string | null | undefined, places: WaypointPlaces, cycle: number): RunMapView {
  if (!plan) return { empty: MAP_EMPTY, head: '', width: 0, height: 0, r: R, cols: [], nodes: [], edges: [] };
  const s = places;   // ⭐ Г8-3: места порталов полосы (список) или короткая форма числом
  const byDepth = new Map<number, RunPlan['nodes']>();
  for (const n of plan.nodes) { const a = byDepth.get(n.depth) ?? []; a.push(n); byDepth.set(n.depth, a); }
  for (const a of byDepth.values()) a.sort((p, q) => p.lane - q.lane);
  const minDepth = Math.min(...plan.nodes.map((n) => n.depth));
  const maxDepth = Math.max(...plan.nodes.map((n) => n.depth));
  const maxCol = Math.max(...[...byDepth.values()].map((a) => a.length));
  const width = PAD * 2 + (maxDepth - minDepth) * COL_W;
  const height = HEAD_H + PAD * 2 + (maxCol - 1) * ROW_H;
  const midY = HEAD_H + PAD + (maxCol - 1) * ROW_H / 2;

  const pos = new Map<string, { x: number; y: number }>();
  for (const [depth, arr] of byDepth) {
    arr.forEach((n, i) => {
      const x = PAD + (depth - minDepth) * COL_W;
      const y = midY + (i - (arr.length - 1) / 2) * ROW_H;
      pos.set(n.id, { x, y });
    });
  }

  const cur = plan.nodes.find((n) => n.id === currentNodeId);
  const nextIds = new Set(cur?.edges.map((e) => e.to) ?? []);

  // ⚠ Столбцы — ПО ВОЗРАСТАНИЮ ГЛУБИНЫ, а не в порядке появления узлов: план приходит кадром, и порядок узлов в нём
  // ничем не обещан (у синтетики эталона первый узел — глубже второго). Полоса номеров обязана читаться слева направо.
  const cols: MapCol[] = [...byDepth.keys()].sort((a, b) => a - b).map((depth) => ({
    depth,
    x: PAD + (depth - minDepth) * COL_W,
    label: String(depth),
    current: cur !== undefined && cur.depth === depth,
    waypoint: isWaypoint(depth, s, cycle),
  }));

  const edges: MapEdge[] = [];
  for (const n of plan.nodes) {
    if (!pos.get(n.id)) continue;
    for (const e of n.edges) {
      if (!pos.get(e.to)) continue;
      const hot = n.id === currentNodeId;
      edges.push({ from: n.id, to: e.to, stroke: hot ? GOLD : EDGE_COLD, width: hot ? 2.5 : 1.5, opacity: hot ? 0.9 : 0.5 });
    }
  }

  const nodes: MapNode[] = [];
  for (const n of plan.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const isCur = n.id === currentNodeId;
    const isNext = nextIds.has(n.id);
    nodes.push({
      id: n.id, type: n.type, x: p.x, y: p.y,
      fill: hex(RUN_NODE_COLOR[n.type as keyof typeof RUN_NODE_COLOR] ?? 0x8a8f9a),
      stroke: isNext ? GOLD : STROKE_COLD, strokeWidth: isNext ? 2.5 : 1.5, fillOpacity: isCur || isNext ? 1 : 0.82,
      ring: isCur ? { r: R + 6, stroke: GOLD, width: 3 } : null,
      label: runNodeLabel(n.type), labelY: p.y + R + 13, labelColor: isCur ? GOLD : LABEL_COLD,
      star: n.modifiers.length > 0, cur: isCur, next: isNext,
    });
  }

  // ⭐ Г5: «до метки N эт.» — от ТЕКУЩЕГО этажа (его знает только узел пати); нет текущего узла (план показан из
  // города) — про метку молчим: считать её от края окна значило бы назвать число, которое ни о чём.
  const hint = cur ? ` · ${waypointHint(cur.depth, s, cycle)}` : '';
  return {
    head: `Биом ${plan.biomeId} · тир ${plan.tier} · этажи ${minDepth}–${maxDepth}${hint}`,
    width, height, r: R, cols, nodes, edges,
  };
}
