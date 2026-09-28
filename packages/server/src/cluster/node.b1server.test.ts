import { describe, it, expect, vi, afterEach } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * ⭐ ФАЗЗЕР КЛАСТЕРА B1, ПРОХОД ПРАВОК 1 (сервер), нода:
 *  • ENV1: нода держит АРЕНДУ (`lease.ts`): дошедший удар сердца продлевает её до `NODE_DEAD_SEC − запас` от отправки; на исходе нода сама
 *    начинает свой слив и выходит РАНЬШЕ, чем реестр вправе отдать её героев и забеги другой (раньше молчащая нода играла дальше, и герой
 *    жил на двух нодах); проснулась после конца аренды — выход сразу, без записи; забег, числящийся за другой нодой, — комнатам (`runsLost`);
 *  • ENV2: дописка слива идёт до конца аренды, а не 7,5 с: база, вернувшаяся на девятой секунде, копии принимает;
 *  • ⭐ R16 C-05: аренда на исходе слива не начинает — удар, дошедший до её конца (база вернулась на 105-й секунде простоя), продлевает её, и
 *    нода играет дальше (раньше неотменяемый слив уводил все ноды разом, а их старт снимал забеги героев); конец аренды — выход без записи.
 * Реестр замокан; время — поддельное (`Date` и таймеры), выход процесса — перехвачен.
 */
const reg = vi.hoisted(() => ({
  order: [] as string[],
  /** Удар сердца падает (раздел с базой, реестр недоступен). */
  beatFails: false,
  /** Забеги, которые реестр числит за другой нодой (`touchRuns` их не возвращает). */
  lostRuns: [] as string[],
  /** ⭐ R16 C-05: удар сердца доходит с задержкой (мс поддельного времени). */
  beatDelayMs: 0,
}));
vi.mock('./registry.js', () => ({
  initClusterSchema: () => Promise.resolve(),
  heartbeat: async (_id: string, _url: string, s: { draining: boolean }) => {
    if (reg.beatFails) throw new Error('реестр не ответил');
    if (reg.beatDelayMs) await new Promise((res) => setTimeout(res, reg.beatDelayMs));
    reg.order.push(`beat draining=${s.draining}`);
  },
  touchClaims: (ids: string[]) => Promise.resolve(new Set(ids)),
  touchRuns: (rs: { key: string }[]) => Promise.resolve(new Set(rs.map((r) => r.key).filter((k) => !reg.lostRuns.includes(k)))),
  releaseNode: async () => { reg.order.push('releaseNode'); },
}));
vi.mock('../db/db.js', () => ({}));

const URL = 'ws://127.0.0.1:1/ws';
let loop: ReturnType<typeof monitorEventLoopDelay> | undefined;

/** Свежий процесс ноды (свой граф модулей: аренда, слив, удары), сигналы и выход — перехвачены. */
async function fresh(): Promise<{ node: typeof import('./node.js'); lease: typeof import('./lease.js'); claim: typeof import('./claimRule.js') }> {
  vi.resetModules();
  reg.order.length = 0; reg.beatFails = false; reg.lostRuns = []; reg.beatDelayMs = 0;
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: () => void) => {
    if (ev === 'SIGTERM' || ev === 'SIGINT') { if (ev === 'SIGTERM') sigterm.push(fn); return process; }
    return realOn(ev as never, fn as never);
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { reg.order.push(`exit ${code ?? 0} @${Date.now()}`); }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  loop = monitorEventLoopDelay({ resolution: 5 });
  return { node: await import('./node.js'), lease: await import('./lease.js'), claim: await import('./claimRule.js') };
}
const sigterm: (() => void)[] = [];
/** Слив дошёл до выхода (предохранитель снят) — иначе его выход достался бы уже следующему тесту. */
async function exited(): Promise<void> {
  await vi.waitFor(() => { if (!reg.order.some((s) => s.startsWith('exit'))) throw new Error(`выхода ещё нет: ${reg.order.join(' → ')}`); }, { timeout: 10_000, interval: 5 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  loop?.disable();
  sigterm.length = 0;
});

describe('⭐ ENV1: аренда ноды — молчащая нода отгораживает себя сама', () => {
  it('удар сердца не доходит — до конца аренды нода играет, с её концом — выход без записи РАНЬШЕ срока, после которого реестр отдаёт её героев', async () => {
    const { node, lease, claim } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const t0 = Date.now();
    await node.joinCluster('node-l1', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    expect(lease.leaseLeft(), 'дошедший удар — аренда на весь срок').toBe(lease.LEASE_MS);
    const flushed: number[] = [];
    node.installNodeShutdown('node-l1', async (budget) => { flushed.push(budget); reg.order.push('flush'); });
    reg.beatFails = true;   // дальше удары не доходят
    await vi.advanceTimersByTimeAsync(lease.LEASE_MS - 4_000);
    // ⭐ R16 C-05: на исходе аренды — не слив (заморозка комнат, снятие из реестра, выход — не отменить): удар, дошедший до её конца, продлит её.
    expect(flushed, 'аренда на исходе — слива нет').toEqual([]);
    expect(node.isDraining()).toBe(false);
    expect(reg.order.some((s) => s.startsWith('exit'))).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    const exit = reg.order.find((s) => s.startsWith('exit'));
    expect(exit, reg.order.join(' → ')).toBeDefined();
    expect(exit!.split(' @')[0], 'выход без записи').toBe('exit 1');
    const at = Number(exit!.split('@')[1]);
    expect(at - t0, 'с концом аренды').toBeLessThanOrEqual(lease.LEASE_MS + 1_000);
    expect(at - t0, 'и до срока смерти в реестре').toBeLessThan(claim.NODE_DEAD_SEC * 1000);
    expect(flushed, 'без дописки: строки героев с концом аренды пишет только тот, кому их отдаст реестр').toEqual([]);
    expect(reg.order, 'и без снятия из реестра').not.toContain('releaseNode');
  });

  it('⭐ R16 C-05: база вернулась на 105-й секунде простоя (до конца аренды) — удар её продлевает, слива и выхода нет', async () => {
    const { node, lease } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    await node.joinCluster('node-l6', URL, () => ['c1', 'c2'], loop!, undefined, undefined, () => [], { lease: true });
    node.installNodeShutdown('node-l6', async () => { reg.order.push('flush'); });
    reg.beatFails = true;                              // Postgres лёг для всего кластера
    await vi.advanceTimersByTimeAsync(105_000);
    expect(lease.leaseLeft(), 'аренда на исходе').toBeLessThanOrEqual(8_000);
    reg.beatFails = false;                             // вернулся — раньше конца аренды и срока смерти в реестре
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lease.leaseLeft(), 'аренда продлена').toBeGreaterThan(lease.LEASE_MS - 3_000);
    expect(node.isDraining(), 'слива нет').toBe(false);
    expect(reg.order.filter((s) => s.startsWith('exit') || s === 'flush' || s === 'releaseNode'), reg.order.join(' → ')).toEqual([]);
  });

  it('⭐ R16 C-05: удар, дошедший уже ПОСЛЕ конца аренды, её не продлевает — нода уходит', async () => {
    const { node, lease } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    await node.joinCluster('node-l7', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    node.installNodeShutdown('node-l7', async () => { reg.order.push('flush'); });
    reg.beatFails = true;
    await vi.advanceTimersByTimeAsync(lease.LEASE_MS - 2_500);
    reg.beatFails = false;
    reg.beatDelayMs = 6_000;                           // база ответила, но удар, отправленный до конца аренды, дошёл после
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reg.order.some((s) => s.startsWith('exit 1')), reg.order.join(' → ')).toBe(true);
    expect(lease.leaseLost(), 'опоздавший удар аренду не вернул').toBe(true);
  });

  it('проснулась после конца аренды (заморозка процесса) — выход сразу, без дописки и снятия из реестра', async () => {
    const { node, lease } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    await node.joinCluster('node-l2', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    const flushed: number[] = [];
    node.installNodeShutdown('node-l2', async (budget) => { flushed.push(budget); });
    reg.beatFails = true;
    vi.setSystemTime(Date.now() + lease.LEASE_MS + 5_000);   // процесс стоял — часы ушли, таймеры не срабатывали
    expect(lease.leaseLost(), 'аренда кончилась').toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reg.order.filter((s) => s.startsWith('exit')).map((s) => s.split(' @')[0]), reg.order.join(' → ')).toContain('exit 1');
    expect(flushed, 'без записи: строки героев уже вправе писать другая нода').toEqual([]);
    expect(reg.order, 'и без снятия из реестра').not.toContain('releaseNode');
  });

  it('удар дошёл снова — аренда продлена, слива нет', async () => {
    const { node, lease } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    await node.joinCluster('node-l3', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    node.installNodeShutdown('node-l3', async () => { reg.order.push('flush'); });
    reg.beatFails = true;
    await vi.advanceTimersByTimeAsync(lease.LEASE_MS - 20_000);
    reg.beatFails = false;   // раздел кончился за 20 с до конца аренды
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lease.leaseLeft()).toBeGreaterThan(lease.LEASE_MS - 3_000);
    expect(node.isDraining()).toBe(false);
    expect(reg.order).not.toContain('flush');
  });

  it('роль single аренды не держит: молчание базы её не сливает (отдать её героев некому)', async () => {
    const { node, lease } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    await node.joinCluster('node-l4', URL, () => ['c1'], loop!, undefined, undefined, () => []);
    node.installNodeShutdown('node-l4', async () => { reg.order.push('flush'); });
    reg.beatFails = true;
    await vi.advanceTimersByTimeAsync(lease.LEASE_MS + 30_000);
    expect(lease.leaseLeft()).toBe(Infinity);
    expect(node.isDraining()).toBe(false);
    expect(reg.order.filter((s) => s.startsWith('exit') || s === 'flush')).toEqual([]);
  });

  it('забег, который реестр числит за другой нодой, — комнатам ноды (`runsLost`), а не только строка в лог', async () => {
    const { node } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reg.lostRuns = ['run-b'];
    const lost: { key: string; room: string }[][] = [];
    await node.joinCluster('node-l5', URL, () => [], loop!, undefined, undefined,
      () => [{ key: 'run-a', room: 'AAAA' }, { key: 'run-b', room: 'ABBB' }], { runsLost: (rs) => { lost.push(rs); } });
    expect(lost).toEqual([[{ key: 'run-b', room: 'ABBB' }]]);
  });
});

describe('⭐ ENV2: дописка слива — до конца аренды', () => {
  it('SIGTERM при живой аренде: бюджет дописки — остаток аренды (база моргнула — круги её ждут), а не 7,5 с', async () => {
    const { node, lease } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await node.joinCluster('node-d1', URL, () => [], loop!, undefined, undefined, () => [], { lease: true });
    const flushed: number[] = [];
    node.installNodeShutdown('node-d1', async (budget) => { flushed.push(budget); });
    for (const fn of sigterm) fn();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!, 'дольше прежних 7,5 с').toBeGreaterThan(60_000);
    expect(flushed[0]!, 'но не дольше аренды').toBeLessThan(lease.LEASE_MS);
    await exited();
  });

  it('без аренды (роль single) — прежние 7,5 с', async () => {
    const { node } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await node.joinCluster('node-d2', URL, () => [], loop!, undefined, undefined, () => []);
    const flushed: number[] = [];
    node.installNodeShutdown('node-d2', async (budget) => { flushed.push(budget); });
    for (const fn of sigterm) fn();
    expect(flushed).toEqual([7_500]);
    await exited();
  });
});
