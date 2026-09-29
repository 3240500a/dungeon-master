import { logThrottle } from './net/logThrottle.js';

/**
 * ⭐ R16 C-02, C-08: ПРАВКА КОНФИГА — ВО ВСЕХ ПРОЦЕССАХ КЛАСТЕРА.
 *
 * Живой конфиг процесса — дефолты данных и оверрайды редактора из базы (`config_overrides`), собранные в памяти (`rebuildConfig` в
 * `index.ts`). Правку («Применить на сервере», `POST /api/dev/config`) пересобирал только процесс, который её принял, — гейтвей: ноды API не
 * отдают (`installNodeFence`) и держали конфиг своего старта до перезапуска. А клиент берёт конфиг у гейтвея и кладёт его ревизию в каждую
 * команду согласия (V-B3-07: продажа, кузница, ковка, разбор — `cfgRev`), и нода сверяет её со СВОЕЙ: любая правка любой таблицы (модели,
 * текстуры, окружение) закрывала лавку и кузницу всем игрокам всех нод отказом «Цена изменилась», а перечитанный конфиг гейтвея был тем же
 * (304) — до перезапуска каждой ноды. Так же — правка оверрайдов мимо сервера (`db:repair`, SQL) и процесс, поднятый после неё.
 *
 * Теперь каждый процесс сверяет ревизию оверрайдов в базе (`readRev`: дёшево, без самих таблиц) раз в `intervalMs` и, если она сдвинулась,
 * пересобирает конфиг (`rebuild`). Ревизия — снятая ДО сборки конфига на старте (`initial`): правка, легшая между ними, соберётся первой же
 * сверкой. Сборка упала (база) — ревизия не запоминается, следующая сверка соберёт снова. Окно расхождения — одна сверка: команда, пришедшая в
 * нём, получает «Цена изменилась», и повтор после перечитывания проходит.
 */

/** ⭐ R16 C-02: как часто процесс сверяет ревизию оверрайдов конфига в базе, мс. */
export const CONFIG_SYNC_MS = 3_000;
/** Сбой сверки — в лог не чаще раза в минуту (лежащая база не топит лог). ⭐ R17-06: срок — по часам процесса (`logThrottle`). */
const WARN_MS = 60_000;

export interface ConfigSyncDeps {
  /** Ревизия оверрайдов в базе (`getConfigOverridesRev`): другая строка — оверрайды менялись. */
  readRev: () => Promise<string>;
  /** Пересобрать живой конфиг процесса из дефолтов и оверрайдов базы. */
  rebuild: () => Promise<void>;
  /** Ревизия, снятая до сборки конфига на старте; нет — первая сверка её только запоминает. */
  initial?: string;
  intervalMs?: number;
  /** Имя процесса для лога. */
  who?: string;
}

export interface ConfigSync {
  /** Сверить сейчас (не дожидаясь таймера): `true` — конфиг пересобран. */
  check(): Promise<boolean>;
  stop(): void;
}

export function startConfigSync(deps: ConfigSyncDeps): ConfigSync {
  const who = deps.who ?? 'dm-server';
  let known = deps.initial;
  let running: Promise<boolean> | null = null;
  const warnLog = logThrottle(WARN_MS);
  const once = async (): Promise<boolean> => {
    let rev: string;
    try {
      rev = await deps.readRev();
    } catch (e) {
      if (warnLog.pass() !== null) console.warn(`[${who}] сверка конфига с базой не удалась — повтор позже:`, e);
      return false;
    }
    if (known === undefined) { known = rev; return false; }
    if (rev === known) return false;
    try {
      await deps.rebuild();
    } catch (e) {
      if (warnLog.pass() !== null) console.warn(`[${who}] конфиг в базе изменился, но пересобрать его не удалось — повтор позже:`, e);
      return false;
    }
    known = rev;
    console.log(`[${who}] конфиг пересобран: оверрайды в базе изменились (правка в другом процессе или мимо сервера)`);
    return true;
  };
  // Сверки — строго по одной: медленная база не множит их.
  const check = (): Promise<boolean> => running ?? (running = once().finally(() => { running = null; }));
  const timer = setInterval(() => { void check(); }, deps.intervalMs ?? CONFIG_SYNC_MS);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}
