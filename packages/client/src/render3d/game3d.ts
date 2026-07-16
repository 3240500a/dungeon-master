/**
 * 3D-КЛИЕНТ (прототип). Гоняет headless `GameSession` ЛОКАЛЬНО в браузере и рендерит в 3D:
 * персонаж/монстры — примитивные риги с пружинной анимацией (actor.ts), окружение из
 * генератора (env3d.ts), VFX-партиклы (vfx.ts). Управление WASD + мышь. Старый 2D-клиент не трогаем.
 * Позже локальный sim заменится на нет-клиент (тот же рендер потребляет снапшоты сервера).
 */
import * as THREE from 'three';
import {
  ConfigRegistry, GameSession, newCharacterSave, generateDungeon, spawnPacks, createRng,
  dominantType, TILE, type PlayerInput, type DungeonLayout, type DamageType,
} from '@dm/shared';
import { makeCharacter, type ActorHandle } from './actor.js';
import { Vfx } from './vfx.js';
import { setFog, makeSceneLighting, buildEnvironment, animateTorches, type Torch } from './env3d.js';

const ELEM: Record<DamageType, number> = { physical: 0xcfcfd6, fire: 0xff5a2a, cold: 0x59a8ff, lightning: 0xffe24a, poison: 0x6ecb3f };
const FACTION: Record<string, number> = { undead: 0x9fb7a6, demon: 0xc9614a, beast: 0xb08a55, monster: 0x8a6fae };
const yaw = (facing: number): number => Math.PI / 2 - facing;
function weaponForClass(id: string): 'sword' | 'axe' | 'staff' { return id === 'mage' || id === 'vorozheya' ? 'staff' : id === 'warrior' ? 'axe' : 'sword'; }

/** Плавающая полоска HP над монстром (спрайт, авто-биллборд; перерисов только при заметном изменении). */
function makeHpBar(): { spr: THREE.Sprite; set: (f: number) => void } {
  const c = document.createElement('canvas'); c.width = 64; c.height = 10; const g = c.getContext('2d')!;
  const t = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false })); spr.scale.set(38, 6, 1);
  let last = -1;
  const draw = (f: number): void => { g.clearRect(0, 0, 64, 10); g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, 0, 64, 10); g.fillStyle = f > 0.5 ? '#5ec24a' : f > 0.25 ? '#d8c24a' : '#d8583e'; g.fillRect(1, 1, 62 * f, 8); t.needsUpdate = true; };
  draw(1);
  return { spr, set: (f) => { f = Math.max(0, Math.min(1, f)); if (Math.abs(f - last) > 0.02) { last = f; draw(f); } } };
}

// ── Renderer / scene / camera ────────────────────────────────────────────────────
const canvas = document.getElementById('app') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene(); setFog(scene); makeSceneLighting(scene);
const camera = new THREE.PerspectiveCamera(52, 1, 1, 6000);
const floorGroup = new THREE.Group(); scene.add(floorGroup);   // геометрия этажа (пересобирается)
const actorsGroup = new THREE.Group(); scene.add(actorsGroup); // актёры/снаряды/лут
const fxGroup = new THREE.Group(); scene.add(fxGroup);
const vfx = new Vfx(fxGroup);

const cfg = new ConfigRegistry(); cfg.loadAll();

// ── Игровое состояние ────────────────────────────────────────────────────────────
let session!: GameSession;
let save!: ReturnType<typeof newCharacterSave>;
let seed = (Math.random() * 1e9) | 0, depth = 1, difficulty = 'normal';
let torches: Torch[] = [];
let playerActor!: ActorHandle;
let playerLight!: THREE.PointLight;
const monActors = new Map<number, { a: ActorHandle; dead: number; hp: ReturnType<typeof makeHpBar> }>();
const projMeshes = new Map<number, THREE.Mesh>();
const dropMeshes = new Map<number, THREE.Object3D>();
let floorCooldown = 0, running = false;

// ── Ввод ─────────────────────────────────────────────────────────────────────────
const keys = new Set<string>();
let lmb = false, rmb = false;
const aim = { wx: 1, wy: 0 };
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
const ray = new THREE.Raycaster(); const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2(); const hitPt = new THREE.Vector3();
let rot: null | { x: number; y: number } = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0) lmb = true;
  if (e.button === 2) { rmb = true; rot = { x: e.clientX, y: e.clientY }; }
});
addEventListener('pointerup', (e) => { if (e.button === 0) lmb = false; if (e.button === 2) { rmb = false; rot = null; } });
canvas.addEventListener('pointermove', (e) => {
  if (rot) { orbit.az -= (e.clientX - rot.x) * 0.005; orbit.el += (e.clientY - rot.y) * 0.005; rot.x = e.clientX; rot.y = e.clientY; }
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (ray.ray.intersectPlane(ground, hitPt)) { aim.wx = hitPt.x; aim.wy = hitPt.z; }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(160, Math.min(1100, orbit.dist * (e.deltaY < 0 ? 0.9 : 1.1))); }, { passive: false });

const orbit = { target: new THREE.Vector3(), dist: 470, az: -0.6, el: 0.95 };
function applyCam(): void {
  const el = Math.max(0.25, Math.min(1.4, orbit.el));
  camera.position.set(orbit.target.x + orbit.dist * Math.cos(el) * Math.sin(orbit.az), orbit.target.y + orbit.dist * Math.sin(el), orbit.target.z + orbit.dist * Math.cos(el) * Math.cos(orbit.az));
  camera.lookAt(orbit.target);
}

// ── Сборка этажа ─────────────────────────────────────────────────────────────────
function clearGroup(g: THREE.Object3D): void {
  for (let i = g.children.length - 1; i >= 0; i--) { const c = g.children[i]!; c.traverse((o) => { (o as THREE.Mesh).geometry?.dispose?.(); }); g.remove(c); }
}
function enterFloor(d: number): void {
  const layout: DungeonLayout = generateDungeon(seed + d * 7919, d, { cols: 52, rows: 40 });
  const rng = createRng(((seed ^ (d * 0x9e3779b1)) >>> 0) || 1);
  const monsters = spawnPacks(cfg, save, layout, d, difficulty, rng);
  session.enterFloor(d, { grid: layout.grid, spawn: layout.spawn, stairs: layout.stairsDown, monsters, doors: layout.doors, levers: layout.levers });

  clearGroup(floorGroup); clearGroup(actorsGroup);
  monActors.clear(); projMeshes.clear(); dropMeshes.clear();
  torches = buildEnvironment(floorGroup, layout);

  // Игрок.
  playerActor = makeCharacter({ body: 0x8a93ad, limb: 0x6f7690, metal: 0.35, weapon: weaponForClass(save.classId) });
  actorsGroup.add(playerActor.root);
  playerLight = new THREE.PointLight(0xffd7a0, 5200, 520, 2); playerLight.position.y = 96; playerActor.root.add(playerLight);
  floorCooldown = 1.5;
  toast(d === 1 ? 'Подземелье — этаж 1' : `Этаж ${d}`);
}

function ensureMonster(id: number, faction: string, champion: boolean): void {
  if (monActors.has(id)) return;
  const a = makeCharacter({ body: FACTION[faction] ?? 0x9a7f5a, limb: 0x5a5a64, head: FACTION[faction] ?? 0x8a6f4a, scale: champion ? 1.35 : 0.92, metal: 0.05, weapon: champion ? 'axe' : 'none' });
  const hp = makeHpBar(); hp.spr.position.y = 66; a.root.add(hp.spr);
  actorsGroup.add(a.root); monActors.set(id, { a, dead: 0, hp });
}

// ── Старт ────────────────────────────────────────────────────────────────────────
function start(classId: string): void {
  save = newCharacterSave(cfg, classId, 'Герой', 'local-1');
  session = new GameSession(cfg, seed, difficulty, { rewards: true });
  session.addPlayer('p1', save);
  depth = 1; enterFloor(depth);
  running = true;
}

// ── Тик + синхронизация ──────────────────────────────────────────────────────────
const TICK = 1 / 30; let acc = 0;
let dbgInput: PlayerInput | null = null; // отладочный ввод (проверка боя без клавиатуры)
function buildInput(): PlayerInput {
  if (dbgInput) return dbgInput;
  const p = session.world.players['p1'];
  let mx = 0, my = 0;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
  const facing = p ? Math.atan2(aim.wy - p.pos.y, aim.wx - p.pos.x) : 0;
  let cast: string | null = null;
  if (rmb && save.mouseRight && save.mouseRight !== 'attack') cast = save.mouseRight;
  else if (keys.has('Digit1') && save.hotbar[0]) cast = save.hotbar[0];
  else if (keys.has('Digit2') && save.hotbar[1]) cast = save.hotbar[1];
  else if (keys.has('Digit3') && save.hotbar[2]) cast = save.hotbar[2];
  return { move: { x: mx, y: my }, facing, attack: lmb, cast, interact: keys.has('KeyE') };
}

function onEvents(evs: ReturnType<GameSession['tick']>): void {
  for (const e of evs) {
    if (e.type === 'swing') { playerActor?.attack(1); vfx.slash(e.x, e.y, e.facing, 0xfff0c0, 44); }
    else if (e.type === 'monster-swing') { monActors.get(e.id)?.a.attack(1); }
    else if (e.type === 'hit' && e.hit && !e.blocked) { vfx.damage(e.x, e.y, Math.round(e.amount), ELEM[dominantType(e.byType)] ?? 0xffffff, e.crit); }
    else if (e.type === 'monster-died') { const m = monActors.get(e.id); if (m) { m.a.setDead(true); m.dead = 0.9; m.hp.spr.visible = false; } vfx.burst(e.x, e.y, 0xc0402a, 16, 100, 0.6); vfx.ring(e.x, e.y, 0x802010, 70, 0.5); }
    else if (e.type === 'levelup') { const p = session.world.players['p1']; if (p) { vfx.ring(p.pos.x, p.pos.y, 0xffd24a, 120, 0.8); vfx.burst(p.pos.x, p.pos.y, 0xffd24a, 24, 120, 0.9, 12, 30); } toast(`Уровень ${e.level}!`); }
    else if (e.type === 'player-died') { running = false; showDeath(); }
    else if (e.type === 'floor-cleared') toast('Этаж зачищен — ищите лестницу вниз');
  }
}

function projColor(owner: string, packet: unknown): number {
  try { return ELEM[dominantType(packet as never)] ?? 0xffffff; } catch { return owner === 'player' ? 0xffcc66 : 0xff5544; }
}

function sync(dt: number): void {
  const w = session.world;
  const p = w.players['p1'];
  if (p) {
    playerActor.setPose(p.pos.x, p.pos.y, yaw(p.facing));
    playerActor.setMove(Math.hypot(p.vel.x, p.vel.y) / 120);
    playerActor.setDead(!p.alive);
    orbit.target.set(p.pos.x, 24, p.pos.y);
  }
  playerActor?.update(dt);

  // Монстры.
  const live = new Set<number>();
  for (const m of w.monsters) {
    if (!m.alive && !monActors.has(m.id)) continue;
    live.add(m.id);
    ensureMonster(m.id, m.def.faction, m.def.rarity === 'champion');
    const rec = monActors.get(m.id)!;
    if (m.alive) { rec.a.setPose(m.pos.x, m.pos.y, yaw(m.facing)); rec.a.setMove(Math.hypot(m.vel.x, m.vel.y) / 90); rec.hp.set(m.hp / Math.max(1, m.maxHp)); }
    rec.a.update(dt);
  }
  // Удаление отыгравших смерть.
  for (const [id, rec] of monActors) {
    if (rec.dead > 0) { rec.dead -= dt; if (rec.dead <= 0) { actorsGroup.remove(rec.a.root); rec.a.dispose(); monActors.delete(id); } }
    else if (!live.has(id)) { actorsGroup.remove(rec.a.root); rec.a.dispose(); monActors.delete(id); }
  }

  // Снаряды.
  const pv = new Set<number>();
  for (const pr of w.projectiles) {
    pv.add(pr.id);
    let m = projMeshes.get(pr.id);
    if (!m) {
      const col = projColor(pr.owner, pr.packet);
      m = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 10), new THREE.MeshBasicMaterial({ color: col }));
      const gl = new THREE.PointLight(col, 40, 90, 2); m.add(gl); actorsGroup.add(m); projMeshes.set(pr.id, m);
      vfx.burst(pr.pos.x, pr.pos.y, col, 8, 45, 0.3, 7, 24); // вспышка-выстрел
    }
    m.position.set(pr.pos.x, 24, pr.pos.y);
  }
  for (const [id, m] of projMeshes) if (!pv.has(id)) { actorsGroup.remove(m); (m.geometry as THREE.BufferGeometry).dispose(); projMeshes.delete(id); }

  // Лут на земле.
  const dv = new Set<number>();
  for (const d of w.drops) {
    dv.add(d.id);
    let g = dropMeshes.get(d.id);
    if (!g) {
      const rc: Record<string, number> = { normal: 0xcfd3da, magic: 0x5b8bd0, rare: 0xd8c24a, unique: 0xc06a2a };
      const col = rc[d.item.rarity] ?? 0xcfd3da;
      g = new THREE.Group();
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(6), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.4 }));
      gem.position.y = 12; g.add(gem); g.add(new THREE.PointLight(col, 25, 70, 2).translateY(12));
      g.position.set(d.pos.x, 0, d.pos.y); actorsGroup.add(g); dropMeshes.set(d.id, g);
    }
    g.rotation.y += dt * 1.5; g.children[0]!.position.y = 12 + Math.sin(performance.now() / 300 + d.id) * 2;
  }
  for (const [id, g] of dropMeshes) if (!dv.has(id)) { actorsGroup.remove(g); dropMeshes.delete(id); }
}

// ── HUD ──────────────────────────────────────────────────────────────────────────
const hud = { hp: el('hp'), mana: el('mana'), stam: el('stam'), xp: el('xp'), info: el('info') };
function el(id: string): HTMLElement { return document.getElementById(id)!; }
function bar(node: HTMLElement, cur: number, max: number): void { node.style.width = `${Math.max(0, Math.min(100, (cur / Math.max(1, max)) * 100))}%`; }
function updateHud(): void {
  const p = session.world.players['p1']; if (!p) return;
  const snap = session.snapshotOf('p1');
  const d = snap?.derived;
  bar(hud.hp, p.hp, d?.maxHp ?? p.hp); bar(hud.mana, p.mana, d?.maxMana ?? 1); bar(hud.stam, p.stamina, d?.maxStamina ?? 1);
  const xt = cfg.get('balance').xpTable;
  const lvl = save.level, cur = xt[lvl - 1] ?? 0, nx = xt[lvl] ?? cur + 1;
  bar(hud.xp, save.xp - cur, Math.max(1, nx - cur));
  hud.info.textContent = `Ур. ${save.level}  ·  Золото ${save.gold}  ·  этаж ${depth}  ·  монстров ${session.monstersAlive}`;
}

// ── Тосты / смерть / меню ──────────────────────────────────────────────────────────
function toast(text: string): void { const t = el('toast'); t.textContent = text; t.style.opacity = '1'; setTimeout(() => { t.style.opacity = '0'; }, 1800); }
function showDeath(): void { const o = el('death'); o.style.display = 'flex'; }
el('respawn').addEventListener('click', () => { el('death').style.display = 'none'; session.respawnPlayer('p1'); running = true; });

function buildMenu(): void {
  const m = el('menu'); const row = el('classes');
  for (const c of cfg.get('classes')) {
    const b = document.createElement('button'); b.className = 'cls'; b.textContent = c.name;
    b.addEventListener('click', () => { m.style.display = 'none'; start(c.id); });
    row.appendChild(b);
  }
}

// ── Цикл ─────────────────────────────────────────────────────────────────────────
let last = performance.now(), t = 0;
function frameStep(dt: number): void {
  t += dt;
  if (running && session) {
    acc += dt; let guard = 0;
    while (acc >= TICK && guard++ < 4) { onEvents(session.tick(TICK, { p1: buildInput() })); acc -= TICK; }
    if (floorCooldown > 0) floorCooldown -= dt;
    const p = session.world.players['p1'], st = session.world.stairs;
    if (p && st && floorCooldown <= 0 && Math.hypot(p.pos.x - st.x, p.pos.y - st.y) < 26) { depth++; enterFloor(depth); }
    sync(dt); updateHud();
  }
  animateTorches(torches, t); vfx.update(dt); applyCam();
}
function loop(): void {
  const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
  frameStep(dt); renderer.render(scene, camera); requestAnimationFrame(loop);
}

function resize(): void { const w = canvas.clientWidth || innerWidth || 960, h = canvas.clientHeight || innerHeight || 600; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); new ResizeObserver(resize).observe(canvas);
resize(); buildMenu(); loop();
(window as unknown as { __g: unknown }).__g = { get session() { return session; }, start, frameStep, render: () => renderer.render(scene, camera), renderer, scene, camera, monActors, projMeshes, dropMeshes, setDbg: (i: PlayerInput | null) => { dbgInput = i; } };
