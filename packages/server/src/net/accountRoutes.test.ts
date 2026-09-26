import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry } from '@dm/shared';

/**
 * ⭐ R4-02: СТРОКИ HTTP-ЗАПРОСА — ДО БАЗЫ. Ник, пароль, имя героя и id героя из пути уходили в Postgres как есть:
 * U+0000 в тексте (22021), U+0000 и непарный суррогат в jsonb сейва (22P05, 22P02) — и каждый такой запрос получал 500
 * со стеком в логе. Здесь настоящие ручки (`installAccountRoutes`) за настоящим express, запросы — по сети, а база —
 * шпион: кривой запрос обязан получить 400 с понятным текстом и НЕ дойти до базы ни одним вызовом.
 */
const db = vi.hoisted(() => {
  // Лимиты частоты на время файла выключены: они проверены своим тестом, а здесь десятки запросов с одного адреса.
  process.env.DM_RATELIMIT = 'off';
  const calls: { fn: string; args: unknown[] }[] = [];
  const TOKEN = 'a'.repeat(64);
  const spy = <T>(fn: string, out: (...a: unknown[]) => T) => (...args: unknown[]): Promise<T> => { calls.push({ fn, args }); return Promise.resolve(out(...args)); };
  /** Что вернёт `createCharacter`: версию нового героя или `null` — база упёрлась в потолок ростера (R4-30). */
  const created = { v: 1 as number | null };
  return { calls, TOKEN, spy, created };
});
vi.mock('../db/db.js', () => ({
  createUser: db.spy('createUser', () => 'user-1'),
  getUserByName: db.spy('getUserByName', () => null),
  createSession: db.spy('createSession', () => db.TOKEN),
  deleteSession: db.spy('deleteSession', () => undefined),
  getSession: db.spy('getSession', (t) => (t === db.TOKEN ? 'user-1' : null)),
  countRecentRegistrations: db.spy('countRecentRegistrations', () => 0),
  listCharacters: db.spy('listCharacters', () => []),
  getCharacter: db.spy('getCharacter', (id) => (id === 'char-1' ? { userId: 'user-1', data: {}, version: 1 } : null)),
  createCharacter: db.spy('createCharacter', () => db.created.v),
  deleteCharacter: db.spy('deleteCharacter', () => undefined),
  countCharacters: db.spy('countCharacters', () => 0),
  deleteSessionsOfUser: db.spy('deleteSessionsOfUser', () => 0),
}));

let server: Server;
let base = '';
beforeAll(async () => {
  const { installAccountRoutes } = await import('./accountRoutes.js');
  const config = new ConfigRegistry();
  config.loadAll();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  installAccountRoutes(app, { config });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { db.calls.length = 0; });

/** Запрос JSON-телом (как шлёт клиент: `JSON.stringify` пишет U+0000 и непарный суррогат экранами). */
async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; error?: string; json: Record<string, unknown> }> {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, error: typeof json.error === 'string' ? json.error : undefined, json };
}
const NUL = 'ab\u0000cd';
const LONE = 'ab\ud800cd';
const classId = (): string => { const c = new ConfigRegistry(); c.loadAll(); return c.get('classes').find((x) => x.enabled !== false)!.id; };

describe('R4-02: аккаунты — кривые строки получают 400 до базы', () => {
  it('регистрация: ник или пароль с U+0000 / непарным суррогатом — 400, база не тронута', async () => {
    for (const body of [
      { username: NUL, password: 'secret-1' }, { username: LONE, password: 'secret-1' },
      { username: 'hero', password: `secret${'\u0000'}` }, { username: 'hero', password: `secret${'\udc00'}` },
      { username: '\u0000', password: 'x' },   // символы проверяются ДО длины: 400, а не 422
    ]) {
      const r = await call('POST', '/api/register', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error).toMatch(/недопустимые символы/);
    }
    expect(db.calls, 'ни одного вызова базы').toEqual([]);
  });

  it('вход: ник с U+0000 / непарным суррогатом — 400 до базы; пароль в базу не ходит и правилом не запирается', async () => {
    for (const username of [NUL, LONE]) {
      const r = await call('POST', '/api/login', { username, password: 'secret-1' });
      expect(r.status, username).toBe(400);
      expect(r.error).toMatch(/Ник содержит недопустимые символы/);
    }
    expect(db.calls).toEqual([]);
    // Пароль, заведённый до правила, вход не запирает: он уходит только в scrypt, база видит лишь ник.
    const r = await call('POST', '/api/login', { username: 'hero', password: `old\u0000pass` });
    expect(r.status, 'неверный логин — обычный 401, не 400').toBe(401);
    expect(db.calls.map((c) => c.fn)).toEqual(['getUserByName']);
    expect(JSON.stringify(db.calls[0]!.args)).not.toMatch(/\\u0000/);
  });

  it('честные регистрация и вход работают; длины — прежние 422', async () => {
    const ok = await call('POST', '/api/register', { username: '  Герой  ', password: 'secret-1' });
    expect(ok.status).toBe(200);
    expect(ok.json.username, 'ник обрезан').toBe('Герой');
    expect(db.calls.map((c) => c.fn)).toEqual(['getUserByName', 'createUser', 'createSession']);
    db.calls.length = 0;
    expect((await call('POST', '/api/register', { username: 'ab', password: 'secret-1' })).status).toBe(422);
    expect((await call('POST', '/api/register', { username: 'hero', password: '123' })).status).toBe(422);
    expect((await call('POST', '/api/login', { username: 'x'.repeat(21), password: 'secret-1' })).status).toBe(422);
    expect((await call('POST', '/api/register', { username: 42, password: 'secret-1' })).status, 'не строка').toBe(422);
    expect(db.calls).toEqual([]);
  });
});

describe('R4-02: герои — имя и id из пути до базы', () => {
  it('создание: имя с U+0000 / непарным суррогатом — 400 до базы (и до проверки сессии)', async () => {
    const cls = classId();
    for (const name of [NUL, LONE, '\u0000']) {
      for (const token of [db.TOKEN, undefined]) {
        const r = await call('POST', '/api/characters', { classId: cls, name }, token);
        expect(r.status, `${JSON.stringify(name)} ${token ? 'с сессией' : 'без'}`).toBe(400);
        expect(r.error).toMatch(/Имя содержит недопустимые символы/);
      }
    }
    expect(db.calls).toEqual([]);
  });

  it('создание: честное имя (и эмодзи — парный суррогат) проходит; длина — прежние 422', async () => {
    const cls = classId();
    const r = await call('POST', '/api/characters', { classId: cls, name: 'Рыцарь 🗡' }, db.TOKEN);
    expect(r.status).toBe(200);
    expect((r.json.character as { name: string }).name).toBe('Рыцарь 🗡');
    expect(db.calls.map((c) => c.fn)).toEqual(['getSession', 'countCharacters', 'createCharacter']);
    db.calls.length = 0;
    expect((await call('POST', '/api/characters', { classId: cls, name: 'x'.repeat(17) }, db.TOKEN)).status).toBe(422);
    expect((await call('POST', '/api/characters', { classId: cls, name: '   ' }, db.TOKEN)).status).toBe(422);
    expect(db.calls).toEqual([]);
  });

  it('⭐ R4-30: потолок ростера держит транзакция создания — упёрлась (параллельные запросы прошли подсчёт) — 409, а не лишний герой', async () => {
    const cls = classId();
    db.created.v = null;
    try {
      const r = await call('POST', '/api/characters', { classId: cls, name: 'Лишний' }, db.TOKEN);
      expect(r.status).toBe(409);
      expect(r.error).toMatch(/Лимит 5 персонажей/);
      const create = db.calls.find((c) => c.fn === 'createCharacter');
      expect(create?.args[3], 'потолок передан в запись').toBe(5);
    } finally { db.created.v = 1; }
  });

  it('удаление: id с U+0000, мусором или непарным суррогатом в пути — 400 до базы; честный id — удаляется', async () => {
    for (const path of ['%00', 'char%00x', 'a%20b', 'x'.repeat(65), '..%2F..']) {
      const r = await call('DELETE', `/api/characters/${path}`, undefined, db.TOKEN);
      expect(r.status, path).toBe(400);
    }
    // Непарный суррогат в пути — это невалидный UTF-8: его отвергает сам express (400), до ручки.
    expect((await call('DELETE', '/api/characters/%ED%A0%80', undefined, db.TOKEN)).status).toBe(400);
    expect(db.calls, 'ни одного вызова базы').toEqual([]);
    const ok = await call('DELETE', '/api/characters/char-1', undefined, db.TOKEN);
    expect(ok.status).toBe(200);
    expect(db.calls.map((c) => c.fn)).toEqual(['getSession', 'getCharacter', 'deleteCharacter']);
  });

  it('токен не того вида — 401 без похода в базу; выход с кривым токеном — ок без базы', async () => {
    for (const token of ['short', 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
      expect((await call('GET', '/api/characters', undefined, token)).status, token).toBe(401);
      expect((await call('POST', '/api/logout-all', undefined, token)).status).toBe(401);
      expect((await call('POST', '/api/logout', undefined, token)).status).toBe(200);
    }
    expect((await call('GET', '/api/characters')).status, 'без токена').toBe(401);
    expect(db.calls).toEqual([]);
    expect((await call('GET', '/api/characters', undefined, db.TOKEN)).status).toBe(200);
    expect(db.calls.map((c) => c.fn)).toEqual(['getSession', 'listCharacters']);
  });
});

describe('R4-02: разбор входа — чистые правила', () => {
  it('символы проверяются до длины, пароль — только при регистрации', async () => {
    const { parseCreds, parseNewCharacter, isCharId, isSessionToken } = await import('./accountRoutes.js');
    expect(parseCreds({ username: NUL, password: 'secret-1' }, 'login')).toMatchObject({ ok: false, status: 400 });
    expect(parseCreds({ username: 'hero', password: NUL + 'xxxx' }, 'register')).toMatchObject({ ok: false, status: 400 });
    expect(parseCreds({ username: 'hero', password: NUL + 'xxxx' }, 'login')).toMatchObject({ ok: true });
    expect(parseCreds(null, 'login')).toMatchObject({ ok: false, status: 422 });
    expect(parseNewCharacter({ classId: 'warrior', name: ' Имя ' })).toEqual({ ok: true, value: { name: 'Имя', classId: 'warrior' } });
    expect(parseNewCharacter({ classId: 'warrior', name: 'a b' })).toMatchObject({ ok: true });   // не Cc/Cs — провод пропускает
    expect(parseNewCharacter({ classId: 'warrior', name: 'a\u007fb' })).toMatchObject({ ok: false, status: 400 });
    expect([isCharId('0f8e0c5e-1c2b-4d6a-9e3f-1234567890ab'), isCharId('old_id-1'), isCharId(''), isCharId('a\u0000'), isCharId(5)])
      .toEqual([true, true, false, false, false]);
    expect([isSessionToken(db.TOKEN), isSessionToken(null), isSessionToken('a'.repeat(65))]).toEqual([true, false, false]);
  });
});
