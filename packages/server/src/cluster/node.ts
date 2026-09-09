import { monitorEventLoopDelay } from 'node:perf_hooks';
import { counters, readGauges } from '../net/metrics.js';
import { heartbeat, releaseNode, touchClaims, initClusterSchema } from './registry.js';

/**
 * Игровая нода (Ф4.3): процесс, который занимается ТОЛЬКО комнатами.
 *
 * Здесь живёт всё, что делает процесс частью кластера: сердцебиение в реестр, продление
 * закреплений своих игроков и корректный уход с деплоя (Ф4.5).
 *
 * ПРО СЛИВ НОДЫ. Просто убить процесс нельзя: у людей внутри идут забеги. Поэтому на SIGTERM
 * нода сперва помечается «сливаемой» — гейтвей перестаёт слать к ней новых, — и только потом
 * дописывает сейвы и выходит. Механизм грейс-реконнекта (он уже был) доводит остальное:
 * игрок вернётся в свою комнату, когда нода поднимется.
 */

const BEAT_MS = 2_000;

let draining = false;
let beat: ReturnType<typeof setInterval> | undefined;

/** Идёт ли слив: гейтвей это видит и перестаёт присылать новых игроков. */
export function isDraining(): boolean { return draining; }

/**
 * Подключить процесс к кластеру. `charIds` — те, кого нода держит прямо сейчас: их
 * закрепление продлевается, чтобы игрок при обрыве вернулся именно сюда, к своей комнате.
 */
export async function joinCluster(
  nodeId: string, url: string, charIds: () => string[],
  loop: ReturnType<typeof monitorEventLoopDelay>,
): Promise<void> {
  await initClusterSchema();

  let lastTicks = counters.ticks;
  let lastRoomSeconds = counters.roomSeconds;
  let lastAt = Date.now();

  const send = async (): Promise<void> => {
    const g = readGauges();
    const cpu = process.cpuUsage();
    const now = Date.now();
    const dt = Math.max(0.001, (now - lastAt) / 1000);
    // Частота симуляции считается между двумя ударами сердца — по факту, а не по заданию.
    // Знаменатель — комнато-секунды за тот же интервал: паузы грейса не тикают, а число
    // комнат внутри интервала меняется, и «комнаты на момент замера» дают частоту, которой
    // не было (см. net/metrics.ts).
    const rs = counters.roomSeconds - lastRoomSeconds;
    const hz = rs > 0 ? (counters.ticks - lastTicks) / rs : 0;
    lastTicks = counters.ticks; lastRoomSeconds = counters.roomSeconds; lastAt = now;

    await heartbeat(nodeId, url, {
      players: g.players, rooms: g.rooms,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      rssBytes: process.memoryUsage().rss,
      loopP99: loop.percentile(99) / 1e6,
      tickHz: hz,
      draining,
    });
    loop.reset();
    await touchClaims(charIds());
  };

  await send();
  beat = setInterval(() => { void send().catch(() => undefined); }, BEAT_MS);
  beat.unref();
}

/**
 * Слив ноды (Ф4.5): перестать принимать новых, дать сохраниться, уйти.
 * `flush` — запись прогресса всех комнат; ждать её обязательно (Ф2: запись асинхронная).
 */
export function installNodeShutdown(nodeId: string, flush: () => Promise<unknown>): void {
  let leaving = false;
  const shutdown = (): void => {
    if (leaving) return;
    leaving = true;
    draining = true;
    console.log(`[${nodeId}] слив: новых игроков не принимаю, дописываю сейвы…`);
    // Предохранитель: если база молчит, всё равно выходим — иначе рестарт подвиснет.
    const done = (): never => process.exit(0);
    const guard = setTimeout(done, 8000);
    void (async () => {
      try {
        await flush();
        await releaseNode(nodeId);
      } catch (e) {
        console.error(`[${nodeId}] при сливе:`, e);
      } finally {
        clearTimeout(guard);
        if (beat) clearInterval(beat);
        done();
      }
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
