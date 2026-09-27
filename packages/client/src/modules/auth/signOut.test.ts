import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signOut } from './signOut.js';
import type { AuthSession } from './authApi.js';

/**
 * ⭐ R11-15: ВЫХОД ИЗ АККАУНТА — ОДИН ШОВ ДЛЯ 2D И ВЕБ-3D (`signOut`): сессия гаснет на сервере (`POST /api/logout`), вход
 * страница забывает сразу, сервер недоступен — всё равно вышли. Экран веб-3D целиком — `render3d/screens3d.test.ts`.
 */
const TOKEN = 'cd'.repeat(32);
let calls: { url: string; method?: string; auth?: string }[];
let fail: boolean;
beforeEach(() => {
  calls = []; fail = false;
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init.method, auth: init.headers?.Authorization });
    if (fail) throw new Error('сети нет');
    return new Response('{"ok":true}', { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** `App` ровно в том, что трогает выход: сессия и её сброс. */
const fakeApp = (auth: AuthSession | null) => {
  const app = { auth, cleared: 0, clearAuth(): void { app.cleared++; app.auth = null; } };
  return app;
};

describe('⭐ R11-15: signOut', () => {
  it('токен уходит на сервер (Bearer), вход забыт сразу — не дожидаясь ответа', async () => {
    const app = fakeApp({ token: TOKEN, userId: 'u1', username: 'hero' });
    const done = signOut(app);
    expect(app.auth, 'экран входа не ждёт сети').toBeNull();
    expect(app.cleared).toBe(1);
    await done;
    expect(calls).toEqual([{ url: '/api/logout', method: 'POST', auth: `Bearer ${TOKEN}` }]);
  });

  it('сервер недоступен — промис не отказывает, вход всё равно забыт', async () => {
    fail = true;
    const app = fakeApp({ token: TOKEN, userId: 'u1', username: 'hero' });
    await expect(signOut(app)).resolves.toBeUndefined();
    expect(app.auth).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('входа не было — запроса нет, сброс всё равно', async () => {
    const app = fakeApp(null);
    await signOut(app);
    expect(calls).toEqual([]);
    expect(app.cleared).toBe(1);
  });
});
