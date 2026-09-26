import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter, clientIp, limits, ipBucket } from './rateLimit.js';

/** Токен-бакет лимитов (Ф0.5). Время передаём явно — тест не зависит от таймеров. */
describe('RateLimiter', () => {
  it('пропускает всплеск размером с ёмкость и режет следующий запрос', () => {
    const rl = new RateLimiter(3, 1);
    const t = 1_000_000;
    expect(rl.take('ip', t)).toBe(true);
    expect(rl.take('ip', t)).toBe(true);
    expect(rl.take('ip', t)).toBe(true);
    expect(rl.take('ip', t)).toBe(false);
  });

  it('пополняется со временем', () => {
    const rl = new RateLimiter(2, 1); // 1 токен в секунду
    const t = 1_000_000;
    rl.take('ip', t); rl.take('ip', t);
    expect(rl.take('ip', t)).toBe(false);
    expect(rl.take('ip', t + 1000)).toBe(true);   // прошла секунда — один токен вернулся
    expect(rl.take('ip', t + 1000)).toBe(false);
  });

  it('не копит сверх ёмкости за долгий простой', () => {
    const rl = new RateLimiter(2, 1);
    const t = 1_000_000;
    rl.take('ip', t);
    // час простоя не даёт «накопить» тысячу токенов
    expect(rl.take('ip', t + 3_600_000)).toBe(true);
    expect(rl.take('ip', t + 3_600_000)).toBe(true);
    expect(rl.take('ip', t + 3_600_000)).toBe(false);
  });

  it('ключи независимы', () => {
    const rl = new RateLimiter(1, 0.001);
    const t = 1_000_000;
    expect(rl.take('a', t)).toBe(true);
    expect(rl.take('a', t)).toBe(false);
    expect(rl.take('b', t)).toBe(true); // сосед по IP не наказан
  });

  it('retryAfterSec подсказывает, через сколько можно', () => {
    const rl = new RateLimiter(1, 0.5); // токен раз в 2 секунды
    const t = 1_000_000;
    rl.take('ip', t);
    expect(rl.take('ip', t)).toBe(false);
    expect(rl.retryAfterSec('ip', t)).toBe(2);
  });

  it('reset забывает ключ', () => {
    const rl = new RateLimiter(1, 0.001);
    const t = 1_000_000;
    rl.take('ip', t);
    expect(rl.take('ip', t)).toBe(false);
    rl.reset('ip');
    expect(rl.take('ip', t)).toBe(true);
  });

  it('простаивающие ключи вычищаются, карта не растёт вечно', () => {
    const rl = new RateLimiter(5, 1, 1000); // всё, что старше секунды — выбросить
    const t = 1_000_000;
    for (let i = 0; i < 50; i++) rl.take(`ip${i}`, t);
    expect(rl.size).toBe(50);
    rl.take('свежий', t + 120_000); // чистка запускается не чаще раза в минуту
    expect(rl.size).toBe(1);
  });
});

describe('лимит кузницы (D12)', () => {
  it('всплеск 5, шестая подряд — отказ, дальше 2 в секунду', () => {
    // Свой экземпляр с теми же числами: общий `limits` делят все тесты процесса.
    const rl = new RateLimiter(5, 2);
    const t = 5_000_000;
    for (let i = 0; i < 5; i++) expect(rl.take('p_1', t), `команда ${i + 1}`).toBe(true);
    expect(rl.take('p_1', t), 'шестая подряд').toBe(false);
    expect(rl.take('p_1', t + 499), 'меньше полусекунды — токена ещё нет').toBe(false);
    expect(rl.take('p_1', t + 1000), 'через полсекунды токен вернулся').toBe(true);
  });

  it('числа в общем наборе лимитов именно такие', () => {
    const t = 7_000_000;
    const key = `probe-${Math.random()}`;
    let passed = 0;
    for (let i = 0; i < 10; i++) if (limits.forgeCmd.take(key, t)) passed++;
    expect(passed).toBe(5);
  });
});

describe('⚠ R3-04: создание героев на аккаунт', () => {
  it('весь ростер разом (5) — можно; шестой подряд — отказ; дальше один в 10 минут, простой не обнуляет счёт', () => {
    const t = 9_000_000;
    const key = `user-${Math.random()}`;
    for (let i = 0; i < 5; i++) expect(limits.charCreate.take(key, t), `герой ${i + 1}`).toBe(true);
    expect(limits.charCreate.take(key, t), 'шестой подряд').toBe(false);
    expect(limits.charCreate.take(key, t + 599_000), 'меньше 10 минут — ещё нельзя').toBe(false);
    expect(limits.charCreate.take(key, t + 600_000), 'через 10 минут — один').toBe(true);
    expect(limits.charCreate.take(key, t + 600_000)).toBe(false);
    expect(limits.charCreate.retryAfterSec(key, t + 600_000)).toBeGreaterThan(500);
  });
});

describe('clientIp', () => {
  it('⭐ R3-07: заголовок от НЕдоверенного собеседника не читается — клиент это сам собеседник', () => {
    expect(clientIp({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, '198.51.100.1')).toBe('198.51.100.1');
  });
  it('⭐ R3-07: за прокси на петле клиент — ПРАВЫЙ адрес цепочки (его дописал прокси); левее — что прислал сам клиент', () => {
    expect(clientIp({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7' }, '127.0.0.1')).toBe('203.0.113.7');
    expect(clientIp({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7' }, '::ffff:127.0.0.1')).toBe('203.0.113.7');
  });
  it('доверенные прокси (`DM_TRUST_PROXY`) пропускаются справа налево, до первого чужого', () => {
    const lb = new Set(['192.0.2.10']);
    expect(clientIp({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7, 192.0.2.10' }, '127.0.0.1', lb)).toBe('203.0.113.7');
    expect(clientIp({ 'x-forwarded-for': '10.9.9.9, 203.0.113.7' }, '192.0.2.10', lb)).toBe('203.0.113.7');
    expect(clientIp({ 'x-forwarded-for': '10.9.9.9' }, '192.0.2.11', lb), 'чужой балансировщик — не доверенный').toBe('192.0.2.11');
  });
  it('поддерживает массив заголовков', () => {
    expect(clientIp({ 'x-forwarded-for': ['10.9.9.9', '203.0.113.9'] }, '127.0.0.1')).toBe('203.0.113.9');
  });
  it('без заголовка использует адрес сокета; IPv4 внутри IPv6 — как IPv4 (один ключ на клиента)', () => {
    expect(clientIp({}, '198.51.100.4')).toBe('198.51.100.4');
    expect(clientIp({}, '::ffff:198.51.100.4')).toBe('198.51.100.4');
  });
  it('без всего — не падает', () => {
    expect(clientIp({})).toBe('unknown');
    expect(clientIp({ 'x-forwarded-for': '203.0.113.7' }), 'заголовку без собеседника не верим').toBe('unknown');
  });
});

describe('⭐ R3-07: перебор пароля с подменой адреса', () => {
  it('новый X-Forwarded-For на каждую попытку не даёт нового ключа: лимит входа по адресу срабатывает', () => {
    const rl = new RateLimiter(10, 1 / 3);           // числа `limits.login`
    let passed = 0;
    for (let i = 0; i < 1000; i++) if (rl.take(clientIp({ 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` }, '198.51.100.66'), 1_000)) passed++;
    expect(passed).toBe(10);
  });

  it('одиннадцатая неудачная попытка в один ник с разных адресов — отказ (`limits.loginUser`)', () => {
    const who = `victim-${Math.random()}`;
    const t = 3_000_000;
    for (let i = 0; i < 10; i++) expect(limits.loginUser.take(who, t), `попытка ${i + 1}`).toBe(true);
    expect(limits.loginUser.take(who, t), 'одиннадцатая').toBe(false);
    expect(limits.loginUser.take(who, t + 29_000), 'меньше 30 с — ещё нельзя').toBe(false);
    expect(limits.loginUser.take(who, t + 30_000), 'через 30 с — одна').toBe(true);
    expect(limits.loginUser.retryAfterSec(who)).toBeGreaterThan(0);
  });
});

describe('⚠ R3-15: часы назад не опустошают бакеты', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('время, пришедшее «из прошлого», — ноль прошедших секунд, а не долг: следующий кадр проходит, запас цел', () => {
    const rl = new RateLimiter(120, 80);             // числа потолка кадров WebSocket
    let t = 10_000;
    for (let i = 0; i < 90; i++, t += 33) expect(rl.take('c1', t), `кадр ${i}`).toBe(true);   // 3 с ввода на 30 Гц
    expect(rl.take('c1', t - 2_000), 'кадр после шага часов назад на 2 с').toBe(true);
    let burst = 0;
    while (rl.take('c1', t - 2_000)) burst++;
    expect(burst, 'всплеск после шага назад — почти вся ёмкость').toBeGreaterThanOrEqual(115);
    // Отсчёт не уехал назад: пополнение идёт от самого позднего виденного момента.
    expect(rl.take('c1', t - 1_000), 'токенов не прибавилось за «секунду» до уже виденного').toBe(false);
    expect(rl.take('c1', t + 100), 'а за настоящее время вперёд — прибавилось').toBe(true);
  });

  it('по умолчанию время монотонное: шаг Date.now назад на 5 с не рвёт соединение', () => {
    const rl = new RateLimiter(120, 80);
    let wall = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    for (let i = 0; i < 90; i++) { wall += 33; expect(rl.take('c1')).toBe(true); }
    wall -= 5_000;                                     // chrony makestep, миграция ВМ, ручная правка часов
    expect(rl.take('c1'), 'первый кадр после шага часов').toBe(true);
  });
});

/**
 * ⭐ R5-25: КЛЮЧ ЛИМИТА ПО АДРЕСУ — СЕТЬ. Провайдер выдаёт IPv6-абоненту целую /64: адрес на каждую попытку (и каждый сокет)
 * давал новый пустой бакет лимитов промахов кода, лобби, входа и регистрации.
 */
describe('⭐ R5-25: ipBucket — IPv6 по /64, IPv4 как есть', () => {
  it('адреса одной /64 в любой записи — один ключ; соседняя сеть — другой', () => {
    const k = ipBucket('2001:db8:1:2::1');
    expect(k).toBe('2001:db8:1:2::/64');
    for (const a of ['2001:DB8:1:2:ffff::abcd', '2001:0db8:0001:0002:0000:0000:0000:0009', '[2001:db8:1:2::7]', '2001:db8:1:2::1%eth0']) {
      expect(ipBucket(a), a).toBe(k);
    }
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(k);
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });

  it('IPv4 (и IPv4 внутри IPv6), петля и не-адрес — как есть', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::1')).toBe('::1');
    expect(ipBucket('unknown')).toBe('unknown');
    expect(ipBucket('1:2:3')).toBe('1:2:3');
  });
});
