import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PosePlayer, localStorageContent, emptyGrid } from './poseRuntime.js';
import { buildHumanoid } from './humanoid.js';
import { GAIT } from './pose.js';
import type { Clip, Pose } from './clipModel.js';

/**
 * УДАР С МЕСТА ВЛАДЕЕТ НИЗОМ, УДАР НА ХОДУ — НЕТ.
 *
 * Требование сформулировано так: «если персонаж стоит и бьёт, хотелось бы, чтобы он и тазом шевелил
 * — перенос веса, — и делал небольшой подшаг; а если бьёт на ходу, то ноги с тазом участвуют
 * в локомоции, и никакого подшага».
 *
 * Таз это уже умел: `applyAttackPelvis` идёт с весом `1 − moveMag`. А ноги — нет: в маске удара
 * (`ATK_MASK`) не было ни таза, ни ног вообще, поэтому подшаг, заавторенный в клипе, игнорировался
 * даже стоя. Теперь у слота действия ВТОРАЯ маска — ноги, — и вес у неё тот же `1 − moveMag`.
 *
 * Тест смотрит на РЕЗУЛЬТАТ в кости, а не на флаги: клип уводит ноги в заведомо небазовую позу,
 * и мы проверяем, доехало ли это до рига.
 */
const mkClip = (): Clip => {
  // Подшаг: обе ноги уходят в позу, которой процедурная походка стоя не даст никогда.
  const v = (x: number, y = 0, z = 0): [number, number, number] => [x, y, z];
  const legs: Pose = { LeftUpperLeg: v(0.9), RightUpperLeg: v(-0.9), LeftLowerLeg: v(1.2), RightLowerLeg: v(0.2) };
  const arms: Pose = { RightUpperArm: v(-1.2, 0, 0.4), LeftUpperArm: v(-0.3, 0, -0.4) };
  const pose: Pose = { ...legs, ...arms };
  const flat: Pose = { LeftUpperLeg: v(0), RightUpperLeg: v(0), LeftLowerLeg: v(0), RightLowerLeg: v(0), ...arms };
  return { name: 'hit_none', character: 'warrior', weapon: 'none', loop: false, keys: [{ pose: flat, t: 0 }, { pose, t: 0.25 }, { pose, t: 0.5 }, { pose: flat, t: 0.75 }] };
};

describe('слот действия и низ тела', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
    } as Storage;
  });
  afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

  /** Риг держим САМИ: `PosePlayer.human` приватный, и лезть в него из теста — расширять API ради теста. */
  const mk = (): { p: PosePlayer; h: ReturnType<typeof buildHumanoid> } => {
    const h = buildHumanoid({});
    return { p: new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', { armDown: 1.35, elbowBend: 0.25 }, emptyGrid()), h };
  };

  /** Максимальный за удар вылет бедра от того, что даёт та же ситуация БЕЗ удара. */
  const legSwing = (speed: number): number => {
    const ref = mk(), hit = mk();
    for (const x of [ref, hit]) { x.p.setYaw(0); x.p.setVel(0, speed); }
    for (let i = 0; i < 120; i++) { ref.p.step(1 / 60); hit.p.step(1 / 60); }
    hit.p.triggerAttack(mkClip());
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      ref.p.step(1 / 60); hit.p.step(1 / 60);
      for (const b of ['LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg']) {
        const a = ref.h.bones.get(b)!.rotation, c = hit.h.bones.get(b)!.rotation;
        worst = Math.max(worst, Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z));
      }
    }
    return worst;
  };

  it('СТОЯ удар доезжает до ног — подшаг из клипа играет', () => {
    expect(legSwing(0), 'ноги ушли от того, что даёт покой без удара').toBeGreaterThan(0.3);
  });

  it('НА ПОЛНОМ ХОДУ удар ног не трогает — ими владеет локомоция', () => {
    expect(legSwing(GAIT.speedRun), 'ноги идут строго по планировщику').toBeLessThan(0.02);
  });

  it('на ходьбе низ отдаётся локомоции ЧАСТИЧНО, без порога и щелчка', () => {
    const still = legSwing(0), walk = legSwing(GAIT.speedWalk * 0.5), run = legSwing(GAIT.speedRun);
    expect(walk, 'меньше, чем стоя').toBeLessThan(still);
    expect(walk, 'но больше, чем на бегу').toBeGreaterThan(run);
  });

  it('руки бьют И на бегу — гейт низа их не касается', () => {
    const ref = mk(), hit = mk();
    for (const x of [ref, hit]) { x.p.setYaw(0); x.p.setVel(0, GAIT.speedRun); }
    for (let i = 0; i < 120; i++) { ref.p.step(1 / 60); hit.p.step(1 / 60); }
    hit.p.triggerAttack(mkClip());
    let arm = 0;
    for (let i = 0; i < 60; i++) {
      ref.p.step(1 / 60); hit.p.step(1 / 60);
      const a = ref.h.bones.get('RightUpperArm')!.rotation, c = hit.h.bones.get('RightUpperArm')!.rotation;
      arm = Math.max(arm, Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z));
    }
    expect(arm, 'рука на бегу бьёт').toBeGreaterThan(0.2);
  });

  it('после удара ноги возвращаются к локомоции, а не залипают', () => {
    const { p, h } = mk(); p.setYaw(0); p.setVel(0, 0);
    for (let i = 0; i < 120; i++) p.step(1 / 60);
    const before = h.bones.get('LeftUpperLeg')!.rotation.clone();
    p.triggerAttack(mkClip());
    for (let i = 0; i < 240; i++) p.step(1 / 60);      // удар давно кончился
    const after = h.bones.get('LeftUpperLeg')!.rotation;
    expect(Math.hypot(before.x - after.x, before.y - after.y, before.z - after.z), 'нога вернулась в покой').toBeLessThan(0.05);
  });
});
