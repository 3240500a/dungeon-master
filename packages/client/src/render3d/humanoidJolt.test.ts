import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as THREE from 'three';
import initJolt from 'jolt-physics';

// humanoidRagdoll тянет ragdoll.ts (DOM через env3d) — Jolt здесь свой, прямо из пакета, а модуль нужен только ради типа.
vi.mock('./ragdoll.js', () => ({ jolt: () => { throw new Error('jolt() не нужен: инстанс передаётся явно'); } }));

import { joltJointSettings, jointOv } from './humanoidRagdoll.js';

/**
 * СТОРОЖ ФИЗИКИ СУСТАВОВ НА ЖИВОМ JOLT. Чистые функции (`joltSwing`, `physSwingOf`) проверяются в `humanoidLimits.test.ts`,
 * но ошибка 17.09 жила именно на стыке с движком: наш plane-диапазон уходил в `mPlaneHalfConeAngle`, а Jolt этим конусом
 * держит поворот вокруг normal-оси. Тут сустав собирается ТЕМ ЖЕ `joltJointSettings`, что и кукла, тело раскручивается
 * вокруг оси, и меряется, где оно встало.
 */
type JoltNS = Awaited<ReturnType<typeof initJolt>>;
type V3 = [number, number, number];
let J: JoltNS;
let ji: InstanceType<JoltNS['JoltInterface']>;
let bi: ReturnType<ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>['GetBodyInterface']>;

beforeAll(async () => {
  J = await initJolt();
  const s = new J.JoltSettings();
  const objFilter = new J.ObjectLayerPairFilterTable(2);                 // 0 — родитель, 1 — ребёнок; друг с другом не сталкиваются
  const bp = new J.BroadPhaseLayerInterfaceTable(2, 2);
  bp.MapObjectToBroadPhaseLayer(0, new J.BroadPhaseLayer(0));
  bp.MapObjectToBroadPhaseLayer(1, new J.BroadPhaseLayer(1));
  s.mObjectLayerPairFilter = objFilter;
  s.mBroadPhaseLayerInterface = bp;
  s.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bp, 2, objFilter, 2);
  ji = new J.JoltInterface(s);
  const g = new J.Vec3(0, 0, 0); ji.GetPhysicsSystem().SetGravity(g);
  bi = ji.GetPhysicsSystem().GetBodyInterface();
});
afterEach(() => { for (const k in jointOv) delete jointOv[k]; });

const D = 180 / Math.PI;
function body(motion: number, layer: number): InstanceType<JoltNS['Body']> {
  const pos = new J.RVec3(0, 0, 0), rot = new J.Quat(0, 0, 0, 1);
  const b = bi.CreateBody(new J.BodyCreationSettings(new J.SphereShape(0.5), pos, rot, motion as never, layer));
  bi.AddBody(b.GetID(), J.EActivation_Activate);
  return b;
}
/** Раскрутить ребёнка вокруг мировой `axis` и вернуть угол (°, со знаком вокруг этой оси), где его остановил сустав. */
function reach(rag: string, axis: V3, motorTarget?: THREE.Quaternion): number {
  const sys = ji.GetPhysicsSystem();
  const parent = body(J.EMotionType_Static, 0), child = body(J.EMotionType_Dynamic, 1);
  const j = joltJointSettings(J, rag, [0, 0, 0])!;
  const con = j.s.Create(parent, child);
  sys.AddConstraint(con);
  if (motorTarget) {
    const m = j.kind === 'swing' ? [j.s.mSwingMotorSettings, j.s.mTwistMotorSettings] : [];
    for (const ms of m) { ms.mSpringSettings.mMode = J.ESpringMode_FrequencyAndDamping; ms.mSpringSettings.mFrequency = 20; ms.mSpringSettings.mDamping = 1; ms.mMinTorqueLimit = -1e9; ms.mMaxTorqueLimit = 1e9; }
    const st = J.castObject(con, J.SwingTwistConstraint);
    st.SetSwingMotorState(J.EMotorState_Position); st.SetTwistMotorState(J.EMotorState_Position);
    st.SetTargetOrientationBS(new J.Quat(motorTarget.x, motorTarget.y, motorTarget.z, motorTarget.w));
  } else bi.SetAngularVelocity(child.GetID(), new J.Vec3(axis[0] * 2, axis[1] * 2, axis[2] * 2));
  for (let i = 0; i < 300; i++) ji.Step(1 / 60, 1);
  const r = bi.GetRotation(child.GetID());
  const a = new THREE.Vector3(...axis).normalize();
  const ang = 2 * Math.atan2(r.GetX() * a.x + r.GetY() * a.y + r.GetZ() * a.z, r.GetW()) * D;
  sys.RemoveConstraint(con);
  for (const b of [child, parent]) { bi.RemoveBody(b.GetID()); bi.DestroyBody(b.GetID()); }
  return ang;
}

describe('Jolt: пределы суставов куклы', () => {
  it('бедро: сгиб упирается в физ-потолок 60°, разгиб 52°, отведение 80° наружу на ОБЕИХ ногах', () => {
    for (const [rag, out] of [['ThighL', 1], ['ThighR', -1]] as const) {
      expect(reach(rag, [-1, 0, 0])).toBeCloseTo(60.2, 0);    // колено вперёд
      expect(reach(rag, [1, 0, 0])).toBeCloseTo(51.6, 0);
      expect(reach(rag, [0, 0, out])).toBeCloseTo(80.2, 0);   // перепутанные конусы дали бы здесь 60°
    }
  });
  it('стопа: вверх 40°, вниз 60°, влево-вправо ±45°, крен ±30°', () => {
    for (const rag of ['FootL', 'FootR']) {
      expect(reach(rag, [-1, 0, 0])).toBeCloseTo(40.1, 0);
      expect(reach(rag, [1, 0, 0])).toBeCloseTo(60.2, 0);
      expect(reach(rag, [0, 1, 0])).toBeCloseTo(45, 0);
      expect(reach(rag, [0, -1, 0])).toBeCloseTo(45, 0);
      expect(Math.abs(reach(rag, [0, 0, 1]) - 29.8)).toBeLessThan(1);
    }
  });
  it('сегмент спины: сгиб 30°, разгиб 17°, бок 15°, скрутка 20°', () => {
    expect(reach('Torso', [1, 0, 0])).toBeCloseTo(30, 0);
    expect(Math.abs(reach('Torso', [-1, 0, 0]) - 16.6)).toBeLessThan(1);
    expect(reach('Torso', [0, 0, 1])).toBeCloseTo(15.1, 0);
    expect(reach('Torso', [0, 1, 0])).toBeCloseTo(20.1, 0);
  });
  it('носок: вниз 40°, вверх 60°', () => {
    expect(reach('ToeL', [1, 0, 0])).toBeCloseTo(40.1, 0);
    expect(reach('ToeR', [-1, 0, 0])).toBeCloseTo(60.2, 0);
  });
  it('асимметричный твист бедра зеркалится на правую ногу так же, как в клэмпе редактора', () => {
    jointOv.hip = { twistMin: -0.2, twistMax: 0.6 };
    expect(reach('ThighL', [0, -1, 0])).toBeCloseTo(34.4, 0);
    expect(reach('ThighL', [0, 1, 0])).toBeCloseTo(11.5, 0);
    expect(reach('ThighR', [0, 1, 0])).toBeCloseTo(34.4, 0);
    expect(reach('ThighR', [0, -1, 0])).toBeCloseTo(11.5, 0);
  });
  it('сдвинутая рамка не сдвигает цель мотора: «покой» держит покой, цель в пределе встаёт ровно, за пределом — на предел', () => {
    const about = (r: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), r);
    for (const rag of ['ThighL', 'Torso', 'FootL']) expect(Math.abs(reach(rag, [1, 0, 0], new THREE.Quaternion()))).toBeLessThan(0.5);
    expect(reach('ThighL', [1, 0, 0], about(-0.5))).toBeCloseTo(-28.6, 0);   // сгиб бедра 28.6° < 60°
    expect(reach('FootL', [1, 0, 0], about(-0.5))).toBeCloseTo(-28.6, 0);    // носок вверх 28.6° < 40°
    expect(reach('Torso', [1, 0, 0], about(0.4))).toBeCloseTo(22.9, 0);      // сгиб сегмента 22.9° < 30°
    expect(Math.abs(reach('Torso', [1, 0, 0], about(-0.5)) + 16.6)).toBeLessThan(1);   // разгиб 28.6° > 16.6° — Jolt клэмпит цель
  });
});
