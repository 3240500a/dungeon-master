import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, type SaveState } from '@dm/shared';
import type { GameConn } from './conn.js';
import type { SessionTelemetry } from './telemetry.js';

/**
 * ⭐ E2E 29.09 (шестой прогон): ЗАПИСИ ТЕЛЕМЕТРИИ СЕССИИ — ПО ОЧЕРЕДИ. Комната пишет строку сессии (`play_sessions`) раз в
 * `DM_TELEMETRY_FLUSH_MS` (`flushTelemetry`) и при снятии (`removePlayer`, `dropStale`) — обе записи уходили `void` и не ждали друг друга.
 * Первая заводит строку (INSERT, её id — в `tmRow` только по ответу), и снятие, пришедшее, пока она в полёте, заводило ВТОРУЮ строку той же
 * сессии: её ковки, переплавки и зачарования в сумме `play_sessions` — дважды (по этим суммам сверяют «цену ковки ≈ времени фарма»), у
 * детектора аномалий — две сессии вместо одной. Строка уже есть — два UPDATE на разных соединениях пула ложились в любом порядке, и
 * запоздавший периодический затирал закрытие: сессия навсегда «не кончилась» (`ended_at` пуст), без последних действий.
 * Живьём (кластер, `poc:craft`) — одно чтение сразу за выходом не застало строку; стенд теперь ждёт её, а здесь — порядок самих записей.
 */
type Call = { id: string | null; ended: boolean; crafted: number; done: (id: string | null) => void };
const tm = vi.hoisted(() => ({ calls: [] as Call[], rows: 0 }));
vi.mock('../db/db.js', () => ({
  putCharacter: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterOwned: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
  landedVersion: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
}));
// Запись телеметрии висит, пока тест её не отпустит (`done`): INSERT (id — null) отвечает новым id строки, UPDATE — тем же.
vi.mock('../db/telemetry.js', () => ({
  upsertPlaySession: (id: string | null, _u: string, _c: string, _ip: string | null, t: SessionTelemetry, ended: boolean) =>
    new Promise<string | null>((res) => { tm.calls.push({ id, ended, crafted: t.crafted, done: res }); }),
}));

type RoomIn = {
  addPlayer(ws: GameConn, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<unknown>;
  step(emit?: boolean): void;
  stop(): void;
  clients: Map<string, { tm: SessionTelemetry; tmFlushedAt: number; tmRow: string | null }>;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
  for (const c of tm.calls.splice(0)) c.done(c.id);   // висящие — отпустить: комната не ждёт их после теста
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  send(): void {}
  close(): void { this.open = false; }
  onMessage(): void {} onClose(): void {}
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
let seq = 0;

/** Герой в городе; его периодическая запись телеметрии ушла (`step` после срока) и висит. */
async function periodicInFlight(tmRow: string | null): Promise<{ room: RoomIn; pid: string; periodic: Call }> {
  const charId = `char-tmw-${++seq}`;
  const room = new RoomCtor(`TMW${seq}`, cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {}, onFarewell: () => {} });
  rooms.push(room);
  const pid = room.addPlayer(new FakeWs() as unknown as GameConn, `user-${charId}`, newCharacterSave(cfg, cfg.get('classes')[0]!.id, `T${seq}`, charId), 1);
  const c = room.clients.get(pid)!;
  c.tmRow = tmRow;
  c.tm.crafted = 1;
  c.tmFlushedAt = 0;   // срок периодической записи вышел
  room.step(false);
  await settle();
  expect(tm.calls.length, 'периодическая запись ушла').toBe(1);
  return { room, pid, periodic: tm.calls[0]! };
}

describe('⭐ E2E 29.09 (шестой прогон): записи телеметрии одной сессии — по очереди', () => {
  it('снятие, пока первая (INSERT) в полёте, — не вторая строка: закрытие ждёт её и пишет в ту же', async () => {
    const { room, pid, periodic } = await periodicInFlight(null);
    expect(periodic).toMatchObject({ id: null, ended: false });
    room.clients.get(pid)!.tm.crafted = 2;   // сессия успела сковать ещё
    void room.removePlayer(pid);
    await settle();
    expect(tm.calls.length, 'закрытие ждёт, пока первая запись заведёт строку (раньше — второй INSERT сразу)').toBe(1);
    periodic.done('row-1');
    await settle();
    expect(tm.calls.map((c) => ({ id: c.id, ended: c.ended })), 'одна строка на сессию: закрытие — UPDATE той же').toEqual([
      { id: null, ended: false }, { id: 'row-1', ended: true },
    ]);
    expect(tm.calls[1]!.crafted, 'закрытие несёт всё, что было до снятия').toBe(2);
  });

  it('строка есть: запоздавший периодический UPDATE не ляжет после закрытия — закрытие уходит за ним', async () => {
    const { room, pid, periodic } = await periodicInFlight('row-7');
    expect(periodic).toMatchObject({ id: 'row-7', ended: false });
    void room.removePlayer(pid);
    await settle();
    expect(tm.calls.length, 'закрытие ждёт висящую запись той же строки (раньше — второй UPDATE наперегонки)').toBe(1);
    periodic.done('row-7');
    await settle();
    expect(tm.calls.map((c) => ({ id: c.id, ended: c.ended }))).toEqual([{ id: 'row-7', ended: false }, { id: 'row-7', ended: true }]);
  });
});
