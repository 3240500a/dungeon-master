import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Метрики сервера в формате Prometheus (задача Ф1.7 плана доработки).
 *
 * ЗАЧЕМ. До этого на сервере не было ни одного счётчика, поэтому любая правка проверялась
 * только синтетическим стендом, а на живых игроках — никак. Правило плана «у каждой правки
 * должно быть число до и после» без этого не работает в проде.
 *
 * ЧТО СМОТРИМ В ПЕРВУЮ ОЧЕРЕДЬ:
 *   dm_tick_hz          — падение ниже 28 значит мир идёт в слоу-мо (симптом, который однажды
 *                         уже проглядели: при 200 игроках было 13,9 Гц вместо 30);
 *   dm_loop_delay_ms    — выбросы p99 выше 50 мс означают блокирующую операцию в горячем пути;
 *   dm_snapshot_bytes   — КБ/с на игрока; после Ф1 обязано упасть на порядок и больше не расти;
 *   dm_dropped_ticks    — ненулевое значение это перегрузка, тик не укладывается в бюджет;
 *   dm_save_conflicts   — ненулевое значение это ИНЦИДЕНТ: две сессии на одного персонажа.
 *
 * Счётчики намеренно простые (числа в модуле, без библиотек): дешевле любой сборки метрик
 * и не тянет зависимость в горячий путь.
 */

/** Монотонно растущие счётчики. */
export const counters = {
  /** Разослано снапшотов (кадров) всего. */
  snapshotFrames: 0,
  /** Байт снапшотов, ушедших клиентам (после умножения на число получателей). */
  snapshotBytes: 0,
  /** Кадров принято от клиентов. */
  framesIn: 0,
  /** Кадров отброшено валидацией (Ф0.6). */
  framesInvalid: 0,
  /** Кадров ввода отброшено троттлингом (Ф0.8). */
  inputThrottled: 0,
  /** Отказов лимитеров частоты (Ф0.5). */
  rateLimited: 0,
  /** Шагов симуляции выброшено из-за перегрузки (Ф0.2). */
  droppedTicks: 0,
  /** Записей сейва, отклонённых по версии (Ф0.3). Ноль на исправном сервере. */
  saveConflicts: 0,
  /** Выселено живых сессий (Ф0.3): реконнекты и попытки двойного входа. */
  sessionsEvicted: 0,
  /** Шагов симуляции выполнено — из этого считается фактическая частота мира. */
  ticks: 0,
};

/** Мгновенные значения. */
export interface Gauges { rooms: number; players: number; connections: number; }

/**
 * Поставщик мгновенных значений. Раньше они обновлялись «по событию» (вход/выход) и к моменту
 * сборки метрик успевали протухнуть — на живом сервере это давало `dm_players 0` при живых
 * комнатах. Теперь считаем в момент запроса, у того, кто действительно знает состав.
 */
let gaugeProvider: (() => Gauges) | null = null;
export function setGaugeProvider(fn: () => Gauges): void { gaugeProvider = fn; }

const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();

// Частоту мира считаем как приращение `ticks` за интервал между сборками метрик:
// это фактическая частота, а не заданная.
// Считается ТОЛЬКО между двумя сборками. Первый запрос отдаёт 0, а не «среднее от старта
// процесса»: на старте комнат ещё нет, и такое среднее выглядит как слоу-мо, которого нет.
let lastTicks = -1;
let lastAt = 0;
let tickHz = 0;

/** Отдаёт метрики в текстовом формате Prometheus. */
export function renderMetrics(): string {
  const now = Date.now();
  const gauges: Gauges = gaugeProvider?.() ?? { rooms: 0, players: 0, connections: 0 };
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  const dt = (now - lastAt) / 1000;
  if (lastTicks < 0) { lastTicks = counters.ticks; lastAt = now; }
  else if (dt >= 1) {
    tickHz = (counters.ticks - lastTicks) / dt / Math.max(1, gauges.rooms);
    lastTicks = counters.ticks;
    lastAt = now;
  }

  const lines: string[] = [];
  const g = (name: string, help: string, value: number, type = 'gauge'): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };

  g('dm_rooms', 'Активных комнат под тиком', gauges.rooms);
  g('dm_players', 'Игроков в мире', gauges.players);
  g('dm_connections', 'Открытых WebSocket-соединений', gauges.connections);
  g('dm_tick_hz', 'Фактическая частота мира на комнату, Гц', Number(tickHz.toFixed(2)));
  g('dm_loop_delay_p50_ms', 'Задержка цикла событий, медиана', Number((loop.percentile(50) / 1e6).toFixed(2)));
  g('dm_loop_delay_p99_ms', 'Задержка цикла событий, p99', Number((loop.percentile(99) / 1e6).toFixed(2)));
  g('dm_loop_delay_max_ms', 'Задержка цикла событий, максимум с прошлой сборки', Number((loop.max / 1e6).toFixed(2)));
  g('dm_rss_bytes', 'Резидентная память процесса', mem.rss);
  g('dm_heap_used_bytes', 'Использовано кучи V8', mem.heapUsed);
  g('dm_cpu_user_seconds_total', 'Процессорное время в пользовательском режиме', cpu.user / 1e6, 'counter');
  g('dm_cpu_system_seconds_total', 'Процессорное время в системном режиме', cpu.system / 1e6, 'counter');

  g('dm_ticks_total', 'Шагов симуляции выполнено', counters.ticks, 'counter');
  g('dm_dropped_ticks_total', 'Шагов выброшено из-за перегрузки', counters.droppedTicks, 'counter');
  g('dm_snapshot_frames_total', 'Снапшотов разослано', counters.snapshotFrames, 'counter');
  g('dm_snapshot_bytes_total', 'Байт снапшотов разослано', counters.snapshotBytes, 'counter');
  g('dm_frames_in_total', 'Кадров принято от клиентов', counters.framesIn, 'counter');
  g('dm_frames_invalid_total', 'Кадров отброшено валидацией', counters.framesInvalid, 'counter');
  g('dm_input_throttled_total', 'Кадров ввода отброшено троттлингом', counters.inputThrottled, 'counter');
  g('dm_rate_limited_total', 'Отказов лимитеров частоты', counters.rateLimited, 'counter');
  g('dm_save_conflicts_total', 'Записей сейва отклонено по версии (ИНЦИДЕНТ, если растёт)', counters.saveConflicts, 'counter');
  g('dm_sessions_evicted_total', 'Живых сессий выселено при повторном входе', counters.sessionsEvicted, 'counter');

  loop.reset();
  return lines.join('\n') + '\n';
}
