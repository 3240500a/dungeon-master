import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from './app.js';

/**
 * ⭐ R4-24: ОТКАЗ КОМАНДЫ, КОТОРУЮ НИКТО НЕ ЖДЁТ, — ВИДЕН ИГРОКУ.
 *
 * «Купить» с полной сумкой, «Взять» второе такое же задание (R3-10), «Забрать награду», когда ей нет места, «Надеть»,
 * «Переложить», очко пассивки — эти команды уходят без ожидания (`sendCmd`). Сервер отвечает на каждую (`cmdResult` с
 * причиной и `error{code:'cmd'}`), но `error` с отказом команды поток входа глушит (его ждёт окно), а ответ без ждущего
 * `App` выбрасывал: клик не делал ничего, и никто не говорил почему. Теперь такой отказ — строкой в лог игры; отказ,
 * которого ЖДЁТ окно (ковка, верстак, сундук — `request`), окно и показывает, в лог он не дублируется.
 *
 * Браузерного WebSocket в node нет — подделка ровно тех свойств, которыми пользуется `NetClient`.
 */
class FakeWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static last: FakeWs | undefined;
  readyState = FakeWs.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWs.last = this; }
  send(): void { }
  close(): void { this.readyState = FakeWs.CLOSED; }
}

describe('⭐ R4-24: отказ команды без ждущего — в лог игры', () => {
  const G = globalThis as unknown as { WebSocket?: unknown; fetch?: unknown };
  let saved: { ws: unknown; fetch: unknown };
  beforeEach(() => {
    saved = { ws: G.WebSocket, fetch: G.fetch };
    G.WebSocket = FakeWs;
    G.fetch = () => Promise.reject(new Error('сети нет'));   // конфиг с сервера — не нужен
    vi.useFakeTimers();
  });
  afterEach(() => { G.WebSocket = saved.ws; G.fetch = saved.fetch; vi.useRealTimers(); });

  function game() {
    const app = new App();
    const log: string[] = [];
    app.bus.on('log:message', (m) => { log.push(m.text); });
    app.net.connect('ws://x/ws');
    const frame = (f: unknown): void => FakeWs.last!.onmessage!({ data: JSON.stringify(f) });
    return { app, log, frame };
  }

  it('⭐ «Купить» с полной сумкой: ответ-отказ без ждущего — одна строка с причиной (было: тишина)', () => {
    const g = game();
    g.frame({ t: 'cmdResult', id: 7, cmd: 'buy', ok: false, reason: 'Нет места' });
    expect(g.log).toHaveLength(1);
    expect(g.log[0]).toContain('Нет места');
    g.frame({ t: 'cmdResult', id: 8, cmd: 'acceptQuest', ok: false, reason: 'Такое задание уже взято — доска обновится позже' });
    expect(g.log.at(-1), 'R3-10: второй такой же квест').toContain('Такое задание уже взято');
  });

  it('успех без ждущего и отказ без причины — в лог не идут', () => {
    const g = game();
    g.frame({ t: 'cmdResult', id: 9, cmd: 'equip', ok: true });
    g.frame({ t: 'cmdResult', id: 10, cmd: 'equip', ok: false });
    expect(g.log).toEqual([]);
  });

  it('⭐ отказ, которого ЖДЁТ окно (`request`), — окну, в лог не дублируется', async () => {
    const g = game();
    const reply = g.app.request({ cmd: 'stashOpen' });
    const id = (g.app as unknown as { cmdId: number }).cmdId;
    g.frame({ t: 'cmdResult', id, cmd: 'stashOpen', ok: false, reason: 'Сундук недоступен' });
    expect(await reply).toMatchObject({ ok: false, reason: 'Сундук недоступен' });
    expect(g.log).toEqual([]);
  });

  it('один и тот же отказ подряд («Слишком часто» на зажатый клик) — одной строкой, а не лентой; спустя время — снова', () => {
    const g = game();
    for (let i = 0; i < 5; i++) g.frame({ t: 'cmdResult', id: 20 + i, cmd: 'buy', ok: false, reason: 'Слишком часто' });
    expect(g.log).toHaveLength(1);
    g.frame({ t: 'cmdResult', id: 30, cmd: 'buy', ok: false, reason: 'Недостаточно золота' });
    expect(g.log, 'другая причина — своя строка').toHaveLength(2);
    vi.advanceTimersByTime(5000);
    g.frame({ t: 'cmdResult', id: 31, cmd: 'buy', ok: false, reason: 'Недостаточно золота' });
    expect(g.log).toHaveLength(3);
  });
});
