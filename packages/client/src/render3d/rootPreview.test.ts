import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { groundFeet } from './footIk.js';
import { flipPose, clipDur, clipPoseAt, clipChannelAt, hipsOffset, setHipsOffset, type Clip, type Pose } from './clipModel.js';
import { turnYawAt, turnSupportAt } from './turnInPlace.js';
import { PosePlayer, localStorageContent, emptyGrid, setLocoMixOverride } from './poseRuntime.js';
import { bakeTurnToClip, bakeTurnSet, defaultReadPose, TURN_PRESETS } from './clipBake.js';
import {
  poseRig, clipRootChannels, rootPreviewAt, rootViewOfPose, rootViewTime, rootViewMatrix, placeRootView, composeRootView,
  rootViewDelta, rootViewJump, turnHipsTarget, seedMotionChannels, sameRootView, copyRootView, ROOT_VIEW_ZERO, ROOT_SNAP_YAW, ROOT_SNAP_POS,
  rootPointToLocal, rootPointToWorld, rootDirToLocal, rootDirToWorld, rootQuatToLocal, rootQuatToWorld,
  turnHipsInGame, turnHipsInView, turnPelvisGameGap, clipTurnPelvisGap, TURN_GAP_DEG, TURN_GAP_U,
  type RootView,
} from './frameEdit.js';

/**
 * ⭐ ПРЕДПРОСМОТР КОРНЯ — галки «корень: поворот / смещение» в клипах поз-редактора (17.09.2026).
 *
 * Жалоба: «в анимациях поворота непонятно, как это будет выглядеть — он просто топчется на месте». Здесь — чистая часть
 * (`frameEdit.ts`): сэмплер корня тот же, что у игры; вид НЕ течёт в запись позы; призраки соседних кадров и физ-призрак
 * стоят там же, где манекен под шарниром; правка переносится за корнем. Проводку в `pose-editor.ts` сторожит
 * `frameEditWiring.test.ts` («предпросмотр корня»).
 */
const D = Math.PI / 180;
const P = (o: Record<string, [number, number, number]>): Pose => o;
const WANT = { yaw: true, pos: true } as const;

/** Поворот на 200° (накопленный, больше π) с корнем по полу и флагами опоры; ключи неравные по времени. */
function turnClip(interp?: 'smooth' | 'ease'): Clip {
  const ys = [0, 20, 95, 170, 200], ts = [0, 0.1, 0.35, 0.6, 0.8];
  return {
    name: 'turn_R_200', character: 'c', weapon: 'none', loop: false, rootYaw: true, rootPos: true,
    keys: ys.map((y, i) => ({
      t: ts[i]!, ...(interp ? { interp } : {}),
      pose: P({ Hips: [0.05 * i, 0.02, -0.03 * i], LeftUpperLeg: [-0.2 * i, 0, 0.1], __hipsD: [0.4 * i, -1 + 0.2 * i, -0.3 * i],
        __rootY: [y * D, 0, 0], __rootP: [1.5 * i, 0, -2 * i], __swing: [i % 2, (i + 1) % 2, 0] }),
    })),
  };
}
const worldPos = (h: Humanoid, nm: string): THREE.Vector3 => h.bones.get(nm)!.getWorldPosition(new THREE.Vector3());
const worldQuat = (h: Humanoid, nm: string): THREE.Quaternion => h.bones.get(nm)!.getWorldQuaternion(new THREE.Quaternion());
/** Манекен редактора: риг под шарниром корня (как `rootTurn` → `human.root`). */
function underPivot(): { h: Humanoid; pivot: THREE.Group } {
  const h = buildHumanoid(), pivot = new THREE.Group(), scene = new THREE.Scene();
  scene.add(pivot); pivot.add(h.root);
  return { h, pivot };
}

describe('сэмплер корня — тот же, что у игры', () => {
  for (const interp of [undefined, 'smooth', 'ease'] as const) {
    it(`⭐ рыск = turnYawAt на любом времени (${interp ?? 'linear'}), на ключе — ровно канал ключа`, () => {
      const c = turnClip(interp);
      for (let t = -0.1; t <= clipDur(c) + 0.1; t += 0.013) expect(rootPreviewAt(c, t, WANT).yaw).toBeCloseTo(turnYawAt(c, t), 9);
      for (const k of c.keys) {
        const v = rootPreviewAt(c, k.t, WANT);
        expect(v.yaw).toBeCloseTo(k.pose['__rootY']![0], 9);
        expect(v.x).toBeCloseTo(k.pose['__rootP']![0], 9);
        expect(v.z).toBeCloseTo(k.pose['__rootP']![2], 9);
        expect(sameRootView(v, rootViewOfPose(k.pose, WANT), 1e-9), 'призрак ключа и манекен на ключе — один корень').toBe(true);
      }
    });
  }

  it('на старте — ноль, накопленный рыск за π не сворачивается (170° → 200°, середина 185°)', () => {
    const c = turnClip();
    expect(sameRootView(rootPreviewAt(c, 0, WANT), ROOT_VIEW_ZERO)).toBe(true);
    expect(rootPreviewAt(c, 0.7, WANT).yaw / D).toBeCloseTo(185, 6);
    expect(rootPreviewAt(c, 5, WANT).yaw / D, 'за концом — последний ключ').toBeCloseTo(200, 6);
  });

  it('зеркало клипа меняет сторону поворота и X смещения', () => {
    const c = turnClip(), m: Clip = { ...c, keys: c.keys.map((k) => ({ ...k, pose: flipPose(k.pose) })) };
    for (const t of [0.05, 0.3, 0.55, 0.8]) {
      const a = rootPreviewAt(c, t, WANT), b = rootPreviewAt(m, t, WANT);
      expect(b.yaw).toBeCloseTo(-a.yaw, 9); expect(b.x).toBeCloseTo(-a.x, 9); expect(b.z).toBeCloseTo(a.z, 9);
    }
  });

  it('галки: выключенная часть — ноль; у клипа без каналов показывать нечего', () => {
    const c = turnClip();
    const y = rootPreviewAt(c, 0.5, { yaw: true, pos: false }), p = rootPreviewAt(c, 0.5, { yaw: false, pos: true });
    expect(y.yaw).not.toBe(0); expect([y.x, y.z]).toEqual([0, 0]);
    expect(p.yaw).toBe(0); expect(Math.hypot(p.x, p.z)).toBeGreaterThan(0);
    expect(sameRootView(rootPreviewAt(c, 0.5, { yaw: false, pos: false }), ROOT_VIEW_ZERO)).toBe(true);
    const plain: Clip = { name: 'idle', character: 'c', weapon: 'none', loop: true, keys: [{ t: 0, pose: P({ Spine: [0.1, 0, 0] }) }, { t: 1, pose: P({ Spine: [0.2, 0, 0] }) }] };
    expect(clipRootChannels(plain)).toEqual({ yaw: false, pos: false });
    expect(sameRootView(rootPreviewAt(plain, 0.5, WANT), ROOT_VIEW_ZERO)).toBe(true);
  });

  it('каналы клипа: флаг ИЛИ канал в ключе (флаги пишут не все пути)', () => {
    expect(clipRootChannels(null)).toEqual({ yaw: false, pos: false });
    expect(clipRootChannels({ ...turnClip(), rootYaw: undefined, rootPos: undefined })).toEqual({ yaw: true, pos: true });
    const onlyFlag: Clip = { name: 'x', character: 'c', weapon: 'none', loop: false, rootYaw: true, keys: [{ t: 0, pose: P({}) }] };
    expect(clipRootChannels(onlyFlag)).toEqual({ yaw: true, pos: false });
  });

  it('время показа: превью (скраб/проигрывание) важнее выбранного ключа; нет ни того, ни другого — null', () => {
    const c = turnClip();
    expect(rootViewTime(c, 2, null)).toBe(0.35);
    expect(rootViewTime(c, 2, 0.5)).toBe(0.5);
    expect(rootViewTime(c, 9, null)).toBeNull();
  });
});

describe('⭐ вид не течёт в запись позы', () => {
  it('поза и таз, прочитанные под шарниром (как `readPoseFull`, вместе с заземлением) — те же, что без него', () => {
    const c = turnClip();
    for (const k of c.keys) {
      const { h: a, pivot } = underPivot(), b = buildHumanoid();
      // стопы под полом — заземление правит углы голеностопа и корень, как `groundManikin` в `readPoseFull`
      const pose = { ...k.pose, __hipsD: [0, -2.5, 0] as [number, number, number] };
      poseRig(a, pose); poseRig(b, pose);
      placeRootView(pivot, rootViewOfPose(k.pose, WANT));
      for (const h of [a, b]) { h.root.updateMatrixWorld(true); groundFeet(h, h.hipsWorldY(), { off: 0 }, 1e3, () => 0, undefined, { still: true }); }
      for (const nm of a.boneNames) expect(a.bones.get(nm)!.quaternion.angleTo(b.bones.get(nm)!.quaternion), nm).toBeLessThan(1e-7);
      const ra = a.readPose(), rb = b.readPose();
      for (const nm in rb) rb[nm]!.forEach((v, i) => expect(Math.abs(ra[nm]![i]! - v), `${nm}[${i}]`).toBeLessThan(1e-9));
      expect(a.hips.position.distanceTo(b.hips.position)).toBeLessThan(1e-9);
      expect(Math.abs(a.root.position.y - b.root.position.y)).toBeLessThan(1e-6);
      expect(a.root.quaternion.angleTo(b.root.quaternion), 'кость Root не повёрнута — рыск на шарнире').toBeLessThan(1e-12);
    }
  });

  it('контроль: тот же рыск, положенный В РИГ (кость Root), виден в чтении позы — именно поэтому шарнир', () => {
    const a = buildHumanoid(), b = buildHumanoid();
    poseRig(a, turnClip().keys[3]!.pose); poseRig(b, turnClip().keys[3]!.pose);
    a.root.rotation.y = 170 * D;
    expect(a.readPose()).not.toEqual(b.readPose());
  });
});

describe('всё видимое стоит там же, где манекен под шарниром', () => {
  const keyPose = turnClip().keys[3]!.pose;   // рыск 170°, смещение, наклон таза, __hipsD
  const view = rootViewOfPose(keyPose, WANT);

  it('⭐ призрак соседнего кадра: `Ry·Root` + смещение на его корне = манекен на том же ключе под шарниром', () => {
    const { h: man, pivot } = underPivot(); poseRig(man, keyPose); man.root.position.set(0, 0, 0); placeRootView(pivot, view);
    const ghost = buildHumanoid(); new THREE.Scene().add(ghost.root);
    poseRig(ghost, keyPose); ghost.root.position.set(0, 0, 0); composeRootView(ghost.root, view); ghost.root.updateMatrixWorld(true);
    for (const nm of man.boneNames) expect(worldPos(ghost, nm).distanceTo(worldPos(man, nm)), nm).toBeLessThan(1e-6);
  });

  it('⭐ физ-призрак: цель таза с рыском даёт те же мировые повороты костей, что у манекена; без неё — мимо на рыск', () => {
    for (const yaw of [30 * D, 100 * D, 170 * D, -135 * D, 200 * D]) {
      const { h: man, pivot } = underPivot(); poseRig(man, keyPose); placeRootView(pivot, { yaw, x: 0, z: 0 });
      const ghost = buildHumanoid(); poseRig(ghost, turnHipsTarget(man.readPose(), yaw)); ghost.root.updateMatrixWorld(true);
      let worst = 0;
      for (const nm of man.boneNames) if (nm !== 'Root') worst = Math.max(worst, worldQuat(ghost, nm).angleTo(worldQuat(man, nm)));   // корень призрака ставит физика, не поза
      expect(worst / D, `рыск ${(yaw / D).toFixed(0)}°`).toBeLessThan(0.2);   // чтение позы округлено до 1e-3 рад
      const naive = buildHumanoid(); poseRig(naive, man.readPose()); naive.root.updateMatrixWorld(true);
      expect(worldQuat(naive, 'Hips').angleTo(worldQuat(man, 'Hips')) / D).toBeGreaterThan(25);
    }
    const p = P({ Hips: [0.1, 0.2, 0.3] });
    expect(turnHipsTarget(p, 0)).toBe(p);
    expect(p['Hips']).toEqual([0.1, 0.2, 0.3]);
  });

  it('⭐ состояние правки едет за корнем: цель/полюс/стопа в кадре персонажа не меняются', () => {
    const { h, pivot } = underPivot(); poseRig(h, keyPose);
    const A: RootView = { yaw: 40 * D, x: 3, z: -5 }, B: RootView = { yaw: -150 * D, x: -7, z: 11 };
    placeRootView(pivot, A);
    const target = worldPos(h, 'LeftHand'), foot = worldQuat(h, 'LeftFoot');
    const pole = worldPos(h, 'LeftLowerLeg').sub(worldPos(h, 'LeftUpperLeg')).normalize();
    const d = rootViewDelta(A, B);
    target.applyMatrix4(d.m); foot.premultiply(d.q); pole.applyQuaternion(d.q);
    placeRootView(pivot, B);
    expect(target.distanceTo(worldPos(h, 'LeftHand'))).toBeLessThan(1e-9);
    expect(foot.angleTo(worldQuat(h, 'LeftFoot'))).toBeLessThan(1e-6);
    expect(pole.distanceTo(worldPos(h, 'LeftLowerLeg').sub(worldPos(h, 'LeftUpperLeg')).normalize())).toBeLessThan(1e-9);
    const mb = rootViewMatrix(B).elements;
    pivot.matrixWorld.elements.forEach((e, i) => expect(Math.abs(e - mb[i]!), 'шарнир = T·Ry, вокруг вертикали в начале, не вокруг таза').toBeLessThan(1e-12));
  });

  it('скачок корня для физ-призрака: скраб/галка — да, шаг проигрывания — нет', () => {
    const z = ROOT_VIEW_ZERO;
    // `sameRootView` — гейт `syncRootView`: «всегда совпадает» заморозил бы шарнир навсегда
    expect(sameRootView(z, { yaw: 1e-6, x: 0, z: 0 })).toBe(false);
    expect(sameRootView(z, { yaw: 0, x: 0, z: -1e-6 })).toBe(false);
    expect(sameRootView({ yaw: 0.5, x: 1, z: 2 }, { yaw: 0.5, x: 1, z: 2 })).toBe(true);
    expect(rootViewJump(z, { yaw: ROOT_SNAP_YAW * 1.01, x: 0, z: 0 })).toBe(true);
    expect(rootViewJump(z, { yaw: 0, x: ROOT_SNAP_POS * 1.01, z: 0 })).toBe(true);
    expect(rootViewJump(z, { yaw: 3 * D, x: 0.5, z: 0.5 })).toBe(false);
  });
});

describe('каналы движения нового/заменённого ключа — с таймлайна', () => {
  it('⭐ «+ кадр» между ключами: корень и опора засеяны, кривые клипа не поменялись', () => {
    const c = turnClip(), t = 0.47;
    const probe = [0.05, 0.2, 0.3, 0.4, 0.47, 0.5, 0.58, 0.7];
    const before = probe.map((x) => [turnYawAt(c, x), rootPreviewAt(c, x, WANT).x, turnSupportAt(c, x)[0]]);
    const fresh = seedMotionChannels(P({ Spine: [0.3, 0, 0], __hipsD: [0, -1, 0] }), c, t);
    const at = c.keys.findIndex((k) => k.t > t);
    c.keys.splice(at, 0, { t, pose: fresh });
    probe.forEach((x, i) => {
      expect(turnYawAt(c, x)).toBeCloseTo(before[i]![0] as number, 9);
      expect(rootPreviewAt(c, x, WANT).x).toBeCloseTo(before[i]![1] as number, 9);
      expect(turnSupportAt(c, x)[0]).toBe(before[i]![2]);
    });
    expect(fresh['Spine']).toEqual([0.3, 0, 0]);
  });

  it('контроль: без засева вставленный ключ роняет поворот клипа в 0 (так было)', () => {
    const c = turnClip(), t = 0.47, was = turnYawAt(c, t);
    c.keys.splice(c.keys.findIndex((k) => k.t > t), 0, { t, pose: P({ Spine: [0.3, 0, 0] }) });
    expect(was / D).toBeGreaterThan(120);
    expect(turnYawAt(c, t)).toBe(0);
  });

  it('«из пред./след.» — корень СВОЙ у ключа, а не соседа; клип без каналов не получает ничего', () => {
    const c = turnClip(), k = c.keys[2]!;
    const pulled = seedMotionChannels(structuredClone(c.keys[1]!.pose), c, k.t);
    expect(pulled['__rootY']).toEqual(k.pose['__rootY']);
    expect(pulled['__rootP']).toEqual(k.pose['__rootP']);
    expect(pulled['__swing']).toEqual(k.pose['__swing']);
    expect(pulled['LeftUpperLeg']).toEqual(c.keys[1]!.pose['LeftUpperLeg']);
    const plain: Clip = { name: 'hit', character: 'c', weapon: 'none', loop: false, keys: [{ t: 0, pose: P({}) }, { t: 1, pose: P({}) }] };
    expect(Object.keys(seedMotionChannels(P({ Spine: [0, 0, 0] }), plain, 0.5))).toEqual(['Spine']);
  });
});

describe('⭐ на запечённых поворотах корень возвращает персонажа туда, где он стоял при запекании', () => {
  // Замер разбора (все 6 пресетов): на месте — до 12.9u (45°) / 23.5u (90°) / 33.6u (180°); с корнем — 0.021u.
  const GX = { armDown: 1.35, elbowBend: 0.25 };
  const BONES = ['Hips', 'Head', 'LeftFoot', 'RightFoot', 'LeftToes', 'RightToes', 'LeftHand', 'RightHand'];
  for (const name of ['turn_R_45', 'turn_L_90', 'turn_R_180']) {
    it(name, () => {
      const spec = TURN_PRESETS.find((s) => s.name === name)!;
      const h = buildHumanoid({});
      const player = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
      const base = defaultReadPose(h), truth = new Map<string, THREE.Vector3[]>();
      let t = 0, first = true;
      const read = (): Pose => {
        if (!first) t += 1 / 60; first = false;
        h.root.updateMatrixWorld(true);
        truth.set(t.toFixed(4), BONES.map((b) => worldPos(h, b)));
        return base();
      };
      const c = bakeTurnToClip(player, h, spec, { character: 'warrior', weapon: 'none', readPose: read }).clip;
      const { h: man, pivot } = underPivot();
      let inPlace = 0, shown = 0, n = 0;
      for (const k of c.keys) {
        const tr = truth.get(k.t.toFixed(4)); if (!tr) continue;
        poseRig(man, k.pose); man.root.position.set(0, 0, 0);
        const err = (): number => Math.max(...BONES.map((b, i) => worldPos(man, b).distanceTo(tr[i]!)));
        placeRootView(pivot, ROOT_VIEW_ZERO); inPlace = Math.max(inPlace, err());
        placeRootView(pivot, rootPreviewAt(c, k.t, { yaw: true, pos: false })); shown = Math.max(shown, err());
        n++;
      }
      expect(n, 'ключи сопоставлены со снятыми кадрами').toBeGreaterThan(3);
      expect(inPlace, 'на месте — видно расхождение').toBeGreaterThan(5);
      expect(shown, `с корнем ${shown.toFixed(3)}u (на месте ${inPlace.toFixed(2)}u)`).toBeLessThan(0.1);
    }, 60_000);
  }
});

/**
 * ⭐ МИР ↔ КАДР ПЕРСОНАЖА (ревью 17.09). Проводку проверяли только регэкспами: ЧТО зовётся, а не ЧТО считается, — и семь
 * мутаций, возвращавших ровно те утечки, от которых галка защищает (забытый `invert` у точки/направления/поворота, обратная
 * матрица вместо прямой, смещение мимо, «вперёд» мира у взгляда, шарнир без `updateMatrixWorld`), проходили все тесты.
 * Теперь формулы — чистые функции `frameEdit`, и оракул здесь — матрицы самого three, а не те же формулы.
 */
describe('⭐ мир ↔ кадр персонажа: формулы против матриц three', () => {
  const VIEWS: RootView[] = [{ yaw: 90 * D, x: 7, z: -4 }, { yaw: 180 * D, x: -3, z: 11 }, { yaw: -135 * D, x: 0.5, z: 2 }, { yaw: 200 * D, x: 0, z: 0 }];
  const PTS = [new THREE.Vector3(3, 20, -8), new THREE.Vector3(-11, 1, 4.5), new THREE.Vector3(0.2, 35, 0)];
  const pivotAt = (v: RootView): THREE.Group => { const g = new THREE.Group(); new THREE.Scene().add(g); placeRootView(g, v); return g; };

  it('точка: мир → кадр = `worldToLocal` шарнира, кадр → мир = `localToWorld`, круг — тождество', () => {
    for (const v of VIEWS) {
      const g = pivotAt(v);
      for (const p of PTS) {
        const l = rootPointToLocal(p.clone(), v);
        expect(l.distanceTo(g.worldToLocal(p.clone())), 'мутации: без обращения / обратная матрица / смещение мимо').toBeLessThan(1e-9);
        expect(rootPointToWorld(p.clone(), v).distanceTo(g.localToWorld(p.clone()))).toBeLessThan(1e-9);
        expect(rootPointToWorld(l, v).distanceTo(p)).toBeLessThan(1e-9);
      }
    }
  });

  it('направление: только рыск — это разность двух точек, смещение корня в него не входит', () => {
    const d = new THREE.Vector3(1.5, -0.5, 4);
    for (const v of VIEWS) {
      const g = pivotAt(v);
      for (const p of PTS) {
        expect(rootDirToLocal(d.clone(), v).distanceTo(g.worldToLocal(p.clone().add(d)).sub(g.worldToLocal(p.clone())))).toBeLessThan(1e-9);
        expect(rootDirToWorld(d.clone(), v).distanceTo(g.localToWorld(p.clone().add(d)).sub(g.localToWorld(p.clone())))).toBeLessThan(1e-9);
      }
    }
  });

  it('поворот: локальный под шарниром ↔ мировой (`getWorldQuaternion`)', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.7));
    for (const v of VIEWS) {
      const g = pivotAt(v), child = new THREE.Object3D(); g.add(child); child.quaternion.copy(q);
      const w = child.getWorldQuaternion(new THREE.Quaternion());
      expect(rootQuatToWorld(q.clone(), v).angleTo(w)).toBeLessThan(1e-6);
      expect(rootQuatToLocal(w.clone(), v).angleTo(q), 'мутация «рыск без обращения» — поворот на 2ψ').toBeLessThan(1e-6);
    }
  });

  it('⭐ драг таза с галкой (`moveHips`): мировая дельта ручки двигает таз В МИРЕ ровно на неё; поза — как у рига без шарнира', () => {
    const v: RootView = { yaw: 90 * D, x: 6, z: -2 }, pose = turnClip().keys[2]!.pose;
    const { h: a, pivot } = underPivot(), b = buildHumanoid();
    poseRig(a, pose); poseRig(b, pose); placeRootView(pivot, v);
    const before = worldPos(a, 'Hips'), d = new THREE.Vector3(0, 0, 5);   // «вперёд» мира — на 90° это вбок персонажа
    a.hips.position.add(rootDirToLocal(d.clone(), v));                   // `rig.hipsPos` → `solveRig` → кость
    expect(worldPos(a, 'Hips').sub(before).distanceTo(d), 'таз уехал не туда, куда тянули').toBeLessThan(1e-9);
    b.hips.position.add(pivot.worldToLocal(before.clone().add(d)).sub(pivot.worldToLocal(before.clone())));   // та же правка в кадре персонажа по three
    expect(a.hips.position.distanceTo(b.hips.position)).toBeLessThan(1e-9);
    expect(a.readPose()).toEqual(b.readPose());
  });

  it('⭐ undo (`snapshot`/`restore`): снимок в кадре персонажа, корень сменился, откат — цель, стопа и полюс на ноге', () => {
    const A: RootView = { yaw: 70 * D, x: 4, z: -9 }, B: RootView = { yaw: -120 * D, x: -6, z: 3 }, pose = turnClip().keys[3]!.pose;
    const { h, pivot } = underPivot(); poseRig(h, pose); placeRootView(pivot, A);
    const ref = buildHumanoid(); poseRig(ref, pose);                    // риг без шарнира — это и есть кадр персонажа
    const pole = (x: Humanoid): THREE.Vector3 => worldPos(x, 'LeftLowerLeg').sub(worldPos(x, 'LeftUpperLeg')).normalize();
    const snap = { t: rootPointToLocal(worldPos(h, 'LeftFoot'), A), fq: rootQuatToLocal(worldQuat(h, 'LeftFoot'), A), pl: rootDirToLocal(pole(h), A) };
    expect(snap.t.distanceTo(worldPos(ref, 'LeftFoot'))).toBeLessThan(1e-9);
    expect(snap.fq.angleTo(worldQuat(ref, 'LeftFoot'))).toBeLessThan(1e-6);
    expect(snap.pl.distanceTo(pole(ref))).toBeLessThan(1e-9);
    placeRootView(pivot, B);                                            // переход на другой кадр поворота / галка
    expect(rootPointToWorld(snap.t.clone(), B).distanceTo(worldPos(h, 'LeftFoot'))).toBeLessThan(1e-9);
    expect(rootQuatToWorld(snap.fq.clone(), B).angleTo(worldQuat(h, 'LeftFoot')), 'стопа запиненной ноги повёрнута — `keepRot` унёс бы это в ключ').toBeLessThan(1e-6);
    expect(rootDirToWorld(snap.pl.clone(), B).distanceTo(pole(h))).toBeLessThan(1e-9);
  });

  it('⭐ точка взгляда при включении (`setGaze`) — перед лицом персонажа, а не мира: на развороте не за затылком', () => {
    const GAZE = 55, fwd = new THREE.Vector3(0, 0, GAZE);
    for (const v of VIEWS) {
      const { h, pivot } = underPivot(); poseRig(h, turnClip().keys[1]!.pose); placeRootView(pivot, v);
      const head = worldPos(h, 'Head'), target = head.clone().add(rootDirToWorld(fwd.clone(), v));
      expect(pivot.worldToLocal(target).sub(pivot.worldToLocal(head)).distanceTo(fwd), `рыск ${(v.yaw / D).toFixed(0)}°`).toBeLessThan(1e-9);
    }
  });

  it('шарнир стоит СРАЗУ после `placeRootView`: `human.root.updateMatrixWorld` к родителю не ходит', () => {
    const v: RootView = { yaw: 130 * D, x: -5, z: 8 };
    const { h, pivot } = underPivot(); poseRig(h, turnClip().keys[2]!.pose);
    placeRootView(pivot, v);
    h.root.updateMatrixWorld(true);                                     // как в редакторе — без `getWorldPosition` (тот обновил бы родителя сам)
    const m = rootViewMatrix(v).elements;
    pivot.matrixWorld.elements.forEach((e, i) => expect(Math.abs(e - m[i]!)).toBeLessThan(1e-12));
    const hipsW = new THREE.Vector3().setFromMatrixPosition(h.hips.matrixWorld);
    expect(hipsW.distanceTo(rootPointToWorld(h.hips.position.clone().applyMatrix4(h.root.matrix), v))).toBeLessThan(1e-9);
  });
});

describe('каналы корня без сборки позы (ревью 17.09: полная поза дважды за кадр проигрывания)', () => {
  it('⭐ `clipChannelAt` = `clipPoseAt[канал]`: ломаная, сплайн, ease, step, цикл сплайном, канал не во всех ключах, один ключ', () => {
    const base = turnClip(), sm = turnClip('smooth');
    const strip = (c: Clip, drop: (i: number) => string[]): Clip => ({ ...c, keys: c.keys.map((k, i) => { const pose = { ...k.pose }; for (const n of drop(i)) delete pose[n]; return { ...k, pose }; }) });
    const variants: Clip[] = [
      base, sm, turnClip('ease'), { ...base, keys: base.keys.map((k) => ({ ...k, interp: 'step' as const })) }, { ...sm, loop: true },
      strip(base, (i) => (i % 2 ? ['__rootY', '__rootP'] : [])), strip(sm, (i) => (i === 2 ? ['__rootY'] : i === 0 ? ['__rootP'] : [])),
      { ...base, keys: [base.keys[2]!] },
    ];
    let n = 0;
    for (const c of variants) {
      for (let u = -0.05; u <= 1.05; u += 0.0173) {
        for (const key of ['__rootY', '__rootP', '__hipsD', '__swing', '__nope']) {
          const want = clipPoseAt(c, u)[key], got = clipChannelAt(c, u, key);
          if (!want) { expect(got, `${key} @${u.toFixed(3)}`).toBeNull(); continue; }
          expect(got, `${key} @${u.toFixed(3)}`).not.toBeNull();
          want.forEach((w, j) => expect(got![j]!).toBeCloseTo(w, 12));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('`rootPreviewAt` пишет в переданный объект и не тащит прошлое значение; `rootViewDelta`/`copyRootView` — тоже без аллокаций', () => {
    const c = turnClip(), out: RootView = { yaw: 9, x: 9, z: 9 };
    expect(rootPreviewAt(c, 0.47, WANT, out)).toBe(out);
    expect(out.yaw).toBeCloseTo(turnYawAt(c, 0.47), 12);
    expect(rootPreviewAt(c, 0.47, { yaw: true, pos: false }, out)).toBe(out);
    expect([out.x, out.z]).toEqual([0, 0]);
    rootPreviewAt(c, 0.47, { yaw: false, pos: false }, out);
    expect(sameRootView(out, ROOT_VIEW_ZERO)).toBe(true);
    const d = { m: new THREE.Matrix4(), q: new THREE.Quaternion() }, v = rootPreviewAt(c, 0.6, WANT);
    expect(rootViewDelta(ROOT_VIEW_ZERO, v, d)).toBe(d);
    const shown: RootView = { yaw: 0, x: 0, z: 0 };
    expect(copyRootView(shown, v)).toBe(shown);
    expect(sameRootView(shown, v)).toBe(true);
  });
});

/**
 * ⚠⚠ ТАЗ КЛИПА ПОВОРОТА: ПОКАЗ ≠ ИГРА (ревью 17.09). Шарнир крутит таз в кадре персонажа, ветка поворота `PosePlayer` —
 * курсом в слот Y эйлера и `__hipsD` в мировых осях (разбор — `frameEdit.turnPelvisGameGap`). Игру в этом заходе не правили
 * (`poseRuntime.ts` правит параллельная работа), редактор предупреждает цифрой. Здесь обе модели привязаны к настоящим
 * `PosePlayer` и шарниру: когда игру поправят, тест упадёт и напомнит убрать предупреждение.
 */
describe('⚠ таз клипа поворота: показ ≠ игра — модели обеих сторон против настоящих `PosePlayer` и шарнира', () => {
  const GX = { armDown: 1.35, elbowBend: 0.25 };
  const bakedTurns = (): Map<string, Clip> => {
    const h = buildHumanoid({}), p = new PosePlayer(h, () => [], localStorageContent('warrior'), 'none', GX, emptyGrid());
    const lib = new Map<string, Clip>();
    for (const r of bakeTurnSet(p, h, { character: 'warrior', weapon: 'none' })) lib.set(r.clip.name, r.clip);
    return lib;
  };
  /** Правка автора на ВСЕХ ключах: наклон таза вперёд +15° и сдвиг таза на +3 по X персонажа. */
  const edited = (c: Clip): Clip => ({ ...c, keys: c.keys.map((k) => {
    const pose = { ...k.pose }, hh = pose['Hips'] ?? [0, 0, 0], hd = hipsOffset(pose) ?? [0, 0, 0];
    pose['Hips'] = [hh[0] + 15 * D, hh[1], hh[2]]; setHipsOffset(pose, [hd[0] + 3, hd[1], hd[2]]);
    return { ...k, pose };
  }) });
  interface Shot { name: string; course: number; q: THREE.Quaternion; pos: THREE.Vector3 }
  /** Стоим, прицел прыгает на `deg`; таз снимаем на ПОСЛЕДНЕМ кадре клипа поворота (вес 1, шов старта погашен). */
  const playTurn = (lib: Map<string, Clip>, deg: number): Shot | null => {
    const h = buildHumanoid({});
    const content = { ...localStorageContent('warrior'), locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; } };
    const p = new PosePlayer(h, () => [], content, 'none', GX, emptyGrid());
    setLocoMixOverride(1);
    try {
      p.setVel(0, 0); p.setYaw(0); p.snapYaw();
      for (let i = 0; i < 120; i++) p.step(1 / 60);
      p.setYaw(deg * D);
      let last: Shot | null = null;
      for (let i = 0; i < 400; i++) {
        p.step(1 / 60);
        const cn = p.turnClipName;
        if (cn) last = { name: cn, course: p.pelvisYaw, q: h.hips.quaternion.clone(), pos: h.hips.position.clone() };
        else if (last) break;
      }
      return last;
    } finally { setLocoMixOverride(null); }
  };

  it('процедурное запекание — без наклона, рыска и сдвига таза: показ = игра, предупреждения нет', () => {
    const rest = buildHumanoid({}).hipsRest;
    for (const [name, c] of bakedTurns()) {
      const g = clipTurnPelvisGap(c, rest);
      expect(g.deg, `${name}: ${g.deg.toFixed(2)}°`).toBeLessThan(TURN_GAP_DEG);
      expect(g.u, `${name}: ${g.u.toFixed(2)}u`).toBeLessThan(TURN_GAP_U);
    }
  }, 60_000);

  it('⭐ наклон +15° и сдвиг +3 на turn_R_180: игра = `turnHipsInGame`, показ = `turnHipsInView`, разница = предупреждение', () => {
    const lib = bakedTurns(), rest = buildHumanoid({}).hipsRest, ed = edited(lib.get('turn_R_180')!);
    lib.set('turn_R_180', ed);
    const r = playTurn(lib, 180);
    expect(r?.name, 'поворот сыграл клипом').toBe('turn_R_180');
    expect(Math.abs(r!.course) / D, 'снимаем на развороте').toBeGreaterThan(150);
    const pose = clipPoseAt(ed, 1);   // правка постоянна по ключам, а таз запекания нулевой (тест выше) — таз клипа на любом времени тот же
    const gq = new THREE.Quaternion(), gp = new THREE.Vector3(), vq = new THREE.Quaternion(), vp = new THREE.Vector3();
    turnHipsInGame(pose, r!.course, rest, gq, gp);
    turnHipsInView(pose, r!.course, rest, vq, vp);
    const STALE = '⚠ игра кладёт таз клипа поворота уже не так, как `frameEdit.turnHipsInGame`: поправь модель; если игра теперь '
      + 'кладёт его в кадре персонажа (как показ) — убери предупреждение в свитке клипа (`clipTurnPelvisGap`) и этот тест';
    expect(r!.q.angleTo(gq) / D, STALE).toBeLessThan(1);
    expect(Math.hypot(r!.pos.x - gp.x, r!.pos.z - gp.z), STALE).toBeLessThan(0.3);
    // показ: манекен под шарниром на том же курсе — ровно `turnHipsInView`
    const { h: man, pivot } = underPivot(); poseRig(man, pose); placeRootView(pivot, { yaw: r!.course, x: 0, z: 0 });
    expect(worldQuat(man, 'Hips').angleTo(vq) / D).toBeLessThan(0.01);
    const mw = worldPos(man, 'Hips');
    expect(Math.hypot(mw.x - vp.x, mw.z - vp.z)).toBeLessThan(1e-6);
    // разные — на столько, сколько обещает предупреждение (замер ревью: 30.0° и 6u)
    expect(gq.angleTo(vq) / D).toBeGreaterThan(25);
    expect(Math.hypot(gp.x - vp.x, gp.z - vp.z)).toBeGreaterThan(5);
    const g = turnPelvisGameGap(pose, rest);
    expect(g.deg).toBeCloseTo(30, 0);
    expect(g.u).toBeCloseTo(6, 0);
    expect(clipTurnPelvisGap(ed, rest).deg).toBeGreaterThan(TURN_GAP_DEG);
  }, 60_000);

  it('крен таза без наклона вперёд-назад — совпадает (в подсказке это обещано)', () => {
    const rest = buildHumanoid({}).hipsRest, g = turnPelvisGameGap(P({ Hips: [0, 0, 12 * D], __hipsD: [0, -1.5, 0] }), rest);
    expect(g.deg).toBeLessThan(1e-4);
    expect(g.u).toBeLessThan(1e-6);
  });
});
