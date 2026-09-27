import type { Server } from 'node:http';

/**
 * Слушать `port` — с повтором, пока порт занят (EADDRINUSE): при dev-рестарте старый инстанс может ещё держать порт — НЕ роняем
 * процесс необработанной ошибкой (иначе сервер умирает и редактор/клиент ловят ECONNREFUSED), а ждём освобождения и повторяем.
 * Вынесено из `index.ts`, чтобы стоять под тестом: импорт `index.ts` поднимает сервер и лезет в базу.
 *
 * ⭐ R10-16: ПОВТОР — НА ТОТ ЖЕ АДРЕС (`host`). Раньше повтор звал `listen(port)` без адреса: express в режиме uWS, которому положено
 * слушать только петлю, после первой же занятости порта вставал на все интерфейсы — прямой ход к нему из сети мимо прокси (его фильтра
 * запросов и потолка тела, R4-11, R5-01). На Windows такой повтор проходил сразу, пока старый инстанс ещё держал петлю.
 */
export function listenWithRetry(
  server: Server, port: number, host: string | undefined,
  o: { tries?: number; delayMs?: number; onFatal: (e: NodeJS.ErrnoException) => void; onListening?: () => void },
): void {
  const maxTries = o.tries ?? 10;
  const delayMs = o.delayMs ?? 500;
  let tries = 0;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && tries < maxTries) {
      tries++;
      console.warn(`[dm-server] порт ${port} занят (рестарт dev?) — повтор #${tries} через ${delayMs}мс…`);
      setTimeout(() => server.listen(port, host), delayMs);
    } else {
      o.onFatal(err);
    }
  });
  server.listen(port, host, () => {
    tries = 0;
    o.onListening?.();
  });
}
