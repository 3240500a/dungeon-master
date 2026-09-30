import { ConfigRegistry, configRev, defaultConfigData } from '@dm/shared';
import type { ChannelIo, ChannelReply } from './configChannel.js';

/**
 * ⭐ R22-08: СЕРВЕР ДЛЯ ПРОВЕРОК КАНАЛА ЗАПИСИ РЕДАКТОРА — настоящий: живой конфиг (`server/configLive.ts` → `configCandidate.ts`) и настоящие
 * ручки записи (`server/net/configRoutes.ts`: «Применить на сервере», «Применить везде», «Сбросить к дефолту» — проба, 409 по базе, 422 правила
 * поверх таблиц). Express подменён таблицей маршрутов (без сокетов): запрос редактора — прямо в обработчики ручек, ответ — их `res.json`.
 * База оверрайдов — карта в памяти, файлы на диске — карта поверх основы (`files` — файлы данных этой сборки). Импорт сервера — с путём из
 * переменной: пакет редактора не тянет сервер в свою проверку типов. Только для тестов.
 */
export type Tables = Record<string, unknown>;

/** Живой конфиг сервера — то, что тесту от него нужно. */
export interface LiveApi {
  rebuild(): Promise<void>;
  noteFile(key: string, value: unknown): void;
  trial(changes: Tables, opts?: { files?: boolean }): Promise<string | null>;
  fileMatches(key: string, disk: unknown): boolean;
}

export interface ServerRig {
  /** Живой реестр сервера (тело `/api/config`). */
  config: ConfigRegistry;
  live: LiveApi;
  /** Оверрайды в базе (ключ → сырое значение). */
  rows: Map<string, unknown>;
  /** Файлы на диске, записанные после старта (ключ → разобранный JSON); нет ключа — файл сборки (`files`). */
  disk: Map<string, unknown>;
  /** Запрос к инструментальной ручке — как `devFetch` редактора. */
  send: ChannelIo['send'];
  /** `GET /api/config` — снимок живого конфига (JSON); `failReads` вперёд — «сервер перезапускается». */
  read: ChannelIo['read'];
  failReads: number;
  /** Последний ответ ручки: статус и тело запроса (что прислал редактор). */
  last: { status: number; body: Tables | undefined } | null;
  /** Другая вкладка редактора (инструмент, другая машина) пишет таблицу поверх живого — база этого редактора устаревает. */
  otherTab(key: string, value: unknown): Promise<number>;
  /** Инциденты и приведения сборки (что сервер сказал вслух). */
  said: string[];
}

type Handler = (req: { body?: unknown; params: Record<string, string> }, res: FakeRes, next: () => void) => void;
interface FakeRes { headersSent: boolean; status(n: number): FakeRes; json(b: unknown): FakeRes }

/** `files` — файлы данных сборки (основа сервера); по умолчанию — встроенные. */
export async function serverRig(files: Tables = defaultConfigData): Promise<ServerRig> {
  const LIVE = '../../server/src/configLive.js';
  const ROUTES = '../../server/src/net/configRoutes.js';
  const { liveConfig } = (await import(/* @vite-ignore */ LIVE)) as { liveConfig: (deps: unknown) => LiveApi };
  const { installConfigWrites } = (await import(/* @vite-ignore */ ROUTES)) as { installConfigWrites: (app: unknown, deps: unknown) => void };
  const config = new ConfigRegistry();
  const rows = new Map<string, unknown>();
  const disk = new Map<string, unknown>();
  const said: string[] = [];
  const live = liveConfig({
    config,
    readOverrides: async () => Object.fromEntries([...rows].map(([k, v]) => [k, structuredClone(v)])),
    deleteOverride: async (k: string) => { rows.delete(k); },
    changed: () => undefined,
    log: () => undefined,
    warn: (s: string) => { said.push(s); },
    incident: (s: string) => { said.push(s); },
  });
  // Файлы этой сборки, отличные от встроенных, — «на диске после старта» (основа сервера — импорт старта + они).
  for (const [k, v] of Object.entries(files)) if (v !== defaultConfigData[k]) { live.noteFile(k, v); disk.set(k, structuredClone(v)); }
  await live.rebuild();

  const routes: { method: string; path: string; handlers: Handler[] }[] = [];
  const app = {
    post: (path: string, ...handlers: Handler[]) => { routes.push({ method: 'POST', path, handlers }); },
    delete: (path: string, ...handlers: Handler[]) => { routes.push({ method: 'DELETE', path, handlers }); },
  };
  const pass: Handler = (_req, _res, next) => { next(); };
  const onDisk = (k: string): unknown => structuredClone(disk.has(k) ? disk.get(k) : files[k]);
  installConfigWrites(app, {
    config, live, gate: pass, json: pass, guard: async () => true,
    setOverride: async (k: string, v: unknown) => { rows.delete(k); rows.set(k, structuredClone(v)); },
    deleteOverride: async (k: string) => { rows.delete(k); },
    writeFile: (k: string, v: unknown) => { disk.set(k, structuredClone(v)); },
    readFile: onDisk,
  });

  const rig: ServerRig = {
    config, live, rows, disk, said, failReads: 0, last: null,
    send: (url, init) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body) as Tables;
      let route = routes.find((r) => r.method === init.method && r.path === url);
      const params: Record<string, string> = {};
      if (!route && init.method === 'DELETE' && url.startsWith('/api/dev/config/')) {
        route = routes.find((r) => r.method === 'DELETE' && r.path === '/api/dev/config/:key');
        params.key = decodeURIComponent(url.slice('/api/dev/config/'.length));
      }
      if (!route) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      const handlers = route.handlers;
      return new Promise<ChannelReply>((resolve) => {
        let code = 200;
        const res: FakeRes = {
          headersSent: false,
          status(n) { code = n; return res; },
          json(b) {
            res.headersSent = true;
            rig.last = { status: code, body };
            const copy = JSON.parse(JSON.stringify(b)) as unknown;
            resolve({ ok: code >= 200 && code < 300, status: code, json: async () => copy });
            return res;
          },
        };
        let i = 0;
        const next = (): void => { const h = handlers[i++]; if (h) h({ body: body === undefined ? undefined : structuredClone(body), params }, res, next); };
        next();
      });
    },
    read: async () => {
      if (rig.failReads > 0) { rig.failReads--; throw new Error('сервер перезапускается'); }
      return JSON.parse(JSON.stringify(config.snapshot())) as Tables;
    },
    otherTab: async (key, value) => {
      const r = await rig.send('/api/dev/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value, __baseRev: { [key]: configRev(config.get(key as never)) } }),
      });
      return r.status;
    },
  };
  return rig;
}

/** Таблица, как её разберёт схема сервера (сравнение «одно и то же»). */
export function sameTable(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
