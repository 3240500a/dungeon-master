/**
 * ГИЗМО ПРЕДЕЛОВ СУСТАВА (поз-редактор) — рисует допустимую зону движения выбранного сустава ПРЯМО на манекене,
 * чтобы крутилки лимитов стали наглядными (как арматура-лимиты в Blender / RotationLimit в Final IK). Строится ТОЙ ЖЕ
 * параметризацией, что FK-клэмп (`jointClamp.ts`): swing = вектор поворота (rP вокруг plane, rN вокруг normal),
 * граница = АСИММЕТРИЧНЫЙ бокс [planeMin,planeMax]×[normalMin,normalMax] → гизмо совпадает с реальным упором кости 1:1.
 *  - swing (плечо/бедро/кисть/торс/голова/голеностоп) → полупрозрачная «шапка» допустимых направлений + дуга твиста;
 *  - hinge (локоть/колено/носок) → плоский клин (сектор) от min до max.
 *  - ИНДИКАТОР: жёлтая точка = текущее направление кости в зоне, стрелка = текущий твист (сколько до предела).
 * Геометрия в ЛОКАЛЬНОМ фрейме сустава; `place()` ставит в мир-позицию сустава + ориентацию РОДИТЕЛЬСКОЙ кости.
 */
import * as THREE from 'three';
import type { LimitView } from './humanoidRagdoll.js';

const R = 14;   // визуальный радиус зоны/дуги (u)

export interface LimitGizmo {
  group: THREE.Group;
  set(view: LimitView | null): void;                                   // пересобрать зону под лимит
  mark(view: LimitView, rP: number, rN: number, twist: number): void;  // подвинуть индикатор текущего положения кости
  place(pos: THREE.Vector3, parentQuat: THREE.Quaternion): void;       // поставить на сустав (мир) + ориентация родителя
}

const v3 = (a: readonly number[]): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]).normalize();
// Направление оси кости (twist) после swing-поворота (rP вокруг plane, rN вокруг normal) — лог-карта, как в клэмпе.
function swingDir(rP: number, rN: number, T: THREE.Vector3, P: THREE.Vector3, N: THREE.Vector3): THREE.Vector3 {
  const mag = Math.hypot(rP, rN);
  if (mag < 1e-6) return T.clone();
  const axis = P.clone().multiplyScalar(rP / mag).addScaledVector(N, rN / mag);
  return T.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, mag));
}

export function makeLimitGizmo(): LimitGizmo {
  const group = new THREE.Group(); group.visible = false;
  const geos: THREE.BufferGeometry[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  // Индикатор текущего положения (создаётся один раз, живёт всегда): точка-направление + стрелка твиста.
  const dot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe066, depthWrite: false })); dot.renderOrder = 9;
  const twistMark = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffe066, depthWrite: false })); twistMark.renderOrder = 9;
  group.add(dot, twistMark);
  function clear(): void { for (const g of geos) g.dispose(); geos.length = 0; group.remove(...group.children.filter((c) => c !== dot && c !== twistMark)); }

  function surface(dirs: THREE.Vector3[], color: number, opacity: number, loop: boolean): void {
    const n = dirs.length; if (n < 2) return;
    const pos: number[] = [0, 0, 0];
    for (const d of dirs) pos.push(d.x * R, d.y * R, d.z * R);
    const idx: number[] = [];
    for (let i = 0; i < (loop ? n : n - 1); i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
    const g = track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 6; group.add(mesh);
  }
  function line(pts: THREE.Vector3[], color: number, closed: boolean, scale = R): void {
    const g = track(new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.clone().multiplyScalar(scale))));
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const ln = closed ? new THREE.LineLoop(g, m) : new THREE.Line(g, m); ln.renderOrder = 7; group.add(ln);
  }

  function set(view: LimitView | null): void {
    clear();
    if (!view) { group.visible = false; return; }
    group.visible = true;
    if (view.kind === 'swing') {
      const T = v3(view.twist!), P = v3(view.plane!), N = v3(view.normal!);
      const pMin = view.planeMin ?? 0, pMax = view.planeMax ?? 0, nMin = view.normalMin ?? 0, nMax = view.normalMax ?? 0, STEP = 48;
      const dirs: THREE.Vector3[] = [];
      for (let i = 0; i < STEP; i++) {                        // обход прямоугольника (rP,rN) по периметру асимм. бокса
        const t = (i / STEP) * 4;
        let rP: number, rN: number;
        if (t < 1) { rP = pMin + (pMax - pMin) * t; rN = nMin; }
        else if (t < 2) { rP = pMax; rN = nMin + (nMax - nMin) * (t - 1); }
        else if (t < 3) { rP = pMax - (pMax - pMin) * (t - 2); rN = nMax; }
        else { rP = pMin; rN = nMax - (nMax - nMin) * (t - 3); }
        dirs.push(swingDir(rP, rN, T, P, N));
      }
      surface(dirs, 0x39a0ff, 0.20, true); line(dirs, 0x8fd0ff, true);      // зона + контур
      line([new THREE.Vector3(0, 0, 0), T], 0xffffff, false);               // ось кости (twist)
      const tmin = view.twistMin ?? 0, tmax = view.twistMax ?? 0;
      if (tmax - tmin > 0.01) {
        const arc: THREE.Vector3[] = [];
        for (let i = 0; i <= 24; i++) arc.push(P.clone().applyAxisAngle(T, tmin + (tmax - tmin) * (i / 24)));
        line(arc, 0xffab40, false, R * 0.55);
      }
    } else {   // hinge: клин-сектор от min до max
      const A = v3(view.axis!), Nn = v3(view.hingeNormal!), lo = view.min ?? 0, hi = view.max ?? 0, STEP = 28;
      const dirs: THREE.Vector3[] = [];
      for (let i = 0; i <= STEP; i++) dirs.push(Nn.clone().applyAxisAngle(A, lo + (hi - lo) * (i / STEP)));
      surface(dirs, 0x46d07a, 0.24, false); line(dirs, 0x9af0b8, false);
      line([new THREE.Vector3(0, 0, 0), dirs[0]!.clone(), new THREE.Vector3(0, 0, 0), dirs[dirs.length - 1]!.clone()], 0x9af0b8, false);
    }
  }
  function mark(view: LimitView, rP: number, rN: number, twist: number): void {
    if (!group.visible) return;
    if (view.kind === 'swing') {
      const T = v3(view.twist!), P = v3(view.plane!), N = v3(view.normal!);
      dot.position.copy(swingDir(rP, rN, T, P, N)).multiplyScalar(R);
      const tp = P.clone().applyAxisAngle(T, twist).multiplyScalar(R * 0.55);
      (twistMark.geometry as THREE.BufferGeometry).setFromPoints([new THREE.Vector3(), tp]);
      twistMark.visible = true;
    } else {
      const A = v3(view.axis!), Nn = v3(view.hingeNormal!);
      dot.position.copy(Nn.clone().applyAxisAngle(A, twist)).multiplyScalar(R);
      twistMark.visible = false;
    }
  }
  function place(pos: THREE.Vector3, parentQuat: THREE.Quaternion): void { group.position.copy(pos); group.quaternion.copy(parentQuat); }

  return { group, set, mark, place };
}
