import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SaveState, AccountStash } from '@dm/shared';
import { q, q1, tx } from './pool.js';
import { syncItems } from './items.js';

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
export interface UserRow { id: string; username: string; passHash: string; passSalt: string; }
const USER_COLS = 'id, username, pass_hash AS "passHash", pass_salt AS "passSalt"';

/** Создаёт пользователя (ник уникален, регистронезависимо). Бросает при дубле (UNIQUE). */
export async function createUser(username: string, passHash: string, passSalt: string): Promise<string> {
  const id = `u_${randomUUID()}`;
  await q('INSERT INTO users (id, username, pass_hash, pass_salt) VALUES ($1, $2, $3, $4)',
    [id, username, passHash, passSalt]);
  return id;
}
export async function getUserByName(username: string): Promise<UserRow | null> {
  return q1<UserRow>(`SELECT ${USER_COLS} FROM users WHERE lower(username) = lower($1)`, [username]);
}
export async function getUserById(id: string): Promise<UserRow | null> {
  return q1<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
}

// ── Сессии ─────────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

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
  const r = await q1<{ userId: string }>(
    'SELECT user_id AS "userId" FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  return r?.userId ?? null;
}
/** Убирает протухшие сессии. Зовётся на старте — таблица не должна расти вечно. */
export async function sweepSessions(): Promise<number> {
  const rows = await q<{ token: string }>('DELETE FROM sessions WHERE expires_at < now() RETURNING token');
  return rows.length;
}
export async function deleteSession(token: string): Promise<void> {
  await q('DELETE FROM sessions WHERE token = $1', [token]);
}

// ── Персонажи ──────────────────────────────────────────────────────────────────
export interface CharacterSummary { charId: string; name: string; classId: string; level: number; }
export interface CharacterRow { userId: string; data: SaveState; version: number; }

/** Создаёт сейв нового персонажа. Возвращает стартовую версию (1). Бросает при дубле charId. */
export async function createCharacter(charId: string, userId: string, data: SaveState): Promise<number> {
  return tx(async (c) => {
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
): Promise<number | null> {
  return tx(async (c) => {
    const r = await c.query<{ version: number }>(
      `UPDATE characters SET data = $1, updated_at = now(), version = version + 1
       WHERE char_id = $2 AND user_id = $3 AND version = $4 RETURNING version`,
      [JSON.stringify(data), charId, userId, expectedVersion]);
    const version = r.rows[0]?.version;
    if (version == null) return null;
    // Ф2: движение вещей записывается ТОЙ ЖЕ транзакцией, что и сейв. Иначе леджер и сейв
    // разъедутся ровно на то окно, в котором и происходят дюпы.
    await syncItems(c, userId, charId, data, undefined, reason);
    return version;
  });
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
 * Возвращает новую версию сейва либо `null`, если версия разошлась (тогда не записано ничего).
 */
export async function putCharacterWithStash(
  charId: string, userId: string, data: SaveState, expectedVersion: number, stash: AccountStash,
): Promise<number | null> {
  return tx(async (c) => {
    const r = await c.query<{ version: number }>(
      `UPDATE characters SET data = $1, updated_at = now(), version = version + 1
       WHERE char_id = $2 AND user_id = $3 AND version = $4 RETURNING version`,
      [JSON.stringify(data), charId, userId, expectedVersion]);
    const version = r.rows[0]?.version;
    if (version == null) return null;   // версия разошлась — коммитим пустую транзакцию, ничего не изменив
    await c.query(
      `INSERT INTO account_stash (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(stash)]);
    // Ф2: сундук участвует в этой записи, поэтому и он попадает в проекцию — только так
    // перенос «инвентарь → сундук» виден леджеру как ОДНО перемещение, а не пропажа и находка.
    await syncItems(c, userId, charId, data, stash, 'stash');
    return version;
  });
}

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
 * Сбрасывает НЕЗАВЕРШЁННЫЕ забеги у ВСЕХ персонажей (удаляет `save.run`). Зовётся на старте
 * сервера: рестарт = чистый лист, без «хвостов» (иначе спуск из города РЕЗЮМИТ старый забег и
 * игнорит выбор алтаря). Возвращает число затронутых персонажей.
 */
export async function clearAllRuns(): Promise<number> {
  // `data - 'run'` — удаление ключа из jsonb прямо в базе: разбирать сейвы в Node незачем.
  const rows = await q<{ char_id: string }>(
    `UPDATE characters SET data = data - 'run', version = version + 1, updated_at = now()
     WHERE data ? 'run' RETURNING char_id`);
  return rows.length;
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
/** Сундук аккаунта из БД (или null, если ещё пуст). */
export async function getAccountStash(userId: string): Promise<AccountStash | null> {
  const r = await q1<{ data: AccountStash }>('SELECT data FROM account_stash WHERE user_id = $1', [userId]);
  return r?.data ?? null;
}
/** Пишет/обновляет сундук аккаунта (last-writer-wins). */
export async function putAccountStash(userId: string, data: AccountStash): Promise<void> {
  await q(
    `INSERT INTO account_stash (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
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
