/**
 * 3D-АКТЁР из примитивов + ПРОЦЕДУРНАЯ ПРУЖИННАЯ анимация («active-ragdoll»-lite, в духе FUNRUN):
 * суставы-пружины тянутся к целевой позе, поза задаётся процедурно (ходьба — синус, атака — дуга).
 * Рига: голова-сфера, торс, руки (2 цилиндра + кулак-сфера), ноги (2 цилиндра + стопа-бокс).
 * Масштаб: 1 юнит ≈ 3.1 см (TILE=32u=1 м), рост ~1.8 м.
 */
import * as THREE from 'three';

// ── Устойчивая неявная пружина (Fast & Stable springs) ──────────────────────────
interface Spring { cur: number; vel: number; target: number; freq: number; zeta: number }
function spr(freq = 4, zeta = 0.7): Spring { return { cur: 0, vel: 0, target: 0, freq, zeta }; }
function step(s: Spring, dt: number): void {
  const w = s.freq * 6.2832;               // угловая частота
  const f = 1 + 2 * dt * s.zeta * w, oo = w * w, hoo = dt * oo, hhoo = dt * hoo;
  const di = 1 / (f + hhoo);
  const x = (f * s.cur + dt * s.vel + hhoo * s.target) * di;
  const v = (s.vel + hoo * (s.target - s.cur)) * di;
  s.cur = x; s.vel = v;
}

export interface CharOpts {
  body?: number; limb?: number; head?: number;   // цвета
  scale?: number;                                 // общий масштаб (1 = ~1.8 м)
  metal?: number;                                 // «металличность» тела (броня)
  weapon?: 'sword' | 'axe' | 'mace' | 'staff' | 'none'; // оружие в правой руке
}

/** Простое оружие в кулаке (свисает вниз от кисти, свингует вместе с рукой). */
function makeWeapon(kind: string): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.4, metalness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.85 });
  if (kind === 'sword') {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(2.4, 34, 5), steel); blade.position.y = -19;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(11, 2.4, 3), steel); guard.position.y = -2;
    g.add(blade, guard);
  } else if (kind === 'axe') {
    const haft = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 32, 6), wood); haft.position.y = -14;
    const head = new THREE.Mesh(new THREE.BoxGeometry(3, 13, 11), steel); head.position.set(0, -26, 4);
    g.add(haft, head);
  } else if (kind === 'mace') {
    const haft = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 26, 6), wood); haft.position.y = -12;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(5, 0), steel); head.position.y = -26;
    g.add(haft, head);
  } else { // staff
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 46, 6), wood); shaft.position.y = -18;
    const orb = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 12), new THREE.MeshStandardMaterial({ color: 0x66aaff, emissive: 0x2a4aa0, emissiveIntensity: 0.6, roughness: 0.3 })); orb.position.y = -41;
    g.add(shaft, orb);
  }
  return g;
}

export interface ActorHandle {
  root: THREE.Group;
  /** Позиция мира (x, z=y) и желаемое направление взгляда (радианы, атан2(dz,dx)). */
  setPose(x: number, z: number, facing: number): void;
  /** 0 — стоит, >0 — идёт (доля от макс. скорости) — амплитуда/темп шага. */
  setMove(speed01: number): void;
  /** Запустить взмах атаки (0..1 — как далеко замахнуться; длительность ~0.42с). */
  attack(power?: number): void;
  /** Коллапс при смерти (оседает, конечности врастопырку). */
  setDead(dead: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

const CYL = (rt: number, rb: number, h: number) => new THREE.CylinderGeometry(rt, rb, h, 10);

/** Сустав: группа-пивот + цилиндр-кость, свисающая вниз от пивота. */
function bone(len: number, rTop: number, rBot: number, mat: THREE.Material): { pivot: THREE.Group; end: THREE.Group } {
  const pivot = new THREE.Group();
  const m = new THREE.Mesh(CYL(rTop, rBot, len), mat); m.position.y = -len / 2; pivot.add(m);
  const end = new THREE.Group(); end.position.y = -len; pivot.add(end);
  return { pivot, end };
}

export function makeCharacter(opts: CharOpts = {}): ActorHandle {
  const scale = opts.scale ?? 1;
  const matBody = new THREE.MeshStandardMaterial({ color: opts.body ?? 0x8a93ad, roughness: 0.62, metalness: opts.metal ?? 0.25 });
  const matLimb = new THREE.MeshStandardMaterial({ color: opts.limb ?? 0x6f7690, roughness: 0.7, metalness: opts.metal ?? 0.15 });
  const matHead = new THREE.MeshStandardMaterial({ color: opts.head ?? 0xd8c0a0, roughness: 0.75 });

  const root = new THREE.Group(); root.scale.setScalar(scale);

  // Таз/корень ног на высоте PELVIS; торс растёт вверх.
  const PELVIS = 30;
  // Торс.
  const torso = new THREE.Group(); torso.position.y = PELVIS; root.add(torso);
  const torsoMesh = new THREE.Mesh(new THREE.CapsuleGeometry(6.2, 12, 6, 12), matBody);
  torsoMesh.position.y = 8; torso.add(torsoMesh);
  const head = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 16), matHead);
  head.position.y = 22; torso.add(head);

  // Руки: плечо → предплечье → кулак. Плечи у верха торса.
  function arm(side: number): { sh: THREE.Group; el: THREE.Group; hand: THREE.Group } {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 7.2, 18, 0); torso.add(shoulder);
    const upper = bone(11, 2.9, 2.6, matLimb); shoulder.add(upper.pivot);
    const fore = bone(10, 2.5, 2.2, matLimb); upper.end.add(fore.pivot);
    const fist = new THREE.Mesh(new THREE.SphereGeometry(3.1, 12, 12), matBody); fist.position.y = -1; fore.end.add(fist);
    shoulder.rotation.z = side * 0.12;
    return { sh: upper.pivot, el: fore.pivot, hand: fore.end };
  }
  const aL = arm(-1), aR = arm(1);
  const wk = opts.weapon ?? 'none';
  if (wk !== 'none') aR.hand.add(makeWeapon(wk));

  // Ноги: бедро → голень → стопа. Бёдра у таза.
  function leg(side: number): { hip: THREE.Group; kn: THREE.Group } {
    const hip = new THREE.Group(); hip.position.set(side * 3.6, 0, 0); root.add(hip); hip.position.y = PELVIS;
    const thigh = bone(15, 3.6, 3.1, matLimb); hip.add(thigh.pivot);
    const shin = bone(15, 3.0, 2.5, matLimb); thigh.end.add(shin.pivot);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 11), matLimb); foot.position.set(0, -1.5, 3); shin.end.add(foot);
    return { hip: thigh.pivot, kn: shin.pivot };
  }
  const lL = leg(-1), lR = leg(1);

  // ── Пружины анимации ──
  const sp = {
    face: spr(6, 1), bobY: spr(5, 0.6), lean: spr(4, 0.7), twist: spr(6, 0.6),
    hipL: spr(6, 0.55), hipR: spr(6, 0.55), knL: spr(7, 0.6), knR: spr(7, 0.6),
    shL: spr(6, 0.5), shR: spr(6, 0.5), elL: spr(7, 0.6), elR: spr(7, 0.6),
    splay: spr(3, 0.8),
  };
  sp.face.cur = sp.face.target = 0;

  let phase = Math.random() * 6.28;
  let move = 0, facing = 0, attackT = 0, attackPow = 1, dead = false;
  const ATTACK_DUR = 0.42;

  function attackCurve(p: number): number {   // взмах правой рукой: замах назад → удар вперёд → возврат
    if (p < 0.28) return THREE.MathUtils.lerp(0, -1.1, p / 0.28);
    if (p < 0.62) return THREE.MathUtils.lerp(-1.1, 1.7, (p - 0.28) / 0.34);
    return THREE.MathUtils.lerp(1.7, 0.15, (p - 0.62) / 0.38);
  }

  const handle: ActorHandle = {
    root,
    setPose(x, z, f) { root.position.set(x, 0, z); facing = f; },
    setMove(s) { move = Math.max(0, Math.min(1.4, s)); },
    attack(power = 1) { if (!dead) { attackT = ATTACK_DUR; attackPow = power; } },
    setDead(d) { dead = d; },
    dispose() {
      root.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); });
    },
    update(dt) {
      // Плавный поворот к направлению взгляда (кратчайшая дуга).
      let df = facing - sp.face.cur; while (df > Math.PI) df -= 6.2832; while (df < -Math.PI) df += 6.2832;
      sp.face.target = sp.face.cur + df;

      if (dead) {
        sp.splay.target = 1; sp.bobY.target = -26; sp.lean.target = 1.4;
        for (const k of ['hipL', 'hipR', 'knL', 'knR', 'shL', 'shR', 'elL', 'elR'] as const) sp[k].target = (k.includes('kn') || k.includes('el')) ? 1.2 : (k.endsWith('L') ? 0.7 : -0.7);
      } else {
        const walking = move > 0.05;
        phase += (walking ? 2.2 + move * 3.2 : 1.3) * dt;
        const s = Math.sin(phase), s2 = Math.sin(phase * 2);
        const amp = walking ? 0.45 + move * 0.4 : 0;
        // Ноги: маятник + подгиб колена на заднем взмахе.
        sp.hipL.target = s * amp; sp.hipR.target = -s * amp;
        sp.knL.target = Math.max(0, -s) * amp * 1.3 + (walking ? 0.12 : 0);
        sp.knR.target = Math.max(0, s) * amp * 1.3 + (walking ? 0.12 : 0);
        // Торс: подпрыг + лёгкий наклон вперёд при беге + дыхание в покое.
        sp.bobY.target = walking ? Math.abs(s2) * 2.0 : Math.sin(phase) * 0.7;
        sp.lean.target = walking ? 0.05 + move * 0.06 : 0.02;
        sp.splay.target = 0;
        // Руки: контр-мах (если не бьём).
        if (attackT <= 0) {
          sp.shL.target = -s * amp * 0.85; sp.shR.target = s * amp * 0.85;
          sp.elL.target = 0.35 + amp * 0.2; sp.elR.target = 0.35 + amp * 0.2;
          sp.twist.target = s * amp * 0.15;
        } else {
          attackT -= dt;
          const p = 1 - attackT / ATTACK_DUR, sw = attackCurve(p) * attackPow;
          sp.shR.target = sw; sp.elR.target = 0.5 + Math.max(0, sw) * 0.7;
          sp.shL.target = -sw * 0.3; sp.elL.target = 0.35;
          sp.twist.target = sw * 0.28; sp.lean.target = 0.1 + Math.max(0, sw) * 0.1;
        }
      }

      for (const k in sp) step(sp[k as keyof typeof sp], dt);

      root.rotation.y = sp.face.cur;
      torso.position.y = PELVIS + sp.bobY.cur;
      torso.rotation.x = sp.lean.cur; torso.rotation.y = sp.twist.cur;
      aL.sh.rotation.x = sp.shL.cur; aR.sh.rotation.x = sp.shR.cur;
      aL.el.rotation.x = -sp.elL.cur; aR.el.rotation.x = -sp.elR.cur;
      lL.hip.rotation.x = sp.hipL.cur; lR.hip.rotation.x = sp.hipR.cur;
      lL.kn.rotation.x = -sp.knL.cur; lR.kn.rotation.x = -sp.knR.cur;
      // Растопырка при смерти — развести плечи/бёдра.
      const spl = sp.splay.cur;
      aL.sh.rotation.z = spl * 0.8; aR.sh.rotation.z = -spl * 0.8;
      lL.hip.rotation.z = spl * 0.5; lR.hip.rotation.z = -spl * 0.5;
    },
  };
  return handle;
}
