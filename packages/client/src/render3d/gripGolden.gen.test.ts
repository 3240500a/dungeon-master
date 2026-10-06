/**
 * ПРОДЮСЕР golden-эталона «ХВАТ ПАЛЬЦЕВ» для Unity-клиента (`__golden__/unity_grip.json`). Перегенерируется на каждом прогоне
 * этого файла из ТЕКУЩЕГО кода веба — тем путём, которым хват доходит до пальцев В ИГРЕ (game3d → `gamePlayerDoll` → `PosePlayer`):
 *  • `axes` — оси суставов 30 фаланг, выведенные из геометрии рига (`fingerAxes.deriveFingerAxes` по офсетам костей куклы с
 *    `fingers: true`), бинд-сгиб и его избыток над каноном (`bindCurlOver`) — на процедурном риге, на рыцаре (офсеты модели из
 *    `unity_rig.json`) и на синтетическом риге с поджатыми и РАЗНЫМИ слева/справа пальцами (вычитание бинд-избытка);
 *  • `presets` — `gripToPose` каждого встроенного хвата на обе кисти, на трёх долях слайдера и трёх ригах;
 *  • `resolve` — `effectiveWeaponGrip` + `resolveGripPose` по цепочке КЛИП → ОРУЖИЕ → АВТО (по полям), со своими хватами (концы
 *    слайдера сняты руками — бленд двух поз) и без конфига вовсе (авто по виду оружия), по ключам оружия всех видов;
 *  • `scenarios` — НАСТОЯЩИЙ `PosePlayer` на кукле рыцаря с пальцами, контент `localStorageContent` (как игра): каждый кадр —
 *    локальные кватернионы 30 фаланг после шага (`applyUpper`: каналы фаланг стойки → живой хват `pe_gripposes`, если стойка
 *    пальцы не анимирует; удар — каналы фаланг удара → живой хват клипа удара, если удар пальцы не анимирует). Сценарии: меч
 *    (в стойке впечён статичный хват — живой его перебивает), топор (у стойки анимированы пальцы — живой не трогает; удар топора
 *    тоже), щит, двуручное, лук, посох, маг без стоек (живой хват без имени клипа), боевая стойка со своим хватом клипа, удар со
 *    своим хватом клипа, смена оружия.
 * Unity: `Assets/DM/PoseEditor/Tests/GripCheck.cs` (меню DM ▸ Verify Grip) гонит свой порт (`FingerAxes`, `GripPoses`, `ClipPlayer`) по
 * тем же входам. Скопировать: `python tools/unity-check/golden_sync.py` (репо Unity) → Assets/DM/PoseEditor/Tests/unity_grip_golden.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { PosePlayer, localStorageContent, applyGaitConfig, loadTwistStates, setLocoMixOverride, emptyGrid, resetSwingSnapshot, type GXKnobs } from './poseRuntime.js';
import { BASE_GAIT_CHAR } from './locoBlend.js';
import { BUILTIN_GRIPS, findGrip, gripToPose, resolveGripPose, effectiveWeaponGrip, EMPTY_GRIP_CONFIG, type GripConfig } from './gripPoses.js';
import { deriveFingerAxes, bindCurlOver, type FingerAxes } from './fingerAxes.js';
import { allFingerBones } from './boneNames.js';
import type { Pose } from './clipModel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
type RawClip = { name: string; character: string; weapon: string; loop?: boolean; keys: { t: number; pose: Pose }[]; [k: string]: unknown };
type Store = Record<string, unknown> & { pe_clips: RawClip[] };
const SNAP = JSON.parse(readFileSync(join(HERE, '__golden__', 'unity_anim_content.json'), 'utf8')) as { stand: Store };
const RIG = JSON.parse(readFileSync(join(HERE, '__golden__', 'unity_rig.json'), 'utf8')) as {
  atlas: { look: { profile?: Record<string, number>; boneScale?: Record<string, number>; boneOffsets?: Record<string, number[]> } }[];
};

const FINGERS = allFingerBones();
const r6 = (x: number): number => { const v = Math.round(x * 1e6) / 1e6; return Object.is(v, -0) ? 0 : v; };
const r5 = (x: number): number => { const v = Math.round(x * 1e5) / 1e5; return Object.is(v, -0) ? 0 : v; };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const DT = 1 / 60;

// ── Риги: процедурный, рыцарь (офсеты модели), рыцарь с поджатыми пальцами (разными слева и справа) ─────────────────────────
type RigOpts = { boneOffsets?: Record<string, number[]>; boneScale?: Record<string, number>; profile?: Record<string, number> };
const knightLook = RIG.atlas[0]!.look;
const knight: RigOpts = { boneOffsets: knightLook.boneOffsets, boneScale: knightLook.boneScale, ...(knightLook.profile && Object.keys(knightLook.profile).length ? { profile: knightLook.profile } : {}) };
/** Поджатая кисть: средние и дальние фаланги опущены к ладони (у левой сильнее), большой отведён — бинд-избыток не нулевой и не зеркальный. */
function curledOffsets(): Record<string, number[]> {
  const bo = clone(knight.boneOffsets!);
  for (const nm of FINGERS) {
    if (!nm.endsWith('Intermediate') && !nm.endsWith('Distal')) continue;
    const v = bo[nm]; if (!v) continue;
    const k = nm.startsWith('Left') ? 0.42 : 0.18;
    const len = Math.hypot(v[0]!, v[1]!, v[2]!);
    bo[nm] = [v[0]!, v[1]! - k * len, v[2]! + (nm.includes('Thumb') ? 0.1 * len : 0)];
  }
  return bo;
}
const RIGS: Record<string, RigOpts> = { canon: {}, knight, curled: { ...knight, boneOffsets: curledOffsets() } };
const humanOf = (o: RigOpts): Humanoid => buildHumanoid({ ...o, fingers: true });
const axesOf = (h: Humanoid): Record<string, FingerAxes> =>
  deriveFingerAxes((b) => { const g = h.bones.get(b); return g ? [g.position.x, g.position.y, g.position.z] : null; });
const poseOut = (p: Pose): Record<string, number[]> => { const o: Record<string, number[]> = {}; for (const k in p) o[k] = p[k]!.map(r6); return o; };

// ── Конфиг хвата (`pe_gripposes`): свои хваты, привязка к оружию и к клипу ─────────────────────────────────────────────────────
function gripConfig(axKnight: Record<string, FingerAxes>): GripConfig {
  // Свой хват «коготь»: правая — полукулак с доворотом большого, левая — свой угол средней фаланги (Про-режим хранит готовые углы).
  const claw: Pose = { ...gripToPose(findGrip('fist')!, 'Right', 0.55, axKnight), ...gripToPose(findGrip('staff')!, 'Left', 0.7, axKnight) };
  claw['RightThumbProximal'] = [0.21, -0.33, 0.12];
  claw['LeftMiddleIntermediate'] = [0.05, 0.4, -0.6];
  const open: Pose = { ...gripToPose(findGrip('relaxed')!, 'Right', 0.25, axKnight), ...gripToPose(findGrip('point')!, 'Left', 0.2, axKnight) };
  return {
    custom: { c_claw: { id: 'c_claw', label: 'коготь', pose: claw }, c_open: { id: 'c_open', label: 'полураскрыта', pose: open } },
    byWeapon: {
      warrior: {
        sword: { R: 'c_claw', closeR: 0.6 },
        'sword+shield': { L: 'shield', closeL: 0.8, openR: 'c_open' },
        bow: { L: 'bow_draw', closeL: 0.9 },
        greatsword: { R: 'sword2h', L: 'c_claw', openL: 'c_open', closeL: 0.35 },
      },
      mage: { staff: { R: 'relaxed', closeR: 0.5, L: 'c_claw', openL: 'c_open', closeL: 0.3 } },
    },
    byClip: {
      warrior: { hit_sword: { R: 'point', closeR: 0.8 }, combat_idle_sword: { L: 'fist' }, idle_staff: { openR: 'c_open', closeR: 0.45 } },
    },
  };
}

// ── Хранилище сценариев: стенд (нужные клипы) + каналы фаланг (запечённый хват, анимированные пальцы) + `pe_gripposes` ──────
const KEEP = ['idle_none', 'idle_sword', 'idle_axe', 'idle_sword+shield', 'idle_greatsword', 'idle_bow', 'idle_staff', 'idle_shield',
  'hit_sword', 'hit_axe', 'hit_sword+shield', 'hit_none'];
function fingerChannels(p: Pose): Pose { const o: Pose = {}; for (const k in p) if (FINGERS.includes(k)) o[k] = p[k]!; return o; }
function gripStore(axKnight: Record<string, FingerAxes>): Store {
  const s = clone(SNAP.stand);
  const clips = s.pe_clips.filter((c) => c.character === 'warrior' && KEEP.includes(c.name));
  const at = (nm: string): RawClip => clips.find((c) => c.name === nm)!;
  // меч: в стойке ВПЕЧЁН статичный хват (как публикация поз-редактора) — живой конфиг обязан его перебить
  const baked = fingerChannels({ ...gripToPose(findGrip('fist')!, 'Right', 1, axKnight), ...gripToPose(findGrip('fist')!, 'Left', 1, axKnight) });
  for (const k of at('idle_sword').keys) Object.assign(k.pose, baked);
  // боевая стойка меча — своя (по ней берётся хват КЛИПА)
  clips.push({ ...clone(at('idle_sword')), name: 'combat_idle_sword', keys: clone(at('idle_sword').keys).map((k) => ({ ...k, pose: { ...k.pose, Spine: [0.12, 0, 0] } })) });
  // топор: у стойки АНИМИРОВАНЫ пальцы (два ключа с разной позой фаланг) — живой хват её не перебивает
  { const c = at('idle_axe'); const k0 = c.keys[0]!;
    const a = fingerChannels({ ...gripToPose(findGrip('axe')!, 'Right', 0.3, axKnight), ...gripToPose(findGrip('relaxed')!, 'Left', 1, axKnight) });
    const b = fingerChannels({ ...gripToPose(findGrip('axe')!, 'Right', 1, axKnight), ...gripToPose(findGrip('fist')!, 'Left', 0.6, axKnight) });
    c.keys = [{ ...clone(k0), t: 0, pose: { ...clone(k0.pose), ...a } }, { ...clone(k0), t: 1.2, pose: { ...clone(k0.pose), ...b } }, { ...clone(k0), t: 2.4, pose: { ...clone(k0.pose), ...a } }]; }
  // удар меча — статичные фаланги (живой хват клипа удара перебивает), удар топора — анимированные (не перебивает)
  { const st = fingerChannels(gripToPose(findGrip('bow_grip')!, 'Right', 1, axKnight));
    for (const k of at('hit_sword').keys) Object.assign(k.pose, st); }
  { const c = at('hit_axe');
    c.keys.forEach((k, i) => Object.assign(k.pose, fingerChannels({ ...gripToPose(findGrip('axe')!, 'Right', 0.4 + 0.12 * i, axKnight), ...gripToPose(findGrip('relaxed')!, 'Left', 0.2 * i, axKnight) }))); }
  return { ...s, pe_clips: clips, pe_gripposes: gripConfig(axKnight) };
}

function useStore(s: Store): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (key in s && s[key] !== undefined ? JSON.stringify(s[key]) : null),
    setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as unknown as Storage;
  resetSwingSnapshot();
}
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; setLocoMixOverride(null); });

/** Отрезок входа: `n` кадров; `combat` — бой; `weapon` — сменить оружие; `atk` — удар клипом на первом кадре (окно и вайндап, сек). */
interface Seg { n: number; combat?: boolean; weapon?: string; atk?: { clip: string; window: number; windup: number } }
interface Scn { id: string; char: string; weapon: string; segs: Seg[] }
const SCENARIOS: Scn[] = [
  { id: 'sword_idle', char: 'warrior', weapon: 'sword', segs: [{ n: 30 }] },
  { id: 'sword_attack', char: 'warrior', weapon: 'sword', segs: [{ n: 8 }, { n: 40, atk: { clip: 'hit_sword', window: 0.5, windup: 0.25 } }] },
  { id: 'sword_combat', char: 'warrior', weapon: 'sword', segs: [{ n: 10 }, { n: 40, combat: true }, { n: 30 }] },
  { id: 'axe_idle_animated', char: 'warrior', weapon: 'axe', segs: [{ n: 90 }] },
  { id: 'axe_attack_animated', char: 'warrior', weapon: 'axe', segs: [{ n: 8 }, { n: 40, atk: { clip: 'hit_axe', window: 0.5, windup: 0.25 } }] },
  { id: 'shield', char: 'warrior', weapon: 'sword+shield', segs: [{ n: 20 }, { n: 36, atk: { clip: 'hit_sword+shield', window: 0.5, windup: 0.25 } }] },
  { id: 'greatsword', char: 'warrior', weapon: 'greatsword', segs: [{ n: 24 }] },
  { id: 'bow', char: 'warrior', weapon: 'bow', segs: [{ n: 24 }] },
  { id: 'staff', char: 'warrior', weapon: 'staff', segs: [{ n: 24 }] },
  { id: 'empty_hands', char: 'warrior', weapon: 'none', segs: [{ n: 24 }] },
  { id: 'mage_no_stance', char: 'mage', weapon: 'staff', segs: [{ n: 24 }] },
  { id: 'swap_sword_axe', char: 'warrior', weapon: 'sword', segs: [{ n: 16 }, { n: 30, weapon: 'axe' }, { n: 20, weapon: 'bow' }] },
];

describe('gripGolden — эталон хвата пальцев для Unity', () => {
  it('пишет __golden__/unity_grip.json', () => {
    // оси, пресеты
    const humans = Object.fromEntries(Object.entries(RIGS).map(([k, o]) => [k, humanOf(o)])) as Record<string, Humanoid>;
    const ax = Object.fromEntries(Object.entries(humans).map(([k, h]) => [k, axesOf(h)])) as Record<string, Record<string, FingerAxes>>;
    const axes: Record<string, Record<string, number[]>> = {};
    for (const [rid, a] of Object.entries(ax)) {
      axes[rid] = {};
      for (const nm of FINGERS) {
        const f = a[nm];
        if (f) axes[rid]![nm] = [...f.twist, ...f.plane, ...f.normal, f.bindCurl, bindCurlOver(nm, a)].map(r6);
      }
    }
    const presets: unknown[] = [];
    for (const rid of Object.keys(RIGS))
      for (const g of BUILTIN_GRIPS)
        for (const side of ['Left', 'Right'] as const)
          for (const close of [0, 0.37, 1]) presets.push({ rig: rid, grip: g.id, side, close, pose: poseOut(gripToPose(g, side, close, ax[rid])) });

    // разбор хвата: без конфига (авто) и с конфигом
    const cfg = gripConfig(ax.knight!);
    const configs: Record<string, GripConfig> = { empty: EMPTY_GRIP_CONFIG(), cfg };
    const WEAPONS = ['sword', 'axe', 'mace', 'hammer', 'club', 'dagger', 'staff', 'spear', 'halberd', 'bow', 'crossbow', 'greatsword', 'greataxe',
      'shield', 'none', 'sword+shield', 'axe+dagger', 'none+shield', 'sword+dagger', 'dual', 'torch', 'weird_thing', 'longbow', 'polearm+shield'];
    const resolve: unknown[] = [];
    const one = (cid: string, ch: string, w: string, clip: string | undefined, rid: string): void => {
      const c = configs[cid]!;
      resolve.push({ cfg: cid, char: ch, weapon: w, clip: clip ?? null, rig: rid,
        eff: effectiveWeaponGrip(c, ch, w, clip), pose: poseOut(resolveGripPose(c, ch, w, ax[rid], clip)) });
    };
    // без конфига хват — только от вида оружия (персонаж и клип не участвуют): все виды на обоих ригах модели
    for (const w of WEAPONS) for (const rid of ['knight', 'curled', 'canon']) one('empty', 'warrior', w, undefined, rid);
    // с конфигом — цепочка клип → оружие → авто по полям, у персонажа со своей записью, с чужой и без записи
    for (const ch of ['warrior', 'mage', 'rogue'])
      for (const w of WEAPONS)
        for (const clip of [undefined, 'hit_sword', 'combat_idle_sword', 'idle_staff', 'nope']) {
          if (ch !== 'warrior' && clip !== undefined && clip !== 'hit_sword') continue;
          one('cfg', ch, w, clip, 'knight');
        }
    for (const w of ['sword', 'sword+shield', 'greatsword', 'bow', 'staff']) for (const clip of [undefined, 'hit_sword', 'idle_staff']) one('cfg', 'warrior', w, clip, 'curled');
    one('cfg', 'mage', 'staff', undefined, 'curled');

    // игровой путь: PosePlayer на кукле рыцаря с пальцами
    const store = gripStore(ax.knight!);
    const scenarios: unknown[] = [];
    for (const sc of SCENARIOS) {
      useStore(store);
      const gx: GXKnobs = { armDown: 1.35, elbowBend: 0.25 };
      applyGaitConfig(sc.char, gx);
      const content = localStorageContent(sc.char, undefined, BASE_GAIT_CHAR);
      const human = humanOf(knight);
      const player = new PosePlayer(human, () => [], content, sc.weapon, gx, emptyGrid(), loadTwistStates(sc.char));
      setLocoMixOverride(1);
      player.setYaw(0); player.snapYaw(); player.setVel(0, 0);
      const frames: unknown[] = [];
      let f = 0, weapon = sc.weapon, since = 99;
      for (const s of sc.segs) for (let i = 0; i < s.n; i++, f++) {
        if (i === 0) since = 0;
        const w = s.weapon ?? weapon;
        if (w !== weapon) { player.setWeapon(w); weapon = w; }
        player.setCombat(!!s.combat);
        if (s.atk && i === 0) {
          const clip = content.clipByName(s.atk.clip);
          expect(clip, s.atk.clip).toBeTruthy();
          player.triggerAttack(clip, s.atk.window, s.atk.windup);
        }
        player.step(DT);
        if (!(since++ < 6 || f % 4 === 3)) continue;
        const q: number[] = [];
        for (const nm of FINGERS) { const b = human.bones.get(nm)!.quaternion; q.push(r5(b.x), r5(b.y), r5(b.z), r5(b.w)); }
        frames.push({ f, q });
      }
      scenarios.push({ ...sc, frames });
    }

    // самопроверки: живой хват реально кладётся и реально уступает анимированным пальцам
    const sq = (id: string): { f: number; q: number[] }[] => (scenarios.find((s) => (s as Scn).id === id) as { frames: { f: number; q: number[] }[] }).frames;
    const isIdent = (q: number[]): boolean => { for (let i = 0; i < q.length; i += 4) if (Math.abs(q[i + 3]! - 1) > 1e-4) return false; return true; };
    expect(isIdent(sq('sword_idle')[3]!.q)).toBe(false);
    const ax0 = sq('axe_idle_animated'), axL = ax0[ax0.length - 1]!;
    expect(JSON.stringify(ax0[2]!.q)).not.toBe(JSON.stringify(axL.q));   // пальцы стойки топора — по клипу, не статичный хват
    expect(store.pe_clips.some((c) => c.name === 'combat_idle_sword')).toBe(true);

    const golden = {
      note: 'Эталон хвата пальцев для Unity: оси суставов из геометрии рига, пресеты, разбор хвата (клип → оружие → авто) и кадры настоящего PosePlayer веба с пальцами (каналы фаланг стойки и удара + живой хват pe_gripposes). Генерит packages/client/src/render3d/gripGolden.gen.test.ts.',
      dt: DT, fingers: FINGERS, rigs: RIGS, axes, presets,
      configs, resolve,
      store, scenarios,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_grip.json'), JSON.stringify(golden));
  }, 120_000);
});
