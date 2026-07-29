/**
 * ОНЛАЙН 3D-КЛИЕНТ — полный аналог 2D-клиента (OnlineScene+NetDriver+UIScene), но рендер на Three.js.
 * Никаких локальных сессий: реальный `App`+`NetClient` к авторитетному серверу, мир строится из кадров
 * `joined`/`areaChanged` (FloorInit) и рисуется из `snapshot` (WorldSnapshot). Ввод (WASD/мышь/скиллы) шлётся
 * на сервер; бой/движение/награды/лут считает сервер. DOM-панели (инвентарь/скилы/город/…), HUD, модалки
 * (лобби/голосование/смерть/код/пинг) — те же, что в 2D (Phaser-free). Куклы игрока/пиров/монстров — единый
 * физ-риг (gamePlayerDoll/humanoidRagdoll), внешность/оружие из серверного конфига (chars3d).
 */
import * as THREE from 'three';
import { App } from '../core/app.js';
import { GameState } from '../core/gameState.js';
import { TILE, type FloorInit, type WorldSnapshot, type DamageType, type PlayerInput } from '@dm/shared';
import { initPhysics, PhysWorld, type RagdollHandle } from './ragdoll.js';
import { makeGamePlayerDoll, makeHumanoidDoll } from './gamePlayerDoll.js';
import { loadRagdollConfig } from './humanoidRagdoll.js';
import { charFor, monsterCharId } from './chars3d.js';
import { Vfx } from './vfx.js';
import { setFog, makeSceneLighting, buildEnvironment, animateTorches, WALL_H, type Torch } from './env3d.js';
import { runAuthFlow } from './screens3d.js';
import { mountHud3d } from './hud3d.js';
import { DomUi } from '../ui/domUi.js';
import { GameLog } from '../ui/gameLog.js';
import { ActionBar } from '../ui/actionBar.js';
import { BeltBar } from '../ui/beltBar.js';
import { SfxController } from '../modules/sfx/sfx.js';
import { inventoryPanel } from '../modules/inventory/inventoryPanel.js';
import { characterPanel, masterPanel } from '../modules/progression/panels.js';
import { skillsPanel } from '../modules/skills/skillsPanel.js';
import { shopPanel } from '../modules/town/shopPanel.js';
import { forgePanel } from '../modules/town/forgePanel.js';
import { difficultyPanel } from '../modules/town/difficultyPanel.js';
import { stashPanel } from '../modules/town/stashPanel.js';
import { questLogPanel } from '../modules/quests/questLogPanel.js';

const yaw = (facing: number): number => Math.PI / 2 - facing;
const ELEM: Record<DamageType, number> = { physical: 0xffe680, fire: 0xff5a2a, cold: 0x59a8ff, lightning: 0xffe24a, poison: 0x6ecb3f };
const FACTION: Record<string, number> = { undead: 0x9fb7a6, demon: 0xc9614a, beast: 0xb08a55, monster: 0x8a6fae };
/** NPC/портал города — клиентский декор (позиции-константы в клетках); авторитет — сервер. */
const TOWN_NPCS: { cx: number; cy: number; label: string; panel: string; tint: number }[] = [
  { cx: 4, cy: 4, label: 'Магазин', panel: 'shop', tint: 0x9fd0ff },
  { cx: 7, cy: 4, label: 'Кузница', panel: 'forge', tint: 0xffa060 },
  { cx: 10, cy: 4, label: 'Мастер прокачки', panel: 'master', tint: 0xb090ff },
  { cx: 14, cy: 4, label: 'Доска квестов', panel: 'quests', tint: 0xd0c060 },
  { cx: 17, cy: 4, label: 'Сундук', panel: 'stash', tint: 0xc99a48 },
];

/** Плавающая полоска HP над монстром (спрайт-биллборд; перерисов только при заметном изменении). */
function makeHpBar(): { spr: THREE.Sprite; set: (f: number) => void } {
  const c = document.createElement('canvas'); c.width = 64; c.height = 10; const g = c.getContext('2d')!;
  const t = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false })); spr.scale.set(38, 6, 1);
  let last = -1;
  const draw = (f: number): void => { g.clearRect(0, 0, 64, 10); g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, 0, 64, 10); g.fillStyle = f > 0.5 ? '#5ec24a' : f > 0.25 ? '#d8c24a' : '#d8583e'; g.fillRect(1, 1, 62 * f, 8); t.needsUpdate = true; };
  draw(1);
  return { spr, set: (f) => { f = Math.max(0, Math.min(1, f)); if (Math.abs(f - last) > 0.02) { last = f; draw(f); } } };
}

interface Interactable { x: number; y: number; radius: number; label: string; run: () => void; doorId?: number }
/** Кукла + служебные поля рендера (низкочастотная скорость для походки, hp-бар монстра). */
interface Actor { d: RagdollHandle; vx: number; vz: number; lx: number; lz: number; hp?: ReturnType<typeof makeHpBar> }

export async function startOnline3d(): Promise<void> {
  // ── Рендерер / сцена / камера ──────────────────────────────────────────────
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); setFog(scene); makeSceneLighting(scene);
  const camera = new THREE.PerspectiveCamera(52, 1, 1, 6000);
  const floorGroup = new THREE.Group(); scene.add(floorGroup);
  const actorsGroup = new THREE.Group(); scene.add(actorsGroup);
  const fxGroup = new THREE.Group(); scene.add(fxGroup);
  const vfx = new Vfx(fxGroup);
  const resize = (): void => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();

  const root = document.getElementById('ui-root') ?? (() => { const r = document.createElement('div'); r.id = 'ui-root'; Object.assign(r.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '10' } satisfies Partial<CSSStyleDeclaration>); document.body.appendChild(r); return r; })();

  // ── App (реальный, с сетью) + панели + лог + звук + HUD ─────────────────────
  const app = new App();
  loadRagdollConfig();   // лимиты/моторы суставов из редактора (pe_ragdoll) до создания кукол
  const ui = new DomUi(app, root);
  ui.register('inventory', inventoryPanel); ui.register('character', characterPanel); ui.register('master', masterPanel);
  ui.register('skills', skillsPanel); ui.register('shop', shopPanel); ui.register('forge', forgePanel);
  ui.register('quests', questLogPanel); ui.register('difficulty', difficultyPanel); ui.register('stash', stashPanel);
  new SfxController(app);
  app.gameLog = new GameLog(app, root);
  const hud = mountHud3d(app);

  await initPhysics();
  const pw = new PhysWorld();

  // ── Ввод ────────────────────────────────────────────────────────────────────
  const keys = new Set<string>();
  let lmb = false, rmb = false, rot: null | { x: number; y: number } = null;
  const mouse = { x: 0, y: 0, set: false };
  const orbit = { target: new THREE.Vector3(), dist: 470, az: -0.6, el: 0.95 };
  addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;   // ввод в форму — не игровой ключ
    keys.add(e.code);
    if (e.code === 'Space' || e.code === 'Tab' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) lmb = true; if (e.button === 2) { rmb = true; rot = { x: e.clientX, y: e.clientY }; } });
  addEventListener('pointerup', (e) => { if (e.button === 0) lmb = false; if (e.button === 2) { rmb = false; rot = null; } });
  canvas.addEventListener('pointermove', (e) => { if (rot) { orbit.az -= (e.clientX - rot.x) * 0.005; orbit.el += (e.clientY - rot.y) * 0.005; rot.x = e.clientX; rot.y = e.clientY; } mouse.x = e.clientX; mouse.y = e.clientY; mouse.set = true; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(160, Math.min(1100, orbit.dist * (e.deltaY < 0 ? 0.9 : 1.1))); }, { passive: false });
  const ray = new THREE.Raycaster(); const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2(); const hitPt = new THREE.Vector3();
  const aimWorld = (): { x: number; y: number } | null => {
    if (!mouse.set) return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((mouse.x - r.left) / r.width) * 2 - 1, -((mouse.y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(ground, hitPt) ? { x: hitPt.x, y: hitPt.z } : null;
  };
  const applyCam = (): void => {
    const el = Math.max(0.25, Math.min(1.4, orbit.el));
    camera.position.set(orbit.target.x + orbit.dist * Math.cos(el) * Math.sin(orbit.az), orbit.target.y + orbit.dist * Math.sin(el), orbit.target.z + orbit.dist * Math.cos(el) * Math.cos(orbit.az));
    camera.lookAt(orbit.target);
  };

  // ── Состояние мира ───────────────────────────────────────────────────────────
  let myId = '';
  let area: 'town' | 'dungeon' = 'town';
  let self: Actor | undefined;
  const peers = new Map<string, Actor>();
  const monsters = new Map<number, Actor>();
  const projMeshes = new Map<number, THREE.Mesh>();
  const dropMeshes = new Map<number, THREE.Object3D>();
  let latest: WorldSnapshot | undefined;
  let smoothX = 0, smoothZ = 0, hasSmooth = false;
  let seq = 0;
  let playerLight: THREE.PointLight | undefined;
  let torches: Torch[] = [];
  let interactables: Interactable[] = [];
  const doorMeshes = new Map<number, THREE.Object3D[]>();
  const leverMeshes = new Map<number, THREE.Object3D>();
  const npcLabels: { spr: THREE.Sprite }[] = [];
  let hudBars: { action: ActionBar; belt: BeltBar } | undefined;   // пояс + панель биндов (D2), создаём в мире

  const disposeActor = (a: Actor): void => { actorsGroup.remove(a.d.group); a.d.dispose(); if (a.hp) actorsGroup.remove(a.hp.spr); };
  const clearGroup = (g: THREE.Object3D): void => { for (let i = g.children.length - 1; i >= 0; i--) { const c = g.children[i]!; c.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); g.remove(c); } };

  // ── Постройка области (город/этаж) из FloorInit ──────────────────────────────
  function buildArea(floor: FloorInit): void {
    // снести прошлую область
    for (const a of peers.values()) disposeActor(a); peers.clear();
    for (const a of monsters.values()) disposeActor(a); monsters.clear();
    for (const m of projMeshes.values()) actorsGroup.remove(m); projMeshes.clear();
    for (const m of dropMeshes.values()) actorsGroup.remove(m); dropMeshes.clear();
    for (const n of npcLabels) actorsGroup.remove(n.spr); npcLabels.length = 0;
    doorMeshes.clear(); leverMeshes.clear(); interactables = [];
    clearGroup(floorGroup);
    area = floor.area;

    const layout = { grid: floor.grid, doors: [], decor: floor.decor, stairsDown: floor.stairs } as unknown as Parameters<typeof buildEnvironment>[1];
    torches = buildEnvironment(floorGroup, layout);
    pw.buildStatic(layout);

    // Игрок-кукла (создаём один раз, дальше перемещаем в spawn).
    const classId = app.state!.save.classId;
    if (!self) {
      const d = makeGamePlayerDoll(pw, { classId, weapon: charFor(classId).weapon, x: floor.spawn.x, z: floor.spawn.y });
      actorsGroup.add(d.group);
      self = { d, vx: 0, vz: 0, lx: floor.spawn.x, lz: floor.spawn.y };
      playerLight = new THREE.PointLight(0xffd7a0, 5200, 520, 2); scene.add(playerLight);
    } else {
      self.d.setPose(floor.spawn.x, floor.spawn.y, 0);
      self.lx = floor.spawn.x; self.lz = floor.spawn.y;
    }
    // Пояс (слева-внизу) + панель биндов ЛКМ/ПКМ/Shift/Space/Alt (по центру) — те же DOM-компоненты, что в 2D UIScene.
    if (!hudBars) hudBars = { action: new ActionBar(app, root), belt: new BeltBar(app, root) };
    smoothX = floor.spawn.x; smoothZ = floor.spawn.y; hasSmooth = false;

    // Монстры области (по FloorInit; вид/удары/стойки — по фракции из конфига).
    for (const m of floor.monsters) {
      const faction = (m.def as { faction?: string }).faction ?? 'monster';
      const mc = charFor(monsterCharId(faction));
      const col = FACTION[faction] ?? 0x8a6f4a;
      const d = makeHumanoidDoll(pw, { x: m.x, z: m.y, weapon: mc.weapon, gaitId: monsterCharId(faction), gaitFallback: 'warrior', gender: mc.gender, build: mc.build, colors: { body: col, limb: 0x5a5a64, head: col } });
      actorsGroup.add(d.group);
      const hp = makeHpBar(); actorsGroup.add(hp.spr);
      monsters.set(m.id, { d, vx: 0, vz: 0, lx: m.x, lz: m.y, hp });
    }

    if (floor.area === 'dungeon') {
      if (floor.stairs) interactables.push({ x: floor.stairs.x, y: floor.stairs.y, radius: 34, label: 'Спуститься глубже (голосование)', run: () => app.net.send({ t: 'descend' }) });
      // портал возврата в город у точки входа
      const back = new THREE.Mesh(new THREE.TorusGeometry(16, 4, 8, 20), new THREE.MeshStandardMaterial({ color: 0x8a5cff, emissive: 0x4a2aa0, emissiveIntensity: 0.7 }));
      back.rotation.x = Math.PI / 2; back.position.set(floor.spawn.x, 12, floor.spawn.y); floorGroup.add(back);
      interactables.push({ x: floor.spawn.x, y: floor.spawn.y, radius: 40, label: 'Вернуться в город (голосование)', run: () => app.net.send({ t: 'return' }) });
      // двери (свои меши, чтобы убирать по doorOpened) + рычаги
      for (const door of floor.doors) {
        const parts: THREE.Object3D[] = [];
        for (const c of door.cells) {
          const dw = new THREE.Mesh(new THREE.BoxGeometry(TILE, WALL_H * 0.85, TILE), new THREE.MeshStandardMaterial({ color: 0x6a4a2a }));
          dw.position.set(c.cx * TILE + TILE / 2, WALL_H * 0.42, c.cy * TILE + TILE / 2); floorGroup.add(dw); parts.push(dw);
        }
        doorMeshes.set(door.id, parts);
      }
      for (const lv of floor.levers) {
        const mk = new THREE.Mesh(new THREE.BoxGeometry(8, 22, 8), new THREE.MeshStandardMaterial({ color: 0xdca94b, emissive: 0x604010, emissiveIntensity: 0.5 }));
        mk.position.set(lv.x, 11, lv.y); floorGroup.add(mk); leverMeshes.set(lv.doorId, mk);
        interactables.push({ x: lv.x, y: lv.y, radius: 40, label: 'Рычаг (открыть дверь)', run: () => app.net.send({ t: 'lever', leverId: lv.id }), doorId: lv.doorId });
      }
      app.state!.depth = floor.depth;
    } else {
      // город: NPC-столбики с подписью-биллбордом + портал в подземелье
      for (const n of TOWN_NPCS) {
        const wx = n.cx * TILE + TILE / 2, wz = n.cy * TILE + TILE / 2;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 46, 8), new THREE.MeshStandardMaterial({ color: n.tint, emissive: n.tint, emissiveIntensity: 0.25 }));
        pole.position.set(wx, 23, wz); floorGroup.add(pole);
        const spr = labelSprite(n.label); spr.position.set(wx, 60, wz); actorsGroup.add(spr); npcLabels.push({ spr });
        interactables.push({ x: wx, y: wz, radius: 42, label: n.label, run: () => app.bus.emit('ui:open', { panel: n.panel }) });
      }
      const rows = floor.grid.length, cols = floor.grid[0]!.length;
      const pwx = (cols - 4) * TILE + TILE / 2, pwz = (rows - 4) * TILE + TILE / 2;
      const portal = new THREE.Mesh(new THREE.TorusGeometry(20, 5, 10, 24), new THREE.MeshStandardMaterial({ color: 0x8a5cff, emissive: 0x4a2aa0, emissiveIntensity: 0.8 }));
      portal.rotation.x = Math.PI / 2; portal.position.set(pwx, 16, pwz); floorGroup.add(portal);
      interactables.push({ x: pwx, y: pwz, radius: 46, label: 'В подземелье (выбор сложности)', run: () => app.bus.emit('ui:open', { panel: 'difficulty' }) });
      app.state!.depth = 0;
    }
  }

  function labelSprite(text: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 256; c.height = 40; const g = c.getContext('2d')!;
    g.font = 'bold 22px system-ui'; g.textAlign = 'center'; g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, 256, 40);
    g.fillStyle = '#e6ddc9'; g.fillText(text, 128, 28);
    const t = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false })); spr.scale.set(90, 14, 1);
    return spr;
  }

  function openDoor(doorId: number): void {
    for (const m of doorMeshes.get(doorId) ?? []) floorGroup.remove(m);
    doorMeshes.delete(doorId);
    const lv = leverMeshes.get(doorId); if (lv) floorGroup.remove(lv); leverMeshes.delete(doorId);
    interactables = interactables.filter((it) => it.doorId !== doorId);
  }

  // ── Рендер мира из снапшота ──────────────────────────────────────────────────
  function driveActor(a: Actor, x: number, z: number, facing: number, alive: boolean, dt: number): void {
    const nvx = (x - a.lx) / Math.max(dt, 1e-3), nvz = (z - a.lz) / Math.max(dt, 1e-3);
    a.vx += (nvx - a.vx) * 0.25; a.vz += (nvz - a.vz) * 0.25;   // low-pass: гасит 30/60Гц-джиттер (иначе ложный страйф)
    a.lx = x; a.lz = z;
    a.d.setPose(x, z, yaw(facing));
    a.d.setWorldVel?.(a.vx, a.vz);
    a.d.setMove(Math.min(1, Math.hypot(a.vx, a.vz) / 120));
    a.d.setDead(!alive);
    a.d.update(dt);
  }

  function renderWorld(dt: number): void {
    if (!latest || !self) return;
    const mine = latest.players.find((p) => p.id === myId);
    if (mine) {
      if (!hasSmooth || Math.hypot(mine.x - smoothX, mine.y - smoothZ) > 120) { smoothX = mine.x; smoothZ = mine.y; hasSmooth = true; }
      else { const k = 1 - Math.exp(-dt / 0.045); smoothX += (mine.x - smoothX) * k; smoothZ += (mine.y - smoothZ) * k; }
      driveActor(self, smoothX, smoothZ, mine.facing, mine.alive, dt);
      const st = app.state!; st.hp = mine.hp; st.mana = mine.mana; st.stamina = mine.stamina; st.debuffs = mine.debuffs;
      if (st.toggles.join(',') !== mine.toggles.join(',')) { st.toggles = mine.toggles; app.bus.emit('state:changed', {}); } else st.toggles = mine.toggles;
      orbit.target.set(smoothX, 20, smoothZ);
      if (playerLight) playerLight.position.set(smoothX, 90, smoothZ);
    }
    // пиры
    const seenP = new Set<string>();
    for (const pv of latest.players) {
      if (pv.id === myId) continue; seenP.add(pv.id);
      let a = peers.get(pv.id);
      if (!a) { const d = makeGamePlayerDoll(pw, { classId: pv.classId, weapon: charFor(pv.classId).weapon, x: pv.x, z: pv.y }); actorsGroup.add(d.group); a = { d, vx: 0, vz: 0, lx: pv.x, lz: pv.y }; peers.set(pv.id, a); }
      driveActor(a, pv.x, pv.y, pv.facing, pv.alive, dt);
    }
    for (const [id, a] of peers) if (!seenP.has(id)) { disposeActor(a); peers.delete(id); }
    // монстры
    for (const mv of latest.monsters) {
      const a = monsters.get(mv.id); if (!a) continue;
      if (!mv.alive) { disposeActor(a); monsters.delete(mv.id); continue; }
      driveActor(a, mv.x, mv.y, mv.facing, true, dt);
      if (a.hp) { a.hp.spr.position.set(mv.x, 70, mv.y); a.hp.set(mv.hp / Math.max(1, mv.maxHp)); }
    }
    // снаряды
    const seenPr = new Set<number>();
    for (const pr of latest.projectiles) {
      seenPr.add(pr.id);
      let m = projMeshes.get(pr.id);
      if (!m) { const tint = pr.owner === 'monster' ? 0xff8080 : ELEM[pr.dom] ?? 0xffe680; m = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 8), new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.7 })); actorsGroup.add(m); projMeshes.set(pr.id, m); }
      m.position.set(pr.x, 22, pr.y);
    }
    for (const [id, m] of projMeshes) if (!seenPr.has(id)) { actorsGroup.remove(m); projMeshes.delete(id); }
    // дропы
    const seenD = new Set<number>();
    for (const d of latest.drops) {
      seenD.add(d.id);
      if (!dropMeshes.has(d.id)) {
        const col = 0xdcc060;
        const g = new THREE.Group();
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(6), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5 }));
        gem.position.y = 12; g.add(gem); g.add(new THREE.PointLight(col, 25, 70, 2).translateY(12));
        g.position.set(d.x, 0, d.y); actorsGroup.add(g); dropMeshes.set(d.id, g);
      }
    }
    for (const [id, g] of dropMeshes) if (!seenD.has(id)) { actorsGroup.remove(g); dropMeshes.delete(id); }
  }

  // ── События сервера (VFX + лог + звук через шину) ────────────────────────────
  function onEvents(events: import('@dm/shared').SessionEvent[]): void {
    const bus = app.bus;
    for (const e of events) {
      if (e.type === 'hit') {
        const dom = (['physical', 'fire', 'cold', 'lightning', 'poison'] as const).reduce((b, t) => (e.byType[t] > e.byType[b] ? t : b), 'physical' as DamageType);
        if (e.hit && e.amount > 0) vfx.damage(e.x, e.y, e.amount, e.target === 'player' ? 0xff5b5b : ELEM[dom], e.crit);
        if (e.target === 'monster' && e.by === myId) {
          const nm = monsters.get(e.id as number);
          if (e.hit && e.amount > 0) bus.emit('log:message', { text: `Нанёс ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-out' });
          void nm;
        } else if (e.id === myId && e.hit && e.amount > 0) bus.emit('log:message', { text: `Получил ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-in' });
      } else if (e.type === 'monster-died') {
        const a = monsters.get(e.id); if (a) { disposeActor(a); monsters.delete(e.id); }
        if (e.by === myId) bus.emit('log:message', { text: `Убит ${e.def.name}`, kind: 'kill' });
      } else if (e.type === 'item-picked') {
        if (e.playerId === myId) { bus.emit('log:message', { text: `Поднято: ${e.item.name}`, kind: 'loot' }); bus.emit('item:picked', { item: e.item }); }
      } else if (e.type === 'gold') { if (e.playerId === myId) bus.emit('gold:changed', { gold: e.total }); }
      else if (e.type === 'xp') { if (e.playerId === myId) bus.emit('log:message', { text: `Опыт +${e.amount}`, kind: 'xp' }); }
      else if (e.type === 'levelup') { if (e.playerId === myId) { bus.emit('log:message', { text: `Новый уровень: ${e.level}!`, kind: 'kill' }); bus.emit('player:levelup', { level: e.level, attributePoints: 0, skillPoints: 0 }); } }
      else if (e.type === 'quest') { if (e.playerId === myId) bus.emit('log:message', { text: e.name, kind: 'system' }); }
      else if (e.type === 'player-died') { if (e.playerId === myId) bus.emit('player:died', { depth: app.state!.depth }); }
      else if (e.type === 'swing') {
        // Проиграть авторский удар КУКЛОЙ (у Волкодава — `удар_axe`): свой игрок или пир.
        const pv = latest?.players.find((p) => p.id === e.playerId);
        const actor = e.playerId === myId ? self : peers.get(e.playerId);
        actor?.d.attack();
        if (pv) vfx.slash(pv.x, pv.y, pv.facing, 0xffe6a0, 48);
        if (e.playerId === myId) {   // свой удар — заливка-откат слота биндов
          const now = performance.now();
          app.actionCooldowns[e.ability] = { start: now, until: now + e.cooldownMs };
          app.attackLockUntil = now + e.lockMs;
        }
      } else if (e.type === 'monster-swing') {
        monsters.get(e.id)?.d.attack();   // монстр машет своим оружием (авторский удар фракции / фолбэк)
      }
    }
  }

  // ── Сетевые обработчики (данные + жизненный цикл) ────────────────────────────
  app.net.on('snapshot', (f) => { latest = f.snap; });
  app.net.on('events', (f) => onEvents(f.events));
  app.net.on('saveUpdate', (f) => { app.state!.save = f.save; app.bus.emit('state:changed', {}); });
  app.net.on('shop', (f) => { app.shopStock = f.items; app.bus.emit('state:changed', {}); });
  app.net.on('questBoard', (f) => { app.questBoard = f.quests; app.bus.emit('state:changed', {}); });
  app.net.on('stash', (f) => { app.stash = { tabs: f.tabs, cols: f.cols, rows: f.rows, tabCount: f.tabCount }; app.bus.emit('state:changed', {}); });
  app.net.on('joined', (f) => {
    hideAll(); myId = f.playerId;
    const st = new GameState(f.save); st.restoreFull(); app.state = st;
    buildArea(f.floor); showRoomCode(f.roomCode);
  });
  app.net.on('areaChanged', (f) => { closeDeath(); buildArea(f.floor); });
  app.net.on('doorOpened', (f) => openDoor(f.doorId));
  app.net.on('died', (f) => showDeath(f));
  app.net.on('voteStart', (f) => showVote(f.kind));
  app.net.on('voteUpdate', (f) => { const t = voteBox?.querySelector('.tally'); if (t) t.textContent = `${f.yes}/${f.total}`; });
  app.net.on('voteEnd', () => closeVote());
  app.net.on('runStatus', (f) => { hideConnecting(); if (f.hasRun) showResume(f.roomCode ?? '', f.depth ?? 0); else showLobby(); });
  app.net.on('abandoned', () => { hideResume(); showLobby(); });
  app.net.on('error', (f) => { if (f.code === 'no-run') { hideResume(); showLobby(); return; } if (statusEl) statusEl.textContent = f.msg; });
  app.net.on('peerLeft', (f) => { const a = peers.get(f.id); if (a) { disposeActor(a); peers.delete(f.id); } });

  // ── Модалки (DOM, как в 2D OnlineScene) ──────────────────────────────────────
  let lobby: HTMLElement | undefined, resumeB: HTMLElement | undefined, connecting: HTMLElement | undefined;
  let voteBox: HTMLElement | undefined, deathBox: HTMLElement | undefined, codeLabel: HTMLElement | undefined, pingLabel: HTMLElement | undefined;
  let statusEl: HTMLElement | undefined; let lastPing = -2;
  const mk = (html: string, css: string): HTMLElement => { const b = document.createElement('div'); b.style.cssText = css; b.innerHTML = html; root.appendChild(b); return b; };
  const CENTER = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);z-index:90;pointer-events:auto';
  const sendJoin = (o: { fresh?: boolean; roomCode?: string; resume?: boolean }): void => app.net.send({ t: 'join', token: app.auth!.token, charId: app.pendingCharId!, ...o });

  function showConnecting(): void { if (connecting) return; connecting = mk(`<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px 30px;color:#e6ddc9;text-align:center"><div>Подключение к серверу…</div><div class="status" style="margin-top:8px;font-size:12px;color:#8f897c"></div></div>`, CENTER); statusEl = connecting.querySelector('.status') as HTMLElement; }
  function hideConnecting(): void { connecting?.remove(); connecting = undefined; }
  function showLobby(): void { app.gameLog?.setVisible(false); if (lobby) return;
    lobby = mk(`<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px;min-width:280px;color:#e6ddc9;text-align:center"><div style="font-size:18px;margin-bottom:14px">Кооп</div><button data-a="solo" style="display:block;width:100%;margin:6px 0;padding:8px;background:#1e2a3a;color:#cfe0f2;border:1px solid #6f9bcf;border-radius:6px;cursor:pointer">Соло (комната на 1)</button><button data-a="host" style="display:block;width:100%;margin:6px 0;padding:8px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Создать комнату</button><div style="display:flex;gap:6px;margin-top:6px"><input class="code" placeholder="КОД" maxlength="4" style="flex:1;text-transform:uppercase;padding:8px;background:#0f131a;color:#e6ddc9;border:1px solid #2b323f;border-radius:6px"><button data-a="join" style="padding:8px 12px;background:#3a2c15;color:#f0d9a8;border:1px solid #e39a3c;border-radius:6px;cursor:pointer">Войти</button></div><div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div></div>`, CENTER);
    statusEl = lobby.querySelector('.status') as HTMLElement;
    const go = (o: { fresh?: boolean; roomCode?: string }): void => { statusEl!.textContent = 'Подключение…'; sendJoin(o); };
    lobby.querySelector('[data-a="solo"]')!.addEventListener('click', () => go({ fresh: true }));
    lobby.querySelector('[data-a="host"]')!.addEventListener('click', () => go({ fresh: true }));
    lobby.querySelector('[data-a="join"]')!.addEventListener('click', () => { const code = (lobby!.querySelector('.code') as HTMLInputElement).value.trim().toUpperCase(); if (code) go({ roomCode: code }); });
  }
  function hideLobby(): void { lobby?.remove(); lobby = undefined; }
  function showResume(roomCode: string, depth: number): void { if (resumeB) return; const where = depth > 0 ? `этаж ${depth}` : 'подземелье';
    resumeB = mk(`<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px;min-width:300px;color:#e6ddc9;text-align:center"><div style="font-size:18px;margin-bottom:8px">Незавершённое прохождение</div><div style="font-size:13px;color:#a8a090;margin-bottom:16px">Вы вышли из подземелья (${where}, комната ${roomCode}). Продолжить или забросить?</div><button data-a="resume" style="display:block;width:100%;margin:6px 0;padding:9px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Продолжить</button><button data-a="abandon" style="display:block;width:100%;margin:6px 0;padding:9px;background:#3a1c1c;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Забросить</button><div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div></div>`, CENTER);
    statusEl = resumeB.querySelector('.status') as HTMLElement;
    resumeB.querySelector('[data-a="resume"]')!.addEventListener('click', () => { statusEl!.textContent = 'Возврат…'; sendJoin({ resume: true }); });
    resumeB.querySelector('[data-a="abandon"]')!.addEventListener('click', () => { statusEl!.textContent = 'Забрасываем…'; app.net.send({ t: 'abandon', token: app.auth!.token, charId: app.pendingCharId! }); });
  }
  function hideResume(): void { resumeB?.remove(); resumeB = undefined; }
  function showRoomCode(code: string): void { if (!codeLabel) codeLabel = mk('', 'position:fixed;top:8px;right:12px;z-index:60;background:#171b24;border:1px solid #6f9bcf;border-radius:6px;padding:6px 10px;color:#cfe0f2;font-size:13px;pointer-events:none'); codeLabel.innerHTML = `Комната: <b style="color:#dca94b;letter-spacing:2px">${code}</b>`; }
  function showVote(kind: 'descend' | 'town'): void { if (voteBox) return; const q = kind === 'town' ? 'Вернуться в город?' : 'Спуск на след. этаж?';
    voteBox = mk(`<div style="margin-bottom:8px">${q} <b class="tally">1/1</b></div><button data-v="1" style="margin:0 4px;padding:6px 14px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Принять</button><button data-v="0" style="margin:0 4px;padding:6px 14px;background:#421;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Отмена</button>`, 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:88;background:#171b24;border:1px solid #6f9bcf;border-radius:8px;padding:12px 16px;color:#e6ddc9;text-align:center;pointer-events:auto');
    voteBox.querySelector('[data-v="1"]')!.addEventListener('click', () => app.net.send({ t: 'vote', accept: true }));
    voteBox.querySelector('[data-v="0"]')!.addEventListener('click', () => app.net.send({ t: 'vote', accept: false }));
  }
  function closeVote(): void { voteBox?.remove(); voteBox = undefined; }
  function showDeath(f: { goldLost: number; itemsLost: number; toTown: boolean }): void { closeDeath();
    const status = f.toTown ? 'Возвращаетесь в город…' : 'Ожидайте: пати спустится — там возродитесь.';
    deathBox = mk(`<div style="font-size:24px;margin-bottom:10px">Вы погибли</div><div style="font-size:14px;color:#d9a898">Потеряно: <b>${f.goldLost}</b> золота, <b>${f.itemsLost}</b> предм.</div><div style="font-size:13px;color:#b09088;margin-top:10px">${status}</div>${f.toTown ? '' : '<button data-a="spec" style="margin-top:14px;padding:8px 16px;background:#3a2030;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Смотреть</button>'}`, 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:96;background:rgba(30,8,10,0.96);border:1px solid #c85a48;border-radius:12px;padding:22px 30px;color:#e6c8bd;text-align:center;min-width:280px;pointer-events:auto');
    deathBox.querySelector('[data-a="spec"]')?.addEventListener('click', () => closeDeath());
  }
  function closeDeath(): void { deathBox?.remove(); deathBox = undefined; }
  function hideAll(): void { hideConnecting(); hideResume(); hideLobby(); }
  function updatePing(): void { const rtt = app.net.rtt; if (rtt === lastPing) return; lastPing = rtt;
    if (!pingLabel) pingLabel = mk('', 'position:fixed;top:40px;right:12px;z-index:60;background:rgba(23,27,36,0.8);border:1px solid #2b323f;border-radius:6px;padding:4px 8px;color:#cfe0f2;font-size:12px;font-family:monospace;pointer-events:none');
    const c = rtt < 0 ? '#8f897c' : rtt < 60 ? '#7fdc7f' : rtt < 120 ? '#dcd07f' : rtt < 200 ? '#dcae7f' : '#dc7f7f';
    pingLabel.innerHTML = `ping <b style="color:${c}">${rtt < 0 ? '—' : rtt}</b> мс`;
  }

  // ── Ввод → сервер (схема как в 2D NetDriver) ─────────────────────────────────
  const wasHeld: Record<string, boolean> = {};   // предыдущее удержание по источнику — фронт-детекция тоглов
  function isToggleSkill(nodeId: string): boolean {
    const cat = app.config.get('skill-tree')?.nodes.find((n) => n.id === nodeId)?.effect.active?.category;
    return cat === 'aura' || cat === 'stance';
  }
  function sendInput(): void {
    const s = app.state!.save;
    const mine = latest?.players.find((p) => p.id === myId);
    let mx = 0, my = 0;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
    let facing = mine?.facing ?? 0;
    const a = aimWorld();
    if (mine && a && Math.hypot(a.x - smoothX, a.y - smoothZ) > 10) facing = Math.atan2(a.y - smoothZ, a.x - smoothX);
    else if (!mouse.set && (mx || my)) facing = Math.atan2(my, mx);
    // ЛКМ/ПКМ + Shift/Space/Alt = mouseLeft/mouseRight/hotbar[0..2]. Тогл (аура/стойка) — только по фронту нажатия.
    let attack = false, cast: string | null = null;
    const consider = (b: string | null | undefined, held: boolean, src: string): void => {
      const prev = wasHeld[src] ?? false; wasHeld[src] = held;
      if (!held || !b) return;
      if (b === 'attack') { attack = true; return; }
      if (isToggleSkill(b) && prev) return;
      if (cast == null) cast = b;
    };
    consider(s.mouseLeft, lmb, 'L');
    consider(s.mouseRight, rmb, 'R');
    consider(s.hotbar[0], keys.has('ShiftLeft') || keys.has('ShiftRight'), 'S');
    consider(s.hotbar[1], keys.has('Space'), 'Sp');
    consider(s.hotbar[2], keys.has('AltLeft') || keys.has('AltRight'), 'A');
    const input: PlayerInput = { move: { x: mx, y: my }, facing, attack, cast, interact: keys.has('KeyE') };
    app.net.send({ t: 'input', seq: seq++, input });
  }

  // ── Взаимодействия [E] (NPC/портал/лестница/рычаг) ───────────────────────────
  const hint = document.getElementById('hint');
  let eWasDown = false;
  function updateInteractions(): void {
    if (!self) return;
    let near: Interactable | undefined, best = Infinity;
    for (const it of interactables) { const d = Math.hypot(it.x - smoothX, it.y - smoothZ); if (d <= it.radius && d < best) { near = it; best = d; } }
    const eDown = keys.has('KeyE');
    if (near) { if (hint) hint.textContent = `[E] ${near.label}`; if (eDown && !eWasDown) near.run(); }
    else if (hint) hint.textContent = 'WASD — идти · ЛКМ/ПКМ/Shift/Space/Alt — действия · 1-4 — зелья · I/K/C — окна · ПКМ-зажать — камера';
    eWasDown = eDown;
  }

  // ── Подключение ──────────────────────────────────────────────────────────────
  await runAuthFlow(app, root);   // логин → выбор персонажа
  showConnecting();
  app.net.onOpen(() => app.net.send({ t: 'runStatus', token: app.auth!.token, charId: app.pendingCharId! }));
  app.net.onClose(() => { hideConnecting(); showLobby(); if (statusEl) statusEl.textContent = 'Сервер недоступен'; });
  app.net.connect();

  // ── Кадр (вынесен, чтобы гнать вручную в фоновой вкладке — rAF там заморожен) ──
  let physAcc = 0, tsec = 0;
  function frame(dt: number): void {
    tsec += dt;
    updatePing();
    if (app.net.connected && myId && latest && app.state) { sendInput(); renderWorld(dt); hud.update(); updateInteractions(); }
    physAcc += dt; let guard = 0; while (physAcc >= 1 / 60 && guard++ < 4) { pw.step(1 / 60); physAcc -= 1 / 60; }
    animateTorches(torches, tsec); vfx.update(dt); applyCam();
    renderer.render(scene, camera);
  }

  if (import.meta.env.DEV) (window as unknown as { __o: unknown }).__o = { app, ui, scene, camera, renderer, frame, render: () => renderer.render(scene, camera), state: () => app.state, myId: () => myId, snap: () => latest, monsters, peers, self: () => self, onEvents };

  let last = performance.now();
  function loop(): void { const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now; frame(dt); requestAnimationFrame(loop); }
  loop();
}
