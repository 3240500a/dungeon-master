import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { newCharacterSave, isWireText, WIRE_TOKEN_RE, WIRE_CHAR_ID_RE, type ConfigRegistry } from '@dm/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  createUser, getUserByName, createSession, deleteSession, countRecentRegistrations,
  listCharacters, getCharacter, createCharacter, deleteCharacter, countCharacters, deleteSessionsOfUser,
} from '../db/db.js';
import { limits, known, clientIp, ipBucket, netTiers, NET_WIDEN, scryptGate } from './rateLimit.js';
import { ah } from './asyncRoute.js';
import { sessionUser, noteSession, sessionKey } from './authSession.js';
import { deviceToken, deviceOk } from './deviceToken.js';

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
 * ⭐ R11-01: и ступени шире — /56 и /48 (`netTiers`), с потолком шире в `NET_WIDEN` раз (20 и 80): с /64 ферма ушла к /56 домашнего
 * провайдера (1280 аккаунтов в сутки) и к бесплатной туннельной /48 (327 680).
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

/**
 * userId по токену из заголовка; иначе шлёт 401 и возвращает null. Токен не того вида — 401 без похода в базу. ⭐ R9-12: сессии
 * нет — неудача платит бакет сети адреса, и поток таких до базы не доходит (429, `sessionUser`).
 */
export async function requireAuth(req: Request, res: Response): Promise<string | null> {
  return sessionUser(req, res, bearer(req));
}

export function installAccountRoutes(app: Express, o: { config: ConfigRegistry }): void {
  const { config } = o;

  // ── Аутентификация ───────────────────────────────────────────────────────────
  app.post('/api/register', accountJson, ah(async (req, res) => {
    // Ф0.5: без лимита один скрипт кладёт сервер регистрациями — каждая это scrypt (~100 мс CPU
    // и десятки мегабайт). Ключ — IP; заголовок прокси учитывается, если он есть.
    const ip = clientIp(req.headers, req.socket.remoteAddress);
    const net = ipBucket(ip);   // R5-25: ключ лимита — сеть адреса (IPv6 — /64), а не адрес: смена адреса бакет не обнуляет
    const tooMany = (limiter: typeof limits.register, key = net): Response => {
      res.setHeader('Retry-After', String(limiter.retryAfterSec(key)));
      return res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
    };
    // ⭐ R11-08: СПЕРВА РАЗБОР — он бесплатен. Раньше бакет регистрации (`register`: 5 подряд, дальше 1 в 30 с) списывался ДО всего,
    // и его платило любое тело: аноним с `{}` раз в 30 с за общим NAT (оператор, общежитие, офис) закрывал регистрацию всем соседям.
    const creds = parseCreds(req.body, 'register');
    if (!creds.ok) return res.status(creds.status).json({ error: creds.error });
    const { username, password } = creds.value;
    const who = username.toLowerCase();
    // ⭐ R11-08: ник, который процесс знает существующим (`known.names`: с запуска — все ники базы, R11-05), — «занят» без базы и под
    // СВОИМ ключом бакета проверок (`k:`): поток заявок в чужие ники бакет соседей не тратит, а перебор ников «есть ли такой» —
    // не быстрее этого бакета.
    if (known.names.has(who)) {
      if (!limits.registerLookup.take(`k:${net}`)) return tooMany(limits.registerLookup, `k:${net}`);
      return res.status(409).json({ error: 'Ник уже занят' });
    }
    // Бакет регистрации пуст — дальше scrypt всё равно не будет: отказ до базы (поток заявок в свободные ники базу не гоняет).
    if (!limits.register.peek(net)) return tooMany(limits.register);
    // ⭐ R11-08: проверки в базе — под своим широким бакетом сети (`registerLookup`), прошедшая их заявка его возвращает.
    if (!limits.registerLookup.take(net)) return tooMany(limits.registerLookup);
    // Ф3.5: суточный потолок аккаунтов с одного адреса. Лимит частоты выше защищает от шквала
    // за минуту, но завести двадцать аккаунтов не спеша он не мешает — а ферму ботов разводят
    // именно так. Честный игрок заводит аккаунт один раз и потолка не замечает.
    // ⭐ R6-19: считаем по СЕТИ адреса (IPv6 — /64), как и лимит частоты; сам адрес пишется рядом — для разбора.
    // ⭐ R11-01: и по каждой ступени шире (IPv6: /56 — 20, /48 — 80 при потолке 5).
    const nets = netTiers(net);
    if (ACCOUNT_CAP_ON) {
      for (let i = 0; i < nets.length; i++) {
        if (await countRecentRegistrations(nets[i]!) < MAX_ACCOUNTS_PER_IP * NET_WIDEN[i]!) continue;
        console.warn(`[dm-server] потолок регистраций с сети ${nets[i]}`);
        return res.status(429).json({ error: 'С этого адреса сегодня создано слишком много аккаунтов' });
      }
    }
    if (await getUserByName(username)) { known.names.add(who); return res.status(409).json({ error: 'Ник уже занят' }); }
    limits.registerLookup.refund(net);
    // ⭐ R11-08: бакет регистрации — только перед самим scrypt; ⭐ R11-01: и общий бюджет scrypt процесса (`scryptGate`).
    if (!limits.register.take(net)) return tooMany(limits.register);
    if (!scryptGate.admit()) {
      limits.register.refund(net);
      res.setHeader('Retry-After', String(scryptGate.retryAfterSec()));
      return res.status(503).json({ error: 'Сервер занят. Попробуйте через несколько секунд' });
    }
    let pass: { hash: string; salt: string };
    try { pass = await hashPassword(password); } finally { scryptGate.done(); }
    const userId = await createUser(username, pass.hash, pass.salt, ip, net, nets.slice(1));
    known.names.add(who);          // R10-04: ник есть — поиск его бакета адреса больше не платит
    const token = await createSession(userId);
    noteSession(token, userId);    // R10-04: сессию завёл этот процесс — бакет адреса ей не нужен
    res.json({ token, userId, username, device: deviceToken(who) });   // R11-05: токен устройства — вход мимо бакета адреса
  }));

  app.post('/api/login', accountJson, ah(async (req, res) => {
    // Ф0.5: тот же scrypt плюс защита от перебора пароля. Успешный вход обнуляет счётчик НИКА — человек, промахнувшийся
    // пару раз, не должен потом ждать. ⭐ R9-10: а бакету адреса — лишь возвращает свой токен (см. ниже).
    // ⭐ R7-13: бакет СЕТИ АДРЕСА платит только НЕВЕРНЫЙ ПАРОЛЬ (scrypt — то, от чего он и стоит), а спрашивается — до scrypt,
    // как бакет адреса лобби (R6-09). Раньше его платила каждая попытка — и вход с несуществующим ником, который scrypt не
    // стоит: за общим NAT один тролль с потоком мусорных ников запирал вход соседям с верным паролем. Перебор пароля держат
    // потолок ника (R3-07) и этот бакет — неудачами. R8-05: списывается до scrypt (верный пароль его возвращает), а поиск ника
    // держит свой широкий бакет (`loginLookup`).
    const net = ipBucket(clientIp(req.headers, req.socket.remoteAddress));   // R5-25: сеть адреса (IPv6 — /64)
    const tooMany = (limiter: { retryAfterSec(key: string): number }, key: string): Response => {
      res.setHeader('Retry-After', String(limiter.retryAfterSec(key)));
      return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже' });
    };
    const creds = parseCreds(req.body, 'login');
    if (!creds.ok) return res.status(creds.status).json({ error: creds.error });
    const { username, password } = creds.value;
    const who = username.toLowerCase();
    // ⭐ R11-05: ТОКЕН УСТРОЙСТВА (`deviceToken`): с этого устройства в этот ник уже входили с верным паролем. Такой вход бакет сети
    // адреса не спрашивает и не платит — его держат потолки ника, — и тролль за общим NAT, опустошающий бакет адреса неверными
    // паролями к любым существующим никам, соседа с устройства, где тот уже входил, больше не запирает. Пароль нужен как прежде.
    const device = deviceOk((req.body as { device?: unknown } | null)?.device, who);
    if (!device && !limits.login.peek(net)) return tooMany(limits.login, net);
    // ⭐ R8-05: поиск ника — под своим, широким бакетом сети адреса (`loginLookup`): мусорный ник scrypt не стоит, но базу — да.
    // ⭐ R10-04: незнакомый процессу ник (`known.names`) платит бакет сети, нашедшийся токен возвращает: поток мусорных ников из-за
    // общего NAT больше не запирает вход соседям с верным паролем. ⭐ R11-10: знакомый — тоже платит, но СВОИМ ключом (`k:`), до базы:
    // раньше он не платил ничего, и одновременная пачка входов на знакомый ник шла в базу вся разом. С токеном устройства — ключ ника.
    const lookupKey = device ? `d:${who}` : known.names.has(who) ? `k:${net}` : net;
    if (!limits.loginLookup.take(lookupKey)) return tooMany(limits.loginLookup, lookupKey);
    const user = await getUserByName(username);
    // R7-13: героя с таким ником нет — сверять нечего: ни scrypt, ни бакета входа (бакет ника на каждый мусорный ник рос бы без конца).
    if (!user) { known.names.delete(who); return res.status(401).json({ error: 'Неверный логин или пароль' }); }
    limits.loginLookup.refund(lookupKey);
    known.names.add(who);
    // ⭐ R11-05: БАКЕТЫ НИКА — РАНЬШЕ БАКЕТА АДРЕСА. Раньше адрес списывался первым, и попытка, которой отказал потолок ника, всё равно
    // тратила токен адреса без всякого scrypt: тролль раз в 3 с бил в ник с исчерпанным потолком и держал бакет адреса пустым —
    // соседи по NAT с верным паролем получали 429. Теперь адрес платит только попытка, которая дойдёт до сверки.
    // ⭐ R3-07: по НИКУ — перебор пароля одного героя с сотни адресов лимит по адресу не держит. Ник без регистра:
    // так его ищет база (`getUserByName`), иначе «Victim» и «victim» были бы двумя бакетами.
    // ⭐ R18-05: с годным токеном устройства этого ника — СВОЙ потолок ника (`loginUserDevice`). Раньше и такой вход платил общий: тролль
    // неверным паролем раз в 30 с (без токена, с любого адреса) держал его пустым — и владелец со своим токеном и верным паролем получал 429
    // бессрочно. Токен — только от верного пароля и подписан по нику: чужие неудачи этот бакет не тратят, перебор с утёкшим токеном — держит.
    const nick = device ? limits.loginUserDevice : limits.loginUser;
    if (!nick.take(who)) return tooMany(nick, who);
    // ⭐ R10-04: и верный пароль — не без предела (`loginOk`, на ник): знакомый ник поиск с адреса не платит, а верный пароль бакет
    // адреса возвращает — сверки своего пароля иначе не держало бы ничего. Неверный токен возвращает: его держат бакеты выше.
    if (!limits.loginOk.take(who)) { nick.refund(who); return tooMany(limits.loginOk, who); }
    // ⭐ R8-05: БАКЕТ АДРЕСА — СПИСАНИЕМ ДО scrypt, и между списанием и scrypt нет ожидания. Раньше до поиска в базе его только
    // спрашивали (`peek`), а списывали после scrypt, не глядя на итог: полсотни одновременных входов проходили проверку все, пока
    // бакет полон, и каждый стоил scrypt. Верный пароль токен возвращает (`refund` ниже). С токеном устройства — не платится.
    if (!device && !limits.login.take(net)) {
      nick.refund(who); limits.loginOk.refund(who);
      return tooMany(limits.login, net);
    }
    // ⭐ R11-01: и общий бюджет scrypt процесса (`scryptGate`): кончился — «занят» без scrypt, и попытка ничего не стоит.
    if (!scryptGate.admit(device)) {
      nick.refund(who); limits.loginOk.refund(who);
      if (!device) limits.login.refund(net);
      res.setHeader('Retry-After', String(scryptGate.retryAfterSec()));
      return res.status(503).json({ error: 'Сервер занят. Попробуйте через несколько секунд' });
    }
    let ok: boolean;
    try { ok = await verifyPassword(password, user.passHash, user.passSalt); } finally { scryptGate.done(); }
    if (!ok) {
      limits.loginOk.refund(who);
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    // ⭐ R9-10: бакету адреса — только СВОЙ токен назад, а не весь бакет. Раньше здесь был `reset`: вход в собственный аккаунт
    // (регистрация даёт их пять на сеть в сутки) стирал все неудачи адреса — девять неверных паролей к чужим никам, один верный
    // к своему, и так по кругу: перебор с одного адреса шёл ~9 scrypt в секунду вместо одного в 3 с (его держал только поиск
    // ника, 10/с). Счёт НИКА обнуляется, как прежде: его неудачи — попытки именно к этому герою, и верный пароль его владельца их снимает.
    if (!device) limits.login.refund(net);
    limits.loginUser.reset(who); limits.loginUserDevice.reset(who);   // R18-05: оба потолка ника — неудачи к нему снимает верный пароль владельца
    const token = await createSession(user.id);
    noteSession(token, user.id);   // R10-04: сессию завёл этот процесс — бакет адреса ей не нужен
    res.json({ token, userId: user.id, username: user.username, device: deviceToken(who) });
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
    if (isSessionToken(token)) {
      // ⭐ R11-07: ПОД БАКЕТОМ СЕТИ АДРЕСА, как прочие ручки с токеном (`sessionUser`, R9-12). Раньше выход удалял в базе по любому
      // токену правильного вида без всякого лимита: анонимный поток случайных токенов стоил запроса на каждый — в пул, который делят
      // сейвы игроков. Знакомый токен (R10-04, R11-05) бакет не спрашивает; незнакомый платит, а удалённая живая сессия возвращает.
      const key = sessionKey(token);
      const familiar = known.sessions.has(key);
      const net = ipBucket(clientIp(req.headers, req.socket.remoteAddress));
      if (!familiar && !limits.authIp.take(net)) {
        res.setHeader('Retry-After', String(limits.authIp.retryAfterSec(net)));
        return res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
      }
      known.sessions.delete(key);
      if (await deleteSession(token) && !familiar) limits.authIp.refund(net);
    }
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
    // R3-04: круг «создал → переложил стартовый комплект → удалил» — не чаще лимита (сам комплект ничего не стоит).
    // ⭐ R11-06: лимит — ДО подсчёта героев в базе (раньше подсчёт шёл первым, и поток запросов при полном ростере гнал его без
    // предела); отказ «ростер полон» токен возвращает — героя не создали.
    if (!limits.charCreate.take(userId)) {
      res.setHeader('Retry-After', String(limits.charCreate.retryAfterSec(userId)));
      return res.status(429).json({ error: 'Слишком часто создаёте героев. Попробуйте позже' });
    }
    const full = (): Response => { limits.charCreate.refund(userId); return res.status(409).json({ error: `Лимит ${MAX_CHARS} персонажей` }); };
    if (await countCharacters(userId) >= MAX_CHARS) return full();
    const charId = randomUUID();
    const save = newCharacterSave(config, classId, name, charId); // авторитетный стартовый сейв
    // R4-30: подсчёт выше — быстрый отказ; потолок держит сама запись (параллельные запросы подсчёт проходят все).
    if (await createCharacter(charId, userId, save, MAX_CHARS) === null) return full();
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
