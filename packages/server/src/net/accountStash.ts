import { getAccountStash, putAccountStash } from '../db/db.js';
import { sanitizeStash, emptyStash, type AccountStash, type ConfigRegistry } from '@dm/shared';

/**
 * Доступ к ОБЩЕМУ на аккаунт сундуку (shared stash). БД — единая истина, кэша нет намеренно:
 * всегда свежее состояние из базы.
 *
 * Ф2: доступ стал асинхронным (Postgres), и прежнее рассуждение «синхронная БД = команда
 * атомарна» больше не работает. Атомарность переноса держится не на этом, а на транзакции
 * `putCharacterWithStash` (сейв и сундук одной записью) и на очереди команд соединения.
 */
export async function loadAccountStash(userId: string, cfg: ConfigRegistry): Promise<AccountStash> {
  const fromDb = await getAccountStash(userId);
  return fromDb ? sanitizeStash(cfg, fromDb) : emptyStash(cfg);
}

export async function saveAccountStash(userId: string, stash: AccountStash): Promise<void> {
  await putAccountStash(userId, stash);
}
