// ── Общий runtime-пайплайн позинга (Ф5): редактор И игра гонят бег/idle-стойки/удары ОДНИМ кодом ──
// Чистые функции: берут human (humanoid.ts), меши оружия, крутилки GX и провайдер контента ЯВНЫМИ параметрами
// (без модульных глобалов), поэтому переиспользуются и в pose-editor.ts (превью), и в игре (gamePlayerDoll.ts, per игрок).
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { PoseDriver, GAIT, POSE, HIP_DX, FOOT_Y, type PoseTargets } from './pose.js';

export type Pose = Record<string, [number, number, number]>;
export interface Keyframe { pose: Pose; t: number }
export interface Clip { name: string; character: string; weapon: string; loop: boolean; keys: Keyframe[]; idleEnds?: boolean }   // idleEnds: первый/последний кадр = idle-стойка (заблокированы в редакторе, синкаются из стойки — как у ударов hit_)
export interface UpperPose { pose: Pose; swing: number }        // idle-поза верха + остаточный мах (0..1)
export interface GXKnobs { armDown: number; elbowBend: number; armDownRun?: number; elbowBendRun?: number }   // *Run — раздельно для бега (интерп по sb); нет → = ходьба. legWidth убран (дубль stanceWidth)
/**
 * Скрутка корпуса (torso-lead): голова/плечи ведут за ПРИЦЕЛОМ, таз догоняет прицел. ОДНА система стоя и на бегу.
 * `threshold` — мёртвая зона (рад): пока |прицел−таз| ≤ неё, таз ДЕРЖИТСЯ, разница «размазана» по позвоночнику (голова ведёт).
 * `turnRate` — скорость доворота таза (рад/с). КРИТИЧНО для стоп-шагов: таз кормит планировщик; слишком быстро →
 *   обе стопы за кадр = прыжок; слишком медленно + лаг → семенит. ~3 рад/с: за приставной шаг (0.18с) таз повернётся
 *   < turnStepDist → стопы переступают поочерёдно и успевают.
 * `maxTwist` — кламп скрутки ВЕРХА (рад): голова/спина не выворачиваются сверх порога.
 * `relaxTime` — сек: если прицел стабилен столько, а таз лагает (скрутка есть) — таз доворачивается к прицелу (скрутка→0,
 *   выравнивание в нейтраль). Т.е. torso-lead = лид ТОЛЬКО пока активно водишь прицелом; замер на цели → корпус выравнивается.
 * `weights` — распределение скрутки по цепочке [Spine, Chest, UpperChest, Neck, Head] (в сумме ~1 → голова доходит до прицела).
 * ПОД БУДУЩЕЕ: профиль умножается на модификатор класса брони (латы → меньше сегментов/порог, лёгкая → свободнее).
 */
export interface TwistProfile { threshold: number; turnRate: number; maxTwist: number; relaxTime: number; weights: [number, number, number, number, number]; headLook: number; headPitch: number }
// headLook 0..1: стабилизация ГОЛОВЫ на прицел в МИР-yaw (компенсирует свинг корпуса от удара). 1 = строго на курсор, 0 = голова
// целиком едет с телом (старое поведение). ~0.85 = смотрит на курсор + чуть гуляет (подмес движения). Зовётся ПОСЛЕ applyTorsoTwist.
// headPitch (рад): ЦЕЛЕВОЙ кивок головы (0 = ровно/горизонт, <0 = смотрит вниз). Убирает НАСЛЕДОВАННЫЙ кивок от свинга корпуса
// (удар качает грудь/спину → голова-ребёнок ныряет). Тем же весом headLook голова уводится к этому кивку, а не к свинг-нырку.
export const TWIST_DEFAULT = (): TwistProfile => ({ threshold: 0.70, turnRate: 3, maxTwist: 1.4, relaxTime: 1.2, weights: [0.15, 0.25, 0.30, 0.15, 0.15], headLook: 0.85, headPitch: 0 });
// Скрутка корпуса настраивается ПО СОСТОЯНИЮ ДВИЖЕНИЯ (стой/ходьба/бег) — в игре эффективный профиль блендится ПЛАВНО
// по скорости (3 якоря), в редакторе каждая кнопка правит свой профиль. Хранилище pe_twist: либо плоский (легаси —
// применяется на все 3), либо { stand?, walk?, run? } частичных профилей.
export type TwistState = 'stand' | 'walk' | 'run';
export interface TwistStates { stand: TwistProfile; walk: TwistProfile; run: TwistProfile }
export const TWIST_STATES_DEFAULT = (): TwistStates => ({ stand: TWIST_DEFAULT(), walk: TWIST_DEFAULT(), run: TWIST_DEFAULT() });
type TwistPartial = Partial<TwistProfile>;
export type TwistCfgStored = TwistPartial & Partial<Record<TwistState, TwistPartial>>;
const mergeTwist = (c: TwistPartial | undefined): TwistProfile => {
  const d = TWIST_DEFAULT();
  return { ...d, ...c, weights: (c?.weights && c.weights.length === 5 ? [...c.weights] as TwistProfile['weights'] : d.weights) };
};
const isPerStateTwist = (raw: TwistCfgStored | undefined): boolean => !!raw && ('stand' in raw || 'walk' in raw || 'run' in raw);
/** Развернуть хранимый конфиг pe_twist в 3 полных профиля. Легаси плоский → на все 3; per-state с пропусками: бег←ходьба←стой. */
export function resolveTwistStates(raw: TwistCfgStored | undefined): TwistStates {
  if (isPerStateTwist(raw)) {
    const r = raw as Partial<Record<TwistState, TwistPartial>>;
    const stand = mergeTwist(r.stand);
    const walk = r.walk ? mergeTwist(r.walk) : { ...stand };
    const run = r.run ? mergeTwist(r.run) : { ...walk };
    return { stand, walk, run };
  }
  const flat = mergeTwist(raw as TwistPartial | undefined);
  return { stand: flat, walk: { ...flat }, run: { ...flat } };
}
const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Записать смешанный профиль скрутки в out (in-place, БЕЗ аллокаций — для горячего цикла). */
function lerpTwistInto(out: TwistProfile, a: TwistProfile, b: TwistProfile, t: number): TwistProfile {
  out.threshold = lerpN(a.threshold, b.threshold, t); out.turnRate = lerpN(a.turnRate, b.turnRate, t);
  out.maxTwist = lerpN(a.maxTwist, b.maxTwist, t); out.relaxTime = lerpN(a.relaxTime, b.relaxTime, t);
  out.headLook = lerpN(a.headLook, b.headLook, t); out.headPitch = lerpN(a.headPitch, b.headPitch, t);
  for (let i = 0; i < 5; i++) out.weights[i] = lerpN(a.weights[i]!, b.weights[i]!, t);
  return out;
}
/** Линейно смешать два профиля скрутки в НОВЫЙ объект (тесты/редкие вызовы). */
export function lerpTwist(a: TwistProfile, b: TwistProfile, t: number): TwistProfile { return lerpTwistInto(TWIST_DEFAULT(), a, b, t); }
const _twBlend = TWIST_DEFAULT();   // scratch: blendTwist зовётся на каждого актёра каждый кадр → пишем сюда, результат потребляется СИНХРОННО в step (не удерживается)
/** Эффективный профиль скрутки по скорости: 3 якоря (стой@0, ходьба@speedWalk, бег@speedRun), кусочно-линейно.
 *  Пишет в общий scratch БЕЗ аллокаций (результат используется сразу в том же кадре — между актёрами не пересекается). */
export function blendTwist(s: TwistStates, speed: number): TwistProfile {
  const w = GAIT.speedWalk, r = Math.max(w + 1, GAIT.speedRun);
  if (speed <= w) return lerpTwistInto(_twBlend, s.stand, s.walk, clamp(speed / Math.max(1, w), 0, 1));
  return lerpTwistInto(_twBlend, s.walk, s.run, clamp((speed - w) / (r - w), 0, 1));
}
const TWIST_BONES = ['Spine', 'Chest', 'UpperChest', 'Neck', 'Head'] as const;
/** Провайдер контента: даёт idle-стойку (полная поза) + swing по оружию. Редактор — из живой библиотеки; игра — из localStorage.
 *  `shieldOverlay` — отдельная поза щита (левая рука+корпус из `стойка_shield`) + вес подмешивания (авторится в редакторе). */
export interface PoseContent {
  resolveUpper(weapon: string, combat?: number): UpperPose | null;   // combat 0..1 — блендит relaxed idle ↔ combat_idle (боевая стойка)
  shieldOverlay?(weaponKey: string): { pose: Pose; mix: number } | null;   // per-оружие: поза стойка_<wk> (фолбэк стойка_shield) + mix
}
/** Активный удар: клип + время (сек). Верх наложится поверх idle/маха с огибающей. */
export interface AttackState { clip: Clip | null; t: number }

export const WPN_KEYS = ['__wpnMain', '__wpnOff'];              // спец-ключи позы: поворот оружия
export const WPN_POS = ['__wpnMainP', '__wpnOffP'];            // спец-ключи позы: позиция оружия
export const UPPER_BONES = ['Chest', 'UpperChest', 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand'];
const ATK_BONES = ['LeftUpperArm', 'RightUpperArm', 'LeftLowerArm', 'RightLowerArm', 'Chest', 'UpperChest', 'LeftShoulder', 'RightShoulder', 'LeftHand', 'RightHand', 'Spine'];
// Кости, которые перекрывает ЩИТ-оверлей: левая рука (держит щит) + корпус (лёгкий разворот к щиту). Аддитивно, с весом.
export const SHIELD_BONES = ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'Spine', 'Chest', 'UpperChest'];
// Спад влияния стойки щита ПО ДИСТАНЦИИ ОТ ЩИТА (кисть 1.0 → корпус ~0). Применяется ТОЛЬКО во время удара (× огибающая):
// в покое щит держит всё (guard), а на ударе кисть держит щит, а локоть/плечо/корпус свободны для маха.
const SHIELD_FALLOFF: Record<string, number> = { LeftHand: 1, LeftLowerArm: 0.38, LeftUpperArm: 0.22, LeftShoulder: 0.15, UpperChest: 0.1, Chest: 0.07, Spine: 0.04 };
/** Убрать суффикс '+shield' — позы/удары берём по БАЗОВОМУ оружию, щит идёт отдельным оверлеем. */
export const baseWeapon = (w: string): string => (w.endsWith('+shield') ? w.slice(0, -'+shield'.length) : w);
/** Миграция старой конвенции имён клипов на новую (idle_/hit_): стойка_<w>→idle_<w>, удар_<w>→hit_<w>.
 *  Применяется при чтении, чтобы старые сохранённые клипы/ссылки (poseClips) работали без разрушительной миграции.
 *  Новые префиксы (idle_/hit_/s_hit_) и произвольные имена не трогаются. */
export const migratePoseName = (name: string): string =>
  name.startsWith('стойка_') ? 'idle_' + name.slice('стойка_'.length)
    : name.startsWith('удар_') ? 'hit_' + name.slice('удар_'.length)
      : name;
/** Ретаргет имени клипа при копировании в другое оружие: конвенционное `<idle_|hit_|s_hit_><fromW>` → `<prefix><toW>`;
 *  иначе если имя содержит подстроку fromW — заменить первое вхождение; иначе имя без изменений. */
export function retargetClipName(name: string, fromW: string, toW: string): string {
  for (const p of ['combat_idle_', 'idle_', 'hit_', 's_hit_']) if (name === p + fromW) return p + toW;
  return fromW && name.includes(fromW) ? name.replace(fromW, toW) : name;
}
const AB_IN = 0.1, AB_OUT = 0.14;                              // огибающая входа/выхода удара (сек)

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const clipDur = (c: Clip): number => (c.keys.length ? c.keys[c.keys.length - 1]!.t : 0);
// Интерп ПОВОРОТОВ кадров — кватернионный SLERP (истинная кратчайшая дуга, без gimbal): линейный лерп эйлеров (даже с
// обёрткой углов) на многоосевых кадрах прокручивает кость на ~360° (полный оборот руки между кадрами удара). slerp учитывает
// двойное покрытие (q/−q = один поворот) → всегда короткий путь. Позиц-ключи (…P) и скаляры (__match/__pinKp=6000!) — линейно.
const _btA = new THREE.Quaternion(), _btB = new THREE.Quaternion(), _btEA = new THREE.Euler(), _btEB = new THREE.Euler(), _btER = new THREE.Euler();
export function blendTwo(a: Pose, b: Pose, t: number): Pose {   // Σ поз по ключам (union), лерп (повороты — slerp'ом)
  const out: Pose = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const pa = a[k] ?? [0, 0, 0], pb = b[k] ?? [0, 0, 0];
    const ang = k[0] !== '_' || k === '__wpnMain' || k === '__wpnOff' || k === '__lgripR';   // повороты: кости+оружие+грип
    if (ang) { _btA.setFromEuler(_btEA.set(pa[0] ?? 0, pa[1] ?? 0, pa[2] ?? 0)); _btB.setFromEuler(_btEB.set(pb[0] ?? 0, pb[1] ?? 0, pb[2] ?? 0)); _btER.setFromQuaternion(_btA.slerp(_btB, t)); out[k] = [_btER.x, _btER.y, _btER.z]; }
    else out[k] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];   // позиции(…P)/скаляры — линейно
  }
  return out;
}
export function clipPoseAt(c: Clip, t01: number): Pose {        // поза клипа на нормализованной фазе 0..1
  const ks = c.keys; if (!ks.length) return {}; if (ks.length < 2) return ks[0]!.pose;
  const dur = clipDur(c) || 1, time = clamp(t01, 0, 1) * dur;
  let i = 0; while (i < ks.length - 2 && ks[i + 1]!.t <= time) i++;
  const a = ks[i]!, b = ks[i + 1]!, span = b.t - a.t;
  return blendTwo(a.pose, b.pose, span > 1e-6 ? clamp((time - a.t) / span, 0, 1) : 0);
}

// ── Общий two-bone IK (закон косинусов) — для off-hand хвата (двуручное) и переиспользования редактором ──
const _ik0 = new THREE.Vector3(), _ik1 = new THREE.Vector3(), _ik2 = new THREE.Vector3(), _ik3 = new THREE.Vector3(), _ik4 = new THREE.Vector3(), _ik5 = new THREE.Vector3(), _ik6 = new THREE.Vector3();
const _ikA = new THREE.Vector3(), _ikB = new THREE.Vector3(), _ikq = new THREE.Quaternion(), _ikq2 = new THREE.Quaternion();
/** Аналитический two-bone IK: root/mid/end к targetWorld; pole — сторона изгиба сустава; endQuatWorld (опц.) — мировая
 *  ориентация конца (кисть). Длины и оси костей берутся из локальных оффсетов рига, поэтому работает и для руки, и для ноги. */
export function solveTwoBoneIK(human: Humanoid, rootN: string, midN: string, endN: string, targetWorld: THREE.Vector3, endQuatWorld: THREE.Quaternion | null, pole: THREE.Vector3): void {
  const root = human.bones.get(rootN), mid = human.bones.get(midN), end = human.bones.get(endN);
  if (!root || !mid || !end) return;
  const aimRoot = _ik0.copy(mid.position).normalize(), aimMid = _ik1.copy(end.position).normalize();
  const L1 = mid.position.length(), L2 = end.position.length();
  root.updateMatrixWorld();
  const rp = root.getWorldPosition(_ik2);
  const dir = _ik3.copy(targetWorld).sub(rp);
  let d = dir.length(); d = clamp(d, Math.abs(L1 - L2) + 0.5, L1 + L2 - 0.5); dir.normalize();
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const bend = _ik4.crossVectors(dir, pole); if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1); else bend.normalize();
  const midPos = _ik5.copy(rp).addScaledVector(_ik6.copy(dir).applyAxisAngle(bend, a), L1);
  aimBone(root, aimRoot, midPos); aimBone(mid, aimMid, targetWorld);
  if (endQuatWorld) { end.updateMatrixWorld(); end.quaternion.copy(end.parent!.getWorldQuaternion(_ikq).invert().multiply(endQuatWorld)); end.updateMatrixWorld(); }
}
function aimBone(bone: THREE.Object3D, aim: THREE.Vector3, t: THREE.Vector3): void {   // повернуть кость так, чтобы её локальная ось aim смотрела в мир-точку t
  bone.updateMatrixWorld();
  const bp = bone.getWorldPosition(_ikA);
  const pq = bone.parent!.getWorldQuaternion(_ikq2).invert();
  const desired = _ikB.copy(t).sub(bp).normalize().applyQuaternion(pq);
  bone.quaternion.setFromUnitVectors(aim, desired); bone.updateMatrixWorld();
}

// ── temp-объекты (общие, без аллокаций в кадре) ──
const _wX = new THREE.Vector3(1, 0, 0), _qd = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _ed = new THREE.Euler();
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qSh = new THREE.Quaternion(), _euH = new THREE.Euler();
function qEuler(e: [number, number, number] | undefined, out: THREE.Quaternion): void { if (e) { _euH.set(e[0], e[1], e[2]); out.setFromEuler(_euH); } else out.identity(); }
function gaitArm(bone: THREE.Object3D | undefined, side: number, sh: number, sp: number, tw: number, armDown: number): void {
  if (!bone) return;
  _ed.set(0, tw, side * armDown + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh);   // рука ВНИЗ + мах вокруг X
  bone.quaternion.multiplyQuaternions(_qs, _qd);
}
function blendBone(human: Humanoid, name: string, gaitE: [number, number, number], idle: Pose | null, mag: number): void {
  const b = human.bones.get(name); if (!b) return;
  const held = idle ? idle[name] : undefined;
  if (!held) { b.rotation.set(gaitE[0], gaitE[1], gaitE[2]); return; }   // нет idle → чистый гейт
  qEuler(gaitE, _qA); qEuler(held, _qB); b.quaternion.copy(_qB).slerp(_qA, mag);   // idle(0) → гейт(1)
}
function blendArm(bone: THREE.Object3D | undefined, side: number, sh: number, sp: number, tw: number, held: [number, number, number] | undefined, hw: number, armDown: number): void {
  if (!bone) return;
  _ed.set(0, tw, side * armDown + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh); _qA.multiplyQuaternions(_qs, _qd);
  qEuler(held, _qB); bone.quaternion.copy(_qA).slerp(_qB, hw);
}
function blendEuler(bone: THREE.Object3D | undefined, gaitE: [number, number, number], held: [number, number, number] | undefined, hw: number): void {
  if (!bone) return;
  qEuler(gaitE, _qA); qEuler(held, _qB); bone.quaternion.copy(_qA).slerp(_qB, hw);
}
function applyWeaponUpper(weaponGroups: THREE.Group[], pose: Pose, hw: number): void {   // оружие: БАЗА хвата; поза с __wpnOverride доредактирует её по hw
  const ovr = !!pose['__wpnOverride'];   // нет флага → жёстко база (единый хват во всех анимациях)
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    const br = g.userData.baseRot as THREE.Euler | undefined, bp = g.userData.basePos as THREE.Vector3 | undefined;
    if (ovr && rk && pose[rk] && br) { const h = pose[rk]!; g.rotation.set(br.x + (h[0] - br.x) * hw, br.y + (h[1] - br.y) * hw, br.z + (h[2] - br.z) * hw); }
    else if (br) g.rotation.copy(br);   // база (нет override) — хват держится жёстко
    if (ovr && pk && pose[pk] && bp) { const h = pose[pk]!; g.position.set(bp.x + (h[0] - bp.x) * hw, bp.y + (h[1] - bp.y) * hw, bp.z + (h[2] - bp.z) * hw); }
    else if (bp) g.position.copy(bp);
  });
}
function attackEnv(tt: number, dur: number): number {
  const s = (x: number): number => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
  if (tt < AB_IN) return s(tt / AB_IN);
  if (tt > dur - AB_OUT) return s((dur - tt) / AB_OUT);
  return 1;
}
function overlayAttack(human: Humanoid, weaponGroups: THREE.Group[], atk: AttackState): void {   // наложить позу удара по времени с огибающей
  const clip = atk.clip; if (!clip) return;
  const dur = clipDur(clip) || 0.001;
  const ab = attackEnv(atk.t, dur);
  const ap = clipPoseAt(clip, atk.t / dur);
  const H = human.bones;
  for (const nm of ATK_BONES) { const e = ap[nm]; if (!e) continue; const b = H.get(nm); if (!b) continue; qEuler(e, _qB); b.quaternion.slerp(_qB, ab); }
  const ovr = !!ap['__wpnOverride'];   // удар двигает хват ТОЛЬКО если у кадра-удара стоит галка override; иначе хват жёсткий (база)
  if (ovr) weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk && ap[rk]) { const h = ap[rk]!; g.rotation.set(g.rotation.x + (h[0] - g.rotation.x) * ab, g.rotation.y + (h[1] - g.rotation.y) * ab, g.rotation.z + (h[2] - g.rotation.z) * ab); }
    if (pk && ap[pk]) { const h = ap[pk]!; g.position.set(g.position.x + (h[0] - g.position.x) * ab, g.position.y + (h[1] - g.position.y) * ab, g.position.z + (h[2] - g.position.z) * ab); }
  });
}
function applyUpper(human: Humanoid, weaponGroups: THREE.Group[], gx: GXKnobs, moveMag: number, t: PoseTargets, content: PoseContent, weapon: string, atk: AttackState, combat = 0): void {
  const H = human.bones;
  const up = content.resolveUpper(weapon, combat);
  // Раздельные руки ходьба↔бег: armDown/elbowBend блендятся walk→run по t.sb (POSE armSh/armEl/armSwing уже слиты в pose.ts).
  const sb = t.sb ?? 0;
  const eDown = gx.armDown + ((gx.armDownRun ?? gx.armDown) - gx.armDown) * sb;
  const eBend = gx.elbowBend + ((gx.elbowBendRun ?? gx.elbowBend) - gx.elbowBend) * sb;
  if (!up) {   // нет idle-позы → полный мах гейта
    gaitArm(H.get('LeftUpperArm'), -1, t.shL, t.shSpL, t.shTwL, eDown);
    gaitArm(H.get('RightUpperArm'), 1, t.shR, t.shSpR, t.shTwR, eDown);
    // Локоть гнётся вокруг ЛОКАЛЬНОЙ Y (лево −Y / право +Y): кисть форерукава лежит на локальной +X, поэтому X =
    // ТВИСТ вдоль кости (кисть не двигается), а сгиб — вокруг Y (замерено; так же в правильных авторских idle_*).
    H.get('LeftLowerArm')!.rotation.set(0, -(Math.abs(t.elL) + eBend), 0);
    H.get('RightLowerArm')!.rotation.set(0, Math.abs(t.elR) + eBend, 0);
  } else {
    // sway (остаточный мах) влияет ПО МЕРЕ ДВИЖЕНИЯ: в покое hw=1 → руки ТОЧНО как в авторской idle (стойка = как в редакторе),
    // на бегу hw=1-sway → мах гейта подмешивается. Раньше hw был константой → idle искажался даже стоя.
    const hw = clamp(1 - up.swing * moveMag, 0, 1);
    blendArm(H.get('LeftUpperArm'), -1, t.shL, t.shSpL, t.shTwL, up.pose['LeftUpperArm'], hw, eDown);
    blendArm(H.get('RightUpperArm'), 1, t.shR, t.shSpR, t.shTwR, up.pose['RightUpperArm'], hw, eDown);
    blendEuler(H.get('LeftLowerArm'), [0, -(Math.abs(t.elL) + eBend), 0], up.pose['LeftLowerArm'], hw);   // локоть = Y (см. выше), не X
    blendEuler(H.get('RightLowerArm'), [0, Math.abs(t.elR) + eBend, 0], up.pose['RightLowerArm'], hw);
    for (const nm of UPPER_BONES) blendEuler(H.get(nm), [0, 0, 0], up.pose[nm], hw);
    applyWeaponUpper(weaponGroups, up.pose, hw);
  }
  if (atk.clip && atk.t >= 0) overlayAttack(human, weaponGroups, atk);   // удар поверх idle/маха
}
/** Полный ретаргет вывода гейта на humanoid: ноги/торс блендятся idle-стойка↔гейт по legMag (сглажен), верх — idle+мах+удар
 *  по armMag (мгновенная скорость: в покое = 0 → руки ТОЧНО idle; иначе — legMag). Раздельно, т.к. legMag оседает медленно. */
/** Компенсация A-стойки бинда ФБХ для ПРОЦЕДУРНОЙ реконструкции: её ik() считает «поворот бедра 0 = нога прямо вниз», а бинд
 *  splay-ит наружу → доворачиваем БЕДРО внутрь на human.legAdduct, нога вертикальна, стопы в планты. Компонентно к Z бедра.
 *  ⚠ `scale`=вес гейта (legMag): АВТОРСКАЯ idle-поза сделана НА бинде (Позы-таб рисует её БЕЗ аддукта) — ей компенсация НЕ нужна,
 *  иначе её сводит ýже, чем автор видел (баг «узкая стойка в игре/локо»). Поэтому аддукт масштабируем: idle(m=0)=0 (ширина автора),
 *  гейт(m=1)=полный (реконструкция компенсирована). measureStancePlants аддукт НЕ зовёт → планты = авторская ширина. */
export function applyLegAdduct(human: Humanoid, scale = 1): void {
  const at = (human.legAdduct ?? 0) * scale;                  // splay бедра (hip→колено) × вес гейта
  const kc = at - (human.legAdductKnee ?? 0) * scale;         // коррекция колена = splayБедра − splayГолени: доворот бедра УЖЕ
  if (Math.abs(at) < 1e-4 && Math.abs(kc) < 1e-4) return;     // повернул голень (она ребёнок) → на колене добираем только разницу,
  const lu = human.bones.get('LeftUpperLeg'), ru = human.bones.get('RightUpperLeg');   // чтобы голень стала ПАРАЛЛЕЛЬНА бедру (как у базового = прямая нога).
  const ll = human.bones.get('LeftLowerLeg'), rl = human.bones.get('RightLowerLeg');
  if (lu) lu.rotation.z -= at; if (ru) ru.rotation.z += at;   // бедро: Left splay +X → −Z сводит вертикально (риг: Left на +X, см. [[humanoid-rig-mirror]])
  if (ll) ll.rotation.z += kc; if (rl) rl.rotation.z -= kc;   // колено: голень ∥ бедру → нога вертикальна В ЛЮБОМ сгибе колена
}
// Приведение РУК в рантайме НЕ делаем: модели биндятся в T-позе (руки горизонт = поза покоя клипов). A-позный бинд корёжит
// ретаргет (46° доворота от бинда скин не тянет) → требуем экспорт скелета в T-позе. См. render3d/README.

export function gaitToHumanoid(human: Humanoid, weaponGroups: THREE.Group[], gx: GXKnobs, legMag: number, t: PoseTargets, content: PoseContent, weapon: string, atk: AttackState, armMag: number = legMag, noIk = false, combat = 0): void {
  human.reset();
  const idle = content.resolveUpper(weapon, combat)?.pose ?? null;   // ПОЛНАЯ idle-стойка (ноги+торс+верх), боевая при combat>0
  const m = legMag;
  human.bones.get('Hips')!.position.set(0, 30 + t.bobY, 0);   // боб таза (множитель ходьба/бег уже в bobY)
  blendBone(human, 'LeftUpperLeg', [t.hipL, t.hipTwL, t.hipLatL], idle, m);
  blendBone(human, 'RightUpperLeg', [t.hipR, t.hipTwR, t.hipLatR], idle, m);
  blendBone(human, 'LeftLowerLeg', [t.knL, 0, 0], idle, m);
  blendBone(human, 'RightLowerLeg', [t.knR, 0, 0], idle, m);
  blendBone(human, 'LeftFoot', [0, 0, 0], idle, m); blendBone(human, 'RightFoot', [0, 0, 0], idle, m);
  blendBone(human, 'LeftToes', [0, 0, 0], idle, m); blendBone(human, 'RightToes', [0, 0, 0], idle, m);
  // Аддукт масштабируем ТОЛЬКО когда idle АВТОРИТ ноги (тогда idle m=0 = авторская ширина, гейт m=1 = компенсирован). Без
  // авторских ног (монстры/процедурка, idle не задаёт LeftUpperLeg) ноги ВСЕГДА реконструкция → аддукт полный (иначе splay бинда).
  applyLegAdduct(human, (idle && idle['LeftUpperLeg']) ? m : 1);
  // ТОРС/ШЕЯ держат idle-стойку при ПОВОРОТЕ НА МЕСТЕ: блендим к гейту по МГНОВЕННОЙ скорости (armMag=0 стоя/крутясь), а не по
  // legMag (=1 на подшаге) — иначе спина разгибалась/клонило назад при развороте. При движении (armMag→1) — гейт-наклон. Скрутка
  // к прицелу (applyTorsoTwist) и head-look-at идут ОТДЕЛЬНО поверх этого.
  blendBone(human, 'Spine', [t.lean, t.twist, t.leanSide], idle, armMag);
  blendBone(human, 'Neck', [t.headNod, t.headTurn, t.headTilt], idle, armMag);
  blendBone(human, 'Head', [0, 0, 0], idle, armMag);
  applyUpper(human, weaponGroups, gx, armMag, t, content, weapon, atk, combat);   // руки — по МГНОВЕННОЙ скорости (в покое точная idle)
  // ЩИТ: подмешать позу левой руки+корпуса + хват щита ПОВЕРХ (после удара). В покое держит guard; на ударе — по спаду
  // от щита (кисть держит, корпус/плечо свободны для маха), огибающая удара плавно вводит/выводит это.
  if (weapon.endsWith('+shield')) {
    const ov = content.shieldOverlay?.(weapon);
    if (ov && ov.mix > 0.001) {
      const aenv = (atk.clip && atk.t >= 0) ? attackEnv(atk.t, clipDur(atk.clip) || 0.001) : 0;
      applyShieldOverlay(human, weaponGroups, ov.pose, ov.mix, aenv);
    }
  }
  // ДВУРУЧНЫЙ ХВАТ: левая кисть IK-ом держит точку __lgripP на оружии (едет с оружием). Точка покадрово: idle → перехват в
  // ударе (берём кадр удара, иначе idle). Только когда левая рука СВОБОДНА (нет офф-руки: щита/дуала).
  if (!noIk && idle && weaponGroups.length && !weapon.includes('+')) {   // noIk (поза-LOD дальних) → пропуск off-hand IK
    const src = (atk.clip && atk.t >= 0) ? clipPoseAt(atk.clip, atk.t / (clipDur(atk.clip) || 1)) : idle;
    const lgP = src['__lgripP'] ?? idle['__lgripP'];
    if (lgP) applyOffhandGrip(human, weaponGroups, lgP, src['__lgripR'] ?? idle['__lgripR'] ?? [0, 0, 0]);
  }
}
// Двуручный off-hand хват: цель = RightHand.world ∘ грип-оружия(локал груп[0]) ∘ __lgrip; pole локтя — из авторской позы левой руки.
const _ogP = new THREE.Vector3(), _ogQ = new THREE.Quaternion(), _ogQ2 = new THREE.Quaternion(), _ogEu = new THREE.Euler();
const _ogSh = new THREE.Vector3(), _ogEl = new THREE.Vector3(), _ogLine = new THREE.Vector3(), _ogPole = new THREE.Vector3();
function applyOffhandGrip(human: Humanoid, weaponGroups: THREE.Group[], lgP: [number, number, number], lgR: [number, number, number]): void {
  const wg = weaponGroups[0]; const rh = human.bones.get('RightHand'); const lua = human.bones.get('LeftUpperArm'); const lla = human.bones.get('LeftLowerArm');
  if (!wg || !rh || !lua || !lla) return;
  human.root.updateMatrixWorld(true);
  const p = _ogP.set(lgP[0], lgP[1], lgP[2]).applyQuaternion(wg.quaternion).add(wg.position);   // __lgrip → space RightHand → мир
  rh.localToWorld(p);
  _ogEu.set(lgR[0], lgR[1], lgR[2]); _ogQ2.setFromEuler(_ogEu);
  const q = rh.getWorldQuaternion(_ogQ).multiply(wg.quaternion).multiply(_ogQ2);               // ориентация кисти в мире
  const sh = lua.getWorldPosition(_ogSh); const line = _ogLine.copy(p).sub(sh); const toEl = _ogPole.copy(lla.getWorldPosition(_ogEl)).sub(sh);
  toEl.addScaledVector(line, -(toEl.dot(line) / Math.max(1e-6, line.lengthSq())));               // pole = перпендикуляр локтя к линии плечо→цель
  const pole = toEl.lengthSq() > 0.5 ? toEl.normalize() : _ogPole.set(0, -1, -0.4);
  solveTwoBoneIK(human, 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', p, q, pole);
}
/** Щит-оверлей: слерп костей SHIELD_BONES к позе щита + перенос ХВАТА щита (поворот/позиция). Вес кости = mix, а НА ВРЕМЯ
 *  удара (aenv 0..1) падает по спаду от щита: кисть держит, корпус свободен. Хват щита в клипе: у `idle_<оружие>+shield`
 *  щит — офф-рука (index-1 → __wpnOff), у базового `idle_shield` щит — единственное (index-0 → __wpnMain); в игре щит —
 *  группа[1], переносим полностью. Читаем __wpnOff, иначе __wpnMain (иначе брали бы грип ОРУЖИЯ и щит улетал). */
export function applyShieldOverlay(human: Humanoid, weaponGroups: THREE.Group[], pose: Pose, mix: number, aenv = 0): void {
  const H = human.bones;
  for (const nm of SHIELD_BONES) {
    const e = pose[nm]; if (!e) continue; const b = H.get(nm); if (!b) continue;
    const w = clamp(mix * (1 - aenv * (1 - (SHIELD_FALLOFF[nm] ?? 0.1))), 0, 1);   // на ударе дальние кости освобождаются
    if (w < 0.002) continue;
    qEuler(e, _qSh); b.quaternion.slerp(_qSh, w);
  }
  const g = weaponGroups[1];   // щит для '+shield'-оружия — вторая группа (первая — оружие в правой руке)
  if (g) {   // ХВАТ щита — ПОЛНОСТЬЮ (щит всегда сидит в кулаке как выставлено; mix влияет только на позу руки/корпуса)
    const r = pose['__wpnOff'] ?? pose['__wpnMain'], p = pose['__wpnOffP'] ?? pose['__wpnMainP'];
    if (r) g.rotation.set(r[0], r[1], r[2]);
    if (p) g.position.set(p[0], p[1], p[2]);
  }
}

// ── Плант-сетка стоп: 8 направлений × 2 скорости (шаг/бег) авторского сдвига цели ноги (body-local fwd,lat) ──
// lVia/rVia — упорядоченные body-local (fwd,lat) точки ОБВОДА свинга (нога облетает опорную, не сквозь). Пусто = прямой свинг.
type XY = [number, number];
export type Leg2 = { l: XY; r: XY; lVia?: XY[]; rVia?: XY[] };
export type PlantGrid = { walk: Leg2[]; run: Leg2[] };         // walk/run — по 8 ячеек (0=вперёд, шаг 45°)
const DIR_STEP = Math.PI / 4;
const STEP_HOLD = 0.35;   // сек: держим ноги на гейте после подшага (settled мерцает → иначе мигание idle↔гейт)
const zeroLeg = (): Leg2 => ({ l: [0, 0], r: [0, 0], lVia: [], rVia: [] });
export const emptyGrid = (): PlantGrid => ({ walk: Array.from({ length: 8 }, zeroLeg), run: Array.from({ length: 8 }, zeroLeg) });
const cloneVia = (v: XY[] | undefined): XY[] => (v ?? []).map((p) => [p[0], p[1]] as XY);
/** Прочитать сохранённую сетку (новый {walk,run} ИЛИ старый {l,r} → размазать во все ячейки). via опциональны (нет → []). */
export function loadPlantGrid(p: (Partial<PlantGrid> & { l?: [number, number]; r?: [number, number] }) | undefined): PlantGrid {
  const g = emptyGrid();
  if (p?.walk && p?.run) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) { const e = p[sp]![i]; if (e) g[sp][i] = { l: [...(e.l ?? [0, 0])] as XY, r: [...(e.r ?? [0, 0])] as XY, lVia: cloneVia(e.lVia), rVia: cloneVia(e.rVia) }; } }
  else if (p?.l && p?.r) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) g[sp][i] = { l: [...p.l] as XY, r: [...p.r] as XY, lVia: [], rVia: [] }; }
  return g;
}
/** Билинейная интерполяция списка via-точек ноги по 4 ячейкам (walk/run × i0/i1 по ft, затем шаг↔бег по spB).
 *  Разная длина списков → паддинг [0,0] до max длины. Пусто везде → []. */
export function blendVia(grid: PlantGrid, key: 'lVia' | 'rVia', i0: number, i1: number, ft: number, spB: number): XY[] {
  const cells = [grid.walk[i0], grid.walk[i1], grid.run[i0], grid.run[i1]];
  const n = Math.max(0, ...cells.map((c) => c?.[key]?.length ?? 0));
  const get = (c: Leg2 | undefined, k: number, comp: 0 | 1): number => c?.[key]?.[k]?.[comp] ?? 0;
  const out: XY[] = [];
  for (let k = 0; k < n; k++) {
    const comp = (c: 0 | 1): number => {
      const w = get(grid.walk[i0], k, c) + (get(grid.walk[i1], k, c) - get(grid.walk[i0], k, c)) * ft;
      const r = get(grid.run[i0], k, c) + (get(grid.run[i1], k, c) - get(grid.run[i0], k, c)) * ft;
      return w + (r - w) * spB;
    };
    out.push([comp(0), comp(1)]);
  }
  return out;
}

// ── Провайдер контента из localStorage (same-origin с редактором): idle-стойки + удары + sway по классу ──
export interface GamePoseContent extends PoseContent {
  attackClip(weapon: string): Clip | null;
  clipByName(name: string): Clip | null;
  /** Поза скила под ЭКИПИРОВАННОЕ оружие: авторскую позу ретаргетит на текущее оружие (семейство), фолбэк — авторская. */
  resolveAbilityClip(name: string, weapon: string): Clip | null;
  /** Все hit_*-клипы данного оружия (для чередования базовой атаки), с фолбэком по оружию/персонажу. */
  attackClips(weapon: string): Clip[];
}
/** Главная рука ключа оружия (`sword+shield`→`sword`). */
const mainWeapon = (w: string): string => w.split('+')[0] ?? w;
const readJSON = <T,>(key: string, fb: T): T => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : fb; } catch { return fb; } };
/** Контент (стойка/удар/sway) по charId; если у него нет клипа — берём у fallbackId (монстры → Волкодав). */
export function localStorageContent(charId: string, fallbackId?: string): GamePoseContent {
  // Имена клипов нормализуем на чтении (старая конвенция стойка_/удар_ → idle_/hit_), чтобы старые данные работали сразу.
  const clips = readJSON<Clip[]>('pe_clips', []).map((c) => (c && typeof c.name === 'string' ? { ...c, name: migratePoseName(c.name) } : c));
  const sway = readJSON<Record<string, Record<string, number>>>('pe_sway', {});
  const shieldCfg = readJSON<Record<string, { mix?: number; perWeapon?: Record<string, number> }>>('pe_shield', {});   // щит: базовый mix + per-оружие
  const find = (kind: string, id: string, w: string): Clip | null => clips.find((c) => c.name === kind + '_' + w && c.character === id && c.weapon === w) ?? null;
  const stance = (w: string): Clip | null => find('idle', charId, w) ?? (fallbackId ? find('idle', fallbackId, w) : null);
  const combatStance = (w: string): Clip | null => find('combat_idle', charId, w) ?? (fallbackId ? find('combat_idle', fallbackId, w) : null);   // боевая стойка (нет → null → фолбэк на relaxed idle)
  const atk = (w: string): Clip | null => find('hit', charId, w) ?? (fallbackId ? find('hit', fallbackId, w) : null);
  const swayOf = (w: string): number => sway[charId]?.[w] ?? (fallbackId ? sway[fallbackId]?.[w] : undefined) ?? 0.2;
  // Клип по имени (нормализуем старое удар_→hit_) — свой персонаж, иначе фолбэк.
  const byName = (name: string): Clip | null => { const nm = migratePoseName(name); return clips.find((c) => c.name === nm && c.character === charId) ?? (fallbackId ? clips.find((c) => c.name === nm && c.character === fallbackId) ?? null : null); };
  return {
    // Idle-стойка: ПОЛНАЯ авторская поза per-оружие (idle_<weapon>) в приоритете — так стойка с щитом/дуалом целиком как в
    // редакторе (оба оружия + грипы). Нет полной → по БАЗОВОМУ оружию (axe+shield → axe) + щит идёт оверлеем.
    resolveUpper(weapon: string, combat = 0): UpperPose | null {
      const full = stance(weapon); const wk = (full && full.keys.length) ? weapon : baseWeapon(weapon);
      const c = (full && full.keys.length) ? full : stance(baseWeapon(weapon));
      if (!c || !c.keys.length) return null;
      let pose = c.keys[0]!.pose;
      if (combat > 0.001) {   // блендим к боевой стойке combat_idle_<w> (нет клипа → остаётся relaxed)
        const cf = combatStance(weapon); const cc = (cf && cf.keys.length) ? cf : combatStance(baseWeapon(weapon));
        if (cc && cc.keys.length) pose = blendTwo(pose, cc.keys[0]!.pose, combat);
      }
      return { pose, swing: swayOf(wk) };
    },
    attackClip(weapon: string): Clip | null { return atk(baseWeapon(weapon)); },
    clipByName(name: string): Clip | null { return byName(name); },
    // Поза скила под экип. оружие: если авторская на другом оружии — ретаргетим семейство (по clip.weapon) на текущее/базовое/главное; иначе авторская как есть.
    resolveAbilityClip(name: string, weapon: string): Clip | null {
      const orig = byName(name);
      if (!orig || orig.weapon === weapon) return orig;
      for (const cand of [weapon, baseWeapon(weapon), mainWeapon(weapon)]) { const c = byName(retargetClipName(name, orig.weapon, cand)); if (c) return c; }
      return orig;
    },
    // Базовая атака: ВСЕ hit_*-клипы оружия (стабильный цикл по имени), фолбэк по оружию (экип→база→главная) и персонажу.
    attackClips(weapon: string): Clip[] {
      const pick = (id: string): Clip[] => { for (const cand of [weapon, baseWeapon(weapon), mainWeapon(weapon)]) { const set = clips.filter((c) => c.character === id && c.weapon === cand && c.name.startsWith('hit_')); if (set.length) return set.slice().sort((a, b) => a.name.localeCompare(b.name)); } return []; };
      const own = pick(charId); return own.length ? own : (fallbackId ? pick(fallbackId) : []);
    },
    // Поза щита per-оружие: idle_<weaponKey> (фолбэк idle_shield) + вес (perWeapon[wk] ?? базовый mix). Нет клипа — нет оверлея.
    shieldOverlay(weaponKey: string): { pose: Pose; mix: number } | null { const c = stance(weaponKey) ?? stance('shield'); if (!c || !c.keys.length) return null; const cfg = shieldCfg[charId] ?? (fallbackId ? shieldCfg[fallbackId] : undefined); const mix = cfg?.perWeapon?.[weaponKey] ?? cfg?.mix ?? 0.85; return { pose: c.keys[0]!.pose, mix }; },
  };
}
type GaitCfg = { gait?: Record<string, number>; pose?: Record<string, number>; gx?: Record<string, number>; plant?: Partial<PlantGrid> & { l?: [number, number]; r?: [number, number] } };
/** Загрузить тюн бега класса (pe_gait[charId]) в ГЛОБАЛЬНЫЕ GAIT/POSE и переданный gx; вернуть плант-сетку. Для ИГРОКА. */
export function applyGaitConfig(charId: string, gx: GXKnobs): PlantGrid {
  const cfgs = readJSON<Record<string, GaitCfg>>('pe_gait', {});
  const c = cfgs[charId];
  if (c?.gait) Object.assign(GAIT, c.gait);
  if (c?.pose) {
    Object.assign(POSE, c.pose);
    // RUN-твины рук: если конфиг задал walk-значение, но не задал run — run = walk (иначе run брал бы глобал-дефолт).
    if (c.pose['armShRun'] === undefined) POSE.armShRun = POSE.armSh;
    if (c.pose['armElRun'] === undefined) POSE.armElRun = POSE.armEl;
    if (c.pose['armSwingRun'] === undefined) POSE.armSwingRun = POSE.armSwing;
  }
  if (c?.gx) Object.assign(gx, c.gx);
  return loadPlantGrid(c?.plant);
}
/** Загрузить ЛОКАЛЬНО gx + плант-сетку (БЕЗ записи в глобальные GAIT/POSE — их монстр делит с игроком).
 *  charId нет в pe_gait → берём fallbackId (монстры до тюнинга → плант Волкодава). Для МОНСТРОВ. */
export function loadGaitLocal(charId: string, gx: GXKnobs, fallbackId?: string): PlantGrid {
  const cfgs = readJSON<Record<string, GaitCfg>>('pe_gait', {});
  const c = cfgs[charId] ?? (fallbackId ? cfgs[fallbackId] : undefined);
  if (c?.gx) Object.assign(gx, c.gx);
  return loadPlantGrid(c?.plant);
}
/** Дефолт веса совпадения рендера с манекеном (RB2). ЕДИНЫЙ для игры (loadMatch) и редактора (loadPhys) → редактор =
 *  игра при нетюненом персонаже. 0.85 (не 0): без тюна рендер вёлся ЧИСТОЙ физикой — быстрый бег моторы не догоняют +
 *  реконструкция 21-кости из 15-тел укорачивает ноги (стопы вниз/провал). Высокий match → рендер ведёт аналит-поза. */
export const DEFAULT_MATCH = 0.85;
export const ATK_MATCH = 0.92;   // пиковый вес совпадения с авторской позой во время удара (физика одна не доводит быстрый замах до конечных кадров)
/** ЕДИНЫЙ вес совпадения РЕНДЕРА с позой-целью (физика→поза-бленд) для игры И редактора-локо → атлас-скин 1:1. Авторский
 *  per-кадр __match (если задан в кадре удара), иначе max(база персонажа, ATK_MATCH·огибающая удара). */
export function renderMatchWeight(base: number, attackWeight: number, attackMatch: number | null): number {
  return attackMatch != null ? attackMatch : Math.max(base, ATK_MATCH * attackWeight);
}
/** Вес совпадения РЕНДЕРА с манекеном (RB2, 0..1) per-char из pe_phys; фолбэк (монстры → Волкодав). Для ИГРЫ. */
export function loadMatch(charId: string, fallbackId?: string): number {
  const cfg = readJSON<Record<string, { match?: number }>>('pe_phys', {});
  return cfg[charId]?.match ?? (fallbackId ? cfg[fallbackId]?.match : undefined) ?? DEFAULT_MATCH;
}
/** Подъём стопы (юниты) per-char из pe_phys.footLift; фолбэк (монстры → gaitFallback). 0 = процедурная стопа на полу.
 *  Ставится на solid/target куклы → measureStancePlants (standY) и footIk.groundFeet поднимают цель заземления, чтобы
 *  ПОДОШВА МЕША атласа (лодыжка выше FOOT_Y) легла на пол. Редактор пишет тем же ключом → редактор ≡ игра. */
export function loadFootLift(charId: string, fallbackId?: string): number {
  const cfg = readJSON<Record<string, { footLift?: number }>>('pe_phys', {});
  return cfg[charId]?.footLift ?? (fallbackId ? cfg[fallbackId]?.footLift : undefined) ?? 0;
}
type GripSlot = { r: [number, number, number]; p: [number, number, number] };
/** БАЗОВЫЙ хват оружия/щита per-(char, weapon) из pe_grip (редактор пишет). Слоты [main(RightHand), off(LeftHand)].
 *  Это ЕДИНАЯ база хвата: применяется во ВСЕХ анимациях (idle/бег/удар) одинаково — оружие не «плавает» покадрово.
 *  Поза с флагом `__wpnOverride` может доредактировать хват поверх базы (галка в редакторе); без флага — жёстко база. */
export function loadGrip(charId: string, weapon: string, fallbackId?: string): (GripSlot | null)[] {
  const cfg = readJSON<Record<string, Record<string, { main?: GripSlot; off?: GripSlot }>>>('pe_grip', {});
  const g = cfg[charId]?.[weapon] ?? (fallbackId ? cfg[fallbackId]?.[weapon] : undefined);
  return [g?.main ?? null, g?.off ?? null];
}
/** Поставить базовый хват pe_grip на `g.userData.baseRot/basePos` групп оружия (поверх weapon-type дефолта из attachWeapons).
 *  Зови ПОСЛЕ attachWeapons и при смене оружия. Нет базы в конфиге → остаётся weapon-type дефолт. */
export function applyBaseGrip(weaponGroups: THREE.Group[], charId: string, weapon: string, fallbackId?: string): void {
  const base = loadGrip(charId, weapon, fallbackId);
  weaponGroups.forEach((g, i) => {
    const b = base[i]; if (!b) return;
    const br = g.userData.baseRot as THREE.Euler | undefined, bp = g.userData.basePos as THREE.Vector3 | undefined;
    if (br) br.set(b.r[0], b.r[1], b.r[2]);
    if (bp) bp.set(b.p[0], b.p[1], b.p[2]);
  });
}
/** Профили скрутки корпуса per-state (стой/ходьба/бег) per-char из pe_twist; фолбэк (монстры → Волкодав). */
export function loadTwistStates(charId: string, fallbackId?: string): TwistStates {
  const cfg = readJSON<Record<string, TwistCfgStored>>('pe_twist', {});
  const raw = cfg[charId] ?? (fallbackId ? cfg[fallbackId] : undefined);
  return resolveTwistStates(raw);
}
/** Обёртка угла в (−π, π]. */
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Шаг torso-lead: таз догоняет ПРИЦЕЛ удержанием в зоне + ПЛАВНЫМ доворотом с защёлкой. ОДНА система стоя и на бегу.
 * Скрутка ВЕРХА = (прицел − таз), клампится `maxTwist`. Возвращает yaw таза, остаток скрутки и состояние защёлки.
 * ОБЩИЙ код игры и редактора. Чистая математика — тестируемо.
 *
 * ЛОГИКА: пока |прицел−таз| ≤ порога и защёлка выкл — таз ДЕРЖИТСЯ (голова ведёт, планировщик не шагает). За зоной
 * защёлка ВКЛ: таз плавно доворачивается со скоростью `turnRate` рад/с, пока не догонит (|разница| ≤ SETTLE) → ВЫКЛ,
 * держит. Плавный доворот (не мгновенный) → стопы переступают ПООЧЕРЁДНО (не прыжок); ~3 рад/с → успевают (не семенят).
 */
const TWIST_SETTLE = 0.03; // рад (~1.7°): таз догнал прицел → гасим защёлку
export function stepTorsoLead(prevRoot: number, aimYaw: number, twist: TwistProfile, dt: number, prevTurning: boolean, relax = false): { rootYaw: number; residual: number; turning: boolean } {
  const err = wrapPi(aimYaw - prevRoot);
  let turning = prevTurning;
  if (Math.abs(err) > twist.threshold) turning = true;      // вышли за зону → начинаем доворот
  else if (relax && Math.abs(err) > TWIST_SETTLE) turning = true;   // прицел стабилен relaxTime → доворот к нейтрали (выравнивание)
  else if (Math.abs(err) <= TWIST_SETTLE) turning = false;  // догнали → держим (deadzone)
  let root = prevRoot;
  if (turning) root += Math.sign(err) * Math.min(Math.abs(err), twist.turnRate * dt);   // плавный рейт-лимит, без перелёта
  let residual = wrapPi(aimYaw - root);                     // скрутка ВЕРХА к прицелу
  if (Math.abs(residual) > twist.maxTwist) residual = Math.sign(residual) * twist.maxTwist;   // кламп (не выворачивать шею)
  return { rootYaw: root, residual, turning };
}
/** Навесить скрутку на риг: таз на rootYaw + остаток размазан по цепочке [Spine..Head] (веса сумм.=1). Звать ПОСЛЕ gaitToHumanoid. */
export function applyTorsoTwist(human: Humanoid, rootYaw: number, residual: number, weights: [number, number, number, number, number]): void {
  const H = human.bones;
  H.get('Hips')!.rotation.y = rootYaw;                        // facing таза (углы ног body-local → корень на rootYaw)
  // rotateY аддитивен поверх авторской позы; цепочка Spine→…→Head накапливает → плечи/голова ведут, оружие (на UpperChest) следом.
  for (let i = 0; i < TWIST_BONES.length; i++) { const b = H.get(TWIST_BONES[i]!); if (b && weights[i]) b.rotateY(residual * weights[i]!); }
}
const _UP_Y = new THREE.Vector3(0, 1, 0);
const _hlCur = new THREE.Quaternion(), _hlDes = new THREE.Quaternion(), _hlP = new THREE.Quaternion();
const _hlFwd = new THREE.Vector3(), _hlR = new THREE.Vector3(), _hlU = new THREE.Vector3();
const _hlM = new THREE.Matrix4();
/** Head look-at + ВЕРТИКАЛЬ: стабилизация головы на ПРИЦЕЛ (мир-yaw), вертикально (up=мир-вверх → нет бокового наклона/ролла) И
 *  на ЗАДАННЫЙ кивок `pitch` (не наследованный свинг-нырок от удара). weight 0..1: 1 = строго на курсор+вертикаль+кивок, 0 = как
 *  есть (голова с телом), ~0.85 = держит + чуть гуляет (подмес). pitch (рад): 0 = ровно, <0 = вниз. Зови ПОСЛЕ applyTorsoTwist/overlayAttack. */
export function applyHeadLookAt(human: Humanoid, aimYaw: number, weight: number, pitch = 0): void {
  if (weight <= 0.001) return;
  const head = human.bones.get('Head'); if (!head) return;
  head.updateWorldMatrix(true, false);                         // мир головы = итог цепочки (после твиста/удара)
  head.getWorldQuaternion(_hlCur);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);            // ЦЕЛЕВОЙ кивок: forward.y = sin(pitch) (<0 = вниз), горизонт = cos(pitch)
  _hlFwd.set(Math.sin(aimYaw) * cp, sp, Math.cos(aimYaw) * cp).normalize();   // yaw→прицел, pitch→ЗАДАННЫЙ (убирает свинг-нырок корпуса)
  _hlR.crossVectors(_UP_Y, _hlFwd);                            // right = up × fwd (горизонт, без ролла)
  if (_hlR.lengthSq() < 1e-6) _hlR.set(1, 0, 0);              // смотрит строго вверх/вниз → произвольный right
  _hlR.normalize(); _hlU.crossVectors(_hlFwd, _hlR).normalize();   // up = fwd × right (в плоскости fwd–мирВверх → нет наклона вбок)
  _hlM.makeBasis(_hlR, _hlU, _hlFwd); _hlDes.setFromRotationMatrix(_hlM);   // целевая: смотрит на прицел, ВЕРТИКАЛЬНА
  _hlCur.slerp(_hlDes, weight);                                // бленд итог→цель по весу (0.85 = держит + чуть гуляет)
  const par = head.parent;
  head.quaternion.copy(par ? par.getWorldQuaternion(_hlP).invert().multiply(_hlCur) : _hlCur);   // → локаль родителя
}

// ── Замер ТОЧНЫХ плантов стоп из авторской idle-позы (для приставного шага при повороте на месте) ──
const STANCE_LEG_BONES = ['LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg', 'LeftFoot', 'RightFoot'];
const _ms0 = new THREE.Vector3(), _ms1 = new THREE.Vector3(), _ms2 = new THREE.Vector3();
/** Плант ноги = ТОЧНАЯ позиция стопы в idle-стойке отн. таза (body-local, yaw 0): lat (X, + = сторона своей кости) + fwd (Z).
 *  Позируем ноги авторской стойкой, читаем мировые стопы отн. таза → по каждой ноге СВОЙ (lat, fwd) СО ЗНАКОМ (не усредняем).
 *  Планировщик (setStance) при повороте держит стопы В ЭТИХ точках и переступает ровно в них (idl-стойка в новом фейсинге).
 *  Нет клипа стойки → фолбэк ±полуширина таза (нога 0/левая на +X — под её кость LeftUpperLeg, см. [[humanoid-rig-mirror]]).
 *  Мутирует human (reset + поза ног) — зови вне кадра рендера (спавн/смена оружия); следующий полный step перепозирует. */
export function measureStancePlants(human: Humanoid, idle: Pose | null): { latL: number; fwdL: number; latR: number; fwdR: number; standY: number } {
  if (!idle) return { latL: HIP_DX, fwdL: 0, latR: -HIP_DX, fwdR: 0, standY: GAIT.standY };
  human.reset();
  const hips = human.bones.get('Hips')!;
  hips.position.set(0, 30, 0); hips.rotation.set(0, 0, 0);
  for (const nm of STANCE_LEG_BONES) { const e = idle[nm]; if (e) { const b = human.bones.get(nm); if (b) b.rotation.set(e[0], e[1], e[2]); } }
  // Аддукт НЕ применяем: планты = АВТОРСКАЯ ширина стойки (как Позы-таб рисует idle, БЕЗ аддукта). idle в gaitToHumanoid тоже без
  // аддукта (legMag=0), так что стойка ≡ планты. Реконструкция при подшаге (legMag→1) добирает аддукт и всё равно попадает в план.
  human.root.updateMatrixWorld(true);
  const h = hips.getWorldPosition(_ms0);
  const fl = human.bones.get('LeftFoot')!.getWorldPosition(_ms1);
  const fr = human.bones.get('RightFoot')!.getWorldPosition(_ms2);   // yaw 0 → world X = body-lateral, world Z = forward
  // Высота таза стойки. ПРИОРИТЕТ — авторская `__hipsY` из idle-позы (где юзер поставил таз = ИСТИНА): и стойка, и бег, и
  // восстановление на applyPose берут ОДНУ величину → нет провала после бега и рассинхрона бег↔стойка (редактор ≡ игра).
  // Фолбэк (старые позы без __hipsY): расчёт из стоп — таз так, чтобы стопы idle стояли на полу (FOOT_Y + footLift).
  const authored = idle['__hipsY'];
  const standY = authored ? authored[0] : (FOOT_Y + (human.footLift ?? 0)) + (h.y - (fl.y + fr.y) / 2);
  return { latL: fl.x - h.x, fwdL: fl.z - h.z, latR: fr.x - h.x, fwdR: fr.z - h.z, standY };
}

// ── PosePlayer: драйвер гейта для ИГРЫ (владеет своим состоянием) — тредмил-ноги + idle-стойка + физ-удар ──
const _vfl = new THREE.Vector3(), _vfr = new THREE.Vector3();
export class PosePlayer {
  readonly driver = new PoseDriver();
  private px = 0; private pz = 0; private vx = 0; private vz = 0;
  private aimYaw = 0;    // прицел (курсор/facing с сервера)
  private rootYaw = 0;   // таз — догоняет aimYaw с задержкой (torso-lead)
  private yawInit = false;
  private turning = false;   // защёлка доворота таза (torso-lead): вкл за порогом, выкл когда догнал
  private prevAim = 0; private aimStableFor = 0;   // сколько прицел стабилен (для relaxTime — доворот таза к нейтрали)
  moveMag = 0; atkSpeed = 1;
  combat = 0;                     // боевой айдл 0..1 (сглажен, кроссфейд за GAIT.combatBlend сек)
  private combatTarget = 0;
  setCombat(on: boolean): void { this.combatTarget = on ? 1 : 0; }   // вход/выход боевой стойки (сервер-авторитетный флаг)
  private noIk = false;   // поза-LOD: пропуск off-hand IK (FOOT-IK пропускает рендер отдельно)
  setNoIk(on: boolean): void { this.noIk = on; }
  /** Вес ГЕЙТА в ногах (0 = поза idle-стойки, 1 = шаг планировщика). Сглажен: резкий скачок = дребезг ног. */
  legMag = 0;
  private stepHold = 0;   // остаточное удержание «ноги ведёт гейт» после подшага (антидребезг мерцающего settled)
  readonly atk: AttackState = { clip: null, t: -1 };
  constructor(
    private human: Humanoid,
    private weaponGroups: () => THREE.Group[],
    private content: PoseContent,
    public weapon: string,
    public gx: GXKnobs,
    public plant: PlantGrid,
    public twistStates: TwistStates = TWIST_STATES_DEFAULT(),
  ) { this.measureStance(); }
  /** Замерить планты стоп из idle-стойки текущего оружия и отдать планировщику (подшаг при повороте идёт в эти точки). */
  measureStance(): void {
    const p = measureStancePlants(this.human, this.content.resolveUpper(this.weapon)?.pose ?? null);
    this.driver.setStance(p.latL, p.fwdL, p.latR, p.fwdR, p.standY);
  }
  setWeapon(w: string): void { this.weapon = w; this.measureStance(); }
  setVel(vx: number, vz: number): void { this.vx = vx; this.vz = vz; }
  setYaw(yaw: number): void { this.aimYaw = yaw; if (!this.yawInit) { this.rootYaw = yaw; this.yawInit = true; } }
  /** Снять лаг таза (спавн/пробуждение/телепорт): таз мгновенно = прицел, без доворота-«юлы». */
  snapYaw(): void { this.rootYaw = this.aimYaw; this.turning = false; }
  /** Запустить удар. windowSec — окно атаки (attack-лок из сервера): клип ужимается, чтобы отыграть ЦЕЛИКОМ за это
   *  окно (быстрее бьёшь — быстрее клип, но всегда до конечных кадров). Медленнее авторского темпа не растягиваем (min 1×). */
  triggerAttack(clip: Clip | null, windowSec = 0): void {
    if (!clip) return;
    this.atk.clip = clip; this.atk.t = 0;
    const dur = clipDur(clip);
    this.atkSpeed = windowSec > 0 && dur > 0 ? Math.max(1, dur / windowSec) : 1;
  }
  get attacking(): boolean { return !!this.atk.clip; }
  /** Вес авторской позы удара в кадре (огибающая attackEnv): 0 в покое, 1 на пике замаха. Для буста match-веса рендера —
   *  физика одна не доводит быстрый замах до конечных кадров, поэтому во время удара видимый меш сильнее тянем к позе-цели. */
  get attackWeight(): number { return this.atk.clip && this.atk.t >= 0 ? attackEnv(this.atk.t, clipDur(this.atk.clip) || 0.001) : 0; }
  /** Per-кадр физ-ключ удара (интерполированный по времени клипа), напр. '__match'/'__pinKp'. null = не авторено (фолбэк рантайма). */
  private atkPhys(key: string): number | null {
    if (!this.atk.clip || this.atk.t < 0) return null;
    const v = clipPoseAt(this.atk.clip, this.atk.t / (clipDur(this.atk.clip) || 1))[key];
    return v ? v[0] : null;
  }
  /** Авторский per-кадр вес совпадения удара (__match). null → рантайм берёт свою огибающую. */
  get attackMatch(): number | null { return this.atkPhys('__match'); }
  /** Авторская per-кадр жёсткость пинов удара (__pinKp). null → дефолт. */
  get attackPinKp(): number | null { return this.atkPhys('__pinKp'); }
  /** Видимый facing (радианы) = ПРИЦЕЛ (куда целится корпус/голова), не таз. */
  get facing(): number { return this.aimYaw; }
  /** Текущий yaw таза (лаг) — для отладки/редактора. */
  get pelvisYaw(): number { return this.rootYaw; }
  /** Пройденный путь тредмила (интеграл скорости) — редактору для скролла пола/оффсета маркеров. */
  get posX(): number { return this.px; }
  get posZ(): number { return this.pz; }
  /** Сбросить путь тредмила в 0 (редактор: рестарт превью). */
  resetPos(): void { this.px = 0; this.pz = 0; }
  /** Вес совпадения рендера с позой на этом кадре (для физ-бленда атласа) — ЕДИНО с игрой. base = match персонажа. */
  matchWeight(base: number): number { return renderMatchWeight(base, this.attackWeight, this.attackMatch); }
  /** Позировать this.human: тредмил-ноги (idle↔гейт по скорости) + верх (idle-стойка + мах + удар).
   *  Кормим гейт РЕАЛЬНЫМ yaw — StepPlanner видит смену facing и делает подшаг при повороте на месте; узость ног
   *  держит ЧИСТАЯ скорость (p.vel), а не дёрганая Δpos (её джиттер в vLat = ложный страйф разводил ноги). */
  step(dt: number): void {
    if (this.atk.clip) { this.atk.t += dt * this.atkSpeed; if (this.atk.t > clipDur(this.atk.clip)) { this.atk.clip = null; this.atk.t = -1; } }
    const cstep = dt / Math.max(0.01, GAIT.combatBlend);   // кроссфейд боевой стойки (линейно за combatBlend сек)
    this.combat += clamp(this.combatTarget - this.combat, -cstep, cstep);
    const vx = this.vx, vz = this.vz, spd = Math.hypot(vx, vz);
    this.moveMag = clamp(spd / GAIT.speedWalk, 0, 1);
    const twist = blendTwist(this.twistStates, spd);   // скрутка корпуса по состоянию (стой/ходьба/бег), плавно по скорости
    // Torso-lead: таз (rootYaw) догоняет прицел (aimYaw) с задержкой (голова/плечи ведут). rootYaw кормит и StepPlanner,
    // и Hips → приставной шаг случается ровно когда таз доворачивает. Остаток `tw` размажем по позвоночнику после позинга.
    // Таз догоняет прицел (одна система стоя и на бегу): голова ведёт, таз держится в зоне и плавно доворачивает.
    // relaxTime: прицел стабилен долго и есть скрутка → таз доворачивается к нейтрали (не держим лид вечно).
    this.aimStableFor = Math.abs(wrapPi(this.aimYaw - this.prevAim)) < 0.01 ? this.aimStableFor + dt : 0;
    this.prevAim = this.aimYaw;
    const tl = stepTorsoLead(this.rootYaw, this.aimYaw, twist, dt, this.turning, this.aimStableFor > twist.relaxTime);
    const yaw = tl.rootYaw, tw = tl.residual; this.rootYaw = yaw; this.turning = tl.turning;
    this.px += vx * dt; this.pz += vz * dt;
    this.driver.setWorld(this.px, this.pz, yaw, vx, vz);        // yaw таза → стопы в верном body-кадре + подшаг при повороте
    this.driver.setGoalYaw(this.aimYaw);                        // прицел → подшаг целит в идл-стойку ПОСЛЕ доворота (не в промежуток)
    const fwdC = vx * Math.sin(yaw) + vz * Math.cos(yaw), latC = vx * Math.cos(yaw) - vz * Math.sin(yaw);
    let ang = Math.atan2(latC, fwdC) / DIR_STEP; ang = ((ang % 8) + 8) % 8;   // направление плант-сетки (тело-локальное)
    const i0 = Math.floor(ang) % 8, i1 = (i0 + 1) % 8, ft = ang - Math.floor(ang);
    const spB = clamp((spd - GAIT.speedWalk) / Math.max(1, GAIT.speedRun - GAIT.speedWalk), 0, 1);
    const bl = (leg: 'l' | 'r', k: 0 | 1): number => {
      const w = this.plant.walk[i0]![leg][k] + (this.plant.walk[i1]![leg][k] - this.plant.walk[i0]![leg][k]) * ft;
      const r = this.plant.run[i0]![leg][k] + (this.plant.run[i1]![leg][k] - this.plant.run[i0]![leg][k]) * ft;
      return w + (r - w) * spB;
    };
    this.driver.setPlantOffset(bl('l', 0), bl('l', 1), bl('r', 0), bl('r', 1));
    this.driver.setPlantVia(blendVia(this.plant, 'lVia', i0, i1, ft, spB), blendVia(this.plant, 'rVia', i0, i1, ft, spB));
    // Вес гейта в ногах: идём/подшагиваем (разворот на месте) → ноги ведёт планировщик, иначе — поза idle-стойки.
    // Без этого при стоянии ноги целиком из idle: подшаг НЕ виден, а фидбэк setFeet отдаёт планировщику чужие стопы.
    // ⚠ `stepping` МЕРЦАЕТ (settled щёлкает по гистерезису) → держим ещё STEP_HOLD после конца подшага, иначе ноги
    // мигают idle↔гейт = тик при развороте на месте.
    if (this.driver.stepping) this.stepHold = STEP_HOLD; else this.stepHold = Math.max(0, this.stepHold - dt);
    const want = this.stepHold > 0 ? 1 : this.moveMag;
    // Асимметрия скорости: ВХОД в гейт (шаг) — резво (отзывчивый подшаг); ВЫХОД в idle (конец поворота) — мягче, иначе поза
    // «оседает» рывком при остановке (ноги морфятся гейт→idle-стойка плавно). Резкое переключение idle↔гейт дребезжит.
    this.legMag += (want - this.legMag) * Math.min(1, dt * (want >= this.legMag ? 6 : 3.5));
    this.human.root.updateMatrixWorld(true);
    if (this.legMag > 0.5) {                                      // фидбэк фактических стоп (иначе шпагат) — только когда ноги ведёт гейт
      const fl = this.human.bones.get('LeftFoot')!.getWorldPosition(_vfl), fr = this.human.bones.get('RightFoot')!.getWorldPosition(_vfr);
      this.driver.setFeet(fl.x + this.px, fl.z + this.pz, fr.x + this.px, fr.z + this.pz);
    }
    gaitToHumanoid(this.human, this.weaponGroups(), this.gx, this.legMag, this.driver.update(dt), this.content, this.weapon, this.atk, this.moveMag, this.noIk, this.combat);
    applyTorsoTwist(this.human, yaw, tw, twist.weights);   // таз на rootYaw + скрутка позвоночника к прицелу
    applyHeadLookAt(this.human, this.aimYaw, twist.headLook, twist.headPitch);   // голова на ПРИЦЕЛ + ЗАДАННЫЙ кивок (убирает свинг-нырок от удара)
  }
}
