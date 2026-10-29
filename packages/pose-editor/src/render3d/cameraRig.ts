/**
 * ⭐⭐ КАМЕРА — ОДИН ИСТОЧНИК НА ИГРУ И НА ВКЛАДКУ «ТЕСТ».
 *
 * Было так: одна и та же строка `{ minDist: 160, maxDist: 480, elNear: 0.55, elFar: 0.95 }` жила
 * ДВУМЯ независимыми копиями — в `online3d.ts` и в `testTab.ts`, — и формула постановки камеры тоже
 * была написана дважды. Числа совпадали, но это ровно та форма, которая уже кусала: «Тест» и игра
 * считают одно и то же по своим копиям и тихо расходятся, как только кто-то правит одну.
 *
 * Теперь числа живут в конфиге (`balance.camera`, страница «Бой и физика» конфиг-редактора), а
 * формула — здесь. Правка в редакторе видна и в игре, и во вкладке, без пересборки.
 *
 * ⚠ УГЛЫ В КОНФИГЕ — В ГРАДУСАХ. Дизайнер правит наклон камеры, а не радианы; перевод здесь.
 *
 * ⚠ АЗИМУТ СВЯЗАН С УПРАВЛЕНИЕМ. От него зависит направление WASD (`moveFromKeys`) и то, куда
 * смещён свет героя (`camDirXZ`). Крутить его можно, но проверять — вместе с ходьбой, иначе «вперёд»
 * перестанет быть вверх экрана.
 */
import * as THREE from 'three';
import { CAM_AZ, camDirXZ } from './playerInput.js';   // ⚠ азимут и направление «к камере» — ОДНА копия на проект (от них зависит WASD)

export interface CameraCfg {
  /** Ближний и дальний предел зума (единицы). */
  minDist: number; maxDist: number;
  /** С чего начинаем. */
  startDist: number;
  /** Наклон (радианы) на ближнем и дальнем зуме: близко камера ниже, далеко — почти топ-даун. */
  elNear: number; elFar: number;
  /** Азимут (радианы): горизонтальное направление от игрока к камере. */
  azimuth: number;
  /** Угол обзора (градусы) и дальность отсечения. */
  fovDeg: number; farClip: number;
  /** Множитель зума за щелчок колеса (>1). Приближение — обратная величина. */
  zoomStep: number;
}

const D2R = Math.PI / 180;

/**
 * Прежние числа клиента — фолбэк, когда конфига нет (тесты, вкладка до загрузки сцены).
 * ⚠ Наклоны здесь в РАДИАНАХ и равны историческим 0.55 / 0.95 бит в бит.
 */
export const CAMERA_FALLBACK: CameraCfg = {
  minDist: 160, maxDist: 480, startDist: 460,
  elNear: 0.55, elFar: 0.95, azimuth: CAM_AZ,
  fovDeg: 52, farClip: 2600, zoomStep: 1.1,
};

/** Секция `balance.camera` как её пишет конфиг (градусы). */
interface CameraSection {
  minDist?: number; maxDist?: number; startDist?: number;
  elNearDeg?: number; elFarDeg?: number; azimuthDeg?: number;
  fovDeg?: number; farClip?: number; zoomStep?: number;
}

/**
 * Разобрать конфиг в рабочие числа. Нет секции или поля — берём прежнее значение, поэтому старый
 * конфиг ведёт себя как раньше.
 *
 * ⚠ `maxDist` не может быть меньше `minDist`: перевёрнутый диапазон дал бы деление на отрицательное
 * в расчёте наклона и камеру вверх ногами. Чиним молча — это не выбор автора, а описка.
 */
export function cameraCfg(balance: unknown): CameraCfg {
  const c = ((balance as { camera?: CameraSection } | null | undefined)?.camera ?? {}) as CameraSection;
  const f = CAMERA_FALLBACK;
  const minDist = c.minDist ?? f.minDist;
  return {
    minDist,
    maxDist: Math.max(minDist + 1, c.maxDist ?? f.maxDist),
    startDist: c.startDist ?? f.startDist,
    elNear: c.elNearDeg === undefined ? f.elNear : c.elNearDeg * D2R,
    elFar: c.elFarDeg === undefined ? f.elFar : c.elFarDeg * D2R,
    azimuth: c.azimuthDeg === undefined ? f.azimuth : c.azimuthDeg * D2R,
    fovDeg: c.fovDeg ?? f.fovDeg,
    farClip: c.farClip ?? f.farClip,
    zoomStep: Math.max(1.001, c.zoomStep ?? f.zoomStep),
  };
}

/** Наклон камеры на этой дистанции: близко — ниже, далеко — топ-даун. */
export function camElevation(dist: number, c: CameraCfg): number {
  const zt = Math.min(1, Math.max(0, (dist - c.minDist) / (c.maxDist - c.minDist)));
  return c.elNear + (c.elFar - c.elNear) * zt;
}

/**
 * Горизонтальное направление ОТ цели К КАМЕРЕ. Своей формулы здесь НЕТ намеренно: ею пользуется ещё
 * и свет героя, и две копии разошлись бы молча — свет «к камере» поехал бы ОТ неё.
 */
export const camDir = (c: CameraCfg): { x: number; z: number } => camDirXZ(c.azimuth);

/**
 * Поставить камеру на цель с этой дистанции — ОДНА формула на игру и вкладку «Тест».
 * Смотрит ровно в цель; тряску (`camShake`) вызывающий накладывает ПОСЛЕ.
 */
export function placeCamera(cam: THREE.Camera, target: THREE.Vector3, dist: number, c: CameraCfg): void {
  const el = camElevation(dist, c);
  const dir = camDir(c), hor = dist * Math.cos(el);
  cam.position.set(target.x + dir.x * hor, target.y + dist * Math.sin(el), target.z + dir.z * hor);
  cam.lookAt(target);
}

/**
 * Применить угол обзора и дальность отсечения, если они поменялись.
 * ⚠ ТОЛЬКО ПРИ ИЗМЕНЕНИИ: `updateProjectionMatrix` каждый кадр — лишняя работа на ровном месте.
 */
export function applyLens(cam: THREE.PerspectiveCamera, c: CameraCfg): void {
  if (cam.fov === c.fovDeg && cam.far === c.farClip) return;
  cam.fov = c.fovDeg; cam.far = c.farClip; cam.updateProjectionMatrix();
}

/**
 * Новая дистанция после щелчка колеса.
 *
 * ⚠ СИММЕТРИЧНО: приближение — деление на тот же множитель, каким отдаляем. Раньше стояли ×0.9 и
 * ×1.1 — щелчок туда и обратно не возвращал камеру на место (0.9 × 1.1 = 0.99, и так каждый раз).
 */
export function camZoom(dist: number, deltaY: number, c: CameraCfg): number {
  const d = deltaY < 0 ? dist / c.zoomStep : dist * c.zoomStep;
  return Math.min(c.maxDist, Math.max(c.minDist, d));
}
