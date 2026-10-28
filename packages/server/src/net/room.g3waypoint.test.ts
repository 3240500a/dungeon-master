import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, runNodeDepth, isWaypoint, waypointGap, defaultConfigData,
  type SaveState, type ServerFrame, type RunConfig,
} from '@dm/shared';

// Каждый шаг — настоящая генерация этажа и заселение; двадцать этажей подряд в умолчание 5 с не влезают.
vi.setConfig({ testTimeout: 120_000 });

/**
 * ⭐⭐ 14.10 (Г3, В4/В5): ПОРТАЛ МЕТКИ ЕСТЬ ВСЕГДА, УХОД В ГОРОД ЗАБЕГ ПАРКУЕТ, «ЗАВЕРШИТЬ» — СНИМАЕТ.
 *
 * Метка (привал) — чистая функция глубины: `depth % balance.dungeonAccess.waypointStep === 0`. На ней держатся старт
 * забега с метки (В2), счёт HUD «до метки N эт.» (В6) и дорога домой. Поэтому «портал на метке» обязан быть ПРАВИЛОМ,
 * а не удачей данных: сегодня его кладёт геометрия привала (`townFloor`), но биом без rest-этажа (одна галка в
 * редакторе, сторож данных — `shared/dungeon/run/waypointData.test.ts`) оставил бы метку обычным боевым этажом.
 * Комната доливает портал к точке входа сама (`Room.enterNode`), и четвёртый тест ниже мерит именно это.
 *
 * ⚠ ЧТО ЗДЕСЬ ПОД ОХРАНОЙ:
 *  1) двадцать этажей подряд: у КАЖДОГО узла-метки есть портал в город (и только у них — у боевых его нет);
 *  2) уход в город с метки ПАРКУЕТ забег: область `town`, а `save.run` цел и указывает на тот же узел;
 *  3) контроль: «Завершить» (`Room.finish`) с той же метки забег СНИМАЕТ — `save.run` пуст;
 *  4) биом без rest-этажа: привала на метке нет (генератор его не ставит), а портал ВСЁ РАВНО есть — и уйти в город
 *     с такой метки можно.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (проверены руками 14.10: наложить → прогнать → вернуть):
 *  • долив портала в `enterNode` снят → валит (4);
 *  • долив портала безусловный (без `isWaypoint`) → валит (1): портал появился бы и на боевых узлах;
 *  • `returnTown` снимает забег (как `finishRun`) → валит (2);
 *  • `Room.finish` не зовёт `finishRun` → валит (3);
 *  • каденция метки сдвинута (`% step === 1`) → валит (1): портал и привал разъезжаются.
 *
 * База замокана: `db.ts` открывает пул к Postgres при импорте.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, SaveState>() }));
vi.mock('../db/db.js', () => ({
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getCharacter: async (charId: string) => {
    const d = db.data.get(charId);
    return d ? { userId: USER, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Pt = { x: number; y: number };
type P = { alive: boolean; hp: number; pos: Pt; save: SaveState };
type Node = { id: string; depth: number; type: string; edges: { to: string }[] };
type RoomIn = {
  code: string; area: string; movedAt: number; difficultyId: string;
  runConfig: RunConfig | null; runNodeId: string | null;
  runPlan: { nodes: Node[] } | null;
  decor: { kind: string; x: number; y: number }[];
  session: { world: { players: Record<string, P>; monsters: { alive: boolean }[]; spawn: Pt; exits?: Pt[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: unknown, startDepth?: number): void;
  returnTown(pid: string): void;
  finish(pid: string): void;
  castVote(pid: string, yes: boolean): void;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const USER = 'user-g3wp';
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.t === t) return this.frames[i] as Extract<ServerFrame, { t: T }>;
    return undefined;
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

let seq = 0;
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
/** ⭐ Г8-3: места порталов полосы (список). */
const step = (reg: ConfigRegistry = cfg): readonly number[] => reg.get('balance').dungeonAccess.portalsAt;
/** ⭐ Г8-3: длина цикла и самый большой разрыв между метками — ими считаются ожидания ниже. */
const cycleOf = (reg: ConfigRegistry = cfg): number => reg.get('balance').dungeonAccess.contentCycle;
const maxGap = (reg: ConfigRegistry = cfg): number => {
  const p = [...step(reg)].sort((a, b) => a - b);
  const c = cycleOf(reg);
  let worst = p[0] ?? 1;
  for (let i = 1; i < p.length; i++) worst = Math.max(worst, p[i]! - p[i - 1]!);
  return Math.max(worst, c - (p.at(-1) ?? c) + (p[0] ?? 1));   // шов круга: от последнего места до первого
};
const depthNow = (r: RoomIn): number => runNodeDepth(r.runNodeId ?? undefined);
const nodeNow = (r: RoomIn): Node => r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
const portalOf = (r: RoomIn): { x: number; y: number } | undefined => r.decor.find((d) => d.kind === 'portal');
/** Мир без монстров: сторож судит переходы, а не бой (планировщик и так остановлен). */
const noMonsters = (r: RoomIn): void => { for (const m of r.session.world.monsters) m.alive = false; };

/** Соло-герой с рекордом глубины тира «normal» (им открывается старт по метке). */
function hero(record = 0): SaveState {
  const charId = `char-g3wp-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `WP-${seq}`, charId);
  s.level = 40; s.attributes.vitality = 80;
  if (record > 0) s.difficultyProgress.normal = record;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
/** Соло-комната в подземелье на 1-м этаже; планировщик остановлен, монстры сняты. */
async function dive(reg: ConfigRegistry = cfg): Promise<{ r: RoomIn; ws: FakeWs; pid: string }> {
  const r = new RoomCtor(`G3W${++seq}`, reg, hooks);
  rooms.push(r);
  r.stop();
  const ws = new FakeWs();
  const pid = r.addPlayer(ws, USER, hero(), 1);
  await settle();
  r.movedAt = 0;
  r.descend(pid);
  expect(r.area, 'забег начат').toBe('dungeon');
  noMonsters(r);
  return { r, ws, pid };
}
/** Шаг на следующий этаж по первому ребру — от выхода, как честный клиент (R3-01). */
function down(r: RoomIn, pid: string): void {
  const node = nodeNow(r);
  expect(node.edges.length, `с этажа ${node.depth} есть куда идти`).toBeGreaterThan(0);
  r.session.world.players[pid]!.pos = { ...r.session.world.exits![0]! };
  r.movedAt = 0;
  r.descend(pid, undefined, node.edges[0]!.to);
  noMonsters(r);
}
/** Сейв героя, как его видит комната. */
const saveOf = (r: RoomIn, pid: string): SaveState => r.session.world.players[pid]!.save;

describe('⭐⭐ Г3 (В4): портал метки есть всегда, уход в город её не завершает', () => {
  it('⭐ 20 ЭТАЖЕЙ ПОДРЯД: портал в город есть РОВНО на узлах-метках, и «до метки N эт.» совпадает с каденцией', async () => {
    const { r, pid } = await dive();
    const s = step();
    const rows: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = depthNow(r);
      const node = nodeNow(r);
      const mark = isWaypoint(d, s, cycleOf());   // ⭐ Г8-3: метка — МЕСТО полосы, цикл обязателен
      const portal = portalOf(r);
      rows.push(`этаж ${String(d).padStart(2)} · ${node.type.padEnd(8)} · ${mark ? 'МЕТКА' : '     '} · портал ${portal ? 'да' : 'нет'} · до метки ${waypointGap(d, s, cycleOf())}`);
      expect(!!portal, `этаж ${d} (${node.type}): портал обязан быть ровно на метке`).toBe(mark);
      if (mark) {
        expect(node.type, `этаж ${d}: метка — это привал`).toBe('rest');
        expect(waypointGap(d, s, cycleOf()), 'на метке счёт HUD — ноль').toBe(0);
      } else {
        expect(waypointGap(d, s, cycleOf()), `этаж ${d}: до метки больше нуля`).toBeGreaterThan(0);
        // ⭐ Г8-3: «не дальше каденции» — не дальше САМОГО БОЛЬШОГО разрыва между местами порталов полосы.
        expect(waypointGap(d, s, cycleOf()), 'и не дальше самого большого разрыва между метками').toBeLessThanOrEqual(maxGap());
      }
      if (i < 19) down(r, pid);
    }
    console.log(`\nПОРТАЛ МЕТКИ, 20 ЭТАЖЕЙ (места ${s.join(', ')} круга из ${cycleOf()}, замер 15.10)\n${rows.join('\n')}`);
    // ⭐ Г8-3: меток на 20 этажах — ровно столько, сколько мест порталов в полосе (3, 6, 9, 12, 15, 18, 20).
    expect(rows.filter((x) => x.includes('МЕТКА')).length, 'меток на 20 этажах — по списку мест')
      .toBe(s.filter((p) => p <= 20).length);
  });

  it('⭐ уход в город С МЕТКИ забег ПАРКУЕТ (save.run цел), а «Завершить» — снимает', async () => {
    for (const how of ['return', 'finish'] as const) {
      const { r, pid } = await dive();
      const s = step();
      while (!isWaypoint(depthNow(r), s, 0)) down(r, pid);
      const node = nodeNow(r);
      const portal = portalOf(r)!;
      expect(portal, 'на метке портал есть').toBeTruthy();
      r.session.world.players[pid]!.pos = { x: portal.x, y: portal.y };
      r.movedAt = 0;
      if (how === 'return') r.returnTown(pid); else r.finish(pid);
      expect(r.area, `${how}: пати в городе`).toBe('town');
      await settle();
      const run = saveOf(r, pid).run;
      if (how === 'return') {
        expect(run, 'уход в город забег ПАРКУЕТ — его можно продолжить').toBeTruthy();
        expect(run!.currentNodeId, 'указатель стоит на той же метке').toBe(node.id);
      } else {
        expect(run, '«Завершить» забег снимает').toBeUndefined();
      }
    }
  });

  it('⚠⚠ Г8-4: биом БЕЗ rest-этажа — узел на метке ВСЁ РАВНО привал, и портал в город есть', async () => {
    // Та самая одна галка редактора (её ловит сторож данных В7); правило В4 обязано держать игру и без неё.
    // ⚠⚠ ОЖИДАНИЕ ПЕРЕВЁРНУТО В Г8-4 (решение владельца): прежде генератор спрашивал у биома, есть ли этаж роли
    // `rest`, и БЕЗ него метку не ставил — здесь ждали «тип узла НЕ rest». Теперь место круга решает всё: узел
    // привальный, а нехватка этажа меняет лишь его ВИД (об этом кричит `waypointWarnings`).
    const tables = structuredClone(defaultConfigData) as Record<string, unknown>;
    (tables['floors'] as { id: string; role: string; enabled?: boolean }[])
      .forEach((f) => { if (f.role === 'rest') f.enabled = false; });
    const reg = new ConfigRegistry();
    reg.loadAll(tables, { cross: false });

    const { r, pid } = await dive(reg);
    const s = step(reg);
    while (!isWaypoint(depthNow(r), s, 0)) down(r, pid);
    const node = nodeNow(r);
    expect(node.type, '⭐ Г8-4: узел на метке — привал даже без rest-этажа биома').toBe('rest');
    const portal = portalOf(r);
    expect(portal, 'а портал на метке комната долила сама (В4)').toBeTruthy();
    r.session.world.players[pid]!.pos = { x: portal!.x, y: portal!.y };
    r.movedAt = 0;
    r.returnTown(pid);
    expect(r.area, 'с такой метки уйти в город можно').toBe('town');
    expect(saveOf(r, pid).run, 'и забег припаркован, а не потерян').toBeTruthy();
    console.log(`[В4+Г8-4] биом без rest-этажа: этаж ${node.depth} тип «${node.type}» (узел остался), портал есть — уход в город прошёл`);
  });
});
