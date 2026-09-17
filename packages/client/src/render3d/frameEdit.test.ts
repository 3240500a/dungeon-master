import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// humanoidRagdoll тянет Jolt через ragdoll.ts (wasm + DOM) — для таблицы пределов шеи/головы он не нужен.
vi.mock('./ragdoll.js', () => ({ jolt: () => { throw new Error('jolt is not available in node'); } }));

import { limitViewForBone } from './humanoidRagdoll.js';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { groundFeet } from './footIk.js';
import type { Clip, Pose } from './clipModel.js';
import {
  poseRig, settleLikePhysGhost, writeKeyPose, keepChannels, sameKeyPose, keyAtTime, KEY_SNAP_SEC, previewOffKey,
  faceTarget, captureAimOffsets, aimBoneToPoint,
} from './frameEdit.js';

const D = Math.PI / 180;
const P = (o: Record<string, [number, number, number]>): Pose => o;

describe('writeKeyPose — служебные каналы ключа', () => {
  it('переносит __swing/__rootY/__rootP/__match/__pinKp, которых свежая поза не несёт', () => {
    const old = P({ Spine: [0.1, 0, 0], __swing: [1, 0, 0], __rootY: [0.3, 0, 0], __rootP: [1, 2, 3], __match: [0.7, 0, 0], __pinKp: [900, 0, 0] });
    const out = keepChannels(P({ Spine: [0.2, 0, 0], __hipsD: [0, -1, 0] }), old);
    expect(out['Spine']).toEqual([0.2, 0, 0]);
    for (const k of ['__swing', '__rootY', '__rootP', '__match', '__pinKp']) expect(out[k], k).toEqual(old[k]);
    expect(out['__swing']).not.toBe(old['__swing']);   // копия, а не ссылка — правка одного ключа не течёт в другой
  });

  it('канал, который свежая поза УЖЕ несёт, старым не перетирается (шов цикла: парный ключ получает каналы записанного)', () => {
    // Ревью-мутация «убрать `nm in fresh`» проходила все тесты: в `readPoseFull` таких каналов нет, но копия в парный ключ их несёт.
    const out = keepChannels(P({ __swing: [5, 0, 0], __rootY: [0.1, 0, 0] }), P({ __swing: [1, 0, 0], __rootY: [0.9, 0, 0], __match: [0.5, 0, 0] }));
    expect(out['__swing']).toEqual([5, 0, 0]);
    expect(out['__rootY']).toEqual([0.1, 0, 0]);
    expect(out['__match']).toEqual([0.5, 0, 0]);
  });

  it('каналы, которыми владеет чтение позы, НЕ воскрешает: хват оружия, маркер левой кисти, таз', () => {
    const old = P({ __wpnOverride: [1, 0, 0], __wpnMain: [0.1, 0.2, 0.3], __wpnOffP: [1, 1, 1], __lgripP: [1, 2, 3], __lgripR: [0, 0, 1], __hipsP: [0, 30, 0], __hipsD: [0, -2, 0] });
    const out = keepChannels(P({ Spine: [0, 0, 0], __hipsD: [0, -1, 0] }), old);
    expect(Object.keys(out).sort()).toEqual(['Spine', '__hipsD']);
    expect(out['__hipsD']).toEqual([0, -1, 0]);
  });
});

describe('writeKeyPose — шов цикла', () => {
  const mk = (loop: boolean, n: number, seamed = true): Clip => ({
    name: 'run_fwd', character: 'c', weapon: 'none', loop,
    keys: Array.from({ length: n }, (_, i) => ({ t: i * 0.1, pose: P({ LeftFoot: [i === n - 1 && seamed ? 0 : i * 0.1, 0, 0], __hipsD: [0, i === n - 1 && seamed ? 0 : -i * 0.1, 0], __swing: [i, 0, 0] }) })),
  });

  it('⭐ запись ключа 0 у сомкнутого цикла пишет и последний ключ (копией), и наоборот', () => {
    const c = mk(true, 5);
    expect(sameKeyPose(c.keys[0]!.pose, c.keys[4]!.pose)).toBe(true);
    expect(writeKeyPose(c, 0, P({ LeftFoot: [0.34, 0, 0], __hipsD: [0, -0.5, 0] }))).toEqual([0, 4]);
    expect(c.keys[4]!.pose['LeftFoot']).toEqual([0.34, 0, 0]);
    expect(c.keys[4]!.pose['__hipsD']).toEqual([0, -0.5, 0]);
    expect(c.keys[4]!.pose['LeftFoot']).not.toBe(c.keys[0]!.pose['LeftFoot']);
    expect(sameKeyPose(c.keys[0]!.pose, c.keys[4]!.pose)).toBe(true);
    expect(writeKeyPose(c, 4, P({ LeftFoot: [-0.2, 0, 0] }))).toEqual([4, 0]);
    expect(c.keys[0]!.pose['LeftFoot']).toEqual([-0.2, 0, 0]);
    expect(c.keys[0]!.pose['__swing']).toEqual([0, 0, 0]);   // служебный канал своего ключа уцелел
  });

  it('середина цикла, разведённые автором концы, не-цикл и два ключа — пишется только сам ключ', () => {
    const mid = mk(true, 5); expect(writeKeyPose(mid, 2, P({ LeftFoot: [1, 0, 0] }))).toEqual([2]);
    const open = mk(true, 5, false); expect(writeKeyPose(open, 0, P({ LeftFoot: [1, 0, 0] }))).toEqual([0]);
    expect(open.keys[4]!.pose['LeftFoot']).toEqual([0.4, 0, 0]);
    const once = mk(false, 5); expect(writeKeyPose(once, 0, P({ LeftFoot: [1, 0, 0] }))).toEqual([0]);
    const two = mk(true, 2); expect(writeKeyPose(two, 0, P({ LeftFoot: [1, 0, 0] }))).toEqual([0]);
  });

  it('совпадение концов — по повороту (двойное покрытие, отсутствующая кость = rest) и офсету таза', () => {
    expect(sameKeyPose(P({ Head: [0, 0, 0] }), P({}))).toBe(true);
    expect(sameKeyPose(P({ Head: [Math.PI, 0, 0] }), P({ Head: [-Math.PI, 0, 0] }))).toBe(true);
    expect(sameKeyPose(P({ Head: [0.0002, 0, 0] }), P({ Head: [0, 0, 0] }))).toBe(false);
    expect(sameKeyPose(P({ __hipsD: [0, -1, 0] }), P({ __hipsD: [0, -1.001, 0] }))).toBe(false);
  });
});

describe('keyAtTime — клик по линейке на ключ', () => {
  const c: Clip = { name: 'x', character: 'c', weapon: 'none', loop: false, keys: [0, 0.3, 0.45].map((t) => ({ t, pose: {} })) };
  it('в полкадра при 60 к/с — это ключ, дальше — между ключами', () => {
    expect(keyAtTime(c, 0.3 + KEY_SNAP_SEC * 0.9)).toBe(1);
    expect(keyAtTime(c, 0.3 - KEY_SNAP_SEC * 1.1)).toBe(-1);
    expect(keyAtTime(c, 0.38)).toBe(-1);
    expect(keyAtTime(c, 0.449)).toBe(2);
  });
});

describe('previewOffKey — гейт записи кадра после скраба/проигрывания', () => {
  const c: Clip = { name: 'x', character: 'c', weapon: 'none', loop: false, keys: [0, 0.3, 0.45].map((t) => ({ t, pose: {} })) };
  it('превью не было или оно стоит на ВЫБРАННОМ ключе — запись разрешена (null)', () => {
    expect(previewOffKey(c, 1, null)).toBeNull();
    expect(previewOffKey(c, 1, 0.3)).toBeNull();
    expect(previewOffKey(c, 1, 0.3 + KEY_SNAP_SEC * 0.9)).toBeNull();
  });
  it('⭐ между ключами, на ЧУЖОМ ключе и без ключа — отказ со временем превью', () => {
    expect(previewOffKey(c, 1, 0.38)).toBe(0.38);                          // поза с t=0.38 не уйдёт в кадр на t=0.30
    expect(previewOffKey(c, 1, 0.45)).toBe(0.45);                          // поза ключа 3 не уйдёт в выбранный ключ 2
    expect(previewOffKey(c, 1, 0.3 + KEY_SNAP_SEC * 1.1)).toBeCloseTo(0.3 + KEY_SNAP_SEC * 1.1, 12);
    expect(previewOffKey(c, 7, 0)).toBe(0);                                // выбранного ключа нет
  });
});

// ── Призрак соседнего кадра ──────────────────────────────────────────────────────────────────────

const LEGS = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];
const world = (h: Humanoid, nm: string): THREE.Vector3 => { h.root.updateMatrixWorld(true); return h.bones.get(nm)!.getWorldPosition(new THREE.Vector3()); };
/** Эталон «видимой фигуры»: физ-призрак кинематически (ноги по позе, таз = поза + gs.off), 60 Гц, 10 с от off = 0. */
function physGhostRef(h: Humanoid, p: Pose, lag: number): void {
  poseRig(h, p); h.root.position.set(0, 0, 0); h.root.updateMatrixWorld(true);
  const hy = h.hipsWorldY(), gs = { off: 0 }, save = LEGS.map((n) => h.bones.get(n)!.quaternion.clone());
  for (let f = 0; f < 600; f++) {
    LEGS.forEach((n, i) => h.bones.get(n)!.quaternion.copy(save[i]!));
    h.setHipsWorldY(hy + gs.off); h.root.updateMatrixWorld(true);
    groundFeet(h, hy, gs, 1 / 60, () => 0, undefined, { lag, still: true });
  }
}

describe('poseRig — таз ключа свой, а не с манекена', () => {
  it('⭐ таз = rest + СОБСТВЕННЫЙ __hipsD, что бы ни стояло на риге до этого', () => {
    const h = buildHumanoid();
    h.hips.position.set(3, 40, -2);                                    // «таз манекена текущего кадра»
    poseRig(h, P({ LeftUpperLeg: [-0.4, 0, 0], __hipsD: [0.5, -2.25, 0.1] }));
    expect(h.hips.position.x).toBeCloseTo(h.hipsRest.x + 0.5, 9);
    expect(h.hips.position.y).toBeCloseTo(h.hipsRest.y - 2.25, 9);
    expect(h.hips.position.z).toBeCloseTo(h.hipsRest.z + 0.1, 9);
    expect(h.bones.get('LeftUpperLeg')!.rotation.x).toBeCloseTo(-0.4, 9);
    poseRig(h, P({}));                                                  // нет офсета — rest
    expect(h.hips.position.distanceTo(h.hipsRest)).toBeLessThan(1e-9);
  });
});

describe('settleLikePhysGhost — призрак садится туда же, куда физ-призрак', () => {
  // Обе стопы опорные и под полом (таз опущен): заземление поднимает таз на часть зазора.
  const crouch = P({ LeftUpperLeg: [-0.1, 0, 0], RightUpperLeg: [-0.1, 0, 0], __hipsD: [0, -1.6, 0] });
  // Одна нога поднята выше порога опоры (6u): стоим на одной, сдвиг держится (как у призрака после goFrame — 0).
  const oneLeg = P({ RightUpperLeg: [-1.2, 0, 0], RightLowerLeg: [1.4, 0, 0], __hipsD: [0, -0.8, 0] });

  for (const lag of [1, 8, 15]) {
    it(`gndLag ${lag}: все кости совпадают с 10-секундной моделью физ-призрака`, () => {
      for (const p of [crouch, oneLeg]) {
        const a = buildHumanoid(), b = buildHumanoid();
        poseRig(a, p); a.root.position.set(0, 0, 0);
        const r = settleLikePhysGhost(a, lag);
        physGhostRef(b, p, lag);
        let err = 0;
        for (const nm of a.boneNames) err = Math.max(err, world(a, nm).distanceTo(world(b, nm)));
        expect(err, `расхождение ${err.toFixed(5)}u за ${r.steps} шагов`).toBeLessThan(0.01);
        expect(r.steps).toBeLessThan(600);
      }
    });
  }

  it('обе стопы опорные: таз садится не на полный зазор, а в неподвижную точку интегратора призрака (≈2/3)', () => {
    const h = buildHumanoid();
    poseRig(h, crouch); h.root.position.set(0, 0, 0); h.root.updateMatrixWorld(true);
    // полный зазор под опорной стопой: один шаг без «стоим» с огромным dt двигает сдвиг ровно на него
    const probe = { off: 0 };
    groundFeet(h, h.hipsWorldY(), probe, 1e3, () => 0, undefined, { lag: 1 });
    poseRig(h, crouch); h.root.position.set(0, 0, 0);
    const r = settleLikePhysGhost(h, 1);
    const k = 1 / 60, ratio = (1 - k / 2) / (1.5 - k / 2);   // off = g·(1 − k/2)/(1.5 − k/2)
    expect(probe.off).toBeGreaterThan(0.5);                  // стопы под полом — таз поднимается
    expect(r.off / probe.off).toBeCloseTo(ratio, 2);
  });

  it('одна опорная стопа — сдвиг таза 0, как у физ-призрака сразу после перехода на кадр', () => {
    const h = buildHumanoid();
    poseRig(h, oneLeg); h.root.position.set(0, 0, 0);
    expect(settleLikePhysGhost(h, 15).off).toBe(0);
  });
});

// ── Взгляд ───────────────────────────────────────────────────────────────────────────────────────

describe('хелпер взгляда на смене кадра', () => {
  const FWD = new THREE.Vector3(0, 0, 1), BONES = [['Neck', 0.35], ['Head', 0.65]] as const;
  // Голова наклонена ОТНОСИТЕЛЬНО шеи, шея повёрнута: оси «вперёд» у двух костей расходятся на ~20°.
  const pose = P({ Spine: [0.1, 0.2, 0], Neck: [0.15, 0.1, 0], Head: [-0.3, 0.15, 0.05] });
  const gaze = (h: Humanoid, t: THREE.Vector3, off: Map<string, THREE.Vector3> | null): void => {
    for (let i = 0; i < 2; i++) for (const [n, w] of BONES) aimBoneToPoint(h, n, t, w, FWD, limitViewForBone, off?.get(n));
  };
  const snap = (h: Humanoid): THREE.Quaternion[] => BONES.map(([n]) => h.bones.get(n)!.quaternion.clone());
  const change = (h: Humanoid, q0: THREE.Quaternion[]): number => Math.max(...BONES.map(([n], i) => h.bones.get(n)!.quaternion.angleTo(q0[i]!) / D));
  const headDir = (h: Humanoid): THREE.Vector3 => { h.root.updateMatrixWorld(true); return FWD.clone().applyQuaternion(h.bones.get('Head')!.getWorldQuaternion(new THREE.Quaternion())); };

  it('только цель «перед лицом» — шея/голова всё равно доворачиваются (так было бы)', () => {
    const h = buildHumanoid(); poseRig(h, pose);
    const q0 = snap(h), t = faceTarget(h, 'Head', FWD, 55)!;
    gaze(h, t, null);
    expect(change(h, q0)).toBeGreaterThan(3);
  });

  it('⭐ цель перед лицом + сдвиги прицела — поза кадра не меняется вовсе', () => {
    const h = buildHumanoid(); poseRig(h, pose);
    const q0 = snap(h), t = faceTarget(h, 'Head', FWD, 55)!;
    gaze(h, t, captureAimOffsets(h, BONES, t, FWD));
    expect(change(h, q0)).toBeLessThan(1e-4);
  });

  it('и взгляд при этом работает: корпус скрутили на 30° — голова держит направление', () => {
    const h = buildHumanoid(); poseRig(h, pose);
    const t = faceTarget(h, 'Head', FWD, 55)!, off = captureAimOffsets(h, BONES, t, FWD), dir0 = headDir(h);
    const sp = h.bones.get('Spine')!; sp.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 30 * D));
    h.root.updateMatrixWorld(true);
    const free = headDir(h).angleTo(dir0) / D;
    gaze(h, t, off);
    const kept = headDir(h).angleTo(dir0) / D;
    expect(free).toBeGreaterThan(20);
    expect(kept, `без взгляда ушла на ${free.toFixed(1)}°`).toBeLessThan(free / 3);
  });

  it('доворачивать нечего — клэмп не трогает позу за пределом сустава', () => {
    const h = buildHumanoid(); poseRig(h, P({ Head: [0, 1.2, 0] }));   // твист головы 69° при пределе ±40°
    const q0 = snap(h), t = faceTarget(h, 'Head', FWD, 55)!;
    gaze(h, t, captureAimOffsets(h, BONES, t, FWD));
    expect(change(h, q0)).toBeLessThan(1e-4);
  });
});
