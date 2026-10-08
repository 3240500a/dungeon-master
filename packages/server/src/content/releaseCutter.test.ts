import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobStore, type BlobStore } from './blobStore.js';
import { releaseCutter } from './releaseCutter.js';
import type { ReleaseInput } from './releaseManifest.js';
import type { ReleaseRecord, Recorded } from './releaseDb.js';

/**
 * ⭐ 08.10 (Д1): НАРЕЗЧИК РЕЛИЗОВ — после правки ждёт тишины (публикация пишет ключ за ключом — один релиз на пачку), режет по одному
 * (повод посреди нарезки — ещё одна после), файлы кладёт ДО записи релиза, одно содержимое — один релиз. База — шпион (сама запись — в
 * `releaseDb.test.ts` против настоящего Postgres), часы — у теста.
 */
let root = '';
let store: BlobStore;
let timers: Array<{ fn: () => void; ms: number } | null>;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dm-cut-')); store = blobStore(root); timers = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(pose: () => Record<string, unknown>) {
  const records: ReleaseRecord[] = [];
  const seen: Array<{ manifestOnDisk: boolean; filesOnDisk: boolean }> = [];
  let seq = 0;
  let lastManifest = '';
  let reads = 0;
  const cutter = releaseCutter({
    readInput: async (): Promise<ReleaseInput> => { reads++; return { config: '{"x":1}', configRev: 'c-1', gameRev: 'g-1', pose: pose() }; },
    store,
    record: async (r): Promise<Recorded> => {
      // порядок: файлы и манифест уже на диске к моменту записи релиза
      seen.push({ manifestOnDisk: store.has(r.manifest), filesOnDisk: true });
      records.push(r);
      if (r.manifest === lastManifest) return { seq, fresh: false };
      lastManifest = r.manifest;
      return { seq: ++seq, fresh: true };
    },
    debounceMs: 100,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (t) => { timers[t as number] = null; },
  });
  const fire = (): void => { const live = timers.filter(Boolean); timers = []; for (const t of live) t!.fn(); };
  return { cutter, records, seen, fire, reads: () => reads };
}

describe('⭐ Д1: нарезчик релизов', () => {
  it('пачка поводов — одна нарезка после тишины', async () => {
    const h = harness(() => ({ pe_clips: [{ n: 1 }] }));
    h.cutter.poke(); h.cutter.poke(); h.cutter.poke();
    expect(timers.filter(Boolean)).toHaveLength(1);
    h.fire();
    await h.cutter.idle();
    expect(h.reads()).toBe(1);
    expect(h.records).toHaveLength(1);
    expect(h.cutter.last()?.fresh).toBe(true);
  });

  it('файлы и манифест — на диске ДО записи релиза', async () => {
    const h = harness(() => ({ pe_clips: [{ n: 1 }, { n: 2 }], pe_anim: {} }));
    const r = await h.cutter.cutNow();
    expect(h.seen[0]!.manifestOnDisk).toBe(true);
    expect(store.has(r.manifest)).toBe(true);
    expect(r.files).toBe(4);   // конфиг, два клипа, pe_anim
    expect(r.newFiles).toBe(4);
  });

  it('то же содержимое — не новый релиз; правка одного клипа — один новый файл', async () => {
    let clips: unknown[] = [{ n: 1 }, { n: 2 }];
    const h = harness(() => ({ pe_clips: clips }));
    const a = await h.cutter.cutNow();
    const b = await h.cutter.cutNow();
    expect(b.fresh).toBe(false);
    expect(b.seq).toBe(a.seq);
    clips = [{ n: 1 }, { n: 3 }];
    const c = await h.cutter.cutNow();
    expect(c.fresh).toBe(true);
    expect(c.seq).toBe(a.seq + 1);
    expect(c.newFiles).toBe(1);
  });

  it('нарезки по одной: вторая начинается после первой; упавшая не рвёт очередь', async () => {
    let n = 0;
    const order: string[] = [];
    const cutter = releaseCutter({
      readInput: async () => {
        const me = ++n;
        order.push(`начало ${me}`);
        await new Promise((r) => setImmediate(r));
        if (me === 1) throw new Error('база легла');
        order.push(`конец ${me}`);
        return { config: '{}', configRev: 'a', gameRev: 'b', pose: { pe_x: me } };
      },
      store,
      record: async () => ({ seq: n, fresh: true }),
    });
    const first = cutter.cutNow();
    const second = cutter.cutNow();
    await expect(first).rejects.toThrow('база легла');
    await second;
    expect(order).toEqual(['начало 1', 'начало 2', 'конец 2']);
  });

  it('⭐ Д3: исключительное действие (уборка) — в очереди нарезок: не рядом с идущей, следующая нарезка — после него', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const cutter = releaseCutter({
      readInput: async () => { order.push('нарезка'); await gate; return { config: '{}', configRev: 'a', gameRev: 'b', pose: {} }; },
      store, record: async () => ({ seq: 1, fresh: true }),
    });
    const cut1 = cutter.cutNow();
    const gc = cutter.exclusive(async () => { order.push('уборка'); return 42; });
    const cut2 = cutter.cutNow();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['нарезка']);
    release();
    await Promise.all([cut1, cut2]);
    expect(await gc).toBe(42);
    expect(order).toEqual(['нарезка', 'уборка', 'нарезка']);
  });

  it('⭐ Д2: арт, чьих файлов нет в хранилище, в релиз не идёт; файлы на месте — идёт', async () => {
    const bundle = store.put(Buffer.from('бандл'.repeat(10)));
    const catalog = store.put(Buffer.from('каталог'));
    let art: ReleaseInput['art'] = { catalog: { name: 'catalog_abi1.bin', sha: catalog.sha, size: catalog.size }, bundles: [{ name: 'x.bundle', sha: 'f'.repeat(64), size: 3 }] };
    const logs: string[] = [];
    const cutter = releaseCutter({
      readInput: async () => ({ config: '{}', configRev: 'a', gameRev: 'b', pose: {}, art: art ? structuredClone(art) : undefined }),
      store, record: async (r) => ({ seq: 1, fresh: true }), log: (m) => logs.push(m),
    });
    const a = await cutter.cutNow();
    expect(logs.some((l) => l.includes('релиз без арта'))).toBe(true);
    const noArt = JSON.parse(readFileSync(store.pathOf(a.manifest), 'utf8')) as { data: { art?: unknown } };
    expect(noArt.data.art).toBeUndefined();
    art = { catalog: { name: 'catalog_abi1.bin', sha: catalog.sha, size: catalog.size }, bundles: [{ name: 'x.bundle', sha: bundle.sha, size: bundle.size }] };
    const b = await cutter.cutNow();
    const withArt = JSON.parse(readFileSync(store.pathOf(b.manifest), 'utf8')) as { data: { art?: { bundles: unknown[] } } };
    expect(withArt.data.art?.bundles).toHaveLength(1);
  });
});
