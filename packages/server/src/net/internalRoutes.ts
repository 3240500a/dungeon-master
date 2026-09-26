import type { Express, Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { localCaller, keyMatches } from './adminAccess.js';

/** R5-24: короче этого ключ чтения метрик не включается — подобрать его перебором проще, чем кажется. */
const METRICS_KEY_MIN = 16;

/**
 * ⭐ R4-27: СЛИВ ПРОЦЕССА ПО КОМАНДЕ — через его обработчики SIGTERM (`installNodeShutdown`, `installShutdown`: дописать
 * сейвы, снять ноду из реестра, выйти), а не сигналом. Раньше ручка звала `process.kill(self, 'SIGTERM')`, а на Windows
 * Node завершает процесс сразу, не вызывая ни одного обработчика: ни записи сейвов, ни прощальных копий, ни снятия ноды
 * (закрепления держали вернувшихся до таймаута живости) — а ручка и существует потому, что на Windows сигналов нет.
 * Обработчиков нет (роль без слива) — сигнал, как прежде.
 */
export function drainProcess(): void {
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM' as never);
  else process.kill(process.pid, 'SIGTERM');
}

/**
 * ⭐ R5-01: ПОСЛЕДНИЙ РУБЕЖ — НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ НАЧИНАЕТ ОБЫЧНЫЙ СЛИВ, а не обрывает процесс. Раньше обработчика не
 * было вовсе: бросок из нативного колбэка uWS (кривой HTTP-запрос к прокси) — выход с кодом 1, и все комнаты ноды умирали
 * вместе с несохранённым прогрессом и прощальными записями в полёте. Продолжать работу после такого исключения нельзя
 * (состояние могло остаться полуизменённым), поэтому процесс уходит — но СЛИВОМ: сейвы дописаны, нода снята из реестра.
 * Слив начинается один раз; повторные исключения — только строкой в лог. Отказ промиса без обработчика Node поднимает
 * сюда же (`origin` — `unhandledRejection`).
 */
export function installCrashDrain(drain: () => void = drainProcess): void {
  let draining = false;
  process.on('uncaughtException', (e, origin) => {
    console.error(`[dm-server] НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ (${origin})${draining ? ' — слив уже идёт' : ' — начинаю слив процесса'}:`, e);
    if (draining) return;
    draining = true;
    try { drain(); } catch (err) { console.error('[dm-server] слив после исключения не начался:', err); process.exit(1); }
  });
}

/** Короткий ключ метрик — предупредили ли уже (правило читают и метрики, и состояние кластера, R6-20). */
const warnedShortKey = new Set<string>();

/**
 * ⭐ R5-24, R6-20: КТО МОЖЕТ ЧИТАТЬ СЛУЖЕБНОЕ — метрики (`/metrics`) и состояние кластера (`/api/cluster`, гейтвей): прямой
 * вызов с самой машины (`localCaller`) или ключ ТОЛЬКО НА ЧТЕНИЕ (`DM_METRICS_KEY`, `Authorization: Bearer …`, сравнение за
 * постоянное время) — для сборщика не с этой машины. Слабый ключ не включается вовсе.
 */
export function internalReader(o: { nodeId: string; metricsKey?: string }): (req: Request) => boolean {
  let metricsKey = o.metricsKey ?? process.env.DM_METRICS_KEY ?? '';
  if (metricsKey && metricsKey.length < METRICS_KEY_MIN) {
    if (!warnedShortKey.has(o.nodeId)) {
      warnedShortKey.add(o.nodeId);
      console.warn(`[${o.nodeId}] DM_METRICS_KEY короче ${METRICS_KEY_MIN} знаков — ключ метрик выключен (/metrics — только с самой машины)`);
    }
    metricsKey = '';
  }
  return (req) => {
    if (localCaller(req.headers, req.socket.remoteAddress)) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
    return !!m && keyMatches(m[1]!, metricsKey, timingSafeEqual);
  };
}

/**
 * Служебные ручки процесса: метрики (Ф1.7) и слив узла (Ф4.5). Вынесены из `index.ts`, чтобы их доступ проверялся
 * тестом за настоящим транспортом: импорт `index.ts` поднимает сервер и лезет в базу.
 *
 * ⭐ R3-03: ОБЕ — ТОЛЬКО ПРЯМОМУ ВЫЗОВУ С САМОЙ МАШИНЫ (`localCaller`). Раньше проверялся адрес сокета, а за прокси
 * uWS (транспорт по умолчанию) express видит петлю у КАЖДОГО запроса: `curl -X POST http://сервер:порт/internal/drain`
 * из интернета гасил ноду — без входа, сколько угодно раз, в кластере все ноды по очереди (и давал рестарт по заказу),
 * `/metrics` отдавал наружу состав комнат и счётчики. Через Caddy перед гейтвеем — то же самое.
 */
export function installInternalRoutes(
  app: Express,
  o: { nodeId: string; metrics: () => Promise<string>; drain: () => void; metricsKey?: string },
): void {
  const canRead = internalReader(o);

  /**
   * Ф1.7: метрики для мониторинга. Отдаём ТОЛЬКО локально — состав комнат, число игроков и
   * счётчики нарушений это внутренняя информация, наружу её выставлять незачем. Prometheus
   * ходит с той же машины: на игровой порт или прямо на петлю express.
   * ⭐ R5-24: или с ключом чтения (`DM_METRICS_KEY`) — стенд `dmload` с ноутбука (STAND.md) и Prometheus на другой машине.
   * Раньше им отвечали 403, а `dmload` читал это как «тик 0 Гц» и молча выключал проверку частоты симуляции.
   */
  app.get('/metrics', (req, res) => {
    if (!canRead(req)) return res.status(403).end();
    void o.metrics().then((body) => { res.type('text/plain; version=0.0.4').send(body); }).catch(() => res.status(500).end());
  });

  /**
   * Ф4.5: СЛИВ УЗЛА ПО КОМАНДЕ — только с самой машины (R5-24: ключ метрик сюда не пускает — он только на чтение).
   *
   * Зачем ручка, если есть SIGTERM: во-первых, на Windows сигналов нет вовсе и проверить слив
   * иначе нельзя; во-вторых, в бою это штатный инструмент выкатки — «слить узел 3, дождаться
   * пустоты, перезапустить», и так по одному, без простоя для остальных.
   */
  app.post('/internal/drain', (req, res) => {
    if (!localCaller(req.headers, req.socket.remoteAddress)) return res.status(403).end();
    console.log(`[${o.nodeId}] слив по команде`);
    res.json({ ok: true, node: o.nodeId });
    // Ответ уходит ДО начала слива: вызывающий должен получить подтверждение, а не таймаут.
    setTimeout(o.drain, 50);
  });
}
