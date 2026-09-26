import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Аудит (Ф2.6) — правила, которые меняет ковка (D9), без базы. Пул замокан: запросы отвечают
 * заготовками по тексту SQL, и видно, КАКОЙ запрос строит аудит. Сама сверка сейвов с леджером
 * против настоящей базы проверяется в `items.test.ts`.
 */
const db = vi.hoisted(() => ({
  sql: [] as string[],
  /** Запросы, ушедшие ВНУТРИ транзакции (`tx`), — отдельно: видно, какие чтения делят один снимок (R3-18). */
  txSql: [] as string[],
  /** Ответы по подстроке запроса: первая совпавшая пара выигрывает. */
  answers: [] as [RegExp, unknown[]][],
}));

vi.mock('./pool.js', () => {
  const answer = (text: string): unknown[] => {
    for (const [re, rows] of db.answers) if (re.test(text)) return rows;
    return [];
  };
  const run = (text: string): unknown[] => { db.sql.push(text); return answer(text); };
  return {
    q: (text: string) => Promise.resolve(run(text)),
    q1: (text: string) => Promise.resolve(run(text)[0] ?? null),
    // Аудит только читает: транзакция нужна ему ради общего снимка, не ради записи.
    tx: <T>(fn: (c: { query: (text: string) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> =>
      fn({ query: (text: string) => { db.txSql.push(text); return Promise.resolve({ rows: answer(text) }); } }),
  };
});

const { runAudit, medianOutliers, KNOWN_REASONS } = await import('./audit.js');

/** Пять обычных аккаунтов по `n` событий и один шумный. */
const rows = (n: number, loud: number): { user_id: string; n: string }[] => [
  ...['a', 'b', 'c', 'd', 'e'].map((u) => ({ user_id: u, n: String(n) })),
  { user_id: 'шумный', n: String(loud) },
];

beforeEach(() => { db.sql = []; db.txSql = []; db.answers = []; });

describe('медиана и выбросы', () => {
  it('впятеро выше медианы — выброс; меньше пяти аккаунтов — медиана ничего не значит', () => {
    expect(medianOutliers(rows(4, 20))!.loud.map((r) => r.user_id)).toEqual(['шумный']);
    expect(medianOutliers(rows(4, 19))!.loud).toEqual([]);
    expect(medianOutliers(rows(4, 20).slice(0, 4))).toBeNull();
  });
});

describe('аудит и ковка (D9)', () => {
  it('⭐ проверка добычи НЕ считает скованное: иначе кузнец выглядел бы фармером', async () => {
    await runAudit();
    // Запрос добычи — суточный счёт рождений по аккаунтам, но НЕ запрос ковки (`AND reason LIKE 'craft%'`).
    const loot = db.sql.find((s) => /interval '24 hours'/.test(s) && /GROUP BY user_id/.test(s) && !/AND reason LIKE 'craft%'/.test(s));
    expect(loot, 'запрос добычи на месте').toBeTruthy();
    expect(loot).toMatch(/reason IS NULL OR reason NOT LIKE 'craft%'/);
  });

  it('⭐ ковка — своя проверка: шумный кузнец виден как «внимание», а не инцидент', async () => {
    db.answers.push([/AND reason LIKE 'craft%'/, rows(3, 40)]);
    const r = await runAudit();
    const f = r.findings.find((x) => x.kind === 'craft-outlier');
    expect(f, 'выброс ковки найден').toBeTruthy();
    expect(f!.severity).toBe('attention');
    expect(f!.examples.join(' ')).toContain('шумный');
    expect(r.findings.some((x) => x.kind === 'loot-outlier'), 'в добычу он не попал').toBe(false);
    expect(r.incidents).toBe(0);
  });

  it('причины кузницы известны аудиту, чужая — нет', async () => {
    expect(KNOWN_REASONS).toEqual(expect.arrayContaining(['craft', 'enchant', 'salvage', 'melt', 'forge', 'stash', 'autosave']));
    db.answers.push([/GROUP BY reason/, [
      { reason: 'craft', n: '3' }, { reason: 'enchant', n: '1' }, { reason: 'salvage', n: '2' },
      { reason: 'melt', n: '1' }, { reason: 'forge', n: '4' }, { reason: 'stash', n: '9' },
    ]]);
    expect((await runAudit()).findings.some((x) => x.kind === 'reason')).toBe(false);

    db.answers = [[/GROUP BY reason/, [{ reason: 'рука-админа', n: '1' }, { reason: null, n: '2' }]]];
    const f = (await runAudit()).findings.find((x) => x.kind === 'reason');
    expect(f?.examples).toEqual(['рука-админа: 1', '(без причины): 2']);
  });
});

describe('аудит и живая игра (R3-18)', () => {
  it('⭐ персонажи, сундуки и леджер читаются ОДНИМ снимком — транзакцией REPEATABLE READ только для чтения', async () => {
    await runAudit();
    expect(db.txSql[0], 'уровень изоляции — до первого чтения').toMatch(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/);
    for (const re of [/SELECT char_id, user_id, data FROM characters/, /SELECT user_id, data FROM account_stash/, /SELECT id, loc, user_id FROM items/]) {
      expect(db.txSql.some((t) => re.test(t)), `${re} — в транзакции`).toBe(true);
      expect(db.sql.some((t) => re.test(t)), `${re} — не мимо неё`).toBe(false);
    }
  });
});
