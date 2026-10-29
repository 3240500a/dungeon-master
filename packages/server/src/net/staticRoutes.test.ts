import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installStatic } from './staticRoutes.js';

/**
 * ⭐ С1 (29.10): ИГРОВОЙ ПРОЦЕСС РАЗДАЁТ ТОЛЬКО МОДЕЛИ И ТЕКСТУРЫ (`/assets`). Веб-клиента он не раздаёт: ни страниц, ни бандла, ни
 * SPA-фолбэка — сервер не знает, какой клиент его рисует. Настоящий express, временная папка моделей.
 */
let root = '';
let server: Server;
let base = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dm-static-'));
  const assetsDir = join(root, 'server-assets');
  mkdirSync(join(assetsDir, 'tiles'), { recursive: true });
  writeFileSync(join(assetsDir, 'knight.glb'), Buffer.from('glTF-model'));
  const app = express();
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  installStatic(app, { assetsDir, dev: false });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; type: string; body: string }> {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
}

describe('⭐ С1: /assets — модели сервера, веб-клиента нет', () => {
  it('модели: есть — 200, нет — честный JSON 404', async () => {
    const glb = await get('/assets/knight.glb');
    expect(glb.status).toBe(200);
    expect(glb.body).toBe('glTF-model');
    const missing = await get('/assets/missing.glb');
    expect(missing.status).toBe(404);
    expect(missing.type).toMatch(/json/);
    expect((await get('/assets/tiles/nope.png')).status).toBe(404);
  });

  it('страниц веб-клиента и SPA-фолбэка нет: /game3d.html, /, глубокая ссылка — 404, API не задет', async () => {
    expect((await get('/game3d.html')).status).toBe(404);
    expect((await get('/')).status).toBe(404);
    expect((await get('/some/deep/link')).status).toBe(404);
    expect((await get('/api/health')).status).toBe(200);
  });
});
