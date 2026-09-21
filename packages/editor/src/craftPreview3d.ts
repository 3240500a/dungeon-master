import * as THREE from 'three';
import { anatomyOf, partById, type ConfigRegistry } from '@dm/shared';
import { makeWeaponMesh } from '@dm/client/render3d/weapon3d.js';
import type { CraftWindowState } from '@dm/client/modules/town/craftPanel.js';

/**
 * 3D-ПРЕВЬЮ СБОРКИ (docs/CRAFT_WEAPONS.md §18, фаза визуала Ф1): процедурный меш ИГРЫ
 * (`weapon3d.ts`) с параметрами от деталей и цветом от материала. Никаких новых мешей: ровно то,
 * что ГДД называет «почти ноль работы художнику» — ширина ударной части от её оси, длина держака,
 * ширина гарды, навершие-противовес, тинт по ступени материала.
 *
 * ⚠ `weapon3d.ts` принадлежит рендеру игры и здесь только ЧИТАЕТСЯ: материалы меша клонируются,
 * прежде чем их красить, иначе покраска уехала бы во все руки в редакторе.
 */

// Цвета ступеней 1..5 по семьям — от исторического материала (§10).
const TINT: Record<string, number[]> = {
  iron: [0x6b5a4e, 0x86837c, 0xa3aab0, 0x9aa6b4, 0xd2d8de],   // болотное → кричное → уклад → дамаск → булат
  wood: [0xb08a5a, 0xa98b62, 0x7a5638, 0x2a2420, 0x6a5238],   // сосна → ясень → граб → морёный дуб → клееное
  stave: [0x8a6a44, 0xa0522d, 0xd8c8a0, 0x4a4a46, 0x9aa2aa],  // вяз → тис → рог и жила → китовый ус → сталь
  trim: [0x2e2e30, 0x9c6b30, 0x2a3440, 0xc8ccd2, 0xd4af37],   // чёрное железо → бронза → воронёная → серебро → золото
  focus: [0x7fb3a8, 0x151515, 0x2a1f35, 0xe8f0ff, 0xe8a33a],  // паста → гагат → обсидиан → хрусталь → янтарь
  hide: [0x8a6a4a, 0x6b4a2e, 0x4a3220, 0x3a2418, 0x9aa0a0],
  cloth: [0xb8a888, 0xd0c0a0, 0xe8e0c8, 0xf0ead8, 0xe0d6f0],
};

let renderer: THREE.WebGLRenderer | null = null;
let raf = 0;
let scene: THREE.Scene | null = null;

function kindFor(weaponClass: string, hands: number): string {
  if (weaponClass === 'sword') return hands === 2 ? 'greatsword' : 'sword';
  if (weaponClass === 'axe') return hands === 2 ? 'greataxe' : 'axe';
  if (weaponClass === 'mace') return hands === 2 ? 'greatmaul' : 'mace';
  if (weaponClass === 'wand') return 'staff'; // у жезла меша в игре нет вовсе — показываем укороченный посох
  return weaponClass;
}

const disposeScene = (s: THREE.Scene): void => {
  s.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose(); });
};

export function weaponPreview3d(reg: ConfigRegistry, st: CraftWindowState): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'background:#0e1117;border:1px solid #2b323f;border-radius:8px;padding:8px';
  const title = document.createElement('div');
  title.style.cssText = 'color:#e39a3c;font-size:12px;font-weight:600;margin-bottom:4px';
  title.textContent = '3D-превью сборки';
  box.append(title);

  const base = reg.get('items.base').find((b) => b.id === st.baseId);
  const anat = anatomyOf(reg, st.weaponClass);
  if (!base || base.kind !== 'weapon' || !anat) return box;

  cancelAnimationFrame(raf);
  if (scene) { disposeScene(scene); scene = null; }
  if (!renderer) {
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { box.append(document.createTextNode('WebGL недоступен')); return box; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(232, 300);
  }
  box.append(renderer.domElement);

  const s = new THREE.Scene();
  scene = s;
  s.add(new THREE.HemisphereLight(0xfff0d8, 0x202030, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(40, 60, 80); s.add(key);
  const rim = new THREE.DirectionalLight(0xe39a3c, 1.2); rim.position.set(-60, -20, -40); s.add(rim);

  const g = makeWeaponMesh(kindFor(st.weaponClass, base.hands ?? 1));
  if (st.weaponClass === 'wand') g.scale.setScalar(0.55);
  const axis = (slot: 'strike' | 'grip' | 'bind' | 'head'): number => partById(reg, st.parts[slot])?.axis ?? 0;
  const tint = (fam: string): number => TINT[fam]?.[Math.max(0, Math.min(4, st.step - 1))] ?? 0x888888;

  // Роль меша по его материалу: сталь — ударная часть, дерево — держак, латунь — обвязка.
  // У лука и арбалета «дерево» — это плечи/дуга, то есть ударная часть.
  const ranged = st.weaponClass === 'bow' || st.weaponClass === 'crossbow';
  let top = -Infinity;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    const hex = src.color?.getHex?.() ?? 0;
    const mat = src.clone();
    m.material = mat;
    if (hex === 0xc2c8d2) { // сталь
      if (!ranged) { mat.color.setHex(tint(anat.strike.family)); m.scale.x *= 1 + 0.35 * axis('strike'); m.scale.z *= 1 + 0.2 * axis('strike'); }
      else mat.color.setHex(tint(anat.bind.family));
    } else if (hex === 0x6e4a2c) { // дерево
      if (ranged) { mat.color.setHex(tint(anat.strike.family)); m.scale.x *= 1 + 0.25 * axis('strike'); }
      else { mat.color.setHex(tint(anat.grip.family)); m.scale.y *= 1 + 0.18 * axis('grip'); }
    } else if (hex === 0xc9a34a) { // латунь — гарда/обвязка
      mat.color.setHex(tint(anat.bind.family)); m.scale.x *= 1 - 0.3 * axis('bind');
    } else if (st.weaponClass === 'wand' || st.weaponClass === 'staff') {
      mat.color.setHex(tint(anat.strike.family)); mat.emissive?.setHex(tint(anat.strike.family)); mat.emissiveIntensity = 0.35;
      m.scale.setScalar(1 + 0.3 * axis('strike'));
    }
    m.updateMatrixWorld();
    const bb = new THREE.Box3().setFromObject(m);
    top = Math.max(top, bb.max.y);
  });

  // Оголовье: навершие-противовес на конце держака. Упор (+) — тяжелее и крупнее, укус (−) — острое.
  const a4 = axis('head');
  const headMat = new THREE.MeshStandardMaterial({ color: tint(anat.head.family), metalness: 0.7, roughness: 0.35 });
  const head = a4 < 0 ? new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.2, 6), headMat) : new THREE.Mesh(new THREE.SphereGeometry(1.2 * (1 + 0.45 * a4), 14, 10), headMat);
  head.position.y = (Number.isFinite(top) ? top : 2) + (a4 < 0 ? 1.4 : 0.9);
  g.add(head);

  // Вертикально, по центру, с подгоном камеры под размер.
  const bb = new THREE.Box3().setFromObject(g);
  const size = bb.getSize(new THREE.Vector3());
  const center = bb.getCenter(new THREE.Vector3());
  g.position.sub(center);
  const pivot = new THREE.Group(); pivot.add(g); s.add(pivot);
  const cam = new THREE.PerspectiveCamera(30, 232 / 300, 0.1, 2000);
  const dist = Math.max(size.y, size.x) * 1.9 + 10;
  cam.position.set(0, 0, dist); cam.lookAt(0, 0, 0);

  const loop = (): void => {
    // Холст убран со страницы (переключили вкладку) — цикл гаснет, а не рисует в пустоту.
    if (scene !== s || !renderer || !renderer.domElement.isConnected) return;
    pivot.rotation.y += 0.012;
    renderer.render(s, cam);
    raf = requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const caption = document.createElement('div');
  caption.style.cssText = 'color:#8f897c;font-size:11px;margin-top:4px;line-height:1.4';
  const mat = reg.get('craft-materials');
  const nm = (fam: string): string => mat.find((m) => m.id === `${fam}-${st.step}`)?.name ?? fam;
  caption.innerHTML = `Процедурный меш игры: ширина от оси ударной части, длина от держака, гарда от обвязки, навершие от оголовья.<br>${nm(anat.strike.family)} · ${nm(anat.grip.family)} · ${nm(anat.bind.family)}`;
  box.append(caption);
  return box;
}
