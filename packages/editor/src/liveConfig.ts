import { ConfigRegistry, configRev, defaultConfigData } from '@dm/shared';

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
 *
 * ⭐ R22-08: и САМИ ЖИВЫЕ ТАБЛИЦЫ, поверх которых база (`value`): правило поверх таблиц (D4) для правки проверяется над ними — как проверит
 * сервер (над живым кандидатом), а не над неприменёнными таблицами рабочей копии. База и живое значение таблицы двигаются только вместе с
 * ответом сервера: принятая запись (`saved` — присланное), перечитанная после сброса таблица (`adopt`).
 */
export class LiveConfigBase {
  private readonly revs = new Map<string, string>();
  private readonly values = new Map<string, unknown>();
  private ready = false;

  /** Живой конфиг сервера загружен: записи есть поверх чего. */
  get loaded(): boolean { return this.ready; }

  /** Принят снимок `/api/config`: база каждой таблицы — её ревизия (и сама таблица — копией: рабочая копия правится на месте). */
  accept(snapshot: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(snapshot)) this.adopt(key, value);
    this.ready = true;
  }

  /** ⭐ R22-08: одна таблица — такая, какой её сейчас держит сервер (перечитана после сброса): база записи и живое значение. */
  adopt(key: string, value: unknown): void {
    this.revs.set(key, configRev(value));
    this.values.set(key, structuredClone(value));
  }

  /** ⭐ R22-08: живая таблица сервера, поверх которой база (`undefined` — не загружена). Копия: править её нельзя. */
  value(key: string): unknown {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : undefined;
  }

  /** Тело записи: значения и `__baseRev` — ревизии, поверх которых правка. `null` — живой конфиг не загружен: писать нельзя. */
  body(values: Record<string, unknown>): Record<string, unknown> | null {
    if (!this.ready) return null;
    const base: Record<string, string> = {};
    for (const key of Object.keys(values)) base[key] = this.revs.get(key) ?? '';
    return { ...values, __baseRev: base };
  }

  /**
   * Сервер принял запись: ревизии таблиц теперь — из его ответа (`rev`), живые таблицы — присланные (`sent`: сервер держит ровно их). Нет ответа —
   * база прежняя (следующая запись — 409). ⚠ R22-08: сброс сюда не ходит — его таблицу знает только сервер (`adopt` после перечитывания).
   */
  saved(rev: unknown, sent?: Record<string, unknown>): void {
    if (!rev || typeof rev !== 'object') return;
    for (const [key, r] of Object.entries(rev as Record<string, unknown>)) {
      if (typeof r !== 'string') continue;
      this.revs.set(key, r);
      if (sent && Object.prototype.hasOwnProperty.call(sent, key)) this.values.set(key, structuredClone(sent[key]));
    }
  }
}

/**
 * ⭐ R22-01: РАБОЧАЯ КОПИЯ ДО ОТВЕТА СЕРВЕРА — встроенные файлы данных, разобранные схемой КАЖДОЙ таблицы, но без правила поверх таблиц (D4).
 * Файлы, вместе его нарушающие (правка одного `data/*.json`, слияние двух годных правок), сервер собирает с зажимом и ИНЦИДЕНТОМ «поправить в
 * редакторе» и работает, а редактор бросал на старте модуля (`registry.loadAll()`) и не открывался вовсе. Правило судят запись (`validated`
 * канала — над живым сервера) и сборка сервера; до загрузки живого запись закрыта (C-09), так что копия здесь — только вид.
 */
export function bundledWorkingCopy(raw: Record<string, unknown> = defaultConfigData): Record<string, unknown> {
  const reg = new ConfigRegistry();
  reg.loadAll(raw, { cross: false });
  return reg.snapshot() as unknown as Record<string, unknown>;
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
