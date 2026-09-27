import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ЧИСТЫЕ РЕШЕНИЯ ДОСТУПА: «пускать этот источник?» и «этот токен — наш ключ?».
 *
 * Вынесено из `index.ts` ровно затем, чтобы это можно было проверить тестом: импорт `index.ts`
 * поднимает сервер и лезет в базу, а решения о доступе обязаны проверяться без того и другого.
 */

/**
 * Пускать ли браузерный запрос с этого источника.
 *
 * Раньше стоял `cors()` без параметров — API отвечал ЛЮБОМУ источнику. Вместе с гейтом dev-роутов
 * «по адресу сокета» это давало дыру, для которой не нужна сеть: браузер разработчика ходит
 * с 127.0.0.1, значит проверку локальности проходила любая открытая в нём страница.
 *
 * Два намеренных послабления:
 *  • запрос БЕЗ `Origin` (curl, сервер-сервер) не отсекаем — CORS защищает браузер от чужой
 *    страницы, а не сервер от клиента; сервер защищает авторизация;
 *  • собственный хост разрешён всегда — при `DM_SERVE_STATIC` игра раздаётся с этого же адреса,
 *    и без этого прод сломался бы на любом POST.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

/**
 * Разбор `DM_ORIGINS`: список через запятую, пустые куски выкидываем.
 *
 * ПУСТАЯ строка трактуется как НЕЗАДАННАЯ (`DM_ORIGINS=` в файле окружения — почти всегда описка),
 * иначе список молча становится пустым и редакторы перестают работать без единого объяснения.
 * «Не пускать никого чужого» выражается явно: указать собственный источник сервера.
 */
export const parseOrigins = (raw: string | undefined, fallback: string): string[] =>
  ((raw ?? '').trim() || fallback).split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Совпадает ли предъявленный токен с ключом процессов (`DM_ADMIN_KEY`).
 *
 * Сравнение за ПОСТОЯННОЕ время: обычное `===` выходит из цикла на первом же несовпавшем байте,
 * и по времени ответа ключ подбирается посимвольно.
 *
 * ⚠ Пустой ключ НИКОГО не пускает. Это главный смысл первой строки: если переменная не задана,
 * наивное сравнение пустой строки с пустым токеном выдало бы «совпало» и открыло всё без пароля.
 */
export function keyMatches(token: string, key: string, eq: (a: Buffer, b: Buffer) => boolean): boolean {
  if (!key || !token) return false;
  const a = Buffer.from(token), b = Buffer.from(key);
  return a.length === b.length && eq(a, b);
}

/**
 * Адрес петли — этот же компьютер. Во всех записях, в которых он приходит: IPv4 127/8, IPv6 `::1` (и полной записью,
 * как его отдаёт uWS), IPv4 внутри IPv6 (`::ffff:127.0.0.1`, в том числе шестнадцатеричной полной записью).
 */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (a === 'localhost' || a === '::1') return true;
  const v4 = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) return v4[1] === '127';
  return /^(?:0{1,4}:){7}0{0,3}1$/.test(a) || /^(?:0{1,4}:){5}ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(a);
}

/** Заголовки, которые ставит прокси. Запрос с любым из них пришёл через прокси, а не от самой машины. */
export const PROXY_HEADERS: readonly string[] = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'via'];

/**
 * ⭐ R3-03: ПРЯМОЙ ВЫЗОВ С САМОЙ МАШИНЫ — только ему открыты служебные ручки (`/metrics`, `/internal/drain`).
 *
 * Раньше хватало адреса сокета «петля». Но всё, что идёт через прокси, приходит С ПЕТЛИ: свой uWS переправляет в
 * express каждый запрос с 127.0.0.1, Caddy или nginx перед сервером — тоже. Проверку проходил любой из интернета:
 * `curl -X POST http://сервер:порт/internal/drain` гасил ноду (а заодно давал рестарт по заказу), `/metrics` уходил наружу.
 *
 * Теперь: сокет — петля И в запросе нет заголовков прокси. Свой прокси uWS не добавляет их только настоящему
 * локальному вызову (собеседник с петли и без чужих заголовков) — всем остальным ставит `X-Forwarded-For` сам
 * (`proxyToExpress`). Обратный прокси перед сервером обязан ставить `X-Forwarded-For` (Caddy делает это по
 * умолчанию, nginx — `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`): по нему же считаются лимиты
 * входа (`clientIp`). Подделка заголовков здесь ничего не даёт: лишний заголовок только ЗАКРЫВАЕТ доступ.
 *
 * ⭐ R12-01: ЗАПРОС ПО СОЕДИНЕНИЮ, КОТОРОЕ ОТКРЫЛ СВОЙ ПРОКСИ uWS (`socketPort` — порт собеседника, он в `proxyLinks`), —
 * локальный, только если прокси сам поставил на нём доказательство (`LOCAL_PROOF_HEADER`, секрет процесса): «петля и без
 * заголовков прокси» для таких соединений ничего не доказывает. Раньше прокси пересылал заголовки длины клиента и делил
 * соединения с express между чужими клиентами — GET с `Content-Length` съедал голову следующего запроса как своё тело, а его
 * тело (`POST /internal/drain` без заголовков) express разбирал как отдельный запрос «с самой машины». Пересылку починил сам прокси
 * (`forwardRequest`: длина — своя, соединение — на один запрос); это вторая линия. Прямой вызов на петлю express (не через
 * прокси: стенд, мониторинг) — по-прежнему по правилу выше.
 *
 * ⭐ R14-11: И НЕ БРАУЗЕРНАЯ СТРАНИЦА (`browserPage`). Любая страница, открытая в браузере на этой машине, ходит на `localhost` с петли и
 * без заголовков прокси: `fetch(…/internal/drain, {method:'POST', mode:'no-cors'})` — простой запрос без предзапроса, CORS прячет лишь
 * ответ, а слив уже пошёл; с подменой DNS (чужое имя → 127.0.0.1) страница ещё и читала `/metrics` и `/api/cluster`.
 */
export function localCaller(
  headers: Record<string, string | string[] | undefined>, socketAddr: string | undefined, socketPort?: number,
): boolean {
  if (!isLoopback(socketAddr) || PROXY_HEADERS.some((h) => headers[h] !== undefined)) return false;
  if (browserPage(headers)) return false;
  if (socketPort === undefined || !proxyPorts.get(socketPort)) return true;
  const proof = headers[LOCAL_PROOF_HEADER];
  return typeof proof === 'string' && keyMatches(proof, localProof, timingSafeEqual);
}

/**
 * ⭐ R14-11: ЗАПРОС ШЛЁТ СТРАНИЦА В БРАУЗЕРЕ, а не человек или программа с этой машины:
 *  • есть `Origin` — его ставит браузер на всё, кроме простого GET и навигации (POST формы и `fetch` любого режима — с ним), и только он;
 *  • `Sec-Fetch-Site` не `none` — браузер говорит, что запрос начала страница (`none` — адресная строка, закладка: сам человек);
 *  • `Host` назван и это не петля (`localhost`, 127/8, `[::1]`, с портом или без) — подмена DNS: страница evil.example, чьё имя вдруг
 *    указывает на 127.0.0.1, ходит сюда со своим именем в `Host` (без заголовка `Host` браузер не ходит вовсе).
 * curl, Prometheus, `dmload` и `fetch` из Node (он шлёт `sec-fetch-mode`, но не `Sec-Fetch-Site` и не `Origin`) под это не попадают.
 */
function browserPage(headers: Record<string, string | string[] | undefined>): boolean {
  if (headers.origin !== undefined) return true;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none') return true;
  const host = headers.host;
  if (host === undefined) return false;
  if (typeof host !== 'string') return true;
  const h = host.trim();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(h) ?? /^([^:[\]]+)(?::\d+)?$/.exec(h);
  return !isLoopback(m ? m[1] : h);
}

/** ⭐ R12-01: заголовок, которым свой прокси uWS доказывает express, что запрос — прямой вызов с самой машины. */
export const LOCAL_PROOF_HEADER = 'x-dm-local';
/**
 * Порты петли, с которых свой прокси сейчас ходит в express (открытые им соединения), — счётом: закрытие старого соединения,
 * дошедшее уже после того, как тот же порт взяло новое, не снимает новое.
 */
const proxyPorts = new Map<number, number>();
let localProof = '';
/**
 * ⭐ R12-01: соединения своего прокси uWS к express и секрет процесса (см. `localCaller`). Секрет — случайный на процесс, наружу
 * не уходит: прокси снимает одноимённый заголовок клиента и ставит свой только собеседнику с петли без заголовков прокси.
 */
export const proxyLinks = {
  proof(): string {
    if (!localProof) localProof = randomBytes(32).toString('hex');
    return localProof;
  },
  open(port: number): void { proxyPorts.set(port, (proxyPorts.get(port) ?? 0) + 1); },
  close(port: number): void {
    const n = (proxyPorts.get(port) ?? 0) - 1;
    if (n > 0) proxyPorts.set(port, n); else proxyPorts.delete(port);
  },
};
