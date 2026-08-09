/**
 * ГИЗМО ПРЕДЕЛОВ СУСТАВА (поз-редактор) — рисует допустимую зону движения выбранного сустава ПРЯМО на манекене,
 * чтобы крутилки лимитов стали наглядными (как арматура-лимиты в Blender). Конструктивно:
 *  - swing (плечо/бедро/кисть/торс/голова) → полупрозрачный «конус-пирамида» = множество допустимых направлений
 *    кости: |swingPlane| ≤ pCone, |swingNormal| ≤ nCone; + оранжевая дуга диапазона твиста вокруг оси кости;
 *  - hinge (локоть/колено/стопа) → плоский клин (сектор) от min до max в плоскости шарнира.
 * Данные (эффективные углы × групповой множитель) даёт `jointLimitView` из humanoidRagdoll. Геометрия строится в
 * ЛОКАЛЬНОМ фрейме сустава (оси twist/plane/axis в T-позе), а `place()` ставит гизмо в мир-позицию сустава и
 * ориентирует кватернионом РОДИТЕЛЬСКОЙ кости манекена (лимиты заданы относительно родителя).
 */
import * as THREE from 'three';
import type { LimitView } from './humanoidRagdoll.js';

const R = 14;   // визуальный радиус конуса/клина/дуги (u)

export interface LimitGizmo {
  group: THREE.Group;
  set(view: LimitView | null): void;                                   // пересобрать геометрию под лимит
  place(pos: THREE.Vector3, parentQuat: THREE.Quaternion): void;       // поставить на сустав (мир) + ориентация родителя
}

const v3 = (a: readonly number[]): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]).normalize();

export function makeLimitGizmo(): LimitGizmo {
  const group = new THREE.Group(); group.visible = false;
  const geos: THREE.BufferGeometry[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  function clear(): void { for (const g of geos) g.dispose(); geos.length = 0; group.clear(); }

  // Полупрозрачная поверхность «веером» от центра (0,0,0) по направлениям dirs·R. loop=true замыкает (конус swing).
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
  // Яркая линия по точкам pts·R (рёбра/дуга). closed=true — LineLoop.
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
      const pC = view.pCone ?? 0, nC = view.nCone ?? 0, STEP = 40;
      const dirs: THREE.Vector3[] = [];
      for (let i = 0; i < STEP; i++) {                         // обход прямоугольника (swingPlane×swingNormal) по периметру
        const t = (i / STEP) * 4;
        let sP: number, sN: number;
        if (t < 1) { sP = -pC + 2 * pC * t; sN = -nC; }
        else if (t < 2) { sP = pC; sN = -nC + 2 * nC * (t - 1); }
        else if (t < 3) { sP = pC - 2 * pC * (t - 2); sN = nC; }
        else { sP = -pC; sN = nC - 2 * nC * (t - 3); }
        dirs.push(T.clone().applyAxisAngle(P, sP).applyAxisAngle(N, sN));   // направление на границе конуса
      }
      surface(dirs, 0x39a0ff, 0.20, true); line(dirs, 0x8fd0ff, true);      // конус + контур
      line([new THREE.Vector3(0, 0, 0), T], 0xffffff, false);               // ось кости (twist)
      const tmin = view.twistMin ?? 0, tmax = view.twistMax ?? 0;           // дуга диапазона твиста вокруг оси
      if (tmax - tmin > 0.01) {
        const arc: THREE.Vector3[] = [];
        for (let i = 0; i <= 24; i++) arc.push(P.clone().applyAxisAngle(T, tmin + (tmax - tmin) * (i / 24)));
        line(arc, 0xffab40, false, R * 0.55);
      }
    } else {   // hinge: клин-сектор от min до max в плоскости шарнира (ось A, нулевое направление = normal Nn)
      const A = v3(view.axis!), Nn = v3(view.hingeNormal!), lo = view.min ?? 0, hi = view.max ?? 0, STEP = 28;
      const dirs: THREE.Vector3[] = [];
      for (let i = 0; i <= STEP; i++) dirs.push(Nn.clone().applyAxisAngle(A, lo + (hi - lo) * (i / STEP)));
      surface(dirs, 0x46d07a, 0.24, false); line(dirs, 0x9af0b8, false);    // сектор + дуга
      line([new THREE.Vector3(0, 0, 0), dirs[0]!.clone(), new THREE.Vector3(0, 0, 0), dirs[dirs.length - 1]!.clone()], 0x9af0b8, false);   // рёбра к краям
    }
  }
  function place(pos: THREE.Vector3, parentQuat: THREE.Quaternion): void { group.position.copy(pos); group.quaternion.copy(parentQuat); }

  return { group, set, place };
}
