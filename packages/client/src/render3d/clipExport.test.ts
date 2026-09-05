import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildAnimations, checkTracksResolve, nodeNames, type ExportOptions } from './clipExport.js';
import { clipManifest } from './clipToAnimation.js';
import { buildHumanoid } from './humanoid.js';
import type { Clip, Pose } from './clipModel.js';

const P = (o: Record<string, [number, number, number]>): Pose => o;
const CLIP: Clip = {
  name: 'walk_fwd', character: 'warrior', weapon: 'sword', loop: true,
  keys: [
    { pose: P({ Hips: [0, 0, 0], LeftUpperLeg: [0.4, 0, 0], RightUpperLeg: [-0.4, 0, 0], __hipsP: [0, 32, 0] }), t: 0 },
    { pose: P({ Hips: [0, 0.1, 0], LeftUpperLeg: [-0.4, 0, 0], RightUpperLeg: [0.4, 0, 0], __hipsP: [0, 31.4, 0] }), t: 0.45 },
    { pose: P({ Hips: [0, 0, 0], LeftUpperLeg: [0.4, 0, 0], RightUpperLeg: [-0.4, 0, 0], __hipsP: [0, 32, 0] }), t: 0.9 },
  ],
};

/** Модель-заглушка с CC-именами костей (как приезжает из AccuRIG). */
function ccSkeleton(): { root: THREE.Object3D; boneMap: Record<string, string> } {
  const root = new THREE.Object3D(); root.name = 'CC_Base_BoneRoot';
  const hip = new THREE.Object3D(); hip.name = 'CC_Base_Hip'; root.add(hip);
  const lt = new THREE.Object3D(); lt.name = 'CC_Base_L_Thigh'; hip.add(lt);
  const rt = new THREE.Object3D(); rt.name = 'CC_Base_R_Thigh'; hip.add(rt);
  return { root, boneMap: { Root: 'CC_Base_BoneRoot', Hips: 'CC_Base_Hip', LeftUpperLeg: 'CC_Base_L_Thigh', RightUpperLeg: 'CC_Base_R_Thigh' } };
}

const opt = (o: Partial<ExportOptions> = {}): ExportOptions => ({ profile: 'canon', ...o });

describe('clipExport — резолв дорожек в узлы', () => {
  it('канон-манекен + канон-имена: всё резолвится', () => {
    const h = buildHumanoid({});
    expect(checkTracksResolve(h.root, buildAnimations([CLIP], opt()))).toEqual([]);
  });

  it('ГРАБЛЯ: чужие имена дорожек на канон-скелете → дорожки потеряются (детектится ДО экспорта)', () => {
    const h = buildHumanoid({});
    const lost = checkTracksResolve(h.root, buildAnimations([CLIP], opt({ profile: 'ue5' })));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.join(' ')).toContain('pelvis');   // узла `pelvis` в нашем манекене нет
  });

  it('модель с CC-именами + профиль model: резолвится по её boneMap', () => {
    const { root, boneMap } = ccSkeleton();
    const lost = checkTracksResolve(root, buildAnimations([CLIP], opt({ profile: 'model', boneMap })));
    expect(lost).toEqual([]);
  });

  it('модель с CC-именами + канон-имена дорожек → потеря (нужен профиль model)', () => {
    const { root, boneMap } = ccSkeleton();
    const lost = checkTracksResolve(root, buildAnimations([CLIP], opt({ profile: 'canon', boneMap })));
    expect(lost.length).toBeGreaterThan(0);
  });

  it('nodeNames собирает именованные узлы скелета', () => {
    const h = buildHumanoid({});
    const n = nodeNames(h.root);
    expect(n.has('Root')).toBe(true); expect(n.has('Hips')).toBe(true); expect(n.has('LeftFoot')).toBe(true);
  });
});

describe('clipExport — состав дорожек', () => {
  it('на каждую кость клипа дорожка + дорожка таза', () => {
    const names = buildAnimations([CLIP], opt())[0]!.tracks.map((t) => t.name).sort();
    expect(names).toEqual(['Hips.position', 'Hips.quaternion', 'LeftUpperLeg.quaternion', 'RightUpperLeg.quaternion']);
  });

  it('несколько клипов → несколько анимаций с их именами', () => {
    const other: Clip = { ...CLIP, name: 'run_fwd' };
    const anims = buildAnimations([CLIP, other], opt());
    expect(anims.map((a) => a.name)).toEqual(['walk_fwd', 'run_fwd']);
  });
});

describe('clipExport — манифест', () => {
  it('запечённая локомоция помечается как locomotion, а не other', () => {
    for (const n of ['idle', 'walk_fwd', 'walk_back', 'run_fwd', 'run_diag_FL', 'strafe_L']) {
      expect(clipManifest({ ...CLIP, name: n }).kind, n).toBe('locomotion');
    }
  });
  it('авторские клипы сохраняют свой вид', () => {
    expect(clipManifest({ ...CLIP, name: 'idle_sword' }).kind).toBe('idle');
    expect(clipManifest({ ...CLIP, name: 'hit_axe' }).kind).toBe('hit');
    expect(clipManifest({ ...CLIP, name: 'плащ_взмах' }).kind).toBe('other');
  });
});
