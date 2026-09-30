import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigRegistry, configRevs, defaultConfigData, type ConfigKey } from '@dm/shared';
import { liveConfig } from '../configLive.js';
import { installConfigWrites } from './configRoutes.js';

/**
 * ⭐ R21-02: ПРОБА ЗАПИСИ КОНФИГА — НАД ТЕМ, ЧТО СОБЕРЁТ ПЕРЕСБОРКА. Ручки записи (`/api/dev/config`, `/api/dev/config-file`) проверяли правку
 * над ФАЙЛАМИ старта (`new ConfigRegistry(); loadAll(); reload(присланное)`), а с правилом поверх таблиц (⭐ D4: время баффа) это разное:
 * откат клича 11.5 с, годный при отдыхе 0.1 из базы, получал 422 «…отдых 25 %…» (число файла), потолок донора печати при уже поднятом
 * откате печати — 422 «…откат 14 с» (тоже файл). Редактор (`validatedKeys` над живым) такую правку пускал — страницу за страницей её было
 * не сохранить. Здесь ручки настоящие (`configRoutes.ts`) на петле, живой конфиг — настоящий (`configLive.ts`), база оверрайдов — карта в
 * памяти (запись уносит строку в конец, как UPDATE в куче Postgres), файлы — карта.
 * ⭐ R21-01: сброс таблицы из связанной пары (`DELETE`) — отказ, а не молча выброшенная или «приведённая» таблица-партнёр на пересборке.
 * ⭐ R21-03: «в файл» — ещё и слой файлов сам по себе: файл, годный только с оверрайдами этой базы, ронял следующий старт.
 */
type Tree = { nodes: { id: string; name: string; maxRank: number; effect: { active?: { category?: string; cooldown: number }; grantsInsert?: string } }[] };
type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };
const fileTree = (): Tree => structuredClone(file().get('skill-tree')) as unknown as Tree;
const fileIns = (): Ins => structuredClone(file().get('skill-inserts')) as unknown as Ins;
const fileBalance = (): Record<string, unknown> => structuredClone(file().get('balance')) as unknown as Record<string, unknown>;
const WARCRY = 'b-class-warrior-a5';
const node = (t: Tree, id: string): Tree['nodes'][number] => t.nodes.find((n) => n.id === id)!;

interface World {
  base: string; config: ConfigRegistry; rows: Map<string, unknown>; files: Map<string, unknown>; incidents: string[]; warned: string[];
  /** ⭐ R22-02: живой конфиг процесса (наблюдатель файлов — `live.applyFile`). */
  live: ReturnType<typeof liveConfig>;
  /** Новый процесс над той же базой (строки — в порядке `order`, иначе как лежат): живой конфиг старта. */
  restart(order?: 'reversed'): Promise<{ config: ConfigRegistry; incidents: string[]; warned: string[] }>;
}
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

async function world(pre: Record<string, unknown> = {}): Promise<World> {
  const rows = new Map<string, unknown>(Object.entries(pre).map(([k, v]) => [k, structuredClone(v)]));
  const files = new Map<string, unknown>();
  const read = (order?: 'reversed') => async (): Promise<Record<string, unknown>> => {
    const list = [...rows].map(([k, v]) => [k, structuredClone(v)] as const);
    return Object.fromEntries(order === 'reversed' ? list.reverse() : list);
  };
  const boot = async (order?: 'reversed'): Promise<{ config: ConfigRegistry; incidents: string[]; warned: string[]; live: ReturnType<typeof liveConfig> }> => {
    const config = new ConfigRegistry();
    const incidents: string[] = [], warned: string[] = [];
    const live = liveConfig({
      config, readOverrides: read(order), deleteOverride: async (k) => { rows.delete(k); }, changed: () => undefined,
      log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { incidents.push(s); },
    });
    for (const [k, v] of files) live.noteFile(k, v);
    await live.rebuild();
    return { config, incidents, warned, live };
  };
  const { config, incidents, warned, live } = await boot();
  const app = express();
  const pass: RequestHandler = (_req, _res, next) => { next(); };
  installConfigWrites(app, {
    config, live, gate: pass, json: express.json({ limit: '24mb' }), guard: async () => true,
    setOverride: async (k, v) => { rows.delete(k); rows.set(k, structuredClone(v)); },   // UPDATE — строка в конец кучи
    deleteOverride: async (k) => { rows.delete(k); },
    writeFile: (k, v) => { files.set(k, structuredClone(v)); },
    // ⭐ R22-02: файл на диске — записанный (или положенный «напарником») либо импорт старта.
    readFile: (k) => structuredClone(files.has(k) ? files.get(k) : (defaultConfigData as Record<string, unknown>)[k]),
  });
  const s = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  servers.push(s);
  return {
    base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, config, rows, files, incidents, warned, live,
    restart: async (order) => { const b = await boot(order); return { config: b.config, incidents: b.incidents, warned: b.warned }; },
  };
}
async function call(w: World, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; error?: string }> {
  const r = await fetch(`${w.base}${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const j = await r.json() as { error?: string };
  return { status: r.status, error: j.error };
}

describe('⭐ R21-02: проба записи конфига — над файлами и всеми оверрайдами базы, строго', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('отдых 0.1 сохранён, затем клич 11.5 с (годен лишь при 0.1) — 200, живёт; и после рестарта в обоих порядках строк', async () => {
    const w = await world();
    expect((await call(w, 'POST', '/api/dev/config', { balance: { ...fileBalance(), buffMinRest: 0.1 } })).status).toBe(200);
    const tree = fileTree();
    node(tree, WARCRY).effect.active!.cooldown = 11.5;
    const r = await call(w, 'POST', '/api/dev/config', { 'skill-tree': tree });
    expect(r.error, 'было — 422 «…отдых 25 %…» с числом файла').toBeUndefined();
    expect(r.status).toBe(200);
    expect(node(w.config.get('skill-tree') as unknown as Tree, WARCRY).effect.active!.cooldown).toBe(11.5);
    for (const order of [undefined, 'reversed'] as const) {
      const b = await w.restart(order);
      expect(b.incidents, order ?? 'как лежат').toEqual([]);
      expect(b.warned.filter((s) => /приведён/.test(s)), order ?? 'как лежат').toEqual([]);
      expect(b.config.get('balance').buffMinRest).toBe(0.1);
      expect(node(b.config.get('skill-tree') as unknown as Tree, WARCRY).effect.active!.cooldown).toBe(11.5);
      expect(node(b.config.get('skill-tree') as unknown as Tree, WARCRY).maxRank).toBe(8);
    }
  });

  it('откат «Оберега» 30 с сохранён, затем потолок его донора 20 — 200 (было 422 «…откат 14 с» — число файла)', async () => {
    const w = await world();
    const ins = fileIns();
    ins.find((i) => i.id === 'ins-ward')!.proc!.ability.cooldown = 30;
    expect((await call(w, 'POST', '/api/dev/config', { 'skill-inserts': ins })).status).toBe(200);
    const tree = fileTree();
    const donor = tree.nodes.find((n) => n.effect.grantsInsert === 'ins-ward')!;
    donor.maxRank = 20;
    const r = await call(w, 'POST', '/api/dev/config', { 'skill-tree': tree });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(node(w.config.get('skill-tree') as unknown as Tree, donor.id).maxRank).toBe(20);
    const b = await w.restart('reversed');
    expect(b.incidents).toEqual([]);
    expect((b.config.get('skill-inserts') as unknown as Ins).find((i) => i.id === 'ins-ward')!.proc!.ability.cooldown).toBe(30);
  });

  it('контроль: древо, нарушающее ЖИВОЙ отдых (0.1), — 422 с живым числом (10 %), ничего не записано; отдых выше, чем держит древо базы, — 422 с «skill-tree»', async () => {
    const w = await world();
    expect((await call(w, 'POST', '/api/dev/config', { balance: { ...fileBalance(), buffMinRest: 0.1 } })).status).toBe(200);
    const tree = fileTree();
    node(tree, WARCRY).effect.active!.cooldown = 9;
    const r = await call(w, 'POST', '/api/dev/config', { 'skill-tree': tree });
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/Боевой клич[\s\S]*отдых 10 %/);
    expect(r.error).not.toMatch(/отдых 25 %/);
    expect(w.rows.has('skill-tree'), 'не записано').toBe(false);
    const up = await call(w, 'POST', '/api/dev/config', { balance: { ...fileBalance(), buffMinRest: 5 } });
    expect(up.status).toBe(422);
    expect(up.error).toMatch(/skill-tree/);
    expect(w.config.get('balance').buffMinRest, 'живое прежнее').toBe(0.1);
  });
});

describe('⭐ R21-01: сброс таблицы из связанной пары — отказ с таблицей-партнёром, а не молча выброшенная таблица на пересборке', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('отдых 0.1 и клич 11.5 с в базе: сброс баланса — 422 (клич нарушит правило при 25 %), всё на месте; сброс древа, затем баланса — 200', async () => {
    const w = await world();
    expect((await call(w, 'POST', '/api/dev/config', { balance: { ...fileBalance(), buffMinRest: 0.1 } })).status).toBe(200);
    const tree = fileTree();
    node(tree, WARCRY).effect.active!.cooldown = 11.5;
    expect((await call(w, 'POST', '/api/dev/config', { 'skill-tree': tree })).status).toBe(200);
    const r = await call(w, 'DELETE', '/api/dev/config/balance');
    expect(r.status, 'было — 200, а пересборка «приводила» клич 8 → 6 или выбрасывала древо').toBe(422);
    expect(r.error).toMatch(/Сброс «balance»[\s\S]*Боевой клич/);
    expect(w.rows.has('balance'), 'оверрайд на месте').toBe(true);
    expect(w.config.get('balance').buffMinRest).toBe(0.1);
    expect(w.incidents).toEqual([]);
    expect((await call(w, 'DELETE', '/api/dev/config/skill-tree')).status, 'сброс древа к файлу — годен при 0.1').toBe(200);
    expect((await call(w, 'DELETE', '/api/dev/config/balance')).status, 'теперь и баланс').toBe(200);
    expect(w.rows.size).toBe(0);
    expect(w.config.get('balance').buffMinRest).toBe(0.25);
    expect((await call(w, 'DELETE', '/api/dev/config/nope')).status, 'не таблица схемы — сброс как прежде').toBe(200);
  });
});

describe('⭐ R21-03: «Применить везде» — файл, годный лишь с оверрайдами базы, — 422, ничего не записано', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('древо и вставки ×8 только в базе: balance.json с отдыхом 1.0 — 422 (старт на другой базе упал бы), ни файла, ни оверрайда; обычная правка баланса — 200', async () => {
    const tree = fileTree();
    for (const n of tree.nodes) if (n.effect.active?.category === 'buff') n.effect.active.cooldown = Math.round(n.effect.active.cooldown * 8);
    const ins = fileIns();
    for (const i of ins) if (i.proc?.ability.category === 'buff') i.proc.ability.cooldown = Math.round(i.proc.ability.cooldown * 8);
    const w = await world({ 'skill-tree': tree, 'skill-inserts': ins });
    const r = await call(w, 'POST', '/api/dev/config-file', { balance: { ...fileBalance(), buffMinRest: 1.0 } });
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/без оверрайдов базы[\s\S]*правило баффа/);
    expect(w.files.size, 'файл не записан').toBe(0);
    expect(w.rows.has('balance'), 'оверрайд не записан').toBe(false);
    expect(w.config.get('balance').buffMinRest).toBe(0.25);
    const ok = await call(w, 'POST', '/api/dev/config-file', { balance: { ...fileBalance(), respecCost: 4321 } });
    expect(ok.status).toBe(200);
    expect((w.files.get('balance') as { respecCost: number }).respecCost).toBe(4321);
    expect(w.config.get('balance').respecCost).toBe(4321);
  });
});

/**
 * ⚠ R22-07: НЕИЗВЕСТНАЯ ТАБЛИЦА — 422 С ЕЁ ИМЕНЕМ, А НЕ 500. С R21-02 проба шла в очереди записей и отказывала верно, но очередь затем
 * считала ревизии присланных ключей (`configRevs` → `config.get('nope')` бросает «не загружен»), а с `__baseRev` — ещё раньше: запрос падал,
 * ручка отвечала 500 «Внутренняя ошибка» с логом ошибки. Редактор принимал 5xx за рестарт (четыре повтора, «Сервер недоступен — не
 * сохранено»), поз-редактор — «сервер отказал (500)» без имени секции (переименованная таблица в `pe_config_edits` запирала публикацию).
 */
describe('⚠ R22-07: неизвестная таблица в записи конфига — 422 с именем, а не 500', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('обе ручки записи, с базой и без: 422 «Неизвестный конфиг «nope»», ни ошибки в лог, ни записи', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await world();
    for (const path of ['/api/dev/config', '/api/dev/config-file']) {
      for (const body of [{ nope: 1 }, { __baseRev: {}, nope: 1 }, { __baseRev: { nope: 'x' }, nope: 1 }, { rarities: structuredClone(w.config.get('rarities')), nope: 1 }]) {
        const r = await call(w, 'POST', path, body);
        expect(r.status, `${path} ${JSON.stringify(Object.keys(body))}: было — 500`).toBe(422);
        expect(r.error).toMatch(/Неизвестный конфиг[\s\S]*nope/);
      }
    }
    expect(errors, 'ни строки «Внутренняя ошибка» в лог').not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    expect(w.rows.size, 'ничего не записано').toBe(0);
    expect(w.files.size).toBe(0);
  });
});

/**
 * ⭐ R22-02: «ПРИМЕНИТЬ ВЕЗДЕ» НЕ ПИШЕТ ТАБЛИЦУ ПОВЕРХ ФАЙЛА, КОТОРОГО СЕРВЕР НЕ ПРИНЯЛ. Редактор грузит живой конфиг; файл, отказанный
 * наблюдателем (или ещё не дошедший до него), лежал на диске, а живой — прежним. Ручка «в файл» сверяла только ревизию живого (C-09) — и
 * писала старую живую таблицу поверх файла: правка напарника (git pull, генератор) молча откатывалась на диске. Теперь таблица, чей файл на
 * диске не тот, что в основе живого, — 409 с причиной, файл не тронут. И наблюдатель берёт файл, спорящий лишь с оверрайдом чужой таблицы
 * (как старт), — так что редактор, перечитав живое, пишет уже поверх правки напарника.
 */
describe('⭐ R22-02: «Применить везде» — таблица, чей файл на диске не принят сервером, — 409, файл цел', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  const liveBalance = (w: World): Record<string, unknown> => structuredClone(w.config.get('balance')) as unknown as Record<string, unknown>;
  const rev = (w: World, keys: string[]): Record<string, string> => configRevs(keys, (k) => w.config.get(k as ConfigKey));

  it('клич хозяина 12.7 с в базе, напарник кладёт balance.json (отдых 0.26, сброс 4242): наблюдатель берёт; редактор, загрузивший раньше, — 409; перечитавший — 200 поверх правки напарника', async () => {
    const tree = fileTree();
    node(tree, WARCRY).effect.active!.cooldown = 12.7;
    const w = await world({ 'skill-tree': tree });
    const before = rev(w, ['balance']);   // вкладка редактора открыта до правки напарника
    const pulled = { ...fileBalance(), buffMinRest: 0.26, respecCost: 4242 };
    w.files.set('balance', structuredClone(pulled));   // git pull
    await expect(w.live.applyFile('balance', structuredClone(pulled)), 'было — «не применён»').resolves.toBeUndefined();
    expect(w.config.get('balance').respecCost).toBe(4242);
    const stale = await call(w, 'POST', '/api/dev/config-file', { __baseRev: before, balance: { ...fileBalance(), respecCost: 777 } });
    expect(stale.status, 'правка поверх старого снимка — отказ (C-09)').toBe(409);
    expect((w.files.get('balance') as { respecCost: number }).respecCost, 'файл напарника цел').toBe(4242);
    const ok = await call(w, 'POST', '/api/dev/config-file', { __baseRev: rev(w, ['balance']), balance: { ...liveBalance(w), respecCost: 777 } });
    expect(ok.status).toBe(200);
    expect(w.files.get('balance'), 'правка хозяина — поверх правки напарника').toMatchObject({ buffMinRest: 0.26, respecCost: 777 });
  });

  it('битый balance.json на диске (отказ наблюдателя): «Применить везде» баланса из живого — 409 с причиной, файл не тронут; чужая таблица — 200', async () => {
    const w = await world();
    const broken = { ...fileBalance(), respecCost: 'много' };
    w.files.set('balance', structuredClone(broken));
    await expect(w.live.applyFile('balance', structuredClone(broken)), 'наблюдатель: схема не пустила').rejects.toThrow(/respecCost/);
    const r = await call(w, 'POST', '/api/dev/config-file', { __baseRev: rev(w, ['balance']), balance: { ...liveBalance(w), reconnectGraceSec: 77 } });
    expect(r.status, 'было — 200, и живая таблица 0.25/500 ложилась поверх файла').toBe(409);
    expect(r.error).toMatch(/balance[\s\S]*на диске/);
    expect(w.files.get('balance'), 'файл на диске не тронут').toEqual(broken);
    expect(w.rows.has('balance'), 'и оверрайд не записан').toBe(false);
    const rar = structuredClone(w.config.get('rarities'));
    rar[0]!.priceMult += 0.5;
    expect((await call(w, 'POST', '/api/dev/config-file', { rarities: rar })).status, 'чужая таблица пишется').toBe(200);
    // Файл поправили — наблюдатель взял — пишется и баланс.
    const fixed = { ...fileBalance(), respecCost: 321 };
    w.files.set('balance', structuredClone(fixed));
    await w.live.applyFile('balance', structuredClone(fixed));
    const ok = await call(w, 'POST', '/api/dev/config-file', { __baseRev: rev(w, ['balance']), balance: { ...liveBalance(w), reconnectGraceSec: 77 } });
    expect(ok.status).toBe(200);
    expect(w.files.get('balance')).toMatchObject({ respecCost: 321, reconnectGraceSec: 77 });
  });

  it('файл на диске новее принятого (наблюдатель ещё не дошёл или выключен) — 409; запись «в файл» своей же таблицы дважды подряд — 200 (формат файла не мешает)', async () => {
    const w = await world();
    w.files.set('balance', { ...fileBalance(), respecCost: 999 });   // правка на диске, наблюдатель её не видел
    const r = await call(w, 'POST', '/api/dev/config-file', { balance: { ...liveBalance(w), reconnectGraceSec: 5 } });
    expect(r.status).toBe(409);
    expect((w.files.get('balance') as { respecCost: number }).respecCost).toBe(999);
    const parts = structuredClone(w.config.get('weapon-parts'));
    expect((await call(w, 'POST', '/api/dev/config-file', { 'weapon-parts': parts })).status).toBe(200);
    expect((await call(w, 'POST', '/api/dev/config-file', { 'weapon-parts': parts })).status, 'своя запись — это и есть основа').toBe(200);
  });
});

/**
 * ⭐ R23-06: ФАЙЛ, ЗАПИСАННЫЙ МЕЖДУ ИМПОРТОМ ДАННЫХ И ВЗВЕДЕНИЕМ НАБЛЮДАТЕЛЯ, — НЕ 409 НАВСЕГДА. Импорт `data/*.json` — при загрузке модуля, наблюдатель
 * взводится в конце `boot()`: файл, записанный в этом окне, события ФС не давал, живой конфиг оставался на импорте, а «Применить везде» его
 * таблицы отвечало 409 («сервер возьмёт его сам» — а взять было нечем) до следующего касания файла или рестарта. Теперь взведённый наблюдатель
 * сверяет диск с основой (`sweep`): разошедшийся файл берётся первым окном дребезга — и запись «в файл» идёт поверх него.
 */
describe('⭐ R23-06: файл, записанный до взведения наблюдателя, — взят; «Применить везде» — 200', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('balance.json изменён в окне старта: наблюдатель, взведённый позже, берёт его сам; «Применить везде» баланса — 200 поверх правки на диске', async () => {
    const { configWatcher } = await import('../configWatch.js');
    const { configKeyForFile } = await import('../configFiles.js');
    const w = await world();
    const pulled = { ...fileBalance(), respecCost: 4242 };
    w.files.set('balance', structuredClone(pulled));   // `git pull` лёг, пока процесс собирал конфиг
    const keys = Object.keys(defaultConfigData);
    const watch = configWatcher({
      live: w.live, keys, log: () => undefined, warn: () => undefined,
      read: (f) => { const k = configKeyForFile(f, keys)!; return structuredClone(w.files.has(k) ? w.files.get(k) : (defaultConfigData as Record<string, unknown>)[k]); },
    });
    watch.sweep();
    await watch.flush();
    watch.stop();
    expect(w.config.get('balance').respecCost, 'было — импорт старта').toBe(4242);
    const r = await call(w, 'POST', '/api/dev/config-file', { balance: { ...(structuredClone(w.config.get('balance')) as unknown as Record<string, unknown>), reconnectGraceSec: 77 } });
    expect(r.status, `было — 409 навсегда: ${r.error ?? ''}`).toBe(200);
    expect(w.files.get('balance'), 'правка хозяина — поверх правки на диске').toMatchObject({ respecCost: 4242, reconnectGraceSec: 77 });
  });
});
