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
import { TILE, Cell, monsterCombatStats, debuffIcon, weapon3dKeyFromEquipment, type Grid, type FloorInit, type WorldSnapshot, type DamageType, type PlayerInput, type SaveState, type ScaledMonster, type DebuffKind } from '@dm/shared';
import { initPhysics, PhysWorld, type RagdollHandle } from './ragdoll.js';
import { makeGamePlayerDoll, makeHumanoidDoll } from './gamePlayerDoll.js';
import { loadRagdollConfig } from './humanoidRagdoll.js';
import { charFor, monsterCharId } from './chars3d.js';
import { Vfx } from './vfx.js';
import { StatusFx } from './statusFx.js';
import { setFog, makeSceneLighting, buildEnvironment, updateTorches, createTorchPool, WALL_H, type Torch } from './env3d.js';
import { runAuthFlow } from './screens3d.js';
import { mountHud3d } from './hud3d.js';
import { mountMinimap, type MiniMark } from './minimap3d.js';
import { mountDebug } from './debug3d.js';
import { DomUi } from '../ui/domUi.js';
import { GameLog } from '../ui/gameLog.js';
import { ActionBar } from '../ui/actionBar.js';
import { BeltBar } from '../ui/beltBar.js';
import { SfxController } from '../modules/sfx/sfx.js';
import { inventoryPanel } from '../modules/inventory/inventoryPanel.js';
import { getHeld } from '../modules/inventory/heldItem.js';
import { dmgColorNum } from '../core/damageTypes.js';
import { characterPanel, masterPanel } from '../modules/progression/panels.js';
import { skillsPanel } from '../modules/skills/skillsPanel.js';
import { shopPanel } from '../modules/town/shopPanel.js';
import { forgePanel } from '../modules/town/forgePanel.js';
import { difficultyPanel } from '../modules/town/difficultyPanel.js';
import { stashPanel } from '../modules/town/stashPanel.js';
import { questLogPanel } from '../modules/quests/questLogPanel.js';
import { runNodeLabel } from '../modules/run/runLabels.js';
import { runMapPanel } from '../modules/run/runMapPanel.js';

const yaw = (facing: number): number => Math.PI / 2 - facing;
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
/** Табличка над монстром (как 2D drawStatus): имя (цвет по редкости) + HP-бар (чемпион шире/золотой) + стан ✷. */
function makeNameplate(name: string, champion: boolean, special: boolean): { spr: THREE.Sprite; set: (f: number) => void; setStun: (s: boolean) => void; setDebuffs: (icons: string) => void } {
  const W = 140, H = 54;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d')!;
  const t = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  const scale = champion ? 60 : 48; spr.scale.set(scale, scale * H / W, 1);
  const nameColor = champion ? '#dca94b' : special ? '#6f9bcf' : '#c4bca8';   // золото / синий / серый
  const bw = champion ? 104 : 84, bx = (W - bw) / 2, by = 21, bh = 8;
  let curF = 1, curStun = false, curDeb = '';
  const draw = (): void => {
    g.clearRect(0, 0, W, H);
    g.font = `bold ${champion ? 14 : 12}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(name, W / 2, 10);
    g.fillStyle = nameColor; g.fillText(name, W / 2, 10);
    if (curStun) { g.fillStyle = '#ffe27a'; g.fillText('✷', W / 2 + g.measureText(name).width / 2 + 10, 10); }
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(bx, by, bw, bh);
    g.fillStyle = curF > 0.5 ? '#5ec24a' : curF > 0.25 ? '#d8c24a' : '#d8583e'; g.fillRect(bx + 1, by + 1, (bw - 2) * curF, bh - 2);
    if (champion) { g.strokeStyle = '#dca94b'; g.lineWidth = 1; g.strokeRect(bx, by, bw, bh); }
    if (curDeb) { g.font = '18px system-ui, sans-serif'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(curDeb, W / 2, 44); g.fillStyle = '#fff'; g.fillText(curDeb, W / 2, 44); }   // иконки+стаки статус-эффектов
    t.needsUpdate = true;
  };
  draw();
  return {
    spr,
    set: (f) => { f = Math.max(0, Math.min(1, f)); if (Math.abs(f - curF) > 0.02) { curF = f; draw(); } },
    setStun: (s) => { if (s !== curStun) { curStun = s; draw(); } },
    setDebuffs: (icons) => { if (icons !== curDeb) { curDeb = icons; draw(); } },
  };
}

/** Ключ 3D-оружия из ЭКИПИРОВКИ: shared-маппинг (weaponClass/hands + офф-рука); нет/неизвестно — класс-дефолт 3D-оружия. */
function weaponKeyFromSave(save: SaveState): string {
  return weapon3dKeyFromEquipment(save.equipment.weapon, save.equipment.offhand) ?? charFor(save.classId).weapon;
}
/** Эффективный 3D-ключ игрока из снапшота (weaponKey с сервера, иначе класс-дефолт) — для кукол пиров. */
function weaponKeyFromView(pv: { weaponKey?: string; classId: string }): string {
  return pv.weaponKey ?? charFor(pv.classId).weapon;
}

interface Interactable { x: number; y: number; radius: number; label: string; run: () => void; doorId?: number }
/** Кукла + служебные поля рендера (низкочастотная скорость для походки, hp-бар монстра). */
interface Actor { d: RagdollHandle; vx: number; vz: number; lx: number; lz: number; hp?: ReturnType<typeof makeNameplate>; dead?: number; maxHp?: number; knock?: { f: number; dx: number; dz: number }; def?: ScaledMonster; wkey?: string; dormant?: boolean }

export async function startOnline3d(): Promise<void> {
  // ── Рендерер / сцена / камера ──────────────────────────────────────────────
  const canvas = document.getElementById('app') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); setFog(scene); makeSceneLighting(scene);
  const torchPool = createTorchPool(scene);   // фикс. пул света факелов (перф) — назначается ближайшим к игроку, создаётся раз
  const camera = new THREE.PerspectiveCamera(52, 1, 1, 6000);
  const floorGroup = new THREE.Group(); scene.add(floorGroup);
  const actorsGroup = new THREE.Group(); scene.add(actorsGroup);
  const fxGroup = new THREE.Group(); scene.add(fxGroup);
  const vfx = new Vfx(fxGroup);
  const statusFx = new StatusFx(fxGroup);   // зацикленные партикл-эффекты активных статусов на сущностях
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
  ui.register('runmap', runMapPanel);
  new SfxController(app);
  app.gameLog = new GameLog(app, root);
  const hud = mountHud3d(app);
  const minimap = mountMinimap(root);
  let monKinematic = false;   // debug (DBG-панель / K): монстры кинематические, физика лишь на удар/смерть — тест источника фризов
  let monNoIk = false;        // debug (J): монстры БЕЗ вспом. IK (foot/off-hand) у ВСЕХ — форсит поза-LOD в цикле ниже
  const debug = mountDebug(scene, camera, canvas, root, {
    onMonKinematic: (on) => { monKinematic = on; for (const a of monsters.values()) a.d.setPhysicsMode?.(on ? 'kinematic' : 'physics'); },
    onLowRes: (on) => { renderer.setPixelRatio(on ? 1 : Math.min(devicePixelRatio, 2)); resize(); },   // 1× пиксели → режем фрагментную цену
    onMonNoIk: (on) => { monNoIk = on; },   // применяется в цикле монстров (форс poseLod у всех)
  });

  await initPhysics();
  const pw = new PhysWorld();

  // ── Ввод ────────────────────────────────────────────────────────────────────
  const keys = new Set<string>();
  let lmb = false, rmb = false;
  const mouse = { x: 0, y: 0, set: false };
  // Камера: азимут ФИКСИРОВАН (вращения по ПКМ нет), наклон меняется с зумом — близко угол ниже
  // (камера опускается), далеко топ-даун как на скрине. Зум-аут ограничен ракурсом скрина.
  const CAM = { minDist: 160, maxDist: 480, elNear: 0.55, elFar: 0.95, az: -0.6 };
  const orbit = { target: new THREE.Vector3(), dist: 460 };
  addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;   // ввод в форму — не игровой ключ
    keys.add(e.code);
    if (e.code === 'Space' || e.code === 'Tab' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) lmb = true; if (e.button === 2) rmb = true; });
  addEventListener('pointerup', (e) => { if (e.button === 0) lmb = false; if (e.button === 2) rmb = false; });
  canvas.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.set = true; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(CAM.minDist, Math.min(CAM.maxDist, orbit.dist * (e.deltaY < 0 ? 0.9 : 1.1))); }, { passive: false });
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
    const zt = Math.max(0, Math.min(1, (orbit.dist - CAM.minDist) / (CAM.maxDist - CAM.minDist)));   // 0 близко … 1 далеко
    const el = CAM.elNear + (CAM.elFar - CAM.elNear) * zt;                                           // близко — ниже угол, далеко — топ-даун
    camera.position.set(orbit.target.x + orbit.dist * Math.cos(el) * Math.sin(CAM.az), orbit.target.y + orbit.dist * Math.sin(el), orbit.target.z + orbit.dist * Math.cos(el) * Math.cos(CAM.az));
    camera.lookAt(orbit.target);
  };

  // ── Состояние мира ───────────────────────────────────────────────────────────
  let myId = '';
  let area: 'town' | 'dungeon' = 'town';
  let self: Actor | undefined;
  let selfWeaponKey = '';   // текущий 3D-ключ оружия/щита игрока (для пересборки при смене снаряжения)
  const peers = new Map<string, Actor>();
  const monsters = new Map<number, Actor>();
  const projMeshes = new Map<number, THREE.Mesh>();
  const dropMeshes = new Map<number, THREE.Object3D>();
  let latest: WorldSnapshot | undefined;
  let smoothX = 0, smoothZ = 0, hasSmooth = false;
  let seq = 0;
  let playerLight: THREE.PointLight | undefined;
  let torches: Torch[] = [];
  let areaGrid: Grid | undefined;   // грид текущей области (для DBG-счётчика монстров вне пола)
  let interactables: Interactable[] = [];
  const doorMeshes = new Map<number, THREE.Object3D[]>();
  const leverMeshes = new Map<number, THREE.Object3D>();
  const npcLabels: { spr: THREE.Sprite }[] = [];
  let hudBars: { action: ActionBar; belt: BeltBar } | undefined;   // пояс + панель биндов (D2), создаём в мире

  const disposeActor = (a: Actor): void => { actorsGroup.remove(a.d.group); a.d.dispose(); if (a.hp) actorsGroup.remove(a.hp.spr); };
  const markDead = (a: Actor): void => { if (a.dead != null) return; a.dormant = false; a.d.setDead(true); a.dead = 1.1; if (a.hp) a.hp.spr.visible = false; };   // регдолл-коллапс на смерти (setDead будит уснувшего)
  const clearGroup = (g: THREE.Object3D): void => { for (let i = g.children.length - 1; i >= 0; i--) { const c = g.children[i]!; c.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()); g.remove(c); } };

  // ── Постройка области (город/этаж) из FloorInit ──────────────────────────────
  function buildArea(floor: FloorInit): void {
    // снести прошлую область
    for (const a of peers.values()) disposeActor(a); peers.clear();
    for (const a of monsters.values()) disposeActor(a); monsters.clear();
    for (const m of projMeshes.values()) actorsGroup.remove(m); projMeshes.clear();
    for (const m of dropMeshes.values()) actorsGroup.remove(m); dropMeshes.clear();
    for (const n of npcLabels) actorsGroup.remove(n.spr); npcLabels.length = 0;
    statusFx.clear();   // сбросить партикл-эффекты статусов прошлой области
    doorMeshes.clear(); leverMeshes.clear(); interactables = [];
    clearGroup(floorGroup);
    area = floor.area;
    areaGrid = floor.grid;   // для DBG-диагностики «монстры вне пола»
    if (app.state) app.state.area = floor.area;   // HUD/отчёт различают город/этаж по area (depth=0 у старта забега = как город)

    const layout = { grid: floor.grid, doors: [], decor: floor.decor, stairsDown: floor.stairs } as unknown as Parameters<typeof buildEnvironment>[1];
    torches = buildEnvironment(floorGroup, layout);
    pw.buildStatic(layout);

    // Игрок-кукла (создаём один раз, дальше перемещаем в spawn). Оружие/щит — из ЭКИПИРОВКИ.
    const classId = app.state!.save.classId;
    selfWeaponKey = weaponKeyFromSave(app.state!.save);
    if (!self) {
      const d = makeGamePlayerDoll(pw, { classId, weapon: selfWeaponKey, x: floor.spawn.x, z: floor.spawn.y });
      actorsGroup.add(d.group);
      self = { d, vx: 0, vz: 0, lx: floor.spawn.x, lz: floor.spawn.y };
      playerLight = new THREE.PointLight(0xffd7a0, 5200, 520, 2); scene.add(playerLight);
    } else {
      self.d.setWeapon?.(selfWeaponKey);   // на новом этаже снаряжение могло смениться
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
      if (monKinematic) d.setPhysicsMode?.('kinematic');   // спавн при активном debug-режиме → сразу кинематический
      actorsGroup.add(d.group);
      const champion = m.def.rarity === 'champion', special = champion || m.def.affixes.length > 0;
      const hp = makeNameplate(m.def.name, champion, special); actorsGroup.add(hp.spr);
      monsters.set(m.id, { d, vx: 0, vz: 0, lx: m.x, lz: m.y, hp, def: m.def });
    }

    if (floor.area === 'dungeon') {
      const isFinale = (floor.exits?.length ?? 0) === 0;
      // Выходы на следующий узел (v2 развилка): лестница-меш + интерактив «Спуститься» по своему ребру графа.
      const exits = floor.exits ?? (floor.stairs ? [floor.stairs] : []);
      exits.forEach((ex, i) => {
        const st = new THREE.Group();
        for (let s = 0; s < 4; s++) { const step = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.9, 5, TILE - s * 5), new THREE.MeshStandardMaterial({ color: 0x2a2a33 })); step.position.set(0, -s * 5 - 2.5, s * 3); st.add(step); }
        st.position.set(ex.x, 0, ex.y); floorGroup.add(st);
        interactables.push({ x: ex.x, y: ex.y, radius: 34, label: exitLabel(floor, i), run: () => descendExit(i) });
      });
      // Декор узла: общий сундук / лавка / портал (rest → в город, финал → завершить забег). Меши строит env3d.
      for (const d of floor.decor) {
        if (d.kind === 'stash') interactables.push({ x: d.x, y: d.y, radius: 40, label: 'Общий сундук', run: () => app.bus.emit('ui:open', { panel: 'stash' }) });
        else if (d.kind === 'shop') interactables.push({ x: d.x, y: d.y, radius: 40, label: 'Лавка', run: () => app.bus.emit('ui:open', { panel: 'shop' }) });
        else if (d.kind === 'portal') interactables.push(isFinale
          ? { x: d.x, y: d.y, radius: 44, label: 'Завершить забег (голосование)', run: () => app.net.send({ t: 'descend' }) }
          : { x: d.x, y: d.y, radius: 44, label: 'Вернуться в город (голосование)', run: () => app.net.send({ t: 'return' }) });
      }
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
      app.run = null; // город — забега нет (мог остаться от завершённого/бросенного)
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
    app.gameLog?.setVisible(true);   // лента лога/«чат» видна только В ИГРЕ (как 2D OnlineScene.buildArea)
    minimap.setFloor(floor.grid); minimap.setVisible(true);
    debug.setFloor(floor.grid);
  }

  /** Спуск через i-й выход: маппит выход на i-е ребро текущего узла (targetNodeId, лениво — граф уже актуален на момент клика). */
  function descendExit(i: number): void {
    const run = app.run;
    const cur = run?.plan.nodes.find((n) => n.id === run.currentNodeId);
    app.net.send({ t: 'descend', targetNodeId: cur?.edges[i]?.to });
  }
  /** Подпись выхода: на развилке (>1 ребро) — тип целевого узла (see-ahead), иначе обычный спуск. */
  function exitLabel(floor: FloorInit, i: number): string {
    const cur = app.run?.plan.nodes.find((n) => n.id === floor.runNodeId);
    if (cur && cur.edges.length > 1) {
      const to = cur.edges[i]?.to;
      const tn = to ? app.run!.plan.nodes.find((n) => n.id === to) : undefined;
      if (tn) return `Спуститься: ${runNodeLabel(tn.type)} (голосование)`;
    }
    return 'Спуститься глубже (голосование)';
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
  // Окно-culling монстров: активны (полный физ-апдейт + поза-пайплайн + pw.step) только те, что попадают в
  // видимый на экране прямоугольник земли + запас по пол-экрана с каждой стороны; остальные УСЫПЛЕНЫ — тела
  // вынуты из физ-мира (pw.step их не считает), поза-пайплайн пропущен, меш заморожен. Так стоимость кадра
  // не зависит от плотности этажа (ping = RTT главного потока) — платим лишь за то, что реально видно + буфер.
  const WIN_MARGIN = 0.5;               // запас: +50% ширины окна с КАЖДОЙ стороны (= «пол-экрана»)
  const WIN_MAX_R = 2000;               // кламп дальности угловых лучей от цели (near-горизонт. верх экрана не улетает в ∞)
  const WIN_HYST = 140;                 // гистерезис-полоса (u): бодрствующего усыпляем лишь за окном + полосой — нет флаттера на кромке
  const POSE_LOD_R2 = 600 * 600;        // радиус² поза-LOD: дальше игрока → без FOOT-IK (монстр всё так же шагает, стопы вдали не видно)
  const _wc: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];   // углы экрана в NDC
  const _wv = new THREE.Vector3();
  let winMinX = -Infinity, winMaxX = Infinity, winMinZ = -Infinity, winMaxZ = Infinity;   // AABB активного окна (world XZ)
  /** Пересчитать AABB активного окна: анпроджектим 4 угла экрана на плоскость y=0, берём габарит, расширяем на запас. */
  function computeActiveWindow(): void {
    camera.updateMatrixWorld();
    const cx = orbit.target.x, cz = orbit.target.z, px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const [nx, ny] of _wc) {
      _wv.set(nx, ny, 0.5).unproject(camera);                                  // точка на луче через угол экрана
      const dx = _wv.x - px, dy = _wv.y - py, dz = _wv.z - pz;
      let gx: number, gz: number;
      if (dy < -1e-3) {                                                        // луч вниз → пересечение с полом y=0
        const t = -py / dy; gx = px + dx * t; gz = pz + dz * t;
        const rx = gx - cx, rz = gz - cz, r = Math.hypot(rx, rz);
        if (r > WIN_MAX_R) { gx = cx + (rx / r) * WIN_MAX_R; gz = cz + (rz / r) * WIN_MAX_R; }   // near-горизонт → кламп
      } else {                                                                // вверх/параллельно (не должно при наклоне) → кламп по направлению
        const r = Math.hypot(dx, dz) || 1; gx = cx + (dx / r) * WIN_MAX_R; gz = cz + (dz / r) * WIN_MAX_R;
      }
      if (gx < mnx) mnx = gx; if (gx > mxx) mxx = gx; if (gz < mnz) mnz = gz; if (gz > mxz) mxz = gz;
    }
    const ex = (mxx - mnx) * WIN_MARGIN, ez = (mxz - mnz) * WIN_MARGIN;
    winMinX = mnx - ex; winMaxX = mxx + ex; winMinZ = mnz - ez; winMaxZ = mxz + ez;
  }
  function driveActor(a: Actor, x: number, z: number, facing: number, alive: boolean, dt: number, doUpdate = true): void {
    const nvx = (x - a.lx) / Math.max(dt, 1e-3), nvz = (z - a.lz) / Math.max(dt, 1e-3);
    a.vx += (nvx - a.vx) * 0.25; a.vz += (nvz - a.vz) * 0.25;   // low-pass: гасит 30/60Гц-джиттер (иначе ложный страйф)
    a.lx = x; a.lz = z;
    a.d.setPose(x, z, yaw(facing));
    a.d.setWorldVel?.(a.vx, a.vz);
    a.d.setMove(Math.min(1, Math.hypot(a.vx, a.vz) / 120));
    a.d.setDead(!alive);
    if (doUpdate) a.d.update(dt);
  }

  function renderWorld(dt: number): void {
    if (!latest || !self) return;
    computeActiveWindow();   // AABB видимого окна (+запас) — гейт активности физики монстров ниже
    const mine = latest.players.find((p) => p.id === myId);
    if (mine) {
      if (!hasSmooth || Math.hypot(mine.x - smoothX, mine.y - smoothZ) > 120) { smoothX = mine.x; smoothZ = mine.y; hasSmooth = true; }
      else { const k = 1 - Math.exp(-dt / 0.045); smoothX += (mine.x - smoothX) * k; smoothZ += (mine.y - smoothZ) * k; }
      driveActor(self, smoothX, smoothZ, mine.facing, mine.alive, dt);
      const st = app.state!; st.hp = mine.hp; st.mana = mine.mana; st.stamina = mine.stamina; st.debuffs = mine.debuffs;
      statusFx.sync('self', smoothX, smoothZ, mine.debuffs);   // эффекты статусов на игроке
      if (st.toggles.join(',') !== mine.toggles.join(',')) { st.toggles = mine.toggles; app.bus.emit('state:changed', {}); } else st.toggles = mine.toggles;
      orbit.target.set(smoothX, 20, smoothZ);
      if (playerLight) playerLight.position.set(smoothX, 90, smoothZ);
    }
    // пиры
    const seenP = new Set<string>();
    for (const pv of latest.players) {
      if (pv.id === myId) continue; seenP.add(pv.id);
      let a = peers.get(pv.id);
      const wk = weaponKeyFromView(pv);   // реальное оружие пира из снапшота (иначе класс-дефолт)
      if (!a) { const d = makeGamePlayerDoll(pw, { classId: pv.classId, weapon: wk, x: pv.x, z: pv.y }); actorsGroup.add(d.group); a = { d, vx: 0, vz: 0, lx: pv.x, lz: pv.y, wkey: wk }; peers.set(pv.id, a); }
      else if (a.wkey !== wk) { a.wkey = wk; a.d.setWeapon?.(wk); }   // пир сменил экипировку → пересобрать меш + адаптировать позы удара
      driveActor(a, pv.x, pv.y, pv.facing, pv.alive, dt);
    }
    for (const [id, a] of peers) if (!seenP.has(id)) { disposeActor(a); peers.delete(id); }
    // монстры
    const dcfg = app.config.get('debuffs');
    for (const mv of latest.monsters) {
      const a = monsters.get(mv.id); if (!a) continue;
      if (!mv.alive) { markDead(a); statusFx.remove(`m${mv.id}`); continue; }   // не удаляем сразу — регдолл падает (см. коллапс-луп ниже)
      if (a.dead != null) continue;               // уже коллапсирует/лежит — снапшот не воскрешает
      a.maxHp = mv.maxHp;                          // для отброса трупа по %-урона убивающего удара
      // Окно-culling: в окне → активен (полный физ-апдейт); вне → усыплён (тела вон из pw.step, поза-пайплайн пропущен).
      // Гистерезис: спящего будим строго по входу в окно, бодрствующего усыпляем лишь за окном + полосой → нет флаттера на кромке.
      const inWin = mv.x >= winMinX && mv.x <= winMaxX && mv.y >= winMinZ && mv.y <= winMaxZ;
      const active = a.dormant
        ? inWin
        : (mv.x >= winMinX - WIN_HYST && mv.x <= winMaxX + WIN_HYST && mv.y >= winMinZ - WIN_HYST && mv.y <= winMaxZ + WIN_HYST);
      if (active && a.dormant) { a.dormant = false; a.d.setSimEnabled?.(true); }       // вход в окно → вернуть в физику (+снап к цели)
      else if (!active && !a.dormant) { a.dormant = true; a.d.setSimEnabled?.(false); } // выход за окно → вон из физики, меш заморожен
      if (active) a.d.setPoseLod?.(monNoIk || (mv.x - smoothX) * (mv.x - smoothX) + (mv.y - smoothZ) * (mv.y - smoothZ) > POSE_LOD_R2);   // дальний в кадре (или debug J: все) → без вспом. IK
      driveActor(a, mv.x, mv.y, mv.facing, true, dt, active);   // dormant → doUpdate=false: setPose держит цель живой, тяжёлый шаг пропущен
      if (a.hp) { a.hp.spr.position.set(mv.x, 74, mv.y); a.hp.set(mv.hp / Math.max(1, mv.maxHp)); a.hp.setStun(mv.stun); a.hp.setDebuffs((Object.keys(mv.debuffs) as DebuffKind[]).filter((k) => mv.debuffs[k]).map((k) => `${debuffIcon(dcfg, k)}${mv.debuffs[k]!.stacks > 1 ? mv.debuffs[k]!.stacks : ''}`).join(' ')); }
      statusFx.sync(`m${mv.id}`, mv.x, mv.y, mv.debuffs);   // партикл-эффекты статусов (горит/яд/лёд/…)
    }
    // Мёртвые монстры: регдолл падает ~1с (физика активна), потом ЗАМИРАЕТ и лежит на полу (не убираем).
    // Осев (a.dead≤0), тело ВЫНИМАЕТСЯ из физ-мира (setSimEnabled(false)) — труп замерзает в позе и не грузит pw.step.
    // Трупы чистятся при смене этажа (buildArea сносит всех).
    for (const a of monsters.values()) {
      if (a.dead == null) continue;
      if (a.dead <= 0) { if (!a.dormant) { a.dormant = true; a.d.setSimEnabled?.(false); } continue; }   // осел → вон из физики, лежит замороженным
      a.d.update(dt); a.dead -= dt;
    }
    // снаряды
    const seenPr = new Set<number>();
    for (const pr of latest.projectiles) {
      seenPr.add(pr.id);
      let m = projMeshes.get(pr.id);
      if (!m) { const tint = pr.owner === 'monster' ? 0xff8080 : dmgColorNum(pr.dom); m = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 8), new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.7 })); actorsGroup.add(m); projMeshes.set(pr.id, m); }
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
        // Гем самосветится (emissive) — БЕЗ PointLight: каждый дроп-свет менял число света в сцене → Three.js
        // перекомпилировал ВСЕ материалы (синхронный хитч в главном потоке на каждый спавн/деспаун лута).
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(6), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.9 }));
        gem.position.y = 12; g.add(gem);
        g.position.set(d.x, 0, d.y); actorsGroup.add(g); dropMeshes.set(d.id, g);
      }
    }
    for (const [id, g] of dropMeshes) if (!seenD.has(id)) { actorsGroup.remove(g); dropMeshes.delete(id); }
  }

  // Позиция сущности из последнего снапшота (игрок-строка / монстр-число) — направление дёрга.
  function posOf(id: string | number): { x: number; y: number } | undefined {
    if (!latest) return undefined;
    if (typeof id === 'string') { const p = latest.players.find((q) => q.id === id); return p ? { x: p.x, y: p.y } : undefined; }
    const m = latest.monsters.find((q) => q.id === id); return m ? { x: m.x, y: m.y } : undefined;
  }
  // Кукла цели события (монстр/свой/пир).
  function dollOf(target: 'player' | 'monster', id: string | number): RagdollHandle | undefined {
    if (target === 'monster') return monsters.get(id as number)?.d;
    return id === myId ? self?.d : peers.get(id as string)?.d;
  }
  // Позы-клипы для анимации скила: e.ability = nodeId скила (или 'attack' для базовой). Нашли узел с poseClips → чередуем.
  function abilityPoseClips(ability: string): string[] | undefined {
    const clips = app.config.get('skill-tree')?.nodes.find((n) => n.id === ability)?.effect.active?.poseClips;
    return clips && clips.length ? clips : undefined;
  }

  // ── События сервера (VFX + лог + звук через шину) ────────────────────────────
  function onEvents(events: import('@dm/shared').SessionEvent[]): void {
    const bus = app.bus;
    for (const e of events) {
      if (e.type === 'hit') {
        const dom = (['physical', 'fire', 'cold', 'lightning', 'poison'] as const).reduce((b, t) => (e.byType[t] > e.byType[b] ? t : b), 'physical' as DamageType);
        // Боевой фидбэк плавающим текстом (как 2D feedback): промах/блок/число. Видят все.
        if (!e.hit) vfx.floatText(e.x, e.y, 'промах', 0x9a9a9a);
        else if (e.blocked) vfx.floatText(e.x, e.y, 'блок', 0x8fd0ff);
        else if (e.amount > 0) vfx.damage(e.x, e.y, e.amount, e.target === 'player' ? 0xff5b5b : dmgColorNum(dom), e.crit);
        // Последний атакованный монстр → реальный шанс попасть/увернуться в листе персонажа (как 2D netDriver).
        if (e.target === 'monster') { const mon = monsters.get(e.id as number); if (mon?.def) { const cs = monsterCombatStats(mon.def); app.lastTarget = { name: mon.def.name, accuracy: cs.accuracy, evade: cs.evade }; } }
        if (e.hit && !e.blocked && e.amount > 0) {   // ФИЗ-ДЁРГ цели от атакующего (импульс в торс/голову)
          const td = dollOf(e.target, e.id);
          const tp = posOf(e.id) ?? { x: e.x, y: e.y }, ap = e.by != null ? posOf(e.by) : undefined;
          let dx = 0, dz = 1; if (ap) { dx = tp.x - ap.x; dz = tp.y - ap.y; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; }
          td?.hitReact(dx, dz, e.crit ? 1.7 : 1);
          if (e.target === 'monster') {   // запомнить ПОСЛЕДНИЙ удар (он же убивающий перед monster-died) → отброс по %-урона
            const a = monsters.get(e.id as number);
            if (a) { const mx = a.maxHp ?? latest?.monsters.find((m) => m.id === e.id)?.maxHp ?? e.amount; a.knock = { f: Math.max(0, Math.min(1, e.amount / Math.max(1, mx))), dx, dz }; }
          }
        }
        if (e.target === 'monster' && e.by === myId && e.hit && e.amount > 0) bus.emit('log:message', { text: `Нанёс ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-out' });
        else if (e.target === 'player' && e.id === myId && e.hit && e.amount > 0) bus.emit('log:message', { text: `Получил ${e.amount}${e.crit ? ' крит!' : ''}`, kind: 'dmg-in' });
      } else if (e.type === 'monster-died') {
        const a = monsters.get(e.id);
        if (a) { markDead(a); if (a.knock) a.d.knockback?.(a.knock.dx, a.knock.dz, a.knock.f); }   // регдолл падает + отброс по %-урона убивающего удара
        vfx.burst(e.x, e.y, 0xc0402a, 16, 100, 0.6);
        if (e.by === myId) bus.emit('log:message', { text: `Убит ${e.def.name}`, kind: 'kill' });
      } else if (e.type === 'item-picked') {
        if (e.playerId === myId) { bus.emit('log:message', { text: `Поднято: ${e.item.name}`, kind: 'loot' }); bus.emit('item:picked', { item: e.item }); }
      } else if (e.type === 'gold') { if (e.playerId === myId) bus.emit('gold:changed', { gold: e.total }); }
      else if (e.type === 'xp') { if (e.playerId === myId) bus.emit('log:message', { text: `Опыт +${e.amount}`, kind: 'xp' }); }
      else if (e.type === 'levelup') { if (e.playerId === myId) { bus.emit('log:message', { text: `Новый уровень: ${e.level}!`, kind: 'kill' }); bus.emit('player:levelup', { level: e.level, attributePoints: 0, skillPoints: 0 }); } }
      else if (e.type === 'quest') { if (e.playerId === myId) bus.emit('log:message', { text: e.name, kind: 'system' }); }
      else if (e.type === 'player-died') { if (e.playerId === myId) bus.emit('player:died', { depth: app.state!.depth }); }
      else if (e.type === 'swing') {
        // Проиграть авторский удар КУКЛОЙ (у Волкодава — `hit_axe`): свой игрок или пир.
        const pv = latest?.players.find((p) => p.id === e.playerId);
        const actor = e.playerId === myId ? self : peers.get(e.playerId);
        actor?.d.attack(abilityPoseClips(e.ability), e.lockMs / 1000);   // скил с poseClips → чередуемые удары; базовая атака → удар по оружию. lockMs = окно атаки → клип целиком за него
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
  app.net.on('saveUpdate', (f) => {
    app.state!.save = f.save;
    if (self) { const k = weaponKeyFromSave(f.save); if (k !== selfWeaponKey) { selfWeaponKey = k; self.d.setWeapon?.(k); } }   // сменил оружие/щит → пересобрать меши
    app.bus.emit('state:changed', {});
  });
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

  function showConnecting(): void { app.gameLog?.setVisible(false); minimap.setVisible(false); if (connecting) return; connecting = mk(`<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px 30px;color:#e6ddc9;text-align:center"><div>Подключение к серверу…</div><div class="status" style="margin-top:8px;font-size:12px;color:#8f897c"></div></div>`, CENTER); statusEl = connecting.querySelector('.status') as HTMLElement; }
  function hideConnecting(): void { connecting?.remove(); connecting = undefined; }
  function showLobby(): void { app.gameLog?.setVisible(false); minimap.setVisible(false); if (lobby) return;
    lobby = mk(`<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px;min-width:280px;color:#e6ddc9;text-align:center"><div style="font-size:18px;margin-bottom:14px">Кооп</div><button data-a="solo" style="display:block;width:100%;margin:6px 0;padding:8px;background:#1e2a3a;color:#cfe0f2;border:1px solid #6f9bcf;border-radius:6px;cursor:pointer">Соло (комната на 1)</button><button data-a="host" style="display:block;width:100%;margin:6px 0;padding:8px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Создать комнату</button><div style="display:flex;gap:6px;margin-top:6px"><input class="code" placeholder="КОД" maxlength="4" style="flex:1;text-transform:uppercase;padding:8px;background:#0f131a;color:#e6ddc9;border:1px solid #2b323f;border-radius:6px"><button data-a="join" style="padding:8px 12px;background:#3a2c15;color:#f0d9a8;border:1px solid #e39a3c;border-radius:6px;cursor:pointer">Войти</button></div><div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div></div>`, CENTER);
    statusEl = lobby.querySelector('.status') as HTMLElement;
    const go = (o: { fresh?: boolean; roomCode?: string }): void => { statusEl!.textContent = 'Подключение…'; sendJoin(o); };
    lobby.querySelector('[data-a="solo"]')!.addEventListener('click', () => go({ fresh: true }));
    lobby.querySelector('[data-a="host"]')!.addEventListener('click', () => go({ fresh: true }));
    lobby.querySelector('[data-a="join"]')!.addEventListener('click', () => { const code = (lobby!.querySelector('.code') as HTMLInputElement).value.trim().toUpperCase(); if (code) go({ roomCode: code }); });
  }
  function hideLobby(): void { lobby?.remove(); lobby = undefined; }
  function showResume(roomCode: string, depth: number): void { app.gameLog?.setVisible(false); minimap.setVisible(false); if (resumeB) return; const where = depth > 0 ? `этаж ${depth}` : 'подземелье';
    resumeB = mk(`<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px;min-width:300px;color:#e6ddc9;text-align:center"><div style="font-size:18px;margin-bottom:8px">Незавершённый забег</div><div style="font-size:13px;color:#a8a090;margin-bottom:16px">У вас есть незавершённое прохождение (${where}${roomCode ? `, комната ${roomCode}` : ''}). Продолжить или завершить?</div><button data-a="resume" style="display:block;width:100%;margin:6px 0;padding:9px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Продолжить забег</button><button data-a="abandon" style="display:block;width:100%;margin:6px 0;padding:9px;background:#3a1c1c;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Завершить (гибель со штрафом)</button><div style="font-size:11px;color:#8f7a72;margin-top:4px">«Завершить» — персонаж считается погибшим: штраф золота и части предметов.</div><div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div></div>`, CENTER);
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
    // Предмет «на курсоре» (D2): клик по миру = бросок/отмена (см. heldItem.onWorldClick), НЕ атака/каст —
    // иначе тот же клик уходит как mouseLeft и персонаж бьёт при выбросе предмета из инвентаря.
    const holding = getHeld() != null;
    consider(s.mouseLeft, holding ? false : lmb, 'L');
    consider(s.mouseRight, holding ? false : rmb, 'R');
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
    else if (hint) hint.textContent = 'WASD — идти · ЛКМ/ПКМ/Shift/Space/Alt — действия · 1-4 — зелья · I/K/C — окна · колесо — зум · F3 — дебаг';
    eWasDown = eDown;
  }

  // ── Подключение ──────────────────────────────────────────────────────────────
  await runAuthFlow(app, root);   // логин → выбор персонажа
  showConnecting();
  app.net.onOpen(() => app.net.send({ t: 'runStatus', token: app.auth!.token, charId: app.pendingCharId! }));
  app.net.onClose(() => { hideConnecting(); showLobby(); if (statusEl) statusEl.textContent = 'Сервер недоступен'; });
  app.net.connect();

  // ── Кадр (вынесен, чтобы гнать вручную в фоновой вкладке — rAF там заморожен) ──
  let physAcc = 0, tsec = 0, fps = 60;
  function frame(dt: number): void {
    tsec += dt;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.1;
    updatePing();
    if (app.net.connected && myId && latest && app.state) {
      sendInput(); renderWorld(dt); hud.update(); updateInteractions();
      const me = latest.players.find((p) => p.id === myId);
      minimap.render(smoothX, smoothZ, me?.facing ?? 0,
        latest.monsters.filter((m) => m.alive).map((m) => ({ x: m.x, z: m.y })),
        latest.players.filter((p) => p.id !== myId).map((p) => ({ x: p.x, z: p.y })),
        interactables.map((it): MiniMark => ({ x: it.x, y: it.y, kind: /спуст|подземель|глубже|город|заверш/i.test(it.label) ? 'portal' : /рычаг/i.test(it.label) ? 'lever' : 'npc' })));
      if (debug.on) {
        const mel = app.config.get('balance').melee;
        const w = app.state.save.equipment.weapon;
        debug.update({
          info: { fps: Math.round(fps), tick: latest.tick, ping: app.net.rtt, x: Math.round(smoothX), z: Math.round(smoothZ), area, depth: app.state.depth, mon: monsters.size, peers: peers.size, drops: dropMeshes.size, seq,
            calls: renderer.info.render.calls, tris_k: Math.round(renderer.info.render.triangles / 1000), prog: renderer.info.programs?.length ?? 0, torches: torches.length,
            // Диагностика «монстры вне пола»: сколько ЖИВЫХ монстров стоят на клетке-НЕ-полу (стена/пустота/вне сетки).
            void: areaGrid ? latest.monsters.filter((m) => m.alive && areaGrid![Math.floor(m.y / TILE)]?.[Math.floor(m.x / TILE)] !== Cell.Floor).length : 0 },
          playerR: me?.r ?? 12,
          players: latest.players.map((p) => ({ x: p.id === myId ? smoothX : p.x, z: p.id === myId ? smoothZ : p.y, facing: p.facing, r: p.r, me: p.id === myId })),
          monsters: latest.monsters.map((mv) => { const def = monsters.get(mv.id)?.def; return { id: mv.id, x: mv.x, z: mv.y, facing: mv.facing, r: mv.r, alive: mv.alive, aiState: mv.aiState, vision: def?.vision ?? 0, visionAngle: def?.visionAngle ?? 0, hearing: def?.hearing ?? 0, hp: mv.hp, maxHp: mv.maxHp }; }),
          projectiles: latest.projectiles.map((pr) => ({ x: pr.x, z: pr.y, r: pr.r })),
          interactables: interactables.map((it) => ({ x: it.x, z: it.y, r: it.radius })),
          playerAttack: me ? { x: smoothX, z: smoothZ, facing: me.facing, reach: mel.baseRange * (w?.reachMult ?? 1), halfArc: (mel.baseArc * (w?.arcMult ?? 1)) / 2 } : null,
        });
      }
    }
    physAcc += dt; let guard = 0; while (physAcc >= 1 / 60 && guard++ < 4) { pw.step(1 / 60); physAcc -= 1 / 60; }
    updateTorches(torches, torchPool, smoothX, smoothZ, tsec); vfx.update(dt); statusFx.update(dt); applyCam();
    renderer.render(scene, camera);
  }

  if (import.meta.env.DEV) (window as unknown as { __o: unknown }).__o = { app, ui, scene, camera, renderer, frame, render: () => renderer.render(scene, camera), state: () => app.state, myId: () => myId, snap: () => latest, monsters, peers, self: () => self, onEvents };

  let last = performance.now();
  function loop(): void { const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now; frame(dt); requestAnimationFrame(loop); }
  loop();
}
