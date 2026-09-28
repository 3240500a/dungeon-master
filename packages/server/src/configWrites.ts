import { configRevs, staleConfigKeys } from '@dm/shared';

/** Исход записи таблиц конфига: записано (новые ревизии) или отказ — таблицы на сервере уже не те, поверх которых правка (их ревизии). */
export type ConfigWriteResult =
  | { ok: true; rev: Record<string, string> }
  | { ok: false; conflicts: string[]; rev: Record<string, string> };

/**
 * ⭐ C-09: ЗАПИСЬ ТАБЛИЦ КОНФИГА ИЗ РЕДАКТОРА — ТОЛЬКО ПОВЕРХ ТОГО, ЧТО ОН ЗАГРУЗИЛ.
 *
 * Редактор шлёт таблицу целиком, а роут (`/api/dev/config`, `/api/dev/config-file`) заменял её оверрайд молча: вкладка, открытая, пока сервер
 * лежал (встроенные дефолты), или со старым снимком (таблицу сохранили в другой вкладке, инструментом, с другой машины) одним «Применить»
 * откатывала всю таблицу — цены кузницы, сброса и лавки, ковку, штраф смерти — у всех игроков. Теперь запись несёт ревизии загруженного
 * (`__baseRev`), и таблица, которая на сервере уже другая, — отказ (409, `conflicts`) без записи, как публикация поз-редактора (`baseRev`).
 * Без базы (старые клиенты, скрипты, `curl`) — как было.
 *
 * Сверка и запись — ОДНИМ шагом в очереди записей процесса (`write` ждёт базу): две вкладки, нажавшие разом поверх одного снимка, обе сверку
 * не пройдут. `current` — живое значение таблицы (реестр сервера после пересборки).
 */
export function configWriter(current: (key: string) => unknown): (baseRev: unknown, keys: readonly string[], write: () => Promise<void>) => Promise<ConfigWriteResult> {
  let queue: Promise<unknown> = Promise.resolve();
  return (baseRev, keys, write) => {
    const run = queue.then(async (): Promise<ConfigWriteResult> => {
      const conflicts = staleConfigKeys(baseRev, keys, current);
      if (conflicts.length) return { ok: false, conflicts, rev: configRevs(conflicts, current) };
      await write();
      return { ok: true, rev: configRevs(keys, current) };
    });
    queue = run.catch(() => undefined);   // упавшая запись очередь не запирает
    return run;
  };
}
