import { LoadBot, type BotOptions } from './client.js';

/**
 * Рабочий процесс стенда (`bench.ts`).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЕ ПРОЦЕССЫ. Прежний стенд держал всех ботов в ОДНОМ процессе рядом с сервером.
 * На сотне ботов это ещё честно, а дальше — нет: однажды прогон на 400 ботах показал, что при
 * вводе 10 Гц оба транспорта дают одинаковые 11 кадров/с. Это был не результат, это стенд
 * упёрся сам в себя. Теперь боты разложены по процессам, и каждый сообщает СВОЙ расход
 * процессора — по сумме видно, когда мерить уже нельзя.
 *
 * Протокол с родителем простой и синхронный по смыслу: spawn → reset → stats → stop.
 */
type Msg =
  | { cmd: 'spawn'; n: number; opts: Omit<BotOptions, 'index' | 'roomCodes'>; startIndex: number }
  | { cmd: 'reset' }
  | { cmd: 'stats' }
  | { cmd: 'stop' };

const bots: LoadBot[] = [];
/** Коды комнат общие внутри процесса — пати собираются из ботов одного рабочего. */
const roomCodes = new Map<number, string>();
let cpuAt = process.cpuUsage();
let cpuSince = Date.now();

process.on('message', (m: Msg) => { void handle(m); });

async function handle(m: Msg): Promise<void> {
  switch (m.cmd) {
    case 'spawn': {
      let failed = 0;
      for (let i = 0; i < m.n; i++) {
        const bot = new LoadBot({ ...m.opts, index: m.startIndex + i, roomCodes });
        try { await bot.start(); bots.push(bot); } catch { failed++; }
        // Регистрация идёт вразбивку: залпом мы мерили бы scrypt, а не игру.
        await new Promise((r) => setTimeout(r, 20));
      }
      process.send?.({ ok: true, spawned: bots.length, failed });
      break;
    }
    case 'reset': {
      for (const b of bots) b.resetStats();
      cpuAt = process.cpuUsage();
      cpuSince = Date.now();
      process.send?.({ ok: true });
      break;
    }
    case 'stats': {
      const cpu = process.cpuUsage(cpuAt);
      const wallUs = Math.max(1, (Date.now() - cpuSince) * 1000);
      process.send?.({
        alive: bots.filter((b) => b.connected).length,
        total: bots.length,
        bytes: bots.reduce((a, b) => a + b.stats.bytes, 0),
        snapshots: bots.reduce((a, b) => a + b.stats.snapshots, 0),
        rttSum: bots.reduce((a, b) => a + b.stats.rttSum, 0),
        rttCount: bots.reduce((a, b) => a + b.stats.rttCount, 0),
        // Медиана считается родителем по средним каждого бота — так же, как в прежнем стенде.
        rtts: bots.filter((b) => b.stats.rttCount > 0).map((b) => b.stats.rttSum / b.stats.rttCount),
        errors: bots.flatMap((b) => b.stats.errors).slice(0, 20),
        errorCount: bots.reduce((a, b) => a + b.stats.errors.length, 0),
        deltaChecks: bots.reduce((a, b) => a + b.stats.deltaChecks, 0),
        deltaMismatches: bots.reduce((a, b) => a + b.stats.deltaMismatches, 0),
        cpuRatio: (cpu.user + cpu.system) / wallUs,   // доли ядра, потраченные ЭТИМ процессом
      });
      break;
    }
    case 'stop': {
      for (const b of bots) b.stop();
      process.send?.({ ok: true });
      setTimeout(() => process.exit(0), 200);
      break;
    }
  }
}
