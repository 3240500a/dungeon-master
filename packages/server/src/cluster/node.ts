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
/** Удар сердца вне расписания — объявить слив сразу (R3-12). Есть, пока нода в кластере. */
let beatNow: (() => Promise<void>) | undefined;
/** R4-28: нода снимается из реестра — новых ударов сердца нет, идущие дожидаются (`installNodeShutdown`). */
let stopped = false;
/** R4-28: удары сердца, ещё идущие в базу. */
const sending = new Set<Promise<void>>();
/** Слив ноды установлен (R3-12): выход процесса — только через него. */
let nodeShutdown = false;

/** Идёт ли слив: гейтвей это видит и перестаёт присылать новых игроков. */
export function isDraining(): boolean { return draining; }
/**
 * ⭐ R3-12: процессом выходит слив ноды — общий обработчик транспорта (`installShutdown`) уступает ему. Раньше на
 * SIGTERM срабатывали оба, и общий выходил первым — до снятия ноды из реестра и раньше, чем дожидался слив.
 */
export function nodeShutdownInstalled(): boolean { return nodeShutdown; }

/**
 * Подключить процесс к кластеру. `charIds` — те, кого нода держит прямо сейчас: их
 * закрепление продлевается, чтобы игрок при обрыве вернулся именно сюда, к своей комнате.
 * `onLost` (R2-05) — те из них, чьё закрепление уже у ЧУЖОЙ ноды: их копии здесь проиграли.
 */
export async function joinCluster(
  nodeId: string, url: string, charIds: () => string[],
  loop: ReturnType<typeof monitorEventLoopDelay>,
  onLost?: (charIds: string[]) => void,
  onGone?: (charIds: string[]) => void,
): Promise<void> {
  await initClusterSchema();

  let lastTicks = counters.ticks;
  let lastRoomSeconds = counters.roomSeconds;
  let lastAt = Date.now();

  const beatOnce = async (): Promise<void> => {
    if (stopped) return;   // R4-28: нода уже снимается из реестра — её строку и закрепления не возвращаем
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

    // ⭐ R7-09: СПЕРВА ПРОДЛИТЬ СВОИХ, ПОТОМ СЕРДЦЕ. Закрепление держится, пока на последнем ударе сердца нода держала героя
    // (`claimForJoin`): сердце раньше продления после долгого простоя базы — окно, где нода «жива», а герой «давно не
    // продлевался», и вход на соседнюю ноду забирал его вместе с правдой, которую нода держит недописанной копией. Продление
    // упало — сердце не бьётся: нода, не подтвердившая своих героев, живой их хозяйкой не выглядит.
    const held = charIds();
    const kept = await touchClaims(held, nodeId);
    await heartbeat(nodeId, url, {
      players: g.players, rooms: g.rooms,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      rssBytes: process.memoryUsage().rss,
      loopP99: loop.percentile(99) / 1e6,
      tickHz: hz,
      draining,
    });
    loop.reset();
    // ⭐ R2-05: закрепление героя у другой ноды, а сессия здесь — проигравшая копия (нода подвисла, и её
    // закрепление забрали). Снимаем её, а не играем дальше: иначе две живые копии одного героя.
    const lost = held.filter((id) => !kept.has(id));
    if (lost.length) onLost?.(lost);
    // ⭐ R4-28: пока продление шло в базу, герой мог уйти, и снятие его закрепления прошло раньше продления — тогда продление
    // вернуло закрепление без сессии, и вход по коду на другой ноде получал отказ до 30 с. Тех, кого нода уже не держит, —
    // снять снова (в очереди героя: вернувшегося за это время не снимет).
    const still = new Set(charIds());
    const gone = held.filter((id) => kept.has(id) && !still.has(id));
    if (gone.length) onGone?.(gone);
  };
  const send = (): Promise<void> => {
    const run = beatOnce();
    sending.add(run);
    void run.finally(() => sending.delete(run)).catch(() => undefined);
    return run;
  };

  await send();
  beatNow = send;
  beat = setInterval(() => { void send().catch(() => undefined); }, BEAT_MS);
  beat.unref();
}

/**
 * Слив ноды (Ф4.5): перестать принимать новых, дать сохраниться, уйти.
 * `flush` — запись прогресса всех комнат; ждать её обязательно (Ф2: запись асинхронная).
 *
 * R3-12: это ЕДИНСТВЕННЫЙ выход процесса ноды — общий обработчик транспорта ему уступает (`nodeShutdownInstalled`).
 * Порядок: слив объявлен сразу (удар сердца вне расписания — гейтвей перестаёт слать новых, не дожидаясь очередного
 * через две секунды; входы сюда отвечают «перезапускаемся»), сейвы дописаны, нода и её закрепления сняты из
 * реестра, выход. Всё — под одним предохранителем.
 */
export function installNodeShutdown(nodeId: string, flush: () => Promise<unknown>): void {
  nodeShutdown = true;
  let leaving = false;
  const shutdown = (): void => {
    // ⭐ R5-08: повторный сигнал (systemd шлёт SIGTERM всей группе, супервизор — свой, npm и tsx пересылают свой) — только в
    // лог: слив уже идёт и выйдет сам.
    if (leaving) { console.log(`[${nodeId}] повторный сигнал остановки — слив уже идёт`); return; }
    leaving = true;
    draining = true;
    console.log(`[${nodeId}] слив: новых игроков не принимаю, дописываю сейвы…`);
    // Предохранитель: если база молчит, всё равно выходим — иначе рестарт подвиснет.
    const done = (): never => process.exit(0);
    const guard = setTimeout(done, 8000);
    void (async () => {
      try {
        // Объявление слива — рядом с записью, а не перед ней: молчащая база не должна съедать время сейвов.
        const announce = (beatNow?.() ?? Promise.resolve()).catch((e: unknown) => console.warn(`[${nodeId}] объявить слив не удалось:`, e));
        await flush();
        await announce;
        // ⭐ R4-28: удары сердца — ДО снятия ноды: новых нет, идущие дописаны. Раньше удар по расписанию, ушедший в базу до
        // снятия, ложился после него — строка ноды и закрепления всех её игроков возвращались, и гейтвей ещё десять секунд
        // слал их на мёртвую ноду (а другие ноды им отказывали «герой на другом узле»).
        stopped = true;
        if (beat) clearInterval(beat);
        await Promise.allSettled([...sending]);
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
  // ⭐ R5-08: `on`, а не `once`. `once` снимал обработчик первым же сигналом, и ВТОРОЙ SIGTERM (а при деплое по DEPLOY.md их
  // приходит несколько) убивал процесс действием по умолчанию посреди записи сейвов: без дописанных копий и `releaseNode`.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
