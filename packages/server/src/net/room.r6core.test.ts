import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, trackObjective, type ServerFrame, type SaveState } from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * Раунд 6 (ядро): то, что правка ядра обязана довезти через настоящую `Room` — согласие на цену покупки (R6-16) и
 * замена начатого задания доски только с согласия игрока (R6-13). Сокет — фейковый, база — заглушка (запись не нужна).
 */
vi.mock('../db/db.js', () => ({
  putCharacter: (_c: string, _u: string, _d: SaveState, v: number) => Promise.resolve(v + 1),
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const r of rooms.splice(0)) r.stop(); });

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
  count(t: ServerFrame['t']): number { return this.frames.filter((f) => f.t === t).length; }
}

const rooms: Room[] = [];
let seq = 0;
function makeRoom(userId: string): { room: Room; ws: FakeWs; pid: string; save: SaveState } {
  limits.forgeCmd.reset(userId); limits.townCmd.reset(userId); limits.cmdResync.reset(userId);
  cfg = new ConfigRegistry();
  cfg.loadAll();
  const room = new RoomCtor('R6C', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Герой', `char-r6c-${++seq}`);
  save.gold = 1_000_000;
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { room, ws, pid, save };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('Room — R6-16: покупка по цене кадра лавки', () => {
  it('⭐ цены подняли живьём: «купить» по цене кадра — отказ и свежий кадр лавки; по новой цене — куплено', async () => {
    const { room, ws, pid, save } = makeRoom('user-r616');
    await settle();
    const frame = ws.last('shop')!;
    const it = frame.items.find((i) => i.kind !== 'consumable')!;
    expect(it, 'на прилавке есть снаряжение').toBeDefined();
    const shown = frame.prices![it.uid]!;
    // Правка из редактора: сервер перечитывает реестр на месте, кадр лавки клиенту не шлёт.
    cfg.reload({ rarities: cfg.get('rarities').map((r) => ({ ...r, priceMult: r.priceMult * 1.5 })) });
    const shops = ws.count('shop');
    const gold0 = save.gold;
    await room.handleCmd(pid, { cmd: 'buy', uid: it.uid, maxGold: shown }, 1);
    const r = ws.last('cmdResult')!;
    expect(r, 'было: молча брал новую цену').toMatchObject({ id: 1, ok: false });
    expect(r.reason).toMatch(/^Цена изменилась/);
    expect(save.gold, 'ни монеты').toBe(gold0);
    expect(save.inventory.some((x) => x.uid === it.uid)).toBe(false);
    expect(ws.count('shop'), 'кадр лавки с ценами сервера — заново').toBeGreaterThan(shops);
    const real = ws.last('shop')!.prices![it.uid]!;
    expect(real).toBeGreaterThan(shown);
    await room.handleCmd(pid, { cmd: 'buy', uid: it.uid, maxGold: real }, 2);
    expect(ws.last('cmdResult')).toMatchObject({ id: 2, ok: true });
    expect(gold0 - save.gold).toBe(real);
  });
});

describe('Room — R6-13: начатое задание доски не пропадает молча', () => {
  it('⭐ зачистка на 11 из 12, доска обновилась — «Взять» зачистку: отказ; с согласием (`replace`) — заменена', async () => {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { room, ws, pid, save } = makeRoom('user-r613');
    await settle();
    const cullOf = (): { id: string; objectives: { type: string; target?: string; amount: number }[] } | undefined =>
      (ws.last('questBoard')?.quests ?? []).find((q) => q.objectives.some((o) => o.type === 'kill'));
    const first = cullOf()!;
    expect(first, 'на доске есть зачистка').toBeDefined();
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: first.id }, 1);
    expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
    const o = first.objectives[0]!;
    for (let i = 0; i < o.amount - 1; i++) trackObjective(save, 'kill', o.target!);
    // Срок доски вышел — «Взять» сперва катает новую (R5-19), с неё и берём.
    vi.setSystemTime(T0 + cfg.get('balance').townRestockSec * 1000 + 60_000);
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: first.id }, 2);
    const next = cullOf()!;
    expect(next.id).not.toBe(first.id);
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: next.id }, 3);
    const r = ws.last('cmdResult')!;
    expect(r, 'было: ok, а начатое пропадало').toMatchObject({ id: 3, ok: false });
    expect(r.reason).toContain('задание этого вида');
    expect(save.quests.find((q) => q.questId === first.id)?.counters.o1, 'прогресс на месте').toBe(o.amount - 1);
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: next.id, replace: true }, 4);
    expect(ws.last('cmdResult')).toMatchObject({ id: 4, ok: true });
    expect(save.quests.some((q) => q.questId === first.id)).toBe(false);
    expect(save.quests.some((q) => q.questId === next.id)).toBe(true);
  });
});
