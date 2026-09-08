import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { ConfigRegistry, newCharacterSave } from '@dm/shared';
import { hashPassword, verifyPassword } from './auth/password.js';
import {
  createUser, getUserByName, createSession, deleteSession, getSession,
  listCharacters, listAllCharacters, getCharacter, createCharacter, deleteCharacter, countCharacters,
  getConfigOverrides, setConfigOverride, deleteConfigOverride,
  getPoseStore, getPoseRevs, setPoseStore, deletePoseStore, clearAllRuns, seedPoseStoreIfEmpty,
} from './db/db.js';
import { attachWsServer } from './net/wsServer.js';
import { limits, clientIp } from './net/rateLimit.js';
import { stripGlbTextures } from './glbStrip.js';
import { extractColliderFromGlb } from './glbMeshBbox.js';

/**
 * Бэкенд игры. Аккаунты по HTTP (`/api/register|login|logout`, `/api/characters` CRUD),
 * сама игра (город/данж/экономика/сейвы) — авторитетно в кооп-комнатах на WebSocket
 * (`net/wsServer` → `Room`). Персонажи принадлежат пользователю (`characters.userId`);
 * WS-join проверяет сессию+владение. Хранилище — `node:sqlite` (db/db.ts).
 */
// Конфиг игры — ЕДИНАЯ СЕРВЕРНАЯ ИСТИНА: встроенные дефолты (data/*.json в бандле shared)
// + персистентные оверрайды редактора (SQLite `config_overrides`). Клиент и редактор берут
// эффективный конфиг через GET /api/config, правки редактора идут в POST /api/dev/config.
const config = new ConfigRegistry();

/** Накатывает сохранённые оверрайды поверх дефолтов (устойчиво к невалидным — пропускает). */
function applyConfigOverrides(): void {
  for (const [key, value] of Object.entries(getConfigOverrides())) {
    try {
      config.reload({ [key]: value });
    } catch (e) {
      console.warn(`[dm-server] пропущен невалидный оверрайд конфига "${key}": ${e instanceof Error ? e.message : e}`);
    }
  }
}
/** Полная пересборка живого конфига: дефолты + персистентные оверрайды (комнаты держат ссылку). */
function rebuildConfig(): void {
  config.loadAll();
  applyConfigOverrides();
}
rebuildConfig(); // старт: дефолты + сохранённые правки редактора

// Рестарт сервера = чистый лист забегов: сбрасываем все НЕЗАВЕРШЁННЫЕ забеги (save.run) у всех персонажей.
// Иначе спуск из города РЕЗЮМИТ старый забег (со старым биомом/сидом) и игнорит выбор алтаря — «хвосты».
{ const wiped = clearAllRuns(); if (wiped) console.log(`[dm-server] сброшено незавершённых забегов: ${wiped}`); }

// Посев авторского 3D-контента поз-редактора при пустой БД (свежий/сброшенный сервер) — чтобы анимации
// были из коробки. Источник — pose-seed.json в git; на проде поз-редактор выключен, иначе контента бы не было.
{ const seeded = seedPoseStoreIfEmpty(); if (seeded) console.log(`[dm-server] pose_store засеян из pose-seed.json: ${seeded} ключей`); }

const MAX_CHARS = 5;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'dm-server', version: '0.1.0' });
});

// ── Конфиг игры (единая истина: сервер) ─────────────────────────────────────────
// GET отдаёт АКТУАЛЬНЫЙ эффективный конфиг (дефолты + сохранённые правки) — его грузят
// и клиент (вью/тултипы), и редактор (показывает реальные значения). Одна истина везде.
app.get('/api/config', (_req, res) => {
  if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-store');   // DEV: конфиг всегда свежий (модели/текстуры/объекты)
  res.json(config.snapshot());
});

// Правки редактора: валидируем → ПЕРСИСТИМ в SQLite → пересобираем живой конфиг. Переживает
// рестарт сервера. balance действует сразу, статы монстров/лут — со следующего этажа.
// АНТИ-ЧИТ: запись только вне продакшена — иначе клиент мог бы переписать баланс сервера.
const DEV_CONFIG_APPLY = process.env.NODE_ENV !== 'production';
app.post('/api/dev/config', (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Правка конфига отключена в продакшене' });
  const overrides = (req.body ?? {}) as Record<string, unknown>;
  try {
    const trial = new ConfigRegistry(); // валидация ДО записи в БД (на временном реестре)
    trial.loadAll();
    trial.reload(overrides); // бросит при мусоре/неизвестном ключе
  } catch (e) {
    return res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
  for (const [key, value] of Object.entries(overrides)) setConfigOverride(key, value);
  rebuildConfig();
  console.log(`[dm-server] конфиг сохранён из редактора: ${Object.keys(overrides).join(', ') || '—'}`);
  res.json({ ok: true, applied: Object.keys(overrides) });
});

// «Применить везде»: пишет правку прямо в ФАЙЛ-источник (data/*.json) → попадёт в git и на деплой.
// Дополнительно ставит оверрайд в БД, чтобы живой конфиг остался верным (не откатился на дефолт,
// импортированный в память при старте — файл перечитается лишь при рестарте процесса). DEV-only.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'src', 'config', 'data');
const configFileFor = (key: string): string => join(DATA_DIR, key.replace(/\./g, '-') + '.json');
app.post('/api/dev/config-file', (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Правка конфига отключена в продакшене' });
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
      setConfigOverride(key, value); // живой конфиг остаётся верным независимо от импортов в памяти
      written.push(key);
    }
  } catch (e) {
    return res.status(500).json({ error: `Не удалось записать файл: ${e instanceof Error ? e.message : String(e)}` });
  }
  rebuildConfig();
  console.log(`[dm-server] конфиг записан в ФАЙЛ (+БД): ${written.join(', ') || '—'}`);
  res.json({ ok: true, written });
});

// Сброс ключа к встроенному дефолту (удаляет персистентный оверрайд).
app.delete('/api/dev/config/:key', (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Правка конфига отключена в продакшене' });
  deleteConfigOverride(req.params.key);
  rebuildConfig();
  console.log(`[dm-server] конфиг сброшен к дефолту: ${req.params.key}`);
  res.json({ ok: true, reset: req.params.key });
});

// ── Контент 3D поз-редактора (единая истина: сервер) ─────────────────────────────
// GET — весь авторский контент (pe_gait/clips/sway/phys/ragdoll/chars); грузят и редактор, и игра
// (кэшируют в localStorage). POST — правки редактора, DEV-only (в проде клиент не переписывает контент).
app.get('/api/pose', (_req, res) => {
  res.json(getPoseStore());
});
// Ревизии без тел: редактор зовёт их на каждой загрузке, чтобы понять, ушёл ли сервер вперёд.
app.get('/api/pose/rev', (_req, res) => {
  res.json(getPoseRevs());
});
/**
 * Публикация рабочей копии редактора. `__baseRev` — ревизии, НА КОТОРЫХ основана присланная копия.
 * Если на сервере ключ новее, вся публикация отклоняется (409) и НИЧЕГО не пишется.
 *
 * ⚠ Зачем замок: тело шлётся ключом ЦЕЛИКОМ (`pe_clips` = вся библиотека), поэтому вкладка, открытая со
 * старым снимком, одним сохранением затирала всё, что появилось позже, — так пропал клип `hit_axe`.
 * Без `__baseRev` (старые клиенты, ручной curl) поведение прежнее: пишем как есть.
 */
app.post('/api/dev/pose', (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Правка контента отключена в продакшене' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const baseRev = body.__baseRev as Record<string, number> | undefined;
  const keys = Object.keys(body).filter((k) => k !== '__baseRev');
  if (baseRev) {
    const cur = getPoseRevs();
    const conflicts = keys.filter((k) => (cur[k] ?? 0) > (baseRev[k] ?? 0));
    if (conflicts.length) {
      console.log(`[dm-server] публикация отклонена (на сервере новее): ${conflicts.join(', ')}`);
      return res.status(409).json({ error: 'На сервере более новая версия', conflicts, rev: cur });
    }
  }
  const rev: Record<string, number> = {};
  for (const k of keys) rev[k] = setPoseStore(k, body[k]);
  res.json({ ok: true, saved: keys, rev });
});
app.delete('/api/dev/pose/:key', (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Правка контента отключена в продакшене' });
  deletePoseStore(req.params.key);
  res.json({ ok: true, deleted: req.params.key });
});

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
app.post('/api/dev/assets/:id', express.raw({ type: Object.keys(ASSET_EXT), limit: '64mb' }), (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Отключено в продакшене' });
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
});

// ── Dev: загрузка РЕАЛЬНЫХ сейвов в калькулятор/сим баланса (без auth, только не в проде) ──
app.get('/api/dev/characters', (_req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Отключено в продакшене' });
  res.json({ characters: listAllCharacters() });
});
app.get('/api/dev/characters/:charId', (req, res) => {
  if (!DEV_CONFIG_APPLY) return res.status(403).json({ error: 'Отключено в продакшене' });
  const ch = getCharacter(req.params.charId);
  if (!ch) return res.status(404).json({ error: 'Персонаж не найден' });
  res.json({ save: ch.data });
});

// ── Хелперы ────────────────────────────────────────────────────────────────────
function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m ? m[1]! : null;
}
/** userId по токену из заголовка; иначе шлёт 401 и возвращает null. */
function requireAuth(req: Request, res: Response): string | null {
  const token = bearer(req);
  const userId = token ? getSession(token) : null;
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
app.post('/api/register', (req, res) => {
  // Ф0.5: без лимита один скрипт кладёт сервер регистрациями — каждая это scrypt (~100 мс CPU
  // и десятки мегабайт). Ключ — IP; заголовок прокси учитывается, если он есть.
  const ip = clientIp(req.headers, req.socket.remoteAddress);
  if (!limits.register.take(ip)) {
    res.setHeader('Retry-After', String(limits.register.retryAfterSec(ip)));
    return res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
  }
  const creds = validCreds(req.body);
  if (!creds) return res.status(422).json({ error: 'Ник 3–20 символов, пароль от 6' });
  if (getUserByName(creds.username)) return res.status(409).json({ error: 'Ник уже занят' });
  const { hash, salt } = hashPassword(creds.password);
  const userId = createUser(creds.username, hash, salt);
  res.json({ token: createSession(userId), userId, username: creds.username });
});

app.post('/api/login', (req, res) => {
  // Ф0.5: тот же scrypt плюс защита от перебора пароля. Успешный вход обнуляет счётчик —
  // человек, промахнувшийся пару раз, не должен потом ждать.
  const ip = clientIp(req.headers, req.socket.remoteAddress);
  if (!limits.login.take(ip)) {
    res.setHeader('Retry-After', String(limits.login.retryAfterSec(ip)));
    return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже' });
  }
  const creds = validCreds(req.body);
  if (!creds) return res.status(422).json({ error: 'Неверные данные' });
  const user = getUserByName(creds.username);
  if (!user || !verifyPassword(creds.password, user.passHash, user.passSalt)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  limits.login.reset(ip);
  res.json({ token: createSession(user.id), userId: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = bearer(req);
  if (token) deleteSession(token);
  res.json({ ok: true });
});

// ── Персонажи (принадлежат пользователю) ───────────────────────────────────────
app.get('/api/characters', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  res.json({ characters: listCharacters(userId) });
});

app.post('/api/characters', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const b = req.body as { classId?: unknown; name?: unknown };
  const classId = typeof b?.classId === 'string' ? b.classId : '';
  const name = (typeof b?.name === 'string' ? b.name : '').trim();
  if (!name || name.length > 16) return res.status(422).json({ error: 'Имя 1–16 символов' });
  if (!config.get('classes').some((c) => c.id === classId && c.enabled !== false)) return res.status(422).json({ error: 'Неизвестный или отключённый класс' });
  if (countCharacters(userId) >= MAX_CHARS) return res.status(409).json({ error: `Лимит ${MAX_CHARS} персонажей` });
  const charId = randomUUID();
  const save = newCharacterSave(config, classId, name, charId); // авторитетный стартовый сейв
  createCharacter(charId, userId, save);
  res.json({ character: { charId, name: save.name, classId: save.classId, level: save.level } });
});

app.delete('/api/characters/:charId', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const ch = getCharacter(req.params.charId);
  if (!ch || ch.userId !== userId) return res.status(404).json({ error: 'Персонаж не найден' });
  deleteCharacter(req.params.charId, userId);
  res.json({ ok: true });
});

// ── Статика клиента (прод: ОДИН сервер отдаёт игру + /api + /ws на одном домене) ──────────
// Регистрируется ПОСЛЕ всех /api-роутов, поэтому их не затирает; WS — на upgrade `/ws`, отдельно.
// Клиент сам находит сервер на том же origin (`/api`, `wss://<host>/ws`), доп. конфиг не нужен.
const CLIENT_DIST = process.env.CLIENT_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(join(CLIENT_DIST, 'index.html'))) {
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

const PORT = Number(process.env.PORT ?? 3001);
const server = createServer(app);
// Выключаем алгоритм Нейгла на КАЖДОМ TCP-соединении (HTTP + апгрейд WS идут по этим же сокетам):
// иначе мелкие реалтайм-пакеты (ввод/снапшоты) склеиваются и ждут до ~40мс, что складывается с пингом.
server.on('connection', (socket) => socket.setNoDelay(true));
attachWsServer(server, config); // авторитетный кооп на /ws (комнаты = GameSession)
// EADDRINUSE устойчиво: при dev-рестарте старый инстанс может ещё держать порт — НЕ роняем процесс необработанной
// ошибкой (иначе сервер умирает и редактор/клиент ловят ECONNREFUSED), а ждём освобождения и повторяем listen.
let listenTries = 0;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenTries < 10) {
    listenTries++;
    console.warn(`[dm-server] порт ${PORT} занят (рестарт dev?) — повтор #${listenTries} через 500мс…`);
    setTimeout(() => server.listen(PORT), 500);
  } else {
    console.error('[dm-server] фатальная ошибка сервера:', err);
    process.exit(1);
  }
});
server.listen(PORT, () => {
  listenTries = 0;
  console.log(`[dm-server] слушает http://localhost:${PORT}`);
});
