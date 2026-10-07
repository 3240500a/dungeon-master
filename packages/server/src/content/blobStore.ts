import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * ⭐ 08.10 (Д1): ХРАНИЛИЩЕ КОНТЕНТА ПО ХЭШУ (план «Обновление контента без пересборки клиента»). Файл лежит под своим sha256
 * (`<root>/b/<первые 2 знака>/<sha256>`) и не переписывается никогда: имя = содержимое, поэтому его можно кэшировать навсегда (у клиента
 * на диске, у CDN — `immutable`), а правка — это новый файл рядом. Рядом с крупным файлом — его gzip (`<sha>.gz`): отдаём его тем, кто
 * понимает gzip (клиент проверяет sha256 уже распакованного). Запись — во временный файл и переименованием: оборванная запись не оставит
 * под именем-хэшем половину файла.
 */
export interface PutResult { sha: string; size: number; fresh: boolean }

export interface BlobStore {
  readonly root: string;
  /** Положить байты; уже лежат (то же имя и размер) — ничего не пишем (`fresh: false`). */
  put(bytes: Buffer): PutResult;
  has(sha: string): boolean;
  /** Путь файла (проверенного `isSha`). */
  pathOf(sha: string): string;
  /** Путь сжатой копии или `null` — её нет (мелкий или несжимаемый файл). */
  gzPathOf(sha: string): string | null;
}

/** Мельче — не сжимаем: заголовок gzip съест выигрыш, а запрос мелкого файла и так дешёв. */
const GZ_MIN_BYTES = 512;
/** Сжатая копия нужна, только если она заметно меньше. */
const GZ_MAX_RATIO = 0.9;

export function isSha(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Записать атомарно: временный файл рядом → переименование (на одном томе это одна операция). */
function writeAtomic(path: string, bytes: Buffer): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
  writeFileSync(tmp, bytes);
  try { renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

export function blobStore(root: string): BlobStore {
  const dirOf = (sha: string): string => join(root, 'b', sha.slice(0, 2));
  const pathOf = (sha: string): string => {
    if (!isSha(sha)) throw new Error(`не sha256: ${String(sha).slice(0, 80)}`);
    return join(dirOf(sha), sha);
  };
  return {
    root,
    pathOf,
    has: (sha) => isSha(sha) && existsSync(pathOf(sha)),
    gzPathOf: (sha) => {
      const p = pathOf(sha) + '.gz';
      return existsSync(p) ? p : null;
    },
    put(bytes) {
      const sha = sha256(bytes);
      const path = pathOf(sha);
      if (existsSync(path) && statSync(path).size === bytes.length) return { sha, size: bytes.length, fresh: false };
      mkdirSync(dirOf(sha), { recursive: true });
      // Сжатая копия — до файла: кто увидел файл, уже может получить и её.
      if (bytes.length >= GZ_MIN_BYTES) {
        const gz = gzipSync(bytes, { level: 9 });
        if (gz.length <= bytes.length * GZ_MAX_RATIO) writeAtomic(path + '.gz', gz);
      }
      writeAtomic(path, bytes);
      return { sha, size: bytes.length, fresh: true };
    },
  };
}
