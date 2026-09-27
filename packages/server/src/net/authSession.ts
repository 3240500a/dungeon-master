import type { Request, Response } from 'express';
import { WIRE_TOKEN_RE } from '@dm/shared';
import { getSession } from '../db/db.js';
import { limits, clientIp, ipBucket } from './rateLimit.js';

/**
 * ⭐ R9-12: СЕССИЯ ПО ТОКЕНУ HTTP — ПОД БАКЕТОМ СЕТИ АДРЕСА (`limits.authIp`), КАК ЛОББИ WEBSOCKET (R5-12, R6-09). Ручки с
 * входом (`requireAuth`: ростер героев, выход везде; маршрут к ноде `/api/route`; `/api/me`, инструменты `/api/dev/*`) проверяли
 * у токена только вид и шли в базу: поток случайных 64-hex токенов с одного адреса стоил запроса в общую базу на каждый — через
 * пул в десять соединений, который делят сейвы игроков, — а лимит маршрута (`limits.route`) ключом берёт аккаунт, то есть
 * стоит уже ПОСЛЕ базы. Теперь запрос списывает токен сети адреса ДО базы, а живая сессия его возвращает (`refund`): платят
 * только неудачи, сосед по NAT со своим токеном бакета не расходует, а поток чужих токенов упирается в 429 без базы.
 *
 * `userId` — или `null`: ответ уже отправлен (401 — токена нет, он не того вида или сессии нет; 429 — неудач с сети адреса
 * слишком много). Кривой токен в базу не ходит и бакета не платит (R4-02: такой сессии быть не может).
 */
export async function sessionUser(req: Request, res: Response, token: string | null): Promise<string | null> {
  if (typeof token !== 'string' || !WIRE_TOKEN_RE.test(token)) { res.status(401).json({ error: 'Требуется вход' }); return null; }
  const net = ipBucket(clientIp(req.headers, req.socket.remoteAddress));
  if (!limits.authIp.take(net)) {
    res.setHeader('Retry-After', String(limits.authIp.retryAfterSec(net)));
    res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
    return null;
  }
  const userId = await getSession(token);
  if (!userId) { res.status(401).json({ error: 'Требуется вход' }); return null; }
  limits.authIp.refund(net);
  return userId;
}
