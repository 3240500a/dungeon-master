import express, { type Express, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { ah } from './asyncRoute.js';
import { isSha, type BlobStore } from '../content/blobStore.js';
import type { ChannelChange, ChannelPointer, ClientsInput, PromoteInput, ReleaseList, RollbackInput } from '../content/releaseDb.js';
import type { CutResult } from '../content/releaseCutter.js';
import { SIGN_ALG, SIGN_PREFIX, type ContentSigner } from '../content/contentSign.js';
import {
  ADMIN_CHANNELS, AUTO_CHANNEL, CHANNEL_RE, CLIENT_BUILD_MAX, ChannelOpError, clientGate, parseCount, parsePercent, pickRelease,
} from '../content/channelRules.js';
import { missingFiles, type GcReport } from '../content/contentGc.js';

/**
 * ⭐ 08.10 (Д1): РАЗДАЧА РЕЛИЗОВ КОНТЕНТА (план «Обновление контента без пересборки клиента»).
 *
 *  • `GET /api/content/pointer?channel=dev&abi=1&build=N&id=…` — УКАЗАТЕЛЬ: номер релиза канала и хэш его манифеста, порядка сотни
 *    байт, с ETag и без кэша (`no-cache`). Клиент сравнивает хэш с сохранённым: совпал — запуск без скачиваний. Чужая ABI — 409 с ABI
 *    сервера; релиза ещё нет (сервер только поднялся) — 503 и «повтори».
 *  • `GET /c/b/<2>/<sha256>` — ФАЙЛ ПО ХЭШУ: имя = содержимое, поэтому `immutable` на год (у клиента — свой кэш на диске). Понимает
 *    gzip — отдаём сжатую копию (`Content-Encoding: gzip`); клиент сверяет sha256 распакованного.
 *  • `POST /api/dev/content/release` — нарезать релиз сейчас (разработчику и тестам; обычно режет сам нарезчик после правки).
 *
 * ⭐ 08.10 (Д3): КАНАЛЫ, РАСКАТКА, ПОДПИСЬ.
 *  • Указатель выбирает релиз устройству (`id` — стабильный хэш устройства/аккаунта): корзина `sha256(id|channel|seq)` меньше процента —
 *    новый, иначе прежний; без `id` — новый только при 100% (`content/channelRules.ts`). Поля `minClient`/`latestClient` и флаги
 *    `clientRequired` (build < minClient — экран «Обновите игру», ответ всё равно 200) и `clientOutdated`. Подпись `sig` — Ed25519 строки
 *    `dmcontent:v1|abi|seq|manifest|channel` (`content/contentSign.ts`), `keyId` — каким ключом.
 *  • Канала нет: `dev` — 503; `beta`/`live` — указатель `dev` (с `channel: "dev"`), ТОЛЬКО если разрешён запасной путь (`devFallback`:
 *    вне продакшена или `DM_CONTENT_DEV_FALLBACK=1`); иначе 404 «канал не выпущен» — на проде dev молча не подсовывается.
 *  • `GET /api/content/pubkey` — открытый ключ подписи (стенду и деплою; клиент верит только своим зашитым ключам).
 *  • Ручки администратора `/api/admin/content/*` — роль `admin` или `DM_ADMIN_KEY`, И НА ПРОДЕ (отдельная дверь плана: продвижение
 *    готового релиза, не правка в обход): список релизов, выпуск в `beta`/`live` (с процентом), откат, версии клиента, уборка хранилища.
 *    Канал `dev` кнопкой не трогается — он сам. Каждое действие и отказ — строка в лог сервера.
 *
 * Вынесено из `index.ts`, чтобы стоять под тестом за настоящим express (как `contentRoutes.ts`).
 */
export interface ReleaseAdminDeps {
  /** Роль администратора или ключ процессов — и на проде. Отказ — ответ уже отправлен (`null`); иначе — кто (для лога и базы). */
  guard(req: Request, res: Response): Promise<string | null>;
  list(o: { abi?: number; limit?: number }): Promise<ReleaseList>;
  promote(i: PromoteInput): Promise<ChannelChange>;
  rollback(i: RollbackInput): Promise<ChannelChange>;
  clients(i: ClientsInput): Promise<ChannelChange>;
  gc(o: { dryRun: boolean; keepReleases: number; minAgeMs: number }): Promise<GcReport>;
  log(msg: string): void;
}

export interface ReleaseRoutesDeps {
  store: BlobStore;
  /** Указатель канала (`releaseDb.channelPointer`). */
  pointer(channel: string, abi: number): Promise<ChannelPointer | null>;
  abi: number;
  /** Базы адресов файлов (`<база>b/<2>/<sha>`): пока — свой сервер. */
  cdn: readonly string[];
  /** ⭐ Д3: ключ подписи указателя. */
  /** Подписант указателя; null — продакшен без боевого ключа: указатель без подписи (выпускные клиенты его отвергнут). */
  signer: ContentSigner | null;
  /** ⭐ Д3: канал без указателя получает указатель `dev` (вне продакшена); нет — 404. */
  devFallback: boolean;
  /** Ручка разработчика: охрана (`devGuard`) и нарезка. Нет — ручки нет. */
  dev?: { guard(req: Request, res: Response): Promise<boolean>; cutNow(): Promise<CutResult> };
  /** ⭐ Д3: ручки администратора. Нет — ручек нет. */
  admin?: ReleaseAdminDeps;
  /** Часы кэша указателя (тесты). */
  now?(): number;
}

/** Сколько указатель отдаётся из памяти, мс: дёшево и для сотен запусков в секунду, а новый релиз виден почти сразу. */
export const POINTER_CACHE_MS = 1_000;
/** ⭐ Д3: `id` устройства — печатный ASCII до 128 знаков (клиент шлёт хэш, а не сам идентификатор). */
const DEVICE_ID_RE = /^[\x21-\x7e]{1,128}$/;
/** ⭐ Д3: подписи указателей в памяти: строк мало (канал × релиз), а подпись — десятки микросекунд на запрос. */
const SIG_CACHE_MAX = 256;
/** ⭐ Д3: уборка: умолчания и нижние пределы (раньше суток — не убираем: ломаются откат и старые клиенты). */
const GC_KEEP_DEFAULT = 20;
const GC_AGE_DAYS_DEFAULT = 14;
const GC_AGE_DAYS_MIN = 1;
const DAY_MS = 86_400_000;

export interface ReleaseRoutes { invalidate(): void }

const qs = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function installReleaseRoutes(app: Express, deps: ReleaseRoutesDeps): ReleaseRoutes {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: ChannelPointer | null }>();
  async function rowOf(channel: string, abi: number): Promise<ChannelPointer | null> {
    const key = `${channel}|${abi}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < POINTER_CACHE_MS) return hit.value;
    const value = await deps.pointer(channel, abi);
    cache.set(key, { at: now(), value });
    return value;
  }
  /** Указатель канала; `unreleased` — канала нет, а запасной путь к `dev` закрыт. */
  async function pointerOf(channel: string, abi: number): Promise<ChannelPointer | null | 'unreleased'> {
    const p = await rowOf(channel, abi);
    if (p || channel === AUTO_CHANNEL) return p;
    if (!deps.devFallback) return 'unreleased';
    return rowOf(AUTO_CHANNEL, abi);
  }
  const sigs = new Map<string, string>();
  function signOf(abi: number, seq: number, manifest: string, channel: string): string | undefined {
    if (!deps.signer) return undefined;   // прод без боевого ключа — указатель без подписи
    const key = `${abi}|${seq}|${manifest}|${channel}`;
    let sig = sigs.get(key);
    if (!sig) {
      if (sigs.size >= SIG_CACHE_MAX) sigs.clear();
      sig = deps.signer.sign(abi, seq, manifest, channel);
      sigs.set(key, sig);
    }
    return sig;
  }

  app.get('/api/content/pointer', ah(async (req, res) => {
    const channel = qs(req.query.channel) ?? AUTO_CHANNEL;
    if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'канал' });
    const abiQ = qs(req.query.abi) !== undefined ? Number(req.query.abi) : deps.abi;
    if (!Number.isInteger(abiQ)) return res.status(400).json({ error: 'abi' });
    const buildQ = qs(req.query.build);
    const build = buildQ === undefined ? 0 : /^\d{1,15}$/.test(buildQ) ? Number(buildQ) : NaN;
    if (!Number.isSafeInteger(build)) return res.status(400).json({ error: 'build' });
    const id = qs(req.query.id);
    if (id !== undefined && !DEVICE_ID_RE.test(id)) return res.status(400).json({ error: 'id' });
    res.setHeader('Cache-Control', 'no-cache');
    if (abiQ !== deps.abi) return res.status(409).json({ error: 'abi', abi: deps.abi });
    const p = await pointerOf(channel, abiQ);
    if (p === 'unreleased') return res.status(404).json({ error: 'канал не выпущен', channel });
    if (!p) { res.setHeader('Retry-After', '2'); return res.status(503).json({ error: 'релиза контента ещё нет' }); }
    const pick = pickRelease(p, p.channel, id);
    const gate = clientGate(build, p.minClient, p.latestClient);
    const text = JSON.stringify({
      seq: pick.seq, manifest: pick.manifest, manifestSize: pick.manifestSize, abi: abiQ, channel: p.channel,
      cdn: deps.cdn, minClient: p.minClient, latestClient: p.latestClient,
      build, clientRequired: gate.required, clientOutdated: gate.outdated, rollout: p.rollout,
      ...(deps.signer ? { sig: signOf(abiQ, pick.seq, pick.manifest, p.channel), sigAlg: SIGN_ALG, keyId: deps.signer.keyId } : {}),
    });
    // ETag — от всего ответа: он зависит и от корзины устройства, и от флагов версии клиента
    const etag = `"${createHash('sha256').update(text).digest('base64url').slice(0, 27)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type('application/json').send(text);
  }));

  app.get('/api/content/pubkey', (_req, res) => {
    const s = deps.signer;
    res.setHeader('Cache-Control', 'no-cache');
    if (!s) return res.status(404).json({ error: 'ключ подписи не задан (DM_CONTENT_SIGN_KEY_FILE)' });
    res.json({ alg: SIGN_ALG, keyId: s.keyId, publicKey: s.publicKey, pem: s.publicPem, dev: s.dev, format: `${SIGN_PREFIX}|<abi>|<seq>|<manifest>|<channel>` });
  });

  app.get('/c/b/:p/:sha', (req, res) => {
    const { p, sha } = req.params;
    if (!isSha(sha) || p !== sha.slice(0, 2)) return res.status(400).json({ error: 'адрес файла' });
    if (!deps.store.has(sha)) return res.status(404).json({ error: 'нет файла' });
    const etag = `"${sha}"`;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? deps.store.gzPathOf(sha) : null;
    const path = gz ?? deps.store.pathOf(sha);
    let size: number;
    try { size = statSync(path).size; } catch { return res.status(404).json({ error: 'нет файла' }); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    if (gz) res.setHeader('Content-Encoding', 'gzip');
    const s = createReadStream(path);
    s.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    s.pipe(res);
  });

  if (deps.dev) {
    const dev = deps.dev;
    app.post('/api/dev/content/release', ah(async (req, res) => {
      if (!await dev.guard(req, res)) return;
      const r = await dev.cutNow();
      cache.clear();
      res.json(r);
    }));
  }

  if (deps.admin) installAdmin(app, deps, deps.admin, () => cache.clear());

  return { invalidate: () => cache.clear() };
}

/** Тело ручки администратора: объект JSON (16 КБ хватает с запасом — прокси на этом пути и так режет на 16 КБ). */
const adminJson = express.json({ limit: '16kb' });
const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

/** Канал выпуска из тела: `beta`/`live`; `dev` — отдельной строкой (он меняется сам). */
function adminChannel(v: unknown): string | ChannelOpError {
  if (v === AUTO_CHANNEL) return new ChannelOpError(400, `канал ${AUTO_CHANNEL} меняется сам, на каждой нарезке — кнопкой его не трогаем`);
  if (typeof v !== 'string' || !ADMIN_CHANNELS.includes(v)) return new ChannelOpError(400, `канал — один из: ${ADMIN_CHANNELS.join(', ')}`);
  return v;
}

const describeChange = (r: ChannelChange): string => {
  const was = r.was ? `было #${r.was.seq} на ${r.was.rollout}%${r.was.prev !== null ? `, прежний #${r.was.prev}` : ''}` : 'канал выпущен впервые';
  return `#${r.seq}${r.reissued ? ` (перевыпуск содержимого #${r.origin})` : ''} на ${r.rollout}%${r.prev !== null ? `, прежний #${r.prev}` : ''}; ${was}`;
};

function installAdmin(app: Express, deps: ReleaseRoutesDeps, admin: ReleaseAdminDeps, invalidate: () => void): void {
  const verify = (manifest: string): string[] => missingFiles(deps.store, manifest);
  /** Действие администратора: охрана → разбор → действие; отказ правилом — его код и строка (и в лог), прочее — 500 через `ah`. */
  const action = (what: string, run: (body: Record<string, unknown>, actor: string) => Promise<{ log: string; reply: unknown; changed: boolean }>) =>
    ah(async (req, res) => {
      const actor = await admin.guard(req, res);
      if (!actor) return;
      try {
        const r = await run(bodyOf(req), actor);
        if (r.changed) invalidate();
        admin.log(`${what}: ${r.log} — ${actor}`);
        res.setHeader('Cache-Control', 'no-store');
        res.json(r.reply);
      } catch (e) {
        if (!(e instanceof ChannelOpError)) throw e;
        admin.log(`${what}: отказ ${e.status} — ${e.message} — ${actor}`);
        res.status(e.status).json({ error: e.message, ...e.extra });
      }
    });

  app.get('/api/admin/content/releases', ah(async (req, res) => {
    if (!await admin.guard(req, res)) return;
    const abiQ = qs(req.query.abi);
    const abi = abiQ === undefined ? undefined : Number(abiQ);
    if (abi !== undefined && !Number.isInteger(abi)) return res.status(400).json({ error: 'abi' });
    const limitQ = qs(req.query.limit);
    const limit = limitQ === undefined ? undefined : Number(limitQ);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) return res.status(400).json({ error: 'limit 1..500' });
    const list = await admin.list({ abi, limit });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ abi: deps.abi, keyId: deps.signer?.keyId ?? null, devKey: deps.signer?.dev ?? false, devFallback: deps.devFallback, ...list });
  }));

  app.post('/api/admin/content/promote', adminJson, action('выпуск', async (b, actor) => {
    const channel = adminChannel(b.channel);
    if (channel instanceof ChannelOpError) throw channel;
    const seq = parseCount(b.seq);
    if (seq === null || seq < 1) throw new ChannelOpError(400, 'seq — номер релиза');
    const percent = b.percent === undefined ? undefined : parsePercent(b.percent);
    if (percent === null) throw new ChannelOpError(400, 'percent — целое 0..100');
    const r = await admin.promote({ channel, seq, percent, actor, verify });
    return { log: `${channel} ← #${seq}${percent !== undefined ? ` на ${percent}%` : ''}: ${r.changed ? describeChange(r) : 'без изменений'}`, reply: r, changed: r.changed };
  }));

  app.post('/api/admin/content/rollback', adminJson, action('откат', async (b, actor) => {
    const channel = adminChannel(b.channel);
    if (channel instanceof ChannelOpError) throw channel;
    const abi = b.abi === undefined ? deps.abi : parseCount(b.abi);
    if (abi === null) throw new ChannelOpError(400, 'abi');
    const toSeq = b.toSeq === undefined ? undefined : parseCount(b.toSeq);
    if (toSeq === null || toSeq === 0) throw new ChannelOpError(400, 'toSeq — номер релиза');
    const r = await admin.rollback({ channel, abi, toSeq, actor, verify });
    return { log: `${channel}: ${describeChange(r)}`, reply: r, changed: r.changed };
  }));

  app.post('/api/admin/content/clients', adminJson, action('версии клиента', async (b, actor) => {
    const channel = typeof b.channel === 'string' && CHANNEL_RE.test(b.channel) ? b.channel : null;
    if (!channel) throw new ChannelOpError(400, 'канал');
    const abi = b.abi === undefined ? deps.abi : parseCount(b.abi);
    if (abi === null) throw new ChannelOpError(400, 'abi');
    const build = (v: unknown, name: string): number | undefined => {
      if (v === undefined) return undefined;
      const n = parseCount(v);
      if (n === null || n > CLIENT_BUILD_MAX) throw new ChannelOpError(400, `${name} — целое 0..${CLIENT_BUILD_MAX}`);
      return n;
    };
    const minClient = build(b.minClient, 'minClient');
    const latestClient = build(b.latestClient, 'latestClient');
    const r = await admin.clients({ channel, abi, minClient, latestClient, actor });
    return { log: `${channel} (ABI ${abi}): minClient ${r.minClient}, latestClient ${r.latestClient}${r.changed ? '' : ' (без изменений)'}`, reply: r, changed: r.changed };
  }));

  app.post('/api/admin/content/gc', adminJson, action('уборка хранилища', async (b, actor) => {
    void actor;
    if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw new ChannelOpError(400, 'dryRun — true/false');
    const dryRun = b.dryRun !== false;
    const keepReleases = b.keepReleases === undefined ? GC_KEEP_DEFAULT : parseCount(b.keepReleases);
    if (keepReleases === null || keepReleases < 1 || keepReleases > 10_000) throw new ChannelOpError(400, 'keepReleases — целое 1..10000');
    const days = b.minAgeDays === undefined ? GC_AGE_DAYS_DEFAULT : b.minAgeDays;
    if (typeof days !== 'number' || !Number.isFinite(days) || days < GC_AGE_DAYS_MIN) throw new ChannelOpError(400, `minAgeDays — число не меньше ${GC_AGE_DAYS_MIN}`);
    const r = await admin.gc({ dryRun, keepReleases, minAgeMs: days * DAY_MS });
    return {
      log: `${dryRun ? 'сухой прогон' : 'УДАЛЕНИЕ'} (держим ${keepReleases} релизов, срок ${days} сут): ${r.removed} файлов, ${(r.bytes / 1024 / 1024).toFixed(1)} МБ, обрывков ${r.parts}, молодых ${r.young}, держимых ${r.kept}`,
      reply: { ...r, keepReleases, minAgeDays: days }, changed: false,
    };
  }));
}
