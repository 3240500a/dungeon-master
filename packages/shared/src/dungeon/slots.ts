import { createRng, type Rng } from '../formulas/rng.js';
import { Cell, TILE, cellToWorld, worldToCell } from '../world/grid.js';
import { PLAYER_RADIUS, type Obstacle } from '../world/state.js';
import { NAV_CELL, NAV_DOWN, NAV_RIGHT, segmentHits } from '../world/pathfind.js';
import type { BiomeDressing } from '../config/schemas.js';
import type { DecorObject, DungeonLayout } from './floorCommon.js';
import { FOOTPRINT_SNAP, footprintRect, obstaclesFromDecor, type CellRect, type DecorSpec } from './decor.js';
import { isFarFace, snapCenter, toCameraXY, wallRuns } from './dressing.js';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора): РАССТАНОВКА ПРОПОВ ПО ПАСПОРТАМ — правило биома `biomes[].dressing.props` вместо россыпи Ф1.
 * Чистая детерминированная функция раскладки, сида и правил; зовётся из `generateFloorParams` ПОСЛЕ оформления (Р1: факелы, ниши, костры —
 * без изменений) и ДО россыпи строк без паспорта (решётка пола) и сундуков. Сетку НЕ меняет: пропы — суб-тайловые преграды
 * (`obstaclesFromDecor`), клиенту едут в `FloorInit.decor` как прочий декор `obj` (протокол прежний).
 *
 * ПРОХОДЫ (каждая комната — свои потоки rng `slotSeed(seed, поток, комната)`, у прохода — свой бросок; ⭐ 13.10 (финал ревью): ДРУГИЕ комнаты
 * правка правила меняет только через «одинаковое не рядом» — оно меряет и сквозь стену (замер: 200 этажей крипты, 2854 комнаты — `emptyRoomShare`
 * 0.25 → 0.30 сменил пропы в 152 комнатах, в 4 из них свой бросок «пустая» прежний: соседи через это правило; с `sameNotNear` 0 — 148 и 0); внутри
 * комнаты поздние проходы видят занятое ранними — устья арок, бюджет углов, центр, — так что правка арок, углов или центра двигает и пропы у стен
 * этой комнаты (`doorway.chance` 1 → 0.5 — 30 комнат из 2854); потоки этажа прежние — 0xfea7 фичи, 0xd7e5 оформление, 0xdec0/0x3a11 россыпь,
 * 0xc4e5 сундуки):
 *  • Р0 якоря — спавн, выходы, рычаги, клетки дверей, сундук сокровищницы, портал/лавка/арена — заняты сразу (как `claimLayoutAnchors`);
 *  • Р1 оформление — уже стоит (`placeDressing`): его ниши и костры — чужие следы, факелы — грани, перед которыми высокому нельзя;
 *  • бюджет комнаты (`SLOT_STREAMS.budget`): доля пустых `emptyRoomShare`, иначе от `density.min` до `density.max` на `perArea` клеток пола;
 *  • Р2 центр (`center`): проп с контекстом floor и следом от `minFoot` в центре комнаты от `minRoom`, кольцо пола вокруг — одна на комнату;
 *  • Р0 полосы (`lanes`): дерево кратчайших путей между проёмами комнаты и её якорями, шириной `lanes.width`, + устья проёмов с косяками;
 *    ведутся ПОСЛЕ центра и костра (огибают их по кольцу) и по клеткам, где можно стоять (центр не под коллайдером радиусом героя: ниши статуй) —
 *    в полосе нет ни преграды, ни пропа «не запирать проход» (и преграды россыпи строк без паспорта — `placeFloorDecor`, ⭐ 12.10 ревью);
 *  • проёмы — арки (`doorway`): ширина паспорта = ширине проёма, дальняя стена, рама из стен по краям, не дверь рычага; ⭐ 12.10 (ревью) тень
 *    арки (`doorway.clearBeyond` клеток от камеры) не на полу другой комнаты; «одинаковое не рядом» арок не касается (рама каждого проёма);
 *  • Р4 одиночки: заявки углов (`corner`, шаблон 2 × 2: шанс на угол и пара) берут свою долю бюджета, спиной к стене (`againstWall`,
 *    раньше углов, выбор по весу паспорта; шаг по центрам на стене; ⭐ 13.10 спинка МОДЕЛИ на линии стены — `wallPivot`) — остальное, затем
 *    ставятся углы, а недобор углов (не встали) — снова спиной к стене (⭐ 12.10, ревью); грани стен (`wall`, только настенные спеки; шаг и
 *    шанс; в счёт бюджета не идут; в коридорах — только они и арки); высокие (`tall`) — только у дальних стен (север и восток при азимуте −45°,
 *    `isFarFace`) и не перед факелом; «одинаковое не рядом» (`sameNotNear`, ⭐ 13.10 — между точками слотов, `slotPoint`);
 *  • Р6 проверка на месте: каждая преграда проверяется проходимостью радиусом героя (`Passability`); отрезала клетку, выход, рычаг или
 *    проём, легла на спавн (⭐ 13.10) — откатывается ТОЛЬКО она (счётчик `rejected`), этаж заново не строится.
 *
 * Результат — в раскладке: `L.doorways` (проёмы комнат), `L.lanes` (полосы), `L.slotLog` (бюджеты и счётчики проходов — сводка по сидам и
 * превью редактора). Биом без `props` сюда не попадает: его этаж байт-в-байт прежний (поля раскладки не появляются).
 */

/** Правила пропов биома (`biomes[].dressing.props`). */
export type PropRules = NonNullable<BiomeDressing['props']>;

/** Константы потоков rng проходов слотов (под-сид комнаты — `slotSeed`). */
export const SLOT_STREAMS = { budget: 0x5107, center: 0xce47, corner: 0xc0e2, againstWall: 0xa6a1, doorway: 0xa7c4, wall: 0xfa11 } as const;
/** Номер «комнаты» потока граней стен коридоров (одна ветка на все коридоры этажа). */
export const CORRIDOR_STREAM = 0xffff;

/** Под-сид прохода `pass` для комнаты `i`: своя ветка на комнату и проход (перемешивание целых — murmur3 fmix). */
export function slotSeed(seed: number, pass: number, i: number): number {
  let h = (seed ^ pass) >>> 0;
  h = Math.imul(h ^ ((i + 0x9e3779b9) >>> 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) || 1;
}

/** ⭐ 12.10 (Ф2): ПРОЁМ комнаты — смежная цепочка проходимых клеток сразу за стороной её прямоугольника, перед которыми проходима клетка
 *  комнаты (так проём режет `connectRooms`, так запирает `lockRoom`). */
export interface Doorway {
  /** Индекс комнаты в `L.rooms`. */
  room: number;
  /** Клетки проёма — снаружи прямоугольника комнаты, вдоль стороны, по порядку. */
  cells: { cx: number; cy: number }[];
  /** Клетки комнаты перед ними (первый ряд внутри) — устье проёма. */
  inner: { cx: number; cy: number }[];
  /** Ширина проёма, клеток (= `cells.length`). */
  width: number;
  /** Нормаль стороны НАРУЖУ из комнаты (верх — (0, −1), низ — (0, 1), лево — (−1, 0), право — (1, 0)). */
  dir: { dx: number; dy: number };
  /** Среди клеток — дверь рычага (`Cell.Door`). */
  door: boolean;
  /** По обоим концам проёма на линии его клеток — стены (арке есть во что упереться). */
  framed: boolean;
}

/** ⭐ 12.10 (Ф2): полоса прохода комнаты — клетки (`cy * cols + cx`), где не стоит преграда и проп «не запирать проход». */
export interface LaneSet { room: number; cells: number[] }

/** ⭐ 12.10 (Ф2): журнал расстановки по слотам — сводка по сидам и превью редактора. `rejected` — откаты проверки проходимости (Р6). */
export interface SlotLog {
  rooms: { room: number; type: string; area: number; target: number; empty: boolean; placed: number }[];
  passes: Record<SlotPass, { placed: number; rejected: number }>;
}
export type SlotPass = 'center' | 'againstWall' | 'corner' | 'doorway' | 'wall';

/** Стороны комнаты по порядку обхода: верх, низ, лево, право (нормаль наружу). */
const SIDES: readonly { dx: number; dy: number }[] = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];

/**
 * ⭐ 12.10 (Ф2): ПРОЁМЫ КОМНАТ этажа — для расстановки (арки, устья полос), полос и превью редактора. Порядок — комнаты по `L.rooms`, стороны
 * верх/низ/лево/право, вдоль стороны — по возрастанию. Клетка проёма проходима (пол или дверь) и проходима клетка комнаты перед ней.
 */
export function roomDoorways(L: DungeonLayout): Doorway[] {
  const out: Doorway[] = [];
  const at = (x: number, y: number): Cell | undefined => L.grid[y]?.[x];
  const pass = (x: number, y: number): boolean => { const c = at(x, y); return c === Cell.Floor || c === Cell.Door; };
  L.rooms.forEach((r, room) => {
    for (const dir of SIDES) {
      const horiz = dir.dy !== 0;
      const n = horiz ? r.w : r.h;
      let run: { o: { cx: number; cy: number }; i: { cx: number; cy: number } }[] = [];
      const flush = (): void => {
        if (!run.length) return;
        const tx = horiz ? 1 : 0, ty = horiz ? 0 : 1;
        const a = run[0]!.o, b = run[run.length - 1]!.o;
        out.push({
          room, cells: run.map((c) => c.o), inner: run.map((c) => c.i), width: run.length, dir: { dx: dir.dx, dy: dir.dy },
          door: run.some((c) => at(c.o.cx, c.o.cy) === Cell.Door),
          framed: at(a.cx - tx, a.cy - ty) === Cell.Wall && at(b.cx + tx, b.cy + ty) === Cell.Wall,
        });
        run = [];
      };
      for (let k = 0; k < n; k++) {
        const ix = horiz ? r.x + k : dir.dx < 0 ? r.x : r.x + r.w - 1;
        const iy = horiz ? (dir.dy < 0 ? r.y : r.y + r.h - 1) : r.y + k;
        const ox = ix + dir.dx, oy = iy + dir.dy;
        if (pass(ox, oy) && pass(ix, iy)) run.push({ o: { cx: ox, cy: oy }, i: { cx: ix, cy: iy } });
        else flush();
      }
      flush();
    }
  });
  return out;
}

type Run = ReturnType<typeof wallRuns>[number];
const N4: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const HALF_PI = Math.PI / 2;
/** Угол в (−π, π] — запись поворота без «лишних оборотов». */
const normRot = (a: number): number => { const r = Math.atan2(Math.sin(a), Math.cos(a)); return Object.is(r, -0) ? 0 : r; };

/**
 * ⭐ 12.10 (Ф2, Р6): ПРОХОДИМОСТЬ С ДЕКОРОМ РАДИУСОМ ГЕРОЯ — маска навигации преград (`buildNavMask`-счёт: центр клетки и ребро к соседке
 * сквозь преграду, раздутую на `PLAYER_RADIUS`) и достижимое от спавна — при открытых дверях рычагов и при закрытых (рычаг обязан быть
 * достижим, не проходя свою дверь). Новая преграда принимается, если всё, что было достижимо и не легло под неё, достижимо и теперь, а спавн
 * под неё не лёг (⭐ 13.10, ревью Ф2).
 * Быстрый путь — локально: клетки, чьи биты сменились, обнесены кольцом; если достижимые клетки «кольца + внутри» связаны между собой внутри
 * этой рамки, любой путь сквозь преграду обходит её по кольцу (рёбра вне рамки не менялись). Не связаны — честный обход всего этажа.
 * Отказ — биты возвращаются, раскладка не тронута.
 */
export class Passability {
  readonly cols: number;
  readonly rows: number;
  readonly bits: Uint8Array;
  /** Клетка сетки: 1 — пол, 2 — дверь рычага, 0 — прочее (сетка за проходы слотов не меняется). */
  private readonly kind: Uint8Array;
  private reachOpen: Uint8Array;
  private reachClosed: Uint8Array;
  /** Клетка спавна (`cy * cols + cx`), вне сетки — −1. */
  private readonly spawnIdx: number;
  /** Сколько раз понадобился обход всего этажа (замер стоимости). */
  globalChecks = 0;

  constructor(private readonly L: DungeonLayout, obstacles: readonly Obstacle[], readonly pad = PLAYER_RADIUS) {
    this.rows = L.grid.length; this.cols = L.grid[0]?.length ?? 0;
    const s = worldToCell(L.spawn.x, L.spawn.y);
    this.spawnIdx = s.cx >= 0 && s.cy >= 0 && s.cx < this.cols && s.cy < this.rows ? s.cy * this.cols + s.cx : -1;
    this.bits = new Uint8Array(this.cols * this.rows);
    this.kind = new Uint8Array(this.cols * this.rows);
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      const c = L.grid[y]![x];
      this.kind[y * this.cols + x] = c === Cell.Floor ? 1 : c === Cell.Door ? 2 : 0;
    }
    for (const o of obstacles) this.stamp(o, null);
    this.reachOpen = this.flood(true);
    this.reachClosed = this.flood(false);
  }

  /** Клетка проходима сейчас: пол (дверь — при открытых), центр не под преградой. */
  walk(i: number, open: boolean): boolean {
    const k = this.kind[i];
    return (k === 1 || (open && k === 2)) && !(this.bits[i]! & NAV_CELL);
  }

  /** Достижима ли клетка от спавна (кэш — надмножество: клетки под принятыми позже преградами в нём остаются, `walk` их отсекает). */
  reached(i: number, open: boolean): boolean {
    return !!(open ? this.reachOpen : this.reachClosed)[i] && this.walk(i, open);
  }

  /** Биты преграды `o` (OR в маску); `log` — прежние значения изменённых клеток (для отката). */
  private stamp(o: Obstacle, log: [number, number][] | null): void {
    const reach = (o.shape === 'circle' ? o.r ?? 0 : Math.hypot(o.hw ?? 0, o.hh ?? 0)) + this.pad;
    if (!(reach > 0) || !Number.isFinite(reach) || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return;
    const x0 = Math.max(0, Math.floor((o.x - reach) / TILE) - 1), x1 = Math.min(this.cols - 1, Math.floor((o.x + reach) / TILE) + 1);
    const y0 = Math.max(0, Math.floor((o.y - reach) / TILE) - 1), y1 = Math.min(this.rows - 1, Math.floor((o.y + reach) / TILE) + 1);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const x = cx * TILE + TILE / 2, y = cy * TILE + TILE / 2;
      let b = 0;
      if (segmentHits(o, x, y, x, y, this.pad)) b |= NAV_CELL;
      if (cx + 1 < this.cols && segmentHits(o, x, y, x + TILE, y, this.pad)) b |= NAV_RIGHT;
      if (cy + 1 < this.rows && segmentHits(o, x, y, x, y + TILE, this.pad)) b |= NAV_DOWN;
      const i = cy * this.cols + cx, old = this.bits[i]!;
      if (b & ~old) { log?.push([i, old]); this.bits[i] = old | b; }
    }
  }

  /** Обход от спавна по маске (4-связность). Спавн под преградой — пусто. */
  private flood(open: boolean, lim?: { x0: number; y0: number; x1: number; y1: number }, from?: number): Uint8Array {
    const { cols, rows } = this;
    const seen = new Uint8Array(cols * rows);
    const s = worldToCell(this.L.spawn.x, this.L.spawn.y);
    const start = from ?? s.cy * cols + s.cx;
    if (!this.walk(start, open)) return seen;
    const q = new Int32Array(cols * rows);
    let head = 0, tail = 0;
    q[tail++] = start; seen[start] = 1;
    // рамка обхода (локальная проверка) — без неё весь этаж; замыкания в цикле не заводим (горячий путь: ~сотни обходов на этаж)
    const lx0 = lim ? lim.x0 : 0, ly0 = lim ? lim.y0 : 0, lx1 = lim ? lim.x1 : cols - 1, ly1 = lim ? lim.y1 : rows - 1;
    const bits = this.bits;
    while (head < tail) {
      const i = q[head++]!, x = i % cols, y = (i / cols) | 0;
      let j = i + 1;
      if (x + 1 <= lx1 && !(bits[i]! & NAV_RIGHT) && !seen[j] && this.walk(j, open)) { seen[j] = 1; q[tail++] = j; }
      j = i - 1;
      if (x - 1 >= lx0 && !(bits[j]! & NAV_RIGHT) && !seen[j] && this.walk(j, open)) { seen[j] = 1; q[tail++] = j; }
      j = i + cols;
      if (y + 1 <= ly1 && !(bits[i]! & NAV_DOWN) && !seen[j] && this.walk(j, open)) { seen[j] = 1; q[tail++] = j; }
      j = i - cols;
      if (y - 1 >= ly0 && !(bits[j]! & NAV_DOWN) && !seen[j] && this.walk(j, open)) { seen[j] = 1; q[tail++] = j; }
    }
    return seen;
  }

  /** Принять преграды нового пропа, если ничего не отрезали; иначе откатить биты.
   *  ⭐ 13.10 (ревью Ф2): 1) СПАВН ПОД ПРЕГРАДОЙ — отказ сразу (при открытых и при закрытых дверях): быстрый путь его не видел — спавн, став
   *  непроходимым, выпадал из «нужных» клеток рамки, и преграда на нём принималась, хотя от спавна больше ничего не достижимо (фаззер ревью: 684
   *  из 36 000 на синтетике; в данных крипты — 0 на 2000 этажей). Спавн уже под декором до слотов (этаж сломан раньше) — держаться не за что, как
   *  прежде. 2) Кэш достижимого (`reachOpen`/`reachClosed`) пишется только после ОБЕИХ проверок: раньше открытая записывалась до закрытой, и при
   *  отказе закрытой кэш хранил дыры отвергнутой преграды — её клетки переставали охраняться. */
  tryAdd(obstacles: readonly Obstacle[]): boolean {
    const log: [number, number][] = [];
    for (const o of obstacles) this.stamp(o, log);
    if (!log.length) return true;
    const undo = (): false => { for (let k = log.length - 1; k >= 0; k--) this.bits[log[k]![0]] = log[k]![1]; return false; };
    const sp = this.spawnIdx;
    if (sp >= 0) for (const open of [true, false]) if ((open ? this.reachOpen : this.reachClosed)[sp] && !this.walk(sp, open)) return undo();
    // рамка изменений: клетка со сменившимся центром и ОБА конца сменившегося ребра
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const take = (x: number, y: number): void => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const [i, old] of log) {
      const d = this.bits[i]! & ~old, x = i % this.cols, y = (i / this.cols) | 0;
      take(x, y);
      if (d & NAV_RIGHT) take(x + 1, y);
      if (d & NAV_DOWN) take(x, y + 1);
    }
    const box = { x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1), x1: Math.min(this.cols - 1, x1 + 1), y1: Math.min(this.rows - 1, y1 + 1) };
    let nowOpen: Uint8Array | null = null, nowClosed: Uint8Array | null = null;
    for (const open of [true, false]) {
      if (this.localOk(open, box)) continue;
      this.globalChecks++;
      const now = this.flood(open);
      const was = open ? this.reachOpen : this.reachClosed;
      for (let i = 0; i < was.length; i++) if (was[i] && this.walk(i, open) && !now[i]) return undo();
      if (open) nowOpen = now; else nowClosed = now;
    }
    // обе проверки прошли — теперь кэш (⭐ 13.10, ревью Ф2)
    if (nowOpen) this.reachOpen = nowOpen;
    if (nowClosed) this.reachClosed = nowClosed;
    return true;
  }

  /** Достижимые и проходимые клетки рамки связаны между собой внутри неё. */
  private localOk(open: boolean, box: { x0: number; y0: number; x1: number; y1: number }): boolean {
    const was = open ? this.reachOpen : this.reachClosed;
    let first = -1;
    const want: number[] = [];
    for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
      const i = y * this.cols + x;
      if (was[i] && this.walk(i, open)) { want.push(i); if (first < 0) first = i; }
    }
    if (first < 0) return true;
    const seen = this.flood(open, box, first);
    return want.every((i) => seen[i]);
  }
}

/**
 * Занятость пола для проходов слотов — ТОТ ЖЕ счёт, что `FloorClaims` (`decor.ts`: след и кольцо отступа, правило в обе стороны; якоря —
 * клеткой без отступа), но на типизированных массивах: кандидатов «у стены» на этаж — тысячи, строковые ключи `FloorClaims` стоили
 * ~5 мс этажа (замер 12.10). Клетки вне сетки не занимаются (там только стены рамки).
 */
class GridClaims {
  private readonly feet: Uint8Array;
  private readonly halo: Uint8Array;
  private anyHalo = false;
  constructor(readonly cols: number, readonly rows: number) {
    this.feet = new Uint8Array(cols * rows);
    this.halo = new Uint8Array(cols * rows);
  }
  private each(r: CellRect, m: number, f: (i: number) => boolean | void): boolean {
    const x0 = Math.max(0, r.x0 - m), y0 = Math.max(0, r.y0 - m), x1 = Math.min(this.cols - 1, r.x1 + m), y1 = Math.min(this.rows - 1, r.y1 + m);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (f(y * this.cols + x) === false) return false;
    return true;
  }
  /** Занять след `r` с отступом `clearance`. */
  claim(r: CellRect, clearance = 0): void {
    this.each(r, 0, (i) => { this.feet[i] = 1; });
    const c = Math.max(0, Math.floor(clearance));
    if (c > 0) { this.anyHalo = true; this.each(r, c, (i) => { this.halo[i] = 1; }); }
  }
  /** След `r` с отступом `clearance` не попал в чужой отступ и не задел чужой след. */
  free(r: CellRect, clearance = 0): boolean {
    if (this.anyHalo && !this.each(r, 0, (i) => !this.halo[i])) return false;
    return this.each(r, Math.max(0, Math.floor(clearance)), (i) => !this.feet[i]);
  }
}

/** Занятость пола уже стоящим декором и якорями — как `claimsOf` + `claimLayoutAnchors` (`decor.ts`). */
function gridClaimsOf(L: DungeonLayout, known: ReadonlyMap<string, DecorSpec>, cols: number, rows: number): GridClaims {
  const g = new GridClaims(cols, rows);
  const cell = (p: { x: number; y: number }): void => { const c = worldToCell(p.x, p.y); g.claim({ x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy }); };
  for (const d of L.decor) {
    const s = d.kind === 'obj' && d.objectId ? known.get(d.objectId) : undefined;
    if (s?.surface === 'wall') continue;
    if (s) g.claim(footprintRect(d), s.clearance ?? 0); else cell(d);
  }
  cell(L.spawn); cell(L.stairsDown);
  for (const e of L.exits) cell(e);
  for (const lv of L.levers) cell(lv);
  for (const d of L.doors) for (const c of d.cells) g.claim({ x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy });
  return g;
}

/** Кандидат на место: клетки следа, их прямоугольник, точка (пивот модели), поворот; у стены — пробег и центр вдоль него. */
interface Cand { cells: number[]; rect: CellRect; x: number; y: number; rot: number; run?: Run; at?: number }

/** Общее состояние проходов этажа. */
interface Ctx {
  L: DungeonLayout;
  rules: PropRules;
  cols: number;
  zone: Int32Array;
  toCam: { x: number; y: number };
  known: ReadonlyMap<string, DecorSpec>;
  claims: GridClaims;
  lane: Uint8Array;
  /** Клетки перед нишами статуй — модель статуи выходит в них: ничего. */
  statueFront: Set<number>;
  /** Клетки перед настенными пропами (факелы): высокому нельзя. */
  wallFront: Set<number>;
  /** Грани стен, занятые оформлением и слотами граней: «x,y,dx,dz». */
  faces: Set<string>;
  /** Следы преград пола (костры, центр) — полоса их обходит (и клетки, чей центр под коллайдером радиусом героя, — `pass.bits`). */
  blockedFeet: Uint8Array;
  pass: Passability;
  /** Точки пропов по id — «одинаковое не рядом». */
  points: Map<string, { x: number; y: number }[]>;
  /** Центры пропов у стены по пробегу — шаг. */
  runAt: Map<Run, number[]>;
  log: SlotLog;
}

const idxOf = (ctx: Ctx, x: number, y: number): number => (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.L.grid.length ? -1 : y * ctx.cols + x);
const isFloor = (ctx: Ctx, i: number): boolean => i >= 0 && ctx.L.grid[(i / ctx.cols) | 0]?.[i % ctx.cols] === Cell.Floor;
const has = (s: DecorSpec, c: string): boolean => !!s.contexts?.includes(c);
const tallOf = (s: DecorSpec): boolean => !!s.passport?.tall;
const keepsPath = (s: DecorSpec): boolean => s.blocks || !!s.passport?.keepPath;
/** Вес пропа на месте: вес × множитель паспорта по типу комнаты / коридору (нет записи — 1). */
const weightOf = (s: DecorSpec, place: string): number => {
  const m = s.rooms?.[place];
  return Math.max(0, s.weight) * (m === undefined ? 1 : Math.max(0, m));
};

/** Взвешенный выбор пропа; нет ни одного с весом — null. */
function pickWeighted(specs: readonly DecorSpec[], place: string, rng: Rng): DecorSpec | null {
  let total = 0;
  for (const s of specs) total += weightOf(s, place);
  if (total <= 0) return null;
  let r = rng.float(0, total);
  for (const s of specs) { const w = weightOf(s, place); r -= w; if (w > 0 && r <= 0) return s; }
  for (let i = specs.length - 1; i >= 0; i--) if (weightOf(specs[i]!, place) > 0) return specs[i]!;
  return null;
}

/** Прямоугольник клеток списка (клетки следа всегда образуют прямоугольник). */
function rectOf(ctx: Ctx, cells: readonly number[]): CellRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of cells) { const x = i % ctx.cols, y = (i / ctx.cols) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

/** Место годно для пропа в зоне `zone`: пол зоны, не полоса (преграде и «не запирать проход»), не перед нишей, высокому — не перед факелом,
 *  отступ свой и соседей (`FloorClaims`, якоря там же), «одинаковое не рядом». */
function canPlace(ctx: Ctx, s: DecorSpec, c: Cand, zone: number): boolean {
  const lanesBan = keepsPath(s), tall = tallOf(s);
  for (const i of c.cells) {
    if (i < 0 || ctx.zone[i] !== zone || !isFloor(ctx, i)) return false;
    if (lanesBan && ctx.lane[i]) return false;
    if (ctx.statueFront.has(i) || (tall && ctx.wallFront.has(i))) return false;
  }
  if (!ctx.claims.free(c.rect, s.clearance ?? 0)) return false;
  const r = ctx.rules.sameNotNear;
  if (r > 0) {
    const q = slotPoint(c.rect);   // ⭐ 13.10 (ревью Ф2): точка слота, не пивот модели
    for (const p of ctx.points.get(s.id) ?? []) if (Math.hypot(p.x - q.x, p.y - q.y) <= r * TILE + 1e-6) return false;
  }
  return true;
}

/** Поставить проп: преграда — сперва проверка проходимости (Р6; отрезала — откат только её), затем запись, след, точка. */
function commit(ctx: Ctx, s: DecorSpec, c: Cand, pass: SlotPass): boolean {
  const d: DecorObject = { x: c.x, y: c.y, kind: 'obj', objectId: s.id, rot: normRot(c.rot), footprint: { w: s.footprint.w, h: s.footprint.h } };
  if (s.blocks && !ctx.pass.tryAdd(obstaclesFromDecor([d], ctx.known as Map<string, DecorSpec>))) { ctx.log.passes[pass].rejected++; return false; }
  ctx.L.decor.push(d);
  ctx.claims.claim(c.rect, s.clearance ?? 0);
  if (s.blocks) for (const i of c.cells) ctx.blockedFeet[i] = 1;
  const pts = ctx.points.get(s.id) ?? [];
  pts.push(slotPoint(c.rect)); ctx.points.set(s.id, pts);   // ⭐ 13.10 (ревью Ф2): точка слота (у центра и арки — она же пивот)
  if (c.run && c.at !== undefined) { const a = ctx.runAt.get(c.run) ?? []; a.push(c.at); ctx.runAt.set(c.run, a); }
  ctx.log.passes[pass].placed++;
  return true;
}

/** Точка грани в мире: центр клетки-стены + ½ клетки к проходимой соседке (как у `placeWallProps`/`placeDressing`). */
const facePoint = (f: { x: number; y: number; dx: number; dz: number }): { x: number; y: number } =>
  ({ x: f.x * TILE + TILE / 2 + (f.dx * TILE) / 2, y: f.y * TILE + TILE / 2 + (f.dz * TILE) / 2 });

/**
 * ⭐ 13.10 (ревью Ф2): ТОЧКА СЛОТА — центр прямоугольника следа (клетки). «Одинаковое не рядом» мерит её, а не пивот модели: пивот у стены стоит
 * по глубине МОДЕЛИ (`wallPivot`), и правило в клетках не должно зависеть от коллайдера (новая выгрузка модели двигала бы соседей по комнате).
 * У центра комнаты и арки точка слота и есть пивот.
 */
const slotPoint = (r: CellRect): { x: number; y: number } => ({ x: ((r.x0 + r.x1 + 1) / 2) * TILE, y: ((r.y0 + r.y1 + 1) / 2) * TILE });

/** ⭐ 13.10 (ревью Ф2): глубина МОДЕЛИ поперёк стены, клеток, при повороте `swap` — по коллайдеру спеки (тот же, что даёт преграду,
 *  `obstaclesFromDecor`, с теми же умолчаниями): бокс — `h` (ось Z модели — по нормали) или `w` при `swap` (по нормали — ось X), круг — 2r;
 *  коллайдера нет (или он вырожден) — `fallback` (глубина следа, как прежде). */
function modelDepth(s: DecorSpec, swap: boolean, fallback: number): number {
  const col = s.collider;
  const m = !col ? NaN : col.shape === 'box' ? (swap ? col.w ?? 0.6 : col.h ?? 0.6) : 2 * (col.r ?? 0.4);
  return Number.isFinite(m) && m > 0 ? m : fallback;
}

/**
 * Пивот пропа, прислонённого к стене с нормалью `n` (в комнату): центр прямоугольника следа, сдвинутый поперёк стены так, чтобы до линии стены
 * было `backOffset` паспорта (якорь back: полка — 0.25 м) или ПОЛГЛУБИНЫ МОДЕЛИ (якорь center/corner: спинка модели — на линии стены).
 * `depth` — клеток следа поперёк стены, `swap` — поворот кладёт ось X модели поперёк стены (`wallTurns`).
 * ⭐ 13.10 (ревью Ф2): было полглубины СЛЕДА — модель мельче следа висела в воздухе (зазор спинки до линии стены, 400 этажей крипты: стол 3x
 * длинной стороной вдоль стены 0.30 м, камень длинной стороной поперёк 0.25, ящики 0.14). Модель глубже следа (след паспорта — ⌈габарит − 0.1⌉) — по центру следа, как прежде:
 * лишнее поровну — половина в стену, половина за след в комнату (≤ 0.05 клетки = 1.6 px: коллайдер у полосы — в пределах 1.6 px от следа, запас
 * героя 14 < 16). Сдвиг от центра следа — СТРОГО меньше `FOOTPRINT_SNAP` (0.45 клетки, запас `SNAP_MARGIN` от погрешности деления): так
 * `footprintRect` записи — ровно клетки слота (занятость россыпи и сундуков, превью); след паспорта ⌈габарит − 0.1⌉ и так держит сдвиг < 0.45,
 * предел ловит только след, раздутый руками. След (клетки, занятость, «одинаковое не рядом» —
 * `slotPoint`) — прежний: сдвигается только точка модели и её коллайдер.
 */
const SNAP_MARGIN = 1e-6;   // ⭐ 13.10 (ревью): сдвиг ровно в FOOTPRINT_SNAP изредка (погрешность) возвращал записи ряд стены за пропом

function wallPivot(s: DecorSpec, rect: CellRect, n: { x: number; y: number }, depth: number, swap: boolean): { x: number; y: number } {
  const cx = ((rect.x0 + rect.x1 + 1) / 2) * TILE, cy = ((rect.y0 + rect.y1 + 1) / 2) * TILE;
  const off = s.passport?.anchor === 'back' ? (s.passport.backOffset ?? 0)
    : Math.max(depth / 2 - FOOTPRINT_SNAP + SNAP_MARGIN, Math.min(depth, modelDepth(s, swap, depth)) / 2);
  return { x: cx + n.x * (off - depth / 2) * TILE, y: cy + n.y * (off - depth / 2) * TILE };
}

/** Повороты пропа у стены с нормалью `n` по `facing` паспорта: лицом в комнату (ось X модели — вдоль стены), вдоль (ось Z — вдоль), кратно
 *  90° / свободно (все четыре). `swap` — след в клетках повёрнут (вдоль стены идёт его h). */
function wallTurns(s: DecorSpec, n: { x: number; y: number }): { rot: number; swap: boolean }[] {
  const rot0 = Math.atan2(n.x, n.y);
  const f = s.passport?.facing ?? 'quad';
  if (f === 'room') return [{ rot: rot0, swap: false }];
  if (f === 'along') return [{ rot: rot0 + HALF_PI, swap: true }, { rot: rot0 - HALF_PI, swap: true }];
  return [{ rot: rot0, swap: false }, { rot: rot0 + Math.PI, swap: false }, { rot: rot0 + HALF_PI, swap: true }, { rot: rot0 - HALF_PI, swap: true }];
}

/** Кандидаты «спиной к стене» пропа `s` в комнате `ri`: каждый пробег комнаты, каждый поворот, каждое начало (от концов — грань). */
function againstWallCands(ctx: Ctx, s: DecorSpec, ri: number, runs: readonly Run[]): Cand[] {
  const out: Cand[] = [];
  const tall = tallOf(s), step = ctx.rules.againstWall.step, gap = 1;
  for (const run of runs) {
    if (tall && !isFarFace(run.dx, run.dz, ctx.toCam)) continue;   // высокий — только у дальних стен
    const n = { x: run.dx, y: run.dz }, m = run.faces.length;
    const taken = ctx.runAt.get(run) ?? [];
    for (const t of wallTurns(s, n)) {
      const A = t.swap ? s.footprint.h : s.footprint.w, D = t.swap ? s.footprint.w : s.footprint.h;
      next: for (let i = gap; i + A - 1 <= m - 1 - gap; i++) {
        const at = i + (A - 1) / 2;
        for (const a of taken) if (Math.abs(a - at) < step) continue next;   // шаг: центры соседей на этой стене
        const cells: number[] = [];
        for (let j = 0; j < A; j++) for (let k = 0; k < D; k++) {
          const f = run.faces[i + j]!;
          const c = idxOf(ctx, f.x + f.dx * (k + 1), f.y + f.dz * (k + 1));
          if (c < 0) continue next;
          cells.push(c);
        }
        const rect = rectOf(ctx, cells);
        const p = wallPivot(s, rect, n, D, t.swap);
        const c: Cand = { cells, rect, x: p.x, y: p.y, rot: t.rot, run, at };
        if (canPlace(ctx, s, c, ri)) out.push(c);
      }
    }
  }
  return out;
}

/** Угол комнаты: клетка с полом и стенами с двух смежных сторон `a`, `b` (от клетки к стене), каждая стена — не короче двух клеток. */
interface Corner { x: number; y: number; a: [number, number]; b: [number, number] }
const CORNER_DIRS: readonly [[number, number], [number, number]][] = [[[-1, 0], [0, -1]], [[1, 0], [0, -1]], [[-1, 0], [0, 1]], [[1, 0], [0, 1]]];

function cornersOf(ctx: Ctx, ri: number): Corner[] {
  const r = ctx.L.rooms[ri]!, out: Corner[] = [];
  const wall = (x: number, y: number): boolean => ctx.L.grid[y]?.[x] === Cell.Wall;
  const own = (x: number, y: number): boolean => { const i = idxOf(ctx, x, y); return i >= 0 && ctx.zone[i] === ri && isFloor(ctx, i); };
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (!own(x, y)) continue;
    for (const [a, b] of CORNER_DIRS) {
      const na = [-a[0], -a[1]], nb = [-b[0], -b[1]];
      // стена a тянется вдоль nb на две клетки, стена b — вдоль na; блок 2 × 2 — пол комнаты
      if (!wall(x + a[0], y + a[1]) || !wall(x + nb[0]! + a[0], y + nb[1]! + a[1])) continue;
      if (!wall(x + b[0], y + b[1]) || !wall(x + na[0]! + b[0], y + na[1]! + b[1])) continue;
      if (!own(x + na[0]!, y + na[1]!) || !own(x + nb[0]!, y + nb[1]!) || !own(x + na[0]! + nb[0]!, y + na[1]! + nb[1]!)) continue;
      out.push({ x, y, a, b });
    }
  }
  return out;
}

/** Кандидаты пропа в угол `k`: 1 × 1 — в угловую клетку; 2 × 1 — вдоль одной из стен; 2 × 2 — весь блок; прочее в угол не идёт.
 *  `cellsAllowed` — клетки блока, ещё свободные (пара). */
function cornerCands(ctx: Ctx, s: DecorSpec, ri: number, k: Corner, only?: { x: number; y: number }[]): Cand[] {
  const out: Cand[] = [];
  const na = { x: -k.a[0], y: -k.a[1] }, nb = { x: -k.b[0], y: -k.b[1] };
  if (tallOf(s) && !(isFarFace(na.x, na.y, ctx.toCam) && isFarFace(nb.x, nb.y, ctx.toCam))) return out;   // высокий — только угол двух дальних стен
  const fw = s.footprint.w, fh = s.footprint.h;
  // ⭐ 13.10 (ревью Ф2): `side` — нормаль ВТОРОЙ стены угла (у которой торец следа): модель прижимается и к ней — на половину того, на что след
  // длиннее модели вдоль спинной стены (ящик 1 × 1 r 0.36 — 0.14 клетки, камень 2 × 1 длиной 1.5 — 0.25), строго меньше FOOTPRINT_SNAP: клетки
  // слота и «одинаковое не рядом» (центр слота) — прежние, сдвигается только точка модели. Было: ящик в углу — в 14 см от второй стены.
  const push = (pts: { x: number; y: number }[], n: { x: number; y: number }, depth: number, turns: { rot: number; swap: boolean }[], side?: { x: number; y: number }): void => {
    const cells = pts.map((p) => idxOf(ctx, p.x, p.y));
    if (cells.some((c) => c < 0)) return;
    const rect = rectOf(ctx, cells);
    const along = side ? (side.x !== 0 ? rect.x1 - rect.x0 + 1 : rect.y1 - rect.y0 + 1) : 0;   // клеток следа вдоль спинной стены
    // ⭐ 13.10 (ревью Ф2): пивот — на каждый поворот (глубина модели поперёк стены у поворотов «лицом» и «вдоль» разная)
    for (const t of turns) {
      const p = wallPivot(s, rect, n, depth, t.swap);
      if (side) {
        const sh = Math.min(FOOTPRINT_SNAP - SNAP_MARGIN, Math.max(0, (along - Math.min(along, modelDepth(s, !t.swap, along))) / 2));
        p.x -= side.x * sh * TILE; p.y -= side.y * sh * TILE;
      }
      const c: Cand = { cells, rect, x: p.x, y: p.y, rot: t.rot };
      if (canPlace(ctx, s, c, ri)) out.push(c);
    }
  };
  const C = { x: k.x, y: k.y };
  const turnsAlong = (n: { x: number; y: number }, longX: boolean): { rot: number; swap: boolean }[] =>
    wallTurns(s, n).filter((t) => (longX ? !t.swap : t.swap));   // длинная сторона следа — вдоль стены
  if (fw === 1 && fh === 1) {
    const sites = only ?? [C];
    for (const site of sites) {
      // спиной к стене, рядом с которой клетка: угловая — к любой из двух
      const walls = site.x === C.x && site.y === C.y ? [na, nb] : site.x === C.x + na.x && site.y === C.y + na.y ? [nb] : [na];
      // вторая стена — по сетке, а не по углу C: пара в нише шириной 2 (круглые комнаты) тоже у двух стен; стены с обеих сторон — по центру
      for (const n of walls) {
        const qs = [{ x: n.y, y: n.x }, { x: -n.y, y: -n.x }].filter((q) => ctx.L.grid[site.y + q.y]?.[site.x + q.x] === Cell.Wall);
        push([site], n, 1, wallTurns(s, n), qs.length === 1 ? { x: -qs[0]!.x, y: -qs[0]!.y } : undefined);
      }
    }
  } else if (!only && ((fw === 2 && fh === 1) || (fw === 1 && fh === 2))) {
    // вдоль стены b (клетки C, C + na — стена b у обеих) и вдоль стены a (C, C + nb)
    push([C, { x: C.x + na.x, y: C.y + na.y }], nb, 1, turnsAlong(nb, fw === 2), na);
    push([C, { x: C.x + nb.x, y: C.y + nb.y }], na, 1, turnsAlong(na, fw === 2), nb);
  } else if (!only && fw === 2 && fh === 2) {
    push([C, { x: C.x + na.x, y: C.y + na.y }, { x: C.x + nb.x, y: C.y + nb.y }, { x: C.x + na.x + nb.x, y: C.y + na.y + nb.y }], nb, 2, wallTurns(s, nb), na);
  }
  return out;
}

/** Поставить проп одного из `pool` по весу места на одного из кандидатов `cands(s)`; проп без мест или откаченный — мимо, попыток ≤ 6. */
function placeOne(ctx: Ctx, pool: readonly DecorSpec[], place: string, rng: Rng, cands: (s: DecorSpec) => Cand[], pass: SlotPass): DecorSpec | null {
  let left = [...pool];
  for (let attempt = 0; attempt < 6 && left.length; attempt++) {
    const s = pickWeighted(left, place, rng);
    if (!s) return null;
    const cs = cands(s);
    if (!cs.length) { left = left.filter((x) => x !== s); continue; }
    if (commit(ctx, s, cs[rng.int(0, cs.length - 1)]!, pass)) return s;
  }
  return null;
}

/**
 * Р0 полосы комнаты `ri`: ДЕРЕВО кратчайших путей между концами (середины устьев проёмов, якоря) по полу комнаты в обход преград пола (костёр,
 * центр), кистью `width × width`, вписанной в пол; + устья проёмов с клеткой у каждого косяка. Путь — вниз по полю расстояний, с тем же шагом,
 * что прежний (прямые участки), иначе — первый по порядку `N4`. Счёт — в прямоугольнике комнаты (свои массивы, без замыканий на клетку).
 */
function traceLanes(ctx: Ctx, ri: number, doors: readonly Doorway[], anchors: readonly number[]): number[] {
  const { cols } = ctx;
  const r = ctx.L.rooms[ri]!;
  const W = r.w, H = r.h, n = W * H;
  const width = Math.max(1, ctx.rules.lanes.width);
  // пол комнаты (её зона), не под преградой пола — по локальному индексу (y − r.y) · w + (x − r.x). ⭐ 12.10 (ревью Ф2): и не клетка, чей центр
  // под коллайдером стоящего декора радиусом героя (бит `NAV_CELL` маски `Passability`): статуя ниши выходит в клетку перед собой — полоса шириной 2
  // вдоль ниш сужалась до 1 (замер ревью: 499 клеток полос на 300 этажей крипты под коллайдером статуи)
  const okL = new Uint8Array(n);
  const bits = ctx.pass.bits;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idxOf(ctx, r.x + x, r.y + y);
    if (i >= 0 && ctx.zone[i] === ri && isFloor(ctx, i) && !ctx.blockedFeet[i] && !(bits[i]! & NAV_CELL)) okL[y * W + x] = 1;
  }
  const loc = (i: number): number => { const x = (i % cols) - r.x, y = ((i / cols) | 0) - r.y; return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x; };
  const lane = new Set<number>();
  const ends: number[] = [];
  for (const d of doors) {
    const mid = d.inner[(d.inner.length - 1) >> 1]!;
    ends.push(mid.cy * cols + mid.cx);
    // устье: весь ряд перед проёмом + клетка у каждого косяка (косяк — если на ней можно стоять: перед нишей статуи — нет)
    const tx = d.dir.dy !== 0 ? 1 : 0, ty = d.dir.dy !== 0 ? 0 : 1;
    const a = d.inner[0]!, b = d.inner[d.inner.length - 1]!;
    for (const c of d.inner) { const i = idxOf(ctx, c.cx, c.cy); if (i >= 0 && ctx.zone[i] === ri && isFloor(ctx, i)) lane.add(i); }
    for (const c of [{ cx: a.cx - tx, cy: a.cy - ty }, { cx: b.cx + tx, cy: b.cy + ty }]) {
      const l = c.cx - r.x >= 0 && c.cy - r.y >= 0 && c.cx - r.x < W && c.cy - r.y < H ? (c.cy - r.y) * W + c.cx - r.x : -1;
      if (l >= 0 && okL[l]) lane.add(idxOf(ctx, c.cx, c.cy));
    }
  }
  for (const i of anchors) { ends.push(i); if (i >= 0 && ctx.zone[i] === ri) lane.add(i); }
  const uniq = [...new Set(ends)].map(loc).filter((l) => l >= 0 && okL[l]);
  const q = new Int32Array(n);
  const dist = uniq.map((src) => {
    const d = new Int32Array(n).fill(-1);
    let head = 0, tail = 0;
    q[tail++] = src; d[src] = 0;
    while (head < tail) {
      const l = q[head++]!, x = l % W, y = (l / W) | 0, nd = d[l]! + 1;
      if (x + 1 < W && okL[l + 1] && d[l + 1] === -1) { d[l + 1] = nd; q[tail++] = l + 1; }
      if (x > 0 && okL[l - 1] && d[l - 1] === -1) { d[l - 1] = nd; q[tail++] = l - 1; }
      if (y + 1 < H && okL[l + W] && d[l + W] === -1) { d[l + W] = nd; q[tail++] = l + W; }
      if (y > 0 && okL[l - W] && d[l - W] === -1) { d[l - W] = nd; q[tail++] = l - W; }
    }
    return d;
  });
  // ДЕРЕВО путей (Прим по расстоянию пола), а не все пары: все пары покрывали ~60 % пола комнаты (замер 12.10, крипта: 494 клетки полос
  // из 803 клеток комнат на этаж) — у стен не оставалось места; дерево связывает каждый проём и якорь с остальными кратчайшими отрезками
  const pairs: [number, number][] = [];
  if (uniq.length > 1) {
    const inTree = new Uint8Array(uniq.length); inTree[0] = 1;
    for (let added = 1; added < uniq.length; added++) {
      let ba = -1, bb = -1, bd = Infinity;
      for (let a = 0; a < uniq.length; a++) {
        if (!inTree[a]) continue;
        for (let b = 0; b < uniq.length; b++) {
          if (inTree[b]) continue;
          const dd = dist[b]![uniq[a]!]!;
          if (dd >= 0 && dd < bd) { bd = dd; ba = a; bb = b; }
        }
      }
      if (bb < 0) break;   // остальные концы не связаны полом комнаты (рукав формы) — их пути нет
      inTree[bb] = 1; pairs.push([ba, bb]);
    }
  }
  // окно ширины `width` по оси, содержащее клетку: ближе к центрированному, целиком на полу комнаты (нет такого — центрированное)
  const lo = -((width - 1) >> 1);
  const tries = [lo];
  for (let s = 1; s < width; s++) { if (lo + s <= 0) tries.push(lo + s); if (lo - s > -width) tries.push(lo - s); }
  const okXY = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && okL[y * W + x] === 1;
  const brush = (l: number): void => {
    const x = l % W, y = (l / W) | 0;
    let sx = x + lo, sy = y + lo;
    for (const t of tries) { let all = true; for (let k = 0; k < width && all; k++) if (!okXY(x + t + k, y)) all = false; if (all) { sx = x + t; break; } }
    for (const t of tries) { let all = true; for (let k = 0; k < width && all; k++) if (!okXY(x, y + t + k)) all = false; if (all) { sy = y + t; break; } }
    for (let yy = sy; yy < sy + width; yy++) for (let xx = sx; xx < sx + width; xx++) if (okXY(xx, yy)) lane.add((r.y + yy) * cols + r.x + xx);
  };
  for (const [a, b] of pairs) {
    const db = dist[b]!;
    let cur = uniq[a]!;
    let px = 0, py = 0;
    brush(cur);
    while (db[cur]! > 0) {
      const x = cur % W, y = (cur / W) | 0, want = db[cur]! - 1;
      let next = -1, ndx = 0, ndy = 0;
      // тот же шаг, что прежний, иначе — первый по порядку N4
      if ((px || py) && okXY(x + px, y + py) && db[(y + py) * W + x + px] === want) { next = (y + py) * W + x + px; ndx = px; ndy = py; }
      else for (const [dx, dy] of N4) if (okXY(x + dx, y + dy) && db[(y + dy) * W + x + dx] === want) { next = (y + dy) * W + x + dx; ndx = dx; ndy = dy; break; }
      if (next < 0) break;
      cur = next; px = ndx; py = ndy;
      brush(cur);
    }
  }
  const cells = [...lane].sort((p, q2) => p - q2);
  for (const i of cells) ctx.lane[i] = 1;
  return cells;
}

/**
 * ⭐ 12.10 (ревью Ф2): ТЕНЬ АРКИ ЛЕЖИТ НА ДРУГОЙ КОМНАТЕ — проём на дальней стене комнаты бывает БЛИЖНЕЙ стеной того, что за ним: за проёмом в 2–3
 * клетках — другая комната (замер ревью: 36 % арок крипты). Арка высокая (arch_04 — 5.7 м) и со стеной не тает (паспорт doorway — поверхность
 * пол, Unity гасит только настенное), а верх модели высотой h закрывает землю за собой на h / tan(возвышение камеры): при 45° (дальний зум) —
 * 5.7 клетки, при 20° (ближний) — 15.6. Луч — от каждой клетки линии проёма В СТОРОНУ ОТ КАМЕРЫ (−`toCam`, по диагонали при азимуте −45°) на
 * `len` клеток, шагом в четверть клетки, сквозь стены (верх арки выше их): пол чужой комнаты на нём — арку не ставить. Коридор за аркой — можно
 * (герой его проходит, а не стоит в нём).
 */
function archShadowsRoom(ctx: Ctx, d: Doorway, len: number): boolean {
  if (!(len > 0)) return false;
  const ax = -ctx.toCam.x, ay = -ctx.toCam.y;
  for (let k = 0; k < d.cells.length; k++) {
    // точка на линии стены: середина между клеткой проёма и клеткой устья
    const ox = (d.cells[k]!.cx + d.inner[k]!.cx) / 2 + 0.5, oy = (d.cells[k]!.cy + d.inner[k]!.cy) / 2 + 0.5;
    for (let t = 0.25; t <= len + 1e-9; t += 0.25) {
      const i = idxOf(ctx, Math.floor(ox + ax * t), Math.floor(oy + ay * t));
      if (i < 0) break;
      const z = ctx.zone[i]!;
      if (z >= 0 && z !== d.room && isFloor(ctx, i)) return true;
    }
  }
  return false;
}

/** Клетки якорей этажа (Р0): спавн, выходы, рычаги, сундук сокровищницы, портал, лавка, арена босса. */
function anchorCells(L: DungeonLayout, cols: number): number[] {
  const out: number[] = [];
  const at = (p: { x: number; y: number }): void => { const c = worldToCell(p.x, p.y); out.push(c.cy * cols + c.cx); };
  at(L.spawn); at(L.stairsDown);
  for (const e of L.exits) at(e);
  for (const lv of L.levers) at(lv);
  for (const d of L.decor) if (d.kind === 'chest' || d.kind === 'portal' || d.kind === 'shop' || d.kind === 'stash' || d.kind === 'arena') at(d);
  return out;
}

export interface SlotOpts {
  /** Азимут камеры (`balance.camera.azimuthDeg`) — какие стены дальние. */
  camAzimuthDeg: number;
  /** Все спеки биома, и объекты оформления тоже (коллайдеры и отступы уже стоящего декора). */
  known: ReadonlyMap<string, DecorSpec>;
}

/**
 * ⭐ 12.10 (Ф2): РАССТАВИТЬ ПРОПЫ ПО СЛОТАМ (`specs` — спеки с паспортом, без объектов оформления). Пишет пропы в `L.decor`, проёмы —
 * `L.doorways`, полосы — `L.lanes`, журнал — `L.slotLog` (его же и возвращает). Порядок и потоки — в шапке файла.
 */
export function placeSlots(L: DungeonLayout, rules: PropRules, specs: readonly DecorSpec[], seed: number, opts: SlotOpts): SlotLog {
  const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
  // зона клетки — индекс ПЕРВОЙ комнаты, в прямоугольнике которой она лежит (как `wallRuns`), иначе −1 (коридор): заливка с конца списка
  const zone = new Int32Array(rows * cols).fill(-1);
  for (let ri = L.rooms.length - 1; ri >= 0; ri--) {
    const r = L.rooms[ri]!;
    for (let y = Math.max(0, r.y); y < Math.min(rows, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(cols, r.x + r.w); x++) zone[y * cols + x] = ri;
  }
  const claims = gridClaimsOf(L, opts.known, cols, rows);
  const log: SlotLog = { rooms: [], passes: { center: { placed: 0, rejected: 0 }, againstWall: { placed: 0, rejected: 0 }, corner: { placed: 0, rejected: 0 }, doorway: { placed: 0, rejected: 0 }, wall: { placed: 0, rejected: 0 } } };
  const ctx: Ctx = {
    L, rules, cols, zone, toCam: toCameraXY(opts.camAzimuthDeg), known: opts.known, claims, lane: new Uint8Array(rows * cols),
    statueFront: new Set(), wallFront: new Set(), faces: new Set(), blockedFeet: new Uint8Array(rows * cols),
    pass: new Passability(L, obstaclesFromDecor(L.decor, opts.known as Map<string, DecorSpec>)), points: new Map(), runAt: new Map(), log,
  };
  // стоящий декор: грани и клетки перед ними (ниши — всем, прочие настенные — высоким), следы преград пола, точки пропов
  for (const d of L.decor) {
    if (d.kind !== 'obj' || !d.objectId) continue;
    const s = opts.known.get(d.objectId);
    const pts = ctx.points.get(d.objectId) ?? []; pts.push({ x: d.x, y: d.y }); ctx.points.set(d.objectId, pts);
    if (s?.surface === 'wall') {
      const faces = d.wallFaces ?? [(() => {
        const dx = Math.round(Math.sin(d.rot ?? 0)), dz = Math.round(Math.cos(d.rot ?? 0));
        return [Math.round((d.x - TILE / 2 - (dx * TILE) / 2) / TILE), Math.round((d.y - TILE / 2 - (dz * TILE) / 2) / TILE), dx, dz] as [number, number, number, number];
      })()];
      for (const [x, y, dx, dz] of faces) {
        ctx.faces.add(`${x},${y},${dx},${dz}`);
        const i = idxOf(ctx, x + dx, y + dz);
        if (i >= 0) (d.wallFaces ? ctx.statueFront : ctx.wallFront).add(i);
      }
    } else if (s?.blocks) {
      const r = footprintRect(d);
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) { const i = idxOf(ctx, x, y); if (i >= 0) ctx.blockedFeet[i] = 1; }
    }
  }
  const doorways = roomDoorways(L);
  const anchors = anchorCells(L, cols);
  const runs = wallRuns(L);
  const lanes: LaneSet[] = [];
  const pool = (c: string, f?: (s: DecorSpec) => boolean): DecorSpec[] => specs.filter((s) => has(s, c) && (!f || f(s)));

  for (let ri = 0; ri < L.rooms.length; ri++) {
    const room = L.rooms[ri]!;
    let area = 0;
    for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) { const i = y * cols + x; if (zone[i] === ri && isFloor(ctx, i)) area++; }
    const entrance = room.type === 'entrance';
    // ── бюджет: доля пустых, иначе плотность по площади пола; вход — без пропов (как у россыпи) ──
    const rb = createRng(slotSeed(seed, SLOT_STREAMS.budget, ri));
    const empty = !entrance && rb.chance(rules.emptyRoomShare);
    const target = entrance || empty ? 0 : Math.max(0, Math.round(rb.float(rules.density.min, rules.density.max) * area / rules.density.perArea));
    let placed = 0;
    const roomRuns = runs.filter((r) => r.zone === ri);
    // ── Р2 центр: проп пола со следом от minFoot, центр комнаты по сетке следа, кольцо пола вокруг, одна на комнату ──
    if (rules.center.on && target > 0 && Math.min(room.w, room.h) >= rules.center.minRoom) {
      const rc = createRng(slotSeed(seed, SLOT_STREAMS.center, ri));
      if (rc.chance(rules.center.chance)) {
        const cand = pool('floor', (s) => !tallOf(s) && Math.min(s.footprint.w, s.footprint.h) >= rules.center.minFoot);
        const got = placeOne(ctx, cand, room.type, rc, (s) => {
          const out: Cand[] = [];
          for (let k = 0; k < 4; k++) {
            const rot = k * HALF_PI, swap = k % 2 === 1;
            const w = swap ? s.footprint.h : s.footprint.w, h = swap ? s.footprint.w : s.footprint.h;
            const cx = snapCenter(room.x + room.w / 2, w), cy = snapCenter(room.y + room.h / 2, h);
            const x0 = cx - w / 2, y0 = cy - h / 2;
            const cells: number[] = [];
            let ring = true;
            for (let y = y0 - 1; y <= y0 + h && ring; y++) for (let x = x0 - 1; x <= x0 + w && ring; x++) {
              const i = idxOf(ctx, x, y);
              if (i < 0 || zone[i] !== ri || !isFloor(ctx, i)) ring = false;   // кольцо пола вокруг — обойти со всех сторон
              else if (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h) cells.push(i);
            }
            if (!ring) continue;
            const c: Cand = { cells, rect: { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 }, x: cx * TILE, y: cy * TILE, rot };
            if (canPlace(ctx, s, c, ri) && ctx.claims.free(c.rect, Math.max(1, s.clearance ?? 0))) out.push(c);
          }
          return out;
        }, 'center');
        if (got) placed++;
      }
    }
    // ── Р0 полосы комнаты: после центра и костра (огибают их) ──
    const myDoors = doorways.filter((d) => d.room === ri);
    lanes.push({ room: ri, cells: traceLanes(ctx, ri, myDoors, anchors.filter((i) => i >= 0 && zone[i] === ri)) });
    // ── арки в проёмы: ширина паспорта = ширине проёма; дальняя стена (арки высокие), рама из стен, не дверь; ⭐ 12.10 (ревью) тень арки не
    //    ложится на другую комнату (`archShadowsRoom`, `doorway.clearBeyond`). «Одинаковое не рядом» арок НЕ касается: арка — рама КАЖДОГО проёма
    //    (решение владельца: 01/04 обрамляют проёмы 3/4), два проёма в шаге друг от друга — обе в арках; число арок рулит `doorway.chance` ──
    if (rules.doorway.on) {
      const rd = createRng(slotSeed(seed, SLOT_STREAMS.doorway, ri));
      for (const d of myDoors) {
        const n = { x: -d.dir.dx, y: -d.dir.dy };   // нормаль стены проёма — в комнату
        if (d.door || !d.framed || !isFarFace(n.x, n.y, ctx.toCam)) continue;
        if (archShadowsRoom(ctx, d, rules.doorway.clearBeyond)) continue;
        const cand = pool('doorway', (s) => s.passport?.doorway?.width === d.width && weightOf(s, room.type) > 0);
        if (!cand.length || !rd.chance(rules.doorway.chance)) continue;
        const s = pickWeighted(cand, room.type, rd);
        if (!s) continue;
        const cells = [...d.cells, ...d.inner].map((c) => c.cy * cols + c.cx);
        const xs = [...d.cells, ...d.inner].map((c) => cellToWorld(c.cx, c.cy));
        const c: Cand = { cells, rect: rectOf(ctx, cells), x: xs.reduce((a, p) => a + p.x, 0) / xs.length, y: xs.reduce((a, p) => a + p.y, 0) / xs.length, rot: Math.atan2(n.x, n.y) };
        if (ctx.claims.free(c.rect, 0)) commit(ctx, s, c, 'doorway');
      }
    }
    // ── Р4 одиночки: заявки углов (шанс и пара) — их доля бюджета; спиной к стене — раньше углов (выбор по весу), затем углы ──
    const rk = createRng(slotSeed(seed, SLOT_STREAMS.corner, ri));
    const reqs: { k: Corner; pair: boolean }[] = [];
    let cornerItems = 0;
    if (rules.corner.on && target - placed > 0) {
      for (const k of cornersOf(ctx, ri)) {
        if (!rk.chance(rules.corner.chance)) continue;
        const pair = rk.chance(rules.corner.pair);
        if (cornerItems >= target - placed) break;
        const p2 = pair && cornerItems + 2 <= target - placed;
        reqs.push({ k, pair: p2 }); cornerItems += p2 ? 2 : 1;
      }
    }
    const ra = createRng(slotSeed(seed, SLOT_STREAMS.againstWall, ri));
    const wallPool = rules.againstWall.on ? pool('againstWall') : [];
    const fillWall = (want: number): void => {
      for (; want > 0; want--) {
        if (!placeOne(ctx, wallPool, room.type, ra, (s) => againstWallCands(ctx, s, ri, roomRuns), 'againstWall')) break;
        placed++;
      }
    };
    fillWall(target - placed - cornerItems);
    for (const { k, pair } of reqs) {
      const main = placeOne(ctx, pool('corner'), room.type, rk, (s) => cornerCands(ctx, s, ri, k), 'corner');
      if (!main) continue;
      placed++;
      if (!pair) continue;
      // вторая — 1 × 1 по другой стене блока (диагональ свободна)
      const na = { x: -k.a[0], y: -k.a[1] }, nb = { x: -k.b[0], y: -k.b[1] };
      const sites = [{ x: k.x + na.x, y: k.y + na.y }, { x: k.x + nb.x, y: k.y + nb.y }];   // занятую главным отсеет `canPlace` (след)
      const twin = specs.filter((s) => (has(s, 'corner') || has(s, 'againstWall')) && s.footprint.w === 1 && s.footprint.h === 1);
      if (placeOne(ctx, twin, room.type, rk, (s) => cornerCands(ctx, s, ri, k, sites), 'corner')) placed++;
    }
    // ⭐ 12.10 (ревью Ф2): ВОЗВРАТ НЕДОБОРА УГЛОВ — заявка угла (или пара) не встала (нет места, откат Р6): её доля бюджета уходит «спиной к
    // стене» (тот же поток). Без возврата это главный недобор плотности: 80 % цели, 39 % комнат ниже цели (замер ревью: ширина полос на него
    // почти не влияет — полосы 1 дали 80.7 %)
    fillWall(target - placed);
    log.rooms.push({ room: ri, type: room.type, area, target, empty, placed });
    // ── грани стен комнаты (контекст wall): шаг и шанс; в счёт бюджета не идут ──
    if (rules.wall.on) wallFaceSlots(ctx, specs, roomRuns, room.type, createRng(slotSeed(seed, SLOT_STREAMS.wall, ri)));
  }
  // ── коридоры: только грани стен (и арки — у проёмов комнат) ──
  if (rules.wall.on && rules.wall.corridors) wallFaceSlots(ctx, specs, runs.filter((r) => r.zone < 0), 'corridor', createRng(slotSeed(seed, SLOT_STREAMS.wall, CORRIDOR_STREAM)));
  L.doorways = doorways;
  L.lanes = lanes;
  L.slotLog = log;
  return log;
}

/** Грани стен пробегов `runs` (место `place` — тип комнаты или corridor): позиции с шагом `wall.step` от грани у конца, на свободной —
 *  шанс `wall.chance`, проп контекста wall по весу места (высокий — только на дальней стене). Ширина следа — граней подряд.
 *  ⭐ 12.10 (ревью Ф2): только НАСТЕННЫЕ спеки (`surface: 'wall'` — паспорт лишь с wall/wallInsert, `passportSurface`, или строка `objects` стены):
 *  паспорт «wall + у стены» — поверхность пол, Unity рисовал бы его на полу (y0 = 0) и не гасил со стеной, а след лёг бы на линию стены
 *  наполовину в неё; такой смешанный паспорт — предупреждение редактора (`decorWarnings`), на гранях — нет. */
function wallFaceSlots(ctx: Ctx, specs: readonly DecorSpec[], runs: readonly Run[], place: string, rng: Rng): void {
  const pool = specs.filter((s) => has(s, 'wall') && s.surface === 'wall');
  if (!pool.length) return;
  const { step, chance } = ctx.rules.wall;
  for (const run of runs) {
    const far = isFarFace(run.dx, run.dz, ctx.toCam);
    const fit = pool.filter((s) => !tallOf(s) || far);
    if (!fit.length) continue;
    for (let i = 1; i <= run.faces.length - 2; i += step) {
      const fk = (j: number): string => { const f = run.faces[j]!; return `${f.x},${f.y},${f.dx},${f.dz}`; };
      if (ctx.faces.has(fk(i)) || !rng.chance(chance)) continue;
      const s = pickWeighted(fit, place, rng);
      if (!s) continue;
      const A = Math.max(1, s.footprint.w);
      if (i + A - 1 > run.faces.length - 2) continue;
      let free = true;
      for (let j = i; j < i + A && free; j++) if (ctx.faces.has(fk(j))) free = false;
      if (!free) continue;
      const fronts = run.faces.slice(i, i + A).map((f) => idxOf(ctx, f.x + f.dx, f.y + f.dz));
      if (keepsPath(s) && fronts.some((c) => c >= 0 && ctx.lane[c])) continue;
      const p0 = facePoint(run.faces[i]!), p1 = facePoint(run.faces[i + A - 1]!);
      const c: Cand = { cells: fronts, rect: rectOf(ctx, fronts), x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, rot: Math.atan2(run.dx, run.dz) };
      const r = ctx.rules.sameNotNear;
      if (r > 0 && (ctx.points.get(s.id) ?? []).some((p) => Math.hypot(p.x - c.x, p.y - c.y) <= r * TILE + 1e-6)) continue;
      // настенный — не напольный: следа на полу не занимает (как факел), только грани и «перед ним» для высоких
      const d: DecorObject = { x: c.x, y: c.y, kind: 'obj', objectId: s.id, rot: normRot(c.rot), footprint: { w: s.footprint.w, h: s.footprint.h } };
      if (s.blocks && !ctx.pass.tryAdd(obstaclesFromDecor([d], ctx.known as Map<string, DecorSpec>))) { ctx.log.passes.wall.rejected++; continue; }
      ctx.L.decor.push(d);
      for (let j = i; j < i + A; j++) ctx.faces.add(fk(j));
      for (const f of fronts) if (f >= 0) ctx.wallFront.add(f);
      const pts = ctx.points.get(s.id) ?? []; pts.push({ x: d.x, y: d.y }); ctx.points.set(s.id, pts);
      ctx.log.passes.wall.placed++;
    }
  }
}
