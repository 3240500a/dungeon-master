import * as THREE from 'three';
import {
  at, box, byAxis, cyl, extrudeXY, latheY, mesh, slotGroups, sphere, tube,
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
 * Взвод висит у приклада.
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

interface StockSpec {
  rows: Row[];
  /** Y ореха (замка). */
  nut: number;
  /** Размах дуги по X для этого ложа, см. */
  span: number;
  stirrup: 'none' | 'narrow' | 'wide' | 'small';
  pow: number;
}

const STOCKS: Record<string, StockSpec> = {
  // Балестрино: короткое ложе высоко над кистью, приклад загнут вниз рукоятью-пистолетом.
  pistol: { rows: [[-27, 2.3, 7.4, 4.8], [-12, 2.7, 7.4, 4.2], [-2, 2.9, 7.4, 3.8], [4, 2.8, 7.2, 4.4], [7, 2.2, 6.4, 5.4]], nut: -12, span: 40, stirrup: 'none', pow: 3 },
  // «В одну ногу»: длинное тонкое ложе, приклад сходит на нет.
  'narrow-stirrup': { rows: [[-34, 3.0, 2.2, -1.2], [-9, 3.4, 2.2, -2.2], [20, 3.2, 2.0, -2.0], [46, 2.2, 1.6, -1.0]], nut: -9, span: 64, stirrup: 'narrow', pow: 3.2 },
  // «В две ноги»: ложе толще, приклад-«дубинка» углубляется к концу.
  'wide-stirrup': { rows: [[-38, 3.6, 2.5, -1.5], [-10, 4.0, 2.5, -2.5], [28, 4.2, 2.4, -3.4], [50, 4.6, 2.2, -4.8]], nut: -10, span: 76, stirrup: 'wide', pow: 3.6 },
  // Под кранекин: короткое, у замка раздуто вширь, приклад опущен «щекой».
  'cranequin-pin': { rows: [[-32, 3.8, 2.8, -1.4], [-20, 4.2, 2.8, -2.4], [-17, 7.2, 2.9, -2.9], [-4, 7.6, 2.9, -2.9], [0, 4.6, 2.8, -2.6], [18, 4.2, 2.4, -2.9], [32, 4.4, 0.2, -6.4]], nut: -12, span: 66, stirrup: 'small', pow: 4 },
  // Под ворот: длинное тяжёлое прямоугольное ложе ~105 см.
  'windlass-long': { rows: [[-50, 4.0, 2.8, -1.6], [-14, 4.6, 2.8, -2.8], [40, 4.6, 2.6, -3.4], [54, 5.0, 2.6, -3.8]], nut: -14, span: 92, stirrup: 'small', pow: 6 },
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
  const stockTag = ctx.tag('grip', 'stock');
  const spec = STOCKS[stockTag] ?? (ctx.hands === 1 ? STOCKS['pistol']! : STOCKS['wide-stirrup']!);
  const isPistol = spec === STOCKS['pistol'];
  const rows = spec.rows;
  const front = rows[0]![0], butt = last(rows)[0];
  const R = (y: number): { w: number; zt: number; zb: number } => {
    const f = rows[0]!, l = last(rows);
    if (y <= f[0]) return { w: f[1], zt: f[2], zb: f[3] };
    if (y >= l[0]) return { w: l[1], zt: l[2], zb: l[3] };
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!, b = rows[i + 1]!;
      if (y <= b[0]) { const t = (y - a[0]) / (b[0] - a[0] || 1); return { w: lerp(a[1], b[1], t), zt: lerp(a[2], b[2], t), zb: lerp(a[3], b[3], t) }; }
    }
    return { w: l[1], zt: l[2], zb: l[3] };
  };
  /** Масштаб мелочи (взвод, замок) по длине ложа. */
  const k = clamp((butt - front) / 90, 0.55, 1.15);
  const { strike: pS, bind: pB, grip: pG } = ctx.parts;
  const woodM = ctx.mat('grip'), prodM = ctx.mat('strike'), lockM = ctx.mat('bind'), spanM = ctx.mat('head');
  const iron = ctx.matOf('iron', pG.step);
  const cord = ctx.matOf('cloth', 1);
  const hide = ctx.matOf('hide', 2);
  const handWood = ctx.matOf('wood', 3);

  // ── GRIP: ложе ──
  const ys: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]![0], b = rows[i + 1]![0];
    const n = Math.max(1, Math.ceil((b - a) / 6.5));
    for (let j = 0; j < n; j++) ys.push(lerp(a, b, j / n));
  }
  ys.push(butt);
  g.grip.add(sweep(ys.map((y) => [0, y] as V2), ys.map((y) => R(y).w), ys.map((y) => R(y).zt - R(y).zb), woodM,
    { pow: spec.pow, sides: 10, z: ys.map((y) => (R(y).zt + R(y).zb) / 2) }));
  const zcF = (R(front).zt + R(front).zb) / 2;
  if (isPistol) {
    // Рукоять-пистолет под ложем (кисть — в начале координат) с яблоком на конце и железный носок.
    const hp: [number, number][] = [[-1.8, 5.2], [-0.6, 2.2], [0.4, -0.6], [1.9, -3.6], [3.8, -6.8]];
    g.grip.add(sweepYZ(hp, fill(hp.length, 3.3), [2.5, 2.6, 2.7, 2.7, 2.6], woodM, { pow: 3, sides: 10 }));
    g.grip.add(at(sphere(1.7, woodM, 10), 0, 4.3, -7.6));
    g.grip.add(at(box(R(front).w + 0.4, 2.2, R(front).zt - R(front).zb + 0.4, iron), 0, front + 0.9, zcF));
  } else {
    const st = spec.stirrup;
    const P: V2[] = st === 'wide'
      ? [[-1.6, 2], [-7, -3], [-10.5, -9], [-10.5, -15], [-6, -17], [6, -17], [10.5, -15], [10.5, -9], [7, -3], [1.6, 2]]
      : st === 'narrow'
        ? [[-1.2, 2], [-4.8, -3], [-5.6, -8], [-3.6, -12.5], [0, -13.5], [3.6, -12.5], [5.6, -8], [4.8, -3], [1.2, 2]]
        : [[-1.4, 2], [-4, -2.5], [-4.6, -7], [-2.5, -10], [2.5, -10], [4.6, -7], [4, -2.5], [1.4, 2]];
    const rr = st === 'wide' ? 0.6 : st === 'narrow' ? 0.5 : 0.72;
    g.grip.add(tube(P.map(([x, y]) => [x, front + y, zcF] as V3), rr, iron, { segments: 24, radial: 5 }));
    if (st === 'wide') g.grip.add(at(box(13, 2.4, 0.4, iron), 0, front - 17, zcF)); // подножка на две ступни
    // Железная обойма носа, куда входит стремя.
    g.grip.add(lashing(front + 1.2, R(front).w, R(front).zt, R(front).zb, 0.35, iron));
  }
  if (stockTag === 'cranequin-pin') {
    // Поперечный штифт под петлю кранекина.
    const yp = 12, r = R(yp);
    g.grip.add(cylX(0.55, r.w + 5, iron, 0, yp, (r.zt + r.zb) / 2, 8));
    for (const sx of [1, -1]) g.grip.add(at(sphere(0.9, iron, 8), sx * (r.w / 2 + 2.5), yp, (r.zt + r.zb) / 2));
  }
  if (stockTag === 'windlass-long') {
    // Железная пятка приклада под петлю ворота и два боковых упора, в которые садятся щёки ворота.
    const r = R(butt);
    g.grip.add(at(box(r.w + 0.5, 1.4, r.zt - r.zb + 0.5, iron), 0, butt - 0.4, (r.zt + r.zb) / 2));
    g.grip.add(lashing(butt - 6, r.w, r.zt, r.zb, 0.3, iron));
    const yl = butt - 11, rl = R(yl);
    g.grip.add(cylX(0.6, rl.w + 3.2, iron, 0, yl, (rl.zt + rl.zb) / 2, 8));
    // Щёки ложа выложены костью (фламандские и немецкие арбалеты XV в.): длинные полосы по бокам и
    // ромб за замком — отличает тяжёлое ложе под ворот от лёгкого «в одну ногу» того же силуэта.
    const bone = ctx.fixed(PLATE_BONE, 0, 0.45);
    const iy: number[] = [];
    for (let y = spec.nut + 17; y <= butt - 14; y += 6) iy.push(y);
    for (const sx of [1, -1]) {
      g.grip.add(sweep(iy.map((y) => [sx * (R(y).w / 2 + 0.05), y] as V2), fill(iy.length, 0.14), iy.map((y) => (R(y).zt - R(y).zb) * 0.42), bone,
        { pow: 5, sides: 6, z: iy.map((y) => (R(y).zt + R(y).zb) / 2) }));
      const yd = spec.nut + 12, rd = R(yd), zc = (rd.zt + rd.zb) / 2, hd = (rd.zt - rd.zb) * 0.38;
      g.grip.add(extrudeYZ([[yd - 3.2, zc], [yd, zc + hd], [yd + 3.2, zc], [yd, zc - hd]], 0.14, bone, sx * (rd.w / 2 + 0.07)));
    }
  }

  // ── STRIKE: дуга + тетива ──
  const pk = prodKind(pS.axis);
  const PR = PRODS[pk];
  const S = spec.span * byAxis(pS.axis, 0.9, 1.1);
  const sk = clamp(spec.span / 70, 0.65, 1.3) * byAxis(pS.axis, 0.92, 1.1);
  const yProd = front + 2.6;
  const arm = turtle([0, yProd], 0, (S / 2) * 1.03, PR.segs, 18);
  const pth = arm.u.map((u) => lerp(PR.th[0], PR.th[1], u) * sk);
  const pwd = arm.u.map((u) => lerp(PR.wd[0], PR.wd[1], u) * sk);
  const zP = R(yProd).zt - pwd[0]! / 2 + 0.3;
  const armParts: THREE.Object3D[] = [sweep(arm.pts, pth, pwd, prodM, { pow: PR.pow, sides: 8, z: zP })];
  const stationAt = (x: number): number => Math.max(0, arm.pts.findIndex((p) => p[0] >= x));
  const ringAt = (i: number, r: number, m: Mat): THREE.Mesh => loopAround(arm.pts[i]!, arm.ang[i]!, pth[i]! / 2 + r, pwd[i]! / 2 + r, r, m, zP);
  const Pend = last(arm.pts), Aend = last(arm.ang);
  if (pk === 'heavy') {
    // Бриделя: толстая тёмная шнуровая обвязка дуги к ложу (её видно издали); роговые наконечники.
    const w = R(yProd).w;
    const bridle = ctx.fixed(BRIDLE, 0, 0.85);
    for (const x of [w / 2 + 0.5, w / 2 + 1.5, w / 2 + 2.5]) armParts.push(ringAt(stationAt(x), 0.45, bridle));
    const r0 = R(yProd);
    g.strike.add(lashing(yProd, r0.w + 2.2, zP + pwd[0]! / 2, r0.zb, 0.42, bridle));
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
    const r = R(yProd);
    g.strike.add(at(box(r.w + 1.2, 2.8, pwd[0]! + 0.5, iron), 0, yProd, zP));
  }
  // Тетива: петли на концах и V к ореху.
  const iT = arm.pts.length - 2;
  const Tc = arm.pts[iT]!, aT = arm.ang[iT]!;
  const Tb = offN(Tc, aT, pth[iT]! / 2 + 0.25);
  const zN = R(spec.nut).zt + 0.9;
  const cordS = ctx.matOf('cloth', 2);
  armParts.push(loopAround(Tc, aT, pth[iT]! / 2 + 0.25, pwd[iT]! / 2 + 0.25, 0.24, cordS, zP));
  armParts.push(rod([Tb[0], Tb[1], zP], [0.3, spec.nut - 0.6, zN], 0.24, cordS));
  const armG = new THREE.Group();
  armG.add(...armParts);
  g.strike.add(armG, mirrorXGroup(armG));

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
   * Хвост спуска уходит под ложе назад, к кисти. У пистолетного ложа позади ореха — рукоять-пистолет,
   * поэтому хвост сжимается по Y и кончается ПЕРЕД рукоятью (как спусковой крючок), а не сквозь неё.
   */
  const tailMaxY = isPistol ? -3.2 : Infinity;
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
      // У пистолетного — рычаг-«жим» вдоль переда рукояти, у остальных — длинный тиллер под ложем.
      const lev: V3[] = isPistol
        ? [...tail([[0, yN + 1.5, zb - 0.3], [0, yN + 6, zb2(yN + 6) - 1.4], [0, yN + 10, zb2(yN + 10) - 2.4]]), [0, -3.4, zb2(-3.4) - 6], [0, -2.8, zb2(-2.8) - 8.6]]
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

  // ── HEAD: взвод (у приклада) ──
  const span = ctx.tag('head', 'span') || 'hands';
  const rB = (y: number): { w: number; zt: number; zb: number; zc: number } => { const r = R(y); return { ...r, zc: (r.zt + r.zb) / 2 }; };
  switch (span) {
    case 'belt-hook': {
      // Поясной крюк: кусок ремня с железной пластиной и двойной коготь, которым цепляют тетиву.
      // В походе его вешают на ложе: когти охватывают ложе с боков и загнуты через верх, ремень висит
      // снизу — так крюк держится за оружие, а не парит рядом с ним.
      const yb = isPistol ? front + 9 : butt - 20 * k;
      const rb = rB(yb);
      const zB = rb.zb - (isPistol ? 4.5 : 6 * k);
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
      const yR = butt - 5 * k, yF = Math.max(spec.nut + 6, yR - 34 * k);
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
      const yc2 = butt - 12 * k, rC = 3.8 * k, zC = R(yc2).zt + rC * 0.9;
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
      // Ворот: ось с барабаном и двумя рукоятями на пятке приклада, тросы вперёд к блоку с когтями.
      const yW = butt + 1.5 * k, zW = R(butt).zt + 2.2 * k, wB = R(butt).w;
      g.head.add(cylX(0.5 * k + 0.1, wB + 9 * k, spanM, 0, yW, zW, 10));
      g.head.add(cylX(1.3 * k, wB, spanM, 0, yW, zW, 14));
      for (const sx of [1, -1]) {
        const xe = sx * (wB / 2 + 4.5 * k);
        g.head.add(at(box(0.7, 1.1, 7 * k, spanM), xe, yW, zW - 3.2 * k));
        g.head.add(cylX(0.55, 3 * k, handWood, xe + sx * 1.5 * k, yW, zW - 6.5 * k, 8));
        g.head.add(at(box(0.4, 5 * k, R(butt).zt - R(butt).zb + 3 * k, spanM), sx * (wB / 2 + 0.4), butt - 1.5 * k, R(butt).zb + (R(butt).zt - R(butt).zb + 3 * k) / 2));
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
      // Руками или рычагом: ничего, кроме ремня-погона с двумя антабками (у пистолетного — темляк).
      if (isPistol) {
        const pts: V3[] = [];
        for (let i = 0; i < 10; i++) { const q = (i / 10) * Math.PI * 2; pts.push([0, 4.6 + 2.2 * Math.sin(q), -10.4 - 3.4 * (1 - Math.cos(q)) * 0.5]); }
        g.head.add(tube(pts, 0.3, hide, { closed: true, segments: 20, radial: 5 }));
        g.head.add(at(mesh(new THREE.TorusGeometry(0.7, 0.16, 6, 12), spanM), 0, 4.6, -9.3, 0, Math.PI / 2, 0));
      } else {
        // Петля для руки под прикладом: взводят руками, упёршись ногой в стремя.
        const yL = butt - 14 * k, zL = R(yL).zb;
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
