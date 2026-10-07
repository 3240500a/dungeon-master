import type { Rng } from '../formulas/rng.js';
import { Cell, TILE, isBlockedCell, worldToCell } from '../world/grid.js';
import type { Obstacle } from '../world/state.js';
import type { DungeonLayout, DecorObject, Room } from './floorCommon.js';

/**
 * Напольный декор этажа (внутрикомнатные колонны/очаги/пропы): СЕРВЕРНАЯ детерминированная
 * расстановка по комнатам + деривация суб-тайловых препятствий из коллайдеров. Один код на
 * сервере и в симе → одинаково у всех игроков (расклад едет клиенту в `FloorInit.decor`).
 *
 * Тайлы пола/стен и СТЕНОВЫЕ колонны (`role:'pillar'`) сюда НЕ входят — их клиент ставит сам
 * детерминированным `cellHash`. Здесь только role `decor`/`prop` (напольные объекты).
 */

/** Минимальная спека расставляемого объекта (из config `objects`), нужная для расстановки+коллизии. */
export interface DecorSpec {
  id: string;                        // objectId (из config objects)
  footprint: { w: number; h: number };
  weight: number;                    // относительный вес выбора при расстановке
  spawnChance: number;               // частота: шанс поставить в клетку-кандидат (0..1)
  surface: 'floor' | 'wall';         // на пол (россыпь по комнатам) или на стену (по граням стен)
  coversFloor: boolean;              // role floor — заменяет тайл пола (клиент пропускает базовый пол в этих клетках)
  blocks: boolean;                   // даёт суб-тайл-препятствие
  blocksSight: boolean;              // препятствие перекрывает и обзор (LoS)
  collider?: { shape: 'circle' | 'box'; r?: number; w?: number; h?: number }; // в ДОЛЯХ тайла
}

/** Параметры плотности расстановки (тюнятся позже; «пачки» декора). */
export interface PlaceDecorOpts {
  chancePerRoom?: number;            // вероятность попытки на одну попытку-слот (0..1)
  maxPerRoom?: number;               // верхняя граница слотов на комнату (масштабируется площадью)
}

const key = (cx: number, cy: number): string => `${cx},${cy}`;

/** Помечает клетку footprint'а (и соседей?) занятой. Возвращает список ключей клеток. */
function footprintCells(cx: number, cy: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) out.push(key(x, y));
  return out;
}

/** Все клетки footprint'а свободны (пол, не заняты, не зарезервированы)? */
function fits(L: DungeonLayout, reserved: Set<string>, cx: number, cy: number, w: number, h: number): boolean {
  for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) {
    if (isBlockedCell(L.grid, x, y)) return false;
    if (L.grid[y]?.[x] !== Cell.Floor) return false;
    if (reserved.has(key(x, y))) return false;
  }
  return true;
}

/** Взвешенный выбор спеки. */
function pickSpec(specs: DecorSpec[], rng: Rng): DecorSpec | null {
  let total = 0;
  for (const s of specs) total += Math.max(0, s.weight);
  if (total <= 0) return specs[rng.int(0, specs.length - 1)] ?? null;
  let r = rng.float(0, total);
  for (const s of specs) { r -= Math.max(0, s.weight); if (r <= 0) return s; }
  return specs[specs.length - 1] ?? null;
}

const QUADS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

/**
 * Расставляет напольный декор по НЕ-входным комнатам (детерминированно от `rng`). Клетки грида НЕ
 * меняются (проходимость сохраняется) — footprint лишь резервирует клетки от наложения; коллизия —
 * суб-тайловая (см. `obstaclesFromDecor`). Пишет обогащённые `DecorObject{kind:'obj'}` в `L.decor`.
 */
export function placeFloorDecor(L: DungeonLayout, allSpecs: DecorSpec[], rng: Rng, opts: PlaceDecorOpts = {}): void {
  const specs = allSpecs.filter((s) => s.surface === 'floor');   // на пол — по комнатам; на стену — placeWallProps
  if (!specs.length) return;
  const chance = opts.chancePerRoom ?? 1;    // глобальный гейт слота (частоту рулит per-object spawnChance)
  const maxPer = opts.maxPerRoom ?? 2;

  // Резерв: клетки спавна/выходов/лестницы + уже существующего декора + дверей/рычагов.
  const reserved = new Set<string>();
  const reserveWorld = (p: { x: number; y: number }): void => { const c = worldToCell(p.x, p.y); reserved.add(key(c.cx, c.cy)); };
  reserveWorld(L.spawn);
  reserveWorld(L.stairsDown);
  for (const e of L.exits) reserveWorld(e);
  for (const d of L.decor) reserveWorld(d);
  for (const d of L.doors) for (const c of d.cells) reserved.add(key(c.cx, c.cy));
  for (const lv of L.levers) reserveWorld(lv);

  for (const room of L.rooms) {
    if (room.type === 'entrance') continue;
    // Число слотов ~ площади интерьера (с запасом-границей у стен), но не больше maxPer.
    const interior = Math.max(0, (room.w - 2) * (room.h - 2));
    const slots = Math.min(maxPer, Math.max(0, Math.floor(interior / 60)) + 1);
    for (let s = 0; s < slots; s++) {
      if (rng.float(0, 1) > chance) continue;
      const spec = pickSpec(specs, rng);
      if (!spec) continue;
      if (rng.float(0, 1) > (spec.spawnChance ?? 1)) continue;   // ЧАСТОТА СПАВНА объекта (config objects[].spawnChance)
      const fw = Math.max(1, spec.footprint.w);
      const fh = Math.max(1, spec.footprint.h);
      // Кандидат-угол footprint'а внутри комнаты с 1-клеточной границей у стен.
      const x0 = room.x + 1;
      const y0 = room.y + 1;
      const x1 = room.x + room.w - 1 - fw;
      const y1 = room.y + room.h - 1 - fh;
      if (x1 < x0 || y1 < y0) continue;
      let placed = false;
      for (let tries = 0; tries < 8 && !placed; tries++) {
        const cx = rng.int(x0, x1);
        const cy = rng.int(y0, y1);
        if (!fits(L, reserved, cx, cy, fw, fh)) continue;
        for (const k of footprintCells(cx, cy, fw, fh)) reserved.add(k);
        const wx = cx * TILE + (fw * TILE) / 2;   // центр footprint'а (мир)
        const wy = cy * TILE + (fh * TILE) / 2;
        L.decor.push({ x: wx, y: wy, kind: 'obj', objectId: spec.id, rot: QUADS[rng.int(0, 3)]!, footprint: { w: fw, h: fh } });
        placed = true;
      }
    }
  }
}

/**
 * Ставит props ПОВЕРХ стен (surface:'wall'): по открытым в комнату граням стен-клеток, детерминированно от `rng` с
 * частотой `spawnChance`. Позиция — центр клетки + смещение к грани на ½TILE; поворот — лицом в комнату. Клетки грида
 * НЕ меняются. Пишет `DecorObject{kind:'obj'}` в `L.decor` (клиент рисует через проп-систему).
 */
export function placeWallProps(L: DungeonLayout, allSpecs: DecorSpec[], rng: Rng): void {
  const specs = allSpecs.filter((s) => s.surface === 'wall');
  if (!specs.length) return;
  const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
  const walk = (x: number, y: number): boolean => { const c = L.grid[y]?.[x]; return c !== undefined && c !== Cell.Wall; };
  const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const used = new Set<string>();   // «x,y,dx,dz» — одна грань = один проп
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (L.grid[y]![x] !== Cell.Wall) continue;
    for (const [dx, dz] of N4) {
      if (!walk(x + dx, y + dz)) continue;   // грань открыта в проходимую клетку
      const k = `${x},${y},${dx},${dz}`;
      if (used.has(k)) continue;
      const spec = pickSpec(specs, rng);
      if (!spec) continue;
      if (rng.float(0, 1) > spec.spawnChance) continue;
      used.add(k);
      const wx = x * 32 + 16 + dx * 16, wy = y * 32 + 16 + dz * 16;   // центр клетки + к грани (TILE=32)
      L.decor.push({ x: wx, y: wy, kind: 'obj', objectId: spec.id, rot: Math.atan2(dx, dz), footprint: { w: 1, h: 1 } });
    }
  }
}

/**
 * Деривит суб-тайловые препятствия из размещённого декора: для каждого `kind:'obj'`-декора,
 * чей объект `blocks`, строит `Obstacle` из коллайдера (доли тайла → world px, повёрнут на rot).
 * Нет коллайдера → дефолт-круг r=0.4 тайла (умещается в клетке, не запирает её целиком).
 */
export function obstaclesFromDecor(decor: DecorObject[], byId: Map<string, DecorSpec>): Obstacle[] {
  const out: Obstacle[] = [];
  for (const d of decor) {
    if (d.kind !== 'obj' || !d.objectId) continue;
    const spec = byId.get(d.objectId);
    if (!spec || !spec.blocks) continue;
    const col = spec.collider;
    if (col?.shape === 'box') {
      out.push({ x: d.x, y: d.y, shape: 'box', hw: ((col.w ?? 0.6) * TILE) / 2, hh: ((col.h ?? 0.6) * TILE) / 2, yaw: d.rot ?? 0, blocksSight: spec.blocksSight });
    } else {
      out.push({ x: d.x, y: d.y, shape: 'circle', r: (col?.r ?? 0.4) * TILE, blocksSight: spec.blocksSight });
    }
  }
  return out;
}

interface ObjCfgLite {
  id: string; modelId: string; enabled: boolean; role: string; surface?: 'floor' | 'wall'; biomes: string[];
  blocks: boolean; blocksSight: boolean; footprint: { w: number; h: number }; spawnChance?: number;
  collider?: { shape: 'circle' | 'box'; r?: number; w?: number; h?: number };
}

/** Расставляемый ли объект СЕРВЕРОМ: floor-россыпь (footprint>1) / prop. (floor 1×1 = базовый тайл-cellHash на клиенте; decor отложен.) */
function isPlaceable(o: ObjCfgLite): boolean {
  if (o.role === 'floor') return o.footprint.w > 1 || o.footprint.h > 1;   // floor-россыпь вместо базовых тайлов
  return o.role === 'prop';
}

/** Строит спеки расставляемых объектов из config `objects` для биома. Коллайдер: явный на объекте перекрывает; иначе из
 *  меша модели (`models[].collider`, извлечён из `collider*` GLB); ⭐ 08.10 (Ф1) иначе из манифеста арта Unity (`art[].collider` —
 *  меш `collider*` в FBX); иначе дефолт-круг. Пол-россыпь (role floor) `coversFloor`. */
export function decorSpecsFor(
  objects: ObjCfgLite[],
  models: { id: string; collider?: { shape: 'circle' | 'box'; r?: number; w?: number; h?: number } }[],
  biomeId: string | undefined,
  art: { id: string; collider?: { shape: 'circle' | 'box'; r?: number; w?: number; h?: number } }[] = [],
): DecorSpec[] {
  type Col = { shape: 'circle' | 'box'; r?: number; w?: number; h?: number };
  const modelCollider = new Map<string, Col>();
  for (const a of art) if (a.collider) modelCollider.set(a.id, a.collider);     // меш collider* FBX (каталог Unity)
  for (const m of models) if (m.collider) modelCollider.set(m.id, m.collider);  // записанный в модель — главнее
  return objects
    .filter((o) => o.enabled && isPlaceable(o) && (!biomeId || o.biomes.length === 0 || o.biomes.includes(biomeId)))
    .map((o) => ({
      id: o.id, footprint: o.footprint, weight: 1, spawnChance: o.spawnChance ?? 0.35,
      surface: o.role === 'prop' ? (o.surface ?? 'floor') : 'floor',   // props — по конфигу; floor-россыпь — всегда пол
      coversFloor: o.role === 'floor',                                  // floor-россыпь заменяет базовый тайл пола
      blocks: o.blocks, blocksSight: o.blocksSight, collider: o.collider ?? modelCollider.get(o.modelId),
    }));
}
