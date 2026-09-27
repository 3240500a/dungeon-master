import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R13-08: АДРЕС НОДЫ ИЗ `/api/route` — С ПРОПУСКОМ МАРШРУТА (`lp`). Нода знает сессии только со своего старта, и токен, выданный
 * позже, платил на её лобби бакет сети адреса наравне с чужими — тролль за тем же CGNAT держал его пустым. Гейтвей сессию только что
 * проверил: пропуск — его подпись над отпечатком токена (ключ процессов общий с нодой), годная только этому токену.
 */
const db = vi.hoisted(() => ({ TOKEN: 'c'.repeat(64), CHAR: '0f8e0c5e-1c2b-4d6a-9e3f-1234567890cd' }));
vi.mock('../db/db.js', () => ({
  getSession: async (t: string) => (t === db.TOKEN ? 'user-13' : null),
  getCharacter: async (id: string) => (id === db.CHAR ? { userId: 'user-13', data: {}, version: 1 } : null),
}));
vi.mock('../db/pool.js', () => ({ q: async () => [], q1: async () => null }));
vi.mock('./registry.js', () => ({
  liveNodes: async () => [{ id: 'node-0', url: 'wss://game.example/ws/0', players: 0, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30 }],
  claimChar: async (_c: string, n: string) => n,
  sweepNodes: async () => 0,
  liveClaim: async () => null,
}));

let server: Server;
let base = '';
beforeAll(async () => {
  const { installGatewayRoutes } = await import('./gateway.js');
  const { setRoutePassKey } = await import('../net/authSession.js');
  setRoutePassKey('7b'.repeat(32));
  const app = express();
  installGatewayRoutes(app);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  const { setRoutePassKey } = await import('../net/authSession.js');
  setRoutePassKey(null);
});

describe('⭐ R13-08: /api/route отдаёт адрес ноды с пропуском маршрута', () => {
  it('пропуск в адресе годен этому токену и не годен чужому', async () => {
    const r = await fetch(`${base}/api/route?charId=${db.CHAR}`, { headers: { Authorization: `Bearer ${db.TOKEN}`, 'X-Forwarded-For': '198.51.100.213' } });
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('wss://game.example/ws/0');
    const pass = u.searchParams.get('lp');
    expect(pass).toBeTruthy();
    const { routePassOk } = await import('../net/authSession.js');
    expect(routePassOk(pass, db.TOKEN)).toBe(true);
    expect(routePassOk(pass, 'd'.repeat(64))).toBe(false);
  });
});
