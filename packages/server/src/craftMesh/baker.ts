import { Worker } from 'node:worker_threads';
import type { CraftParts } from '@dm/shared';
import type { FromWorker, ToWorker } from './protocol.js';

/**
 * ХОЗЯИН ПОТОКА ПЕЧИ (главный поток). Печь (`worker.ts`: `three` + построители + экспортёр) поднимается ЛЕНИВО — первой
 * работой, а не на старте процесса; простояла `idleMs` — гасится (память потока возвращается), следующая работа поднимет снова.
 *
 * ⭐ ГЛАВНЫЙ ПОТОК НЕ ПЕЧЁТ НИКОГДА. Здесь только очередь и почта: сборка (~1–3 мс), экспорт (~1–2 мс), холодный старт печи
 * (~2.5 с: разбор `shared` и построителей) — всё в своём потоке, тик комнат одиночного процесса их не видит.
 *
 * Пределы:
 * - `queueMax` — работ одновременно (в печи и ждущих); сверх — `busy` сразу (ручка отвечает 503), очередь не копится;
 * - `jobTimeoutMs` — работа без ответа дольше (печь зависла или захлебнулась) — поток гасится, все его работы — `failed`;
 * - `bootTimeoutMs` — печь не поднялась за срок — то же;
 * - память потока — `resourceLimits` (`maxOldMb`): утечка в построителе роняет печь, а не процесс;
 * - ⭐ ПЕЧЬ НЕ ПОДНИМАЕТСЯ (поток не создан, вышел или упал до «готова», не успел в срок — битая выкладка без tsx, нет памяти) —
 *   ПАУЗА `bootBackoffMs`, удваиваясь до `bootBackoffMaxMs`: работы в паузе отказывают сразу (`failed`, ручка — 503), без нового
 *   потока. Прежде каждый запрос поднимал свой поток (новый изолят V8 — дорого главному потоку) и тут же его терял. Удачный
 *   подъём паузу снимает. Падение уже ПОДНЯТОЙ печи паузы не ставит: следующая работа поднимает новую сразу.
 * Ревизия таблиц модели уходит печи перед первой работой этой ревизии (`ConfigMsg`) — печь своих таблиц не читает.
 */

export interface BakeJob {
  /** Ревизия таблиц модели (`configSetRev` по `CRAFT_MESH_DEPS`). */
  rev: string;
  /** Таблицы этой ревизии — зовётся, только когда печь их ещё не видела. */
  tables: () => Record<string, unknown>;
  /** Подпись вида — в `extras` файла. */
  look: string;
  weaponClass: string;
  hands: number;
  parts: CraftParts;
}

export type BakeResult =
  | { ok: true; glb: Uint8Array }
  /**
   * `unbuildable` — построитель вид не собрал (ответ 422, ключ помнится); `error` — построитель бросил исключение (503: бывает и
   * сбой мгновения — память; повторы одного вида служба считает, `service.ts`); `busy` — очередь полна (503); `failed` — сбой печи (503).
   */
  | { ok: false; kind: 'unbuildable' | 'error' | 'busy' | 'failed'; reason: string };

export interface BakerOptions {
  queueMax?: number;
  jobTimeoutMs?: number;
  bootTimeoutMs?: number;
  idleMs?: number;
  /** Потолок кучи потока печи, МБ. */
  maxOldMb?: number;
  /** Пауза после неудачного подъёма печи, мс (удваивается до `bootBackoffMaxMs`). */
  bootBackoffMs?: number;
  bootBackoffMaxMs?: number;
  /** Поднять поток (тест подставляет свой). */
  spawn?: (opts: { maxOldMb: number }) => Worker;
}

export const BAKER_DEFAULTS = {
  queueMax: 32, jobTimeoutMs: 15_000, bootTimeoutMs: 60_000, idleMs: 15 * 60_000, maxOldMb: 384, bootBackoffMs: 2_000, bootBackoffMaxMs: 60_000,
} as const;

const BOOT_URL = new URL('./workerBoot.mjs', import.meta.url);

/** Поток печи: TS грузит `workerBoot.mjs`; память — под потолком. */
export function spawnBakeWorker(opts: { maxOldMb: number }): Worker {
  return new Worker(BOOT_URL, { resourceLimits: { maxOldGenerationSizeMb: opts.maxOldMb } });
}

interface Pending { resolve: (r: BakeResult) => void; timer: ReturnType<typeof setTimeout> }

export class CraftMeshBaker {
  private readonly o: Required<Omit<BakerOptions, 'spawn'>> & { spawn: NonNullable<BakerOptions['spawn']> };
  private worker: Worker | null = null;
  private ready: Promise<Worker | null> | null = null;
  private sentRev: string | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Пауза после неудачного подъёма: до какого момента (`performance.now`) новые потоки не поднимаются, и её текущая длина. */
  private backoffUntil = 0;
  private backoffMs = 0;
  private counters = { bakes: 0, failed: 0, busy: 0, boots: 0 };

  constructor(opts: BakerOptions = {}) {
    this.o = { ...BAKER_DEFAULTS, ...opts, spawn: opts.spawn ?? spawnBakeWorker };
  }

  /** Что печь сейчас делает — для тестов и `/metrics`. */
  stats(): { alive: boolean; inflight: number; bakes: number; failed: number; busy: number; boots: number; backoffMs: number } {
    return { alive: !!this.worker, inflight: this.inflight, ...this.counters, backoffMs: this.backoffMs };
  }

  async bake(job: BakeJob): Promise<BakeResult> {
    if (this.inflight >= this.o.queueMax) {
      this.counters.busy++;
      return { ok: false, kind: 'busy', reason: 'Печь моделей занята, попробуйте позже' };
    }
    if (!this.worker && performance.now() < this.backoffUntil) return this.fail('Печь моделей не поднимается, попробуйте позже');
    this.inflight++;
    this.cancelIdle();
    try {
      const w = await this.start();
      // Не поднялась — или её успели погасить (остановка, срок чужой работы), пока эта ждала готовности: работа к ней не идёт.
      if (!w || w !== this.worker) return this.fail('Печь моделей не поднялась');
      if (this.sentRev !== job.rev) {
        this.post(w, { t: 'config', rev: job.rev, tables: job.tables() });
        this.sentRev = job.rev;
      }
      const id = ++this.seq;
      const r = await new Promise<BakeResult>((resolve) => {
        const timer = setTimeout(() => {
          // Печь не ответила в срок — зависла или захлебнулась: гасим её целиком, её работы отказываются (`stop`).
          this.stop('работа печи не уложилась в срок');
        }, this.o.jobTimeoutMs);
        this.pending.set(id, { resolve, timer });
        this.post(w, { t: 'bake', id, rev: job.rev, look: job.look, weaponClass: job.weaponClass, hands: job.hands, parts: job.parts });
      });
      if (r.ok) this.counters.bakes++;
      else if (r.kind === 'failed') this.counters.failed++;
      return r;
    } finally {
      this.inflight--;
      if (this.inflight === 0) this.armIdle();
    }
  }

  /** Погасить печь (остановка процесса, тест). Ждущие работы — `failed`. */
  async close(): Promise<void> {
    this.cancelIdle();
    const w = this.worker;
    this.stop('печь остановлена');
    if (w) await w.terminate().catch(() => undefined);
  }

  /** Подъём не удался: пауза до следующей попытки, каждая неудача подряд — вдвое длиннее (до потолка). */
  private bootFailed(): void {
    this.backoffMs = Math.min(this.o.bootBackoffMaxMs, this.backoffMs ? this.backoffMs * 2 : this.o.bootBackoffMs);
    this.backoffUntil = performance.now() + this.backoffMs;
  }

  private fail(reason: string): BakeResult {
    this.counters.failed++;
    return { ok: false, kind: 'failed', reason };
  }

  private post(w: Worker, m: ToWorker): void {
    w.postMessage(m);
  }

  /** Поднять печь, если её нет; готовая печь — или `null`. Одна попытка на всех ждущих. */
  private start(): Promise<Worker | null> {
    if (this.worker && this.ready) return this.ready;
    this.counters.boots++;
    let w: Worker;
    try { w = this.o.spawn({ maxOldMb: this.o.maxOldMb }); }
    catch (e) {
      console.warn('[craft-mesh] поток печи не создан:', e instanceof Error ? e.message : e);
      this.bootFailed();
      return Promise.resolve(null);
    }
    w.unref();   // печь не держит процесс живым: остановка сервера и тесты её не ждут
    this.worker = w;
    this.sentRev = null;
    let up = false;
    this.ready = new Promise<Worker | null>((resolve) => {
      const timer = setTimeout(() => { this.bootFailed(); this.stop('печь не поднялась в срок'); resolve(null); }, this.o.bootTimeoutMs);
      w.on('message', (m: FromWorker) => {
        if (m.t === 'ready') { clearTimeout(timer); up = true; this.backoffMs = 0; this.backoffUntil = 0; resolve(w); return; }
        const p = this.pending.get(m.id);
        if (!p) return;   // ответ на работу, отказанную по сроку
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m.t === 'done' ? { ok: true, glb: m.glb } : { ok: false, kind: m.kind, reason: m.reason });
      });
      const gone = (why: string): void => {
        clearTimeout(timer);
        if (!up && this.worker === w) this.bootFailed();   // вышла до «готова» — подъём не удался
        if (this.worker === w) this.stop(why);
        resolve(null);
      };
      w.on('error', (e) => { console.warn('[craft-mesh] печь упала:', e instanceof Error ? e.message : e); gone('печь упала'); });
      w.on('exit', (code) => gone(`печь вышла (${code})`));
    });
    return this.ready;
  }

  /** Снять текущую печь: работы — `failed`, следующая работа поднимет новую. */
  private stop(why: string): void {
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    this.sentRev = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, kind: 'failed', reason: `Печь моделей: ${why}` });
      this.pending.delete(id);
    }
    if (w) void w.terminate().catch(() => undefined);
  }

  private armIdle(): void {
    this.cancelIdle();
    if (!this.worker) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.inflight === 0) this.stop('простой'); }, this.o.idleMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }
}
