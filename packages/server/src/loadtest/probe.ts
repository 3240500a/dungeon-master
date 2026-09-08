import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Обёртка боевого сервера для нагрузочного стенда: поднимает ТОТ ЖЕ `index.ts` и раз в 3 секунды
 * печатает серверную сторону замера — CPU процесса, RSS и лаг цикла событий. Именно лаг цикла
 * показывает блокирующие операции в горячем пути (синхронный SQLite, тяжёлый JSON), которых
 * не видно с клиента.
 *
 *   npm run loadtest:server
 *   PORT=3999 DM_DB=data/loadtest.db npm run loadtest:server
 *
 * Отдельная БД по умолчанию: боты плодят аккаунты, боевую базу этим засорять нельзя.
 */
process.env.PORT ??= '3999';
process.env.DM_DB ??= 'data/loadtest.db';
process.env.NODE_ENV ??= 'production'; // как в проде: dev-роуты закрыты, кэш ассетов включён

const hist = monitorEventLoopDelay({ resolution: 5 });
hist.enable();

await import('../index.js');

let lastCpu = process.cpuUsage();
let lastAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const wallUs = (now - lastAt) * 1000;
  const pct = ((cpu.user + cpu.system) / wallUs) * 100;
  const rss = process.memoryUsage().rss / 1048576;
  console.log(
    `[стенд-сервер] CPU ${pct.toFixed(1)}% ядра | RSS ${rss.toFixed(0)} МБ | ` +
    `цикл p50 ${(hist.percentile(50) / 1e6).toFixed(2)} p99 ${(hist.percentile(99) / 1e6).toFixed(2)} max ${(hist.max / 1e6).toFixed(1)} мс`,
  );
  hist.reset();
  lastCpu = process.cpuUsage();
  lastAt = now;
}, 3000);
