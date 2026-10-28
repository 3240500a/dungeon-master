import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, RUN_NODES_MAX, type SaveState, type RunConfig, type RunNodeState } from '@dm/shared';

vi.setConfig({ testTimeout: 30_000 });

/**
 * ⭐⭐ 14.10: ШОВ «КОМНАТА/МЕНЕДЖЕР → СВОД БАЗЫ» — ГЛУБИНА ДОЕЗЖАЕТ ДО ЗАПРОСА.
 *
 * Чтение свода забега режется по глубине СПРАШИВАЮЩЕГО: `getRunLedger(key, limit, atDepth)` отдаёт записи не глубже
 * его узла (`db/db.ts`). Правило лечит беду разошедшейся пати (R9-01): комната, стоящая на мелком узле, получала
 * глубокий хвост напарника БЕЗ записи своего узла — и собирала свой узел СВЕЖИМ (сундук цел, босс жив, возврат R4-01).
 *
 * ⚠ ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ. Правило было прочитано в коде и верно, но зубов у шва не было НИ ОДНОГО: `grep atDepth`
 * по тестам давал только `db/runLedger.test.ts` — он зовёт `getRunLedger` НАПРЯМУЮ. А все серверные моки
 * `getRunLedger` принимают ОДИН аргумент (`async () => []`), поэтому удаление третьего аргумента у обоих вызывающих
 * оставляло весь пакет зелёным. Здесь мок ЗАПОМИНАЕТ аргументы — и шов проверяется с той стороны, с которой он живёт.
 *
 * Два вызывающих, и у каждого своя глубина:
 *  · `Room.resumeFromLedger` (продолжение забега из города) — САМЫЙ ГЛУБОКИЙ указатель этого забега В КОМНАТЕ: ровно
 *    тот узел, с которого продолжит `resumeRun`, и ровно тот, что показало окно голосования (R9-08);
 *  · `RoomManager.foldRunLedger` (вход героя: вливание свода в его сейв) — глубина ЕГО СОБСТВЕННОГО указателя.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 14.10: наложить → прогнать → вернуть, md5
 * сверен):
 *  • снять третий аргумент у `getRunLedger` в `room.ts` — валит «комната даёт самый глубокий указатель»;
 *  • снять третий аргумент у `getRunLedger` в `roomManager.ts` — валит «вход даёт глубину своего сейва»;
 *  • `Math.max` → `Math.min` в сборе глубины комнаты — валит «самый глубокий, а не самый мелкий»;
 *  • зажать глубину в ноль (`Math.max(0, …)`) у порченого указателя — валит «порченое имя едет как −1»
 *    (окно «вокруг 0» было бы ПУСТЫМ: узлов глубины 0 нет, и узел собрался бы свежим).
 */
const db = vi.hoisted(() => ({
  versions: new Map<string, number>(), data: new Map<string, SaveState>(),
  /** Аргументы КАЖДОГО вызова `getRunLedger` — предмет этого файла. */
  calls: [] as { key: string; limit?: number; atDepth?: number; argc: number }[],
  rows: [] as RunNodeState[],
}));
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
  getRunLedger: async (...args: unknown[]) => {
    db.calls.push({ key: args[0] as string, limit: args[1] as number | undefined, atDepth: args[2] as number | undefined, argc: args.length });
    return structuredClone(db.rows);
  },
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
  getSession: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type Pt = { x: number; y: number };
type RoomIn = {
  area: string; movedAt: number; runNodeId: string | null;
  session: { world: { players: Record<string, { save: SaveState; pos: Pt }>; spawn: Pt } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string): void;
  castVote(pid: string, yes: boolean): void;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let MgrCtor: new (cfg: ConfigRegistry) => unknown;
let ledgerKey: (c: RunConfig) => string;
let cfg: ConfigRegistry;
const USER = 'user-seam';
beforeAll(async () => {
  const room = (await import('./room.js')) as unknown as { Room: typeof RoomCtor; runLedgerKey: typeof ledgerKey };
  RoomCtor = room.Room; ledgerKey = room.runLedgerKey;
  ({ RoomManager: MgrCtor } = (await import('./roomManager.js')) as unknown as { RoomManager: typeof MgrCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); db.calls.length = 0; db.rows.length = 0; });

class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  send(): void {} close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

let seq = 0;
/** Забег, припаркованный на узле `node`: конфиг один на всех героев пати (`sameRun`). */
const parked = (config: RunConfig, node: string): NonNullable<SaveState['run']> =>
  ({ config, currentNodeId: node, visited: [node] });
function hero(run?: NonNullable<SaveState['run']>): SaveState {
  const charId = `char-seam-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `S${seq}`, charId);
  s.level = 20;
  if (run) s.run = structuredClone(run);
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
const runCfg = (): RunConfig => ({
  biomeId: cfg.get('biomes')[0]!.id,
  tier: 'normal', seed: 12345, modifiers: [], id: `seam-run-${++seq}`, floorKey: 'ab'.repeat(16),
});

describe('⭐⭐ 14.10: глубина спрашивающего доезжает до запроса свода', () => {
  it('⭐ комната (продолжение из города) даёт САМЫЙ ГЛУБОКИЙ указатель забега в ней', async () => {
    const config = runCfg();
    const r = new RoomCtor('SEAM1', cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} });
    rooms.push(r);
    const pa = r.addPlayer(new FakeWs(), USER, hero(parked(config, 'n57_3')), 1);
    const pb = r.addPlayer(new FakeWs(), USER, hero(parked(config, 'n61_0')), 1);
    await settle();
    expect(r.area, 'оба в городе, забег припаркован').toBe('town');
    db.calls.length = 0;
    r.movedAt = 0;
    r.descend(pa);
    r.castVote(pb, true);
    await settle();

    const call = db.calls.find((c) => c.key === ledgerKey(config));
    expect(call, 'свод забега читался').toBeTruthy();
    expect(call!.argc, 'третий аргумент передан (без него окно режется от самой глубокой записи ЗАБЕГА)').toBe(3);
    expect(call!.limit, 'окно — размер окна записей сейва').toBe(RUN_NODES_MAX);
    expect(call!.atDepth, 'самый глубокий указатель В КОМНАТЕ (57 и 61 → 61)').toBe(61);
    // И продолжение действительно пошло на этот узел — глубина запроса и глубина входа совпадают.
    expect(r.runNodeId, 'продолжили с самого глубокого указателя').toBe('n61_0');
  });

  it('⚠ порченый указатель едет как −1 («глубину не знаю»), а не как 0', async () => {
    const config = runCfg();
    const r = new RoomCtor('SEAM2', cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} });
    rooms.push(r);
    const pid = r.addPlayer(new FakeWs(), USER, hero(parked(config, 'boss')), 1);
    await settle();
    db.calls.length = 0;
    r.movedAt = 0;
    r.descend(pid);
    await settle();
    const call = db.calls.find((c) => c.key === ledgerKey(config));
    expect(call?.atDepth, 'не-имя узла — −1, иначе окно «вокруг 0» пустое и узел свежий').toBe(-1);
  });

  it('⭐ вход героя (вливание свода в его сейв) даёт глубину ЕГО указателя', async () => {
    const config = runCfg();
    const mgr = new MgrCtor(cfg) as { foldRunLedger(s: SaveState): Promise<boolean> };
    const save = hero(parked(config, 'n143_2'));
    db.calls.length = 0;
    db.rows = [{ id: 'n143_2', el: 20, chests: [1], killed: [2], levers: [] }];
    // `foldRunLedger` — приватный шов входа (`join` зовёт его перед сборкой сессии): предмет здесь только аргументы.
    const ok = await (mgr as unknown as { foldRunLedger(s: SaveState): Promise<boolean> }).foldRunLedger(save);
    expect(ok, 'свод прочитан').toBe(true);
    expect(db.calls.length, 'ровно одно чтение').toBe(1);
    const call = db.calls[0]!;
    expect(call.key).toBe(ledgerKey(config));
    expect(call.argc, 'третий аргумент передан').toBe(3);
    expect(call.limit).toBe(RUN_NODES_MAX);
    expect(call.atDepth, 'глубина указателя этого сейва (n143_2 → 143)').toBe(143);
    // И прочитанное влилось в сейв: запись своего узла на месте (ради неё рез по глубине и сделан).
    expect(save.run!.node?.id ?? save.run!.nodes?.[0]?.id, 'запись узла влита').toBe('n143_2');
  });

  it('вход героя БЕЗ забега свод не читает вовсе', async () => {
    const mgr = new MgrCtor(cfg) as { foldRunLedger(s: SaveState): Promise<boolean> };
    db.calls.length = 0;
    expect(await mgr.foldRunLedger(hero())).toBe(true);
    expect(db.calls.length, 'лишнего запроса в базу нет').toBe(0);
  });
});
