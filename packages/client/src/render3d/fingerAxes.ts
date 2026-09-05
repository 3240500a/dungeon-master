/**
 * ОСИ СУСТАВОВ ПАЛЬЦА — ВЫВОДЯТСЯ ИЗ ГЕОМЕТРИИ, А НЕ ЗАШИТЫ (Ф14.4).
 *
 * Раньше и пределы (`jointLimits.fingerJoints`), и хваты (`gripPoses.gripToPose`) считали, что палец
 * лежит вдоль ±X, а сгибается вокруг Y. Первое верно для нашего процедурного манекена, второе — НЕТ:
 * корни пальцев разложены по Z (Index z=+1.5 … Little z=−1.4), кисть тонкая по Y, значит плоскость
 * ладони — X–Z, и «в кулак» это вращение вокруг Z. Вокруг Y палец уезжал ВБОК по ладони.
 * На импортированной модели всё ещё хуже: там палец смотрит куда угодно, и никакая фиксированная ось
 * не подходит в принципе.
 *
 * Здесь ось выводится из САМИХ КОСТЕЙ, поэтому одна формула работает и на нашем манекене, и на чужом риге:
 *
 *   along      — направление фаланги (офсет её первого ребёнка);
 *   spread     — поперёк ладони (корень мизинца − корень указательного);
 *   palmN      — нормаль ладони = along(средний) × spread;
 *   palmInward — та сторона ладони, где большой палец (он всегда с ладонной стороны);
 *   plane      — ОСЬ СГИБА = along × palmInward;   twist = along;   normal = twist × plane.
 *
 * БОЛЬШОЙ ПАЛЕЦ — ИСКЛЮЧЕНИЕ (Ф17). Его пястная кость развёрнута относительно остальных на ~90°
 * (это и есть противопоставление), поэтому он сгибается ПОПЕРЁК ладони (кончик идёт к мизинцу), а не
 * «вниз к ладони». Общая формула давала ему ось, повёрнутую ровно на 90° (видно по гизмо предела:
 * клин сгиба смотрел попёрёк реального хода). У него `plane = нормаль ладони`, ортогонализованная к фаланге.
 *
 * ВАЖНО про знак: берётся именно `palmN` (как посчитался), а НЕ `palmInward`. `palmN` — псевдовектор
 * (`palmN_R = −M·palmN_L`), и только с ним ОДИН и тот же угол гнёт оба больших пальца внутрь; `palmInward`
 * полярен (знак `s` тоже меняется) и потребовал бы пер-стороннего множителя — того самого, который мы вывели как лишний.
 *
 * Тройка ортонормирована по построению — это важно: `jointClamp.clampLocalToLimit` раскладывает свинг
 * скалярными произведениями и на косой тройке дал бы неверный клэмп, а `dofBasis` в редакторе строит
 * из неё матрицу поворота напрямую.
 *
 * Модуль ЧИСТЫЙ (числа, без THREE и без сцены) — целиком тестируется в node.
 */
import { FINGER_CHAINS, FINGER_SEGMENTS, type FingerChain } from './boneNames.js';
import { FINGER_GEO } from './humanoid.js';

export type Vec3 = [number, number, number];
export interface FingerAxes {
  twist: Vec3; plane: Vec3; normal: Vec3;
  /**
   * НАСКОЛЬКО ФАЛАНГА УЖЕ СОГНУТА В БИНДЕ (рад, вокруг оси сгиба, положительное = к ладони).
   * У моделей бинд-кисть бывает какой угодно — от прямой до заметно сжатой, и это наша rest-поза.
   * Хват же задаёт сгиб «ОТ ПРЯМОГО ПАЛЬЦА» и ложился поверх бинда → кулак поверх полукулака.
   * Вычитая `bindCurl`, получаем: «открытая» = ровно бинд модели, «кулак» = кулак на любой модели.
   *
   * Отсчёт у каждого сустава свой, от направления ПРЕДЫДУЩЕГО звена:
   *   Proximal     — от ПЯСТНОЙ кости (запястье→корень пальца). Это главный сустав сгиба (MCP) и самый
   *                  большой ход; раньше он считался нулевым «точкой отсчёта» и потому не корректировался.
   *   Intermediate — от проксимальной фаланги. Замеряется точно.
   *   Distal       — ОЦЕНКА: берём угол средней. У кисти нет кости-кончика (проверено на CC: `L_Index3`
   *                  без детей), направление последнего звена измерить не из чего. В расслабленной кисти
   *                  DIP согнут примерно как PIP, а ошибка в меньшую сторону безопаснее переизгиба.
   */
  bindCurl: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 | null => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Rest-офсет кости относительно родителя. `null` — кости нет. */
export type OffsetOf = (bone: string) => Vec3 | null;

const boneName = (side: 'Left' | 'Right', chain: FingerChain, seg: 0 | 1 | 2): string => side + chain + FINGER_SEGMENTS[seg];

/** Канонические офсеты фаланг из `FINGER_GEO` — ровно то, что строит `humanoid.fingerBones()`. */
export function canonicalFingerOffsets(): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    for (const [chain, base, lens] of FINGER_GEO) {
      for (let i = 0; i < 3; i++) {
        out[side + chain + FINGER_SEGMENTS[i]] = i === 0
          ? [base[0] * sx, base[1], base[2]]
          : [(lens[i - 1] ?? 1) * sx, 0, 0];
      }
    }
  }
  return out;
}

/**
 * Оси всех 30 фаланг. Если геометрия вырождена (ладонь схлопнута, палец совпал с нормалью ладони) —
 * для этой кости оси не выдаются: пусть вызывающий возьмёт канонические, чем получить NaN в клэмпе.
 */
export function deriveFingerAxes(offsetOf: OffsetOf): Record<string, FingerAxes> {
  const out: Record<string, FingerAxes> = {};
  for (const side of ['Left', 'Right'] as const) {
    // Направление фаланги = офсет её ПЕРВОГО РЕБЁНКА. У дистальной ребёнка нет — берём её собственный
    // офсет (направление предыдущего звена): у прямого пальца это то же направление.
    const along = (chain: FingerChain, seg: 0 | 1 | 2): Vec3 | null =>
      norm((seg < 2 ? offsetOf(boneName(side, chain, (seg + 1) as 0 | 1 | 2)) : offsetOf(boneName(side, chain, seg))) ?? [0, 0, 0]);

    const rootOf = (chain: FingerChain): Vec3 | null => offsetOf(boneName(side, chain, 0));
    const idx = rootOf('Index'), lit = rootOf('Little'), mid = rootOf('Middle'), thu = rootOf('Thumb');
    const midAlong = along('Middle', 0);
    if (!idx || !lit || !mid || !thu || !midAlong) continue;

    const palmN = norm(cross(midAlong, sub(lit, idx)));
    if (!palmN) continue;
    const s = dot(sub(thu, mid), palmN);            // большой палец — с ЛАДОННОЙ стороны
    if (Math.abs(s) < 1e-9) continue;
    const palmInward = scale(palmN, Math.sign(s));

    for (const chain of FINGER_CHAINS) {
      const isThumb = chain === 'Thumb';
      for (let seg = 0 as 0 | 1 | 2; seg <= 2; seg = (seg + 1) as 0 | 1 | 2) {
        const t = along(chain, seg); if (!t) continue;
        // Ф17: у большого пальца ось сгиба — САМА нормаль ладони (см. шапку), у остальных — поперёк ладони.
        // Нормаль к фаланге не перпендикулярна, поэтому ортогонализуем (иначе тройка косая и клэмп врёт).
        const raw = isThumb ? sub(palmN, scale(t, dot(palmN, t))) : cross(t, palmInward);
        const plane = norm(raw); if (!plane) continue;                    // палец вдоль своей же оси — вырождение
        const normal = norm(cross(t, plane)); if (!normal) continue;
        // Бинд-сгиб = знаковый угол от направления ПРЕДЫДУЩЕГО звена к этому, вокруг оси сгиба.
        // Для проксимальной предыдущее звено — пястная кость (запястье→корень пальца).
        const prev = seg === 0 ? norm(rootOf(chain) ?? [0, 0, 0]) : along(chain, (seg - 1) as 0 | 1 | 2);
        const measured = prev ? Math.atan2(dot(cross(prev, t), plane), dot(prev, t)) : 0;
        const bindCurl = seg === 2 ? (out[boneName(side, chain, 1)]?.bindCurl ?? 0) : measured;   // у дистальной — оценка по средней
        out[boneName(side, chain, seg)] = { twist: t, plane, normal, bindCurl };
      }
    }
  }
  return out;
}

/** Канонические оси (наш процедурный манекен) — считаются один раз. */
let _canon: Record<string, FingerAxes> | null = null;
export const canonicalFingerAxes = (): Record<string, FingerAxes> => (_canon ??= deriveFingerAxes((b) => canonicalFingerOffsets()[b] ?? null));

/**
 * НА СКОЛЬКО эта кисть согнута СИЛЬНЕЕ нашей канонической — то, что надо вычесть из хвата.
 *
 * Считаем ИЗБЫТОК, а не абсолютный угол: у большого пальца пястная кость идёт под углом к фаланге,
 * и на нашей СОБСТВЕННОЙ прямой кисти «угол пясть→проксимальная» = 23°. Вычитать его нельзя — это
 * структура кисти, а не согнутость, и хват недобирал бы 23° на любой модели, включая процедурную.
 * Разность с каноном обнуляет всё структурное и оставляет ровно «насколько эта модель поджата».
 */
export function bindCurlOver(bone: string, derived?: Record<string, FingerAxes> | null): number {
  const c = canonicalFingerAxes()[bone]; if (!c) return 0;
  return (derived?.[bone]?.bindCurl ?? c.bindCurl) - c.bindCurl;
}

/**
 * НАСКОЛЬКО ЭТА КИСТЬ ПРИШЛА ПОДЖАТОЙ (градусы) — диагностика для редактора.
 * Показывает то, что хват теперь выпрямляет молча: у CC/AccuRIG левая и правая кисти согнуты
 * по-разному, и пока это не видно числом, «пальцы гнутся не так» выглядит как баг хвата.
 */
export function bindCurlReport(side: 'Left' | 'Right', derived?: Record<string, FingerAxes> | null): { avg: number; max: number } {
  const DEG = 180 / Math.PI;
  let sum = 0, n = 0, mx = 0;
  for (const chain of FINGER_CHAINS) {
    for (let seg = 0 as 0 | 1 | 2; seg <= 2; seg = (seg + 1) as 0 | 1 | 2) {
      const v = bindCurlOver(boneName(side, chain, seg), derived);
      sum += v; n++; mx = Math.max(mx, Math.abs(v));
    }
  }
  return n ? { avg: (sum / n) * DEG, max: mx * DEG } : { avg: 0, max: 0 };
}

/** Оси кости с фолбэком на канон. Один вход для пределов, хватов и гизмо. */
export function fingerAxesOf(bone: string, derived?: Record<string, FingerAxes> | null): FingerAxes | null {
  return derived?.[bone] ?? canonicalFingerAxes()[bone] ?? null;
}
