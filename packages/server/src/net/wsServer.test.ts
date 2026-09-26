import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { ConfigRegistry } from '@dm/shared';
import { counters } from './metrics.js';

/**
 * ТРАНСПОРТ `ws` ЦЕЛИКОМ: настоящий `attachWsServer` на порту 0 и настоящие сокеты. Здесь проверяется то, чего
 * не видно из менеджера комнат: что бросок внутри обработчика кадра не валит процесс (R2-01) и что огромный
 * кадр закрывается транспортом ДО разбора (R2-18). База не нужна — кадры не доходят до входа в игру.
 */
vi.mock('../db/db.js', () => ({
  getSession: () => Promise.resolve(null),
  getCharacter: () => Promise.resolve(null),
  putCharacter: () => Promise.resolve(null),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'save' }),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
}));

let server: Server;
let url = '';

beforeAll(async () => {
  const { attachWsServer } = await import('./wsServer.js');
  const cfg = new ConfigRegistry();
  cfg.loadAll();
  server = createServer();
  // Обработчики SIGINT/SIGTERM транспорта в тестовом процессе не нужны: они вызвали бы process.exit.
  const once = vi.spyOn(process, 'once').mockImplementation(() => process);
  attachWsServer(server, cfg);
  once.mockRestore();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
const opened: WebSocket[] = [];
afterAll(() => {
  // Сокеты после апгрейда сервер уже не держит — рвём свои и не ждём закрытия слушателя.
  for (const ws of opened) ws.terminate();
  server.close();
});

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    opened.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
/** Понг на пинг с номером `id` — или `null`, если за полсекунды ответа нет. */
function ping(ws: WebSocket, id: number): Promise<unknown> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 500);
    ws.on('message', (d: Buffer) => {
      const f = JSON.parse(d.toString()) as { t?: string; id?: unknown };
      if (f.t === 'pong' && f.id === id) { clearTimeout(t); resolve(f); }
    });
    ws.send(JSON.stringify({ t: 'ping', id }));
  });
}
/** Код закрытия сокета — или `-1`, если за `ms` сокет так и не закрыли. */
function closedWith(ws: WebSocket, ms = 2000): Promise<number> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(-1), ms);
    ws.once('close', (code: number) => { clearTimeout(t); resolve(code); });
  });
}

describe('транспорт ws — кадры-убийцы', () => {
  it('⭐ R2-01: пинг с id глубиной 6000 уровней не роняет процесс — соседний сокет получает понг', async () => {
    const bad = await open();
    bad.send('{"t":"ping","id":' + '['.repeat(6000) + ']'.repeat(6000) + '}');
    await new Promise((r) => setTimeout(r, 50));
    const good = await open();
    expect(await ping(good, 7)).toEqual({ t: 'pong', id: 7 });
    bad.close(); good.close();
  });

  it('⭐ R2-18: кадр больше 64 КБ закрывается кодом 1009 и до разбора не доходит; соседний сокет живёт', async () => {
    const big = await open();
    const closing = closedWith(big);
    const in0 = counters.framesIn;
    big.send('{"t":"ping","id":1,"pad":"' + 'a'.repeat(70 * 1024) + '"}');
    expect(await closing).toBe(1009);
    expect(counters.framesIn - in0, 'кадр не дошёл до менеджера комнат').toBe(0);
    const good = await open();
    expect(await ping(good, 8)).toEqual({ t: 'pong', id: 8 });
    good.close();
  });
});

describe('⭐ R4-13: путь игрового сокета за прокси по путям (DEPLOY §3a, вариант А)', () => {
  /** Открыть сокет на путь `path` того же сервера: открылся — сокет, отказ рукопожатия — его HTTP-код. */
  function openAt(path: string): Promise<WebSocket | number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url.replace(/\/ws$/, path));
      opened.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      ws.once('error', () => resolve(-1));
    });
  }

  it('⭐ гейтвей отдаёт wss://домен/ws/<i>, прокси пересылает путь как есть — нода принимает /ws/<i> (было: 400)', async () => {
    const ws = await openAt('/ws/0');
    expect(ws, 'сокет на /ws/0 открылся').toBeInstanceOf(WebSocket);
    expect(await ping(ws as WebSocket, 11)).toEqual({ t: 'pong', id: 11 });
    const ws12 = await openAt('/ws/12?x=1');
    expect(ws12).toBeInstanceOf(WebSocket);
    (ws as WebSocket).close(); (ws12 as WebSocket).close();
  });

  it('прочие пути игрового сокета не получают', async () => {
    for (const p of ['/wsx', '/ws/abc', '/ws/0/1', '/api/ws']) expect(await openAt(p), p).not.toBeInstanceOf(WebSocket);
  });
});
