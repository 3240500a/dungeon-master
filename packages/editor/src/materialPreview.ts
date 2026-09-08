/**
 * Превью-сфера материала (как шар материала в 3ds Max/Unity), НАШИМ рендером (Three.js) — чтобы материал в редакторе
 * выглядел 1:1 как в игре. Пара источников света + окружение (RoomEnvironment) для PBR-отражений; автоповорот + орбита
 * мышью. Один WebGL-контекст: создаётся один раз, `dispose()` при пересборке панели.
 *
 * ⚠ Материал НЕ собирается здесь: `update()` зовёт `buildMaterial` из клиентского `assetCache` — ЕДИНСТВЕННЫЙ перевод
 * URP-описания в three.js. Раньше у превью была своя копия логики, и она расходилась с игрой (разное цветовое
 * пространство карт данных) — теперь расхождение невозможно по построению.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildMaterial, type MaterialCfg, type TextureCfg } from '@dm/client/render3d/assetCache.js';

/** Форма записи текстуры/материала = config-секции textures/materials (канон URP Lit, см. schemas.ts). */
export type TexCfg = TextureCfg;
export type MatCfg = Partial<MaterialCfg> & { id?: string };
export interface MaterialPreview { el: HTMLElement; update(mat: MatCfg, textures: TexCfg[]): void; setEnv(intensity: number): void; dispose(): void }

/** Создать превью-сферу материала. size — сторона канваса (px). */
export function createMaterialPreview(size = 240): MaterialPreview {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0b10);   // тёмный фон как подземелье
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // IBL есть, но его вклад регулируется envMapIntensity (по умолч. слабо)

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

  // Свет КАК В ИГРЕ (env3d makeSceneLighting + факел): тусклый ambient/hemisphere/directional, основной вклад — тёплый
  // факел-point-light рядом. Так материал на сфере выглядит как в подземелье (roughness/metalness читаются честно).
  // Авторинг-свет (ярко, чтобы roughness/metalness ЧИТАЛИСЬ): key-directional + холодный fill + тёплый факел-ободок +
  // окружение (envMapIntensity — слайдер). Тусклый «вид игры» = слайдер «Окружение» в 0. Материал тот же, что в игре.
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 4, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.6); fill.position.set(-4, -1, 2); scene.add(fill);
  const torch = new THREE.PointLight(0xff9a4a, 5, 16, 2); torch.position.set(-2.4, 1.8, -2.2); scene.add(torch);   // тёплый ободок-факел

  let mat = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: 0.8, metalness: 0 });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), mat);
  scene.add(sphere);
  let envIntensity = 0;      // ВЫКЛ по умолчанию = вид игры (в игре envMap нет). IBL даёт ложный блик швов (Fresnel по канавкам) — глушим. Слайдер поднимает для авторинга металла.

  // Орбита мышью + автоповорот (стоп при перетаскивании).
  const el = renderer.domElement;
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:8px;cursor:grab;touch-action:none;display:block`;
  let auto = true, yaw = 0.6, pitch = 0.35, dragging = false, lastX = 0, lastY = 0;
  el.addEventListener('pointerdown', (e) => { dragging = true; auto = false; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.addEventListener('pointermove', (e) => { if (!dragging) return; yaw += (e.clientX - lastX) * 0.01; pitch = Math.max(-1.3, Math.min(1.3, pitch + (e.clientY - lastY) * 0.01)); lastX = e.clientX; lastY = e.clientY; });
  const endDrag = (e: PointerEvent): void => { if (!dragging) return; dragging = false; try { el.releasePointerCapture(e.pointerId); } catch { /* нет захвата */ } el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag);

  let alive = true, raf = 0, wasConnected = false;
  const R = 3.4;
  const loop = (): void => {
    if (!alive) return;
    if (el.isConnected) wasConnected = true;
    else if (wasConnected) { dispose(); return; }   // канвас убрали из DOM (сменили секцию/запись) → освободить WebGL-контекст
    if (auto) yaw += 0.005;
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * R, Math.sin(pitch) * R, Math.cos(yaw) * Math.cos(pitch) * R);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  /** Дефолты URP-материала — форма редактора может быть неполной, пока запись не сохранена (zod-дефолты ставятся
   *  реестром при загрузке конфига, а свежесозданная запись их ещё не имеет). */
  const DEF: MaterialCfg = {
    id: '__preview', surface: 'opaque', blend: 'alpha', alphaClip: false, cutoff: 0.5, cull: 'back',
    baseColor: [1, 1, 1, 1], metallic: 0, smoothness: 0.5, occlusionStrength: 1, bumpScale: 1,
    emissionColor: [0, 0, 0], emissionIntensity: 1, tiling: [1, 1], offset: [0, 0],
  };

  function update(m: MatCfg, textures: TexCfg[]): void {
    const set = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as Partial<MaterialCfg>;
    const full: MaterialCfg = { ...DEF, ...set, id: '__preview' };
    const next = buildMaterial({ materials: [full], textures }, '__preview') as THREE.MeshStandardMaterial | null;
    if (!next) return;
    next.envMapIntensity = envIntensity;   // вклад IBL — ТОЛЬКО превью (в игре envMap нет), слайдер «Окружение»
    sphere.material = next;
    mat.dispose();                         // текстуры общие (кэш assetCache) — их не трогаем
    mat = next;
  }

  function dispose(): void {
    if (!alive) return;   // идемпотентно (само-очистка из loop + явный вызов панели могут совпасть)
    alive = false; cancelAnimationFrame(raf);
    mat.dispose(); sphere.geometry.dispose(); pmrem.dispose();
    scene.environment?.dispose();
    renderer.dispose();
  }

  function setEnv(v: number): void { envIntensity = v; mat.envMapIntensity = v; }

  return { el, update, setEnv, dispose };
}
