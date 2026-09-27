import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Хеширование паролей на встроенном `node:crypto` (scrypt) — без сторонних зависимостей
 * (как node:sqlite). Соль случайная на пароль; сравнение — постоянного времени.
 */
const KEYLEN = 64;

/**
 * ⭐ R11-01: scrypt — В ПУЛЕ ПОТОКОВ libuv, А НЕ НА ГЛАВНОМ ПОТОКЕ. Раньше здесь был `scryptSync`: ~30 мс главного потока на каждую
 * регистрацию и сверку пароля — того самого, что тикает все комнаты процесса (в кластере — гейтвея, что ведёт входы и маршруты).
 * Поток входов с сотен адресов (IPv6-сеть, ботнет) замораживал игру всем. Теперь сверка идёт в пуле, и сразу — не больше
 * `SCRYPT_PARALLEL` (пул — четыре потока на процесс, их ждут и файлы, и DNS): остальные ждут очереди здесь. Сколько их пускать вообще —
 * решает ручка (`scryptGate`, бюджет процесса).
 */
const SCRYPT_PARALLEL = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function derive(password: string, salt: string): Promise<Buffer> {
  if (running < SCRYPT_PARALLEL) running++;
  else await new Promise<void>((r) => { waiting.push(r); });   // место передаст закончивший (счёт `running` не падает)
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, KEYLEN, (e, key) => { if (e) reject(e); else resolve(key); });
    });
  } finally {
    const next = waiting.shift();
    if (next) next(); else running--;
  }
}

export interface PasswordHash { hash: string; salt: string; }

/** Хеширует пароль: случайная соль (16 байт) + scrypt(64). Возвращает hex-строки. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt)).toString('hex');
  return { hash, salt };
}

/** Проверяет пароль против сохранённого хеша+соли (timing-safe). */
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const expected = Buffer.from(hash, 'hex');
  const actual = await derive(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
