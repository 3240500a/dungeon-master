/**
 * ⭐⭐ Г4 (14.10): НЕВАЛИДНЫЙ СЕЙВ — ПОЧИНИТЬ НА ВХОДЕ И ЗАПИСАТЬ ИНЦИДЕНТ (`RoomManager.sanitize` → `repairDepth`).
 *
 * ЗАЧЕМ ЭТОТ СТОРОЖ. Пока забег был конечным, из рекорда глубины и указателя узла не следовало ни мира, ни прав. С Г1–Г3
 * из них следует ВСЁ: уровень монстров — от глубины узла (`floorMonsterLevel`), стартовая метка — от рекорда
 * (`waypointStart`), а какой узел пересоберёт продолжение — от `run.currentNodeId`. Структурная схема сейва
 * (`shared/validation/save.ts`) на входе НЕ ЗОВЁТСЯ ни раз (она для стендов и симов), поэтому сейв из Postgres до Г4
 * проходил в игру как есть.
 *
 * ЗАМЕР ДО ПРАВКИ (настоящая `Room`, `addPlayerResumeRun`; тот же пробник, что и в комментарии `repairDepth`):
 *   • `'n1000000000_0'` — ФОРМА ГОДНА → комната села на этаж 1 000 000 000: 54 монстра уровня 1 100 000 003, hp 1,9e25
 *     (u32 кадра — 4 294 967 295). Проверка одной формы эту дыру НЕ закрывает — отсюда потолок доверия
 *     `WAYPOINT_DEPTH_LIMIT`, тот же, которым Г3 уже ограничила рекорд;
 *   • `'start'`/`'n1e9_0'`/`''` → `resumeRun` берёт `startId`: «продолжение» забега с 60-го этажа НА ПЕРВОМ;
 *   • `'n0_0'` → `enterNode` молча выходит: комната остаётся `town` с `runNodeId = null` — тупик на каждый «Продолжить»;
 *   • забег без `config` → `TypeError … reading 'tier'` (и `reading 'id'` в `runLedgerKey`): герой НЕ ВХОДИТ ВОВСЕ;
 *   • `difficultyProgress` = `undefined`/`null`/`'abc'`/`42` → `TypeError: Cannot set properties of …` в `enterNode`:
 *     спуск не состоится ни разу.
 *
 * Что файл обязан валить: снятие починки рекорда; своё приведение рекорда вместо общего шва `depthRecordOf`; проверку
 * указателя ТОЛЬКО по форме (без потолка доверия); молчаливую починку (нет строки `ИНЦИДЕНТ` или счётчика); шум на
 * честном сейве; шум на сейве старше рекорда (поля нет); снятие забега, который годен.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ConfigRegistry, newCharacterSave, WAYPOINT_DEPTH_LIMIT, waypointStart,
  type SaveState, type ServerFrame, type RunConfig,
} from '@dm/shared';
import { counters } from './metrics.js';

vi.setConfig({ testTimeout: 120_000 });

const USER = 'user-g4';
const db = vi.hoisted(() => ({ versions: new Map<string, number>(), data: new Map<string, SaveState>() }));
vi.mock('../db/db.js', () => ({
  getCharacter: async (charId: string) => {
    const d = db.data.get(charId);
    return d ? { userId: 'user-g4', data: structuredClone(d), version: db.versions.get(charId) ?? 1 } : null;
  },
  getSession: async () => null,
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  landedVersion: async () => null,
  putCharacter: async (charId: string, _u: string, data: SaveState, version: number) => {
    if (version !== (db.versions.get(charId) ?? 1)) return null;
    db.versions.set(charId, version + 1); db.data.set(charId, structuredClone(data));
    return version + 1;
  },
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve('node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

type Pt = { x: number; y: number };
type P = { alive: boolean; hp: number; pos: Pt; save: SaveState };
/** Комната — настоящая: по сейву ПОСЛЕ починки мерится, КУДА ВОШЁЛ ГЕРОЙ (область, узел, этаж, монстры). */
type RoomIn = {
  area: string; movedAt: number; depth: number; runNodeId: string | null; runConfig: RunConfig | null;
  session: { world: { players: Record<string, P>; monsters: { alive: boolean; hp: number; def: { level: number } }[]; exits?: Pt[] } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  addPlayerResumeRun(ws: unknown, userId: string, save: SaveState, version: number): string;
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: unknown, startDepth?: number): void;
  stop(): void;
};
type Mgr = { ownedSave(userId: string, charId: string): Promise<{ save: SaveState; version: number } | undefined>; rooms: Map<string, { stop(): void }> };

let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
let RoomCtor: new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
let cfg: ConfigRegistry;
const managers: Mgr[] = [];
const rooms: RoomIn[] = [];
beforeAll(async () => {
  ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js'));
  ({ Room: RoomCtor } = (await import('./room.js')) as unknown as { Room: typeof RoomCtor });
  cfg = new ConfigRegistry();
  cfg.loadAll();
});
afterEach(() => {
  for (const m of managers.splice(0)) for (const r of m.rooms.values()) r.stop();
  for (const r of rooms.splice(0)) r.stop();
  vi.restoreAllMocks();
});

class FakeWs {
  open = true; readonly ip = '127.0.0.1'; frames: ServerFrame[] = [];
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.frames.push(JSON.parse(raw) as ServerFrame); }
  close(): void { this.open = false; } onMessage(): void {} onClose(): void {}
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };
const hooks = { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} };

function manager(): Mgr {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    const m = new RoomManagerCtor(cfg) as unknown as Mgr;
    managers.push(m);
    return m;
  } finally { vi.useRealTimers(); }
}
function room(): RoomIn {
  const r = new RoomCtor(`G4${(++seq).toString(36).toUpperCase().padStart(6, '0')}`, cfg, hooks);
  rooms.push(r);
  return r;
}
let seq = 0;
/** Герой в базе; `patch` портит сейв так, как его мог бы вернуть Postgres. */
function stored(patch: (s: SaveState) => void = () => undefined): SaveState {
  const charId = `g4-${++seq}`;
  const s = newCharacterSave(cfg, 'warrior', `G4-${seq}`, charId);
  s.level = 30; s.attributes.vitality = 60;
  patch(s);
  db.versions.set(charId, 1); db.data.set(charId, structuredClone(s));
  return s;
}
/** Строки `ИНЦИДЕНТ` и приращение счётчика за один вход. */
async function entry(s: SaveState): Promise<{ save: SaveState; said: string[]; n: number }> {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const was = counters.saveRepaired;
  const got = await manager().ownedSave(USER, s.charId);
  const said = spy.mock.calls.map((c) => String(c[0])).filter((x) => x.includes('ИНЦИДЕНТ'));
  spy.mockRestore();
  return { save: got!.save, said, n: counters.saveRepaired - was };
}
/** Честный припаркованный забег на `depth`: конфиг — от настоящей комнаты (сид и ключ этажей свои). */
async function parked(depth: number): Promise<RunConfig> {
  const r = room();
  const host = stored();
  const pid = r.addPlayer(new FakeWs(), USER, host, 1);
  await settle();
  r.movedAt = 0;
  r.descend(pid, undefined, undefined, undefined, 1);
  await settle();
  const c = structuredClone(r.runConfig!);
  void depth;
  return c;
}
/** КУДА ВОШЁЛ ГЕРОЙ по этому сейву: область, узел, этаж, самый сильный монстр. */
async function where(s: SaveState): Promise<string> {
  const r = room();
  let threw = '';
  try {
    if (s.run) r.addPlayerResumeRun(new FakeWs(), USER, s, 1);
    else r.addPlayer(new FakeWs(), USER, s, 1);
  } catch (e) { threw = ` БРОСИЛО: ${String(e).split('\n')[0]}`; }
  await settle(12);
  const ms = r.session.world.monsters;
  const lv = ms.reduce((m, x) => Math.max(m, x.def.level), 0);
  const hp = ms.reduce((m, x) => Math.max(m, x.hp), 0);
  return `область ${r.area}, узел ${String(r.runNodeId)}, этаж ${r.depth}, монстров ${ms.length}${ms.length ? ` (макс ур. ${lv}, hp ${hp})` : ''}${threw}`;
}

describe('⭐⭐ Г4: невалидный сейв — починка на входе и инцидент', () => {
  it('ЧЕСТНЫЙ СЕЙВ: ни одной починки, ни строки в логе, ни единицы счётчика', async () => {
    const run = await parked(1);
    const s = stored((x) => {
      x.difficultyProgress = { normal: 60, nightmare: 0 };
      x.run = { config: run, currentNodeId: 'n60_0', visited: [], peak: 12 };
    });
    const { save, said, n } = await entry(s);
    expect(said, 'честный сейв лога не трогает').toEqual([]);
    expect(n, 'счётчик починок не растёт').toBe(0);
    expect(save.difficultyProgress).toEqual({ normal: 60, nightmare: 0 });
    expect(save.run?.currentNodeId, 'забег цел').toBe('n60_0');
    console.log(`\nГ4 ЧЕСТНЫЙ СЕЙВ → ${await where(save)}`);
  });

  it('СЕЙВ СТАРШЕ РЕКОРДА (поля нет): молча пустой — шуметь на каждом входе старого героя не надо', async () => {
    const s = stored((x) => { delete (x as unknown as { difficultyProgress?: unknown }).difficultyProgress; });
    const { save, said, n } = await entry(s);
    expect(save.difficultyProgress).toEqual({});
    expect(said, 'молчит, как починка уровня и золота').toEqual([]);
    expect(n).toBe(0);
    console.log(`\nГ4 СЕЙВ БЕЗ РЕКОРДА → ${await where(save)}`);
  });

  it('РЕКОРД НЕ ОБЪЕКТ: пустой + инцидент (до правки вход в узел БРОСАЛ — спуск не состоялся бы ни разу)', async () => {
    const log: string[] = [];
    for (const bad of [null, 'abc', 42, [1, 2]] as unknown[]) {
      const s = stored((x) => { (x as unknown as { difficultyProgress: unknown }).difficultyProgress = bad; });
      const { save, said, n } = await entry(s);
      expect(save.difficultyProgress, `${JSON.stringify(bad)} → пустой объект`).toEqual({});
      expect(n, `${JSON.stringify(bad)}: одна починка`).toBe(1);
      expect(said.join('\n'), `${JSON.stringify(bad)}: сказано вслух`).toMatch(/ИНЦИДЕНТ[\s\S]*рекорд глубины был/);
      log.push(`${JSON.stringify(bad)} → ${JSON.stringify(save.difficultyProgress)}; ${await where(save)}`);
    }
    console.log(`\nГ4 РЕКОРД НЕ ОБЪЕКТ\n${log.join('\n')}`);
  });

  it('ПОРЧЕНОЕ ЧИСЛО РЕКОРДА: целое 0…потолка общим швом, инцидент на каждое; ключ не-тир остаётся', async () => {
    // ⭐ Г8-3: места порталов и длина круга — как их считает сервер; старт забега по починенному рекорду — тем же швом.
    const access = cfg.get('balance').dungeonAccess;
    const step = access.portalsAt[0]!;
    const bads: [unknown, number][] = [
      [1e9, WAYPOINT_DEPTH_LIMIT], [2 ** 53, WAYPOINT_DEPTH_LIMIT], [-5, 0], [-0, 0], [2.5, 2],
      // ⚠ `Infinity` даёт 0, а не потолок: `depthRecordOf` не считает его числом («не конечное» = записи нет).
      [NaN, 0], [Infinity, 0], ['60', 0], [[60], 0], [null, 0], [{}, 0],
    ];
    const log: string[] = [];
    for (const [bad, want] of bads) {
      const s = stored((x) => { (x.difficultyProgress as unknown as Record<string, unknown>).normal = bad; });
      const { save, said, n } = await entry(s);
      expect(save.difficultyProgress.normal, `${JSON.stringify(bad) ?? String(bad)} → ${want}`).toBe(want);
      expect(n, `${JSON.stringify(bad) ?? String(bad)}: одна починка`).toBe(1);
      expect(said.join('\n')).toMatch(/ИНЦИДЕНТ[\s\S]*рекорд глубины тира «normal»/);
      // Старт следующего забега — по ПОЧИНЕННОМУ рекорду, тем же швом, что у алтаря и сервера.
      const start = waypointStart([save.difficultyProgress], 'normal', access.portalsAt, access.contentCycle, Number.MAX_SAFE_INTEGER);
      log.push(`${(JSON.stringify(bad) ?? String(bad)).padEnd(18)} → ${String(want).padStart(5)}; старт забега ${start}`);
    }
    // Ключ, не похожий на тир, ОСТАВЛЕН (инертен: рекорд читают только по id тира), а его ЗНАЧЕНИЕ чинится.
    const ghost = stored((x) => { (x.difficultyProgress as unknown as Record<string, unknown>).ghost = 7; });
    const g1 = await entry(ghost);
    expect(g1.save.difficultyProgress.ghost, 'годное число под чужим ключом не трогаем').toBe(7);
    expect(g1.said, 'и не шумим').toEqual([]);
    const ghostBad = stored((x) => { (x.difficultyProgress as unknown as Record<string, unknown>).ghost = 1e9; });
    const g2 = await entry(ghostBad);
    expect(g2.save.difficultyProgress.ghost, 'а мусор под чужим ключом — чиним').toBe(WAYPOINT_DEPTH_LIMIT);
    expect(g2.n).toBe(1);
    console.log(`\nГ4 ПОРЧЕНОЕ ЧИСЛО РЕКОРДА (потолок доверия ${WAYPOINT_DEPTH_LIMIT}, шаг метки ${step})\n${log.join('\n')}\nключ не-тир: 7 → ${g1.save.difficultyProgress.ghost}, 1e9 → ${g2.save.difficultyProgress.ghost}`);
  });

  it('УКАЗАТЕЛЬ ЗАБЕГА ГОДЕН: не трогаем — ни глубокий честный, ни ровно на потолке доверия', async () => {
    const run = await parked(1);
    for (const id of ['n1_0', 'n60_0', `n${WAYPOINT_DEPTH_LIMIT}_0`, 'n300_7']) {
      const s = stored((x) => { x.run = { config: structuredClone(run), currentNodeId: id, visited: [id] }; });
      const { save, said, n } = await entry(s);
      expect(save.run?.currentNodeId, `${id} — забег цел`).toBe(id);
      expect([said.length, n], `${id} — тишина`).toEqual([0, 0]);
    }
  });

  it('УКАЗАТЕЛЬ ЗАБЕГА НЕГОДЕН: забег снят, инцидент, герой входит в ГОРОД — и заработанное при нём', async () => {
    const run = await parked(1);
    const cases: [string, unknown][] = [
      ['не по форме', 'start'],
      ['не по форме', 'n1e9_0'],
      ['пустое имя', ''],
      ['глубина 0 (до правки — тупик в городе)', 'n0_0'],
      ['глубже потолка доверия (до правки — этаж 1e9)', 'n1000000000_0'],
      ['15 цифр: форма годна, глубина чудовищна', 'n999999999999999_0'],
      ['16 цифр: форму не проходит и SQL-шов свода', 'n9999999999999999_0'],
      ['не строка', 123],
      ['нет вовсе', undefined],
    ];
    const log: string[] = [];
    for (const [why, id] of cases) {
      const s = stored((x) => {
        x.difficultyProgress = { normal: 60 };
        x.gold = 1234;
        x.run = { config: structuredClone(run), currentNodeId: id as string, visited: [] };
        if (id === undefined) delete (x.run as unknown as { currentNodeId?: unknown }).currentNodeId;
      });
      const { save, said, n } = await entry(s);
      expect(save.run, `${why} (${JSON.stringify(id)}): забег снят`).toBeUndefined();
      expect(n, `${why}: одна починка`).toBe(1);
      expect(said.join('\n'), `${why}: сказано вслух`).toMatch(/ИНЦИДЕНТ[\s\S]*припаркованный забег снят/);
      // ⚠ ЗАРАБОТАННОЕ НЕ ТРОНУТО: снятие забега — не штраф.
      expect([save.level, save.gold, save.difficultyProgress.normal]).toEqual([30, 1234, 60]);
      log.push(`${(JSON.stringify(id) ?? 'нет').padEnd(22)} (${why}) → ${await where(save)}`);
    }
    console.log(`\nГ4 УКАЗАТЕЛЬ ЗАБЕГА НЕГОДЕН\n${log.join('\n')}`);
  });

  it('ЗАБЕГ БЕЗ CONFIG (и мусор на месте забега): снят — до правки вход БРОСАЛ, то есть герой не входил вовсе', async () => {
    const log: string[] = [];
    for (const bad of [
      { currentNodeId: 'n5_0', visited: [] },
      { config: null, currentNodeId: 'n5_0', visited: [] },
      { config: 'x', currentNodeId: 'n5_0', visited: [] },
      42,
      'run',
      [],
    ] as unknown[]) {
      const s = stored((x) => { (x as unknown as { run: unknown }).run = bad; });
      const { save, said, n } = await entry(s);
      expect(save.run, `${JSON.stringify(bad)}: снят`).toBeUndefined();
      expect(n).toBe(1);
      expect(said.join('\n')).toMatch(/ИНЦИДЕНТ[\s\S]*припаркованный забег снят/);
      log.push(`${JSON.stringify(bad)} → ${await where(save)}`);
    }
    console.log(`\nГ4 ЗАБЕГ БЕЗ CONFIG\n${log.join('\n')}`);
  });

  it('ДВЕ ПОЧИНКИ РАЗОМ: своя строка у каждой, счётчик на две; повторный вход после записи — тишина', async () => {
    const run = await parked(1);
    const s = stored((x) => {
      x.difficultyProgress = { normal: 1e9 };
      x.run = { config: run, currentNodeId: 'n1000000000_0', visited: [] };
    });
    const first = await entry(s);
    expect(first.n, 'рекорд + забег').toBe(2);
    expect(first.said.length).toBe(2);
    // Починенное легло в базу (как легло бы первой записью сейва) — следующий вход молчит.
    db.data.set(s.charId, structuredClone(first.save));
    const again = await entry(s);
    expect([again.n, again.said.length], 'починка ложится записью — потока строк от одного героя не бывает').toEqual([0, 0]);
    console.log(`\nГ4 ДВЕ ПОЧИНКИ РАЗОМ\n${first.said.join('\n')}\nповторный вход: починок ${again.n}, строк ${again.said.length}`);
  });

  it('ПОТОК БЕЗ ЗАПИСИ СЕЙВА (кадр лобби `runStatus`): строка и счётчик — по разу на герой × вид починки', async () => {
    // ⚠⚠ ПОЧЕМУ ГЛУШИТЕЛЬ ВООБЩЕ НУЖЕН. Мотивировка «починка ложится первой же записью сейва» верна только для пути
    // ВХОДА. `ownedSave` зовёт и кадр лобби `runStatus` — он ТОЛЬКО отвечает кадром, сейв не пишет, и порченая строка
    // базы остаётся порченой. ЗАМЕР ДО ПРАВКИ: три запроса по одной строке — три строки `ИНЦИДЕНТ` и счётчик +3;
    // потолок лобби (`RateLimiter(20, 2)`) держит два запроса в секунду, то есть ≈170 тыс. строк в сутки с ОДНОГО
    // героя — поток, который прячет в логе все остальные инциденты, а разбору человеком повтор не даёт ничего.
    // Поэтому ключ глушителя — ГЕРОЙ И ВИД ПОЧИНКИ, а не один герой: вторая беда того же сейва обязана прозвучать
    // своей строкой (её чинят отдельно), и беда другого героя — тоже.
    const m = manager();
    const one = stored((x) => { x.difficultyProgress = { normal: 1e9 }; });
    const two = stored((x) => { x.difficultyProgress = { normal: -3, hell: 7.5 }; });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const was = counters.saveRepaired;
    const lines: number[] = [];
    const take = (): number => {
      const n = spy.mock.calls.filter((cc) => String(cc[0]).includes('ИНЦИДЕНТ')).length;
      spy.mockClear();
      return n;
    };
    // Одна и та же порченая строка три раза — база между запросами НЕ МЕНЯЕТСЯ (как на пути лобби).
    for (let i = 0; i < 3; i++) { await m.ownedSave(USER, one.charId); lines.push(take()); }
    // Другой герой с ДВУМЯ видами починки — свои строки, и его повтор тоже глушится.
    await m.ownedSave(USER, two.charId); lines.push(take());
    await m.ownedSave(USER, two.charId); lines.push(take());
    spy.mockRestore();
    const grew = counters.saveRepaired - was;
    expect(lines, 'первый герой: 1 строка и тишина; второй: 2 своих строки и тишина').toEqual([1, 0, 0, 2, 0]);
    expect(grew, 'счётчик растёт вместе со строкой — они про одно').toBe(3);
    // ⚠ ПОЧИНКА САМА НЕ ГЛУШИТСЯ — глушится только строка: сейв, отданный на ТРЕТЬЕМ (молчаливом) запросе, починен.
    const got = await m.ownedSave(USER, one.charId);
    expect(got!.save.difficultyProgress!['normal'], 'молчаливый ответ всё равно отдаёт починенный сейв').toBe(WAYPOINT_DEPTH_LIMIT);
    console.log(`\nГ4 ПОТОК БЕЗ ЗАПИСИ\nстрок по запросам: ${lines.join(', ')} (без глушителя замерено 1, 1, 1, 2, 2 — строка на КАЖДЫЙ запрос, счётчик +7); счётчик +${grew}`);
  });
});
