import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Хеширование паролей на встроенном `node:crypto` (scrypt) — без сторонних зависимостей
 * (как node:sqlite). Соль случайная на пароль; сравнение — постоянного времени.
 */
const KEYLEN = 64;

export interface PasswordHash { hash: string; salt: string; }

/** Хеширует пароль: случайная соль (16 байт) + scrypt(64). Возвращает hex-строки. */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return { hash, salt };
}

/** Проверяет пароль против сохранённого хеша+соли (timing-safe). */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
