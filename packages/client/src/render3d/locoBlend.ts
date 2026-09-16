/**
 * ПОЛЗУНОК «ПРОЦЕДУРНО ↔ КЛИП» (Ф4) — выбор клипа и фаза для него. Чистая часть, без сцены.
 *
 * ГЛАВНОЕ РЕШЕНИЕ ФАЗЫ: клип сэмплируется НЕ своим таймером, а фазой планировщика. Планировщик
 * остаётся часами и опорой даже на единице ползунка, и из этого следуют обе вещи, ради которых всё
 * затевалось:
 *  • стопы не скользят — планты по-прежнему ставит он, клип лишь придаёт форму;
 *  • настройки персонажа (длина шага, доля опоры, каденция) ПЕРЕТАЙМЛИВАЮТ чужой клип. Это и есть
 *    «из двух купленных паков неограниченное число вариантов»: свой таймер у клипа сделал бы его
 *    неизменяемым, и ползунки перестали бы на него влиять.
 *
 * Фаза планировщика — π на шаг, значит 2π на полный цикл (левая + правая). Клип локомоции авторится
 * ровно на цикл, поэтому `u = (фаза mod 2π) / 2π`.
 */

/** Четыре направления вместо восьми — решение Ф0: диагонали закрывает доворот таза. */
export type LocoDir = 'fwd' | 'back' | 'strafe_L' | 'strafe_R';

/** Фаза планировщика (рад, π на шаг) → нормализованное время клипа 0..1. */
export function locoPhaseU(phase: number): number {
  const TAU = Math.PI * 2;
  let u = phase % TAU;
  if (u < 0) u += TAU;
  return u / TAU;
}

/**
 * Направление по движению В КАДРЕ ТЕЛА. Складка к ближайшей оси — та же, что у доворота таза:
 * ход спиной это шаг назад, а не разворот. Порог страйфа берётся снаружи (`GAIT.strafeFrom/To`),
 * чтобы у клипов и у страйф-колонки настроек была ОДНА граница, а не две расходящиеся.
 */
export function locoDir(fwd: number, lat: number, strafeDeg: number): LocoDir {
  const ang = Math.atan2(Math.abs(lat), Math.abs(fwd)) * 180 / Math.PI;
  if (ang >= strafeDeg) return lat >= 0 ? 'strafe_R' : 'strafe_L';
  return fwd >= 0 ? 'fwd' : 'back';
}

/**
 * Имя клипа по конвенции из плана: `walk_fwd` / `run_strafe_L` и так далее.
 *
 * Конвенция, а не жёсткая привязка: узел графа может указать на любой клип (Ф1.2), а это — умолчание,
 * с которого всё работает без единой записи в конфиге.
 */
export function locoClipName(dir: LocoDir, fast: boolean): string {
  return `${fast ? 'run' : 'walk'}_${dir}`;
}

/**
 * ⭐⭐ ВСЁ, ЧТО ДВИЖОК МОЖЕТ СПРОСИТЬ: четыре направления × ходьба/бег. Ровно эти имена и обязан
 * покрывать набор запекания — иначе запечёшь клипы, которых никто не читает, и наоборот.
 *
 * ⚠ Этот список — ЕДИНСТВЕННАЯ правда о составе набора. Он же кормит сторожа расхождения
 * (`locoSet.test.ts`) и список запекания в редакторе, поэтому «добавил направление» = одна правка.
 */
export const LOCO_DIRS: readonly LocoDir[] = ['fwd', 'back', 'strafe_L', 'strafe_R'];
export const LOCO_NAMES: readonly string[] =
  [false, true].flatMap((fast) => LOCO_DIRS.map((d) => locoClipName(d, fast)));

/**
 * Имена-кандидаты при ПОИСКЕ: нынешняя конвенция, затем историческая.
 *
 * ⚠ Историческое имя страйфа — без префикса скорости (`strafe_L`): запекатель делал ОДИН страйф на
 * сторону, и он подходит обеим скоростям — другого у автора всё равно нет. Смена конвенции не должна
 * обнулять уже запечённое (та же логика, что у имён стоек: `stanceNameCandidates`).
 */
export function locoClipNames(dir: LocoDir, fast: boolean): string[] {
  const out = [locoClipName(dir, fast)];
  if (dir === 'strafe_L' || dir === 'strafe_R') out.push(dir);
  return out;
}

/**
 * ⭐⭐ НАБОР ЛОКОМОЦИИ — ОДИН НА ВСЕ ОРУЖИЯ, С ВОЗМОЖНОСТЬЮ ПЕРЕКРЫТЬ ЕГО ПООРУЖНО.
 *
 * Порядок: точный набор ЭТОГО оружия → безоружный (`none`) → любой, что есть. Так «запёк без оружия»
 * работает везде, а «запёк отдельно под двуручник» бьёт базу — ровно как у стоек предметов.
 *
 * ⚠ РАНЬШЕ ОРУЖИЕ НЕ УЧАСТВОВАЛО ВОВСЕ: поиск шёл по имени и персонажу, и `find` отдавал ПЕРВЫЙ
 * подходящий клип — то есть набор был не «общий» и не «пооружный», а «какой раньше лёг в массив».
 */
export function findLocoClip<T extends { name: string; character?: string; weapon?: string }>(
  clips: readonly T[], name: string, character: string, weapon: string,
): T | null {
  let exact: T | null = null, base: T | null = null, any: T | null = null;
  for (const c of clips) {
    if (c.name !== name || c.character !== character) continue;
    if (c.weapon === weapon) { exact = c; break; }              // точнее уже не будет — выходим
    if (c.weapon === 'none') base ??= c;
    any ??= c;
  }
  return exact ?? base ?? any;
}

// ── СЕКЦИИ: старт → цикл → остановка (Ф5б) ───────────────────────────────────────────────────────

/** Что именно играет слой локомоции прямо сейчас. */
export type LocoSection = 'start' | 'loop' | 'stop' | 'idle';

export interface LocoSectionState {
  section: LocoSection;
  /** Собственное время секции (сек). У цикла его нет — им правит фаза планировщика. */
  t: number;
}

/**
 * Шаг машины секций. Чистая: ей дают состояние, «двигаемся ли», dt и границы — она возвращает новое.
 *
 * ⚠ РАЗГОН И ОСТАНОВКА ИДУТ ПО СВОЕМУ ВРЕМЕНИ, а цикл — по фазе планировщика, и это не
 * непоследовательность. У разгона нет «фазы шага»: он и есть выход на неё из нуля, и привязать его к
 * фазе значило бы растянуть или сжать его до неузнаваемости на каждой скорости. У цикла наоборот:
 * своё время сделало бы его неперетаймливаемым, и настройки персонажа перестали бы на него влиять.
 *
 * Возврат из остановки сразу в разгон (передумал на полпути) намеренно НЕ делается: доигрывать нечего,
 * персонаж уже поехал — уходим в разгон с нуля, это честнее, чем прыгнуть в середину цикла.
 */
export interface SectionBounds { loopStart: number; loopEnd: number; dur: number; hasStart: boolean; hasStop: boolean }

export function stepLocoSection(st: LocoSectionState, moving: boolean, dt: number, sec: SectionBounds): LocoSectionState {
  const t = st.t + dt;
  if (moving) {
    switch (st.section) {
      case 'loop': return { section: 'loop', t: 0 };
      case 'start': return t >= sec.loopStart ? { section: 'loop', t: 0 } : { section: 'start', t };
      // Из покоя и из остановки — на разгон с нуля. Возврат из остановки в середину цикла намеренно
      // НЕ делается: доигрывать там нечего, а прыжок в середину читается как рывок.
      default: return sec.hasStart ? { section: 'start', t: 0 } : { section: 'loop', t: 0 };
    }
  }
  switch (st.section) {
    case 'loop': return sec.hasStop ? { section: 'stop', t: 0 } : { section: 'idle', t: 0 };
    case 'stop': return t >= Math.max(0, sec.dur - sec.loopEnd) ? { section: 'idle', t: 0 } : { section: 'stop', t };
    case 'start': return { section: 'idle', t: 0 };   // отпустили на разгоне — доигрывать нечего
    default: return { section: 'idle', t: 0 };
  }
}

/**
 * Время внутри клипа для текущей секции (сек).
 *
 * Цикл берёт фазу планировщика (см. `locoPhaseU`) и растягивается ровно на секцию цикла, разгон и
 * остановка — своё время, обрезанное по границам секции.
 */
export function sectionClipTime(st: LocoSectionState, plannerU: number, sec: { loopStart: number; loopEnd: number }, dur: number): number {
  if (st.section === 'start') return Math.min(st.t, sec.loopStart);
  if (st.section === 'stop') return Math.min(sec.loopEnd + st.t, dur);
  return sec.loopStart + plannerU * Math.max(0, sec.loopEnd - sec.loopStart);
}
