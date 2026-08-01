/**
 * POSE-EDITOR (мини-Каскадёр) — 3-зонный UI (тулбар / вьюпорт / панель-вкладки / таймлайн).
 * IK-риг Cascadeur-стиль: свободный таз + эффекторы кистей/стоп с пинами + планта стоп (footQuat) + per-limb IK/FK.
 * Персонажи (классы игры + ручные пресеты: пропорции/гендер/оружие) · оружие в руках · клипы per персонаж+оружие
 * (localStorage) · undo/redo · плей/скраб таймлайна. Экспорт JSON поз/клипов — аниматор вшивает в игру.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildHumanoid, type Humanoid, type BuildScale } from './humanoid.js';
import { initPhysics, PhysWorld } from './ragdoll.js';
import { makeHumanoidRagdoll, type HumanoidRagdoll, PHYS, LIMITS, MOTOR, loadRagdollConfig, saveRagdollConfig, PIN_SRC, RAG_NAMES, weaponHandMasses, renderRagdollGhost, newGhostGround } from './humanoidRagdoll.js';
import { PoseDriver, GAIT, POSE, type PoseTargets } from './pose.js';
import { gaitToHumanoid as rtGaitToHumanoid, baseWeapon as rtBaseWeapon, measureStancePlants, blendVia, migratePoseName, retargetClipName, type PoseContent } from './poseRuntime.js';
import { WEAPONS, OFFHANDS, attachWeapons } from './weapon3d.js';
import { CLASS_CHARS, MONSTER_CHARS, type Char } from './chars3d.js';
import { savePoseKey } from './poseServer.js';

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const V = (): THREE.Vector3 => new THREE.Vector3();
const Q = (): THREE.Quaternion => new THREE.Quaternion();

const canvas = document.getElementById('app') as HTMLCanvasElement;
const bar = document.getElementById('toolbar')!, panel = document.getElementById('panel')!, timeline = document.getElementById('timeline')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1a1d26);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000); camera.position.set(0, 44, 150);
const orbit = new OrbitControls(camera, canvas); orbit.target.set(0, 34, 0); orbit.enableDamping = true; orbit.dampingFactor = 0.1;
scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x3a3a44, 0.9));
const kl = new THREE.DirectionalLight(0xffffff, 1.6); kl.position.set(60, 120, 90); scene.add(kl);
const flt = new THREE.DirectionalLight(0x9fb0d0, 0.5); flt.position.set(-80, 40, -40); scene.add(flt);
// Непрозрачный ШАХМАТНЫЙ пол — прокручивается при беге (тредмилл), чтобы видеть, скользят ли стопы по земле (как в игре).
const FLOOR_SIZE = 400, FLOOR_TILE = 20;   // мир: одна плитка текстуры = FLOOR_TILE (в ней 2×2 клетки → клетка = 10u)
const checkerTex = ((): THREE.Texture => {
  const cvf = document.createElement('canvas'); cvf.width = cvf.height = 64; const cx = cvf.getContext('2d')!;
  cx.fillStyle = '#2b3142'; cx.fillRect(0, 0, 64, 64); cx.fillStyle = '#232838'; cx.fillRect(0, 0, 32, 32); cx.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(cvf); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(FLOOR_SIZE / FLOOR_TILE, FLOOR_SIZE / FLOOR_TILE); t.magFilter = THREE.NearestFilter; return t;
})();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), new THREE.MeshStandardMaterial({ map: checkerTex, roughness: 0.96, metalness: 0 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
function scrollFloor(): void { checkerTex.offset.set(gaitPx / FLOOR_TILE, -gaitPz / FLOOR_TILE); }   // тредмилл: пол едет под бегущим (V текстуры смотрит в −Z из-за поворота пола → Z со знаком минус)

const gizmo = new TransformControls(camera, canvas); gizmo.setSpace('world'); scene.add(gizmo.getHelper());
gizmo.addEventListener('dragging-changed', (e) => { const dragging = (e as unknown as { value: boolean }).value; orbit.enabled = !dragging; if (!dragging) { if (plantDrag >= 0) { plantDrag = -1; dragMark = null; gizmo.detach(); saveGaitCfg(); } else pushUndo(); } });

let human!: Humanoid;
let mode: 'fk' | 'ik' = 'ik';
let hipsMode: 'translate' | 'rotate' = 'translate';
let bodyFollow = 0.45;

// ── Персонажи (реестр — общий с игрой, chars3d.ts) ──
function loadChars(): Char[] { try { const s = localStorage.getItem('pe_chars'); if (s) return JSON.parse(s) as Char[]; } catch { /* */ } return []; }
let customChars: Char[] = loadChars();
let persona: 'class' | 'monster' = 'class';                     // режим ростера: персонажи (классы) ↔ монстры
const allChars = (): Char[] => [...CLASS_CHARS, ...customChars, ...MONSTER_CHARS];   // для поиска curChar по id
const rosterChars = (): Char[] => persona === 'class' ? [...CLASS_CHARS, ...customChars] : MONSTER_CHARS;   // что показывать в выпадашке
let curCharId = CLASS_CHARS[0]!.id;
const curChar = (): Char => allChars().find((c) => c.id === curCharId) ?? CLASS_CHARS[0]!;
let weapon = curChar().weapon;

// ── Оружие (меши в руках) — общий модуль weapon3d.ts (редактор и игра рисуют одинаково) ──
let weaponGroups: THREE.Group[] = [];
function updateWeapon(): void {
  if (weaponGroups.some((g) => gizmo.object === g)) gizmo.detach();   // не держать гизмо на удаляемом оружии
  for (const g of weaponGroups) { g.parent?.remove(g); g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  weaponGroups = attachWeapons(human, weapon);                        // сборка+хват+базы поворота — в weapon3d
}

// ── FK-подсветка ──
let selected: string | null = null; let selMesh: THREE.Mesh | null = null; let selEmis = 0;
function highlight(m: THREE.Mesh | null): void {
  if (selMesh) (selMesh.material as THREE.MeshStandardMaterial).emissive.setHex(selEmis);
  selMesh = m; if (m) { const mat = m.material as THREE.MeshStandardMaterial; selEmis = mat.emissive.getHex(); mat.emissive.setHex(0x2e6cff); }
}

// ── IK-риг ──
interface Eff { root: string; mid: string; end: string; pole: THREE.Vector3; isFoot: boolean; pin: boolean; ik: boolean; target: THREE.Vector3; prev: THREE.Vector3; footQuat: THREE.Quaternion; handle: THREE.Mesh; poleHandle: THREE.Mesh }
const LIMB_OF: Record<string, string> = { LeftUpperArm: 'LH', LeftLowerArm: 'LH', LeftHand: 'LH', RightUpperArm: 'RH', RightLowerArm: 'RH', RightHand: 'RH', LeftUpperLeg: 'LF', LeftLowerLeg: 'LF', RightUpperLeg: 'RF', RightLowerLeg: 'RF' };
const mkHandle = (color: number, r: number, box = false): THREE.Mesh => { const m = new THREE.Mesh(box ? new THREE.BoxGeometry(r * 1.6, r * 1.6, r * 1.6) : new THREE.SphereGeometry(r, 12, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); m.renderOrder = 999; scene.add(m); return m; };
const rig = {
  hipsPos: V(), hipsQuat: Q(), hipsHandle: mkHandle(0xf0c020, 3.4, true),
  eff: {
    LH: { root: 'LeftUpperArm', mid: 'LeftLowerArm', end: 'LeftHand', pole: new THREE.Vector3(0, -1, -0.4), isFoot: false, pin: false, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x4a8cff, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
    RH: { root: 'RightUpperArm', mid: 'RightLowerArm', end: 'RightHand', pole: new THREE.Vector3(0, -1, -0.4), isFoot: false, pin: false, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x4a8cff, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
    LF: { root: 'LeftUpperLeg', mid: 'LeftLowerLeg', end: 'LeftFoot', pole: new THREE.Vector3(0, 0, 1), isFoot: true, pin: true, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x46d07a, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
    RF: { root: 'RightUpperLeg', mid: 'RightLowerLeg', end: 'RightFoot', pole: new THREE.Vector3(0, 0, 1), isFoot: true, pin: true, ik: true, target: V(), prev: V(), footQuat: Q(), handle: mkHandle(0x46d07a, 2.6), poleHandle: mkHandle(0xff8c3a, 2.0) },
  } as Record<string, Eff>,
};
const effList = (): Eff[] => Object.values(rig.eff);
const _q = Q();
function aimBoneAt(bone: THREE.Object3D, aim: THREE.Vector3, t: THREE.Vector3): void {
  bone.updateMatrixWorld();
  const bp = bone.getWorldPosition(V());
  const pq = bone.parent!.getWorldQuaternion(_q).clone().invert();
  const desired = t.clone().sub(bp).normalize().applyQuaternion(pq);
  bone.quaternion.setFromUnitVectors(aim, desired); bone.updateMatrixWorld();
}
function solve2Bone(rootN: string, midN: string, endN: string, target: THREE.Vector3, pole: THREE.Vector3): void {
  const root = human.bones.get(rootN)!, mid = human.bones.get(midN)!, end = human.bones.get(endN)!;
  const aimRoot = mid.position.clone().normalize(), aimMid = end.position.clone().normalize();
  const L1 = mid.position.length(), L2 = end.position.length();
  root.updateMatrixWorld();
  const rp = root.getWorldPosition(V());
  const toT = target.clone().sub(rp);
  let d = toT.length(); d = clamp(d, Math.abs(L1 - L2) + 0.5, L1 + L2 - 0.5);
  const dir = toT.normalize();
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const bend = V().crossVectors(dir, pole); if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1); else bend.normalize();
  const midPos = rp.clone().addScaledVector(dir.clone().applyAxisAngle(bend, a), L1);
  aimBoneAt(root, aimRoot, midPos); aimBoneAt(mid, aimMid, target.clone());
}
// Восстановить МИРОВУЮ ориентацию конца эффектора (кисть/стопа) после солва: solve2Bone целит плечо/предплечье
// минимальной дугой (`setFromUnitVectors`) → даёт ПРОИЗВОЛЬНУЮ скрутку, и кисть (с оружием) разворачивало. Держим
// захваченную ориентацию (footQuat) — как у стоп. Так drag руки в IK больше не «сбрасывает» углы и не крутит топор.
function setEndOrient(e: Eff): void { const end = human.bones.get(e.end)!; end.updateMatrixWorld(); const pInv = end.parent!.getWorldQuaternion(Q()).invert(); end.quaternion.copy(pInv.multiply(e.footQuat)); end.updateMatrixWorld(); }
// Захватить цель И полюс (направление изгиба локтя/колена) из ТЕКУЩЕЙ позы кости —
// чтобы возврат в IK воспроизводил позу, а не сбрасывал ручную докрутку сустава.
function syncEff(e: Eff): void {
  const root = human.bones.get(e.root)!, mid = human.bones.get(e.mid)!, end = human.bones.get(e.end)!;
  root.updateMatrixWorld(); mid.updateMatrixWorld(); end.updateMatrixWorld();
  const rp = root.getWorldPosition(V()), mp = mid.getWorldPosition(V()), ep = end.getWorldPosition(V());
  e.target.copy(ep); e.prev.copy(ep);
  const dir = ep.clone().sub(rp);
  if (dir.lengthSq() > 1e-6) { const perp = mp.clone().sub(rp).sub(dir.clone().multiplyScalar(mp.clone().sub(rp).dot(dir) / dir.lengthSq())); if (perp.lengthSq() > 1) e.pole.copy(perp.normalize()); }   // прямая рука → полюс не трогаем
  e.footQuat.copy(end.getWorldQuaternion(Q()));   // ориентация КОНЦА (кисть/стопа) — восстановим после солва (иначе IK крутит скрутку)
}
function captureRig(): void {
  const hips = human.bones.get('Hips')!; rig.hipsPos.copy(hips.position); rig.hipsQuat.copy(hips.quaternion);
  human.root.updateMatrixWorld(true);
  for (const e of effList()) syncEff(e);
}
function solveRig(): void {
  const hips = human.bones.get('Hips')!; hips.position.copy(rig.hipsPos); hips.quaternion.copy(rig.hipsQuat); hips.updateMatrixWorld(true);
  for (const e of effList()) { if (e.ik) { solve2Bone(e.root, e.mid, e.end, e.target, e.pole); setEndOrient(e); } else e.target.copy(human.bones.get(e.end)!.getWorldPosition(V())); }
}
function moveHips(delta: THREE.Vector3, except: Eff | null): void { rig.hipsPos.add(delta); for (const e of effList()) if (!e.isFoot && !e.pin && e !== except) e.target.add(delta); }

// ── Пикинг ──
const ray = new THREE.Raycaster(); let activeKey: string | null = null; let activePole: string | null = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (gizmo.dragging) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  if (editPlant && locoOn && locoGait) {                     // режим правки: тянем АВТОРСКИЕ маркеры (плант/обвод), кости не трогаем
    const hit = ray.intersectObjects(authMarks.map((a) => a.mesh), false)[0];
    const am = hit && authMarks.find((a) => a.mesh === hit.object);
    if (am) {
      dragMark = am; plantDrag = 0;
      plantEditDir = plantDirSel; plantEditRun = plantSpeedRun;   // заморозить активную ячейку на время драга
      plantGrab.copy(am.mesh.position);
      const cell = activeCell();
      const base = am.kind === 'plant' ? (am.foot === 0 ? cell.l : cell.r) : (am.foot === 0 ? cell.lVia! : cell.rVia!)[am.k]!;
      plantOff0 = [base[0], base[1]];
      gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(am.mesh);
    }
    return;
  }
  if (mode === 'ik') {
    const list: THREE.Object3D[] = [rig.hipsHandle];
    for (const e of effList()) list.push(e.handle, e.poleHandle);
    const hit = ray.intersectObjects(list, false)[0];
    if (hit) {
      activeKey = null; activePole = null;
      if (hit.object === rig.hipsHandle) { activeKey = 'hips'; gizmo.setSpace('world'); gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); gizmo.attach(rig.hipsHandle); }
      else {
        const endK = Object.keys(rig.eff).find((k) => rig.eff[k]!.handle === hit.object);
        const polK = Object.keys(rig.eff).find((k) => rig.eff[k]!.poleHandle === hit.object);
        if (endK) { const e = rig.eff[endK]!; e.ik = true; syncEff(e); refreshLimbs(); activeKey = endK; gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(e.handle); }
        else if (polK) { const e = rig.eff[polK]!; e.ik = true; syncEff(e); refreshLimbs(); activePole = polK; gizmo.setSpace('world'); gizmo.setMode('translate'); gizmo.attach(e.poleHandle); }
      }
      return;
    }
    gizmo.detach(); activeKey = null; activePole = null; return;
  }
  // FK: кости + меши оружия (оружие — вращение вокруг хвата)
  const meshes: THREE.Mesh[] = [...human.meshes];
  for (const g of weaponGroups) g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const hit = ray.intersectObjects(meshes, false)[0];
  if (hit) {
    const obj = hit.object as THREE.Mesh;
    if (obj.userData.bone) { const nm = obj.userData.bone as string; selected = nm; highlight(obj); gizmo.setSpace('world'); gizmo.setMode('rotate'); gizmo.attach(human.bones.get(nm)!); refreshPose(); }
    else { let g: THREE.Object3D | null = obj; while (g && !(weaponGroups as THREE.Object3D[]).includes(g)) g = g.parent; if (g) { selected = null; highlight(null); gizmo.setSpace('local'); gizmo.setMode('rotate'); gizmo.attach(g); refreshPose(); } }
  }
  else { gizmo.detach(); highlight(null); selected = null; refreshPose(); }
});
gizmo.addEventListener('objectChange', () => {
  if (dragMark) {                                            // тянем авторский маркер (плант/обвод): мировая дельта → body-local (fwd,lat)
    const d = dragMark.mesh.position.clone().sub(plantGrab);
    const s = Math.sin(gaitYaw), c = Math.cos(gaitYaw);
    const cell = activeCell();
    const dst = dragMark.kind === 'plant' ? (dragMark.foot === 0 ? cell.l : cell.r) : (dragMark.foot === 0 ? cell.lVia! : cell.rVia!)[dragMark.k]!;
    dst[0] = plantOff0[0] + (d.x * s + d.z * c);              // fwd вдоль facing
    dst[1] = plantOff0[1] + (d.x * c - d.z * s);              // lat вправо
    return;
  }
  if (mode === 'fk') {
    const nm = (gizmo.object as THREE.Object3D | undefined)?.name;
    if (nm) { const lk = LIMB_OF[nm]; if (lk) { rig.eff[lk]!.ik = false; refreshLimbs(); } if (nm === 'Hips') rig.hipsQuat.copy(human.bones.get('Hips')!.quaternion); const fk = nm === 'LeftFoot' ? 'LF' : nm === 'RightFoot' ? 'RF' : null; if (fk) rig.eff[fk]!.footQuat.copy(human.bones.get(nm)!.getWorldQuaternion(Q())); }
    return;
  }
  if (mode !== 'ik' || (!activeKey && !activePole)) return;
  if (activePole) { const e = rig.eff[activePole]!; const rp = human.bones.get(e.root)!.getWorldPosition(V()); const pv = e.poleHandle.position.clone().sub(rp); if (pv.lengthSq() > 1e-6) e.pole.copy(pv.normalize()); return; }
  if (activeKey === 'hips') { if (hipsMode === 'translate') moveHips(rig.hipsHandle.position.clone().sub(rig.hipsPos), null); else rig.hipsQuat.copy(rig.hipsHandle.quaternion); }
  else { const e = rig.eff[activeKey!]!; const nt = e.handle.position.clone(); if (!e.isFoot && bodyFollow > 0) moveHips(nt.clone().sub(e.prev).multiplyScalar(bodyFollow), e); e.target.copy(nt); e.prev.copy(nt); }
});

// ── Позы / клипы / undo ──
type Pose = Record<string, [number, number, number]>;
interface Keyframe { pose: Pose; t: number }                 // t = сек от начала клипа (кадры отсортированы по t)
interface Clip { name: string; character: string; weapon: string; loop: boolean; keys: Keyframe[] }
const DEF_GAP = 0.3;                                          // дефолт-шаг между кадрами (сек)
function migrateClip(c0: unknown): Clip {                     // старый формат (keys: Pose[]) → кадры с временем
  const c = c0 as Clip & { keys: (Keyframe | Pose)[] };
  const keys: Keyframe[] = (c.keys ?? []).map((k, i) => (k && typeof (k as Keyframe).t === 'number' && (k as Keyframe).pose) ? (k as Keyframe) : ({ pose: k as unknown as Pose, t: i * DEF_GAP }));
  return { name: c.name, character: c.character, weapon: c.weapon, loop: c.loop ?? false, keys };
}
function loadLib(): Clip[] { try { const s = localStorage.getItem('pe_clips'); if (!s) return []; return (JSON.parse(s) as unknown[]).map(migrateClip); } catch { return []; } }
function saveLib(): void { try { localStorage.setItem('pe_clips', JSON.stringify(library)); savePoseKey('pe_clips'); } catch { /* */ } }
let library: Clip[] = loadLib();
let clipBuf: Clip | null = null;      // буфер «копировать позу» — переживает переключение оружия/персонажа (вставка в другое оружие)
let clipBufWasAtk = false;            // был ли исходник в буфере помечен ударом (перенести метку при вставке)
let clipIdx = 0, frameIdx = 0;
const clipsHere = (): Clip[] => library.filter((c) => c.character === curCharId && c.weapon === weapon);
const curClip = (): Clip | null => clipsHere()[clipIdx] ?? null;
const clipDur = (c: Clip): number => c.keys.length ? c.keys[c.keys.length - 1]!.t : 0;
function sortKeys(c: Clip): void { const cur = c.keys[frameIdx]; c.keys.sort((a, b) => a.t - b.t); if (cur) frameIdx = c.keys.indexOf(cur); }
// Поза оружия относительно хвата пишется спец-ключами (не кости): поворот __wpn{Main|Off}, позиция __wpn{Main|Off}P.
const WPN_KEYS = ['__wpnMain', '__wpnOff'];
const WPN_POS = ['__wpnMainP', '__wpnOffP'];
function readPoseFull(): Pose {
  const p = human.readPose();
  delete p['LeftBreast']; delete p['RightBreast'];           // jiggle груди — рантайм, не пишем в позу

  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk) { const e = g.rotation; p[rk] = [+e.x.toFixed(3), +e.y.toFixed(3), +e.z.toFixed(3)]; }
    if (pk) { const q = g.position; p[pk] = [+q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2)]; }
  });
  return p;
}
function applyWeaponPose(p: Pose): void {
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk && p[rk]) g.rotation.set(p[rk]![0], p[rk]![1], p[rk]![2]);
    if (pk && p[pk]) g.position.set(p[pk]![0], p[pk]![1], p[pk]![2]);
  });
}
function applyPose(p: Pose): void { human.reset(); for (const nm in p) { if (nm[0] === '_') continue; const b = human.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); } applyWeaponPose(p); }
function lerpPose(a: Pose, b: Pose, t: number): void {
  human.reset();
  for (const nm of human.boneNames) { const pa = a[nm] ?? [0, 0, 0], pb = b[nm] ?? [0, 0, 0]; human.bones.get(nm)!.rotation.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t); }
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk) { const pa = a[rk], pb = b[rk]; if (pa && pb) g.rotation.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t); else if (pa) g.rotation.set(pa[0], pa[1], pa[2]); }
    if (pk) { const pa = a[pk], pb = b[pk]; if (pa && pb) g.position.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t); else if (pa) g.position.set(pa[0], pa[1], pa[2]); }
  });
}
function mirrorLR(): void { const p = human.readPose(); for (const nm of human.boneNames) { if (!nm.startsWith('Left')) continue; const rb = human.bones.get('Right' + nm.slice(4)); const s = p[nm]!; if (rb) rb.rotation.set(s[0], -s[1], -s[2]); } if (mode === 'ik') captureRig(); }

// ── Локомоция: 2D бленд-дерево (Unity-стиль VelX/VelZ) ──
interface LocoNode { character: string; weapon: string; clip: string; vx: number; vz: number }
function loadLoco(): LocoNode[] { try { const s = localStorage.getItem('pe_loco'); return s ? JSON.parse(s) as LocoNode[] : []; } catch { return []; } }
let locoNodes: LocoNode[] = loadLoco();
function saveLoco(): void { try { localStorage.setItem('pe_loco', JSON.stringify(locoNodes)); savePoseKey('pe_loco'); } catch { /* */ } }
const locoHere = (): LocoNode[] => locoNodes.filter((n) => n.character === curCharId && n.weapon === weapon);
function blendTwo(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const pa = a[k] ?? [0, 0, 0], pb = b[k] ?? [0, 0, 0]; out[k] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]; }
  return out;
}
function clipPoseAt(c: Clip, t01: number): Pose {   // поза клипа на нормализованной фазе 0..1
  const ks = c.keys; if (!ks.length) return {}; if (ks.length < 2) return ks[0]!.pose;
  const dur = clipDur(c) || 1, time = clamp(t01, 0, 1) * dur;
  let i = 0; while (i < ks.length - 2 && ks[i + 1]!.t <= time) i++;
  const a = ks[i]!, b = ks[i + 1]!, span = b.t - a.t;
  return blendTwo(a.pose, b.pose, span > 1e-6 ? clamp((time - a.t) / span, 0, 1) : 0);
}
function locoWeights(nodes: LocoNode[], vx: number, vz: number): number[] {   // веса = обратный квадрат расстояния (норм.)
  const w = nodes.map((n) => 1 / ((n.vx - vx) ** 2 + (n.vz - vz) ** 2 + 0.03));
  const s = w.reduce((a, b) => a + b, 0) || 1; return w.map((x) => x / s);
}
function blendLocoPose(nodes: LocoNode[], weights: number[], phase: number): Pose {   // Σ вес·поза_i(фаза)
  const out: Pose = {};
  nodes.forEach((n, idx) => {
    const wt = weights[idx]!; if (wt < 0.002) return;
    const clip = library.find((c) => c.name === n.clip && c.character === n.character && c.weapon === n.weapon); if (!clip) return;
    const p = clipPoseAt(clip, phase);
    for (const k in p) { const cur = out[k] ?? [0, 0, 0]; out[k] = [cur[0] + p[k]![0] * wt, cur[1] + p[k]![1] * wt, cur[2] + p[k]![2] * wt]; }
  });
  return out;
}
type BoneOv = Record<string, [number, number, number]>;
/** Болванка цикла бега (стартовая, редактируемая): чередование ног/рук + наклон. 5 кадров (0..0.8), луп. */
function makeRunCycle(): Keyframe[] {
  const saved = readPoseFull(); human.reset(); const base = readPoseFull(); applyPose(saved);   // чистая T-база
  const K = (t: number, ov: BoneOv): Keyframe => { const p: Pose = {}; for (const k in base) p[k] = base[k]!.slice() as [number, number, number]; for (const k in ov) p[k] = ov[k]!; return { pose: p, t }; };
  const dL = -1.35, dR = 1.35;   // руки вниз (z)
  const k0: BoneOv = { LeftUpperLeg: [-0.5, 0, 0], LeftLowerLeg: [0.15, 0, 0], RightUpperLeg: [0.35, 0, 0], RightLowerLeg: [0.7, 0, 0], LeftUpperArm: [0.4, 0, dL], RightUpperArm: [-0.5, 0, dR], LeftLowerArm: [0, -0.7, 0], RightLowerArm: [0, 0.7, 0], Spine: [0.15, 0, 0] };
  const k1: BoneOv = { LeftUpperLeg: [0.2, 0, 0], LeftLowerLeg: [0.25, 0, 0], RightUpperLeg: [-0.1, 0, 0], RightLowerLeg: [1.1, 0, 0], LeftUpperArm: [0, 0, dL], RightUpperArm: [0, 0, dR], LeftLowerArm: [0, -0.6, 0], RightLowerArm: [0, 0.6, 0], Spine: [0.15, 0, 0] };
  const mir = (o: BoneOv): BoneOv => { const m: BoneOv = {}; for (const key in o) { const rk = key.startsWith('Left') ? 'Right' + key.slice(4) : key.startsWith('Right') ? 'Left' + key.slice(5) : key; const v = o[key]!; m[rk] = [v[0], -v[1], -v[2]]; } return m; };
  return [K(0, k0), K(0.2, k1), K(0.4, mir(k0)), K(0.6, mir(k1)), K(0.8, k0)];
}

interface State { pose: Pose; hips: { p: [number, number, number]; q: [number, number, number, number] }; eff: Record<string, { t: [number, number, number]; fq: [number, number, number, number]; pl: [number, number, number]; ik: boolean; pin: boolean }> }
function snapshot(): State {
  const eff: State['eff'] = {};
  for (const k in rig.eff) { const e = rig.eff[k]!; eff[k] = { t: e.target.toArray() as [number, number, number], fq: e.footQuat.toArray() as [number, number, number, number], pl: e.pole.toArray() as [number, number, number], ik: e.ik, pin: e.pin }; }
  return { pose: readPoseFull(), hips: { p: rig.hipsPos.toArray() as [number, number, number], q: rig.hipsQuat.toArray() as [number, number, number, number] }, eff };
}
function restore(s: State): void {
  applyPose(s.pose); rig.hipsPos.fromArray(s.hips.p); rig.hipsQuat.fromArray(s.hips.q);
  for (const k in s.eff) { const e = rig.eff[k]; const d = s.eff[k]!; if (e) { e.target.fromArray(d.t); e.footQuat.fromArray(d.fq); if (d.pl) e.pole.fromArray(d.pl); e.ik = d.ik; e.pin = d.pin; } }
  refreshLimbs();
}
let undoStack: State[] = [], redoStack: State[] = [];
function pushUndo(): void { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
function undo(): void { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()!); }
function redo(): void { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()!); }
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); } });

// ── Физ-настройки per-персонаж (pe_phys): вес совпадения рендера с манекеном (RB2) — редактор пишет, игра читает. ──
function loadPhys(id: string): void { try { const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, { match?: number }>; PHYS.match = c[id]?.match ?? 0; } catch { PHYS.match = 0; } }
function savePhysMatch(): void { try { const c = JSON.parse(localStorage.getItem('pe_phys') || '{}') as Record<string, { match?: number }>; (c[curCharId] ??= {}).match = PHYS.match; localStorage.setItem('pe_phys', JSON.stringify(c)); savePoseKey('pe_phys'); } catch { /* */ } }
// ── Вес подмешивания ЩИТА per-(персонаж, оружие) (pe_shield): поза щита наслаивается на позу оружия с этим весом. ──
// Хранилище: { [char]: { mix?: базовый; perWeapon?: {[weaponKey]: number} } }. Старый {char:{mix}} читается как база-фолбэк.
type ShieldCfg = { mix?: number; perWeapon?: Record<string, number> };
let shieldCfgAll: Record<string, ShieldCfg> = {};
function loadShieldMix(_id: string): void { try { shieldCfgAll = JSON.parse(localStorage.getItem('pe_shield') || '{}') as Record<string, ShieldCfg>; } catch { shieldCfgAll = {}; } }
const shieldMixFor = (wk: string): number => { const c = shieldCfgAll[curCharId]; return c?.perWeapon?.[wk] ?? c?.mix ?? 0.85; };   // per-оружие → база → дефолт
function setShieldMix(wk: string, v: number): void { const c = (shieldCfgAll[curCharId] ??= {}); if (wk.endsWith('+shield')) (c.perWeapon ??= {})[wk] = v; else c.mix = v; }   // '+shield'-ключ → per-оружие, иначе база
function saveShield(): void { try { localStorage.setItem('pe_shield', JSON.stringify(shieldCfgAll)); savePoseKey('pe_shield'); } catch { /* */ } }

// ── Персонаж: пересборка ──
function applyChar(id: string): void {
  curCharId = id; const c = curChar(); weapon = c.weapon;
  loadPhys(id);                                               // физ-настройки (match) этого персонажа
  loadShieldMix(id);                                          // вес подмешивания щита этого персонажа
  applyGaitCfg(id);                                            // свой настроенный бег у каждого персонажа
  if (human) { scene.remove(human.root); human.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  gizmo.detach(); selMesh = null; selected = null; activeKey = null; weaponGroups = [];
  human = buildHumanoid({ gender: c.gender, build: c.build });
  scene.add(human.root); human.root.visible = showKin; updateWeapon(); captureRig();
  if (pw) buildGhost();                                       // призрак под новые пропорции
  disposeOnion();                                             // онион-призраки пересоберутся под новые пропорции
  clipIdx = 0; frameIdx = 0; undoStack = []; redoStack = [];
  syncAllAttackEnds();                                        // концы ударов этого персонажа = его стойки
  refreshAll();
}
function setWeapon(w: string): void { weapon = w; updateWeapon(); clipIdx = 0; frameIdx = 0; refreshAll(); }
const splitWeapon = (w: string): [string, string] => { if (w === 'dual') w = 'sword+dagger'; const i = w.lastIndexOf('+'); return i > 0 ? [w.slice(0, i), w.slice(i + 1)] : [w, 'none']; };   // 'main+off' → [main, off]

// ══ UI ══
const mkBtn = (label: string, fn: () => void, cls = 'tbtn'): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = fn; return b; };
const sep = (): HTMLElement => { const s = document.createElement('div'); s.className = 'tb-sep'; return s; };

// ── Тулбар ──
const charSel = document.createElement('select'); charSel.onchange = () => applyChar(charSel.value);
const wpnSel = document.createElement('select');
for (const w of WEAPONS) { const o = document.createElement('option'); o.value = w; o.textContent = w; wpnSel.append(o); }
const offSel = document.createElement('select');   // офф-рука: нет / щит / второе оружие → ключ main+off
for (const o of OFFHANDS) { const op = document.createElement('option'); op.value = o; op.textContent = o === 'none' ? '—' : o; offSel.append(op); }
const composeWeapon = (): void => { const m = wpnSel.value, o = offSel.value; setWeapon(o === 'none' ? m : m + '+' + o); };
wpnSel.onchange = composeWeapon; offSel.onchange = composeWeapon;
let fkB!: HTMLButtonElement, ikB!: HTMLButtonElement, hipsB!: HTMLButtonElement;
function setMode(m: 'fk' | 'ik'): void { mode = m; gizmo.detach(); highlight(null); selected = null; activeKey = null; activePole = null; for (const e of effList()) { e.handle.visible = m === 'ik'; e.poleHandle.visible = m === 'ik'; } rig.hipsHandle.visible = m === 'ik'; if (m === 'ik') captureRig(); fkB.classList.toggle('on', m === 'fk'); ikB.classList.toggle('on', m === 'ik'); refreshPose(); }
ikB = mkBtn('IK', () => setMode('ik')); fkB = mkBtn('FK', () => setMode('fk'));
hipsB = mkBtn('таз: двигать', () => { hipsMode = hipsMode === 'translate' ? 'rotate' : 'translate'; hipsB.textContent = 'таз: ' + (hipsMode === 'translate' ? 'двигать' : 'вращать'); if (activeKey === 'hips') { gizmo.setMode(hipsMode); if (hipsMode === 'rotate') rig.hipsHandle.quaternion.copy(rig.hipsQuat); } });
const physB = mkBtn('физ: выкл', () => { void ensurePhysics().then(() => { physOn = !physOn; physB.textContent = 'физ: ' + (physOn ? 'вкл' : 'выкл'); physB.classList.toggle('on', physOn); setPhysVis(physOn); }); });
const manB = mkBtn('манекен: вкл', () => { showKin = !showKin; human.root.visible = showKin; manB.textContent = 'манекен: ' + (showKin ? 'вкл' : 'выкл'); manB.classList.toggle('on', !showKin); });
// Тумблер ростера: персонажи (классы) ↔ монстры. Переключает список выбора персонажа и грузит первого из ростера.
let personaB!: HTMLButtonElement;
personaB = mkBtn('◧ персонажи', () => {
  persona = persona === 'class' ? 'monster' : 'class';
  personaB.textContent = persona === 'class' ? '◧ персонажи' : '◧ монстры';
  personaB.classList.toggle('on', persona === 'monster');
  const first = rosterChars()[0];
  if (first) applyChar(first.id); else refreshAll();
});
bar.append(personaB, document.createTextNode('Персонаж'), charSel, document.createTextNode('Оружие'), wpnSel, document.createTextNode('офф'), offSel, sep(), ikB, fkB, hipsB, sep(),
  mkBtn('зеркало L→R', () => { pushUndo(); mirrorLR(); }), mkBtn('T-поза', () => { pushUndo(); human.reset(); if (mode === 'ik') captureRig(); }), sep(),
  mkBtn('↶ undo', () => undo()), mkBtn('↷ redo', () => redo()), sep(), physB, manB);

// ── Панель-вкладки (Анимация = клипы+кадры+поза; Бег = 2D бленд локомоции; Персонаж = setup) ──
let tab: 'anim' | 'loco' | 'char' = 'anim';
const tabBar = document.createElement('div'); tabBar.style.cssText = 'display:flex;gap:3px;margin-bottom:6px';
const body = document.createElement('div');
panel.append(tabBar, body);
const el = (t: string, css: string): HTMLElement => { const e = document.createElement(t); e.style.cssText = css; return e; };
const pbtn = (label: string, fn: () => void, on = false): HTMLButtonElement => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = `margin:2px 3px 2px 0;padding:3px 7px;background:${on ? '#3a5030' : '#2a3350'};color:#cfd3e0;border:1px solid #4a5680;border-radius:4px;cursor:pointer;font:11px monospace`; b.onclick = fn; return b; };
for (const [k, lbl] of [['anim', 'Анимация'], ['loco', 'Бег'], ['char', 'Персонаж']] as const) { const b = document.createElement('button'); b.textContent = lbl; b.style.cssText = 'flex:1;padding:4px;background:#20242f;color:#cfd3e0;border:1px solid #39415a;border-radius:4px;cursor:pointer;font:11px monospace'; b.onclick = () => { tab = k; refreshAll(); }; b.dataset.tab = k; tabBar.append(b); }

function refreshAll(): void { for (const b of Array.from(tabBar.children) as HTMLButtonElement[]) b.style.background = b.dataset.tab === tab ? '#3a5030' : '#20242f'; charSel.innerHTML = ''; for (const c of rosterChars()) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; o.selected = c.id === curCharId; charSel.append(o); } { const [wm, wo] = splitWeapon(weapon); wpnSel.value = wm; offSel.value = wo; } if (tab === 'anim') renderAnim(); else if (tab === 'loco') renderLoco(); else renderChar(); refreshTimeline(); updateOnion(); }
function refreshPose(): void { if (tab === 'anim') renderAnim(); }
function refreshLimbs(): void { if (tab === 'anim') renderAnim(); }

// Инструменты позы (аппендятся в общую панель «Анимация»; правка позы = правка текущего кадра)
const limbLabels: Record<string, string> = { LH: 'рука Л', RH: 'рука П', LF: 'нога Л', RF: 'нога П' };
function poseTools(): void {
  const info = el('div', 'color:#9ae6a0;margin:10px 0 4px;border-top:1px solid #39415a;padding-top:8px'); info.textContent = mode === 'ik' ? 'IK: таз/кисти/стопы + оранж. локти/колени' : (selected ? 'выбрано: ' + selected : 'FK: клик по кости или оружию'); body.append(info);
  const lh = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px'); lh.textContent = 'КОНЕЧНОСТИ IK/FK'; body.append(lh);
  const lr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(lr);
  for (const k of ['LH', 'RH', 'LF', 'RF']) { const e = rig.eff[k]!; lr.append(pbtn(`${limbLabels[k]}: ${e.ik ? 'IK' : 'FK'}`, () => { e.ik = !e.ik; if (e.ik) syncEff(e); renderAnim(); }, e.ik)); }
  const ph = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ph.textContent = 'ПИНЫ'; body.append(ph);
  const pr = el('div', 'display:flex;flex-wrap:wrap;gap:6px'); body.append(pr);
  for (const [k, lb] of [['LH', 'кисть Л'], ['RH', 'кисть П'], ['LF', 'стопа Л'], ['RF', 'стопа П']] as const) { const lab = el('label', 'font-size:11px'); const cb = el('input', '') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = rig.eff[k]!.pin; cb.onchange = () => { rig.eff[k]!.pin = cb.checked; }; lab.append(cb, document.createTextNode(lb)); pr.append(lab); }
  const rh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rh.textContent = 'REACH (тело за рукой)'; body.append(rh);
  const bf = el('input', 'width:100%') as HTMLInputElement; bf.type = 'range'; bf.min = '0'; bf.max = '1'; bf.step = '0.05'; bf.value = String(bodyFollow); bf.oninput = () => { bodyFollow = parseFloat(bf.value); }; body.append(bf);
  if (weaponGroups.length) {
    const wh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); wh.textContent = 'ОРУЖИЕ · ⟳ вращать / ✥ двигать (в кадр)'; body.append(wh);
    const wr = el('div', 'display:flex;flex-wrap:wrap;gap:3px'); body.append(wr);
    const wlbl = ['осн', 'офф'];
    const pickWeapon = (g: THREE.Object3D, m: 'rotate' | 'translate'): void => { setMode('fk'); selected = null; highlight(null); gizmo.setSpace('local'); gizmo.setMode(m); gizmo.attach(g); };
    weaponGroups.forEach((g, i) => { const nm = wlbl[i] ?? ('о' + (i + 1)); wr.append(pbtn(nm + ' ⟳', () => pickWeapon(g, 'rotate')), pbtn(nm + ' ✥', () => pickWeapon(g, 'translate'))); });
    wr.append(pbtn('сброс', () => { updateWeapon(); renderAnim(); }));   // пересборка = базовые позиция/поворот
  }
  // ── ФИЗИКА (PuppetMaster-стиль: пины/мышцы + дёрг/падение) ──
  const phh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); phh.textContent = 'ФИЗИКА (мышцы/пины)'; body.append(phh);
  const phRow = (label: string, key: 'pin' | 'pinKp' | 'muscle' | 'load' | 'match', min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
    const s = el('input', 'width:100px') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(PHYS[key]);
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = String(PHYS[key]);
    s.oninput = () => { PHYS[key] = parseFloat(s.value); v.textContent = s.value; if (key === 'match') savePhysMatch(); };
    row.append(s, v); body.append(row);
  };
  phRow('пины (сила)', 'pin', 0, 1, 0.05); phRow('пин · жёсткость', 'pinKp', 0, 12000, 200); phRow('мышцы (ведение)', 'muscle', 0, 1, 0.05); phRow('вес оружия', 'load', 0, 3, 0.1);
  phRow('★ совпадение с манекеном', 'match', 0, 1, 0.05);   // RB2: 0 = физика, 1 = ровно твоя поза (бленд рендера)
  // ── ЛИМИТЫ/МОТОРЫ суставов (RB3): множитель конусов/диапазонов + сила моторов. Применяется ПЕРЕСБОРКОЙ куклы на отпускание. ──
  const rgh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); rgh.textContent = 'ЛИМИТЫ/МОТОРЫ (пересборка)'; body.append(rgh);
  const ragRow = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
    const s = el('input', 'width:100px') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(get());
    const v = el('span', 'width:44px;text-align:right;color:#9ae6a0'); v.textContent = String(get());
    s.oninput = () => { v.textContent = s.value; };
    s.onchange = () => { set(parseFloat(s.value)); saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); };   // пересборка на отпускание
    row.append(s, v); body.append(row);
  };
  ragRow('лимит: рука ×', () => LIMITS.arm, (v) => { LIMITS.arm = v; }, 0.4, 2.5, 0.05);
  ragRow('лимит: нога ×', () => LIMITS.leg, (v) => { LIMITS.leg = v; }, 0.4, 2.5, 0.05);
  ragRow('лимит: торс ×', () => LIMITS.core, (v) => { LIMITS.core = v; }, 0.4, 2.5, 0.05);
  ragRow('лимит: голова ×', () => LIMITS.head, (v) => { LIMITS.head = v; }, 0.4, 2.5, 0.05);
  ragRow('мотор рука · сила', () => MOTOR.arm[1], (v) => { MOTOR.arm[1] = v; }, 1e6, 2e7, 5e5);
  ragRow('мотор нога · сила', () => MOTOR.leg[1], (v) => { MOTOR.leg[1] = v; }, 1e6, 2e7, 5e5);
  ragRow('мотор торс · сила', () => MOTOR.core[1], (v) => { MOTOR.core[1] = v; }, 5e5, 1e7, 5e5);
  body.append(pbtn('сброс лимитов/моторов', () => { LIMITS.arm = LIMITS.leg = LIMITS.core = LIMITS.head = 1; MOTOR.leg = [20, 6e6]; MOTOR.arm = [20, 6e6]; MOTOR.core = [15, 3e6]; MOTOR.head = [13, 2e5]; saveRagdollConfig(); savePoseKey('pe_ragdoll'); if (ragdoll) rebuildRagdoll(); renderAnim(); }));
  const phb = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:4px'); body.append(phb);
  phb.append(
    pbtn('физ вкл/выкл', () => { void ensurePhysics().then(() => { physOn = !physOn; setPhysVis(physOn); }); }, physOn),
    pbtn('дёрг (удар)', () => { void ensurePhysics().then(() => { physOn = true; setPhysVis(true); if (ragdoll) { ragdoll.hit('Torso', 0, 0.3, 1, 1.4); ragdoll.hit('Head', 0, 0.3, 1, 0.8); } }); }),
    pbtn(physDead ? 'встать' : 'упасть', () => { void ensurePhysics().then(() => { physOn = true; setPhysVis(true); if (!ragdoll) return; if (physDead) { const h = ragdoll.bodyPos('Hips'); reviveFrom.set(h[0], h[1], h[2]); reviveT = 0; ragdoll.setDead(false); physDead = false; } else { ragdoll.setDead(true); physDead = true; reviveT = -1; } renderAnim(); }); }, physDead),
  );
  const bh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); bh.textContent = 'FK · выбрать кость'; body.append(bh);
  const bl = el('div', 'display:flex;flex-wrap:wrap;gap:2px;max-height:150px;overflow:auto'); body.append(bl);
  for (const nm of human.boneNames) { const b = document.createElement('button'); b.textContent = nm; b.style.cssText = `font-size:10px;padding:1px 4px;border-radius:3px;cursor:pointer;border:1px solid #39415a;background:${nm === selected ? '#3a5030' : '#20242f'};color:#b8bec8`; b.onclick = () => { setMode('fk'); selected = nm; highlight(human.meshes.find((x) => x.userData.bone === nm) ?? null); gizmo.setMode('rotate'); gizmo.attach(human.bones.get(nm)!); renderAnim(); }; bl.append(b); }
}

// Вкладка АНИМАЦИЯ = клипы + кадры(с временем) + инструменты позы (правишь позу = правишь текущий кадр)
function delClip(cl: Clip): void {   // удалить позу/анимацию из библиотеки (+ снять пометку удара, если была)
  const idx = library.indexOf(cl); if (idx < 0) return;
  library.splice(idx, 1);
  const am = atkCfgs[cl.character]?.[cl.weapon]; if (am) { const j = am.indexOf(cl.name); if (j >= 0) { am.splice(j, 1); saveAtk(); } }
  clipIdx = 0; frameIdx = 0; saveLib(); refreshAll();
}
function renderAnim(): void { body.innerHTML = ''; clipSection(); poseTools(); }
function clipSection(): void {
  const list = clipsHere();
  const info = el('div', 'color:#9ae6a0;margin-bottom:4px'); info.textContent = `${curChar().name} · ${weapon} · клипов: ${list.length}`; body.append(info);
  const row1 = el('div', ''); body.append(row1);
  const nameFree = (nm: string): string => { let n = nm, i = 2; while (library.some((x) => x.name === n && x.character === curCharId && x.weapon === weapon)) n = nm + '_' + i++; return n; };
  // Вставить позу из буфера в ТЕКУЩЕЕ оружие: глубокий клон кадров + ретаргет имени (idle_меч→idle_топор). Игра подхватит.
  const pasteHere = (): void => {
    if (!clipBuf) return;
    let name = retargetClipName(clipBuf.name, clipBuf.weapon, weapon);
    const taken = (nm: string): boolean => library.some((x) => x.name === nm && x.character === curCharId && x.weapon === weapon);
    if (clipBuf.weapon === weapon) name = nameFree(name);                                   // то же оружие = дубликат → не затирать
    else if (taken(name) && !confirm('Клип «' + name + '» на «' + weapon + '» уже есть — перезаписать?')) return;
    const nc: Clip = { name, character: curCharId, weapon, loop: clipBuf.loop, keys: clipBuf.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) };
    const i = library.findIndex((x) => x.name === name && x.character === curCharId && x.weapon === weapon);
    if (i >= 0) library[i] = nc; else library.push(nc);
    if (clipBufWasAtk) { const arr = ((atkCfgs[curCharId] ??= {})[weapon] ??= []); if (!arr.includes(name)) { arr.push(name); saveAtk(); } }
    saveLib(); clipIdx = Math.max(0, clipsHere().findIndex((x) => x.name === name)); frameIdx = 0; refreshAll();
  };
  row1.append(pbtn('+ новый', () => { const nm = prompt('имя клипа (действие)', 'clip' + (list.length + 1)); if (!nm) return; library.push({ name: nameFree(nm), character: curCharId, weapon, loop: false, keys: [{ pose: readPoseFull(), t: 0 }] }); clipIdx = list.length; frameIdx = 0; saveLib(); refreshAll(); }));
  if (clipBuf) row1.append(pbtn('⎘ вставить: ' + retargetClipName(clipBuf.name, clipBuf.weapon, weapon), pasteHere));   // буфер переживает смену оружия/персонажа
  const c = curClip();
  if (c) {
    row1.append(
      pbtn('⎘ копир', () => { clipBuf = { name: c.name, character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }; clipBufWasAtk = atkList().includes(c.name); refreshAll(); }),
      pbtn('дубл', () => { library.push({ name: nameFree(c.name + '_copy'), character: curCharId, weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) }); saveLib(); refreshAll(); }),
      pbtn('переим', () => {
        const nm = prompt('имя клипа', c.name); if (!nm || nm === c.name) return;
        if (library.some((x) => x !== c && x.name === nm && x.character === curCharId && x.weapon === weapon)) { alert('Клип «' + nm + '» на этом оружии уже есть — выберите другое имя.'); return; }
        const wasConv = ['idle_', 'hit_', 's_hit_'].some((p) => c.name === p + weapon), stillConv = ['idle_', 'hit_', 's_hit_'].some((p) => nm === p + weapon);
        if (wasConv && !stillConv && !confirm('«' + c.name + '» — конвенционное имя, игра ищет позу по нему. Переименование отвяжет её от оружия. Продолжить?')) return;
        const old = c.name; c.name = nm; const arr = atkCfgs[curCharId]?.[weapon]; if (arr) { const j = arr.indexOf(old); if (j >= 0) { arr[j] = nm; saveAtk(); } }
        saveLib(); refreshAll();
      }),
      pbtn('удалить', () => { if (confirm('Удалить клип «' + c.name + '»?')) delClip(c); }),
      pbtn(c.loop ? '↻ луп' : '→ 1 раз', () => { c.loop = !c.loop; saveLib(); refreshAll(); }, c.loop),
      pbtn('⚙ запечь физику', () => { void bakeCurrentClip(); }),
    );
  }
  const selr = el('div', 'display:flex;flex-wrap:wrap;gap:3px;margin-top:5px'); body.append(selr);
  list.forEach((cl, i) => {   // клип = кнопка выбора + ✗ удалить (любую позу/анимацию прямо из списка)
    const grp = el('div', 'display:inline-flex;align-items:center');
    grp.append(pbtn(cl.name, () => { clipIdx = i; frameIdx = 0; goFrame(0); }, i === clipIdx));
    grp.append(pbtn('✗', () => { if (confirm('Удалить «' + cl.name + '»?')) delClip(cl); }));
    selr.append(grp);
  });
  if (!list.length) { const e = el('div', 'color:#d0a060;font-size:11px'); e.textContent = 'Нет клипов для этого оружия. «+ новый» создаёт из текущей позы.'; body.append(e); }
  if (c) {
    const isAtk = isAttackClip(c); const lastI = c.keys.length - 1;
    const isEnd = (i: number): boolean => isAtk && (i === 0 || i === lastI);
    const fh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); fh.textContent = `КАДРЫ (${c.keys.length}) · длит. ${clipDur(c).toFixed(2)}с` + (isAtk ? ' · удар: 🔒кадры 1/' + (lastI + 1) + ' из стойки' : ''); body.append(fh);
    const fr = el('div', 'display:flex;flex-wrap:wrap;gap:2px'); body.append(fr);
    c.keys.forEach((kf, i) => fr.append(pbtn(`${isEnd(i) ? '🔒' : ''}${i + 1}·${kf.t.toFixed(2)}`, () => goFrame(i), i === frameIdx)));
    const kf = c.keys[frameIdx];
    if (kf) {
      const tr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); tr.innerHTML = '<span style="flex:1">время кадра (с)</span>';
      const ti = el('input', 'width:70px') as HTMLInputElement; ti.type = 'number'; ti.min = '0'; ti.step = '0.05'; ti.value = kf.t.toFixed(2);
      ti.onchange = () => { kf.t = Math.max(0, parseFloat(ti.value) || 0); sortKeys(c); saveLib(); refreshAll(); };
      tr.append(ti); body.append(tr);
    }
    const act = el('div', 'margin-top:5px'); body.append(act);
    const atEnd = isEnd(frameIdx);
    act.append(
      atEnd
        ? pbtn('🔒 кадр из стойки', () => { alert('Крайние кадры удара — это idle-стойка, они не редактируются тут. Правь стойку: таб «Бег» → «захватить стойку», концы удара подхватят.'); })
        : pbtn('◉ записать кадр', () => { pushUndo(); if (c.keys[frameIdx]) c.keys[frameIdx]!.pose = readPoseFull(); saveLib(); }),
      pbtn('+ кадр', () => { const insAt = isAtk ? Math.max(1, Math.min(frameIdx + 1, lastI)) : frameIdx + 1; const a = c.keys[insAt - 1], b = c.keys[insAt]; const nt = (a && b) ? (a.t + b.t) / 2 : (a ? a.t + DEF_GAP : 0); c.keys.splice(insAt, 0, { pose: readPoseFull(), t: nt }); frameIdx = insAt; saveLib(); refreshAll(); }),   // у удара — только в середину
      pbtn('− кадр', () => { if (!atEnd && c.keys.length > (isAtk ? 3 : 1)) { c.keys.splice(frameIdx, 1); frameIdx = Math.min(frameIdx, c.keys.length - 1); saveLib(); refreshAll(); } }),   // концы удара не удалить
    );
    // подтянуть позу в текущий кадр из соседнего (строить замах/удар от концов-idle, потом править)
    if (!atEnd) {
      const pr2 = el('div', 'margin-top:3px'); body.append(pr2);
      const pull = (get: () => Pose): void => { pushUndo(); const kk = c.keys[frameIdx]; if (kk) { kk.pose = get(); saveLib(); goFrame(frameIdx); } };
      if (frameIdx > 0) pr2.append(pbtn('◀ из пред.', () => pull(() => clonePose(c.keys[frameIdx - 1]!.pose))));
      if (frameIdx < lastI) pr2.append(pbtn('из след. ▶', () => pull(() => clonePose(c.keys[frameIdx + 1]!.pose))));
      if (frameIdx > 0 && frameIdx < lastI) pr2.append(pbtn('⇄ середина (пред+след)', () => pull(() => blendTwo(c.keys[frameIdx - 1]!.pose, c.keys[frameIdx + 1]!.pose, 0.5))));
    }
    body.append(pbtn('🧅 призраки соседних кадров', () => { onionOn = !onionOn; refreshAll(); }, onionOn));
  }
  const eh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); eh.textContent = 'ЭКСПОРТ / ИМПОРТ'; body.append(eh);
  const ta = el('textarea', 'width:100%;height:70px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:4px;font:10px monospace') as HTMLTextAreaElement; body.append(ta);
  const er = el('div', ''); body.append(er);
  er.append(pbtn('клип', () => { if (c) ta.value = JSON.stringify(c); }), pbtn('всё', () => { ta.value = JSON.stringify(library); }), pbtn('копир', () => navigator.clipboard?.writeText(ta.value)), pbtn('импорт', () => { try { const d = JSON.parse(ta.value); const arr = Array.isArray(d) ? d : [d]; const cl = arr.map(migrateClip); if (Array.isArray(d)) library = cl; else library.push(...cl); saveLib(); refreshAll(); } catch { /* */ } }));
}

// Сохранение внешности персонажа: конфиг-персонаж/фракция (builtin) → серверный pe_appearance (ростер-СПИСОК остаётся
// из конфига, тут лишь пол/телосложение/оружие); свой персонаж → pe_chars. Оба уходят на сервер (единая истина).
function loadAppearanceRaw(): Record<string, unknown> { try { return (JSON.parse(localStorage.getItem('pe_appearance') || '{}') as Record<string, unknown>) || {}; } catch { return {}; } }
function saveCharEdit(c: Char): void {
  if (c.builtin) {
    const ap = loadAppearanceRaw();
    ap[c.id] = { gender: c.gender, build: c.build, weapon: c.weapon };
    localStorage.setItem('pe_appearance', JSON.stringify(ap)); savePoseKey('pe_appearance');
  } else {
    localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars');
  }
}

// Вкладка ПЕРСОНАЖ
function renderChar(): void {
  body.innerHTML = '';
  const c = curChar();
  const info = el('div', 'color:#9ae6a0;margin-bottom:6px'); info.textContent = `${c.name}${c.builtin ? ' (из конфига)' : ' (свой)'} · ${c.gender} · ${c.weapon}`; body.append(info);
  const sl = (label: string, key: keyof BuildScale): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px'); row.innerHTML = `<span style="flex:1">${label}</span>`;
    const s = el('input', 'width:110px') as HTMLInputElement; s.type = 'range'; s.min = '0.6'; s.max = '1.4'; s.step = '0.02'; s.value = String(c.build[key] ?? 1);
    const v = el('span', 'width:36px;text-align:right;color:#9ae6a0'); v.textContent = String(c.build[key] ?? 1);
    s.oninput = () => { c.build[key] = parseFloat(s.value); v.textContent = s.value; applyChar(c.id); tab = 'char'; refreshAll(); };
    s.onchange = () => saveCharEdit(c);   // персист внешности на отпускание (без спама сервера на каждый пиксель)
    row.append(s, v); body.append(row);
  };
  const th = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 2px'); th.textContent = 'ТЕЛОСЛОЖЕНИЕ'; body.append(th);
  sl('руки', 'arm'); sl('ноги', 'leg'); sl('торс', 'torso'); sl('голова', 'head');
  const gh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); gh.textContent = 'ПОЛ'; body.append(gh);
  body.append(pbtn('male', () => { c.gender = 'male'; saveCharEdit(c); applyChar(c.id); tab = 'char'; refreshAll(); }, c.gender === 'male'), pbtn('female', () => { c.gender = 'female'; saveCharEdit(c); applyChar(c.id); tab = 'char'; refreshAll(); }, c.gender === 'female'));
  const wh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); wh.textContent = 'ОРУЖИЕ ПО УМОЛЧАНИЮ'; body.append(wh);
  const wsel = el('select', 'margin:2px 0') as HTMLSelectElement;
  const wopts = WEAPONS.includes(c.weapon) ? WEAPONS : [c.weapon, ...WEAPONS];   // combo-дефолт (напр. sword+shield) сохраняем опцией
  for (const w of wopts) { const o = document.createElement('option'); o.value = w; o.textContent = w; if (w === c.weapon) o.selected = true; wsel.append(o); }
  wsel.onchange = () => { c.weapon = wsel.value; saveCharEdit(c); setWeapon(c.weapon); tab = 'char'; refreshAll(); };   // дефолт-оружие класса/фракции (игра берёт его)
  body.append(wsel);
  // Подмешивание ЩИТА per-оружие: при выбранной офф-руке «щит» вес хранится под ключом main+shield; иначе редактируется база.
  const isShieldKey = weapon.endsWith('+shield');
  const sh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); sh.textContent = 'ПОДМЕШИВАНИЕ ЩИТА' + (isShieldKey ? ' — ' + weapon : ' (база)'); body.append(sh);
  const shRow = el('label', 'display:flex;align-items:center;gap:6px'); shRow.innerHTML = '<span style="flex:1">вес (поза щита → рука+корпус)</span>';
  const shs = el('input', 'width:110px') as HTMLInputElement; shs.type = 'range'; shs.min = '0'; shs.max = '1'; shs.step = '0.05'; shs.value = String(shieldMixFor(weapon));
  const shv = el('span', 'width:36px;text-align:right;color:#9ae6a0'); shv.textContent = shieldMixFor(weapon).toFixed(2);
  shs.oninput = () => { setShieldMix(weapon, parseFloat(shs.value)); shv.textContent = parseFloat(shs.value).toFixed(2); };   // превью бега с '+shield'-оружием читает живьём
  shs.onchange = () => saveShield();
  shRow.append(shs, shv); body.append(shRow);
  const shHint = el('div', 'color:#8f897c;font-size:10px;margin-top:2px'); shHint.textContent = isShieldKey
    ? 'позу щита дотюнь для ЭТОГО оружия: авторь клип «idle_' + weapon + '» (иначе берётся базовая «idle_shield»).'
    : 'база: авторь «idle_shield» (оружие «shield» → левая рука → «захватить стойку»). Для тюна под оружие выбери офф-руку «щит».'; body.append(shHint);
  const ah = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px'); ah.textContent = 'СВОИ ПЕРСОНАЖИ'; body.append(ah);
  body.append(pbtn('+ создать из текущего', () => { const nm = prompt('имя персонажа', 'char' + (customChars.length + 1)); if (!nm) return; const id = 'c' + Date.now(); customChars.push({ id, name: nm, gender: c.gender, build: { ...c.build }, weapon }); localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars'); applyChar(id); }));
  if (!c.builtin) body.append(pbtn('удалить персонажа', () => { customChars = customChars.filter((x) => x.id !== c.id); localStorage.setItem('pe_chars', JSON.stringify(customChars)); savePoseKey('pe_chars'); applyChar(CLASS_CHARS[0]!.id); }));
}

// Вкладка БЕГ — 2D бленд-дерево локомоции (Unity-стиль): узлы-клипы на VelX/VelZ, красная точка-семпл, превью на месте
const PAD = 240, PADM = 24;
const velToPad = (vx: number, vz: number): [number, number] => [PAD / 2 + vx * (PAD / 2 - PADM), PAD / 2 - vz * (PAD / 2 - PADM)];
const padToVel = (px: number, py: number): [number, number] => [clamp((px - PAD / 2) / (PAD / 2 - PADM), -1, 1), clamp(-(py - PAD / 2) / (PAD / 2 - PADM), -1, 1)];
function drawPad(cv: HTMLCanvasElement): void {
  const ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, PAD, PAD); ctx.fillStyle = '#181b24'; ctx.fillRect(0, 0, PAD, PAD);
  ctx.strokeStyle = '#2a3040'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const p = PADM + i * (PAD - 2 * PADM) / 4; ctx.beginPath(); ctx.moveTo(p, PADM); ctx.lineTo(p, PAD - PADM); ctx.moveTo(PADM, p); ctx.lineTo(PAD - PADM, p); ctx.stroke(); }
  ctx.strokeStyle = '#3a4258'; ctx.beginPath(); ctx.moveTo(PAD / 2, PADM); ctx.lineTo(PAD / 2, PAD - PADM); ctx.moveTo(PADM, PAD / 2); ctx.lineTo(PAD - PADM, PAD / 2); ctx.stroke();
  ctx.fillStyle = '#5a6478'; ctx.font = '9px monospace'; ctx.fillText('вперёд', PAD / 2 + 3, PADM + 9); ctx.fillText('назад', PAD / 2 + 3, PAD - PADM - 3); ctx.fillText('П', PAD - PADM - 8, PAD / 2 - 3); ctx.fillText('Л', PADM + 2, PAD / 2 - 3);
  if (editPlant) {   // 16 точек-ячеек плантов: внешнее кольцо (mag .95) = БЕГ, внутреннее (.34) = ХОДЬБА; активная подсвечена
    for (const run of [false, true]) for (let i = 0; i < 8; i++) {
      const th = i * DIR_STEP, mag = run ? 0.95 : 0.34; const [px, py] = velToPad(Math.sin(th) * mag, Math.cos(th) * mag);
      const on = i === plantDirSel && run === plantSpeedRun;
      ctx.beginPath(); ctx.arc(px, py, on ? 6 : 4, 0, 7); ctx.fillStyle = on ? '#ffd24a' : run ? '#46d07a' : '#357a52'; ctx.fill();
      if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
  const [sx, sy] = velToPad(locoVx, locoVz); ctx.fillStyle = '#ff5a4a'; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();   // красная точка = вектор скорости/направление
}
function renderLoco(): void {
  body.innerHTML = '';
  const info = el('div', 'color:#9ae6a0;margin-bottom:4px'); info.textContent = `${curChar().name} · ${weapon} · бег = idle-стойка + физпокачивание + физ-ноги`; body.append(info);
  const cv = document.createElement('canvas'); cv.width = PAD; cv.height = PAD; cv.style.cssText = 'width:100%;max-width:250px;display:block;border:1px solid #39415a;border-radius:6px;touch-action:none;cursor:crosshair'; body.append(cv);
  const redraw = (): void => drawPad(cv); redraw();
  // Выбор ЯЧЕЙКИ планта = клик по одной из 16 точек на квадрате (8 внешних = бег, 8 внутренних = ходьба).
  const goDir = (i: number, run: boolean): void => { gaitFaceMove = false; gaitYawManual = 0; const th = i * DIR_STEP, mag = run ? 0.95 : 0.34; locoVz = Math.cos(th) * mag; locoVx = Math.sin(th) * mag; plantDirSel = i; plantSpeedRun = run; if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; void ensurePhysics(); } renderLoco(); };
  const hitPlantPoint = (ev: PointerEvent): boolean => {
    const r = cv.getBoundingClientRect(); const mx = (ev.clientX - r.left) / r.width * PAD, my = (ev.clientY - r.top) / r.height * PAD;
    let best = -1, bestRun = true, bestD = 15;   // порог попадания в точку, px
    for (const run of [false, true]) for (let i = 0; i < 8; i++) { const th = i * DIR_STEP, mag = run ? 0.95 : 0.34; const [px, py] = velToPad(Math.sin(th) * mag, Math.cos(th) * mag); const d = Math.hypot(mx - px, my - py); if (d < bestD) { bestD = d; best = i; bestRun = run; } }
    if (best >= 0) { goDir(best, bestRun); return true; }
    return false;
  };
  let drag = false;
  const setFrom = (ev: PointerEvent): void => { const r = cv.getBoundingClientRect(); [locoVx, locoVz] = padToVel((ev.clientX - r.left) / r.width * PAD, (ev.clientY - r.top) / r.height * PAD); redraw(); };
  cv.addEventListener('pointerdown', (ev) => { if (editPlant && hitPlantPoint(ev)) return; drag = true; cv.setPointerCapture(ev.pointerId); setFrom(ev); });   // в режиме плантов клик по точке = выбор ячейки
  cv.addEventListener('pointermove', (ev) => { if (drag) setFrom(ev); });
  cv.addEventListener('pointerup', () => { drag = false; });
  body.append(pbtn(locoOn ? '⏸ стоп' : '▶ превью бега', () => { locoOn = !locoOn; if (locoOn) { gaitPx = 0; gaitPz = 0; void ensurePhysics(); } else goFrame(frameIdx); renderLoco(); }, locoOn));   // стоп → вернуть манекен к авторскому кадру (не застывать на шаге)
  const tr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:6px'); tr.innerHTML = '<span style="flex:1">скорость просмотра (замедл./×)</span>';
  const ts = el('input', 'flex:2') as HTMLInputElement; ts.type = 'range'; ts.min = '0.1'; ts.max = '2'; ts.step = '0.05'; ts.value = String(locoTempo);
  const tv = el('span', 'width:34px;text-align:right;color:#9ae6a0'); tv.textContent = locoTempo.toFixed(2);
  ts.oninput = () => { locoTempo = parseFloat(ts.value); tv.textContent = locoTempo.toFixed(2); }; tr.append(ts, tv); body.append(tr);
  // Facing: тумблер «по движению»(поворот) / «фикс»(страйф) + угол при фиксе.
  const fr = el('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;align-items:center'); body.append(fr);
  fr.append(pbtn(gaitFaceMove ? 'лицом: по движению' : 'лицом: фикс (страйф)', () => { gaitFaceMove = !gaitFaceMove; renderLoco(); }, gaitFaceMove));
  fr.append(pbtn('редакт. планты', () => { editPlant = !editPlant; if (!editPlant && plantDrag >= 0) { plantDrag = -1; dragMark = null; gizmo.detach(); } renderLoco(); }, editPlant));
  if (editPlant) {   // ячейку выбираешь КЛИКОМ по точке на квадрате; правка — тянешь маркеры в сцене (плант + точки обвода via)
    const cb = el('div', 'flex:1 1 100%;margin-top:3px;border:1px solid #39415a;border-radius:6px;padding:4px'); fr.append(cb);
    const hint = el('div', 'font-size:11px;color:#8fb7ff'); hint.textContent = `${DIR8[plantDirSel]} · ${plantSpeedRun ? 'бег' : 'шаг'} — плант: СИНИЙ=Л / КРАСНЫЙ=П (тяни). Точки обвода — тех же цветов, мельче. Жёлтый = живая цель (динамика).`; cb.append(hint);
    const vr = el('div', 'display:flex;gap:2px;margin-top:3px;align-items:center'); cb.append(vr);
    const vl = el('span', 'font-size:11px;color:#9ae6a0'); vl.textContent = 'обвод (via):'; vr.append(vl);
    vr.append(pbtn('нога: ' + (viaLeg === 0 ? 'Л' : 'П'), () => { viaLeg = viaLeg === 0 ? 1 : 0; renderLoco(); }, true));
    vr.append(
      pbtn('+ точка', () => { const c = selCell(); const arr = viaLeg === 0 ? (c.lVia ??= []) : (c.rVia ??= []); if (arr.length < MAX_VIA) { arr.push([2, viaLeg === 0 ? 12 : -12]); saveGaitCfg(); renderLoco(); } }),
      pbtn('− точка', () => { const c = selCell(); const arr = viaLeg === 0 ? c.lVia : c.rVia; if (arr && arr.length) { arr.pop(); saveGaitCfg(); renderLoco(); } }),
    );
    const rr = el('div', 'display:flex;gap:2px;margin-top:3px'); cb.append(rr);
    rr.append(
      pbtn('сброс ячейки', () => { (plantSpeedRun ? gaitPlant.run : gaitPlant.walk)[plantDirSel] = zeroLeg(); saveGaitCfg(); }),
      pbtn('сброс всех', () => { Object.assign(gaitPlant, emptyGrid()); saveGaitCfg(); renderLoco(); }),
    );
  }
  if (!gaitFaceMove) {
    const yr = el('label', 'display:flex;align-items:center;gap:6px;flex:1 1 100%'); yr.innerHTML = '<span style="flex:1">угол (°)</span>';
    const ys = el('input', 'flex:2') as HTMLInputElement; ys.type = 'range'; ys.min = '-180'; ys.max = '180'; ys.step = '5'; ys.value = String(Math.round(gaitYawManual * 180 / Math.PI));
    const yv = el('span', 'width:40px;text-align:right;color:#9ae6a0'); yv.textContent = ys.value + '°';
    ys.oninput = () => { gaitYawManual = parseFloat(ys.value) * Math.PI / 180; yv.textContent = ys.value + '°'; }; yr.append(ys, yv); fr.append(yr);
  }
  gaitReadout = el('div', 'color:#8fb7ff;font-size:11px;margin-top:4px'); gaitReadout.textContent = 'скорость: — (пад: центр → шаг, край → бег)'; body.append(gaitReadout);
  renderGaitTune();
  renderUpperPanel();
  renderAttackPanel();
}
/** Панель настройки процедурного бега (GX/POSE/GAIT). Меняет живые объекты + пишет per-character в pe_gait. */
function renderGaitTune(): void {
  const box = el('div', 'margin-top:8px;border:1px solid #39415a;border-radius:6px;padding:6px');
  const gsl = (label: string, obj: NumRec, key: string, min: number, max: number, step: number): void => {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:3px');
    const nm = el('span', 'flex:1;font-size:11px'); nm.textContent = label; row.append(nm);
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(obj[key]);
    const v = el('span', 'width:42px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = (+obj[key]!).toFixed(2);
    s.oninput = () => { obj[key] = parseFloat(s.value); v.textContent = obj[key]!.toFixed(2); saveGaitCfg(); };
    row.append(s, v); box.append(row);
  };
  const grp = (t: string): void => { const h = el('div', 'color:#8fb7ff;font-weight:bold;margin:6px 0 1px;font-size:11px'); h.textContent = t; box.append(h); };
  const GXo = GX as unknown as NumRec, POSEo = POSE as unknown as NumRec, GAITo = GAIT as unknown as NumRec;
  grp('поза (ретаргет)');
  gsl('руки вниз', GXo, 'armDown', 0.6, 1.8, 0.01);
  gsl('сгиб локтя', GXo, 'elbowBend', 0, 1.2, 0.02);
  grp('руки (мах)');
  gsl('плечо база', POSEo, 'armSh', -0.8, 0.4, 0.02);
  gsl('локоть база', POSEo, 'armEl', 0, 1.4, 0.02);
  gsl('амплитуда маха', POSEo, 'armSwing', 0, 1.2, 0.02);
  grp('ноги / посадка');
  // «высота таза» убрана — база берётся из idle-стойки (measureStancePlants.standY), чтобы бег/подшаг не подскакивали.
  gsl('присед (мин.таз)', GAITo, 'pelvisMin', 16, 34, 0.5);
  gsl('длина шага (ходьба)', GAITo, 'stepWalk', 10, 70, 1);
  gsl('длина шага (бег)', GAITo, 'stepRun', 10, 70, 1);
  gsl('боб таза × (ходьба)', GAITo, 'bobWalk', 0, 2, 0.05);
  gsl('боб таза × (бег)', GAITo, 'bobRun', 0, 2, 0.05);
  gsl('подъём стопы (ходьба)', GAITo, 'liftWalk', 2, 20, 0.5);
  gsl('подъём стопы (бег)', GAITo, 'liftRun', 2, 20, 0.5);
  gsl('скорость анимации бега (в игре, антискольз.)', GAITo, 'cadence', 0.5, 2, 0.05);
  gsl('доля опоры (ходьба)', GAITo, 'dutyWalk', 0.15, 0.5, 0.01);
  gsl('доля опоры (бег)', GAITo, 'dutyRun', 0.1, 0.35, 0.01);
  gsl('потолок бедра', GAITo, 'hipFwdLim', 0.4, 1.4, 0.02);
  gsl('ширина стойки', GAITo, 'stanceWidth', -6, 14, 0.5);
  gsl('вынос вбок (страйф)', GAITo, 'strafeReach', 0, 1.5, 0.05);
  gsl('предел кроссовера', GAITo, 'crossClamp', 0, 99, 1);
  gsl('поворот: порог (рад/с)', GAITo, 'turnStep', 0.1, 1.5, 0.05);
  gsl('поворот: шаг через (u)', GAITo, 'turnStepDist', 2, 16, 0.5);
  gsl('поворот: ведёт внутр. нога', GAITo, 'turnLeadBias', 0.3, 1.0, 0.05);
  box.append(pbtn('сброс настроек бега', () => { delete gaitCfgs[curCharId]; try { localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); } catch { /* */ } applyGaitCfg(curCharId); renderLoco(); }));
  // Экспорт/импорт настроек бега ВСЕХ персонажей (pe_gait) — портируемый артефакт (бэкап + вход для Ф5).
  const eh = el('div', 'color:#8fb7ff;font-weight:bold;margin:8px 0 2px;font-size:11px'); eh.textContent = 'НАСТРОЙКИ БЕГА → JSON (все персонажи)'; box.append(eh);
  const ga = el('textarea', 'width:100%;height:56px;background:#0e1016;color:#9ae6a0;border:1px solid #39415a;border-radius:4px;font:10px monospace') as HTMLTextAreaElement; box.append(ga);
  const gr = el('div', 'display:flex;gap:2px;margin-top:2px'); box.append(gr);
  gr.append(
    pbtn('экспорт', () => { saveGaitCfg(); ga.value = JSON.stringify(gaitCfgs); }),
    pbtn('копир', () => navigator.clipboard?.writeText(ga.value)),
    pbtn('импорт', () => { try { const d = JSON.parse(ga.value) as typeof gaitCfgs; if (d && typeof d === 'object') { gaitCfgs = d; localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); applyGaitCfg(curCharId); renderLoco(); } } catch { /* */ } }),
  );
  body.append(box);
}

// ── Таймлайн ──
let playing = false, playT = 0, playSpeed = 1;
const tlName = el('span', 'color:#9ae6a0;min-width:90px'); const tlDots = el('div', 'position:relative;flex:1;height:22px'); const scrub = el('input', 'flex:2') as HTMLInputElement;
scrub.type = 'range'; scrub.min = '0'; scrub.max = '1'; scrub.step = '0.005'; scrub.value = '0'; scrub.oninput = () => { const c = curClip(); if (c) preview(parseFloat(scrub.value) * clipDur(c)); if (mode === 'ik') captureRig(); };
const playBtn = mkBtn('▶', () => { const c = curClip(); if (!playing && c && playT >= clipDur(c)) playT = 0; playing = !playing; playBtn.textContent = playing ? '⏸' : '▶'; });
const spd = el('input', 'width:80px') as HTMLInputElement; spd.type = 'range'; spd.min = '0.2'; spd.max = '3'; spd.step = '0.1'; spd.value = '1'; spd.oninput = () => { playSpeed = parseFloat(spd.value); };
timeline.append(playBtn, tlName, scrub, document.createTextNode('скор'), spd, tlDots);
function refreshTimeline(): void {
  const c = curClip(); tlName.textContent = c ? c.name : '(нет клипа)'; tlDots.innerHTML = '';
  if (!c) return;
  const dur = clipDur(c) || 1;
  c.keys.forEach((kf, i) => { const d = el('div', `position:absolute;top:4px;width:12px;height:12px;border-radius:50%;cursor:pointer;border:1px solid #39415a;background:${i === frameIdx ? '#46d07a' : '#4a5680'};left:${(kf.t / dur) * 92}%`); d.title = `${i + 1} · ${kf.t.toFixed(2)}с`; d.onclick = () => goFrame(i); tlDots.append(d); });
}
function goFrame(i: number): void { const c = curClip(); if (!c) return; frameIdx = i; if (c.keys[i]) applyPose(c.keys[i]!.pose); if (mode === 'ik') captureRig(); refreshAll(); }
function preview(time: number): void {   // time в секундах
  const c = curClip(); if (!c || !c.keys.length) return; const ks = c.keys;
  if (ks.length < 2) { applyPose(ks[0]!.pose); return; }
  const tt = clamp(time, 0, clipDur(c));
  let i = 0; while (i < ks.length - 2 && ks[i + 1]!.t <= tt) i++;
  const a = ks[i]!, b = ks[i + 1]!, span = b.t - a.t;
  lerpPose(a.pose, b.pose, span > 1e-6 ? clamp((tt - a.t) / span, 0, 1) : 0);
}

// ── Физика (Ф2b: рэгдолл на гуманоид-скелете — призрак, ведомый моторами к позе) ──
let pw: PhysWorld | null = null; let physOn = false; let physDead = false; let showKin = true;
let ragdoll: HumanoidRagdoll | null = null;
let reviveT = -1; const reviveFrom = new THREE.Vector3(); const reviveDur = 0.9;   // плавное вставание с пола
let locoOn = false, locoPhase = 0, locoVx = 0, locoVz = 0.7, locoTempo = 1, locoGait = true;   // превью локомоции (движок: gait/бленд)
// ── Процедурный бег из 3д-клиента (pose.ts) → ретаргет на humanoid ──
const gaitDriver = new PoseDriver();
let gaitPx = 0, gaitPz = 0; const GAIT_MAXSPD = 120;
let gaitMoveMag = 0;   // 0 стоишь … 1 бежишь: по нему ноги/торс блендятся idle-стойка ↔ физ-гейт
let gaitYaw = 0, gaitYawManual = 0, gaitFaceMove = true;   // facing: по движению (поворот) / ручной угол (страйф)
let gaitReadout: HTMLElement | null = null;                // живой индикатор скорости/режима (ходьба↔бег)
// ── Маркеры планта + точки ОБВОДА (via) свинга. Авторские = СТАТИЧЕСКИЕ (не тредмиллят), тянутся гизмо → body-local offset.
// Левая нога — СИНИЙ, правая — КРАСНЫЙ. via — те же цвета, поменьше. Живой индикатор (жёлтый мелкий) ездит по факту (динамика).
let editPlant = false;
let viaLeg: 0 | 1 = 0;                                          // какую ногу авторим кнопками + / − обвод
const PLANT_BLUE = 0x4aa0ff, PLANT_RED = 0xff5a4a, MAX_VIA = 3, HIP_DXE = 3.6, MARK_Y = 1.5;
const plantMarks = [mkHandle(PLANT_BLUE, 3, true), mkHandle(PLANT_RED, 3, true)];   // [0]=L плант, [1]=R плант (авторские)
const viaMarks: THREE.Mesh[][] = [[], []];
for (let i = 0; i < 2; i++) for (let k = 0; k < MAX_VIA; k++) viaMarks[i]!.push(mkHandle(i === 0 ? PLANT_BLUE : PLANT_RED, 2, false));
const liveMarks = [mkHandle(0xffe04a, 1.4, false), mkHandle(0xffe04a, 1.4, false)];   // живые точки (динамика): куда реально идёт стопа
[plantMarks[0]!, plantMarks[1]!, ...viaMarks.flat(), liveMarks[0]!, liveMarks[1]!].forEach((m) => { m.visible = false; });
type AuthMark = { mesh: THREE.Mesh; foot: 0 | 1; kind: 'plant' | 'via'; k: number };   // реестр перетаскиваемых авторских точек
let authMarks: AuthMark[] = [];
let plantDrag = -1; let dragMark: AuthMark | null = null; const plantGrab = V(); let plantOff0: [number, number] = [0, 0];
let gaitSpd = 0;   // фактическая скорость гейта (для точного референса планта — маркер совпадает с ногой)
const selCell = (): Leg2 => (plantSpeedRun ? gaitPlant.run : gaitPlant.walk)[plantDirSel]!;   // ВЫБРАННАЯ ячейка (панель)
const setXZ = (m: THREE.Mesh, x: number, z: number): void => { m.position.set(x, MARK_Y, z); };
/** Стационарный body-референс: forward=(sin yaw,cos yaw), right=(cos yaw,−sin yaw); хип ноги на ±HIP_DXE вбок.
 *  Точно совпадает с плант-целью планировщика: tx−gaitPx == refPos(foot, fwdAmt, latAmt). */
function refPos(foot: 0 | 1, fwd: number, lat: number): [number, number] {
  const s = Math.sin(gaitYaw), c = Math.cos(gaitYaw), side = foot === 0 ? HIP_DXE : -HIP_DXE;
  return [c * side + s * fwd + c * lat, -s * side + c * fwd - s * lat];
}
/** Референс-позиция ПЛАНТА выбранной ячейки = РЕАЛЬНАЯ плант-цель (как в pose.ts plant()): hip + fwd·(lead·mFwd+off) +
 *  right·(lead·mLat·strafeReach + stanceWidth·side + off). Считаем по фактической скорости гейта → маркер совпадает с ногой. */
function plantRef(foot: 0 | 1, off: [number, number]): [number, number] {
  const th = plantDirSel * (Math.PI / 4), mFwd = Math.cos(th), mLat = Math.sin(th);
  const speed = gaitSpd > 1 ? gaitSpd : (plantSpeedRun ? GAIT.speedRun : GAIT.speedWalk);
  const dr = clamp((speed - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
  const stepLen = (GAIT.stepWalk + (GAIT.stepRun - GAIT.stepWalk) * dr) / Math.max(0.1, GAIT.cadence);
  const duty = GAIT.dutyWalk + (GAIT.dutyRun - GAIT.dutyWalk) * dr;
  const lead = stepLen * duty + stepLen * GAIT.aheadMul + speed * GAIT.predictSec;
  const side = foot === 0 ? 1 : -1;
  return refPos(foot, lead * mFwd + off[0], lead * mLat * GAIT.strafeReach + GAIT.stanceWidth * side + off[1]);
}
function updatePlantMarks(): void {
  const show = editPlant && locoOn && locoGait;
  authMarks = [];
  const cell = (plantSpeedRun ? gaitPlant.run : gaitPlant.walk)[plantDirSel]!;   // авторим выбранную ячейку (при драге авто-слежение выкл → совпадает с замороженной)
  for (let i = 0; i < 2; i++) {
    const foot = i as 0 | 1;
    const off = foot === 0 ? cell.l : cell.r;
    const pm = plantMarks[i]!; pm.visible = show;
    if (show) { authMarks.push({ mesh: pm, foot, kind: 'plant', k: 0 });
      if (dragMark?.mesh !== pm) { const p = plantRef(foot, off); setXZ(pm, p[0], p[1]); } }
    const via = (foot === 0 ? cell.lVia : cell.rVia) ?? [];
    for (let k = 0; k < MAX_VIA; k++) {
      const vm = viaMarks[i]![k]!; const on = show && k < via.length; vm.visible = on;
      if (on) { authMarks.push({ mesh: vm, foot, kind: 'via', k });
        if (dragMark?.mesh !== vm) { const p = refPos(foot, via[k]![0], via[k]![1]); setXZ(vm, p[0], p[1]); } }
    }
    const lm = liveMarks[i]!; lm.visible = show;                 // живой: реальная цель, тредмилл-ремап
    if (show) { const [tx, tz] = gaitDriver.plantTarget(foot); setXZ(lm, tx - gaitPx, tz - gaitPz); }
  }
}
/** Ретаргет-крутилки редактора (сверх GAIT/POSE): ширина ног, база «рука вниз», база сгиба локтя, множитель боба. Передаются в общий poseRuntime. */
const GX = { armDown: 1.35, elbowBend: 0.25 };   // legWidth убран (дубль «ширина стойки»); боб таза — в GAIT.bobWalk/bobRun
// Живой контент редактора (библиотека + swayCfg). shieldOverlay — поза щита per-оружие (idle_<wk> → фолбэк idle_shield)
// + вес shieldMixFor(wk) (ползунок), подмешивается ТАК ЖЕ, как в игре: превью '+shield'-оружия показывает микс.
const editorContent: PoseContent = {
  resolveUpper: (w) => resolveUpper(w),
  shieldOverlay: (wk) => { const c = stanceClip(wk) ?? stanceClip('shield'); return c && c.keys[0] ? { pose: c.keys[0].pose, mix: shieldMixFor(wk) } : null; },
};
function gaitToHumanoid(t: PoseTargets): void {   // тонкая обёртка над ОБЩИМ пайплайном (Ф5) — редактор и игра одним кодом
  rtGaitToHumanoid(human, weaponGroups, GX, gaitMoveMag, t, editorContent, weapon, { clip: attackClip, t: attackT });
}
// ── Верх тела по оружию (Феча 2): idle-СТОЙКА = клип «idle_<оружие>» (правится в Анимации) + остаточный мах (pe_sway) ──
interface UpperPose { pose: Pose; swing: number }
const stanceName = (w: string): string => 'idle_' + w;
function stanceClip(w: string): Clip | null { return library.find((c) => c.name === stanceName(w) && c.character === curCharId && c.weapon === w) ?? null; }
function loadSway(): Record<string, Record<string, number>> { try { return JSON.parse(localStorage.getItem('pe_sway') || '{}') as Record<string, Record<string, number>>; } catch { return {}; } }
let swayCfg: Record<string, Record<string, number>> = loadSway();
function saveSway(): void { try { localStorage.setItem('pe_sway', JSON.stringify(swayCfg)); savePoseKey('pe_sway'); } catch { /* */ } }
const swayOf = (w: string): number => swayCfg[curCharId]?.[w] ?? 0.2;   // остаточный мах поверх idle (физпокачивание)
function resolveUpper(wpn: string): UpperPose | null {   // idle-поза по БАЗОВОМУ оружию (sword+shield → sword); щит — отдельным оверлеем
  const b = rtBaseWeapon(wpn);
  let c = stanceClip(b);
  if (!c) { const base = rtBaseWeapon(curChar().weapon); if (base !== b) c = stanceClip(base); }
  if (!c || !c.keys[0]) return null;
  return { pose: c.keys[0]!.pose, swing: swayOf(b) };
}
// Удары — клипы «hit_<w>» (базовый) и «s_hit_<w>» (спец/скил) из 6 кадров; кадры 1 и последний = idle-стойка (не редактируются, синк ОДНОСТОРОННЕ idle→удар).
const isAttackClip = (c: Clip): boolean => c.name.startsWith('hit_') || c.name.startsWith('s_hit_');
function syncAttackEnds(c: Clip): void {
  const st = stanceClip(c.weapon); if (!st || !st.keys[0] || c.keys.length < 2) return;
  const pose = JSON.parse(JSON.stringify(st.keys[0].pose)) as Pose;
  c.keys[0]!.pose = pose; c.keys[c.keys.length - 1]!.pose = JSON.parse(JSON.stringify(st.keys[0].pose)) as Pose;
}
function syncAllAttackEnds(): void { for (const c of library) if (c.character === curCharId && isAttackClip(c)) syncAttackEnds(c); }
function captureUpper(): void {   // снять ВСЮ позу манекена (ноги+торс+верх+оружие) → клип «стойка_<оружие>» = начальная позиция всего тела
  if (locoOn || playing) { alert('Идёт превью/воспроизведение — сначала останови (⏸), иначе схватишь кадр бега, а не стойку.'); return; }
  const nm = stanceName(weapon);
  const i = library.findIndex((c) => c.name === nm && c.character === curCharId && c.weapon === weapon);
  if (i >= 0 && !confirm(`Перезаписать «${nm}» текущей позой манекена?`)) return;   // защита от случайной перезаписи idle
  pushUndo();                       // на случай ошибки — Ctrl+Z вернёт прежнюю стойку
  const pose = readPoseFull();
  const clip: Clip = { name: nm, character: curCharId, weapon, loop: false, keys: [{ pose, t: 0 }] };
  if (i >= 0) library[i] = clip; else library.push(clip);
  syncAllAttackEnds();   // стойка изменилась → концы всех её ударов подхватывают
  saveLib();
}
// ── Удары на бегу (Феча 3): авторский клип-удар поверх бегущих ног, физически ведомый (моторы гонят рэгдолл к цели) ──
let attackClip: Clip | null = null; let attackT = -1; let attackSpeed = 1;
function triggerAttack(c: Clip): void {   // запустить удар; включить физику → физ-призрак = физически верный замах
  syncAttackEnds(c);   // концы = актуальная стойка (на случай если стойку поправили)
  attackClip = c; attackT = 0;
  void ensurePhysics().then(() => { physOn = true; setPhysVis(true); });
}
// Пометка клипов как ударов (per char×weapon) — их кнопки появляются в превью бега.
function loadAtk(): Record<string, Record<string, string[]>> { try { return JSON.parse(localStorage.getItem('pe_attacks') || '{}') as Record<string, Record<string, string[]>>; } catch { return {}; } }
let atkCfgs: Record<string, Record<string, string[]>> = loadAtk();
function saveAtk(): void { try { localStorage.setItem('pe_attacks', JSON.stringify(atkCfgs)); savePoseKey('pe_attacks'); } catch { /* */ } }
(function migrateDual(): void {   // единая офф-рука: старый ключ оружия 'dual' → 'sword+dagger' (клипы/атаки/sway). Идемпотентно.
  let changed = false;
  for (const c of library) if (c.weapon === 'dual') { c.weapon = 'sword+dagger'; changed = true; }
  for (const map of [swayCfg as Record<string, Record<string, unknown>>, atkCfgs as Record<string, Record<string, unknown>>]) {
    for (const ch of Object.keys(map)) { const byW = map[ch]!; if (byW['dual'] !== undefined && byW['sword+dagger'] === undefined) { byW['sword+dagger'] = byW['dual']; delete byW['dual']; changed = true; } }
  }
  if (changed) { try { localStorage.setItem('pe_clips', JSON.stringify(library)); savePoseKey('pe_clips'); localStorage.setItem('pe_sway', JSON.stringify(swayCfg)); savePoseKey('pe_sway'); localStorage.setItem('pe_attacks', JSON.stringify(atkCfgs)); savePoseKey('pe_attacks'); } catch { /* */ } }
})();
(function migratePoseNames(): void {   // старая конвенция имён стойка_/удар_ → idle_/hit_ (идемпотентно): клипы + метки-удары + loco-узлы. Игра тоже нормализует на чтении.
  let clipsCh = false, atkCh = false, locoCh = false;
  for (const c of library) { const nn = migratePoseName(c.name); if (nn !== c.name) { c.name = nn; clipsCh = true; } }
  for (const ch of Object.keys(atkCfgs)) { const byW = atkCfgs[ch]!; for (const w of Object.keys(byW)) { const arr = byW[w]!; for (let i = 0; i < arr.length; i++) { const nn = migratePoseName(arr[i]!); if (nn !== arr[i]) { arr[i] = nn; atkCh = true; } } } }
  for (const n of locoNodes) { const nn = migratePoseName(n.clip); if (nn !== n.clip) { n.clip = nn; locoCh = true; } }
  if (clipsCh) saveLib();
  if (atkCh) saveAtk();
  if (locoCh) saveLoco();
})();
function atkList(): string[] { return atkCfgs[curCharId]?.[weapon] ?? []; }
function toggleAtk(name: string): void { const byC = (atkCfgs[curCharId] ??= {}); const arr = (byC[weapon] ??= []); const i = arr.indexOf(name); if (i >= 0) arr.splice(i, 1); else arr.push(name); saveAtk(); }
const clonePose = (p: Pose): Pose => JSON.parse(JSON.stringify(p)) as Pose;
const cloneClipTo = (c: Clip, char: string): Clip => ({ name: c.name, character: char, weapon: c.weapon, loop: c.loop, keys: c.keys.map((k) => ({ pose: clonePose(k.pose), t: k.t })) });

// ── СИД «Волкодав»: idle-стойка (клип «idle_<w>») + удар (клип «hit_<w>», начинается ИЗ idle) на КАЖДОЕ из 16 оружий (+ без оружия) ──
type V3 = [number, number, number];
function buildWarriorSeed(): { stances: Clip[]; attacks: Clip[]; sway: Record<string, number> } {
  const P = (rua: V3, rla: V3, lua: V3, lla: V3, ex?: Record<string, V3>): Pose => ({ RightUpperArm: rua, RightLowerArm: rla, LeftUpperArm: lua, LeftLowerArm: lla, ...(ex ?? {}) });
  // idle-шаблоны по типу оружия: (правое плечо, правый локоть, левое плечо, левый локоть), sway = остаточный мах (физпокачивание)
  const IDLE: Record<string, { pose: Pose; sway: number }> = {
    melee1h: { pose: P([-0.35, 0, 1.15], [-0.7, 0, 0], [-0.15, 0, -1.25], [-0.35, 0, 0]), sway: 0.22 },   // меч/кинжал/топор/булава в правой
    shield1h: { pose: P([-0.3, 0, 1.1], [-0.7, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0]), sway: 0.15 },       // меч+щит: щит-гард слева
    dual: { pose: P([-0.4, 0, 1.05], [-0.75, 0, 0], [-0.4, 0, -1.05], [-0.75, 0, 0]), sway: 0.2 },         // парное: обе к бою
    twoH: { pose: P([-0.25, 0.95, 0.5], [-1.2, -0.3, 0], [-0.15, -1.05, -0.35], [-1.5, 0.3, 0]), sway: 0.12 },   // двуручка вперёд-по диагонали
    staff: { pose: P([-0.2, 0.8, 0.7], [-1.0, 0, 0], [-0.2, -0.9, -0.4], [-1.3, 0.2, 0]), sway: 0.14 },
    bow: { pose: P([-0.5, 0.9, 0.6], [-1.9, 0, 0], [-0.1, -1.35, -0.35], [-0.15, 0, 0]), sway: 0.1 },      // лук: левая вперёд держит, правая у подбородка
    crossbow: { pose: P([-0.4, 0.7, 0.6], [-1.0, 0, 0], [-0.3, -0.8, -0.4], [-1.1, 0, 0]), sway: 0.1 },    // арбалет вперёд, две руки
    shield: { pose: P([-0.3, 0, 1.0], [-0.8, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0]), sway: 0.15 },
    unarmed: { pose: P([-1.0, 0.5, 0.55], [-1.7, 0, 0], [-1.0, -0.5, -0.55], [-1.7, 0, 0]), sway: 0.25 },  // без оружия: кулаки у груди (гард)
  };
  // удар: [замах, удар] (idle-кадр добавим первым/последним снаружи). Не-двигающаяся рука = из idle.
  const ATK: Record<string, [Pose, Pose]> = {
    melee1h: [P([-2.0, 0, 0.4], [-1.0, 0, 0], [-0.15, 0, -1.25], [-0.35, 0, 0], { Chest: [0, 0.25, 0] }), P([0.5, 0, 0.9], [-0.2, 0, 0], [-0.15, 0, -1.25], [-0.35, 0, 0], { Chest: [0.15, -0.35, 0] })],
    shield1h: [P([-2.0, 0, 0.4], [-1.0, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0], { Chest: [0, 0.25, 0] }), P([0.5, 0, 0.9], [-0.2, 0, 0], [-0.75, 0, -0.6], [-1.4, 0, 0], { Chest: [0.15, -0.35, 0] })],
    dual: [P([-1.9, 0, 0.4], [-0.9, 0, 0], [-0.4, 0, -1.05], [-0.75, 0, 0], { Chest: [0, 0.2, 0] }), P([0.5, 0, 0.9], [-0.3, 0, 0], [-0.5, 0, -0.9], [-0.9, 0, 0], { Chest: [0.1, -0.3, 0] })],
    twoH: [P([-2.1, 0, 0.5], [-0.8, 0, 0], [-2.0, 0, -0.4], [-0.9, 0, 0], { Chest: [0, 0.3, 0] }), P([0.4, 0, 0.7], [-0.3, 0, 0], [0.3, 0, -0.5], [-0.4, 0, 0], { Chest: [0.2, -0.4, 0] })],
    staff: [P([-2.0, 0, 0.5], [-1.0, 0, 0], [-1.5, 0, -0.5], [-1.2, 0, 0], { Chest: [0, 0.2, 0] }), P([0.3, 0, 0.8], [-0.4, 0, 0], [-0.3, 0, -0.5], [-1.3, 0, 0], { Chest: [0.15, -0.3, 0] })],
    bow: [P([-0.55, 0.6, 0.55], [-2.2, 0, 0], [-0.1, -1.4, -0.3], [-0.1, 0, 0], { Chest: [0, -0.1, 0] }), P([-0.4, 0.3, 0.5], [-2.4, 0, 0], [-0.1, -1.45, -0.28], [-0.05, 0, 0], { Chest: [0, -0.22, 0] })],   // натяг: правая к подбородку
    crossbow: [P([-0.42, 0.7, 0.6], [-0.9, 0, 0], [-0.3, -0.8, -0.4], [-1.1, 0, 0], { Chest: [0, 0, 0] }), P([-0.45, 0.7, 0.6], [-1.0, 0, 0], [-0.3, -0.8, -0.4], [-1.1, 0, 0], { Chest: [-0.1, 0, 0] })],   // выстрел + отдача
    shield: [P([-0.3, 0, 1.0], [-0.8, 0, 0], [-0.75, 0, -0.4], [-1.2, 0, 0], { Chest: [0, 0.15, 0] }), P([-0.3, 0, 1.0], [-0.8, 0, 0], [-1.4, 0, -0.2], [-0.6, 0, 0], { Chest: [0.12, -0.2, 0] })],   // удар щитом
    unarmed: [P([-1.2, 0.4, 0.5], [-1.9, 0, 0], [-1.0, -0.5, -0.55], [-1.7, 0, 0], { Chest: [0, 0.2, 0] }), P([-1.4, 0.2, 0.4], [-0.15, 0, 0], [-1.0, -0.5, -0.55], [-1.7, 0, 0], { Chest: [0.1, -0.3, 0] })],   // прямой правой
  };
  const MAP: Record<string, string> = { none: 'unarmed', sword: 'melee1h', dagger: 'melee1h', axe: 'melee1h', mace: 'melee1h', 'sword+shield': 'shield1h', dual: 'dual', greatsword: 'twoH', greataxe: 'twoH', greatmaul: 'twoH', halberd: 'twoH', spear: 'twoH', staff: 'staff', bow: 'bow', crossbow: 'crossbow', shield: 'shield' };
  const stances: Clip[] = [], attacks: Clip[] = [], sway: Record<string, number> = {};
  for (const w in MAP) {
    const tpl = MAP[w]!; const idle = IDLE[tpl]!, a = ATK[tpl]!;
    sway[w] = idle.sway;
    stances.push({ name: stanceName(w), character: 'warrior', weapon: w, loop: false, keys: [{ pose: clonePose(idle.pose), t: 0 }] });
    // удар = 6 кадров: idle → замах½ → замах-макс → удар½ → удар-финиш → idle. Полукадры — интерполяция (blendTwo).
    const wUp = a[0], strike = a[1];
    attacks.push({ name: 'hit_' + w, character: 'warrior', weapon: w, loop: false, keys: [
      { pose: clonePose(idle.pose), t: 0 },
      { pose: blendTwo(idle.pose, wUp, 0.5), t: 0.10 },
      { pose: clonePose(wUp), t: 0.22 },
      { pose: blendTwo(wUp, strike, 0.5), t: 0.34 },
      { pose: clonePose(strike), t: 0.46 },
      { pose: clonePose(idle.pose), t: 0.62 },
    ] });
  }
  return { stances, attacks, sway };
}
function seedWarrior(forceStances: boolean): void {   // сид Волкодава: удары ВСЕГДА пересобрать (6 кадров), стойки — добавить недостающие (force=перезаписать)
  const s = buildWarriorSeed();
  const put = (c: Clip, replace: boolean): void => { const i = library.findIndex((x) => x.name === c.name && x.character === 'warrior' && x.weapon === c.weapon); if (i >= 0) { if (replace) library[i] = c; } else library.push(c); };
  for (const c of s.stances) put(c, forceStances);
  for (const c of s.attacks) put(c, true);   // удары — в 6-кадровую структуру
  swayCfg.warrior = forceStances ? s.sway : { ...s.sway, ...(swayCfg.warrior ?? {}) }; saveSway();
  const am = (atkCfgs.warrior ??= {});
  for (const c of s.attacks) { const arr = (am[c.weapon] ??= []); if (!arr.includes(c.name)) arr.push(c.name); }
  saveAtk();
  syncAllAttackEnds();   // концы ударов = актуальные стойки (пользовательские, если стойку не форсили)
  saveLib();
}
function ensureSeed(): void {   // первый запуск: 16 стоек + 16 ударов (6 кадров, концы из стойки). Флаг pe_seeded4 (миграция 4→6 кадров)
  localStorage.removeItem('pe_upper');   // старый формат idle-стора не используется
  if (localStorage.getItem('pe_seeded4')) return;
  seedWarrior(false);   // новый юзер → всё; старый сид → стойки сохранить, удары пересобрать в 6 кадров
  localStorage.setItem('pe_seeded4', '1');
}
function renderUpperPanel(): void {   // панель idle-стойки по оружию (Феча 2): захват в клип, остаточный мах, «взять за основу»
  const box = el('div', 'margin-top:8px;border:1px solid #39415a;border-radius:6px;padding:6px');
  const st = stanceClip(weapon); const has = !!st;
  const h = el('div', 'color:#8fb7ff;font-weight:bold;margin-bottom:2px;font-size:11px');
  h.textContent = `IDLE-СТОЙКА · ${weapon}` + (has ? ' (клип «' + stanceName(weapon) + '»)' : ' — не задана (полный мах)'); box.append(h);
  box.append(pbtn(has ? '⟳ перезахватить стойку (в клип)' : '✎ захватить стойку (в клип)', () => { captureUpper(); renderLoco(); }));
  if (curCharId === 'warrior') box.append(pbtn('↺ сид Волкодава (16 стоек + 16 ударов)', () => { if (confirm('Перезаписать все стойки и удары Волкодава примерным сидом?')) { seedWarrior(true); renderLoco(); } }));
  if (has) {
    const row = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); row.innerHTML = '<span style="flex:1;font-size:11px">остаточный мах (сверх физики)</span>';
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = '0'; s.max = '1'; s.step = '0.05'; s.value = String(swayOf(weapon));
    const v = el('span', 'width:34px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = swayOf(weapon).toFixed(2);
    s.oninput = () => { (swayCfg[curCharId] ??= {})[weapon] = parseFloat(s.value); v.textContent = parseFloat(s.value).toFixed(2); saveSway(); }; row.append(s, v); box.append(row);
    box.append(pbtn('сброс стойки', () => { library = library.filter((c) => !(c.name === stanceName(weapon) && c.character === curCharId && c.weapon === weapon)); saveLib(); renderLoco(); }));
  }
  {   // взять стойку с другого ОРУЖИЯ — единый список оружия (как в тулбаре); копирование в себя = no-op
    const r1 = el('div', 'display:flex;gap:2px;margin-top:4px'); const sel = el('select', 'flex:1;background:#20242f;color:#cfe;border:1px solid #39415a;border-radius:4px;font-size:11px') as HTMLSelectElement;
    WEAPONS.forEach((w) => { const o = document.createElement('option'); o.value = w; o.textContent = w; sel.append(o); });
    r1.append(sel, pbtn('основа: оружие', () => { if (sel.value === weapon) return; const src = stanceClip(sel.value); if (src) { const nm = stanceName(weapon); const i = library.findIndex((c) => c.name === nm && c.character === curCharId && c.weapon === weapon); const nc: Clip = { name: nm, character: curCharId, weapon, loop: false, keys: [{ pose: clonePose(src.keys[0]!.pose), t: 0 }] }; if (i >= 0) library[i] = nc; else library.push(nc); (swayCfg[curCharId] ??= {})[weapon] = swayCfg[curCharId]?.[sel.value] ?? 0.2; saveLib(); saveSway(); renderLoco(); } })); box.append(r1);
  }
  const srcC = allChars().filter((c) => c.id !== curCharId && library.some((cl) => cl.character === c.id && cl.name.startsWith('idle_')));
  if (srcC.length) {   // взять ВЕСЬ набор (стойки+удары) с другого КЛАССА
    const r2 = el('div', 'display:flex;gap:2px;margin-top:4px'); const sel = el('select', 'flex:1;background:#20242f;color:#cfe;border:1px solid #39415a;border-radius:4px;font-size:11px') as HTMLSelectElement;
    srcC.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.append(o); });
    r2.append(sel, pbtn('основа: класс (весь верх)', () => { const src = sel.value; for (const cl of library.filter((c) => c.character === src && (c.name.startsWith('idle_') || c.name.startsWith('hit_') || c.name.startsWith('s_hit_')))) { const i = library.findIndex((c) => c.character === curCharId && c.name === cl.name && c.weapon === cl.weapon); const nc = cloneClipTo(cl, curCharId); if (i >= 0) library[i] = nc; else library.push(nc); } swayCfg[curCharId] = { ...(swayCfg[src] ?? {}) }; atkCfgs[curCharId] = JSON.parse(JSON.stringify(atkCfgs[src] ?? {})); saveLib(); saveSway(); saveAtk(); renderLoco(); })); box.append(r2);
  }
  body.append(box);
}
function renderAttackPanel(): void {   // Феча 3: пометить клипы ударами + кнопки запуска поверх бега (физ-ведомо)
  const box = el('div', 'margin-top:8px;border:1px solid #5a3946;border-radius:6px;padding:6px');
  const h = el('div', 'color:#d08fbf;font-weight:bold;margin-bottom:2px;font-size:11px'); h.textContent = 'УДАРЫ НА БЕГУ (клип → физ-удар)'; box.append(h);
  const clips = clipsHere().filter((c) => !c.loop);   // удары — не-loop клипы (беговой цикл loop — отдельно)
  if (!clips.length) { const w = el('div', 'color:#d0a060;font-size:11px'); w.textContent = 'Нет клипов-ударов. Сделай удар во вкладке «Анимация» → вернись и отметь его тут.'; box.append(w); }
  const marks = atkList();
  clips.forEach((c) => {
    const isAtk = marks.includes(c.name);
    const r = el('div', 'display:flex;gap:2px;margin-top:2px;align-items:center'); box.append(r);
    r.append(pbtn(isAtk ? '⚔' : '—', () => { toggleAtk(c.name); renderLoco(); }, isAtk));
    const nm = el('span', 'flex:1;font-size:11px'); nm.textContent = c.name; r.append(nm);
    if (isAtk) r.append(pbtn('▶ удар', () => { if (!locoOn) { locoOn = true; gaitPx = 0; gaitPz = 0; } triggerAttack(c); }));
  });
  if (marks.length) {
    const tr = el('label', 'display:flex;align-items:center;gap:6px;margin-top:4px'); tr.innerHTML = '<span style="flex:1;font-size:11px">скорость удара</span>';
    const s = el('input', 'flex:2') as HTMLInputElement; s.type = 'range'; s.min = '0.3'; s.max = '2'; s.step = '0.1'; s.value = String(attackSpeed);
    const v = el('span', 'width:30px;text-align:right;color:#9ae6a0;font-size:11px'); v.textContent = attackSpeed.toFixed(1);
    s.oninput = () => { attackSpeed = parseFloat(s.value); v.textContent = attackSpeed.toFixed(1); }; tr.append(s, v); box.append(tr);
    const hint = el('div', 'color:#8fb7ff;font-size:10px;margin-top:3px'); hint.textContent = 'Удар ведётся физикой (моторы гонят рэгдолл к позам) — смотри на призрака. Сила — в панели ФИЗИКА.'; box.append(hint);
  }
  body.append(box);
}
// Настройки бега per персонаж (GAIT+POSE+GX): сохраняем/грузим при смене персонажа → у каждого класса свой бег.
const GAIT_KEYS = ['pelvisMin', 'stepWalk', 'stepRun', 'bobWalk', 'bobRun', 'liftWalk', 'liftRun', 'cadence', 'dutyWalk', 'dutyRun', 'speedWalk', 'speedRun', 'hipFwdLim', 'stanceWidth', 'strafeReach', 'crossClamp', 'turnStep', 'turnStepDist', 'turnLeadBias'] as const;   // длина шага/боб/подъём — раздельно ходьба/бег; standY убран (база из стойки)
const POSE_KEYS = ['armSh', 'armEl', 'armSwing', 'armElWalk'] as const;
const GX_KEYS = ['armDown', 'elbowBend'] as const;
type NumRec = Record<string, number>;
const GAIT_DEF: NumRec = {}, POSE_DEF: NumRec = {}, GX_DEF = { ...GX };
for (const k of GAIT_KEYS) GAIT_DEF[k] = (GAIT as NumRec)[k]!;
for (const k of POSE_KEYS) POSE_DEF[k] = (POSE as NumRec)[k]!;
// Авторский сдвиг плант-цели (body-local fwd,lat) на ногу — СЕТКА 8 направлений × 2 скорости (шаг/бег).
// lVia/rVia — точки ОБВОДА свинга (body-local fwd,lat): маховая летит через них, огибая опорную. Пусто = прямой свинг.
type XY = [number, number];
type Leg2 = { l: XY; r: XY; lVia?: XY[]; rVia?: XY[] };
type PlantGrid = { walk: Leg2[]; run: Leg2[] };   // walk/run — по 8 ячеек (направление 0=вперёд, шаг 45°)
type PlantStored = Partial<PlantGrid> & { l?: XY; r?: XY };   // старый одиночный {l,r} ИЛИ новый {walk,run}
const DIR8 = ['вперёд', 'вп-вправо', 'вправо', 'назад-вправо', 'назад', 'назад-влево', 'влево', 'вп-влево'];
const DIR_STEP = Math.PI / 4;
const cloneVia = (v: XY[] | undefined): XY[] => (v ?? []).map((p) => [p[0], p[1]] as XY);
const zeroLeg = (): Leg2 => ({ l: [0, 0], r: [0, 0], lVia: [], rVia: [] });
const emptyGrid = (): PlantGrid => ({ walk: Array.from({ length: 8 }, zeroLeg), run: Array.from({ length: 8 }, zeroLeg) });
const gaitPlant: PlantGrid = emptyGrid();                       // живая сетка (интерполируется в stepGait)
let plantDirSel = 0, plantSpeedRun = true;                     // активная ячейка для правки (направление 0-7, бег/шаг)
let plantEditDir = 0, plantEditRun = true;                     // замороженная ячейка на время драга маркера
const activeCell = (): Leg2 => (plantEditRun ? gaitPlant.run : gaitPlant.walk)[plantEditDir]!;
let gaitCfgs: Record<string, { gait: NumRec; pose: NumRec; gx: NumRec; plant?: PlantStored }> = (() => { try { return JSON.parse(localStorage.getItem('pe_gait') || '{}'); } catch { return {}; } })();
function loadPlant(p: PlantStored | undefined): void {          // читаем новый {walk,run} ИЛИ старый {l,r} (→ размазать во все ячейки)
  const g = emptyGrid();
  if (p?.walk && p?.run) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) { const e = p[sp]![i]; if (e) g[sp][i] = { l: [...(e.l ?? [0, 0])] as XY, r: [...(e.r ?? [0, 0])] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }; } }
  else if (p?.l && p?.r) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) g[sp][i] = { l: [...p.l] as XY, r: [...p.r] as XY, lVia: [], rVia: [] }; }
  gaitPlant.walk = g.walk; gaitPlant.run = g.run;
}
function applyGaitCfg(id: string): void {   // выставить GAIT/POSE/GX/plant под персонажа (или дефолты)
  const c = gaitCfgs[id];
  Object.assign(GAIT, GAIT_DEF, c?.gait ?? {});
  Object.assign(POSE, POSE_DEF, c?.pose ?? {});
  Object.assign(GX, GX_DEF, c?.gx ?? {});
  loadPlant(c?.plant);
}
function saveGaitCfg(): void {
  const gait: NumRec = {}, pose: NumRec = {}, gx: NumRec = {};
  for (const k of GAIT_KEYS) gait[k] = (GAIT as NumRec)[k]!;
  for (const k of POSE_KEYS) pose[k] = (POSE as NumRec)[k]!;
  for (const k of GX_KEYS) gx[k] = (GX as NumRec)[k]!;
  const cp = (arr: Leg2[]): Leg2[] => arr.map((e) => ({ l: [...e.l] as XY, r: [...e.r] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }));
  gaitCfgs[curCharId] = { gait, pose, gx, plant: { walk: cp(gaitPlant.walk), run: cp(gaitPlant.run) } };
  try { localStorage.setItem('pe_gait', JSON.stringify(gaitCfgs)); savePoseKey('pe_gait'); } catch { /* */ }
}
let stanceMeasuredFor = '';   // замеряем ширину стойки один раз на текущее оружие (мутирует human → только на смене)
function stepGait(dt: number): void {
  if (attackClip) { attackT += dt * attackSpeed; if (attackT > clipDur(attackClip)) { attackClip = null; attackT = -1; } }   // проигрывание удара
  if (stanceMeasuredFor !== weapon) {   // приставной шаг при повороте на месте держит РАССТАВЛЕННУЮ стойку — её ширину замеряем
    const p = measureStancePlants(human, editorContent.resolveUpper(weapon)?.pose ?? null);
    gaitDriver.setStance(p.latL, p.fwdL, p.latR, p.fwdR, p.standY); stanceMeasuredFor = weapon;
  }
  const vx = locoVx * GAIT_MAXSPD, vz = locoVz * GAIT_MAXSPD;   // квадрат = скорость движения (центр→ходьба, край→бег); темп ушёл в скорость ПРОСМОТРА
  const spd = Math.hypot(vx, vz); gaitSpd = spd;   // gaitSpd → точный референс плант-маркера
  gaitMoveMag = clamp(spd / GAIT.speedWalk, 0, 1);   // 0 стоишь → idle-ноги; ≥speedWalk бежишь → физ-шаг
  // Facing (yaw): «лицом по движению» → тело поворачивается к скорости (всегда бег вперёд, виден поворот);
  // иначе — фикс. угол `gaitYawManual` (страйф: тело смотрит в одну сторону, шаги идут в другую).
  if (gaitFaceMove) { if (spd > 1) gaitYaw = Math.atan2(vx, vz); } else gaitYaw = gaitYawManual;
  gaitPx += vx * dt; gaitPz += vz * dt;
  gaitDriver.setWorld(gaitPx, gaitPz, gaitYaw, vx, vz);      // yaw кормит планировщик — стопы в правильном body-кадре
  // Планты по 8 направлениям × 2 скорости: body-local угол движения + скорость → билинейная интерп 4 ячеек.
  const fwdC = vx * Math.sin(gaitYaw) + vz * Math.cos(gaitYaw), latC = vx * Math.cos(gaitYaw) - vz * Math.sin(gaitYaw);
  let a = Math.atan2(latC, fwdC) / DIR_STEP; a = ((a % 8) + 8) % 8;
  const i0 = Math.floor(a) % 8, i1 = (i0 + 1) % 8, ft = a - Math.floor(a);
  const spB = clamp((spd - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
  const bl = (leg: 'l' | 'r', k: 0 | 1): number => {
    const w = gaitPlant.walk[i0]![leg][k] + (gaitPlant.walk[i1]![leg][k] - gaitPlant.walk[i0]![leg][k]) * ft;
    const r = gaitPlant.run[i0]![leg][k] + (gaitPlant.run[i1]![leg][k] - gaitPlant.run[i0]![leg][k]) * ft;
    return w + (r - w) * spB;
  };
  gaitDriver.setPlantOffset(bl('l', 0), bl('l', 1), bl('r', 0), bl('r', 1));
  gaitDriver.setPlantVia(blendVia(gaitPlant, 'lVia', i0, i1, ft, spB), blendVia(gaitPlant, 'rVia', i0, i1, ft, spB));
  if (plantDrag < 0 && spd > 1) { plantDirSel = (Math.round(a) % 8 + 8) % 8; plantSpeedRun = spB >= 0.5; }   // активная ячейка следит за падом
  human.root.updateMatrixWorld(true);                        // фидбэк фактических стоп в мир гейта (иначе шпагат)
  const fl = human.bones.get('LeftFoot')!.getWorldPosition(V()), fr = human.bones.get('RightFoot')!.getWorldPosition(V());
  gaitDriver.setFeet(fl.x + gaitPx, fl.z + gaitPz, fr.x + gaitPx, fr.z + gaitPz);
  gaitToHumanoid(gaitDriver.update(dt));
  human.bones.get('Hips')!.rotation.y = gaitYaw;             // визуальный facing (углы ног body-local → корень крутим на yaw)
  if (gaitReadout && gaitReadout.isConnected) {              // живой индикатор скорости + режим ходьба↔бег
    const mode = spd < 5 ? 'стоит' : spd < GAIT.speedWalk ? 'ходьба' : 'бег';
    gaitReadout.textContent = `скорость: ${spd.toFixed(0)} u/с · ${mode}` + (gaitFaceMove ? '' : ` · страйф ${Math.round(gaitYaw * 180 / Math.PI)}°`);
  }
}
function stepLoco(dt: number): void {
  const nodes = locoHere(); if (!nodes.length) return;
  const mag = Math.min(1, Math.hypot(locoVx, locoVz));
  locoPhase = (locoPhase + dt * 1.6 * (0.12 + 0.88 * mag) * locoTempo) % 1;          // на idle почти стоит, на бегу быстрые ноги
  const pose = blendLocoPose(nodes, locoWeights(nodes, locoVx, locoVz), locoPhase);
  if (Object.keys(pose).length) applyPose(pose);
}
let ghostHuman: Humanoid | null = null;   // физ-призрак — ТАКОЙ ЖЕ гуманоид (форма/пропорции), ведомый результатом физики
function buildGhost(): void {
  if (ghostHuman) { scene.remove(ghostHuman.root); ghostHuman.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  const c = curChar();
  ghostHuman = buildHumanoid({ gender: c.gender, build: c.build, limb: 0x39d0ff, body: 0x2bb6e6, head: 0x9fe0ff });
  for (const m of ghostHuman.meshes) { const mat = m.material as THREE.MeshStandardMaterial; mat.transparent = true; mat.opacity = 0.55; mat.depthWrite = false; }
  scene.add(ghostHuman.root); ghostHuman.root.visible = physOn;
}
function setPhysVis(on: boolean): void { if (ghostHuman) ghostHuman.root.visible = on; }
// ── Онион-скин: полупрозрачные призраки соседних кадров (пред=синий, след=оранжевый) при позинге в «Анимации» ──
let onionOn = false; let onionPrev: Humanoid | null = null; let onionNext: Humanoid | null = null;
function mkOnion(tint: number): Humanoid {
  const c = curChar();
  const h = buildHumanoid({ gender: c.gender, build: c.build, limb: tint, body: tint, head: tint });
  for (const m of h.meshes) { const mat = m.material as THREE.MeshStandardMaterial; mat.transparent = true; mat.opacity = 0.32; mat.depthWrite = false; mat.emissive.setHex(tint); mat.emissiveIntensity = 0.25; }
  scene.add(h.root); h.root.visible = false; return h;
}
function disposeOnion(): void {
  for (const h of [onionPrev, onionNext]) if (h) { scene.remove(h.root); h.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
  onionPrev = onionNext = null;
}
function applyPoseTo(h: Humanoid, p: Pose): void {   // применить позу (без оружия) к произвольному гуманоиду, выровняв таз к манекену
  h.reset();
  for (const nm in p) { if (nm[0] === '_') continue; const b = h.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
  h.bones.get('Hips')!.position.copy(human.bones.get('Hips')!.position);
}
function updateOnion(): void {
  const c = onionOn && tab === 'anim' ? curClip() : null;
  if (!c || c.keys.length < 2) { if (onionPrev) onionPrev.root.visible = false; if (onionNext) onionNext.root.visible = false; return; }
  if (!onionPrev) { onionPrev = mkOnion(0x4a8cff); onionNext = mkOnion(0xff8c3a); }
  const pv = c.keys[frameIdx - 1], nx = c.keys[frameIdx + 1];
  if (pv) { applyPoseTo(onionPrev!, pv.pose); onionPrev!.root.visible = true; } else onionPrev!.root.visible = false;
  if (nx) { applyPoseTo(onionNext!, nx.pose); onionNext!.root.visible = true; } else onionNext!.root.visible = false;
}
async function ensurePhysics(): Promise<void> {
  if (pw) return;
  await initPhysics();
  pw = new PhysWorld();
  pw.addGround(300);                                        // плоский пол (верх на y=0)
  loadRagdollConfig();                                      // RB3: лимиты/моторы из pe_ragdoll ДО создания рэгдолла
  ragdoll = makeHumanoidRagdoll(pw);
  scene.add(ragdoll.group); ragdoll.group.visible = false;   // боксы-физтела скрыты — показываем гуманоид-призрак
  buildGhost();
}
// RB3: пересборка рэгдолла с текущими LIMITS/MOTOR (они читаются при СОЗДАНИИ в makeCon; live-правка сустава роняет wasm).
function rebuildRagdoll(): void {
  if (!pw || !ragdoll) return;
  scene.remove(ragdoll.group); ragdoll.dispose();
  ragdoll = makeHumanoidRagdoll(pw);
  scene.add(ragdoll.group); ragdoll.group.visible = false;
}
const pinVecs = RAG_NAMES.map(() => new THREE.Vector3()); const pinArr: (THREE.Vector3 | null)[] = RAG_NAMES.map(() => null);
function stepPhysics(dt: number): void {
  if (!pw || !physOn || !ragdoll) return;
  human.root.updateMatrixWorld(true);                        // манекен = целевая поза (правка или интерполяция клипа)
  const hips = human.bones.get('Hips')!;
  const stand = hips.getWorldPosition(V()); const standQ = hips.getWorldQuaternion(Q());
  if (reviveT >= 0) {                                         // вставание: плавно поднимаем таз с пола к стойке
    reviveT += dt; const t = Math.min(1, reviveT / reviveDur), e = t * t * (3 - 2 * t);
    ragdoll.setPelvis(reviveFrom.clone().lerp(stand, e), standQ);
    if (t >= 1) reviveT = -1;
  } else ragdoll.setPelvis(stand, standQ);
  ragdoll.setPoseTarget(human.readPose());
  for (let i = 0; i < RAG_NAMES.length; i++) {               // цели пинов = мир-позиции суставов манекена
    const src = PIN_SRC[RAG_NAMES[i]!]; const b = src ? human.bones.get(src) : undefined;
    if (b) { b.getWorldPosition(pinVecs[i]!); pinArr[i] = pinVecs[i]!; } else pinArr[i] = null;
  }
  ragdoll.setPinTargets(pinArr);
  const [mHR, mHL] = weaponHandMasses(weapon);   // масса рук по main+off (щит/второе оружие → левая)
  ragdoll.setLoad('HandR', mHR); ragdoll.setLoad('HandL', mHL);
  ragdoll.update(dt);   // моторы ведут к позе + пины + вес оружия + kinematic-таз
  pw.step(Math.min(dt, 1 / 60));
  // призрак-гуманоид = физ-результат + заземление стопы (ОБЩИЙ код с игрой). На «упал» прижим off — пусть коллапсит.
  // + БЛЕНД к манекену по PHYS.match (0 физика … 1 ровно поза): цель — human.readPose() (только пока жив и match>0).
  if (ghostHuman) {
    const sw = gaitDriver.swingLegs;   // при loco: опора = !swing → заземляем только опорную стопу (маховую ведёт поза)
    renderRagdollGhost(ghostHuman, ragdoll, ghostGround, Math.min(dt, 1 / 60), 0, !physDead,
      !physDead && PHYS.match > 0.001 ? human.readPose() : null, physDead ? 0 : PHYS.match, undefined, locoOn ? [!sw[0], !sw[1]] : undefined);
  }
}
const ghostGround = newGhostGround();
/** Ф4 — ЗАПЕКАНИЕ: прогнать клип через физику, покадрово снять физ-результат → обычная покадровая анимация. */
async function bakeCurrentClip(): Promise<void> {
  await ensurePhysics();
  const c = curClip(); if (!c || !ragdoll) return;
  physOn = true; setPhysVis(true);
  const dur = clipDur(c) || 0.5, dt = 1 / 60, sampleEvery = 2;   // сэмпл 30 к/с
  const baked: Keyframe[] = [];
  preview(0); for (let i = 0; i < 40; i++) stepPhysics(dt);       // устаканиться на стартовой позе
  let simT = 0, step = 0;
  while (simT <= dur + 1e-6) {
    preview(Math.min(simT, dur));                                // манекен = интерполированная авторская поза
    stepPhysics(dt);
    if (step % sampleEvery === 0) baked.push({ pose: ragdoll.readBakedPose(), t: +simT.toFixed(3) });
    simT += dt; step++;
  }
  library.push({ name: c.name + '_baked', character: curCharId, weapon, loop: c.loop, keys: baked });
  clipIdx = clipsHere().length - 1; frameIdx = 0; saveLib(); refreshAll();
}

// ── Вторичное движение (jiggle груди) — пружина от вертик./бокового ускорения груди (основа под плащ/волосы) ──
const JIG = { stiff: 360, damp: 34, scale: 0.0016, max: 0.5 };
let jY = 0, jVy = 0, jX = 0, jVx = 0;
const jAng = { L: 0, R: 0 }, jVel = { L: 0, R: 0 }, jAngX = { L: 0, R: 0 }, jVelX = { L: 0, R: 0 };
function jiggle(dt: number): void {
  const uc = human.bones.get('UpperChest'); const bl = human.bones.get('LeftBreast');
  if (!uc || !bl || dt <= 0) return;                         // только female (есть breast-кости)
  const p = uc.getWorldPosition(V());
  const vy = (p.y - jY) / dt, ay = (vy - jVy) / dt; jY = p.y; jVy = vy;
  const vx = (p.x - jX) / dt, ax = (vx - jVx) / dt; jX = p.x; jVx = vx;
  for (const s of ['L', 'R'] as const) {
    const b = human.bones.get(s === 'L' ? 'LeftBreast' : 'RightBreast'); if (!b) continue;
    jVel[s] += (-JIG.stiff * jAng[s] - JIG.damp * jVel[s] - ay * JIG.scale) * dt; jAng[s] += jVel[s] * dt;   // питч от верт. ускор.
    jVelX[s] += (-JIG.stiff * jAngX[s] - JIG.damp * jVelX[s] - ax * JIG.scale) * dt; jAngX[s] += jVelX[s] * dt;   // свэй от бок. ускор.
    b.rotation.set(clamp(jAng[s], -JIG.max, JIG.max), 0, clamp(jAngX[s], -JIG.max, JIG.max));
  }
}

// ── Цикл ──
ensureSeed();   // первый запуск: залить примерный контент Волкодава (idle-стойки + удары по оружию)
applyChar(curCharId); setMode('ik'); tab = 'anim'; refreshAll();
function resize(): void { const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); new ResizeObserver(resize).observe(canvas); resize();
let last = performance.now();
function loop(): void {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  const c = curClip();
  if (locoOn) stepGait(dt * locoTempo);   // бег = процедурный гейт (ноги) + idle-стойка + физ; locoTempo = скорость ПРОСМОТРА (slow-mo/×)
  else if (playing && c) {
    const dur = clipDur(c);
    if (dur < 1e-3 || c.keys.length < 2) { playing = false; playBtn.textContent = '▶'; }
    else { playT += dt * playSpeed; if (playT > dur) { if (c.loop) playT %= dur; else { playT = dur; playing = false; playBtn.textContent = '▶'; } } scrub.value = String(playT / dur); preview(playT); }
  }
  else if (mode === 'ik') {
    // Солвим IK ТОЛЬКО когда реально тянешь эффектор. Иначе (вхолостую) 2-костный IK пересчитывал руки/ноги из
    // позиций эффекторов и ТЕРЯЛ скрутку плеча/ориентацию — та же поза выглядела иначе, чем в FK. Теперь FK-поза
    // сохраняется, а солв идёт лишь на перетаскивании (тогда правка осознанная).
    if (gizmo.dragging) solveRig();
    const active = gizmo.dragging ? gizmo.object : null;
    if (rig.hipsHandle !== active) rig.hipsHandle.position.copy(rig.hipsPos);
    for (const e of effList()) { if (e.handle !== active) e.handle.position.copy(e.target); if (e.poleHandle !== active) e.poleHandle.position.copy(human.bones.get(e.mid)!.getWorldPosition(V())); }
  }
  updatePlantMarks();
  scrollFloor();   // тредмилл-пол под бегущим (тянется по gaitPx/gaitPz)
  stepPhysics(dt);
  jiggle(dt);   // вторичное движение груди (female)
  orbit.update(); renderer.render(scene, camera); requestAnimationFrame(loop);
}
loop();

(window as unknown as { __pe: unknown }).__pe = { scene, camera, renderer, gizmo, rig, get human() { return human; }, get library() { return library; }, get weapons() { return weaponGroups; }, render: () => renderer.render(scene, camera), setMode, applyChar, setWeapon, solveRig, captureRig, syncEff, pose: () => readPoseFull(), wpos: (b: string) => human.bones.get(b)!.getWorldPosition(V()).toArray().map((v) => +v.toFixed(1)),
  ensurePhysics, bakeCurrentClip, PHYS, LIMITS, MOTOR, rebuildRagdoll, jiggle, get pw() { return pw; }, get ragdoll() { return ragdoll; },
  locoSetVel: (x: number, z: number): void => { locoVx = x; locoVz = z; }, locoStep: (dt: number): void => stepLoco(dt), locoGaitStep: (dt: number): void => stepGait(dt), get locoNodes() { return locoNodes; }, locoAdd: (clip: string, vx: number, vz: number): void => { locoNodes.push({ character: curCharId, weapon, clip, vx, vz }); },
  setPlantCell: (dir: number, run: boolean, lF: number, lL: number, rF: number, rL: number): void => { const cell = (run ? gaitPlant.run : gaitPlant.walk)[((dir % 8) + 8) % 8]!; cell.l = [lF, lL]; cell.r = [rF, rL]; }, get plant() { return gaitPlant; }, get plantSel() { return { dir: plantDirSel, run: plantSpeedRun }; },
  captureUpper, get sway() { return swayCfg; }, resolveUpper: (w: string): unknown => resolveUpper(w), get stances() { return library.filter((c) => c.name.startsWith('idle_')); },
  gaitAttack: (name: string): void => { const c = clipsHere().find((x) => x.name === name) ?? library.find((x) => x.name === name); if (c) triggerAttack(c); }, get attackT() { return attackT; }, markAttack: (name: string): void => toggleAtk(name),
  physStep: (dt: number, n: number): unknown => { if (!pw || !ragdoll) return null; physOn = true; for (let i = 0; i < n; i++) { stepPhysics(dt); } return { Hips: ragdoll.bodyPos('Hips'), Head: ragdoll.bodyPos('Head'), HandL: ragdoll.bodyPos('HandL'), HandR: ragdoll.bodyPos('HandR'), FootL: ragdoll.bodyPos('FootL'), Torso: ragdoll.bodyPos('Torso') }; } };
