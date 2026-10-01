import type { CraftParts } from '@dm/shared';

/** Кадры между главным потоком (`baker.ts`) и потоком печи (`worker.ts`). Только типы — модуль ничего не грузит. */

/** Таблицы модели новой ревизии: печь пересобирает свой реестр (`depsRegistry`). Идёт перед первой работой этой ревизии. */
export interface ConfigMsg { t: 'config'; rev: string; tables: Record<string, unknown> }
/** Испечь вид. `rev` — ревизия таблиц, с которой работа поставлена: печь на другой отвечает отказом, а не чужой моделью. */
export interface BakeMsg { t: 'bake'; id: number; rev: string; look: string; weaponClass: string; hands: number; parts: CraftParts }
export type ToWorker = ConfigMsg | BakeMsg;

export type FromWorker =
  | { t: 'ready' }
  | { t: 'done'; id: number; glb: Uint8Array }
  /**
   * `unbuildable` — построитель вид не собрал (вид несобираем на этой ревизии); `error` — построитель бросил исключение (подробность —
   * в журнал потока, наружу — общая фраза); `failed` — сбой печи (не та ревизия конфига).
   */
  | { t: 'fail'; id: number; kind: 'unbuildable' | 'error' | 'failed'; reason: string };
