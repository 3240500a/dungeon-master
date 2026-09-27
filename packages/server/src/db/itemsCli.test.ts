import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ `npm run items:audit` НА БАЗЕ, ГДЕ СЕРВЕР ЕЩЁ НЕ СТАРТОВАЛ. Инструмент поднимал только основную схему, а аудит читает
 * и закрепления кластера (проверка 6: закрепления за исчезнувшими узлами): на базе после одного лишь `create-admin` сверка
 * проходила всю базу и падала в самом конце на «отношение char_claims не существует». Вскрылось, когда тесты базы уехали в
 * свои схемы: в общей тестовой базе таблицы кластера всегда оставлял кто-то из соседних файлов.
 *
 * Настоящий инструмент — отдельным процессом (`node --import tsx`), как его зовёт `npm run`, против своей схемы файла в
 * `dungeon_test` (`testDb.ts`); без базы тест пропускается.
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('itemscli'));

let alive = false;
beforeAll(async () => {
  alive = await tdb.open();
  if (!alive) return;
  // Как после `create-admin` на свежей базе: основная схема есть, схемы кластера нет.
  const pool = await import('./pool.js');
  await pool.initSchema();
  await pool.closePool();
});
afterAll(async () => { if (alive) await tdb.drop(); });

/** Запустить инструмент предметов с аргументами; адрес базы — схема этого файла. */
function itemsCli(...args: string[]): Promise<{ code: number; out: string }> {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));   // packages/server: оттуда `tsx` и зовёт `npm run`
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/db/itemsCli.ts', ...args],
      { cwd, env: { ...process.env, DM_PG: process.env.DM_PG }, timeout: 90_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}\n${stderr}` }));
  });
}

describe.runIf(process.env.DM_SKIP_PG !== '1')('items:audit на свежей базе', () => {
  it('⭐ сверка проходит до конца и печатает отчёт — схему кластера инструмент поднимает сам', async () => {
    if (!alive) return;
    const r = await itemsCli('audit');
    expect(r.out, 'на «char_claims не существует» инструмент больше не падает').not.toMatch(/char_claims/);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('АУДИТ ИНВАРИАНТОВ');
  }, 120_000);
});
