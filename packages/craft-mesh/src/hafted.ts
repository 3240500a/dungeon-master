import * as THREE from 'three';
import {
  at, box, byAxis, cyl, extrudeXY, hash01, latheY, mesh, slotGroups, sphere, torus, tube,
  type MeshCtx, type V2,
} from './core.js';

/**
 * ТОПОР И БУЛАВА ИЗ ДЕТАЛЕЙ (docs/CRAFT_WEAPONS.md §18). Контракт — в `core.ts`: сантиметры, хват
 * основной руки в начале координат, рабочий конец в −Y, плоскость полотна XY, лезвие топора в +X.
 *
 * Топор: `grip` — топорище, `bind` — проушина со щекавицами, `strike` — полотно (кромка в +X),
 * `head` — обух (со стороны −X от проушины).
 * Булава: `grip` — рукоять/древко, `bind` — обоймица под билом, `strike` — било (−Y),
 * `head` — конец рукояти/подток (+Y, за кистью).
 *
 * Форма — по ТЕГУ детали (силуэт узнаваем: Кирпичников, Петерсен, Окшотт не при чём — тут топоры),
 * пропорция — по ОСИ, ступень материала геометрию не трогает (только цвет).
 */

type V3 = [number, number, number];
const UP = new THREE.Vector3(0, 1, 0);
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

// ── Помощники геометрии ──────────────────────────────────────────────────────────────────────────

/** Тело вращения с профилем снизу вверх (так нормали смотрят наружу) — порядок точек любой. */
function lathe(profile: V2[], mat: THREE.Material, seg = 16): THREE.Mesh {
  const first = profile[0]!, last = profile[profile.length - 1]!;
  return latheY(first[1] > last[1] ? [...profile].reverse() : profile, mat, seg);
}

/** Квадратичная кривая Безье: точки от p0 (не включая) до p1 (включая). */
function bz(p0: V2, c: V2, p1: V2, n = 8): V2[] {
  const out: V2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
    out.push([a * p0[0] + b * c[0] + d * p1[0], a * p0[1] + b * c[1] + d * p1[1]]);
  }
  return out;
}

/** Дуга окружности от угла a0 до a1 (включая оба конца). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** Убрать соседние совпадающие точки и замыкающий повтор — триангуляция их не любит. */
function clean(pts: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) out.push(p);
  }
  const a = out[0], b = out[out.length - 1];
  if (a && b && out.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) out.pop();
  return out;
}

/** Сужение по толщине (Z) вдоль X: у x0 множитель k0, у x1 — k1. Клин полотна, клюв к острию. */
function taperZ(m: THREE.Mesh, x0: number, x1: number, k0: number, k1: number): THREE.Mesh {
  const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01((pos.getX(i) - x0) / (x1 - x0));
    pos.setZ(i, pos.getZ(i) * (k0 + (k1 - k0) * t));
  }
  pos.needsUpdate = true;
  m.geometry.computeVertexNormals();
  return m;
}

/** Шип-пирамида: основание в (0,0,0), остриё в +Y на `len`. */
function spike(len: number, r: number, mat: THREE.Material, sides = 4): THREE.Mesh {
  const geo = new THREE.ConeGeometry(r, len, sides, 1);
  geo.translate(0, len / 2, 0);
  return mesh(geo, mat);
}

/** Поставить объект в точку и повернуть его +Y вдоль направления. */
function aim<T extends THREE.Object3D>(o: T, pos: V3, dir: V3): T {
  o.position.set(pos[0], pos[1], pos[2]);
  o.quaternion.setFromUnitVectors(UP, new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
  return o;
}

/** Направление по азимуту (от +X к +Z) и возвышению (к −Y, рабочему концу). */
function dirAE(az: number, el: number): V3 {
  return [Math.cos(el) * Math.cos(az), -Math.sin(el), Math.cos(el) * Math.sin(az)];
}

/** Выпуклый многогранник по вершинам и нормалям граней (грань = вершины на её опорной плоскости). */
function convexPoly(verts: V3[], normals: V3[], mat: THREE.Material): THREE.Mesh {
  const V = verts.map((v) => new THREE.Vector3(v[0], v[1], v[2]));
  const pos: number[] = [];
  const tmp = new THREE.Vector3();
  for (const nn of normals) {
    const n = new THREE.Vector3(nn[0], nn[1], nn[2]).normalize();
    let d = -Infinity;
    for (const v of V) d = Math.max(d, v.dot(n));
    const face = V.filter((v) => v.dot(n) > d - 1e-4);
    if (face.length < 3) continue;
    const c = new THREE.Vector3();
    for (const v of face) c.add(v);
    c.multiplyScalar(1 / face.length);
    const u = tmp.subVectors(face[0]!, c).normalize().clone();
    const w = new THREE.Vector3().crossVectors(n, u);
    const ang = (v: THREE.Vector3): number => { const q = v.clone().sub(c); return Math.atan2(q.dot(w), q.dot(u)); };
    face.sort((a, b) => ang(a) - ang(b));
    for (let i = 1; i < face.length - 1; i++) {
      for (const p of [face[0]!, face[i]!, face[i + 1]!]) pos.push(p.x, p.y, p.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

/** Куб со срезанными углами (полуребро a, срез c < a) — било Кирпичникова тип II. */
function truncCube(a: number, c: number, mat: THREE.Material): THREE.Mesh {
  const verts: V3[] = [];
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    verts.push([sx * c, sy * a, sz * a], [sx * a, sy * c, sz * a], [sx * a, sy * a, sz * c]);
  }
  const normals: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) normals.push([sx, sy, sz]);
  return convexPoly(verts, normals, mat);
}

/** Сфера с деформацией радиуса по направлению (кап, рёбра). */
function warpedSphere(r: number, f: (n: THREE.Vector3) => number, mat: THREE.Material, w = 18, h = 12, sy = 1): THREE.Mesh {
  const geo = new THREE.SphereGeometry(r, w, h);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const k = f(n);
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * sy, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

/** Обмотка: рубчатый чехол вокруг оси Y от y0 до y1 (шнур, ремень). */
function ridged(r: number, y0: number, y1: number, pitch: number, depth: number, mat: THREE.Material, seg = 14): THREE.Mesh {
  const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
  const n = Math.max(2, Math.round((hi - lo) / pitch));
  const prof: V2[] = [];
  for (let i = 0; i <= n * 2; i++) prof.push([i % 2 ? r + depth : r, lo + ((hi - lo) * i) / (n * 2)]);
  return lathe(prof, mat, seg);
}

/** Радиус профиля тела вращения на высоте y (линейно между точками). */
function profR(prof: V2[], y: number): number {
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i]!, b = prof[i + 1]!;
    const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
    if (y >= lo && y <= hi) return hi - lo < 1e-6 ? Math.max(a[0], b[0]) : a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
  }
  return prof[0]![0];
}

/** Масштаб точек профиля. */
const scaleP = (pts: V2[], sx: number, sy = sx): V2[] => pts.map(([x, y]) => [x * sx, y * sy]);

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ТОПОР
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Контур полотна в координатах (u, v): u — от передней грани проушины к лезвию (+X),
 * v — «вверх» к рабочему концу (−Y). Возвращает контур, длину до кромки и сужение по толщине.
 */
interface AxeBladeShape { pts: V2[]; len: number; neck: number; edgeK: number; holes?: V2[][] }

function axeBladeShape(form: string, axis: number, two: boolean): AxeBladeShape {
  switch (form) {
    case 'wedge': { // клиновидное: короткий ТОЛСТЫЙ клин 7–9 см — прямые грани, почти прямая кромка,
      // шейка во всю толщину проушины (не веер, как у широких, и без бороды)
      const s = byAxis(axis, 0.9, 1.1), L = 8 * s, Ht = 3.2 * s, Hb = 3.7 * s;
      return {
        len: L + 0.7 * s, neck: 1, edgeK: 0.34,
        pts: [[0, 2.5], [L, Ht], ...bz([L, Ht], [L + 1.4 * s, -0.25 * s], [L, -Hb], 8), [0, -2.5]],
      };
    }
    case 'narrow': { // узкое: вытянутое вперёд, кромка чуть оттянута вниз
      const s = byAxis(axis, 0.9, 1.1), L = 14 * s;
      return {
        len: L + 0.6, neck: 0.8, edgeK: 0.14,
        pts: [[0, 1.6], [L * 0.55, 1.7], ...bz([L * 0.55, 1.7], [L * 0.9, 1.8], [L, 2.8 * s], 4), ...bz([L, 2.8 * s], [L + 1.4 * s, -0.4], [L - 0.4, -3.4 * s], 8), ...bz([L - 0.4, -3.4 * s], [L * 0.62, -1.75], [L * 0.28, -1.65], 5), [0, -1.6]],
      };
    }
    case 'notched': { // Кирпичников IА: узкое с полулунной выемкой на нижней грани
      const s = byAxis(axis, 0.9, 1.1), L = 14 * s, vb = -4.0 * s, rn = L * 0.2;
      const cu = L * 0.47;
      return {
        len: L + 0.8, neck: 0.8, edgeK: 0.14,
        pts: [
          [0, 1.6], [L * 0.55, 1.7], ...bz([L * 0.55, 1.7], [L * 0.9, 1.8], [L, 2.8 * s], 4),
          ...bz([L, 2.8 * s], [L + 1.8 * s, -1], [L - 0.6, -4.9 * s], 8),
          [L - 2.4, vb - 0.3], [cu + rn, vb],
          ...arc(cu, vb, rn, 0, Math.PI, 12).slice(1),
          [L * 0.13, -2.4], [0, -1.8],
        ],
      };
    }
    case 'hanging-beard': { // прямая верхняя грань и длинная висячая борода
      const s = byAxis(axis, 0.9, 1.1), L = 15 * s;
      return {
        len: L + 0.8, neck: 0.85, edgeK: 0.13,
        pts: [[0, 2.0], [L * 0.5, 2.05], [L * 0.92, 2.1], [L, 2.3], ...bz([L, 2.3], [L + 1.5 * s, -3.5 * s], [L - 0.9, -10.8 * s], 10), ...bz([L - 0.9, -10.8 * s], [L * 0.86, -3.3], [L * 0.28, -2.3], 9), [0, -2.1]],
      };
    }
    case 'short-beard': { // Петерсен E: бородка едва намечена
      const s = byAxis(axis, 0.9, 1.1), L = 12.5 * s;
      return {
        len: L + 1, neck: 0.85, edgeK: 0.14,
        pts: [[0, 2.0], ...bz([0, 2.0], [L * 0.6, 2.2], [L, 3.7 * s], 6), ...bz([L, 3.7 * s], [L + 1.8 * s, -0.8], [L - 0.6, -5.6 * s], 9), ...bz([L - 0.6, -5.6 * s], [L * 0.45, -2.5], [0, -2.1], 7)],
      };
    }
    case 'broad': { // Кирпичников VII / Петерсен L: широкое симметричное полотно-веер
      const s = byAxis(axis, 0.88, 1.12), L = 14 * s, H = 9.5 * s;
      return {
        len: L + 2.4, neck: byAxis(axis, 0.75, 1), edgeK: byAxis(axis, 0.1, 0.16),
        pts: [[0, 2.3], ...bz([0, 2.3], [L * 0.62, 2.6], [L, H], 8), ...bz([L, H], [L + 3.2 * s, 0], [L, -H], 14), ...bz([L, -H], [L * 0.62, -2.6], [0, -2.3], 8)],
      };
    }
    case 'dane': { // Петерсен M: тонкое полотно, кромка-полумесяц 25–30 см, нижний рог длиннее
      const s = byAxis(axis, 0.94, 1.12), L = 19 * s, Ht = 9.5 * s, Hb = 17 * s;
      return {
        len: L + 2.5, neck: byAxis(axis, 0.5, 0.68), edgeK: 0.12,
        pts: [[0, 2.4], ...bz([0, 2.4], [L * 0.62, 2.6], [L, Ht], 9), ...bz([L, Ht], [L + 4.6 * s, -4 * s], [L - 1.5 * s, -Hb], 16), ...bz([L - 1.5 * s, -Hb], [L * 0.52, -2.8], [0, -2.5], 10)],
      };
    }
    case 'crescent': { // секира палача: огромный полумесяц, рога загнуты к древку, окно в полотне
      const s = byAxis(axis, 0.9, 1.1), R = 21 * s, cu = 8 * s, a = (100 * Math.PI) / 180;
      const tipT: V2 = [cu + R * Math.cos(a), R * Math.sin(a)], tipB: V2 = [tipT[0], -tipT[1]];
      const hole = arc(13 * s, 0, 2.6 * s, 0, Math.PI * 2, 12).slice(0, -1);
      return {
        len: cu + R, neck: 0.75, edgeK: 0.12, holes: [hole],
        pts: [[0, 2.8], ...bz([0, 2.8], [9 * s, 9 * s], tipT, 10), ...arc(cu, 0, R, a, -a, 26).slice(1), ...bz(tipB, [9 * s, -9 * s], [0, -2.8], 10)],
      };
    }
    case 'bearded': default: { // Кирпичников IV–VI: бородовидное
      const s = byAxis(axis, 0.9, 1.1) * (two ? 1.3 : 1), L = 13.5 * s;
      return {
        len: L + 1.4, neck: 0.85, edgeK: 0.13,
        pts: [[0, 2.0], ...bz([0, 2.0], [L * 0.6, 2.2], [L, 4.4 * s], 7), ...bz([L, 4.4 * s], [L + 2.0 * s, -1.8 * s], [L - 1.2, -8.5 * s], 10), ...bz([L - 1.2, -8.5 * s], [L * 0.55, -2.6], [0, -2.1], 8)],
      };
    }
  }
}

export function buildAxe(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const S = ctx.parts.strike, G = ctx.parts.grip, B = ctx.parts.bind, H = ctx.parts.head;
  const two = (ctx.tag('grip', 'hold') || (ctx.hands >= 2 ? 'two' : 'one')) === 'two';
  const mS = ctx.mat('strike'), mG = ctx.mat('grip'), mB = ctx.mat('bind'), mH = ctx.mat('head');
  const leather = ctx.matOf('hide', G.step);

  // ── Топорище (grip) ──
  const L = two ? byAxis(G.axis, 110, 140) : byAxis(G.axis, 60, 80);
  const tail = two ? 8 : 5.5;            // конец топорища за кистью (+Y)
  const rH = two ? 1.85 : 1.5;
  const eyeH = two ? 7.6 : 6.2, e = eyeH / 2;
  const yTop = tail - L;                 // конец топорища у бойка (−Y), торчит из проушины на 1 см
  const yEye = yTop + 1.0 + e;
  const ex = rH + 1.0, ez = rH + 0.55;   // полуразмеры проушины по X и Z
  const curved = /curv/.test(G.id);
  const yS = yEye + e + 3;
  const cx = (y: number): number => {
    if (!curved || y <= yS) return 0;
    if (y <= 0) return -2.4 * Math.sin((Math.PI * (y - yS)) / (0 - yS));
    return 1.8 * (y / tail) ** 2;
  };
  const wrapLo = two ? -18 : -12, wrapHi = two ? 3.5 : 2.5;
  if (curved) {
    const pts: V3[] = [];
    const n = 11;
    for (let i = 0; i <= n; i++) { const y = yTop + ((tail - 0.6 - yTop) * i) / n; pts.push([cx(y), y, 0]); }
    g.grip.add(tube(pts, rH, mG, { segments: 60, radial: 10 }));
    g.grip.add(at(cyl(rH, rH, 0.4, mG, 10), 0, yTop + 0.2));
    g.grip.add(at(sphere(rH * 1.28, mG, 10), cx(tail - 1), tail - 1));
    const wp: V3[] = [];
    for (let i = 0; i <= 5; i++) { const y = wrapLo + ((wrapHi - wrapLo) * i) / 5; wp.push([cx(y), y, 0]); }
    g.grip.add(tube(wp, rH * 1.12, leather, { segments: 20, radial: 10 }));
  } else {
    g.grip.add(lathe([
      [0.01, yTop], [rH * 0.97, yTop], [rH * 1.02, yTop + 0.8], [rH * 1.05, yEye + e + 2],
      [rH * 0.98, (yEye + e + tail) / 2], [rH * 0.93, tail - 7], [rH * 1.05, tail - 2.2],
      [rH * 1.32, tail - 0.9], [rH * 1.22, tail], [0.01, tail],
    ], mG, 14));
    g.grip.add(ridged(rH * 1.07, wrapLo, wrapHi, 1.3, 0.14, leather, 12));
  }

  // ── Проушина и щекавицы (bind) ──
  const eye = lathe([[0.01, -e], [ez * 0.86, -e], [ez, -e * 0.55], [ez, e * 0.55], [ez * 0.86, e], [0.01, e]], mB, 16);
  eye.scale.x = ex / ez;
  eye.position.y = yEye;
  g.bind.add(eye);
  const lk = byAxis(B.axis, 0.88, 1.12);
  const lugZ = rH + 0.28;
  const lugPair = (outline: V2[]): void => {
    for (const s of [1, -1]) g.bind.add(at(extrudeXY(clean(outline), 0.55, mB), 0, 0, s * lugZ));
  };
  // Верхние щекавицы стоят ВЫШЕ торца топорища — между щёк там пусто, поэтому они цельные во всю
  // толщину проушины (иначе с ребра видны две висящие в воздухе пластинки).
  const lugSolid = (outline: V2[]): void => { g.bind.add(extrudeXY(clean(outline), 2 * lugZ + 0.55, mB)); };
  const yLo = yEye + e - 0.4;  // нижний край проушины (к кисти)
  const yHi = yEye - e + 0.4;  // верхний край (к бойку)
  const bw = ex * 0.85;
  switch (ctx.tag('bind', 'lugs')) {
    case 'none': // гладкая проушина — только поясок по краям
      g.bind.add(at(torus(ez * 1.02, 0.28, mB, Math.PI * 2, 18), 0, yEye + e * 0.7, 0, Math.PI / 2));
      break;
    case 'two-pairs': { // короткие треугольники вверх и вниз
      const ll = (two ? 5.2 : 4.2) * lk, lu = (two ? 2.6 : 2.1) * lk;
      lugPair([[-bw, yLo], [bw, yLo], [0, yLo + ll]]);
      lugSolid([[-bw * 0.8, yHi], [0, yHi - lu], [bw * 0.8, yHi]]);
      break;
    }
    case 'cape': { // мысовидные: длинные вогнутые острия-«мысы», нижние длиннее
      const ll = (two ? 9 : 7.5) * lk, lu = (two ? 4.4 : 3.6) * lk;
      lugPair([[-bw, yLo], [bw, yLo], ...bz([bw, yLo], [ex * 0.15, yLo + ll * 0.25], [0.15, yLo + ll], 6), ...bz([-0.15, yLo + ll], [-ex * 0.15, yLo + ll * 0.25], [-bw, yLo], 6)]);
      lugSolid([[-bw, yHi], ...bz([-bw, yHi], [-ex * 0.15, yHi - lu * 0.25], [-0.15, yHi - lu], 5), [0.15, yHi - lu], ...bz([0.15, yHi - lu], [ex * 0.15, yHi - lu * 0.25], [bw, yHi], 5).slice(0, -1), [bw, yHi]]);
      break;
    }
    case 'tube': { // трубчатая втулка вдоль топорища с валиком на конце
      const tl = (two ? 14 : 10.5) * lk, r0 = rH + 0.5;
      g.bind.add(lathe([[r0 + 0.3, yLo - 0.5], [r0, yLo + 1], [r0 - 0.08, yLo + tl - 1.2], [r0 + 0.35, yLo + tl - 0.8], [r0 + 0.35, yLo + tl - 0.2], [rH + 0.05, yLo + tl]], mB, 14));
      g.bind.add(at(sphere(0.35, mB, 6), 0, yLo + tl * 0.5, r0 - 0.05));
      g.bind.add(at(sphere(0.35, mB, 6), 0, yLo + tl * 0.5, -(r0 - 0.05)));
      break;
    }
    case 'lower': default: { // только нижние: треугольники вниз по топорищу
      const ll = (two ? 7 : 5.6) * lk;
      lugPair([[-bw, yLo], [bw, yLo], [ex * 0.28, yLo + ll * 0.55], [0, yLo + ll], [-ex * 0.28, yLo + ll * 0.55]]);
      break;
    }
  }

  // ── Полотно (strike), кромка в +X ──
  const form = ctx.tag('strike', 'form') || (two ? 'dane' : 'bearded');
  const bs = axeBladeShape(form, S.axis, two);
  const Q = ([u, v]: V2): V2 => [ex - 0.5 + u, yEye - v];
  const bladeDepth = 2 * ez * bs.neck;
  const bladeMesh = extrudeXY(clean(bs.pts.map(Q)), bladeDepth, mS, { holes: bs.holes?.map((h) => clean(h.map(Q))) });
  taperZ(bladeMesh, ex - 0.5, ex - 0.5 + bs.len, 1, bs.edgeK);
  g.strike.add(bladeMesh);
  // Заклёпка-клеймо у шейки — у каждой формы на своём месте (мелкая особенность варианта).
  const hm = hash01(S.id);
  g.strike.add(at(cyl(0.45, 0.45, bladeDepth * 0.95, mS, 8), ex + 1.6 + hm * 1.2, yEye + (hm - 0.5) * 1.2, 0, Math.PI / 2));

  // ── Обух (head), со стороны −X ──
  // У двуручной секиры полотно 25–30 см, и обух в родном размере теряется в превью — чуть крупнее.
  const hk = byAxis(H.axis, 0.9, 1.1) * (two ? 1.2 : 1);
  const P = ([w, v]: V2): V2 => [-(ex - 0.5) - w, yEye - v];
  const pz = 2 * ez * 0.86;
  const poll = (pts: V2[], depth: number, k1 = 1, len = 0): void => {
    const m = extrudeXY(clean(pts.map(P)), depth, mH);
    if (k1 !== 1) taperZ(m, -(ex - 0.5), -(ex - 0.5) - len, 1, k1);
    g.head.add(m);
  };
  switch (ctx.tag('head', 'butt')) {
    case 'hammer': { // молоточек (чекан): шейка и квадратный боёк
      const sq = (two ? 3.6 : 3.4) * hk, nl = 4.2 * hk;
      poll([[0, e * 0.8], [nl * 0.5, sq / 2], [nl, sq / 2], [nl, -sq / 2], [nl * 0.5, -sq / 2], [0, -e * 0.8]], sq * 0.95);
      g.head.add(at(box(1.0, sq + 0.6, sq + 0.6, mH), P([nl + 0.3, 0])[0], yEye));
      break;
    }
    case 'plate': { // пластинчатый: тонкая Т-пластина, выступающая вверх и вниз
      const t = 2.2 * hk, w = 2.8 * hk;
      poll([[0, e * 0.8], [1.1, e * 0.8], [1.4, e + t], [w, e + t], [w + 0.4, e + t - 0.6], [w + 0.4, -e - t + 0.6], [w, -e - t], [1.4, -e - t], [1.1, -e * 0.8], [0, -e * 0.8]], 1.1);
      break;
    }
    case 'notched': { // вырезной с мысками: вогнутый затылок с двумя остриями
      const w = 2.7 * hk;
      poll([[0, e], [w, e + 1.4 * hk], [w * 0.62, e * 0.32], [w * 0.4, 0], [w * 0.62, -e * 0.32], [w, -e - 1.4 * hk], [0, -e]], pz * 0.9);
      break;
    }
    case 'long': { // длинный затыльник: вытянутая сужающаяся призма
      const w = 7 * hk;
      poll([[0, e * 0.85], [w, e * 0.42], [w + 0.6, 0], [w, -e * 0.42], [0, -e * 0.85]], pz, 0.55, w + 0.6);
      break;
    }
    case 'beak': { // клюв: загнутый к топорищу шип
      const bl = (two ? 10 : 9.5) * hk;
      const tip: V2 = [bl, -3.4 * hk];
      poll([[0, e * 0.55], ...bz([0, e * 0.55], [bl * 0.6, e * 0.45], tip, 8), ...bz(tip, [bl * 0.5, -1.0], [0, -e * 0.55], 8)], pz * 0.8, 0.2, bl);
      break;
    }
    case 'plain': default: { // простой: плоская площадка затылка
      const w = 1.3 * hk;
      poll([[0, e * 0.92], [w, e * 0.85], [w, -e * 0.85], [0, -e * 0.92]], pz * 0.92);
      break;
    }
  }
  return root;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// БУЛАВА
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export function buildMace(ctx: MeshCtx): THREE.Group {
  const { root, g } = slotGroups();
  const S = ctx.parts.strike, G = ctx.parts.grip, B = ctx.parts.bind, H = ctx.parts.head;
  const two = (ctx.tag('grip', 'hold') || (ctx.hands >= 2 ? 'two' : 'one')) === 'two';
  const mS = ctx.mat('strike'), mG = ctx.mat('grip'), mB = ctx.mat('bind'), mH = ctx.mat('head');
  const leather = ctx.matOf('hide', G.step);

  // ── Рукоять / древко (grip) ──
  const L = two ? byAxis(G.axis, 120, 200) : byAxis(G.axis, 50, 70);
  const tail = two ? 16 : 4.5;            // за кистью (+Y)
  const rT = two ? 2.1 : 1.85;            // у била
  const rG = two ? 2.0 : 1.6;             // у кисти
  const yTop = tail - L;
  g.grip.add(lathe([
    [0.01, yTop], [rT, yTop], [rT, yTop + 3], [(rT + rG) / 2, yTop + L * 0.4], [rG, -8],
    [rG * 0.97, 0], [rG * 1.06, tail - 1.2], [rG * 1.1, tail], [0.01, tail],
  ], mG, 14));
  // Обмотка — на ширину ладони (у 1h ≈ 10 см): кольцо-гарда встаёт сразу перед ней, а не посреди хвата.
  g.grip.add(ridged(rG * 1.06, two ? -16 : -7, two ? 6 : 3.2, 1.2, 0.13, leather, 12));

  // ── Било (strike): своя группа у верхнего конца рукояти, локальная y < 0 — к рабочему концу ──
  const hg = new THREE.Group();
  hg.position.y = yTop;
  g.strike.add(hg);
  const form = ctx.tag('strike', 'form') || (two ? 'crow' : 'sphere');
  const hs = byAxis(S.axis, 0.92, 1.08);
  const wood = ctx.matOf('wood', S.step);
  const hsh = hash01(S.id);
  const collar = (r: number): void => {
    hg.add(lathe([[r + 0.15, 1.4], [r + 0.5, 0.8], [r + 0.5, -1.2], [r + 0.2, -1.8]], mS, 16));
  };
  const nub = (y: number, r = 0.9): void => { hg.add(at(sphere(r, mS, 10), 0, y)); };
  const ring = (r: number, y: number, h: number, mat: THREE.Material): void => {
    hg.add(lathe([[r - 0.2, y + h / 2], [r + 0.3, y + h * 0.3], [r + 0.3, y - h * 0.3], [r - 0.2, y - h / 2]], mat, 16));
  };
  const spikesOn = (cy: number, r: number, dirs: { az: number; el: number; len: number; rad: number }[], sides = 4): void => {
    for (const d of dirs) {
      const v = dirAE(d.az, d.el);
      const s = spike(d.len, d.rad, mS, sides);
      aim(s, [v[0] * r * 0.85, cy + v[1] * r * 0.85, v[2] * r * 0.85], v);
      hg.add(s);
    }
  };
  /** Шип остриём к рабочему концу (−Y), основание на высоте y. */
  const spikeDown = (len: number, r: number, y: number): THREE.Mesh => at(spike(len, r, mS, 4), 0, y, 0, 0, 0, Math.PI);
  const Q4 = Math.PI / 2, Q8 = Math.PI / 4;

  switch (form) {
    // ── деревянные (1h) ──
    case 'club-butt': { // комлевая дубина: утолщение к концу и шишки корней
      const prof = scaleP([[rT, 1], [rT * 1.1, -4], [2.6, -10], [3.6, -16], [4.6, -21], [5.3, -25], [5.4, -28], [4.6, -31], [2.8, -32.6], [0.01, -33]], hs);
      hg.add(lathe(prof, mS, 14));
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + hsh * 2, y = -(21 + ((i * 3) % 7) * 1.4) * hs;
        const r = profR(prof, y);
        const k = sphere(1.5 + 0.35 * (i % 3), mS, 8);
        k.scale.set(1, 0.7, 1);
        hg.add(at(k, Math.cos(a) * r * 0.92, y, Math.sin(a) * r * 0.92));
      }
      for (let i = 0; i < 4; i++) {
        const az = (i / 4) * Math.PI * 2 + 0.4;
        const v = dirAE(az, 0.9);
        hg.add(aim(spike(3.2 * hs, 1.0, mS, 5), [v[0] * 3.2 * hs, -30.5 * hs, v[2] * 3.2 * hs], v));
      }
      break;
    }
    case 'burl': { // капо́вая палица: шея и бугристый кап
      const R = 5.6 * hs, cy = -9 - R * 0.8;
      hg.add(lathe([[rT, 1], [rT * 0.95, -5], [rT * 1.2, -8], [3.2, -10]], mS, 14));
      const ph = hsh * 6;
      hg.add(at(warpedSphere(R, (n) => 1 + 0.13 * Math.sin(4.1 * n.x + ph) * Math.sin(3.7 * n.y + 1.3) + 0.09 * Math.sin(5.3 * n.z + 2 * ph) + 0.06 * Math.cos(7.1 * n.x * n.z), mS, 18, 13, 1.12), 0, cy));
      for (let i = 0; i < 4; i++) {
        const v = dirAE(i * 1.7 + ph, -0.3 + i * 0.35);
        hg.add(at(sphere(1.2 + (i % 2) * 0.4, mS, 8), v[0] * R * 0.95, cy + v[1] * R, v[2] * R * 0.95));
      }
      break;
    }
    case 'cue': { // кий: тонкая палка с утолщением-яблоком
      hg.add(lathe(scaleP([[rT, 1], [rT * 0.85, -6], [rT * 0.78, -16], [2.2, -18.5], [3.1, -21], [3.2, -23.5], [2.4, -26], [1.0, -27.2], [0.01, -27.5]], 1, hs), mS, 16));
      hg.add(at(torus(rT * 0.8, 0.22, mS, Math.PI * 2, 14), 0, -12 * hs, 0, Math.PI / 2));
      break;
    }
    // ── металлические (1h) ──
    case 'cube': { // Кирпичников II: куб со срезанными углами
      const a = 3.3 * hs;
      collar(rT);
      hg.add(at(truncCube(a, a * 0.42, mS), 0, -1.2 - a));
      nub(-1.2 - 2 * a - 0.3, 0.7);
      break;
    }
    case 'ribbed': { // ребристая: шар с восемью рёбрами
      const R = 4.0 * hs;
      collar(rT);
      hg.add(at(warpedSphere(R, (n) => {
        const az = Math.atan2(n.z, n.x), lat = Math.sqrt(Math.max(0, 1 - n.y * n.y));
        return 1 + 0.22 * Math.pow(Math.abs(Math.cos(4 * az)), 6) * lat;
      }, mS, 40, 12, 1.2), 0, -1.4 - R * 1.2));
      nub(-1.4 - R * 2.4 - 0.2, 0.8);
      break;
    }
    case 'flanged': { // шестопёр: шесть перьев на трубке
      const k = hs;
      hg.add(lathe([[rT + 0.3, 1.2], [rT + 0.3, -2], [1.4, -3], [1.3, -13.5 * k], [1.9, -14.2 * k], [1.2, -15.3 * k], [0.01, -15.6 * k]], mS, 14));
      const fl = scaleP([[0.9, -1.5], [2.2, -2.4], [3.4, -3.8], [4.6, -5.0], [5.0, -9.2], [5.6, -10.8], [3.8, -12.6], [1.6, -14.2], [0.9, -14.2]], k);
      for (let i = 0; i < 6; i++) hg.add(at(extrudeXY(fl, 0.75, mS), 0, 0, 0, 0, (i * Math.PI) / 3, 0));
      break;
    }
    case 'beak': { // Кирпичников IIА: куб с клювом-клевцом
      const a = 3.0 * hs, yc = -1.2 - a;
      collar(rT);
      hg.add(at(truncCube(a, a * 0.4, mS), 0, yc));
      const tip: V2 = [a + 7.5 * hs, yc + 3.6];
      const bk = extrudeXY(clean([[a - 0.4, yc - 1.5], ...bz([a - 0.4, yc - 1.5], [a + 4.5, yc - 1.4], tip, 8), ...bz(tip, [a + 3.5, yc + 0.4], [a - 0.4, yc + 1.5], 8)]), 1.8, mS);
      hg.add(taperZ(bk, a - 0.4, tip[0], 1, 0.25));
      nub(yc - a - 0.3, 0.7);
      break;
    }
    // ── шипастые (1h) ──
    case 'spikes12': { // Кирпичников IV: шар и 12 пирамидальных шипов
      const R = 3.2 * hs, cy = -1.2 - R;
      collar(rT);
      hg.add(at(sphere(R, mS, 14), 0, cy));
      const d: { az: number; el: number; len: number; rad: number }[] = [];
      for (let i = 0; i < 4; i++) d.push({ az: i * Q4, el: 0, len: 3.4 * hs, rad: 1.2 });
      for (let i = 0; i < 4; i++) for (const el of [0.8, -0.8]) d.push({ az: Q8 + i * Q4, el, len: 2.6 * hs, rad: 1.0 });
      spikesOn(cy, R, d);
      break;
    }
    case 'spikes-peas': { // Кирпичников III: четыре шипа и «горошки» между ними
      const R = 3.3 * hs, cy = -1.2 - R;
      collar(rT);
      hg.add(at(sphere(R, mS, 14), 0, cy));
      spikesOn(cy, R, [0, 1, 2, 3].map((i) => ({ az: i * Q4, el: 0, len: 3.8 * hs, rad: 1.35 })));
      for (let i = 0; i < 4; i++) for (const el of [0.66, 0, -0.66]) {
        const v = dirAE(Q8 + i * Q4, el);
        hg.add(at(sphere(0.7 * hs, mS, 6), v[0] * R, cy + v[1] * R, v[2] * R));
      }
      hg.add(at(sphere(0.7 * hs, mS, 6), 0, cy - R, 0));
      break;
    }
    case 'spikes4': { // Кирпичников I: кубик и четыре крупные пирамиды крестом
      const a = 2.6 * hs, cy = -1.2 - a;
      collar(rT);
      hg.add(at(truncCube(a, a * 0.42, mS), 0, cy));
      for (let i = 0; i < 4; i++) {
        const v = dirAE(i * Q4, 0);
        const s = spike(5.2 * hs, 2.0 * hs, mS, 4);
        s.geometry.rotateY(Q8);
        hg.add(aim(s, [v[0] * a * 0.9, cy, v[2] * a * 0.9], v));
      }
      break;
    }
    // ── молот и клюв (2h) ──
    case 'lucerne': case 'crow': case 'falcon': {
      // Голова на 1,6–2 м древка в превью мелкая — рисуем её чуть крупнее (×1.2), втулка — по древку.
      const hb = new THREE.Group();
      hb.scale.setScalar(1.2);
      hg.add(hb);
      const top = -12.3;
      hg.add(lathe([[rT + 0.35, 1.2], [rT + 0.35, -3.5], [rT + 0.2, -6.0]], mS, 14));
      hb.add(at(box(3.6, 7.5, 3.6, mS), 0, -8.5));
      const beak = (dir: 1 | -1, len: number, drop: number, curve: number, depth: number): void => {
        const x0 = 1.6 * dir, tip: V2 = [dir * (1.6 + len), -8.5 + drop];
        const pts: V2[] = [[x0, -10.5], ...bz([x0, -10.5], [dir * (1.6 + len * 0.55), -10.5 + curve * 0.2], tip, 9), ...bz(tip, [dir * (1.6 + len * 0.5), -6.8 + curve * 0.35], [x0, -6.6], 9)];
        hb.add(taperZ(extrudeXY(clean(pts), depth, mS), x0, tip[0], 1, 0.22));
      };
      const hammer = (dir: 1 | -1, len: number, face: number): void => {
        hb.add(at(box(len, face * 0.85, face * 0.85, mS), dir * (1.6 + len / 2), -8.5));
        hb.add(at(box(0.8, face, face, mS), dir * (1.6 + len + 0.2), -8.5));
      };
      if (form === 'lucerne') { // люцернский молот: четырёхзубый боёк, клюв назад, длинное копьё
        hb.add(at(box(3.4, 4.8, 4.8, mS), 3.3, -8.5));
        for (const dy of [-1.45, 1.45]) for (const dz of [-1.45, 1.45]) hb.add(aim(spike(3.4, 1.1, mS, 4), [4.9, -8.5 + dy, dz], [1, 0, 0]));
        beak(-1, 12.5 * hs, 4.5, 3, 2.2);
        hb.add(spikeDown(26 * hs, 1.35, top));
      } else if (form === 'crow') { // вороний клюв: длинный загнутый клюв, молоточек, копьецо
        beak(1, 16.5 * hs, 6, 5, 2.2);
        hammer(-1, 3.0, 3.6);
        hb.add(spikeDown(17 * hs, 1.15, top));
      } else { // соколиный клюв: короткий ПРЯМОЙ четырёхгранный клюв (не плоский серп, как у вороньего)
        const bk = spike(10.5 * hs, 1.35, mS, 4);
        bk.scale.set(1, 1, 0.8);
        hb.add(aim(bk, [1.5, -8.6, 0], [1, 0.14, 0]));
        hammer(-1, 2.6, 3.1);
        hb.add(spikeDown(12 * hs, 1.0, top));
      }
      break;
    }
    // ── грубое древковое (2h) ──
    case 'lead': { // свинцовый молот майотенов: поперечный свинцовый цилиндр в железных обручах
      const R = 5.2 * hs, W = 17 * hs, cy = -3 - R * 0.95;
      const lead = ctx.fixed(0x6f757d, 0.5, 0.55);
      hg.add(lathe([[rT + 0.4, 1.8], [rT + 0.45, -3.5]], mS, 14));
      hg.add(at(lathe([[0.01, -W / 2], [R * 0.9, -W / 2], [R, -W / 2 + 0.8], [R, W / 2 - 0.8], [R * 0.9, W / 2], [0.01, W / 2]], lead, 18), 0, cy, 0, 0, 0, Math.PI / 2));
      for (const x of [-W / 2 + 1.2, W / 2 - 1.2, 0]) hg.add(at(cyl(R + 0.3, R + 0.3, x === 0 ? 1.8 : 1.3, mS, 18), x, cy, 0, 0, 0, Math.PI / 2));
      break;
    }
    case 'oslop': { // ослоп: тяжёлая дубина, окованная железными шипами-гвоздями
      const prof = scaleP([[rT, 1], [rT * 1.1, -6], [3.4, -18], [4.8, -30], [5.9, -40], [6.3, -46], [5.8, -51], [3.8, -54.5], [0.01, -55.5]], hs);
      hg.add(lathe(prof, wood, 16));
      for (const y of [-27, -50]) { const yy = y * hs; ring(profR(prof, yy), yy, 1.6, mS); }
      for (let r = 0; r < 4; r++) {
        const y = -(32 + r * 4.5) * hs, rr = profR(prof, y);
        for (let i = 0; i < 6; i++) {
          const v = dirAE((i + (r % 2) * 0.5) * (Math.PI / 3), 0);
          hg.add(aim(spike(1.6, 0.75, mS, 4), [v[0] * rr * 0.95, y, v[2] * rr * 0.95], v));
        }
      }
      break;
    }
    case 'goedendag': { // гёдендаг: древко расширяется к концу, железное кольцо и длинный шип
      const prof = scaleP([[rT, 1], [rT * 1.05, -10], [3.0, -22], [4.0, -33], [4.5, -40], [4.6, -42.5], [0.01, -42.6]], hs);
      hg.add(lathe(prof, wood, 16));
      ring(4.6 * hs, -41.3 * hs, 2.6, mS);
      ring(profR(prof, -30 * hs), -30 * hs, 1.4, mS);
      hg.add(spikeDown(17 * hs, 1.3, -42.3 * hs));
      break;
    }
    case 'sprinkler': { // моргенштерн-«кропило»: шипастый барабан на древке
      const prof = scaleP([[rT, 1], [rT * 1.3, -1.5], [4.6, -3], [4.8, -5], [4.8, -25], [4.4, -27], [0.01, -27.3]], hs);
      hg.add(lathe(prof, wood, 16));
      for (const y of [-4, -15, -26]) ring(4.8 * hs, y * hs, 1.4, mS);
      for (let r = 0; r < 4; r++) {
        const y = [-7.5, -11.5, -18.5, -22.5][r]! * hs;
        for (let i = 0; i < 6; i++) {
          const v = dirAE((i + (r % 2) * 0.5) * (Math.PI / 3), 0);
          hg.add(aim(spike(3.2, 0.75, mS, 4), [v[0] * 4.6 * hs, y, v[2] * 4.6 * hs], v));
        }
      }
      hg.add(spikeDown(9 * hs, 1.1, -27 * hs));
      break;
    }
    case 'sphere': default: { // Кирпичников V: шаровая булава
      const R = 4.2 * hs;
      collar(rT);
      hg.add(at(sphere(R, mS, 18), 0, -1.3 - R));
      nub(-1.3 - 2 * R - 0.2, 0.9);
      break;
    }
  }

  // ── Обоймица (bind): у основания била, к кисти (+Y от yTop) ──
  const mk = byAxis(B.axis, 0.92, 1.08);
  const yB = yTop;
  switch (ctx.tag('bind', 'mount')) {
    case 'wrap': { // обмотка шнуром между двумя колечками
      const wl = (two ? 9 : 6) * mk;
      g.bind.add(ridged(rT + 0.02, yB + 0.4, yB + wl, 0.8, 0.22, ctx.matOf('hide', B.step), 14));
      for (const y of [yB + 0.4, yB + wl]) g.bind.add(at(torus(rT + 0.1, 0.22, mB, Math.PI * 2, 16), 0, y, 0, Math.PI / 2));
      break;
    }
    case 'tube': { // длинная трубчатая втулка с валиком и заклёпками
      const tl = (two ? 22 : 12) * mk, r0 = rT + 0.3;
      g.bind.add(lathe([[r0 + 0.35, yB - 0.4], [r0 + 0.35, yB + 1], [r0 + 0.05, yB + 2], [r0, yB + tl - 1.2], [r0 + 0.35, yB + tl - 0.8], [r0 + 0.35, yB + tl], [rT + 0.02, yB + tl + 0.3]], mB, 16));
      for (const s of [1, -1]) g.bind.add(at(sphere(0.35, mB, 6), s * (r0 + 0.02), yB + tl * 0.55, 0));
      break;
    }
    case 'langets': { // ланцеты: четыре железные полосы вниз по древку на заклёпках
      const ll = (two ? 38 : 15) * mk, w = two ? 1.4 : 1.1;
      g.bind.add(lathe([[rT + 0.4, yB - 0.4], [rT + 0.4, yB + 1.6], [rT + 0.05, yB + 2.0]], mB, 16));
      const strip = clean([[-w / 2, 0], [w / 2, 0], [w / 2, ll - 1.6], [0, ll], [-w / 2, ll - 1.6]]);
      for (let i = 0; i < 4; i++) {
        const a = i * (Math.PI / 2);
        const s = extrudeXY(strip, 0.3, mB);
        s.position.set(Math.sin(a) * (rT + 0.15), yB, Math.cos(a) * (rT + 0.15));
        s.rotation.y = a;
        g.bind.add(s);
        for (const f of [0.4, 0.85]) g.bind.add(at(sphere(0.3, mB, 6), Math.sin(a) * (rT + 0.35), yB + ll * f, Math.cos(a) * (rT + 0.35)));
      }
      break;
    }
    case 'ferrule': default: { // оковка: кольцевой обруч с валиками
      const fl = (two ? 6.5 : 4.5) * mk, r = rT;
      g.bind.add(lathe([[r + 0.1, yB - 0.5], [r + 0.55, yB - 0.3], [r + 0.55, yB + 0.6], [r + 0.3, yB + 0.9], [r + 0.3, yB + fl - 0.9], [r + 0.55, yB + fl - 0.6], [r + 0.55, yB + fl], [r + 0.1, yB + fl + 0.2]], mB, 16));
      break;
    }
  }

  // ── Конец рукояти / подток (head): +Y за кистью ──
  const hk = byAxis(H.axis, 0.9, 1.1);
  const cap = (): void => { g.head.add(lathe([[rG * 1.05, tail - 1.2], [rG * 1.22, tail - 0.9], [rG * 1.22, tail + 0.3], [rG * 0.9, tail + 0.8], [0.01, tail + 0.9]], mH, 14)); };
  switch (ctx.tag('head', 'end')) {
    case 'ring': { // кольцо-гарда сразу перед кистью (у переднего края обмотки) + колпачок
      const yr = two ? -16.6 : -7.6;
      g.head.add(at(torus(3.4 * hk, 0.45, mH, Math.PI * 2, 24), 0, yr, 0, Math.PI / 2));
      g.head.add(at(cyl(3.3 * hk, 3.3 * hk, 0.35, mH, 20), 0, yr));
      cap();
      break;
    }
    case 'lanyard': { // темляк: колпачок с ушком и петля шнура
      cap();
      g.head.add(at(torus(0.8, 0.25, mH, Math.PI * 2, 12), 0, tail + 1.3));
      g.head.add(tube([[0, tail + 1.9, 0], [1.6, tail + 4.2, 0], [2.4, tail + 8, 0.3], [1.3, tail + 11.5, 0.5], [-0.6, tail + 12, 0.4], [-2.0, tail + 9, 0.2], [-1.5, tail + 4.2, 0]], 0.28, ctx.matOf('hide', H.step), { closed: true, segments: 40, radial: 6 }));
      break;
    }
    case 'hook': { // крюк для подвеса у седла
      cap();
      const pts: V3[] = [[0, tail + 0.4, 0], [0, tail + 3, 0], [0.6, tail + 5.2, 0], [2.4, tail + 6.3, 0], [4.0, tail + 5.1, 0], [4.2, tail + 3.2, 0], [3.4, tail + 2.2, 0]];
      g.head.add(tube(pts.map(([x, y, z]) => [x * hk, tail + (y - tail) * hk, z] as V3), 0.42, mH, { segments: 40, radial: 8 }));
      g.head.add(at(sphere(0.55, mH, 8), 3.4 * hk, tail + 2.2 * hk));
      break;
    }
    case 'butt': { // подток: оковка торца; тяжёлый — длиннее и с шаровым противовесом, лёгкий — тонкий колпак
      const hc = byAxis(H.axis, 3.5, 8), kb = byAxis(H.axis, 0.2, 1.5), rb = rG * 1.2 * kb;
      g.head.add(lathe([
        [rG * 1.05, tail - hc], [rG * 1.28, tail - hc + 0.7], [rG * 1.15, tail - hc + 1.4], [rG * 1.12, tail - 1.2],
        [Math.max(rG * 1.15, rb * 0.8), tail - 0.4], [rb, tail + 0.6 * kb], [rb * 0.85, tail + 1.6 * kb], [rb * 0.45, tail + 2.3 * kb], [0.01, tail + 2.5 * kb],
      ], mH, 16));
      break;
    }
    case 'spike': { // острый подток: втулка и четырёхгранное остриё
      g.head.add(lathe([[rG * 1.05, tail - 4.5], [rG * 1.25, tail - 3.8], [rG * 1.15, tail - 0.6], [rG * 1.3, tail + 0.4], [rG * 0.8, tail + 0.8]], mH, 14));
      g.head.add(at(spike(11 * hk, rG * 0.85, mH, 4), 0, tail + 0.6));
      break;
    }
    case 'knob': default: { // набалдашник-«грибок»
      g.head.add(lathe([[rG * 1.02, tail - 1.2], [rG * 1.2, tail - 0.2], [2.6 * hk, tail + 1.0], [2.8 * hk, tail + 1.9], [2.2 * hk, tail + 2.8], [0.01, tail + 3.3 * hk]], mH, 16));
      break;
    }
  }
  return root;
}
