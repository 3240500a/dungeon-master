import { describe, it, expect } from 'vitest';
import { ConfigRegistry, configRevs, type ConfigKey } from '@dm/shared';
import { configWriter } from './configWrites.js';

/**
 * ⭐ C-09: ЗАПИСЬ ТАБЛИЦЫ КОНФИГА ИЗ РЕДАКТОРА — ТОЛЬКО ПОВЕРХ ТОГО, ЧТО ОН ЗАГРУЗИЛ (`__baseRev`). Роут заменял оверрайд таблицы целиком и
 * молча: вкладка редактора со встроенными дефолтами (сервер лежал на её открытии) или со старым снимком откатывала всю таблицу (`balance` —
 * цены, ковка, штраф смерти) у всех игроков. Теперь — 409 и ничего не записано; без базы (старые клиенты, скрипты) — как было.
 */
describe('⭐ C-09: запись конфига сверяет базу редактора', () => {
  const live = (): { reg: ConfigRegistry; cur: (k: string) => unknown; writes: string[]; write: (patch: Record<string, unknown>) => () => Promise<void> } => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const writes: string[] = [];
    return {
      reg, writes,
      cur: (k) => reg.get(k as ConfigKey),
      // Как роут: оверрайд в базу (ожидание) и пересборка живого реестра.
      write: (patch) => async () => { await new Promise((r) => setTimeout(r, 1)); reg.reload(patch); writes.push(Object.keys(patch).join(',')); },
    };
  };

  it('⭐ база совпала — записано, ответ несёт новые ревизии; база устарела (сохранили в другой вкладке) — 409, ничего не записано', async () => {
    const { reg, cur, writes, write } = live();
    const put = configWriter(cur);
    const base = configRevs(['balance'], cur);
    const bal = structuredClone(reg.get('balance'));
    const a = await put(base, ['balance'], write({ balance: { ...bal, respecCost: bal.respecCost + 5 } }));
    expect(a.ok).toBe(true);
    expect(a.rev, 'новая база — ревизия записанного').toEqual(configRevs(['balance'], cur));
    const b = await put(base, ['balance'], write({ balance: { ...bal, townRestockSec: 1 } }));
    expect(b, 'было: вторая вкладка молча откатывала цену первой').toMatchObject({ ok: false, conflicts: ['balance'] });
    expect(writes).toHaveLength(1);
    expect(reg.get('balance').respecCost, 'правка первой цела').toBe(bal.respecCost + 5);
  });

  it('две записи разом поверх одного снимка — сверка и запись одним шагом: вторая не проходит', async () => {
    const { reg, cur, writes, write } = live();
    const put = configWriter(cur);
    const base = configRevs(['balance'], cur);
    const bal = structuredClone(reg.get('balance'));
    const [a, b] = await Promise.all([
      put(base, ['balance'], write({ balance: { ...bal, respecCost: 1 } })),
      put(base, ['balance'], write({ balance: { ...bal, respecCost: 2 } })),
    ]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(writes).toHaveLength(1);
    expect(reg.get('balance').respecCost).toBe(1);
  });

  it('без базы (старые клиенты, скрипты, `curl`) — как было: пишет; упавшая запись не запирает очередь', async () => {
    const { cur, writes, write } = live();
    const put = configWriter(cur);
    expect((await put(undefined, ['rarities'], write({}))).ok).toBe(true);
    await expect(put(undefined, ['rarities'], async () => { throw new Error('база упала'); })).rejects.toThrow('база упала');
    expect((await put(undefined, ['rarities'], write({}))).ok, 'следующая запись идёт').toBe(true);
    expect(writes).toHaveLength(2);
  });
});
