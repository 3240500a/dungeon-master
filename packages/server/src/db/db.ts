import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SaveState, AccountStash } from '@dm/shared';

/**
 * Хранилище на встроенном node:sqlite (без нативных зависимостей). Аккаунты:
 * `users` (логин+хеш пароля), `sessions` (токен→userId), `characters` (charId→userId+сейв).
 * Владение персонажем проверяется по `characters.userId` (анти-чит: чужой charId не загрузить).
 */
const DB_PATH = process.env.DM_DB ?? 'data/dm.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passHash TEXT NOT NULL,
    passSalt TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS characters (
    charId TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    data TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_characters_userId ON characters (userId);
  CREATE TABLE IF NOT EXISTS config_overrides (
    key TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_stash (
    userId TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`);

// ── Пользователи ───────────────────────────────────────────────────────────────
export interface UserRow { id: string; username: string; passHash: string; passSalt: string; }

const insertUserStmt = db.prepare(
  'INSERT INTO users (id, username, passHash, passSalt, createdAt) VALUES (?, ?, ?, ?, ?)',
);
const userByNameStmt = db.prepare('SELECT id, username, passHash, passSalt FROM users WHERE username = ? COLLATE NOCASE');
const userByIdStmt = db.prepare('SELECT id, username, passHash, passSalt FROM users WHERE id = ?');

/** Создаёт пользователя (ник уникален, регистронезависимо). Бросает при дубле (UNIQUE). */
export function createUser(username: string, passHash: string, passSalt: string): string {
  const id = `u_${randomUUID()}`;
  insertUserStmt.run(id, username, passHash, passSalt, Date.now());
  return id;
}
export function getUserByName(username: string): UserRow | null {
  return (userByNameStmt.get(username) as UserRow | undefined) ?? null;
}
export function getUserById(id: string): UserRow | null {
  return (userByIdStmt.get(id) as UserRow | undefined) ?? null;
}

// ── Сессии ─────────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const insertSessionStmt = db.prepare('INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)');
const sessionStmt = db.prepare('SELECT userId, expiresAt FROM sessions WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');

/** Заводит сессию, возвращает opaque-токен (32 байта hex). */
export function createSession(userId: string, ttlMs = SESSION_TTL_MS): string {
  const token = randomBytes(32).toString('hex');
  insertSessionStmt.run(token, userId, Date.now() + ttlMs);
  return token;
}
/** userId по валидному непросроченному токену; иначе null (просроченный удаляется). */
export function getSession(token: string): string | null {
  const row = sessionStmt.get(token) as { userId: string; expiresAt: number } | undefined;
  if (!row) return null;
  if (row.expiresAt < Date.now()) { deleteSessionStmt.run(token); return null; }
  return row.userId;
}
export function deleteSession(token: string): void {
  deleteSessionStmt.run(token);
}

// ── Персонажи ──────────────────────────────────────────────────────────────────
export interface CharacterSummary { charId: string; name: string; classId: string; level: number; }
export interface CharacterRow { userId: string; data: SaveState; }

const upsertCharStmt = db.prepare(
  `INSERT INTO characters (charId, userId, data, updatedAt) VALUES (?, ?, ?, ?)
   ON CONFLICT(charId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
);
const charStmt = db.prepare('SELECT userId, data FROM characters WHERE charId = ?');
const charsByUserStmt = db.prepare('SELECT data FROM characters WHERE userId = ? ORDER BY updatedAt DESC');
const deleteCharStmt = db.prepare('DELETE FROM characters WHERE charId = ? AND userId = ?');
const countCharsStmt = db.prepare('SELECT COUNT(*) AS n FROM characters WHERE userId = ?');

/** Пишет/обновляет сейв персонажа (владелец фиксируется при создании). */
export function putCharacter(charId: string, userId: string, data: SaveState): void {
  upsertCharStmt.run(charId, userId, JSON.stringify(data), Date.now());
}
/** Персонаж по charId (с владельцем) — для проверки владения на входе. */
export function getCharacter(charId: string): CharacterRow | null {
  const row = charStmt.get(charId) as { userId: string; data: string } | undefined;
  return row ? { userId: row.userId, data: JSON.parse(row.data) as SaveState } : null;
}
/** Краткий ростер пользователя (для экрана выбора). */
export function listCharacters(userId: string): CharacterSummary[] {
  const rows = charsByUserStmt.all(userId) as { data: string }[];
  return rows.map((r) => {
    const s = JSON.parse(r.data) as SaveState;
    return { charId: s.charId, name: s.name, classId: s.classId, level: s.level };
  });
}
export function deleteCharacter(charId: string, userId: string): void {
  deleteCharStmt.run(charId, userId);
}
export function countCharacters(userId: string): number {
  return (countCharsStmt.get(userId) as { n: number }).n;
}

// ── Оверрайды конфигов (единая серверная истина: редактор пишет, игра+редактор читают) ──
const upsertConfigStmt = db.prepare(
  `INSERT INTO config_overrides (key, json, updatedAt) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`,
);
const allConfigStmt = db.prepare('SELECT key, json FROM config_overrides');
const deleteConfigStmt = db.prepare('DELETE FROM config_overrides WHERE key = ?');

/** Все персистентные оверрайды конфигов (ключ→значение) — применяются поверх дефолтов. */
export function getConfigOverrides(): Record<string, unknown> {
  const rows = allConfigStmt.all() as { key: string; json: string }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = JSON.parse(r.json);
  return out;
}
/** Пишет/обновляет оверрайд одного конфига (персистентно). */
export function setConfigOverride(key: string, value: unknown): void {
  upsertConfigStmt.run(key, JSON.stringify(value), Date.now());
}
/** Удаляет оверрайд ключа (сброс к встроенному дефолту). */
export function deleteConfigOverride(key: string): void {
  deleteConfigStmt.run(key);
}

// ── Общий сундук аккаунта (shared stash: одна истина на всех персонажей пользователя) ──
const upsertStashStmt = db.prepare(
  `INSERT INTO account_stash (userId, data, updatedAt) VALUES (?, ?, ?)
   ON CONFLICT(userId) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
);
const stashStmt = db.prepare('SELECT data FROM account_stash WHERE userId = ?');

/** Сундук аккаунта из БД (или null, если ещё пуст). */
export function getAccountStash(userId: string): AccountStash | null {
  const row = stashStmt.get(userId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as AccountStash) : null;
}
/** Пишет/обновляет сундук аккаунта (last-writer-wins). */
export function putAccountStash(userId: string, data: AccountStash): void {
  upsertStashStmt.run(userId, JSON.stringify(data), Date.now());
}
