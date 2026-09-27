import { describe, it, expect, vi } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * ⭐ R7-09: УДАР СЕРДЦА НОДЫ — СПЕРВА ПРОДЛЕНИЕ СВОИХ ГЕРОЕВ, ПОТОМ СЕРДЦЕ. Закрепление держится, пока на последнем ударе
 * сердца нода держала героя (`registry.claimForJoin`). Сердце раньше продления после долгого простоя базы — окно, где нода
 * «жива», а герой «давно не продлевался», и вход на соседнюю ноду его забирал. Продление упало — сердце не бьётся: нода,
 * которая не может подтвердить героев, не выглядит живой, державшей их. Реестр замокан: проверяется порядок.
 */
const reg = vi.hoisted(() => ({ order: [] as string[], touchFails: false }));
vi.mock('./registry.js', () => ({
  initClusterSchema: () => Promise.resolve(),
  heartbeat: async () => { reg.order.push('beat'); },
  touchClaims: async (ids: string[]) => {
    reg.order.push('touch');
    if (reg.touchFails) throw new Error('база не ответила');
    return new Set(ids);
  },
  releaseNode: () => Promise.resolve(),
}));
vi.mock('../db/db.js', () => ({}));

describe('⭐ R7-09: удар сердца — продление героев, затем сердце', () => {
  it('порядок: продление раньше сердца; продление упало — сердце не бьётся', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const loop = monitorEventLoopDelay({ resolution: 5 });
    try {
      const { joinCluster } = await import('./node.js');
      await joinCluster('node-r709', 'ws://127.0.0.1:1/ws', () => ['c1'], loop);
      expect(reg.order, 'первый удар').toEqual(['touch', 'beat']);
      reg.order.length = 0;
      reg.touchFails = true;
      vi.advanceTimersByTime(2_000);
      await vi.waitFor(() => { if (!reg.order.length) throw new Error('удара ещё нет'); });
      await new Promise((r) => setTimeout(r, 20));
      expect(reg.order, 'продление упало — сердце не бьётся').toEqual(['touch']);
    } finally {
      vi.useRealTimers();
      loop.disable();
      reg.touchFails = false;
    }
  });
});
