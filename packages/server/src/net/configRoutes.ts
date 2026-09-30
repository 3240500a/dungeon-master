import type { Express, Request, Response, RequestHandler } from 'express';
import { configSchemas, configRevs, type ConfigKey, type ConfigRegistry } from '@dm/shared';
import { ah } from './asyncRoute.js';
import { configWriter } from '../configWrites.js';
import type { LiveConfig } from '../configLive.js';

/**
 * ЗАПИСЬ КОНФИГА ИЗ РЕДАКТОРА (dev-ручки): «Применить на сервере» (`POST /api/dev/config` → оверрайд в базе), «Применить везде»
 * (`POST /api/dev/config-file` → файл `data/*.json` + оверрайд) и «Сбросить к дефолту» (`DELETE /api/dev/config/:key`). Вынесены из
 * `index.ts` (⭐ R21-02), чтобы проверять их настоящими запросами (`configRoutes.test.ts`).
 *
 * ⭐ R21-02: ПРОБА ЗАПИСИ — НАД ТЕМ, ЧТО СОБЕРЁТ ПЕРЕСБОРКА. Раньше проба была `new ConfigRegistry(); loadAll(); reload(присланное)` — над
 * ФАЙЛАМИ старта: с правилом поверх нескольких таблиц (D4) годная правка одной страницы редактора (откат клича, годный при отдыхе 0.1,
 * уже сохранённом в базе; потолок донора печати при уже поднятом откате печати) получала 422 с числами файла, а обратное (правка, годная
 * над файлами, но не с оверрайдами базы) проходило — и пересборка её выбрасывала. Теперь проба — `live.trial`: файлы + ВСЕ оверрайды базы
 * (`buildCandidate`, как пересборка) и присланное поверх, строго; «в файл» — ещё и слой файлов сам по себе (R21-03). Сервер, редактор
 * (`validatedKeys` — над загруженным живым) и пересборка проверяют одно и то же. Проба — в очереди записей (`configWriter`) вместе с
 * записью: из двух вкладок, приславших по половине несовместного, вторая получает отказ, а не зажим в пересборке.
 */
export interface ConfigRouteDeps {
  config: ConfigRegistry;
  live: LiveConfig;
  /** Доступ до тела (`devGate`: 401/403 без чтения тела, R4-11). */
  gate: RequestHandler;
  /** Тело JSON инструментов (`devJson`) — после `gate`. */
  json: RequestHandler;
  /** Доступ ручки без тела (`devGuard`): `false` — отказ уже отправлен. */
  guard: (req: Request, res: Response) => Promise<boolean>;
  /** Записать оверрайд таблицы (`setConfigOverride`). */
  setOverride: (key: string, value: unknown) => Promise<void>;
  /** Снять оверрайд таблицы (`deleteConfigOverride`). */
  deleteOverride: (key: string) => Promise<void>;
  /** Записать файл таблицы `data/<key>.json` (в его формате, `configFileFormat.ts`); бросает — ручке 500. */
  writeFile: (key: string, value: unknown) => void;
  /**
   * ⭐ R22-02: прочитать файл таблицы `data/<key>.json` с диска (разобранный JSON); нет файла — `undefined`, бросок — не разобран. Сверка «файл
   * на диске — тот, что принят сервером» перед записью «в файл». Нет ручки — сверки нет (как было).
   */
  readFile?: (key: string) => unknown;
}

export function installConfigWrites(app: Express, deps: ConfigRouteDeps): void {
  const { config, live } = deps;
  /**
   * ⭐ C-09: запись таблиц конфига — только поверх того, что редактор загрузил (`__baseRev`, ревизии загруженного): таблица на сервере уже
   * другая (сохранили в другой вкладке, инструментом, с другой машины; вкладка открыта при лежащем сервере — с дефолтами) — 409, ничего не
   * записано. Сверка и запись — одним шагом (`configWriter`); ответ несёт новые ревизии (`rev`) — база следующей записи редактора.
   */
  // ⚠ R22-07: не таблица схемы — `undefined`, а не бросок «не загружен»: очередь считает ревизии присланных ключей и после отказа пробы.
  const writeConfig = configWriter((key) => (isTable(key) ? config.get(key) : undefined));
  /** 409 записи конфига поверх чужой правки. */
  const staleConfig = (res: Response, conflicts: string[], rev: Record<string, string>): void => {
    console.log(`[dm-server] запись конфига отклонена (на сервере новее): ${conflicts.join(', ')}`);
    res.status(409).json({ error: 'На сервере более новая версия', conflicts, rev });
  };
  /**
   * ⚠ R22-07: ключи, которые не таблицы схемы (переименованная или снятая таблица в `pe_config_edits` поз-редактора, старая вкладка, скрипт),
   * — 422 с именем ДО очереди записей. Раньше отказ пробы (R21-02) внутри очереди сменялся броском подсчёта ревизий (`config.get('nope')`):
   * ручка отвечала 500 «Внутренняя ошибка», редактор принимал это за рестарт и повторял, а поз-редактор не мог назвать негодную секцию.
   */
  const unknownTables = (res: Response, keys: readonly string[]): boolean => {
    const unknown = keys.filter((k) => !isTable(k));
    if (!unknown.length) return false;
    console.log(`[dm-server] запись конфига отклонена: неизвестные таблицы ${unknown.join(', ')}`);
    res.status(422).json({ error: `Неизвестный конфиг «${unknown.join('», «')}» — такой таблицы в схеме нет (переименована или снята; обновите страницу редактора)` });
    return true;
  };

  app.post('/api/dev/config', deps.gate, deps.json, ah(async (req, res) => {
    const { __baseRev, ...overrides } = (req.body ?? {}) as Record<string, unknown>;
    if (unknownTables(res, Object.keys(overrides))) return;
    const refused: { msg?: string } = {};
    const r = await writeConfig(__baseRev, Object.keys(overrides), async () => {
      // ⭐ R21-02: валидация ДО записи в БД — над кандидатом пересборки с присланным поверх (мусор, неизвестный ключ, правило поверх таблиц).
      const why = await live.trial(overrides);
      if (why !== null) { refused.msg = why; return; }
      for (const [key, value] of Object.entries(overrides)) await deps.setOverride(key, value);
      await live.rebuild();
    });
    if (!r.ok) return staleConfig(res, r.conflicts, r.rev);
    if (refused.msg !== undefined) return res.status(422).json({ error: refused.msg });
    console.log(`[dm-server] конфиг сохранён из редактора: ${Object.keys(overrides).join(', ') || '—'}`);
    res.json({ ok: true, applied: Object.keys(overrides), rev: r.rev });
  }));

  /**
   * ⭐ R22-02: таблицы, чей файл на диске НЕ тот, что лежит в основе живого конфига (`live.fileMatches`): наблюдатель его не принял (пишется,
   * опечатка — негоден схемой), ещё не дошёл до него (окно дребезга, повтор после сбоя базы) или выключен. Редактор грузит живое — и запись
   * «в файл» такой таблицы легла бы СТАРОЙ живой таблицей поверх файла: правка напарника (git pull, генератор) молча откатывалась на диске.
   * Ключ → что с файлом (для ответа).
   */
  const diskDrift = (keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!deps.readFile) return out;
    for (const key of keys) {
      let disk: unknown;
      try {
        disk = deps.readFile(key);
      } catch (e) {
        out[key] = `файл не разобран (${e instanceof Error ? e.message : String(e)})`;
        continue;
      }
      if (disk === undefined) { out[key] = 'файла нет на диске'; continue; }
      if (!live.fileMatches(key, disk)) out[key] = 'файл на диске не тот, что принят сервером (правка на диске, которую сервер не взял или ещё не взял)';
    }
    return out;
  };

  // «Применить везде»: пишет правку прямо в ФАЙЛ-источник (data/*.json) → попадёт в git и на деплой.
  // Дополнительно ставит оверрайд в БД, чтобы живой конфиг остался верным (не откатился на дефолт,
  // импортированный в память при старте). ⭐ R15-05: и сам файл — основа следующих пересборок (`live.noteFile`): наблюдатель снимет
  // оверрайд («файл главнее»), и сверка, пересобрав конфиг, возьмёт таблицу из файла, а не из импорта старта. DEV-only.
  app.post('/api/dev/config-file', deps.gate, deps.json, ah(async (req, res) => {
    const { __baseRev, ...overrides } = (req.body ?? {}) as Record<string, unknown>;   // C-09: база — как у `/api/dev/config`
    if (unknownTables(res, Object.keys(overrides))) return;   // ⚠ R22-07: и файл `data/nope.json` не пишется
    const written: string[] = [];
    const failed: { msg?: string; status?: number; disk?: string[] } = {};   // запись файла упала — 500, как было (пересборки нет); проба — 422
    const r = await writeConfig(__baseRev, Object.keys(overrides), async () => {
      // ⭐ R21-02/03: валидация ДО записи в файл — над кандидатом пересборки с присланным и над слоем файлов самим по себе: файл, годный
      // только вместе с оверрайдами этой базы, ронял следующий старт (и любой старт с этого checkout).
      const why = await live.trial(overrides, { files: true });
      if (why !== null) { failed.msg = why; failed.status = 422; return; }
      // ⭐ R22-02: файл на диске — тот, поверх которого правка (сверка — последней перед записью: окно гонки с диском — без ожиданий базы).
      const drift = diskDrift(Object.keys(overrides));
      if (Object.keys(drift).length) {
        failed.status = 409;
        failed.disk = Object.keys(drift);
        failed.msg = `Не записано: ${Object.entries(drift).map(([k, why]) => `data/${k.replace(/\./g, '-')}.json — ${why}`).join('; ')}. `
          + 'Запись затёрла бы файл на диске живой таблицей. Поправьте или верните файл (сервер возьмёт его сам), обновите страницу редактора и повторите.';
        return;
      }
      try {
        for (const [key, value] of Object.entries(overrides)) {
          // Файл «строка на запись» (weapon-parts) пишем в его же формате и без умолчаний zod — иначе одна правка
          // детали давала diff на весь файл (`configFileFormat.ts`).
          deps.writeFile(key, value);
          live.noteFile(key, value);   // ⭐ R15-05: файл теперь такой — основа пересборок (наблюдатель снимет оверрайд, сверка пересоберёт)
          await deps.setOverride(key, value); // живой конфиг остаётся верным независимо от импортов в памяти
          written.push(key);
        }
      } catch (e) {
        failed.msg = `Не удалось записать файл: ${e instanceof Error ? e.message : String(e)}`;
        failed.status = 500;
        return;
      }
      // ⚠ `await`. Здесь стоял голый вызов АСИНХРОННОЙ `rebuildConfig()`, и это два дефекта разом:
      //  • сервер отвечал «ок» ДО пересборки — редактор тут же перечитывал `/api/config` и получал СТАРОЕ
      //    тело, то есть «сохранил, а не применилось» на ровном месте;
      //  • отказ внутри (валидация, база) становился НЕОБРАБОТАННЫМ reject, а он в Node роняет процесс.
      await live.rebuild();
    });
    if (!r.ok) return staleConfig(res, r.conflicts, r.rev);
    if (failed.disk) {
      // ⭐ R22-02: конфликт с ДИСКОМ — 409, как чужая правка (C-09), но с причиной: редактор её показывает (`disk`), перечитывание живого не поможет,
      // пока файл не годен или не взят сервером.
      console.log(`[dm-server] запись конфига в файл отклонена (файл на диске не принят сервером): ${failed.disk.join(', ')}`);
      return res.status(409).json({ error: failed.msg, conflicts: failed.disk, disk: true, rev: r.rev });
    }
    if (failed.msg !== undefined) return res.status(failed.status ?? 500).json({ error: failed.msg });
    console.log(`[dm-server] конфиг записан в ФАЙЛ (+БД): ${written.join(', ') || '—'}`);
    res.json({ ok: true, written, rev: r.rev });
  }));

  // Сброс ключа к встроенному дефолту (удаляет персистентный оверрайд).
  app.delete('/api/dev/config/:key', ah<{ key: string }>(async (req, res) => {
    if (!await deps.guard(req, res)) return;
    const key = req.params.key;
    const refused: { msg?: string } = {};
    // ⭐ C-09: сброс — в той же очереди записей конфига (без базы: «сбросить» — осознанно поверх любого); ответ несёт ревизию сброшенной
    // таблицы — база следующей записи редактора.
    await writeConfig(undefined, [], async () => {
      // ⭐ R21-01: сброс таблицы из связанной пары (отдых баланса ↔ откаты древа и вставок) проверяется, как запись: без неё таблица-партнёр
      // нарушила бы правило поверх таблиц, и следующая пересборка молча выбросила бы или «привела» её. Отказ — 422 с таблицей и подсказкой.
      const why = await live.trialReset(key);
      if (why !== null) { refused.msg = why; return; }
      await deps.deleteOverride(key);
      await live.rebuild();
    });
    if (refused.msg !== undefined) {
      console.log(`[dm-server] сброс конфига «${key}» отклонён: без него связанная таблица нарушит правило поверх таблиц`);
      return res.status(422).json({ error: refused.msg });
    }
    console.log(`[dm-server] конфиг сброшен к дефолту: ${key}`);
    res.json({ ok: true, reset: key, ...(isTable(key) ? { rev: configRevs([key], (k) => config.get(k as ConfigKey)) } : {}) });
  }));
}

/** Ключ — таблица схемы конфига (свой ключ `configSchemas`, не унаследованный вроде `toString`). */
function isTable(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(configSchemas, key);
}
