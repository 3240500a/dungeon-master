import type { ConfigRegistry } from '@dm/shared';

/**
 * ETag конфига — СЛАБЫЙ, НО ПО ВСЕМУ ТЕЛУ.
 *
 * ⚠ Здесь была выборка «каждый 64-й символ» (`i += 64`) ради экономии. Экономия была не нужна —
 * ETag считается при ПЕРЕСБОРКЕ конфига (правка редактора, старт), а не на каждый запрос, — зато
 * цена оказалась высокой: правка числа ТОЙ ЖЕ ДЛИНЫ, не попавшая в выборку, давала бит-в-бит тот же
 * ETag. Клиент получал 304 и продолжал жить со старым конфигом. Симптом — «поправил, перезапустил
 * всё, ничего не изменилось», и искать такое можно бесконечно: 63 символа из 64 не влияли вовсе.
 *
 * FNV-1a покрывает каждый байт; по 436 КБ это доли миллисекунды.
 */
export function configEtagOf(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return `W/"${body.length.toString(36)}-${(h >>> 0).toString(36)}"`;
}

/** Готовый ответ `/api/config`: тело, его ETag и ревизия сервера (`CONFIG_REV_HEADER`). */
export interface ConfigReply { body: string; etag: string; rev: string }

/**
 * ⭐ R16 C-07: ОТВЕТ `/api/config` — С ОДНОГО СНИМКА РЕЕСТРА: тело (JSON снимка), его ETag и РЕВИЗИЯ СЕРВЕРА (`ConfigRegistry.revision`,
 * заголовок `CONFIG_REV_HEADER`). Ревизию вкладка кладёт в согласие команд кузницы, лавки и разбора (`cfgRev`), а нода сверяет её со своей.
 * Раньше вкладка клала свою — посчитанную по телу, разобранному СВОЕЙ схемой: у вкладки, пережившей деплой со сменой формы таблицы (L2 /
 * R3-25), она расходилась с серверной навсегда, и каждая продажа и ковка получали «Цена изменилась».
 */
export function configReplyOf(reg: ConfigRegistry): ConfigReply {
  const body = JSON.stringify(reg.snapshot());
  return { body, etag: configEtagOf(body), rev: reg.revision() };
}
