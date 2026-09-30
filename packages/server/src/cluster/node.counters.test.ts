import { describe, it, expect, vi, afterEach } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * ⭐ E2E 30.09 (седьмой прогон): УДАР СЕРДЦА НОДЫ НЕСЁТ СНИМОК ЕЁ СЧЁТЧИКОВ — из него гейтвей складывает метрики кластера под именами
 * одиночного процесса (`gateway.metrics.test.ts`). Раньше в реестр уходили только показатели ёмкости, и инциденты нод (`dm_write_foreign_total`,
 * `dm_save_conflicts_total`…) на гейтвее не было видно вовсе. Реестр замокан, таймеры — поддельные (интервал ударов не живёт дольше теста).
 */
const reg = vi.hoisted(() => ({ beats: [] as { counters?: { boot: string; values: Record<string, number> } }[] }));
vi.mock('./registry.js', () => ({
  initClusterSchema: () => Promise.resolve(),
  heartbeat: async (_id: string, _url: string, s: { counters?: { boot: string; values: Record<string, number> } }) => { reg.beats.push(s); return true; },
  nodeBeatAge: async () => 0,
  touchClaims: async (ids: string[]) => new Set(ids),
  touchRuns: async (rs: { key: string }[]) => new Set(rs.map((r) => r.key)),
  releaseNode: async () => undefined,
}));
vi.mock('../db/db.js', () => ({}));

afterEach(() => { vi.useRealTimers(); });

describe('⭐ E2E 30.09: удар сердца — со счётчиками ноды', () => {
  it('снимок счётчиков процесса — в каждом ударе: инцидент ноды виден реестру с ближайшим ударом', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.resetModules();
    const { counters } = await import('../net/metrics.js');
    const node = await import('./node.js');
    const loop = monitorEventLoopDelay({ resolution: 5 });
    counters.writeForeign = 2;
    counters.forgeCrafted = 7;
    await node.joinCluster('node-c', 'ws://127.0.0.1:1/ws', () => [], loop);
    const first = reg.beats.at(-1)?.counters;
    expect(first?.boot, 'метка запуска процесса — по ней гейтвей узнаёт рестарт ноды').toBeTruthy();
    expect(first?.values.dm_write_foreign_total).toBe(2);
    expect(first?.values.dm_forge_crafted_total).toBe(7);
    counters.writeForeign = 3;
    await vi.advanceTimersByTimeAsync(2_100);
    const next = reg.beats.at(-1)?.counters;
    expect(reg.beats.length).toBeGreaterThanOrEqual(2);
    expect(next?.values.dm_write_foreign_total, 'следующий удар — со свежим значением').toBe(3);
    expect(next?.boot, 'процесс тот же — метка та же').toBe(first?.boot);
    loop.disable();
  });
});
