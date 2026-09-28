import { fork, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LEASE_MS } from './lease.js';

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

/**
 * ⭐ R5-14: НОД НЕ БОЛЬШЕ, ЧЕМ БУКВ В КОДЕ КОМНАТЫ. Первая буква кода — нода (`A` + номер), букв 26. Раньше по умолчанию
 * поднималось до 32 нод: node-26…29 выдавали коды на A…D — те же, что node-0…3, гейтвей вёл вход к другу на первую ноду
 * с этой буквой, и там «Комната не найдена» (каждый промах ещё и платил лимит промахов, R4-18).
 */
export const MAX_NODES = 26;

/**
 * Сколько игровых нод поднимать. По умолчанию — ядра минус два (гейтвею и базе тоже надо жить), но не больше `MAX_NODES`.
 * R5-14: `DM_NODES` больше `MAX_NODES` — запуск падает с объяснением, а не делит буквы между нодами.
 */
export function nodeCount(env = process.env.DM_NODES, cores = cpus().length): number {
  const n = Math.floor(Number(env ?? 0));
  if (n > MAX_NODES) throw new Error(`DM_NODES=${n}: игровых нод не больше ${MAX_NODES} — первая буква кода комнаты называет ноду (A–Z)`);
  if (n > 0) return n;
  return Math.max(1, Math.min(MAX_NODES, cores - 2));
}

/** Что нужно остановке от процесса ребёнка (`ChildProcess`) — и тесту. */
interface ChildLike {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', cb: () => void): unknown;
}

/**
 * ⭐ R5-08: ребёнок ВЫШЕЛ — у него есть код выхода или сигнал, от которого он умер. `killed` — лишь «сигнал ОТПРАВЛЕН»: по
 * нему супервизор считал ноды вышедшими через 200 мс после SIGTERM и выходил сам, а systemd добивал ноды, ещё
 * дописывавшие сейвы.
 */
export function childGone(p: ChildLike | undefined): boolean {
  return !p || p.exitCode !== null || p.signalCode !== null;
}

/**
 * Остановить детей: SIGTERM каждому и ждать, пока ВЫЙДУТ все (событие `exit`), — не дольше `deadlineMs`; дольше — SIGKILL
 * оставшимся. `done` зовётся ровно один раз.
 * ⭐ ENV2: срок по умолчанию — аренда ноды с запасом: слив, пока база лежит, дописывает сейвы до конца аренды (`node.ts`, `drainBudget`), и
 * SIGKILL через прежние 12 с обрывал бы его посреди записи. База жива — ноды выходят за миллисекунды, срок не ждётся.
 */
export function stopChildren(procs: readonly (ChildLike | undefined)[], done: () => void, deadlineMs = LEASE_MS + 5_000): void {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    done();
  };
  const deadline = setTimeout(() => {
    for (const p of procs) if (!childGone(p)) p!.kill('SIGKILL');
    finish();
  }, deadlineMs);
  const check = (): void => { if (procs.every(childGone)) finish(); };
  for (const p of procs) {
    if (childGone(p)) continue;
    p!.once('exit', check);
    p!.kill('SIGTERM');
  }
  check();
}

interface Child { name: string; env: NodeJS.ProcessEnv; proc?: ChildProcess; restarts: number }

export function runSupervisor(): void {
  const port = Number(process.env.PORT ?? 3001);
  const n = nodeCount();
  const host = process.env.DM_NODE_HOST ?? '127.0.0.1';

  const kids: Child[] = [
    { name: 'gateway', env: { DM_ROLE: 'gateway', PORT: String(port) }, restarts: 0 },
  ];
  // ⭐ R5-13: доля потолка кластера на ноду — с запасом на перекос раскладки (гейтвей раздаёт по нодам не идеально ровно).
  // Нода сверх неё новых комнат не заводит: очередь гейтвея не обойти прямым подключением к ноде.
  const maxPlayers = Number(process.env.DM_MAX_PLAYERS ?? 0);
  const perNode = maxPlayers > 0 ? Math.ceil((maxPlayers / n) * 1.25) : 0;
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
        ...(perNode > 0 ? { DM_NODE_MAX_PLAYERS: String(perNode) } : {}),
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
    if (stopping) { console.log('[кластер] повторный сигнал остановки — уже жду нод'); return; }
    stopping = true;
    console.log('[кластер] останавливаю: жду, пока ноды допишут прогресс…');
    // ⭐ R5-08: ждём ВЫХОДА нод (`childGone`), а не отправки сигнала (`killed`).
    stopChildren(kids.map((k) => k.proc), () => process.exit(0));
  };
  // R5-08: `on`, а не `once` — повторный сигнал (systemd шлёт его всей группе) не должен убить супервизор, пока ноды пишут.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
