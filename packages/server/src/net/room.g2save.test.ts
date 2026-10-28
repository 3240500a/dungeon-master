import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, RUN_NODES_MAX, RUN_VISITED_MAX, type SaveState, type RunPlan, type RunConfig } from '@dm/shared';

// Спуск на сотни этажей — это сотни настоящих генераций этажа и заселений; умолчание 5 с тут лотерея.
vi.setConfig({ testTimeout: 120_000 });

/**
 * ⭐⭐ 13.10 (Г2, Р5): ЗАМЕР — СЕЙВ БЕСКОНЕЧНОГО СПУСКА НЕ РАСТЁТ.
 *
 * Спуск больше не кончается (окно слоёв, адресуемое глубиной), а сейв забега вёл два списка «на всю историю»:
 * `run.visited` — без потолка вовсе, `run.nodes` — с потолком 512, но ОТКАЗОМ новым записям. Первое растило бы строку
 * Postgres на запись за этаж навсегда, второе на 513-м этаже перестало бы помнить взятое — то есть вернуло бы фарм
 * узла продолжением (R4-01). Р5 сделала оба списка ОКНОМ самых глубоких записей.
 *
 * ⭐⭐ 13.10 (решение владельца-архитектора): окно записей СУЖЕНО 512 → 32 (`RUN_NODES_MAX`), и этот замер — его
 * обоснование: полка сейва на 600-м этаже ≈35 КБ → ≈6,2 КБ (сам забег ≈31,6 КБ → ≈2,8 КБ). Держать полтысячи
 * записей незачем — вернуться можно только на припаркованный узел или туда, где стоит напарник.
 *
 * ⚠ 14.10: ПОЛКУ ПИШЕМ ОКРУГЛЁННО, И ЭТО НЕ ЛЕНЬ. Шесть прогонов 14.10 дали 6 226 / 6 227 / 6 228 Б: номера узлов и
 * число убитых в записях пляшут от сида, и точная цифра в документах ссорила их между собой (где-то 6 227, где-то
 * 6 228 — «та же» полка). Предмет замера — что полка СТОИТ (отношение 300 → 600 и потолок 10 000 Б ниже), а не её
 * последняя цифра.
 *
 * Здесь это проверяется НЕ на чистых функциях (их сторож — `shared/dungeon/run/nodeState.test.ts`), а на настоящей
 * `Room`: спуск идёт её собственным `enterNode` — тем самым швом, который пишет указатель, `visited`, записи узлов и
 * свод, — и меряется РАЗМЕР СЕЙВА В БАЙТАХ, как он уйдёт в базу. Голосование и стояние у выхода намеренно не
 * повторяются: предмет замера — рост сейва с глубиной, а не правила перехода (их стерегут `room.run.test.ts`).
 *
 * База замокана: `db.ts` открывает пул к Postgres при импорте.
 */
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, unknown>() }));
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
    return d ? { userId: `user-${charId}`, data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
  getRunLedger: async () => [],
  mergeRunLedger: () => Promise.resolve(),
  landedVersion: async () => null,
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));

type RoomIn = {
  area: string; movedAt: number; runNodeId: string | null; runPlan: RunPlan | null; runConfig: RunConfig | null;
  session: { world: { players: Record<string, { save: SaveState }> } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string): void;
  enterNode(nodeId: string): void;
  stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
beforeAll(async () => {
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
const rooms: RoomIn[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.stop(); });

class FakeWs {
  open = true; readonly ip = '127.0.0.1';
  send(): void {} close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
}

describe('⭐⭐ Г2 (Р5): сейв бесконечного спуска встаёт на полку', () => {
  it('спуск на 600 этажей: `visited`/`nodes` и байты сейва не растут с глубиной', () => {
    const room = new RoomCtor('G2SAVE', cfg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} });
    rooms.push(room);
    const charId = 'char-g2save';
    const save = newCharacterSave(cfg, 'warrior', 'Deep', charId);
    save.level = 30;
    db.versions.set(charId, 1); db.data.set(charId, structuredClone(save));
    const pid = room.addPlayer(new FakeWs() as never, `user-${charId}`, save, 1);
    room.descend(pid);   // соло → голосование проходит сразу, забег начат с 1-го этажа
    expect(room.area, 'в подземелье').toBe('dungeon');

    const live = (): SaveState => room.session.world.players[pid]!.save;
    const marks: { depth: number; visited: number; nodes: number; runBytes: number; saveBytes: number }[] = [];
    const mark = (depth: number): void => {
      const s = live();
      marks.push({
        depth,
        visited: s.run?.visited.length ?? 0,
        nodes: s.run?.nodes?.length ?? 0,
        runBytes: JSON.stringify(s.run ?? {}).length,
        saveBytes: JSON.stringify(s).length,
      });
    };
    // Этаж, на котором закрывается окно записей: узел указателя лежит отдельно (`run.node`), поэтому на один глубже
    // потолка. Считается от самого потолка — сузили окно (512 → 32), и замер поехал за ним, а не остался на 513-м.
    const CLOSES = RUN_NODES_MAX + 1;
    const MARKS = new Set([1, 10, CLOSES, RUN_VISITED_MAX, 100, 300, 600]);
    mark(1);
    for (let depth = 2; depth <= 600; depth++) {
      const cur = room.runPlan!.nodes.find((n) => n.id === room.runNodeId)!;
      expect(cur.edges.length, `с этажа ${depth - 1} есть куда идти (спуск не кончается)`).toBeGreaterThan(0);
      room.enterNode(cur.edges[0]!.to);
      expect(room.runNodeId, `вошли на этаж ${depth}`).toBe(cur.edges[0]!.to);
      if (MARKS.has(depth)) mark(depth);
    }

    const w = (n: number, k = 7): string => String(n).padStart(k);
    console.log([
      '⭐⭐ Г2 (Р5): сейв спуска на 600 этажей (настоящая Room, свой enterNode на каждый этаж)',
      ' этаж | visited |   nodes | run, Б | сейв, Б',
      '------+---------+---------+--------+--------',
      ...marks.map((m) => ` ${w(m.depth, 4)} | ${w(m.visited)} | ${w(m.nodes)} | ${w(m.runBytes, 6)} | ${w(m.saveBytes, 7)}`),
      `потолки: visited ${RUN_VISITED_MAX}, nodes ${RUN_NODES_MAX} — дальше вытеснение самых мелких записей`,
      'для сравнения, окно записей 512 (до решения владельца 13.10): на 600-м этаже сейв 35 014 Б, забег 31 630 Б',
    ].join('\n'));

    const at = (d: number) => marks.find((m) => m.depth === d)!;
    // ПОЛКА ДЛИН: окно `visited` закрывается на 64-м этаже, окно записей — на `RUN_NODES_MAX + 1`-м, и дальше ни один
    // список не растёт.
    expect(at(RUN_VISITED_MAX).visited, `visited на ${RUN_VISITED_MAX}-м этаже — ровно окно`).toBe(RUN_VISITED_MAX);
    expect(at(600).visited, 'и на 600-м — то же окно').toBe(RUN_VISITED_MAX);
    expect(at(CLOSES).nodes, 'записи узлов упёрлись в окно').toBe(RUN_NODES_MAX);
    expect(at(600).nodes, 'и держатся на нём').toBe(RUN_NODES_MAX);
    // ПОЛКА БАЙТ: когда окно закрылось, сейв с глубиной не растёт. Мерим между ГЛУБОКИМИ метками (300 → 600), а не от
    // самого закрытия окна: на номерах узлов прибавляются цифры, и в записях разное число убитых — от 33-го к 600-му
    // это даёт +15% содержимого при НЕИЗМЕННОЙ длине списков, и такой допуск спрятал бы настоящий рост.
    expect(at(600).runBytes / at(300).runBytes, 'байты забега 300 → 600').toBeLessThan(1.02);
    expect(at(600).saveBytes / at(300).saveBytes, 'байты сейва 300 → 600').toBeLessThan(1.02);
    expect(at(600).runBytes / at(CLOSES).runBytes, `байты забега ${CLOSES} → 600 (окно уже закрыто)`).toBeLessThan(1.2);
    // ⭐ РЕШЕНИЕ ВЛАДЕЛЬЦА (13.10): окно 32 — припаркованный узел плюс запас на отставшего напарника. Полка сейва
    // обязана остаться В ДЕСЯТКАХ КИЛОБАЙТ ниже прежней (при 512 было 35 014 Б): эти байты уезжают в Postgres при
    // КАЖДОЙ записи сейва, а прочитать их некому — указатель забега назад не ходит (R4-04).
    expect(at(600).saveBytes, 'полка сейва на 600-м этаже').toBeLessThan(10_000);
    // ⭐ И ОКНО — САМОЕ ГЛУБОКОЕ, а не первые записи: мелкие вытеснены, текущий узел на месте (иначе фарм узла).
    const s = live();
    expect(s.run!.visited, 'первый этаж из окна ушёл').not.toContain('n1_0');
    expect(s.run!.visited, 'узел, на котором стоим, — в окне').toContain(room.runNodeId);
    expect(s.run!.node?.id, 'запись текущего узла — та же').toBe(room.runNodeId);
    const depths = s.run!.nodes!.map((n) => Number(/^n(\d+)_/.exec(n.id)![1]));
    expect(Math.min(...depths), 'в окне записей — глубокий хвост, а не начало забега').toBeGreaterThan(1);
  });
});
