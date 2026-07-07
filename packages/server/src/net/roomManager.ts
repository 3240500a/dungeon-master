import type { WebSocket } from 'ws';
import { levelForXp, packInventory, type ConfigRegistry, type ClientFrame, type SaveState } from '@dm/shared';
import { getSession, getCharacter } from '../db/db.js';
import { Room } from './room.js';

function newCode(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/**
 * Управление комнатами: коннект → join (по коду присоединяется, без кода — создаёт
 * комнату; соло = комната на 1). Роутит кадры клиента в его комнату. Держит связь
 * ws → {playerId, room}; на закрытие/leave удаляет игрока (пустая комната самоуничтожается).
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private conns = new Map<WebSocket, { pid: string; room: Room }>();
  /** charId → комната, ждущая его реконнекта (заморожена/активна). Реконнект возвращает в ту же точку. */
  private graceByChar = new Map<string, Room>();

  constructor(private cfg: ConfigRegistry) {}

  /** Сброс прогресса всех комнат в БД — для graceful shutdown (рестарт/остановка сервера). */
  flushAll(): void {
    for (const room of this.rooms.values()) room.flush();
  }

  handleConnection(ws: WebSocket): void {
    ws.on('message', (data: Buffer) => this.onMessage(ws, data.toString()));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let frame: ClientFrame;
    try { frame = JSON.parse(raw) as ClientFrame; } catch { return; }

    if (frame.t === 'join') {
      if (this.conns.has(ws)) return;
      // Аутентификация: валидный токен сессии → userId; персонаж должен принадлежать ему.
      const userId = getSession(frame.token);
      if (!userId) { ws.send(JSON.stringify({ t: 'error', code: 'auth', msg: 'Требуется вход' })); return; }
      const character = getCharacter(frame.charId);
      if (!character || character.userId !== userId) {
        ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return;
      }
      const save = this.sanitize(character.data);
      // Реконнект: у персонажа есть «замороженная»/активная комната → вернуться в НЕЁ (та же точка),
      // игнорируя код комнаты. Анти-эксплойт: возврат в подземелье, а не в город.
      const graceRoom = this.graceByChar.get(frame.charId);
      if (graceRoom) {
        const pid = graceRoom.reconnect(ws, userId, save);
        this.conns.set(ws, { pid, room: graceRoom });
        return;
      }
      let room: Room;
      if (frame.roomCode) {
        const existing = this.rooms.get(frame.roomCode.toUpperCase());
        if (!existing) { ws.send(JSON.stringify({ t: 'error', code: 'no-room', msg: 'Комната не найдена' })); return; }
        room = existing;
      } else {
        room = this.createRoom();
      }
      const pid = room.addPlayer(ws, userId, save);
      this.conns.set(ws, { pid, room });
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    switch (frame.t) {
      case 'input': conn.room.setInput(conn.pid, frame.input); break;
      case 'cmd': conn.room.handleCmd(conn.pid, frame.command); break;
      case 'descend': conn.room.descend(conn.pid, frame.difficultyId); break;
      case 'return': conn.room.returnTown(conn.pid); break;
      case 'lever': conn.room.pullLever(conn.pid, frame.leverId); break;
      case 'vote': conn.room.castVote(conn.pid, frame.accept); break;
      case 'leave': this.onClose(ws); break;
    }
  }

  private onClose(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.room.removePlayer(conn.pid);
    this.conns.delete(ws);
  }

  private createRoom(): Room {
    let code = newCode();
    while (this.rooms.has(code)) code = newCode();
    const room = new Room(code, this.cfg, {
      onEmpty: (c) => this.rooms.delete(c),
      onGrace: (charId) => this.graceByChar.set(charId, room),
      onUngrace: (charId) => this.graceByChar.delete(charId),
    });
    this.rooms.set(code, room);
    return room;
  }

  /** Лёгкий анти-чит поверх сохранённого сейва: уровень из опыта, золото ≥0 (полный объект, без стрипа). */
  private sanitize(save: SaveState): SaveState {
    const xpTable = this.cfg.get('balance').xpTable;
    save.level = Math.min(save.level, levelForXp(save.xp, xpTable) || 1);
    save.gold = Math.max(0, Math.floor(save.gold));
    // Одноразовое лечение битой/налагающейся раскладки старых сейвов: сохраняет валидные
    // позиции, переставляет только сломанные. Дальше раскладку держит валидной сервер (moveItem).
    packInventory(save.inventory, this.cfg.get('balance').inventory);
    return save;
  }
}
