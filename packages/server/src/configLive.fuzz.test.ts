import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ConfigRegistry, buffTimingIssues, configCrossIssues, configSchemas, defaultConfigData, upgradeStoredOverride, type ConfigKey,
} from '@dm/shared';
import { liveConfig, type LiveConfig } from './configLive.js';
import { configWatcher, type ConfigWatch } from './configWatch.js';
import { configFileNameFor, configKeyForFile } from './configFiles.js';
import { installConfigWrites } from './net/configRoutes.js';
import { fuzzRng, mixSeed, type FuzzRng } from './net/coopLifecycle.fuzzKit.js';

/**
 * ⭐ R21-01/02/03, R22-02/06/07: ФАЗЗЕР СБОРКИ ЖИВОГО КОНФИГА — модельный: настоящие ручки записи (`net/configRoutes.ts`) на петле, настоящий
 * живой конфиг (`configLive.ts` → `configCandidate.ts`), настоящий наблюдатель файлов (`configWatch.ts`), база оверрайдов — карта в памяти с
 * порядком кучи Postgres (запись уносит строку в конец), ДИСК — карта файлов данных (что записала ручка «в файл», положил напарник или
 * генератор, в том числе битое). Сид даёт последовательность правок хозяина по трём таблицам, которые связывает правило поверх таблиц
 * (⭐ D4: `balance.buffMinRest`, откаты и потолки баффов древа, откаты печатей вставок и потолки их доноров) — числами у самой границы
 * правила, по одной и парами, — через «Применить на сервере», «Применить везде», «Сбросить к дефолту», правку файлов на диске (наблюдатель:
 * один файл или пачка, по одному, разом, при сбое базы на чтении — с повтором), битый файл на диске и «Применить везде» его таблицы, правку
 * чужой таблицы и запись с неизвестной таблицей. После КАЖДОЙ операции проверяются инварианты:
 *  1 — живой конфиг держит правило поверх таблиц (`1-cross`);
 *  2 — ручки ничего не приводят и не выбрасывают молча: запись в чистое состояние (старт ничего не говорит) оставляет его чистым — ни
 *      «приведён», ни ИНЦИДЕНТА (`2-silent-change`);
 *  3 — принятое живёт как прислано: таблица, на которую ручка ответила 200, в живом конфиге ровно она (`3-accepted-changed`); сброс с 200 —
 *      таблица файла (`3-reset`); отказ ручки — ни базы, ни диска не тронул (`3-refused-wrote`); ⭐ R22-02: годный схемой файл на диске
 *      наблюдатель берёт (`3-watch-refused`), битый — нет (`3-garbage-taken`), и «Применить везде» таблицы с битым файлом не пишет его поверх
 *      (`3-drift-overwrite`); ⭐ R22-07: неизвестная таблица — 422 (`3-unknown-table`); ⭐ R23-06: и файл, записанный в ОКНЕ СТАРТА (между
 *      импортом данных и взведением наблюдателя — событий ФС о нём нет), взведённый наблюдатель берёт сам (`3-boot-missed`; из своего потока);
 *  4 — ПОРЯДОК СТРОК НЕ ВАЖЕН, И РЕСТАРТ ≡ РАБОТАЮЩИЙ: новый процесс над той же базой и ФАЙЛАМИ НА ДИСКЕ (⭐ R22-02: и тем, что наблюдатель
 *      брал с приведением, — отказанного годного на диске не бывает) собирает тот же конфиг (ревизия) и говорит то же, что работающий
 *      (`4-order`, `4-restart`, `4-said`), и не бросает (`4-boot-threw`); пока на диске битый файл, старт невозможен — проверка ждёт его починки;
 *  5 — ⭐ R22-06: ручка не делает слой файлов хуже сам по себе: новой строки-нарушителя правила или более раннего ранга нарушения
 *      (`5-files-worse`). Слой файлов, уже нарушающий правило, — законное состояние (напарник положил, старт приводит с инцидентом).
 * Самопроверки: прежняя сборка (оверрайды по одному в порядке строк, правило над полусобранным реестром) и прежний наблюдатель (строгая проба
 * одного файла поверх оверрайдов базы, отказ — только строкой, файл остаётся на диске; ⚠ R23-06 — без сверки диска при взведении) фаззером ловятся.
 *
 * ПЕРЕМЕННЫЕ: `DM_FUZZ_SEEDS=N` (умолчание 5), `DM_FUZZ_FROM` — с какого сида, `DM_FUZZ_OPS` — длина последовательности (умолчание 8),
 * `DM_FUZZ_TRACE=1` — след операций и исходов в stderr. Большой прогон (30.09): 60 сидов × 14 операций — нарушений нет.
 */
const SEEDS = Number(process.env.DM_FUZZ_SEEDS ?? 5);
const FROM = Number(process.env.DM_FUZZ_FROM ?? 1);
const OPS = Number(process.env.DM_FUZZ_OPS ?? 8);

type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number; durationSec: number }; grantsInsert?: string } }[] };
type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
type Tables = Record<string, unknown>;
const CROSS = ['balance', 'skill-tree', 'skill-inserts'] as const;
type Cross = (typeof CROSS)[number];
const KEYS = Object.keys(configSchemas);
const clone = <T>(v: T): T => structuredClone(v);
const fileName = (k: string): string => configFileNameFor(k);

/** Правка таблицы `key` поверх `from` (как редактор: страница — от загруженного живого конфига; как напарник — от файла), числами у границы правила. */
function mutate(r: FuzzRng, key: Cross, from: unknown): unknown {
  const t = clone(from) as Record<string, unknown>;
  if (key === 'balance') {
    (t as { buffMinRest: number }).buffMinRest = r.pick([0.05, 0.1, 0.1, 0.25, 0.5, 1.0]);
    if (r.chance(0.5)) (t as { respecCost: number }).respecCost = 100 + r.int(9000);   // правка экономики рядом — живёт или нет вместе с баллансом
    return t;
  }
  if (key === 'skill-tree') {
    const tree = t as unknown as Tree;
    const buffs = tree.nodes.filter((n) => n.effect.active?.category === 'buff');
    const donors = tree.nodes.filter((n) => n.effect.grantsInsert === 'ins-ward' || n.effect.grantsInsert === 'ins-swiftness');
    for (let i = 0, n = 1 + r.int(2); i < n; i++) {
      if (r.chance(0.7)) {
        const b = r.pick(buffs);
        // Множители действия у границы: 1.3–1.5 годны при отдыхе 0.1 и не годны при 0.25 (на рангах 6–8) — пары, живые только вместе.
        b.effect.active!.cooldown = Math.round(b.effect.active!.durationSec * r.pick([1.2, 1.3, 1.4, 1.45, 1.5, 1.6, 2, 3]) * 100) / 100;
        b.maxRank = r.pick([1, 3, 6, 8, 8, 12, 20]);
      } else {
        r.pick(donors).maxRank = r.pick([1, 3, 10, 20]);
      }
    }
    return tree;
  }
  const ins = t as unknown as Ins;
  const sig = r.pick(ins.filter((i) => i.proc?.ability.category === 'buff'));
  sig.proc!.ability.cooldown = r.pick([4, 5, 7, 10.4, 10.5, 14, 30, 45]);
  return ins;
}
/** ⭐ R22-02: битый файл таблицы (пойман на середине записи, опечатка напарника) — негоден схемой. */
function garbageOf(r: FuzzRng, key: string, from: unknown): unknown {
  if (key === 'balance') return { ...(clone(from) as Record<string, unknown>), buffMinRest: r.pick(['много', -1, null]) };
  if (key === 'skill-tree') return { nodes: 'обрезано' };
  if (key === 'skill-inserts') return [{ id: 7 }];
  return r.chance(0.5) ? {} : [{ id: 'x' }];
}

interface Boot { config: ConfigRegistry; said: string[] }
/** Строки сборки, которые фаззер слушает: приведённое (предупреждение) и инциденты. */
const hear = (said: string[]): { warn: (s: string) => void; incident: (s: string) => void } => ({
  warn: (s) => { if (/приведён/.test(s)) said.push(s); }, incident: (s) => { said.push(s); },
});
/** Старт процесса над базой (`rows` в порядке `order`) и файлами на диске: настоящий живой конфиг. */
async function bootLive(rows: [string, unknown][], files: Map<string, unknown>): Promise<Boot> {
  const config = new ConfigRegistry();
  const said: string[] = [];
  const live = liveConfig({
    config, readOverrides: async () => Object.fromEntries(rows.map(([k, v]) => [k, clone(v)])), deleteOverride: async () => undefined,
    changed: () => undefined, log: () => undefined, ...hear(said),
  });
  for (const [k, v] of files) live.noteFile(k, v);
  await live.rebuild();
  return { config, said };
}
/** ⚠ Самопроверка: сборка ДО R21 — основа с правилом над одними файлами, оверрайды по одному в порядке строк над полусобранным реестром. */
async function bootLegacy(rows: [string, unknown][], files: Map<string, unknown>): Promise<Boot> {
  const config = new ConfigRegistry();
  const said: string[] = [];
  config.loadAll({ ...defaultConfigData, ...Object.fromEntries(files) });
  for (const [key, stored] of rows) {
    const { value, fixes } = upgradeStoredOverride(key, stored, config);
    try {
      config.reload({ [key]: value } as Partial<Record<ConfigKey, unknown>>);
      if (fixes.length) said.push(`оверрайд "${key}" приведён: ${fixes.join(', ')}`);
    } catch (e) {
      said.push(`ИНЦИДЕНТ: пропущен "${key}": ${String(e).split('\n')[0]}`);
    }
  }
  return { config, said };
}

interface World {
  url: string; config: ConfigRegistry; live: LiveConfig; watch: ConfigWatch; rows: Map<string, unknown>;
  /** Файлы на диске (ключ таблицы → разобранный JSON): нет ключа — файл, как при старте (импорт). */
  disk: Map<string, unknown>;
  /** Последний ГОДНЫЙ файл таблицы, взятый сервером (наблюдателем или записью «в файл»): из него правят файл дальше. */
  good: Map<string, unknown>;
  /** Таблицы, чей файл на диске битый (негоден схемой). */
  garbage: Set<string>;
  said: string[];
  /** Сколько чтений оверрайдов впереди упадут (база не ответила); `readFailed` — падало ли. */
  failReads: number; readFailed: boolean;
}
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

async function world(): Promise<World> {
  const w = {
    rows: new Map<string, unknown>(), disk: new Map<string, unknown>(), good: new Map<string, unknown>(), garbage: new Set<string>(),
    config: new ConfigRegistry(), said: [] as string[], failReads: 0, readFailed: false,
  } as World;
  w.live = liveConfig({
    config: w.config,
    readOverrides: async () => {
      if (w.failReads > 0) { w.failReads--; w.readFailed = true; throw new Error('connection terminated unexpectedly'); }
      return Object.fromEntries([...w.rows].map(([k, v]) => [k, clone(v)]));
    },
    deleteOverride: async (k) => { w.rows.delete(k); },
    changed: () => undefined, log: () => undefined, ...hear(w.said),
  });
  await w.live.rebuild();
  const onDisk = (k: string): unknown => clone(w.disk.has(k) ? w.disk.get(k) : (defaultConfigData as Tables)[k]);
  w.watch = configWatcher({
    live: w.live, keys: KEYS, read: (f) => onDisk(configKeyForFile(f, KEYS)!), log: () => undefined, warn: () => undefined, retryMs: 3_600_000,
  });
  const app = express();
  const pass: RequestHandler = (_req, _res, next) => { next(); };
  installConfigWrites(app, {
    config: w.config, live: w.live, gate: pass, json: express.json({ limit: '24mb' }), guard: async () => true,
    setOverride: async (k, v) => { w.rows.delete(k); w.rows.set(k, clone(v)); },
    deleteOverride: async (k) => { w.rows.delete(k); },
    writeFile: (k, v) => { w.disk.set(k, clone(v)); w.good.set(k, clone(v)); w.garbage.delete(k); },
    readFile: onDisk,
  });
  const s = await new Promise<Server>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
  servers.push(s);
  w.url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return w;
}
async function call(w: World, method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<number> {
  const r = await fetch(`${w.url}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  await r.body?.cancel();
  return r.status;
}
/** Таблица, как её разберёт схема (сравнение «живое ≡ присланное»). */
const parsed = (key: string, value: unknown): string => JSON.stringify(configSchemas[key as ConfigKey].parse(value));
const goodTable = (w: World, key: string): unknown => clone(w.good.has(key) ? w.good.get(key) : (defaultConfigData as Tables)[key]);
/** Слой файлов, взятый сервером (годные файлы): как его загрузит старт на базе без оверрайдов. */
const goodLayer = (w: World): Tables => ({ ...defaultConfigData, ...Object.fromEntries([...w.good].map(([k, v]) => [k, clone(v)])) });
/** ⭐ R22-06: нарушители правила у слоя файлов самого по себе: строка → первый негодный ранг и нехватка отката на нём. */
type Violators = Map<string, { rank: number; gap: number }>;
function layerViolators(layer: Tables): Violators {
  const reg = new ConfigRegistry();
  reg.reload(Object.fromEntries(CROSS.map((k) => [k, layer[k]])), { cross: false });
  const out: Violators = new Map();
  for (const i of buffTimingIssues({ balance: reg.get('balance'), 'skill-tree': reg.get('skill-tree'), 'skill-inserts': reg.get('skill-inserts') })) {
    out.set(`${i.table}:${i.id}`, { rank: i.rank, gap: i.floor - i.cooldown });
  }
  return out;
}
/** ⭐ R22-06: что в `after` хуже, чем в `before`: новая строка-нарушитель, ранг раньше или (на том же ранге) нехватка больше. */
function worseThan(before: Violators, after: Violators): string | null {
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) return `${id}: новое нарушение`;
    if (a.rank < b.rank || (a.rank === b.rank && a.gap > b.gap + 1e-9)) return `${id}: ранг ${b.rank} → ${a.rank}, нехватка ${b.gap.toFixed(2)} → ${a.gap.toFixed(2)}`;
  }
  return null;
}
const sorted = (xs: string[]): string => JSON.stringify([...xs].sort());

/** ⚠ Самопроверка R22-02: наблюдатель до R22 — строгая проба ОДНОГО файла поверх оверрайдов базы и всех правил слоя файлов; отказ — строка. */
async function legacyWatch(w: World, keys: readonly string[]): Promise<void> {
  for (const k of keys) {
    const v = clone(w.disk.get(k));
    const why = await w.live.trial({ [k]: v });
    let alone = false;
    try { new ConfigRegistry().loadAll({ ...goodLayer(w), [k]: v }); } catch { alone = true; }
    if (why === null && !alone) await w.live.applyFile(k, v);
  }
}

interface Violation { seed: number; step: number; op: string; inv: string; msg: string }
/** `watch`: наблюдатель — нынешний, до R22 (`legacy`) или ⚠ R23-06 без сверки диска при взведении (`noSweep`, самопроверка). */
interface Opts { boot: typeof bootLive; watch: 'live' | 'legacy' | 'noSweep' }

/** Один сид: операции и инварианты после каждой. `boot` — сборка процесса для проверки «рестарт ≡ работающий» (самопроверка — прежняя). */
async function runSeed(seed: number, opts: Opts): Promise<Violation | null> {
  const r = fuzzRng(mixSeed(0x5210c0f, seed));
  const w = await world();
  let clean = true;   // старт над текущим состоянием ничего не говорит (ни приведения, ни инцидента)
  try {
    // ⭐ R23-06: ОКНО СТАРТА — файлы, записанные между импортом данных (загрузка модуля) и взведением наблюдателя (конец `boot()`): событий ФС о
    // них не будет, и взведённый наблюдатель обязан сверить диск с основой сам (`sweep`) — иначе живой конфиг на импорте, рестарт — на диске, а
    // «Применить везде» таблицы — 409 навсегда. Из своего потока: основной поток операций не сдвигается.
    const pre = fuzzRng(mixSeed(0x2306, seed));
    if (pre.chance(0.4)) {
      const keys: Cross[] = pre.chance(0.4) ? [...new Set([pre.pick(CROSS), pre.pick(CROSS)])] : [pre.pick(CROSS)];
      for (const k of keys) w.disk.set(k, mutate(pre, k, goodTable(w, k)));
      if (opts.watch !== 'noSweep') w.watch.sweep();
      await w.watch.flush();
      for (const k of keys) {
        if (!w.live.fileMatches(k, w.disk.get(k))) return { seed, step: -1, op: `окно старта: ${keys.join('+')}`, inv: '3-boot-missed', msg: `годный схемой файл «${k}», записанный до взведения наблюдателя, не в основе живого` };
        w.good.set(k, clone(w.disk.get(k)));
      }
      w.said.length = 0;
      await w.live.rebuild();
      clean = w.said.length === 0;
    }
    for (let step = 0; step < OPS; step++) {
      const kind = r.weighted([5, 3, 2, 2, 1, 1]);
      let op = '';
      const expectLive: [string, string][] = [];
      const rowsBefore = JSON.stringify([...w.rows]);
      const diskBefore = JSON.stringify([...w.disk]);
      const worstBefore = layerViolators(goodLayer(w));
      const route = kind !== 3 && kind !== 5;
      let refused = false;
      w.said.length = 0;
      const v = (inv: string, msg: string): Violation => ({ seed, step, op, inv, msg });
      if (kind === 0 || kind === 1) {
        // ⭐ R22-02: «Применить везде» таблицы с битым файлом на диске — чаще, пока он там (редактор пишет поверх отказанного наблюдателем).
        const junk = [...w.garbage].filter((k): k is Cross => (CROSS as readonly string[]).includes(k));
        const keys: Cross[] = kind === 1 && junk.length && r.chance(0.6) ? [r.pick(junk)] : r.chance(0.35) ? [r.pick(CROSS), r.pick(CROSS)] : [r.pick(CROSS)];
        const body: Tables = {};
        for (const k of keys) body[k] = mutate(r, k, body[k] ?? w.config.get(k));
        const unknown = r.chance(0.06);   // ⭐ R22-07: таблица, которой в схеме нет (переименована, старая вкладка)
        if (unknown) body['nope-table'] = 1;
        const path = kind === 0 ? '/api/dev/config' : '/api/dev/config-file';
        const onJunk = kind === 1 && keys.some((k) => w.garbage.has(k));   // до вызова: запись «в файл» (если пройдёт) файл починит
        const st = await call(w, 'POST', path, body);
        op = `${path} ${Object.keys(body).join('+')}${onJunk ? ' (битый файл на диске)' : ''} → ${st}`;
        if (unknown) {
          if (st !== 422) return v('3-unknown-table', `ответ ${st}`);
          refused = true;
        } else if (st === 200) {
          if (onJunk) return v('3-drift-overwrite', 'таблица с битым файлом на диске записана поверх него живой');
          for (const [k, val] of Object.entries(body)) expectLive.push([k, parsed(k, val)]);
        } else if (st === 422 || (st === 409 && onJunk)) {
          refused = true;
          // ⭐ R22-06: отказ «в файл» обязан быть за дело: кандидат с оверрайдами базы правку держит (строгая проба «на сервер») и слой файлов
          // от неё не хуже — отказывать нечем (раньше — любое уже лежащее в файлах нарушение запирало любую правку).
          if (st === 422 && kind === 1 && await w.live.trial(body) === null && !worseThan(worstBefore, layerViolators({ ...goodLayer(w), ...body }))) {
            return v('3-refused-unjustified', 'отказ «в файл» правке, которую держит кандидат и которая слой файлов не ухудшает');
          }
        } else return v('6-status', `ответ ${st}`);
      } else if (kind === 2) {
        const held = CROSS.filter((k) => w.rows.has(k));
        const k = held.length && r.chance(0.8) ? r.pick(held) : r.pick(CROSS);   // чаще — таблицу, у которой оверрайд есть
        const st = await call(w, 'DELETE', `/api/dev/config/${k}`);
        op = `DELETE ${k} → ${st}`;
        if (st === 200) expectLive.push([k, parsed(k, goodTable(w, k))]);
        else if (st === 422) refused = true;
        else return v('6-status', `ответ ${st}`);
      } else if (kind === 3) {
        // ⭐ R22-02: правка файлов на диске (генератор, руки, git pull): один или пачка; битый файл чаще чинят; база иногда не отвечает.
        const junk = [...w.garbage].filter((k): k is Cross => (CROSS as readonly string[]).includes(k));
        const n = r.pick([1, 1, 2, 3]);
        const pool: Cross[] = [...CROSS];
        const keys: Cross[] = [];
        if (junk.length && r.chance(0.5)) keys.push(r.pick(junk));
        while (keys.length < n) { const k = r.pick(pool.filter((x) => !keys.includes(x))); keys.push(k); }
        for (const k of keys) { w.disk.set(k, mutate(r, k, goodTable(w, k))); w.garbage.delete(k); }
        const how = keys.length === 1 ? 'пачка' : r.pick(['пачка', 'по одному', 'разом'] as const);
        const fail = r.chance(0.2);
        w.failReads = fail ? 1 : 0;
        w.readFailed = false;
        if (opts.watch === 'legacy') await legacyWatch(w, keys).catch(() => undefined);
        else if (how === 'пачка') { for (const k of keys) w.watch.touched(fileName(k)); await w.watch.flush(); }
        else if (how === 'по одному') for (const k of keys) { w.watch.touched(fileName(k)); await w.watch.flush(); }
        else await Promise.allSettled(keys.map((k) => w.live.applyFile(k, clone(w.disk.get(k)))));
        if (w.readFailed) { for (const k of keys) w.watch.touched(fileName(k)); await w.watch.flush(); }   // повтор наблюдателя (его таймер)
        w.failReads = 0;
        op = `диск ${keys.join('+')} (${how}${fail ? ', база не ответила' : ''})${opts.watch === 'legacy' ? ' [прежний наблюдатель]' : ''}`;
        for (const k of keys) {
          if (!w.live.fileMatches(k, w.disk.get(k))) {
            if (opts.watch === 'live') return v('3-watch-refused', `годный схемой файл «${k}» на диске, а в основе живого — нет`);
            continue;   // прежний наблюдатель отказал — файл на диске остаётся: это и ловит рестарт
          }
          w.good.set(k, clone(w.disk.get(k)));
          // Файл, который сборка привела правилом поверх таблиц, сказан вслух (ИНЦИДЕНТ) — в живом приведённое.
          if (!w.said.some((s) => s.includes(`файл данных «${k}»`))) expectLive.push([k, parsed(k, w.disk.get(k))]);
        }
      } else if (kind === 4) {
        // Чужая правилу таблица — отказа по правилу поверх таблиц быть не может (⭐ R22-06: и «в файл» при слое файлов, уже нарушающем правило).
        const rar = clone(w.config.get('rarities'));
        rar[0]!.priceMult = Math.round((rar[0]!.priceMult + 0.1) * 100) / 100;
        const path = w.garbage.has('rarities') || r.chance(0.5) ? '/api/dev/config' : '/api/dev/config-file';
        const st = await call(w, 'POST', path, { rarities: rar });
        op = `${path} rarities → ${st}`;
        if (st !== 200) return v('3-unrelated-refused', `ответ ${st}`);
        expectLive.push(['rarities', parsed('rarities', rar)]);
      } else {
        // ⭐ R22-02: битый файл на диске (пойман на середине записи, опечатка) — наблюдатель его не берёт, живое прежнее.
        const k = r.pick([...CROSS, 'rarities']);
        const before = JSON.stringify(w.config.get(k as ConfigKey));
        w.disk.set(k, garbageOf(r, k, goodTable(w, k)));
        w.garbage.add(k);
        w.watch.touched(fileName(k));
        await w.watch.flush();
        op = `битый файл ${k} на диске`;
        if (w.live.fileMatches(k, w.disk.get(k))) return v('3-garbage-taken', `битый «${k}» в основе`);
        if (JSON.stringify(w.config.get(k as ConfigKey)) !== before) return v('3-garbage-taken', `живая «${k}» сменилась`);
      }
      if (process.env.DM_FUZZ_TRACE) process.stderr.write(`seed ${seed} step ${step}: ${op}\n`);
      const issues = configCrossIssues((k) => w.config.get(k));
      if (issues.length) return v('1-cross', issues.map((i) => i.msg).join(' | '));
      if (route && clean && w.said.length) return v('2-silent-change', w.said.join(' | '));
      for (const [k, want] of expectLive) if (JSON.stringify(w.config.get(k as ConfigKey)) !== want) return v(kind === 2 ? '3-reset' : '3-accepted-changed', `«${k}» в живом не то, что принято`);
      if (refused && route && JSON.stringify([...w.rows]) !== rowsBefore) return v('3-refused-wrote', 'отказ, а база изменилась');
      if (refused && route && JSON.stringify([...w.disk]) !== diskBefore) return v('3-refused-wrote', 'отказ, а файл на диске изменился');
      if (route) {
        const worse = worseThan(worstBefore, layerViolators(goodLayer(w)));
        if (worse) return v('5-files-worse', `слой файлов хуже: ${worse}`);
      }
      // Что говорит работающий процесс сейчас (его пересборка) — это же обязан сказать старт.
      w.said.length = 0;
      await w.live.rebuild();
      const saysNow = sorted(w.said);
      clean = w.said.length === 0;
      if (w.garbage.size) continue;   // с битым файлом на диске процесс не стартует — рестарт проверится, когда файл починят
      const rev = w.config.revision();
      const rows = [...w.rows];
      const shuffled = [...rows];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = r.int(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
      for (const [name, order] of [['обратный', [...rows].reverse()], ['случайный', shuffled]] as const) {
        let b: Boot;
        try { b = await opts.boot(order, new Map([...w.disk].map(([k, x]) => [k, clone(x)]))); } catch (e) { return v('4-boot-threw', `${name}: ${String(e).split('\n')[0]}`); }
        if (b.config.revision() !== rev) return v('4-restart', `${name} порядок строк: конфиг рестарта не тот, что у работающего${b.said.length ? ` (${b.said.join(' | ').slice(0, 300)})` : ''}`);
        if (sorted(b.said) !== saysNow) return v(clean ? '4-order' : '4-said', `${name} порядок строк: старт говорит не то, что работающий: ${b.said.join(' | ').slice(0, 400)}`);
      }
    }
    return null;
  } finally {
    w.watch.stop();
  }
}

describe('⭐ R21/R22: фаззер сборки живого конфига — порядок строк, рестарт, диск, принятое живёт, правило поверх таблиц', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it(`инварианты после каждой операции: ${SEEDS} сидов × ${OPS} операций`, async () => {
    const found: Violation[] = [];
    for (let seed = FROM; seed < FROM + SEEDS; seed++) {
      const bad = await runSeed(seed, { boot: bootLive, watch: 'live' });
      if (bad) found.push(bad);
    }
    expect(found).toEqual([]);
  }, Math.max(120_000, SEEDS * OPS * 2_500));   // долгий прогон — по его длине (операция ~0.25 с, под нагрузкой — кратно)

  it('самопроверка: прежняя сборка (по одному оверрайду в порядке строк, правило над полусобранным реестром) ловится', async () => {
    let caught: Violation | null = null;
    for (let seed = 1; seed <= 12 && !caught; seed++) caught = await runSeed(seed, { boot: bootLegacy, watch: 'live' });
    if (process.env.DM_FUZZ_TRACE) process.stderr.write(JSON.stringify(caught) + '\n');
    expect(caught, 'фаззер обязан поймать зависимость от порядка строк').not.toBeNull();
    expect(caught!.inv).toMatch(/^4-/);
  }, 120_000);

  it('⚠ R23-06 самопроверка: наблюдатель без сверки диска при взведении (файл окна старта не берёт никто) ловится', async () => {
    let caught: Violation | null = null;
    for (let seed = 1; seed <= 12 && !caught; seed++) caught = await runSeed(seed, { boot: bootLive, watch: 'noSweep' });
    expect(caught, 'фаззер обязан поймать файл окна старта, которого нет в живом').not.toBeNull();
    expect(caught!.inv).toBe('3-boot-missed');
  }, 120_000);

  it('⭐ R22-02 самопроверка: прежний наблюдатель (строгая проба одного файла, отказ — строкой, файл на диске) ловится', async () => {
    let caught: Violation | null = null;
    for (let seed = 1; seed <= 20 && !caught; seed++) caught = await runSeed(seed, { boot: bootLive, watch: 'legacy' });
    if (process.env.DM_FUZZ_TRACE) process.stderr.write(JSON.stringify(caught) + '\n');
    expect(caught, 'фаззер обязан поймать расхождение диска и живого').not.toBeNull();
    expect(caught!.inv).toMatch(/^4-(restart|said)/);
  }, 240_000);
});
