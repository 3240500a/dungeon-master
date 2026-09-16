/**
 * МОДЕЛЬ КЛИПА — ОДНА КОПИЯ на редактор и игру (Ф1.1).
 *
 * До этого файла `Pose`/`Keyframe`/`Clip`, `blendTwo`, `clipPoseAt`, `clipDur` жили ДВАЖДЫ:
 * в `poseRuntime.ts` (игра) и в `pose-editor.ts` (редактор), и классификатор «угол или скаляр»
 * в `blendTwo` уже начал расходиться текстуально. Любая новая фича интерполяции писалась бы дважды.
 *
 * Файл ЧИСТЫЙ: только `THREE.Quaternion/Euler` (математика), без сцены, DOM и загрузчиков —
 * поэтому целиком тестируется в node-vitest.
 */
import * as THREE from 'three';

// ── Типы ──────────────────────────────────────────────────────────────────────────────────────────
export type Pose = Record<string, [number, number, number]>;

/** Форма кривой на ИСХОДЯЩЕМ интервале ключа (как в Blender/Cascadeur: ключ задаёт переход К СЛЕДУЮЩЕМУ).
 *  `linear` — как было всегда (дефолт, старые клипы без поля читаются именно так);
 *  `ease` — безье-ремап фазы ручками `ease` (дефолт EASE_INOUT);
 *  `step` — держать позу ключа до следующего (stepped-блокинг);
 *  `fixed` — интервал считается уже записанным покадрово, доп. сглаживания нет (== linear);
 *  `smooth` — СПЛАЙН через ключи: скорость на ключе непрерывна, форму задают соседи (`splinePose`). */
export type Interp = 'linear' | 'ease' | 'step' | 'fixed' | 'smooth';

// ── Метки на кадрах (модель Unreal Notify / Notify State) ────────────────────────────────────────
/**
 * Тип метки. `dur` НЕ задан → точечное событие (Notify); `dur` задан → отрезок с началом и концом
 * (Notify State). Дорожку НЕ храним — она выводится из типа (`MARK_TRACK`): одна метка бьёт сразу в
 * несколько дорожек, и поле `track` заставило бы дублировать метку на каждую.
 *
 * `impact` несёт СВОИ звук и эффект полями, а не тремя метками на одном кадре; `swing` — один взмах,
 * то есть свист клинка и след меча на общем отрезке. Окна урона и неуязвимости не нужны: урон у нас
 * серверный и падает ровно на `impact`, неуязвимости в игре нет.
 */
export type MarkType =
  | 'impact'      // кадр удара: на него садится windupMs сервера + звук/искра
  | 'sfx'         // прочий звук
  | 'vfx'         // прочий эффект
  | 'footstep'    // шаг (материал поверхности знает мир, не клип)
  | 'camshake'    // тряска камеры, сила в `num`
  | 'swing'       // ОТРЕЗОК: свист клинка + след меча
  | 'combo'       // ОТРЕЗОК: окно ветвления цепочки ударов
  | 'windup'      // начало замаха (секция для цепочки)
  | 'recover'     // конец отработки (секция для цепочки)
  // ── СЕКЦИИ ЛОКОМОЦИИ (Ф5б): старт, цикл и остановка ОДНИМ клипом ──
  // Та же модель, что у ударов (и что у Montage Sections в Unreal): разметка ВНУТРИ клипа, а не
  // резка на файлы. Шов авторится один раз и не зависит от длительности кроссфейда, библиотека
  // втрое короче, а старт и остановка гарантированно совпадают по фазе ноги с циклом — при
  // отдельных клипах это приходится ловить кроссфейдом заново на каждой паре.
  | 'loop_start'  // здесь кончается разгон и начинается цикл
  | 'loop_end';   // здесь цикл кончается и начинается остановка
export type MarkTrack = 'gameplay' | 'audio' | 'vfx' | 'camera';
export interface Mark {
  type: MarkType;
  /** id звука из конфига (клип говорит ЧТО и КОГДА, обработчик решает КАК). */
  sfx?: string;
  /** id эффекта из конфига. */
  vfx?: string;
  foot?: 'L' | 'R';
  /** Число-параметр: сила тряски камеры. */
  num?: number;
  /** Длительность (сек) → метка становится отрезком. Варпится вместе с ключами при тайм-варпе удара. */
  dur?: number;
}
/** Дорожка типа — только для отрисовки в таймлайне (`impact` рисуем на геймплейной, значки звука/эффекта рядом). */
export const MARK_TRACK: Readonly<Record<MarkType, MarkTrack>> = {
  impact: 'gameplay', combo: 'gameplay', windup: 'gameplay', recover: 'gameplay',
  loop_start: 'gameplay', loop_end: 'gameplay',
  sfx: 'audio', footstep: 'audio', swing: 'audio', vfx: 'vfx', camshake: 'camera',
};
/** Типы, которые ОБЯЗАНЫ быть отрезком (у них `dur` есть всегда). */
export const RANGE_MARKS: ReadonlySet<MarkType> = new Set<MarkType>(['swing', 'combo']);
export const isRangeMark = (m: Mark): boolean => m.dur !== undefined && m.dur > 0;

export interface Keyframe {
  pose: Pose;
  t: number;                    // сек от начала клипа (кадры отсортированы по t)
  interp?: Interp;              // нет → 'linear'
  ease?: [number, number, number, number];   // ручки безье (x1,y1,x2,y2), только для interp='ease'
  /** Метки событий. Живут НА КЛЮЧЕ, а не на клипе: `migrateClip` пересобирает клип по явному списку
   *  полей и молча выбросил бы новое поле уровня клипа, а ключи проходят по ссылке; плюс метка сама
   *  едет за ключом при ретайминге и переживает прореживание. */
  marks?: Mark[];
}
export interface Clip {
  name: string; character: string; weapon: string; loop: boolean; keys: Keyframe[];
  /** Первый/последний кадр = idle-стойка (заблокированы в редакторе, синкаются из стойки — как у `hit_`). */
  idleEnds?: boolean;
  /**
   * ⭐ К КАКОЙ БАЗЕ ПРИВЯЗАНЫ КОНЦЫ (`idle` | `combat` | `clip:<имя>`). Панель импорта даёт выбрать
   * базовую позу, но синк концов её НЕ ЗНАЛ и всегда брал обычную стойку — поэтому «выбрал боевую,
   * сохранилось с небоевой». Нет отметки (старые клипы, удары) — прежнее поведение.
   */
  idleEndsFrom?: string;
  /**
   * КОРЕНЬ (Ф2): клип НЕСЁТ поворот / смещение персонажа в каналах `__rootY` / `__rootP`.
   *
   * ⚠ Это ДАННЫЕ, а не привод. Позицию и фейсинг задаёт сервер, и в игре каналы корня не читает
   * никто — сторож проверяет это проигрыванием. Нужны они трём потребителям: анализатору походки
   * (длина шага и угол поворота берутся отсюда), экспорту в чужой движок (там это root motion) и
   * предпросмотру в редакторе, где персонажа можно катить по полу.
   */
  rootYaw?: boolean;
  rootPos?: boolean;
}

export const DEF_GAP = 0.3;     // дефолт-шаг между кадрами (сек) при миграции старого формата

export const clipDur = (c: Clip): number => (c.keys.length ? c.keys[c.keys.length - 1]!.t : 0);

// ── Спец-ключи позы (не кости) ────────────────────────────────────────────────────────────────────
export const WPN_KEYS = ['__wpnMain', '__wpnOff'];             // поворот оружия
export const WPN_POS = ['__wpnMainP', '__wpnOffP'];            // позиция оружия
/** Офсет таза. `__hipsP` — ЛЕГАСИ: абсолютная локальная позиция таза в юнитах рига, а значит ЗАВИСИТ ОТ ТЕЛА
 *  (32.4 у среднего — присед, у высокого с rest 34.5 — цыпочки). `__hipsD` — ДЕЛЬТА от rest-высоты таза,
 *  она переносима: один клип ложится на любое телосложение. Читать ВСЕГДА через `hipsOffset` — он приводит
 *  оба вида к дельте, поэтому клип со смешанными кадрами (часть перезаписана) не даёт скачка. */
export const HIPS_ABS = '__hipsP';
export const HIPS_DEL = '__hipsD';
/**
 * КОРЕНЬ: поворот и смещение САМОГО ПЕРСОНАЖА относительно первого кадра (Ф2).
 *
 * `__rootY` — накопленный рыск, `[рад, 0, 0]`. Накопленный, а не свёрнутый в ±π: разворот на 180°+
 * должен читаться как один непрерывный поворот, иначе анализатор увидит на месте разворота скачок.
 * Поэтому он интерполируется ЛИНЕЙНО и НЕ входит в `ANGLE_SPECIALS` — slerp свернул бы его обратно.
 * `__rootP` — смещение по полу, `[x, 0, z]` в юнитах рига.
 */
export const ROOT_YAW = '__rootY';
export const ROOT_POS = '__rootP';

/** Корень кадра: `[yaw, x, z]`. Нет каналов — `null` (клип in-place, как и был до Ф2). */
export function rootMotion(p: Pose): [number, number, number] | null {
  const y = p[ROOT_YAW], q = p[ROOT_POS];
  if (!y && !q) return null;
  return [y ? y[0] : 0, q ? q[0] : 0, q ? q[2] : 0];
}
/** Записать корень кадра. Нулевые каналы всё равно пишем: «канал есть и он ноль» — тоже сведение. */
export function setRootMotion(p: Pose, yaw: number, x: number, z: number): void {
  p[ROOT_YAW] = [yaw, 0, 0];
  p[ROOT_POS] = [x, 0, z];
}
/** Rest-высота таза базового профиля (`humanoid.BONES`: Hips.pos = [0,32,0]) — фолбэк, когда профиля нет. */
export const HIPS_REST_Y = 32;

/** Офсет таза кадра как ДЕЛЬТА от rest. `null` — кадр таз не трогает. */
export function hipsOffset(p: Pose, restY = HIPS_REST_Y): [number, number, number] | null {
  const d = p[HIPS_DEL];
  if (d) return [d[0], d[1], d[2]];
  const a = p[HIPS_ABS];
  return a ? [a[0], a[1] - restY, a[2]] : null;   // легаси-абсолют → та же дельта
}
/** Записать офсет таза (всегда в новом виде; легаси-ключ с этого кадра уходит). */
export function setHipsOffset(p: Pose, d: readonly [number, number, number]): void {
  p[HIPS_DEL] = [d[0], d[1], d[2]];
  delete p[HIPS_ABS];
}
/** Привести кадр к дельта-виду. Возвращает true, если что-то поменялось (чтобы знать, надо ли сохранять). */
export function normalizePoseHips(p: Pose, restY: number): boolean {
  const a = p[HIPS_ABS]; if (!a) return false;
  if (!p[HIPS_DEL]) p[HIPS_DEL] = [a[0], a[1] - restY, a[2]];
  delete p[HIPS_ABS];
  return true;
}
/** То же на весь клип — зовётся, когда rest-высота КОНКРЕТНОГО персонажа уже известна. */
export function normalizeClipHips(c: Clip, restY: number): boolean {
  let ch = false;
  for (const k of c.keys) if (normalizePoseHips(k.pose, restY)) ch = true;
  return ch;
}

/** Ключи с `__`-префиксом, значение которых — ЭЙЛЕР (их надо slerp'ить, а не лерпить покомпонентно). */
const ANGLE_SPECIALS = new Set([...WPN_KEYS, '__lgripR']);
/** Ключ позы хранит поворот? Кости (без `_`-префикса) — да; из спец-ключей — только перечисленные.
 *  Позиции (`…P`, `__hipsP`) и скаляры (`__match`, `__pinKp` = до 12000!) — линейно. */
export const isAngleKey = (k: string): boolean => k[0] !== '_' || ANGLE_SPECIALS.has(k);

// ── Углы ──────────────────────────────────────────────────────────────────────────────────────────
const TAU = Math.PI * 2;
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Кратчайшая разница углов (рад) в (−π, π]. */
export const shortDelta = (from: number, to: number): number => { let d = (to - from) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
export const lerpAng = (from: number, to: number, t: number): number => from + shortDelta(from, to) * t;

const _sqA = new THREE.Quaternion(), _sqB = new THREE.Quaternion(), _seA = new THREE.Euler(), _seB = new THREE.Euler();
/** Slerp двух эйлер-троек в `out`. Кватернионный путь — истинная кратчайшая дуга, без gimbal-прокрутки:
 *  линейный лерп эйлеров (даже с обёрткой углов) на многоосевых кадрах проворачивал руку на ~360°. */
export function slerpEuler(out: THREE.Quaternion, pa: readonly number[], pb: readonly number[], t: number): THREE.Quaternion {
  _sqA.setFromEuler(_seA.set(pa[0] ?? 0, pa[1] ?? 0, pa[2] ?? 0));
  _sqB.setFromEuler(_seB.set(pb[0] ?? 0, pb[1] ?? 0, pb[2] ?? 0));
  return out.copy(_sqA).slerp(_sqB, t);
}

// ── Кривые: ремап фазы интервала ──────────────────────────────────────────────────────────────────
export const EASE_INOUT: [number, number, number, number] = [0.42, 0, 0.58, 1];   // как CSS ease-in-out
export const EASE_IN: [number, number, number, number] = [0.42, 0, 1, 1];
export const EASE_OUT: [number, number, number, number] = [0, 0, 0.58, 1];

const bez1 = (p1: number, p2: number, t: number): number => {   // кубическая безье с P0=0, P3=1
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
};
/** cubic-bezier(x1,y1,x2,y2): решаем x(s)=u ньютоном (с бисекцией-фолбэком), возвращаем y(s). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let s = u;
  for (let i = 0; i < 8; i++) {                                 // Ньютон: быстрая сходимость на «приличных» ручках
    const x = bez1(x1, x2, s) - u;
    if (Math.abs(x) < 1e-6) return bez1(y1, y2, s);
    const mt = 1 - s;
    const dx = 3 * mt * mt * x1 + 6 * mt * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (Math.abs(dx) < 1e-9) break;
    s -= x / dx;
    if (s < 0 || s > 1) break;
  }
  let lo = 0, hi = 1; s = u;                                    // бисекция: работает на любых (в т.ч. вырожденных) ручках
  for (let i = 0; i < 24; i++) { const x = bez1(x1, x2, s); if (Math.abs(x - u) < 1e-6) break; if (x < u) lo = s; else hi = s; s = (lo + hi) / 2; }
  return bez1(y1, y2, s);
}

/** Ремап линейной фазы интервала `u` (0..1) по кривой ИСХОДЯЩЕГО ключа `k`.
 *  Ключ без `interp` == 'linear' → `u` возвращается как есть, поэтому старые клипы ведут себя ровно как раньше. */
export function easeU(k: Keyframe | undefined, u: number): number {
  const m = k?.interp;
  if (!m || m === 'linear' || m === 'fixed' || m === 'smooth') return u;   // у сплайна фаза своя, ремапа нет
  if (m === 'step') return u >= 1 ? 1 : 0;                      // держим позу ключа ДО следующего; ровно на нём — переключаемся
  const e = k?.ease ?? EASE_INOUT;
  return cubicBezier(e[0], e[1], e[2], e[3], u);
}

// ── Бленд поз ─────────────────────────────────────────────────────────────────────────────────────
const _btQ = new THREE.Quaternion(), _btE = new THREE.Euler();
/** Σ поз по ключам (union), лерп; повороты — slerp'ом. */
export function blendTwo(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const pa = a[k] ?? [0, 0, 0], pb = b[k] ?? [0, 0, 0];
    if (isAngleKey(k)) { slerpEuler(_btQ, pa, pb, t); _btE.setFromQuaternion(_btQ); out[k] = [_btE.x, _btE.y, _btE.z]; }
    else out[k] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
  }
  return out;
}

export interface ClipSegment { a: Keyframe; b: Keyframe; u: number; i: number }
/** Интервал клипа на времени `time` (сек) + УЖЕ отремапленная кривой фаза `u`.
 *  Единая точка для всех проигрывателей: и `clipPoseAt` (чистый), и редакторский `lerpPose` (мутирует манекен). */
export function clipSegmentAt(c: Clip, time: number): ClipSegment | null {
  const ks = c.keys; if (!ks.length) return null;
  if (ks.length < 2) { const k = ks[0]!; return { a: k, b: k, u: 0, i: 0 }; }
  const t = Math.max(0, Math.min(clipDur(c), time));
  let i = 0; while (i < ks.length - 2 && ks[i + 1]!.t <= t) i++;
  const a = ks[i]!, b = ks[i + 1]!, span = b.t - a.t;
  return { a, b, u: easeU(a, span > 1e-6 ? clamp01((t - a.t) / span) : 0), i };
}

/** Поза клипа на НОРМАЛИЗОВАННОЙ фазе 0..1. */
export function clipPoseAt(c: Clip, t01: number): Pose {
  const seg = clipSegmentAt(c, clamp01(t01) * (clipDur(c) || 1));
  return seg ? segmentPose(c, seg) : {};
}

/** Поза интервала: линейно (с ремапом кривой ключа) или сплайном. ОДНА точка для игры, редактора и экспорта. */
export function segmentPose(c: Clip, seg: ClipSegment): Pose {
  if (seg.a === seg.b) return seg.a.pose;
  return seg.a.interp === 'smooth' ? splinePose(c, seg.i, seg.u) : blendTwo(seg.a.pose, seg.b.pose, seg.u);
}

// ── Сплайн между ключами ──────────────────────────────────────────────────────────────────────────
/**
 * Позиционные каналы движения: у сплайна они гладкие, у меры ошибки идут через `POS_DEG_PER_UNIT`.
 * Прочие скаляры (`__match`, `__pinKp` до 12000, флаги опоры `__swing`) — линейно: сглаживать веса и флаги
 * нельзя, кубика перелетает за 0 и 1.
 */
export const MOTION_POS_KEYS: ReadonlySet<string> = new Set([HIPS_DEL, HIPS_ABS, ...WPN_POS, '__lgripP', ROOT_POS, ROOT_YAW]);
/**
 * Позиционные каналы в МЕРЕ ОШИБКИ прореживания и подгонки. Корня здесь нет: `__rootY` — радианы, и мерить его
 * «юнитами смещения» было бы бессмыслицей.
 * ⚙ ГРАБЛЯ (из `clipBaker`): раньше мера гнала ЛЮБУЮ тройку через `setFromEuler().angleTo()`, и офсет таза
 * [0,−1.5,0] читался бы как ~86° ошибки на каждом кадре — прореживание перестало бы прореживать.
 */
export const ERROR_POS_KEYS: ReadonlySet<string> = new Set([HIPS_DEL, HIPS_ABS, ...WPN_POS, '__lgripP']);
/** 1 юнит смещения ≈ 5° поворота. При пороге 3° это «боб таза от 0.6 юнита сохраняется» (рост таза 32 юнита). */
export const POS_DEG_PER_UNIT = 5;

/** Соседний ключ для касательной. В цикле — через шов (последний ключ цикла повторяет первый), иначе край клипа. */
function splineIndex(c: Clip, j: number): number {
  const n = c.keys.length;
  if (j >= 0 && j < n) return j;
  if (c.loop && n > 2) return j < 0 ? n - 1 + j : j - (n - 1);
  return j < 0 ? 0 : n - 1;
}
function splineTime(c: Clip, j: number): number {
  const n = c.keys.length;
  if (j >= 0 && j < n) return c.keys[j]!.t;
  if (c.loop && n > 2) return j < 0 ? c.keys[n - 1 + j]!.t - clipDur(c) : c.keys[j - (n - 1)]!.t + clipDur(c);
  return c.keys[j < 0 ? 0 : n - 1]!.t;
}
/** Касательная на ключе по трём точкам с НЕРАВНЫМ шагом (взвешенное среднее наклонов); на краю — односторонняя. */
const tangent = (a: number, b: number, c: number, d1: number, d2: number): number =>
  d1 <= 1e-9 ? (d2 <= 1e-9 ? 0 : (c - b) / d2) : d2 <= 1e-9 ? (b - a) / d1 : (((b - a) / d1) * d2 + ((c - b) / d2) * d1) / (d1 + d2);
const _sp0 = new THREE.Quaternion(), _sp1 = new THREE.Quaternion(), _sp2 = new THREE.Quaternion(), _sp3 = new THREE.Quaternion();
const _spE = new THREE.Euler();
const ZERO3: readonly [number, number, number] = [0, 0, 0];

/**
 * ⭐ СПЛАЙН НА ИНТЕРВАЛЕ `i` (ключ `i` → `i+1`) при фазе `u`: кубический Эрмит, касательные из соседних ключей
 * (Катмулл–Ром с неравным шагом). Кривая проходит ЧЕРЕЗ ключи, и скорость на ключе непрерывна — поэтому на
 * тех же ключах движение плавное, а ключей нужно в разы меньше, чем для ломаной.
 *
 * Повороты — ПО КОМПОНЕНТАМ КВАТЕРНИОНА в одном полушарии и с нормировкой. Так считает Unity в режиме
 * «Quaternion» и glTF `CUBICSPLINE`; кратчайшая дуга сохраняется, пока соседние ключи ближе 180°.
 * Позиции (`MOTION_POS_KEYS`) — по компонентам, прочие скаляры — линейно. Цикл: соседи — через шов.
 */
export function splinePose(c: Clip, i: number, u: number): Pose {
  const ks = c.keys;
  const k0 = ks[splineIndex(c, i - 1)]!, k1 = ks[i]!, k2 = ks[i + 1]!, k3 = ks[splineIndex(c, i + 2)]!;
  const d0 = k1.t - splineTime(c, i - 1), h = k2.t - k1.t, d2 = splineTime(c, i + 2) - k2.t;
  const s2 = u * u, s3 = s2 * u;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + u) * h, h01 = -2 * s3 + 3 * s2, h11 = (s3 - s2) * h;
  const out: Pose = {};
  for (const key of new Set([...Object.keys(k1.pose), ...Object.keys(k2.pose)])) {
    const p1 = k1.pose[key] ?? ZERO3, p2 = k2.pose[key] ?? ZERO3;          // union — как у `blendTwo`
    const p0 = k0.pose[key] ?? p1, p3 = k3.pose[key] ?? p2;
    if (isAngleKey(key)) {
      _sp1.setFromEuler(_spE.set(p1[0], p1[1], p1[2]));
      _sp2.setFromEuler(_spE.set(p2[0], p2[1], p2[2])); if (_sp2.dot(_sp1) < 0) _sp2.set(-_sp2.x, -_sp2.y, -_sp2.z, -_sp2.w);
      _sp0.setFromEuler(_spE.set(p0[0], p0[1], p0[2])); if (_sp0.dot(_sp1) < 0) _sp0.set(-_sp0.x, -_sp0.y, -_sp0.z, -_sp0.w);
      _sp3.setFromEuler(_spE.set(p3[0], p3[1], p3[2])); if (_sp3.dot(_sp2) < 0) _sp3.set(-_sp3.x, -_sp3.y, -_sp3.z, -_sp3.w);
      const cmp = (a: number, b: number, cc: number, d: number): number =>
        h00 * b + h10 * tangent(a, b, cc, d0, h) + h01 * cc + h11 * tangent(b, cc, d, h, d2);
      _sp0.set(cmp(_sp0.x, _sp1.x, _sp2.x, _sp3.x), cmp(_sp0.y, _sp1.y, _sp2.y, _sp3.y), cmp(_sp0.z, _sp1.z, _sp2.z, _sp3.z), cmp(_sp0.w, _sp1.w, _sp2.w, _sp3.w)).normalize();
      _spE.setFromQuaternion(_sp0);
      out[key] = [_spE.x, _spE.y, _spE.z];
    } else if (MOTION_POS_KEYS.has(key)) {
      const v = (j: number): number => h00 * p1[j]! + h10 * tangent(p0[j]!, p1[j]!, p2[j]!, d0, h) + h01 * p2[j]! + h11 * tangent(p1[j]!, p2[j]!, p3[j]!, h, d2);
      out[key] = [v(0), v(1), v(2)];
    } else out[key] = [p1[0] + (p2[0] - p1[0]) * u, p1[1] + (p2[1] - p1[1]) * u, p1[2] + (p2[2] - p1[2]) * u];
  }
  return out;
}

/**
 * Ошибка позы `got` против эталона `ref`, в градусах: повороты — угол между кватернионами, позиции движения —
 * через `POS_DEG_PER_UNIT`; прочие скаляры в меру не входят (плотность ключей задаёт движение, а не настройки).
 * `bones` — фильтр каналов.
 */
export function poseErrorDeg(ref: Pose, got: Pose, bones?: (key: string) => boolean): number {
  let worst = 0;
  for (const key in ref) {
    if (bones && !bones(key)) continue;
    const a = ref[key]!, b = got[key]; if (!b) continue;
    let e: number;
    if (isAngleKey(key)) {
      _sp1.setFromEuler(_spE.set(a[0], a[1], a[2])); _sp2.setFromEuler(_spE.set(b[0], b[1], b[2]));
      e = _sp1.angleTo(_sp2) * 180 / Math.PI;
    } else if (ERROR_POS_KEYS.has(key)) e = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) * POS_DEG_PER_UNIT;
    else continue;
    if (e > worst) worst = e;
  }
  return worst;
}

/**
 * Секции клипа локомоции (Ф5б). Границы в секундах.
 *
 * НЕТ МЕТОК — ВЕСЬ КЛИП ЦИКЛ, ровно как было до Ф5б. Это не «деградация», а основной случай:
 * у обычного зацикленного `run_fwd` разгона и остановки нет, и заставлять их размечать было бы
 * издевательством.
 */
export interface ClipSections {
  /** Конец разгона = начало цикла. 0 — разгона нет. */
  loopStart: number;
  /** Конец цикла = начало остановки. = длительность, если остановки нет. */
  loopEnd: number;
  /** Есть ли вообще что играть на разгоне / остановке. */
  hasStart: boolean;
  hasStop: boolean;
}
export function clipSections(c: Clip): ClipSections {
  const dur = clipDur(c);
  const a = markSec(c, 'loop_start'), b = markSec(c, 'loop_end');
  const loopStart = a ?? 0;
  const loopEnd = b ?? dur;
  return {
    loopStart, loopEnd: Math.max(loopStart, loopEnd),
    hasStart: a !== null && a > 1e-4,
    hasStop: b !== null && b < dur - 1e-4,
  };
}

// ── Метки: чтение ────────────────────────────────────────────────────────────────────────────────
/** Время метки `impact` (сек от начала клипа) или null, если удар не размечен. Первая по времени. */
export function impactSec(c: Clip): number | null {
  for (const k of c.keys) if (k.marks?.some((m) => m.type === 'impact')) return k.t;
  return null;
}
/** Первый ключ с меткой такого типа (сек) или null. */
export function markSec(c: Clip, type: MarkType): number | null {
  for (const k of c.keys) if (k.marks?.some((m) => m.type === type)) return k.t;
  return null;
}
/**
 * ⭐⭐ ОКНО КОМБО — ОТРЕЗОК, ВНУТРИ КОТОРОГО УДАР МОЖЕТ ПЕРЕЙТИ В СЛЕДУЮЩИЙ.
 *
 * До этого метку `combo` не читал НИКТО — ни клиент, ни сервер (проверено поиском): разметка была,
 * поведения не было. Теперь это граница, в которой живёт зажатая атака: конец окна не отпускает в
 * стойку, а начинает следующий удар цепочки.
 *
 * Берём ПЕРВУЮ метку: два окна комбо в одном клипе — это авторская ошибка, и гадать за автора,
 * какое из них главное, нельзя. Точечная (без `dur`) метка окном не является — окна нулевой длины
 * не бывает, и трактовать её как «весь остаток клипа» значило бы придумывать за автора.
 */
export function comboWindow(c: Clip | null | undefined): { start: number; end: number } | null {
  if (!c) return null;
  for (const k of c.keys) {
    const m = k.marks?.find((x) => x.type === 'combo' && x.dur !== undefined && x.dur > 0);
    if (m) return { start: k.t, end: k.t + m.dur! };
  }
  return null;
}

export interface MarkEvent {
  mark: Mark; phase: 'point' | 'begin' | 'end'; t: number;
  /** Клип, из которого метка. Нужен подписчику, чтобы видеть СОСЕДНИЕ метки (звук замаха молчит,
   *  если в клипе размечен взмах — иначе свистело бы дважды; см. `animSfx.soundForMark`). Шаг, снятый
   *  с опоры ног (планировщик, касания клипа), клипа не имеет. */
  clip?: Clip;
  /** Темп хода в момент события: 0 — на месте … 1 — бег. Ставит проигрыватель; шаг по нему громче и суше. */
  pace?: number;
}
/**
 * Метки, ПЕРЕСЕЧЁННЫЕ на интервале (tPrev, tNow] времени КЛИПА. Точечные дают `point`, отрезки — `begin`
 * на своём ключе и `end` через `dur`.
 * ⚠ Искать надо по ПРОЙДЕННОМУ интервалу, а не по «ближайшему кадру»: на сжатом тайм-варпом клипе кадр
 * между двумя вызовами проскакивают целиком, и метка бы потерялась.
 * `dur` живёт во времени КЛИПА, поэтому тайм-варп удара растягивает отрезок вместе с анимацией сам собой.
 */
export function marksInRange(c: Clip, tPrev: number, tNow: number): MarkEvent[] {
  const out: MarkEvent[] = [];
  if (tNow <= tPrev) return out;
  for (const k of c.keys) {
    if (!k.marks) continue;
    for (const m of k.marks) {
      if (m.dur !== undefined && m.dur > 0) {
        if (k.t > tPrev && k.t <= tNow) out.push({ mark: m, phase: 'begin', t: k.t, clip: c });
        const e = k.t + m.dur;
        if (e > tPrev && e <= tNow) out.push({ mark: m, phase: 'end', t: e, clip: c });
      } else if (k.t > tPrev && k.t <= tNow) out.push({ mark: m, phase: 'point', t: k.t, clip: c });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Метки ЦИКЛА, пройденные за кадр. Время цикла могло перескочить через шов — тогда `tNow < tPrev`, и пройденный
 * путь это (tPrev, конец цикла] ∪ [начало цикла, tNow].
 * ⚠ Начало после шва берётся ВКЛЮЧИТЕЛЬНО: метка на первом кадре цикла иначе не звучала бы никогда — та же
 * причина, по которой удар на первом кадре ищет от −ε.
 */
export function loopMarksInRange(c: Clip, tPrev: number, tNow: number, loopStart: number, loopEnd: number): MarkEvent[] {
  if (tNow >= tPrev) return marksInRange(c, tPrev, tNow);
  return [...marksInRange(c, tPrev, loopEnd), ...marksInRange(c, loopStart - 1e-9, tNow)];
}

/** Есть ли в клипе метка этого типа. */
export const hasMark = (c: Clip | null | undefined, type: MarkType): boolean =>
  !!c?.keys.some((k) => k.marks?.some((m) => m.type === type));

const sameMark = (a: Mark, b: Mark): boolean =>
  a.type === b.type && a.foot === b.foot && a.sfx === b.sfx && a.vfx === b.vfx && a.num === b.num && a.dur === b.dur;

/**
 * ⭐ ПЕРЕНЕСТИ МЕТКИ СО СТАРОЙ ВЕРСИИ КЛИПА НА ПЕРЕЗАПЕЧЁННУЮ. Запекание пишет клип заново — ключи другие,
 * и расставленные руками метки (шаги!) пропадали бы при первой же правке походки и перезапекании.
 *
 * Время переносится ДОЛЕЙ длительности: цикл походки снят по фазе, поэтому «левая пятка на 12 % цикла»
 * остаётся на 12 % и при другом темпе. Ключа в этой точке нет — он ВСТАВЛЯЕТСЯ позой самого клипа в ней:
 * отрезок делится на два отрезка той же дуги, и движение не меняется ни на градус.
 * Одинаковые метки на одном ключе не дублируются — повторный перенос ничего не добавит.
 */
export function carryMarks(from: Clip, to: Clip): Clip {
  const src = from.keys.filter((k) => k.marks?.length);
  const dFrom = clipDur(from), dTo = clipDur(to);
  if (!src.length || !to.keys.length) return to;
  const keys: Keyframe[] = to.keys.map((k) => (k.marks ? { ...k, marks: [...k.marks] } : { ...k }));
  for (const k of src) {
    const t = dFrom > 0 && dTo > 0 ? Math.min(dTo, (k.t / dFrom) * dTo) : 0;
    let i = keys.findIndex((x) => Math.abs(x.t - t) < 1e-4);
    if (i < 0) {
      i = keys.findIndex((x) => x.t > t);
      if (i < 0) i = keys.length;
      keys.splice(i, 0, { t, pose: clipPoseAt(to, dTo > 0 ? t / dTo : 0) });
    }
    const dst = keys[i]!;
    for (const m of k.marks!) if (!dst.marks?.some((x) => sameMark(x, m))) (dst.marks ??= []).push({ ...m });
  }
  return { ...to, keys };
}

// ── Зеркало / переворот ───────────────────────────────────────────────────────────────────────────
const otherSide = (nm: string): string | null =>
  nm.startsWith('Left') ? 'Right' + nm.slice(4) : nm.startsWith('Right') ? 'Left' + nm.slice(5) : null;
/** Позиц-ключи, у которых зеркалится X (мир рига: Left = +X). */
const MIRROR_POS = new Set([...WPN_POS, '__lgripP', HIPS_ABS, HIPS_DEL, ROOT_POS]);

/** Отзеркалить ОДНУ сторону на другую: `from='Left'` → правая половина становится отражением левой.
 *  Центральные кости не трогаются (это «подтянуть вторую руку», а не переворот всей позы). */
export function mirrorSide(p: Pose, from: 'Left' | 'Right' = 'Left'): Pose {
  const out: Pose = {};
  for (const k in p) { const v = p[k]!; out[k] = [v[0], v[1], v[2]]; }
  for (const nm in p) {
    if (!nm.startsWith(from)) continue;
    const dst = otherSide(nm); if (!dst) continue;
    const s = p[nm]!;
    out[dst] = [s[0], -s[1], -s[2]];
  }
  return out;
}

/** Перевернуть позу целиком: стороны меняются местами, центральные кости отражаются.
 *  Двойное применение — тождество (проверяется тестом). */
export function flipPose(p: Pose): Pose {
  const out: Pose = {};
  for (const k in p) {
    const v = p[k]!;
    const dst = otherSide(k);
    if (dst) { out[dst] = [v[0], -v[1], -v[2]]; continue; }             // кость: на другую сторону + отражение
    if (k[0] !== '_') { out[k] = [v[0], -v[1], -v[2]]; continue; }      // центральная кость: отражение на месте
    if (MIRROR_POS.has(k)) { out[k] = [-v[0], v[1], v[2]]; continue; }  // позиция: зеркало по X
    if (k === ROOT_YAW) { out[k] = [-v[0], v[1], v[2]]; continue; }     // поворот корня: зеркало меняет сторону разворота
    if (isAngleKey(k)) { out[k] = [v[0], -v[1], -v[2]]; continue; }     // спец-поворот (оружие/грип)
    out[k] = [v[0], v[1], v[2]];                                        // скаляры (__match/__pinKp) — как есть
  }
  return out;
}

// ── Миграции формата ──────────────────────────────────────────────────────────────────────────────
/** Старый формат (`keys: Pose[]` без времени) → кадры с временем; `__hipsY` → `__hipsP` (Ф1.4).
 *  Применяется ПРИ ЧТЕНИИ, чтобы весь накопленный на сервере контент работал без разрушительной миграции. */
/** Ключ клипа в библиотеке: игра ищет стойку/удар РОВНО по этой тройке (`localStorageContent.find`). */
export const clipKey = (c: { name: string; character: string; weapon: string }): string => `${c.name}|${c.character}|${c.weapon}`;
/**
 * Тройки, встречающиеся в библиотеке больше одного раза.
 *
 * Дубль — это не «лишняя запись», а тихая порча: чтение берёт ПЕРВОЕ совпадение, поэтому вторая и
 * дальше копии недостижимы, а редактор может править как раз их. Пусто = библиотека чистая.
 */
export function duplicateClipKeys(list: readonly { name: string; character: string; weapon: string }[]): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const c of list) { const k = clipKey(c); if (seen.has(k)) dup.add(k); else seen.add(k); }
  return [...dup];
}
/** Свободное имя в пределах персонажа и оружия: `имя`, `имя_2`, `имя_3`… */
export function freeClipNameIn(list: readonly { name: string; character: string; weapon: string }[], nm: string, character: string, weapon: string): string {
  const taken = (n: string): boolean => list.some((x) => x.name === n && x.character === character && x.weapon === weapon);
  let n = nm;
  for (let i = 2; taken(n); i++) n = nm + '_' + i;
  return n;
}

export function migrateClip(c0: unknown): Clip {
  const c = c0 as Clip & { keys: (Keyframe | Pose)[] };
  const keys: Keyframe[] = (c.keys ?? []).map((k, i) => {
    const kf: Keyframe = (k && typeof (k as Keyframe).t === 'number' && (k as Keyframe).pose)
      ? (k as Keyframe)
      : { pose: k as unknown as Pose, t: i * DEF_GAP };
    migratePose(kf.pose);
    return kf;
  });
  // ⚠ Список полей ЯВНЫЙ, поэтому новое поле клипа надо дописывать И СЮДА — иначе оно молча
  // теряется на первом же чтении (ровно эта грабля описана у `marks`).
  return { name: c.name, character: c.character, weapon: c.weapon, loop: c.loop ?? false, keys,
    idleEnds: c.idleEnds, idleEndsFrom: c.idleEndsFrom, rootYaw: c.rootYaw, rootPos: c.rootPos };
}

/**
 * ⭐ ЧЬЕЙ ПОЗОЙ СИНКАТЬ КОНЦЫ КЛИПА. Разбор `idleEndsFrom` вынесен из редактора сюда, чтобы его
 * можно было проверить тестом: в редакторе он жил бы в DOM-коде и остался бы без сторожа.
 *
 * ⚠ Нет отметки — берём обычную стойку, как было всегда: у ударов (`hit_*`) концы и должны быть
 * idle, и старые клипы не должны поменять поведение.
 */
export function idleEndsSource(c: Clip, look: { stance(weapon: string, combat: number): Pose | null; clip(name: string): Pose | null }): Pose | null {
  const from = c.idleEndsFrom;
  if (from && from.startsWith('clip:')) return look.clip(from.slice(5));
  if (from === 'combat') return look.stance(c.weapon, 1);
  return look.stance(c.weapon, 0);
}

/** Ин-плейс миграция одной позы: `__hipsY` (только высота) → `__hipsP` (полный офсет таза X/Y/Z).
 *  Раньше X/Z таза молча терялись при записи кадра — из-за этого мах/скрутка таза в ударе не сохранялись. */
export function migratePose(p: Pose): Pose {
  const y = p['__hipsY'];
  if (y && !p['__hipsP']) p['__hipsP'] = [0, y[0], 0];
  if (y) delete p['__hipsY'];
  return p;
}

/**
 * ⭐ ЕСТЬ ЛИ В КЛИПЕ ЖИВАЯ АНИМАЦИЯ ПАЛЬЦЕВ — то есть меняются ли каналы фаланг ОТ КАДРА К КАДРУ.
 *
 * Нужно ровно для одного решения: чей хват сильнее. Живой конфиг хвата (`pe_gripposes`) обязан
 * перебивать ЗАПЕЧЁННЫЙ статичный хват — иначе правка в редакторе не доезжает до игры, потому что в
 * клипе лежит слепок прошлой настройки. Но АНИМАЦИЮ пальцев он перебивать не имеет права: замер
 * мокапа со снятыми кистями — это не хват, а движение, и подменять его статичной позой значит терять
 * работу. Один кадр анимацией не бывает по определению.
 *
 * Считается один раз на клип (`WeakMap`) — зовётся каждый кадр.
 */
const FINGER_CH = /^(Left|Right)(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;
const _fingerVary = new WeakMap<object, boolean>();
export function fingersAnimated(clip: { keys: { pose: Pose }[] } | null | undefined): boolean {
  if (!clip) return false;
  const hit = _fingerVary.get(clip); if (hit !== undefined) return hit;
  let out = false;
  const keys = clip.keys;
  if (keys && keys.length > 1) {
    const first = keys[0]!.pose;
    outer: for (const nm in first) {
      if (!FINGER_CH.test(nm)) continue;
      const a = first[nm]!;
      for (let i = 1; i < keys.length; i++) {
        const b = keys[i]!.pose[nm];
        if (!b || Math.abs(b[0] - a[0]) > 1e-4 || Math.abs(b[1] - a[1]) > 1e-4 || Math.abs(b[2] - a[2]) > 1e-4) { out = true; break outer; }
      }
    }
  }
  _fingerVary.set(clip, out);
  return out;
}
