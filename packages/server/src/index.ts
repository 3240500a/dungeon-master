import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { ConfigRegistry, newCharacterSave } from '@dm/shared';
import { hashPassword, verifyPassword } from './auth/password.js';
import {
  createUser, getUserByName, createSession, deleteSession, getSession,
  listCharacters, getCharacter, putCharacter, deleteCharacter, countCharacters,
  getConfigOverrides, setConfigOverride, deleteConfigOverride,
} from './db/db.js';
import { attachWsServer } from './net/wsServer.js';

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
  const creds = validCreds(req.body);
  if (!creds) return res.status(422).json({ error: 'Ник 3–20 символов, пароль от 6' });
  if (getUserByName(creds.username)) return res.status(409).json({ error: 'Ник уже занят' });
  const { hash, salt } = hashPassword(creds.password);
  const userId = createUser(creds.username, hash, salt);
  res.json({ token: createSession(userId), userId, username: creds.username });
});

app.post('/api/login', (req, res) => {
  const creds = validCreds(req.body);
  if (!creds) return res.status(422).json({ error: 'Неверные данные' });
  const user = getUserByName(creds.username);
  if (!user || !verifyPassword(creds.password, user.passHash, user.passSalt)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
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
  if (!config.get('classes').some((c) => c.id === classId)) return res.status(422).json({ error: 'Неизвестный класс' });
  if (countCharacters(userId) >= MAX_CHARS) return res.status(409).json({ error: `Лимит ${MAX_CHARS} персонажей` });
  const charId = randomUUID();
  const save = newCharacterSave(config, classId, name, charId); // авторитетный стартовый сейв
  putCharacter(charId, userId, save);
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
server.listen(PORT, () => {
  console.log(`[dm-server] слушает http://localhost:${PORT}`);
});
