import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';
import { applyLegAdduct } from './poseRuntime.js';

/** Архитектура ретаргета: процедурный скелет строится по ТОЧНЫМ офсетам источника — posDrive конформит меш 1:1 без искажения
 *  суставов. Модели ОБЯЗАНЫ биндиться в T-позе (руки горизонт = поза покоя клипов); A-позный бинд рук корёжит ретаргет (46°
 *  доворота от бинда скин не тянет) → компенсации РУК в рантайме НЕТ. Лёгкий развал НОГ добираем legAdduct (маленький, ~10°). */
describe('leg-adduct compensation (T-pose bind contract)', () => {
  const dir = (h: ReturnType<typeof buildHumanoid>, a: string, b: string): THREE.Vector3 =>
    h.bones.get(b)!.getWorldPosition(new THREE.Vector3()).sub(h.bones.get(a)!.getWorldPosition(new THREE.Vector3())).normalize();

  it('legAdduct извлекается из splay бинда и сводит ногу вертикально (−Y)', () => {
    const bo: Record<string, [number, number, number]> = {
      LeftLowerLeg: [1.8, -14, 0.3], RightLowerLeg: [-1.8, -14, 0.3], LeftFoot: [0.9, -13, 0.5], RightFoot: [-0.9, -13, 0.5],
    };
    const h = buildHumanoid({ boneOffsets: bo });
    expect(h.legAdduct).toBeGreaterThan(0.05);   // splay извлечён (~7°)
    applyLegAdduct(h);
    h.root.updateMatrixWorld(true);
    const lLeg = dir(h, 'LeftUpperLeg', 'LeftLowerLeg');
    expect(lLeg.y).toBeLessThan(-0.98); expect(Math.abs(lLeg.x)).toBeLessThan(0.03);
  });

  it('T-позные офсеты ног (прямо вниз) → legAdduct ≈ 0 (no-op)', () => {
    const h = buildHumanoid({ boneOffsets: { LeftLowerLeg: [0, -15, 0], LeftFoot: [0, -14, 0] } });
    expect(Math.abs(h.legAdduct)).toBeLessThan(1e-3);
  });

  it('интерфейс Humanoid не несёт полей armAdduct (компенсация рук снята)', () => {
    const h = buildHumanoid({});
    expect('armAdduct' in h).toBe(false);
    expect('legAdduct' in h).toBe(true);
  });
});
