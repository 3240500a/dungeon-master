/**
 * ⭐⭐ ТАБЛИЦА «ТЕЙК МОКАПА → НАШ КЛИП» для набора Kubold Movement Animset Pro.
 *
 * Зачем таблица в КОДЕ, а не в голове: пакет — 195 тейков в 7 файлах, из них движку нужны 15 имён
 * (`locoSetAudit.REQUIRED_NAMES`). Переносить их поштучно — 15 × шесть кликов, и каждый раз заново
 * вспоминать, какой тейк цикличный, какой несёт поворот и какой брать НЕЛЬЗЯ. Таблица делает из этого
 * один проход, а причины живут рядом с данными, а не в переписке.
 *
 * Модуль ЧИСТЫЙ (данные + разбор имён, без THREE и DOM) — тестируется в node.
 *
 * ⚠⚠ ЧЕТЫРЕ «ПОВОРОТА НА МЕСТЕ» У KUBOLD НЕ ПОВОРАЧИВАЮТ, И ЭТО ЗАМЕР, А НЕ ДОГАДКА.
 * `TurnLt90_Loop` / `TurnRt90_Loop` / `TurnLt180` / `TurnRt180` начинаются и заканчиваются на ОДНОМ курсе:
 * через наш импортёр `__rootY` в конце 0.0° (размах по клипу 13–47° — это раскачка таза, а не поворот),
 * Root не крутится вовсе. Так они и задуманы: тейк «loopable rotation in place» ОБЯЗАН возвращаться в свою
 * позу, чтобы зацикливаться, а сам угол накладывает КОД (та же идея, что у их же `*_Lean*`: «the root
 * however is moving just forward… you want to apply the rotation by code»).
 * А наш `turnInPlace` устроен наоборот и намеренно: «таз поворачивается ПО КРИВОЙ ИЗ КЛИПА — ровно так, как
 * в нём переступают ноги, поэтому стопы и таз не могут разойтись». Клип без `__rootY` дал бы переступающие
 * на месте ноги и НЕ поворачивающегося персонажа — молча. Поэтому повороты в пакетный перенос не идут;
 * наши запечённые `turn_*` остаются на месте. Для сравнения: `RunFwdTurn180_L_LU` поворот НЕСЁТ (182.0°) —
 * значит дело не в файле и не в нашем съёме рыска.
 *
 * ⚠⚠ ПОВОРОТ В ПАКЕТЕ ПОЧТИ НИГДЕ НЕ ЛЕЖИТ: дорожка `Root.quaternion` есть РОВНО У 7 ТЕЙКОВ ИЗ 66, и у стартов
 * с доворотом значения несовместимы с именами — `WalkFwdStart180_L` несёт 33°, `WalkFwdStart180_R` −146°,
 * `WalkFwdStart135_R` −1°, `RunFwdStart90_R` и все четыре `*ArchLoop*` — ноль. То есть угол у Kubold накладывает
 * КОНТРОЛЛЕР, а анимация даёт только отклик тела. Поэтому `rootYaw` в таблице стоит ТОЛЬКО там, где поворот
 * замерен целиком (`RunFwdTurn180_L_LU`, 177°): снять частичный рыск было бы ХУЖЕ, чем не снимать, —
 * `pelvisPoseToChar` вычел бы из таза эти 33° и испортил саму позу.
 * (Наш съём рыска при этом верен: где дорожка есть, `__rootY` совпадает с ней в пределах 2–3°.)
 *
 * ЗАМЕРЕННЫЕ СКОРОСТИ ПАКЕТА (наши юниты, `TILE = 32 u = 1 м`; через наш ретаргет ±1 %):
 *   ходьба во все четыре стороны и все диагонали — 55.2 u/с (1.72 м/с); наш `walk_fwd` снят на 40;
 *   бег вперёд и диагонали 45° — 120.1 (3.75) — это РОВНО наш `LOCO_BAKE_RUN_SPD`;
 *   бег назад 73.4, бег боком 71.8 / 75.1, диагонали 135° — 73.4;
 *   спринт 205.1 (6.41) — почти наш рывок 200.
 */

/** Один перенос: откуда берём и во что превращаем. */
export interface MocapTake {
  /** Имя тейка внутри FBX (селект «анимация» в панели импорта). */
  take: string;
  /** Имя клипа в НАШЕЙ конвенции. */
  clip: string;
  /** Цикл. Он же решает, писать ли `bakeSpeed`: темп есть только у цикла. */
  cyclic: boolean;
  /** Поворот персонажа лежит В КЛИПЕ → снимать его в канал `__rootY`. */
  rootYaw?: boolean;
  /** Обрезка по исходнику ДОЛЯМИ длительности (0..1). */
  trim?: readonly [number, number];
  /** Имя спрашивает движок (`REQUIRED_NAMES`) — такие переносятся первой кнопкой. */
  core?: boolean;
  /** Непустое — брать НЕЛЬЗЯ, и здесь сказано почему (панель показывает причину, кнопка тейк пропускает). */
  blocked?: string;
  /** Зачем он нам — печатается в списке переноса. */
  note: string;
}

const TURN_BLOCKED = 'тейк не поворачивает: `__rootY` в конце 0.0° (замер), угол Kubold отдаёт коду — наш `turnInPlace` берёт его ИЗ клипа';

/** Ход по четырём сторонам + стойка — то, что движок спрашивает по имени. */
const CORE: readonly MocapTake[] = [
  { take: 'Idle', clip: 'idle', cyclic: true, core: true, note: 'живой айдл 6.7 с — у нас сейчас 2 ключа, персонаж стоит бит-в-бит неподвижно' },
  { take: 'WalkFwdLoop', clip: 'walk_fwd', cyclic: true, core: true, note: 'ходьба вперёд, 55.2 u/с' },
  { take: 'WalkBwdLoop', clip: 'walk_back', cyclic: true, core: true, note: 'ходьба назад, 55.2 (файл Additionals)' },
  { take: 'StrafeLeftLoop', clip: 'walk_strafe_L', cyclic: true, core: true, note: 'ходьба боком влево, 55.2 (Additionals)' },
  { take: 'StrafeRightLoop', clip: 'walk_strafe_R', cyclic: true, core: true, note: 'ходьба боком вправо, 55.2 (Additionals)' },
  { take: 'RunFwdLoop', clip: 'run_fwd', cyclic: true, core: true, note: 'бег вперёд, 120.1 u/с — ровно наша скорость съёма' },
  { take: 'RunBwdLoop', clip: 'run_back', cyclic: true, core: true, note: 'бег назад, 73.4 (RunStrafeUpdate)' },
  { take: 'RunLtLoop', clip: 'run_strafe_L', cyclic: true, core: true, note: 'бег боком влево, 71.8 (RunStrafeUpdate)' },
  { take: 'RunRtLoop', clip: 'run_strafe_R', cyclic: true, core: true, note: 'бег боком вправо, 75.1 (RunStrafeUpdate)' },
  // Повороты: имена движок спрашивает, но переносить эти тейки нельзя — см. шапку.
  { take: 'TurnLt90_Loop', clip: 'turn_L_90', cyclic: false, core: true, blocked: TURN_BLOCKED, note: 'поворот влево 90°' },
  { take: 'TurnRt90_Loop', clip: 'turn_R_90', cyclic: false, core: true, blocked: TURN_BLOCKED, note: 'поворот вправо 90°' },
  { take: 'TurnLt180', clip: 'turn_L_180', cyclic: false, core: true, blocked: TURN_BLOCKED, note: 'поворот влево 180°' },
  { take: 'TurnRt180', clip: 'turn_R_180', cyclic: false, core: true, blocked: TURN_BLOCKED, note: 'поворот вправо 180°' },
  { take: 'TurnLt90_Loop', clip: 'turn_L_45', cyclic: false, trim: [0, 0.5], core: true, blocked: TURN_BLOCKED + '; плюс 45° в пакете нет вовсе — это половина цикла 90°', note: 'поворот влево 45°' },
  { take: 'TurnRt90_Loop', clip: 'turn_R_45', cyclic: false, trim: [0, 0.5], core: true, blocked: TURN_BLOCKED + '; плюс 45° в пакете нет вовсе — это половина цикла 90°', note: 'поворот вправо 45°' },
];

/**
 * ДОПОЛНИТЕЛЬНОЕ СОДЕРЖИМОЕ. Имена все с приставкой `mocap_` — НАМЕРЕННО, по двум причинам:
 * 1. рантайм их пока не читает вовсе (машина секций старт/остановка написана, но меток никто не ставит;
 *    колонок 45°/135° в бленде нет) — приставка не даёт принять содержимое за работающую механику;
 * 2. `locoSetAudit.isGait` считает клипом ХОДА всё, что начинается на `walk_`/`run_`, и без приставки
 *    двадцать этих клипов встали бы в панель покрытия ложными дефектами `stale_speed`.
 * Появится машина — переименовать по одному клику каждый.
 */
const EXTRA: readonly MocapTake[] = [
  // Остановки ПО ОПОРНОЙ НОГЕ — то, чем лечится замеренный прокат 10.71 / 15.74 ед («рампой торможения НЕ лечится»).
  { take: 'WalkFwdStop_LU', clip: 'mocap_walk_fwd_stop_L', cyclic: false, note: 'остановка ходьбы, левая нога поднята' },
  { take: 'WalkFwdStop_RU', clip: 'mocap_walk_fwd_stop_R', cyclic: false, note: 'остановка ходьбы, правая поднята' },
  { take: 'RunFwdStop_LU', clip: 'mocap_run_fwd_stop_L', cyclic: false, note: 'остановка бега, левая поднята' },
  { take: 'RunFwdStop_RU', clip: 'mocap_run_fwd_stop_R', cyclic: false, note: 'остановка бега, правая поднята' },
  { take: 'WalkBwdStop_LU', clip: 'mocap_walk_back_stop_L', cyclic: false, note: 'остановка ходьбы назад, левая' },
  { take: 'WalkBwdStop_RU', clip: 'mocap_walk_back_stop_R', cyclic: false, note: 'остановка ходьбы назад, правая' },
  { take: 'StrafeLeftStop_LU', clip: 'mocap_walk_strafe_L_stop_L', cyclic: false, note: 'остановка страйфа влево, левая' },
  { take: 'StrafeLeftStop_RU', clip: 'mocap_walk_strafe_L_stop_R', cyclic: false, note: 'остановка страйфа влево, правая' },
  { take: 'StrafeRightStop_LU', clip: 'mocap_walk_strafe_R_stop_L', cyclic: false, note: 'остановка страйфа вправо, левая' },
  { take: 'StrafeRightStop_RU', clip: 'mocap_walk_strafe_R_stop_R', cyclic: false, note: 'остановка страйфа вправо, правая' },
  // Старты с места.
  { take: 'WalkFwdStart', clip: 'mocap_walk_fwd_start', cyclic: false, note: 'старт ходьбы' },
  { take: 'RunFwdStart', clip: 'mocap_run_fwd_start', cyclic: false, note: 'старт бега' },
  { take: 'WalkBwdStart', clip: 'mocap_walk_back_start', cyclic: false, note: 'старт ходьбы назад' },
  { take: 'StrafeLeftStart', clip: 'mocap_walk_strafe_L_start', cyclic: false, note: 'старт страйфа влево' },
  { take: 'StrafeRightStart', clip: 'mocap_walk_strafe_R_start', cyclic: false, note: 'старт страйфа вправо' },
  // Старты С ДОВОРОТОМ — ими закрывается перелёт на 135° (замер: 5.90 ед проката, 1.28 с).
  { take: 'WalkFwdStart90_L', clip: 'mocap_walk_fwd_start_L90', cyclic: false, note: 'старт ходьбы с доворотом 90° влево — угол в тейке НЕ лежит, кладёт код' },
  { take: 'WalkFwdStart90_R', clip: 'mocap_walk_fwd_start_R90', cyclic: false, note: 'старт ходьбы с доворотом 90° вправо — в тейке лежит ЧАСТИЧНЫЙ рыск -18° — имени не соответствует, поэтому не снимаем' },
  { take: 'WalkFwdStart135_L', clip: 'mocap_walk_fwd_start_L135', cyclic: false, note: 'старт ходьбы 135° влево (Additionals) — в тейке лежит ЧАСТИЧНЫЙ рыск 31° — имени не соответствует, поэтому не снимаем' },
  { take: 'WalkFwdStart135_R', clip: 'mocap_walk_fwd_start_R135', cyclic: false, note: 'старт ходьбы 135° вправо (Additionals) — в тейке лежит ЧАСТИЧНЫЙ рыск -1° — имени не соответствует, поэтому не снимаем' },
  { take: 'WalkFwdStart180_L', clip: 'mocap_walk_fwd_start_L180', cyclic: false, note: 'старт ходьбы 180° влево — в тейке лежит ЧАСТИЧНЫЙ рыск 33° — имени не соответствует, поэтому не снимаем' },
  { take: 'WalkFwdStart180_R', clip: 'mocap_walk_fwd_start_R180', cyclic: false, note: 'старт ходьбы 180° вправо — в тейке лежит ЧАСТИЧНЫЙ рыск -146° — имени не соответствует, поэтому не снимаем' },
  { take: 'RunFwdStart90_L', clip: 'mocap_run_fwd_start_L90', cyclic: false, note: 'старт бега с доворотом 90° влево — угол в тейке НЕ лежит, кладёт код' },
  { take: 'RunFwdStart90_R', clip: 'mocap_run_fwd_start_R90', cyclic: false, note: 'старт бега с доворотом 90° вправо — угол в тейке НЕ лежит, кладёт код' },
  { take: 'RunFwdStart135_L', clip: 'mocap_run_fwd_start_L135', cyclic: false, note: 'старт бега 135° влево (Additionals) — угол в тейке НЕ лежит, кладёт код' },
  { take: 'RunFwdStart135_R', clip: 'mocap_run_fwd_start_R135', cyclic: false, note: 'старт бега 135° вправо (Additionals) — угол в тейке НЕ лежит, кладёт код' },
  { take: 'RunFwdStart180_L', clip: 'mocap_run_fwd_start_L180', cyclic: false, note: 'старт бега 180° влево — угол в тейке НЕ лежит, кладёт код' },
  { take: 'RunFwdStart180_R', clip: 'mocap_run_fwd_start_R180', cyclic: false, note: 'старт бега 180° вправо — в тейке лежит ЧАСТИЧНЫЙ рыск -12° — имени не соответствует, поэтому не снимаем' },
  // Развороты НА БЕГУ по опорной ноге — эти поворот НЕСУТ (замер: 182.0°).
  { take: 'RunFwdTurn180_L_LU', clip: 'mocap_run_turn180_L_footL', cyclic: false, rootYaw: true, note: 'разворот на бегу влево, левая нога поднята — ЕДИНСТВЕННЫЙ тейк с полным поворотом (замер 177° в файле, 182° после съёма)' },
  { take: 'RunFwdTurn180_L_RU', clip: 'mocap_run_turn180_L_footR', cyclic: false, note: 'разворот на бегу влево, правая поднята — поворота в тейке НЕТ (дорожки Root.quaternion нет)' },
  { take: 'RunFwdTurn180_R_LU', clip: 'mocap_run_turn180_R_footL', cyclic: false, note: 'разворот на бегу вправо, левая поднята — поворота в тейке НЕТ' },
  { take: 'RunFwdTurn180_R_RU', clip: 'mocap_run_turn180_R_footR', cyclic: false, note: 'разворот на бегу вправо, правая поднята — поворота в тейке НЕТ' },
  // ДИАГОНАЛИ — ими закрывается шов на 47.5° (сегодня до него чистый «вперёд» тазом, после — чистый страйф).
  { take: 'StrafeLeft45Loop', clip: 'mocap_walk_diag_L45', cyclic: true, note: 'ходьба по диагонали 45° влево, 55.2 (Additionals)' },
  { take: 'StrafeLeft135Loop', clip: 'mocap_walk_diag_L135', cyclic: true, note: 'ходьба по диагонали 135° влево, 55.2 (RunStrafeUpdate)' },
  { take: 'StrafeRight45Loop', clip: 'mocap_walk_diag_R45', cyclic: true, note: 'ходьба по диагонали 45° вправо, 55.2 (RunStrafeUpdate)' },
  { take: 'StrafeRight135Loop', clip: 'mocap_walk_diag_R135', cyclic: true, note: 'ходьба по диагонали 135° вправо, 55.2 (Additionals)' },
  { take: 'RunStrafeLeft45Loop', clip: 'mocap_run_diag_L45', cyclic: true, note: 'бег по диагонали 45° влево, 120.1' },
  { take: 'RunStrafeLeft135Loop', clip: 'mocap_run_diag_L135', cyclic: true, note: 'бег по диагонали 135° влево, 73.4' },
  { take: 'RunStrafeRight45Loop', clip: 'mocap_run_diag_R45', cyclic: true, note: 'бег по диагонали 45° вправо, 120.1' },
  { take: 'RunStrafeRight135Loop', clip: 'mocap_run_diag_R135', cyclic: true, note: 'бег по диагонали 135° вправо, 73.4' },
  // Крен и дуга — авторский материал под наш `stepDirWarp` (у крена корень едет ПРЯМО, угол кладёт код).
  { take: 'WalkFwdLoop_LeanL', clip: 'mocap_walk_lean_L', cyclic: true, note: 'ходьба с креном влево, корень едет прямо' },
  { take: 'WalkFwdLoop_LeanR', clip: 'mocap_walk_lean_R', cyclic: true, note: 'ходьба с креном вправо, корень едет прямо' },
  { take: 'RunFwdLoop_LeanL', clip: 'mocap_run_lean_L', cyclic: true, note: 'бег с креном влево, корень едет прямо' },
  { take: 'RunFwdLoop_LeanR', clip: 'mocap_run_lean_R', cyclic: true, note: 'бег с креном вправо, корень едет прямо' },
  { take: 'WalkArchLoop_L', clip: 'mocap_walk_arch_L', cyclic: true, note: 'ходьба по дуге влево: стопы идут по дуге, а КОРПУС курс не меняет (замер: Root 0°) — материал под наш `stepDirWarp`' },
  { take: 'WalkArchLoop_R', clip: 'mocap_walk_arch_R', cyclic: true, note: 'ходьба по дуге вправо, Root 0° — угол кладёт код' },
  { take: 'RunArchLoop_L', clip: 'mocap_run_arch_L', cyclic: true, note: 'бег по дуге влево, Root 0° — угол кладёт код' },
  { take: 'RunArchLoop_R', clip: 'mocap_run_arch_R', cyclic: true, note: 'бег по дуге вправо, Root 0° — угол кладёт код' },
  // Спринт и запасные айдлы.
  { take: 'SprintFwdLoop', clip: 'mocap_sprint_fwd', cyclic: true, note: 'спринт 205.1 u/с — почти наш рывок 200 (файл SprintFixed)' },
  { take: 'Idle2', clip: 'mocap_idle2', cyclic: true, note: 'запасной айдл 7.4 с (файл Idles)' },
  { take: 'Idle3', clip: 'mocap_idle3', cyclic: true, note: 'запасной айдл 7.1 с (Idles)' },
  { take: 'Idle4', clip: 'mocap_idle4', cyclic: true, note: 'запасной айдл 12.4 с (Idles)' },
  { take: 'Idle5', clip: 'mocap_idle5', cyclic: true, note: 'запасной айдл 15.8 с (Idles)' },
  { take: 'Idle6', clip: 'mocap_idle6', cyclic: true, note: 'запасной айдл 10.0 с (Idles)' },
];

/** Вся таблица. Порядок значим только для показа. */
export const MOCAP_SET: readonly MocapTake[] = [...CORE, ...EXTRA];

/** Что из таблицы нашлось в ОТКРЫТОМ файле. `blocked` отделено от `core`: показать надо, переносить — нет. */
export interface MocapMatch {
  /** Ядро, которое можно переносить. */
  core: MocapTake[];
  /** Дополнительное содержимое. */
  extra: MocapTake[];
  /** Нашлось, но брать нельзя (с причиной). */
  blocked: MocapTake[];
  /** Имена ядра, которых в этом файле нет (лежат в других файлах пакета). */
  absentCore: string[];
}

/**
 * Разобрать список имён тейков открытого файла по таблице.
 * ⚠ Сравнение по ТОЧНОМУ имени: у Kubold тейки зовутся одинаково во всех файлах пакета, а угадывание
 * («содержит walk») притащило бы `Crouch_WalkFwdLoop` в набор хода.
 */
export function matchMocapSet(takeNames: readonly string[]): MocapMatch {
  const have = new Set(takeNames);
  const core: MocapTake[] = [], extra: MocapTake[] = [], blocked: MocapTake[] = [], absentCore: string[] = [];
  for (const t of MOCAP_SET) {
    if (!have.has(t.take)) { if (t.core) absentCore.push(t.clip); continue; }
    if (t.blocked) blocked.push(t);
    else if (t.core) core.push(t);
    else extra.push(t);
  }
  return { core, extra, blocked, absentCore };
}

/** Есть ли в файле вообще что-то из набора — по этому панель решает, показывать ли блок переноса. */
export const isMocapSetFile = (takeNames: readonly string[]): boolean => {
  const m = matchMocapSet(takeNames);
  return m.core.length + m.extra.length > 0;
};
