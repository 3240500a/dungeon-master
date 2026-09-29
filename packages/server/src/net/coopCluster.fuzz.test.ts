import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, generateItem, itemFromBaseId, createRng, playerSnapshot, packInventory, findFree, stashDims,
  isWalkableWorld, hasLineOfSight, isDifficultyUnlocked, runRecords, Cell, TILE,
  type ServerFrame, type SaveState, type Item, type RunConfig, type RunPlan, type RunNodeState, type PlayerInput, type Grid, type AccountStash,
} from '@dm/shared';
import { fuzzRng, mixSeed, shrinkOps, type FuzzRng } from './coopLifecycle.fuzzKit.js';
import { ClusterModel, NODE_DEAD_SEC, CLAIM_IDLE_SEC } from './coopCluster.fuzzKit.js';
import { LEASE_MS } from '../cluster/lease.js';

/**
 * ⭐ B1 (КЛАСТЕР): ФАЗЗЕР ЖИЗНЕННОГО ЦИКЛА КООПА НА ДВУХ НОДАХ. Продолжение `coopLifecycle.fuzz.test.ts` (одна нода): те же операции героев и
 * те же инварианты целостности, но игроков держат ДВА процесса — два настоящих `RoomManager` со своими комнатами, каждый в СВОЁМ экземпляре
 * графа модулей (`vi.resetModules` + свой `DM_NODE_ID`: у ноды своё имя, свои коды комнат, своё хранилище забегов и свой `clusterHooks`, как
 * у двух процессов), — с ОДНИМ реестром кластера (`coopCluster.fuzzKit.ts`: `char_claims`, `run_locks`, `cluster_nodes` по правилам SQL
 * `registry.ts`) и одной честной базой (версии сейва и сундука, исход фиксации неизвестен, сбои). Сердцебиение ноды — порядок `joinCluster`
 * (продлить своих, продлить забеги, удар, снять проигравших `fenceLost`, снять ушедших `releaseIdle`), загрузка — порядок `index.ts` (сброс
 * забегов `clearAllRuns`, снятие забегов прошлого процесса, хранилище забегов, менеджер, первый удар), слив — `installNodeShutdown`
 * (объявить, дописать кругами `flushAll`, снять ноду из реестра, выйти; ⭐ ENV2: дописка — до конца аренды ноды, а без аренды — 7,5 с), аренда —
 * `lease.ts` (⭐ ENV1: дошедший удар её продлевает, после конца — выход без записи; ⭐ R16 C-05: на исходе — не слив, а игра до её конца:
 * удар, дошедший до него, её продлевает, дошедший позже — нет).
 *
 * Операции сверх одной ноды: вход (и статус, и «Завершить») идёт через гейтвей (маршрут `/api/route`: код — к ноде буквы, иначе закрепление
 * или самая свободная), напрямую на ноду (старый адрес, устаревшая картина гейтвея) или на «чужую» ноду (`x` — не ту, что держит его забег);
 * падение ноды (`crash` — процесса нет: ни записей, ни ответов, сокеты игроков оборваны; `crashAt` — на N-м своём запросе к базе или реестру,
 * то есть посреди входа, записи, «Завершить», продолжения забега), слив (`drain`, и фоном — `bg`: слив идёт вперемешку с операциями),
 * перезапуск (`restart` — новый процесс с тем же именем), пауза сердцебиения (`stall` — нода жива, но реестр её не видит), раздел ноды с
 * базой (`partition` — все запросы ноды падают), сбои запросов реестра (`regFault`: закрепление, забег, продление, удар, маршрут — до
 * фиксации или «легло, ответ потерян»), ⭐ R16-02 пауза машины ноды дольше срока смерти (`suspend` — процесс стоит целиком, его часы не идут,
 * настенные потом догоняет chrony или стоят и они; реестр тем временем отдаёт её героев и забеги другой; из своего потока `W.pause`). События
 * кластера — из своего потока чисел (`W.env`): операции героев идут как шли.
 *
 * Процесс, чей это код, несут цепочки промисов и таймеры (`AsyncLocalStorage`, `inProc`): у мёртвого процесса таймеры не срабатывают, его
 * запросы не уходят и не отвечают (`gate`), а его лог и штрафы наблюдатели не видят. Операция, не закончившаяся за 30 с настоящего времени, —
 * `6-hang` (ожидание, которое не кончится).
 *
 * Инварианты — все из `coopLifecycle.fuzz.test.ts` (1–8, см. там; ⭐ R16 C-09: и `5-status-promise` — статус забега через гейтвей обещает цену
 * «Завершить» этой ноды, в том числе «мёртв, оплачено» строки после падения и слива) и кластерные:
 *  a — герой держится (сессия, грейс, тело) не больше чем одной живой нодой (`a-live-two-nodes`); живая сессия проигравшей копии снимается
 *      сердцебиением (`fenceLost`); ⭐ R16-02: нода, которую реестр не видел дольше аренды (пауза машины: часы процесса стояли), не оживает — её
 *      удар не доходит, а процесс уходит без записи (`a-dead-node-revived`; раньше продление вставляло отданное и отпущенное заново); ⭐ R17-01:
 *      и когда пауза легла ПОСЛЕ ответа сверки (`suspend.mid`: между сверкой и продлением своих или между продлением и ударом) — удар ложится
 *      только с проверкой в нём самом (`heartbeat(…, leased)`), и устаревший ответ сверки ноду не оживляет;
 *  b — забег идёт в подземелье не больше чем одной комнаты во всём кластере (`b-run-two-rooms`); нода не теряет держание забега, который её
 *      комната ведёт (`b-run-lock-lost` — ИНЦИДЕНТ сердцебиения); ⭐ R15-08: и не держит забег, который её комната отпустила (`b-run-lock-orphan`:
 *      продление или взятие, легшее в базу ПОСЛЕ отпуска, вставляло строку заново, и «Продолжить» на соседней ноде вело к исчезнувшей комнате;
 *      поздний ответ реестра — сбой `late` из своего потока `lateReg`);
 *  c — после падения ноды вещь не удвоена и не пропала между выжившей нодой и базой: правда героев упавшей ноды — строка базы (откат к ней
 *      законен: взятое после последней записи уходит с процессом), а взятое стоком возвращается только в строку своего героя;
 *  d — никто не заперт навсегда: после смерти ноды её закрепления и забеги освобождаются правилом держания (`NODE_DEAD_SEC`), отказ
 *      «забег идёт в другой комнате» называет живую комнату (кроме окна держания мёртвой ноды), а в конце, когда все ушли, ни одно
 *      закрепление и ни один забег не держатся без сессии и комнаты (`d-claim-stuck`, `d-run-lock-stuck`).
 *
 * Окружение: ОКНО ДИЗАЙНА — простой базы или сердцебиения короче `NODE_DEAD_SEC` (120 с): дольше реестр по дизайну отдаёт героев и забеги
 * молчащей ноды другой (R7-09 — «ИНЦИДЕНТ»). По умолчанию паузы и разделы (вместе) короче; `DM_FUZZ_OUTAGE_LONG=1` добавляет длинные. ⭐ ENV1
 * (проход правок 1): молчащая нода теперь отгораживает себя сама раньше срока (аренда): нарушение после длинного простоя — снова нарушение
 * (корень `ENV-outage-over-dead-sec` больше не прощается). Остаётся по дизайну только слив, чья дописка не легла до конца аренды (раздел с
 * базой дольше неё) — `ENV-drain-db-outage`: копии уходят с процессом (ИНЦИДЕНТ, R12-04), прогон на нём не падает. ⭐ Перепрогон R16: и (только
 * с `DM_FUZZ_OUTAGE_LONG`) двойной сбой — пауза машины дольше срока смерти, а реестр ноде недоступен и после неё, — `ENV-thaw-registry-silent`:
 * сверка R16-02 не доходит, и до конца аренды нода держит отданное (см. `KNOWN`). Найденные и ещё не
 * исправленные корни — `KNOWN` и тесты `it.fails` в конце; исправленные (K1, K2, K3, ENV1, ENV2 — проход правок 1; K3a–K3d — проход 2) —
 * те же сжатые последовательности тестами `it`: повтор держит правку. ⭐ K3 (передача вещи через землю записана наполовину: выброс лёг,
 * подъём — нет) закрыт целиком: окно было не «одна запись в пути», а всё время, пока поднятое жило в сумке без строки (пауза C-07 после сбоя,
 * упавшая запись без повтора, исход неизвестен — копия «на дописать», падение на самой записи, аренда, кончившаяся в простое базы, — и своё
 * выброшенное тоже). Теперь выброшенное переходит в сумку только после записи поднимающего с ним (`Room.pickThrown`); до неё вещь лежит на
 * земле, и процесс, умерший раньше, уносит её с землёй своей комнаты (сток по дизайну). Проверка видит мир между операциями, поэтому смерть
 * процесса посреди операции (`crashAt`) снимает, что лежало на земле его комнат (`killInc`): такая вещь — не «записанное и потерянное».
 *
 * Умолчание — фиксированные сиды (полный прогон — десятки секунд). `DM_FUZZ_SEEDS=N` — N сидов подряд с `DM_FUZZ_SEED0` (по умолчанию 1),
 * `DM_FUZZ_OPS` — длина последовательности, `DM_FUZZ_FAULTS=0` — без сбоев базы и реестра, `DM_FUZZ_SHRINK=0` — без сжатия,
 * `DM_FUZZ_SHRINK_KNOWN=1` — сжимать и известные корни, `DM_FUZZ_TRACE=1` — операции и состояние после каждой (и взятия, отпуски, продления забегов в реестре), `DM_FUZZ_LOG=<файл>` —
 * нарушения сразу в файл, `DM_FUZZ_SELFTEST=claim|runlock|fence|leak|held|lease|k1|k3|c09|r1508|r15settle|r1602|r1701` — самопроверка (сломать правило реестра, снятие проигравших,
 * отпускание закреплений, удержание выброшенного, аренду ноды, метку «мёртв, оплачено» в строке, подъём выброшенного только после записи,
 * «смерть оплачена» в статусе забега, сверку возраста удара с реестром после паузы машины, проверку живости в самом ударе сердца —
 * фаззер обязан найти), `DM_FUZZ_REPLAY='{"seed":…,"ops":[…]}'` — повтор. Нарушение
 * печатается с сидом и СЖАТОЙ последовательностью (сжатие держит метку и корень). Большой прогон — параллельно, диапазонами сидов:
 *   DM_FUZZ_SEEDS=250 DM_FUZZ_SEED0=10000 npx vitest run packages/server/src/net/coopCluster.fuzz.test.ts
 */

const FUZZ_SEEDS = Number(process.env.DM_FUZZ_SEEDS ?? 0) || 0;
const FUZZ_SEED0 = Number(process.env.DM_FUZZ_SEED0 ?? 1) || 1;
const FUZZ_OPS = Number(process.env.DM_FUZZ_OPS ?? 0) || 0;
const FUZZ_SHRINK = process.env.DM_FUZZ_SHRINK !== '0';
const FUZZ_TRACE = process.env.DM_FUZZ_TRACE === '1';
const FUZZ_FAULTS = process.env.DM_FUZZ_FAULTS !== '0';
const FUZZ_LOG = process.env.DM_FUZZ_LOG;
const FUZZ_SELFTEST = process.env.DM_FUZZ_SELFTEST ?? '';
/** Паузы и разделы дольше `NODE_DEAD_SEC` (за окном дизайна) — только по просьбе. */
const OUTAGE_LONG = process.env.DM_FUZZ_OUTAGE_LONG === '1';
/**
 * ⭐ R16-02: самопроверка `r1602` — и из теста (зубы сценария паузы машины идут в прогоне по умолчанию). ⭐ R17-01: `r1701` — удар сердца без
 * проверки живости в нём самом (безусловная вставка, как до правки), сверка и продление — как есть.
 */
const teeth = { r1602: FUZZ_SELFTEST === 'r1602', r1701: FUZZ_SELFTEST === 'r1701' };
function logLine(s: string): void { if (FUZZ_LOG) appendFileSync(FUZZ_LOG, `${s}\n`); }
vi.setConfig({ testTimeout: FUZZ_SEEDS ? 24 * 3600_000 : 180_000 });
/** Прогон по умолчанию (полный прогон тестов): сиды и длина — десятки секунд на машине разработчика. */
const DEFAULT_SEEDS = Array.from({ length: 24 }, (_, i) => 1 + i);
const DEFAULT_OPS = 110;
/**
 * ⭐ E2E 28.09: круг дописки слива — ломоть `DRAIN_ROUND_MS` (1 с) и пауза до `DRAIN_RETRY_MAX_MS` (0,5 с) в `roomManager.ts`. База, вернувшаяся
 * ближе к концу бюджета слива, получает от него одну попытку: сбой на ней — та же «дописка не легла до конца аренды» (`ENV-drain-db-outage`).
 */
const DRAIN_LAST_TRY_MS = 1_500;
/** Нод в кластере. */
const NODES = 2;
const BEAT_MS = 2_000;
/**
 * Окно дизайна: паузы и разделы (вместе) — не дольше этого с последнего дошедшего удара (`NODE_DEAD_SEC` с запасом на удар и шаг). ⭐ R16 C-05:
 * и через конец аренды ноды (`LEASE_MS`, 112 с): окно было 100 с — простой в 104–120 с (слив по аренде, которого не отменял дошедший удар)
 * не встречался ни разу.
 */
const OUTAGE_CAP_MS = (NODE_DEAD_SEC - 6) * 1000;
const DRAIN_GUARD_MS = 8_000;
const DRAIN_FLUSH_MS = DRAIN_GUARD_MS - 500;
/** ⭐ ENV2: слив дописывает до конца аренды ноды (`node.ts`, `drainBudget`): дольше неё — никогда. */
const DRAIN_MAX_MS = LEASE_MS;

// ── Детерминированные броски окружения (как у фаззера одной ноды) ──────────────────────────────────────────────────────────────────
const env = vi.hoisted(() => {
  let a = 1;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, reseed(s: number): void { a = s >>> 0; } };
});
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  const bytes = (n: number): Buffer => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = Math.floor(env.next() * 256); return b; };
  const over = {
    randomInt: (a: number, b?: number): number => { const [lo, hi] = b === undefined ? [0, a] : [a, b]; return lo + Math.floor(env.next() * (hi - lo)); },
    randomFillSync: <T extends NodeJS.ArrayBufferView>(buf: T): T => {
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(env.next() * 256);
      return buf;
    },
    randomUUID: (): string => {
      const h = bytes(16).toString('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    randomBytes: (n: number): Buffer => bytes(n),
  };
  return { ...orig, ...over, default: { ...orig, ...over } };
});

// ── Общие для всех нод модули: shared (со штрафом под наблюдением), метрики, лимиты ────────────────────────────────────────────────
/**
 * Экземпляр графа модулей у каждого процесса ноды свой (`boot`), но эти три — один на всех: `@dm/shared` (тяжёлый, без состояния процесса,
 * и в нём шпион штрафа), метрики (в модуле — живой замер цикла событий: на каждый экземпляр он оставался бы включённым) и лимиты частоты
 * (сняты: не предмет фаззера). Фабрика моков запоминает модуль — повторный граф получает тот же.
 */
const spy = vi.hoisted(() => ({
  onPenalty: null as null | ((save: SaveState, removed: string[], goldLost: number, stack: string) => void),
  memo: new Map<string, unknown>(),
}));
vi.mock('@dm/shared', async (importOriginal) => {
  const hit = spy.memo.get('shared');
  if (hit) return hit as typeof import('@dm/shared');
  const m = await importOriginal<typeof import('@dm/shared')>();
  const mod = {
    ...m,
    applyDeathPenalty: (save: SaveState, penalty: Parameters<typeof m.applyDeathPenalty>[1], rng?: Parameters<typeof m.applyDeathPenalty>[2]) => {
      const before = save.inventory.map((i) => i.uid);
      const gold = save.gold;
      const r = m.applyDeathPenalty(save, penalty, rng);
      const after = new Set(save.inventory.map((i) => i.uid));
      spy.onPenalty?.(save, before.filter((u) => !after.has(u)), gold - save.gold, new Error().stack ?? '');
      return r;
    },
  };
  spy.memo.set('shared', mod);
  return mod;
});
vi.mock('./metrics.js', async (importOriginal) => {
  if (!spy.memo.has('metrics')) spy.memo.set('metrics', await importOriginal());
  return spy.memo.get('metrics') as typeof import('./metrics.js');
});
vi.mock('./rateLimit.js', async (importOriginal) => {
  if (!spy.memo.has('rateLimit')) spy.memo.set('rateLimit', await importOriginal());
  return spy.memo.get('rateLimit') as typeof import('./rateLimit.js');
});

/** Невидимые поля сейва: номер прогона и процесс (экземпляр ноды), прочитавший его из базы. */
const RUN_TAG = '__fuzzRun';
const INC_TAG = '__fuzzInc';

// ── Маленькая честная база (одна на кластер) ─────────────────────────────────────────────────────────────────────────────────────────
type FaultKind = 'fail' | 'deadlock' | 'unknownLost' | 'unknownLanded' | 'stashConflict';
const db = vi.hoisted(() => ({
  rows: new Map<string, { userId: string; json: string; version: number }>(),
  stash: new Map<string, { json: string; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
  sessions: new Map<string, string>(),
  faults: [] as { kind: FaultKind; charId?: string }[],
  consumed: 0,
  run: 0,
  unknownStreak: new Map<string, number>(),
  doubleUnknown: new Set<string>(),
  writes: [] as { charId: string; v: number; ok: boolean; reason: string; stash: boolean; json?: string; src?: SaveState; seq?: number }[],
  /** Сквозной номер легшей записи: штраф, записанный ПОЗЖЕ себя тем же объектом сейва, — лёг (см. `landed`). */
  wseq: 0,
}));

/** Запросы базы — как в `coopLifecycle.fuzz.test.ts`; процесс ноды получает их через свои ворота (`dbFor`). */
function dbCore(CommitUnknown: typeof import('../db/errors.js').CommitUnknown) {
  const take = (charId: string, withStash: boolean): FaultKind | undefined => {
    const i = db.faults.findIndex((f) => (f.charId === undefined || f.charId === charId) && (withStash || f.kind !== 'stashConflict'));
    if (i < 0) return undefined;
    db.consumed++;
    const kind = db.faults.splice(i, 1)[0]!.kind;
    if (kind === 'unknownLost' || kind === 'unknownLanded') {
      const n = (db.unknownStreak.get(charId) ?? 0) + 1;
      db.unknownStreak.set(charId, n);
      if (n >= 2) db.doubleUnknown.add(charId);
    }
    return kind;
  };
  const unknown = (json: string): Error => { const e = new CommitUnknown(new Error('Query read timeout')); e.sent = json; return injected(e); };
  const uniq = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);
  return {
    getSession: async (token: string) => db.sessions.get(token) ?? null,
    getCharacter: async (charId: string) => {
      const r = db.rows.get(charId);
      if (!r) return null;
      const data = JSON.parse(r.json) as SaveState;
      // Самопроверка `k1`: «мёртв, оплачено» (`run.deadAt`) из строки не доходит до входа (K1 снят) — погибший после падения ноды встаёт живым (2).
      if (FUZZ_SELFTEST === 'k1' && data.run) delete data.run.deadAt;
      Object.defineProperty(data, RUN_TAG, { value: db.run, enumerable: false });
      return { userId: r.userId, data, version: r.version };
    },
    putCharacter: async (charId: string, userId: string, data: SaveState, v: number, reason = 'autosave') => {
      const json = JSON.stringify(data);
      const f = take(charId, false);
      if (f === 'fail') throw injected(new Error('база упала'));
      if (f === 'deadlock') throw injected(Object.assign(new Error('обнаружена взаимоблокировка'), { code: '40P01' }));
      if (f === 'unknownLost') throw unknown(json);
      const r = db.rows.get(charId);
      if (!r || r.userId !== userId || r.version !== v) { db.writes.push({ charId, v, ok: false, reason, stash: false }); return null; }
      r.version = v + 1; r.json = json;
      db.writes.push({ charId, v, ok: true, reason, stash: false, json, src: data, seq: ++db.wseq });
      if (f !== 'unknownLanded') db.unknownStreak.delete(charId);
      if (f === 'unknownLanded') throw unknown(json);
      return r.version;
    },
    putCharacterWithStash: async (charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number, reason = 'stash') => {
      const json = JSON.stringify(data);
      const f = take(charId, true);
      if (f === 'fail') throw injected(new Error('база упала'));
      if (f === 'deadlock') throw injected(Object.assign(new Error('обнаружена взаимоблокировка'), { code: '40P01' }));
      if (f === 'stashConflict') return { ok: false, conflict: 'stash' };
      if (f === 'unknownLost') throw unknown(json);
      const r = db.rows.get(charId);
      if (!r || r.userId !== userId || r.version !== v) { db.writes.push({ charId, v, ok: false, reason, stash: true }); return { ok: false, conflict: 'save' }; }
      const st = db.stash.get(userId);
      if (sv !== (st?.version ?? 0)) return { ok: false, conflict: 'stash' };
      r.version = v + 1; r.json = json;
      db.stash.set(userId, { json: JSON.stringify(stash), version: sv + 1 });
      db.writes.push({ charId, v, ok: true, reason, stash: true, json, src: data, seq: ++db.wseq });
      if (f !== 'unknownLanded') db.unknownStreak.delete(charId);
      if (f === 'unknownLanded') throw unknown(json);
      return { ok: true, version: r.version, stashVersion: sv + 1 };
    },
    landedVersion: async (charId: string, json: string, expected: number) => {
      const r = db.rows.get(charId);
      return r && r.version === expected + 1 && r.json === json ? r.version : null;
    },
    createCharacter: async () => 1,
    getAccountStash: async (userId: string) => {
      const st = db.stash.get(userId);
      return st ? { data: JSON.parse(st.json) as AccountStash, version: st.version } : null;
    },
    putAccountStash: async () => undefined,
    getRunLedger: async (key: string) => [...(db.ledger.get(key)?.values() ?? [])].map((r) => structuredClone(r)),
    mergeRunLedger: async (key: string, recs: readonly { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }[]) => {
      let m = db.ledger.get(key);
      if (!m) db.ledger.set(key, (m = new Map()));
      for (const r of recs) {
        const cur = m.get(r.id);
        m.set(r.id, cur
          ? { id: r.id, el: cur.el, chests: uniq([...cur.chests, ...r.chests]), killed: uniq([...cur.killed, ...r.killed]), levers: uniq([...cur.levers, ...r.levers]) }
          : structuredClone(r));
      }
    },
  };
}

// ── Процесс, который сейчас исполняется ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * ЧЕЙ ЭТО КОД: процесс ноды (`Inc`), в котором идёт вызов, — его несут цепочки промисов и таймеры (обёртка таймеров в `run`). Процесса нет —
 * его таймеры не срабатывают, а цепочки, уже стоявшие в очереди, не пишут в лог и не штрафуют (наблюдатели их не видят): у мёртвого процесса
 * нет ни времени, ни голоса.
 */
const als = new AsyncLocalStorage<Inc>();
function inProc<T>(inc: Inc | undefined, fn: () => T): T { return inc ? als.run(inc, fn) : fn(); }
const deadCode = (): boolean => als.getStore()?.dead === true;

// ── Соединение ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class FakeConn implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  closedWith?: number;
  hero?: number;
  roomCode?: string;
  run?: number;
  resume?: boolean;
  /** Процесс ноды, к которому подключён сокет. Процесса не стало (падение, слив) — сокет оборван без его обработчиков (`kill`). */
  inc?: Inc;
  killed = false;
  static onFrame: ((c: FakeConn, f: ServerFrame) => void) | null = null;
  static onServerClose: ((c: FakeConn, code?: number) => void) | null = null;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  send(raw: string | Uint8Array): void {
    if (this.killed || typeof raw !== 'string') return;
    const f = JSON.parse(raw) as ServerFrame;
    if (FUZZ_SELFTEST === 'c09' && f.t === 'runStatus') delete f.dead;   // R16 C-09: статус без «смерть оплачена» — как до правки
    this.frames.push(f);
    FakeConn.onFrame?.(this, f);
    if (this.frames.length > 400) this.frames.splice(0, 200);
  }
  close(code?: number): void {
    if (!this.open) return;
    this.open = false; this.closedWith = code;
    if (this.killed) return;
    FakeConn.onServerClose?.(this, code);
    inProc(this.inc, () => this.onEnd());
  }
  /** Процесс ноды умер: сокет закрыт, но ни закрытия, ни кадров процесс уже не обработает. */
  kill(): void { this.killed = true; this.open = false; }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void {
    if (this.killed) return;
    if (this.inc) process.env.DM_NODE_ID = this.inc.node;   // коды комнат — буквой этой ноды (`newCode` читает имя ноды при вызове)
    const raw = JSON.stringify(frame);
    inProc(this.inc, () => this.onMsg(raw));
  }
  since(i: number): ServerFrame[] { return this.frames.slice(Math.max(0, i)); }
}

// ── Внутренности комнаты и менеджера (это тест) ─────────────────────────────────────────────────────────────────────────────────
type Pt = { x: number; y: number };
type Derived = { maxHp: number; maxMana: number; maxStamina: number; hpRegen: number; manaRegen: number; staminaRegen: number };
type PlayerIn = {
  id: string; hp: number; maxHp: number; mana: number; stamina: number; alive: boolean; pos: Pt; vel: Pt; save: SaveState;
  debuffs: Record<string, unknown>;
};
type MonIn = { id: number; alive: boolean; hp: number; pos: Pt; aiState: string };
type DropIn = { id: number; kind: string; item?: Item; pos: Pt; owner?: string; heldBy?: string };
type ClientIn = { pid: string; userId: string; saveVersion: number; stale: boolean; unsure: string[]; ws: GameConn };
type InfoIn = { save: SaveState; userId: string; saveVersion: number; paid: boolean; fled: boolean; fledDescend: boolean; safe?: boolean };
type RoomIn = {
  step(emit?: boolean): void;
  code: string; area: 'town' | 'dungeon' | 'arena'; depth: number; difficultyId: string;
  /** Продолжение забега из города ждёт базу (свод, взятие — R9-01): комната уже на переходе в подземелье. */
  resuming: boolean;
  clients: Map<string, ClientIn>; disconnected: Map<string, InfoIn>; lingering: Map<string, { pid: string; p: PlayerIn; info: InfoIn }>;
  staleFarewells: Map<string, { charId: string; farewell: { saved: boolean } }>;
  /** ⭐ K3: выброшенное, которое сейчас поднимают (`Room.pickThrown`: запись поднимающего в пути) — до её конца вещь не в сумке. */
  carrying: Set<DropIn>;
  runConfig: RunConfig | null; runPlan: RunPlan | null; runNodeId: string | null; nodeState: RunNodeState | null;
  ledger: Map<string, RunNodeState>;
  decor: { kind: string; x: number; y: number }[];
  session: {
    world: {
      players: Record<string, PlayerIn>; monsters: MonIn[]; drops: DropIn[]; chests: { id: number; pos: Pt; opened: boolean }[];
      spawn: Pt; exits?: Pt[]; grid: Grid; timeMs: number;
    };
    snapshotOf(pid: string): { derived: Derived } | undefined;
  };
  setInput(pid: string, input: PlayerInput): void;
  stop(): void;
  holdsRun(key: string): boolean;
};
type RmIn = {
  rooms: Map<string, RoomIn>; conns: Map<GameConn, { pid: string; room: RoomIn }>; live: Map<string, GameConn>;
  graceByChar: Map<string, RoomIn>; unsaved: Map<string, unknown>; inflight: Map<string, unknown>; charOps: Map<string, unknown>;
  runRooms: Map<string, RoomIn>;
  retryUnsaved(now?: number): Promise<void>;
  handleConnection(ws: GameConn): void;
  flushAll(budgetMs?: number): Promise<void>;
};
type ClusterHooksIn = {
  liveCharIds(): string[]; fenceLost(ids: readonly string[]): void; releaseIdle(ids: readonly string[]): void; heldRuns(): { key: string; room: string }[];
  fenceRuns(runs: readonly { key: string; room: string }[]): void; releaseRuns(runs: readonly { key: string; room: string }[]): void;
};
/** Реестр кластера, как его видит процесс ноды (`cluster/registry.ts`) — ворота процесса поверх модели (`registryFor`). */
type RegIn = {
  releaseChar(c: string, n: string): Promise<void>; claimForJoin(c: string, n: string): Promise<string>; claimOwner(c: string): Promise<string | null>;
  claimRun(k: string, n: string, r: string): Promise<string | null>; releaseRun(k: string, n: string, r: string): Promise<void>;
  touchClaims(ids: readonly string[], n: string, leased?: boolean): Promise<Set<string>>;
  touchRuns(rs: readonly { key: string; room: string }[], n: string, leased?: boolean): Promise<Set<string>>;
  /** ⭐ R17-01: `leased` — удар ноды с арендой: ложится, только пока реестр видел её меньше аренды назад; `false` — не лёг. */
  heartbeat(n: string, s: { players: number; rooms: number; draining: boolean }, leased?: boolean): Promise<boolean>;
  /** ⭐ R16-02: давно ли реестр видел удар ноды (часы базы), с; строки нет — `null`. */
  nodeBeatAge(n: string): Promise<number | null>;
  releaseNode(n: string): Promise<void>; releaseNodeRuns(n: string): Promise<number>; clearAllRuns(self: string): Promise<number>;
};

/**
 * ПРОЦЕСС НОДЫ: экземпляр графа модулей с менеджером комнат. `dead` — процесса нет (упал, слит, не загрузился): его запросы к базе и
 * реестру не уходят и не отвечают, его таймеры и комнаты ничего не делают для мира (проверки их не видят). У имени ноды процессы сменяют
 * друг друга (`restart`).
 */
interface Inc {
  node: string; n: number; gen: number;
  dead: boolean; diedAt: number; why: string;
  /** Слив объявлен (`isDraining`), нода снимается (`stopped` — новых ударов сердца нет). */
  draining: boolean; stopped: boolean;
  /** Удары сердца не доходят до реестра до этого часа (`stall`); запросы к базе и реестру падают до этого часа (`partition`). */
  stallUntil: number; partitionUntil: number;
  /** Когда удар сердца ноды последний раз дошёл до реестра. */
  lastBeatOk: number;
  /** Сколько ещё запросов (кроме сердцебиения) до падения процесса (`crashAt`); 0 — не назначено. */
  crashAt: number;
  /** Самопроверка `leak`: все, кого процесс держал. */
  ever: Set<string>;
  /**
   * ⭐ R16-02: машина ноды на паузе (`suspend`) с этого часа (0 — не на паузе) до `frozenUntil`: процесс стоит целиком. `frozenLeft` — остаток
   * аренды по часам процесса на начало паузы, `frozenWall` — настенные часы после паузы догнал chrony (иначе стояли и они); `held` — таймеры,
   * пришедшие в паузу (сработают через свой остаток на её начало); `sentAt` — настенный час отправки удара, последним продлившего аренду.
   */
  frozenAt: number; frozenUntil: number; frozenLeft: number; frozenWall: boolean;
  held: Map<unknown, { at: number; run: () => void }>;
  sentAt: number;
  /** ⭐ R16-02: процесс вернулся с паузы машины: его тишина в реестре — пауза, а не простой базы (окно дизайна `envelope` — не про неё). */
  thawed: boolean;
  /**
   * ⭐ R16-02: мир списал процесс на паузе (`forget`) и с тех пор он ничего не делал: его смерть сразу после возвращения — без второго отката
   * (герои, что он держал, давно живут строкой базы или на другой ноде, и их правда — там).
   */
  writtenOff: boolean;
  /**
   * ⭐ R17-01: пауза машины ляжет посреди удара сердца (`suspend.mid`): `claims` — сразу после ответа сверки возраста удара (ответ «жива» ждёт
   * в буфере сокета всю паузу), `beat` — между продлением своих и ударом. `resumeBeat` — продолжить удар, вставший на паузе (`thaw`),
   * `pausedBeat` — сам этот удар.
   */
  midPause?: { at: 'claims' | 'beat'; ms: number; wall: boolean };
  resumeBeat?: () => void;
  pausedBeat?: Promise<void>;
  rm: RmIn; hooks: ClusterHooksIn; reg: RegIn;
  /** ⭐ ENV1: аренда процесса (`lease.ts` его графа модулей: её же читают его комнаты и менеджер). */
  lease: typeof import('../cluster/lease.js');
  runLedgerKey: (cfg: RunConfig) => string;
  timer?: ReturnType<typeof setInterval>;
}

// ── Операции ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Where = 'entry' | 'exit' | 'portal' | 'away' | 'monster' | 'drop' | 'chest';
type Others = 'none' | 'yes' | 'no';
/**
 * Куда идёт кадр лобби: через гейтвей (`gw`), прямо на ноду `n` (старый адрес, устаревшая картина гейтвея) или на «чужую» ноду (`x`) — не ту,
 * что держит забег героя (или его закрепление, или его прошлый сокет): гейтвей, чьё закрепление маршрута протухло, отправил его к самой
 * свободной. Так чаще всего и встречаются две ноды одного забега.
 */
type Via = 'gw' | 'x' | number;
type RegOp = 'claimForJoin' | 'claimOwner' | 'releaseChar' | 'claimRun' | 'releaseRun' | 'touchClaims' | 'touchRuns' | 'heartbeat' | 'route';
type Op =
  | { k: 'join'; h: number; mode: 'fresh' | 'resume' | 'code' | 'friend'; r: number; reuse: boolean; via: Via }
  | { k: 'status'; h: number; via: Via }
  /**
   * ⭐ R16 C-09: `ask` — экран входа: статус забега и «Завершить» с него же, одним соединением одной ноды, и что экран обещал (`runStatus.dead`
   * — «без штрафа»), то «Завершить» и сделало (`5-status-promise`). Флаг — из своего потока (`W.ask`).
   */
  | { k: 'abandon'; h: number; via: Via; ask?: boolean }
  | { k: 'leave'; h: number }
  | { k: 'close'; h: number }
  | { k: 'move'; h: number; to: Where; r: number }
  | { k: 'hurt'; h: number; frac: number }
  | { k: 'kill'; h: number; body: boolean }
  | { k: 'potion'; h: number; belt: boolean; r: number }
  | { k: 'attack'; h: number; r: number; weaken: boolean }
  | { k: 'descend'; h: number; r: number; others: Others; near: boolean; pause?: boolean; diff?: number }
  | { k: 'town'; h: number; others: Others; near: boolean; pause?: boolean }
  | { k: 'arena'; h: number; others: Others; pause?: boolean }
  | { k: 'vote'; h: number; yes: boolean }
  | { k: 'step'; n: number }
  | { k: 'wait'; ms: number }
  | { k: 'drop'; h: number; r: number }
  | { k: 'pickup'; h: number; r: number }
  | { k: 'trade'; h: number; r: number }
  | { k: 'stash'; h: number; r: number; out: boolean }
  | { k: 'sell'; h: number; r: number }
  | { k: 'chest'; h: number; r: number }
  | { k: 'fault'; f: FaultKind; h: number | null }
  | { k: 'retry' }
  | { k: 'recruit' }
  // ── кластер ──
  | { k: 'crash'; n: number }
  /** Процесс умрёт на `calls`-м своём запросе к базе или реестру (кроме сердцебиения) — посреди входа, записи, «Завершить», продолжения забега. */
  | { k: 'crashAt'; n: number; calls: number }
  /** `bg` — слив идёт своим ходом (до 8 с поддельного времени), пока идут другие операции: входы, кадры, соседняя нода. */
  | { k: 'drain'; n: number; bg?: boolean }
  | { k: 'restart'; n: number }
  /** `long` — за окном дизайна (дольше `NODE_DEAD_SEC`, `DM_FUZZ_OUTAGE_LONG`): сжатая последовательность повторяется и без переменной. */
  | { k: 'stall'; n: number; ms: number; long?: true }
  | { k: 'partition'; n: number; ms: number; long?: true }
  /**
   * ⭐ R16-02: машина ноды на паузе `ms` — дольше `NODE_DEAD_SEC` (ВМ на паузе, сон хоста): процесс стоит целиком (таймеры, комнаты, сокеты),
   * его часы (`performance.now`) не идут, а настенные после возобновления догоняет chrony (`wall`; нет — стояли и они). Реестр тем временем
   * числит ноду мёртвой (операция сразу доводит время до её срока смерти): её героев и забеги берут и отпускают на другой ноде. Возобновление —
   * на границе операции, когда время дошло до конца паузы (и в эпилоге). Из своего потока (`W.pause`).
   */
  | { k: 'suspend'; n: number; ms: number; wall: boolean; mid?: 'claims' | 'beat' }
  /** ⭐ R15-08: `late` — запрос реестра ляжет с опозданием (`LATE_MS` поддельного времени): между отправкой и «легло» идут шаги и операции. */
  | { k: 'regFault'; op: RegOp; kind: 'fail' | 'landed' | 'late'; n: number | null };

interface Violation { inv: string; msg: string; op: number; seed: number; faults: number; cause?: string }
interface Hero {
  i: number; charId: string; userId: string; token: string;
  conn: FakeConn | null; cmd: number;
  lastSave?: SaveState;
  cap: { hp: number; mana: number; stamina: number; at: number } | null;
  level: number; xp: number;
  deadOn: Set<string>;
  penaltyEv: number; revivedEv: number; revivals: number[];
  reached: Set<string>; depthMax: Map<string, number>; progMax: Map<string, number>;
  wasDead: boolean;
  deadRun: string | null; deadRoom: RoomIn | null; deadInst: string | null;
  droppedDead: boolean;
  lastPen: Penalty | null;
  deadSeenEv: number;
}
interface PreState {
  kind: 'live' | 'disc' | 'off'; area?: string; alive?: boolean; safe?: boolean; paid?: boolean; fled?: boolean; fledDescend?: boolean; body?: boolean;
  foreign?: boolean;
  /** ⭐ Перепрогон R15: комната живого на переходе в подземелье (продолжение ждёт базу, `resuming`). */
  moving?: boolean;
}
/** `seq` — номер последней легшей записи к моменту штрафа (`db.wseq`): запись этого же объекта сейва позже — штраф в базе. */
interface Penalty { charId: string; removed: string[]; gold: number; src: string; op: number; save: SaveState; ev: number; run: string | null; where: string | null; seq: number }
interface W {
  seed: number; heroes: Hero[]; rng: FuzzRng; aux: FuzzRng; crew: FuzzRng; env: FuzzRng;
  /** ⭐ R16 C-09: свой поток и у «статус перед Завершить» (`abandon.ask`) — последовательность операций та же. */
  ask: FuzzRng;
  /**
   * ⭐ R16 C-09: «Завершить» операции со статусом перед ним (`abandon.ask`): соединение, герой, чисто ли (ни его кадров лобби в очереди, ни живой
   * сессии нигде; сбоев базы и реестра на начало — `faults`, `reg`), и что сказал статус в миг ответа (`st`).
   */
  asked: {
    conn: FakeConn; charId: string; quiet: boolean; faults: number; reg: number;
    st?: { dead: boolean; hasRun: boolean; live: boolean; hadRun: boolean; grace: boolean };
  } | null;
  penaltyCount: Map<string, number>;
  ticking: Set<RoomIn>; lobbies: FakeConn[];
  born: WeakSet<RoomIn>;
  pending: { conn: FakeConn; charId: string; t: 'join' | 'runStatus' | 'abandon'; idx: number; at: number; op: number }[];
  violations: Violation[]; seen: Set<string>;
  penalties: Penalty[];
  sinks: Set<string>; lastLoc: Map<string, string>;
  /**
   * ⭐ K3: поднимаемое (запись поднимающего в пути, `carrying`), чья земля ушла (смена этажа, снятие комнаты): `groundGone` его стоком не
   * числит — легла запись, вещь в сумке. Не легла — ушло с землёй (сток): это решает проверка, когда запись кончилась.
   */
  carryGone: Set<string>;
  sunkBy: Map<string, string>;
  sold: Set<string>;
  /** c: вещи, которые хоть раз лежали в базе (строка героя, сундук аккаунта) — их пропажа при откате к базе не «ещё не записанное». */
  durableSeen: Set<string>;
  /** K3: вещи, побывавшие на земле (видены там проверкой или подняты операцией `pickup`/`trade`) — их пропажа при откате — передача наполовину. */
  fromGround: Set<string>;
  ev: number;
  /** ⭐ R16-09: счётчик событий на начало операции (`preState`). */
  opEv0: number;
  recs: Map<string, { chests: Set<number>; killed: Set<number> }>;
  roomSeen: WeakMap<RoomIn, { key: string; st: RunNodeState; chests: Set<number>; killed: Set<number> }>;
  ids: WeakMap<object, number>; idSeq: number;
  errors: string[]; cmdFailed0: number; frameErrors0: number;
  op: number; opRef: Op | null; stepped: boolean;
  // ── кластер ──
  cluster: ClusterModel;
  /** Текущий процесс каждой ноды (может быть мёртвым). */
  nodes: Inc[];
  incs: Inc[]; incSeq: number;
  roomInc: WeakMap<RoomIn, Inc>;
  regFaults: { op: RegOp; kind: 'fail' | 'landed' | 'late'; node?: string }[];
  /** ⭐ R15-08: свой поток поздних ответов реестра (`late`) — прежние операции идут как шли. */
  lateReg: FuzzRng;
  /** ⭐ R16-02: свой поток пауз машины ноды (`suspend`) — прежние операции идут как шли. */
  pause: FuzzRng;
  /** ⭐ R17-01: и свой — у места паузы посреди удара сердца (`suspend.mid`): поток пауз не сдвигается. */
  midPause: FuzzRng;
  /** ⭐ R15-08: поздних запросов реестра в пути; когда комната отпустила забег (`ключ@нода@комната` → час) — для `b-run-lock-orphan`. */
  lateInFlight: number; runReleasedAt: Map<string, number>;
  /**
   * ⭐ Перепрогон R16: порядок запросов реестра по забегам (`regSeq`): когда лёг отпуск (`ключ@нода@комната` → номер). Взятие той же
   * комнаты, ОТПРАВЛЕННОЕ после него, — новое держание, и прежний отпуск ему не судья; отправленное до него и легшее позже (R15-08) — судья.
   */
  regSeq: number; releasedSeq: Map<string, number>;
  /**
   * ⭐ Перепрогон R15: отпуск забега, не дошедший до реестра (`ключ@нода@комната` → час сбоя) — нода повторяет его ударом (`runsDue`): до её
   * следующего дошедшего удара сирота законна. И что реестр ответил на взятие (`ключ@комната` держателя → час): отказ «Продолжить» пересказывает его.
   */
  releaseFailedAt: Map<string, number>; claimSaw: Map<string, number>;
  /** Герои, чья правда откатилась к строке базы (упала нода, копия снята проигравшей) — сверка вещей (c) на ближайшей проверке. */
  rolledBack: Set<string>;
  /** События кластера (падения, сливы, паузы, разделы) — в тексте нарушения и для корня. */
  events: string[];
  /** Было окно простоя дольше `NODE_DEAD_SEC` (за окном дизайна). */
  envelope: boolean;
  /** Кластерные события были (сверка «второго писателя» — только без них). */
  clusterTouched: boolean;
  /** Исключения команд и кадров от сбоев, заказанных фаззером (раздел с базой, сбой реестра), — с прошлой проверки. */
  expectCmd: number; expectFrame: number;
  /** Нрав кластера прогона (от сида): как часто события кластера и как быстро супервизор поднимает упавшую ноду. */
  clusterP: number; restartP: number;
  /** Слив во время раздела с базой унёс копии и свод (ИНЦИДЕНТ по дизайну): их последствия — тот же корень. */
  drainLost: boolean;
  /** K2: на падении процесса взятое на узле было в строке героя в базе, а в своде забега в базе — нет. */
  ledgerBehind: boolean;
  /**
   * ⭐ Перепрогон R16: нода вернулась с паузы машины, а реестр ей ещё недоступен (длинная пауза сердцебиения или раздел с базой дольше паузы —
   * только `DM_FUZZ_OUTAGE_LONG`): сверка R16-02 не доходит, и до конца аренды нода не знает, что её героев и забеги уже отдали.
   */
  thawSilent: boolean;
}

let cfg: ConfigRegistry;
let counters: typeof import('./metrics.js').counters;
let cur: W | null = null;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
/** Настоящие часы (до подмены): сторож зависшей операции. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
class Hang extends Error {}
/**
 * Сторож: операция (или фаза эпилога) не закончилась за `ms` НАСТОЯЩЕГО времени — это ожидание, которое не кончится (цепочка ждёт то, чего
 * не будет): нарушение `6-hang`, прогон обрывается. Без сторожа один такой сид вешал весь процесс большого прогона.
 */
async function watchdog<T>(w: W, p: Promise<T>, what: string, ms = 30_000): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, rej) => { t = realSetTimeout(() => rej(new Hang(what)), ms); });
  try { return await Promise.race([p, cap]); } catch (e) {
    if (e instanceof Hang) violate(w, '6-hang', `${what}: не закончилась за ${ms / 1000} с настоящего времени`);
    throw e;
  } finally { realClearTimeout(t); }
}
const drain = async (n = 2): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };
const tokenOf = (u: number): string => (u + 1).toString(16).padStart(2, '0').repeat(32);
const idOf = (w: W, o: object): number => { let v = w.ids.get(o); if (v === undefined) { v = ++w.idSeq; w.ids.set(o, v); } return v; };
const instOf = (w: W, room: RoomIn): string => `${idOf(w, room)}:${idOf(w, room.session.world.grid)}`;
const fmt = (op: Op): string => JSON.stringify(op);
/** `gateway.nodeLetter`: буква ноды в коде комнаты. */
const letterOf = (nodeId: string): string => String.fromCharCode(65 + (Number(/(\d+)$/.exec(nodeId)?.[1] ?? 0) % 26));
const nodeIdx = (nodeId: string): number => Number(/(\d+)$/.exec(nodeId)?.[1] ?? 0);
/** Ключ забега: функция чистая, берём у любого процесса прогона (`room.ts` у всех один и тот же код). */
let runLedgerKey: (cfg: RunConfig) => string = () => '';
/** Процессы, что есть для мира: не мёртвые и ⭐ R16-02 не на паузе машины (стоит целиком — ни ответа, ни записи, ни тика). */
const alive = (w: W): Inc[] => w.nodes.filter((i) => !i.dead && !i.frozenAt);
const incOfRoom = (w: W, room: RoomIn): Inc | undefined => w.roomInc.get(room);

function violate(w: W, inv: string, msg: string, h?: Hero, cause?: string): void {
  const key = `${inv}|${msg}`;
  if (w.seen.has(key)) return;
  w.seen.add(key);
  w.violations.push({ inv, msg: `${msg}${w.events.length ? ` [кластер: ${w.events.slice(-4).join(', ')}]` : ''}`, op: w.op, seed: w.seed, faults: db.consumed, cause: cause ?? causeOf(w, inv, h) });
}
/** Нарушения, которые окно простоя дольше `NODE_DEAD_SEC` объясняет по дизайну (R7-09: реестр отдаёт героев и забеги молчащей ноды). */
const ENVELOPE_INV = /^(a-|b-|7-|1-|2-revived|3-double|8-node|8-run|8-progress|4-free|6-internal|5-)/;
function causeOf(w: W, inv: string, h: Hero | undefined): string | undefined {
  if (w.envelope && ENVELOPE_INV.test(inv)) return 'ENV-outage-over-dead-sec';
  if (w.drainLost && /^(1-|2-revived|3-double|8-node|4-free)/.test(inv)) return 'ENV-drain-db-outage';
  if (w.thawSilent && ENVELOPE_INV.test(inv)) return 'ENV-thaw-registry-silent';
  // K1: погиб (штраф и «мёртв, оплачено» — в строке), процесс его комнаты умер (падение, слив) — и вошёл живым в тот же забег в другой комнате.
  if (inv === '2-revived-elsewhere' && h?.deadRoom && incOfRoom(w, h.deadRoom)?.dead) return 'K1-dead-resumed-alive';
  // K2: взятое на узле легло строкой героя, а свод забега в базе — нет; процесс умер, и узел собрался по своду без взятого.
  if ((inv === '8-node-refarmable' || inv === '8-node-double-loot') && w.ledgerBehind) return 'K2-ledger-behind-row';
  // K3: передача вещи записана наполовину — уход из строки отдавшего лёг (V-B2-04: запись выброса сразу), приход к поднявшему — нет. Метку
  // ставит сам `c-durable-item-lost` — только вещи, побывавшей на земле (`fromGround`): иная пропажа записанного — не K3.
  return undefined;
}

// ── Где герой ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function liveAt(w: W, h: Hero): { room: RoomIn; pid: string; p: PlayerIn; ws: FakeConn; inc: Inc } | undefined {
  for (const inc of alive(w)) {
    const ws = inc.rm.live.get(h.charId);
    if (!ws) continue;
    const c = inc.rm.conns.get(ws);
    if (!c) continue;
    const p = c.room.session.world.players[c.pid];
    if (p) return { room: c.room, pid: c.pid, p, ws: ws as FakeConn, inc };
  }
  return undefined;
}
/** Комнаты живых процессов: живые, грейс, снятые, чьё закрытие сокета ещё идёт, и тикающие. */
function allRooms(w: W): RoomIn[] {
  const out = new Set<RoomIn>();
  for (const inc of alive(w)) {
    for (const r of inc.rm.rooms.values()) out.add(r);
    for (const c of inc.rm.conns.values()) out.add(c.room);
    for (const r of inc.rm.graceByChar.values()) out.add(r);
  }
  for (const r of w.ticking) { const inc = incOfRoom(w, r); if (!inc?.dead && !inc?.frozenAt) out.add(r); }
  return [...out];
}
const roomsOf = (w: W, inc: Inc): RoomIn[] => {
  const out = new Set<RoomIn>([...inc.rm.rooms.values(), ...[...inc.rm.conns.values()].map((c) => c.room), ...inc.rm.graceByChar.values()]);
  for (const r of w.ticking) if (incOfRoom(w, r) === inc) out.add(r);
  return [...out];
};
/**
 * Земля комнаты для сверки вещей: дропы — и ⭐ K3 поднимаемые с неё (`carrying`), чья земля уже ушла (смена этажа, снятие комнаты), пока
 * запись поднимающего в пути: в сумку вещь переходит только после неё, а до того её место — земля (умер процесс — ушла с ней).
 */
function groundOf(room: RoomIn): DropIn[] {
  const ds = room.session.world.drops;
  return room.carrying?.size ? [...ds, ...[...room.carrying].filter((d) => !ds.includes(d))] : ds;
}
function findRoom(w: W, code: string): { room: RoomIn; inc: Inc } | undefined {
  for (const inc of alive(w)) { const room = inc.rm.rooms.get(code); if (room) return { room, inc }; }
  return undefined;
}
type Loc = { kind: 'live' | 'body' | 'disc'; room: RoomIn; inc?: Inc; pid?: string; p?: PlayerIn; info?: InfoIn; c?: ClientIn };
function locate(w: W): Map<string, Loc[]> {
  const out = new Map<string, Loc[]>();
  const add = (id: string, l: Loc): void => { let a = out.get(id); if (!a) out.set(id, (a = [])); a.push(l); };
  for (const room of allRooms(w)) {
    const inc = incOfRoom(w, room);
    const players = room.session.world.players;
    const bodies = new Set([...room.lingering.values()].map((l) => l.pid));
    for (const [pid, c] of room.clients) {
      const p = players[pid];
      if (!p) { violate(w, '7-client-without-entity', `комната ${room.code}: клиент ${pid} без сущности`); continue; }
      add(p.save.charId, { kind: 'live', room, inc, pid, p, c });
    }
    for (const [charId, l] of room.lingering) add(charId, { kind: 'body', room, inc, pid: l.pid, p: l.p, info: l.info });
    for (const [charId, info] of room.disconnected) add(charId, { kind: 'disc', room, inc, info });
    for (const [pid, p] of Object.entries(players)) {
      if (!room.clients.has(pid) && !bodies.has(pid)) violate(w, '7-ghost-entity', `комната ${room.code}: сущность ${p.save.charId} без сессии и тела`);
    }
  }
  return out;
}
function preState(w: W): Map<string, PreState> {
  w.opEv0 = w.ev;   // R16-09: состояние — на этот миг; оживления позже него проверка видит по `revivals`
  const locs = locate(w);
  const out = new Map<string, PreState>();
  for (const h of w.heroes) {
    const ls = locs.get(h.charId) ?? [];
    const live = ls.find((l) => l.kind === 'live');
    const disc = ls.find((l) => l.kind === 'disc');
    if (live) out.set(h.charId, { kind: 'live', area: live.room.area, alive: live.p!.alive, moving: live.room.resuming });
    else if (disc) {
      const i = disc.info!;
      const own = i.save.run?.config ? runLedgerKey(i.save.run.config) : null;
      const foreign = !!own && own !== (disc.room.runConfig ? runLedgerKey(disc.room.runConfig) : null);
      out.set(h.charId, { kind: 'disc', area: disc.room.area, safe: !!i.safe, paid: i.paid, fled: i.fled, fledDescend: i.fledDescend, body: ls.some((l) => l.kind === 'body'), foreign });
    } else out.set(h.charId, { kind: 'off' });
  }
  return out;
}
function rowSave(charId: string): SaveState | undefined {
  const r = db.rows.get(charId);
  return r ? JSON.parse(r.json) as SaveState : undefined;
}
/** Копия героя «на дописать» у живого процесса (запись не легла, исход неизвестен, прощальная в полёте). */
function pendingCopy(w: W, charId: string): boolean {
  for (const inc of alive(w)) {
    if (inc.rm.unsaved.has(charId) || inc.rm.inflight.has(charId)) return true;
  }
  return allRooms(w).some((r) => [...r.staleFarewells.values()].some((s) => s.charId === charId && !s.farewell.saved));
}
/** ПРАВДА О ГЕРОЕ: копия в памяти живого процесса; копия, которую он ещё дописывает, — последняя виденная; иначе строка базы. */
function truthOf(w: W, h: Hero, locs: Map<string, Loc[]>): { save: SaveState; mem: boolean; pending?: boolean } | undefined {
  const ls = locs.get(h.charId) ?? [];
  const mem = ls.find((l) => l.kind === 'live') ?? ls.find((l) => l.kind === 'disc') ?? ls.find((l) => l.kind === 'body');
  if (mem) { const s = mem.p?.save ?? mem.info!.save; h.lastSave = s; return { save: s, mem: true }; }
  if (pendingCopy(w, h.charId) && h.lastSave) return { save: h.lastSave, mem: true, pending: true };
  const row = rowSave(h.charId);
  return row ? { save: row, mem: false } : undefined;
}
const itemsOf = (s: SaveState): Item[] => [...Object.values(s.equipment ?? {}).filter((i): i is Item => !!i), ...s.inventory, ...(s.belt ?? []).filter((i): i is Item => !!i)];
const tracked = (it: Item): boolean => it.kind !== 'material' && it.kind !== 'consumable' && !it.use;

// ── Проверка после каждой операции ──────────────────────────────────────────────────────────────────────────────────────────────
function check(w: W, pre: Map<string, PreState>, op: Op | null): void {
  const locs = locate(w);
  const now = Date.now();

  // 6: исключения, погашенные внутри (команда, кадр), — ошибка кода; кроме отказа базы или реестра, заказанного фаззером (раздел, сбой):
  // его кадр лобби получает «занято», команда — «ошибка сервера, попробуйте ещё раз» (R3-14), и это штатно.
  if (counters.cmdFailed - w.cmdFailed0 > w.expectCmd) violate(w, '6-cmd-threw', `команда упала исключением: ${w.errors.slice(-3).join(' | ')}`);
  if (counters.frameErrors - w.frameErrors0 > w.expectFrame) violate(w, '6-frame-threw', `кадр упал исключением: ${w.errors.slice(-3).join(' | ')}`);
  w.cmdFailed0 = counters.cmdFailed; w.frameErrors0 = counters.frameErrors; w.expectCmd = 0; w.expectFrame = 0;

  // 7, a: одна пишущая копия героя — в одной комнате и на одной ноде.
  for (const [charId, ls] of locs) {
    const rooms = new Set(ls.map((l) => l.room));
    const incs = new Set(ls.map((l) => l.inc));
    const kinds = ls.map((l) => l.kind).sort().join('+');
    const where = ls.map((l) => `${l.kind}@${l.room.code}/${l.inc?.node}#${l.inc?.gen}`).join(', ');
    if (incs.size > 1) violate(w, 'a-live-two-nodes', `${charId} держат ${incs.size} ноды: ${where}; операция ${op ? fmt(op) : 'эпилог'}`, heroBy(w, charId));
    else if (rooms.size > 1) violate(w, '7-two-copies', `${charId} сразу в ${rooms.size} комнатах: ${where}`);
    else if (kinds !== 'live' && kinds !== 'disc' && kinds !== 'body+disc') violate(w, '7-two-copies', `${charId} в комнате ${ls[0]!.room.code}: ${kinds}`);
    for (const l of ls) {
      if (l.kind !== 'live' || !l.c || l.c.stale || l.c.unsure.length) continue;
      const row = db.rows.get(charId);
      if (row && row.version !== l.c.saveVersion) violate(w, '7-zombie-session', `живая сессия ${charId} (${l.inc?.node}) держит версию ${l.c.saveVersion}, в базе ${row.version}`);
    }
  }
  // a: живая сессия (реестр `live` менеджера) — у героя одна во всём кластере.
  for (const h of w.heroes) {
    const on = alive(w).filter((inc) => inc.rm.live.has(h.charId));
    if (on.length > 1) violate(w, 'a-live-two-nodes', `${h.charId}: живая сессия на ${on.map((i) => `${i.node}#${i.gen}`).join(' и ')}; операция ${op ? fmt(op) : 'эпилог'}`, h);
  }

  const truth = new Map<string, SaveState>();
  const pendingChars = new Set<string>();
  for (const h of w.heroes) {
    const t = truthOf(w, h, locs);
    if (!t) continue;
    truth.set(h.charId, t.save);
    if (t.pending) pendingChars.add(h.charId);
  }

  // c: что лежит в базе сейчас — было в базе (пропажа такой вещи при откате — не «ещё не записанное», а потерянное записанное).
  for (const r of db.rows.values()) for (const it of itemsOf(JSON.parse(r.json) as SaveState)) if (tracked(it)) w.durableSeen.add(it.uid);
  for (const st of db.stash.values()) for (const it of (JSON.parse(st.json) as AccountStash).tabs.flat()) if (tracked(it)) w.durableSeen.add(it.uid);
  // 1: вещь — в одном месте (правда героев, сундуки, земля живых нод).
  const where = new Map<string, string[]>();
  const put = (uid: string, loc: string): void => { let a = where.get(uid); if (!a) where.set(uid, (a = [])); a.push(loc); };
  const trackedUid = new Set<string>();
  for (const [charId, s] of truth) for (const it of itemsOf(s)) { put(it.uid, `hero:${charId}`); if (tracked(it)) trackedUid.add(it.uid); }
  for (const [userId, st] of db.stash) {
    const data = JSON.parse(st.json) as AccountStash;
    for (const it of data.tabs.flat()) { put(it.uid, `stash:${userId}`); if (tracked(it)) trackedUid.add(it.uid); }
  }
  const rooms = allRooms(w);
  for (const room of rooms) for (const d of groundOf(room)) if (d.kind === 'item' && d.item) { put(d.item.uid, `ground:${room.code}`); w.fromGround.add(d.item.uid); if (tracked(d.item)) trackedUid.add(d.item.uid); }
  // ⭐ K3: поднимаемое, чья земля ушла, пока запись поднимающего была в пути (`carryGone`): легла — вещь в его сумке; ещё в пути — земля
  // (`carrying`); строка базы её держит (исход неизвестен, копию ещё дописывают) — судьбу решит дописка. Иначе ушло с землёй ушедшего этажа —
  // сток. Сама проверка его на земле могла и не видеть: выброс, подъём и смена этажа — одна операция (голосование решилось снятием соседа), и
  // последним местом вещи числилась сумка выбросившего.
  for (const uid of [...w.carryGone]) {
    const ls = where.get(uid);
    if (ls?.some((l) => l.startsWith('ground:'))) continue;
    if (!ls && [...db.rows.values()].some((r) => r.json.includes(uid))) continue;
    w.carryGone.delete(uid);
    if (!ls) { w.sinks.add(uid); w.lastLoc.delete(uid); }
  }
  // Штраф лёг: сейв со штрафом — правда героя, или легла его запись. Запись — и по тексту, и по САМОМУ объекту сейва, записанному после
  // штрафа: вход после «Завершить»-штрафа правит тот же сейв дальше (комната, задания, пулы), и если процесс умер на следующем запросе,
  // текст объекта уже не тот, что лёг, — а штраф в строке базы (правда после отката). Считается ДО отката (ниже): вещь, взятая легшим
  // штрафом (или проданная) в операции, где процесс умер, — сток, а не «записанное и потерянное» (раньше — `c-durable-item-lost`, артефакт).
  const landed = (pn: Penalty): boolean => {
    if (truth.get(pn.charId) === pn.save) return true;
    const json = JSON.stringify(pn.save);
    return db.writes.some((x) => x.ok && x.charId === pn.charId && (x.json === json || (x.src === pn.save && (x.seq ?? 0) > pn.seq)));
  };
  const took = w.penalties.filter(landed);
  const removedNow = new Set(took.flatMap((pn) => pn.removed));
  for (const pn of took) for (const u of pn.removed) w.sunkBy.set(u, pn.charId);
  // c: правда героев упавшей ноды (и проигравших копий) откатилась к строке базы — законно: взятое стоком после последней записи
  // (продажа, штраф) вернулось в ЕГО строку, а взятое после неё (подобранное, добыча) ушло с процессом.
  if (w.rolledBack.size) {
    for (const uid of [...w.sinks]) {
      const ls = where.get(uid);
      if (ls && ls.every((l) => l.startsWith('hero:') && w.rolledBack.has(l.slice(5)))) { w.sinks.delete(uid); w.sunkBy.delete(uid); }
    }
    for (const [uid, loc] of [...w.lastLoc]) {
      if (where.has(uid)) continue;
      if (!loc.startsWith('hero:') || !w.rolledBack.has(loc.slice(5))) continue;
      if (removedNow.has(uid) || w.sold.has(uid)) continue;   // взято легшим стоком в этой же операции — сток (ниже)
      // Уже сток: земля ушедшей комнаты (`groundGone` — выброс и снятие комнаты в одной операции, проверка его на земле не видела).
      if (w.sinks.has(uid)) { w.lastLoc.delete(uid); continue; }
      w.sinks.add(uid); w.lastLoc.delete(uid);
      // c: вещь уже лежала в базе (у другого героя, в сундуке), её уход оттуда записан, а приход к этому — нет: откат к базе её потерял.
      // K3 — только вещь, прошедшая через землю (выброс лёг, подъём — нет); иная пропажа записанного — свой корень, не прощается.
      if (w.durableSeen.has(uid)) violate(w, 'c-durable-item-lost', `вещь ${uid}: лежала в базе, ушла оттуда записью, а у ${loc.slice(5)} (процесс умер) записана не была — после отката её нет нигде; операция ${op ? fmt(op) : 'эпилог'}`, undefined, w.fromGround.has(uid) ? 'K3-transfer-half-persisted' : undefined);
      else tally('c-rollback-item');
    }
    w.rolledBack.clear();
  }
  for (const [uid, ls] of where) {
    const settled = ls.filter((l) => !(l.startsWith('hero:') && pendingChars.has(l.slice(5))));
    if (settled.length > 1) violate(w, '1-dup-item', `вещь ${uid} сразу в: ${ls.join(', ')}`);
    if (w.sinks.has(uid)) {
      const holder = w.heroes.find((x) => ls.includes(`hero:${x.charId}`)) ?? w.heroes.find((x) => x.charId === w.sunkBy.get(uid));
      violate(w, '1-sunk-item-back', `вещь ${uid}, взятая стоком (штраф/продажа/земля ушедшего этажа), снова в игре: ${ls.join(', ')}`, holder);
    }
  }
  for (const [uid, loc] of [...w.lastLoc]) {
    if (where.has(uid)) continue;
    if (loc.startsWith('ground:') || removedNow.has(uid) || w.sold.has(uid)) { w.sinks.add(uid); w.lastLoc.delete(uid); }
  }
  w.sold.clear();
  for (const uid of trackedUid) w.lastLoc.set(uid, where.get(uid)![0]!);

  const perHero = new Map<string, Penalty[]>();
  for (const pn of took) { let a = perHero.get(pn.charId); if (!a) perHero.set(pn.charId, (a = [])); a.push(pn); }
  for (const [charId, ps] of perHero) {
    const h = w.heroes.find((x) => x.charId === charId);
    if (!h) continue;
    const st = pre.get(charId) ?? { kind: 'off' };
    const asked = (t: 'join' | 'abandon'): boolean => w.pending.some((p) => p.charId === charId && p.t === t);
    const counted = ps.filter((p) => p.src !== 'stored');
    // ⭐ Перепрогон R15: за одну операцию дважды — подряд, без оживления между штрафами (входы из очереди героя — одной операцией).
    const byEv = [...counted].sort((a, b) => a.ev - b.ev);
    const sameLife = byEv.some((p, i) => i > 0 && !h.revivals.some((r) => r > byEv[i - 1]!.ev && r < p.ev));
    if (sameLife && !counted.every((p) => p.src === 'death' || p.src === 'linger')) violate(w, '3-double-penalty', `${charId}: за одну операцию штрафов ${counted.length} (${counted.map((p) => p.src).join(', ')})`, h);
    const firstEv = Math.min(...counted.map((p) => p.ev));
    const livedBetween = h.revivals.some((r) => r > h.penaltyEv && r < firstEv);
    const guest = !!h.lastPen && counted.every((p) => guestDeath(h.lastPen!, p));
    if (counted.length && h.penaltyEv > 0 && h.penaltyEv < firstEv && !livedBetween && !guest) violate(w, '3-double-penalty', `${charId}: штраф (${counted.map((p) => p.src).join(', ')}) — а прошлый ещё не «отжит» (живым не видели, пати забег не уводила); операция ${op ? fmt(op) : 'эпилог'}`, h);
    // ⭐ R16-09: ожил ЗА ЭТУ операцию и раньше этого штрафа — состояние до операции (`st`) уже не про эту жизнь (см. фаззер одной ноды).
    const revivedInOp = (p: Penalty): boolean => h.revivals.some((r) => r > w.opEv0 && r < p.ev);
    for (const p of ps) {
      const why = `${charId} ${p.src}: до операции ${JSON.stringify(st)}, операция ${op ? fmt(op) : 'эпилог'}`;
      if (p.src === 'abandonStored' && !asked('abandon')) violate(w, '3-unjustified-penalty', `штраф по строке базы без «Завершить»: ${why}`);
      if (p.src === 'abandonAsDead') {
        // ⭐ R16-01: забег за штраф бросает только «Завершить»; вход, чей бросок стоил бы штрафа, — отказ `run` (страховка — без штрафа).
        if (!asked('abandon')) violate(w, '3-unjustified-penalty', `«Завершить»-штраф без «Завершить» (вход забег за штраф не бросает — R16-01): ${why}`);
        if (st.kind === 'disc' && st.paid && !st.foreign && !revivedInOp(p)) violate(w, '3-double-penalty', `штраф с оплаченной смерти (paid): ${why}`, h);
      }
      if (p.src === 'bury' || p.src === 'buryFled' || p.src === 'stored') {
        // ⭐ Перепрогон R15: вход героя, шедший на начало операции (очередь за медленной записью, поздний ответ реестра), — держание: он дошёл,
        // и похороны его копии за операцию — по правилам, а не «чужие».
        if (st.kind === 'off' && p.src !== 'stored' && !asked('join')) violate(w, '3-unjustified-penalty', `похоронен тот, кого нода не держала: ${why}`);
        // ⭐ Перепрогон R15: комната на переходе (продолжение ждало позднего ответа реестра) за операцию дошла до подземелья — не «город».
        if (st.kind === 'live' && st.area !== 'dungeon' && !st.moving) violate(w, '3-safe-penalized', `похоронен стоящий в городе/на арене: ${why}`);
        if (st.kind === 'disc' && st.safe) violate(w, '3-safe-penalized', `похоронен тот, чей забег пати увела в город (safe): ${why}`);
        if (st.kind === 'disc' && st.paid && p.src !== 'stored' && !revivedInOp(p)) violate(w, '3-double-penalty', `похоронен со штрафом погибший (paid): ${why}`, h);
        if (p.src === 'buryFled' && st.kind === 'disc' && !st.fled && !st.fledDescend && !st.body) violate(w, '3-safe-penalized', `спокойно ушедший (не fled) похоронен уходом пати: ${why}`);
      }
    }
    if (counted.length) { h.penaltyEv = Math.max(h.penaltyEv, ...counted.map((p) => p.ev)); h.lastPen = counted.reduce((a, b) => (b.ev > a.ev ? b : a)); h.cap = null; }
  }
  w.penalties.length = 0;

  // 5 (R16 C-09): ЭКРАН ВХОДА НЕ ВРЁТ О ЦЕНЕ «ЗАВЕРШИТЬ» (как у фаззера жизненного цикла): статус сказал `dead` — «Завершить» с того же экрана
  // штрафа не берёт; не сказал — берёт. Только чистая пара: ни его кадров лобби в очереди, ни живой сессии, ни сбоев базы и реестра за
  // операцию, нода жива; «Завершить» прошло, и забег было что бросать.
  const ask = w.asked;
  if (ask && op?.k === 'abandon') {
    w.asked = null;
    const st = ask.st;
    const h = w.heroes.find((x) => x.charId === ask.charId);
    const done = ask.conn.frames.some((f) => f.t === 'abandoned');
    const clean = db.consumed === ask.faults && w.regFaults.length === ask.reg && !ask.conn.inc?.dead;
    if (h && st && done && clean && ask.quiet && !st.live && st.hasRun && st.hadRun) {
      const charged = took.some((p) => p.charId === ask.charId && PROMISE_SRC.has(p.src));
      tally(`promise:${st.dead ? 'free' : 'cost'}:${st.grace ? 'grace' : 'row'}`);
      if (charged === st.dead) {
        violate(w, '5-status-promise', `${ask.charId}: экран «Продолжить / Забросить» ${st.dead ? 'обещал «без штрафа» (`dead`), а «Завершить» оштрафовал' : 'пугал штрафом, а «Завершить» его не взял (смерть оплачена — `dead` не сказан)'} (нода ${ask.conn.inc?.node}); до операции ${JSON.stringify(pre.get(ask.charId))}, операция ${op ? fmt(op) : 'эпилог'}`, h);
      }
    }
  }

  if (op && (op.k === 'potion' || op.k === 'attack')) heroOf(w, op.h).cap = null;
  // 2: комната смерти сменила этаж — оживление. Процесса комнаты нет — судьбу смерти решила строка базы (`rollBack`).
  for (const h of w.heroes) {
    if (h.deadRoom && !incOfRoom(w, h.deadRoom)?.dead && instOf(w, h.deadRoom) !== h.deadInst) { h.deadRun = null; h.deadRoom = null; h.deadInst = null; }
  }
  for (const h of w.heroes) {
    const run = truth.get(h.charId)?.run;
    if (h.deadRun && (!run?.config || runLedgerKey(run.config) !== h.deadRun)) { h.deadRun = null; h.deadRoom = null; h.deadInst = null; }
  }
  for (const h of w.heroes) {
    for (const l of locs.get(h.charId) ?? []) {
      if (l.kind === 'disc') {
        // Ждёт реконнекта МЁРТВЫМ (оплачено) в подземелье: комната помнит его смерть на этом этаже — она и есть комната смерти. K1: вход в
        // новую комнату забега (падение ноды, слив) ставит его мёртвым, а снятый записью (исход неизвестен) ждёт в ней же; смена ЕЁ этажа
        // оживляет законно. Раньше якорь смерти оставался на комнате упавшей ноды, и это оживление числилось `2-revived-elsewhere` (артефакт).
        const room = l.room;
        if (l.info?.paid && room.area === 'dungeon' && room.runConfig) {
          const key = instOf(w, room);
          h.deadOn.add(key);
          if (h.deadInst !== key) { h.deadRun = runLedgerKey(room.runConfig); h.deadRoom = room; h.deadInst = key; }
        }
        continue;
      }
      if (!l.p) continue;
      const room = l.room;
      if (room.area === 'arena') continue;
      const key = instOf(w, room);
      if (!l.p.alive) {
        h.deadOn.add(key); h.wasDead = true;
        h.deadSeenEv = ++w.ev;
        if (room.area === 'dungeon' && room.runConfig && h.deadInst !== key) { h.deadRun = runLedgerKey(room.runConfig); h.deadRoom = room; h.deadInst = key; }
        continue;
      }
      if (h.deadOn.has(key)) violate(w, '2-revived-same-floor', `${h.charId} погиб на этаже ${key} (${room.area}, узел ${room.runNodeId}) — и снова жив на нём же (${l.kind}); операция ${op ? fmt(op) : 'конец'}`);
      // 2: и снимком — кадр перехода мог уйти раньше, чем сокет стал сессией (продолжение забега в новой комнате шлёт этаж внутри входа).
      if (h.deadRun && room.area === 'dungeon' && room.runConfig && room !== h.deadRoom && runLedgerKey(room.runConfig) === h.deadRun) {
        violate(w, '2-revived-elsewhere', `${h.charId} погиб в забеге (комната ${h.deadRoom?.code}/${h.deadRoom ? incOfRoom(w, h.deadRoom)?.node : '?'}${h.deadRoom && incOfRoom(w, h.deadRoom)?.dead ? ' — процесса нет' : ', этаж не менялся'}) — а живым стоит на узле ${room.runNodeId} того же забега в комнате ${room.code}/${l.inc?.node}; операция ${op ? fmt(op) : 'эпилог'}`, h);
        h.deadRun = null; h.deadRoom = null; h.deadInst = null;
      }
    }
    const lv = (locs.get(h.charId) ?? []).find((l) => l.kind === 'live');
    const s = lv?.p;
    if (s?.alive && lv!.room.area !== 'arena') {
      h.revivedEv = ++w.ev; h.revivals.push(h.revivedEv); h.droppedDead = false;
      const save = s.save;
      const reset = h.wasDead || save.level > h.level || save.xp !== h.xp;
      h.wasDead = false; h.level = save.level; h.xp = save.xp;
      const base = playerSnapshot(save, cfg).derived;
      const run = lv!.room.session.snapshotOf(lv!.pid!)?.derived;
      if (h.cap && !reset) {
        const dt = Math.max(0, now - h.cap.at) / 1000;
        const allow = (was: number, a: number, b: number | undefined): number => was + 3 * Math.max(a, b ?? 0) * dt + 1;
        const bad: string[] = [];
        if (s.hp > allow(h.cap.hp, base.hpRegen, run?.hpRegen)) bad.push(`здоровье ${h.cap.hp.toFixed(1)} → ${s.hp.toFixed(1)}`);
        if (s.mana > allow(h.cap.mana, base.manaRegen, run?.manaRegen)) bad.push(`мана ${h.cap.mana.toFixed(1)} → ${s.mana.toFixed(1)}`);
        if (s.stamina > allow(h.cap.stamina, base.staminaRegen, run?.staminaRegen)) bad.push(`выносливость ${h.cap.stamina.toFixed(1)} → ${s.stamina.toFixed(1)}`);
        if (bad.length) violate(w, '4-free-restore', `${h.charId} за ${dt.toFixed(1)} с (${lv!.room.area}, ${lv!.kind}, ${lv!.inc?.node}): ${bad.join('; ')}; операция ${op ? fmt(op) : 'конец'}`);
      }
      h.cap = { hp: s.hp, mana: s.mana, stamina: s.stamina, at: now };
      if (w.stepped && run) {
        const over: string[] = [];
        if (s.hp > run.maxHp + 1e-6) over.push(`здоровье ${s.hp} > ${run.maxHp}`);
        if (s.mana > run.maxMana + 1e-6) over.push(`мана ${s.mana} > ${run.maxMana}`);
        if (s.stamina > run.maxStamina + 1e-6) over.push(`выносливость ${s.stamina} > ${run.maxStamina}`);
        if (over.length) violate(w, '4-over-max', `${h.charId}: ${over.join('; ')}`);
      }
    }
    for (const l of locs.get(h.charId) ?? []) if (l.kind === 'disc' && l.info!.safe) { h.revivedEv = ++w.ev; h.revivals.push(h.revivedEv); h.droppedDead = false; }
  }

  // 8: прогресс забега.
  for (const h of w.heroes) {
    const s = truth.get(h.charId);
    if (!s) continue;
    for (const [tier, d] of Object.entries(s.difficultyProgress ?? {})) {
      if (d > (h.depthMax.get(tier) ?? 0)) violate(w, '8-progress-unreached', `${h.charId}: глубина «${tier}» ${d}, а достигнуто подключённым ${h.depthMax.get(tier) ?? 0}`);
      const was = h.progMax.get(tier) ?? 0;
      if (d < was) violate(w, '8-progress-regress', `${h.charId}: глубина «${tier}» откатилась ${was} → ${d}`);
      else h.progMax.set(tier, d);
    }
    const run = s.run;
    if (run?.config && !h.reached.has(`${runLedgerKey(run.config)}|${run.currentNodeId}`)) {
      violate(w, '8-pointer-unreached', `${h.charId}: указатель забега на ${run.currentNodeId}, где он подключённым не стоял`);
    }
  }
  // 8, b: забег идёт в подземелье ОДНОЙ комнаты во всём кластере.
  const byRun = new Map<string, RoomIn[]>();
  for (const room of rooms) {
    if (room.area !== 'dungeon' || !room.runConfig) continue;
    const k = runLedgerKey(room.runConfig);
    byRun.set(k, [...(byRun.get(k) ?? []), room]);
  }
  for (const [k, rs] of byRun) {
    if (rs.length < 2) continue;
    const nodes = new Set(rs.map((r) => incOfRoom(w, r)?.node));
    const text = rs.map((r) => `${r.code}@${r.runNodeId}/${incOfRoom(w, r)?.node}`).join(', ');
    violate(w, nodes.size > 1 ? 'b-run-two-rooms' : '8-run-in-two-rooms', `забег ${k} в подземелье двух комнат сразу: ${text}; операция ${op ? fmt(op) : 'эпилог'}`);
  }
  // b (⭐ R15-08): НОДА НЕ ДЕРЖИТ ЗАБЕГ, КОТОРЫЙ ЕЁ КОМНАТА ОТПУСТИЛА. Строка держания, продлённая или взятая (`liveAt`) ПОСЛЕ отпуска этой
  // комнатой, а комната забег не держит, — сирота: «Продолжить» на соседней ноде вело к исчезнувшей комнате до `CLAIM_IDLE_SEC`. Судим в
  // тишине: поздних запросов реестра в пути нет, нода жива и не отрезана.
  if (!w.lateInFlight) {
    for (const [key, l] of w.cluster.runLocks) {
      const at = w.runReleasedAt.get(`${key}@${l.node}@${l.room}`);
      if (at === undefined || l.liveAt <= at) continue;
      const inc = w.nodes.find((i) => i.node === l.node);
      if (!inc || inc.dead || Date.now() < inc.stallUntil || Date.now() < inc.partitionUntil) continue;
      const room = inc.rm.rooms.get(l.room);
      if (room && room.holdsRun(key)) continue;
      // ⭐ Перепрогон R15: повторный отпуск упал (раздел, сбой реестра) — его повторит ближайший удар ноды (`runsDue`): до него — законно.
      const failed = w.releaseFailedAt.get(`${key}@${l.node}@${l.room}`);
      if (failed !== undefined && inc.lastBeatOk <= failed) { tally('b:orphan-release-retry-pending'); continue; }
      violate(w, 'b-run-lock-orphan', `забег ${key}: держание за ${l.node}/${l.room} продлено после отпуска комнатой, а комната его не держит; операция ${op ? fmt(op) : 'эпилог'}`);
    }
  }
  for (const room of rooms) {
    if (room.area !== 'dungeon' || !room.runConfig || !room.nodeState) continue;
    const st = room.nodeState;
    const key = `${runLedgerKey(room.runConfig)}|${st.id}`;
    let rec = w.recs.get(key);
    if (!rec) w.recs.set(key, (rec = { chests: new Set(), killed: new Set() }));
    const prev = w.roomSeen.get(room);
    if (!prev || prev.st !== st || prev.key !== key) {
      const lostC = [...rec.chests].filter((c) => !st.chests.includes(c));
      const lostK = [...rec.killed].filter((c) => !st.killed.includes(c));
      if (lostC.length || lostK.length) violate(w, '8-node-refarmable', `комната ${room.code} (${incOfRoom(w, room)?.node}) вошла в узел ${st.id} без взятого: сундуки ${lostC.join(',') || '—'}, убитые ${lostK.join(',') || '—'}`);
    } else {
      const againC = st.chests.filter((c) => !prev.chests.has(c) && rec!.chests.has(c));
      const againK = st.killed.filter((c) => !prev.killed.has(c) && rec!.killed.has(c));
      if (againC.length || againK.length) violate(w, '8-node-double-loot', `узел ${st.id}: взято повторно — сундуки ${againC.join(',') || '—'}, убитые ${againK.join(',') || '—'} (комната ${room.code})`);
    }
    for (const c of st.chests) rec.chests.add(c);
    for (const c of st.killed) rec.killed.add(c);
    w.roomSeen.set(room, { key, st, chests: new Set(st.chests), killed: new Set(st.killed) });
  }

  // 5: кадр лобби без ответа. ⭐ Перепрогон R16: кадр к ноде, чья машина на паузе (`suspend`), ждёт её конца — процесс не отвечает ничего;
  // проснувшаяся уходит без записи, и её сокеты закрыты (а ожившая в самопроверке закрывает лобби сама, `thaw`).
  for (const p of [...w.pending]) {
    const want = p.t === 'join' ? ['joined', 'error'] : p.t === 'runStatus' ? ['runStatus', 'error'] : ['abandoned', 'error'];
    if (p.conn.since(p.idx).some((f) => want.includes(f.t))) { w.pending.splice(w.pending.indexOf(p), 1); continue; }
    if (!p.conn.open) { w.pending.splice(w.pending.indexOf(p), 1); continue; }
    if (p.conn.inc?.frozenAt) continue;
    if (now - p.at > 40_000) { violate(w, '5-lobby-unanswered', `кадр «${p.t}» (операция ${p.op}, ${p.conn.inc?.node}) без ответа ${((now - p.at) / 1000).toFixed(0)} с`); w.pending.splice(w.pending.indexOf(p), 1); }
  }
}
const heroBy = (w: W, charId: unknown): Hero | undefined => w.heroes.find((x) => x.charId === charId);

const stats = new Map<string, number>();
const tally = (k: string): void => { stats.set(k, (stats.get(k) ?? 0) + 1); };

function noteFrame(w: W, c: FakeConn, f: ServerFrame): void {
  if (c.run !== db.run || c.inc?.dead) return;
  if (f.t === 'joined') {
    c.roomCode = f.roomCode;
    if (c.inc && f.roomCode[0] !== letterOf(c.inc.node)) tally('harness:letter-mismatch');
  }
  // 5 (R16 C-09): обещание экрана входа — в миг ответа статуса: что сказано (`dead`), жива ли сессия (на любой ноде) и есть ли забег у копии,
  // которую бросит «Завершить» этой ноды (её грейс-копия, нет её — строка базы; как решает сам кадр `abandon`).
  if (f.t === 'runStatus' && w.asked?.conn === c && !w.asked.st && c.inc) {
    const charId = w.asked.charId;
    const grace = c.inc.rm.graceByChar.get(charId);
    const hadRun = grace ? !!grace.disconnected.get(charId)?.save.run : !!rowSave(charId)?.run;
    w.asked.st = { dead: f.dead === true, hasRun: f.hasRun, live: alive(w).some((i) => i.rm.live.has(charId)), hadRun, grace: !!grace };
  }
  if (f.t === 'areaChanged') tally(`area:${(f.floor as { area?: string }).area}`);
  else if (f.t === 'cmdResult') tally(`cmd:${f.cmd}:${f.ok ? 'ok' : 'no'}`);
  else if (f.t === 'error') tally(`err:${f.code}`);
  else if (f.t === 'died') tally(f.status ? 'died:status' : 'died');
  else if (f.t === 'joined' || f.t === 'abandoned') tally(f.t);
  else if (f.t === 'voteEnd') tally(`vote:${f.passed ? 'pass' : 'fail'}`);
  // 5 (C-05), d: «Продолжить», отказанный из-за забега в другой комнате, — с кодом комнаты, что ДЕРЖИТ его забег: живой, где угодно в
  // кластере. Мёртвой ноды — только в окне держания (`NODE_DEAD_SEC` с её последнего удара): дольше отказ запирает героя без выхода.
  if (f.t === 'error' && (f.code === 'full' || f.code === 'run') && c.resume && c.hero !== undefined && c.inc && !c.inc.rm.conns.has(c)) {
    const h = w.heroes[c.hero]!;
    const own = rowSave(h.charId)?.run?.config;
    const key = own ? runLedgerKey(own) : null;
    const holder = f.roomCode ? findRoom(w, f.roomCode) : undefined;
    let ok = !!holder && !!key && holder.room.holdsRun(key);
    // Держатель на другой ноде виден реестру с опозданием до удара её сердца (`touchRuns`/`heldRuns`): комната, чьи участники только что ушли,
    // ещё числится держателем. Код ведёт в комнату С ЭТИМ ЗАБЕГОМ (её план жив: вошедший с ним снова его участник) — путь есть.
    if (!ok && f.code === 'run' && holder && key && holder.room.runConfig && runLedgerKey(holder.room.runConfig) === key) { ok = true; tally('d:resume-refused-stale-holder'); }
    if (!ok && f.code === 'run' && f.roomCode) {
      // Держатель на ноде, которой нет (упала/слита) или которая жива, но комнату уже отпустила, — держание по реестру ещё действует?
      const lock = key ? w.cluster.runLocks.get(key) : undefined;
      if (lock && lock.room === f.roomCode && w.cluster.held(lock.liveAt, lock.node)) {
        const inc = w.nodes[nodeIdx(lock.node)];
        // ⭐ Перепрогон R16: и нода, чья машина на паузе (`suspend`), — для мира она ушла, как упавшая (`forget`).
        if (inc?.dead || inc?.frozenAt) { ok = true; tally('d:resume-refused-dead-holder-window'); }
        // Держание без комнаты у живой ноды (взятие, чей ответ потерян; снятие, упавшее сбоем) нода не продлевает, и оно протухает само через
        // `CLAIM_IDLE_SEC` после её удара (удары не идут — позже, но не дольше окна дизайна): отказ временный. Дольше окна — заперт (d).
        else if (!refreshes(inc, key!)) {
          ok = Date.now() - lock.liveAt < (NODE_DEAD_SEC + CLAIM_IDLE_SEC) * 1000 + 2 * BEAT_MS;
          tally(ok ? 'd:resume-refused-orphan-lock' : 'd:resume-refused-orphan-lock-long');
        }
      }
      // ⭐ Перепрогон R15: держание-сирота (взятие ушедшей комнаты легло позже её отпуска — поздний ответ реестра) её нода уже сняла (R15-08:
      // повтор отпуска по ответу взятия), а отказ пересказал ответ реестра до снятия: отказ временный — «Продолжить» снова находит забег.
      // Строки уже нет или она за другой комнатой; реестр ТОЧНО так ответил на взятие только что (`claimSaw`, не старше удара) — не выдумка
      // отказа. Путь, запертый насовсем, стережёт эпилог: каждый с забегом в строке жмёт «Продолжить» снова.
      const saw = key ? w.claimSaw.get(`${key}@${f.roomCode}`) : undefined;
      if (!ok && (!lock || lock.room !== f.roomCode) && saw !== undefined && Date.now() - saw <= BEAT_MS) { ok = true; tally('d:resume-refused-orphan-lock-gone'); }
    }
    if (!ok) violate(w, '5-resume-dead-end', `${h.charId}: «Продолжить» на ${c.inc.node} — отказ «${f.code}» (${f.msg}) ${f.roomCode ? `с кодом ${f.roomCode}, а эта комната его забег ${key ?? '—'} не держит (${holder ? `${holder.inc.node}` : 'комнаты нет'}; реестр: ${key ? JSON.stringify(w.cluster.runLocks.get(key) ?? null) : '—'})` : 'без кода комнаты, что держит его забег'}; операция ${w.opRef ? fmt(w.opRef) : 'эпилог'}`, h);
  }
  if ((f.t !== 'joined' && f.t !== 'areaChanged') || c.hero === undefined || !c.roomCode || !c.inc) return;
  const room = c.inc.rm.rooms.get(c.roomCode);
  if (!room) return;
  const h = w.heroes[c.hero]!;
  // Кадр этажа посреди входа (продолжение забега в новой комнате: `attach` в городе, следом сборка узла `enterNode`, `resumed`) приходит
  // раньше, чем менеджер запомнил соединение (`conns`): игрок — по сокету в клиентах комнаты. Иначе «встал на узле мёртвым» (K1) проверка не
  // видела, а городской кадр входа (жив) числила оживлением — и «Завершить» из грейса после такого входа была «без штрафа за новую жизнь».
  const pid = f.t === 'joined' ? f.playerId : c.inc.rm.conns.get(c)?.pid ?? [...room.clients.values()].find((cl) => cl.ws === c)?.pid;
  const p = pid ? room.session.world.players[pid] : undefined;
  if (p?.alive && room.area === 'dungeon' && room.runConfig && h.deadRun && room !== h.deadRoom && runLedgerKey(room.runConfig) === h.deadRun) {
    violate(w, '2-revived-elsewhere', `${h.charId} погиб в забеге (комната ${h.deadRoom?.code}/${h.deadRoom ? incOfRoom(w, h.deadRoom)?.node : '?'}${h.deadRoom && incOfRoom(w, h.deadRoom)?.dead ? ' — процесса нет' : ', этаж не менялся'}) — а живым встал на узел ${room.runNodeId} того же забега в комнате ${room.code}/${c.inc.node} (${f.t}, операция ${w.opRef ? fmt(w.opRef) : 'эпилог'})`, h);
    h.deadRun = null; h.deadRoom = null; h.deadInst = null;
  }
  if (p?.alive && room.area !== 'arena') revived(w, h);
  if (p && !p.alive && room.area !== 'arena') {
    h.deadSeenEv = ++w.ev;
    // ⭐ Раунд 16 (модель; большой прогон кластера, сид 200019): K1 — вход погибшего в новую комнату его забега (процесс комнаты смерти умер)
    // ставит его мёртвым: якорь смерти — ЭТА комната, и смена её этажа (застрявшие мёртвые уходят в город, R12-07; пати увела в город) оживляет
    // законно. Кадром — потому что вход, возврат застрявших в город и спуск из него бывают одной операцией, и проверка видела героя уже живым в
    // городе, с якорем на комнате упавшей ноды: спуск пати числился `2-revived-elsewhere` (артефакт, как у ждущего реконнекта выше).
    if (room.area === 'dungeon' && room.runConfig && h.deadRun === runLedgerKey(room.runConfig)) { h.deadRoom = room; h.deadInst = instOf(w, room); }
  }
}

/** Нода держит забег `key` комнатой и продлевает его ударом сердца (`heldRuns` без его подметания — проверка не трогает состояние). */
function refreshes(inc: Inc | undefined, key: string): boolean {
  if (!inc || inc.dead) return false;
  const r = inc.rm.runRooms.get(key);
  return !!r && inc.rm.rooms.get(r.code) === r && r.holdsRun(key);
}

function noteRevived(w: W, room: RoomIn): void {
  if (room.area === 'arena') return;
  for (const [pid] of room.clients) {
    const p = room.session.world.players[pid];
    const h = w.heroes.find((x) => x.charId === p?.save.charId);
    if (h && p?.alive) revived(w, h);
  }
  for (const charId of room.disconnected.keys()) {
    const h = w.heroes.find((x) => x.charId === charId);
    if (h) revived(w, h);
  }
}
function lifePaid(w: W, h: Hero): boolean {
  const pending = w.penalties.filter((p) => p.charId === h.charId && p.src !== 'stored').map((p) => p.ev);
  return Math.max(h.penaltyEv, ...pending) > h.revivedEv;
}
function deathPaid(w: W, h: Hero): boolean {
  return lifePaid(w, h) || h.deadSeenEv > h.revivedEv;
}
const ABANDON_SRC: ReadonlySet<string> = new Set(['abandonStored', 'abandonAsDead', 'stored', 'bury', 'buryFled']);
/**
 * ⭐ R16 C-09: штрафы, которые берёт «Завершить» (цена, о которой говорит экран входа): сам «Завершить» (из грейса и по строке базы), его
 * запись по строке (копию обогнали) и тело в бою, погибшее и ещё не оплаченное (`endLinger` — первым делом «Завершить»).
 */
const PROMISE_SRC: ReadonlySet<string> = new Set(['abandonStored', 'abandonAsDead', 'stored', 'linger']);
/**
 * ⭐ R16 C-09: герой вне игры, чья смерть в забеге оплачена по правде кластера: ждёт пати мёртвым в грейсе живой ноды (`paid`) или «мёртв,
 * оплачено» в копии либо строке (`run.deadAt` — в том числе после падения и слива ноды). Только выбор героя для вставки операции.
 */
function paidOut(w: W, h: Hero): boolean {
  for (const inc of alive(w)) {
    const info = inc.rm.graceByChar.get(h.charId)?.disconnected.get(h.charId);
    if (info) return !!info.save.run && (info.paid || info.save.run.deadAt !== undefined);
  }
  return rowSave(h.charId)?.run?.deadAt !== undefined;
}
function guestDeath(prev: Penalty, next: Penalty): boolean {
  return (prev.src === 'death' || prev.src === 'linger') && ABANDON_SRC.has(next.src) && next.run !== null && prev.where !== next.run;
}
function revived(w: W, h: Hero): void {
  if (lifePaid(w, h) || h.wasDead) h.cap = null;
  h.revivedEv = ++w.ev;
  h.revivals.push(h.revivedEv);
  h.droppedDead = false;
}
function noteReached(w: W, room: RoomIn, pids: readonly string[]): void {
  if (room.area !== 'dungeon' || !room.runConfig || !room.runNodeId) return;
  const key = `${runLedgerKey(room.runConfig)}|${room.runNodeId}`;
  for (const pid of pids) {
    const charId = room.session.world.players[pid]?.save.charId;
    const h = w.heroes.find((x) => x.charId === charId);
    if (!h) continue;
    h.reached.add(key);
    h.depthMax.set(room.difficultyId, Math.max(h.depthMax.get(room.difficultyId) ?? 0, room.depth));
  }
}

/**
 * c: ПРАВДА ГЕРОЕВ `ids` ОТКАТИЛАСЬ К СТРОКЕ БАЗЫ (процесс, державший их копии, умер; копию сняли проигравшей). Всё, что случилось с копией
 * после её последней записи, ушло с ней, — законно (падение процесса — не действие игрока): смерть, не легшая в базу, не случилась (строка без
 * «мёртв, оплачено» — жизнь новая: следующий штраф не второй), пулы и прогресс — из строки (с чистого листа), вещи — сверяются на ближайшей
 * проверке (`rolledBack`). Смерть, легшая в базу (`run.deadAt`), — осталась: второй штраф за неё и оживление в том же забеге ловятся как
 * всегда.
 */
function rollBack(w: W, ids: Iterable<string>): void {
  for (const id of ids) {
    const h = heroBy(w, id);
    if (!h) continue;
    w.rolledBack.add(id);
    h.cap = null; h.lastSave = undefined;
    const row = rowSave(id);
    for (const [tier] of h.progMax) h.progMax.set(tier, Math.min(h.progMax.get(tier)!, row?.difficultyProgress?.[tier] ?? 0));
    if (row?.run?.deadAt === undefined) { h.deadRun = null; h.deadRoom = null; h.deadInst = null; revived(w, h); }
    // Строка — «мёртв, оплачено»: что бы с копией ни случилось после (вошла живой), откатилось к оплаченной смерти (C-03: «Завершить» — без штрафа).
    else h.deadSeenEv = ++w.ev;
  }
}

// ── Исполнение операций ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const idle = (facing = 0): PlayerInput => ({ move: { x: 0, y: 0 }, facing, attack: false, cast: null, interact: false });
const portals = (room: RoomIn): Pt[] => room.decor.filter((d) => d.kind === 'portal').map((d) => ({ x: d.x, y: d.y }));
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const openCells = new WeakMap<Grid, Pt[]>();
function floorCells(grid: Grid): Pt[] {
  let c = openCells.get(grid);
  if (!c) {
    c = [];
    for (let y = 0; y < grid.length; y++) for (let x = 0; x < (grid[y]?.length ?? 0); x++) if (grid[y]![x] === Cell.Floor) c.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 });
    openCells.set(grid, c);
  }
  return c;
}
function place(p: PlayerIn, at: Pt): void { p.pos = { x: at.x, y: at.y }; p.vel = { x: 0, y: 0 }; }
const OFFS = [[30, 0], [-30, 0], [0, 30], [0, -30], [22, 22], [-22, 22], [22, -22], [-22, -22]] as const;
function beside(room: RoomIn, at: Pt, r: number): Pt | undefined {
  const g = room.session.world.grid;
  for (let k = 0; k < OFFS.length; k++) {
    const [dx, dy] = OFFS[(k + Math.floor(r * 8)) % OFFS.length]!;
    const q = { x: at.x + dx, y: at.y + dy };
    if (isWalkableWorld(g, q.x, q.y) && hasLineOfSight(g, at.x, at.y, q.x, q.y)) return q;
  }
  return undefined;
}
function spot(room: RoomIn, to: Where, r: number): Pt | undefined {
  const w = room.session.world;
  const gates = [w.spawn, ...(w.exits ?? []), ...portals(room)];
  switch (to) {
    case 'entry': return w.spawn;
    case 'exit': { const ex = w.exits ?? []; return ex.length ? ex[Math.floor(r * ex.length) % ex.length] : portals(room)[0]; }
    case 'portal': return portals(room)[0] ?? w.spawn;
    case 'away': {
      const cells = floorCells(w.grid).filter((c) => gates.every((g) => dist(c, g) > 200));
      const pool = cells.length ? cells : floorCells(w.grid);
      return pool.length ? pool[Math.floor(r * pool.length) % pool.length] : undefined;
    }
    case 'monster': {
      const mons = w.monsters.filter((m) => m.alive);
      if (!mons.length) return undefined;
      const m = mons[Math.floor(r * mons.length) % mons.length]!;
      m.aiState = 'chase';
      return beside(room, m.pos, r);
    }
    case 'drop': { const ds = w.drops; return ds.length ? ds[Math.floor(r * ds.length) % ds.length]!.pos : undefined; }
    case 'chest': { const cs = w.chests.filter((c) => !c.opened); return cs.length ? cs[Math.floor(r * cs.length) % cs.length]!.pos : undefined; }
  }
}
function send(w: W, h: Hero, frame: Record<string, unknown>): void {
  const at = liveAt(w, h);
  if (!at) return;
  try { at.ws.push(frame); } catch (e) { violate(w, '6-push-threw', `кадр ${String(frame.t)}: ${String(e)}`); }
}
function cmd(w: W, h: Hero, command: Record<string, unknown>): number {
  const id = ++h.cmd;
  send(w, h, { t: 'cmd', command, id });
  return id;
}
/**
 * Маршрут кадра лобби: через гейтвей (модель `/api/route` — живые ноды реестра, код к ноде буквы, закрепление маршрута) или прямо на ноду.
 * Процесса по адресу нет (упал, реестр ещё не заметил) — сокет не открывается: `undefined`.
 */
function routeOf(w: W, h: Hero, code: string | undefined, via: Via): Inc | undefined {
  let n: number;
  if (via === 'x') {
    const key = rowSave(h.charId)?.run?.config ? runLedgerKey(rowSave(h.charId)!.run!.config) : undefined;
    const home = (key ? w.cluster.runLocks.get(key)?.node : undefined) ?? w.cluster.claims.get(h.charId)?.node ?? h.conn?.inc?.node;
    n = home ? (nodeIdx(home) + 1) % NODES : (h.i + 1) % NODES;   // не из потока: повтор последовательности идёт без генератора
  } else if (via === 'gw') {
    if (takeReg(w, 'route', undefined)) { tally('route:fault'); return undefined; }
    const r = w.cluster.route(h.charId, code, letterOf);
    if ('error' in r) { tally(`route:${r.error}`); return undefined; }
    n = nodeIdx(r.node);
  } else n = via % NODES;
  const inc = w.nodes[n];
  if (!inc || inc.dead) { tally('route:dead-node'); return undefined; }
  if (inc.frozenAt) { tally('route:frozen-node'); return undefined; }   // ⭐ R16-02: машина на паузе — подключение не открывается
  return inc;
}
function lobby(w: W, h: Hero, frame: Record<string, unknown>, inc: Inc, conn?: FakeConn): FakeConn {
  const ws = conn ?? new FakeConn();
  ws.hero = h.i;
  ws.run = db.run;
  ws.resume = frame.t === 'join' && frame.resume === true;
  if (!conn) { ws.inc = inc; process.env.DM_NODE_ID = inc.node; inProc(inc, () => inc.rm.handleConnection(ws)); w.lobbies.push(ws); }
  const t = frame.t as 'join' | 'runStatus' | 'abandon';
  w.pending.push({ conn: ws, charId: h.charId, t, idx: ws.frames.length, at: Date.now(), op: w.op });
  try { ws.push({ ...frame, token: h.token, charId: h.charId }); } catch (e) { violate(w, '6-push-threw', `кадр ${t}: ${String(e)}`); }
  return ws;
}
async function stepAll(w: W, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(34);
    for (const room of [...w.ticking]) {
      if (!w.ticking.has(room)) continue;
      const inc = incOfRoom(w, room);
      if (!inc || inc.dead || inc.frozenAt) continue;   // ⭐ R16-02: процесс на паузе не тикает
      process.env.DM_NODE_ID = inc.node;
      try { inProc(inc, () => room.step(false)); } catch (e) { violate(w, '6-step-threw', `шаг комнаты ${room.code}: ${e instanceof Error ? e.stack?.split('\n').slice(0, 4).join(' ') : String(e)}`); }
    }
    await drain(1);
  }
  w.stepped = true;
}
function othersVote(w: W, room: RoomIn, h: Hero, others: Others, near: Pt | undefined): void {
  if (others === 'none') return;
  const mates = w.heroes.filter((x) => x !== h && liveAt(w, x)?.room === room);
  mates.forEach((m, i) => {
    const at = liveAt(w, m)!;
    if (near && at.p.alive) place(at.p, near);
    send(w, m, { t: 'vote', accept: !(others === 'no' && i === mates.length - 1) });
  });
}
const heroOf = (w: W, i: number): Hero => w.heroes[i % w.heroes.length]!;
async function pause(w: W): Promise<void> { await stepAll(w, 48); }

async function exec(w: W, op: Op): Promise<void> {
  w.stepped = false;
  // ⭐ R16-02: пауза машины кончилась — процесс продолжает (граница операции: так ложится на неё и повтор последовательности).
  for (const inc of w.nodes) if (inc.frozenAt && !inc.dead && Date.now() >= inc.frozenUntil) await thaw(w, inc);
  switch (op.k) {
    case 'join': {
      const h = heroOf(w, op.h);
      const reuse = op.reuse && h.conn?.open && h.conn.inc && !h.conn.inc.dead && !h.conn.inc.frozenAt && !h.conn.inc.rm.conns.has(h.conn) && !w.pending.some((p) => p.conn === h.conn);
      const frame: Record<string, unknown> = { t: 'join' };
      if (op.mode === 'fresh') frame.fresh = true;
      else if (op.mode === 'resume') frame.resume = true;
      else {
        const rooms = alive(w).flatMap((inc) => [...inc.rm.rooms.values()]);
        const friends = op.mode === 'friend'
          ? rooms.filter((r) => w.heroes.some((x) => x !== h && ([...r.clients.values()].some((c) => r.session.world.players[c.pid]?.save.charId === x.charId) || r.disconnected.has(x.charId))))
          : rooms;
        const pool = friends.length ? friends : rooms;
        if (pool.length) frame.roomCode = pool[Math.floor(op.r * pool.length) % pool.length]!.code;
        else frame.fresh = true;
      }
      const inc = reuse ? h.conn!.inc! : routeOf(w, h, frame.roomCode as string | undefined, op.via);
      if (!inc) return;
      h.conn = lobby(w, h, frame, inc, reuse ? h.conn! : undefined);
      await drain();
      return;
    }
    case 'status': case 'abandon': {
      const h = heroOf(w, op.h);
      const quiet = !w.pending.some((p) => p.charId === h.charId) && !alive(w).some((i) => i.rm.live.has(h.charId));
      const faults = db.consumed, reg = w.regFaults.length;   // R16 C-09: до маршрута — его сбой реестра тоже в счёт
      const inc = routeOf(w, h, undefined, op.via);
      if (!inc) return;
      if (op.k === 'abandon' && op.ask) {
        // ⭐ R16 C-09: экран входа — статус забега, и «Завершить» с него же (одно соединение одной ноды: кадры по очереди). Обещание экрана
        // записывает `noteFrame` в миг ответа, сверяет — `check`.
        const ws = lobby(w, h, { t: 'runStatus' }, inc);
        w.asked = { conn: ws, charId: h.charId, quiet, faults, reg };
        lobby(w, h, { t: 'abandon' }, inc, ws);
        await drain(3);
        return;
      }
      lobby(w, h, { t: op.k === 'status' ? 'runStatus' : 'abandon' }, inc);
      await drain();
      return;
    }
    case 'leave': send(w, heroOf(w, op.h), { t: 'leave' }); await drain(); return;
    case 'close': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (at) {
        at.ws.close();
        if (at.inc.rm.conns.has(at.ws) || at.inc.rm.live.get(h.charId) === at.ws) violate(w, '7-closed-still-live', `${h.charId}: соединение закрыто, а сессия жива до конца очереди его кадров`);
      }
      await drain();
      return;
    }
    case 'move': {
      const at = liveAt(w, heroOf(w, op.h));
      if (!at || !at.p.alive) return;
      const q = spot(at.room, op.to, op.r);
      if (q) place(at.p, q);
      return;
    }
    case 'hurt': {
      const at = liveAt(w, heroOf(w, op.h));
      if (!at || !at.p.alive || at.room.area === 'town') return;
      at.p.hp = Math.min(at.p.hp, Math.max(1, Math.floor(at.p.maxHp * op.frac)));
      await stepAll(w, 1);
      return;
    }
    case 'kill': {
      const h = heroOf(w, op.h);
      let p: PlayerIn | undefined;
      let room: RoomIn | undefined;
      if (op.body) for (const r of allRooms(w)) { const l = r.lingering.get(h.charId); if (l) { p = l.p; room = r; } }
      if (!p) { const at = liveAt(w, h); if (at && at.room.area !== 'town') { p = at.p; room = at.room; } }
      if (!p || !room || !p.alive) return;
      p.hp = 1;
      p.debuffs.poison = { stacks: 1, maxStacks: 1, expiresAt: room.session.world.timeMs + 60_000, mag: 9999, mag2: 0 };
      await stepAll(w, 4);
      return;
    }
    case 'potion': {
      const at = liveAt(w, heroOf(w, op.h));
      if (!at || !at.p.alive) return;
      const save = at.p.save;
      if (op.belt) {
        const slots = save.belt.map((it, i) => (it?.use ? i : -1)).filter((i) => i >= 0);
        if (!slots.length) return;
        try { inProc(at.inc, () => at.room.setInput(at.pid, { ...idle(), useBelt: slots[Math.floor(op.r * slots.length) % slots.length] })); } catch (e) { violate(w, '6-input-threw', String(e)); }
        await stepAll(w, 1);
      } else {
        const pots = [...save.inventory, ...save.belt.filter((i): i is Item => !!i)].filter((i) => i.use);
        if (!pots.length) return;
        cmd(w, heroOf(w, op.h), { cmd: 'useConsumable', uid: pots[Math.floor(op.r * pots.length) % pots.length]!.uid });
        await drain();
      }
      return;
    }
    case 'attack': {
      const at = liveAt(w, heroOf(w, op.h));
      if (!at || !at.p.alive || at.room.area !== 'dungeon') return;
      const mons = at.room.session.world.monsters.filter((m) => m.alive);
      if (!mons.length) return;
      const m = mons.reduce((a, b) => (dist(b.pos, at.p.pos) < dist(a.pos, at.p.pos) ? b : a));
      const q = beside(at.room, m.pos, op.r);
      if (q) place(at.p, q);
      if (op.weaken) m.hp = Math.min(m.hp, 1);
      const facing = Math.atan2(m.pos.y - at.p.pos.y, m.pos.x - at.p.pos.x);
      try { inProc(at.inc, () => at.room.setInput(at.pid, { ...idle(facing), attack: true })); } catch (e) { violate(w, '6-input-threw', String(e)); }
      await stepAll(w, 8);
      const again = liveAt(w, heroOf(w, op.h));
      if (again) try { inProc(again.inc, () => again.room.setInput(again.pid, idle(facing))); } catch (e) { violate(w, '6-input-threw', String(e)); }
      await drain();
      return;
    }
    case 'descend': {
      if (op.pause) await pause(w);
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at) return;
      const room = at.room;
      let near: Pt | undefined;
      if (room.area === 'town') send(w, h, op.diff !== undefined ? { t: 'descend', difficultyId: tierIds()[op.diff % tierIds().length] } : { t: 'descend' });
      else if (room.area === 'dungeon') {
        const node = room.runPlan?.nodes.find((n) => n.id === room.runNodeId);
        if (!node) return;
        if (node.edges.length === 0) {
          near = portals(room)[0];
          if (near && at.p.alive) place(at.p, near);
          send(w, h, { t: 'descend' });
        } else {
          const i = Math.floor(op.r * node.edges.length) % node.edges.length;
          const ex = room.session.world.exits?.[i];
          if (ex && at.p.alive) place(at.p, ex);
          near = ex;
          send(w, h, { t: 'descend', targetNodeId: node.edges[i]!.to });
        }
      } else return;
      await drain();
      othersVote(w, room, h, op.others, op.near ? near : undefined);
      await drain();
      return;
    }
    case 'town': {
      if (op.pause) await pause(w);
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || at.room.area === 'town') return;
      const room = at.room;
      const near = room.area === 'dungeon' ? room.session.world.spawn : undefined;
      if (near && op.near && at.p.alive) place(at.p, near);
      send(w, h, { t: 'return' });
      await drain();
      othersVote(w, room, h, op.others, op.near ? near : undefined);
      await drain();
      return;
    }
    case 'arena': {
      if (op.pause) await pause(w);
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || at.room.area !== 'town') return;
      send(w, h, { t: 'arena' });
      await drain();
      othersVote(w, at.room, h, op.others, undefined);
      await drain();
      return;
    }
    case 'vote': send(w, heroOf(w, op.h), { t: 'vote', accept: op.yes }); await drain(); return;
    case 'step': await stepAll(w, op.n); return;
    case 'wait': {
      await vi.advanceTimersByTimeAsync(op.ms);
      await drain();
      await stepAll(w, 2);
      return;
    }
    case 'drop': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at) return;
      const inv = at.p.save.inventory.filter((i) => !i.use);
      if (!inv.length) return;
      cmd(w, h, { cmd: 'drop', uid: inv[Math.floor(op.r * inv.length) % inv.length]!.uid });
      await drain();
      return;
    }
    case 'pickup': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || !at.p.alive) return;
      const ds = at.room.session.world.drops.filter((d) => d.kind === 'item');
      if (!ds.length) return;
      const d = ds[Math.floor(op.r * ds.length) % ds.length]!;
      place(at.p, d.pos);
      cmd(w, h, { cmd: 'pickup', dropId: d.id });
      await drain();
      return;
    }
    case 'trade': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || !at.p.alive) return;
      const mate = w.heroes.find((x) => x !== h && x.userId === h.userId && liveAt(w, x)?.room === at.room && liveAt(w, x)?.p.alive);
      const inv = at.p.save.inventory.filter((i) => !i.use);
      if (!inv.length) return;
      const uid = inv[Math.floor(op.r * inv.length) % inv.length]!.uid;
      w.fromGround.add(uid);   // K3: выброс и подъём — в одной операции, проверка землю не видит
      cmd(w, h, { cmd: 'drop', uid });
      await drain();
      if (!mate) return;
      const d = at.room.session.world.drops.find((x) => x.item?.uid === uid);
      const mat = liveAt(w, mate);
      if (!d || !mat) return;
      place(mat.p, d.pos);
      cmd(w, mate, { cmd: 'pickup', dropId: d.id });
      await drain();
      return;
    }
    case 'stash': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || at.room.area !== 'town') return;
      const dims = stashDims(cfg);
      const st = db.stash.get(h.userId);
      const tab = st ? (JSON.parse(st.json) as AccountStash).tabs[0] ?? [] : [];
      if (!op.out) {
        const inv = at.p.save.inventory.filter((i) => !i.use);
        if (!inv.length) return;
        const it = inv[Math.floor(op.r * inv.length) % inv.length]!;
        const f = findFree(tab, it.gridW, it.gridH, dims);
        if (!f) return;
        cmd(w, h, { cmd: 'stashMove', uid: it.uid, dst: 0, x: f.x, y: f.y });
      } else {
        if (!tab.length) return;
        const it = tab[Math.floor(op.r * tab.length) % tab.length]!;
        const f = findFree(at.p.save.inventory, it.gridW, it.gridH, cfg.get('balance').inventory);
        if (!f) return;
        cmd(w, h, { cmd: 'stashMove', uid: it.uid, dst: 'inv', x: f.x, y: f.y });
      }
      await drain();
      return;
    }
    case 'sell': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || at.room.area !== 'town') return;
      const inv = at.p.save.inventory.filter((i) => !i.use);
      if (!inv.length) return;
      const uid = inv[Math.floor(op.r * inv.length) % inv.length]!.uid;
      const ws = at.ws;
      const id = cmd(w, h, { cmd: 'sell', uid, minGold: 0 });
      await drain();
      if (ws.frames.some((f) => f.t === 'cmdResult' && f.id === id && f.ok)) w.sold.add(uid);
      return;
    }
    case 'chest': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || !at.p.alive || at.room.area !== 'dungeon') return;
      const cs = at.room.session.world.chests.filter((c) => !c.opened);
      if (!cs.length) return;
      const c = cs[Math.floor(op.r * cs.length) % cs.length]!;
      place(at.p, beside(at.room, c.pos, op.r) ?? c.pos);
      send(w, h, { t: 'chest', chestId: c.id });
      await drain();
      return;
    }
    case 'fault': db.faults.push({ kind: op.f, ...(op.h !== null ? { charId: heroOf(w, op.h).charId } : {}) }); return;
    case 'retry': kickRetry(w); await drain(4); return;
    case 'recruit': {
      if (w.heroes.length >= HEROES_MAX) return;
      const i = w.heroes.length;
      const r = fuzzRng(mixSeed(w.seed, 0x4e0 + i));
      const accs = [...new Set(w.heroes.map((h) => Number(h.userId.slice('fz-u'.length))))];
      w.heroes.push(newHero(r, i, r.chance(0.5) ? r.pick(accs) : Math.max(...accs) + 1));
      return;
    }
    // ── кластер ──
    case 'crash': {
      const inc = w.nodes[op.n % NODES];
      if (!inc || inc.dead) return;
      killInc(w, inc, 'crash');
      await drain();
      return;
    }
    case 'drain': {
      const inc = w.nodes[op.n % NODES];
      if (!inc || inc.dead || inc.draining || inc.frozenAt) return;
      await drainNode(w, inc, !!op.bg);
      return;
    }
    case 'crashAt': {
      const inc = w.nodes[op.n % NODES];
      if (!inc || inc.dead || inc.frozenAt) return;
      inc.crashAt = op.calls;
      w.events.push(`crashAt:${inc.node}+${op.calls}@${w.op}`);
      return;
    }
    case 'restart': {
      const inc = w.nodes[op.n % NODES];
      if (inc && !inc.dead) return;
      await boot(w, op.n % NODES);
      await drain();
      return;
    }
    case 'stall': case 'partition': {
      const inc = w.nodes[op.n % NODES];
      if (!inc || inc.dead || inc.frozenAt) return;
      // Окно дизайна по умолчанию: паузы и разделы вместе (они накладываются) — не дольше `OUTAGE_CAP_MS` с последнего дошедшего удара.
      const until = OUTAGE_LONG || op.long ? Date.now() + op.ms : Math.min(Date.now() + op.ms, inc.lastBeatOk + OUTAGE_CAP_MS);
      if (op.k === 'stall') inc.stallUntil = Math.max(inc.stallUntil, until); else inc.partitionUntil = Math.max(inc.partitionUntil, until);
      w.clusterTouched = true;
      w.events.push(`${op.k}:${inc.node}:${Math.round(op.ms / 1000)}с@${w.op}`);
      tally(`node:${op.k}`);
      return;
    }
    case 'regFault': w.regFaults.push({ op: op.op, kind: op.kind, ...(op.n !== null ? { node: `node-${op.n % NODES}` } : {}) }); return;
    case 'suspend': {
      const inc = w.nodes[op.n % NODES];
      if (!inc || inc.dead || inc.frozenAt || inc.draining || alive(w).length < 2) return;
      // ⭐ R17-01: пауза посреди удара сердца — удар идёт сейчас (как удар по расписанию), и машина встаёт на своём месте в нём (`pausePoint`).
      // До этого места удар не дошёл (пауза сердцебиения, раздел, сверка его уже отгородила) — пауза ложится сразу, как прежде.
      if (op.mid) {
        inc.midPause = { at: op.mid, ms: op.ms, wall: op.wall };
        process.env.DM_NODE_ID = inc.node;
        inc.pausedBeat = inProc(inc, () => beat(w, inc)).catch(() => undefined);
        await drain();
        inc.midPause = undefined;
        if (inc.dead) return;
      }
      if (!inc.frozenAt) freeze(w, inc, op.ms, op.wall);
      // Сразу — до срока смерти ноды в реестре (удары другой ноды, уборка гейтвея): иначе паузу снимала бы первая операция со сдвигом времени.
      for (let t = 0; t < (NODE_DEAD_SEC + 4) * 1000; t += BEAT_MS) await vi.advanceTimersByTimeAsync(BEAT_MS);
      await drain();
      return;
    }
  }
}

/**
 * ⭐ R16-02: МАШИНА НОДЫ ВСТАЛА (`suspend`). Для мира процесс ушёл с этого мига (как упавший: правда его героев — строка базы, взятое на узлах
 * без записи — ушло с ним): вернувшись, он обязан уйти без записи (реестр его уже отдал), а не играть дальше своими копиями.
 */
function freeze(w: W, inc: Inc, ms: number, wall: boolean): void {
  const left = inc.lease.leaseLeft();
  forget(w, inc);
  inc.frozenUntil = inc.frozenAt + ms; inc.frozenLeft = left; inc.frozenWall = wall;
  w.clusterTouched = true;
  w.events.push(`suspend:${inc.node}:${Math.round(ms / 1000)}с${wall ? '' : '(часы стояли)'}@${w.op}`);
  tally('node:suspend');
}

/**
 * ⭐ R17-01: МЕСТО ПАУЗЫ ПОСРЕДИ УДАРА СЕРДЦА (`suspend.mid`). Ответ реестра, на котором удар стоит (сверка возраста удара — «жива», продление
 * своих), был верен в миг ответа, а машина встаёт сразу после: удар продолжится только после паузы (`thaw`) — с ответом, устаревшим на её длину.
 */
async function pausePoint(w: W, inc: Inc, at: 'claims' | 'beat'): Promise<void> {
  const m = inc.midPause;
  if (!m || m.at !== at) return;
  inc.midPause = undefined;
  freeze(w, inc, m.ms, m.wall);
  w.events.push(`suspend-mid:${at}@${w.op}`);
  tally(`node:suspend-mid-${at}`);
  await new Promise<void>((res) => { inc.resumeBeat = res; });
}

/**
 * ⭐ R16-02: ПАУЗА МАШИНЫ КОНЧИЛАСЬ. Часы процесса стояли: аренда — с тем же остатком, что на начало паузы, а настенные часы догнал chrony
 * (`frozenWall`) — или стояли и они (тогда и сомнения нет). Первым — удар сердца: реестр уже отдал её героев и забеги, и процесс обязан уйти
 * без записи (`node.ts`: сверка возраста удара по часам базы). Настенные часы ушли вперёд — сомнение в аренде, и `checkLease` шлёт удар сразу
 * (записи до него отгорожены, `leaseLost`); стояли все часы — удар по расписанию не позже чем через `BEAT_MS`, а окно до него (запись копии
 * ложится только поверх строки той же версии, её никто не трогал) — вне этой модели. Ожил (самопроверка) — клиенты за паузу ушли (сокеты
 * закрыты — процесс видит это сразу), таймеры срабатывают через свой остаток на начало паузы.
 */
async function thaw(w: W, inc: Inc): Promise<void> {
  const paused = Date.now() - inc.frozenAt;
  inc.frozenAt = 0; inc.frozenUntil = 0; inc.thawed = true;
  inc.lease.leaseBeat(inc.frozenWall ? inc.sentAt : inc.sentAt + paused, performance.now() - (LEASE_MS - inc.frozenLeft));
  w.events.push(`resume:${inc.node}:${Math.round(paused / 1000)}с@${w.op}`);
  tally('node:resume');
  process.env.DM_NODE_ID = inc.node;
  const resume = inc.resumeBeat;
  inc.resumeBeat = undefined;
  if (resume) {
    // ⭐ R17-01: пауза легла посреди удара — он и продолжается (с ответом, устаревшим на её длину), а не начинается новый.
    let done = false;
    void (inc.pausedBeat ?? Promise.resolve()).then(() => { done = true; });
    resume();
    for (let t = 0; !done && t < 4 * LATE_MS; t += 50) { await drain(); if (!done) await vi.advanceTimersByTimeAsync(50); }
  } else {
    await inProc(inc, () => beat(w, inc)).catch(() => undefined);
  }
  await drain();
  if (inc.dead) return;
  // ⭐ Перепрогон R16: удар сверки не дошёл — реестр ещё недоступен (длинная пауза сердцебиения, раздел): нода жива до конца аренды (`ENV-thaw-registry-silent`).
  if (Date.now() < inc.stallUntil || Date.now() < inc.partitionUntil) {
    w.thawSilent = true;
    w.events.push(`thaw-silent:${inc.node}@${w.op}`);
    tally('env:thaw-registry-silent');
  }
  inc.writtenOff = false;   // ожил (самопроверка): дальше его копии — снова его
  for (const c of w.lobbies) if (c.inc === inc && c.open) c.close();
  const held = [...inc.held.values()];
  inc.held.clear();
  for (const t of held) inProc(inc, () => setTimeout(t.run, t.at));
  await drain();
  await vi.advanceTimersByTimeAsync(BEAT_MS + 50);
  await drain();
}
const tierIds = (): string[] => cfg.get('difficulties').map((d) => d.id);
/**
 * Фоновая дописка копий на живых нодах — как её таймер: не дожидаясь. Дописка стоит в очереди героя, а там бывает дело, которое ждёт таймера
 * (потолок прощальной записи, удержание выброшенного): операция, ждущая дописку при стоящих часах, ждала бы вечно.
 */
function kickRetry(w: W): void {
  for (const inc of alive(w)) {
    process.env.DM_NODE_ID = inc.node;
    void inProc(inc, () => inc.rm.retryUnsaved(Date.now())).catch(() => undefined);
  }
}

// ── Процессы нод ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Сбой запроса реестра, заказанный фаззером (`regFault`): `fail` — до фиксации, `landed` — легло, ответ потерян. */
function takeReg(w: W, op: RegOp, node: string | undefined): 'fail' | 'landed' | 'late' | undefined {
  const i = w.regFaults.findIndex((f) => f.op === op && (f.node === undefined || f.node === node));
  if (i < 0) return undefined;
  tally(`regFault:${op}`);
  return w.regFaults.splice(i, 1)[0]!.kind;
}
/**
 * ВОРОТА ПРОЦЕССА: запрос процесса `inc` к базе или реестру. Процесса нет — запрос не уходит и ответа нет (цепочка, ждущая его, так и
 * стоит: процесса, который бы её продолжил, не существует). Раздел с базой — отказ сразу. Иначе — как есть (тело запроса исполняется при
 * вызове, как у настоящего: запрос уходит сразу).
 */
/** Ошибка, которую заказал фаззер (раздел, сбой реестра или базы): исключение из-за неё — штатный отказ, а не ошибка кода (6). */
const INJECTED = Symbol('fuzzInjected');
function injected<E extends Error>(e: E): E { (e as unknown as Record<symbol, boolean>)[INJECTED] = true; return e; }
const isInjected = (e: unknown): boolean => !!e && typeof e === 'object' && (e as Record<symbol, unknown>)[INJECTED] === true;
function gate<R>(inc: Inc, fn: () => R | Promise<R>, counted = true): Promise<R> {
  if (inc.dead) return new Promise<R>(() => undefined);
  // `crashAt`: процесс падает на этом запросе — он не уходит, а всё, что процесс не успел, уходит с ним.
  if (counted && inc.crashAt > 0 && --inc.crashAt === 0 && cur) { killInc(cur, inc, 'crash'); return new Promise<R>(() => undefined); }
  if (Date.now() < inc.partitionUntil) return Promise.reject(injected(Object.assign(new Error(`${inc.node}: нет связи с базой`), { code: 'ECONNRESET' })));
  try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
}
function dbFor(inc: Inc, CommitUnknown: typeof import('../db/errors.js').CommitUnknown): Record<string, unknown> {
  const core = dbCore(CommitUnknown) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(core)) {
    out[name] = (...a: unknown[]) => gate(inc, async () => {
      const r = await fn(...a);
      // Сейв, прочитанный этим процессом, — его: штраф на нём процесс, которого нет, в мир не кладёт (см. `spy.onPenalty`).
      if (name === 'getCharacter' && r) Object.defineProperty((r as { data: object }).data, INC_TAG, { value: inc, enumerable: false });
      return r;
    });
  }
  return out;
}
function registryFor(w: W, inc: Inc): RegIn {
  const call = <T>(op: RegOp | null, fn: () => T): Promise<T> => gate(inc, () => {
    const f = op ? takeReg(w, op, inc.node) : undefined;
    if (f === 'late') return lateReg(w, inc, fn);
    if (f === 'fail') throw injected(new Error(`реестр: ${op} упал до фиксации`));
    const r = fn();
    if (f === 'landed') throw injected(new Error(`реестр: ${op} — ответ на фиксацию потерян`));
    return r;
  }, op !== 'touchClaims' && op !== 'touchRuns' && op !== 'heartbeat');
  const c = w.cluster;
  // `DM_FUZZ_TRACE=1`: и забеги реестра — кто, когда (поддельное время) и с каким итогом лёг (поздний — в миг, когда лёг).
  const traced = <T>(what: string, fn: () => T): (() => T) => (!FUZZ_TRACE ? fn : () => {
    const r = fn();
    console.info(`[fuzz ${w.seed}]       реестр ${inc.node}#${inc.gen} +${Date.now() - T0}мс ${what} → ${r instanceof Set ? JSON.stringify([...r]) : JSON.stringify(r ?? null)}`);
    return r;
  });
  return {
    releaseChar: (id, n) => call('releaseChar', () => c.releaseChar(id, n)),
    claimForJoin: (id, n) => call('claimForJoin', () => (FUZZ_SELFTEST === 'claim' ? stealClaim(w, id, n) : c.claimForJoin(id, n))),
    claimOwner: (id) => call('claimOwner', () => c.claimOwner(id)),
    claimRun: (k, n, r) => {
      const sent = ++w.regSeq;
      return call('claimRun', traced(`claimRun ${k.slice(-6)} ${r}`, () => {
        const held = FUZZ_SELFTEST === 'runlock' ? (c.runLocks.set(k, { node: n, room: r, liveAt: Date.now() }), null) : c.claimRun(k, n, r);
        if (held) w.claimSaw.set(`${k}@${held}`, Date.now());
        // ⭐ Перепрогон R16: комната взяла забег снова после своего отпуска — отпуск больше не судит её продления (`releasedSeq`).
        else if ((w.releasedSeq.get(`${k}@${n}@${r}`) ?? Infinity) < sent) { w.runReleasedAt.delete(`${k}@${n}@${r}`); w.releasedSeq.delete(`${k}@${n}@${r}`); }
        return held;
      }));
    },
    releaseRun: (k, n, r) => {
      const p = call('releaseRun', traced(`releaseRun ${k.slice(-6)} ${r}`, () => {
        w.runReleasedAt.set(`${k}@${n}@${r}`, Date.now()); w.releasedSeq.set(`${k}@${n}@${r}`, ++w.regSeq);
        return c.releaseRun(k, n, r);
      }));
      p.catch(() => { if (cur === w) w.releaseFailedAt.set(`${k}@${n}@${r}`, Date.now()); });
      return p;
    },
    touchClaims: (ids, n, leased) => call('touchClaims', () => c.touchClaims(ids, n, leased)),
    touchRuns: (rs, n, leased) => call('touchRuns', traced(`touchRuns ${rs.map((x) => `${x.key.slice(-6)} ${x.room}`).join(',')}`, () => c.touchRuns(rs, n, leased))),
    heartbeat: (n, s, leased) => call('heartbeat', () => c.heartbeat(n, s, leased)),
    nodeBeatAge: (n) => gate(inc, () => c.nodeBeatAge(n), false),
    releaseNode: (n) => call(null, () => c.releaseNode(n)),
    releaseNodeRuns: (n) => call(null, () => c.releaseNodeRuns(n)),
    clearAllRuns: (self) => call(null, () => {
      const rows = new Map([...db.rows].map(([id, r]) => [id, {
        hasRun: () => (JSON.parse(r.json) as SaveState).run !== undefined,
        dropRun: () => { const s = JSON.parse(r.json) as SaveState; delete s.run; r.json = JSON.stringify(s); r.version++; },
      }]));
      return c.clearAllRuns(self, rows);
    }),
  };
}
/** ⭐ R15-08: поздний запрос реестра достаётся базе через этот срок поддельного времени (шаги комнат между — десяток). */
const LATE_MS = 300;
/**
 * ⭐ R15-08: ЗАПРОС РЕЕСТРА ЛОЖИТСЯ С ОПОЗДАНИЕМ (`late`): база применит его через `LATE_MS`, и всё, что процесс сделал за это время (комната
 * отпустила забег — её `DELETE` лёг сразу), легло раньше. Процесс умер — запрос всё равно лёг (он уже в базе), но ответа нет.
 */
function lateReg<T>(w: W, inc: Inc, fn: () => T): Promise<T> {
  w.lateInFlight++;
  tally('regFault:late');
  return new Promise<T>((res, rej) => {
    setTimeout(() => {
      w.lateInFlight--;
      if (cur !== w) return;
      let r: T;
      try { r = fn(); } catch (e) { if (!inc.dead) rej(e); return; }
      if (!inc.dead) res(r);
    }, LATE_MS);
  });
}
/** Самопроверка `claim`: закрепление на входе забирается всегда (правило держания сломано) — фаззер обязан найти `a-live-two-nodes`. */
function stealClaim(w: W, id: string, n: string): string {
  w.cluster.claims.set(id, { node: n, touchedAt: Date.now(), liveAt: Date.now() });
  return n;
}

/**
 * Инструменты фаззера на экземпляре графа процесса: наблюдение за методами комнаты и менеджера (как в фаззере одной ноды — там шпионы
 * `vi.spyOn`, здесь — обёртки прямо на прототипах: экземпляров сотни, а реестр шпионов vitest держал бы каждый граф в памяти до конца
 * файла) и планировщик (тик ведёт фаззер).
 */
function instrument(w: W, inc: Inc, rmMod: typeof import('./roomManager.js'), roomMod: typeof import('./room.js'), sched: typeof import('./scheduler.js')): void {
  const mine = (room: RoomIn): boolean => cur === w && !inc.dead && w.born.has(room);
  // Самопроверка `held`: выброшенное не держится строкой выбросившего до его записи (V-B2-04 снят) — после падения ноды вещь у двоих (c).
  if (FUZZ_SELFTEST === 'held') (roomMod.Room.prototype as unknown as Record<string, unknown>).holdThrown = () => undefined;
  // Самопроверка `k3`: подъём выброшенного — снова памятью, а запись поднявшего следом (как до прохода правок 2): процесс, умерший до неё,
  // теряет записанное (c, K3 — сжатые K3a–K3d падают).
  if (FUZZ_SELFTEST === 'k3') {
    type Old = { session: { pickupDropById(pid: string, id: number): unknown }; persist(pid: string): Promise<unknown> };
    (roomMod.Room.prototype as unknown as Record<string, unknown>).pickThrown = function (this: Old, _c: unknown, pid: string, dropId: number) {
      const got = this.session.pickupDropById(pid, dropId);
      if (got) void this.persist(pid);
      return Promise.resolve(got ? { ok: true } : { ok: false, reason: 'Далеко или инвентарь полон' });
    };
  }
  // ⭐ Самопроверка `r15settle` (перепрогон R15): строка забега не сверяется с держателем, как до правки — отпуск, упавший сбоем, не
  // повторяется, а строку, которую позднее продление переписало на прежнюю комнату ноды, никто не правит (фаззер обязан найти
  // `b-run-lock-orphan`: повторы 7200355 и 7201016 падают; и отпуск при живом держателе молчит — `5-resume-dead-end`, повторы 7240242 и 7250928); и
  // удар судит «чужие» забеги по снимку (`b-run-lock-lost`: повтор 7230032).
  if (FUZZ_SELFTEST === 'r15settle') {
    const rp = rmMod.RoomManager.prototype as unknown as Record<string, unknown>;
    rp.releaseRun = (key: string, code: string): void => { void inc.reg.releaseRun(key, inc.node, code).catch(() => undefined); };
    rp.settleRun = function (this: { runHolder(key: string): unknown }, key: string, code: string): void {
      if (!this.runHolder(key)) void inc.reg.releaseRun(key, inc.node, code).catch(() => undefined);
    };
  }
  sched.tickScheduler.add = ((r: RoomIn) => { if (inc.dead || cur !== w) return; w.ticking.add(r); w.born.add(r); w.roomInc.set(r, inc); }) as never;
  sched.tickScheduler.remove = ((r: RoomIn) => { if (cur === w && w.roomInc.get(r) === inc) w.ticking.delete(r); }) as never;
  const proto = roomMod.Room.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const wrap = (target: Record<string, (...a: unknown[]) => unknown>, name: string, fn: (self: unknown, a: unknown[], call: () => unknown) => unknown): void => {
    const orig = target[name]!;
    target[name] = function (this: unknown, ...a: unknown[]) { return fn(this, a, () => orig.apply(this, a)); };
  };
  const after = (name: string, fn: (room: RoomIn, ret: unknown) => void, pre?: (room: RoomIn) => void): void =>
    wrap(proto, name, (self, _a, call) => { pre?.(self as RoomIn); const r = call(); fn(self as RoomIn, r); return r; });
  const groundGone = (room: RoomIn): void => {
    if (!mine(room)) return;
    // ⭐ K3: поднимаемое (запись поднимающего в пути) с землёй не уходит — легла запись, вещь в его сумке; не легла — пропажа проверкой (сток).
    for (const d of room.session.world.drops) if (d.kind === 'item' && d.item) (room.carrying?.has(d) ? w.carryGone : w.sinks).add(d.item.uid);
  };
  after('enterNode', (room) => { if (mine(room)) { noteReached(w, room, [...room.clients.keys()]); noteRevived(w, room); } }, groundGone);
  after('enterTown', (room) => { if (mine(room)) noteRevived(w, room); }, groundGone);
  after('enterArenaFloor', () => undefined, groundGone);
  after('stop', groundGone);
  after('attach', (room, pid) => {
    if (!mine(room)) return;
    noteReached(w, room, [pid as string]);
    const save = room.session.world.players[pid as string]?.save;
    const h = w.heroes.find((x) => x.charId === save?.charId);
    if (h && save) h.lastSave = save;
    if (h && room.runConfig && room.nodeState && save?.run?.config && runLedgerKey(save.run.config) === runLedgerKey(room.runConfig)) {
      h.reached.add(`${runLedgerKey(room.runConfig)}|${room.nodeState.id}`);
    }
  });
  // c: копию героя сняли проигравшей (закрепление у другой ноды, R2-05) — его правда теперь там или в строке базы. ⭐ Перепрогон R17: снимает
  // процесс, которого мир уже списал (пауза машины, `forget`; проснувшийся посреди удара продолжает его — R17-01 — и снимает свои копии до
  // выхода), — правды героя это не трогает: его копии откатились ещё на паузе (как его смерть — `killInc`), а правда теперь у другой ноды.
  wrap(proto, 'fence', (self, a, call) => {
    const r = call();
    if (mine(self as RoomIn) && r) {
      if (!inc.writtenOff) rollBack(w, [a[0] as string]);
      w.events.push(`fence:${String(a[0])}@${inc.node}#${inc.gen}`); tally('fence');
    }
    return r;
  });
  const taken = (charId: string): number => w.penaltyCount.get(charId) ?? 0;
  const opText = (): string => (w.opRef ? fmt(w.opRef) : 'эпилог');
  wrap(proto, 'abandonAsDead', (self, a, call) => {
    const room = self as RoomIn;
    const [charId, insurance] = a as [string, boolean | undefined];
    const info = room.disconnected.get(charId);
    const h = mine(room) ? heroBy(w, charId) : undefined;
    const need = !!h && !insurance && !!info?.save.run?.config && !deathPaid(w, h);
    const n0 = taken(charId);
    const r = call();
    if (need && taken(charId) === n0) {
      violate(w, '3-missing-penalty', `${charId}: «Завершить» из грейса комнаты ${room.code}/${inc.node} (${info!.safe ? 'забег припаркован' : 'ждал реконнекта'}${info!.paid ? ', paid' : ''}${info!.save.run?.deadAt !== undefined ? `, «мёртв» на ${info!.save.run.deadAt}` : ''}) — без штрафа, а он с тех пор оживал; операция ${opText()}`, h);
    }
    return r;
  });
  const rmProto = rmMod.RoomManager.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  // 6: кадр, погашенный отказом базы или реестра, заказанным фаззером, — штатный «занято» (R3-14), а не ошибка кода.
  wrap(rmProto, 'onFrame', (_self, _a, call) => (call() as Promise<unknown>).catch((e: unknown) => {
    if (cur === w && isInjected(e)) w.expectFrame++;
    throw e;
  }));
  wrap(rmProto, 'abandonStored', (_self, a, call) => {
    const charId = a[1] as string;
    const h = cur === w && !inc.dead ? heroBy(w, charId) : undefined;
    const row = rowSave(charId);
    const need = !!h && !!row?.run?.config && !deathPaid(w, h);
    const n0 = taken(charId);
    return (call() as Promise<unknown>).then((r) => {
      if (need && cur === w && !inc.dead && taken(charId) === n0 && db.writes.some((x) => x.ok && x.charId === charId)) {
        violate(w, '3-missing-penalty', `${charId}: «Завершить» по строке базы на ${inc.node} (${row!.run!.deadAt !== undefined ? `«мёртв, оплачено» на ${row!.run!.deadAt}` : 'забег'}) — без штрафа, а он с тех пор оживал; операция ${opText()}`, h);
      }
      return r;
    });
  });
  const BURY = new Set(['bury', 'buryFled']);
  for (const name of ['wipe', 'expireGrace', 'buryFled']) {
    wrap(proto, name, (self, _a, call) => {
      const room = self as RoomIn;
      if (!mine(room)) return call();
      const key = room.runConfig ? runLedgerKey(room.runConfig) : null;
      const guests = [...room.disconnected].filter(([, i]) => i.save.run?.config && runLedgerKey(i.save.run.config) !== key)
        .map(([charId, info]) => ({ charId, info, run: runLedgerKey(info.save.run!.config) }));
      const buried = (id: string): number => w.penalties.filter((p) => p.charId === id && BURY.has(p.src)).length;
      const n0 = new Map(guests.map((g) => [g.charId, buried(g.charId)]));
      const r = call();
      for (const g of guests) {
        const now = g.info.save.run?.config ? runLedgerKey(g.info.save.run.config) : null;
        const paid = buried(g.charId) > n0.get(g.charId)!;
        if (now === g.run && !paid) continue;
        violate(w, '3-foreign-run-buried', `${g.charId}: ${name} комнаты ${room.code} (её забег ${key ?? '—'}) — ${[paid ? 'штраф' : '', now !== g.run ? 'забег снят' : ''].filter(Boolean).join(' и ')}, а его забег ${g.run} ей чужой; операция ${opText()}`, heroBy(w, g.charId));
      }
      return r;
    });
  }
  wrap(proto, 'reconnect', (self, a, call) => {
    const room = self as RoomIn;
    const ws = a[0] as FakeConn, save = a[2] as SaveState;
    if (mine(room) && ws.resume) {
      const info = room.disconnected.get(save.charId);
      const own = info?.save.run?.config;
      if (info?.safe && own && (!room.runConfig || runLedgerKey(own) !== runLedgerKey(room.runConfig))) {
        violate(w, '5-resume-foreign-run', `${save.charId}: «Продолжить» — в комнату ${room.code} (${room.area}, забег ${room.runConfig ? runLedgerKey(room.runConfig) : '—'}), а его припаркованный забег — ${runLedgerKey(own)}; операция ${opText()}`, heroBy(w, save.charId));
      }
    }
    return call();
  });
  // 5 (⭐ R17-02, как у фаззера одной ноды): «Продолжить» живого участника — не в город (арену) держателя, где кто-то подключён: его спуск ждал
  // бы чужого голоса, а выход был «Забросить». С забегом в сейве к держателю — только в подземелье.
  wrap(proto, 'addPlayer', (self, a, call) => {
    const room = self as RoomIn;
    const ws = a[0] as FakeConn, save = a[2] as SaveState;
    if (mine(room) && ws.resume && save.run?.config && room.area !== 'dungeon' && room.clients.size > 0) {
      violate(w, '5-run-hostage', `${save.charId}: «Продолжить» на ${inc.node} — в ${room.area} комнаты ${room.code} (подключено ${room.clients.size}), чей забег ${runLedgerKey(save.run.config)} стоит не в подземелье: его спуск ждёт голоса других; операция ${opText()}`, heroBy(w, save.charId));
    }
    return call();
  });
  wrap(proto, 'startRun', (self, _a, call) => {
    const room = self as RoomIn;
    if (mine(room)) {
      const ds = cfg.get('difficulties');
      const i = ds.findIndex((d) => d.id === room.difficultyId);
      const heroes = [...room.clients.keys()].map((pid) => room.session.world.players[pid]?.save).filter((s): s is SaveState => !!s);
      if (!heroes.some((s) => isDifficultyUnlocked(ds, i, s.difficultyProgress ?? {}))) {
        violate(w, '8-tier-locked-start', `комната ${room.code} начала забег в тире «${room.difficultyId}», закрытом всем подключённым; операция ${opText()}`);
      }
    }
    return call();
  });
}

/**
 * ПРОЦЕСС НОДЫ `n` СТАРТУЕТ (`index.ts`, роль node): свой граф модулей, сброс забегов (`clearAllRuns`), снятие забегов прошлого процесса
 * (`releaseNodeRuns`), хранилище забегов кластера, менеджер комнат, вход в кластер (первый удар сердца — сразу; не прошёл — процесс падает,
 * супервизор поднимет позже), удары каждые 2 с.
 */
async function boot(w: W, n: number): Promise<Inc | undefined> {
  const node = `node-${n}`;
  const prev = w.nodes[n];
  const inc: Inc = {
    node, n, gen: ++w.incSeq, dead: false, diedAt: 0, why: '', draining: false, stopped: false,
    stallUntil: 0, partitionUntil: prev?.partitionUntil ?? 0, lastBeatOk: Date.now(), crashAt: 0, ever: new Set(),
    frozenAt: 0, frozenUntil: 0, frozenLeft: 0, frozenWall: true, held: new Map(), sentAt: Date.now(), thawed: false, writtenOff: false,
    rm: null as unknown as RmIn, hooks: null as unknown as ClusterHooksIn, reg: null as unknown as RegIn, runLedgerKey: () => '',
    lease: null as unknown as typeof import('../cluster/lease.js'),
  };
  vi.resetModules();
  process.env.DM_NODE_ID = node;
  vi.doMock('../db/db.js', async () => dbFor(inc, (await import('../db/errors.js')).CommitUnknown));
  vi.doMock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
  vi.doMock('../cluster/registry.js', () => registryFor(w, inc));
  vi.doMock('../cluster/node.js', () => ({ isDraining: () => inc.draining }));
  const rmMod = await import('./roomManager.js');
  const roomMod = await import('./room.js');
  const sched = await import('./scheduler.js');
  inc.lease = await import('../cluster/lease.js');
  inc.reg = registryFor(w, inc);
  inc.runLedgerKey = roomMod.runLedgerKey;
  runLedgerKey = roomMod.runLedgerKey;
  instrument(w, inc, rmMod, roomMod, sched);
  w.nodes[n] = inc;
  w.incs.push(inc);
  w.events.push(`boot:${node}#${inc.gen}@${w.op}`);
  tally('node:boot');
  return inProc(inc, async () => {
    try {
      await inc.reg.clearAllRuns(node);
      await inc.reg.releaseNodeRuns(node);
    } catch {
      killInc(w, inc, 'boot-failed');
      return undefined;
    }
    rmMod.setRunLockStore({ claim: (key, room) => inc.reg.claimRun(key, node, room), release: (key, room) => inc.reg.releaseRun(key, node, room) });
    inc.rm = new rmMod.RoomManager(cfg) as unknown as RmIn;
    inc.hooks = rmMod.clusterHooks as unknown as ClusterHooksIn;
    // Самопроверка `leak`: нода считает, что держит всех, кого держала хоть раз (утечка в `liveCharIds`), — закрепление не отпускается
    // никогда: сердцебиение восстанавливает снятое, и вход на другой ноде получает отказ навсегда (d).
    if (FUZZ_SELFTEST === 'leak') {
      const orig = inc.hooks.liveCharIds.bind(inc.hooks);
      inc.hooks = { ...inc.hooks, liveCharIds: () => { for (const id of orig()) inc.ever.add(id); return [...inc.ever]; } };
    }
    try {
      await beat(w, inc, true);
    } catch {
      killInc(w, inc, 'boot-failed');
      return undefined;
    }
    inc.timer = setInterval(() => { void beat(w, inc).catch(() => undefined); }, BEAT_MS);
    return inc;
  });
}

/**
 * Удар сердца ноды — порядок `joinCluster.beatOnce`: продлить своих (кого нет в ответе — проиграли), продлить забеги комнат (кого нет —
 * ИНЦИДЕНТ, и комнаты их отпускают — ⭐ ENV1 `fenceRuns`), удар (дошёл — аренда продлена от его отправки), снять проигравших (`fenceLost`),
 * снять тех, кто ушёл, пока шло продление (`releaseIdle`). Пауза (`stall`) — удар не доходит. ⭐ ENV1: и сверка аренды (`checkLease` —
 * у ноды раз в секунду, здесь — с каждым ударом по расписанию): кончилась — выход без записи. ⭐ R16 C-05: на исходе — слива нет (удар, дошедший
 * до конца аренды, её продлевает), а дошедший после конца её не продлевает.
 */
async function beat(w: W, inc: Inc, first = false): Promise<void> {
  if (inc.dead || inc.stopped || cur !== w) return;
  if (!first) {
    const left = inc.lease.leaseLeft();
    if (left <= 0) { tally('node:lease-lost'); killInc(w, inc, 'lease'); return; }
    if (left <= DRAIN_GUARD_MS) tally('node:lease-low');
  }
  // Окно дизайна: живая нода молчит почти `NODE_DEAD_SEC` — дальше реестр по правилу отдаёт её героев и забеги другой (R7-09). ⭐ R16-02: не
  // пауза машины — после неё нода обязана уйти сама (сверка ниже), это не простой базы.
  if (Date.now() - inc.lastBeatOk >= NODE_DEAD_SEC * 1000 - 2 * BEAT_MS && !w.envelope && !inc.thawed) {
    w.envelope = true;
    w.events.push(`envelope:${inc.node}@${w.op}`);
    tally('env:outage-over-dead-sec');
  }
  if (!first && Date.now() < inc.stallUntil) return;
  const sentAt = Date.now();
  const sentMono = performance.now();   // ⭐ R15-06: срок аренды — по часам процесса (здесь они идут с настенными, `performance.now`)
  // ⭐ R16-02: сперва — давно ли реестр видел ноду (часы базы, `node.ts`): дольше аренды или строки нет — выход без записи. Самопроверка `r1602` —
  // без этой сверки и без её второго рубежа в продлении (`leased`): фаззер обязан найти `a-dead-node-revived`.
  const guard = !teeth.r1602;
  if (!first && guard) {
    const age = await inc.reg.nodeBeatAge(inc.node);
    if (inc.dead) return;
    if (age === null || age * 1000 >= LEASE_MS) { tally('node:registry-saw-dead'); killInc(w, inc, 'lease'); return; }
  }
  // ⭐ R17-01: удар ноды с арендой ложится только с проверкой живости в нём самом (`heartbeat(…, leased)`). Самопроверка `r1701` — без неё
  // (безусловная вставка, как до правки): пауза машины после ответа сверки обязана дать `a-dead-node-revived`.
  const atomic = guard && !teeth.r1701;
  await pausePoint(w, inc, 'claims');
  if (inc.dead) return;
  const hooks = inc.hooks;
  const held = hooks.liveCharIds();
  const kept = await inc.reg.touchClaims(held, inc.node, guard);
  const runs = hooks.heldRuns();
  if (runs.length) {
    const keptRuns = await inc.reg.touchRuns(runs, inc.node, guard);
    // ⭐ Перепрогон R15: чужие — только те, что нода держит и после ответа (`node.ts`): отпущенный за время продления забег взяла другая нода законно.
    const nowHeld = hooks.heldRuns();
    const lostRuns = FUZZ_SELFTEST === 'r15settle' ? runs.filter((r) => !keptRuns.has(r.key))
      : nowHeld.filter((r) => !keptRuns.has(r.key) && runs.some((s) => s.key === r.key));
    if (lostRuns.length) {
      console.error(`[${inc.node}] ИНЦИДЕНТ: забеги комнат ${lostRuns.map((r) => r.room).join(', ')} кластер числит за другой нодой — один забег идёт в двух местах`);
      hooks.fenceRuns(lostRuns);
    }
    // ⭐ R15-08: забег, который комната отпустила, пока продление шло в базу, — отпустить снова (`node.ts`, `runsGone`). Самопроверка `r1508` —
    // без этого (фаззер обязан найти `b-run-lock-orphan`). ⭐ Перепрогон R15: по паре «забег, комната» — забег взяла другая комната ноды.
    const pair = (r: { key: string; room: string }): string => (FUZZ_SELFTEST === 'r15settle' ? r.key : `${r.key}@${r.room}`);
    const still = new Set(nowHeld.map(pair));
    const goneRuns = runs.filter((r) => keptRuns.has(r.key) && !still.has(pair(r)));
    if (goneRuns.length && FUZZ_SELFTEST !== 'r1508') hooks.releaseRuns(goneRuns);
  }
  await pausePoint(w, inc, 'beat');
  if (inc.dead) return;
  const prevAge = w.cluster.nodeBeatAge(inc.node);   // (a, R16-02) — до удара: не оживляет ли он ноду, которую реестр уже вправе был счесть мёртвой
  const landed = await inc.reg.heartbeat(inc.node, { players: inc.rm.live.size, rooms: inc.rm.rooms.size, draining: inc.draining }, !first && atomic);
  if (inc.dead) return;
  // ⭐ R17-01: удар не лёг — реестр уже счёл ноду мёртвой (ответ сверки устарел на паузу машины): выход без записи, аренда не продлена (`node.ts`).
  if (!landed) { tally('node:beat-refused'); killInc(w, inc, 'lease'); return; }
  // a (⭐ R16-02): удар дошёл, а реестр до него не видел ноду дольше аренды (или её строку сняла уборка) — ожила нода, чьих героев и забеги он
  // уже вправе был отдать: её продление вставляло отданное и отпущенное другой нодой заново, и гейтвей вёл героя к её устаревшей копии.
  if (!first && (prevAge === null || prevAge * 1000 >= LEASE_MS)) {
    violate(w, 'a-dead-node-revived', `${inc.node}#${inc.gen}: удар сердца дошёл, а реестр до него не видел ноду ${prevAge === null ? '(строку сняла уборка)' : `${Math.round(prevAge)} с`} — дольше аренды: её героев и забеги он уже вправе был отдать; ${w.cluster.dump()}`);
  }
  inc.lastBeatOk = Date.now();
  // Самопроверка `lease`: нода аренды не держит (как до ENV1/ENV2) — длинный простой обязан дать героя на двух нодах, слив в раздел — ИНЦИДЕНТ.
  // ⭐ R16 C-05: удар, дошедший уже после конца аренды, её не продлевает (`node.ts`): нода уходит с первой же сверкой.
  if (FUZZ_SELFTEST !== 'lease' && inc.lease.leaseLeft() > 0) { if (inc.lease.leaseLeft() <= DRAIN_GUARD_MS) tally('node:lease-renewed-late'); inc.lease.leaseBeat(sentAt, sentMono); inc.sentAt = sentAt; }
  const lost = held.filter((id) => !kept.has(id));
  if (lost.length && FUZZ_SELFTEST !== 'fence') hooks.fenceLost(lost);
  const still = new Set(hooks.liveCharIds());
  const gone = held.filter((id) => kept.has(id) && !still.has(id));
  if (gone.length) hooks.releaseIdle(gone);
}

/**
 * ПРОЦЕССА НОДЫ БОЛЬШЕ НЕТ (упал, слит, не загрузился): ни записей, ни ответов, ни таймеров для мира; сокеты его игроков оборваны (клиент
 * увидит разрыв, процесс — уже ничего). Правда героев, чьи копии он держал, — строка базы (`rollBack`).
 */
function killInc(w: W, inc: Inc, why: string): void {
  if (inc.dead) return;
  const held = inc.writtenOff ? new Set<string>() : heldBy(w, inc);
  inc.dead = true; inc.diedAt = Date.now(); inc.why = why;
  if (inc.timer) clearInterval(inc.timer);
  for (const r of [...w.ticking]) if (w.roomInc.get(r) === inc) w.ticking.delete(r);
  for (const c of w.lobbies) if (c.inc === inc) c.kill();
  w.clusterTouched = true;
  w.events.push(`${why}:${inc.node}#${inc.gen}@${w.op}`);
  tally(`node:${why}`);
  if (FUZZ_TRACE) console.info(`[fuzz ${w.seed}]     процесс ${inc.node}#${inc.gen} умер (${why}): откат к строке базы — ${[...held].join(', ') || '—'}`);
  settleLost(w, held);
}

/**
 * ⭐ R16-02: ПРОЦЕСС НА ПАУЗЕ МАШИНЫ — ДЛЯ МИРА УШЁЛ, КАК УПАВШИЙ (`killInc`), но жив: вернётся (`thaw`) и обязан уйти без записи. Правда
 * героев, что он держал, — строка базы; взятое его комнатами на узлах без записи — ушло с ним.
 */
function forget(w: W, inc: Inc): void {
  const held = heldBy(w, inc);
  inc.frozenAt = Date.now();
  inc.writtenOff = true;
  if (FUZZ_TRACE) console.info(`[fuzz ${w.seed}]     процесс ${inc.node}#${inc.gen} на паузе машины: откат к строке базы — ${[...held].join(', ') || '—'}`);
  settleLost(w, held);
}

/** Кого процесс держит (сессия, грейс, тело, копии на дописать, закрепление, последняя виденная копия) — и что лежало на земле его комнат. */
function heldBy(w: W, inc: Inc): Set<string> {
  const held = new Set<string>();
  if (inc.rm) {
    for (const [charId, ls] of locate(w)) if (ls.some((l) => l.inc === inc)) held.add(charId);
    for (const id of [...inc.rm.unsaved.keys(), ...inc.rm.inflight.keys(), ...inc.rm.live.keys(), ...inc.rm.graceByChar.keys()]) held.add(id);
    for (const r of roomsOf(w, inc)) for (const s of r.staleFarewells.values()) held.add(s.charId);
  }
  // И тот, кого процесс держал «между»: сессию уже сняли, а прощальную запись ещё не завели (смерть посреди `onClose`), — его закрепление
  // ещё за этой нодой, или последняя виденная копия прочитана этим процессом.
  for (const h of w.heroes) {
    if (w.cluster.claims.get(h.charId)?.node === inc.node) held.add(h.charId);
    if (h.lastSave && (h.lastSave as unknown as Record<string, Inc | undefined>)[INC_TAG] === inc) held.add(h.charId);
  }
  // c: что в миг смерти лежало на земле комнат процесса — ушло с землёй ушедшей комнаты (сток по дизайну), а не «записанное и потерянное».
  // Проверка видит мир только между операциями, а процесс умирает и посреди одной (`crashAt`): выброс и подъём в одной операции (`trade`),
  // подъём, чья запись ушла вместе с процессом (⭐ K3, проход правок 2: в сумку — только после записи), — вещь, до конца лежавшая на земле,
  // числилась у выбросившего. Вещь, которую процесс держал в сумке, — у того, у кого её видели последним: её пропажа ловится, как прежде.
  if (inc.rm) {
    for (const r of roomsOf(w, inc)) {
      for (const d of groundOf(r)) if (d.kind === 'item' && d.item && tracked(d.item)) w.lastLoc.set(d.item.uid, `ground:${r.code}`);
    }
  }
  return held;
}

/** Процесса для мира больше нет (`killInc`, `forget`): правда `held` — строка базы; записи узлов, не легшие никуда, ушли с ним. */
function settleLost(w: W, held: Set<string>): void {
  rollBack(w, held);
  // 8, c: взятое на узлах (сундуки, убитые) комнатами упавшего процесса, но не легшее никуда (свод базы, сейвы в базе, комнаты живых нод), —
  // ушло с ним вместе со своей добычей: узел соберётся с ним заново, и это не повтор.
  const durable = durableRecs(w);
  if (ledgerBehindRows()) { w.ledgerBehind = true; tally('k2:ledger-behind-row-at-death'); }
  for (const [k, rec] of w.recs) {
    const d = durable.get(k);
    for (const c of [...rec.chests]) if (!d?.chests.has(c)) { rec.chests.delete(c); tally('c-rollback-chest'); }
    for (const c of [...rec.killed]) if (!d?.killed.has(c)) rec.killed.delete(c);
  }
}

/** K2: взятое на узле (сундук, убитый) есть в записях забега строки героя в базе, а в своде этого забега в базе — нет. */
function ledgerBehindRows(): boolean {
  for (const r of db.rows.values()) {
    const s = JSON.parse(r.json) as SaveState;
    if (!s.run?.config) continue;
    const m = db.ledger.get(runLedgerKey(s.run.config));
    for (const st of runRecords(s.run, s.run.config)) {
      const l = m?.get(st.id);
      if (st.chests.some((c) => !l?.chests.includes(c)) || st.killed.some((c) => !l?.killed.includes(c))) return true;
    }
  }
  return false;
}

/** Записи узлов забегов, что переживут процесс: свод в базе, забеги сейвов в базе и в памяти живых нод, своды их комнат. */
function durableRecs(w: W): Map<string, { chests: Set<number>; killed: Set<number> }> {
  const out = new Map<string, { chests: Set<number>; killed: Set<number> }>();
  const add = (key: string, st: { chests: readonly number[]; killed: readonly number[] }): void => {
    let a = out.get(key);
    if (!a) out.set(key, (a = { chests: new Set(), killed: new Set() }));
    for (const c of st.chests) a.chests.add(c);
    for (const c of st.killed) a.killed.add(c);
  };
  for (const [runKey, m] of db.ledger) for (const r of m.values()) add(`${runKey}|${r.id}`, r);
  const fromSave = (s: SaveState | undefined): void => {
    if (!s?.run?.config) return;
    const k = runLedgerKey(s.run.config);
    for (const st of runRecords(s.run, s.run.config)) add(`${k}|${st.id}`, st);
  };
  for (const r of db.rows.values()) fromSave(JSON.parse(r.json) as SaveState);
  for (const room of allRooms(w)) {
    if (room.runConfig) {
      const k = runLedgerKey(room.runConfig);
      for (const st of room.ledger.values()) add(`${k}|${st.id}`, st);
      if (room.nodeState) add(`${k}|${room.nodeState.id}`, room.nodeState);
    }
    for (const p of Object.values(room.session.world.players)) fromSave(p.save);
    for (const i of room.disconnected.values()) fromSave(i.save);
  }
  return out;
}

/**
 * СЛИВ НОДЫ (`installNodeShutdown`): слив объявлен (удар вне расписания — гейтвей перестаёт слать новых, входы отвечают «перезапускаемся»),
 * сейвы дописаны кругами (`flushAll`), новых ударов нет, идущие дождались, нода снята из реестра (`releaseNode`), выход. Всё — под
 * предохранителем: ⭐ ENV2 дописка — до конца аренды ноды (`drainBudget`: база лежит — круги ждут её), не успели — выход всё равно.
 * (⭐ R16 C-05: аренда на исходе слива больше не начинает.)
 */
async function drainNode(w: W, inc: Inc, bg: boolean, why = ''): Promise<void> {
  inc.draining = true;
  w.clusterTouched = true;
  w.events.push(`drain${bg ? '~' : ''}${why ? `-${why}` : ''}:${inc.node}#${inc.gen}@${w.op}`);
  let done = false;
  const left = inc.lease.leaseLeft();
  const budget = Number.isFinite(left) ? Math.max(0, left - (DRAIN_GUARD_MS - DRAIN_FLUSH_MS)) : DRAIN_FLUSH_MS;
  const guardMs = budget + (DRAIN_GUARD_MS - DRAIN_FLUSH_MS);
  // Предохранитель: не успели — выход всё равно.
  const guard = setTimeout(() => { if (cur === w) killInc(w, inc, 'drain'); }, guardMs);
  void inProc(inc, async () => {
    try {
      const announce = beat(w, inc, true).catch(() => undefined);
      await inc.rm.flushAll(budget);
      await announce;
      inc.stopped = true;
      if (inc.timer) clearInterval(inc.timer);
      await inc.reg.releaseNode(inc.node);
    } catch { /* как `installNodeShutdown`: ошибка — в лог, выход всё равно */ } finally {
      done = true;
      clearTimeout(guard);
      if (cur === w) killInc(w, inc, 'drain');
    }
  });
  if (bg) { await drain(); return; }
  for (let t = 0; t < guardMs && !done; t += 250) {
    await drain(3);
    if (done) break;
    await vi.advanceTimersByTimeAsync(250);
  }
  await drain();
}

// ── Генератор операций ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function genOp(w: W, rng: FuzzRng): Op {
  const hs = w.heroes;
  const live = hs.filter((h) => liveAt(w, h));
  const off = hs.filter((h) => !liveAt(w, h));
  const inArea = (a: string): Hero[] => live.filter((h) => liveAt(w, h)!.room.area === a);
  const dun = inArea('dungeon'), town = inArea('town'), arena = inArea('arena');
  const pairs = live.filter((h) => live.some((x) => x !== h && x.userId === h.userId && liveAt(w, x)!.room === liveAt(w, h)!.room));
  const bodies = hs.filter((h) => allRooms(w).some((r) => r.lingering.has(h.charId)));
  const ix = (h: Hero): number => h.i;
  const pickFrom = (xs: Hero[]): number => ix(xs.length ? rng.pick(xs) : rng.pick(hs));
  const any = (): number => rng.int(hs.length);
  const L = live.length ? 1 : 0;
  const rooms = alive(w).reduce((s, i) => s + i.rm.rooms.size, 0);
  const unsaved = alive(w).reduce((s, i) => s + i.rm.unsaved.size, 0);
  // Кластер — из своего потока (`env`): прежние операции героев идут как шли, события кластера лишь вставлены между ними.
  const dead = w.nodes.filter((i) => i.dead);
  const up = alive(w);
  // Лежат все — супервизор поднимает быстро (иначе прогон тратит операции впустую); последнюю живую роняем реже.
  if (dead.length && w.env.chance(up.length ? w.restartP : 0.6)) return { k: 'restart', n: w.env.pick(dead).n };
  // ⭐ R16-02: пауза машины ноды дольше срока смерти (ВМ на паузе, сон хоста) — из своего потока (`pause`): прежние операции идут как шли.
  if (up.length > 1 && w.pause.chance(0.012)) {
    const op: Op = { k: 'suspend', n: w.pause.pick(up).n, ms: w.pause.pick([130_000, 200_000, 400_000]), wall: w.pause.chance(0.7) };
    // ⭐ R17-01: половина пауз ложится посреди удара сердца — после ответа сверки или продления своих (из своего потока).
    return w.midPause.chance(0.5) ? { ...op, mid: w.midPause.pick(['claims', 'beat'] as const) } : op;
  }
  if (up.length && w.env.chance(up.length > 1 ? w.clusterP : w.clusterP / 3)) {
    const n = w.env.pick(up).n;
    const long = OUTAGE_LONG && w.env.chance(0.3);
    const ms = long ? w.env.pick([130_000, 400_000]) : w.env.pick([3_000, 8_000, 15_000, 45_000, 85_000, 105_000, 110_000]);   // R16 C-05: и конец аренды
    switch (w.env.weighted([2, 1.5, 2.5, 2.5, FUZZ_FAULTS ? 4 : 0, 2])) {
      case 0: return { k: 'crash', n };
      case 1: return w.env.chance(0.5) ? { k: 'drain', n, bg: true } : { k: 'drain', n };
      case 5: return { k: 'crashAt', n, calls: 1 + w.env.int(12) };
      case 2: return { k: 'stall', n, ms, ...(long ? { long: true as const } : {}) };
      case 3: return FUZZ_FAULTS ? { k: 'partition', n, ms, ...(long ? { long: true as const } : {}) } : { k: 'stall', n, ms, ...(long ? { long: true as const } : {}) };
      default: return {
        k: 'regFault',
        op: w.env.pick(['claimForJoin', 'claimForJoin', 'claimOwner', 'releaseChar', 'claimRun', 'claimRun', 'releaseRun', 'touchClaims', 'touchRuns', 'heartbeat', 'route'] as const),
        kind: w.env.chance(0.5) ? 'fail' : 'landed', n: w.env.chance(0.5) ? n : null,
      };
    }
  }
  if (hs.length < HEROES_MAX && w.crew.chance(0.02)) return { k: 'recruit' };
  // ⭐ R15-08: поздний ответ реестра на продление и взятие забега — из своего потока (`lateReg`), пока забеги держат комнаты: отпуск забега
  // комнатой ляжет в базу раньше.
  if (up.some((i) => i.rm.runRooms.size) && w.lateReg.chance(0.06)) {
    return { k: 'regFault', op: w.lateReg.pick(['touchRuns', 'touchRuns', 'claimRun'] as const), kind: 'late', n: w.lateReg.chance(0.7) ? w.lateReg.pick(up).n : null };
  }
  // ⭐ R16 C-09: погибший вне игры (ждёт пати мёртвым — `paid`, или «мёртв, оплачено» в строке — `run.deadAt`, в том числе после падения и
  // слива ноды) — экран входа через гейтвей: статус и «Завершить» с него (`5-status-promise`). Из своего потока (`ask`).
  const deadOut = off.filter((h) => paidOut(w, h));
  if (deadOut.length && w.ask.chance(0.3)) return { k: 'abandon', h: w.ask.pick(deadOut).i, via: 'gw', ask: true };
  const diff = (): number | undefined => (w.aux.chance(0.5) ? w.aux.int(tierIds().length) : undefined);
  const via = (): Via => { const r = w.env.next(); return r < 0.65 ? 'gw' : r < 0.85 ? 'x' : w.env.int(NODES); };
  // Вне игры с забегом в строке — чаще «Продолжить» и чаще не на ноду своего забега: так две ноды встречаются на одном забеге.
  const parked = off.filter((h) => rowSave(h.charId)?.run);
  const table: [number, () => Op][] = [
    [off.length ? 14 : 3, () => ({ k: 'join', h: rng.chance(0.75) ? pickFrom(off) : any(), mode: rng.pick(['fresh', 'resume', 'resume', 'code', 'friend', 'friend'] as const), r: rng.next(), reuse: rng.chance(0.5), via: via() })],
    [parked.length ? 4 : 0, () => ({ k: 'join', h: pickFrom(parked), mode: 'resume', r: rng.next(), reuse: rng.chance(0.3), via: w.env.chance(0.5) ? 'x' : 'gw' })],
    [2, () => ({ k: 'status', h: any(), via: via() })],
    [2.5, () => {
      const op: Op = { k: 'abandon', h: rng.chance(0.7) ? pickFrom(off) : any(), via: via() };
      return w.ask.chance(0.6) ? { ...op, ask: true } : op;   // ⭐ R16 C-09: из своего потока — основной не сдвигается
    }],
    [3 * L, () => ({ k: 'leave', h: pickFrom(live) })],
    [5 * L, () => ({ k: 'close', h: pickFrom(live) })],
    [8 * L, () => ({ k: 'move', h: pickFrom(live), to: rng.pick(['entry', 'exit', 'portal', 'away', 'monster', 'monster', 'drop', 'chest'] as const), r: rng.next() })],
    [dun.length || arena.length ? 6 : 0, () => ({ k: 'hurt', h: pickFrom([...dun, ...arena]), frac: rng.pick([0.03, 0.1, 0.3, 0.6]) })],
    [dun.length || arena.length || bodies.length ? 4 : 0, () => (bodies.length && rng.chance(0.4) ? { k: 'kill', h: pickFrom(bodies), body: true } : { k: 'kill', h: pickFrom([...dun, ...arena]), body: false })],
    [2 * L, () => ({ k: 'potion', h: pickFrom(live), belt: rng.chance(0.5), r: rng.next() })],
    [dun.length ? 5 : 0, () => ({ k: 'attack', h: pickFrom(dun), r: rng.next(), weaken: rng.chance(0.6) })],
    [9 * L, () => {
      const op: Op = { k: 'descend', h: pickFrom(live), r: rng.next(), others: rng.pick(['yes', 'yes', 'yes', 'none', 'no'] as const), near: rng.chance(0.5), pause: rng.chance(0.7) };
      const d = diff();
      return d === undefined ? op : { ...op, diff: d };
    }],
    [dun.length || arena.length ? 5 : 0, () => ({ k: 'town', h: pickFrom([...dun, ...arena]), others: rng.pick(['yes', 'yes', 'none', 'no'] as const), near: rng.chance(0.7), pause: rng.chance(0.7) })],
    [town.length ? 1.5 : 0, () => ({ k: 'arena', h: pickFrom(town), others: rng.pick(['yes', 'yes', 'none'] as const), pause: rng.chance(0.7) })],
    [4 * L, () => ({ k: 'vote', h: pickFrom(live), yes: rng.chance(0.8) })],
    [rooms ? 10 : 1, () => ({ k: 'step', n: rng.pick([1, 3, 10, 30, 90]) })],
    [rooms || unsaved || w.nodes.some((i) => i.dead) ? 6 : 1, () => ({ k: 'wait', ms: rng.pick([1_600, 4_200, 16_000, 61_000, 3_601_000]) })],
    [3 * L, () => ({ k: 'drop', h: pickFrom(live), r: rng.next() })],
    [3 * L, () => ({ k: 'pickup', h: pickFrom(live), r: rng.next() })],
    [pairs.length ? 5 : 0, () => ({ k: 'trade', h: pickFrom(pairs), r: rng.next() })],
    [town.length ? 3 : 0, () => ({ k: 'stash', h: pickFrom(town), r: rng.next(), out: rng.chance(0.4) })],
    [town.length ? 1 : 0, () => ({ k: 'sell', h: pickFrom(town), r: rng.next() })],
    [dun.length ? 3 : 0, () => ({ k: 'chest', h: pickFrom(dun), r: rng.next() })],
    [FUZZ_FAULTS ? 3 : 0, () => ({ k: 'fault', f: rng.pick(['fail', 'deadlock', 'unknownLost', 'unknownLanded', 'stashConflict'] as const), h: rng.chance(0.6) ? any() : null })],
    [1, () => ({ k: 'retry' })],
  ];
  return table[rng.weighted(table.map(([wt]) => wt))]![1]();
}

// ── Прогон ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function seedWorld(seed: number): { heroes: Hero[] } {
  const r = fuzzRng(mixSeed(seed, 0x5eed));
  const nHeroes = 2 + r.int(3);
  const nAcc = 1 + r.int(Math.min(3, nHeroes - 1));
  const heroes: Hero[] = [];
  for (let i = 0; i < nHeroes; i++) {
    const acc = i < 2 ? 0 : r.int(nAcc);
    heroes.push(newHero(r, i, acc));
  }
  return { heroes };
}
const HEROES_MAX = 5;
function newHero(r: FuzzRng, i: number, acc: number): Hero {
  const classes = cfg.get('classes').filter((c) => c.enabled !== false);
  const base = cfg.get('items.base');
  const weapon = base.filter((b) => b.kind === 'weapon' && b.enabled !== false);
  const armor = base.filter((b) => b.kind === 'armor' && b.enabled !== false);
  const charId = `fz-h${i}`;
  const userId = `fz-u${acc}`;
  const save = newCharacterSave(cfg, r.pick(classes).id, `Герой${i}`, charId) as SaveState;
  save.gold = 2_000 + r.int(3_000);
  const gen = (pool: typeof base): Item => generateItem(base, cfg.get('affixes'), cfg.get('uniques'),
    { dropBias: 1, itemLevel: 3, baseId: r.pick(pool).id, tiers: cfg.get('item-tiers'), rarities: cfg.get('rarities'), forceRarity: 'normal', maxReqTotal: cfg.get('balance').maxTotalRequirement },
    createRng(1 + r.int(1_000_000)));
  for (let k = 0; k < 3; k++) save.inventory.push(gen(k === 2 ? armor : weapon));
  const pot = (id: string): Item | null => itemFromBaseId(base, id, undefined, 'shop');
  save.belt = [pot('healing-potion'), pot('minor-healing-potion'), null, null];
  const mana = pot('mana-potion');
  if (mana) save.inventory.push(mana);
  packInventory(save.inventory, cfg.get('balance').inventory);
  db.rows.set(charId, { userId, json: JSON.stringify(save), version: 1 });
  db.sessions.set(tokenOf(acc), userId);
  return {
    i, charId, userId, token: tokenOf(acc), conn: null, cmd: 0, cap: null, level: save.level, xp: save.xp,
    deadOn: new Set(), penaltyEv: 0, revivedEv: 0, revivals: [], reached: new Set(), depthMax: new Map(), progMax: new Map(), wasDead: false,
    deadRun: null, deadRoom: null, deadInst: null, droppedDead: false, lastPen: null, deadSeenEv: 0,
  };
}

/**
 * ЭПИЛОГ: сбои базы и реестра выключены, разделы и паузы кончились; мёртвые ноды поднимаются (или одна остаётся лежать — от сида: тогда
 * всё идёт через выжившую, d), все уходят, грейс, держания и дописки отрабатывают — и каждый герой «статус → Завершить (если забег) → вход
 * «Соло»» через гейтвей и стоит в городе. Когда все ушли — ни комнат, ни закреплений и забегов без сессии (d), в базе у вещи одно место (1, c).
 */
async function quiesce(w: W): Promise<void> {
  const phase = async (op: Op | null, fn: () => Promise<void>): Promise<void> => {
    w.op++; w.opRef = op;
    const pre = preState(w);
    db.writes.length = 0;
    await fn();
    check(w, pre, op);
  };
  db.faults.length = 0;
  w.regFaults.length = 0;
  for (const inc of w.nodes) { inc.stallUntil = 0; inc.partitionUntil = 0; inc.crashAt = 0; }
  const leaveDead = fuzzRng(mixSeed(w.seed, 0xdead)).chance(0.4);   // свой поток: повтор и сжатие видят тот же эпилог
  await phase(null, async () => {
    // ⭐ R16-02: пауза машины кончается — вернувшийся процесс уходит сам (реестр его уже отдал) или, если пауза была короче, играет дальше.
    for (const inc of w.nodes) if (inc.frozenAt && !inc.dead) await thaw(w, inc);
    // Слив, идущий фоном, — до конца (он уводит ноду): решать, кого поднимать, можно только по его итогу.
    for (let t = 0; t <= DRAIN_MAX_MS && w.nodes.some((i) => i.draining && !i.dead); t += 250) await vi.advanceTimersByTimeAsync(250);
    const dead = w.nodes.filter((i) => i.dead);
    // Оставить ноду лежать можно, только если выжившая не уйдёт сама: аренда, не продлённая за раздел (за окном дизайна), на ближайшем ударе
    // сливает ноду (`beat`: осталось не больше предохранителя слива) — и эпилогу не осталось бы ни одной.
    const lasts = (i: Inc): boolean => i.lease.leaseLeft() > DRAIN_GUARD_MS + 2 * BEAT_MS;
    for (const inc of dead) {
      if (leaveDead && alive(w).some(lasts)) continue;
      await boot(w, inc.n);
    }
    await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
    await drain(3);
    // Выжившая всё же слила себя (аренда) — лежащие поднимает супервизор, как после любого выхода процесса.
    for (let t = 0; t <= DRAIN_MAX_MS && w.nodes.some((i) => i.draining && !i.dead); t += 250) await vi.advanceTimersByTimeAsync(250);
    if (!alive(w).length) {
      for (const inc of w.nodes.filter((i) => i.dead)) await boot(w, inc.n);
      await vi.advanceTimersByTimeAsync(BEAT_MS * 2);
      await drain(3);
    }
  });
  // Подняться не смогла ни одна — эпилогу идти некуда (это не нарушение игры: база молчит всем).
  if (!alive(w).length) { violate(w, 'd-no-node', 'в эпилоге ни одна нода не поднялась'); return; }
  const gw = async (h: Hero, frame: Record<string, unknown>): Promise<FakeConn | undefined> => {
    const inc = routeOf(w, h, undefined, 'gw');
    if (!inc) return undefined;
    const ws = lobby(w, h, frame, inc);
    await drain(3);
    return ws;
  };
  // d: СМЕРТЬ НОДЫ ЗАПИРАЕТ НЕ ДОЛЬШЕ ОКНА ДЕРЖАНИЯ. Через `NODE_DEAD_SEC` + `CLAIM_IDLE_SEC` после её последнего удара каждый, кого не держит
  // живая нода (сессия, грейс, копия на дописать), входит через гейтвей без «герой на другом узле»: закрепления мёртвой больше не держат.
  if (w.nodes.some((i) => i.dead)) {
    await phase(null, async () => { await vi.advanceTimersByTimeAsync((NODE_DEAD_SEC + CLAIM_IDLE_SEC) * 1000 + 3 * BEAT_MS); await drain(3); });
    for (const h of w.heroes) {
      if (liveAt(w, h) || alive(w).some((i) => i.rm.graceByChar.has(h.charId) || i.rm.unsaved.has(h.charId) || i.rm.inflight.has(h.charId))) continue;
      await phase({ k: 'join', h: h.i, mode: 'resume', r: 0, reuse: false, via: 'gw' }, async () => {
        const ws = await gw(h, { t: 'join', resume: true });
        if (ws?.frames.some((f) => f.t === 'error' && f.code === 'wrong-node')) {
          violate(w, 'd-locked-after-death', `${h.charId}: через ${NODE_DEAD_SEC + CLAIM_IDLE_SEC} с после смерти ноды вход через гейтвей — «герой на другом узле»; ${w.cluster.dump()}`, h);
        }
      });
    }
  }
  // 5 (C-05), d: забег в сейве — с путём в игру без штрафа, пока комнаты живы.
  for (const h of w.heroes) {
    if (liveAt(w, h) || !rowSave(h.charId)?.run) continue;
    let full = false;
    await phase({ k: 'join', h: h.i, mode: 'resume', r: 0, reuse: false, via: 'gw' }, async () => {
      const ws = await gw(h, { t: 'join', resume: true });
      full = !!ws?.frames.some((f) => f.t === 'error' && f.code === 'full');
    });
    if (!full) continue;
    await phase({ k: 'join', h: h.i, mode: 'fresh', r: 0, reuse: false, via: 'gw' }, async () => {
      const ws = await gw(h, { t: 'join', fresh: true });
      const j = ws?.frames.find((f) => f.t === 'joined') as Extract<ServerFrame, { t: 'joined' }> | undefined;
      if (!j) violate(w, '5-resume-dead-end', `${h.charId}: «Продолжить» — «нет мест», а «Соло» из лобби не входит: ${JSON.stringify(ws?.frames.filter((f) => f.t === 'error').at(-1) ?? null)}`, h);
      else if (!j.save.run) violate(w, '5-resume-dead-end', `${h.charId}: «Продолжить» — «нет мест», а «Соло» из лобби снял забег`, h);
    });
  }
  await phase(null, async () => {
    for (const h of w.heroes) { const at = liveAt(w, h); if (at) at.ws.close(); }
    for (const c of w.lobbies) c.close();
    await drain(3);
  });
  await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
  for (let k = 0; k < 2; k++) await phase(null, async () => { await vi.advanceTimersByTimeAsync(3_700_000); await drain(3); await stepAll(w, 2); });
  for (let k = 0; k < 4; k++) {
    await phase(null, async () => {
      await vi.advanceTimersByTimeAsync(65_000);
      kickRetry(w);
      await drain(3);
    });
  }
  for (const inc of alive(w)) {
    if (inc.rm.unsaved.size || inc.rm.inflight.size) violate(w, '5-copy-never-lands', `${inc.node}: база здорова, а копии не легли: ${[...inc.rm.unsaved.keys(), ...inc.rm.inflight.keys()].join(', ')}`);
  }
  for (const room of allRooms(w)) if (room.disconnected.size) violate(w, '5-grace-forever', `комната ${room.code} ждёт реконнекта после грейса: ${[...room.disconnected.keys()].join(', ')}`);
  for (const h of w.heroes) {
    let hasRun: boolean | undefined;
    let why = '';
    for (let a = 0; a < 3 && hasRun === undefined; a++) {
      await phase({ k: 'status', h: h.i, via: 'gw' }, async () => {
        const ws = await gw(h, { t: 'runStatus' });
        hasRun = (ws?.frames.filter((f) => f.t === 'runStatus').at(-1) as { hasRun?: boolean } | undefined)?.hasRun;
        why = ws ? JSON.stringify(ws.frames.at(-1) ?? null) : 'маршрута нет';
      });
      if (hasRun === undefined) await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
    }
    if (hasRun === undefined) violate(w, '5-stuck-status', `${h.charId}: статус забега без ответа: ${why}; ${w.cluster.dump()}`);
    if (hasRun) {
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        await phase({ k: 'abandon', h: h.i, via: 'gw' }, async () => {
          const ws = await gw(h, { t: 'abandon' });
          ok = !!ws?.frames.some((f) => f.t === 'abandoned');
          why = ws ? JSON.stringify(ws.frames.filter((f) => f.t === 'error').at(-1) ?? null) : 'маршрута нет';
        });
        if (!ok) await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
      }
      if (!ok) violate(w, '5-stuck-abandon', `${h.charId}: «Завершить» не проходит: ${why}; ${w.cluster.dump()}`);
    }
    let joined: FakeConn | undefined;
    for (let a = 0; a < 3 && !joined; a++) {
      await phase({ k: 'join', h: h.i, mode: 'fresh', r: 0, reuse: false, via: 'gw' }, async () => {
        const ws = await gw(h, { t: 'join', fresh: true });
        const j = ws?.frames.find((f) => f.t === 'joined') as { floor?: { area?: string } } | undefined;
        if (j) {
          joined = ws;
          if (j.floor?.area !== 'town') violate(w, '5-join-not-town', `${h.charId}: вход «Соло» не в город, а в ${j.floor?.area}`);
        } else why = ws ? JSON.stringify(ws.frames.filter((f) => f.t === 'error').at(-1) ?? null) : 'маршрута нет';
      });
      if (!joined) await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
    }
    if (!joined) violate(w, '5-stuck-join', `${h.charId}: вход «Соло» не проходит: ${why}; ${w.cluster.dump()}`);
    await phase({ k: 'close', h: h.i }, async () => { joined?.close(); await drain(3); });
  }
  await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
  // 5: все ушли — комнат не осталось.
  for (const inc of alive(w)) {
    if (inc.rm.rooms.size) violate(w, '5-room-leak', `${inc.node}: все ушли, а комнаты живы: ${[...inc.rm.rooms.values()].map((r) => `${r.code}/${r.area} клиентов ${r.clients.size}, ждут ${r.disconnected.size}`).join('; ')}`);
  }
  // d: когда все ушли и время держания прошло — ни закрепления, ни забега, которые держатся без сессии и комнаты.
  await phase(null, async () => { await vi.advanceTimersByTimeAsync((NODE_DEAD_SEC + CLAIM_IDLE_SEC + 10) * 1000); await drain(3); });
  if (FUZZ_TRACE) console.info(`[fuzz ${w.seed}] эпилог: ${traceLine(w)}`);
  for (const [charId, c] of w.cluster.claims) {
    if (!w.cluster.held(c.liveAt, c.node)) continue;
    const inc = w.nodes[nodeIdx(c.node)];
    // Держит — по правде менеджера (сессия, грейс, прощальная запись в полёте или не легла), а не по его списку для сердцебиения.
    const holds = !!inc && !inc.dead && (inc.rm.live.has(charId) || inc.rm.graceByChar.has(charId) || inc.rm.inflight.has(charId) || inc.rm.unsaved.has(charId));
    if (!holds) violate(w, 'd-claim-stuck', `${charId}: закрепление за ${c.node} держится (продлено ${Math.round((Date.now() - (c.liveAt ?? 0)) / 1000)} с назад), а нода героя не держит; ${w.cluster.dump()}`);
  }
  for (const [key, l] of w.cluster.runLocks) {
    if (!w.cluster.held(l.liveAt, l.node)) continue;
    const inc = w.nodes[nodeIdx(l.node)];
    const holds = refreshes(inc, key);
    if (!holds) violate(w, 'd-run-lock-stuck', `забег ${key}: держание за ${l.node}/${l.room} продлевается, а комнаты с ним нет; ${w.cluster.dump()}`);
  }
  // 1, c: в базе у каждой вещи одно место, и ничего не пропало иначе, чем стоком.
  const final = new Map<string, string[]>();
  const at = (uid: string, loc: string): void => { let a = final.get(uid); if (!a) final.set(uid, (a = [])); a.push(loc); };
  for (const [charId, r] of db.rows) for (const it of itemsOf(JSON.parse(r.json) as SaveState)) at(it.uid, `hero:${charId}`);
  for (const [userId, st] of db.stash) for (const it of (JSON.parse(st.json) as AccountStash).tabs.flat()) at(it.uid, `stash:${userId}`);
  for (const [uid, ls] of final) if (ls.length > 1) violate(w, '1-dup-item-db', `в базе вещь ${uid} сразу в: ${ls.join(', ')}`);
  for (const [uid, loc] of w.lastLoc) if (!final.has(uid) && !w.sinks.has(uid)) violate(w, '1-item-lost', `вещь ${uid} (последний раз: ${loc}) пропала без стока`);
}

function traceLine(w: W): string {
  const locs = locate(w);
  const hs = w.heroes.map((h) => {
    const ls = locs.get(h.charId) ?? [];
    const l = ls.find((x) => x.kind === 'live') ?? ls.find((x) => x.kind === 'body') ?? ls.find((x) => x.kind === 'disc');
    const flags = `${lifePaid(w, h) ? ' [штраф]' : ''}`;
    if (!l) return `h${h.i}:off${flags}`;
    const p = l.p;
    const where = `${l.room.code}/${l.inc?.node.slice(-1)}/${l.room.area}${l.room.runNodeId ? `@${l.room.runNodeId}` : ''}`;
    return `h${h.i}:${l.kind}${ls.length > 1 ? `+${ls.length - 1}` : ''} ${where}${p ? ` ${p.alive ? 'жив' : 'мёртв'} ${Math.round(p.hp)}/${Math.round(p.maxHp)}` : ''}${l.info?.safe ? ' safe' : ''}${l.info?.paid ? ' paid' : ''}${flags}`;
  });
  const vers = w.heroes.map((h) => { const r = db.rows.get(h.charId); return `h${h.i}:v${r?.version}`; }).join(' ');
  const nodes = w.nodes.map((i) => `${i.node}#${i.gen}${i.dead ? '†' : ''}${i.draining ? '(слив)' : ''} комнат ${i.dead ? '-' : i.rm.rooms.size} unsaved [${i.dead ? '' : [...i.rm.unsaved.keys()].join(',')}]`).join('; ');
  const recs = (xs: { id: string; chests: readonly number[]; killed: readonly number[] }[]): string => xs.map((r) => `${r.id}:c[${r.chests.join(',')}]k[${r.killed.join(',')}]`).join(' ');
  const ledger = [...db.ledger].map(([k, m]) => `${k.slice(-6)}{${recs([...m.values()])}}`).join(' ');
  const rowRecs = w.heroes.map((h) => { const s = rowSave(h.charId); return s?.run?.config ? `h${h.i}{${recs(runRecords(s.run, s.run.config))}}` : ''; }).filter(Boolean).join(' ');
  return `${hs.join(' | ')} || ${nodes} || ${w.cluster.dump()} || база ${vers} || свод ${ledger || '—'} || записи строк ${rowRecs || '—'}`;
}

interface RunResult { violations: Violation[]; ops: Op[] }
/** `stopAt` — остановиться на первом нарушении, которое он признаёт (сжатие); `null` — прогнать всё. */
async function run(seed: number, script: Op[] | null, nOps: number, stopAt: ((v: Violation) => boolean) | null): Promise<RunResult> {
  db.rows.clear(); db.stash.clear(); db.ledger.clear(); db.sessions.clear(); db.faults.length = 0; db.consumed = 0; db.writes.length = 0;
  db.unknownStreak.clear(); db.doubleUnknown.clear();
  db.run++;
  env.reseed(mixSeed(seed, 0xe11));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: T0 });
  // Таймер несёт процесс, который его завёл (`als`); процесса нет — таймер не срабатывает.
  const fakeTimeout = globalThis.setTimeout, fakeInterval = globalThis.setInterval;
  // ⭐ R16-02: процесс на паузе машины (`suspend`) — его таймер не срабатывает: часы процесса стоят. Разовый сработает после паузы через свой
  // остаток на её начало (`thaw`), интервал — в свой срок после неё.
  const carry = (fake: typeof setTimeout, once: boolean) => ((cb: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
    const st = als.getStore();
    if (!st) return fake(cb, ms, ...a);
    const run = (): void => { if (!st.dead) als.run(st, () => cb(...a)); };
    return fake(() => {
      if (st.dead) return;
      if (st.frozenAt) { if (once && !st.held.has(cb)) st.held.set(cb, { at: Math.max(0, Date.now() - st.frozenAt), run }); return; }
      run();
    }, ms);
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = carry(fakeTimeout, true);
  globalThis.setInterval = carry(fakeInterval as unknown as typeof setTimeout, false) as unknown as typeof setInterval;
  const w: W = {
    seed, heroes: [], rng: fuzzRng(mixSeed(seed, 0x0b5)), aux: fuzzRng(mixSeed(seed, 0xa11)), crew: fuzzRng(mixSeed(seed, 0xc4e)), env: fuzzRng(mixSeed(seed, 0xc1a5)),
    ask: fuzzRng(mixSeed(seed, 0xc09)), asked: null, lateReg: fuzzRng(mixSeed(seed, 0x1508)), pause: fuzzRng(mixSeed(seed, 0x1602)), midPause: fuzzRng(mixSeed(seed, 0x1701)), lateInFlight: 0, runReleasedAt: new Map(), regSeq: 0, releasedSeq: new Map(), releaseFailedAt: new Map(), claimSaw: new Map(),
    penaltyCount: new Map(), ticking: new Set(), born: new WeakSet(), lobbies: [], pending: [], violations: [], seen: new Set(),
    penalties: [], sinks: new Set(), carryGone: new Set(), lastLoc: new Map(), sunkBy: new Map(), sold: new Set(), durableSeen: new Set(), fromGround: new Set(), ev: 0, opEv0: 0, recs: new Map(), roomSeen: new WeakMap(), ids: new WeakMap(), idSeq: 0,
    errors: [], cmdFailed0: counters.cmdFailed, frameErrors0: counters.frameErrors, op: -1, opRef: null, stepped: false,
    cluster: new ClusterModel(() => Date.now()), nodes: [], incs: [], incSeq: 0, roomInc: new WeakMap(), regFaults: [], rolledBack: new Set(),
    events: [], envelope: false, clusterTouched: false, expectCmd: 0, expectFrame: 0, clusterP: 0, restartP: 0, drainLost: false, ledgerBehind: false, thawSilent: false,
  };
  // Нрав кластера — из потока кластера до первой операции: у одних прогонов ноды падают редко и встают сразу, у других лежат долго.
  w.clusterP = w.env.pick([0.03, 0.07, 0.12]);
  w.restartP = w.env.pick([0.02, 0.08, 0.25]);
  cur = w;
  FakeConn.onFrame = (c, f) => noteFrame(w, c, f);
  FakeConn.onServerClose = null;
  const ops: Op[] = [];
  // Гейтвей подметает реестр раз в 30 с (`sweepNodes`).
  const sweep = setInterval(() => { w.cluster.sweepNodes(); }, 30_000);
  try {
    w.heroes = seedWorld(seed).heroes;
    for (let n = 0; n < NODES; n++) await boot(w, n);
    const total = script ? script.length : nOps;
    for (let i = 0; i < total; i++) {
      const op = script ? script[i]! : genOp(w, w.rng);
      ops.push(op);
      w.op = i; w.opRef = op;
      if (FUZZ_TRACE) console.info(`[fuzz ${seed}] #${i} ${fmt(op)}`);
      const pre = preState(w);
      db.writes.length = 0;
      await watchdog(w, exec(w, op), `операция ${fmt(op)}`);
      check(w, pre, op);
      if (FUZZ_TRACE) console.info(`[fuzz ${seed}]     ${traceLine(w)}`);
      if (FUZZ_TRACE && process.env.DM_FUZZ_TRACE_LOG === '1') { for (const e of w.errors) process.stdout.write(`[fuzz ${seed}]       лог: ${e.slice(0, 220)}\n`); w.errors.length = 0; }
      if (stopAt && w.violations.some(stopAt)) return { violations: w.violations, ops };
    }
    w.op = total;
    await watchdog(w, quiesce(w), 'эпилог', 120_000);
    return { violations: w.violations, ops };
  } catch (e) {
    if (e instanceof Hang) return { violations: w.violations, ops };
    throw e;
  } finally {
    for (let i = 0; i < db.consumed; i++) tally('fault-consumed');
    cur = null;
    FakeConn.onFrame = null;
    FakeConn.onServerClose = null;
    clearInterval(sweep);
    // Прогон кончен: все его процессы — мёртвые (их цепочки к базе больше не отвечают — в следующий прогон ничего не протечёт).
    for (const inc of w.incs) { inc.dead = true; if (inc.timer) clearInterval(inc.timer); }
    for (const c of w.lobbies) c.kill();
    w.ticking.clear();
    vi.clearAllTimers();
    await drain(10);
    vi.clearAllTimers();
    globalThis.setTimeout = fakeTimeout; globalThis.setInterval = fakeInterval;
    vi.useRealTimers();
    vi.clearAllMocks();
  }
}

async function shrink(seed: number, ops: Op[], v: Violation): Promise<Op[]> {
  const cut = ops.slice(0, Math.min(ops.length, v.op + 1));
  // Та же метка и тот же корень: сжатие не подменяет нарушение в окне дизайна нарушением за его пределами (и наоборот).
  const it = (x: Violation): boolean => x.inv === v.inv && x.cause === v.cause;
  const same = async (cand: Op[]): Promise<boolean> => (await run(seed, cand, 0, it)).violations.some(it);
  if (!(await same(cut))) return ops;
  return (await shrinkOps(cut, same, 250)).ops;
}

function report(seed: number, v: Violation, ops: Op[]): string {
  return [
    `✗ [${v.inv}]${v.cause ? ` (${v.cause})` : ''} сид ${seed}, операция ${v.op}: ${v.msg}`,
    `  минимальная последовательность (${ops.length} оп.; повтор: DM_FUZZ_REPLAY='${JSON.stringify({ seed, ops })}'):`,
    ...ops.map((o, i) => `    ${String(i).padStart(3)} ${fmt(o)}`),
  ].join('\n');
}

beforeAll(async () => {
  counters = (await import('./metrics.js')).counters;
  const { limits } = await import('./rateLimit.js');
  for (const l of Object.values(limits) as { take(k: string): boolean; peek?(k: string): boolean }[]) {
    l.take = () => true;
    if (typeof l.peek === 'function') l.peek = () => true;
  }
  cfg = new ConfigRegistry();
  cfg.loadAll();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.spyOn(Math, 'random').mockImplementation(() => env.next());
  spy.onPenalty = (save, removed, gold, stack) => {
    if (!cur || deadCode() || (save as unknown as Record<string, unknown>)[RUN_TAG] !== db.run) return;
    const inc = (save as unknown as Record<string, Inc | undefined>)[INC_TAG];
    if (inc?.dead) return;   // процесса, державшего этот сейв, нет — штраф ушёл с ним
    const src = ['abandonStored', 'endLinger', 'onPlayerDeath', 'settleStored', 'abandonAsDead', 'buryFled', 'finalizeDisconnectedAsDead', 'buryDisconnected']
      .find((n) => stack.includes(n)) ?? '?';
    const map: Record<string, string> = {
      abandonStored: 'abandonStored', endLinger: 'linger', onPlayerDeath: 'death', settleStored: 'stored', abandonAsDead: 'abandonAsDead',
      buryFled: 'buryFled', finalizeDisconnectedAsDead: 'bury', buryDisconnected: 'bury', '?': '?',
    };
    const run = save.run?.config ? runLedgerKey(save.run.config) : null;
    const room = src === 'onPlayerDeath' || src === 'endLinger' ? allRooms(cur).find((r) => Object.values(r.session.world.players).some((p) => p.save === save)) : undefined;
    const where = room?.runConfig ? runLedgerKey(room.runConfig) : null;
    cur.penalties.push({ charId: save.charId, removed, gold, src: map[src]!, op: cur.op, save, ev: ++cur.ev, run, where, seq: db.wseq });
    cur.penaltyCount.set(save.charId, (cur.penaltyCount.get(save.charId) ?? 0) + 1);
    tally(`pen:${map[src]}`);
    if (FUZZ_TRACE) process.stdout.write(`[fuzz ${cur.seed}]     штраф ${save.charId} (${map[src]}): золото −${gold}, вещи ${removed.join(',') || '—'}\n`);
  };
  const keep = (lvl: 'error' | 'warn' | 'log' | 'info') => vi.spyOn(console, lvl).mockImplementation((...a: unknown[]) => {
    const s = a.map((x) => (x instanceof Error ? `${x.message}` : String(x))).join(' ');
    if (lvl === 'info' && s.startsWith('[fuzz')) { process.stdout.write(`${s}\n`); return; }
    // ⭐ R17-01: и процесс, который мир уже списал (пауза машины, `forget`) и который ещё не ожил: удар, вставший на паузе после ответа сверки,
    // продолжается с устаревшим ответом — продление отказано (реестр счёл ноду мёртвой), и он честно пишет ИНЦИДЕНТ «забеги за другой нодой»
    // прямо перед тем, как удар не ляжет и процесс уйдёт без записи. Нарушение здесь — только если он ожил (`a-dead-node-revived`).
    if (!cur || deadCode() || als.getStore()?.writtenOff === true) return;
    cur.errors.push(s.slice(0, 300));
    if (cur.errors.length > 50) cur.errors.shift();
    // 6: команда, упавшая отказом базы или реестра, заказанным фаззером, — штатная «ошибка сервера, попробуйте ещё раз».
    if (/(команда «.*» игрока .* упала|обработка команды игрока .* упала)/.test(s) && a.some(isInjected)) cur.expectCmd++;
    // ⭐ R15-08: сундук на входе, чьё чтение упало разделом с базой, заказанным фаззером, — штатный сбой базы посреди входа (раздел начался, пока
    // вход ждал поздний ответ реестра): комната живёт, сундук клиент перечитает своим действием.
    const entryStashDown = /сундук на входе/.test(s) && a.some(isInjected);
    if (/продолжение забега из города упало|отказ при закрытии соединения|фоновая дописка копии|сундук на входе|изменил сейв .* — откачено/.test(s) && !entryStashDown) violate(cur, '6-internal-error', s.slice(0, 300));
    // b: сердцебиение нашло забег своей комнаты за другой нодой — один забег в двух местах.
    if (/ИНЦИДЕНТ: забеги комнат/.test(s)) violate(cur, 'b-run-lock-lost', s.slice(0, 300));
    else if (/ИНЦИДЕНТ: забег .* кластер числит/.test(s)) violate(cur, 'b-run-lock-lost', s.slice(0, 300));
    else if (/ИНЦИДЕНТ: слив не дописал/.test(s) && cur.nodes.some((i) => i.draining && !i.dead && Date.now() < i.partitionUntil + DRAIN_LAST_TRY_MS)) {
      // Слив во время раздела с базой: бюджет слива кончился раньше раздела — копии уходят с процессом (так и задумано: ИНЦИДЕНТ, R12-04).
      // ⭐ E2E 28.09 (сид 51245): и раздел, кончившийся меньше чем за круг дописки до конца бюджета, — у слива одна попытка, и её исход
      // (сбой, «неизвестен») проверить уже некогда: после аренды писать нельзя.
      violate(cur, '7-copy-forgotten', s.slice(0, 300), undefined, 'ENV-drain-db-outage');
      cur.drainLost = true;
    } else if (/ИНЦИДЕНТ/.test(s)) violate(cur, '7-copy-forgotten', s.slice(0, 300));
    if (/ОТКЛОНЁН устаревший сейв|копия отключённого .* устарела/.test(s) && db.consumed === 0 && !cur.clusterTouched) violate(cur, '7-second-writer', s.slice(0, 300));
  });
  keep('error'); keep('warn'); keep('log'); keep('info');
  process.on('unhandledRejection', onUnhandled);
});
const nodeIdBefore = process.env.DM_NODE_ID;
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
  if (nodeIdBefore === undefined) delete process.env.DM_NODE_ID; else process.env.DM_NODE_ID = nodeIdBefore;
});
function onUnhandled(e: unknown): void { if (cur) violate(cur, '6-unhandled-rejection', e instanceof Error ? `${e.message} ${e.stack?.split('\n').slice(1, 3).join(' ')}` : String(e)); }

/** Корни, которые прогон считает, но на которых не падает: окно простоя за пределом дизайна (см. шапку) и известные, ещё не исправленные. */
const KNOWN: Record<string, string> = {
  // ENV1 исправлен: молчащая нода отгораживает себя сама до срока, после которого реестр отдаёт её героев и забеги (аренда, `lease.ts`), —
  // нарушения после длинного простоя (`ENV-outage-over-dead-sec`) больше не прощаются.
  'ENV-drain-db-outage': 'слив ноды во время раздела с базой дольше аренды ноды (бюджета слива; или кончившегося меньше чем за круг дописки до его конца) — копии уходят с процессом (ИНЦИДЕНТ по дизайну, R12-04)',
  // ⭐ Перепрогон R16 (только `DM_FUZZ_OUTAGE_LONG`): двойной сбой — пауза машины дольше срока смерти И реестр, недоступный ей и после паузы
  // (пауза сердцебиения или раздел с базой дольше самой паузы). Сверка R16-02 (давно ли реестр видел ноду) до реестра не доходит, а часы
  // процесса паузы не видели (стояли все часы — нода не отгорожена; настенные догнал chrony — отгорожена сомнением): до конца аренды нода держит
  // героев и забеги, которые реестр уже отдал другой (a, b), и копии, которые та уже переписала (ИНЦИДЕНТ R6-06). Узнать это ей не у кого;
  // конец аренды — выход без записи. Открытый вопрос владельцу — запись «по строке базы» в этом окне (см. отчёт перепрогона).
  'ENV-thaw-registry-silent': 'нода вернулась с паузы машины дольше срока смерти, а реестр ей ещё недоступен — до конца аренды не знает, что её героев и забеги отдали',
  // K1 (вход, который комната не помнит, читает «мёртв, оплачено» из сейва), K2 (свод забега — в базу раньше строки героя) и K3 (передача
  // через землю записана наполовину) исправлены: их нарушения — снова неизвестные. ⭐ K3 (проход правок 2): окно было шире «одной записи в
  // пути» — подъём клал вещь в сумку раньше записи поднявшего, а та могла не лечь вовсе (пауза C-07, сбой без повтора, исход неизвестен, копия
  // «на дописать», процесс умер на ней, аренда кончилась в простое базы). Теперь выброшенное переходит в сумку только после записи поднимающего
  // с ним (`Room.pickThrown`), а до неё лежит на земле: умер процесс — ушло с землёй его комнаты (сток по дизайну), а не из записанного.
};
function knownCause(c: string | undefined): boolean {
  return c !== undefined && Object.prototype.hasOwnProperty.call(KNOWN, c);
}

async function sweep(seeds: number[], nOps: number, doShrink: boolean): Promise<{ found: Map<string, string>; counts: Map<string, number> }> {
  const found = new Map<string, string>();
  const counts = new Map<string, number>();
  const shrinkKnown = process.env.DM_FUZZ_SHRINK_KNOWN === '1';
  for (const seed of seeds) {
    const r = await run(seed, null, nOps, null);
    for (const v of r.violations) {
      const key = `${v.inv}${v.cause ? ` (${v.cause})` : ''}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (FUZZ_SEEDS) process.stdout.write(`@@V ${seed} ${key} сбоев=${v.faults} оп=${v.op} ${v.msg.slice(0, 300)}\n`);
      logLine(`@@V ${seed} ${key} сбоев=${v.faults} оп=${v.op} ${v.msg.slice(0, 300)}`);
    }
    const first = new Map<string, Violation>();
    for (const v of r.violations) {
      const key = knownCause(v.cause) && !shrinkKnown ? `known:${v.cause}:${v.inv}` : `${v.inv}${v.cause ? ` (${v.cause})` : ''}`;
      if (!first.has(key)) first.set(key, v);
    }
    for (const [key, v] of first) {
      if (found.has(key)) continue;
      const shrinkIt = doShrink && (!knownCause(v.cause) || shrinkKnown);
      const ops = shrinkIt ? await shrink(seed, r.ops, v) : r.ops.slice(0, v.op + 1);
      const again = shrinkIt ? (await run(seed, ops, 0, null)).violations.find((x) => x.inv === v.inv && x.cause === v.cause) ?? v : v;
      const text = shrinkIt ? report(seed, again, ops) : `✗ [${v.inv}] (${v.cause ?? 'не сжато'}) сид ${seed}, операция ${v.op}: ${v.msg}`;
      found.set(key, text);
      if (!v.cause || shrinkKnown || FUZZ_SEEDS) process.stdout.write(`${text}\n`);
      logLine(text);
    }
  }
  return { found, counts };
}

async function replay(seed: number, ops: Op[]): Promise<Violation[]> {
  return (await run(seed, ops, 0, null)).violations;
}

describe('⭐ B1: фаззер коопа на двух нодах (два RoomManager, реестр кластера, честная база)', () => {
  if (process.env.DM_FUZZ_REPLAY) {
    it('повтор последовательности', async () => {
      const { seed, ops } = JSON.parse(process.env.DM_FUZZ_REPLAY!) as { seed: number; ops: Op[] };
      const r = await replay(seed, ops);
      for (const v of r) process.stdout.write(`✗ [${v.inv}]${v.cause ? ` (${v.cause})` : ''} операция ${v.op}: ${v.msg}\n`);
      process.stdout.write(`[fuzz] покрытие: ${JSON.stringify(Object.fromEntries([...stats].sort((a, b) => a[0].localeCompare(b[0]))))}\n`);
      expect(r.map((v) => v.inv)).toEqual([]);
    });
    return;
  }
  it(FUZZ_SEEDS ? `сиды ${FUZZ_SEED0}…${FUZZ_SEED0 + FUZZ_SEEDS - 1}` : 'фиксированные сиды: инварианты держатся (кроме известных корней)', async () => {
    const seeds = FUZZ_SEEDS ? Array.from({ length: FUZZ_SEEDS }, (_, i) => FUZZ_SEED0 + i) : DEFAULT_SEEDS;
    const t0 = performance.now();
    const { found, counts } = await sweep(seeds, FUZZ_OPS || (FUZZ_SEEDS ? 140 : DEFAULT_OPS), FUZZ_SHRINK);
    process.stdout.write(`[fuzz] сидов ${seeds.length} за ${((performance.now() - t0) / 1000).toFixed(1)} с; нарушений: ${JSON.stringify(Object.fromEntries(counts))}\n`);
    if (FUZZ_SEEDS) process.stdout.write(`[fuzz] покрытие: ${JSON.stringify(Object.fromEntries([...stats].sort((a, b) => a[0].localeCompare(b[0]))))}\n`);
    const unknown = [...found.keys()].filter((k) => !k.startsWith('known:') && !Object.keys(KNOWN).some((c) => k.endsWith(`(${c})`)));
    expect(unknown, [...unknown.map((k) => found.get(k))].join('\n\n')).toEqual([]);
  });

  it('детерминизм: тот же сид — та же последовательность и те же нарушения', async () => {
    const a = await run(11, null, 60, null);
    const b = await run(11, null, 60, null);
    expect(JSON.stringify(b.ops)).toBe(JSON.stringify(a.ops));
    expect(b.violations.map((v) => `${v.inv}@${v.op}:${v.msg}`)).toEqual(a.violations.map((v) => `${v.inv}@${v.op}:${v.msg}`));
  });

  /**
   * НАЙДЕННОЕ ЭТИМ ФАЗЗЕРОМ — сжатые последовательности (повтор одной: `DM_FUZZ_REPLAY`). Пока корень жив, повтор даёт нарушение его метки —
   * тест стоит `it.fails` (`knownRoot`). Шаг исправления снимает `.fails` (`fixedRoot`, и корень из `KNOWN`): тогда тест держит правку.
   */
  const knownRoot = (name: string, seed: number, ops: Op[], inv: string): void => {
    it.fails(name, async () => {
      const got = (await replay(seed, ops)).map((v) => `${v.inv}${v.cause ? ` (${v.cause})` : ''}: ${v.msg}`);
      expect(got.filter((v) => v.startsWith(inv)), 'нарушение корня').toEqual([]);
    });
  };
  /**
   * Корень исправлен: повтор его сжатой последовательности не даёт ни его нарушения, ни какого-либо другого. `known` — последовательность
   * за окном дизайна: другие нарушения — только известных корней (`KNOWN`, напр. слив, чья дописка не легла до конца аренды).
   */
  const fixedRoot = (name: string, seed: number, ops: Op[], inv: string, known = false): void => {
    it(name, async () => {
      const vs = await replay(seed, ops);
      const got = vs.map((v) => `${v.inv}${v.cause ? ` (${v.cause})` : ''}: ${v.msg}`);
      expect(got.filter((v) => v.startsWith(inv)), 'нарушение корня').toEqual([]);
      expect(known ? got.filter((_, i) => !knownCause(vs[i]!.cause)) : got, 'и никаких других').toEqual([]);
    });
  };
  void knownRoot;   // известных неисправленных корней сейчас нет — помощник ждёт следующих
  // K1 (слив): A и B в коопе на node-0, B погиб (штраф и «мёртв, оплачено» — `run.deadAt` — легли), node-0 слита (копии дописаны, забег
  // отпущен). «Продолжить» B через гейтвей — на node-1: новая комната собирала забег на том же узле, и B вставал в нём ЖИВЫМ, с полным здоровьем,
  // а пати этаж не меняла (`attach`: нет записи ухода — жив, метка снята). Теперь вход, который комната не помнит, читает метку из сейва
  // (`Room.deadBySave`): B — мёртвым на узле, один — возврат застрявших (вайп, второго штрафа нет).
  fixedRoot('K1a: погибший после слива ноды «Продолжить» на соседней — мёртвым, а не живым на узле своей смерти', 1423, [
    { k: 'join', h: 1, mode: 'fresh', r: 0.05154610681347549, reuse: true, via: 'x' },
    { k: 'join', h: 3, mode: 'friend', r: 0.5484413022641093, reuse: true, via: 'gw' },
    { k: 'descend', h: 1, r: 0.0042995421681553125, others: 'yes', near: true, pause: true, diff: 1 },
    { k: 'kill', h: 3, body: false },
    { k: 'drain', n: 0 },
    { k: 'join', h: 3, mode: 'resume', r: 0.7876885160803795, reuse: true, via: 'gw' },
  ], '2-revived-elsewhere');
  // K1 (падение): то же через падение ноды — B погиб и вышел (грейс, копия с «мёртв, оплачено» легла), node-0 упала, держание забега истекло
  // (`NODE_DEAD_SEC`), «Продолжить» B на node-1 — был живым на узле смерти, теперь мёртвым.
  fixedRoot('K1b: погибший после падения ноды «Продолжить» на соседней — мёртвым, а не живым на узле своей смерти', 2242, [
    { k: 'join', h: 0, mode: 'friend', r: 0.35238315002061427, reuse: false, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.7868922236375511, reuse: true, via: 'gw' },
    { k: 'descend', h: 0, r: 0.9525302082765847, others: 'yes', near: true, pause: true },
    { k: 'kill', h: 1, body: false },
    { k: 'leave', h: 1 },
    { k: 'crash', n: 0 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 1, mode: 'resume', r: 0.6747359652072191, reuse: false, via: 'gw' },
  ], '2-revived-elsewhere');
  // K1 (город): h0 погиб в коопе на node-1 (строка — «мёртв, оплачено»), node-1 упала. h0 входит «Соло» — новая городская комната на node-0:
  // вход в город снимал метку («вошёл живым»), и спуск из города продолжал его забег — живым на узле смерти. Теперь вход погибшего не в
  // подземелье своего забега снимает забег без штрафа, как страховка входа на одной ноде (`RoomManager.endDeadRun`): спуск из города — уже
  // новый забег. (Метку и так снимает только смена этажа его комнаты; сборка узла продолжением ставит мёртвым — `enterNode`, `resumed`.)
  fixedRoot('K1c: погибший после падения ноды «Соло» и спуск из города — не живым на узле своей смерти', 245, [
    { k: 'join', h: 0, mode: 'friend', r: 0.6683314724359661, reuse: true, via: 'x' },
    { k: 'join', h: 2, mode: 'friend', r: 0.7629780743736774, reuse: false, via: 'gw' },
    { k: 'join', h: 0, mode: 'fresh', r: 0.1314132371917367, reuse: true, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.8241225078236312, reuse: true, via: 'gw' },
    { k: 'descend', h: 0, r: 0.4034984647296369, others: 'yes', near: false, pause: true, diff: 3 },
    { k: 'descend', h: 0, r: 0.35950685292482376, others: 'yes', near: true, pause: true },
    { k: 'attack', h: 0, r: 0.47295393073000014, weaken: false },
    { k: 'step', n: 90 },
    { k: 'wait', ms: 1_600 },
    { k: 'wait', ms: 16_000 },
    { k: 'crash', n: 1 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 0, mode: 'fresh', r: 0.7962276758626103, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0.2438742690719664, others: 'none', near: true, pause: true, diff: 2 },
  ], '2-revived-elsewhere');
  // K1 (город, «Завершить»): то же, вход по коду в чужую городскую комнату. Метка, оставленная в городе, делала бы «Завершить» потом
  // бесплатным, хотя герой уже жил (3-missing-penalty) — вход снимает забег сразу, без штрафа (оплачен), завершать нечего.
  fixedRoot('K1d: погибший после падения ноды входит в чужой город — забег снят без штрафа, «Завершить» бесплатным не бывает', 393, [
    { k: 'drain', n: 0 },
    { k: 'join', h: 1, mode: 'friend', r: 0.7592957068700343, reuse: true, via: 'gw' },
    { k: 'descend', h: 1, r: 0.7178915676195174, others: 'yes', near: false, pause: false, diff: 1 },
    { k: 'join', h: 3, mode: 'friend', r: 0.9390915993135422, reuse: true, via: 'gw' },
    { k: 'kill', h: 1, body: false },
    { k: 'wait', ms: 61_000 },
    { k: 'restart', n: 0 },
    { k: 'crash', n: 1 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 1, mode: 'code', r: 0.7441394641064107, reuse: false, via: 'gw' },
  ], '3-missing-penalty');
  // K2: A и B в коопе на node-0, A открыл сундук и выбросил вещь (запись A — сразу, V-B2-04: строка A легла С записью узла «сундук открыт»),
  // свод забега в базу ещё не писался (он — на чекпойнтах: автосейв, узел, город). node-0 упала; «Продолжить» B на node-1 собирал узел по
  // своду базы и своей строке — сундук снова закрыт, хотя строка A (в базе) его помнит открытым. Теперь запись сейва героя забега сперва
  // дописывает свод (`Room.ledgerLag`/`ledgerRound`): строка не обгоняет свод.
  fixedRoot('K2: свод забега не отстаёт от строки героя — после падения ноды узел собирается со взятым', 4161, [
    { k: 'join', h: 1, mode: 'fresh', r: 0.5144464538898319, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'friend', r: 0.9825055077672005, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0.37795360619202256, others: 'yes', near: true, pause: false, diff: 1 },
    { k: 'chest', h: 0, r: 0.6447820959147066 },
    { k: 'trade', h: 0, r: 0.5897050574421883 },
    { k: 'crash', n: 0 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 1, mode: 'resume', r: 0.060745321214199066, reuse: false, via: 'gw' },
  ], '8-node-refarmable');
  // K3: A и B (один аккаунт) в городе на node-0; A передаёт вещь B через землю: выброс A записан сразу (V-B2-04 — вещь отпущена), подъём B —
  // только в памяти до его следующей записи. node-0 падает: в базе вещи нет ни у A (уход записан), ни у B (приход не записан). Не дюп — потеря
  // уже записанной вещи. Проход 1 писал строку поднявшего сразу (`savePicked`) — окно сузилось, но не закрылось (K3a–K3d ниже); проход 2:
  // выброшенное переходит в сумку только после записи поднимающего С НИМ (`Room.pickThrown`) — до неё вещь на земле.
  fixedRoot('K3: передача через землю — подъём записан сразу, падение ноды после неё вещь не теряет', 500110, [
    { k: 'join', h: 1, mode: 'friend', r: 0.10950272483751178, reuse: false, via: 'gw' },
    { k: 'join', h: 0, mode: 'friend', r: 0.5085474038496614, reuse: true, via: 'gw' },
    { k: 'trade', h: 0, r: 0.9360762422438711 },
    { k: 'crash', n: 0 },
  ], 'c-durable-item-lost');
  // ⭐ K3a (проход правок 2): процесс умер ровно на записи подъёма (`crashAt`, без сбоев базы). Вещь уже была в сумке B, строка B её не
  // держала, строка A отпустила — её не было нигде. Теперь до записи она на земле: умер процесс — ушла с землёй его комнаты (сток по дизайну).
  fixedRoot('K3a: процесс умер на записи подъёма — вещь не в сумке без строки, а на земле ушедшей комнаты', 2200098, [
    { k: 'join', h: 1, mode: 'friend', r: 0.7298081561457366, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'resume', r: 0.34918417455628514, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'friend', r: 0.266517169540748, reuse: true, via: 'x' },
    { k: 'crashAt', n: 0, calls: 2 },
    { k: 'trade', h: 1, r: 0.3674791189841926 },
  ], 'c-durable-item-lost');
  // ⭐ K3b: запись подъёма упала (сбой базы), повтора до автосейва не было (и пауза C-07 его не ставила), процесс упал — вещи нет ни в одной
  // строке. Теперь подъём, чья запись не легла, не состоялся: вещь лежит на земле свободной.
  fixedRoot('K3b: запись подъёма упала — вещь осталась на земле, а не в сумке без строки', 2303782, [
    { k: 'join', h: 0, mode: 'fresh', r: 0.7455516832415015, reuse: false, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.13264079089276493, reuse: true, via: 'gw' },
    { k: 'fault', f: 'fail', h: 1 },
    { k: 'trade', h: 0, r: 0.08130454760976136 },
    { k: 'crash', n: 0 },
  ], 'c-durable-item-lost');
  // ⭐ K3c: исход записи подъёма неизвестен (и не легла) — копия с вещью ждала дописки у менеджера, процесс упал. Теперь копия — без вещи, а
  // вещь на земле за поднимавшим (`heldBy`): легла та запись — вещь в его строке, нет — на земле ушедшей комнаты.
  fixedRoot('K3c: исход записи подъёма неизвестен — вещь на земле за поднимавшим, а не в копии «на дописать»', 2100393, [
    { k: 'recruit' },
    { k: 'join', h: 2, mode: 'fresh', r: 0.3893702873028815, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'friend', r: 0.7447080232668668, reuse: true, via: 'gw' },
    { k: 'fault', f: 'unknownLost', h: 0 },
    { k: 'trade', h: 2, r: 0.15299476915970445 },
    { k: 'crash', n: 0 },
  ], 'c-durable-item-lost');
  // ⭐ K3d: СВОЁ выброшенное (выброс лёг), поднятое во время раздела ноды с базой (15 с — в окне дизайна), и падение: подъём не записан, выброс
  // записан — вещи нет. Теперь подъём в раздел не состоялся — вещь на земле.
  const k3d = (ms: number, long: boolean): Op[] => [
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 0, mode: 'friend', r: 0.0544650973752141, reuse: false, via: 'gw' },
    { k: 'town', h: 0, others: 'no', near: true, pause: true },
    { k: 'close', h: 0 },
    { k: 'join', h: 2, mode: 'friend', r: 0.32690556114539504, reuse: true, via: 'gw' },
    { k: 'drop', h: 2, r: 0.6308250513393432 },
    long ? { k: 'partition', n: 1, ms, long: true } : { k: 'partition', n: 1, ms },
    { k: 'pickup', h: 2, r: 0.6861121042165905 },
    long ? { k: 'wait', ms } : { k: 'crash', n: 1 },
  ];
  fixedRoot('K3d: своё выброшенное, поднятое в раздел с базой, и падение ноды — вещь на земле, а не в сумке без строки', 2301760, k3d(15_000, false), 'c-durable-item-lost');
  // То же, раздел 130 с (за окном дизайна): аренда кончилась, нода слила себя сама. Слив без базы копии не дописал — это известный корень
  // (`ENV-drain-db-outage`), а вещь, поднятая в раздел, — не потеря записанного: она на земле.
  fixedRoot('K3d: своё выброшенное, поднятое в долгий раздел, — нода отгородилась сама, вещь не в сумке без строки', 2301760, k3d(130_000, true), 'c-durable-item-lost', true);
  // ENV1: h1 в подземелье на node-1, чьи удары сердца 130 с не доходят до реестра (за окном дизайна: дольше `NODE_DEAD_SEC`). Через 120 с
  // реестр по правилу держания отдаёт его и забег node-0 (R7-09), «Продолжить» через гейтвей — туда: h1 жил на двух нодах, забег — в двух
  // комнатах, сессия на node-1 — зомби, а node-1, снова достучавшись, писала «ИНЦИДЕНТ» и играла дальше. Теперь node-1 на исходе аренды
  // (`lease.ts`) сливает себя сама и уходит раньше, чем реестр отдаёт её героя.
  fixedRoot('ENV1: нода, молчащая дольше срока держания, отгораживает себя сама — герой не живёт на двух нодах', 300163, [
    { k: 'drain', n: 0 },
    { k: 'join', h: 1, mode: 'code', r: 0.40584025415591896, reuse: true, via: 'gw' },
    { k: 'stall', n: 1, ms: 130_000, long: true },
    { k: 'descend', h: 1, r: 0.297374096699059, others: 'no', near: true, pause: true },
    { k: 'wait', ms: 61_000 },
    { k: 'restart', n: 0 },
    { k: 'wait', ms: 61_000 },
    { k: 'join', h: 1, mode: 'resume', r: 0.8452086646575481, reuse: true, via: 'gw' },
  ], 'a-live-two-nodes');
  // ⭐ E2E 28.09 (большой прогон, сид 51245, ужато до 5 операций): раздел node-0 с базой 110 с, слив в его начале, и единственная запись слива
  // после возврата базы (за 0,4 с до конца аренды) — исход неизвестен. Проверить его некогда, после аренды писать нельзя: копия уходит с
  // процессом — ИНЦИДЕНТ по дизайну (`ENV-drain-db-outage`), откат к строке базы законен. Классификатор ждал «ИНЦИДЕНТ посреди раздела» и
  // этот хвост считал нарушением.
  fixedRoot('E2E 28.09: база вернулась за круг дописки до конца аренды, а единственная попытка слива — сбой: ИНЦИДЕНТ по дизайну', 51245, [
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 1, mode: 'friend', r: 0.6875010614749044, reuse: false, via: 'gw' },
    { k: 'partition', n: 0, ms: 110_000 },
    { k: 'fault', f: 'unknownLost', h: null },
    { k: 'drain', n: 0 },
  ], '7-copy-forgotten:', true);
  // ENV2: слив ноды, пока она 8 с не достаёт до базы: дописка сдавалась через 7,5 с («ИНЦИДЕНТ: слив не дописал героя…»), и копии уходили с
  // процессом, хотя база вернулась через полсекунды. Теперь дописка идёт до конца аренды ноды (`node.ts`, `drainBudget`) — и ложится.
  fixedRoot('ENV2: слив во время короткого раздела с базой дописывает копии, когда база вернулась', 1532, [
    { k: 'join', h: 0, mode: 'resume', r: 0.07676748721860349, reuse: true, via: 'x' },
    { k: 'join', h: 0, mode: 'fresh', r: 0.911401049233973, reuse: true, via: 'gw' },
    { k: 'partition', n: 1, ms: 8_000 },
    { k: 'drain', n: 1 },
  ], '7-copy-forgotten');
  // АРТЕФАКТ СТЕНДА (прогон после прохода правок 2): A и B (один аккаунт) в городе, A голосует за спуск один; A бросает вещь, B её поднимает
  // (`pickThrown`), и запись B с вещью — исход неизвестен (не легла): B снят, и его снятие решает голосование — комната уходит в подземелье,
  // пока подъём в пути: вещь ушла с землёй города (сток по дизайну), подъём не состоялся. `groundGone` поднимаемое стоком не числил, а проверка
  // вещь на земле не видела (всё — одна операция) и числила её в сумке A: падение ноды — `c-durable-item-lost`. Теперь такое решает проверка
  // по концу записи (`carryGone`).
  fixedRoot('стенд: подъём в пути, пока пати ушла с этажа, — вещь ушла с землёй, а не «записанное и потерянное»', 3001397, [
    { k: 'recruit' },
    { k: 'join', h: 2, mode: 'friend', r: 0.5451924153603613, reuse: false, via: 'gw' },
    { k: 'join', h: 0, mode: 'friend', r: 0.1670625158585608, reuse: true, via: 'gw' },
    { k: 'fault', f: 'unknownLost', h: 2 },
    { k: 'descend', h: 0, r: 0.9588577398099005, others: 'none', near: true, pause: true, diff: 0 },
    { k: 'trade', h: 0, r: 0.37116951402276754 },
    { k: 'crash', n: 0 },
  ], 'c-durable-item-lost');
  // АРТЕФАКТ СТЕНДА (прогон после прохода правок 3): B погиб в коопе на node-1 (штраф, «мёртв, оплачено»), node-1 слита; «Продолжить» B на
  // node-0 — новая комната: `attach` в городе (кадр входа — жив), следом сборка узла ставит его мёртвым (K1, `enterNode` `resumed`). Кадр этажа
  // приходил раньше, чем менеджер запоминал соединение, и проверка его не видела: вход числился оживлением, а «Завершить» из грейса (запись
  // входа — исход неизвестен, сессия снята, `paid`) — «без штрафа за новую жизнь» (`3-missing-penalty`). Теперь игрок кадра — по сокету.
  fixedRoot('стенд: «Продолжить» погибшего в новую комнату — кадр входа в городе не оживление, «Завершить» из грейса без штрафа', 5300414, [
    { k: 'join', h: 2, mode: 'fresh', r: 0.14542528614401817, reuse: true, via: 0 },
    { k: 'descend', h: 2, r: 0.17833974142558873, others: 'yes', near: true, pause: true, diff: 3 },
    { k: 'crash', n: 0 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 2, mode: 'resume', r: 0.7994460684712976, reuse: false, via: 'x' },
    { k: 'join', h: 3, mode: 'friend', r: 0.313406387809664, reuse: true, via: 'gw' },
    { k: 'kill', h: 3, body: false },
    { k: 'restart', n: 0 },
    { k: 'drain', n: 1, bg: true },
    { k: 'fault', f: 'unknownLost', h: null },
    { k: 'join', h: 3, mode: 'resume', r: 0.9833822902292013, reuse: false, via: 'x' },
    { k: 'abandon', h: 3, via: 'gw' },
  ], '3-missing-penalty');
  // АРТЕФАКТ СТЕНДА (там же, долгий простой): node-0 130 с без базы, node-1 слита. Эпилог по сиду оставлял лежать node-1, раз node-0 жива, —
  // а та на первом же ударе сливала себя (аренда на исходе), и эпилогу не оставалось ни одной ноды (`d-no-node`). Теперь лежать остаётся нода,
  // только если выжившая с арендой, а слившую себя выжившую поднимает супервизор.
  fixedRoot('стенд: эпилог не оставляет кластер без нод, когда выжившая сливает себя по аренде', 5101369, [
    { k: 'partition', n: 0, ms: 130_000, long: true },
    { k: 'drain', n: 1 },
    { k: 'wait', ms: 4_200 },
    { k: 'wait', ms: 1_600 },
    { k: 'wait', ms: 61_000 },
    { k: 'wait', ms: 16_000 },
    { k: 'wait', ms: 4_200 },
    { k: 'wait', ms: 16_000 },
  ], 'd-no-node');

  // R16 (ревью клиента), ИСПРАВЛЕНО. C-09: h0 ранен в подземелье, закрыл вкладку (тело в бою) — и тело добито: смерть оплачена, он ждёт пати
  // мёртвым. Экран входа через гейтвей: статус не говорил, что смерть оплачена, и «Незавершённое прохождение» грозило штрафом, а «Завершить»
  // с него (верно, V1) штрафа не брало. Теперь статус несёт `dead` (самопроверка `DM_FUZZ_SELFTEST=c09` его снимает: повтор падает).
  fixedRoot('R16 C-09: добитое тело ждёт пати мёртвым — экран через гейтвей говорит «без штрафа», и «Завершить» его не берёт', 4, [
    { k: 'join', h: 1, mode: 'code', r: 0.8850732231512666, reuse: false, via: 'gw' },
    { k: 'descend', h: 1, r: 0.40035125333815813, others: 'no', near: true, pause: true, diff: 2 },
    { k: 'descend', h: 1, r: 0.556104893097654, others: 'yes', near: true, pause: false },
    { k: 'step', n: 30 },
    { k: 'join', h: 1, mode: 'resume', r: 0.64798319269903, reuse: true, via: 0 },
    { k: 'join', h: 0, mode: 'fresh', r: 0.5109382960945368, reuse: true, via: 'x' },
    { k: 'descend', h: 1, r: 0.6726705036126077, others: 'no', near: false, pause: true, diff: 3 },
    { k: 'descend', h: 0, r: 0.653866155538708, others: 'no', near: true, pause: false, diff: 0 },
    { k: 'hurt', h: 0, frac: 0.1 },
    { k: 'close', h: 0 },
    { k: 'kill', h: 0, body: true },
    { k: 'abandon', h: 1, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.642303554341197, reuse: true, via: 'x' },
    { k: 'attack', h: 1, r: 0.006681002443656325, weaken: true },
    { k: 'abandon', h: 0, via: 'gw', ask: true },
  ], '5-status-promise');

  // ── Раунд 15 (сервер), ИСПРАВЛЕНО. R15-08: удар сердца взял снимок забегов, продление ответило поздно (`late`), а комната тем временем
  // забег отпустила (вайп — её `DELETE` лёг раньше): продление вставило строку заново, и держание ушедшей комнаты жило до `CLAIM_IDLE_SEC`.
  // Теперь удар отпускает такие забеги снова (`runsGone`; самопроверка `DM_FUZZ_SELFTEST=r1508` это снимает — повтор падает). Сжато фаззером.
  fixedRoot('R15-08: продление забега, легшее после его отпуска комнатой, не оставляет держания без комнаты', 19, [
    { k: 'join', h: 0, mode: 'friend', r: 0.45121140661649406, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0.3024489327799529, others: 'yes', near: false, pause: true },
    { k: 'crashAt', n: 0, calls: 7 },
    { k: 'join', h: 0, mode: 'code', r: 0.8036829486954957, reuse: false, via: 'gw' },
    { k: 'restart', n: 0 },
    { k: 'step', n: 1 },
    { k: 'join', h: 3, mode: 'code', r: 0.6786514187697321, reuse: false, via: 'gw' },
    { k: 'potion', h: 3, belt: true, r: 0.8588571685831994 },
    { k: 'descend', h: 3, r: 0.8802298188675195, others: 'yes', near: true, pause: true, diff: 2 },
    { k: 'hurt', h: 3, frac: 0.03 },
    { k: 'regFault', op: 'touchRuns', kind: 'late', n: 0 },
    { k: 'attack', h: 3, r: 0.08440084452740848, weaken: true },
    { k: 'kill', h: 3, body: false },
  ], 'b-run-lock-orphan');

  // ── Перепрогон после правок раунда 15 (сиды 7 200 001…7 201 080), ИСПРАВЛЕНО: R15-08 закрыл не всё. Самопроверка `DM_FUZZ_SELFTEST=r15settle`
  // возвращает поведение до правки — первые два повтора падают на `b-run-lock-orphan`. Сжато фаззером.
  // (а) Соло-спуск h1 на node-1: взятие забега легло поздно (`late`), а h1 тут же погиб (вайп отпустил забег раньше вставки). Повторный отпуск
  // по ответу взятия (R15-08) упал — node-1 отрезана от базы на 3 с, — и сбой глушился: строка без комнаты жила до `CLAIM_IDLE_SEC`. Теперь
  // неудавшийся отпуск повторяет ближайший удар сердца (`RoomManager.runsDue`).
  fixedRoot('перепрогон R15 (а): повторный отпуск забега, упавший в разделе с базой, повторяет удар сердца', 7200355, [
    { k: 'town', h: 3, others: 'yes', near: true, pause: true },
    { k: 'join', h: 2, mode: 'code', r: 0.8289919735398144, reuse: false, via: 0 },
    { k: 'descend', h: 2, r: 0.161201739218086, others: 'yes', near: false, pause: true, diff: 0 },
    { k: 'join', h: 1, mode: 'fresh', r: 0.24235298624262214, reuse: true, via: 'gw' },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: null },
    { k: 'descend', h: 1, r: 0.12051907880231738, others: 'no', near: false, pause: true },
    { k: 'kill', h: 1, body: false },
    { k: 'partition', n: 1, ms: 3000 },
    { k: 'wait', ms: 61000 },
  ], 'b-run-lock-orphan');
  // (б) Удар сердца node-0 взял снимок (забег — за городской комнатой A), продление ответило поздно, а h0 тем временем «Продолжить» — забег
  // взяла новая комната B той же ноды. Продление легло с A: строка указывала на комнату, которая забег не держит, до следующего удара (и
  // «Продолжить» на соседней ноде слало бы туда). `runsGone` сравнивал только ключ. Теперь — пару «забег, комната», и строка переписывается
  // на держателя (`RoomManager.settleRun`).
  fixedRoot('перепрогон R15 (б): позднее продление с прежней комнатой ноды — строка забега тут же переписана на держателя', 7201016, [
    { k: 'join', h: 0, mode: 'friend', r: 0.9007073836401105, reuse: false, via: 'gw' },
    { k: 'wait', ms: 1600 },
    { k: 'descend', h: 0, r: 0.8901956903282553, others: 'none', near: false, pause: false, diff: 0 },
    { k: 'recruit' },
    { k: 'attack', h: 0, r: 0.14147656550630927, weaken: true },
    { k: 'step', n: 3 },
    { k: 'attack', h: 0, r: 0.2686340636573732, weaken: true },
    { k: 'join', h: 1, mode: 'code', r: 0.40691171074286103, reuse: false, via: 'gw' },
    { k: 'kill', h: 0, body: false },
    { k: 'recruit' },
    { k: 'step', n: 3 },
    { k: 'join', h: 3, mode: 'code', r: 0.8857199891936034, reuse: true, via: 'gw' },
    { k: 'join', h: 4, mode: 'friend', r: 0.7930156707298011, reuse: true, via: 'gw' },
    { k: 'join', h: 2, mode: 'fresh', r: 0.5538507583551109, reuse: false, via: 'gw' },
    { k: 'kill', h: 4, body: false },
    { k: 'wait', ms: 1600 },
    { k: 'kill', h: 3, body: false },
    { k: 'step', n: 90 },
    { k: 'arena', h: 2, others: 'yes', pause: true },
    { k: 'kill', h: 2, body: false },
    { k: 'wait', ms: 1600 },
    { k: 'step', n: 10 },
    { k: 'descend', h: 1, r: 0.2916975053958595, others: 'yes', near: false, pause: false },
    { k: 'descend', h: 0, r: 0.8919000288005918, others: 'none', near: true, pause: true },
    { k: 'wait', ms: 4200 },
    { k: 'step', n: 30 },
    { k: 'descend', h: 0, r: 0.11949410219676793, others: 'yes', near: false, pause: true },
    { k: 'attack', h: 1, r: 0.7742634071037173, weaken: true },
    { k: 'close', h: 1 },
    { k: 'wait', ms: 61000 },
    { k: 'kill', h: 0, body: false },
    { k: 'wait', ms: 4200 },
    { k: 'abandon', h: 3, via: 'gw', ask: true },
    { k: 'descend', h: 0, r: 0.607214591698721, others: 'yes', near: false, pause: true, diff: 1 },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'abandon', h: 4, via: 'gw', ask: true },
    { k: 'step', n: 30 },
    { k: 'regFault', op: 'touchRuns', kind: 'late', n: null },
    { k: 'step', n: 3 },
    { k: 'join', h: 0, mode: 'resume', r: 0.7558056768029928, reuse: true, via: 'gw' },
    { k: 'step', n: 30 },
  ], 'b-run-lock-orphan');
  // (в) МОДЕЛЬ ФАЗЗЕРА — окно по дизайну. Взятие забега комнатой node-1 легло поздно, когда её уже не было (h1 ушёл), а «Продолжить» h1 на
  // node-0 спросило реестр как раз между этой вставкой и повторным отпуском node-1 (R15-08, миллисекунды): отказ с кодом ушедшей комнаты
  // пересказал ответ реестра, а через миг строки уже нет — «Продолжить» снова находит забег. Судить такой отказ тупиком нельзя; тупик насовсем
  // стережёт эпилог (каждый с забегом в строке жмёт «Продолжить» ещё раз).
  fixedRoot('перепрогон R15 (в): отказ «Продолжить», пересказавший ответ реестра о сироте позднего взятия, — не тупик', 7200656, [
    { k: 'join', h: 1, mode: 'friend', r: 0.5484650731086731, reuse: true, via: 0 },
    { k: 'descend', h: 1, r: 0.23631936474703252, others: 'yes', near: false, pause: false, diff: 0 },
    { k: 'drain', n: 0 },
    { k: 'join', h: 1, mode: 'friend', r: 0.564534290926531, reuse: true, via: 'gw' },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'restart', n: 0 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: null },
    { k: 'descend', h: 1, r: 0.9306421934161335, others: 'yes', near: false, pause: true, diff: 2 },
    { k: 'close', h: 1 },
    { k: 'join', h: 1, mode: 'resume', r: 0.7130583333782852, reuse: false, via: 'x' },
    { k: 'step', n: 90 },
  ], '5-resume-dead-end');
  // (г) МОДЕЛЬ ФАЗЗЕРА. «Продолжить» h2 на node-1 ждало позднего ответа реестра на взятие забега (`late`) — операция кончилась, вход ещё в
  // пути, и следующая (час ожидания) застала героя «вне игры». Вход дошёл, h2 встал на узел живым, его автосейв лёг с неизвестным исходом
  // (сессия снята, копия ждёт реконнекта) — и через час грейса похороны со штрафом: по правилам, а не «похоронен тот, кого нода не держала».
  // Вход героя, стоявший в очереди на начало операции, — держание (как у страховки входа).
  fixedRoot('перепрогон R15 (г): похороны героя, чей вход ещё шёл на начало операции, — не «чужие»', 7210519, [
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'join', h: 2, mode: 'code', r: 0.3690562506671995, reuse: false, via: 'gw' },
    { k: 'descend', h: 2, r: 0.0758780324831605, others: 'yes', near: true, pause: false },
    { k: 'drain', n: 0, bg: true },
    { k: 'fault', f: 'unknownLanded', h: null },
    { k: 'join', h: 2, mode: 'resume', r: 0.24626997439190745, reuse: false, via: 'x' },
    { k: 'wait', ms: 3_601_000 },
  ], '3-unjustified-penalty');
  // (д) Удар сердца node-0 взял снимок (забег припаркован в городской комнате h1), продление ответило поздно, а h1 тем временем закрыл вкладку
  // (комната забег отпустила) и «Продолжить» через гейтвей — забег законно взяла node-1. Позднее продление вернулось без него, и удар писал
  // «ИНЦИДЕНТ: …один забег идёт в двух местах» и снимал комнаты (которых у забега уже не было): ложная тревога. Теперь «чужие» — только те,
  // что нода держит и после ответа (`node.ts`). Самопроверка `r15settle` возвращает суд по снимку — повтор падает. Сжато фаззером.
  fixedRoot('перепрогон R15 (д): забег, отпущенный за время продления и взятый другой нодой, — не «инцидент» удара', 7230032, [
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 0, mode: 'friend', r: 0.3344396997708827, reuse: true, via: 'gw' },
    { k: 'wait', ms: 4200 },
    { k: 'descend', h: 0, r: 0.5411802639719099, others: 'no', near: true, pause: false },
    { k: 'step', n: 90 },
    { k: 'recruit' },
    { k: 'step', n: 3 },
    { k: 'step', n: 30 },
    { k: 'join', h: 1, mode: 'code', r: 0.3170796283520758, reuse: false, via: 0 },
    { k: 'wait', ms: 4200 },
    { k: 'join', h: 2, mode: 'friend', r: 0.7183859846554697, reuse: false, via: 'gw' },
    { k: 'step', n: 10 },
    { k: 'hurt', h: 2, frac: 0.1 },
    { k: 'wait', ms: 61_000 },
    { k: 'kill', h: 2, body: false },
    { k: 'abandon', h: 2, via: 'gw', ask: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'abandon', h: 0, via: 'gw', ask: true },
    { k: 'regFault', op: 'touchRuns', kind: 'late', n: 0 },
    { k: 'step', n: 30 },
    { k: 'close', h: 1 },
    { k: 'join', h: 1, mode: 'resume', r: 0.9027325231581926, reuse: false, via: 'gw' },
  ], 'b-run-lock-lost');
  // (е) Продолжение из города (комната A, node-0) ждало взятие забега (R9-01, `runClaim`) — оно легло поздно, поверх строки новой комнаты B той
  // же ноды (h2 тем временем «Продолжить» — забег взяла B), а A бросила продолжение (все ушли): `runDropped` при живом держателе молчал, и
  // до удара сердца строка называла ушедшую A — «Продолжить» h1 на node-1 получал отказ с её кодом. Теперь отпуск при держателе — строку на
  // него (`RoomManager.runFreed` → `settleRun`). Самопроверка `r15settle` — повтор падает. Сжато фаззером (сид 7240242).
  fixedRoot('перепрогон R15 (е): позднее взятие брошенного продолжения — строка тут же на держателя, отказ «Продолжить» не ведёт в ушедшую', 7240242, [
    { k: 'join', h: 1, mode: 'friend', r: 0.8358823657035828, reuse: true, via: 'x' },
    { k: 'descend', h: 1, r: 0.9744348109234124, others: 'no', near: false, pause: false, diff: 3 },
    { k: 'fault', f: 'unknownLost', h: 2 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'join', h: 2, mode: 'code', r: 0.5110722477547824, reuse: true, via: 'gw' },
    { k: 'town', h: 1, others: 'yes', near: true, pause: true },
    { k: 'leave', h: 1 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: null },
    { k: 'join', h: 2, mode: 'friend', r: 0.14631444099359214, reuse: true, via: 'gw' },
    { k: 'descend', h: 2, r: 0.9270958297420293, others: 'yes', near: true, pause: true, diff: 0 },
    { k: 'join', h: 1, mode: 'resume', r: 0.20347817800939083, reuse: false, via: 'x' },
    { k: 'join', h: 2, mode: 'resume', r: 0.4302257669623941, reuse: false, via: 'gw' },
  ], '5-resume-dead-end');
  // (ж) «Продолжить» h0 на node-1 взял забег за новым кодом комнаты — взятие легло поздно, а за это время тот же забег взял «Продолжить» h3
  // на той же ноде (комната B): h0 вошёл к ней, а строка осталась за кодом комнаты, которой не было, — до удара сердца «Продолжить» h2 на
  // node-0 получал отказ с этим кодом. Теперь взятое за кодом, который не понадобился (держатель нашёлся здесь), — на держателя
  // (`RoomManager.join` → `runFreedKey` → `settleRun`). Самопроверка `r15settle` — повтор падает. Сжато фаззером (сид 7250928).
  fixedRoot('перепрогон R15 (ж): «Продолжить», чьё взятие легло поздно, а забег уже у комнаты ноды, — строка на неё, а не на несозданную', 7250928, [
    { k: 'join', h: 1, mode: 'code', r: 0.7275196467526257, reuse: false, via: 'gw' },
    { k: 'wait', ms: 61_000 },
    { k: 'wait', ms: 61_000 },
    { k: 'step', n: 30 },
    { k: 'join', h: 3, mode: 'friend', r: 0.47992228739894927, reuse: true, via: 0 },
    { k: 'wait', ms: 61_000 },
    { k: 'descend', h: 1, r: 0.006927951704710722, others: 'yes', near: false, pause: true },
    { k: 'wait', ms: 61_000 },
    { k: 'join', h: 0, mode: 'fresh', r: 0.5479457837063819, reuse: false, via: 'gw' },
    { k: 'join', h: 2, mode: 'code', r: 0.13349726935848594, reuse: true, via: 'gw' },
    { k: 'attack', h: 1, r: 0.11577198072336614, weaken: true },
    { k: 'close', h: 0 },
    { k: 'join', h: 1, mode: 'fresh', r: 0.15657527814619243, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'code', r: 0.3441667705774307, reuse: true, via: 'x' },
    { k: 'town', h: 3, others: 'yes', near: true, pause: true },
    { k: 'close', h: 2 },
    { k: 'step', n: 30 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'leave', h: 3 },
    { k: 'close', h: 0 },
    { k: 'join', h: 0, mode: 'resume', r: 0.7389698668848723, reuse: true, via: 'x' },
    { k: 'join', h: 3, mode: 'resume', r: 0.07838283618912101, reuse: false, via: 'x' },
    { k: 'wait', ms: 1600 },
    { k: 'join', h: 2, mode: 'resume', r: 0.5927640041336417, reuse: false, via: 'x' },
  ], '5-resume-dead-end');
  // (з) МОДЕЛЬ ФАЗЗЕРА. h1 соло зовёт спуск из города — продолжение припаркованного забега ждёт взятия (R9-01), а оно отвечает поздно (`late`):
  // операция кончилась, герой «в городе». Следующая (час) застала переход: h1 вошёл в подземелье, автосейв лёг с неизвестным исходом (сессия
  // снята), грейс кончился — похороны по правилам, а не «похоронен стоящий в городе». Комната на переходе (продолжение ждёт базу) — не город.
  fixedRoot('перепрогон R15 (з): похороны героя, чья комната на начало операции уже уходила в подземелье, — не «стоящий в городе»', 7270081, [
    { k: 'join', h: 1, mode: 'fresh', r: 0.3659474460873753, reuse: true, via: 'gw' },
    { k: 'descend', h: 1, r: 0.9370606255251914, others: 'yes', near: false, pause: false },
    { k: 'town', h: 1, others: 'yes', near: false, pause: true },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: null },
    { k: 'fault', f: 'unknownLanded', h: null },
    { k: 'descend', h: 1, r: 0.30662332475185394, others: 'no', near: false, pause: true },
    { k: 'wait', ms: 3_601_000 },
  ], '3-safe-penalized');
  // ⭐ Раунд 16 (фаззер кластера, большой прогон; сид 170085 — пауза машины здесь лишь сдвигала время): герой ушёл из комнаты, державшей его
  // забег, а другая комната ноды начала новый — сверка строки забега (`settleRun`) переписывала её на держателя вставкой, и вставка, легшая
  // ПОЗЖЕ отпуска держателем (его комната ушла), жила за исчезнувшей комнатой до `CLAIM_IDLE_SEC`. Теперь после вставки — сверка снова, как
  // после взятия (`runTaken`, R15-08).
  fixedRoot('раунд 16: сверка строки забега на держателя, легшая после его отпуска, — сверяется снова, а не держит забег за ушедшей комнатой', 170085, [
    { k: 'crash', n: 0 },
    { k: 'wait', ms: 124_000 },
    { k: 'join', h: 1, mode: 'fresh', r: 0.5437627574428916, reuse: true, via: 'gw' },
    { k: 'descend', h: 1, r: 0.981170765357092, others: 'none', near: true, pause: true, diff: 1 },
    { k: 'wait', ms: 4200 },
    { k: 'town', h: 1, others: 'yes', near: true, pause: false },
    { k: 'join', h: 2, mode: 'friend', r: 0.5812762998975813, reuse: false, via: 'gw' },
    { k: 'join', h: 1, mode: 'resume', r: 0.358477720990777, reuse: false, via: 1 },
    { k: 'town', h: 1, others: 'no', near: true, pause: false },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'descend', h: 2, r: 0.11676076636649668, others: 'none', near: true, pause: true, diff: 0 },
    { k: 'close', h: 1 },
  ], 'b-run-lock-orphan');
  // ⭐ R16-02 (модель): машина node-0 на паузе, его герой h0 тем временем вошёл к пати на node-1, погиб там (штраф взят) и ждёт реконнекта в её
  // грейсе. Проснувшаяся node-0 уходит на первом же ударе — и её смерть откатывала h0 «к строке базы» второй раз (мир списал её копии ещё на
  // паузе): модель считала, что он с тех пор оживал, и «Завершить» оплаченной смерти без штрафа выглядело `3-missing-penalty`. Сжато фаззером
  // (сид 190020).
  fixedRoot('R16-02 (модель): смерть проснувшейся ноды не откатывает второй раз героев, которых мир списал с неё ещё на паузе', 190020, [
    { k: 'join', h: 1, mode: 'fresh', r: 0.5622048997320235, reuse: true, via: 'gw' },
    { k: 'abandon', h: 1, via: 'gw' },
    { k: 'join', h: 1, mode: 'resume', r: 0.6475514837075025, reuse: true, via: 'x' },
    { k: 'join', h: 1, mode: 'friend', r: 0.17499810177832842, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'fresh', r: 0.8568386784754694, reuse: true, via: 'gw' },
    { k: 'suspend', n: 0, ms: 130_000, wall: false },
    { k: 'descend', h: 1, r: 0.8712329412810504, others: 'yes', near: true, pause: true },
    { k: 'join', h: 0, mode: 'code', r: 0.7072058960329741, reuse: false, via: 'gw' },
    { k: 'kill', h: 0, body: false },
    { k: 'fault', f: 'unknownLost', h: 0 },
    { k: 'wait', ms: 61_000 },
    { k: 'abandon', h: 0, via: 'gw', ask: true },
  ], '3-missing-penalty');
  // ⭐ Раунд 16 (модель; большой прогон, сид 200019 — пауза машины здесь лишь сдвигала время): h3 погиб в подземелье на node-1, node-1 упала;
  // «Продолжить» ставит его мёртвым в новую комнату забега (K1), мёртвые застряли — комната уходит в город (R12-07, город оживляет), и пати
  // спускается снова. Вход, возврат в город и спуск шли одной операцией, и якорь смерти оставался на комнате упавшей ноды: законное оживление
  // городом числилось `2-revived-elsewhere` (K1). Якорь — комната, куда он вошёл мёртвым (`noteFrame`).
  fixedRoot('раунд 16 (модель): вошедший мёртвым в новую комнату своего забега оживает сменой ЕЁ этажа, а не «в чужой комнате»', 200019, [
    { k: 'join', h: 3, mode: 'code', r: 0.8227567246649414, reuse: true, via: 'gw' },
    { k: 'crash', n: 0 },
    { k: 'wait', ms: 124_000 },
    { k: 'join', h: 2, mode: 'friend', r: 0.8796997691970319, reuse: true, via: 'gw' },
    { k: 'wait', ms: 61_000 },
    { k: 'join', h: 3, mode: 'friend', r: 0.7323144210968167, reuse: false, via: 'x' },
    { k: 'restart', n: 0 },
    { k: 'descend', h: 3, r: 0.8622460223268718, others: 'yes', near: true, pause: true },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: null },
    { k: 'town', h: 0, others: 'no', near: true, pause: true },
    { k: 'attack', h: 2, r: 0.15343769220635295, weaken: true },
    { k: 'step', n: 90 },
    { k: 'kill', h: 3, body: false },
    { k: 'town', h: 2, others: 'no', near: true, pause: true },
    { k: 'descend', h: 3, r: 0.1248106244020164, others: 'none', near: false, pause: true },
    { k: 'step', n: 3 },
    { k: 'town', h: 1, others: 'no', near: true, pause: true },
    { k: 'crash', n: 1 },
    { k: 'wait', ms: 124_000 },
    { k: 'join', h: 3, mode: 'resume', r: 0.9971884347032756, reuse: false, via: 0 },
    { k: 'fault', f: 'unknownLost', h: null },
    { k: 'join', h: 2, mode: 'resume', r: 0.2206850196234882, reuse: false, via: 'gw' },
    { k: 'wait', ms: 16_000 },
    { k: 'descend', h: 3, r: 0.7600327336695045, others: 'yes', near: true, pause: true, diff: 3 },
  ], '2-revived-elsewhere');
  // ⭐ R16-02: ПАУЗА МАШИНЫ НОДЫ ДОЛЬШЕ СРОКА СМЕРТИ. h0 в подземелье своего забега на node-0; машина node-0 встаёт на 200 с (часы процесса
  // стоят, настенные потом догоняет chrony — или стоят и они). Реестр за это время числит её мёртвой: h0 через гейтвей «Продолжить» — на node-1,
  // доигрывает, возвращается в город и выходит (забег припаркован в строке, закрепление и забег node-1 отпустила). node-0 просыпается: раньше
  // сверка аренды (удар) доходила и оживляла её — продление вставляло закрепление h0 и держание забега заново, за ней, и гейтвей вёл h0 к её
  // устаревшей копии в грейсе (штраф за забег, законно припаркованный на node-1; сундуки и босс этажа — второй раз). Теперь удар сперва
  // спрашивает реестр, давно ли тот видел ноду (часы базы), — дольше аренды: выход без записи. Самопроверка `r1602` (без сверки и без второго
  // рубежа в продлении) — `a-dead-node-revived`.
  const suspended = (wall: boolean): Op[] => [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false, via: 0 },
    { k: 'descend', h: 0, r: 0.5, others: 'none', near: false, pause: true },
    { k: 'suspend', n: 0, ms: 200_000, wall },
    { k: 'join', h: 0, mode: 'resume', r: 0, reuse: false, via: 'gw' },
    { k: 'town', h: 0, others: 'none', near: true, pause: true },
    { k: 'leave', h: 0 },
    { k: 'wait', ms: 61_000 },
    { k: 'wait', ms: 61_000 },
    { k: 'step', n: 3 },
  ];
  fixedRoot('R16-02: машина ноды на паузе 200 с, её героя взяла и отпустила другая нода — проснувшаяся уходит без записи (настенные часы догнал chrony)', 11, suspended(true), 'a-dead-node-revived');
  fixedRoot('R16-02: …и когда стояли все часы гостя (сомнения в аренде нет вовсе) — уходит на первом же ударе', 11, suspended(false), 'a-dead-node-revived');
  // ⭐ R17-01: ТА ЖЕ ПАУЗА, НО ПОСРЕДИ УДАРА СЕРДЦА: сверка возраста удара уже ответила «жива» (ответ ждал в буфере сокета всю паузу), или
  // продление своих уже легло. Проснувшаяся продолжает тот же удар: продление отказано (R16-02), а удар раньше был безусловной вставкой — строка
  // node-0 оживала, аренда продлевалась, и следующий удар вставлял закрепление h0 и держание забега заново (гейтвей вёл h0 к её копии). Теперь
  // удар ложится только с проверкой живости в нём самом: не лёг — выход без записи. Самопроверка `r1701` (удар без проверки) — `a-dead-node-revived`.
  const suspendedMid = (mid: 'claims' | 'beat', wall: boolean): Op[] => suspended(wall).map((o) => (o.k === 'suspend' ? { ...o, mid } : o));
  fixedRoot('R17-01: машина встала сразу после ответа сверки возраста удара — удар не ложится, проснувшаяся уходит без записи', 11, suspendedMid('claims', true), 'a-dead-node-revived');
  fixedRoot('R17-01: …и между продлением своих и ударом (стояли все часы гостя)', 11, suspendedMid('beat', false), 'a-dead-node-revived');
  it('самопроверка R17-01: удар без проверки живости в нём самом — пауза после ответа сверки даёт `a-dead-node-revived`', async () => {
    const refused = stats.get('node:beat-refused') ?? 0;
    expect((await replay(11, suspendedMid('claims', false))).map((v) => v.inv), 'с проверкой в ударе — чисто').toEqual([]);
    expect(stats.get('node:beat-refused') ?? 0, 'проснувшаяся нода ушла по отказу удара, а не сверки').toBeGreaterThan(refused);
    teeth.r1701 = true;
    try {
      for (const mid of ['claims', 'beat'] as const) {
        for (const wall of [true, false]) expect((await replay(11, suspendedMid(mid, wall))).map((v) => v.inv), `${mid}, настенные ${wall ? 'догнал chrony' : 'стояли'}`).toContain('a-dead-node-revived');
      }
    } finally { teeth.r1701 = FUZZ_SELFTEST === 'r1701'; }
  });
  it('самопроверка R16-02: без сверки возраста удара и без второго рубежа в продлении — `a-dead-node-revived`', async () => {
    const saw = stats.get('node:registry-saw-dead') ?? 0;
    expect((await replay(11, suspended(true))).map((v) => v.inv), 'со сверкой — чисто').toEqual([]);
    expect(stats.get('node:registry-saw-dead') ?? 0, 'проснувшаяся нода ушла по сверке с реестром').toBeGreaterThan(saw);
    teeth.r1602 = true;
    try {
      for (const wall of [true, false]) expect((await replay(11, suspended(wall))).map((v) => v.inv)).toContain('a-dead-node-revived');
    } finally { teeth.r1602 = FUZZ_SELFTEST === 'r1602'; }
  });
  // ── Перепрогон после правок раунда 16 (сиды 8 200 001…8 201 000), МОДЕЛЬ ФАЗЗЕРА — сервер прав. «Продолжить» через гейтвей ждёт взятия забега,
  // чей ответ реестра опаздывает (`late`, сотни мс), и тут же машина этой ноды встаёт на паузу (`suspend`): операция паузы двигает время на срок
  // смерти ноды (124 с), а процесс на паузе не отвечает ничего — проверка 5 читала это «кадром лобби без ответа». Кадр к ноде на паузе ждёт её
  // конца: проснувшаяся уходит без записи (сокеты закрыты — ответ не нужен), а без паузы тот же вход садит героя в следующей же операции.
  // Сжато фаззером (сиды 8200125 и 8200619).
  fixedRoot('перепрогон R16 (модель): вход, ждущий позднего ответа реестра, и пауза машины его ноды — не «кадр лобби без ответа»', 8200125, [
    { k: 'join', h: 2, mode: 'friend', r: 0.7484877316746861, reuse: true, via: 'gw' },
    { k: 'descend', h: 2, r: 0.7313783599529415, others: 'yes', near: false, pause: false },
    { k: 'wait', ms: 4200 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 0 },
    { k: 'town', h: 2, others: 'yes', near: true, pause: false },
    { k: 'join', h: 2, mode: 'resume', r: 0.1476424764841795, reuse: true, via: 'gw' },
    { k: 'suspend', n: 0, ms: 130_000, wall: true },
  ], '5-lobby-unanswered');
  fixedRoot('перепрогон R16 (модель): …и после выхода из города, новым соединением', 8200619, [
    { k: 'join', h: 0, mode: 'friend', r: 0.35234176041558385, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0.5175720625557005, others: 'yes', near: true, pause: true, diff: 0 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'town', h: 2, others: 'no', near: false, pause: true },
    { k: 'leave', h: 2 },
    { k: 'join', h: 2, mode: 'resume', r: 0.09945983393117785, reuse: false, via: 'gw' },
    { k: 'suspend', n: 1, ms: 130_000, wall: true },
  ], '5-lobby-unanswered');
  // Взятие забега опоздало (`late`), комната его тут же отпустила (спуск не состоялся), а потом взяла снова — спуском пати, законно: строка за ней
  // и продлевается. Отпуск был ДО нового взятия, но проверка `b-run-lock-orphan` помнила его (`runReleasedAt`) и, когда последний участник
  // забега ушёл из города (комната забег больше не держит, подметёт ближайший удар), читала продления нового держания «продлением после
  // отпуска». Отпуск судит только взятия, отправленные до него (позднее взятие R15-08); взятое после него — новое держание. Сжато фаззером
  // (сид 8220479; прогон с длинными простоями, но сжатая последовательность — в окне дизайна).
  fixedRoot('перепрогон R16 (модель): забег, отпущенный комнатой и взятый ею снова, — не «продлён после отпуска»', 8220479, [
    { k: 'regFault', op: 'route', kind: 'fail', n: null },
    { k: 'join', h: 1, mode: 'fresh', r: 0.5010524122044444, reuse: true, via: 'gw' },
    { k: 'join', h: 2, mode: 'friend', r: 0.8612289326265454, reuse: true, via: 'gw' },
    { k: 'descend', h: 2, r: 0.4358929612208158, others: 'none', near: false, pause: true, diff: 0 },
    { k: 'recruit' },
    { k: 'join', h: 0, mode: 'friend', r: 0.2576081482693553, reuse: false, via: 'gw' },
    { k: 'town', h: 0, others: 'none', near: true, pause: true },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 0 },
    { k: 'fault', f: 'unknownLost', h: 0 },
    { k: 'join', h: 2, mode: 'fresh', r: 0.871086437953636, reuse: false, via: 'gw' },
    { k: 'descend', h: 2, r: 0.8230289863422513, others: 'yes', near: true, pause: false, diff: 3 },
    { k: 'join', h: 1, mode: 'friend', r: 0.016975944861769676, reuse: false, via: 'gw' },
    { k: 'descend', h: 1, r: 0.2100534753408283, others: 'yes', near: true, pause: true },
    { k: 'join', h: 0, mode: 'friend', r: 0.13637704798020422, reuse: true, via: 'gw' },
    { k: 'town', h: 2, others: 'yes', near: false, pause: true },
    { k: 'close', h: 1 },
    { k: 'leave', h: 2 },
    { k: 'join', h: 3, mode: 'code', r: 0.9209239222109318, reuse: true, via: 'x' },
    { k: 'leave', h: 0 },
  ], 'b-run-lock-orphan');
  // «Продолжить» на node-0 ждал ответа реестра, а тем временем машина node-1, чья комната держит его забег, встала на паузу: взятие ответило
  // «забег в комнате BEY5WG65» (держание node-1 ещё в окне), и отказ назвал комнату процесса на паузе. Для мира такой процесс ушёл (`forget`, как
  // упавший), и его держание — то же окно держания мёртвой ноды: отказ временный, после него «Продолжить» находит забег (эпилог это стережёт).
  // Проверка знала окно только для упавших (`dead`). Сжато фаззером (сид 8220704; пауза — в окне дизайна, R16-02).
  fixedRoot('перепрогон R16 (модель): отказ «Продолжить» с кодом комнаты ноды, чья машина встала на паузу, — окно держания, а не тупик', 8220704, [
    { k: 'join', h: 0, mode: 'friend', r: 0.34143628692254424, reuse: false, via: 'gw' },
    { k: 'step', n: 1 },
    { k: 'step', n: 10 },
    { k: 'descend', h: 0, r: 0.12227179808542132, others: 'yes', near: false, pause: true },
    { k: 'crash', n: 0 },
    { k: 'join', h: 2, mode: 'friend', r: 0.5799622295890003, reuse: true, via: 'gw' },
    { k: 'recruit' },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 0 },
    { k: 'join', h: 3, mode: 'friend', r: 0.18954091472551227, reuse: false, via: 'gw' },
    { k: 'descend', h: 3, r: 0.7459224094636738, others: 'yes', near: true, pause: true },
    { k: 'wait', ms: 3_601_000 },
    { k: 'restart', n: 0 },
    { k: 'join', h: 0, mode: 'friend', r: 0.8491046014241874, reuse: false, via: 'gw' },
    { k: 'abandon', h: 3, via: 'gw', ask: true },
    { k: 'close', h: 0 },
    { k: 'town', h: 2, others: 'no', near: false, pause: true },
    { k: 'close', h: 2 },
    { k: 'join', h: 2, mode: 'resume', r: 0.7270895775873214, reuse: false, via: 0 },
    { k: 'suspend', n: 1, ms: 200_000, wall: false },
  ], '5-resume-dead-end');
  // ⭐ Перепрогон R16, ДВОЙНОЙ СБОЙ ЗА ОКНОМ ДИЗАЙНА (`DM_FUZZ_OUTAGE_LONG`): сердцебиение node-0 не доходит до реестра 400 с, и посреди этого её
  // машина встаёт на 130 с (стояли все часы). Реестр отдаёт h0 и его забег node-1 («Продолжить» через гейтвей), а проснувшаяся node-0 спросить
  // реестр не может — держит свою копию в грейсе и комнату забега до конца аренды (a, b). Это корень `ENV-thaw-registry-silent` (`KNOWN`), а без
  // долгого простоя сердцебиения (ударом сверки R16-02 нода уходит сразу) тот же повтор чист. Сжато фаззером (сид 8220394).
  const THAW_SILENT: Op[] = [
    { k: 'stall', n: 0, ms: 400_000, long: true },
    { k: 'join', h: 0, mode: 'code', r: 0.2973463968373835, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0.2639001728966832, others: 'yes', near: false, pause: true, diff: 0 },
    { k: 'suspend', n: 0, ms: 130_000, wall: false },
    { k: 'descend', h: 2, r: 0.27310377615503967, others: 'yes', near: false, pause: true, diff: 2 },
    { k: 'descend', h: 0, r: 0.708571185125038, others: 'yes', near: true, pause: true, diff: 3 },
    { k: 'step', n: 90 },
    { k: 'join', h: 0, mode: 'resume', r: 0.6925311542581767, reuse: true, via: 'gw' },
  ];
  it('перепрогон R16 (модель): пауза машины, а реестр ей недоступен и после неё, — корень за окном дизайна (`ENV-thaw-registry-silent`)', async () => {
    const vs = await replay(8220394, THAW_SILENT);
    expect(vs.map((v) => v.inv), 'двойной сбой воспроизводится').toContain('a-live-two-nodes');
    expect(vs.filter((v) => v.cause !== 'ENV-thaw-registry-silent').map((v) => `${v.inv}: ${v.msg}`), 'и объяснён своим корнем').toEqual([]);
    const short: Op[] = [{ k: 'stall', n: 0, ms: 400_000 }, ...THAW_SILENT.slice(1)];
    expect((await replay(8220394, short)).map((v) => `${v.inv}: ${v.msg}`), 'простой сердцебиения в окне дизайна — чисто').toEqual([]);
  });
  // ── Перепрогон после правок раунда 17 (сиды 9 430 001…9 430 300, 300 оп.), МОДЕЛЬ ФАЗЗЕРА — сервер прав. Машина node-0 встала сразу после
  // ответа сверки удара (R17-01, `suspend.mid`); h0 «Продолжить» на node-1, h3 к нему по коду, h0 ушёл (грейс), node-1 в разделе с базой; оба
  // погибли — штраф h0 взят в памяти node-1, его запись ждёт конца раздела (копия на дописать). Проснувшаяся node-0 продолжает тот же удар и
  // снимает свои проигравшие копии h0 и h3 (`fenceLost`) — а модель откатывала по этому снятию правду h0 «к строке базы» (строка без штрафа:
  // вещи снова «у героя», сток забыт), хотя его правда — копия node-1, а копии node-0 мир списал ещё на паузе (как смерть такой ноды, R16-02).
  // Легла запись node-1 — штраф в строке, и взятые им вещи числились пропавшими без стока (`1-item-lost`). Снятие копии процессом, которого мир
  // уже списал, правды героя не трогает. Сжато фаззером (сид 9430061).
  fixedRoot('перепрогон R17 (модель): проснувшаяся посреди удара нода снимает свои проигравшие копии — правда героя на другой ноде не откатывается', 9430061, [
    { k: 'join', h: 0, mode: 'fresh', r: 0.29429075587540865, reuse: false, via: 'gw' },
    { k: 'join', h: 0, mode: 'resume', r: 0.5920183213893324, reuse: true, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.6996014229953289, reuse: true, via: 'gw' },
    { k: 'close', h: 1 },
    { k: 'join', h: 4, mode: 'friend', r: 0.3202300660777837, reuse: true, via: 1 },
    { k: 'join', h: 3, mode: 'friend', r: 0.5415613993536681, reuse: false, via: 'x' },
    { k: 'join', h: 0, mode: 'code', r: 0.12889971560798585, reuse: false, via: 0 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'descend', h: 0, r: 0.31072546052746475, others: 'yes', near: true, pause: true },
    { k: 'suspend', n: 0, ms: 400_000, wall: false, mid: 'claims' },
    { k: 'join', h: 0, mode: 'resume', r: 0.5125974263064563, reuse: false, via: 'x' },
    { k: 'join', h: 3, mode: 'code', r: 0.43106870958581567, reuse: false, via: 'gw' },
    { k: 'step', n: 90 },
    { k: 'leave', h: 0 },
    { k: 'step', n: 30 },
    { k: 'step', n: 30 },
    { k: 'partition', n: 1, ms: 45_000 },
    { k: 'step', n: 30 },
    { k: 'wait', ms: 16_000 },
    { k: 'step', n: 1 },
    { k: 'step', n: 3 },
    { k: 'step', n: 10 },
    { k: 'descend', h: 0, r: 0.42568637686781585, others: 'yes', near: true, pause: true },
    { k: 'step', n: 90 },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
  ], '1-item-lost');
});
