import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountStash, SaveState } from '@dm/shared';

/**
 * D8: ЛОГИКА ЗАПИСИ «сейв + сундук» — без базы. Пул замокан: `tx` отдаёт поддельный клиент, который
 * отвечает на запросы по заготовке и записывает, что у него спросили, — так видно, КАКОЙ запрос
 * выбран (вставка без затирания или обновление по версии), что транзакция ОТКАТЫВАЕТСЯ на конфликте
 * сундука и что причина доезжает до журнала вещей. Как это ведёт себя в настоящем Postgres,
 * проверяет `items.test.ts` (там, где база есть).
 */
const pg = vi.hoisted(() => ({
  sql: [] as string[],
  params: [] as unknown[][],
  /** Сколько строк вернёт следующий UPDATE characters / запрос к account_stash. */
  saveRows: 1,
  stashRows: 1,
  ended: '' as '' | 'COMMIT' | 'ROLLBACK',
  /** Если задано — запрос к account_stash падает с этой ошибкой (обрыв соединения и т. п.). */
  stashError: '',
  sync: [] as { reason: string; withStash: boolean }[],
  /** Сейв, который увидел журнал вещей, — сериализованным В МОМЕНТ вызова `syncItems` (R1-16). */
  synced: [] as string[],
  /** Задержать ответ на UPDATE characters — «запрос в пути», тик комнаты тем временем идёт (R1-16). */
  updateGate: null as Promise<void> | null,
  /** Транзакция доходит до COMMIT, а его ответ теряется — исход неизвестен (R2-09). */
  commitUnknown: false,
  /** Что покажет сверка после такой фиксации: версия строки и совпадают ли данные с записанными. */
  resolveRow: null as null | { version: number; mine: boolean },
  /** Запросы мимо транзакции (сверка исхода) — текст и параметры. */
  outside: [] as { text: string; params: unknown[] }[],
}));

vi.mock('./pool.js', () => {
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      pg.sql.push(text);
      pg.params.push(params);
      if (text.includes('UPDATE characters')) {
        if (pg.updateGate) await pg.updateGate;
        return { rows: pg.saveRows ? [{ version: 5 }] : [] };
      }
      if (text.includes('account_stash')) {
        if (pg.stashError) return Promise.reject(new Error(pg.stashError));
        return Promise.resolve({ rows: pg.stashRows ? [{ version: 8 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return {
    q: () => Promise.resolve([]),
    q1: (text: string, params: unknown[] = []) => {
      pg.outside.push({ text, params });
      return Promise.resolve(pg.resolveRow);
    },
    // Как настоящий `tx`: исключение внутри = откат и проброс наружу; потерянный ответ на COMMIT — CommitUnknown.
    tx: async (fn: (c: typeof client) => Promise<unknown>) => {
      const { CommitUnknown } = await import('./errors.js');
      let out: unknown;
      try { out = await fn(client); } catch (e) { pg.ended = 'ROLLBACK'; throw e; }
      pg.ended = 'COMMIT';
      if (pg.commitUnknown) throw new CommitUnknown(new Error('Query read timeout'));
      return out;
    },
  };
});
vi.mock('./items.js', () => ({
  syncItems: (_c: unknown, _u: string, _ch: string, s: unknown, stash: unknown, reason: string) => {
    pg.sync.push({ reason, withStash: !!stash });
    pg.synced.push(JSON.stringify(s));
    return Promise.resolve();
  },
}));

const { putCharacterWithStash, putCharacter } = await import('./db.js');

const save = { charId: 'c1', gold: 1 } as unknown as SaveState;
const stash = { version: 1, tabs: [[]], materials: { 'iron-1': 3 } } as unknown as AccountStash;
const stashSql = (): string => pg.sql.find((s) => s.includes('account_stash')) ?? '';

beforeEach(() => {
  pg.sql = []; pg.params = []; pg.saveRows = 1; pg.stashRows = 1; pg.ended = ''; pg.sync = []; pg.stashError = '';
  pg.synced = []; pg.updateGate = null; pg.commitUnknown = false; pg.resolveRow = null; pg.outside = [];
});

describe('putCharacterWithStash — решения по версиям (D8)', () => {
  it('строки сундука не было (версия 0): вставка БЕЗ затирания', async () => {
    const r = await putCharacterWithStash('c1', 'u1', save, 4, stash, 0);
    expect(r).toEqual({ ok: true, version: 5, stashVersion: 8 });
    expect(stashSql()).toMatch(/INSERT INTO account_stash/);
    expect(stashSql(), 'никакого DO UPDATE — иначе вторая сессия затёрла бы первую').toMatch(/ON CONFLICT \(user_id\) DO NOTHING/);
    expect(pg.ended).toBe('COMMIT');
  });

  it('строка есть: обновление только при совпадении версии, версия растёт', async () => {
    await putCharacterWithStash('c1', 'u1', save, 4, stash, 7);
    const i = pg.sql.findIndex((s) => s.includes('account_stash'));
    expect(pg.sql[i]).toMatch(/UPDATE account_stash SET[\s\S]*version = version \+ 1[\s\S]*WHERE user_id = \$1 AND version = \$3/);
    expect(pg.params[i]![0]).toBe('u1');
    expect(pg.params[i]![2], 'предъявлена прочитанная версия').toBe(7);
  });

  it('⭐ сундук обогнали — транзакция ОТКАТЫВАЕТСЯ целиком, журнал вещей не тронут', async () => {
    pg.stashRows = 0;
    const r = await putCharacterWithStash('c1', 'u1', save, 4, stash, 7);
    expect(r).toEqual({ ok: false, conflict: 'stash' });
    expect(pg.ended, 'сейв уже был переписан в этой транзакции — её надо откатить').toBe('ROLLBACK');
    expect(pg.sync).toEqual([]);
  });

  it('гонка первой вставки: DO NOTHING вернул ноль строк — тот же конфликт и откат', async () => {
    pg.stashRows = 0;
    expect(await putCharacterWithStash('c1', 'u1', save, 4, stash, 0)).toEqual({ ok: false, conflict: 'stash' });
    expect(pg.ended).toBe('ROLLBACK');
  });

  it('версия СЕЙВА разошлась — сундук даже не трогаем', async () => {
    pg.saveRows = 0;
    expect(await putCharacterWithStash('c1', 'u1', save, 4, stash, 7)).toEqual({ ok: false, conflict: 'save' });
    expect(stashSql()).toBe('');
    expect(pg.sync).toEqual([]);
  });

  it('D9: причина доезжает до журнала вещей; по умолчанию — stash', async () => {
    await putCharacterWithStash('c1', 'u1', save, 4, stash, 7, 'craft');
    await putCharacterWithStash('c1', 'u1', save, 4, stash, 7);
    expect(pg.sync).toEqual([{ reason: 'craft', withStash: true }, { reason: 'stash', withStash: true }]);
  });

  it('D9: у записи одного сейва — тоже; по умолчанию autosave', async () => {
    await putCharacter('c1', 'u1', save, 4, 'salvage');
    await putCharacter('c1', 'u1', save, 4);
    expect(pg.sync).toEqual([{ reason: 'salvage', withStash: false }, { reason: 'autosave', withStash: false }]);
  });

  it('чужая ошибка базы не глотается — её обязан увидеть вызывающий, транзакция откачена', async () => {
    pg.stashError = 'соединение оборвано';
    await expect(putCharacterWithStash('c1', 'u1', save, 4, stash, 7)).rejects.toThrow('соединение оборвано');
    expect(pg.ended).toBe('ROLLBACK');
  });
});

/**
 * ⭐ R1-16: СЕЙВ ПИШЕТСЯ ОДНИМ СНИМКОМ. Комната отдаёт в запись ЖИВОЙ сейв, а между запросами транзакции
 * её тик продолжает идти (подбор, пояс). Раньше строка сериализовалась в одном месте, а журнал вещей
 * строился по тому же объекту ПОЗЖЕ — и записывал вещь «у персонажа», которой в записанной строке нет
 * (или наоборот). После падения до следующего автосейва ночной аудит видел «пропажу» и «несовпадение»
 * там, где дюпа не было. Теперь и строка, и журнал берут один снимок, снятый в момент вызова.
 */
describe('R1-16: строка сейва и журнал вещей — из одного снимка', () => {
  const live = (): SaveState => ({ charId: 'c1', gold: 1, inventory: [{ uid: 'a' }], equipment: {}, belt: [] } as unknown as SaveState);
  const rowOf = (): string => pg.params[pg.sql.findIndex((q) => q.includes('UPDATE characters'))]![0] as string;

  for (const which of ['putCharacter', 'putCharacterWithStash'] as const) {
    it(`⭐ ${which}: тик дописал сейв, пока запрос в пути, — ни строка, ни журнал этого не видят, и они совпадают`, async () => {
      let open!: () => void;
      pg.updateGate = new Promise<void>((r) => { open = r; });
      const s = live();
      const p = which === 'putCharacter' ? putCharacter('c1', 'u1', s, 4) : putCharacterWithStash('c1', 'u1', s, 4, stash, 7);
      await new Promise((r) => setTimeout(r, 0));
      (s.inventory as unknown[]).push({ uid: 'b' });      // подобрал вещь, пока запрос в пути
      s.gold = 999;
      open();
      await p;
      expect(pg.synced, 'журнал вещей вызван ровно раз').toHaveLength(1);
      expect(pg.synced[0], 'журнал видит ровно записанную строку').toBe(rowOf());
      expect(JSON.parse(rowOf()), 'в строке — сейв на момент вызова').toEqual(live());
    });
  }
});

/**
 * ⭐ R2-09: ОТВЕТ НА COMMIT ПОТЕРЯН. node-postgres по таймауту лишь отклоняет промис, а отправленный `COMMIT` база
 * доводит до конца: «запись упала» могло значить «записано». Запись сверяет строку с тем, что писала, и отвечает
 * правду; не смогла выяснить — бросает `CommitUnknown`, и комната снимает сессию, а не откатывает память к «до».
 */
describe('R2-09: исход фиксации выясняется, а не угадывается', () => {
  for (const which of ['putCharacter', 'putCharacterWithStash'] as const) {
    const write = (): Promise<unknown> => which === 'putCharacter'
      ? putCharacter('c1', 'u1', save, 4)
      : putCharacterWithStash('c1', 'u1', save, 4, stash, 7);

    it(`⭐ ${which}: строка — наша, версия +1 — запись принята`, async () => {
      pg.commitUnknown = true;
      pg.resolveRow = { version: 5, mine: true };
      const r = await write();
      expect(r).toEqual(which === 'putCharacter' ? 5 : { ok: true, version: 5, stashVersion: 8 });
      const check = pg.outside.at(-1)!;
      expect(check.text, 'сверка по данным, а не только по версии').toMatch(/data = \$1::jsonb/);
      expect(check.params[0], 'сверяется ровно записанный снимок').toBe(JSON.stringify(save));
    });

    it(`⭐ ${which}: версия не сдвинулась — исход неизвестен, запись бросает CommitUnknown`, async () => {
      const { CommitUnknown } = await import('./errors.js');
      pg.commitUnknown = true;
      pg.resolveRow = { version: 4, mine: false };
      await expect(write()).rejects.toBeInstanceOf(CommitUnknown);
    });

    it(`${which}: версия ушла дальше чужой записью — тоже неизвестно (не «наше»)`, async () => {
      const { CommitUnknown } = await import('./errors.js');
      pg.commitUnknown = true;
      pg.resolveRow = { version: 5, mine: false };
      await expect(write()).rejects.toBeInstanceOf(CommitUnknown);
    });
  }
});
