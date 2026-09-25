import * as THREE from 'three';
import {
  at, box, byAxis, cone, cyl, extrudeXY, hash01, latheY, mesh, mirrorX, slotGroups, sphere, tube,
  type MeshCtx, type SlotName, type V2,
} from './core.js';

/**
 * МЕЧ И КИНЖАЛ ИЗ ДЕТАЛЕЙ (docs/CRAFT_WEAPONS.md §18, визуал Ф1). Контракт — в `core.ts`:
 * сантиметры, основная рука в начале координат, клинок в −Y, плоскость клинка XY.
 *
 * Клинок — ЛОФТ по сечениям (не плоская плашка): у каждого типа Окшотта своё сечение — плоское
 * с долом (X–XIV), ромб (XV, XVIII), шестигранник (XVII, XIX), дол переходит в ромб (XVI),
 * однолезвийный клин с толстой спинкой (фальшион, сабля, сакс). Дол — настоящая канавка, её
 * грани покрашены темнее, чтобы дол читался и на маленьком превью.
 *
 * Что задаёт форму: ТЕГИ детали — силуэт (тип клинка, хват, гарда, навершие); ОСЬ — пропорции
 * (ширина, толщина, длина рукояти, размер навершия); `hash01(id)` — мелочь (число витков оплётки,
 * высота заклёпки хвостовика), чтобы два варианта с одинаковыми тегами и осью не совпали.
 * Ступень материала на геометрию НЕ влияет — только цвет.
 */

// ── Мелкие помощники ────────────────────────────────────────────────────────────────────────────

const PI = Math.PI;
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const smooth = (u: number): number => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
/** Степень без NaN: отрицательное основание (погрешность у острия) прижимается к нулю. */
const pw = (x: number, e: number): number => Math.pow(Math.max(0, x), e);

/** Кусочно-линейная функция по равномерным узлам на [0,1]. */
function pwl(u: number, v: readonly number[]): number {
  const n = v.length - 1;
  const x = clamp(u, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return lerp(v[i] ?? 0, v[i + 1] ?? 0, x - i);
}

/** Облегчённый тор в плоскости XY (кольца гарды, четырёхлистники): меньше вершин, чем `torus`. */
function ring(R: number, r: number, mat: THREE.Material, tubular = 16, radial = 6): THREE.Mesh {
  return mesh(new THREE.TorusGeometry(R, r, radial, tubular), mat);
}

/** Грани вместо сглаживания — для гранёных наверший. */
function faceted(m: THREE.Mesh): THREE.Mesh {
  const g = m.geometry.toNonIndexed();
  g.computeVertexNormals();
  m.geometry.dispose();
  m.geometry = g;
  return m;
}

/** Тот же материал детали, но темнее — дол, накладки. Цвет всё равно идёт от ступени. */
function shade(ctx: MeshCtx, slot: SlotName, k: number, metalness = 0.7, roughness = 0.45): THREE.Material {
  const std = ctx.mat(slot) as THREE.MeshStandardMaterial;
  const c = std.color ? std.color.clone().multiplyScalar(k) : new THREE.Color(0x444444);
  return ctx.fixed(c.getHex(), metalness, roughness);
}

/** Группа в точке и с поворотом по Z. */
function holder(x: number, y: number, rz = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, 0);
  g.rotation.z = rz;
  return g;
}

/**
 * Тело вращения с валиками — оплётка шнуром по коже или точёные кольца. `shape(u)` — множитель
 * радиуса по длине, u=0 у гарды, u=1 у навершия; строится от y=0 вверх на `len`.
 */
function ridgedLathe(len: number, R: number, shape: (u: number) => number, ridges: number, amp: number, mat: THREE.Material, segs = 12): THREE.Mesh {
  const pts: V2[] = [[0.01, 0]];
  const K = Math.max(8, ridges * 3);
  for (let i = 0; i <= K; i++) {
    const u = i / K;
    const rib = ridges > 0 ? Math.max(0, Math.cos(2 * PI * ridges * u)) : 0;
    pts.push([R * shape(u) * (1 + amp * rib), u * len]);
  }
  pts.push([0.01, len]);
  return latheY(pts, mat, segs);
}

// ── Клинок: сечение и лофт ──────────────────────────────────────────────────────────────────────

/**
 * Сечение в одной станции клинка. xR/xL — правая и левая кромки, xC — ось сечения (гребень,
 * центр дола), th — полная толщина. Плечо — где спуск кромки встречает плоскость: доля
 * полуширины `sh` и доля полутолщины `zs` (плоское — zs=1, ромб — на прямой от кромки к гребню).
 */
interface Sec {
  xR: number; xL: number; xC: number; th: number;
  shR: number; zsR: number; shL: number; zsL: number;
  /** Центральный дол: полуширина и глубина. */
  g?: number; gd?: number;
  /** Парные боковые долы: смещение от оси, полуширина, глубина. */
  sx?: number; sg?: number; sgd?: number;
}

/** Состав сечения — постоянный на весь клинок (у всех станций одинаковое число точек). */
interface Layout { center: boolean; side: boolean; lean?: boolean }

interface Shape { sh: number; zs: number }
const FLAT: Shape = { sh: 0.62, zs: 1 };
const LENS: Shape = { sh: 0.48, zs: 0.66 };
const DIAM: Shape = { sh: 0.5, zs: 0.5 };
const HEX: Shape = { sh: 0.36, zs: 1 };
const BLUNT: Shape = { sh: 0.9, zs: 1 };
const mixShape = (a: Shape, b: Shape, u: number): Shape => ({ sh: lerp(a.sh, b.sh, u), zs: lerp(a.zs, b.zs, u) });

/** Контур сечения (x, z) по кругу + метка дола у каждой точки (грань дола — между точками одной метки). */
function ringOf(s: Sec, lay: Layout): { p: V2[]; lab: number[] } {
  const r = Math.max(0.02, s.xR - s.xC), l = Math.max(0.02, s.xC - s.xL);
  const T = Math.max(0.025, s.th / 2);
  let up: V2[]; let lab: number[];
  if (lay.lean) {
    up = [[r, 0], [0, T], [-l, 0]];
    lab = [0, 0, 0];
  } else {
    const sR: V2 = [clamp(s.shR, 0.05, 0.98) * r, clamp(s.zsR, 0, 1) * T];
    const sL: V2 = [-clamp(s.shL, 0.05, 0.98) * l, clamp(s.zsL, 0, 1) * T];
    const zAt = (x: number): number => {
      if (x >= sR[0]) return lerp(sR[1], 0, (x - sR[0]) / Math.max(1e-6, r - sR[0]));
      if (x >= 0) return lerp(T, sR[1], x / Math.max(1e-6, sR[0]));
      if (x >= sL[0]) return lerp(T, sL[1], x / Math.min(-1e-6, sL[0]));
      return lerp(sL[1], 0, (x - sL[0]) / Math.min(-1e-6, -l - sL[0]));
    };
    up = [[r, 0], sR]; lab = [0, 0];
    const inner = Math.min(sR[0], -sL[0]);
    const hw = lay.center ? clamp(s.g ?? 0, 0, inner * 0.9) : 0;
    const d = hw > 0 ? Math.min(s.gd ?? 0.15, T * 0.7, hw * 1.2) : 0;
    let sx = 0, sg = 0, sd = 0;
    if (lay.side) {
      sg = Math.max(0, s.sg ?? 0);
      const lo = hw + sg + 0.03, hi = inner * 0.95 - sg;
      if (hi < lo || sg <= 0) { sg = 0; sx = (hw + inner) / 2; } else sx = clamp(s.sx ?? (lo + hi) / 2, lo, hi);
      sd = sg > 0 ? Math.min(s.sgd ?? 0.12, T * 0.6, sg * 1.2) : 0;
      up.push([sx + sg, zAt(sx + sg)], [sx, zAt(sx) - sd], [sx - sg, zAt(sx - sg)]); lab.push(2, 2, 2);
    }
    if (lay.center) { up.push([hw, zAt(hw)], [0, T - d], [-hw, zAt(-hw)]); lab.push(1, 1, 1); }
    else { up.push([0, T]); lab.push(0); }
    if (lay.side) { up.push([-sx + sg, zAt(-sx + sg)], [-sx, zAt(-sx) - sd], [-sx - sg, zAt(-sx - sg)]); lab.push(3, 3, 3); }
    up.push(sL, [-l, 0]); lab.push(0, 0);
  }
  const p: V2[] = [...up];
  const lb = [...lab];
  for (let i = up.length - 2; i >= 1; i--) {
    const q = up[i]!;
    const m = lab[i] ?? 0;
    p.push([q[0], -q[1]]);
    lb.push(m ? m + 10 : 0);
  }
  return { p, lab: lb };
}

/**
 * ЛОФТ: станции сверху вниз, у каждой грани сечения — своя пара столбцов вершин (гладко вдоль
 * клинка, остро на гранях и гребне). Грани дола — отдельным мешем тёмного материала.
 */
function loft(st: { y: number; s: Sec }[], lay: Layout, mat: THREE.Material, grooveMat: THREE.Material): THREE.Mesh[] {
  const rings = st.map((q) => ({ y: q.y, xc: q.s.xC, ...ringOf(q.s, lay) }));
  const first = rings[0]!;
  const M = first.p.length;
  const main = { pos: [] as number[], idx: [] as number[] };
  const gro = { pos: [] as number[], idx: [] as number[] };
  for (let k = 0; k < M; k++) {
    const k2 = (k + 1) % M;
    const la = first.lab[k] ?? 0, lb = first.lab[k2] ?? 0;
    const tgt = la !== 0 && la === lb ? gro : main;
    const base = tgt.pos.length / 3;
    for (const R of rings) {
      const a = R.p[k]!, b = R.p[k2]!;
      tgt.pos.push(R.xc + a[0], R.y, a[1], R.xc + b[0], R.y, b[1]);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const a = base + 2 * i;
      tgt.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  // Пята — торец у гарды.
  const c0 = main.pos.length / 3;
  main.pos.push(first.xc, first.y, 0);
  for (const q of first.p) main.pos.push(first.xc + q[0], first.y, q[1]);
  for (let k = 0; k < M; k++) main.idx.push(c0, c0 + 1 + ((k + 1) % M), c0 + 1 + k);

  const toMesh = (b: { pos: number[]; idx: number[] }, m: THREE.Material): THREE.Mesh => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setIndex(b.idx);
    geo.computeVertexNormals();
    return mesh(geo, m);
  };
  const out = [toMesh(main, mat)];
  if (gro.idx.length) out.push(toMesh(gro, grooveMat));
  return out;
}

/** Станции: равномерно + гуще у острия + обязательные изломы (конец рикассо, начало острия). */
function stationsT(n: number, tipFrom: number, tipN: number, breaks: number[]): number[] {
  const ts: number[] = [];
  for (let i = 0; i <= n; i++) ts.push(i / n);
  for (let i = 1; i < tipN; i++) ts.push(tipFrom + (1 - tipFrom) * (i / tipN));
  for (const b of breaks) if (b > 0 && b < 1) ts.push(b);
  ts.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of ts) if (!out.length || t - out[out.length - 1]! > 1e-4) out.push(t);
  return out;
}

/** Рикассо: незаточенная узкая пята (см), крюки-«парирхакены» на её конце, обмотка кожей. */
interface Ricasso { len: number; w: number; wrap: boolean; lug: number }

interface BladeDef {
  len: number;
  prof: (t: number) => Sec;
  lay: Layout;
  n?: number; tipFrom?: number; tipN?: number; breaks?: number[];
  ric?: Ricasso & { wAfter: number; th: number };
}

/** Описание симметричного клинка — полуширина, толщина, сечение, долы, волна, изгиб. */
interface SymDef {
  len: number;
  w: (t: number) => number;
  th: (t: number) => number;
  shape?: (t: number) => Shape;
  fuller?: (t: number) => { g: number; gd: number };
  side?: (t: number) => { sx: number; sg: number; sgd: number };
  /** Смещение обеих кромок (пламенеющий клинок): гребень прямой, кромки волной. */
  wave?: (t: number) => number;
  /** Смещение всей оси (крис, сабля). */
  curve?: (t: number) => number;
  /** Доп. уширение правой/левой стороны (асимметричная пята кериса). */
  flare?: (t: number) => { r: number; l: number };
  lay?: Partial<Layout>;
  n?: number; tipFrom?: number; tipN?: number; breaks?: number[];
  ric?: Ricasso;
}

function symBlade(d: SymDef): BladeDef {
  const shapeAt = d.shape ?? ((): Shape => FLAT);
  const ric = d.ric;
  const tr = ric ? ric.len / d.len : 0;
  const tt = tr + 0.012;
  const secAt = (t: number): Sec => {
    const c = d.curve ? d.curve(t) : 0;
    const wv = d.wave ? d.wave(t) : 0;
    const fl = d.flare ? d.flare(t) : { r: 0, l: 0 };
    const w = d.w(t), sh = shapeAt(t);
    const f = d.fuller ? d.fuller(t) : { g: 0, gd: 0 };
    const sd = d.side ? d.side(t) : { sx: 0, sg: 0, sgd: 0 };
    return {
      xC: c, xR: c + w + wv + fl.r, xL: c - w + wv - fl.l, th: d.th(t),
      shR: sh.sh, zsR: sh.zs, shL: sh.sh, zsL: sh.zs,
      g: f.g, gd: f.gd, sx: sd.sx, sg: sd.sg, sgd: sd.sgd,
    };
  };
  const prof = (t: number): Sec => {
    if (!ric || t >= tt) return secAt(t);
    const th = d.th(t) * 1.12;
    if (t <= tr) return { xC: 0, xR: ric.w, xL: -ric.w, th, shR: BLUNT.sh, zsR: BLUNT.zs, shL: BLUNT.sh, zsL: BLUNT.zs, g: 0, gd: 0, sx: 0, sg: 0, sgd: 0 };
    const u = smooth((t - tr) / (tt - tr));
    const b = secAt(tt);
    const sh = mixShape(BLUNT, { sh: b.shR, zs: b.zsR }, u);
    return { ...b, xR: lerp(ric.w, b.xR, u), xL: lerp(-ric.w, b.xL, u), th: lerp(th, b.th, u), shR: sh.sh, zsR: sh.zs, shL: sh.sh, zsL: sh.zs, g: 0, sg: 0 };
  };
  const lay: Layout = { center: !!d.fuller, side: !!d.side, ...d.lay };
  const breaks = [...(d.breaks ?? [])];
  if (ric) breaks.push(tr, tt);
  const b0 = secAt(tt);
  return {
    len: d.len, prof, lay, n: d.n, tipFrom: d.tipFrom, tipN: d.tipN, breaks,
    ric: ric ? { ...ric, wAfter: Math.max(b0.xR, -b0.xL), th: d.th(tt) } : undefined,
  };
}

/** Полуширина: от w0 у пяты к w1 в ts (прямо), дальше остриё: k — выпуклость (0 — треугольное, <0 — вогнутое), 'round' — скруглённое. */
function taper(w0: number, w1: number, ts: number, k: number | 'round'): (t: number) => number {
  return (t: number): number => {
    if (t <= ts) return lerp(w0, w1, ts > 0 ? t / ts : 0);
    const u = clamp((t - ts) / (1 - ts), 0, 1);
    return k === 'round' ? w1 * Math.sqrt(Math.max(0, 1 - u * u)) : w1 * (1 - u) * (1 + k * u);
  };
}

/** Дол от `from` до `to`: полуширина от hw0 к hw1, скруглённые концы. */
function fullerFn(to: number, hw0: number, hw1 = hw0, depth = 0.16, from = 0): (t: number) => { g: number; gd: number } {
  return (t: number) => {
    if (t < from || t >= to) return { g: 0, gd: 0 };
    const span = to - from;
    const u = (t - from) / span;
    const end = Math.sqrt(clamp((to - t) / Math.max(0.01, span * 0.1), 0, 1));
    const start = from > 0 ? Math.sqrt(clamp((t - from) / Math.max(0.01, span * 0.1), 0, 1)) : 1;
    return { g: lerp(hw0, hw1, u) * end * start, gd: depth };
  };
}

/** Однолезвийное сечение: кромка в +X, толстая спинка в −X, дол у спинки. */
function singleSec(xL: number, xR: number, th: number, g = 0, gd = 0.12): Sec {
  const xR2 = Math.max(xR, xL + 0.04);
  return { xL, xR: xR2, xC: xL + 0.3 * (xR2 - xL), th, shR: 0.55, zsR: 0.78, shL: 0.85, zsL: 1, g, gd };
}

/** Клинок в группу: лофт + крюки рикассо + обмотка рикассо. */
function bladeGroup(def: BladeDef, y0: number, ctx: MeshCtx): THREE.Group {
  const g = new THREE.Group();
  const mat = ctx.mat('strike');
  const ts = stationsT(def.n ?? 22, def.tipFrom ?? 0.85, def.tipN ?? 6, def.breaks ?? []);
  const st = ts.map((t) => ({ y: y0 - t * def.len, s: def.prof(t) }));
  for (const m of loft(st, def.lay, mat, shade(ctx, 'strike', 0.5))) g.add(m);
  const ric = def.ric;
  if (ric) {
    const yr = y0 - ric.len;
    if (ric.lug > 0) {
      const L = ric.lug;
      const lug = extrudeXY([[0, -0.9], [L * 0.55, -0.25], [L, 1.2], [L * 0.8, 1.55], [0, 0.75]], Math.max(0.5, ric.th * 0.95), mat);
      at(lug, ric.wAfter - 0.25, yr);
      g.add(lug, mirrorX(lug));
    }
    if (ric.wrap) {
      const h = ric.len * 0.78;
      const sleeve = cyl(1, 1, h, ctx.mat('grip'), 10);
      sleeve.scale.set(ric.w + 0.18, 1, ric.th / 2 + 0.28);
      g.add(at(sleeve, 0, y0 - 0.6 - h / 2));
      for (const yy of [y0 - 0.6, y0 - 0.6 - h]) {
        const band = cyl(1, 1, 0.5, shade(ctx, 'grip', 0.6, 0, 0.8), 10);
        band.scale.set(ric.w + 0.3, 1, ric.th / 2 + 0.4);
        g.add(at(band, 0, yy));
      }
    }
  }
  return g;
}

// ── МЕЧ: клинки ─────────────────────────────────────────────────────────────────────────────────

// Классы клинка только по ДЛИНЕ (§3.5, решение 24.09): короткий до 78 · длинный 78–90 · полуторный
// 90–110 · двуручный от 110. Эпоха — отдельно, у типа клинка. Длины типов сняты с медиан оригиналов
// («Размеры исторических мечей»). ⚠ Это ФОЛБЭК: у каждого типа своя длина в его `case`.
const SWORD_LEN: Record<string, number> = { short: 70, arming: 84, great: 100, huge: 124 };
const BASE_BLADE: Record<string, string> = { 'short-sword': 'short', gladius: 'short', 'long-sword': 'arming', greatsword: 'great', claymore: 'huge' };

/** Клинок меча по типу Окшотта / римскому типу, пропорции — от оси. */
function swordBlade(ctx: MeshCtx): BladeDef {
  const p = ctx.parts.strike;
  const A = byAxis(p.axis, 0.86, 1.14);       // ширина
  const At = byAxis(p.axis, 0.9, 1.1);        // толщина
  const kind = ctx.tag('strike', 'blade') || BASE_BLADE[ctx.baseId] || 'arming';
  const type = ctx.tag('strike', 'type');
  const single = ctx.tag('strike', 'edge') === 'single';
  const ricTag = ctx.tag('strike', 'ricasso') === 'yes';
  const th = (a: number, b: number) => (t: number): number => lerp(a, b, t) * At;

  let d: SymDef | null = null;
  switch (type) {
    // ─ короткие ─
    case 'XXII': d = { len: 76, w: taper(3.3 * A, 2.3 * A, 0.74, 0.5), th: th(0.6, 0.32),
      side: (t) => ({ sx: 0.75 * A, sg: t < 0.3 ? 0.26 * Math.sqrt(clamp((0.3 - t) / 0.03, 0, 1)) : 0, sgd: 0.13 }), n: 18, tipFrom: 0.74, breaks: [0.28, 0.3] }; break;
    case 'XIIIb': d = { len: 75, w: taper(2.75 * A, 2.55 * A, 0.9, 'round'), th: th(0.55, 0.32), fuller: fullerFn(0.5, 0.62 * A), tipFrom: 0.9, tipN: 7 }; break;
    case 'XIV': d = { len: 72, w: taper(3.35 * A, 1.25 * A, 0.82, 0.35), th: th(0.6, 0.3), fuller: fullerFn(0.38, 0.8 * A, 0.5 * A), tipFrom: 0.82 }; break;
    // ─ римские ─
    case 'hisp': d = { len: 66, th: th(0.75, 0.35), shape: () => LENS, tipFrom: 0.7, tipN: 8,
      w: (t) => {
        if (t < 0.7) return (2.75 - 0.4 * Math.sin((PI * Math.min(t, 0.64)) / 0.64)) * A;      // «талия» листа
        const u = (t - 0.7) / 0.3; return 2.75 * A * (1 - u) * (1 + 0.2 * u);                 // длинное остриё
      } }; break;
    case 'mainz': d = { len: 57, w: taper(2.85 * A, 2.3 * A, 0.64, -0.3), th: th(0.72, 0.3), shape: () => LENS, tipFrom: 0.64, tipN: 8 }; break;
    case 'fulham': d = { len: 54, w: taper(2.6 * A, 2.45 * A, 0.8, 0), th: th(0.7, 0.32), shape: () => LENS, tipFrom: 0.8 }; break;
    case 'pompeii': d = { len: 50, w: taper(2.45 * A, 2.45 * A, 0.89, 0.25), th: th(0.7, 0.34), shape: () => LENS, tipFrom: 0.89 }; break;
    // ─ архаичные: бронза и раннее железо ─
    case 'arch-leaf': {
      // Ксифос: полотно раздаётся к середине и оттуда сходится в остриё — вес уходит туда, где
      // клинок встречает цель. Тонкое бронзовое полотно держит от складывания высокий гребень.
      const w0 = 1.95 * A, wm = 3.4 * A, tm = 0.5;
      d = { len: 60, th: th(0.8, 0.34), shape: () => DIAM, n: 20, tipFrom: tm, tipN: 10, breaks: [tm],
        w: (t) => (t <= tm ? lerp(w0, wm, smooth(t / tm)) : wm * pw(1 - (t - tm) / (1 - tm), 0.75)) };
      break;
    }
    case 'arch-cast': {
      // Науэ II отлит заодно с рукоятью: сразу над пятой остаётся «талия» — туда металл в форму
      // приходит последним. Чечевичное сечение и лишняя толщина — запас против излома по литью.
      const tw = 0.16, wm = 3.1 * A, tm = 0.6;
      d = { len: 62, th: th(0.95, 0.42), shape: () => LENS, n: 22, tipFrom: tm, tipN: 8, breaks: [tw],
        w: (t) => {
          if (t < tw) return lerp(3.0 * A, 1.85 * A, smooth(t / tw));
          if (t < tm) return lerp(1.85 * A, wm, smooth((t - tw) / (tm - tw)));
          return wm * pw(1 - (t - tm) / (1 - tm), 0.9);
        } };
      break;
    }
    case 'arch-needle': {
      // Рапира Сандарса: резать ей нечем — кромки идут почти параллельно, весь смысл в уколе.
      // Потому гребень тянется во всю длину и толщина близка к полуширине: иначе сложится о кость.
      d = { len: 88, w: taper(1.3 * A, 1.1 * A, 0.9, 0.15), th: th(1.2, 0.5), shape: () => DIAM,
        lay: { lean: true }, n: 20, tipFrom: 0.9, tipN: 8 };
      break;
    }
    case 'arch-tongue': {
      // «Язык карпа»: рубит широким полотном, а колет узким языком, и переход между ними — СТУПЕНЬ.
      // Ступень короткая (2% длины): растяни её — и вместо уступа читается обычное сужение.
      const st = 0.72, sw = 0.02, wn = 1.05 * A;
      d = { len: 64, th: th(0.68, 0.36), n: 22, tipFrom: st + sw, tipN: 7, breaks: [st, st + sw],
        w: (t) => {
          if (t < st) return lerp(3.15 * A, 2.95 * A, t / st);
          if (t < st + sw) return lerp(2.95 * A, wn, (t - st) / sw);
          const u = (t - st - sw) / (1 - st - sw);
          return wn * (1 - u) * (1 + 0.3 * u);
        } };
      break;
    }
    case 'arch-stub': {
      // Акинак: самое короткое полотно, какое ещё зовут мечом. Кромки параллельны до последней
      // пятой части и там ломаются в прямое остриё — плавного схода нет, отсюда излом на 0.8.
      d = { len: 45, w: taper(1.95 * A, 1.8 * A, 0.8, 0.05), th: th(0.72, 0.42), shape: () => LENS,
        n: 16, tipFrom: 0.8, tipN: 5, breaks: [0.8] };
      break;
    }
    case 'arch-blunt': {
      // Латен III: острия нет вовсе — конец срезан и скруглён, колоть таким нечем. Широкий дол
      // почти во всю длину снимает вес с полотна, которому остаётся только рубить.
      d = { len: 84, w: taper(2.95 * A, 2.8 * A, 0.95, 'round'), th: th(0.55, 0.38),
        fuller: fullerFn(0.88, 0.9 * A, 0.7 * A, 0.17), tipFrom: 0.95, tipN: 8 };
      break;
    }
    case 'arch-watered': {
      // Спата — конная мера: длинное ровное полотно и скруглённый конец. Дол широкий, но мелкий:
      // сварной узор живёт в самой поверхности, глубокая канавка срезала бы его вместе с металлом.
      d = { len: 69, w: taper(2.45 * A, 2.25 * A, 0.86, 'round'), th: th(0.5, 0.32),
        fuller: fullerFn(0.74, 1.05 * A, 0.9 * A, 0.1), tipFrom: 0.86, tipN: 7 };
      break;
    }
    // ─ рыцарские ─
    case 'X': d = { len: 80, w: taper(2.9 * A, 2.45 * A, 0.9, 0.9), th: th(0.5, 0.3), fuller: fullerFn(0.86, 0.85 * A, 0.62 * A, 0.18), tipFrom: 0.9 }; break;
    case 'XI': d = { len: 87, w: taper(2.1 * A, 1.75 * A, 0.86, 0.6), th: th(0.5, 0.3), fuller: fullerFn(0.82, 0.32, 0.26, 0.13), tipFrom: 0.86 }; break;
    case 'XII': d = { len: 84, w: taper(2.6 * A, 1.5 * A, 0.84, 0.5), th: th(0.55, 0.3), fuller: fullerFn(0.66, 0.68 * A, 0.4 * A), tipFrom: 0.84 }; break;
    case 'XIIa': d = { len: 104, w: taper(2.75 * A, 1.55 * A, 0.85, 0.5), th: th(0.6, 0.3), fuller: fullerFn(0.66, 0.72 * A, 0.42 * A), tipFrom: 0.85 }; break;
    case 'XIII': d = { len: 82, w: taper(2.8 * A, 2.68 * A, 0.915, 'round'), th: th(0.5, 0.32), fuller: fullerFn(0.5, 0.75 * A), tipFrom: 0.915, tipN: 7 }; break;
    case 'XIIIa': d = { len: 93, w: taper(3.05 * A, 2.85 * A, 0.925, 'round'), th: th(0.55, 0.32), fuller: fullerFn(0.5, 0.8 * A), tipFrom: 0.925, tipN: 7 }; break;
    case 'XV': d = { len: 74, w: (t) => 2.4 * A * (1 - t) * (1 + 0.15 * t), th: th(1.0, 0.3), shape: () => DIAM, lay: { lean: true }, tipFrom: 0.8 }; break;
    case 'XVa': d = { len: 91, w: (t) => 1.95 * A * (1 - t) * (1 + 0.25 * t), th: th(1.1, 0.35), shape: () => DIAM, lay: { lean: true }, tipFrom: 0.8 }; break;
    case 'XVI': d = { len: 76, w: taper(2.6 * A, 1.85 * A, 0.58, 0.25), th: th(0.6, 0.45), fuller: fullerFn(0.47, 0.62 * A),
      shape: (t) => mixShape(FLAT, DIAM, smooth((t - 0.42) / 0.14)), tipFrom: 0.58, breaks: [0.47, 0.5, 0.56] }; break;
    case 'XVII': d = { len: 92, w: (t) => 2.25 * A * (1 - t) * (1 + 0.35 * t), th: th(1.0, 0.35), shape: () => HEX, fuller: fullerFn(0.2, 0.38), tipFrom: 0.85 }; break;
    case 'XVIII': d = { len: 80, w: (t) => 3.0 * A * (1 - t) * (1 + 0.5 * t), th: th(0.95, 0.3), shape: () => DIAM, lay: { lean: true }, tipFrom: 0.8 }; break;
    case 'XIX': d = { len: 89, w: taper(1.85 * A, 1.7 * A, 0.88, 0.5), th: th(0.72, 0.35), shape: () => HEX, fuller: fullerFn(0.34, 0.28, 0.24, 0.12, 0.07),
      ric: { len: 5, w: 1.45 * A, wrap: false, lug: 0 }, tipFrom: 0.88 }; break;
    case 'XX': d = { len: 102, w: taper(3.0 * A, 2.1 * A, 0.85, 0.5), th: th(0.6, 0.3), fuller: fullerFn(0.55, 0.55 * A, 0.4 * A),
      side: (t) => ({ sx: 1.45 * A, sg: t < 0.3 ? 0.3 * Math.sqrt(clamp((0.3 - t) / 0.03, 0, 1)) : 0, sgd: 0.12 }), n: 17, tipFrom: 0.85, breaks: [0.28, 0.3] }; break;
    // ─ огромные ─
    case 'straight': d = { len: 114, w: taper(2.9 * A, 2.4 * A, 0.9, 0.6), th: th(0.7, 0.32), fuller: fullerFn(0.36, 0.72 * A), tipFrom: 0.9 }; break;
    case 'wide-ricasso': d = { len: 124, w: taper(3.1 * A, 2.4 * A, 0.9, 0.55), th: th(0.72, 0.32), fuller: fullerFn(0.46, 0.7 * A, 0.55 * A, 0.18, 0.16),
      ric: { len: 18, w: 1.55 * A, wrap: true, lug: 2.6 }, tipFrom: 0.9 }; break;
    case 'narrow-ricasso': d = { len: 130, w: (t) => 2.5 * A * (1 - t) * (1 + 0.35 * t), th: th(1.0, 0.32), shape: () => DIAM,
      ric: { len: 20, w: 1.3 * A, wrap: false, lug: 2.0 }, tipFrom: 0.85 }; break;
    case 'wavy': {
      const from = 0.05, to = 0.93, count = 16;
      d = { len: 128, w: taper(2.5 * A, 1.9 * A, 0.9, 0.5), th: th(0.8, 0.3), shape: () => DIAM, lay: { lean: true },
        wave: (t) => {
          if (t < from || t > to) return 0;
          const u = (t - from) / (to - from);
          const env = Math.min(1, u / 0.04, (1 - u) / 0.06);
          return 0.6 * A * env * Math.sin(u * PI * count);
        },
        n: Math.round((count * 4.6) / (to - from)), tipFrom: 0.9 };
      break;
    }
    default: break;
  }

  // Однолезвийные: фальшион и сабля — свои контуры (прямая спинка, кромка в +X).
  if (type === 'falchion') {
    const back = -1.45 * A, tipX = back + 0.5 * A, wMax = 4.4 * A;
    return {
      len: 73, lay: { center: true, side: false }, tipFrom: 0.8, tipN: 8, breaks: [0.84],
      prof: (t) => {
        const xL = t < 0.84 ? back : lerp(back, tipX, smooth((t - 0.84) / 0.16));
        const xR = t <= 0.8
          ? lerp(1.6 * A, wMax, pw(t / 0.8, 1.4))
          : tipX + (wMax - tipX) * Math.sqrt(Math.max(0, 1 - ((t - 0.8) / 0.2) ** 2));
        const f = fullerFn(0.6, 0.28, 0.24, 0.12)(t);
        return singleSec(xL, xR, lerp(0.85, 0.45, t) * At, f.g, f.gd);
      },
    };
  }
  if (type === 'sabre') {
    const sag = 4.2, w0 = 3.25 * A, w1 = 2.75 * A;
    return {
      len: 83, lay: { center: true, side: false }, tipFrom: 0.85, tipN: 7, n: 26,
      prof: (t) => {
        const spine = -sag * t * t - 1.15 * A;
        const f = fullerFn(0.72, 0.26, 0.22, 0.11)(t);
        if (t <= 0.85) return singleSec(spine, spine + lerp(w0, w1, t / 0.85), lerp(0.75, 0.4, t) * At, f.g, f.gd);
        const u = (t - 0.85) / 0.15;
        const xL = spine + 0.55 * A * u * u;
        return singleSec(xL, xL + w1 * (1 - u) * (1 + 0.6 * u), lerp(0.75, 0.35, t) * At, f.g, f.gd);
      },
    };
  }

  // Архаичные однолезвийные — тем же приёмом, что фальшион и сабля: кромка в +X, спинка в −X.
  if (type === 'arch-sickle') {
    // Хопеш: у рукояти прямая незаточенная пята, дальше полотно валится серпом. Заточен он по
    // ВНЕШНЕЙ стороне изгиба, поэтому ось уходит в −X: выпуклой выходит кромка, а не спинка.
    const tr = 0.2, hook = 10.5 * A, wm = 3.6 * A;
    return {
      len: 45, lay: { center: false, side: false }, n: 26, tipFrom: 0.86, tipN: 7, breaks: [tr - 0.015, tr],
      prof: (t) => {
        const tk = lerp(0.85, 0.5, t) * At;
        // Пята — симметричный тупой брусок: за неё берутся второй рукой, затачивать её нечем.
        if (t < tr - 0.015) return { xC: 0, xR: 0.95 * A, xL: -0.95 * A, th: tk * 1.2, shR: BLUNT.sh, zsR: BLUNT.zs, shL: BLUNT.sh, zsL: BLUNT.zs };
        const u = clamp((t - tr) / (1 - tr), 0, 1);
        const back = -1.2 * A - hook * pw(u, 1.7);
        const w = lerp(2.1 * A, wm, smooth(u));
        if (t <= 0.86) return singleSec(back, back + w, tk);
        const v = (t - 0.86) / 0.14;
        return singleSec(back + 0.45 * w * v * v, back + w * (1 - v) * (1 + 0.5 * v), tk);
      },
    };
  }
  if (type === 'arch-falling') {
    // Копис: полотно валится вперёд, но заточка ложится на ВНУТРЕННЮЮ, вогнутую сторону — потому
    // ось уходит в +X, к кромке. У рукояти полотно поджато в «горло», к концу распирает: сам падает.
    const drop = 6.2 * A, wm = 4.25 * A;
    return {
      len: 58, lay: { center: true, side: false }, n: 26, tipFrom: 0.84, tipN: 7,
      prof: (t) => {
        const back = -1.45 * A + drop * pw(t, 1.8);
        const f = fullerFn(0.72, 0.24, 0.2, 0.11)(t);
        const tk = lerp(0.9, 0.46, t) * At;
        const w = t < 0.3 ? lerp(2.6 * A, 2.2 * A, t / 0.3) : lerp(2.2 * A, wm, smooth((t - 0.3) / 0.54));
        if (t <= 0.84) return singleSec(back, back + w, tk, f.g, f.gd);
        const v = (t - 0.84) / 0.16;
        return singleSec(back + 0.5 * A * v * v, back + wm * (1 - v) * (1 + 0.55 * v), tk, f.g, f.gd);
      },
    };
  }
  if (type === 'arch-backed') {
    // Сакс: спинка прямая и толстая во всю длину, заточка одна. Остриё сидит У СПИНКИ — к концу
    // поднимается кромка, а спинка не опускается: на такой обух кузнецу хватает и полосы железа.
    const back = -1.6 * A, edge = 2.6 * A, tb = 0.64;
    return {
      len: 52, lay: { center: true, side: false }, n: 18, tipFrom: tb, tipN: 8, breaks: [tb],
      prof: (t) => {
        const f = fullerFn(0.58, 0.22, 0.18, 0.1)(t);
        const tk = lerp(1.0, 0.6, t) * At;
        if (t < tb) return singleSec(back, lerp(edge, edge * 0.94, t / tb), tk, f.g, f.gd);
        const u = (t - tb) / (1 - tb);
        return singleSec(back, lerp(edge * 0.94, back + 0.3 * A, pw(u, 1.7)), tk, f.g, f.gd);
      },
    };
  }

  if (!d) {
    // Неизвестный тип — классический XII по длине своего класса.
    const len = SWORD_LEN[kind] ?? 80;
    d = { len, w: taper(2.6 * A, 1.5 * A, 0.84, 0.5), th: th(0.55, 0.3), fuller: fullerFn(0.66, 0.68 * A, 0.4 * A), tipFrom: 0.84 };
  }
  if (ricTag && !d.ric) d.ric = { len: Math.round(d.len * 0.1), w: d.w(0) * 0.6, wrap: false, lug: 1.8 };
  if (single) {
    // Однолезвийный вариант любого типа: левая сторона — спинка.
    const base = symBlade(d);
    return { ...base, prof: (t) => { const s = base.prof(t); return { ...s, shL: 0.85, zsL: 1, xL: s.xC - (s.xC - s.xL) * 0.7 }; } };
  }
  return symBlade(d);
}

// ── МЕЧ: рукоять ────────────────────────────────────────────────────────────────────────────────

// Длины хвата, см (без навершия): у одноручных 9–11 (история 8.5–11.5), полуторная 19, двуручная 22 —
// полуторник держат двумя на 20–22, длинная двуручная 33 × 1.1 ≈ 36 — хват цвайхендера (30–40).
const HOLD_LEN: Record<string, number> = { cramped: 9, short: 10, one: 11, 'hand-half': 19, long: 23, two: 22, 'two-long': 33 };
const BARREL = [0.86, 0.97, 1.02, 0.97, 0.86];
/** Профиль рукояти по хвату: бочонок, «бутылка» полуторника, длинная к навершию тоньше, двуручная с перехватом. */
const HOLD_SHAPE: Record<string, readonly number[]> = {
  cramped: BARREL, short: BARREL, one: BARREL,
  'hand-half': [0.88, 1.03, 1.06, 0.93, 0.86, 0.9, 0.95],
  long: [0.96, 1.02, 1.02, 0.97, 0.9, 0.85, 0.83],
  two: [0.9, 1.0, 1.05, 1.06, 1.02, 0.95, 0.9],
  'two-long': [0.92, 1.04, 1.0, 0.84, 1.02, 1.03, 0.98, 0.9],
};

/** Ножевая рукоять мессера: хвостовик-пластина, две щёчки и заклёпки. От y=0 вверх. */
function knifeGrip(len: number, halfW: number, ctx: MeshCtx, rivets: number): THREE.Group {
  const g = new THREE.Group();
  const p = ctx.parts.grip;
  // Щёчки расширяются к торцу, конец загнут к лезвию (+X) — «клюв» мессера.
  const o: V2[] = [
    [-halfW, 0], [halfW, 0], [halfW * 1.02, len * 0.5], [halfW * 1.15, len * 0.82], [halfW * 1.5, len * 0.97],
    [halfW * 1.25, len], [0, len * 1.02], [-halfW * 1.1, len * 0.96], [-halfW * 1.08, len * 0.6],
  ];
  const tang = extrudeXY(o.map(([x, y]) => [x * 1.04, y] as V2), 0.45, ctx.matOf('iron', p.step));
  g.add(tang);
  for (const z of [1, -1]) g.add(at(extrudeXY(o, 0.75, ctx.matOf('wood', p.step)), 0, 0, z * 0.6));
  const rm = ctx.matOf('trim', p.step);
  for (let i = 0; i < rivets; i++) {
    const y = len * (0.18 + (0.64 * i) / Math.max(1, rivets - 1));
    g.add(at(cyl(0.32, 0.32, 2.3, rm, 8), halfW * 0.05, y, 0, PI / 2));
  }
  return g;
}

function swordGrip(ctx: MeshCtx, two: boolean): { group: THREE.Group; len: number } {
  const p = ctx.parts.grip;
  const hold = ctx.tag('grip', 'hold') || (two ? 'two' : 'one');
  const len = (HOLD_LEN[hold] ?? (two ? 22 : 11)) * byAxis(p.axis, 0.9, 1.1);
  const R = (two ? 1.62 : 1.42) * byAxis(p.axis, 0.95, 1.05);
  const quirk = hash01(p.id) < 0.5 ? 0 : 1;
  const g = new THREE.Group();
  if (ctx.tag('grip', 'build') === 'knife') {
    g.add(knifeGrip(len, R * 0.95, ctx, 3 + quirk));
    return { group: g, len };
  }
  const shape = HOLD_SHAPE[hold] ?? BARREL;
  const ridges = Math.max(3, Math.round(len / (two ? 3.3 : 2.4))) + quirk;
  const core = ridgedLathe(len, R, (u) => pwl(u, shape), ridges, 0.06, ctx.mat('grip'), 10);
  core.scale.z = 0.8;
  g.add(core);
  // Обоймицы у гарды и у навершия; у длинной двуручной — ещё кольцо перехвата.
  const fm = ctx.matOf('trim', p.step);
  const ferrule = (r: number, h: number, y: number): void => {
    const f = cyl(r, r, h, fm, 10); f.scale.z = 0.8; g.add(at(f, 0, y));
  };
  ferrule(R * (shape[0] ?? 1) * 1.08, 0.9, 0.45);
  ferrule(R * (shape[shape.length - 1] ?? 1) * 1.08, 0.7, len - 0.35);
  if (hold === 'two-long') ferrule(R * 1.12, 1.1, len * (3 / 7));
  return { group: g, len };
}

// ── МЕЧ: гарда ──────────────────────────────────────────────────────────────────────────────────

/** Брусок-перекрестье из контура: верх ровный (у рукояти), низ выпуклый. y от 0 вниз. */
function barOutline(hw: number, H: number, endK: number, droop = 0): V2[] {
  const top: V2[] = [], bot: V2[] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const x = -hw + (2 * hw * i) / N;
    const q = (x / hw) ** 2;
    top.push([x, -droop * q]);
    bot.push([x, -droop * q - H * (1 - endK * q)]);
  }
  return [...top, ...bot.reverse()];
}

/** Четырёхлистник на конце дужки клеймора: четыре кольца крестом вокруг точки. */
function quatrefoil(cx: number, cy: number, ang: number, rq: number, rt: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  for (let k = 0; k < 4; k++) {
    const a = ang + (k * PI) / 2;
    g.add(at(ring(rq, rt, mat, 10, 4), cx + rq * 1.05 * Math.cos(a), cy + rq * 1.05 * Math.sin(a)));
  }
  return g;
}

function swordGuard(ctx: MeshCtx, two: boolean): THREE.Group {
  const gr = new THREE.Group();
  const m = ctx.mat('bind');
  const p = ctx.parts.bind;
  const s = byAxis(p.axis, 0.88, 1.12) * (two ? 1.35 : 1);
  const H = two ? 2.1 : 1.7, D = two ? 2.6 : 2.2;
  const knob = 1 + 0.12 * hash01(p.id);
  const guard = ctx.tag('bind', 'guard') || 'long-straight';
  switch (guard) {
    case 'short-cross': {
      // Стиль 3: короткий толстый брусок эпохи викингов, к концам тоньше.
      gr.add(extrudeXY(barOutline(5 * s, H * 1.25, 0.42), D * 1.15, m));
      break;
    }
    case 'long-straight': {
      // Стиль 1: длинная прямая крестовина квадратного сечения, сужение к концам + щиток на клинок.
      const L = 9.5 * s - 1.3;
      gr.add(at(box(2.6, H, D, m), 0, -H / 2));
      const arm = at(cyl(0.45 * knob, H * 0.56, L, m, 4), 1.3 + L / 2, -H / 2, 0, PI / 4, 0, -PI / 2);
      gr.add(arm, mirrorX(arm));
      gr.add(at(extrudeXY([[0, 0], [1.25, -1.5], [0, -3.1], [-1.25, -1.5]], D * 0.55, m), 0, -H + 0.3));
      break;
    }
    case 'curved': {
      // Стили 4/6/7: концы загнуты к клинку, на концах шарики.
      const hw = 9 * s, drop = 3.2 * s, y = -H / 2;
      const pts: [number, number, number][] = [
        [-hw, y - drop, 0], [-hw * 0.72, y - drop * 0.42, 0], [-hw * 0.38, y - drop * 0.06, 0], [0, y, 0],
        [hw * 0.38, y - drop * 0.06, 0], [hw * 0.72, y - drop * 0.42, 0], [hw, y - drop, 0],
      ];
      gr.add(tube(pts, H * 0.34, m, { segments: 36, radial: 8 }));
      gr.add(at(box(2.8, H, D, m), 0, y));
      const k = at(sphere(H * 0.48 * knob, m, 10), hw, y - drop);
      gr.add(k, mirrorX(k));
      break;
    }
    case 'figured': {
      // Стили 5/8/9/12: тонкие плечи раздаются к концам в «рыбий хвост», концы чуть к клинку.
      const hw = 9 * s, top: V2[] = [], bot: V2[] = [];
      const N = 10;
      for (let i = 0; i <= N; i++) {
        const x = -hw + (2 * hw * i) / N, q = Math.abs(x) / hw;
        const half = 0.5 * H + 1.7 * s * q ** 3 * knob, dy = -H / 2 - 1.1 * s * q * q;
        top.push([x, dy + half]); bot.push([x, dy - half]);
      }
      const yEnd = -H / 2 - 1.1 * s;
      const o: V2[] = [...top, [hw - 1.1 * s, yEnd], ...bot.reverse(), [-hw + 1.1 * s, yEnd]];
      gr.add(extrudeXY(o, D * 0.8, m));
      gr.add(at(extrudeXY([[0, 0.2], [1.4, -1.2], [0, -3.2], [-1.4, -1.2]], D * 1.05, m), 0, -H / 2));
      break;
    }
    case 'rings-hooks': {
      // Эфес позднего двуручника: длинная крестовина, боковые кольца, парирующие крюки к клинку.
      // У двуручника крестовина 35–45 см — иначе на 150-см мече эфес теряется.
      const hw = (two ? 13.5 : 11) * s, L = hw - 1.4, y = -H / 2;
      gr.add(at(box(2.8, H * 1.1, D * 1.05, m), 0, y));
      const arm = at(cyl(H * 0.3, H * 0.44, L, m, 8), 1.4 + L / 2, y, 0, 0, 0, -PI / 2);
      const end = at(sphere(H * 0.52 * knob, m, 8), hw, y);
      gr.add(arm, mirrorX(arm), end, mirrorX(end));
      // Боковые кольца — поперёк плоскости клинка, наклонены к клинку (видны и плашмя, и с ребра).
      const R = (two ? 2.9 : 2.5) * s, tilt = 0.8, rr = 0.34 * Math.min(1.3, s);
      for (const z of [1, -1]) {
        gr.add(at(ring(R, rr, m, 14, 5), 0, y - (R - 0.2) * Math.sin(tilt), z * (D / 2 + (R - 0.2) * Math.cos(tilt)), z * (PI / 2 + tilt)));
      }
      const k = s, hr = 0.3 * Math.min(1.3, s);
      const hookEnd: [number, number, number] = [3.9 * k, -H - 4.8 * k, 0];
      const hook = tube([[1.1, -H * 0.8, 0], [3.2 * k, -H - 0.6 * k, 0], [4.6 * k, -H - 2.2 * k, 0], [4.7 * k, -H - 3.8 * k, 0], hookEnd],
        hr, m, { segments: 16, radial: 5 });
      const hookTip = at(sphere(hr * 1.5, m, 6), hookEnd[0], hookEnd[1]);
      gr.add(hook, mirrorX(hook), hookTip, mirrorX(hookTip));
      break;
    }
    case 'claymore': {
      // Шотландский двуручник: дужки наклонены к клинку, на концах четырёхлистники; язычки на клинок.
      // Размах гарды — 27–32 см у горских оригиналов (RA IX.912: 27.2): дужка 8.8·s даёт ≈30.
      const a = 0.66, L = 8.8 * s, dir = [Math.cos(a), -Math.sin(a)] as const, y = -H / 2;
      gr.add(at(box(3.2, H * 1.2, D, m), 0, y));
      const arm = at(cyl(H * 0.26, H * 0.4, L, m, 8), (dir[0] * L) / 2, y + (dir[1] * L) / 2, 0, 0, 0, -(PI / 2 + a));
      gr.add(arm, mirrorX(arm));
      const rq = 1.45 * knob * Math.min(1.25, s / 1.2);
      const qf = quatrefoil(dir[0] * (L + rq * 1.05), y + dir[1] * (L + rq * 1.05), -a, rq, 0.3, m);
      gr.add(qf, mirrorX(qf));
      const langet: V2[] = [[-0.8, 0], [0.8, 0], [0.8, -4.6], [0, -5.9], [-0.8, -4.6]];
      for (const z of [1, -1]) gr.add(at(extrudeXY(langet, 0.22, m), 0, -H, z * 0.55));
      break;
    }
    case 'shield': {
      // Гладиус: полуовальный щиток — плоский к клинку, скруглён к рукояти, под ним пластина.
      const dome = latheY([[0.01, -2.7], [3.8 * s, -2.7], [4.05 * s, -2.3], [3.9 * s, -1.6], [3.3 * s, -0.85], [2.25 * s, -0.25], [1.5, 0.05], [0.01, 0.05]], m, 18);
      dome.scale.z = 0.62;
      gr.add(dome);
      const plate = cyl(4.2 * s, 4.2 * s, 0.4, m, 20);
      plate.scale.z = 0.66;
      gr.add(at(plate, 0, -2.9));
      break;
    }
    case 'nagel': {
      // Мессер: прямая крестовина с утолщёнными концами и боковой шип-нагель, прикрывающий пальцы.
      const hw = 7.5 * s, L = hw - 1.2, y = -H / 2;
      gr.add(at(box(2.4, H * 1.1, D * 1.1, m), 0, y));
      const arm = at(cyl(H * 0.36 * knob, H * 0.3, L, m, 6), 1.2 + L / 2, y, 0, 0, 0, -PI / 2);
      gr.add(arm, mirrorX(arm));
      const nl = 3.2 * s;
      gr.add(at(cyl(0.3, 0.46, nl, m, 8), 0, y, D * 0.55 + nl / 2, PI / 2));
      gr.add(at(sphere(0.55 * knob, m, 8), 0, y, D * 0.55 + nl));
      break;
    }
    default: {
      gr.add(extrudeXY(barOutline(8 * s, H, 0.3), D, m));
      break;
    }
  }
  return gr;
}

// ── МЕЧ: навершие ───────────────────────────────────────────────────────────────────────────────

/** Нижний брусок наверший эпохи викингов (Петерсен). */
function lowerGuard(w: number, h: number, d: number, m: THREE.Material): THREE.Mesh {
  return extrudeXY([[-w, 0.12], [-w * 0.6, 0], [w * 0.6, 0], [w, 0.12], [w, h], [-w, h]], d, m);
}

/** Заклёпка хвостовика над навершием. */
function peen(y: number, r: number, h: number, m: THREE.Material): THREE.Mesh {
  return at(latheY([[0.01, 0], [r, 0], [r * 0.95, h * 0.6], [r * 0.5, h], [0.01, h * 1.05]], m, 10), 0, y);
}

function swordPommel(ctx: MeshCtx, two: boolean): THREE.Group {
  const g = new THREE.Group();
  const m = ctx.mat('head');
  const p = ctx.parts.head;
  const s = byAxis(p.axis, 0.88, 1.12) * (two ? 1.22 : 1);
  const ph = (0.45 + 0.2 * hash01(p.id)) * s;   // высота заклёпки — своя у варианта
  switch (ctx.tag('head', 'pommel')) {
    case 'lobed': {
      // Петерсен: нижний брусок + верх из трёх долей, средняя выше.
      const w = 3.4 * s, hb = 1.35 * s;
      g.add(lowerGuard(w, hb, 2.6 * s, m));
      const lobes: [number, number, number][] = [[-2.2 * s, 0.5 * s, 1.15 * s], [0, 1.05 * s, 1.3 * s], [2.2 * s, 0.5 * s, 1.15 * s]];
      const o: V2[] = [[-w * 0.94, hb]];
      const N = 26;
      for (let i = 0; i <= N; i++) {
        const x = -w * 0.94 + (1.88 * w * i) / N;
        let y = 0.15 * s;
        for (const [cx, cy, r] of lobes) if (Math.abs(x - cx) < r) y = Math.max(y, cy + Math.sqrt(r * r - (x - cx) ** 2));
        o.push([x, hb + y]);
      }
      o.push([w * 0.94, hb]);
      g.add(extrudeXY(o, 2.2 * s, m));
      break;
    }
    case 'triangular': {
      // Петерсен: нижний брусок + верх «треуголкой».
      const w = 3.3 * s, hb = 1.3 * s;
      g.add(lowerGuard(w, hb, 2.6 * s, m));
      const o: V2[] = [[-w * 0.95, hb]];
      const N = 12;
      for (let i = 0; i <= N; i++) {
        const x = -w * 0.95 + (1.9 * w * i) / N;
        const q = Math.abs(x) / (w * 0.95);
        o.push([x, hb + 0.15 * s + 2.5 * s * pw(1 - q, 1.15) * (1 - 0.25 * (1 - q) ** 6)]);
      }
      o.push([w * 0.95, hb]);
      g.add(extrudeXY(o, 2.1 * s, m));
      break;
    }
    case 'brazil-nut': {
      // Окшотт A: широкий плоский «орех».
      const nut = latheY([[0.01, 0], [1.0 * s, 0], [2.4 * s, 0.35 * s], [3.25 * s, 1.25 * s], [3.05 * s, 2.2 * s], [2.0 * s, 2.95 * s], [0.01, 3.25 * s]], m, 18);
      nut.scale.z = 0.42;
      g.add(nut);
      g.add(peen(3.2 * s, 0.4 * s, ph * 0.7, m));
      break;
    }
    case 'disc': {
      // Окшотт G: плоский диск плашмя к плоскости клинка.
      const R = 2.75 * s;
      g.add(at(cyl(0.95 * s, 1.1 * s, 0.5 * s, m, 12), 0, 0.25 * s));
      g.add(at(cyl(R, R, 1.7 * s, m, 24), 0, 0.5 * s + R, 0, PI / 2));
      g.add(peen(0.5 * s + 2 * R - 0.05, 0.55 * s, ph, m));
      break;
    }
    case 'wheel': {
      // Окшотт H–K: колесо — скошенные края и выпуклая середина.
      const R = 3.0 * s;
      const pr: V2[] = [[0.01, -1.35 * s], [1.1 * s, -1.35 * s], [1.25 * s, -0.85 * s], [2.75 * s, -0.45 * s], [R, -0.28 * s],
        [R, 0.28 * s], [2.75 * s, 0.45 * s], [1.25 * s, 0.85 * s], [1.1 * s, 1.35 * s], [0.01, 1.35 * s]];
      g.add(at(cyl(0.95 * s, 1.1 * s, 0.5 * s, m, 12), 0, 0.25 * s));
      g.add(at(latheY(pr, m, 24), 0, 0.5 * s + R, 0, PI / 2));
      g.add(peen(0.5 * s + 2 * R - 0.05, 0.55 * s, ph, m));
      break;
    }
    case 'faceted': {
      // Гранёное (Кирпичников VII): шестигранный многогранник.
      g.add(faceted(latheY([[0.01, 0], [0.9 * s, 0], [1.95 * s, 0.9 * s], [2.35 * s, 2.0 * s], [1.95 * s, 3.1 * s], [0.9 * s, 3.8 * s], [0.01, 3.95 * s]], m, 6)));
      g.add(peen(3.9 * s, 0.4 * s, ph * 0.8, m));
      break;
    }
    case 'pear': {
      // Окшотт T: груша, узким концом к рукояти.
      g.add(latheY([[0.01, 0], [0.85 * s, 0], [1.0 * s, 0.6 * s], [1.5 * s, 1.6 * s], [2.05 * s, 2.8 * s], [2.15 * s, 3.6 * s], [1.75 * s, 4.5 * s], [0.9 * s, 5.1 * s], [0.01, 5.3 * s]], m, 16));
      g.add(peen(5.25 * s, 0.45 * s, ph * 0.8, m));
      break;
    }
    case 'fishtail': {
      // Окшотт V: раздвоенный раструб «рыбий хвост».
      const o: V2[] = [[1.1 * s, 0], [1.3 * s, 1.2 * s], [1.9 * s, 2.4 * s], [3.1 * s, 3.45 * s], [3.5 * s, 4.1 * s], [2.1 * s, 3.7 * s], [0, 2.65 * s],
        [-2.1 * s, 3.7 * s], [-3.5 * s, 4.1 * s], [-3.1 * s, 3.45 * s], [-1.9 * s, 2.4 * s], [-1.3 * s, 1.2 * s], [-1.1 * s, 0]];
      g.add(extrudeXY(o, 1.9 * s, m));
      break;
    }
    case 'ball': {
      // Римский гладиус: крупный шар с заклёпкой.
      g.add(at(cyl(1.1 * s, 1.3 * s, 0.5 * s, m, 12), 0, 0.25 * s));
      const b = sphere(2.45 * s, m, 16);
      b.scale.y = 0.86;
      g.add(at(b, 0, 0.45 * s + 2.1 * s));
      g.add(peen(0.45 * s + 4.2 * s - 0.1, 0.5 * s, ph, m));
      break;
    }
    case 'spiked': {
      // Фэнтези: ядро с шипами вверх, в стороны и по Z.
      const cy = 2.2 * s, r = 1.6 * s;
      g.add(at(sphere(r, m, 12), 0, cy));
      const sp = (ang: number, rx = 0): void => {
        const len = 2.4 * s;
        const c = cone(0.55 * s, len, m, 8);
        if (rx) { at(c, 0, cy, Math.sign(rx) * (r + len / 2 - 0.3), rx); }
        else at(c, -Math.sin(ang) * (r + len / 2 - 0.3), cy + Math.cos(ang) * (r + len / 2 - 0.3), 0, 0, 0, ang);
        g.add(c);
      };
      sp(0); sp(PI / 3); sp(-PI / 3); sp(PI / 1.6); sp(-PI / 1.6); sp(0, PI / 2); sp(0, -PI / 2);
      break;
    }
    default: {
      g.add(at(cyl(2.4 * s, 2.4 * s, 1.6 * s, m, 20), 0, 2.6 * s, 0, PI / 2));
      break;
    }
  }
  return g;
}

/** ⭐ МЕЧ: клинок по типу, рукоять по хвату, гарда и навершие по своим формам. */
export function buildSword(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const two = ctx.hands === 2;
  const grip = swordGrip(ctx, two);
  // Основная рука — сразу под гардой: у одноручной рукоять вокруг нуля, у длинной — уходит вверх.
  const yG = -Math.min(5.5, grip.len / 2);
  grip.group.position.y = yG;
  g.grip.add(grip.group);

  const guard = swordGuard(ctx, two);
  guard.position.y = yG;
  g.bind.add(guard);

  g.strike.add(bladeGroup(swordBlade(ctx), yG - 1.2, ctx));

  const pommel = swordPommel(ctx, two);
  pommel.position.y = yG + grip.len;
  g.head.add(pommel);
  return root;
}

// ── КИНЖАЛ ──────────────────────────────────────────────────────────────────────────────────────

const BASE_FAMILY: Record<string, string> = { dagger: 'rhomb', stiletto: 'faceted', 'assassin-blade': 'long-narrow', kris: 'wavy', cleaver: 'single' };

/** Клинок кинжала по семье (Dean 1929); ось: массивный +1 / ровный 0 / облегчённый −1 — ширина и толщина. */
function daggerBlade(ctx: MeshCtx): BladeDef {
  const p = ctx.parts.strike;
  const A = byAxis(p.axis, 0.8, 1.2), At = byAxis(p.axis, 0.85, 1.15);
  const fam = ctx.tag('strike', 'family') || BASE_FAMILY[ctx.baseId] || 'rhomb';
  switch (fam) {
    case 'faceted': {
      // Стилет: квадратное сечение без лезвий, у пяты — гранёный брусок.
      const tb = 0.07;
      return symBlade({
        len: 24, n: 16, tipFrom: 0.9, breaks: [tb, tb + 0.012],
        w: (t) => (t < tb ? 0.95 * A : 0.78 * A * pw(1 - (t - tb) / (1 - tb), 1.05)),
        th: (t) => (t < tb ? 1.5 * A : 1.56 * A * pw(1 - (t - tb) / (1 - tb), 1.05) + 0.02) * (At / A),
        shape: (t) => (t < tb + 0.006 ? BLUNT : DIAM),
      });
    }
    case 'long-narrow': {
      // Рондель: длинный узкий клинок, у острия утолщение против кольчуги.
      return symBlade({
        len: 32, n: 22, tipFrom: 0.82, breaks: [0.7, 0.82],
        w: (t) => {
          if (t < 0.7) return lerp(1.2, 0.78, t / 0.7) * A;
          if (t < 0.82) return lerp(0.78, 0.94, smooth((t - 0.7) / 0.12)) * A;
          const u = (t - 0.82) / 0.18; return 0.94 * A * (1 - u) * (1 + 0.35 * u);
        },
        th: (t) => {
          if (t < 0.7) return lerp(0.85, 0.72, t / 0.7) * At;
          if (t < 0.82) return lerp(0.72, 1.1, smooth((t - 0.7) / 0.12)) * At;
          return 1.1 * At * pw(1 - (t - 0.82) / 0.18, 0.8) + 0.02;
        },
        shape: (t) => mixShape(HEX, DIAM, smooth((t - 0.6) / 0.16)),
      });
    }
    case 'wavy': {
      // Крис: нечётное число волн (7 лук), вся ось змеится, пята асимметрично расширена.
      const from = 0.15, to = 0.93, luk = 7, amp = 0.75 * byAxis(p.axis, 0.9, 1.1);
      return symBlade({
        len: 34, n: 56, tipFrom: 0.88, tipN: 6, lay: { lean: true },
        w: taper(1.55 * A, 0.95 * A, 0.88, 0.4),
        th: (t) => lerp(0.62, 0.22, t) * At,
        shape: () => DIAM,
        curve: (t) => {
          if (t < from || t > to) return 0;
          const u = (t - from) / (to - from);
          return amp * Math.min(1, u / 0.05, (1 - u) / 0.12) * Math.sin(u * PI * luk);
        },
        flare: (t) => ({ r: t < 0.17 ? 1.35 * A * (1 - t / 0.17) ** 2 : 0, l: t < 0.1 ? 0.4 * A * (1 - t / 0.1) ** 2 : 0 }),
      });
    }
    case 'single': {
      // Сакс/тесак: толстая прямая спинка (−X), лезвие в +X; «ломаная спинка» — по тегу spine=broken.
      const broken = ctx.tag('strike', 'spine') === 'broken';
      const back = -1.25 * A, edge = 2.2 * A;
      return {
        len: 30, lay: { center: true, side: false }, n: 18, tipFrom: broken ? 0.62 : 0.68, tipN: 8, breaks: broken ? [0.62] : [0.68],
        prof: (t) => {
          const f = fullerFn(0.62, 0.2, 0.16, 0.1)(t);
          const th = lerp(0.85, 0.45, t) * At;
          if (broken) {
            const tip = edge * 0.86;
            const xL = t < 0.62 ? back : lerp(back, tip, (t - 0.62) / 0.38);
            const xR = t < 0.9 ? edge - 0.15 * A * t : lerp(edge - 0.135 * A, tip, (t - 0.9) / 0.1);
            return singleSec(xL, xR, th, f.g, f.gd);
          }
          // Прямая толстая спинка почти до конца; лезвие широкой дугой поднимается к ней — остриё
          // у спинки, а не по оси: силуэт однолезвийного ножа, а не короткого меча.
          const e0 = (tt: number): number => edge * (1 + 0.04 * Math.sin(PI * tt));
          if (t < 0.68) return singleSec(back, e0(t), th, f.g, f.gd);
          const u = (t - 0.68) / 0.32, tip = back + 0.26 * (edge - back), e68 = e0(0.68);
          return singleSec(lerp(back, tip, pw(u, 2.4)), tip + (e68 - tip) * Math.sqrt(Math.max(0, 1 - u * u)), th, f.g, f.gd);
        },
      };
    }
    default: {
      // Ромбический: плоский ромб, два лезвия, прямое сужение к острию.
      return symBlade({
        len: 26, n: 16, tipFrom: 0.8, lay: { lean: true },
        w: (t) => 1.85 * A * (1 - t) * (1 + 0.35 * t),
        th: (t) => lerp(0.8, 0.2, t) * At,
        shape: () => DIAM,
      });
    }
  }
}

/** Черен кинжала; `top` — куда и под каким углом встаёт оголовок (относительно низа черена). */
function daggerGrip(ctx: MeshCtx): { group: THREE.Group; len: number; top: { x: number; y: number; rz: number } } {
  const p = ctx.parts.grip;
  const kind = ctx.tag('grip', 'grip') || 'spindle';
  const baseLen: Record<string, number> = { spindle: 10, knife: 10, metal: 9.5, hulu: 9.5 };
  const len = (baseLen[kind] ?? 10) * byAxis(p.axis, 0.92, 1.15);
  const R = 1.3 * byAxis(p.axis, 0.95, 1.05);
  const quirk = hash01(p.id) < 0.5 ? 0 : 1;
  const g = new THREE.Group();
  switch (kind) {
    case 'knife': {
      g.add(knifeGrip(len, R * 0.95, ctx, 2 + quirk));
      return { group: g, len, top: { x: 0, y: len, rz: 0 } };
    }
    case 'metal': {
      // Цельнометаллический точёный балясник.
      const prof = [1.0, 1.25, 1.25, 0.88, 1.18, 1.32, 1.18, 0.88, 1.25, 1.25, 1.0];
      const pts: V2[] = [[0.01, 0]];
      prof.forEach((k, i) => pts.push([R * 0.82 * k, (len * i) / (prof.length - 1)]));
      pts.push([0.01, len]);
      g.add(latheY(pts, ctx.matOf('iron', p.step), 14 + 2 * quirk));
      return { group: g, len, top: { x: 0, y: len, rz: 0 } };
    }
    case 'hulu': {
      // Хулу кериса: рукоять, склонённая вперёд, с «брюшком» на изгибе.
      const hm = ctx.mat('grip');
      const bend: [number, number, number][] = [[0, 0, 0], [0.05, len * 0.35, 0], [0.35, len * 0.65, 0], [1.2, len * 0.88, 0], [2.1, len, 0]];
      g.add(tube(bend, R * 0.95, hm, { segments: 24, radial: 10 }));
      g.add(at(sphere(R * 1.18, hm, 12), 0.3, len * 0.55));
      const sel = cyl(R * 1.2, R * 1.1, 0.7, ctx.matOf('trim', p.step), 12 + 2 * quirk);
      g.add(at(sel, 0, 0.35));
      const a = Math.atan2(2.1 - 1.2, len * 0.12);
      return { group: g, len, top: { x: 2.1, y: len, rz: -a } };
    }
    default: {
      // Веретённый: точёный черен, толще в середине, с кольцами.
      const core = ridgedLathe(len, R, (u) => 0.74 + 0.28 * Math.sin(PI * u), 2 + quirk, 0.14, ctx.mat('grip'));
      core.scale.z = 0.85;
      g.add(core);
      return { group: g, len, top: { x: 0, y: len, rz: 0 } };
    }
  }
}

function daggerGuard(ctx: MeshCtx): THREE.Group {
  const gr = new THREE.Group();
  const m = ctx.mat('bind');
  const p = ctx.parts.bind;
  const s = byAxis(p.axis, 0.88, 1.12);
  const knob = 1 + 0.12 * hash01(p.id);
  const H = 1.2, D = 1.7;
  switch (ctx.tag('bind', 'guard')) {
    case 'none': {
      // Без гарды: одна обоймица-втулка на пяте.
      gr.add(latheY([[0.01, -1.0], [1.15 * s, -1.0], [1.4 * s, -0.7], [1.4 * s, -0.25], [1.2 * s, 0.05]], m, 14));
      break;
    }
    case 'nagel': {
      // Короткое перекрестье + нагель вбок.
      const hw = 3.6 * s;
      gr.add(extrudeXY(barOutline(hw, H, 0.35), D, m));
      const nl = 2.2 * s;
      gr.add(at(cyl(0.24, 0.36, nl, m, 8), 0, -H / 2, D / 2 + nl / 2, PI / 2));
      gr.add(at(sphere(0.42 * knob, m, 8), 0, -H / 2, D / 2 + nl));
      break;
    }
    case 'cross': {
      // Квиллоны, слегка загнутые к клинку, с шариками.
      const hw = 4.6 * s, y = -H / 2, drop = 1.1 * s;
      gr.add(tube([[-hw, y - drop, 0], [-hw * 0.55, y - drop * 0.25, 0], [0, y, 0], [hw * 0.55, y - drop * 0.25, 0], [hw, y - drop, 0]], 0.42, m, { segments: 28, radial: 7 }));
      gr.add(at(box(1.8, H, D, m), 0, y));
      const k = at(sphere(0.62 * knob, m, 9), hw, y - drop);
      gr.add(k, mirrorX(k));
      break;
    }
    case 'disc': {
      // Рондель: диск поперёк черена.
      gr.add(at(cyl(3.0 * s, 3.0 * s, 0.75, m, 22), 0, -0.45));
      break;
    }
    case 'kidney': {
      // Баллок: две доли-«почки» — продолжение черена у его основания (по сторонам черена, а не
      // на клинке); клинок выходит из-под них через тонкую пластинку.
      for (const x of [1, -1]) {
        const lobe = sphere(1.55 * s * knob, m, 12);
        lobe.scale.set(1, 0.82, 0.95);
        gr.add(at(lobe, x * 1.45 * s, 0.45));
      }
      const plate = cyl(1.6 * s, 1.6 * s, 0.35, m, 14);
      plate.scale.z = 0.6;
      gr.add(at(plate, 0, -0.55));
      break;
    }
    case 'bar': {
      // Базелард: нижняя перекладина «Н».
      const hw = 3.8 * s;
      gr.add(extrudeXY([[-hw, -0.2], [-hw + 0.4, 0], [hw - 0.4, 0], [hw, -0.2], [hw, -1.35], [hw - 0.4, -1.55], [-hw + 0.4, -1.55], [-hw, -1.35]], 2.0, m));
      break;
    }
    case 'ring': {
      // Дага: длинные квиллоны к клинку + боковое кольцо-щиток.
      const hw = 5.2 * s, y = -H / 2, drop = 1.6 * s;
      gr.add(tube([[-hw, y - drop, 0], [-hw * 0.55, y - drop * 0.3, 0], [0, y, 0], [hw * 0.55, y - drop * 0.3, 0], [hw, y - drop, 0]], 0.38, m, { segments: 28, radial: 7 }));
      gr.add(at(box(1.8, H * 1.2, D, m), 0, y));
      const k = at(sphere(0.55 * knob, m, 9), hw, y - drop);
      gr.add(k, mirrorX(k));
      const R = 2.1 * s;
      gr.add(at(ring(R, 0.3, m, 18, 6), 0, y - 0.9, D / 2 + R - 0.3, 0, PI / 2));
      break;
    }
    case 'ganja': {
      // Ганджа кериса: асимметричная пластина — тупой «нос» с одной стороны, хвост с другой.
      const k = s;
      const o: V2[] = [[-4.4 * k, -0.55], [-3.1 * k, 0.05], [2.2 * k, 0.05], [3.05 * k, -0.35], [3.35 * k, -1.2], [2.7 * k, -1.95],
        [0.8 * k, -2.05], [-1.2 * k, -1.75], [-2.7 * k, -1.25], [-3.8 * k, -1.15], [-4.6 * k, -1.2], [-4.9 * k, -0.85]];
      gr.add(extrudeXY(o, 1.05, m));
      break;
    }
    default: {
      gr.add(extrudeXY(barOutline(4 * s, H, 0.3), D, m));
      break;
    }
  }
  return gr;
}

function daggerPommel(ctx: MeshCtx): THREE.Group {
  const g = new THREE.Group();
  const m = ctx.mat('head');
  const p = ctx.parts.head;
  const s = byAxis(p.axis, 0.88, 1.12);
  const ph = (0.35 + 0.15 * hash01(p.id)) * s;
  switch (ctx.tag('head', 'pommel')) {
    case 'cap': {
      g.add(latheY([[0.01, 0], [1.3 * s, 0], [1.45 * s, 0.4 * s], [1.3 * s, 1.0 * s], [0.8 * s, 1.45 * s], [0.01, 1.6 * s]], m, 14));
      g.add(peen(1.55 * s, 0.3 * s, ph, m));
      break;
    }
    case 'disc': {
      // Второй диск ронделя — поперёк черена.
      g.add(at(cyl(2.6 * s, 2.6 * s, 0.75 * s, m, 22), 0, 0.4 * s));
      g.add(peen(0.75 * s, 0.6 * s, ph * 1.4, m));
      break;
    }
    case 'ears': {
      // «Уши» (ear dagger): два диска-продолжения накладок по ОБЕ СТОРОНЫ хвостовика (±Z),
      // разведённые клином наружу; между ними — торец хвостовика, туда ложится большой палец.
      const R = 2.1 * s, a = 0.42, z0 = 0.3 * s, y0 = 0.45 * s;
      for (const k of [1, -1]) {
        const ear = cyl(R, R, 0.35 * s, m, 18);
        g.add(at(ear, 0, y0 + R * Math.cos(a), k * (z0 + R * Math.sin(a)), k * (PI / 2 + a)));
      }
      g.add(at(cyl(0.9 * s, 1.1 * s, 0.6 * s, m, 10), 0, 0.3 * s));
      g.add(at(box(1.3 * s, 1.6 * s, 0.5 * s, m), 0, 0.6 * s + 0.8 * s));
      break;
    }
    case 'crescent': {
      // Базелард: верхняя перекладина полумесяцем, рога вверх.
      const hw = 3.9 * s, o: V2[] = [];
      const N = 10;
      for (let i = 0; i <= N; i++) { const x = -hw + (2 * hw * i) / N; o.push([x, 0.2 * s + 1.3 * s * (x / hw) ** 2]); }
      for (let i = N; i >= 0; i--) { const x = -hw + (2 * hw * i) / N; const q = (x / hw) ** 2; o.push([x, 0.2 * s + 1.3 * s * q + (1.35 - 0.45 * q) * s]); }
      g.add(extrudeXY(o, 1.9 * s, m));
      break;
    }
    case 'washer': {
      // Раструб торца и широкая шайба с заклёпкой.
      g.add(latheY([[0.01, 0], [1.2 * s, 0], [1.4 * s, 0.6 * s], [2.05 * s, 1.1 * s], [2.6 * s, 1.15 * s], [2.6 * s, 1.45 * s], [0.7 * s, 1.5 * s], [0.7 * s, 1.5 * s + ph], [0.01, 1.6 * s + ph]], m, 18));
      break;
    }
    case 'sword': {
      // Мечевое: маленькое колесо.
      const R = 2.1 * s;
      const pr: V2[] = [[0.01, -0.95 * s], [0.8 * s, -0.95 * s], [0.9 * s, -0.6 * s], [1.9 * s, -0.32 * s], [R, -0.2 * s],
        [R, 0.2 * s], [1.9 * s, 0.32 * s], [0.9 * s, 0.6 * s], [0.8 * s, 0.95 * s], [0.01, 0.95 * s]];
      g.add(at(cyl(0.8 * s, 0.95 * s, 0.4 * s, m, 10), 0, 0.2 * s));
      g.add(at(latheY(pr, m, 20), 0, 0.4 * s + R, 0, PI / 2));
      g.add(peen(0.4 * s + 2 * R - 0.05, 0.4 * s, ph, m));
      break;
    }
    case 'hulu': {
      // Торец хулу: резная головка, склонённая вперёд «клювом».
      const head = sphere(1.45 * s, m, 12);
      head.scale.set(1.15, 0.9, 0.85);
      g.add(at(head, 0.35 * s, 1.0 * s));
      g.add(at(cone(0.6 * s, 1.7 * s, m, 8), 1.75 * s, 1.15 * s, 0, 0, 0, -PI / 2 + 0.45));
      g.add(at(cyl(1.25 * s, 1.3 * s, 0.45 * s, m, 12), 0, 0.2 * s));
      break;
    }
    default: {
      g.add(sphere(1.4 * s, m, 12));
      break;
    }
  }
  return g;
}

/** ⭐ КИНЖАЛ: клинок по семье (ромб, стилет, рондель, крис, сакс), черен, гарда и оголовок по формам. */
export function buildDagger(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const grip = daggerGrip(ctx);
  const yG = -grip.len / 2;
  grip.group.position.y = yG;
  g.grip.add(grip.group);

  const guard = daggerGuard(ctx);
  guard.position.y = yG;
  g.bind.add(guard);

  g.strike.add(bladeGroup(daggerBlade(ctx), yG - 0.6, ctx));

  const h = holder(grip.top.x, yG + grip.top.y, grip.top.rz);
  h.add(daggerPommel(ctx));
  g.head.add(h);
  return root;
}
