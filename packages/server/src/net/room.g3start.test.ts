import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, newCharacterSave, runNodeDepth, waypointStart, clientFrameSchema, type SaveState, type ServerFrame, type RunConfig } from '@dm/shared';

// Каждый замер — настоящая генерация этажа и заселение (в том числе на 60-м этаже); умолчание 5 с тут лотерея.
vi.setConfig({ testTimeout: 120_000 });

/**
 * ⭐⭐ 14.10 (Г3, В2/В3): СТАРТ ЗАБЕГА С МЕТКИ — АНТИ-ЧИТ, КООП И «ОКНО ≡ ИСХОД».
 *
 * Кадр `descend` из города получил `startDepth`: с какой метки начать новый забег. Правило (решение владельца):
 *  • открытая метка — глубина, кратная каденции привала, и не глубже рекорда тира (`save.difficultyProgress[tier]`);
 *    вход на 1-м этаже открыт всегда;
 *  • эффективный старт — самая глубокая метка, открытая у КАЖДОГО героя пати, но не глубже запрошенной; ничего не
 *    подошло — 1;
 *  • у кого рекорд мельче, тому метки открываются НОГАМИ: его прогресс растёт на каждом новом входе (`enterNode`).
 *
 * ⚠ ПРЕДМЕТ СТОРОЖА — ИМЕННО «НЕ ОТКАЗ, А ЗАЖИМ». Проверка «годен ли кадр» отвечала бы да/нет и тем подсказывала
 * границу, а каждая забытая форма мусора была бы дыркой. Поэтому здесь на КАЖДЫЙ подложенный кадр мерится ГЛУБИНА, С
 * КОТОРОЙ ЗАБЕГ ФАКТИЧЕСКИ НАЧАЛСЯ (`Room.runNodeId`), и она обязана быть не глубже разрешённой по сейвам.
 *
 * ⚠ МУТАЦИИ, КОТОРЫЕ ЭТОТ ФАЙЛ ОБЯЗАН ВАЛИТЬ (каждая проверена руками 14.10: наложить → прогнать → вернуть, md5
 * сверен):
 *  • `startDepthOf` считает по кадру, а не по сейвам (`waypointStart(..., want)` → `want`) — валит всю таблицу
 *    подложенных кадров;
 *  • `startDepthOf` читает прогресс ТОЛЬКО звавшего (а не всей пати) — валит «кооп: 60 и 20 при шаге 3 → не глубже 18»;
 *  • `startDepthOf` берёт сильнейший рекорд пати вместо слабейшего — валит тот же кооп-тест;
 *  • `startRun` игнорирует `startDepth` (окно всегда `windowAt(1)`) — валит «старт действительно на метке»;
 *  • `startDepth` выброшен из `planKey` — валит «окно ≡ исход: напарник с мелким рекордом вошёл, пока голосовали»;
 *  • `startDepth` не уходит в `voteStart` — валит «окно называет ту же глубину, что начнётся»;
 *  • `roomManager` не передаёт `frame.startDepth` — валит «шов кадр → комната» (он стережётся исходником: см.
 *    подпись того теста — почему именно так);
 *  • `startDepth` убран из схемы кадра — валит «первая линия — схема кадра»;
 *  • запись прогресса в `enterNode` снята/сдвинута — валит «метки открываются ногами».
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
  castVote(pid: string, yes: boolean): void;
  step(): void; stop(): void;
};
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const USER = 'user-g3';
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
  votes(): Extract<ServerFrame, { t: 'voteStart' }>[] {
    return this.frames.filter((f): f is Extract<ServerFrame, { t: 'voteStart' }> => f.t === 'voteStart');
  }
  errors(): string[] {
    return this.frames.filter((f): f is Extract<ServerFrame, { t: 'error' }> => f.t === 'error').map((f) => f.msg);
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

let seq = 0;
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };
/** Герой с заданным рекордом глубины тира «normal» (его и читает старт по метке). */
function hero(record: number): SaveState {
  const charId = `char-g3-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `G3-${seq}`, charId);
  s.level = 30; s.attributes.vitality = 60;
  if (record > 0) s.difficultyProgress.normal = record;
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
function room(): RoomIn {
  const r = new RoomCtor(`G3S${++seq}`, cfg, hooks);
  rooms.push(r);
  return r;
}
/** ⭐ Г8-3: живые МЕСТА порталов (`balance.dungeonAccess.portalsAt`) — ими же считает генератор и чистая функция. */
const step = (): readonly number[] => cfg.get('balance').dungeonAccess.portalsAt;
/** ⭐⭐ Г8-2: длина цикла контента — метка считается МЕСТОМ В ПОЛОСЕ, и сервер читает это же число. */
const cycle = (): number => cfg.get('balance').dungeonAccess.contentCycle;
/** Глубина узла, на котором стоит комната (из имени узла — так же, как читает её сервер). */
const depthNow = (r: RoomIn): number => runNodeDepth(r.runNodeId ?? undefined);

/** Соло-спуск с подложенным `startDepth`: кадр годной формы или мусор — замер один, фактическая глубина старта. */
async function soloStart(record: number, want: unknown): Promise<{ depth: number; shown: number | undefined }> {
  const r = room();
  const ws = new FakeWs();
  const pid = r.addPlayer(ws, USER, hero(record), 1);
  await settle();
  r.movedAt = 0;
  r.descend(pid, undefined, undefined, undefined, want as number);
  expect(r.area, `рекорд ${record}, кадр ${JSON.stringify(want)}: пати в подземелье`).toBe('dungeon');
  const shown = ws.votes()[0]?.startDepth;
  const depth = depthNow(r);
  r.stop();
  return { depth, shown };
}

describe('⭐⭐ Г3 (В2): анти-чит старта по метке — кадр только ограничивает сверху', () => {
  it('⭐ ТАБЛИЦА ПОДЛОЖЕННЫХ КАДРОВ: старт никогда не глубже разрешённого сейвами', async () => {
    // ⚠⚠ 15.10 (Г8-3): ЧИСЛА ПЕРЕСЧИТАНЫ ПОД СХЕМУ ВЛАДЕЛЬЦА. Метка — это МЕСТО круга (цикл 20) из списка
    // 3/6/9/12/15/18/20: 20-е место — последнее в круге («на 19-м босс, 20-й портал и 21-й по новой всё»), поэтому
    // 60-й этаж СНОВА метка (его место — 20), а 58-й — метка места 18. Второй круг: 23/26/29/32/35/38/40.
    const RECORD = 60;
    const s = step();
    const cases: { want: unknown; why: string; expect: number }[] = [
      { want: undefined, why: 'кадра без глубины — вход (так ходят прежние клиенты)', expect: 1 },
      { want: 18, why: 'честная метка (место 18 полосы)', expect: 18 },
      { want: 60, why: 'ровно рекорд, и 60 — метка (место 20, конец круга)', expect: 60 },
      { want: 61, why: 'глубже рекорда на этаж — вниз до рекорда-метки', expect: 60 },
      { want: 1e9, why: 'подложена глубина с запасом', expect: 60 },
      { want: 20, why: 'метка места 20 первого круга', expect: 20 },
      { want: 19, why: 'НЕ метка: место 19 — актовый босс, вниз до 18', expect: 18 },
      { want: 0, why: 'ноль', expect: 1 },
      { want: -5, why: 'минус', expect: 1 },
      { want: 1.5, why: 'дробь', expect: 1 },
      { want: Number.NaN, why: 'NaN', expect: 1 },
      { want: Number.POSITIVE_INFINITY, why: 'Infinity', expect: 1 },
      { want: '18', why: 'строка вместо числа', expect: 1 },
      { want: null, why: 'null', expect: 1 },
      { want: [18], why: 'массив', expect: 1 },
    ];
    const rows: string[] = [];
    for (const c of cases) {
      const { depth, shown } = await soloStart(RECORD, c.want);
      rows.push(`кадр ${String(c.want === undefined ? 'нет' : JSON.stringify(c.want) ?? String(c.want)).padStart(12)} → старт ${String(depth).padStart(3)} · окно ${String(shown).padStart(3)} — ${c.why}`);
      expect(depth, `кадр ${JSON.stringify(c.want)}: фактический старт`).toBe(c.expect);
      expect(shown, `кадр ${JSON.stringify(c.want)}: окно голосования называет исход`).toBe(c.expect);
      // Вторая, независимая мера: та же глубина, что даёт чистая функция по сейву.
      expect(depth, `кадр ${JSON.stringify(c.want)}: сходится с чистой функцией`)
        .toBe(waypointStart([{ normal: RECORD }], 'normal', s, cycle(), c.want as number));
    }
    console.log(`\nАНТИ-ЧИТ СТАРТА ПО МЕТКЕ (рекорд ${RECORD}, шаг ${s}, замер 14.10)\n${rows.join('\n')}`);
  });

  it('⭐ свежий герой (рекорда нет) начинает с 1-го этажа, какую бы глубину ни прислал', async () => {
    for (const want of [undefined, 1, 3, 18, 1e9]) {
      const { depth, shown } = await soloStart(0, want);
      expect(depth, `без рекорда кадр ${String(want)}`).toBe(1);
      expect(shown, 'окно обещает вход').toBe(1);
    }
  });

  /**
   * ⚠ ШОВ «КАДР → КОМНАТА» СТЕРЕЖЁТСЯ ИСХОДНИКОМ, И ЭТО ОСОЗНАННО. Тесты этого файла зовут `Room.descend`
   * напрямую, а разбор кадра живёт в `RoomManager.handleFrame`: забудь там последний аргумент — и ВСЁ останется
   * зелёным, а в живой игре выбор метки молча перестанет работать (ровно тот сорт сторожа, которого тут не хватало
   * у шва комната→база, см. `db/runLedger.test.ts`). Поднимать ради одной строки весь менеджер с базой и сокетами
   * дороже, чем прочитать строку.
   */
  it('шов кадр → комната: разбор `descend` передаёт `startDepth` в комнату', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./roomManager.ts', import.meta.url), 'utf8');
    const line = src.split(/\r?\n/).find((l) => l.includes("case 'descend':"));
    expect(line, "строка разбора кадра `descend` в roomManager").toBeTruthy();
    expect(line, 'стартовая глубина доезжает до комнаты').toContain('frame.startDepth');
  });

  it('первая линия — схема кадра: форму мусора она не пускает дальше границы', () => {
    const ok = (startDepth: unknown): boolean => clientFrameSchema.safeParse({ t: 'descend', startDepth }).success;
    expect(ok(18), 'целое ≥ 1 — годно').toBe(true);
    expect(ok(1e9), 'потолка нет намеренно (спуск бесконечен) — зажмёт комната').toBe(true);
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '18', null, [18], {}]) {
      expect(ok(bad), `схема отвергает ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(clientFrameSchema.safeParse({ t: 'descend' }).success, 'поля может не быть вовсе').toBe(true);
  });
});

describe('⭐⭐ Г3 (В3): кооп — старт по самому слабому рекорду, метки открываются ногами', () => {
  it('⭐ пати с рекордами 60 и 20 → старт не глубже 20 (метка места 20, конец круга)', async () => {
    const s = step();
    expect([...s], 'живые места порталов полосы').toEqual([3, 6, 9, 12, 15, 18, 20]);
    const r = room();
    const wa = new FakeWs(), wb = new FakeWs();
    const a = hero(60), b = hero(20);
    const pa = r.addPlayer(wa, USER, a, 1);
    const pb = r.addPlayer(wb, USER, b, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 60);   // звавший просит СВОЙ рекорд
    // ⭐ Г8-3: окно обоим называет 20 — ограничивает рекорд НАПАРНИКА (20), а не звавшего (60). И 20-й этаж сам
    // метка: его место в круге 20-е, последнее. Прежде то же правило давало 18 — место 18 было последним портальным.
    expect(wa.votes()[0]?.startDepth, 'окно звавшего').toBe(20);
    expect(wb.votes()[0]?.startDepth, 'окно напарника').toBe(20);
    r.castVote(pb, true);
    expect(r.area).toBe('dungeon');
    expect(depthNow(r), 'старт пати').toBe(20);
    expect(waypointStart([{ normal: 60 }, { normal: 20 }], 'normal', s, cycle(), 60), 'та же чистая функция').toBe(20);
  });

  it('⭐ отставший открывает метки НОГАМИ: его рекорд растёт, следующий старт глубже', async () => {
    const r = room();
    const a = hero(60), b = hero(20);
    const pa = r.addPlayer(new FakeWs(), USER, a, 1);
    const pb = r.addPlayer(new FakeWs(), USER, b, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 60);
    r.castVote(pb, true);
    expect(depthNow(r), '⭐ Г8-3: старт по слабому рекорду 20 — и 20-й этаж сам метка (место 20 круга)').toBe(20);
    const rows = [`старт ${depthNow(r)}: рекорд A ${a.difficultyProgress.normal} · B ${b.difficultyProgress.normal}`];
    expect(b.difficultyProgress.normal, 'вход на 20 рекорд отстающего не опускает').toBe(20);

    // Спуск ногами: 21 → 22 → 23 → 24. Монстры «спят», зовущий стоит у выхода (правило R3-01).
    for (let i = 0; i < 4; i++) {
      const w = r.session.world;
      for (const m of w.monsters) m.alive = false;
      const node = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!;
      const to = node.edges[0]!.to;
      for (const p of Object.values(w.players)) p.pos = { ...w.exits![0]! };
      r.movedAt = 0;
      r.descend(pa, undefined, to);
      r.castVote(pb, true);
      expect(r.runNodeId, 'пати спустилась').toBe(to);
      rows.push(`этаж ${depthNow(r)}: рекорд A ${a.difficultyProgress.normal} · B ${b.difficultyProgress.normal}`);
    }
    console.log(`\nМЕТКИ ОТКРЫВАЮТСЯ НОГАМИ (замер 15.10)\n${rows.join('\n')}`);
    expect(depthNow(r), 'прошли четыре этажа').toBe(24);
    // ⚠⚠ Г8-3, ДВА РАЗНЫХ ЧИСЛА — И ПУТАТЬ ИХ НЕЛЬЗЯ. Рекорд — ФАКТИЧЕСКАЯ пройденная глубина (24-й
    // этаж — рекорд 24), а правило «не больше ОДНОЙ метки за вход» (`nextWaypointAfter`) только ЗАЖИМАЕТ его
    // сверху, чтобы протащенный на 60-й не получил 60 сразу. А вот СТАРТ из рекорда — всегда МЕТКА не глубже его,
    // то есть 23 (место 3 второго круга) — это проверяет ассерт в конце теста.
    expect(b.difficultyProgress.normal, '⭐ рекорд отстающего вырос ногами — ровно до пройденного этажа').toBe(24);
    expect(a.difficultyProgress.normal, 'рекорд ведущего не опустился').toBe(60);

    // Пати уходит в город с точки входа узла (`canLeave`) — забег при этом ПАРКУЕТСЯ.
    const back = r.session.world;
    for (const p of Object.values(back.players)) p.pos = { ...back.spawn };
    r.movedAt = 0;
    (r as unknown as { returnTown(pid: string): void }).returnTown(pa);
    r.castVote(pb, true);
    expect(r.area, 'в городе').toBe('town');
    // ⚠ Забег снят вручную: «Завершить» с метки — это В4/В5 (следующая фаза), а здесь предмет один — что ВЫРОСШИЙ
    // рекорд открывает метку НОВОМУ забегу. Припаркованный стартовую глубину не выбирает вовсе (идёт по своему
    // указателю, см. тест ниже), поэтому без снятия спуск был бы продолжением, а не новым забегом.
    for (const p of Object.values(r.session.world.players)) p.save.run = undefined;
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 60);
    r.castVote(pb, true);
    expect(r.area, 'новый забег начался').toBe('dungeon');
    // ⚠⚠ 15.10 (Г8-3): ВОТ ЧЕГО СТОИЛИ НОГИ. Старт был 20 (слабый рекорд 20, место 20 круга); отстающий прошёл
    // четыре этажа и открыл следующую метку — 23 (место 3 ВТОРОГО круга), поэтому новый забег пати начинает глубже.
    expect(depthNow(r), '⭐ после ног отстающего пати стартует с НОВОЙ открытой метки, а не с прежней').toBe(23);
  });

  it('новичок в пати тянет старт к входу (его рекорд — ноль)', async () => {
    const r = room();
    const pa = r.addPlayer(new FakeWs(), USER, hero(60), 1);
    const pb = r.addPlayer(new FakeWs(), USER, hero(0), 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 60);
    r.castVote(pb, true);
    expect(depthNow(r), 'глубина ветерана новичку не достаётся').toBe(1);
  });
});

describe('⭐⭐ Г3 (В2): окно голосования ≡ исход и по глубине', () => {
  it('⭐ напарник с мелким рекордом вошёл, пока голосовали, — голосование ОТМЕНЯЕТСЯ, а не уводит пати на 1-й', async () => {
    const r = room();
    const wa = new FakeWs(), wb = new FakeWs(), wc = new FakeWs();
    const pa = r.addPlayer(wa, USER, hero(60), 1);
    const pb = r.addPlayer(wb, USER, hero(60), 1);
    await settle();
    r.movedAt = 0;
    r.descend(pa, undefined, undefined, undefined, 18);
    expect(wa.votes()[0]?.startDepth, 'окно обещает 18').toBe(18);

    // Пока голосовали, вошёл третий — без рекорда. Разрешение пати стало «вход».
    const pc = r.addPlayer(wc, USER, hero(0), 1);
    await settle();
    r.castVote(pb, true);
    r.castVote(pc, true);

    expect(r.area, 'перехода не было — голосовали не за это').toBe('town');
    expect(wa.errors().some((m) => m.includes('Пати изменилась')), 'кадр отмены с причиной').toBe(true);

    // Позвать заново: новое окно говорит правду, и начинается ровно оно.
    r.movedAt = 0;
    wa.frames.length = 0;
    r.descend(pa, undefined, undefined, undefined, 18);
    r.castVote(pb, true);
    r.castVote(pc, true);
    expect(wa.votes()[0]?.startDepth, 'новое окно — вход').toBe(1);
    expect(r.area).toBe('dungeon');
    expect(depthNow(r), 'начался ровно показанный вход').toBe(1);
  });

  it('⭐ продолжение припаркованного забега стартовую глубину не выбирает (идёт по своему указателю)', async () => {
    const r = room();
    const ws = new FakeWs();
    const a = hero(60);
    const pid = r.addPlayer(ws, USER, a, 1);
    await settle();
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 18);
    expect(depthNow(r)).toBe(18);
    // Спуск на один этаж ногами и возврат в город: забег припаркован на 19-м.
    const w = r.session.world;
    for (const m of w.monsters) m.alive = false;
    const to = r.runPlan!.nodes.find((n) => n.id === r.runNodeId)!.edges[0]!.to;
    w.players[pid]!.pos = { ...w.exits![0]! };
    r.movedAt = 0; r.descend(pid, undefined, to);
    expect(depthNow(r)).toBe(19);
    r.session.world.players[pid]!.pos = { ...r.session.world.spawn };
    r.movedAt = 0;
    (r as unknown as { returnTown(pid: string): void }).returnTown(pid);
    expect(r.area, 'в городе, забег припаркован').toBe('town');

    ws.frames.length = 0;
    r.movedAt = 0;
    r.descend(pid, undefined, undefined, undefined, 3);   // просит мелкую метку — у продолжения это не рычаг
    const v = ws.votes()[0]!;
    expect(v.startDepth, 'окно продолжения глубину старта не называет').toBeUndefined();
    expect(v.resume?.depth, 'окно называет указатель забега').toBe(19);
    expect(depthNow(r), 'продолжение вернуло на свой узел, а не на запрошенный 3-й').toBe(19);
  });
});
