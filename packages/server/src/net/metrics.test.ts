import { describe, it, expect, vi, afterEach } from 'vitest';
import { counters, renderMetrics, setGaugeProvider } from './metrics.js';

/**
 * Регрессия на делитель частоты мира.
 *
 * Комната в грейсе (все вышли, ждём реконнект час) ЖИВЁТ, но снята с планировщика и не тикает.
 * Пока `dm_tick_hz` делили на все комнаты процесса, каждая такая пауза занижала частоту:
 * на стенде 520 комнат в грейсе показали 5,8 Гц при живых 30, и ворота качества падали на
 * здоровом сервере. Делитель — только тикающие комнаты.
 */

const value = (text: string, name: string): number => {
  const m = new RegExp(`^${name} (-?[\\d.e+]+)$`, 'm').exec(text);
  return m ? Number(m[1]) : NaN;
};

afterEach(() => {
  vi.useRealTimers();
  setGaugeProvider(() => ({ rooms: 0, ticking: 0, players: 0, connections: 0 }));
});

describe('dm_tick_hz', () => {
  it('считается по тикающим комнатам, а не по всем', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    // Десять комнат тикают, ещё девяносто висят в грейсе.
    setGaugeProvider(() => ({ rooms: 100, ticking: 10, players: 10, connections: 10 }));

    renderMetrics(); // первая сборка только запоминает точку отсчёта
    const start = counters.ticks;
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    counters.ticks = start + 600; // 10 комнат × 30 Гц × 2 с

    const text = renderMetrics();
    expect(value(text, 'dm_tick_hz')).toBeCloseTo(30, 1);
    expect(value(text, 'dm_rooms')).toBe(100);
    expect(value(text, 'dm_rooms_ticking')).toBe(10);
  });
});
