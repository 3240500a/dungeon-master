import { describe, it, expect } from 'vitest';

/**
 * ⭐ R6-20: ТЕЛО АНОНИМНОЙ РУЧКИ — ИЗ КЭША. `GET /api/pose` на каждый запрос читал из базы весь `pose_store` (сотни КБ) и
 * сериализовал его заново, `GET /api/cluster` на каждый запрос спрашивал базу об узлах: поток анонимных GET становился
 * нагрузкой общей базы. Кэш тела — один запрос в базу на срок (и на все запросы, пришедшие, пока он идёт), сброс — при
 * записи этим же процессом.
 */
describe('⭐ R6-20: кэш тела ответа', () => {
  it('сто запросов в срок кэша — одно чтение; параллельные ждут одно и то же чтение', async () => {
    const { cachedJson } = await import('./cachedJson.js');
    let loads = 0;
    let t = 0;
    const c = cachedJson(async () => { loads++; return { n: loads }; }, 1000, () => t);
    const bodies = await Promise.all(Array.from({ length: 50 }, () => c.get()));
    for (let i = 0; i < 50; i++) bodies.push(await c.get());
    expect(loads).toBe(1);
    expect(new Set(bodies.map((b) => b.body))).toEqual(new Set([JSON.stringify({ n: 1 })]));
    expect(bodies[0]!.etag, 'ETag — по телу').toMatch(/".+"$/);
    t = 1001;
    expect((await c.get()).body, 'срок вышел — прочитано заново').toBe(JSON.stringify({ n: 2 }));
  });

  it('сброс (запись этим процессом) — следующее чтение свежее, ETag другой', async () => {
    const { cachedJson } = await import('./cachedJson.js');
    let v = 1;
    const c = cachedJson(async () => ({ v }), 60_000, () => 0);
    const a = await c.get();
    v = 2;
    expect((await c.get()).body, 'в срок — из кэша').toBe(a.body);
    c.invalidate();
    const b = await c.get();
    expect(b.body).toBe(JSON.stringify({ v: 2 }));
    expect(b.etag).not.toBe(a.etag);
  });

  it('чтение упало — ошибка вызывающему, кэш не отравлен', async () => {
    const { cachedJson } = await import('./cachedJson.js');
    let fail = true;
    const c = cachedJson(async () => { if (fail) throw new Error('база упала'); return { ok: 1 }; }, 60_000, () => 0);
    await expect(c.get()).rejects.toThrow('база упала');
    fail = false;
    expect((await c.get()).body).toBe(JSON.stringify({ ok: 1 }));
  });
});
