import { z } from 'zod';

/**
 * ⭐ 08.10 (Д3, план «Обновление контента без пересборки клиента»): МОДЕЛЬ ВКЛАДКИ «📦 ВЫПУСКИ» — чистая, без DOM (под node-тесты).
 *
 * Вкладка — кнопки к ручкам администратора сервера `/api/admin/content/*` (`server/src/net/releaseRoutes.ts`): список релизов и каналов,
 * выпуск в `beta`/`live` (с процентом), откат, версии клиента. Здесь — всё, кроме DOM:
 *  • разбор ответов сервера (zod) и ошибки — понятным текстом (`errorText`);
 *  • модель страницы: каналы dev / beta / live с текущим и прежним релизом, список релизов с метками каналов;
 *  • ПЛАН действия (`planPromote` / `planRollback` / `planClients`): тело запроса, текст подтверждения «что произойдёт» и ожидаемый итог.
 *    План повторяет правила сервера (`server/src/content/releaseDb.ts`), чтобы подтверждение говорило правду про ЭТОТ случай (первый
 *    выпуск, подъём процента, новое содержимое, перевыпуск), а заведомый отказ не доходил до окна подтверждения. Судит всё равно сервер:
 *    список мог устареть (выпустили с другой машины) — тогда отказ сервера приходит его же текстом. Совпадение плана с сервером стережёт
 *    `releasesServer.test.ts` (настоящие ручки и база `dungeon_test`).
 *
 * Канал `dev` — только просмотр: он переключается сам на каждой нарезке (решение владельца), кнопок у него нет.
 */

export const AUTO_CHANNEL = 'dev';
export const ADMIN_CHANNELS = ['beta', 'live'] as const;
export type AdminChannel = typeof ADMIN_CHANNELS[number];
/** Каналы, которые вкладка показывает всегда (даже не выпущенные) — в этом порядке. */
export const SHOWN_CHANNELS: readonly string[] = [AUTO_CHANNEL, ...ADMIN_CHANNELS];
/** Потолок номера сборки клиента (колонки `integer` на сервере). */
export const CLIENT_BUILD_MAX = 2_147_483_647;
/** Сколько последних релизов просить (сервер добавит каждый, на который смотрит канал). */
export const LIST_LIMIT = 100;

export const URLS = {
  list: '/api/admin/content/releases',
  promote: '/api/admin/content/promote',
  rollback: '/api/admin/content/rollback',
  clients: '/api/admin/content/clients',
} as const;

// ── Ответы сервера ───────────────────────────────────────────────────────────────────────────────
const int = z.number().int();
const nat = int.nonnegative();
const pct = int.min(0).max(100);
const ChannelRefZ = z.object({ channel: z.string(), as: z.enum(['current', 'prev']), percent: pct });
const ReleaseZ = z.object({
  seq: int.positive(), abi: int, manifest: z.string(), manifestSize: nat, configRev: z.string(), gameRev: z.string(),
  created: z.number(), note: z.string(), origin: int.positive().nullable(), channels: z.array(ChannelRefZ),
});
const ChannelZ = z.object({
  channel: z.string(), abi: int, seq: int.positive(), prev: int.positive().nullable(), rollout: pct,
  minClient: nat, latestClient: nat, updated: z.number(), updatedBy: z.string(), auto: z.boolean(),
});
const ListZ = z.object({
  abi: int, keyId: z.string(), devKey: z.boolean(), devFallback: z.boolean(), releases: z.array(ReleaseZ), channels: z.array(ChannelZ),
});
const ChangeZ = z.object({
  channel: z.string(), abi: int, seq: int.positive(), rollout: pct, prev: int.positive().nullable(), minClient: nat, latestClient: nat,
  reissued: z.boolean(), origin: int.positive(), changed: z.boolean(),
  was: z.object({ seq: int.positive(), rollout: pct, prev: int.positive().nullable() }).nullable(),
});

export type Release = z.infer<typeof ReleaseZ>;
export type ListedChannel = z.infer<typeof ChannelZ>;
export type ReleaseList = z.infer<typeof ListZ>;
export type ChannelChange = z.infer<typeof ChangeZ>;

/** Ответ сервера: код и разобранное тело (не JSON — `undefined`). Код 0 — запрос не дошёл (сеть, сервер не поднят). */
export interface Reply { status: number; body: unknown }
/** Отправка запроса — на странице `devFetch` (токен админа и повтор входа на 401), в тесте — `fetch` к стенду. */
export type Send = (url: string, init?: RequestInit) => Promise<Response>;

export async function request(send: Send, url: string, init?: RequestInit): Promise<Reply> {
  let res: Response;
  try { res = await send(url, init); } catch { return { status: 0, body: undefined }; }
  const text = await res.text().catch(() => '');
  let body: unknown;
  try { body = text ? JSON.parse(text) as unknown : undefined; } catch { body = undefined; }
  return { status: res.status, body };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Хэш коротко: 10 знаков хватает отличить релизы глазами. */
export const short = (sha: string): string => sha.slice(0, 10);

/** Хвост отказа «у релиза нет файлов»: какие именно (коротко). */
function missingTail(b: Record<string, unknown>): string {
  if (!Array.isArray(b.missing) || !b.missing.length) return '';
  const list = b.missing.filter((s): s is string => typeof s === 'string');
  const count = typeof b.count === 'number' ? b.count : list.length;
  const shown = list.slice(0, 3).map(short).join(', ');
  return ` Нет в хранилище: ${shown}${count > 3 ? ` и ещё ${count - 3}` : ''} — нарезка не дописала файлы или их убрала уборка.`;
}

/** Отказ сервера — строкой для человека. `what` — что пытались сделать («Выпуск в live»). */
export function errorText(r: Reply, what: string): string {
  const b = isObj(r.body) ? r.body : {};
  const msg = typeof b.error === 'string' ? b.error : '';
  if (r.status === 0) return `${what}: сервер не отвечает — он запущен? (редактор ходит на /api через прокси Vite, адрес — DM_API)`;
  if (r.status === 401) return `${what}: нужен вход администратора — сессия истекла или вход отменён. Войди и повтори.`;
  if (r.status === 403) return `${what}: у этого входа нет прав администратора${msg ? ` («${msg}»)` : ''} — выпуск контента только для роли admin или ключа DM_ADMIN_KEY.`;
  if (r.status === 404 && !msg) return `${what}: сервер не знает ручек выпуска (/api/admin/content) — он собран до Д3? Перезапусти сервер.`;
  if (r.status === 413) return `${what}: сервер отверг тело запроса как слишком большое.`;
  if (r.status === 429) return `${what}: слишком много запросов — подожди немного и повтори.`;
  if (r.status >= 500) return `${what}: ошибка сервера (${r.status})${msg ? ` — ${msg}` : ''}. Подробности — в логе сервера, строки «[dm-server] [content]».`;
  if (msg) return `${what}: сервер отказал (${r.status}) — ${msg}.${missingTail(b)}`;
  return `${what}: неожиданный ответ сервера (${r.status}).`;
}

/** Итог запроса: значение или отказ строкой для человека. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Разбор ответа по схеме; 200, но не по форме — сервер и редактор разных версий. */
function parseOk<T>(r: Reply, schema: z.ZodType<T>, what: string): Result<T> {
  if (r.status !== 200) return { ok: false, error: errorText(r, what) };
  const p = schema.safeParse(r.body);
  if (p.success) return { ok: true, value: p.data };
  const where = p.error.issues[0]?.path.join('.') || 'тело';
  return { ok: false, error: `${what}: ответ сервера не по форме (${where}) — редактор и сервер разных версий? Перезапусти сервер или обнови страницу.` };
}

export const parseList = (r: Reply): Result<ReleaseList> => parseOk(r, ListZ, 'Список релизов');
export const parseChange = (r: Reply, what: string): Result<ChannelChange> => parseOk(r, ChangeZ, what);

export async function loadList(send: Send, limit = LIST_LIMIT): Promise<Result<ReleaseList>> {
  return parseList(await request(send, `${URLS.list}?limit=${limit}`));
}

// ── Модель страницы ──────────────────────────────────────────────────────────────────────────────
export interface ChannelView {
  name: string;
  /** `dev` — меняется сам, кнопок нет. */
  auto: boolean;
  /** Состояние канала; `null` — канал (на этой ABI) ещё не выпущен. */
  state: ListedChannel | null;
  /** Релиз, который канал раздаёт (`state.seq`), и прежний (`state.prev`) — из списка. */
  current?: Release;
  previous?: Release;
}

export interface PageModel {
  /** ABI сервера (её раздаёт указатель по умолчанию) и выбранная во вкладке. */
  serverAbi: number;
  abi: number;
  abis: number[];
  keyId: string;
  devKey: boolean;
  devFallback: boolean;
  channels: ChannelView[];
  /** Релизы выбранной ABI, номер вниз. */
  releases: Release[];
  bySeq: Map<number, Release>;
  /** Наибольший номер в списке (всех ABI): перевыпуск получит номер больше. */
  maxSeq: number;
}

export function buildModel(list: ReleaseList, abi: number = list.abi): PageModel {
  const abis = [...new Set([list.abi, ...list.releases.map((r) => r.abi), ...list.channels.map((c) => c.abi)])].sort((a, b) => a - b);
  const releases = list.releases.filter((r) => r.abi === abi).sort((a, b) => b.seq - a.seq);
  const bySeq = new Map(list.releases.map((r) => [r.seq, r]));
  const mine = list.channels.filter((c) => c.abi === abi);
  const names = [...SHOWN_CHANNELS, ...mine.map((c) => c.channel).filter((n) => !SHOWN_CHANNELS.includes(n)).sort()];
  const channels = names.map((name): ChannelView => {
    const state = mine.find((c) => c.channel === name) ?? null;
    return {
      name, auto: name === AUTO_CHANNEL || (state?.auto ?? false), state,
      current: state ? bySeq.get(state.seq) : undefined,
      previous: state && state.prev !== null ? bySeq.get(state.prev) : undefined,
    };
  });
  const maxSeq = list.releases.reduce((m, r) => Math.max(m, r.seq), 0);
  return { serverAbi: list.abi, abi, abis, keyId: list.keyId, devKey: list.devKey, devFallback: list.devFallback, channels, releases, bySeq, maxSeq };
}

export const channelOf = (m: PageModel, name: string): ChannelView | undefined => m.channels.find((c) => c.name === name);
/** Чьё содержимое несёт релиз: у перевыпуска — исходный номер. */
export const originOf = (r: Release): number => r.origin ?? r.seq;

const pad = (n: number): string => String(n).padStart(2, '0');
/** «08.10.2026 14:05» — местное время. */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Релиз одной строкой для подтверждений: номер, дата, хэш, чьё содержимое. */
export function releaseLine(r: Release): string {
  return `#${r.seq} (от ${fmtTime(r.created)}, манифест ${short(r.manifest)}${r.origin !== null ? `, содержимое #${r.origin}` : ''})`;
}

export interface Badge { text: string; kind: 'current' | 'rollout' | 'prev' | 'target' }

/** Метки каналов у строки релиза: «live», «live 10%», «live · прежний 90%», «live · цель отката» (у dev — просто «прежний»: кнопки отката нет). */
export function badgesOf(r: Release): Badge[] {
  const order = (n: string): number => { const i = SHOWN_CHANNELS.indexOf(n); return i < 0 ? 99 : i; };
  return [...r.channels].sort((a, b) => order(a.channel) - order(b.channel) || (a.as === 'current' ? -1 : 1)).map((c): Badge => {
    if (c.as === 'current') return c.percent >= 100 ? { text: c.channel, kind: 'current' } : { text: `${c.channel} ${c.percent}%`, kind: 'rollout' };
    if (c.percent > 0) return { text: `${c.channel} · прежний ${c.percent}%`, kind: 'prev' };
    return c.channel === AUTO_CHANNEL ? { text: `${c.channel} · прежний`, kind: 'target' } : { text: `${c.channel} · цель отката`, kind: 'target' };
  });
}

/** Раскатка канала словами. */
export function rolloutText(c: ChannelView): string {
  const s = c.state;
  if (!s) return '—';
  if (s.rollout >= 100 || s.prev === null) return `100% на #${s.seq}`;
  return `${s.rollout}% на #${s.seq}, ${100 - s.rollout}% на #${s.prev}`;
}

export const clientText = (n: number): string => (n > 0 ? `сборка ${n}` : 'не задан');

/** Кто менял канал: нарезчик, ключ процессов или администратор (id аккаунта). */
export function actorText(by: string): string {
  if (by === 'cutter') return 'нарезчик (сам)';
  if (by === 'key') return 'ключ DM_ADMIN_KEY';
  return by ? `админ ${by.length > 12 ? `${by.slice(0, 8)}…` : by}` : '—';
}

// ── План действия ────────────────────────────────────────────────────────────────────────────────
/** Ожидаемый итог (поля `ChannelChange`): `seq: 'new'` — перевыпуск под новым номером (больше всех прежних). */
export interface Expect {
  seq: number | 'new';
  rollout: number;
  prev: number | null;
  reissued: boolean;
  origin: number;
  minClient?: number;
  latestClient?: number;
}

export type Plan =
  | { ok: true; what: string; url: string; body: Record<string, unknown>; confirm: string; expect: Expect }
  /** `noop` — так уже есть, слать нечего (сервер ответил бы «без изменений»). */
  | { ok: false; what: string; error: string; noop?: boolean };

const isAdmin = (c: string): c is AdminChannel => (ADMIN_CHANNELS as readonly string[]).includes(c);
const refuse = (what: string, error: string, noop = false): Plan => ({ ok: false, what, error, ...(noop ? { noop: true } : {}) });

/** Процент из поля: целое 1..100 (0% выпуском не задаётся — «никому» это не выпуск). */
export function parsePercentInput(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}

/** Номер сборки клиента из поля: целое 0..CLIENT_BUILD_MAX (пусто — 0, «не задан»). */
export function parseBuildInput(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n <= CLIENT_BUILD_MAX ? n : null;
}

/**
 * «В бету» / «Выпустить»: релиз `seq` → канал на `percent`%. Правила — как у сервера (`promoteRelease`):
 *  • канал не выпущен — только 100%;
 *  • то же содержимое (манифест), что у канала, — меняется только процент и только вверх;
 *  • новое содержимое — только когда прежняя раскатка доведена до 100%; релиз не новее текущего — перевыпуск под новым номером.
 */
export function planPromote(m: PageModel, channel: string, seq: number, percent: number): Plan {
  const what = channel === 'beta' ? 'В бету' : `Выпуск в ${channel}`;
  if (!isAdmin(channel)) return refuse(what, channel === AUTO_CHANNEL ? 'канал dev меняется сам, на каждой нарезке — кнопкой его не трогаем' : `канал — один из: ${ADMIN_CHANNELS.join(', ')}`);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return refuse(what, 'процент раскатки — целое от 1 до 100');
  const rel = m.bySeq.get(seq);
  if (!rel) return refuse(what, `релиза #${seq} нет в списке — обнови список`);
  if (rel.abi !== m.abi) return refuse(what, `релиз #${seq} другой ABI (${rel.abi}), а вкладка показывает ABI ${m.abi}`);
  const ch = channelOf(m, channel)!;
  const cur = ch.state;
  const body = { channel, seq, percent };
  const origin = originOf(rel);

  if (!cur) {
    if (percent < 100) return refuse(what, `канал ${channel} ещё не выпущен — первый выпуск только на 100%: тем, кто вне процента, давать нечего`);
    const lines = [
      `Выпустить ${releaseLine(rel)} в ${channel} — канал выпускается впервые.`,
      '',
      `Что будет: все клиенты ${channel} (100%) получат это содержимое.`,
      ...(channel === 'live' ? betaWarning(m, rel) : []),
    ];
    return { ok: true, what, url: URLS.promote, body, confirm: lines.join('\n'), expect: { seq: rel.seq, rollout: 100, prev: null, reissued: false, origin } };
  }

  const curRel = ch.current;
  const curOrigin = curRel ? originOf(curRel) : cur.seq;
  if (curRel && curRel.manifest === rel.manifest) {
    if (percent < cur.rollout) return refuse(what, `процент раскатки только растёт (${cur.rollout}% → ${percent}%) — вернуть прежний релиз: «Откатить»`);
    if (percent === cur.rollout) return refuse(what, `${channel} уже раздаёт это содержимое (#${cur.seq}) на ${cur.rollout}% — менять нечего`, true);
    const expect: Expect = { seq: cur.seq, rollout: percent, prev: cur.prev, reissued: false, origin: curOrigin };
    const rest = cur.prev !== null ? `#${cur.prev}` : 'прежнем';
    const lines = [
      `Поднять раскатку #${cur.seq} в ${channel}: ${cur.rollout}% → ${percent}%.`,
      ...(rel.seq !== cur.seq ? [`(#${rel.seq} несёт то же содержимое, что #${cur.seq}, — меняется только процент.)`] : []),
      '',
      percent >= 100
        ? `Что будет: все клиенты ${channel} получат #${cur.seq}.${cur.prev !== null ? ` #${cur.prev} останется прежним — к нему вернёт «Откатить».` : ''}`
        : `Что будет: #${cur.seq} получат ~${percent}% устройств (было ~${cur.rollout}%), остальные ~${100 - percent}% остаются на ${rest}.`,
      'Попавшие в раскатку раньше остаются на новом. Опустить процент потом нельзя — только «Откатить».',
    ];
    return { ok: true, what, url: URLS.promote, body, confirm: lines.join('\n'), expect };
  }

  if (cur.rollout < 100) {
    return refuse(what, `в ${channel} идёт раскатка #${cur.seq} (${cur.rollout}%) — доведи её до 100% или откати, потом выпускай другой релиз`);
  }
  const reissued = rel.seq <= cur.seq;
  const expect: Expect = { seq: reissued ? 'new' : rel.seq, rollout: percent, prev: cur.seq, reissued, origin };
  const lines = [
    percent >= 100 ? `Выпустить ${releaseLine(rel)} в ${channel} для всех (100%).` : `Выпустить ${releaseLine(rel)} в ${channel} на ${percent}%.`,
    '',
    `Сейчас в ${channel}: #${cur.seq}${curOrigin !== cur.seq ? ` (содержимое #${curOrigin})` : ''}, 100%.`,
    percent >= 100
      ? `Что будет: все клиенты ${channel} получат новое содержимое; #${cur.seq} станет прежним — к нему вернёт «Откатить».`
      : `Что будет: новое содержимое получат ~${percent}% устройств (по корзине устройства), остальные ~${100 - percent}% остаются на #${cur.seq}. `
        + `Дальше процент можно только поднимать (та же кнопка с бо́льшим процентом); вернуть всех на #${cur.seq} — «Откатить».`,
    ...(reissued ? [`#${rel.seq} не новее текущего #${cur.seq} — сервер перевыпустит его содержимое под новым номером (больше #${m.maxSeq}): номер канала у клиента только растёт.`] : []),
    ...(channel === 'live' ? betaWarning(m, rel) : []),
  ];
  return { ok: true, what, url: URLS.promote, body, confirm: lines.join('\n'), expect };
}

/** Порядок владельца — dev → beta → live: выпуск в live содержимого, которого нет в бете, — с предупреждением. */
function betaWarning(m: PageModel, rel: Release): string[] {
  const beta = channelOf(m, 'beta');
  if (!beta?.state) return ['', '⚠ beta ещё не выпущен — этот релиз в бете не проверялся.'];
  if (beta.current && beta.current.manifest !== rel.manifest) {
    return ['', `⚠ В beta сейчас другое содержимое (#${beta.state.seq}) — этот релиз в бете не стоит.`];
  }
  return [];
}

/**
 * Куда «Откатить»: по умолчанию — прежний релиз канала; прежнего нет (после отката он снят) — только явный выбор (`toSeq`).
 * Правила — как у сервера (`rollbackChannel`): канал выпущен, цель — другое содержимое той же ABI; итог — 100%, без прежнего, номер
 * больше всех (перевыпуск), если цель не новее текущего.
 */
export function planRollback(m: PageModel, channel: string, toSeq?: number): Plan {
  const what = `Откат ${channel}`;
  if (!isAdmin(channel)) return refuse(what, channel === AUTO_CHANNEL ? 'канал dev меняется сам, на каждой нарезке — кнопкой его не трогаем' : `канал — один из: ${ADMIN_CHANNELS.join(', ')}`);
  const ch = channelOf(m, channel)!;
  const cur = ch.state;
  if (!cur) return refuse(what, `канал ${channel} не выпущен — откатывать нечего`);
  const target = toSeq ?? cur.prev;
  if (target === null || target === undefined) {
    return refuse(what, `у ${channel} нет прежнего релиза (откат его снимает) — выбери в списке релиз, к которому вернуться, и нажми «Откатить к выбранному»`);
  }
  const rel = m.bySeq.get(target);
  if (!rel) return refuse(what, `релиза #${target} нет в списке — обнови список`);
  if (rel.abi !== m.abi) return refuse(what, `релиз #${target} другой ABI (${rel.abi}, канал — ${m.abi})`);
  if (ch.current && ch.current.manifest === rel.manifest) return refuse(what, `${channel} уже на содержимом #${originOf(rel)} — откатывать некуда`);
  // как сервер (releaseDb.rollbackChannel): откат — только к содержимому старше текущего (по исходному номеру); новее — это выпуск
  const curOrigin = ch.current ? originOf(ch.current) : cur.seq;
  if (originOf(rel) > curOrigin) return refuse(what, `откат только назад: содержимое #${originOf(rel)} новее текущего #${curOrigin} — для нового содержимого «Выпустить»`);
  const reissued = rel.seq <= cur.seq;
  const origin = originOf(rel);
  const body: Record<string, unknown> = { channel, abi: m.abi, ...(toSeq !== undefined ? { toSeq } : {}) };
  const now = cur.rollout < 100 && cur.prev !== null ? `#${cur.seq} на ${cur.rollout}%, прежний #${cur.prev}` : `#${cur.seq} на 100%${cur.prev !== null ? `, прежний #${cur.prev}` : ''}`;
  const lines = [
    `Откатить ${channel} к ${releaseLine(rel)}.`,
    '',
    `Сейчас в ${channel}: ${now}.`,
    reissued
      ? `Что будет: все клиенты ${channel} (100%) вернутся на содержимое #${origin} под НОВЫМ номером (больше #${m.maxSeq}) — клиент, уже взявший #${cur.seq}, примет откат, а подставной старый указатель отвергнет.`
      : `Что будет: все клиенты ${channel} (100%) получат #${rel.seq}.`,
    `${cur.rollout < 100 ? 'Идущая раскатка снимается. ' : ''}Прежнего релиза у канала после отката не будет: повторный «Откатить» не вернёт #${cur.seq} — только выпуском заново.`,
  ];
  return { ok: true, what, url: URLS.rollback, body, confirm: lines.join('\n'), expect: { seq: reissued ? 'new' : rel.seq, rollout: 100, prev: null, reissued, origin } };
}

/**
 * Версии клиента канала: `minClient` — ниже экран «Обновите игру» (вход закрыт), `latestClient` — ниже плашка «Доступно обновление».
 * 0 — не задано. Сервер разрешает это и на `dev` (стенд экрана обновления), вкладка — нет: dev здесь только просмотр.
 */
export function planClients(m: PageModel, channel: string, minText: string, latestText: string): Plan {
  const what = `Версии клиента ${channel}`;
  if (!isAdmin(channel)) return refuse(what, channel === AUTO_CHANNEL ? 'dev во вкладке — только просмотр' : `канал — один из: ${ADMIN_CHANNELS.join(', ')}`);
  const ch = channelOf(m, channel)!;
  const cur = ch.state;
  if (!cur) return refuse(what, `канал ${channel} не выпущен — версии клиента задаются выпущенному каналу`);
  const min = parseBuildInput(minText);
  if (min === null) return refuse(what, `minClient — целое от 0 до ${CLIENT_BUILD_MAX} (0 — не задан)`);
  const latest = parseBuildInput(latestText);
  if (latest === null) return refuse(what, `latestClient — целое от 0 до ${CLIENT_BUILD_MAX} (0 — не задан)`);
  if (latest > 0 && min > latest) return refuse(what, `minClient (${min}) выше latestClient (${latest}) — так не бывает: обязательная сборка не может быть новее последней`);
  if (min === cur.minClient && latest === cur.latestClient) return refuse(what, `${channel}: minClient ${min}, latestClient ${latest} — так уже стоит`, true);
  const lines = [`Версии клиента в ${channel} (ABI ${m.abi}):`];
  if (min !== cur.minClient) {
    lines.push(min > 0
      ? `• minClient ${cur.minClient} → ${min}: сборки ниже ${min} увидят экран «Обновите игру» и не войдут в игру.`
      : `• minClient ${cur.minClient} → 0: экран «Обновите игру» снимается — входят любые сборки.`);
  }
  if (latest !== cur.latestClient) {
    lines.push(latest > 0
      ? `• latestClient ${cur.latestClient} → ${latest}: сборки ниже ${latest} увидят плашку «Доступно обновление» (играть можно).`
      : `• latestClient ${cur.latestClient} → 0: плашка «Доступно обновление» снимается.`);
  }
  if (min > cur.minClient) lines.push('', `⚠ Поднимай minClient, только когда Steam уже раздал сборку ${min}, — иначе игроки застрянут на «обновитесь».`);
  const origin = ch.current ? originOf(ch.current) : cur.seq;
  return {
    ok: true, what, url: URLS.clients, body: { channel, abi: m.abi, minClient: min, latestClient: latest }, confirm: lines.join('\n'),
    expect: { seq: cur.seq, rollout: cur.rollout, prev: cur.prev, reissued: false, origin, minClient: min, latestClient: latest },
  };
}

/** Итог действия словами — в строку статуса вкладки. */
export function describeChange(c: ChannelChange, clients = false): string {
  if (clients) return `${c.channel}: minClient ${c.minClient}, latestClient ${c.latestClient}${c.changed ? '' : ' — без изменений'}.`;
  const now = `#${c.seq} на ${c.rollout}%${c.prev !== null ? `, прежний #${c.prev}` : ''}`;
  if (!c.changed) return `${c.channel}: без изменений (${now}).`;
  const was = c.was ? `было #${c.was.seq} на ${c.was.rollout}%${c.was.prev !== null ? `, прежний #${c.was.prev}` : ''}` : 'канал выпущен впервые';
  return `${c.channel}: ${now} — ${was}.${c.reissued ? ` Номер #${c.seq} — перевыпуск содержимого #${c.origin}.` : ''}`;
}

/** Выполнить план: POST с телом плана; ответ — разобранный итог или отказ текстом. */
export async function runPlan(send: Send, plan: Extract<Plan, { ok: true }>): Promise<{ ok: true; value: ChannelChange; text: string } | { ok: false; error: string }> {
  const r = await request(send, plan.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan.body) });
  const p = parseChange(r, plan.what);
  if (!p.ok) return p;
  return { ok: true, value: p.value, text: describeChange(p.value, plan.url === URLS.clients) };
}
