/**
 * ⭐⭐ Г3 (14.10): ПУТИ КАРРИ — МЕТКА ДАРОМ НЕ ДОСТАЁТСЯ НИ ОДНИМ ИЗ НИХ.
 *
 * Зажим пати по самому слабому рекорду действует только на НОВЫЙ забег из города, поэтому его обходил
 * ⚠⚠ 15.10 (Г8-2): ВСЕ ГЛУБИНЫ ЗДЕСЬ — МЕТКИ ПОЛОСЫ. Метка стоит на месте круга (цикл 20), кратном шагу 3:
 * 3/6/9/12/15/18, 23/26/29/32/35/38 и далее. Поэтому 60-й этаж меткой БОЛЬШЕ НЕ ЯВЛЯЕТСЯ (его место 20), и
 * пробник ходит на 58-й (место 18); потолок доверия к рекорду (10 000) САМ является меткой — его место в круге
 * 20-е, последнее («на 19-м босс, 20-й портал и 21-й по новой всё»), поэтому зажим даёт ровно 10 000.
 * Правило, которое файл стережёт («рекорд растёт не больше шага за вход»), от выбора глубины не зависит.
 *
 * ПОРЯДОК ДЕЙСТВИЙ: вход по коду в комнату, уже стоящую на 58-м этаже, альт того же аккаунта, вход
 * посреди голосования, смерть на глубине, продолжение ЧУЖОГО припаркованного забега. Замер до правки:
 * рекорд новичка прыгал с 0 до глубины комнаты за ОДИН вход по пяти путям из девяти.
 *
 * Правило (решение владельца): «открывается у всех ПОСТЕПЕННО, и им надо добежать туда НОГАМИ всем» —
 * рекорд растёт не больше чем на шаг метки за вход (`Room.enterNode`). Карри НЕ ЗАПРЕЩЕНО — ни вход
 * по коду, ни продолжение не отказывают; дороже стала только метка.
 *
 * Чем этот файл отличается от `room.g3carry.test.ts`: там два главных пути, здесь — ВСЕ девять плюс два
 * случая, которых нет нигде больше: «шаг берётся ИЗ КОНФИГА, а не литералом 3» и «порченый
 * рекорд в базе не снимает потолок прибавки» (строковая склейка `'60' + 3 = '603'` — лечится общим швом
 * `depthRecordOf` на ЗАПИСИ, потому что сейв из Postgres схему не проходит).
 *
 * Что файл обязан валить: прежнее правило `max(was, node.depth)`; щедрый шаг (`was + 60`); шаг
 * литералом вместо конфига; сырое чтение рекорда без `depthRecordOf`; запись прогресса на повторном входе.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, runNodeDepth, waypointStart, openWaypoints, nextWaypointAfter,
  type SaveState, type ServerFrame, type RunConfig,
} from '@dm/shared';

vi.setConfig({ testTimeout: 300_000 });

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
type RoomIn = {
  code: string; area: string; movedAt: number; difficultyId: string;
  runConfig: RunConfig | null; runNodeId: string | null;
  runPlan: { nodes: { id: string; depth: number; edges: { to: string }[] }[] } | null;
  session: { world: { players: Record<string, P>; monsters: { alive: boolean }[]; spawn: Pt; exits?: Pt[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  reconnect(ws: unknown, userId: string, save: SaveState, version: number): string;
  removePlayer(pid: string): Promise<unknown>;
  returnTown(pid: string): void;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: unknown, startDepth?: number): void;
  castVote(pid: string, yes: boolean): void;
  startDepthOf(tierId: string, want: number | undefined): number;
  vote: unknown;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const USER = 'user-probe';
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
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

let seq = 0;
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
function hero(record: number, c = cfg, user = USER): SaveState {
  const charId = `char-probe-${++seq}`;
  const s = newCharacterSave(c, 'warrior', `PR-${seq}`, charId);
  s.level = 30; s.attributes.vitality = 60;
  if (record > 0) s.difficultyProgress.normal = record;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  void user;
  return s;
}
function room(c = cfg): RoomIn {
  const r = new RoomCtor(`PRB${++seq}`, c, hooks);
  rooms.push(r);
  return r;
}
/** ⭐ Г8-3: места порталов в полосе (список). */
const stepOf = (c = cfg): readonly number[] => c.get('balance').dungeonAccess.portalsAt;
/** ⭐⭐ Г8-2: длина цикла — метка стоит на МЕСТЕ В ПОЛОСЕ, и пробник считает теми же числами, что сервер. */
const cycleOf = (c = cfg): number => c.get('balance').dungeonAccess.contentCycle;
const depthNow = (r: RoomIn): number => runNodeDepth(r.runNodeId ?? undefined);
const rec = (s: SaveState): number => s.difficultyProgress.normal ?? 0;

/** Один этаж ногами: монстры сняты, все у выхода, спуск по первой ветке + «за» остальных. */
function walk(r: RoomIn, by: string, others: string[]): number {
  const w = r.session.world;
  for (const m of w.monsters) m.alive = false;
  const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
  const to = node.edges[0]!.to;
  for (const p of Object.values(w.players)) p.pos = { ...w.exits![0]! };
  r.movedAt = 0;
  r.descend(by, undefined, to);
  for (const pid of others) r.castVote(pid, true);
  expect(r.runNodeId, 'спустились').toBe(to);
  return depthNow(r);
}

describe('ПРОБНИК: все пути карри — на сколько растёт рекорд за вход', () => {
  it('реконнект после карри + альт того же аккаунта + смерть на глубине', async () => {
    const s = stepOf();
    const r = room();
    const vet = hero(58);
    const pa = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);
    expect(depthNow(r)).toBe(58);
    const log: string[] = [`старт ветерана ${depthNow(r)}, шаг ${s}`];

    // вход по коду
    const fresh = hero(0);
    let pb = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    log.push(`вход по коду на ${depthNow(r)}: рекорд ${rec(fresh)}`);
    expect(rec(fresh)).toBe(0);
    walk(r, pa, [pb]);
    log.push(`после 1 этажа (${depthNow(r)}): рекорд ${rec(fresh)}`);
    expect(rec(fresh)).toBe(3);

    // РЕКОННЕКТ: выпал и вернулся на той же глубине
    await r.removePlayer(pb);
    await settle(12);
    const saved = structuredClone(db.data.get(fresh.charId)!);
    log.push(`снят с комнаты: рекорд в базе ${saved.difficultyProgress.normal ?? 0}`);
    pb = r.reconnect(new FakeWs(), USER, saved, db.versions.get(fresh.charId)!);
    await settle(12);
    const backSave = r.session.world.players[pb]!.save;
    log.push(`реконнект на ${depthNow(r)}: рекорд ${rec(backSave)}`);
    expect(rec(backSave), 'реконнект сам прогресса не даёт').toBe(3);
    walk(r, pa, [pb]);
    log.push(`после этажа (${depthNow(r)}): рекорд ${rec(backSave)}`);
    expect(rec(backSave), 'ещё шаг').toBe(6);

    // АЛЬТ того же аккаунта: свежий персонаж того же `userId` садится на глубину
    const alt = hero(0);
    const pc = r.addPlayer(new FakeWs(), USER, alt, 1);
    await settle();
    log.push(`альт того же аккаунта вошёл на ${depthNow(r)}: рекорд ${rec(alt)}`);
    expect(rec(alt)).toBe(0);
    walk(r, pa, [pb, pc]);
    log.push(`альт после этажа (${depthNow(r)}): рекорд ${rec(alt)}`);
    expect(rec(alt), 'альту — тот же шаг').toBe(3);

    // СМЕРТЬ НА ГЛУБИНЕ: мёртвого пати уносит дальше — прогресс тем же шагом
    const pe = r.session.world.players[pc]!;
    pe.alive = false; pe.hp = 0;
    walk(r, pa, [pb, pc]);
    log.push(`мёртвого унесли на ${depthNow(r)}: рекорд альта ${rec(alt)}`);
    expect(rec(alt), 'смерть прибавку не множит').toBe(6);
    console.log(`\nПРОБНИК КАРРИ (реконнект/альт/смерть)\n${log.join('\n')}`);
  });

  it('вход В МОМЕНТ ГОЛОСОВАНИЯ: вошедший получает шаг, а не глубину', async () => {
    const r = room();
    const a = hero(58); const b = hero(58);
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);
    r.castVote(pb, true);
    expect(depthNow(r), 'два ветерана стартуют с 58').toBe(58);

    // Голосование открыто и ждёт второго — в это окно входит новичок.
    const w = r.session.world;
    for (const m of w.monsters) m.alive = false;
    const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
    const to = node.edges[0]!.to;
    for (const p of Object.values(w.players)) p.pos = { ...w.exits![0]! };
    r.movedAt = 0;
    r.descend(pa, undefined, to);
    expect(r.vote, 'голосование идёт').toBeTruthy();
    const fresh = hero(0);
    const pc = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    r.castVote(pb, true); r.castVote(pc, true);
    expect(r.runNodeId, 'спуск прошёл').toBe(to);
    console.log(`\nВХОД В МОМЕНТ ГОЛОСОВАНИЯ: глубина ${depthNow(r)}, рекорд вошедшего ${rec(fresh)}`);
    expect(rec(fresh), 'вошедшему посреди голосования — ОДНА метка, а не 59').toBe(nextWaypointAfter(0, stepOf(), cycleOf()));
  });

  it('⚠ ОКНО ГОЛОСОВАНИЯ: вышел до `descend`, вернулся до исхода — шаг БЕЗ ЕДИНОГО ЭТАЖА', async () => {
    const r = room();
    const a = hero(58); const b = hero(58); const c = hero(0);
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    let pc = r.addPlayer(new FakeWs(), USER, c, 1);
    await settle();
    const log: string[] = [`в городе трое: ветераны ${rec(a)}/${rec(b)}, новичок ${rec(c)}`];
    // при новичке в комнате сервер зажимает старт его рекордом — это и обходят
    log.push(`старт при новичке в комнате: ${r.startDepthOf('normal', 58)}`);
    await r.removePlayer(pc);
    await settle(10);
    log.push(`новичок вышел — старт стал ${r.startDepthOf('normal', 58)}`);
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);   // план посчитан БЕЗ новичка
    expect(r.area, 'голосование ещё идёт — ждёт второго ветерана').toBe('town');
    pc = r.reconnect(new FakeWs(), USER, structuredClone(db.data.get(c.charId)!), db.versions.get(c.charId)!);
    await settle(10);
    r.castVote(pb, true); r.castVote(pc, true);
    await settle(10);
    const got = r.session.world.players[pc]!.save;
    log.push(`исход: область ${r.area}, глубина ${depthNow(r)}, рекорд новичка ${rec(got)} (этажей пройдено 0)`);
    log.push(`старт, пересчитанный на исходе: ${r.startDepthOf('normal', 58)}`);
    console.log(`\nОКНО ГОЛОСОВАНИЯ — ВТОРАЯ ЛИНИЯ (R9-08 «окно ≡ исход»)\n${log.join('\n')}`);
    // ЗАМЕР: голос ОТМЕНЁН — `planKey` на исходе считает `startDepth` заново по текущим `clients`, и вернувшийся
    // новичок сводит его к 1. Даром прогресс не достаётся даже на шаг: пати осталась в городе.
    expect(r.area, 'спуска не было вовсе').toBe('town');
    expect(rec(got), 'и прогресса не было').toBe(0);
  });

  it('выход в город и ПОВТОРНЫЕ продолжения на той же глубине прогресса не дают', async () => {
    const r = room();
    const vet = hero(58);
    const pa = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);
    expect(walk(r, pa, [])).toBe(59);
    const fresh = hero(0);
    const pb = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    const log: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const w = r.session.world;
      for (const p of Object.values(w.players)) p.pos = { ...w.spawn };
      r.movedAt = 0;
      r.returnTown(pa);
      r.castVote(pb, true);
      expect(r.area, 'в городе').toBe('town');
      r.movedAt = 0;
      r.descend(pa, undefined, undefined, undefined, 1);
      r.castVote(pb, true);
      await settle(14);
      log.push(`круг ${i}: область ${r.area}, глубина ${depthNow(r)}, рекорд новичка ${rec(fresh)}`);
      expect(r.area, 'продолжение забега').toBe('dungeon');
      expect(depthNow(r), 'та же глубина указателя хозяина').toBe(59);
      expect(rec(fresh), 'повторный вход прогресса не даёт НИКОГДА').toBe(0);
    }
    console.log(`\nГОРОД↔УЗЕЛ ТУДА-ОБРАТНО\n${log.join('\n')}`);
  });

  it('ОБЫЧНЫЙ СПУСК: соло 1→30 рекорд равен глубине; пати двух ветеранов 58→68 — тоже', async () => {
    const r = room();
    const h = hero(0);
    const pid = r.addPlayer(new FakeWs(), USER, h, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    expect(depthNow(r)).toBe(1);
    expect(rec(h)).toBe(1);
    for (let d = 2; d <= 30; d++) {
      expect(walk(r, pid, [])).toBe(d);
      expect(rec(h), `соло этаж ${d}`).toBe(d);
    }
    console.log(`\nСОЛО 1→30: рекорд на 30-м = ${rec(h)}`);

    const r2 = room();
    const a = hero(58); const b = hero(58);
    const pa = r2.addPlayer(new FakeWs(), USER, a, 1);
    const pb = r2.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    r2.movedAt = 0;
    r2.descend(pa, undefined, undefined, undefined, 58);
    r2.castVote(pb, true);
    expect(depthNow(r2)).toBe(58);
    for (let d = 59; d <= 68; d++) {
      expect(walk(r2, pa, [pb])).toBe(d);
      expect(rec(a), `ветеран A на ${d}`).toBe(d);
      expect(rec(b), `ветеран B на ${d}`).toBe(d);
    }
    console.log(`ПАТИ 58→68: рекорды ${rec(a)} / ${rec(b)}`);
  });

  it('СТАРТ ПОСЛЕ ПРОТЯЖКИ: протащенный на 58-й прошёл 5 этажей — метки и соло-старт', async () => {
    const s = stepOf();
    const r = room();
    const vet = hero(58);
    const pa = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);
    const fresh = hero(0);
    const pb = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    for (let i = 0; i < 5; i++) walk(r, pa, [pb]);
    const open = openWaypoints(fresh.difficultyProgress, 'normal', s, cycleOf());
    const solo = waypointStart([fresh.difficultyProgress], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER);
    console.log(`\nПОСЛЕ ПРОТЯЖКИ (5 этажей с 58-го): рекорд ${rec(fresh)}, метки [${open.join(', ')}], соло-старт ${solo}`);
    // ⭐ Г8-3: за вход открывается не больше ОДНОЙ метки, и места стоят неровно — после пяти входов рекорд
    // прошёл первые пять мест полосы (3, 6, 9, 12, 15), а не «5 × шаг».
    expect(rec(fresh), 'пять входов — пять меток полосы').toBe(15);
    // ⚠ Ф3 (16.10): входа в списке нет — он не метка, а кнопка портала «начать сначала».
    expect(open, 'открыты только заработанные').toEqual([3, 6, 9, 12, 15]);
    expect(solo).toBe(15);
    // и сервер своим швом даёт то же (пати из одного новичка — копия с новым charId, иначе сейв отклонит версия)
    const r2 = room();
    const copy = hero(0);
    copy.difficultyProgress.normal = rec(fresh);
    r2.addPlayer(new FakeWs(), USER, copy, 1);
    await settle();
    expect(r2.startDepthOf('normal', 1e9), 'серверный зажим по его рекорду').toBe(15);
    // и в пати с ветераном зажим по САМОМУ СЛАБОМУ — тот же 15
    console.log(`КООП-ЗАЖИМ: ветеран ${rec(vet)} + новичок ${rec(fresh)} → старт ${r.startDepthOf('normal', 1e9)}`);
    expect(r.startDepthOf('normal', 1e9), 'по слабейшему').toBe(15);
  });

  it('ПОРЧЕНЫЙ РЕКОРД: где окажется игрок', async () => {
    const s = stepOf();
    const cases: [string, unknown][] = [
      ['1e9', 1e9], ['2^53-1', Number.MAX_SAFE_INTEGER], ['дробь 1.5', 1.5], ['минус', -5],
      ['строка "60"', '60'], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
      ['10000', 10_000], ['10001', 10_001],
    ];
    const rows: string[] = [];
    for (const [name, v] of cases) {
      const start = waypointStart([{ normal: v as number }], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER);
      const open = openWaypoints({ normal: v as number }, 'normal', s, cycleOf());
      rows.push(`${name}: старт ${start}, меток ${open.length}, последняя ${open[open.length - 1]}`);
    }
    console.log(`\nПОРЧЕНЫЙ РЕКОРД (чистые швы)\n${rows.join('\n')}`);
    // ⭐ Г8-3: потолок доверия к рекорду — `WAYPOINT_DEPTH_LIMIT` (10 000), и 10 000-й этаж САМ является меткой
    // (его место в полосе — 20, последнее место круга). Прежде ближайшая метка вниз была 9998.
    const cap = waypointStart([{ normal: 1e9 }], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER);
    expect(cap, 'порченый рекорд зажат потолком доверия').toBe(10_000);
    expect(waypointStart([{ normal: Number.MAX_SAFE_INTEGER }], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER)).toBe(cap);
    expect(waypointStart([{ normal: 1.5 }], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(waypointStart([{ normal: -5 }], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(waypointStart([{ normal: '60' as unknown as number }], 'normal', s, cycleOf(), Number.MAX_SAFE_INTEGER)).toBe(1);

    // ЖИВОЙ СЕРВЕР: герой с рекордом 1e9 просит 1e9 — куда его денет комната
    const r = room();
    const bad = hero(0);
    bad.difficultyProgress.normal = 1e9;
    const pid = r.addPlayer(new FakeWs(), USER, bad, 1);
    await settle();
    expect(r.startDepthOf('normal', 1e9), 'зажим рекорда').toBe(10_000);
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1e9);
    console.log(`ЖИВАЯ КОМНАТА, рекорд 1e9: область ${r.area}, узел ${r.runNodeId}, глубина ${depthNow(r)}, рекорд после входа ${rec(bad)}`);
    expect(depthNow(r), 'не 999999999').toBe(10_000);
  });

  it('МЕСТА БЕРУТСЯ ИЗ КОНФИГА: сменил `dungeonAccess.portalsAt` — сменилась прибавка', async () => {
    const c2 = new ConfigRegistry();
    c2.loadAll();
    c2.get('balance').dungeonAccess.portalsAt = [5, 10, 15, 20];
    expect([...stepOf(c2)], 'места порталов сменились').toEqual([5, 10, 15, 20]);
    const r = room(c2);
    const vet = hero(58, c2);
    const pa = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);
    // ⚠ Г8-2: при шаге 5 метки стоят на местах 5/10/15/20 полосы, то есть 58-й (место 18) меткой не является —
    // сервер зажимает старт до 55-го (место 15). Это и проверяет шаг «из конфига»: число берётся из баланса.
    expect(depthNow(r)).toBe(55);
    const fresh = hero(0, c2);
    const pb = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    walk(r, pa, [pb]);
    const first = rec(fresh);
    walk(r, pa, [pb]);
    console.log(`\nШАГ ИЗ КОНФИГА (5): после 1 этажа ${first}, после 2 — ${rec(fresh)}`);
    expect(first, 'прибавка = шаг конфига, а не 3').toBe(5);
    expect(rec(fresh)).toBe(10);
  });
});
