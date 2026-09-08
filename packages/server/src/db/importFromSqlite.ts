import { DatabaseSync } from 'node:sqlite';
import { initSchema, q, closePool } from './pool.js';

/**
 * Разовый перенос АВТОРСКОГО КОНТЕНТА из старой базы `node:sqlite` в Postgres (Ф2).
 *
 *   npm run db:import -- --from=packages/server/data/dm.db
 *
 * Переносятся ТОЛЬКО две таблицы: `config_overrides` (правки баланса/контента из редактора)
 * и `pose_store` (клипы и позы 3D-редактора). Это работа руками, её терять нельзя.
 *
 * Аккаунты, персонажи, сундуки и сессии НЕ переносятся сознательно: на момент перехода это
 * тестовые данные, а Ф2 меняет саму форму хранения предметов — тащить в новую схему старые
 * блобы значило бы тащить и все их болезни. Новая база начинается с чистого листа.
 */
const from = process.argv.find((a) => a.startsWith('--from='))?.slice(7) ?? 'packages/server/data/dm.db';

async function main(): Promise<void> {
  const src = new DatabaseSync(from, { readOnly: true });
  await initSchema();

  let cfg = 0;
  for (const r of src.prepare('SELECT key, json, updatedAt FROM config_overrides').all() as { key: string; json: string; updatedAt: number }[]) {
    await q(`INSERT INTO config_overrides (key, json, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      [r.key, r.json, r.updatedAt]);
    cfg++;
  }

  let poses = 0;
  for (const r of src.prepare('SELECT key, json, updatedAt FROM pose_store').all() as { key: string; json: string; updatedAt: number }[]) {
    await q(`INSERT INTO pose_store (key, json, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      [r.key, r.json, r.updatedAt]);
    poses++;
  }

  // Сверка размеров: молчаливая потеря половины клипов выглядела бы как успешный перенос.
  const sizes = await q<{ key: string; n: string }>(
    `SELECT key, length(json::text) AS n FROM pose_store ORDER BY length(json::text) DESC LIMIT 3`);
  console.log(`перенесено: оверрайдов конфига ${cfg}, ключей поз ${poses}`);
  console.log(`крупнейшие ключи поз: ${sizes.map((s) => `${s.key} ${(Number(s.n) / 1024).toFixed(0)} КБ`).join(', ')}`);
  src.close();
  await closePool();
}

void main();
