/**
 * ПРЕДЕЛЫ СУСТАВОВ, НЕ ЗАВИСЯЩИЕ ОТ ФИЗИКИ (Ф3.3).
 *
 * Раньше предел существовал ТОЛЬКО у кости, у которой есть физ-тело Jolt: `JOINT_DEF` выводился из таблицы
 * тел `B[]`, а `jointLimitView` брал оси прямо оттуда. Следствие: у фаланги пальца нет тела → нет `LimitView` →
 * ни осей для гизмо вращения, ни клэмпа. То есть «покрутить палец» физически не могло работать правильно.
 *
 * Здесь — второй, БЕЗ-физический источник пределов для костей, которых в рэгдолле нет (пальцы и всё, что
 * появится дальше). `limitViewForBone` сначала спрашивает физ-риг (там оси зеркальны и выверены), и только
 * если тела нет — берёт отсюда. Так физика не тронута, а новые кости получают полноценный предел.
 *
 * Плюс ПРЕСЕТЫ скелета. Диапазоны у нас асимметричные (min/max), а не симметричный конус — поэтому
 * «колени в обратную сторону» это просто перестановка знаков, отдельного кода не нужно.
 *
 * Оси в локальном фрейме РОДИТЕЛЯ в T-позе, как и в физ-риге:
 *   twist  — вдоль кости, plane — ось основного сгиба, normal = twist × plane.
 * У нас Left = +X, вперёд = +Z, вверх = +Y. Пальцы смотрят вдоль ±X, сгибаются вокруг Y (к ладони, т.е. −Z).
 */
import type { LimitView, JointLim } from './humanoidRagdoll.js';
import { FINGER_CHAINS, FINGER_SEGMENTS } from './boneNames.js';
import { canonicalFingerAxes, fingerAxesOf, bindCurlOver, type FingerAxes } from './fingerAxes.js';

type Vec3 = [number, number, number];
const D = Math.PI / 180;

/** Описание предела кости вне физ-рига: канон-id сустава + оси + углы. */
export interface ExtraJoint { canon: string; twist: Vec3; plane: Vec3; def: JointLim }

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Пределы фаланг. Анатомия: пястно-фаланговый (Proximal) сгибается ~90° и имеет небольшой боковой развод;
 * межфаланговые (Intermediate/Distal) — почти чистые шарниры без развода. Большой палец живёт в своей
 * плоскости (противопоставление), поэтому у него шире твист и развод.
 */
function fingerJoints(): Record<string, ExtraJoint> {
  const out: Record<string, ExtraJoint> = {};
  const canon = canonicalFingerAxes();
  for (const side of ['Left', 'Right'] as const) {
    for (const chain of FINGER_CHAINS) {
      for (let i = 0; i < 3; i++) {
        const name = side + chain + FINGER_SEGMENTS[i];
        // Ф14.4: оси НЕ зашиты. Раньше тут стояло `twist=[sx,0,0], plane=[0,1,0]` — и `plane` был неверен
        // даже для нашего манекена: пальцы разложены по Z, ладонь тонкая по Y, поэтому сгиб — вокруг Z,
        // а вокруг Y палец уезжал ВБОК. Теперь ось выводится из самой геометрии (`fingerAxes.ts`).
        const ax = canon[name]; if (!ax) continue;
        const twist: Vec3 = ax.twist, plane: Vec3 = ax.plane;
        const isThumb = chain === 'Thumb';
        const base = i === 0;
        const def: JointLim = {
          kind: 'swing', group: 'arm',
          // Основной сгиб: почти только «в кулак», переразгиб маленький. ЗНАК СЛЕДУЕТ ЗА ОСЬЮ:
          // положительный угол вокруг выведенной оси = сгиб к ладони (на ОБЕИХ кистях — ось уже зеркальна).
          //
          // БОЛЬШОЙ ПАЛЕЦ НЕСИММЕТРИЧЕН В ДРУГУЮ СТОРОНУ (Ф18). У прочих пальцев разгиб —
          // крохотный переразгиб, а у большого это ЛУЧЕВОЕ ОТВЕДЕНИЕ — тот самый увод ·В СТОРОНУ·,
          // которым ставится раскрытая ладонь, и хода там не 25°, а все 60°. С прежними числами клин
          // предела уходил почти целиком в сторону сгиба, и отвести большой было некуда — FK-клэмп
          // упирал его в границу. Межфаланговый большого (IP) тоже заметно переразгибается (~20°).
          planeMin: (isThumb ? (base ? -60 : -20) : (base ? -25 : -5)) * D, planeMax: (base ? 95 : 100) * D,
          // боковой развод — только у основания. У большого это ладонное отведение (из плоскости ладони), тоже ~50°.
          normalMin: (base ? (isThumb ? -50 : -18) : -3) * D, normalMax: (base ? (isThumb ? 50 : 18) : 3) * D,
          // осевой твист — почти нет, кроме противопоставления большого
          twistMin: (isThumb && base ? -45 : -8) * D, twistMax: (isThumb && base ? 45 : 8) * D,
        };
        out[name] = { canon: `finger_${chain.toLowerCase()}_${FINGER_SEGMENTS[i]!.toLowerCase()}`, twist, plane, def };
      }
    }
  }
  return out;
}

/** Кость → предел, если у неё НЕТ физ-тела. */
export const EXTRA_JOINTS: Record<string, ExtraJoint> = fingerJoints();

/** `LimitView` для кости без физ-тела (тот же контракт, что у физического `jointLimitView`).
 *  `axes` — оси, выведенные из КОНКРЕТНОГО рига (импортированная модель); нет — берутся канонические. */
export function extraLimitView(boneName: string, axes?: Record<string, FingerAxes> | null): LimitView | null {
  const j = EXTRA_JOINTS[boneName]; if (!j) return null;
  const e = j.def;
  const a = fingerAxesOf(boneName, axes) ?? { twist: j.twist, plane: j.plane, normal: cross(j.twist, j.plane) };
  // Ф17: ДИАПАЗОН СГИБА СДВИГАЕТСЯ НА БИНД-ИЗБЫТОК. Числа в `fingerJoints` — анатомия, отсчитанная
  // ОТ ПРЯМОГО пальца (переразгиб −25°, сгиб +95°), а локальный угол кости отсчитывается от rest,
  // то есть от БИНДА модели. У CC бинд поджат на 20–50°, и получалось: выпрямление (локальный −over)
  // выходило за planeMin, а кулак не доставал до planeMax. Сдвиг возвращает обе границы на место —
  // «прямой палец» ровно внутри зоны, «полный кулак» ровно на её краю, на любой модели.
  const shift = bindCurlOver(boneName, axes);
  return {
    kind: 'swing', group: e.group, canon: j.canon,
    twist: a.twist, plane: a.plane, normal: a.normal,
    planeMin: (e.planeMin ?? 0) - shift, planeMax: (e.planeMax ?? 0) - shift,
    normalMin: e.normalMin, normalMax: e.normalMax, twistMin: e.twistMin, twistMax: e.twistMax,
  };
}

// ── ПРЕСЕТЫ СКЕЛЕТА ──────────────────────────────────────────────────────────────────────────────────
/**
 * Готовые наборы оверрайдов канон-суставов. Ложатся в тот же `jointOv`, что и ручная правка,
 * и персистятся тем же `pe_ragdoll` — то есть это просто «залить осмысленные числа одной кнопкой».
 *
 * `digitigrade` — звериные ноги: колено гнётся В ДРУГУЮ СТОРОНУ, голеностоп получает большой диапазон
 * (у дигитигра он работает как второе колено). Работает БЕЗ нового кода ровно потому, что пределы
 * асимметричные: у человека колено `flex` вперёд, тут — назад, что выражается через hyperext.
 */
export interface LimitPreset { id: string; label: string; hint: string; joints: Record<string, Partial<JointLim>> }

export const LIMIT_PRESETS: readonly LimitPreset[] = [
  { id: 'human', label: 'Человек', hint: 'анатомический эталон (дефолт)', joints: {} },
  {
    id: 'digitigrade', label: 'Обратные колени / дигитигр',
    hint: 'колено гнётся назад, голеностоп работает как второй сустав',
    joints: {
      knee: { flex: 10 * D, hyperext: 130 * D },                       // основной сгиб ушёл в «переразгиб»
      ankle: { planeMin: -110 * D, planeMax: 40 * D, normalMin: -20 * D, normalMax: 20 * D, twistMin: -15 * D, twistMax: 15 * D },
      hip: { planeMin: -70 * D, planeMax: 60 * D, normalMin: -80 * D, normalMax: 80 * D, twistMin: -40 * D, twistMax: 40 * D },
      toe: { flex: 60 * D, hyperext: 40 * D },
    },
  },
  {
    id: 'loose', label: 'Свободный (мягкие пределы)',
    hint: 'вдвое шире человеческих — для мультяшных/нечеловеческих поз',
    joints: {
      shoulder: { planeMin: -200 * D, planeMax: 200 * D, normalMin: -160 * D, normalMax: 160 * D, twistMin: -170 * D, twistMax: 170 * D },
      hip: { planeMin: -120 * D, planeMax: 120 * D, normalMin: -170 * D, normalMax: 170 * D, twistMin: -90 * D, twistMax: 90 * D },
      spine: { planeMin: -80 * D, planeMax: 90 * D, normalMin: -60 * D, normalMax: 60 * D, twistMin: -70 * D, twistMax: 70 * D },
      elbow: { flex: 170 * D, hyperext: 25 * D },
      knee: { flex: 170 * D, hyperext: 25 * D },
    },
  },
  {
    id: 'none', label: 'Без пределов', hint: 'клэмп фактически отключён (поза важнее анатомии)',
    joints: {
      shoulder: { planeMin: -Math.PI, planeMax: Math.PI, normalMin: -Math.PI, normalMax: Math.PI, twistMin: -Math.PI, twistMax: Math.PI },
      hip: { planeMin: -Math.PI, planeMax: Math.PI, normalMin: -Math.PI, normalMax: Math.PI, twistMin: -Math.PI, twistMax: Math.PI },
      spine: { planeMin: -Math.PI, planeMax: Math.PI, normalMin: -Math.PI, normalMax: Math.PI, twistMin: -Math.PI, twistMax: Math.PI },
      head: { planeMin: -Math.PI, planeMax: Math.PI, normalMin: -Math.PI, normalMax: Math.PI, twistMin: -Math.PI, twistMax: Math.PI },
      wrist: { planeMin: -Math.PI, planeMax: Math.PI, normalMin: -Math.PI, normalMax: Math.PI, twistMin: -Math.PI, twistMax: Math.PI },
      ankle: { planeMin: -Math.PI, planeMax: Math.PI, normalMin: -Math.PI, normalMax: Math.PI, twistMin: -Math.PI, twistMax: Math.PI },
      elbow: { flex: 179 * D, hyperext: 179 * D },
      knee: { flex: 179 * D, hyperext: 179 * D },
      toe: { flex: 179 * D, hyperext: 179 * D },
    },
  },
] as const;

export const findPreset = (id: string): LimitPreset | null => LIMIT_PRESETS.find((p) => p.id === id) ?? null;
