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
  /** ⭐ 12.10 (Ф1 «Паспорт»): контексты паспорта декора (`art[].decor.contexts`). Нет поля (объект без паспорта) — как прежде: пол или стена
   *  по `surface`. С паспортом проход Ф1 ставит объект, только если его контекст есть в паспорте: россыпь пола — `floor`, грани стен — `wall`
   *  (на гранях — только строка `objects`, не неявный объект: `placeWallProps`); прочие контексты (у стены, угол, проём, сокет, сор) — слоты
   *  Ф2–Ф5, сейчас не ставятся. */
  contexts?: readonly string[];
  /** ⭐ 12.10: множители веса паспорта по типу комнаты (`Room.type`) и коридору; нет — 1 везде. */
  rooms?: Readonly<Partial<Record<string, number>>>;
  /** ⭐ 12.10: неявный объект — ключ манифеста с паспортом без строки `objects` (`placeableObjects`). */
  implicit?: boolean;
  /** ⭐ 12.10: паспорт модели целиком (поля для Ф2: якорь, лицо, теги, полосы, проём, штабель) — расстановкой Ф1 не читается. */
  passport?: Readonly<DecorPassportLite>;
}

/** ⭐ 12.10: паспорт декора, как его читает расстановка (`art[].decor`, схема `artDecorSchema`; разброс `variance` — картинка, не здесь). */
export interface DecorPassportLite {
  contexts: readonly string[];
  footprint: { w: number; h: number };
  anchor?: string; backOffset?: number; facing?: string;
  clearance?: number; keepPath?: boolean;
  blocks: boolean; blocksSight: boolean; tall?: boolean;
  tags?: readonly string[];
  rooms?: Readonly<Partial<Record<string, number>>>;
  weight?: number;
  biomes?: readonly string[];
  doorway?: { width: number }; stack?: { max: number }; hosts?: readonly string[];
}

/** Параметры плотности расстановки (⭐ 12.10: из конфига биома `biomes[].decorDensity` — `decorPlaceOf`). */
export interface PlaceDecorOpts {
  chancePerRoom?: number;            // вероятность попытки на одну попытку-слот (0..1)
  maxPerRoom?: number;               // верхняя граница слотов на комнату (масштабируется площадью)
  /** ⭐ 12.10: клеток интерьера на слот сверх первого (было зашито 60). */
  areaPerSlot?: number;
}

/** ⭐ 12.10: плотность россыпи биома (`biomes[].decorDensity`); нет поля — `undefined` (умолчания `placeFloorDecor`: 1 / 2 / 60). */
export function decorPlaceOf(biome: { decorDensity?: { chancePerRoom: number; maxPerRoom: number; areaPerSlot: number } } | undefined): PlaceDecorOpts | undefined {
  const d = biome?.decorDensity;
  return d ? { chancePerRoom: d.chancePerRoom, maxPerRoom: d.maxPerRoom, areaPerSlot: d.areaPerSlot } : undefined;
}

/** ⭐ 12.10: ставит ли проход Ф1 объект в контексте `ctx` (`floor` — россыпь пола, `wall` — грани стен): без паспорта — да (как прежде). */
function inContext(s: DecorSpec, ctx: 'floor' | 'wall'): boolean {
  return !s.contexts || s.contexts.includes(ctx);
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
 * ⭐ 12.10 (G3): СЛЕД В ОСЯХ СЕТКИ — `footprint` записан в осях модели (w — по её X, h — по Z; при `rot` 0 модель X идёт по столбцам, Z — по
 * строкам, как бокс коллайдера `obstaclesFromDecor`), поворот на четверть (90°/270°, точнее — `|sin rot| > √½`) меняет стороны местами.
 * Раньше след брался без поворота: стол 1×2, повёрнутый на 90°, резервировал не те клетки, а бокс коллизии при этом поворачивался. У
 * квадратного следа поворот ничего не меняет. Тот же расчёт — у Unity (`EnvRules.CoveredCells`) и веб-стенда (`env3d.ts`).
 */
export function rotatedFootprint(fp: { w: number; h: number }, rot: number | undefined): { w: number; h: number } {
  const w = Math.max(1, fp.w), h = Math.max(1, fp.h);
  return w !== h && Math.abs(Math.sin(rot ?? 0)) > Math.SQRT1_2 ? { w: h, h: w } : { w, h };
}

/**
 * ⭐ 13.10 (ревью Ф2): ДОПУСК ПРИЖАТИЯ СЛЕДА, клеток. Край следа от точки декора, не дальше этого от линии сетки, — на ней (`footprintRect`).
 * Пропы слотов у стены стоят пивотом по глубине МОДЕЛИ (`slots.ts wallPivot`: спинка на линии стены) — до 0.45 клетки от центра своего следа
 * к стене; с прежним eps 1e-9 след их записи захватывал ряд стены за ними (полка — с 12.10), а отступ соседей через этот ряд смотрел сквозь стену:
 * россыпь решёток и сундуки менялись (замер правки: 2 этажа крипты из 400). Точки на узлах и полуузлах (центр посреди клетки — след на клетку
 * шире: костёр в комнате нечётной ширины) дают те же клетки, что прежде: дробная часть 0 и ½ допуском меньше ½ не задевается. Весь прочий декор
 * (россыпь, оформление, арки, центр комнаты) стоит на узлах и полуузлах.
 */
export const FOOTPRINT_SNAP = 0.45;

/**
 * ⭐ 08.10: СЛЕД декора в клетках — прямоугольник `footprint` с центром в точке декора (так их ставят `placeFloorDecor` и костры
 * `placeDressing`; центр посреди клетки — след на клетку шире: костёр в комнате нечётной ширины лежит на трёх клетках). Без `footprint`
 * (портал, лавка, процедурный факел) — клетка под точкой. ⭐ 12.10 (G3): стороны — с поворотом `rot` (`rotatedFootprint`). ⭐ 13.10: край —
 * с допуском `FOOTPRINT_SNAP` (проп, прижатый к стене, — клетки своего слота, без ряда стены).
 */
export function footprintRect(d: { x: number; y: number; footprint?: { w: number; h: number }; rot?: number }): CellRect {
  if (!d.footprint) { const c = worldToCell(d.x, d.y); return { x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy }; }
  const { w: fw, h: fh } = rotatedFootprint(d.footprint, d.rot);
  const cx = d.x / TILE, cy = d.y / TILE, eps = FOOTPRINT_SNAP;   // было 1e-9 (шум деления на краю клетки) — теперь и допуск прижатия
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

/** ⭐ 12.10: вес спеки на месте — её вес × множитель паспорта по типу комнаты (`rooms`; нет — 1). */
function weightAt(s: DecorSpec, place: string | undefined): number {
  const m = place !== undefined ? s.rooms?.[place] : undefined;
  return Math.max(0, s.weight) * (m === undefined ? 1 : Math.max(0, m));
}

/** Взвешенный выбор спеки. ⭐ 12.10: `place` — тип комнаты (множитель паспорта `rooms`); у всех вес 0 — никого (раньше — случайная:
 *  до весов из конфига вес был 1 у всех, и эта ветка не исполнялась ни разу — поток rng прежний). */
function pickSpec(specs: DecorSpec[], rng: Rng, place?: string): DecorSpec | null {
  let total = 0;
  for (const s of specs) total += weightAt(s, place);
  if (total <= 0) return null;
  let r = rng.float(0, total);
  for (const s of specs) { const w = weightAt(s, place); r -= w; if (w > 0 && r <= 0) return s; }
  for (let i = specs.length - 1; i >= 0; i--) if (weightAt(specs[i]!, place) > 0) return specs[i]!;   // шум сложения на краю — последний с весом
  return null;
}

const QUADS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

/**
 * Расставляет напольный декор по НЕ-входным комнатам (детерминированно от `rng`). Клетки грида НЕ
 * меняются (проходимость сохраняется) — footprint лишь резервирует клетки от наложения; коллизия —
 * суб-тайловая (см. `obstaclesFromDecor`). Пишет обогащённые `DecorObject{kind:'obj'}` в `L.decor`.
 * `taken` — клетки «cx,cy», уже занятые оформлением биома (`dressing.ts`); нет — как прежде.
 * ⭐ 08.10: ОТСТУП (`DecorSpec.clearance`, `FloorClaims`) — и у ставящегося объекта, и у уже стоящего декора (`known` — все спеки биома,
 * вместе с выпавшими из россыпи объектами оформления: у костра свой отступ); стоящий декор занимает весь след, а не клетку под точкой.
 * ⭐ 12.10 (ревью Ф2): `lanes` — клетки «cx,cy» полос прохода слотов (`slots.ts`, у биома с правилами пропов): ПРЕГРАДА россыпи (и «не запирать
 * проход») на них не встаёт — иначе строка `objects` с преградой легла бы в полосы (замер ревью: решётка, сделанная преградой, — 58 % на
 * полосах). Не преграда (решётка крипты) — как прежде; нет `lanes` (биом без правил) — как прежде. Отрезать проход россыпь и так не может:
 * кольцо пола вокруг преграды (G11).
 */
export function placeFloorDecor(L: DungeonLayout, allSpecs: DecorSpec[], rng: Rng, opts: PlaceDecorOpts = {}, taken?: ReadonlySet<string>, known?: ReadonlyMap<string, DecorSpec>, lanes?: ReadonlySet<string>): void {
  // на пол — по комнатам; на стену — placeWallProps. ⭐ 12.10: объект с паспортом — только с контекстом `floor` (прочие ждут слотов Ф2)
  const specs = allSpecs.filter((s) => s.surface === 'floor' && inContext(s, 'floor'));
  if (!specs.length) return;
  const chance = opts.chancePerRoom ?? 1;    // глобальный гейт слота (частоту рулит per-object spawnChance)
  const maxPer = opts.maxPerRoom ?? 2;
  const perSlot = Math.max(1, opts.areaPerSlot ?? 60);   // ⭐ 12.10: из конфига биома (было зашито 60)
  const byId = known ?? new Map(allSpecs.map((s) => [s.id, s]));

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
  const claims = claimsOf(L.decor, byId);
  claimLayoutAnchors(claims, L);   // ⭐ 08.10: кольцо решётки — не на выход и не на рычаг
  // ⭐ 12.10 (G11, правило проходимости): клетки следов ПРЕГРАЖДАЮЩЕГО напольного декора (уже стоящего — костры оформления — и новых)
  const blockedFeet = new Set<string>();
  const markBlocked = (r: CellRect): void => { for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) blockedFeet.add(key(x, y)); };
  for (const d of L.decor) {
    const s = d.kind === 'obj' && d.objectId ? byId.get(d.objectId) : undefined;
    if (s?.blocks && s.surface === 'floor') markBlocked(footprintRect(d));
  }
  /**
   * ⭐ 12.10 (G11): ПРАВИЛО ПРОХОДИМОСТИ преграждающей россыпи — вокруг следа кольцо в клетку проходимого пола, и в кольце нет следа другой
   * преграды. Тогда любой путь, шедший сквозь след, обходит его по кольцу (кольцо — замкнутая цепочка клеток пола), и преграды не смыкаются в
   * стену: декор не отрезает ни одной клетки этажа (коллайдер — внутри своего следа). Раньше хватало «на клетку от стен комнаты», пока
   * преграждающей россыпи в данных не было; стол 2×3 в рукаве комнаты-«Г» перегородил бы его целиком. Не преграда (решётка пола) — как прежде.
   */
  const ringFree = (r: CellRect): boolean => {
    for (let y = r.y0 - 1; y <= r.y1 + 1; y++) for (let x = r.x0 - 1; x <= r.x1 + 1; x++) {
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) continue;
      if (L.grid[y]?.[x] !== Cell.Floor || blockedFeet.has(key(x, y))) return false;
    }
    return true;
  };

  for (const room of L.rooms) {
    if (room.type === 'entrance') continue;
    // Число слотов ~ площади интерьера (с запасом-границей у стен), но не больше maxPer.
    const interior = Math.max(0, (room.w - 2) * (room.h - 2));
    const slots = Math.min(maxPer, Math.max(0, Math.floor(interior / perSlot)) + 1);
    for (let s = 0; s < slots; s++) {
      if (rng.float(0, 1) > chance) continue;
      const spec = pickSpec(specs, rng, room.type);   // ⭐ 12.10: вес — с множителем паспорта по типу комнаты
      if (!spec) continue;
      if (rng.float(0, 1) > (spec.spawnChance ?? 1)) continue;   // ЧАСТОТА СПАВНА объекта (config objects[].spawnChance)
      const fw0 = Math.max(1, spec.footprint.w);
      const fh0 = Math.max(1, spec.footprint.h);
      // ⭐ 12.10 (G3): неквадратный след — поворот ДО места (след в клетках — повёрнутый, `rotatedFootprint`), квадратный — после, как прежде
      // (поток rng квадратных тот же: этаж без неквадратной россыпи — байт-в-байт прежний)
      const turn = fw0 !== fh0 ? QUADS[rng.int(0, 3)]! : undefined;
      const { w: fw, h: fh } = rotatedFootprint({ w: fw0, h: fh0 }, turn);
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
        if (spec.blocks && !ringFree(rect)) continue;        // ⭐ 12.10 (G11): кольцо пола вокруг преграды
        if (lanes && (spec.blocks || spec.passport?.keepPath) && footprintCells(cx, cy, fw, fh).some((k) => lanes.has(k))) continue;   // ⭐ 12.10 (ревью Ф2): не на полосу
        claims.claim(rect, spec.clearance);
        for (const k of footprintCells(cx, cy, fw, fh)) reserved.add(k);
        if (spec.blocks) markBlocked(rect);
        const wx = cx * TILE + (fw * TILE) / 2;   // центр footprint'а (мир)
        const wy = cy * TILE + (fh * TILE) / 2;
        // след в записи — в осях модели (как у статуй): клетки — `footprintRect` с поворотом
        L.decor.push({ x: wx, y: wy, kind: 'obj', objectId: spec.id, rot: turn ?? QUADS[rng.int(0, 3)]!, footprint: { w: fw0, h: fh0 } });
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
 * ⭐ 12.10 (ревью Ф1): у прохода граней НЕТ бюджета — бросок на каждую открытую грань, и плотность держит только `spawnChance` строки
 * `objects` (умолчание 0.35). НЕЯВНЫЙ объект (паспорт без строки) идёт с частотой 1 — с контекстом `wall` он занял бы почти каждую грань этажа
 * (замер ревью: 82 % граней, коридоры тоже), поэтому сюда он не допускается: неявный настенный проп ждёт слотов стены Ф2 (с бюджетом).
 * Строка `objects` с поверхностью wall и паспортом модели ставится, как прежде, своей частотой, а вес — с множителем паспорта `rooms` по МЕСТУ
 * грани: тип комнаты, в прямоугольнике которой лежит клетка перед гранью (первой, как зоны пробегов `dressing.ts wallRuns`), иначе `corridor`
 * (`rooms.corridor: 0` — не в коридорах). Без паспортов место не считается — поток rng и раскладка прежние.
 */
export function placeWallProps(L: DungeonLayout, allSpecs: DecorSpec[], rng: Rng, taken?: ReadonlySet<string>): void {
  // ⭐ 12.10: с паспортом — только контекст `wall`; неявный объект — не здесь (см. выше)
  const specs = allSpecs.filter((s) => s.surface === 'wall' && !s.implicit && inContext(s, 'wall'));
  if (!specs.length) return;
  const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
  const walk = (x: number, y: number): boolean => { const c = L.grid[y]?.[x]; return c !== undefined && c !== Cell.Wall; };
  const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const used = new Set<string>(taken ?? []);   // «x,y,dx,dz» — одна грань = один проп; ⭐ 08.10: грани оформления биома (ниши, факелы) заняты сразу
  // ⭐ 12.10: место грани для весов паспорта `rooms` — только если они есть хоть у одной спеки (без паспортов — `undefined`, как прежде)
  const zoned = specs.some((s) => s.rooms);
  const placeOf = (cx: number, cy: number): string | undefined => {
    if (!zoned) return undefined;
    const room = L.rooms.find((r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h);
    return room ? room.type : 'corridor';
  };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (L.grid[y]![x] !== Cell.Wall) continue;
    for (const [dx, dz] of N4) {
      if (!walk(x + dx, y + dz)) continue;   // грань открыта в проходимую клетку
      const k = `${x},${y},${dx},${dz}`;
      if (used.has(k)) continue;
      const spec = pickSpec(specs, rng, placeOf(x + dx, y + dz));   // ⭐ 12.10: вес — с множителем паспорта по месту грани
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

type Col = { shape: 'circle' | 'box'; r?: number; w?: number; h?: number };

/** Объект конфига `objects`, как его читает расстановка (поля строки после схемы). */
export interface ObjCfgLite {
  id: string; modelId: string; enabled: boolean; role: string; surface?: 'floor' | 'wall'; biomes: string[];
  blocks: boolean; blocksSight: boolean; footprint: { w: number; h: number }; spawnChance?: number; clearance?: number;
  collider?: Col;
  /** ⭐ 12.10 (G2): вес россыпи (`objects[].weight`); нет — из паспорта, нет паспорта — 1. */
  weight?: number;
}

/** ⭐ 12.10: строка манифеста арта, как её читает расстановка: ключ, вид, группа каталога, коллайдер, паспорт декора; ⭐ 12.10 (Ф2) габарит
 *  модели (`bounds`, м, в осях модели; Y — вверх) — только для предупреждений (`decorWarnings`: высокая модель без отметки tall). */
export interface ArtRowLite { id: string; kind?: string; group?: string; collider?: Col; decor?: DecorPassportLite; bounds?: { min: number[]; max: number[] } }

/** ⭐ 12.10: объект расстановки — строка `objects` либо неявный объект паспорта; `passport` — паспорт его модели (если есть). */
export type PlaceableObject = ObjCfgLite & { passport?: DecorPassportLite; implicit?: boolean };

/** Расставляемый ли объект СЕРВЕРОМ: floor-россыпь (footprint>1) / prop. (floor 1×1 = базовый тайл-cellHash на клиенте; decor отложен.) */
function isPlaceable(o: ObjCfgLite): boolean {
  if (o.role === 'floor') return o.footprint.w > 1 || o.footprint.h > 1;   // floor-россыпь вместо базовых тайлов
  return o.role === 'prop';
}

/** ⭐ 12.10: строка манифеста — модель пропа или окружения (не персонаж, не .mat библиотеки). */
const isPropArt = (a: ArtRowLite): boolean => a.kind === 'env' || a.kind === 'prop';

/** ⭐ 12.10: биомы неявного объекта — из паспорта, а пустой список паспорта — биом папки каталога (группа `biome_<id>`); иначе нет. */
export function passportBiomes(a: ArtRowLite): string[] {
  const own = (a.decor?.biomes ?? []).filter((b) => !!b);
  if (own.length) return own;
  const g = a.group ?? '';
  return g.startsWith('biome_') && g.length > 'biome_'.length ? [g.slice('biome_'.length)] : [];
}

/** ⭐ 12.10: поверхность неявного объекта по контекстам паспорта — только на стене (`wall`/`wallInsert`) → стена, иначе пол. Настенный
 *  неявный объект в Ф1 не ставится (у граней нет бюджета, `placeWallProps`), но в списке объектов есть — кит Unity его знает заранее. */
export function passportSurface(p: DecorPassportLite): 'floor' | 'wall' {
  return p.contexts.length > 0 && p.contexts.every((c) => c === 'wall' || c === 'wallInsert') ? 'wall' : 'floor';
}

/**
 * ⭐ 12.10 (Ф1 «Паспорт», план декора): ОБЪЕКТЫ РАССТАНОВКИ — строки `objects` (как были) и НЕЯВНЫЕ объекты: ключ манифеста арта Unity
 * (`art[]`, вид env/prop) с паспортом декора (`art[].decor`, компонент `DmDecor` на префабе) и без строки `objects` — ни с `id`, ни с
 * `modelId` этого ключа (строка есть — она и решает: выключенная строка выключает и ключ). Неявный объект: `id` = `modelId` = ключ, роль
 * `prop`, поверхность — по контекстам (`passportSurface`), биомы — `passportBiomes` (нет биома — не ставится, предупреждение редактора),
 * след/отступ/преграда/обзор/вес — паспорта, частота — 1 (сколько пропов в комнате, решают слоты биома `decorDensity` и веса паспортов; у граней
 * стен слотов нет — неявный объект в Ф1 ставит только россыпь пола, `placeWallProps` его не берёт).
 * Порядок: строки `objects` по конфигу, затем неявные ПО КЛЮЧУ (не по порядку строк манифеста — экспорт его переставляет). Строке `objects` с моделью-паспортом паспорт приходит как `passport`
 * (её поля главнее). Та же функция — у Unity (`EnvRules.PropSpecs`, сторож — раздел `decor` эталона `EnvCheck`).
 */
export function placeableObjects(objects: readonly ObjCfgLite[], art: readonly ArtRowLite[] = []): PlaceableObject[] {
  const passport = new Map<string, ArtRowLite>();
  for (const a of art) if (a.decor && isPropArt(a) && !passport.has(a.id)) passport.set(a.id, a);
  const claimed = new Set<string>();
  for (const o of objects) { claimed.add(o.id); claimed.add(o.modelId); }
  const out: PlaceableObject[] = objects.map((o) => {
    const p = passport.get(o.modelId)?.decor;
    return p ? { ...o, passport: p } : o;
  });
  // ⭐ 12.10: неявные — по ключу (порядок кодовых единиц, как `string.CompareOrdinal` Unity), а не по порядку строк манифеста: экспорт Unity
  // строки переставляет, а порядок спек — это выбор по весу из rng, то есть иначе каждая выгрузка манифеста меняла бы этажи тех же сидов
  const implicitRows = [...passport.values()].filter((a) => !claimed.has(a.id)).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const a of implicitRows) {
    const p = a.decor!;
    out.push({
      id: a.id, modelId: a.id, enabled: true, role: 'prop', surface: passportSurface(p), biomes: passportBiomes(a),
      blocks: p.blocks, blocksSight: p.blocksSight, footprint: { w: p.footprint.w, h: p.footprint.h },
      spawnChance: 1, clearance: p.clearance ?? 0, weight: p.weight, passport: p, implicit: true,
    });
  }
  return out;
}

/** Строит спеки расставляемых объектов из config `objects` для биома. Коллайдер: явный на объекте перекрывает; иначе из
 *  меша модели (`models[].collider`, извлечён из `collider*` GLB); ⭐ 08.10 (Ф1) иначе из манифеста арта Unity (`art[].collider` —
 *  меш `collider*` в FBX); иначе дефолт-круг. Пол-россыпь (role floor) `coversFloor`. ⭐ 08.10: `clearance` — отступ (`FloorClaims`).
 *  ⭐ 12.10 (Ф1 «Паспорт»): + неявные объекты паспортов декора (`placeableObjects`); вес — строки, иначе паспорта, иначе 1 (G2: был зашит
 *  1); контексты и веса по комнатам — паспорта. Неявный объект без биома не ставится нигде (и при `biomeId` undefined — тоже). */
export function decorSpecsFor(
  objects: ObjCfgLite[],
  models: { id: string; collider?: Col }[],
  biomeId: string | undefined,
  art: ArtRowLite[] = [],
): DecorSpec[] {
  const modelCollider = new Map<string, Col>();
  for (const a of art) if (a.collider) modelCollider.set(a.id, a.collider);     // меш collider* FBX (каталог Unity)
  for (const m of models) if (m.collider) modelCollider.set(m.id, m.collider);  // записанный в модель — главнее
  return placeableObjects(objects, art)
    .filter((o) => o.enabled && isPlaceable(o) && (o.implicit
      ? o.biomes.length > 0 && (!biomeId || o.biomes.includes(biomeId))
      : !biomeId || o.biomes.length === 0 || o.biomes.includes(biomeId)))
    .map((o) => {
      const s: DecorSpec = {
        id: o.id, footprint: o.footprint, weight: o.weight ?? o.passport?.weight ?? 1, spawnChance: o.spawnChance ?? 0.35,
        surface: o.role === 'prop' ? (o.surface ?? 'floor') : 'floor',   // props — по конфигу; floor-россыпь — всегда пол
        coversFloor: o.role === 'floor',                                  // floor-россыпь заменяет базовый тайл пола
        blocks: o.blocks, blocksSight: o.blocksSight, collider: o.collider ?? modelCollider.get(o.modelId),
        clearance: Math.max(0, Math.floor(o.clearance ?? 0)),   // ⭐ 08.10: отступ напольного декора, клеток
      };
      // ⭐ 12.10: паспорт — только у объектов с ним (без паспорта спека та же, что прежде)
      if (o.passport) { s.contexts = o.passport.contexts; if (o.passport.rooms) s.rooms = o.passport.rooms; s.passport = o.passport; }
      if (o.implicit) s.implicit = true;
      return s;
    });
}

/** ⭐ 12.10 (Ф2): порог «высокой» модели, м — как у Unity (`DM.Art.DmDecor.TallHeight`: без правки паспорта tall = верх модели выше 1.5 м). */
export const DECOR_TALL_HEIGHT = 1.5;

/** ⭐ 12.10 (Ф2): биом, как его читают предупреждения расстановки — оформление (ссылки на объекты) и слоты правил пропов (`dressing.props`;
 *  сырые данные редактора: нет поля слота — включён, нет `minFoot` — 2, как умолчания схемы). */
export interface BiomeDecorLite {
  id: string;
  dressing?: {
    torch?: { objectId?: string };
    statues?: { objectIds?: readonly string[] };
    firePits?: { objectIds?: readonly string[] };
    props?: {
      center?: { on?: boolean; minFoot?: number };
      againstWall?: { on?: boolean };
      corner?: { on?: boolean };
      doorway?: { on?: boolean };
      wall?: { on?: boolean };
    };
  };
}
type PropSlotsLite = NonNullable<NonNullable<BiomeDecorLite['dressing']>['props']>;

const slotOn = (x?: { on?: boolean }): boolean => x?.on !== false;

/** ⭐ 12.10 (Ф2): в каких контекстах слоты биома (`dressing.props`, `slots.ts`) на самом деле ставят проп `s`: floor — центр (не высокий, след от
 *  `minFoot`), againstWall — у стены, corner — угол (следы до 2 × 2), doorway — арка с `doorway.width`, wall — грань; socket / scatter /
 *  doorFlank / wallInsert — наборы и мелочь Ф4–Ф5 (сейчас никогда). */
function slotContexts(s: DecorSpec, props: PropSlotsLite): string[] {
  const fw = s.footprint.w, fh = s.footprint.h, tall = !!s.passport?.tall;
  const ok: Record<string, boolean> = {
    floor: slotOn(props.center) && !tall && Math.min(fw, fh) >= (props.center?.minFoot ?? 2),
    againstWall: slotOn(props.againstWall),
    corner: slotOn(props.corner) && Math.max(fw, fh) <= 2,
    doorway: slotOn(props.doorway) && !!s.passport?.doorway?.width,
    wall: slotOn(props.wall) && s.surface === 'wall',   // ⭐ 12.10 (ревью Ф2): грани берут только настенные (паспорт лишь wall/wallInsert)
  };
  return (s.contexts ?? []).filter((c) => ok[c]);
}

/** Слоты правил пропов → контекст паспорта, который каждый ставит, и подпись для предупреждения. */
const SLOT_CONTEXT: readonly [keyof PropSlotsLite, string, string][] = [
  ['center', 'floor', 'центр комнаты'], ['againstWall', 'againstWall', 'у стены'], ['corner', 'corner', 'угол'], ['doorway', 'doorway', 'арка в проём'], ['wall', 'wall', 'грань стены'],
];

/**
 * ⭐ 12.10 (G15 и паспорт): ПРЕДУПРЕЖДЕНИЯ РАССТАНОВКИ (редактор, «Проверить конфиг»; сторож — `decorPassport.test.ts`):
 *  • объект роли `decor` — сервер его не ставит вовсе («отложено»): раньше такой объект молча пропадал, для пропа — роль `prop`;
 *  • паспорт без биома (ни `biomes` паспорта, ни группы `biome_<id>` каталога) — неявный объект не встанет ни в одном биоме;
 *  • паспорт без контекстов — не встанет нигде.
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора — «Как проверяем»; сторож — `decorWarnings.test.ts`):
 *  • ВЫСОКИЙ У БЛИЖНЕЙ СТЕНЫ: модель выше `DECOR_TALL_HEIGHT` без отметки tall (слоты пустят её и к ближним стенам — закроет героя); с `biomes` —
 *    высокий проп биома БЕЗ правил пропов: россыпь Ф1 (контекст floor) и грани строкой `objects` (контекст wall) дальних стен не различают;
 *  • ПРАВИЛА БЕЗ ПРОПОВ (с `biomes`): ссылка оформления (факел, статуи, костры) на объект, которого нет в «Объектах», выключенный или чужой биому
 *    (правило молча пустое); правила пропов без единого пропа с паспортом в биоме; включённый слот без пропа, которого он ставит;
 *  • ПРОП, КОТОРЫЙ СЛОТЫ МОЛЧА ПРОПУСКАЮТ (с `biomes`, у биома с правилами): ни один его контекст не ставится (floor со следом меньше `minFoot`
 *    или высокий, угол шире 2 клеток, doorway без ширины, выключенный слот); только сокет с хозяевами — не предупреждение (наборы Ф4, решение
 *    владельца 12.10: стулья и табуреты ждут столов).
 */
export function decorWarnings(
  objects: readonly ObjCfgLite[], art: readonly ArtRowLite[] = [], biomes: readonly BiomeDecorLite[] = [],
): { section: 'objects' | 'art' | 'biomes'; id: string; msg: string }[] {
  const out: { section: 'objects' | 'art' | 'biomes'; id: string; msg: string }[] = [];
  for (const o of objects) {
    if (o.enabled && o.role === 'decor') out.push({ section: 'objects', id: o.id, msg: 'роль decor сервер не расставляет («отложено») — объекта не будет на этажах; для пропа — роль prop' });
  }
  for (const o of placeableObjects(objects, art)) {
    if (!o.implicit) continue;
    if (!o.biomes.length) out.push({ section: 'art', id: o.id, msg: 'паспорт декора без биома (ни biomes паспорта, ни папки Env/<биом>/) — неявный объект не встанет ни в одном биоме' });
    if (!o.passport?.contexts.length) out.push({ section: 'art', id: o.id, msg: 'паспорт декора без контекстов — неявный объект не встанет нигде' });
  }
  // ⭐ 12.10 (ревью Ф2): настенный контекст вперемешку с напольными — поверхность пол (`passportSurface`): слоты граней его не берут (Unity нарисовал
  // бы его на полу и не гасил со стеной), настенным он не встанет нигде
  for (const a of art) {
    const cs = a.decor?.contexts ?? [];
    if (!a.decor || !isPropArt(a) || !cs.some((c) => c === 'wall' || c === 'wallInsert') || passportSurface(a.decor) === 'wall') continue;
    out.push({ section: 'art', id: a.id, msg: `паспорт смешивает настенные (wall / wallInsert) и напольные контексты (${cs.join(', ')}) — поверхность пол: на грани стен он не встанет (слоты граней берут только настенные); настенный проп — отдельная модель с одними настенными контекстами` });
  }
  // ⭐ 12.10 (Ф2): высокая модель без отметки tall — по габариту манифеста (у ключа бывает и строка .mat библиотеки без габарита — её мимо)
  for (const a of art) {
    if (!a.decor || !isPropArt(a) || a.decor.tall || !(a.decor.contexts ?? []).some((c) => c !== 'socket' && c !== 'scatter')) continue;
    const top = a.bounds?.max?.[1];
    if (typeof top === 'number' && top > DECOR_TALL_HEIGHT) {
      out.push({ section: 'art', id: a.id, msg: `модель высотой ${top.toFixed(2)} м (выше ${DECOR_TALL_HEIGHT}) без отметки tall — слоты поставят её и у ближних к камере стен, она закроет героя; отметь tall в DmDecor` });
    }
  }
  if (!biomes.length) return out;
  // сырые строки редактора: нет поля — умолчание схемы
  const rows: ObjCfgLite[] = objects.map((o) => ({ ...o, enabled: o.enabled !== false, biomes: o.biomes ?? [], footprint: o.footprint ?? { w: 1, h: 1 }, role: o.role ?? 'prop' }));
  const byId = new Map(rows.map((o) => [o.id, o]));
  for (const b of biomes) {
    const d = b.dressing;
    if (!d) continue;
    // оформление: ссылка на объект — есть, включён, свой биому (иначе `placeDressing` его не ставит — правило молча пустое)
    const refs: [string, string][] = [];
    if (d.torch?.objectId) refs.push(['torch', d.torch.objectId]);
    for (const id of d.statues?.objectIds ?? []) if (id) refs.push(['statues', id]);
    for (const id of d.firePits?.objectIds ?? []) if (id) refs.push(['firePits', id]);
    for (const [rule, id] of refs) {
      const o = byId.get(id);
      const why = !o ? 'нет в «Объектах»' : !o.enabled ? 'выключен' : o.biomes.length && !o.biomes.includes(b.id) ? `не из биома ${b.id}` : '';
      if (why) out.push({ section: 'biomes', id: b.id, msg: `оформление ${rule}: объект «${id}» ${why} — правило молча пустое` });
    }
    const specs = decorSpecsFor(rows, [], b.id, [...art]).filter((s) => !!s.contexts);
    const props = d.props;
    if (!props) {
      // путь Ф1: россыпь пола и грани строкой objects дальние стены не различают
      for (const s of specs) {
        if (!s.passport?.tall) continue;
        const where = s.contexts!.includes('floor') ? 'россыпью пола' : s.contexts!.includes('wall') && !s.implicit ? 'на гранях стен' : '';
        if (where) out.push({ section: 'biomes', id: b.id, msg: `высокий проп «${s.id}» без правил пропов (dressing.props) ставится ${where} и у ближних к камере стен — включи правила пропов (слоты ставят высокое только у дальних стен) или сними контекст` });
      }
      continue;
    }
    if (!specs.length) { out.push({ section: 'biomes', id: b.id, msg: 'правила пропов (dressing.props) есть, а пропов с паспортом декора у биома нет — слоты пусты' }); continue; }
    for (const [slot, ctx, name] of SLOT_CONTEXT) {
      if (slotOn(props[slot]) && !specs.some((s) => slotContexts(s, props).includes(ctx))) {
        out.push({ section: 'biomes', id: b.id, msg: `правила пропов: слот «${name}» (${slot}) включён, а пропа, которого он ставит (контекст ${ctx}), у биома нет — слот пуст: выключи его или дай пропу контекст` });
      }
    }
    for (const s of specs) {
      if (slotContexts(s, props).length) continue;
      const cs = s.contexts!;
      if (cs.length && cs.every((c) => c === 'socket') && s.passport?.hosts?.length) continue;   // ждёт хозяина (наборы Ф4) — решение, не ошибка
      out.push({ section: 'biomes', id: b.id, msg: `проп «${s.id}» (контексты ${cs.join(', ') || '—'}, след ${s.footprint.w} × ${s.footprint.h}${s.passport?.tall ? ', высокий' : ''}) слотами не ставится: центр — не высокий и со следом от minFoot ${props.center?.minFoot ?? 2}, угол — до 2 × 2, doorway — с шириной проёма, socket / scatter / doorFlank / wallInsert — наборы Ф4 и мелочь Ф5` });
    }
  }
  return out;
}
