import { fork, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Супервизор кластера (Ф4.3): поднимает гейтвей и игровые ноды, следит, чтобы они жили.
 *
 * ЗАЧЕМ ОН НУЖЕН. Node однопоточен: один процесс — одно ядро. Замер части 4 показал, что
 * на потолке процесс съедает ядро целиком, а остальные пятнадцать простаивают. Никакая
 * оптимизация внутри процесса этого не меняет — нужны процессы.
 *
 * ЧТО ЗАПУСКАЕТСЯ:
 *   • гейтвей на `PORT` — HTTP, аккаунты, конфиг, статика, маршрутизация и очередь;
 *   • `DM_NODES` игровых нод на `PORT+1 …` — только WebSocket и комнаты.
 *
 * ПАДЕНИЕ НОДЫ НЕ РОНЯЕТ КЛАСТЕР: супервизор поднимает её заново, реестр вычищает мёртвую
 * запись, а игроки возвращаются механизмом грейс-реконнекта. Гейтвей тоже перезапускается —
 * пока он лежит, играющие внутри не страдают, потому что игра идёт мимо него.
 *
 * ПРО ПРИВЯЗКУ К ЯДРАМ (NUMA). На двухсокетной машине половину нод стоит прибить к каждому
 * узлу, иначе память ходит через межпроцессорную шину. Это делается снаружи (`taskset`,
 * `numactl`) и зависит от железа, поэтому здесь не зашито: `DM_NODE_PREFIX` позволяет
 * запускать ноды под нужной обёрткой.
 */

const entry = fileURLToPath(new URL('../index.ts', import.meta.url));

/** Сколько игровых нод поднимать. По умолчанию — ядра минус одно под гейтвей и базу. */
function nodeCount(): number {
  const env = Number(process.env.DM_NODES ?? 0);
  if (env > 0) return env;
  return Math.max(1, Math.min(32, cpus().length - 2));
}

interface Child { name: string; env: NodeJS.ProcessEnv; proc?: ChildProcess; restarts: number }

export function runSupervisor(): void {
  const port = Number(process.env.PORT ?? 3001);
  const n = nodeCount();
  const host = process.env.DM_NODE_HOST ?? '127.0.0.1';

  const kids: Child[] = [
    { name: 'gateway', env: { DM_ROLE: 'gateway', PORT: String(port) }, restarts: 0 },
  ];
  for (let i = 0; i < n; i++) {
    const p = port + 1 + i;
    kids.push({
      name: `node-${i}`,
      env: {
        DM_ROLE: 'node',
        DM_NODE_ID: `node-${i}`,
        PORT: String(p),
        // ВНУТРЕННИЙ порт express этой ноды. Разводить диапазоны обязательно: в режиме uws
        // игровой порт занимает uWS, а express уезжает на PORT+1 — и без явного указания
        // он сел бы на игровой порт СОСЕДНЕЙ ноды. Проверено: боты получали HTTP 200 вместо
        // рукопожатия WebSocket, потому что стучались к соседу.
        DM_HTTP_PORT: String(port + 1000 + i),
        // Адрес, который гейтвей отдаст клиенту. В бою здесь стоит внешний адрес или путь
        // за обратным прокси — см. docs/DEPLOY.md.
        DM_NODE_URL: process.env.DM_NODE_URL_TEMPLATE
          ? process.env.DM_NODE_URL_TEMPLATE.replace('{port}', String(p)).replace('{i}', String(i))
          : `ws://${host}:${p}/ws`,
      },
      restarts: 0,
    });
  }

  console.log(`[кластер] гейтвей на :${port}, игровых нод ${n} (порты ${port + 1}–${port + n})`);

  let stopping = false;
  const spawn = (k: Child): void => {
    const proc = fork(entry, [], {
      env: { ...process.env, ...k.env },
      execArgv: process.execArgv,     // тот же загрузчик (tsx), что у супервизора
      stdio: 'inherit',
    });
    k.proc = proc;
    proc.on('exit', (code, signal) => {
      if (stopping) return;
      k.restarts++;
      console.warn(`[кластер] ${k.name} завершился (код ${code}, сигнал ${signal}) — поднимаю заново, перезапуск #${k.restarts}`);
      // Пауза перед перезапуском: если процесс падает сразу, не крутим цикл на весь процессор.
      setTimeout(() => { if (!stopping) spawn(k); }, Math.min(10_000, 500 * k.restarts));
    });
  };
  for (const k of kids) spawn(k);

  /**
   * Остановка кластера: сигнал уходит ДЕТЯМ, и мы ждём, пока они допишут сейвы.
   * Убивать их сразу нельзя — у людей внутри идут забеги (Ф4.5).
   */
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('[кластер] останавливаю: жду, пока ноды допишут прогресс…');
    for (const k of kids) k.proc?.kill('SIGTERM');
    const deadline = setTimeout(() => {
      for (const k of kids) k.proc?.kill('SIGKILL');
      process.exit(0);
    }, 12_000);
    const check = setInterval(() => {
      if (kids.every((k) => !k.proc || k.proc.exitCode !== null || k.proc.killed)) {
        clearTimeout(deadline); clearInterval(check); process.exit(0);
      }
    }, 200);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
