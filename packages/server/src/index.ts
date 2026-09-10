import express, { type Request, type Response, type RequestHandler } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdirSync, watch } from 'node:fs';
import { ConfigRegistry, configSchemas, newCharacterSave } from '@dm/shared';
import { configKeyForFile } from './configFiles.js';
import { hashPassword, verifyPassword } from './auth/password.js';
import {
  createUser, getUserByName, createSession, deleteSession, getSession, countRecentRegistrations,
  listCharacters, listAllCharacters, getCharacter, createCharacter, deleteCharacter, countCharacters,
  getUserById,
  getConfigOverrides, setConfigOverride, deleteConfigOverride,
  getPoseStore, getPoseRevs, setPoseStore, deletePoseStore, clearAllRuns, seedPoseStoreIfEmpty, sweepSessions,
  getUserRole,
  deleteSessionsOfUser,
} from './db/db.js';
import { initSchema, closePool } from './db/pool.js';
import { attachWsServer } from './net/wsServer.js';
import { startUwsServer } from './net/uwsServer.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { limits, clientIp } from './net/rateLimit.js';
import { renderMetrics } from './net/metrics.js';
import { originAllowed, parseOrigins, keyMatches } from './net/adminAccess.js';
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

  // Рестарт сервера = чистый лист забегов: сбрасываем все НЕЗАВЕРШЁННЫЕ забеги (save.run) у всех
  // персонажей. Иначе спуск из города РЕЗЮМИТ старый забег (старый биом/сид) и игнорит алтарь.
  watchConfigFiles();   // правки data/*.json должны быть видны в редакторе и в игре без рестарта

  const wiped = await clearAllRuns();
  if (wiped) console.log(`[dm-server] сброшено незавершённых забегов: ${wiped}`);

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

const MAX_CHARS = 5;
/**
 * Ф3.5: сколько аккаунтов можно завести с одного адреса за сутки. Пять — с запасом на семью
 * и общий интернет: люди заводят аккаунт один раз, а ферма ботов упирается в потолок.
 */
const MAX_ACCOUNTS_PER_IP = Number(process.env.DM_MAX_ACCOUNTS_PER_IP ?? 5);
/**
 * Стенд заводит сотню аккаунтов с одного адреса и упирался в этот потолок (в первом прогоне
 * дошли 5 ботов из 60). Потолок — тот же лимит частоты по смыслу, поэтому и выключается тем
 * же переключателем `DM_RATELIMIT=off`, который ставит только `loadtest/probe.ts`. Боевая
 * конфигурация проверяется отдельно — `npm run poc:flood`.
 */
const ACCOUNT_CAP_ON = process.env.DM_RATELIMIT !== 'off';

/**
 * Express 4 не ловит отказ промиса из обработчика: необработанный `reject` уронил бы процесс.
 * Все обработчики, ходящие в базу (Ф2 — доступ асинхронный), оборачиваются этим.
 */
type RouteParams = Record<string, string>;
const ah = <P extends RouteParams = RouteParams>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>,
): RequestHandler<P> => (req, res) => {
  void fn(req as Request<P>, res).catch((e: unknown) => {
    console.error('[dm-server] отказ в обработчике:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' });
  });
};

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
app.use(express.json({ limit: '2mb' }));

/**
 * Ф1.7: метрики для мониторинга. Отдаём ТОЛЬКО локально — состав комнат, число игроков и
 * счётчики нарушений это внутренняя информация, наружу её выставлять незачем. Prometheus
 * ходит с той же машины или через прокси, который сам решает, кого пускать.
 */
app.get('/metrics', (req, res) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!LOCAL_HOSTS.has(ip)) return res.status(403).end();
  // Ф4: на гейтвее метрики — это СУММА по кластеру. Иначе мониторинг показывал бы работу
  // процесса, который игру не ведёт, а стенд мерил бы одну ноду из десяти.
  if (process.env.DM_ROLE === 'gateway') {
    void (async () => {
      const { clusterMetrics } = await import('./cluster/gateway.js');
      res.type('text/plain; version=0.0.4').send(await clusterMetrics());
    })().catch(() => res.status(500).end());
    return;
  }
  res.type('text/plain; version=0.0.4').send(renderMetrics());
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
  // Слабый ETag по длине и дешёвой контрольной сумме тела: считать sha по 436 КБ на каждой
  // правке незачем, а от случайного совпадения этого достаточно.
  let h = 0;
  for (let i = 0; i < configBody.length; i += 64) h = (h * 31 + configBody.charCodeAt(i)) | 0;
  configEtag = `W/"${configBody.length.toString(36)}-${(h >>> 0).toString(36)}"`;
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
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const ADMIN_KEY = process.env.DM_ADMIN_KEY ?? '';
async function devGuard(req: Request, res: Response): Promise<boolean> {
  if (!DEV_CONFIG_APPLY) { res.status(403).json({ error: 'Отключено в продакшене' }); return false; }
  const token = bearer(req);
  if (!token) { res.status(401).json({ error: 'Требуется вход' }); return false; }
  if (keyMatches(token, ADMIN_KEY, timingSafeEqual)) return true;
  const userId = await getSession(token);
  if (!userId) { res.status(401).json({ error: 'Требуется вход' }); return false; }
  if (await getUserRole(userId) !== 'admin') {
    console.warn(`[dm-server] отказ dev-роута ${req.path}: у ${userId} нет прав администратора`);
    res.status(403).json({ error: 'Нужны права администратора' });
    return false;
  }
  return true;
}
app.post('/api/dev/config', ah(async (req, res) => {
  if (!await devGuard(req, res)) return;
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
app.post('/api/dev/config-file', ah(async (req, res) => {
  if (!await devGuard(req, res)) return;
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
      writeFileSync(configFileFor(key), JSON.stringify(value, null, 2) + '\n');
      await setConfigOverride(key, value); // живой конфиг остаётся верным независимо от импортов в памяти
      written.push(key);
    }
  } catch (e) {
    return res.status(500).json({ error: `Не удалось записать файл: ${e instanceof Error ? e.message : String(e)}` });
  }
  rebuildConfig();
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
app.get('/api/pose', ah(async (_req, res) => {
  res.json(await getPoseStore());
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
app.post('/api/dev/pose', ah(async (req, res) => {
  if (!await devGuard(req, res)) return;
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
  for (const k of keys) rev[k] = await setPoseStore(k, body[k]);
  res.json({ ok: true, saved: keys, rev });
}));
app.delete('/api/dev/pose/:key', ah<{ key: string }>(async (req, res) => {
  if (!await devGuard(req, res)) return;
  await deletePoseStore(req.params.key);
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
// Content-Type → расширение файла. GLB (модели) и PNG/JPG (текстуры). Прочее → .bin.
const ASSET_EXT: Record<string, string> = { 'model/gltf-binary': 'glb', 'application/octet-stream': 'glb', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
// Обработчик стал асинхронным вместе с `devGuard` (проверка роли ходит в базу) — отсюда `ah`.
app.post('/api/dev/assets/:id', express.raw({ type: Object.keys(ASSET_EXT), limit: '64mb' }), ah<{ id: string }>(async (req, res) => {
  if (!await devGuard(req, res)) return;
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
  const ch = await getCharacter(req.params.charId);
  if (!ch) return res.status(404).json({ error: 'Персонаж не найден' });
  res.json({ save: ch.data });
}));

// ── Хелперы ────────────────────────────────────────────────────────────────────
function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m ? m[1]! : null;
}
/** userId по токену из заголовка; иначе шлёт 401 и возвращает null. */
async function requireAuth(req: Request, res: Response): Promise<string | null> {
  const token = bearer(req);
  const userId = token ? await getSession(token) : null;
  if (!userId) { res.status(401).json({ error: 'Требуется вход' }); return null; }
  return userId;
}
function validCreds(body: unknown): { username: string; password: string } | null {
  const b = body as { username?: unknown; password?: unknown };
  const username = typeof b?.username === 'string' ? b.username.trim() : '';
  const password = typeof b?.password === 'string' ? b.password : '';
  if (username.length < 3 || username.length > 20) return null;
  if (password.length < 6 || password.length > 200) return null;
  return { username, password };
}

// ── Аутентификация ───────────────────────────────────────────────────────────
app.post('/api/register', ah(async (req, res) => {
  // Ф0.5: без лимита один скрипт кладёт сервер регистрациями — каждая это scrypt (~100 мс CPU
  // и десятки мегабайт). Ключ — IP; заголовок прокси учитывается, если он есть.
  const ip = clientIp(req.headers, req.socket.remoteAddress);
  if (!limits.register.take(ip)) {
    res.setHeader('Retry-After', String(limits.register.retryAfterSec(ip)));
    return res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
  }
  const creds = validCreds(req.body);
  if (!creds) return res.status(422).json({ error: 'Ник 3–20 символов, пароль от 6' });
  // Ф3.5: суточный потолок аккаунтов с одного адреса. Лимит частоты выше защищает от шквала
  // за минуту, но завести двадцать аккаунтов не спеша он не мешает — а ферму ботов разводят
  // именно так. Честный игрок заводит аккаунт один раз и потолка не замечает.
  if (ACCOUNT_CAP_ON && await countRecentRegistrations(ip) >= MAX_ACCOUNTS_PER_IP) {
    console.warn(`[dm-server] потолок регистраций с адреса ${ip}`);
    return res.status(429).json({ error: 'С этого адреса сегодня создано слишком много аккаунтов' });
  }
  if (await getUserByName(creds.username)) return res.status(409).json({ error: 'Ник уже занят' });
  const { hash, salt } = hashPassword(creds.password);
  const userId = await createUser(creds.username, hash, salt, ip);
  res.json({ token: await createSession(userId), userId, username: creds.username });
}));

app.post('/api/login', ah(async (req, res) => {
  // Ф0.5: тот же scrypt плюс защита от перебора пароля. Успешный вход обнуляет счётчик —
  // человек, промахнувшийся пару раз, не должен потом ждать.
  const ip = clientIp(req.headers, req.socket.remoteAddress);
  if (!limits.login.take(ip)) {
    res.setHeader('Retry-After', String(limits.login.retryAfterSec(ip)));
    return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже' });
  }
  const creds = validCreds(req.body);
  if (!creds) return res.status(422).json({ error: 'Неверные данные' });
  const user = await getUserByName(creds.username);
  if (!user || !verifyPassword(creds.password, user.passHash, user.passSalt)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  limits.login.reset(ip);
  res.json({ token: await createSession(user.id), userId: user.id, username: user.username });
}));

/**
 * Ф3.4: выйти на ВСЕХ устройствах. Единственный способ обезвредить уведённый токен, не дожидаясь
 * его срока. Сюда же должна звать смена пароля, когда она появится: пароль сменили, а старые
 * сессии продолжают играть — это не защита.
 */
app.post('/api/logout-all', ah(async (req, res) => {
  const userId = await requireAuth(req, res); if (!userId) return;
  const n = await deleteSessionsOfUser(userId);
  console.log(`[dm-server] отозваны все сессии пользователя ${userId}: ${n}`);
  res.json({ ok: true, revoked: n });
}));

app.post('/api/logout', ah(async (req, res) => {
  const token = bearer(req);
  if (token) await deleteSession(token);
  res.json({ ok: true });
}));

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
  const userId = await getSession(token);
  if (!userId) return res.status(401).json({ error: 'Требуется вход' });
  const user = await getUserById(userId);
  if (!user) return res.status(401).json({ error: 'Требуется вход' });
  res.json({ userId, username: user.username, role: user.role, via: 'session' });
}));

// ── Персонажи (принадлежат пользователю) ───────────────────────────────────────
app.get('/api/characters', ah(async (req, res) => {
  const userId = await requireAuth(req, res); if (!userId) return;
  res.json({ characters: await listCharacters(userId) });
}));

app.post('/api/characters', ah(async (req, res) => {
  const userId = await requireAuth(req, res); if (!userId) return;
  const b = req.body as { classId?: unknown; name?: unknown };
  const classId = typeof b?.classId === 'string' ? b.classId : '';
  const name = (typeof b?.name === 'string' ? b.name : '').trim();
  if (!name || name.length > 16) return res.status(422).json({ error: 'Имя 1–16 символов' });
  if (!config.get('classes').some((c) => c.id === classId && c.enabled !== false)) return res.status(422).json({ error: 'Неизвестный или отключённый класс' });
  if (await countCharacters(userId) >= MAX_CHARS) return res.status(409).json({ error: `Лимит ${MAX_CHARS} персонажей` });
  const charId = randomUUID();
  const save = newCharacterSave(config, classId, name, charId); // авторитетный стартовый сейв
  await createCharacter(charId, userId, save);
  res.json({ character: { charId, name: save.name, classId: save.classId, level: save.level } });
}));

app.delete('/api/characters/:charId', ah<{ charId: string }>(async (req, res) => {
  const userId = await requireAuth(req, res); if (!userId) return;
  const ch = await getCharacter(req.params.charId);
  if (!ch || ch.userId !== userId) return res.status(404).json({ error: 'Персонаж не найден' });
  await deleteCharacter(req.params.charId, userId);
  res.json({ ok: true });
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
if (!SERVE_STATIC) {
  console.log('[dm-server] раздача статики выключена (DM_SERVE_STATIC=off)');
} else if (existsSync(join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST));
  // SPA-фолбэк: любой не-/api GET → index.html (deep links). /api/* уходит в 404 выше по стеку.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(CLIENT_DIST, 'index.html'));
  });
  console.log(`[dm-server] отдаю клиент из ${CLIENT_DIST}`);
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
  installGatewayRoutes(app);
}

/**
 * Ф4.5: СЛИВ УЗЛА ПО КОМАНДЕ — только с самой машины (как и метрики).
 *
 * Зачем ручка, если есть SIGTERM: во-первых, на Windows сигналов нет вовсе и проверить слив
 * иначе нельзя; во-вторых, в бою это штатный инструмент выкатки — «слить узел 3, дождаться
 * пустоты, перезапустить», и так по одному, без простоя для остальных.
 */
app.post('/internal/drain', (req, res) => {
  const ip = req.socket.remoteAddress ?? '';
  if (!LOCAL_HOSTS.has(ip)) return res.status(403).end();
  console.log(`[${process.env.DM_NODE_ID ?? 'node-0'}] слив по команде`);
  res.json({ ok: true, node: process.env.DM_NODE_ID ?? 'node-0' });
  // Ответ уходит ДО начала слива: вызывающий должен получить подтверждение, а не таймаут.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
});

// Ф4.3: нода объявляет себя кластеру и уходит с деплоя по-человечески (Ф4.5).
if (ROLE === 'node' || ROLE === 'single') {
  const { joinCluster, installNodeShutdown } = await import('./cluster/node.js');
  const { clusterHooks } = await import('./net/roomManager.js');
  const nodeId = process.env.DM_NODE_ID ?? 'node-0';
  const url = process.env.DM_NODE_URL ?? `ws://127.0.0.1:${PORT}/ws`;
  await joinCluster(nodeId, url, () => clusterHooks.liveCharIds(), clusterLoop);
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
