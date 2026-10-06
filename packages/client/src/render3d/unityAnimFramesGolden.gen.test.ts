/**
 * ПРОДЮСЕР golden-эталона G2 «ЛОКОМОЦИЯ КЛИПАМИ ПОКАДРОВО» для Unity-клиента (шаги U4b, U4d, U4e). На каждом `npm test` перегенерирует
 * `__golden__/unity_anim_g2.json` из ТЕКУЩЕГО кода веба: НАСТОЯЩИЙ `PosePlayer` (стенд замеров `parityHarness.makeStand` —
 * процедурный гуманоид без офсетов, доля клипа 1 = «только клипы», как в игре; рыцарь — тот же плеер на риге из офсетов
 * модели, как его строит `gamePlayerDoll`) прогоняется по сценариям хода и поворотов, и с КАЖДОГО кадра снимаются локальные
 * кватернионы 22 костей, позиция таза, скаляры слоя клипов (`clipPhase`, доля клипа `locoW`, вес фиксации `lockW`, опора стоп)
 * и поворотов (курс таза, доворот и его сектор, защёлка и скорость таза, «прицел стоит», клип поворота на месте, его время, вес и
 * гашение, доля шва). Шагает плеер каждый кадр, в эталон идёт каждый третий (`f` — номер кадра) и каждый из восьми после смены
 * входа или клипа поворота. Unity (`Assets/DM/PoseEditor/Tests/AnimFrameCheck.cs`, меню DM ▸ Verify Anim Frames) гонит свой порт
 * (`ClipPlayer`) по тем же входам и сверяет кадр за кадром.
 *
 * Контент — как игра: `applyGaitConfig` (тюн персонажа из `pe_gait` в глобальные ручки + gx, свёртка локтя),
 * `localStorageContent(класс, —, донор хода warrior)`, `loadTwistStates`. Хранилища:
 *  • `stand` — закреплённый ответ `/api/pose` тестового стенда (`__golden__/unity_anim_content.json`) + НАБОР ХОДА мокапа Kubold
 *    (`public/mocap/mocap_core.json`, 15 клипов, с поворотами на месте 45/90/180) под воином без оружия — так его переносит
 *    кнопка набора; айдл мокапа — живая безоружная стойка (`idle_none_relax`, 8 ключей);
 *  • `rich` — `stand` + синтетика под ветки, которых у стенда нет: `pe_swing` (мах по предмету, поправки вбок/назад, бой),
 *    `pe_layers` (грудь и голова), `pe_twist` (профили по состояниям, свой порог/выравнивание/темп клипа поворота), таз стойки
 *    (`stancePelvis`), доворот таза под ход (`warpOn`, потолок 45°), запечённый отворот (`hipsYawW`) у страйфов, секции цикла у
 *    ходьбы (`loop_start`/`loop_end`), ленивая нейтраль маха (бег без `swingRef`), канал опоры у страйфа и у поворота `turn_R_90`,
 *    стойка без `__hipsD` (высота стоя по стопам), руки мага без стойки с асимметрией и колонкой боя (`locoVal`);
 *  • `stale` — `rich`, где страйфы сняты ДО кардинальной ревизии (`bakeRev` 1: доворот старой складкой вперёд/назад вместо
 *    секторов), а поворотов на месте нет вовсе (таз стоя ведёт `stepTorsoLead`);
 *  • `warp` — `stand` с доворотом таза под ход (`warpOn`): клипы мокапа без запечённого отворота и без таза стойки — отворот
 *    корпуса на доворот идёт прямой веткой (без рыска кости), как у импортированного набора в игре.
 * Рыцарь — риг из офсетов модели (приведение ног, высота лодыжки, длины ноги для фиксации стоп).
 * Повороты (4d): прицел ведётся «мышью» — разгон и торможение (smoothstep), ступенями (снапшоты сервера), непрерывным вращением; на
 * 45/90/180 в обе стороны, рывком и плавно, с выравниванием малого остатка, с ходом посреди поворота и остановкой посреди доворота,
 * со сменой оружия посреди шва. Удары и действия (4e, хранилища `atk` / `calm` / `idle` поверх `rich`): удар с посадкой импакта на вайндап сервера, без разметки — ровной
 * скоростью, телеграф монстра (окна нет, донор контента — воин), цепочка при зажатой атаке (конец окна комбо = следующий удар, перехват
 * свинга сервера после автосцепки, отпустил — доигрывает хвост), кроссфейд уходящего удара, ноги удара (стоя — у клипа, на ходу — у
 * локомоции, встали посреди удара — переходят), таз удара, бой, смена оружия и щит, позы скила, состояния (оглушён / сбит / встаёт —
 * приоритет и замок), удар посреди поворота и прицел во время удара, редкие вставки в покой (и их отсутствие при наборе поворотов), шаги.
 * Очередь ударов — копия `gamePlayerDoll.attack` (пул, «последний сыгранный», `pickAttack`); пул ≥ 3 — со случайностью `mulberry32`
 * по сиду сценария (`rndSeed`), у прочих случайность не участвует.
 * ЗАЗЕМЛЕНИЕ (`gd` кадра): кинематический показ куклы игры (`renderKinematicPose` → `groundFeet`, копия четырёх строк — humanoidRagdoll
 * в node не грузится) на втором манекене той же геометрии: таз позы + накопленный сдвиг, IK опорных стоп на пол y = 0, укладка плашмя;
 * снимаются мир-высота таза, сдвиг `gs.off` и шесть костей ног. ⚠ Поза копируется кватернионами, а не `readPose()` (тот округляет
 * эйлер до 1e-3 рад — ≤ 0.03° на кость; это артефакт сериализации, его Unity не повторяет).
 * ЧАСТОТА КАДРА: у отрезка свой `dt` — 144 Гц, 20 Гц и «рваный» кадр (1/144…3/60, как пропуски temporal-LOD), чтобы шаги, зависящие
 * от `dt` (темп прицела, `LEGS_FADE`, `COL_FADE`, конец поворота, фиксация стоп, сдвиг заземления), сверялись не только на 60 Гц.
 * Риги: процедурный, рыцарь (офсеты модели), `slim` (неединичный профиль тела), `scaled` (только `boneScale`); `footLift` сценария —
 * подъём стопы (pe_phys). Отрезок может снять лаг таза (`snap`, телепорт) и выключить вставки (`breaks: false`).
 * В кадре — ещё слот действия (клип, время, темп), уходящий удар (клип, время, вес), ноги удара (затвор, вес), вставка (клип, время,
 * вес); у сценария — все метки кадров (`onMark`: метки ударов и шагов с темпом) с номером кадра.
 * Скопировать в Unity: `python tools/unity-check/golden_sync.py` (репо Unity) → Assets/DM/PoseEditor/Tests/unity_anim_g2_golden.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeStand } from './parityHarness.js';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import {
  PosePlayer, localStorageContent, applyGaitConfig, loadGaitLocal, loadTwistStates, setLocoMixOverride, emptyGrid, resetSwingSnapshot,
  type GXKnobs, type GamePoseContent,
} from './poseRuntime.js';
import { GAIT, ASYM, COMBAT } from './gaitKnobs.js';
import { BASE_GAIT_CHAR, locoPhaseU, bakedLocoSpeed } from './locoBlend.js';
import { pickAttack, ATTACK_VARY } from './attackPick.js';
import { type Pose, type Clip, type MarkEvent } from './clipModel.js';
import { groundFeet } from './footIk.js';
import { mulberry32 } from './idleFidget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
type RawClip = { name: string; character: string; weapon: string; loop: boolean; keys: { t: number; pose: Pose }[]; [k: string]: unknown };
type Store = Record<string, unknown> & { pe_clips: RawClip[] };
const SNAP = JSON.parse(readFileSync(join(HERE, '__golden__', 'unity_anim_content.json'), 'utf8')) as { stand: Store };
const CORE = JSON.parse(readFileSync(join(HERE, '..', '..', 'public', 'mocap', 'mocap_core.json'), 'utf8')) as RawClip[];
const RIG = JSON.parse(readFileSync(join(HERE, '__golden__', 'unity_rig.json'), 'utf8')) as {
  atlas: { look: { profile?: Record<string, number>; boneScale?: Record<string, number>; boneOffsets?: Record<string, number[]> } }[];
};

const r5 = (x: number): number => { const v = Math.round(x * 1e5) / 1e5; return Object.is(v, -0) ? 0 : v; };
const r6 = (x: number): number => { const v = Math.round(x * 1e6) / 1e6; return Object.is(v, -0) ? 0 : v; };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Порядок костей в кадре эталона (локальные кватернионы x,y,z,w подряд). */
const BONES = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'];
/** Кости, которые трогает заземление (IK опорной ноги): их локальные кватернионы — в `gd` кадра после таза и сдвига. */
const GROUND_BONES = ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];

// ── Хранилища ────────────────────────────────────────────────────────────────────────────────────
/** Стенд + набор хода мокапа под воином без оружия (айдл мокапа — его живая безоружная стойка). */
function standStore(): Store {
  const s = clone(SNAP.stand);
  const set = CORE.map((c) => ({ ...clone(c), name: c.name === 'idle' ? 'idle_none_relax' : c.name, character: 'warrior', weapon: 'none' }));
  return { ...s, pe_clips: [...s.pe_clips, ...set] };
}
/** Наложение поверх базы: ключи целиком, правки полей клипов по индексу в `pe_clips` базы, клипы в конец. */
type Overlay = { base?: string; keys: Record<string, unknown>; patch: [number, Record<string, unknown>][]; add: RawClip[] };
const clipAt = (s: Store, name: string): number => s.pe_clips.findIndex((c) => c.character === 'warrior' && c.name === name);
/**
 * Канал опоры `__swing` (≥ 0.5 = нога в воздухе) по долям времени клипа: окна переноса левой и правой, `air` — значение переноса.
 * ⚠ У поворота `air` 0.8, а не 1: его время идёт шагом темпа × кадр, и при 0/1 середина между ключами (ровно 0.5 — порог) попадала
 * бы точно на кадр — опора решалась бы последним битом (float-клип Unity против double веба), а не движением.
 */
function withSwing(c: RawClip, l: [number, number], r: [number, number], air = 1): RawClip['keys'] {
  const dur = c.keys[c.keys.length - 1]!.t || 1;
  return clone(c.keys).map((k) => { const u = k.t / dur; return { ...k, pose: { ...k.pose, __swing: [u >= l[0] && u < l[1] ? air : 0, u >= r[0] && u < r[1] ? air : 0, 0] } }; });
}
function richOverlay(stand: Store): Overlay {
  const gait = clone(stand.pe_gait as Record<string, Record<string, unknown>>);
  const w = gait.warrior!;
  w.gait = { ...(w.gait as Record<string, number>), stancePelvis: 0.7, stancePelvisYaw: 0.5, speedWalk: 45, dutyWalk: 0.4, combatBlend: 0.25, warpOn: 1, warpMax: 45 };
  w.gx = { ...(w.gx as Record<string, number>), armDown: 1.3, armDownRun: 1.1, elbowBend: 0.3 };
  w.asym = { armDown: [1.25, 1.35] };
  w.combat = { armDown: 0.9 };
  // маг без стоек: руки опущены ручками gx — здесь им асимметрия и колонка боя (locoVal), сгиб локтя (свёртка его обнулит)
  gait.mage = { ...(gait.mage ?? {}), gx: { armDown: 1.2, elbowBend: 0.4, armDownRun: 1.0 }, asym: { armDown: [1.1, 1.3], armDownRun: [0.9, 1.05] }, combat: { armDown: 0.7, armDownRun: 0.6 } };
  const patch: [number, Record<string, unknown>][] = [];
  const at = (name: string): number => clipAt(stand, name);
  stand.pe_clips.forEach((c, i) => {
    if (c.character === 'warrior' && /_strafe_[LR]$/.test(c.name)) patch.push([i, { hipsYawW: [0.3, 0.45, 0.25] }]);
  });
  // Секции цикла у ходьбы: разгон до loop_start и остановка после loop_end (stepLocoSection / sectionClipTime, цикл по секции).
  { const i = at('walk_fwd'); const keys = clone(stand.pe_clips[i]!.keys) as ({ marks?: unknown[] } & Record<string, unknown>)[];
    keys[3]!.marks = [{ type: 'loop_start' }]; keys[keys.length - 5]!.marks = [{ type: 'loop_end' }];
    patch.push([i, { keys }]); }
  patch.push([at('run_fwd'), { swingRef: null }]);   // нейтраль маха — ленивым средним по циклу (swingRefOf без поля)
  // Канал опоры `__swing` у ходьбы вбок: опора — из ВЕДУЩЕГО клипа, а не окном по доле (ведущий у страйфа — сам страйф).
  { const i = at('walk_strafe_R'); patch.push([i, { keys: withSwing(stand.pe_clips[i]!, [0.05, 0.45], [0.55, 0.95]) }]); }
  // …и у поворота на месте: опора на время клипа поворота — из ЕГО канала (`turnSupportAt`), а не из клипа хода.
  { const i = at('turn_R_90'); patch.push([i, { keys: withSwing(stand.pe_clips[i]!, [0.1, 0.4], [0.45, 0.8], 0.8) }]); }
  // Добавленные клипы: «разбойник» с одной статичной стойкой (ни живой базы, ни `__hipsD` — высота стоя по стопам: FOOT_Y у
  // процедурного рига, лодыжка — у рыцаря) и боевая стойка воина с топором со СВОИМ тазом (смена боя перемеряет высоту стоя).
  const dagger = stand.pe_clips[at('idle_dagger')]!;
  const axe = stand.pe_clips[at('idle_axe')]!;
  const add: RawClip[] = [
    { ...clone(dagger), name: 'idle_dagger', character: 'rogue' },
    { ...clone(axe), name: 'idle_axe_incombat', character: 'warrior', keys: clone(axe.keys).map((k) => ({ ...k, pose: { ...k.pose, __hipsD: [0.4, -1.6, 0.3], Spine: [0.18, 0.05, 0] } })) },
  ];
  return {
    keys: {
      pe_gait: gait,
      pe_swing: {
        warrior: {
          axe: { walk: { arm: { a: 0.8, k: 0.5 }, elbow: { k: 0.25 } }, run: { arm: { a: 0.6, k: 0.8 }, wrist: { a: 0.9, k: 0.1 } },
            combat: { run: { arm: { k: 0.3 } } }, side: { arm: 1.6, elbow: 0.5 }, back: { arm: 0.4 } },
          none: { run: { arm: { a: 0.2, k: 0.9 } } },
        },
      },
      pe_layers: { warrior: { axe: { walk: { chest: 0.4, head: 0.3 }, run: { chest: 0.9 }, combat: { run: { head: 0.8 } } } } },
      pe_twist: { warrior: {
        stand: { weights: [0.2, 0.3, 0.3, 0.1, 0.1], headLook: 0.6, headPitch: -0.1, threshold: 0.6, relaxTime: 1.0, turnClipRate: 1.5 },
        run: { headLook: 0.95, maxTwist: 1.1, turnRate: 4 },
      } },
    },
    patch, add,
  };
}
/** `stale` поверх `rich`: страйфы не кардинальные (старая складка доворота), поворотов на месте нет (персонаж «чужой»). */
function staleOverlay(rich: Store): Overlay {
  const patch: [number, Record<string, unknown>][] = [];
  rich.pe_clips.forEach((c, i) => {
    if (c.character !== 'warrior') return;
    if (/_strafe_[LR]$/.test(c.name)) patch.push([i, { bakeRev: 1 }]);
    if (/^turn_[LR]_\d+$/.test(c.name)) patch.push([i, { character: 'archive' }]);
  });
  return { base: 'rich', keys: {}, patch, add: [] };
}
/**
 * `tempo` поверх `stand`: шаг ходьбы и бега вперёд ПРАВИЛИ после съёма (`strideTempo.syncClipTempo`) — часы идут по
 * `tempoSpeed` (`clipTempoSpeed`), а не по скорости съёма: ходьба шире (темп ×1.25), бег короче (×0.8).
 */
function tempoOverlay(stand: Store): Overlay {
  const patch: [number, Record<string, unknown>][] = [];
  stand.pe_clips.forEach((c, i) => {
    if (c.character !== 'warrior') return;
    const k = c.name === 'run_fwd' ? 0.8 : c.name === 'walk_fwd' ? 1.25 : 0;
    if (k) patch.push([i, { tempoSpeed: Math.round(bakedLocoSpeed(c as { name: string; bakeSpeed?: number }) * k * 1000) / 1000 }]);
  });
  return { base: 'stand', keys: {}, patch, add: [] };
}
/**
 * ⭐ ДИАГОНАЛИ (07.10): у воина восемь направлений — бленд парой соседних (`locoPairWeights`), доворот к ближайшей оси
 * набора. Клипы диагоналей — копии хода вперёд/назад со СВОИМ скручиванием корпуса по стороне: зеркальная ошибка
 * стороны (L45 ↔ R45) видна сразу.
 */
function diagClips(stand: Store): RawClip[] {
  const out: RawClip[] = [];
  const mk = (from: string, to: string, spineY: number): void => {
    const c = clone(stand.pe_clips[clipAt(stand, from)]!);
    c.name = to;
    c.keys = c.keys.map((k) => {
      const s = k.pose['Spine'] ?? [0, 0, 0];
      return { ...k, pose: { ...k.pose, Spine: [s[0]!, s[1]! + spineY, s[2]!] } };
    });
    out.push(c);
  };
  for (const sp of ['walk', 'run']) {
    mk(`${sp}_fwd`, `${sp}_diag_L45`, 0.12); mk(`${sp}_fwd`, `${sp}_diag_R45`, -0.12);
    mk(`${sp}_back`, `${sp}_diag_L135`, 0.18); mk(`${sp}_back`, `${sp}_diag_R135`, -0.18);
  }
  return out;
}
/** `two` поверх `warp`: у воина только вперёд и назад (страйфы в архиве) — доворот к ближайшему из двух, остаток — скольжение. */
function twoOverlay(warp: Store): Overlay {
  const patch: [number, Record<string, unknown>][] = [];
  warp.pe_clips.forEach((c, i) => { if (c.character === 'warrior' && /_strafe_[LR]$/.test(c.name)) patch.push([i, { character: 'archive' }]); });
  return { base: 'warp', keys: {}, patch, add: [] };
}
/** `warp` поверх `stand`: доворот таза под ход включён ручкой персонажа, остальное — как у стенда. */
function warpOverlay(stand: Store): Overlay {
  const gait = clone(stand.pe_gait as Record<string, Record<string, unknown>>);
  gait.warrior!.gait = { ...(gait.warrior!.gait as Record<string, number>), warpOn: 1 };
  return { base: 'stand', keys: { pe_gait: gait }, patch: [], add: [] };
}
/** Метки на ключах клипа: индекс ключа → список меток (остальные ключи как были). */
type MarkSpec = Record<number, Record<string, unknown>[]>;
function withMarks(c: RawClip, marks: MarkSpec, hipsD?: Record<number, [number, number, number]>): RawClip['keys'] {
  return clone(c.keys).map((k, i) => ({ ...k, ...(marks[i] ? { marks: marks[i] } : {}), pose: hipsD?.[i] ? { ...k.pose, __hipsD: hipsD[i] } : k.pose }));
}
/** Клип стенда воина под другим именем/оружием (синтетика для слота действия: вторые удары, состояния, вставки). */
function cloneAs(s: Store, from: string, name: string, weapon: string, marks: MarkSpec = {}): RawClip {
  const c = s.pe_clips[clipAt(s, from)]!;
  return { ...clone(c), name, character: 'warrior', weapon, keys: withMarks(c, marks) };
}
/**
 * `atk` поверх `rich` (4e): РАЗМЕЧЕННЫЙ удар топора — мах (отрезок с нуля: метка на первом кадре), замах `windup`, звук, импакт +
 * тряска, окно комбо — и сдвиг таза удара `__hipsD`; второй удар серии (`hit_axe_b`, окно комбо раньше импакта, без `windup` —
 * вход цепочки в начало окна); серия топора `pe_attacks`; клипы состояний (`pe_anim.states`: оглушён — ноги всегда у клипа, сбит —
 * непрерываемый с приоритетом, встаёт — ноги никогда); авторские шаги у бега (`footstep` — шаги из меток, а не из касаний).
 */
function atkOverlay(rich: Store): Overlay {
  const at = (name: string): number => clipAt(rich, name);
  const patch: [number, Record<string, unknown>][] = [];
  { const i = at('hit_axe');
    patch.push([i, { keys: withMarks(rich.pe_clips[i]!, {
      0: [{ type: 'swing', dur: 0.3 }],
      1: [{ type: 'windup' }, { type: 'sfx', sfx: 'whoosh' }],
      3: [{ type: 'impact' }, { type: 'camshake', num: 0.6 }, { type: 'combo', dur: 0.15 }],
    }, { 0: [0, 0, 0], 2: [0.5, -0.4, 0.8], 3: [1.0, -0.8, 1.6], 4: [0.4, -0.3, 0.6], 5: [0, 0, 0] }) }]); }
  { const i = at('turn_R_90');
    patch.push([i, { keys: withMarks(rich.pe_clips[i]!, { 3: [{ type: 'footstep', foot: 'L' }], 6: [{ type: 'sfx', sfx: 'scuff' }], 9: [{ type: 'footstep', foot: 'R' }] }) }]); }
  // удар кинжала без разметки, но с idle-входом: цепочка входит после него (второй ключ), темп — от этой точки
  patch.push([at('hit_dagger'), { idleEnds: true }]);
  { const i = at('run_fwd'); const n = rich.pe_clips[i]!.keys.length;
    patch.push([i, { keys: withMarks(rich.pe_clips[i]!, { 2: [{ type: 'footstep', foot: 'L' }], [Math.floor(n / 2) + 1]: [{ type: 'footstep', foot: 'R' }] }) }]); }
  const add: RawClip[] = [
    cloneAs(rich, 'hit_mace', 'hit_axe_b', 'axe', { 2: [{ type: 'combo', dur: 0.2 }], 3: [{ type: 'impact' }, { type: 'vfx', vfx: 'spark' }] }),
    cloneAs(rich, 'hit_dagger', 'react_stagger', 'none'),
    cloneAs(rich, 'hit_greatmaul', 'react_fall', 'none'),
    cloneAs(rich, 'hit_halberd', 'react_getup', 'none'),
  ];
  const attacks = clone(rich.pe_attacks as Record<string, Record<string, string[]>>);
  attacks.warrior!.axe = ['hit_axe', 'hit_axe_b'];
  return {
    base: 'rich',
    keys: {
      pe_attacks: attacks,
      pe_anim: { warrior: { states: {
        stagger: { clip: 'react_stagger', priority: 3, legs: 'always', blendSec: 0.2 },
        knockdown_fall: { clip: 'react_fall', priority: 3, interruptible: false, blendSec: 0.08 },
        getup: { clip: 'react_getup', priority: 2, legs: 'never' },
      } } },
    },
    patch, add,
  };
}
/**
 * `calm` поверх `atk`: редкие вставки в покой — базовые (с весом и без), предметная топора, расписание (`idleBreak`) короткое, чтобы
 * вставки шли в пределах сценария. Набор поворотов на месте остаётся: с ним «решаем о повороте» стоя истинно всегда, и вставки НЕ
 * играют вовсе — это поведение веба, сценарий его стережёт.
 */
function calmOverlay(atk: Store): Overlay {
  const patch: [number, Record<string, unknown>][] = [];
  const anim = clone(atk.pe_anim as Record<string, Record<string, unknown>>);
  anim.warrior!.base = {
    fidgets: [{ clip: 'fidget_look', weight: 1, blend: 0.2 }, 'fidget_shift'], combatFidgets: [{ clip: 'fidget_guard', weight: 1 }],
    idleBreak: { after: 0.5, gapMin: 0.75, gapMax: 1.5, blend: 0.25 },
  };
  anim.warrior!.items = { axe: { fidgets: [{ clip: 'fidget_axe', weight: 2 }] } };
  return {
    base: 'atk', keys: { pe_anim: anim }, patch,
    add: [cloneAs(atk, 'hit_spear', 'fidget_look', 'none'), cloneAs(atk, 'hit_staff', 'fidget_shift', 'none'), cloneAs(atk, 'hit_bow', 'fidget_axe', 'axe'),
      cloneAs(atk, 'hit_crossbow', 'fidget_guard', 'none')],
  };
}
/** `idle` поверх `calm`: поворотов на месте нет (персонаж «чужой») — стоя «решаем о повороте» ложно, и вставки играют. */
function idleOverlay(calm: Store): Overlay {
  const patch: [number, Record<string, unknown>][] = [];
  calm.pe_clips.forEach((c, i) => { if (c.character === 'warrior' && /^turn_[LR]_\d+$/.test(c.name)) patch.push([i, { character: 'archive' }]); });
  return { base: 'calm', keys: {}, patch, add: [] };
}
/** `atk3` поверх `atk`: серия топора из ТРЁХ ударов — очередь со случайностью (`vary`), сид — у сценария. */
function atk3Overlay(atk: Store): Overlay {
  const attacks = clone(atk.pe_attacks as Record<string, Record<string, string[]>>);
  attacks.warrior!.axe = ['hit_axe', 'hit_axe_b', 'hit_axe_c'];
  return { base: 'atk', keys: { pe_attacks: attacks }, patch: [],
    add: [cloneAs(atk, 'hit_spear', 'hit_axe_c', 'axe', { 1: [{ type: 'combo', dur: 0.25 }], 2: [{ type: 'impact' }] })] };
}
/**
 * `owner` поверх `stand` (06.10) — КАК КОНТЕНТ ВЛАДЕЛЬЦА, но из данных репо: живая безоружная база (айдл мокапа, 8 ключей), своя
 * однокадровая боевая база, стойки меча и щита в слоте офф-руки, привязанные `pe_anim` к ТОЧНОМУ ключу, — снятые когда-то от ДРУГОЙ
 * безоружной базы (свои ноги и таз: бёдра на 0.5/0.7 рад, таз (−1, 0.08, 0.65), как у владельца), ручки `pe_gait`/`pe_twist`/
 * `pe_layers`/`pe_swing` владельца. На нём до 06.10 одиночный предмет отдавал стойку ЦЕЛИКОМ и стопы в покое плыли; правило
 * владельца — тело всегда безоружное, от стойки предмета только рука.
 */
function ownerOverlay(stand: Store): Overlay {
  const at = (name: string): RawClip => stand.pe_clips[clipAt(stand, name)]!;
  const relax = stand.pe_clips.find((c) => c.character === 'warrior' && c.name === 'idle_none_relax')!.keys[0]!.pose;
  const legs = (p: Pose, d: number): Pose => ({ ...p,
    LeftUpperLeg: [0.5 * d, 0.05, 0.2], RightUpperLeg: [-0.7 * d, -0.04, -0.12], LeftLowerLeg: [0.22 * d, 0, 0], RightLowerLeg: [0.24 * d, 0, 0],
    LeftFoot: [-0.19 * d, 0.1, 0], RightFoot: [-0.45 * d, -0.12, 0] });
  const pick = (p: Pose, keys: string[]): Pose => Object.fromEntries(keys.filter((k) => p[k]).map((k) => [k, p[k]!]));
  const ARM_R = ['RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand', '__wpnMain', '__wpnMainP'];
  const ARM_L = ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand'];
  const one = (name: string, weapon: string, pose: Pose): RawClip => ({ name, character: 'warrior', weapon, loop: false, keys: [{ t: 0, pose }] });
  // боевая база: своя присадка и таз; меч/щит в бою — та же поза с рукой предмета (у владельца боевые стойки совпадают телом)
  const combat: Pose = { ...legs(relax, 0.6), __hipsD: [-1, -1.06, 0.65] };
  const sword = at('idle_sword').keys[0]!.pose, shield = at('idle_none+shield').keys[0]!.pose;
  const add: RawClip[] = [
    one('idle_none_incombat', 'none', combat),
    one('idle_sword_relax_2', 'sword', { ...legs(sword, 1), __hipsD: [-1, 0.08, 0.65] }),
    one('idle_sword_incombat', 'sword', { ...combat, ...pick(sword, ARM_R) }),
    one('idle_none+shield_relax', 'none+shield', { ...legs(shield, 1), __hipsD: [-1, 0.08, 0.65] }),
    one('idle_none+shield_incombat', 'none+shield', { ...combat, ...pick(shield, [...ARM_L, '__wpnMain', '__wpnMainP']) }),
  ];
  const gait = clone(stand.pe_gait as Record<string, Record<string, unknown>>);
  const w = gait.warrior!;
  w.gait = { ...(w.gait as Record<string, number>), stancePelvis: 1, stancePelvisYaw: 1, gndLag: 1, warpOn: 1, warpMax: 50, combatBlend: 0.18 };
  w.gx = { ...(w.gx as Record<string, number>), armDown: 1.52, elbowBend: 0, armDownRun: 1.08 };
  return {
    base: 'stand',
    keys: {
      pe_gait: gait,
      pe_anim: { warrior: {
        base: { idle: 'idle_none_relax', combatIdle: 'idle_none_incombat' },
        items: { sword: { idle: 'idle_sword_relax_2', combatIdle: 'idle_sword_incombat' }, 'none+shield': { idle: 'idle_none+shield_relax', combatIdle: 'idle_none+shield_incombat' } },
      } },
      pe_twist: { warrior: { stand: { threshold: 1.571, turnRate: 8, maxTwist: 1.222, headLook: 0.5 } } },
      pe_layers: { warrior: { none: { run: { chest: 1 }, walk: { chest: 1 } } } },
      pe_swing: { warrior: { sword: { run: { arm: { k: 0.15 } } } } },
    },
    patch: [], add,
  };
}
function applyOverlay(base: Store, ov: Overlay): Store {
  const s = clone(base);
  Object.assign(s, clone(ov.keys));
  for (const [i, f] of ov.patch) Object.assign(s.pe_clips[i]!, clone(f));
  s.pe_clips.push(...clone(ov.add));
  return s;
}

/** «localStorage» веба — из хранилища (контент и тюн читают его на сборке куклы). */
function useStore(s: Store): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (key in s && s[key] !== undefined ? JSON.stringify(s[key]) : null),
    setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as unknown as Storage;
  resetSwingSnapshot();   // снимок `pe_swing` модульный — иначе чужое хранилище доехало бы до следующего сценария
}
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; setLocoMixOverride(null); });

// ── Сценарии ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Отрезок входа: `n` кадров с этой скоростью (u/с, мир веба), прицелом, боем и оружием (нет — оружие сценария). 4e: `atk` — событие
 * удара на ПЕРВОМ кадре отрезка (окно lockMs и вайндап windupMs в сек, `clips` — позы скила; свинг монстра — окно 0), `hold` — атака
 * зажата, `stun`/`downed` — состояния с сервера.
 */
interface Seg {
  n: number; vx: number; vz: number; aim?: number; combat?: boolean; weapon?: string;
  atk?: { window: number; windup: number; clips?: string[] }; hold?: boolean; stun?: boolean; downed?: boolean;
  /** Длительность кадра отрезка (сек); нет — 1/60. */
  dt?: number;
  /** Снять лаг таза на первом кадре отрезка (телепорт/пробуждение: `snapYaw` после `setYaw`, как кукла игры). */
  snap?: boolean;
  /** Включить/выключить редкие вставки на первом кадре отрезка (`setIdleBreaks`). */
  breaks?: boolean;
}
/** `yaw0` — курс на старте (таз снапнут на прицел); `fb` — донор контента (монстр → воин); `breaks` — редкие вставки включены (игровая кукла). */
interface Scn {
  id: string; store: 'stand' | 'rich' | 'stale' | 'warp' | 'atk' | 'calm' | 'idle' | 'atk3' | 'owner' | 'tempo' | 'diag' | 'diagw' | 'two'; char: string; weapon: string;
  rig?: 'knight' | 'slim' | 'scaled'; idlePhase?: number; yaw0?: number;
  fb?: string; breaks?: boolean; segs: Seg[];
  /** Подъём стопы рига (pe_phys.footLift, юниты): высота стоя без `__hipsD` и цель заземления. */
  footLift?: number;
  /** Сид случайности очереди ударов (`mulberry32`) — для пулов ≥ 3. */
  rndSeed?: number;
}
const D45 = 80 / Math.SQRT2;
const DEG = Math.PI / 180;
const ramp = (n: number, to: number): Seg[] => Array.from({ length: n }, (_, i) => ({ n: 1, vx: 0, vz: (to * (i + 1)) / n }));
/** «Мышь»: прицел из `from` в `to` за `n` кадров с разгоном и торможением (smoothstep); скорость хода — `v`. */
const aimRamp = (n: number, from: number, to: number, v: [number, number] = [0, 0], combat?: boolean): Seg[] =>
  Array.from({ length: n }, (_, i) => { const u = (i + 1) / n; return { n: 1, vx: v[0], vz: v[1], aim: from + (to - from) * u * u * (3 - 2 * u), combat }; });
/** Прицел СТУПЕНЯМИ: новое значение раз в `every` кадров (чужой игрок — курс из снапшотов сервера 20 Гц), линейно к `to`. */
const aimSteps = (n: number, from: number, to: number, every: number): Seg[] =>
  Array.from({ length: Math.ceil(n / every) }, (_, i) => ({ n: Math.min(every, n - i * every), vx: 0, vz: 0, aim: from + (to - from) * Math.min(1, ((i + 1) * every) / n) }));
/** Непрерывное вращение прицела: `rate` рад/с, `n` кадров. */
const spin = (n: number, from: number, rate: number): Seg[] =>
  Array.from({ length: n }, (_, i) => ({ n: 1, vx: 0, vz: 0, aim: from + (rate * (i + 1)) / 60 }));
const hold = (n: number, aim: number, v: [number, number] = [0, 0], combat?: boolean): Seg => ({ n, vx: v[0], vz: v[1], aim, combat });
/** Ход под углом `deg` (от +Z к +X) со скоростью `spd`. */
const dirV = (deg: number, spd = 80): [number, number] => [spd * Math.sin(deg * DEG), spd * Math.cos(deg * DEG)];
/** Медленный разгон вперёд до `to` u/с за `n` кадров при прицеле `aim` (пороги «стоим» 0.06 / 0.16 скорости ходьбы — разные кадры). */
const creep = (n: number, to: number, aim: number): Seg[] => Array.from({ length: n }, (_, i) => ({ n: 1, vx: 0, vz: (to * (i + 1)) / n, aim }));
/** Общее у сценариев контента владельца: хранилище, персонаж, риг рыцаря, подъём стопы `pe_phys` владельца, фаза живой стойки. */
const OWNER = { store: 'owner', char: 'warrior', rig: 'knight', footLift: 2.59, idlePhase: 3.7 } as const;
const SCN: Scn[] = [
  { id: 'idle_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 50, vx: 0, vz: 0 }] },
  { id: 'fwd40_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 112, vx: 0, vz: 40 }] },
  { id: 'fwd80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 112, vx: 0, vz: 80 }] },
  { id: 'fwd120_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: 0, vz: 120 }] },
  { id: 'strafeL80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: -80, vz: 0 }] },
  { id: 'strafeR80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: 80, vz: 0 }] },
  { id: 'back80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: 0, vz: -80 }] },
  { id: 'stop_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 70, vx: 0, vz: 80 }, { n: 50, vx: 0, vz: 0 }] },
  { id: 'diag80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 90, vx: D45, vz: D45 }] },
  { id: 'backdiag80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 90, vx: -D45, vz: -D45 }] },
  { id: 'ramp120_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [...ramp(100, 120), { n: 20, vx: 0, vz: 120 }] },
  { id: 'flip80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 50, vx: 80, vz: 0 }, { n: 50, vx: -80, vz: 0 }] },
  { id: 'combat80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 30, vx: 0, vz: 80 }, { n: 60, vx: 0, vz: 80, combat: true }] },
  // ⭐ ДИАГОНАЛИ (07.10): бленд парой соседних направлений; на оси диагонали — она одна; мгновенный разворот — кроссфейд пары
  { id: 'diag_fwd30_axe', store: 'diag', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 90, vx: 80 * Math.sin(Math.PI / 6), vz: 80 * Math.cos(Math.PI / 6) }] },
  { id: 'diag_on45_axe', store: 'diag', char: 'warrior', weapon: 'axe', segs: [{ n: 90, vx: D45, vz: D45 }] },
  { id: 'diag_side100_axe', store: 'diag', char: 'warrior', weapon: 'axe', segs: [{ n: 90, vx: -80 * Math.sin(100 * DEG), vz: 80 * Math.cos(100 * DEG) }] },
  { id: 'diag_back150_axe', store: 'diag', char: 'warrior', weapon: 'axe', segs: [{ n: 90, vx: 80 * Math.sin(150 * DEG), vz: 80 * Math.cos(150 * DEG) }] },
  { id: 'diag_walk60_axe', store: 'diag', char: 'warrior', weapon: 'axe', segs: [{ n: 90, vx: 30 * Math.sin(60 * DEG), vz: 30 * Math.cos(60 * DEG) }] },
  { id: 'diag_flip_axe', store: 'diag', char: 'warrior', weapon: 'axe', segs: [{ n: 50, vx: D45, vz: D45 }, { n: 50, vx: -D45, vz: -D45 }] },
  // доворот таза к ближайшей оси набора: восемь осей, затем только две (вперёд/назад) — остаток сверх потолка скользит
  { id: 'diagw_60_axe', store: 'diagw', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: 80 * Math.sin(60 * DEG), vz: 80 * Math.cos(60 * DEG) }] },
  { id: 'diagw_sweep_axe', store: 'diagw', char: 'warrior', weapon: 'axe', segs: [{ n: 50, vx: D45, vz: D45 }, { n: 50, vx: 80, vz: 0 }, { n: 50, vx: D45, vz: -D45 }] },
  { id: 'two_side80_axe', store: 'two', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: 80, vz: 0 }] },
  { id: 'two_back120_axe', store: 'two', char: 'warrior', weapon: 'axe', segs: [{ n: 100, vx: -80 * Math.sin(120 * DEG), vz: 80 * Math.cos(120 * DEG) }] },
  // ⭐ темп по шагу: правленые шаг ходьбы и бега — часы по `tempoSpeed` (смесь колонок на 60, бег целиком на 80)
  { id: 'tempo_fwd60_80_axe', store: 'tempo', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 60, vx: 0, vz: 60 }, { n: 60, vx: 0, vz: 80 }] },
  { id: 'fwd80_none', store: 'stand', char: 'warrior', weapon: 'none', idlePhase: 2.5, segs: [{ n: 20, vx: 0, vz: 0 }, { n: 90, vx: 0, vz: 80 }] },
  { id: 'mage_fwd80', store: 'stand', char: 'mage', weapon: 'staff', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 90, vx: 0, vz: 80 }, { n: 20, vx: 0, vz: 0 }] },
  { id: 'knight_fwd80_axe', store: 'stand', char: 'warrior', weapon: 'axe', rig: 'knight', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 100, vx: 0, vz: 80 }] },
  { id: 'rich_idle_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 40, vx: 0, vz: 0 }] },
  { id: 'rich_fwd80_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 60, vx: 0, vz: 80 }, { n: 40, vx: 0, vz: 80, combat: true }] },
  { id: 'rich_strafeL80_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 90, vx: -80, vz: 0 }] },
  { id: 'rich_backdiag60_none', store: 'rich', char: 'warrior', weapon: 'none', segs: [{ n: 90, vx: 40, vz: -45 }] },
  { id: 'jump80_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 40, vx: 0, vz: 80 }, { n: 40, vx: 80, vz: 0 }] },
  { id: 'mage_knight_fwd80', store: 'stand', char: 'mage', weapon: 'staff', rig: 'knight', segs: [{ n: 8, vx: 0, vz: 0 }, { n: 80, vx: 0, vz: 80 }] },
  { id: 'rich_knight_fwd80_axe', store: 'rich', char: 'warrior', weapon: 'axe', rig: 'knight', segs: [{ n: 20, vx: 0, vz: 0 }, { n: 80, vx: 0, vz: 80 }] },
  { id: 'rich_mage_combat60', store: 'rich', char: 'mage', weapon: 'staff', segs: [{ n: 30, vx: 0, vz: 60 }, { n: 50, vx: 0, vz: 60, combat: true }, { n: 20, vx: 0, vz: 0, combat: true }] },
  { id: 'rich_walk_sections_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, { n: 90, vx: 0, vz: 30 }, { n: 40, vx: 0, vz: 0 }] },
  { id: 'creep4_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 60, vx: 0, vz: 4 }, { n: 30, vx: 0, vz: 9 }] },
  { id: 'yawed80_axe', store: 'stand', char: 'warrior', weapon: 'axe', yaw0: 0.9,
    segs: [{ n: 10, vx: 0, vz: 0, aim: 0.9 }, { n: 80, vx: 80 * Math.sin(0.9), vz: 80 * Math.cos(0.9), aim: 0.9 }, { n: 30, vx: 0, vz: 0, aim: 0.9 }] },
  { id: 'rich_walkstrafeR30_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, { n: 100, vx: 30, vz: 0 }] },
  { id: 'rich_rogue_fwd80_dagger', store: 'rich', char: 'rogue', weapon: 'dagger', segs: [{ n: 10, vx: 0, vz: 0 }, { n: 60, vx: 0, vz: 80 }] },
  { id: 'rich_rogue_knight_fwd80_dagger', store: 'rich', char: 'rogue', weapon: 'dagger', rig: 'knight', segs: [{ n: 10, vx: 0, vz: 0 }, { n: 60, vx: 0, vz: 80 }] },
  { id: 'rich_combat_stand_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, { n: 40, vx: 0, vz: 0, combat: true }, { n: 40, vx: 0, vz: 50, combat: true }] },
  // ── 4d: повороты на месте клипами (прицел «мышью»), torso-lead, доворот таза под ход ──
  { id: 'turn45R_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(12, 0, 45 * DEG), hold(90, 45 * DEG)] },
  { id: 'turn90L_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(15, 0, -90 * DEG), hold(110, -90 * DEG)] },
  { id: 'turn180R_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(18, 0, 178 * DEG), hold(140, 178 * DEG)] },
  { id: 'flick180L_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, ...aimRamp(12, 0, -178 * DEG), hold(150, -178 * DEG)] },
  { id: 'slow180R_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, ...aimRamp(60, 0, 180 * DEG - 0.01), hold(120, 180 * DEG - 0.01)] },
  { id: 'spin_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, ...spin(180, 0, 2.5), hold(120, 7.5)] },
  { id: 'relax38_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, ...aimRamp(10, 0, 38 * DEG), hold(110, 38 * DEG)] },
  { id: 'small25L_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, ...aimRamp(10, 0, -25 * DEG), hold(100, -25 * DEG)] },
  { id: 'stepped90R_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 10, vx: 0, vz: 0 }, ...aimSteps(30, 0, 90 * DEG, 3), hold(100, 90 * DEG)] },
  { id: 'turn_walk_axe', store: 'stand', char: 'warrior', weapon: 'axe',
    segs: [{ n: 10, vx: 0, vz: 0 }, ...aimRamp(15, 0, 90 * DEG), hold(14, 90 * DEG), hold(60, 90 * DEG, [0, 80]), hold(40, 90 * DEG)] },
  { id: 'walk_turn_stop_axe', store: 'stand', char: 'warrior', weapon: 'axe',
    segs: [{ n: 30, vx: 0, vz: 80 }, ...aimRamp(20, 0, 120 * DEG, [0, 80]), hold(3, 120 * DEG, [0, 80]), hold(110, 120 * DEG)] },
  { id: 'knight_turn90R_axe', store: 'stand', char: 'warrior', weapon: 'axe', rig: 'knight', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(15, 0, 90 * DEG), hold(100, 90 * DEG)] },
  { id: 'mage_turn45L', store: 'stand', char: 'mage', weapon: 'staff', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(12, 0, -50 * DEG), hold(80, -50 * DEG)] },
  { id: 'rich_turn90R_swing_axe', store: 'rich', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(15, 0, 92 * DEG), hold(110, 92 * DEG)] },
  { id: 'rich_combat_turn90L_axe', store: 'rich', char: 'warrior', weapon: 'axe',
    segs: [{ n: 30, vx: 0, vz: 0, combat: true }, ...aimRamp(15, 0, -95 * DEG, [0, 0], true), hold(110, -95 * DEG, [0, 0], true)] },
  { id: 'rich_warp_axe', store: 'rich', char: 'warrior', weapon: 'axe',
    segs: [hold(50, 0, [80 * Math.sin(60 * DEG), 80 * Math.cos(60 * DEG)]), hold(40, 0, [80 * Math.sin(40 * DEG), 80 * Math.cos(40 * DEG)]),
      hold(40, 0, [80 * Math.sin(30 * DEG), 80 * Math.cos(30 * DEG)]), hold(20, 0), hold(30, 0, [80 * Math.sin(50 * DEG), 80 * Math.cos(50 * DEG)]),
      ...aimRamp(20, 0, 70 * DEG, [80 * Math.sin(50 * DEG), 80 * Math.cos(50 * DEG)]), hold(30, 70 * DEG, [80 * Math.sin(-120 * DEG), 80 * Math.cos(-120 * DEG)])] },
  { id: 'rich_warp_ties_axe', store: 'rich', char: 'warrior', weapon: 'axe',
    segs: [hold(40, 0, [D45, D45]), hold(10, 0), hold(40, 0, [-D45, D45]), hold(10, 0), hold(40, 0, [-D45, -D45]), hold(10, 0), hold(40, 0, [D45, -D45])] },
  { id: 'stale_warp_axe', store: 'stale', char: 'warrior', weapon: 'axe',
    segs: [hold(50, 0, [-80, 0]), hold(50, 0, [-40, -70]), hold(30, 0, [70, -40]), hold(20, 0)] },
  { id: 'stale_turn_stand_axe', store: 'stale', char: 'warrior', weapon: 'axe',
    segs: [{ n: 10, vx: 0, vz: 0 }, ...aimRamp(15, 0, 100 * DEG), hold(60, 100 * DEG), ...aimRamp(8, 100 * DEG, 120 * DEG), hold(100, 120 * DEG)] },
  { id: 'warp_diag_axe', store: 'warp', char: 'warrior', weapon: 'axe',
    segs: [hold(40, 0, dirV(60)), ...aimRamp(12, 0, 0.4, dirV(60)), hold(30, 0.4, dirV(60)), hold(40, 0.4, dirV(-100)), hold(20, 0.4)] },
  { id: 'turn_creep_axe', store: 'stand', char: 'warrior', weapon: 'axe',
    segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(15, 0, 90 * DEG), hold(10, 90 * DEG), ...creep(25, 12, 90 * DEG), hold(30, 90 * DEG, [0, 12]), hold(30, 90 * DEG)] },
  // ── 4e: удары (посадка импакта на вайндап, цепочка при зажатой атаке, кроссфейд), ноги и таз удара, состояния, вставки, метки ──
  { id: 'atk_windup_axe', store: 'atk', char: 'warrior', weapon: 'axe', segs: [stand(20), swing(0.5, 0.25), stand(60)] },
  { id: 'atk_plain_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [stand(15), swing(0.5, 0.25), stand(18), swing(0.4, 0.2), stand(50)] },
  { id: 'atk_monster_tele', store: 'atk', char: 'skeleton', fb: 'warrior', weapon: 'axe', segs: [stand(12), swing(0, 0.6), stand(70), swing(0, 0.3), stand(40)] },
  { id: 'atk_combo_hold_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [stand(10), swing(0.5, 0.25, true), stand(29, true), swing(0.5, 0.25, true), stand(29, true), swing(0.5, 0.25, true), stand(15, true), stand(60)] },
  { id: 'atk_combo_late_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [stand(10), swing(0.5, 0.25, true), stand(36, true), swing(0.5, 0.25, true), stand(40, true), stand(30)] },
  { id: 'atk_dagger_chain', store: 'atk', char: 'warrior', weapon: 'dagger', segs: [stand(10), swing(0.3, 0.15), stand(8), swing(0.3, 0.15), stand(40)] },
  { id: 'atk_walk_axe', store: 'atk', char: 'warrior', weapon: 'axe', segs: [{ n: 30, vx: 0, vz: 80 }, { n: 1, vx: 0, vz: 80, atk: { window: 0.5, windup: 0.25 } }, { n: 50, vx: 0, vz: 80 }] },
  { id: 'atk_stop_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [{ n: 30, vx: 0, vz: 60 }, { n: 1, vx: 0, vz: 60, atk: { window: 0.7, windup: 0.35 } }, { n: 6, vx: 0, vz: 60 }, stand(60)] },
  { id: 'atk_combat_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [stand(15), { n: 20, vx: 0, vz: 0, combat: true }, { n: 1, vx: 0, vz: 0, combat: true, atk: { window: 0.5, windup: 0.25 } }, { n: 40, vx: 0, vz: 0, combat: true }, stand(40)] },
  { id: 'atk_swap_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [stand(10), swing(0.5, 0.25), stand(8), { n: 30, vx: 0, vz: 0, weapon: 'sword' }, { n: 1, vx: 0, vz: 0, weapon: 'sword', atk: { window: 0.6, windup: 0.3 } },
      { n: 40, vx: 0, vz: 0, weapon: 'sword' }, { n: 1, vx: 0, vz: 0, weapon: 'sword+shield', atk: { window: 0.6, windup: 0.3 } }, { n: 20, vx: 0, vz: 0, weapon: 'sword+shield' },
      { n: 1, vx: 0, vz: 0, weapon: 'sword+shield', atk: { window: 0.6, windup: 0.3 } }, { n: 50, vx: 0, vz: 0, weapon: 'sword+shield' }] },
  { id: 'atk_states_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [stand(10), { n: 25, vx: 0, vz: 0, stun: true }, stand(5), swing(0.5, 0.25), { n: 6, vx: 0, vz: 0, stun: true }, stand(15),
      { n: 10, vx: 0, vz: 0, downed: true }, { n: 20, vx: 0, vz: 0, downed: true, stun: true }, swing(0.5, 0.25), { n: 20, vx: 0, vz: 0, downed: true }, stand(50)] },
  { id: 'atk_aim_axe', store: 'atk', char: 'warrior', weapon: 'axe', segs: [stand(15), swing(0.5, 0.25), ...aimRamp(10, 0, 90 * DEG), hold(110, 90 * DEG)] },
  { id: 'atk_ability_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: [stand(10), { n: 1, vx: 0, vz: 0, atk: { window: 0.6, windup: 0.3, clips: ['hit_sword', 'hit_axe_b'] } }, stand(25),
      { n: 1, vx: 0, vz: 0, atk: { window: 0.6, windup: 0.3, clips: ['nope'] } }, stand(45)] },
  { id: 'atk_knight_axe', store: 'atk', char: 'warrior', weapon: 'axe', rig: 'knight', segs: [stand(15), swing(0.5, 0.25), stand(40), { n: 30, vx: 0, vz: 70 }] },
  { id: 'steps_run_axe', store: 'atk', char: 'warrior', weapon: 'axe', segs: [stand(8), { n: 90, vx: 0, vz: 110 }, { n: 30, vx: 0, vz: 40 }, stand(20)] },
  { id: 'fidget_axe', store: 'idle', char: 'warrior', weapon: 'axe', breaks: true, idlePhase: 0.3,
    segs: [stand(200), swing(0.5, 0.25), stand(60), { n: 20, vx: 0, vz: 60 }, stand(150)] },
  { id: 'fidget_combat_none', store: 'idle', char: 'warrior', weapon: 'none', breaks: true, idlePhase: 1.1,
    segs: [{ n: 110, vx: 0, vz: 0, combat: true }, { n: 30, vx: 0, vz: 0, combat: true, weapon: 'axe' }, { n: 140, vx: 0, vz: 0, combat: true, weapon: 'axe' }] },
  { id: 'fidget_turnset_axe', store: 'calm', char: 'warrior', weapon: 'axe', breaks: true, idlePhase: 0.3, segs: [stand(120)] },
  // ── частота кадра: 144 Гц, 20 Гц, рваный кадр (ход, остановка, поворот на месте, удар, бой) ──
  { id: 'hz144_mix_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: withDt(1 / 144, [stand(48), { n: 150, vx: 0, vz: 120 }, { n: 60, vx: 50, vz: 0 }, stand(120), ...aimRamp(36, 0, 90 * DEG), hold(260, 90 * DEG),
      { n: 1, vx: 0, vz: 0, aim: 90 * DEG, atk: { window: 0.5, windup: 0.25 } }, hold(110, 90 * DEG), hold(60, 90 * DEG, [0, 0], true)]) },
  { id: 'hz20_mix_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: withDt(1 / 20, [stand(8), { n: 30, vx: 0, vz: 80 }, { n: 12, vx: -60, vz: -40 }, stand(20), ...aimRamp(5, 0, -90 * DEG), hold(40, -90 * DEG),
      { n: 1, vx: 0, vz: 0, aim: -90 * DEG, atk: { window: 0.5, windup: 0.25 } }, hold(20, -90 * DEG), hold(15, -90 * DEG, [80, 0], true), stand(20)]) },
  { id: 'jitter_mix_axe', store: 'atk', char: 'warrior', weapon: 'axe',
    segs: jitter([stand(20), { n: 60, vx: 0, vz: 80 }, { n: 40, vx: D45, vz: D45 }, { n: 25, vx: 0, vz: 30 }, stand(30), ...aimRamp(18, 0, 178 * DEG), hold(90, 178 * DEG),
      swing(0.5, 0.25, true), stand(30, true), swing(0.5, 0.25, true), stand(25, true), stand(30), { n: 40, vx: 0, vz: 0, combat: true }, { n: 30, vx: -80, vz: 0, combat: true }, stand(30)]) },
  { id: 'jitter_knight_axe', store: 'rich', char: 'warrior', weapon: 'axe', rig: 'knight',
    segs: jitter([stand(15), { n: 50, vx: 0, vz: 100 }, stand(25), ...aimRamp(15, 0, -90 * DEG), hold(80, -90 * DEG)]) },
  // ── риги и подъём стопы ──
  { id: 'slim_fwd80_axe', store: 'stand', char: 'warrior', weapon: 'axe', rig: 'slim', segs: [stand(10), { n: 90, vx: 0, vz: 80 }, stand(30)] },
  { id: 'scaled_turn90_axe', store: 'stand', char: 'warrior', weapon: 'axe', rig: 'scaled', segs: [stand(20), ...aimRamp(15, 0, 90 * DEG), hold(100, 90 * DEG), { n: 40, vx: 0, vz: 60 }] },
  { id: 'footlift_rogue_dagger', store: 'rich', char: 'rogue', weapon: 'dagger', footLift: 2.5, segs: [stand(10), { n: 60, vx: 0, vz: 80 }, stand(30)] },
  { id: 'footlift_knight_axe', store: 'stand', char: 'warrior', weapon: 'axe', rig: 'knight', footLift: 1.2, segs: [stand(10), { n: 60, vx: 0, vz: 80 }, stand(30)] },
  // ── очередь из трёх ударов со случайностью; снять лаг таза и выключить вставки посреди кадра ──
  { id: 'atk3_rnd_axe', store: 'atk3', char: 'warrior', weapon: 'axe', rndSeed: 12345,
    segs: [stand(10), swing(0.5, 0.25, true), stand(29, true), swing(0.5, 0.25, true), stand(29, true), swing(0.5, 0.25, true), stand(29, true), swing(0.5, 0.25, true), stand(40, true), stand(40)] },
  { id: 'snap_breaks_axe', store: 'idle', char: 'warrior', weapon: 'axe', breaks: true, idlePhase: 0.3,
    segs: [stand(130), { n: 20, vx: 0, vz: 0, breaks: false }, stand(30), ...aimRamp(6, 0, 1.2), hold(10, 1.2), { n: 1, vx: 0, vz: 0, aim: 2.6, snap: true }, hold(40, 2.6),
      { n: 1, vx: 0, vz: 0, aim: 2.6, breaks: true }, hold(120, 2.6)] },
  // ── 06.10: контент как у владельца (`owner`, рыцарь, подъём стопы 2.59) — стойка с предметом = безоружная стойка + рука предмета ──
  { id: 'owner_idle_none', ...OWNER, weapon: 'none', segs: [stand(300)] },
  { id: 'owner_idle_sword', ...OWNER, weapon: 'sword', segs: [stand(300)] },
  { id: 'owner_idle_noneshield', ...OWNER, weapon: 'none+shield', segs: [stand(240)] },
  { id: 'owner_idle_swordshield', ...OWNER, weapon: 'sword+shield', segs: [stand(240)] },
  { id: 'owner_combat_sword', ...OWNER, weapon: 'sword', segs: [stand(30), { n: 150, vx: 0, vz: 0, combat: true }, stand(60)] },
  { id: 'owner_jiggle_sword', ...OWNER, weapon: 'sword',
    segs: [stand(20), ...Array.from({ length: 180 }, (_, i): Seg => ({ n: 1, vx: 0, vz: 0, aim: 0.12 * Math.sin((2 * Math.PI * 0.7 * (i + 1)) / 60) }))] },
  { id: 'owner_turn90R_sword', ...OWNER, weapon: 'sword', segs: [stand(20), ...aimRamp(12, 0, 90 * DEG), hold(120, 90 * DEG)] },
  { id: 'owner_micro_sword', ...OWNER, weapon: 'sword', segs: [stand(20), { n: 8, vx: 0, vz: 80 }, stand(120)] },
  { id: 'owner_attack_sword', ...OWNER, weapon: 'sword',
    segs: [{ n: 20, vx: 0, vz: 0, combat: true }, { n: 1, vx: 0, vz: 0, combat: true, atk: { window: 0.5, windup: 0.25 } }, { n: 60, vx: 0, vz: 0, combat: true }, stand(40)] },
  { id: 'owner_swap', ...OWNER, weapon: 'none',
    segs: [stand(40), { n: 60, vx: 0, vz: 0, weapon: 'sword' }, { n: 60, vx: 0, vz: 0, weapon: 'sword+shield' }, { n: 60, vx: 0, vz: 0, weapon: 'none+shield' }, { n: 40, vx: 0, vz: 0, weapon: 'axe' }] },
  { id: 'owner_hz144_idle_sword', ...OWNER, weapon: 'sword', segs: withDt(1 / 144, [stand(432)]) },
];
/** Отрезки с заданной длительностью кадра. */
function withDt(dt: number, segs: Seg[]): Seg[] { return segs.map((s) => ({ ...s, dt })); }
/** Рваный кадр: каждый кадр — своя длительность из ряда (1/144…3/60; 2/60 и 3/60 — как пропуски temporal-LOD дальних кукол). */
function jitter(segs: Seg[]): Seg[] {
  const JITTER = [1 / 60, 1 / 144, 1 / 30, 1 / 60, 2 / 60, 1 / 90, 3 / 60, 1 / 120, 1 / 45, 1 / 75];
  let k = 0;
  return segs.flatMap((s) => Array.from({ length: s.n }, (_, i) => ({ ...s, n: 1, dt: JITTER[k++ % JITTER.length]!, atk: i === 0 ? s.atk : undefined })));
}
/** Стоять `n` кадров (атака зажата — `held`). */
function stand(n: number, held?: boolean): Seg { return { n, vx: 0, vz: 0, hold: held }; }
/** Кадр со свингом сервера: окно (lockMs, сек), вайндап (windupMs, сек), зажата ли атака. */
function swing(window: number, windup: number, held?: boolean): Seg { return { n: 1, vx: 0, vz: 0, atk: { window, windup }, hold: held }; }
/** Удар посреди поворота на месте (кадр решения ищется пробным прогоном). */
const ATK_TURN_BASE: Scn = { id: 'atk_in_turn_axe', store: 'atk', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(15, 0, 90 * DEG), hold(110, 90 * DEG)] };
/**
 * Очередь ударов куклы — копия `gamePlayerDoll.attack` (замыкание куклы веба, наружу не экспортируется): пул (позы скила под оружие
 * или базовая атака), «последний сыгранный», `pickAttack`; та же очередь даёт клипы автосцепке (`comboNext`). Пулы сценариев ≤ 2 —
 * случайность не участвует (она бы бросила).
 */
function dollAttack(player: PosePlayer, content: GamePoseContent, rndSeed?: number): { attack(clips: string[] | undefined, windowSec: number, windupSec: number): void } {
  let atkLast: string | null = null;
  const noRnd = rndSeed !== undefined ? mulberry32(rndSeed) : (): number => { throw new Error('пул ударов ≥ 3 без сида: случайность в эталоне не участвует'); };
  return {
    attack(clips, windowSec, windupSec): void {
      const weapon = player.weapon;
      const pool = (clips && clips.length)
        ? clips.map((n) => content.resolveAbilityClip(n, weapon)).filter((c): c is NonNullable<typeof c> => !!c)
        : content.attackClips(weapon);
      const names = pool.map((c) => c.name);
      const take = (): Clip | null => { const i = pickAttack(names, atkLast, ATTACK_VARY, noRnd); return i < 0 ? null : pool[i]!; };
      player.comboNext = pool.length ? () => { const c = take(); if (c) atkLast = c.name; return c; } : null;
      if (pool.length) {
        const c = take();
        if (c && player.triggerAttack(c, windowSec, windupSec)) atkLast = c.name;
      } else player.triggerAttack(content.attackClip(weapon), windowSec, windupSec);
    },
  };
}
/** Смена оружия посреди ШВА поворота (кадры решения/конца клипа ищутся пробным прогоном тех же входов). */
const SWAP_BASE: Scn = { id: 'turn_swap_axe', store: 'stand', char: 'warrior', weapon: 'axe', segs: [{ n: 20, vx: 0, vz: 0 }, ...aimRamp(15, 0, 90 * DEG), hold(110, 90 * DEG)] };
const DT = 1 / 60;
/** Секция слоя хода — номером (`sec` кадра): покой, разгон, цикл, остановка. */
const SECTIONS = ['idle', 'start', 'loop', 'stop'];
/** Развернуть отрезки в покадровый вход. */
const perFrame = (segs: Seg[]): Seg[] => segs.flatMap((s) => Array.from({ length: s.n }, () => ({ ...s, n: 1 })));

/** Внутреннее состояние плеера, которое снимает эталон (поля веба приватные — читаются как есть, без пересчёта). */
type Priv = {
  locoW: number; lockW: number; clipStandY: number; locoSec: { section: string };
  rootYaw: number; turning: boolean; leadRate: number; aimStableFor: number; seamW: number;
  dirWarp: { warp: number; sector: number };
  turn: { clip: { name: string }; t: number; w: number; out: boolean } | null;
  atk: { clip: Clip | null; t: number }; fade: { atk: { clip: Clip | null; t: number }; w: number } | null;
  legsHeld: boolean; atkLegsW: number; atkRate(): number;
  fidget: { clip: string | null; t: number; w: number };
};

describe('эталон G2 локомоции, поворотов и действий клипами для Unity', () => {
  it('пишет __golden__/unity_anim_g2.json', () => {
    const stand = standStore();
    const ov = richOverlay(stand);
    const rich = applyOverlay(stand, ov);
    const ovStale = staleOverlay(rich);
    const ovWarp = warpOverlay(stand);
    const ovDiag: Overlay = { base: 'stand', keys: {}, patch: [], add: diagClips(stand) };
    const ovDiagW: Overlay = { base: 'warp', keys: {}, patch: [], add: diagClips(stand) };
    const ovTempo = tempoOverlay(stand);
    expect(ovTempo.patch.length, 'у стенда нет ходьбы/бега вперёд воина — сценарию темпа нечего проверять').toBeGreaterThan(0);
    const stores: Record<string, Store> = { stand, rich, stale: applyOverlay(rich, ovStale), warp: applyOverlay(stand, ovWarp), tempo: applyOverlay(stand, ovTempo) };
    stores.diag = applyOverlay(stand, ovDiag);
    stores.diagw = applyOverlay(stores.warp!, ovDiagW);
    const ovTwo = twoOverlay(stores.warp!);
    expect(ovTwo.patch.length, 'у стенда нет страйфов воина — сценарию «два клипа» нечего убирать').toBe(4);
    stores.two = applyOverlay(stores.warp!, ovTwo);
    const ovAtk = atkOverlay(rich);
    stores.atk = applyOverlay(rich, ovAtk);
    const ovCalm = calmOverlay(stores.atk);
    stores.calm = applyOverlay(stores.atk, ovCalm);
    const ovIdle = idleOverlay(stores.calm);
    stores.idle = applyOverlay(stores.calm, ovIdle);
    const ovAtk3 = atk3Overlay(stores.atk);
    stores.atk3 = applyOverlay(stores.atk, ovAtk3);
    const ovOwner = ownerOverlay(stand);
    stores.owner = applyOverlay(stand, ovOwner);
    const knight = RIG.atlas[0]!.look;
    const knightRig = { boneOffsets: knight.boneOffsets, boneScale: knight.boneScale, profile: knight.profile && Object.keys(knight.profile).length ? knight.profile : undefined };
    // Риги без модели: неединичный профиль тела (рост/ноги/руки/корпус) и только пер-костные множители (без офсетов).
    const RIGS = {
      knight: knightRig,
      slim: { profile: { height: 1.12, leg: 0.92, arm: 1.06, torso: 1.1 } },
      scaled: { boneScale: { LeftLowerLeg: 1.1, LeftFoot: 0.94, RightUpperLeg: 1.2, Spine: 1.25, LeftUpperArm: 0.9, Neck: 1.3 } },
    };

    const play = (sc: Scn) => {
      useStore(stores[sc.store]!);
      const gx: GXKnobs = { armDown: 1.35, elbowBend: 0.25 };   // GX_DEFAULT куклы игры (`gamePlayerDoll`)
      // Монстр (`fb`): глобальные ручки — от игрока-воина (applyGaitConfig), свои — только gx (loadGaitLocal, без свёртки локтя).
      if (sc.fb) { applyGaitConfig(sc.fb, { armDown: 1.35, elbowBend: 0.25 }); loadGaitLocal(sc.char, gx, sc.fb); }
      else applyGaitConfig(sc.char, gx);                       // тюн класса → глобальные ручки + gx (свёртка локтя)
      const content = localStorageContent(sc.char, sc.fb, BASE_GAIT_CHAR);
      const twist = loadTwistStates(sc.char, sc.fb);
      let player: PosePlayer, human: Humanoid;
      const rigOpts = sc.rig ? RIGS[sc.rig] : {};
      if (sc.rig || sc.footLift !== undefined) {
        human = buildHumanoid(rigOpts);
        if (sc.footLift !== undefined) human.footLift = sc.footLift;   // до плеера: высота стоя меряется при его сборке
        player = new PosePlayer(human, () => [], content, sc.weapon, gx, emptyGrid(), twist);
        setLocoMixOverride(1);
        player.setYaw(0); player.snapYaw(); player.setVel(0, 0);
      } else {
        const st = makeStand({ content, weapon: sc.weapon, gx });
        player = st.player; human = st.human;
        player.twistStates = twist;
      }
      if (sc.idlePhase !== undefined) player.setIdlePhase(sc.idlePhase);
      if (sc.yaw0 !== undefined) { player.setYaw(sc.yaw0); player.snapYaw(); }
      if (sc.breaks) player.setIdleBreaks(true);
      const pr = player as unknown as Priv;
      const doll = dollAttack(player, content, sc.rndSeed);
      // Показ куклы: второй манекен той же геометрии (web `solid`), заземление — состояние `gs` на сценарий.
      const solid = buildHumanoid(rigOpts);
      solid.footLift = human.footLift;
      const gs = { off: 0 };
      const hipW = new THREE.Vector3();
      const frames: unknown[] = [];
      const marks: unknown[] = [];
      const starts: number[] = [], ends: number[] = [];
      let f = 0;
      player.onMark = (e: MarkEvent) => {
        marks.push([f, e.mark.type, e.phase, r6(e.t), e.clip?.name ?? null, e.mark.foot ?? null, e.pace !== undefined ? r6(e.pace) : null]);
      };
      // Кадр шагает КАЖДЫЙ раз, а в эталон идёт каждый третий — и каждый из 8 после смены входа (переходы: доля клипа,
      // кроссфейд колонки, бой, прицел, оружие) или клипа поворота (решение, конец, погас). Разгон по кадру (ramp) сменой не считается.
      let since = 99, prev: Seg | null = null, weapon = sc.weapon, lastTurn: Priv['turn'] = null;
      let lastAtk: Clip | null = null, lastFade: unknown = null, lastFidget: string | null = null;
      for (const s of sc.segs) for (let i = 0; i < s.n; i++, f++) {
        const w = s.weapon ?? sc.weapon;
        if (!prev || Math.hypot(s.vx - prev.vx, s.vz - prev.vz) > 5 || !!s.combat !== !!prev.combat || (s.aim ?? 0) !== (prev.aim ?? 0)
          || w !== (prev.weapon ?? sc.weapon) || !!s.hold !== !!prev.hold || !!s.stun !== !!prev.stun || !!s.downed !== !!prev.downed
          || (s.atk && i === 0) || ((s.snap || s.breaks !== undefined) && i === 0)) since = 0;
        prev = s;
        if (w !== weapon) { player.setWeapon(w); weapon = w; }
        // Порядок кадра игры: ввод (атака зажата) → события сервера (свинг) → привод снапшота (driveActor) → шаг куклы.
        player.attackHold = !!s.hold;
        if (s.atk && i === 0) doll.attack(s.atk.clips, s.atk.window, s.atk.windup);
        if (s.breaks !== undefined && i === 0) player.setIdleBreaks(s.breaks);
        player.setVel(s.vx, s.vz); player.setYaw(s.aim ?? 0); player.setCombat(!!s.combat);
        if (s.snap && i === 0) player.snapYaw();   // после setYaw — как кукла игры на телепорте
        player.setState(!!s.stun, !!s.downed);
        const dt = s.dt ?? DT;
        player.step(dt);
        // Кинематический показ (web renderKinematicPose): поза → манекен показа, таз = таз позы + сдвиг, затем groundFeet.
        human.root.updateMatrixWorld(true);
        human.bones.get('Hips')!.getWorldPosition(hipW);
        solid.reset();
        for (const [nm, b] of human.bones) solid.bones.get(nm)?.quaternion.copy(b.quaternion);
        solid.setHipsWorld(hipW.x, hipW.y + gs.off, hipW.z);
        solid.root.updateMatrixWorld(true);
        groundFeet(solid, hipW.y, gs, dt, () => 0, player.groundSupport,
          { w: player.groundWeights, lag: GAIT.gndLag, flat: player.plantWeights, still: player.moveMag < 0.02 });
        if (pr.turn !== lastTurn) {
          since = 0;
          if (pr.turn && !lastTurn) starts.push(f);
          if (!pr.turn && lastTurn) ends.push(f);
          lastTurn = pr.turn;
        }
        if (pr.atk.clip !== lastAtk || pr.fade !== lastFade || pr.fidget.clip !== lastFidget) {
          since = 0; lastAtk = pr.atk.clip; lastFade = pr.fade; lastFidget = pr.fidget.clip;
        }
        const rec = since++ < 8 || f % 3 === 2;
        if (!rec) continue;
        const q: number[] = [];
        for (const nm of BONES) { const b = human.bones.get(nm)!.quaternion; q.push(r5(b.x), r5(b.y), r5(b.z), r5(b.w)); }
        const hp = human.bones.get('Hips')!.position;
        const sup = player.groundSupport;
        const tn = pr.turn;
        frames.push({
          f, q, hp: [r5(hp.x), r5(hp.y), r5(hp.z)],
          ph: r6(player.clipPhaseNow), u: r6(locoPhaseU(player.clipPhaseNow)), lw: r6(pr.locoW), kw: r6(pr.lockW),
          c: (sup[0] ? 1 : 0) + (sup[1] ? 2 : 0), sy: r5(pr.clipStandY), sec: SECTIONS.indexOf(pr.locoSec.section),
          ry: r6(pr.rootYaw), wp: r6(pr.dirWarp.warp), ws: pr.dirWarp.sector, tg: pr.turning ? 1 : 0, lr: r6(pr.leadRate),
          as: r6(pr.aimStableFor), tn: tn ? tn.clip.name : null, tt: tn ? r6(tn.t) : 0, tw: tn ? r6(tn.w) : 0, to: tn?.out ? 1 : 0,
          sw: r6(pr.seamW),
          an: pr.atk.clip ? pr.atk.clip.name : null, at: r6(pr.atk.t), ar: pr.atk.clip ? r6(pr.atkRate()) : 0,
          fn: pr.fade ? pr.fade.atk.clip?.name ?? null : null, ft: pr.fade ? r6(pr.fade.atk.t) : 0, fw: pr.fade ? r6(pr.fade.w) : 0,
          lh: pr.legsHeld ? 1 : 0, lg: r6(pr.atkLegsW),
          fg: pr.fidget.clip, fgt: pr.fidget.clip ? r6(pr.fidget.t) : 0, fgw: r6(pr.fidget.w),
          gd: [r5(solid.hipsWorldY()), r6(gs.off), ...GROUND_BONES.flatMap((nm) => { const b = solid.bones.get(nm)!.quaternion; return [r5(b.x), r5(b.y), r5(b.z), r5(b.w)]; })],
        });
      }
      // Ручки, которыми кадр реально считался: Unity сверяет с ними свой разбор `pe_gait` (applyGaitConfig + foldElbow).
      const knobs = {
        gait: Object.fromEntries(['speedWalk', 'speedRun', 'dutyWalk', 'dutyRun', 'combatBlend', 'stancePelvis', 'stancePelvisYaw', 'standY',
          'warpOn', 'warpMax', 'warpSmooth', 'warpRate', 'gndLag']
          .map((k) => [k, (GAIT as unknown as Record<string, number>)[k]])),
        gx: { ...gx }, asym: clone(ASYM), combat: clone(COMBAT),
      };
      return { out: { id: sc.id, store: sc.store, char: sc.char, fb: sc.fb ?? null, weapon: sc.weapon, rig: sc.rig ?? null, idlePhase: sc.idlePhase ?? null,
        yaw0: sc.yaw0 ?? null, breaks: !!sc.breaks, footLift: sc.footLift ?? null, rndSeed: sc.rndSeed ?? null, segs: sc.segs, knobs, frames, marks }, starts, ends };
    };

    // Смена оружия: на 3-м кадре шва решения (меч) и на 3-м кадре шва конца клипа (обратно топор) — шов снимается заново.
    const probe = play(SWAP_BASE);
    expect(probe.starts.length).toBeGreaterThan(0);
    expect(probe.ends.length).toBeGreaterThan(0);
    const swapSegs: Seg[] = perFrame(SWAP_BASE.segs).map((s, f) => ({
      ...s, weapon: f >= probe.starts[0]! + 3 && f < probe.ends[0]! + 3 ? 'sword' : undefined,
    }));
    const SWAP: Scn = { ...SWAP_BASE, segs: swapSegs };
    // Удар на 3-м кадре поворота на месте: поворот доигрывает (ноги — у него, «крутимся» — ноги удару не отдаются).
    const probeT = play(ATK_TURN_BASE);
    expect(probeT.starts.length).toBeGreaterThan(0);
    const ATK_TURN: Scn = { ...ATK_TURN_BASE, segs: perFrame(ATK_TURN_BASE.segs).map((s, f) => (f === probeT.starts[0]! + 3 ? { ...s, atk: { window: 0.5, windup: 0.25 } } : s)) };

    const runs = [...SCN, SWAP, ATK_TURN].map((sc) => play(sc));
    const scenarios = runs.map((r) => r.out);
    expect(scenarios.length).toBe(SCN.length + 2);
    type Fr = { lw: number; ph: number; sec: number; tn: string | null; to: number; ws: number; wp: number; tg: number; lr: number; sw: number; c: number };
    const frOf = (id: string): Fr[] => scenarios.find((s) => s.id === id)!.frames as Fr[];
    const turnsOf = (id: string): string[] => { const out: string[] = []; for (const fr of frOf(id)) if (fr.tn && fr.tn !== out[out.length - 1]) out.push(fr.tn); return out; };
    // Сторож сути: на ходу клипы ДОЛЖНЫ играть (иначе эталон мерил бы скольжение в стойке, а не локомоцию).
    const fwd = frOf('fwd80_axe');
    expect(fwd[fwd.length - 1]!.lw).toBeGreaterThan(0.99);
    expect(fwd[fwd.length - 1]!.ph).toBeGreaterThan(Math.PI);
    // …и ветки, ради которых заведена синтетика, реально пройдены: разгон, цикл и остановка по секциям.
    expect([...new Set(frOf('rich_walk_sections_axe').map((f) => f.sec))].sort()).toEqual([0, 1, 2, 3]);
    // Повороты на месте: величина — ближайшая к итогу движения прицела, ОДНИМ клипом (рывок не дробится на 45° + …).
    expect(turnsOf('turn45R_axe')).toEqual(['turn_R_45']);
    expect(turnsOf('turn90L_axe')).toEqual(['turn_L_90']);
    expect(turnsOf('turn180R_axe')).toEqual(['turn_R_180']);
    expect(turnsOf('flick180L_axe')).toEqual(['turn_L_180']);
    expect(turnsOf('spin_axe').length).toBeGreaterThan(1);                      // упор скрутки — поворот без ожидания, цепочкой
    expect(turnsOf('relax38_axe')).toEqual(['turn_R_45']);                      // малый остаток доворачивается после relaxTime
    expect(turnsOf('small25L_axe')).toEqual([]);                                // меньше наименьшего доворота — остаётся скруткой
    expect(turnsOf('rich_turn90R_swing_axe')).toEqual(['turn_R_90']);
    expect(frOf('rich_turn90R_swing_axe').some((f) => f.tn && f.c !== 3)).toBe(true);   // опора — из канала клипа поворота
    expect(frOf('turn_walk_axe').some((f) => f.to === 1)).toBe(true);           // пошли посреди поворота — клип гаснет
    expect(frOf('walk_turn_stop_axe').some((f) => f.lr > 0 && !f.tn)).toBe(true);   // таз доторможивает после остановки
    expect(turnsOf('stale_turn_stand_axe')).toEqual([]);                        // поворотов нет — таз ведёт stepTorsoLead
    expect(frOf('stale_turn_stand_axe').some((f) => f.tg === 1)).toBe(true);
    expect(frOf('turn_swap_axe').some((f) => f.sw > 0)).toBe(true);
    expect(frOf('turn_creep_axe').some((f) => f.to === 1)).toBe(true);         // медленный старт посреди поворота — гашение
    expect(frOf('warp_diag_axe').some((f) => Math.abs(f.wp) > 0.2)).toBe(true);   // доворот без рыска кости и таза стойки
    // Доворот: сектора с переброской, ничья ±45° → вперёд, ±135° → назад; старая складка — только вперёд/назад.
    expect(new Set(frOf('rich_warp_axe').map((f) => f.ws))).toEqual(new Set([0, 1, 2]));
    expect(frOf('rich_warp_axe').some((f) => Math.abs(f.wp) > 0.3)).toBe(true);
    expect(new Set(frOf('rich_warp_ties_axe').map((f) => f.ws))).toEqual(new Set([0, 2]));
    const staleW = frOf('stale_warp_axe');
    expect(new Set(staleW.map((f) => f.ws))).toEqual(new Set([0, 2]));
    expect(staleW.some((f) => Math.abs(f.wp) > 0.3)).toBe(true);
    // ── 4e: ветки слота действия реально пройдены ──
    type AF = { f: number; an: string | null; fn: string | null; lh: number; fg: string | null };
    const afOf = (id: string): AF[] => scenarios.find((s) => s.id === id)!.frames as unknown as AF[];
    const mkOf = (id: string): unknown[][] => scenarios.find((s) => s.id === id)!.marks as unknown[][];
    const clipsOf = (id: string): string[] => { const out: string[] = []; for (const fr of afOf(id)) if (fr.an && fr.an !== out[out.length - 1]) out.push(fr.an); return out; };
    // импакт садится на вайндап сервера (свинг на кадре 20, вайндап 0.25 с = 15 кадров)
    const imp = mkOf('atk_windup_axe').find((m) => m[1] === 'impact')!;
    expect(Math.abs(((imp[0] as number) - 20 + 1) * DT - 0.25)).toBeLessThanOrEqual(DT);
    expect(mkOf('atk_windup_axe').some((m) => m[1] === 'swing' && m[2] === 'begin')).toBe(true);   // метка на t = 0 — на первом кадре
    expect(clipsOf('atk_combo_hold_axe').length).toBeGreaterThanOrEqual(3);                        // цепочка: автосцепка и свинги
    expect(afOf('atk_combo_hold_axe').some((f) => f.fn)).toBe(true);                               // кроссфейд уходящего удара
    expect(afOf('atk_plain_axe').some((f) => f.fn)).toBe(true);
    expect(afOf('atk_walk_axe').every((f) => f.lh === 0)).toBe(true);                              // на ходу ноги у локомоции
    expect(afOf('atk_stop_axe').some((f) => f.lh === 1)).toBe(true);                              // встали посреди удара — ноги удару
    expect(afOf('atk_in_turn_axe').every((f) => f.lh === 0)).toBe(true);                           // поворот — ноги не отдаются
    expect(clipsOf('atk_states_axe')).toEqual(expect.arrayContaining(['react_stagger', 'react_fall', 'react_getup']));
    expect(clipsOf('atk_monster_tele').length).toBeGreaterThanOrEqual(2);
    expect(new Set(clipsOf('atk_swap_axe'))).toEqual(new Set(['hit_axe', 'hit_sword', 'hit_sword+shield', 'hit_sword+shield_2']));
    expect(mkOf('steps_run_axe').some((m) => m[1] === 'footstep' && m[4] === 'run_fwd')).toBe(true);   // шаги из меток клипа
    expect(mkOf('fwd80_axe').some((m) => m[1] === 'footstep' && m[4] === null)).toBe(true);           // шаги из касаний опоры
    expect(afOf('fidget_axe').some((f) => f.fg)).toBe(true);
    expect(afOf('fidget_combat_none').some((f) => f.fg)).toBe(true);
    expect(afOf('fidget_combat_none').some((f) => f.f >= 110 && f.f < 113 && f.fg)).toBe(true);   // смена оружия посреди вставки — гашение
    // свинг позже окна перехвата (13 кадров после автосцепки > 0.2 с) — новый удар, а не уточнение темпа
    expect(afOf('atk_combo_late_axe').some((f) => f.f === 47 && f.fn === 'hit_axe_b')).toBe(true);
    expect(afOf('fidget_combat_none').some((f) => f.fg === 'fidget_guard')).toBe(true);           // боевая ось — свой пул
    expect(afOf('atk_dagger_chain').some((f) => f.fn === 'hit_dagger')).toBe(true);
    expect(mkOf('atk_in_turn_axe').some((m) => m[1] === 'footstep' && m[4] === 'turn_R_90')).toBe(true);   // шаги поворота — из меток
    expect(afOf('fidget_turnset_axe').every((f) => !f.fg)).toBe(true);   // набор поворотов — «решаем о повороте» стоя всегда

    // ── 06.10: стойка с предметом = безоружная + рука предмета. Ноги, таз и заземление с мечом / щитом / парой — РОВНО
    // безоружные на каждом кадре (до правки одиночный предмет отдавал стойку целиком, и опорные стопы плыли), а рука — своя.
    type OF = { f: number; q: number[]; hp: number[]; gd: number[] };
    const ofOf = (id: string): OF[] => scenarios.find((s) => s.id === id)!.frames as unknown as OF[];
    const LEGS = [0, 14, 15, 16, 17, 18, 19, 20, 21];   // Hips + кости ног в `BONES`
    const RUA = BONES.indexOf('RightUpperArm'), LUA = BONES.indexOf('LeftUpperArm');
    const free = ofOf('owner_idle_none');
    for (const [id, arm] of [['owner_idle_sword', RUA], ['owner_idle_noneshield', LUA], ['owner_idle_swordshield', RUA]] as const) {
      const fr = ofOf(id);
      expect(fr.length).toBeGreaterThan(50);
      let armDiff = 0;
      fr.forEach((x, i) => {   // безоружный сценарий длиннее — кадры совпадают номерами на общей длине
        const y = free[i]!;
        expect(x.f).toBe(y.f);
        for (const b of LEGS) for (let j = 0; j < 4; j++) expect(Math.abs(x.q[b * 4 + j]! - y.q[b * 4 + j]!), `${id} кадр ${x.f} кость ${BONES[b]}`).toBeLessThan(2e-5);
        for (let j = 0; j < 3; j++) expect(Math.abs(x.hp[j]! - y.hp[j]!), `${id} кадр ${x.f} таз`).toBeLessThan(2e-5);
        for (let j = 0; j < x.gd.length; j++) expect(Math.abs(x.gd[j]! - y.gd[j]!), `${id} кадр ${x.f} заземление`).toBeLessThan(2e-5);
        for (let j = 0; j < 4; j++) armDiff = Math.max(armDiff, Math.abs(x.q[arm * 4 + j]! - y.q[arm * 4 + j]!));
      });
      expect(armDiff, `${id}: рука предмета обязана отличаться от безоружной`).toBeGreaterThan(0.05);
    }

    const golden = {
      note: 'Эталон G2 паритета Unity ↔ веб: локомоция, повороты и слот действия (удары, состояния, вставки, метки) клипами («только клипы») покадрово, заземление стоп показа (groundFeet), разная частота кадра — настоящий PosePlayer веба через стенд parityHarness на закреплённом контенте. Генерит packages/client/src/render3d/unityAnimFramesGolden.gen.test.ts.',
      dt: DT, bones: BONES,
      stores: { stand, rich: { keys: ov.keys, patch: ov.patch, add: ov.add }, stale: ovStale, warp: ovWarp, tempo: ovTempo, diag: ovDiag, diagw: ovDiagW, two: ovTwo, atk: ovAtk, calm: ovCalm, idle: ovIdle, atk3: ovAtk3, owner: ovOwner },
      rigs: RIGS, groundBones: GROUND_BONES,
      scenarios,
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unity_anim_g2.json'), JSON.stringify(golden));
  }, 240_000);
});
