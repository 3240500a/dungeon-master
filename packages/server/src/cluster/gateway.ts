import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { q, q1 } from '../db/pool.js';
import { getSession, getCharacter } from '../db/db.js';
import { liveNodes, claimChar, sweepNodes, type NodeRow } from './registry.js';

/**
 * Гейтвей (Ф4.1, Ф4.4): раздаёт клиенту адрес игровой ноды и держит очередь на вход.
 *
 * ЧЕГО ГЕЙТВЕЙ НЕ ДЕЛАЕТ — он НЕ проксирует игру. Проксируй он кадры, вся работа, которую
 * мы только что разложили по процессам, снова сошлась бы в одном: он делал бы те же
 * отправки и приёмы, только дважды. Поэтому клиент спрашивает адрес один раз и дальше
 * говорит с нодой напрямую.
 *
 * КАК ВЫБИРАЕТСЯ НОДА:
 *  1. Заход по коду комнаты — по ПЕРВОЙ БУКВЕ кода. Код комнаты выдаёт нода и ставит в него
 *     свою букву, поэтому «зайти к другу» не требует ни одного запроса в базу.
 *  2. Возврат своего персонажа — на ноду, за которой он закреплён (`char_claims`). Это же
 *     закрытие глобального замка: второй вход тем же персонажем попадает на ТУ ЖЕ ноду,
 *     где выселение старой сессии уже работает с Ф0.3.
 *  3. Новый вход — на самую свободную живую ноду.
 */

/** Буква ноды в коде комнаты: `node-0` → `A`. По ней гейтвей и маршрутизирует. */
export function nodeLetter(nodeId: string): string {
  const idx = Number(/(\d+)$/.exec(nodeId)?.[1] ?? 0);
  return String.fromCharCode(65 + (idx % 26));
}

/** Потолок кластера. Сверх него — очередь, а не отказ и не «примем всех и ляжем». */
const MAX_PLAYERS = Number(process.env.DM_MAX_PLAYERS ?? 0);   // 0 = без потолка
/** Билет в очереди живёт недолго: ушедший из очереди не должен держать место. */
const TICKET_TTL_SEC = 60;

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m ? m[1]! : null;
}

/**
 * Сколько игроков мы отправили на узел с прошлого обновления его показателей.
 *
 * БЕЗ ЭТОГО ВСПЛЕСК УХОДИТ НА ОДИН УЗЕЛ. Показатели приходят с сердцебиением раз в две
 * секунды; если за это время подключаются сорок человек, все сорок видят «везде по нулю»
 * и все едут на первый узел. Проверено на первом же прогоне: 4 узла, 14 игроков — все на
 * `node-0`. Поэтому к числу игроков прибавляем ещё не учтённые направления.
 */
const issued = new Map<string, number>();
/** Раз в несколько секунд показатели узлов догоняют реальность — счётчик обнуляем. */
setInterval(() => issued.clear(), 4_000).unref();

/** Самая свободная живая нода с учётом уже выданных, но ещё не учтённых направлений. */
function leastLoaded(nodes: NodeRow[]): NodeRow | undefined {
  const score = (n: NodeRow): number => n.players + (issued.get(n.id) ?? 0);
  const best = nodes.filter((n) => !n.draining).sort((a, b) => score(a) - score(b))[0];
  if (best) issued.set(best.id, (issued.get(best.id) ?? 0) + 1);
  return best;
}

export function installGatewayRoutes(app: Express): void {
  /**
   * Куда подключаться. Возвращает либо адрес ноды, либо место в очереди.
   * Клиент зовёт это ПЕРЕД открытием сокета и после каждого разрыва.
   */
  app.get('/api/route', (req: Request, res: Response) => {
    void (async () => {
      const token = bearer(req);
      const userId = token ? await getSession(token) : null;
      if (!userId) return res.status(401).json({ error: 'Требуется вход' });

      const charId = String(req.query.charId ?? '');
      const owned = charId ? await getCharacter(charId) : null;
      if (!owned || owned.userId !== userId) return res.status(403).json({ error: 'Персонаж недоступен' });

      const nodes = await liveNodes();
      if (!nodes.length) return res.status(503).json({ error: 'Игровые узлы недоступны' });

      // 1. По коду комнаты — к другу.
      const code = String(req.query.roomCode ?? '').toUpperCase();
      if (code) {
        const byLetter = nodes.find((n) => nodeLetter(n.id) === code[0]);
        if (byLetter) return res.json({ url: byLetter.url, node: byLetter.id, reason: 'по коду комнаты' });
        return res.status(404).json({ error: 'Комната не найдена: узел не отвечает' });
      }

      // 2. Очередь: считаем ПЕРЕД закреплением, иначе место занимает тот, кого не пустили.
      const total = nodes.reduce((a, n) => a + n.players, 0);
      const ticket = String(req.query.ticket ?? '');
      if (MAX_PLAYERS > 0 && total >= MAX_PLAYERS) {
        const q1r = await admit(ticket, userId, MAX_PLAYERS - total);
        if (!q1r.admitted) return res.status(503).json(q1r.body);
      } else if (ticket) {
        await q('DELETE FROM login_queue WHERE ticket = $1', [ticket]);   // место есть — билет не нужен
      }

      // 3. Свой персонаж возвращается на свою ноду; новый — на самую свободную.
      const free = leastLoaded(nodes) ?? nodes[0]!;
      const nodeId = await claimChar(charId, free.id);
      const target = nodes.find((n) => n.id === nodeId) ?? free;
      res.json({ url: target.url, node: target.id, reason: target.id === free.id ? 'самая свободная' : 'закреплён за узлом' });
    })().catch((e: unknown) => {
      console.error('[гейтвей] отказ маршрутизации:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка' });
    });
  });

  /** Состояние кластера — для мониторинга и стенда. */
  app.get('/api/cluster', (_req: Request, res: Response) => {
    void (async () => {
      const nodes = await liveNodes();
      res.json({
        players: nodes.reduce((a, n) => a + n.players, 0),
        rooms: nodes.reduce((a, n) => a + n.rooms, 0),
        maxPlayers: MAX_PLAYERS || null,
        nodes: nodes.map((n) => ({
          id: n.id, url: n.url, players: n.players, rooms: n.rooms,
          draining: n.draining, tickHz: n.tick_hz, loopP99: n.loop_p99_ms,
          rssMb: Math.round(Number(n.rss_bytes) / 1048576),
        })),
      });
    })().catch(() => res.status(500).json({ error: 'Внутренняя ошибка' }));
  });

  // Узлы, переставшие подавать признаки жизни, не должны копиться в реестре.
  setInterval(() => { void sweepNodes().catch(() => undefined); }, 30_000).unref();
}

/**
 * Очередь на вход. Билет выдаётся один раз, дальше клиент приходит с ним и получает своё
 * место. Пускаем столько, сколько освободилось мест, начиная с головы очереди.
 */
async function admit(ticket: string, userId: string, freeSlots: number)
  : Promise<{ admitted: boolean; body?: unknown }> {
  await q(`DELETE FROM login_queue WHERE at < now() - ($1 || ' seconds')::interval`, [String(TICKET_TTL_SEC)]);

  if (ticket) {
    const pos = await q1<{ n: string }>(
      `SELECT COUNT(*) n FROM login_queue
       WHERE at < (SELECT at FROM login_queue WHERE ticket = $1)`, [ticket]);
    const ahead = Number(pos?.n ?? 0);
    if (ahead < Math.max(0, freeSlots)) {
      await q('DELETE FROM login_queue WHERE ticket = $1', [ticket]);
      return { admitted: true };
    }
    // Обновляем метку, чтобы билет не протух, пока человек честно ждёт.
    await q('UPDATE login_queue SET at = at WHERE ticket = $1', [ticket]);
    const total = await q1<{ n: string }>('SELECT COUNT(*) n FROM login_queue');
    return { admitted: false, body: { queue: { ticket, position: ahead + 1, total: Number(total?.n ?? 0) } } };
  }

  const fresh = randomUUID();
  await q('INSERT INTO login_queue (ticket, user_id) VALUES ($1, $2)', [fresh, userId]);
  const total = await q1<{ n: string }>('SELECT COUNT(*) n FROM login_queue');
  return { admitted: false, body: { queue: { ticket: fresh, position: Number(total?.n ?? 1), total: Number(total?.n ?? 1) } } };
}

/**
 * Метрики КЛАСТЕРА в формате Prometheus. Складываем показатели узлов из реестра: мониторинг
 * и нагрузочный стенд должны видеть работу всех процессов, а не того одного, который игру
 * как раз и не ведёт.
 *
 * Имена намеренно те же, что у одиночного процесса (`dm_cpu_*`, `dm_tick_hz`, `dm_rss_bytes`),
 * поэтому стенд и дашборд работают с кластером без единой правки.
 */
export async function clusterMetrics(): Promise<string> {
  const nodes = await liveNodes();
  const sum = (f: (n: NodeRow) => number): number => nodes.reduce((a, n) => a + f(n), 0);
  const players = sum((n) => n.players);
  const rooms = sum((n) => n.rooms);
  // Частота симуляции по кластеру — среднее по узлам, взвешенное по числу комнат:
  // узел без комнат не должен тянуть среднее вниз.
  const hz = rooms > 0 ? sum((n) => n.tick_hz * n.rooms) / rooms : 0;
  const out: string[] = [];
  const g = (name: string, help: string, v: number, type = 'gauge'): void => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${v}`);
  };
  g('dm_nodes', 'Живых игровых узлов в кластере', nodes.length);
  g('dm_nodes_draining', 'Узлов в состоянии слива', nodes.filter((n) => n.draining).length);
  g('dm_players', 'Игроков в кластере', players);
  g('dm_rooms', 'Комнат в кластере', rooms);
  g('dm_tick_hz', 'Частота симуляции, взвешенная по комнатам', Number(hz.toFixed(2)));
  g('dm_loop_delay_p99_ms', 'Худший лаг цикла среди узлов', Number(Math.max(0, ...nodes.map((n) => n.loop_p99_ms)).toFixed(2)));
  g('dm_rss_bytes', 'Суммарная резидентная память узлов', sum((n) => Number(n.rss_bytes)));
  // Процессорное время всех узлов вместе: стенд считает по нему загрузку кластера.
  g('dm_cpu_user_seconds_total', 'Процессорное время узлов (сумма)', Number(sum((n) => n.cpu_seconds).toFixed(3)), 'counter');
  g('dm_cpu_system_seconds_total', 'Учтено в dm_cpu_user_seconds_total', 0, 'counter');
  const queued = await q1<{ n: string }>('SELECT COUNT(*) n FROM login_queue');
  g('dm_login_queue', 'Игроков в очереди на вход', Number(queued?.n ?? 0));
  return `${out.join('\n')}\n`;
}
