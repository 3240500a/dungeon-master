import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { WIRE_TOKEN_RE } from '@dm/shared';
import { getSession, listLiveSessions, listUsernames } from '../db/db.js';
import { limits, known, clientIp, ipBucket, type RateLimiter } from './rateLimit.js';

/** ⭐ R10-04: отпечаток токена сессии для `known.sessions` — сами токены процесс в памяти не копит. */
export function sessionKey(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

/** ⭐ R10-04: база подтвердила сессию этого токена (вход, регистрация) — бакет сети адреса ему больше не нужен. */
export function noteSession(token: string, userId: string): void {
  known.sessions.add(sessionKey(token), userId);
}

/**
 * ⭐ R11-05: СТАРТ ГЕЙТВЕЯ (и одиночного процесса) — живые сессии и ники базы сразу знакомы (`known`). Раньше знакомым становилось
 * только то, что предъявили этому процессу: после рестарта или деплоя каждый честный токен и ник платил общий бакет сети адреса, и
 * поток чужих токенов (ников) за общим NAT запирал соседям ростер, маршрут к ноде и вход — а стать знакомым, не пройдя этот бакет,
 * было нельзя. База по-прежнему спрашивается на каждом запросе: знакомость лишь снимает бакет адреса.
 */
export async function primeKnown(): Promise<{ sessions: number; names: number }> {
  const [sessions, names] = await Promise.all([listLiveSessions(), listUsernames()]);
  for (const s of sessions) known.sessions.add(sessionKey(s.token), s.userId);
  for (const n of names) known.names.add(n.toLowerCase());
  return { sessions: sessions.length, names: names.length };
}

/**
 * ⭐ R9-12: СЕССИЯ ПО ТОКЕНУ HTTP — ПОД БАКЕТОМ СЕТИ АДРЕСА (`limits.authIp`), КАК ЛОББИ WEBSOCKET (R5-12, R6-09). Ручки с
 * входом (`requireAuth`: ростер героев, выход везде; маршрут к ноде `/api/route`; `/api/me`, инструменты `/api/dev/*`) проверяли
 * у токена только вид и шли в базу: поток случайных 64-hex токенов с одного адреса стоил запроса в общую базу на каждый — через
 * пул в десять соединений, который делят сейвы игроков, — а лимит маршрута (`limits.route`) ключом берёт аккаунт, то есть
 * стоит уже ПОСЛЕ базы. Теперь запрос списывает токен сети адреса ДО базы, а живая сессия его возвращает (`refund`): платят
 * только неудачи, сосед по NAT со своим токеном бакета не расходует, а поток чужих токенов упирается в 429 без базы.
 *
 * ⭐ R10-04: ТОКЕН, ЧЬЮ СЕССИЮ ПРОЦЕСС УЖЕ ВИДЕЛ ЖИВОЙ (`known.sessions`: вход, регистрация, прошлый запрос), БАКЕТ НЕ СПРАШИВАЕТ.
 * Раньше списание шло до базы у КАЖДОГО запроса, а возврат — только после: пустой бакет отказывал и живому токену, и поток чужих
 * токенов из-за общего NAT (оператор, общежитие, офис) запирал соседям маршрут к ноде (он — перед каждым подключением), ростер и
 * вход редактора. База спрашивается как прежде: отозванная сессия — 401 (и токен снова «незнакомый»). Незнакомый токен (процесс
 * его не видел) платит бакет, как раньше, — поток чужих до базы не доходит (R9-12). R11-05: живые сессии знакомы с самого старта
 * процесса (`primeKnown`), а знакомость живёт срок сессии.
 *
 * ⭐ R11-06: И ПОД ПОТОЛКОМ АККАУНТА (`perAccount`: `limits.account`, инструментам — `limits.accountDev`). Знакомый токен бакета адреса
 * не платит — и один бесплатный аккаунт гнал ростер, `/api/me`, «выйти везде» по два запроса в общую базу на запрос без предела.
 * Знакомый токен платит потолок своего аккаунта ДО базы (аккаунт известен по отпечатку), незнакомый — после неё.
 *
 * `userId` — или `null`: ответ уже отправлен (401 — токена нет, он не того вида или сессии нет; 429 — неудач с сети адреса
 * слишком много или запросов аккаунта). Кривой токен в базу не ходит и бакета не платит (R4-02: такой сессии быть не может).
 */
export async function sessionUser(
  req: Request, res: Response, token: string | null, perAccount: RateLimiter = limits.account,
): Promise<string | null> {
  if (typeof token !== 'string' || !WIRE_TOKEN_RE.test(token)) { res.status(401).json({ error: 'Требуется вход' }); return null; }
  const key = sessionKey(token);
  const seen = known.sessions.get(key);
  const net = ipBucket(clientIp(req.headers, req.socket.remoteAddress));
  const tooMany = (retrySec: number): null => {
    res.setHeader('Retry-After', String(retrySec));
    res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
    return null;
  };
  if (seen !== undefined) {
    if (!perAccount.take(seen)) return tooMany(perAccount.retryAfterSec(seen));
  } else if (!limits.authIp.take(net)) {
    return tooMany(limits.authIp.retryAfterSec(net));
  }
  let userId: string | null;
  try {
    userId = await getSession(token);
  } catch (e) {
    if (seen !== undefined) perAccount.refund(seen);   // база не ответила — запрос ответа не получил, потолок аккаунта не платит
    throw e;
  }
  if (!userId) { known.sessions.delete(key); res.status(401).json({ error: 'Требуется вход' }); return null; }
  known.sessions.add(key, userId);
  if (seen === undefined) {
    limits.authIp.refund(net);
    if (!perAccount.take(userId)) return tooMany(perAccount.retryAfterSec(userId));
  }
  return userId;
}
