import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password (scrypt, без зависимостей)', () => {
  it('верный пароль проходит, неверный — нет', async () => {
    const { hash, salt } = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash, salt)).toBe(true);
    expect(await verifyPassword('wrong', hash, salt)).toBe(false);
  });

  it('хеш не равен паролю и соль случайна', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.hash).not.toBe('same');
    expect(a.salt).not.toBe(b.salt); // разные соли → разные хеши одного пароля
    expect(a.hash).not.toBe(b.hash);
  });

  it('⭐ R11-01: scrypt — не на главном потоке: пока идут сверки, цикл событий живёт (тики комнат не стоят)', async () => {
    const { hash, salt } = await hashPassword('x-secret');
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 1);
    const ok = await Promise.all(Array.from({ length: 6 }, () => verifyPassword('x-secret', hash, salt)));
    clearInterval(t);
    expect(ok).toEqual(Array(6).fill(true));
    expect(ticks, 'таймер цикла событий срабатывал, пока шли сверки').toBeGreaterThan(0);
  });
});
