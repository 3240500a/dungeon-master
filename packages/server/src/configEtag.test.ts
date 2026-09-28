import { describe, it, expect } from 'vitest';
import { ConfigRegistry, PRICE_CHANGED, configChanged } from '@dm/shared';
import { configEtagOf, configReplyOf } from './configEtag.js';

/**
 * ⭐ ETag ОБЯЗАН МЕНЯТЬСЯ ОТ ЛЮБОЙ ПРАВКИ ТЕЛА.
 *
 * Прежняя версия брала каждый 64-й символ: правка числа той же длины давала ТОТ ЖЕ ETag, клиент
 * получал 304 и жил со старым конфигом. Это тот самый случай «поправил, перезапустил всё, ничего
 * не изменилось» — и по виду не отличимый от «правка не сохранилась».
 */
describe('ETag конфига', () => {
  it('⭐ правка ОДНОГО символа в любом месте меняет ETag', () => {
    const body = JSON.stringify({ models: Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, scale: 1 })) });
    const base = configEtagOf(body);
    let same = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      const alt = body.slice(0, i) + (ch === 'x' ? 'y' : 'x') + body.slice(i + 1);   // длина сохраняется
      if (configEtagOf(alt) === base) same++;
    }
    expect(same, `⚠ ${same} позиций тела не влияют на ETag`).toBe(0);
    expect(body.length).toBeGreaterThan(500);   // тело заведомо длиннее прежнего шага выборки
  });

  it('одинаковое тело — одинаковый ETag (иначе 304 не сработает никогда)', () => {
    const b = '{"a":1,"b":[1,2,3]}';
    expect(configEtagOf(b)).toBe(configEtagOf(b));
  });

  it('формат слабого ETag сохранён', () => {
    expect(configEtagOf('{}')).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
  });
});

/**
 * ⭐ R16 C-07: ОТВЕТ `/api/config` НЕСЁТ РЕВИЗИЮ СЕРВЕРА. Вкладка клала в согласие команд кузницы и лавки (`cfgRev`) ревизию, посчитанную по
 * телу, разобранному СВОЕЙ схемой, — у вкладки, пережившей деплой со сменой формы таблицы, она расходилась с серверной навсегда. Теперь сервер
 * присылает свою (`CONFIG_REV_HEADER`) с тем же снимком, что тело и ETag, и её же сверяет нода.
 */
describe('⭐ R16 C-07: ответ /api/config — тело, ETag и ревизия сервера с одного снимка', () => {
  it('ревизия ответа — ревизия реестра (её сверяет `configChanged`); тело и ETag — те же, что прежде', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const reply = configReplyOf(reg);
    expect(reply.rev).toBe(reg.revision());
    expect(configChanged(reg, reply.rev), 'согласие по ревизии ответа — проходит').toBeNull();
    expect(reply.body).toBe(JSON.stringify(reg.snapshot()));
    expect(reply.etag).toBe(configEtagOf(reply.body));
  });

  it('⭐ вкладка старшей схемы (поле нового выпуска срезано её разбором): своя ревизия — не серверная, а ревизия ответа — согласие', () => {
    const server = new ConfigRegistry();
    server.loadAll();
    const data = (server as unknown as { data: Record<string, unknown> }).data;
    data.balance = { ...(data.balance as object), knobOfNextRelease: 3 };   // так выглядит разобранный конфиг нового выпуска
    const reply = configReplyOf(server);
    const tab = new ConfigRegistry();
    tab.loadAll();
    tab.reload(JSON.parse(reply.body) as Record<string, unknown>);   // `App.syncConfig`: разбор «удался» — поле срезано
    expect(tab.revision(), 'было: согласие по ней — отказ без конца').not.toBe(reply.rev);
    expect(configChanged(server, tab.revision())?.reason?.startsWith(PRICE_CHANGED)).toBe(true);
    expect(configChanged(server, reply.rev)).toBeNull();
  });
});
