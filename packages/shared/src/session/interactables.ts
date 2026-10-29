import { TILE } from '../world/grid.js';
import { exitLabel } from '../dungeon/run/labels.js';
import type { RunPlan } from '../dungeon/run/types.js';
import type { FloorInit } from './netTypes.js';

/**
 * ⭐ С7 (29.10): ИНТЕРАКТИВЫ ОБЛАСТИ — ИХ СОБИРАЕТ СЕРВЕР. Где стоит, в каком радиусе [E], что подписано и что делает — раньше это
 * держали клиенты своими константами (веб `buildArea`, Unity `WorldRules.AreaInteractables`, станции города `TOWN_NPCS`), а сервер о
 * станциях города не знал вовсе: проверял только «в городе ли герой». Теперь список едет в `FloorInit.interactables` (и в кадре
 * открытия области — `reveal`), клиент его рисует, а сервер по тем же точкам проверяет, что герой рядом (`stationNear`).
 *
 * Радиус — подсказки [E] у клиента. Сервер судит с запасом на задержку (свои пороги: выход 64, сундук и рычаг 56, алтарь 56, станция
 * `STATION_USE_R`): честный игрок не получает отказ из-за полклетки рассинхрона.
 */
export type InteractAct = 'exit' | 'panel' | 'return' | 'lever' | 'chest';

export interface Interactable {
  x: number;
  y: number;
  radius: number;
  act: InteractAct;
  label: string;
  /** Окно, которое открывает `panel`: `shop`, `forge`, `master`, `quests`, `stash`, `difficulty` (портал города), `altar`. */
  panel?: string;
  /** Рычаг или сундук — его id на этаже. */
  id?: number;
  /** Рычаг — какую дверь открывает. */
  doorId?: number;
  /** Выход — номер ребра узла (`descend` с `targetNodeId` этого ребра). */
  exit?: number;
  /** Выход — узел, куда ведёт его ребро (`descend.targetNodeId`): граф считать клиенту незачем. */
  to?: string;
  /**
   * Станция и портал города — с какого расстояния сервер исполняет их команды (`STATION_USE_R`). Отошёл дальше — клиент закрывает окно сам,
   * иначе сервер ответил бы отказом «Подойдите ближе».
   */
  reach?: number;
}

/** Радиусы подсказки [E] (веб `buildArea`; Unity `WorldRules`). */
export const INTERACT_R = { exit: 34, shop: 40, portal: 44, spawn: 40, lever: 40, chest: 48, npc: 42, townPortal: 46, altar: 42 } as const;

export const INTERACT_LABEL = {
  shop: 'Лавка',
  ret: 'Вернуться в город (голосование)',
  lever: 'Рычаг (открыть дверь)',
  chest: 'Сундук (открыть)',
  townPortal: 'Портал — куда лететь',
  altar: 'Алтарь — настроить отрезок',
} as const;

/** Станции города: клетка, подпись, окно. Цвет столбика — показ, он у клиента. */
export const TOWN_STATIONS: readonly { cx: number; cy: number; label: string; panel: string }[] = [
  { cx: 4, cy: 4, label: 'Магазин', panel: 'shop' },
  { cx: 7, cy: 4, label: 'Кузница', panel: 'forge' },
  { cx: 10, cy: 4, label: 'Мастер прокачки', panel: 'master' },
  { cx: 14, cy: 4, label: 'Доска квестов', panel: 'quests' },
  { cx: 17, cy: 4, label: 'Сундук', panel: 'stash' },
];

/**
 * ⭐ С7: с какого расстояния сервер исполняет команду станции города (центр станции → герой). Подсказка [E] — 42; запас — на задержку и
 * на то, что окно открыто, а герой сделал шаг. Отошёл дальше — клиент закрывает окно станции сам, сервер отказывает.
 */
export const STATION_USE_R = 80;

const at = (cx: number, cy: number): { x: number; y: number } => ({ x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 });

/** Центр станции города `panel` (её клетка) — или `undefined`, если такой станции нет. */
export function townStationAt(panel: string): { x: number; y: number } | undefined {
  const s = TOWN_STATIONS.find((t) => t.panel === panel);
  return s ? at(s.cx, s.cy) : undefined;
}

/** Портал города (окно «куда лететь») — у правого нижнего угла площади. */
export function townPortalAt(grid: FloorInit['grid']): { x: number; y: number } | undefined {
  const rows = grid.length, cols = grid[0]?.length ?? 0;
  return rows > 0 && cols > 0 ? at(cols - 4, rows - 4) : undefined;
}

/**
 * Интерактивы области в ПОРЯДКЕ веба (`buildArea`; ничья ближайшего — первый): подземелье — выходы (подпись — из плана забега:
 * see-ahead развилки), лавка и портал декора, возврат у входа, алтарь метки, рычаги, закрытые сундуки; город — станции и портал.
 */
export function floorInteractables(f: Pick<FloorInit, 'area' | 'exits' | 'stairs' | 'decor' | 'spawn' | 'altar' | 'levers' | 'chests' | 'grid' | 'runNodeId'>, plan?: RunPlan,
  opts: { spawn?: boolean } = {}): Interactable[] {
  const out: Interactable[] = [];
  if (f.area === 'dungeon') {
    const exits = f.exits ?? (f.stairs ? [f.stairs] : []);
    // ⭐ С-аудит F5: у выхода открытого куска — свой номер ребра (`i`): выходы до него могли быть ещё не открыты.
    const cur = plan?.nodes.find((n) => n.id === f.runNodeId);
    exits.forEach((e, n) => {
      const i = 'i' in e && typeof e.i === 'number' ? e.i : n;
      const to = cur?.edges[i]?.to;
      out.push({ x: e.x, y: e.y, radius: INTERACT_R.exit, act: 'exit', label: exitLabel(plan, f.runNodeId, i), exit: i, ...(to ? { to } : {}) });
    });
    for (const d of f.decor) {
      if (d.kind === 'shop') out.push({ x: d.x, y: d.y, radius: INTERACT_R.shop, act: 'panel', label: INTERACT_LABEL.shop, panel: 'shop' });
      else if (d.kind === 'portal') out.push({ x: d.x, y: d.y, radius: INTERACT_R.portal, act: 'return', label: INTERACT_LABEL.ret });
    }
    if (opts.spawn !== false) out.push({ x: f.spawn.x, y: f.spawn.y, radius: INTERACT_R.spawn, act: 'return', label: INTERACT_LABEL.ret });
    if (f.altar) out.push({ x: f.altar.x, y: f.altar.y, radius: INTERACT_R.altar, act: 'panel', label: INTERACT_LABEL.altar, panel: 'altar' });
    for (const l of f.levers) out.push({ x: l.x, y: l.y, radius: INTERACT_R.lever, act: 'lever', label: INTERACT_LABEL.lever, id: l.id, doorId: l.doorId });
    for (const c of f.chests) if (!c.opened) out.push({ x: c.x, y: c.y, radius: INTERACT_R.chest, act: 'chest', label: INTERACT_LABEL.chest, id: c.id });
    return out;
  }
  // ⭐ С7: станциям ремесла и сундуку (их команды сервер судит по близости) и порталу (спуск и арена — от него) — досягаемость.
  const judged = new Set(['shop', 'forge', 'stash']);
  for (const s of TOWN_STATIONS) out.push({ ...at(s.cx, s.cy), radius: INTERACT_R.npc, act: 'panel', label: s.label, panel: s.panel, ...(judged.has(s.panel) ? { reach: STATION_USE_R } : {}) });
  const portal = townPortalAt(f.grid);
  if (portal) out.push({ ...portal, radius: INTERACT_R.townPortal, act: 'panel', label: INTERACT_LABEL.townPortal, panel: 'difficulty', reach: STATION_USE_R });
  return out;
}
