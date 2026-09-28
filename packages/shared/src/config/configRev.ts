/**
 * ⭐ C-09: РЕВИЗИЯ ТАБЛИЦЫ КОНФИГА — «поверх какой правды сервера правка».
 *
 * Редактор конфигов шлёт таблицу ЦЕЛИКОМ (`balance` — цены кузницы, сброса и лавки, ковка, штраф смерти…), а сервер заменял её оверрайд молча.
 * Вкладка, открытая, пока сервер лежал (перезапуск `tsx watch` на каждую правку кода, недоступная машина), видела встроенные дефолты, и одно
 * «Применить» откатывало всю таблицу у всех игроков — кроме поля, которое правили. То же без всякого сбоя — со старым снимком: таблицу успели
 * сохранить в другой вкладке, инструментом («Ковка → Клинки») или с другой машины. Теперь запись несёт ревизии того, что редактор загрузил
 * (`__baseRev`), а сервер сверяет их с живыми (`staleConfigKeys`) и отказывает (409), как публикация поз-редактора (`baseRev`).
 *
 * Ревизия — FNV-1a по JSON значения, по ПОЛНЫМ кодам знаков (не младшим байтам: «ч» и «G» иначе одно и то же). JSON значения у сервера
 * (живой реестр) и у редактора (таблица из тела `/api/config`) — одна строка: тело — это `JSON.stringify` снимка реестра.
 */
export function configRev(value: unknown): string {
  const s = JSON.stringify(value) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

/** Ревизии таблиц `keys` по живому значению (`current`). */
export function configRevs(keys: readonly string[], current: (key: string) => unknown): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, configRev(current(k))]));
}

/**
 * Ревизия таблицы с памятью по САМОМУ ОБЪЕКТУ таблицы. Таблицу реестра на месте не правят: правка — новый объект (`reload`), поэтому
 * ревизия объекта постоянна, а хэш ~0.4 МБ JSON всего конфига на каждую команду кузницы (V-B3-07) был бы дорог.
 */
const tableRevs = new WeakMap<object, string>();
function tableRev(value: unknown): string {
  if (value === null || typeof value !== 'object') return configRev(value);
  let rev = tableRevs.get(value);
  if (rev === undefined) { rev = configRev(value); tableRevs.set(value, rev); }
  return rev;
}

/**
 * ⭐ V-B3-07: РЕВИЗИЯ ВСЕГО КОНФИГА — «с какого конфига нарисовано окно». Считается по содержимому одинаково у сервера (живой реестр) и у
 * клиента (реестр из тела `/api/config`: тело — `JSON.stringify` снимка реестра, а разбор схемой идемпотентен — сторож
 * `configRev.test.ts`), поэтому по проводу её не возят: клиент кладёт ревизию СВОЕГО конфига в команду (`cfgRev`), сервер
 * сверяет со своей (`configChanged`). Все таблицы, а не выборка: исход ковки и лавки зависит от десятка таблиц, и забытая в
 * выборке ревизию бы не сдвинула.
 */
export function configSetRev(keys: readonly string[], table: (key: string) => unknown): string {
  return configRev(keys.map((k) => `${k}:${tableRev(table(k))}`).join('|'));
}

/**
 * ⭐ R16 C-07: ЗАГОЛОВОК ОТВЕТА `/api/config` — ревизия конфига СЕРВЕРА (`ConfigRegistry.revision`), с которого собрано тело. Ревизия клиента
 * по разобранному им телу равна ей, только пока схемы у них одни: деплой, сменивший форму любой таблицы (новое поле, другой порядок, поле с
 * умолчанием убрано), а вкладка старая (L2 / R3-25 — переподключается сама, без перезагрузки), — и её разбор «удался», но в другое. Согласие
 * (`cfgRev`) по своей ревизии отказывало ей тогда навсегда. Теперь вкладка шлёт ревизию сервера для тела, которое у неё легло (`App.syncConfig`),
 * а своя с ней не сошлась — игроку «перезагрузите страницу».
 */
export const CONFIG_REV_HEADER = 'x-config-rev';

/**
 * Таблицы записи `keys`, чья база (`baseRev`, ревизии загруженного редактором) — уже не живое значение: запись поверх них затёрла бы чужую
 * правку. Базы нет вовсе — не сверяем (старые клиенты, скрипты, `curl`: как было). База есть, но без ревизии таблицы или не того вида —
 * конфликт: «не знаю, поверх чего» — это не «можно».
 */
export function staleConfigKeys(baseRev: unknown, keys: readonly string[], current: (key: string) => unknown): string[] {
  if (baseRev === undefined || baseRev === null) return [];
  if (typeof baseRev !== 'object' || Array.isArray(baseRev)) return [...keys];
  const base = baseRev as Record<string, unknown>;
  return keys.filter((k) => typeof base[k] !== 'string' || base[k] !== configRev(current(k)));
}
