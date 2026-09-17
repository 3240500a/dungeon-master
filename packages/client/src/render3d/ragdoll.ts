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
import type { MarkEvent } from './clipModel.js';

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
/** Фикс-шаг игровой физики (с). */
export const PHYS_H = 1 / 60;

/**
 * КИНЕМАТИЧЕСКИЙ ПРИВОД ТЕЛА (таз куклы): цель + КОГДА её достичь. Живёт в `PhysWorld`, ставит его кукла
 * (`setKinematic` в `update`, `holdKinematic`/`releaseKinematic` на смерти/подъёме/culling). Сам `MoveKinematic`
 * зовёт ТОЛЬКО мир — перед КАЖДЫМ шагом, с длиной ИМЕННО ЭТОГО шага. Поля — внутренние, снаружи не трогать.
 */
export interface KinDrive {
  readonly id: InstanceType<JoltNS['BodyID']>;
  readonly p: THREE.Vector3;
  readonly q: THREE.Quaternion;
  /** Интервал, за который кукла выдала цель (dt её `update`; при temporal-LOD — накопленный). 0 — «держать». */
  span: number;
  /** Мир-время (`PhysWorld.now`), к которому таз должен быть на цели. Считается в `advance`/`stepFrame`. */
  t: number;
  /** Цель свежая — `t` ещё не посчитан. */
  fresh: boolean;
  /** false — мир тело НЕ ведёт (мёртв/нокдаун — таз dynamic; вынут из мира — MoveKinematic активирует тело вне broadphase). */
  on: boolean;
}
const _kq = new THREE.Quaternion();

/** Физмир + статика этажа. */
export class PhysWorld {
  readonly jolt: InstanceType<JoltNS['JoltInterface']>;
  readonly system: ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>;
  readonly bi: ReturnType<ReturnType<InstanceType<JoltNS['JoltInterface']>['GetPhysicsSystem']>['GetBodyInterface']>;
  private statics: InstanceType<JoltNS['BodyID']>[] = [];
  // ── кинематические приводы (см. `advance`) ──
  private kin: KinDrive[] = [];   // массив, не Set: обход без итератора — без аллокаций на каждом шаге
  private now = 0;                // мир-время: сумма dt кадров (`advance`/`stepFrame`)
  private acc = 0;                // остаток аккумулятора фикс-шага: физика отстаёт от `now` на него
  private readonly kP: InstanceType<JoltNS['RVec3']>;
  private readonly kQ: InstanceType<JoltNS['Quat']>;

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
    this.kP = new J.RVec3(0, 0, 0);
    this.kQ = new J.Quat(0, 0, 0, 1);
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

  // ── КИНЕМАТИЧЕСКИЙ ТАЗ: MoveKinematic с длиной ШАГА, а не кадра ────────────────────────────────────────────
  //
  // ⚠ БЫЛО (с da5f331 по 17.09.2026): кукла в `update(dt)` сама звала `MoveKinematic(цель, dt КАДРА)`, а игра
  // шагала фикс-шагом 1/60 из аккумулятора. MoveKinematic ставит скорость (цель − тело)/dt, шаг интегрирует её
  // за 1/60 → за шаг таз проходит (1/60)/dt разрыва, и ошибка умножается на (1 − частота/60) на КАЖДОМ шаге.
  // ЗАМЕР (живой Jolt, риг 'base', скачок цели +5u): 120 Гц — раскачка ±5.00u навсегда; 144 Гц — ×−1.40 за шаг,
  // 8e26 u за 3 с бега; 165/240 Гц — Infinity/NaN. «60 Гц» с fp-шумом меток rAF: 22–23 % кадров без шага и
  // столько же с двумя → перелёт 5u, дрожь торса (RMS 2-й разности тела Torso по шагам) 20 076 u/с² при 225 на чистых 60.
  //
  // ⚠ «ПРОСТО ДЕРЖАТЬ» (MoveKinematic(цель, h) перед каждым шагом) расхождение снимает, но весь путь кадра уходит
  // в ОДИН шаг, а следующие стоят. ЗАМЕР дрожи торса, бег 300 u/с: 30 Гц — 31 150 (было 522); 60 Гц ±2 мс —
  // 18 174; 90 Гц — 10 675; 144 Гц — 5 997. Бюджет (max(h, остаток dt)) чинит 30 Гц и LOD через кадр, но не
  // 45 Гц (8 761), рваные 60 (15 487), 90 (10 675), 144 (5 997).
  //
  // ⭐ СТАЛО — цель с ВРЕМЕНЕМ: кукла сдаёт цель и свой dt (`setKinematic`), мир знает, к какому мир-времени таз
  // должен на ней быть (`t = now + max(0, span − dt)`; при temporal-LOD — к следующему апдейту куклы, как было), и
  // КАЖДЫЙ шаг двигает тело на долю h/(t − время физики) от текущей позы к цели → таз идёт по цели, сэмплированной
  // в моменты шагов, с ровной скоростью. ЗАМЕР дрожи торса: 30 Гц 522 (= было), 45 — 477 (было 10 047),
  // 60 ±2 мс — 398 (было 13 601), 90 — 282 (было 30 082), 120 — 226 (было 30 370), 144 — 246, 165 — 244,
  // 240 — 225 (было ∞), temporal-LOD через 2/3 кадра — 524/1046 (= было). Цена: таз физики отстаёт от
  // последней цели не больше чем на шаг движения (5u при 300 u/с) — там, где частота не кратна 60.

  /** Зарегистрировать кинематическое тело (выключено до первого `setKinematic`). Снять — `dropKinematic`. */
  kinematic(id: InstanceType<JoltNS['BodyID']>): KinDrive {
    const k: KinDrive = { id, p: new THREE.Vector3(), q: new THREE.Quaternion(), span: 0, t: 0, fresh: false, on: false };
    this.kin.push(k);
    return k;
  }
  dropKinematic(k: KinDrive): void {
    k.on = false;
    const i = this.kin.indexOf(k); if (i < 0) return;
    this.kin[i] = this.kin[this.kin.length - 1]!; this.kin.pop();
  }
  /** Цель тела. `span` — за какой интервал она выдана (dt апдейта куклы); 0 — прибыть сразу и держать. */
  setKinematic(k: KinDrive, pos: THREE.Vector3, quat: THREE.Quaternion, span: number): void {
    k.p.copy(pos); k.q.copy(quat);
    k.span = Number.isFinite(span) && span > 0 ? span : 0;
    k.fresh = true; k.on = true;
  }
  /** Держать тело там, где оно СЕЙЧАС (dynamic → kinematic наследует скорость падения — её надо погасить). */
  holdKinematic(k: KinDrive): void {
    const p = this.bi.GetPosition(k.id); const x = p.GetX(), y = p.GetY(), z = p.GetZ();
    const r = this.bi.GetRotation(k.id); _kq.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW());
    k.p.set(x, y, z); k.q.copy(_kq);
    k.span = 0; k.fresh = true; k.on = true;
  }
  /** Мир тело больше не ведёт (смерть/нокдаун — таз dynamic; вынос из мира). До следующего `setKinematic`/`holdKinematic`. */
  releaseKinematic(k: KinDrive): void { k.on = false; }

  /** Посчитать `t` свежим целям: кадр длиной `dt` уже прибавлен к `now`. */
  private stampKinematic(dt: number): void {
    for (let i = 0; i < this.kin.length; i++) {
      const k = this.kin[i]!;
      if (k.fresh) { k.t = this.now + Math.max(0, k.span - dt); k.fresh = false; }
    }
  }
  /**
   * MoveKinematic ВСЕМ включённым телам перед шагом длины `h`. `simT` — мир-время состояния физики ДО шага;
   * NaN — «держать»: доехать за этот шаг (шаг без часов — `step`). Зовётся на КАЖДОМ шаге: скорость kinematic-тела
   * в Jolt живёт между шагами (замер: 10 → 20 → 30 без новых MoveKinematic), доехавшее тело надо останавливать.
   */
  private driveKinematic(h: number, simT: number): void {
    const bi = this.bi, kP = this.kP, kQ = this.kQ;
    for (let i = 0; i < this.kin.length; i++) {
      const k = this.kin[i]!;
      if (!k.on) continue;
      const rem = k.t - simT;                          // NaN при «держать» → сравнение ложно → f = 1
      const f = rem > h + 1e-9 ? h / rem : 1;
      if (f < 1) {
        const p = bi.GetPosition(k.id); const x = p.GetX(), y = p.GetY(), z = p.GetZ();   // временные обёртки — копируем сразу
        const r = bi.GetRotation(k.id); _kq.set(r.GetX(), r.GetY(), r.GetZ(), r.GetW()).slerp(k.q, f);
        kP.Set(x + (k.p.x - x) * f, y + (k.p.y - y) * f, z + (k.p.z - z) * f);
        kQ.Set(_kq.x, _kq.y, _kq.z, _kq.w);
      } else {
        kP.Set(k.p.x, k.p.y, k.p.z); kQ.Set(k.q.x, k.q.y, k.q.z, k.q.w);
      }
      bi.MoveKinematic(k.id, kP, kQ, h);
    }
  }

  /**
   * ОДИН шаг длины `h`, цели «держать»: kinematic-тела доезжают до своей цели за этот шаг. Для вызывающих без
   * часов кадра — редактор поз (`step(min(dt, 1/60))`, рендер после шага → таз на цели, без недоезда ниже 60 fps),
   * запекание, тесты. Игра шагает `advance`.
   */
  step(h: number): void {
    for (let i = 0; i < this.kin.length; i++) this.kin[i]!.fresh = false;
    this.driveKinematic(h, NaN);
    this.jolt.Step(h, 1);
  }

  /**
   * ИГРА: кадр длиной `dt` фикс-шагами `h` (аккумулятор, не больше `maxSteps` за кадр — как было в online3d).
   * Кинематические цели ведутся по времени (см. блок выше). Возвращает число шагов.
   */
  advance(dt: number, h = PHYS_H, maxSteps = 4): number {
    if (!(dt > 0)) return 0;
    this.now += dt;
    this.stampKinematic(dt);
    this.acc += dt;
    let n = 0;
    while (this.acc >= h && n < maxSteps) {
      this.driveKinematic(h, this.now - this.acc);
      this.jolt.Step(h, 1);
      this.acc -= h; n++;
    }
    return n;
  }

  /**
   * Кадр `dt` целиком, подшагами не длиннее `maxH` (dt ≤ 1/60 → один шаг длины dt, как `step`): время физики =
   * время кадра, цели ведутся по времени, после вызова таз НА цели. Для редактора — вместо `step(min(dt, 1/60))`,
   * который ниже 60 fps считает физику в замедлении (пины/вес оружия — импульсы ·dt — там ×dt·60 сильнее).
   */
  stepFrame(dt: number, maxH = PHYS_H): number {
    if (!(dt > 0)) return 0;
    const n = Math.max(1, Math.ceil(dt / maxH - 0.1)), h = dt / n;   // −0.1: dt = 1/60 с fp-шумом → 1 шаг
    this.now += dt;
    this.stampKinematic(dt);
    for (let i = 0; i < n; i++) {
      this.driveKinematic(h, this.now - dt + i * h);
      this.jolt.Step(h, 1);
    }
    return n;
  }
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
  /** Проиграть удар. clips (имена поз-клипов скила) — если заданы, чередуются по кругу; иначе удар по оружию.
   *  windowSec — окно атаки (attack-лок): клип ужимается, чтобы отыграть целиком за него (быстрее атака → быстрее клип). */
  /** `windupSec` — вайндап сервера: размеченный кадр `impact` садится ровно на момент урона. */
  attack(clips?: string[], windowSec?: number, windupSec?: number): void;
  /** Метки кадров играющего клипа (удар/звук/VFX/шаг/тряска). Клип говорит ЧТО и КОГДА, обработчик — КАК.
   *  Звук уже подписан (`animSfx.markSfx`); VFX/тряска — свободные места на том же шве. */
  onMark?: ((e: MarkEvent) => void) | null;
  /** Атака ЗАЖАТА: пока true, конец размеченного окна `combo` начинает следующий удар цепочки, а не стойку. */
  setAttackHold?(on: boolean): void;
  setDead(d: boolean): void;
  /** Дёрг при попадании: импульс в верх тела (dx,dz — направление отбрасывания, ед. вектор; power — сила ×). */
  hitReact(dx: number, dz: number, power?: number): void;
  /** Отброс трупа на смерти: сильный горизонтальный импульс в таз/торс (frac 0..1 — доля урона от HP → дальность). */
  knockback?(dx: number, dz: number, frac: number): void;
  /** Нокдаун (сбить с ног): падение рагдоллом в направлении (dx,dz), лежит downSec, потом ВСТАЁТ за riseSec
   *  (таз kinematic лерпит с пола к стойке + рампа моторов/бленда). Не смерть — по завершении обычный режим. */
  knockdown?(dx: number, dz: number, downSec: number, riseSec: number): void;
  /** Сменить оружие/щит куклы (пересобрать меши). Ключ weapon3d ('axe','sword+shield',…). */
  setWeapon?(key: string, models?: { main?: string; off?: string }): void;
  /** Свап внешности брони по слотам (C6c): slot→{modelId, materialId} надетых предметов → пересобрать скин-слой (сабмеш + материал). */
  setAppearance?(equip: Record<string, { modelId?: string; materialId?: string } | undefined>): void;
  /** Боевой айдл: on=true → боевая стойка (combat_idle), off → обычная. Кроссфейд плавный (GAIT.combatBlend). */
  setCombat?(on: boolean): void;
  /** Состояния с сервера: оглушён / сбит с ног. Кукла отыгрывает их клипом через слот действия (Ф1.5). */
  setState?(stunned: boolean, downed: boolean): void;
  /** Окно-culling: on=false → тела куклы вон из физ-мира (pw.step их не считает), меш замерзает; on=true → вернуть + снап. */
  setSimEnabled?(on: boolean): void;
  /** Debug-режим физики монстра: 'kinematic' = рисовать из позы (тела вон из pw.step), физика лишь транзиентно на удар/смерть; 'physics' = как обычно. */
  setPhysicsMode?(mode: 'physics' | 'kinematic'): void;
  /** Поза-LOD: on=true → пропускать FOOT-IK (заземление стоп) — для ДАЛЬНИХ монстров в кадре (детали стоп не видно, дешевле). */
  setPoseLod?(on: boolean): void;
  update(dt: number): void;
  dispose(): void;
}
