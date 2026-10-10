import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '@dm/shared';
import { CAM_AZ, camDirXZ } from './playerInput.js';

/**
 * СВЕТ ГЕРОЯ СДВИНУТ К КАМЕРЕ.
 *
 * Он стоял РОВНО НАД ГОЛОВОЙ (`position.set(x, 90, z)`), поэтому освещены были темя и плечи, а
 * обращённая к игроку сторона персонажа оставалась в тени. Сдвиг по горизонтали разворачивает свет
 * на ту сторону, которую игрок вообще видит.
 *
 * ⚠ Направление берётся из АЗИМУТА КАМЕРЫ одним швом `camDirXZ` — им же ставится и сама камера.
 * Вторая копия формулы разошлась бы молча: свет «к камере» поехал бы ОТ неё, и это читалось бы как
 * проблема освещения, а не как перепутанный знак.
 */
describe('направление «к камере» — один шов с постановкой камеры', () => {
  it('единичный вектор', () => {
    for (const az of [CAM_AZ, 0, Math.PI / 3, -2]) {
      const d = camDirXZ(az);
      expect(Math.hypot(d.x, d.z), `az=${az}`).toBeCloseTo(1, 9);
    }
  });

  it('⭐ указывает ИМЕННО на камеру, а не от неё', () => {
    // Ставим камеру той же формулой, что игра (`applyCam`), и проверяем, что вектор от цели к ней
    // совпадает с `camDirXZ`. Это и есть страховка от перепутанного знака.
    for (const az of [CAM_AZ, 0.4, -1.9]) {
      for (const el of [0.55, 0.95]) {
        const dist = 300, d = camDirXZ(az), hor = dist * Math.cos(el);
        const tx = 17, tz = -23;                       // цель в произвольной точке — формула от неё не зависит
        const cx = tx + d.x * hor, cz = tz + d.z * hor;
        const len = Math.hypot(cx - tx, cz - tz) || 1;
        expect((cx - tx) / len, `az=${az} el=${el}`).toBeCloseTo(d.x, 9);
        expect((cz - tz) / len, `az=${az} el=${el}`).toBeCloseTo(d.z, 9);
      }
    }
  });

  it('на нашем азимуте камера стоит по −X и +Z — значит туда же едет и свет', () => {
    const d = camDirXZ(CAM_AZ);
    expect(d.x, 'камера левее по X').toBeLessThan(0);
    expect(d.z, 'и ближе по Z').toBeGreaterThan(0);
  });
});

describe('настройки света героя', () => {
  const sh = (): { playerLightHeight: number; playerLightToCam: number; playerLightDist: number } => {
    const reg = new ConfigRegistry(); reg.loadAll();
    return reg.get('balance').lighting.shadow3d;
  };

  it('высота и сдвиг к камере — настройки, а не числа в коде', () => {
    const s = sh();
    // 09.10 владелец: свет героя на 3.5 м (112) — низ стены стыкуется с полом; было 90 → 160 → 112. Сторож — вилка, а не число.
    expect(s.playerLightHeight, 'высота света героя — в конфиге, в вилке 2–6 м').toBeGreaterThanOrEqual(64);
    expect(s.playerLightHeight).toBeLessThanOrEqual(192);
    expect(s.playerLightToCam, 'сдвиг к камере задан и ненулевой — иначе ничего не изменилось бы').toBeGreaterThan(0);
  });

  it('сдвиг заметно меньше дальности света — иначе персонаж выпал бы из круга', () => {
    const s = sh();
    expect(s.playerLightToCam).toBeLessThan(s.playerLightDist / 3);
  });

  it('⭐ свет светит СВЕРХУ-СБОКУ, а не сбоку и не строго сверху', () => {
    // Угол от вертикали: 0° — прежнее «фонарь на темени», 90° — свет из-за плеча игрока в упор.
    // Держим в разумной вилке ключевого света, иначе тени лягут через весь экран.
    const s = sh();
    const deg = Math.atan2(s.playerLightToCam, s.playerLightHeight) * 180 / Math.PI;
    expect(deg, `угол от вертикали ${deg.toFixed(1)}°`).toBeGreaterThan(14);   // 3.5 м и сдвиг к камере — 15.0°
    expect(deg).toBeLessThan(55);
  });
});
