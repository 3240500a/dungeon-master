// ── ОБЖАТИЕ КОЛЛАЙДЕРА ПО ВЕРШИНАМ (Ф28.3) ───────────────────────────────────────────────────
// Чистая математика: точки в ФРЕЙМЕ ТЕЛА → размеры формы. Ни THREE, ни Jolt, ни DOM —
// поэтому считается в node-тестах, как `physRig.ts`.
//
// ЗАЧЕМ. До этого физ-тела снимались ТОЛЬКО С КОСТЕЙ (`fitPhysToBones`): длина бралась честно,
// а ширина и толщина оставались ручными множителями «на глаз». Индустрия так не делает: в Unreal
// PhysicsAsset тела генерируются ПО ВЕРШИНАМ, взвешенным на кость (`Vertex Weighting Type`:
// Any Weight / Dominant Weight), и только поэтому коллайдер повторяет тело, а не приблизительно
// его напоминает. Здесь ровно это.
//
// ПОЧЕМУ ПЕРЦЕНТИЛЬ, А НЕ МАКСИМУМ. Одна залётная вершина (шип на наплечнике, застрявший вес
// от соседней кости) раздувает капсулу на всю руку. Перцентиль отсекает выбросы и даёт форму,
// которая описывает МАССУ вершин. Для рагдолла коллайдер полезно держать чуть МЕНЬШЕ меша
// (иначе соседние тела пересекаются и физика расшвыривает их на старте), для ткани — чуть
// БОЛЬШЕ (иначе ткань протыкает меш) — за это отвечает `inflate`.

/** Точка в ФРЕЙМЕ ТЕЛА: `a` — вдоль оси тела, `u`/`v` — две поперечные. */
export interface BodyPoint { a: number; u: number; v: number }

export interface FitOpts {
  /** Доля вершин, которую форма обязана накрыть (0..1). Остальное — выбросы. */
  pct?: number;
  /** Раздуть (>1) или поджать (<1) поперечник. Рагдолл — чуть меньше меша, ткань — чуть больше. */
  inflate?: number;
  /**
   * Доля, срезаемая С КАЖДОГО КОНЦА оси. Реальный скиннинг вешает на кость одиночные
   * далёкие вершины (пола плаща на груди, воротник на шее), и чистый min/max растягивал
   * тело вчетверо (замер: грудь 2.82u → 10.53u). 0 = честные края.
   */
  axPct?: number;
}

export interface FitResult {
  /** Половина длины вдоль оси тела. */
  half: number;
  /** Смещение ЦЕНТРА формы вдоль оси относительно начала фрейма (сустава). */
  center: number;
  /** Радиус (круглые формы) = перцентиль расстояния от оси. */
  r: number;
  /** Полуширина по `u` и полутолщина по `v` — для бокса. */
  hu: number;
  hv: number;
  /**
   * Радиус БЛИЖНЕЙ и ДАЛЬНЕЙ половин тела — для конической капсулы. Конечность человека
   * сужается к концу (бедро толще колена), и одним радиусом это не опишешь: либо толсто внизу,
   * либо тонко вверху. Именно этой формой ткань аппроксимирует конечности (пара сфер разного радиуса).
   */
  rNear: number;
  rFar: number;
  /** Сколько вершин участвовало. 0 → мерить было нечего, вызывающий обязан оставить прежнее. */
  n: number;
}

/** Перцентиль по УЖЕ отсортированному массиву (линейная интерполяция между соседями). */
export function percentileSorted(sorted: number[], pct: number): number {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0]!;
  const x = Math.min(Math.max(pct, 0), 1) * (n - 1);
  const i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i]! * (1 - f) + sorted[i + 1]! * f : sorted[n - 1]!;
}

/**
 * Обжать облако точек тела.
 *
 * ДЛИНА и ПОПЕРЕЧНИК режутся РАЗНЫМИ порогами и это намеренно. Поперёк выбросов много
 * (шипы, чужие веса) — там агрессивный `pct`. Вдоль оси конец кости — это конец кости,
 * подрезать его нельзя (стопа станет короче ступни), поэтому `axPct` малый и по умолчанию нулевой.
 */
export function fitCollider(pts: readonly BodyPoint[], opts: FitOpts = {}): FitResult {
  const pct = opts.pct ?? 0.95, inflate = opts.inflate ?? 1;
  const n = pts.length;
  if (!n) return { half: 0, center: 0, r: 0, hu: 0, hv: 0, rNear: 0, rFar: 0, n: 0 };
  const ax: number[] = [], rad: number[] = [], du: number[] = [], dv: number[] = [];
  for (const p of pts) { ax.push(p.a); rad.push(Math.hypot(p.u, p.v)); du.push(Math.abs(p.u)); dv.push(Math.abs(p.v)); }
  ax.sort((x, y) => x - y); rad.sort((x, y) => x - y); du.sort((x, y) => x - y); dv.sort((x, y) => x - y);
  const t = opts.axPct ?? 0;
  const lo = percentileSorted(ax, t), hi = percentileSorted(ax, 1 - t);
  // Радиусы концов берутся по КРАЙНИМ ЧЕТВЕРТЯМ, а не по половинам: половина тянет оценку
  // к середине тела и конус получается почти цилиндром (замер на конусе 4u→2u: дальний
  // радиус выходил 2.95 вместо 2.5). Границы — по ОСИ, а не по числу точек: плотность вершин неровная.
  const q = (hi - lo) / 4;
  const near: number[] = [], farr: number[] = [];
  for (const p of pts) { const r0 = Math.hypot(p.u, p.v); if (p.a <= lo + q) near.push(r0); else if (p.a >= hi - q) farr.push(r0); }
  if (!near.length) near.push(percentileSorted(rad, pct));
  if (!farr.length) farr.push(percentileSorted(rad, pct));
  near.sort((x, y) => x - y); farr.sort((x, y) => x - y);
  return {
    half: (hi - lo) / 2,
    center: (hi + lo) / 2,
    r: percentileSorted(rad, pct) * inflate,
    hu: percentileSorted(du, pct) * inflate,
    hv: percentileSorted(dv, pct) * inflate,
    rNear: percentileSorted(near, pct) * inflate,
    rFar: percentileSorted(farr, pct) * inflate,
    n,
  };
}
