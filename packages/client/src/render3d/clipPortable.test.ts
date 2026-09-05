import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { clipPoseAt, type Clip, type Pose } from './clipModel.js';
import type { BodyProfile } from './bodyProfile.js';

/**
 * ИНВАРИАНТ Ф1.6: клип хранит ТОЛЬКО повороты костей — телосложение живёт отдельным каналом (BodyProfile).
 * Иначе анимация перестаёт быть переносимой: клип, записанный на «толстом высоком», не ляжет на «худого низкого»,
 * и весь смысл «редактор = источник анимаций для любого движка» рушится.
 *
 * Тест доказывает: одна и та же поза на РАЗНЫХ телосложениях даёт ОДИНАКОВЫЕ углы суставов и одинаковые НАПРАВЛЕНИЯ
 * костей — отличается только масштаб (длины звеньев). Это ровно то, что делает ретаргет в любом движке.
 */

const applyRotations = (h: Humanoid, p: Pose): void => {
  h.reset();
  for (const nm in p) { if (nm[0] === '_') continue; const b = h.bones.get(nm); if (b) b.rotation.set(p[nm]![0], p[nm]![1], p[nm]![2]); }
  h.root.updateMatrixWorld(true);
};

const POSE: Pose = {
  Spine: [0.12, 0.05, -0.03],
  Chest: [0.08, -0.1, 0.02],
  LeftUpperArm: [0.3, 0.2, -0.9],
  LeftLowerArm: [0, 0, -0.7],
  RightUpperArm: [-0.25, -0.15, 0.85],
  LeftUpperLeg: [-0.4, 0.05, 0.1],
  LeftLowerLeg: [0.8, 0, 0],
  RightUpperLeg: [0.35, -0.05, -0.1],
  __hipsP: [0, 31.2, 0.5],
};

const CLIP: Clip = {
  name: 'hit_sword', character: 'a', weapon: 'sword', loop: false,
  keys: [{ pose: { LeftUpperArm: [0, 0, -0.2] }, t: 0 }, { pose: POSE, t: 0.3 }, { pose: { LeftUpperArm: [0, 0, -0.2] }, t: 0.6 }],
};

const SLIM: BodyProfile = { height: 0.9, arm: 0.92, leg: 0.88, torso: 0.95, girth: 0.8 };
const BULK: BodyProfile = { height: 1.15, arm: 1.1, leg: 1.2, torso: 1.05, girth: 1.35 };

const dirOf = (h: Humanoid, from: string, to: string): THREE.Vector3 =>
  h.bones.get(to)!.getWorldPosition(new THREE.Vector3())
    .sub(h.bones.get(from)!.getWorldPosition(new THREE.Vector3())).normalize();

describe('переносимость клипа: телосложение — отдельный канал (Ф1.6)', () => {
  it('одна поза на разных телосложениях → ИДЕНТИЧНЫЕ локальные углы суставов', () => {
    const a = buildHumanoid({ profile: SLIM }), b = buildHumanoid({ profile: BULK });
    applyRotations(a, POSE); applyRotations(b, POSE);
    for (const nm of a.boneNames) {
      const qa = a.bones.get(nm)!.quaternion, qb = b.bones.get(nm)!.quaternion;
      expect(qa.angleTo(qb)).toBeLessThan(1e-6);
    }
  });

  it('направления костей совпадают, а длины — нет (масштаб, а не искажение позы)', () => {
    const a = buildHumanoid({ profile: SLIM }), b = buildHumanoid({ profile: BULK });
    applyRotations(a, POSE); applyRotations(b, POSE);
    for (const [f, t] of [['LeftUpperArm', 'LeftLowerArm'], ['LeftLowerArm', 'LeftHand'], ['LeftUpperLeg', 'LeftLowerLeg']] as const) {
      expect(dirOf(a, f, t).angleTo(dirOf(b, f, t))).toBeLessThan(1e-4);   // куда смотрит кость — одинаково
    }
    const lenA = a.bones.get('LeftLowerArm')!.position.length();
    const lenB = b.bones.get('LeftLowerArm')!.position.length();
    expect(lenB).toBeGreaterThan(lenA * 1.05);                             // а длина — разная (это и есть телосложение)
  });

  it('клип целиком (со скрабом по времени) переносится на другое телосложение', () => {
    const a = buildHumanoid({ profile: SLIM }), b = buildHumanoid({ profile: BULK });
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = clipPoseAt(CLIP, u);
      applyRotations(a, p); applyRotations(b, p);
      for (const nm of a.boneNames) {
        expect(a.bones.get(nm)!.quaternion.angleTo(b.bones.get(nm)!.quaternion)).toBeLessThan(1e-6);
      }
    }
  });

  it('в позах клипа нет ключей телосложения (только кости + известные спец-ключи)', () => {
    const ALLOWED = new Set(['__hipsP', '__wpnMain', '__wpnOff', '__wpnMainP', '__wpnOffP', '__wpnOverride', '__lgripP', '__lgripR', '__match', '__pinKp']);
    for (const k of CLIP.keys) for (const nm in k.pose) {
      if (nm[0] === '_') expect(ALLOWED.has(nm), `неизвестный спец-ключ «${nm}» в клипе`).toBe(true);
    }
  });

  it('Root не участвует в позе как кость-анимация (позиция персонажа — не часть клипа)', () => {
    const h = buildHumanoid({});
    applyRotations(h, POSE);
    expect(h.root.name).toBe('Root');
    expect(h.root.position.lengthSq()).toBe(0);   // клип не сдвинул персонажа
  });
});
