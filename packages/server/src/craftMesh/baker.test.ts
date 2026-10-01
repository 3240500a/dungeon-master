import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { CraftParts } from '@dm/shared';
import { CraftMeshBaker, type BakeJob, type BakerOptions } from './baker.js';
import type { FromWorker, ToWorker } from './protocol.js';

/**
 * U6b: ХОЗЯИН ПОТОКА ПЕЧИ. Поток — подделка (почта и выход), поэтому проверяется сам хозяин: печь поднимается ЛЕНИВО, таблицы
 * новой ревизии уходят ей один раз, очередь с потолком (сверх — `busy` сразу), упавшая или зависшая печь отказывает свои работы и
 * поднимается заново следующей работой, простой гасит поток. Настоящий поток — в `net/craftMeshRoutes.test.ts`.
 */
class FakeWorker extends EventEmitter {
  posted: ToWorker[] = [];
  terminated = false;
  constructor(private readonly auto: { ready?: boolean; answer?: (m: ToWorker & { t: 'bake' }) => FromWorker | null } = {}) {
    super();
    if (auto.ready !== false) queueMicrotask(() => this.emit('message', { t: 'ready' } satisfies FromWorker));
  }
  postMessage(m: ToWorker): void {
    this.posted.push(m);
    if (m.t === 'bake' && this.auto.answer) {
      const r = this.auto.answer(m);
      if (r) setTimeout(() => this.emit('message', r), 1);
    }
  }
  terminate(): Promise<number> {
    if (!this.terminated) { this.terminated = true; setTimeout(() => this.emit('exit', 1), 0); }
    return Promise.resolve(1);
  }
  unref(): void {}
}

const parts = { strike: { id: 'a', step: 1 }, grip: { id: 'b', step: 1 }, bind: { id: 'c', step: 1 }, head: { id: 'd', step: 1 } } as CraftParts;
const job = (rev = 'r1'): BakeJob => ({ rev, tables: () => ({ rev }), look: 'x', weaponClass: 'sword', hands: 1, parts });
const ok = (m: { id: number }): FromWorker => ({ t: 'done', id: m.id, glb: new Uint8Array([1, 2, 3]) });

function baker(o: BakerOptions & { make?: () => FakeWorker } = {}): { b: CraftMeshBaker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const b = new CraftMeshBaker({
    ...o,
    spawn: () => { const w = o.make ? o.make() : new FakeWorker({ answer: ok }); workers.push(w); return w as unknown as Worker; },
  });
  return { b, workers };
}

describe('хозяин потока печи', () => {
  it('⭐ печь поднимается первой работой, а не заранее; таблицы ревизии — один раз, перед работой', async () => {
    const { b, workers } = baker();
    expect(workers.length, 'до первой работы потока нет').toBe(0);
    expect(await b.bake(job())).toEqual({ ok: true, glb: new Uint8Array([1, 2, 3]) });
    expect(await b.bake(job())).toMatchObject({ ok: true });
    expect(await b.bake(job('r2'))).toMatchObject({ ok: true });
    expect(workers.length).toBe(1);
    expect(workers[0]!.posted.map((m) => m.t === 'config' ? `config:${m.rev}` : 'bake')).toEqual(['config:r1', 'bake', 'bake', 'config:r2', 'bake']);
    await b.close();
  });

  it('отказ построителя доходит как есть (`unbuildable`)', async () => {
    const { b } = baker({ make: () => new FakeWorker({ answer: (m) => ({ t: 'fail', id: m.id, kind: 'unbuildable', reason: 'нет' }) }) });
    expect(await b.bake(job())).toEqual({ ok: false, kind: 'unbuildable', reason: 'нет' });
    await b.close();
  });

  it('⭐ очередь с потолком: сверх `queueMax` — `busy` сразу, без потока и без ожидания', async () => {
    const { b, workers } = baker({ queueMax: 2, make: () => new FakeWorker({ answer: () => null }) });
    const a1 = b.bake(job()), a2 = b.bake(job());
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'busy' });
    expect(b.stats()).toMatchObject({ inflight: 2, busy: 1 });
    await b.close();
    expect(await a1).toMatchObject({ ok: false, kind: 'failed' });
    expect(await a2).toMatchObject({ ok: false, kind: 'failed' });
    expect(workers.length).toBe(1);
  });

  it('⭐ упавшая печь отказывает свои работы, следующая работа поднимает новую (и шлёт ей таблицы заново)', async () => {
    const { b, workers } = baker({ make: () => new FakeWorker({ answer: workers.length === 0 ? () => null : ok }) });
    const pending = b.bake(job());
    await new Promise((r) => setTimeout(r, 5));
    workers[0]!.emit('error', new Error('boom'));
    expect(await pending).toMatchObject({ ok: false, kind: 'failed' });
    expect(workers[0]!.terminated).toBe(true);
    const next = await b.bake(job());
    expect(next).toMatchObject({ ok: true });
    expect(workers.length).toBe(2);
    expect(workers[1]!.posted[0]).toMatchObject({ t: 'config', rev: 'r1' });
    await b.close();
  });

  it('работа без ответа дольше срока — печь гасится, работа отказывается', async () => {
    const { b, workers } = baker({ jobTimeoutMs: 30, make: () => new FakeWorker({ answer: () => null }) });
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed', reason: expect.stringMatching(/срок/) });
    expect(workers[0]!.terminated).toBe(true);
    expect(b.stats().alive).toBe(false);
    await b.close();
  });

  it('печь не поднялась за срок — отказ, без вечного ожидания', async () => {
    const { b } = baker({ bootTimeoutMs: 30, make: () => new FakeWorker({ ready: false }) });
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed' });
    await b.close();
  });

  it('простой гасит поток — память печи возвращается; следующая работа поднимает снова', async () => {
    const { b, workers } = baker({ idleMs: 20 });
    expect(await b.bake(job())).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(workers[0]!.terminated, 'погашена простоем').toBe(true);
    expect(await b.bake(job())).toMatchObject({ ok: true });
    expect(workers.length).toBe(2);
    await b.close();
  });

  it('поток не создаётся (нет tsx, нет памяти) — отказ, а не исключение в ручку', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = new CraftMeshBaker({ spawn: () => { throw new Error('no tsx'); } });
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed' });
    warn.mockRestore();
  });

  it('⭐ печь не поднимается (битая выкладка) — ПАУЗА: работы отказывают сразу, без нового потока на каждый запрос; срок вышел — пробует снова', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let spawns = 0;
    const b = new CraftMeshBaker({ bootBackoffMs: 40, spawn: () => { spawns++; throw new Error('no tsx'); } });
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed' });
    for (let i = 0; i < 5; i++) expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed', reason: expect.stringMatching(/не поднимается/) });
    expect(spawns, 'пять работ подряд — ни одного нового потока').toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed' });
    expect(spawns, 'пауза вышла — одна новая попытка').toBe(2);
    for (let i = 0; i < 3; i++) await b.bake(job());
    expect(spawns, 'вторая неудача — пауза снова (и длиннее)').toBe(2);
    expect(b.stats().backoffMs).toBeGreaterThan(40);
    warn.mockRestore();
  });

  it('⭐ поток упал на подъёме (вышел до «готова») — та же пауза; удачный подъём её снимает', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let bad = true;
    const { b, workers } = baker({
      bootBackoffMs: 30,
      make: () => {
        if (!bad) return new FakeWorker({ answer: ok });
        const w = new FakeWorker({ ready: false });
        setTimeout(() => w.emit('exit', 1), 1);
        return w;
      },
    });
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed' });
    expect(await b.bake(job())).toMatchObject({ ok: false, kind: 'failed' });
    expect(workers.length, 'во время паузы потоков не плодим').toBe(1);
    bad = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(await b.bake(job())).toMatchObject({ ok: true });
    expect(b.stats().backoffMs, 'поднялась — пауза снята').toBe(0);
    await b.close();
    warn.mockRestore();
  });

  it('сбой построителя доходит отдельным видом (`error`): ручка отличает его от несобираемого вида', async () => {
    const { b } = baker({ make: () => new FakeWorker({ answer: (m) => ({ t: 'fail', id: m.id, kind: 'error', reason: 'boom' }) }) });
    expect(await b.bake(job())).toEqual({ ok: false, kind: 'error', reason: 'boom' });
    await b.close();
  });
});
