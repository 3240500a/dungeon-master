import * as THREE from 'three';
import {
  at, blade, box, byAxis, cone, cyl, extrudeXY, hash01, latheY, mirrorX, slotGroups, sphere, torus, tube,
  type MeshCtx, type V2,
} from './core.js';

/**
 * ДРЕВКОВОЕ ОРУЖИЕ ИЗ ДЕТАЛЕЙ: копьё и алебарда (docs/CRAFT_WEAPONS.md §18, визуал Ф1).
 *
 * Гнёзда: `strike` — перо копья / полотно алебарды, `grip` — древко, `bind` — втулка/обоймица
 * (как перо сидит на древке), `head` — подток на пятке древка (у обоих классов общий, `pl-bt-*`).
 * Контракт `core.ts`: сантиметры, основная рука в начале координат, рабочий конец в −Y, полотно
 * в плоскости XY, лезвие алебарды смотрит в +X.
 *
 * Как читается деталь:
 * - ТЕГ формы даёт силуэт (Кирпичников для перьев, Уолдман/Двуреченский для полотен);
 * - ОСЬ даёт пропорцию (длина/ширина/толщина), `nudge(id)` — ±2 % своей особенности варианта;
 * - СТУПЕНЬ материала геометрию не трогает — только цвет.
 * Локальная система наконечника: торец дерева в y = 0, древко уходит в +Y, перо — в −Y.
 */

// ── Общие помощники ──────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const HALF_PI = Math.PI / 2;

/** Своя мелкая особенность варианта: ±2 % к размеру по id — два варианта с одними тегами и осью не совпадут. */
const nudge = (id: string): number => 1 + (hash01(id) - 0.5) * 0.04;

/**
 * Тело вращения с профилем в ЛЮБОМ порядке: `LatheGeometry` смотрит гранями наружу, только когда y
 * растёт, — иначе при FrontSide деталь видна «изнутри». Разворачиваем профиль сами.
 */
function lathe(profile: V2[], mat: THREE.Material, seg = 14): THREE.Mesh {
  const first = profile[0], last = profile[profile.length - 1];
  return latheY(first && last && first[1] > last[1] ? [...profile].reverse() : profile, mat, seg);
}

const scalePts = (pts: V2[], kx: number, ky = kx, dy = 0): V2[] => pts.map(([x, y]): V2 => [x * kx, y * ky + dy]);

/** Симметричный контур из правой половины: от основания (x > 0) до острия на оси (x = 0). */
const sym = (right: V2[]): V2[] => [...right, ...right.slice(0, -1).reverse().map(([x, y]): V2 => [-x, y])];

/** Единичные профили гранёных тел [радиус, y] для y от 0 до −1 (масштаб по месту). */
const RIB: V2[] = [[1, 0], [0.85, -0.5], [0.001, -1]];
const SPIKE: V2[] = [[0.75, 0], [1, -0.12], [0.7, -0.55], [0.001, -1]];
const AWL: V2[] = [[0.75, 0], [1, -0.06], [0.82, -0.45], [0.45, -0.78], [0.001, -1]];
const TETRA: V2[] = [[0.45, 0], [0.42, -0.2], [1, -0.44], [0.82, -0.64], [0.001, -1]];
const FACET: V2[] = [[0.2, 0], [0.26, -0.08], [1, -0.3], [0.9, -0.52], [0.5, -0.76], [0.001, -1]];

/**
 * ГРАНЁНОЕ ТЕЛО (4 грани): ромб в сечении — углы на ±X (полуширина `hw`) и ±Z (полутолщина `ht`);
 * от y0 в −Y на `len`. `square` — повернуть на 45°: грани смотрят по осям (шило, жало).
 */
function faceted(y0: number, len: number, hw: number, ht: number, mat: THREE.Material, prof: V2[], square = false): THREE.Mesh {
  const m = lathe(prof, mat, 4);
  m.scale.set(hw, len, ht);
  m.position.y = y0;
  if (square) m.rotation.y = Math.PI / 4;
  return m;
}

/** Плавный подъём полуширины от `b` до `w` на отрезке t∈[0, p] (плечи пера). */
const rise = (t: number, p: number, b: number, w: number, pow = 1): number => b + (w - b) * Math.pow(Math.sin(clamp(t / p, 0, 1) * HALF_PI), pow);
/** Доля пути от точки наибольшей ширины p к острию. */
const past = (t: number, p: number): number => clamp((t - p) / (1 - p), 0, 1);

// ── Подток: общий у копья и алебарды (`pl-bt-*`) ───────────────────────────────────────────────

/**
 * ПОДТОК на пятке древка: торец дерева в `yT` (+Y), радиус `rT`; наконечник уходит в +Y.
 * Тяжёлый — шар-противовес; кольцевой — втулка с проушиной; простой — короткая оковка;
 * гранёный — восьмигранная пирамида; острый — длинное жало (sauroter).
 */
function buttCap(ctx: MeshCtx, grp: THREE.Group, yT: number, rT: number, ex: number): void {
  const p = ctx.parts.head;
  const mat = ctx.mat('head');
  const k = byAxis(p.axis, 0.9, 1.12) * ex * nudge(p.id);
  const id = p.id;
  const kind = id.includes('heavy') ? 'heavy' : id.includes('ring') ? 'ring' : id.includes('facet') ? 'faceted'
    : id.includes('spike') ? 'spike' : id.includes('plain') ? 'plain'
      : p.axis > 0.75 ? 'heavy' : p.axis > 0.25 ? 'ring' : p.axis > -0.25 ? 'plain' : p.axis > -0.75 ? 'faceted' : 'spike';
  const L = (pts: V2[], seg = 14, rotY = 0): void => {
    const m = lathe(pts.map(([r, y]): V2 => [r, yT + y]), mat, seg);
    m.rotation.y = rotY;
    grp.add(m);
  };
  switch (kind) {
    case 'heavy':
      L([[rT * 0.98, -9 * k], [rT * 1.22, -9 * k], [rT * 1.16, -7.4 * k], [rT * 1.12, -1.5 * k], [rT * 1.6, 1.2 * k],
        [rT * 2.05, 4 * k], [rT * 1.85, 6.8 * k], [rT * 1.1, 8.8 * k], [0.001, 9.4 * k]], 16);
      grp.add(at(cyl(rT * 1.3, rT * 1.3, 1.1 * k, mat, 14), 0, yT - 6.6 * k));
      break;
    case 'ring':
      L([[rT * 0.98, -6.5 * k], [rT * 1.16, -6.5 * k], [rT * 1.12, 0], [rT * 0.75, 1.4 * k], [0.001, 1.8 * k]], 12);
      grp.add(at(torus(rT * 1.2, 0.38 * k, mat, Math.PI * 2, 16), 0, yT - 5.6 * k, 0, HALF_PI));
      grp.add(at(cyl(0.55 * k, 0.55 * k, 1.8 * k, mat, 8), 0, yT + 2.3 * k));
      grp.add(at(torus(2.1 * k, 0.48 * k, mat, Math.PI * 2, 18), 0, yT + 3.1 * k + 2.1 * k));
      break;
    case 'faceted':
      L([[rT * 0.98, -8 * k], [rT * 1.16, -8 * k], [rT * 1.2, -1.2 * k], [rT * 1.02, 1.6 * k], [0.001, 8.5 * k]], 8, Math.PI / 8);
      grp.add(at(cyl(rT * 1.32, rT * 1.32, 1.2 * k, mat, 8), 0, yT - 7.2 * k, 0, 0, Math.PI / 8));
      break;
    case 'spike':
      L([[rT * 0.98, -6 * k], [rT * 1.12, -6 * k], [rT * 1.12, 0.2 * k], [rT * 0.9, 0.8 * k], [0.001, 0.9 * k]], 12);
      L([[rT * 1.0, 0.4 * k], [rT * 0.78, 4 * k], [0.001, 19 * k]], 4, Math.PI / 4);
      break;
    default: // plain
      L([[rT * 0.98, -6 * k], [rT * 1.1, -6 * k], [rT * 1.1, 0.3 * k], [rT * 0.85, 1.7 * k], [0.001, 2.2 * k]], 12);
      break;
  }
}

// ── КОПЬЁ ────────────────────────────────────────────────────────────────────────────────────────

/**
 * ВТУЛКА КОПЬЯ (`bind.mount`), локально: торец древка в y = 0, радиус `rs`. Возвращает y, где
 * начинается шейка пера (оно уходит дальше в −Y).
 * socket — конусная втулка (гранёная — восьмигранник с валиками); tang — черешок без втулки:
 * торец древка обмотан шнуром между двумя обоймицами; langets — короткая втулка и длинные ланцеты
 * по древку на заклёпках; crossbar — втулка с поперечиной-упором (рогатина), примотанной шнуром.
 */
function spearMount(ctx: MeshCtx, grp: THREE.Group, rs: number, ex: number): number {
  const p = ctx.parts.bind;
  const mat = ctx.mat('bind');
  const cord = ctx.matOf('cloth', 1);
  const mount = ctx.tag('bind', 'mount') || 'socket';
  const k = byAxis(p.axis, 0.9, 1.12) * ex * nudge(p.id);
  const tip = -4 * ex;
  // Стенка втулки уже у торца древка (y = 0) шире дерева — иначе дерево проступает кольцом сквозь железо.
  // Гранёная (8 граней) — радиус на 1/cos(π/8): плоскость грани лежит ближе к оси, чем её ребро.
  const socket = (sl: number, seg: number): void => {
    const q = rs / Math.cos(Math.PI / seg);
    const m = lathe([[q * 0.55, tip], [q * 0.84, tip + 2 * ex], [q * 1.07, -0.3], [q * 1.1, sl - 1.8],
      [q * 1.22, sl - 1], [q * 1.22, sl], [q * 0.98, sl]], mat, seg);
    if (seg === 8) m.rotation.y = Math.PI / 8;
    grp.add(m);
  };
  switch (mount) {
    case 'tang': {
      const bl = 11 * k, turns = 7, n = 56, R = rs + 0.24;
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, a = t * turns * Math.PI * 2;
        pts.push([Math.sin(a) * R, 1.3 + t * bl, Math.cos(a) * R]);
      }
      grp.add(tube(pts, 0.26, cord, { segments: 84, radial: 5 }));
      grp.add(at(cyl(rs * 1.14, rs * 1.14, 1.2, mat, 12), 0, 0.5));
      grp.add(at(cyl(rs * 1.14, rs * 1.14, 1.0, mat, 12), 0, 1.8 + bl));
      grp.add(lathe([[rs * 0.5, -2.2], [rs * 0.95, -0.9], [rs * 1.14, -0.1], [rs * 0.9, 0]], mat, 12));
      return -2.2;
    }
    case 'langets': {
      const sl = 8 * k, lg = 40 * k;
      socket(sl, 12);
      for (const z of [1, -1]) {
        grp.add(at(box(1.3 * ex, lg, 0.32, mat), 0, sl - 1 + lg / 2, z * (rs + 0.16)));
        for (const f of [0.25, 0.6, 0.93]) grp.add(at(sphere(0.34 * ex, mat, 6), 0, sl - 1 + lg * f, z * (rs + 0.34)));
      }
      return tip;
    }
    case 'crossbar': {
      const sl = 12 * k, half = rs + 7.5 * k, yb = sl * 0.5;
      socket(sl, 12);
      grp.add(at(cyl(0.7 * ex, 0.7 * ex, 2 * half, mat, 8), 0, yb, 0, 0, 0, HALF_PI));
      for (const s of [1, -1]) grp.add(at(sphere(1.05 * ex, mat, 8), s * half, yb));
      grp.add(at(cyl(rs * 1.34, rs * 1.34, 2.4 * ex, cord, 10), 0, yb));
      return tip;
    }
    default: { // socket
      const sl = 12.5 * k;
      const ribbed = p.id.includes('rib');
      socket(sl, ribbed ? 8 : 12);
      if (ribbed) for (const f of [0.18, 0.45, 0.72]) grp.add(at(cyl(rs * 1.52, rs * 1.52, 1.2 * ex, mat, 8), 0, sl * f, 0, 0, Math.PI / 8));
      else grp.add(at(sphere(0.35 * ex, mat, 6), 0, sl * 0.6, rs * 1.08));
      return tip;
    }
  }
}

/** Двушипное перо (VII): узкий лист и два шипа-жабры, загнутые назад к древку. Правая половина, y от основания. */
const TWO_SPIKE: V2[] = [[0.6, 0], [0.8, -4], [4.8, -2.2], [2.1, -12], [2.4, -16], [2.1, -24], [1.15, -31], [0, -37]];
/** Крыло-упор Flügellanze под пером: правая половина, y от кончика втулки назад по древку (+Y). */
const WING: V2[] = [[0.4, 0.4], [2.6, -0.4], [7.6, 1.6], [7.2, 3.4], [0.4, 5.6]];

/**
 * ПЕРО КОПЬЯ (`strike.form`, Кирпичников 1966): от `yN` (кончик втулки) в −Y.
 * Плоские перья — профилем `blade()` с ромбическим ребром; гранёные — телом с 4 гранями.
 */
function spearHead(ctx: MeshCtx, grp: THREE.Group, yN: number, rs: number, ex: number): void {
  const p = ctx.parts.strike;
  const mat = ctx.mat('strike');
  const k = byAxis(p.axis, 0.92, 1.1) * ex * nudge(p.id);
  const form = ctx.tag('strike', 'form');
  const add = (o: THREE.Object3D): void => { grp.add(o); };
  /** Шейка пера от втулки; возвращает y основания пера. */
  const neck = (len: number, r1: number): number => {
    add(lathe([[r1, yN - len], [r1 * 1.3, yN - len * 0.55], [rs * 0.55, yN]], mat, 10));
    return yN - len;
  };
  /** Плоское перо по профилю полуширины + ромбическое ребро по оси. */
  const leaf = (y0: number, len: number, thick: number, hw: (t: number) => number, rib: number): void => {
    add(blade({ length: len, y0, thick, stations: 18, halfW: (t) => { const h = hw(t); return { r: h, l: h }; } }, mat));
    add(faceted(y0, len * 0.94, rib, thick / 2 + 0.35, mat, RIB));
  };

  switch (form) {
    case 'rhombic': { // II: ромб — прямые кромки, наибольшая ширина ближе к основанию
      const y = neck(3.5 * ex, 0.6 * k), w = 3.3 * k, b = 0.6 * k;
      leaf(y, 28 * k, 0.95, (t) => (t < 0.42 ? b + ((w - b) * t) / 0.42 : (w * (1 - t)) / 0.58), 0.55 * k);
      break;
    }
    case 'ovate': { // IV: яйцевидное — короткое, широкое, скруглённое
      const y = neck(3 * ex, 0.65 * k), w = 4.1 * k, b = 0.65 * k;
      leaf(y, 25 * k, 1.0, (t) => (t < 0.34 ? rise(t, 0.34, b, w, 0.6) : w * Math.pow(1 - Math.pow(past(t, 0.34), 1.7), 0.9)), 0.6 * k);
      break;
    }
    case 'triangular': { // III: удлинённый треугольник — широкие плечи у основания, прямые кромки
      const y = neck(3 * ex, 0.6 * k), w = 4.0 * k, b = 0.6 * k;
      leaf(y, 35 * k, 0.9, (t) => (t < 0.05 ? b + ((w - b) * t) / 0.05 : w * (1 - past(t, 0.05))), 0.5 * k);
      break;
    }
    case 'laurel': { // IVА: лавровый лист — длинный, наибольшая ширина посередине
      const y = neck(3.5 * ex, 0.45 * k), w = 3.9 * k, b = 0.45 * k;
      leaf(y, 40 * k, 0.9, (t) => (t < 0.5 ? b + (w - b) * Math.sin((t / 0.5) * HALF_PI) ** 1.4 : w * Math.cos(past(t, 0.5) * HALF_PI) ** 0.9), 0.5 * k);
      break;
    }
    case 'rogatina': { // IVА рогатинное: массивное широкое перо с толстым ребром
      const y = neck(4 * ex, 0.9 * k), w = 5.3 * k, b = 0.9 * k;
      leaf(y, 44 * k, 1.5, (t) => (t < 0.36 ? rise(t, 0.36, b, w, 0.55) : w * (1 - Math.pow(past(t, 0.36), 1.35))), 1.0 * k);
      break;
    }
    case 'awl': // шиловидное: длинное узкое четырёхгранное жало
      add(faceted(yN, 42 * k, 1.2 * k, 1.2 * k, mat, AWL, true));
      break;
    case 'tetra': // V: короткое четырёхгранное с утолщённой «головкой»
      add(faceted(yN, 25 * k, 1.95 * k, 1.95 * k, mat, TETRA, true));
      break;
    case 'facet-broad': // широкое гранёное: плоский ромб в сечении с ясными гранями
      add(faceted(yN, 32 * k, 3.6 * k, 1.25 * k, mat, FACET));
      break;
    case 'two-spike': { // VII: узкое перо и два шипа назад
      const y = neck(3 * ex, 0.6 * k);
      add(extrudeXY(sym(scalePts(TWO_SPIKE, k, k, y)), 0.9, mat, { bevel: 0.3 }));
      add(faceted(y - 4 * k, 32 * k, 0.5 * k, 0.8, mat, RIB));
      break;
    }
    case 'winged': { // крылатое: лист и два упора-крыла на втулке
      const y = neck(4 * ex, 0.55 * k), w = 2.8 * k, b = 0.55 * k;
      leaf(y, 30 * k, 0.9, (t) => (t < 0.32 ? rise(t, 0.32, b, w) : w * Math.pow(Math.cos(past(t, 0.32) * HALF_PI), 1.1)), 0.5 * k);
      const wing = extrudeXY(WING.map(([x, wy]): V2 => [x * k, yN + wy * ex]), 0.7, mat, { bevel: 0.2 });
      add(wing);
      add(mirrorX(wing));
      break;
    }
    case 'trident': { // три зубца с бородками на общей перекладине
      const w = 6.6 * k, pl = 27 * k, yb = yN - 1.5 * k;
      add(tube([[-w, yb - 6 * k, 0], [-w * 0.78, yb - 1.8 * k, 0], [0, yb, 0], [w * 0.78, yb - 1.8 * k, 0], [w, yb - 6 * k, 0]], 0.8 * k, mat, { segments: 36, radial: 7 }));
      const barb = (x: number, y: number, len: number): void => { add(at(lathe([[0.8 * k, 0], [1.55 * k, -0.6 * k], [0.001, -len]], mat, 4), x, y)); };
      add(lathe([[rs * 0.55, yN], [0.95 * k, yb - 1], [0.8 * k, yb - pl * 0.78]], mat, 8));
      barb(0, yb - pl * 0.78, 6 * k);
      for (const s of [1, -1]) {
        add(tube([[s * w, yb - 5.6 * k, 0], [s * w * 1.03, yb - 14 * k, 0], [s * w * 0.96, yb - pl * 0.7, 0]], 0.68 * k, mat, { segments: 20, radial: 7 }));
        barb(s * w * 0.96, yb - pl * 0.7, 5 * k);
      }
      break;
    }
    default: { // lanceolate, I: длинный узкий лист, наибольшая ширина в нижней трети
      const y = neck(3.5 * ex, 0.5 * k), w = 1.95 * k, b = 0.5 * k;
      leaf(y, 38 * k, 0.85, (t) => (t < 0.24 ? rise(t, 0.24, b, w) : w * Math.pow(Math.cos(past(t, 0.24) * HALF_PI), 1.5)), 0.42 * k);
      break;
    }
  }
}

/**
 * КОПЬЁ. Длина — по базе: сулица/короткое 150–180 см, копьё ≈ 265, длинное копьё ≈ 250, пика ≈ 400
 * (перо пики чуть преувеличено, чтобы читалось в превью). Начало координат — рука: `one` у точки
 * баланса, `heel` у пятки (почти всё древко в −Y), `middle` посередине.
 */
export function buildSpear(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const gp = ctx.parts.grip;
  const base = ctx.baseId;
  const pike = base === 'pike';
  const hold = ctx.tag('grip', 'hold') || (ctx.hands >= 2 ? 'heel' : 'one');
  const baseShaft = pike ? 350 : base === 'lance' ? 208 : base === 'spear' ? 222 : base === 'trident' ? 128 : ctx.hands >= 2 ? 222 : 120;
  const S = baseShaft * byAxis(gp.axis, 0.9, 1.1) * nudge(gp.id);
  // Преувеличение наконечника — от БАЗЫ, не от длины древка: иначе смена древка перемасштабирует перо.
  const ex = pike ? 1.35 : ctx.hands >= 2 ? 1.1 : 1;
  const r = (pike ? 1.55 : base === 'lance' ? 1.85 : ctx.hands >= 2 ? 1.65 : 1.35) * byAxis(gp.axis, 0.95, 1.06);
  const a = hold === 'one' ? S * 0.55 : hold === 'middle' ? S * 0.42 : S * clamp(0.19 - 0.06 * gp.axis, 0.1, 0.25);
  const yB = a, yE = a - S;
  const rT = r * 1.04, rE = r * 0.9;

  // Древко и обмотки там, где лежат руки: сулица — одна у баланса, пятка — задняя и передняя, середина — длинная.
  const wood = ctx.mat('grip');
  const hide = ctx.matOf('hide', 3), cord = ctx.matOf('cloth', 1);
  g.grip.add(at(cyl(rT, rE, S, wood, 12), 0, (yB + yE) / 2));
  const wrap = (yc: number, len: number, bands: number): void => {
    g.grip.add(at(cyl(r * 1.22, r * 1.22, len, hide, 12), 0, yc));
    for (let i = 0; i <= bands; i++) g.grip.add(at(cyl(r * 1.32, r * 1.32, 0.9, cord, 10), 0, yc - len / 2 + (len * i) / bands));
  };
  if (hold === 'middle') wrap(0, 34, 6);
  else if (hold === 'heel') { wrap(-1, 20, 4); wrap(-Math.min(S * 0.3, 80), 13, 3); }
  else wrap(0, 15, 4);

  buttCap(ctx, g.head, yB, rT, ex);

  const bG = at(new THREE.Group(), 0, yE); g.bind.add(bG);
  const sG = at(new THREE.Group(), 0, yE); g.strike.add(sG);
  const yN = spearMount(ctx, bG, rE, ex);
  spearHead(ctx, sG, yN, rE, ex);
  return root;
}

// ── АЛЕБАРДА ─────────────────────────────────────────────────────────────────────────────────────

/** Где полотно держится за древко (локально, торец дерева в 0): от `top` (≤ 0) до `bot`; `tail` — косица бердыша. */
interface HeadSpec { top: number; bot: number; tail?: number }

/** Клюв/крюк на обухе (−X): корень высотой h у x = −x0, остриё на len дальше и на `drop` ниже (к +Y). */
const beakPts = (x0: number, len: number, y: number, h: number, drop: number): V2[] => [
  [-x0, y - h / 2], [-x0 - len * 0.45, y - h * 0.32 + drop * 0.25], [-x0 - len, y + drop],
  [-x0 - len * 0.6, y + h * 0.22 + drop * 0.5], [-x0, y + h / 2],
];

/** Кольцо-окошко (декоративная прорезь поздней алебарды). */
const ringPts = (cx: number, cy: number, r: number, n = 8): V2[] =>
  Array.from({ length: n }, (_, i): V2 => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)]);

/**
 * ПОЛОТНО АЛЕБАРДЫ (`strike.form`), локально: торец древка в 0, рабочий конец в −Y, лезвие в +X.
 * Возвращает, где полотно держится за древко, — по этому месту обоймица строит кольца/втулку.
 */
function halberdHead(ctx: MeshCtx, grp: THREE.Group, r: number): HeadSpec {
  const p = ctx.parts.strike;
  const mat = ctx.mat('strike');
  const k = byAxis(p.axis, 0.94, 1.08) * nudge(p.id);
  const form = ctx.tag('strike', 'form');
  const flat = (pts: V2[], depth = 0.75, holes?: V2[][]): void => {
    grp.add(extrudeXY(scalePts(pts, k), depth, mat, { bevel: 0.22, holes: holes?.map((h) => scalePts(h, k)) ?? [] }));
  };
  const spike = (y0: number, len: number, hw: number, ht: number, square = false): void => {
    grp.add(faceted(y0 * k, len * k, hw * k, ht * k, mat, SPIKE, square));
  };
  const beak = (len: number, y: number, h: number, drop: number): void => { flat(beakPts((r * 0.7) / k, len, y, h, drop), 1.4); };
  const spec = (top: number, bot: number, tail?: number): HeadSpec => (tail === undefined ? { top: top * k, bot: bot * k } : { top: top * k, bot: bot * k, tail: tail * k });

  switch (form) {
    case 'vouge': // вуж: секач-нож — выпуклое брюшко, шире всего в верхней трети, остриё на линии спинки; без углов и без шипа
      flat([[1.6, 18], [4.6, 20], [9.2, 16.5], [12.4, 8.5], [13.8, -2], [14.3, -14], [13.9, -25], [12.5, -34.5], [9.8, -42.5],
        [5.8, -49.5], [1.6, -55.5], [-1.5, -59], [-1.6, -50], [-1.6, -30], [-1.6, -4], [1.4, -0.5]]);
      return spec(-3, 18);
    case 'glaive': // глефа: нож на древке — выпуклое лезвие, остриё загнуто к спинке, шип-упор на обухе
      flat([[2.3, -1], [4.8, -8], [7.1, -20], [7.9, -34], [7.1, -46], [4.6, -56], [1.0, -63], [-2.8, -67], [-2.4, -57], [-2.1, -40],
        [-2.1, -20], [-8.2, -18.5], [-4.5, -13.5], [-2.3, -10], [-2.3, -1]]);
      return spec(-1.5, 13);
    case 'bill': // билл: широкое полотно садового секача — выпуклое брюшко, горловина и крюк вперёд остриём к руке; жало и шип на обухе
      flat([[2.3, -1], [4.2, -5], [7.6, -10], [9.6, -16], [9.4, -22], [10, -26.5], [12, -31], [14.5, -32.8], [16.2, -31],
        [16.8, -27.2], [18.2, -31], [17.8, -35.5], [15.2, -39.2], [10.6, -41.6], [5.4, -42.8], [1.3, -43.6], [0, -64],
        [-1.3, -43.6], [-2.4, -41], [-2.4, -32], [-13, -28.4], [-2.4, -26.6], [-2.3, -10], [-2.3, -1]]);
      return spec(-1.5, 13);
    case 'late': // поздняя: малое полотно с вогнутым лезвием и прорезью, длинное жало, малый клюв
      flat([[1.4, 7], [5, 5.5], [9.8, 8.5], [8.4, 1.5], [7.9, -4.5], [8.8, -10.5], [11, -14.5], [5.2, -10.5], [1.4, -8]], 0.75, [ringPts(5.2, -1.5, 1.3)]);
      spike(-5, 58, 1.35, 0.8);
      beak(8.5, -2, 4, 3.5);
      return spec(-6, 9);
    case 'early': // ранняя (Земпах): широкий прямоугольный секач с углами, верх срезан прямо в остриё над древком, крюк на обухе
      flat([[1.5, 21], [6, 22.5], [17.6, 18.6], [18.9, 15.6], [19.1, 4], [18.5, -7], [19.3, -17.6], [17.8, -20.2], [10, -30.8],
        [3, -39.2], [0.2, -42.6], [-1.5, -37], [-1.5, -16], [-3, -15.2], [-8.2, -10.8], [-3.2, -9.6], [-1.6, -8], [-1.6, -2], [1.5, -1]]);
      return spec(-3, 21);
    case 'spetum': // спетум: длинное жало и два изогнутых вверх отростка
      flat(sym([[2.3, -1], [3.5, -4], [8.6, -6.6], [12.6, -11], [14.4, -18.5], [13.8, -31], [11.7, -20.5], [9.3, -13.8], [5.1, -11.2],
        [2.5, -12.8], [2.2, -26], [1.5, -46], [0, -66]]), 0.9);
      spike(-12, 52, 0.9, 0.75);
      return spec(-1.5, 13);
    case 'partisan': // протазан: широкое треугольное перо и два малых уса у основания
      flat(sym([[2.3, -1], [3.3, -3.4], [8.2, -2.8], [11.6, -6.2], [12.4, -10.5], [10.1, -8.4], [7.2, -7.4], [5.3, -8.4], [7.4, -11.2],
        [6.3, -21], [4.6, -33], [2.4, -45], [0, -56]]), 0.9);
      spike(-8, 46, 1.0, 0.8);
      return spec(-1.5, 13);
    case 'broad-partisan': // широкий протазан: плечистое перо, усы закручены назад
      flat(sym([[2.4, -1], [4.2, -2.8], [9.4, -1.2], [13.8, 1.8], [12.6, -2.4], [9.2, -4.6], [6.6, -6.2], [10.6, -9.6], [11.4, -14],
        [10.2, -24], [7, -36], [3.2, -47], [0, -55]]), 1.0);
      spike(-8, 45, 1.4, 0.85);
      return spec(-1.5, 13);
    case 'bard1': // бердыш 1: топоровидный — широкое короткое полотно, косица к древку
      flat([[1.4, -22], [1.4, 8], [1.9, 26], [2.5, 31], [3.8, 30], [5.6, 21], [10.5, 15.5], [15.4, 7.5], [16.8, -3.5], [15.4, -14.5],
        [11.4, -23], [6.2, -27.5], [2.4, -30]]);
      return spec(0, 12, 28);
    case 'bard2': // бердыш 2: месяцевидный — длинное узкое полотно, остриё высоко над древком
      flat([[1.8, -54], [1.6, -30], [2.6, -12], [2.8, 8], [2.3, 26], [1.9, 43], [3.4, 43.5], [7.6, 33], [11.2, 18], [13, 1], [12.6, -17],
        [10.2, -33], [6.2, -45]]);
      return spec(0, 12, 40);
    case 'bard3': // бердыш 3: двурогий — широкий полумесяц, верхний рог над древком, нижний рог свободно отведён от древка;
      // к древку ниже его держит отдельная косица-полоса
      flat([[-2.2, -51], [6.4, -45], [13.4, -32], [17.4, -17], [19, 0], [18.8, 14], [17.6, 27], [15.8, 38], [13.6, 48],
        [11.4, 40.5], [8.8, 32], [5.8, 23.5], [3.2, 16], [1.8, 9], [1.7, 0], [2.0, -20], [2.2, -34], [0.8, -44]]);
      flat([[1.2, 10], [2.6, 10], [2.3, 46], [1.2, 46]], 0.6);
      return spec(0, 12, 44);
    case 'poleaxe-beak': case 'poleaxe': case 'poleaxe-heavy': {
      // полэкс: кованая головка, топор, верхнее жало; на обухе — клюв или молот. Головка на ~15 % крупнее
      // натуры — на древке в 2 м она иначе теряется в превью. Тяжёлый — не просто крупнее: у него
      // бородовидный топор (нижний рог свисает к руке), молот 3×3 и толстое жало.
      const heavy = form === 'poleaxe-heavy';
      const h = (heavy ? 1.22 : 1) * 1.15;
      const yc = -0.8 * h * k;
      grp.add(at(box(4.6 * h * k, 7.4 * h * k, 4.6 * h * k, mat), 0, yc));
      flat(scalePts(heavy
        ? [[1.8, -5.8], [6.4, -4.8], [12.4, -10.6], [14.6, -3.4], [15.2, 4.4], [14.2, 11.8], [11.8, 18.4], [8.8, 13.6], [6.4, 7.8], [1.8, 6.6]]
        : [[1.8, -4.5], [6.2, -3.6], [10.4, -8.4], [11.9, -1.6], [12.1, 4.4], [10.6, 10.8], [6.2, 6.8], [1.8, 5.6]], h), heavy ? 1.1 : 0.8);
      if (form === 'poleaxe-beak') {
        // клюв (bec de corbin): длинный, гранёный у корня, загнут к руке
        flat(scalePts([[-1.4, -2.2], [-7.5, -2.4], [-13.5, -0.6], [-19.5, 4.6], [-14.2, 1.8], [-7.5, 1.6], [-1.4, 2.2]], h), 1.5);
      } else {
        const x0 = r * 0.8, nl = 3.2 * h * k, fs = (heavy ? 5.6 : 4.2) * h * k, fw = 2.2 * h * k;
        grp.add(at(box(nl, 2.8 * h * k, 2.8 * h * k, mat), -(x0 + nl / 2), yc));
        const fx = -(x0 + nl + fw / 2);
        grp.add(at(box(fw, fs, fs, mat), fx, yc));
        const n = heavy ? 3 : 2;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          grp.add(at(cone(0.55 * h * k, 1.3 * h * k, mat, 4), fx - fw / 2 - 0.6 * h * k, yc + ((i - (n - 1) / 2) * fs) / n, ((j - (n - 1) / 2) * fs) / n, 0, 0, HALF_PI));
        }
      }
      spike(-4.4 * h, (heavy ? 22 : 21) * h, (heavy ? 1.6 : 1.3) * h, (heavy ? 1.6 : 1.3) * h, true);
      return spec(-5 * h, 6 * h);
    }
    default: // swiss: топор с прямым лезвием, верхняя кромка уходит в жало, клюв загнут вниз
      flat([[1.4, 12], [6.5, 12.5], [14.8, 16.8], [15.4, 8], [15.5, -2], [16.2, -11.5], [11.2, -11.8], [6.8, -14.2], [3.4, -19.5], [1.4, -24]]);
      spike(-3, 36, 1.6, 1.0);
      beak(13, 1, 5, 6.5);
      return spec(-4, 15);
  }
}

/**
 * ОБОЙМИЦА АЛЕБАРДЫ (`bind.mount`) по месту крепления полотна: rings — два кольца (и третье на
 * косице); socket — втулка (кованая — восьмигранная с яблоком); langets — ланцеты по древку на
 * заклёпках; rondel — диск-рондель под головкой и короткие ланцеты.
 */
function halberdMount(ctx: MeshCtx, grp: THREE.Group, r: number, hs: HeadSpec): void {
  const p = ctx.parts.bind;
  const mat = ctx.mat('bind');
  const mount = ctx.tag('bind', 'mount') || 'socket';
  const k = byAxis(p.axis, 0.9, 1.12) * nudge(p.id);
  const top = Math.min(hs.top, -1.2), bot = hs.bot;
  const sleeve = (ml: number, seg: number, knop = false): number => {
    const yM = bot + ml;
    const prof: V2[] = [[0.001, top - 1], [r * 0.72, top], [r * 1.02, top * 0.4], [r * 1.1, 1]];
    if (knop) { const ym = (1 + bot) / 2; prof.push([r * 1.1, ym - 2.2], [r * 1.62, ym - 0.6], [r * 1.62, ym + 0.6], [r * 1.1, ym + 2.2]); }
    prof.push([r * 1.12, yM - 2], [r * 1.26, yM - 1.2], [r * 1.26, yM], [r * 0.98, yM]);
    const m = lathe(prof, mat, seg);
    if (seg === 8) m.rotation.y = Math.PI / 8;
    grp.add(m);
    return yM;
  };
  const ring = (y: number): void => { grp.add(at(torus(r + 0.62 * k, 0.62 * k, mat, Math.PI * 2, 18), 0.35, y, 0, HALF_PI)); };
  const strips = (y0: number, len: number, rivets: number[]): void => {
    for (const z of [1, -1]) {
      grp.add(at(box(1.5, len, 0.35, mat), 0, y0 + len / 2, z * (r + 0.17)));
      for (const f of rivets) grp.add(at(sphere(0.36, mat, 6), 0, y0 + len * f, z * (r + 0.36)));
    }
  };
  switch (mount) {
    case 'rings': {
      grp.add(lathe([[0.001, top - 0.8], [r * 0.75, top], [r * 1.06, 0.4], [r * 1.06, 2], [r * 0.98, 2]], mat, 12));
      const y1 = 2.6, y2 = Math.max(bot - 1.6 * k, y1 + 4);
      ring(y1); ring(y2);
      if (hs.tail !== undefined) ring(hs.tail);
      return;
    }
    case 'langets': {
      const yM = sleeve(4 * k, 12);
      strips(yM - 1, 42 * k, [0.2, 0.45, 0.7, 0.94]);
      break;
    }
    case 'rondel': {
      const yM = sleeve(4 * k, 12);
      grp.add(at(cyl(6.2 * k, 6.2 * k, 0.8, mat, 20), 0, yM + 2.5));
      grp.add(at(cyl(r * 1.45, r * 1.45, 2.6, mat, 12), 0, yM + 2.5));
      strips(yM + 3.6, 22 * k, [0.35, 0.9]);
      break;
    }
    default: // socket
      if (p.id.includes('forg')) sleeve(10 * k, 8, true);
      else sleeve(7 * k, 12);
      break;
  }
  if (hs.tail !== undefined) grp.add(at(cyl(r * 1.14, r * 1.14, 2.6 * k, mat, 12), 0, hs.tail));
}

/**
 * АЛЕБАРДА (всегда двуручная): восьмигранное древко 175–215 см, рука в ≈ 60 см от пятки; на
 * конце — полотно по форме, обоймица по месту его крепления, на пятке — подток.
 */
export function buildHalberd(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const gp = ctx.parts.grip;
  const S = byAxis(gp.axis, 176, 214) * nudge(gp.id);
  const a = 58 + 3 * gp.axis;
  const r = 1.9 * byAxis(gp.axis, 0.96, 1.05);
  const yB = a, yE = a - S;
  g.grip.add(at(cyl(r, r, S, ctx.mat('grip'), 8), 0, (yB + yE) / 2, 0, 0, Math.PI / 8));

  buttCap(ctx, g.head, yB, r, 1);

  const sG = at(new THREE.Group(), 0, yE); g.strike.add(sG);
  const bG = at(new THREE.Group(), 0, yE); g.bind.add(bG);
  const hs = halberdHead(ctx, sG, r);
  halberdMount(ctx, bG, r, hs);
  return root;
}
