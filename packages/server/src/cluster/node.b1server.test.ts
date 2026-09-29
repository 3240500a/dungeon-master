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
 *  • ⭐ R16-02: удар сперва спрашивает реестр, давно ли тот видел ноду (часы БАЗЫ): дольше аренды (простой машины, которого часы процесса не
 *    видели) — выход без записи, ни продления своих, ни удара: реестр уже вправе был отдать её героев и забеги, и отданное и отпущенное
 *    продление вставило бы снова.
 *  • ⭐ R17-01: и когда машина встала ПОСЛЕ ответа сверки («2 с» ждал в буфере сокета всю паузу) — удар сердца сам ложится, только пока реестр
 *    видел ноду меньше аренды назад (`heartbeat(…, leased)`): не лёг — выход без записи, аренда не продлена. Раньше удар был безусловной
 *    вставкой: он оживлял строку, которую реестр уже счёл мёртвой, продлевал аренду, и следующий удар вставлял закрепления и забеги заново.
 * Реестр замокан; время — поддельное (`Date`, ⭐ R15-06 — и часы процесса `performance.now`, по которым идёт срок аренды, и таймеры), выход
 * процесса — перехвачен. `setSystemTime` двигает только настенные часы — это шаг часов или простой машины, видный лишь им (R15-06). Часы
 * базы — часы процесса плюс `dbSkewMs` (простой машины: база жила, часы процесса стояли).
 */
const reg = vi.hoisted(() => ({
  order: [] as string[],
  /** Удар сердца падает (раздел с базой, реестр недоступен). */
  beatFails: false,
  /** Забеги, которые реестр числит за другой нодой (`touchRuns` их не возвращает). */
  lostRuns: [] as string[],
  /** ⭐ R16 C-05: удар сердца доходит с задержкой (мс поддельного времени). */
  beatDelayMs: 0,
  /** ⭐ R16-02: насколько часы базы ушли вперёд часов процесса (простой машины), мс; когда реестр видел последний удар — по часам базы. */
  dbSkewMs: 0,
  lastBeatDb: null as number | null,
  /** ⭐ R16-02: строку ноды сняла уборка реестра (`sweepNodes`). */
  rowGone: false,
  /**
   * ⭐ R17-01: машина ноды встаёт на столько мс (часы базы идут, часы процесса стоят) СРАЗУ ПОСЛЕ того, как база ответила на сверку возраста
   * удара (`pauseAfterAge`) или на продление своих (`pauseAfterTouch`): ответ был верен в миг ответа, а нода действует по нему после паузы.
   */
  pauseAfterAge: 0,
  pauseAfterTouch: 0,
}));
/** ⭐ R16-02: часы базы. */
const dbNow = (): number => performance.now() + reg.dbSkewMs;
vi.mock('./registry.js', async () => {
  const { LEASE_MS } = await import('./lease.js');
  const { NODE_DEAD_SEC } = await import('./claimRule.js');
  /** Сколько реестр не видел удара ноды (часы базы), мс; строки нет — бесконечность. */
  const silentMs = (): number => (reg.rowGone || reg.lastBeatDb === null ? Infinity : dbNow() - reg.lastBeatDb);
  /** ⭐ R16-02: продление ноды с арендой — только пока реестр числит её живой (`NODE_DEAD_SEC`). */
  const deadFor = (leased?: boolean): boolean => !!leased && silentMs() >= NODE_DEAD_SEC * 1000;
  return {
    initClusterSchema: () => Promise.resolve(),
    heartbeat: async (_id: string, _url: string, s: { draining: boolean }, leased?: boolean) => {
      if (reg.beatFails) throw new Error('реестр не ответил');
      if (reg.beatDelayMs) await new Promise((res) => setTimeout(res, reg.beatDelayMs));
      // ⭐ R17-01: удар ноды с арендой — одним запросом с проверкой: реестр видел её меньше аренды назад (строка есть), иначе не ложится.
      if (leased && silentMs() >= LEASE_MS) { reg.order.push('beat refused'); return false; }
      reg.order.push(`beat draining=${s.draining}`);
      reg.lastBeatDb = dbNow(); reg.rowGone = false;
      return true;
    },
    nodeBeatAge: async () => {
      if (reg.beatFails) throw new Error('реестр не ответил');
      const age = reg.rowGone || reg.lastBeatDb === null ? null : (dbNow() - reg.lastBeatDb) / 1000;
      if (reg.pauseAfterAge) { reg.dbSkewMs += reg.pauseAfterAge; reg.pauseAfterAge = 0; }   // R17-01: ответ ушёл — машина встала
      return age;
    },
    touchClaims: (ids: string[], _n: string, leased?: boolean) => {
      reg.order.push('touchClaims');
      const out = new Set(deadFor(leased) ? [] : ids);
      if (reg.pauseAfterTouch) { reg.dbSkewMs += reg.pauseAfterTouch; reg.pauseAfterTouch = 0; }   // R17-01: ответ ушёл — машина встала
      return Promise.resolve(out);
    },
    touchRuns: (rs: { key: string }[], _n: string, leased?: boolean) => {
      reg.order.push('touchRuns');
      return Promise.resolve(new Set(deadFor(leased) ? [] : rs.map((r) => r.key).filter((k) => !reg.lostRuns.includes(k))));
    },
    releaseNode: async () => { reg.order.push('releaseNode'); },
  };
});
vi.mock('../db/db.js', () => ({}));

const URL = 'ws://127.0.0.1:1/ws';
let loop: ReturnType<typeof monitorEventLoopDelay> | undefined;

/** Свежий процесс ноды (свой граф модулей: аренда, слив, удары), сигналы и выход — перехвачены. */
async function fresh(): Promise<{ node: typeof import('./node.js'); lease: typeof import('./lease.js'); claim: typeof import('./claimRule.js') }> {
  vi.resetModules();
  reg.order.length = 0; reg.beatFails = false; reg.lostRuns = []; reg.beatDelayMs = 0; reg.dbSkewMs = 0; reg.lastBeatDb = null; reg.rowGone = false;
  reg.pauseAfterAge = 0; reg.pauseAfterTouch = 0;
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
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

describe('⭐ R15-06: аренда — по часам процесса; настенные часы только сомневаются', () => {
  /** Поддельные часы — и настенные, и процесса (`performance.now`): ход времени двигает оба, шаг настенных (`setSystemTime`) — только их. */
  const clocks = (): void => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] }); };

  it('настенные часы шагнули вперёд на 200 с при здоровой базе — нода не выходит: удар сверки дошёл, аренда продлена', async () => {
    const { node, lease } = await fresh();
    clocks();
    await node.joinCluster('node-c1', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    node.installNodeShutdown('node-c1', async () => { reg.order.push('flush'); });
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(Date.now() + 200_000);   // chrony makestep / миграция ВМ: часы процесса не шли
    expect(lease.leaseLost(), 'до ответа реестра — отгорожена (сомнение)').toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reg.order.filter((s) => s.startsWith('exit') || s === 'flush'), reg.order.join(' → ')).toEqual([]);
    expect(lease.leaseLost(), 'удар дошёл — аренда продлена, сомнения нет').toBe(false);
    expect(lease.leaseLeft()).toBeGreaterThan(lease.LEASE_MS - 3_000);
  });

  it('настенные часы шагнули назад на 60 с — аренда не растягивается на 60 с: удары не доходят — выход в срок по часам процесса', async () => {
    const { node, lease, claim } = await fresh();
    clocks();
    await node.joinCluster('node-c2', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    node.installNodeShutdown('node-c2', async () => { reg.order.push('flush'); });
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(10_000);   // удары после шага доходят — аренда продлевается от них
    const lastOk = performance.now();
    reg.beatFails = true;                          // дальше база молчит
    await vi.advanceTimersByTimeAsync(lease.LEASE_MS + 2_000);
    expect(reg.order.some((s) => s.startsWith('exit 1')), `выход в срок аренды (${reg.order.join(' → ')})`).toBe(true);
    expect(performance.now() - lastOk, 'и до срока смерти ноды в реестре').toBeLessThan(claim.NODE_DEAD_SEC * 1000);
    expect(lease.leaseLost()).toBe(true);
  });

  it('часы процесса и настенные — вместе (обычный ход): удары не доходят — выход с концом аренды, без записи', async () => {
    const { node, lease } = await fresh();
    clocks();
    const t0 = performance.now();
    await node.joinCluster('node-c3', URL, () => ['c1'], loop!, undefined, undefined, () => [], { lease: true });
    node.installNodeShutdown('node-c3', async () => { reg.order.push('flush'); });
    reg.beatFails = true;
    await vi.advanceTimersByTimeAsync(lease.LEASE_MS - 3_000);
    expect(reg.order.some((s) => s.startsWith('exit'))).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reg.order.find((s) => s.startsWith('exit'))?.split(' @')[0], 'выход без записи (выход подменён — сверка зовёт его каждую секунду)').toBe('exit 1');
    expect(performance.now() - t0).toBeLessThanOrEqual(lease.LEASE_MS + 2_000);
    expect(reg.order).not.toContain('flush');
  });
});

describe('⭐ R16-02: нода, которую реестр уже счёл мёртвой, не оживает — выход без записи', () => {
  const clocks = (): void => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] }); };
  /** Нода в кластере с арендой, держит героя и забег; 10 с спокойной игры. */
  async function up(id: string): Promise<{ node: typeof import('./node.js'); lease: typeof import('./lease.js') }> {
    const { node, lease } = await fresh();
    clocks();
    await node.joinCluster(id, URL, () => ['c1'], loop!, undefined, undefined, () => [{ key: 'run-a', room: 'AAAA' }], { lease: true });
    node.installNodeShutdown(id, async () => { reg.order.push('flush'); });
    await vi.advanceTimersByTimeAsync(10_000);
    reg.order.length = 0;
    return { node, lease };
  }
  const writes = (): string[] => reg.order.filter((s) => s === 'touchClaims' || s === 'touchRuns' || s.startsWith('beat') || s === 'flush' || s === 'releaseNode');

  it('ВМ на паузе 200 с (часы процесса стояли, база шла), настенные догнал chrony — удар сверки узнаёт от реестра про 200 с тишины: выход без записи, продления нет', async () => {
    const { lease } = await up('node-p1');
    reg.dbSkewMs += 200_000;                  // база жила 200 с, пока гость стоял
    vi.setSystemTime(Date.now() + 200_000);   // …а настенные часы гостя догнал chrony
    expect(lease.leaseLeft(), 'по часам процесса аренда ещё идёт').toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reg.order.some((s) => s.startsWith('exit 1')), reg.order.join(' → ')).toBe(true);
    expect(writes(), 'ни продления своих (отданных и отпущенных — вставило бы снова), ни удара, ни слива').toEqual([]);
    expect(lease.leaseLost(), 'аренда не продлена').toBe(true);
  });

  it('и без шага настенных часов (часы гостя стояли все) — удар по расписанию узнаёт то же: выход без записи', async () => {
    const { lease } = await up('node-p2');
    reg.dbSkewMs += 200_000;
    expect(lease.leaseDoubted(), 'сомнения нет — настенные тоже стояли').toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reg.order.some((s) => s.startsWith('exit 1')), reg.order.join(' → ')).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('строку ноды уже сняла уборка реестра — выход без записи (раньше удар вставлял её, закрепления и забеги заново)', async () => {
    await up('node-p3');
    reg.rowGone = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reg.order.some((s) => s.startsWith('exit 1')), reg.order.join(' → ')).toBe(true);
    expect(writes()).toEqual([]);
  });

  /**
   * ⭐ R17-01: СВЕРКА ОТВЕТИЛА ДО ПАУЗЫ. База на другой машине ответила «2 с» сразу, а ответ ждал в буфере сокета всю паузу машины ноды (200 с:
   * часы процесса стояли — аренда по ним почти полная). Реестр тем временем счёл ноду мёртвой: её героя и забег взяла и отпустила другая нода.
   * Продление своих отказано (R16-02), и удар сердца — тоже: он ложится только одним запросом с проверкой «реестр видел её меньше аренды
   * назад». Раньше удар был безусловной вставкой: строка ноды оживала, аренда продлевалась, `fenceLost` не находил чужого владельца (его
   * отпустили) — и следующий удар вставлял закрепление героя и держание забега заново, за ней. То же — пауза между продлением и ударом.
   */
  for (const at of ['age', 'touch'] as const) {
    it(`⭐ R17-01: машина встала сразу после ответа ${at === 'age' ? 'сверки возраста удара' : 'на продление своих'} — удар не ложится: выход без записи, аренда не продлена, отданное не оживает`, async () => {
      const { node, lease } = await fresh();
      clocks();
      const id = `node-p6${at}`;
      const lost: string[][] = [];
      await node.joinCluster(id, URL, () => ['c1'], loop!, (ids) => { lost.push(ids); }, undefined, () => [{ key: 'run-a', room: 'AAAA' }], { lease: true });
      node.installNodeShutdown(id, async () => { reg.order.push('flush'); });
      await vi.advanceTimersByTimeAsync(10_000);
      reg.order.length = 0; lost.length = 0;
      const end0 = lease.leaseLeft() + performance.now();   // конец аренды по часам процесса
      if (at === 'age') reg.pauseAfterAge = 200_000; else reg.pauseAfterTouch = 200_000;
      await vi.advanceTimersByTimeAsync(2_100);
      expect(reg.order.some((s) => s.startsWith('exit 1')), reg.order.join(' → ')).toBe(true);
      expect(reg.order.filter((s) => s.startsWith('beat draining')), 'удар не лёг: строка ноды не ожила').toEqual([]);
      expect(lease.leaseLeft() + performance.now(), 'аренда не продлена').toBe(end0);
      expect(lost, 'копии не снимались по ответу, которому верить нельзя, — процесс уходит целиком').toEqual([]);
      const n = reg.order.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(reg.order.slice(n).filter((s) => s === 'touchClaims' || s === 'touchRuns' || s.startsWith('beat draining')), 'и следующего удара с продлением своих нет').toEqual([]);
    });
  }

  it('контроль: простой базы на 100 с (реестр не видел ноду 100 с — меньше аренды) — удар доходит, нода играет', async () => {
    const { lease } = await up('node-p4');
    reg.beatFails = true;
    await vi.advanceTimersByTimeAsync(100_000);
    reg.beatFails = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reg.order.filter((s) => s.startsWith('exit')), reg.order.join(' → ')).toEqual([]);
    expect(lease.leaseLeft()).toBeGreaterThan(lease.LEASE_MS - 3_000);
    expect(reg.order).toContain('touchClaims');
  });
});

describe('⭐ R15-08: забег, отпущенный комнатой, пока удар продлевал снимок, — отпускается снова (близнец R4-28 для `run_locks`)', () => {
  it('снимок забегов взят, комната отпустила забег до продления (продление вставило строку заново) — после удара нода отпускает его ещё раз', async () => {
    const { node } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let held = [{ key: 'run-a', room: 'AAAA' }, { key: 'run-b', room: 'ABBB' }];
    const gone: { key: string; room: string }[][] = [];
    let calls = 0;
    // Первый вызов — снимок удара; комната тут же отпускает `run-a` (её `DELETE` лёг раньше продления — `touchRuns` вставил строку заново).
    const heldRuns = (): { key: string; room: string }[] => { const out = held; if (++calls === 1) held = [held[1]!]; return out; };
    await node.joinCluster('node-g1', URL, () => [], loop!, undefined, undefined, heldRuns, { runsGone: (rs) => { gone.push(rs); } });
    expect(gone, 'продлённый, но уже не свой забег — отпустить снова').toEqual([[{ key: 'run-a', room: 'AAAA' }]]);
  });

  it('⭐ перепрогон R15: снимок назвал прежнюю комнату, а забег уже взяла другая комната ноды — «ушла» пара «забег, комната»', async () => {
    const { node } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let held = [{ key: 'run-a', room: 'AAAA' }];
    const gone: { key: string; room: string }[][] = [];
    let calls = 0;
    // «Продолжить» того же героя между снимком и продлением: забег держит новая комната, а продление легло с прежней.
    const heldRuns = (): { key: string; room: string }[] => { const out = held; if (++calls === 1) held = [{ key: 'run-a', room: 'ACCC' }]; return out; };
    await node.joinCluster('node-g3', URL, () => [], loop!, undefined, undefined, heldRuns, { runsGone: (rs) => { gone.push(rs); } });
    expect(gone, 'строку — на держателя (менеджер: `settleRun`)').toEqual([[{ key: 'run-a', room: 'AAAA' }]]);
  });

  it('⭐ перепрогон R15: комната отпустила забег, пока продление шло в базу, а его взяла другая нода — не инцидент и не снятие', async () => {
    const { node } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reg.lostRuns = ['run-a'];                  // продление легло, когда строку уже держала другая нода («Продолжить» героя там)
    let held = [{ key: 'run-a', room: 'AAAA' }];
    let calls = 0;
    const heldRuns = (): { key: string; room: string }[] => { const out = held; if (++calls === 1) held = []; return out; };
    const lost: unknown[] = [];
    await node.joinCluster('node-g4', URL, () => [], loop!, undefined, undefined, heldRuns, { runsLost: (rs) => { lost.push(rs); } });
    expect(lost, 'комнаты ноды забег уже не держат — отпускать нечего').toEqual([]);
    expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((s) => s.includes('ИНЦИДЕНТ')), 'и ложной тревоги в лог нет').toEqual([]);
  });

  it('контроль: забег, что держат и после удара, и забег, который продление не вернуло (он у другой ноды), — не «ушедшие»', async () => {
    const { node } = await fresh();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reg.lostRuns = ['run-b'];
    const gone: unknown[] = [];
    await node.joinCluster('node-g2', URL, () => [], loop!, undefined, undefined,
      () => [{ key: 'run-a', room: 'AAAA' }], { runsGone: (rs) => { gone.push(rs); } });
    expect(gone).toEqual([]);
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
