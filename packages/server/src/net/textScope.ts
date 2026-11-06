import { AsyncLocalStorage } from 'node:async_hooks';
import { localeLangs, localizerFor, setTextObserver, setTextProvider, type CmdCode, type Lang, type Locales, type Localizer } from '@dm/shared';

/**
 * ⭐⭐ i18n Ф1 (06.11): ОБЛАСТЬ ЯЗЫКА ИГРОКА НА СЕРВЕРЕ. Сервер шлёт игроку весь текст (виды, отказы команд, итоги, сообщения входа), и
 * собирает его ОБЩИМ кодом shared (`tr` / `trn` / `cfgText`), который языка параметром не берёт: язык — это текущая область. Здесь она
 * живёт в `AsyncLocalStorage`, поэтому переживает `await` — транзакция команды ждёт базу (`withAccount`), отвечает после записи
 * (`later`), — и итог приходит на языке того, кто прислал команду, а не того, чей кадр исполнялся последним.
 *
 * ⚠ Ставится ОДИН раз на процесс (`installTextScope`, зовётся при загрузке модуля): shared остаётся браузерно-безопасным — асинхронная
 * область есть только у сервера. Без области (тик, рассылка, загрузка) — язык-источник: русский, ровно как раньше.
 * ⚠ Язык-источник не заводит `Localizer` вовсе (`localizerFor` → `null`): горячий путь русского игрока стоит одного объекта области.
 */
interface Scope {
  /** Разрешитель языка игрока; `null` — язык-источник. */
  readonly loc: Localizer | null;
  /** ⭐ Коды выданных в области фраз (текст → код) — `cmdResult.code`: отказ узнаётся по ключу фразы, а не по её переводу. */
  readonly codes?: Map<string, string>;
}

const store = new AsyncLocalStorage<Scope>();
/** Область языка-источника без журнала кодов — одна на процесс. */
const SOURCE_SCOPE: Scope = Object.freeze({ loc: null });

/**
 * ⭐ КОДЫ ОТКАЗОВ ПО КЛЮЧУ ФРАЗЫ (`cmdResult.code`, словарь — `CmdCode` в `netTypes.ts`). Клиент решает по причине отказа (перечитать конфиг
 * на «Цена изменилась…» — `DmClient`, `App.syncConfig`), и сравнение ТЕКСТА сломалось бы на первом же переводе. Ключ фразы — стабильный id
 * текста, поэтому код выводится из него: все фразы согласия (`srv:consent.*` — цена, сырьё, выход, конфиг, сборка) — `priceChanged`, где
 * бы их ни выдал код (ядро `townActions`, обмен, сторож комнаты); прочие — по таблице.
 */
const CODE_OF_KEY: Readonly<Record<string, CmdCode>> = {
  'srv:room.tooOften': 'rateLimited',
  'srv:room.duplicate': 'duplicate',
  'srv:room.badCommand': 'invalid',
  'srv:room.townOnly': 'townOnly',
  'srv:room.stationFar': 'stationFar',
  'srv:room.frozen': 'frozen',
  'srv:room.noCharacter': 'noCharacter',
  'srv:room.serverError': 'serverError',
  'srv:room.saveFailed': 'serverError',
  'srv:room.stockRenewed': 'stockRenewed',
  'srv:room.boardRenewed': 'boardRenewed',
  'srv:room.craftClosed': 'craftClosed',
};
export function codeOfTextKey(key: string): CmdCode | undefined {
  return key.startsWith('srv:consent.') ? 'priceChanged' : CODE_OF_KEY[key];
}

let installed = false;
/** Ставит провайдера области и наблюдателя кодов в shared — один раз на процесс. */
export function installTextScope(): void {
  if (installed) return;
  installed = true;
  setTextProvider(() => store.getStore()?.loc ?? null);
  setTextObserver((key, text) => {
    const codes = store.getStore()?.codes;
    if (!codes) return;
    const code = codeOfTextKey(key);
    if (code !== undefined) codes.set(text, code);
  });
}
installTextScope();

/**
 * `fn` — на языке `lang` (только включённый язык таблицы; прочее и `undefined` — источник). Область переживает `await` внутри `fn`.
 * `codes` — журнал кодов фраз этой области (команда города: `codeOf` по нему после исполнения).
 */
export function inTextLang<T>(locales: Locales | undefined, lang: Lang | undefined, fn: () => T, codes?: Map<string, string>): T {
  const loc = localizerFor(locales, lang);
  return store.run(loc === null && codes === undefined ? SOURCE_SCOPE : { loc, ...(codes ? { codes } : {}) }, fn);
}

/**
 * ⭐ i18n Ф1 (ревизия 06.11): `fn` — ВНЕ области языка (язык-источник, без журнала кодов), и всё, что она заводит (таймеры, промисы), —
 * тоже. Для долгоживущих цепочек процесса: планировщик тиков заводит свою цепочку `setTimeout` там, где его разбудили (вход игрока,
 * реконнект — область языка игрока), и без этого ВСЕ тики всех комнат шли бы на его языке и с журналом кодов его команды.
 */
export function outsideTextScope<T>(fn: () => T): T {
  return store.exit(fn);
}

/** Код фразы `text`, выданной в текущей области (журнал `codes` области; нет журнала или фразы — `undefined`). */
export function scopeCodeOf(text: string | undefined): string | undefined {
  return text === undefined ? undefined : store.getStore()?.codes?.get(text);
}

/** То, что нужно от HTTP-запроса, чтобы выбрать язык ответа (express `Request` подходит). */
export interface LangRequest { body?: unknown; query?: unknown; headers: Readonly<Record<string, string | string[] | undefined>> }

/**
 * ⭐ ЯЗЫК HTTP-ОТВЕТА (вход, регистрация, ростер, маршрут гейтвея): явное поле `lang` (тело или строка запроса) → заголовок
 * `Accept-Language` → язык-источник. Только ВКЛЮЧЁННЫЕ языки `locales`: невключённый явный язык — как его нет (дальше заголовок).
 */
export function requestLang(req: LangRequest, locales: Locales | undefined): Lang | undefined {
  const enabled = localeLangs(locales, { enabledOnly: true });
  if (!enabled.length) return undefined;
  for (const v of [(req.body as { lang?: unknown } | null | undefined)?.lang, (req.query as { lang?: unknown } | null | undefined)?.lang]) {
    if (typeof v === 'string' && enabled.includes(v.toLowerCase())) return v.toLowerCase();
  }
  const h = req.headers['accept-language'];
  return langFromAcceptLanguage(Array.isArray(h) ? h.join(',') : h, enabled);
}

/**
 * Обработчик маршрута — в области языка запроса (`requestLang`). Область переживает `await` обработчика: отказы базы, лимитов и разбора
 * тела (`parseCreds`) уходят на языке игрока. `locales` — лениво: таблица живого конфига (перезагрузка — новая).
 */
export function withRequestLang<Q extends LangRequest, S, N>(
  locales: () => Locales | undefined, handler: (req: Q, res: S, next: N) => unknown,
): (req: Q, res: S, next: N) => unknown {
  return (req, res, next) => {
    let table: Locales | undefined;
    try { table = locales(); } catch { table = undefined; }
    return inTextLang(table, requestLang(req, table), () => handler(req, res, next));
  };
}

/**
 * Первый поддерживаемый язык из заголовка `Accept-Language` (`en-US,en;q=0.9,ru;q=0.8`) среди `enabled`; нет — `undefined` (источник).
 * Вес `q` уважается, регион отбрасывается до основы (`en-US` → `en`), если сам он не включён.
 */
export function langFromAcceptLanguage(header: string | undefined, enabled: readonly Lang[]): Lang | undefined {
  if (!header || !enabled.length) return undefined;
  const asked = header.split(',').slice(0, 16).map((part, i) => {
    const [tag, ...rest] = part.trim().split(';');
    const q = rest.map((r) => /^\s*q=([0-9.]+)\s*$/.exec(r)).find((m) => m)?.[1];
    return { tag: (tag ?? '').trim().toLowerCase(), q: q === undefined ? 1 : Number(q), i };
  }).filter((a) => a.tag && a.tag !== '*' && Number.isFinite(a.q) && a.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const a of asked) {
    if (enabled.includes(a.tag)) return a.tag;
    const base = a.tag.split('-')[0]!;
    if (enabled.includes(base)) return base;
  }
  return undefined;
}
