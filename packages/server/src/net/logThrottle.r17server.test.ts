import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave } from '@dm/shared';
import type { GameConn } from './conn.js';

/**
 * ⭐ R17-06: ГЛУШИТЕЛИ ЛОГА «НЕ ЧАЩЕ РАЗА В 10 С» — ПО ЧАСАМ ПРОЦЕССА. Раньше все семь мерили срок настенными часами (`Date.now() - lastAt`):
 * шаг часов НАЗАД на S секунд (chrony makestep, откат снимка ВМ, ручная правка — тот же класс событий, что R3-15, R15-06, R16-06) делал
 * разность отрицательной, и S секунд подряд строки только считались промолчанными: сбои записи сейва (C-07), свода забега, кадры с
 * исключением, HTTP 500, отказы маршрутизации гейтвея и шум команд — пропадали ровно тогда, когда по логу разбирают инцидент с часами.
 *
 * Каждый глушитель: первая строка — в лог; настенные часы шагнули назад на час, а часы процесса прошли 11 с — вторая строка тоже в лог
 * (срок по часам процесса вышел); ещё через секунду — промолчана; ещё через 10 — строка с числом промолчанных.
 */
vi.mock('../db/db.js', () => ({
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  putCharacter: () => Promise.resolve(null),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../db/pool.js', () => ({ q: () => Promise.resolve([]), q1: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(null),
  liveNodes: () => Promise.resolve([]),
  liveClaim: () => Promise.resolve(null),
  claimChar: (_c: string, node: string) => Promise.resolve(node),
  sweepNodes: () => Promise.resolve(0),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

let cfg: ConfigRegistry;
beforeAll(() => {
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * Прогнать глушитель `call` по часам: настенные и процесса — подменены; `lines` — строки лога (`console[kind]`), что до него дошли.
 * Часы процесса — далеко впереди настоящих: прежние вызовы того же глушителя в этом файле срок уже отсидели.
 */
function clocked(kind: 'error' | 'warn', call: () => void): string[] {
  const lines: string[] = [];
  vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => { lines.push(String(a[0])); });
  let wall = Date.now();
  let mono = performance.now() + 1e9;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  call();
  expect(lines, 'первая строка — в лог').toHaveLength(1);
  wall -= 3_600_000; mono += 11_000;   // шаг настенных часов назад на час; по часам процесса прошло 11 с
  call();
  expect(lines, 'шаг часов назад не глушит лог: по часам процесса срок вышел').toHaveLength(2);
  wall += 1_000; mono += 1_000;
  call();
  expect(lines, 'через секунду — промолчана').toHaveLength(2);
  wall += 10_000; mono += 10_000;
  call();
  expect(lines, 'через 10 с — строка, с числом промолчанных').toHaveLength(3);
  expect(lines[2]).toContain('и ещё 1');
  return lines;
}

describe('⭐ R17-06: шаг настенных часов назад не глушит лог — срок глушителя по часам процесса', () => {
  it('HTTP-ошибки (`warnHttp`)', async () => {
    const { warnHttp } = await import('./asyncRoute.js');
    clocked('error', () => warnHttp(new Error('сбой'), 'сбой'));
  });

  it('кадры, погашенные на транспорте (`frameFailed`)', async () => {
    const { frameFailed } = await import('./wsServer.js');
    clocked('error', () => frameFailed(new Error('кадр')));
  });

  it('отказы маршрутизации гейтвея (`warnRoute`)', async () => {
    const { warnRoute } = await import('../cluster/gateway.js');
    clocked('error', () => warnRoute(new Error('база не ответила')));
  });

  it('сбои записи сейва (`warnSave`, C-07) и свода забега (`warnLedger`)', async () => {
    const { warnSave, warnLedger } = await import('./room.js');
    clocked('error', () => warnSave('[room T] запись сейва c1', new Error('ECONNREFUSED')));
    vi.restoreAllMocks();
    clocked('error', () => warnLedger(new Error('ECONNREFUSED')));
  });

  it('кадры, погашенные исключением в менеджере (`warnFrame`)', async () => {
    const { RoomManager } = await import('./roomManager.js');
    vi.useFakeTimers({ toFake: ['setInterval'] });
    let rm: InstanceType<typeof RoomManager>;
    try { rm = new RoomManager(cfg); } finally { vi.useRealTimers(); }
    const warnFrame = (rm as unknown as { warnFrame(e: unknown): void }).warnFrame.bind(rm);
    clocked('error', () => warnFrame(new Error('кадр')));
  });

  it('сбои сверки конфига с базой (`startConfigSync`, раз в минуту) — тот же класс, восьмой глушитель', async () => {
    const { startConfigSync } = await import('../configSync.js');
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(String(a[0])); });
    let wall = Date.now();
    let mono = performance.now() + 1e9;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const sync = startConfigSync({ readRev: () => Promise.reject(new Error('база недоступна')), initial: 'a', intervalMs: 3_600_000, rebuild: async () => undefined });
    try {
      await sync.check();
      expect(lines, 'первая строка — в лог').toHaveLength(1);
      wall -= 3_600_000; mono += 61_000;   // шаг настенных часов назад на час; по часам процесса прошла минута с лишним
      await sync.check();
      expect(lines, 'шаг часов назад не глушит лог: по часам процесса срок вышел').toHaveLength(2);
      wall += 1_000; mono += 1_000;
      await sync.check();
      expect(lines, 'через секунду — промолчана').toHaveLength(2);
    } finally { sync.stop(); }
  });

  it('шум невалидных команд игрока (`Room.warnClient`)', async () => {
    const { Room } = await import('./room.js');
    const room = new Room('R17L', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
    try {
      const ws = { open: true, ip: '127.0.0.1', send() {}, close() {}, onMessage() {}, onClose() {} } as unknown as GameConn;
      const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'L', 'char-r17l');
      const pid = room.addPlayer(ws, 'user-r17l', save, 1);
      const inner = room as unknown as { clients: Map<string, unknown>; warnClient(c: unknown, text: string): void };
      const c = inner.clients.get(pid)!;
      clocked('warn', () => inner.warnClient(c, 'невалидная команда'));
    } finally { room.stop(); }
  });
});
