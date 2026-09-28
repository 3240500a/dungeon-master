import { describe, it, expect } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { Request, Response } from 'express';
import { holdRefusal } from './asyncRoute.js';

/**
 * ⭐⭐ ОТКАЗ, ПРИНЯТЫЙ ДО ЧТЕНИЯ ТЕЛА, ОБЯЗАН ДОЕХАТЬ ДО КЛИЕНТА НА БОЛЬШОМ ТЕЛЕ.
 *
 * На этом встала публикация поз-редактора: `devGate` отвечает 401/403/429 не читая тела (R4-11), а запрос от прокси
 * идёт БЕЗ keep-alive (`agent: false`, R12-01). На таком запросе нода, закончив ответ при непрочитанном теле,
 * уничтожает сокет сразу — клиент дописывает тело в закрытый сокет, получает СБРОС, и сброс уносит из приёмного
 * буфера сам ответ. Владелец видел «сервер недоступен» вместо предложения войти.
 *
 * ⚠ ЗАМЕР, НА КОТОРОМ СТОИТ ЭТОТ ФАЙЛ (тело 5 МБ, `Connection: close`, отказ 401):
 *   ответить, потом дочитать → ОБРЫВ ECONNRESET;  ответить, не дочитывать → ОБРЫВ;  ДОЧИТАТЬ, ПОТОМ ОТВЕТИТЬ → 401.
 * На keep-alive доезжает любая форма — потому беда и не ловилась мелкими пробами.
 *
 * Здесь настоящий http-сервер и настоящий клиент, тело — 5 МБ, соединение — как у прокси (`agent: false`).
 */
const BIG = 5 * 1024 * 1024;

/** Поднять сервер с обработчиком и вернуть порт + стоп. */
async function serve(handler: (req: Request, res: Response) => void): Promise<{ port: number; stop: () => void }> {
  const s: Server = createServer((req, res) => handler(req as unknown as Request, res as unknown as Response));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as { port: number }).port, stop: () => s.close() };
}

/** POST тела `bytes` байт. `keepAlive: false` — как ходит прокси (`agent: false`). */
function post(port: number, bytes: number, keepAlive = false): Promise<{ status: number | 'обрыв'; body: string }> {
  const body = Buffer.alloc(bytes, 0x61);
  return new Promise((resolve) => {
    const r = request({
      host: '127.0.0.1', port, path: '/api/dev/pose', method: 'POST', agent: keepAlive ? undefined : false,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    }, (res) => {
      let out = '';
      res.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    r.on('error', () => resolve({ status: 'обрыв', body: '' }));
    r.end(body);
  });
}

/** Отказ ровно как у `devGate`: решение принято ДО тела, отправка — через `holdRefusal`. */
function gateLike(cap: number, held: boolean) {
  return (req: Request, res: Response): void => {
    const hold = held ? holdRefusal(req, res) : null;
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":"Требуется вход"}');
    hold?.sendAfterBody(cap);
  };
}

describe('⭐⭐ holdRefusal: отказ до чтения тела доезжает, а не превращается в обрыв', () => {
  it('⭐⭐ ГЛАВНОЕ: 5 МБ без keep-alive — клиент получает 401, а не сброс', async () => {
    const s = await serve(gateLike(24 * 1024 * 1024, true));
    try {
      const small = await post(s.port, 512);
      expect(small.status, 'мелкое тело доезжало и раньше').toBe(401);
      const big = await post(s.port, BIG);
      expect(big.status, 'на 5 МБ отказ обязан доехать: иначе клиент не узнает, что надо войти').toBe(401);
      expect(big.body).toContain('Требуется вход');
    } finally { s.stop(); }
  });

  it('⚠ БЕЗ перехвата то же самое рвётся — сторож ловит именно отправку раньше тела', async () => {
    const s = await serve(gateLike(24 * 1024 * 1024, false));
    try {
      expect((await post(s.port, 512)).status, 'мелкое проходит и без перехвата — беда видна только на большом').toBe(401);
      expect((await post(s.port, BIG)).status, 'это и была жалоба «сервер недоступен, хотя всё запущено»').toBe('обрыв');
    } finally { s.stop(); }
  });

  it('тело больше потолка пути — рвём, а не дочитываем бесконечный поток', async () => {
    const s = await serve(gateLike(64 * 1024, true));
    try {
      expect((await post(s.port, BIG)).status).toBe('обрыв');
    } finally { s.stop(); }
  });

  it('keep-alive — тот же 401 (перехват ничего не ломает там, где и так работало)', async () => {
    const s = await serve(gateLike(24 * 1024 * 1024, true));
    try {
      expect((await post(s.port, BIG, true)).status).toBe(401);
    } finally { s.stop(); }
  });

  it('⭐ доступ ЕСТЬ — `pass()` снимает перехват и тело достаётся ручке нетронутым', async () => {
    const s = await serve((req, res) => {
      const hold = holdRefusal(req, res);
      hold.pass();                       // гейт пропустил: тела не касаемся
      let seen = 0;
      req.on('data', (c: Buffer) => { seen += c.length; });
      req.on('end', () => { res.statusCode = 200; res.end(JSON.stringify({ seen })); });
      req.resume();
    });
    try {
      const r = await post(s.port, BIG);
      expect(r.status, 'обычный путь ручки не изменился').toBe(200);
      expect(JSON.parse(r.body).seen, 'ручка получила ВСЁ тело — перехват его не съел').toBe(BIG);
    } finally { s.stop(); }
  });
});
