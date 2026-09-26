import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { GameConn } from './conn.js';

/**
 * ⭐ R6-07: МЕДЛЕННЫЙ КЛИЕНТ НА uWS ОТКЛЮЧАЕТСЯ, А НЕ ТЕРЯЕТ КАДРЫ МОЛЧА. Сверх `maxBackpressure` uWS не шлёт кадр (код
 * 2 — DROPPED), а сокет по умолчанию не закрывает: клиент оставался в комнате, его ввод продлевал жизнь сокета, а кадры
 * смены этажа, сейва, ответов на команды и голосований пропадали — он стоял на старой карте со старым сейвом и держал
 * голосования пати. Транспорт `ws` такого клиента закрывал (1013) — теперь и uWS: переполнение = закрытие 1013, счётчик
 * `dm_slow_clients_dropped_total`, дальше обычный путь реконнекта и грейса.
 *
 * Настоящий uWS с поведением игрового сокета (`gameWsBehavior`), клиент — сырой TCP, который перестаёт читать. Потолок
 * очереди — 64 КБ (`DM_MAX_BACKPRESSURE`: на честных 16 МБ медленный клиент набирает его больше двадцати минут).
 */
vi.hoisted(() => { process.env.DM_MAX_BACKPRESSURE = String(64 * 1024); });
vi.mock('../db/db.js', () => ({}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
}));

interface UwsLike {
  App(): { ws(p: string, b: Record<string, unknown>): { listen(host: string, port: number, cb: (t: unknown) => void): void } };
  us_socket_local_port(t: unknown): number;
  us_listen_socket_close(t: unknown): void;
}
let uWS: UwsLike | null = null;
try { uWS = createRequire(import.meta.url)('uWebSockets.js') as UwsLike; } catch { /* пакет не собран под платформу */ }

const conns: { conn: GameConn; closed: boolean }[] = [];
let port = 0;
let token: unknown = null;
beforeAll(async () => {
  if (!uWS) return;
  const { gameWsBehavior } = await import('./uwsServer.js');
  const u = uWS;
  await new Promise<void>((resolve, reject) => {
    u.App().ws('/ws', gameWsBehavior(u as never, (c) => {
      const rec = { conn: c, closed: false };
      conns.push(rec);
      c.onMessage(() => undefined);
      c.onClose(() => { rec.closed = true; });
    })).listen('127.0.0.1', 0, (t) => {
      if (!t) { reject(new Error('uWS не занял порт')); return; }
      token = t; port = u.us_socket_local_port(t); resolve();
    });
  });
});
afterAll(() => { if (uWS && token) uWS.us_listen_socket_close(token); });

/** Сырой TCP-клиент игрового сокета: рукопожатие — и дальше он ничего не читает (`pause`). */
async function stalledClient(): Promise<{ sock: net.Socket; rest: Buffer }> {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
  sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const rest = await new Promise<Buffer>((resolve) => sock.once('data', (d: Buffer) => resolve(Buffer.from(d.subarray(d.indexOf('\r\n\r\n') + 4)))));
  sock.pause();
  return { sock, rest };
}
/** Код закрывающего кадра в потоке кадров сервера (или undefined). */
function closeCode(buf: Buffer): number | undefined {
  let off = 0;
  let code: number | undefined;
  while (off + 2 <= buf.length) {
    const op = buf[off]! & 0x0f;
    let len = buf[off + 1]! & 0x7f;
    let h = 2;
    if (len === 126) { if (off + 4 > buf.length) break; len = buf.readUInt16BE(off + 2); h = 4; }
    else if (len === 127) { if (off + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(off + 2)); h = 10; }
    if (off + h + len > buf.length) break;
    if (op === 8 && len >= 2) code = buf.readUInt16BE(off + h);
    off += h + len;
  }
  return code;
}

describe.runIf(!!uWS)('⭐ R6-07: переполнение исходящей очереди на uWS — закрытие 1013, а не молчаливая потеря кадров', () => {
  it('клиент перестал читать, сервер шлёт кадры по 16 КБ — соединение закрыто для игры, счётчик вырос, клиент получает 1013', async () => {
    const { counters } = await import('./metrics.js');
    const before = conns.length;
    const { sock, rest } = await stalledClient();
    for (let i = 0; i < 50 && conns.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    const rec = conns[conns.length - 1]!;
    const dropped0 = counters.slowClientsDropped;
    // Кадры меньше потолка — как в игре (снимок мира — килобайты при потолке 16 МБ): очередь растёт, пока клиент не читает.
    const chunk = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 4000 && rec.conn.open; i++) rec.conn.send(`{"t":"snap","n":${i},"pad":"${chunk}"}`);
    expect(rec.conn.open, 'для игры соединения больше нет').toBe(false);
    expect(rec.closed, 'onClose — дальше грейс и реконнект, как у транспорта ws').toBe(true);
    expect(counters.slowClientsDropped - dropped0).toBe(1);
    // Клиент снова читает: всё, что успело уйти, и закрывающий кадр 1013; потом сокет закрыт.
    let buf = rest;
    const ended = new Promise<void>((resolve) => { sock.once('close', () => resolve()); });
    sock.on('data', (d: Buffer) => { buf = Buffer.concat([buf, d]); });
    sock.resume();
    await Promise.race([ended, new Promise((r) => setTimeout(r, 10_000))]);
    expect(sock.destroyed || sock.readableEnded, 'сокет клиента закрыт').toBe(true);
    expect(closeCode(buf), 'код закрытия').toBe(1013);
    sock.destroy();
  }, 20_000);

  it('читающий клиент: кадр больше потолка на пустую очередь уходит (как у самого uWS), соединение живо', async () => {
    const WebSocket = (await import('ws')).default;
    const before = conns.length;
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const got: number[] = [];
    client.on('message', (d: Buffer) => { got.push(d.length); });
    await new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); });
    for (let i = 0; i < 50 && conns.length === before; i++) await new Promise((r) => setTimeout(r, 5));
    const rec = conns[conns.length - 1]!;
    rec.conn.send(`{"t":"joined","pad":"${'y'.repeat(100 * 1024)}"}`);
    for (let i = 0; i < 200 && !got.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(got[0], 'дошёл целиком').toBeGreaterThan(100 * 1024);
    expect(rec.conn.open).toBe(true);
    expect(rec.closed).toBe(false);
    client.close();
  });
});
