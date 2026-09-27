import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeNodeState, RUN_NODES_MAX, type SaveState, type AccountStash, type RunNodeState } from '@dm/shared';
import { q, q1, tx } from './pool.js';
import { syncItems } from './items.js';
import { CommitUnknown } from './errors.js';
import { claimHeldSql, claimHeldParams } from '../cluster/claimRule.js';

/**
 * Хранилище: Postgres (`db/pool.ts`). Аккаунты — `users` (логин+хеш пароля), `sessions`
 * (токен→userId), `characters` (charId→userId+сейв). Владение персонажем проверяется по
 * `characters.user_id` (анти-чит: чужой charId не загрузить).
 *
 * ВСЁ ЗДЕСЬ АСИНХРОННО. Раньше слой был синхронным (node:sqlite), и обращение к базе можно
 * было воткнуть в любую строчку. Теперь нельзя: вызывающая сторона обязана дождаться. Там,
 * где порядок важен (кадры одного соединения), очередь держит `RoomManager`.
 *
 * `data jsonb` — Postgres отдаёт разобранный объект, `JSON.parse` не нужен и вреден.
 */

// ── Пользователи ───────────────────────────────────────────────────────────────
/** `role`: `player` — обычный игрок, `admin` — доступ к инструментальным роутам (`/api/dev/*`, рабочая копия поз-редактора). */
export interface UserRow { id: string; username: string; passHash: string; passSalt: string; role: string; }
const USER_COLS = 'id, username, pass_hash AS "passHash", pass_salt AS "passSalt", role';

/**
 * Создаёт пользователя (ник уникален, регистронезависимо). Бросает при дубле (UNIQUE). `ip` — адрес регистрации (для
 * разбора), `net` — его сеть (`ipBucket`, R6-19): по ней считается суточный потолок аккаунтов. ⭐ R11-01: `wider` — ступени сети
 * шире (IPv6: /56 и /48, `netTiers`): суточный потолок держат и они.
 */
export async function createUser(
  username: string, passHash: string, passSalt: string, ip?: string, net?: string, wider: readonly string[] = [],
): Promise<string> {
  const id = `u_${randomUUID()}`;
  await q(`INSERT INTO users (id, username, pass_hash, pass_salt, created_ip, created_net, created_net56, created_net48)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, username, passHash, passSalt, ip ?? null, net ?? null, wider[0] ?? null, wider[1] ?? null]);
  return id;
}

/**
 * Ф3.5: сколько аккаунтов заведено с этой СЕТИ адреса (`ipBucket`: IPv4 — сам адрес, IPv6 — /64) за последние часы.
 *
 * Лимит частоты (Ф0.5) защищает от шквала за минуту, но не мешает завести двадцать аккаунтов
 * не спеша — а именно так и разводят ферму ботов. Суточный потолок стоит ботоводу времени
 * и не стоит ничего честному игроку: он заводит аккаунт один раз.
 * ⭐ R6-19: по сети, а не по точному адресу — иначе ферма меняла хвост IPv6 внутри своей /64. Строки до правки (сети нет)
 * считаются по адресу: для IPv4 сеть и есть адрес.
 * ⭐ R11-01: `net` — ключ ЛЮБОЙ ступени сети (/64, /56, /48 — `netTiers`; у ключей разный хвост, спутать нельзя): ферма меняла /64
 * внутри своей /56 (или бесплатной /48) — и потолок пяти аккаунтов был у каждой /64.
 */
export async function countRecentRegistrations(net: string, hours = 24): Promise<number> {
  const r = await q1<{ n: string }>(
    `SELECT COUNT(*) n FROM users
     WHERE (created_net = $1 OR created_net56 = $1 OR created_net48 = $1 OR (created_net IS NULL AND created_ip = $1))
       AND created_at > now() - ($2 || ' hours')::interval`,
    [net, String(hours)]);
  return Number(r?.n ?? 0);
}

/**
 * ⭐ R11-05: все ники базы (без регистра) — гейтвей знает их с запуска (`primeKnown`): вход в существующий ник не платит общий
 * бакет поиска с адреса даже после рестарта, а регистрация в занятый ник отвечает «занят», не спрашивая базу.
 */
export async function listUsernames(): Promise<string[]> {
  const rows = await q<{ u: string }>('SELECT lower(username) AS u FROM users');
  return rows.map((r) => r.u);
}
export async function getUserByName(username: string): Promise<UserRow | null> {
  return q1<UserRow>(`SELECT ${USER_COLS} FROM users WHERE lower(username) = lower($1)`, [username]);
}
export async function getUserById(id: string): Promise<UserRow | null> {
  return q1<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
}
/**
 * Роль по id. Отдельным запросом, а не через `getUserById`, намеренно: проверка прав идёт на КАЖДОМ
 * инструментальном запросе, и тащить ради неё хеш пароля из базы незачем.
 * Нет пользователя → `null`, и вызывающий обязан трактовать это как отказ, а не как «обычный игрок».
 */
export async function getUserRole(id: string): Promise<string | null> {
  const r = await q1<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
  return r?.role ?? null;
}
/**
 * Смена пароля. В игре её пока нет (см. комментарий у `/api/logout-all`), а админский аккаунт без неё
 * означал бы, что случайный пароль остаётся навсегда. Здесь она есть — из консоли, то есть для того,
 * у кого есть доступ к машине с базой. Сессии при этом надо гасить отдельно: пароль сменили,
 * а старые токены продолжают работать — это не защита.
 */
export async function setUserPassword(username: string, passHash: string, passSalt: string): Promise<string | null> {
  const r = await q1<{ id: string }>(
    'UPDATE users SET pass_hash = $2, pass_salt = $3 WHERE lower(username) = lower($1) RETURNING id',
    [username, passHash, passSalt]);
  return r?.id ?? null;
}
/** Выдать/снять роль по НИКУ (регистронезависимо, как и вход). Возвращает id или null, если ника нет. */
export async function setUserRole(username: string, role: string): Promise<string | null> {
  const r = await q1<{ id: string }>(
    'UPDATE users SET role = $2 WHERE lower(username) = lower($1) RETURNING id', [username, role]);
  return r?.id ?? null;
}

// ── Сессии ─────────────────────────────────────────────────────────────────────
/**
 * Ф3.4: срок жизни токена. Было 30 дней без продления — украденный токен работал месяц.
 * Стало 7 дней, но СКОЛЬЗЯЩИЕ: каждое использование отодвигает срок, поэтому тот, кто играет,
 * не разлогинивается никогда, а брошенный токен протухает за неделю.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Продлеваем не чаще раза в сутки: иначе на каждый вход в комнату шла бы лишняя запись. */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** Заводит сессию, возвращает opaque-токен (32 байта hex). */
export async function createSession(userId: string, ttlMs = SESSION_TTL_MS): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, to_timestamp($3))',
    [token, userId, (Date.now() + ttlMs) / 1000]);
  return token;
}
/**
 * userId по валидному непросроченному токену; иначе null.
 *
 * Один запрос, без удаления протухшего на месте: этот путь горячий (проверка на каждом входе
 * в комнату), а чистка — дело `sweepSessions` на старте.
 */
export async function getSession(token: string): Promise<string | null> {
  const r = await q1<{ userId: string; renew: boolean }>(
    `SELECT user_id AS "userId", expires_at < now() + $2 * interval '1 millisecond' AS renew
     FROM sessions WHERE token = $1 AND expires_at > now()`,
    [token, SESSION_TTL_MS - SESSION_RENEW_AFTER_MS]);
  if (!r) return null;
  if (r.renew) {
    await q(`UPDATE sessions SET expires_at = now() + $2 * interval '1 millisecond' WHERE token = $1`,
      [token, SESSION_TTL_MS]);
  }
  return r.userId;
}
/**
 * Отозвать ВСЕ сессии пользователя. Нужен на смене пароля и на кнопку «выйти везде»:
 * иначе увод токена не лечится ничем, кроме ожидания срока.
 */
export async function deleteSessionsOfUser(userId: string): Promise<number> {
  const rows = await q<{ token: string }>('DELETE FROM sessions WHERE user_id = $1 RETURNING token', [userId]);
  return rows.length;
}
/** Убирает протухшие сессии. Зовётся на старте — таблица не должна расти вечно. */
export async function sweepSessions(): Promise<number> {
  const rows = await q<{ token: string }>('DELETE FROM sessions WHERE expires_at < now() RETURNING token');
  return rows.length;
}
/** Удалить сессию токена. ⭐ R11-07: `true` — строка была (сессия жила): только такой выход возвращает токен бакета адреса. */
export async function deleteSession(token: string): Promise<boolean> {
  const rows = await q<{ token: string }>('DELETE FROM sessions WHERE token = $1 RETURNING token', [token]);
  return rows.length > 0;
}
/**
 * ⭐ R11-05: живые сессии (токен и аккаунт) — гейтвей знает их с запуска (`primeKnown`): токен, выданный до рестарта или деплоя,
 * не платит общий бакет адреса. Свежепродлённые — последними (при потолке памяти вытесняются самые старые).
 */
export async function listLiveSessions(): Promise<{ token: string; userId: string }[]> {
  return q<{ token: string; userId: string }>(
    'SELECT token, user_id AS "userId" FROM sessions WHERE expires_at > now() ORDER BY expires_at');
}

/**
 * ⭐ R11-05: КЛЮЧ ПРОЦЕССОВ `name` (32 случайных байта hex) — один на базу: общий у гейтвея и нод, переживает рестарт. Первый
 * спросивший его заводит, остальные читают. Сейчас им подписываются токены устройства входа (`net/deviceToken.ts`).
 */
export async function serverKey(name: string): Promise<string> {
  await q('INSERT INTO server_keys (name, key) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, randomBytes(32).toString('hex')]);
  const r = await q1<{ key: string }>('SELECT key FROM server_keys WHERE name = $1', [name]);
  if (!r) throw new Error(`[db] ключ процессов ${name} не заведён`);
  return r.key;
}

// ── Персонажи ──────────────────────────────────────────────────────────────────
export interface CharacterSummary { charId: string; name: string; classId: string; level: number; }
export interface CharacterRow { userId: string; data: SaveState; version: number; }

/**
 * Создаёт сейв нового персонажа. Возвращает стартовую версию (1) — или `null`, если у аккаунта уже `maxChars` героев.
 * Бросает при дубле charId.
 *
 * ⭐ R4-30: ПОТОЛОК РОСТЕРА — В ТРАНЗАКЦИИ СОЗДАНИЯ, под блокировкой строки аккаунта. Раньше ручка считала героев отдельным
 * запросом и создавала следующим: пять одновременных запросов при четырёх героях видели «четыре» все пять — и героев
 * становилось девять (лишние — лавки, доски и стартовые комплекты альтов).
 */
export async function createCharacter(charId: string, userId: string, data: SaveState, maxChars?: number): Promise<number | null> {
  return tx(async (c) => {
    if (maxChars !== undefined) {
      await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const n = await c.query<{ n: string }>('SELECT COUNT(*) AS n FROM characters WHERE user_id = $1', [userId]);
      if (Number(n.rows[0]?.n ?? 0) >= maxChars) return null;
    }
    await c.query('INSERT INTO characters (char_id, user_id, data, updated_at, version) VALUES ($1, $2, $3, now(), 1)',
      [charId, userId, JSON.stringify(data)]);
    // Стартовый комплект — тоже вещи: они рождаются здесь и должны попасть в журнал.
    await syncItems(c, userId, charId, data, undefined, 'newCharacter');
    return 1;
  });
}

/**
 * Пишет сейв персонажа с проверкой версии (Ф0.3). Возвращает НОВУЮ версию либо `null`, если
 * версия разошлась — значит эту запись обогнал кто-то другой, и наша копия устарела.
 *
 * Отказ — это НЕ штатная ситуация: при исправном сервере у персонажа ровно одна живая сессия
 * (`RoomManager.live`), поэтому расхождение версий означает либо гонку, которую мы не закрыли,
 * либо зависшую комнату. Поэтому зовущая сторона обязана шуметь в лог, а не глотать.
 */
export async function putCharacter(
  charId: string, userId: string, data: SaveState, expectedVersion: number, reason = 'autosave',
  reasons?: ReadonlyMap<string, string>,
): Promise<number | null> {
  const snap = snapshotOf(data);
  try {
    return await tx(async (c) => {
      const r = await c.query<{ version: number }>(
        `UPDATE characters SET data = $1, updated_at = now(), version = version + 1
         WHERE char_id = $2 AND user_id = $3 AND version = $4 RETURNING version`,
        [snap.json, charId, userId, expectedVersion]);
      const version = r.rows[0]?.version;
      if (version == null) return null;
      // Ф2: движение вещей записывается ТОЙ ЖЕ транзакцией, что и сейв. Иначе леджер и сейв
      // разъедутся ровно на то окно, в котором и происходят дюпы.
      await syncItems(c, userId, charId, snap.save, undefined, reason, reasons);
      return version;
    });
  } catch (e) {
    if (e instanceof CommitUnknown) { e.sent = snap.json; return committedAnyway(charId, snap.json, expectedVersion, e); }   // R14-04
    throw e;
  }
}

/**
 * ⭐ R2-09: ОТВЕТ НА COMMIT ПОТЕРЯН — ВЫЯСНИТЬ, ЧЕМ КОНЧИЛОСЬ. Строка персонажа с версией +1 и РОВНО нашими данными
 * (сравнение jsonb — по смыслу, не по порядку ключей) — запись наша: у героя одна живая сессия, и ни у кого больше
 * нет этих данных при этой версии. Версия не сдвинулась, а судьба фиксации решена (`settled`) — не записано
 * наверняка: бросаем исходную ошибку, как любой сбой до фиксации. Всё прочее — исход неизвестен (фиксация могла
 * ещё не дойти): `CommitUnknown` дальше, и комната снимает сессию, а не откатывает память к «до».
 */
async function committedAnyway(charId: string, json: string, expectedVersion: number, e: CommitUnknown): Promise<number> {
  let row: { version: number; mine: boolean } | null = null;
  try {
    row = await q1<{ version: number; mine: boolean }>(
      'SELECT version, data = $1::jsonb AS mine FROM characters WHERE char_id = $2', [json, charId]);
  } catch { /* база молчит — исход так и неизвестен */ }
  if (row && Number(row.version) === expectedVersion + 1 && row.mine) return Number(row.version);
  if (row && Number(row.version) === expectedVersion && e.settled) throw e.original;
  throw e;
}

/**
 * ⭐ R14-04: ЛЕГЛА ЛИ ЗАПИСЬ С НЕИЗВЕСТНЫМ ИСХОДОМ — строка героя на версии `expectedVersion + 1` и РОВНО с отправленными данными (`json` —
 * её снимок, `CommitUnknown.sent`). Да — эта версия: следующая запись той же копии пишет поверх неё. Нет (строка на прежней версии,
 * ушла дальше, чужие данные, героя нет) — `null`. База молчит — бросает: исход так и неизвестен.
 */
export async function landedVersion(charId: string, json: string, expectedVersion: number): Promise<number | null> {
  const row = await q1<{ version: number; mine: boolean }>(
    'SELECT version, data = $1::jsonb AS mine FROM characters WHERE char_id = $2', [json, charId]);
  return row && Number(row.version) === expectedVersion + 1 && row.mine ? Number(row.version) : null;
}

/**
 * ⭐ R1-16: ОДИН СНИМОК на запись — и для строки, и для журнала вещей, снятый в момент вызова. Комната отдаёт
 * сюда ЖИВОЙ сейв, а между запросами транзакции её тик продолжает идти (подбор, пояс): раньше строка
 * сериализовалась в одном месте, а журнал строился по тому же объекту позже — и записывал вещь «у персонажа»,
 * которой в строке нет (или наоборот). После падения до следующего автосейва ночной аудит видел «пропажу» и
 * «несовпадение» там, где дюпа не было, — и настоящий дюп тонул в ложных.
 */
function snapshotOf<T>(data: T): { json: string; save: T } {
  const json = JSON.stringify(data);
  return { json, save: JSON.parse(json) as T };
}

/** Персонаж по charId (с владельцем и версией) — для проверки владения на входе. */
export async function getCharacter(charId: string): Promise<CharacterRow | null> {
  return q1<CharacterRow>(
    'SELECT user_id AS "userId", data, version FROM characters WHERE char_id = $1', [charId]);
}

/**
 * Ф0.4: перенос предмета инвентарь ↔ сундук ОДНОЙ транзакцией.
 *
 * Раньше сундук писался сразу, а инвентарь игрока — только следующим автосейвом, до десяти
 * секунд спустя. Падение процесса в этом окне давало предмет и там, и там: ровно та схема,
 * которой дюпали D2R через сундук. Теперь либо обе строки, либо ни одной.
 *
 * D8: СУНДУК ТОЖЕ ПОД ВЕРСИЕЙ. Он общий на аккаунт, а героев одного аккаунта можно держать онлайн
 * одновременно (две вкладки) — у каждого своя комната и своя копия сундука. Раньше сундук писался
 * «кто последний, тот и прав»: второй герой затирал то, что первый только что потратил или положил,
 * — готовый способ тратить одно сырьё дважды. Теперь сундук пишется, только если его версия та же,
 * что читали (`expectedStashVersion`, 0 — строки ещё не было); иначе транзакция откатывается ЦЕЛИКОМ,
 * вместе с сейвом, и не записано ничего.
 *
 * Возвращает новые версии сейва и сундука либо что именно разошлось (тогда не записано ничего).
 * `reason` — причина для журнала вещей (D9): `stash`, `forge`, `craft`, `salvage`…
 */
export async function putCharacterWithStash(
  charId: string, userId: string, data: SaveState, expectedVersion: number,
  stash: AccountStash, expectedStashVersion: number, reason = 'stash',
  reasons?: ReadonlyMap<string, string>,
): Promise<StashWriteResult> {
  const snap = snapshotOf(data), st = snapshotOf(stash);   // R1-16: строка и журнал — из одного снимка
  try {
    return await tx(async (c): Promise<StashWriteResult> => {
      const r = await c.query<{ version: number }>(
        `UPDATE characters SET data = $1, updated_at = now(), version = version + 1
         WHERE char_id = $2 AND user_id = $3 AND version = $4 RETURNING version`,
        [snap.json, charId, userId, expectedVersion]);
      const version = r.rows[0]?.version;
      // Версия сейва разошлась — коммитим пустую транзакцию, ничего не изменив.
      if (version == null) return { ok: false, conflict: 'save' };
      const s = expectedStashVersion > 0
        // Строка есть: пишем, только если её никто не обогнал. Под READ COMMITTED параллельная
        // запись ждёт нашей блокировки строки и после неё перепроверяет условие по НОВОЙ версии.
        ? await c.query<{ version: number }>(
          `UPDATE account_stash SET data = $2, updated_at = now(), version = version + 1
           WHERE user_id = $1 AND version = $3 RETURNING version`,
          [userId, st.json, expectedStashVersion])
        // Строки не было: вставка без затирания. Если вторая сессия успела вставить первой,
        // DO NOTHING вернёт ноль строк — это такой же конфликт, как и расхождение версии.
        : await c.query<{ version: number }>(
          `INSERT INTO account_stash (user_id, data, updated_at, version) VALUES ($1, $2, now(), 1)
           ON CONFLICT (user_id) DO NOTHING RETURNING version`,
          [userId, st.json]);
      const stashVersion = s.rows[0]?.version;
      // Сейв уже переписан в этой транзакции — откатываем её броском, иначе сейв ушёл бы без сундука.
      if (stashVersion == null) throw new StashConflict();
      // Ф2: сундук участвует в этой записи, поэтому и он попадает в проекцию — только так
      // перенос «инвентарь → сундук» виден леджеру как ОДНО перемещение, а не пропажа и находка.
      await syncItems(c, userId, charId, snap.save, st.save, reason, reasons);
      return { ok: true, version, stashVersion };
    });
  } catch (e) {
    if (e instanceof StashConflict) return { ok: false, conflict: 'stash' };
    // R2-09: сейв и сундук — одна транзакция: строка персонажа наша — значит и сундук записан (его версия +1).
    if (e instanceof CommitUnknown) {
      e.sent = snap.json;   // R14-04: сейв и сундук — одна транзакция: легла строка сейва — лёг и сундук (его версия +1)
      const version = await committedAnyway(charId, snap.json, expectedVersion, e);
      return { ok: true, version, stashVersion: expectedStashVersion + 1 };
    }
    throw e;
  }
}

/** Итог записи сейва вместе с сундуком: новые версии обоих либо что именно разошлось. */
export type StashWriteResult =
  | { ok: true; version: number; stashVersion: number }
  | { ok: false; conflict: 'save' | 'stash' };

/** Сундук обогнали — бросается ВНУТРИ транзакции, чтобы `tx` откатил и уже записанный сейв. */
class StashConflict extends Error {}

/** Краткий ростер пользователя (для экрана выбора). */
export async function listCharacters(userId: string): Promise<CharacterSummary[]> {
  const rows = await q<{ data: SaveState }>(
    'SELECT data FROM characters WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
  return rows.map((r) => summary(r.data));
}
/** ВСЕ персонажи всех пользователей (только dev-инструменты баланса: реальный билд в калькулятор/сим). */
export async function listAllCharacters(): Promise<CharacterSummary[]> {
  const rows = await q<{ data: SaveState }>('SELECT data FROM characters ORDER BY updated_at DESC');
  return rows.map((r) => summary(r.data));
}
function summary(s: SaveState): CharacterSummary {
  return { charId: s.charId, name: s.name, classId: s.classId, level: s.level };
}
export async function deleteCharacter(charId: string, userId: string): Promise<void> {
  await q('DELETE FROM characters WHERE char_id = $1 AND user_id = $2', [charId, userId]);
}
export async function countCharacters(userId: string): Promise<number> {
  const r = await q1<{ n: string }>('SELECT COUNT(*) AS n FROM characters WHERE user_id = $1', [userId]);
  return Number(r?.n ?? 0);
}

/**
 * Сбрасывает НЕЗАВЕРШЁННЫЕ забеги (удаляет `save.run`). Зовётся на старте игрового процесса: рестарт = чистый
 * лист, без «хвостов» (иначе спуск из города РЕЗЮМИТ старый забег и игнорит выбор алтаря). Возвращает число
 * затронутых персонажей.
 *
 * ⭐ R2-11: КРОМЕ ГЕРОЕВ, ЖИВЫХ НА ДРУГОЙ НОДЕ. Раньше сброс шёл по всей базе: поочерёдный перезапуск нод стирал
 * забеги и поднимал версию сейва тем, кто прямо сейчас играл на соседних нодах, — их следующая запись получала
 * отказ по версии, и сессии снимались (R1-01) пачками посреди забега. Живой — значит закреплён за другой нодой,
 * которая подаёт признаки жизни (`self` — эта нода: её прежние закрепления с прошлого запуска — её хвосты).
 * Таблицы кластера к этому моменту обязаны быть созданы (`initClusterSchema`).
 *
 * ⭐ R8-06: «живой на другой ноде» — ПО ПРАВИЛУ ВХОДА (`claimHeldSql`, R7-09): нода замолчала меньше срока смерти, а героя держала
 * на последнем ударе. Раньше хватало 10 с молчания: база легла, нода стартовала в этом окне — и снимала забег и версию героям,
 * которых вход ещё отдавал замолчавшей ноде (её сессии — 4009 пачкой, недописанная прощальная копия пропадала «конфликтом»).
 * Закрепление ноды, ударившей за `nodeStaleSec`, щадится, как и прежде, — и маршрут гейтвея к ней тоже.
 */
export async function clearAllRuns(self: string, nodeStaleSec = 10): Promise<number> {
  // `data - 'run'` — удаление ключа из jsonb прямо в базе: разбирать сейвы в Node незачем.
  const rows = await q<{ char_id: string }>(
    `UPDATE characters SET data = data - 'run', version = version + 1, updated_at = now()
     WHERE data ? 'run'
       AND NOT EXISTS (SELECT 1 FROM char_claims cc JOIN cluster_nodes n ON n.id = cc.node_id
                       WHERE cc.char_id = characters.char_id AND cc.node_id <> $1
                         AND (n.beat_at > now() - ($2 || ' seconds')::interval OR (${claimHeldSql('cc', 'n', 3, 4)})))
     RETURNING char_id`, [self, String(nodeStaleSec), ...claimHeldParams()]);
  return rows.length;
}

// ── Свод записей забегов (R9-01, `pool.ts` — `run_ledger`) ───────────────────────
/** Номер в списке записи узла — целый в пределах `integer` базы: иной (порча) в строку не идёт, а не роняет запись всего свода. */
const ledgerIds = (list: readonly number[]): number[] => list.filter((n) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647);

/**
 * ⭐ R9-01: записи узлов забега `runKey` из базы — проверенные (`normalizeNodeState`), не больше потолка узлов забега. Нет — пусто.
 */
export async function getRunLedger(runKey: string): Promise<RunNodeState[]> {
  const rows = await q<{ id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>(
    'SELECT node_id AS id, el, chests, killed, levers FROM run_ledger WHERE run_key = $1 ORDER BY node_id LIMIT $2',
    [runKey, RUN_NODES_MAX]);
  return rows.map((r) => normalizeNodeState(r)).filter((r): r is RunNodeState => !!r);
}

/**
 * ⭐ R9-01: влить записи узлов в свод забега `runKey` — ОБЪЕДИНЕНИЕМ, одним запросом: списки только растут (взятое кем-либо
 * взято для всех), мощь узла — первой записи. Строку одного узла две комнаты пишут по очереди (блокировка строки на
 * `ON CONFLICT`), и объединение не теряет ни одной.
 * ⭐ R10-13: строки — ПО ПОРЯДКУ id узла (`ORDER BY r.id`), у всех писателей одному. Запрос берёт блокировки строк в порядке
 * записей, а его давал вызывающий (порядок изменений у каждой комнаты свой): две комнаты одного забега, пишущие те же узлы
 * навстречу (`[n1, n2]` и `[n2, n1]`), взаимно блокировались — база обрывала одну (40P01), её записи ждали повтора 5 с, и вход,
 * читавший свод в это окно, видел узлы свежими.
 */
export async function mergeRunLedger(runKey: string, records: readonly RunNodeState[]): Promise<void> {
  if (!records.length) return;
  const rows = records.map((r) => ({ id: r.id, el: r.el, chests: ledgerIds(r.chests), killed: ledgerIds(r.killed), levers: ledgerIds(r.levers) }));
  const union = (col: string): string => `ARRAY(SELECT DISTINCT x FROM unnest(run_ledger.${col} || excluded.${col}) AS x ORDER BY x)`;
  const list = (col: string): string => `ARRAY(SELECT jsonb_array_elements_text(r.${col})::int)`;
  await q(
    `INSERT INTO run_ledger (run_key, node_id, el, chests, killed, levers, updated_at)
     SELECT $1, r.id, r.el, ${list('chests')}, ${list('killed')}, ${list('levers')}, now()
     FROM jsonb_to_recordset($2::jsonb) AS r(id text, el double precision, chests jsonb, killed jsonb, levers jsonb)
     ORDER BY r.id
     ON CONFLICT (run_key, node_id) DO UPDATE SET
       chests = ${union('chests')}, killed = ${union('killed')}, levers = ${union('levers')}, updated_at = now()`,
    [runKey, JSON.stringify(rows)]);
}

/** ⭐ R9-01: выбросить записи забегов, которых не трогали `days` дней (забеги рестарт ноды не переживают). Зовётся на старте. */
export async function sweepRunLedger(days = 7): Promise<number> {
  const r = await q1<{ n: string }>(
    `WITH gone AS (DELETE FROM run_ledger WHERE updated_at < now() - ($1 || ' days')::interval RETURNING 1)
     SELECT count(*) AS n FROM gone`, [String(days)]);
  return Number(r?.n ?? 0);
}

// ── Оверрайды конфигов (единая серверная истина: редактор пишет, игра+редактор читают) ──
/** Все персистентные оверрайды конфигов (ключ→значение) — применяются поверх дефолтов. */
export async function getConfigOverrides(): Promise<Record<string, unknown>> {
  const rows = await q<{ key: string; json: unknown }>('SELECT key, json FROM config_overrides');
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.json;
  return out;
}
/** Пишет/обновляет оверрайд одного конфига (персистентно). */
export async function setConfigOverride(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO config_overrides (key, json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), Date.now()]);
}
/** Удаляет оверрайд ключа (сброс к встроенному дефолту). */
export async function deleteConfigOverride(key: string): Promise<void> {
  await q('DELETE FROM config_overrides WHERE key = $1', [key]);
}

// ── Общий сундук аккаунта (shared stash: одна истина на всех персонажей пользователя) ──
/**
 * Сундук аккаунта из БД вместе с версией (D8) — или null, если строки ещё нет. Версию предъявляет
 * `putCharacterWithStash`: запись пройдёт, только если сундук с тех пор никто не менял.
 */
export async function getAccountStash(userId: string): Promise<{ data: AccountStash; version: number } | null> {
  const r = await q1<{ data: AccountStash; version: number }>(
    'SELECT data, version FROM account_stash WHERE user_id = $1', [userId]);
  return r ? { data: r.data, version: Number(r.version) } : null;
}
/**
 * Пишет/обновляет сундук аккаунта БЕЗ проверки версии (last-writer-wins) — только для инструментов.
 * Игра пишет сундук исключительно через `putCharacterWithStash`. Версию всё равно поднимаем:
 * иначе живая сессия, прочитавшая сундук до этой записи, затёрла бы её своей копией.
 */
export async function putAccountStash(userId: string, data: AccountStash): Promise<void> {
  await q(
    `INSERT INTO account_stash (user_id, data, updated_at, version) VALUES ($1, $2, now(), 1)
     ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
       version = account_stash.version + 1`,
    [userId, JSON.stringify(data)]);
}

// ── Контент 3D поз-редактора (единая истина: редактор пишет, редактор+игра читают) ──
// Опаковые JSON-блобы по ключам (pe_gait/pe_clips/pe_sway/pe_phys/pe_ragdoll/pe_chars) — авторский
// контент (клипы/кадры/гейты), НЕ через ConfigRegistry (слишком сложен для zod-схем).
/** Весь контент поз-редактора (ключ→значение) — отдаётся редактору и игре. */
export async function getPoseStore(): Promise<Record<string, unknown>> {
  const rows = await q<{ key: string; json: unknown }>('SELECT key, json FROM pose_store');
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.json;
  return out;
}
/**
 * РЕВИЗИИ контента: `{ключ: updatedAt}`. Редактор держит рабочую копию у себя и сравнивает
 * ревизии, чтобы (а) показать «на сервере новее» и (б) не затереть чужую правку вслепую.
 * Отдельный роут, потому что тела тяжёлые (одни клипы — сотни килобайт), а ревизии нужны
 * на каждой загрузке.
 */
export async function getPoseRevs(): Promise<Record<string, number>> {
  const rows = await q<{ key: string; updated_at: string }>('SELECT key, updated_at FROM pose_store');
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = Number(r.updated_at);
  return out;
}
/** Пишет/обновляет один ключ контента поз-редактора (персистентно). Возвращает НОВУЮ ревизию. */
export async function setPoseStore(key: string, value: unknown): Promise<number> {
  const rev = Date.now();
  await q(
    `INSERT INTO pose_store (key, json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), rev]);
  return rev;
}
/** Удаляет ключ контента поз-редактора (чистка устаревших/тест-ключей). */
export async function deletePoseStore(key: string): Promise<void> {
  await q('DELETE FROM pose_store WHERE key = $1', [key]);
}

/**
 * Посев авторского 3D-контента (pose_store) из файла-сида `pose-seed.json` при ПУСТОЙ таблице
 * (свежая/сброшенная БД, напр. чистый прод-сервер). Источник — файл в git (выгружен из
 * поз-редактора), чтобы 3D-анимации были из коробки и переживали чистку БД. Возвращает число
 * засеянных ключей.
 */
export async function seedPoseStoreIfEmpty(): Promise<number> {
  const r = await q1<{ n: string }>('SELECT COUNT(*) AS n FROM pose_store');
  if (Number(r?.n ?? 0) > 0) return 0;   // уже есть контент — не трогаем
  try {
    const seed = JSON.parse(readFileSync(new URL('../pose-seed.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    let k = 0;
    for (const [key, value] of Object.entries(seed)) { await setPoseStore(key, value); k++; }
    return k;
  } catch { return 0; }   // нет файла/битый — тихо пропускаем (не критично)
}
