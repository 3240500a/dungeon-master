import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ⭐ E2E 30.09 (седьмой прогон): СЧЁТЧИКИ НОД — НА ГЕЙТВЕЕ, ПОД ТЕМИ ЖЕ ИМЕНАМИ. docs/DEPLOY.md обещал: «метрики на гейтвее — СУММА по
 * кластеру, имена те же, что у одиночного процесса, дашборд менять не надо». Живьём (`curl :4100/metrics` стенда-кластера) на гейтвее были
 * только десять показателей ёмкости (игроки, комнаты, тик, память, процессор, очередь), а ни одного счётчика нод: ни инцидентов
 * (`dm_save_conflicts_total`, `dm_write_foreign_total`, `dm_ledger_drain_lost_total`, `dm_farewell_forgotten_total`, `dm_cmd_failed_total`,
 * `dm_frame_errors_total`), ни кузницы (`dm_forge_*_total` — по ним сверяют «цену ковки ≈ времени фарма»), ни отключённых медленных клиентов
 * (`dm_slow_clients_dropped_total` — его читает `dmload --slow` по STAND.md и в кластере видел всегда 0). Мониторинг, настроенный по
 * документу на гейтвей боевого кластера (роль по умолчанию — супервизор), не увидел бы ни одного инцидента целостности.
 *
 * Теперь нода кладёт снимок своих счётчиков в строку реестра с каждым ударом сердца (`counterSnapshot`, `heartbeat`), а гейтвей отдаёт их
 * сумму — МОНОТОННУЮ: рестарт ноды (новый `boot`, счёт с нуля) и её уход из живых сумму не уменьшают (для Prometheus убывание счётчика —
 * сброс, и `increase()` засчитал бы остаток суммы заново), возврат ноды с тем же `boot` не считается дважды. Плюс собственные счётчики
 * процесса гейтвея (лимиты его HTTP-ручек).
 */
const reg = vi.hoisted(() => ({ nodes: [] as Record<string, unknown>[] }));
vi.mock('../db/db.js', () => ({ getSession: async () => null, getCharacter: async () => null }));
vi.mock('../db/pool.js', () => ({ q: async () => [], q1: async () => ({ n: '0' }) }));
vi.mock('./registry.js', () => ({
  liveNodes: async () => reg.nodes,
  claimChar: async () => null,
  sweepNodes: async () => 0,
  liveClaim: async () => null,
}));

const row = (id: string, boot: string, values: Record<string, number>): Record<string, unknown> => ({
  id, url: `ws://${id}/ws`, players: 0, rooms: 0, draining: false, cpu_seconds: 0, rss_bytes: '0', loop_p99_ms: 0, tick_hz: 30,
  counters: { boot, values },
});
const value = (text: string, name: string): number => {
  const m = new RegExp(`^${name} (-?[\\d.e+]+)$`, 'm').exec(text);
  return m ? Number(m[1]) : NaN;
};
/** Свежий процесс гейтвея: сумма счётчиков — состояние модуля. */
async function gateway(): Promise<typeof import('./gateway.js')> {
  vi.resetModules();
  return import('./gateway.js');
}

beforeEach(() => { reg.nodes = []; });

describe('⭐ E2E 30.09: счётчики нод — на гейтвее', () => {
  it('сумма счётчиков живых нод — под именами одиночного процесса, с типом counter', async () => {
    const { clusterMetrics } = await gateway();
    reg.nodes = [
      row('node-0', 'a', { dm_save_conflicts_total: 2, dm_forge_crafted_total: 4, dm_write_foreign_total: 0 }),
      row('node-1', 'b', { dm_save_conflicts_total: 3, dm_forge_crafted_total: 1, dm_write_foreign_total: 1 }),
    ];
    const text = await clusterMetrics();
    expect(value(text, 'dm_save_conflicts_total')).toBe(5);
    expect(value(text, 'dm_forge_crafted_total')).toBe(5);
    expect(value(text, 'dm_write_foreign_total'), 'инцидент одной ноды виден на гейтвее').toBe(1);
    expect(text).toMatch(/^# TYPE dm_save_conflicts_total counter$/m);
    expect(value(text, 'dm_players'), 'показатели ёмкости — как были').toBe(0);
  });

  it('рестарт ноды и её уход сумму не уменьшают; возврат с тем же запуском не считается дважды', async () => {
    const { clusterMetrics } = await gateway();
    reg.nodes = [row('node-0', 'a', { dm_save_conflicts_total: 2 }), row('node-1', 'b', { dm_save_conflicts_total: 3 })];
    expect(value(await clusterMetrics(), 'dm_save_conflicts_total')).toBe(5);
    // node-1 перезапущена: счёт с нуля, уже 1.
    reg.nodes = [row('node-0', 'a', { dm_save_conflicts_total: 2 }), row('node-1', 'b2', { dm_save_conflicts_total: 1 })];
    expect(value(await clusterMetrics(), 'dm_save_conflicts_total'), 'не 3: сброс ноды — не убыль суммы').toBe(6);
    reg.nodes = [row('node-0', 'a', { dm_save_conflicts_total: 4 }), row('node-1', 'b2', { dm_save_conflicts_total: 1 })];
    expect(value(await clusterMetrics(), 'dm_save_conflicts_total')).toBe(8);
    // node-1 выпала из живых (пропустила удары) — её вклад остаётся.
    reg.nodes = [row('node-0', 'a', { dm_save_conflicts_total: 4 })];
    expect(value(await clusterMetrics(), 'dm_save_conflicts_total')).toBe(8);
    // Вернулась тем же процессом — прежнее не считается второй раз, новое — считается.
    reg.nodes = [row('node-0', 'a', { dm_save_conflicts_total: 4 }), row('node-1', 'b2', { dm_save_conflicts_total: 2 })];
    expect(value(await clusterMetrics(), 'dm_save_conflicts_total')).toBe(9);
  });

  it('каждый счётчик одиночного процесса — в снимке ноды и на гейтвее (новый счётчик не выпадет из суммы молча)', async () => {
    const metrics = await import('../net/metrics.js');
    const own = [...metrics.renderMetrics().matchAll(/^# TYPE (\S+) counter$/gm)].map((m) => m[1]!)
      .filter((n) => !n.startsWith('dm_cpu_'));   // процессорное время гейтвей и так складывает из строк реестра (`cpu_seconds`)
    expect(own.length).toBeGreaterThan(20);
    const snap = metrics.counterSnapshot();
    expect(Object.keys(snap.values).sort()).toEqual([...own].sort());
    const { clusterMetrics } = await gateway();
    reg.nodes = [row('node-0', snap.boot, Object.fromEntries(own.map((n, i) => [n, i + 1])))];
    const text = await clusterMetrics();
    for (const [i, n] of own.entries()) expect(value(text, n), n).toBeGreaterThanOrEqual(i + 1);
  });

  it('строка реестра без снимка (нода старше правки, мок) — показатели ёмкости как были, счётчики — нулём', async () => {
    const { clusterMetrics } = await gateway();
    reg.nodes = [{ ...row('node-0', 'a', {}), counters: undefined }];
    const text = await clusterMetrics();
    expect(value(text, 'dm_nodes')).toBe(1);
    expect(value(text, 'dm_save_conflicts_total')).toBe(0);
  });
});
