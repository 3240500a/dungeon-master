import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { blobStore, isSha, sha256 } from './blobStore.js';

/** ⭐ 08.10 (Д1): хранилище по хэшу — имя = содержимое, запись атомарна, крупное — ещё и сжатой копией. */
let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dm-blobs-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('⭐ Д1: хранилище контента по хэшу', () => {
  it('кладёт под sha256 в папку по первым двум знакам; второй раз — не пишет', () => {
    const st = blobStore(root);
    const bytes = Buffer.from('{"a":1}');
    const r = st.put(bytes);
    expect(r).toEqual({ sha: sha256(bytes), size: bytes.length, fresh: true });
    expect(st.pathOf(r.sha)).toBe(join(root, 'b', r.sha.slice(0, 2), r.sha));
    expect(readFileSync(st.pathOf(r.sha)).equals(bytes)).toBe(true);
    expect(st.has(r.sha)).toBe(true);
    expect(st.put(bytes).fresh).toBe(false);
  });

  it('крупный сжимаемый файл — со сжатой копией (она распаковывается в него же); мелкий — без', () => {
    const st = blobStore(root);
    const big = Buffer.from(JSON.stringify({ keys: Array.from({ length: 400 }, (_, i) => [i, i * 0.5, 'Hips']) }));
    const r = st.put(big);
    const gz = st.gzPathOf(r.sha);
    expect(gz).not.toBeNull();
    expect(gunzipSync(readFileSync(gz!)).equals(big)).toBe(true);
    expect(st.gzPathOf(st.put(Buffer.from('x')).sha)).toBeNull();
  });

  it('не оставляет временных файлов; чужое имя — не путь', () => {
    const st = blobStore(root);
    const r = st.put(Buffer.alloc(2048, 7));
    const dir = join(root, 'b', r.sha.slice(0, 2));
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(isSha(r.sha)).toBe(true);
    expect(isSha('../../etc/passwd')).toBe(false);
    expect(st.has('../../x')).toBe(false);
    expect(() => st.pathOf('..')).toThrow();
    expect(existsSync(join(root, 'b'))).toBe(true);
  });
});
