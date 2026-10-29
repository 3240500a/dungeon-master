import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { isFarFace, toCameraXY } from '@dm/shared';
import { camDirXZ } from './playerInput.js';
import { cameraCfg, placeCamera } from './cameraRig.js';

/**
 * ⭐ 08.10: «ДАЛЬНЯЯ СТЕНА» СЕРВЕРА — ТА ЖЕ КАМЕРА, ЧТО У КЛИЕНТА.
 *
 * Статуи в нишах сервер ставит только на дальние от камеры стены (`shared/dungeon/dressing.ts`): грань дальняя, если смотрит лицом
 * к камере, `dot(n, toCameraXY(azimuthDeg)) > 0` в мире сервера (x — столбец, y — строка сетки). Своей камеры у сервера нет — знак
 * выведен из клиентской (`camDirXZ` + `placeCamera`; Unity `CameraRig.Dir`/`Place` — их порт). Перепутанный знак поставил бы ниши
 * на ближние стены — их тает фейд и они загораживают героя. Сторож: направление сервера = направление камеры клиента (мир z = сетка y),
 * а дальняя грань — дальше от настоящей камеры, чем противоположная.
 */
describe('⭐ 08.10: дальняя стена сервера = камера клиента', () => {
  it('toCameraXY (сервер) совпадает с camDirXZ (клиент) на любом азимуте', () => {
    for (const deg of [-45, 0, 30, 90, 135, -170, 180]) {
      const s = toCameraXY(deg), c = camDirXZ((deg * Math.PI) / 180);
      expect(s.x).toBeCloseTo(c.x, 12);
      expect(s.y).toBeCloseTo(c.z, 12);
    }
  });

  it('настоящая камера (placeCamera): дальняя грань комнаты дальше от неё, чем противоположная', () => {
    for (const deg of [-45, 20, 110, -150]) {
      const cfg = cameraCfg({ camera: { azimuthDeg: deg } });
      const cam = new THREE.PerspectiveCamera();
      const hero = new THREE.Vector3(500, 0, 300);
      placeCamera(cam, hero, cfg.startDist, cfg);
      const t = toCameraXY(deg);
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        if (!isFarFace(dx, dz, t)) continue;
        // Стена с гранью (dx, dz) стоит ПРОТИВ нормали от героя: точка на 5 клеток в сторону −n; противоположная — на +n.
        const wall = new THREE.Vector3(hero.x - dx * 160, 0, hero.z - dz * 160);
        const opp = new THREE.Vector3(hero.x + dx * 160, 0, hero.z + dz * 160);
        expect(cam.position.distanceTo(wall), `az ${deg}: грань (${dx},${dz})`).toBeGreaterThan(cam.position.distanceTo(opp));
      }
    }
  });
});
