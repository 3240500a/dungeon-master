import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installStatic } from './staticRoutes.js';

/**
 * ⭐ R10-03: СОБРАННЫЙ КЛИЕНТ ГРУЗИТСЯ С ИГРОВОГО ПРОЦЕССА. Vite кладёт бандл в `dist/assets/` (`/assets/game3d-<хэш>.js`), а
 * `/assets` занимала раздача моделей сервера со своим 404 на всё, чего нет у неё: страница приходила, её скрипт — JSON 404, и
 * стенд `game3d.html`, поз-редактор и каждый ленивый кусок бандла в любой собранной выкладке были белым экраном. Настоящий express,
 * временные папки: модели сервера и `client/dist` с тем же раскладом, что даёт сборка.
 */
let root = '';
let assetsDir = '';
let clientDist = '';
let server: Server;
let base = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dm-r1003-'));
  assetsDir = join(root, 'server-assets');
  clientDist = join(root, 'dist');
  mkdirSync(join(assetsDir, 'tiles'), { recursive: true });
  mkdirSync(join(clientDist, 'assets'), { recursive: true });
  writeFileSync(join(assetsDir, 'knight.glb'), Buffer.from('glTF-model'));
  writeFileSync(join(clientDist, 'game3d.html'), '<!doctype html><script type="module" src="/assets/game3d-AbC123.js"></script>');
  writeFileSync(join(clientDist, 'pose-editor.html'), '<!doctype html><script type="module" src="/assets/poseEditor-XyZ789.js"></script>');
  writeFileSync(join(clientDist, 'assets', 'game3d-AbC123.js'), 'export const bundle = 1;');
  writeFileSync(join(clientDist, 'assets', 'poseEditor-XyZ789.js'), 'export const editor = 1;');
  writeFileSync(join(clientDist, 'assets', 'forgeCraftTab-Q1w2E3.js'), 'export const lazy = 1;');
  writeFileSync(join(clientDist, 'menu-bg.png'), Buffer.from('png'));
  const app = express();
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  installStatic(app, { assetsDir, clientDist, serveStatic: true, dev: false });
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

describe('⭐ R10-03: бандл клиента на /assets раздаётся рядом с моделями', () => {
  it('страница и её скрипт: /game3d.html — 200, /assets/game3d-<хэш>.js — 200 JavaScript (было: JSON 404)', async () => {
    const page = await get('/game3d.html');
    expect(page.status).toBe(200);
    const src = /src="([^"]+)"/.exec(page.body)![1]!;
    const js = await get(src);
    expect(js.status, `${src}: ${js.body.slice(0, 60)}`).toBe(200);
    expect(js.type).toMatch(/javascript/);
    expect((await get('/assets/poseEditor-XyZ789.js')).status, 'поз-редактор').toBe(200);
    expect((await get('/assets/forgeCraftTab-Q1w2E3.js')).status, 'ленивый кусок бандла').toBe(200);
  });

  it('модели — как прежде: есть — 200, нет — честный JSON 404 (не страница игры)', async () => {
    const glb = await get('/assets/knight.glb');
    expect(glb.status).toBe(200);
    expect(glb.body).toBe('glTF-model');
    const missing = await get('/assets/missing.glb');
    expect(missing.status).toBe(404);
    expect(missing.type).toMatch(/json/);
    expect((await get('/assets/tiles/nope.png')).status).toBe(404);
  });

  it('SPA-фолбэк и корень клиента не задеты: /menu-bg.png — 200, глубокая ссылка — страница, /api/* — не страница', async () => {
    expect((await get('/menu-bg.png')).status).toBe(200);
    const deep = await get('/some/deep/link');
    expect(deep.status).toBe(200);
    expect(deep.type).toMatch(/html/);
    expect((await get('/api/nope')).status).toBe(404);
  });

  it('раздача клиента выключена (DM_SERVE_STATIC=off) — /assets отдаёт только модели', async () => {
    const app = express();
    installStatic(app, { assetsDir, clientDist, serveStatic: false, dev: false });
    const s = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    try {
      const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      expect((await fetch(`${b}/assets/knight.glb`)).status).toBe(200);
      expect((await fetch(`${b}/assets/game3d-AbC123.js`)).status).toBe(404);
      expect((await fetch(`${b}/game3d.html`)).status).toBe(404);
    } finally { s.close(); }
  });

  it('настоящая сборка (если она есть): каждый скрипт страниц client/dist доступен через те же ручки', async () => {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '../../../client/dist');
    if (!existsSync(join(dist, 'assets'))) return;   // клиент не собран — проверять нечего
    const app = express();
    installStatic(app, { assetsDir, clientDist: dist, serveStatic: true, dev: false });
    const s = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    try {
      const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      // Сборка может идти прямо сейчас (соседний процесс, `npm run build`): файла, которого нет на диске, сервер не обязан отдавать.
      const read = (f: string): string => { try { return readFileSync(join(dist, f), 'utf8'); } catch { return ''; } };
      for (const page of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
        for (const m of read(page).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
          if (!existsSync(join(dist, m[1]!))) continue;
          const r = await fetch(`${b}${m[1]}`);
          await r.body?.cancel();
          if (r.status !== 200 && !existsSync(join(dist, m[1]!))) continue;   // стёрт сборкой между проверкой и запросом
          expect(r.status, `${page} → ${m[1]}`).toBe(200);
        }
      }
    } finally { s.close(); }
  });
});
