import { createRng, type Rng } from '../formulas/rng.js';
import { Cell, cellToWorld, worldToCell } from '../world/grid.js';
import type { FloorAlgoParams, FloorFeatures } from '../config/schemas.js';
import { type DungeonLayout, type Room, validate, roomCenter } from './floorCommon.js';
import { ALGORITHMS, roomsAlgorithm } from './algorithms/index.js';
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
}

/** Добавляет выходы (кроме первого) в самых дальних от спавна комнатах; выставляет exits. */
function applyExits(L: DungeonLayout, exitCount: number, _rng: Rng): void {
  if (exitCount <= 0) { L.exits = []; return; }
  L.exits = [L.stairsDown];
  if (exitCount === 1) return;
  const sc = worldToCell(L.spawn.x, L.spawn.y);
  const used = new Set(L.exits.map((e) => { const c = worldToCell(e.x, e.y); return `${c.cx},${c.cy}`; }));
  const cands = L.rooms
    .filter((r) => r.type !== 'entrance')
    .map((r) => { const c = roomCenter(r); return { c, d: (c.cx - sc.cx) ** 2 + (c.cy - sc.cy) ** 2 }; })
    .filter((x) => !used.has(`${x.c.cx},${x.c.cy}`))
    .sort((a, b) => b.d - a.d);
  for (const cand of cands) {
    if (L.exits.length >= exitCount) break;
    const k = `${cand.c.cx},${cand.c.cy}`;
    if (used.has(k)) continue;
    used.add(k);
    L.exits.push(cellToWorld(cand.c.cx, cand.c.cy));
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
  tagRooms(L, 'champion', f.championRooms, rng);
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
    effective = { algorithm: 'rooms', cols: params.cols, rows: params.rows, roomCount: 9, bigChance: 0.3 };
    algo = roomsAlgorithm;
  }
  const build = (s: number): DungeonLayout => {
    const rng = createRng(s || 1);
    const L = algo(effective, rng, { lock });
    applyExits(L, exitCount, rng);
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

/** Гарантированно проходимый этаж по FloorSpec (биом/алгоритм/сид/выходы/замок/фичи). */
export function generateFloor(spec: FloorSpec): DungeonLayout {
  return generateFloorParams(spec.algoParams, spec.seed, {
    lock: spec.locked,
    exitCount: spec.exitCount,
    town: spec.kind === 'town',
    features: spec.features,
  });
}
