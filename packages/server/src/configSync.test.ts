import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './net/conn.js';
import {
  ConfigRegistry, addToInventory, itemFromBaseId, newCharacterSave, shopSellPrice, withConfigRev,
  type ServerFrame, type SaveState, type TownCommand,
} from '@dm/shared';
import { limits } from './net/rateLimit.js';
import { startConfigSync, CONFIG_SYNC_MS } from './configSync.js';

/**
 * ⭐ R16 C-02, C-08: ПРАВКА КОНФИГА — ВО ВСЕХ ПРОЦЕССАХ. Правку редактора пересобирал только принявший её процесс (гейтвей), а нода держала
 * конфиг старта: клиент (конфиг — у гейтвея) слал ревизию гейтвея в каждой команде согласия (V-B3-07), нода сверяла со своей — и любая правка
 * любой таблицы закрывала лавку и кузницу всем её игрокам до перезапуска ноды. Теперь процесс сверяет ревизию оверрайдов в базе
 * (`startConfigSync`) и пересобирает конфиг, когда она сдвинулась. База оверрайдов — в памяти теста, время — поддельное, комната — настоящая.
 */
const db = vi.hoisted(() => ({ saves: new Map<string, number>(), data: new Map<string, SaveState>() }));
vi.mock('./db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, structuredClone(data));
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: () => Promise.resolve(null),
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
}));
vi.mock('./db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Room = import('./net/room.js').Room;
let RoomCtor: typeof import('./net/room.js').Room;
beforeAll(async () => { ({ Room: RoomCtor } = await import('./net/room.js')); });
const rooms: Room[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; }
  onMessage(): void { /* комнату дёргают напрямую */ }
  onClose(): void { /* не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    return this.frames.filter((f) => f.t === t).at(-1) as Extract<ServerFrame, { t: T }> | undefined;
  }
}

/** Маленькая «база оверрайдов»: таблицы и ревизия (как `getConfigOverridesRev`: сдвигается с любой записью). */
function overridesDb(): { all: Record<string, unknown>; rev: number; put(key: string, value: unknown): void } {
  return { all: {}, rev: 0, put(key, value) { this.all[key] = structuredClone(value); this.rev++; } };
}
/** Сборка конфига процесса — как `rebuildConfig` в `index.ts`: дефолты и оверрайды базы. */
function rebuildFrom(reg: ConfigRegistry, store: { all: Record<string, unknown> }): void {
  reg.loadAll();
  reg.reload(structuredClone(store.all));
}
/** Правка таблицы, к ценам не относящейся (окружение биома — фейд стен): ревизия конфига всё равно другая. */
function environmentEdit(reg: ConfigRegistry): unknown {
  const env = structuredClone(reg.get('environment')) as { fade?: { start: number } }[];
  env[0]!.fade!.start += 7;
  return env;
}

describe('⭐ R16 C-02, C-08: правка конфига доходит до нод', () => {
  it('правка на гейтвее (таблица не о ценах) — нода сверкой пересобирает конфиг, и продажа по ревизии гейтвея проходит', async () => {
    const store = overridesDb();
    const gateway = new ConfigRegistry(); rebuildFrom(gateway, store);
    const node = new ConfigRegistry(); rebuildFrom(node, store);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sync = startConfigSync({ readRev: async () => String(store.rev), rebuild: async () => rebuildFrom(node, store), initial: String(store.rev), who: 'node-t' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Герой на ноде, в городе, с мечом на продажу.
    const charId = 'char-cfgsync-1', userId = 'user-cfgsync-1';
    for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(userId);
    const s = newCharacterSave(node, node.get('classes')[0]!.id, 'Sync', charId);
    const sword = itemFromBaseId(node.get('items.base'), 'long-sword', node.get('item-tiers'), 'drop')!;
    expect(addToInventory(s.inventory, sword, node.get('balance').inventory)).toBe(true);
    db.saves.set(charId, 1); db.data.set(charId, structuredClone(s));
    const room = new RoomCtor('CFGS1', node, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
    rooms.push(room);
    room.stop();
    const ws = new FakeWs();
    const pid = room.addPlayer(ws as unknown as GameConn, userId, s, 1);
    // «Применить на сервере» на гейтвее: база и конфиг гейтвея — новые, клиент перечитал конфиг гейтвея.
    store.put('environment', environmentEdit(gateway));
    rebuildFrom(gateway, store);
    expect(gateway.revision(), 'ревизия сдвинулась').not.toBe(node.revision());
    const sell = (id: number): TownCommand => withConfigRev(gateway, { cmd: 'sell', uid: sword.uid, minGold: shopSellPrice(gateway, sword) } as TownCommand);
    await room.handleCmd(pid, sell(1), 1);
    expect(ws.last('cmdResult'), 'до сверки нода отказывает «Цена изменилась»').toMatchObject({ id: 1, ok: false });
    // Сверка по таймеру: нода видит сдвинутую ревизию оверрайдов и пересобирает конфиг.
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS);
    expect(node.revision(), 'конфиг ноды — тот же, что у гейтвея').toBe(gateway.revision());
    await room.handleCmd(pid, sell(2), 2);
    expect(ws.last('cmdResult'), 'продажа по ревизии гейтвея прошла').toMatchObject({ id: 2, ok: true });
    sync.stop();
  });

  it('сверка: неизменная ревизия — без сборки; сбой чтения или сборки — повтор следующей сверкой; сверки не накладываются', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let rev = 'a';
    let readFails = false, buildFails = false;
    let builds = 0, reads = 0;
    let slow: Promise<void> | null = null;
    const sync = startConfigSync({
      readRev: async () => { reads++; if (slow) await slow; if (readFails) throw new Error('база недоступна'); return rev; },
      rebuild: async () => { if (buildFails) throw new Error('база недоступна'); builds++; },
      initial: 'a',
    });
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS * 3);
    expect(builds, 'ревизия та же — сборки нет').toBe(0);
    rev = 'b'; readFails = true;
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS);
    expect(builds, 'чтение упало — сборки нет').toBe(0);
    readFails = false; buildFails = true;
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS);
    expect(builds, 'сборка упала').toBe(0);
    buildFails = false;
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS);
    expect(builds, 'следующая сверка собрала').toBe(1);
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS * 2);
    expect(builds, 'и больше не собирает').toBe(1);
    // Медленная база: пока сверка ждёт ответа, таймер новых не ставит.
    let open!: () => void;
    slow = new Promise<void>((r) => { open = r; });
    const r0 = reads;
    await vi.advanceTimersByTimeAsync(CONFIG_SYNC_MS * 4);
    expect(reads - r0, 'одна сверка в пути').toBe(1);
    slow = null; open();
    await vi.advanceTimersByTimeAsync(0);
    rev = 'c';
    expect(await sync.check(), 'сверка по требованию').toBe(true);
    expect(builds).toBe(2);
    sync.stop();
  });

  it('без ревизии старта первая сверка её только запоминает', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let builds = 0;
    const sync = startConfigSync({ readRev: async () => 'x', rebuild: async () => { builds++; } });
    expect(await sync.check()).toBe(false);
    expect(await sync.check()).toBe(false);
    expect(builds).toBe(0);
    sync.stop();
  });
});
