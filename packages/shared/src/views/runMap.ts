import type { RunPlan } from '../dungeon/run/types.js';
import { runNodeLabel, waypointHint } from '../dungeon/run/labels.js';
import { isWaypoint, portalPlaces, type WaypointPlaces } from '../formulas/power.js';
import { hex6, jsNum, runNodeColor } from './runCommon.js';

/**
 * ⭐⭐ С-views (29.10): КАРТА ЗАБЕГА (M) — раскладку считает СЕРВЕР по своему плану (`Room.runPlan` + `runNodeId`).
 *
 * Порт `RunMapLayout.Build` (Unity `Assets/DM/UI/RunMap.cs`; исходник правила — веб `runMapLayout.runMapView`). Ключи результата —
 * поля C# `RunMapView` / `RunMapCol` / `RunMapNode` / `RunMapEdge`. Метка столбца и «до метки N эт.» — `isWaypoint`/`waypointHint`,
 * те же, что у генератора и HUD.
 */

/** Геометрия схемы (C# `RunMapLayout.ColW/RowH/Pad/R/HeadH`). */
export const RUN_MAP_GEOM = { colW: 96, rowH: 66, pad: 28, r: 16, headH: 20 } as const;
const GOLD = '#dca94b', EDGE_COLD = '#4a4640', STROKE_COLD = '#1a1a1a', LABEL_COLD = '#c4bca8';
/** Подпись «забега нет» (C# `RunMapLayout.Empty`). */
export const RUN_MAP_EMPTY = 'Забег не активен — карта появится в подземелье.';
/** Легенда: типы, подписи и цвета (C# `RunMapLayout.LegendTypes` + `WorldRules.NodeLabel/NodeColor`). */
export const RUN_MAP_LEGEND_TYPES = ['combat', 'elite', 'boss', 'treasure', 'rest'] as const;
export function runMapLegend(): { type: string; label: string; color: string }[] {
  return RUN_MAP_LEGEND_TYPES.map((t) => ({ type: t, label: runNodeLabel(t), color: hex6(runNodeColor(t)) }));
}
/**
 * Строка легенды про «⌂» — `RunMapPanel.Draw` собирал её из мест порталов своего конфига. Модель C# поля под неё не несёт
 * (предложено поле `legendNote`, см. отчёт); места — та же нормализация, что у `isWaypoint`.
 */
export function runMapLegendNote(places: WaypointPlaces, cycle: number): string {
  return `⌂ — привал с порталом в город (места ${portalPlaces(places, cycle).join(', ')} круга)`;
}

/** C# `RunMapCol`. */
export interface RunMapCol { depth: number; x: number; label: string; cur: boolean; waypoint: boolean }
/** C# `RunMapNode`. */
export interface RunMapNode {
  id: string; type: string; fill: string; stroke: string; label: string; labelColor: string;
  x: number; y: number; strokeWidth: number; fillOpacity: number; labelY: number;
  cur: boolean; next: boolean; star: boolean;
}
/** C# `RunMapEdge`. */
export interface RunMapEdge { from: string; to: string; stroke: string; width: number; opacity: number }
/** C# `RunMapView`. */
export interface RunMapModel {
  empty: string | null; head: string | null; width: number; height: number;
  cols: RunMapCol[]; nodes: RunMapNode[]; edges: RunMapEdge[];
}

type PlanLike = Pick<RunPlan, 'biomeId' | 'tier' | 'nodes'>;

/**
 * ⭐⭐ МОДЕЛЬ КАРТЫ ЗАБЕГА (C# `RunMapLayout.Build`). Сервер: `runMapPanelView(this.runPlan, this.runNodeId, access.portalsAt,
 * access.contentCycle)`. Плана нет (город, кадр отстал) — только `empty`.
 */
export function runMapPanelView(
  plan: PlanLike | null | undefined, currentNodeId: string | null | undefined, places: WaypointPlaces, cycle: number,
): RunMapModel {
  const v: RunMapModel = { empty: null, head: null, width: 0, height: 0, cols: [], nodes: [], edges: [] };
  if (!plan) { v.empty = RUN_MAP_EMPTY; return v; }
  const G = RUN_MAP_GEOM;
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  // столбцы — в порядке первого появления слоя, внутри — по полосе (сортировка устойчивая, как `OrderBy` C#)
  const byDepth = new Map<number, (typeof nodes)[number][]>();
  for (const n of nodes) { const a = byDepth.get(n.depth) ?? []; a.push(n); byDepth.set(n.depth, a); }
  for (const a of byDepth.values()) a.sort((p, q) => p.lane - q.lane);
  const minDepth = nodes.length ? Math.min(...nodes.map((n) => n.depth)) : 0;
  const maxDepth = nodes.length ? Math.max(...nodes.map((n) => n.depth)) : 0;
  const maxCol = byDepth.size ? Math.max(...[...byDepth.values()].map((a) => a.length)) : 1;
  v.width = G.pad * 2 + (maxDepth - minDepth) * G.colW;
  v.height = G.headH + G.pad * 2 + (maxCol - 1) * G.rowH;
  const midY = G.headH + G.pad + (maxCol - 1) * G.rowH / 2;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [depth, arr] of byDepth) {
    arr.forEach((n, i) => {
      if (typeof n.id === 'string') pos.set(n.id, { x: G.pad + (depth - minDepth) * G.colW, y: midY + (i - (arr.length - 1) / 2) * G.rowH });
    });
  }
  const cur = currentNodeId != null ? nodes.find((n) => n.id === currentNodeId) : undefined;
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    v.cols.push({
      depth, x: G.pad + (depth - minDepth) * G.colW, label: jsNum(depth),
      cur: cur !== undefined && cur.depth === depth, waypoint: isWaypoint(depth, places, cycle),
    });
  }
  const hint = cur ? ` · ${waypointHint(cur.depth, places, cycle)}` : '';
  v.head = `Биом ${jsNum(plan.biomeId)} · тир ${jsNum(plan.tier)} · этажи ${jsNum(minDepth)}–${jsNum(maxDepth)}${hint}`;
  const nextIds = new Set((cur?.edges ?? []).map((e) => e?.to).filter((t): t is string => typeof t === 'string'));
  for (const n of nodes) {
    if (typeof n.id !== 'string' || !pos.has(n.id)) continue;
    const hot = currentNodeId != null && n.id === currentNodeId;
    for (const e of n.edges ?? []) {
      const to = e?.to;
      if (typeof to !== 'string' || !pos.has(to)) continue;
      v.edges.push({ from: n.id, to, stroke: hot ? GOLD : EDGE_COLD, width: hot ? 2.5 : 1.5, opacity: hot ? 0.9 : 0.5 });
    }
  }
  for (const n of nodes) {
    const p = typeof n.id === 'string' ? pos.get(n.id) : undefined;
    if (!p) continue;
    const isCur = currentNodeId != null && n.id === currentNodeId;
    const isNext = nextIds.has(n.id);
    v.nodes.push({
      id: n.id, type: n.type, fill: hex6(runNodeColor(n.type)), stroke: isNext ? GOLD : STROKE_COLD, label: runNodeLabel(n.type),
      labelColor: isCur ? GOLD : LABEL_COLD, x: p.x, y: p.y, strokeWidth: isNext ? 2.5 : 1.5, fillOpacity: isCur || isNext ? 1 : 0.82,
      labelY: p.y + G.r + 13, cur: isCur, next: isNext, star: Array.isArray(n.modifiers) && n.modifiers.length > 0,
    });
  }
  return v;
}
