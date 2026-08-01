/**
 * ФИЗ-МИР на Jolt Physics (`jolt-physics` — wasm-порт движка из Horizon Forbidden West / Death Stranding 2).
 * Здесь: `PhysWorld` (мир Jolt — гравитация/слои + статика этажа: пол и видимые стены) и общий интерфейс
 * `RagdollHandle`. САМА кукла (единый риг игрока И монстров) — в `humanoidRagdoll.ts` + `gamePlayerDoll.ts`;
 * старый `makeRagdoll` (собственный 15-костный риг монстров) СНЕСЁН. Ведение к позе, «мышцы»-моторы, суставы —
 * см. `humanoidRagdoll.ts`. Единицы: 32u = 1 м, гравитация -9.81*32 (Jolt-допуски в метрах — масштабируем под мир).
 *
 * ⚠️ ГРАБЛИ emscripten: методы, возвращающие значение (`Quat.sIdentity()`, `Ragdoll.GetBodyID()`,
 * `Mat44.GetTranslation()` …), отдают ПЕРЕИСПОЛЬЗУЕМУЮ временную обёртку, а не свежий объект.
 * `J.destroy()` на такой — порча аллокатора (немой abort / «table index out of bounds» позже в Step),
 * а складывать её в массив бессмысленно (все элементы укажут на последнее значение).
 * Уничтожать можно ТОЛЬКО то, что создал сам через `new`; значения — копировать сразу.
 */
import * as THREE from 'three';
import initJolt from 'jolt-physics';
import { TILE, Cell, type DungeonLayout } from '@dm/shared';
import { WALL_H } from './env3d.js';

export type JoltNS = Awaited<ReturnType<typeof initJolt>>;
let J!: JoltNS;
/** Доступ к Jolt-неймспейсу после initPhysics (для сборки рэгдолла из других модулей — единый wasm-инстанс). */
export function jolt(): JoltNS { return J; }

/** Скретч-объекты: emscripten-обёртки живут в куче wasm — плодить их каждый кадр нельзя. */
let kPos!: InstanceType<JoltNS['RVec3']>, kRot!: InstanceType<JoltNS['Quat']>, zeroV!: InstanceType<JoltNS['Vec3']>;

export async function initPhysics(): Promise<void> {
  J = await initJolt();
  kPos = new J.RVec3(0, 0, 0);
  kRot = new J.Quat(0, 0, 0, 1);
  zeroV = new J.Vec3(0, 0, 0);
}

const LAYER_STATIC = 0, LAYER_DOLL = 1, NUM_LAYERS = 2;
const BP_STATIC = 0, BP_MOVING = 1, NUM_BP = 2;

/** Физмир + статика этажа. */
export class PhysWorld {
  readonly jolt: InstanceType<JoltNS['JoltInterface']>;
  readonly system: ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>;
  readonly bi: ReturnType<ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>['GetBodyInterface']>;
  private statics: InstanceType<JoltNS['BodyID']>[] = [];

  constructor() {
    const s = new J.JoltSettings();
    // Ассерты Jolt иначе прилетают немым abort() — включаем расшифровку (в release-сборке молчит).
    const str = (p: number): string => { let out = ''; for (let i = p; J.HEAPU8[i]; i++) out += String.fromCharCode(J.HEAPU8[i]!); return out; };
    const ah = new J.AssertFailedHandlerJS();
    ah.OnAssertFailed = (expr: number, msg: number, file: number, line: number): void => {
      console.error(`JOLT ASSERT: ${str(expr)} | ${str(msg)} @ ${str(file)}:${line}`);
    };
    s.mAssertFailedHandler = ah;
    const objFilter = new J.ObjectLayerPairFilterTable(NUM_LAYERS);
    objFilter.EnableCollision(LAYER_STATIC, LAYER_DOLL);
    objFilter.EnableCollision(LAYER_DOLL, LAYER_DOLL);   // самопересечение соседних костей глушит GroupFilter рэгдолла
    const bp = new J.BroadPhaseLayerInterfaceTable(NUM_LAYERS, NUM_BP);
    bp.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(BP_STATIC));
    bp.MapObjectToBroadPhaseLayer(LAYER_DOLL, new J.BroadPhaseLayer(BP_MOVING));
    s.mObjectLayerPairFilter = objFilter;
    s.mBroadPhaseLayerInterface = bp;
    s.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bp, NUM_BP, objFilter, NUM_LAYERS);
    this.jolt = new J.JoltInterface(s);
    J.destroy(s);
    this.system = this.jolt.GetPhysicsSystem();
    this.bi = this.system.GetBodyInterface();

    const g = new J.Vec3(0, -9.81 * TILE, 0);
    this.system.SetGravity(g);
    J.destroy(g);
    // Допуски Jolt откалиброваны на метры; у нас метр = 32 юнита — иначе контакты «слишком точные».
    const ps = this.system.GetPhysicsSettings();
    ps.mSpeculativeContactDistance *= TILE;
    ps.mPenetrationSlop *= TILE;
    this.system.SetPhysicsSettings(ps);
  }

  private addBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    const half = new J.Vec3(hx, hy, hz);
    const shape = new J.BoxShape(half, 0.5);
    const pos = new J.RVec3(cx, cy, cz);
    const rot = new J.Quat(0, 0, 0, 1);   // НЕ sIdentity(): его нельзя destroy (см. шапку файла)
    const bcs = new J.BodyCreationSettings(shape, pos, rot, J.EMotionType_Static, LAYER_STATIC);
    const body = this.bi.CreateBody(bcs);
    this.bi.AddBody(body.GetID(), J.EActivation_DontActivate);
    this.statics.push(body.GetID());
    J.destroy(bcs); J.destroy(rot); J.destroy(pos); J.destroy(half);
  }

  /** Пол + видимые стены (смежные с проходимой клеткой) как статические тела. */
  buildStatic(layout: DungeonLayout): void {
    this.clearStatic();
    const grid = layout.grid, rows = grid.length, cols = grid[0]!.length;
    const walk = (x: number, y: number): boolean => grid[y]?.[x] !== undefined && grid[y]![x] !== Cell.Wall;
    this.addBox((cols * TILE) / 2, -2, (rows * TILE) / 2, (cols * TILE) / 2, 2, (rows * TILE) / 2);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (grid[y]![x] !== Cell.Wall) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (walk(x + dx, y + dy)) { near = true; break; }
      if (!near) continue;
      this.addBox(x * TILE + TILE / 2, WALL_H / 2, y * TILE + TILE / 2, TILE / 2, WALL_H / 2, TILE / 2);
    }
  }

  clearStatic(): void {
    for (const id of this.statics) { this.bi.RemoveBody(id); this.bi.DestroyBody(id); }
    this.statics = [];
  }

  /** Плоский пол для редактора поз (без layout): большая тонкая плита, верх на y=0. */
  addGround(half = 300): void { this.addBox(0, -2, 0, half, 2, half); }
  /** Плоский пол-плита в произвольной точке XZ (верх на y=0) — для тредмил-физики игрока ВНЕ подземелья. */
  addGroundAt(cx: number, cz: number, half = 300): void { this.addBox(cx, -2, cz, half, 2, half); }

  step(dt: number): void { this.jolt.Step(dt, 1); }
}


// ── Хендл куклы (реализуется gamePlayerDoll.makeHumanoidDoll; общий для игрока и монстров) ──
export interface RagdollHandle {
  group: THREE.Group;
  /** Только для отладки из консоли (мостик кадров/драйв-тесты). */
  _dbg?: Record<string, unknown>;
  setPose(x: number, z: number, yaw: number): void;
  setMove(s: number): void;
  /** Чистая мир-скорость (u/с) — опц.; GamePlayerDoll кормит ею гейт (p.vel без [2×,0]-миганий дельты позиции). */
  setWorldVel?(vx: number, vz: number): void;
  /** Проиграть удар. clips (имена поз-клипов скила) — если заданы, чередуются по кругу; иначе удар по оружию. */
  attack(clips?: string[]): void;
  setDead(d: boolean): void;
  /** Дёрг при попадании: импульс в верх тела (dx,dz — направление отбрасывания, ед. вектор; power — сила ×). */
  hitReact(dx: number, dz: number, power?: number): void;
  /** Отброс трупа на смерти: сильный горизонтальный импульс в таз/торс (frac 0..1 — доля урона от HP → дальность). */
  knockback?(dx: number, dz: number, frac: number): void;
  /** Сменить оружие/щит куклы (пересобрать меши). Ключ weapon3d ('axe','sword+shield',…). */
  setWeapon?(key: string): void;
  update(dt: number): void;
  dispose(): void;
}
