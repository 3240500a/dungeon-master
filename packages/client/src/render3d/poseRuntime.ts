// ── Общий runtime-пайплайн позинга (Ф5): редактор И игра гонят бег/idle-стойки/удары ОДНИМ кодом ──
// Чистые функции: берут human (humanoid.ts), меши оружия, крутилки GX и провайдер контента ЯВНЫМИ параметрами
// (без модульных глобалов), поэтому переиспользуются и в pose-editor.ts (превью), и в игре (gamePlayerDoll.ts, per игрок).
import * as THREE from 'three';
import type { Humanoid } from './humanoid.js';
import { PoseDriver, GAIT, POSE, type PoseTargets } from './pose.js';

export type Pose = Record<string, [number, number, number]>;
export interface Keyframe { pose: Pose; t: number }
export interface Clip { name: string; character: string; weapon: string; loop: boolean; keys: Keyframe[] }
export interface UpperPose { pose: Pose; swing: number }        // idle-поза верха + остаточный мах (0..1)
export interface GXKnobs { legWidth: number; armDown: number; elbowBend: number; bob: number }
/** Провайдер контента: даёт idle-стойку (полная поза) + swing по оружию. Редактор — из живой библиотеки; игра — из localStorage.
 *  `shieldOverlay` — отдельная поза щита (левая рука+корпус из `стойка_shield`) + вес подмешивания (авторится в редакторе). */
export interface PoseContent {
  resolveUpper(weapon: string): UpperPose | null;
  shieldOverlay?(): { pose: Pose; mix: number } | null;
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
const AB_IN = 0.1, AB_OUT = 0.14;                              // огибающая входа/выхода удара (сек)

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const clipDur = (c: Clip): number => (c.keys.length ? c.keys[c.keys.length - 1]!.t : 0);
export function blendTwo(a: Pose, b: Pose, t: number): Pose {   // Σ поз по ключам (union), лерп
  const out: Pose = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const pa = a[k] ?? [0, 0, 0], pb = b[k] ?? [0, 0, 0]; out[k] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]; }
  return out;
}
export function clipPoseAt(c: Clip, t01: number): Pose {        // поза клипа на нормализованной фазе 0..1
  const ks = c.keys; if (!ks.length) return {}; if (ks.length < 2) return ks[0]!.pose;
  const dur = clipDur(c) || 1, time = clamp(t01, 0, 1) * dur;
  let i = 0; while (i < ks.length - 2 && ks[i + 1]!.t <= time) i++;
  const a = ks[i]!, b = ks[i + 1]!, span = b.t - a.t;
  return blendTwo(a.pose, b.pose, span > 1e-6 ? clamp((time - a.t) / span, 0, 1) : 0);
}

// ── temp-объекты (общие, без аллокаций в кадре) ──
const _wX = new THREE.Vector3(1, 0, 0), _qd = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _ed = new THREE.Euler();
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qSh = new THREE.Quaternion(), _euH = new THREE.Euler();
function qEuler(e: [number, number, number] | undefined, out: THREE.Quaternion): void { if (e) { _euH.set(e[0], e[1], e[2]); out.setFromEuler(_euH); } else out.identity(); }
function gaitArm(bone: THREE.Object3D | undefined, side: number, sh: number, sp: number, tw: number, gx: GXKnobs): void {
  if (!bone) return;
  _ed.set(0, tw, side * gx.armDown + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh);   // рука ВНИЗ + мах вокруг X
  bone.quaternion.multiplyQuaternions(_qs, _qd);
}
function blendBone(human: Humanoid, name: string, gaitE: [number, number, number], idle: Pose | null, mag: number): void {
  const b = human.bones.get(name); if (!b) return;
  const held = idle ? idle[name] : undefined;
  if (!held) { b.rotation.set(gaitE[0], gaitE[1], gaitE[2]); return; }   // нет idle → чистый гейт
  qEuler(gaitE, _qA); qEuler(held, _qB); b.quaternion.copy(_qB).slerp(_qA, mag);   // idle(0) → гейт(1)
}
function blendArm(bone: THREE.Object3D | undefined, side: number, sh: number, sp: number, tw: number, held: [number, number, number] | undefined, hw: number, gx: GXKnobs): void {
  if (!bone) return;
  _ed.set(0, tw, side * gx.armDown + sp); _qd.setFromEuler(_ed); _qs.setFromAxisAngle(_wX, sh); _qA.multiplyQuaternions(_qs, _qd);
  qEuler(held, _qB); bone.quaternion.copy(_qA).slerp(_qB, hw);
}
function blendEuler(bone: THREE.Object3D | undefined, gaitE: [number, number, number], held: [number, number, number] | undefined, hw: number): void {
  if (!bone) return;
  qEuler(gaitE, _qA); qEuler(held, _qB); bone.quaternion.copy(_qA).slerp(_qB, hw);
}
function applyWeaponUpper(weaponGroups: THREE.Group[], pose: Pose, hw: number): void {   // оружие: база хвата → авторская idle по hw
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    const br = g.userData.baseRot as THREE.Euler | undefined, bp = g.userData.basePos as THREE.Vector3 | undefined;
    if (rk && pose[rk] && br) { const h = pose[rk]!; g.rotation.set(br.x + (h[0] - br.x) * hw, br.y + (h[1] - br.y) * hw, br.z + (h[2] - br.z) * hw); }
    if (pk && pose[pk] && bp) { const h = pose[pk]!; g.position.set(bp.x + (h[0] - bp.x) * hw, bp.y + (h[1] - bp.y) * hw, bp.z + (h[2] - bp.z) * hw); }
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
  weaponGroups.forEach((g, i) => {
    const rk = WPN_KEYS[i], pk = WPN_POS[i];
    if (rk && ap[rk]) { const h = ap[rk]!; g.rotation.set(g.rotation.x + (h[0] - g.rotation.x) * ab, g.rotation.y + (h[1] - g.rotation.y) * ab, g.rotation.z + (h[2] - g.rotation.z) * ab); }
    if (pk && ap[pk]) { const h = ap[pk]!; g.position.set(g.position.x + (h[0] - g.position.x) * ab, g.position.y + (h[1] - g.position.y) * ab, g.position.z + (h[2] - g.position.z) * ab); }
  });
}
function applyUpper(human: Humanoid, weaponGroups: THREE.Group[], gx: GXKnobs, t: PoseTargets, content: PoseContent, weapon: string, atk: AttackState): void {
  const H = human.bones;
  const up = content.resolveUpper(weapon);
  if (!up) {   // нет idle-позы → полный мах гейта
    gaitArm(H.get('LeftUpperArm'), -1, t.shL, t.shSpL, t.shTwL, gx);
    gaitArm(H.get('RightUpperArm'), 1, t.shR, t.shSpR, t.shTwR, gx);
    H.get('LeftLowerArm')!.rotation.set(-Math.abs(t.elL) - gx.elbowBend, 0, 0);
    H.get('RightLowerArm')!.rotation.set(-Math.abs(t.elR) - gx.elbowBend, 0, 0);
  } else {
    const hw = clamp(1 - up.swing, 0, 1);   // вес idle-позы (1 держим, 0 полный мах)
    blendArm(H.get('LeftUpperArm'), -1, t.shL, t.shSpL, t.shTwL, up.pose['LeftUpperArm'], hw, gx);
    blendArm(H.get('RightUpperArm'), 1, t.shR, t.shSpR, t.shTwR, up.pose['RightUpperArm'], hw, gx);
    blendEuler(H.get('LeftLowerArm'), [-Math.abs(t.elL) - gx.elbowBend, 0, 0], up.pose['LeftLowerArm'], hw);
    blendEuler(H.get('RightLowerArm'), [-Math.abs(t.elR) - gx.elbowBend, 0, 0], up.pose['RightLowerArm'], hw);
    for (const nm of UPPER_BONES) blendEuler(H.get(nm), [0, 0, 0], up.pose[nm], hw);
    applyWeaponUpper(weaponGroups, up.pose, hw);
  }
  if (atk.clip && atk.t >= 0) overlayAttack(human, weaponGroups, atk);   // удар поверх idle/маха
}
/** Полный ретаргет вывода гейта на humanoid: ноги/торс блендятся idle-стойка↔гейт по moveMag, верх — idle+мах+удар. */
export function gaitToHumanoid(human: Humanoid, weaponGroups: THREE.Group[], gx: GXKnobs, moveMag: number, t: PoseTargets, content: PoseContent, weapon: string, atk: AttackState): void {
  human.reset();
  const idle = content.resolveUpper(weapon)?.pose ?? null;   // ПОЛНАЯ idle-стойка (ноги+торс+верх)
  const m = moveMag;
  human.bones.get('Hips')!.position.set(0, 30 + t.bobY * gx.bob, 0);   // боб таза
  blendBone(human, 'LeftUpperLeg', [t.hipL, t.hipTwL, t.hipLatL - gx.legWidth], idle, m);
  blendBone(human, 'RightUpperLeg', [t.hipR, t.hipTwR, t.hipLatR + gx.legWidth], idle, m);
  blendBone(human, 'LeftLowerLeg', [t.knL, 0, 0], idle, m);
  blendBone(human, 'RightLowerLeg', [t.knR, 0, 0], idle, m);
  blendBone(human, 'LeftFoot', [0, 0, 0], idle, m); blendBone(human, 'RightFoot', [0, 0, 0], idle, m);
  blendBone(human, 'LeftToes', [0, 0, 0], idle, m); blendBone(human, 'RightToes', [0, 0, 0], idle, m);
  blendBone(human, 'Spine', [t.lean, t.twist, t.leanSide], idle, m);
  blendBone(human, 'Neck', [t.headNod, t.headTurn, t.headTilt], idle, m);
  blendBone(human, 'Head', [0, 0, 0], idle, m);
  applyUpper(human, weaponGroups, gx, t, content, weapon, atk);
  // ЩИТ: подмешать позу левой руки+корпуса + хват щита ПОВЕРХ (после удара). В покое держит guard; на ударе — по спаду
  // от щита (кисть держит, корпус/плечо свободны для маха), огибающая удара плавно вводит/выводит это.
  if (weapon.endsWith('+shield')) {
    const ov = content.shieldOverlay?.();
    if (ov && ov.mix > 0.001) {
      const aenv = (atk.clip && atk.t >= 0) ? attackEnv(atk.t, clipDur(atk.clip) || 0.001) : 0;
      applyShieldOverlay(human, weaponGroups, ov.pose, ov.mix, aenv);
    }
  }
}
/** Щит-оверлей: слерп костей SHIELD_BONES к позе щита + перенос ХВАТА щита (поворот/позиция). Вес кости = mix, а НА ВРЕМЯ
 *  удара (aenv 0..1) падает по спаду от щита: кисть держит, корпус свободен. Хват в `стойка_shield` — index-0 (__wpnMain),
 *  в игре щит — index-1, переносим на группу[1] (полностью — щит всегда в кулаке). */
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
    const r = pose['__wpnMain'], p = pose['__wpnMainP'];
    if (r) g.rotation.set(r[0], r[1], r[2]);
    if (p) g.position.set(p[0], p[1], p[2]);
  }
}

// ── Плант-сетка стоп: 8 направлений × 2 скорости (шаг/бег) авторского сдвига цели ноги (body-local fwd,lat) ──
export type Leg2 = { l: [number, number]; r: [number, number] };
export type PlantGrid = { walk: Leg2[]; run: Leg2[] };         // walk/run — по 8 ячеек (0=вперёд, шаг 45°)
const DIR_STEP = Math.PI / 4;
const STEP_HOLD = 0.35;   // сек: держим ноги на гейте после подшага (settled мерцает → иначе мигание idle↔гейт)
const zeroLeg = (): Leg2 => ({ l: [0, 0], r: [0, 0] });
export const emptyGrid = (): PlantGrid => ({ walk: Array.from({ length: 8 }, zeroLeg), run: Array.from({ length: 8 }, zeroLeg) });
/** Прочитать сохранённую сетку (новый {walk,run} ИЛИ старый {l,r} → размазать во все ячейки). */
export function loadPlantGrid(p: (Partial<PlantGrid> & { l?: [number, number]; r?: [number, number] }) | undefined): PlantGrid {
  const g = emptyGrid();
  if (p?.walk && p?.run) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) { const e = p[sp]![i]; if (e) g[sp][i] = { l: [...(e.l ?? [0, 0])] as [number, number], r: [...(e.r ?? [0, 0])] as [number, number] }; } }
  else if (p?.l && p?.r) { for (const sp of ['walk', 'run'] as const) for (let i = 0; i < 8; i++) g[sp][i] = { l: [...p.l] as [number, number], r: [...p.r] as [number, number] }; }
  return g;
}

// ── Провайдер контента из localStorage (same-origin с редактором): idle-стойки + удары + sway по классу ──
export interface GamePoseContent extends PoseContent { attackClip(weapon: string): Clip | null }
const readJSON = <T,>(key: string, fb: T): T => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : fb; } catch { return fb; } };
/** Контент (стойка/удар/sway) по charId; если у него нет клипа — берём у fallbackId (монстры → Волкодав). */
export function localStorageContent(charId: string, fallbackId?: string): GamePoseContent {
  const clips = readJSON<Clip[]>('pe_clips', []);
  const sway = readJSON<Record<string, Record<string, number>>>('pe_sway', {});
  const shieldCfg = readJSON<Record<string, { mix?: number }>>('pe_shield', {});   // вес подмешивания щита per персонаж
  const find = (kind: string, id: string, w: string): Clip | null => clips.find((c) => c.name === kind + '_' + w && c.character === id && c.weapon === w) ?? null;
  const stance = (w: string): Clip | null => find('стойка', charId, w) ?? (fallbackId ? find('стойка', fallbackId, w) : null);
  const atk = (w: string): Clip | null => find('удар', charId, w) ?? (fallbackId ? find('удар', fallbackId, w) : null);
  const swayOf = (w: string): number => sway[charId]?.[w] ?? (fallbackId ? sway[fallbackId]?.[w] : undefined) ?? 0.2;
  return {
    // Позы/удары — по БАЗОВОМУ оружию (axe+shield → axe): щит не подменяет анимацию оружия.
    resolveUpper(weapon: string): UpperPose | null { const b = baseWeapon(weapon); const c = stance(b); return c && c.keys.length ? { pose: c.keys[0]!.pose, swing: swayOf(b) } : null; },
    attackClip(weapon: string): Clip | null { return atk(baseWeapon(weapon)); },
    // Отдельная поза щита (стойка_shield) + вес подмешивания (редактор). Нет клипа — оверлея нет.
    shieldOverlay(): { pose: Pose; mix: number } | null { const c = stance('shield'); if (!c || !c.keys.length) return null; const mix = shieldCfg[charId]?.mix ?? (fallbackId ? shieldCfg[fallbackId]?.mix : undefined) ?? 0.85; return { pose: c.keys[0]!.pose, mix }; },
  };
}
type GaitCfg = { gait?: Record<string, number>; pose?: Record<string, number>; gx?: Record<string, number>; plant?: Partial<PlantGrid> & { l?: [number, number]; r?: [number, number] } };
/** Загрузить тюн бега класса (pe_gait[charId]) в ГЛОБАЛЬНЫЕ GAIT/POSE и переданный gx; вернуть плант-сетку. Для ИГРОКА. */
export function applyGaitConfig(charId: string, gx: GXKnobs): PlantGrid {
  const cfgs = readJSON<Record<string, GaitCfg>>('pe_gait', {});
  const c = cfgs[charId];
  if (c?.gait) Object.assign(GAIT, c.gait);
  if (c?.pose) Object.assign(POSE, c.pose);
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
/** Вес совпадения РЕНДЕРА с манекеном (RB2, 0..1) per-char из pe_phys; фолбэк (монстры → Волкодав). Для ИГРЫ. */
export function loadMatch(charId: string, fallbackId?: string): number {
  const cfg = readJSON<Record<string, { match?: number }>>('pe_phys', {});
  return cfg[charId]?.match ?? (fallbackId ? cfg[fallbackId]?.match : undefined) ?? 0;
}

// ── PosePlayer: драйвер гейта для ИГРЫ (владеет своим состоянием) — тредмил-ноги + idle-стойка + физ-удар ──
const _vfl = new THREE.Vector3(), _vfr = new THREE.Vector3();
export class PosePlayer {
  readonly driver = new PoseDriver();
  private px = 0; private pz = 0; private vx = 0; private vz = 0; private yaw = 0;
  moveMag = 0; atkSpeed = 1;
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
  ) {}
  setWeapon(w: string): void { this.weapon = w; }
  setVel(vx: number, vz: number): void { this.vx = vx; this.vz = vz; }
  setYaw(yaw: number): void { this.yaw = yaw; }
  triggerAttack(clip: Clip | null): void { if (clip) { this.atk.clip = clip; this.atk.t = 0; } }
  get attacking(): boolean { return !!this.atk.clip; }
  /** Видимый facing (радианы) = yaw гейта (в Hips). */
  get facing(): number { return this.yaw; }
  /** Позировать this.human: тредмил-ноги (idle↔гейт по скорости) + верх (idle-стойка + мах + удар).
   *  Кормим гейт РЕАЛЬНЫМ yaw — StepPlanner видит смену facing и делает подшаг при повороте на месте; узость ног
   *  держит ЧИСТАЯ скорость (p.vel), а не дёрганая Δpos (её джиттер в vLat = ложный страйф разводил ноги). */
  step(dt: number): void {
    if (this.atk.clip) { this.atk.t += dt * this.atkSpeed; if (this.atk.t > clipDur(this.atk.clip)) { this.atk.clip = null; this.atk.t = -1; } }
    const vx = this.vx, vz = this.vz, yaw = this.yaw, spd = Math.hypot(vx, vz);
    this.moveMag = clamp(spd / GAIT.speedWalk, 0, 1);
    this.px += vx * dt; this.pz += vz * dt;
    this.driver.setWorld(this.px, this.pz, yaw, vx, vz);        // реальный yaw → стопы в верном body-кадре + подшаг при повороте
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
    // Вес гейта в ногах: идём/подшагиваем (разворот на месте) → ноги ведёт планировщик, иначе — поза idle-стойки.
    // Без этого при стоянии ноги целиком из idle: подшаг НЕ виден, а фидбэк setFeet отдаёт планировщику чужие стопы.
    // ⚠ `stepping` МЕРЦАЕТ (settled щёлкает по гистерезису) → держим ещё STEP_HOLD после конца подшага, иначе ноги
    // мигают idle↔гейт = тик при развороте на месте.
    if (this.driver.stepping) this.stepHold = STEP_HOLD; else this.stepHold = Math.max(0, this.stepHold - dt);
    const want = this.stepHold > 0 ? 1 : this.moveMag;
    this.legMag += (want - this.legMag) * Math.min(1, dt * 6);    // сглаживание — резкое переключение idle↔гейт дребезжит
    this.human.root.updateMatrixWorld(true);
    if (this.legMag > 0.5) {                                      // фидбэк фактических стоп (иначе шпагат) — только когда ноги ведёт гейт
      const fl = this.human.bones.get('LeftFoot')!.getWorldPosition(_vfl), fr = this.human.bones.get('RightFoot')!.getWorldPosition(_vfr);
      this.driver.setFeet(fl.x + this.px, fl.z + this.pz, fr.x + this.px, fr.z + this.pz);
    }
    gaitToHumanoid(this.human, this.weaponGroups(), this.gx, this.legMag, this.driver.update(dt), this.content, this.weapon, this.atk);
    this.human.bones.get('Hips')!.rotation.y = yaw;            // facing в Hips (углы ног body-local → корень крутим на yaw)
  }
}
