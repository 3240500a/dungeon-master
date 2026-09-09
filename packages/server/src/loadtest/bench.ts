import { fork, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Расширенный прогон (финальный замер плана доработки).
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ `run.ts`. Тот отвечает на вопрос «держит ли сервер N ботов» и годится
 * регрессионным гейтом. Этот отвечает на главный вопрос плана — **сколько игроков держит
 * ядро** — и делает это тремя вещами, которых у прежнего стенда не было:
 *
 * 1. БОТЫ В ОТДЕЛЬНЫХ ПРОЦЕССАХ. Прежний стенд крутил всех ботов рядом с сервером в одном
 *    процессе. На сотне это ещё честно, дальше — нет: прогон на 400 ботах однажды показал
 *    одинаковые 11 кадров/с у двух разных транспортов, то есть мерил сам себя.
 * 2. ЗАЩИТА ОТ САМООБМАНА. Каждый рабочий сообщает свой расход процессора; если стенд вместе
 *    с сервером занял почти всю машину, ступень помечается НЕДОСТОВЕРНОЙ и поиск
 *    останавливается. Лучше честное «дальше мерить нечем», чем красивое число ни о чём.
 * 3. ПОИСК ПОТОЛКА СТУПЕНЯМИ. Боты добавляются, пока держатся ворота качества; последняя
 *    удержавшаяся ступень и есть ёмкость. Число при фиксированном N потолка не показывает.
 *
 * Ворота качества на ступени (все обязаны держаться):
 *   • кадров мира не ниже 95 % нормы — иначе клиент видит рывки;
 *   • частота СИМУЛЯЦИИ (`dm_tick_hz`) не ниже 28 — ниже мир идёт в слоу-мо, а это тот самый
 *     симптом, который однажды уже проглядели (при 200 игроках было 13,9 Гц вместо 30);
 *   • RTT медиана в пределах порога;
 *   • никто не отвалился, ошибок нет, расхождений дельт нет.
 *
 *   npm run bench:ramp
 *   npm run bench:ramp -- --from=50 --step=50 --max=600 --secs=40 --hz=30
 */
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a) ?? /^--([^=]+)$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const num = (k: string, d: number): number => (args.has(k) ? Number(args.get(k)) : d);
const str = (k: string, d: string): string => args.get(k) ?? d;

const BASE = str('base', 'http://127.0.0.1:3999');
const FROM = num('from', 50);
const STEP = num('step', 50);
const MAX = num('max', 600);
const SECS = num('secs', 40);
const WARMUP = num('warmup', 8);
const INPUT_HZ = num('hz', 30);
const GROUP = num('group', 1);
const RTT_LIMIT = num('rttLimit', 120);
const SNAP_HZ = num('snapHz', Number(process.env.DM_SNAPSHOT_HZ ?? 20));
const TICK_FLOOR = num('tickFloor', 28);
/** Рабочих процессов: половина ядер — оставляем машине место под сам сервер. */
const PROCS = num('procs', Math.max(2, Math.floor(cpus().length / 2)));
/** Доля машины, выше которой замер считается недостоверным (стенд мешает серверу). */
const BUSY_LIMIT = num('busyLimit', 0.75);

const CORES = cpus().length;
// Рабочий запускается ТЕМ ЖЕ загрузчиком, что и родитель (tsx), иначе TypeScript ему не по зубам.
const workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface WorkerStats {
  alive: number; total: number; bytes: number; snapshots: number;
  rtts: number[]; errors: string[]; errorCount: number;
  deltaChecks: number; deltaMismatches: number; cpuRatio: number;
}

/** Метрики сервера читаем прямо у него — так расход процессора берётся из первых рук. */
async function serverMetrics(): Promise<Record<string, number>> {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z_0-9]+) (-?[\d.e+]+)$/.exec(line.trim());
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

class Pool {
  private readonly procs: ChildProcess[] = [];
  private spawned = 0;

  start(): void {
    for (let i = 0; i < PROCS; i++) {
      const p = fork(workerPath, [], { execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      p.stderr?.on('data', (d: Buffer) => process.stderr.write(`[рабочий ${i}] ${d.toString()}`));
      this.procs.push(p);
    }
  }

  private ask<T>(p: ChildProcess, msg: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('рабочий не ответил')), timeoutMs);
      p.once('message', (m) => { clearTimeout(t); resolve(m as T); });
      p.send(msg);
    });
  }

  /** Добавить ботов, разложив поровну по процессам. Возвращает, сколько реально поднялось. */
  async add(n: number, tag: string): Promise<number> {
    const per = Math.ceil(n / this.procs.length);
    const opts = { base: BASE, tag, classId: 'warrior', inputHz: INPUT_HZ, groupSize: GROUP, descend: true };
    const jobs = this.procs.map((p, i) => {
      const mine = Math.max(0, Math.min(per, n - i * per));
      if (!mine) return Promise.resolve({ spawned: 0, failed: 0 });
      return this.ask<{ spawned: number; failed: number }>(
        p, { cmd: 'spawn', n: mine, startIndex: this.spawned + i * per, opts });
    });
    const res = await Promise.all(jobs);
    this.spawned += n;
    return res.reduce((a, r) => a + (r.failed ?? 0), 0);
  }

  async reset(): Promise<void> {
    await Promise.all(this.procs.map((p) => this.ask(p, { cmd: 'reset' })));
  }

  async stats(): Promise<WorkerStats> {
    const all = await Promise.all(this.procs.map((p) => this.ask<WorkerStats>(p, { cmd: 'stats' })));
    return {
      alive: all.reduce((a, s) => a + s.alive, 0),
      total: all.reduce((a, s) => a + s.total, 0),
      bytes: all.reduce((a, s) => a + s.bytes, 0),
      snapshots: all.reduce((a, s) => a + s.snapshots, 0),
      rtts: all.flatMap((s) => s.rtts),
      errors: all.flatMap((s) => s.errors).slice(0, 10),
      errorCount: all.reduce((a, s) => a + s.errorCount, 0),
      deltaChecks: all.reduce((a, s) => a + s.deltaChecks, 0),
      deltaMismatches: all.reduce((a, s) => a + s.deltaMismatches, 0),
      cpuRatio: all.reduce((a, s) => a + s.cpuRatio, 0),
    };
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.procs.map((p) => this.ask(p, { cmd: 'stop' }, 5000)));
    for (const p of this.procs) p.kill();
  }
}

interface StepResult {
  bots: number; alive: number; frameHz: number; tickHz: number;
  rttMedian: number; rttP95: number; kbPerClient: number;
  serverCpu: number; benchCpu: number; rssMb: number; loopP99: number;
  errors: number; mismatches: number; checks: number;
  ok: boolean; trustworthy: boolean; why: string[];
}

async function measureStep(pool: Pool, bots: number): Promise<StepResult> {
  await sleep(WARMUP * 1000);
  await pool.reset();
  const m0 = await serverMetrics();
  const t0 = Date.now();
  await sleep(SECS * 1000);
  const dt = (Date.now() - t0) / 1000;
  const s = await pool.stats();
  const m1 = await serverMetrics();

  // CPU сервера — по разнице счётчиков процессорного времени между двумя сборками.
  const cpuS = ((m1.dm_cpu_user_seconds_total ?? 0) - (m0.dm_cpu_user_seconds_total ?? 0))
    + ((m1.dm_cpu_system_seconds_total ?? 0) - (m0.dm_cpu_system_seconds_total ?? 0));
  const serverCpu = cpuS / dt;

  const rtts = s.rtts.sort((a, b) => a - b);
  const median = rtts.length ? rtts[Math.floor(rtts.length / 2)]! : NaN;
  const p95 = rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * 0.95))]! : NaN;
  const frameHz = s.snapshots / dt / Math.max(1, s.alive);
  const tickHz = m1.dm_tick_hz ?? 0;

  const why: string[] = [];
  if (frameHz < SNAP_HZ * 0.95) why.push(`кадров мира ${frameHz.toFixed(1)} < ${(SNAP_HZ * 0.95).toFixed(1)}`);
  if (tickHz && tickHz < TICK_FLOOR) why.push(`симуляция ${tickHz.toFixed(1)} Гц < ${TICK_FLOOR} — мир в слоу-мо`);
  if (!(median <= RTT_LIMIT)) why.push(`RTT ${median.toFixed(0)} мс > ${RTT_LIMIT}`);
  if (s.alive !== bots) why.push(`живых ${s.alive}/${bots}`);
  if (s.errorCount) why.push(`ошибок ${s.errorCount}`);
  if (s.deltaMismatches) why.push(`расхождений дельт ${s.deltaMismatches}`);

  // Стенд и сервер вместе не должны занимать машину целиком: иначе меряем очередь ОС.
  const busy = (serverCpu + s.cpuRatio) / CORES;
  const trustworthy = busy <= BUSY_LIMIT;

  return {
    bots, alive: s.alive, frameHz, tickHz, rttMedian: median, rttP95: p95,
    kbPerClient: s.bytes / dt / 1024 / Math.max(1, s.alive),
    serverCpu, benchCpu: s.cpuRatio, rssMb: (m1.dm_rss_bytes ?? 0) / 1048576,
    loopP99: m1.dm_loop_delay_p99_ms ?? 0,
    errors: s.errorCount, mismatches: s.deltaMismatches, checks: s.deltaChecks,
    ok: why.length === 0, trustworthy, why,
  };
}

async function main(): Promise<void> {
  const tag = Math.random().toString(36).slice(2, 7);
  console.log(`[стенд] поиск потолка: от ${FROM} шагом ${STEP} до ${MAX}, ступень ${SECS} с, ввод ${INPUT_HZ} Гц`);
  console.log(`[стенд] рабочих процессов ${PROCS} из ${CORES} ядер, сервер ${BASE}\n`);

  const pool = new Pool();
  pool.start();

  const rows: StepResult[] = [];
  let current = 0;
  let capacity = 0;

  for (let target = FROM; target <= MAX; target += STEP) {
    // Насыщенный сервер перестаёт успевать отвечать на регистрацию новых ботов — и это само
    // по себе результат: ступень не удалось даже собрать. Раньше стенд на этом падал с
    // трассой, теряя всё измеренное; теперь это штатный конец поиска.
    let failed = 0;
    try {
      failed = await pool.add(target - current, tag);
    } catch (e) {
      console.log(`${String(target).padStart(4)} ботов  ✗  ступень не собралась: ${(e as Error).message}`);
      console.log('        сервер уже не успевает принимать новых игроков — это и есть потолок');
      break;
    }
    current = target;
    if (failed) console.log(`[стенд] не поднялось ботов: ${failed}`);

    const r = await measureStep(pool, target);
    rows.push(r);

    const mark = !r.trustworthy ? '⚠ НЕДОСТОВЕРНО' : r.ok ? '✓' : '✗';
    console.log(
      `${String(target).padStart(4)} ботов  ${mark}  кадры ${r.frameHz.toFixed(1)}/с · тик ${r.tickHz.toFixed(1)} Гц · `
      + `RTT ${r.rttMedian.toFixed(0)}/${r.rttP95.toFixed(0)} мс · ${r.kbPerClient.toFixed(1)} КБ/с · `
      + `CPU сервер ${(r.serverCpu * 100).toFixed(0)}% стенд ${(r.benchCpu * 100).toFixed(0)}% · RSS ${r.rssMb.toFixed(0)} МБ`);
    if (r.why.length) console.log(`        ${r.why.join(' · ')}`);

    if (!r.trustworthy) {
      console.log('        стенд и сервер заняли машину — дальше меряется очередь ОС, а не сервер');
      break;
    }
    if (!r.ok) break;
    capacity = target;
  }

  await pool.stop();

  const last = rows[rows.length - 1];
  console.log('\n════════════════════════════════════════════════════════');
  const last2 = await serverMetrics().catch((): Record<string, number> => ({}));
  const nodes = last2.dm_nodes ?? 1;
  console.log(`ЁМКОСТЬ: ${capacity} игроков` + (nodes > 1
    ? ` на кластере из ${nodes} узлов (${Math.round(capacity / nodes)} на узел)`
    : ' на одном процессе (одно ядро симуляции)'));
  if (last && !last.trustworthy) {
    console.log('ОГОВОРКА: поиск остановлен не сервером, а машиной — настоящий потолок ВЫШЕ.');
    console.log('Чтобы найти его, нужен отдельный нагрузчик (--base на другую машину).');
  } else if (last && !last.ok) {
    console.log(`Ступень ${last.bots} не удержалась: ${last.why.join(' · ')}`);
  }
  const best = rows.find((r) => r.bots === capacity);
  if (best) {
    console.log(`На потолке: трафик ${best.kbPerClient.toFixed(1)} КБ/с на игрока, `
      + `CPU сервера ${(best.serverCpu * 100).toFixed(0)} % ядра, RSS ${best.rssMb.toFixed(0)} МБ, `
      + `лаг цикла p99 ${best.loopP99.toFixed(1)} мс`);
    console.log(`Сверок дельт на ступени: ${best.checks}, расхождений ${best.mismatches}`);
  }
  console.log('════════════════════════════════════════════════════════');
  process.exit(capacity > 0 ? 0 : 1);
}

void main();
