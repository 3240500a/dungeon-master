import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { login, register } from './authApi.js';

/**
 * ⭐ R11-05: ТОКЕН УСТРОЙСТВА — клиент хранит выданный сервером токен по нику и шлёт его со следующим входом в этот ник: с ним вход
 * не упирается в общий лимит адреса, который опустошил тролль за тем же NAT. В сессию (`dm:auth`) он не идёт.
 */
const store = new Map<string, string>();
const bodies: Record<string, unknown>[] = [];
const DEVICE = 'ab'.repeat(32);
beforeEach(() => {
  store.clear();
  bodies.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
    return new Response(JSON.stringify({ token: 't'.repeat(64), userId: 'u1', username: 'Hero', device: DEVICE }), { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('⭐ R11-05: токен устройства входа', () => {
  it('первый вход — без токена; выданный хранится по нику (без регистра) и уходит со следующим входом', async () => {
    const s = await login('Hero', 'secret-1');
    expect(bodies[0]!.device).toBeUndefined();
    expect(store.get('dm:device:hero')).toBe(DEVICE);
    expect(s).toEqual({ token: 't'.repeat(64), userId: 'u1', username: 'Hero' });
    await login(' hero ', 'secret-1');
    expect(bodies[1]!.device).toBe(DEVICE);
  });

  it('регистрация тоже выдаёт токен устройства; другой ник его не получает', async () => {
    await register('Hero', 'secret-1');
    expect(store.get('dm:device:hero')).toBe(DEVICE);
    await login('Other', 'secret-1');
    expect(bodies[1]!.device).toBeUndefined();
  });

  it('хранилища нет (приватный режим) — вход как раньше, без исключений', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    await expect(login('Hero', 'secret-1')).resolves.toMatchObject({ userId: 'u1' });
  });
});
