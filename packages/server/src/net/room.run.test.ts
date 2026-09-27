import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, generateItem, itemFromBaseId, materialItem, createRng, uuidv7,
  craftWeapon, defaultParts, keyVariantsByBase, variantsFor, keySlotOf, CRAFT_SLOT_LIST, emptyJournal, fullJournal, emptyStash, enchantCost, sketchable,
  addToInventory, carriedMaterials, shopBuyPrice, Cell, addDebuffStack, acceptQuest,
  type ServerFrame, type RunPlan, type RunNode, type SaveState, type Item, type AccountStash, type CraftInput, type CraftJournal,
  type CraftCost,
} from '@dm/shared';
import { counters } from './metrics.js';
import { limits } from './rateLimit.js';

// Тесты файла ждут комнату оборотами цикла (`settle` — setTimeout(0)), а на Windows каждый такой оборот — шаг системного
// таймера (~15,6 мс): тест идёт 0,3–3 с и без нагрузки. Под нагрузкой полного прогона умолчание 5 с — лотерея; гонки этот
// потолок не прячет — они падают утверждением, а не временем.
vi.setConfig({ testTimeout: 20_000 });

/**
 * E2E (headless) серверного жизненного цикла забега v2 (Ф4.2/4.4). Гоняем реальную `Room`
 * с фейковым ws, читаем ИСХОДЯЩИЕ кадры как чёрный ящик: старт из города → RunPlan → узлы с
 * выходами (контракт exits.length == edges.length) → развилки → финал (портал, 0 выходов) →
 * завершение → город; `save.run` персистится в забеге и очищается на финале. Плюс алтарь:
 * выбор биома/шаблона учитывается, невалидный/выключенный отбрасывается (анти-чит).
 *
 * БД замокана: `db.ts` открывает пул к Postgres при импорте — не тащим базу в юнит-тест (и не
 * трогаем боевую БД дев-сервера). Ф2: доступ асинхронный, поэтому мок отдаёт ПРОМИСЫ — синхронный
 * мок молча ломал бы `await` в комнате.
 *
 * Мок — маленькая ЧЕСТНАЯ база: версии сейва (Ф0.3) и сундука (D8) проверяются так же, как в
 * Postgres, а каждая успешная запись оставляет след (причина для журнала вещей, D9, и снимок сейва).
 * Без этого тесты не видели бы ни отказов по версии, ни того, что именно ушло в базу.
 */
const db = vi.hoisted(() => ({
  /** charId → версия сейва в «базе». Нет записи — 1 (так персонажа отдаёт вход в тестах). */
  saves: new Map<string, number>(),
  /** charId → последний записанный сейв. */
  data: new Map<string, SaveState>(),
  /** userId → строка сундука. */
  stashes: new Map<string, { data: AccountStash; version: number }>(),
  writes: [] as { kind: 'save' | 'stash'; charId: string; reason: string }[],
  /** Изобразить, что сундук обогнал другой герой аккаунта. */
  failStash: false,
  /** Изобразить сбой записи сейва с сундуком: база упала (`throw`) или вернула мусор вместо итога (`null`). */
  stashFault: null as null | 'throw' | 'null',
  /** Задержать чтение сундука, пока тест не отпустит, — чтобы сделать что-то «пока ждём базу». */
  stashGate: null as Promise<void> | null,
  /** Задержать саму ЗАПИСЬ сейва с сундуком — транзакция стоит на ней, тик комнаты идёт дальше (R1-05). */
  stashWriteGate: null as Promise<void> | null,
  /** Задержать запись ОДНОГО сейва (автосейв, разбор на месте), пока тест не отпустит (R2-14). */
  saveGate: null as Promise<void> | null,
  /** uid вещей, которые леджер числит за ЧУЖИМ аккаунтом: запись с ними отклоняется целиком (R2-02). */
  foreign: new Set<string>(),
  /** Запись «сейв + сундук» ПРИМЕНЯЕТСЯ, а ответ на фиксацию теряется — исход неизвестен (R2-09). */
  commitUnknown: false,
  /** С какими причинами по uid ушла каждая успешная запись (R2-21). */
  reasonMaps: [] as { charId: string; reason: string; reasons: Record<string, string> }[],
}));
vi.mock('../db/db.js', async () => {
  const { LedgerViolation, CommitUnknown } = await import('../db/errors.js');
  /** Как `syncItems`: вещь чужого аккаунта отклоняет запись целиком, до изменения чего-либо. */
  const ledgerCheck = (save: SaveState, stash?: AccountStash): void => {
    const uids = [
      ...Object.values(save.equipment).filter(Boolean).map((i) => i!.uid), ...save.inventory.map((i) => i.uid),
      ...save.belt.filter(Boolean).map((i) => i!.uid), ...(stash?.tabs.flat().map((i) => i.uid) ?? []),
    ];
    const bad = uids.filter((u) => db.foreign.has(u));
    if (bad.length) throw new LedgerViolation(`вещь ${bad[0]} числится за аккаунтом чужого`, bad);
  };
  const logReasons = (charId: string, reason: string, reasons?: ReadonlyMap<string, string>): void => {
    db.reasonMaps.push({ charId, reason, reasons: Object.fromEntries(reasons ?? []) });
  };
  /**
   * Как Postgres с `jsonb` (R3-02): U+0000 — 22P05, непарный суррогат — 22P02. `JSON.stringify` пишет оба экраном
   * (парный суррогат — сырым символом), по нему и узнаём. Отказ — до версии: база не разберёт параметр вовсе.
   */
  const pgCheck = (v: unknown): void => {
    const json = JSON.stringify(v);
    if (/\\u0000/.test(json)) throw Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
    if (/\\ud[89a-f][0-9a-f]{2}/i.test(json)) throw Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' });
  };
  return {
    putCharacter: (charId: string, _u: string, data: SaveState, v: number, reason = 'autosave', reasons?: ReadonlyMap<string, string>) => {
      const snap = structuredClone(data);          // снимок в момент вызова — как и настоящая запись
      const apply = (): number | null => {
        pgCheck(snap);
        ledgerCheck(snap);
        if (v !== (db.saves.get(charId) ?? 1)) return null;
        db.saves.set(charId, v + 1);
        db.data.set(charId, snap);
        db.writes.push({ kind: 'save', charId, reason });
        logReasons(charId, reason, reasons);
        return v + 1;
      };
      if (db.saveGate) return db.saveGate.then(apply);
      try { return Promise.resolve(apply()); } catch (e) { return Promise.reject(e); }
    },
    putCharacterWithStash: async (
      charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number, reason = 'stash',
      reasons?: ReadonlyMap<string, string>,
    ) => {
      if (db.stashWriteGate) await db.stashWriteGate;
      if (db.stashFault === 'throw') return Promise.reject(new Error('база недоступна'));
      if (db.stashFault === 'null') return Promise.resolve(null);
      pgCheck(data); pgCheck(stash);
      ledgerCheck(data, stash);
      if (v !== (db.saves.get(charId) ?? 1)) return Promise.resolve({ ok: false, conflict: 'save' });
      if (db.failStash || sv !== (db.stashes.get(userId)?.version ?? 0)) return Promise.resolve({ ok: false, conflict: 'stash' });
      db.saves.set(charId, v + 1);
      db.data.set(charId, structuredClone(data));
      db.stashes.set(userId, { data: structuredClone(stash), version: sv + 1 });
      db.writes.push({ kind: 'stash', charId, reason });
      logReasons(charId, reason, reasons);
      if (db.commitUnknown) throw new CommitUnknown(new Error('Query read timeout'));
      return Promise.resolve({ ok: true, version: v + 1, stashVersion: sv + 1 });
    },
    createCharacter: () => Promise.resolve(1),
    getCharacter: () => Promise.resolve(null),
    getAccountStash: async (userId: string) => {
      if (db.stashGate) await db.stashGate;
      const row = db.stashes.get(userId);
      return row ? { data: structuredClone(row.data), version: row.version } : null;
    },
    putAccountStash: () => Promise.resolve(),
    // R9-01: свод записей забегов в базе (`run_ledger`) — пустой; комнаты пишут в него, вход читает.
    getRunLedger: () => Promise.resolve([]),
    mergeRunLedger: () => Promise.resolve(),
  };
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
type Room = import('./room.js').Room;
let RoomCtor: typeof import('./room.js').Room;
let cfg: ConfigRegistry;

class FakeWs implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  /** С каким кодом сервер закрыл сокет (R1-01: 4009 — сессия устарела). */
  closedWith?: number;
  /** Двоичные кадры мира (Ф1.4) тесту не нужны — он читает управляющие. */
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(code?: number): void { this.open = false; this.closedWith = code; }
  onMessage(): void { /* тест не шлёт кадры вверх — комнату дёргают напрямую */ }
  onClose(): void { /* закрытие в тесте не проверяется */ }
  last<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.t === t) return f as Extract<ServerFrame, { t: T }>;
    }
    return undefined;
  }
}

const rooms: Room[] = [];
let seq = 0;
/**
 * R4-17: лимиты команд — по АККАУНТУ (вход в комнату их не обнуляет). Тесты заводят героев одними и теми же аккаунтами —
 * каждому новому герою чистые лимиты, как было, когда ключом был вход; сброс посреди теста — по аккаунту игрока.
 */
function freshLimits(userId: string): void { limits.forgeCmd.reset(userId); limits.townCmd.reset(userId); limits.cmdResync.reset(userId); }
/** Аккаунт игрока комнаты — ключ лимитов команд (R4-17). */
function userOf(pid: string): string {
  for (const r of rooms) { const c = (r as unknown as { clients: Map<string, { userId: string }> }).clients.get(pid); if (c) return c.userId; }
  return pid;
}
function makeRoom(userId = 'user-1'): { room: Room; ws: FakeWs; pid: string; save: SaveState } {
  freshLimits(userId);
  const room = new RoomCtor('TEST', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
  rooms.push(room);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Hero', `char-${++seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { room, ws, pid, save };
}
/** Дать отработать фоновым записям (вход, вливание кошелька): мок базы отвечает сразу. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
/**
 * R9-01: продолжение из города ждёт свод забега из базы (у мока — готовые промисы): дождаться одних микрозадач, без оборотов
 * таймеров — иначе планировщик успел бы сдвинуть монстров, а тесты сверяют заселение как есть.
 */
const drained = async (): Promise<void> => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
/** Индекс последнего кадра типа `t` — для проверки ПОРЯДКА кадров. */
const lastIdx = (ws: FakeWs, t: ServerFrame['t']): number => ws.frames.map((f) => f.t).lastIndexOf(t);
const countOf = (ws: FakeWs, t: ServerFrame['t']): number => ws.frames.filter((f) => f.t === t).length;
/**
 * Снять паузу между переходами (R1-03): голосование за переход не чаще раза в полторы секунды, а тесты
 * жизненного цикла проходят граф забега за миллисекунды. Паузу проверяет свой тест.
 */
const ready = (room: Room): void => { (room as unknown as { movedAt: number }).movedAt = 0; };
/** Область комнаты — арена рисуется клиентом как этаж, поэтому по кадру её от подземелья не отличить. */
const areaOf = (room: Room): string => (room as unknown as { area: string }).area;
type Pt = { x: number; y: number };
type RunIn = {
  runPlan: RunPlan | null; runNodeId: string | null; depth: number; decor: { kind: string; x: number; y: number }[];
  session: { world: { exits?: Pt[]; spawn: Pt; players: Record<string, { pos: Pt; hp: number; alive: boolean; debuffs: Record<string, unknown> }> } };
};
const runOf = (room: Room): RunIn => room as unknown as RunIn;
/**
 * Встать туда, откуда честный клиент зовёт спуск (R3-01): к выходу ребра на узел `to` (выход i ↔ ребро i), без `to` —
 * к выходу первого ребра, на финале — к порталу. Сервер спуск издалека больше не принимает.
 */
function toExit(room: Room, pid: string, to?: string): void {
  const r = runOf(room);
  const node = nodeOf(r.runPlan!, r.runNodeId!);
  const i = Math.max(0, to ? node.edges.findIndex((e) => e.to === to) : 0);
  const at = node.edges.length === 0 ? r.decor.find((d) => d.kind === 'portal')! : r.session.world.exits![i]!;
  r.session.world.players[pid]!.pos = { x: at.x, y: at.y };
}
/** Настоящая вещь из конвейера генерации, уложенная в сумку. */
function weaponInBag(save: SaveState, x = 0, y = 0): Item {
  const base = cfg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && b.enabled !== false)!;
  const it = generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
    { dropBias: 1, itemLevel: 5, baseId: base.id, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal',
      maxReqTotal: cfg.get('balance').maxTotalRequirement }, createRng(7));
  it.pos = { x, y };
  save.inventory.push(it);
  return it;
}
const nodeOf = (plan: RunPlan, id: string): RunNode => plan.nodes.find((n) => n.id === id)!;

beforeAll(async () => {
  ({ Room: RoomCtor } = await import('./room.js'));
  cfg = new ConfigRegistry();
  cfg.loadAll();
});

afterEach(() => { for (const r of rooms) r.stop(); rooms.length = 0; });

describe('Room — жизненный цикл забега v2 (сервер, headless)', () => {
  it('старт → выходы по рёбрам → финал → город; exits==edges на каждом шаге, save.run пишется и очищается', () => {
    const { room, ws, pid } = makeRoom();

    // Старт забега из города (соло → голосование проходит сразу).
    room.descend(pid);
    expect(ws.last('runPlan'), 'после старта приходит RunPlan').toBeDefined();
    expect(ws.last('areaChanged')?.floor.area).toBe('dungeon');
    expect(ws.last('saveUpdate')?.save.run, 'в забеге save.run записан').toBeTruthy();

    // Контракт на стартовом узле: число выходов этажа == число исходящих рёбер узла.
    {
      const rp = ws.last('runPlan')!;
      const cur = nodeOf(rp.plan, rp.currentNodeId);
      const area = ws.last('areaChanged')!;
      expect(area.floor.runNodeId).toBe(rp.currentNodeId);
      expect(area.floor.exits?.length ?? 0).toBe(cur.edges.length);
    }

    // Прогон всего графа по первому ребру до финала (0 рёбер), проверяя контракт на каждом узле.
    let guard = 0;
    for (; guard < 40; guard++) {
      const rp = ws.last('runPlan')!;
      const cur = nodeOf(rp.plan, rp.currentNodeId);
      if (cur.edges.length === 0) break; // достигли финала
      const target = cur.edges[0]!.to;
      ready(room);
      toExit(room, pid, target);
      room.descend(pid, undefined, target);
      const rp2 = ws.last('runPlan')!;
      expect(rp2.currentNodeId, 'спуск по ребру → вошли в целевой узел').toBe(target);
      const a2 = ws.last('areaChanged')!;
      expect(a2.floor.runNodeId).toBe(target);
      expect(a2.floor.exits?.length ?? 0).toBe(nodeOf(rp2.plan, target).edges.length);
    }
    expect(guard, 'граф сошёлся к финалу за разумное число шагов').toBeLessThan(40);

    // Финал: выходов нет, есть портал-декор в город.
    const finArea = ws.last('areaChanged')!;
    expect(finArea.floor.exits?.length ?? 0).toBe(0);
    expect(finArea.floor.decor.some((d) => d.kind === 'portal'), 'финал даёт портал в город').toBe(true);

    // Завершение забега (финал → город + очистка run) — у портала.
    ready(room);
    toExit(room, pid);
    room.descend(pid);
    expect(ws.last('areaChanged')?.floor.area, 'финиш возвращает в город').toBe('town');
    expect(ws.last('saveUpdate')?.save.run, 'после финиша забег очищен').toBeUndefined();
  });

  /**
   * БАГ ИЗ ИГРЫ: погиб в забеге, вернулся в город — а реконнект предлагал «продолжить»
   * и высаживал на том же этаже, где убили, со всем живым прогрессом.
   *
   * Корень: возврат после вайпа идёт через `enterTown`, а забег чистил только `finishRun`
   * (финал). Значит `save.run` переживал смерть и персистился со старым узлом.
   */
  it('⭐ сундуки этажа ДОЕЗЖАЮТ до игрока: этаж их генерил, а сессия не получала', () => {
    // ⚠ Ровно этот баг: `generateFloor` расставлял сундуки, но `enterFloor` звался без них,
    // и `world.chests` оставался пустым. В симе бота сундуки были (он передавал их явно), то
    // есть отчёты по экономике выглядели верными, а в игре за два этажа не встречалось ни одного.
    // Ловится только со стороны КАДРА: сама генерация работала правильно.
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { room, ws, pid } = makeRoom();
      room.descend(pid);
      counts.push(ws.last('areaChanged')!.floor.chests.length);
    }
    const min = cfg.get('balance').loot.chestsPerFloor.min;
    expect(min, 'тест имеет смысл, только пока сундуки вообще включены').toBeGreaterThan(0);
    expect(counts.every((n) => n >= min), `сундуков по этажам: ${counts.join(', ')}`).toBe(true);
  });

  it('вАЙП ЗАВЕРШАЕТ ЗАБЕГ: после смерти соло `save.run` пуст, продолжать нечего', () => {
    const { room, ws, pid } = makeRoom();
    room.descend(pid);
    const startId = ws.last('runPlan')!.plan.startId;
    // Спускаемся ГЛУБЖЕ старта — иначе «новый забег начался со старта» ничего не доказывает:
    // погибнув на стартовом узле, мы бы и при НЕИСПРАВЛЕННОМ баге вернулись туда же.
    const firstEdge = nodeOf(ws.last('runPlan')!.plan, startId).edges[0]!.to;
    ready(room);
    toExit(room, pid, firstEdge);
    room.descend(pid, undefined, firstEdge);
    const runBefore = ws.last('saveUpdate')?.save.run;
    expect(runBefore, 'в забеге указатель есть').toBeTruthy();
    const diedAt = runBefore!.currentNodeId;
    expect(diedAt, 'гибнем НЕ на стартовом узле').not.toBe(startId);

    // Убиваем игрока через САМУ СИМУЛЯЦИЮ (смертельный DoT), а не вызовом внутреннего
    // метода: баг был именно в СЦЕПЛЕНИИ «событие смерти → вайп → забег», и проверять
    // надо весь этот путь. Сессия приватная — тянемся через каст, это тест.
    const inner = room as unknown as { session: { world: { players: Record<string, { hp: number; debuffs: Record<string, unknown> }> } } };
    const p = inner.session.world.players[pid]!;
    p.hp = 1;
    p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };

    for (let i = 0; i < 20 && !ws.last('died'); i++) room.step(false);
    expect(ws.last('died'), 'игрок действительно погиб').toBeDefined();
    expect(ws.last('died')!.toTown, 'соло = вайп → возврат в город').toBe(true);

    // ГЛАВНОЕ: указатель забега снят СРАЗУ на вайпе, а не когда-нибудь потом —
    // именно этот сейв уйдảт в БД автосейвом и его же прочитает реконнект.
    expect(ws.last('saveUpdate')?.save.run, 'после вайпа забег окончен').toBeUndefined();

    // И следующий спуск начинает НОВЫЙ забег с начала, а не возвращает на этаж гибели.
    room.step(false);                       // доводим таймер окна смерти до города
    (room as unknown as { wipeAt: number }).wipeAt = 1;   // не ждём 4 секунды реального времени
    room.step(false);
    expect(ws.last('areaChanged')?.floor.area, 'вайп уводит в город').toBe('town');
    ready(room);
    room.descend(pid);
    const rp = ws.last('runPlan')!;
    expect(rp.currentNodeId, 'новый забег — со стартового узла').toBe(rp.plan.startId);
    expect(rp.currentNodeId, 'и ТОЧНО не с этажа, где убили').not.toBe(diedAt);
  });

  /**
   * Соседняя болезнь того же бага. Модалка «Продолжить/Завершить» считала забег идущим по
   * САМОМУ ФАКТУ живой грейс-комнаты, а комната живёт и когда игрок просто стоит в городе.
   * Забег идёт ровно пока жив план — это и спрашивает `roomManager` через `inRun`.
   */
  it('inRun честно говорит, идёт ли забег: город → нет, забег → да, после вайпа → нет', () => {
    const { room, ws, pid } = makeRoom();
    expect(room.inRun, 'в городе до старта продолжать нечего').toBe(false);

    room.descend(pid);
    expect(room.inRun, 'в забеге — есть').toBe(true);

    // Выход в город ПОСРЕДИ забега его НЕ завершает: туда ходят за покупками и возвращаются.
    ready(room);
    room.returnTown(pid);
    expect(ws.last('areaChanged')?.floor.area).toBe('town');
    expect(room.inRun, 'выход в город — не конец забега').toBe(true);
    expect(ws.last('saveUpdate')?.save.run, 'указатель цел — есть куда вернуться').toBeTruthy();

    // А вот гибель — конец.
    ready(room);
    room.descend(pid);
    const inner = room as unknown as { session: { world: { players: Record<string, { hp: number; debuffs: Record<string, unknown> }> } } };
    const p = inner.session.world.players[pid]!;
    p.hp = 1;
    p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };
    for (let i = 0; i < 20 && !ws.last('died'); i++) room.step(false);
    expect(ws.last('died'), 'игрок погиб').toBeDefined();
    expect(room.inRun, 'после вайпа продолжать нечего — модалка не должна появляться').toBe(false);
  });

  it('алтарь: выбранные биом/шаблон учитываются; несуществующие/выключенные отбрасываются (фолбэк)', () => {
    const biomes = cfg.get('biomes').filter((b) => b.enabled !== false);
    const tpls = cfg.get('run-templates').filter((t) => t.enabled !== false);
    expect(biomes.length, 'есть включённые биомы').toBeGreaterThan(0);
    expect(tpls.length, 'есть включённые шаблоны').toBeGreaterThan(0);

    // Берём НЕ первый (если возможно) — чтобы доказать, что выбор реально учтён, а не дефолт.
    const pickBiome = biomes[biomes.length - 1]!;
    const pickTpl = tpls[tpls.length - 1]!;
    {
      const { room, ws, pid } = makeRoom();
      room.descend(pid, 'normal', undefined, { biomeId: pickBiome.id, templateId: pickTpl.id, modifiers: [] });
      const rp = ws.last('runPlan')!;
      expect(rp.plan.biomeId).toBe(pickBiome.id);
      expect(rp.plan.templateId).toBe(pickTpl.id);
    }
    // Мусорный выбор → фолбэк на включённый контент (без падения/мусора в плане).
    {
      const { room, ws, pid } = makeRoom();
      room.descend(pid, 'normal', undefined, { biomeId: 'no-such-biome', templateId: 'no-such-tpl', modifiers: ['bogus'] });
      const rp = ws.last('runPlan')!;
      expect(biomes.some((b) => b.id === rp.plan.biomeId)).toBe(true);
      expect(tpls.some((t) => t.id === rp.plan.templateId)).toBe(true);
    }
  });
});

/**
 * Команды города на сервере (К0): ответ на каждую команду (D3), схема до исполнения (D11), лимит
 * частоты кузницы (D12), атомарность сейва и сундука (D7/D8), причины записей (D9). Всё — со
 * стороны исходящих кадров и «базы» мока, как видит клиент и как увидит журнал вещей.
 */
describe('Room — команды города: ответы, схема, лимиты, транзакции', () => {
  it('⭐ D3: cmdResult на успех и на отказ, с номером, ПОСЛЕ saveUpdate; старый кадр error остался', async () => {
    const { room, ws, pid } = makeRoom();
    await settle();
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'bind', slot: 0, value: 'attack' }, 7);
    expect(ws.last('cmdResult')).toEqual({ t: 'cmdResult', id: 7, cmd: 'bind', ok: true });
    expect(lastIdx(ws, 'saveUpdate'), 'сейв пришёл').toBeGreaterThanOrEqual(0);
    expect(lastIdx(ws, 'saveUpdate'), 'и РАНЬШЕ ответа').toBeLessThan(lastIdx(ws, 'cmdResult'));

    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'sell', uid: 'нет-такой-вещи' }, 8);
    const r = ws.last('cmdResult')!;
    expect(r).toMatchObject({ id: 8, cmd: 'sell', ok: false });
    expect(r.reason).toBeTruthy();
    expect(ws.last('error')?.msg, 'прежние клиенты читают отказ из error').toBe(r.reason);
    expect(lastIdx(ws, 'saveUpdate')).toBeLessThan(lastIdx(ws, 'cmdResult'));
  });

  it('⭐ D11: невалидные команды — отказ «Неверная команда», без исключения и без исполнения', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    save.gold = 1_000_000;                         // респек по карману — если бы исполнился, было бы видно
    const before = JSON.stringify(save);
    const n0 = counters.cmdInvalid;
    const cases: [unknown, unknown, number | undefined][] = [
      [{ cmd: 'bind', slot: 0, value: null, hack: 1 }, 1, 1],                  // лишний ключ
      [{ cmd: 'moveItem', uid: 'x', x: '1', y: 0 }, 2, 2],                     // не тот тип
      [{ cmd: 'stashMove', uid: 'x', dst: { tab: 1 }, x: 0, y: 0 }, 3, 3],     // битая вложенность
      [{ cmd: 'respec', extra: { nested: [1, 2] } }, 4, 4],                    // лишнее вложенное
      [null, 5, 5], ['respec', 6, 6], [[], 7, 7], [{}, 8, 8], [undefined, 9, 9],
      [{ cmd: { toString: 'respec' } }, 10, 10], [{ cmd: '__proto__' }, 11, 11], [{ cmd: 'constructor', uid: 'x' }, 12, 12],
      [{ cmd: 'respec' }, -1, undefined],                                      // негодный номер: команда верна,
      [{ cmd: 'respec' }, 1.5, undefined],                                     // но исполнять её нельзя
      [{ cmd: 'respec' }, '13', undefined],
      [{ cmd: 'respec' }, { id: 1 }, undefined],
    ];
    for (const [cmd, id, echo] of cases) {
      ws.frames.length = 0;
      await expect(room.handleCmd(pid, cmd, id), JSON.stringify(cmd) ?? 'undefined').resolves.toBeUndefined();
      const r = ws.last('cmdResult');
      expect(r, `ответ на ${JSON.stringify(cmd)}`).toBeDefined();
      expect(r!.ok).toBe(false);
      expect(r!.reason).toBe('Неверная команда');
      expect(r!.id).toBe(echo);
      expect(ws.last('error')?.msg).toBe('Неверная команда');
    }
    expect(counters.cmdInvalid - n0).toBe(cases.length);
    expect(JSON.stringify(save), 'сейв не тронут ни одной из них').toBe(before);
  });

  it('⭐ D3/Ф2.5: повтор по номеру НЕ исполняется, но получает тот же итог — и успех, и отказ', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    save.unspentAttributePoints = 3;
    const attr = Object.keys(save.attributes)[0]!;
    await room.handleCmd(pid, { cmd: 'allocAttr', attr }, 11);
    const first = ws.last('cmdResult')!;
    expect(first).toMatchObject({ id: 11, ok: true });

    const d0 = counters.cmdDuplicate;
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'allocAttr', attr }, 11);
    expect(save.unspentAttributePoints, 'очко потрачено ОДИН раз').toBe(2);
    expect(counters.cmdDuplicate - d0).toBe(1);
    expect(ws.last('cmdResult')).toEqual(first);
    expect(lastIdx(ws, 'saveUpdate'), 'сейв дошлён до ответа').toBeLessThan(lastIdx(ws, 'cmdResult'));

    await room.handleCmd(pid, { cmd: 'sell', uid: 'нет' }, 12);
    const fail = ws.last('cmdResult')!;
    await room.handleCmd(pid, { cmd: 'sell', uid: 'нет' }, 12);
    expect(ws.last('cmdResult'), 'отказ оригинала повтор тоже видит отказом').toEqual(fail);
    expect(fail.ok).toBe(false);
  });

  it('⚠ R2-15: 300 очков атрибутов — ОДНА команда: один сейв, один ответ; очков меньше — отказ без единого вложенного', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    save.unspentAttributePoints = 300;
    const str0 = save.attributes.strength;
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'allocAttr', attr: 'strength', n: 300 }, 21);
    expect(ws.last('cmdResult')).toMatchObject({ id: 21, ok: true });
    expect(save.unspentAttributePoints).toBe(0);
    expect(save.attributes.strength).toBe(str0 + 300);
    expect(countOf(ws, 'saveUpdate'), 'один сейв на всю пачку').toBe(1);
    expect(countOf(ws, 'cmdResult')).toBe(1);

    save.unspentAttributePoints = 5;
    const before = JSON.stringify(save);
    await room.handleCmd(pid, { cmd: 'allocAttr', attr: 'dexterity', n: 6 }, 22);
    expect(ws.last('cmdResult')).toMatchObject({ id: 22, ok: false });
    expect(JSON.stringify(save), 'всё или ничего').toBe(before);
  });

  it('⭐ D12: шестой разбор подряд — «Слишком часто», вещь цела', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    const it = weaponInBag(save);
    const r0 = counters.cmdRateLimited;
    // Пять попыток съедают всплеск — токен берётся за ПОПЫТКУ, даже с несуществующим uid.
    for (let i = 0; i < 5; i++) {
      await room.handleCmd(pid, { cmd: 'salvage', uid: `нет-${i}` }, 100 + i);
      expect(ws.last('cmdResult')!.reason, `попытка ${i + 1}`).not.toBe('Слишком часто');
    }
    await room.handleCmd(pid, { cmd: 'salvage', uid: it.uid }, 106);
    expect(ws.last('cmdResult')).toMatchObject({ id: 106, ok: false, reason: 'Слишком часто' });
    expect(save.inventory.some((i) => i.uid === it.uid), 'разбор не случился').toBe(true);
    expect(counters.cmdRateLimited - r0).toBe(1);
    // Кузничный разбор делит тот же лимит — обойти его сменой команды нельзя.
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: it.uid }, 107);
    expect(ws.last('cmdResult')!.reason).toBe('Слишком часто');
  });

  it('команда не из того места — cmdResult отказом (Ф3.1)', async () => {
    const { room, ws, pid } = makeRoom();
    room.descend(pid);
    expect(ws.last('areaChanged')?.floor.area).toBe('dungeon');
    await settle();
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'stashOpen' }, 21);
    expect(ws.last('cmdResult')).toMatchObject({ id: 21, cmd: 'stashOpen', ok: false });
    expect(ws.last('cmdResult')!.reason).toMatch(/только в городе/);
    expect(ws.last('stash'), 'сундук из подземелья не открылся').toBeUndefined();
  });

  /**
   * ⭐ R7-11: ПРИВАЛ ЗАБЕГА (rest-узел) НЕ ЗОВЁТ К СУНДУКУ, КОТОРЫЙ СЕРВЕР НЕ ОТКРОЕТ. Город-хаб привала ставил декор
   * `stash`, оба клиента рисовали из него «[E] Общий сундук», окно слало `stashOpen` — и каждый честный клик получал
   * «только в городе» и шёл в `cmdOutOfPlace` (телеметрия чита). Сундук остаётся в городе (правило против мула,
   * `guard.ts`), а дорога к нему с привала — портал.
   */
  it('⭐ R7-11: привал — портал в город, а сундука в кадре области нет', () => {
    const { room, ws, pid } = makeRoom();
    room.descend(pid, 'normal', undefined, { templateId: 'dungeon-standard' });
    for (let g = 0; g < 40; g++) {
      const r = runOf(room);
      const node = nodeOf(r.runPlan!, r.runNodeId!);
      if (node.type === 'rest' || !node.edges.length) break;
      ready(room);
      toExit(room, pid);
      room.descend(pid, undefined, node.edges[0]!.to);
    }
    const r = runOf(room);
    expect(nodeOf(r.runPlan!, r.runNodeId!).type, 'стандартный забег доходит до привала').toBe('rest');
    const floor = ws.last('areaChanged')!.floor;
    expect(floor.area).toBe('dungeon');
    expect(floor.decor.map((d) => d.kind), 'кнопки «Общий сундук» клиенту не из чего строить').not.toContain('stash');
    expect(floor.decor.some((d) => d.kind === 'portal'), 'портал в город — на месте').toBe(true);
  });

  it('⭐ исключение в обработчике — отказ и счётчик, НЕ проброс; сейв откатан к снимку', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    // 1) Сбой вне сейва: прилавок испорчен — покупка бросает.
    (room as unknown as { shop: unknown }).shop = null;
    const f0 = counters.cmdFailed;
    await expect(room.handleCmd(pid, { cmd: 'buy', uid: 'x' }, 31)).resolves.toBeUndefined();
    expect(ws.last('cmdResult')).toMatchObject({ id: 31, ok: false });
    expect(counters.cmdFailed - f0).toBe(1);

    // 2) Сбой ПОСРЕДИ продажи: вещь уже вынута из сумки, а цена бросает. Без отката вещь пропала бы.
    const it = weaponInBag(save);
    let reads = 0;
    Object.defineProperty(it, 'affixes', {
      enumerable: true, configurable: true,
      get() { if (reads++ >= 1) throw new Error('сбой посреди продажи'); return []; },
    });
    const gold0 = save.gold;
    await room.handleCmd(pid, { cmd: 'sell', uid: it.uid }, 32);
    expect(ws.last('cmdResult')).toMatchObject({ id: 32, ok: false });
    expect(save.gold, 'золото не начислено').toBe(gold0);
    expect(save.inventory.filter((i) => i.uid === it.uid), 'вещь вернулась в сумку — ровно одна').toHaveLength(1);
    expect(counters.cmdFailed - f0).toBe(2);
  });

  it('⭐ D7/D8: сундук обогнали — сдача сырья откатывается ЦЕЛИКОМ, сырьё снова в сумке', async () => {
    const { room, ws, pid, save } = makeRoom('user-deposit');
    await settle();
    const def = cfg.get('craft-materials').find((m) => m.enabled)!;
    save.inventory.push({ ...materialItem(def, 5, uuidv7()), pos: { x: 0, y: 0 } });
    const c0 = counters.stashConflicts;

    db.failStash = true;
    try {
      await room.handleCmd(pid, { cmd: 'depositMaterials' }, 51);
    } finally { db.failStash = false; }
    expect(ws.last('cmdResult')).toMatchObject({ id: 51, ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' });
    expect(save.inventory.some((i) => i.kind === 'material'), 'сырьё вернулось в сумку').toBe(true);
    expect(db.stashes.get('user-deposit')?.data.materials?.[def.id] ?? 0, 'в сундук ничего не ушло').toBe(0);
    expect(counters.stashConflicts - c0).toBe(1);

    await room.handleCmd(pid, { cmd: 'depositMaterials' }, 52);
    expect(ws.last('cmdResult')).toMatchObject({ id: 52, ok: true });
    expect(save.inventory.some((i) => i.kind === 'material')).toBe(false);
    expect(db.stashes.get('user-deposit')!.data.materials![def.id]).toBe(5);
    expect(db.writes.at(-1), 'D9: причина записи — stash').toMatchObject({ kind: 'stash', charId: save.charId, reason: 'stash' });
    expect(ws.last('stash')?.materials[def.id], 'клиент получил сундук из той же транзакции').toBe(5);
  });

  it('⭐ D8: два героя одного аккаунта сдают сырьё ОДНОВРЕМЕННО — сундук получает только одну сдачу', async () => {
    const a = makeRoom('user-twin');
    const b = makeRoom('user-twin');
    await settle();
    const def = cfg.get('craft-materials').find((m) => m.enabled)!;
    a.save.inventory.push({ ...materialItem(def, 3, uuidv7()), pos: { x: 0, y: 0 } });
    b.save.inventory.push({ ...materialItem(def, 4, uuidv7()), pos: { x: 0, y: 0 } });
    // Обе команды стартуют до того, как любая запишется: обе читают одну и ту же версию сундука.
    await Promise.all([a.room.handleCmd(a.pid, { cmd: 'depositMaterials' }, 1), b.room.handleCmd(b.pid, { cmd: 'depositMaterials' }, 1)]);
    const ra = a.ws.last('cmdResult')!, rb = b.ws.last('cmdResult')!;
    expect([ra.ok, rb.ok].filter(Boolean), 'прошла ровно одна').toHaveLength(1);
    const count = (s: SaveState): number => s.inventory.filter((i) => i.kind === 'material').reduce((n, i) => n + (i.count ?? 0), 0);
    const inStash = db.stashes.get('user-twin')!.data.materials![def.id]!;
    // Сохранение количества: 3 + 4 = 7 ровно, где бы оно ни лежало. Ни одна единица не задвоилась и не пропала.
    expect(inStash + count(a.save) + count(b.save)).toBe(7);
    expect(inStash === 3 || inStash === 4).toBe(true);
  });

  it('D9: разбор пишется сразу и со своей причиной', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    const it = weaponInBag(save);
    // Кузничный разбор: полный выход, без шанса «ничего не дал бы» у полевого.
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: it.uid }, 61);
    expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ id: 61, ok: true });
    expect(save.inventory.some((i) => i.uid === it.uid)).toBe(false);
    // D6: разбор у кузнеца пишет журнал аккаунта — значит сейв и сундук одной записью.
    expect(db.writes.at(-1)).toEqual({ kind: 'stash', charId: save.charId, reason: 'salvage' });
    expect(db.data.get(save.charId)!.inventory.some((i) => i.uid === it.uid), 'в базе вещи уже нет').toBe(false);
  });

  it('⭐ «Завершить забег» после выхода из подземелья записывает штраф — версия берётся ПОСЛЕ прощальной записи', async () => {
    const { room, pid, save } = makeRoom();
    room.descend(pid);
    await settle();
    expect(save.run, 'в забеге').toBeTruthy();
    const conflicts0 = counters.saveConflicts;
    const left = room.removePlayer(pid);         // выход из подземелья → грейс
    await room.abandonAsDead(save.charId);       // «Завершить»: штраф + снятие забега
    await left;
    expect(counters.saveConflicts - conflicts0, 'база не отказала ни одной записи').toBe(0);
    expect(db.data.get(save.charId)!.run, 'в базе забега больше нет — «продолжить» некуда').toBeUndefined();
  });
});

// ── Ковка на сервере (К3) ─────────────────────────────────────────────────────────────────────────

/** Заявка из реальных деталей конфига: в каждом гнезде первая форма, чьё окно берёт ступень `step`. */
function inputAt(cls: string, hands: number, step: number): CraftInput | null {
  const keySlot = keySlotOf(cfg, cls);
  const group = keyVariantsByBase(cfg, cls, hands).find((g) => g.variants.some((p) => p.stepMin <= step && step <= p.stepMax));
  if (!group) return null;
  const parts = {} as CraftInput['parts'];
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? group.variants : variantsFor(cfg, cls, slot, hands);
    const p = pool.find((v) => v.stepMin <= step && step <= v.stepMax);
    if (!p) return null;
    parts[slot] = { id: p.id, step };
  }
  return { weaponClass: cls, hands, parts };
}

interface CraftSample { input: CraftInput; cost: CraftCost; baseId: string; typeId: string; tier: number }
let sampleCache: CraftSample | undefined;
/** Первая заявка, которую кузнец реально скуёт и у которой есть исторический тип (по нему кодекс пишет «сковал»). */
function sample(): CraftSample {
  if (sampleCache) return sampleCache;
  for (const cls of ['sword', 'axe', 'mace', 'dagger']) for (const step of [2, 1, 3]) {
    const input = inputAt(cls, 1, step);
    if (!input) continue;
    const pv = craftWeapon(cfg, input, { journal: fullJournal(cfg), materialsOn: true });
    if (pv.ok && pv.cost && pv.type?.typeId && pv.type.baseId && pv.tier !== undefined) {
      return (sampleCache = { input, cost: pv.cost, baseId: pv.type.baseId, typeId: pv.type.typeId, tier: pv.tier });
    }
  }
  throw new Error('в конфиге нет ни одной заявки, которую кузнец скуёт');
}
/** Журнал, в котором открыто ровно то, из чего собрана заявка. */
const journalFor = (s: CraftSample): CraftJournal =>
  ({ ...emptyJournal(), bases: [s.baseId], variants: CRAFT_SLOT_LIST.map((slot) => s.input.parts[slot].id), tierHi: s.tier });
/** Сундук аккаунта в «базе»: журнал и кошелёк. Версия не единица — запись пойдёт веткой обновления, как у живого аккаунта. */
function seedStash(userId: string, journal: CraftJournal, materials: Record<string, number>): void {
  db.stashes.set(userId, { data: { ...emptyStash(cfg), forgeJournal: journal, materials: { ...materials }, craftNonces: [] }, version: 3 });
}
/** Сырьё в сумку — стопками на свободные клетки. */
function bagMaterials(save: SaveState, mats: Record<string, number>): void {
  const defs = cfg.get('craft-materials');
  for (const [id, n] of Object.entries(mats)) {
    if (n <= 0) continue;
    if (!addToInventory(save.inventory, materialItem(defs.find((d) => d.id === id)!, n, uuidv7()), cfg.get('balance').inventory)) throw new Error('сумка полна');
  }
}
/** Найденное оружие (без деталей) на свободную клетку сумки. */
function foundWeaponInBag(save: SaveState, seed = 7): Item {
  const base = cfg.get('items.base').find((b) => b.kind === 'weapon' && b.weaponClass === 'sword' && b.enabled !== false)!;
  const it = generateItem(cfg.get('items.base'), cfg.get('affixes'), cfg.get('uniques'),
    { dropBias: 1, itemLevel: 5, baseId: base.id, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal',
      maxReqTotal: cfg.get('balance').maxTotalRequirement, origin: 'drop' }, createRng(seed));
  if (!addToInventory(save.inventory, it, cfg.get('balance').inventory)) throw new Error('сумка полна');
  return it;
}
const crafted = (save: SaveState): Item[] => save.inventory.filter((i) => i.parts);
const craftCmd = (nonce: string, input: unknown): unknown => ({ cmd: 'craft', nonce, input });

/**
 * Герой в городе с ровно тем, что нужно на одну ковку `sample()`: половина сырья в сумке, остальное
 * (+3 сверх) в кошельке сундука, золото — цена + `spareGold`, журнал открыт ровно под заявку.
 */
async function craftSetup(userId: string, spareGold = 0) {
  const s = sample();
  const r = makeRoom(userId);
  await settle();
  const bag: Record<string, number> = {}, wallet: Record<string, number> = {};
  for (const [id, n] of Object.entries(s.cost.materials)) { bag[id] = Math.ceil(n / 2); wallet[id] = n - bag[id]! + 3; }
  bagMaterials(r.save, bag);
  seedStash(userId, journalFor(s), wallet);
  r.save.gold = s.cost.gold + spareGold;
  limits.forgeCmd.reset(userOf(r.pid));
  r.ws.frames.length = 0;
  return { ...r, s, bag, wallet };
}
/** Снимок «базы» аккаунта и персонажа: отказ обязан оставить его байт в байт. */
const dbSnap = (userId: string, charId: string): string =>
  JSON.stringify([db.stashes.get(userId) ?? null, db.data.get(charId) ?? null, db.saves.get(charId) ?? null]);

/**
 * ⭐ КОВКА, ЗАЧАРОВАНИЕ И РАЗБОР НА СЕРВЕРЕ (К3): провод (схема D11, место Ф3.1, лимит D12, флаг D13) и
 * транзакция аккаунта (D7/D8) вокруг ядра. Всё — со стороны кадров клиента и «базы» мока. Главный закон
 * тот же, что в ядре: любой отказ — до траты, и после него ни сейв в памяти, ни база не изменились.
 */
describe('Room — ковка на сервере: ковка, зачарование, разбор', () => {
  let liveBefore = false;
  const nodeEnvBefore = process.env.NODE_ENV;
  beforeEach(() => {
    liveBefore = cfg.get('balance').craft.live;
    cfg.get('balance').craft.live = true;
  });
  afterEach(() => {
    cfg.get('balance').craft.live = liveBefore;
    db.stashFault = null;
    db.failStash = false;
    delete process.env.DM_CRAFT_FULL_JOURNAL;
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnvBefore;
  });

  it('⭐ ковка целиком: сырьё из сумки и кошелька, золото, uid в ответе, вещь в сейве, журнал в кадре сундука', async () => {
    const { room, ws, pid, save, s } = await craftSetup('user-craft-flow', 40);
    const w0 = db.writes.length;
    await room.handleCmd(pid, craftCmd('craft-flow-0001', s.input), 1);
    const r = ws.last('cmdResult')!;
    expect(r, JSON.stringify(r)).toMatchObject({ id: 1, cmd: 'craft', ok: true });
    expect(typeof r.uid).toBe('string');

    const item = ws.last('saveUpdate')!.save.inventory.find((i) => i.uid === r.uid);
    expect(item, 'вещь приехала клиенту в сейве').toBeDefined();
    expect(item!.parts).toEqual(s.input.parts);
    expect(item!.origin, 'D16: рождена ковкой').toBe('craft');
    expect(crafted(save)).toHaveLength(1);
    expect(save.gold, 'золото списано ровно по цене').toBe(40);
    const carried = carriedMaterials(save.inventory);
    for (const id of Object.keys(s.cost.materials)) expect(carried[id] ?? 0, `сумка: ${id}`).toBe(0);

    const row = db.stashes.get('user-craft-flow')!;
    for (const id of Object.keys(s.cost.materials)) expect(row.data.materials![id], `кошелёк: ${id}`).toBe(3);
    expect(row.data.craftNonces, 'ключ записан той же транзакцией').toEqual([{ n: 'craft-flow-0001', uid: r.uid }]);
    expect(row.data.forgeJournal!.typesForged, 'кодекс «сковал»').toEqual([s.typeId]);
    expect(db.writes.slice(w0), 'D9: одна запись, причина craft').toEqual([{ kind: 'stash', charId: save.charId, reason: 'craft' }]);
    expect(db.data.get(save.charId)!.inventory.some((i) => i.uid === r.uid), 'вещь в базе').toBe(true);

    const st = ws.last('stash')!;
    expect(st.forgeJournal.typesForged, 'журнал доехал до клиента').toContain(s.typeId);
    for (const id of Object.keys(s.cost.materials)) expect(st.materials[id]).toBe(3);
    expect('craftNonces' in st, 'ключи заявок клиенту не шлются').toBe(false);
    expect(lastIdx(ws, 'stash')).toBeLessThan(lastIdx(ws, 'saveUpdate'));
    expect(lastIdx(ws, 'saveUpdate'), 'D3: ответ — после сейва').toBeLessThan(lastIdx(ws, 'cmdResult'));
  });

  it('D13: кузнец закрыт — ковка и зачарование отказывают до всего; разбор работает', async () => {
    const { room, ws, pid, save, s } = await craftSetup('user-craft-closed');
    await room.handleCmd(pid, craftCmd('closed-00001', s.input), 1);          // скуём, пока открыто — для зачарования
    const uid = ws.last('cmdResult')!.uid!;
    cfg.get('balance').craft.live = false;
    save.gold = 1_000_000;
    const before = JSON.stringify(save), snap = dbSnap('user-craft-closed', save.charId);
    await room.handleCmd(pid, craftCmd('closed-00002', s.input), 2);
    expect(ws.last('cmdResult')).toMatchObject({ id: 2, cmd: 'craft', ok: false, reason: 'Кузнец ещё не куёт' });
    await room.handleCmd(pid, { cmd: 'forgeEnchant', uid, rarity: 'magic' }, 3);
    expect(ws.last('cmdResult')).toMatchObject({ id: 3, cmd: 'forgeEnchant', ok: false, reason: 'Кузнец ещё не куёт' });
    expect(JSON.stringify(save), 'сейв не тронут').toBe(before);
    expect(dbSnap('user-craft-closed', save.charId), 'в базу не ушло ничего').toBe(snap);

    const found = foundWeaponInBag(save);
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: found.uid }, 4);
    expect(ws.last('cmdResult'), 'разбор от флага не зависит').toMatchObject({ id: 4, ok: true });
  });

  it('Ф3.1: из подземелья не куют и не зачаровывают — отказ до всякой траты', async () => {
    const { room, ws, pid, save, s } = await craftSetup('user-craft-dungeon');
    room.descend(pid);
    expect(ws.last('areaChanged')?.floor.area).toBe('dungeon');
    await settle();
    const found = foundWeaponInBag(save);
    const before = JSON.stringify(save), snap = dbSnap('user-craft-dungeon', save.charId);
    const out0 = counters.cmdOutOfPlace;
    const cmds: unknown[] = [craftCmd('dungeon-0001', s.input), { cmd: 'forgeEnchant', uid: found.uid, rarity: 'rare' }, { cmd: 'forgeSalvage', uid: found.uid }];
    for (const [i, cmd] of cmds.entries()) {
      await room.handleCmd(pid, cmd, 10 + i);
      expect(ws.last('cmdResult'), JSON.stringify(cmd)).toMatchObject({ id: 10 + i, ok: false });
      expect(ws.last('cmdResult')!.reason).toMatch(/только в городе/);
    }
    expect(counters.cmdOutOfPlace - out0).toBe(cmds.length);
    expect(JSON.stringify(save), 'сейв не тронут').toBe(before);
    expect(dbSnap('user-craft-dungeon', save.charId), 'база не тронута').toBe(snap);
  });

  it('⭐ D11: кривые заявки — без исключения, без траты, без записи; смысловые отказы ядра — тоже', async () => {
    const { room, ws, pid, save, s } = await craftSetup('user-craft-junk', 1_000);
    const before = JSON.stringify(save), snap = dbSnap('user-craft-junk', save.charId);
    const w0 = db.writes.length, f0 = counters.cmdFailed, inv0 = counters.cmdInvalid;
    const part = (slot: 'strike' | 'grip' | 'bind' | 'head', patch: Record<string, unknown>): unknown =>
      ({ ...s.input, parts: { ...s.input.parts, [slot]: { ...s.input.parts[slot], ...patch } } });
    // Нарушения СХЕМЫ: до ядра не доходят, ответ — «Неверная команда».
    const schema: unknown[] = [
      { ...(craftCmd('junk-000001', s.input) as object), extra: 1 },
      craftCmd('junk-000002', { ...s.input, tier: 6 }),
      craftCmd('junk-000003', { ...s.input, parts: { ...s.input.parts, pommel: s.input.parts.head } }),
      craftCmd('junk-000004', { ...s.input, parts: { strike: s.input.parts.strike, grip: s.input.parts.grip, bind: s.input.parts.bind } }),
      craftCmd('junk-000005', part('strike', { step: 0 })),
      craftCmd('junk-000006', part('strike', { step: 6 })),
      craftCmd('junk-000007', part('grip', { step: 2.5 })),
      craftCmd('junk-000008', part('grip', { step: '2' })),
      craftCmd('junk-000009', part('bind', { material: 'iron-5' })),
      craftCmd('junk-000010', part('head', { id: '' })),
      craftCmd('junk-000011', part('head', { id: 'x'.repeat(65) })),
      craftCmd('junk-000012', { ...s.input, hands: 3 }),
      craftCmd('junk-000013', { ...s.input, finish: -1 }),
      craftCmd('junk-000014', { ...s.input, finish: 99 }),
      craftCmd('junk-000015', { ...s.input, finish: 1.5 }),
      craftCmd('junk-000016', { ...s.input, weaponClass: '' }),
      craftCmd('junk-000017', null),
      craftCmd('junk-000018', [s.input]),
      craftCmd('short', s.input),
      craftCmd('x'.repeat(65), s.input),
      craftCmd('nonce with spaces', s.input),
      { cmd: 'craft', input: s.input },
      JSON.parse(JSON.stringify(craftCmd('junk-000019', s.input)).replace('"weaponClass":', '"__proto__":{"live":true},"weaponClass":')) as unknown,
      { cmd: 'forgeEnchant', uid: 'x', rarity: 'unique' },
      { cmd: 'forgeEnchant', uid: 'x', rarity: 'normal' },
      { cmd: 'forgeEnchant', uid: 'x', rarity: 'magic', cost: 0 },
      { cmd: 'forgeEnchant', uid: 'x' },
    ];
    for (const [i, cmd] of schema.entries()) {
      await expect(room.handleCmd(pid, cmd, 100 + i)).resolves.toBeUndefined();
      expect(ws.last('cmdResult'), JSON.stringify(cmd)).toMatchObject({ id: 100 + i, ok: false, reason: 'Неверная команда' });
    }
    expect(counters.cmdInvalid - inv0, 'каждая посчитана').toBe(schema.length);

    // Схему прошли, но кузнец такое не скуёт: ядро отказывает внутри транзакции, до траты.
    const other = cfg.get('weapon-parts').find((p) => !Object.values(s.input.parts).some((q) => q.id === p.id))!;
    const semantic: [string, unknown][] = [
      ['нет такой детали', craftCmd('sem-000001', part('strike', { id: 'нет-такой-детали' }))],
      ['чужая деталь в гнезде', craftCmd('sem-000002', part('grip', { id: s.input.parts.strike.id }))],
      ['деталь не открыта журналом', craftCmd('sem-000003', part('bind', { id: other.id }))],
      ['доводка вне конфига', craftCmd('sem-000004', { ...s.input, finish: 31 })],
      ['класс не тот', craftCmd('sem-000005', { ...s.input, weaponClass: 'no-such-class' })],
      ['хват не тот', craftCmd('sem-000006', { ...s.input, hands: s.input.hands === 1 ? 2 : 1 })],
      ['зачаровать несуществующее', { cmd: 'forgeEnchant', uid: 'нет-такой-вещи', rarity: 'magic' }],
    ];
    for (const [i, [why, cmd]] of semantic.entries()) {
      limits.forgeCmd.reset(userOf(pid));                  // лимит проверяется отдельно — здесь он не мешает
      await expect(room.handleCmd(pid, cmd, 200 + i)).resolves.toBeUndefined();
      const r = ws.last('cmdResult')!;
      expect(r, why).toMatchObject({ id: 200 + i, ok: false });
      expect(r.reason, why).toBeTruthy();
    }
    expect(counters.cmdFailed - f0, 'ни одного исключения').toBe(0);
    expect(JSON.stringify(save), 'сейв байт в байт').toBe(before);
    expect(dbSnap('user-craft-junk', save.charId), 'база байт в байт').toBe(snap);
    expect(db.writes.length - w0, 'ни одной записи').toBe(0);
    expect(({} as Record<string, unknown>).live, 'прототип не тронут').toBeUndefined();
  });

  it('⭐ запись не прошла (база упала или вернула мусор) — откат сейва, кошелька, журнала и ключа; повтор кует ОДИН раз', async () => {
    const user = 'user-craft-fault';
    const { room, ws, pid, save, s } = await craftSetup(user);
    const before = JSON.stringify(save), snap = dbSnap(user, save.charId);
    const e0 = counters.saveErrors, f0 = counters.cmdFailed;
    let id = 1;
    for (const fault of ['throw', 'null'] as const) {
      db.stashFault = fault;
      await room.handleCmd(pid, craftCmd('fault-nonce-01', s.input), id++);
      db.stashFault = null;
      expect(ws.last('cmdResult'), fault).toMatchObject({ ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' });
      expect(JSON.stringify(save), `${fault}: сейв откатан целиком — золото, сырьё в сумке, без вещи`).toBe(before);
      expect(dbSnap(user, save.charId), `${fault}: в базе ни кошелька, ни журнала, ни ключа`).toBe(snap);
      expect(ws.last('saveUpdate')!.save.inventory.some((i) => i.parts), `${fault}: клиенту вещь не показана`).toBe(false);
      limits.forgeCmd.reset(userOf(pid));
    }
    expect(counters.saveErrors - e0).toBe(2);
    expect(counters.cmdFailed - f0, 'сбой базы — не исключение обработчика').toBe(0);

    // Клиент повторяет ТУ ЖЕ заявку — она кует ровно одну вещь и списывает ровно один раз.
    await room.handleCmd(pid, craftCmd('fault-nonce-01', s.input), id++);
    const r = ws.last('cmdResult')!;
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(crafted(save)).toHaveLength(1);
    expect(save.gold).toBe(0);
    expect(db.stashes.get(user)!.data.craftNonces).toEqual([{ n: 'fault-nonce-01', uid: r.uid }]);
  });

  it('⭐ D8: два героя аккаунта куют из ОДНОГО кошелька одновременно — вещь одна, сырьё списано один раз', async () => {
    const user = 'user-craft-twin';
    const s = sample();
    const a = makeRoom(user), b = makeRoom(user);
    await settle();
    seedStash(user, journalFor(s), s.cost.materials);            // ровно на одну ковку
    a.save.gold = s.cost.gold; b.save.gold = s.cost.gold;
    limits.forgeCmd.reset(userOf(a.pid)); limits.forgeCmd.reset(userOf(b.pid));
    await Promise.all([a.room.handleCmd(a.pid, craftCmd('twin-a-00001', s.input), 1), b.room.handleCmd(b.pid, craftCmd('twin-b-00001', s.input), 1)]);
    const ra = a.ws.last('cmdResult')!, rb = b.ws.last('cmdResult')!;
    expect([ra.ok, rb.ok].filter(Boolean), 'прошла ровно одна').toHaveLength(1);
    const loser = ra.ok ? b : a, lost = ra.ok ? rb : ra;
    expect(lost.reason).toBe('Не удалось сохранить, попробуйте ещё раз');
    expect(crafted(a.save).length + crafted(b.save).length, 'вещь одна на двоих').toBe(1);
    expect(a.save.gold + b.save.gold, 'золото списано один раз').toBe(s.cost.gold);
    const w = db.stashes.get(user)!.data.materials!;
    for (const id of Object.keys(s.cost.materials)) expect(w[id] ?? 0, id).toBe(0);
    expect(counters.stashConflicts).toBeGreaterThan(0);

    // Проигравший повторяет — сырья больше нет, и сервер это видит (сундук перечитан заново).
    limits.forgeCmd.reset(userOf(loser.pid));
    await loser.room.handleCmd(loser.pid, craftCmd(ra.ok ? 'twin-b-00001' : 'twin-a-00001', s.input), 2);
    expect(loser.ws.last('cmdResult')).toMatchObject({ ok: false });
    expect(loser.ws.last('cmdResult')!.reason).toMatch(/Не хватает/);
    expect(crafted(a.save).length + crafted(b.save).length).toBe(1);
  });

  it('D8: сундук обогнали — ковка откатывается, а повтор проходит', async () => {
    const user = 'user-craft-race';
    const { room, ws, pid, save, s } = await craftSetup(user);
    const before = JSON.stringify(save), snap = dbSnap(user, save.charId);
    db.failStash = true;
    await room.handleCmd(pid, craftCmd('race-nonce-01', s.input), 1);
    db.failStash = false;
    expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' });
    expect(JSON.stringify(save)).toBe(before);
    expect(dbSnap(user, save.charId)).toBe(snap);
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, craftCmd('race-nonce-01', s.input), 2);
    expect(ws.last('cmdResult')).toMatchObject({ id: 2, ok: true });
    expect(crafted(save)).toHaveLength(1);
  });

  it('⭐ D4: повтор ключа после РЕКОННЕКТА (новая сессия, новое окно номеров) — та же вещь, без второй траты и без записи', async () => {
    const user = 'user-craft-reconnect';
    const { room, ws, pid, save, s } = await craftSetup(user, 25);
    await room.handleCmd(pid, craftCmd('recon-nonce-01', s.input), 1);
    const first = ws.last('cmdResult')!;
    expect(first.ok).toBe(true);
    await room.removePlayer(pid);                                   // обрыв в городе: комната закрыта

    // Новая сессия читает сейв из «базы» — как настоящий вход после обрыва.
    const saved = structuredClone(db.data.get(save.charId)!);
    const room2 = new RoomCtor('TEST2', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room2);
    const ws2 = new FakeWs();
    const pid2 = room2.addPlayer(ws2 as unknown as GameConn, user, saved, db.saves.get(save.charId)!);
    await settle();
    limits.forgeCmd.reset(userOf(pid2));
    expect(crafted(saved), 'вещь пережила обрыв').toHaveLength(1);
    const snap = dbSnap(user, save.charId);
    const w0 = db.writes.length;
    ws2.frames.length = 0;
    // Тот же номер 1: окно дедупа у нового соединения чистое — спасает только ключ заявки на аккаунте.
    await room2.handleCmd(pid2, craftCmd('recon-nonce-01', s.input), 1);
    expect(ws2.last('cmdResult')).toEqual({ t: 'cmdResult', id: 1, cmd: 'craft', ok: true, uid: first.uid });
    // И даже с ДРУГОЙ заявкой под тем же ключом — прежняя вещь, а не новая.
    const alt = inputAt(s.input.weaponClass, s.input.hands, s.input.parts.strike.step === 1 ? 2 : 1) ?? s.input;
    await room2.handleCmd(pid2, craftCmd('recon-nonce-01', alt), 2);
    expect(ws2.last('cmdResult')).toMatchObject({ id: 2, ok: true, uid: first.uid });
    expect(crafted(saved), 'вещь одна').toHaveLength(1);
    expect(saved.gold, 'второй раз не списано').toBe(25);
    expect(db.writes.length - w0, 'повтор в базу не пишет').toBe(0);
    expect(dbSnap(user, save.charId)).toBe(snap);
    expect(ws2.last('stash')?.forgeJournal.typesForged, 'свежий сундук после реконнекта').toContain(s.typeId);
  });

  it('игрок ушёл, пока ковка ждала базу, — ковки нет: ни вещи в прощальной записи, ни ключа в сундуке', async () => {
    const user = 'user-craft-leave';
    const { room, pid, save, s } = await craftSetup(user);
    let release!: () => void;
    db.stashGate = new Promise<void>((r) => { release = r; });
    const cmd = room.handleCmd(pid, craftCmd('leave-nonce-01', s.input), 1);
    await settle();                                  // команда в очереди и ждёт сундук
    const left = room.removePlayer(pid);             // обрыв: прощальная запись встаёт в очередь ЗА ковкой
    db.stashGate = null;
    release();
    await cmd;
    await left;
    const inDb = db.data.get(save.charId)!;
    expect(crafted(inDb), 'в базе вещи нет').toHaveLength(0);
    expect(inDb.gold, 'и золото не списано').toBe(s.cost.gold);
    expect(db.stashes.get(user)!.data.craftNonces, 'ключ не записан — повтор после входа скуёт честно').toEqual([]);
  });

  it('D1/DM_CRAFT_FULL_JOURNAL: флаг разработчика открывает ворота журнала, но в базу журнал уходит своим', async () => {
    const user = 'user-craft-fulljournal';
    const { room, ws, pid, save, s } = await craftSetup(user);
    db.stashes.get(user)!.data.forgeJournal = emptyJournal();       // не открыто ничего
    await room.handleCmd(pid, craftCmd('fulljr-00001', s.input), 1);
    expect(ws.last('cmdResult'), 'без флага — журнал закрыт').toMatchObject({ id: 1, ok: false });
    expect(crafted(save)).toHaveLength(0);

    process.env.DM_CRAFT_FULL_JOURNAL = '1';
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, craftCmd('fulljr-00002', s.input), 2);
    expect(ws.last('cmdResult')).toMatchObject({ id: 2, ok: true });
    const j = db.stashes.get(user)!.data.forgeJournal!;
    expect({ ...j, typesForged: [] }, 'полный журнал не записан — только кодекс').toEqual(emptyJournal());
    expect(j.typesForged).toEqual([s.typeId]);
    const shown = ws.last('stash')!.forgeJournal;
    expect(shown.bases, 'окну показаны открытые ворота — то, чем гейтит сервер').toEqual(fullJournal(cfg).bases);
    expect(shown.typesForged, 'а кодекс свой').toEqual([s.typeId]);
  });

  it('⭐ D1/DM_CRAFT_FULL_JOURNAL в продакшене ИГНОРИРУЕТСЯ: ворота закрыты, окну — свой журнал', async () => {
    const user = 'user-craft-fulljournal-prod';
    const { room, ws, pid, save, s } = await craftSetup(user);
    db.stashes.get(user)!.data.forgeJournal = emptyJournal();       // не открыто ничего
    process.env.DM_CRAFT_FULL_JOURNAL = '1';
    process.env.NODE_ENV = 'production';
    const before = JSON.stringify(save), snap = dbSnap(user, save.charId);
    await room.handleCmd(pid, craftCmd('fulljr-prod-01', s.input), 1);
    expect(ws.last('cmdResult'), 'забытый на боевом сервере флаг ворот не открывает').toMatchObject({ id: 1, ok: false });
    expect(crafted(save)).toHaveLength(0);
    expect(JSON.stringify(save), 'сейв цел').toBe(before);
    expect(dbSnap(user, save.charId), 'база цела').toBe(snap);
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'stashOpen' }, 2);
    expect(ws.last('stash')!.forgeJournal.bases, 'окну — журнал аккаунта, а не открытые ворота').toEqual([]);

    // Тот же процесс вне продакшена — флаг снова работает: решение читается на каждый вызов.
    process.env.NODE_ENV = 'test';
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, craftCmd('fulljr-prod-02', s.input), 3);
    expect(ws.last('cmdResult')).toMatchObject({ id: 3, ok: true });
  });

  it('⭐ D5: зачарование скованной вещи — только золото, uid в ответе, причина enchant; отказы до оплаты', async () => {
    const user = 'user-enchant';
    const { room, ws, pid, save, s } = await craftSetup(user);
    await room.handleCmd(pid, craftCmd('ench-nonce-01', s.input), 1);
    const uid = ws.last('cmdResult')!.uid!;
    const item = save.inventory.find((i) => i.uid === uid)!;
    const cost = enchantCost(cfg, item, 'magic');
    expect(cost).toBeGreaterThan(0);
    const found = foundWeaponInBag(save);
    const refused = async (cmd: unknown, id: number, re: RegExp): Promise<void> => {
      limits.forgeCmd.reset(userOf(pid));
      const before = JSON.stringify(save), snap = dbSnap(user, save.charId);
      await room.handleCmd(pid, cmd, id);
      const r = ws.last('cmdResult')!;
      expect(r, JSON.stringify(cmd)).toMatchObject({ id, ok: false });
      expect(r.reason).toMatch(re);
      expect(JSON.stringify(save), `${JSON.stringify(cmd)}: сейв цел`).toBe(before);
      expect(dbSnap(user, save.charId), `${JSON.stringify(cmd)}: база цела`).toBe(snap);
    };
    save.gold = cost - 1;
    await refused({ cmd: 'forgeEnchant', uid, rarity: 'magic' }, 2, /золота/);
    save.gold = cost + 7;
    await refused({ cmd: 'forgeEnchant', uid: found.uid, rarity: 'magic' }, 3, /скованную/);
    await refused({ cmd: 'forgeEnchant', uid: 'нет-такой-вещи', rarity: 'rare' }, 4, /не в инвентаре/);

    limits.forgeCmd.reset(userOf(pid));
    const w0 = db.writes.length;
    await room.handleCmd(pid, { cmd: 'forgeEnchant', uid, rarity: 'magic' }, 5);
    expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ id: 5, cmd: 'forgeEnchant', ok: true, uid });
    const after = save.inventory.find((i) => i.uid === uid)!;
    expect(after.rarity).toBe('magic');
    expect(after.affixes.length).toBeGreaterThan(0);
    expect(after.parts, 'детали на месте').toEqual(s.input.parts);
    expect(save.gold, 'списано ровно по цене').toBe(7);
    expect(db.writes.slice(w0)).toEqual([{ kind: 'stash', charId: save.charId, reason: 'enchant' }]);
    expect(db.data.get(save.charId)!.inventory.find((i) => i.uid === uid)!.rarity, 'в базе — зачарованная').toBe('magic');

    save.gold = 1_000_000;
    await refused({ cmd: 'forgeEnchant', uid, rarity: 'rare' }, 6, /уже зачарована/);
  });

  it('⭐ D6: разбор найденного у кузнеца открывает журнал (unlocked в ответе, журнал в кадре); скованное — переплавка', async () => {
    const user = 'user-salvage-journal';
    const { room, ws, pid, save } = makeRoom(user);
    await settle();
    expect(ws.last('stash')?.forgeJournal, 'журнал приходит уже на входе — пустой у нового аккаунта').toEqual(emptyJournal());
    const found = foundWeaponInBag(save);
    const base = cfg.get('items.base').find((b) => b.id === found.baseId)!;
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: found.uid }, 1);
    const r = ws.last('cmdResult')!;
    expect(r, JSON.stringify(r)).toMatchObject({ id: 1, cmd: 'forgeSalvage', ok: true });
    expect(r.unlocked, 'что открылось — строками').toContain(`Тип «${base.name}»`);
    expect(db.stashes.get(user)!.data.forgeJournal!.bases).toContain(found.baseId);
    expect(db.writes.at(-1)).toEqual({ kind: 'stash', charId: save.charId, reason: 'salvage' });
    expect(ws.last('stash')!.forgeJournal.bases, 'журнал доехал до окна').toContain(found.baseId);
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'stashOpen' }, 2);
    expect(ws.last('stash')!.forgeJournal.bases, 'и на открытии сундука').toContain(found.baseId);
  });

  it('D9: скованное переплавляется с причиной melt — у кузнеца и на месте; журнал переплавка не трогает', async () => {
    const user = 'user-melt';
    const { room, ws, pid, save, s } = await craftSetup(user);
    await room.handleCmd(pid, craftCmd('melt-nonce-01', s.input), 1);
    const uid = ws.last('cmdResult')!.uid!;
    const journal = structuredClone(db.stashes.get(user)!.data.forgeJournal);
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid }, 2);
    const r = ws.last('cmdResult')!;
    expect(r, JSON.stringify(r)).toMatchObject({ id: 2, ok: true });
    expect(r.unlocked, 'переплавка ничего не открывает').toBeUndefined();
    expect(db.writes.at(-1)).toEqual({ kind: 'stash', charId: save.charId, reason: 'melt' });
    expect(db.stashes.get(user)!.data.forgeJournal).toEqual(journal);
    expect(save.inventory.some((i) => i.uid === uid)).toBe(false);

    // Разбор на месте: ещё одна вещь — та же причина, но пишется одним сейвом (сундука в поле нет).
    save.gold = 1_000_000;
    bagMaterials(save, s.cost.materials);
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, craftCmd('melt-nonce-02', s.input), 3);
    const uid2 = ws.last('cmdResult')!.uid!;
    expect(uid2).toBeTruthy();
    // Полевая доля катается (0.3 с вероятностным остатком); с R9-03 пустой бросок тоже разбирает вещь (в ничто), так что
    // повтор — только страховка. Нам важна причина записи удачного разбора.
    let r2 = ws.last('cmdResult')!;
    for (let i = 0; i < 30; i++) {
      limits.forgeCmd.reset(userOf(pid));
      await room.handleCmd(pid, { cmd: 'salvage', uid: uid2 }, 4 + i);
      r2 = ws.last('cmdResult')!;
      if (r2.ok) break;
      expect(save.inventory.some((it) => it.uid === uid2), 'отказ оставил вещь целой').toBe(true);
    }
    expect(r2, JSON.stringify(r2)).toMatchObject({ ok: true });
    expect(db.writes.at(-1)).toEqual({ kind: 'save', charId: save.charId, reason: 'melt' });
    expect(save.inventory.some((it) => it.uid === uid2)).toBe(false);
  });

  it('⭐ D12: шестая ковка подряд — «Слишком часто», ничего не списано; зачарование делит тот же лимит', async () => {
    const { room, ws, pid, save, s } = await craftSetup('user-craft-rate');
    for (let i = 0; i < 5; i++) {
      await room.handleCmd(pid, craftCmd(`rate-nonce-0${i}`, { ...s.input, weaponClass: 'no-such-class' }), 1 + i);
      expect(ws.last('cmdResult')!.reason, `попытка ${i + 1}`).not.toBe('Слишком часто');
    }
    const before = JSON.stringify(save);
    await room.handleCmd(pid, craftCmd('rate-nonce-ok', s.input), 10);
    expect(ws.last('cmdResult')).toMatchObject({ id: 10, ok: false, reason: 'Слишком часто' });
    expect(JSON.stringify(save), 'ковка не случилась').toBe(before);
    await room.handleCmd(pid, { cmd: 'forgeEnchant', uid: 'x', rarity: 'magic' }, 11);
    expect(ws.last('cmdResult')!.reason).toBe('Слишком часто');
  });

  it('⭐ K7: телеметрия кузницы — скованное, зачарованное, переплавленное, разобранное; отказы и повтор ключа не считаются', async () => {
    const user = 'user-forge-telemetry';
    const { room, ws, pid, save, s } = await craftSetup(user);
    const tm = (room as unknown as { clients: Map<string, { tm: import('./telemetry.js').SessionTelemetry }> }).clients.get(pid)!.tm;
    const g0 = { ...counters };
    const delta = (k: 'forgeCrafted' | 'forgeMelted' | 'forgeSalvaged' | 'forgeEnchanted'): number => counters[k] - g0[k];

    // Отказ до всего (кривая заявка) и отказ ядра (не хватает) — не считаются.
    await room.handleCmd(pid, craftCmd('tm-nonce-bad', { ...s.input, extra: 1 }), 1);
    await room.handleCmd(pid, craftCmd('tm-nonce-0001', { ...s.input, weaponClass: 'no-such-class' }), 2);
    expect(tm.crafted).toBe(0);

    await room.handleCmd(pid, craftCmd('tm-nonce-0002', s.input), 3);
    const uid = ws.last('cmdResult')!.uid!;
    expect(ws.last('cmdResult')!.ok).toBe(true);
    expect(tm.crafted, 'сессия').toBe(1);
    expect(delta('forgeCrafted'), '/metrics').toBe(1);

    // Повтор ключа (без записи) — вещь та же, счётчик не растёт.
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, craftCmd('tm-nonce-0002', s.input), 4);
    expect(ws.last('cmdResult')).toMatchObject({ ok: true, uid });
    expect(tm.crafted, 'повтор ключа — не вторая ковка').toBe(1);

    save.gold = 1_000_000;
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, { cmd: 'forgeEnchant', uid, rarity: 'magic' }, 5);
    expect(ws.last('cmdResult')!.ok).toBe(true);
    expect(tm.enchanted).toBe(1);
    expect(delta('forgeEnchanted')).toBe(1);

    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid }, 6);
    expect(ws.last('cmdResult')!.ok).toBe(true);
    expect(tm.melted, 'скованное — переплавка').toBe(1);
    expect(delta('forgeMelted')).toBe(1);

    const found = foundWeaponInBag(save, 11);
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: found.uid }, 7);
    expect(ws.last('cmdResult')!.ok).toBe(true);
    expect(tm.salvaged, 'найденное — разбор').toBe(1);
    expect(delta('forgeSalvaged')).toBe(1);

    // Запись не прошла — действие откатано, и в телеметрии его нет.
    bagMaterials(save, s.cost.materials);
    db.stashFault = 'throw';
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, craftCmd('tm-nonce-0003', s.input), 8);
    expect(ws.last('cmdResult')!.ok).toBe(false);
    expect(tm.crafted, 'откат — не ковка').toBe(1);
    expect(delta('forgeCrafted')).toBe(1);

    const ph = tm.perHour();
    expect(ph.craftedPerHour).toBeGreaterThan(0);
    expect(ph.meltedPerHour).toBeGreaterThan(0);
    expect(ph.salvagedPerHour).toBeGreaterThan(0);
    expect(ph.enchantedPerHour).toBeGreaterThan(0);
  });

  it('D21: прилавок — только включённые базы, происхождение shop, ступень базы катается как у дропа', () => {
    const { room, save } = makeRoom();
    save.level = 40;
    // Снаряжение стока (`rollGear`) и зелья лавки (`freshConsumables`) катаются порознь (R2-04) — проверяем оба.
    const inner = room as unknown as { rollGear(): Item[]; freshConsumables(): Item[] };
    const bases = cfg.get('items.base');
    let rolled = 0, gear = 0;
    // 40 прилавков: выключенная база (сейчас одна из 30 ближних) без фильтра попала бы на прилавок почти наверняка.
    expect(bases.some((b) => b.enabled === false), 'тест имеет смысл, пока есть выключенная база').toBe(true);
    for (let k = 0; k < 40; k++) {
      for (const it of [...inner.freshConsumables(), ...inner.rollGear()]) {
        expect(it.origin, it.name).toBe('shop');
        const base = bases.find((b) => b.id === it.baseId)!;
        expect(base.enabled !== false, `выключенная база на прилавке: ${base.id}`).toBe(true);
        if (it.kind === 'consumable' || it.rarity === 'unique') continue;
        gear++;
        // Без броска ступени та же база на том же уровне получает одну и ту же ступень всегда.
        const fixed = generateItem(bases, cfg.get('affixes'), cfg.get('uniques'),
          { dropBias: 1, itemLevel: 41, baseId: it.baseId, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal' }, createRng(1));
        if (fixed.tier !== it.tier) rolled++;
      }
    }
    expect(gear).toBeGreaterThan(0);
    expect(rolled, 'ступени разные — бросок работает').toBeGreaterThan(0);
  });
});

// ── Раунд 1 ревью сервера: устаревшая сессия, прилавок, транзакции, трафик ─────────────────────────

/** Второй игрок в той же комнате. */
function addPeer(room: Room, userId: string): { ws: FakeWs; pid: string; save: SaveState } {
  freshLimits(userId);
  const ws = new FakeWs();
  const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Сосед', `char-${++seq}`);
  const pid = room.addPlayer(ws as unknown as GameConn, userId, save, 1);
  return { ws, pid, save };
}
type WorldIn = { players: Record<string, { pos: { x: number; y: number }; hp: number }>; drops: { item?: Item }[] };
const worldOf = (room: Room): WorldIn => (room as unknown as { session: { world: WorldIn } }).session.world;
const idle = { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
type StockIn = { shop: Item[]; questBoard: { id: string }[]; stock: { at: number } };
const stockOf = (room: Room): StockIn => room as unknown as StockIn;

describe('Room — раунд 1: устаревшая сессия, прилавок, транзакции, трафик', () => {
  afterEach(() => { db.failStash = false; db.stashWriteGate = null; vi.restoreAllMocks(); });

  it('⭐ R1-01: базу обогнали — сессия теряет право писать: сокет закрыт (4009), игрок снят, прощальной записи нет', async () => {
    const { room, ws, pid, save } = makeRoom();
    await settle();
    // Другой писатель (админский отзыв вещи, «Завершить» из другой вкладки) поднял версию сейва.
    db.saves.set(save.charId, (db.saves.get(save.charId) ?? 1) + 5);
    const w0 = db.writes.length;
    await room.flush();
    expect(ws.open, 'зомби не остаётся играть').toBe(false);
    expect(ws.closedWith).toBe(4009);
    expect(room.size, 'игрок снят с комнаты').toBe(0);
    // Закрытие сокета доедет до менеджера позже — снятие уже снятого ничего не пишет.
    await room.removePlayer(pid);
    expect(db.writes.length - w0, 'ни одной записи устаревшей копией').toBe(0);
  });

  it('⭐ R1-03: круги «город ↔ арена» не перекатывают прилавок и доску и не пишут в базу', async () => {
    const { room, pid } = makeRoom();
    await settle();
    const st = stockOf(room);
    // Сравниваем СНАРЯЖЕНИЕ: зелья лавки катаются заново на каждый заход в город (R2-04), бросать там нечего.
    const gear = (): string => st.shop.filter((i) => i.kind !== 'consumable').map((i) => i.uid).join();
    const shop0 = gear(), board0 = st.questBoard.map((q) => q.id).join();
    const w0 = db.writes.length;
    for (let i = 0; i < 3; i++) {
      ready(room); room.enterArena(pid);
      expect(areaOf(room)).toBe('arena');
      ready(room); room.returnTown(pid);
      expect(areaOf(room)).toBe('town');
    }
    expect(gear(), 'прилавок тот же').toBe(shop0);
    expect(st.questBoard.map((q) => q.id).join(), 'доска та же').toBe(board0);
    expect(db.writes.length - w0, 'из арены в город — без записи в базу').toBe(0);

    // Время обновления пришло — следующий вход в город катает новый сток.
    st.stock.at -= cfg.get('balance').townRestockSec * 1000 + 1;
    ready(room); room.enterArena(pid);
    ready(room); room.returnTown(pid);
    expect(gear(), 'после срока прилавок обновился').not.toBe(shop0);
  });

  it('⭐ R1-03: новая комната того же героя — тот же прилавок; купленное не возвращается', async () => {
    const a = makeRoom();
    await settle();
    const first = a.ws.last('shop')!.items;
    const gear = first.find((i) => i.kind !== 'consumable')!;
    expect(gear, 'на прилавке есть снаряжение').toBeTruthy();
    await a.room.removePlayer(a.pid);

    const reenter = (): { room: Room; ws: FakeWs; pid: string } => {
      const room = new RoomCtor('TEST', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
      rooms.push(room);
      const ws = new FakeWs();
      const pid = room.addPlayer(ws as unknown as GameConn, 'user-1', a.save, db.saves.get(a.save.charId) ?? 1);
      return { room, ws, pid };
    };
    const b = reenter();
    // Снаряжение: зелья лавки у каждой комнаты свои (R2-04) — перебрасывать в них нечего.
    const gearOf = (items: Item[]): string[] => items.filter((i) => i.kind !== 'consumable').map((i) => i.uid);
    expect(gearOf(b.ws.last('shop')!.items), 'вышел-зашёл — прилавок не перекатился').toEqual(gearOf(first));
    a.save.gold = 1_000_000;
    await b.room.handleCmd(b.pid, { cmd: 'buy', uid: gear.uid }, 1);
    expect(b.ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
    await b.room.removePlayer(b.pid);

    const c = reenter();
    const again = c.ws.last('shop')!.items.map((i) => i.uid);
    expect(again, 'купленное не вернулось').not.toContain(gear.uid);
    expect(again).toHaveLength(first.length - 1);
  });

  it('⭐ R2-36: кадр прилавка несёт АВТОРИТЕТНУЮ цену покупки каждой вещи — ровно ту, что спишет buy', async () => {
    const a = makeRoom();
    await settle();
    const f = a.ws.last('shop')!;
    expect(f.items.length).toBeGreaterThan(0);
    expect(Object.keys(f.prices).sort()).toEqual(f.items.map((i) => i.uid).sort());
    for (const it of f.items) expect(f.prices[it.uid], it.name).toBe(shopBuyPrice(cfg, it));
    // Цена кадра — та самая: на единицу меньше — отказ, ровно она — покупка и ноль в кошельке.
    const gear = f.items.find((i) => i.kind !== 'consumable')!;
    a.save.gold = f.prices[gear.uid]! - 1;
    await a.room.handleCmd(a.pid, { cmd: 'buy', uid: gear.uid }, 1);
    expect(a.ws.last('cmdResult')).toMatchObject({ id: 1, ok: false, reason: 'Недостаточно золота' });
    a.save.gold = f.prices[gear.uid]!;
    await a.room.handleCmd(a.pid, { cmd: 'buy', uid: gear.uid }, 2);
    expect(a.ws.last('cmdResult')).toMatchObject({ id: 2, ok: true });
    expect(a.save.gold).toBe(0);
    // Прилавок пересобран — цены в новом кадре тоже: купленного в них нет.
    const g = a.ws.last('shop')!;
    expect(g.prices[gear.uid]).toBeUndefined();
    expect(Object.keys(g.prices)).toHaveLength(g.items.length);
  });

  it('R1-03: переход голосованием — не чаще раза в полторы секунды', () => {
    const { room, ws, pid } = makeRoom();
    room.enterArena(pid);
    expect(areaOf(room)).toBe('arena');
    room.returnTown(pid);
    expect(areaOf(room), 'сразу назад нельзя').toBe('arena');
    expect(ws.last('error')?.code).toBe('rate');
    ready(room);
    room.returnTown(pid);
    expect(areaOf(room)).toBe('town');
  });

  it('⭐ R1-05: пока сдача сырья ждёт базу, тик не трогает сейв игрока — откат не возвращает выпитое и не стирает поднятое', async () => {
    const a = makeRoom('user-hold');
    const b = addPeer(a.room, 'user-hold-b');
    await settle();
    const w = worldOf(a.room);
    // Сосед роняет вещь у ног A.
    const gift = weaponInBag(b.save);
    w.players[b.pid]!.pos = { ...w.players[a.pid]!.pos };
    await a.room.handleCmd(b.pid, { cmd: 'drop', uid: gift.uid }, 1);
    expect(b.ws.last('cmdResult')).toMatchObject({ ok: true });
    // У A: сырьё в сумке (есть что сдавать), зелье на поясе, здоровье на донышке.
    const def = cfg.get('craft-materials').find((m) => m.enabled)!;
    a.save.inventory.push({ ...materialItem(def, 5, uuidv7()), pos: { x: 0, y: 0 } });
    const potion = itemFromBaseId(cfg.get('items.base'), 'healing-potion', undefined, 'shop')!;
    a.save.belt = [potion];
    w.players[a.pid]!.hp = 1;

    let open!: () => void;
    db.stashWriteGate = new Promise<void>((r) => { open = r; });
    db.failStash = true;
    const cmd = a.room.handleCmd(a.pid, { cmd: 'depositMaterials' }, 2);
    await settle();                                   // транзакция стоит на записи
    a.room.setInput(a.pid, { ...idle, useBelt: 0 });
    a.room.step(false);
    a.room.setInput(a.pid, { ...idle, interact: true });
    a.room.step(false);
    a.room.setInput(a.pid, idle);
    db.stashWriteGate = null;
    open();
    await cmd;
    db.failStash = false;
    expect(a.ws.last('cmdResult')).toMatchObject({ id: 2, ok: false });
    const healed = w.players[a.pid]!.hp > 30;
    const potionLeft = a.save.belt[0]?.uid === potion.uid;
    expect(healed && potionLeft, 'зелье выпито и вернулось — бесплатное лечение').toBe(false);
    const inBag = a.save.inventory.some((i) => i.uid === gift.uid);
    const onGround = w.drops.some((d) => d.item?.uid === gift.uid);
    expect(Number(inBag) + Number(onGround), `в сумке ${inBag}, на земле ${onGround}`).toBe(1);

    // Транзакция кончилась — тик снова работает для A.
    a.room.setInput(a.pid, { ...idle, useBelt: 0 });
    a.room.step(false);
    a.room.setInput(a.pid, idle);
    expect(a.save.belt[0] ?? null, 'зелье пьётся, как только запись закончилась').toBeNull();
  });

  it('⭐ R1-05: голосование, прошедшее пока транзакция ждёт базу, исполняется ПОСЛЕ неё — откат не снимает забег', async () => {
    const a = makeRoom('user-hold-vote');
    const b = addPeer(a.room, 'user-hold-vote-b');
    await settle();
    const def = cfg.get('craft-materials').find((m) => m.enabled)!;
    a.save.inventory.push({ ...materialItem(def, 5, uuidv7()), pos: { x: 0, y: 0 } });
    a.room.descend(a.pid);                            // A за, ждём B
    let open!: () => void;
    db.stashWriteGate = new Promise<void>((r) => { open = r; });
    db.failStash = true;
    const cmd = a.room.handleCmd(a.pid, { cmd: 'depositMaterials' }, 1);
    await settle();
    a.room.castVote(b.pid, true);
    db.stashWriteGate = null;
    open();
    await cmd;
    db.failStash = false;
    expect(a.ws.last('cmdResult')).toMatchObject({ id: 1, ok: false });
    expect(areaOf(a.room), 'голосование исполнилось').toBe('dungeon');
    expect(a.save.run, 'указатель забега у A на месте — откат его не стёр').toBeTruthy();
  });

  it('R1-10: команды не из того места шумят в лог не чаще раза в окно', async () => {
    const { room, pid } = makeRoom();
    room.descend(pid);
    await settle();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 50; i++) await room.handleCmd(pid, { cmd: 'stashOpen' }, 100 + i);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('вне города')).length).toBeLessThanOrEqual(1);
  });

  it('⭐ R1-11: отказы не рассылают полный сейв без меры; невалидная команда — без сейва вовсе', async () => {
    const { room, ws, pid } = makeRoom();
    await settle();
    ws.frames.length = 0;
    for (let i = 0; i < 50; i++) await room.handleCmd(pid, { cmd: 'sell', uid: 'нет-такой-вещи' }, 300 + i);
    expect(countOf(ws, 'cmdResult'), 'ответ на каждую').toBe(50);
    expect(countOf(ws, 'saveUpdate'), 'сейв — только первые несколько').toBeLessThanOrEqual(5);
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'sell', uid: 'x', extra: 1 }, 400);
    expect(ws.last('cmdResult')).toMatchObject({ id: 400, ok: false, reason: 'Неверная команда' });
    expect(countOf(ws, 'saveUpdate'), 'невалидная команда сейв не трогала').toBe(0);
  });

  it('⭐ R1-11: пустая команда не рассылает статику пати; надетый меч — ровно один кадр', async () => {
    const a = makeRoom('user-peer-a');
    const b = addPeer(a.room, 'user-peer-b');
    a.save.level = 60;
    for (const k of Object.keys(a.save.attributes) as (keyof SaveState['attributes'])[]) a.save.attributes[k] = 500;
    await settle();
    // Уровень и атрибуты поставлены мимо игры — их разносит первая же рассылка статики.
    await a.room.handleCmd(a.pid, { cmd: 'bind', slot: 0, value: 'attack' }, 9);
    b.ws.frames.length = 0;
    for (let i = 0; i < 10; i++) await a.room.handleCmd(a.pid, { cmd: 'bind', slot: 0, value: 'attack' }, 10 + i);
    expect(countOf(b.ws, 'peerInfo'), 'статика не менялась — рассылать нечего').toBe(0);
    const parts = defaultParts(cfg, 'sword', 1, 2)!;
    const pv = craftWeapon(cfg, { weaponClass: 'sword', hands: 1, parts }, { rng: createRng(5) });
    expect(pv.ok, pv.reason).toBe(true);
    const sword = { ...pv.item!, pos: { x: 0, y: 0 } };
    a.save.inventory.push(sword);
    await a.room.handleCmd(a.pid, { cmd: 'equip', uid: sword.uid }, 30);
    expect(a.ws.last('cmdResult')).toMatchObject({ ok: true });
    expect(countOf(b.ws, 'peerInfo'), 'сменилось оружие — ровно один кадр').toBe(1);
    expect(b.ws.last('peerInfo')!.peers.map((p) => p.id), 'и только про A').toEqual([a.pid]);
  });
});

// ── Раунд 2 ревью сервера ────────────────────────────────────────────────────────────────────────

describe('Room — раунд 2: чужие вещи, лавка, неизвестный исход записи, разбор на месте, журнал, лог', () => {
  afterEach(() => {
    db.foreign.clear(); db.commitUnknown = false; db.saveGate = null;
    vi.restoreAllMocks();
  });

  it('⭐ R2-02: выброшенное игроком ДРУГОГО аккаунта не поднять — ни кликом, ни по [E]; своё и своего аккаунта — можно', async () => {
    const a = makeRoom('user-drop-a');
    const b = addPeer(a.room, 'user-drop-b');
    const alt = addPeer(a.room, 'user-drop-a');          // второй герой того же аккаунта
    await settle();
    const w = worldOf(a.room);
    const sword = weaponInBag(a.save);
    await a.room.handleCmd(a.pid, { cmd: 'drop', uid: sword.uid }, 1);
    expect(a.ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
    const drop = (w.drops as { id: number; item?: Item; pos: { x: number; y: number } }[]).find((d) => d.item?.uid === sword.uid)!;
    expect(drop).toBeTruthy();

    w.players[b.pid]!.pos = { ...drop.pos };
    await a.room.handleCmd(b.pid, { cmd: 'pickup', dropId: drop.id }, 1);
    expect(b.ws.last('cmdResult')).toMatchObject({ id: 1, ok: false });
    expect(b.ws.last('cmdResult')!.reason).toMatch(/аккаунт/);
    a.room.setInput(b.pid, { ...idle, interact: true });
    a.room.step(false);
    a.room.setInput(b.pid, idle);
    expect(b.save.inventory.some((i) => i.uid === sword.uid), 'и по [E] не поднять').toBe(false);
    expect(w.drops.some((d) => d.item?.uid === sword.uid), 'вещь лежит на земле').toBe(true);

    w.players[alt.pid]!.pos = { ...drop.pos };
    await a.room.handleCmd(alt.pid, { cmd: 'pickup', dropId: drop.id }, 1);
    expect(alt.ws.last('cmdResult'), 'герой того же аккаунта поднимает').toMatchObject({ id: 1, ok: true });
    expect(alt.save.inventory.some((i) => i.uid === sword.uid)).toBe(true);
  });

  it('⭐ R2-02: вещь чужого аккаунта в сейве не губит все записи игрока — её изымают, остальное пишется, игроку говорят', async () => {
    const { room, ws, save } = makeRoom('user-ledger');
    await settle();
    const alien = weaponInBag(save);
    db.foreign.add(alien.uid);
    save.gold = 4242;
    ws.frames.length = 0;
    await room.flush();
    expect(db.data.get(save.charId)?.gold, 'прогресс записан').toBe(4242);
    expect(save.inventory.some((i) => i.uid === alien.uid), 'чужая вещь изъята из сейва').toBe(false);
    expect(db.data.get(save.charId)!.inventory.some((i) => i.uid === alien.uid)).toBe(false);
    expect(ws.last('error')?.msg, 'игроку сказали').toMatch(/изъят/);
    expect(ws.last('saveUpdate')!.save.inventory.some((i) => i.uid === alien.uid)).toBe(false);
    expect(ws.open, 'сессия жива').toBe(true);
  });

  it('⭐ R2-04: зелья лавки — свои на каждый заход в город и в новой комнате; снаряжение — сток героя', async () => {
    const { room, ws, pid, save } = makeRoom('user-potions');
    await settle();
    save.gold = 1_000_000;
    const heal = (items: Item[]): Item[] => items.filter((i) => i.baseId === 'healing-potion');
    const gearOf = (items: Item[]): string[] => items.filter((i) => i.kind !== 'consumable').map((i) => i.uid);
    const gear0 = gearOf(ws.last('shop')!.items);
    const first = heal(ws.last('shop')!.items);
    expect(first).toHaveLength(5);
    let id = 1;
    for (const p of first) {
      await room.handleCmd(pid, { cmd: 'buy', uid: p.uid }, id++);
      expect(ws.last('cmdResult')).toMatchObject({ ok: true });
    }
    expect(heal(ws.last('shop')!.items), 'раскупили').toHaveLength(0);
    ready(room); room.enterArena(pid);
    ready(room); room.returnTown(pid);
    expect(heal(ws.last('shop')!.items), 'новый заход в город — зелья снова на прилавке').toHaveLength(5);
    expect(gearOf(ws.last('shop')!.items), 'снаряжение не перекатилось').toEqual(gear0);

    await room.removePlayer(pid);
    const room2 = new RoomCtor('TEST', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room2);
    const ws2 = new FakeWs();
    room2.addPlayer(ws2 as unknown as GameConn, 'user-potions', save, db.saves.get(save.charId) ?? 1);
    expect(heal(ws2.last('shop')!.items), 'новая комната в пределах срока — зелья на месте').toHaveLength(5);
    expect(gearOf(ws2.last('shop')!.items), 'снаряжение — тот же сток').toEqual(gear0);
  });

  it('⭐ R2-09: база запись приняла, а ответ на фиксацию потерян — память не откатывается к «до», сессия снята (4009)', async () => {
    const user = 'user-r209';
    const { room, ws, pid, save } = makeRoom(user);
    await settle();
    const it = weaponInBag(save);
    db.commitUnknown = true;
    await room.handleCmd(pid, { cmd: 'stashMove', uid: it.uid, dst: 0, x: 0, y: 0 }, 1);
    db.commitUnknown = false;
    expect(db.stashes.get(user)!.data.tabs.flat().some((i) => i.uid === it.uid), 'база перенос приняла').toBe(true);
    const inMem = save.inventory.some((i) => i.uid === it.uid);
    expect(!inMem || ws.closedWith === 4009, 'в памяти вещь снова в сумке, а сессия жива').toBe(true);
    await room.handleCmd(pid, { cmd: 'drop', uid: it.uid }, 2);
    expect(worldOf(room).drops.some((d) => d.item?.uid === it.uid), 'выбросить вторую копию нельзя').toBe(false);
  });

  it('⭐ R2-14: разбор на месте не ждёт базу — зелье после него пьётся сразу; запись с причиной разбора доходит позже', async () => {
    const { room, ws, pid, save } = makeRoom('user-field');
    room.descend(pid);
    await settle();
    expect(areaOf(room)).toBe('dungeon');
    const potion = itemFromBaseId(cfg.get('items.base'), 'healing-potion', undefined, 'shop')!;
    save.belt = [potion];
    let open!: () => void;
    db.saveGate = new Promise<void>((r) => { open = r; });
    const w0 = db.writes.length;
    try {
      let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        const it = weaponInBag(save);
        limits.forgeCmd.reset(userOf(pid));
        const salv = room.handleCmd(pid, { cmd: 'salvage', uid: it.uid }, 10 + i);
        const quick = await Promise.race([salv.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 100))]);
        expect(quick, 'ответ на разбор не ждёт базу').toBe(true);
        done = !!ws.last('cmdResult')?.ok;
        if (!done) save.inventory = save.inventory.filter((x) => x.uid !== it.uid);
      }
      expect(done, 'разбор удался').toBe(true);
      // R4-35: зелье при полном здоровье не тратится — ранен, чтобы оно подействовало.
      const hero = worldOf(room).players[pid]!;
      hero.hp = Math.max(1, Math.floor(hero.hp / 2));
      await room.handleCmd(pid, { cmd: 'useConsumable', uid: potion.uid }, 99);
      expect(ws.last('cmdResult')).toMatchObject({ id: 99, ok: true });
      expect(save.belt[0] ?? null, 'зелье выпито, пока запись разбора ждёт базу').toBeNull();
      expect(db.writes.length - w0, 'запись разбора ещё не дошла').toBe(0);
    } finally {
      db.saveGate = null;
      open();
    }
    await settle();
    expect(db.writes.slice(w0).some((w) => w.reason === 'salvage'), JSON.stringify(db.writes.slice(w0))).toBe(true);
  });

  it('⭐ R2-21: запись ковки подписывает «ковкой» только скованную вещь — купленное до неё идёт автосейвом', async () => {
    const liveBefore = cfg.get('balance').craft.live;
    cfg.get('balance').craft.live = true;
    try {
      const { room, ws, pid, save, s } = await craftSetup('user-r221', 1_000_000);
      const gear = stockOf(room).shop.find((i) => i.kind !== 'consumable' && i.gridW * i.gridH <= 2)
        ?? stockOf(room).shop.find((i) => i.kind !== 'consumable')!;
      await room.handleCmd(pid, { cmd: 'buy', uid: gear.uid }, 1);
      expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ id: 1, ok: true });
      expect(save.inventory.some((i) => i.uid === gear.uid)).toBe(true);
      await room.handleCmd(pid, craftCmd('r221-nonce-01', s.input), 2);
      const r = ws.last('cmdResult')!;
      expect(r, JSON.stringify(r)).toMatchObject({ id: 2, ok: true });
      const last = db.reasonMaps.at(-1)!;
      expect(last.reasons[r.uid!], 'скованное — ковкой').toBe('craft');
      expect(last.reasons[gear.uid], 'купленное — не ковкой').toBeUndefined();
    } finally { cfg.get('balance').craft.live = liveBefore; }
  });

  it('R2-25: общий лимит команд и лимит кузницы — РАЗНЫЕ счётчики', async () => {
    const { room, pid } = makeRoom('user-r225');
    await settle();
    const t0 = counters.cmdTownRateLimited, f0 = counters.cmdRateLimited;
    for (let i = 0; i < 200; i++) await room.handleCmd(pid, { cmd: 'bind', slot: 0, value: 'attack' }, 500 + i);
    expect(counters.cmdTownRateLimited - t0, 'поток привязок упёрся в общий лимит').toBeGreaterThan(0);
    expect(counters.cmdRateLimited - f0, 'кузница тут ни при чём').toBe(0);
    limits.townCmd.reset(userOf(pid));
    const t1 = counters.cmdTownRateLimited;
    for (let i = 0; i < 8; i++) await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: 'нет-такой' }, 800 + i);
    expect(counters.cmdRateLimited - f0, 'разборы упёрлись в лимит кузницы').toBeGreaterThan(0);
    expect(counters.cmdTownRateLimited - t1).toBe(0);
  });

  it('R2-26: ключ команды с переводом строки Unicode и bidi не подделывает строку лога', async () => {
    const { room, pid } = makeRoom('user-r226');
    await settle();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = JSON.parse('{"cmd":"sell","uid":"x","a\\u2028[room ABCD] fake\\u0085\\u2029\\u202Eevil":1}') as unknown;
    await room.handleCmd(pid, raw, 900);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('невалидная команда'));
    expect(line, 'шум о невалидной команде есть').toBeTruthy();
    expect(line, JSON.stringify(line)).not.toMatch(new RegExp('[\\u2028\\u2029\\u0085\\u202E]'));
  });
});

// ── Раунд 3 ревью: ядро (бинд, отравленный сейв, квесты доски, эскизы) ─────────────────────────────

describe('Room — раунд 3: сейв, который база не примет никогда (R3-02)', () => {
  const NUL = String.fromCharCode(0);
  afterEach(() => { vi.restoreAllMocks(); });

  it('⭐ бинд с U+0000 или непарным суррогатом — «Неверная команда»: сейв и база чисты, сессия жива', async () => {
    const { room, ws, pid, save } = makeRoom('user-r302-bind');
    await settle();
    const before = JSON.stringify(save), v0 = db.saves.get(save.charId);
    for (const [i, value] of [`x${NUL}`, `x${String.fromCharCode(0xd800)}`, 'нет-такого-скилла'].entries()) {
      await room.handleCmd(pid, { cmd: 'bind', slot: 4, value }, 10 + i);
      expect(ws.last('cmdResult'), JSON.stringify(value)).toMatchObject({ id: 10 + i, cmd: 'bind', ok: false });
    }
    expect(JSON.stringify(save), 'hotbar не тронут').toBe(before);
    await room.flush();
    expect(db.saves.get(save.charId), 'автосейв прошёл').toBe((v0 ?? 1) + 1);
    expect(ws.open, 'сессия жива').toBe(true);
  });

  it('⭐ отравленный сейв: запись падает классом 22 — сессия снята (4009), героем из памяти не играют, лог один', async () => {
    const { room, ws, pid, save } = makeRoom('user-r302-poison');
    await settle();
    const v0 = db.saves.get(save.charId), inDb = JSON.stringify(db.data.get(save.charId));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    save.name = `x${NUL}`;   // мимо команд: вторая линия обязана держать и то, что первая когда-нибудь пропустит
    await room.flush();
    expect(ws.closedWith, 'сокет закрыт как устаревший').toBe(4009);
    expect(room.size, 'игрок снят').toBe(0);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('не примет')).length, 'в лог — один раз').toBe(1);
    expect(db.saves.get(save.charId), 'в базе прежняя версия').toBe(v0);
    expect(JSON.stringify(db.data.get(save.charId)), 'и прежний сейв').toBe(inDb);
    // Выход после снятия — ни записи, ни «сохраняем, повторите» навсегда.
    await expect(room.removePlayer(pid)).resolves.toEqual({ saved: true });
    // Команда снятой сессии — некому исполнять.
    await room.handleCmd(pid, { cmd: 'drop', uid: save.inventory[0]?.uid ?? 'x' }, 1);
    expect(worldOf(room).drops.length, 'бросить вещь соседу снятая сессия не может').toBe(0);
  });

  it('⭐ выход с отравленным сейвом (город и подземелье): прощальная запись не держит копию вечно — правда в базе', async () => {
    for (const where of ['town', 'dungeon'] as const) {
      const { room, pid, save } = makeRoom(`user-r302-leave-${where}`);
      await settle();
      if (where === 'dungeon') { room.descend(pid); await settle(); }
      const v0 = db.saves.get(save.charId);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      save.name = `x${NUL}`;
      const f = await room.removePlayer(pid);
      expect(f, `${where}: копию не держим — её не записать никогда`).toEqual({ saved: true });
      expect(db.saves.get(save.charId), `${where}: в базе прежняя версия`).toBe(v0);
    }
  });

  it('транзакция «сейв + сундук» на отравленном сейве — тоже снятие, а не «попробуйте ещё раз» по кругу', async () => {
    const { room, ws, pid, save } = makeRoom('user-r302-tx');
    await settle();
    const it = weaponInBag(save);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    save.name = `x${NUL}`;
    await room.handleCmd(pid, { cmd: 'stashMove', uid: it.uid, dst: 0, x: 0, y: 0 }, 1);
    expect(ws.closedWith).toBe(4009);
    expect(db.stashes.get('user-r302-tx')?.data.tabs.flat().some((i) => i.uid === it.uid) ?? false, 'в сундук не ушло').toBe(false);
  });
});

describe('Room — раунд 3: случайные квесты доски (R3-10)', () => {
  type QuestFrame = { id: string; objectives: { type: string; amount: number }[] };
  const boardOf = (ws: FakeWs): QuestFrame[] => (ws.last('questBoard')?.quests ?? []) as QuestFrame[];
  const delveOf = (ws: FakeWs): QuestFrame | undefined => boardOf(ws).find((q) => q.objectives.some((o) => o.type === 'reach-floor'));
  const statusOf = (save: SaveState, id: string): string | undefined => save.quests.find((q) => q.questId === id)?.status;
  /** Глубина текущего узла забега по последнему кадру `runPlan`. */
  const depthNow = (ws: FakeWs): number => { const rp = ws.last('runPlan')!; return nodeOf(rp.plan, rp.currentNodeId).depth; };
  /** Спуск по первому ребру, пока узел мельче `depth`. */
  function diveTo(room: Room, ws: FakeWs, pid: string, depth: number): void {
    for (let i = 0; i < 40 && depthNow(ws) < depth; i++) {
      const rp = ws.last('runPlan')!;
      const next = nodeOf(rp.plan, rp.currentNodeId).edges[0];
      expect(next, 'граф достаточно глубок для теста').toBeDefined();
      ready(room);
      toExit(room, pid, next!.to);
      room.descend(pid, undefined, next!.to);
    }
    expect(depthNow(ws)).toBe(depth);
  }

  it('⭐ «достичь этажа» не засчитывает продолжение забега на уже пройденном узле — только новый вход глубже', async () => {
    const { room, ws, pid, save } = makeRoom('user-r310-resume');
    await settle();
    const tpl = cfg.get('run-templates').find((t) => t.enabled !== false && (t.length?.min ?? 0) >= 6)!;
    expect(tpl, 'шаблон забега не короче шести этажей').toBeDefined();
    room.descend(pid, 'normal', undefined, { templateId: tpl.id });
    diveTo(room, ws, pid, 4);
    const parked = ws.last('runPlan')!.currentNodeId;
    ready(room); room.returnTown(pid);
    expect(areaOf(room)).toBe('town');
    expect(save.run?.currentNodeId, 'забег припаркован на 4-м этаже').toBe(parked);

    const delve = delveOf(ws)!;
    expect(delve, 'на доске есть «достичь этажа»').toBeDefined();
    expect(delve.objectives[0]!.amount, 'цель не глубже припаркованного узла').toBeLessThanOrEqual(4);
    await room.handleCmd(pid, { cmd: 'acceptQuest', questId: delve.id }, 1);
    expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });

    ready(room); room.descend(pid);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(ws.last('runPlan')!.currentNodeId, 'спуск из города продолжил тот же узел').toBe(parked);
    expect(statusOf(save, delve.id), 'возврат на пройденный этаж — не достижение').toBe('active');
    await room.handleCmd(pid, { cmd: 'turnInQuest', questId: delve.id }, 2);
    expect(ws.last('cmdResult')).toMatchObject({ id: 2, ok: false });

    diveTo(room, ws, pid, 5);
    expect(statusOf(save, delve.id), 'новый узел глубже цели — выполнено').toBe('completed');
  });

  it('⭐ доски героев-хозяев не множат квесты: второе задание того же шаблона за срок доски — отказ; другой шаблон и срок спустя — можно', async () => {
    const user = 'user-r310-alts';
    const a = makeRoom(user);
    await settle();
    const main = addPeer(a.room, user);
    await settle();
    const delveA = delveOf(main.ws)!;
    expect(delveA).toBeDefined();
    await a.room.handleCmd(main.pid, { cmd: 'acceptQuest', questId: delveA.id }, 1);
    expect(main.ws.last('cmdResult'), 'с доски первого альта — можно').toMatchObject({ id: 1, ok: true });
    await a.room.removePlayer(main.pid);

    const b = makeRoom(user);
    await settle();
    const ws2 = new FakeWs();
    const pid2 = b.room.addPlayer(ws2 as unknown as GameConn, user, main.save, db.saves.get(main.save.charId) ?? 1);
    await settle();
    const delveB = delveOf(ws2)!;
    expect(delveB.id, 'у второго альта своя доска').not.toBe(delveA.id);
    const before = JSON.stringify(main.save.quests);
    await b.room.handleCmd(pid2, { cmd: 'acceptQuest', questId: delveB.id }, 2);
    const r = ws2.last('cmdResult')!;
    expect(r, 'второе «достичь этажа» за срок доски — отказ').toMatchObject({ id: 2, ok: false });
    expect(r.reason).toBeTruthy();
    expect(JSON.stringify(main.save.quests), 'квесты не тронуты').toBe(before);
    expect(delveOf(ws2)?.id, 'квест остался на доске').toBe(delveB.id);

    const other = boardOf(ws2).find((q) => !q.objectives.some((o) => o.type === 'reach-floor'));
    if (other) {
      await b.room.handleCmd(pid2, { cmd: 'acceptQuest', questId: other.id }, 3);
      expect(ws2.last('cmdResult'), 'другой шаблон — своя квота').toMatchObject({ id: 3, ok: true });
    }
    // Срок доски вышел — квота обновилась, как обновилась бы и сама доска. R4-33: мерка — поколение доски (`boardAt`).
    const prog = main.save.quests.find((q) => q.questId === delveA.id)! as { acceptedAt?: number; boardAt?: number };
    expect(typeof prog.acceptedAt, 'время принятия записано в прогресс').toBe('number');
    expect(typeof prog.boardAt, 'и поколение доски').toBe('number');
    prog.acceptedAt = prog.boardAt = stockOf(b.room).stock.at - cfg.get('balance').townRestockSec * 1000 - 1;
    await b.room.handleCmd(pid2, { cmd: 'acceptQuest', questId: delveB.id }, 4);
    expect(ws2.last('cmdResult'), 'срок вышел — можно').toMatchObject({ id: 4, ok: true });
  });

  it('⭐ R4-33: доска честно обновилась — то же задание с новой доски берётся сразу, а не через срок от принятия', async () => {
    const W = cfg.get('balance').townRestockSec * 1000;
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T0);                              // доска героя катается сейчас
      const { room, ws, pid, save } = makeRoom('user-r433');
      await settle();
      const first = delveOf(ws)!;
      vi.setSystemTime(T0 + W - 60_000);                 // взял на последней минуте доски
      await room.handleCmd(pid, { cmd: 'acceptQuest', questId: first.id }, 1);
      expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
      save.quests.find((q) => q.questId === first.id)!.status = 'turned-in';
      vi.setSystemTime(T0 + W + 1);                      // срок доски вышел — заход в город катает новую
      ready(room); room.enterArena(pid);
      ready(room); room.returnTown(pid);
      const fresh = delveOf(ws)!;
      expect(fresh.id, 'доска обновилась').not.toBe(first.id);
      await room.handleCmd(pid, { cmd: 'acceptQuest', questId: fresh.id }, 2);
      expect(ws.last('cmdResult'), 'раньше — «доска обновится позже» ещё девять минут').toMatchObject({ id: 2, ok: true });
    } finally { vi.useRealTimers(); }
  });
});

describe('Room — раунд 3: эскизы кузнеца (R3-11)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const sketchableId = (j: CraftJournal): string => cfg.get('weapon-parts').find((p) => p.enabled !== false && sketchable(cfg, j, p.id))!.id;

  it('⭐ восемь разборов найденного у кузнеца → эскиз; forgeSketch открывает деталь — в базе, в кадре сундука, одной записью', async () => {
    const user = 'user-r311-flow';
    const { room, ws, pid, save } = makeRoom(user);
    await settle();
    const k = cfg.get('balance').craft.journal;
    for (let i = 0; i < k.sketchAfter; i++) {
      const found = foundWeaponInBag(save, 40 + i);
      limits.forgeCmd.reset(userOf(pid));
      await room.handleCmd(pid, { cmd: 'forgeSalvage', uid: found.uid }, 100 + i);
      expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ id: 100 + i, ok: true });
    }
    expect(ws.last('cmdResult')!.unlocked?.some((l) => /Эскиз/.test(l)), 'разбор сказал об эскизе').toBe(true);
    const j0 = db.stashes.get(user)!.data.forgeJournal!;
    expect(j0.sketches, 'жалость дала эскиз').toBe(1);
    const id = sketchableId(j0);
    limits.forgeCmd.reset(userOf(pid));
    const w0 = db.writes.length;
    ws.frames.length = 0;
    await room.handleCmd(pid, { cmd: 'forgeSketch', variantId: id }, 200);
    const r = ws.last('cmdResult')!;
    expect(r, JSON.stringify(r)).toMatchObject({ id: 200, cmd: 'forgeSketch', ok: true });
    expect(r.unlocked?.[0]).toMatch(/Деталь/);
    const j1 = db.stashes.get(user)!.data.forgeJournal!;
    expect(j1.variants, 'деталь открыта в базе').toContain(id);
    expect(j1.sketches, 'эскиз потрачен в базе').toBe(0);
    expect(ws.last('stash')!.forgeJournal.variants, 'и в кадре сундука').toContain(id);
    expect(ws.last('stash')!.forgeJournal.sketches).toBe(0);
    expect(db.writes.slice(w0), 'одна транзакция сундука').toEqual([{ kind: 'stash', charId: save.charId, reason: 'craft' }]);
    // Второй раз — эскизов нет: отказ, ничего не записано.
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, { cmd: 'forgeSketch', variantId: sketchableId(j1) }, 201);
    expect(ws.last('cmdResult')).toMatchObject({ id: 201, ok: false, reason: 'Эскизов нет' });
    expect(db.writes.length - w0).toBe(1);
  });

  it('⭐ отказы — сейв, сундук и база байт в байт: эскизов нет, деталь уже открыта, ключевая форма неоткрытого типа, чужой id', async () => {
    const user = 'user-r311-refuse';
    const { room, ws, pid, save } = makeRoom(user);
    await settle();
    const keySlot = keySlotOf(cfg, 'sword');
    const groups = keyVariantsByBase(cfg, 'sword', 1);
    const nonKey = variantsFor(cfg, 'sword', CRAFT_SLOT_LIST.find((s) => s !== keySlot)!, 1)[0]!;
    const journal = (sketches: number): CraftJournal => ({ ...emptyJournal(), bases: [groups[0]!.baseId], variants: [nonKey.id], tierHi: 0, sketches });
    const lockedKey = groups.find((g) => g.baseId !== groups[0]!.baseId)!.variants.find((p) => !sketchable(cfg, journal(2), p.id))!;
    expect(lockedKey, 'есть ключевая форма неоткрытого типа').toBeDefined();
    const cases: [string, CraftJournal, string, RegExp][] = [
      ['эскизов нет', journal(0), sketchableId(journal(1)), /Эскизов нет/],
      ['уже открыта', journal(2), nonKey.id, /уже открыт/],
      ['ключевая форма неоткрытого типа', journal(2), lockedKey.id, /не открыть/],
      ['нет такой детали', journal(2), 'нет-такой-детали', /Нет такой детали/],
    ];
    for (const [i, [why, j, variantId, reason]] of cases.entries()) {
      seedStash(user, j, {});
      limits.forgeCmd.reset(userOf(pid));
      const before = JSON.stringify(save), snap = dbSnap(user, save.charId);
      await room.handleCmd(pid, { cmd: 'forgeSketch', variantId }, 300 + i);
      const r = ws.last('cmdResult')!;
      expect(r, why).toMatchObject({ id: 300 + i, cmd: 'forgeSketch', ok: false });
      expect(r.reason, why).toMatch(reason);
      expect(JSON.stringify(save), `${why}: сейв не тронут`).toBe(before);
      expect(dbSnap(user, save.charId), `${why}: база не тронута`).toBe(snap);
    }
    // Схема: лишний ключ, пустой id, U+0000 — «Неверная команда».
    for (const [i, bad] of [{ cmd: 'forgeSketch', variantId: nonKey.id, n: 2 }, { cmd: 'forgeSketch', variantId: '' },
      { cmd: 'forgeSketch', variantId: `x${String.fromCharCode(0)}` }, { cmd: 'forgeSketch' }].entries()) {
      await room.handleCmd(pid, bad, 400 + i);
      expect(ws.last('cmdResult'), JSON.stringify(bad)).toMatchObject({ id: 400 + i, ok: false, reason: 'Неверная команда' });
    }
  });

  it('Ф3.1 / D12: эскиз — у кузнеца в городе и под лимитом кузницы', async () => {
    const user = 'user-r311-place';
    const { room, ws, pid, save } = makeRoom(user);
    await settle();
    const j: CraftJournal = { ...emptyJournal(), sketches: 3 };
    seedStash(user, j, {});
    const id = sketchableId(j);
    room.descend(pid);
    await settle();
    const snap = dbSnap(user, save.charId);
    await room.handleCmd(pid, { cmd: 'forgeSketch', variantId: id }, 1);
    expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: false });
    expect(ws.last('cmdResult')!.reason).toMatch(/только в городе/);
    expect(dbSnap(user, save.charId), 'из подземелья — ничего').toBe(snap);
    ready(room); room.returnTown(pid);
    await settle();
    limits.forgeCmd.reset(userOf(pid));
    const f0 = counters.cmdRateLimited;
    for (let i = 0; i < 8; i++) await room.handleCmd(pid, { cmd: 'forgeSketch', variantId: 'нет-такой-детали' }, 10 + i);
    expect(counters.cmdRateLimited - f0, 'перебор id упирается в лимит кузницы').toBeGreaterThan(0);
  });
});

describe('Room — раунд 3: спуск, финал и грейс (R3-01, R3-05, R3-06, R3-17)', () => {
  const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
  /** Узел, на котором стоит комната, — по последнему кадру `runPlan`. */
  const nodeNow = (ws: FakeWs): RunNode => { const rp = ws.last('runPlan')!; return nodeOf(rp.plan, rp.currentNodeId); };
  /** Убить игрока самой симуляцией (смертельный DoT) — весь путь «смерть → штраф → вайп», как в тестах вайпа. */
  function kill(room: Room, pid: string, ws: FakeWs): void {
    const p = runOf(room).session.world.players[pid]!;
    p.hp = 1;
    p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 };
    const n0 = countOf(ws, 'died');
    for (let i = 0; i < 20 && countOf(ws, 'died') === n0; i++) room.step(false);
    expect(countOf(ws, 'died'), 'игрок погиб').toBe(n0 + 1);
  }
  /** Пати из двух: A хозяин, B сосед; забег начат, B голосует «за» каждый переход. */
  async function party(tag: string) {
    const a = makeRoom(`user-${tag}-a`);
    const b = addPeer(a.room, `user-${tag}-b`);
    b.save.gold = 1000;
    await settle();
    a.room.descend(a.pid);
    a.room.castVote(b.pid, true);
    expect(areaOf(a.room)).toBe('dungeon');
    const down = (): void => {
      const cur = nodeNow(a.ws);
      ready(a.room);
      toExit(a.room, a.pid, cur.edges[0]!.to);
      a.room.descend(a.pid, undefined, cur.edges[0]!.to);
      a.room.castVote(b.pid, true);
    };
    return { a, b, down };
  }
  const disconnectedOf = (room: Room): Map<string, { save: SaveState }> =>
    (room as unknown as { disconnected: Map<string, { save: SaveState }> }).disconnected;

  it('⭐ R3-01: спуск издалека — отказ «far»: голосования нет, узел и прогресс сложности те же; у выхода — спуск', () => {
    const { room, ws, pid, save } = makeRoom('user-r301');
    room.descend(pid, 'easy');
    const start = nodeNow(ws);
    expect(start.edges.length, 'со старта есть куда спускаться').toBeGreaterThan(0);
    const w = runOf(room).session.world;
    // Модифицированный клиент шлёт спуск сразу после входа на этаж — от точки входа, не дойдя до выхода.
    // Раскладка тесту не важна: точка заведомо дальше любого выхода.
    const far = { x: -5000, y: -5000 };
    const votes0 = countOf(ws, 'voteStart');
    for (let i = 0; i < 5; i++) {
      ready(room);
      w.players[pid]!.pos = { ...far };
      room.descend(pid, undefined, start.edges[0]!.to);
      room.descend(pid);
    }
    expect(countOf(ws, 'voteStart') - votes0, 'голосования не было').toBe(0);
    expect(ws.last('error')?.code).toBe('far');
    expect(areaOf(room)).toBe('dungeon');
    expect(runOf(room).runNodeId, 'узел тот же').toBe(start.id);
    expect(save.run?.currentNodeId).toBe(start.id);
    expect(save.difficultyProgress.easy, 'прогресс сложности — по настоящей глубине').toBe(start.depth);

    ready(room);
    toExit(room, pid, start.edges[0]!.to);
    room.descend(pid, undefined, start.edges[0]!.to);
    const next = nodeNow(ws);
    expect(next.id, 'от выхода — спуск').toBe(start.edges[0]!.to);
    expect(save.difficultyProgress.easy).toBe(next.depth);
  });

  it('⭐ R3-01: на развилке — ребро только своего выхода, без выбора — выход, у которого стоишь; финал — только у портала', () => {
    let forks = 0;
    for (let attempt = 0; attempt < 6 && !forks; attempt++) {
      const { room, ws, pid } = makeRoom('user-r301-fork');
      room.descend(pid, undefined, undefined, { templateId: 'deep-expedition' });
      for (let guard = 0; guard < 40; guard++) {
        const cur = nodeNow(ws);
        if (cur.edges.length === 0) break;
        ready(room);
        if (cur.edges.length >= 2 && !forks) {
          forks++;
          expect(runOf(room).session.world.exits, 'выход i ↔ ребро i').toHaveLength(cur.edges.length);
          toExit(room, pid, cur.edges[0]!.to);
          room.descend(pid, undefined, cur.edges[1]!.to);          // стоит у выхода 0, просит ребро 1
          expect(ws.last('error')?.code).toBe('far');
          expect(runOf(room).runNodeId, 'чужой выход — не спуск').toBe(cur.id);
          toExit(room, pid, cur.edges[1]!.to);
          room.descend(pid);                                        // ветку не выбрал — ребро выхода под ногами
          expect(nodeNow(ws).id, 'ушли по ребру выхода, у которого стояли').toBe(cur.edges[1]!.to);
          continue;
        }
        toExit(room, pid, cur.edges[0]!.to);
        room.descend(pid, undefined, cur.edges[0]!.to);
      }
      const fin = nodeNow(ws);
      expect(fin.edges, 'дошли до финала').toHaveLength(0);
      const portal = runOf(room).decor.find((d) => d.kind === 'portal')!;
      ready(room);
      runOf(room).session.world.players[pid]!.pos = { x: portal.x + 300, y: portal.y };
      expect(dist(runOf(room).session.world.players[pid]!.pos, portal)).toBeGreaterThan(100);
      room.descend(pid);
      expect(ws.last('error')?.code).toBe('far');
      expect(areaOf(room), 'финал издалека не завершается').toBe('dungeon');
      toExit(room, pid);
      room.descend(pid);
      expect(areaOf(room), 'у портала — завершение').toBe('town');
    }
    expect(forks, 'в графе встретилась развилка').toBe(1);
  });

  it('⭐ R3-05: пати закончила забег, пока партнёр в грейсе, — забег окончен и для него: копия и база без забега, грейс без штрафа', async () => {
    const { a, b, down } = await party('r305');
    for (let g = 0; g < 40 && nodeNow(a.ws).edges.length; g++) down();
    const fin = nodeNow(a.ws).id;
    expect(b.save.run?.currentNodeId).toBe(fin);
    await a.room.removePlayer(b.pid);                    // B закрыл вкладку на финале → грейс
    expect(db.data.get(b.save.charId)!.run?.currentNodeId, 'прощальная запись — с финалом').toBe(fin);
    ready(a.room); toExit(a.room, a.pid); a.room.descend(a.pid);
    expect(areaOf(a.room), 'A завершил забег').toBe('town');
    await settle();
    expect(disconnectedOf(a.room).get(b.save.charId)?.save.run, 'копия ждущего — без забега').toBeUndefined();
    expect(db.data.get(b.save.charId)!.run, 'и в базе: «Продолжить» некуда').toBeUndefined();
    (a.room as unknown as { expireGrace(): void }).expireGrace();
    await settle();
    expect(db.data.get(b.save.charId)!.gold, 'истечение грейса после финала — не смерть').toBe(1000);
  });

  it('⭐ R3-05: вернувшийся после чужого финала — в городе, и его спуск начинает НОВЫЙ забег, а не финал', async () => {
    const { a, b, down } = await party('r305r');
    for (let g = 0; g < 40 && nodeNow(a.ws).edges.length; g++) down();
    const fin = nodeNow(a.ws).id;
    await a.room.removePlayer(b.pid);
    ready(a.room); toExit(a.room, a.pid); a.room.descend(a.pid);
    await settle();
    const ws2 = new FakeWs();
    const pidB = a.room.reconnect(ws2 as unknown as GameConn, 'user-r305r-b', structuredClone(db.data.get(b.save.charId)!), db.saves.get(b.save.charId)!);
    expect(ws2.last('joined')!.floor.area).toBe('town');
    await a.room.removePlayer(a.pid);
    ready(a.room);
    a.room.descend(pidB);
    const rp = ws2.last('runPlan')!;
    expect(rp.currentNodeId, 'новый забег — со старта').toBe(rp.plan.startId);
    expect(rp.currentNodeId).not.toBe(fin);
  });

  it('⭐ R3-06: погибший в коопе и отключившийся не платит второй раз — ни за вайп, ни за истечение грейса, ни за «Завершить»', async () => {
    for (const how of ['wipe', 'grace', 'abandon'] as const) {
      const { a, b } = await party(`r306-${how}`);
      kill(a.room, b.pid, b.ws);
      expect(b.ws.last('died')!.toTown, 'кооп: B ждёт пати мёртвым').toBe(false);
      const paid = b.save.gold;
      expect(paid, 'штраф за смерть взят').toBeLessThan(1000);
      await a.room.removePlayer(b.pid);
      if (how === 'wipe') kill(a.room, a.pid, a.ws);
      else if (how === 'grace') (a.room as unknown as { expireGrace(): void }).expireGrace();
      else await a.room.abandonAsDead(b.save.charId);
      await settle();
      expect(db.data.get(b.save.charId)!.gold, `${how}: второй раз не платит`).toBe(paid);
      expect(db.data.get(b.save.charId)!.run, `${how}: забег снят`).toBeUndefined();
    }
  });

  it('⭐ R3-06: мёртвый в коопе, вернувшийся реконнектом, — всё ещё мёртв; оживает со спуском пати', async () => {
    const { a, b } = await party('r306r');
    kill(a.room, b.pid, b.ws);
    await a.room.removePlayer(b.pid);
    const ws2 = new FakeWs();
    const pidB = a.room.reconnect(ws2 as unknown as GameConn, 'user-r306r-b', structuredClone(db.data.get(b.save.charId)!), db.saves.get(b.save.charId)!);
    const w = runOf(a.room).session.world;
    expect(w.players[pidB]!.alive, 'реконнект не воскрешает').toBe(false);
    expect(w.players[pidB]!.hp).toBe(0);
    expect(ws2.last('died')?.toTown, 'клиенту — окно «ждите пати»').toBe(false);
    const cur = nodeNow(a.ws);
    ready(a.room); toExit(a.room, a.pid, cur.edges[0]!.to);
    a.room.descend(a.pid, undefined, cur.edges[0]!.to);
    a.room.castVote(pidB, true);
    expect(nodeNow(a.ws).id).toBe(cur.edges[0]!.to);
    expect(w.players[pidB]!.alive, 'пати спустилась — B ожил').toBe(true);
  });

  // ── R4-16: «тот же этаж» — это тот же ЭКЗЕМПЛЯР этажа, а не та же глубина ────────────────────────────
  it('⭐ R4-16: мёртвый ушёл, пати сходила в город и продолжила ТОТ ЖЕ узел — вернувшийся жив (этаж новый), ложного вайпа нет', async () => {
    const { a, b } = await party('r416');
    kill(a.room, b.pid, b.ws);
    await a.room.removePlayer(b.pid);
    const w = runOf(a.room).session.world;
    const node = nodeNow(a.ws).id;
    ready(a.room);
    w.players[a.pid]!.pos = { ...w.spawn };
    a.room.returnTown(a.pid);
    expect(areaOf(a.room)).toBe('town');
    ready(a.room);
    a.room.descend(a.pid);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(nodeNow(a.ws).id, 'продолжили тот же узел').toBe(node);
    const ws2 = new FakeWs();
    const pidB = a.room.reconnect(ws2 as unknown as GameConn, 'user-r416-b', structuredClone(db.data.get(b.save.charId)!), db.saves.get(b.save.charId)!);
    expect(w.players[pidB]!.alive, 'этаж новый — B жив').toBe(true);
    expect(w.players[pidB]!.hp).toBeGreaterThan(0);
    expect(ws2.last('died'), 'окна смерти нет').toBeUndefined();
    kill(a.room, a.pid, a.ws);
    expect(a.ws.last('died')!.toTown, 'B жив — это не вайп').toBe(false);
    expect(areaOf(a.room)).toBe('dungeon');
    expect(a.save.run, 'забег цел').toBeTruthy();
  });

  it('⭐ R4-16: ушёл на первом узле забега 1, пати закончила его и начала забег 2 (тоже глубина 1) — вернувшийся у входа, а не в точке ухода', async () => {
    const { a, b, down } = await party('r416b');
    const w = runOf(a.room).session.world;
    const left = { x: w.spawn.x + 96, y: w.spawn.y + 64 };
    w.players[b.pid]!.pos = { ...left };
    (w.players[b.pid] as unknown as { combatTimer: number }).combatTimer = 0;   // ушёл не из боя — штрафа за это нет (R4-14)
    await a.room.removePlayer(b.pid);
    for (let g = 0; g < 40 && nodeNow(a.ws).edges.length; g++) down();
    ready(a.room); toExit(a.room, a.pid); a.room.descend(a.pid);
    expect(areaOf(a.room), 'забег 1 закончен').toBe('town');
    ready(a.room); a.room.descend(a.pid);
    expect(nodeNow(a.ws).depth, 'забег 2 — снова глубина 1').toBe(1);
    await settle();
    const ws2 = new FakeWs();
    const pidB = a.room.reconnect(ws2 as unknown as GameConn, 'user-r416b-b', structuredClone(db.data.get(b.save.charId)!), db.saves.get(b.save.charId)!);
    expect(w.players[pidB]!.pos, 'у входа нового этажа').toEqual(w.spawn);
  });

  // ── R4-14: в город из подземелья — только те, кто у портала (или мёртв) ─────────────────────────────
  it('⭐ R4-14: «за» возврат в город засчитывается только у портала или мёртвому — напарник у входа не уводит из боя', async () => {
    const { a, b } = await party('r414');
    const w = runOf(a.room).session.world;
    w.players[b.pid]!.pos = { x: w.spawn.x + 3000, y: w.spawn.y + 3000 };
    w.players[b.pid]!.hp = 1;
    ready(a.room);
    w.players[a.pid]!.pos = { ...w.spawn };
    a.room.returnTown(a.pid);
    a.room.castVote(b.pid, true);
    expect(areaOf(a.room), 'издалека «за» не засчитано').toBe('dungeon');
    expect(b.ws.last('error')?.code).toBe('far');
    expect(b.save.gold, 'без штрафа — просто отказ').toBe(1000);
    w.players[b.pid]!.pos = { x: w.spawn.x + 20, y: w.spawn.y };
    a.room.castVote(b.pid, true);
    expect(areaOf(a.room), 'у портала — можно').toBe('town');
  });

  it('⭐ R4-14: «за», поданное у портала, не уносит из боя того, кто потом отошёл', async () => {
    const { a, b } = await party('r414b');
    const c = addPeer(a.room, 'user-r414b-c');
    const w = runOf(a.room).session.world;
    for (const pid of [a.pid, b.pid, c.pid]) w.players[pid]!.pos = { ...w.spawn };
    ready(a.room);
    a.room.returnTown(a.pid);
    a.room.castVote(b.pid, true);                          // B «за» у портала…
    w.players[b.pid]!.pos = { x: w.spawn.x + 3000, y: w.spawn.y };   // …и ушёл в бой
    a.room.castVote(c.pid, true);                          // последний голос
    expect(areaOf(a.room), 'B уже не у портала — перехода нет').toBe('dungeon');
    expect(b.ws.last('error')?.code).toBe('far');
  });

  it('⭐ R4-14: отключившийся посреди боя живым не выходит в город даром — пати ушла порталом: штраф брошенного забега; у портала — без штрафа', async () => {
    for (const how of ['fight', 'portal'] as const) {
      const { a, b } = await party(`r414c-${how}`);
      const w = runOf(a.room).session.world;
      const pb = w.players[b.pid] as unknown as { pos: Pt; hp: number; combatTimer: number };
      if (how === 'fight') {
        pb.pos = { x: w.spawn.x + 3000, y: w.spawn.y }; pb.hp = 1;
        // R5-11: «в бою» — на него идёт монстр (окно боевого айдла `combatTimer` мерой больше не служит).
        const m = (w as unknown as { monsters: { alive: boolean; pos: Pt; aiState: string }[] }).monsters.find((x) => x.alive)!;
        m.pos = { x: pb.pos.x + 20, y: pb.pos.y }; m.aiState = 'chase';
      } else { pb.pos = { ...w.spawn }; pb.combatTimer = 0; }
      await a.room.removePlayer(b.pid);
      ready(a.room);
      w.players[a.pid]!.pos = { ...w.spawn };
      a.room.returnTown(a.pid);
      expect(areaOf(a.room)).toBe('town');
      await settle();
      const inDb = db.data.get(b.save.charId)!;
      if (how === 'fight') {
        expect(inDb.gold, 'сбежал из боя — штраф').toBeLessThan(1000);
        expect(inDb.run, 'забег снят').toBeUndefined();
      } else {
        expect(inDb.gold, 'ушёл у портала — без штрафа').toBe(1000);
        expect(inDb.run, 'забег припаркован').toBeTruthy();
      }
    }
  });

  it('⭐ R3-17: хозяин вырос в уровне за забег — снаряжение кузницы по новому уровню; доска та же; без роста круги не перекатывают', async () => {
    const { room, ws, pid, save } = makeRoom('user-r317');
    await settle();
    const gearOf = (): Item[] => ws.last('shop')!.items.filter((i) => i.kind !== 'consumable');
    const top = (): number => Math.max(...gearOf().map((i) => i.itemLevel));
    expect(top(), 'новичку — снаряжение первого уровня').toBe(2);
    const board0 = stockOf(room).questBoard.map((q) => q.id).join();
    room.descend(pid);
    save.level = 20;
    ready(room); room.returnTown(pid);
    expect(areaOf(room)).toBe('town');
    expect(top(), 'вернулся двадцатым — снаряжение по уровню хозяина').toBeGreaterThanOrEqual(21);
    expect(stockOf(room).questBoard.map((q) => q.id).join(), 'доска та же').toBe(board0);
    const uids = gearOf().map((i) => i.uid).join();
    ready(room); room.enterArena(pid);
    ready(room); room.returnTown(pid);
    expect(gearOf().map((i) => i.uid).join(), 'уровень не рос — прилавок тот же (R1-03)').toBe(uids);
  });
});

/**
 * ⭐ R4-03: КУЗНЕЦ КУЁТ (решение владельца, 26.09): `balance.craft.live` в данных — `true`. Тесты выше ставят флаг
 * руками в обе стороны; этот — без рук, на конфиге «как в игре»: ковка и зачарование проходят.
 */
describe('Room — ковка открыта в данных (R4-03)', () => {
  it('⭐ без переключения флага: ковка куёт, зачарование зачаровывает', async () => {
    expect(cfg.get('balance').craft.live, 'balance.craft.live в data/balance.json').toBe(true);
    const { room, ws, pid, save, s } = await craftSetup('user-r403-live', 1_000_000);
    await room.handleCmd(pid, craftCmd('r403-live-0001', s.input), 1);
    const r = ws.last('cmdResult')!;
    expect(r, JSON.stringify(r)).toMatchObject({ id: 1, cmd: 'craft', ok: true });
    expect(save.inventory.some((i) => i.uid === r.uid)).toBe(true);
    limits.forgeCmd.reset(userOf(pid));
    await room.handleCmd(pid, { cmd: 'forgeEnchant', uid: r.uid!, rarity: 'magic' }, 2);
    expect(ws.last('cmdResult'), JSON.stringify(ws.last('cmdResult'))).toMatchObject({ id: 2, cmd: 'forgeEnchant', ok: true });
  });
});

/**
 * ⭐ R4-01: ПРОДОЛЖЕНИЕ ЗАБЕГА — ТОТ ЖЕ УЗЕЛ, А НЕ СВЕЖИЙ. Узел пересобирается из сида на каждое продолжение, и раньше
 * вместе с ним вставали сундуки (гарантированная целая вещь), боссы и уники: «в город → спуск продолжает узел» по кругу
 * фармил их без конца — и модифицированным клиентом, и честным через портал входа. Теперь узел помнит, что на нём
 * взято: открытые сундуки, убитые монстры, дёрнутые рычаги — в сейве каждого участника (`save.run.node`).
 * И в город из подземелья — только от портала (входа или портала узла), как это и предлагает клиент.
 */
describe('Room — раунд 4: узел забега не фармится возвратом (R4-01)', () => {
  type MonIn = { id: number; alive: boolean; hp: number; pos: Pt; debuffs: Record<string, unknown>; dotBy?: Record<string, string>; def: { id: string; rarity: string; level: number } };
  type NodeWorld = {
    spawn: Pt; monsters: MonIn[]; drops: { kind: string; item?: Item }[];
    chests: { id: number; pos: Pt; opened: boolean }[];
    levers: { id: number; pos: Pt; used: boolean; doorId: number }[];
    doors: { id: number; cells: { cx: number; cy: number }[] }[];
    grid: number[][];
    players: Record<string, { pos: Pt; alive: boolean }>;
  };
  const wOf = (room: Room): NodeWorld => (room as unknown as { session: { world: NodeWorld } }).session.world;
  const nodeNow = (ws: FakeWs): RunNode => { const rp = ws.last('runPlan')!; return nodeOf(rp.plan, rp.currentNodeId); };
  const standAt = (room: Room, pid: string, at: Pt): void => { wOf(room).players[pid]!.pos = { x: at.x, y: at.y }; };
  /** Подпись монстра заселения — что и где стоит (id сущности — сквозной счётчик мира, по нему не сравнить). */
  const sig = (m: MonIn): string => `${m.def.id}/${m.def.rarity}/${m.def.level}@${Math.round(m.pos.x)},${Math.round(m.pos.y)}`;
  const aliveSigs = (room: Room): string[] => wOf(room).monsters.filter((m) => m.alive).map(sig).sort();
  /**
   * Заселение без убитых — разность МУЛЬТИМНОЖЕСТВ: подпись не уникальна (члены пачки встают на клетку вожака — два
   * одинаковых зомби в одной точке). Фильтр «подписи нет среди убитых» выбрасывал и живого близнеца убитого, и тест
   * падал на случайном сиде (~1 из 30): «лишний» зомби, которого на деле никто не воскрешал.
   */
  const withoutKilled = (all: readonly string[], killed: readonly string[]): string[] => {
    const out = [...all];
    for (const k of killed) { const i = out.indexOf(k); if (i >= 0) out.splice(i, 1); }
    return out;
  };
  /** Сколько раз подпись встречается в списке. */
  const countSig = (list: readonly string[], s: string): number => list.filter((x) => x === s).length;
  const itemDrops = (room: Room): number => wOf(room).drops.filter((d) => d.kind === 'item').length;
  /**
   * Убить монстров САМОЙ СИМУЛЯЦИЕЙ (смертельный DoT, как у игроков в тестах вайпа): смерть, награды, событие и запись узла —
   * тем же путём, что в бою. Яд — первого игрока комнаты (R5-06: добитое статусом засчитывается тому, кто его повесил;
   * ничей яд — смерть без наград). Возвращает подписи убитых.
   */
  function slay(room: Room, pick: (m: MonIn) => boolean): string[] {
    const doomed = wOf(room).monsters.filter((m) => m.alive && pick(m));
    const by = Object.keys(wOf(room).players)[0]!;
    for (const m of doomed) { m.hp = 1; m.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: Date.now() + 60_000, mag: 9999, mag2: 0 }; m.dotBy = { poison: by }; }
    for (let i = 0; i < 10 && doomed.some((m) => m.alive); i++) room.step(false);
    expect(doomed.every((m) => !m.alive), 'выбранные монстры убиты').toBe(true);
    return doomed.map(sig);
  }
  /** В город — от портала входа, как честный клиент. */
  function toTown(room: Room, pid: string): void {
    ready(room);
    standAt(room, pid, wOf(room).spawn);
    room.returnTown(pid);
    expect(areaOf(room), 'вышли в город').toBe('town');
  }
  /** Спуск из города — продолжение припаркованного забега (R9-01: после чтения свода забега из базы). */
  async function resume(room: Room, pid: string): Promise<void> {
    ready(room);
    room.descend(pid);
    await drained();
    expect(areaOf(room), 'спустились').toBe('dungeon');
  }
  /** Спуск по первому ребру (у его выхода), пока узел не подойдёт; `null` — дошли до финала, не найдя. */
  function diveUntil(room: Room, ws: FakeWs, pid: string, want: () => boolean, vote?: () => void): RunNode | null {
    for (let g = 0; g < 40; g++) {
      if (want()) return nodeNow(ws);
      const cur = nodeNow(ws);
      if (!cur.edges.length) return null;
      ready(room);
      toExit(room, pid, cur.edges[0]!.to);
      room.descend(pid, undefined, cur.edges[0]!.to);
      vote?.();
    }
    return null;
  }

  it('⭐ открытый сундук остаётся открытым: возврат и продолжение не дают второй вещи — ни командой, ни по [E]', async () => {
    const { room, ws, pid, save } = makeRoom('user-r401-chest');
    room.descend(pid);
    const node = nodeNow(ws).id;
    const all = wOf(room).chests.map((c) => c.id);
    expect(all.length, 'на узле есть сундуки').toBeGreaterThan(0);
    const chest = wOf(room).chests[0]!;
    standAt(room, pid, chest.pos);
    room.openChest(pid, chest.id);
    expect(chest.opened).toBe(true);
    expect(itemDrops(room), 'сундук высыпал добычу').toBeGreaterThan(0);
    // Команда пришла между тиками — событие обязано уйти всем сразу, а не лечь в разосланный буфер прошлого тика.
    const opened = ws.frames.some((f) => f.t === 'events' && f.events.some((e) => e.type === 'chest-opened' && e.id === chest.id));
    expect(opened, 'клиенту ушло событие «сундук открыт»').toBe(true);
    expect(save.run?.node?.chests, 'сундук записан в забег').toContain(chest.id);

    toTown(room, pid);
    await settle();
    expect(db.data.get(save.charId)?.run?.node?.chests, 'и в базу — с возвратом в город').toContain(chest.id);
    await resume(room, pid);
    expect(nodeNow(ws).id, 'продолжили тот же узел').toBe(node);
    expect(ws.last('areaChanged')!.floor.chests.map((c) => c.id), 'открытый сундук клиенту не приходит').not.toContain(chest.id);
    expect(wOf(room).chests.map((c) => c.id).sort(), 'сундуки узла те же').toEqual([...all].sort());
    const again = wOf(room).chests.find((c) => c.id === chest.id)!;
    expect(again.opened, 'сундук открыт и после продолжения').toBe(true);
    expect(wOf(room).chests.filter((c) => !c.opened).length, 'остальные — целы').toBe(all.length - 1);

    standAt(room, pid, again.pos);
    room.openChest(pid, chest.id);
    room.setInput(pid, { ...idle, interact: true });
    room.step(false);
    room.setInput(pid, idle);
    expect(itemDrops(room), 'второй добычи нет ни командой, ни по [E]').toBe(0);
    expect(save.run?.node?.chests.filter((id) => id === chest.id), 'запись без повторов').toHaveLength(1);
  });

  it('⭐ убитые уник и босс не встают: продолжение узла — без них, и повтор круга награды не даёт', async () => {
    let tried = 0;
    for (const templateId of ['dungeon-standard', 'deep-expedition']) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { room, ws, pid, save } = makeRoom('user-r401-boss');
        room.descend(pid, undefined, undefined, { templateId });
        const hasUnique = (): boolean => wOf(room).monsters.some((m) => m.alive && m.def.rarity === 'unique');
        if (!diveUntil(room, ws, pid, hasUnique)) continue;
        tried++;
        const node = nodeNow(ws).id;
        const before = aliveSigs(room);
        const dead = slay(room, (m) => m.def.rarity === 'unique');
        expect(dead.length).toBeGreaterThan(0);
        expect(save.run?.node?.killed.length, 'убитые записаны номерами заселения').toBe(dead.length);
        for (let loop = 0; loop < 3; loop++) {
          toTown(room, pid);
          const xp0 = save.xp, drops0 = itemDrops(room);
          await resume(room, pid);
          expect(nodeNow(ws).id).toBe(node);
          expect(hasUnique(), `круг ${loop + 1}: уник/босс не встал`).toBe(false);
          expect(aliveSigs(room), 'живые — ровно те же, что были, без убитых').toEqual(withoutKilled(before, dead));
          room.step(false);
          expect(save.xp, 'опыта за убитых второй раз нет').toBe(xp0);
          expect(itemDrops(room), 'добычи за убитых второй раз нет').toBe(drops0);
        }
        return;
      }
    }
    expect(tried, 'встретился узел с уником или боссом').toBeGreaterThan(0);
  });

  it('⭐ честное продолжение: живые монстры и целые сундуки на месте, заселение то же при выросшем герое, дальше — свежий узел', async () => {
    const { room, ws, pid, save } = makeRoom('user-r401-honest');
    room.descend(pid);
    const node = nodeNow(ws);
    expect(node.edges.length, 'со старта есть куда идти').toBeGreaterThan(0);
    const first = aliveSigs(room);
    const chests0 = wOf(room).chests.map((c) => c.id).sort();
    const victim = wOf(room).monsters.find((m) => m.alive)!;
    const dead = slay(room, (m) => m === victim);
    toTown(room, pid);
    // Герой вырос в городе — узел заселяется ровно так же, как на первом входе (мощь узла записана с ним).
    save.level = 40;
    await resume(room, pid);
    expect(nodeNow(ws).id).toBe(node.id);
    expect(aliveSigs(room), 'заселение то же, минус убитый').toEqual(withoutKilled(first, dead));
    expect(wOf(room).chests.filter((c) => !c.opened).map((c) => c.id).sort(), 'сундуки целы').toEqual(chests0);
    // Живого монстра по-прежнему можно убить — и это тоже запишется.
    const more = slay(room, (m) => m.alive);
    expect(save.run?.node?.killed.length).toBe(dead.length + more.length);
    // Дальше по графу — новый узел с чистого листа.
    ready(room);
    toExit(room, pid, node.edges[0]!.to);
    room.descend(pid, undefined, node.edges[0]!.to);
    expect(nodeNow(ws).id).toBe(node.edges[0]!.to);
    expect(save.run?.node, 'запись нового узла').toMatchObject({ id: node.edges[0]!.to, chests: [], killed: [], levers: [] });
    expect(wOf(room).chests.every((c) => !c.opened), 'новый узел — свои целые сундуки').toBe(true);
  });

  it('⭐ вышел из игры в городе, «Продолжить» — новая комната из сейва базы: узел тот же и как его оставили', async () => {
    const { room, ws, pid, save } = makeRoom('user-r401-relog');
    room.descend(pid);
    const node = nodeNow(ws).id;
    const chest = wOf(room).chests[0]!;
    standAt(room, pid, chest.pos);
    room.openChest(pid, chest.id);
    const before = aliveSigs(room);
    const dead = slay(room, (m) => m.def.rarity !== 'normal');
    const left = withoutKilled(before, dead);
    toTown(room, pid);
    await room.removePlayer(pid);                           // из города — чистый выход, комнаты больше нет
    await settle();
    const fromDb = structuredClone(db.data.get(save.charId)!);
    expect(fromDb.run?.node?.chests).toContain(chest.id);
    const fresh = new RoomCtor('TEST2', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(fresh);
    const ws2 = new FakeWs();
    fresh.addPlayerResumeRun(ws2 as unknown as GameConn, 'user-r401-relog', fromDb, db.saves.get(save.charId)!);
    expect(ws2.last('runPlan')!.currentNodeId, 'продолжение — тот же узел').toBe(node);
    expect(wOf(fresh).chests.find((c) => c.id === chest.id)?.opened, 'сундук открыт').toBe(true);
    expect(aliveSigs(fresh), 'живые — те же, убитые не встали').toEqual(left);
    expect(dead.every((d) => countSig(aliveSigs(fresh), d) === countSig(left, d)), 'убитые не встали (близнецы в пачке — живы)').toBe(true);
  });

  it('дёрнутый рычаг остаётся дёрнутым: дверь открыта и после продолжения', async () => {
    let seen = 0;
    for (let attempt = 0; attempt < 8 && !seen; attempt++) {
      const { room, ws, pid, save } = makeRoom('user-r401-lever');
      room.descend(pid, undefined, undefined, { templateId: 'deep-expedition' });
      if (!diveUntil(room, ws, pid, () => wOf(room).levers.length > 0)) continue;
      seen++;
      const lever = wOf(room).levers[0]!;
      const door = wOf(room).doors.find((d) => d.id === lever.doorId)!;
      standAt(room, pid, lever.pos);
      room.pullLever(pid, lever.id);
      expect(ws.last('doorOpened')?.doorId).toBe(door.id);
      expect(save.run?.node?.levers).toContain(lever.id);
      toTown(room, pid);
      await resume(room, pid);
      const floor = ws.last('areaChanged')!.floor;
      expect(floor.levers.map((l) => l.id), 'рычаг не предлагается снова').not.toContain(lever.id);
      expect(floor.doors.map((d) => d.id), 'дверь не рисуется запертой').not.toContain(door.id);
      for (const c of door.cells) expect(floor.grid[c.cy]![c.cx], 'проход открыт').toBe(Cell.Floor);
      expect(wOf(room).levers.find((l) => l.id === lever.id)?.used).toBe(true);
    }
    expect(seen, 'встретился узел с рычагом').toBe(1);
  });

  it('⭐ кооп: взятое любым участником не встаёт ни у хозяина, ни у соседа, ставшего хозяином', async () => {
    const a = makeRoom('user-r401-coop-a');
    const b = addPeer(a.room, 'user-r401-coop-b');
    await settle();
    a.room.descend(a.pid);
    a.room.castVote(b.pid, true);
    const node = nodeNow(a.ws).id;
    const chest = wOf(a.room).chests[0]!;
    standAt(a.room, b.pid, chest.pos);
    a.room.openChest(b.pid, chest.id);                      // открыл СОСЕД
    const dead = slay(a.room, (m) => m.alive);              // хозяин (и пати) зачистили узел
    expect(dead.length).toBeGreaterThan(0);
    for (const s of [a.save, b.save]) {
      expect(s.run?.node?.chests, 'запись — у каждого участника').toContain(chest.id);
      expect(s.run?.node?.killed).toHaveLength(dead.length);
    }
    ready(a.room);
    standAt(a.room, a.pid, wOf(a.room).spawn);
    standAt(a.room, b.pid, wOf(a.room).spawn);              // R4-14: «за» уход в город — тоже у портала
    a.room.returnTown(a.pid);
    a.room.castVote(b.pid, true);
    expect(areaOf(a.room)).toBe('town');
    await a.room.removePlayer(a.pid);                       // хозяин ушёл — хозяином стал сосед
    await resume(a.room, b.pid);
    expect(nodeNow(b.ws).id, 'сосед продолжил тот же узел').toBe(node);
    expect(wOf(a.room).chests.find((c) => c.id === chest.id)?.opened, 'сундук открыт').toBe(true);
    expect(wOf(a.room).monsters.filter((m) => m.alive), 'зачищенный узел пуст').toHaveLength(0);
  });

  it('⭐ кооп: отвалившийся в подземелье и вернувшийся из базы получает запись узла комнаты — его продолжение не свежее', async () => {
    const a = makeRoom('user-r401-grace-a');
    const b = addPeer(a.room, 'user-r401-grace-b');
    await settle();
    a.room.descend(a.pid);
    a.room.castVote(b.pid, true);
    const node = nodeNow(a.ws).id;
    await a.room.removePlayer(b.pid);                       // B закрыл вкладку в подземелье → грейс, в базе — узел без сундука
    await settle();
    const chest = wOf(a.room).chests[0]!;
    standAt(a.room, a.pid, chest.pos);
    a.room.openChest(a.pid, chest.id);
    const dead = slay(a.room, (m) => m.alive);
    toTown(a.room, a.pid);
    await a.room.removePlayer(a.pid);                       // A ушёл из города; комната ждёт B
    await settle();
    const fromDb = structuredClone(db.data.get(b.save.charId)!);
    expect(fromDb.run?.currentNodeId).toBe(node);
    expect(fromDb.run?.node?.chests ?? [], 'в базе у B — узел без сундука').not.toContain(chest.id);
    const ws2 = new FakeWs();
    const pidB = a.room.reconnect(ws2 as unknown as GameConn, 'user-r401-grace-b', fromDb, db.saves.get(b.save.charId)!);
    ready(a.room);
    a.room.descend(pidB);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(ws2.last('runPlan')!.currentNodeId).toBe(node);
    expect(wOf(a.room).chests.find((c) => c.id === chest.id)?.opened, 'сундук, открытый без B, открыт и для B').toBe(true);
    expect(wOf(a.room).monsters.filter((m) => m.alive).length, 'убитые без B не встали').toBe(0);
    expect(dead.length).toBeGreaterThan(0);
  });

  it('⭐ кооп: вернувшийся реконнектом, пока пати ушла дальше, — на узле пати, а не на старом: пройденное им заново не встаёт', async () => {
    const a = makeRoom('user-r401-behind-a');
    const b = addPeer(a.room, 'user-r401-behind-b');
    await settle();
    a.room.descend(a.pid);
    a.room.castVote(b.pid, true);
    const x = nodeNow(a.ws);
    expect(x.edges.length).toBeGreaterThan(0);
    await a.room.removePlayer(b.pid);                       // B отвалился на X: в базе у B — X без взятого
    await settle();
    const chest = wOf(a.room).chests[0]!;
    standAt(a.room, a.pid, chest.pos);
    a.room.openChest(a.pid, chest.id);
    slay(a.room, (m) => m.alive);                           // A зачистил X
    ready(a.room); toExit(a.room, a.pid, x.edges[0]!.to);
    a.room.descend(a.pid, undefined, x.edges[0]!.to);       // и ушёл на Y (B в грейсе — голосует один A)
    const y = nodeNow(a.ws).id;
    expect(y).not.toBe(x.id);
    const ws2 = new FakeWs();
    const fromDb = structuredClone(db.data.get(b.save.charId)!);
    expect(fromDb.run?.currentNodeId, 'в базе у B — старый узел').toBe(x.id);
    const pidB = a.room.reconnect(ws2 as unknown as GameConn, 'user-r401-behind-b', fromDb, db.saves.get(b.save.charId)!);
    const saveB = runOf(a.room).session.world.players[pidB] as unknown as { save: SaveState };
    expect(saveB.save.run?.currentNodeId, 'B — на узле пати').toBe(y);
    expect(saveB.save.run?.node?.id).toBe(y);
    // Пати в город; A уходит — хозяином становится B, и его продолжение — узел пати, а не пройденный X заново.
    ready(a.room); standAt(a.room, a.pid, wOf(a.room).spawn);
    a.room.returnTown(a.pid);
    a.room.castVote(pidB, true);
    expect(areaOf(a.room)).toBe('town');
    await a.room.removePlayer(a.pid);
    ready(a.room);
    a.room.descend(pidB);
    expect(ws2.last('runPlan')!.currentNodeId, 'продолжение — узел пати').toBe(y);
  });

  it('⭐ в город из подземелья — только от портала: издалека «far» без голосования; от портала входа и портала узла — можно', () => {
    const { room, ws, pid } = makeRoom('user-r401-portal');
    room.descend(pid);
    const w = wOf(room);
    const votes0 = countOf(ws, 'voteStart');
    for (let i = 0; i < 3; i++) {
      ready(room);
      standAt(room, pid, { x: w.spawn.x + 5000, y: w.spawn.y + 5000 });
      room.returnTown(pid);
    }
    expect(countOf(ws, 'voteStart') - votes0, 'голосования не было').toBe(0);
    expect(ws.last('error')?.code).toBe('far');
    expect(areaOf(room), 'остались в подземелье').toBe('dungeon');
    // У портала входа — с тем же запасом на отставание позиции, что и спуск.
    ready(room);
    standAt(room, pid, { x: w.spawn.x + 40, y: w.spawn.y });
    room.returnTown(pid);
    expect(areaOf(room), 'от портала входа — в город').toBe('town');

    // Портал узла — тоже выход в город (на финале он далеко от входа: проверяем именно его).
    const r = makeRoom('user-r401-portal2');
    r.room.descend(r.pid, undefined, undefined, { templateId: 'crypt-short' });
    expect(diveUntil(r.room, r.ws, r.pid, () => nodeNow(r.ws).edges.length === 0), 'дошли до финала').not.toBeNull();
    const portal = runOf(r.room).decor.find((d) => d.kind === 'portal')!;
    expect(Math.hypot(portal.x - wOf(r.room).spawn.x, portal.y - wOf(r.room).spawn.y), 'портал финала — не у входа').toBeGreaterThan(128);
    ready(r.room);
    standAt(r.room, r.pid, { x: portal.x + 30, y: portal.y });
    r.room.returnTown(r.pid);
    expect(areaOf(r.room), 'от портала узла — в город').toBe('town');
    expect(r.save.run?.currentNodeId, 'в город — не конец забега').toBe(nodeNow(r.ws).id);
  });

  // ── R4-04: указатель забега не отматывается назад ─────────────────────────────────────────────────
  const hooks = { onEmpty() {}, onGrace() {}, onUngrace() {} };
  /** Сейв героя из «базы» — как его прочитал бы вход (копия и версия). */
  const fromDb = (charId: string): { save: SaveState; v: number } => ({ save: structuredClone(db.data.get(charId)!), v: db.saves.get(charId)! });
  const playerSave = (room: Room, pid: string): SaveState => (runOf(room).session.world.players[pid] as unknown as { save: SaveState }).save;
  /**
   * D и B паркуют забег в городе комнаты D на стартовом узле X; B уходит и в одиночку («Продолжить» — новая комната из
   * базы) спускается на Y, открывает сундук и зачищает узел, возвращается в город и выходит. В базе у B — Y с записью.
   */
  async function aheadOfRoom(tag: string) {
    const d = makeRoom(`user-${tag}-d`);
    const b = addPeer(d.room, `user-${tag}-b`);
    await settle();
    d.room.descend(d.pid);
    d.room.castVote(b.pid, true);
    const x = nodeNow(d.ws);
    expect(x.edges.length, 'с X есть куда спускаться').toBeGreaterThan(0);
    ready(d.room);
    standAt(d.room, d.pid, wOf(d.room).spawn);
    standAt(d.room, b.pid, wOf(d.room).spawn);
    d.room.returnTown(d.pid);
    d.room.castVote(b.pid, true);
    expect(areaOf(d.room), 'пати в городе, забег припаркован у X').toBe('town');
    await d.room.removePlayer(b.pid);
    await settle();
    const charB = b.save.charId;
    const solo = new RoomCtor(`R404-${tag}`, cfg, hooks);
    rooms.push(solo);
    const ws = new FakeWs();
    const j = fromDb(charB);
    const pid = solo.addPlayerResumeRun(ws as unknown as GameConn, `user-${tag}-b`, j.save, j.v);
    expect(nodeNow(ws).id).toBe(x.id);
    ready(solo);
    toExit(solo, pid, x.edges[0]!.to);
    solo.descend(pid, undefined, x.edges[0]!.to);
    const y = nodeNow(ws).id;
    expect(y).toBe(x.edges[0]!.to);
    const chest = wOf(solo).chests[0]!;
    expect(chest.opened, 'Y свежий — сундук цел').toBe(false);
    standAt(solo, pid, chest.pos);
    solo.openChest(pid, chest.id);
    slay(solo, (m) => m.alive);
    toTown(solo, pid);
    await solo.removePlayer(pid);
    await settle();
    expect(db.data.get(charB)!.run?.currentNodeId, 'в базе у B — Y').toBe(y);
    return { d, charB, userB: `user-${tag}-b`, x, y, chestId: chest.id };
  }

  it('⭐ R4-04: вошедший по коду ВПЕРЕДИ комнаты не отматывается назад — узел, взятый им в одиночку, не встаёт по кругу', async () => {
    const { d, charB, userB, x, y, chestId } = await aheadOfRoom('r404-join');
    for (let loop = 0; loop < 3; loop++) {
      // B входит по коду в комнату D (стоит у X) и сразу выходит.
      const ws3 = new FakeWs();
      const j = fromDb(charB);
      const pid3 = d.room.addPlayer(ws3 as unknown as GameConn, userB, j.save, j.v);
      expect(playerSave(d.room, pid3).run?.currentNodeId, `круг ${loop}: указатель B не отмотан к X`).toBe(y);
      await d.room.removePlayer(pid3);
      await settle();
      expect(db.data.get(charB)!.run?.currentNodeId, `круг ${loop}: в базе у B — по-прежнему Y`).toBe(y);
      // «Продолжить»: новая комната из базы — и если указатель всё же у X, спуск на Y.
      const r2 = new RoomCtor(`R404-loop-${loop}`, cfg, hooks);
      rooms.push(r2);
      const ws2 = new FakeWs();
      const k = fromDb(charB);
      const pid2 = r2.addPlayerResumeRun(ws2 as unknown as GameConn, userB, k.save, k.v);
      if (nodeNow(ws2).id === x.id) {
        ready(r2);
        toExit(r2, pid2, y);
        r2.descend(pid2, undefined, y);
      }
      expect(nodeNow(ws2).id).toBe(y);
      const xp0 = playerSave(r2, pid2).xp;
      expect(wOf(r2).chests.find((c) => c.id === chestId)?.opened, `круг ${loop}: сундук Y открыт`).toBe(true);
      expect(wOf(r2).monsters.filter((m) => m.alive), `круг ${loop}: зачищенный Y пуст`).toHaveLength(0);
      standAt(r2, pid2, wOf(r2).chests.find((c) => c.id === chestId)!.pos);
      r2.openChest(pid2, chestId);
      r2.step(false);
      expect(itemDrops(r2), `круг ${loop}: добычи нет`).toBe(0);
      expect(playerSave(r2, pid2).xp, `круг ${loop}: опыта нет`).toBe(xp0);
      toTown(r2, pid2);
      await r2.removePlayer(pid2);
      await settle();
    }
  });

  it('⭐ R4-04: продолжение из города — с САМОГО ГЛУБОКОГО указателя пати: хозяин не тянет ушедшего вперёд назад', async () => {
    const { d, charB, userB, y, chestId } = await aheadOfRoom('r404-host');
    const ws3 = new FakeWs();
    const j = fromDb(charB);
    const pidB = d.room.addPlayer(ws3 as unknown as GameConn, userB, j.save, j.v);
    ready(d.room);
    d.room.descend(d.pid);                                  // хозяин D (указатель X) зовёт спуск
    d.room.castVote(pidB, true);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(areaOf(d.room)).toBe('dungeon');
    expect(nodeNow(d.ws).id, 'продолжили с Y — самого глубокого указателя').toBe(y);
    expect(playerSave(d.room, pidB).run?.currentNodeId, 'B не отмотан').toBe(y);
    expect(d.save.run?.currentNodeId, 'D подтянут вперёд').toBe(y);
    expect(wOf(d.room).chests.find((c) => c.id === chestId)?.opened, 'сундук Y открыт').toBe(true);
    expect(wOf(d.room).monsters.filter((m) => m.alive), 'Y зачищен').toHaveLength(0);
  });

  it('⭐ R4-04: запись есть у КАЖДОГО пройденного узла — даже отмотанный указатель не даёт узел свежим; пройденный без записи (старый сейв) — взят целиком', async () => {
    const { room, ws, pid, save } = makeRoom('user-r404-ledger');
    room.descend(pid);
    const x = nodeNow(ws);
    const y = x.edges[0]!.to;
    ready(room); toExit(room, pid, y); room.descend(pid, undefined, y);
    const chest = wOf(room).chests[0]!;
    standAt(room, pid, chest.pos);
    room.openChest(pid, chest.id);
    const dead = slay(room, (m) => m.alive);
    expect(dead.length).toBeGreaterThan(0);
    toTown(room, pid);
    await settle();
    const parked = structuredClone(save.run!);
    expect(parked.currentNodeId).toBe(y);
    for (const how of ['rewound', 'legacy'] as const) {
      // Сейв отмотан к X (как сделал бы старый `attach`); у «старого» — ещё и без записей пройденных узлов.
      const s = structuredClone(save);
      s.run = { ...structuredClone(parked), currentNodeId: x.id };
      if (how === 'legacy') { delete (s.run as { nodes?: unknown }).nodes; delete s.run.node; }
      else (s.run as { nodes?: unknown }).nodes = [structuredClone(parked.node!)];
      if (how === 'rewound') delete s.run.node;
      const r2 = new RoomCtor(`R404-${how}`, cfg, hooks);
      rooms.push(r2);
      const ws2 = new FakeWs();
      const pid2 = r2.addPlayerResumeRun(ws2 as unknown as GameConn, 'user-r404-ledger', s, db.saves.get(save.charId)!);
      expect(nodeNow(ws2).id, how).toBe(x.id);
      ready(r2); toExit(r2, pid2, y); r2.descend(pid2, undefined, y);
      expect(nodeNow(ws2).id).toBe(y);
      if (how === 'rewound') expect(wOf(r2).chests.find((c) => c.id === chest.id)?.opened, 'сундук Y открыт по записи').toBe(true);
      else expect(wOf(r2).chests.every((c) => c.opened), 'старый сейв: пройденный узел без записи — сундуки взяты').toBe(true);
      expect(wOf(r2).monsters.filter((m) => m.alive).length, `${how}: убитые не встали`).toBe(0);
    }
  });

  // ── R4-25: чужой припаркованный забег не подменяется молча ─────────────────────────────────────────
  it('⭐ R4-25: герой с припаркованным забегом у хозяина БЕЗ забега — спуск продолжает ЕГО забег, а не подменяет его новым', async () => {
    const f = makeRoom('user-r425-f');
    f.save.gold = 1000;
    f.room.descend(f.pid);
    const n = nodeNow(f.ws).id;
    toTown(f.room, f.pid);
    await f.room.removePlayer(f.pid);
    await settle();
    const runF = structuredClone(db.data.get(f.save.charId)!.run!);
    const h = makeRoom('user-r425-h');
    const ws = new FakeWs();
    const j = fromDb(f.save.charId);
    const pidF = h.room.addPlayer(ws as unknown as GameConn, 'user-r425-f', j.save, j.v);
    ready(h.room);
    h.room.descend(h.pid);
    h.room.castVote(pidF, true);
    const now = playerSave(h.room, pidF);
    expect(now.run?.config.seed, 'забег F не подменён').toBe(runF.config.seed);
    expect(now.run?.currentNodeId).toBe(n);
    expect(now.gold, 'штрафа нет').toBe(1000);
  });

  it('⭐ R4-25: у хозяина СВОЙ забег — «за» героя с другим припаркованным забегом не засчитывается: забег F цел, спуска нет', async () => {
    const f = makeRoom('user-r425b-f');
    f.save.gold = 1000;
    f.room.descend(f.pid);
    toTown(f.room, f.pid);
    await f.room.removePlayer(f.pid);
    await settle();
    const runF = JSON.stringify(db.data.get(f.save.charId)!.run);
    const h = makeRoom('user-r425b-h');
    h.room.descend(h.pid);
    toTown(h.room, h.pid);                                 // у H свой припаркованный забег
    const ws = new FakeWs();
    const j = fromDb(f.save.charId);
    const pidF = h.room.addPlayer(ws as unknown as GameConn, 'user-r425b-f', j.save, j.v);
    ready(h.room);
    h.room.descend(h.pid);
    h.room.castVote(pidF, true);
    expect(areaOf(h.room), 'спуска нет').toBe('town');
    expect(ws.last('error')?.code, 'F объяснили').toBe('run');
    expect(JSON.stringify(playerSave(h.room, pidF).run), 'забег F цел').toBe(runF);
    expect(playerSave(h.room, pidF).gold).toBe(1000);
    // И в подземелье: F пришёл к H, когда тот уже внизу, — спуск по ребру без него не пройдёт через его «за».
    ready(h.room); h.room.castVote(pidF, false);
    await h.room.removePlayer(pidF);
    ready(h.room); h.room.descend(h.pid);
    await drained();   // R9-01: продолжение из города — после чтения свода забега из базы
    expect(areaOf(h.room)).toBe('dungeon');
    const ws2 = new FakeWs();
    const k = fromDb(f.save.charId);
    const pidF2 = h.room.addPlayer(ws2 as unknown as GameConn, 'user-r425b-f', k.save, k.v);
    const cur = nodeNow(h.ws);
    ready(h.room); toExit(h.room, h.pid, cur.edges[0]!.to);
    h.room.descend(h.pid, undefined, cur.edges[0]!.to);
    h.room.castVote(pidF2, true);
    expect(nodeNow(h.ws).id, 'спуска нет').toBe(cur.id);
    expect(ws2.last('error')?.code).toBe('run');
    expect(JSON.stringify(playerSave(h.room, pidF2).run), 'забег F цел и в подземелье').toBe(runF);
  });
});

describe('Room — раунд 4: город безопасен (R4-09)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  type PIn = { hp: number; alive: boolean; debuffs: Parameters<typeof addDebuffStack>[0] };
  const sessionOf = (room: Room) => (room as unknown as { session: { world: { timeMs: number; players: Record<string, PIn> } } }).session;
  /** 5 HP и кровотечение, которое убивает за доли секунды. */
  const lethal = (room: Room, pid: string): void => {
    const s = sessionOf(room);
    const p = s.world.players[pid]!;
    p.hp = 5;
    addDebuffStack(p.debuffs, { kind: 'bleed', chance: 1, mag: 40, maxStacks: 5, durationMs: 4000 }, s.world.timeMs);
  };

  it('⭐ из арены с чужим кровотечением — в город: жив, золото на месте, окна смерти нет', async () => {
    const a = makeRoom('user-r409a');
    const b = addPeer(a.room, 'user-r409b');
    await settle();
    ready(a.room); a.room.enterArena(a.pid); a.room.castVote(b.pid, true);
    expect(areaOf(a.room)).toBe('arena');
    b.save.gold = 1000;
    lethal(a.room, b.pid);
    ready(a.room); a.room.returnTown(a.pid); a.room.castVote(b.pid, true);
    expect(areaOf(a.room)).toBe('town');
    const died0 = countOf(b.ws, 'died');
    for (let i = 0; i < 90; i++) a.room.step(false);
    expect(sessionOf(a.room).world.players[b.pid]!.alive, 'в городе не умирают').toBe(true);
    expect(countOf(b.ws, 'died'), 'окна смерти нет').toBe(died0);
    expect(b.save.gold, 'штрафа нет').toBe(1000);
  });

  it('⭐ соло: вернулся порталом с кровотечением — жив, забег не стёрт', async () => {
    const { room, ws, pid, save } = makeRoom('user-r409s');
    await settle();
    room.descend(pid);
    expect(areaOf(room)).toBe('dungeon');
    lethal(room, pid);
    ready(room); room.returnTown(pid);
    expect(areaOf(room)).toBe('town');
    const run0 = JSON.stringify(save.run);
    expect(save.run, 'забег припаркован').toBeTruthy();
    for (let i = 0; i < 90; i++) room.step(false);
    expect(sessionOf(room).world.players[pid]!.alive).toBe(true);
    expect(ws.last('died'), 'окна смерти нет').toBeUndefined();
    expect(JSON.stringify(save.run), 'забег цел — есть куда вернуться').toBe(run0);
  });
});

describe('Room — раунд 4: ввод, зелья, квесты (R4-19, R4-20, R4-26, R4-35)', () => {
  type PIn = { pos: Pt; vel: Pt; hp: number; alive: boolean; stunTimer: number; stamina: number; dodgeCd: number };
  const pOf = (room: Room, pid: string): PIn => (room as unknown as { session: { world: { players: Record<string, PIn> } } }).session.world.players[pid]!;
  const dodges = (ws: FakeWs): number => ws.frames.filter((f) => f.t === 'events')
    .reduce((n, f) => n + (f as Extract<ServerFrame, { t: 'events' }>).events.filter((e) => e.type === 'dodge').length, 0);

  it('⭐ R4-19: нажатие, ещё не увиденное тиком, следующий кадр не стирает — рывок ровно один', async () => {
    const { room, ws, pid } = makeRoom('user-r419');
    room.descend(pid);
    await settle();
    room.step(false);
    const p = pOf(room, pid);
    p.stamina = 100; p.dodgeCd = 0;
    const d0 = dodges(ws);
    room.setInput(pid, { ...idle, move: { x: 1, y: 0 }, dodge: true });    // кадр нажатия пробела…
    room.setInput(pid, { ...idle, move: { x: 1, y: 0 }, dodge: false });   // …и следующий кадр раньше тика
    room.step(false);
    expect(dodges(ws) - d0, 'рывок состоялся').toBe(1);
    p.dodgeCd = 0; p.stamina = 100;
    for (let i = 0; i < 5; i++) room.step(false);
    expect(dodges(ws) - d0, 'одно нажатие — один рывок').toBe(1);
  });

  it('⭐ R4-20: ввод перестал приходить (вкладка скрыта, кадры не идут) — через треть секунды герой стоит, а не бежит дальше', async () => {
    const { room, pid } = makeRoom('user-r420');
    room.descend(pid);
    await settle();
    const p = pOf(room, pid);
    room.setInput(pid, { ...idle, move: { x: 1, y: 0 }, facing: 1.25 });
    room.step(false);
    expect(Math.hypot(p.vel.x, p.vel.y), 'пошёл').toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) room.step(false);
    expect(Math.hypot(p.vel.x, p.vel.y), 'кадров нет — стоит').toBe(0);
    room.setInput(pid, { ...idle, move: { x: 1, y: 0 } });
    room.step(false);
    expect(Math.hypot(p.vel.x, p.vel.y), 'кадр пришёл — снова идёт').toBeGreaterThan(0);
  });

  it('⭐ R4-26: «собрать предмет» не засчитывает своё выброшенное и поднятое снова', async () => {
    const { room, pid, save } = makeRoom('user-r426');
    room.descend(pid);
    await settle();
    const it = weaponInBag(save);
    const def = { id: 'q-r426', name: 'Собрать', description: '', objectives: [{ id: 'o1', type: 'collect-item' as const, target: it.baseId, amount: 3 }], reward: { gold: 1 } };
    expect(acceptQuest(save, def).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      await room.handleCmd(pid, { cmd: 'drop', uid: it.uid }, 100 + i);
      expect(save.inventory.some((x) => x.uid === it.uid), `круг ${i}: выбросил`).toBe(false);
      room.setInput(pid, { ...idle, interact: true });
      room.step(false);
      room.setInput(pid, idle);
      room.step(false);
      expect(save.inventory.some((x) => x.uid === it.uid), `круг ${i}: поднял снова`).toBe(true);
    }
    const prog = save.quests.find((q) => q.questId === 'q-r426')!;
    expect(prog.counters.o1, 'своё выброшенное не считается').toBe(0);
    expect(prog.status).toBe('active');
  });

  it('⭐ R4-35: зелье командой — не при полном здоровье, не в стане и не мёртвым; расходуется, только если подействовало', async () => {
    const { room, ws, pid, save } = makeRoom('user-r435');
    room.descend(pid);
    await settle();
    room.step(false);
    const p = pOf(room, pid);
    const full = p.hp;
    const potion = itemFromBaseId(cfg.get('items.base'), 'healing-potion', undefined, 'shop')!;
    save.belt = [potion];
    await room.handleCmd(pid, { cmd: 'useConsumable', uid: potion.uid }, 1);
    expect(ws.last('cmdResult'), 'полное здоровье — нет эффекта').toMatchObject({ id: 1, ok: false });
    expect(save.belt[0]?.uid, 'зелье цело').toBe(potion.uid);
    const half = Math.floor(full / 2);
    p.hp = half; p.stunTimer = 5;
    room.step(false);
    await room.handleCmd(pid, { cmd: 'useConsumable', uid: potion.uid }, 2);
    expect(ws.last('cmdResult'), 'в стане не пьют').toMatchObject({ id: 2, ok: false });
    expect(p.hp, 'здоровье не выросло').toBeLessThan(half + 2);
    expect(save.belt[0]?.uid).toBe(potion.uid);
    p.stunTimer = 0; p.alive = false;
    await room.handleCmd(pid, { cmd: 'useConsumable', uid: potion.uid }, 3);
    expect(ws.last('cmdResult'), 'мёртвые не пьют').toMatchObject({ id: 3, ok: false });
    expect(save.belt[0]?.uid).toBe(potion.uid);
    p.alive = true;
    room.step(false);
    await room.handleCmd(pid, { cmd: 'useConsumable', uid: potion.uid }, 4);
    expect(ws.last('cmdResult')).toMatchObject({ id: 4, ok: true });
    expect(p.hp, 'подлечило').toBeGreaterThan(half);
    expect(save.belt[0] ?? null, 'выпито').toBeNull();
  });
});

describe('Room — раунд 5: здоровье, добивание статусом, журнал квестов (R5-02, R5-06, R5-20)', () => {
  type P5 = { hp: number; maxHp: number; alive: boolean; pos: { x: number; y: number } };
  const p5 = (room: Room, pid: string): P5 => (room as unknown as { session: { world: { players: Record<string, P5> } } }).session.world.players[pid]!;

  it('⭐ R5-02: снял амулет +жизни командой в подземелье — здоровье не выше нового максимума', async () => {
    const { room, ws, pid, save } = makeRoom('user-r502');
    room.descend(pid);
    await settle();
    const base = cfg.get('items.base').find((b) => (b as { slot?: string }).slot === 'amulet' && b.enabled !== false)!;
    const amu = itemFromBaseId(cfg.get('items.base'), base.id, cfg.get('item-tiers'), 'drop')!;
    amu.affixes.push({ affixId: 'hearty', kind: 'prefix', modifier: { stat: 'maxHp', kind: 'flat', value: 45 } });
    amu.requirements = {};
    save.equipment.amulet = amu;
    room.step(false);
    const p = p5(room, pid);
    const withAmu = p.maxHp;
    p.hp = p.maxHp;                                   // налился в амулете
    await room.handleCmd(pid, { cmd: 'unequip', slot: 'amulet' }, 1);
    expect(ws.last('cmdResult')).toMatchObject({ id: 1, ok: true });
    for (let i = 0; i < 90; i++) {
      room.step(false);
      expect(p.hp, `шаг ${i}: ${p.hp} при максимуме ${p.maxHp}`).toBeLessThanOrEqual(p.maxHp);
    }
    expect(p.maxHp, 'максимум упал на прибавку амулета').toBe(withAmu - 45);
  });
  it('⭐ R5-06: добитое ядом соседа — его убийство и его «Уничтожить N»; хозяин комнаты не получает ничего', async () => {
    const host = makeRoom('user-r506-host');                 // вошёл первым — «первый в комнате»
    freshLimits('user-r506-main');
    const mws = new FakeWs();
    const mainSave = newCharacterSave(cfg, 'mage', 'Маг', `char-${++seq}`);
    mainSave.skills['b-curse-a4'] = 1;
    const main = host.room.addPlayer(mws as unknown as GameConn, 'user-r506-main', mainSave, 1);
    await settle();
    host.room.descend(host.pid);
    host.room.castVote(main, true);
    expect(areaOf(host.room)).toBe('dungeon');
    type M5 = { alive: boolean; hp: number; pos: { x: number; y: number }; def: { id: string; hpRegen: number; xp: number } };
    const w = (host.room as unknown as { session: { world: { monsters: M5[] } } }).session.world;
    const m = w.monsters.find((x) => x.alive)!;
    m.hp = 30; m.def.hpRegen = 0;
    const q = (id: string) => ({ id, name: 'Убить', description: '', objectives: [{ id: 'o1', type: 'kill' as const, target: m.def.id, amount: 5 }], reward: { gold: 1 } });
    expect(acceptQuest(host.save, q('q-r506')).ok).toBe(true);
    expect(acceptQuest(mainSave, q('q-r506')).ok).toBe(true);
    const hostXp = host.save.xp, mainXp = mainSave.xp;
    const pm = p5(host.room, main), ph = p5(host.room, host.pid);
    pm.pos = { ...m.pos };
    host.room.setInput(main, { ...idle, cast: 'b-curse-a4' });
    for (let i = 0; i < 900 && m.alive; i++) {
      pm.hp = pm.maxHp; ph.hp = ph.maxHp;                   // бой не решает — решает яд
      host.room.step(false);
      if (i === 0) host.room.setInput(main, idle);
    }
    expect(m.alive, 'яд соседа добил').toBe(false);
    const counter = (s: SaveState): number | undefined => s.quests.find((x) => x.questId === 'q-r506')?.counters.o1;
    expect(counter(mainSave), 'убийство — соседа (яд проклятия мог задеть и соседних того же вида)').toBeGreaterThanOrEqual(1);
    expect(counter(host.save), 'хозяину — ничего').toBe(0);
    expect(host.save.xp, 'опыт хозяину не пришёл').toBe(hostXp);
    expect(mainSave.xp, 'опыт — соседу').toBeGreaterThan(mainXp);
  });
  it('⭐ R5-20: старый сейв с тысячами сданных заданий доски входит в комнату уже чистым; квота помнит поколение', async () => {
    freshLimits('user-r520');
    const save = newCharacterSave(cfg, cfg.get('classes')[0]!.id, 'Ветеран', `char-${++seq}`);
    const chain = cfg.get('quests.main').find((q) => q.enabled !== false)!;
    save.activeQuestDefs.push(chain as SaveState['activeQuestDefs'][number]);   // цепочка давно начата — вход квестов не выдаёт
    save.quests.push({ questId: chain.id, status: 'active', counters: {} });
    const now = Date.now();
    for (let g = 0; g < 2000; g++) {
      const id = `rnd_rnd-delve_old${g.toString(36)}`;
      save.activeQuestDefs.push({ id, name: 'Достичь этажа 3', description: '', objectives: [{ id: 'o1', type: 'reach-floor', amount: 3 }], reward: { gold: 1 } });
      save.quests.push({ questId: id, status: 'turned-in', counters: { o1: 3 }, acceptedAt: now - g * 60_000, boardAt: now - g * 60_000 });
    }
    const room = new RoomCtor('TEST', cfg, { onEmpty() {}, onGrace() {}, onUngrace() {} });
    rooms.push(room);
    const ws = new FakeWs();
    room.addPlayer(ws as unknown as GameConn, 'user-r520', save, 1);
    await settle();
    expect(save.quests.filter((q) => q.questId.startsWith('rnd_')), 'сданное с доски ушло из журнала').toEqual([]);
    expect(save.activeQuestDefs.filter((d) => d.id.startsWith('rnd_'))).toEqual([]);
    expect(save.quests.map((q) => q.questId), 'цепочка на месте').toEqual([chain.id]);
    expect(save.boardQuota?.['rnd-delve'], 'поколение самого свежего сданного — в квоте').toBe(now);
    expect(JSON.stringify(ws.last('joined')!.save).length, 'в кадр входа уходит маленький сейв').toBeLessThan(20_000);
  });
});
