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
  /** Вторая строка на узле, когда он не про состояние (слой, предмет): чем он и с какой силой. */
  sub?: string;
  /** Уровень, в который узел ПУСКАЕТ по двойному клику (как подмашина в Unity). Нет — узел-лист. */
  enter?: LevelId;
}

/**
 * УРОВНИ ГРАФА — ровно как подмашины состояний в Unity Animator: заходишь внутрь ТОГО ЖЕ окна, а не
 * открываешь новое, и путь виден хлебными крошками. Корень (`''`) — не куча узлов, а СТЕК СЛОЁВ: он и
 * есть контракт системы («нижний слой не знает о верхних»), поэтому показать его надо первым.
 */
export type LevelId = '' | 'stance' | 'main' | 'off' | 'action' | 'loco';

/** Слои контроллера снизу вверх — тот же порядок, что в плане Ф1. */
export const LAYER_DEFS: { id: LevelId; title: string; sub: string; enter: boolean }[] = [
  { id: 'loco', title: 'ЛОКОМОЦИЯ', sub: 'ноги и таз — планировщик шагов', enter: false },
  { id: 'stance', title: 'ПОЗА ВЕРХА', sub: 'idle_relax ↔ idle_incombat', enter: true },
  { id: 'main', title: 'ГЛАВНАЯ РУКА', sub: 'Δ предмета правой руки', enter: true },
  { id: 'off', title: 'ВТОРАЯ РУКА', sub: 'Δ предмета левой руки', enter: true },
  { id: 'action', title: 'ДЕЙСТВИЕ', sub: 'удар · реакция · падение', enter: true },
];
export const LEVEL_TITLE: Record<LevelId, string> = {
  '': 'Контроллер', stance: 'Поза верха', main: 'Главная рука', off: 'Вторая рука', action: 'Действие', loco: 'Локомоция',
};

/** Пустой узел-заготовка: поля состояния для узлов, которые состояниями не являются. */
const plainNode = (id: string, clip: string, missing: boolean, sub: string, base = false, enter?: LevelId): GraphNode =>
  ({ id, base, clip, priority: 0, interruptible: true, legs: 'auto', missing, sub, enter });

/** Все состояния: встроенные плюс заведённые автором. */
export function graphStates(store: AnimStore, charId: string): string[] {
  const g = store[charId] ?? {};
  return [...new Set<string>([...BUILTIN_STATES, ...Object.keys(g.states ?? {})])];
}

/**
 * Узлы уровня. Корень — стек слоёв (счётчик на узле показывает, есть ли внутри что смотреть),
 * `action` — состояния слота действия, `stance` — две безоружные базы, `main`/`off` — предметы руки.
 */
export function levelNodes(store: AnimStore, charId: string, clipNames: readonly string[], level: LevelId): GraphNode[] {
  const cfg = readAnimCfg(store, charId);
  const have = new Set(clipNames);
  const g = store[charId] ?? {};
  if (level === 'action') return graphNodes(store, charId, clipNames);
  if (level === 'loco') return [plainNode('#loco', '', false, 'ручки — вкладка «Бег»', true)];
  if (level === 'stance') {
    return (['idle', 'combat_idle'] as const).map((k) => {
      const clip = cfg.clipName(k, 'none');
      return plainNode(k === 'idle' ? '#relax' : '#incombat', clip, !have.has(clip),
        k === 'idle' ? 'спокойная база' : 'боевая база', true);
    });
  }
  if (level === 'main' || level === 'off') {
    const base = cfg.clipName('idle', 'none');
    const out = [plainNode('#base', base, !have.has(base), 'безоружная база', true)];
    for (const item of Object.keys(g.items ?? {})) {
      if (cfg.handOf(item) !== (level === 'main' ? 'main' : 'off')) continue;
      const clip = cfg.clipName('idle', item);
      out.push(plainNode(item, clip, !have.has(clip),
        `${cfg.kindOf(item) === 'override' ? 'замена верха' : 'дельта'} · сила ${cfg.weightOf(item).toFixed(2)}`));
    }
    return out;
  }
  // Корень: стек слоёв. Счётчик — сколько внутри узлов, чтобы пустой слой был виден сразу.
  return LAYER_DEFS.map((l) => {
    const n = l.enter ? levelNodes(store, charId, clipNames, l.id).length : 0;
    return plainNode('#' + l.id, '', false, l.enter ? `${l.sub} · ${n}` : l.sub, true, l.enter ? l.id : undefined);
  });
}

/** Рёбра уровня. В корне это порядок наложения слоёв — контракт «нижний не знает о верхних». */
export function levelEdges(store: AnimStore, charId: string, level: LevelId): GraphEdge[] {
  if (level === 'action') return graphEdges(store, charId);
  if (level === 'stance' || level === 'loco') return [];
  if (level === 'main' || level === 'off') {
    return levelNodes(store, charId, [], level).filter((n) => n.id !== '#base')
      .map((n) => ({ from: '#base', to: n.id, kind: 'from-base' as const }));
  }
  const es: GraphEdge[] = [];
  for (let i = 1; i < LAYER_DEFS.length; i++) es.push({ from: '#' + LAYER_DEFS[i - 1]!.id, to: '#' + LAYER_DEFS[i]!.id, kind: 'chain' });
  return es;
}

export function graphNodes(store: AnimStore, charId: string, clipNames: readonly string[]): GraphNode[] {
  const cfg = readAnimCfg(store, charId);
  const have = new Set(clipNames);
  // Служебные узлы базы. `sub` у них ОБЯЗАТЕЛЕН: без него они рисуются как состояния с «prio 0» и
  // читаются как сломанные — а это вообще не состояния, это точка отсчёта и соседний слой.
  const base: GraphNode[] = BASE_NODES.map((id) => ({
    id, base: true, clip: '', priority: 0, interruptible: true, legs: 'auto', missing: false,
    sub: id === '#stance' ? 'откуда приходим · вкладка «Бег»' : 'ноги — планировщик шагов',
  }));
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
