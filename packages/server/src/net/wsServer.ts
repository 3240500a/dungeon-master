import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';

/**
 * Поднимает WebSocket-сервер на пути `/ws` поверх общего HTTP-сервера (тот же порт,
 * что REST). Каждый коннект уходит в `RoomManager` (комнаты = авторитетные сессии).
 */
export function attachWsServer(server: Server, cfg: ConfigRegistry): void {
  // perMessageDeflate: сжимаем крупные кадры (снапшоты 30 Гц) — на узком/VPN-канале это снимает
  // забитость полосы (bufferbloat-лаг). threshold=1024 — мелочь (ввод/ping/pong) НЕ жмём (лишний CPU
  // без выигрыша). Умеренный level=6 — баланс сжатие/CPU; контекст-тейковер по умолчанию (похожие
  // снапшоты жмутся сильнее). Для широкого канала эффект нейтрален, для VPN — заметный плюс.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } },
  });
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
