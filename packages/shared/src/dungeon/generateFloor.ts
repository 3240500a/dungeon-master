import { createRng, type Rng } from '../formulas/rng.js';
import { Cell, cellToWorld, worldToCell } from '../world/grid.js';
import type { FloorAlgoParams, FloorFeatures, RoomPrefab } from '../config/schemas.js';
import { type DungeonLayout, type Room, validate, roomCenter } from './floorCommon.js';
import { ALGORITHMS, roomsAlgorithm } from './algorithms/index.js';
import { selectPrefabs } from './prefab.js';
import { townFloor } from './townFloor.js';
import type { FloorSpec } from './run/types.js';

/** Опции сборки этажа поверх «сырого» алгоритма. */
export interface GenFloorOpts {
  /** Гейтить ли выход замком дверь↔рычаг (только boss). По умолчанию true (legacy). */
  lock?: boolean;
  /** Сколько выходов на следующие этажи (развилка). По умолчанию 1. */
  exitCount?: number;
  /** Town-этаж (rest): портал в город + сундук, без замка. */
  town?: boolean;
  /** Фичи этажа (портал/сундук/лавка/босс-комната/чемпионы/сокровищницы). */
  features?: FloorFeatures;
  /** Библиотека рукотворных префабов (room-scope — вставка комнат; floor-scope — алгоритм prefab). */
  prefabs?: RoomPrefab[];
  /** Биом этажа — для отбора префабов по их полю `biomes` (пусто у префаба = любой биом). */
  biomeId?: string;
}

/**
 * Выставляет выходы: первый = stairsDown, остальные — farthest-point sampling (каждый следующий
 * максимизирует МИН. дистанцию до уже размещённых {спавн + выходы}) ⇒ выходы разнесены по карте.
 */
function applyExits(L: DungeonLayout, exitCount: number, _rng: Rng): void {
  if (exitCount <= 0) { L.exits = []; return; }
  L.exits = [L.stairsDown];
  if (exitCount === 1) return;
  const key = (c: { cx: number; cy: number }): string => `${c.cx},${c.cy}`;
  const anchors = [worldToCell(L.spawn.x, L.spawn.y), worldToCell(L.stairsDown.x, L.stairsDown.y)]; // спавн + размещённые выходы
  const usedCells = new Set(anchors.map(key));
  const cands = L.rooms.filter((r) => r.type !== 'entrance').map(roomCenter).filter((c) => !usedCells.has(key(c)));
  while (L.exits.length < exitCount && cands.length) {
    let best = -1, bestD = -1;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]!;
      let md = Infinity;
      for (const a of anchors) md = Math.min(md, (c.cx - a.cx) ** 2 + (c.cy - a.cy) ** 2);
      if (md > bestD) { bestD = md; best = i; }
    }
    if (best < 0) break;
    const c = cands.splice(best, 1)[0]!;
    anchors.push(c);
    L.exits.push(cellToWorld(c.cx, c.cy));
  }
}

/** Комната, содержащая мировую точку. */
function roomAt(L: DungeonLayout, p: { x: number; y: number }): Room | undefined {
  const c = worldToCell(p.x, p.y);
  return L.rooms.find((r) => c.cx >= r.x && c.cx < r.x + r.w && c.cy >= r.y && c.cy < r.y + r.h);
}

/** Тегирует `count` не-входных комнат без содержимого заданным `content`; возвращает их. */
function tagRooms(L: DungeonLayout, content: NonNullable<Room['content']>, count: number, rng: Rng): Room[] {
  if (!count || count <= 0) return [];
  const cands = L.rooms.filter((r) => r.type !== 'entrance' && !r.content);
  const out: Room[] = [];
  for (let i = 0; i < count && cands.length; i++) {
    const [r] = cands.splice(rng.int(0, cands.length - 1), 1);
    if (!r) break;
    r.content = content;
    out.push(r);
  }
  return out;
}

/** Применяет фичи этажа: декор портал/сундук/лавка + тег комнат (босс/чемпионы/сокровищницы). */
function applyFeatures(L: DungeonLayout, f: FloorFeatures | undefined, rng: Rng): void {
  if (!f) return;
  const entrance = L.rooms.find((r) => r.type === 'entrance') ?? L.rooms[0];
  const ec = entrance ? roomCenter(entrance) : null;
  if (f.portal && !L.decor.some((d) => d.kind === 'portal')) L.decor.push({ ...L.stairsDown, kind: 'portal' });
  if (f.stash && ec) L.decor.push({ ...cellToWorld(ec.cx + 1, ec.cy), kind: 'stash' });
  if (f.shop && ec) L.decor.push({ ...cellToWorld(ec.cx - 1, ec.cy), kind: 'shop' });
  if (f.bossRoom) { const br = roomAt(L, L.stairsDown); if (br) br.content = 'boss'; }
  tagRooms(L, 'unique', f.uniqueRooms, rng);
  for (const r of tagRooms(L, 'treasure', f.treasureRooms, rng)) {
    const c = roomCenter(r);
    L.decor.push({ ...cellToWorld(c.cx, c.cy), kind: 'chest' });
  }
}

/**
 * Гарантированно проходимый этаж по параметрам алгоритма: диспетчер по `algorithm` + сборка
 * выходов/town + инвариант `validate` с перегенерацией + фолбэк «снять замки», затем применение
 * фич (декор/тег комнат — на проходимость не влияют). Единый путь геометрии для сервера/сима/редактора.
 */
export function generateFloorParams(params: FloorAlgoParams, seed: number, opts: GenFloorOpts = {}): DungeonLayout {
  const lock = opts.lock ?? true;
  const exitCount = Math.max(0, opts.exitCount ?? 1);
  const town = opts.town ?? false;

  // Town-этаж (rest): компактный хаб вместо алгоритмической геометрии.
  if (town) {
    let L: DungeonLayout | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const t = townFloor(exitCount, ((seed + attempt * 104729) >>> 0) || 1);
      if (validate(t)) { L = t; break; }
    }
    return L ?? townFloor(exitCount, (seed >>> 0) || 1); // проходим по конструкции
  }

  let effective: FloorAlgoParams = params;
  let algo = ALGORITHMS[params.algorithm];
  if (!algo) {
    effective = { algorithm: 'rooms', cols: params.cols, rows: params.rows, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0, largeRoomArea: 80 };
    algo = roomsAlgorithm;
  }
  // Отбор префабов под этот этаж: по биому + типу генерации (пустой список у префаба = «любой»).
  const prefabs = selectPrefabs(opts.prefabs ?? [], { biomeId: opts.biomeId, algorithm: effective.algorithm });
  const build = (s: number): DungeonLayout => {
    const rng = createRng(s || 1);
    const L = algo(effective, rng, { lock, prefabs });
    // prefab-этаж сам определяет выходы (зоны 'x'); прочие — farthest-point среди комнат.
    if (effective.algorithm === 'prefab') L.exits = exitCount <= 0 ? [] : L.exits.slice(0, Math.max(1, exitCount));
    else applyExits(L, exitCount, rng);
    // Терминальный этаж (финал, нет выходов дальше) — портал возврата в город на месте лестницы.
    if (exitCount === 0) L.decor.push({ ...L.stairsDown, kind: 'portal' });
    return L;
  };

  let result: DungeonLayout | null = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const L = build(((seed + attempt * 104729) >>> 0) || 1);
    if (validate(L)) { result = L; break; }
  }
  if (!result) {
    // Фолбэк: снять замки (двери → пол) — этаж заведомо проходим.
    result = build((seed >>> 0) || 1);
    for (const d of result.doors) for (const c of d.cells) { const row = result.grid[c.cy]; if (row) row[c.cx] = Cell.Floor; }
    result.doors = [];
    result.levers = [];
  }
  applyFeatures(result, opts.features, createRng(((seed ^ 0xfea7) >>> 0) || 1));
  return result;
}

/** Гарантированно проходимый этаж по FloorSpec (биом/алгоритм/сид/выходы/замок/фичи + библиотека префабов). */
export function generateFloor(spec: FloorSpec, prefabs?: RoomPrefab[]): DungeonLayout {
  return generateFloorParams(spec.algoParams, spec.seed, {
    lock: spec.locked,
    exitCount: spec.exitCount,
    town: spec.kind === 'town',
    features: spec.features,
    prefabs,
    biomeId: spec.biomeId,
  });
}
