/**
 * Единый планировщик тиков всех комнат процесса (задача Ф0.2 плана доработки сервера).
 *
 * ЗАЧЕМ. Раньше у каждой комнаты был свой `setInterval(step, 33)`. Node переставляет интервал
 * ПОСЛЕ колбэка, поэтому любая занятость цикла копится в дрейф: под нагрузкой 200 игроков мир
 * шёл 13,9 Гц вместо 30 — то есть игровое время текло в 46 % от реального, и это выглядело
 * не как лаг, а как слоу-мо. Вдобавок все интервалы заводились почти одновременно и били
 * одной пачкой в одном обороте цикла.
 *
 * КАК ЧИНИМ. Один таймер на процесс с мелким шагом опроса; у каждой комнаты своё время
 * следующего тика, накапливаемое ФИКСИРОВАННЫМИ шагами от предыдущего (`nextAt += TICK_MS`),
 * а не от момента фактического пробуждения. Отстали — догоняем несколькими шагами симуляции,
 * чтобы игровое время совпадало с реальным. Снапшот при этом шлём ОДИН раз в конце пачки:
 * клиенту нужно актуальное состояние, а не история промежуточных шагов.
 *
 * Комнаты стартуют со случайным сдвигом внутри тика — работа размазывается по окну вместо
 * всплеска «все комнаты в одном обороте цикла».
 *
 * ЗАЩИТА ОТ СПИРАЛИ. Если комната отстала больше чем на `MAX_CATCHUP` шагов (сервер реально
 * не тянет), догонять бессмысленно — это только усугубит отставание. Тогда ресинхронизируемся
 * на текущий момент и считаем пропуск: счётчик `droppedTicks` виден снаружи и должен быть
 * нулём на здоровом сервере.
 */

import { counters } from './metrics.js';

/** Комната, которую умеет тикать планировщик. */
export interface Tickable {
  /**
   * Продвинуть симуляцию ровно на один фиксированный шаг.
   * @param emit слать ли снапшот — true только на последнем шаге пачки догона.
   */
  step(emit: boolean): void;
}

/** Шаг симуляции, мс. Тот же, что был у `setInterval` в комнате. */
export const TICK_MS = 1000 / 30;
/** Сколько шагов подряд разрешено догонять за одно пробуждение. */
const MAX_CATCHUP = 4;
/** Шаг опроса планировщика, мс. Мельче тика, чтобы комнаты со сдвигом попадали в своё время. */
const SLICE_MS = 4;

interface Entry { room: Tickable; nextAt: number; }

export class TickScheduler {
  private readonly entries = new Map<Tickable, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = 0;
  /** Сколько шагов симуляции пришлось выбросить из-за перегрузки. Ноль на здоровом сервере. */
  droppedTicks = 0;

  /** Число комнат под тиком — для метрик и тестов. */
  get size(): number { return this.entries.size; }

  /** Поставить комнату на тик. Повторный вызов для той же комнаты ничего не делает. */
  add(room: Tickable): void {
    if (this.entries.has(room)) return;
    const now = performance.now();
    // Случайный сдвиг внутри окна тика — размазывает нагрузку по циклу вместо всплеска.
    this.entries.set(room, { room, nextAt: now + Math.random() * TICK_MS });
    this.ensureRunning(now);
  }

  /** Снять комнату с тика (пауза грейса, уничтожение комнаты). */
  remove(room: Tickable): void {
    this.entries.delete(room);
    if (this.entries.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  has(room: Tickable): boolean { return this.entries.has(room); }

  /** Остановить планировщик целиком (выключение процесса). */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.entries.clear();
  }

  private ensureRunning(now: number): void {
    if (this.timer) return;
    this.wakeAt = now;
    this.schedule(now);
  }

  /** Планирует следующее пробуждение так, чтобы сетка опроса не дрейфовала. */
  private schedule(now: number): void {
    this.wakeAt += SLICE_MS;
    if (this.wakeAt < now) this.wakeAt = now + SLICE_MS; // сильно отстали — начинаем сетку заново
    this.timer = setTimeout(() => this.tick(), Math.max(0, this.wakeAt - now));
  }

  private tick(): void {
    const now = performance.now();
    for (const e of this.entries.values()) {
      if (e.nextAt > now) continue;

      // Сколько фиксированных шагов пропущено с прошлого раза.
      let steps = 0;
      while (e.nextAt <= now && steps < MAX_CATCHUP) { e.nextAt += TICK_MS; steps++; }
      if (e.nextAt <= now) {
        // Отстали сильнее, чем готовы догонять: ресинк, чтобы не уйти в спираль.
        const behind = Math.ceil((now - e.nextAt) / TICK_MS);
        this.droppedTicks += behind;
        counters.droppedTicks += behind;
        e.nextAt = now + TICK_MS;
      }

      for (let i = 0; i < steps; i++) {
        try {
          e.room.step(i === steps - 1); // снапшот только на последнем шаге пачки
        } catch (err) {
          // Падение одной комнаты не должно ронять тик остальных.
          console.error('[scheduler] ошибка в тике комнаты:', err);
        }
      }
    }
    if (this.entries.size > 0) this.schedule(performance.now());
    else this.timer = null;
  }
}

/** Планировщик процесса. Один на весь сервер — в этом вся суть задачи. */
export const tickScheduler = new TickScheduler();
