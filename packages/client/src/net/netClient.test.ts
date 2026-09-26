import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encodeWorldFrame, snapshotToDelta, WIRE_FULL, WIRE_DELTA, type WorldSnapshot } from '@dm/shared';
import { NetClient, nodeUrl, routeToNode } from './netClient.js';

/**
 * ⭐ L2: ОДИН ЖИВОЙ СОКЕТ. С переподключением (поток входа `entryFlow`) у `NetClient` бывает «прошлый» сокет, и его
 * поздние события не должны трогать новый: закрытие старого сокета после `connect` сносило бы уже новую сессию
 * (плашка «соединение потеряно» и третий сокет), а его кадры шли бы в обработчики новой — вперемешку с миром новой
 * комнаты. Новый `connect` закрывает прежний сокет и забывает копию мира: первая дельта нового сокета до полного кадра
 * к миру прошлого не применяется.
 *
 * Браузерного WebSocket в node нет — подделка ровно тех свойств, которыми пользуется клиент.
 */
class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWs[] = [];
  readyState = FakeWs.CONNECTING;
  binaryType = '';
  sent: string[] = [];
  closedByClient = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(s: string): void { this.sent.push(s); }
  close(): void { this.closedByClient = true; this.readyState = FakeWs.CLOSED; }
  // Со стороны «сети»:
  open(): void { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  drop(code?: number): void { this.readyState = FakeWs.CLOSED; this.onclose?.({ code }); }
  msg(data: unknown): void { this.onmessage?.({ data }); }
}

const world = (tick: number, ids: string[]): WorldSnapshot => ({
  tick, monsters: [], projectiles: [], drops: [],
  players: ids.map((id) => ({ id, x: 16, y: 16, facing: 0, hp: 100, mana: 50, stamina: 30, alive: true, inCombat: false, stun: false, debuffs: {}, toggles: [] })),
});
const bin = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('⭐ L2: NetClient — живой только последний сокет', () => {
  const G = globalThis as unknown as { WebSocket?: unknown };
  let saved: unknown;
  beforeEach(() => { saved = G.WebSocket; G.WebSocket = FakeWs; FakeWs.all = []; });
  afterEach(() => { G.WebSocket = saved; });

  it('код закрытия доходит до обработчиков (4009 / 4001 / 4008 — причина для игрока)', () => {
    const net = new NetClient();
    const codes: (number | undefined)[] = [];
    net.onClose((c) => codes.push(c));
    net.connect('ws://x/ws');
    FakeWs.all[0]!.open();
    expect(net.connected).toBe(true);
    FakeWs.all[0]!.drop(4009);
    expect(codes).toEqual([4009]);
    expect(net.connected).toBe(false);
    expect(net.rtt).toBe(-1);
  });

  it('⭐ поздние события прошлого сокета новую сессию не трогают; новый connect закрывает прежний', () => {
    const net = new NetClient();
    let opens = 0; const closes: (number | undefined)[] = []; const frames: string[] = [];
    net.onOpen(() => { opens++; });
    net.onClose((c) => closes.push(c));
    net.on('runStatus', (f) => frames.push(`runStatus:${String(f.hasRun)}`));
    net.connect('ws://x/ws');
    const a = FakeWs.all[0]!;                          // ещё соединяется…
    net.connect('ws://x/ws');                          // …а уже новый (кнопка лобби, переподключение)
    const b = FakeWs.all[1]!;
    expect(a.closedByClient, 'прежний сокет закрыт — два живых соединения одного окна серверу не нужны').toBe(true);
    b.open();
    expect(opens).toBe(1);
    a.open(); a.msg(JSON.stringify({ t: 'runStatus', hasRun: true })); a.drop(1006);
    expect(opens, 'открытие прошлого сокета — не наше').toBe(1);
    expect(frames, 'кадры прошлого сокета не доходят').toEqual([]);
    expect(closes, '⚠ было: закрытие прошлого сокета сносило новую сессию').toEqual([]);
    expect(net.connected, 'новый жив').toBe(true);
    b.msg(JSON.stringify({ t: 'runStatus', hasRun: false }));
    expect(frames).toEqual(['runStatus:false']);
    net.send({ t: 'ping', id: 1 });
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([JSON.stringify({ t: 'ping', id: 1 })]);
    net.close();
  });

  it('⭐ новый сокет начинает мир с чистого листа: дельта до полного кадра к миру прошлого не применяется', () => {
    const net = new NetClient();
    const snaps: WorldSnapshot[] = [];
    net.on('snapshot', (f) => { snaps.push(f.snap); });
    net.connect('ws://x/ws');
    const a = FakeWs.all[0]!; a.open();
    const w1 = world(5, ['p_old']);
    a.msg(bin(encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(w1), sum: 0 })));
    expect(snaps.at(-1)!.players.map((p) => p.id)).toEqual(['p_old']);
    a.drop(4009);
    net.connect('ws://x/ws');
    const b = FakeWs.all[1]!; b.open();
    b.msg(bin(encodeWorldFrame({ kind: WIRE_DELTA, delta: { t: 1, pu: [{ id: 'p_new', x: 32 }] }, sum: 0 })));
    expect(snaps, 'дельта нового сокета до его полного кадра — ждём полный, а не лепим к старому миру').toHaveLength(1);
    const w2 = world(1, ['p_new']);
    b.msg(bin(encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(w2), sum: 0 })));
    expect(snaps.at(-1)!.players.map((p) => p.id)).toEqual(['p_new']);
    net.close();
  });
});

describe('R5-16: подписка на кадр снимается своей отпиской', () => {
  const G = globalThis as unknown as { WebSocket?: unknown };
  let saved: unknown;
  beforeEach(() => { saved = G.WebSocket; G.WebSocket = FakeWs; FakeWs.all = []; });
  afterEach(() => { G.WebSocket = saved; });

  it('отписка снимает ровно свой обработчик — соседний того же типа слышит кадры дальше', () => {
    const net = new NetClient();
    const got: string[] = [];
    const offA = net.on('runStatus', () => got.push('a'));
    net.on('runStatus', () => got.push('b'));
    net.connect('ws://x/ws');
    const ws = FakeWs.all[0]!; ws.open();
    ws.msg(JSON.stringify({ t: 'runStatus', hasRun: false }));
    offA(); offA();
    ws.msg(JSON.stringify({ t: 'runStatus', hasRun: false }));
    expect(got).toEqual(['a', 'b', 'b']);
    net.close();
  });
});

describe('⭐ R4-13: маршрут к ноде — ответ гейтвея глазами браузера', () => {
  const G = globalThis as unknown as { location?: unknown; fetch?: unknown };
  const PAGE = { protocol: 'https:', host: 'game.example', hostname: 'game.example' };
  let savedLoc: unknown, savedFetch: unknown;
  beforeEach(() => { savedLoc = G.location; savedFetch = G.fetch; G.location = PAGE; });
  afterEach(() => { G.location = savedLoc; G.fetch = savedFetch; });

  /** Гейтвей отвечает статусом и телом (строка — не JSON); запрос записан. */
  function gateway(status: number, body: unknown) {
    const asked: { url: string; auth?: string }[] = [];
    G.fetch = (url: string, init?: { headers?: Record<string, string> }) => {
      asked.push({ url, auth: init?.headers?.authorization });
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(JSON.parse(text)) });
    };
    return asked;
  }

  it('⭐ адрес ноды на петле (одиночный процесс без DM_NODE_URL) со страницы за доменом — тот же путь на origin страницы', () => {
    expect(nodeUrl('ws://127.0.0.1:3001/ws', PAGE), 'было бы: каждый игрок стучится к себе на 127.0.0.1').toBe('wss://game.example/ws');
    expect(nodeUrl('ws://localhost:3002/ws', PAGE)).toBe('wss://game.example/ws');
    expect(nodeUrl('/ws/0', PAGE), 'относительный путь — от origin страницы').toBe('wss://game.example/ws/0');
    expect(nodeUrl('wss://game.example/ws/1', PAGE)).toBe('wss://game.example/ws/1');
    expect(nodeUrl('ws://10.0.0.5:3003/ws', { protocol: 'http:', host: '10.0.0.5:3001', hostname: '10.0.0.5' })).toBe('ws://10.0.0.5:3003/ws');
    // Страница сама на петле (разработка) — адрес на петле достижим как есть.
    expect(nodeUrl('ws://127.0.0.1:3001/ws', { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' })).toBe('ws://127.0.0.1:3001/ws');
  });

  it('ответ гейтвея: адрес, очередь, отказ с причиной; «чей вход недействителен» — кодом', async () => {
    const asked = gateway(200, { url: 'wss://game.example/ws/2', node: 'node-2' });
    expect(await routeToNode('t0k', 'hero-1', undefined, 'C7K3F9XY')).toEqual({ url: 'wss://game.example/ws/2' });
    expect(asked).toEqual([{ url: '/api/route?charId=hero-1&roomCode=C7K3F9XY', auth: 'Bearer t0k' }]);
    const q = { ticket: 't-1', position: 4, total: 9 };
    gateway(503, { queue: q });
    expect(await routeToNode('t0k', 'hero-1', 't-1')).toEqual({ queue: q });
    gateway(404, { error: 'Комната не найдена: узел не отвечает' });
    expect(await routeToNode('t0k', 'hero-1', undefined, 'Z7K3F9XY')).toEqual({ error: 'Комната не найдена: узел не отвечает' });
    gateway(401, { error: 'Требуется вход' });
    expect(await routeToNode('t0k', 'hero-1')).toEqual({ error: 'Требуется вход', code: 'auth' });
    gateway(403, { error: 'Персонаж недоступен' });
    expect(await routeToNode('t0k', 'hero-1')).toEqual({ error: 'Персонаж недоступен', code: 'forbidden' });
  });

  it('маршрута нет или он сломался (старый сервер, 5xx, сеть) — адрес по умолчанию, клиент работает как в одиночном процессе', async () => {
    gateway(404, '<html>Cannot GET</html>');
    expect(await routeToNode('t0k', 'hero-1')).toEqual({ url: 'wss://game.example/ws' });
    gateway(500, { error: 'Внутренняя ошибка' });
    expect(await routeToNode('t0k', 'hero-1')).toEqual({ url: 'wss://game.example/ws' });
    gateway(503, { error: 'Игровые узлы недоступны' });
    expect(await routeToNode('t0k', 'hero-1')).toEqual({ url: 'wss://game.example/ws' });
    G.fetch = () => Promise.reject(new TypeError('сети нет'));
    expect(await routeToNode('t0k', 'hero-1')).toEqual({ url: 'wss://game.example/ws' });
  });
});
