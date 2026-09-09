import { describe, it, expect, vi, afterEach } from 'vitest';
import { counters, renderMetrics, setGaugeProvider } from './metrics.js';

/**
 * Регрессии на частоту мира — метрику, по которой нагрузочный стенд решает, здоров ли сервер.
 * Оба случая ниже наблюдались вживую и оба давали ЛОЖНЫЙ сигнал: первый занижал частоту втрое,
 * второй завышал почти вдвое.
 */

const value = (text: string, name: string): number => {
  const m = new RegExp(`^${name} (-?[\\d.e+]+)$`, 'm').exec(text);
  return m ? Number(m[1]) : NaN;
};

/** Прокрутить время и «натикать» столько, сколько дают `rooms` комнат за `secs` на 30 Гц. */
const advance = (secs: number, rooms: number): void => {
  vi.setSystemTime(new Date(Date.now() + secs * 1000));
  counters.ticks += rooms * 30 * secs;
  counters.roomSeconds += rooms * secs;
};

afterEach(() => {
  vi.useRealTimers();
  setGaugeProvider(() => ({ rooms: 0, ticking: 0, players: 0, connections: 0 }));
});

describe('dm_tick_hz', () => {
  it('не занижается паузами грейса: комнаты, снятые с планировщика, в знаменатель не входят', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // Десять комнат тикают, ещё девяносто висят в грейсе и не тикают.
    setGaugeProvider(() => ({ rooms: 100, ticking: 10, players: 10, connections: 10 }));

    renderMetrics(); // первая сборка только запоминает точку отсчёта
    advance(2, 10);

    const text = renderMetrics();
    expect(value(text, 'dm_tick_hz')).toBeCloseTo(30, 1);
    expect(value(text, 'dm_rooms')).toBe(100);
    expect(value(text, 'dm_rooms_ticking')).toBe(10);
  });

  it('не завышается, когда число комнат меняется ВНУТРИ окна замера', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let ticking = 12;
    setGaugeProvider(() => ({ rooms: ticking, ticking, players: ticking, connections: ticking }));

    renderMetrics();
    // Полокна работали двенадцать комнат, потом половина закрылась.
    advance(3, 12);
    ticking = 6;
    advance(3, 6);

    // Прежний способ (шаги ÷ время ÷ комнаты на момент замера) дал бы здесь 45 Гц.
    expect(value(renderMetrics(), 'dm_tick_hz')).toBeCloseTo(30, 1);
  });
});
