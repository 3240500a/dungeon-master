/**
 * РАБОЧАЯ КОПИЯ КОНФИГА (Ф12.4): правки моделей/материалов живут локально и публикуются кнопкой.
 *
 * ЗАЧЕМ. Вкладка «Модели» на выбранном атласе даёт ~80 селектов (слот + материал на каждый сабмеш), и каждое
 * изменение раньше делало ДВА POST на сервер (`/api/dev/config-file` + `/api/dev/config`), а `.catch(() => {})`
 * съедал ошибку. Нет сервера — вся настройка сабмешей уходила в никуда, и это ровно жалоба «настроил один раз,
 * а оно не сохранилось». Теперь правка мгновенно ложится в localStorage, переживает F5 и уходит на сервер
 * той же кнопкой «Опубликовать», что и контент, — двух разных «сохранить» в интерфейсе быть не должно.
 *
 * СЛОИ ЧТЕНИЯ (низ → верх): встроенные дефолты → `pe_config` (кэш серверного, кладёт `syncConfigFromServer`)
 * → `pe_config_edits` (эти правки). Верхний слой выигрывает — как оверрайд конфига на сервере, только локально.
 */
import { notifySyncChange } from './poseServer.js';

const EDITS_KEY = 'pe_config_edits';
const CACHE_KEY = 'pe_config';

type Section = Record<string, unknown>;

const read = (k: string): Section => { try { return JSON.parse(localStorage.getItem(k) || '{}') as Section; } catch { return {}; } };
const write = (k: string, v: Section): void => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } };

/** Локальные правки конфига по секциям (`models`, `materials`, `textures`, …). */
export function configEdits(): Section { return read(EDITS_KEY); }

/** Секции с неопубликованными правками — для счётчика на кнопке публикации. */
export function configDirtyKeys(): string[] {
  return Object.keys(configEdits()).map((k) => 'pe_config:' + k);
}

/**
 * Записать секцию конфига в рабочую копию. Мгновенно и без сети — сервер может быть выключен, это норма.
 * `pe_config` тоже обновляем, чтобы всё, что читает кэш синхронно (ростер, вкладка «Модели», игра),
 * увидело правку сразу же, без перезагрузки.
 */
export function saveConfigSection(section: string, value: unknown): void {
  const edits = read(EDITS_KEY); edits[section] = value; write(EDITS_KEY, edits);
  const cache = read(CACHE_KEY); cache[section] = value; write(CACHE_KEY, cache);
  notifySyncChange();                            // счётчик «Опубликовать (N)» обязан видеть и правки конфига
}

/** Конфиг с наложенными локальными правками (то, что должен видеть редактор и локальная игра). */
export function mergedConfig(base: Section = read(CACHE_KEY)): Section {
  return { ...base, ...read(EDITS_KEY) };
}

/**
 * Опубликовать правки конфига: в ФАЙЛ-источник (`data/*.json`, попадёт в git и на деплой) и в живой конфиг
 * сервера. Порядок тот же, что был у прежних точечных сохранений, — сначала файл, потом живой оверрайд.
 */
export async function publishConfigEdits(): Promise<{ ok: boolean; error?: string; sections: string[] }> {
  const edits = read(EDITS_KEY);
  const sections = Object.keys(edits);
  if (!sections.length) return { ok: true, sections: [] };
  const body = JSON.stringify(edits);
  try {
    for (const url of ['/api/dev/config-file', '/api/dev/config']) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) {
        let msg = 'сервер отказал (' + res.status + ')';
        try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* */ }
        return { ok: false, error: msg, sections };
      }
    }
  } catch { return { ok: false, error: 'сервер недоступен — правки остались локально', sections }; }
  write(EDITS_KEY, {});          // опубликовано → рабочая копия конфига пуста, кэш уже совпадает с сервером
  notifySyncChange();
  return { ok: true, sections };
}
