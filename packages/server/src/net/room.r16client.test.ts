import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import { ConfigRegistry, newCharacterSave, type ServerFrame, type SaveState, type RunPlan, type RunNode } from '@dm/shared';
import { limits } from './rateLimit.js';

// Комнату тест ведёт сам (зов, голос, стойка у выхода), планировщик остановлен — исход решают шаги теста, а не часы. Потолок — только
// про импорт графа комнаты под нагрузкой полного прогона.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐ R16-04 (КЛИЕНТ): ГОЛОСОВАНИЕ В ПОДЗЕМЕЛЬЕ ГОВОРИТ, КУДА ВЕДЁТ. Кадр `voteStart` на развилке нёс цель (`targetNodeId`/`targetNodeType`),
 * но окно напарника её не читало, а на финале (узел без рёбер) комната голосует за ЗАВЕРШЕНИЕ забега (`finish`) — и кадр этого не
 * говорил вовсе: принявший «Спуск на след. этаж?» уходил в город, и всё, что лежало на полу финала, пропадало со сменой области.
 * Здесь — что кадр несёт: тип узла ребра выхода, у которого стоит зовущий, и `finish` финала (текст окна — `client/ui/voteText.test.ts`).
 * Комната настоящая, сокет — фейковый, база — маленькая честная (версии сейва).
 */
const db = vi.hoisted(() => ({ saves: new Map<string, number>(), data: new Map<string, SaveState>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: (charId: string, _u: string, data: SaveState, v: number) => {
    const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
    if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve(null);
    db.saves.set(charId, v + 1);
    db.data.set(charId, snap);
    return Promise.resolve(v + 1);
  },
  putCharacterWithStash: () => Promise.resolve({ ok: false, conflict: 'stash' }),
  getCharacter: (charId: string) => {
    const d = db.data.get(charId);
    return Promise.resolve(d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.saves.get(charId) ?? 1 } : null);
  },
  getAccountStash: () => Promise.resolve(null),
  putAccountStash: () => Promise.resolve(),
  getRunLedger: () => Promise.resolve([]),
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: () => Promise.resolve(null),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: Room[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

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
}

type Pt = { x: number; y: number };
/** Внутренности комнаты, до которых тесту приходится дотягиваться (это тест). */
type RoomIn = {
  area: string; movedAt: number; runPlan: RunPlan | null; runNodeId: string | null;
  decor: { kind: string; x: number; y: number }[];
  session: { world: { exits?: Pt[]; monsters: { alive: boolean }[]; players: Record<string, { pos: Pt }> } };
};
const inner = (room: Room): RoomIn => room as unknown as RoomIn;
const ready = (room: Room): void => { inner(room).movedAt = 0; };
let seq = 0;

function hero(): { save: SaveState; userId: string } {
  const charId = `char-r16c04-${++seq}`;
  const uid = `user-${charId}`;
  for (const l of [limits.townCmd, limits.forgeCmd, limits.cmdResync]) l.reset(uid);
  const s = newCharacterSave(cfg, cfg.get('classes')[0]!.id, `V${seq}`, charId);
  db.saves.set(charId, 1);
  db.data.set(charId, structuredClone(s));
  return { save: s, userId: uid };
}
function join(room: Room, h: { save: SaveState; userId: string }): { ws: FakeWs; pid: string } {
  const ws = new FakeWs();
  const pid = room.addPlayer(ws as unknown as GameConn, h.userId, h.save, 1);
  return { ws, pid };
}
const nodeOf = (room: Room, id: string): RunNode => inner(room).runPlan!.nodes.find((n) => n.id === id)!;
const nodeNow = (room: Room): RunNode => nodeOf(room, inner(room).runNodeId!);
const noMonsters = (room: Room): void => { for (const m of inner(room).session.world.monsters) m.alive = false; };
/** Встать к выходу ребра на узел `to`. */
function toExit(room: Room, pid: string, to: string): void {
  const i = nodeNow(room).edges.findIndex((e) => e.to === to);
  const at = inner(room).session.world.exits![i]!;
  inner(room).session.world.players[pid]!.pos = { x: at.x, y: at.y };
}

describe('⭐ R16-04: кадр голосования в подземелье — куда ведёт', () => {
  it('развилка: окно напарника получает тип узла ребра выхода зовущего; финал: `finish` — голосование за завершение забега', () => {
    let forks = 0, finals = 0;
    for (let attempt = 0; attempt < 8 && !(forks && finals); attempt++) {
      const room = new RoomCtor(`R16C04-${attempt}`, cfg, { onEmpty() {}, onGrace() {}, onUngrace() {}, onFarewell() {} });
      rooms.push(room);
      room.stop();                                           // мир стоит: монстры не вмешиваются в голосования
      const a = join(room, hero()), b = join(room, hero());
      ready(room);
      room.descend(a.pid, 'easy', undefined, { templateId: 'deep-expedition' });
      room.castVote(b.pid, true);
      expect(inner(room).area).toBe('dungeon');
      for (let guard = 0; guard < 40 && nodeNow(room).edges.length > 0; guard++) {
        noMonsters(room);
        const cur = nodeNow(room);
        // На развилке — НЕ первое ребро: кадр обязан нести цель выхода, у которого стоит зовущий, а не «куда-нибудь».
        const edge = cur.edges.length >= 2 ? cur.edges[1]! : cur.edges[0]!;
        toExit(room, a.pid, edge.to);
        ready(room);
        room.descend(a.pid, undefined, edge.to);
        const f = b.ws.last('voteStart')!;
        expect(f, 'спуск по ребру — не завершение').not.toHaveProperty('finish');
        expect(f).toMatchObject({ kind: 'descend', by: a.pid, targetNodeId: edge.to, targetNodeType: nodeOf(room, edge.to).type });
        if (cur.edges.length >= 2) forks++;
        room.castVote(b.pid, true);
        expect(inner(room).runNodeId, 'прошёл показанный спуск').toBe(edge.to);
      }
      expect(nodeNow(room).edges, 'дошли до финала').toHaveLength(0);
      noMonsters(room);
      const portal = inner(room).decor.find((d) => d.kind === 'portal')!;
      inner(room).session.world.players[a.pid]!.pos = { x: portal.x, y: portal.y };
      ready(room);
      room.descend(a.pid);
      const f = b.ws.last('voteStart')!;
      expect(f, 'было: кадр финала — как обычный спуск, окно «Спуск на след. этаж?»').toMatchObject({ kind: 'descend', by: a.pid, finish: true });
      expect(f.targetNodeId).toBeUndefined();
      finals++;
      room.castVote(b.pid, true);
      expect(inner(room).area, 'принятое завершение — в город').toBe('town');
    }
    expect(forks, 'в графах встретилась развилка').toBeGreaterThan(0);
    expect(finals).toBeGreaterThan(0);
  });
});
