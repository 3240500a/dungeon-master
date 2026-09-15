import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cameraCfg, camElevation, camDir, placeCamera, applyLens, camZoom, CAMERA_FALLBACK } from './cameraRig.js';
import { CAM_AZ } from './playerInput.js';

/**
 * ⭐⭐ КАМЕРА — ОДИН ИСТОЧНИК НА ИГРУ И НА ВКЛАДКУ «ТЕСТ».
 *
 * Вопрос автора был простой: «настройки камеры есть где-то в конфиг-эдиторе?». Не было: числа жили
 * ДВУМЯ дословными копиями в коде (`online3d.ts` и `testTab.ts`), и формула постановки — тоже дважды.
 * Совпадали они только потому, что их никто не трогал.
 *
 * Теперь числа в `balance.camera`, формула в `cameraRig`. Сторожа ниже держат два обещания: старый
 * конфиг ведёт себя бит в бит как раньше, и вторая копия чисел не заводится снова.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f: string): string => readFileSync(join(HERE, f), 'utf8');

describe('камера из конфига', () => {
  it('⭐⭐ ПУСТОЙ КОНФИГ — ПРЕЖНИЕ ЧИСЛА БИТ В БИТ', () => {
    // Гарантия «ничего не поехало»: у кого секции нет, у того камера как была.
    expect(cameraCfg(undefined)).toEqual(CAMERA_FALLBACK);
    expect(cameraCfg({})).toEqual(CAMERA_FALLBACK);
    expect(cameraCfg({ camera: {} })).toEqual(CAMERA_FALLBACK);
  });

  it('⭐ УГЛЫ ИЗ КОНФИГА — В ГРАДУСАХ', () => {
    // ⚠ Мутация «принимать радианы как есть» валит это: 90 превратилось бы в 90 радиан.
    const c = cameraCfg({ camera: { elNearDeg: 30, elFarDeg: 60, azimuthDeg: -45 } });
    expect(c.elNear).toBeCloseTo(Math.PI / 6, 9);
    expect(c.elFar).toBeCloseTo(Math.PI / 3, 9);
    expect(c.azimuth).toBeCloseTo(-Math.PI / 4, 9);
  });

  it('⚠ ПЕРЕВЁРНУТЫЙ ДИАПАЗОН ЗУМА ЧИНИТСЯ — это описка, а не выбор автора', () => {
    // Иначе деление на отрицательное в расчёте наклона перевернуло бы камеру.
    const c = cameraCfg({ camera: { minDist: 400, maxDist: 100 } });
    expect(c.maxDist).toBeGreaterThan(c.minDist);
  });

  it('⭐ НАКЛОН: близко — ниже, далеко — топ-даун, за пределами — кламп', () => {
    const c = cameraCfg({ camera: { minDist: 100, maxDist: 500, elNearDeg: 30, elFarDeg: 60 } });
    expect(camElevation(100, c)).toBeCloseTo(c.elNear, 9);
    expect(camElevation(500, c)).toBeCloseTo(c.elFar, 9);
    expect(camElevation(300, c)).toBeCloseTo((c.elNear + c.elFar) / 2, 9);
    expect(camElevation(0, c), '⚠ ближе предела — не круче ближнего наклона').toBeCloseTo(c.elNear, 9);
    expect(camElevation(9999, c), '⚠ дальше предела — не круче дальнего').toBeCloseTo(c.elFar, 9);
  });

  it('⭐⭐ ПОСТАНОВКА КАМЕРЫ: расстояние до цели РОВНО заданное, и смотрит в цель', () => {
    const c = cameraCfg({ camera: {} });
    const cam = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3(120, 20, -70);
    for (const dist of [160, 300, 480]) {
      placeCamera(cam, target, dist, c);
      expect(cam.position.distanceTo(target), `⚠ дистанция не ${dist}`).toBeCloseTo(dist, 6);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const toTarget = target.clone().sub(cam.position).normalize();
      expect(fwd.dot(toTarget), '⚠ камера смотрит не в цель').toBeCloseTo(1, 6);
    }
  });

  it('⚠ НАПРАВЛЕНИЕ «К КАМЕРЕ» — ТА ЖЕ ФУНКЦИЯ, ЧТО У СВЕТА ГЕРОЯ', () => {
    // Две копии этой формулы уже ловили: свет «к камере» поехал бы ОТ неё, и это читалось бы как
    // проблема освещения, а не как перепутанный знак.
    const c = cameraCfg({ camera: { azimuthDeg: -45 } });
    const d = camDir(c);
    expect(Math.hypot(d.x, d.z), 'вектор единичный').toBeCloseTo(1, 9);
    expect(d.x).toBeCloseTo(Math.sin(CAM_AZ), 9);
    expect(d.z).toBeCloseTo(Math.cos(CAM_AZ), 9);
  });

  it('⭐ ЗУМ СИММЕТРИЧЕН: щёлкнул туда и обратно — вернулся на место', () => {
    // ⚠ Раньше стояли ×0.9 и ×1.1: 0.9 × 1.1 = 0.99, и камера ползла ближе на каждой паре щелчков.
    const c = cameraCfg({ camera: {} });
    const d0 = 300;
    expect(camZoom(camZoom(d0, -1, c), +1, c), '⚠ зум несимметричен').toBeCloseTo(d0, 9);
  });

  it('⚠ зум зажат пределами', () => {
    const c = cameraCfg({ camera: { minDist: 100, maxDist: 500 } });
    let d = 300; for (let i = 0; i < 50; i++) d = camZoom(d, -1, c);
    expect(d).toBe(100);
    for (let i = 0; i < 50; i++) d = camZoom(d, +1, c);
    expect(d).toBe(500);
  });

  it('⭐ ЛИНЗА ПРИМЕНЯЕТСЯ И НЕ ПЕРЕСЧИТЫВАЕТ МАТРИЦУ ЗРЯ', () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 1, 1000);
    let calls = 0;
    const orig = cam.updateProjectionMatrix.bind(cam);
    cam.updateProjectionMatrix = (): void => { calls++; orig(); };
    const c = cameraCfg({ camera: { fovDeg: 52, farClip: 2600 } });
    applyLens(cam, c);
    expect(cam.fov).toBe(52); expect(cam.far).toBe(2600); expect(calls).toBe(1);
    applyLens(cam, c);
    expect(calls, '⚠ матрица проекции пересчитывается каждый кадр').toBe(1);
  });

  it('⭐⭐ ВТОРОЙ КОПИИ ЧИСЕЛ КАМЕРЫ НЕТ — ни в игре, ни во вкладке «Тест»', () => {
    // Ровно та форма, с которой всё началось: дословно одинаковая строка в двух файлах.
    for (const f of ['online3d.ts', 'testTab.ts']) {
      const s = src(f);
      expect(/elNear\s*:/.test(s), `⚠ ${f}: завёлся свой наклон камеры`).toBe(false);
      expect(/minDist\s*:/.test(s), `⚠ ${f}: завёлся свой предел зума`).toBe(false);
      expect(/deltaY\s*<\s*0\s*\?\s*0?\.\d/.test(s), `⚠ ${f}: завёлся свой шаг зума`).toBe(false);
    }
  });
});
