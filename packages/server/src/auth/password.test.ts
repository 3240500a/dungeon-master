import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password (scrypt, без зависимостей)', () => {
  it('верный пароль проходит, неверный — нет', () => {
    const { hash, salt } = hashPassword('correct horse');
    expect(verifyPassword('correct horse', hash, salt)).toBe(true);
    expect(verifyPassword('wrong', hash, salt)).toBe(false);
  });

  it('хеш не равен паролю и соль случайна', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a.hash).not.toBe('same');
    expect(a.salt).not.toBe(b.salt); // разные соли → разные хеши одного пароля
    expect(a.hash).not.toBe(b.hash);
  });
});
