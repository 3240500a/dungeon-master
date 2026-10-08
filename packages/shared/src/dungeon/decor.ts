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
  /** ⭐ 08.10: отступ напольного декора, клеток (`objects[].clearance`): кольцо вокруг следа без другого напольного декора; нет/0 — как прежде. */
  clearance?: number;
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

/** Прямоугольник клеток (включительно). */
export interface CellRect { x0: number; y0: number; x1: number; y1: number }

/**
 * ⭐ 08.10: СЛЕД декора в клетках — прямоугольник `footprint` с центром в точке декора (так их ставят `placeFloorDecor` и костры
 * `placeDressing`; центр посреди клетки — след на клетку шире: костёр в комнате нечётной ширины лежит на трёх клетках). Без `footprint`
 * (портал, лавка, процедурный факел) — клетка под точкой.
 */
export function footprintRect(d: { x: number; y: number; footprint?: { w: number; h: number } }): CellRect {
  if (!d.footprint) { const c = worldToCell(d.x, d.y); return { x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy }; }
  const fw = Math.max(1, d.footprint.w), fh = Math.max(1, d.footprint.h);
  const cx = d.x / TILE, cy = d.y / TILE, eps = 1e-9;   // eps — от шума деления на краю клетки
  return { x0: Math.floor(cx - fw / 2 + eps), y0: Math.floor(cy - fh / 2 + eps), x1: Math.ceil(cx + fw / 2 - eps) - 1, y1: Math.ceil(cy + fh / 2 - eps) - 1 };
}

/**
 * ⭐ 08.10: ОТСТУП НАПОЛЬНОГО ДЕКОРА (`objects[].clearance`, клеток; решение владельца — костёр и решётка рядом «не очень красиво»): кольцо
 * в `clearance` клеток вокруг следа, где не стоит ДРУГОЙ напольный декор. Правило в обе стороны: объект не ставится, если его след попал в
 * след + отступ уже стоящего, ИЛИ его след + СВОЙ отступ задел след уже стоящего, — у двух объектов с отступом 1 между следами всегда
 * клетка пола (не касаются ни гранью, ни углом). Отступ 0 у всех — ничего не меняется: следы и так не пересекаются (`fits`), раскладка
 * байт-в-байт прежняя. Настенный декор (факелы, ниши статуй) — не напольный: его клетки перед гранью и так заняты (`taken`).
 */
export class FloorClaims {
  private readonly feet = new Set<string>();   // клетки следов напольного декора
  private readonly halo = new Set<string>();   // клетки «след + отступ» объектов с отступом
  /** Занять след с отступом `clearance`. */
  claim(r: CellRect, clearance = 0): void {
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) this.feet.add(key(x, y));
    const c = Math.max(0, Math.floor(clearance));
    if (c > 0) for (let y = r.y0 - c; y <= r.y1 + c; y++) for (let x = r.x0 - c; x <= r.x1 + c; x++) this.halo.add(key(x, y));
  }
  /** След `r` с отступом `clearance` не попал в чужой отступ и не задел чужой след. */
  free(r: CellRect, clearance = 0): boolean {
    if (this.halo.size) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (this.halo.has(key(x, y))) return false;
    const c = Math.max(0, Math.floor(clearance));
    for (let y = r.y0 - c; y <= r.y1 + c; y++) for (let x = r.x0 - c; x <= r.x1 + c; x++) if (this.feet.has(key(x, y))) return false;
    return true;
  }
}

/**
 * ⭐ 08.10 (ревью, решение владельца «на костре не ставить»): точки этажа, которые декор с отступом не задевает и кольцом — вход, лестница,
 * выходы, рычаги, клетки дверей. Занимают след в клетку БЕЗ отступа: у объектов без отступа проверка та же, что у `fits`/`reserved`
 * (раскладка прежняя), а кольцо решётки или костра больше не ложится на выход или рычаг.
 */
export function claimLayoutAnchors(claims: FloorClaims, L: DungeonLayout): void {
  const cell = (p: { x: number; y: number }): void => { const c = worldToCell(p.x, p.y); claims.claim({ x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy }); };
  cell(L.spawn); cell(L.stairsDown);
  for (const e of L.exits) cell(e);
  for (const lv of L.levers) cell(lv);
  for (const d of L.doors) for (const c of d.cells) claims.claim({ x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy });
}

/**
 * ⭐ 08.10: занятость пола декором, уже стоящим на этаже: напольный объект (`known` — спеки биома, и выпавшие из россыпи объекты
 * оформления тоже) — своим следом и отступом; прочий декор (портал, лавка, процедурный факел, объект без спеки) — клеткой под точкой;
 * настенный (`surface: 'wall'`) — мимо.
 */
export function claimsOf(decor: readonly DecorObject[], known?: ReadonlyMap<string, DecorSpec>): FloorClaims {
  const claims = new FloorClaims();
  for (const d of decor) {
    const spec = d.kind === 'obj' && d.objectId ? known?.get(d.objectId) : undefined;
    if (spec?.surface === 'wall') continue;
    if (spec) claims.claim(footprintRect(d), spec.clearance ?? 0);
    else { const c = worldToCell(d.x, d.y); claims.claim({ x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy }); }
  }
  return claims;
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
 * `taken` — клетки «cx,cy», уже занятые оформлением биома (`dressing.ts`); нет — как прежде.
 * ⭐ 08.10: ОТСТУП (`DecorSpec.clearance`, `FloorClaims`) — и у ставящегося объекта, и у уже стоящего декора (`known` — все спеки биома,
 * вместе с выпавшими из россыпи объектами оформления: у костра свой отступ); стоящий декор занимает весь след, а не клетку под точкой.
 */
export function placeFloorDecor(L: DungeonLayout, allSpecs: DecorSpec[], rng: Rng, opts: PlaceDecorOpts = {}, taken?: ReadonlySet<string>, known?: ReadonlyMap<string, DecorSpec>): void {
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
  // ⭐ 08.10: клетки, занятые оформлением биома (`placeDressing`: костёр целиком, клетки перед нишами и факелами) — «cx,cy».
  if (taken) for (const k of taken) reserved.add(k);
  // ⭐ 08.10: следы и отступы стоящего декора (костёр — весь след 2×2 и кольцо отступа); отступ 0 у всех — проверка ниже всегда проходит
  const claims = claimsOf(L.decor, known ?? new Map(allSpecs.map((s) => [s.id, s])));
  claimLayoutAnchors(claims, L);   // ⭐ 08.10: кольцо решётки — не на выход и не на рычаг

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
        const rect = { x0: cx, y0: cy, x1: cx + fw - 1, y1: cy + fh - 1 };
        if (!claims.free(rect, spec.clearance)) continue;   // ⭐ 08.10: отступ — свой и соседей
        claims.claim(rect, spec.clearance);
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
 * НЕ меняются. Пишет `DecorObject{kind:'obj'}` в `L.decor` (клиент рисует через проп-систему). `taken` — грани «x,y,dx,dz»,
 * уже занятые оформлением биома: на них ни пропа, ни броска; нет `taken` — как прежде.
 */
export function placeWallProps(L: DungeonLayout, allSpecs: DecorSpec[], rng: Rng, taken?: ReadonlySet<string>): void {
  const specs = allSpecs.filter((s) => s.surface === 'wall');
  if (!specs.length) return;
  const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
  const walk = (x: number, y: number): boolean => { const c = L.grid[y]?.[x]; return c !== undefined && c !== Cell.Wall; };
  const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const used = new Set<string>(taken ?? []);   // «x,y,dx,dz» — одна грань = один проп; ⭐ 08.10: грани оформления биома (ниши, факелы) заняты сразу
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
  blocks: boolean; blocksSight: boolean; footprint: { w: number; h: number }; spawnChance?: number; clearance?: number;
  collider?: { shape: 'circle' | 'box'; r?: number; w?: number; h?: number };
}

/** Расставляемый ли объект СЕРВЕРОМ: floor-россыпь (footprint>1) / prop. (floor 1×1 = базовый тайл-cellHash на клиенте; decor отложен.) */
function isPlaceable(o: ObjCfgLite): boolean {
  if (o.role === 'floor') return o.footprint.w > 1 || o.footprint.h > 1;   // floor-россыпь вместо базовых тайлов
  return o.role === 'prop';
}

/** Строит спеки расставляемых объектов из config `objects` для биома. Коллайдер: явный на объекте перекрывает; иначе из
 *  меша модели (`models[].collider`, извлечён из `collider*` GLB); ⭐ 08.10 (Ф1) иначе из манифеста арта Unity (`art[].collider` —
 *  меш `collider*` в FBX); иначе дефолт-круг. Пол-россыпь (role floor) `coversFloor`. ⭐ 08.10: `clearance` — отступ (`FloorClaims`). */
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
      clearance: Math.max(0, Math.floor(o.clearance ?? 0)),   // ⭐ 08.10: отступ напольного декора, клеток
    }));
}
