import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from './registry.js';
import { configRev, configRevs, staleConfigKeys } from './configRev.js';

/**
 * ⭐ C-09: РЕВИЗИЯ ТАБЛИЦЫ КОНФИГА — «поверх какой правды сервера правка». Редактор шлёт таблицу ЦЕЛИКОМ (`balance` — все цены, ковка,
 * штраф смерти…), и сервер заменял оверрайд таблицы молча: вкладка, открытая, пока сервер лежал (встроенные дефолты), или со старым снимком
 * (правили в другой вкладке, инструментом, на другой машине) одним «Применить» откатывала всю таблицу у всех игроков. Теперь запись несёт
 * ревизии загруженного (`__baseRev`), и сервер отказывает (409), если таблица на нём уже другая.
 */
describe('⭐ C-09: ревизия таблицы конфига и сверка базы записи', () => {
  it('ревизия — одна у сервера (живой реестр) и у редактора (таблица из тела `/api/config`)', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const body = JSON.stringify(reg.snapshot());   // так сервер отдаёт `/api/config`
    const seen = JSON.parse(body) as Record<string, unknown>;   // так его читает редактор
    for (const key of ['balance', 'difficulties', 'items.base', 'weapon-parts'] as const) {
      expect(configRev(seen[key]), key).toBe(configRev(reg.get(key)));
    }
  });

  it('правка меняет ревизию — и число той же длины, и буква того же кода в младшем байте (кириллица)', () => {
    const a = { forgePrices: { a: 120 }, name: 'Меч' };
    expect(configRev({ ...a, forgePrices: { a: 130 } })).not.toBe(configRev(a));
    expect(configRev({ ...a, name: 'Мещ' })).not.toBe(configRev(a));
    // «ч» (U+0447) и «G» (U+0047) — один младший байт: ревизия по байтам (как ETag тела) их не различала бы.
    expect(configRev('ч')).not.toBe(configRev('G'));
    expect(configRev(a)).toBe(configRev(structuredClone(a)));
  });

  it('сверка: без базы — не сверяем (старые клиенты, скрипты); база совпала — можно; другая или нет ключа — конфликт', () => {
    const cur: Record<string, unknown> = { balance: { x: 1 }, rarities: [1, 2] };
    const get = (k: string): unknown => cur[k];
    const keys = ['balance', 'rarities'];
    expect(staleConfigKeys(undefined, keys, get)).toEqual([]);
    expect(staleConfigKeys(configRevs(keys, get), keys, get)).toEqual([]);
    const base = configRevs(keys, get);
    cur.balance = { x: 2 };   // таблицу успел сохранить кто-то другой
    expect(staleConfigKeys(base, keys, get)).toEqual(['balance']);
    expect(staleConfigKeys({ rarities: base.rarities }, keys, get), 'база без ключа — не «можно»').toEqual(['balance']);
    expect(staleConfigKeys('мусор', keys, get), 'база не того вида — как без неё нельзя: конфликт').toEqual(keys);
  });
});
