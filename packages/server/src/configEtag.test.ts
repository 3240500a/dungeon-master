import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ConfigRegistry, PRICE_CHANGED, configChanged, playerLocales, UI_CORPUS, CONFIG_FULL_URL, CONFIG_REV_HEADER, CONFIG_GAME_REV_HEADER, type Locales,
} from '@dm/shared';
import { configEtagOf, configReplyOf } from './configEtag.js';
import { installConfigRead } from './net/configRoutes.js';

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

  it('⭐ R15-07: знак, чей младший байт совпадает с заменой («G»/«ч», «0»/«а», «1»/«б», пробел/«Р»), меняет ETag', () => {
    // Раньше хэш брал только младший байт кода знака: правка той же длины такой заменой давала ТОТ ЖЕ ETag при новой ревизии — 304 со
    // старым конфигом и старой ревизией, и каждая команда согласия — «Цена изменилась» по кругу.
    for (const [a, b] of [['G', 'ч'], ['0', 'а'], ['1', 'б'], [' ', 'Р'], ['A', 'с']] as const) {
      expect(a.charCodeAt(0) & 0xff, `${a}/${b}: младшие байты равны`).toBe(b.charCodeAt(0) & 0xff);
      expect(configEtagOf(`{"name":"Клинок ${a}"}`), `${a} → ${b}`).not.toBe(configEtagOf(`{"name":"Клинок ${b}"}`));
    }
  });

  it('⭐ R15-07: настоящий конфиг — «Обычный» → «О1ычный» (та же длина): другой ETag, как и другая ревизия', () => {
    const a = new ConfigRegistry(); a.loadAll();
    const b = new ConfigRegistry(); b.loadAll();
    const rar = structuredClone(b.get('rarities')) as { name: string }[];
    const i = rar.findIndex((r) => r.name.includes('б'));
    expect(i, 'в названиях редкостей есть «б»').toBeGreaterThanOrEqual(0);
    rar[i]!.name = rar[i]!.name.replace('б', '1');
    b.reload({ rarities: rar });
    const ra = configReplyOf(a), rb = configReplyOf(b);
    expect(rb.body.length).toBe(ra.body.length);
    expect(rb.rev, 'ревизия другая').not.toBe(ra.rev);
    expect(rb.etag, 'и ETag другой — 304 со старым конфигом невозможен').not.toBe(ra.etag);
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
    // ⭐ i18n (07.11, шаг 9): снимок целиком — полное тело (редактору); тело игрока — тот же снимок с тонкой таблицей языков (`playerLocales`)
    expect(reply.full.body).toBe(JSON.stringify(reg.snapshot()));
    expect(reply.full.etag).toBe(configEtagOf(reply.full.body));
    expect(reply.body).toBe(JSON.stringify({ ...reg.snapshot(), locales: playerLocales(reg.get('locales') as Locales) }));
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

/**
 * ⭐ i18n (07.11, шаг 9): ТОНКАЯ ТАБЛИЦА ЯЗЫКОВ ДЛЯ ИГРОКА. Английский пакет (5 301 строка, ≈ 340 КБ) ехал в теле `/api/config` каждому клиенту
 * Unity и в каждом релизе контента, а Unity читает из него только ключи своей обвязки (`ui:`): текст конфига и фраз кода сервер собирает сам.
 * Тело игрока — мета пакетов + `ui:`; редактору — полное (`?locales=full`); ревизии одни; у каждого варианта свой ETag.
 */
describe('⭐ i18n (07.11, шаг 9): тело игрока — тонкая таблица языков, редактору — полная', () => {
  const servers: Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });

  it('тонкая таблица: у каждого пакета мета как есть, из строк — ровно `ui:` (все ключи корпуса Unity, переведённые — на месте)', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const full = reg.get('locales') as Locales;
    const thin = playerLocales(full);
    expect(Object.keys(thin)).toEqual(Object.keys(full));
    for (const [lang, pack] of Object.entries(full)) {
      const { strings, ...meta } = pack;
      const { strings: tStrings, ...tMeta } = thin[lang]!;
      expect(tMeta, `${lang}: мета пакета`).toEqual(meta);
      const ui = Object.fromEntries(Object.entries(strings).filter(([k]) => k.startsWith('ui:')));
      expect({ ...tStrings }, `${lang}: строки — только ui:`).toEqual(ui);
    }
    const en = thin.en!;
    expect(en.enabled, 'английский включён').toBe(true);
    const missing = Object.keys(UI_CORPUS).filter((k) => en.strings[k] === undefined);
    expect(missing, 'вся обвязка Unity — в тонком пакете').toEqual([]);
    expect(Object.keys(en.strings).some((k) => k.startsWith('cfg:') || k.startsWith('srv:'))).toBe(false);
    expect(full.en!.strings['srv:loot.picked'], 'полная — с фразами сервера').toBeDefined();
    // реестр сервера держит полную таблицу (он собирает текст), вынос строк его не трогает
    expect(Object.keys(reg.get('locales').en!.strings).length).toBeGreaterThan(5000);
    // язык с кодом `__proto__` ложится ключом, а не прототипом ответа
    const odd = playerLocales(JSON.parse('{"__proto__":{"name":"X","enabled":false,"grammar":{"join":" ","agrees":true,"capitalize":"first"},"templates":{},"strings":{"ui:a.b":"x","cfg:t/r/name":"y"}}}') as Locales);
    expect(Object.keys(odd)).toEqual(['__proto__']);
    expect(JSON.stringify(odd)).toBe('{"__proto__":{"name":"X","enabled":false,"grammar":{"join":" ","agrees":true,"capitalize":"first"},"templates":{},"strings":{"ui:a.b":"x"}}}');
  });

  it('`GET /api/config` — тело игрока, `?locales=full` — полное; ETag и 304 — свои у каждого варианта, ревизии — одни; тело игрока меньше на пакет строк', async () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const reply = configReplyOf(reg);
    const app = express();
    installConfigRead(app, () => reply, { noStore: true });
    const s = await new Promise<Server>((resolve) => { const v = app.listen(0, '127.0.0.1', () => resolve(v)); });
    servers.push(s);
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const thinR = await fetch(`${base}/api/config`);
    const fullR = await fetch(`${base}${CONFIG_FULL_URL}`);
    const thinBody = await thinR.text(), fullBody = await fullR.text();
    expect(thinBody).toBe(reply.body);
    expect(fullBody).toBe(reply.full.body);
    expect(thinR.headers.get('etag')).toBe(reply.etag);
    expect(fullR.headers.get('etag')).toBe(reply.full.etag);
    expect(reply.etag).not.toBe(reply.full.etag);
    for (const r of [thinR, fullR]) {
      expect(r.headers.get(CONFIG_REV_HEADER)).toBe(reg.revision());
      expect(r.headers.get(CONFIG_GAME_REV_HEADER)).toBe(reg.gameRevision());
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    // ревизия, посчитанная клиентом по тонкому телу, — та же, что по полному: языки вне ревизий
    const tab = new ConfigRegistry();
    tab.loadAll();
    tab.reload(JSON.parse(thinBody) as Record<string, unknown>);
    expect(tab.revision()).toBe(reg.revision());
    expect(tab.gameRevision()).toBe(reg.gameRevision());
    // 304 — только своему ETag: ETag другого варианта — тело
    expect((await fetch(`${base}/api/config`, { headers: { 'if-none-match': reply.etag } })).status).toBe(304);
    expect((await fetch(`${base}${CONFIG_FULL_URL}`, { headers: { 'if-none-match': reply.full.etag } })).status).toBe(304);
    expect((await fetch(`${base}/api/config`, { headers: { 'if-none-match': reply.full.etag } })).status).toBe(200);
    expect((await fetch(`${base}${CONFIG_FULL_URL}`, { headers: { 'if-none-match': reply.etag } })).status).toBe(200);
    // замер: тело игрока легче полного больше чем на 250 КБ (английский пакет без cfg:/srv:), сам пакет игрока — меньше 40 КБ
    const bytes = (t: string): number => Buffer.byteLength(t, 'utf8');
    expect(bytes(fullBody) - bytes(thinBody)).toBeGreaterThan(250_000);
    expect(bytes(JSON.stringify((JSON.parse(thinBody) as { locales: unknown }).locales))).toBeLessThan(40_000);
  });
});
