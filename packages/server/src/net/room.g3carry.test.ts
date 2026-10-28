import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, runNodeDepth, waypointStart, nextWaypointAfter, type SaveState, type ServerFrame, type RunConfig } from '@dm/shared';

// Каждый замер — настоящая генерация этажа и заселение (в том числе двадцать этажей подряд с 61-го); умолчание 5 с тут лотерея.
vi.setConfig({ testTimeout: 180_000 });

/**
 * ⭐⭐ 14.10 (Г3, правка 7): КАРРИ РАЗРЕШЁН, А МЕТКА ДАРОМ НЕ ДОСТАЁТСЯ.
 *
 * Зажим стартовой глубины (`Room.startDepthOf` → `waypointStart`) обходится ПОРЯДКОМ ДЕЙСТВИЙ — проверка 14.10
 * замерила два открытых пути, и оба идут МИМО него:
 *  (а) ВХОД ПО КОДУ в комнату, которая уже стоит на 60-м этаже (`RoomManager.join` → `Room.addPlayer`: перед ним
 *      только `MAX_PARTY` и `runClashOn`, ни области, ни глубины), — и новичок получал рекорд 61 после ОДНОГО этажа
 *      ногами, то есть соло-старт 60;
 *  (б) ПРОДОЛЖЕНИЕ ЧУЖОГО припаркованного забега (`Room.resumeFromLedger` → `resumeRun`): в окне голосования только
 *      `resume.depth`, и пати входит на глубину указателя хозяина — новичок попадал на 59 и дальше на 60
 *      (до Г8-2 это были 61 и 62: метка тогда стояла на 60-м, теперь — на 58-м, место 18 полосы).
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (дословно): «если они начали с 20 этажа, то открывается у всех ПОСТЕПЕННО, кроме тех, у кого
 * открыто, и им надо добежать туда НОГАМИ всем — тогда протяжка по вейпоинтам будет дольше, и это нормально».
 * Поэтому ни одна из двух дверей НЕ ЗАКРЫТА (карри работает), а правило одно и живёт в `Room.enterNode`: прогресс
 * сложности растёт не больше чем на ШАГ МЕТКИ (`balance.dungeonAccess.waypointStep`) за вход в новый узел.
 *
 * ⚠ ПРЕДМЕТ СТОРОЖА — ЖИВАЯ `Room` И ТЕ ЖЕ ЧИСЛА, ЧТО В ЗАМЕРЕ ПРОВЕРКИ. Чистая функция здесь ничего не доказала бы:
 * вся находка была в том, что до правила ДОХОДЯТ двумя путями, которых чистая функция не видит. Поэтому оба пути
 * проигрываются ногами на настоящей комнате, и мерится `save.difficultyProgress` героя, а не аргументы вызовов.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 14.10: наложить → прогнать → вернуть, md5
 * сверен):
 *  • возврат прежнего правила (`Math.max(was, node.depth)`) — валит оба пути: новичок получает 61 вместо 3;
 *  • щедрый шаг (`was + 60` вместо `was + waypointStep`) — валит «после одного этажа 3»;
 *  • шаг литералом 1 вместо числа баланса — валит «после одного этажа 3» (станет 1) и «после двадцати этажей 60»;
 *  • снятие `Math.max(was, …)` (прогресс едет вниз) — валит «новый забег с входа рекорд ветерана не опускает»;
 *  • снятие шага совсем (прогресс = `node.depth` без потолка) — валит оба пути, как и первая мутация;
 *  • «шаг» применён и к обычному спуску как ограничение глубины — валит «соло-спуск: рекорд равен глубине»;
 *  • молчаливый `return` в `Room.finish` вне подземелья — валит «кнопка в городе отвечает кадром, а не молчанием».
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
type RoomIn = {
  code: string; area: string; movedAt: number; difficultyId: string;
  runConfig: RunConfig | null; runNodeId: string | null;
  runPlan: { nodes: { id: string; depth: number; edges: { to: string }[] }[] } | null;
  session: { world: { players: Record<string, P>; monsters: { alive: boolean }[]; spawn: Pt; exits?: Pt[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: unknown, startDepth?: number): void;
  finish(pid: string): void;
  castVote(pid: string, yes: boolean): void;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const USER = 'user-carry';
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
  errors(): Extract<ServerFrame, { t: 'error' }>[] {
    return this.frames.filter((f): f is Extract<ServerFrame, { t: 'error' }> => f.t === 'error');
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

let seq = 0;
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
/** Герой с заданным рекордом глубины тира «normal» (его читают и старт по метке, и прогресс сложности). */
function hero(record: number): SaveState {
  const charId = `char-carry-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `CR-${seq}`, charId);
  s.level = 30; s.attributes.vitality = 60;
  if (record > 0) s.difficultyProgress.normal = record;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
function room(): RoomIn {
  const r = new RoomCtor(`G3C${++seq}`, cfg, hooks);
  rooms.push(r);
  return r;
}
/** Живой шаг каденции — он же потолок прибавки прогресса за вход. */
/** ⭐ Г8-3: места порталов в полосе (список) — ими же считает прибавку сервер. */
const step = (): readonly number[] => cfg.get('balance').dungeonAccess.portalsAt;
/** ⭐ Г8-3: длина круга — места порталов считаются ВНУТРИ неё. */
const cycleOf = (): number => cfg.get('balance').dungeonAccess.contentCycle;
/** ⭐⭐ Г8-2: длина цикла контента — метка стоит на МЕСТЕ В ПОЛОСЕ, и сервер считает старт этим же числом. */
const cycle = (): number => cfg.get('balance').dungeonAccess.contentCycle;
/** Глубина узла, на котором стоит комната (из имени узла — так же, как читает её сервер). */
const depthNow = (r: RoomIn): number => runNodeDepth(r.runNodeId ?? undefined);
/** Рекорд тира «normal» в сейве. */
const rec = (s: SaveState): number => s.difficultyProgress.normal ?? 0;

/**
 * Один этаж НОГАМИ: монстры «спят», все стоят у выхода (правило R3-01), спуск по первой ветке + «за» остальных.
 * Возвращает глубину, на которой пати оказалась.
 */
function walk(r: RoomIn, by: string, others: string[]): number {
  const w = r.session.world;
  for (const m of w.monsters) m.alive = false;
  const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
  const to = node.edges[0]!.to;
  for (const p of Object.values(w.players)) p.pos = { ...w.exits![0]! };
  r.movedAt = 0;
  r.descend(by, undefined, to);
  for (const pid of others) r.castVote(pid, true);
  expect(r.runNodeId, 'пати спустилась на следующий узел').toBe(to);
  return depthNow(r);
}

describe('⭐⭐ Г3 (правка 7): протащенный глубоко открывает метки НОГАМИ, по шагу за этаж', () => {
  it('⭐ (а) ВХОД ПО КОДУ на 58-й этаж: после одного этажа рекорд новичка 3, после двадцати — 58', async () => {
    // ⚠⚠ 15.10 (Г8-3): ГЛУБИНА ВЗЯТА У МЕТКИ ПОЛОСЫ. Метка — МЕСТО круга (цикл 20) из списка 3/6/9/12/15/18/20;
    // 58-й этаж — место 18, честная метка. Правило, которое сторожит этот файл («за вход открывается не больше
    // ОДНОЙ метки»), от выбора глубины не зависит, а вот прибавку теперь считает `nextWaypointAfter`, а не шаг:
    // места стоят неровно (…18, 20, 23…), и фиксированное число давало бы то половину шага, то полтора.
    const s = step();
    expect([...s], 'живые места порталов полосы').toEqual([3, 6, 9, 12, 15, 18, 20]);
    const firstMark = nextWaypointAfter(0, s, cycleOf());
    const r = room();
    const vet = hero(58);
    const pa = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);   // ветеран честно стартует со своей метки
    expect(r.area, 'пати в подземелье').toBe('dungeon');
    expect(depthNow(r), 'старт ветерана — его метка').toBe(58);

    // ⚠ ВОТ ОНА, ДЫРКА: новичка сажают в комнату НА 60-м ЭТАЖЕ, и никакая проверка глубины на этом пути не стоит.
    const fresh = hero(0);
    const pb = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    expect(r.area, 'комната по-прежнему в подземелье на 58-м').toBe('dungeon');
    expect(depthNow(r)).toBe(58);
    expect(rec(fresh), 'вход в комнату сам прогресса не даёт').toBe(0);

    const rows: string[] = [`вошёл по коду: область ${r.area}, глубина ${depthNow(r)}, рекорд новичка ${rec(fresh)}`];
    const got: number[] = [];
    for (let i = 1; i <= 20; i++) {
      const d = walk(r, pa, [pb]);
      got.push(rec(fresh));
      if (i <= 3 || i === 20) rows.push(`этаж ${d}: рекорд новичка ${rec(fresh)} · ветерана ${rec(vet)}`);
    }
    console.log(`\nКАРРИ ВХОДОМ ПО КОДУ (замер 15.10, места ${s.join(', ')} круга)\n${rows.join('\n')}`);

    expect(got[0], '⭐ после ОДНОГО этажа ногами — ПЕРВАЯ метка полосы, а не 61').toBe(3);
    expect(got[1]).toBe(6);
    expect(got[2]).toBe(9);
    // ⚠⚠ 15.10 (Г8-3): рекорд растёт ПО ОДНОЙ МЕТКЕ ЗА ВХОД, а не на фиксированный шаг и не прыжком на глубину
    // комнаты. Места стоят неровно (3, 6, 9, 12, 15, 18, 20, затем 23, 26 … второго круга), поэтому за двадцать
    // входов рекорд проходит ровно двадцать мест — 58, а не «20 × 3 = 60». Ту же цепочку считаем здесь независимо,
    // чистым швом: совпадение числа с сервером и есть предмет проверки.
    let chain = 0;
    for (let i = 0; i < 20; i++) chain = nextWaypointAfter(chain, s, cycle());
    expect(chain, 'двадцать меток подряд от нуля').toBe(58);
    expect(got[19], '⭐ после двадцати этажей ногами — ровно двадцать МЕТОК').toBe(chain);
    // Вторая, независимая мера: с таким рекордом сервер теперь и начал бы ровно с 58-й — ни глубже.
    expect(waypointStart([{ normal: got[19]! }], 'normal', s, cycle(), 1e9), 'соло-старт новичка после протяжки').toBe(58);
    expect(rec(vet), 'ветеран ногами растёт как обычно: 58 + 20 этажей').toBe(78);
  });

  it('⭐ (б) ПРОДОЛЖЕНИЕ ЧУЖОГО припаркованного забега: новичок входит на 59, а рекорд ему даёт шаг', async () => {
    // ⚠ 15.10 (Г8-2): старт — метка полосы 58 (60 меткой больше не является), поэтому ветеран уходит на 59-й.
    const s = step();
    const r = room();
    const vet = hero(58);
    const pa = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 58);
    expect(depthNow(r)).toBe(58);
    expect(walk(r, pa, []), 'ветеран ушёл на 59-й').toBe(59);

    // Уход в город ПАРКУЕТ забег (В4): указатель ветерана остаётся на 59-м.
    const back = r.session.world;
    for (const p of Object.values(back.players)) p.pos = { ...back.spawn };
    r.movedAt = 0;
    (r as unknown as { returnTown(pid: string): void }).returnTown(pa);
    expect(r.area, 'в городе, забег припаркован').toBe('town');
    expect(vet.run?.currentNodeId, 'указатель забега ветерана').toBeTruthy();

    // ⚠ ВТОРАЯ ДЫРКА: новичок входит в город к ветерану и голосует за ПРОДОЛЖЕНИЕ — `startDepthOf` на этом пути не зовётся.
    const fresh = hero(0);
    const pb = r.addPlayer(new FakeWs(), USER, fresh, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 1);   // просит вход — у продолжения это не рычаг
    r.castVote(pb, true);
    await settle(12);   // продолжение ждёт свод забега из базы (`resumeFromLedger`)
    expect(r.area, 'пати продолжила забег ветерана').toBe('dungeon');
    expect(depthNow(r), 'и вошла на глубину указателя хозяина').toBe(59);
    expect(rec(fresh), 'продолжение — повторный вход: прогресса не даёт никому').toBe(0);

    const d = walk(r, pa, [pb]);
    console.log(`\nКАРРИ ПРОДОЛЖЕНИЕМ ЧУЖОГО ЗАБЕГА (замер 14.10)\nвошёл на ${59}: рекорд новичка 0\nэтаж ${d}: рекорд новичка ${rec(fresh)} · ветерана ${rec(vet)}`);
    expect(d, 'спустились на 60-й').toBe(60);
    expect(rec(fresh), '⭐ после одного этажа — ПЕРВАЯ метка полосы, а не 60').toBe(nextWaypointAfter(0, step(), cycleOf()));
    expect(rec(vet), 'ветеран на 60-м').toBe(60);
  });

  it('⭐ ОБЫЧНЫЙ СОЛО-СПУСК ПРАВИЛО НЕ ТРОГАЕТ: рекорд равен глубине на каждом этаже', async () => {
    const r = room();
    const h = hero(0);
    const pid = r.addPlayer(new FakeWs(), USER, h, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);
    expect(depthNow(r), 'свежий герой начинает с входа').toBe(1);
    const rows = [`этаж 1: рекорд ${rec(h)}`];
    expect(rec(h), 'первый этаж').toBe(1);
    for (let d = 2; d <= 8; d++) {
      expect(walk(r, pid, [])).toBe(d);
      rows.push(`этаж ${d}: рекорд ${rec(h)}`);
      expect(rec(h), `этаж ${d}: рекорд равен глубине`).toBe(d);
    }
    console.log(`\nОБЫЧНЫЙ СПУСК (шаг прибавки ${step()} никогда не связывает)\n${rows.join(' · ')}`);
  });

  it('новый забег с ВХОДА рекорд ветерана не опускает (прогресс едет только вверх)', async () => {
    const r = room();
    const vet = hero(60);
    const pid = r.addPlayer(new FakeWs(), USER, vet, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 1);   // сам попросил вход
    expect(depthNow(r)).toBe(1);
    expect(rec(vet), 'рекорд 60 остался 60').toBe(60);
    expect(walk(r, pid, [])).toBe(2);
    expect(rec(vet), 'и на 2-м этаже тоже').toBe(60);
  });
});

describe('⭐ Г3 (правка 7): «Завершить забег» вне подземелья отвечает словами', () => {
  it('кнопка в городе — кадр `error` с кодом `far`, а не молчание', async () => {
    const r = room();
    const ws = new FakeWs();
    const h = hero(60);
    const pid = r.addPlayer(ws, USER, h, 1);
    await settle();
    expect(r.area, 'герой в городе').toBe('town');
    ws.frames.length = 0;
    r.finish(pid);
    const errs = ws.errors();
    console.log(`\nОТКАЗ «ЗАВЕРШИТЬ» В ГОРОДЕ: ${errs.map((e) => `${e.code}: ${e.msg}`).join(' | ') || '(молчание)'}`);
    expect(errs.length, 'отказ не молчаливый').toBe(1);
    expect(errs[0]!.code, 'код — как у остальных отказов этой двери').toBe('far');
    expect(errs[0]!.msg, 'и сказано, где это делают').toContain('подземелье');
    expect(r.area, 'область не сменилась').toBe('town');
  });
});
