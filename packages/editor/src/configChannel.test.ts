import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigRegistry, configCrossIssues, configRev, configSchemas, defaultConfigData, type ConfigKey } from '@dm/shared';
import { LiveConfigBase, bundledWorkingCopy } from './liveConfig.js';
import { ConfigChannel } from './configChannel.js';
import { serverRig, sameTable, type ServerRig, type Tables } from './configChannel.fuzzKit.js';

/**
 * ⭐ R22-08: «СБРОСИТЬ К ДЕФОЛТУ» НЕ ТРОГАЕТ РАБОЧУЮ КОПИЮ, БАЗУ ЗАПИСИ И ВКЛАДКИ ИГРЫ ДО ОТВЕТА СЕРВЕРА.
 *
 * `resetConfig` клал в рабочую копию встроенные дефолты таблицы, рассылал их вкладкам игры и только потом слал DELETE. С R21-01 сервер сброс
 * может отклонить (422: без оверрайда связанная таблица нарушит правило поверх таблиц), а форма оставалась на дефолтах, которых сервер не ставил,
 * база записи — на живом оверрайде, вкладки игры — на дефолтах. Следующее «Применить» одного поля слало дефолты всех прочих полей поверх
 * совпавшей базы — и сервер молча заменял баланс хозяина у всех игроков (класс C-09, «редактор ≡ сервер»). А правило поверх таблиц редактор
 * проверял над НЕПРИМЕНЁННЫМИ таблицами рабочей копии, а не над живыми, как сервер.
 *
 * Сервер здесь настоящий (`configChannel.fuzzKit.ts`: живой конфиг и ручки записи), канал редактора — настоящий (`configChannel.ts`).
 */
type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number; durationSec: number } } }[] };
const CRY = 'b-class-warrior-a5';
const cross = (t: Tables): string[] => configCrossIssues((k) => configSchemas[k].parse(t[k])).map((i) => i.msg);
/** Древо с откатом клича `k × действие`. */
function treeWith(k: number): Tables {
  const tree = structuredClone(defaultConfigData['skill-tree']) as Tree;
  const n = tree.nodes.find((x) => x.id === CRY)!;
  n.effect.active!.cooldown = Math.round(n.effect.active!.durationSec * k * 100) / 100;
  return tree as unknown as Tables;
}
const balanceWith = (patch: Record<string, unknown>): Tables => ({ ...(defaultConfigData.balance as Tables), ...patch });

interface Editor { data: Tables; live: LiveConfigBase; ch: ConfigChannel; posts: [string, unknown][]; said: string[] }
/** Редактор, открытый над сервером: рабочая копия — встроенные файлы, затем живой конфиг (`loadFromServer`). */
async function editorOn(s: ServerRig): Promise<Editor> {
  const data = bundledWorkingCopy();
  const live = new LiveConfigBase();
  const snap = await s.read();
  live.accept(snap);
  Object.assign(data, snap);
  const posts: [string, unknown][] = [];
  const said: string[] = [];
  const ch = new ConfigChannel(data, live, {
    send: s.send, read: () => s.read(), post: (k, v) => { posts.push([k, structuredClone(v)]); },
    status: (t) => { said.push(t); }, label: (k) => k, later: (fn) => { fn(); },
  });
  return { data, live, ch, posts, said };
}

describe('⭐ R22-08: сброс таблицы — рабочая копия и вкладки двигаются только с ответом сервера', () => {
  let logSpy: { mockRestore(): void };
  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { logSpy.mockRestore(); });

  /** Хозяин: баланс (отдых 0.1 и прочие правки) и древо с кличем, годным только при отдыхе 0.1, — оверрайдами в базе. */
  async function ownerServer(): Promise<ServerRig> {
    const s = await serverRig();
    const bal = balanceWith({ buffMinRest: 0.1, respecCost: 777, townRestockSec: 321 });
    const tree = treeWith(1.4);
    expect(cross({ ...defaultConfigData, balance: bal, 'skill-tree': tree }), 'вместе с отдыхом 0.1 годно').toEqual([]);
    expect(cross({ ...defaultConfigData, 'skill-tree': tree }).length, 'с отдыхом файла (0.25) клич правило нарушает').toBeGreaterThan(0);
    s.rows.set('balance', bal);
    s.rows.set('skill-tree', tree);
    await s.live.rebuild();
    return s;
  }

  it('⭐ сервер отклонил сброс (422): форма, база и вкладки игры прежние; правка одного поля уходит поверх ЖИВЫХ прочих полей', async () => {
    const s = await ownerServer();
    const e = await editorOn(s);
    const liveBal = structuredClone(s.config.get('balance'));
    expect(await e.ch.reset('balance'), 'сброс отклонён').toBe(false);
    expect(s.last?.status).toBe(422);
    expect(e.data.balance, 'было: форма — встроенные дефолты, которых сервер не ставил').toEqual(liveBal);
    expect(e.posts, 'было: вкладкам игры разосланы дефолты до ответа сервера').toEqual([]);
    expect(e.said.at(-1), 'причина — в строке статуса').toMatch(/Сервер отклонил конфиг: Сброс «balance»/);

    // Хозяин правит одно поле и жмёт «Применить».
    (e.data.balance as { respecCost: number }).respecCost = 778;
    const values = e.ch.validated(['balance']);
    expect(values).not.toBeNull();
    expect(await e.ch.push(values!)).toBe(true);
    expect(s.last?.body?.balance, 'тело — живой баланс хозяина с одной правкой').toEqual({ ...liveBal, respecCost: 778 });
    expect(s.config.get('balance'), 'было: отдых, цены, пополнение лавки — к дефолтам у всех игроков').toEqual({ ...liveBal, respecCost: 778 });
    expect(e.posts).toEqual([['balance', { ...liveBal, respecCost: 778 }]]);
  });

  it('⭐ сброс принят: форма — таблица, которую СОБРАЛ сервер (файл на диске, а не бандл редактора); вкладкам — она же, после ответа', async () => {
    const s = await ownerServer();
    const disk = balanceWith({ respecCost: 1234 });   // напарник поправил data/balance.json после сборки редактора — сервер его взял
    s.live.noteFile('balance', disk);
    s.rows.delete('skill-tree');                       // древо хозяина снято: баланс сбрасывать можно
    await s.live.rebuild();
    const e = await editorOn(s);
    expect(await e.ch.reset('balance')).toBe(true);
    const got = s.config.get('balance');
    expect(got.respecCost).toBe(1234);
    expect(e.data.balance, 'было: встроенный дефолт редактора (500), а у сервера — файл на диске').toEqual(got);
    expect(e.posts).toEqual([['balance', got]]);
    // База записи — перечитанная таблица: следующая правка ложится (не 409), и поверх того, что держит сервер.
    (e.data.balance as { respecCost: number }).respecCost = 1235;
    expect(await e.ch.push(e.ch.validated(['balance'])!)).toBe(true);
    expect(s.config.get('balance')).toEqual({ ...got, respecCost: 1235 });
  });

  it('сброс принят, а перечитать таблицу не вышло (рестарт): форма и база прежние — следующая запись получает 409, а не отменяет сброс молча', async () => {
    const s = await ownerServer();
    s.rows.delete('skill-tree');
    await s.live.rebuild();
    const e = await editorOn(s);
    const before = structuredClone(e.data.balance);
    s.failReads = 1;
    expect(await e.ch.reset('balance')).toBe(false);
    expect(s.rows.has('balance'), 'на сервере сброшено').toBe(false);
    expect(e.data.balance).toEqual(before);
    expect(e.posts).toEqual([]);
    expect(e.said.at(-1)).toMatch(/не перечитана/);
    expect(await e.ch.push(e.ch.validated(['balance'])!)).toBe(false);
    expect(s.last?.status, 'было бы: база сдвинута ответом DELETE, и прежние правки хозяина молча возвращались поверх сброса').toBe(409);
    expect(s.rows.has('balance')).toBe(false);
  });

  it('⭐ правило поверх таблиц для правки — над ЖИВЫМИ прочими таблицами, как у сервера, а не над неприменёнными в рабочей копии', async () => {
    const s = await serverRig();
    const e = await editorOn(s);
    // (а) Баланс правится, но не применён (отдых 1.0); применяют древо — сервер проверит его над живым отдыхом 0.25 и примет.
    (e.data.balance as { buffMinRest: number }).buffMinRest = 1;
    const tree = treeWith(1.7);
    e.data['skill-tree'] = tree;
    expect(await s.live.trial({ 'skill-tree': tree }), 'сервер правку древа принимает').toBeNull();
    const ok = e.ch.validated(['skill-tree']);
    expect(ok, 'было: отказ по неприменённому отдыху рабочей копии').not.toBeNull();
    expect(await e.ch.push(ok!)).toBe(true);
    // (б) Отдых в рабочей копии снижен (0.1, не применён), клич — под него; применяют древо: сервер откажет (живой отдых 0.25) — редактор тоже.
    (e.data.balance as { buffMinRest: number }).buffMinRest = 0.1;
    const tight = treeWith(1.4);
    e.data['skill-tree'] = tight;
    expect(await s.live.trial({ 'skill-tree': tight }), 'сервер правку древа отклоняет').not.toBeNull();
    expect(e.ch.validated(['skill-tree']), 'было: редактор пропускал — над неприменённым отдыхом 0.1').toBeNull();
    expect(e.said.at(-1)).toMatch(/Ошибка валидации/);
  });
});

describe('⭐ R22-01: встроенные файлы вместе нарушают D4 — редактор открывается', () => {
  it('рабочая копия до ответа сервера — встроенные файлы как есть, без броска (было: `registry.loadAll()` на старте модуля — редактор не открывался)', () => {
    const files: Tables = { ...defaultConfigData, balance: balanceWith({ buffMinRest: 0.3 }) };
    expect(() => new ConfigRegistry().loadAll(files), 'сами файлы вместе правило нарушают').toThrow(/D4 правило баффа/);
    const copy = bundledWorkingCopy(files);
    expect((copy.balance as { buffMinRest: number }).buffMinRest).toBe(0.3);
    for (const k of Object.keys(configSchemas) as ConfigKey[]) expect(sameTable(copy[k], configSchemas[k].parse(files[k])), k).toBe(true);
  });

  it('база записи — ревизия живой таблицы; живая таблица — копия (правка рабочей копии на месте её не трогает)', () => {
    const live = new LiveConfigBase();
    const snap = { balance: { respecCost: 1, nested: { a: 1 } } };
    live.accept(snap);
    snap.balance.nested.a = 2;
    expect(live.value('balance')).toEqual({ respecCost: 1, nested: { a: 1 } });
    expect(live.body({ balance: {} })!.__baseRev).toEqual({ balance: configRev({ respecCost: 1, nested: { a: 1 } }) });
  });
});
