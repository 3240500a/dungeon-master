import type { Biome } from '../config/schemas.js';
import { Cell, worldToCell } from '../world/grid.js';
import { footprintRect, obstaclesFromDecor, type DecorSpec } from './decor.js';
import type { DungeonLayout } from './floorCommon.js';
import { generateFloorFor, type FloorConfig } from './floorInputs.js';
import { resolveFloorSpec } from './floorSpec.js';
import { Passability, type SlotPass } from './slots.js';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора — «Как проверяем»): СВОДКА ДЕКОРА ПО СИДАМ — «документ средних» (как у Path of Exile): N этажей
 * биома путём сервера (`generateFloorFor`) → пропы на комнату (мин / медиана / макс, по типу комнаты), доля занятого пола, доля пустых комнат,
 * сколько раз какой предмет встал, счётчики проходов слотов (поставлено / откачено проверкой проходимости), проёмы и полосы, время сборки этажа.
 * По ней крутят бюджеты правил пропов (`biomes[].dressing.props`), а не на глаз по одному этажу. CLI — `npm run decor:stats`
 * (`packages/server/src/decor-stats-cli.ts`); `withoutRules` — тот же биом без правил пропов (путь Ф1: паспорта россыпью) для «до / после».
 *
 * Счёт — по раскладке, не по журналу слотов: одинаково и для пути Ф1, и для Ф2. «Проп комнаты» — объект с паспортом декора
 * (`DecorSpec.contexts`), кроме арок (контекст doorway с шириной проёма) и настенных (`surface: wall`); комната — первая, в прямоугольнике
 * которой клетка его точки (как зоны `wallRuns`), вход не считается (пропов в нём нет по правилу). «Занятый пол» — клетки пола комнат под
 * следом ТВЁРДОГО напольного декора (`blocks`: пропы, костры). Сторож Р6 — независимо от расстановки (`Passability`, радиус героя, двери открыты
 * и закрыты): клетки и якоря (выходы, рычаги, сундуки, проёмы), достижимые от спавна на этаже с прочим декором, обязаны оставаться достижимыми
 * и с пропами паспортов (`cut.props` = 0); что отрезал прочий декор (оформление Р1, россыпь без паспорта) — отдельно (`cut.other`, от этажа без
 * декора; замер 12.10: ниша статуи запирает тупик шириной в клетку — 2 клетки на 60 этажей крипты, якоря — 0).
 */

/** Сводка одного биома. Числа «на этаж» — средние по этажам выборки. */
export interface DecorStats {
  biomeId: string;
  /** Были ли у биома правила пропов (путь слотов Ф2). */
  rules: boolean;
  floors: number;
  /** Время сборки этажа (`generateFloorFor`), мс — после прогрева. */
  genMs: { p50: number; p95: number; mean: number; max: number };
  /** Комнат без входа. */
  rooms: number;
  /** Средняя площадь пола комнаты (без входа), клеток. */
  roomArea: number;
  /** Пропы комнаты: на комнату (без входа) и на 100 клеток её пола (в среднем). */
  perRoom: { min: number; median: number; max: number; mean: number; per100: number };
  /** То же по типу комнаты. */
  byType: Record<string, { rooms: number; min: number; median: number; max: number; mean: number; area: number }>;
  /** Доля комнат (без входа) без единого пропа. */
  emptyShare: number;
  /** Доля комнат, выпавших пустыми броском правила (журнал слотов; путь Ф1 — нет). */
  rolledEmptyShare?: number;
  /** Цель и факт бюджета на комнату (журнал слотов). */
  budget?: { target: number; placed: number };
  /** Доля пола комнат под следом твёрдого напольного декора — всего и только пропов с паспортом. */
  occupied: { all: number; props: number };
  /** На этаж: пропы с паспортом в коридорах (вне комнат), арки, настенные с паспортом. */
  perFloor: { corridorProps: number; arches: number; wallProps: number };
  /** Предметы (`obj`) на этаж по id — и оформление, и россыпь, и паспорта. */
  items: Record<string, number>;
  /** Проходы слотов на этаж: поставлено / откачено (Р6). Путь Ф1 — нет. */
  passes?: Record<SlotPass, { placed: number; rejected: number }>;
  /** Проёмы комнат на этаж, доля с рамой, ширины (с дверью рычага — «Nд»). Путь Ф1 — нет. */
  doorways?: { perFloor: number; framedShare: number; widths: Record<string, number> };
  /** Доля пола комнат под полосами прохода. Путь Ф1 — нет. */
  laneShare?: number;
  /** Сторож Р6 по всей выборке (сумма): клетки и якоря, отрезанные пропами с паспортом (обязаны быть 0), и — отдельно — прочим декором
   *  (оформление Р1, россыпь без паспорта; меряется от этажа без декора, пропы — от этажа с прочим декором). */
  cut: { props: { cells: number; anchors: number }; other: { cells: number; anchors: number } };
}

export interface DecorStatsOpts {
  /** Этажей в выборке. */
  floors: number;
  /** Этажей прогрева (в счёт не идут) — время первых сборок раздуто компиляцией; по умолчанию min(20, floors). */
  warmup?: number;
  /** Без правил пропов биома (путь Ф1) — для «до / после». */
  withoutRules?: boolean;
  /** Часы (мс); по умолчанию `performance.now`. */
  now?: () => number;
}

/** Биом без правил пропов (`dressing.props`) — путь Ф1. */
export function biomeWithoutPropRules(b: Biome): Biome {
  return b.dressing?.props ? { ...b, dressing: (({ props: _p, ...d }) => d)(b.dressing) } : b;
}

const quant = (sorted: readonly number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);
const meanOf = (a: readonly number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const spread = (a: number[]): { min: number; median: number; max: number; mean: number } => {
  const s = [...a].sort((x, y) => x - y);
  return { min: s[0] ?? 0, median: quant(s, 0.5), max: s[s.length - 1] ?? 0, mean: meanOf(s) };
};

/** Этажи выборки: обычные роли биома (без привала), каждая — столько раз подряд, сколько её `weight`, по кругу; сид и число выходов — от номера. */
function sampleFloors(cfg: FloorConfig, biome: Biome): (i: number) => ReturnType<typeof resolveFloorSpec> {
  const floors = cfg.get('floors').filter((f) => f.biomeId === biome.id && f.role !== 'rest' && f.enabled !== false && (f.weight ?? 1) > 0);
  const deck = floors.flatMap((f) => Array.from({ length: Math.max(1, Math.round(f.weight ?? 1)) }, () => f));
  return (i) => {
    const f = deck.length ? deck[i % deck.length] : undefined;
    return resolveFloorSpec(biome, f, f?.minDepth ?? 1, (i * 7919 + 13) >>> 0, [], { exitCount: 1 + (i % 3) });
  };
}

/** Отрезал ли декор что-то (Р6, независимо от расстановки): клетки и якоря (выходы, рычаги, сундуки — клеткой; проёмы — хоть одной клеткой),
 *  достижимые до (`base`), обязаны быть достижимы после (`dec`). */
function cutOf(L: DungeonLayout, base: Passability, dec: Passability): { cells: number; anchors: number } {
  let cells = 0, anchors = 0;
  for (let i = 0; i < base.bits.length; i++) if (base.reached(i, true) && dec.walk(i, true) && !dec.reached(i, true)) cells++;
  const lost = (cx: number, cy: number): boolean => {
    const i = cy * base.cols + cx;
    return (base.reached(i, true) && !dec.reached(i, true)) || (base.reached(i, false) && !dec.reached(i, false));
  };
  const pt = (p: { x: number; y: number }): boolean => { const c = worldToCell(p.x, p.y); return lost(c.cx, c.cy); };
  for (const e of L.exits) if (pt(e)) anchors++;
  for (const lv of L.levers) if (pt(lv)) anchors++;
  for (const c of L.chests) if (pt(c)) anchors++;
  // проём — целиком: был достижим хоть одной клеткой — и остался (широкий проём с клеткой под преградой соседней комнаты не отрезан)
  const any = (p: Passability, d: { cells: readonly { cx: number; cy: number }[] }, open: boolean): boolean => d.cells.some((c) => p.reached(c.cy * p.cols + c.cx, open));
  for (const d of L.doorways ?? []) if ((any(base, d, true) && !any(dec, d, true)) || (any(base, d, false) && !any(dec, d, false))) anchors++;
  return { cells, anchors };
}

/** Сводка декора биома `biome` по `opts.floors` этажам пути сервера. */
export function decorStats(cfg: FloorConfig, biome: Biome, opts: DecorStatsOpts): DecorStats {
  const b = opts.withoutRules ? biomeWithoutPropRules(biome) : biome;
  const now = opts.now ?? (() => performance.now());
  const specOf = sampleFloors(cfg, b);
  const warm = Math.max(0, Math.min(opts.warmup ?? 20, opts.floors));
  for (let i = 0; i < warm; i++) generateFloorFor(cfg, specOf(opts.floors + i), b);   // прогрев — на чужих сидах

  const times: number[] = [], perRoom: number[] = [], per100: number[] = [];
  const byType = new Map<string, { n: number[]; area: number }>();
  const items = new Map<string, number>();
  const passes: Partial<Record<SlotPass, { placed: number; rejected: number }>> = {};
  const widths = new Map<string, number>();
  let rooms = 0, areaSum = 0, empty = 0, rolled = 0, logged = 0, target = 0, placedLog = 0;
  let floorCells = 0, occAll = 0, occProps = 0, laneCells = 0, corridorProps = 0, arches = 0, wallProps = 0;
  let doorways = 0, framed = 0, withLog = 0;
  const cut: DecorStats['cut'] = { props: { cells: 0, anchors: 0 }, other: { cells: 0, anchors: 0 } };

  for (let i = 0; i < opts.floors; i++) {
    const spec = specOf(i);
    const t0 = now();
    const { layout: L, inputs, obstacles } = generateFloorFor(cfg, spec, b);
    times.push(now() - t0);
    const known = new Map<string, DecorSpec>(inputs.decorSpecs.map((s) => [s.id, s]));
    const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
    // зона клетки — первая комната, в прямоугольнике которой она лежит (как `wallRuns`/`placeSlots`), иначе −1
    const zone = new Int32Array(rows * cols).fill(-1);
    for (let ri = L.rooms.length - 1; ri >= 0; ri--) {
      const r = L.rooms[ri]!;
      for (let y = Math.max(0, r.y); y < Math.min(rows, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(cols, r.x + r.w); x++) zone[y * cols + x] = ri;
    }
    const area = new Array<number>(L.rooms.length).fill(0);
    for (let k = 0; k < zone.length; k++) if (zone[k]! >= 0 && L.grid[(k / cols) | 0]![k % cols] === Cell.Floor) area[zone[k]!]!++;
    const count = new Array<number>(L.rooms.length).fill(0);
    const hard = new Uint8Array(rows * cols), hardProp = new Uint8Array(rows * cols);
    for (const d of L.decor) {
      if (d.kind !== 'obj' || !d.objectId) continue;
      items.set(d.objectId, (items.get(d.objectId) ?? 0) + 1);
      const s = known.get(d.objectId);
      if (!s) continue;
      const passport = !!s.contexts;
      const arch = passport && !!s.passport?.doorway && s.contexts!.includes('doorway');
      if (s.surface === 'wall') { if (passport) wallProps++; continue; }
      if (arch) { arches++; continue; }
      if (s.blocks) {
        const r = footprintRect(d);
        for (let y = Math.max(0, r.y0); y <= Math.min(rows - 1, r.y1); y++) for (let x = Math.max(0, r.x0); x <= Math.min(cols - 1, r.x1); x++) {
          hard[y * cols + x] = 1; if (passport) hardProp[y * cols + x] = 1;
        }
      }
      if (!passport) continue;
      const c = worldToCell(d.x, d.y), z = c.cx >= 0 && c.cy >= 0 && c.cx < cols && c.cy < rows ? zone[c.cy * cols + c.cx]! : -1;
      if (z < 0) corridorProps++; else count[z]!++;
    }
    for (let k = 0; k < zone.length; k++) {
      const z = zone[k]!;
      if (z < 0 || L.rooms[z]!.type === 'entrance' || L.grid[(k / cols) | 0]![k % cols] !== Cell.Floor) continue;
      floorCells++; if (hard[k]) occAll++; if (hardProp[k]) occProps++;
    }
    L.rooms.forEach((r, ri) => {
      if (r.type === 'entrance') return;
      rooms++; areaSum += area[ri]!;
      perRoom.push(count[ri]!); if (area[ri]! > 0) per100.push((100 * count[ri]!) / area[ri]!);
      if (count[ri] === 0) empty++;
      const t = byType.get(r.type) ?? { n: [], area: 0 };
      t.n.push(count[ri]!); t.area += area[ri]!; byType.set(r.type, t);
    });
    if (L.slotLog) {
      withLog++;
      for (const [k, v] of Object.entries(L.slotLog.passes) as [SlotPass, { placed: number; rejected: number }][]) {
        const p = (passes[k] ??= { placed: 0, rejected: 0 }); p.placed += v.placed; p.rejected += v.rejected;
      }
      for (const r of L.slotLog.rooms) {
        if (r.type === 'entrance') continue;
        logged++; if (r.empty) rolled++; target += r.target; placedLog += r.placed;
      }
    }
    for (const d of L.doorways ?? []) {
      doorways++; if (d.framed) framed++;
      const k = `${d.width}${d.door ? 'д' : ''}`; widths.set(k, (widths.get(k) ?? 0) + 1);
    }
    for (const l of L.lanes ?? []) if (L.rooms[l.room]?.type !== 'entrance') laneCells += l.cells.filter((k) => zone[k] === l.room).length;
    // Р6: без декора → прочий декор (оформление, россыпь без паспорта) → весь; пропы с паспортом судятся от этажа с прочим декором
    const other = obstaclesFromDecor(L.decor.filter((d) => !(d.kind === 'obj' && d.objectId && known.get(d.objectId)?.contexts)), known);
    const p0 = new Passability(L, []), p1 = new Passability(L, other), p2 = new Passability(L, obstacles);
    const co = cutOf(L, p0, p1), cp = cutOf(L, p1, p2);
    cut.other.cells += co.cells; cut.other.anchors += co.anchors; cut.props.cells += cp.cells; cut.props.anchors += cp.anchors;
  }

  const n = Math.max(1, opts.floors);
  const t = [...times].sort((x, y) => x - y);
  const out: DecorStats = {
    biomeId: biome.id, rules: !!b.dressing?.props, floors: opts.floors,
    genMs: { p50: quant(t, 0.5), p95: quant(t, 0.95), mean: meanOf(t), max: t[t.length - 1] ?? 0 },
    rooms, roomArea: rooms ? areaSum / rooms : 0,
    perRoom: { ...spread(perRoom), per100: meanOf(per100) },
    byType: Object.fromEntries([...byType].sort(([a], [c]) => (a < c ? -1 : 1)).map(([k, v]) => [k, { rooms: v.n.length, ...spread(v.n), area: v.n.length ? v.area / v.n.length : 0 }])),
    emptyShare: rooms ? empty / rooms : 0,
    occupied: { all: floorCells ? occAll / floorCells : 0, props: floorCells ? occProps / floorCells : 0 },
    perFloor: { corridorProps: corridorProps / n, arches: arches / n, wallProps: wallProps / n },
    items: Object.fromEntries([...items].sort((a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1)).map(([k, v]) => [k, v / n])),
    cut,
  };
  if (withLog) {
    out.rolledEmptyShare = logged ? rolled / logged : 0;
    out.budget = { target: logged ? target / logged : 0, placed: logged ? placedLog / logged : 0 };
    out.passes = Object.fromEntries(Object.entries(passes).map(([k, v]) => [k, { placed: v.placed / n, rejected: v.rejected / n }])) as DecorStats['passes'];
    out.doorways = { perFloor: doorways / n, framedShare: doorways ? framed / doorways : 0, widths: Object.fromEntries([...widths].sort(([a], [c]) => (a < c ? -1 : 1)).map(([k, v]) => [k, v / n])) };
    out.laneShare = floorCells ? laneCells / floorCells : 0;
  }
  return out;
}

const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);
const pc = (x: number): string => `${(100 * x).toFixed(1)} %`;

/** Сводка текстом (CLI, README). `before` — тот же биом без правил пропов (путь Ф1): тогда ключевые строки — «до → после». */
export function formatDecorStats(s: DecorStats, before?: DecorStats): string {
  const L: string[] = [];
  const ba = (f: (x: DecorStats) => string): string => (before ? `${f(before)} → ${f(s)}` : f(s));
  L.push(`── ${s.biomeId}: ${s.floors} этажей · правила пропов: ${s.rules ? 'есть (слоты Ф2)' : 'нет (путь Ф1)'}${before ? ' · «до» — тот же биом без правил (путь Ф1)' : ''}`);
  L.push(`  сборка этажа, мс: p50 ${ba((x) => f2(x.genMs.p50))} · p95 ${ba((x) => f2(x.genMs.p95))} · среднее ${ba((x) => f2(x.genMs.mean))} · макс ${ba((x) => f1(x.genMs.max))}`);
  L.push(`  комнат (без входа) ${s.rooms}, пол комнаты в среднем ${f1(s.roomArea)} клеток`);
  L.push(`  пропов на комнату: мин ${ba((x) => String(x.perRoom.min))} · медиана ${ba((x) => String(x.perRoom.median))} · макс ${ba((x) => String(x.perRoom.max))} · среднее ${ba((x) => f2(x.perRoom.mean))} · на 100 клеток ${ba((x) => f2(x.perRoom.per100))}`);
  for (const [k, v] of Object.entries(s.byType)) {
    const b = before?.byType[k];
    L.push(`    ${k}: комнат ${v.rooms}, пол ${f1(v.area)} · мин ${v.min} · медиана ${b ? `${b.median} → ` : ''}${v.median} · макс ${b ? `${b.max} → ` : ''}${v.max} · среднее ${b ? `${f2(b.mean)} → ` : ''}${f2(v.mean)}`);
  }
  L.push(`  пустых комнат ${ba((x) => pc(x.emptyShare))}${s.rolledEmptyShare !== undefined ? ` (бросок «пустая» — ${pc(s.rolledEmptyShare)})` : ''}`);
  if (s.budget) L.push(`  бюджет на комнату: цель ${f2(s.budget.target)}, поставлено ${f2(s.budget.placed)} (центр, углы, у стены; арки и грани — сверх)`);
  L.push(`  занятый пол комнат (твёрдый декор): всего ${ba((x) => pc(x.occupied.all))} · пропы ${ba((x) => pc(x.occupied.props))}${s.laneShare !== undefined ? ` · полосы прохода ${pc(s.laneShare)}` : ''}`);
  L.push(`  на этаж: арок ${ba((x) => f2(x.perFloor.arches))} · настенных с паспортом ${ba((x) => f2(x.perFloor.wallProps))} · пропов в коридорах ${ba((x) => f2(x.perFloor.corridorProps))}`);
  if (s.doorways) L.push(`  проёмов на этаж ${f2(s.doorways.perFloor)}, с рамой ${pc(s.doorways.framedShare)}; ширины: ${Object.entries(s.doorways.widths).map(([k, v]) => `${k}×${f2(v)}`).join(' ')}`);
  if (s.passes) L.push(`  проходы на этаж (поставлено / откачено Р6): ${Object.entries(s.passes).map(([k, v]) => `${k} ${f2(v.placed)}/${f2(v.rejected)}`).join(' · ')}`);
  const ids = [...new Set([...Object.keys(s.items), ...Object.keys(before?.items ?? {})])];
  ids.sort((a, c) => (s.items[c] ?? 0) - (s.items[a] ?? 0) || (a < c ? -1 : 1));
  L.push(`  предметов на этаж: ${ids.map((k) => `${k} ${before ? `${f2(before.items[k] ?? 0)} → ` : ''}${f2(s.items[k] ?? 0)}`).join(' · ') || '—'}`);
  L.push(`  Р6, отрезано пропами с паспортом: клеток ${ba((x) => String(x.cut.props.cells))}, якорей ${ba((x) => String(x.cut.props.anchors))}${s.cut.props.cells || s.cut.props.anchors ? '  ⚠ ОТРЕЗАНО' : ''}` +
    ` · прочим декором (оформление, россыпь без паспорта): клеток ${ba((x) => String(x.cut.other.cells))}, якорей ${ba((x) => String(x.cut.other.anchors))}`);
  return L.join('\n');
}
