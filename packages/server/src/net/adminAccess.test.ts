import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from 'node:crypto';
import { originAllowed, parseOrigins, keyMatches, isLoopback, localCaller } from './adminAccess.js';

const eq = (a: Buffer, b: Buffer): boolean => timingSafeEqual(a, b);
const LIST = ['http://localhost:5173', 'http://localhost:5174'];

describe('источники (CORS по списку)', () => {
  it('свои дев-серверы пускаем, чужую страницу — нет', () => {
    expect(originAllowed('http://localhost:5173', 'localhost:3001', LIST)).toBe(true);
    expect(originAllowed('http://localhost:5174', 'localhost:3001', LIST)).toBe(true);
    // РАДИ ЭТОГО ВСЁ И ЗАТЕЯНО: страница из интернета, открытая в браузере разработчика,
    // ходит на сервер с 127.0.0.1 и раньше проходила проверку локальности dev-роутов.
    expect(originAllowed('https://evil.example', 'localhost:3001', LIST)).toBe(false);
  });

  it('похожий, но не тот источник не проходит: сравнение точное, не по подстроке', () => {
    expect(originAllowed('http://localhost:5173.evil.example', 'localhost:3001', LIST)).toBe(false);
    expect(originAllowed('http://localhost:51730', 'localhost:3001', LIST)).toBe(false);
    expect(originAllowed('https://localhost:5173', 'localhost:3001', LIST)).toBe(false);   // схема — часть источника
  });

  it('запрос без Origin не отсекаем — CORS про браузер, а не про сервер', () => {
    expect(originAllowed(undefined, 'localhost:3001', LIST)).toBe(true);
    expect(originAllowed(undefined, undefined, [])).toBe(true);
  });

  it('СОБСТВЕННЫЙ хост разрешён всегда — иначе прод-раздача (DM_SERVE_STATIC) сломалась бы на POST', () => {
    expect(originAllowed('http://game.example', 'game.example', [])).toBe(true);
    expect(originAllowed('https://game.example', 'game.example', [])).toBe(true);
    expect(originAllowed('http://other.example', 'game.example', [])).toBe(false);
  });

  it('список читается из переменной, пустые куски выкидываются', () => {
    expect(parseOrigins('a, b ,, c', 'x')).toEqual(['a', 'b', 'c']);
    expect(parseOrigins(undefined, 'http://localhost:5173')).toEqual(['http://localhost:5173']);
    expect(parseOrigins('', 'http://localhost:5173')).toEqual(['http://localhost:5173']);   // пусто → умолчание, а не «пусти всех»
  });
});

describe('ключ процессов (DM_ADMIN_KEY)', () => {
  it('совпадает только точный ключ', () => {
    expect(keyMatches('s3cret', 's3cret', eq)).toBe(true);
    expect(keyMatches('s3cres', 's3cret', eq)).toBe(false);
    expect(keyMatches('s3cret-longer', 's3cret', eq)).toBe(false);   // разная длина отсеивается ДО сравнения
  });

  it('ПУСТОЙ КЛЮЧ НЕ ПУСКАЕТ НИКОГО — иначе незаданная переменная открыла бы всё без пароля', () => {
    expect(keyMatches('', '', eq)).toBe(false);
    expect(keyMatches('что угодно', '', eq)).toBe(false);
    expect(keyMatches('', 's3cret', eq)).toBe(false);
  });

  it('сравнение не роняется на разной длине (timingSafeEqual этого не прощает)', () => {
    expect(() => keyMatches('a', 'abcdef', eq)).not.toThrow();
  });
});

describe('⭐ R3-03: служебные ручки — только прямому вызову с самой машины', () => {
  it('петля во всех записях — петля; чужой адрес — нет', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', '0000:0000:0000:0000:0000:0000:0000:0001',
      '0000:0000:0000:0000:0000:ffff:7f00:0001', 'localhost']) expect(isLoopback(a), a).toBe(true);
    for (const a of ['10.8.1.3', '::ffff:10.8.1.3', '128.0.0.1', '::2', '', undefined, 'evil.example']) expect(isLoopback(a), String(a)).toBe(false);
  });

  it('петля без заголовков прокси — своя машина; с любым из них — запрос пришёл через прокси', () => {
    expect(localCaller({}, '127.0.0.1')).toBe(true);
    expect(localCaller({ host: 'localhost:3001' }, '::ffff:127.0.0.1')).toBe(true);
    // За прокси uWS и за Caddy/nginx сокет express — петля у КАЖДОГО запроса: решает заголовок прокси.
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'via']) {
      expect(localCaller({ [h]: '203.0.113.9' }, '127.0.0.1'), h).toBe(false);
    }
    expect(localCaller({}, '10.8.1.3'), 'не петля').toBe(false);
    expect(localCaller({}, undefined)).toBe(false);
  });
});
