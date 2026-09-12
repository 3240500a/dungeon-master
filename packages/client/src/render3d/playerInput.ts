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

/** Мёртвая зона курсора (ед. мира): ближе — прицел не перебивает прежний фейсинг, иначе дрожит. */
export const AIM_DEAD = 10;

/**
 * Куда смотреть. Приоритет: курсор (если он дальше мёртвой зоны) → направление хода (если мышь ещё не
 * трогали) → прежний угол. Последнее важно: без него персонаж на остановке доворачивался бы в ноль.
 */
export function facingFrom(
  prev: number,
  aim: { x: number; y: number } | null,
  px: number, pz: number,
  mv: { x: number; y: number },
  mouseSet: boolean,
  dead = AIM_DEAD,
): number {
  if (aim && Math.hypot(aim.x - px, aim.y - pz) > dead) return Math.atan2(aim.y - pz, aim.x - px);
  if (!mouseSet && (mv.x || mv.y)) return Math.atan2(mv.y, mv.x);
  return prev;
}
