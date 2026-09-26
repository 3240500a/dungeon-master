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
  /** Команд отклонено проверкой места (Ф3.1): городская команда прислана не из города. */
  cmdOutOfPlace: 0,
  /** Команд отброшено как повтор по номеру (Ф2.5). */
  cmdDuplicate: 0,
  /** Команд, не прошедших схему (D11): лишний ключ, не тот тип, мусор вместо объекта. */
  cmdInvalid: 0,
  /** Команд, чей обработчик бросил исключение (D11). Ноль на исправном сервере — растёт = ошибка в коде. */
  cmdFailed: 0,
  /** Команд кузницы, отклонённых лимитом частоты (D12). */
  cmdRateLimited: 0,
  /**
   * Команд города, отклонённых ОБЩИМ лимитом частоты (R1-11). Отдельно от кузницы (R2-25): поток экипировок и
   * перекладок — не злоупотребление кузницей, и настоящий упор в её лимит не должен в нём тонуть.
   */
  cmdTownRateLimited: 0,
  /**
   * Вещей, изъятых из сейва на записи (R2-02): леджер числит их за другим аккаунтом или отозванными. Ненулевое —
   * повод смотреть, откуда вещь пришла: выброс и подбор между аккаунтами закрыт, других законных путей нет.
   */
  ledgerConfiscated: 0,
  /** Кадров, на которых обработчик бросил синхронно (R2-01): кадр погашен, процесс жив. Ноль на исправном сервере. */
  frameErrors: 0,
  /**
   * Записей сундука, отклонённых по версии (D8): два героя одного аккаунта тронули сундук
   * одновременно. В отличие от `saveConflicts` это НЕ инцидент — так бывает законно; вторая
   * запись откатывается целиком, и игрок видит «попробуйте ещё раз».
   */
  stashConflicts: 0,
  /** Записей сейва, упавших с ошибкой базы (не по версии). Сейв остаётся в памяти до следующей записи. */
  saveErrors: 0,
  /**
   * Кузница (K7, §22): успешные ковки, переплавки скованного, разборы найденного (у кузнеца и на месте),
   * зачарования — записанные в базу. Повтор ключа ковки и отказы сюда не идут.
   */
  forgeCrafted: 0,
  forgeMelted: 0,
  forgeSalvaged: 0,
  forgeEnchanted: 0,
  /** Выселено живых сессий (Ф0.3): реконнекты и попытки двойного входа. */
  sessionsEvicted: 0,
  /**
   * Снято сессий, потерявших право писать (R1-01): база отказала по версии сейва, и сессия закрыта кодом 4009.
   * Растёт вместе с `saveConflicts`; ненулевое значение — повод посмотреть, кто писал этого героя в обход сессии.
   */
  sessionsStale: 0,
  /**
   * Неудачных фоновых попыток дописать копию героя, которую база не приняла на выходе (R3-19). Растёт — база
   * отказывает дольше короткого сбоя, а правда об этих героях живёт только в памяти ноды.
   */
  farewellRetryFailed: 0,
  /** Шагов симуляции выполнено — из этого считается фактическая частота мира. */
  ticks: 0,
  /** Отключено клиентов, не успевавших читать (переполнение исходящей очереди). */
  slowClientsDropped: 0,
  /** «Комната × секунда» под тиком — знаменатель частоты мира. */
  roomSeconds: 0,
};

/**
 * Мгновенные значения.
 *
 * `rooms` — все комнаты процесса, `ticking` — только те, что реально под планировщиком.
 * Различие не косметическое: комната, из которой все вышли из подземелья, ЖИВЁТ ещё час
 * (грейс на реконнект), но НЕ тикает. Пока частоту мира делили на все комнаты, каждая
 * такая пауза занижала `dm_tick_hz` — и ворота нагрузочного стенда падали на здоровом
 * сервере. Нашлось новым стендом: 520 комнат в грейсе давали 5,8 Гц при живых 30.
 */
export interface Gauges { rooms: number; ticking: number; players: number; connections: number; }

/**
 * Поставщик мгновенных значений. Раньше они обновлялись «по событию» (вход/выход) и к моменту
 * сборки метрик успевали протухнуть — на живом сервере это давало `dm_players 0` при живых
 * комнатах. Теперь считаем в момент запроса, у того, кто действительно знает состав.
 */
let gaugeProvider: (() => Gauges) | null = null;
export function setGaugeProvider(fn: () => Gauges): void { gaugeProvider = fn; }
/** Текущие показатели состава — нужны не только метрикам, но и сердцебиению ноды (Ф4). */
export function readGauges(): Gauges { return gaugeProvider?.() ?? { rooms: 0, ticking: 0, players: 0, connections: 0 }; }

const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();

// Частоту мира считаем как приращение `ticks` за интервал между сборками метрик:
// это фактическая частота, а не заданная.
// Считается ТОЛЬКО между двумя сборками. Первый запрос отдаёт 0, а не «среднее от старта
// процесса»: на старте комнат ещё нет, и такое среднее выглядит как слоу-мо, которого нет.
let lastTicks = -1;
let lastRoomSeconds = 0;
let lastAt = 0;
let tickHz = 0;

/** Отдаёт метрики в текстовом формате Prometheus. */
export function renderMetrics(): string {
  const now = Date.now();
  const gauges: Gauges = gaugeProvider?.() ?? { rooms: 0, ticking: 0, players: 0, connections: 0 };
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  const dt = (now - lastAt) / 1000;
  if (lastTicks < 0) { lastTicks = counters.ticks; lastRoomSeconds = counters.roomSeconds; lastAt = now; }
  else if (dt >= 1) {
    // Знаменатель — комнато-секунды за тот же интервал, а не «комнаты на момент замера».
    // Иначе изменение числа комнат ВНУТРИ окна даёт частоту, которой не было: замерено 52 Гц
    // при живых 30, когда за окно половина комнат закрылась.
    const rs = counters.roomSeconds - lastRoomSeconds;
    if (rs > 0) tickHz = (counters.ticks - lastTicks) / rs;
    lastTicks = counters.ticks;
    lastRoomSeconds = counters.roomSeconds;
    lastAt = now;
  }

  const lines: string[] = [];
  const g = (name: string, help: string, value: number, type = 'gauge'): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };

  g('dm_rooms', 'Комнат в процессе (включая паузу грейса)', gauges.rooms);
  g('dm_rooms_ticking', 'Комнат под планировщиком тиков', gauges.ticking);
  g('dm_slow_clients_dropped_total', 'Отключено клиентов из-за переполнения исходящей очереди', counters.slowClientsDropped, 'counter');
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
  g('dm_sessions_stale_total', 'Сессий снято за устаревший сейв (R1-01)', counters.sessionsStale, 'counter');
  g('dm_cmd_out_of_place_total', 'Городских команд прислано не из города (Ф3.1)', counters.cmdOutOfPlace, 'counter');
  g('dm_cmd_duplicate_total', 'Команд отброшено как повтор по номеру (Ф2.5)', counters.cmdDuplicate, 'counter');
  g('dm_cmd_invalid_total', 'Команд отброшено схемой (D11)', counters.cmdInvalid, 'counter');
  g('dm_cmd_failed_total', 'Команд, чей обработчик бросил исключение (ОШИБКА, если растёт)', counters.cmdFailed, 'counter');
  g('dm_cmd_rate_limited_total', 'Команд кузницы отклонено лимитом частоты (D12)', counters.cmdRateLimited, 'counter');
  g('dm_cmd_town_rate_limited_total', 'Команд города отклонено общим лимитом частоты (R1-11)', counters.cmdTownRateLimited, 'counter');
  g('dm_ledger_confiscated_total', 'Вещей чужого аккаунта или отозванных изъято из сейва на записи (R2-02)', counters.ledgerConfiscated, 'counter');
  g('dm_frame_errors_total', 'Кадров, погашенных из-за исключения в обработчике (R2-01; ОШИБКА, если растёт)', counters.frameErrors, 'counter');
  g('dm_stash_conflicts_total', 'Записей сундука отклонено по версии (D8)', counters.stashConflicts, 'counter');
  g('dm_save_errors_total', 'Записей сейва, упавших с ошибкой базы', counters.saveErrors, 'counter');
  g('dm_farewell_retry_failed_total', 'Фоновых попыток дописать недописанную копию героя, снова упавших (R3-19)', counters.farewellRetryFailed, 'counter');
  g('dm_forge_crafted_total', 'Вещей скованно (K7)', counters.forgeCrafted, 'counter');
  g('dm_forge_melted_total', 'Скованных вещей переплавлено (K7)', counters.forgeMelted, 'counter');
  g('dm_forge_salvaged_total', 'Найденных вещей разобрано — у кузнеца и на месте (K7)', counters.forgeSalvaged, 'counter');
  g('dm_forge_enchanted_total', 'Скованных вещей зачаровано (K7)', counters.forgeEnchanted, 'counter');

  loop.reset();
  return lines.join('\n') + '\n';
}
