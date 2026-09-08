import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TickScheduler, TICK_MS } from './scheduler.js';

/**
 * Планировщик тиков (Ф0.2). Главное, что проверяем: игровое время НЕ отстаёт от реального,
 * даже когда цикл событий занят — иначе мир идёт в слоу-мо (ровно тот баг, который чиним).
 */
describe('TickScheduler', () => {
  // Планировщик намеренно считает время по МОНОТОННЫМ часам (`performance.now`), а не по
  // `Date.now`: настенные часы могут прыгнуть от NTP и утащить игровой цикл. Vitest по умолчанию
  // `performance` не подменяет, поэтому просим об этом явно.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  /** Комната-заглушка: считает шаги и разосланные снапшоты. */
  function fakeRoom() {
    const r = { steps: 0, emits: 0, step(emit: boolean) { r.steps++; if (emit) r.emits++; } };
    return r;
  }

  it('за секунду реального времени делает ~30 шагов симуляции', () => {
    const s = new TickScheduler();
    const room = fakeRoom();
    s.add(room);
    vi.advanceTimersByTime(1000);
    // Допуск на случайный стартовый сдвиг комнаты внутри окна тика.
    expect(room.steps).toBeGreaterThanOrEqual(28);
    expect(room.steps).toBeLessThanOrEqual(31);
    s.stop();
  });

  it('догоняет пропущенные шаги, если цикл был занят (мир не уходит в слоу-мо)', () => {
    const s = new TickScheduler();
    const room = fakeRoom();
    s.add(room);
    // Одно длинное пробуждение вместо череды коротких: имитируем занятый цикл.
    vi.advanceTimersByTime(500);
    const after = room.steps;
    expect(after).toBeGreaterThanOrEqual(13); // ~15 шагов за 500 мс, а не 1
    s.stop();
  });

  it('снапшот шлётся один раз на пачку догона, а не на каждый шаг', () => {
    const s = new TickScheduler();
    const room = fakeRoom();
    s.add(room);
    vi.advanceTimersByTime(1000);
    expect(room.emits).toBeLessThanOrEqual(room.steps);
    expect(room.emits).toBeGreaterThan(0);
    s.stop();
  });

  it('в штатном режиме не выбрасывает ни одного шага', () => {
    const s = new TickScheduler();
    const room = fakeRoom();
    s.add(room);
    vi.advanceTimersByTime(10_000);
    // droppedTicks — счётчик ПЕРЕГРУЗКИ: он должен быть нулём, пока сервер успевает.
    // Ненулевое значение на живом сервере означает, что тик не укладывается в бюджет.
    // (Сам предохранитель от спирали срабатывает только при реальной занятости цикла —
    // фейковые таймеры её не воспроизводят, там время идёт ровно по расписанию.)
    expect(s.droppedTicks).toBe(0);
    expect(room.steps).toBeGreaterThanOrEqual(298);
    s.stop();
  });

  it('add/remove управляют участием комнаты в тике', () => {
    const s = new TickScheduler();
    const room = fakeRoom();
    s.add(room);
    expect(s.size).toBe(1);
    vi.advanceTimersByTime(200);
    const during = room.steps;
    expect(during).toBeGreaterThan(0);
    s.remove(room);
    expect(s.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(room.steps).toBe(during); // после remove не тикает
    s.stop();
  });

  it('повторный add не удваивает тик комнаты', () => {
    const s = new TickScheduler();
    const room = fakeRoom();
    s.add(room);
    s.add(room);
    expect(s.size).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(room.steps).toBeLessThanOrEqual(31);
    s.stop();
  });

  it('ошибка в одной комнате не мешает тикать другой', () => {
    const s = new TickScheduler();
    const bad = { step(): void { throw new Error('бум'); } };
    const good = fakeRoom();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.add(bad);
    s.add(good);
    vi.advanceTimersByTime(500);
    expect(good.steps).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    s.stop();
  });

  it('TICK_MS соответствует 30 Гц', () => {
    expect(TICK_MS).toBeCloseTo(1000 / 30, 6);
  });
});
