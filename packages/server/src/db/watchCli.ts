import { recentSessions, prunePlaySessions } from './telemetry.js';
import { detect, summarize, DEFAULT_THRESHOLDS } from '../net/anomaly.js';
import { q1, closePool, initSchema } from './pool.js';

/**
 * Разбор телеметрии (Ф3.3).
 *
 *   npm run watch:anomalies                 — очередь на разбор за сутки
 *   npm run watch:anomalies -- --hours=72   — окно шире
 *   npm run watch:anomalies -- --prune=30   — заодно убрать наблюдения старше 30 дней
 *
 * НИКОГО НЕ БАНИТ И НИЧЕГО НЕ МЕНЯЕТ. Только читает и печатает — это принципиально, а не
 * «пока не дошли руки»: автоматика по одному сигналу ложно срабатывает гарантированно,
 * а ложный бан стоит дороже десяти пропущенных ботов.
 */
const arg = (k: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function main(): Promise<void> {
  await initSchema();
  const ready = await q1<{ ok: boolean }>(`SELECT to_regclass('play_sessions') IS NOT NULL AS ok`);
  if (!ready?.ok) {
    console.log('в этой базе ещё нет таблицы телеметрии — она не инициализирована.');
    console.log('Схема создаётся при первом старте сервера: npm run dev:server');
    process.exitCode = 1;
    await closePool();
    return;
  }

  const hours = Number(arg('hours') ?? 24);
  const rows = await recentSessions(hours);
  console.log(`ТЕЛЕМЕТРИЯ за ${hours} ч: сессий ${rows.length}\n`);

  if (rows.length) {
    // Общая картина популяции — без неё пороги не с чем сверять.
    const perHour = rows.filter((r) => r.minutes >= 5).map((r) => (r.gold + r.xp) / (r.minutes / 60));
    const sorted = [...perHour].sort((a, b) => a - b);
    const at = (p: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0;
    console.log('ценности в час по популяции:');
    console.log(`  медиана ${Math.round(at(0.5))} · 90-й процентиль ${Math.round(at(0.9))} · максимум ${Math.round(at(1))}`);
    const longest = rows.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    console.log(`  самая длинная сессия: ${(longest.minutes / 60).toFixed(1)} ч`);
    const rhythms = rows.filter((r) => r.actions >= DEFAULT_THRESHOLDS.metronomeMinActions);
    if (rhythms.length) {
      const sd = rhythms.map((r) => r.action_sd_ms).sort((a, b) => a - b);
      console.log(`  разброс ритма (мс): минимум ${sd[0]!.toFixed(0)} · медиана ${sd[sd.length >> 1]!.toFixed(0)}`);
    }
  }

  const queue = summarize(detect(rows));
  console.log(`\nОЧЕРЕДЬ НА РАЗБОР: ${queue.length}`);
  for (const e of queue.slice(0, 20)) {
    console.log(`\n  [${e.score}] аккаунт ${e.userId}  (${e.kinds.join(', ')})`);
    for (const w of e.why) console.log(`      ${w}`);
  }
  if (queue.length > 20) console.log(`\n  … и ещё ${queue.length - 20}`);
  if (!queue.length) console.log('  пусто — сигнатур не сработало');

  console.log('\nЭто ПОМЕТКИ, а не приговор: решение принимает человек, глядя на выгрузку.');

  const prune = arg('prune');
  if (prune) {
    const n = await prunePlaySessions(Number(prune));
    console.log(`убрано наблюдений старше ${prune} дней: ${n}`);
  }
  await closePool();
}

void main();
