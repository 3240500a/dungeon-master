import type { Biome, Floor, FloorAlgoParams, FloorFeatures, FloorRole } from '../config/schemas.js';
import { createRng } from '../formulas/rng.js';
import type { FloorSpec } from './run/types.js';

/** Безопасный дефолт геометрии/фич, если у биома нет подходящих этажей. */
const DEFAULT_ALGO: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0 };
const DEFAULT_FEATURES: FloorFeatures = { portal: false, stash: false, shop: false, bossRoom: false, uniqueRooms: 0, treasureRooms: 0 };

/** Этаж доступен в шаблоне (пустой список = во всех). */
function inTemplate(f: Floor, templateId: string): boolean {
  return f.templates.length === 0 || f.templates.includes(templateId);
}
/** Этаж включён (не выключен тумблером). */
function on(f: Floor): boolean {
  return f.enabled !== false;
}

/** Взвешенный детерминированный выбор этажа из списка по сиду. */
function weighted(eligible: Floor[], seed: number): Floor | undefined {
  if (!eligible.length) return undefined;
  const rng = createRng(((seed ^ 0x9e3779b9) >>> 0) || 1);
  const total = eligible.reduce((s, f) => s + Math.max(0, f.weight), 0);
  if (total <= 0) return eligible[0];
  let r = rng.next() * total;
  for (const f of eligible) { r -= Math.max(0, f.weight); if (r <= 0) return f; }
  return eligible[eligible.length - 1];
}

/** Из списка этажей биома оставить подходящие по окну глубины (иначе — ближайшие). */
function byDepth(pool: Floor[], depth: number): Floor[] {
  const win = pool.filter((f) => depth >= f.minDepth && depth <= f.maxDepth);
  if (win.length) return win;
  const dist = (f: Floor) => (depth < f.minDepth ? f.minDepth - depth : depth - f.maxDepth);
  const min = Math.min(...pool.map(dist));
  return pool.filter((f) => dist(f) === min);
}

/** Роли биома, у которых есть хотя бы один этаж-член шаблона (для сборки забега). */
export function availableRoles(biomeId: string, floors: Floor[], templateId: string): Set<FloorRole> {
  const s = new Set<FloorRole>();
  for (const f of floors) if (on(f) && f.biomeId === biomeId && inTemplate(f, templateId)) s.add(f.role);
  return s;
}

/** Подбор этажа заданной РОЛИ (по биому + членству + окну глубины), взвешенный сид-выбор. */
export function pickFloorForRole(role: FloorRole, biomeId: string, floors: Floor[], depth: number, templateId: string, seed: number): Floor | undefined {
  const ofRole = floors.filter((f) => on(f) && f.biomeId === biomeId && f.role === role && inTemplate(f, templateId));
  if (!ofRole.length) return undefined;
  return weighted(byDepth(ofRole, depth), seed);
}

/** Любой этаж биома на глубине (роль-агностик фолбэк). */
export function pickFloor(biomeId: string, floors: Floor[], depth: number, seed: number): Floor | undefined {
  const ofBiome = floors.filter((f) => on(f) && f.biomeId === biomeId);
  if (!ofBiome.length) return undefined;
  return weighted(byDepth(ofBiome, depth), seed);
}

/**
 * Строит спецификацию этажа из ВЫБРАННОГО конфига этажа: биом даёт тайлсет (с учётом variants по глубине),
 * этаж — геометрию/роль/фичи/плотность. locked/kind выводятся из фич/роли (opts может переопределить).
 */
export function resolveFloorSpec(
  biome: Biome,
  floor: Floor | undefined,
  depth: number,
  seed: number,
  modifiers: string[] = [],
  opts: { exitCount?: number; locked?: boolean; kind?: 'normal' | 'town' } = {},
): FloorSpec {
  let tileset = biome.tileset;
  for (const v of biome.variants) if (depth >= v.fromDepth) tileset = v.tileset; // высший подходящий fromDepth
  const features = floor?.features ?? DEFAULT_FEATURES;
  const role = floor?.role ?? 'combat';
  return {
    biomeId: biome.id,
    floorId: floor?.id ?? '',
    role,
    features,
    packDensity: floor?.packDensity ?? 1,
    tileset,
    algoParams: floor?.algoParams ?? DEFAULT_ALGO,
    seed,
    modifiers,
    exitCount: opts.exitCount ?? 1,
    locked: opts.locked ?? features.bossRoom, // замок — если это босс-комната
    kind: opts.kind ?? (role === 'rest' ? 'town' : 'normal'),
  };
}

/** Пул монстров биома с учётом варианта по глубине. */
export function resolveMonsterPool(biome: Biome, depth: number): string[] {
  let pool = biome.monsterPool;
  for (const v of biome.variants) if (depth >= v.fromDepth && v.monsterPool) pool = v.monsterPool;
  return pool;
}
