import express, { type Request, type Response, type RequestHandler } from 'express';
import { configEtagOf } from './configEtag.js';
import cors from 'cors';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, watch } from 'node:fs';
import { ConfigRegistry, configSchemas } from '@dm/shared';
import { configKeyForFile } from './configFiles.js';
import { arrayElementSchema, formatConfigFile } from './configFileFormat.js';
import {
  getSession, listAllCharacters, getCharacter,
  getUserById,
  getConfigOverrides, setConfigOverride, deleteConfigOverride,
  getPoseStore, getPoseRevs, setPoseStore, deletePoseStore, clearAllRuns, seedPoseStoreIfEmpty, sweepSessions,
  getUserRole,
} from './db/db.js';
import { initSchema, closePool } from './db/pool.js';
import { attachWsServer } from './net/wsServer.js';
import { startUwsServer } from './net/uwsServer.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { renderMetrics } from './net/metrics.js';
import { originAllowed, parseOrigins, keyMatches } from './net/adminAccess.js';
import { installInternalRoutes, internalReader, drainProcess, installCrashDrain } from './net/internalRoutes.js';
import { installAccountRoutes, bearer, isSessionToken, isCharId } from './net/accountRoutes.js';
import { ah, httpErrors } from './net/asyncRoute.js';
import { cachedJson } from './net/cachedJson.js';
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

/** Накатывает сохранённые оверрайды поверх дефолтов (устойчиво к невалидным — пропускает). */
async function applyConfigOverrides(): Promise<void> {
  const all = await getConfigOverrides();
  for (const [key, value] of Object.entries(all)) {
    try {
      config.reload({ [key]: value });
    } catch (e) {
      console.warn(`[dm-server] пропущен невалидный оверрайд конфига "${key}": ${e instanceof Error ? e.message : e}`);
    }
  }
  // ГОВОРИМ ВСЛУХ, что перекрыто. Оверрайд из редактора живёт в БД и переживает рестарт, поэтому
  // «правлю файл, а везде старое» выглядит как мистика, пока не увидишь эту строчку.
  const keys = Object.keys(all);
  if (keys.length) console.log(`[dm-server] поверх файлов лежат оверрайды редактора: ${keys.join(', ')}`);
}
/** Полная пересборка живого конфига: дефолты + персистентные оверрайды (комнаты держат ссылку). */
async function rebuildConfig(): Promise<void> {
  config.loadAll();
  await applyConfigOverrides();
  rebuildConfigCache(); // Ф0.7: тело для /api/config готовим здесь же, а не на каждом запросе
}

/**
 * Подготовка хранилища перед приёмом запросов (Ф2). Раньше всё это делалось прямо в модуле —
 * доступ был синхронным. Теперь порядок явный, и слушать порт мы начинаем ТОЛЬКО после того,
 * как схема есть, а конфиг собран: иначе первый же запрос увидел бы полупустой реестр.
 */
async function boot(): Promise<void> {
  await initSchema();
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
  }

  // Посев авторского 3D-контента поз-редактора при пустой БД (свежий/сброшенный сервер) — чтобы
  // анимации были из коробки. Источник — pose-seed.json в git.
  const seeded = await seedPoseStoreIfEmpty();
  if (seeded) console.log(`[dm-server] pose_store засеян из pose-seed.json: ${seeded} ключей`);

  const gone = await sweepSessions();
  if (gone) console.log(`[dm-server] убрано протухших сессий: ${gone}`);

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

// ── Конфиг игры (единая истина: сервер) ─────────────────────────────────────────
// GET отдаёт АКТУАЛЬНЫЙ эффективный конфиг (дефолты + сохранённые правки) — его грузят
// и клиент (вью/тултипы), и редактор (показывает реальные значения). Одна истина везде.
// Ф0.7: тело конфига сериализуется ОДИН раз — при старте и при каждой правке из редактора.
// Раньше на каждый запрос шёл `structuredClone` всего реестра плюс `JSON.stringify`: 8,58 мс
// блокировки цикла и 436 КБ тела. Один вход игрока съедал четверть тикового бюджета, сотня
// входов в секунду — 86 % ядра на один этот роут.
let configBody = '';
let configEtag = '';
function rebuildConfigCache(): void {
  configBody = JSON.stringify(config.snapshot());
  configEtag = configEtagOf(configBody);   // по ВСЕМУ телу — см. `configEtag.ts`, там разобрано, чем стоила выборка
}


app.get('/api/config', (req, res) => {
  if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-store');   // DEV: конфиг всегда свежий (модели/текстуры/объекты)
  res.setHeader('ETag', configEtag);
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
  // Не ключ процессов и не токен сессии по виду — в базу незачем (R4-02).
  const userId = isSessionToken(token) ? await getSession(token) : null;
  if (!userId) { res.status(401).json({ error: 'Требуется вход' }); return false; }
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
  void devGuard(req, res).then((ok) => { if (ok) next(); }).catch((e: unknown) => {
    console.error('[dm-server] отказ в обработчике:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' });
  });
};
/** Тело JSON инструментов (конфиг, контент поз-редактора — сотни КБ) — ставится ПОСЛЕ `devGate`. */
const devJson = express.json({ limit: '2mb' });
app.post('/api/dev/config', devGate, devJson, ah(async (req, res) => {
  const overrides = (req.body ?? {}) as Record<string, unknown>;
  try {
    const trial = new ConfigRegistry(); // валидация ДО записи в БД (на временном реестре)
    trial.loadAll();
    trial.reload(overrides); // бросит при мусоре/неизвестном ключе
  } catch (e) {
    return res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
  for (const [key, value] of Object.entries(overrides)) await setConfigOverride(key, value);
  await rebuildConfig();
  console.log(`[dm-server] конфиг сохранён из редактора: ${Object.keys(overrides).join(', ') || '—'}`);
  res.json({ ok: true, applied: Object.keys(overrides) });
}));

// «Применить везде»: пишет правку прямо в ФАЙЛ-источник (data/*.json) → попадёт в git и на деплой.
// Дополнительно ставит оверрайд в БД, чтобы живой конфиг остался верным (не откатился на дефолт,
// импортированный в память при старте — файл перечитается лишь при рестарте процесса). DEV-only.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'src', 'config', 'data');
const configFileFor = (key: string): string => join(DATA_DIR, key.replace(/\./g, '-') + '.json');
app.post('/api/dev/config-file', devGate, devJson, ah(async (req, res) => {
  const overrides = (req.body ?? {}) as Record<string, unknown>;
  try {
    const trial = new ConfigRegistry(); // валидация ДО записи в файл
    trial.loadAll();
    trial.reload(overrides);
  } catch (e) {
    return res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
  const written: string[] = [];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      // Файл «строка на запись» (weapon-parts) пишем в его же формате и без умолчаний zod — иначе одна правка
      // детали давала diff на весь файл (`configFileFormat.ts`).
      const path = configFileFor(key);
      writeFileSync(path, formatConfigFile(value, existsSync(path) ? readFileSync(path, 'utf8') : null, arrayElementSchema(key)));
      await setConfigOverride(key, value); // живой конфиг остаётся верным независимо от импортов в памяти
      written.push(key);
    }
  } catch (e) {
    return res.status(500).json({ error: `Не удалось записать файл: ${e instanceof Error ? e.message : String(e)}` });
  }
  // ⚠ `await`. Здесь стоял голый вызов АСИНХРОННОЙ `rebuildConfig()`, и это два дефекта разом:
  //  • сервер отвечал «ок» ДО пересборки — редактор тут же перечитывал `/api/config` и получал СТАРОЕ
  //    тело, то есть «сохранил, а не применилось» на ровном месте;
  //  • отказ внутри (валидация, база) становился НЕОБРАБОТАННЫМ reject, а он в Node роняет процесс.
  await rebuildConfig();
  console.log(`[dm-server] конфиг записан в ФАЙЛ (+БД): ${written.join(', ') || '—'}`);
  res.json({ ok: true, written });
}));

// Сброс ключа к встроенному дефолту (удаляет персистентный оверрайд).
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
 */
function watchConfigFiles(): void {
  if (process.env.NODE_ENV === 'production' || process.env.DM_WATCH_CONFIG === '0') return;
  const pending = new Map<string, NodeJS.Timeout>();
  try {
    watch(DATA_DIR, (_ev, file) => {
      if (!file || !file.endsWith('.json')) return;
      clearTimeout(pending.get(file));
      // Дребезг: запись файла редактором/генератором прилетает несколькими событиями подряд.
      pending.set(file, setTimeout(() => { pending.delete(file); void applyFileChange('', file); }, 200));
    });
    console.log(`[dm-server] слежу за ${DATA_DIR} — правки data/*.json подхватываются на лету`);
  } catch (e) {
    console.warn(`[dm-server] не удалось следить за конфигами: ${e instanceof Error ? e.message : e}`);
  }
}

async function applyFileChange(_key: string, file: string): Promise<void> {
  const real = configKeyForFile(file, Object.keys(configSchemas));
  if (!real) return;
  try {
    const value = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
    config.reload({ [real]: value });                       // сперва валидация: невалидный файл сюда не пройдёт
    if (Object.prototype.hasOwnProperty.call(await getConfigOverrides(), real)) {
      await deleteConfigOverride(real);                     // снимаем устаревший снимок, иначе он переживёт рестарт
      console.log(`[dm-server] снят устаревший оверрайд «${real}» — теперь главенствует файл`);
    }
    rebuildConfigCache();
    console.log(`[dm-server] конфиг перечитан с диска: ${real}`);
  } catch (e) {
    // Файл могли поймать на середине записи или он реально невалиден — живой конфиг не трогаем.
    console.warn(`[dm-server] ${file} не применён: ${e instanceof Error ? e.message : e}`);
  }
}

app.delete('/api/dev/config/:key', ah<{ key: string }>(async (req, res) => {
  if (!await devGuard(req, res)) return;
  await deleteConfigOverride(req.params.key);
  await rebuildConfig();
  console.log(`[dm-server] конфиг сброшен к дефолту: ${req.params.key}`);
  res.json({ ok: true, reset: req.params.key });
}));

// ── Контент 3D поз-редактора (единая истина: сервер) ─────────────────────────────
// GET — весь авторский контент (pe_gait/clips/sway/phys/ragdoll/chars); грузят и редактор, и игра
// (кэшируют в localStorage). POST — правки редактора, DEV-only (в проде клиент не переписывает контент).
// ⭐ R6-20: тело — из кэша (`cachedJson`), с ETag. Раньше каждый анонимный GET читал из базы весь `pose_store` (сотни КБ) и
// сериализовал его заново. Сброс — при записи этим процессом (`/api/dev/pose`), срок — для записей соседних процессов.
const POSE_CACHE_MS = 5_000;
const poseBody = cachedJson(() => getPoseStore(), POSE_CACHE_MS);
app.get('/api/pose', ah(async (req, res) => {
  const { body, etag } = await poseBody.get();
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('application/json').send(body);
}));
// Ревизии без тел: редактор зовёт их на каждой загрузке, чтобы понять, ушёл ли сервер вперёд.
app.get('/api/pose/rev', ah(async (_req, res) => {
  res.json(await getPoseRevs());
}));
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
  } finally { poseBody.invalidate(); }   // R6-20: и упавшая на середине запись могла лечь частью
  res.json({ ok: true, saved: keys, rev });
}));
app.delete('/api/dev/pose/:key', ah<{ key: string }>(async (req, res) => {
  if (!await devGuard(req, res)) return;
  try { await deletePoseStore(req.params.key); } finally { poseBody.invalidate(); }
  res.json({ ok: true, deleted: req.params.key });
}));

// ── Dev: ассеты 3D-моделей (GLB) — импорт из поз-редактора (FBX→настройка→экспорт GLB), раздача в игру ──
// GLB — бинарь, в pose_store НЕ кладём (там мелкие JSON); файлы на диске, мелкий конфиг (карта костей/тип/хват)
// — в pose_store (pe_models). Раздача статикой /assets/<id>.glb; в проде запись отключена (DEV_CONFIG_APPLY).
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });
// DEV: ЖЁСТКО без кэша — `no-store` + БЕЗ etag/last-modified (никаких 304). Браузер НИКОГДА не хранит и не
// ревалидирует: перезалил модель/текстуру под тем же именем → свежие байты сразу (без Ctrl+Shift+R, без залипания).
// ПРОД: часовой кэш (GLB крупные). Вернуть кэш = запустить с NODE_ENV=production.
app.use('/assets', express.static(ASSETS_DIR, {
  maxAge: DEV_CONFIG_APPLY ? 0 : '1h',
  etag: !DEV_CONFIG_APPLY,          // DEV: без ETag → нет условных запросов/304
  lastModified: !DEV_CONFIG_APPLY,  // DEV: без Last-Modified
  cacheControl: !DEV_CONFIG_APPLY,  // DEV: заголовок ставим сами (ниже)
  setHeaders: DEV_CONFIG_APPLY
    ? (res): void => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); }
    : undefined,
}));
// Нет такого файла → честный 404 (перехват ДО общего catch-all, иначе отсутствующий ассет отдавал HTML-заглушку со
// статусом 200, и игра парсила её как GLB/PNG). Заодно чистка битых ссылок в редакторе может достоверно определить «нет файла».
app.use('/assets', (_req, res) => { res.status(404).json({ error: 'asset not found' }); });
/**
 * СТАТИСТИКА ФАЙЛОВ АССЕТОВ — для вкладки «Роадмап» в редакторе: сколько моделей, текстур и звуков
 * реально лежит на сервере. Это позволяет пунктам роадмапа СЧИТАТЬ СЕБЯ САМИМ («звуков 0 из 200»),
 * вместо ручных галок, которые устаревают.
 *
 * Роут ЧИТАЮЩИЙ и без авторизации — в отличие от загрузки (`POST /api/dev/assets`): он отдаёт только
 * агрегаты (счётчики и суммарный объём), без имён файлов и содержимого.
 */
function assetStats(): { byExt: Record<string, number>; byDir: Record<string, number>; bytes: number } {
  const byExt: Record<string, number> = {};
  const byDir: Record<string, number> = {};
  let bytes = 0;
  const walk = (abs: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(abs); } catch { return; }        // папку могли удалить между вызовами — не 500-им из-за этого
    for (const name of entries) {
      const full = join(abs, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, rel ? rel + '/' + name : name); continue; }
      const ext = (name.split('.').pop() ?? '').toLowerCase();
      byExt[ext] = (byExt[ext] ?? 0) + 1;
      if (rel) byDir[rel] = (byDir[rel] ?? 0) + 1;
      bytes += st.size;
    }
  };
  walk(ASSETS_DIR, '');
  return { byExt, byDir, bytes };
}
app.get('/api/assets/stats', (_req, res) => { res.json(assetStats()); });

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
  if (ext === 'glb' && /^(1|true|yes)$/i.test(String(req.query.strip ?? ''))) {
    const before = buf.length;
    const r = stripGlbTextures(buf);
    buf = r.out; stripNote = r.note;
    if (r.changed) console.log(`[assets] strip ${id}: ${before}→${buf.length} — ${r.note}`);
  }
  // ?dir=<подпапка> — раскладка ассетов по папкам (напр. "crypt_tile_set" или "crypt_tile_set/textures"). Санитайз:
  // сегменты из латинских букв/цифр/_/-, без ".." и абсолютных путей → защита от path-traversal (только ASCII-имена).
  const dirSegs = String(req.query.dir ?? '').split(/[\\/]+/).map((s) => s.trim().replace(/[^a-zA-Z0-9_-]/g, '')).filter(Boolean);
  const relPath = [...dirSegs, id + '.' + ext].join('/');
  const absPath = join(ASSETS_DIR, ...dirSegs, id + '.' + ext);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
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
  const userId = isSessionToken(token) ? await getSession(token) : null;   // R4-02: кривой токен — без базы
  if (!userId) return res.status(401).json({ error: 'Требуется вход' });
  const user = await getUserById(userId);
  if (!user) return res.status(401).json({ error: 'Требуется вход' });
  res.json({ userId, username: user.username, role: user.role, via: 'session' });
}));

// ── Статика клиента (прод: ОДИН сервер отдаёт игру + /api + /ws на одном домене) ──────────
// Регистрируется ПОСЛЕ всех /api-роутов, поэтому их не затирает; WS — на upgrade `/ws`, отдельно.
// Клиент сам находит сервер на том же origin (`/api`, `wss://<host>/ws`), доп. конфиг не нужен.
const CLIENT_DIST = process.env.CLIENT_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
// Ф0.9: `DM_SERVE_STATIC=off` снимает раздачу клиента с игрового процесса. Сейчас через него
// идут 7,4 МБ бандла и 31 МБ моделей — один холодный заход стоит игровому ядру десятков
// мегабайт. Правильный ответ это CDN; переменная нужна, чтобы отделить игру от раздачи уже
// сегодня, не дожидаясь CDN (второй процесс с тем же CLIENT_DIST).
const SERVE_STATIC = process.env.DM_SERVE_STATIC !== 'off';
// ⚠ Корневую страницу НЕЛЬЗЯ прибивать к index.html: 2D-клиент больше не собирается в продакшен
// (см. `client/vite.config.ts`), и жёсткая ссылка на него выключила бы раздачу целиком — вместе
// с 3D-стендом и поз-редактором. Берём первую существующую страницу, порядок = приоритет.
const ENTRY = ['game3d.html', 'index.html'].find((f) => existsSync(join(CLIENT_DIST, f)));
if (!SERVE_STATIC) {
  console.log('[dm-server] раздача статики выключена (DM_SERVE_STATIC=off)');
} else if (ENTRY) {
  app.use(express.static(CLIENT_DIST));
  // SPA-фолбэк: любой не-/api GET → корневая страница (deep links). /api/* уходит в 404 выше по стеку.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(CLIENT_DIST, ENTRY));
  });
  console.log(`[dm-server] отдаю клиент из ${CLIENT_DIST}, корневая страница — ${ENTRY}`);
} else {
  console.log('[dm-server] client/dist не найден — статику не отдаю (dev: клиент на Vite :5173)');
}

/**
 * Роль процесса (Ф4). Один и тот же файл — три разных занятия:
 *   supervisor — поднимает гейтвей и ноды и следит за ними (по умолчанию в бою);
 *   gateway    — HTTP, аккаунты, конфиг, статика, маршрутизация и очередь; игры в нём нет;
 *   node       — только WebSocket и комнаты;
 *   single     — всё в одном процессе, как было до Ф4 (стенд, разработка, малый онлайн).
 */
const ROLE = process.env.DM_ROLE ?? 'single';
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
    (lost) => clusterHooks.fenceLost(lost), (gone) => clusterHooks.releaseIdle(gone));
  installNodeShutdown(nodeId, () => clusterHooks.flushAll());
  console.log(`[${nodeId}] в кластере: ${url}`);
}
// EADDRINUSE устойчиво: при dev-рестарте старый инстанс может ещё держать порт — НЕ роняем процесс необработанной
// ошибкой (иначе сервер умирает и редактор/клиент ловят ECONNREFUSED), а ждём освобождения и повторяем listen.
let listenTries = 0;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenTries < 10) {
    listenTries++;
    console.warn(`[dm-server] порт ${HTTP_PORT} занят (рестарт dev?) — повтор #${listenTries} через 500мс…`);
    setTimeout(() => server.listen(HTTP_PORT), 500);
  } else {
    console.error('[dm-server] фатальная ошибка сервера:', err);
    process.exit(1);
  }
});
// В режиме uws express слушает ТОЛЬКО петлю: снаружи на него не должно быть прямого хода
// мимо прокси, иначе мимо него уедут и заголовки адреса, по которым считаются лимиты частоты.
server.listen(HTTP_PORT, uws ? '127.0.0.1' : undefined, () => {
  listenTries = 0;
  console.log(`[dm-server] слушает http://localhost:${PORT}`);
});
