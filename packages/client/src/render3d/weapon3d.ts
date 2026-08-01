// ── Меши оружия в руках гуманоида (общий для редактора поз и игры) ──
// Строятся вдоль −Y; хват доворачивает клинок/древко вперёд (+Z). userData.baseRot/basePos — база для бленда
// idle-верха/удара в poseRuntime. attachWeapons цепляет группы к костям кистей и возвращает их (порядок: основная, офф).
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';

// Одиночные наборы оружия. Офф-рука (щит/второе оружие) добавляется отдельным селектором → ключ 'main+off'.
export const WEAPONS = ['none',
  'sword', 'dagger', 'axe', 'mace',                              // одноручное
  'greatsword', 'greataxe', 'greatmaul', 'halberd', 'spear',     // двуручное
  'staff', 'bow', 'crossbow', 'shield'];                         // маг / дальний / офф-хенд (щит один)
// Варианты офф-руки (левая): нет / щит / одноручное оружие (дуал). Ключ = main + '+' + off.
export const OFFHANDS = ['none', 'shield', 'dagger', 'sword', 'axe', 'mace'];

const steelMat = new THREE.MeshStandardMaterial({ color: 0xc2c8d2, metalness: 0.85, roughness: 0.35 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0x6e4a2c, roughness: 0.85 });
const brassMat = new THREE.MeshStandardMaterial({ color: 0xc9a34a, metalness: 0.7, roughness: 0.4 });

export function makeWeaponMesh(kind: string): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number, ry = 0): void => { const m = new THREE.Mesh(geo, mat); m.position.y = y; if (ry) m.rotation.z = ry; g.add(m); };
  if (kind === 'sword') { add(new THREE.BoxGeometry(1.4, 30, 0.5), steelMat, -17); add(new THREE.ConeGeometry(0.8, 3, 4), steelMat, -33.5); add(new THREE.BoxGeometry(5, 1.1, 1.6), brassMat, -2); add(new THREE.CylinderGeometry(0.8, 0.8, 3, 8), woodMat, 0); }
  else if (kind === 'dagger') { add(new THREE.BoxGeometry(1.2, 13, 0.5), steelMat, -8.5); add(new THREE.ConeGeometry(0.7, 2, 4), steelMat, -15.5); add(new THREE.BoxGeometry(3.2, 1, 1.4), brassMat, -2); add(new THREE.CylinderGeometry(0.7, 0.7, 3, 8), woodMat, 0); }
  else if (kind === 'axe') { add(new THREE.CylinderGeometry(1.2, 1.2, 30, 8), woodMat, -14); const head = new THREE.Mesh(new THREE.BoxGeometry(13, 8, 2.5), steelMat); head.position.set(-5, -24, 0); g.add(head); }
  else if (kind === 'mace') { add(new THREE.CylinderGeometry(1.2, 1.2, 24, 8), woodMat, -11); add(new THREE.IcosahedronGeometry(4.4, 0), steelMat, -24); }
  else if (kind === 'staff') { add(new THREE.CylinderGeometry(1.4, 1.4, 46, 8), woodMat, -18); const orb = new THREE.Mesh(new THREE.SphereGeometry(3.6, 12, 12), new THREE.MeshStandardMaterial({ color: 0x66aaff, emissive: 0x2a4aa0, emissiveIntensity: 0.6, roughness: 0.3 })); orb.position.y = -42; g.add(orb); }
  else if (kind === 'spear') { add(new THREE.CylinderGeometry(1, 1, 52, 8), woodMat, -20); add(new THREE.ConeGeometry(1.6, 8, 6), steelMat, -50); }
  else if (kind === 'greatsword') { add(new THREE.BoxGeometry(1.9, 46, 0.7), steelMat, -27); add(new THREE.ConeGeometry(1.0, 4, 4), steelMat, -52); add(new THREE.BoxGeometry(8, 1.4, 2), brassMat, -3); add(new THREE.CylinderGeometry(0.9, 0.9, 7, 8), woodMat, 1.5); }
  else if (kind === 'greataxe') { add(new THREE.CylinderGeometry(1.4, 1.4, 48, 8), woodMat, -22); const head = new THREE.Mesh(new THREE.BoxGeometry(20, 11, 3), steelMat); head.position.set(6, -38, 0); const back = new THREE.Mesh(new THREE.BoxGeometry(9, 8, 3), steelMat); back.position.set(-8, -38, 0); g.add(head, back); }
  else if (kind === 'greatmaul') { add(new THREE.CylinderGeometry(1.5, 1.5, 46, 8), woodMat, -21); const head = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 13, 12), steelMat); head.rotation.z = Math.PI / 2; head.position.y = -42; g.add(head); }
  else if (kind === 'halberd') { add(new THREE.CylinderGeometry(1.2, 1.2, 58, 8), woodMat, -27); add(new THREE.ConeGeometry(1.4, 7, 6), steelMat, -58); const blade = new THREE.Mesh(new THREE.BoxGeometry(15, 11, 2), steelMat); blade.position.set(6, -46, 0); const spike = new THREE.Mesh(new THREE.ConeGeometry(1.6, 6, 4), steelMat); spike.position.set(-7, -46, 0); spike.rotation.z = Math.PI / 2; g.add(blade, spike); }
  else if (kind === 'bow') {
    const SWEEP = Math.PI * 130 / 180, R = 20;
    const arc = new THREE.Mesh(new THREE.TorusGeometry(R, 0.85, 6, 28, SWEEP), woodMat);
    arc.rotation.z = -SWEEP / 2; arc.position.x = -R;
    const tipX = R * Math.cos(SWEEP / 2) - R, tipY = R * Math.sin(SWEEP / 2);
    const string = new THREE.Mesh(new THREE.BoxGeometry(0.35, tipY * 2, 0.35), steelMat);
    string.position.x = tipX; g.add(arc, string);
  }
  else if (kind === 'crossbow') {
    add(new THREE.BoxGeometry(2.6, 30, 3.4), woodMat, -15);
    const prod = new THREE.Mesh(new THREE.BoxGeometry(32, 2, 2.4), steelMat); prod.position.set(0, -25, 0);
    const strn = new THREE.Mesh(new THREE.BoxGeometry(30, 0.4, 0.4), steelMat); strn.position.set(0, -20, 0);
    const nut = new THREE.Mesh(new THREE.BoxGeometry(3, 4, 3.6), steelMat); nut.position.set(0, -20, 0);
    g.add(prod, strn, nut);
  }
  else if (kind === 'shield') { const disc = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 1.5, 22), woodMat); const rim = new THREE.Mesh(new THREE.TorusGeometry(10, 0.9, 8, 24), steelMat); rim.rotation.x = Math.PI / 2; const boss = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8), steelMat); boss.position.y = -1; boss.scale.y = 0.6; g.add(disc, rim, boss); }
  return g;
}

/** Собрать и прицепить оружие(я) выбранного набора к кистям гуманоида. Возвращает группы (для позинга в poseRuntime). */
export function attachWeapons(human: Humanoid, weapon: string): THREE.Group[] {
  const groups: THREE.Group[] = [];
  const attach = (kind: string, boneName: string): void => {
    if (kind === 'none') return;
    const g = makeWeaponMesh(kind); const bone = human.bones.get(boneName);
    if (!bone) return;
    if (kind === 'shield') { g.rotation.set(Math.PI / 2, 0, 0); g.position.set(0, 0, 0); }   // диск лицом вперёд, в кулаке
    else if (kind === 'bow') { g.rotation.set(0, 0, 0); }                                        // лук уже вертикальный (дуга в XY)
    else g.rotation.set(-Math.PI / 2, 0, 0);                                                    // клинок/древко — вперёд (+Z), параллельно земле
    g.userData.baseRot = g.rotation.clone(); g.userData.basePos = g.position.clone();           // база хвата — для бленда idle-верха/удара
    bone.add(g); groups.push(g);
  };
  if (weapon === 'dual') weapon = 'sword+dagger';   // легаси-алиас старого комбо
  if (weapon === 'none') return groups;
  const plus = weapon.lastIndexOf('+');
  if (plus > 0) { attach(weapon.slice(0, plus), 'RightHand'); attach(weapon.slice(plus + 1), 'LeftHand'); }   // main+off: щит ИЛИ второе оружие в левую руку
  else if (weapon === 'shield') { attach('shield', 'LeftHand'); }
  else if (weapon === 'bow') { attach('bow', 'LeftHand'); }
  else attach(weapon, 'RightHand');
  return groups;
}
