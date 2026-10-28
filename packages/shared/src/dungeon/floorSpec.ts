import type { Biome, Floor, FloorAlgoParams, FloorFeatures, FloorRole } from '../config/schemas.js';
import { createRng } from '../formulas/rng.js';
import type { FloorSpec } from './run/types.js';

/** Безопасный дефолт геометрии/фич, если у биома нет подходящих этажей. */
const DEFAULT_ALGO: FloorAlgoParams = { algorithm: 'rooms', cols: 56, rows: 42, roomCount: 9, bigChance: 0.3, loops: 0.5, spawnMode: 'farthest', shapes: { rect: 6, ell: 1, blob: 1, round: 1, hall: 1 }, prefabChance: 0, largeRoomArea: 80 };
const DEFAULT_FEATURES: FloorFeatures = { portal: false, shop: false, bossRoom: false, uniqueRooms: 0, treasureRooms: 0 };

/** Этаж включён (не выключен тумблером). */
function on(f: Floor): boolean {
  return f.enabled !== false;
}

/**
 * ⭐⭐ Ф2 (16.10): ВЕС ЭТАЖА НА МЕСТЕ КРУГА. Нет `placeWeight` — обычный `weight`. Есть — линейная проводка от
 * `first` (первое место круга) к `last` (последнее): `w = first + (last − first) × (место − 1) / (цикл − 1)`.
 * Цикл ≤ 1 или место вне круга — берётся `first` (вырожденный круг не должен менять смесь молча).
 */
export function floorWeightAt(f: Floor, place?: number, cycle?: number): number {
  const pw = f.placeWeight;
  if (!pw) return Math.max(0, f.weight);
  const c = Number.isFinite(cycle) ? Math.floor(cycle as number) : 0;
  const p = Number.isFinite(place) ? Math.floor(place as number) : 0;
  if (c <= 1 || p < 1 || p > c) return Math.max(0, pw.first);
  const k = (p - 1) / (c - 1);
  return Math.max(0, pw.first + (pw.last - pw.first) * k);
}

/** Взвешенный детерминированный выбор этажа из списка по сиду (вес — с учётом места круга). */
function weighted(eligible: Floor[], seed: number, place?: number, cycle?: number): Floor | undefined {
  if (!eligible.length) return undefined;
  const rng = createRng(((seed ^ 0x9e3779b9) >>> 0) || 1);
  const w = eligible.map((f) => floorWeightAt(f, place, cycle));
  const total = w.reduce((s, x) => s + x, 0);
  if (total <= 0) return eligible[0];
  let r = rng.next() * total;
  for (let i = 0; i < eligible.length; i++) { r -= w[i]!; if (r <= 0) return eligible[i]; }
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

/**
 * Роли биома, у которых есть хотя бы один включённый этаж (для сборки забега).
 *
 * ⚠⚠ Г8-4 (15.10): ЧЛЕНСТВО ЭТАЖА В ШАБЛОНЕ СНЯТО. Оно было третьим — молчаливым — условием существования
 * контента: этаж мог быть включён, подходить по глубине и всё равно не участвовать, если его не записали в
 * текущий шаблон. На этом пропадали БОССЫ (`crypt-boss` состоял только в двух шаблонах из трёх), а владелец
 * потребовал обратного: «боссы на этажах боссов, вейпоинты на этажах вейпоинтов согласно таблице». Шаблон забега
 * остался ОДИН, и фильтровать по нему нечего.
 */
export function availableRoles(biomeId: string, floors: Floor[]): Set<FloorRole> {
  const s = new Set<FloorRole>();
  for (const f of floors) if (on(f) && f.biomeId === biomeId) s.add(f.role);
  return s;
}

/**
 * ⭐⭐ Г8-5 (15.10): РОЛИ, У КОТОРЫХ ЕСТЬ ЭТАЖ ИМЕННО НА ЭТОМ МЕСТЕ КРУГА (окно `minDepth..maxDepth` его накрывает).
 *
 * ⚠⚠ ЗАЧЕМ ОТДЕЛЬНО ОТ `availableRoles`. Подбор этажа роли НИКОГДА не возвращает «нет»: `byDepth` при промахе окна
 * берёт БЛИЖАЙШЕЕ окно (и это правильно — узел обязан получить этаж). Но если спрашивать «какие роли бывают» без
 * оглядки на место, окна глубины становятся ДЕКОРАТИВНЫМИ: генератор ставит элиту на 1-м месте круга, где её окно
 * начинается с 3-го, и берёт её этаж фолбэком. Замер 15.10 по живым данным: у крипты элита и сокровищница не
 * покрывают места 1–2, а боевые этажи — места 16–20 (их закрыл новый `crypt-depths`).
 *
 * Рядовой узел выбирается ТОЛЬКО из ролей этого места; метка и босс ставятся по таблице круга и это правило не
 * спрашивают (Г8-4) — им этаж и положено добирать фолбэком, если контента биома не хватает.
 */
export function availableRolesAt(biomeId: string, floors: Floor[], depth: number): Set<FloorRole> {
  const s = new Set<FloorRole>();
  for (const f of floors) if (on(f) && f.biomeId === biomeId && depth >= f.minDepth && depth <= f.maxDepth) s.add(f.role);
  return s;
}

/**
 * Подбор этажа заданной РОЛИ (по биому + окну глубины), взвешенный сид-выбор.
 *
 * ⭐ Ф2 (16.10): `opts.place`/`opts.cycle` включают вес по месту круга (`placeWeight`), а `opts.bossRank` сужает
 * боссовые этажи до сделанных под этот ранг — если таких нет, берутся любые боссовые (узел обязан получить этаж).
 */
export function pickFloorForRole(
  role: FloorRole, biomeId: string, floors: Floor[], depth: number, seed: number,
  opts?: { place?: number; cycle?: number; bossRank?: 'mini' | 'strong' | 'act' },
): Floor | undefined {
  const ofRole = floors.filter((f) => on(f) && f.biomeId === biomeId && f.role === role);
  if (!ofRole.length) return undefined;
  const byRank = opts?.bossRank ? ofRole.filter((f) => f.bossRank === opts.bossRank) : [];
  const pool = byRank.length ? byRank : ofRole;
  return weighted(byDepth(pool, depth), seed, opts?.place, opts?.cycle);
}

/** Любой этаж биома на глубине (роль-агностик фолбэк — когда этажа нужной роли у биома нет вовсе). */
export function pickFloor(biomeId: string, floors: Floor[], depth: number, seed: number): Floor | undefined {
  const ofBiome = floors.filter((f) => on(f) && f.biomeId === biomeId);
  if (!ofBiome.length) return undefined;
  return weighted(byDepth(ofBiome, depth), seed);
}

/**
 * ⭐⭐ Г8-3 (15.10): БОССОВЫЙ ЭТАЖ — БОЛЬШЕ ПО РАЗМЕРУ. Владелец: «боссовый уровень сделаем просто больше по
 * размеру». Множитель приходит из `balance.dungeonAccess.bossRanks[ранг].floorScale` и растягивает ЛИНЕЙНЫЕ
 * размеры сетки (`cols`/`rows`).
 *
 * ⚠ ПОЧЕМУ ЧИСЛО КОМНАТ ЕДЕТ ПО ПЛОЩАДИ, А НЕ ЛИНЕЙНО. Комнаты в генераторе ФИКСИРОВАННОГО размера в клетках
 * (6..9 обычная, 10..14 большая — `algorithms/rooms.ts`), от размера сетки они не растут. Растяни одну сетку и
 * оставь `roomCount` — те же 9 комнат разъедутся по площади ×1.8, и этаж станет не «больше», а ПУСТЕЕ: длинные
 * коридоры между прежними комнатами. Поэтому число комнат множится на `floorScale²` — плотность застройки та же,
 * а этаж честно крупнее. Оба числа зажаты в рамки схемы (`cols/rows` 20..200, `roomCount` 3..30).
 *
 * ⚠ КОПИЯ, А НЕ ПРАВКА НА МЕСТЕ: `algoParams` — это объект ЖИВОГО конфига (реестр держит его в памяти, см.
 * память «редактор и игра видят одно и то же»). Правка на месте растянула бы этаж НАВСЕГДА и для всех, кто его
 * потом выберет. Масштаб 1 (или его отсутствие) не создаёт копии вовсе — кадр `runPlan` байт-в-байт прежний.
 */
function scaleAlgo(p: FloorAlgoParams, scale: number): FloorAlgoParams {
  if (!Number.isFinite(scale) || scale <= 1) return p;
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));
  return {
    ...p,
    cols: clamp(p.cols * scale, 20, 200),
    rows: clamp(p.rows * scale, 20, 200),
    ...(p.algorithm === 'rooms' ? { roomCount: clamp(p.roomCount * scale * scale, 3, 30) } : {}),
  } as FloorAlgoParams;
}

/**
 * Строит спецификацию этажа из ВЫБРАННОГО конфига этажа: биом даёт тайлсет (с учётом variants по глубине),
 * этаж — геометрию/роль/фичи/плотность. locked/kind выводятся из фич/роли (opts может переопределить).
 * `floorScale` (Г8-3) растягивает сетку боссового этажа — см. `scaleAlgo`.
 */
export function resolveFloorSpec(
  biome: Biome,
  floor: Floor | undefined,
  depth: number,
  seed: number,
  modifiers: string[] = [],
  opts: { exitCount?: number; locked?: boolean; kind?: 'normal' | 'town'; floorScale?: number } = {},
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
    algoParams: scaleAlgo(floor?.algoParams ?? DEFAULT_ALGO, opts.floorScale ?? 1),
    seed,
    modifiers,
    exitCount: opts.exitCount ?? 1,
    locked: opts.locked ?? features.bossRoom, // замок — если это босс-комната
    kind: opts.kind ?? (role === 'rest' ? 'town' : 'normal'),
    // поля — только когда выключено: у прочих биомов спецификация (и runPlan на проводе) байт-в-байт прежняя
    ...(biome.pillars === false ? { pillars: false as const } : {}),
    ...(biome.torches === false ? { torches: false as const } : {}),
  };
}

/** Пул монстров биома с учётом варианта по глубине. */
export function resolveMonsterPool(biome: Biome, depth: number): string[] {
  let pool = biome.monsterPool;
  for (const v of biome.variants) if (depth >= v.fromDepth && v.monsterPool) pool = v.monsterPool;
  return pool;
}
