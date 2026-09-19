import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import {
  PosePlayer, localStorageContent, applyGaitConfig, loadTwistStates, loadFootLift, setLocoMixOverride,
  TURN_ACCEL_SEC, WARP_ACCEL_SEC,
  type PoseContent, type GXKnobs, type TwistStates,
} from './poseRuntime.js';
import { bakeGaitToClip, bakeTurnSet, GAIT_PRESETS } from './clipBake.js';
import { type Clip } from './clipModel.js';
import { makeNetInterp } from './netInterp.js';
import { driveActor, facingToYaw, type DriveState, type DrivenDoll } from './driveActor.js';
import { facingFrom, AIM_DEAD } from './playerInput.js';
import { pelvisHeading } from './pelvisFrame.js';
import { GAIT, POSE, GAIT_BASE, POSE_BASE } from './gaitKnobs.js';
import MODELS from '@dm/shared/config/data/models.json' with { type: 'json' };

/**
 * ⭐⭐ СТЕНД ДИАГНОСТИКИ: «на бегу вперёд корпус дёргается, а в редакторе те же клипы играются плавно».
 *
 * План §2. Стенд НИЧЕГО НЕ ЧИНИТ — он МЕРЯЕТ. Жалоба автора звучит как «анимация чуть подлагивает», но клипы
 * в редакторе идут гладко, значит ищем не в клипах, а во ВХОДАХ: в игре скорость и прицел приезжают снапшотами
 * 30 Гц, а кукла позируется КАЖДЫЙ кадр. Редактор кормит превью ПОСТОЯННЫЕ скорость и прицел — он физически не
 * может воспроизвести беду и контролем не является.
 *
 * Стенд собран из НАСТОЯЩИХ шипящих модулей, без единой переписанной копии:
 *   сервер БОЕВОЙ каденции (сим 30 Гц, рассылка 20 — см. `SIM_HZ`/`SNAP_HZ`; дрожание прихода ±5 мс)
 *     → `makeNetInterp` (`push` на снапшот, `at` на кадр — скорость держится постоянной между снапшотами)
 *     → `facingFrom` от НАРИСОВАННОЙ позиции к неподвижному курсору (ровно как `online3d.ts:775`)
 *     → `driveActor` (`setVel` → `setYaw` → `step`, порядок зеркалит `gamePlayerDoll.update`)
 *     → `PosePlayer` с опубликованными данными воина на риге knight_06 и запечённым набором клипов.
 *
 * МЕРА (её в проекте не было вовсе; ближайшая — по рукам в `clipOnly.test.ts`): мировой курс Hips / Spine /
 * Chest / UpperChest через `pelvisFrame.pelvisHeading`, первая (°/с) и вторая (°/с²) разности, полный угол
 * кватерниона за кадр и число смен знака первой разности в секунду. Всё нормировано НА СЕКУНДУ — тогда
 * 60 / 120 / 144 Гц сравнимы, и всё, что РАСТЁТ С ЧАСТОТОЙ КАДРОВ, — это грабля «порог на кадр вместо в секунду».
 *
 * Счётчики снимаются с приватных полей `PosePlayer` (в TS private — только на компиляции): защёлка `turning`,
 * сбросы `aimStableFor`, щелчки стороны страйфа `latPlusX`, срабатывания кроссфейда колонок, темп фазы клипа.
 *
 * ⭐⭐ РЕВЮ 19.09 добавило сюда: боевую каденцию рассылки (`SNAP_HZ` 20 при симе 30 — Δtick чередуется 2,1;
 * прежние 30 остались отдельной строкой матрицы), КАНАЛ ТАЗА в отчёте и сторожах (его не стерёг никто, и в
 * дыру провалились две правки), сцены «встал посреди доворота» (`stopAt`/`stopLag`), «мышь событиями»
 * (`mouseHz`/`aimW` — ввод квантован не кадром), «таз открыт» (`hipsMode`) и промахи мимо курсора меньше
 * двух единиц (особая точка мягкой мёртвой зоны). Разбор находок — в README, раздел «Ревью 19.09».
 *
 * ЗАПУСК ПОЛНОЙ МАТРИЦЫ (сценарии × частоты × абляции, ~70 с):
 *   TJ_FULL=1 npx vitest run packages/client/src/render3d/torsoJitter.test.ts
 * Куда писать таблицы: TJ_OUT=<путь без расширения> (по умолчанию не пишет никуда).
 * Покадровый дамп: TJ_DUMP=<сцена>|<Гц>|<абляция>.
 * Опубликованные данные: TJ_POSE=<pose_now.json>; файла нет → дефолты конфига (стенд всё равно бежит).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ ЧТО ЗАМЕР ПОКАЗАЛ (18.09, рыцарь knight_06, опубликованный воин, запечённый набор, 10 с на прогон).
 * Контроль — абляция H (путь редактора): ТОЧНО ОДИНАКОВА на 60 / 120 / 144 — таз 0.0 °/с, грудь 85 °/с,
 * рывок груди 470–500 °/с², смен знака 1.7/с. Жалоба «в редакторе плавно» этим подтверждена численно.
 *
 * 1. ВПЕРЁД ХУЖЕ, НАЗАД СЛАБЕЕ — подтверждено, 36-кратно. Одна и та же геометрия (пеленг 20°, 80 ед/с,
 *    курсор 300 ед), бег НА курсор против бега ОТ него: таз p99 452.9 против 12.4 °/с, `rootYaw` 171.9
 *    (упор рейт-лимита `turnRate`) против 0.0, переключений `turning` 27.0/с против 1.5/с (144 Гц).
 *    Причина ровно та, что в плане: скорость пеленга `v·sin θ / r` — на сближении растёт, на удалении падает.
 *
 * 2. ГЛАВНЫЙ ПОДОЗРЕВАЕМЫЙ ПОДТВЕРЖДЁН (порог «прицел стоит» на кадр, `:2071`). В полосе, где скорость
 *    прицела лежит между 0.6 и 1.44 рад/с (`band_d133`, `band_d90`), ОДНО И ТО ЖЕ движение считается
 *    «прицел едет» на 60 Гц и «прицел стоит» на 120 / 144: сбросов `aimStableFor` 0.7/с → 0.0/с → 0.0/с.
 *    Следствие — защёлка `turning` щёлкает 8.6 → 19.2 → 23.0 раз в секунду (2.7×), доля кадров с тазом
 *    на упоре рейт-лимита 3.5 → 8.0 → 8.0 %, рывок груди 8842 → 19918 → 26476 °/с² (3.0×).
 *    ⚠ НО: абляция E (`relaxTime = ∞`) убирает ЩЁЛКАНЬЕ (27.0/с → 0.8/с) и НЕ убирает рывок
 *    (17332 → 18200 °/с²), а таз делает ХУЖЕ (p99 452.9 → 543.5). Предсказание плана «убирает relaxTime = ∞»
 *    ОПРОВЕРГНУТО замером: без relax таз держит дольше и догоняет БОЛЬШИМ куском.
 *
 * 3. САМЫЙ БОЛЬШОЙ ОДИНОЧНЫЙ ВКЛАД В РЫВОК КОРПУСА — 30-герцовая СКОРОСТЬ, а не прицел. Абляция B
 *    (точная скорость каждый кадр) при живом прицеле: рывок груди 8842 → 5285 °/с² (−40 %), смен знака
 *    6.5 → 3.7/с (−43 %), верх груди p99 120 → 102. Абляция D (прицел заморожен, скорость живая) оставляет
 *    рывок 6836–25227 °/с² при нуле по тазу — то есть корпус дёргает и БЕЗ всякого прицела.
 *    ⭐ Источник ряби найден: абляция I (снапшоты приходят строго по 1/30 с) даёт рябь скорости 0.0 % —
 *    вся рябь 11.2–11.8 % рождается из ДРОЖАНИЯ ПРИХОДА ±5 мс: `netInterp.push` делит путь на интервал
 *    между приходами, и ±10 мс на 33 мс — это ±30 % мгновенной оценки, из которых после `VEL_TAU` остаётся ~11 %.
 *
 * 4. МЁРТВАЯ ЗОНА ПРИЦЕЛА (`AIM_DEAD` 10) — редкий, но САМЫЙ КРУПНЫЙ скачок, и он ровно однокадровый.
 *    Проход в 4 ед от курсора: верх груди max 2666 / 5068 / 5922 °/с на 60 / 120 / 144 (растёт ЛИНЕЙНО с
 *    частотой — подпись скачка за один кадр). Абляция C (пеленг без зоны): 683 / 740 / 749 °/с — ровно,
 *    без роста. То есть зона превращает быстрый, но НЕПРЕРЫВНЫЙ разворот пеленга в скачок 55° за кадр.
 *    В 25 ед от курсора (мимо зоны) разницы A и C нет — беда именно в зоне, и достижима только на беге ВПЕРЁД.
 *
 * 5. ЧЕГО В СПИСКЕ ПЛАНА НЕ БЫЛО: ПЕРЕБРОС СЕКТОРА ДОВОРОТА (`stepDirWarp`). Канал `warp` даёт p99
 *    400–435 °/с при пике 795 — втрое выше физического потолка torso-lead (172 °/с). Это `warpMax` 40°,
 *    перекладываемые за `warpSmooth` 0.12 с на смене сектора: ±40° / 0.12 ≈ 667 °/с, плюс 172 от таза.
 *    Событий мало (2 за 10 с), но каждое — самый большой одиночный рывок таза на прямом беге.
 *
 * 6. СНЯТЫ С ПОДОЗРЕНИЯ ЗАМЕРОМ:
 *    • сторона страйфа (`latPlusX`): абляция F (сторона закреплена правкой исходника в worktree) даёт
 *      числа БИТ В БИТ те же; щелчков 0.0–0.3/с, кроссфейд колонок не срабатывает НИ РАЗУ (`xf/s` 0.0);
 *    • клипы: абляция G (`locoMix` 0, чистая процедурка) почти не меняет картину (17332 → 16787 °/с²);
 *    • дрожание прихода само по себе: абляция I отличается от A только рябью скорости (см. п. 3).
 *
 * ⚠ ЧИТАТЬ `d2` ОСТОРОЖНО: у кусочно-постоянного входа (скорость с сети) вторая разность растёт с частотой
 * кадров ПО ПОСТРОЕНИЮ и сама по себе баги не доказывает. Подпись бага — рост СЧЁТЧИКОВ ЛОГИКИ
 * (`turn/s`, `stab/s`, `lim%`): это состояния, а не производные, и от частоты кадров зависеть не должны.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────── опубликованные данные и риг ───────────────────────────

const POSE_JSON = process.env.TJ_POSE
  ?? 'C:/Users/a/AppData/Local/Temp/claude/C--work-Games-Art-Games-Art-dungeon-master/a8f001bd-8530-46a8-b1c3-b63c4094c321/scratchpad/pose_now.json';
const HAS_PUB = existsSync(POSE_JSON);
const FULL = process.env.TJ_FULL === '1';
const OUT = process.env.TJ_OUT ?? '';

type Model = { id: string; kind?: string; body?: unknown; boneScale?: unknown; boneOffsets?: Record<string, number[]> };
const KNIGHT = (MODELS as unknown as Model[]).find((m) => m.id === 'knight_06_modular_rig');
const GX: GXKnobs = { armDown: 1.35, elbowBend: 0.25 };
const CHAR = 'warrior';
/** Кости, чей мировой курс и есть «корпус» из жалобы. */
const TORSO = ['Hips', 'Spine', 'Chest', 'UpperChest'] as const;
type TorsoBone = typeof TORSO[number];
/**
 * Разбор канала таза: `rootYaw` (torso-lead, рейт-лимит `turnRate`) и `warp` — ВЕСЬ остальной рыск таза
 * (`pelvisYawWorld − aimRootYaw`): доворот под ход, ПОВОРОТ ТАЗА ручкой, качание рыска и рыск из клипа.
 * ⚠ Было `pelvisYaw − aimRootYaw`, то есть только курс: рыск, сидящий В КОСТИ, мимо этой меры проходил молча.
 * Оба — публичные геттеры `PosePlayer`, так что разбор не лезет во внутренности.
 * Без него «таз дёрнулся» не отличить: рейт-лимит физически не может дать больше 172 °/с, а замер даёт 700+.
 */
const CHAN = [...TORSO, 'rootYaw', 'warp'] as const;
type Chan = typeof CHAN[number];
const DEG = 180 / Math.PI;
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

let lib: Map<string, Clip>;
beforeAll(() => {
  const store = new Map<string, string>();
  if (HAS_PUB) {
    const snap = JSON.parse(readFileSync(POSE_JSON, 'utf8')) as Record<string, unknown>;
    for (const k of Object.keys(snap)) store.set(k, JSON.stringify(snap[k]));
  }
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null,
    get length() { return store.size; },
  } as Storage;
  // Набор клипов — ровно как кнопка редактора и как `clipOnly.test.ts`: 8 клипов хода + стойка + повороты на месте.
  Object.assign(GAIT, GAIT_BASE); Object.assign(POSE, POSE_BASE);
  const plant = applyGaitConfig(CHAR, GX);
  const h = buildHumanoid(rigOpts());
  h.footLift = loadFootLift(CHAR);
  const p = new PosePlayer(h, () => [], localStorageContent(CHAR), 'none', GX, plant, loadTwistStates(CHAR));
  lib = new Map();
  for (const s of GAIT_PRESETS) lib.set(s.name, bakeGaitToClip(p, h, s, { character: CHAR, weapon: 'none' }).clip);
  for (const r of bakeTurnSet(p, h, { character: CHAR, weapon: 'none' })) lib.set(r.clip.name, r.clip);
});
afterAll(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage; });
afterEach(() => { setLocoMixOverride(null); });

function rigOpts(): Parameters<typeof buildHumanoid>[0] {
  return KNIGHT
    ? { profile: KNIGHT.body as never, boneScale: KNIGHT.boneScale as never, boneOffsets: KNIGHT.boneOffsets, fingers: true }
    : {};
}
const withLib = (base: PoseContent): PoseContent => ({
  ...base,
  locoClip: (names: readonly string[]) => { for (const n of names) { const c = lib.get(n); if (c) return c; } return null; },
});

// ─────────────────────────── кукла: адаптер вокруг `driveActor` ───────────────────────────

/**
 * Мини-кукла, повторяющая ШОВ `gamePlayerDoll.update`: `setVel(мировая скорость)` → `setYaw(курс)` → `step(dt)`.
 * Всё остальное (физика, скин, заземление) к подёргиванию корпуса отношения не имеет и сюда не тащится:
 * поза собирается ровно тем же `PosePlayer`, что и в игре.
 */
interface Doll extends DrivenDoll { p: PosePlayer; h: Humanoid }
function makeDoll(twist: TwistStates, content: PoseContent): Doll {
  Object.assign(GAIT, GAIT_BASE); Object.assign(POSE, POSE_BASE);
  const plant = applyGaitConfig(CHAR, GX);
  const h = buildHumanoid(rigOpts());
  h.footLift = loadFootLift(CHAR);
  const p = new PosePlayer(h, () => [], content, 'none', GX, plant, twist);
  let yaw = 0, wvx = 0, wvz = 0, first = true;
  return {
    p, h,
    setPose(_x, _z, y) { yaw = y; },
    setWorldVel(vx, vz) { wvx = vx; wvz = vz; },
    setMove() { /* магнитуда не нужна: скорость приходит `setWorldVel`, как в игре */ },
    setDead() { /* жив */ },
    setCombat(c) { p.setCombat(c); },
    setState() { /* ни стана, ни нокдауна */ },
    update(dt) {
      p.setVel(wvx, wvz); p.setYaw(yaw);
      if (first) { p.snapYaw(); first = false; }
      p.step(dt);
    },
  };
}

// ─────────────────────────── сценарий и прогон ───────────────────────────

/**
 * Геометрия сценария в СЕРВЕРНЫХ осях (x, y=мировой z), фейсинг как у сервера: 0 = +X, против часовой.
 * Курсор неподвижен в мире, персонаж идёт по прямой с постоянной скоростью.
 */
interface Scene {
  name: string;
  spd: number;                 // ед/с
  r0: number;                  // стартовое расстояние до курсора
  bearingDeg: number;          // пеленг на курсор от оси +X (курсор ВПЕРЕДИ по ходу, если идём вперёд)
  /**
   * true — ход в −X при том же курсоре: персонаж смотрит на курсор и БЕЖИТ ОТ НЕГО (спиной). Расстояние
   * РАСТЁТ, значит скорость поворота прицела `v·sin θ / r` падает — ровно та асимметрия «вперёд хуже,
   * назад слабее», ради которой сценарии и разведены.
   */
  recede?: boolean;
  missU?: number;              // боковой промах мимо курсора (проход рядом / через мёртвую зону)
  /**
   * ⭐ ЗАДАНИЕ ЧЕРЕЗ ТОЧКУ НАИБОЛЬШЕГО СБЛИЖЕНИЯ — им и меряется ГЛАВНЫЙ подозреваемый.
   * Скорость поворота прицела в этой точке РОВНО `spd / dMin`, а порог «прицел стоит» — 0.01 рад ЗА КАДР,
   * то есть `0.01 × Гц` рад/с: 0.6 при 60, 1.2 при 120, 1.44 при 144. Меняя `dMin`, кладём скорость прицела
   * ниже полосы, В ПОЛОСУ и выше неё — и сразу видно, где 60 / 120 / 144 расходятся.
   * `tMin` — когда это сближение случается (ставим ПОСЛЕ прогрева, иначе событие не попадёт в окно замера).
   */
  dMin?: number;
  tMin?: number;
  /**
   * ⭐ ВВОД СОБЫТИЯМИ: стоим на месте, прицел ведём мышью `mouseHz` событий в секунду со скоростью `aimW` рад/с.
   * Именно так приходит мышь (125 Гц у обычной, 1000 у игровой), и именно на этом видно, что порог
   * «прицел стоит» обязан быть РАТОЙ, а не сравнением приращения за кадр (см. `AIM_STILL_RATE`).
   */
  mouseHz?: number;
  aimW?: number;
  /**
   * ⭐ «ВСТАЛ И ДОВОРАЧИВАЮСЬ К МОНСТРУ». В этот момент сервер роняет скорость в НОЛЬ ЗА ТИК
   * (`balance.moveInertia.enabled` false — инерции нет вовсе), клиент гасит предсказание (`brake`), а
   * прицел продолжает ехать `aimW` рад/с (игрок ведёт мышь). Ровно тот стык, на котором «разгон только
   * на ходу» переключает привод таза посреди доворота.
   */
  stopAt?: number;
  /** Через сколько после начала доворота игрок отпускает кнопку (сек). Ноль — встал ровно в тот же кадр. */
  stopLag?: number;
  /** Поворот таза (`POSE.hipsTurn`) на прогон, °: он тоже едет в рыск таза и тоже обязан влезать в предел скорости. */
  hipsTurnDeg?: number;
}
type Abl = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

interface Row { t: number; ch: number[]; q: THREE.Quaternion[]; aim: number; turning: boolean; stable: number; lat: boolean; fade: number; phase: number; turnClip: string | null; sector: number; spd: number; rate: number; hold: boolean }

interface RunOpts { sc: Scene; hz: number; abl: Abl; secs?: number; jitter?: boolean; seed?: number; snapHz?: number }

/**
 * ⭐⭐ КАДЕНЦИЯ СЕРВЕРА — ДВА РАЗНЫХ ЧИСЛА, и стенд обязан держать оба.
 *
 * `SIM_HZ` — темп симуляции и ЕДИНИЦА поля `tick` (`scheduler.TICK_MS` = 1000/30). `SNAP_HZ` — темп
 * РАССЫЛКИ снапшотов (`room.SNAPSHOT_HZ`, умолчание 20). Они развязаны, поэтому Δtick между снапшотами
 * ЧЕРЕДУЕТСЯ 2, 1, 2, 1 — и калибровка «секунд в тике» видит попеременно длинный и короткий интервал.
 * ⚠ Первая версия стенда слала 30 снапшотов в секунду (Δtick всегда 1) — это НЕ боевая каденция, и
 * остаточная рябь скорости на ней выходила втрое меньше настоящей. Умолчание здесь — боевое (20).
 */
const SIM_HZ = 30;
const SNAP_HZ = 20;

function run(o: RunOpts): Row[] {
  const { sc, hz } = o;
  const secs = o.secs ?? 10, dt = 1 / hz;
  const twist = loadTwistStates(CHAR);
  if (o.abl === 'E') for (const k of ['stand', 'walk', 'run'] as const) twist[k].relaxTime = Infinity;
  const doll = makeDoll(twist, withLib(localStorageContent(CHAR)));
  POSE.hipsTurn = POSE.hipsTurnRun = (sc.hipsTurnDeg ?? 0) * Math.PI / 180;
  setLocoMixOverride(o.abl === 'G' ? 0 : 1);

  // Курсор стоит на месте ВПЕРЕДИ (+X). Ход: вперёд +X (сближаемся) или назад −X (удаляемся, лицом к курсору).
  const vx = sc.recede ? -sc.spd : sc.spd, vz = 0;
  const b = sc.bearingDeg * Math.PI / 180;
  const cursor = sc.dMin != null ? { x: 0, y: sc.dMin }
    : sc.missU != null ? { x: sc.r0, y: sc.missU }
      : { x: sc.r0 * Math.cos(b), y: sc.r0 * Math.sin(b) };
  const x0 = sc.dMin != null ? -vx * (sc.tMin ?? 5) : 0, z0 = 0;

  // ── сервер: сим 30 Гц, рассылка `snapHz` (Δtick чередуется 2,1 при 20), дрожание прихода ±5 мс ──
  let seed = (o.seed ?? 1) >>> 0;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const snaps: { x: number; z: number; at: number; tick: number }[] = [];
  {
    const snapHz = o.snapHz ?? SNAP_HZ;
    let tick = 0, acc = 0;
    for (; tick / SIM_HZ <= secs + 1; ) {
      const st = tick / SIM_HZ, sm = Math.min(st, sc.stopAt != null ? sc.stopAt + (sc.stopLag ?? 0) : Infinity);
      const j = o.jitter ? (rnd() - 0.5) * 0.010 : 0;      // ±5 мс
      snaps.push({ x: x0 + vx * sm, z: z0 + vz * sm, at: Math.max(0, st + j), tick });
      acc += SIM_HZ / snapHz;                              // 1.5 при 20 Гц → шаг тика 2, 1, 2, 1 …
      const d = Math.max(1, Math.round(acc)); acc -= d; tick += d;
    }
  }

  const interp = makeNetInterp();
  const ID = 'pself';
  const state: DriveState = { d: doll, vx: 0, vz: 0, lx: x0, lz: z0 };
  const aim0 = Math.atan2(cursor.y - z0, cursor.x - x0);
  let facing = aim0, aimStop = aim0;                              // старт: смотрим на курсор
  let si = 0, drawX = x0, drawZ = z0;
  const rows: Row[] = [];
  const priv = doll.p as unknown as {
    turning: boolean; aimStableFor: number; clipPhase: number;
    colPrev: { latPlusX: boolean }; colFade: { w: number }; dirWarp: { sector: number };
    leadRate: number; turnAccelHold: boolean;
  };
  const qtmp = TORSO.map(() => new THREE.Quaternion());

  for (let f = 0; f <= Math.round(secs * hz); f++) {
    const t = f * dt;
    // ⚠ ВРЕМЯ СНАПШОТА — ВРЕМЯ ЕГО ПРИХОДА, А НЕ КАДРА. В игре `snapAt` пишется в обработчике сокета
    // (`online3d.ts:1002`), а `feedInterp` только раздаёт его на кадре. Квантовать `t` кадром было бы
    // НЕВЕРНО: интервал между `push` перестал бы быть 1/30, и оценка скорости рябила бы вдвое сильнее,
    // чем в игре, — стенд мерил бы собственную ошибку.
    // ⭐ Тик снапшота отдаём ровно как игра (`online3d.feedInterp`): `netInterp` считает скорость по ЧАСАМ
    // СЕРВЕРА, а не по дрожащему приходу. Абляция J — прежний путь (тика нет), она и мерит цену ряби.
    while (si < snaps.length && snaps[si]!.at <= t) {
      const sn = snaps[si]!;
      if (o.abl === 'J') interp.push(ID, sn.x, sn.z, sn.at);
      else interp.push(ID, sn.x, sn.z, sn.at, sn.tick);
      si++;
    }
    // Отпустил кнопку: клиент гасит предсказание СВОЕЙ скорости мгновенно (инерции в балансе нет) —
    // ровно `online3d.ts`, `interp.brake(focus, Infinity, …)`.
    if (sc.stopAt != null && t >= sc.stopAt + (sc.stopLag ?? 0)) interp.brake(ID, Infinity, t, dt);
    const ip = interp.at(ID, t);
    const exact = { x: x0 + vx * t, z: z0 + vz * t };
    // ── позиция кадра и скорость: что именно видит кукла ──
    const drawn = o.abl === 'H' ? exact : { x: ip.x, z: ip.z };
    drawX = drawn.x; drawZ = drawn.z;
    const vel = o.abl === 'B' || o.abl === 'C' || o.abl === 'H' ? { x: vx, z: vz } : { x: ip.vx, z: ip.vz };
    // ── прицел: РОВНО как `online3d.ts:775` — от НАРИСОВАННОЙ позиции к неподвижному курсору ──
    // ⭐ Мышь СОБЫТИЯМИ: курсор переставляется `mouseHz` раз в секунду, между событиями прицел СТОИТ.
    // Кадр видит либо ноль, либо целый скачок события — и порог «прицел стоит» обязан этого не замечать.
    if (sc.mouseHz) facing = aim0 + (sc.aimW ?? 0) * Math.floor(t * sc.mouseHz) / sc.mouseHz;
    // После остановки прицел ведёт мышь (игрок доворачивается к монстру), а не пеленг на курсор.
    // Дуга ограничена 90°: развернулись к монстру и встали — иначе прицел уезжает кругами и мера меряет кламп скрутки.
    else if (sc.stopAt != null && t >= sc.stopAt) facing = aimStop + Math.min(Math.PI / 2, (sc.aimW ?? 0) * (t - sc.stopAt));
    else if (o.abl === 'D' || o.abl === 'H') { /* прицел постоянный: не трогаем `facing` */ }
    else if (o.abl === 'C') facing = facingFrom(facing, cursor, exact.x, exact.z, { x: 0, y: 0 }, true, 0);
    else facing = facingFrom(facing, cursor, drawX, drawZ, { x: 0, y: 0 }, true, AIM_DEAD);
    if (sc.stopAt != null && t < sc.stopAt) aimStop = facing;   // от какого угла мышь поведёт дугу после остановки

    driveActor(state, drawX, drawZ, facing, true, dt, { vel, combat: false });

    doll.h.root.updateMatrixWorld(true);
    const ch: number[] = [], q: THREE.Quaternion[] = [];
    TORSO.forEach((n, i) => {
      const bn = doll.h.bones.get(n)!;
      bn.getWorldQuaternion(qtmp[i]!);
      ch.push(pelvisHeading(qtmp[i]!));
      q.push(qtmp[i]!.clone());
    });
    ch.push(doll.p.aimRootYaw, doll.p.pelvisYawWorld - doll.p.aimRootYaw);   // разбор таза: torso-lead и ВЕСЬ прочий рыск
    rows.push({
      t, ch, q, aim: facing, turning: priv.turning, stable: priv.aimStableFor,
      lat: priv.colPrev.latPlusX, fade: priv.colFade.w, phase: priv.clipPhase, turnClip: doll.p.turnClipName,
      sector: priv.dirWarp.sector, spd: Math.hypot(vel.x, vel.z),
      rate: priv.leadRate, hold: priv.turnAccelHold,
    });
  }
  setLocoMixOverride(null); POSE.hipsTurn = POSE.hipsTurnRun = 0;
  return rows;
}

// ─────────────────────────── меры ───────────────────────────

interface ChStat { d1p99: number; d1max: number; d2p99: number; d2max: number; qp99: number; qmax: number; rev: number }
interface Stat { ch: Record<Chan, ChStat>; turnTog: number; stabRst: number; latFlip: number; xfade: number; phaseRate: number; turnClips: number; sectFlip: number; rateLim: number; spdErr: number; spdD1: number; secs: number; lagP99: number; lagMax: number; stopStep: number }

const pct = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]!;
};

/**
 * Меры по окну ПОСЛЕ прогрева. Всё нормировано НА СЕКУНДУ — иначе 60 / 120 / 144 несравнимы.
 *
 * ⚠ «Дёргается» — это не амплитуда, а СМЕНА ЗНАКА и рывок: у гладкого клипа размах курса груди тот же 80 °/с,
 * что и у дёрганого, а вот `rev` (смен знака в секунду) и `d2` (°/с²) отличаются в разы. Поэтому в отчёте
 * стоят обе колонки, а контролем всегда идёт абляция H (путь редактора).
 */
function stats(rows: Row[], hz: number, warm = 2, stopAt?: number): Stat {
  const dt = 1 / hz, i0 = Math.round(warm * hz);
  const w = rows.slice(i0);
  const ch = {} as Record<Chan, ChStat>;
  CHAN.forEach((n, bi) => {
    const d1: number[] = [], d2: number[] = [], qa: number[] = [];
    for (let i = 1; i < w.length; i++) d1.push(wrapPi(w[i]!.ch[bi]! - w[i - 1]!.ch[bi]!) * DEG / dt);
    for (let i = 1; i < d1.length; i++) d2.push((d1[i]! - d1[i - 1]!) / dt);
    if (bi < TORSO.length) for (let i = 1; i < w.length; i++) qa.push(w[i - 1]!.q[bi]!.angleTo(w[i]!.q[bi]!) * DEG / dt);
    // Смены знака первой разности — только заметные (мёртвая полоса 1 °/с снимает численный шум).
    let rev = 0; let last = 0;
    for (const v of d1) { const s = v > 1 ? 1 : v < -1 ? -1 : 0; if (s && last && s !== last) rev++; if (s) last = s; }
    ch[n] = {
      d1p99: pct(d1.map(Math.abs), 0.99), d1max: Math.max(0, ...d1.map(Math.abs)),
      d2p99: pct(d2.map(Math.abs), 0.99), d2max: Math.max(0, ...d2.map(Math.abs)),
      qp99: pct(qa, 0.99), qmax: qa.length ? Math.max(...qa) : 0, rev: rev / ((w.length - 1) * dt),
    };
  });
  let turnTog = 0, stabRst = 0, latFlip = 0, xfade = 0, turnClips = 0, sectFlip = 0, rateLim = 0;
  const RATE_LIM = 3 * DEG * 0.995;   // turnRate 3 рад/с: кадр «на упоре» — таз ведёт рейт-лимит, а не прицел
  const ri = CHAN.indexOf('rootYaw');
  for (let i = 1; i < w.length; i++) {
    if (w[i]!.turning !== w[i - 1]!.turning) turnTog++;
    if (w[i]!.stable === 0 && w[i - 1]!.stable > 0) stabRst++;
    if (w[i]!.lat !== w[i - 1]!.lat) latFlip++;
    if (w[i]!.fade >= 0.999 && w[i - 1]!.fade < 0.999) xfade++;
    if (w[i]!.turnClip && !w[i - 1]!.turnClip) turnClips++;
    if (w[i]!.sector !== w[i - 1]!.sector) sectFlip++;
    if (Math.abs(wrapPi(w[i]!.ch[ri]! - w[i - 1]!.ch[ri]!)) * DEG / dt >= RATE_LIM) rateLim++;
  }
  const secs = (w.length - 1) * dt;
  const phaseRate = (w[w.length - 1]!.phase - w[0]!.phase) / secs;
  // ⭐ ОТСТАВАНИЕ ТАЗА ОТ ПРИЦЕЛА (°) — цена любого торможения таза. Грудь остаётся на прицеле (это инвариант,
  // его стерегут другие тесты), а вот таз отстаёт, и именно это читается как «персонаж отвечает вяло».
  const lag = w.map((r) => Math.abs(wrapPi(facingToYaw(r.aim) - r.ch[ri]!)) * DEG);
  // Рябь оценки скорости: отклонение от истинной (%) и её производная (ед/с²) — суспект «темп клипа шагает со скоростью».
  const sp = w.map((r) => r.spd), tru = pct(sp, 0.5);
  const spdErr = tru > 1e-6 ? Math.max(...sp.map((v) => Math.abs(v - tru))) / tru * 100 : 0;
  const sd: number[] = [];
  for (let i = 1; i < w.length; i++) sd.push(Math.abs(sp[i]! - sp[i - 1]!) / dt);
  /**
   * ⭐ РЫВОК САМОГО ПРИВОДА ТАЗА (канал `rootYaw`, °/с²) в окне остановки. Мера точечная и НЕ по `Hips`:
   * в мировом курсе таза на остановке живёт ещё и схлопывание доворота (`moving` false → цель 0), оно
   * ограничено своим пределом и к закону привода отношения не имеет. Здесь мерится ровно то, что
   * переключал порог «разгон только на ходу»: приращение скорости доворота за кадр, делённое на кадр.
   * У ограничителя приращения потолок — `turnRate / TURN_ACCEL_SEC` и он НЕ зависит от частоты кадров;
   * у прежнего переключения закона рывок рос вместе с ней.
   */
  let stopStep = 0;
  if (stopAt != null) {
    const hi = CHAN.indexOf('rootYaw');
    for (let i = 2; i < w.length; i++) {
      if (w[i]!.t < stopAt - 0.01 || w[i]!.t > stopAt + 0.06) continue;
      const a = wrapPi(w[i]!.ch[hi]! - w[i - 1]!.ch[hi]!) * DEG / dt, b = wrapPi(w[i - 1]!.ch[hi]! - w[i - 2]!.ch[hi]!) * DEG / dt;
      stopStep = Math.max(stopStep, Math.abs(a - b) / dt);
    }
  }
  return {
    ch, turnTog: turnTog / secs, stabRst: stabRst / secs, latFlip: latFlip / secs, xfade: xfade / secs,
    phaseRate, turnClips, sectFlip, rateLim: rateLim / (w.length - 1), spdErr, spdD1: pct(sd, 0.99), secs,
    lagP99: pct(lag, 0.99), lagMax: Math.max(0, ...lag), stopStep,
  };
}

// ─────────────────────────── сценарии ───────────────────────────

/**
 * ⭐ БЛИЖНИЕ СЦЕНАРИИ ОБЯЗАТЕЛЬНЫ. Скорость поворота прицела на неподвижный курсор — `v·sin θ / r`, и порог
 * «прицел стоит» (0.01 рад ЗА КАДР) пересекается ею только вблизи: при 80 ед/с и 45° это `r` от 39 до 94 ед.
 * Дальний курсор (300 ед) идёт ниже порога на ВСЕХ частотах, и разницы 60 / 144 там не увидеть вовсе.
 */
const SCENES: readonly Scene[] = [
  { name: 'fwd20_r300', spd: 80, r0: 300, bearingDeg: 20 },      // «просто бегу вперёд»: прицел почти по ходу, курсор далеко
  { name: 'fwd20_r80', spd: 80, r0: 80, bearingDeg: 20 },        // то же вблизи — скорость пеленга у порога «прицел стоит»
  { name: 'fwd45_r300', spd: 80, r0: 300, bearingDeg: 45 },
  { name: 'fwd45_r80', spd: 80, r0: 80, bearingDeg: 45 },
  { name: 'back20_r300', spd: 80, r0: 300, bearingDeg: 20, recede: true },
  { name: 'back20_r80', spd: 80, r0: 80, bearingDeg: 20, recede: true },
  { name: 'back45_r300', spd: 80, r0: 300, bearingDeg: 45, recede: true },
  { name: 'back45_r80', spd: 80, r0: 80, bearingDeg: 45, recede: true },
  { name: 'cross_miss25', spd: 80, r0: 300, bearingDeg: 0, missU: 25 },   // проходим рядом: пеленг разворачивается быстро
  { name: 'cross_miss4', spd: 80, r0: 300, bearingDeg: 0, missU: 4 },     // ВНУТРЬ мёртвой зоны (AIM_DEAD 10): её и ловим
  /**
   * ⭐ ПОЧТИ СКВОЗЬ КУРСОР. У мягкой зоны в середине радиуса есть ОСОБАЯ ТОЧКА: примесь прежнего
   * направления длиной `dead − r` ровно гасит вектор на курсор, когда пеленг ему противоположен и
   * `r = dead / 2`. Смесь — ноль, `atan2(0, 0)` = 0 (мировой +X), и прицел щёлкает на пол-оборота.
   * Промах 1 и 0.05 ед проводят ровно через эту точку — на 4 ед она не достигается.
   */
  { name: 'cross_miss1', spd: 80, r0: 300, bearingDeg: 0, missU: 1 },
  { name: 'cross_miss005', spd: 80, r0: 300, bearingDeg: 0, missU: 0.05 },
  /**
   * ⭐ МЫШЬ СОБЫТИЯМИ, СТОЯ. 125 Гц — обычная офисная мышь; кадр на 240 Гц видит либо ноль, либо целое
   * событие. Порог «прицел стоит» обязан мерить РАТУ, а не приращение за кадр, иначе один и тот же
   * медленный увод мыши включает выравнивание таза на одной машине и не включает на другой.
   */
  { name: 'mouse125_w04', spd: 0, r0: 300, bearingDeg: 0, mouseHz: 125, aimW: 0.4 },
  { name: 'mouse125_w02', spd: 0, r0: 300, bearingDeg: 0, mouseHz: 125, aimW: 0.2 },
  /** «Встал и доворачиваюсь к монстру»: бег → стоп за тик, дальше мышь ведёт прицел 2 рад/с. */
  { name: 'stop_face', spd: 80, r0: 300, bearingDeg: 5, stopAt: 5, aimW: 2, stopLag: 0.03 },
  /**
   * ⭐ ОСТАНОВКА ПОСРЕДИ ДОВОРОТА — ровно тот стык, на котором «разгон только на ходу» менял ЗАКОН привода.
   * Проходим в 25 ед от курсора (таз в этот миг доворачивается на упоре) и отпускаем кнопку на 3.78 с.
   */
  { name: 'stop_mid', spd: 80, r0: 300, bearingDeg: 0, missU: 25, stopAt: 3.78, aimW: 0, stopLag: 0 },
  { name: 'stop_mid2', spd: 80, r0: 300, bearingDeg: 0, missU: 25, stopAt: 3.9, aimW: 0, stopLag: 0 },
  /** ПОВОРОТ ТАЗА ручкой (35°): он едет в рыск таза наравне с доворотом и тоже обязан влезать в предел. */
  { name: 'fwd20_turn', spd: 80, r0: 300, bearingDeg: 20, hipsTurnDeg: 35 },
  { name: 'cross_miss25_turn', spd: 80, r0: 300, bearingDeg: 0, missU: 25, hipsTurnDeg: 35 },
];
/**
 * ⭐ ПОЛОСА ПОРОГА «ПРИЦЕЛ СТОИТ». Сближение на `dMin` при 80 ед/с даёт скорость прицела `80 / dMin` рад/с;
 * порог — `0.01 × Гц` (0.6 / 1.2 / 1.44). Отсюда: 400 — ниже полосы на всех частотах (все три должны совпасть),
 * 133 и 90 — В ПОЛОСЕ (60 считает «едет», 120 и 144 — «стоит»), 40 и 20 — выше полосы (снова все совпадают).
 */
const BAND: readonly Scene[] = ([400, 133, 90, 55, 25] as const).map((d) => (
  { name: `band_d${d}`, spd: 80, r0: 0, bearingDeg: 0, dMin: d, tMin: 5 }));
const SPEEDS = [40, 80, 120];
const RATES = [60, 120, 144];
/** Для ВВОДА СОБЫТИЯМИ нужна и частота ВЫШЕ частоты мыши: на 240 Гц кадр видит ровно одно событие или ноль. */
const MRATES = [60, 120, 144, 240];
const ABLS: readonly Abl[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const ABL_NAME: Record<Abl, string> = {
  A: 'база', B: 'точная скорость', C: 'аналит. пеленг без мёртвой зоны', D: 'постоянный прицел',
  E: 'relaxTime = ∞', F: 'сторона страйфа закреплена (нужна правка в worktree)', G: 'locoMix 0 (процедурка)',
  H: 'путь редактора (const vel + yaw)', I: 'база БЕЗ дрожания прихода снапшотов',
  J: 'скорость по ПРИХОДУ, без серверного тика (как было до правки)',
};

const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1).padStart(6) : '   n/a');
const HEAD = [
  'ключ'.padEnd(28), 'Hips d1 p99/ max'.padStart(15), 'Hips d2 p99/ max'.padStart(15),
  'rootd1'.padStart(7), 'warpd1/ max'.padStart(14),
  'Chest d1 p99/ max'.padStart(15), 'Chest d2'.padStart(8), 'UChest d1 p99/max'.padStart(15),
  ' rev/s', ' turn/s', ' stab/s', '  lim%', ' sect', '  lat/s', '   xf/s', ' phase', ' vErr%', ' vD1', ' lag99', ' lagMx', ' stopΔ',
].join(' ');
function line(key: string, s: Stat): string {
  const c = (n: Chan): string => `${f2(s.ch[n].d1p99)}/${f2(s.ch[n].d1max)}`;
  return [
    key.padEnd(28), c('Hips'), `${f2(s.ch.Hips.d2p99)}/${f2(s.ch.Hips.d2max)}`,
    f2(s.ch.rootYaw.d1p99).slice(1), c('warp'), c('Chest'),
    f2(s.ch.Chest.d2p99).padStart(8), c('UpperChest'), f2(s.ch.Chest.rev), f2(s.turnTog), f2(s.stabRst),
    f2(s.rateLim * 100), `${String(s.sectFlip).padStart(4)}`, f2(s.latFlip), f2(s.xfade), f2(s.phaseRate),
    f2(s.spdErr), f2(s.spdD1), f2(s.lagP99), f2(s.lagMax), f2(s.stopStep),
  ].join(' ');
}

// ─────────────────────────── сторожа ───────────────────────────

/**
 * ⭐⭐ СТОРОЖА. Пороги — из ЗАМЕРА после правок §2 (18.09), с запасом ~35 %; рядом в скобках стоит число
 * ДО правки, и каждое из них порог ломает. У каждого сторожа есть мутация, которая возвращает прежнее
 * поведение, — они перечислены в шапке каждого `it` и проверены в worktree.
 *
 * ⚠ ЧЕМ МЕРЯЕМ, А ЧЕМ НЕТ. `d2` (рывок) у кусочно-постоянного входа растёт с частотой кадров ПО ПОСТРОЕНИЮ,
 * поэтому порогов «одинаково на 60 и 144» на НЁМ нет — они стоят на СЧЁТЧИКАХ ЛОГИКИ (`turning`, сбросы
 * «прицел стоит», доля кадров на упоре рейт-лимита): это состояния, и от частоты кадров они зависеть не
 * имеют права вовсе. Рывок стережём абсолютными потолками на каждой частоте.
 */
const MEMO = new Map<string, Stat>();
const st = (sc: Scene, hz: number, abl: Abl = 'A', snapHz = SNAP_HZ): Stat => {
  const key = `${sc.name}|${hz}|${abl}|${snapHz}`;
  let v = MEMO.get(key);
  if (!v) { v = stats(run({ sc, hz, abl, snapHz, jitter: abl !== 'H', secs: sc.dMin ? 12 : 10 }), hz, 2, sc.stopAt); MEMO.set(key, v); }
  return v;
};
const SC = (n: string): Scene => [...SCENES, ...BAND].find((x) => x.name === n)!;

describe('подёргивание корпуса на бегу: сторожа', () => {
  it('⭐⭐ СЧЁТЧИКИ ЛОГИКИ НЕ ЗАВИСЯТ ОТ ЧАСТОТЫ КАДРОВ (порог «прицел стоит» — в секунду, а не на кадр)', () => {
    // ⚠ Мутация «порог на кадр» (`|Δприцел| < 0.01` вместо `AIM_STILL_RATE`) валит это.
    // ЗАМЕР ДО правки: переключений `turning` 5.8 → 22.5 → 27.0 в секунду при 60 / 120 / 144 (4.7×),
    // сбросов «прицел стоит» 0.6 → 0.0 → 0.0. СТАЛО: 3.1 / 2.8 / 3.0 и 0.1 / 0.1 / 0.1.
    for (const nm of ['fwd20_r300', 'band_d133', 'cross_miss25']) {
      const sc = SC(nm), a = RATES.map((hz) => st(sc, hz));
      const rng = (f: (s: Stat) => number): number => {
        const v = a.map(f), lo = Math.min(...v), hi = Math.max(...v);
        return lo > 0.05 ? hi / lo : hi;      // около нуля отношение не имеет смысла — стережём абсолют
      };
      expect(rng((x) => x.turnTog), `${nm}: переключений turning ${a.map((x) => x.turnTog.toFixed(1))}`).toBeLessThan(1.6);
      expect(rng((x) => x.stabRst), `${nm}: сбросов «прицел стоит» ${a.map((x) => x.stabRst.toFixed(1))}`).toBeLessThan(2.2);
      expect(rng((x) => x.rateLim), `${nm}: кадров на упоре рейт-лимита ${a.map((x) => (x.rateLim * 100).toFixed(1))}`).toBeLessThan(1.7);
    }
  }, 180_000);

  it('⭐⭐ СОБЫТИЙНЫЙ ВВОД (мышь 125 Гц, стоим): «прицел стоит» решается ОДИНАКОВО на 60…240 кадрах', () => {
    // ⚠ Мутация «скорость прицела = |Δ| / кадр» (как было до 19.09) валит это: ЗАМЕР при увода прицела
    // 0.4 рад/с — сбросов «прицел стоит» 0.0 / 5.0 / 0.0 / 115.0 в секунду при 60 / 120 / 144 / 240 и
    // отставание таза p99 47.5 / 101.5 / 47.4 / 133.8°, то есть выравнивание таза включалось на одной
    // машине и не включалось на другой. СТАЛО: 0.0 везде и 47.5 / 47.4 / 47.4 / 47.4°.
    for (const nm of ['mouse125_w04', 'mouse125_w02']) {
      const sc = SC(nm), a = MRATES.map((hz) => st(sc, hz));
      expect(Math.max(...a.map((x) => x.stabRst)), `${nm}: сбросов «прицел стоит» ${a.map((x) => x.stabRst.toFixed(1))}`).toBeLessThan(0.5);
      const lag = a.map((x) => x.lagP99);
      expect(Math.max(...lag) / Math.min(...lag), `${nm}: отставание таза ${lag.map((x) => x.toFixed(1))}`).toBeLessThan(1.15);
      const tt = a.map((x) => x.turnTog);
      expect(Math.max(...tt) - Math.min(...tt), `${nm}: переключений turning ${tt.map((x) => x.toFixed(1))}`).toBeLessThan(0.6);
    }
  }, 300_000);

  it('⭐⭐ РЫВОК КОРПУСА НА ПРЯМОМ БЕГУ: потолок на каждой частоте (разгон таза + скорость по тику)', () => {
    // ⚠ Мутации, каждая валит свою строку: «разгон таза выключен» (`TURN_ACCEL_SEC` мимо `stepTorsoLead`)
    // и «скорость по приходу, без серверного тика» (`netInterp.push` без `tick`).
    // ЗАМЕР рывка груди p99 (°/с²) при 60 / 120 / 144 на БОЕВОЙ каденции (сим 30 Гц, рассылка 20), до → после:
    //   бег вперёд 20°  4057 /  6401 /  8279 → 2062 / 1995 / 2158
    //   бег вперёд 45°  4109 /  8280 /  9786 → 2366 / 2357 / 2228
    //   бег спиной 45°  2579 /  2294 /  2207 → 1832 / 1697 / 1906
    // Контроль (путь редактора) — 494 / 499 / 502 на всех частотах.
    const CAP: Record<string, [number, number, number]> = {
      fwd20_r300: [2800, 2800, 2900],
      fwd45_r300: [3200, 3200, 3100],
      back45_r300: [2500, 2500, 2600],
      back20_r300: [2200, 2500, 2200],
    };
    for (const [nm, caps] of Object.entries(CAP)) {
      const sc = SC(nm);
      RATES.forEach((hz, i) => {
        const s = st(sc, hz);
        expect(s.ch.Chest.d2p99, `${nm} @${hz}: рывок груди ${s.ch.Chest.d2p99.toFixed(0)}`).toBeLessThan(caps[i]!);
      });
    }
    // Контроль обязан остаться гладким и одинаковым на всех частотах — иначе сторож меряет не то.
    for (const hz of RATES) {
      const h = st(SC('fwd20_r300'), hz, 'H');
      expect(h.ch.Hips.d1max, 'путь редактора: таз стоит').toBeLessThan(1);
      expect(h.ch.Chest.d2p99, 'путь редактора: рывок груди').toBeLessThan(600);
    }
  }, 180_000);

  it('⭐⭐ КАНАЛ ТАЗА ТОЖЕ СТЕРЕЖЁТСЯ: рывок `Hips` ограничен разгонами и НЕ растёт с частотой кадров', () => {
    // ⚠ ЭТОГО СТОРОЖА НЕ БЫЛО ВОВСЕ, и в дыру провалились сразу две правки: закон торможения таза
    // обрывался защёлкой (`TWIST_SETTLE`), а предел доворота резал ШАГ, а не ускорение. Обе мутации —
    // «интегрировать по `turning`, а не по `rate`» и «`WARP_ACCEL_SEC` мимо `stepDirWarp`» — валят это.
    // ЗАМЕР рывка таза max (°/с²) при 60 / 120 / 144, до → после:
    //   бег вперёд 20°   19 098 / 38 865 / 43 406 → 6 041 / 7 865 / 7 865
    //   бег вперёд 45°   20 865 / 38 865 / 46 065 → 7 865 / 7 865 / 7 865
    //   бег спиной 45°    5 730 / 11 459 / 14 324 → 3 145 / 3 362 / 3 410
    //   мимо курсора     20 357 / 41 019 / 49 390 → 5 000 / 5 000 / 5 940
    // Потолок не с потолка: это СУММА двух документированных пределов ускорения —
    // `turnRate / TURN_ACCEL_SEC` (2865 °/с² на бегу) и `warpRate / WARP_ACCEL_SEC` (5000 °/с²).
    const cap = (GAIT.warpRate / WARP_ACCEL_SEC + 3 * DEG / TURN_ACCEL_SEC) * 1.3;
    for (const nm of ['fwd20_r300', 'fwd45_r300', 'back45_r300', 'back20_r300', 'cross_miss25', 'cross_miss4', 'band_d133']) {
      const sc = SC(nm), v = RATES.map((hz) => st(sc, hz).ch.Hips.d2max);
      for (let i = 0; i < RATES.length; i++) {
        expect(v[i]!, `${nm} @${RATES[i]}: рывок таза ${v[i]!.toFixed(0)} (потолок ${cap.toFixed(0)})`).toBeLessThan(cap);
      }
      expect(Math.max(...v) / Math.min(...v), `${nm}: рост с частотой кадров ${v.map((x) => x.toFixed(0))}`).toBeLessThan(1.6);
    }
  }, 300_000);

  it('⭐ ОСТАНОВКА ПОСРЕДИ ДОВОРОТА: закон привода таза НЕ ПЕРЕКЛЮЧАЕТСЯ (`turnAccelHold`)', () => {
    // ⚠ Мутация «разгон снимается скоростью НОГ» (`spd > MOVE_EPS_WARP` вместо `turnAccelHold`) валит это.
    // Инерции в балансе нет (`moveInertia.enabled` false), скорость падает 80 → 0 ЗА ТИК, и таз посреди
    // доворота перескакивал с разогнанной скорости на полный `turnRate`. ЗАМЕР рывка привода таза (°/с²)
    // при 60 / 120 / 144: 6 876 / 13 751 / 16 501 → 4 775 / 4 775 / 4 775 — ровно `turnRate / TURN_ACCEL_SEC`
    // стоячего профиля, и рост с частотой кадров исчез.
    const cap = 5 / TURN_ACCEL_SEC * DEG * 1.3;   // turnRate стоя (опубликованный воин) / разгон
    for (const nm of ['stop_mid', 'stop_mid2']) {
      const sc = SC(nm);
      for (const abl of ['A', 'G'] as const) {
        const v = RATES.map((hz) => st(sc, hz, abl).stopStep);
        for (let i = 0; i < RATES.length; i++) {
          expect(v[i]!, `${nm}|${abl} @${RATES[i]}: рывок привода ${v[i]!.toFixed(0)}`).toBeLessThan(cap);
        }
        expect(Math.max(...v) / Math.max(1, Math.min(...v)), `${nm}|${abl}: рост с кадрами ${v.map((x) => x.toFixed(0))}`).toBeLessThan(1.2);
      }
    }
  }, 300_000);

  it('⭐ ПРОХОД СКВОЗЬ КУРСОР (мёртвая зона) НЕ ДАЁТ ОДНОКАДРОВОГО СКАЧКА', () => {
    // ⚠ Мутация «жёсткая мёртвая зона» (`r > dead` → прежний угол) валит это: ЗАМЕР на проходе в 4 ед —
    // верх груди 2666 / 5068 / 5922 °/с при 60 / 120 / 144, РОВНО линейно по частоте (подпись скачка за кадр).
    // СТАЛО: 624 / 683 / 654 — и роста нет. Без зоны вовсе было бы 683 / 740 / 749, то есть цена зоны ушла.
    // ⚠ И ПРОМАХ МЕНЬШЕ ДВУХ ЕДИНИЦ — тоже: там у прежней ВЕКТОРНОЙ смеси была особая точка (см.
    // `selfFacing.test.ts`). ЗАМЕР верха груди на промахе 0.05 ед: 3035 / 4111 / 4196 → 1673 / 2318 / 2706.
    const sc = SC('cross_miss4'), v = RATES.map((hz) => st(sc, hz).ch.UpperChest.d1max);
    for (const hz of RATES) {
      const s = st(sc, hz);
      expect(s.ch.UpperChest.d1max, `проход в 4 ед @${hz}: верх груди ${s.ch.UpperChest.d1max.toFixed(0)} °/с`).toBeLessThan(1000);
    }
    expect(Math.max(...v) / Math.min(...v), `рост с частотой кадров: ${v.map((x) => x.toFixed(0))}`).toBeLessThan(1.4);
    for (const [nm, cap] of [['cross_miss1', 2200], ['cross_miss005', 3400]] as const) {
      for (const hz of RATES) {
        const s = st(SC(nm), hz);
        expect(s.ch.UpperChest.d1max, `${nm} @${hz}: верх груди ${s.ch.UpperChest.d1max.toFixed(0)} °/с`).toBeLessThan(cap);
      }
    }
  }, 180_000);

  it('⭐ ХЛЫСТ ДОВОРОТА НА ПЕРЕБРОСЕ СЕКТОРА ОГРАНИЧЕН (`GAIT.warpRate`) — И С ПОВЁРНУТЫМ ТАЗОМ ТОЖЕ', () => {
    // ⚠ Мутация «предела скорости доворота нет» (`rateDeg` 0) валит это: ЗАМЕР — канал доворота p99
    // 400–435 °/с при пике 610–795, то есть вчетверо выше физического потолка torso-lead (172 °/с).
    // ⚠ СТРОКИ `_turn` — ПРО НОВУЮ РУЧКУ. Раньше здесь мерили раскрытие «таз открыт», которое цеплялось за СЕКТОР и
    // на его перебросе прыгало на весь угол (ЗАМЕР до 19.09: 350–369 °/с при потолке 300). Поворот таза за сектор
    // не цепляется вовсе — он едет непрерывной долей страйфа, — и проверяется ровно это: добавь ему сектор, и
    // прыжок вернётся. Сцены выбраны так, чтобы переброс сектора в окне ЗАМЕРА точно был.
    const cap = GAIT.warpRate * 1.02;
    for (const nm of ['fwd20_r300', 'cross_miss25', 'band_d133']) {
      const sc = SC(nm);
      for (const hz of RATES) {
        const s = st(sc, hz);
        expect(s.sectFlip, `${nm} @${hz}: сторож пустой — перебросов сектора не случилось`).toBeGreaterThan(0);
        expect(s.ch.warp.d1max, `${nm} @${hz}: доворот ${s.ch.warp.d1max.toFixed(0)} °/с`).toBeLessThan(cap);
      }
    }
    // ⚠ ПОВОРОТ ТАЗА МЕРЯЕМ НА ПРОЦЕДУРКЕ (G): в «только клипы» (A) ручка инертна по построению — угол там несёт
    // САМ КЛИП, а клипы этого стенда сняты с нулевой ручкой. Клиповый путь стережёт `hipsYaw.test.ts`.
    for (const nm of ['fwd20_turn', 'cross_miss25_turn']) {
      const sc = SC(nm);
      for (const hz of RATES) {
        const s = st(sc, hz, 'G');
        expect(s.sectFlip, `${nm} @${hz}: сторож пустой`).toBeGreaterThan(0);
        expect(s.ch.warp.d1max, `${nm} @${hz}: рыск таза ${s.ch.warp.d1max.toFixed(0)} °/с`).toBeLessThan(cap * 1.03);
      }
    }
  }, 300_000);

  it('⭐⭐ РЯБЬ ОЦЕНКИ СКОРОСТИ — ОТ ЧАСОВ СЕРВЕРА, А НЕ ОТ ПРИХОДА СНАПШОТА', () => {
    // ⚠ Мутация «скорость по интервалу прихода» (`netInterp.push` без `tick`) валит это — она же абляция J.
    // ⚠ И мутация «среднее по коротким интервалам вместо длинной базы» валит СТРОКУ 20 Гц: на БОЕВОЙ
    // каденции (сим 30 Гц, рассылка 20 — Δtick чередуется 2, 1) среднее давало 1.6 %, то есть выше
    // собственного порога прежнего сторожа; на ровных 30 Гц разницы почти не было (0.33 против 0.32),
    // поэтому прежняя каденция стенда её не показывала вовсе.
    // ЗАМЕР ряби (%) при 60 / 120 / 144: рассылка 20 Гц 1.64 / 1.72 / 1.72 → 0.22 / 0.21 / 0.21;
    // рассылка 30 Гц 0.33 / 0.34 / 0.35 → 0.32 / 0.32 / 0.32; по приходу (абляция J) — 12.3 %.
    for (const hz of RATES) {
      const a = st(SC('fwd20_r300'), hz), j = st(SC('fwd20_r300'), hz, 'J');
      const a30 = st(SC('fwd20_r300'), hz, 'A', 30);
      expect(a.spdErr, `рябь скорости (рассылка ${SNAP_HZ} Гц) @${hz}: ${a.spdErr.toFixed(2)} %`).toBeLessThan(0.5);
      expect(a30.spdErr, `рябь скорости (рассылка 30 Гц) @${hz}: ${a30.spdErr.toFixed(2)} %`).toBeLessThan(0.5);
      expect(j.spdErr, `абляция J (по приходу) @${hz} обязана быть хуже: ${j.spdErr.toFixed(1)} %`).toBeGreaterThan(5);
    }
  }, 180_000);

  it('⚠ ЦЕНА ТОРМОЖЕНИЯ ТАЗА: отставание от прицела не выросло сверх замеренного', () => {
    // Грудь и оружие остаются НА ПРИЦЕЛЕ (это отдельный инвариант, его стерегут `clipOnly`/`hipsOpen`),
    // а вот таз отстаёт — и это цена разгона. ЗАМЕР p99 отставания таза (°): бег вперёд 37.5 → 37.9,
    // мимо курсора в 25 ед 42.6 → 43.9, «таз почти догнал» 3.4 → 3.4. Порог — с запасом над этими числами.
    for (const [nm, cap] of [['fwd20_r300', 42], ['cross_miss25', 48], ['back45_r300', 6]] as const) {
      for (const hz of RATES) {
        const s = st(SC(nm), hz);
        expect(s.lagP99, `${nm} @${hz}: таз отстаёт на ${s.lagP99.toFixed(1)}°`).toBeLessThan(cap);
      }
    }
  }, 180_000);
});

describe('подёргивание корпуса на бегу: стенд диагностики', () => {
  it('стенд собирается из настоящих модулей и проходит базовый сценарий на 60/120/144', () => {
    const out: string[] = [];
    for (const hz of RATES) {
      const rows = run({ sc: SCENES[1]!, hz, abl: 'A', jitter: true });
      const s = stats(rows, hz), h = stats(run({ sc: SCENES[1]!, hz, abl: 'H' }), hz);
      out.push(line(`A|${SCENES[1]!.name}|${hz}`, s));
      out.push(line(`H|${SCENES[1]!.name}|${hz}`, h));
      // Санитарные границы: стенд действительно позировал (курс не застыл и не взорвался).
      expect(rows.length, 'кадры').toBeGreaterThan(hz * 9);
      expect(s.ch.Chest.d1max, 'корпус вообще шевелится').toBeGreaterThan(0);
      expect(s.ch.Chest.d1max, 'корпус не улетает').toBeLessThan(5000);
      // Контроль (путь редактора) обязан быть гладким — иначе стенд меряет не то, о чём жалоба.
      expect(h.ch.Hips.d1max, 'у пути редактора таз стоит').toBeLessThan(1);
      expect(h.ch.Chest.rev, 'у пути редактора грудь не рыскает').toBeLessThan(4);
    }
    if (OUT) writeFileSync(`${OUT}_smoke.txt`, [HEAD, ...out].join('\n'), 'utf8');
    else console.log(out.join('\n'));
  }, 180_000);

  it.runIf(process.env.TJ_ROWS)('строки по списку сцен (TJ_ROWS=<сцена>,<сцена>… [|<абляция>])', () => {
    const [names, abl] = (process.env.TJ_ROWS ?? '').split('|');
    const out = [HEAD];
    for (const nm of (names ?? '').split(',')) {
      const sc = [...SCENES, ...BAND].find((x) => x.name === nm);
      if (!sc) continue;
      for (const hz of (sc.mouseHz ? MRATES : RATES)) out.push(line(`${nm}|${hz}`, st(sc, hz, (abl as Abl) || 'A')));
    }
    console.log(out.join('\n'));
    expect(out.length).toBeGreaterThan(1);
  }, 600_000);

  it.runIf(process.env.TJ_DUMP)('покадровый дамп одного сценария (TJ_DUMP=<сцена>|<Гц>|<абляция>)', () => {
    const [nm, hzs, abl] = (process.env.TJ_DUMP ?? '').split('|');
    const sc = [...SCENES, ...BAND].find((s) => s.name === nm) ?? SCENES[1]!;
    const hz = Number(hzs) || 60;
    const rows = run({ sc, hz, abl: (abl as Abl) ?? 'A', jitter: true, secs: sc.dMin ? 12 : 10 });
    const dt = 1 / hz;
    const csv = ['t,aim,turning,stable,lat,fade,phase,rate,hold,clip,' + CHAN.map((n) => `${n},d${n}`).join(',')];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!, p = rows[i - 1]!;
      csv.push([r.t.toFixed(5), (r.aim * DEG).toFixed(4), r.turning ? 1 : 0,
        r.stable.toFixed(4), r.lat ? 1 : 0, r.fade.toFixed(3), r.phase.toFixed(4),
        r.rate.toFixed(4), r.hold ? 1 : 0, r.turnClip ?? '-',
        ...CHAN.map((_, b) => `${(r.ch[b]! * DEG).toFixed(4)},${(wrapPi(r.ch[b]! - p.ch[b]!) * DEG / dt).toFixed(3)}`)].join(','));
    }
    const f = `${OUT || 'tj'}_dump_${sc.name}_${hz}_${abl ?? 'A'}.csv`;
    writeFileSync(f, csv.join('\n'), 'utf8');
    console.log(`dump → ${f} (${csv.length - 1} кадров)`);
    expect(csv.length).toBeGreaterThan(10);
  }, 180_000);

  it.runIf(FULL)('ПОЛНАЯ МАТРИЦА: сценарии × скорости × частоты + абляции', () => {
    const lines: string[] = [], json: Record<string, unknown> = {};
    lines.push(`# СЦЕНАРИИ (абляция A = база, сим ${SIM_HZ} Гц, рассылка ${SNAP_HZ} Гц — боевая, дрожание прихода ±5 мс)`);
    lines.push('# d1 — первая разность мирового курса, °/с; d2 — вторая, °/с²; rev/s — смен знака d1 в секунду');
    lines.push('# root = torso-lead (рейт-лимит turnRate 172 °/с), warp = ВЕСЬ прочий рыск таза (pelvisYawWorld − aimRootYaw)');
    lines.push(HEAD);
    for (const sc of SCENES) for (const spd of SPEEDS) for (const hz of (sc.mouseHz ? MRATES : RATES)) {
      if (sc.mouseHz && spd !== SPEEDS[0]) continue;   // мышь стоя: скорость не при чём, одна строка
      const s = stats(run({ sc: { ...sc, spd: sc.mouseHz ? 0 : spd }, hz, abl: 'A', jitter: true }), hz, 2, sc.stopAt);
      const key = `${sc.name}|v${sc.mouseHz ? 0 : spd}|${hz}`;
      lines.push(line(key, s)); json[key] = s;
    }
    lines.push('');
    lines.push('# ПОВОРОТ ТАЗА РУЧКОЙ (POSE.hipsTurn 35°) — на процедурке (G; в «только клипы» его несёт сам клип)');
    lines.push(HEAD);
    for (const nm of ['fwd20_turn', 'cross_miss25_turn']) for (const abl of ['G'] as const) for (const hz of RATES) {
      const sc = [...SCENES].find((x) => x.name === nm)!;
      const s = stats(run({ sc, hz, abl, jitter: true }), hz, 2, sc.stopAt);
      const key = `${abl}|${nm}|${hz}`;
      lines.push(line(key, s)); json[key] = s;
    }
    lines.push('');
    lines.push('# ТА ЖЕ БАЗА НА СТАРОЙ КАДЕНЦИИ СТЕНДА (30 снапшотов в секунду, Δtick всегда 1) — для сверки с ЗАМЕРОМ 18.09');
    lines.push(HEAD);
    for (const sc of SCENES) for (const hz of RATES) {
      if (sc.mouseHz) continue;
      const s = stats(run({ sc, hz, abl: 'A', jitter: true, snapHz: 30 }), hz, 2, sc.stopAt);
      const key = `snap30|${sc.name}|${hz}`;
      lines.push(line(key, s)); json[key] = s;
    }
    lines.push('');
    lines.push('# ПОЛОСА ПОРОГА «ПРИЦЕЛ СТОИТ» (0.01 рад НА КАДР = 0.6 / 1.2 / 1.44 рад/с при 60 / 120 / 144)');
    lines.push('# скорость прицела в точке сближения = 80/dMin рад/с; A = игра, H = путь редактора');
    lines.push(HEAD);
    for (const sc of BAND) for (const abl of ['A', 'H'] as const) for (const hz of RATES) {
      const s = stats(run({ sc, hz, abl, jitter: true, secs: 12 }), hz);
      const key = `${abl}|${sc.name}|${hz}`;
      lines.push(line(key, s)); json[key] = s;
    }
    lines.push('');
    lines.push('# АБЛЯЦИИ (по одному идеализированному входу за раз; дрожание ±5 мс)');
    lines.push(HEAD);
    for (const abl of ABLS) {
      lines.push(`# ${abl} — ${ABL_NAME[abl]}`);
      if (abl === 'F') { lines.push('#   (нужна правка исходника — идёт отдельным прогоном в worktree)'); continue; }
      for (const sc of [...SCENES, ...BAND]) for (const hz of RATES) {
        const s = stats(run({ sc, hz, abl: abl === 'I' ? 'A' : abl, jitter: abl !== 'I', secs: sc.dMin ? 12 : 10 }), hz, 2, sc.stopAt);
        const key = `${abl}|${sc.name}|${hz}`;
        lines.push(line(key, s)); json[key] = s;
      }
      lines.push('');
    }
    const txt = lines.join('\n');
    if (OUT) { writeFileSync(`${OUT}.txt`, txt, 'utf8'); writeFileSync(`${OUT}.json`, JSON.stringify(json), 'utf8'); }
    else console.log(txt);
    expect(Object.keys(json).length).toBeGreaterThan(0);
  }, 3_600_000);
});
