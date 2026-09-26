/**
 * Ошибки слоя базы, которые РАЗЛИЧАЕТ игровая логика. Отдельный модуль без `pg`: комната импортирует их
 * для `instanceof`, и тащить за ними пул соединений (он открывается при импорте `pool.ts`) ей незачем —
 * в юнит-тестах комнаты база замокана целиком.
 */

/**
 * Нарушение инварианта леджера: вещь чужого аккаунта или отозванная. Запись сейва отменяется целиком.
 * `itemIds` — все вещи-нарушители этой записи (R2-02): комната вынимает их из сейва и пишет остальное,
 * а не теряет молча каждую следующую запись игрока.
 */
export class LedgerViolation extends Error {
  constructor(message: string, readonly itemIds: readonly string[] = []) {
    super(message);
    this.name = 'LedgerViolation';
  }
}

/**
 * ⭐ R2-09: ИСХОД ФИКСАЦИИ НЕИЗВЕСТЕН. Сбой пришёл на самом `COMMIT` (таймаут ответа, обрыв соединения): база
 * могла транзакцию и зафиксировать — node-postgres по таймауту лишь отклоняет промис, а отправленный `COMMIT`
 * доходит до конца. Сбой ДО фиксации — обычная ошибка: транзакция откатана наверняка.
 *
 * `settled` — судьба `COMMIT` уже решена: следующий за ним `ROLLBACK` на том же соединении прошёл, а он встаёт в
 * очередь ЗА опоздавшим `COMMIT`. Тогда свежее чтение строки говорит правду. Нет — соединение умерло посреди
 * фиксации, и она может дойти позже любого чтения.
 */
export class CommitUnknown extends Error {
  constructor(readonly original: unknown, readonly settled = false) {
    super(`исход COMMIT неизвестен: ${original instanceof Error ? original.message : String(original)}`);
    this.name = 'CommitUnknown';
  }
}

/**
 * ⭐ R3-02: ДАННЫЕ, КОТОРЫЕ БАЗА НЕ ПРИМЕТ НИКОГДА — класс SQLSTATE `22` (data exception): U+0000 в jsonb (22P05),
 * непарный суррогат (22P02), байт 0x00 в тексте (22021), переполнение числа (22003)… Это не сбой базы, а сами данные:
 * повтор той же записи упадёт так же. Комната такую сессию снимает, а не играет ею из памяти (см. `Room.write`).
 */
export function isDataException(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('22');
}

/**
 * ⭐ R4-10: ТРАНЗАКЦИЮ МОЖНО ПОВТОРИТЬ — база откатила её целиком сама: взаимоблокировка (`40P01`) или сбой сериализации
 * (`40001`). Ничего не записано, повтор той же записи безопасен (в отличие от `CommitUnknown`, где исход неизвестен).
 */
export function isTxRetryable(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return code === '40P01' || code === '40001';
}
