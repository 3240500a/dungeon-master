import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * КЭШ ИСПЕЧЁННЫХ МОДЕЛЕЙ (GLB и DMCM). Ключ — штамп кода печи + ревизия таблиц модели + подпись вида (+ формат, `service.ts`): правка
 * любой таблицы модели или кода построителя даёт новый ключ, старые записи просто перестают спрашиваться и вытесняются.
 * ⭐ 08.10 (Ф4): LRU в памяти ОБЩИЙ на оба формата — их разводит ключ (у DMCM свой хвост `|bin1`), а не кэш; на диске у формата своё
 * расширение (`CacheExt`), заданное вызывающим.
 *
 * - ПАМЯТЬ — LRU с потолком по БАЙТАМ и по числу записей (модель — 30…140 КБ; 32 МБ — сотни видов). Чтение освежает запись.
 * - ДИСК — необязательный (`dir`): переживает рестарт и деплой без смены кода. Имя файла — sha256 ключа; запись — во временный
 *   файл и переименованием (читатель не увидит половину). Потолок по числу файлов (`diskMax`): сверх — сносятся самые старые
 *   по времени изменения. Весь ввод-вывод асинхронный — главный поток не ждёт диска. Сбой диска — промах, не ошибка ответа.
 * - ⚠ СЧЁТ И ЧИСТКА — ТОЛЬКО СВОИ ФАЙЛЫ (`OWN_FILE`: 64 hex + `.glb` или `.dmcm`). Папку задаёт выкладка (`DM_CRAFT_MESH_CACHE_DIR`), и если её
 *   направили туда, где лежат настоящие модели (`packages/server/assets`), чистка по «всем *.glb» сносила бы их как старейшие.
 *   Временный файл, брошенный сбоем посреди записи (`OWN_TMP`), сносится, когда он старше `TMP_STALE_MS`, — свежий может писать
 *   другой процесс с той же папкой.
 */

export interface GlbCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  /** Папка дискового кэша; нет — только память. */
  dir?: string;
  /** Потолок файлов на диске. */
  diskMax?: number;
}

export const GLB_CACHE_DEFAULTS = { maxBytes: 32 * 1024 * 1024, maxEntries: 1024, diskMax: 4000 } as const;

/** Расширение файла на диске по формату: GLB — `glb`, двоичный меш DMCM v1 — `dmcm`. Потолок `diskMax` — общий на оба. */
export type CacheExt = 'glb' | 'dmcm';
const fileOf = (key: string, ext: CacheExt): string => `${createHash('sha256').update(key).digest('hex')}.${ext}`;
/** Свой файл кэша: имя — sha256 ключа и расширение формата (`fileOf`). Чужое в папке кэша не считается и не сносится. */
const OWN_FILE = /^[0-9a-f]{64}\.(?:glb|dmcm)$/;
/** Свой временный файл записи (`putDisk`): `<sha256>.<расширение>.<pid>.<8 hex>.tmp`. */
const OWN_TMP = /^[0-9a-f]{64}\.(?:glb|dmcm)\.\d+\.[0-9a-f]{8}\.tmp$/;
/** Временный файл старше этого брошен сбоем (запись модели — миллисекунды): сносится при пересчёте папки. */
export const TMP_STALE_MS = 10 * 60_000;

export class GlbCache {
  private readonly mem = new Map<string, Uint8Array>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly dir: string | undefined;
  private readonly diskMax: number;
  /** Сколько файлов на диске (по нашему счёту; первый вызов — по папке). */
  private diskCount: number | null = null;
  private pruning: Promise<void> | null = null;
  private counters = { hits: 0, misses: 0, diskHits: 0, diskWrites: 0, diskErrors: 0 };

  constructor(o: GlbCacheOptions = {}) {
    this.maxBytes = o.maxBytes ?? GLB_CACHE_DEFAULTS.maxBytes;
    this.maxEntries = o.maxEntries ?? GLB_CACHE_DEFAULTS.maxEntries;
    this.dir = o.dir || undefined;
    this.diskMax = o.diskMax ?? GLB_CACHE_DEFAULTS.diskMax;
  }

  get hasDisk(): boolean { return !!this.dir; }

  stats(): { entries: number; bytes: number; hits: number; misses: number; diskHits: number; diskWrites: number; diskErrors: number } {
    return { entries: this.mem.size, bytes: this.bytes, ...this.counters };
  }

  /** Из памяти (освежает запись в LRU). */
  get(key: string): Uint8Array | undefined {
    const v = this.mem.get(key);
    if (!v) { this.counters.misses++; return undefined; }
    this.mem.delete(key);
    this.mem.set(key, v);
    this.counters.hits++;
    return v;
  }

  /** В память; старейшие вытесняются, пока не влезет. Запись больше всего потолка не кладётся. */
  set(key: string, glb: Uint8Array): void {
    const old = this.mem.get(key);
    if (old) { this.mem.delete(key); this.bytes -= old.byteLength; }
    if (glb.byteLength > this.maxBytes) return;
    this.mem.set(key, glb);
    this.bytes += glb.byteLength;
    while (this.bytes > this.maxBytes || this.mem.size > this.maxEntries) {
      const [k, v] = this.mem.entries().next().value as [string, Uint8Array];
      this.mem.delete(k);
      this.bytes -= v.byteLength;
    }
  }

  /** С диска (и в память). Нет диска, файла или файл не читается — `undefined`. `ext` — расширение формата ключа. */
  async getDisk(key: string, ext: CacheExt = 'glb'): Promise<Uint8Array | undefined> {
    if (!this.dir) return undefined;
    try {
      const buf = await readFile(join(this.dir, fileOf(key, ext)));
      const glb = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      this.set(key, glb);
      this.counters.diskHits++;
      return glb;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.counters.diskErrors++;
      return undefined;
    }
  }

  /** На диск (если он есть). Сбой — только счётчик: ответ уже ушёл из памяти. */
  async putDisk(key: string, glb: Uint8Array, ext: CacheExt = 'glb'): Promise<void> {
    if (!this.dir) return;
    const name = fileOf(key, ext);
    const tmp = join(this.dir, `${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, glb);
      await rename(tmp, join(this.dir, name));
      this.counters.diskWrites++;
      if (this.diskCount === null) this.diskCount = (await this.ownFiles()).length;
      else this.diskCount++;
      if (this.diskCount > this.diskMax) await this.prune();
    } catch {
      this.counters.diskErrors++;
      await unlink(tmp).catch(() => undefined);
    }
  }

  /**
   * Свои файлы кэша в папке (`OWN_FILE`); заодно сносит свои временные файлы, брошенные сбоем записи (старше `TMP_STALE_MS`).
   * Чужое в папке не трогается.
   */
  private async ownFiles(): Promise<string[]> {
    const dir = this.dir!;
    const all = await readdir(dir);
    const now = Date.now();
    await Promise.all(all.filter((f) => OWN_TMP.test(f)).map(async (f) => {
      const t = await stat(join(dir, f)).then((s) => s.mtimeMs, () => now);
      if (now - t > TMP_STALE_MS) await unlink(join(dir, f)).catch(() => undefined);
    }));
    return all.filter((f) => OWN_FILE.test(f));
  }

  /** Снести самые старые СВОИ файлы до 90 % потолка. Одна чистка за раз. */
  private prune(): Promise<void> {
    this.pruning ??= (async () => {
      const dir = this.dir!;
      const files = await this.ownFiles();
      const aged = await Promise.all(files.map(async (f) => ({ f, t: await stat(join(dir, f)).then((s) => s.mtimeMs, () => 0) })));
      aged.sort((a, b) => a.t - b.t);
      const keep = Math.floor(this.diskMax * 0.9);
      const drop = aged.slice(0, Math.max(0, aged.length - keep));
      await Promise.all(drop.map(({ f }) => unlink(join(dir, f)).catch(() => undefined)));
      this.diskCount = aged.length - drop.length;
    })().finally(() => { this.pruning = null; });
    return this.pruning;
  }
}
