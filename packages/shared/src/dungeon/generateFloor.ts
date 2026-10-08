import { createRng, type Rng } from '../formulas/rng.js';
import { Cell, TILE, cellToWorld, worldToCell } from '../world/grid.js';
import type { FloorAlgoParams, FloorFeatures, RoomPrefab } from '../config/schemas.js';
import { type DungeonLayout, type Room, validate, roomCenter } from './floorCommon.js';
import { ALGORITHMS, roomsAlgorithm } from './algorithms/index.js';
import { selectPrefabs } from './prefab.js';
import { townFloor } from './townFloor.js';
import { claimsOf, obstaclesFromDecor, placeFloorDecor, placeWallProps, type DecorSpec, type PlaceDecorOpts } from './decor.js';
import { dressingObjectIds, placeDressing, type DressingOpts, type DressingResult } from './dressing.js';
import { pushOutObstacle } from '../world/movement.js';
import { placeChests } from './floorCommon.js';
import type { FloorSpec } from './run/types.js';

/** Опции сборки этажа поверх «сырого» алгоритма. */
export interface GenFloorOpts {
  /** Гейтить ли выход замком дверь↔рычаг (только boss). По умолчанию true (legacy). */
  lock?: boolean;
  /** Сколько выходов на следующие этажи (развилка). По умолчанию 1. */
  exitCount?: number;
  /** Town-этаж (rest): портал в город, без замка (сундук аккаунта — только в городе, R7-11). */
  town?: boolean;
  /** Фичи этажа (портал/сундук/лавка/босс-комната/чемпионы/сокровищницы). */
  features?: FloorFeatures;
  /** Библиотека рукотворных префабов (room-scope — вставка комнат; floor-scope — алгоритм prefab). */
  prefabs?: RoomPrefab[];
  /** Биом этажа — для отбора префабов по их полю `biomes` (пусто у префаба = любой биом). */
  biomeId?: string;
  /** Спеки напольного декора биома (role decor/prop) — сервер расставляет их по комнатам. */
  decorSpecs?: DecorSpec[];
  /** Плотность расстановки декора (тюн «пачек»). */
  decorPlace?: PlaceDecorOpts;
  /** ⭐ 08.10: `false` — без процедурных колонн: клетки-колонны → пол, декор `pillar` прочь (биом, `biomes[].pillars`). */
  pillars?: boolean;
  /** ⭐ 08.10: `false` — без процедурных стоячих факелов: декор `torch` прочь (биом, `biomes[].torches`). */
  torches?: boolean;
  /** Сундуки этажа (Ч6): тиры из конфига `chests` + сколько ставить. Нет — этаж без сундуков. */
  chests?: { tiers: readonly { id: string; enabled?: boolean; weight?: number }[]; perFloor: { min: number; max: number } };
  /** ⭐ 08.10: оформление биома ПО ПРАВИЛУ (`biomes[].dressing` + азимут камеры, `dressingOf`) — факелы с шагом, статуи в нишах
   *  дальних стен, костры. Едет опцией генерации, а НЕ `FloorSpec`: спецификация ходит по проводу в `runPlan` и у биомов без
   *  оформления обязана остаться байт-в-байт. Нет — этаж как прежде. */
  dressing?: DressingOpts;
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

/** Применяет фичи этажа: декор портал/лавка + тег комнат (босс/чемпионы/сокровищницы). Сундука аккаунта нет (R7-11: только в городе). */
function applyFeatures(L: DungeonLayout, f: FloorFeatures | undefined, rng: Rng): void {
  if (!f) return;
  const entrance = L.rooms.find((r) => r.type === 'entrance') ?? L.rooms[0];
  const ec = entrance ? roomCenter(entrance) : null;
  if (f.portal && !L.decor.some((d) => d.kind === 'portal')) L.decor.push({ ...L.stairsDown, kind: 'portal' });
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
  // ⭐ 08.10: биом без процедурных колонн/факелов — снимаются ПОСЛЕ сборки и проверки этажа: поток rng генерации не сдвигается,
  // проходимость только растёт (колонна → пол), остальной этаж байт-в-байт тот же; пропсы ниже уже видят освободившийся пол
  if (opts.pillars === false) {
    for (const row of result.grid) for (let x = 0; x < row.length; x++) if (row[x] === Cell.Pillar) row[x] = Cell.Floor;
    result.decor = result.decor.filter((d) => d.kind !== 'pillar');
  }
  if (opts.torches === false) result.decor = result.decor.filter((d) => d.kind !== 'torch');
  applyFeatures(result, opts.features, createRng(((seed ^ 0xfea7) >>> 0) || 1));
  // ⭐ 08.10: оформление биома — РАНЬШЕ россыпи (ниши и костры занимают место первыми), свой поток rng. Его объекты выпадают из
  // россыпи правилом, без броска; коллайдеры и свет у них — из тех же спек (`decorSpecs`), что у прочих.
  let taken: DressingResult | undefined;
  let specs = opts.decorSpecs;
  if (opts.dressing) {
    taken = placeDressing(result, opts.dressing, createRng(((seed ^ 0xd7e5) >>> 0) || 1), specs ? new Map(specs.map((s) => [s.id, s])) : undefined);
    const own = dressingObjectIds(opts.dressing.rules);
    if (specs && own.size) specs = specs.filter((s) => !own.has(s.id));
  }
  // Расставляемые объекты (пол-россыпь + props на пол/стену) — детерминированно от сида (независимые потоки rng).
  if (specs && specs.length) {
    // ⭐ 08.10: отступы стоящего декора — по всем спекам биома (у костров оформления свой `clearance`, а из россыпи они выпали)
    placeFloorDecor(result, specs, createRng(((seed ^ 0xdec0) >>> 0) || 1), opts.decorPlace, taken?.floorCells, new Map((opts.decorSpecs ?? specs).map((s) => [s.id, s])));
    placeWallProps(result, specs, createRng(((seed ^ 0x3a11) >>> 0) || 1), taken?.faces);
  }
  // Сундуки — СВОЙ поток rng, как у декора: добавление сундуков не должно сдвигать всё остальное.
  if (opts.chests && !opts.town) {
    // ⚠ R9-16: не под преградой декора — те же коллайдеры, что получит сессия (`obstaclesFromDecor`), с запасом в четверть
    // клетки, чтобы сундук не врастал в колонну. Декора с преградой нет — сундук там же, где и был.
    const known = new Map((opts.decorSpecs ?? []).map((s) => [s.id, s]));
    const blockers = obstaclesFromDecor(result.decor, known);
    // ⭐ 08.10 (ревью, владелец: «на костре не надо ставить»): и не на след напольного объекта (решётка, костёр) и не в его кольцо отступа
    // (`objects[].clearance`) — коллайдер решётки сундук не держал вовсе, а у костра пускал на край следа. Только объекты конфига (`obj`):
    // у биомов без них сундук там же, где был.
    const floorClaims = claimsOf(result.decor.filter((d) => d.kind === 'obj'), known);
    const blocked = (x: number, y: number): boolean => {
      const c = worldToCell(x, y);
      return !floorClaims.free({ x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy }) || blockers.some((o) => pushOutObstacle(x, y, TILE / 4, o) !== null);
    };
    placeChests(result, createRng(((seed ^ 0xc4e5) >>> 0) || 1), opts.chests.tiers, opts.chests.perFloor, blocked);
  }
  return result;
}

/** Гарантированно проходимый этаж по FloorSpec (биом/алгоритм/сид/выходы/замок/фичи + библиотека префабов + декор).
 *  `dressing` — оформление биома (`dressingOf(biome, balance)`); у биома без него `undefined`. */
export function generateFloor(spec: FloorSpec, prefabs?: RoomPrefab[], decorSpecs?: DecorSpec[], decorPlace?: PlaceDecorOpts, chests?: GenFloorOpts['chests'], dressing?: DressingOpts): DungeonLayout {
  return generateFloorParams(spec.algoParams, spec.seed, {
    lock: spec.locked,
    exitCount: spec.exitCount,
    town: spec.kind === 'town',
    features: spec.features,
    prefabs,
    biomeId: spec.biomeId,
    pillars: spec.pillars,
    torches: spec.torches,
    decorSpecs,
    decorPlace,
    chests,
    dressing,
  });
}
