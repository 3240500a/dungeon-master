import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRegistry } from '@dm/shared';

/**
 * ⭐ R10-09: НОДА КЛАСТЕРА ОТДАЁТ ПО HTTP ТОЛЬКО СЛУЖЕБНОЕ. Нода (`DM_ROLE=node`) слушает на 0.0.0.0 (uWS) и всё, что не `/ws`,
 * переправляет своему express, а тот держал весь API гейтвея: вход, регистрацию, ростер, инструменты, конфиг, статику. Лимиты —
 * в памяти процесса: с портами нод наружу (DEPLOY §3a, вариант Б) перебор пароля одного ника шёл (N+1)× быстрее потолка R3-07, и
 * каждая сверка (scrypt) — на главном потоке ИГРОВОЙ ноды. Здесь express собран в порядке `index.ts`: служебные ручки, здоровье,
 * забор ноды (`installNodeFence`), затем публичное. База и сверка пароля — шпионы.
 */
vi.mock('../db/db.js', () => ({
  getUserByName: async () => ({ id: 'user-1', username: 'victim', passHash: 'h', passSalt: 's' }),
  createSession: async () => 'b'.repeat(64),
  createUser: async () => 'user-x',
  deleteSession: async () => undefined,
  getSession: async () => null,
  countRecentRegistrations: async () => 0,
  listCharacters: async () => [],
  getCharacter: async () => null,
  createCharacter: async () => 1,
  deleteCharacter: async () => undefined,
  countCharacters: async () => 0,
  deleteSessionsOfUser: async () => 0,
}));
const pw = vi.hoisted(() => ({ verifies: 0 }));
vi.mock('../auth/password.js', () => ({
  hashPassword: () => ({ hash: 'h', salt: 's' }),
  verifyPassword: () => { pw.verifies++; return false; },
}));

let root = '';
const servers: Server[] = [];
let cfg: ConfigRegistry;
beforeAll(() => {
  cfg = new ConfigRegistry();
  cfg.loadAll();
  root = mkdtempSync(join(tmpdir(), 'dm-r1009-'));
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'models', 'knight.glb'), 'glb');
  writeFileSync(join(root, 'dist', 'game3d.html'), '<!doctype html>');
});
afterAll(() => {
  for (const s of servers) s.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Процесс роли `role`: express в порядке `index.ts` на петле. */
async function processOf(role: string): Promise<string> {
  const { installInternalRoutes, installNodeFence } = await import('./internalRoutes.js');
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const { installStatic } = await import('./staticRoutes.js');
  const app = express();
  installInternalRoutes(app, { nodeId: `n-${role}`, metrics: () => Promise.resolve('dm_probe 1\n'), drain: () => undefined });
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  installNodeFence(app, role);
  app.get('/api/config', (_req, res) => { res.json({ ok: true }); });
  app.post('/api/dev/config', (_req, res) => { res.json({ ok: true }); });
  installAccountRoutes(app, { config: cfg });
  installStatic(app, { assetsDir: join(root, 'models'), clientDist: join(root, 'dist'), serveStatic: true, dev: false });
  const s = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
async function status(base: string, path: string, init?: RequestInit): Promise<number> {
  const r = await fetch(`${base}${path}`, init);
  await r.body?.cancel();
  return r.status;
}
const loginInit = (i: number): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` },
  body: JSON.stringify({ username: 'victim', password: `guess-${i}` }),
});

describe('⭐ R10-09: нода — только /ws и служебное', () => {
  it('нода: вход, регистрация, ростер, конфиг, инструменты, статика — 404, без scrypt; метрики с петли и здоровье — как прежде', async () => {
    const base = await processOf('node');
    pw.verifies = 0;
    for (let i = 1; i <= 5; i++) expect(await status(base, '/api/login', loginInit(i)), 'вход').toBe(404);
    expect(pw.verifies, 'сверок пароля на ноде нет').toBe(0);
    expect(await status(base, '/api/register', loginInit(9))).toBe(404);
    expect(await status(base, '/api/characters')).toBe(404);
    expect(await status(base, '/api/config')).toBe(404);
    expect(await status(base, '/api/dev/config', { method: 'POST' })).toBe(404);
    expect(await status(base, '/game3d.html')).toBe(404);
    expect(await status(base, '/assets/knight.glb')).toBe(404);
    expect(await status(base, '/metrics'), 'метрики с самой машины').toBe(200);
    expect(await status(base, '/api/health')).toBe(200);
  });

  it('гейтвей и одиночный процесс — весь API как прежде', async () => {
    for (const role of ['gateway', 'single']) {
      const base = await processOf(role);
      expect(await status(base, '/api/login', loginInit(50)), `${role}: вход`).toBe(401);
      expect(await status(base, '/api/config'), `${role}: конфиг`).toBe(200);
      expect(await status(base, '/game3d.html'), `${role}: статика`).toBe(200);
      expect(await status(base, '/assets/knight.glb'), `${role}: модели`).toBe(200);
      expect(await status(base, '/metrics')).toBe(200);
    }
  });
});
