import {
  ConfigRegistry, configSchemas, defaultConfigData, buffTimingIssues, CONFIG_CROSS_KEYS, type ConfigKey, type BuffTimingIssue,
} from '@dm/shared';
import { counters } from './net/metrics.js';
import { buildCandidate, candidateText, type ConfigCandidate } from './configCandidate.js';

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
 *
 * ⭐ R21-01/02/03: основа и оверрайды базы собираются ОДНИМ кандидатом (`configCandidate.ts`): схема — у каждой таблицы своя, правило поверх
 * нескольких таблиц (D4) — над итоговым кандидатом, а не по одной таблице в порядке строк базы; пересборка не бросает из-за него никогда.
 * Запись (ручки редактора, сброс) проверяется строго поверх того же кандидата (`trial`, `trialReset`), а файл — ещё и слоем файлов сам по
 * себе: сервер, редактор и пересборка проверяют одно и то же.
 *
 * ⭐ R22-02: НАБЛЮДАТЕЛЬ РЕШАЕТ ТО ЖЕ, ЧТО СТАРТ (`applyFiles`). Файл на диске УЖЕ лежит — отказ наблюдателя его оттуда не уберёт, а старт
 * процесса (и деплой с этого checkout) его возьмёт. С R21-03 наблюдатель проверял файл строго поверх кандидата со всеми оверрайдами базы и
 * отказывал строкой в лог: живой конфиг и редактор оставались на старой таблице, «Применить везде» этой таблицы писало старую живую таблицу
 * поверх файла (правка напарника молча откатывалась на диске), а рестарт собирал другой конфиг, чем работающий. Теперь годный СХЕМОЙ файл
 * (или пачка файлов одного окна дребезга, `configWatch.ts`) ложится в основу ДО чтения базы, свой устаревший оверрайд снимается («файл
 * главнее»), а правило поверх таблиц решает пересборка над итоговым кандидатом — зажимом вслух, ровно как на старте. Негодный схемой файл
 * (пишется, опечатка) основой не становится (как R15-05); его перечитывает следующее применение, а ручка «в файл» такую таблицу не пишет
 * поверх диска (409, `fileMatches`).
 * ⭐ R22-06: проба «в файл» отказывает слою файлов, только если правка вносит в него НОВОЕ нарушение правила поверх таблиц или углубляет
 * лежащее (`filesWorse`): уже лежащее (старт принял с инцидентом) не запирает правки чужих таблиц.
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

/** ⭐ R22-02: исход применения файлов наблюдателем: легли в основу (`taken`) и не легли по схеме — с причиной (`refused`). */
export interface FilesOutcome { taken: string[]; refused: Record<string, string> }

export interface LiveConfig {
  /**
   * Полная пересборка: файлы данных (как на диске) + оверрайды базы — одним кандидатом (⭐ R21-01, `buildCandidate`). Оверрайды — СПЕРВА из
   * базы, сборка — без ожиданий (R16 C-02). Из-за правила поверх таблиц не бросает никогда (⭐ R21-03).
   */
  rebuild(): Promise<void>;
  /** Файл таблицы `key` на диске теперь такой (записала ручка «Применить и записать в файл»): основа следующих пересборок. */
  noteFile(key: string, value: unknown): void;
  /**
   * ⭐ R22-02: наблюдатель увидел правку файлов (`changes`: таблица → разобранный JSON; пачка одного окна дребезга) — решить, как решит старт:
   * годное схемой — в основу СРАЗУ (до базы), устаревший оверрайд своей таблицы снять («файл главнее»), пересобрать (правило поверх таблиц —
   * над итоговым кандидатом, спорящий оверрайд чужой таблицы приводится вслух, как на старте). Негодное схемой — `refused`, основа прежняя.
   * Бросает только база (чтение и снятие оверрайдов, пересборка): основа уже новая, наблюдатель повторит применение.
   */
  applyFiles(changes: Record<string, unknown>): Promise<FilesOutcome>;
  /** Одна таблица через `applyFiles`: негодная схемой — бросок с причиной. */
  applyFile(key: string, value: unknown): Promise<void>;
  /**
   * ⭐ R22-02: файл таблицы `key` на диске (`disk`, разобранный JSON) — тот, что лежит в основе? Сравнение — по разбору схемой (ручка «в файл»
   * пишет без умолчаний zod, `configFileFormat.ts`). Негодный схемой — не тот. Не таблица — тот (сверять нечего).
   */
  fileMatches(key: string, disk: unknown): boolean;
  /**
   * ⭐ R21-02: ПРОБА ЗАПИСИ — над тем, что соберёт пересборка (файлы + ВСЕ оверрайды базы, `buildCandidate`), с `changes` поверх, строго: схема
   * и правило поверх таблиц. Отказ — текст ошибки валидации (ручке — 422), годно — `null`; бросает только чтение базы (ручке — 500). `files` —
   * ещё и СЛОЙ ФАЙЛОВ сам по себе (⭐ R21-03: основа + `changes`, без оверрайдов): файл уходит в git и на деплой, где оверрайдов этой базы
   * нет, и годным только из-за них он быть не должен. ⭐ R22-06: отказ — только если правка вносит в слой файлов новое нарушение правила
   * поверх таблиц или углубляет лежащее (`filesWorse`).
   */
  trial(changes: Record<string, unknown>, opts?: { files?: boolean }): Promise<string | null>;
  /**
   * ⭐ R21-01: ПРОБА СБРОСА оверрайда `key` к файлу (`DELETE /api/dev/config/:key`) — тем же порядком: таблица из основы строго поверх
   * кандидата. Отказ (текст), если без оверрайда связанная таблица (древо, вставки, баланс) нарушит правило поверх таблиц: раньше сброс
   * проходил молча, а следующая пересборка выбрасывала или «приводила» таблицу-партнёра.
   */
  trialReset(key: string): Promise<string | null>;
}

export function liveConfig(deps: LiveConfigDeps): LiveConfig {
  const { config } = deps;
  const log = deps.log ?? ((s: string) => console.log(s));
  const warn = deps.warn ?? ((s: string) => console.warn(s));
  const incident = deps.incident ?? ((s: string) => console.error(s));
  /** Файлы, прочитанные с диска после старта (ключ → сырое значение): поверх импорта старта. */
  const files = new Map<string, unknown>();
  /** Основа сборки: импорт старта + файлы, прочитанные с диска после него. */
  const base = (): Record<string, unknown> => (files.size ? { ...defaultConfigData, ...Object.fromEntries(files) } : defaultConfigData);
  /** Кандидат пересборки — из оверрайдов базы, какие они СЕЙЧАС (`buildCandidate`). */
  const candidate = async (): Promise<ConfigCandidate> => buildCandidate(base(), await deps.readOverrides());
  /** Отказ пробы — текст ошибки валидации, годно — `null`. */
  const refusal = (probe: () => void): string | null => {
    try { probe(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  /**
   * Кандидат — в живой реестр, одним `loadAll` (всё или ничего, R7-14).
   * ⚠ R20-08: сохранённое под прежней схемой приведено (`upgradeStoredOverride`: ⭐ D2 — кривая опыта баланса старше R20-05; старт класса
   * дробью или минусом, до R18-07 — вниз до целого, не ниже нуля; ⭐ D4 — зажим баффа, нарушающего правило ВМЕСТЕ с прочими таблицами) — иначе
   * одно старое значение выбрасывало все правки таблицы, — и приведённое говорится вслух. Пропуск таблицы целиком — ИНЦИДЕНТ (`console.error`
   * и `dm_config_override_skipped_total`), а не строка предупреждения: правок хозяина в игре нет. ⭐ R21-03: файл данных, приведённый правилом
   * поверх таблиц, — тоже инцидент (в игре не то, что в файле); правило, не удержанное и после приведения, — инцидент, а не бросок.
   */
  const install = (c: ConfigCandidate, keys: readonly string[]): void => {
    config.loadAll(c.raw, { cross: !c.crossLeft.length });   // каждая таблица кандидата уже разобрана схемой — сюда не бросает
    for (const s of c.skipped) {
      counters.configOverridesSkipped++;
      incident(`[dm-server] ИНЦИДЕНТ: ${candidateText.skipped(s)}`);
    }
    for (const [key, lines] of Object.entries(c.fileFixes)) incident(`[dm-server] ИНЦИДЕНТ: ${candidateText.fileFixed(key, lines)}`);
    if (c.crossLeft.length) incident(`[dm-server] ИНЦИДЕНТ: ${candidateText.crossLeft(c.crossLeft)}`);
    for (const [key, lines] of Object.entries(c.fixes)) warn(`[dm-server] ${candidateText.fixed(key, lines)}`);
    // ГОВОРИМ ВСЛУХ, что перекрыто. Оверрайд из редактора живёт в БД и переживает рестарт, поэтому
    // «правлю файл, а везде старое» выглядит как мистика, пока не увидишь эту строчку.
    if (keys.length) log(`[dm-server] поверх файлов лежат оверрайды редактора: ${keys.join(', ')}`);
  };
  const rebuild = async (): Promise<void> => {
    const all = await deps.readOverrides();
    install(buildCandidate(base(), all), Object.keys(all).sort());
    deps.changed();
  };
  /**
   * ⭐ R22-06: нарушения правила поверх таблиц у СЛОЯ ФАЙЛОВ `layer` (без оверрайдов базы) — со строкой и рангом, чтобы сравнить «до» и
   * «после» правки. Разбираются только таблицы правила (схема уже проверена строгой пробой).
   */
  const layerIssues = (layer: Record<string, unknown>): BuffTimingIssue[] => {
    const reg = new ConfigRegistry();
    reg.reload(Object.fromEntries(CONFIG_CROSS_KEYS.map((k) => [k, layer[k]])), { cross: false });
    return buffTimingIssues({ balance: reg.get('balance'), 'skill-tree': reg.get('skill-tree'), 'skill-inserts': reg.get('skill-inserts') });
  };
  /**
   * ⭐ R22-06: что правка `changes` вносит в слой файлов НОВОГО по правилу поверх таблиц: строка, которой среди нарушений не было, или та же, но
   * углублённая — первый негодный ранг раньше или нехватка отката на нём больше. Правка, не трогающая таблиц правила, — ничего.
   */
  const filesWorse = (changes: Record<string, unknown>): BuffTimingIssue[] => {
    if (!Object.keys(changes).some((k) => (CONFIG_CROSS_KEYS as readonly string[]).includes(k))) return [];
    const was = layerIssues(base());
    const gap = (i: BuffTimingIssue): number => i.floor - i.cooldown;
    return layerIssues({ ...base(), ...changes }).filter((i) => !was.some((b) => b.table === i.table && b.id === i.id
      && (b.rank < i.rank || (b.rank === i.rank && gap(i) <= gap(b) + 1e-9))));
  };
  const trial = async (changes: Record<string, unknown>, opts?: { files?: boolean }): Promise<string | null> => {
    const c = await candidate();   // чтение базы — до проб: его отказ бросается (не «данные негодны»)
    // Строго: схема + правило поверх таблиц над кандидатом с правкой — ровно то, что соберёт пересборка после записи.
    const why = refusal(() => c.reg.reload(changes as Partial<Record<ConfigKey, unknown>>));
    if (why !== null || !opts?.files) return why;
    // ⭐ R21-03: слой файлов сам по себе (основа + `changes`): так его загрузит старт процесса на другой базе (деплой). ⭐ R22-06: отказ — только
    // новому или углублённому нарушению: лежащее уже (старт принял его с инцидентом) правки чужих таблиц не запирает.
    const worse = filesWorse(changes);
    if (!worse.length) return null;
    return `Файлы данных вместе не проходят правила поверх таблиц без оверрайдов базы (файл уходит в git и на деплой — годным только из-за них он быть не должен; `
      + `нарушение, уже лежащее в файлах, правке не мешает — мешает новое или углублённое). Конфиг "${worse[0]!.table}" не прошёл валидацию:\n`
      + worse.map((i) => `${i.table}: ⭐ D4 правило баффа: ${i.msg}`).join('\n');
  };
  /** ⭐ R22-02: применения файлов наблюдателем — по одному: каждое берёт основу, оставленную прежним. */
  let applying: Promise<unknown> = Promise.resolve();
  const applyFiles = (changes: Record<string, unknown>): Promise<FilesOutcome> => {
    const run = applying.then(async (): Promise<FilesOutcome> => {
      const taken: string[] = [];
      const refused: Record<string, string> = {};
      for (const [key, value] of Object.entries(changes)) {
        // Схема одной таблицы от прочих не зависит: негодный файл (пишется, опечатка) основой не становится — как R15-05, и старт его не
        // загрузил бы. Правило поверх таблиц — НЕ здесь: его решит пересборка над итоговым кандидатом, как на старте.
        const why = refusal(() => new ConfigRegistry().reload({ [key]: value } as Partial<Record<ConfigKey, unknown>>, { cross: false }));
        if (why !== null) { refused[key] = why; continue; }
        files.set(key, structuredClone(value));   // ДО базы: лежащая база правку файла не теряет — её соберёт повтор или любая пересборка
        taken.push(key);
      }
      if (!taken.length) return { taken, refused };
      if (taken.some((k) => (CONFIG_CROSS_KEYS as readonly string[]).includes(k))) {
        // Слой файлов сам по себе нарушает правило: здесь его может держать оверрайд базы, а на деплое (другая база) старт приведёт таблицу.
        const alone = layerIssues(base());
        if (alone.length) warn(`[dm-server] файлы данных сами по себе (без оверрайдов базы) нарушают правило поверх таблиц (⭐ D4) — на деплое старт их зажмёт: ${alone.map((i) => `${i.table}: ${i.msg}`).join(' | ')}`);
      }
      const stored = await deps.readOverrides();
      for (const key of taken) {
        if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
        await deps.deleteOverride(key);   // снимаем устаревший снимок, иначе он переживёт рестарт
        log(`[dm-server] снят устаревший оверрайд «${key}» — теперь главенствует файл`);
      }
      await rebuild();
      return { taken, refused };
    });
    applying = run.catch(() => undefined);   // упавшее применение очередь не запирает
    return run;
  };
  return {
    rebuild,
    noteFile(key, value) { files.set(key, structuredClone(value)); },
    applyFiles,
    async applyFile(key, value) {
      const { refused } = await applyFiles({ [key]: value });
      if (refused[key] !== undefined) throw new Error(refused[key]);
    },
    fileMatches(key, disk) {
      const schema = (configSchemas as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>)[key];
      if (!Object.prototype.hasOwnProperty.call(configSchemas, key) || !schema) return true;
      const a = schema.safeParse(disk);
      const b = schema.safeParse(base()[key]);
      return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
    },
    trial,
    async trialReset(key) {
      if (!Object.prototype.hasOwnProperty.call(configSchemas, key)) return null;   // не таблица схемы — сбросу нечего проверять
      const why = await trial({ [key]: base()[key] });
      return why === null ? null : `Сброс «${key}» к файлу данных нарушит правило поверх таблиц — сперва поправьте или сбросьте связанную таблицу. ${why}`;
    },
  };
}
