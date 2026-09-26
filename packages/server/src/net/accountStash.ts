import { getAccountStash, putAccountStash, putCharacterWithStash } from '../db/db.js';
import { sanitizeStash, emptyStash, migrateWalletToStash, type AccountStash, type ConfigRegistry, type SaveState } from '@dm/shared';

/**
 * Доступ к ОБЩЕМУ на аккаунт сундуку (shared stash). БД — единая истина, кэша нет намеренно:
 * всегда свежее состояние из базы.
 *
 * Ф2: доступ стал асинхронным (Postgres), и прежнее рассуждение «синхронная БД = команда
 * атомарна» больше не работает. Атомарность переноса держится не на этом, а на транзакции
 * `putCharacterWithStash` (сейв и сундук одной записью) и на очереди команд соединения.
 */

/**
 * Сундук вместе с его версией в базе (D8). Версия едет обратно в `putCharacterWithStash`:
 * запись пройдёт, только если с момента чтения сундук никто не менял — героев одного
 * аккаунта можно держать онлайн сразу нескольких. `version = 0` — строки ещё нет.
 */
export interface LoadedStash { stash: AccountStash; version: number; }

export async function loadAccountStash(userId: string, cfg: ConfigRegistry): Promise<LoadedStash> {
  const row = await getAccountStash(userId);
  if (!row) return { stash: emptyStash(cfg), version: 0 };
  // Версия у существующей строки не бывает меньше единицы (умолчание столбца). Ноль здесь
  // означал бы «строки нет» и запись пошла бы вставкой — она не прошла бы никогда.
  const version = Number.isInteger(row.version) && row.version > 0 ? row.version : 1;
  return { stash: sanitizeStash(cfg, row.data), version };
}

/** Запись без проверки версии — только для инструментов; игра пишет сундук вместе с сейвом. */
export async function saveAccountStash(userId: string, stash: AccountStash): Promise<void> {
  await putAccountStash(userId, stash);
}

/**
 * ⚠ ПЕРЕЕЗД СТАРОГО КОШЕЛЬКА. До ч7 сырьё лежало у каждого персонажа своё, теперь оно общее на аккаунт.
 * Вливаем ОДИН раз и обнуляем поле в сейве — иначе при следующем входе влилось бы второй раз; сейв и сундук
 * пишутся одной транзакцией. Не прошла — сейв остаётся каким был, кошелёк вольётся при следующем входе.
 *
 * R1-06: ДО ВХОДА В КОМНАТУ, пока сейв ещё ничей. Раньше переезд шёл уже в живой комнате и мимо очереди кадров:
 * пока его запись ждала базу, игрок успевал, например, бросить вещь, а откат неудачной записи возвращал сейв к
 * снимку — вещь оказывалась и на земле, и в сумке. Неудачу записи с D8 можно вызвать нарочно (второй герой
 * аккаунта трогает сундук), и кошелёк оставался в сейве — трюк повторялся на каждом входе.
 * Возвращает сейв и версию, с которыми входить.
 */
export async function migrateLegacyWallet(
  userId: string, save: SaveState, version: number, cfg: ConfigRegistry,
): Promise<{ save: SaveState; version: number }> {
  if (!save.materials || !Object.keys(save.materials).length) return { save, version };
  try {
    const loaded = await loadAccountStash(userId, cfg);
    const next = structuredClone(save);
    if (!migrateWalletToStash(next, loaded.stash)) return { save, version };
    const res = await putCharacterWithStash(save.charId, userId, next, version, loaded.stash, loaded.version, 'stash');
    if (res.ok) return { save: next, version: res.version };
    console.warn(`[room] переезд кошелька ${save.charId} не записан (обогнали ${res.conflict === 'stash' ? 'сундук' : 'сейв'}) — повторится при следующем входе`);
  } catch (e) {
    console.error(`[room] переезд кошелька ${save.charId} упал:`, e);
  }
  return { save, version };
}
