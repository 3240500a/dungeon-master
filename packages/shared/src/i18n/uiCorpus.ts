/**
 * ⭐⭐ i18n (07.11, «литералы обвязки»): КОРПУС ФРАЗ КЛИЕНТА UNITY (`ui:`) — третий рядом с корпусом конфига (`cfg:`, `walkConfigText`) и фраз
 * сервера (`srv:`, `srvCorpus.ts`). Файл `corpus.ui.json` пишет извлекатель (`npm run i18n` → `uiExtract.ts`: вызовы `DmText.T`/`Tn`/`With`/
 * `WithN` в рантайме `Assets/DM` Unity-репо) и сверяют сторожа: веб — `uiCorpus.test.ts` (когда Unity-репо рядом), Unity — `ui_text.py`
 * (по эталону псевдоязыка `__golden__/unity_ui.json`, который пишет тот же `npm run i18n`). Отсюда фразы берут вкладка «🌐 Языки»
 * («таблицы» `клиент Unity · <область>`), отчёт покрытия, заготовки `i18n:stub` и псевдоязык.
 *
 * ⚠ Исходник фразы ЖИВЁТ В КОДЕ Unity (`DmText.T(key, "исходник")`), файл — его снимок: Unity берёт исходник из вызова, а не отсюда. Перевод
 * `ui:` уезжает в Unity таблицей `locales` конфига (`DmLang` → `DmI18n.Loc`), как и строки `cfg:`; сервер ключей `ui:` не читает.
 */
import corpus from './corpus.ui.json' with { type: 'json' };
import type { FormSet } from './forms.js';

/** Ключ фразы клиента → исходник (строка) или формы по числу (`Tn`: категории языка-источника). */
export const UI_CORPUS: Readonly<Record<string, FormSet>> = (corpus as { strings: Record<string, FormSet> }).strings;

/** Строка корпуса клиента — в той же форме, что строки корпуса кода сервера (`SrvText`): вкладка и отчёт идут одним кодом. */
export interface UiText {
  /** Ключ `ui:<область>.<вещь>`. */
  key: string;
  /** Исходник; у фразы по числу — форма `other`. */
  source: string;
  /** Формы по числу (`Tn`) — только у таких фраз. */
  forms?: Readonly<Record<string, string>>;
  /** «Таблица» вкладки: `ui:<область>` (`ui:settings`, `ui:forge`…). */
  table: string;
  field: 'text' | 'forms';
  stable: true;
}

/** Область ключа: `ui:forge.title` → `ui:forge`. */
export const uiArea = (key: string): string => key.slice(0, Math.max(3, key.indexOf('.')));

/** Строки корпуса клиента в порядке ключей. */
export function uiCorpusRows(strings: Readonly<Record<string, FormSet>> = UI_CORPUS): UiText[] {
  return Object.entries(strings).map(([key, src]) => (typeof src === 'string'
    ? { key, source: src, table: uiArea(key), field: 'text' as const, stable: true as const }
    : { key, source: src.other ?? Object.values(src)[0] ?? '', forms: src, table: uiArea(key), field: 'forms' as const, stable: true as const }));
}

/** Все ключи корпуса клиента — для покрытия вместе с `cfg:` и `srv:`. */
export function uiCorpusKeys(): string[] {
  return Object.keys(UI_CORPUS);
}
