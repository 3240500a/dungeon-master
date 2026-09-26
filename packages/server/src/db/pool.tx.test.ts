import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ⭐ R2-09: `tx` РАЗЛИЧАЕТ, НА КАКОМ ШАГЕ СЛОМАЛАСЬ ТРАНЗАКЦИЯ. Сбой до `COMMIT` — транзакция откачена наверняка
 * (ROLLBACK прошёл, или соединение закрыто — открытую транзакцию база откатывает сама). Сбой на самом `COMMIT`
 * (таймаут ответа, обрыв) — исход неизвестен: node-postgres по таймауту лишь отклоняет промис, а отправленный
 * `COMMIT` база доводит до конца. Такой сбой — `CommitUnknown`, и вызывающий обязан выяснить исход.
 *
 * `pg` замокан: проверяется ровно логика `tx`, без базы.
 */
const pg = vi.hoisted(() => ({
  sql: [] as string[],
  /** На каком запросе «база» упадёт. */
  failOn: '' as string,
  released: [] as (boolean | undefined)[],
}));
vi.mock('pg', () => {
  const client = {
    query: (text: string) => {
      pg.sql.push(text);
      if (pg.failOn && text === pg.failOn) return Promise.reject(new Error(`Query read timeout (${text})`));
      return Promise.resolve({ rows: [] });
    },
    release: (broken?: boolean) => { pg.released.push(broken); },
    // R3-13: `tx` слушает 'error' соединения, пока держит его, — событий этот мок не шлёт.
    on: () => undefined,
    off: () => undefined,
  };
  class Pool {
    on(): void { /* ошибки простаивающих соединений тесту не нужны */ }
    connect(): Promise<typeof client> { return Promise.resolve(client); }
    query(): Promise<{ rows: unknown[] }> { return Promise.resolve({ rows: [] }); }
    end(): Promise<void> { return Promise.resolve(); }
  }
  return { default: { Pool } };
});

const { tx } = await import('./pool.js');
const { CommitUnknown } = await import('./errors.js');

beforeEach(() => { pg.sql = []; pg.failOn = ''; pg.released = []; });

describe('tx: сбой до фиксации и на фиксации', () => {
  it('⭐ сбой на COMMIT — CommitUnknown (исход неизвестен), а не обычная ошибка', async () => {
    pg.failOn = 'COMMIT';
    const err = await tx(async (c) => { await c.query('UPDATE x'); return 1; }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitUnknown);
    expect(String((err as InstanceType<typeof CommitUnknown>).original)).toMatch(/Query read timeout/);
    expect((err as InstanceType<typeof CommitUnknown>).settled, 'ROLLBACK прошёл — судьба COMMIT решена').toBe(true);
    expect(pg.sql).toEqual(['BEGIN', 'UPDATE x', 'COMMIT', 'ROLLBACK']);
  });

  it('сбой внутри транзакции — сама ошибка: откат наверняка', async () => {
    pg.failOn = 'UPDATE x';
    const err = await tx(async (c) => { await c.query('UPDATE x'); return 1; }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CommitUnknown);
    expect(String(err)).toMatch(/UPDATE x/);
    expect(pg.sql.at(-1)).toBe('ROLLBACK');
  });

  it('успех — результат, соединение возвращается в пул целым', async () => {
    expect(await tx(async () => 7)).toBe(7);
    expect(pg.released).toEqual([false]);
  });
});
