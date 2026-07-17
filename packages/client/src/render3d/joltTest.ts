/**
 * ИЗОЛИРОВАННЫЙ СТЕНД Jolt (только для отладки, в игру не входит).
 * Собирает рэгдолл по шагам с логом на каждом этапе — чтобы поймать, какой именно вызов роняет wasm.
 * Открыть `jolt-test.html`, смотреть консоль; всё живое — в `window.__t`.
 */
import initJolt from 'jolt-physics/debug-wasm-compat';

type JoltNS = Awaited<ReturnType<typeof initJolt>>;
let J!: JoltNS;

const log = (s: string): void => { console.log('[T] ' + s); const el = document.getElementById('out'); if (el) el.textContent += s + '\n'; };
const step = <T>(name: string, fn: () => T): T => {
  log('→ ' + name);
  try { const r = fn(); log('  ok'); return r; } catch (e) { log('  ПАДЁТ: ' + (e as Error).message); throw e; }
};

const LAYER_STATIC = 0, LAYER_DOLL = 1, NUM_LAYERS = 2, BP_STATIC = 0, BP_MOVING = 1, NUM_BP = 2;

async function main(): Promise<void> {
  J = await initJolt();
  log('Jolt загружен');

  // Перехват ассертов: без него наружу летит немой abort().
  const str = (p: number): string => { let o = ''; for (let i = p; J.HEAPU8[i]; i++) o += String.fromCharCode(J.HEAPU8[i]!); return o; };
  const s = new J.JoltSettings();
  const ah = new J.AssertFailedHandlerJS();
  ah.OnAssertFailed = (expr: number, msg: number, file: number, line: number): void => {
    const t = `ASSERT: ${str(expr)} | ${str(msg)} @ ${str(file)}:${line}`;
    console.error(t); const el = document.getElementById('out'); if (el) el.textContent += t + '\n';
  };
  s.mAssertFailedHandler = ah;
  log('mMaxBodies по умолчанию = ' + s.mMaxBodies);

  const objFilter = new J.ObjectLayerPairFilterTable(NUM_LAYERS);
  objFilter.EnableCollision(LAYER_STATIC, LAYER_DOLL);
  objFilter.EnableCollision(LAYER_DOLL, LAYER_DOLL);
  const bp = new J.BroadPhaseLayerInterfaceTable(NUM_LAYERS, NUM_BP);
  bp.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(BP_STATIC));
  bp.MapObjectToBroadPhaseLayer(LAYER_DOLL, new J.BroadPhaseLayer(BP_MOVING));
  s.mObjectLayerPairFilter = objFilter;
  s.mBroadPhaseLayerInterface = bp;
  s.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bp, NUM_BP, objFilter, NUM_LAYERS);
  const jolt = step('new JoltInterface', () => new J.JoltInterface(s));
  const system = jolt.GetPhysicsSystem();
  const bi = system.GetBodyInterface();
  const TILE = 32;
  step('SetGravity', () => { const g = new J.Vec3(0, -9.81 * TILE, 0); system.SetGravity(g); J.destroy(g); });
  step('PhysicsSettings scale', () => {
    const ps = system.GetPhysicsSettings();
    ps.mSpeculativeContactDistance *= TILE; ps.mPenetrationSlop *= TILE;
    system.SetPhysicsSettings(ps);
  });

  // Пол — по косточкам: ищем, какой именно вызов роняет.
  const half = step('new Vec3(500,2,500)', () => new J.Vec3(500, 2, 500));
  log('  half = ' + half.GetX() + ',' + half.GetY() + ',' + half.GetZ());
  const rot = step('Quat.sIdentity()', () => J.Quat.prototype.sIdentity());
  log('  rot = ' + [rot.GetX(), rot.GetY(), rot.GetZ(), rot.GetW()].join(',') + ' normalized=' + rot.IsNormalized());
  const rot2 = step('new Quat(0,0,0,1)', () => new J.Quat(0, 0, 0, 1));
  log('  rot2 = ' + [rot2.GetX(), rot2.GetY(), rot2.GetZ(), rot2.GetW()].join(',') + ' normalized=' + rot2.IsNormalized());
  const shape = step('new BoxShape(half, 0.5)', () => new J.BoxShape(half, 0.5));
  const pos = step('new RVec3(0,-2,0)', () => new J.RVec3(0, -2, 0));
  const bcs = step('new BodyCreationSettings', () => new J.BodyCreationSettings(shape, pos, rot2, J.EMotionType_Static, LAYER_STATIC));
  const body = step('bi.CreateBody', () => bi.CreateBody(bcs));
  step('bi.AddBody', () => bi.AddBody(body.GetID(), J.EActivation_DontActivate));

  // ── Риг: те же кости, что в игре ──
  const B = [
    { n: 'pelvis', p: -1, a: [0, 30, 0], o: [0, 0, 0], sh: 'box', d: [5, 4, 3] },
    { n: 'torso', p: 0, a: [0, 32, 0], o: [0, 8, 0], sh: 'cap', d: [5, 5.5] },
    { n: 'head', p: 1, a: [0, 51, 0], o: [0, 5, 0], sh: 'sph', d: [5] },
    { n: 'thighL', p: 0, a: [-3.6, 30, 0], o: [0, -7.5, 0], sh: 'cap', d: [6, 3.4] },
    { n: 'shinL', p: 3, a: [-3.6, 15, 0], o: [0, -7.5, 0], sh: 'cap', d: [6, 2.9] },
  ] as const;

  const skeleton = step('Skeleton', () => {
    const sk = new J.Skeleton();
    for (const b of B) { const nm = new J.JPHString(b.n, b.n.length); sk.AddJoint(nm, b.p); J.destroy(nm); }
    log('  joints=' + sk.GetJointCount() + ' ordered=' + sk.AreJointsCorrectlyOrdered());
    return sk;
  });

  const rs = new J.RagdollSettings();
  rs.mSkeleton = skeleton;
  rs.mParts.resize(B.length);
  const keep: unknown[] = [];
  for (let i = 0; i < B.length; i++) {
    const b = B[i]!;
    step('part ' + b.n, () => {
      const part = rs.mParts.at(i);
      let inner;
      if (b.sh === 'cap') inner = new J.CapsuleShapeSettings(b.d[0]!, b.d[1]!);
      else if (b.sh === 'sph') inner = new J.SphereShapeSettings(b.d[0]!);
      else { const h = new J.Vec3(b.d[0]!, b.d[1]!, b.d[2]!); inner = new J.BoxShapeSettings(h, 0.5); J.destroy(h); }
      const off = new J.Vec3(b.o[0], b.o[1], b.o[2]);
      const idq = new J.Quat(0, 0, 0, 1);   // НЕ sIdentity(): его нельзя destroy — это общий временный объект
      const rt = new J.RotatedTranslatedShapeSettings(off, idq, inner);
      const res = rt.Create();
      log('  shape err=' + (res.HasError && res.HasError() ? res.GetError().c_str() : 'нет'));
      const shape = res.Get();
      keep.push(res, rt, inner);
      part.SetShape(shape);
      const pos = new J.RVec3(b.a[0], b.a[1], b.a[2]);
      part.mPosition = pos; part.mRotation = idq;
      part.mMotionType = i === 0 ? J.EMotionType_Kinematic : J.EMotionType_Dynamic;
      part.mObjectLayer = LAYER_DOLL;
      log('  masa: motionType=' + part.mMotionType);
      if (i > 0) {
        const c = new J.SwingTwistConstraintSettings();
        const p1 = new J.RVec3(b.a[0], b.a[1], b.a[2]), p2 = new J.RVec3(b.a[0], b.a[1], b.a[2]);
        const t1 = new J.Vec3(0, -1, 0), t2 = new J.Vec3(0, -1, 0);
        const l1 = new J.Vec3(1, 0, 0), l2 = new J.Vec3(1, 0, 0);
        c.mPosition1 = p1; c.mPosition2 = p2;
        c.mTwistAxis1 = t1; c.mTwistAxis2 = t2;
        c.mPlaneAxis1 = l1; c.mPlaneAxis2 = l2;
        c.mNormalHalfConeAngle = 0.5; c.mPlaneHalfConeAngle = 1.0;
        c.mTwistMinAngle = -0.4; c.mTwistMaxAngle = 0.4;
        // МОТОРЫ: проверяем, доходят ли записи в настройки (геттер может отдавать копию!).
        const ms = c.mSwingMotorSettings;
        ms.mSpringSettings.mMode = J.ESpringMode_FrequencyAndDamping;
        ms.mSpringSettings.mFrequency = 12;
        ms.mSpringSettings.mDamping = 1;
        ms.mMinTorqueLimit = -6e6; ms.mMaxTorqueLimit = 6e6;
        log('  мотор записан? freq=' + c.mSwingMotorSettings.mSpringSettings.mFrequency +
            ' maxTorque=' + c.mSwingMotorSettings.mMaxTorqueLimit);
        const ts = c.mTwistMotorSettings;
        ts.mSpringSettings.mMode = J.ESpringMode_FrequencyAndDamping;
        ts.mSpringSettings.mFrequency = 12; ts.mSpringSettings.mDamping = 1;
        ts.mMinTorqueLimit = -6e6; ts.mMaxTorqueLimit = 6e6;
        part.mToParent = c;
        J.destroy(p1); J.destroy(p2); J.destroy(t1); J.destroy(t2); J.destroy(l1); J.destroy(l2);
      }
      J.destroy(idq); J.destroy(off); J.destroy(pos);
    });
  }
  step('DisableParentChildCollisions', () => rs.DisableParentChildCollisions());
  step('CalculateBodyIndexToConstraintIndex', () => rs.CalculateBodyIndexToConstraintIndex());
  step('CalculateConstraintIndexToBodyIdxPair', () => rs.CalculateConstraintIndexToBodyIdxPair());
  const ragdoll = step('CreateRagdoll', () => rs.CreateRagdoll(0, 0, system));
  step('AddToPhysicsSystem', () => ragdoll.AddToPhysicsSystem(J.EActivation_Activate));
  // Ровно то, что делает игра: отпускаем настройки форм после создания тел.
  step('destroy настроек форм (как в игре)', () => { for (const o of keep) J.destroy(o); keep.length = 0; });
  step('Step x10 (без позы)', () => { for (let i = 0; i < 10; i++) jolt.Step(1 / 60, 1); });

  // Поза + ведение моторами — то, чего в игре не пережил Step.
  const pose = step('SkeletonPose', () => { const p = new J.SkeletonPose(); p.SetSkeleton(skeleton); return p; });
  step('заполнить позу покоя', () => {
    for (let i = 0; i < B.length; i++) {
      const b = B[i]!;
      const par: readonly number[] = b.p < 0 ? [0, 0, 0] : B[b.p as 0]!.a;
      const js = pose.GetJoint(i);
      js.mTranslation.Set(b.a[0] - par[0]!, b.a[1] - par[1]!, b.a[2] - par[2]!);
      js.mRotation.Set(0, 0, 0, 1);
    }
    log('  translation[1] = ' + pose.GetJoint(1).mTranslation.GetY() + ' (ждём 2)');
  });
  step('SetRootOffset + CalculateJointMatrices', () => {
    const ro = new J.RVec3(0, 0, 0); pose.SetRootOffset(ro); J.destroy(ro);
    pose.CalculateJointMatrices();
  });
  step('DriveToPoseUsingMotors', () => ragdoll.DriveToPoseUsingMotors(pose));
  step('Step x60 ПОСЛЕ ведения', () => { for (let i = 0; i < 60; i++) { ragdoll.DriveToPoseUsingMotors(pose); jolt.Step(1 / 60, 1); } });
  step('позы тел', () => {
    for (let i = 0; i < ragdoll.GetBodyCount(); i++) {
      const p = bi.GetPosition(ragdoll.GetBodyID(i));
      log(`  ${B[i]!.n}: ${p.GetX().toFixed(1)}, ${p.GetY().toFixed(1)}, ${p.GetZ().toFixed(1)}`);
    }
  });
  (window as unknown as { __t: unknown }).__t = { J, jolt, system, bi, ragdoll, rs, skeleton };
  log('ГОТОВО — стенд выжил');
}

main().catch((e) => log('ФАТАЛ: ' + (e as Error).message));
