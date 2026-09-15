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
import { markSfx, shakeForMark, burstForMark } from './animSfx.js';   // звук меток — тот же, что в игре (правило «редактор ≡ игра»)
import { Vfx } from './vfx.js';
import { makeCamShake } from './camShake.js';
import { cameraCfg, placeCamera, applyLens, camZoom, CAMERA_FALLBACK, type CameraCfg } from './cameraRig.js';   // ⭐ одна камера на игру и вкладку
import { loadAssetConfig, resolvePlayerLook, editorClasses } from './modelSkin.js';
import type { RagdollHandle, PhysWorld } from './ragdoll.js';
import { createTestScene, TEST_TICK_DT, type TestScene } from './testScene.js';
import { driveActor, type DriveState } from './driveActor.js';
import { makeStageOwner } from './stageOwner.js';
import { moveFromKeys, facingFrom, aimOnGround, aimTmp } from './playerInput.js';
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
  /**
   * Вкладка ОТКРЫТА (кукла может ещё собираться). ⚠ Гейтить снаружи надо этим, а не `active`:
   * между «нажали Тест» и готовой куклой лежат физика + конфиг + GLB, и в этом окне `active`
   * ещё false — значит «уйти с вкладки» было некому, и сборка доезжала уже на чужой вкладке.
   */
  readonly wanted: boolean;
  /** Строка состояния для панели: где стоим, с какой скоростью. */
  status(): string;
  /** Пересобрать куклу (сменили персонажа или оружие). */
  rebuild(): void;
}

/** Камера теста — те же числа, что в игре: изометрия 45°, угол подъёма растёт с дистанцией. */
/**
 * ⭐ КАМЕРА ИЗ КОНФИГА, А НЕ ВТОРАЯ КОПИЯ ЧИСЕЛ. Здесь стояла ДОСЛОВНАЯ копия строки из `online3d.ts`
 * и вторая копия формулы постановки — числа совпадали, но расходятся такие копии молча. Сцены ещё
 * может не быть (конфиг грузится) — тогда прежние значения из `CAMERA_FALLBACK`.
 */
let camCfg: CameraCfg = CAMERA_FALLBACK;
const IDLE: PlayerInput = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };

/** Всё, что вкладка положила в сцену за одну сборку. ОДНИМ объектом — чтобы снималось тоже одним. */
interface Built { doll: RagdollHandle; room: THREE.LineSegments; scene: TestScene; drive: DriveState }

export function createTestTab(host: TestTabHost): TestTab {
  // ⚠ Текущая сборка — ОДНА ссылка, и её выставляет ТОЛЬКО победившая сборка (устаревшая до этой
  // строки не доходит: `alive()` проверяется после каждого await). Снятие идёт не отсюда, а через
  // владельца — см. `stageOwner.ts`, там же и разбор жалобы «появился ещё один меш».
  let cur: Built | null = null;
  let dist = 300;
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
    if (!cur || typing()) return;
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  };
  const onUp = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const onMove = (e: PointerEvent): void => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.set = true; };
  const onBtnDown = (e: PointerEvent): void => { if (cur && e.button === 0) lmb = true; };
  const onBtnUp = (e: PointerEvent): void => { if (e.button === 0) lmb = false; };
  const onWheel = (e: WheelEvent): void => {
    if (!cur) return;
    e.preventDefault();
    dist = camZoom(dist, e.deltaY, camCfg);
  };

  const camShake = makeCamShake();
  const vfx = new Vfx(host.scene);   // эффекты меток: во вкладке те же, что в игре
  const applyCam = (x: number, z: number, dt = 0): void => {
    target.set(x, 30, z);
    applyLens(host.camera, camCfg);
    placeCamera(host.camera, target, dist, camCfg);   // ⭐ ТА ЖЕ функция, что в игре
    camShake.apply(host.camera, dt);
  };

  /** Рамка комнаты: без неё непонятно, где кончается пол и почему персонаж встал. */
  const makeRoom = (w: number, h: number): THREE.LineSegments => {
    const g = new THREE.BufferGeometry();
    const x0 = 0, z0 = 0, x1 = w, z1 = h, y = 1;
    const p = [x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0];
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a6480 }));
  };

  const stage = makeStageOwner<Built>({
    // Захват общих ресурсов редактора: клавиатура/мышь уходят в игру, орбита выключается.
    on: () => {
      addEventListener('keydown', onDown);
      addEventListener('keyup', onUp);
      host.canvas.addEventListener('pointermove', onMove);
      host.canvas.addEventListener('pointerdown', onBtnDown);
      addEventListener('pointerup', onBtnUp);
      host.canvas.addEventListener('wheel', onWheel, { passive: false });
      host.setOrbit(false);
    },
    // ⚠ Зовётся И тогда, когда собраться не успели: иначе уход во время загрузки оставлял бы
    // редактор без орбиты, а стрелки продолжали бы ехать «в тест».
    off: () => {
      removeEventListener('keydown', onDown);
      removeEventListener('keyup', onUp);
      host.canvas.removeEventListener('pointermove', onMove);
      host.canvas.removeEventListener('pointerdown', onBtnDown);
      removeEventListener('pointerup', onBtnUp);
      host.canvas.removeEventListener('wheel', onWheel);
      keys.clear(); lmb = false;
      host.setOrbit(true);
    },

    async build(alive) {
      const pw = await host.physics();
      if (!pw || !alive()) return null;   // ушли с вкладки, пока грузилась физика — куклу не плодим
      const classId = host.charId();
      // Тот же разбор, что в игре. Источник свой — локальная рабочая копия конфига: редактор обязан
      // показывать то, что правят ПРЯМО СЕЙЧАС, а не последнее опубликованное.
      const look = resolvePlayerLook(await loadAssetConfig(), editorClasses(), classId);
      if (!alive()) return null;          // ушли с вкладки, пока грузился конфиг
      const sc = createTestScene(classId);
      camCfg = cameraCfg(sc.balance);   // ⭐ камера — из ТОГО ЖЕ конфига, на котором крутится сцена
      dist = Math.min(camCfg.maxDist, Math.max(camCfg.minDist, dist));
      const doll = makeGamePlayerDoll(pw, { x: sc.view.x, z: sc.view.z, weapon: host.weapon(), classId, ...look });
      {   // ⭐ разметку взмаха/удара СЛЫШНО и ТРЯСКУ ВИДНО прямо в редакторе — как в игре
        const sfx = markSfx(1);
        doll.onMark = (e) => {
          sfx(e);
          const p = shakeForMark(e); if (p > 0) camShake.hit(p);
          const b = burstForMark(e); if (b) vfx.burst(sc.view.x, sc.view.z, b.color, b.n, b.speed, b.life);
        };
      }
      host.scene.add(doll.group);
      const room = makeRoom(sc.bounds.w, sc.bounds.h);
      host.scene.add(room);
      const built: Built = { doll, room, scene: sc, drive: { d: doll, vx: 0, vz: 0, lx: sc.view.x, lz: sc.view.z } };
      cur = built;
      dist = 300;
      applyCam(sc.view.x, sc.view.z);
      return built;
    },

    drop(b) {
      if (cur === b) cur = null;          // чужую (актуальную) сборку не обнуляем — см. `cur` выше
      host.scene.remove(b.doll.group); b.doll.dispose();
      host.scene.remove(b.room); b.room.geometry.dispose(); (b.room.material as THREE.Material).dispose();
    },
  });

  return {
    get active() { return stage.active; },
    get wanted() { return stage.wanted; },

    start(): Promise<void> { return stage.start(); },
    stop(): void { stage.stop(); },
    rebuild(): void { void stage.rebuild(); },

    frame(dt: number): void {
      const c = cur; if (!c) return;
      const { scene, drive } = c;
      const mv = moveFromKeys(keys, camCfg.azimuth);   // ⚠ WASD ЗАВЯЗАН НА АЗИМУТ: крутим камеру — едет и «вперёд»
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

      vfx.update(dt);
      c.doll.setAttackHold?.(lmb);        // зажатая ЛКМ держит цепочку внутри окна комбо — ровно как в игре
      for (const e of scene.step(dt, input)) {
        // Удар отыгрывает КУКЛА по серверному событию — с тем же окном и вайндапом, что в игре.
        if (e.type === 'swing') c.doll.attack(undefined, e.lockMs / 1000, e.windupMs / 1000);
      }
      driveActor(drive, scene.view.x, scene.view.z, scene.view.facing, scene.view.alive, dt,
        { combat: scene.view.inCombat, stun: scene.view.stun });
      applyCam(scene.view.x, scene.view.z, dt);
    },

    status(): string {
      const c = cur;
      if (!c) return stage.wanted ? 'собираем куклу…' : 'вкладка не активна';
      const { scene, drive } = c;
      const v = Math.hypot(drive.vx, drive.vz);
      return `${v.toFixed(0)} ед/с · ${scene.view.x.toFixed(0)}, ${scene.view.z.toFixed(0)}`
        + (scene.view.inCombat ? ' · в бою' : '') + ` · тик ${(1 / TEST_TICK_DT) | 0} Гц`;
    },
  };
}
