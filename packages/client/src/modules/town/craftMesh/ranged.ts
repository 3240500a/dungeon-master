import * as THREE from 'three';
import {
  at, box, byAxis, cone, cyl, extrudeXY, latheY, mesh, slotGroups, sphere, tube,
  type MeshCtx, type V2,
} from './core.js';

/**
 * ЛУК И АРБАЛЕТ ИЗ ДЕТАЛЕЙ (docs/CRAFT_WEAPONS.md §18, визуал Ф1). Контракт — в `core.ts`.
 *
 * ЛУК рисуется НАТЯНУТЫМ (на тетиве) в плоскости XY: рукоять в начале координат, верхнее плечо в −Y,
 * спинка в +X, тетива со стороны −X. Силуэт плеч — «черепаха» из дуг (длина + поворот к тетиве), у
 * каждого типа свой: скифская сигма (горб − прогиб − загиб), простая D-дуга, длинная пологая
 * D-дуга с D-сечением, рефлексно-рекурвный составной, длинный рефлексный. Концы (head) продолжают
 * плечо с его касательной: гибкие, роговые ноки, рабочий загиб, сияхи (с накладками 4/7), большие
 * сияхи с подтетивниками. Тетива ложится как настоящая: от нока к самой «тетивной» точке живота
 * (подтетивник, колено рекурва) — и по прямой вниз.
 *
 * АРБАЛЕТ: ложе вдоль −Y от спуска (рука — в начале координат) к носу, где поперёк по X стоит дуга;
 * верх ложа — +Z, спуск и рычаг — под ложем (−Z). Тетива взведена: V от концов дуги к ореху.
 * Взвод висит у хвоста. Каждое из 22 лож (`STOCKS`) — профиль сбоку и сверху (строки y/ширина/верх/низ:
 * изгиб вниз у пулевых, приклад у ружейных, «кулак» крепостного) плюс своя мебель (`FURNITURE`): рукоять
 * пистолета, винт балестрино, магазины чуского и чжугэ-ну, упор мишенного, полумесяц гастрафета…
 * Ложе задаёт и посадку дуги (на верх, сквозь окно, с наклоном), и двойную тетиву пулевых.
 */

type V3 = [number, number, number];
type Mat = THREE.Material;
const D2R = Math.PI / 180;
const BONE = 0xe6dcc3;
const HORN = 0xc9b28a;
const DARK_HORN = 0x3a2c22;
/** Накладки гуннского лука — белее «рога и жилы» (ступень 3 кибити), иначе ухо в кости не видно. */
const PLATE_BONE = 0xf6f1e4;
/** Жильная/берестяная обмотка концов накладок. */
const SINEW = 0x3b2a1e;
/** Орех замка — рог/кость (исторически), светлый, чтобы замок читался на тёмном ложе. */
const ANTLER = 0xeee4cc;
/** Воск/смола навощённой тетивы. */
const WAX = 0x8a5620;
/** Тёмная пеньковая бриделя тяжёлой дуги. */
const BRIDLE = 0x4a3826;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
function last<T>(a: T[]): T { return a[a.length - 1]!; }
const fill = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

// ── Геометрия ────────────────────────────────────────────────────────────────────────────────────

interface SweepOpts {
  sides?: number;
  /** Показатель суперэллипса сечения: 2 — эллипс, 4…7 — скруглённый прямоугольник. */
  pow?: number;
  /** Центр сечения по Z: одно число или по станции. */
  z?: number | number[];
  /** D-сечение: спинка (+нормаль) плоская, живот круглый — английский длинный лук. */
  flatBack?: boolean;
}

/**
 * ПРОТЯЖКА СЕЧЕНИЯ по осевой в плоскости XY: `th` — размер по левой нормали к оси (в плоскости),
 * `wd` — по Z. Плечи лука, дуга и ложе арбалета, ремни. Торцы закрыты.
 */
function sweep(center: V2[], th: number[], wd: number[], mat: Mat, o: SweepOpts = {}): THREE.Mesh {
  const n = center.length;
  const sides = o.sides ?? 8;
  const e = 2 / (o.pow ?? 2);
  const zAt = (i: number): number => (Array.isArray(o.z) ? (o.z[i] ?? 0) : (o.z ?? 0));
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = center[i]!;
    const a = center[Math.max(0, i - 1)]!, b = center[Math.min(n - 1, i + 1)]!;
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const t = (th[i] ?? last(th)) / 2, w = (wd[i] ?? last(wd)) / 2, z = zAt(i);
    for (let k = 0; k < sides; k++) {
      const ang = ((k + 0.5) / sides) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      let u = Math.sign(c) * Math.abs(c) ** e;
      const v = Math.sign(s) * Math.abs(s) ** e;
      if (o.flatBack && u > 0.3) u = 0.3;
      pos.push(p[0] - ty * u * t, p[1] + tx * u * t, z + v * w);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * sides + k, b = i * sides + ((k + 1) % sides), c = a + sides, d = b + sides;
      idx.push(a, b, c, b, d, c);
    }
  }
  const c0 = n * sides;
  const f = center[0]!, l = last(center);
  pos.push(f[0], f[1], zAt(0), l[0], l[1], zAt(n - 1));
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    idx.push(c0, k2, k, c0 + 1, (n - 1) * sides + k, (n - 1) * sides + k2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

/** Протяжка по кривой в плоскости YZ (пары [y, z]); `wd` ложится по X, центр по X — `x`. */
function sweepYZ(center: [number, number][], th: number[], wd: number[], mat: Mat, o: SweepOpts = {}, x = 0): THREE.Mesh {
  const m = sweep(center.map(([y, z]) => [z, y] as V2), th, wd, mat, { ...o, z: -x });
  m.geometry.rotateY(-Math.PI / 2);
  return m;
}

/** Протяжка по кривой в плоскости XZ (пары [x, z]) на высоте `y`; `wd` ложится по Y. */
function sweepXZ(center: [number, number][], th: number[], wd: number[], mat: Mat, y: number, o: SweepOpts = {}): THREE.Mesh {
  const m = sweep(center, th, wd, mat, { ...o, z: -y });
  m.geometry.rotateX(Math.PI / 2);
  return m;
}

/** Плоская деталь с контуром в плоскости YZ (пары [y, z]), толщина по X. */
function extrudeYZ(outline: [number, number][], depth: number, mat: Mat, x = 0): THREE.Mesh {
  const m = extrudeXY(outline.map(([y, z]) => [z, y] as V2), depth, mat);
  m.geometry.rotateY(-Math.PI / 2);
  m.position.x = x;
  return m;
}

/** Тело вращения, нос которого смотрит в −Y локально; профиль сортируется снизу вверх (наружные грани). */
function lathe(profile: V2[], mat: Mat, seg = 12): THREE.Mesh {
  return latheY([...profile].sort((p, q) => p[1] - q[1]), mat, seg);
}

/** Стержень между двумя точками. */
function rod(a: V3, b: V3, r: number, mat: Mat, seg = 6): THREE.Mesh {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const m = cyl(r, r, Math.max(0.01, len), mat, seg);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  if (len > 1e-6) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** Цилиндр поперёк по X (ось, штифт, ролик). */
function cylX(r: number, len: number, mat: Mat, x: number, y: number, z: number, seg = 12): THREE.Mesh {
  return at(cyl(r, r, len, mat, seg), x, y, z, 0, 0, Math.PI / 2);
}

interface Seg { f: number; turn: number }
interface Path { pts: V2[]; ang: number[]; u: number[] }

/**
 * «ЧЕРЕПАХА»: осевая из дуг постоянной кривизны. `ang0` — курс (рад, от +X против часовой), у сегмента
 * доля длины `f` и поворот `turn` в градусах (+ — против часовой). Возвращает точки, курс и долю длины.
 */
function turtle(start: V2, ang0: number, len: number, segs: Seg[], stations = 24): Path {
  const pts: V2[] = [[start[0], start[1]]];
  const ang = [ang0];
  const u = [0];
  let [x, y] = start;
  let a = ang0, s = 0;
  const fsum = segs.reduce((q, g) => q + g.f, 0) || 1;
  for (const g of segs) {
    const L = (len * g.f) / fsum;
    const n = Math.max(2, Math.round((stations * g.f) / fsum));
    const da = (g.turn * D2R) / n, ds = L / n;
    for (let i = 0; i < n; i++) {
      const am = a + da / 2;
      x += Math.cos(am) * ds; y += Math.sin(am) * ds;
      a += da; s += ds;
      pts.push([x, y]); ang.push(a); u.push(s / len);
    }
  }
  return { pts, ang, u };
}

/** Точка, сдвинутая по левой нормали к курсу `a` на `d` (у верхнего плеча лука + — к спинке). */
function offN(p: V2, a: number, d: number): V2 { return [p[0] - Math.sin(a) * d, p[1] + Math.cos(a) * d]; }

/** Петля (кольцо шнура/обоймы) вокруг сечения в точке пути: полуоси по нормали и по Z. */
function loopAround(p: V2, a: number, rn: number, rz: number, r: number, mat: Mat, z = 0, seg = 8): THREE.Mesh {
  const nx = -Math.sin(a), ny = Math.cos(a);
  const pts: V3[] = [];
  for (let i = 0; i < seg; i++) {
    const q = (i / seg) * Math.PI * 2;
    pts.push([p[0] + nx * rn * Math.cos(q), p[1] + ny * rn * Math.cos(q), z + rz * Math.sin(q)]);
  }
  return tube(pts, r, mat, { closed: true, segments: seg + 2, radial: 4 });
}

/** Кольцо-обвязка вокруг прямоугольного сечения ложа (оси X, Z) в точке y. */
function lashing(y: number, w: number, zt: number, zb: number, r: number, mat: Mat): THREE.Mesh {
  const hx = w / 2 + r * 0.6, zc = (zt + zb) / 2, hz = (zt - zb) / 2 + r * 0.6;
  const pts: V3[] = [[hx, y, zc + hz], [-hx, y, zc + hz], [-hx, y, zc - hz], [hx, y, zc - hz]];
  const dense: V3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!, b = pts[(i + 1) % 4]!;
    dense.push(a, [lerp(a[0], b[0], 0.5), y, lerp(a[2], b[2], 0.5)]);
  }
  return tube(dense, r, mat, { closed: true, segments: 16, radial: 4 });
}

// ── ЛУК ──────────────────────────────────────────────────────────────────────────────────────────

interface LimbSpec {
  /** Длина лука вдоль кибити, см. */
  L: number;
  /** Дуги плеча: доля длины и поворот К ТЕТИВЕ (+) или к спинке (−), градусы. */
  segs: Seg[];
  th: number; wd: number; thEnd: number; wdEnd: number;
  /** Холмегорское «весло»: ширина растёт к середине плеча. */
  bulge?: number;
  flatBack?: boolean;
  pow: number;
}

const LIMBS: Record<string, LimbSpec> = {
  // Скифский лук: плечо от рукояти сначала уходит в спинку (горб), потом круто к тетиве и снова загибается наружу.
  'short-sigma': { L: 76, segs: [{ f: 0.24, turn: -40 }, { f: 0.46, turn: 118 }, { f: 0.3, turn: -66 }], th: 1.9, wd: 2.5, thEnd: 0.55, wdEnd: 0.5, pow: 2.6 },
  // Простой лук из палки: ровная D-дуга, широкое плоское плечо («весло» Холмегора).
  self: { L: 150, segs: [{ f: 1, turn: 44 }], th: 1.8, wd: 3.0, thEnd: 0.5, wdEnd: 0.4, bulge: 1.65, pow: 3.6 },
  // Английский длинный: 190 см, пологая дуга, узкое глубокое D-сечение.
  'long-straight': { L: 190, segs: [{ f: 0.16, turn: 0.5 }, { f: 0.84, turn: 21 }], th: 3.5, wd: 2.6, thEnd: 0.42, wdEnd: 0.5, flatBack: true, pow: 2 },
  // Составной (тюркский, крымский): короткий, сильно согнут, на конце рекурв.
  composite: { L: 120, segs: [{ f: 0.12, turn: -8 }, { f: 0.64, turn: 70 }, { f: 0.24, turn: -30 }], th: 2.3, wd: 3.1, thEnd: 0.6, wdEnd: 0.55, pow: 2.8 },
  // Длинный рефлексный (гуннский): длинное почти прямое плечо под углом, лёгкий рекурв.
  'long-reflex': { L: 156, segs: [{ f: 0.14, turn: -12 }, { f: 0.7, turn: 44 }, { f: 0.16, turn: -14 }], th: 2.5, wd: 3.5, thEnd: 0.62, wdEnd: 0.62, pow: 2.8 },
};

/** Рукоять: полудлина, центр лука по Y (у выносной рукоять ниже центра) и собственный изгиб. */
const RISERS: Record<string, { half: number; yc: number; bend: number; arrowY: number }> = {
  bend: { half: 5.5, yc: 0, bend: 4, arrowY: -5.5 },
  rigid: { half: 9, yc: 0, bend: 0, arrowY: -5.5 },
  offset: { half: 9, yc: -3.5, bend: 0, arrowY: -8.2 },
};

/** Длина конца (доля полулука). */
const TIP_LEN: Record<string, number> = { flexible: 0.08, 'horn-nocks': 0.035, working: 0.16, siyah: 0.17, 'big-siyah': 0.25 };

type StringKind = 'double' | 'waxed' | 'single' | 'braided' | 'twisted';
const stringKind = (ax: number): StringKind => (ax >= 0.75 ? 'double' : ax >= 0.25 ? 'waxed' : ax >= -0.25 ? 'single' : ax >= -0.75 ? 'braided' : 'twisted');

export function buildBow(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const lim = LIMBS[ctx.tag('strike', 'limbs')] ?? LIMBS['self']!;
  const riser = RISERS[ctx.tag('grip', 'riser')] ? ctx.tag('grip', 'riser') : 'bend';
  const rs = RISERS[riser]!;
  const tip = TIP_LEN[ctx.tag('head', 'tips')] ? ctx.tag('head', 'tips') : 'flexible';
  const plates = ctx.tag('head', 'plates') || 'none';
  const { strike: pS, head: pH, bind: pB, grip: pG } = ctx.parts;
  const yc = rs.yc;
  const th0 = lim.th * byAxis(pS.axis, 0.8, 1.22);
  const wd0 = lim.wd * byAxis(pS.axis, 0.86, 1.14);
  const H = lim.L / 2;
  const capLen = tip === 'horn-nocks' ? Math.max(3.6, H * 0.05) : 0;
  const tipLen = H * TIP_LEN[tip]! * (tip === 'siyah' ? byAxis(pH.axis, 0.9, 1.06) : 1);
  const limbLen = Math.max(10, H - rs.half - tipLen - capLen);
  const staveM = ctx.mat('strike'), gripM = ctx.mat('grip'), bindM = ctx.mat('bind'), headM = ctx.mat('head');
  const hide = ctx.matOf('hide', pG.step);
  const bone = ctx.fixed(BONE, 0, 0.45);

  /** Зеркало верхней половины в нижнюю (относительно y = yc). */
  const mirror = (o: THREE.Object3D): THREE.Object3D => { const c = o.clone(); c.scale.y = -1; c.position.y = 2 * yc - o.position.y; return c; };
  const both = (grp: THREE.Group, ...objs: THREE.Object3D[]): void => {
    const h = new THREE.Group();
    h.add(...objs);
    grp.add(h, mirror(h));
  };

  // ── Осевая: половина рукояти → плечо → конец (верхняя половина, курс −Y) ──
  const handle = turtle([0, yc], -Math.PI / 2, rs.half, [{ f: 1, turn: -rs.bend }], 6);
  const limb = turtle(last(handle.pts), last(handle.ang), limbLen, lim.segs.map((s) => ({ f: s.f, turn: -s.turn })), 26);
  const thL = limb.u.map((u) => th0 * lerp(1, lim.thEnd, u ** 1.1));
  const wdL = limb.u.map((u) => wd0 * lerp(1, lim.wdEnd, u ** 1.3) * (lim.bulge ? 1 + (lim.bulge - 1) * Math.sin(Math.PI * Math.min(1, u * 1.1)) : 1));

  // ── STRIKE: плечи ──
  both(g.strike, sweep(limb.pts, thL, wdL, staveM, { pow: lim.pow, flatBack: lim.flatBack, sides: lim.flatBack ? 10 : 8 }));

  // ── GRIP: рукоять ──
  /** Габарит рукояти для накладок «семёрки»: полутолщина по Z, центр по X и живот (−X) на высоте y. */
  let gripHalfZ = wd0 / 2;
  let gripCX = 0;
  let bellyAt = (_y: number): number => -th0 / 2;
  if (riser === 'bend') {
    // Гнущаяся: тонкая кибить идёт через рукоять не прерываясь; кожаная обмотка и два шнурка.
    const hp: V2[] = [...handle.pts].reverse().map((p) => [p[0], 2 * yc - p[1]] as V2).concat(handle.pts.slice(1));
    const ha: number[] = [...handle.ang].reverse().map((a) => -Math.PI - a).concat(handle.ang.slice(1));
    g.grip.add(sweep(hp, fill(hp.length, th0 * 1.02), fill(hp.length, wd0 * 0.92), gripM, { pow: lim.pow }));
    const wrapIdx = hp.map((p, i) => (Math.abs(p[1] - yc) <= 4.3 ? i : -1)).filter((i) => i >= 0);
    const wp = wrapIdx.map((i) => hp[i]!);
    g.grip.add(sweep(wp, fill(wp.length, th0 * 1.02 + 0.55), fill(wp.length, wd0 * 0.92 + 0.55), hide, { pow: lim.pow }));
    for (const i of [wrapIdx[0]!, last(wrapIdx)]) {
      const a = ha[i] ?? -Math.PI / 2;
      g.grip.add(loopAround(hp[i]!, a, th0 * 0.51 + 0.35, wd0 * 0.46 + 0.35, 0.16, ctx.matOf('cloth', 1)));
    }
    gripHalfZ = (wd0 * 0.92 + 0.55) / 2;
    bellyAt = () => -(th0 * 0.51 + 0.28);
  } else if (riser === 'rigid') {
    // Жёсткая: толстая «рыбка» рукояти, обе щеки и живот выложены костью.
    const depth = wd0 * 1.1;
    const N = 9;
    const bx = (t: number): number => th0 / 2 + 0.7 * (1 - t * t);
    const lx = (t: number): number => -(th0 / 2 + 2.1 * (1 - t * t) ** 1.2);
    const outline = (sx: number, sy: number, t0: number): V2[] => {
      const r: V2[] = [], l: V2[] = [];
      for (let i = 0; i <= N; i++) {
        const t = lerp(-t0, t0, i / N);
        r.push([bx(t) * sx, yc + t * rs.half * sy]);
        l.push([lx(t) * sx, yc + t * rs.half * sy]);
      }
      return [...r, ...l.reverse()];
    };
    g.grip.add(extrudeXY(outline(1, 1, 1), depth, gripM));
    for (const sz of [1, -1]) g.grip.add(at(extrudeXY(outline(0.86, 1, 0.8), 0.3, bone), 0, 0, sz * (depth / 2 + 0.14)));
    const belly: V2[] = [];
    for (let i = 0; i <= 10; i++) { const t = lerp(-0.7, 0.7, i / 10); belly.push([lx(t) - 0.14, yc - t * rs.half]); }
    g.grip.add(sweep(belly, fill(belly.length, 0.3), fill(belly.length, depth * 0.8), bone, { pow: 4, sides: 6 }));
    gripHalfZ = depth / 2 + 0.3;
    gripCX = (bx(0) + lx(0)) / 2;
    bellyAt = (y) => lx(clamp((y - yc) / rs.half, -1, 1)) - 0.3;
  } else {
    // Выносная: спинка прямая, живот — полка для стрелы над кистью и «пистолетный» выступ под кисть.
    const depth = wd0 * 1.12;
    const keys: V2[] = [[-1, 0], [-0.75, 0.3], [-0.62, 1.7], [-0.42, 1.7], [-0.36, 0.9], [-0.1, 2.6], [0.38, 3.6], [0.72, 2.4], [1, 0]];
    const d = (t: number): number => {
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i]!, b = keys[i + 1]!;
        if (t <= b[0]) { const k = (t - a[0]) / (b[0] - a[0]); return lerp(a[1], b[1], 0.5 - 0.5 * Math.cos(Math.PI * k)); }
      }
      return 0;
    };
    const bx = (t: number): number => th0 / 2 + 0.5 * (1 - t * t);
    const outline = (t0: number, t1: number, grow: number): V2[] => {
      const r: V2[] = [], l: V2[] = [];
      const n = Math.max(6, Math.round((t1 - t0) * 8));
      for (let i = 0; i <= n; i++) {
        const t = lerp(t0, t1, i / n);
        r.push([bx(t) + grow, yc + t * rs.half]);
        l.push([-(th0 / 2 + d(t)) - grow, yc + t * rs.half]);
      }
      return [...r, ...l.reverse()];
    };
    g.grip.add(extrudeXY(outline(-1, 1, 0), depth, gripM));
    g.grip.add(extrudeXY(outline(-0.3, 0.85, 0.22), depth + 0.45, hide));
    // Полочка-упор для стрелы из рога.
    g.grip.add(at(box(1.9, 0.7, depth * 0.55, ctx.fixed(HORN, 0, 0.35)), -(th0 / 2 + 1.0), yc - 0.52 * rs.half, depth * 0.2));
    gripHalfZ = (depth + 0.45) / 2;
    gripCX = (bx(0) - th0 / 2 - d(0)) / 2;
    bellyAt = (y) => { const t = clamp((y - yc) / rs.half, -1, 1); return -(th0 / 2 + d(t)) - (t > -0.3 && t < 0.85 ? 0.24 : 0.02); };
  }

  // ── HEAD: концы ──
  const E = last(limb.pts), A = last(limb.ang);
  const thE = last(thL), wdE = last(wdL);
  let tp: Path;
  let tth: number[], twd: number[];
  let tpow = lim.pow;
  let nockI: number;
  let bridge: V2 | null = null;
  let flat = false;
  const extras: THREE.Object3D[] = [];
  let nockC: V2 | null = null, nockA = 0, nockRn = 0, nockRz = 0;
  switch (tip) {
    case 'horn-nocks': {
      tp = turtle(E, A, tipLen, [{ f: 1, turn: -4 }], 4);
      tth = fill(tp.pts.length, thE * 0.95); twd = fill(tp.pts.length, wdE * 0.95);
      nockI = tp.pts.length - 1;
      flat = !!lim.flatBack;
      // Роговой нок: колпачок-«пулька» с канавкой под петлю тетивы.
      const cl = capLen, rb = Math.max(thE, wdE) * 0.5 + 0.25;
      const cap = lathe([[rb * 0.9, 1.2], [rb, 0], [rb * 1.06, -0.18 * cl], [rb * 0.74, -0.32 * cl], [rb * 0.74, -0.44 * cl], [rb * 0.98, -0.54 * cl], [rb * 0.8, -0.78 * cl], [rb * 0.34, -0.96 * cl], [0.02, -cl]], ctx.fixed(HORN, 0, 0.35), 12);
      const P = last(tp.pts), a = last(tp.ang);
      extras.push(at(cap, P[0], P[1], 0, 0, 0, a + Math.PI / 2));
      nockC = [P[0] + Math.cos(a) * cl * 0.38, P[1] + Math.sin(a) * cl * 0.38];
      nockA = a; nockRn = rb * 0.74; nockRz = rb * 0.74;
      break;
    }
    case 'working': {
      // Рабочий загиб: конец сам гнётся от тетивы круглым «крючком» (не жёсткий угол сияхи), тетива
      // лежит на загибе. Загиб крутой — иначе в превью его не отличить от гибкого конца.
      tp = turtle(E, A, tipLen, [{ f: 0.18, turn: -4 }, { f: 0.82, turn: 100 }], 14);
      tth = tp.u.map((u) => thE * lerp(1, 0.6, u)); twd = tp.u.map((u) => wdE * lerp(1, 0.66, u));
      nockI = tp.pts.length - 2;
      flat = !!lim.flatBack;
      break;
    }
    case 'siyah': {
      // Сияха: жёсткий прямой «рычаг», вклеенный под углом вперёд через колено.
      const kk = byAxis(pH.axis, 0.85, 1.1);
      tp = turtle(E, A, tipLen, [{ f: 0.14, turn: 40 * kk }, { f: 0.86, turn: 3 }], 12);
      tth = tp.u.map((u) => thE * (u < 0.2 ? lerp(1, 1.45, u / 0.2) : lerp(1.45, 1.15, (u - 0.2) / 0.8)));
      twd = tp.u.map((u) => wdE * lerp(0.95, 0.78, u));
      tpow = 5;
      nockI = tp.pts.length - 2;
      break;
    }
    case 'big-siyah': {
      // Большая сияха: длинное ухо; на колене — костяной подтетивник, на котором лежит тетива.
      tp = turtle(E, A, tipLen, [{ f: 0.1, turn: 36 }, { f: 0.9, turn: 4 }], 14);
      tth = tp.u.map((u) => thE * (u < 0.15 ? lerp(1, 1.9, u / 0.15) : lerp(1.9, 1.4, (u - 0.15) / 0.85)));
      twd = tp.u.map((u) => wdE * lerp(1, 0.85, u));
      tpow = 5;
      nockI = tp.pts.length - 2;
      const iK = tp.u.findIndex((u) => u >= 0.12);
      const pK = tp.pts[iK]!, aK = tp.ang[iK]!, thK = tth[iK]!;
      const bc = offN(pK, aK, -(thK / 2 + 0.6));
      extras.push(at(box(1.5, 2.4, twd[iK]! * 1.15, bone), bc[0], bc[1], 0, 0, 0, aK + Math.PI / 2));
      bridge = offN(pK, aK, -(thK / 2 + 1.35));
      break;
    }
    default: {
      // Гибкие: плечо просто сходит на нет, продолжая изгиб.
      tp = turtle(E, A, tipLen, [{ f: 1, turn: -10 }], 8);
      tth = tp.u.map((u) => thE * lerp(1, 0.45, u)); twd = tp.u.map((u) => wdE * lerp(1, 0.5, u));
      nockI = Math.round((tp.pts.length - 1) * 0.8);
      flat = !!lim.flatBack;
    }
  }
  both(g.head, sweep(tp.pts, tth, twd, headM, { pow: tpow, flatBack: flat, sides: flat ? 10 : 8 }), ...extras);

  // Костяные накладки гуннского набора. 4 [Ирзи] — пара концевых на каждом ухе (обе щеки), ухо
  // целиком одето в белую кость и перетянуто тёмной жилой по краям накладок. 7 [Кум-Дарья] — те же
  // 4 концевые + 3 срединные на рукояти: две боковые «ланцетом» и одна по животу.
  if (plates === 'four' || plates === 'seven') {
    const plateM = ctx.fixed(PLATE_BONE, 0, 0.4);
    const sinew = ctx.fixed(SINEW, 0, 0.8);
    const i0 = Math.max(1, tp.u.findIndex((u) => u >= 0.16));
    const i1 = Math.min(tp.pts.length - 1, nockI + 1);
    const ids = tp.pts.map((_, i) => i).filter((i) => i >= i0 && i <= i1);
    const sp = ids.map((i) => tp.pts[i]!), sth = ids.map((i) => tth[i]! * 1.1 + 0.1), swd = ids.map((i) => twd[i]!);
    const slabs: THREE.Object3D[] = [];
    for (const sz of [1, -1]) slabs.push(sweep(sp, sth, fill(sp.length, 0.36), plateM, { pow: 5, sides: 8, z: swd.map((w) => sz * (w / 2 + 0.17)) }));
    for (const i of [ids[0]!, ids[Math.round((ids.length - 1) * 0.55)]!]) slabs.push(loopAround(tp.pts[i]!, tp.ang[i]!, tth[i]! * 0.55 + 0.3, twd[i]! / 2 + 0.55, 0.2, sinew));
    both(g.head, ...slabs);
    if (plates === 'seven') {
      const Lp = 2 * rs.half + 2.5, W = th0 * 1.15 + 0.6;
      const lance: V2[] = [];
      for (let i = 0; i <= 8; i++) { const t = i / 8; lance.push([gripCX + (W / 2) * Math.sin(Math.PI * t) ** 0.55, yc - Lp / 2 + Lp * t]); }
      for (let i = 7; i >= 1; i--) { const q = lance[i]!; lance.push([2 * gripCX - q[0], q[1]]); }
      for (const sz of [1, -1]) g.head.add(at(extrudeXY(lance, 0.34, plateM), 0, 0, sz * (gripHalfZ + 0.17)));
      const bp: V2[] = [];
      for (let i = 0; i <= 10; i++) { const y = yc - Lp * 0.4 + Lp * 0.8 * (i / 10); bp.push([bellyAt(y) - 0.17, y]); }
      g.head.add(sweep(bp, bp.map((_, i) => 0.34 * (0.4 + 0.6 * Math.sin((Math.PI * i) / 10))), fill(bp.length, gripHalfZ * 1.5), plateM, { pow: 4, sides: 8 }));
    }
  }

  // ── BIND: тетива ──
  const kind = stringKind(pB.axis);
  /** На длинном луке тетива чуть утрирована, иначе в превью (подгонка по высоте) она тоньше пикселя. */
  const sS = clamp(lim.L / 100, 0.85, 1.6);
  const rS = { double: 0.13, waxed: 0.27, single: 0.16, braided: 0.26, twisted: 0.2 }[kind] * sS;
  if (!nockC) {
    nockC = tp.pts[nockI]!; nockA = tp.ang[nockI]!;
    nockRn = tth[nockI]! / 2; nockRz = twd[nockI]! / 2;
  }
  const Nb = offN(nockC, nockA, -(nockRn + rS));
  const reach = Math.abs(Nb[1] - yc) - 0.3;
  let K: V2 | null = null;
  const consider = (q: V2): void => { if (Math.abs(q[1] - yc) < reach && q[0] < Nb[0] - 0.3 && (!K || q[0] < K[0])) K = q; };
  limb.pts.forEach((p, i) => consider(offN(p, limb.ang[i]!, -(thL[i]! / 2 + rS))));
  tp.pts.forEach((p, i) => { if (i < nockI) consider(offN(p, tp.ang[i]!, -(tth[i]! / 2 + rS))); });
  if (bridge) consider([bridge[0] - rS, bridge[1]]);
  const Kp: V2 = K ?? Nb;
  const xs = Kp[0];
  const y0 = Kp[1], y1 = 2 * yc - Kp[1];
  const runLen = Math.abs(y1 - y0);
  const ar = clamp(rs.arrowY, Math.min(y0, y1) + 8, Math.max(y0, y1) - 8);
  const half: THREE.Object3D[] = [];
  const run: THREE.Object3D[] = [];
  const lp = (r: number, m: Mat, z = 0): THREE.Mesh => loopAround(nockC!, nockA, nockRn + r, nockRz + r, r, m, z);
  switch (kind) {
    case 'double': {
      // Двойная: две нити, разведённые на ширину пальца, стянуты общими перевязками (видно «лесенкой»);
      // у ноков — по две петли, посередине общая обмотка.
      const DX = 0.55 * sS, DZ = 0.3 * sS;
      for (const sd of [1, -1]) {
        const dx = sd * DX, z = sd * DZ;
        if (K) half.push(rod([Nb[0] + dx * 0.4, Nb[1], z * 0.4], [Kp[0] + dx, Kp[1], z], rS, bindM));
        run.push(rod([xs + dx, y0, z], [xs + dx, y1, z], rS, bindM));
      }
      half.push(lp(rS, bindM, 0.3), lp(rS, bindM, -0.3));
      for (const f of [0.14, 0.3, 0.7, 0.86]) {
        const y = lerp(y0, y1, f);
        run.push(at(box(2 * DX + 2.6 * rS, 0.55 * sS, 2 * DZ + 2.6 * rS, bindM), xs, y, 0));
      }
      run.push(at(box(2 * DX + 3.2 * rS, 10, 2 * DZ + 3.2 * rS, bindM), xs, ar + 1, 0));
      break;
    }
    case 'waxed': {
      // Навощённая: толще, тёмный янтарный воск с блеском; концевые обмотки у петель.
      const base = (bindM as THREE.MeshStandardMaterial).color ?? new THREE.Color(0xd0c0a0);
      const wax = ctx.fixed(base.clone().lerp(new THREE.Color(WAX), 0.7).getHex(), 0.05, 0.18);
      if (K) half.push(rod([Nb[0], Nb[1], 0], [Kp[0], Kp[1], 0], rS, wax));
      half.push(lp(rS * 1.2, wax));
      const sgn = Math.sign(y1 - y0) || 1;
      half.push(rod([xs, y0, 0], [xs, y0 + sgn * Math.min(6, runLen * 0.1), 0], rS * 1.45, wax));
      run.push(rod([xs, y0, 0], [xs, y1, 0], rS, wax));
      run.push(rod([xs, ar - 5, 0], [xs, ar + 7, 0], rS * 1.55, wax, 8));
      break;
    }
    case 'braided': {
      // Плетёная: толстая, с «колосками» плетения по всей длине.
      if (K) half.push(rod([Nb[0], Nb[1], 0], [Kp[0], Kp[1], 0], rS, bindM));
      half.push(lp(rS, bindM));
      run.push(rod([xs, y0, 0], [xs, y1, 0], rS, bindM));
      const n = Math.max(8, Math.floor(runLen / (6 * sS)));
      for (let i = 0; i < n; i++) {
        const y = lerp(y0, y1, (i + 0.5) / n);
        const b = mesh(new THREE.SphereGeometry(rS * 1.75, 5, 3), bindM);
        b.scale.set(1, 1.9, 1);
        run.push(at(b, xs, y, 0, 0, i % 2 ? 0.6 : -0.6, 0));
      }
      break;
    }
    case 'twisted': {
      // Витая: две пряди, скрученные спиралью.
      if (K) half.push(rod([Nb[0], Nb[1], 0], [Kp[0], Kp[1], 0], rS, bindM));
      half.push(lp(rS, bindM));
      const turns = Math.max(8, Math.round(runLen / (7.5 * sS)));
      const per = 4;
      for (const ph of [0, Math.PI]) {
        const pts: V3[] = [];
        for (let i = 0; i <= turns * per; i++) {
          const t = i / (turns * per), q = ph + t * turns * Math.PI * 2;
          pts.push([xs + 0.24 * sS * Math.cos(q), lerp(y0, y1, t), 0.24 * sS * Math.sin(q)]);
        }
        run.push(tube(pts, 0.14 * sS, bindM, { segments: turns * per, radial: 3 }));
      }
      break;
    }
    default: {
      // Одинарная: тонкая нить, центральная обмотка и узелок-метка под стрелу.
      if (K) half.push(rod([Nb[0], Nb[1], 0], [Kp[0], Kp[1], 0], rS, bindM));
      half.push(lp(rS, bindM));
      run.push(rod([xs, y0, 0], [xs, y1, 0], rS, bindM));
      run.push(rod([xs, ar - 5, 0], [xs, ar + 6, 0], rS * 1.7, bindM, 8));
      run.push(at(sphere(rS * 2.6, bindM, 8), xs, ar - 0.5, 0));
    }
  }
  both(g.bind, ...half);
  g.bind.add(...run);
  return root;
}

// ── АРБАЛЕТ ──────────────────────────────────────────────────────────────────────────────────────

/** Строка профиля ложа: y, ширина по X, верх по Z, низ по Z. */
type Row = [number, number, number, number];
/** Точка контура в плоскости YZ (вид сбоку). */
type YZ = [number, number];
type StirrupKind = 'none' | 'narrow' | 'wide' | 'small' | 'big' | 'triple' | 'horse';

interface StockSpec {
  /** Профиль ложа от носа (−Y) к хвосту: по нему садятся дуга, замок и взвод. */
  rows: Row[];
  /** Y ореха (замка). */
  nut: number;
  /** Размах дуги по X для этого ложа, см. */
  span: number;
  /** Толщина дуги сверх той, что даёт размах (Ganze Rüstung — «чрезвычайно толстая» стальная дуга). */
  prodK?: number;
  stirrup: StirrupKind;
  /** Масштаб стремени (крепостное — крупнее ручного). */
  stirrupK?: number;
  /** Показатель суперэллипса сечения ложа: 2 — овал/восьмигранник, 6+ — прямоугольный брус. */
  pow: number;
  /** Граней сечения (8 при pow 2 — восьмигранник). */
  sides?: number;
  /** Дуга позади носа, см (у мишенного передок выходит за дугу). По умолчанию 2.6. */
  prodAt?: number;
  /** Посадка дуги: на верх ложа (умолч.), сквозь окно посередине или на заданной высоте Z. */
  prodZ?: 'top' | 'mid' | number;
  /** Наклон дуги вверх, градусы (пулевые арбалеты: пуля идёт над выгнутым передком). */
  tilt?: number;
  /** Двойная тетива с распорками и кармашком под пулю. */
  pellet?: boolean;
  /** Спуск кончается перед этим Y: дальше рукоять, скоба или вертикальная ручка. */
  tailMax?: number;
  /** Где висит темляк при взводе руками — низ рукояти (иначе петля под хвостом). */
  loop?: V3;
  /** Y поясного крюка в походном положении (иначе — от хвоста). */
  hookY?: number;
  /** Конец «рабочего» ложа, от которого ставится взвод: перед упором, рычагом, винтом. По умолчанию хвост. */
  tail?: number;
  /** Отрезок Y сплошного ложа по профилю (колонна кугельшнеппера); `false` — ложе целиком рисует его мебель. */
  body?: [number, number] | false;
}

/**
 * 22 ЛОЖА (docs/CRAFT_WEAPONS.md, каталог силуэтов): у каждого свой профиль и своя мебель (`FURNITURE`).
 * Размеры — из музейных замеров (Met, KHM, Royal Armouries) и реконструкций Payne-Gallwey; начало
 * координат — там, где лежит основная кисть (у спуска, рукояти или вертикальной ручки).
 */
const STOCKS: Record<string, StockSpec> = {
  // ── одноручные ──
  // Арбалет-пистолет нач. XIX в.: короткое ложе высоко над наклонной пистолетной рукоятью, латунный ствол-жёлоб.
  // Ложе кончается там, где начинается рукоять: её спинка продолжает верхнюю линию (хвоста-«шипа» за ней нет).
  pistol: { rows: [[-27, 2.3, 7.4, 4.8], [-12, 2.7, 7.4, 4.2], [-2, 2.9, 7.4, 3.8], [0.2, 2.9, 7.3, 3.9], [1.4, 2.5, 6.5, 4.7]], nut: -12, span: 44, stirrup: 'none', pow: 3, tailMax: -3.2, loop: [0, 4.6, -9.3], hookY: -18, tail: 3 },
  // Балестрино: цельностальная «Т» 20–29 см — полый брусок с винтом-домкратом, головка винта с воротком сзади.
  balestrino: { rows: [[-12, 2.6, 1.4, -1.4], [9, 2.6, 1.4, -1.4]], nut: -3, span: 22, stirrup: 'none', pow: 6, prodAt: -0.4, prodZ: 'mid', tailMax: 5, loop: [0, 4, -1.9], hookY: -2, tail: 6, body: false },
  // Дамский каменный: малое узкое ложе, передняя треть выгнута ВНИЗ, дуга с наклоном вверх, точёное навершие.
  'lady-stonebow': { rows: [[-30, 2.2, -3.0, -6.6], [-27, 2.0, -3.2, -5.8], [-22, 1.8, -2.6, -4.8], [-17, 1.8, -1.2, -3.4], [-12, 2.0, 0.4, -1.8], [-8, 2.4, 1.2, -1.4], [-2, 2.4, 1.2, -1.4], [14, 2.1, 1.0, -1.3], [16, 2.0, 0.9, -1.2]], nut: -6, span: 32, stirrup: 'none', pow: 2.4, sides: 8, prodAt: 2.4, tilt: 14, pellet: true },
  // Чуский двузарядный: лакированный короб-магазин на брусе, пистолетная рукоять из-под узла дуги, рычаг сзади.
  'chu-repeater': { rows: [[-5, 3.8, 1.6, -2.0], [-1, 4.2, 1.6, -2.2], [20, 4.2, 1.6, -2.0], [22, 3.8, 1.4, -1.8]], nut: 18, span: 30, stirrup: 'none', pow: 5, prodAt: 1.8, tailMax: 21, loop: [0, 3.4, -11.1], hookY: 10, tail: 17 },
  // ── лёгкие ──
  // «В одну ногу»: прямое ложе без приклада, высокий передок с отверстием под обмотку, узкое стремя.
  'narrow-stirrup': { rows: [[-38, 3.0, 2.4, -3.8], [-31, 3.2, 2.3, -3.1], [-26, 3.2, 2.2, -2.3], [-9, 3.4, 2.2, -2.2], [20, 3.2, 2.0, -2.0], [44, 2.4, 1.6, -1.4], [46, 2.0, 1.4, -1.0]], nut: -9, span: 64, stirrup: 'narrow', pow: 3.2 },
  // Каменный арбалет: передняя половина выгнута вниз «лебединой шеей», задняя — восьмигранная, луковичное навершие.
  'stonebow-bent': { rows: [[-46, 2.6, -6.0, -10.4], [-42, 2.2, -6.6, -9.6], [-36, 1.9, -6.8, -9.0], [-29, 1.9, -5.6, -7.8], [-22, 2.0, -3.2, -5.4], [-15, 2.2, -0.4, -2.8], [-10, 2.8, 1.4, -1.8], [2, 2.8, 1.4, -1.8], [8, 2.5, 1.3, -1.6], [38, 2.3, 1.2, -1.5], [40, 2.1, 1.1, -1.3]], nut: -7, span: 56, stirrup: 'none', pow: 2, sides: 8, tilt: 12, pellet: true },
  // Шнеппер: изящное ложе ≈70 см с угловатым ружейным прикладом, дуга сквозь окно передка.
  schnepper: { rows: [[-38, 2.4, 1.4, -2.6], [-33, 2.8, 1.5, -2.4], [-14, 3.0, 1.5, -2.2], [-6, 3.4, 1.6, -2.6], [2, 3.0, 1.4, -2.6], [7, 3.2, 1.2, -3.6], [14, 3.6, 0.9, -6.6], [24, 3.8, 0.4, -9.6], [31, 3.9, 0.0, -11.0], [32, 3.9, -0.1, -11.0]], nut: -6, span: 61, stirrup: 'none', pow: 4, prodAt: 3, prodZ: 'mid', tailMax: 1 },
  // Кугельшнеппер: прямая тонкая стальная колонна, сзади насажен деревянный приклад; рычаг взвода по верху.
  'kugel-lever': { rows: [[-44, 1.6, 1.0, -1.2], [-6, 1.8, 1.0, -1.2], [-4.5, 3.0, 1.6, -2.4], [3, 3.8, 1.3, -3.0], [9, 3.8, 1.0, -5.0], [19, 3.8, 0.4, -8.4], [25, 3.8, 0.1, -9.8], [26, 3.8, 0.0, -9.8]], nut: -9, span: 44, stirrup: 'none', pow: 6, sides: 8, pellet: true, tailMax: 0.5, body: [-44, -3] },
  // Чжугэ-ну: брус ≈75 см, на нём высокий короб-магазин ≈40×4×12 и рама-рычаг назад-вверх; бамбуковая дуга.
  'zhuge-magazine': { rows: [[-48, 4.6, 2.4, -2.6], [-44, 4.8, 2.5, -2.5], [20, 4.8, 2.5, -2.5], [27, 4.4, 2.2, -2.3]], nut: -3, span: 96, stirrup: 'none', pow: 5, prodAt: 4 },
  // ── арбалеты ──
  // «В две ноги»: длинное тонкое прямое ложе, хвост симметрично сужается; широкое стремя, полосы рога.
  'wide-stirrup': { rows: [[-40, 3.6, 2.6, -4.4], [-33, 3.8, 2.6, -3.6], [-27, 3.8, 2.5, -2.6], [-10, 4.0, 2.5, -2.5], [26, 3.8, 2.3, -2.3], [46, 2.8, 1.8, -1.8], [50, 2.2, 1.4, -1.4]], nut: -10, span: 76, stirrup: 'wide', pow: 3.6 },
  // Испанское: тонкий прямой почти квадратный брус; Г-образные щёки у ореха, поперечный штифт под козью ногу.
  'spanish-straight': { rows: [[-36, 3.4, 1.9, -1.9], [30, 3.4, 1.9, -1.9], [52, 2.6, 1.5, -1.5]], nut: -6, span: 68, stirrup: 'none', pow: 7, sides: 8 },
  // Halbe Rüstung: коренастое ложе, вздутое у ореха; короткий плоский приклад по оси со щекой слева.
  'cheek-butt': { rows: [[-34, 3.4, 2.6, -2.0], [-24, 3.6, 2.6, -2.2], [-18, 4.8, 2.8, -2.8], [-12, 6.2, 3.0, -3.4], [-5, 5.2, 2.9, -3.1], [3, 3.8, 2.6, -2.9], [10, 4.0, 2.6, -3.7], [22, 4.3, 2.5, -4.4], [31, 4.5, 2.4, -4.6], [33, 4.5, 2.4, -4.6]], nut: -12, span: 68, stirrup: 'none', pow: 4, prodAt: 2, tailMax: 1 },
  // Слёрбоу: кранекинное ложе XVI в., поверх жёлоба — «ствол»-трубка.
  barrel: { rows: [[-36, 3.6, 2.4, -1.8], [-26, 3.8, 2.4, -2.2], [-15, 5.0, 2.6, -2.8], [-5, 5.2, 2.6, -2.8], [3, 4.2, 2.4, -2.8], [26, 3.4, 2.0, -3.8], [34, 3.0, 1.6, -3.6], [36, 2.6, 1.4, -3.0]], nut: -10, span: 66, stirrup: 'none', pow: 4 },
  // Ханьский ну: прямой брус без приклада, бронзовый замок в кожухе с прицелом, вертикальная рукоять за ним.
  'vertical-grip': { rows: [[-60, 4.4, 3.0, -3.0], [-2, 4.6, 3.0, -3.2], [6, 4.4, 2.8, -3.0]], nut: -8, span: 118, stirrup: 'none', pow: 6, sides: 8, prodAt: 3.5, prodZ: 'mid', tailMax: -0.7, loop: [0, 1.5, -12.3] },
  // ── тяжёлые ──
  // Под кранекин: короткое, передок с прорезью под дугу, «плечо», выпуклая середина у ореха, тонкий хвост.
  'cranequin-pin': { rows: [[-36, 3.8, 2.4, -1.8], [-26, 3.8, 2.4, -2.0], [-24.6, 5.4, 2.9, -2.9], [-12, 6.2, 3.1, -3.0], [-3, 5.6, 2.9, -2.9], [6, 4.2, 2.4, -2.8], [34, 2.8, 1.6, -3.8], [36, 2.4, 1.3, -3.4]], nut: -12, span: 66, stirrup: 'small', pow: 4, prodZ: 'mid' },
  // Ganze Rüstung: массивное ружейное ложе — толстая шейка, глубокий приклад со щекой, львиные головы штифта.
  'ganze-ruestung': { rows: [[-40, 5.6, 3.4, -3.0], [-30, 5.8, 3.4, -3.2], [-23, 6.8, 3.6, -3.8], [-16, 7.6, 3.8, -4.2], [-8, 7.2, 3.6, -4.0], [1, 6.4, 3.3, -4.3], [8, 6.6, 3.0, -6.6], [24, 7.0, 2.5, -11.2], [41, 7.2, 2.1, -13.4], [43, 7.2, 2.1, -13.4]], nut: -16, span: 84, prodK: 1.22, stirrup: 'none', pow: 4, prodAt: 2.4, tailMax: 0 },
  // Мишенное: длинное тяжёлое ложе, передок за дугой, большой изогнутый упор под левую руку, латунный хвост.
  'target-rest': { rows: [[-50, 4.2, 3.0, -3.4], [-44, 4.8, 3.1, -4.0], [-34, 5.0, 3.1, -4.0], [-16, 5.6, 3.2, -3.6], [-4, 5.4, 3.1, -3.4], [6, 4.8, 2.8, -4.0], [30, 4.6, 2.4, -5.0], [52, 4.4, 1.9, -6.2], [59, 4.2, 0.8, -7.2], [62, 4.2, 0.3, -7.6]], nut: -16, span: 80, stirrup: 'triple', pow: 4, prodAt: 8, prodZ: 'mid', tailMax: 4 },
  // Шэньби-гун: прямое ложе ≈1 м из горной шелковицы, большое железное «конское» стремя, бронзовый замок.
  'horse-stirrup': { rows: [[-80, 4.8, 2.8, -3.6], [-73, 4.4, 2.8, -3.0], [12, 4.4, 2.8, -3.0], [20, 4.0, 2.6, -2.8]], nut: -9, span: 92, stirrup: 'horse', pow: 5, prodAt: 4, tailMax: -1.2, loop: [0, 1, -11.1] },
  // ── аркбаллисты ──
  // Под ворот: длинное прямое ложе, высокий передок, заострённый хвост в колпачке; прицельная планка.
  'windlass-long': { rows: [[-44, 4.2, 3.0, -5.9], [-37, 4.4, 3.0, -4.9], [-22, 4.6, 2.9, -3.4], [-8, 4.8, 2.8, -3.0], [20, 4.2, 2.4, -2.4], [38, 3.4, 2.1, -2.1], [45, 2.6, 1.6, -1.6], [47, 2.0, 1.1, -1.1]], nut: -8, span: 80, stirrup: 'big', pow: 6, sides: 8 },
  // Крепостное: 125 см, глубокий «кулак» под толстую дугу, широкая шея, узкий хвост; вертлюг треножника.
  rampart: { rows: [[-62, 7.6, 4.2, -8.4], [-55, 7.2, 4.0, -7.6], [-48, 5.8, 3.4, -4.8], [-32, 6.2, 3.4, -4.2], [-20, 7.2, 3.6, -4.4], [-8, 6.4, 3.4, -4.0], [20, 5.0, 3.0, -3.2], [56, 3.8, 2.4, -2.4], [63, 3.0, 1.9, -1.9]], nut: -20, span: 97, stirrup: 'big', stirrupK: 1.3, pow: 6, sides: 8, prodAt: 4.5, prodZ: 'mid' },
  // Гастрафет: корпус с зубчатыми рейками, ползун сверху далеко за дугу, вогнутый полумесяц под живот.
  'belly-slider': { rows: [[-50, 4.4, 4.0, -3.6], [4, 4.4, 4.0, -3.2], [6.5, 4.4, 1.6, -3.2], [30, 4.4, 1.6, -3.2], [37, 5.2, 1.8, -3.8]], nut: -2, span: 116, stirrup: 'none', pow: 5, prodAt: 3, prodZ: -1.0, tail: 28, body: false },
  // Поясной (腰開弩): короткий толстый брус ≈53 см под огромную дугу ≈195 см, бронзовый замок, ушко под крюк.
  'waist-short': { rows: [[-34, 6.6, 3.8, -4.6], [-27, 6.0, 3.4, -3.6], [-10, 6.0, 3.4, -3.4], [16, 5.6, 3.2, -3.2], [19, 5.2, 3.0, -3.0]], nut: -5, span: 190, stirrup: 'none', pow: 6, sides: 8, prodAt: 3.5, prodZ: 'mid', tailMax: 9 },
};

/** Граней сечения ложа: округлым — 10, брусу (pow ≥ 4) хватит 8. */
const sidesOf = (s: StockSpec): number => s.sides ?? (s.pow >= 4 ? 8 : 10);

/** Деревянный приклад кугельшнеппера, насаженный на стальную колонну. */
const KUGEL_BUTT: Row[] = [[-4.5, 3.0, 1.6, -2.4], [3, 3.8, 1.3, -3.0], [9, 3.8, 1.0, -5.0], [19, 3.8, 0.4, -8.4], [25, 3.8, 0.1, -9.8], [26, 3.8, 0.0, -9.8]];
/** Неподвижный корпус гастрафета (под ползуном). */
const GASTRA_CASE: Row[] = [[-50, 4.4, 1.6, -3.6], [-44, 4.4, 1.6, -3.2], [30, 4.4, 1.6, -3.2], [37, 5.2, 1.8, -3.8]];

/** Стремя в плоскости ложа: контур от носа вперёд (x, dy) и толщина прута. */
const STIRRUPS: Record<Exclude<StirrupKind, 'none'>, { pts: V2[]; r: number }> = {
  wide: { pts: [[-1.6, 2], [-7, -3], [-10.5, -9], [-10.5, -15], [-6, -17], [6, -17], [10.5, -15], [10.5, -9], [7, -3], [1.6, 2]], r: 0.6 },
  narrow: { pts: [[-1.2, 2], [-4.8, -3], [-5.6, -8], [-3.6, -12.5], [0, -13.5], [3.6, -12.5], [5.6, -8], [4.8, -3], [1.2, 2]], r: 0.5 },
  small: { pts: [[-1.4, 2], [-4, -2.5], [-4.6, -7], [-2.5, -10], [2.5, -10], [4.6, -7], [4, -2.5], [1.4, 2]], r: 0.72 },
  big: { pts: [[-2.2, 2], [-6.5, -2.5], [-8.6, -9], [-7.6, -15.5], [-3.8, -18], [3.8, -18], [7.6, -15.5], [8.6, -9], [6.5, -2.5], [2.2, 2]], r: 1.0 },
  triple: { pts: [[-1.8, 2], [-5.5, -3], [-6.8, -9], [-5, -14], [0, -15], [5, -14], [6.8, -9], [5.5, -3], [1.8, 2]], r: 0.62 },
  horse: { pts: [[-1.6, 2.5], [-2.2, 0], [-4, -3], [-7.2, -8], [-8.4, -13], [-7.6, -16.5], [7.6, -16.5], [8.4, -13], [7.2, -8], [4, -3], [2.2, 0], [1.6, 2.5]], r: 0.8 },
};

const BRASS = 0xc9a24a;
const COPPER = 0xb87333;
const BRONZE = 0x9a7038;
const LACQUER = 0x1d1614;
const LACQUER_RED = 0x8e2a1c;
const HOLE = 0x120d0a;
const PEARL = 0xe9e6de;
const IVORY = 0xf1e9d6;
const SNAKEWOOD = 0x6b2d1c;
const GOLD = 0xd4af37;
const PAINT = 0x7c2a1e;
const DARK_WOOD = 0x2a1d14;
const THREAD = 0x55575c;

function rowAt(rows: Row[], y: number): { w: number; zt: number; zb: number } {
  const f = rows[0]!, l = last(rows);
  if (y <= f[0]) return { w: f[1], zt: f[2], zb: f[3] };
  if (y >= l[0]) return { w: l[1], zt: l[2], zb: l[3] };
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]!, b = rows[i + 1]!;
    if (y <= b[0]) { const t = (y - a[0]) / (b[0] - a[0] || 1); return { w: lerp(a[1], b[1], t), zt: lerp(a[2], b[2], t), zb: lerp(a[3], b[3], t) }; }
  }
  return { w: l[1], zt: l[2], zb: l[3] };
}

/**
 * Станции протяжки на [y0, y1]: концы и изломы профиля. Профиль между строками линеен, поэтому
 * промежуточные станции формы не меняют — только тратят вершины.
 */
function rowStations(rows: Row[], y0: number, y1: number): number[] {
  return [y0, ...rows.map((r) => r[0]).filter((y) => y > y0 + 0.05 && y < y1 - 0.05), y1];
}

/** Ложе протяжкой по профилю строк от y0 до y1; `grow` — припуск (обшивка, колпачок поверх дерева). */
function stockSweep(rows: Row[], mat: Mat, pow: number, sides: number, y0 = rows[0]![0], y1 = last(rows)[0], grow = 0): THREE.Mesh {
  const ys = rowStations(rows, y0, y1);
  const r = ys.map((y) => rowAt(rows, y));
  return sweep(ys.map((y) => [0, y] as V2), r.map((q) => q.w + 2 * grow), r.map((q) => q.zt - q.zb + 2 * grow), mat,
    { pow, sides, z: r.map((q) => (q.zt + q.zb) / 2) });
}

/** Плоская деталь с контуром в плоскости YZ и прорезями (толщина по X). */
function plateYZ(outline: YZ[], depth: number, mat: Mat, x: number, holes: YZ[][] = []): THREE.Mesh {
  const sw = (p: YZ[]): V2[] => p.map(([y, z]) => [z, y] as V2);
  const m = extrudeXY(sw(outline), depth, mat, { holes: holes.map(sw) });
  m.geometry.rotateY(-Math.PI / 2);
  m.position.x = x;
  return m;
}

/** Овальная накладка на боковую грань (плоскость YZ): полуоси по Y и Z, толщина по X. */
function ovalSide(ry: number, rz: number, t: number, mat: Mat, x: number, y: number, z: number, seg = 10): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(1, 1, t, seg);
  geo.scale(ry, 1, rz);
  geo.rotateZ(Math.PI / 2);
  return at(mesh(geo, mat), x, y, z);
}

/** Овальная вставка на верхнюю грань (плоскость XY). */
function ovalTop(rx: number, ry: number, t: number, mat: Mat, x: number, y: number, z: number, seg = 10): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(1, 1, t, seg);
  geo.scale(rx, 1, ry);
  geo.rotateX(Math.PI / 2);
  return at(mesh(geo, mat), x, y, z);
}

const ringGeo = (R: number, r: number, seg: number): THREE.TorusGeometry => new THREE.TorusGeometry(R, r, 4, seg);
/** Кольцо в плоскости YZ (ось по X): антабка, кольцо подвеса, «эстрибо». */
const ringX = (R: number, r: number, mat: Mat, x: number, y: number, z: number, seg = 10): THREE.Mesh => at(mesh(ringGeo(R, r, seg), mat), x, y, z, 0, Math.PI / 2, 0);
/** Кольцо в плоскости XZ (ось по Y): диоптр, обойма вокруг колонны или ствола. */
const ringY = (R: number, r: number, mat: Mat, x: number, y: number, z: number, seg = 10): THREE.Mesh => at(mesh(ringGeo(R, r, seg), mat), x, y, z, Math.PI / 2, 0, 0);

/** Что мебели ложа нужно знать о сборке. */
interface Kit {
  add(...o: THREE.Object3D[]): void;
  R(y: number): { w: number; zt: number; zb: number };
  zc(y: number): number;
  s: StockSpec;
  ctx: MeshCtx;
  front: number;
  butt: number;
  /** Центр дуги по Y и Z и её толщина по Z у ложа. */
  yProd: number;
  zP: number;
  pw: number;
  wood: Mat; iron: Mat; cord: Mat; hide: Mat; handWood: Mat; bone: Mat; horn: Mat; brass: Mat; bronze: Mat; dark: Mat;
}

/** Вилка-мушка каменного арбалета: две стойки над носом, между ними нить с бусиной. */
function forkSight(K: Kit, y: number, h: number, hx: number): void {
  const z0 = K.R(y).zt;
  for (const sx of [1, -1]) K.add(at(box(0.3, 0.45, h, K.iron), sx * hx, y, z0 + h / 2));
  K.add(rod([-hx, y, z0 + h - 0.35], [hx, y, z0 + h - 0.35], 0.07, K.cord, 4));
  K.add(at(box(0.5, 0.5, 0.5, K.bone), 0, y, z0 + h - 0.35, 0, 0.785, 0.615));
}

/** Диоптр: стойка с кольцом над ложем. */
function peepSight(K: Kit, y: number, h: number): void {
  const z0 = K.R(y).zt;
  K.add(at(box(0.35, 0.3, h, K.iron), 0, y, z0 + h / 2));
  K.add(ringY(0.55, 0.14, K.iron, 0, y, z0 + h + 0.5, 8));
}

/** Спусковая скоба под ложем от y0 до y1. */
function triggerGuard(K: Kit, y0: number, y1: number, depth: number, r: number, mat: Mat): THREE.Mesh {
  const z0 = K.R(y0).zb, z1 = K.R(y1).zb, zl = Math.min(z0, z1) - depth;
  return tube([[0, y0, z0 + 0.3], [0, y0 - 0.4, z0 - depth * 0.6], [0, lerp(y0, y1, 0.3), zl], [0, lerp(y0, y1, 0.72), zl + depth * 0.08],
    [0, y1 + 0.3, z1 - depth * 0.4], [0, y1, z1 + 0.3]], r, mat, { segments: 16, radial: 4 });
}

/** Железная (бронзовая) обойма-муфта вокруг ложа в точке y: коробка чуть больше сечения. */
function band(K: Kit, y: number, len: number, grow: number, mat: Mat): THREE.Mesh {
  const r = K.R(y);
  return at(box(r.w + 2 * grow, len, r.zt - r.zb + 2 * grow, mat), 0, y, K.zc(y));
}

/** Сквозной поперечный штифт под петлю кранекина: концы торчат «ушами» на `out` см. */
function cranequinPin(K: Kit, y: number, out: number): void {
  const r = K.R(y), z = K.zc(y);
  K.add(cylX(0.55, r.w + 2 * out, K.iron, 0, y, z, 8));
  for (const sx of [1, -1]) K.add(at(sphere(0.9, K.iron, 5), sx * (r.w / 2 + out), y, z));
}

/** Пара вертикальных скоб, охватывающих дугу спереди по бокам носа; `wedge` — с клиньями. */
function prodClamps(K: Kit, wedge: boolean): void {
  const y = K.yProd, z = K.zP, hz = K.pw / 2 + 0.7;
  for (const sx of [1, -1]) {
    const x = sx * (K.R(y).w / 2 + 1.0);
    K.add(tube([[x, y + 1.5, z - hz], [x, y - 1.2, z - hz], [x, y - 1.8, z], [x, y - 1.2, z + hz], [x, y + 1.5, z + hz]], 0.3, K.iron, { segments: 10, radial: 4 }));
    if (wedge) K.add(at(box(0.8, 1.0, 2 * hz - 0.4, K.handWood), x, y + 1.8, z));
  }
}

/** Ремни крест-накрест от стремени через дугу. */
function crossStraps(K: Kit, mat: Mat, wS: number): void {
  const z = K.zP + K.pw / 2 + 0.15;
  for (const a of [0.7, -0.7]) K.add(at(box(wS, 9, 0.28, mat), 0, K.yProd - 1.2, z, 0, 0, a));
}

/** Бронзовый замок китайского типа в кожухе, врезанном в ложе; `wangshan` — прицельная пластина с делениями. */
function chineseLock(K: Kit, len: number, wangshan: boolean): void {
  const y = K.s.nut, r = K.R(y);
  K.add(at(box(r.w + 0.3, len, 3.0, K.bronze), 0, y + len * 0.1, r.zt - 1.35));
  if (!wangshan) return;
  const ys = y + 3.4, zs = r.zt + 0.15;
  K.add(at(box(1.7, 0.3, 4.6, K.bronze), 0, ys, zs + 2.3));
  for (let i = 1; i <= 4; i++) K.add(at(box(1.1, 0.06, 0.1, K.dark), 0, ys + 0.17, zs + 0.9 * i));
}

/** Вертикальная цилиндрическая рукоять под ложем с бронзовым торцом. */
function verticalGrip(K: Kit, y: number, len: number, r: number): void {
  const zb = K.R(y).zb;
  K.add(at(cyl(r, r * 0.9, len, K.wood, 10), 0, y, zb - len / 2 + 0.5, Math.PI / 2));
  K.add(at(cyl(r * 1.06, r * 1.06, 0.9, K.bronze, 10), 0, y, zb - len + 0.3, Math.PI / 2));
}

/** Металлический колпачок на хвосте (на него надевают коробку ворота). */
function tailCap(K: Kit, len: number): void {
  K.add(stockSweep(K.s.rows, K.iron, K.s.pow, sidesOf(K.s), K.butt - len, K.butt, 0.12));
}

/** Накладки полосой по обеим боковым граням от y0 до y1: доля высоты и сдвиг центра вверх (в долях высоты). */
function sideStrips(K: Kit, y0: number, y1: number, mat: Mat, frac: number, up: number): void {
  const iy = rowStations(K.s.rows, y0, y1);
  const h = (y: number): number => K.R(y).zt - K.R(y).zb;
  for (const sx of [1, -1]) {
    K.add(sweep(iy.map((y) => [sx * (K.R(y).w / 2 + 0.05), y] as V2), fill(iy.length, 0.14), iy.map((y) => h(y) * frac), mat,
      { pow: 5, sides: 6, z: iy.map((y) => K.zc(y) + h(y) * up) }));
  }
}

/** Полоса по верху (или низу) ложа: роговая облицовка, направляющая болта. */
function topStrip(K: Kit, y0: number, y1: number, mat: Mat, frac: number, bottom = false): void {
  const iy = rowStations(K.s.rows, y0, y1);
  K.add(sweep(iy.map((y) => [0, y] as V2), iy.map((y) => K.R(y).w * frac), fill(iy.length, 0.16), mat,
    { pow: 6, sides: 6, z: iy.map((y) => (bottom ? K.R(y).zb - 0.05 : K.R(y).zt + 0.05)) }));
}

/** Мебель каждого ложа: то, что делает силуэт узнаваемым (рукояти, приклады, магазины, упоры, прицелы). */
const FURNITURE: Record<string, (K: Kit) => void> = {
  pistol(K) {
    // Рукоять кремнёвого пистолета: наклонная, с латунным затыльником; перед ней — латунная скоба спуска.
    const hp: YZ[] = [[-1.0, 6.2], [-0.6, 3.4], [0.4, -0.2], [1.9, -3.6], [3.8, -6.8]];
    K.add(sweepYZ(hp, [3.0, 3.3, 3.3, 3.3, 3.3], [2.5, 2.6, 2.7, 2.7, 2.6], K.wood, { pow: 3, sides: 10 }));
    K.add(at(sphere(1.7, K.wood, 10), 0, 4.3, -7.6));
    const cap = sphere(1.72, K.brass, 10);
    cap.scale.set(1.08, 1, 0.5);
    K.add(at(cap, 0, 4.7, -8.3, -0.55));
    K.add(tube([[0, -9.6, 4.2], [0, -10.1, 2.0], [0, -8.2, -1.0], [0, -4.8, -2.0], [0, -2.2, -1.2], [0, -1.3, 0.6]], 0.3, K.brass, { segments: 18, radial: 5 }));
    const f = K.R(K.front);
    K.add(at(box(f.w + 0.4, 2.2, f.zt - f.zb + 0.4, K.iron), 0, K.front + 0.9, K.zc(K.front)));
    // Латунный ствол-жёлоб с продольной прорезью по верху (по ней ходит тетива), мушка на дульце, целик за замком.
    const y0 = K.front + 4.4, y1 = K.s.nut - 2.2, zB = K.R(y1).zt + 0.75;
    K.add(at(cyl(1.05, 1.05, y1 - y0, K.brass, 12), 0, (y0 + y1) / 2, zB));
    K.add(at(box(0.36, y1 - y0 + 0.04, 0.12, K.dark), 0, (y0 + y1) / 2, zB + 1.0));
    K.add(ringY(1.1, 0.16, K.brass, 0, y0 + 0.3, zB));
    K.add(at(sphere(0.34, K.brass, 6), 0, y0 + 1.1, zB + 1.3));
    for (const sx of [1, -1]) K.add(at(box(0.5, 0.35, 1.1, K.iron), sx * 0.45, K.s.nut + 4.5, K.R(K.s.nut + 4.5).zt + 0.5));
  },

  balestrino(K) {
    // Полый стальной брусок: сплошной верх, в боковых гранях сквозной паз, в нём винт-домкрат с ползуном.
    const { front: y0, butt: y1 } = K, L = y1 - y0, ym = (y0 + y1) / 2, w = 2.6, h = 2.8;
    // Верх и низ сплошные (открыт брусок только с боков — иначе снизу видно пустой жёлоб, а спуск висит в нём).
    K.add(at(box(w, L, 0.5, K.wood), 0, ym, h / 2 - 0.25), at(box(w, L, 0.4, K.wood), 0, ym, -h / 2 + 0.2));
    const side: YZ[] = [[y0, -h / 2], [y1, -h / 2], [y1, h / 2 - 0.45], [y0, h / 2 - 0.45]];
    const slot: YZ[] = [[y0 + 3.5, -0.5], [y1 - 2.5, -0.5], [y1 - 2.5, 0.5], [y0 + 3.5, 0.5]];
    for (const sx of [1, -1]) K.add(plateYZ(side, 0.4, K.wood, sx * (w / 2 - 0.2), [slot]));
    // Нос: колодка, сквозь которую идёт дуга, и две стальные скобы-«стремечки», охватывающие её спереди.
    const yP = K.yProd;
    K.add(at(box(3.4, 2.4, 3.4, K.wood), 0, yP, 0));
    for (const sx of [1, -1]) {
      const x = sx * 2.4;
      K.add(tube([[x, yP + 0.9, -1.5], [x, yP - 1.2, -1.5], [x, yP - 1.8, 0], [x, yP - 1.2, 1.5], [x, yP + 0.9, 1.5]], 0.26, K.iron, { segments: 10, radial: 4 }));
    }
    // Винт с резьбой спиралью и гайка-ползун, берущая тетиву, — видны в пазу.
    const s0 = y0 + 2, s1 = y1 + 1.2;
    K.add(at(cyl(0.4, 0.4, s1 - s0, K.iron, 6), 0, (s0 + s1) / 2, 0));
    const hel: V3[] = [];
    const turns = 10;
    for (let i = 0; i <= turns * 4; i++) { const t = i / (turns * 4), q = t * turns * Math.PI * 2; hel.push([0.48 * Math.cos(q), lerp(y0 + 3, y1 - 2, t), 0.48 * Math.sin(q)]); }
    K.add(tube(hel, 0.11, K.ctx.fixed(THREAD, 0.8, 0.4), { segments: turns * 4, radial: 3 }));
    K.add(at(box(1.7, 1.6, 1.3, K.iron), 0, K.s.nut + 1.4, 0));
    // Головка винта с поперечным воротком за задним торцом; взводят двумя руками.
    K.add(at(box(1.7, 1.4, 1.7, K.wood), 0, y1 + 0.7, 0));
    K.add(cylX(0.26, 7.2, K.iron, 0, y1 + 1.9, 0, 8));
    for (const sx of [1, -1]) K.add(at(sphere(0.55, K.iron, 5), sx * 3.6, y1 + 1.9, 0));
    // Поясная клипса на боковой грани: пружинная полоса, приклёпанная задним концом.
    K.add(at(box(0.22, 7, 1.4, K.wood), -(w / 2 + 0.55), -1, 0), at(box(0.5, 1.0, 1.0, K.wood), -(w / 2 + 0.25), 2.0, 0));
  },

  'lady-stonebow'(K) {
    // Точёное навершие заднего бруска (приклада нет); обойма на перегибе; вилка-мушка на носу, складной диоптр.
    const b = K.butt, zE = K.zc(b);
    K.add(at(lathe([[0.85, b - 0.4], [1.2, b + 0.6], [0.7, b + 1.5], [1.3, b + 2.7], [0.95, b + 3.6], [0.05, b + 4.0]], K.wood, 10), 0, 0, zE));
    K.add(band(K, -12, 0.9, 0.18, K.iron));
    forkSight(K, K.front + 0.8, 7, 1.0);
    peepSight(K, K.s.nut + 3.5, 2.2);
  },

  'chu-repeater'(K) {
    const lac = K.ctx.fixed(LACQUER, 0.1, 0.3), red = K.ctx.fixed(LACQUER_RED, 0.1, 0.4);
    // Чёрный лакированный короб-магазин с красными поясками: спереди две полукруглые бойницы, сверху щель заряжания.
    const m0 = K.front + 1.6, m1 = K.s.nut - 2.8, zm = K.R(0).zt, mh = 6.0, mw = 5.4, ym = (m0 + m1) / 2;
    K.add(at(box(mw, m1 - m0, mh, lac), 0, ym, zm + mh / 2));
    for (const y of [m0 + 0.5, m1 - 0.5]) K.add(at(box(mw + 0.14, 0.45, mh + 0.14, red), 0, y, zm + mh / 2));
    K.add(at(box(1.3, m1 - m0 - 3, 0.1, K.dark), 0, ym, zm + mh + 0.02));
    for (const sx of [1, -1]) {
      K.add(at(mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.12, 10, 1, false, -Math.PI / 2, Math.PI), K.dark), sx * 1.35, m0 - 0.05, zm + 1.0));
      // Две стрелы рядом в центральном жёлобе — бронзовые наконечники торчат из-под короба.
      K.add(rod([sx * 0.45, m0 + 1, zm + 0.45], [sx * 0.45, m0 - 3.4, zm + 0.45], 0.2, K.handWood, 5));
      K.add(at(cone(0.32, 1.2, K.bronze, 6), sx * 0.45, m0 - 4.0, zm + 0.45, 0, 0, Math.PI));
    }
    // Пистолетная рукоять из-под узла дуги (передняя треть бруса).
    const hp: YZ[] = [[-0.8, K.R(0).zb + 1.0], [0.2, -4.4], [1.5, -7.4], [2.8, -9.8]];
    K.add(sweepYZ(hp, fill(hp.length, 2.8), [2.6, 2.7, 2.7, 2.6], K.wood, { pow: 3, sides: 10 }));
    K.add(at(box(3.0, 1.4, 1.1, lac), 0, 3.3, -10.5, -0.45));
    // Сзади подвижный рычаг на бронзовой оси со шнурком-рукояткой: он и тянет тетиву, спуска нет.
    const yl = K.butt - 2.2, zl = K.R(K.butt).zb + 1.2;
    K.add(cylX(0.4, K.R(K.butt).w + 1.2, K.bronze, 0, yl, zl, 8));
    const lv: YZ[] = [[yl, zl], [yl + 2.4, zl + 4], [yl + 4.2, zl + 8.2], [yl + 5.0, zl + 11.2]];
    K.add(sweepYZ(lv, fill(lv.length, 1.3), fill(lv.length, 1.8), lac, { pow: 4, sides: 8 }));
    K.add(ringX(1.1, 0.16, K.cord, 0, yl + 5.3, zl + 12.6));
  },

  'narrow-stirrup'(K) {
    // Высокий передок со сквозным отверстием под обмотку дуги; стремя привязано ремнями крест-накрест с дугой.
    const yh = K.front + 5.5;
    K.add(cylX(0.85, K.R(yh).w + 0.08, K.dark, 0, yh, K.zc(yh) - 0.7, 10));
    crossStraps(K, K.hide, 0.8);
  },

  'stonebow-bent'(K) {
    const b = K.butt, zE = K.zc(b);
    // Луковичное навершие с перламутровым затыльником (конец прижимают к щеке, это не плечевой приклад).
    K.add(at(lathe([[1.05, b - 0.5], [1.7, b + 1.2], [2.1, b + 2.9], [1.5, b + 4.6], [1.05, b + 5.4], [0.05, b + 5.6]], K.wood, 10), 0, 0, zE));
    K.add(at(cyl(1.0, 1.0, 0.25, K.ctx.fixed(PEARL, 0.2, 0.25), 10), 0, b + 5.5, zE));
    // Резной завиток на верхней задней грани.
    const cy = 24, cz = K.R(cy).zt + 2.3;
    const sc: V3[] = [[0, cy - 4.2, K.R(cy - 4.2).zt - 0.1]];
    for (let i = 0; i <= 10; i++) { const t = i / 10, a = Math.PI - t * 1.75 * Math.PI, r = 2.1 * (1 - 0.6 * t); sc.push([0, cy + r * Math.cos(a), cz + r * Math.sin(a)]); }
    K.add(tube(sc, 0.34, K.wood, { segments: 24, radial: 4 }));
    // Дуга с наклоном вверх — в паре вертикальных стальных скоб с клиньями; высокая вилка-мушка, диоптр над замком.
    prodClamps(K, true);
    forkSight(K, K.front + 0.7, 10.5, 1.3);
    peepSight(K, K.s.nut + 4.5, 2.6);
  },

  schnepper(K) {
    const n = K.s.nut;
    // Щека на левой грани приклада — гравированный рог; роговой затыльник.
    K.add(ovalSide(6.5, 2.4, 0.3, K.horn, K.R(20).w / 2 + 0.1, 20, K.zc(20) + 0.8));
    const rb = K.R(K.butt);
    K.add(at(box(rb.w + 0.25, 0.7, rb.zt - rb.zb + 0.2, K.horn), 0, K.butt + 0.3, K.zc(K.butt)));
    // Болт лежит на костяной опоре у носа; над его хвостом роговая пружина-прижим с V-прорезью (она же целик).
    const yb = K.front + 7;
    K.add(at(box(2.0, 0.8, 0.6, K.bone), 0, yb, K.R(yb).zt + 0.3));
    const ys = n + 6, zs = K.R(ys).zt;
    K.add(sweepYZ([[ys, zs + 0.1], [ys - 3, zs + 0.9], [ys - 6.5, zs + 1.4]], [0.3, 0.3, 0.26], [1.3, 1.2, 1.0], K.horn, { pow: 4, sides: 6 }));
    for (const sx of [1, -1]) K.add(at(box(0.35, 0.3, 0.7, K.horn), sx * 0.35, ys - 6.5, zs + 1.8));
    // Овальная выемка под большой палец за замком.
    K.add(ovalTop(0.9, 1.8, 0.08, K.ctx.fixed(DARK_WOOD, 0, 0.9), 0, n + 10, K.R(n + 10).zt + 0.02));
    // Спуск со скобой; железная петля на носке под крюк толкающего рычага; пеньковая обмотка дуги в окне передка.
    K.add(triggerGuard(K, n + 1.5, n + 8.5, 3.0, 0.26, K.iron));
    K.add(ringX(0.9, 0.2, K.iron, 0, K.front + 1.4, K.R(K.front + 1.4).zb - 0.8));
    for (const dy of [-1.9, 1.9]) { const y = K.yProd + dy, r = K.R(y); K.add(lashing(y, r.w, r.zt, r.zb, 0.2, K.cord)); }
  },

  'kugel-lever'(K) {
    // Деревянный приклад ружейного типа насажен на стальную колонну; облицован гравированной костью, щека слева.
    K.add(stockSweep(KUGEL_BUTT, K.ctx.matOf('wood', K.ctx.parts.grip.step), 4, 10));
    const yy = [5, 14, 24];
    const pl: YZ[] = [...yy.map((y) => [y, K.R(y).zt - 0.8] as YZ), ...[...yy].reverse().map((y) => [y, K.R(y).zb + 0.8] as YZ)];
    K.add(plateYZ(pl, 0.5, K.bone, 1.9 + 0.2));
    // Встроенный рычаг взвода по верху колонны: шарнир за дугой, кольцо-защёлка у приклада; по колонне ездит коробка с крюком.
    const zL = K.R(-20).zt + 0.3;
    K.add(at(box(1.1, 25.5, 0.5, K.iron), 0, -25.75, zL));
    K.add(cylX(0.4, 2.6, K.iron, 0, -38.5, zL - 0.1, 6));
    K.add(ringY(1.5, 0.2, K.iron, 0, -14.8, 0.2));
    K.add(at(box(2.6, 3.0, 2.8, K.iron), 0, K.s.nut - 3.3, K.zc(K.s.nut - 3.3)));
    // Вилка-мушка, ажурный диоптр, спуск со скобой, предохранитель перед прикладом.
    forkSight(K, K.front + 0.8, 4.5, 0.8);
    peepSight(K, -2.2, 2.2);
    K.add(triggerGuard(K, -5.5, 2, 2.6, 0.24, K.iron));
    K.add(at(box(0.3, 1.6, 0.6, K.iron), 1.05, -7, 0));
  },

  'zhuge-magazine'(K) {
    // Высокий короб-магазин на 10–12 болтов: нижний брусок с жёлобом и вырезом под тетиву, железные обоймы.
    const m0 = K.front + 6.5, m1 = K.s.nut - 2.2, z0 = K.R(m0).zt, ym = (m0 + m1) / 2;
    K.add(at(box(4.9, m1 - m0, 2.2, K.wood), 0, ym, z0 + 1.1));
    K.add(at(box(4.2, m1 - m0 - 1.2, 10, K.wood), 0, ym + 0.6, z0 + 7.2));
    for (const f of [0.16, 0.84]) K.add(at(box(4.5, 0.8, 10.1, K.iron), 0, lerp(m0 + 1.2, m1, f), z0 + 7.2));
    K.add(at(box(1.2, m1 - m0 - 4, 0.08, K.dark), 0, ym + 0.6, z0 + 12.23));
    // Рама-рычаг: шарнир на ложе у носа, штифт через короб, рукоять торчит назад-вверх.
    const yA = m0 + 2.5, zA = K.zc(yA), yH = m1 + 7, zH = z0 + 17, xL = 3.0;
    for (const sx of [1, -1]) K.add(rod([sx * xL, yA, zA], [sx * xL, yH, zH], 0.55, K.handWood, 6));
    K.add(cylX(0.6, 2 * xL + 1.4, K.handWood, 0, yH, zH, 8));
    K.add(cylX(0.32, 2 * xL + 1.0, K.iron, 0, yA, zA, 8));
    K.add(cylX(0.3, 2 * xL + 1.0, K.iron, 0, lerp(yA, yH, 0.62), lerp(zA, zH, 0.62), 8));
  },

  'wide-stirrup'(K) {
    // Полосы полированного рога вдоль ложа (из той же накладки вырезана направляющая болта).
    topStrip(K, K.front + 5, K.butt - 5, K.horn, 0.62);
    sideStrips(K, K.s.nut + 5, K.butt - 8, K.horn, 0.3, 0.12);
    // Высокий передок с отверстием под пеньковую обмотку, плетёные ремни крест-накрест.
    const yh = K.front + 5.5;
    K.add(cylX(0.95, K.R(yh).w + 0.08, K.dark, 0, yh, K.zc(yh) - 0.9, 10));
    crossStraps(K, K.cord, 1.1);
    // Железный крючок на хвосте под полиспаст или кранекин.
    const yk = K.butt - 7, zk = K.R(yk).zt;
    K.add(tube([[0, yk + 1.2, zk], [0, yk, zk + 1.6], [0, yk - 1.4, zk + 1.5], [0, yk - 1.7, zk + 0.7]], 0.3, K.iron, { segments: 12, radial: 5 }));
  },

  'spanish-straight'(K) {
    const n = K.s.nut, r = K.R(n), zm = K.zc(n), copper = K.ctx.fixed(COPPER, 0.85, 0.35);
    // Врезанные заподлицо Г-образные щёки у ореха: ложе здесь не толще, чем везде.
    const L: YZ[] = [[n - 7, r.zt - 0.1], [n + 7, r.zt - 0.1], [n + 7, r.zb + 0.1], [n + 4.6, r.zb + 0.1], [n + 4.6, zm], [n - 7, zm]];
    for (const sx of [1, -1]) K.add(plateYZ(L, 0.14, copper, sx * (r.w / 2 + 0.04)));
    // Роговой жёлоб-«канал» перед орехом.
    K.add(at(box(1.5, 18, 0.3, K.horn), 0, n - 11.5, r.zt + 0.12), at(box(0.4, 18, 0.06, K.dark), 0, n - 11.5, r.zt + 0.3));
    // Поперечный штифт под орехом — упор для вилки козьей ноги, с вращающимися втулками.
    const yp = n + 1.2, zp = r.zb + 0.8;
    K.add(cylX(0.65, r.w + 3.8, K.iron, 0, yp, zp, 8));
    for (const sx of [1, -1]) K.add(cylX(0.9, 1.1, K.iron, sx * (r.w / 2 + 1.3), yp, zp, 8));
    // Кольцо «эстрибо» на голове (не стремя), кольцо под седельный крюк; дуга в паре металлических скоб.
    K.add(at(box(1.0, 1.2, 0.8, K.iron), 0, K.front - 0.4, K.zc(K.front)), ringX(1.4, 0.26, K.iron, 0, K.front - 2.1, K.zc(K.front)));
    const ys = 20, xs = -(K.R(ys).w / 2 + 0.45);
    K.add(at(box(0.6, 1.0, 0.8, K.iron), xs + 0.2, ys, K.zc(ys)), ringX(1.0, 0.18, K.iron, xs, ys, K.zc(ys) - 1.1));
    prodClamps(K, false);
  },

  'cheek-butt'(K) {
    const n = K.s.nut;
    // Вогнутая щека на левой грани приклада: тёмная выборка в костяной окантовке.
    const yc = 21, rc = K.R(yc), zq = K.zc(yc) + 0.3;
    K.add(ovalSide(7.0, 2.1, 0.1, K.bone, rc.w / 2 + 0.01, yc, zq, 8));
    K.add(ovalSide(6.3, 1.6, 0.1, K.ctx.fixed(DARK_WOOD, 0, 0.9), rc.w / 2 + 0.05, yc, zq, 8));
    // Толстый роговой затыльник; сверху — «раковина» под большой палец.
    const rb = K.R(K.butt);
    K.add(at(box(rb.w + 0.3, 1.6, rb.zt - rb.zb + 0.3, K.horn), 0, K.butt + 0.8, K.zc(K.butt)));
    const shell = sphere(1.3, K.bone, 6);
    shell.scale.set(1.15, 1.5, 0.55);
    K.add(at(shell, 0, K.butt - 4, rb.zt + 0.1));
    // Верх и низ облицованы гравированным рогом.
    topStrip(K, K.front + 2, K.butt - 1, K.horn, 0.7);
    topStrip(K, K.front + 2, n + 6, K.horn, 0.7, true);
    // Спуск со скобой, шнеллер (второй спуск) и поворотный предохранитель.
    K.add(triggerGuard(K, n + 7, n + 15, 3.2, 0.28, K.iron));
    const ys = n + 12.4, zs = K.R(ys).zb;
    K.add(tube([[0, ys, zs + 0.2], [0, ys + 0.3, zs - 1.3], [0, ys - 0.2, zs - 2.2]], 0.15, K.iron, { segments: 8, radial: 4 }));
    K.add(at(box(0.3, 1.8, 0.6, K.iron), -(K.R(n + 17).w / 2 + 0.15), n + 17, K.zc(n + 17)));
    // Складной целик за замком; костяной мостик под болт у носа (жёлоба нет); штифт под кранекин; кольцо подвеса.
    const yr = n + 5, zr = K.R(yr).zt;
    K.add(at(box(1.8, 0.25, 2.0, K.iron), 0, yr, zr + 1.0), at(box(2.2, 0.5, 0.4, K.iron), 0, yr, zr + 0.15));
    const yb = K.front + 6;
    K.add(at(box(K.R(yb).w * 0.8, 1.0, 0.5, K.bone), 0, yb, K.R(yb).zt + 0.25));
    cranequinPin(K, n + 18, 2.5);
    K.add(ringX(0.9, 0.18, K.iron, 0, K.front + 4, K.R(K.front + 4).zb - 0.9));
  },

  barrel(K) {
    // «Ствол» слёрбоу: трубка поверх жёлоба от ореха почти до дуги (прорезь снизу — под тетиву), латунные пояски.
    const y0 = K.front + 5, y1 = K.s.nut - 2.4, rB = 1.6, zB = K.R(y1).zt + rB - 0.1, ym = (y0 + y1) / 2;
    K.add(at(cyl(rB, rB, y1 - y0, K.iron, 14), 0, ym, zB));
    K.add(at(cyl(rB * 0.55, rB * 0.55, 0.12, K.dark, 10), 0, y0 - 0.02, zB));
    for (const f of [0.03, 0.5, 0.97]) K.add(ringY(rB + 0.04, 0.2, K.brass, 0, lerp(y0, y1, f), zB));
    K.add(at(sphere(0.3, K.brass, 6), 0, y0 + 1.2, zB + rB + 0.15));
    cranequinPin(K, K.s.nut + 18, 2.5);
  },

  'vertical-grip'(K) {
    const n = K.s.nut;
    // Бронзовый замок в кожухе с прицелом «ваншань»; за ним вниз — вертикальная рукоять; приклада нет.
    chineseLock(K, 13, true);
    verticalGrip(K, n + 9.5, 9, 1.5);
    // Жёлоб под стрелу по верху; бронзовые обоймы поперечного гнезда дуги.
    const y0 = K.front + 5, y1 = n - 6;
    K.add(at(box(0.8, y1 - y0, 0.06, K.dark), 0, (y0 + y1) / 2, K.R(y0).zt + 0.03));
    for (const y of [K.yProd - 2.4, K.yProd + 2.4]) K.add(band(K, y, 1.0, 0.2, K.bronze));
  },

  'cranequin-pin'(K) {
    const n = K.s.nut;
    // Штифт под петлю кранекина ≈18 см за орехом; бока выпуклой середины в резном роге; лёгкая щека слева на хвосте.
    cranequinPin(K, n + 18, 2.5);
    sideStrips(K, n - 11, n + 13, K.horn, 0.5, 0);
    K.add(ovalSide(7, 1.4, 0.25, K.bone, K.R(24).w / 2 + 0.1, 24, K.zc(24) + 0.2));
  },

  'ganze-ruestung'(K) {
    const n = K.s.nut, gold = K.ctx.fixed(GOLD, 0.9, 0.3), ivory = K.ctx.fixed(IVORY, 0, 0.4);
    // Штифт кранекина с концами — львиными головами.
    const yp = n + 18, rp = K.R(yp), zp = K.zc(yp);
    K.add(cylX(0.7, rp.w + 5, K.iron, 0, yp, zp, 8));
    for (const sx of [1, -1]) {
      const x = sx * (rp.w / 2 + 2.6);
      K.add(at(sphere(1.25, gold, 5), x, yp, zp), at(box(1.0, 1.0, 0.9, gold), x + sx * 0.3, yp - 1.2, zp - 0.25));
    }
    // Кольцо подвеса с резным бюстом.
    const yr = K.front + 6, zr = K.R(yr).zb;
    K.add(at(box(1.6, 1.6, 1.0, gold), 0, yr, zr - 0.3), ringX(1.8, 0.3, gold, 0, yr, zr - 2.6), at(sphere(0.6, ivory, 5), 0, yr, zr - 4.6));
    // Роговой затыльник со вставкой-гербом; толстая щека змеиного дерева.
    const rb = K.R(K.butt);
    K.add(at(box(rb.w + 0.4, 2.0, rb.zt - rb.zb + 0.4, K.horn), 0, K.butt + 1.0, K.zc(K.butt)));
    K.add(at(cyl(2.0, 2.0, 0.3, gold, 6), 0, K.butt + 2.1, K.zc(K.butt) + 0.5));
    K.add(ovalSide(8, 3.0, 0.9, K.ctx.fixed(SNAKEWOOD, 0, 0.5), K.R(24).w / 2 + 0.35, 24, K.zc(24) + 1.0, 8));
    // Массивная золочёная скоба спуска («морское чудовище»).
    K.add(triggerGuard(K, n + 7, n + 19, 4.6, 0.55, gold));
    // Облицовка: пластины слоновой кости по бокам передка, гравированный рог по верху; целик, костяной мостик.
    const yi = K.front + 9;
    for (const sx of [1, -1]) K.add(ovalSide(3.4, 1.9, 0.14, ivory, sx * (K.R(yi).w / 2 + 0.03), yi, K.zc(yi), 6));
    topStrip(K, K.front + 3, n - 4, K.horn, 0.7);
    K.add(at(box(1.8, 0.25, 2.2, K.iron), 0, n + 6, K.R(n + 6).zt + 1.1));
    K.add(at(box(K.R(K.front + 5).w * 0.8, 1.0, 0.5, K.bone), 0, K.front + 5, K.R(K.front + 5).zt + 0.25));
  },

  'target-rest'(K) {
    const n = K.s.nut, f = K.front;
    // Главная деталь: большой изогнутый выступ под передком — упор левой руки.
    const hr: YZ[] = [[f + 12.5, K.R(f + 12.5).zb + 1.4], [f + 13.6, -7.8], [f + 16.4, -12.0], [f + 21, -14.6], [f + 25.6, -15.0], [f + 28.6, -13.4]];
    K.add(sweepYZ(hr, [5.0, 4.4, 3.8, 3.4, 3.0, 2.8], [3.6, 3.6, 3.4, 3.2, 3.0, 2.8], K.wood, { pow: 3, sides: 8 }));
    // Дуга сквозь окно передка в паре скоб с клиньями; удлинённый хвост в латунной обшивке, роговой затыльник, упор под палец.
    prodClamps(K, true);
    K.add(stockSweep(K.s.rows, K.brass, K.s.pow, sidesOf(K.s), 26, K.butt - 1, 0.12));
    const rb = K.R(K.butt);
    K.add(at(box(rb.w + 0.4, 1.4, rb.zt - rb.zb + 0.4, K.horn), 0, K.butt + 0.3, K.zc(K.butt)));
    K.add(at(box(2.4, 3.2, 1.0, K.horn), 0, K.butt - 10, K.R(K.butt - 10).zt + 0.35, -0.2));
    // Регулируемая мушка в рамке на носу, диоптр над замком, жёлоб ≈25 см.
    const yf = f + 2.5, zf = K.R(yf).zt;
    // Мушка — латунный ползунок в раме между стойками (двигают винтом по высоте), а не висящая в воздухе бусина.
    for (const sx of [1, -1]) K.add(at(box(0.3, 0.3, 4.6, K.iron), sx * 1.15, yf, zf + 2.1));
    K.add(at(box(2.3, 0.5, 0.55, K.brass), 0, yf, zf + 3.0));
    peepSight(K, n + 7, 3.2);
    K.add(at(box(0.8, 25, 0.06, K.dark), 0, n - 13.5, K.R(n - 13.5).zt + 0.03));
  },

  'horse-stirrup'(K) {
    const n = K.s.nut;
    // Бронзовый замок китайского типа у заднего конца, вертикальная рукоять (по аналогии с ханьским ну).
    chineseLock(K, 12, false);
    verticalGrip(K, n + 10, 8, 1.6);
    // Шёлковая обмотка ложа; сбоку — роговая полка, по которой идёт стрела («偏架», толкование).
    const silk = K.ctx.matOf('cloth', 4);
    for (const y of [K.front + 18, K.front + 34]) { const r = K.R(y); K.add(lashing(y, r.w, r.zt, r.zb, 0.26, silk)); }
    const y0 = K.front + 10, y1 = n - 7, r = K.R((y0 + y1) / 2);
    K.add(at(box(0.9, y1 - y0, 0.6, K.horn), r.w / 2 + 0.4, (y0 + y1) / 2, r.zt - 0.3));
  },

  'windlass-long'(K) {
    // Заострённый хвост в металлическом колпачке ≈5 см — на него надевают коробку ворота; упор перед коробкой.
    tailCap(K, 5);
    const yl = K.butt - 12, rl = K.R(yl);
    K.add(cylX(0.6, rl.w + 3.2, K.iron, 0, yl, K.zc(yl), 8));
    // Деревянная прицельная планка ≈30 см с косыми зарубками над хвостом.
    const s0 = K.butt - 41, s1 = K.butt - 14;
    K.add(sweepYZ([[s0, K.R(s0).zt + 0.5], [s1, K.R(s1).zt + 0.5]], [1.0, 1.0], [1.0, 0.9], K.handWood, { pow: 4, sides: 8 }));
    for (const t of [0.55, 0.72, 0.89]) { const y = lerp(s0, s1, t); K.add(at(box(1.06, 0.3, 0.7, K.dark), 0, y, K.R(y).zt + 0.85, 0.6)); }
    // Щёки ложа выложены костью: длинные полосы по бокам и ромб за замком (фламандские и немецкие арбалеты XV в.).
    sideStrips(K, K.s.nut + 17, K.butt - 16, K.bone, 0.42, 0);
    const yd = K.s.nut + 12, rd = K.R(yd), zd = K.zc(yd), hd = (rd.zt - rd.zb) * 0.38;
    for (const sx of [1, -1]) K.add(extrudeYZ([[yd - 3.2, zd], [yd, zd + hd], [yd + 3.2, zd], [yd, zd - hd]], 0.14, K.bone, sx * (rd.w / 2 + 0.07)));
  },

  rampart(K) {
    // Железные обоймы глубокого «кулака» под толстую дугу; колпачок на длинном узком хвосте под коробку ворота.
    for (const y of [K.front + 1.4, K.yProd + 4.2]) K.add(band(K, y, 1.6, 0.25, K.iron));
    tailCap(K, 6);
    // Роспись по бокам шеи и роговые вставки вдоль хвоста.
    const paint = K.ctx.fixed(PAINT, 0, 0.6), yq = K.s.nut + 23;
    for (const sx of [1, -1]) K.add(ovalSide(8, 2.2, 0.12, paint, sx * (K.R(yq).w / 2 + 0.03), yq, K.zc(yq), 6));
    sideStrips(K, K.s.nut + 36, K.butt - 10, K.horn, 0.3, 0.1);
    // Поворотный треножник у центра тяжести — то, чем крепостной отличается от ручного воротового в силуэте:
    // вилка-обойма на поперечной оси, шкворень вниз и три раскинутые ноги.
    const ys = K.s.nut + 6, r = K.R(ys), zp = K.zc(ys), xo = r.w / 2 + 0.45, zl = r.zb - 3.2;
    for (const sx of [1, -1]) K.add(plateYZ([[ys - 2, zp + 1.2], [ys + 2, zp + 1.2], [ys + 2, zl], [ys - 2, zl]], 0.7, K.iron, sx * xo));
    K.add(at(box(2 * xo + 0.7, 4, 1.0, K.iron), 0, ys, zl));
    K.add(cylX(0.55, 2 * xo + 2.2, K.iron, 0, ys, zp, 6));
    const zH = zl - 11;
    K.add(rod([0, ys, zl], [0, ys, zH], 1.0, K.iron, 6));
    K.add(at(box(3.6, 3.6, 2.0, K.iron), 0, ys, zH));
    for (const a of [90, 210, 330]) {
      const c = Math.cos(a * D2R), s = Math.sin(a * D2R);
      K.add(rod([1.2 * c, ys + 1.2 * s, zH], [17 * c, ys + 17 * s, zH - 24], 0.9, K.handWood, 4));
    }
  },

  'belly-slider'(K) {
    const slideM = K.ctx.matOf('wood', K.ctx.parts.grip.step >= 4 ? 2 : 4);
    // Неподвижный корпус (syrinx) с направляющими «ласточкина хвоста» по верху.
    K.add(stockSweep(GASTRA_CASE, K.wood, 5, 10));
    // Ползун (diostra) с когтем и спуском: выходит далеко вперёд за дугу — носом его упирают в землю при взводе.
    const s0 = K.front - 12, s1 = K.s.nut + 6, zS = 2.8;
    K.add(at(box(3.0, s1 - s0, 2.4, slideM), 0, (s0 + s1) / 2, zS));
    K.add(at(box(3.4, 1.6, 2.8, K.iron), 0, s0 + 0.7, zS));
    // Зубчатые рейки по бокам корпуса (планка + пилообразная лента зубьев) и собачки храповика на ползуне.
    const r0 = K.front + 10, r1 = K.s.nut + 18, zr = 0.2, pitch = 2.6;
    const saw: [number, number][] = [];
    for (let y = r0; y <= r1 + 1e-6; y += pitch) saw.push([y, zr + 0.25], [y + pitch * 0.75, zr + 0.95]);
    for (const sx of [1, -1]) {
      const x = sx * 2.45;
      K.add(at(box(0.5, r1 - r0 + pitch, 0.7, K.iron), x, (r0 + r1 + pitch) / 2, zr - 0.2));
      K.add(sweepYZ(saw, fill(saw.length, 0.3), fill(saw.length, 0.5), K.iron, { pow: 2, sides: 4 }, x));
      K.add(rod([sx * 1.75, s1 - 2.2, 2.6], [sx * 2.5, s1 - 4.8, zr + 1.1], 0.28, K.iron, 6));
    }
    K.add(cylX(0.26, 4.2, K.iron, 0, s1 - 2.2, 2.6, 6));
    // Задний торец — вогнутый полумесяц рогами вверх и вниз: упор под живот.
    const yE = last(GASTRA_CASE)[0], zc0 = -1.0, cr: YZ[] = [];
    for (let i = 0; i <= 6; i++) { const s = -1 + i / 3; cr.push([yE + 11.4 - 11.4 * (1 - s * s), zc0 + 9.2 * s]); }
    for (let i = 5; i >= 1; i--) { const s = -1 + i / 3; cr.push([yE + 10.6 - 3.6 * (1 - s * s), zc0 + 8.8 * s]); }
    K.add(plateYZ(cr, 6.4, K.wood, 0));
  },

  'waist-short'(K) {
    // Глубокое гнездо под огромную дугу — железные обоймы по обе стороны; бронзовый замок и бронзовый торец.
    for (const y of [K.front + 0.8, K.yProd + 3.4]) K.add(band(K, y, 1.4, 0.25, K.iron));
    chineseLock(K, 12, false);
    const rb = K.R(K.butt);
    K.add(at(box(rb.w + 0.3, 1.2, rb.zt - rb.zb + 0.3, K.bronze), 0, K.butt + 0.3, K.zc(K.butt)));
    // Ушко с кольцом под поясной крюк: взводят сидя, упёршись ступнями в дугу и разгибая спину.
    const yh = K.s.nut + 18, rh = K.R(yh);
    K.add(at(box(1.6, 2.2, 1.0, K.iron), 0, yh, rh.zb - 0.4), ringX(1.5, 0.3, K.iron, 0, yh, rh.zb - 2.3));
  },
};

type ProdKind = 'heavy' | 'reinforced' | 'straight' | 'light' | 'slim';
const prodKind = (ax: number): ProdKind => (ax >= 0.75 ? 'heavy' : ax >= 0.25 ? 'reinforced' : ax >= -0.25 ? 'straight' : ax >= -0.75 ? 'light' : 'slim');

/** Плечо дуги (правое, курс +X, изгиб к прикладу +Y): дуги, толщина по Y и ширина по Z у центра/конца. */
const PRODS: Record<ProdKind, { segs: Seg[]; th: [number, number]; wd: [number, number]; pow: number }> = {
  heavy: { segs: [{ f: 0.22, turn: 0 }, { f: 0.78, turn: 30 }], th: [3.2, 2.0], wd: [4.6, 3.0], pow: 3 },
  reinforced: { segs: [{ f: 0.2, turn: 0 }, { f: 0.8, turn: 27 }], th: [2.6, 1.5], wd: [3.9, 2.5], pow: 3 },
  straight: { segs: [{ f: 0.5, turn: 0 }, { f: 0.5, turn: 12 }], th: [1.9, 1.5], wd: [3.3, 2.8], pow: 7 },
  light: { segs: [{ f: 0.14, turn: 0 }, { f: 0.6, turn: 42 }, { f: 0.26, turn: -64 }], th: [1.8, 1.0], wd: [3.0, 1.8], pow: 2.6 },
  slim: { segs: [{ f: 0.08, turn: 0 }, { f: 0.92, turn: 29 }], th: [1.4, 0.7], wd: [2.3, 1.1], pow: 2.4 },
};

type LockKind = 'pin' | 'nut' | 'axle' | 'lever' | 'hidden';

export function buildCrossbow(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const tagStock = ctx.tag('grip', 'stock');
  const key = STOCKS[tagStock] ? tagStock : ctx.hands === 1 ? 'pistol' : 'wide-stirrup';
  const spec = STOCKS[key]!;
  const rows = spec.rows;
  const front = rows[0]![0], butt = last(rows)[0];
  /** Конец ложа, от которого ставится взвод. */
  const tailY = spec.tail ?? butt;
  const R = (y: number): { w: number; zt: number; zb: number } => rowAt(rows, y);
  const zc = (y: number): number => { const r = R(y); return (r.zt + r.zb) / 2; };
  /** Масштаб мелочи (взвод, замок) по длине ложа. */
  const k = clamp((butt - front) / 90, 0.55, 1.15);
  const { strike: pS, bind: pB, grip: pG } = ctx.parts;
  const woodM = ctx.mat('grip'), prodM = ctx.mat('strike'), lockM = ctx.mat('bind'), spanM = ctx.mat('head');
  const iron = ctx.matOf('iron', pG.step);
  const cord = ctx.matOf('cloth', 1);
  const hide = ctx.matOf('hide', 2);
  const handWood = ctx.matOf('wood', 3);

  // ── Дуга: размеры и посадка (нужны и ложу — скобам, обмоткам) ──
  const pk = prodKind(pS.axis);
  const PR = PRODS[pk];
  const S = spec.span * byAxis(pS.axis, 0.9, 1.1);
  const sk = clamp(spec.span / 70, 0.65, 1.3) * byAxis(pS.axis, 0.92, 1.1) * (spec.prodK ?? 1);
  const yProd = front + (spec.prodAt ?? 2.6);
  const arm = turtle([0, yProd], 0, (S / 2) * 1.03, PR.segs, 18);
  const pth = arm.u.map((u) => lerp(PR.th[0], PR.th[1], u) * sk);
  const pwd = arm.u.map((u) => lerp(PR.wd[0], PR.wd[1], u) * sk);
  const rP = R(yProd);
  const zP = typeof spec.prodZ === 'number' ? spec.prodZ : spec.prodZ === 'mid' ? (rP.zt + rP.zb) / 2 : rP.zt - pwd[0]! / 2 + 0.3;

  // ── GRIP: ложе, стремя, мебель ──
  if (spec.body !== false) {
    const [b0, b1] = spec.body ?? [front, butt];
    g.grip.add(stockSweep(rows, woodM, spec.pow, sidesOf(spec), b0, b1));
  }
  if (spec.stirrup !== 'none') {
    const St = STIRRUPS[spec.stirrup], sK = spec.stirrupK ?? 1, zF = zc(front);
    g.grip.add(tube(St.pts.map(([x, y]) => [x * sK, front + y * sK, zF] as V3), St.r * sK, iron, { segments: 18, radial: 4 }));
    if (spec.stirrup === 'wide') g.grip.add(at(box(13, 2.4, 0.4, iron), 0, front - 17, zF)); // подножка на две ступни
    if (spec.stirrup === 'triple') g.grip.add(at(box(1.0, 16, 0.7, iron), 0, front - 6.5, zF)); // трёхчастное: средняя планка
    if (spec.stirrup === 'horse') {
      // «Конское» стремя: широкая плоская подножка и шейка под ремень.
      g.grip.add(at(box(15.4, 0.9, 4.4, iron), 0, front - 16.7, zF), at(box(4.4, 2.2, 1.8, iron), 0, front - 0.6, zF));
    }
    // Железная обойма носа, куда входит стремя.
    const rF = R(front + 1.2);
    g.grip.add(spec.pow >= 4 ? at(box(rF.w + 0.6, 1.4, rF.zt - rF.zb + 0.6, iron), 0, front + 1.2, zc(front + 1.2)) : lashing(front + 1.2, rF.w, rF.zt, rF.zb, 0.35, iron));
  }
  FURNITURE[key]?.({
    add: (...o) => { g.grip.add(...o); }, R, zc, s: spec, ctx, front, butt, yProd, zP, pw: pwd[0]!,
    wood: woodM, iron, cord, hide, handWood,
    bone: ctx.fixed(PLATE_BONE, 0, 0.45), horn: ctx.fixed(HORN, 0, 0.35), brass: ctx.fixed(BRASS, 0.85, 0.35),
    bronze: ctx.fixed(BRONZE, 0.8, 0.45), dark: ctx.fixed(HOLE, 0, 0.95),
  });

  // ── STRIKE: дуга + тетива ──
  const armParts: THREE.Object3D[] = [sweep(arm.pts, pth, pwd, prodM, { pow: PR.pow, sides: 8, z: zP })];
  const stationAt = (x: number): number => Math.max(0, arm.pts.findIndex((p) => p[0] >= x));
  const ringAt = (i: number, r: number, m: Mat): THREE.Mesh => loopAround(arm.pts[i]!, arm.ang[i]!, pth[i]! / 2 + r, pwd[i]! / 2 + r, r, m, zP);
  const Pend = last(arm.pts), Aend = last(arm.ang);
  if (pk === 'heavy') {
    // Бриделя: толстая тёмная шнуровая обвязка дуги к ложу (её видно издали); роговые наконечники.
    const w = R(yProd).w;
    const bridle = ctx.fixed(BRIDLE, 0, 0.85);
    for (const x of [w / 2 + 0.5, w / 2 + 1.5, w / 2 + 2.5]) armParts.push(ringAt(stationAt(x), 0.45, bridle));
    g.strike.add(lashing(yProd, rP.w + 2.2, zP + pwd[0]! / 2, rP.zb, 0.42, bridle));
    const cap = lathe([[0.9, 0.8], [1.1, 0], [1.2, -1.2], [0.85, -1.8], [1.0, -2.4], [0.3, -3.2]], ctx.fixed(DARK_HORN, 0, 0.4), 10);
    cap.scale.set(pth[pth.length - 1]! / 1.6, 1, pwd[pwd.length - 1]! / 1.6);
    armParts.push(at(cap, Pend[0], Pend[1], zP, 0, 0, Aend + Math.PI / 2));
  } else if (pk === 'reinforced') {
    // Усиленная: три широкие железные обоймы-муфты на каждом плече.
    for (const u of [0.3, 0.55, 0.8]) {
      const i = Math.max(1, Math.min(arm.pts.length - 2, arm.u.findIndex((q) => q >= u)));
      const ids = [i - 1, i, i + 1];
      armParts.push(sweep(ids.map((j) => arm.pts[j]!), ids.map((j) => pth[j]! + 0.5), ids.map((j) => pwd[j]! + 0.5), iron, { pow: 5, sides: 8, z: zP }));
    }
  } else if (pk === 'straight') {
    // Прямая: плоская полоса без изгиба у центра, торцы-пуговки.
    armParts.push(at(sphere(pth[pth.length - 1]! * 0.75, prodM, 8), Pend[0], Pend[1], zP));
  } else if (pk === 'light') {
    // Лёгкая: концы загнуты вперёд (рекурв), маленькие ноки.
    armParts.push(ringAt(arm.pts.length - 3, 0.18, prodM));
  } else {
    // Облегчённая: длинное сужение и острые наконечники.
    const tipC = at(mesh(new THREE.ConeGeometry(pwd[pwd.length - 1]! * 0.45, 2.4, 8), prodM), 0, 0, 0);
    const a = Aend;
    tipC.position.set(Pend[0] + Math.cos(a) * 1.1, Pend[1] + Math.sin(a) * 1.1, zP);
    tipC.rotation.set(0, 0, a - Math.PI / 2);
    armParts.push(tipC);
  }
  if (pk === 'straight') {
    // Железная пряжка, сажающая стальную полосу в нос ложа.
    g.strike.add(at(box(rP.w + 1.2, 2.8, pwd[0]! + 0.5, iron), 0, yProd, zP));
  }
  // Петля тетивы на конце — в группе дуги (наклоняется вместе с ней).
  const iT = arm.pts.length - 2;
  const Tc = arm.pts[iT]!, aT = arm.ang[iT]!;
  const Tb = offN(Tc, aT, pth[iT]! / 2 + 0.25);
  const zN = R(spec.nut).zt + 0.9;
  const cordS = ctx.matOf('cloth', 2);
  armParts.push(loopAround(Tc, aT, pth[iT]! / 2 + 0.25, pwd[iT]! / 2 + 0.25, 0.24, cordS, zP));
  const armG = new THREE.Group();
  armG.add(...armParts);
  // Пулевые арбалеты: дуга вставлена с наклоном вверх — поворот вокруг оси X через центр дуги.
  const tilt = (spec.tilt ?? 0) * D2R;
  if (tilt) {
    const piv = new THREE.Group(), inner = new THREE.Group();
    piv.position.set(0, yProd, zP);
    piv.rotation.x = tilt;
    inner.position.set(0, -yProd, -zP);
    inner.add(armG, mirrorXGroup(armG));
    piv.add(inner);
    g.strike.add(piv);
  } else g.strike.add(armG, mirrorXGroup(armG));
  // Тетива взведена: V от концов дуги к ореху.
  const dT = Tb[1] - yProd;
  const T: V3 = [Tb[0], yProd + dT * Math.cos(tilt), zP + dT * Math.sin(tilt)];
  const Nk: V3 = [0.3, spec.nut - 0.6, zN];
  const strG = new THREE.Group();
  if (spec.pellet) {
    // Двойная тетива каменного арбалета: две нити, разведённые распоркой у конца, между ними у замка — кармашек под пулю.
    const dz = 0.55, f = 0.18;
    for (const sz of [1, -1]) strG.add(rod([T[0], T[1], T[2] + sz * dz * 0.45], [Nk[0], Nk[1], Nk[2] + sz * dz], 0.17, cordS, 4));
    const gap = 2 * dz * lerp(0.45, 1, f);
    strG.add(at(box(0.5, 0.5, gap + 0.4, ctx.fixed(BONE, 0, 0.45)), lerp(T[0], Nk[0], f), lerp(T[1], Nk[1], f), lerp(T[2], Nk[2], f)));
  } else strG.add(rod(T, Nk, 0.24, cordS));
  g.strike.add(strG, mirrorXGroup(strG));
  if (spec.pellet) {
    const pouch = sphere(1.25, ctx.matOf('hide', 3), 6);
    pouch.scale.set(1.6, 0.8, 0.9);
    g.strike.add(at(pouch, 0, spec.nut - 1.0, zN));
  }

  // ── BIND: замок ──
  const lk: LockKind = (() => {
    const t = ctx.tag('bind', 'lock');
    if (t === 'pin') return 'pin';
    if (t === 'nut') return 'nut';
    return pB.axis >= 0.75 ? 'lever' : pB.axis <= -0.75 ? 'hidden' : 'axle';
  })();
  const yN = spec.nut, rN = R(yN);
  const zt = rN.zt, zb = rN.zb, w = rN.w;
  const rn = 1.7 * clamp(w / 3.8, 0.7, 1.2);
  const nutLen = w * 0.78;
  const zb2 = (y: number): number => R(y).zb;
  const nutM = ctx.fixed(ANTLER, 0, 0.45);
  const nut = (sink: number): void => {
    g.bind.add(cylX(rn, nutLen, nutM, 0, yN, zt - rn * sink, 12));
    for (const sx of [0.6, -0.6]) g.bind.add(at(box(0.5, 0.9, 2.0, nutM), sx, yN - rn * 0.55, zt + 0.7 - rn * (sink - 0.45)));
  };
  /**
   * Хвост спуска уходит под ложе назад, к кисти. Если позади ореха рукоять, скоба или вертикальная ручка
   * (`tailMax`), хвост сжимается по Y и кончается ПЕРЕД ней (как спусковой крючок), а не сквозь неё.
   */
  const tm = spec.tailMax;
  const tailMaxY = tm ?? Infinity;
  const tail = (pts: V3[]): V3[] => {
    const maxY = Math.max(...pts.map((p) => p[1]));
    if (maxY <= tailMaxY) return pts;
    const s = (tailMaxY - yN) / (maxY - yN);
    return pts.map(([x, y, z]) => [x, yN + (y - yN) * s, z] as V3);
  };
  switch (lk) {
    case 'pin': {
      // Подъёмный штифт: колодка с прорезью на ложе, штифт снизу выталкивает тетиву; рычажок под ложем.
      g.bind.add(at(box(w * 0.6, 1.2, 1.1, lockM), 0, yN - 0.9, zt + 0.55));
      g.bind.add(at(box(w * 0.6, 1.2, 1.1, lockM), 0, yN + 0.9, zt + 0.55));
      g.bind.add(at(cyl(0.34, 0.34, zt - zb + 2.6, lockM, 8), 0, yN, (zt + zb) / 2 + 0.5, Math.PI / 2));
      g.bind.add(tube(tail([[0, yN, zb - 0.4], [0, yN + 6, zb2(yN + 6) - 1.1], [0, yN + 13, zb2(yN + 13) - 2.3], [0, yN + 16, zb2(yN + 16) - 3.4]]), 0.5, lockM, { segments: 16, radial: 5 }));
      break;
    }
    case 'nut': {
      // Орех без оси: сидит в гнезде и притянут шнуровой обвязкой; спуск — изогнутый «хвост».
      nut(0.45);
      for (const dy of [-(rn + 0.9), rn + 0.9]) g.bind.add(lashing(yN + dy, R(yN + dy).w, R(yN + dy).zt, R(yN + dy).zb, 0.22, cord));
      g.bind.add(tube(tail([[0, yN + 1, zb - 0.2], [0, yN + 4, zb2(yN + 4) - 2.2], [0, yN + 9, zb2(yN + 9) - 2.0], [0, yN + 14, zb2(yN + 14) - 3.4], [0, yN + 17, zb2(yN + 17) - 5.4]]), 0.5, lockM, { segments: 20, radial: 5 }));
      break;
    }
    case 'lever': {
      // Рычажный спуск: орех на оси и длинный рычаг вдоль всего низа ложа («тиллер»).
      nut(0.45);
      g.bind.add(cylX(0.3, w + 1.6, iron, 0, yN, zt - rn * 0.45, 8));
      for (const sx of [1, -1]) g.bind.add(at(sphere(0.55, lockM, 6), sx * (w / 2 + 0.8), yN, zt - rn * 0.45));
      const L = 34 * k;
      // Перед рукоятью — рычаг-«жим» вдоль её переда, у остальных — длинный тиллер под ложем.
      const lev: V3[] = tm !== undefined
        ? [...tail([[0, yN + 1.5, zb - 0.3], [0, yN + 6, zb2(yN + 6) - 1.4], [0, yN + 10, zb2(yN + 10) - 2.4]]), [0, tm - 0.2, zb2(tm - 0.2) - 6], [0, tm + 0.4, zb2(tm + 0.4) - 8.6]]
        : [[0, yN + 1.5, zb - 0.3], [0, yN + 8, zb2(yN + 8) - 1.4], [0, yN + L * 0.65, zb2(yN + L * 0.65) - 1.7], [0, yN + L, zb2(yN + L) - 3.0]];
      g.bind.add(tube(lev, 0.7, lockM, { segments: 20, radial: 5 }));
      g.bind.add(at(sphere(1.0, lockM, 8), ...last(lev)));
      for (const sx of [1, -1]) g.bind.add(extrudeYZ([[yN - 3, zt - 0.3], [yN + 3, zt - 0.3], [yN + 3, zt - (zt - zb) * 0.8], [yN - 3, zt - (zt - zb) * 0.8]], 0.16, lockM, sx * (w / 2 + 0.09)));
      break;
    }
    case 'hidden': {
      // Потайной: орех утоплен, сверху накладная пластина, по бокам плоские розетки, спуск — короткая кнопка.
      nut(0.85);
      const hw = w * 0.47;
      g.bind.add(at(extrudeXY([[0, yN - 10], [hw, yN - 6], [hw, yN + 6], [0, yN + 11], [-hw, yN + 6], [-hw, yN - 6]], 0.22, lockM), 0, 0, zt + 0.11));
      for (const sx of [1, -1]) g.bind.add(at(cyl(1.2, 1.2, 0.18, lockM, 14), sx * (w / 2 + 0.09), yN, zt - rn * 0.85, 0, 0, Math.PI / 2));
      g.bind.add(at(cyl(0.3, 0.38, 1.6, lockM, 8), 0, yN + 3, zb2(yN + 3) - 0.7, Math.PI / 2));
      break;
    }
    default: {
      // Орех на оси: ось с головками насквозь, боковые замочные пластины, короткий изогнутый спуск.
      nut(0.45);
      g.bind.add(cylX(0.3, w + 1.6, iron, 0, yN, zt - rn * 0.45, 8));
      for (const sx of [1, -1]) {
        g.bind.add(at(sphere(0.55, lockM, 6), sx * (w / 2 + 0.8), yN, zt - rn * 0.45));
        const zl = zt - (zt - zb) * 0.85;
        g.bind.add(extrudeYZ([[yN - 5.5, zt - 0.3], [yN + 5.5, zt - 0.3], [yN + 7, zl], [yN - 3.5, zl]], 0.18, lockM, sx * (w / 2 + 0.1)));
      }
      g.bind.add(tube([[0, yN + 2.5, zb + 0.2], [0, yN + 3.4, zb - 2.2], [0, yN + 5.2, zb - 3.8], [0, yN + 7.2, zb - 4.4]], 0.45, lockM, { segments: 12, radial: 5 }));
    }
  }

  // ── HEAD: взвод (у хвоста) ──
  const span = ctx.tag('head', 'span') || 'hands';
  const rB = (y: number): { w: number; zt: number; zb: number; zc: number } => { const r = R(y); return { ...r, zc: (r.zt + r.zb) / 2 }; };
  switch (span) {
    case 'belt-hook': {
      // Поясной крюк: кусок ремня с железной пластиной и двойной коготь, которым цепляют тетиву.
      // В походе его вешают на ложе: когти охватывают ложе с боков и загнуты через верх, ремень висит
      // снизу — так крюк держится за оружие, а не парит рядом с ним.
      const yb = spec.hookY ?? tailY - 20 * k;
      const rb = rB(yb);
      const zB = rb.zb - (ctx.hands === 1 ? 4.5 : 6 * k);
      const arc: [number, number][] = [];
      for (let i = 0; i <= 12; i++) { const t = lerp(-1.2, 1.2, i / 12); arc.push([11 * k * Math.sin(t), zB - 5 * k * (1 - Math.cos(t))]); }
      g.head.add(sweepXZ(arc, fill(arc.length, 0.5), fill(arc.length, 4.2 * k), hide, yb, { pow: 5, sides: 8 }));
      const xc = rb.w / 2 + 0.5 * k + 0.35, rc = 0.45 * k + 0.12;
      g.head.add(at(box(Math.max(4.4 * k, 2 * xc + 2 * rc + 0.6), 2.2 * k, 2.4 * k, spanM), 0, yb, zB + 1.2 * k));
      for (const sx of [1, -1]) {
        g.head.add(tube([[sx * xc, yb, zB + 2 * k], [sx * xc, yb, (rb.zt + rb.zb) / 2], [sx * xc, yb, rb.zt + 0.6], [sx * (xc - 0.9), yb, rb.zt + 1.3 + rc],
          [sx * (rb.w / 2 - 0.4), yb, rb.zt + 0.5 + rc]], rc, spanM, { segments: 20, radial: 5 }));
      }
      break;
    }
    case 'goats-foot': {
      // Козья нога: сложенная вилка с когтями по бокам ложа и изогнутый рычаг поверх.
      const yR = tailY - 5 * k, yF = Math.max(spec.nut + 6, yR - 34 * k);
      for (const sx of [1, -1]) {
        const xx = sx * (Math.max(R(yR).w, R(yF).w) / 2 + 0.8);
        g.head.add(tube([[xx, yR, rB(yR).zc + 0.4], [xx, (yR + yF) / 2, rB((yR + yF) / 2).zc + 0.8], [xx, yF, rB(yF).zc + 0.6]], 0.42, spanM, { segments: 12, radial: 5 }));
        g.head.add(tube([[xx, yF, rB(yF).zc + 0.6], [xx, yF - 1.6, rB(yF).zc + 1.2], [xx, yF - 1.8, rB(yF).zc + 2.6], [xx, yF - 0.6, rB(yF).zc + 3.1]], 0.36, spanM, { segments: 12, radial: 5 }));
      }
      g.head.add(cylX(0.5, R(yR).w + 3, spanM, 0, yR, rB(yR).zc + 0.4, 8));
      const lev: [number, number][] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8, y = lerp(yR, yF - 4 * k, t);
        lev.push([y, R(y).zt + 0.9 + 3.2 * k * Math.sin(Math.PI * t)]);
      }
      g.head.add(sweepYZ(lev, fill(lev.length, 0.8), fill(lev.length, 1.5), spanM, { pow: 4, sides: 8 }));
      g.head.add(at(sphere(0.9, spanM, 8), 0, last(lev)[0], last(lev)[1]));
      break;
    }
    case 'cranequin': {
      // Кранекин: круглый корпус с шестернёй на прикладе, зубчатая рейка вперёд до ореха, ворот-ручка сбоку.
      const yc2 = tailY - 12 * k, rC = 3.8 * k, zC = R(yc2).zt + rC * 0.9;
      g.head.add(cylX(rC, 2.6 * k, spanM, 0, yc2, zC, 14));
      g.head.add(cylX(rC * 0.45, 3.6 * k, spanM, 0, yc2, zC, 10));
      const yA = yc2 - rC * 0.6, yZ = spec.nut - 1, zR = zC - rC * 0.55;
      const pitch = 2.7 * k + 0.4, tooth = 0.85 * k, hR = 1.1 * k;
      const out: [number, number][] = [[yA, zR - hR / 2], [yZ, zR - hR / 2], [yZ, zR + hR / 2]];
      for (let y = yZ + pitch; y < yA - pitch * 0.5; y += pitch) out.push([y - pitch * 0.5, zR + hR / 2 + tooth], [y, zR + hR / 2]);
      out.push([yA, zR + hR / 2]);
      g.head.add(extrudeYZ(out, 1.2 * k, spanM));
      for (const sx of [0.8, -0.8]) g.head.add(tube([[sx * k, yZ, zR], [sx * k, yZ - 1.4 * k, zR - 0.4], [sx * k, yZ - 1.6 * k, zR - 1.8 * k]], 0.3 * k + 0.08, spanM, { segments: 8, radial: 5 }));
      const xC = 1.3 * k + 1.8;
      g.head.add(cylX(0.35, xC * 2, spanM, xC * 0.5, yc2, zC, 8));
      g.head.add(at(box(0.6, 7 * k, 1.1, spanM), xC + 0.3, yc2 + 3.2 * k, zC));
      g.head.add(cylX(0.55, 2.6, handWood, xC + 1.6, yc2 + 6.5 * k, zC, 8));
      g.head.add(lashing(yc2 + rC + 1.2, R(yc2 + rC + 1.2).w, R(yc2 + rC + 1.2).zt + 1.2, R(yc2 + rC + 1.2).zb, 0.28, cord));
      break;
    }
    case 'windlass': {
      // Ворот: ось с барабаном и двумя рукоятями на пятке, тросы вперёд к блоку с когтями.
      const rT = R(tailY);
      const yW = tailY + 1.5 * k, zW = rT.zt + 2.2 * k, wB = rT.w;
      g.head.add(cylX(0.5 * k + 0.1, wB + 9 * k, spanM, 0, yW, zW, 10));
      g.head.add(cylX(1.3 * k, wB, spanM, 0, yW, zW, 14));
      for (const sx of [1, -1]) {
        const xe = sx * (wB / 2 + 4.5 * k);
        g.head.add(at(box(0.7, 1.1, 7 * k, spanM), xe, yW, zW - 3.2 * k));
        g.head.add(cylX(0.55, 3 * k, handWood, xe + sx * 1.5 * k, yW, zW - 6.5 * k, 8));
        g.head.add(at(box(0.4, 5 * k, rT.zt - rT.zb + 3 * k, spanM), sx * (wB / 2 + 0.4), tailY - 1.5 * k, rT.zb + (rT.zt - rT.zb + 3 * k) / 2));
      }
      const yBk = spec.nut - 2, zBk = R(yBk).zt + 1.6;
      for (const sx of [1, -1]) g.head.add(rod([sx * 1.1 * k, yW, zW + 1.2 * k], [sx * 1.1 * k, yBk + 1, zBk + 0.3], 0.16, cord, 5));
      g.head.add(at(box(Math.max(3, R(yBk).w) + 1, 3.2 * k, 1.8 * k, spanM), 0, yBk, zBk));
      for (const sx of [1, -1]) {
        g.head.add(cylX(1.1 * k, 0.8, spanM, sx * 1.2 * k, yBk + 1.2 * k, zBk + 1.1 * k, 12));
        g.head.add(tube([[sx * 1.4 * k, yBk - 1.2 * k, zBk], [sx * 1.4 * k, yBk - 2.6 * k, zBk - 0.4], [sx * 1.4 * k, yBk - 2.8 * k, zBk - 1.6 * k]], 0.3 * k + 0.08, spanM, { segments: 8, radial: 5 }));
      }
      break;
    }
    default: {
      // Руками или рычагом: у рукояти — темляк с кольцом, у длинных лож — петля для руки под хвостом.
      if (spec.loop) {
        const [lx, ly, lz] = spec.loop;
        const pts: V3[] = [];
        for (let i = 0; i < 10; i++) { const q = (i / 10) * Math.PI * 2; pts.push([lx, ly + 2.2 * Math.sin(q), lz - 1.1 - 1.7 * (1 - Math.cos(q))]); }
        g.head.add(tube(pts, 0.3, hide, { closed: true, segments: 20, radial: 5 }));
        g.head.add(at(mesh(new THREE.TorusGeometry(0.7, 0.16, 6, 12), spanM), lx, ly, lz, 0, Math.PI / 2, 0));
      } else {
        // Петля для руки под хвостом: взводят руками, упёршись ногой в стремя.
        const yL = tailY - 14 * k, zL = R(yL).zb;
        const pts: V3[] = [];
        for (let i = 0; i < 12; i++) { const q = (i / 12) * Math.PI * 2; pts.push([0, yL + 3.6 * k * Math.sin(q), zL - 1.2 - 3.4 * k * (1 - Math.cos(q))]); }
        g.head.add(tube(pts, 0.34, hide, { closed: true, segments: 24, radial: 5 }));
        g.head.add(at(mesh(new THREE.TorusGeometry(0.9, 0.2, 6, 12), spanM), 0, yL, zL - 0.7, 0, Math.PI / 2, 0));
      }
    }
  }
  return root;
}

/** Зеркало группы по X (левое плечо дуги из правого). */
function mirrorXGroup(o: THREE.Object3D): THREE.Object3D {
  const c = o.clone();
  c.scale.x = -1;
  c.position.x = -o.position.x;
  return c;
}
