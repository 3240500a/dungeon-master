import { describe, it, expect } from 'vitest';
import { RateLimiter, clientIp } from './rateLimit.js';

/** Токен-бакет лимитов (Ф0.5). Время передаём явно — тест не зависит от таймеров. */
describe('RateLimiter', () => {
  it('пропускает всплеск размером с ёмкость и режет следующий запрос', () => {
    const rl = new RateLimiter(3, 1);
    const t = 1_000_000;
    expect(rl.take('ip', t)).toBe(true);
    expect(rl.take('ip', t)).toBe(true);
    expect(rl.take('ip', t)).toBe(true);
    expect(rl.take('ip', t)).toBe(false);
  });

  it('пополняется со временем', () => {
    const rl = new RateLimiter(2, 1); // 1 токен в секунду
    const t = 1_000_000;
    rl.take('ip', t); rl.take('ip', t);
    expect(rl.take('ip', t)).toBe(false);
    expect(rl.take('ip', t + 1000)).toBe(true);   // прошла секунда — один токен вернулся
    expect(rl.take('ip', t + 1000)).toBe(false);
  });

  it('не копит сверх ёмкости за долгий простой', () => {
    const rl = new RateLimiter(2, 1);
    const t = 1_000_000;
    rl.take('ip', t);
    // час простоя не даёт «накопить» тысячу токенов
    expect(rl.take('ip', t + 3_600_000)).toBe(true);
    expect(rl.take('ip', t + 3_600_000)).toBe(true);
    expect(rl.take('ip', t + 3_600_000)).toBe(false);
  });

  it('ключи независимы', () => {
    const rl = new RateLimiter(1, 0.001);
    const t = 1_000_000;
    expect(rl.take('a', t)).toBe(true);
    expect(rl.take('a', t)).toBe(false);
    expect(rl.take('b', t)).toBe(true); // сосед по IP не наказан
  });

  it('retryAfterSec подсказывает, через сколько можно', () => {
    const rl = new RateLimiter(1, 0.5); // токен раз в 2 секунды
    const t = 1_000_000;
    rl.take('ip', t);
    expect(rl.take('ip', t)).toBe(false);
    expect(rl.retryAfterSec('ip', t)).toBe(2);
  });

  it('reset забывает ключ', () => {
    const rl = new RateLimiter(1, 0.001);
    const t = 1_000_000;
    rl.take('ip', t);
    expect(rl.take('ip', t)).toBe(false);
    rl.reset('ip');
    expect(rl.take('ip', t)).toBe(true);
  });

  it('простаивающие ключи вычищаются, карта не растёт вечно', () => {
    const rl = new RateLimiter(5, 1, 1000); // всё, что старше секунды — выбросить
    const t = 1_000_000;
    for (let i = 0; i < 50; i++) rl.take(`ip${i}`, t);
    expect(rl.size).toBe(50);
    rl.take('свежий', t + 120_000); // чистка запускается не чаще раза в минуту
    expect(rl.size).toBe(1);
  });
});

describe('clientIp', () => {
  it('берёт первый адрес из x-forwarded-for', () => {
    expect(clientIp({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe('203.0.113.7');
  });
  it('поддерживает массив заголовков', () => {
    expect(clientIp({ 'x-forwarded-for': ['203.0.113.9'] })).toBe('203.0.113.9');
  });
  it('без заголовка использует адрес сокета', () => {
    expect(clientIp({}, '198.51.100.4')).toBe('198.51.100.4');
  });
  it('без всего — не падает', () => {
    expect(clientIp({})).toBe('unknown');
  });
});
