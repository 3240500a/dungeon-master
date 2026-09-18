import * as THREE from 'three';
/**
 * ВВОД ИГРОКА → `PlayerInput`. Две функции, которые обязаны быть в одном экземпляре.
 *
 * Вынесены из `online3d.ts` ради вкладки «Тест» в поз-редакторе. Соблазн написать там «такой же»
 * WASD велик, а цена ошибки незаметная и дорогая: экран повёрнут на 45°, и если знак поворота не
 * совпадёт, персонаж в тесте будет ходить по диагонали относительно игры. Настройщик увидит другую
 * походку и пойдёт чинить походку — то есть будет править исправное.
 *
 * Сервер по-прежнему единственный, кто двигает персонажа: отсюда уходит только НАМЕРЕНИЕ.
 */

/** Азимут камеры (изометрия 45°). Единственная копия числа, от которого зависит направление WASD. */
export const CAM_AZ = -Math.PI / 4;

/**
 * Горизонтальный единичный вектор ОТ точки взгляда К КАМЕРЕ.
 *
 * Ровно та пара `(sin az, cos az)`, которой камера и ставится: `pos = target + dist·cos(el)·(sin az,
 * …, cos az)`. Вынесено отдельной функцией, потому что этим направлением пользуется не только камера
 * (свет героя сдвигается вдоль него), а две копии одной формулы расходятся молча: свет «к камере»
 * поехал бы ОТ неё, и это выглядело бы как проблема освещения, а не как перепутанный знак.
 */
export function camDirXZ(camAz = CAM_AZ): { x: number; z: number } {
  return { x: Math.sin(camAz), z: Math.cos(camAz) };
}

/**
 * WASD → мировой вектор намерения.
 *
 * Экран повёрнут на `camAz`, поэтому клавиши крутим на −`camAz`: W ровно «вверх по экрану», A/D
 * строго вбок при любом угле камеры. Не нормализуем — сервер нормализует сам (диагональ не быстрее).
 */
export function moveFromKeys(keys: ReadonlySet<string>, camAz = CAM_AZ): { x: number; y: number } {
  let kx = 0, ky = 0;
  if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) kx -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) ky += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) ky -= 1;
  const ca = Math.cos(-camAz), sa = Math.sin(-camAz);
  return { x: kx * ca - ky * sa, y: kx * sa + ky * ca };
}

/** Мёртвая зона курсора (ед. мира): ближе — власть курсора ГАСНЕТ (см. `facingFrom`), иначе прицел дрожит. */
export const AIM_DEAD = 10;

/**
 * Куда смотреть. Приоритет: курсор (за мёртвой зоной — РОВНО пеленг на него) → направление хода (если мышь
 * ещё не трогали) → прежний угол. Последнее важно: без него персонаж на остановке доворачивался бы в ноль.
 *
 * ⭐⭐ МЯГКАЯ МЁРТВАЯ ЗОНА. Было: ближе `dead` держится ПРЕЖНИЙ угол, жёстко. Пробегая мимо курсора, игрок
 * входит в зону с одним пеленгом, а выходит с уже развернувшимся — и разворот отдаётся ОДНИМ КАДРОМ.
 * ЗАМЕР (стенд `torsoJitter.test.ts`, проход в 4 ед от курсора на 80 ед/с): верх груди 2666 / 5068 / 5922 °/с
 * при 60 / 120 / 144 — РОВНО ЛИНЕЙНО по частоте кадров, подпись скачка за один кадр (~55° разом).
 * Тот же проход БЕЗ зоны вовсе — 683 / 740 / 749 °/с, без роста.
 *
 * Стало: власть курсора гаснет ЛИНЕЙНО к центру зоны. К вектору на курсор подмешивается прежнее направление
 * длиной `dead − r`: на радиусе зоны примесь нулевая (снаружи всё бит в бит как было), в самом центре курсора
 * не слышно вовсе (тот самый смысл «не крутиться, когда курсор на тебе»), между — непрерывно.
 * Ни скачка на границе, ни «мёртвого» участка, где прицел не слушается.
 */
export function facingFrom(
  prev: number,
  aim: { x: number; y: number } | null,
  px: number, pz: number,
  mv: { x: number; y: number },
  mouseSet: boolean,
  dead = AIM_DEAD,
): number {
  if (aim) {
    const dx = aim.x - px, dz = aim.y - pz, r = Math.hypot(dx, dz);
    if (r > dead) return Math.atan2(dz, dx);
    // Примесь прежнего направления. `r === 0` — курсор ровно на персонаже: вектор чисто прежний, угол прежний.
    if (dead > 0 && r > 0) {
      const k = dead - r;
      return Math.atan2(dz + Math.sin(prev) * k, dx + Math.cos(prev) * k);
    }
  }
  if (!mouseSet && (mv.x || mv.y)) return Math.atan2(mv.y, mv.x);
  return prev;
}

/**
 * Точка прицела на полу (y = 0) из положения курсора. Общая, потому что «почти такой же» рейкаст в
 * другом месте даёт другой прицел при другом FOV — и персонаж в тесте целится не туда, что читается
 * как ошибка доворота корпуса, хотя корпус ни при чём.
 *
 * Временные объекты передаются снаружи: функция зовётся каждый кадр и не имеет права мусорить.
 */
export function aimOnGround(
  tmp: { ray: THREE.Raycaster; ndc: THREE.Vector2; ground: THREE.Plane; hit: THREE.Vector3 },
  camera: THREE.Camera,
  rect: { left: number; top: number; width: number; height: number },
  mx: number, my: number,
): { x: number; y: number } | null {
  tmp.ndc.set(((mx - rect.left) / rect.width) * 2 - 1, -((my - rect.top) / rect.height) * 2 + 1);
  tmp.ray.setFromCamera(tmp.ndc, camera);
  return tmp.ray.ray.intersectPlane(tmp.ground, tmp.hit) ? { x: tmp.hit.x, y: tmp.hit.z } : null;
}

/** Готовый набор временных объектов для `aimOnGround` — один на потребителя. */
export function aimTmp(): { ray: THREE.Raycaster; ndc: THREE.Vector2; ground: THREE.Plane; hit: THREE.Vector3 } {
  return { ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), ground: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit: new THREE.Vector3() };
}
