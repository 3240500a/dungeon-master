import type { Request, Response, RequestHandler, ErrorRequestHandler } from 'express';

/**
 * Express 4 не ловит отказ промиса из обработчика: необработанный `reject` уронил бы процесс.
 * Все обработчики, ходящие в базу (Ф2 — доступ асинхронный), оборачиваются этим.
 * ⭐ R11-11: отказ — в лог через глушитель (`warnHttp`), а не стеком на каждый запрос: пока база лежит (переключение, потолок пула),
 * анонимный поток входов, выходов и чтений поз писал по стеку на запрос — тот же поток в лог, что R1-10…R7-05 глушили у кадров.
 */
export type RouteParams = Record<string, string>;
export const ah = <P extends RouteParams = RouteParams>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>,
): RequestHandler<P> => (req, res) => {
  void fn(req as Request<P>, res).catch((e: unknown) => {
    warnHttp(e, 'отказ в обработчике');
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' });
  });
};

/**
 * ⭐ R7-05: ЗНАЧЕНИЕ СТРОКИ ЗАПРОСА — ТОЛЬКО СТРОКОЙ. Разборщик express по умолчанию (`qs`, «extended») строит из `?x[toString]=1`
 * объект `{ toString: '1' }`, а из `?x=a&x=b` — массив; `String()` на таком объекте бросает (`toString` не функция), и ручка
 * отвечала 500 со стеком в лог на каждый анонимный запрос. Строка — как есть, нет значения — пусто, прочее — `undefined`
 * (не строка: отказ 400 или «как не прислано» — решает ручка).
 */
export function queryText(v: unknown): string | undefined {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : undefined;
}

/**
 * Лог ошибок HTTP (дошедших до `httpErrors`, отказов `ah` и `devGate` — R11-11) — не чаще раза в 10 с (как `warnFrame` у кадров):
 * поток таких не топит лог. `what` — что за ошибка (в строку лога).
 */
let httpWarnAt = 0;
let httpWarnMuted = 0;
export function warnHttp(e: unknown, what = 'ошибка запроса'): void {
  const now = Date.now();
  if (now - httpWarnAt < 10_000) { httpWarnMuted++; return; }
  const muted = httpWarnMuted ? ` (и ещё ${httpWarnMuted} с прошлого сообщения)` : '';
  httpWarnAt = now; httpWarnMuted = 0;
  console.error(`[dm-server] ${what}${muted}:`, e);
}

/**
 * ⭐ R6-21: ОШИБКИ EXPRESS — ОТВЕТОМ, А НЕ СТЕКОМ В ЛОГ. Своего обработчика ошибок не было: кривой JSON в теле (`{`) отдавал
 * разборщик тела обработчику express по умолчанию, а тот пишет стек в лог на КАЖДЫЙ запрос (и в продакшене) — анонимно, до
 * любого лимита: тот же поток в лог, что R1-10, R2-01, R3-14 и R4-21 глушили у кадров WebSocket и `/api/route`. Ошибка
 * клиента (кривой JSON, тело больше потолка — статус 4xx) — ответ JSON без лога; прочее — 500 и строка в лог через
 * глушитель. Ставится ПОСЛЕДНИМ, после всех ручек.
 */
export const httpErrors: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) { next(err); return; }
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = Number(e?.status ?? e?.statusCode);
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? 'Слишком большое тело запроса' : 'Неверный запрос' });
    return;
  }
  warnHttp(err);
  res.status(500).json({ error: 'Внутренняя ошибка' });
};
