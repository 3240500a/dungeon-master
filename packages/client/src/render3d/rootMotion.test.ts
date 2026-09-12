import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { detrendTravel, rootTravel, type Vec3 } from './footLock.js';
import { ROOT_POS, ROOT_YAW, blendTwo, flipPose, migrateClip, rootMotion, setRootMotion, type Clip, type Keyframe, type Pose } from './clipModel.js';
import { poseClipToAnimationClip, animationClipToPoseClip, ROOT_POS_TRACK, ROOT_ROT_TRACK } from './clipToAnimation.js';
import { buildHumanoid } from './humanoid.js';
import { PoseDriver } from './pose.js';
import { gaitToHumanoid, type PoseContent, type GXKnobs } from './poseRuntime.js';

/**
 * КОРЕНЬ КЛИПА (Ф2) — ДАННЫЕ, А НЕ ПРИВОД.
 *
 * Позицию и фейсинг задаёт сервер. Клип, который сам подвинул персонажа, — это рассинхрон с сервером,
 * то есть худший вид бага: он не падает, он тихо разъезжается и виден только рядом с другим игроком.
 * Поэтому канал корня заводится СРАЗУ со сторожем: проигрывание клипа с корнем обязано давать те же
 * кости, что и тот же клип без корня.
 *
 * Нужен канал троим: анализатору походки (длина шага и угол поворота за шаг берутся отсюда), экспорту
 * в чужой движок (там это root motion) и предпросмотру в редакторе.
 */
const DT = 1 / 60;

describe('снятие корня ничего не теряет и не удваивает', () => {
  const raw: Vec3[] = Array.from({ length: 20 }, (_, i) => [i * 3 + Math.sin(i) * 2, 32 + Math.sin(i * 0.7), i * 5]);

  it('поза + корень = исходное движение, покадрово', () => {
    for (const mode of ['none', 'vertical', 'full'] as const) {
      const det = detrendTravel(raw, mode), root = rootTravel(raw, mode);
      for (let i = 0; i < raw.length; i++) {
        for (let a = 0; a < 3; a++) {
          expect(det[i]![a]! + root[i]![a]!, `${mode}[${i}][${a}]`).toBeCloseTo(raw[i]![a]!, 9);
        }
      }
    }
  });

  it('на in-place источнике корень РОВНО ноль — брать нечего', () => {
    const still: Vec3[] = Array.from({ length: 12 }, (_, i) => [0, 32 + Math.sin(i), 0]);
    for (const r of rootTravel(still, 'full')) { expect(r[0]).toBeCloseTo(0, 12); expect(r[2]).toBeCloseTo(0, 12); }
  });

  it('на едущем мокапе корень — это весь перенос, а в позе его не остаётся', () => {
    const walk: Vec3[] = Array.from({ length: 31 }, (_, i) => [0, 32, i * 4]);
    const root = rootTravel(walk, 'full'), det = detrendTravel(walk, 'full');
    expect(root.at(-1)![2], 'весь травел в корне').toBeCloseTo(120, 6);
    expect(Math.max(...det.map((d) => Math.abs(d[2]))), 'в позе травела не осталось').toBeLessThan(1e-9);
  });
});

describe('канал корня в модели клипа', () => {
  it('читается и пишется, отсутствие каналов = клип in-place', () => {
    const p: Pose = {};
    expect(rootMotion(p)).toBeNull();
    setRootMotion(p, 1.5, 10, -20);
    expect(rootMotion(p)).toEqual([1.5, 10, -20]);
  });

  it('ПОВОРОТ НАКОПЛЕННЫЙ и интерполируется линейно — разворот на 200° не сворачивается в −160°', () => {
    const a: Pose = {}, b: Pose = {};
    setRootMotion(a, 0, 0, 0);
    setRootMotion(b, Math.PI * 200 / 180, 0, 0);
    const mid = blendTwo(a, b, 0.5);
    expect(mid[ROOT_YAW]![0] * 180 / Math.PI, 'ровно половина разворота').toBeCloseTo(100, 6);
  });

  it('зеркало переворачивает и сторону разворота, и смещение вбок', () => {
    const p: Pose = {};
    setRootMotion(p, 0.8, 12, 40);
    const f = flipPose(p);
    expect(f[ROOT_YAW]![0], 'налево стало направо').toBeCloseTo(-0.8, 9);
    expect(f[ROOT_POS]![0], 'вбок зеркалится').toBeCloseTo(-12, 9);
    expect(f[ROOT_POS]![2], 'вперёд остаётся вперёд').toBeCloseTo(40, 9);
  });

  it('двойное зеркало — тождество', () => {
    const p: Pose = {}; setRootMotion(p, 0.8, 12, 40);
    expect(rootMotion(flipPose(flipPose(p)))).toEqual([0.8, 12, 40]);
  });

  it('ФЛАГИ ПЕРЕЖИВАЮТ ЧТЕНИЕ: `migrateClip` собирает клип по явному списку полей', () => {
    // Та же грабля, что описана у `marks`: новое поле клипа надо дописывать в миграцию, иначе оно
    // молча теряется на первом же чтении с сервера — и галка в панели будет «сама сбрасываться».
    const c = migrateClip({ name: 'turn_L_90', character: 'warrior', weapon: 'none', loop: false, keys: [], rootYaw: true, rootPos: true });
    expect(c.rootYaw).toBe(true);
    expect(c.rootPos).toBe(true);
  });
});

// ── Сторож: корень не двигает куклу ──────────────────────────────────────────────────────────────
const stub = (pose: Pose): PoseContent => ({ resolveUpper: () => ({ pose, swing: 0 }) });
const gx = (): GXKnobs => ({ armDown: 1.35, elbowBend: 0.25 });

/** Все кости + мировая позиция таза после одного кадра с заданной позой верха. */
function bake(pose: Pose): { bones: number[]; hips: [number, number, number] } {
  const h = buildHumanoid({});
  const d = new PoseDriver();
  let z = 0; let t = d.update(DT);
  for (let i = 0; i < 30; i++) { z += 60 * DT; d.setWorld(0, z, 0, 0, 60); t = d.update(DT); }
  h.reset();
  gaitToHumanoid(h, [], gx(), 1, t, stub(pose), 'none', { clip: null, t: -1 }, 1);
  h.root.updateMatrixWorld(true);
  const bones: number[] = [];
  for (const [, b] of [...h.bones].sort((a, b2) => a[0].localeCompare(b2[0]))) bones.push(b.rotation.x, b.rotation.y, b.rotation.z);
  const p = h.bones.get('Hips')!.getWorldPosition(new THREE.Vector3());
  return { bones, hips: [p.x, p.y, p.z] };
}

describe('СТОРОЖ: клип с корнем не двигает куклу', () => {
  const base: Pose = { LeftUpperArm: [-0.3, 0, 0.2], RightUpperArm: [-0.3, 0, -0.2], Chest: [0, 0.1, 0] };

  it('огромные смещение и поворот в каналах не меняют НИ ОДНОЙ кости', () => {
    const withRoot: Pose = { ...base };
    setRootMotion(withRoot, Math.PI, 500, -900);   // полразворота и девять метров — заметили бы сразу
    const a = bake(base), b = bake(withRoot);
    expect(b.bones).toEqual(a.bones);
  });

  it('и не двигают куклу в мире', () => {
    const withRoot: Pose = { ...base };
    setRootMotion(withRoot, Math.PI, 500, -900);
    const a = bake(base), b = bake(withRoot);
    for (let i = 0; i < 3; i++) expect(b.hips[i]).toBeCloseTo(a.hips[i]!, 12);
  });
});

describe('корень уезжает в экспорт и возвращается', () => {
  it('круговой рейс: клип → AnimationClip → клип, корень цел', () => {
    const mk = (t: number, yaw: number, x: number, z: number): Keyframe => {
      const pose: Pose = { Hips: [0, 0, 0] };
      setRootMotion(pose, yaw, x, z);
      return { t, pose };
    };
    const src: Clip = {
      name: 'turn_L_90', character: 'warrior', weapon: 'none', loop: false, rootYaw: true, rootPos: true,
      keys: [mk(0, 0, 0, 0), mk(0.4, 0.8, 12, 40), mk(0.8, Math.PI / 2, 20, 90)],
    };
    const anim = poseClipToAnimationClip(src, {});
    expect(anim.tracks.some((t) => t.name === ROOT_POS_TRACK), 'дорожка смещения есть').toBe(true);
    expect(anim.tracks.some((t) => t.name === ROOT_ROT_TRACK), 'дорожка поворота есть').toBe(true);
    const back = animationClipToPoseClip(anim, { character: 'warrior', weapon: 'none' });
    expect(back.rootYaw).toBe(true);
    expect(back.rootPos).toBe(true);
    const last = rootMotion(back.keys.at(-1)!.pose)!;
    expect(last[0], 'поворот').toBeCloseTo(Math.PI / 2, 5);
    expect(last[1], 'вбок').toBeCloseTo(20, 4);
    expect(last[2], 'вперёд').toBeCloseTo(90, 4);
  });

  it('клип БЕЗ корня не обрастает пустыми дорожками', () => {
    const plain: Clip = { name: 'idle', character: 'warrior', weapon: 'none', loop: true, keys: [{ t: 0, pose: { Hips: [0, 0, 0] } }] };
    const anim = poseClipToAnimationClip(plain, {});
    expect(anim.tracks.some((t) => t.name.startsWith('Root.'))).toBe(false);
  });

  it('корень НЕ читается обратно как кость `Root` — иначе он поехал бы в позу', () => {
    const pose: Pose = { Hips: [0, 0, 0] };
    setRootMotion(pose, 1, 5, 7);
    const anim = poseClipToAnimationClip({ name: 'c', character: 'w', weapon: 'none', loop: false, rootYaw: true, rootPos: true, keys: [{ t: 0, pose }] }, {});
    const back = animationClipToPoseClip(anim, { character: 'w', weapon: 'none' });
    expect(back.keys[0]!.pose['Root'], 'кости Root в позе быть не должно').toBeUndefined();
  });
});
