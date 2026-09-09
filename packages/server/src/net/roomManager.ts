import type { GameConn } from './conn.js';
import { levelForXp, packInventory, applyDeathPenalty, type ConfigRegistry, type ClientFrame, type SaveState } from '@dm/shared';
import { getSession, getCharacter, putCharacter } from '../db/db.js';
import { Room } from './room.js';
import { limits } from './rateLimit.js';
import { counters, setGaugeProvider } from './metrics.js';
import { releaseChar } from '../cluster/registry.js';

/**
 * Ф4.1: ПЕРВАЯ БУКВА КОДА — это нода, на которой живёт комната. Благодаря ей «зайти к другу
 * по коду» не требует ни одного запроса в реестр: гейтвей смотрит на букву и отправляет
 * клиента к нужному процессу. Дешевле любой таблицы соответствий и не может протухнуть.
 */
function nodeLetter(): string {
  const idx = Number(/(\d+)$/.exec(process.env.DM_NODE_ID ?? 'node-0')?.[1] ?? 0);
  return String.fromCharCode(65 + (idx % 26));
}
function newCode(): string {
  return nodeLetter() + Math.random().toString(36).slice(2, 6).toUpperCase();
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
/**
 * Ф0.8: потолок частоты кадров `input` на соединение. Боевой клиент шлёт ввод из рендер-цикла,
 * то есть 60–144 Гц, а полезны из них только 30: `setInput` просто перезаписывает последний.
 * Приём кадра стоит ~13 мкс, то есть столько же, сколько отправка, — лишние кадры это чистая
 * потеря. Лимит с запасом на джиттер клиента; сверх лимита кадр молча отбрасывается.
 */
const INPUT_HZ_LIMIT = 40;
/** Имя этой ноды в кластере (Ф4). В одиночном режиме — `node-0`. */
const NODE_ID = process.env.DM_NODE_ID ?? 'node-0';

/**
 * Доступ кластера к менеджеру комнат этого процесса (Ф4): сердцебиению нужны имена живых
 * персонажей, чтобы продлить их закрепление за нодой, а сливу — дописать прогресс.
 * Менеджер в процессе один, поэтому ссылку держим здесь, а не тащим её через пять слоёв.
 */
let current: RoomManager | null = null;
export const clusterHooks = {
  /** Персонажи с живой сессией на этой ноде. */
  liveCharIds(): string[] { return current ? [...current.liveChars()] : []; },
  /** Дописать прогресс всех комнат — для слива ноды. */
  flushAll(): Promise<unknown> { return current ? current.flushAll() : Promise.resolve(); },
};

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** Счётчик кадров ввода в текущем окне на соединение: {окно (сек), сколько пришло, сколько отброшено}. */
  private inputRate = new Map<GameConn, { sec: number; seen: number; dropped: number }>();
  private conns = new Map<GameConn, { pid: string; room: Room }>();
  /** charId → комната, ждущая его реконнекта (заморожена/активна). Реконнект возвращает в ту же точку. */
  private graceByChar = new Map<string, Room>();
  /**
   * Ф0.3: РЕЕСТР ЖИВЫХ СЕССИЙ, `charId → соединение`. Инвариант: у персонажа во всём процессе
   * ровно одна живая сессия. Раньше дедуп был только ВНУТРИ комнаты, поэтому второй `join`
   * без кода просто создавал вторую комнату — обе держали свою копию сейва и писали её раз
   * в 10 секунд (last-writer-wins). Это и есть подтверждённый дюп; PoC — `loadtest/dupe.ts`.
   */
  private live = new Map<string, GameConn>();
  /** Ключи соединений для лимитеров частоты (Ф0.5). */
  private connKeys = new WeakMap<GameConn, string>();
  private connSeq = 0;

  /** Имена персонажей с живой сессией — для продления закрепления в реестре (Ф4). */
  liveChars(): IterableIterator<string> { return this.live.keys(); }

  constructor(private cfg: ConfigRegistry) {
    current = this;
    // Ф1.7: показатели считаются в момент запроса метрик — состав комнат знает только менеджер.
    setGaugeProvider(() => {
      let players = 0;
      for (const room of this.rooms.values()) players += room.size;
      return { rooms: this.rooms.size, players, connections: this.conns.size };
    });
  }

  /** Сброс прогресса всех комнат в БД — для graceful shutdown (рестарт/остановка сервера). */
  flushAll(): Promise<unknown> {
    return Promise.all([...this.rooms.values()].map((room) => room.flush()));
  }

  /**
   * Ф2: ОЧЕРЕДЬ КАДРОВ НА СОЕДИНЕНИЕ. Обработка кадра стала асинхронной (доступ к базе), а
   * значит два кадра одного игрока могли бы выполняться внахлёст: второй `join` начал бы
   * работу, пока первый ещё читает сейв, и оба записали бы игрока в разные комнаты. Кадры
   * одного соединения идут строго друг за другом.
   *
   * Мимо очереди пропущены `ping` и `input` — они не ходят в базу, зато идут десятками в
   * секунду: ставить их в очередь значило бы добавлять задержку самому горячему пути.
   */
  handleConnection(ws: GameConn): void {
    let chain: Promise<void> = Promise.resolve();
    ws.onMessage((raw) => {
      const frame = this.accept(ws, raw);
      if (!frame) return;
      if (frame.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', id: frame.id })); return; }
      if (frame.t === 'input') {
        const conn = this.conns.get(ws);
        if (conn && this.allowInput(ws)) conn.room.setInput(conn.pid, frame.input);
        return;
      }
      chain = chain.then(() => this.onFrame(ws, frame)).catch((e: unknown) => {
        console.error('[room] отказ при обработке кадра:', e);
      });
    });
    ws.onClose(() => { chain = chain.then(() => { this.onClose(ws); }); });
  }

  /**
   * Общий вход кадра: лимит частоты и разбор. Возвращает кадр либо undefined, если кадр
   * отброшен (и тогда соединение уже могло быть закрыто).
   */
  private accept(ws: GameConn, raw: string): ClientFrame | undefined {
    // Ф0.5: общий потолок кадров на соединение — проверяем ДО разбора JSON, иначе флудер
    // заставляет нас парсить его мусор. Превышение потолка это уже не «высокий FPS»
    // (тот отсекается мягким лимитом ввода), а поведение, которого у клиента быть не должно.
    counters.framesIn++;
    if (!limits.wsFrames.take(this.connKey(ws))) {
      counters.rateLimited++;
      ws.close(4008, 'rate limit');
      this.onClose(ws);
      return undefined;
    }
    try { return JSON.parse(raw) as ClientFrame; } catch { return undefined; }
  }

  /** Кадры, которым нужна база: идут по очереди соединения (см. `handleConnection`). */
  private async onFrame(ws: GameConn, frame: ClientFrame): Promise<void> {

    // Есть ли незавершённый забег? Грейс-комната (из подземелья, ещё жива) ИЛИ сохранённый `save.run`
    // (город-разрыв / истёкший грейс / реконнект). Модалка «Продолжить/Завершить» появляется ВСЕГДА,
    // пока забег не завершён. (После рестарта сервера save.run уже сброшен clearAllRuns → hasRun=false.)
    if (frame.t === 'runStatus') {
      const userId = await this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      const room = this.graceByChar.get(frame.charId);
      const owned = room ? undefined : await this.ownedSave(userId, frame.charId);
      const run = owned?.save.run;
      const hasRun = !!room || !!run;
      const depth = room?.currentDepth ?? (run ? runDepthOf(run.currentNodeId) : 0);
      ws.send(JSON.stringify({ t: 'runStatus', hasRun, roomCode: room?.code, depth }));
      return;
    }

    // Завершить забег: персонаж гибнет со штрафом. Грейс-комната → её abandonAsDead; иначе (грейс истёк /
    // город-разрыв, но save.run цел) — применяем штраф и чистим `run` прямо в сейве.
    if (frame.t === 'abandon') {
      const userId = await this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      const graceRoom = this.graceByChar.get(frame.charId);
      if (graceRoom) graceRoom.abandonAsDead(frame.charId);
      else {
        const owned = await this.ownedSave(userId, frame.charId);
        if (owned?.save.run) {
          applyDeathPenalty(owned.save, this.cfg.get('balance').deathPenalty);
          owned.save.run = undefined;
          if (await putCharacter(frame.charId, userId, owned.save, owned.version) === null) {
            console.warn(`[room] отклонён устаревший сейв при abandon ${frame.charId}`);
          }
        }
      }
      ws.send(JSON.stringify({ t: 'abandoned' }));
      return;
    }

    if (frame.t === 'join') {
      if (this.conns.has(ws)) return;
      const userId = await this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      // Ф0.3: этот персонаж уже где-то играет — выселяем старую сессию ДО чтения сейва из БД,
      // чтобы новая прочитала уже зафиксированный прогресс, а не обогнала его.
      this.evictLive(frame.charId);

      // Продолжить забег: грейс-комната → возврат в ту же точку; иначе (грейс истёк / город-разрыв,
      // но save.run цел) → пересобираем забег в НОВОЙ комнате из save.run.config (тот же узел).
      if (frame.resume) {
        const owned = await this.ownedSave(userId, frame.charId);
        if (!owned) { ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return; }
        const { save, version } = owned;
        const graceRoom = this.graceByChar.get(frame.charId);
        if (graceRoom) {
          const pid = graceRoom.reconnect(ws, userId, save, version);
          this.conns.set(ws, { pid, room: graceRoom });
          this.live.set(save.charId, ws);
          return;
        }
        if (save.run) {
          const room = this.createRoom();
          const pid = room.addPlayerResumeRun(ws, userId, save, version);
          this.conns.set(ws, { pid, room });
          this.live.set(save.charId, ws);
          return;
        }
        ws.send(JSON.stringify({ t: 'error', code: 'no-run', msg: 'Забег не найден' }));
        return;
      }

      // Осознанный вход в НОВУЮ комнату (соло/хост/по коду): висел незавершённый забег — считаем
      // его брошенным (штраф) ДО чтения сейва, чтобы новый вход взял уже урезанный сейв из БД.
      this.graceByChar.get(frame.charId)?.abandonAsDead(frame.charId);
      const owned = await this.ownedSave(userId, frame.charId);
      if (!owned) { ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return; }
      let room: Room;
      if (frame.roomCode) {
        const existing = this.rooms.get(frame.roomCode.toUpperCase());
        if (!existing) { ws.send(JSON.stringify({ t: 'error', code: 'no-room', msg: 'Комната не найдена' })); return; }
        room = existing;
      } else {
        // Ф0.5: каждая новая комната — это свой тик в планировщике. Без лимита тысяча join'ов
        // кладёт процесс. Ключ — пользователь: он уже проверен на владение персонажем.
        if (!limits.roomCreate.take(userId)) {
          ws.send(JSON.stringify({ t: 'error', code: 'rate', msg: 'Слишком часто создаёте комнаты' }));
          return;
        }
        room = this.createRoom();
      }
      const pid = room.addPlayer(ws, userId, owned.save, owned.version);
      this.conns.set(ws, { pid, room });
      this.live.set(owned.save.charId, ws);
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    switch (frame.t) {
      case 'cmd': await conn.room.handleCmd(conn.pid, frame.command, frame.id); break;
      case 'descend': conn.room.descend(conn.pid, frame.difficultyId, frame.targetNodeId, frame.runConfig); break;
      case 'arena': conn.room.enterArena(conn.pid); break;
      case 'return': conn.room.returnTown(conn.pid); break;
      case 'lever': conn.room.pullLever(conn.pid, frame.leverId); break;
      case 'vote': conn.room.castVote(conn.pid, frame.accept); break;
      case 'leave': this.onClose(ws); break;
    }
  }

  /** Стабильный ключ соединения для лимитеров: сокет живёт ровно одну сессию. */
  private connKey(ws: GameConn): string {
    let k = this.connKeys.get(ws);
    if (!k) { k = `c${++this.connSeq}`; this.connKeys.set(ws, k); }
    return k;
  }

  /**
   * Выселяет живую сессию персонажа, если она есть: закрывает её соединение и снимает игрока
   * с комнаты (это же персистит его прогресс). Выселяем, а не отказываем новому входу: чаще
   * всего вторая сессия — это реконнект после обрыва, и держать игрока снаружи до таймаута хуже.
   */
  private evictLive(charId: string): void {
    const old = this.live.get(charId);
    if (!old) return;
    this.live.delete(charId);
    counters.sessionsEvicted++;
    const conn = this.conns.get(old);
    if (conn) { conn.room.removePlayer(conn.pid); this.conns.delete(old); }
    this.inputRate.delete(old);
    try { old.close(4001, 'replaced'); } catch { /* уже закрыт */ }
  }

  private onClose(ws: GameConn): void {
    this.inputRate.delete(ws);
    const conn = this.conns.get(ws);
    if (!conn) return;
    for (const [charId, sock] of this.live) {
      if (sock !== ws) continue;
      this.live.delete(charId);
      // Ф4: закрепление снимаем ТОЛЬКО если ждать нечего. Если у персонажа осталась
      // грейс-комната, он обязан вернуться на эту же ноду — иначе забег потеряется.
      if (!this.graceByChar.has(charId)) void releaseChar(charId, NODE_ID).catch(() => undefined);
      break;
    }
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

  /**
   * Пропускать ли этот кадр ввода. Окно — одна секунда; сверх `INPUT_HZ_LIMIT` кадры
   * отбрасываются. Соединение не рвём: лишняя частота это почти всегда высокий FPS клиента,
   * а не злонамеренность (злонамеренность ловит общий лимит кадров ws, задача Ф0.5).
   */
  private allowInput(ws: GameConn): boolean {
    const sec = Math.floor(Date.now() / 1000);
    let r = this.inputRate.get(ws);
    if (!r || r.sec !== sec) { r = { sec, seen: 0, dropped: 0 }; this.inputRate.set(ws, r); }
    r.seen++;
    if (r.seen > INPUT_HZ_LIMIT) { r.dropped++; counters.inputThrottled++; return false; }
    return true;
  }

  /** Проверка сессии + владения персонажем. Ошибку шлёт сама; возвращает userId или undefined. */
  private async authOwner(ws: GameConn, token: string, charId: string): Promise<string | undefined> {
    const userId = await getSession(token);
    if (!userId) { ws.send(JSON.stringify({ t: 'error', code: 'auth', msg: 'Требуется вход' })); return undefined; }
    const character = await getCharacter(charId);
    if (!character || character.userId !== userId) {
      ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return undefined;
    }
    return userId;
  }

  /**
   * Свежий сейв персонажа из БД + его версия (Ф0.3) + лёгкий анти-чит. Версия едет в комнату
   * и предъявляется при каждой записи: устаревшая копия не сможет затереть свежую.
   */
  private async ownedSave(userId: string, charId: string): Promise<{ save: SaveState; version: number } | undefined> {
    const character = await getCharacter(charId);
    if (!character || character.userId !== userId) return undefined;
    return { save: this.sanitize(character.data), version: character.version };
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
