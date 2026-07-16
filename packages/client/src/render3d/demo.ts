/**
 * Ф0 3D-СПАЙК (изолированная демо-страница /three-demo.html). Строит НАШ реальный этаж из
 * `generateDungeon` в 3D на Three.js: пол/стены/двери — меши (инстансинг), пропсы (колонны,
 * факелы, сундук, лестница) — простые процедурные модели кодом, текстуры пола/стен —
 * процедурные (canvas). Живую игру (Phaser) не трогает. Оценочный прототип «вида».
 */
import * as THREE from 'three';
import { generateDungeon, moveWithCollision, TILE, Cell, type Grid } from '@dm/shared';

// ── Процедурные текстуры (canvas → CanvasTexture). Масштаб: TILE(32u) = 1 метр. ──
function tex(c: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Плитняк: крупные светло-серые плиты со сдержанным швом (спокойно, низкий контраст). */
function flagstoneTexture(): THREE.Texture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = '#4c4e4d'; g.fillRect(0, 0, S, S); // шов — средне-серый
  const n = 2, cell = S / n;
  for (let ry = 0; ry < n; ry++) for (let rx = 0; rx < n; rx++) {
    const L = 52 + (Math.random() * 8 - 4);
    const bx = rx * cell + 3, by = ry * cell + 3, bw = cell - 6, bh = cell - 6;
    g.fillStyle = `hsl(150,3%,${L}%)`; g.fillRect(bx, by, bw, bh);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2; g.beginPath(); g.moveTo(bx, by + bh); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.beginPath(); g.moveTo(bx + bw, by); g.lineTo(bx + bw, by + bh); g.lineTo(bx, by + bh); g.stroke();
  }
  g.fillStyle = 'rgba(120,122,120,0.05)';
  for (let i = 0; i < 500; i++) g.fillRect(Math.random() * S, Math.random() * S, 2, 2); // еле-еле зерно
  g.strokeStyle = 'rgba(0,0,0,0.15)'; g.lineWidth = 1;                                  // пара редких трещинок
  for (let i = 0; i < 4; i++) { g.beginPath(); let x = Math.random() * S, y = Math.random() * S; g.moveTo(x, y); for (let j = 0; j < 3; j++) { x += Math.random() * 20 - 10; y += Math.random() * 20 - 10; g.lineTo(x, y); } g.stroke(); }
  return tex(c);
}
/** Каменная кладка: аккуратные светло-серые блоки со сдержанным швом (спокойно). */
function masonryTexture(): THREE.Texture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = '#4a4c4c'; g.fillRect(0, 0, S, S); // шов — средне-серый, не чёрный
  const rows = 4, rh = S / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh; let x = -(r % 2) * (S / 6);
    while (x < S) {
      const w = (S / 3) * (0.85 + Math.random() * 0.3), L = 56 + (Math.random() * 6 - 3);
      const bx = x + 2, by = y + 2, bw = w - 3, bh = rh - 3;
      const grad = g.createLinearGradient(bx, by, bx, by + bh);
      grad.addColorStop(0, `hsl(200,4%,${L + 5}%)`); grad.addColorStop(1, `hsl(200,4%,${L - 5}%)`);
      g.fillStyle = grad; g.fillRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(40,42,44,0.5)'; g.lineWidth = 1; g.strokeRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(bx, by + bh); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
      x += w;
    }
  }
  return tex(c);
}
/** Мягкий спрайт для партиклов пламени (радиальный градиент). */
function flameTexture(): THREE.Texture {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.4, 'rgba(255,220,150,0.7)'); grad.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
const floorTex = flagstoneTexture();
const wallTex = masonryTexture(); wallTex.repeat.set(1, 2); // стена 3 м → ~8 рядов блоков
const FLAME_TEX = flameTexture();

// ── Renderer / scene / camera ──────────────────────────────────────────────────
const canvas = document.getElementById('app') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#06070c');
scene.fog = new THREE.FogExp2(0x06070c, 0.0012); // даль тонет во тьме — атмосфера

const camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);

// Свет как в 2D: низкая база, доминирует «карманный свет» игрока (см. hero()) + факелы-пятна.
scene.add(new THREE.AmbientLight(0x20222e, 0.45));
scene.add(new THREE.HemisphereLight(0x34384e, 0x140f0a, 0.3));
const dir = new THREE.DirectionalLight(0xb8c2dc, 0.18); // едва — только форма стен
dir.position.set(0.5, 1, 0.35);
scene.add(dir);

const WALL_H = 96; // 3 метра (TILE=32u=1 м)
interface Flame { attr: THREE.BufferAttribute; pos: Float32Array; life: Float32Array; seed: Float32Array }
const torchLights: { light: THREE.PointLight; base: number; flame: Flame }[] = [];
let world = new THREE.Group();
scene.add(world);

// ── Игрок: локальное управление (Ф1). Мир (x,y) → 3D (x,0,z=y). ──────────────────
const PLAYER_SPEED = 120, PLAYER_R = 13;
const player = { x: 0, y: 0, aimX: 1, aimZ: 0 };
let heroGroup!: THREE.Group;
let facingMarker!: THREE.Mesh;
let curGrid: Grid = [];
const keys = new Set<string>();
addEventListener('keydown', (e) => { keys.add(e.code); });
addEventListener('keyup', (e) => { keys.delete(e.code); });

// ── Простые процедурные модели пропсов ─────────────────────────────────────────
const matStone = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.02, map: floorTex });
const matWall = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0, map: wallTex });
const matWood = new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.85 });
const matMetal = new THREE.MeshStandardMaterial({ color: 0x8892a0, roughness: 0.5, metalness: 0.6 });
const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 1 });

const FLAME_N = 22;
function torch(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.0, 48, 6), matWood); pole.position.y = 24; g.add(pole);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(5, 3, 5, 8), matMetal); bowl.position.y = 50; g.add(bowl);
  const light = new THREE.PointLight(0xff7a2a, 1500, 360, 2.0); light.position.set(0, 58, 0); g.add(light);
  // Пламя — партиклы (аддитивные спрайты, поднимаются и рассеиваются).
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(FLAME_N * 3), life = new Float32Array(FLAME_N), seed = new Float32Array(FLAME_N);
  for (let i = 0; i < FLAME_N; i++) { life[i] = Math.random(); seed[i] = Math.random() * 6.283; pos[i * 3 + 1] = 52; }
  const attr = new THREE.BufferAttribute(pos, 3); geo.setAttribute('position', attr);
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    map: FLAME_TEX, color: 0xffa848, size: 16, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  g.add(pts); g.position.set(x, 0, z);
  torchLights.push({ light, base: 1500, flame: { attr, pos, life, seed } });
  return g;
}
function pillar(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, WALL_H, 12), matWall);
  shaft.position.y = WALL_H / 2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(12, 10, 6, 12), matWall);
  cap.position.y = WALL_H - 3;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(12, 13, 5, 12), matWall);
  base.position.y = 2.5;
  g.add(shaft, cap, base); g.position.set(x, 0, z);
  return g;
}
function chest(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(20, 12, 14), matWood); body.position.y = 6;
  const lid = new THREE.Mesh(new THREE.BoxGeometry(21, 6, 15), matWood); lid.position.y = 14;
  const band = new THREE.Mesh(new THREE.BoxGeometry(22, 4, 3), matMetal); band.position.y = 10;
  g.add(body, lid, band); g.position.set(x, 0, z);
  return g;
}
function stairs(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.9, 5, TILE - i * 4), matDark);
    step.position.set(0, -i * 5 - 2.5, i * 3);
    g.add(step);
  }
  g.position.set(x, 0, z);
  return g;
}
function doorSlab(x: number, z: number, vertical: boolean): THREE.Mesh {
  const geo = vertical ? new THREE.BoxGeometry(8, WALL_H * 0.85, TILE) : new THREE.BoxGeometry(TILE, WALL_H * 0.85, 8);
  const m = new THREE.Mesh(geo, matWood);
  m.position.set(x, WALL_H * 0.85 / 2, z);
  return m;
}
function hero(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(7, 24, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x9aa6c0, roughness: 0.6, metalness: 0.3 }));
  body.position.y = 26; // капсула: 26 ± (12+7) = 7..45
  const head = new THREE.Mesh(new THREE.SphereGeometry(5.5, 14, 14),
    new THREE.MeshStandardMaterial({ color: 0xd8c0a0, roughness: 0.7 }));
  head.position.y = 50; // макушка ~56u ≈ 1.75 м
  // «Фонарь» игрока — тёплый ореол видимости, подвешен ~3 м над полом (как факел на шесте / радиус обзора 2D).
  // decay:2 физкорректен → нужна большая интенсивность (кандела), иначе не светит.
  const glow = new THREE.PointLight(0xffd7a0, 5200, 520, 2.0);
  glow.position.y = 96; g.add(glow); // ~3 м над полом
  g.add(body, head); g.position.set(x, 0, z);
  return g;
}

// ── Построить этаж в 3D ─────────────────────────────────────────────────────────
function cellW(c: number): number { return c * TILE + TILE / 2; }

function buildDungeon(seed: number): void {
  scene.remove(world);
  world.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  torchLights.length = 0;
  world = new THREE.Group();

  const L = generateDungeon(seed, 3, { cols: 56, rows: 42 });
  const grid = L.grid;
  const rows = grid.length, cols = grid[0]!.length;
  const walkable = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== Cell.Wall;

  // Пол — инстансы на всех проходимых клетках (Floor/Door/Pillar), тонкие плиты, верх на y=0.
  const floorCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (walkable(x, y)) floorCells.push([x, y]);
  const floorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, 4, TILE), matStone, floorCells.length);
  const dummy = new THREE.Object3D();
  floorCells.forEach(([x, y], i) => { dummy.position.set(cellW(x), -2, cellW(y)); dummy.updateMatrix(); floorMesh.setMatrixAt(i, dummy.matrix); });
  world.add(floorMesh);

  // Стены — только «видимые» (Wall, смежная с проходимой по 8 соседям) → данж «вырезан» в скале.
  const wallCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] !== Cell.Wall) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (walkable(x + dx, y + dy)) { near = true; break; }
    }
    if (near) wallCells.push([x, y]);
  }
  const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, WALL_H, TILE), matWall, wallCells.length);
  wallCells.forEach(([x, y], i) => { dummy.position.set(cellW(x), WALL_H / 2, cellW(y)); dummy.updateMatrix(); wallMesh.setMatrixAt(i, dummy.matrix); });
  world.add(wallMesh);

  // Двери — деревянные плиты (ориентация по соседям-полу).
  for (const d of L.doors) for (const c of d.cells) {
    const vertical = walkable(c.cx - 1, c.cy) || walkable(c.cx + 1, c.cy);
    world.add(doorSlab(cellW(c.cx), cellW(c.cy), vertical));
  }

  // Декор (колонны/факелы/сундук/арена-босс).
  for (const o of L.decor) {
    if (o.kind === 'pillar') world.add(pillar(o.x, o.y));
    else if (o.kind === 'torch') world.add(torch(o.x, o.y));
    else if (o.kind === 'chest') world.add(chest(o.x, o.y));
    else if (o.kind === 'arena') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(TILE * 2.2, 2, 8, 40),
        new THREE.MeshStandardMaterial({ color: 0x704020, roughness: 0.8 }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(o.x, 0.5, o.y); world.add(ring);
    }
  }

  world.add(stairs(L.stairsDown.x, L.stairsDown.y));
  heroGroup = hero(L.spawn.x, L.spawn.y); world.add(heroGroup);
  // Маркер взгляда — плоский треугольник на полу (как конус обзора в 2D).
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, -7, 0, 0, 7, 30, 0, 0]), 3));
  facingMarker = new THREE.Mesh(tri, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
  world.add(facingMarker);
  scene.add(world);

  curGrid = L.grid;
  player.x = L.spawn.x; player.y = L.spawn.y; player.aimX = 1; player.aimZ = 0;
  orbit.target.set(player.x, 20, player.y);
  orbit.dist = 460; orbit.az = -0.6; orbit.el = 0.92; orbit.apply();
}

// ── Мини-орбита (без зависимостей) ───────────────────────────────────────────────
const orbit = {
  target: new THREE.Vector3(), dist: 600, az: -0.6, el: 0.9,
  apply(): void {
    const el = Math.max(0.15, Math.min(1.45, this.el));
    const x = this.target.x + this.dist * Math.cos(el) * Math.sin(this.az);
    const y = this.target.y + this.dist * Math.sin(el);
    const z = this.target.z + this.dist * Math.cos(el) * Math.cos(this.az);
    camera.position.set(x, y, z); camera.lookAt(this.target);
  },
};
// Управление: ПКМ-тащить — орбита камеры; колесо — зум; свободная мышь — взгляд (луч в пол); WASD — идти.
const ray = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();
let rot: null | { x: number; y: number } = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 2) { rot = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointerup', () => { rot = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointermove', (e) => {
  if (rot) { orbit.az -= (e.clientX - rot.x) * 0.005; orbit.el += (e.clientY - rot.y) * 0.005; rot.x = e.clientX; rot.y = e.clientY; orbit.apply(); return; }
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (ray.ray.intersectPlane(ground, hit)) {
    const dx = hit.x - player.x, dz = hit.z - player.y, l = Math.hypot(dx, dz) || 1;
    player.aimX = dx / l; player.aimZ = dz / l;
  }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(140, Math.min(1200, orbit.dist * (e.deltaY < 0 ? 0.9 : 1.1))); orbit.apply(); }, { passive: false });

function resize(): void {
  const w = canvas.clientWidth || innerWidth || 960;
  const h = canvas.clientHeight || innerHeight || 600;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);

// ── Цикл ─────────────────────────────────────────────────────────────────────────
let t = 0;
function loop(): void {
  t += 0.016;
  for (const tl of torchLights) {
    const fl = tl.flame;
    for (let i = 0; i < FLAME_N; i++) {
      let lf = (fl.life[i] ?? 0) + 0.02 + (i % 3) * 0.004;
      if (lf > 1) lf -= 1;
      fl.life[i] = lf;
      const spread = lf * 7, b = i * 3, sd = fl.seed[i] ?? 0;
      fl.pos[b] = Math.sin(sd + t * 6) * spread;
      fl.pos[b + 1] = 52 + lf * 28;
      fl.pos[b + 2] = Math.cos(sd * 1.3 + t * 6) * spread;
    }
    fl.attr.needsUpdate = true;
    tl.light.intensity = tl.base * (0.78 + Math.sin(t * 11 + tl.base) * 0.12 + Math.random() * 0.12);
  }
  // Движение игрока (WASD/стрелки, world-absolute как в 2D) с коллизией по сетке.
  let mx = 0, my = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if ((mx || my) && curGrid.length) {
    const l = Math.hypot(mx, my);
    const np = moveWithCollision({ x: player.x, y: player.y }, { x: (mx / l) * PLAYER_SPEED, y: (my / l) * PLAYER_SPEED }, PLAYER_R, curGrid, 0.016);
    player.x = np.x; player.y = np.y;
  }
  heroGroup.position.set(player.x, 0, player.y);
  facingMarker.position.set(player.x, 3, player.y);
  facingMarker.rotation.y = Math.atan2(-player.aimZ, player.aimX);
  orbit.target.set(player.x, 20, player.y); orbit.apply();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

let seed = 12345;
resize();
buildDungeon(seed);
loop();
// debug-хук для проверки рендера из консоли (спайк).
(window as unknown as { __demo: unknown }).__demo = { renderer, scene, camera, buildDungeon, player, keys, move: moveWithCollision, grid: () => curGrid };
document.getElementById('reroll')!.addEventListener('click', () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; buildDungeon(seed); });
