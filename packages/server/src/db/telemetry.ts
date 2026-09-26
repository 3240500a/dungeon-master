import { q, q1 } from './pool.js';
import type { SessionTelemetry } from '../net/telemetry.js';

/**
 * Хранение телеметрии поведения (Ф3.2): одна строка на игровую сессию.
 *
 * Отдельная таблица, а не колонки в `characters`: это наблюдения, а не состояние игры.
 * Их можно чистить по сроку, выгружать и агрегировать, ничем не рискуя, — и потеря
 * телеметрии не должна ронять игру (все записи здесь «стараются», но не бросают наверх).
 *
 * ПРО АДРЕС. IP пишется, потому что без него не проверить главную сигнатуру ботоводства —
 * пачку аккаунтов, входящих и выходящих синхронно с одного адреса. Это внутренние
 * эксплуатационные данные сервера, наружу они не отдаются (`/metrics` и так только с localhost).
 */

export interface PlaySessionRow {
  id: string;
  user_id: string;
  char_id: string;
  ip: string | null;
  started_at: Date;
  ended_at: Date | null;
  minutes: number;
  kills: number;
  gold: number;
  xp: number;
  items: number;
  deaths: number;
  floors: number;
  actions: number;
  action_mean_ms: number;
  action_sd_ms: number;
  /** Кузница (K7): скованно, переплавлено, разобрано, зачаровано за сессию. */
  crafted: number;
  melted: number;
  salvaged: number;
  enchanted: number;
}

/**
 * Записать состояние сессии. Первый вызов заводит строку и возвращает её id, дальнейшие
 * обновляют её же — поэтому длинная сессия видна ДО своего конца. Это существенно: сигнатура
 * «шестнадцать часов без пауз» на строке, которая пишется только при выходе, не сработает
 * никогда, потому что бот из игры не выходит.
 */
export async function upsertPlaySession(
  id: string | null, userId: string, charId: string, ip: string | null,
  t: SessionTelemetry, ended: boolean,
): Promise<string | null> {
  const iv = t.intervals();
  try {
    if (!id) {
      const r = await q1<{ id: string }>(
        `INSERT INTO play_sessions
           (user_id, char_id, ip, started_at, updated_at, ended_at, minutes,
            kills, gold, xp, items, deaths, floors, actions, action_mean_ms, action_sd_ms,
            crafted, melted, salvaged, enchanted)
         VALUES ($1,$2,$3, to_timestamp($4/1000.0), now(), $5, $6, $7,$8,$9,$10,$11,$12,$13,$14,$15, $16,$17,$18,$19)
         RETURNING id`,
        [userId, charId, ip, t.startedAt, ended ? new Date() : null, t.minutes(),
          t.kills, t.gold, t.xp, t.items, t.deaths, t.floors, t.actions, iv.meanMs, iv.sdMs,
          t.crafted, t.melted, t.salvaged, t.enchanted]);
      return r?.id ?? null;
    }
    await q(
      `UPDATE play_sessions SET updated_at = now(), ended_at = $2, minutes = $3,
         kills = $4, gold = $5, xp = $6, items = $7, deaths = $8, floors = $9,
         actions = $10, action_mean_ms = $11, action_sd_ms = $12,
         crafted = $13, melted = $14, salvaged = $15, enchanted = $16
       WHERE id = $1`,
      [id, ended ? new Date() : null, t.minutes(),
        t.kills, t.gold, t.xp, t.items, t.deaths, t.floors, t.actions, iv.meanMs, iv.sdMs,
        t.crafted, t.melted, t.salvaged, t.enchanted]);
    return id;
  } catch (e) {
    // Наблюдения не стоят того, чтобы из-за них падала игра.
    console.warn('[телеметрия] не записалась:', e instanceof Error ? e.message : e);
    return id;
  }
}

/** Сессии за последние `hours` часов — вход детектора аномалий (Ф3.3). */
export async function recentSessions(hours = 24): Promise<PlaySessionRow[]> {
  return q<PlaySessionRow>(
    `SELECT id, user_id, char_id, ip, started_at, ended_at, minutes, kills, gold, xp,
            items, deaths, floors, actions, action_mean_ms, action_sd_ms,
            crafted, melted, salvaged, enchanted
     FROM play_sessions
     WHERE updated_at > now() - ($1 || ' hours')::interval
     ORDER BY started_at`, [String(hours)]);
}

/** Убрать старые наблюдения: телеметрия не должна копиться вечно. */
export async function prunePlaySessions(days = 30): Promise<number> {
  const rows = await q<{ id: string }>(
    `DELETE FROM play_sessions WHERE updated_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(days)]);
  return rows.length;
}
