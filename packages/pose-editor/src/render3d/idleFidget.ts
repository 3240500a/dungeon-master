/**
 * ⭐⭐ РЕДКИЕ ВСТАВКИ В ПОКОЙ («idle break»): планировщик и огибающая.
 *
 * ЧТО ЭТО. Персонаж стоит и ничего не делает — раз в полминуты он переступает, поводит плечом или
 * крутит мечом, и возвращается в основную стойку. В Unity это состояние с `Exit Time` и рандом-переходом,
 * в Unreal — `Random Sequence Player` с «Chance to Play»; у нас — ВРЕМЕННАЯ ПОДМЕНА БАЗЫ СТОЙКИ с весом.
 *
 * ⚠⚠ ПОЧЕМУ НЕ ЧЕРЕЗ СЛОТ ДЕЙСТВИЯ (как удар), хотя он рядом и «уже всё умеет» — ЗАМЕР:
 *   • маска слота НЕ СОДЕРЖИТ `Neck`/`Head`: фиджет сдвинул бы руку на 95.0°, а голову на 0.3° — то есть
 *     отыграл бы корпусом и МОЛЧА ПОТЕРЯЛ ровно то, чем живой айдл и живёт (голова у него 21–56°);
 *   • ветка поворота на месте выходит на любом непустом слоте: за 5 с с прицелом на +90° клип поворота
 *     играет 28 кадров при свободном слоте и 0 кадров при занятом. Фиджет 7.1 с = 426 кадров без
 *     поворотов, самый длинный тейк 15.8 с = 948.
 * Здесь слот не трогается ВООБЩЕ, поэтому повороты работают как работали, а начало поворота гасит
 * вставку (условие покоя) — игровой отклик выше косметики.
 *
 * ⚠ И НЕ ЧЕРЕЗ РОТАЦИЮ РОЛИ СТОЙКИ: роль — это ЦИКЛ, а просили «редко, один раз и назад»; однократность
 * в понятие роли не выражается ничем, а ждать шва цикла стоит до полной длины тейка (до 15.8 с).
 * Форму данных (список в `pe_anim`) от той идеи берём, проигрывание — нет.
 *
 * Модуль ЧИСТЫЙ: ни Three, ни DOM, ни localStorage — тестируется в node и общий у игры и редактора.
 */
import type { FidgetCfg, IdleBreakCfg } from './animConfig.js';

/** Состояние планировщика одной куклы. */
export interface FidgetState {
  /** Играющая вставка (null — покой основной стойки). */
  clip: string | null;
  /** Она подменяет БАЗУ или это поза С ПРЕДМЕТОМ. */
  scope: 'base' | 'item';
  /** Время внутри вставки (сек). */
  t: number;
  /** Вес огибающей 0..1 — им и гасится стык, инерциализации в проекте нет. */
  w: number;
  /** Длительность играющей вставки (сек). */
  dur: number;
  /** Кроссфейд играющей вставки (сек). */
  blend: number;
  /** Сколько подряд стоим спокойно (сек). */
  calmFor: number;
  /** Сколько осталось ждать до следующей вставки (сек). Отсчёт — ОТ КОНЦА предыдущей. */
  wait: number;
  /** Гасим ли текущую досрочно (потеряли покой). */
  fading: boolean;
  /** Свой генератор на куклу. */
  rnd: () => number;
}

/**
 * mulberry32 — маленький детерминированный ГПСЧ. Сид берётся ОТ ТОЧКИ СПАВНА, как и фаза дыхания
 * (`PosePlayer.setIdlePhase`): то же место даёт то же расписание, значит кадр воспроизводим и сторожа не
 * начинают мигать. Своего `Math.random` у куклы нет НАРОЧНО.
 */
export function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return (): number => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Начальное состояние. `phase0` — собственная фаза этой куклы (сек), та же, что у дыхания: без неё стая,
 * заспавненная одним тиком, выдала бы ПЕРВУЮ вставку в одном окне. ЗАМЕР со слагаемым: из 12 кукол в окно
 * 0.5 с стартуют не больше 3.
 */
export function makeFidgetState(seed: number, phase0 = 0): FidgetState {
  const rnd = mulberry32(seed);
  return { clip: null, scope: 'base', t: 0, w: 0, dur: 0, blend: 0, calmFor: 0, wait: phase0, fading: false, rnd };
}

/** Выбор по весам («Chance to Play»). Пустой пул — null. */
export function pickFidget(pool: readonly FidgetCfg[], r: number): FidgetCfg | null {
  let sum = 0;
  for (const f of pool) sum += Math.max(0, f.weight);
  if (sum <= 0) return null;
  let x = Math.min(0.999999, Math.max(0, r)) * sum;
  for (const f of pool) { x -= Math.max(0, f.weight); if (x < 0) return f; }
  return pool[pool.length - 1] ?? null;
}

/**
 * Огибающая: нарастание за `blend`, держание, спад за `blend` к концу клипа. Непрерывна по построению,
 * поэтому щелчка на входе и выходе нет. ЗАМЕР на реальных клипах: разрыв поз на стыке 6.4° даёт
 * 6.4 °/кадр без кроссфейда и 1.10 / 0.96 / 0.98 °/кадр при 0.12 / 0.20 / 0.30 с — при проектном пороге
 * 10 °/кадр. Для несинканных концов: разрыв 45° → 7.0 / 4.6 / 3.3 °/кадр.
 */
const envelope = (t: number, dur: number, blend: number): number => {
  if (dur <= 0) return 0;
  if (blend <= 1e-4) return t < dur ? 1 : 0;
  return Math.max(0, Math.min(1, t / blend, (dur - t) / blend));
};

/**
 * Шаг планировщика. `calm` — «стоим и ничего не делаем» (считается вызывающим по его защёлкам).
 * `durOf` — длительность клипа по имени; 0 или меньше = клипа нет, вставка не запускается.
 *
 * ⚠ ПАУЗА ОТСЧИТЫВАЕТСЯ ОТ КОНЦА ПРЕДЫДУЩЕЙ, а не от начала: иначе тейк 15.8 с съедал бы половину паузы
 * и самая длинная вставка оказалась бы самой частой.
 */
export function stepIdleBreak(
  st: FidgetState, dt: number, calm: boolean, cfg: IdleBreakCfg,
  pool: readonly FidgetCfg[], durOf: (clip: string) => number,
): void {
  if (!(dt > 0)) return;
  if (!calm) {
    st.calmFor = 0;
    if (st.clip) st.fading = true;                          // покой потерян — гасим, но не рвём кадром
  } else st.calmFor += dt;

  if (st.clip) {
    st.t += dt;
    if (st.fading) {
      // Досрочное гашение идёт ТЕМ ЖЕ временем кроссфейда, что и штатный выход — иначе прерывание
      // щёлкает сильнее, чем обычный конец, и «пошёл» выглядит хуже, чем «доиграл».
      st.w -= dt / Math.max(1e-3, st.blend);
      if (st.w <= 0) { st.w = 0; st.clip = null; st.fading = false; st.wait = nextGap(st, cfg); }
      return;
    }
    st.w = envelope(st.t, st.dur, st.blend);
    if (st.t >= st.dur) { st.clip = null; st.w = 0; st.wait = nextGap(st, cfg); }
    return;
  }

  st.w = 0;
  if (!calm || st.calmFor < cfg.after) return;
  st.wait -= dt;
  if (st.wait > 0) return;
  const pick = pickFidget(pool, st.rnd());
  const dur = pick ? durOf(pick.clip) : 0;
  if (!pick || !(dur > 0)) { st.wait = nextGap(st, cfg); return; }   // нечего играть — просто ждём дальше
  st.clip = pick.clip; st.scope = pick.scope; st.t = 0; st.dur = dur;
  // ⚠ Кроссфейд не длиннее половины клипа: иначе огибающая не успевает выйти на 1 и вставка «не видна».
  st.blend = Math.max(1e-3, Math.min(pick.blend || cfg.blend, dur * 0.5));
  st.w = 0;
}

const nextGap = (st: FidgetState, cfg: IdleBreakCfg): number =>
  cfg.gapMin + st.rnd() * Math.max(0, cfg.gapMax - cfg.gapMin);
