import { configRev } from '@dm/shared';

/**
 * ⭐ C-09: ПОВЕРХ КАКОЙ ПРАВДЫ СЕРВЕРА РАБОЧАЯ КОПИЯ РЕДАКТОРА.
 *
 * Редактор держит рабочую копию всех таблиц (`data`) и шлёт на сервер таблицу ЦЕЛИКОМ. Живой конфиг грузился один раз на старте: не ответил
 * сервер (перезапуск под `tsx watch` — на каждую правку кода; машина недоступна) — копия оставалась встроенными дефолтами, и «Применить»
 * (с повтором как раз на перезапуск сервера) заменяло оверрайд таблицы дефолтами: все прежние правки `balance` (цены кузницы, сброса, лавки,
 * ковка, штраф смерти…) откатывались у всех игроков, кроме поля, которое правили. То же без сбоя — со старым снимком (таблицу сохранили в
 * другой вкладке, инструментом «Ковка → Клинки», с другой машины).
 *
 * Теперь: пока живой конфиг не загружен (`loaded`), загрузка повторяется (`loadLiveConfig`), а тела записи нет (`body` → null) — не уходит ни
 * «Применить», ни «в файл», ни запись инструментов. Загружен — тело несёт ревизии загруженного (`__baseRev`, `configRev`), сервер сверяет их с
 * живыми и отказывает (409) правке поверх чужой; своя принятая запись сдвигает базу ревизиями из ответа сервера (`saved`).
 */
export class LiveConfigBase {
  private readonly revs = new Map<string, string>();
  private ready = false;

  /** Живой конфиг сервера загружен: записи есть поверх чего. */
  get loaded(): boolean { return this.ready; }

  /** Принят снимок `/api/config`: база каждой таблицы — её ревизия. */
  accept(snapshot: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(snapshot)) this.revs.set(key, configRev(value));
    this.ready = true;
  }

  /** Тело записи: значения и `__baseRev` — ревизии, поверх которых правка. `null` — живой конфиг не загружен: писать нельзя. */
  body(values: Record<string, unknown>): Record<string, unknown> | null {
    if (!this.ready) return null;
    const base: Record<string, string> = {};
    for (const key of Object.keys(values)) base[key] = this.revs.get(key) ?? '';
    return { ...values, __baseRev: base };
  }

  /** Сервер принял запись (или сброс): ревизии таблиц теперь — из его ответа (`rev`). Нет ответа — база прежняя (следующая запись — 409). */
  saved(rev: unknown): void {
    if (!rev || typeof rev !== 'object') return;
    for (const [key, r] of Object.entries(rev as Record<string, unknown>)) if (typeof r === 'string') this.revs.set(key, r);
  }
}

/** Паузы между попытками загрузить живой конфиг, мс (последняя — дальше без роста): `tsx watch` поднимает сервер за 1–2 с, машина — дольше. */
export const LOAD_RETRY_MS = [1000, 2000, 4000, 8000, 15000] as const;

/**
 * Загрузить живой конфиг: не вышло — повтор с паузой (`LOAD_RETRY_MS`), пока не выйдет. `loaded` — снимок принят (`live.accept` уже позван);
 * `failed(n, ms)` — попытка `n` не удалась, следующая через `ms`. Возвращает отмену.
 */
export function loadLiveConfig(
  fetchSnapshot: () => Promise<Record<string, unknown>>,
  live: LiveConfigBase,
  on: { loaded: (snapshot: Record<string, unknown>) => void; failed: (attempt: number, retryInMs: number) => void },
): () => void {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tryOnce = (): void => {
    timer = undefined;
    fetchSnapshot().then((snapshot) => {
      if (stopped) return;
      live.accept(snapshot);
      on.loaded(snapshot);
    }, () => {
      if (stopped) return;
      const ms = LOAD_RETRY_MS[Math.min(attempt, LOAD_RETRY_MS.length - 1)]!;
      attempt++;
      on.failed(attempt, ms);
      timer = setTimeout(tryOnce, ms);
    });
  };
  tryOnce();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
