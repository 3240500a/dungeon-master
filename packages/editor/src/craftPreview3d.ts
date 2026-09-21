import * as THREE from 'three';
import { CRAFT_SLOT_LIST, anatomyOf, partById, slotName, stepLabel, type ConfigRegistry, type CraftSlot } from '@dm/shared';
import { buildCraftMesh, type CraftMeshResult } from '@dm/client/modules/town/craftMesh/index.js';
import type { CraftWindowState } from '@dm/client/modules/town/craftPanel.js';

/**
 * 3D-ПРЕВЬЮ СБОРКИ (docs/CRAFT_WEAPONS.md §18, визуал Ф1): модель собирается из ТЕХ ЖЕ деталей,
 * что и вещь (`client/modules/town/craftMesh`): форма клинка по типу, своя гарда и навершие,
 * полотно и обух топора, рога и концы лука; цвет — материал каждой детали. Модель та же, что
 * потом встанет в окно кузницы игры, — песочница лишь показывает её.
 *
 * Управление: тянуть мышью — повернуть, колесо — приблизить, двойной клик — снова крутить самой.
 */

const W = 260, H = 440;

let renderer: THREE.WebGLRenderer | null = null;
let raf = 0;
let scene: THREE.Scene | null = null;
let current: CraftMeshResult | null = null;
/** Ракурс переживает перерисовку окна: крутишь модель — выбор детали её не сбрасывает. */
const view = { yaw: 0.6, pitch: 0.12, zoom: 1, auto: true };

export function weaponPreview3d(reg: ConfigRegistry, st: CraftWindowState): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'background:#0e1117;border:1px solid #2b323f;border-radius:8px;padding:8px';
  const title = document.createElement('div');
  title.style.cssText = 'color:#e39a3c;font-size:12px;font-weight:600;margin-bottom:4px';
  title.textContent = '3D-превью сборки';
  box.append(title);

  const anat = anatomyOf(reg, st.weaponClass);
  cancelAnimationFrame(raf);
  if (current) { current.dispose(); current = null; }
  scene = null;
  const built = anat ? buildCraftMesh(reg, st.weaponClass, st.hands, st.parts) : null;
  if (!anat || !built) { box.append(document.createTextNode('Сборка не строится')); return box; }
  current = built;

  if (!renderer) {
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { box.append(document.createTextNode('WebGL недоступен')); return box; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(W, H);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.style.cssText = 'display:block;cursor:grab;border-radius:6px;background:radial-gradient(ellipse at 50% 40%, #1d2330 0%, #0e1117 70%)';
    bindControls(renderer.domElement);
  }
  box.append(renderer.domElement);

  const s = new THREE.Scene();
  scene = s;
  s.add(new THREE.HemisphereLight(0xfff0d8, 0x202030, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(60, 80, 120); s.add(key);
  const rim = new THREE.DirectionalLight(0xe39a3c, 1.4); rim.position.set(-90, -30, -80); s.add(rim);
  const fill = new THREE.DirectionalLight(0x8fb0ff, 0.6); fill.position.set(-60, 40, 90); s.add(fill);

  // Рабочим концом вверх — так оружие читается на стенде.
  const g = built.group;
  g.rotation.z = Math.PI;
  const bb = new THREE.Box3().setFromObject(g);
  const size = bb.getSize(new THREE.Vector3());
  const center = bb.getCenter(new THREE.Vector3());
  const holder = new THREE.Group(); holder.add(g); g.position.sub(center);
  const pivot = new THREE.Group(); pivot.add(holder); s.add(pivot);
  const cam = new THREE.PerspectiveCamera(28, W / H, 0.5, 5000);
  const fitDist = Math.max(size.y / (2 * Math.tan((28 * Math.PI) / 360)), size.x * 1.4, 30) * 1.12;

  const loop = (): void => {
    // Холст убран со страницы (переключили вкладку) — цикл гаснет, а не рисует в пустоту.
    if (scene !== s || !renderer || !renderer.domElement.isConnected) return;
    if (view.auto) view.yaw += 0.01;
    pivot.rotation.set(view.pitch, view.yaw, 0);
    const d = fitDist / view.zoom;
    cam.position.set(0, 0, d); cam.lookAt(0, 0, 0);
    renderer.render(s, cam);
    raf = requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const caption = document.createElement('div');
  caption.style.cssText = 'color:#8f897c;font-size:11px;margin-top:6px;line-height:1.5';
  const line = (slot: CraftSlot): string => {
    const p = partById(reg, st.parts[slot].id);
    return p ? `<b style="color:#c9bfae">${slotName(anat, slot, st.hands)}</b>: ${p.name} · ${stepLabel(reg, anat, slot, p, st.parts[slot].step)}` : '';
  };
  caption.innerHTML = `${CRAFT_SLOT_LIST.map(line).join('<br>')}<br><span style="color:#6b665c">${Math.round(size.y)} см · тянуть — повернуть, колесо — ближе, двойной клик — крутить</span>`;
  box.append(caption);
  return box;
}

/** Мышь: повернуть, приблизить, вернуть авто-вращение. Вешается один раз на общий холст. */
function bindControls(el: HTMLCanvasElement): void {
  let drag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch }; view.auto = false; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.yaw = drag.yaw + (e.clientX - drag.x) * 0.012;
    view.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + (e.clientY - drag.y) * 0.01));
  });
  const up = (): void => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.max(0.6, Math.min(6, view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); }, { passive: false });
  el.addEventListener('dblclick', () => { view.auto = true; view.pitch = 0.12; view.zoom = 1; });
}
