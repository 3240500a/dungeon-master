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

  // ⭐ V-B3-07: согласие окна кузницы и лавки на конфиг (`cfgRev`) стоит на том, что ревизия реестра клиента, прочитавшего `/api/config`,
  // РАВНА ревизии сервера — иначе каждую команду ждал бы «Цена изменилась» без конца. Разбор схемой обязан быть идемпотентным для ВСЕХ
  // таблиц (ни `transform`, ни порядка ключей, зависящего от входа), и эта проверка его стережёт.
  it('ревизия реестра: клиент, прочитавший тело `/api/config` (и правку живьём), видит ту же, что сервер; правка её двигает', () => {
    const server = new ConfigRegistry();
    server.loadAll();
    const b = structuredClone(server.get('balance'));
    b.craft.cost.enchantGold += 7;
    server.reload({ balance: b });   // оверрайд из базы / правка редактора
    const client = new ConfigRegistry();
    client.loadAll();   // встроенные дефолты до ответа сервера
    expect(client.revision(), 'дефолты клиента — не конфиг сервера с правкой').not.toBe(server.revision());
    client.reload(JSON.parse(JSON.stringify(server.snapshot())) as Record<string, unknown>);   // `App.syncConfig`
    expect(client.revision()).toBe(server.revision());
    // Таблица за таблицей — чтобы при расхождении было видно, какая схема разбирается неидемпотентно.
    const s = server.snapshot() as Record<string, unknown>, c = client.snapshot() as Record<string, unknown>;
    for (const key of Object.keys(s)) expect(configRev(c[key]), key).toBe(configRev(s[key]));
    // Правка живьём (новая таблица) — новая ревизия; прежняя таблица на месте — прежняя (память по объекту таблицы).
    const before = server.revision();
    expect(server.revision()).toBe(before);
    server.reload({ balance: { ...structuredClone(server.get('balance')), maxTotalRequirement: server.get('balance').maxTotalRequirement + 1 } });
    expect(server.revision()).not.toBe(before);
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
