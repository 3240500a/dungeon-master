/**
 * ⭐ ТРЯСКА КАМЕРЫ ПО МЕТКЕ `camshake` — «травма» с затуханием, как у Squirrel Eiserloh.
 *
 * Метка несёт СИЛУ отдельным числом (`Mark.num`), чтобы её можно было масштабировать от тяжести
 * удара: лёгкий тычок и обрушение двуручника — одна и та же метка с разным числом.
 *
 * ⚠ КОПИМ «ТРАВМУ», А НЕ СМЕЩЕНИЕ. Смещение считается как `травма²` — поэтому слабые тряски почти
 * не видны, а сильные читаются резко; складывать же сами смещения нельзя: два удара подряд дали бы
 * ровную дрожь вместо двух толчков. Потолок 1 не даёт цепочке ударов растрясти кадр до нечитаемости.
 *
 * ⚠ СМЕЩАЕМ КАМЕРУ, А НЕ ЦЕЛЬ. Тряска — свойство наблюдателя: сдвинешь точку взгляда — поедет вся
 * геометрия кадра вместе с прицелом, и по экрану станет невозможно целиться.
 */
import * as THREE from 'three';

export interface CamShake {
  /** Добавить толчок силой `power` (1 = обычный удар). */
  hit(power: number): void;
  /** Сдвинуть камеру на текущую тряску и проредить травму. Звать ПОСЛЕ `lookAt`. */
  apply(cam: THREE.Object3D, dt: number): void;
  /** Текущая травма 0…1 — для тестов и отладки. */
  readonly trauma: number;
}

/** Затухание травмы в секунду (полный спад ~0.8 с). */
const DECAY = 1.25;
/** Максимальное смещение камеры в единицах сцены при травме 1. */
const AMP = 14;

export function makeCamShake(amp = AMP): CamShake {
  let trauma = 0;
  // Свои фазы на ось — иначе камера ходила бы по прямой, а не дрожала.
  const px = Math.random() * 1000, py = Math.random() * 1000;
  let t = 0;
  const off = new THREE.Vector3();
  /** Дешёвый непрерывный «шум»: сумма двух несоизмеримых синусов — без библиотеки и без таблиц. */
  const wob = (phase: number, speed: number): number =>
    Math.sin((t + phase) * speed) * 0.6 + Math.sin((t + phase) * speed * 2.7) * 0.4;
  return {
    hit(power: number): void { trauma = Math.min(1, trauma + Math.max(0, power) * 0.35); },
    apply(cam: THREE.Object3D, dt: number): void {
      if (trauma <= 0) return;
      t += dt;
      const s = trauma * trauma * amp;
      off.set(wob(px, 34) * s, wob(py, 41) * s * 0.7, 0).applyQuaternion(cam.quaternion);   // сдвиг В ЭКРАННОЙ плоскости
      cam.position.add(off);
      trauma = Math.max(0, trauma - dt * DECAY);
    },
    get trauma(): number { return trauma; },
  };
}
