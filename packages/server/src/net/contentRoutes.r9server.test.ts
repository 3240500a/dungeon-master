import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Сотни запросов по настоящему HTTP за тест; под нагрузкой полного прогона умолчание 5 с — лотерея.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R9-12: АНОНИМНЫЕ РУЧКИ КОНТЕНТА — ИЗ КЭША. `GET /api/pose/rev` на каждый запрос спрашивал базу, а `GET /api/assets/stats`
 * синхронно обходил всё дерево ассетов на главном потоке (тикающем комнаты). Ручки — настоящие (`installContentReads`) за
 * настоящим express, источники — шпионы (обход — настоящий, по временной папке); часы кэша — у теста.
 */
let server: Server;
let base = '';
let t = 0;
const loads = { store: 0, revs: 0, walks: 0 };
let revs: Record<string, number> = { pe_clips: 1 };
let dir = '';
let api: { invalidatePose(): void; invalidateAssets(): void };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-r912-'));
  mkdirSync(join(dir, 'crypt'));
  writeFileSync(join(dir, 'a.glb'), 'x');
  writeFileSync(join(dir, 'crypt', 'b.png'), 'yy');
  const { installContentReads, assetStats } = await import('./contentRoutes.js');
  const app = express();
  api = installContentReads(app, {
    poseStore: async () => { loads.store++; return { pe_clips: [] }; },
    poseRevs: async () => { loads.revs++; return { ...revs }; },
    assetStats: () => { loads.walks++; return assetStats(dir); },
    now: () => t,
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(base + path);
  return { status: r.status, json: await r.json() };
}

describe('⭐ R9-12: ревизии поз и счётчики ассетов — одно чтение на срок кэша', () => {
  it('всплеск в 100 запросов ревизий и 100 счётчиков — одно чтение базы и один обход папки', async () => {
    const all = await Promise.all([
      ...Array.from({ length: 50 }, () => get('/api/pose/rev')),
      ...Array.from({ length: 50 }, () => get('/api/assets/stats')),
    ]);
    for (let i = 0; i < 50; i++) { all.push(await get('/api/pose/rev')); all.push(await get('/api/assets/stats')); }
    expect(loads.revs, 'ревизии из базы').toBe(1);
    expect(loads.walks, 'обход папки ассетов').toBe(1);
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect((await get('/api/assets/stats')).json, 'обход настоящий: файлы по расширениям и подпапкам').toEqual({
      byExt: { glb: 1, png: 1 }, byDir: { crypt: 1 }, bytes: 3,
    });
    expect((await get('/api/pose/rev')).json).toEqual({ pe_clips: 1 });
  });

  it('срок вышел — прочитано заново; запись этим процессом (публикация, заливка) — сразу свежее', async () => {
    revs = { pe_clips: 2 };
    expect((await get('/api/pose/rev')).json, 'в срок — из кэша').toEqual({ pe_clips: 1 });
    api.invalidatePose();
    expect((await get('/api/pose/rev')).json, 'своя публикация видна сразу').toEqual({ pe_clips: 2 });
    writeFileSync(join(dir, 'c.ogg'), 'zzz');
    api.invalidateAssets();
    expect((await get('/api/assets/stats')).json).toMatchObject({ byExt: { glb: 1, png: 1, ogg: 1 }, bytes: 6 });
    const walks = loads.walks;
    t += 60_000;
    await get('/api/assets/stats');
    await get('/api/assets/stats');
    expect(loads.walks, 'срок вышел — один новый обход').toBe(walks + 1);
  });

  it('контроль: тела поз — как прежде, из кэша с ETag (R6-20); повтор с If-None-Match — 304', async () => {
    const r = await fetch(`${base}/api/pose`);
    const etag = r.headers.get('etag')!;
    await r.body?.cancel();
    const again = await fetch(`${base}/api/pose`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(loads.store).toBe(1);
  });
});
