/**
 * МОДЕЛЬ ГРАФА АНИМАЦИЙ: из конфига — узлы и рёбра. Без DOM, поэтому проверяется в node.
 *
 * Рисование живёт в `animGraphPanel.ts`, а ВСЯ логика — здесь. Разделение не косметическое: узловой
 * редактор легко превращается в «нарисовали и надеемся», а самое ценное в нём — выводимые рёбра
 * «кто кого перебивает». Они должны быть посчитаны правильно, и это должно быть доказуемо.
 */
import { readAnimCfg, type AnimStore } from './animConfig.js';

/** Состояния, которые рантайм запускает сам (Ф1.4/Ф1.5) — узлы для них есть всегда. */
export const BUILTIN_STATES = ['attack', 'stagger', 'knockdown_fall', 'getup'] as const;
/** Служебные узлы базовых слоёв: их настраивают на вкладке «Бег», здесь они — точка отсчёта. */
export const BASE_NODES = ['#stance', '#loco'] as const;

export type EdgeKind = 'from-base' | 'chain' | 'interrupt';
export interface GraphEdge { from: string; to: string; kind: EdgeKind }
export interface GraphNode {
  id: string;
  /** Служебный узел базового слоя — не редактируется и не удаляется. */
  base: boolean;
  clip: string;
  priority: number;
  interruptible: boolean;
  legs: 'auto' | 'never' | 'always';
  /** Клипа с таким именем у персонажа нет — битая привязка, её надо ВИДЕТЬ. */
  missing: boolean;
}

/** Все состояния: встроенные плюс заведённые автором. */
export function graphStates(store: AnimStore, charId: string): string[] {
  const g = store[charId] ?? {};
  return [...new Set<string>([...BUILTIN_STATES, ...Object.keys(g.states ?? {})])];
}

export function graphNodes(store: AnimStore, charId: string, clipNames: readonly string[]): GraphNode[] {
  const cfg = readAnimCfg(store, charId);
  const have = new Set(clipNames);
  const base: GraphNode[] = BASE_NODES.map((id) => ({ id, base: true, clip: '', priority: 0, interruptible: true, legs: 'auto', missing: false }));
  const states = graphStates(store, charId).map((id): GraphNode => {
    const c = cfg.stateCfg(id);
    return { id, base: false, clip: c.clip, priority: c.priority, interruptible: c.interruptible, legs: c.legs, missing: !have.has(c.clip) };
  });
  return [...base, ...states];
}

/**
 * Рёбра трёх видов.
 *
 *  `from-base`  — служебные «откуда приходим»: из стойки в каждое состояние.
 *  `chain`      — АВТОРСКИЕ цепочки (`next`): комбо. Ссылка на несуществующее состояние отбрасывается.
 *  `interrupt`  — ВЫВОДИМЫЕ: «A перебьёт B, хотя B помечен непрерываемым». Рисуются ровно затем, чтобы
 *                 ошибка в приоритетах была видна на картинке, а не выяснялась в бою. Для прерываемого
 *                 B ребро не нужно: его и так перебьёт кто угодно, и граф превратился бы в решётку.
 */
export function graphEdges(store: AnimStore, charId: string): GraphEdge[] {
  const cfg = readAnimCfg(store, charId);
  const ids = graphStates(store, charId);
  const known = new Set(ids);
  const es: GraphEdge[] = ids.map((id) => ({ from: '#stance', to: id, kind: 'from-base' as const }));
  for (const id of ids) for (const n of cfg.stateCfg(id).next) if (known.has(n)) es.push({ from: id, to: n, kind: 'chain' });
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const ca = cfg.stateCfg(a), cb = cfg.stateCfg(b);
    if (!cb.interruptible && ca.priority > cb.priority) es.push({ from: a, to: b, kind: 'interrupt' });
  }
  return es;
}
