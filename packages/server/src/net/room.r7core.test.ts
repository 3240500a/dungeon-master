import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type SessionEvent } from '@dm/shared';
import { limits } from './rateLimit.js';

/**
 * Раунд 7 (ядро): то, что правка ядра обязана довезти через настоящую `Room` — добитое статусом вернувшемуся реконнектом
 * хозяину статуса (R7-07) и окно реконнекта длиннее предела таймера Node (R7-20). Сокет — фейковый, база — заглушка.
 */
vi.mock('../db/db.js', () => ({
  // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
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
  /** Все события сессии, разосланные этому сокету кадрами `events`. */
  events(): SessionEvent[] { return this.frames.flatMap((f) => (f.t === 'events' ? f.events : [])); }
}

const rooms: Room[] = [];
let seq = 0;
function makeRoom(userId: string, classId = 'warrior'): { room: Room; ws: FakeWs; pid: string; save: SaveState } {
  limits.forgeCmd.reset(userId); limits.townCmd.reset(userId); limits.cmdResync.reset(userId);
  cfg = new ConfigRegistry();
  cfg.loadAll();
  const room = new RoomCtor('R7C', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, classId, 'Герой', `char-r7c-${++seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { room, ws, pid, save };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const idle = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
type Pt = { x: number; y: number };
type M7 = { id: number; alive: boolean; hp: number; pos: Pt; debuffs: Record<string, unknown>; def: { id: string; hpRegen: number; xp: number } };
type P7 = { hp: number; maxHp: number; mana: number; pos: Pt };
type W7 = { monsters: M7[]; players: Record<string, P7> };
const worldOf = (room: Room): W7 => (room as unknown as { session: { world: W7 } }).session.world;
const areaOf = (room: Room): string => (room as unknown as { area: string }).area;
const graceOf = (room: Room): Map<string, unknown> => (room as unknown as { disconnected: Map<string, unknown> }).disconnected;
type NodeRec = { killed: number[] };
const nodeOf = (room: Room): NodeRec | null => (room as unknown as { nodeState: NodeRec | null }).nodeState;

/**
 * ⚠ R7-07: ВЕРНУВШИЙСЯ — ТОТ ЖЕ ГЕРОЙ. Каждый вход в комнату — новый id (`p_<uuid>`), а хозяин яда искался по старому: соло-
 * герой отравил монстра, отвалился (комната на грейсе, мир стоит, яд ждёт), вернулся «Продолжить» — и добитое уходило
 * никому: ни опыта, ни добычи, ни «Уничтожить N», а запись узла (R4-01) помечала монстра убитым навсегда.
 */
describe('Room — R7-07: добитое ядом — вернувшемуся реконнектом хозяину яда', () => {
  it('⭐ соло: отравил, обрыв, «Продолжить» — смерть от яда его: событие с НОВЫМ id, опыт, запись узла', async () => {
    const { room, pid, save } = makeRoom('user-r707', 'mage');
    save.skills['b-curse-a4'] = 1;
    await settle();
    room.descend(pid);
    await settle();
    expect(areaOf(room)).toBe('dungeon');
    const w = worldOf(room);
    const m = w.monsters.find((x) => x.alive)!;
    m.hp = 1e6; m.def.hpRegen = 0; m.def.xp = 500;
    const me = w.players[pid]!;
    me.pos = { ...m.pos };
    // Яд проклятия ложится с шансом 0.9, откат 9 с: жмём каст, пока не ляжет (40 с — пять попыток, промах всех — 1e-5).
    for (let i = 0; i < 1200 && !m.debuffs.poison; i++) {
      me.hp = me.maxHp; me.mana = 999; me.pos = { ...m.pos };
      room.setInput(pid, { ...idle, cast: 'b-curse-a4' });   // свежий кадр каждый тик — иначе ввод устареет в «стоять»
      room.step(false);
    }
    room.setInput(pid, idle);
    expect(m.debuffs.poison, 'яд повешен самой сессией').toBeTruthy();
    const at = { ...me.pos };
    void room.removePlayer(pid);                       // закрыл вкладку — грейс, мир на паузе
    await settle();
    expect(graceOf(room).has(save.charId), 'ждёт реконнекта').toBe(true);
    const back = structuredClone(save);                // вернулся с сейвом из базы — новый объект
    const xp0 = back.xp;
    const ws2 = new FakeWs();
    const pid2 = room.reconnect(ws2 as unknown as GameConn, 'user-r707', back, 2);
    expect(pid2).not.toBe(pid);
    const me2 = worldOf(room).players[pid2]!;
    me2.pos = at;
    m.hp = 0.01;                                       // следующий тик яда добивает
    for (let i = 0; i < 30 && m.alive; i++) { me2.hp = me2.maxHp; room.step(false); }
    expect(m.alive, 'яд добил').toBe(false);
    const died = ws2.events().find((e) => e.type === 'monster-died' && e.id === m.id) as Extract<SessionEvent, { type: 'monster-died' }> | undefined;
    expect(died, 'событие смерти разослано').toBeDefined();
    expect(died!.by, 'было: undefined — убийство без награды').toBe(pid2);
    expect(ws2.events().some((e) => e.type === 'xp' && e.playerId === pid2), 'опыт за убийство').toBe(true);
    expect(back.xp).toBeGreaterThan(xp0);
    expect(nodeOf(room)?.killed.length, 'запись узла — убит (продолжение его не вернёт)').toBeGreaterThan(0);
  });
});

/**
 * ⚠ R7-20: ОКНО РЕКОННЕКТА ДЛИННЕЕ ПРЕДЕЛА ТАЙМЕРА. `setTimeout` Node держит не больше 2^31−1 мс (~24,8 суток): дольше —
 * `TimeoutOverflowWarning` и срабатывание через 1 мс. Щедрое окно в 30 суток из редактора хоронило каждого отвалившегося
 * в подземелье сразу: штраф смерти и снятый забег. Схема держит потолок, комната — сторожа таймера.
 */
describe('Room — R7-20: окно реконнекта длиннее предела таймера Node', () => {
  for (const sec of [30 * 24 * 3600, 2_000_000]) {
    it(`⭐ reconnectGraceSec = ${sec}: отключённый ждёт, а не хоронится через 1 мс`, async () => {
      const { room, pid, save } = makeRoom(`user-r720-${sec}`);
      await settle();
      room.descend(pid);
      await settle();
      expect(save.run, 'в забеге').toBeTruthy();
      // Мимо схемы (она теперь держит потолок): сторож таймера в комнате — вторая линия.
      (cfg.get('balance') as { reconnectGraceSec: number }).reconnectGraceSec = sec;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      void room.removePlayer(pid);
      vi.advanceTimersByTime(1_000);                  // переполненный таймер сработал бы через 1 мс
      expect(graceOf(room).has(save.charId), 'было: похоронен через 1 мс').toBe(true);
      expect(save.run, 'забег цел').toBeTruthy();
    });
  }
});
