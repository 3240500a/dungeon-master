import type { Request, Response } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
 * ⭐ R13-08: ПРОПУСК МАРШРУТА — гейтвей проверил сессию токена (`/api/route`) и говорит об этом ноде адресом, который отдаёт клиенту
 * (`?lp=`). Нода знает живые сессии только со своего старта (`primeKnown`), и токен, выданный позже (вход после деплоя ноды), на её
 * лобби был незнакомым: платил бакет сети адреса ДО базы (R12-05), а поток мусорных токенов тролля за тем же CGNAT держал бакет
 * пустым — честный сосед получал «rate» и на статус забега, и на вход. Пропуск — подпись ключом процессов (`serverKey('route')`, общий у
 * гейтвея и нод) над отпечатком токена и сроком: подделать его нельзя, чужому токену он не подходит, а база спрашивается как прежде
 * (отозванная сессия — «вход нужен»). Ключа нет (одиночный процесс без него, тест) — пропусков нет: всё как до R13-08.
 */
let routeKey: Buffer | null = null;
/** Сколько живёт пропуск: клиент спрашивает маршрут перед каждым подключением (R4-13), и этого с запасом хватает до сокета. */
export const ROUTE_PASS_TTL_MS = 10 * 60_000;
export function setRoutePassKey(hex: string | null): void {
  routeKey = hex ? Buffer.from(hex, 'hex') : null;
}
function routeMac(token: string, exp: number): string {
  return createHmac('sha256', routeKey!).update(`route|${sessionKey(token)}|${exp}`).digest('base64url');
}
/** Пропуск маршрута для токена (`undefined` — ключа нет). */
export function routePass(token: string, now = Date.now()): string | undefined {
  if (!routeKey) return undefined;
  const exp = Math.floor((now + ROUTE_PASS_TTL_MS) / 1000);
  return `${exp.toString(36)}.${routeMac(token, exp)}`;
}
/** Годен ли пропуск `pass` этому токену сейчас: подпись своя, срок не вышел и не из будущего дальше своего. */
export function routePassOk(pass: unknown, token: string, now = Date.now()): boolean {
  if (!routeKey || typeof pass !== 'string') return false;
  const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{43})$/.exec(pass);
  if (!m) return false;
  const exp = parseInt(m[1]!, 36);
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now || exp * 1000 > now + ROUTE_PASS_TTL_MS + 60_000) return false;
  const want = Buffer.from(routeMac(token, exp));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * ⭐ R11-05: СТАРТ ГЕЙТВЕЯ (и одиночного процесса) — живые сессии и ники базы сразу знакомы (`known`). Раньше знакомым становилось
 * только то, что предъявили этому процессу: после рестарта или деплоя каждый честный токен и ник платил общий бакет сети адреса, и
 * поток чужих токенов (ников) за общим NAT запирал соседям ростер, маршрут к ноде и вход — а стать знакомым, не пройдя этот бакет,
 * было нельзя. База по-прежнему спрашивается на каждом запросе: знакомость лишь снимает бакет адреса.
 *
 * ⭐ R12-05: и НОДА КЛАСТЕРА — живые сессии (ники ей не нужны: входа по паролю у неё нет, `names: false`). Кадр лобби с незнакомым
 * токеном платит бакет сети адреса до базы; без знакомства на старте после каждого деплоя честные токены нод платили бы его наравне с
 * потоком чужих за общим NAT. Сессии, выданные после старта ноды, знакомы ей с первого живого кадра.
 */
export async function primeKnown(o: { names?: boolean } = {}): Promise<{ sessions: number; names: number }> {
  const [sessions, names] = await Promise.all([listLiveSessions(), o.names === false ? Promise.resolve([]) : listUsernames()]);
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
