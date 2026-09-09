import WebSocket from 'ws';
import { applyWorldDelta, worldChecksum, decodeWorldFrame, emptySnapshot, WIRE_FULL, type ClientFrame, type ServerFrame, type WorldSnapshot } from '@dm/shared';

/**
 * Бот-клиент нагрузочного стенда: регистрация → персонаж → комната → спуск → ввод с частотой тика.
 * Ведёт себя как настоящий клиент по протоколу (`ClientFrame`/`ServerFrame`), поэтому меряет
 * реальный путь сервера целиком: разбор кадров, тик комнаты, сериализацию и отправку.
 *
 * Собирает с СВОЕЙ стороны: RTT (ping/pong), сколько снапшотов пришло, сколько байт принято.
 * Серверную сторону (CPU, лаг цикла) печатает `probe.ts`.
 */
export interface BotOptions {
  /** База сервера, например `http://127.0.0.1:3999`. */
  base: string;
  /** Уникальный префикс имён аккаунтов этого прогона (чтобы прогоны не конфликтовали). */
  tag: string;
  /** Порядковый номер бота. */
  index: number;
  /** Класс персонажа. */
  classId: string;
  /** Частота отправки ввода, Гц. */
  inputHz: number;
  /** Размер пати: 1 — каждый в своей комнате, N — по N ботов на комнату. */
  groupSize: number;
  /** Спускаться в подземелье (иначе бот стоит в городе). */
  descend: boolean;
  /** Общая на прогон карта «индекс группы → код комнаты» — хост записывает, остальные ждут. */
  roomCodes: Map<number, string>;
}

export interface BotStats {
  /** Сумма и число замеров RTT — для медианы по популяции берётся среднее бота. */
  rttSum: number;
  rttCount: number;
  /** Принято байт и снапшотов. */
  bytes: number;
  snapshots: number;
  /** Кадры `error` от сервера — важны: молчаливый отказ легко проглядеть. */
  errors: string[];
  /**
   * Расхождения дельт (Ф1.3). Бот применяет дельты к своей копии мира, а когда приходит
   * периодический ПОЛНЫЙ кадр — сверяет реконструкцию с истиной. Любое ненулевое значение
   * означает ошибку в дельта-протоколе, и это самая дешёвая возможная проверка: сервер
   * и так шлёт полный кадр раз в несколько секунд.
   */
  deltaMismatches: number;
  /** Сколько полных кадров удалось сверить (чтобы «ноль расхождений» не означал «ноль сверок»). */
  deltaChecks: number;
}

export class LoadBot {
  readonly stats: BotStats = { rttSum: 0, rttCount: 0, bytes: 0, snapshots: 0, errors: [], deltaMismatches: 0, deltaChecks: 0 };
  /** Своя копия мира: полный кадр задаёт её, дельты двигают. */
  private world?: WorldSnapshot;
  private ws?: WebSocket;
  private inputTimer?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingSentAt = new Map<number, number>();
  private pingId = 0;
  private seq = 0;

  constructor(private readonly o: BotOptions) {}

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /**
   * Куда подключаться (Ф4.1). Гейтвей отвечает адресом узла либо местом в очереди —
   * очередь ждём, а не считаем ошибкой: она и есть штатное поведение на потолке.
   */
  private async route(token: string, charId: string, roomCode?: string): Promise<string> {
    let ticket = '';
    for (let i = 0; i < 60; i++) {
      const qs = `charId=${encodeURIComponent(charId)}${ticket ? `&ticket=${ticket}` : ''}`
        + (roomCode ? `&roomCode=${encodeURIComponent(roomCode)}` : '');
      const r = await fetch(`${this.o.base}/api/route?${qs}`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) return ((await r.json()) as { url: string }).url;
      if (r.status === 503) {
        const b = (await r.json()) as { queue?: { ticket: string } };
        if (b.queue) { ticket = b.queue.ticket; await new Promise((s) => setTimeout(s, 1000)); continue; }
      }
      throw new Error(`/api/route → ${r.status} ${await r.text()}`);
    }
    throw new Error('очередь на вход не подошла за минуту');
  }

  /** Регистрация + персонаж по HTTP, затем вход в комнату по WS. Бросает при отказе сервера. */
  async start(): Promise<void> {
    const { token } = await this.post<{ token: string }>('/api/register', {
      username: `lt_${this.o.tag}_${this.o.index}`,
      password: 'loadtest-password',
    });
    const { character } = await this.post<{ character: { charId: string } }>(
      '/api/characters', { classId: this.o.classId, name: `B${this.o.index}` }, token,
    );

    const group = Math.floor(this.o.index / this.o.groupSize);
    const isHost = this.o.index % this.o.groupSize === 0;

    // Не-хост ждёт код комнаты ДО маршрутизации: код несёт в себе букву ноды, и без него
    // гейтвей отправит его к другому процессу, где этой комнаты нет.
    if (!isHost) {
      for (let i = 0; i < 200 && !this.o.roomCodes.has(group); i++) await sleep(50);
    }
    const code = this.o.roomCodes.get(group);

    // Ф4: адрес игрового узла спрашиваем у гейтвея. В одиночном режиме он вернёт сам себя,
    // поэтому стенд одинаково работает и с кластером, и без него.
    const url = await this.route(token, character.charId, isHost ? undefined : code);
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, group, isBinary));

    this.send({ t: 'join', token, charId: character.charId, ...(isHost || !code ? { fresh: true } : { roomCode: code }) });

    this.inputTimer = setInterval(() => this.sendInput(), 1000 / this.o.inputHz);
    this.pingTimer = setInterval(() => {
      const id = ++this.pingId;
      this.pingSentAt.set(id, Date.now());
      if (this.pingSentAt.size > 20) this.pingSentAt.delete(this.pingSentAt.keys().next().value!);
      this.send({ t: 'ping', id });
    }, 1000);
    ws.on('close', () => this.stop());
  }

  stop(): void {
    if (this.inputTimer) { clearInterval(this.inputTimer); this.inputTimer = undefined; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  /** Обнулить счётчики — зовётся после прогрева, чтобы замер шёл с установившегося режима. */
  resetStats(): void {
    this.stats.rttSum = 0; this.stats.rttCount = 0;
    this.stats.bytes = 0; this.stats.snapshots = 0;
    this.stats.deltaMismatches = 0; this.stats.deltaChecks = 0;
  }

  private onMessage(data: Buffer, group: number, isBinary: boolean): void {
    this.stats.bytes += data.length;
    // Ф1.4: кадры мира двоичные, управляющие — текстовый JSON.
    if (isBinary) {
      this.stats.snapshots++;
      const f = decodeWorldFrame(new Uint8Array(data));
      const base = f.kind === WIRE_FULL ? emptySnapshot() : this.world;
      if (!base) return;
      this.world = applyWorldDelta(base, f.delta);
      // Сверка на ТОМ ЖЕ тике: сумма приехала вместе с кадром.
      this.stats.deltaChecks++;
      if (worldChecksum(this.world) !== f.sum) {
        this.stats.deltaMismatches++;
      }
      return;
    }
    let frame: ServerFrame;
    try { frame = JSON.parse(data.toString()) as ServerFrame; } catch { return; }
    switch (frame.t) {

      case 'pong': {
        const at = this.pingSentAt.get(frame.id);
        if (at != null) { this.stats.rttSum += Date.now() - at; this.stats.rttCount++; this.pingSentAt.delete(frame.id); }
        break;
      }
      case 'joined':
        this.o.roomCodes.set(group, frame.roomCode);
        // Спуск идёт голосованием: хост инициирует, остальные голосуют «за» по `voteStart`.
        if (this.o.descend) setTimeout(() => this.send({ t: 'descend', difficultyId: 'normal' }), 1500 + Math.random() * 1500);
        break;
      case 'voteStart':
        setTimeout(() => this.send({ t: 'vote', accept: true }), 100);
        break;
      case 'error':
        this.stats.errors.push(`${frame.code}: ${frame.msg}`);
        break;
      default:
        break;
    }
  }

  /** Ввод «бегу в случайную сторону и бью» — нагружает движение, ИИ и бой, а не только сеть. */
  private sendInput(): void {
    const a = Math.random() * Math.PI * 2;
    this.send({
      t: 'input', seq: this.seq++,
      input: { move: { x: Math.cos(a), y: Math.sin(a) }, facing: a, attack: true, cast: null, interact: false },
    });
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const r = await fetch(this.o.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
