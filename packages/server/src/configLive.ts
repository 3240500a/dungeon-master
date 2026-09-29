import { defaultConfigData, upgradeStoredOverride, type ConfigRegistry } from '@dm/shared';
import { counters } from './net/metrics.js';

/**
 * ⭐ R15-05: ЖИВОЙ КОНФИГ ПРОЦЕССА = ФАЙЛЫ ДАННЫХ, КАКИЕ ОНИ СЕЙЧАС, + ОВЕРРАЙДЫ РЕДАКТОРА ИЗ БАЗЫ.
 *
 * Раньше пересборка (`rebuildConfig` в `index.ts`) брала за основу `defaultConfigData` — ESM-импорт `data/*.json` В МОМЕНТ СТАРТА
 * процесса (`tsx watch` эти файлы нарочно не видит). Пока пересборка шла только по правке из редактора, это не мешало: правка ложилась
 * оверрайдом. Но с R16 C-02 пересборку зовёт и сверка ревизии оверрайдов (`configSync.ts`, раз в 3 с) — на ЛЮБУЮ их правку в любом процессе.
 * А наблюдатель файлов (`watchConfigFiles`) кладёт правку файла прямо в живой реестр и снимает устаревший оверрайд («файл главнее»): ревизия
 * сдвигалась, сверка пересобирала конфиг из импорта старта — и «Применить и записать в файл», «Применить везде», правка руками или
 * генератором откатывались в игре и в `/api/config` за ~3 с до старого (следующая правка редактора — 409 по ревизии). Правило владельца
 * «редактор ≡ игра» ломалось молча; прод не задет (наблюдателя там нет).
 *
 * Теперь основа сборки — импорт старта, поверх которого лежат файлы, прочитанные с диска после него (`noteFile`: наблюдатель проверил и
 * положил; ручка записи в файл записала). Невалидный файл основой не становится — живёт прежняя (последняя годная) таблица.
 */
export interface LiveConfigDeps {
  config: ConfigRegistry;
  /** Оверрайды редактора из базы (`getConfigOverrides`). */
  readOverrides: () => Promise<Record<string, unknown>>;
  /** Снять оверрайд (`deleteConfigOverride`). */
  deleteOverride: (key: string) => Promise<void>;
  /** Живой конфиг сменился — готовое тело `/api/config` пересобрать (Ф0.7, `rebuildConfigCache`). */
  changed: () => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** ⚠ R20-08: оверрайд пропущен целиком — ИНЦИДЕНТ (правок хозяина в таблице нет). Умолчание — `console.error`. */
  incident?: (line: string) => void;
}

export interface LiveConfig {
  /** Полная пересборка: файлы данных (как на диске) + оверрайды базы. Оверрайды — СПЕРВА из базы, сборка — без ожиданий (R16 C-02). */
  rebuild(): Promise<void>;
  /** Файл таблицы `key` на диске теперь такой (записала ручка «Применить и записать в файл»): основа следующих пересборок. */
  noteFile(key: string, value: unknown): void;
  /**
   * Наблюдатель увидел правку файла таблицы `key` (`value` — разобранный JSON): проверить и положить в живой реестр и в основу, снять
   * устаревший оверрайд («файл главнее»). Невалидный — бросает, и ничего не меняется.
   */
  applyFile(key: string, value: unknown): Promise<void>;
}

export function liveConfig(deps: LiveConfigDeps): LiveConfig {
  const { config } = deps;
  const log = deps.log ?? ((s: string) => console.log(s));
  const warn = deps.warn ?? ((s: string) => console.warn(s));
  const incident = deps.incident ?? ((s: string) => console.error(s));
  /** Файлы, прочитанные с диска после старта (ключ → сырое значение): поверх импорта старта. */
  const files = new Map<string, unknown>();
  /**
   * Накатывает оверрайды `all` поверх основы (устойчиво к невалидным — пропускает).
   * ⚠ R20-08: сохранённое под прежней схемой сперва приводится (`upgradeStoredOverride`: старт класса дробью или минусом, до R18-07 — вниз
   * до целого, не ниже нуля) — иначе одно старое значение выбрасывало все правки таблицы, — и приведённое говорится вслух. Пропуск таблицы
   * целиком — ИНЦИДЕНТ (`console.error` и `dm_config_override_skipped_total`), а не строка предупреждения: правок хозяина в игре нет.
   */
  const applyOverrides = (all: Record<string, unknown>): void => {
    for (const [key, stored] of Object.entries(all)) {
      const { value, fixes } = upgradeStoredOverride(key, stored);
      try {
        config.reload({ [key]: value });
        if (fixes.length) warn(`[dm-server] оверрайд конфига "${key}" сохранён под прежней схемой — приведён при загрузке (в базе прежний: записать — «Применить» в редакторе или npm run db:repair -- --fix): ${fixes.join(', ')}`);
      } catch (e) {
        counters.configOverridesSkipped++;
        incident(`[dm-server] ИНЦИДЕНТ: пропущен невалидный оверрайд конфига "${key}" — таблица целиком живёт на файле, правок хозяина в ней в игре нет (сохранить заново из редактора или npm run db:repair): ${e instanceof Error ? e.message : e}`);
      }
    }
    // ГОВОРИМ ВСЛУХ, что перекрыто. Оверрайд из редактора живёт в БД и переживает рестарт, поэтому
    // «правлю файл, а везде старое» выглядит как мистика, пока не увидишь эту строчку.
    const keys = Object.keys(all);
    if (keys.length) log(`[dm-server] поверх файлов лежат оверрайды редактора: ${keys.join(', ')}`);
  };
  return {
    async rebuild() {
      const all = await deps.readOverrides();
      config.loadAll(files.size ? { ...defaultConfigData, ...Object.fromEntries(files) } : defaultConfigData);
      applyOverrides(all);
      deps.changed();
    },
    noteFile(key, value) { files.set(key, structuredClone(value)); },
    async applyFile(key, value) {
      config.reload({ [key]: value });   // сперва валидация: невалидный файл сюда не пройдёт
      files.set(key, structuredClone(value));
      if (Object.prototype.hasOwnProperty.call(await deps.readOverrides(), key)) {
        await deps.deleteOverride(key);   // снимаем устаревший снимок, иначе он переживёт рестарт
        log(`[dm-server] снят устаревший оверрайд «${key}» — теперь главенствует файл`);
      }
      deps.changed();
    },
  };
}
