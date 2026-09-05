import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { makeFullBodyIk } from './fullBodyIk.js';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const wpos = (h: Humanoid, b: string): THREE.Vector3 => { h.root.updateMatrixWorld(true); return h.bones.get(b)!.getWorldPosition(new THREE.Vector3()); };

describe('fullBodyIk — базовое достижение цели', () => {
  it('кисть дотягивается до достижимой точки', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const target = wpos(h, 'LeftHand').clone().add(V(-6, -8, 6));
    const err = rig.solve(new Map([['LeftHand', target]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    expect(err).toBeLessThan(0.6);
    expect(wpos(h, 'LeftHand').distanceTo(target)).toBeLessThan(0.6);
  });

  it('недостижимая цель — рука вытягивается в её сторону, а не ломается', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const shoulder = wpos(h, 'LeftUpperArm');
    const target = shoulder.clone().add(V(300, 0, 0));
    rig.solve(new Map([['LeftHand', target]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    const hand = wpos(h, 'LeftHand');
    const dir = hand.clone().sub(shoulder).normalize();
    expect(dir.x).toBeGreaterThan(0.85);                      // тянется в сторону цели
    expect(hand.distanceTo(shoulder)).toBeLessThan(40);       // но не растянулась (длины сохранены)
  });

  it('длины костей сохраняются (скелет не растягивается)', () => {
    const h = buildHumanoid({});
    const before = ['LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot']
      .map((b) => wpos(h, b).distanceTo(wpos(h, h.bones.get(b)!.parent!.name)));
    const rig = makeFullBodyIk(h);
    rig.solve(new Map([['LeftHand', wpos(h, 'LeftHand').add(V(-10, -14, 8))]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    const after = ['LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot']
      .map((b) => wpos(h, b).distanceTo(wpos(h, h.bones.get(b)!.parent!.name)));
    for (let i = 0; i < before.length; i++) expect(after[i]!).toBeCloseTo(before[i]!, 3);
  });
});

describe('fullBodyIk — ПИНЫ (главное требование Ф4)', () => {
  /** Шарнир колена: сгиб вокруг X (вперёд). Пределы играют роль полюса — см. комментарий в fullBodyIk. */
  const kneeHinge = (bone: string): unknown => (/LowerLeg$/.test(bone)
    ? { kind: 'hinge', group: 'leg', canon: 'knee', axis: [1, 0, 0], hingeNormal: [0, -1, 0], min: -0.05, max: 2.2 }
    : null);

  it('приколотые стопы стоят, когда таз тянут вниз (присед)', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h, { limits: kneeHinge as never });
    const lf = wpos(h, 'LeftFoot').clone(), rf = wpos(h, 'RightFoot').clone();
    const hips = wpos(h, 'Hips').clone();

    rig.solve(new Map([['LeftFoot', lf], ['RightFoot', rf]]), { bone: 'Hips', pos: hips.clone().add(V(0, -9, 0)) });

    expect(wpos(h, 'LeftFoot').distanceTo(lf), 'левая стопа уехала').toBeLessThan(0.6);
    expect(wpos(h, 'RightFoot').distanceTo(rf), 'правая стопа уехала').toBeLessThan(0.6);
    expect(wpos(h, 'Hips').y).toBeLessThan(hips.y - 6);            // таз реально опустился
    // колено согнулось В АНАТОМИЧЕСКОЙ ПЛОСКОСТИ (вперёд), а не вбок — это заслуга предела-шарнира
    const knee = wpos(h, 'LeftLowerLeg'), ankle = wpos(h, 'LeftFoot');
    expect(knee.z).toBeGreaterThan(ankle.z + 0.5);
  });

  it('приколотые стопы стоят, когда таз тянут ВБОК (в пределах досягаемости)', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h, { limits: kneeHinge as never });
    const lf = wpos(h, 'LeftFoot').clone(), rf = wpos(h, 'RightFoot').clone();
    const hips = wpos(h, 'Hips').clone();
    rig.solve(new Map([['LeftFoot', lf], ['RightFoot', rf]]), { bone: 'Hips', pos: hips.clone().add(V(3, -4, 2)) });
    expect(wpos(h, 'LeftFoot').distanceTo(lf)).toBeLessThan(0.8);
    expect(wpos(h, 'RightFoot').distanceTo(rf)).toBeLessThan(0.8);
  });

  it('если пин физически НЕ достижим — решение вырождается плавно, а не взрывается', () => {
    // Таз уводим вбок так, что дальняя нога короче требуемого: остаточный промах ОБЯЗАН быть,
    // но ограниченным (нога тянется в сторону пина, а не выворачивается и не растягивается).
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h, { limits: kneeHinge as never });
    const lf = wpos(h, 'LeftFoot').clone(), rf = wpos(h, 'RightFoot').clone();
    const hips = wpos(h, 'Hips').clone();
    const boneLen = (b: string): number => wpos(h, b).distanceTo(wpos(h, h.bones.get(b)!.parent!.name));
    const before = ['LeftLowerLeg', 'LeftFoot', 'RightLowerLeg', 'RightFoot'].map(boneLen);
    rig.solve(new Map([['LeftFoot', lf], ['RightFoot', rf]]), { bone: 'Hips', pos: hips.clone().add(V(9, -2, 3)) });
    const err = Math.max(wpos(h, 'LeftFoot').distanceTo(lf), wpos(h, 'RightFoot').distanceTo(rf));
    expect(err).toBeGreaterThan(0.5);                     // недостижимо — промах есть
    expect(err).toBeLessThan(6);                          // но ограниченный, без взрыва
    // ДЛИНЫ КОСТЕЙ не изменились — скелет не растянули, чтобы «дотянуться»
    const after = ['LeftLowerLeg', 'LeftFoot', 'RightLowerLeg', 'RightFoot'].map(boneLen);
    for (let i = 0; i < before.length; i++) expect(after[i]!).toBeCloseTo(before[i]!, 3);
  });

  it('БЕЗ пинов та же тяга таза утаскивает стопы за собой (то, на что и жаловались)', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const lf = wpos(h, 'LeftFoot').clone();
    const hips = wpos(h, 'Hips').clone();
    // цель только на кисть — стопы не закреплены; таз двигаем «руками», как это делал moveHips
    h.hips.position.add(V(0, -9, 0));
    rig.solve(new Map([['LeftHand', wpos(h, 'LeftHand')]]), { bone: 'Hips', pos: hips.clone().add(V(0, -9, 0)) });
    expect(wpos(h, 'LeftFoot').distanceTo(lf)).toBeGreaterThan(4);
  });

  it('можно приколоть кисть и крутить корпус — кисть остаётся на месте', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const hand = wpos(h, 'RightHand').clone();
    const lf = wpos(h, 'LeftFoot').clone(), rf = wpos(h, 'RightFoot').clone();
    rig.solve(
      new Map([['RightHand', hand], ['LeftFoot', lf], ['RightFoot', rf]]),
      { bone: 'Hips', pos: wpos(h, 'Hips').clone().add(V(2, -4, 2)) },
    );
    expect(wpos(h, 'RightHand').distanceTo(hand)).toBeLessThan(1.2);
    expect(wpos(h, 'LeftFoot').distanceTo(lf)).toBeLessThan(1.2);
  });
});

describe('fullBodyIk — цепь ПРОИЗВОЛЬНОЙ длины (требование первой версии)', () => {
  it('цепь из 3 звеньев (нога) и из 4 (спина до головы) решаются одинаково', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const headTarget = wpos(h, 'Head').clone().add(V(4, -3, 5));
    const err = rig.solve(new Map([['Head', headTarget]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    expect(err).toBeLessThan(1);
  });

  it('пальцы (три фаланги) решаются той же машинкой', () => {
    const h = buildHumanoid({ fingers: true });
    const rig = makeFullBodyIk(h);
    expect(rig.bones).toContain('LeftIndexDistal');
    const tip = wpos(h, 'LeftIndexDistal').clone();
    const target = tip.clone().add(V(-1.2, -1.5, 0.4));
    const err = rig.solve(new Map([['LeftIndexDistal', target]]), { bone: 'LeftHand', pos: wpos(h, 'LeftHand') });
    expect(err).toBeLessThan(0.6);
  });

  it('солвер не знает про «ногу = 2 кости»: цель на носке тоже достигается', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const toes = wpos(h, 'LeftToes').clone().add(V(0, 3, 4));
    const err = rig.solve(new Map([['LeftToes', toes]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    expect(err).toBeLessThan(1);
  });
});

describe('fullBodyIk — пределы суставов', () => {
  it('с клэмпом локоть не выворачивается наизнанку', () => {
    // Предел-заглушка: жёсткий шарнир только вокруг Y с узким диапазоном.
    const hinge = (bone: string): ReturnType<typeof mkView> | null => (bone === 'LeftLowerArm' ? mkView() : null);
    function mkView(): { kind: 'hinge'; group: 'arm'; canon: string; axis: [number, number, number]; hingeNormal: [number, number, number]; min: number; max: number } {
      return { kind: 'hinge', group: 'arm', canon: 'elbow', axis: [0, 1, 0], hingeNormal: [1, 0, 0], min: -0.2, max: 0.2 };
    }
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h, { limits: hinge as never });
    rig.solve(new Map([['LeftHand', wpos(h, 'LeftHand').add(V(-14, -10, 0))]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    expect(h.bones.get('LeftLowerArm')!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.25);   // зажат в свой диапазон
  });

  it('без клэмпа тот же случай сгибает локоть заметно сильнее (клэмп реально работает)', () => {
    const bend = (limits?: unknown): number => {
      const h = buildHumanoid({});
      const rig = makeFullBodyIk(h, limits ? { limits: limits as never } : {});
      rig.solve(new Map([['LeftHand', wpos(h, 'LeftHand').add(V(-14, -10, 0))]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
      return h.bones.get('LeftLowerArm')!.quaternion.angleTo(new THREE.Quaternion());
    };
    const tight = (bone: string): unknown => (bone === 'LeftLowerArm'
      ? { kind: 'hinge', group: 'arm', canon: 'elbow', axis: [0, 1, 0], hingeNormal: [1, 0, 0], min: -0.2, max: 0.2 }
      : null);
    expect(bend()).toBeGreaterThan(bend(tight) + 0.3);
  });
});

describe('fullBodyIk — устойчивость', () => {
  it('пустой набор целей — no-op без исключений', () => {
    const h = buildHumanoid({});
    const before = wpos(h, 'LeftHand').clone();
    expect(makeFullBodyIk(h).solve(new Map())).toBe(0);
    expect(wpos(h, 'LeftHand').distanceTo(before)).toBe(0);
  });

  it('повторный solve на уже достигнутой позе ничего не ломает (идемпотентность)', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    const t = wpos(h, 'LeftHand').clone().add(V(-5, -6, 4));
    rig.solve(new Map([['LeftHand', t]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    const p1 = wpos(h, 'LeftHand').clone();
    rig.solve(new Map([['LeftHand', t]]), { bone: 'Hips', pos: wpos(h, 'Hips') });
    expect(wpos(h, 'LeftHand').distanceTo(p1)).toBeLessThan(0.2);
  });

  it('неизвестная кость в целях игнорируется', () => {
    const h = buildHumanoid({});
    const rig = makeFullBodyIk(h);
    expect(() => rig.solve(new Map([['НетТакойКости', V(0, 0, 0)]]))).not.toThrow();
  });
});
