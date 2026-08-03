/**
 * Debug-draw 3D-клиента (кнопка «DBG» + F3): слои-чекбоксы, включаемые по отдельности (цифры 1-6):
 *  1 КОЛЛАЙДЕРЫ  — стены (InstancedMesh как физ-статика) + круги коллизии игрока/монстров/пиров/снарядов/интерактов;
 *  2 ВОСПРИЯТИЕ  — конус зрения (def.vision/visionAngle по facing) + круг слуха (def.hearing) монстров;
 *  3 АТАКА       — круг ближней атаки монстра (r+r+slack) + дуга атаки игрока (reach/arc из конфига);
 *  4 AI          — цвет по aiState (покой/погоня) + линия монстр→ближайший игрок при погоне;
 *  5 FACING      — стрелка направления взгляда у всех актёров;
 *  6 МЕТКИ       — билборд id/hp/state над актёром (DOM, проекция мира→экран).
 * + инфо-панель (fps/tick/ping/коорд/счётчики). Мировые линии — один batched LineSegments (vertex-colors, 1 дроукол).
 * Данные подаёт online3d каждый кадр (только когда включено). Коллизии/восприятие — из снапшота (r,aiState) и def.
 */
import * as THREE from 'three';
import { Cell, TILE, type Grid } from '@dm/shared';
import { WALL_H } from './env3d.js';

export type DebugLayer = 'colliders' | 'vision' | 'attack' | 'ai' | 'facing' | 'labels';
export interface DbgActor { x: number; z: number; facing: number; r: number; me?: boolean }
export interface DbgMonster extends DbgActor { id: number; alive: boolean; aiState: 'idle' | 'chase'; vision: number; visionAngle: number; hearing: number; hp: number; maxHp: number }
export interface DebugFrame {
  info: Record<string, string | number>;
  playerR: number;
  players: DbgActor[];
  monsters: DbgMonster[];
  projectiles: { x: number; z: number; r: number }[];
  interactables: { x: number; z: number; r: number }[];
  playerAttack: { x: number; z: number; facing: number; reach: number; halfArc: number } | null;
}
export interface Debug3d { setFloor(grid: Grid): void; update(f: DebugFrame): void; readonly on: boolean }

const MELEE_SLACK = 8;   // приближение MONSTER_MELEE_WHIFF_SLACK для радиуса ближней атаки монстра
const COL = { self: 0x35e08a, peer: 0x5aa0ff, mon: 0x35e08a, proj: 0xffffff, inter: 0x6fd0ff, vision: 0xffe24a, hear: 0x59a8ff, atkMon: 0xff5a3a, atkPl: 0xffa030, chase: 0xff4040, idle: 0x8a90a4, target: 0xff6060, face: 0xffffff };

export function mountDebug(scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLCanvasElement, root: HTMLElement, opts: { onMonKinematic?: (on: boolean) => void; onLowRes?: (on: boolean) => void; onMonNoIk?: (on: boolean) => void } = {}): Debug3d {
  let on = false;
  const layers: Record<DebugLayer, boolean> = { colliders: true, vision: true, attack: true, ai: true, facing: false, labels: false };
  const group = new THREE.Group(); group.visible = false; scene.add(group);

  // ── Стены-коллайдеры (как PhysWorld.buildStatic), InstancedMesh ──────────────
  const boxGeo = new THREE.BoxGeometry(TILE, WALL_H, TILE);
  const boxMat = new THREE.MeshBasicMaterial({ color: 0x35e08a, wireframe: true, transparent: true, opacity: 0.4 });
  let walls: THREE.InstancedMesh | null = null;
  const setFloor = (grid: Grid): void => {
    if (walls) { group.remove(walls); walls.dispose(); walls = null; }
    let n = 0; for (const row of grid) for (const c of row) if (c === Cell.Wall) n++;
    if (!n) return;
    walls = new THREE.InstancedMesh(boxGeo, boxMat, n);
    const m = new THREE.Matrix4(); let i = 0;
    for (let y = 0; y < grid.length; y++) { const row = grid[y]!; for (let x = 0; x < row.length; x++) if (row[x] === Cell.Wall) { m.setPosition(x * TILE + TILE / 2, WALL_H / 2, y * TILE + TILE / 2); walls.setMatrixAt(i++, m); } }
    walls.instanceMatrix.needsUpdate = true; group.add(walls);
  };

  // ── Batched мировые линии (круги/секторы/стрелки/линии) — vertex-colors, 1 дроукол ──
  const MAXV = 60000;
  const posA = new Float32Array(MAXV * 3), colA = new Float32Array(MAXV * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
  lines.frustumCulled = false; group.add(lines);
  let vi = 0; const _c = new THREE.Color();
  const vtx = (x: number, y: number, z: number): void => { posA[vi * 3] = x; posA[vi * 3 + 1] = y; posA[vi * 3 + 2] = z; colA[vi * 3] = _c.r; colA[vi * 3 + 1] = _c.g; colA[vi * 3 + 2] = _c.b; vi++; };
  const seg = (x1: number, z1: number, x2: number, z2: number, color: number, y = 2): void => { if (vi + 2 > MAXV) return; _c.set(color); vtx(x1, y, z1); vtx(x2, y, z2); };
  const circle = (x: number, z: number, r: number, color: number, segs = 28, y = 2): void => { let px = x + r, pz = z; for (let i = 1; i <= segs; i++) { const a = (i / segs) * 6.2832; const nx = x + Math.cos(a) * r, nz = z + Math.sin(a) * r; seg(px, pz, nx, nz, color, y); px = nx; pz = nz; } };
  const sector = (x: number, z: number, r: number, facing: number, half: number, color: number, segs = 22, y = 2): void => {
    const a0 = facing - half, a1 = facing + half; let px = x + Math.cos(a0) * r, pz = z + Math.sin(a0) * r;
    seg(x, z, px, pz, color, y);
    for (let i = 1; i <= segs; i++) { const a = a0 + ((a1 - a0) * i) / segs; const nx = x + Math.cos(a) * r, nz = z + Math.sin(a) * r; seg(px, pz, nx, nz, color, y); px = nx; pz = nz; }
    seg(px, pz, x, z, color, y);
  };
  const arrow = (x: number, z: number, facing: number, len: number, color: number, y = 2): void => {
    const tx = x + Math.cos(facing) * len, tz = z + Math.sin(facing) * len; seg(x, z, tx, tz, color, y);
    const b = len * 0.3; seg(tx, tz, tx - Math.cos(facing - 0.5) * b, tz - Math.sin(facing - 0.5) * b, color, y); seg(tx, tz, tx - Math.cos(facing + 0.5) * b, tz - Math.sin(facing + 0.5) * b, color, y);
  };

  // ── Панель + чекбоксы слоёв + инфо ───────────────────────────────────────────
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:12px;top:170px;z-index:70;display:none;background:rgba(8,10,16,0.85);' +
    'border:1px solid #35506a;border-radius:6px;padding:8px 10px;font:11px/1.4 monospace;color:#9fe0c0;pointer-events:auto;min-width:150px';
  root.appendChild(panel);
  const LAYER_LABELS: [DebugLayer, string][] = [['colliders', '1 коллайдеры'], ['vision', '2 восприятие'], ['attack', '3 атака'], ['ai', '4 AI'], ['facing', '5 facing'], ['labels', '6 метки']];
  const boxes: Record<string, HTMLInputElement> = {};
  const layerRow = document.createElement('div'); layerRow.style.cssText = 'margin-bottom:6px';
  for (const [k, lbl] of LAYER_LABELS) {
    const row = document.createElement('label'); row.style.cssText = 'display:block;cursor:pointer;color:#cfe0d6';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = layers[k]; cb.style.cssText = 'margin-right:5px;vertical-align:middle';
    cb.addEventListener('change', () => { layers[k] = cb.checked; });
    row.append(cb, document.createTextNode(lbl)); layerRow.appendChild(row); boxes[k] = cb;
  }
  // Перф-тумблер (K): кинематика монстров — рисуем из позы, физику считаем только на удар/смерть (тест источника фризов).
  const physRow = document.createElement('label'); physRow.style.cssText = 'display:block;cursor:pointer;color:#ffd479;border-top:1px solid #2b3a48;margin-top:6px;padding-top:6px';
  const physCb = document.createElement('input'); physCb.type = 'checkbox'; physCb.style.cssText = 'margin-right:5px;vertical-align:middle';
  physCb.addEventListener('change', () => opts.onMonKinematic?.(physCb.checked));
  physRow.append(physCb, document.createTextNode('K кинематика монстров (физ: удар/смерть)'));
  // Перф-тумблер (L): половинный pixelRatio — мгновенно режет фрагментную цену (тест «упираемся ли в GPU»).
  const lowRow = document.createElement('label'); lowRow.style.cssText = 'display:block;cursor:pointer;color:#ffd479;margin-top:4px';
  const lowCb = document.createElement('input'); lowCb.type = 'checkbox'; lowCb.style.cssText = 'margin-right:5px;vertical-align:middle';
  lowCb.addEventListener('change', () => opts.onLowRes?.(lowCb.checked));
  lowRow.append(lowCb, document.createTextNode('L 1× пиксели (perf)'));
  // Перф-тумблер (J): монстры БЕЗ вспомогательного IK (FOOT-IK + off-hand) — у ВСЕХ, не только дальних.
  const noikRow = document.createElement('label'); noikRow.style.cssText = 'display:block;cursor:pointer;color:#ffd479;margin-top:4px';
  const noikCb = document.createElement('input'); noikCb.type = 'checkbox'; noikCb.style.cssText = 'margin-right:5px;vertical-align:middle';
  noikCb.addEventListener('change', () => opts.onMonNoIk?.(noikCb.checked));
  noikRow.append(noikCb, document.createTextNode('J монстры без вспом. IK (foot/off-hand)'));
  const infoEl = document.createElement('div'); infoEl.style.cssText = 'white-space:pre;color:#9fe0c0;border-top:1px solid #2b3a48;padding-top:5px';
  panel.append(layerRow, physRow, lowRow, noikRow, infoEl);

  const btn = document.createElement('button'); btn.textContent = 'DBG';
  btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:70;padding:4px 9px;background:#1c2130;color:#8f9bb0;border:1px solid #39415a;border-radius:5px;cursor:pointer;font:11px monospace;pointer-events:auto';
  root.appendChild(btn);

  // Метки-билборды (DOM, проекция мира→экран), пул.
  const labelWrap = document.createElement('div'); labelWrap.style.cssText = 'position:fixed;inset:0;z-index:69;pointer-events:none;display:none'; root.appendChild(labelWrap);
  const labelPool: HTMLDivElement[] = []; const _v = new THREE.Vector3();

  const setOn = (v: boolean): void => {
    on = v; group.visible = on; panel.style.display = on ? 'block' : 'none';
    if (!on) labelWrap.style.display = 'none';
    btn.style.background = on ? '#274032' : '#1c2130'; btn.style.color = on ? '#8adca0' : '#8f9bb0';
  };
  btn.addEventListener('click', () => setOn(!on));
  addEventListener('keydown', (e) => {
    const t = document.activeElement; if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (e.code === 'F3') { e.preventDefault(); setOn(!on); return; }
    if (on && e.code === 'KeyK') { physCb.checked = !physCb.checked; opts.onMonKinematic?.(physCb.checked); return; }   // кинематика монстров
    if (on && e.code === 'KeyL') { lowCb.checked = !lowCb.checked; opts.onLowRes?.(lowCb.checked); return; }   // половинный pixelRatio
    if (on && e.code === 'KeyJ') { noikCb.checked = !noikCb.checked; opts.onMonNoIk?.(noikCb.checked); return; }   // монстры без вспом. IK
    if (on && /^Digit[1-6]$/.test(e.code)) { const k = LAYER_LABELS[+e.code.slice(5) - 1]![0]; layers[k] = !layers[k]; boxes[k]!.checked = layers[k]; }
  });

  function updateLabels(f: DebugFrame): void {
    labelWrap.style.display = 'block';
    const rect = canvas.getBoundingClientRect();
    const items: { x: number; z: number; txt: string }[] = [
      ...f.players.map((p) => ({ x: p.x, z: p.z, txt: p.me ? 'YOU' : 'peer' })),
      ...f.monsters.filter((m) => m.alive).map((m) => ({ x: m.x, z: m.z, txt: `#${m.id} ${Math.round(m.hp)}/${Math.round(m.maxHp)} ${m.aiState}` })),
    ];
    for (let i = 0; i < items.length; i++) {
      let el = labelPool[i];
      if (!el) { el = document.createElement('div'); el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);font:10px monospace;color:#bfead0;background:rgba(0,0,0,0.55);padding:1px 4px;border-radius:3px;white-space:nowrap'; labelWrap.appendChild(el); labelPool[i] = el; }
      _v.set(items[i]!.x, 62, items[i]!.z).project(camera);
      if (_v.z < 1) { el.style.display = 'block'; el.style.left = `${rect.left + (_v.x * 0.5 + 0.5) * rect.width}px`; el.style.top = `${rect.top + (-_v.y * 0.5 + 0.5) * rect.height}px`; el.textContent = items[i]!.txt; } else el.style.display = 'none';
    }
    for (let i = items.length; i < labelPool.length; i++) labelPool[i]!.style.display = 'none';
  }

  const update = (f: DebugFrame): void => {
    if (!on) return;
    infoEl.textContent = Object.entries(f.info).map(([k, v]) => `${k.padEnd(8)} ${v}`).join('\n');
    if (walls) walls.visible = layers.colliders;
    vi = 0;
    if (layers.colliders) {
      for (const p of f.players) circle(p.x, p.z, p.r, p.me ? COL.self : COL.peer);
      for (const m of f.monsters) if (m.alive) circle(m.x, m.z, m.r, COL.mon);
      for (const pr of f.projectiles) circle(pr.x, pr.z, Math.max(3, pr.r), COL.proj, 16);
      for (const it of f.interactables) circle(it.x, it.z, it.r, COL.inter);
    }
    if (layers.vision) for (const m of f.monsters) if (m.alive) { sector(m.x, m.z, m.vision, m.facing, (m.visionAngle * Math.PI) / 360, COL.vision); circle(m.x, m.z, m.hearing, COL.hear, 40); }
    if (layers.attack) {
      for (const m of f.monsters) if (m.alive) circle(m.x, m.z, m.r + f.playerR + MELEE_SLACK, COL.atkMon);
      if (f.playerAttack) sector(f.playerAttack.x, f.playerAttack.z, f.playerAttack.reach, f.playerAttack.facing, f.playerAttack.halfArc, COL.atkPl);
    }
    if (layers.ai) for (const m of f.monsters) if (m.alive) {
      circle(m.x, m.z, m.r + 3, m.aiState === 'chase' ? COL.chase : COL.idle);
      if (m.aiState === 'chase' && f.players.length) { let bx = 0, bz = 0, bd = Infinity; for (const p of f.players) { const d = (p.x - m.x) ** 2 + (p.z - m.z) ** 2; if (d < bd) { bd = d; bx = p.x; bz = p.z; } } seg(m.x, m.z, bx, bz, COL.target); }
    }
    if (layers.facing) { for (const p of f.players) arrow(p.x, p.z, p.facing, p.r + 16, COL.face); for (const m of f.monsters) if (m.alive) arrow(m.x, m.z, m.facing, m.r + 14, COL.face); }
    geo.attributes.position!.needsUpdate = true; geo.attributes.color!.needsUpdate = true; geo.setDrawRange(0, vi);
    if (layers.labels) updateLabels(f); else labelWrap.style.display = 'none';
  };
  return { setFloor, update, get on() { return on; } };
}
