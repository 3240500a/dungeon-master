import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { newCharacterSave, isWireText, WIRE_TOKEN_RE, WIRE_CHAR_ID_RE, type ConfigRegistry } from '@dm/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  createUser, getUserByName, createSession, deleteSession, getSession, countRecentRegistrations,
  listCharacters, getCharacter, createCharacter, deleteCharacter, countCharacters, deleteSessionsOfUser,
} from '../db/db.js';
import { limits, clientIp, ipBucket } from './rateLimit.js';
import { ah } from './asyncRoute.js';

/**
 * Аккаунты и ростер героев по HTTP: `/api/register|login|logout|logout-all`, `/api/characters` (список, создание,
 * удаление). Вынесены из `index.ts`, чтобы проверка входа стояла под тестом за настоящим express: импорт `index.ts`
 * поднимает сервер и лезет в базу (как `internalRoutes.ts`).
 *
 * ⭐ R4-02: СТРОКИ ИЗ ЗАПРОСА — ДО БАЗЫ. Ник, имя героя и id героя из пути уходили в Postgres как есть: U+0000 в тексте
 * база отвергает (22021), U+0000 и непарный суррогат в jsonb сейва — тоже (22P05, 22P02), и на каждый такой запрос
 * был ответ 500 со стеком в логе. Правило провода то же, что у WebSocket (`isWireText`, `WIRE_CHAR_ID_RE`,
 * `WIRE_TOKEN_RE`): кривое — 400 с понятным текстом, база не видит его вовсе. Длины — прежние (422).
 */

const MAX_CHARS = 5;
/**
 * Ф3.5: сколько аккаунтов можно завести с одного адреса за сутки. Пять — с запасом на семью
 * и общий интернет: люди заводят аккаунт один раз, а ферма ботов упирается в потолок.
 * ⭐ R6-19: «адрес» — СЕТЬ адреса (`ipBucket`: IPv6 — /64), как у лимита частоты регистраций (R5-25). Раньше потолок считал
 * точный адрес: ферма, меняющая хвост адреса внутри своей /64, заводила ~2880 аккаунтов в сутки вместо пяти.
 */
const MAX_ACCOUNTS_PER_IP = Number(process.env.DM_MAX_ACCOUNTS_PER_IP ?? 5);
/**
 * ⭐ R6-04: ТЕЛО ЗАПРОСА — ТОЛЬКО ЭТИМ РУЧКАМ И МАЛЕНЬКОЕ. Ник, пароль, имя героя — десятки байт. Раньше тело любого запроса
 * к серверу разбирал общий `express.json` на 2 МБ ДО ручек и их лимитов: анонимный POST с 2 МБ вложенного JSON стоил
 * ~115 мс главного потока, и десяток таких в секунду держал тики всех комнат процесса. Больше потолка — 413 без разбора,
 * кривой JSON — 400 (`httpErrors`).
 */
const accountJson = express.json({ limit: '8kb' });
/**
 * Стенд заводит сотню аккаунтов с одного адреса и упирался в этот потолок (в первом прогоне
 * дошли 5 ботов из 60). Потолок — тот же лимит частоты по смыслу, поэтому и выключается тем
 * же переключателем `DM_RATELIMIT=off`, который ставит только `loadtest/probe.ts`. Боевая
 * конфигурация проверяется отдельно — `npm run poc:flood`.
 */
const ACCOUNT_CAP_ON = process.env.DM_RATELIMIT !== 'off';

/** Ник — от 3 до 20 знаков после обрезки пробелов; пароль — от 6 до 200; имя героя — от 1 до 16. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 200;
export const CHAR_NAME_MAX = 16;

/** Итог разбора входа: значение или отказ со статусом и текстом для игрока. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400 | 422; error: string };
const bad = (status: 400 | 422, error: string): { ok: false; status: 400 | 422; error: string } => ({ ok: false, status, error });

/**
 * Ник и пароль из тела запроса. Символы — ДО длины (R4-02): строка с U+0000 — 400 при любой длине. Пароль правилу провода
 * подчиняется только при регистрации: в базу он не уходит (только его хэш), а вход с паролем, заведённым до правила,
 * запирать нельзя.
 */
export function parseCreds(body: unknown, mode: 'register' | 'login'): Parsed<{ username: string; password: string }> {
  const b = body as { username?: unknown; password?: unknown } | null | undefined;
  const username = typeof b?.username === 'string' ? b.username.trim() : '';
  const password = typeof b?.password === 'string' ? b.password : '';
  if (!isWireText(username)) return bad(400, 'Ник содержит недопустимые символы');
  if (mode === 'register' && !isWireText(password)) return bad(400, 'Пароль содержит недопустимые символы');
  const sized = username.length >= USERNAME_MIN && username.length <= USERNAME_MAX && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
  if (!sized) return bad(422, mode === 'register' ? 'Ник 3–20 символов, пароль от 6' : 'Неверные данные');
  return { ok: true, value: { username, password } };
}

/** Имя нового героя и класс из тела запроса (класс сверяется с конфигом отдельно — в базу он не уходит сам по себе). */
export function parseNewCharacter(body: unknown): Parsed<{ name: string; classId: string }> {
  const b = body as { classId?: unknown; name?: unknown } | null | undefined;
  const classId = typeof b?.classId === 'string' ? b.classId : '';
  const name = (typeof b?.name === 'string' ? b.name : '').trim();
  if (!isWireText(name)) return bad(400, 'Имя содержит недопустимые символы');
  if (!name || name.length > CHAR_NAME_MAX) return bad(422, `Имя 1–${CHAR_NAME_MAX} символов`);
  return { ok: true, value: { name, classId } };
}

/** id героя из пути — вид `randomUUID()` (и старых id): иначе 400, до базы. */
export function isCharId(v: unknown): v is string {
  return typeof v === 'string' && WIRE_CHAR_ID_RE.test(v);
}

/** Токен сессии из заголовка — вид `db.createSession`. Кривой в базу не ходит: такой сессии нет и быть не может. */
export function isSessionToken(v: unknown): v is string {
  return typeof v === 'string' && WIRE_TOKEN_RE.test(v);
}

/** Токен из `Authorization: Bearer …` — как прислан (вид проверяет вызывающий: ключ процессов — не сессия). */
export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m ? m[1]! : null;
}

/** userId по токену из заголовка; иначе шлёт 401 и возвращает null. Токен не того вида — 401 без похода в базу. */
export async function requireAuth(req: Request, res: Response): Promise<string | null> {
  const token = bearer(req);
  const userId = isSessionToken(token) ? await getSession(token) : null;
  if (!userId) { res.status(401).json({ error: 'Требуется вход' }); return null; }
  return userId;
}

export function installAccountRoutes(app: Express, o: { config: ConfigRegistry }): void {
  const { config } = o;

  // ── Аутентификация ───────────────────────────────────────────────────────────
  app.post('/api/register', accountJson, ah(async (req, res) => {
    // Ф0.5: без лимита один скрипт кладёт сервер регистрациями — каждая это scrypt (~100 мс CPU
    // и десятки мегабайт). Ключ — IP; заголовок прокси учитывается, если он есть.
    const ip = clientIp(req.headers, req.socket.remoteAddress);
    const net = ipBucket(ip);   // R5-25: ключ лимита — сеть адреса (IPv6 — /64), а не адрес: смена адреса бакет не обнуляет
    if (!limits.register.take(net)) {
      res.setHeader('Retry-After', String(limits.register.retryAfterSec(net)));
      return res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
    }
    const creds = parseCreds(req.body, 'register');
    if (!creds.ok) return res.status(creds.status).json({ error: creds.error });
    const { username, password } = creds.value;
    // Ф3.5: суточный потолок аккаунтов с одного адреса. Лимит частоты выше защищает от шквала
    // за минуту, но завести двадцать аккаунтов не спеша он не мешает — а ферму ботов разводят
    // именно так. Честный игрок заводит аккаунт один раз и потолка не замечает.
    // ⭐ R6-19: считаем по СЕТИ адреса (IPv6 — /64), как и лимит частоты; сам адрес пишется рядом — для разбора.
    if (ACCOUNT_CAP_ON && await countRecentRegistrations(net) >= MAX_ACCOUNTS_PER_IP) {
      console.warn(`[dm-server] потолок регистраций с сети ${net}`);
      return res.status(429).json({ error: 'С этого адреса сегодня создано слишком много аккаунтов' });
    }
    if (await getUserByName(username)) return res.status(409).json({ error: 'Ник уже занят' });
    const { hash, salt } = hashPassword(password);
    const userId = await createUser(username, hash, salt, ip, net);
    res.json({ token: await createSession(userId), userId, username });
  }));

  app.post('/api/login', accountJson, ah(async (req, res) => {
    // Ф0.5: тот же scrypt плюс защита от перебора пароля. Успешный вход обнуляет счётчик —
    // человек, промахнувшийся пару раз, не должен потом ждать.
    const net = ipBucket(clientIp(req.headers, req.socket.remoteAddress));   // R5-25: сеть адреса (IPv6 — /64)
    if (!limits.login.take(net)) {
      res.setHeader('Retry-After', String(limits.login.retryAfterSec(net)));
      return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже' });
    }
    const creds = parseCreds(req.body, 'login');
    if (!creds.ok) return res.status(creds.status).json({ error: creds.error });
    const { username, password } = creds.value;
    // ⭐ R3-07: и по НИКУ — перебор пароля одного героя с сотни адресов лимит по адресу не держит. Ник без регистра:
    // так его ищет база (`getUserByName`), иначе «Victim» и «victim» были бы двумя бакетами.
    const who = username.toLowerCase();
    if (!limits.loginUser.take(who)) {
      res.setHeader('Retry-After', String(limits.loginUser.retryAfterSec(who)));
      return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже' });
    }
    const user = await getUserByName(username);
    if (!user || !verifyPassword(password, user.passHash, user.passSalt)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    limits.login.reset(net);
    limits.loginUser.reset(who);
    res.json({ token: await createSession(user.id), userId: user.id, username: user.username });
  }));

  /**
   * Ф3.4: выйти на ВСЕХ устройствах. Единственный способ обезвредить уведённый токен, не дожидаясь
   * его срока. Сюда же должна звать смена пароля, когда она появится: пароль сменили, а старые
   * сессии продолжают играть — это не защита.
   */
  app.post('/api/logout-all', ah(async (req, res) => {
    const userId = await requireAuth(req, res); if (!userId) return;
    const n = await deleteSessionsOfUser(userId);
    console.log(`[dm-server] отозваны все сессии пользователя ${userId}: ${n}`);
    res.json({ ok: true, revoked: n });
  }));

  app.post('/api/logout', ah(async (req, res) => {
    const token = bearer(req);
    // Токен не того вида сессией не бывает — удалять нечего, в базу незачем (R4-02).
    if (isSessionToken(token)) await deleteSession(token);
    res.json({ ok: true });
  }));

  // ── Персонажи (принадлежат пользователю) ───────────────────────────────────────
  app.get('/api/characters', ah(async (req, res) => {
    const userId = await requireAuth(req, res); if (!userId) return;
    res.json({ characters: await listCharacters(userId) });
  }));

  app.post('/api/characters', accountJson, ah(async (req, res) => {
    // R4-02: имя — до базы, даже до проверки сессии: сейв героя (jsonb) с U+0000 или непарным суррогатом база не примет.
    const parsed = parseNewCharacter(req.body);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
    const { name, classId } = parsed.value;
    if (!config.get('classes').some((c) => c.id === classId && c.enabled !== false)) return res.status(422).json({ error: 'Неизвестный или отключённый класс' });
    const userId = await requireAuth(req, res); if (!userId) return;
    if (await countCharacters(userId) >= MAX_CHARS) return res.status(409).json({ error: `Лимит ${MAX_CHARS} персонажей` });
    // R3-04: круг «создал → переложил стартовый комплект → удалил» — не чаще лимита (сам комплект ничего не стоит).
    if (!limits.charCreate.take(userId)) {
      res.setHeader('Retry-After', String(limits.charCreate.retryAfterSec(userId)));
      return res.status(429).json({ error: 'Слишком часто создаёте героев. Попробуйте позже' });
    }
    const charId = randomUUID();
    const save = newCharacterSave(config, classId, name, charId); // авторитетный стартовый сейв
    // R4-30: подсчёт выше — быстрый отказ; потолок держит сама запись (параллельные запросы подсчёт проходят все).
    if (await createCharacter(charId, userId, save, MAX_CHARS) === null) return res.status(409).json({ error: `Лимит ${MAX_CHARS} персонажей` });
    res.json({ character: { charId, name: save.name, classId: save.classId, level: save.level } });
  }));

  app.delete('/api/characters/:charId', ah<{ charId: string }>(async (req, res) => {
    // R4-02: id из пути — до базы (`%00` раньше доезжал до Postgres и отвечал 500).
    if (!isCharId(req.params.charId)) return res.status(400).json({ error: 'Неверный id персонажа' });
    const userId = await requireAuth(req, res); if (!userId) return;
    const ch = await getCharacter(req.params.charId);
    if (!ch || ch.userId !== userId) return res.status(404).json({ error: 'Персонаж не найден' });
    await deleteCharacter(req.params.charId, userId);
    res.json({ ok: true });
  }));
}
