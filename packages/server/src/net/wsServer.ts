import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { ConfigRegistry } from '@dm/shared';
import { RoomManager } from './roomManager.js';

/**
 * Поднимает WebSocket-сервер на пути `/ws` поверх общего HTTP-сервера (тот же порт,
 * что REST). Каждый коннект уходит в `RoomManager` (комнаты = авторитетные сессии).
 */
export function attachWsServer(server: Server, cfg: ConfigRegistry): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const rooms = new RoomManager(cfg);
  wss.on('connection', (ws) => rooms.handleConnection(ws));
  console.log('[dm-server] WebSocket на /ws');

  // Graceful shutdown: при остановке/рестарте (в dev — `tsx watch` шлёт SIGTERM на каждую
  // правку кода) успеваем синхронно сбросить прогресс всех комнат в БД — забег не теряется.
  const shutdown = () => { try { rooms.flushAll(); } finally { process.exit(0); } };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
