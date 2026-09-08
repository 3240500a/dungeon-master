import { LoadBot, sleep, type BotOptions } from './client.js';

/**
 * Нагрузочный стенд: поднимает N ботов против живого сервера и печатает вердикт с порогами.
 * Служит регрессионным гейтом для фаз плана доработки — каждая правка должна двигать числа
 * в нужную сторону, а не «казаться быстрее».
 *
 *   npm run loadtest -- --n=100 --secs=30
 *   npm run loadtest -- --n=100 --group=4 --hz=30 --base=http://127.0.0.1:3999
 *
 * Сервер поднимать отдельно: `npm run loadtest:server` (та же игра + самоотчёт CPU/лага цикла).
 */
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a) ?? /^--([^=]+)$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const num = (k: string, d: number): number => (args.has(k) ? Number(args.get(k)) : d);
const str = (k: string, d: string): string => args.get(k) ?? d;
const bool = (k: string, d: boolean): boolean => (args.has(k) ? args.get(k) !== 'false' : d);

const BASE = str('base', 'http://127.0.0.1:3999');
const N = num('n', 50);
const SECS = num('secs', 30);
const GROUP = num('group', 1);
const INPUT_HZ = num('hz', 30);
const DESCEND = bool('descend', true);
const TICK_HZ = num('tickHz', 30);      // норма частоты мира, с которой сравниваем
const RTT_LIMIT = num('rttLimit', 50);  // порог RTT медианы, мс (локально всё, что выше — уже проблема)

/** Пороги вердикта: тикрейт не ниже 95 % нормы, RTT в пределах, никто не отвалился, ошибок нет. */
function verdict(ok: boolean): string { return ok ? '✓' : '✗'; }

async function main(): Promise<void> {
  const tag = Math.random().toString(36).slice(2, 7);
  const roomCodes = new Map<number, string>();
  const bots: LoadBot[] = [];

  console.log(`[стенд] ${N} ботов, пати по ${GROUP}, ввод ${INPUT_HZ} Гц, спуск=${DESCEND}, сервер ${BASE}`);
  for (let i = 0; i < N; i++) {
    const o: BotOptions = { base: BASE, tag, index: i, classId: str('class', 'warrior'), inputHz: INPUT_HZ, groupSize: GROUP, descend: DESCEND, roomCodes };
    const bot = new LoadBot(o);
    try {
      await bot.start();
      bots.push(bot);
    } catch (e) {
      console.error(`[стенд] бот ${i} не поднялся: ${(e as Error).message}`);
    }
    await sleep(20); // не долбим регистрацию залпом — иначе меряем scrypt, а не игру
  }

  const warmup = num('warmup', 5);
  console.log(`[стенд] подключено ${bots.length}/${N}; прогрев ${warmup} с, затем замер ${SECS} с…`);
  await sleep(warmup * 1000);
  for (const b of bots) b.resetStats();

  const t0 = Date.now();
  await sleep(SECS * 1000);
  const dt = (Date.now() - t0) / 1000;

  const alive = bots.filter((b) => b.connected).length;
  const bytes = bots.reduce((a, b) => a + b.stats.bytes, 0);
  const snaps = bots.reduce((a, b) => a + b.stats.snapshots, 0);
  const errors = bots.flatMap((b) => b.stats.errors);
  const rtts = bots.filter((b) => b.stats.rttCount > 0).map((b) => b.stats.rttSum / b.stats.rttCount).sort((x, y) => x - y);
  const median = rtts.length ? rtts[Math.floor(rtts.length / 2)]! : NaN;
  const p95 = rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * 0.95))]! : NaN;
  const tickRate = snaps / dt / Math.max(alive, 1);
  const kbPerClient = bytes / dt / 1024 / Math.max(alive, 1);

  const okTick = tickRate >= TICK_HZ * 0.95;
  const okRtt = median <= RTT_LIMIT;
  const okAlive = alive === bots.length && bots.length === N;
  const okErr = errors.length === 0;

  console.log(`
────────────────────────────────────────────────────────
ИТОГ   ${N} ботов, пати по ${GROUP}, ${dt.toFixed(0)} с
  частота мира   ${tickRate.toFixed(1)} Гц   (норма ${TICK_HZ})        ${verdict(okTick)}
  RTT медиана    ${median.toFixed(1)} мс   (порог ${RTT_LIMIT})        ${verdict(okRtt)}
  RTT p95        ${p95.toFixed(1)} мс
  трафик вниз    ${kbPerClient.toFixed(0)} КБ/с на клиента · ${(bytes / dt / 1048576).toFixed(2)} МБ/с всего
  живых          ${alive}/${N}                          ${verdict(okAlive)}
  ошибок         ${errors.length}                              ${verdict(okErr)}
────────────────────────────────────────────────────────`);
  if (errors.length) {
    const uniq = [...new Set(errors)].slice(0, 5);
    for (const e of uniq) console.log(`  ! ${e}`);
  }

  for (const b of bots) b.stop();
  process.exit(okTick && okRtt && okAlive && okErr ? 0 : 1);
}

void main();
