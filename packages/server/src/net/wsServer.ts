import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';

/**
 * Поднимает WebSocket-сервер на пути `/ws` поверх общего HTTP-сервера (тот же порт,
 * что REST). Каждый коннект уходит в `RoomManager` (комнаты = авторитетные сессии).
 */
export function attachWsServer(server: Server, cfg: ConfigRegistry): void {
  // Ф0.1: сжатие ВЫКЛЮЧЕНО осознанно. Замер: perMessageDeflate стоит 179 мкс на кадр НА КАЖДОГО
  // клиента и выполняется в пуле из четырёх потоков libuv. На сотне клиентов пул захлёбывается,
  // очередь исходящих растёт (RSS 270→730 МБ), задержка уходит в 10–12 СЕКУНД. Тот же тест без
  // сжатия: RTT 8 мс, память стабильна. Цена — трафик вниз растёт с ~25 до ~175 КБ/с на игрока;
  // это временно: Ф1 (дельта-снапшоты + область интереса + бинарный кадр) уводит кадр на порядок
  // вниз, после чего сжимать будет уже нечего. Возвращать сжатие без замера — не надо.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: false,
  });
  // WSS привязан к http-серверу и переизлучает его ошибки (напр. EADDRINUSE при dev-рестарте). БЕЗ обработчика
  // 'error' здесь Node роняет процесс (unhandled 'error') → сервер умирает и редактор/клиент ловят ECONNREFUSED.
  // Логируем; освобождение порта/повтор listen обрабатывает server.on('error') в index.ts.
  wss.on('error', (e) => console.warn('[ws] WebSocketServer error:', (e as Error).message));
  const rooms = new RoomManager(cfg);
  wss.on('connection', (ws) => {
    // Heartbeat: помечаем «живым» на любой pong/сообщение; мёртвые (обрыв интернета, TCP ещё висит)
    // добиваем ниже — иначе removePlayer не сработал бы до TCP-таймаута (~2 мин) и в комнате копился
    // бы «призрак» игрока (дубль при реконнекте).
    (ws as { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => { (ws as { isAlive?: boolean }).isAlive = true; });
    ws.on('message', () => { (ws as { isAlive?: boolean }).isAlive = true; });
    rooms.handleConnection(ws);
  });
  // Пинг всех раз в 10с; кто не ответил с прошлого пинга — terminate() → 'close' → removePlayer.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as { isAlive?: boolean };
      if (w.isAlive === false) { ws.terminate(); continue; }
      w.isAlive = false;
      ws.ping();
    }
  }, 10_000);
  wss.on('close', () => clearInterval(heartbeat));
  console.log('[dm-server] WebSocket на /ws');

  // Graceful shutdown: при остановке/рестарте (в dev — `tsx watch` шлёт SIGTERM на каждую
  // правку кода) успеваем синхронно сбросить прогресс всех комнат в БД — забег не теряется.
  const shutdown = () => { try { rooms.flushAll(); } finally { process.exit(0); } };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
