import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { findTwistChains, driveTwistChains, twistReport } from './twistBones.js';

const D = 180 / Math.PI;
/** Скелет как у CC: сегмент вдоль +X, твисты ВЛОЖЕНЫ друг в друга, дочерний сегмент — отдельная ветка. */
function ourRig(): { bones: Map<string, THREE.Object3D> } {
  // НАШ риг: рест = identity, позиция ребёнка задаёт ось кости (как в humanoid.ts)
  const mk = (x: number): THREE.Object3D => { const o = new THREE.Object3D(); o.position.set(x, 0, 0); return o; };
  return { bones: new Map([['LeftUpperArm', mk(0)], ['LeftLowerArm', mk(13)], ['LeftHand', mk(11)]]) };
}
function armRig(): { byName: Map<string, THREE.Object3D>; map: Record<string, string>; root: THREE.Object3D } {
  const mk = (name: string, x: number): THREE.Object3D => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, 0, 0); return o; };
  const root = mk('Root', 0);
  const up = mk('L_Upperarm', 0); root.add(up);
  const t1 = mk('L_UpperarmTwist01', 3); up.add(t1);      // 30% длины
  const t2 = mk('L_UpperarmTwist02', 3); t1.add(t2);      // ещё 30% → 60%
  const fore = mk('L_Forearm', 10); up.add(fore);         // длина плеча = 10
  const f1 = mk('L_ForearmTwist01', 4); fore.add(f1);     // 50% предплечья
  const hand = mk('L_Hand', 8); fore.add(hand);           // длина предплечья = 8
  root.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Object3D>([['L_Upperarm', up], ['L_Forearm', fore], ['L_Hand', hand]]);
  const map: Record<string, string> = { LeftUpperArm: 'L_Upperarm', LeftLowerArm: 'L_Forearm', LeftHand: 'L_Hand' };
  return { byName, map, root };
}
/** Мировая закрутка кости вокруг +X относительно бинда (бинд у всех = identity). */
const worldRoll = (o: THREE.Object3D): number => {
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  const a = new THREE.Vector3(1, 0, 0);
  return 2 * Math.atan2(new THREE.Vector3(q.x, q.y, q.z).dot(a), q.w) * D;
};
const find = (root: THREE.Object3D, n: string): THREE.Object3D => root.getObjectByName(n)!;

describe('twistBones — оборот растягивается по длине кости', () => {
  it('находит твисты обеих цепей и считает доли по положению', () => {
    const { byName, map } = armRig();
    const r = twistReport(findTwistChains(byName, map));
    expect(r.map((x) => x.bone).sort()).toEqual(['L_ForearmTwist01', 'L_UpperarmTwist01', 'L_UpperarmTwist02']);
  });

  it('ПЛЕЧО (untwist): у корня оборота почти нет, к локтю — полный', () => {
    const { byName, map, root } = armRig(); const our = ourRig();
    const chains = findTwistChains(byName, map);
    our.bones.get('LeftUpperArm')!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 90 / D);   // плечо крутанули на 90°
    find(root, 'L_Upperarm').quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 90 / D);
    root.updateMatrixWorld(true);
    driveTwistChains(chains, our);
    root.updateMatrixWorld(true);
    expect(worldRoll(find(root, 'L_UpperarmTwist01'))).toBeCloseTo(27, 0);    // 30% от 90°
    expect(worldRoll(find(root, 'L_UpperarmTwist02'))).toBeCloseTo(54, 0);    // 60% от 90°
    expect(worldRoll(find(root, 'L_Forearm'))).toBeCloseTo(90, 0);            // сам сегмент несёт полный
  });

  it('ВЛОЖЕННОСТЬ учтена: доли НЕ складываются (иначе Twist02 дал бы 90°)', () => {
    const { byName, map, root } = armRig(); const our = ourRig();
    const chains = findTwistChains(byName, map);
    our.bones.get('LeftUpperArm')!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 90 / D);
    find(root, 'L_Upperarm').quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 90 / D);
    root.updateMatrixWorld(true); driveTwistChains(chains, our); root.updateMatrixWorld(true);
    const a = worldRoll(find(root, 'L_UpperarmTwist01')), b = worldRoll(find(root, 'L_UpperarmTwist02'));
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(90);            // ← ключевое: не 27+54=81 поверх и не 90
  });

  it('ПРЕДПЛЕЧЬЕ (twist): источник — КИСТЬ, у локтя 0, к запястью полный', () => {
    const { byName, map, root } = armRig(); const our = ourRig();
    const chains = findTwistChains(byName, map);
    our.bones.get('LeftHand')!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 80 / D);   // пронация 80°
    root.updateMatrixWorld(true); driveTwistChains(chains, our); root.updateMatrixWorld(true);
    expect(worldRoll(find(root, 'L_ForearmTwist01'))).toBeCloseTo(40, 0);    // 50% от 80°
    expect(worldRoll(find(root, 'L_Forearm'))).toBeCloseTo(0, 3);            // сегмент пронацию не несёт
  });

  it('нет оборота — твисты стоят в бинде (ничего не портим на покое)', () => {
    const { byName, map, root } = armRig(); const our = ourRig();
    const chains = findTwistChains(byName, map);
    driveTwistChains(chains, our); root.updateMatrixWorld(true);
    for (const n of ['L_UpperarmTwist01', 'L_UpperarmTwist02', 'L_ForearmTwist01']) {
      expect(Math.abs(worldRoll(find(root, n))), n).toBeLessThan(1e-6);
    }
  });

  it('ДУБЛИ СУБМЕШЕЙ и ЧУЖИЕ конечности в цепь НЕ попадают (модель взрывало)', () => {
    // У модульного CC под каждой ведомой костью висят копии под-скелета на каждый сабмеш (`...Twist01_1`…`_37`),
    // а под само-дублём сегмента — копия остального скелета. Обход собирал 76 костей в цепь плеча → взрыв меша.
    const mk = (name: string, x: number): THREE.Object3D => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, 0, 0); return o; };
    const root = mk('Root', 0);
    const up = mk('L_Upperarm', 0); root.add(up);
    up.add(mk('L_UpperarmTwist01', 3));            // ← настоящая
    up.add(mk('L_UpperarmTwist01_7', 3));          // ← копия сабмеша: НЕ брать
    up.add(mk('L_UpperarmTwist01_23', 3));         // ← копия сабмеша: НЕ брать
    const dup = mk('L_Upperarm', 0); up.add(dup);  // ← само-дубль, под ним копия остального скелета
    dup.add(mk('L_CalfTwist01', 5));               // ← чужая конечность: НЕ брать
    dup.add(mk('L_UpperarmTwist02', 6));
    const fore = mk('L_Forearm', 10); up.add(fore);
    fore.add(mk('L_ForearmTwist01', 4));           // ← чужой сегмент (своя цепь): в цепь плеча НЕ брать
    root.updateMatrixWorld(true);
    const byName = new Map<string, THREE.Object3D>([['L_Upperarm', up], ['L_Forearm', fore]]);
    const r = twistReport(findTwistChains(byName, { LeftUpperArm: 'L_Upperarm', LeftLowerArm: 'L_Forearm' }));
    expect(r.map((x) => x.bone)).toEqual(['L_UpperarmTwist01']);
  });

  it('модель без твист-костей — пустой список, поведение прежнее', () => {
    const root = new THREE.Object3D();
    const up = new THREE.Object3D(); up.name = 'Upperarm'; root.add(up);
    const fore = new THREE.Object3D(); fore.name = 'Forearm'; fore.position.set(10, 0, 0); up.add(fore);
    root.updateMatrixWorld(true);
    const chains = findTwistChains(new Map([['Upperarm', up], ['Forearm', fore]]),
      { LeftUpperArm: 'Upperarm', LeftLowerArm: 'Forearm' });
    expect(chains).toHaveLength(0);
  });
});

describe('twistBones — регрессии из живой проверки', () => {
  it('РАЗВЁРТКА: проход через ±180° не даёт оборота на ровном месте', () => {
    const { byName, map, root } = armRig(); const our = ourRig();
    const chains = findTwistChains(byName, map);
    const arm = our.bones.get('LeftUpperArm')!;
    // меряем ФАКТИЧЕСКИЙ шаг кости кадр-к-кадру (`angleTo` не заворачивается, в отличие от угла вокруг оси)
    let prev: THREE.Quaternion | null = null, worst = 0;
    for (let deg = 0; deg <= 350; deg += 5) {     // плавно крутим ЧЕРЕЗ 180°
      arm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), deg / D);
      driveTwistChains(chains, our); root.updateMatrixWorld(true);
      const now = find(root, 'L_UpperarmTwist02').quaternion.clone();
      if (prev) worst = Math.max(worst, prev.angleTo(now) * D);
      prev = now;
    }
    expect(worst).toBeLessThan(20);              // шаг 5° × доля ≈ 3°; срыв на 2π дал бы под 180°
  });

  it('БАЗА ОТ НАШЕГО РИГА: бинд модели (A-поза/хват/стопа) в твисты НЕ течёт', () => {
    const { byName, map, root } = armRig(); const our = ourRig();
    const chains = findTwistChains(byName, map);
    // модель «в чужом бинде»: кости модели повёрнуты, а наш риг в T-позе → крена быть не должно
    find(root, 'L_Upperarm').quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 40 / D);
    find(root, 'L_Hand').quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 70 / D);
    root.updateMatrixWorld(true); driveTwistChains(chains, our); root.updateMatrixWorld(true);
    for (const n of ['L_UpperarmTwist01', 'L_UpperarmTwist02', 'L_ForearmTwist01']) {
      const t = find(root, n);
      expect(Math.abs(2 * Math.atan2(t.quaternion.x, t.quaternion.w) * D), n).toBeLessThan(1e-6);
    }
  });
});
