/**
 * ЧИСТЫЙ ЛИСТ НА СЕРВЕРЕ: снести весь авторский 3D-контент из базы.
 *
 * Зачем отдельный скрипт, если в редакторе есть кнопка. Кнопка ходит через `/api/dev/*`, то есть
 * зависит от сессии, прав и поднятого сервера — и если хоть один DELETE не прошёл, редактор при
 * следующей же загрузке ВЕРНЁТ ВСЁ ОБРАТНО (`syncPoseFromServer` тянет с сервера всё, чего нет
 * локально). Здесь мы говорим с базой напрямую: видно, что было, и видно, что стало.
 *
 *   node tools/wipe-content.mjs           — показать, что лежит (ничего не трогает)
 *   node tools/wipe-content.mjs --yes     — стереть
 *
 * ⚠ Перед запуском стоит сделать дамп: `curl http://localhost:3001/api/pose > backup.json`.
 */
import pg from 'pg';

const URL_ = process.env.DM_PG ?? 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon';
const GO = process.argv.includes('--yes');
const pool = new pg.Pool({ connectionString: URL_ });

const size = (v) => (Array.isArray(v) ? `${v.length} записей` : v && typeof v === 'object' ? `${Object.keys(v).length} ключей` : String(v));

try {
  const { rows } = await pool.query('SELECT key, json FROM pose_store ORDER BY key');
  console.log(`\nБАЗА: ${URL_.replace(/:[^:@]*@/, ':***@')}`);
  console.log(`pose_store: ${rows.length} ключей`);
  for (const r of rows) console.log(`  ${r.key.padEnd(16)} ${size(r.json)}`);

  const ov = await pool.query('SELECT key FROM config_overrides ORDER BY key');
  console.log(`config_overrides: ${ov.rows.length}${ov.rows.length ? ' — ' + ov.rows.map((r) => r.key).join(', ') : ''}`);

  if (!GO) {
    console.log('\nЭто только показ. Стереть: node tools/wipe-content.mjs --yes\n');
  } else {
    await pool.query('DELETE FROM pose_store');
    // Модели живут в игровом конфиге. Пишем ПУСТОЙ оверрайд, а не удаляем его: дефолт берётся из
    // `models.json`, который у запущенного сервера уже в памяти — удаление вернуло бы старый список.
    await pool.query(
      `INSERT INTO config_overrides (key, json) VALUES ('models', '[]'::jsonb)
       ON CONFLICT (key) DO UPDATE SET json = excluded.json`);
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM pose_store');
    console.log(`\nСТЁРТО. pose_store: ${after.rows[0].n} ключей, оверрайд models = [].`);
    console.log('⚠ Перезапусти сервер (npm run dev) — конфиг он держит в памяти.\n');
  }
} catch (e) {
  console.error('\nНе вышло:', e.message);
  console.error('Проверь, что Postgres поднят и строка DM_PG верная.\n');
  process.exitCode = 1;
} finally {
  await pool.end();
}
