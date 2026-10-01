import express, { type Request, type Response, type RequestHandler } from 'express';
import { configReplyOf } from './configEtag.js';
import cors from 'cors';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdirSync, watch } from 'node:fs';
import { CONFIG_REV_HEADER, ConfigRegistry, configSchemas, type ConfigKey } from '@dm/shared';
import { configWatcher } from './configWatch.js';
import { startConfigSync } from './configSync.js';
import { liveConfig } from './configLive.js';
import { arrayElementSchema, formatConfigFile } from './configFileFormat.js';
import {
  listAllCharacters, getCharacter,
  getUserById,
  getConfigOverrides, setConfigOverride, deleteConfigOverride, getConfigOverridesRev,
  getPoseStore, getPoseRevs, setPoseStore, deletePoseStore, clearAllRuns, seedPoseStoreIfEmpty, sweepSessions, sweepRunLedger,
  getUserRole, serverKey,
} from './db/db.js';
import { initSchema, closePool } from './db/pool.js';
import { attachWsServer } from './net/wsServer.js';
import { startUwsServer, bodyCapFor } from './net/uwsServer.js';   // потолок тела пути — один и тот же у прокси и у дочитывания отказа
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { renderMetrics } from './net/metrics.js';
import { originAllowed, parseOrigins, keyMatches } from './net/adminAccess.js';
import { installInternalRoutes, internalReader, drainProcess, installCrashDrain, installNodeFence } from './net/internalRoutes.js';
import { installStatic } from './net/staticRoutes.js';
import { listenWithRetry } from './net/listen.js';
import { installAccountRoutes, bearer, isCharId } from './net/accountRoutes.js';
import { sessionUser, primeKnown, setRoutePassKey } from './net/authSession.js';
import { setDeviceKey } from './net/deviceToken.js';
import { limits } from './net/rateLimit.js';
import { installContentReads, assetStats } from './net/contentRoutes.js';
import { installConfigWrites } from './net/configRoutes.js';
import { installCraftMeshRoute } from './net/craftMeshRoutes.js';
import { ah, httpErrors, queryText, warnHttp, holdRefusal } from './net/asyncRoute.js';
import { stripGlbTextures } from './glbStrip.js';
import { extractColliderFromGlb } from './glbMeshBbox.js';

/**
 * Бэкенд игры. Аккаунты по HTTP (`/api/register|login|logout`, `/api/characters` CRUD),
 * сама игра (город/данж/экономика/сейвы) — авторитетно в кооп-комнатах на WebSocket
 * (`net/wsServer` → `Room`). Персонажи принадлежат пользователю (`characters.userId`);
 * WS-join проверяет сессию+владение. Хранилище — Postgres (db/pool.ts, db/db.ts).
 */
// Конфиг игры — ЕДИНАЯ СЕРВЕРНАЯ ИСТИНА: встроенные дефолты (data/*.json в бандле shared)
// + персистентные оверрайды редактора (таблица `config_overrides`). Клиент и редактор берут
// эффективный конфиг через GET /api/config, правки редактора идут в POST /api/dev/config.
const config = new ConfigRegistry();

/**
 * ⭐ R15-05: живой конфиг — файлы данных, КАКИЕ ОНИ СЕЙЧАС (импорт старта + правки файлов, увиденные наблюдателем или записанные ручкой
 * «в файл»), и оверрайды редактора поверх (`configLive.ts`). Раньше основой пересборки был импорт старта, и сверка (R16 C-02) откатывала
 * правку файла, как только сдвигалась ревизия оверрайдов.
 */
const live = liveConfig({
  config, readOverrides: getConfigOverrides, deleteOverride: deleteConfigOverride,
  changed: () => rebuildConfigCache(),   // Ф0.7: тело для /api/config готовим здесь же, а не на каждом запросе
});
/**
 * Полная пересборка живого конфига: файлы данных + персистентные оверрайды (комнаты держат ссылку).
 * ⭐ R16 C-02: оверрайды — СПЕРВА из базы, сама сборка — без ожиданий. Раньше дефолты ставились до чтения базы: на время запроса (под нагрузкой —
 * секунды) комнаты, тикавшие между, играли на встроенных таблицах без правок редактора. Теперь пересборка идёт и по сверке (`configSync.ts`).
 */
async function rebuildConfig(): Promise<void> {
  await live.rebuild();
}
/** ⭐ R16 C-02: ревизия оверрайдов, снятая на старте ДО сборки конфига: правку, легшую после, соберёт первая сверка (`startConfigSync`). */
let bootConfigRev: string | undefined;

/**
 * Подготовка хранилища перед приёмом запросов (Ф2). Раньше всё это делалось прямо в модуле —
 * доступ был синхронным. Теперь порядок явный, и слушать порт мы начинаем ТОЛЬКО после того,
 * как схема есть, а конфиг собран: иначе первый же запрос увидел бы полупустой реестр.
 */
async function boot(): Promise<void> {
  await initSchema();
  bootConfigRev = await getConfigOverridesRev();   // ⭐ R16 C-02: до сборки — правка между ними не потеряется
  await rebuildConfig();   // дефолты + сохранённые правки редактора + готовое тело ответа

  // Рестарт сервера = чистый лист забегов: сбрасываем НЕЗАВЕРШЁННЫЕ забеги (save.run). Иначе спуск из города
  // РЕЗЮМИТ старый забег (старый биом/сид) и игнорит алтарь.
  watchConfigFiles();   // правки data/*.json должны быть видны в редакторе и в игре без рестарта

  // ⭐ R2-11: только игровой процесс и только ничьи забеги. Гейтвей комнат не держит — ему сбрасывать нечего, а
  // нода не трогает героев, живых на ДРУГИХ нодах: поочерёдный перезапуск стирал им забег посреди игры и сбивал
  // версию сейва — все их сессии снимались следующим же автосейвом.
  if (ROLE !== 'gateway') {
    const { initClusterSchema } = await import('./cluster/registry.js');
    await initClusterSchema();
    const wiped = await clearAllRuns(process.env.DM_NODE_ID ?? 'node-0');
    if (wiped) console.log(`[dm-server] сброшено незавершённых забегов: ${wiped}`);
    // R9-01: свод записей забегов (`run_ledger`) — только свежий: забеги рестарт не переживают, строки — неделю.
    const stale = await sweepRunLedger();
    if (stale) console.log(`[dm-server] убрано старых записей узлов забегов: ${stale}`);
    // ⭐ V2: забег — за одной нодой кластера (`run_locks`): забеги прошлого процесса этой ноды ушли вместе с его комнатами, а продолжение
    // забега (спуск из города, «Продолжить») сверяется с базой — идёт ли он уже в комнате другой ноды. До приёма соединений.
    const { releaseNodeRuns, claimRun, releaseRun } = await import('./cluster/registry.js');
    const { setRunLockStore } = await import('./net/roomManager.js');
    const nodeId = process.env.DM_NODE_ID ?? 'node-0';
    const tails = await releaseNodeRuns(nodeId);
    if (tails) console.log(`[dm-server] снято забегов прошлого процесса ноды: ${tails}`);
    setRunLockStore({ claim: (key, room) => claimRun(key, nodeId, room), release: (key, room) => releaseRun(key, nodeId, room) });
    // ⭐ R18-03: запись строки героя (сессия, дописка, копия ждущего, штраф и снятие забега по строке базы) — только пока героя держит эта нода
    // (закрепление за ней; с арендой — и реестр видел её удар): после простоя машины она иначе хоронила героя, который уже играл тот же забег на
    // соседней, и дописывала копии поверх строк, прочитанных там.
    const { setRowOwner } = await import('./net/room.js');
    setRowOwner({ node: nodeId, leased: ROLE === 'node' });
  }

  // Посев авторского 3D-контента поз-редактора при пустой БД (свежий/сброшенный сервер) — чтобы
  // анимации были из коробки. Источник — pose-seed.json в git.
  const seeded = await seedPoseStoreIfEmpty();
  if (seeded) console.log(`[dm-server] pose_store засеян из pose-seed.json: ${seeded} ключей`);

  const gone = await sweepSessions();
  if (gone) console.log(`[dm-server] убрано протухших сессий: ${gone}`);

  // ⭐ R11-05: вход, регистрация, ростер и маршрут — у гейтвея (и одиночного процесса): живые сессии и ники базы знакомы ему с
  // запуска (после деплоя честный токен и ник не платят общий бакет адреса), токены устройства — подписаны ключом базы.
  // ⭐ R13-08: пропуск маршрута (`/api/route` → адрес ноды) подписывает гейтвей, проверяет нода — ключ общий, из базы.
  if (ROLE === 'gateway' || ROLE === 'single' || ROLE === 'node') setRoutePassKey(await serverKey('route'));
  if (ROLE === 'gateway' || ROLE === 'single') {
    setDeviceKey(await serverKey('device'));
    const primed = await primeKnown();
    console.log(`[dm-server] знакомо с запуска: сессий ${primed.sessions}, ников ${primed.names}`);
  } else if (ROLE === 'node') {
    // ⭐ R12-05: лобби ноды — незнакомый токен платит бакет адреса до базы; честные сессии знакомы ей с запуска (`primeKnown`).
    const primed = await primeKnown({ names: false });
    console.log(`[dm-server] знакомо с запуска: сессий ${primed.sessions}`);
  }

  // Ф3.4: в бою трафик обязан идти по TLS. Сам процесс слушает голый HTTP всегда — шифрование
  // терминирует nginx перед ним, и определить это изнутри нельзя. Поэтому требуем ЯВНОГО
  // подтверждения: без него в проде остаётся громкое предупреждение, а не тихая уверенность,
  // что «наверное, там прокси».
  if (process.env.NODE_ENV === 'production' && process.env.DM_BEHIND_TLS !== '1') {
    console.warn('[dm-server] ВНИМАНИЕ: не подтверждён TLS перед сервером. Токены и игровой трафик'
      + ' могут идти открытым текстом. Поставьте DM_BEHIND_TLS=1, если снаружи стоит https-прокси.');
  }
}

// Потолки аккаунтов и героев (MAX_CHARS, регистрации с адреса) и обёртка асинхронных ручек `ah` — в
// `net/accountRoutes.ts` и `net/asyncRoute.ts`.

const app = express();
/**
 * CORS ПО СПИСКУ, а не «всем подряд».
 *
 * Раньше здесь стоял `cors()` без параметров — API отвечал ЛЮБОМУ источнику. В паре с гейтом
 * dev-роутов «по адресу сокета» это давало дыру, для которой не нужна даже сеть: браузер
 * разработчика ходит с `127.0.0.1`, значит проверку локальности проходила ЛЮБАЯ открытая в нём
 * страница — и могла переписать баланс (`/api/dev/config`), файлы-истины `data/*.json` и залить
 * 64-мегабайтный ассет. Список источников закрывает это ещё до авторизации.
 *
 * Запросы БЕЗ `Origin` (curl, сервер-сервер) не отсекаем намеренно: CORS защищает браузер от чужой
 * страницы, а не сервер от клиента — сервер защищает авторизация. По той же причине разрешён
 * собственный хост: при `DM_SERVE_STATIC` игра раздаётся с этого же адреса.
 */
const ORIGINS = parseOrigins(process.env.DM_ORIGINS, 'http://localhost:5173,http://localhost:5174');
app.use(cors((req, cb) => {
  const h = req.headers as { origin?: string; host?: string };
  cb(null, { origin: originAllowed(h.origin, h.host, ORIGINS) });
}));
// ⭐ R6-04: ОБЩЕГО РАЗБОРА ТЕЛА НЕТ. Здесь стоял `express.json` на 2 МБ для ЛЮБОГО запроса — до ручек и их лимитов: анонимный
// POST с 2 МБ вложенного JSON (на любой путь) стоил ~115 мс главного потока, и десяток таких в секунду держал тики всех
// комнат. Тело разбирают только ручки, которым оно нужно: аккаунты — маленьким разбором (`accountRoutes.ts`, 8 КБ),
// инструменты `/api/dev/*` — большим, но после проверки доступа (`devGate` → `devJson`, как R4-11 для ассетов).

/**
 * Роль процесса (Ф4). Один и тот же файл — три разных занятия:
 *   supervisor — поднимает гейтвей и ноды и следит за ними (по умолчанию в бою);
 *   gateway    — HTTP, аккаунты, конфиг, статика, маршрутизация и очередь; игры в нём нет;
 *   node       — только WebSocket и комнаты (R10-09: по HTTP — только служебное, `installNodeFence`);
 *   single     — всё в одном процессе, как было до Ф4 (стенд, разработка, малый онлайн).
 */
const ROLE = process.env.DM_ROLE ?? 'single';

/**
 * Ф1.7 `/metrics` и Ф4.5 `/internal/drain` — только прямому вызову с самой машины (R3-03, `net/internalRoutes.ts`).
 * Здесь, до раздачи статики: её SPA-фолбэк на любой GET иначе отдал бы на `/metrics` страницу игры.
 */
installInternalRoutes(app, {
  nodeId: process.env.DM_NODE_ID ?? 'node-0',
  // Ф4: на гейтвее метрики — это СУММА по кластеру. Иначе мониторинг показывал бы работу
  // процесса, который игру не ведёт, а стенд мерил бы одну ноду из десяти.
  metrics: async () => {
    if (process.env.DM_ROLE !== 'gateway') return renderMetrics();
    const { clusterMetrics } = await import('./cluster/gateway.js');
    return clusterMetrics();
  },
  drain: drainProcess,   // R4-27: обработчики SIGTERM, а не сигнал — на Windows `process.kill(self)` убивает без них
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'dm-server', version: '0.1.0' });
});

// ⭐ R10-09: нода кластера по HTTP отдаёт только то, что выше (метрики, слив, здоровье); API и статика — у гейтвея.
installNodeFence(app, ROLE);

// ── Конфиг игры (единая истина: сервер) ─────────────────────────────────────────
// GET отдаёт АКТУАЛЬНЫЙ эффективный конфиг (дефолты + сохранённые правки) — его грузят
// и клиент (вью/тултипы), и редактор (показывает реальные значения). Одна истина везде.
// Ф0.7: тело конфига сериализуется ОДИН раз — при старте и при каждой правке из редактора.
// Раньше на каждый запрос шёл `structuredClone` всего реестра плюс `JSON.stringify`: 8,58 мс
// блокировки цикла и 436 КБ тела. Один вход игрока съедал четверть тикового бюджета, сотня
// входов в секунду — 86 % ядра на один этот роут.
let configBody = '';
let configEtag = '';
/** ⭐ R16 C-07: ревизия сервера для этого тела — вкладка кладёт её в согласие команд кузницы и лавки (`cfgRev`), а не свою по разобранному. */
let configRevision = '';
function rebuildConfigCache(): void {
  // ETag — по ВСЕМУ телу (см. `configEtag.ts`, там разобрано, чем стоила выборка); тело, ETag и ревизия — с одного снимка реестра.
  ({ body: configBody, etag: configEtag, rev: configRevision } = configReplyOf(config));
}


app.get('/api/config', (req, res) => {
  if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-store');   // DEV: конфиг всегда свежий (модели/текстуры/объекты)
  res.setHeader('ETag', configEtag);
  res.setHeader(CONFIG_REV_HEADER, configRevision);
  if (req.headers['if-none-match'] === configEtag) return res.status(304).end();
  res.type('application/json').send(configBody);
});

// Правки редактора: валидируем → ПЕРСИСТИМ в базу → пересобираем живой конфиг. Переживает
// рестарт сервера. balance действует сразу, статы монстров/лут — со следующего этажа.
// АНТИ-ЧИТ: запись только вне продакшена — иначе клиент мог бы переписать баланс сервера.
const DEV_CONFIG_APPLY = process.env.NODE_ENV !== 'production';

/**
 * Ф0.12 закрыл dev-роуты (правка баланса, заливка ассетов, чтение чужих сейвов) ДВУМЯ независимыми
 * условиями: не продакшен И запрос с локальной машины. Второе условие оказалось не пропуском, а лишь
 * его видимостью — см. комментарий у CORS: браузер разработчика тоже локальный, поэтому под гейт
 * подпадала любая открытая в нём страница. Плюс этот же код предупреждал, что «за обратным прокси все
 * запросы выглядят локальными», а на вторую машину такой гейт не расширяется в принципе.
 *
 * Теперь второе условие — РОЛЬ. Человек входит логином/паролем и получает сессию (роль `admin`
 * выдаётся `grant-admin`), процессы (скрипты, шим генерации анимаций) предъявляют `DM_ADMIN_KEY`.
 * Первое условие — прежнее `DEV_CONFIG_APPLY`, его не трогаем: два независимых условия были
 * осознанным решением.
 *
 * Отзыв доступа: `logout-all` гасит все сессии человека, смена `DM_ADMIN_KEY` — ключ процессов.
 */
const ADMIN_KEY = process.env.DM_ADMIN_KEY ?? '';
async function devGuard(req: Request, res: Response): Promise<boolean> {
  if (!DEV_CONFIG_APPLY) { res.status(403).json({ error: 'Отключено в продакшене' }); return false; }
  const token = bearer(req);
  if (!token) { res.status(401).json({ error: 'Требуется вход' }); return false; }
  if (keyMatches(token, ADMIN_KEY, timingSafeEqual)) return true;
  // Не ключ процессов и не токен сессии по виду — в базу незачем (R4-02). ⭐ R9-12: сессии нет — неудача платит бакет сети
  // адреса до базы (`sessionUser`). ⭐ R11-06: и потолок аккаунта — свой, широкий (публикация поз-редактора — пачка запросов).
  const userId = await sessionUser(req, res, token, limits.accountDev);
  if (!userId) return false;
  if (await getUserRole(userId) !== 'admin') {
    console.warn(`[dm-server] отказ dev-роута ${req.path}: у ${userId} нет прав администратора`);
    res.status(403).json({ error: 'Нужны права администратора' });
    return false;
  }
  return true;
}
/**
 * ⭐ R4-11: доступ — ДО ТЕЛА. `express.raw` на 64 МБ стоял перед `devGuard`: анонимный запрос заставлял ноду собрать 64 МБ
 * (и в продакшене, где ручка всё равно отвечает 403). Теперь тело читает только тот, кому ручка открыта.
 * ⭐ R6-04: так же и JSON-ручки инструментов (`devJson`): общего разбора тела больше нет.
 */
const devGate: RequestHandler = (req, res, next) => {
  // ⭐⭐ ОТКАЗ УХОДИТ ТОЛЬКО ПОСЛЕ ДОЧИТЫВАНИЯ ТЕЛА (`holdRefusal`). Решение принимается как и раньше — ДО тела
  // (R4-11), и тело по-прежнему не собирается: байты выбрасываются по мере прихода. Откладывается лишь ОТПРАВКА,
  // иначе на запросе без keep-alive (а прокси шлёт именно такой) нода уничтожает сокет сразу после ответа, клиент
  // получает сброс, и сброс уносит сам ответ: на посылке поз-редактора 5.6 МБ настоящий 401 не доезжал ни до
  // прокси, ни до редактора — вместо предложения войти владелец видел «прокси не достучался до express».
  const hold = holdRefusal(req, res);
  void devGuard(req, res).then((ok) => {
    if (ok) { hold.pass(); next(); return; }   // доступ есть — тело нетронутым уходит разборщику ручки
    hold.sendAfterBody(bodyCapFor(req.path));
  }).catch((e: unknown) => {
    warnHttp(e, 'отказ в обработчике');   // R11-11: через глушитель, как `ah`
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' });
    hold.sendAfterBody(bodyCapFor(req.path));
  });
};
/** Тело JSON инструментов (конфиг, контент поз-редактора — сотни КБ) — ставится ПОСЛЕ `devGate`. */
/**
 * ⚠⚠ ЛИМИТ 2 МБ ЛОМАЛ ПУБЛИКАЦИЮ ПОЗ-РЕДАКТОРА, И ЧИНИЛСЯ ОН НЕ ТАМ, ГДЕ БОЛЕЛО.
 *
 * Публикация шлёт ВСЕ грязные ключи ОДНИМ телом, а `pe_clips` с перенесённым мокап-набором это уже
 * ~1.5 МБ сам по себе. ЗАМЕР (живой браузер, POST на эту же ручку): 0.5 МБ → 200, 1.9 МБ → доехало,
 * 2.5 МБ → `TypeError: Failed to fetch`, 4 МБ → то же. То есть при превышении браузер получает НЕ 413,
 * а обрыв, и клиент честно пишет «сервер недоступен — правки остались локально». Отсюда и «часть
 * отправляет, часть нет»: мелкие ключи проходят, большой рвёт всю посылку.
 *
 * 24 МБ — с запасом на библиотеку клипов целиком (68 клипов мокап-набора + авторские). Ручка под
 * `devGate`: тело читает только тот, кому она открыта, поэтому анонимной нагрузки это не добавляет
 * (ровно тот довод, по которому общий `express.json` отсюда убрали).
 */
const devJson = express.json({ limit: '24mb' });
// «Применить на сервере», «Применить везде» (файл `data/*.json` + оверрайд) и «Сбросить к дефолту» — `net/configRoutes.ts`. ⭐ R21-02:
// проба записи — над тем, что соберёт пересборка (файлы + все оверрайды базы, `live.trial`), а не над файлами старта.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'src', 'config', 'data');
const configFileFor = (key: string): string => join(DATA_DIR, key.replace(/\./g, '-') + '.json');
installConfigWrites(app, {
  config, live, gate: devGate, json: devJson, guard: devGuard,
  setOverride: setConfigOverride, deleteOverride: deleteConfigOverride,
  // Файл «строка на запись» (weapon-parts) пишем в его же формате и без умолчаний zod — иначе одна правка
  // детали давала diff на весь файл (`configFileFormat.ts`).
  writeFile: (key, value) => {
    const path = configFileFor(key);
    writeFileSync(path, formatConfigFile(value, existsSync(path) ? readFileSync(path, 'utf8') : null, arrayElementSchema(key)));
  },
  // ⭐ R22-02: файл на диске — тот ли, что принят сервером: иначе запись «в файл» затёрла бы его живой таблицей (409).
  readFile: (key) => {
    const path = configFileFor(key);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as unknown : undefined;
  },
});

/**
 * ЖИВОЕ ПЕРЕЧИТЫВАНИЕ `data/*.json` С ДИСКА.
 *
 * ЗАЧЕМ. Редактор конфигов и оба клиента (веб-3D и Unity) берут конфиг с сервера, а сервер держит
 * его В ПАМЯТИ: дефолты приходят ESM-импортом `defaults.ts` в момент старта. Значит правка файла —
 * генератором, руками, `git pull` — не доезжала НИКУДА до перезапуска процесса, и человек честно
 * видел старое дерево, старый баланс, старые числа. `tsx watch` эти файлы игнорирует намеренно
 * (иначе каждая правка из редактора роняла бы процесс), так что сам себя он тоже не спасал.
 *
 * Поэтому следим за папкой данных здесь: файл поменялся → перечитали с диска → провалидировали →
 * положили в живой реестр. Комнаты держат ССЫЛКУ на реестр, поэтому подхватывают без реконнекта.
 *
 * ФАЙЛ ГЛАВНЕЕ ОВЕРРАЙДА, и устаревший оверрайд снимается. Иначе выходит ровно та ловушка, на
 * которой мы и попались: один раз нажатое в редакторе «Применить на сервере» кладёт снимок в
 * `config_overrides`, и дальше он НАВСЕГДА перекрывает файл — сколько ни правь данные, и редактор,
 * и оба клиента показывают старое. Правка файла — осознанное авторское действие (генератор, руки,
 * `git pull`), она и должна побеждать; «Применить и записать в файл» пишет оба места разом, так что
 * согласованность не страдает.
 *
 * ⭐ R22-02: и решает наблюдатель то же, что старт процесса (`configWatch.ts`, `live.applyFiles`): файлы одного окна дребезга — одной пачкой,
 * годный схемой файл — в основу (правило поверх таблиц — над итоговым кандидатом, как на старте), негодный — перечитывается при каждом
 * следующем применении, упавшее на базе применение — повтором.
 * ⭐ R23-06: и файл, записанный ДО взведения (импорт `data/*.json` — при загрузке модуля, а сюда `boot()` доходит через секунды: схема базы,
 * ревизия, сборка конфига), не теряется: взведённый наблюдатель сверяет диск с основой (`watcher.sweep`) — разошедшийся файл применяется, как
 * увиденная правка. Раньше его не брал никто до рестарта, а «Применить везде» его таблицы отвечало 409 навсегда.
 */
function watchConfigFiles(): void {
  if (process.env.NODE_ENV === 'production' || process.env.DM_WATCH_CONFIG === '0') return;
  const watcher = configWatcher({
    live, keys: Object.keys(configSchemas),
    // Файл могли поймать на середине записи — бросок разбора, наблюдатель перечитает его следующим применением.
    read: (file) => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as unknown,
  });
  try {
    watch(DATA_DIR, (_ev, file) => { if (file) watcher.touched(file); });
    watcher.sweep();   // ⭐ R23-06: ПОСЛЕ взведения — запись, идущая сейчас, придёт ещё и событием
    console.log(`[dm-server] слежу за ${DATA_DIR} — правки data/*.json подхватываются на лету`);
  } catch (e) {
    watcher.stop();
    console.warn(`[dm-server] не удалось следить за конфигами: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Контент 3D поз-редактора (единая истина: сервер) ─────────────────────────────
// GET — весь авторский контент (pe_gait/clips/sway/phys/ragdoll/chars); грузят и редактор, и игра
// (кэшируют в localStorage). POST — правки редактора, DEV-only (в проде клиент не переписывает контент).
// ⭐ R6-20, R9-12: `GET /api/pose`, `/api/pose/rev` и `/api/assets/stats` — из кэша, с ETag (`net/contentRoutes.ts`). Раньше
// каждый анонимный GET читал базу (`pose_store`) или обходил всё дерево ассетов на главном потоке. Сброс — при записи этим
// процессом (`/api/dev/pose`, заливка ассета), срок — для записей соседних процессов.
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });
const content = installContentReads(app, {
  poseStore: () => getPoseStore(),
  poseRevs: () => getPoseRevs(),
  assetStats: () => assetStats(ASSETS_DIR),
});
/**
 * Публикация рабочей копии редактора. `__baseRev` — ревизии, НА КОТОРЫХ основана присланная копия.
 * Если на сервере ключ новее, вся публикация отклоняется (409) и НИЧЕГО не пишется.
 *
 * ⚠ Зачем замок: тело шлётся ключом ЦЕЛИКОМ (`pe_clips` = вся библиотека), поэтому вкладка, открытая со
 * старым снимком, одним сохранением затирала всё, что появилось позже, — так пропал клип `hit_axe`.
 * Без `__baseRev` (старые клиенты, ручной curl) поведение прежнее: пишем как есть.
 */
app.post('/api/dev/pose', devGate, devJson, ah(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const baseRev = body.__baseRev as Record<string, number> | undefined;
  const keys = Object.keys(body).filter((k) => k !== '__baseRev');
  if (baseRev) {
    const cur = await getPoseRevs();
    const conflicts = keys.filter((k) => (cur[k] ?? 0) > (baseRev[k] ?? 0));
    if (conflicts.length) {
      console.log(`[dm-server] публикация отклонена (на сервере новее): ${conflicts.join(', ')}`);
      return res.status(409).json({ error: 'На сервере более новая версия', conflicts, rev: cur });
    }
  }
  const rev: Record<string, number> = {};
  try {
    for (const k of keys) rev[k] = await setPoseStore(k, body[k]);
  } finally { content.invalidatePose(); }   // R6-20: и упавшая на середине запись могла лечь частью
  res.json({ ok: true, saved: keys, rev });
}));
app.delete('/api/dev/pose/:key', ah<{ key: string }>(async (req, res) => {
  if (!await devGuard(req, res)) return;
  try { await deletePoseStore(req.params.key); } finally { content.invalidatePose(); }
  res.json({ ok: true, deleted: req.params.key });
}));

// ── Dev: ассеты 3D-моделей (GLB) — импорт из поз-редактора (FBX→настройка→экспорт GLB), раздача в игру ──
// GLB — бинарь, в pose_store НЕ кладём (там мелкие JSON); файлы на диске, мелкий конфиг (карта костей/тип/хват)
// — в pose_store (pe_models). Раздача статикой /assets/<id>.glb — вместе с бандлом клиента (`installStatic` ниже, R10-03);
// в проде запись отключена (DEV_CONFIG_APPLY).
// Статистика файлов ассетов (`GET /api/assets/stats`, «Роадмап» редактора) — из кэша, см. `installContentReads` выше.

// Content-Type → расширение файла. GLB (модели) и PNG/JPG (текстуры). Прочее → .bin.
const ASSET_EXT: Record<string, string> = { 'model/gltf-binary': 'glb', 'application/octet-stream': 'glb', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
// R4-11: доступ — ДО ТЕЛА (`devGate`, см. выше у `devGuard`).
// Обработчик стал асинхронным вместе с `devGuard` (проверка роли ходит в базу) — отсюда `ah`.
app.post('/api/dev/assets/:id', devGate, express.raw({ type: Object.keys(ASSET_EXT), limit: '64mb' }), ah<{ id: string }>(async (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');   // sanitize → без path-traversal
  if (!id) return res.status(400).json({ error: 'bad id' });
  let buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'empty body' });
  const ext = ASSET_EXT[(req.headers['content-type'] ?? '').split(';')[0]!.trim()] ?? 'bin';
  // ?strip=1 (GLB) — вырезать вшитые текстуры, оставив геометрию+развёртку. Пайплайн: экспорт «с текстурами» держит UV,
  // но весит мегабайты; тут срезаем картинки (материал в игре всё равно из конфига). Только окружение/объекты (см. glbStrip).
  let stripNote = '';
  // R7-05: значение запроса — только строкой (`queryText`): `?strip[toString]=1` — объект, и `String()` на нём бросал.
  if (ext === 'glb' && /^(1|true|yes)$/i.test(queryText(req.query.strip) ?? '')) {
    const before = buf.length;
    const r = stripGlbTextures(buf);
    buf = r.out; stripNote = r.note;
    if (r.changed) console.log(`[assets] strip ${id}: ${before}→${buf.length} — ${r.note}`);
  }
  // ?dir=<подпапка> — раскладка ассетов по папкам (напр. "crypt_tile_set" или "crypt_tile_set/textures"). Санитайз:
  // сегменты из латинских букв/цифр/_/-, без ".." и абсолютных путей → защита от path-traversal (только ASCII-имена).
  const dir = queryText(req.query.dir);
  if (dir === undefined) return res.status(400).json({ error: 'bad dir' });   // R7-05: не строка — отказ, а не бросок
  const dirSegs = dir.split(/[\\/]+/).map((s) => s.trim().replace(/[^a-zA-Z0-9_-]/g, '')).filter(Boolean);
  const relPath = [...dirSegs, id + '.' + ext].join('/');
  const absPath = join(ASSETS_DIR, ...dirSegs, id + '.' + ext);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
  content.invalidateAssets();   // R9-12: счётчики ассетов — из кэша; своя заливка видна сразу
  // Коллайдер из невидимого меша `collider*` (GLB): габариты → форма коллизии (в долях тайла). Редактор пишет в models[].collider.
  const collider = ext === 'glb' ? extractColliderFromGlb(buf) : null;
  if (collider) console.log(`[assets] коллайдер ${id}: ${JSON.stringify(collider)}`);
  res.json({ ok: true, id, url: '/assets/' + relPath, bytes: buf.length, stripped: !!stripNote, note: stripNote || undefined, collider: collider ?? undefined });
}));

// ── Dev: загрузка РЕАЛЬНЫХ сейвов в калькулятор/сим баланса (без auth, только не в проде) ──
app.get('/api/dev/characters', ah(async (req, res) => {
  if (!await devGuard(req, res)) return;
  res.json({ characters: await listAllCharacters() });
}));
app.get('/api/dev/characters/:charId', ah<{ charId: string }>(async (req, res) => {
  if (!await devGuard(req, res)) return;
  if (!isCharId(req.params.charId)) return res.status(400).json({ error: 'Неверный id персонажа' });   // R4-02: до базы
  const ch = await getCharacter(req.params.charId);
  if (!ch) return res.status(404).json({ error: 'Персонаж не найден' });
  res.json({ save: ch.data });
}));

// ── Аккаунты и ростер героев: `/api/register|login|logout|logout-all`, `/api/characters` — `net/accountRoutes.ts`
// (R4-02: строки запроса проверяются правилом провода ДО базы). Регистрируются ЗДЕСЬ — до раздачи статики ниже.
installAccountRoutes(app, { config });

/**
 * КТО Я И ЧТО МНЕ МОЖНО. Нужен редакторам на ВХОДЕ: они спрашивают вход до того, как
 * что-нибудь показать, а значит обязаны ПРОВЕРИТЬ сохранённый токен, а не поверить ему. Самого по себе
 * наличия строки в localStorage не достаточно: роль могли снять, сессию — отозвать, ключ — сменить.
 *
 * Отвечает и обычному игроку (`role: 'player'`) — это не утечка, человек узнаёт только о СЕБЕ,
 * зато редактор может сказать «вошёл, но прав нет» вместо безликого отказа.
 */
app.get('/api/me', ah(async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Требуется вход' });
  // Ключ процессов — не человек: имени у него нет, права админские.
  if (keyMatches(token, ADMIN_KEY, timingSafeEqual)) return res.json({ role: 'admin', via: 'key' });
  const userId = await sessionUser(req, res, token);   // R4-02: кривой токен — без базы; R9-12: неудачи — под бакетом адреса
  if (!userId) return;
  const user = await getUserById(userId);
  if (!user) return res.status(401).json({ error: 'Требуется вход' });
  res.json({ userId, username: user.username, role: user.role, via: 'session' });
}));

// ⭐ U6b: модель оружия из деталей — GLB по подписи вида (`GET /api/craft-mesh.glb`, `net/craftMeshRoutes.ts`): печёт поток печи
// (`craftMesh/worker.ts`) тем же построителем, что у веба; главный поток `three` не грузит. Нода кластера HTTP API не отдаёт (R10-09).
if (ROLE !== 'node') installCraftMeshRoute(app, { config });

// ── Статика клиента (прод: ОДИН сервер отдаёт игру + /api + /ws на одном домене) ──────────
// Регистрируется ПОСЛЕ всех /api-роутов, поэтому их не затирает; WS — на upgrade `/ws`, отдельно.
// Клиент сам находит сервер на том же origin (`/api`, `wss://<host>/ws`), доп. конфиг не нужен.
// Модели и текстуры (`/assets`, ASSETS_DIR) и собранный клиент (его бандл — тоже `/assets`, R10-03) — `net/staticRoutes.ts`.
const CLIENT_DIST = process.env.CLIENT_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
// Ф0.9: `DM_SERVE_STATIC=off` снимает раздачу клиента с игрового процесса. Сейчас через него
// идут 7,4 МБ бандла и 31 МБ моделей — один холодный заход стоит игровому ядру десятков
// мегабайт. Правильный ответ это CDN; переменная нужна, чтобы отделить игру от раздачи уже
// сегодня, не дожидаясь CDN (второй процесс с тем же CLIENT_DIST).
const SERVE_STATIC = process.env.DM_SERVE_STATIC !== 'off';
// R10-09: нода статику не отдаёт вовсе (`installNodeFence` выше) — и не монтирует.
const ENTRY = ROLE === 'node' ? undefined : installStatic(app, { assetsDir: ASSETS_DIR, clientDist: CLIENT_DIST, serveStatic: SERVE_STATIC, dev: DEV_CONFIG_APPLY });
if (ROLE === 'node') {
  console.log('[dm-server] нода кластера: по HTTP — только /metrics, /internal/drain и /api/health (API и статика — у гейтвея)');
} else if (!SERVE_STATIC) {
  console.log('[dm-server] раздача статики выключена (DM_SERVE_STATIC=off)');
} else if (ENTRY) {
  console.log(`[dm-server] отдаю клиент из ${CLIENT_DIST}, корневая страница — ${ENTRY}`);
} else {
  console.log('[dm-server] client/dist не найден — статику не отдаю (dev: клиент на Vite :5173)');
}

/** Лаг цикла событий этой ноды — уезжает в реестр с каждым ударом сердца (Ф4). */
const clusterLoop = monitorEventLoopDelay({ resolution: 5 });
clusterLoop.enable();
if (ROLE === 'supervisor') {
  const { runSupervisor } = await import('./cluster/supervisor.js');
  installCrashDrain();   // R5-01: необработанное исключение — остановка детей их сливом, а не обрыв
  runSupervisor();
  // Супервизор не слушает портов и не ходит в базу — дальше по файлу ему делать нечего.
  await new Promise(() => { /* живёт, пока живы дети */ });
}

const PORT = Number(process.env.PORT ?? 3001);
/**
 * Ф1.6: транспорт сменный. По умолчанию `uws` — замер после общего кадра на комнату дал
 * 9–12 % меньше CPU и на четверть меньше задержки, потому что транспорт стал основной
 * работой процесса. `DM_WS=ws` возвращает прежнюю библиотеку; если пакет uWS не собран
 * под платформу, откат на `ws` происходит сам, и сервер всё равно поднимается.
 *
 * В режиме uws игровой порт занимает он, а express переезжает на порт петли и получает
 * запросы через прокси: снаружи адрес не меняется — тот же порт, тот же `/ws`, тот же `/api`.
 */
// Хранилище готово, конфиг собран — только теперь можно принимать запросы (Ф2).
await boot();
// ⭐ R5-01: с этого момента процесс держит игроков — необработанное исключение начинает обычный слив (запись сейвов, снятие
// ноды), а не обрывает процесс со всеми комнатами. До загрузки падение остаётся падением: дописывать ещё нечего.
installCrashDrain();
// ⭐ R16 C-02, C-08: правка конфига в другом процессе (редактор — у гейтвея) или мимо сервера — и здесь: сверка ревизии оверрайдов в базе,
// сдвинулась — пересборка. Иначе нода сверяла согласие команд кузницы и лавки (`cfgRev` — ревизия конфига гейтвея) со своим конфигом старта.
startConfigSync({ readRev: getConfigOverridesRev, rebuild: rebuildConfig, initial: bootConfigRev, who: `dm-server ${ROLE}` });

// Гейтвею игровой транспорт не нужен: он раздаёт адреса нод, а не возит кадры.
const wantUws = ROLE !== 'gateway' && (process.env.DM_WS ?? 'uws') === 'uws';
const uws = wantUws && startUwsServer(config, PORT, Number(process.env.DM_HTTP_PORT ?? PORT + 1));
const HTTP_PORT = uws ? Number(process.env.DM_HTTP_PORT ?? PORT + 1) : PORT;
const server = createServer(app);
// Выключаем алгоритм Нейгла на КАЖДОМ TCP-соединении (HTTP + апгрейд WS идут по этим же сокетам):
// иначе мелкие реалтайм-пакеты (ввод/снапшоты) склеиваются и ждут до ~40мс, что складывается с пингом.
server.on('connection', (socket) => socket.setNoDelay(true));
if (!uws && ROLE !== 'gateway') attachWsServer(server, config); // авторитетный кооп на /ws (комнаты = GameSession)

// Ф4.1: маршрутизация и очередь живут на гейтвее (и в одиночном режиме — там он сам себе узел).
if (ROLE === 'gateway' || ROLE === 'single') {
  const { installGatewayRoutes } = await import('./cluster/gateway.js');
  const { initClusterSchema } = await import('./cluster/registry.js');
  await initClusterSchema();
  // R6-20: состояние кластера читается по правилу `/metrics` — с самой машины или ключом чтения метрик.
  installGatewayRoutes(app, { canRead: internalReader({ nodeId: process.env.DM_NODE_ID ?? 'node-0' }) });
}

// ⭐ R6-21: ошибки express (кривой JSON, тело больше потолка) — ответом JSON без стека в логе; ставится после всех ручек.
app.use(httpErrors);

// Ф4.5: слив узла по команде (`POST /internal/drain`) — в `installInternalRoutes` выше, рядом с метриками.

// Ф4.3: нода объявляет себя кластеру и уходит с деплоя по-человечески (Ф4.5).
if (ROLE === 'node' || ROLE === 'single') {
  const { joinCluster, installNodeShutdown } = await import('./cluster/node.js');
  const { clusterHooks } = await import('./net/roomManager.js');
  const nodeId = process.env.DM_NODE_ID ?? 'node-0';
  const url = process.env.DM_NODE_URL ?? `ws://127.0.0.1:${PORT}/ws`;
  await joinCluster(nodeId, url, () => clusterHooks.liveCharIds(), clusterLoop,
    (lost) => clusterHooks.fenceLost(lost), (gone) => clusterHooks.releaseIdle(gone), () => clusterHooks.heldRuns(),   // V2: и забеги
    // ⭐ ENV1: забег, числящийся за другой нодой, комната отпускает; нода кластера держит аренду и на её исходе отгораживает себя сама
    // (одиночному процессу отдавать героев некому — аренды у него нет).
    // ⭐ R15-08: забег, который комната отпустила, пока удар его продлевал, — отпустить снова.
    { runsLost: (runs) => clusterHooks.fenceRuns(runs), runsGone: (runs) => clusterHooks.releaseRuns(runs), lease: ROLE === 'node' });
  installNodeShutdown(nodeId, (budgetMs) => clusterHooks.flushAll(budgetMs));
  console.log(`[${nodeId}] в кластере: ${url}`);
}
// В режиме uws express слушает ТОЛЬКО петлю: снаружи на него не должно быть прямого хода
// мимо прокси, иначе мимо него уедут и заголовки адреса, по которым считаются лимиты частоты.
// EADDRINUSE устойчиво (dev-рестарт: старый инстанс ещё держит порт) — повтор, ⭐ R10-16: на тот же адрес (`net/listen.ts`).
listenWithRetry(server, HTTP_PORT, uws ? '127.0.0.1' : undefined, {
  onFatal: (err) => {
    console.error('[dm-server] фатальная ошибка сервера:', err);
    process.exit(1);
  },
  onListening: () => console.log(`[dm-server] слушает http://localhost:${PORT}`),
});
