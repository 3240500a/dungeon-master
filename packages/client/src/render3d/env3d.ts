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

export interface Torch { light: THREE.PointLight; base: number; attr: THREE.BufferAttribute; pos: Float32Array; life: Float32Array; seed: Float32Array }
const FLAME_N = 20;

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

  const floorCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (walk(x, y)) floorCells.push([x, y]);
  const fm = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, 4, TILE), matStone, floorCells.length);
  floorCells.forEach(([x, y], i) => { dummy.position.set(cw(x), -2, cw(y)); dummy.updateMatrix(); fm.setMatrixAt(i, dummy.matrix); });
  parent.add(fm);

  const wallCells: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[y]![x] !== Cell.Wall) continue;
    let near = false; for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (walk(x + dx, y + dy)) { near = true; break; }
    if (near) wallCells.push([x, y]);
  }
  const wm = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, WALL_H, TILE), matWall, wallCells.length);
  wallCells.forEach(([x, y], i) => { dummy.position.set(cw(x), WALL_H / 2, cw(y)); dummy.updateMatrix(); wm.setMatrixAt(i, dummy.matrix); });
  parent.add(wm);

  for (const d of layout.doors) for (const c of d.cells) {
    const vertical = walk(c.cx - 1, c.cy) || walk(c.cx + 1, c.cy);
    const geo = vertical ? new THREE.BoxGeometry(8, WALL_H * 0.85, TILE) : new THREE.BoxGeometry(TILE, WALL_H * 0.85, 8);
    const m = new THREE.Mesh(geo, matWood); m.position.set(cw(c.cx), WALL_H * 0.85 / 2, cw(c.cy)); parent.add(m);
  }

  const torches: Torch[] = [];
  for (const o of layout.decor) {
    if (o.kind === 'pillar') {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, WALL_H, 12), matWall); shaft.position.y = WALL_H / 2;
      g.add(shaft); g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'chest') {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(20, 12, 14), matWood); body.position.y = 6;
      const lid = new THREE.Mesh(new THREE.BoxGeometry(21, 6, 15), matWood); lid.position.y = 14; g.add(body, lid); g.position.set(o.x, 0, o.y); parent.add(g);
    } else if (o.kind === 'torch') {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2, 48, 6), matWood).translateY(24));
      const light = new THREE.PointLight(0xff7a2a, 1500, 360, 2); light.position.y = 58; g.add(light);
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(FLAME_N * 3), life = new Float32Array(FLAME_N), seed = new Float32Array(FLAME_N);
      for (let i = 0; i < FLAME_N; i++) { life[i] = Math.random(); seed[i] = Math.random() * 6.283; pos[i * 3 + 1] = 52; }
      const attr = new THREE.BufferAttribute(pos, 3); geo.setAttribute('position', attr);
      g.add(new THREE.Points(geo, new THREE.PointsMaterial({ map: FLAME_TEX, color: 0xffa848, size: 16, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      g.position.set(o.x, 0, o.y); parent.add(g);
      torches.push({ light, base: 1500, attr, pos, life, seed });
    }
  }
  if (layout.stairsDown) {
    const g = new THREE.Group();
    for (let i = 0; i < 5; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.9, 5, TILE - i * 4), matDark); s.position.set(0, -i * 5 - 2.5, i * 3); g.add(s); }
    g.position.set(layout.stairsDown.x, 0, layout.stairsDown.y); parent.add(g);
  }
  return torches;
}

export function animateTorches(torches: Torch[], t: number): void {
  for (const tr of torches) {
    for (let i = 0; i < FLAME_N; i++) {
      let lf = (tr.life[i] ?? 0) + 0.02 + (i % 3) * 0.004; if (lf > 1) lf -= 1; tr.life[i] = lf;
      const spread = lf * 7, b = i * 3, sd = tr.seed[i] ?? 0;
      tr.pos[b] = Math.sin(sd + t * 6) * spread; tr.pos[b + 1] = 52 + lf * 28; tr.pos[b + 2] = Math.cos(sd * 1.3 + t * 6) * spread;
    }
    tr.attr.needsUpdate = true;
    tr.light.intensity = tr.base * (0.78 + Math.sin(t * 11 + tr.base) * 0.12 + Math.random() * 0.12);
  }
}
