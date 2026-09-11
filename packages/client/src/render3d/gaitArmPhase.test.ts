import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid } from './humanoid.js';

/**
 * ЗНАК ФАЗЫ: «рука вперёд» и «плечо вперёд» — это КАКИЕ числа.
 *
 * Этот вопрос всплывал четыре раза и каждый раз выводился заново из головы, потому что в риге он
 * неочевиден: плечо машет вокруг X, ключица — вокруг Y, риг зеркальный (Left на +X), а поверх лежит
 * авторская стойка с уже повёрнутой ключицей. Ошибиться в знаке здесь — значит получить пояс,
 * едущий против своей руки, и не понять, кто виноват.
 *
 * Поэтому соглашение ЗАМЕРЯЕТСЯ на живой кукле, а не утверждается: воспроизводим ровно то, что делают
 * `gaitArm` и `addEuler` в `poseRuntime`, и смотрим, куда уехала кисть по Z.
 */
const AUTHOR: [number, number, number] = [0.003, 0.247, -0.181];   // авторская ключица воина
const wX = new THREE.Vector3(1, 0, 0);

const handZ = (side: 'Left' | 'Right', sh: number, clavFwd: number): number => {
  const h = buildHumanoid({});
  h.reset();
  const sg = side === 'Left' ? 1 : -1;
  const cl = h.bones.get(side + 'Shoulder')!;
  cl.rotation.set(AUTHOR[0], AUTHOR[1], AUTHOR[2]);
  // Пояс кладётся АДДИТИВНО поверх авторской ключицы, и ось выноса — `-sg*fwd` вокруг Y (см. `o.shoLY`).
  cl.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -sg * clavFwd, 0)));
  // Точная копия `gaitArm`: рука ВНИЗ (Z, знак стороны) и мах вокруг X.
  const arm = h.bones.get(side + 'UpperArm')!;
  const qd = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -sg * 1.35));
  arm.quaternion.multiplyQuaternions(new THREE.Quaternion().setFromAxisAngle(wX, sh), qd);
  h.root.updateMatrixWorld(true);
  return h.bones.get(side + 'Hand')!.getWorldPosition(new THREE.Vector3()).z;
};

describe('соглашение о фазе маха', () => {
  it('РУКА идёт вперёд при ОТРИЦАТЕЛЬНОМ угле плеча — и слева, и справа', () => {
    for (const s of ['Left', 'Right'] as const) {
      expect(handZ(s, -0.5, 0), `${s}: sh<0 = вперёд`).toBeGreaterThan(handZ(s, 0, 0));
      expect(handZ(s, +0.5, 0), `${s}: sh>0 = назад`).toBeLessThan(handZ(s, 0, 0));
    }
  });

  it('ПОЯС идёт вперёд при ПОЛОЖИТЕЛЬНОМ `fwd` — даже поверх повёрнутой авторской ключицы', () => {
    for (const s of ['Left', 'Right'] as const) {
      expect(handZ(s, -0.22, +0.3), `${s}: fwd>0 = вперёд`).toBeGreaterThan(handZ(s, -0.22, -0.3));
    }
  });

  it('ИТОГ: в коде `fwd = shoSwing · (−dev)`, а `dev` — отклонение плеча. Значит рука вперёд (dev<0) → пояс вперёд', () => {
    // Проверяем саму связку на числах: рука ушла вперёд ⇒ dev < 0 ⇒ fwd > 0 ⇒ кисть ещё дальше вперёд.
    const dev = -0.4;                    // плечо ушло на 0.4 в минус = рука вперёд
    const fwd = 0.5 * -dev;              // shoSwing = 0.5
    expect(fwd).toBeGreaterThan(0);
    const base = handZ('Left', -0.22, 0);
    expect(handZ('Left', -0.22 + dev, fwd), 'пояс добавляет к выносу, а не отнимает').toBeGreaterThan(handZ('Left', -0.22 + dev, 0));
    expect(handZ('Left', -0.22 + dev, fwd)).toBeGreaterThan(base);
  });
});
