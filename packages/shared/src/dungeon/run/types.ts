import type { FloorAlgoParams, RunNodeType, FloorRole, FloorFeatures } from '../../config/schemas.js';

/**
 * Контракты генератора забегов v2 (headless). Два слоя:
 *  - RunPlan (макро): ветвящийся слоистый граф узлов-этажей (см. generateRunPlan).
 *  - FloorSpec (микро): детерминированная спецификация геометрии одного узла (см. generateFloor).
 * Всё детерминировано от `RunConfig.seed` — граф НЕ сохраняется, а регенерируется (как этаж из seed^depth).
 */

/** Полная спецификация одного этажа: биом + выбранный этаж + алгоритм/параметры + сид + модификаторы. */
export interface FloorSpec {
  biomeId: string;
  /** id выбранного конфига этажа (из `floors`) — трассировка/редактор. */
  floorId: string;
  /** Роль выбранного этажа (combat/elite/boss/treasure/…). */
  role: FloorRole;
  /** Фичи этажа (портал/сундук/лавка/босс-комната/чемпионы/сокровищницы). */
  features: FloorFeatures;
  /** Множитель плотности пачек. */
  packDensity: number;
  /** Тайлсет (с учётом variants биома по глубине). */
  tileset: string;
  algoParams: FloorAlgoParams;
  /** Сид именно этого этажа (детерминирован от сида забега и узла). */
  seed: number;
  /** id модификаторов (run + node), влияющих на этот этаж. Применение к спавну/луту — Ф4. */
  modifiers: string[];
  /** Число выходов на следующие этажи (= число исходящих рёбер узла; finale = 0). */
  exitCount: number;
  /** Гейтить ли выход замком дверь↔рычаг (только boss-этажи; простые — false). */
  locked: boolean;
  /** Особый тип этажа: 'town' (rest-узел — портал в город + сундук, без монстров) | 'normal'. */
  kind: 'normal' | 'town';
}

/** Направленное ребро к узлу следующего слоя. */
export interface RunEdge {
  to: string;
}

/** Узел забега = один этаж (или город-rest). */
export interface RunNode {
  id: string;
  type: RunNodeType;
  /** Слой в графе: 0 = start. Растёт вглубь. */
  depth: number;
  /** Индекс внутри слоя (для раскладки схемы). */
  lane: number;
  biomeId: string;
  floorSpec: FloorSpec;
  /** id узловых модификаторов (affliction/boon) — «реклама вперёд» на схеме. */
  modifiers: string[];
  /** Куда можно пойти дальше (узлы следующего достижимого слоя). */
  edges: RunEdge[];
}

/** Готовая структура забега. */
export interface RunPlan {
  templateId: string;
  biomeId: string;
  /** id тира сложности (из difficulties). */
  tier: string;
  seed: number;
  startId: string;
  finaleId?: string;
  nodes: RunNode[];
  /** Активные на весь забег модификаторы (выбраны в алтаре). */
  runModifiers: string[];
}

/**
 * Вход генератора структуры = шаблон + настройки алтаря. Необязательные поля переопределяют
 * дефолты шаблона (сдвинутые игроком слайдеры); отсутствующие берутся из run-template.
 */
export interface RunConfig {
  templateId: string;
  biomeId: string;
  tier: string;
  seed: number;
  /** Зафиксированная длина (число слоёв); иначе — из диапазона шаблона по сиду. */
  length?: number;
  /** Максимальная ширина слоя; иначе — из шаблона. */
  widthMax?: number;
  branching?: number;
  returnEvery?: number;
  bossEvery?: number;
  nodeTypeWeights?: Record<string, number>;
  /** Мощь персонажа-игрока = эфф. уровень (уровень + гир + пассивы). Влияет на уровни монстров.
   *  server-ready: в Ф4 сервер считает из сейва пати; в редакторе задаётся слайдером алтаря. */
  power?: number;
  /** Выбранные в алтаре run-модификаторы (scope:'run'). */
  modifiers: string[];
}

/** Состояние забега в сейве (Ф4). Граф регенерится из `config.seed` — здесь только указатель. */
export interface RunState {
  templateId: string;
  config: RunConfig;
  currentNodeId: string;
  visited: string[];
}
