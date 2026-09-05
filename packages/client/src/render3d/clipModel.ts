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
 *  `fixed` — интервал считается уже записанным покадрово, доп. сглаживания нет (== linear). */
export type Interp = 'linear' | 'ease' | 'step' | 'fixed';

export interface Keyframe {
  pose: Pose;
  t: number;                    // сек от начала клипа (кадры отсортированы по t)
  interp?: Interp;              // нет → 'linear'
  ease?: [number, number, number, number];   // ручки безье (x1,y1,x2,y2), только для interp='ease'
}
export interface Clip { name: string; character: string; weapon: string; loop: boolean; keys: Keyframe[]; idleEnds?: boolean }   // idleEnds: первый/последний кадр = idle-стойка (заблокированы в редакторе, синкаются из стойки — как у ударов hit_)

export const DEF_GAP = 0.3;     // дефолт-шаг между кадрами (сек) при миграции старого формата

export const clipDur = (c: Clip): number => (c.keys.length ? c.keys[c.keys.length - 1]!.t : 0);

// ── Спец-ключи позы (не кости) ────────────────────────────────────────────────────────────────────
export const WPN_KEYS = ['__wpnMain', '__wpnOff'];             // поворот оружия
export const WPN_POS = ['__wpnMainP', '__wpnOffP'];            // позиция оружия
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
  if (!m || m === 'linear' || m === 'fixed') return u;
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
  if (!seg) return {};
  return seg.a === seg.b ? seg.a.pose : blendTwo(seg.a.pose, seg.b.pose, seg.u);
}

// ── Зеркало / переворот ───────────────────────────────────────────────────────────────────────────
const otherSide = (nm: string): string | null =>
  nm.startsWith('Left') ? 'Right' + nm.slice(4) : nm.startsWith('Right') ? 'Left' + nm.slice(5) : null;
/** Позиц-ключи, у которых зеркалится X (мир рига: Left = +X). */
const MIRROR_POS = new Set([...WPN_POS, '__lgripP', '__hipsP']);

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
    if (isAngleKey(k)) { out[k] = [v[0], -v[1], -v[2]]; continue; }     // спец-поворот (оружие/грип)
    out[k] = [v[0], v[1], v[2]];                                        // скаляры (__match/__pinKp) — как есть
  }
  return out;
}

// ── Миграции формата ──────────────────────────────────────────────────────────────────────────────
/** Старый формат (`keys: Pose[]` без времени) → кадры с временем; `__hipsY` → `__hipsP` (Ф1.4).
 *  Применяется ПРИ ЧТЕНИИ, чтобы весь накопленный на сервере контент работал без разрушительной миграции. */
export function migrateClip(c0: unknown): Clip {
  const c = c0 as Clip & { keys: (Keyframe | Pose)[] };
  const keys: Keyframe[] = (c.keys ?? []).map((k, i) => {
    const kf: Keyframe = (k && typeof (k as Keyframe).t === 'number' && (k as Keyframe).pose)
      ? (k as Keyframe)
      : { pose: k as unknown as Pose, t: i * DEF_GAP };
    migratePose(kf.pose);
    return kf;
  });
  return { name: c.name, character: c.character, weapon: c.weapon, loop: c.loop ?? false, keys, idleEnds: c.idleEnds };
}

/** Ин-плейс миграция одной позы: `__hipsY` (только высота) → `__hipsP` (полный офсет таза X/Y/Z).
 *  Раньше X/Z таза молча терялись при записи кадра — из-за этого мах/скрутка таза в ударе не сохранялись. */
export function migratePose(p: Pose): Pose {
  const y = p['__hipsY'];
  if (y && !p['__hipsP']) p['__hipsP'] = [0, y[0], 0];
  if (y) delete p['__hipsY'];
  return p;
}
