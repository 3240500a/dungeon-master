import { configFileNameFor, configKeyForFile } from './configFiles.js';
import type { LiveConfig } from './configLive.js';
import { logThrottle } from './net/logThrottle.js';

/**
 * ⭐ R22-02: НАБЛЮДАТЕЛЬ ФАЙЛОВ ДАННЫХ (`data/*.json`) — ТО ЖЕ РЕШЕНИЕ, ЧТО У СТАРТА ПРОЦЕССА.
 *
 * Раньше (`index.ts` `watchConfigFiles`) у каждого файла был свой дребезг, и файл применялся ОДИН (`live.applyFile`), строгой пробой поверх
 * кандидата с оверрайдами базы; отказ оставлял строку «не применён» — и всё. Отсюда три беды: набор, годный только вместе (git pull, генератор:
 * отдых баланса вместе с откатами древа и вставок), отказывался при любом порядке событий; отказанный файл больше никто не перечитывал; а
 * применение, упавшее на чтении базы, терялось насовсем.
 *
 * Теперь:
 *  • файлы, тронутые в одном окне дребезга, применяются ОДНОЙ пачкой (`live.applyFiles`): годное схемой ложится в основу, как его возьмёт
 *    старт, правило поверх таблиц — над итоговым кандидатом;
 *  • файл, не прочитанный (пишется) или негодный схемой, остаётся ОТКАЗАННЫМ и перечитывается при каждом следующем применении (любой файл);
 *    ручка «в файл» такую таблицу поверх диска не пишет (409, `configRoutes.ts`);
 *  • применение, упавшее на базе, повторяется через `retryMs` (основа к тому времени уже новая — `applyFiles` кладёт её до базы); ⚠ R23-07:
 *    строка об этом — не чаще раза в минуту, с числом промолчанных (лежащая база не топит лог; повтор — как был);
 *  • ⭐ R23-06: файл, записанный ДО взведения наблюдателя (между импортом `data/*.json` и концом `boot()`), событием ФС не придёт никогда —
 *    взведённый наблюдатель сверяет диск с основой (`sweep`): разошедшийся файл — как тронутый.
 */
export interface ConfigWatchDeps {
  /** Применение файлов и ⭐ R23-06 сверка файла на диске с основой живого конфига (`sweep`). */
  live: Pick<LiveConfig, 'applyFiles' | 'fileMatches'>;
  /** Таблицы схемы — им сопоставляются имена файлов (`configKeyForFile`). */
  keys: readonly string[];
  /** Прочитать и разобрать файл данных `file` (имя в папке данных). Бросок — не прочитан: пишется, удалён, битый JSON. */
  read: (file: string) => unknown;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Дребезг: запись файла редактором, генератором или git приходит несколькими событиями подряд (и по нескольким файлам). */
  debounceMs?: number;
  /** Через сколько повторить применение, упавшее на базе. */
  retryMs?: number;
}

export interface ConfigWatch {
  /** Событие наблюдателя ФС по файлу `file` (имя в папке данных): не таблица — мимо. */
  touched(file: string): void;
  /**
   * ⭐ R23-06: СВЕРИТЬ ФАЙЛЫ ВСЕХ ТАБЛИЦ НА ДИСКЕ С ОСНОВОЙ ЖИВОГО КОНФИГА (`live.fileMatches`) — звать сразу, как наблюдатель ФС взведён.
   * `defaults.ts` импортирует `data/*.json` при загрузке модуля, а наблюдатель взводится в конце `boot()` (схема базы, ревизия, сборка конфига;
   * у нод кластера — ещё и замок схемы): файл, записанный в этом окне (генератор, руки, `git pull` вместе с `.ts`), события ФС не дал бы — живой
   * конфиг оставался на импорте, а рестарт собирал новый; «Применить везде» его таблицы — 409 навсегда. Разошедшийся файл — как тронутый
   * (первое окно дребезга решит его, как любую правку на диске: годный — в основу, свой устаревший оверрайд снят), равный — не трогается
   * (оверрайды его таблицы живут). Нечитаемый (пишется прямо сейчас) — тоже как тронутый: применение перечитает.
   */
  sweep(): void;
  /** Применить накопленное сейчас (не дожидаясь дребезга): тронутые файлы и отказанные прежде. */
  flush(): Promise<void>;
  stop(): void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** ⚠ R23-07: строка о применении, упавшем на базе, — не чаще раза в минуту (как сбой сверки, `configSync.ts`): лежащая база не топит лог. */
const RETRY_WARN_MS = 60_000;

export function configWatcher(deps: ConfigWatchDeps): ConfigWatch {
  const log = deps.log ?? ((s: string) => console.log(s));
  const warn = deps.warn ?? ((s: string) => console.warn(s));
  const debounceMs = deps.debounceMs ?? 200;
  const retryMs = deps.retryMs ?? 3_000;
  const keyOf = (file: string): string | undefined => configKeyForFile(file, deps.keys);
  /** Файлы, тронутые с прошлого применения. */
  const dirty = new Set<string>();
  /** Отказанные файлы (файл → причина): лежат на диске, в основе нет — перечитываются при каждом следующем применении. */
  const refused = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  /** ⚠ R23-07: глушитель строки о повторе (срок — по часам процесса, R17-06). */
  const retryLog = logThrottle(RETRY_WARN_MS);

  const arm = (ms: number): void => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(); }, ms);
    timer.unref?.();
  };
  const refuse = (file: string, why: string): void => {
    if (refused.get(file) !== why) warn(`[dm-server] ${file} не применён (файл на диске, в игре — прежняя таблица; «Применить везде» её поверх файла не запишет): ${why}`);
    refused.set(file, why);
  };
  const once = async (): Promise<void> => {
    const batch = [...new Set([...dirty, ...refused.keys()])];
    dirty.clear();
    const values: Record<string, unknown> = {};
    const fileOf = new Map<string, string>();
    for (const file of batch) {
      const key = keyOf(file);
      if (!key) continue;
      try {
        values[key] = deps.read(file);
        fileOf.set(key, file);
      } catch (e) {
        refuse(file, `не прочитан: ${errText(e)}`);   // пишется прямо сейчас — его следующее событие (или любое применение) перечитает
      }
    }
    if (!fileOf.size) return;
    let out: Awaited<ReturnType<ConfigWatchDeps['live']['applyFiles']>>;
    try {
      out = await deps.live.applyFiles(values);
    } catch (e) {
      // База: основа уже новая (её соберёт любая пересборка), а снять устаревший оверрайд и пересобрать — повтором.
      for (const file of fileOf.values()) dirty.add(file);
      // ⚠ R23-07: повтор — каждые `retryMs`, а строка — не чаще раза в минуту: раньше каждый повтор писал её снова весь простой базы.
      const tail = retryLog.pass();
      if (tail !== null) warn(`[dm-server] правка ${[...fileOf.values()].join(', ')} не применена до конца: ${errText(e)} — повтор через ${Math.round(retryMs / 1000)} с${tail}`);
      arm(retryMs);
      return;
    }
    for (const key of out.taken) {
      const file = fileOf.get(key)!;
      refused.delete(file);
      log(`[dm-server] конфиг перечитан с диска: ${key}`);
    }
    for (const [key, why] of Object.entries(out.refused)) refuse(fileOf.get(key) ?? key, why);
  };
  // Применения — строго по одному: следующее берёт основу, оставленную прежним.
  const flush = (): Promise<void> => (chain = chain.then(once, once));
  return {
    touched(file) {
      if (stopped || !keyOf(file)) return;
      dirty.add(file);
      arm(debounceMs);
    },
    sweep() {
      if (stopped) return;
      let drift = false;
      for (const key of deps.keys) {
        const file = configFileNameFor(key);
        let disk: unknown;
        try {
          disk = deps.read(file);
        } catch {
          dirty.add(file);   // пишется прямо сейчас (или битый): применение перечитает — и возьмёт или скажет отказ
          drift = true;
          continue;
        }
        if (deps.live.fileMatches(key, disk)) continue;   // диск ≡ основа: трогать нечего (оверрайд таблицы живёт)
        dirty.add(file);
        drift = true;
      }
      if (drift) arm(debounceMs);
    },
    flush,
    stop() { stopped = true; clearTimeout(timer); timer = undefined; },
  };
}
