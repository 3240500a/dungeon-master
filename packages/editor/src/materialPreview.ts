/**
 * Превью-сфера материала (как шар материала в 3ds Max/Unity), НАШИМ рендером (Three.js) — чтобы материал в редакторе
 * выглядел 1:1 как в игре. Пара источников света + окружение (RoomEnvironment) для PBR-отражений; автоповорот + орбита
 * мышью. `update(mat, textures)` пересобирает MeshStandardMaterial из конфига (те же поля, что assetCache в клиенте,
 * включая normalFlipY = инверсия зелёного канала DirectX→OpenGL через знак normalScale.y) — вызывается на каждое
 * изменение параметра в реальном времени. Один WebGL-контекст: создаётся один раз, `dispose()` при пересборке панели.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Форма записи текстуры/материала (совпадает с config-секциями textures/materials). */
export interface TexCfg { id: string; url?: string; colorSpace?: string; wrapS?: string; wrapT?: string; flipY?: boolean }
export interface MatCfg {
  baseColor?: unknown; opacity?: unknown; metalness?: unknown; roughness?: unknown; emissive?: unknown;
  emissiveIntensity?: unknown; normalScale?: unknown; normalFlipY?: unknown;
  map?: unknown; normalMap?: unknown; roughnessMap?: unknown; metalnessMap?: unknown; emissiveMap?: unknown; aoMap?: unknown;
}
export interface MaterialPreview { el: HTMLElement; update(mat: MatCfg, textures: TexCfg[]): void; setEnv(intensity: number): void; dispose(): void }

const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
const col = (v: unknown, d: number): THREE.Color => (Array.isArray(v) ? new THREE.Color(v[0] as number, v[1] as number, v[2] as number) : new THREE.Color(d));

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
  scene.add(new THREE.AmbientLight(0x20222e, 0.5));
  scene.add(new THREE.HemisphereLight(0x34384e, 0x141014, 0.35));
  const dir = new THREE.DirectionalLight(0xb8c2dc, 0.2); dir.position.set(0.5, 1, 0.35); scene.add(dir);
  const torch = new THREE.PointLight(0xff7a2a, 7, 12, 2); torch.position.set(2.2, 1.6, 2.2); scene.add(torch);   // факел (тёплый) — даёт основной блик

  const mat = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: 0.8, metalness: 0 });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), mat);
  scene.add(sphere);
  let envIntensity = 0.2;   // сила вклада IBL (0 = как в игре без окружения; выше — подсветить металл). Слайдер в панели.

  const loader = new THREE.TextureLoader();
  const texCache = new Map<string, THREE.Texture>();

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

  /** Текстура по id из конфига. srgb: цвет/эмиссия — sRGB (если сама текстура не помечена linear); карты данных — linear. */
  function tex(textures: TexCfg[], id: unknown, srgb: boolean): THREE.Texture | null {
    if (typeof id !== 'string' || !id) return null;
    const c = textures.find((t) => t.id === id);
    if (!c || !c.url) return null;
    let t = texCache.get(id);
    if (!t) { t = loader.load(c.url); texCache.set(id, t); }
    t.colorSpace = c.colorSpace === 'linear' ? THREE.LinearSRGBColorSpace : (srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace);
    t.wrapS = c.wrapS === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapT = c.wrapT === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (typeof c.flipY === 'boolean') t.flipY = c.flipY;
    t.needsUpdate = true;
    return t;
  }

  function update(m: MatCfg, textures: TexCfg[]): void {
    mat.color = col(m.baseColor, 0xffffff);
    mat.opacity = num(m.opacity, 1); mat.transparent = mat.opacity < 0.999;
    mat.metalness = num(m.metalness, 0);
    mat.roughness = num(m.roughness, 0.8);
    mat.emissive = col(m.emissive, 0x000000);
    mat.emissiveIntensity = num(m.emissiveIntensity, 1);
    mat.envMapIntensity = envIntensity;                  // вклад IBL (регулируется слайдером «Окружение»)
    const ns = num(m.normalScale, 1);
    mat.normalScale.set(ns, m.normalFlipY ? -ns : ns);   // flip green: DirectX(Y−)→OpenGL(Y+) без пересжатия текстуры
    mat.map = tex(textures, m.map, true);
    mat.normalMap = tex(textures, m.normalMap, false);
    mat.roughnessMap = tex(textures, m.roughnessMap, false);
    mat.metalnessMap = tex(textures, m.metalnessMap, false);
    mat.emissiveMap = tex(textures, m.emissiveMap, true);
    mat.aoMap = tex(textures, m.aoMap, false);
    mat.needsUpdate = true;
  }

  function dispose(): void {
    if (!alive) return;   // идемпотентно (само-очистка из loop + явный вызов панели могут совпасть)
    alive = false; cancelAnimationFrame(raf);
    for (const t of texCache.values()) t.dispose();
    texCache.clear();
    mat.dispose(); sphere.geometry.dispose(); pmrem.dispose();
    scene.environment?.dispose();
    renderer.dispose();
  }

  function setEnv(v: number): void { envIntensity = v; mat.envMapIntensity = v; }

  return { el, update, setEnv, dispose };
}
