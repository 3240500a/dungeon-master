/**
 * ИМПОРТ КЛИПА — ЧИСТАЯ ЧАСТЬ: обрезка, шов цикла, сигнатура рига, отчёт диагностики.
 *
 * Всё, что здесь лежит, раньше либо не существовало (обрезка, шов), либо уходило в `console.log`
 * запекателя (диагностика). Причина №1 жалобы «импорт дал два ключа» — карта костей промахнулась или
 * анимация не дошла до костей, и об этом можно было узнать ТОЛЬКО открыв F12. Отчёт — те же числа,
 * но как ДАННЫЕ: панель импорта их показывает, а тест может проверить.
 *
 * Ни загрузчиков, ни DOM → тестируется в node.
 */
import * as THREE from 'three';
import { clipDur, clipSegmentAt, blendTwo, type Clip, type Keyframe, type MarkType, type Pose } from './clipModel.js';
import { pasteIntoInterval } from './poseLibrary.js';

const RAD2DEG = 180 / Math.PI;
const clonePose = (p: Pose): Pose => { const o: Pose = {}; for (const k in p) { const v = p[k]!; o[k] = [v[0], v[1], v[2]]; } return o; };
const cloneKey = (k: Keyframe): Keyframe => ({ ...k, pose: clonePose(k.pose), marks: k.marks?.map((m) => ({ ...m })) });

// ── Отчёт диагностики ────────────────────────────────────────────────────────────────────────────
/** Что нашлось в файле — заполняется ОДИН раз на открытие источника. */
export interface ImportReport {
  file: string;
  animations: { name: string; dur: number; tracks: number }[];
  /** Костей в скелете источника. */
  bones: number;
  /** Повторяющиеся имена костей — верный признак дублей скелета от конвертера. */
  dupNames: string[];
  mapped: string[];
  unmapped: string[];
  /** Сколько из 30 фаланг нашлось (мокапы обычно без пальцев). */
  fingers: number;
  /** Первые имена дорожек — видно, какие кости анимация реально крутит. */
  tracks: string[];
  /** Направление руки/ноги ДО и ПОСЛЕ приведения к T-позе (в T: рука [±1,0,0], нога [0,−1,0]). */
  restBefore: { arm: string; leg: string };
  restAfter: { arm: string; leg: string };
}
/** Что вышло из ОДНОГО запекания — меняется на каждое переключение галки. */
export interface BakeStats {
  frames: number;
  keys: number;
  /** Макс. движение позы по кадрам (°). Почти ноль → анимация не дошла до снимаемых костей. */
  maxMoveDeg: number;
  worstBone: string;
  /** Худший ОТРЫВ стопы от своей цели (юниты). Больше нуля → перенос веса упёрся в длину ноги. */
  footMiss?: number;
  /** Размах смещения таза по X/Y/Z (юниты) — видно, что «сила переноса веса» реально делает. */
  hipsRange?: [number, number, number];
}
/** Клип статичен → в библиотеку такой класть бессмысленно (это и есть жалоба «импорт дал два ключа»). */
export const isStaticBake = (s: BakeStats): boolean => s.maxMoveDeg < 2;

// ── Сигнатура рига ───────────────────────────────────────────────────────────────────────────────
/**
 * Устойчивый ключ набора костей источника: под ним запоминается ручная карта костей, чтобы второй файл
 * с ТЕМ ЖЕ скелетом (следующий клип из того же пакета Mixamo) подхватывал её сам.
 * Имена сортируются — порядок обхода у разных конвертеров разный, а скелет тот же.
 * Хвост-номера копий (`..._7`) срезаются: дубли скелета не должны менять сигнатуру.
 */
export function rigSignature(boneNames: readonly string[]): string {
  const uniq = [...new Set(boneNames.map((n) => n.replace(/_\d+$/, '')))].sort();
  let h = 0x811c9dc5;
  for (const n of uniq) { for (let i = 0; i < n.length; i++) { h ^= n.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= 0x2f; h = Math.imul(h, 0x01000193); }
  return uniq.length + '-' + (h >>> 0).toString(16).padStart(8, '0');
}

// ── Обрезка ──────────────────────────────────────────────────────────────────────────────────────
/** Поза клипа в АБСОЛЮТНОМ времени (сек), с учётом кривых — то же, чем ходит проигрыватель. */
export function poseAtSec(c: Clip, sec: number): Pose {
  const seg = clipSegmentAt(c, sec);
  if (!seg) return {};
  return seg.a === seg.b ? clonePose(seg.a.pose) : blendTwo(seg.a.pose, seg.b.pose, seg.u);
}

/**
 * Обрезать ГОТОВЫЙ клип по времени. Границы становятся ключами (поза берётся интерполяцией),
 * время съезжает к нулю. Для импорта лучше резать по ИСХОДНИКУ (границы цикла семплирования) —
 * тогда прореживание идёт уже по обрезанному и концы RDP ложатся ровно на границы; эта функция для
 * правки уже лежащих в библиотеке клипов.
 */
export function trimClip(c: Clip, inSec: number, outSec: number): Clip {
  const dur = clipDur(c);
  const a = Math.max(0, Math.min(dur, Math.min(inSec, outSec)));
  const b = Math.max(0, Math.min(dur, Math.max(inSec, outSec)));
  if (!c.keys.length) return { ...c, keys: [] };
  if (b - a < 1e-6) return { ...c, keys: [{ t: 0, pose: poseAtSec(c, a) }] };
  const keys: Keyframe[] = [];
  const head = clipSegmentAt(c, a);
  keys.push({ t: 0, pose: poseAtSec(c, a), interp: head?.a.interp, ease: head?.a.ease ? [...head.a.ease] as [number, number, number, number] : undefined });
  for (const k of c.keys) if (k.t > a + 1e-6 && k.t < b - 1e-6) keys.push({ ...cloneKey(k), t: +(k.t - a).toFixed(4) });
  keys.push({ t: +(b - a).toFixed(4), pose: poseAtSec(c, b) });
  for (const k of keys) if (k.interp === undefined) delete k.interp;
  return { ...c, keys };
}

// ── Шов цикла ────────────────────────────────────────────────────────────────────────────────────
const _sa = new THREE.Quaternion(), _sb = new THREE.Quaternion(), _se = new THREE.Euler();
/** Угол между двумя позами по костям (°) и худшая кость. */
export function poseGap(a: Pose, b: Pose): { deg: number; bone: string } {
  let deg = 0, bone = '—';
  for (const nm of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (nm[0] === '_') continue;
    const va = a[nm], vb = b[nm]; if (!va || !vb) continue;
    _sa.setFromEuler(_se.set(va[0], va[1], va[2]));
    _sb.setFromEuler(_se.set(vb[0], vb[1], vb[2]));
    const d = _sa.angleTo(_sb) * RAD2DEG;
    if (d > deg) { deg = d; bone = nm; }
  }
  return { deg, bone };
}
/** Ошибка шва цикла: насколько последний кадр не совпал с первым. У не-цикла смысла не имеет. */
export const loopSeamGap = (c: Clip): { deg: number; bone: string } =>
  (c.keys.length < 2 ? { deg: 0, bone: '—' } : poseGap(c.keys[0]!.pose, c.keys[c.keys.length - 1]!.pose));

/**
 * Свести шов цикла: хвост длиной `blendSec` плавно приходит в позу первого кадра.
 * Ровно тот сценарий, под который написан `pasteIntoInterval` («взял первый кадр, вставил в хвост»).
 * `blendSec <= 0` → жёсткая сшивка: последний кадр просто становится первым.
 */
export function closeLoopSeam(c: Clip, blendSec: number): Clip {
  const keys = c.keys.map(cloneKey);
  if (keys.length < 2) return { ...c, keys };
  const first = clonePose(keys[0]!.pose), dur = keys[keys.length - 1]!.t;
  if (blendSec <= 0) { keys[keys.length - 1]!.pose = first; return { ...c, keys }; }
  let from = keys.length - 1;
  while (from > 0 && keys[from - 1]!.t >= dur - blendSec) from--;
  pasteIntoInterval(keys, from, keys.length - 1, first, 'bezier');
  return { ...c, keys };
}

/**
 * СШИВКА ТРЁХ ИСТОЧНИКОВ В ОДИН КЛИП (Ф5б): разгон + цикл + остановка.
 *
 * Почему одним клипом, а не тремя. Шов авторится ОДИН раз и не зависит от длительности кроссфейда;
 * библиотека втрое короче; и главное — старт и остановка гарантированно совпадают по фазе ноги с
 * циклом, потому что лежат с ним в одном файле. При трёх отдельных клипах это приходится ловить
 * кроссфейдом заново на каждой паре, и промах виден именно на стыке, где и так тяжелее всего.
 *
 * Границы помечаются метками `loop_start` / `loop_end` — та же модель, что у Montage Sections в
 * Unreal: разметка ВНУТРИ клипа, а не резка на файлы.
 *
 * ⚠ Шов между секциями — СТЫК, а не кроссфейд, и это правильно: разгон авторится непрерывным
 * продолжением цикла. Требование к паку: он должен быть записан именно так. Не сошлось — остаются
 * три клипа, граф это умеет.
 */
export function stitchLocoClip(start: Clip | null, loop: Clip, stop: Clip | null, name = loop.name): Clip {
  const keys: Keyframe[] = [];
  let t = 0;
  const push = (c: Clip, mark?: MarkType): void => {
    const d = clipDur(c);
    c.keys.forEach((k, i) => {
      const kf: Keyframe = { ...k, t: +(t + k.t).toFixed(4), pose: { ...k.pose } };
      if (mark && i === 0) kf.marks = [...(k.marks ?? []), { type: mark }];
      keys.push(kf);
    });
    t += d;
  };
  if (start && start.keys.length) push(start);
  // Метку начала цикла вешаем на ПЕРВЫЙ кадр цикла, конца — на первый кадр остановки: так границы
  // читаются одинаково и когда разгона нет, и когда нет остановки.
  push(loop, 'loop_start');
  if (stop && stop.keys.length) push(stop, 'loop_end');
  return { ...loop, name, keys, loop: false };
}
