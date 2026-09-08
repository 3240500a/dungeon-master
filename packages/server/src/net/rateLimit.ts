/**
 * Лимиты частоты (задача Ф0.5 плана доработки сервера).
 *
 * ЗАЧЕМ. До этого лимитов не было НИГДЕ. `/api/register` и `/api/login` открыты без капчи,
 * а каждая попытка — это `scryptSync`: десятки мегабайт памяти и ~100 мс процессора на вызов.
 * То есть один скрипт клал сервер, не открыв ни одного WebSocket. Каждый `join` без кода
 * создаёт новую комнату с собственным тиком — тысяча join'ов клала процесс так же.
 *
 * Реализация — токен-бакет: ёмкость задаёт допустимый всплеск, скорость пополнения — средний
 * поток. Так честный игрок, который быстро перелогинился пару раз, ничего не замечает,
 * а флудер упирается почти сразу.
 */

/**
 * Аварийный выключатель для нагрузочного стенда: сотня ботов идёт с одного адреса и упирается
 * в лимит регистрации раньше, чем начнётся замер. Включается ТОЛЬКО явной переменной окружения,
 * которую ставит `loadtest/probe.ts`; в проде её не бывает, и при её появлении сервер шумит.
 */
const DISABLED = process.env.DM_RATELIMIT === 'off';
if (DISABLED) console.warn('[rateLimit] ЛИМИТЫ ЧАСТОТЫ ВЫКЛЮЧЕНЫ (DM_RATELIMIT=off) — только для нагрузочного стенда');

interface Bucket { tokens: number; at: number; }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  /**
   * Ноль, а не `Date.now()`: время приходит от вызывающего (в тестах — искусственное), и брать
   * старт из настенных часов значит сравнивать две разные шкалы. Первый вызов просто подметёт
   * пустую карту и задаст точку отсчёта.
   */
  private lastSweep = 0;

  /**
   * @param capacity сколько запросов подряд разрешено «в всплеске»
   * @param refillPerSec сколько токенов возвращается в секунду (средний допустимый поток)
   * @param idleMs через сколько простоя запись о ключе выбрасывается (чтобы карта не росла)
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly idleMs = 10 * 60_000,
  ) {}

  /** Списать один токен. `false` — лимит исчерпан, запрос надо отклонить. */
  take(key: string, now = Date.now()): boolean {
    if (DISABLED) return true;
    this.sweep(now);
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Сколько секунд ждать до следующего разрешённого запроса — для заголовка Retry-After. */
  retryAfterSec(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.refillPerSec);
  }

  /** Забыть ключ (например, при успешном входе — чтобы не наказывать за прошлые опечатки). */
  reset(key: string): void { this.buckets.delete(key); }

  get size(): number { return this.buckets.size; }

  /** Периодическая чистка простаивающих ключей: карта не должна расти вечно. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.at > this.idleMs) this.buckets.delete(k);
  }
}

/**
 * Лимиты по умолчанию. Числа подобраны так, чтобы живой человек их не замечал:
 * зарегистрироваться пять раз подряд или ошибиться паролем десять раз — нормально,
 * сотня попыток в минуту — уже не человек.
 */
export const limits = {
  /** Регистрация: 5 подряд, дальше 1 в 30 секунд. Каждая — scrypt, поэтому строго. */
  register: new RateLimiter(5, 1 / 30),
  /** Вход: 10 подряд, дальше 1 в 3 секунды. Тоже scrypt + защита от перебора пароля. */
  login: new RateLimiter(10, 1 / 3),
  /** Создание комнат: 10 подряд, дальше 1 в 2 секунды на аккаунт. Комната = свой тик. */
  roomCreate: new RateLimiter(10, 0.5),
  /** Общий потолок кадров WebSocket на соединение: всплеск 120, поток 80/с. */
  wsFrames: new RateLimiter(120, 80),
};

/** IP клиента с учётом обратного прокси. Доверяем `x-forwarded-for`, только если он есть. */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback?: string): string {
  const fwd = headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (raw) return raw.split(',')[0]!.trim();
  return fallback ?? 'unknown';
}
