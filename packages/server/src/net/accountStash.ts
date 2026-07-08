import { getAccountStash, putAccountStash } from '../db/db.js';
import { sanitizeStash, emptyStash, type AccountStash, type ConfigRegistry } from '@dm/shared';

/**
 * Доступ к ОБЩЕМУ на аккаунт сундуку (shared stash). БД — единая истина: `node:sqlite`
 * синхронна, значит каждая команда `handleCmd` выполняется атомарно в одном потоке —
 * расхождения между комнатами процесса невозможны. Кэша нет намеренно (всегда свежее
 * состояние из БД); при гонке одновременных изменений — last-writer-wins.
 */
export function loadAccountStash(userId: string, cfg: ConfigRegistry): AccountStash {
  const fromDb = getAccountStash(userId);
  return fromDb ? sanitizeStash(cfg, fromDb) : emptyStash(cfg);
}

export function saveAccountStash(userId: string, stash: AccountStash): void {
  putAccountStash(userId, stash);
}
