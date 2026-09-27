import { describe, it, expect } from 'vitest';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createNet } from 'node:net';
import type { AddressInfo } from 'node:net';
import { listenWithRetry } from './listen.js';

/**
 * ⭐ R10-16: ПОВТОР ЗАНЯТОГО ПОРТА СЛУШАЕТ ТОТ ЖЕ АДРЕС. В режиме uWS express обязан слушать только петлю (иначе к нему прямой ход
 * мимо прокси: мимо его фильтра запросов и потолка тела), а повтор после EADDRINUSE звал `listen(port)` без адреса — и вставал на
 * все интерфейсы. Порт держит «старый инстанс» (сокет на петле), первый `listen` получает EADDRINUSE, держатель уходит.
 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNet().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('⭐ R10-16: listenWithRetry', () => {
  it('порт на петле занят, держатель уходит — повтор встаёт на 127.0.0.1, а не на все интерфейсы', async () => {
    const port = await freePort();
    const blocker = createNet();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
    const server: Server = createHttp();
    const fatal: unknown[] = [];
    let busy = 0;
    // Первая неудача — держатель освобождает порт (как старый инстанс на рестарте); повтор идёт своим таймером.
    server.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EADDRINUSE' && busy++ === 0) blocker.close(); });
    const listening = new Promise<void>((resolve) => {
      listenWithRetry(server, port, '127.0.0.1', { delayMs: 50, onFatal: (e) => fatal.push(e), onListening: resolve });
    });
    try {
      await listening;
      expect(busy, 'первый listen упёрся в занятый порт').toBeGreaterThanOrEqual(1);
      expect(fatal).toEqual([]);
      expect((server.address() as AddressInfo).address, 'только петля').toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (blocker.listening) blocker.close();
    }
  });

  it('без адреса (транспорт ws) — как прежде: все интерфейсы; порт занят дольше попыток — фатальная ошибка вызывающему', async () => {
    const port = await freePort();
    const blocker = createNet();
    await new Promise<void>((resolve) => blocker.listen(port, () => resolve()));
    const server: Server = createHttp();
    try {
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        listenWithRetry(server, port, undefined, { tries: 2, delayMs: 10, onFatal: resolve });
      });
      expect(err.code).toBe('EADDRINUSE');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    const s2: Server = createHttp();
    await new Promise<void>((resolve) => listenWithRetry(s2, port, undefined, { onFatal: () => undefined, onListening: resolve }));
    expect(['::', '0.0.0.0']).toContain((s2.address() as AddressInfo).address);
    await new Promise<void>((resolve) => s2.close(() => resolve()));
  });
});
