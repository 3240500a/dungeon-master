import * as THREE from 'three';
import {
  at, byAxis, extrudeXY, hash01, latheY, mesh, mirrorX, slotGroups, sphere,
  type MeshCtx, type V2,
} from './core.js';

/**
 * ЖЕЗЛ И ПОСОХ ИЗ ДЕТАЛЕЙ (docs/CRAFT_WEAPONS.md §18, визуал Ф1). Контракт — в `core.ts`.
 *
 * Ключевая деталь — ДЕРЕВО ствола/древка (`grip.wood`). У всех пяти пород одна семья и одни цвета
 * ступеней, поэтому породу видно только ФОРМОЙ:
 *   лещина — тонкий прямой прут, узлы-утолщения и светлые срезы сучков;
 *   тёрн   — коленчатый (зигзаг от узла к узлу), с наплывами и тёмными шипами к вершине;
 *   тис    — сплюснутый ствол, скрученный винтом; в двух желобках — красная жилка ядра;
 *   осмол  — толстый, бугристый, тёсаный, с тёмными сучками и глянцевыми потёками смолы;
 *   эбен   — точёный ровный стержень с резными поясками бусин и чёрными вставками у хвата.
 * Навершие (`strike.silhouette`) — свой силуэт у жезла и посоха; камень — материал фокуса (светится
 * стихией), металл навершия — материал оправы. Оправа (`bind.mount`) и пята (`head.heel`) — общие
 * для жезла и посоха, различаются масштабом.
 * Начало координат — хват: у жезла в комлевой трети, у посоха ≈ в метре под макушкой. Навершие
 * строится в СВОЕЙ системе «вверх = к рабочему концу» (группа повёрнута на π по Z), пята — от торца.
 * Ось детали — пропорция (крупнее/тоньше), ступень материала геометрию НЕ меняет.
 */

type V3 = [number, number, number];
type Mat = THREE.Material;

const TAU = Math.PI * 2;

/** Древко: где верх (−Y) и низ (+Y), радиус под оковку и изгиб оси. */
interface Shaft {
  top: number;
  bottom: number;
  /** Радиус под оковку на высоте y (с запасом на рёбра и наплывы). */
  r(y: number): number;
  /** Смещение оси по X на высоте y (коленчатый тёрн, кривой осмол). */
  x(y: number): number;
}

/** Где камень навершия — вокруг него строится клетка оправы. Координаты — в системе навершия. */
interface Anchor { cx: number; cy: number; cz: number; rx: number; ry: number }

interface HeadIn {
  g: THREE.Group;
  /** Радиус верха древка — от него растёт шейка навершия. */
  rs: number;
  /** Масштаб «жезловых» силуэтов (1 у жезла) и «посоховых» (1 у посоха), уже с осью детали. */
  kw: number;
  ks: number;
  gem: Mat;
  metal: Mat;
  wood: Mat;
  dark: Mat;
}

// ── Мелкие помощники ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** Детерминированный разброс 0…1 по индексу — шипы, капли, сучки стоят всегда одинаково. */
const rnd = (i: number, salt = 0): number => { const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return v - Math.floor(v); };
const gauss = (u: number, c: number, w: number): number => Math.exp(-(((u - c) / w) ** 2));
const sc = (pts: V3[], k: number): V3[] => pts.map(([x, y, z]) => [x * k, y * k, z * k] as V3);
/** Разброс ±2.5% по id детали: у двух вариантов с одинаковыми тегами и осью всё равно своя мерка. */
const jitter = (id: string): number => 1 + 0.05 * (hash01(id) - 0.5);

function ell(rx: number, ry: number, rz: number, mat: Mat, seg = 12): THREE.Mesh {
  const m = sphere(1, mat, seg);
  m.scale.set(rx, ry, rz);
  return m;
}

/** Кольцо в плоскости XY (лёгкое: мало сегментов). */
function ring(R: number, r: number, mat: Mat, radial = 5, tub = 16): THREE.Mesh {
  return mesh(new THREE.TorusGeometry(R, r, radial, tub), mat);
}

/** Гранёная поверхность: плоские нормали (камень, призма, четырёхгранное копьецо). */
function flat<T extends THREE.Mesh>(m: T): T {
  const g = m.geometry.toNonIndexed();
  m.geometry.dispose();
  g.computeVertexNormals();
  m.geometry = g;
  return m;
}

/** Палочка/шип от точки p по направлению dir: радиус r0 у основания, r1 на конце. */
function stick(p: THREE.Vector3, dir: THREE.Vector3, r0: number, r1: number, len: number, mat: Mat, seg = 6, open = false): THREE.Mesh {
  const m = mesh(new THREE.CylinderGeometry(r1, r0, len, seg, 1, open), mat);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  m.position.copy(p).addScaledVector(dir, len / 2);
  return m;
}

/**
 * Закрыть верх профиля тела вращения плоской крышкой: открытая чашка/шейка иначе светит изнанкой
 * (с материалом FrontSide — сквозная дыра между оправой и камнем).
 */
function shut(p: V2[]): V2[] {
  const last = p[p.length - 1]!;
  return [...p, [0.001, last[1]]];
}

/** Выборки параметра 0…1: равномерные + сгущение вокруг особенностей (узлы, наплывы). */
function tSamples(n: number, feats: number[], w: number, m = 2): number[] {
  const all: number[] = [];
  for (let i = 0; i <= n; i++) all.push(i / n);
  for (const f of feats) for (let k = -m; k <= m; k++) { const t = f + (k / m) * w; if (t > 0 && t < 1) all.push(t); }
  all.sort((a, b) => a - b);
  return all.filter((t, i) => i === 0 || t - all[i - 1]! > 1e-3);
}

/**
 * ТРУБКА ПЕРЕМЕННОГО СЕЧЕНИЯ вдоль сплайна: радиус r(t, угол) — сужение клыка и шипа, скрутка тиса,
 * узлы лещины, бугры осмола. Кадр переносится параллельно; угол 0 смотрит в +Z, пока кривая не
 * уходит вдоль Z. Шов без разрыва нормалей, торцы закрыты.
 */
function sweep(
  pts: V3[], radius: (t: number, a: number) => number, mat: Mat,
  opts: { segs?: number; ts?: number[]; radial?: number; caps?: boolean } = {},
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const radial = opts.radial ?? 8;
  const segs = opts.segs ?? 24;
  const ts = opts.ts ?? Array.from({ length: segs + 1 }, (_, i) => i / segs);
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  curve.getTangentAt(0, T);
  N.set(0, 0, 1);
  if (Math.abs(T.z) > 0.9) N.set(1, 0, 0);
  const pos: number[] = [];
  const centers: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  for (const t of ts) {
    curve.getPointAt(t, P);
    curve.getTangentAt(t, T);
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-8) { N.set(1, 0, 0).addScaledVector(T, -T.x); if (N.lengthSq() < 1e-8) N.set(0, 1, 0).addScaledVector(T, -T.y); }
    N.normalize();
    B.crossVectors(T, N);
    centers.push(P.clone());
    tangents.push(T.clone());
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU;
      const r = Math.max(0.004, radius(t, a));
      const c = Math.cos(a), s = Math.sin(a);
      pos.push(P.x + r * (c * N.x + s * B.x), P.y + r * (c * N.y + s * B.y), P.z + r * (c * N.z + s * B.z));
    }
  }
  const rows = ts.length;
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < radial; j++) {
    const j1 = (j + 1) % radial;
    const a = i * radial + j, b = (i + 1) * radial + j, c = (i + 1) * radial + j1, d = i * radial + j1;
    idx.push(a, d, b, b, d, c);
  }
  const v = (k: number): THREE.Vector3 => new THREE.Vector3(pos[k * 3]!, pos[k * 3 + 1]!, pos[k * 3 + 2]!);
  // Обход граней — наружу (проверка по среднему кольцу, чтобы не зависеть от знаков кадра).
  const mi = Math.floor((rows - 1) / 2);
  const va = v(mi * radial);
  const nrm = v(mi * radial + 1).sub(va).cross(v((mi + 1) * radial).sub(va));
  if (nrm.dot(va.clone().sub(centers[mi]!)) < 0) for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]!; idx[k + 1] = idx[k + 2]!; idx[k + 2] = t; }
  if (opts.caps !== false) {
    for (const end of [0, rows - 1]) {
      const base = pos.length / 3;
      const C = centers[end]!;
      pos.push(C.x, C.y, C.z);
      for (let j = 0; j < radial; j++) { const k = (end * radial + j) * 3; pos.push(pos[k]!, pos[k + 1]!, pos[k + 2]!); }
      const tri: number[] = [];
      for (let j = 0; j < radial; j++) tri.push(base, base + 1 + j, base + 1 + ((j + 1) % radial));
      const want = end === 0 ? tangents[0]!.clone().negate() : tangents[rows - 1]!.clone();
      const n = v(base + 1).sub(v(base)).cross(v(base + 2).sub(v(base)));
      if (n.dot(want) < 0) for (let k = 0; k < tri.length; k += 3) { const t = tri[k + 1]!; tri[k + 1] = tri[k + 2]!; tri[k + 2] = t; }
      idx.push(...tri);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

/** Смещение по X вдоль сплайна оси — чтобы оковка садилась на коленчатый тёрн. */
function lookupX(pts: V3[], Y: (u: number) => number): (u: number) => number {
  const c = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const n = 96, ys: number[] = [], xs: number[] = [];
  for (let i = 0; i <= n; i++) { const p = c.getPoint(i / n); ys.push(p.y); xs.push(p.x); }
  return (u) => {
    const y = Y(u);
    let i = 0;
    while (i < n - 1 && ys[i + 1]! < y) i++;
    const y0 = ys[i]!, y1 = ys[i + 1]!;
    const f = y1 > y0 ? clamp01((y - y0) / (y1 - y0)) : 0;
    return xs[i]! + (xs[i + 1]! - xs[i]!) * f;
  };
}

/** Крест из профиля (держава, двузмий): стойка от y0 до y1, перекладина на высоте yc. */
function crossOutline(y0: number, y1: number, yc: number, w: number, hw: number): V2[] {
  return [
    [-w, y0], [w, y0], [w, yc - w], [hw, yc - w], [hw, yc + w], [w, yc + w],
    [w, y1], [-w, y1], [-w, yc + w], [-hw, yc + w], [-hw, yc - w], [-w, yc - w],
  ];
}

// ── СТВОЛ / ДРЕВКО (ключевая деталь: порода) ─────────────────────────────────────────────────────

/** Длина жезла и посоха, радиус у вершины (rt) и у комля (rb) в «жезловых» сантиметрах. */
const WOODS: Record<string, { wand: number; staff: number; rt: number; rb: number }> = {
  hazel: { wand: 32, staff: 150, rt: 0.36, rb: 0.56 },
  thorn: { wand: 30, staff: 146, rt: 0.42, rb: 0.62 },
  yew: { wand: 31, staff: 150, rt: 0.42, rb: 0.58 },
  pitch: { wand: 29, staff: 146, rt: 0.54, rb: 0.74 },
  ebony: { wand: 31, staff: 148, rt: 0.45, rb: 0.5 },
};

function buildShaft(ctx: MeshCtx, staff: boolean, out: THREE.Group): Shaft {
  const part = ctx.parts.grip;
  const kind = part.tags.wood ?? '';
  const hv = hash01(part.id);
  const W = WOODS[kind] ?? { wand: 32 + 5 * hv, staff: 142 + 14 * hv, rt: 0.42, rb: 0.6 };
  const k = staff ? 2.6 : 1;
  const len = staff ? W.staff : W.wand;
  // Хват: у посоха верх древка в 76 см над рукой (с навершием — около метра), у жезла рука в комлевой трети.
  const top = staff ? -76 : -Math.round(len * 6.8) / 10;
  const bottom = top + len;
  const rt = W.rt * k, rb = W.rb * k;
  const base = (u: number): number => rt + (rb - rt) * clamp01(u);
  const Y = (u: number): number => top + u * len;
  const U = (y: number): number => clamp01((y - top) / len);
  const wood = ctx.mat('grip');
  let xOf: (u: number) => number = () => 0;
  let swell: (u: number) => number = () => 0;
  let fit = 1.04;
  const line = (f: (u: number) => number, n: number): V3[] => Array.from({ length: n + 1 }, (_, i) => [f(i / n), Y(i / n), 0] as V3);

  switch (kind) {
    case 'hazel': {
      // Лещина: самый тонкий прямой прут; частые узлы-утолщения в светлых поясках коры,
      // срезанные сучки поочерёдно на две стороны (очерёдное ветвление) — светлый срез.
      const nodes = staff ? [0.12, 0.27, 0.42, 0.58, 0.73, 0.88] : [0.18, 0.4, 0.62, 0.86];
      const w = staff ? 0.011 : 0.02;
      swell = (u) => nodes.reduce((a, n) => a + 0.28 * gauss(u, n, w), 0);
      xOf = (u) => 0.1 * k * Math.sin(Math.PI * u);
      out.add(sweep(line(xOf, 8), (t) => base(t) * (1 + swell(t)), wood, { ts: tSamples(staff ? 28 : 18, nodes, w * 2.2), radial: 8 }));
      const bark = ctx.fixed(0xd2bb90, 0, 0.8);
      nodes.forEach((n, i) => {
        const R = base(n);
        out.add(at(ring(R * 1.22, R * 0.19, bark, 3, 10), xOf(n), Y(n) + w * len * 0.9, 0, Math.PI / 2));
        const phi = 0.4 + (i % 2) * Math.PI + i * 0.35;
        const dir = new THREE.Vector3(Math.cos(phi) * 0.78, -0.62, Math.sin(phi) * 0.78).normalize();
        const p = new THREE.Vector3(xOf(n) + Math.cos(phi) * R * 0.6, Y(n), Math.sin(phi) * R * 0.6);
        const L = staff ? 3.8 : 1.25;
        out.add(stick(p, dir, R * 0.55, R * 0.45, L, wood, 6, true));
        const cut = mesh(new THREE.CircleGeometry(R * 0.45, 6), bark);
        cut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        cut.position.copy(p).addScaledVector(dir, L + 0.01);
        out.add(cut);
      });
      break;
    }
    case 'thorn': {
      // Тёрн: коленчатый — ось ломается в каждом узле, наплывы на узлах, шипы смотрят к вершине.
      const nN = staff ? 7 : 4;
      const nodes = Array.from({ length: nN }, (_, i) => (i + 1) / (nN + 1));
      const A = 0.36 * k;
      const pts: V3[] = [[0, top, 0], ...nodes.map((u, i) => [(i % 2 ? -A : A) * Math.sqrt(Math.sin(Math.PI * u)), Y(u), 0] as V3), [0, bottom, 0]];
      xOf = lookupX(pts, Y);
      const w = staff ? 0.012 : 0.022;
      swell = (u) => nodes.reduce((a, n) => a + 0.24 * gauss(u, n, w), 0);
      out.add(sweep(pts, (t, a) => base(t) * (1 + swell(t) + 0.05 * Math.sin(3 * a + 40 * t)), wood, { ts: tSamples(staff ? 28 : 18, nodes, w * 2.2), radial: 8 }));
      // Шипы — главный признак тёрна: крупные и не чёрные, иначе на тёмном фоне превью их не видно.
      const spike = ctx.fixed(0x4a382a, 0, 0.55);
      const cnt = staff ? 16 : 9;
      for (let i = 0; i < cnt; i++) {
        const u = 0.05 + (0.9 * (i + 0.3 + 0.4 * rnd(i, 1))) / cnt;
        const phi = i * 2.39996 + 0.4;
        const L = (staff ? 4.4 : 1.35) * (0.7 + 0.3 * rnd(i, 2));
        const R = base(u) * (1 + swell(u)) * 0.85;
        const dir = new THREE.Vector3(Math.cos(phi) * 0.82, -0.57, Math.sin(phi) * 0.82).normalize();
        out.add(stick(new THREE.Vector3(xOf(u) + Math.cos(phi) * R, Y(u), Math.sin(phi) * R), dir, L * 0.2, 0.002, L, spike, 5, true));
      }
      fit = 1.08;
      break;
    }
    case 'yew': {
      // Тис: сплюснутый ствол, скрученный винтом (силуэт «дышит» то толще, то тоньше), в двух
      // желобках — красная жилка ядра.
      const turns = staff ? 5 : 2;
      out.add(sweep(line(xOf, 1), (t, a) => base(t) * (1 + 0.2 * Math.cos(2 * (a - turns * TAU * t))), wood, { segs: staff ? 44 : 26, radial: 10 }));
      const red = ctx.fixed(0x9a3a1e, 0, 0.45);
      const n = Math.ceil(turns * 10);
      for (const off of [Math.PI / 2, (3 * Math.PI) / 2]) {
        const vein: V3[] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n, a = off + turns * TAU * t, R = base(t) * 0.84;
          vein.push([R * Math.sin(a), Y(t), R * Math.cos(a)]);
        }
        out.add(sweep(vein, (t) => base(t) * 0.31, red, { segs: staff ? 36 : 18, radial: 4 }));
      }
      fit = 1.2;
      break;
    }
    case 'pitch': {
      // Осмол: толстый, кривоватый, бугристый; тёмные сучки и глянцевые потёки смолы к комлю.
      xOf = (u) => 0.14 * k * Math.sin(Math.PI * u) * Math.sin(3 * Math.PI * u);
      const lumps = staff ? [0.12, 0.37, 0.6, 0.86] : [0.22, 0.83];
      const w = staff ? 0.02 : 0.035;
      swell = (u) => lumps.reduce((a, n) => a + 0.12 * gauss(u, n, w), 0);
      out.add(sweep(line(xOf, 10),
        (t, a) => base(t) * (1 + swell(t) + 0.07 * Math.sin(2 * a + 11 * t) + 0.05 * Math.sin(5 * a - 23 * t + 1.7)),
        wood, { ts: tSamples(staff ? 30 : 20, lumps, w * 2), radial: 9 }));
      const knot = ctx.fixed(0x2a1a0e, 0, 0.55);
      lumps.forEach((n, i) => {
        const phi = 1.1 + i * 2.2, R = base(n) * 0.95;
        out.add(at(ell(R * 0.72, R * 1.1, R * 0.72, knot, 7), xOf(n) + Math.cos(phi) * R, Y(n), Math.sin(phi) * R));
      });
      const resin = ctx.fixed(0x6e3f0c, 0.15, 0.12);
      const drips = staff ? 6 : 3;
      for (let i = 0; i < drips; i++) {
        const u = 0.08 + (0.84 * (i + 0.5)) / drips, phi = 0.3 + i * 2.7;
        const L = (staff ? 6.5 : 2.0) * (0.7 + 0.3 * rnd(i, 3)), rd = staff ? 0.62 : 0.2;
        const R = base(u) * 0.97;
        // Капля: тонкий потёк сверху, тяжёлая бусина снизу (к комлю).
        const drop: V2[] = [[0.001, 0], [rd * 0.5, 0.12 * L], [rd * 0.6, 0.6 * L], [rd * 1.05, 0.86 * L], [rd * 1.2, L], [rd * 0.85, L + 0.7 * rd], [0.001, L + rd]];
        out.add(at(latheY(drop, resin, 6), xOf(u) + Math.cos(phi) * (R + rd * 0.25), Y(u), Math.sin(phi) * (R + rd * 0.25)));
      }
      fit = 1.1;
      break;
    }
    case 'ebony': {
      // Эбен: точёный ровный стержень без сучка, резные пояски по три бусины по всей длине,
      // чёрные лакированные вставки над и под хватом.
      const groups = staff ? [0.04, 0.2, 0.37, 0.66, 0.79, 0.9] : [0.06, 0.26, 0.46, 0.87];
      const hb = staff ? 0.7 : 0.22;
      const prof: V2[] = [[0.001, top], [base(0) * 0.8, top], [base(0), top + hb]];
      for (const gu of groups) {
        const yc = Y(gu), R = base(gu);
        prof.push([R, yc - 4.6 * hb]);
        for (let j = -1; j <= 1; j++) {
          const y = yc + j * 2.4 * hb;
          prof.push([R * 0.92, y - 1.2 * hb], [R * 1.22, y - 0.45 * hb], [R * 1.22, y + 0.45 * hb]);
        }
        prof.push([R * 0.92, yc + 3.6 * hb], [R, yc + 4.6 * hb]);
      }
      prof.push([base(1), bottom - hb], [base(1) * 0.8, bottom], [0.001, bottom]);
      out.add(latheY(prof, wood, 9));
      // Чёрные вставки обрамляют кулак (≈ ±4.5 см у жезла, ±11 см у посоха), а не лежат под пальцами.
      const lacquer = ctx.fixed(0x0e0c0c, 0.3, 0.18);
      for (const y of staff ? [-11, 11] : [-4.4, 4.4]) out.add(at(ring(base(U(y)) * 1.02, base(U(y)) * 0.16, lacquer, 4, 12), 0, y, 0, Math.PI / 2));
      fit = 1.02;
      break;
    }
    default:
      out.add(sweep(line(xOf, 1), (t) => base(t), wood, { segs: 12, radial: 10 }));
  }
  return { top, bottom, r: (y) => base(U(y)) * (fit + swell(U(y))), x: (y) => xOf(U(y)) };
}

// ── НАВЕРШИЕ: жезловые силуэты (единица — сантиметр жезла, kw) ───────────────────────────────────

/** Шейка-втулка от древка к чаше навершия (профиль снизу вверх в системе навершия). */
function neckProfile(rs: number, k: number, rest: V2[]): V2[] {
  return shut([[rs * 1.08, -0.9 * k], [rs * 1.25, -0.3 * k], [rs * 1.1, 0.3 * k], ...rest]);
}

/** Держава: шар на чашечке, придержан четырьмя лапками. */
function wandOrb(o: HeadIn): Anchor {
  const k = o.kw, R = 1.85 * k;
  o.g.add(latheY(neckProfile(o.rs, k, [[0.45 * R, 0.9 * k], [0.8 * R, 1.5 * k], [0.98 * R, 1.95 * k], [0.9 * R, 2.1 * k]]), o.metal, 16));
  const cy = 2.0 * k + 0.62 * R;
  o.g.add(at(sphere(R, o.gem, 16), 0, cy));
  const Rc = R + 0.05 * k;
  for (let i = 0; i < 4; i++) {
    const phi = (i + 0.5) * (TAU / 4);
    const pts = [-0.62, -0.3, 0, 0.3].map((psi) => [Math.cos(phi) * Rc * Math.cos(psi), cy + Rc * Math.sin(psi), Math.sin(phi) * Rc * Math.cos(psi)] as V3);
    o.g.add(sweep(pts, (t) => (0.17 - 0.08 * t) * k, o.metal, { segs: 8, radial: 5 }));
  }
  return { cx: 0, cy, cz: 0, rx: R, ry: R };
}

/** Длань («main de justice»): манжета, ладонь к зрителю, веер из четырёх пальцев и отставленный большой; камень — в ладони. */
function wandHand(o: HeadIn): Anchor {
  const k = o.kw;
  o.g.add(latheY(neckProfile(o.rs, k, [[0.75 * k, 0.55 * k], [0.95 * k, 1.1 * k], [0.88 * k, 1.35 * k], [0.7 * k, 1.5 * k]]), o.metal, 14));
  o.g.add(at(ell(1.15 * k, 1.3 * k, 0.45 * k, o.metal, 12), 0, 2.65 * k, 0));
  const fb = [-0.8, -0.27, 0.27, 0.8], ft = [-1.35, -0.45, 0.45, 1.25], fl = [2.0, 2.45, 2.55, 2.25];
  fb.forEach((b, i) => {
    const t = ft[i]!, L = fl[i]!;
    const pts: V3[] = [[b, 3.4, 0], [b + (t - b) * 0.45, 3.4 + 0.5 * L, 0.05], [b + (t - b) * 0.8, 3.4 + 0.85 * L, 0.2], [t, 3.4 + L, 0.55]];
    o.g.add(sweep(sc(pts, k), (u) => (0.3 - 0.08 * u) * k, o.metal, { segs: 9, radial: 6 }));
  });
  o.g.add(sweep(sc([[1.0, 2.2, 0.15], [1.7, 2.6, 0.35], [2.1, 3.3, 0.55], [2.2, 3.9, 0.75]], k), (u) => (0.32 - 0.08 * u) * k, o.metal, { segs: 9, radial: 6 }));
  o.g.add(at(sphere(0.95 * k, o.gem, 12), 0, 2.85 * k, 0.75 * k));
  return { cx: 0.2 * k, cy: 3.6 * k, cz: 0.3 * k, rx: 2.2 * k, ry: 2.6 * k };
}

/** Гранёный камень: огранка «бриллиант» (восемь граней) в короне из шести лапок. */
function wandFaceted(o: HeadIn): Anchor {
  const k = o.kw, G = 1.7 * k;
  o.g.add(latheY(neckProfile(o.rs, k, [[0.55 * G, 0.9 * k], [0.62 * G, 1.1 * k]]), o.metal, 12));
  const y0 = 0.7 * k, yg = y0 + 0.95 * G, yc = yg + 0.14 * G, yt = yc + 0.42 * G;
  o.g.add(flat(latheY([[0.02, y0], [G, yg], [G, yc], [0.62 * G, yt], [0.001, yt]], o.gem, 8)));
  for (let i = 0; i < 6; i++) {
    const phi = (i / 6) * TAU, c = Math.cos(phi), s = Math.sin(phi);
    const pts: V3[] = [[0.55 * G * c, 1.0 * k, 0.55 * G * s], [(G + 0.1 * k) * c, yg - 0.1 * k, (G + 0.1 * k) * s], [(G + 0.08 * k) * c, yc + 0.05 * k, (G + 0.08 * k) * s], [0.85 * G * c, yc + 0.2 * G, 0.85 * G * s]];
    o.g.add(sweep(pts, () => 0.1 * k, o.metal, { segs: 8, radial: 4 }));
  }
  return { cx: 0, cy: (y0 + yt) / 2, cz: 0, rx: G, ry: (yt - y0) / 2 + 0.2 * k };
}

/**
 * Кабошон: гладкий высокий купол без граней в глухом гнезде-барабане (прямая стенка, витой поясок
 * по краю). Не «грибок»: гнездо уже камня не расходится тарелкой, купол — выше половины ширины.
 */
function wandCabochon(o: HeadIn): Anchor {
  const k = o.kw, B = 1.6 * k;
  o.g.add(latheY(neckProfile(o.rs, k, [[0.62 * B, 0.95 * k], [0.9 * B, 1.2 * k], [1.0 * B, 1.3 * k], [1.0 * B, 2.3 * k], [0.95 * B, 2.35 * k]]), o.metal, 18));
  const yb = 2.05 * k, Hd = 1.45 * k;
  const dome: V2[] = [[0.001, yb], [0.95 * B, yb]];
  for (let i = 1; i <= 7; i++) { const th = (i / 7) * (Math.PI / 2); dome.push([Math.max(0.001, 0.95 * B * Math.cos(th)), yb + Hd * Math.sin(th)]); }
  o.g.add(latheY(dome, o.gem, 18));
  o.g.add(at(ring(1.02 * B, 0.13 * k, o.metal, 4, 22), 0, 2.3 * k, 0, Math.PI / 2));
  o.g.add(at(ring(1.02 * B, 0.1 * k, o.metal, 4, 22), 0, 1.35 * k, 0, Math.PI / 2));
  return { cx: 0, cy: yb + Hd * 0.3, cz: 0, rx: B, ry: Hd };
}

/** Призма: длинный шестигранный кристалл с острой головкой, у основания обмотан проволокой. */
function wandPrism(o: HeadIn): Anchor {
  const k = o.kw, P = 0.7 * k, Lp = 6.0 * k, Lt = 1.6 * k;
  o.g.add(flat(latheY(neckProfile(o.rs, k, [[P * 1.15, 0.9 * k], [P * 1.32, 1.3 * k], [P * 1.12, 1.5 * k]]), o.metal, 6)));
  const y0 = 1.0 * k;
  o.g.add(flat(latheY([[0.02, y0 - 0.1 * k], [P, y0], [P, y0 + Lp], [0.001, y0 + Lp + Lt]], o.gem, 6)));
  const wrap: V3[] = [];
  for (let i = 0; i <= 20; i++) { const a = (i / 20) * TAU * 2, y = y0 + 0.6 * k + (i / 20) * 1.6 * k; wrap.push([Math.sin(a) * P * 1.02, y, Math.cos(a) * P * 1.02]); }
  o.g.add(sweep(wrap, () => 0.07 * k, o.metal, { segs: 40, radial: 4 }));
  return { cx: 0, cy: y0 + (Lp + Lt) / 2, cz: 0, rx: P * 1.4, ry: (Lp + Lt) / 2 + 0.2 * k };
}

/** Клык: изогнутый сплюснутый зуб из камня фокуса в оправе-манжете. */
function wandFang(o: HeadIn): Anchor {
  const k = o.kw;
  o.g.add(latheY(neckProfile(o.rs, k, [[0.95 * k, 0.8 * k], [1.1 * k, 1.15 * k], [1.0 * k, 1.35 * k]]), o.metal, 14));
  const pts = sc([[0, 0.9, 0], [0.12, 2.6, 0], [0.65, 4.6, 0], [1.7, 6.4, 0], [3.0, 7.5, 0]], k);
  o.g.add(sweep(pts, (t, a) => (1.0 * k * (1 - t) ** 0.85 + 0.03 * k) * (1 - 0.3 * Math.cos(a) ** 2), o.gem, { segs: 20, radial: 10 }));
  o.g.add(at(ring(1.02 * k, 0.12 * k, o.metal, 5, 16), 0, 1.25 * k, 0, Math.PI / 2));
  return { cx: 1.0 * k, cy: 4.2 * k, cz: 0, rx: 2.0 * k, ry: 3.8 * k };
}

/** Рогулька: развилка из дерева ствола, между рожками на проволоке — камень. */
function forkHead(o: HeadIn): Anchor {
  const k = o.kw;
  const r0 = o.rs * 0.78, r1 = 0.1 * k;
  for (const sx of [1, -1]) {
    const pts = sc([[0, -0.4, 0], [0.3 * sx, 1.0, 0], [1.35 * sx, 2.8, 0], [1.85 * sx, 4.6, 0], [1.45 * sx, 6.1, 0]], k);
    o.g.add(sweep(pts, (t) => r0 * (1 - t) + r1 * t, o.wood, { segs: 18, radial: 8 }));
  }
  o.g.add(at(ring(o.rs * 1.2, o.rs * 0.22, o.metal, 5, 16), 0, 0.35 * k, 0, Math.PI / 2));
  const gy = 2.9 * k, gr = 0.85 * k;
  o.g.add(at(sphere(gr, o.gem, 12), 0, gy));
  o.g.add(at(mesh(new THREE.CylinderGeometry(0.06 * k, 0.06 * k, 2.7 * k, 5), o.metal), 0, gy, 0, 0, 0, Math.PI / 2));
  return { cx: 0, cy: gy, cz: 0, rx: gr * 1.1, ry: gr * 1.1 };
}

// ── НАВЕРШИЕ: посоховые силуэты (единица — сантиметр посоха, ks) ─────────────────────────────────

/** Балясина-шейка посоха: от древка, через яблоко, к `rest`. */
function staffNeck(rs: number, k: number, rest: V2[]): V2[] {
  return shut([[rs * 1.08, -3 * k], [rs * 1.25, -2 * k], [rs * 1.12, -0.5 * k], [rs * 1.1, 0], [2.3 * k, 1.1 * k], [2.6 * k, 1.9 * k], [1.6 * k, 2.8 * k], ...rest]);
}

/** Держава (ферула): шар с поясом и полудугой, над ним — крест. */
function staffOrb(o: HeadIn): Anchor {
  const k = o.ks, R = 5.4 * k;
  o.g.add(latheY(staffNeck(o.rs, k, [[1.4 * k, 3.3 * k], [2.0 * k, 3.9 * k], [0.62 * R, 4.5 * k], [0.7 * R, 4.8 * k]]), o.metal, 16));
  const cy = 4.3 * k + 0.82 * R;
  o.g.add(at(sphere(R, o.gem, 16), 0, cy));
  o.g.add(at(ring(R * 1.01, 0.3 * k, o.metal, 5, 24), 0, cy, 0, Math.PI / 2));
  o.g.add(at(mesh(new THREE.TorusGeometry(R * 1.01, 0.3 * k, 5, 14, Math.PI), o.metal), 0, cy, 0, 0, Math.PI / 2));
  // Заклёпки на стыке полудуги с поясом — заодно закрывают открытые торцы трубки полудуги.
  for (const sz of [1, -1]) o.g.add(at(sphere(0.5 * k, o.metal, 8), 0, cy, sz * R * 1.01));
  const y0 = cy + R - 0.4 * k, y1 = cy + R + 7.5 * k;
  o.g.add(extrudeXY(crossOutline(y0, y1, cy + R + 5 * k, 0.55 * k, 2.5 * k), 1.0 * k, o.metal));
  o.g.add(at(sphere(0.9 * k, o.metal, 10), 0, cy + R + 0.2 * k));
  return { cx: 0, cy, cz: 0, rx: R, ry: R };
}

/**
 * Двузмий (архиерейский жезл): над яблоком — «якорь» из двух змей, тела дугой наружу и вверх,
 * головы повёрнуты друг к другу и смотрят на камень на средней стойке; над камнем — крест.
 */
function staffSerpents(o: HeadIn): Anchor {
  const k = o.ks;
  o.g.add(latheY(staffNeck(o.rs, k, [[1.5 * k, 3.4 * k], [1.9 * k, 4.0 * k], [1.4 * k, 4.8 * k], [0.6 * k, 5.2 * k]]), o.metal, 12));
  const pts = sc([[0, 4.2, 0], [2.4, 4.5, 0], [5.8, 5.8, 0], [8.6, 8.4, 0], [9.7, 11.7, 0], [9.0, 14.3, 0], [7.4, 15.5, 0], [5.6, 15.6, 0]], k);
  const snake = new THREE.Group();
  snake.add(sweep(pts, (t) => k * (0.55 + 0.5 * Math.sin(Math.PI * (0.15 + 0.7 * t))), o.metal, { segs: 22, radial: 7 }));
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const pe = curve.getPointAt(1), te = curve.getTangentAt(1);
  const hp = pe.clone().addScaledVector(te, 1.2 * k);
  snake.add(at(ell(1.9 * k, 1.0 * k, 1.2 * k, o.metal, 8), hp.x, hp.y, 0, 0, 0, Math.atan2(te.y, te.x)));
  for (const z of [0.85, -0.85]) snake.add(at(mesh(new THREE.SphereGeometry(0.34 * k, 5, 3), o.gem), hp.x + te.x * 0.5 * k, hp.y + 0.45 * k, z * k));
  o.g.add(snake, mirrorX(snake));
  const gy = 15.6 * k, gr = 1.7 * k;
  o.g.add(at(mesh(new THREE.CylinderGeometry(0.5 * k, 0.6 * k, gy - 4.5 * k, 8, 1, true), o.metal), 0, (gy + 4.5 * k) / 2));
  o.g.add(at(sphere(gr, o.gem, 12), 0, gy));
  o.g.add(extrudeXY(crossOutline(gy + gr - 0.3 * k, gy + gr + 5.6 * k, gy + gr + 3.8 * k, 0.45 * k, 1.8 * k), 0.8 * k, o.metal));
  return { cx: 0, cy: gy, cz: 0, rx: gr, ry: gr };
}

/** Тау (кроция): стойка и перекладина с опущенными концами-шарами, в перекрестье — камень в кольце. */
function staffTau(o: HeadIn): Anchor {
  const k = o.ks;
  o.g.add(latheY(staffNeck(o.rs, k, [[1.15 * k, 3.3 * k], [1.1 * k, 8.8 * k], [1.5 * k, 9.9 * k], [1.9 * k, 10.8 * k]]), o.metal, 14));
  const bar = sc([[-10.2, 8.0, 0], [-11.0, 10.4, 0], [-9.2, 12.3, 0], [-4.6, 13.0, 0], [0, 13.1, 0], [4.6, 13.0, 0], [9.2, 12.3, 0], [11.0, 10.4, 0], [10.2, 8.0, 0]], k);
  o.g.add(sweep(bar, (t) => k * (0.75 + 0.55 * Math.sin(Math.PI * t)), o.metal, { segs: 26, radial: 7 }));
  for (const sx of [1, -1]) o.g.add(at(sphere(1.1 * k, o.metal, 8), sx * 10.2 * k, 7.8 * k));
  const gy = 13.1 * k, gr = 2.1 * k;
  o.g.add(at(sphere(gr, o.gem, 12), 0, gy));
  o.g.add(at(ring(gr * 1.1, 0.34 * k, o.metal, 5, 20), 0, gy));
  o.g.add(at(sphere(0.8 * k, o.metal, 10), 0, gy + gr + 0.5 * k));
  return { cx: 0, cy: gy, cz: 0, rx: gr, ry: gr };
}

/** Крюк (педум, литуус, крозье): стебель уходит в сходящуюся спираль с «почками», в глазке — камень. */
function staffCrook(o: HeadIn): Anchor {
  const k = o.ks;
  o.g.add(latheY(staffNeck(o.rs, k, [[1.25 * k, 3.3 * k], [1.1 * k, 3.6 * k]]), o.metal, 14));
  // Завиток крупнее «вопросика»: у крозье и литууса он в ширину почти с треть высоты навершия.
  const R0 = 6.0, cx = R0, cy = 17.6, turns = 1.05, rEnd = 3.0;
  const spiral = (p: number): [number, number, number] => {
    const th = Math.PI - TAU * turns * p, r = R0 - (R0 - rEnd) * p;
    return [cx + r * Math.cos(th), cy + r * Math.sin(th), th];
  };
  const pts: V3[] = [[0, 2.4, 0], [0, 7, 0], [0, 12, 0]];
  for (let i = 0; i <= 16; i++) { const [x, y] = spiral(i / 16); pts.push([x, y, 0]); }
  o.g.add(sweep(sc(pts, k), (t) => k * (1.05 - 0.4 * t), o.metal, { segs: 34, radial: 7 }));
  for (const p of [0.12, 0.26, 0.4, 0.54, 0.68]) {
    const [, , th] = spiral(p), r = R0 - (R0 - rEnd) * p + 0.9;
    o.g.add(at(sphere(0.55 * k, o.metal, 6), (cx + r * Math.cos(th)) * k, (cy + r * Math.sin(th)) * k));
  }
  const [ex, ey] = spiral(1);
  o.g.add(at(sphere(0.75 * k, o.metal, 8), ex * k, ey * k));
  const gr = 1.8 * k;
  o.g.add(at(sphere(gr, o.gem, 12), cx * k, cy * k));
  return { cx: cx * k, cy: cy * k, cz: 0, rx: gr, ry: gr };
}

/** Череп (фэнтези): свод, лицевая часть, скулы, нижняя челюсть; глазницы и нос — тёмные провалы. */
function staffSkull(o: HeadIn): Anchor {
  const k = o.ks, S = 6.6 * k;
  // Два позвонка; верхний уходит в основание черепа (без щели между шеей и сводом).
  o.g.add(latheY(staffNeck(o.rs, k, [[1.2 * k, 3.0 * k], [1.6 * k, 3.2 * k], [1.7 * k, 3.6 * k], [1.2 * k, 3.9 * k], [1.6 * k, 4.2 * k], [1.7 * k, 4.6 * k], [1.0 * k, 5.0 * k], [0.9 * k, 7.4 * k]]), o.gem, 12));
  const C = 5.2 * k + 1.02 * S;
  const e = (rx: number, ry: number, rz: number, x: number, y: number, z: number, m: Mat, seg = 12): void => {
    o.g.add(at(ell(rx * S, ry * S, rz * S, m, seg), x * S, C + y * S, z * S));
  };
  e(0.86, 0.9, 1.0, 0, 0.12, -0.08, o.gem, 16);
  e(0.6, 0.46, 0.55, 0, -0.42, 0.4, o.gem, 12);
  for (const sx of [1, -1]) {
    e(0.24, 0.18, 0.3, sx * 0.5, -0.26, 0.5, o.gem, 8);
    e(0.23, 0.21, 0.14, sx * 0.33, -0.1, 0.8, o.dark, 8);
  }
  e(0.09, 0.15, 0.08, 0, -0.36, 0.93, o.dark, 6);
  e(0.36, 0.045, 0.12, 0, -0.72, 0.86, o.dark, 8);
  const jaw: V3[] = [[-0.52, -0.62, 0.05], [-0.46, -0.86, 0.5], [0, -0.95, 0.84], [0.46, -0.86, 0.5], [0.52, -0.62, 0.05]];
  o.g.add(sweep(jaw.map(([x, y, z]) => [x * S, C + y * S, z * S] as V3), () => 0.12 * S, o.gem, { segs: 16, radial: 6 }));
  return { cx: 0, cy: C, cz: 0.1 * S, rx: 0.95 * S, ry: 1.1 * S };
}

function buildFocus(ctx: MeshCtx, staff: boolean, sh: Shaft, out: THREE.Group): Anchor {
  const p = ctx.parts.strike;
  const kind = p.tags.silhouette ?? '';
  const s = byAxis(p.axis, 0.85, 1.15) * jitter(p.id);
  const g = at(new THREE.Group(), sh.x(sh.top), sh.top, 0, 0, 0, Math.PI);
  out.add(g);
  const o: HeadIn = {
    g, rs: sh.r(sh.top), kw: s * (staff ? 3.8 : 1), ks: s * (staff ? 1 : 0.27),
    gem: ctx.mat('strike'),
    metal: ctx.matOf(ctx.parts.bind.family || 'trim', ctx.parts.bind.step),
    wood: ctx.mat('grip'),
    dark: ctx.fixed(0x0b0909, 0, 0.9),
  };
  switch (kind) {
    case 'orb': return staff ? staffOrb(o) : wandOrb(o);
    case 'hand': return wandHand(o);
    case 'faceted': return wandFaceted(o);
    case 'cabochon': return wandCabochon(o);
    case 'prism': return wandPrism(o);
    case 'fang': return wandFang(o);
    case 'fork': return forkHead(o);
    case 'serpents': return staffSerpents(o);
    case 'tau': return staffTau(o);
    case 'crook': return staffCrook(o);
    case 'skull': return staffSkull(o);
    default: return staff ? staffOrb(o) : wandOrb(o);
  }
}

// ── ОПРАВА / ОКОВКА (общая: «яблоки», клетка, кольца, обоймицы, филигрань) ───────────────────────

function buildMount(ctx: MeshCtx, staff: boolean, sh: Shaft, anc: Anchor, out: THREE.Group): void {
  const p = ctx.parts.bind;
  const kind = p.tags.mount ?? '';
  const s = byAxis(p.axis, 0.9, 1.1) * jitter(p.id);
  const m = ctx.mat('bind');
  const q = staff ? 1 : 0.27; // единица длины: сантиметр посоха → жезла
  const R = sh.r, X = sh.x;
  /** Кольцо-обруч на древке на высоте y. */
  const band = (y: number, grow: number, tube: number, tub = 14): void => {
    out.add(at(ring(R(y) * grow + tube * 0.7, tube, m, 4, tub), X(y), y, 0, Math.PI / 2));
  };

  switch (kind) {
    case 'apples': {
      // «Яблоки»: три сплющенных шара столбиком под навершием и одно над хватом.
      const put = (y: number, size: number): void => {
        const r = R(y), kr = r * size * s, h = kr * 0.85;
        out.add(at(latheY([[r * 1.02, -h * 1.3], [r * 1.18, -h * 1.12], [kr * 0.72, -h * 0.78], [kr * 0.97, -h * 0.32], [kr, 0], [kr * 0.97, h * 0.32], [kr * 0.72, h * 0.78], [r * 1.18, h * 1.12], [r * 1.02, h * 1.3]], m, 12), X(y), y));
      };
      [2.0, 1.75, 1.55].forEach((size, i) => put(sh.top + (5.5 + i * 10.5) * q, size));
      put(staff ? -9 : -5.2, 1.45);
      break;
    }
    case 'cage': {
      // Клетка: проволочные дуги вокруг камня навершия, снизу обруч, сверху шишечка.
      const hf = at(new THREE.Group(), X(sh.top), sh.top, 0, 0, 0, Math.PI);
      out.add(hf);
      const n = staff ? 6 : 5, cl = (staff ? 0.9 : 0.3) * s, wr = (staff ? 0.28 : 0.08) * s;
      // Клетка не мельче «фонаря»: вокруг маленького камня (тау, крюк) она всё равно должна читаться.
      const Rx = Math.max(anc.rx + cl, (staff ? 4.2 : 1.6) * s), Ry = Math.max(anc.ry + cl, (staff ? 4.6 : 1.8) * s);
      const psis = [-0.5 * Math.PI + 0.35, -0.3 * Math.PI, -0.12 * Math.PI, 0.05 * Math.PI, 0.22 * Math.PI, 0.38 * Math.PI, 0.5 * Math.PI - 0.1];
      for (let i = 0; i < n; i++) {
        const phi = ((i + 0.5) / n) * TAU;
        const pts = psis.map((psi) => [anc.cx + Rx * Math.cos(psi) * Math.cos(phi), anc.cy + Ry * Math.sin(psi), anc.cz + Rx * Math.cos(psi) * Math.sin(phi)] as V3);
        hf.add(sweep(pts, () => wr, m, { segs: 12, radial: 4, caps: false }));
      }
      const yb = anc.cy + Ry * Math.sin(psis[0]!), rb = Rx * Math.cos(psis[0]!);
      hf.add(at(ring(rb, wr * 1.6, m, 5, 18), anc.cx, yb, anc.cz, Math.PI / 2));
      hf.add(at(ring(Rx * Math.cos(psis[6]!), wr * 1.4, m, 5, 12), anc.cx, anc.cy + Ry * Math.sin(psis[6]!), anc.cz, Math.PI / 2));
      hf.add(at(sphere(wr * 3.2, m, 8), anc.cx, anc.cy + Ry + wr * 2, anc.cz));
      break;
    }
    case 'rings': {
      // Кольца: частые обручи под навершием и пара над хватом.
      for (let i = 0; i < 5; i++) { const y = sh.top + (4.5 + i * 5.2 * s) * q; band(y, 1.05, R(y) * 0.3 * s); }
      for (const y of staff ? [-10.5, -7.5] : [-5.6, -4.8]) band(y, 1.05, R(y) * 0.26 * s);
      break;
    }
    case 'ferrules': {
      // Обоймицы: длинная втулка-раструб у навершия и короткая над хватом, с валиками по краям.
      const sleeve = (yA: number, L: number): void => {
        const r = Math.max(R(yA), R(yA + L));
        const prof: V2[] = [[r * 1.01, 0], [r * 1.3, 0.04 * L], [r * 1.3, 0.1 * L], [r * 1.12, 0.16 * L], [r * 1.1, 0.44 * L], [r * 1.24, 0.5 * L], [r * 1.1, 0.56 * L], [r * 1.12, 0.84 * L], [r * 1.3, 0.9 * L], [r * 1.3, 0.96 * L], [r * 1.01, L]];
        out.add(at(latheY(prof, m, 14), X(yA + L / 2), yA));
      };
      sleeve(sh.top - 0.4 * q, 14 * q * s);
      sleeve(staff ? -19 : -6.8, 7 * q * s);
      break;
    }
    case 'filigree': {
      // Филигрань: две встречные спирали витой проволоки — сеточка с зернью на перекрестьях.
      const yA = sh.top + 4 * q, L = 34 * q * s, turns = staff ? 4 : 3, wr = (staff ? 0.2 : 0.075) * s;
      const Rh = (y: number): number => R(y) * 1.04 + wr;
      for (const hand of [1, -1]) {
        const n = turns * 10, pts: V3[] = [];
        for (let i = 0; i <= n; i++) {
          const u = i / n, y = yA + u * L, phi = hand * TAU * turns * u;
          pts.push([X(y) + Rh(y) * Math.sin(phi), y, Rh(y) * Math.cos(phi)]);
        }
        out.add(sweep(pts, () => wr, m, { segs: turns * 12, radial: 4, caps: false }));
      }
      for (let j = 0; j <= 2 * turns; j++) {
        const y = yA + (j / (2 * turns)) * L, z = j % 2 ? -Rh(y) : Rh(y);
        out.add(at(mesh(new THREE.SphereGeometry(wr * 1.9, 4, 3), m), X(y), y, z));
      }
      band(yA, 1.04, wr * 1.8, 14);
      band(yA + L, 1.04, wr * 1.8, 14);
      break;
    }
    default:
      for (let i = 0; i < 2 + Math.floor(hash01(p.id) * 3); i++) { const y = sh.top + (3 + i * 4) * q; band(y, 1.05, R(y) * 0.22 * s); }
  }
}

// ── ПЯТА (общая: оковец, подковец, колпачок, копьецо) ────────────────────────────────────────────

function buildHeel(ctx: MeshCtx, staff: boolean, sh: Shaft, out: THREE.Group): void {
  const p = ctx.parts.head;
  const kind = p.tags.heel ?? '';
  const s = byAxis(p.axis, 0.9, 1.1) * jitter(p.id);
  const m = ctx.mat('head');
  const R = sh.r(sh.bottom);
  const q = staff ? 1 : 0.32;
  // Своя система: начало — торец комля, +Y — наружу от древка.
  const hg = at(new THREE.Group(), sh.x(sh.bottom), sh.bottom);
  out.add(hg);
  switch (kind) {
    case 'shoe': {
      // Оковец: глухая втулка на комель, валик по краю, скруглённый торец.
      const L = 10 * q * s;
      hg.add(latheY([[R * 1.02, -L], [R * 1.26, -L + 1.0 * q], [R * 1.26, -L + 1.8 * q], [R * 1.1, -L + 2.4 * q], [R * 1.08, -0.6 * q], [R * 1.0, 0.3 * q], [R * 0.62, 0.8 * q], [0.001, 0.9 * q]], m, 14));
      for (const sx of [1, -1]) hg.add(at(sphere(R * 0.14, m, 6), sx * R * 1.1, -L + 4.5 * q, 0));
      break;
    }
    case 'horseshoe': {
      // Подковец: U-образная скоба через торец (дугой наружу, ветви по древку) с гвоздями.
      const Ro = R * 1.5, Ri = R * 1.02, A = 6.5 * q * s, depth = R * 1.35;
      const outline: V2[] = [[Ro, -A], [Ro, 0]];
      for (let i = 1; i < 9; i++) { const th = (i / 9) * Math.PI; outline.push([Ro * Math.cos(th), Ro * Math.sin(th)]); }
      outline.push([-Ro, 0], [-Ro, -A], [-Ri, -A], [-Ri, 0]);
      for (let i = 8; i >= 1; i--) { const th = (i / 9) * Math.PI; outline.push([Ri * Math.cos(th), Ri * Math.sin(th)]); }
      outline.push([Ri, 0], [Ri, -A]);
      hg.add(extrudeXY(outline, depth, m));
      const dome: V2[] = [[R * 0.99, -0.4 * q]];
      for (let i = 0; i <= 5; i++) { const th = (i / 5) * (Math.PI / 2); dome.push([Math.max(0.001, R * 0.99 * Math.cos(th)), R * 0.9 * Math.sin(th)]); }
      hg.add(latheY(dome, ctx.mat('grip'), 10));
      const nail = ctx.fixed(0x2a2a2c, 0.6, 0.45), rm = (Ro + Ri) / 2, nr = (Ro - Ri) * 0.24;
      const spots: [number, number][] = [[rm, -A * 0.55], [-rm, -A * 0.55], [0, rm]];
      for (const [x, y] of spots) for (const z of [1, -1]) hg.add(at(mesh(new THREE.SphereGeometry(nr, 4, 3), nail), x, y, (z * depth) / 2));
      break;
    }
    case 'cap': {
      // Стальной колпачок: короткая втулка и широкий купол-грибок с шишечкой на торце.
      const L = 2.6 * q * s, Rc = R * 1.55, D = R * 1.15 * s;
      const prof: V2[] = [[R * 1.02, -L], [R * 1.18, -L + 0.5 * q], [R * 1.12, -0.45 * q], [Rc, -0.1 * q]];
      for (let i = 1; i <= 6; i++) { const th = (i / 6) * (Math.PI / 2); prof.push([Math.max(0.001, Rc * Math.cos(th)), D * Math.sin(th)]); }
      hg.add(latheY(prof, m, 16));
      hg.add(at(sphere(R * 0.38, m, 8), 0, D + R * 0.15));
      break;
    }
    case 'spear': {
      // Копьецо: втулка и четырёхгранный шип.
      const Ls = (staff ? 8 : 10 * q) * s;
      hg.add(latheY([[R * 1.02, -4.5 * q], [R * 1.2, -3.8 * q], [R * 1.1, -0.4 * q], [R * 1.35, 0], [R * 1.3, 0.5 * q], [R * 0.95, 0.9 * q]], m, 14));
      hg.add(flat(latheY([[R * 0.95, 0.85 * q], [R * 0.72, 2.0 * q], [0.001, 0.9 * q + Ls]], m, 4)));
      break;
    }
    default: {
      const L = (3 + 4 * hash01(p.id)) * q;
      hg.add(latheY([[R * 1.02, -L], [R * 1.15, -L + 0.5 * q], [R * 1.1, 0], [R * 0.5, 0.5 * q], [0.001, 0.6 * q]], m, 12));
    }
  }
}

// ── Сборка ───────────────────────────────────────────────────────────────────────────────────────

function buildMagic(ctx: MeshCtx): THREE.Group {
  const staff = ctx.cls === 'staff';
  const { root, g } = slotGroups();
  const shaft = buildShaft(ctx, staff, g.grip);
  const anchor = buildFocus(ctx, staff, shaft, g.strike);
  buildMount(ctx, staff, shaft, anchor, g.bind);
  buildHeel(ctx, staff, shaft, g.head);
  return root;
}

/** Жезл ≈ 32–38 см (+ навершие): рука в комлевой трети, навершие в −Y. */
export const buildWand = (ctx: MeshCtx): THREE.Group => buildMagic(ctx);
/** Посох ≈ 165–185 см: рука ≈ в метре под макушкой навершия. */
export const buildStaff = (ctx: MeshCtx): THREE.Group => buildMagic(ctx);
