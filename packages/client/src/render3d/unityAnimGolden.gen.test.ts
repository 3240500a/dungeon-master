/**
 * ПРОДЮСЕР golden-эталона G1 «РАЗБОР КОНТЕНТА АНИМАЦИИ» для Unity-клиента (шаг U4a). На каждом `npm test` перегенерирует
 * `__golden__/unity_anim_g1.json` из ТЕКУЩЕГО кода веба. Unity портирует ровно то, что игра веба делает с `GET /api/pose`
 * до позирования (`localStorageContent` → `PosePlayer`), и эталон фиксирует, как это сделал веб
 * (`Assets/DM/PoseEditor/Tests/AnimContentCheck.cs`, меню DM ▸ Verify Anim Content):
 *  • `stores` — содержимое `/api/pose`, на котором всё считается: `stand` — ответ тестового стенда как есть (закреплён в
 *    `__golden__/unity_anim_content.json`, база `dungeon_test`), `rich` — тот же ответ плюс шесть клипов мокапа Kubold и
 *    синтетика под все ветки правил (`pe_anim` с привязками/предметами/состояниями/вставками, `pe_attacks`, `pe_layers`,
 *    живые многоключевые стойки, метки, секции цикла, легаси-имена и легаси-таз, пальцы, дубли троек);
 *  • `names` — `migratePoseName`, `baseWeapon`, `weaponChain`, `retargetClipName`, `splitHands`, `offSlotKey`,
 *    `isTwoHanded`, имена стоек и набора хода (`defaultStanceName`, `stanceNameCandidates`, `locoClipName(s)`,
 *    `BASE_GAIT_CHAR`, `BASE_LOCO_WEAPON`), `findLocoClip` на списке; `collate` — сортировка `localeCompare` (ей сортируются
 *    удары по конвенции имён);
 *  • `animCfg` — `readAnimCfg` (`pe_anim`): имя стойки и кандидаты, вид/рука/сила предмета, состояния, вставки, расписание;
 *  • `pickAttack` — очередь ударов с заданной последовательностью случайных чисел;
 *  • `layers` — `readLayerStore` / `lookupLayers` / `resolveLayers` (`pe_layers` + легаси `pe_sway`);
 *  • `clips` — модель клипа: поза по фазе (`clipPoseAt`), канал (`clipChannelAt`), таз (`hipsOffset`),
 *    секции (`clipSections`), метки (`markSec`, `impactSec`, `comboWindow`, `marksInRange`, `loopMarksInRange`, `hasMark`),
 *    `fingersAnimated`, поля клипа и `blendTwo`;
 *  • `stance` — `composeStance`, `asOffHandPose`, `stancePoseAt`, `resolveStancePose` (таблица поз, живая база, вставки, трасса рук);
 *  • `content` — НАСТОЯЩИЙ `localStorageContent` над каждым хранилищем для игрока, монстра (донор `warrior`) и чужого класса:
 *    `resolveUpper` (стойка под экипировку, бой, время живой стойки, вставка), `attackClips`/`attackClip`, `stateClip`/`stateCfg`,
 *    `locoClip` (свой → донор контента → донор ХОДА), `shieldOverlay`, `clipByName`, `resolveAbilityClip`, вставки и расписание;
 *  • `chars` — реестр внешности chars3d (`buildRoster` над конфигом `classes`/`monsters` + `pe_appearance`): `charFor` (имя, пол,
 *    телосложение, оружие — им веб выбирает оружие монстра без `weaponKey` и толщину процедурной куклы), `monsterCharId`;
 *  • `morph` — телосложение `pe_morph` куклы игры: `loadMorph` (свой → донор, пустая запись — нет морфа) и `composeProfile` /
 *    `composeBoneScale` / `composeBuild` поверх пропорций модели.
 * Ссылка на клип — `[индекс в pe_clips, имя после миграции]`. Повороты — эйлер XYZ (рад), округление 1e-6.
 * Скопировать в Unity: `python tools/unity-check/golden_sync.py` (репо Unity) → Assets/DM/PoseEditor/Tests/unity_anim_g1_golden.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAnimCfg, defaultStanceName, stanceNameCandidates } from './animConfig.js';
import { pickAttack, ATTACK_VARY } from './attackPick.js';
import { readLayerStore, lookupLayers, resolveLayers, newResolvedLayers, LAYER_LEGACY_DEFAULT } from './layerWeights.js';
import { findLocoClip, locoClipName, locoClipNames, LOCO_DIRS, BASE_GAIT_CHAR, BASE_LOCO_WEAPON } from './locoBlend.js';
import {
  TWO_HANDED, isTwoHanded, splitHands, offSlotKey, composeStance, asOffHandPose, stancePoseAt, resolveStancePose,
  ARM_MAIN_MASK, ARM_OFF_MASK, UPPER_ALL_MASK, type PoseLayer, type StanceLayerInfo, type LayerKind,
} from './poseLayers.js';
import { fullMask, type BoneMask } from './boneMask.js';
import {
  blendTwo, clipPoseAt, clipChannelAt, hipsOffset, clipSections, markSec, impactSec, comboWindow,
  marksInRange, loopMarksInRange, hasMark, fingersAnimated, clipDur, type Clip, type Pose, type Mark, type MarkType,
} from './clipModel.js';
import { localStorageContent, migratePoseName, baseWeapon, weaponChain, retargetClipName, loadMorph } from './poseRuntime.js';
import { buildRoster, charFor, monsterCharId } from './chars3d.js';
import { composeProfile, composeBuild, composeBoneScale } from './bodyMorph.js';
import type { BodyProfile, BoneScale } from './bodyProfile.js';
import type { BuildScale } from './humanoid.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP = JSON.parse(readFileSync(join(HERE, '__golden__', 'unity_anim_content.json'), 'utf8')) as {
  stand: Record<string, unknown>; mocap: RawClip[];
};

type Key = { t: number; pose: Pose; interp?: string; ease?: number[]; marks?: Mark[] };
type RawClip = { name: string; character: string; weapon: string; loop: boolean; keys: Key[]; [k: string]: unknown };
type Store = Record<string, unknown> & { pe_clips: RawClip[] };

const r6 = (x: number): number => { const v = Math.round(x * 1e6) / 1e6; return Object.is(v, -0) ? 0 : v; };
/** Округление поз эталона: 1e-5 рад — в пять раз мельче допуска проверки Unity (2e-5), а эталон вдвое легче. */
const r5 = (x: number): number => { const v = Math.round(x * 1e5) / 1e5; return Object.is(v, -0) ? 0 : v; };
const r3 = (x: number): number => Math.round(x * 1e3) / 1e3;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Поза для эталона: ключи в порядке вставки, тройки с округлением. */
const P = (p: Pose | null | undefined): Record<string, number[]> | null => {
  if (!p) return null;
  const o: Record<string, number[]> = {};
  for (const k in p) { const v = p[k]!; o[k] = [r5(v[0]), r5(v[1]), r5(v[2])]; }
  return o;
};
const V3 = (v: readonly number[] | null | undefined): number[] | null => (v ? [r5(v[0]!), r5(v[1]!), r5(v[2]!)] : null);

// ── Синтетика ────────────────────────────────────────────────────────────────────────────────────
const BODY = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'];
/** Детерминированная поза: углы до ±amp (рад), три знака после запятой — как у живых данных. */
function syn(seed: number, bones: readonly string[] = BODY, amp = 0.6): Pose {
  const p: Pose = {};
  bones.forEach((b, i) => { p[b] = [r3(Math.sin(seed * 1.7 + i * 0.91) * amp), r3(Math.cos(seed * 0.83 + i * 1.37) * amp * 0.7), r3(Math.sin(seed * 2.3 + i * 0.53) * amp * 0.5)]; });
  return p;
}
const withX = (p: Pose, extra: Pose): Pose => ({ ...p, ...extra });
const clip = (name: string, character: string, weapon: string, keys: Key[], extra: Record<string, unknown> = {}): RawClip =>
  ({ name, character, weapon, loop: false, keys, ...extra });
const k = (t: number, pose: Pose, more: Partial<Key> = {}): Key => ({ t, pose, ...more });
const FING = ['LeftIndexProximal', 'LeftIndexIntermediate', 'RightThumbDistal', 'RightLittleProximal'];

function richStore(): Store {
  const stand = clone(SNAP.stand) as Store;
  const mc = (n: string): RawClip => clone(SNAP.mocap.find((c) => c.name === n)!);
  const as = (c: RawClip, name: string, character: string, weapon: string, extra: Record<string, unknown> = {}): RawClip =>
    ({ ...c, name, character, weapon, ...extra });
  const clips: RawClip[] = [...stand.pe_clips];
  // Живые стойки: мокап-айдл 8 ключей — безоружная база воина по привязке; боевая — сплайн-цикл; у мага — ease с ручками.
  clips.push(as(mc('idle'), 'idle_none_relax', 'warrior', 'none'));
  clips.push(clip('idle_none_incombat', 'warrior', 'none', [
    k(0, withX(syn(11), { __hipsD: [0, -1.2, 0.3] }), { interp: 'smooth' }),
    k(0.9, withX(syn(12, BODY, 0.5), { __hipsD: [0.4, -1.5, 0.1] }), { interp: 'smooth' }),
    k(1.7, withX(syn(13, BODY, 0.55), { __hipsD: [-0.2, -1.1, 0.2], __swing: [1, 0, 0], __rootY: [0.3, 0, 0] }), { interp: 'smooth' }),
    k(2.4, withX(syn(11), { __hipsD: [0, -1.2, 0.3] }), { interp: 'smooth' }),
  ], { loop: true }));
  clips.push(clip('idle_sword_custom', 'warrior', 'sword', [k(0, withX(syn(21), { __wpnMain: [-1.571, 0.1, 0], __wpnMainP: [0.2, -1, 0.5] }))]));
  clips.push(clip('combat_idle_sword', 'warrior', 'sword', [k(0, withX(syn(22), { __wpnMain: [-1.2, 0, 0.3] }))]));
  clips.push(clip('idle_staff_live', 'mage', 'none', [
    k(0, syn(31), { interp: 'ease', ease: [0.2, 0.1, 0.3, 1] }),
    k(1.25, syn(32), { interp: 'ease' }),
    k(2.5, syn(33), { interp: 'step' }),
    k(3.1, syn(31)),
  ], { loop: true }));
  clips.push(clip('idle_staff', 'mage', 'staff', [k(0, withX(syn(34), { __wpnMain: [-1.4, 0.2, 0.1] }))]));
  clips.push(clip('idle_torch', 'warrior', 'torch', [k(0, withX(syn(41), { __wpnMain: [0.3, 0.2, 0.1], __wpnMainP: [1, 2, 3] }))]));
  clips.push(clip('idle_dagger_grip', 'warrior', 'dagger', [
    k(0, withX(syn(42), { LeftIndexProximal: [0.1, 0, 0], RightThumbDistal: [0.2, 0.1, 0] })),
    k(0.8, withX(syn(43), { LeftIndexProximal: [0.6, 0, 0], RightThumbDistal: [0.2, 0.1, 0] })),
  ], { loop: true }));
  clips.push(clip('idle_axe_fingers', 'warrior', 'axe', [
    k(0, withX(syn(44), { RightLittleProximal: [0.3, 0.1, 0] })), k(0.5, withX(syn(45), { RightLittleProximal: [0.3, 0.1, 0] })),
  ]));
  clips.push(clip('idle_spear', 'warrior', 'spear', [k(0, syn(46))]));   // дубль тройки стенда: читается ПЕРВЫЙ
  // Набор хода: мокап под `none`, перекрытие бега под мечом, легаси-страйф у монстра.
  for (const n of ['walk_fwd', 'turn_R_90']) clips.push(as(mc(n), n, 'warrior', 'none'));
  // Остальной набор нужен только как «какой клип ответил» — берём первые ключи, эталон легче.
  for (const n of ['run_fwd', 'walk_strafe_L', 'run_back']) { const c = mc(n); clips.push(as({ ...c, keys: c.keys.slice(0, 4) }, n, 'warrior', 'none')); }
  clips.push(clip('run_fwd', 'warrior', 'sword', [k(0, syn(51)), k(0.4, syn(52))], { loop: true, bakeSpeed: 120, bakeRev: 3, upperPure: true }));
  clips.push(clip('strafe_R', 'undead', 'none', [k(0, syn(53)), k(0.5, syn(54))], { loop: true, bakeSpeed: 'fast', bakeRev: 2 }));
  clips.push(clip('walk_fwd_alt', 'warrior', 'none', [k(0, syn(55)), k(0.6, syn(56))], { loop: true, bakeSpeed: -3 }));
  clips.push(clip('run_fwd_sect', 'warrior', 'none', [
    k(0, withX(syn(61), { __hipsD: [0, -2, 0] })),
    k(0.2, syn(62), { marks: [{ type: 'loop_start' }, { type: 'footstep', foot: 'L' }] }),
    k(0.5, withX(syn(63), { __hipsD: [0.5, -1, 0] }), { marks: [{ type: 'footstep', foot: 'R' }] }),
    k(0.8, syn(64), { marks: [{ type: 'footstep', foot: 'L', sfx: 'step_l' }] }),
    k(1.1, syn(65), { marks: [{ type: 'loop_end' }] }),
    k(1.4, withX(syn(66), { __hipsD: [0, -3, 0.5] })),
  ], { loop: true }));
  // Удары: метки, ворота серии, сортировка по конвенции.
  clips.push(clip('hit_sword_a', 'warrior', 'sword', [
    k(0, syn(71), { marks: [{ type: 'windup' }] }),
    k(0.15, syn(72), { marks: [{ type: 'swing', dur: 0.15, sfx: 'whoosh' }] }),
    k(0.3, syn(73), { marks: [{ type: 'impact', sfx: 'hit_metal', vfx: 'spark' }, { type: 'combo', dur: 0.2 }, { type: 'camshake', num: 0.6 }] }),
    k(0.65, syn(74), { marks: [{ type: 'recover' }] }),
  ]));
  clips.push(clip('hit_sword_b', 'warrior', 'sword', [
    k(0, syn(75)), k(0.2, syn(76), { marks: [{ type: 'impact' }, { type: 'combo' }] }), k(0.55, syn(77)),
  ]));
  clips.push(clip('hit_sword_c', 'warrior', 'sword', [k(0, syn(78)), k(0.4, syn(79))]));
  for (const n of ['hit_axe_2', 'hit_axe_10', 'hit_Axe_b', 'hit_axe_a', 'hit_axe+x', 'hit_axe-y', 'hit_axe_A', 'hit_axe_.z'])
    clips.push(clip(n, 'warrior', 'axe', [k(0, syn(80 + n.length)), k(0.3, syn(81))]));
  clips.push(clip('удар_staff', 'mage', 'staff', [k(0, syn(91)), k(0.3, syn(92))]));
  clips.push(clip('hit_staff_2', 'mage', 'staff', [k(0, syn(93)), k(0.35, syn(94))]));
  clips.push(clip('стойка_axe', 'mage', 'axe', [k(0, syn(95))]));
  clips.push(clip('hit_bow', 'undead', 'bow', [k(0, syn(96)), k(0.5, syn(97))]));
  clips.push(clip('s_hit_sword', 'warrior', 'sword', [k(0, syn(98)), k(0.4, syn(99))]));
  clips.push(clip('s_hit_axe', 'warrior', 'axe', [k(0, syn(100)), k(0.4, syn(101))]));
  // Состояния и вставки.
  clips.push(clip('stagger_a', 'warrior', 'none', [k(0, syn(111)), k(0.45, syn(112))]));
  clips.push(clip('kd_fall', 'warrior', 'none', [k(0, syn(113)), k(0.7, withX(syn(114), { __hipsD: [0, -20, 4] }))]));
  clips.push(clip('getup', 'warrior', 'none', [k(0, syn(115)), k(0.9, syn(116))]));
  clips.push(clip('fidget_shift', 'warrior', 'none', [
    k(0, withX(syn(121), { __swing: [1, 0, 0], __rootY: [0.2, 0, 0], __rootP: [1, 0, 2] })), k(0.6, syn(122)), k(1.5, syn(123)),
  ]));
  clips.push(clip('fidget_wave', 'warrior', 'none', [k(0, syn(124)), k(1.1, syn(125))]));
  clips.push(clip('fidget_spin', 'warrior', 'sword', [k(0, withX(syn(126), { __wpnMain: [0.5, 1, 0] })), k(0.9, withX(syn(127), { __wpnMain: [2.5, -1, 0.3] }))]));
  clips.push(clip('fidget_one', 'warrior', 'none', [k(0, syn(128))]));
  // Модель клипа: легаси-таз, все формы интервала, сплайн-цикл.
  clips.push(clip('hips_legacy', 'warrior', 'none', [
    k(0, withX(syn(131), { __hipsP: [0.5, 31.2, -0.4], __match: [0.8, 0, 0] })),
    k(0.5, withX(syn(132), { __hipsP: [-0.5, 33.6, 0.4], __match: [0.2, 0, 0] })),
    k(1, withX(syn(133), { __hipsD: [0, 1, 0] })),
  ]));
  clips.push(clip('interp_mix', 'warrior', 'none', [
    k(0, withX(syn(141), { __hipsD: [0, 0, 0] }), { interp: 'ease', ease: [0.1, 0.7, 0.4, 0.95] }),
    k(0.3, withX(syn(142), { __hipsD: [1, -1, 0] }), { interp: 'step' }),
    k(0.55, withX(syn(143), { __hipsD: [2, 0, 1] }), { interp: 'smooth' }),
    k(0.9, withX(syn(144), { __hipsD: [0, 2, 1], __rootY: [1.2, 0, 0] }), { interp: 'smooth' }),
    k(1.2, withX(syn(145), { __hipsD: [-1, 0, 0], __rootY: [2.6, 0, 0] }), { interp: 'fixed' }),
    k(1.6, withX(syn(146), { __hipsD: [0, 0, 0], __rootY: [3.3, 0, 0] }), { interp: 'ease' }),
    k(1.6, syn(147)),
  ]));
  clips.push(clip('interp_loop', 'warrior', 'none', [
    // Метки секций на КРАЯХ клипа: начало цикла на нуле — разгона нет, конец цикла на последнем ключе — остановки нет.
    k(0, withX(syn(151), { __hipsD: [0, -1, 0] }), { interp: 'smooth', marks: [{ type: 'loop_start' }] }),
    k(0.4, withX(syn(152), { __hipsD: [1, -2, 0], LeftIndexProximal: [0.3, 0, 0] }), { interp: 'smooth' }),
    k(0.9, withX(syn(153), { __hipsD: [0, -3, 1] }), { interp: 'smooth' }),
    k(1.2, withX(syn(151), { __hipsD: [0, -1, 0] }), { interp: 'smooth', marks: [{ type: 'loop_end' }] }),
  ], { loop: true, rootYaw: true, rootPos: false, bakeSrc: 'mocap', hipsYawDeg: 12.5, hipsYawW: [0.5, 0.3, 0.2], bakeId: 20261001 }));
  return {
    ...stand,
    pe_clips: clips,
    pe_anim: {
      warrior: {
        base: {
          idle: 'idle_none_relax', combatIdle: 'idle_none_incombat',
          fidgets: ['fidget_shift', { clip: 'fidget_wave', weight: 2, blend: 0.4 }, { clip: '' }, { clip: 'fidget_one', weight: 0 }, 'fidget_shift', 7],
          combatFidgets: [],
          idleBreak: { after: 8, gapMin: 30, gapMax: 20, blend: -1 },
        },
        items: {
          sword: { kind: 'additive', hand: 'main', weight: 0.8, idle: 'idle_sword_custom', fidgets: ['fidget_spin', 'fidget_shift', { clip: 'fidget_one', weight: 0.5 }] },
          shield: { weight: 0.6 },
          torch: { hand: 'off', kind: 'override' },
          dagger: { idle: 'idle_dagger_grip', weight: 1.7, hand: 'left' },
          staff: { kind: 'bogus', weight: -0.5 },
          bow: [],
          mace: 'junk',
        },
        states: {
          stagger: 'stagger_a',
          knockdown_fall: { clip: 'kd_fall', priority: 5, interruptible: false, blendSec: 0.2, legs: 'always', next: ['getup', 3] },
          getup: { legs: 'never', blendSec: -1, priority: 'x' },
          walk_fwd: 'walk_fwd_alt', run_fwd: '', bad: 42,
        },
      },
      mage: { base: { idle: 'idle_staff_live', fidgets: [{ clip: 'fidget_shift', blend: 0 }] }, items: { staff: { kind: 'additive', weight: 0.5 } } },
      rogue: 'не объект',
    },
    pe_attacks: {
      ...(stand.pe_attacks as Record<string, unknown>),
      warrior: { ...((stand.pe_attacks as Record<string, Record<string, unknown>>).warrior), sword: ['hit_sword_b', 'hit_sword_a', 'missing_hit', 5], axe: [], 'sword+shield': [], mace: 'x' },
      mage: { staff: ['hit_staff_2'] },
      undead: { axe: ['hit_axe_2'] },
    },
    pe_layers: {
      warrior: {
        none: { walk: { chest: 0.3, head: 0.9 }, run: { chest: 1.4, head: 'x' }, combat: { run: { head: 0.1 } } },
        'sword+shield': { walk: { chest: 0.45 } }, axe: 'junk', sword: { combat: { walk: {} } },
      },
      undead: { bow: { run: { chest: 0.05 } } },
    },
    pe_sway: { ...(stand.pe_sway as Record<string, unknown>), mage: { staff: 0.7, none: 2 }, undead: {} },
    pe_shield: { warrior: { mix: 0.75, perWeapon: { 'sword+shield': 0.5 } }, mage: { mix: 0.3 } },
  };
}

// ── localStorage веба — из хранилища ─────────────────────────────────────────────────────────────
/**
 * Клипы уходят в «localStorage» с меткой индекса `__gi`: контент веба читает их из JSON заново (объекты новые), а
 * эталону нужна ссылка «какой клип хранилища ответил». Лишнее поле рантайм не читает (клип копируется спредом).
 */
const GI = '__gi';
function useStore(s: Store): void {
  const body = (key: string): unknown => (key === 'pe_clips' ? s.pe_clips.map((c, i) => ({ ...c, [GI]: i })) : s[key]);
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (key in s && s[key] !== undefined ? JSON.stringify(body(key)) : null),
    setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as unknown as Storage;
}
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });

const WEAPONS = ['none', 'sword', 'axe', 'sword+shield', 'axe+shield', 'none+shield', 'shield', 'sword+dagger', 'dual', 'greatsword',
  'staff', 'bow', 'torch', 'mace+shield', 'spear+shield', 'axe+dagger', 'dagger', 'spear', 'нет_такого'];
const LIVE_WEAPONS = ['none', 'sword', 'sword+shield', 'none+shield', 'staff', 'torch', 'greatsword', 'dagger', 'axe+torch'];
const LIVE_T: [number, number][] = [[0, 0.37], [0.6, 5.3], [0, 13.9], [0.6, 13.9]];

describe('эталон G1 разбора контента анимации для Unity', () => {
  it('пишет __golden__/unity_anim_g1.json', () => {
    const stores: Record<string, Store> = { stand: clone(SNAP.stand) as Store, rich: richStore() };
    /**
     * `rich` в эталоне — НАЛОЖЕНИЕМ на `stand` (его клипы — префикс `pe_clips`, ключи верхнего уровня — подмена целиком):
     * копировать ответ стенда второй раз незачем. Unity собирает хранилище обратно тем же правилом.
     */
    const standClips = stores.stand!.pe_clips.length;
    const richOut: Record<string, unknown> = { base: 'stand', clipsFrom: standClips };
    for (const [kk, v] of Object.entries(stores.rich!)) {
      if (kk === 'pe_clips') richOut[kk] = (v as RawClip[]).slice(standClips);
      else if (JSON.stringify(v) !== JSON.stringify(stores.stand![kk])) richOut[kk] = v;
    }
    expect(JSON.stringify(stores.rich!.pe_clips.slice(0, standClips))).toBe(JSON.stringify(stores.stand!.pe_clips));

    // ── имена ──
    const NAMES = ['стойка_axe', 'удар_sword', 'idle_axe', 'hit_bow', 's_hit_axe', 'стойка', 'удар_', 'xстойка_axe', 'combat_idle_sword', ''];
    const WK = ['sword', 'sword+shield', 'axe+dagger', 'none+shield', 'dual', 'none', 'shield', 'a+b+c', '+shield', 'x+shield+shield', ''];
    const names = {
      migrate: NAMES.map((n) => [n, migratePoseName(n)]),
      baseWeapon: WK.map((w) => [w, baseWeapon(w)]),
      weaponChain: WK.map((w) => [w, weaponChain(w)]),
      splitHands: WK.map((w) => [w, splitHands(w)]),
      offSlotKey: ['shield', 'dagger', 'none'].map((w) => [w, offSlotKey(w)]),
      twoHanded: [...TWO_HANDED],
      isTwoHanded: ['greatsword', 'sword', 'bow', 'staff', 'none', 'Greatsword'].map((w) => [w, isTwoHanded(w)]),
      retarget: [
        ['idle_sword', 'sword', 'axe'], ['combat_idle_sword', 'sword', 'mace'], ['hit_sword', 'sword', 'axe'], ['s_hit_sword', 'sword', 'bow'],
        ['hit_sword_2', 'sword', 'axe'], ['my_sword_swing_sword', 'sword', 'axe'], ['skill_x', 'sword', 'axe'], ['idle_sword', '', 'axe'],
        ['hit_sword+shield', 'sword+shield', 'sword'],
      ].map(([n, f, t]) => [n, f, t, retargetClipName(n!, f!, t!)]),
      stanceDefault: (['idle', 'combat_idle'] as const).flatMap((kd) => ['none', 'sword', 'sword+shield'].map((i) => [kd, i, defaultStanceName(kd, i), stanceNameCandidates(kd, i)])),
      locoNames: LOCO_DIRS.flatMap((d) => [false, true].map((f) => [d, f, locoClipName(d, f), locoClipNames(d, f)])),
      BASE_GAIT_CHAR, BASE_LOCO_WEAPON,
      findLoco: (() => {
        const list = [
          { name: 'run_fwd', character: 'warrior', weapon: 'axe' }, { name: 'run_fwd', character: 'warrior', weapon: 'none' },
          { name: 'run_fwd', character: 'warrior', weapon: 'sword' }, { name: 'run_fwd', character: 'mage', weapon: 'staff' },
          { name: 'run_fwd', character: 'warrior', weapon: 'none' }, { name: 'walk_fwd', character: 'warrior', weapon: 'bow' },
          { name: 'walk_fwd', character: 'warrior', weapon: 'axe' },
        ];
        const q: [string, string, string][] = [['run_fwd', 'warrior', 'sword'], ['run_fwd', 'warrior', 'bow'], ['run_fwd', 'mage', 'none'],
          ['run_fwd', 'mage', 'staff'], ['walk_fwd', 'warrior', 'none'], ['walk_fwd', 'warrior', 'axe'], ['run_back', 'warrior', 'none']];
        return { list, cases: q.map(([n, c, w]) => { const r = findLocoClip(list, n, c, w); return [n, c, w, r ? list.indexOf(r) : -1]; }) };
      })(),
    };

    // ── сортировка localeCompare (ей упорядочены удары по конвенции имён) ──
    // ⚠ Только ASCII: место кириллицы относительно латиницы зависит от локали машины (ru — раньше латиницы, корень ICU —
    // позже), и эталон с ней переставал бы совпадать сам с собой на другой машине. ASCII у всех локалей одинаков.
    const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    const COLL = [
      ['hit_sword', 'hit_sword_2', 'hit_sword_10', 'hit_sword+x', 'hit_sword-x', 'hit_Sword', 'hit_sword_a', 'hit_sword_A', 'hit_sword_B', 'hit_sword_b', 'hit_sword_.z', 'hit_sword_z'],
      ASCII, ASCII.map((c) => 'x' + c + 'y'), ASCII.map((c) => c + c.toLowerCase()),
      ['aB', 'Ab', 'ab', 'AB', 'a_b', 'a-b', 'a b', 'a', 'A', 'aa', 'a0', 'a~', 'Aa', 'aA'],
      ['hit_axe_2', 'hit_axe_10', 'hit_Axe_b', 'hit_axe_a', 'hit_axe+x', 'hit_axe-y', 'hit_axe_A', 'hit_axe_.z'],
    ];
    const collate = COLL.map((l) => [l, l.slice().sort((a, b) => a.localeCompare(b))]);

    // ── pe_anim ──
    const rawAnims: [string, unknown][] = [
      ['rich', stores.rich!.pe_anim], ['пусто', {}], ['null', null], ['строка', 'x'], ['char null', { warrior: null }],
      ['char строка', { warrior: 'x' }], ['мусор веток', { warrior: { items: [], base: 5, states: 's' } }],
    ];
    const ITEMS = ['none', 'sword', 'shield', 'torch', 'dagger', 'staff', 'bow', 'mace', 'greatsword', 'axe'];
    const STATES = ['stagger', 'knockdown_fall', 'getup', 'attack', 'walk_fwd', 'run_fwd', 'bad', 'hit_react_F'];
    const FIDGET_HANDS: string[][] = [[], ['none'], ['sword'], ['sword', 'shield'], ['dagger', 'sword'], ['none', 'none']];
    const animCfg = rawAnims.map(([label, raw]) => ({ label, raw, chars: (label === 'rich' ? [['warrior', undefined], ['mage', 'warrior'], ['undead', 'warrior'], ['rogue', 'warrior'], ['nobody', undefined]] : [['warrior', undefined], ['undead', 'warrior']])
      .map(([ch, fb]) => {
        const a = readAnimCfg(raw, ch!, fb);
        return {
          charId: ch, fallbackId: fb ?? null,
          clipName: (['idle', 'combat_idle'] as const).flatMap((kd) => ITEMS.map((i) => [kd, i, a.clipName(kd, i), a.clipNames(kd, i)])),
          item: ITEMS.map((i) => [i, a.kindOf(i), a.handOf(i) ?? null, r6(a.weightOf(i)), a.has(i)]),
          states: STATES.map((s) => [s, a.stateName(s), a.stateCfg(s)]),
          fidgets: (['idle', 'combat_idle'] as const).flatMap((kd) => FIDGET_HANDS.map((h) => [kd, h, a.fidgets(kd, h)])),
          idleBreak: a.idleBreak(),
        };
      }) }));

    // ── очередь ударов ──
    const POOLS = [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e']];
    const RNDS = [[0.1, 0.5], [0.9, 0.2], [0.33, 0.99], [0.3333, 0], [0.2, 0.999999], [0.05, 0.6]];
    const pick: unknown[] = [];
    for (const pool of POOLS) for (const last of [null, pool[0] ?? 'a', pool[pool.length - 1] ?? 'e', 'zz']) for (const vary of [0, ATTACK_VARY, 1]) for (const rnd of RNDS) {
      let used = 0;
      const out = pickAttack(pool, last, vary, () => rnd[used++] ?? 0);
      pick.push({ pool, last, vary, rnd, out, used });
    }

    // ── pe_layers ──
    const rawLayers: unknown[] = [stores.rich!.pe_layers, null, 'x', { warrior: 'x' }, { warrior: { none: 5, sword: { walk: 'x', run: { chest: -1, head: 2, other: 0.5 }, combat: 'x' }, axe: { combat: { walk: { head: 0.25 }, run: [] } } } }];
    const read = rawLayers.map((raw) => [raw, readLayerStore(raw)]);
    const lookStore = readLayerStore(stores.rich!.pe_layers);
    const SWAYS: unknown[] = [stores.rich!.pe_sway, null, { warrior: { 'sword+shield': 'x', sword: 0.4, axe: -2 } }];
    const lookup: unknown[] = [];
    for (let si = 0; si < SWAYS.length; si++) for (const [ch, fb] of [['warrior', undefined], ['undead', 'warrior'], ['mage', 'warrior'], ['warrior', 'warrior'], ['mage', undefined]] as [string, string | undefined][])
      for (const w of ['none', 'sword', 'sword+shield', 'none+shield', 'axe', 'axe+shield', 'bow', 'staff', 'staff+shield']) {
        for (const useStoreArg of [true, false]) {
          const r = lookupLayers(useStoreArg ? lookStore : null, SWAYS[si] as never, ch, w, fb);
          lookup.push({ store: useStoreArg, sway: si, charId: ch, fallbackId: fb ?? null, weapon: w, entry: r.entry, swing: r6(r.swing), source: r.source, rCharId: r.charId, rWeapon: r.weapon });
        }
      }
    const ENTRIES = [null, lookStore.warrior!.none!, lookStore.warrior!['sword+shield']!, lookStore.warrior!.sword!, lookStore.undead!.bow!,
      { walk: { chest: 0.9 }, run: { head: 0.2 }, combat: { walk: { chest: 0.1, head: 0.7 } } }];
    const resolve: unknown[] = [];
    for (const e of ENTRIES) for (const sb of [0, 0.3, 1, 1.5]) for (const c of [0, 0.5, 1]) for (const [d, hd] of [[LAYER_LEGACY_DEFAULT, 0], [0.5, 1]]) {
      const o = resolveLayers(e, sb, c, d!, hd!, newResolvedLayers());
      resolve.push({ entry: e, sb, combat: c, dflt: d, headDflt: hd, out: { chest: r6(o.chest), head: r6(o.head) } });
    }

    // ── модель клипа ──
    const rich = stores.rich!.pe_clips;
    const idxOf = (n: string, ch = 'warrior'): number => rich.findIndex((c) => c.name === n && c.character === ch);
    const CLIP_NAMES = ['idle_none_relax', 'idle_none_incombat', 'walk_fwd', 'turn_R_90', 'run_fwd_sect', 'hit_sword_a', 'hit_sword_b',
      'hips_legacy', 'interp_mix', 'interp_loop', 'idle_dagger_grip', 'idle_axe_fingers', 'fidget_shift', 'fidget_one', 'kd_fall'];
    const T01 = [0, 0.31, 0.77, 0.999, 1.4];
    const CH_KEYS = ['__hipsD', '__hipsP', '__rootY', '__rootP', '__match', '__swing', 'Hips', 'LeftUpperArm', '__wpnMain', 'нет'];
    const MARK_TYPES: MarkType[] = ['impact', 'swing', 'combo', 'windup', 'recover', 'loop_start', 'loop_end', 'footstep', 'camshake', 'sfx'];
    const RANGES: [number, number][] = [[-1e-9, 0.1], [0.05, 0.3], [0.3, 0.3], [0.2, 0.1], [0, 10], [0.14, 0.31], [0.299, 0.45], [0.49, 0.5]];
    const LOOPS: [number, number, number, number][] = [[0.9, 0.3, 0.2, 1.1], [0.1, 0.6, 0.2, 1.1], [1.0, 0.2, 0.2, 1.1], [0.5, 0.5, 0.2, 1.1], [1.05, 0.25, 0, 1.4]];
    const ev = (c: Clip, e: ReturnType<typeof marksInRange>[number]): unknown[] => {
      const ki = c.keys.findIndex((kk) => kk.marks?.includes(e.mark));
      return [ki, c.keys[ki]!.marks!.indexOf(e.mark), e.phase, r6(e.t)];
    };
    const clips = CLIP_NAMES.map((n) => {
      const i = idxOf(n); const c = rich[i] as unknown as Clip;
      expect(i, `клип ${n} есть в хранилище`).toBeGreaterThanOrEqual(0);
      return {
        i, name: n, dur: r6(clipDur(c)),
        poseAt: T01.map((t) => [t, P(clipPoseAt(c, t))]),
        channel: T01.flatMap((t) => CH_KEYS.map((key) => [t, key, V3(clipChannelAt(c, t, key))])),
        hips: c.keys.map((kk) => [V3(hipsOffset(kk.pose)), V3(hipsOffset(kk.pose, 34.5))]),
        sections: (() => { const s = clipSections(c); return { loopStart: r6(s.loopStart), loopEnd: r6(s.loopEnd), hasStart: s.hasStart, hasStop: s.hasStop }; })(),
        markSec: MARK_TYPES.map((t) => [t, markSec(c, t)]),
        hasMark: MARK_TYPES.map((t) => [t, hasMark(c, t)]),
        impact: impactSec(c), combo: comboWindow(c),
        inRange: RANGES.map(([a, b]) => [a, b, marksInRange(c, a, b).map((e) => ev(c, e))]),
        inLoop: LOOPS.map(([a, b, ls, le]) => [a, b, ls, le, loopMarksInRange(c, a, b, ls, le).map((e) => ev(c, e))]),
        fingers: fingersAnimated(c),
      };
    });
    const fields = rich.map((c, i) => {
      const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      return [i, c.name, num(c.bakeSpeed), num(c.bakeRev), c.upperPure === true, c.rootYaw === true, c.rootPos === true,
        typeof c.bakeSrc === 'string' ? c.bakeSrc : null, Array.isArray(c.hipsYawW) ? c.hipsYawW : null, num(c.hipsYawDeg),
        typeof c.idleEndsFrom === 'string' ? c.idleEndsFrom : null, c.loop === true, c.idleEnds === true, !!c.swingRef && typeof c.swingRef === 'object'];
    });
    const BLENDS: [Pose, Pose][] = [
      [syn(201, ['Hips', 'Spine', 'LeftHand']), syn(202, ['Spine', 'LeftHand', 'RightHand'])],
      [{ __hipsD: [0, -1, 2], __wpnMain: [1, 0.5, -0.2], __match: [1, 0, 0] }, { __hipsD: [1, 1, 0], __wpnMainP: [3, 2, 1], __lgripR: [0.4, 0.2, 0.1] }],
      [{ Head: [3.0, 0.1, -3.0] }, { Head: [-3.0, -0.1, 3.0] }],
      [{ Head: [0, 0, 0] }, { Head: [3.5, 0.2, 0] }],   // кватернионы в разных полушариях: slerp обязан идти короткой дугой
    ];
    const blend = BLENDS.flatMap(([a, b]) => [0, 0.25, 0.5, 1].map((t) => [a, b, t, P(blendTwo(a, b, t))]));

    // ── стойка: сборка слоями ──
    const MASKS: Record<string, BoneMask> = { main: ARM_MAIN_MASK, off: ARM_OFF_MASK, upper: UPPER_ALL_MASK, full: fullMask() };
    const base = withX(syn(301), { __hipsD: [0, -1, 0], __wpnMain: [0.1, 0.2, 0.3] });
    const itemA = withX(syn(302), { __wpnMain: [-1.5, 0, 0.2], __swing: [1, 0, 0], LeftIndexProximal: [0.4, 0, 0], Jaw: [0.2, 0, 0] });
    const itemB = withX(syn(303, BODY.slice(6, 14)), { __wpnOff: [0.3, 0.3, 0.3], __hipsD: [0.5, 0.5, 0.5] });
    const COMPOSE: { base: Pose; layers: { pose: Pose; base?: Pose; mask: string; weight: number; kind: LayerKind }[] }[] = [
      { base, layers: [{ pose: itemA, mask: 'main', weight: 1, kind: 'additive' }] },
      { base, layers: [{ pose: itemA, mask: 'main', weight: 0.4, kind: 'additive' }, { pose: itemB, mask: 'off', weight: 0.7, kind: 'additive' }] },
      { base, layers: [{ pose: itemA, base: syn(304), mask: 'full', weight: 1, kind: 'additive' }] },
      { base, layers: [{ pose: itemA, mask: 'upper', weight: 0.6, kind: 'override' }, { pose: itemB, mask: 'off', weight: 1.5, kind: 'additive' }] },
      { base, layers: [{ pose: itemB, mask: 'main', weight: 0, kind: 'additive' }, { pose: itemA, mask: 'full', weight: 1, kind: 'override' }] },
    ];
    const compose = COMPOSE.map((cs) => [cs, P(composeStance(cs.base, cs.layers.map((l): PoseLayer => ({ pose: l.pose, base: l.base, mask: MASKS[l.mask]!, weight: l.weight, kind: l.kind }))))]);
    const offHand = [itemA, { __wpnMain: [1, 2, 3], __wpnMainP: [4, 5, 6], __wpnOffP: [0, 0, 1] }, { __wpnOff: [1, 1, 1], __wpnMain: [2, 2, 2] }, {}]
      .map((p) => [p, P(asOffHandPose(p as Pose))]);
    const STANCE_CLIPS = ['idle_none_relax', 'idle_none_incombat', 'interp_loop', 'idle_sword_custom', 'fidget_one'];
    const stanceAt = STANCE_CLIPS.flatMap((n) => [0, 0.37, -2.1, 7.77, 100.3, 2.4].map((t) => [idxOf(n), t, P(stancePoseAt(rich[idxOf(n)] as unknown as Clip, t))]));
    // Резолвер стойки на ТАБЛИЦЕ поз: ключ «вид|предмет» → поза или клип (живой — по `stancePoseAt`).
    const TABLES: Record<string, Record<string, { pose?: Pose; clip?: number }>> = {
      liveBase: {
        'idle|none': { clip: idxOf('idle_none_relax') }, 'combat_idle|none': { clip: idxOf('idle_none_incombat') },
        'idle|sword': { pose: syn(311) }, 'idle|shield': { pose: syn(312) }, 'idle|none+shield': { pose: syn(313) },
        'idle|greatsword': { pose: syn(314) }, 'idle|torch': { pose: syn(315) }, 'combat_idle|sword': { pose: syn(316) },
        'idle|sword+shield': { clip: idxOf('interp_loop') }, 'idle|dagger': { pose: syn(317) },
      },
      staticBase: { 'idle|none': { pose: syn(321) }, 'idle|axe': { pose: syn(322) }, 'idle|shield': { pose: syn(323) }, 'combat_idle|axe': { pose: syn(324) } },
      noBase: { 'idle|sword': { pose: syn(331) }, 'idle|shield': { pose: syn(332) } },
    };
    const OPTS: Record<string, { weight?: Record<string, number>; kind?: Record<string, LayerKind>; hand?: Record<string, 'main' | 'off'>; live?: boolean; fidget?: { pose: Pose; scope: 'base' | 'item'; w: number } }> = {
      none: {},
      cfg: { weight: { sword: 0.8, shield: 0.6 }, kind: { torch: 'override', shield: 'override' }, hand: { torch: 'off' }, live: true },
      fidgetBase: { live: true, fidget: { pose: withX(syn(341), { __swing: [1, 0, 0], __rootY: [0.5, 0, 0], __hipsD: [0, -0.5, 0] }), scope: 'base', w: 0.6 } },
      fidgetItem: { live: true, weight: { sword: 0.5 }, fidget: { pose: withX(syn(342), { __wpnMain: [1, 1, 1] }), scope: 'item', w: 1.4 } },
      fidgetTiny: { live: true, fidget: { pose: syn(343), scope: 'base', w: 1e-5 } },
    };
    /**
     * Какие наборы опций, оружия и (бой, время) гоняем на каждой таблице: живая база — всё, прочие — их ветки.
     * ⚠ Время — НЕ на ключе клипа: ровно на ключе выбор интервала решает последний бит (у веба 0.9/2.4·2.4 = 0.8999…), и
     * состав каналов позы (союз ключей интервала) разошёлся бы с float-портом без всякой разницы в движении.
     */
    const PLAN: Record<string, { opts: string[]; weapons: string[]; ct: [number, number][] }> = {
      liveBase: { opts: ['none', 'cfg'], weapons: ['none', 'sword', 'sword+shield', 'none+shield', 'greatsword', 'torch', 'axe', 'axe+shield', 'dual', 'dagger+torch'], ct: [[0, 0], [0.4, 0.95], [1, 3.3]] },
      liveFidget: { opts: ['fidgetBase', 'fidgetItem', 'fidgetTiny'], weapons: ['none', 'sword', 'sword+shield', 'torch'], ct: [[0, 0], [0.4, 0.95], [1, 3.3]] },
      staticBase: { opts: ['none', 'cfg', 'fidgetBase'], weapons: ['none', 'axe', 'axe+shield', 'sword', 'shield', 'none+shield'], ct: [[0, 0], [1, 3.3]] },
      noBase: { opts: ['none', 'cfg'], weapons: ['sword', 'sword+shield', 'none', 'axe', 'shield'], ct: [[0, 0]] },
    };
    const stance: unknown[] = [];
    for (const [pn, plan] of Object.entries(PLAN)) for (const on of plan.opts)
      for (const w of plan.weapons)
        for (const [c, t] of plan.ct) {
          const tn = pn === 'liveFidget' ? 'liveBase' : pn, table = TABLES[tn]!, o = OPTS[on]!;
          const find = (kd: 'idle' | 'combat_idle', it: string, tt: number): Pose | null => {
            const e = table[kd + '|' + it]; if (!e) return null;
            return e.clip !== undefined ? stancePoseAt(rich[e.clip] as unknown as Clip, tt) : e.pose!;
          };
          const trace: StanceLayerInfo[] = [];
          const pose = resolveStancePose(find, w, c, {
            ...(o.weight ? { weight: (it: string) => o.weight![it] ?? 1 } : {}),
            ...(o.kind ? { kind: (it: string) => o.kind![it] ?? (isTwoHanded(it) ? 'override' : 'additive') } : {}),
            ...(o.hand ? { hand: (it: string) => o.hand![it] } : {}),
            ...(o.live ? { live: (kd: 'idle' | 'combat_idle', it: string) => { const e = table[kd + '|' + it]; return !!e && e.clip !== undefined && rich[e.clip]!.keys.length > 1; } } : {}),
            ...(o.fidget ? { fidget: o.fidget } : {}),
            trace,
          }, t);
          stance.push({ table: tn, opts: on, weapon: w, combat: c, t, pose: P(pose), trace: trace.map((l) => ({ ...l, weight: r6(l.weight) })) });
        }

    // ── контент: настоящий `localStorageContent` ──
    const ref = (_s: Store, c: Clip | null | undefined): [number, string] | null =>
      (c ? [(c as unknown as Record<string, number>)[GI]!, c.name] : null);
    const content: unknown[] = [];
    const DOLLS: Record<string, [string, string | undefined, string | undefined][]> = {
      stand: [['warrior', undefined, BASE_GAIT_CHAR], ['mage', undefined, BASE_GAIT_CHAR], ['undead', 'warrior', BASE_GAIT_CHAR], ['__none__', undefined, undefined]],
      rich: [['warrior', undefined, BASE_GAIT_CHAR], ['mage', undefined, BASE_GAIT_CHAR], ['undead', 'warrior', BASE_GAIT_CHAR], ['rogue', undefined, BASE_GAIT_CHAR], ['mage', 'warrior', 'undead']],
    };
    for (const [sn, dolls] of Object.entries(DOLLS)) {
      const s = stores[sn]!;
      useStore(s);
      for (const [ch, fb, gfb] of dolls) {
        const ct = localStorageContent(ch, fb, gfb);
        const up = (w: string, c: number, t: number, fidget: { pose: Pose; scope: 'base' | 'item'; w: number } | null = null): unknown => {
          const u = ct.resolveUpper(w, c, t, fidget);
          return [w, c, t, fidget, u ? { pose: P(u.pose), swing: r6(u.swing), layers: u.layers ?? null, main: u.hands?.main ?? null, off: u.hands?.off ?? null, clipName: u.clipName ?? null, fingers: !!u.fingersAnimated } : null];
        };
        const upper: unknown[] = [];
        // Полный перебор — у кукол со своим контентом; у доноров (монстр, чужой класс) — ветки фолбэка.
        const full = ch === 'warrior' || (ch === 'mage' && !fb);
        const ws = full ? WEAPONS : ['none', 'sword', 'sword+shield', 'bow', 'staff', 'axe'];
        for (const w of ws) for (const [c, t] of (sn === 'stand' ? [[0, 0], [0.5, 0]] : [[0, 0], [1, 2.2]]) as [number, number][]) upper.push(up(w, c, t));
        if (sn === 'rich') for (const w of full ? LIVE_WEAPONS : ['none', 'sword']) for (const [c, t] of LIVE_T) upper.push(up(w, c, t));
        if (sn === 'rich' && ch === 'warrior') {
          const fp = (nm: string, t: number): Pose => ct.fidgetPose!(nm, t)!;
          for (const w of ['none', 'sword', 'sword+shield']) {
            upper.push(up(w, 0, 1.1, { pose: fp('fidget_shift', 0.4), scope: 'base', w: 0.6 }));
            upper.push(up(w, 0.5, 3.2, { pose: fp('fidget_spin', 0.5), scope: 'item', w: 1 }));
            upper.push(up(w, 1, 0.2, { pose: fp('fidget_wave', 0.9), scope: 'base', w: 1e-5 }));
          }
        }
        const STATE_Q = ['stagger', 'knockdown_fall', 'getup', 'attack', 'walk_fwd', 'run_fwd', 'bad', 'hit_react_F', 'kd_fall'];
        const LOCO_Q: string[][] = [...LOCO_DIRS.flatMap((d) => [false, true].map((f) => locoClipNames(d, f))), ['turn_R_90'], ['run_fwd_sect', 'run_fwd'], [], ['', 'walk_fwd']];
        const ABIL: [string, string][] = [['hit_sword_a', 'sword'], ['hit_sword_a', 'axe'], ['s_hit_sword', 'axe'], ['s_hit_sword', 'axe+shield'], ['s_hit_sword', 'sword+shield'],
          ['удар_staff', 'staff'], ['удар_staff', 'bow'], ['missing', 'sword'], ['idle_sword', 'mace+shield'], ['hit_sword', 'spear+shield']];
        content.push({
          store: sn, charId: ch, fallbackId: fb ?? null, gaitFallbackId: gfb ?? null,
          upper,
          attackClips: WEAPONS.map((w) => [w, ct.attackClips(w).map((c) => ref(s, c))]),
          attackClip: WEAPONS.map((w) => [w, ref(s, ct.attackClip(w))]),
          stateClip: STATE_Q.map((st) => [st, ref(s, ct.stateClip!(st)), ct.stateCfg!(st)]),
          locoClip: LOCO_Q.flatMap((nm) => ['none', 'sword', 'axe', 'sword+shield', 'bow'].map((w) => [nm, w, ref(s, ct.locoClip!(nm, w))])),
          shieldOverlay: ['sword+shield', 'axe+shield', 'none+shield', 'mace+shield', 'spear+shield', 'sword', 'none', 'staff+shield'].map((wk) => {
            const o = ct.shieldOverlay!(wk);
            return [wk, o ? { pose: P(o.pose), mix: r6(o.mix) } : null];
          }),
          clipByName: ['idle_none', 'hit_staff', 'удар_staff', 'стойка_axe', 'idle_axe', 'idle_spear', 'fidget_shift', 'missing', 'run_fwd'].map((n) => [n, ref(s, ct.clipByName(n))]),
          ability: ABIL.map(([n, w]) => [n, w, ref(s, ct.resolveAbilityClip(n, w))]),
          fidgets: (['idle', 'combat_idle'] as const).flatMap((kd) => FIDGET_HANDS.map((h) => [kd, h, ct.fidgets!(kd, h)])),
          idleBreak: ct.idleBreak!(),
          fidgetDur: ['fidget_shift', 'fidget_one', 'fidget_spin', 'missing', 'стойка_axe'].map((n) => [n, r6(ct.fidgetDur!(n))]),
          fidgetPose: ['fidget_shift', 'fidget_one', 'fidget_wave', 'missing'].flatMap((n) => [0, 0.4, 9].map((t) => [n, t, P(ct.fidgetPose!(n, t))])),
        });
      }
    }
    expect(content.length).toBe(9);
    expect(stance.length).toBeGreaterThan(120);

    // ── реестр внешности (chars3d): конфиг классов/монстров + pe_appearance → charFor / monsterCharId ──
    const CHAR_CFG = {
      classes: [
        { id: 'warrior', name: 'Воин', startWeaponId: 'rusty_axe', startAttributes: { strength: 16, vitality: 14 } },
        { id: 'mage', startWeaponId: 'oak_staff', startAttributes: { strength: 8, vitality: 10 } },
        { id: 'newclass', name: 'Новый', startWeaponId: 'Heavy_Crossbow', startAttributes: { strength: 30, vitality: 30 } },
        { id: 'spearman', startWeaponId: 'pike_1' },
        { id: 'scholar', startWeaponId: 'Grimoire_Orb', startAttributes: { strength: 'x', vitality: 9 } },
        { name: 'без id' },
        { id: 'undead', startWeaponId: 'mace_of_bones' },
      ],
      monsters: [
        { faction: 'undead', ai: 'melee', hp: 30 }, { faction: 'undead', ai: 'ranged_caster', hp: 20 },
        { faction: 'beast', hp: 60 }, { faction: 'goblin', ai: 'ranged', hp: 10 }, { hp: 25 }, { faction: 'demon', hp: 'x' },
      ],
    };
    const CHAR_AP = { warrior: { weapon: 'sword', build: { arm: 1.3 } }, goblin: { name: 'Гоблин', weapon: 'spear' }, beast: { gender: 'female' },
      newclass: { build: { leg: 0.8, head: 1.1 } }, monster: { weapon: 'mace' } };
    const CHAR_IDS = ['warrior', 'mage', 'newclass', 'spearman', 'scholar', 'undead', 'beast', 'goblin', 'demon', 'monster', 'unknown', ''];
    const FACTIONS = ['undead', 'goblin', 'zombie', 'monster', '', 'beast', 'demon'];
    const rosterCase = (label: string, cfg: unknown, ap: unknown): unknown => {
      useStore({ pe_clips: [], pe_config: cfg, pe_appearance: ap } as unknown as Store);
      buildRoster();
      return {
        label, config: cfg, appearance: ap ?? null,
        chars: CHAR_IDS.map((id) => { const c = charFor(id); return [id, { id: c.id, name: c.name, gender: c.gender, build: c.build, weapon: c.weapon }]; }),
        monsterCharId: FACTIONS.map((f) => [f, monsterCharId(f)]),
      };
    };
    const chars = [
      rosterCase('config+appearance', CHAR_CFG, CHAR_AP),
      rosterCase('config', CHAR_CFG, undefined),
      rosterCase('empty', { classes: [], monsters: [] }, undefined),
    ];
    // ── морф телосложения (pe_morph): loadMorph и композиция поверх пропорций модели ──
    const PE_MORPH = {
      warrior: { height: 1.1, legs: 0.9, weight: 1.2, neck: 1.15, shoulders: 0.95, hips: 1.05, hands: 1.1, feet: 0.9, head: 1.05, armGirth: 1.1, chest: 1.2, waist: 0.9, arms: 1.05, torso: 0.95 },
      mage: {}, rogue: { height: 0.92, legGirth: 1.3 }, archer: 'abc', skeleton: null,
    };
    useStore({ pe_clips: [], pe_morph: PE_MORPH } as unknown as Store);
    const MORPH_LOADS: [string, string | null][] = [['warrior', null], ['mage', null], ['mage', 'warrior'], ['skeleton', 'warrior'], ['nobody', 'rogue'], ['archer', null], ['nobody', null]];
    const PROFILES: (BodyProfile | undefined)[] = [undefined, { height: 1.2, leg: 0.9 }, { height: 1, arm: 1, leg: 1, torso: 1, girth: 1.1 }];
    const BSCALES: (BoneScale | undefined)[] = [undefined, { Neck: 1.2, LeftUpperLeg: 0.9, Spine: 1.1 }, {}];
    const BUILDS: (BuildScale | undefined)[] = [undefined, { arm: 1.1 }, { arm: 1.2, leg: 0.8, torso: 1.3, head: 0.9 }];
    const morph = {
      store: PE_MORPH, profiles: PROFILES.map((x) => x ?? null), boneScales: BSCALES.map((x) => x ?? null), builds: BUILDS.map((x) => x ?? null),
      cases: MORPH_LOADS.map(([ch, fb]) => {
        const m = loadMorph(ch, fb ?? undefined);
        return {
          char: ch, fb, morph: m,
          profile: m ? PROFILES.map((b) => composeProfile(b, m)) : null,
          boneScale: m ? BSCALES.map((b) => composeBoneScale(b, m) ?? null) : null,
          build: m ? BUILDS.map((b) => composeBuild(b, m)) : null,
        };
      }),
    };

    const golden = {
      note: 'Эталон G1 паритета Unity ↔ веб: разбор контента анимации из /api/pose (pe_anim, pe_attacks, pe_layers, pe_sway, pe_shield, модель клипа, стойка под экипировку, реестр внешности pe_appearance, морф pe_morph). Генерит packages/client/src/render3d/unityAnimGolden.gen.test.ts из закреплённого снимка __golden__/unity_anim_content.json.',
      stores: { stand: stores.stand, rich: richOut }, names, collate, animCfg, pickAttack: pick, layers: { read, sways: SWAYS, lookup, resolve },
      clips: { list: clips, fields, blend },
      stance: {
        compose, offHand, at: stanceAt,
        tables: Object.fromEntries(Object.entries(TABLES).map(([tn, t]) => [tn, Object.fromEntries(Object.entries(t).map(([kk, e]) => [kk, e.clip !== undefined ? { clip: e.clip } : { pose: e.pose }]))])),
        opts: OPTS, resolve: stance,
      },
      content, chars, morph,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_anim_g1.json'), JSON.stringify(golden));
  }, 60_000);
});
