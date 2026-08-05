/**
 * Окружение 3D-клиента: процедурные текстуры (спокойный серый камень), сборка этажа из
 * DungeonLayout (пол/стены/двери/пропсы), факелы с партикл-пламенем и точечным светом,
 * освещение «карманный свет». Мир (x,y) → 3D (x, h, z=y). TILE=32u=1 м, стена 3 м.
 */
import * as THREE from 'three';
import { TILE, Cell, type DungeonLayout } from '@dm/shared';

export const WALL_H = 96;

function tex(c: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function flagstoneTexture(): THREE.Texture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = '#4c4e4d'; g.fillRect(0, 0, S, S);
  const n = 2, cell = S / n;
  for (let ry = 0; ry < n; ry++) for (let rx = 0; rx < n; rx++) {
    const L = 52 + (Math.random() * 8 - 4), bx = rx * cell + 3, by = ry * cell + 3, bw = cell - 6, bh = cell - 6;
    g.fillStyle = `hsl(150,3%,${L}%)`; g.fillRect(bx, by, bw, bh);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2; g.beginPath(); g.moveTo(bx, by + bh); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.beginPath(); g.moveTo(bx + bw, by); g.lineTo(bx + bw, by + bh); g.lineTo(bx, by + bh); g.stroke();
  }
  g.fillStyle = 'rgba(120,122,120,0.05)'; for (let i = 0; i < 500; i++) g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  return tex(c);
}
function masonryTexture(): THREE.Texture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  g.fillStyle = '#4a4c4c'; g.fillRect(0, 0, S, S);
  const rows = 4, rh = S / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh; let x = -(r % 2) * (S / 6);
    while (x < S) {
      const w = (S / 3) * (0.85 + Math.random() * 0.3), L = 56 + (Math.random() * 6 - 3), bx = x + 2, by = y + 2, bw = w - 3, bh = rh - 3;
      const grad = g.createLinearGradient(bx, by, bx, by + bh); grad.addColorStop(0, `hsl(200,4%,${L + 5}%)`); grad.addColorStop(1, `hsl(200,4%,${L - 5}%)`);
      g.fillStyle = grad; g.fillRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(40,42,44,0.5)'; g.lineWidth = 1; g.strokeRect(bx, by, bw, bh);
      g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(bx, by + bh); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.stroke();
      x += w;
    }
  }
  return tex(c);
}
function flameTexture(): THREE.Texture {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.4, 'rgba(255,220,150,0.7)'); grad.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S); return new THREE.CanvasTexture(c);
}

const floorTex = flagstoneTexture();
const wallTex = masonryTexture(); wallTex.repeat.set(1, 2);
const FLAME_TEX = flameTexture();
const matStone = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: floorTex });
const matWall = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, map: wallTex });
const matWood = new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.85 });
const matMetal = new THREE.MeshStandardMaterial({ color: 0x8892a0, roughness: 0.5, metalness: 0.6 });
const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 1 });

// Факел: мир-позиция + данные пламени. Света СВОЕГО нет — светят лишь TORCH_POOL_N ближайших через общий пул
// (перф: 20-50 факелов на этаж = столько же PointLight → PBR считал КАЖДЫЙ на каждый фрагмент = дикая фрагментная цена;
//  пул фиксированного размера → фрагментная цена ограничена И число света постоянно = нет перекомпиляции материалов).
export interface Torch { x: number; z: number; base: number; attr: THREE.BufferAttribute; pos: Float32Array; life: Float32Array; seed: Float32Array; d2: number; on: boolean; group: THREE.Object3D; flame: THREE.Points }
const FLAME_N = 20;
export const TORCH_POOL_N = 10;   // сколько факелов светят одновременно (ближайшие к игроку); пламя-спрайт есть у всех
// Дальше этой дистанции факел ПОЛНОСТЬЮ в тумане (FogExp2 0.0012 → почти сплошной цвет к ~2000u) → прячем группу
// (столбик + пламя-Points): убираем зря рисуемый прозрачный additive-овердро дальних пламён. См. updateTorches.
const FLAME_CULL2 = 1800 * 1800;

/** Пул света факелов — создаётся ОДИН раз на сессию (постоянное число PointLight → ноль перекомпиляций). */
export function createTorchPool(scene: THREE.Scene): THREE.PointLight[] {
  const pool: THREE.PointLight[] = [];
  for (let i = 0; i < TORCH_POOL_N; i++) {
    const l = new THREE.PointLight(0xff7a2a, 0, 380, 2);
    l.shadow.mapSize.set(512, 512); l.shadow.camera.near = 8; l.shadow.camera.far = 380; l.shadow.bias = -0.004;   // конфиг теней (вкл. по тумблеру)
    scene.add(l); pool.push(l);
  }
  return pool;
}


export function setFog(scene: THREE.Scene): void {
  scene.background = new THREE.Color('#06070c'); scene.fog = new THREE.FogExp2(0x06070c, 0.0012);
}
export function makeSceneLighting(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0x20222e, 0.5));
  scene.add(new THREE.HemisphereLight(0x34384e, 0x141014, 0.35));
  const dir = new THREE.DirectionalLight(0xb8c2dc, 0.2); dir.position.set(0.5, 1, 0.35); scene.add(dir);
}

const cw = (c: number): number => c * TILE + TILE / 2;

/** Строит этаж из layout в `parent`; возвращает факелы для анимации в цикле. */
export function buildEnvironment(parent: THREE.Object3D, layout: DungeonLayout): Torch[] {
  const grid = layout.grid, rows = grid.length, cols = grid[0]!.length;
  const walk = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== Cell.Wall;
  const dummy = new THREE.Object3D();
  // Общие геометрии повторяющихся пропсов (реюз вместо `new` на КАЖДЫЙ факел/сундук): меньше аллокаций и
  // GPU-буферов. Живут на время этажа; clearGroup при смене области их dispose (реюз в пределах этажа — ок).
  const postGeo = new THREE.CylinderGeometry(1.4, 2, 48, 6);
  const chestBodyGeo = new THREE.BoxGeometry(20, 12, 14), chestLidGeo = new THREE.BoxGeometry(21, 6, 15);

  const floorCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (walk(x, y)) floorCells.push([x, y]);
  const fm = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, 4, TILE), matStone, floorCells.length);
  fm.receiveShadow = true;   // тени от факелов (вкл. по тумблеру) — пол принимает
  floorCells.forEach(([x, y], i) => { dummy.position.set(cw(x), -2, cw(y)); dummy.updateMatrix(); fm.setMatrixAt(i, dummy.matrix); });
  parent.add(fm);

  const wallCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] !== Cell.Wall) continue;
    let near = false; for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (walk(x + dx, y + dy)) { near = true; break; }
    if (near) wallCells.push([x, y]);
  }
  const wm = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, WALL_H, TILE), matWall, wallCells.length);
  wm.castShadow = true; wm.receiveShadow = true;
  wallCells.forEach(([x, y], i) => { dummy.position.set(cw(x), WALL_H / 2, cw(y)); dummy.updateMatrix(); wm.setMatrixAt(i, dummy.matrix); });
  parent.add(wm);

  // Колонны — из ГРИДА (Cell.Pillar непроходим на сервере: blocked()). Рисуем ВСЕ такие клетки (и декоративные из
  // decorate, и «зал» из carveRoomShaped) — иначе они были невидимыми стенами (рендерились как пол → «непроходимые тайлы»).
  const pillarCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (grid[y]![x] === Cell.Pillar) pillarCells.push([x, y]);
  if (pillarCells.length) {
    const pm = new THREE.InstancedMesh(new THREE.CylinderGeometry(9, 10, WALL_H, 12), matWall, pillarCells.length);
    pm.castShadow = true; pm.receiveShadow = true;
    pillarCells.forEach(([x, y], i) => { dummy.position.set(cw(x), WALL_H / 2, cw(y)); dummy.updateMatrix(); pm.setMatrixAt(i, dummy.matrix); });
    parent.add(pm);
  }

  for (const d of layout.doors) for (const c of d.cells) {
    const vertical = walk(c.cx - 1, c.cy) || walk(c.cx + 1, c.cy);
    const geo = vertical ? new THREE.BoxGeometry(8, WALL_H * 0.85, TILE) : new THREE.BoxGeometry(TILE, WALL_H * 0.85, 8);
    const m = new THREE.Mesh(geo, matWood); m.position.set(cw(c.cx), WALL_H * 0.85 / 2, cw(c.cy)); parent.add(m);
  }

  const torches: Torch[] = [];
  for (const o of layout.decor) {
    if (o.kind === 'pillar') {
      // Колонны уже отрисованы из грида (Cell.Pillar) выше — пропускаем, иначе двойной меш.
    } else if (o.kind === 'chest') {
      const g = new THREE.Group();
      const body = new THREE.Mesh(chestBodyGeo, matWood); body.position.y = 6;
      const lid = new THREE.Mesh(chestLidGeo, matWood); lid.position.y = 14; g.add(body, lid); g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'torch') {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(postGeo, matWood).translateY(24));
      const geo = new THREE.BufferGeometry();   // света своего НЕТ — назначит пул (updateTorches) ближайшим к игроку
      const pos = new Float32Array(FLAME_N * 3), life = new Float32Array(FLAME_N), seed = new Float32Array(FLAME_N);
      for (let i = 0; i < FLAME_N; i++) { life[i] = Math.random(); seed[i] = Math.random() * 6.283; pos[i * 3 + 1] = 52; }
      const attr = new THREE.BufferAttribute(pos, 3); geo.setAttribute('position', attr);
      const flame = new THREE.Points(geo, new THREE.PointsMaterial({ map: FLAME_TEX, color: 0xffa848, size: 16, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.add(flame);
      g.position.set(o.x, 0, o.y); parent.add(g);
      torches.push({ x: o.x, z: o.y, base: 1500, attr, pos, life, seed, d2: 0, on: false, group: g, flame });
    } else if (o.kind === 'portal') {
      // Портал узла забега (rest → возврат в город; финал → завершение). Аметистовое кольцо + свечение.
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(18, 4, 10, 24), new THREE.MeshStandardMaterial({ color: 0x8a5cff, emissive: 0x4a2aa0, emissiveIntensity: 0.9 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 20; g.add(ring);
      const glow = new THREE.PointLight(0x8a5cff, 900, 260, 2); glow.position.y = 22; g.add(glow);
      g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'stash') {
      // Общий сундук (крупнее обычного, тёмное золото).
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(28, 16, 18), matWood); body.position.y = 8;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(29, 7, 19), matMetal); lid.position.y = 19;
      g.add(body, lid); g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'shop') {
      // Лавка: стойка + навес.
      const g = new THREE.Group();
      const counter = new THREE.Mesh(new THREE.BoxGeometry(30, 18, 16), matWood); counter.position.y = 9;
      const awning = new THREE.Mesh(new THREE.BoxGeometry(34, 3, 20), new THREE.MeshStandardMaterial({ color: 0x4a8f6a, roughness: 0.8 })); awning.position.y = 34;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 34, 6), matWood); post.position.set(14, 17, 0);
      g.add(counter, awning, post); g.position.set(o.x, 0, o.y); parent.add(g);
    }
  }
  if (layout.stairsDown) {
    const g = new THREE.Group();
    for (let i = 0; i < 5; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.9, 5, TILE - i * 4), matDark); s.position.set(0, -i * 5 - 2.5, i * 3); g.add(s); }
    g.position.set(layout.stairsDown.x, 0, layout.stairsDown.y); parent.add(g);
  }
  return torches;
}

/**
 * Свет + пламя факелов: пул из TORCH_POOL_N PointLight назначается TORCH_POOL_N БЛИЖАЙШИМ к игроку факелам
 * (мерцание), остальные — интенсивность 0 (но остаются в сцене → число света постоянно, нет перекомпиляции).
 * Пламя анимируем только у СВЕТЯЩИХ (ближних) — дальние в тумане/за кадром замирают (экономим буфер-аплоады).
 * Выбор ближайших — O(pool·torches) без аллокаций (транзиентные d2/on на факеле).
 */
export function updateTorches(torches: Torch[], pool: THREE.PointLight[], px: number, pz: number, t: number): void {
  for (const tr of torches) { const dx = tr.x - px, dz = tr.z - pz; tr.d2 = dx * dx + dz * dz; tr.on = false; tr.group.visible = tr.d2 < FLAME_CULL2; }   // туман-кулинг: дальние (в сплошном тумане) не рисуем
  for (let k = 0; k < pool.length; k++) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < torches.length; i++) { const tr = torches[i]!; if (!tr.on && tr.d2 < bd) { bd = tr.d2; best = i; } }
    const l = pool[k]!;
    if (best < 0) { l.intensity = 0; continue; }   // факелов меньше, чем ламп в пуле
    const tr = torches[best]!; tr.on = true;
    l.position.set(tr.x, 58, tr.z);
    l.intensity = tr.base * (0.78 + Math.sin(t * 11 + tr.base) * 0.12 + Math.random() * 0.12);   // мерцание
  }
  for (const tr of torches) {
    if (!tr.on) continue;   // дальний факел — пламя заморожено (в тумане/за кадром не видно)
    for (let i = 0; i < FLAME_N; i++) {
      let lf = (tr.life[i] ?? 0) + 0.02 + (i % 3) * 0.004; if (lf > 1) lf -= 1; tr.life[i] = lf;
      const spread = lf * 7, b = i * 3, sd = tr.seed[i] ?? 0;
      tr.pos[b] = Math.sin(sd + t * 6) * spread; tr.pos[b + 1] = 52 + lf * 28; tr.pos[b + 2] = Math.cos(sd * 1.3 + t * 6) * spread;
    }
    tr.attr.needsUpdate = true;
  }
}
