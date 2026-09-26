import { describe, it, expect, vi, afterEach } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * ⭐ R3-12: У ПРОЦЕССА ОДИН ПУТЬ ВЫХОДА. Нода кластера (и одиночный процесс) получала ДВА обработчика SIGTERM: общий
 * транспортный (`installShutdown`, ставят `startUwsServer`/`attachWsServer`) и слив ноды (`installNodeShutdown`).
 * Общий выходил сразу после своей записи сейвов (или через 5 с) — до `releaseNode`: закрепления и строка ноды
 * оставались в реестре, гейтвей до десяти секунд слал вернувшихся игроков на мёртвую ноду, а записи прощаний и
 * штрафов, которые слив ноды ждёт до 8 с, обрывались выходом.
 *
 * Обработчики ставятся так же, как в `index.ts` для роли node/single; сигнал доставляется так, как его доставляет Node, —
 * всем слушателям по порядку регистрации. Реестр и выход процесса замоканы: ни базы, ни настоящего выхода.
 */
const reg = vi.hoisted(() => ({
  order: [] as string[],
  /** R4-28: задержка каждого следующего удара сердца, мс (по порядку вызовов; нет числа — сразу). */
  beatDelays: [] as number[],
  /** R4-28: что случилось, пока продление закреплений шло в базу. */
  onTouch: null as null | (() => void),
}));
vi.mock('./registry.js', () => ({
  initClusterSchema: () => Promise.resolve(),
  heartbeat: async (_id: string, _url: string, s: { draining: boolean }) => {
    const ms = reg.beatDelays.shift() ?? 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    reg.order.push(`beat draining=${s.draining}`);
  },
  touchClaims: (ids: string[]) => { reg.order.push('touch'); reg.onTouch?.(); return Promise.resolve(new Set(ids)); },
  releaseNode: async () => { await new Promise((r) => setTimeout(r, 5)); reg.order.push('releaseNode'); },
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
}));
vi.mock('../db/db.js', () => ({}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

afterEach(() => { vi.restoreAllMocks(); });

describe('слив ноды (R3-12)', () => {
  it('⭐ SIGTERM в роли node: объявить слив, дописать, снять ноду из реестра — и выйти ОДИН раз, после releaseNode', async () => {
    const handlers = new Map<string, (() => void)[]>();
    // R5-08: обработчики сигналов ставятся `process.on` — их и ловим (прочие события — как есть).
    const realOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: () => void) => {
      if (ev !== 'SIGTERM' && ev !== 'SIGINT') return realOn(ev as never, fn as never);
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
      return process;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { reg.order.push(`exit ${code ?? 0}`); }) as never);
    const { installShutdown } = await import('../net/wsServer.js');
    const { joinCluster, installNodeShutdown, isDraining } = await import('./node.js');
    const flush = (who: string) => async (): Promise<void> => {
      reg.order.push(`flush ${who} start`);
      await new Promise((r) => setTimeout(r, 20));
      reg.order.push(`flush ${who} done`);
    };

    // Порядок index.ts: транспорт (startUwsServer → installShutdown), затем кластер.
    installShutdown({ flushAll: flush('transport') } as never);
    const loop = monitorEventLoopDelay({ resolution: 5 });
    await joinCluster('node-t', 'ws://127.0.0.1:1/ws', () => [], loop);
    installNodeShutdown('node-t', flush('node'));
    reg.order.length = 0;

    for (const fn of handlers.get('SIGTERM') ?? []) fn();
    await new Promise((r) => setTimeout(r, 300));

    const exits = reg.order.filter((s) => s.startsWith('exit'));
    expect(exits, `выход ровно один: ${reg.order.join(' → ')}`).toEqual(['exit 0']);
    expect(reg.order.indexOf('releaseNode'), 'нода снята из реестра до выхода').toBeGreaterThanOrEqual(0);
    expect(reg.order.indexOf('releaseNode')).toBeLessThan(reg.order.indexOf('exit 0'));
    expect(reg.order.indexOf('flush node done'), 'сейвы дописаны до снятия ноды').toBeLessThan(reg.order.indexOf('releaseNode'));
    expect(reg.order.indexOf('beat draining=true'), 'слив объявлен сразу, не через удар сердца').toBeGreaterThanOrEqual(0);
    expect(reg.order.indexOf('beat draining=true')).toBeLessThan(reg.order.indexOf('flush node done'));
    expect(isDraining()).toBe(true);
    loop.disable();
  });
});

describe('сердцебиение и снятие ноды (R4-28)', () => {
  it('⭐ удар сердца, начатый ДО слива и ещё идущий в базу, не возвращает ноду и закрепления в реестр после releaseNode', async () => {
    vi.resetModules();
    const handlers: (() => void)[] = [];
    const realOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: () => void) => {
      if (ev !== 'SIGTERM' && ev !== 'SIGINT') return realOn(ev as never, fn as never);
      if (ev === 'SIGTERM') handlers.push(fn);
      return process;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation((() => { reg.order.push('exit'); }) as never);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { joinCluster, installNodeShutdown } = await import('./node.js');
      const loop = monitorEventLoopDelay({ resolution: 5 });
      reg.beatDelays = [0, 80];                             // первый удар — при входе; второй (по расписанию) застрял в базе
      await joinCluster('node-r428', 'ws://127.0.0.1:1/ws', () => ['c1'], loop);
      installNodeShutdown('node-r428', async () => { await new Promise((r) => setTimeout(r, 20)); reg.order.push('flush done'); });
      reg.order.length = 0;
      vi.advanceTimersByTime(2_000);                        // удар по расписанию ушёл в базу…
      for (const fn of handlers) fn();                      // …и тут пришёл SIGTERM
      await new Promise((r) => setTimeout(r, 300));
      const rel = reg.order.indexOf('releaseNode');
      expect(rel, reg.order.join(' → ')).toBeGreaterThanOrEqual(0);
      expect(reg.order.slice(rel).filter((x) => x.startsWith('beat') || x === 'touch'), `после снятия ноды — ни удара, ни продления: ${reg.order.join(' → ')}`).toEqual([]);
      loop.disable();
    } finally {
      vi.useRealTimers();
      reg.beatDelays = [];
    }
  });

  it('⭐ закрепление, продлённое для героя, который тем временем ушёл, отдаётся ноде на снятие', async () => {
    vi.resetModules();
    const { joinCluster } = await import('./node.js');
    const loop = monitorEventLoopDelay({ resolution: 5 });
    let held = ['c1', 'c2'];
    reg.onTouch = () => { held = ['c2']; };                // c1 вышел, пока продление шло в базу, — его снятие уже прошло
    const gone: string[][] = [];
    try {
      await joinCluster('node-r428b', 'ws://127.0.0.1:1/ws', () => held, loop, undefined, (ids: string[]) => { gone.push(ids); });
    } finally { reg.onTouch = null; loop.disable(); }
    expect(gone).toEqual([['c1']]);
  });
});

/**
 * ⭐ R5-08: ВТОРОЙ SIGTERM ВО ВРЕМЯ СЛИВА. Обработчики ставились `process.once`: первый сигнал снимал их, и второй (systemd с
 * `KillMode=control-group` шлёт его каждому процессу группы, а супервизор — ещё и свой; npm и tsx пересылают свой) убивал
 * процесс действием по умолчанию посреди записи сейвов — ни дописанных копий, ни `releaseNode`. Здесь настоящий
 * `process.on` (замоканы только выход процесса и реестр); сигнал доставляется, как его доставляет Node, — `emit`.
 */
describe('⭐ R5-08: второй SIGTERM во время слива', () => {
  it('обработчики не снимаются первым сигналом; второй — только в лог; выход ровно один — после записи и снятия ноды', async () => {
    vi.resetModules();
    const before = new Map((['SIGTERM', 'SIGINT'] as const).map((ev) => [ev, process.listeners(ev)]));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { reg.order.push(`exit ${code ?? 0}`); }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { installShutdown } = await import('../net/wsServer.js');
    const { joinCluster, installNodeShutdown } = await import('./node.js');
    const loop = monitorEventLoopDelay({ resolution: 5 });
    try {
      installShutdown({ flushAll: () => Promise.resolve() } as never);
      await joinCluster('node-r508', 'ws://127.0.0.1:1/ws', () => [], loop);
      installNodeShutdown('node-r508', async () => {
        reg.order.push('flush start');
        await new Promise((r) => setTimeout(r, 40));
        reg.order.push('flush done');
      });
      reg.order.length = 0;
      process.emit('SIGTERM' as never);
      expect(process.listenerCount('SIGTERM'), 'первый сигнал обработчики не снял').toBeGreaterThan(before.get('SIGTERM')!.length);
      await new Promise((r) => setTimeout(r, 10));
      process.emit('SIGTERM' as never);                     // второй — посреди записи
      process.emit('SIGINT' as never);
      await new Promise((r) => setTimeout(r, 300));
      expect(reg.order.filter((s) => s.startsWith('exit')), reg.order.join(' → ')).toEqual(['exit 0']);
      expect(reg.order.filter((s) => s === 'flush start'), 'слив начат один раз').toHaveLength(1);
      expect(reg.order.indexOf('flush done')).toBeLessThan(reg.order.indexOf('releaseNode'));
      expect(reg.order.indexOf('releaseNode')).toBeLessThan(reg.order.indexOf('exit 0'));
    } finally {
      loop.disable();
      for (const [ev, was] of before) for (const l of process.listeners(ev)) if (!was.includes(l)) process.removeListener(ev, l);
    }
  });
});
