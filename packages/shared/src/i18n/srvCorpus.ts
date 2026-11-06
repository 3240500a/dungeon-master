/**
 * ⭐⭐ i18n Ф2 (06.11): КОРПУС ФРАЗ КОДА СЕРВЕРА (`srv:`) — рядом с корпусом конфига (`cfg:`, `walkConfigText`). Файл
 * `corpus.srv.json` пишет извлекатель (`npm run i18n`, дерево TypeScript по `tr()`/`trn()` в `shared` и `server` — `srvExtract.ts`) и
 * сверяет сторож (`srvCorpus.test.ts`: ключ в коде без записи, другой исходник, два исходника у ключа — падение). Отсюда фразы берут
 * вкладка «🌐 Языки» (переводчик видит и правит их как строки конфига), отчёт покрытия и сторож псевдоязыка.
 *
 * ⚠ Исходник фразы ЖИВЁТ В КОДЕ (`tr(key, 'исходник')`), файл — его снимок: рантайм берёт исходник из вызова, а не отсюда, поэтому
 * устаревший файл не ломает текст — он ломает только перевод (переводчик не увидел новой фразы), и это ловит сторож.
 */
import corpus from './corpus.srv.json' with { type: 'json' };
import type { FormSet } from './forms.js';

/** Ключ фразы → исходник (строка) или формы по числу (`trn`: категории `Intl.PluralRules` языка-источника). */
export const SRV_CORPUS: Readonly<Record<string, FormSet>> = (corpus as { strings: Record<string, FormSet> }).strings;

/** Строка корпуса кода — в той же форме, что строка корпуса конфига (`ConfigText`), чтобы вкладка и отчёт шли одним кодом. */
export interface SrvText {
  /** Ключ `srv:<область>.<вещь>`. */
  key: string;
  /** Исходник; у фразы по числу — форма `other` (для поиска и показа одной строкой). */
  source: string;
  /** Формы по числу (`trn`) — только у таких фраз. */
  forms?: Readonly<Record<string, string>>;
  /** «Таблица» вкладки: `srv:<область>` (`srv:forge`, `srv:room`…). */
  table: string;
  /** Поле: `text` у фразы, `forms` у фразы по числу. */
  field: 'text' | 'forms';
  /** Ключ кода стабилен всегда (он авторский). */
  stable: true;
}

/** Область ключа: `srv:forge.noRoom` → `srv:forge`. */
export const srvArea = (key: string): string => key.slice(0, Math.max(4, key.indexOf('.')));

/** Строки корпуса кода в порядке ключей. */
export function srvCorpusRows(strings: Readonly<Record<string, FormSet>> = SRV_CORPUS): SrvText[] {
  return Object.entries(strings).map(([key, src]) => (typeof src === 'string'
    ? { key, source: src, table: srvArea(key), field: 'text' as const, stable: true as const }
    : { key, source: src.other ?? Object.values(src)[0] ?? '', forms: src, table: srvArea(key), field: 'forms' as const, stable: true as const }));
}

/** Все ключи корпуса кода — для покрытия (`localeCoverage`) вместе с ключами конфига. */
export function srvCorpusKeys(): string[] {
  return Object.keys(SRV_CORPUS);
}
