import { getAccountStash, putAccountStash, putCharacterWithStash } from '../db/db.js';
import { CommitUnknown } from '../db/errors.js';
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
 *
 * ⭐ R8-17: СТАРАЯ КОПИЯ — ТОЛЬКО КОГДА СТРОКА ГЕРОЯ НАВЕРНЯКА НЕ ТРОНУТА (сундук обогнали — не записано ничего; сбой до фиксации).
 * Исход фиксации неизвестен (`CommitUnknown`, R2-09) или строку обогнали — в базе уже может лежать (или лежит) другая версия:
 * вход со старой копией и старой версией давал сессию, чья первая запись упрётся в отказ (4009), а до неё следующий кадр
 * соединения успевал бросить вещь на землю — сосед по аккаунту поднимал её, а строка героя в базе её держала: вещь у двоих.
 * Тогда — бросок: вход ответит «сервер занят», повтор прочитает правду из базы.
 */
export async function migrateLegacyWallet(
  userId: string, save: SaveState, version: number, cfg: ConfigRegistry,
): Promise<{ save: SaveState; version: number }> {
  if (!save.materials || !Object.keys(save.materials).length) return { save, version };
  let res: Awaited<ReturnType<typeof putCharacterWithStash>>;
  let next: SaveState;
  try {
    const loaded = await loadAccountStash(userId, cfg);
    next = structuredClone(save);
    if (!migrateWalletToStash(next, loaded.stash)) return { save, version };
    res = await putCharacterWithStash(save.charId, userId, next, version, loaded.stash, loaded.version, 'stash');
  } catch (e) {
    if (e instanceof CommitUnknown) throw e;   // R8-17: строка, может быть, уже новая — старой копией не входим
    console.error(`[room] переезд кошелька ${save.charId} упал:`, e);
    return { save, version };
  }
  if (res.ok) return { save: next, version: res.version };
  // R8-17: версию сейва обогнали — старая копия уже не та, что в базе.
  if (res.conflict === 'save') throw new Error(`переезд кошелька ${save.charId}: строку героя обогнали — вход со старой копией отменён`);
  console.warn(`[room] переезд кошелька ${save.charId} не записан (обогнали сундук) — повторится при следующем входе`);
  return { save, version };
}
