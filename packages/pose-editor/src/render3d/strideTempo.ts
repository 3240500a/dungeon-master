import * as THREE from 'three';
import { buildHumanoid, type Humanoid } from './humanoid.js';
import { clipPoseAt, clipDur, clipSections, type Clip, type TempoRef } from './clipModel.js';
import { bakedLocoSpeed, LOCO_NAMES, LOCO_DIAG_NAMES } from './locoBlend.js';

/**
 * ⭐⭐ ТЕМП ЦИКЛА ПО ШАГУ (06.10).
 *
 * Жалоба владельца: укоротил шаг бега вперёд — «вперёд надо чуть быстрее, чтобы анимация игралась». Часы «только
 * клипы» крутят цикл по СКОРОСТИ СЪЁМА (`cycle = bakeSpeed × период`), а правка ключей её не трогает; у этого клипа её
 * не было вовсе (копия теряла поле) — шли легаси 102. Шаг короче, темп прежний → опорная стопа едет вперёд. ЗАМЕР в
 * Unity: 20–45 % скорости героя.
 *
 * ПРАВИЛО: **нетронутый клип — темп бит-в-бит как был; правленый — во столько же раз, во сколько изменился шаг.**
 * Шаг меряется на ОДНОЙ И ТОЙ ЖЕ стандартной кукле и до, и после правки, поэтому пропорции куклы против модели
 * сокращаются. ⚠ Абсолютное число с куклы для темпа НЕ годится: ноги куклы не как у рыцаря, и мокап-бег (121.1)
 * она «видит» как 90 — а в игре он не скользит. Годится только ОТНОШЕНИЕ.
 *
 * Шаг = средняя скорость опорной стопы назад по оси хода в кадре персонажа (u/с времени клипа). У клипа на месте
 * корень едет ровно со скоростью хода, и стопа на земле обязана уходить назад с ней же — это и есть темп, при
 * котором она стоит. Среднее по касанию = наименьшие квадраты проскальзывания.
 */

/** Ревизия замера. Сменишь метод — подними: `syncClipTempo` пересоберёт точки отсчёта, СОХРАНИВ нынешний темп. */
export const STRIDE_REV = 1;
const N = 120;                       // сэмплов на цикл
const CONTACT_BAND = 0.25;           // касание: ниже четверти размаха высоты стопы
const MIN_CONTACT = 0.05;            // меньше 5 % цикла на земле — опоры нет, мерить нечего
const SAME = 0.01;                   // шаг изменился меньше чем на 1 % — считаем нетронутым (шум сериализации)
const MIN_RATIO = 0.4, MAX_RATIO = 2.5;

/** Клипы, темп которых читают часы: колонки набора (`LOCO_NAMES`), диагонали и исторические страйфы без префикса. */
export const TEMPO_NAMES: ReadonlySet<string> = new Set([...LOCO_NAMES, ...LOCO_DIAG_NAMES, 'strafe_L', 'strafe_R']);

let doll: Humanoid | null = null;
let hipsRest: THREE.Vector3 | null = null;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3();
const cache = new Map<string, number | null>();

/** Стандартная кукла замера — одна на процесс: замер обязан зависеть только от клипа. */
function dollOf(): Humanoid {
  if (!doll) { doll = buildHumanoid({}); hipsRest = doll.bones.get('Hips')!.position.clone(); }
  return doll;
}

/**
 * Шаг клипа (u/с времени клипа) — скорость опорной стопы назад на стандартной кукле, по секции цикла. null — опору
 * не найти (стопа не касается земли, клип короче 0.05 с).
 */
export function measureStride(c: Clip): number | null {
  const sc = clipSections(c), dur = clipDur(c) || 1;
  const a = sc.loopStart, span = (sc.loopEnd - sc.loopStart) || dur;
  if (!(span > 0.05)) return null;
  const sig = `${a}|${span}|${JSON.stringify(c.keys)}`;
  if (cache.has(sig)) return cache.get(sig)!;
  const h = dollOf(), hips = h.bones.get('Hips')!;
  const px: number[][] = [[], []], pz: number[][] = [[], []], py: number[][] = [[], []];
  for (let i = 0; i < N; i++) {
    const pose = clipPoseAt(c, (a + span * i / N) / dur);
    h.reset();
    for (const nm in pose) {
      if (nm[0] === '_') continue;
      const b = h.bones.get(nm), r = pose[nm];
      if (b && r) b.rotation.set(r[0]!, r[1]!, r[2]!);
    }
    const d = (pose as Record<string, number[] | undefined>)['__hipsD'];
    hips.position.copy(hipsRest!);
    if (d) hips.position.add(_d.set(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0));
    h.root.updateMatrixWorld(true);
    ['Left', 'Right'].forEach((s, f) => {
      h.bones.get(s + 'Foot')!.getWorldPosition(_v);
      const toe = h.bones.get(s + 'Toes');
      const y = toe ? Math.min(_v.y, toe.getWorldPosition(_w).y) : _v.y;
      px[f]!.push(_v.x); pz[f]!.push(_v.z); py[f]!.push(y);
    });
  }
  // Ось хода — главная ось горизонтального пути обеих стоп.
  let mx = 0, mz = 0;
  for (let f = 0; f < 2; f++) for (let i = 0; i < N; i++) { mx += px[f]![i]!; mz += pz[f]![i]!; }
  mx /= 2 * N; mz /= 2 * N;
  let sxx = 0, szz = 0, sxz = 0;
  for (let f = 0; f < 2; f++) for (let i = 0; i < N; i++) {
    const dx = px[f]![i]! - mx, dz = pz[f]![i]! - mz;
    sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
  }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz), ax = Math.cos(ang), az = Math.sin(ang);
  const dt = span / N;
  let sum = 0, cnt = 0;
  for (let f = 0; f < 2; f++) {
    const X = px[f]!, Z = pz[f]!, Y = py[f]!;
    const v = X.map((x, i) => (((X[(i + 1) % N]! - x) * ax + (Z[(i + 1) % N]! - Z[i]!) * az)) / dt);
    let lo = Infinity, hi = -Infinity;
    for (const y of Y) { if (y < lo) lo = y; if (y > hi) hi = y; }
    const thr = lo + CONTACT_BAND * (hi - lo);
    // Куда стопа едет, пока она внизу, — туда и «назад» (знак оси PCA произволен).
    let low = 0;
    for (let i = 0; i < N; i++) if (Y[i]! <= thr) low += v[i]!;
    const sg = Math.sign(low);
    if (sg === 0) return remember(sig, null);
    let s = 0, n = 0;
    for (let i = 0; i < N; i++) if (Y[i]! <= thr && v[i]! * sg > 0) { s += v[i]! * sg; n++; }
    if (n < MIN_CONTACT * N) return remember(sig, null);
    sum += s; cnt += n;
  }
  return remember(sig, cnt ? sum / cnt : null);
}

function remember(sig: string, v: number | null): number | null {
  if (cache.size > 400) cache.clear();
  cache.set(sig, v);
  return v;
}

const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const keyOf = (c: Clip): string => `${c.name}|${c.character}|${c.weapon}`;

/**
 * Донор точки отсчёта для клипа БЕЗ скорости съёма: одноимённый клип другого персонажа/оружия, у которого она есть.
 * Сначала то же оружие, потом ближайший по длине цикла, при равенстве — первый в библиотеке.
 */
function donorOf(lib: readonly Clip[], c: Clip): Clip | null {
  const spanOf = (x: Clip): number => { const s = clipSections(x); return (s.loopEnd - s.loopStart) || clipDur(x); };
  const sp = spanOf(c);
  let best: Clip | null = null, bestScore = Infinity;
  for (const d of lib) {
    if (d === c || d.name !== c.name || !posNum(d.bakeSpeed)) continue;
    if (d.character === c.character && d.weapon === c.weapon) continue;
    const score = (d.weapon === c.weapon ? 0 : 1000) + Math.abs(spanOf(d) - sp);
    if (score < bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Точка отсчёта под нынешний метод, СОХРАНЯЯ нынешний темп (смена ревизии замера не должна сдвигать игру). */
function rebase(ref: TempoRef, c: Clip, m: number | null): TempoRef {
  if (!m) return { ...ref, rev: STRIDE_REV };
  const cur = posNum(c.tempoSpeed) ? c.tempoSpeed : ref.speed;
  return { ...ref, stride: round3(m * ref.speed / cur), rev: STRIDE_REV };
}

/**
 * ⭐⭐ ПРИВЕСТИ ТЕМП КЛИПОВ ХОДА К ИХ ШАГУ — один шов на все пути правки (вызывает `saveLib` редактора и старт).
 * Ставит `tempoRef` (точку отсчёта) там, где её нет, и `tempoSpeed` там, где шаг изменился. Нетронутый клип с
 * `bakeSpeed` получает только `tempoRef`, без `tempoSpeed` — часы читают ровно `bakeSpeed`. Возвращает ключи
 * изменённых клипов (пусто — менять нечего).
 */
export function syncClipTempo(lib: Clip[]): string[] {
  const changed: string[] = [];
  for (const c of lib) {
    if (!TEMPO_NAMES.has(c.name)) continue;
    const before = JSON.stringify([c.tempoRef ?? null, c.tempoSpeed ?? null]);
    const m = measureStride(c);
    let ref = c.tempoRef;
    if (posNum(c.bakeSpeed)) {
      // Съём (или ПЕРЕсъём: скорость другая) — точка отсчёта заново: свежий клип верен по построению.
      if (!ref || ref.speed !== c.bakeSpeed) { ref = m ? { speed: c.bakeSpeed, stride: round3(m), rev: STRIDE_REV } : undefined; delete c.tempoSpeed; }
      else if (ref.rev !== STRIDE_REV) ref = rebase(ref, c, m);
    } else if (!ref) {
      const d = donorOf(lib, c), dm = d ? measureStride(d) : null;
      if (d && dm) ref = { speed: d.bakeSpeed!, stride: round3(dm), rev: STRIDE_REV, from: d.character };
    } else if (ref.rev !== STRIDE_REV) ref = rebase(ref, c, m);
    if (ref) c.tempoRef = ref; else delete c.tempoRef;
    let tempo: number | undefined;
    if (ref) {
      let r = m ? m / ref.stride : 1;
      if (Math.abs(r - 1) < SAME) r = 1;
      if (r < MIN_RATIO || r > MAX_RATIO) { console.warn(`[темп по шагу] ${keyOf(c)}: шаг ×${r.toFixed(2)} к отсчёту — вне ${MIN_RATIO}…${MAX_RATIO}, темп не трогаю`); r = 1; }
      const t = round3(ref.speed * r);
      tempo = Math.abs(t - bakedLocoSpeed(c)) < 1e-6 ? undefined : t;
    }
    if (tempo !== undefined) c.tempoSpeed = tempo; else delete c.tempoSpeed;
    if (JSON.stringify([c.tempoRef ?? null, c.tempoSpeed ?? null]) !== before) changed.push(keyOf(c));
  }
  return changed;
}

/** Подпись для редактора: «темп по шагу 85 · шаг 70 %» (null — темп не менялся). */
export function tempoNote(c: Clip, nameOf: (character: string) => string = (id) => id): string | null {
  if (!posNum(c.tempoSpeed) || !c.tempoRef) return null;
  const m = measureStride(c);
  const pct = m ? Math.round(100 * m / c.tempoRef.stride) : null;
  return `темп по шагу ${Math.round(c.tempoSpeed)}${pct !== null ? ` · шаг ${pct} %` : ''}${c.tempoRef.from ? ` · от «${nameOf(c.tempoRef.from)}» ${Math.round(c.tempoRef.speed)}` : ''}`;
}
