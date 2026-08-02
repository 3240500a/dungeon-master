import type { WebSocket } from 'ws';
import { levelForXp, packInventory, applyDeathPenalty, type ConfigRegistry, type ClientFrame, type SaveState } from '@dm/shared';
import { getSession, getCharacter, putCharacter } from '../db/db.js';
import { Room } from './room.js';

function newCode(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/** Глубина этажа по id узла забега ('start'=0, 'n<depth>_<lane>'). Для подписи модалки без регенерации графа. */
function runDepthOf(nodeId: string): number {
  const m = /^n(\d+)_/.exec(nodeId);
  return m ? Number(m[1]) : 0;
}

/**
 * Управление комнатами. Вход по явному намерению:
 *  • `runStatus` — есть ли незавершённый забег (грейс-комната из подземелья); комнату не создаёт;
 *  • `join { resume }` — вернуться в грейс-комнату (та же точка); без грейса → error 'no-run';
 *  • `join { roomCode }` — к другу по коду; `join { fresh }`/без кода — новая комната (соло/хост).
 * Осознанный вход в НОВУЮ комнату при висящем забеге = бросок забега (штраф смерти) как страховка.
 * Реконнект-грейс возникает ТОЛЬКО при выходе из подземелья (в городе выход = чистый разрыв).
 * Роутит кадры клиента в его комнату; ws → {playerId, room}; пустая комната самоуничтожается.
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

    // Замер задержки: сразу эхо-pong (без auth/комнаты) — клиент считает RTT. Также keepalive.
    if (frame.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', id: frame.id })); return; }

    // Есть ли незавершённый забег? Грейс-комната (из подземелья, ещё жива) ИЛИ сохранённый `save.run`
    // (город-разрыв / истёкший грейс / реконнект). Модалка «Продолжить/Завершить» появляется ВСЕГДА,
    // пока забег не завершён. (После рестарта сервера save.run уже сброшен clearAllRuns → hasRun=false.)
    if (frame.t === 'runStatus') {
      const userId = this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      const room = this.graceByChar.get(frame.charId);
      const save = room ? undefined : this.ownedSave(userId, frame.charId);
      const hasRun = !!room || !!save?.run;
      const depth = room?.currentDepth ?? (save?.run ? runDepthOf(save.run.currentNodeId) : 0);
      ws.send(JSON.stringify({ t: 'runStatus', hasRun, roomCode: room?.code, depth }));
      return;
    }

    // Завершить забег: персонаж гибнет со штрафом. Грейс-комната → её abandonAsDead; иначе (грейс истёк /
    // город-разрыв, но save.run цел) — применяем штраф и чистим `run` прямо в сейве.
    if (frame.t === 'abandon') {
      const userId = this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      const graceRoom = this.graceByChar.get(frame.charId);
      if (graceRoom) graceRoom.abandonAsDead(frame.charId);
      else {
        const save = this.ownedSave(userId, frame.charId);
        if (save?.run) { applyDeathPenalty(save, this.cfg.get('balance').deathPenalty); save.run = undefined; putCharacter(frame.charId, userId, save); }
      }
      ws.send(JSON.stringify({ t: 'abandoned' }));
      return;
    }

    if (frame.t === 'join') {
      if (this.conns.has(ws)) return;
      const userId = this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;

      // Продолжить забег: грейс-комната → возврат в ту же точку; иначе (грейс истёк / город-разрыв,
      // но save.run цел) → пересобираем забег в НОВОЙ комнате из save.run.config (тот же узел).
      if (frame.resume) {
        const save = this.ownedSave(userId, frame.charId);
        if (!save) { ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return; }
        const graceRoom = this.graceByChar.get(frame.charId);
        if (graceRoom) {
          const pid = graceRoom.reconnect(ws, userId, save);
          this.conns.set(ws, { pid, room: graceRoom });
          return;
        }
        if (save.run) {
          const room = this.createRoom();
          const pid = room.addPlayerResumeRun(ws, userId, save);
          this.conns.set(ws, { pid, room });
          return;
        }
        ws.send(JSON.stringify({ t: 'error', code: 'no-run', msg: 'Забег не найден' }));
        return;
      }

      // Осознанный вход в НОВУЮ комнату (соло/хост/по коду): висел незавершённый забег — считаем
      // его брошенным (штраф) ДО чтения сейва, чтобы новый вход взял уже урезанный сейв из БД.
      this.graceByChar.get(frame.charId)?.abandonAsDead(frame.charId);
      const save = this.ownedSave(userId, frame.charId);
      if (!save) { ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return; }
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
      case 'descend': conn.room.descend(conn.pid, frame.difficultyId, frame.targetNodeId, frame.runConfig); break;
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

  /** Проверка сессии + владения персонажем. Ошибку шлёт сама; возвращает userId или undefined. */
  private authOwner(ws: WebSocket, token: string, charId: string): string | undefined {
    const userId = getSession(token);
    if (!userId) { ws.send(JSON.stringify({ t: 'error', code: 'auth', msg: 'Требуется вход' })); return undefined; }
    const character = getCharacter(charId);
    if (!character || character.userId !== userId) {
      ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return undefined;
    }
    return userId;
  }

  /** Свежий сейв персонажа из БД (после возможного штрафа за бросок забега) + лёгкий анти-чит. */
  private ownedSave(userId: string, charId: string): SaveState | undefined {
    const character = getCharacter(charId);
    if (!character || character.userId !== userId) return undefined;
    return this.sanitize(character.data);
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
