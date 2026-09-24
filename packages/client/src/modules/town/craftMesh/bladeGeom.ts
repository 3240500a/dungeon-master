import * as THREE from 'three';

/**
 * ⭐ ИЗМЕРИТЕЛЬ КЛИНКА (docs/CRAFT_WEAPONS.md §26): геометрия модели → числа, из которых ковка
 * выводит статы (`shared/formulas/bladeStats.ts`). Один и тот же код меряет процедурные заглушки
 * (сторож `bladeGeom.test.ts` сверяет их с `weapon-parts[].geom`) и модели, загруженные во вкладке
 * «Ковка → Клинки» редактора.
 *
 * Договор о модели (тот же, что у `craftMesh/core.ts`): сантиметры, пята клинка у начала координат,
 * клинок идёт по −Y, полотно в плоскости XY, лезвие смотрит в +X. Модель не по договору можно
 * развернуть (`orient`): длинная ось — клинок, пята — конец, ближний к началу координат, плоскость
 * полотна — более широкая из двух оставшихся осей. Но тогда спинку однолезвийного не отличить от
 * лезвия, и замер об этом предупреждает.
 */

/** Станций вдоль клинка: 24 полосы от пяты к острию. */
export const BLADE_STATIONS = 24;

export interface BladeMeasure {
  /** Длина клинка, см. */
  len: number;
  /** Рабочая ширина: медиана ширины на 25–87 % длины (без усов рикассо и без острия), см. */
  width: number;
  /** Центр площади силуэта: 0 — у рукояти, 1 — у острия. */
  bal: number;
  /** Расширение к концу: наибольшая ширина на 67–87 % к медиане на 33–67 %. */
  flare: number;
  /** Изгиб спинки, % длины. */
  spine: number;
  /** Наибольшая ширина (с усами), см — для справки. */
  wMax: number;
  /** Наибольшая толщина, см. */
  thick: number;
  /** Ширина по станциям от пяты к острию, см. */
  prof: number[];
  /** Сколько треугольников в модели. */
  tris: number;
  /** Что пришлось сделать с моделью и о чём стоит знать. */
  warn: string[];
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Все треугольники объекта в мировых координатах (индексированные и нет). */
function worldTriangles(obj: THREE.Object3D): Float32Array {
  obj.updateMatrixWorld(true);
  const chunks: Float32Array[] = [];
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    chunks.push(out);
  });
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

/**
 * Перекладка осей: какая из мировых осей — длина (L), ширина полотна (W) и толщина (T), и в какую
 * сторону идёт клинок. По договору L = −Y, W = X, T = Z.
 */
interface Frame { l: 0 | 1 | 2; w: 0 | 1 | 2; t: 0 | 1 | 2; lSign: 1 | -1 }

type Axis = 0 | 1 | 2;
const AXIS = 'XYZ';

function pickFrame(tri: Float32Array, orient: boolean, warn: string[]): Frame {
  const def: Frame = { l: 1, w: 0, t: 2, lSign: 1 };
  if (!orient || !tri.length) return def;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3) for (let a = 0; a < 3; a++) { const x = tri[i + a]!; if (x < lo[a]!) lo[a] = x; if (x > hi[a]!) hi[a] = x; }
  const ext = [0, 1, 2].map((a) => hi[a]! - lo[a]!);
  const l = ext.indexOf(Math.max(...ext)) as Axis;
  const [r0, r1] = ([0, 1, 2] as const).filter((a) => a !== l) as [Axis, Axis];
  const [w, t]: [Axis, Axis] = ext[r0]! >= ext[r1]! ? [r0, r1] : [r1, r0];
  // Пята — конец, ближний к началу координат; остриё уходит в «минус» по оси длины. Это только первая
  // догадка: у модели с центром посередине клинка она — монетка, и `measureBlade` перепроверяет её формой.
  const lSign: 1 | -1 = Math.abs(hi[l]!) <= Math.abs(lo[l]!) ? 1 : -1;
  if (Math.min(Math.abs(hi[l]!), Math.abs(lo[l]!)) > 0.1 * ext[l]!) {
    warn.push('Начало координат не у пяты: пяту и остриё различаю по форме клинка — проверь силуэт.');
  }
  if (l !== 1 || lSign !== 1) {
    warn.push(`Клинок лежал не по договору (ось ${AXIS[l]}): развернул по самой длинной оси. Лезвие однолезвийного могло оказаться со стороны спинки — проверь подсказку формы.`);
  }
  if (w !== 0) warn.push(`Полотно в плоскости ${AXIS[w]}${AXIS[l]}, а не XY: ширину взял по ${AXIS[w]}.`);
  return { l, w, t, lSign };
}

interface Sections { len: number; prof: number[]; back: number[]; thick: number }

/** Координаты в рамке клинка: y — вдоль (пята вверху, остриё внизу), x — ширина, z — толщина. */
function toBladeFrame(tri: Float32Array, f: Frame, sign: 1 | -1): Float32Array {
  const n = tri.length / 3;
  const P = new Float32Array(tri.length);
  for (let i = 0; i < n; i++) {
    P[i * 3] = tri[i * 3 + f.w]!;
    P[i * 3 + 1] = tri[i * 3 + f.l]! * f.lSign * sign;
    P[i * 3 + 2] = tri[i * 3 + f.t]!;
  }
  return P;
}

/**
 * Сечения по 24 станциям от пяты к острию: ширина, линия обуха (−X) и толщина — по ТРЕУГОЛЬНИКАМ
 * (пересечение рёбер с плоскостью), а не по вершинам: у низкополигональной модели длинный треугольник
 * пересекает полосу, не оставив в ней ни одной вершины, и замер по вершинам читал бы там нулевую ширину.
 */
function sections(P: Float32Array): Sections | null {
  const n = P.length / 3;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const y = P[i * 3 + 1]!; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const len = y1 - y0;
  if (!(len > 0)) return null;
  const N = BLADE_STATIONS;
  const prof: number[] = [], back: number[] = [];
  let thick = 0;
  const xs: number[] = [], zs: number[] = [];
  for (let s = 0; s < N; s++) {
    const yc = y1 - (len * (s + 0.5)) / N;
    xs.length = 0; zs.length = 0;
    for (let t = 0; t < n; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = (t + e) * 3, b = (t + ((e + 1) % 3)) * 3;
        const ya = P[a + 1]!, yb = P[b + 1]!;
        if ((ya - yc) * (yb - yc) > 0 || ya === yb) continue;
        const k = (yc - ya) / (yb - ya);
        xs.push(P[a]! + (P[b]! - P[a]!) * k);
        zs.push(P[a + 2]! + (P[b + 2]! - P[a + 2]!) * k);
      }
    }
    if (!xs.length) { prof.push(0); back.push(0); continue; }
    const xl = Math.min(...xs), xh = Math.max(...xs);
    prof.push(xh - xl);
    back.push(xl);
    thick = Math.max(thick, Math.max(...zs) - Math.min(...zs));
  }
  return { len, prof, back, thick };
}

const endMean = (prof: number[], from: number, to: number): number => {
  const a = prof.slice(from, to);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
};

/**
 * ⭐ ЗАМЕР. `orient` — модель не по договору: разворачиваем по самой длинной оси, а какой конец пята,
 * решает ФОРМА (узкий конец — остриё), а не положение начала координат: при центре модели посередине
 * клинка догадка по началу координат — монетка, и перевёрнутый клинок молча менял бы блок на
 * кровотечение. `flip` — человек переставляет пяту и остриё сам, если форма обманула (тупоконечный клинок).
 */
export function measureBlade(obj: THREE.Object3D, opts: { orient?: boolean; flip?: boolean } = {}): BladeMeasure | null {
  const warn: string[] = [];
  const tri = worldTriangles(obj);
  if (tri.length < 9) return null;
  const f = pickFrame(tri, !!opts.orient, warn);
  let sign: 1 | -1 = 1;
  let sec = sections(toBladeFrame(tri, f, sign));
  if (!sec) return null;
  if (opts.orient && endMean(sec.prof, 0, 3) < 0.8 * endMean(sec.prof, 21, 24)) {
    sign = -1;
    sec = sections(toBladeFrame(tri, f, sign))!;
    warn.push('Пяту и остриё определил по форме: узкий конец — остриё.');
  }
  if (opts.flip) {
    sign = sign === 1 ? -1 : 1;
    sec = sections(toBladeFrame(tri, f, sign))!;
    warn.push('Пята и остриё переставлены вручную.');
  }
  const { len, prof, back, thick } = sec;
  const N = BLADE_STATIONS;

  // Центр площади силуэта: 0 — у пяты, 1 — у острия.
  let sum = 0, mom = 0;
  for (let s = 0; s < N; s++) { sum += prof[s]!; mom += prof[s]! * ((s + 0.5) / N); }
  const bal = sum > 0 ? mom / sum : 0.5;
  // Доли длины — через индексы станций: 6..20 ≈ 25–87 %, 8..15 ≈ 33–67 %, 16..20 ≈ 67–87 %.
  const width = median(prof.slice(6, 21));
  const flare = Math.max(...prof.slice(16, 21)) / Math.max(1e-6, median(prof.slice(8, 16)));
  // Изгиб спинки: снос линии обуха (−X) от хорды между станциями 1 и 20 (без пяты и острия).
  let sag = 0;
  const i0 = 1, i1 = 20;
  for (let s = i0; s <= i1; s++) {
    const u = (s - i0) / (i1 - i0);
    sag = Math.max(sag, Math.abs(back[s]! - (back[i0]! + (back[i1]! - back[i0]!) * u)));
  }
  if (prof.some((w) => w === 0)) warn.push('На части станций сечение пустое: клинок с разрывом или сетка не замкнута.');

  return {
    len: Math.round(len * 10) / 10,
    width: r2(width),
    bal: r3(bal),
    flare: r2(flare),
    spine: r2((100 * sag) / len),
    wMax: r2(Math.max(...prof)),
    thick: r2(thick),
    prof: prof.map(r2),
    tris: Math.round(tri.length / 9),
    warn,
  };
}

/** Замер → поле `geom` детали (то, что кладётся в `weapon-parts.json`). */
export function geomOf(m: BladeMeasure): { len: number; width: number; bal: number; flare: number; spine: number } {
  return { len: m.len, width: m.width, bal: m.bal, flare: m.flare, spine: m.spine };
}
