/**
 * ВКЛАДКА «ТЕСТ»: персонаж откликается на ввод ровно так же, как в клиенте.
 *
 * Смысл один — не бегать между редактором и игрой, чтобы посмотреть, что получилось. Но проверка
 * стоит чего-то, только если она честная: «почти как в игре» хуже, чем ничего, потому что расхождение
 * спишут на настройку и пойдут крутить исправные ручки.
 *
 * Поэтому здесь НЕТ своей логики. Движение — `testScene` (настоящий `GameSession`, то же ядро, что у
 * сервера, теми же тиками). Ввод — `playerInput` (те же функции, что шлют input в игре). Снапшот в
 * куклу — `driveActor` (тот же привод). Кукла — `makeGamePlayerDoll` (та же, что в игре, а не манекен
 * редактора), и ВНЕШНОСТЬ ей даёт тот же `resolvePlayerLook`. Своё тут только камера и склейка — то есть
 * ровно то, что на позу не влияет.
 *
 * ⚠ Урок, купленный жалобой «ноги покоробило»: одной общей функции построения МАЛО, если её зовут с
 * разными входами. Кукла собиралась без `boneOffsets`/`boneScale`/`profile` — кости вставали по
 * встроенным числам, а меш оставался модельным, и скин тянул ноги туда, где их нет. Входы — такая же
 * часть шва, как и код.
 */
import * as THREE from 'three';
import { makeGamePlayerDoll } from './gamePlayerDoll.js';
import { loadAssetConfig, resolvePlayerLook, editorClasses } from './modelSkin.js';
import type { RagdollHandle, PhysWorld } from './ragdoll.js';
import { createTestScene, TEST_TICK_DT, type TestScene } from './testScene.js';
import { driveActor, type DriveState } from './driveActor.js';
import { moveFromKeys, facingFrom, aimOnGround, aimTmp, CAM_AZ } from './playerInput.js';
import type { PlayerInput } from '@dm/shared';

export interface TestTabHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Физмир редактора (ленивая инициализация — как и для остальных физ-панелей). */
  physics(): Promise<PhysWorld | null>;
  charId(): string;
  weapon(): string;
  /** Орбита редактора: в тесте камера ведёт персонажа, крутить её мышью нельзя — мышь это прицел. */
  setOrbit(on: boolean): void;
}

export interface TestTab {
  start(): Promise<void>;
  stop(): void;
  /** Кадр. Зовётся всегда; молчит, пока вкладка не активна. */
  frame(dt: number): void;
  readonly active: boolean;
  /** Строка состояния для панели: где стоим, с какой скоростью. */
  status(): string;
  /** Пересобрать куклу (сменили персонажа или оружие). */
  rebuild(): void;
}

/** Камера теста — те же числа, что в игре: изометрия 45°, угол подъёма растёт с дистанцией. */
const CAM = { minDist: 160, maxDist: 480, elNear: 0.55, elFar: 0.95, az: CAM_AZ };
const IDLE: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

export function createTestTab(host: TestTabHost): TestTab {
  let scene: TestScene | null = null;
  let doll: RagdollHandle | null = null;
  let drive: DriveState | null = null;
  let room: THREE.LineSegments | null = null;
  let dist = 300;
  let active = false;
  let want = false;   // вкладка открыта, но кукла ещё собирается (физика грузится асинхронно)
  const keys = new Set<string>();
  const mouse = { x: 0, y: 0, set: false };
  let lmb = false;
  let prevSpace = false;
  const aimT = aimTmp();
  const target = new THREE.Vector3();

  // ── Ввод. Слушаем окно, но игнорируем набор в поля — та же защита, что в игре. ────────────────
  const typing = (): boolean => {
    const t = document.activeElement;
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  };
  const onDown = (e: KeyboardEvent): void => {
    if (!active || typing()) return;
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  };
  const onUp = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const onMove = (e: PointerEvent): void => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.set = true; };
  const onBtnDown = (e: PointerEvent): void => { if (active && e.button === 0) lmb = true; };
  const onBtnUp = (e: PointerEvent): void => { if (e.button === 0) lmb = false; };
  const onWheel = (e: WheelEvent): void => {
    if (!active) return;
    e.preventDefault();
    dist = Math.max(CAM.minDist, Math.min(CAM.maxDist, dist * (e.deltaY < 0 ? 0.9 : 1.1)));
  };

  const applyCam = (x: number, z: number): void => {
    // Одна формула с игрой: близко — ниже угол, далеко — почти топ-даун.
    const zt = Math.max(0, Math.min(1, (dist - CAM.minDist) / (CAM.maxDist - CAM.minDist)));
    const el = CAM.elNear + (CAM.elFar - CAM.elNear) * zt;
    target.set(x, 30, z);
    host.camera.position.set(
      target.x + dist * Math.cos(el) * Math.sin(CAM.az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.cos(CAM.az),
    );
    host.camera.lookAt(target);
  };

  /** Рамка комнаты: без неё непонятно, где кончается пол и почему персонаж встал. */
  const makeRoom = (w: number, h: number): THREE.LineSegments => {
    const g = new THREE.BufferGeometry();
    const x0 = 0, z0 = 0, x1 = w, z1 = h, y = 1;
    const p = [x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0];
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a6480 }));
  };

  const teardown = (): void => {
    if (doll) { host.scene.remove(doll.group); doll.dispose(); doll = null; }
    if (room) { host.scene.remove(room); room.geometry.dispose(); (room.material as THREE.Material).dispose(); room = null; }
    scene = null; drive = null;
  };

  const build = async (): Promise<void> => {
    teardown();
    const pw = await host.physics();
    if (!pw || !want) return;            // ушли с вкладки, пока грузилась физика — куклу не плодим
    const classId = host.charId();
    // Тот же разбор, что в игре. Источник свой — локальная рабочая копия конфига: редактор обязан
    // показывать то, что правят ПРЯМО СЕЙЧАС, а не последнее опубликованное.
    const look = resolvePlayerLook(await loadAssetConfig(), editorClasses(), classId);
    if (!want) return;                   // ушли с вкладки, пока грузился конфиг
    scene = createTestScene(classId);
    doll = makeGamePlayerDoll(pw, { x: scene.view.x, z: scene.view.z, weapon: host.weapon(), classId, ...look });
    host.scene.add(doll.group);
    room = makeRoom(scene.bounds.w, scene.bounds.h);
    host.scene.add(room);
    drive = { d: doll, vx: 0, vz: 0, lx: scene.view.x, lz: scene.view.z };
    dist = 300;
    applyCam(scene.view.x, scene.view.z);
    active = true;
  };

  return {
    get active() { return active; },

    async start(): Promise<void> {
      want = true;
      addEventListener('keydown', onDown);
      addEventListener('keyup', onUp);
      host.canvas.addEventListener('pointermove', onMove);
      host.canvas.addEventListener('pointerdown', onBtnDown);
      addEventListener('pointerup', onBtnUp);
      host.canvas.addEventListener('wheel', onWheel, { passive: false });
      host.setOrbit(false);
      await build();
    },

    stop(): void {
      want = false; active = false;
      removeEventListener('keydown', onDown);
      removeEventListener('keyup', onUp);
      host.canvas.removeEventListener('pointermove', onMove);
      host.canvas.removeEventListener('pointerdown', onBtnDown);
      removeEventListener('pointerup', onBtnUp);
      host.canvas.removeEventListener('wheel', onWheel);
      keys.clear(); lmb = false;
      host.setOrbit(true);
      teardown();
    },

    rebuild(): void { if (want) void build(); },

    frame(dt: number): void {
      if (!active || !scene || !drive) return;
      const mv = moveFromKeys(keys, CAM.az);
      const aim = mouse.set ? aimOnGround(aimT, host.camera, host.canvas.getBoundingClientRect(), mouse.x, mouse.y) : null;
      const facing = facingFrom(scene.view.facing, aim, scene.view.x, scene.view.z, mv, mouse.set);
      const space = keys.has('Space');
      const input: PlayerInput = {
        ...IDLE,
        move: mv,
        facing,
        attack: lmb,
        interact: keys.has('KeyE'),
        dodge: space && !prevSpace,   // эджево, как в клиенте: рывок в кадр нажатия, а не пока держишь
      };
      prevSpace = space;

      for (const e of scene.step(dt, input)) {
        // Удар отыгрывает КУКЛА по серверному событию — с тем же окном и вайндапом, что в игре.
        if (e.type === 'swing') doll?.attack(undefined, e.lockMs / 1000, e.windupMs / 1000);
      }
      driveActor(drive, scene.view.x, scene.view.z, scene.view.facing, scene.view.alive, dt,
        { combat: scene.view.inCombat, stun: scene.view.stun });
      applyCam(scene.view.x, scene.view.z);
    },

    status(): string {
      if (!scene) return active ? 'собираем куклу…' : 'вкладка не активна';
      const v = drive ? Math.hypot(drive.vx, drive.vz) : 0;
      return `${v.toFixed(0)} ед/с · ${scene.view.x.toFixed(0)}, ${scene.view.z.toFixed(0)}`
        + (scene.view.inCombat ? ' · в бою' : '') + ` · тик ${(1 / TEST_TICK_DT) | 0} Гц`;
    },
  };
}
