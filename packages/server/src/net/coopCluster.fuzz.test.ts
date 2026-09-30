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
 * «Завершить» этой ноды, в том числе «мёртв, оплачено» строки после падения и слива; ⭐ R20-01: и слив выходит, только когда свод процесса в
 * базе или сказан ИНЦИДЕНТ — `8-drain-ledger-silent`: пачка свода снятой комнаты, висящая в базе, — сбой `ledgerSlow`, из своего потока;
 * ⭐ перепрогон R20: под ней же копия сессии, чья транзакция «сейв + сундук» ждёт свод, — под вопросом до конца транзакции, как R15-02 одной
 * ноды, а «Завершить» в силе, пока его кадр исполняется, и когда соединение уже закрыто — `abandonBusy`; ⭐ D1: и правило общего забега —
 * `5-run-stuck`, `5-run-paid`, `5-resume-split`, `5-solo-unearned`, ⭐ R22-05 `5-vote-consented-failed`, операции `want` и `solo`, фаза живости эпилога: «Продолжить» и «Соло» через
 * гейтвей, а отказ `run` с кодом держателя — к его ноде по коду, как веб-клиент, `EntryFlow.runHeld`; живость — только при здоровом кластере) и
 * кластерные:
 *  a — герой держится (сессия, грейс, тело) не больше чем одной живой нодой (`a-live-two-nodes`); живая сессия проигравшей копии снимается
 *      сердцебиением (`fenceLost`); ⭐ R16-02: нода, которую реестр не видел дольше аренды (пауза машины: часы процесса стояли), не оживает — её
 *      удар не доходит, а процесс уходит без записи (`a-dead-node-revived`; раньше продление вставляло отданное и отпущенное заново); ⭐ R17-01:
 *      и когда пауза легла ПОСЛЕ ответа сверки (`suspend.mid`: между сверкой и продлением своих или между продлением и ударом) — удар ложится
 *      только с проверкой в нём самом (`heartbeat(…, leased)`), и устаревший ответ сверки ноду не оживляет; ⭐ R18-03: и запись ПО СТРОКЕ БАЗЫ
 *      (штраф брошенного забега, снятие забега — `settleStored`, `abandonStored`) не ложится на героя, чьё закрепление у другой ноды
 *      (`a-stored-foreign-write`): после паузы машины с остановленными часами (аренда цела, сомнения нет) нода до первого удара исполняет кадры,
 *      пришедшие в её сокеты за паузу (операция `frozenFrame`, из своего потока), — и хоронила строку героя, который уже играл тот же забег на
 *      другой ноде;
 *  b — забег идёт в подземелье не больше чем одной комнаты во всём кластере (`b-run-two-rooms`); нода не теряет держание забега, который её
 *      комната ведёт (`b-run-lock-lost` — ИНЦИДЕНТ сердцебиения); ⭐ R15-08: и не держит забег, который её комната отпустила (`b-run-lock-orphan`:
 *      продление или взятие, легшее в базу ПОСЛЕ отпуска, вставляло строку заново, и «Продолжить» на соседней ноде вело к исчезнувшей комнате;
 *      поздний ответ реестра — сбой `late` из своего потока `lateReg`; ⭐ перепрогон R19: строка, которую нода держит за своим недолёгшим
 *      сводом, R18-02 `runsOwed`, — не сирота, пока свод должен и до первого дошедшего удара после того, как он лёг; ⭐ перепрогон Z4: и строка,
 *      которую позднее взятие ушедшей комнаты переписало поверх держателя той же ноды, а вернуть держателю реестр не дал (`claimFailedAt`), —
 *      до первого дошедшего удара: держит — продление, отпустил — снятие, `RoomManager.runsStale`);
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
 * базой дольше неё; ⭐ перепрогон R18: или свод забега, которого ждёт строка героя, K2, — не принимался столько же, `ledgerDown`) —
 * `ENV-drain-db-outage`: копии уходят с процессом (ИНЦИДЕНТ, R12-04), прогон на нём не падает. ⭐ Перепрогон R16: и (только
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
 * `DM_FUZZ_OPS` — длина последовательности, `DM_FUZZ_FAULTS=0` — без сбоев базы и реестра, `DM_FUZZ_ADMIN=0` — без обгонов
 * администратора (`adminBump`: ни одно нарушение не прощается корнем `ADMIN-row-wins`), `DM_FUZZ_SHRINK=0` — без сжатия,
 * `DM_FUZZ_SHRINK_KNOWN=1` — сжимать и известные корни, `DM_FUZZ_TRACE=1` — операции и состояние после каждой (и взятия, отпуски, продления забегов в реестре), `DM_FUZZ_LOG=<файл>` —
 * нарушения сразу в файл, `DM_FUZZ_SELFTEST=claim|runlock|fence|leak|held|lease|k1|k3|c09|r1508|r15settle|r1602|r1701|r1802|r1803|r1905|r2001|d1solo|d1timeout|z3lost|z4stale` — самопроверка (сломать правило реестра, снятие проигравших,
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
/** ⭐ Z: `DM_FUZZ_ADMIN=0` — без обгонов администратора: корень `ADMIN-row-wins` (герой обогнан хоть раз за прогон) не заслоняет настоящий той же метки. */
const FUZZ_ADMIN = process.env.DM_FUZZ_ADMIN !== '0';
const FUZZ_LOG = process.env.DM_FUZZ_LOG;
const FUZZ_SELFTEST = process.env.DM_FUZZ_SELFTEST ?? '';
/** Паузы и разделы дольше `NODE_DEAD_SEC` (за окном дизайна) — только по просьбе. */
const OUTAGE_LONG = process.env.DM_FUZZ_OUTAGE_LONG === '1';
/**
 * ⭐ R16-02: самопроверка `r1602` — и из теста (зубы сценария паузы машины идут в прогоне по умолчанию). ⭐ R17-01: `r1701` — удар сердца без
 * проверки живости в нём самом (безусловная вставка, как до правки), сверка и продление — как есть. ⭐ D1 `d1solo` — держатель «Соло» не отпускает
 * забег (`handRun` — ложь), `d1timeout` — голосование вне подземелья без срока: оба — `5-run-stuck` (операция `want`); R19-05 `r1905` — пауза и уход комнаты
 * свод забега не дописывают (`8-ledger-stranded`, операция `adminBump`) — как у фаззера одной ноды. ⭐ R20-01 `r2001` — комната, чья пачка свода
 * в пути, не в учёте недолёгшего (как до правки): слив снятой комнаты её не ждёт (`8-node-refarmable`, сбой `ledgerSlow`). ⭐ R22-09 (сам прогон):
 * `r2209` — имя ноды одно на весь процесс теста, как до правки (`nodeEnv`); `wrongLetter` — нода чеканит коды буквой соседней: оба —
 * `harness:letter-mismatch`, провал прогона. ⭐ Z3 `z3lost` — ответ взятия забега «держит другая нода» — ИНЦИДЕНТ и о комнате, которая забег
 * уже отпустила (как до правки `RoomManager.runLost`): `b-run-lock-lost`. ⭐ Z4 `z4stale` — строку забега за ушедшей комнатой, которую не
 * удалось вернуть держателю, удар не помнит (как до правки `RoomManager.runsStale`): `b-run-lock-orphan`.
 */
const teeth = {
  r1602: FUZZ_SELFTEST === 'r1602', r1701: FUZZ_SELFTEST === 'r1701', r1802: FUZZ_SELFTEST === 'r1802', r1803: FUZZ_SELFTEST === 'r1803',
  r1905: FUZZ_SELFTEST === 'r1905', r2001: FUZZ_SELFTEST === 'r2001', d1solo: FUZZ_SELFTEST === 'd1solo', d1timeout: FUZZ_SELFTEST === 'd1timeout',
  r2209: FUZZ_SELFTEST === 'r2209', wrongLetter: FUZZ_SELFTEST === 'wrongLetter', z3lost: FUZZ_SELFTEST === 'z3lost', z4stale: FUZZ_SELFTEST === 'z4stale',
};
function logLine(s: string): void { if (FUZZ_LOG) appendFileSync(FUZZ_LOG, `${s}\n`); }
// ⭐ Перепрогон R18: и самопроверка — сжатие внесённого дефекта (`runlock`: 161 с одним процессом) под нагрузкой соседних прогонов упиралось в
// потолок прогона по умолчанию, найдя свой корень.
vi.setConfig({ testTimeout: FUZZ_SEEDS || FUZZ_SELFTEST ? 24 * 3600_000 : 180_000 });
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
/** ⭐ D1 (живость): шагов клиента по правилу общего забега до подземелья своего забега (как у фаззера одной ноды; в кластере — и переход к ноде). */
const WANT_STEPS = 14;
/** ⭐ D1: штрафы за брошенный забег («Завершить», похороны) — «без штрафа» живости считает только их. */
const PAID_SRC: ReadonlySet<string> = new Set(['abandonStored', 'abandonAsDead', 'stored', 'bury', 'buryFled']);

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
type FaultKind = 'fail' | 'deadlock' | 'unknownLost' | 'unknownLanded' | 'stashConflict' | 'ledgerDown' | 'ledgerSlow';
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
  writes: [] as {
    charId: string; v: number; ok: boolean; reason: string; stash: boolean; json?: string; src?: SaveState; seq?: number;
    /** ⭐ R18-03: нода, чей процесс писал; запись по строке базы (`settleStored`, `abandonStored`); чьё закрепление было у героя в миг записи. */
    node?: string; byRow?: boolean; owner?: string | null;
  }[],
  /** ⭐ R18-03: нода, чей процесс сейчас зовёт базу (`dbFor`: вызов синхронен до записи). */
  writer: undefined as string | undefined,
  /** ⭐ R18-03: записей по строке, отказанных проверкой владения (`putCharacterOwned` → `foreign`). */
  foreignRefused: 0,
  /** ⭐ R18-02: свод забега не пишется (строки героев — пишутся) до операции `ledgerDownUntil` (номер операции прогона — `opNow`). */
  ledgerDownUntil: 0,
  /** ⭐ Перепрогон R18: поддельный час, когда свод снова стал приниматься (слив в фоне переживает операции — `drainLedgerDown`). */
  ledgerUpAt: 0,
  /**
   * ⭐ R20-01: следующая запись свода висит в базе `ms` по часам процесса, который её отправил (умер процесс — не ляжет никогда: соединение ушло с
   * ним), потом ложится или падает (`fail`). `slowUntil` — процесс → час, когда его медленная пачка кончается (`drainLedgerDown`).
   */
  ledgerSlow: null as null | { ms: number; fail: boolean },
  slowUntil: new Map<unknown, number>(),
  /** ⭐ Перепрогон R20: медленные пачки свода — процесс и отрезок времени (срок ответа кадра лобби длиннее на них, проверка 5). */
  slowSpans: [] as { inc: unknown; from: number; to: number }[],
  opNow: 0,
  /** Сквозной номер легшей записи: штраф, записанный ПОЗЖЕ себя тем же объектом сейва, — лёг (см. `landed`). */
  wseq: 0,
  /** ⭐ R19-05: администратор обгоняет следующую запись сейва героя `charId` (как у фаззера одной ноды); `during` — что комната успела. */
  bump: null as null | { charId: string; during: () => void },
  /** ⭐ R19-05: герои прогона, чью строку обогнал администратор (`ADMIN-row-wins`). */
  bumped: new Set<string>(),
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
  /** ⭐ R18-03: кто пишет, по строке ли базы (действие над свежей строкой — `settleStored`, `abandonStored`) и чьё закрепление у героя сейчас. */
  const who = (charId: string): { node?: string; byRow: boolean; owner: string | null } => ({
    node: db.writer, byRow: /settleStored|abandonStored/.test(new Error().stack ?? ''), owner: cur?.cluster.claimOwner(charId) ?? null,
  });
  const putCharacter = async (charId: string, userId: string, data: SaveState, v: number, reason = 'autosave'): Promise<number | null> => {
    const json = JSON.stringify(data);
    const by = who(charId);
    const bump = db.bump?.charId === charId ? db.bump : null;
    if (bump) db.bump = null;
    const f = take(charId, false);
    if (bump && f === undefined) {
      // ⭐ R19-05: строку обогнал администратор, пока запись шла (содержимое — тот же снимок); комната тем временем живёт дальше. Второй писатель —
      // внешний, как сбой базы (счёт `consumed`: отказ по версии дальше — не `7-second-writer`).
      db.consumed++;
      db.bumped.add(charId);
      const r = db.rows.get(charId);
      if (r) { r.version++; r.json = json; }
      bump.during();
    }
    if (f === 'fail') throw injected(new Error('база упала'));
    if (f === 'deadlock') throw injected(Object.assign(new Error('обнаружена взаимоблокировка'), { code: '40P01' }));
    if (f === 'unknownLost') throw unknown(json);
    const r = db.rows.get(charId);
    if (!r || r.userId !== userId || r.version !== v) { db.writes.push({ charId, v, ok: false, reason, stash: false, ...by }); return null; }
    r.version = v + 1; r.json = json;
    db.writes.push({ charId, v, ok: true, reason, stash: false, json, src: data, seq: ++db.wseq, ...by });
    if (f !== 'unknownLanded') db.unknownStreak.delete(charId);
    if (f === 'unknownLanded') throw unknown(json);
    return r.version;
  };
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
    putCharacter,
    // ⭐ R18-03: `db.putCharacterOwned` — владение и запись одним запросом: закрепление героя не за этой нодой (или, с арендой, реестр не видел
    // её удара дольше аренды) — `foreign`, не записано ничего.
    putCharacterOwned: async (charId: string, userId: string, data: SaveState, v: number, owner: { node: string; leased: boolean }, reason = 'autosave') => {
      if (!cur?.cluster.ownsRow(charId, owner.node, owner.leased)) { db.foreignRefused++; tally('r1803:foreign-refused'); return 'foreign'; }
      return putCharacter(charId, userId, data, v, reason);
    },
    putCharacterWithStash: async (
      charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number, reason = 'stash', _reasons?: unknown,
      owner?: { node: string; leased: boolean },
    ) => {
      // ⭐ R18-03: с `owner` — владение и запись одним запросом (`db.putCharacterWithStash`): героя держит не эта нода — `foreign`, не записано.
      if (owner && !cur?.cluster.ownsRow(charId, owner.node, owner.leased)) { db.foreignRefused++; tally('r1803:foreign-refused'); return { ok: false, conflict: 'foreign' }; }
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
      // ⭐ R18-02: свод не принимается (блокировка, таймаут выражения), а строки героев — да.
      if (db.opNow < db.ledgerDownUntil) throw injected(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
      // ⭐ R20-01: медленная пачка — висит по часам своего процесса (таймер умершего не срабатывает: пачка не ляжет), потом ложится или падает.
      const slow = db.ledgerSlow;
      if (slow) {
        db.ledgerSlow = null;
        const inc = als.getStore();
        db.slowUntil.set(inc, Date.now() + slow.ms);
        db.slowSpans.push({ inc, from: Date.now(), to: Date.now() + slow.ms });
        if (inc) inc.ledgerInFlight++;
        try {
          await new Promise((r) => setTimeout(r, slow.ms));
        } finally { if (inc) inc.ledgerInFlight--; }
        if (slow.fail) throw injected(Object.assign(new Error('Query read timeout'), {}));
      }
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
/**
 * ⭐ R22-09: ИМЯ НОДЫ — У ПРОЦЕССА, А НЕ У ПРОГОНА. `RoomManager` читает `process.env.DM_NODE_ID` при вызове (`newCode` — буква ноды в коде
 * комнаты), а обе ноды живут в одном процессе теста. Прогон ставил переменную перед каждой операцией ноды, и продолжение ноды после ожиданий
 * (`join`: закрепление, выселение, прощание, свод) читало имя ДРУГОЙ ноды, успевшей её переставить: код комнаты с чужой буквой. Гейтвей модели
 * вёл его к чужой ноде, та отвечала `run` тем же кодом, «Продолжить» ходил по кругу — ложный `5-run-stuck` (сид 882050), а пути маршрута по
 * букве (D1, C-05/C-08) проверялись в состоянии, которого в проде нет. Теперь имя ноды читается у процесса, чей это код (`als`), вне его — как
 * поставил прогон; код с чужой буквой — провал прогона (`harness:letter-mismatch`), а не счётчик. Зубы: `r2209` (как до правки), `wrongLetter`.
 */
const realEnv = process.env;
const nodeEnv: NodeJS.ProcessEnv = new Proxy(realEnv, {
  get: (t, k) => {
    if (k !== 'DM_NODE_ID') return Reflect.get(t, k);
    const inc = teeth.r2209 ? undefined : als.getStore();
    if (!inc) return t.DM_NODE_ID;
    return teeth.wrongLetter ? `node-${(inc.n + 1) % 2}` : inc.node;
  },
  // Запись — прямо в настоящее окружение: через прокси (приёмник — он) Node получил бы неполный дескриптор и отказал бы.
  set: (t, k, v) => Reflect.set(t, k, v),
});

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
  /** ⭐ D1: последний вход сокета — «Продолжить без пати» (`join{resume, solo}`); кадры сокета — ещё и сюда (живость, `wantRun`). */
  solo?: boolean;
  tap?: (f: ServerFrame) => void;
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
    this.tap?.(f);
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
    /** Сейвы на удержании (R1-05): у сессии — транзакция «сейв + сундук» в пути; у тела в бою (`lingering`) — его срок. */
    saveHeld: Set<string>;
  };
  setInput(pid: string, input: PlayerInput): void;
  stop(): void;
  holdsRun(key: string): boolean;
  /** ⭐ D1: право «Соло» героя на забег здесь; сколько мест занято (без героя). */
  soloRight(charId: string, key: string): boolean;
  seatsTaken(charId: string): number;
  /** Голосование комнаты (живость — по нему: чьё, «за» ли герой). */
  vote: { kind: string; by: string; yes: Set<string>; no: Set<string> } | null;
  /** Забег, который комната держит, и заморозка слива (голосов нет). */
  runLock: string | null; frozen: boolean;
  /** ⭐ R19-05: повтор записи свода по таймеру и пачки свода в пути (`8-ledger-stranded`); запись прогресса героя, сундук узла. */
  ledgerRetry: unknown; ledgerInflight: number;
  persist(pid: string): Promise<unknown>;
  openChest(pid: string, id: number): void;
};
type RmIn = {
  rooms: Map<string, RoomIn>; conns: Map<GameConn, { pid: string; room: RoomIn }>; live: Map<string, GameConn>;
  graceByChar: Map<string, RoomIn>; unsaved: Map<string, unknown>; inflight: Map<string, unknown>; charOps: Map<string, unknown>;
  runRooms: Map<string, RoomIn>;
  /** ⭐ R18-02: строки забегов, которые нода держит без комнаты за недолёгшим сводом (ключ → код комнаты строки). */
  runsOwed: Map<string, string>;
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
   * (герои, что он держал, давно живут строкой базы или на другой ноде, и их правда — там). ⭐ Перепрогон R18: снимает метку только удар,
   * принятый реестром (`beat`), или реестр, недоступный и после паузы (`thaw`, `ENV-thaw-registry-silent`), — не возвращение с паузы само по себе.
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
  /**
   * ⭐ R18-03: кадры, пришедшие в сокеты процесса, пока машина стояла (`frozenFrame`): сокет жив (TCP копит), процесс прочтёт их, оттаяв, —
   * при остановленных часах ДО первого удара (`thaw`).
   */
  queued: { ws: FakeConn; frame: Record<string, unknown> }[];
  rm: RmIn; hooks: ClusterHooksIn; reg: RegIn;
  /** ⭐ ENV1: аренда процесса (`lease.ts` его графа модулей: её же читают его комнаты и менеджер). */
  lease: typeof import('../cluster/lease.js');
  runLedgerKey: (cfg: RunConfig) => string;
  /** ⭐ R18-02: у процесса есть записи свода забега, которых в базе нет (`runLedgerOwed` его графа модулей). */
  ledgerOwed: (key: string) => boolean;
  /** ⭐ R19-05: комнаты процесса с недолёгшим сводом (`ledgerOwingRooms` его графа модулей) — и ушедшие. */
  ledgerOwing: () => readonly unknown[];
  /** ⭐ R20-01: пачек свода процесса в базе (запись отправлена, исхода нет) и сказал ли его слив ИНЦИДЕНТ о своде. */
  ledgerInFlight: number; ledgerIncident: boolean;
  /**
   * ⭐ Перепрогон R20: кадры «Завершить», которые процесс сейчас исполняет (герой → сколько): просьба в силе, пока её кадр не кончился, и когда
   * её соединение уже закрыто (сервер доводит начатое). Умерший процесс кадров не доводит — его счёт не в силе.
   */
  abandonBusy: Map<string, number>;
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
  | { k: 'fault'; f: FaultKind; h: number | null; ops?: number; ms?: number; fail?: boolean }
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
  /**
   * ⭐ R18-03: кадр героя, чей сокет на ноде, стоящей на паузе машины: `return` — «в город», `vote` — «за», `leave` — выйти. Процесс прочтёт его,
   * оттаяв (`thaw`), — до первого удара, если стояли все часы. Из своего потока (`W.thawF`).
   */
  | { k: 'frozenFrame'; h: number; t: 'return' | 'vote' | 'leave' }
  /** ⭐ R15-08: `late` — запрос реестра ляжет с опозданием (`LATE_MS` поддельного времени): между отправкой и «легло» идут шаги и операции. */
  | { k: 'regFault'; op: RegOp; kind: 'fail' | 'landed' | 'late'; n: number | null }
  /** ⭐ R19-04: держатель забега в городе действует и отвечает «нет» (`no`) или молчит — как у фаззера одной ноды. Из своего потока (`W.obstruct`). */
  | { k: 'obstruct'; h: number; no: boolean }
  /** ⭐ D1: «Продолжить без пати» — как у фаззера одной ноды (в игре — `leave` и вход тем же сокетом, вне игры — через гейтвей). Из своего потока. */
  | { k: 'solo'; h: number }
  /** ⭐ D1 (живость): герой хочет продолжить свой забег (`wantRun`); напарники отвечают `partner`. Из своего потока, только при здоровом кластере. */
  | { k: 'want'; h: number; partner: Partner }
  /** ⭐ R19-05: администратор обгоняет автосейв героя в подземелье, пока в комнате открывают сундук. Из своего потока (`W.bump`). */
  | { k: 'adminBump'; h: number };

/** ⭐ D1: как напарники в комнате героя отвечают на его голос за продолжение забега (`wantRun`). */
type Partner = 'yes' | 'no' | 'idle';
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
  /** Кадры лобби в пути. ⭐ Перепрогон Z3: `solo` — у КАДРА (`join{resume, solo}`), а не у сокета: следующий кадр того же сокета его не затирает. */
  pending: { conn: FakeConn; charId: string; t: 'join' | 'runStatus' | 'abandon'; idx: number; at: number; op: number; solo: boolean }[];
  violations: Violation[]; seen: Set<string>;
  penalties: Penalty[];
  sinks: Set<string>; lastLoc: Map<string, string>;
  /**
   * ⭐ K3: поднимаемое (запись поднимающего в пути, `carrying`), чья земля ушла (смена этажа, снятие комнаты): `groundGone` его стоком не
   * числит — легла запись, вещь в сумке. Не легла — ушло с землёй (сток): это решает проверка, когда запись кончилась.
   */
  carryGone: Set<string>;
  /**
   * ⭐ Перепрогон Z4: комната, чья земля ушла с поднимаемым (`carryGone`). Пока её подъём не кончился (`carrying` держит вещь, а процесс жив), запись
   * в пути — у кластера она ждёт свод ещё в комнате, до базы, — и снятая комната из проверки выпала: место вещи — этот подъём, а не сток.
   */
  carryRoom: Map<string, RoomIn>;
  sunkBy: Map<string, string>;
  sold: Set<string>;
  /**
   * ⭐ Перепрогон Z2 (как R15-02 фаззера одной ноды): продажи, ждущие ответа. Кадр продажи стоит в очереди соединения за записью в пути (раздел с
   * базой, медленная база) и исполняется позже своей операции — продано по ответу, когда бы он ни пришёл (`noteFrame`).
   */
  selling: { conn: FakeConn; id: number; uid: string }[];
  /**
   * ⭐ Перепрогон Z2: вещь → герой, чей штраф ЛЁГ В СТРОКУ, пока правда героя для модели — копия в памяти, которая её ещё держит (проигравшая
   * копия ждёт дописки, штраф — по строке базы, `settleStored`). Копию снимут — откат к строке, дописка по строке, — и вещь уходит стоком этого штрафа.
   */
  sinkLater: Map<string, string>;
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
  /** ⭐ R18-03: свой поток у кадров, пришедших ноде на паузе (`frozenFrame`). ⭐ R18-02: и у сбоя свода (`ledgerDown`). */
  thawF: FuzzRng; ledgerF: FuzzRng;
  /** ⭐ R20-01: свой поток у медленной пачки свода (`ledgerSlow`). */
  slowF: FuzzRng;
  /** ⭐ R19-04, R19-05: свои потоки у держателя, что не хочет идти (`obstruct`), и у администратора (`adminBump`). */
  obstruct: FuzzRng; bump: FuzzRng;
  /** ⭐ D1: свои потоки у «Продолжить без пати» (`solo`) и у живости (`want`). */
  soloF: FuzzRng; want: FuzzRng;
  /** ⭐ D1: модель прав «Соло» из кадров (как у фаззера одной ноды): комната → герои с подсказкой `solo` в ней (`5-solo-unearned`). */
  soloHints: WeakMap<RoomIn, Set<string>>;
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
  /**
   * ⭐ Перепрогон Z4: взятие забега, не дошедшее до реестра (`ключ@нода` → час сбоя). Переписать строку на держателя ноды (`settleRun`: позднее
   * взятие ушедшей комнаты легло поверх его строки) чинит ближайший удар (продление за держателем или снятие, `runsStale`) — до него законно.
   */
  claimFailedAt: Map<string, number>;
  /**
   * ⭐ Перепрогон R19: строка, которую нода держит за недолёгшим сводом (R18-02, `runsOwed`), а свод уже лёг (`ключ@нода` → комната строки и
   * когда проверка это впервые увидела): отпустит ближайший удар (`heldRuns`) — до него держание законно, после — сирота.
   */
  owedLanded: Map<string, { room: string; since: number }>;
  /** ⭐ Перепрогон R20: герои, чей кадр «Завершить» кончился за операцию (`Inc.abandonBusy`), — его штраф лёг по просьбе. */
  abandonDone: Set<string>;
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
/** ⭐ D1: срок голосования вне подземелья (`room.ts`, тот же у всех процессов) — живость ждёт его за молчащего напарника. */
let VOTE_TIMEOUT_MS = 0;
/** Процессы, что есть для мира: не мёртвые и ⭐ R16-02 не на паузе машины (стоит целиком — ни ответа, ни записи, ни тика). */
const alive = (w: W): Inc[] => w.nodes.filter((i) => !i.dead && !i.frozenAt);
const incOfRoom = (w: W, room: RoomIn): Inc | undefined => w.roomInc.get(room);

function violate(w: W, inv: string, msg: string, h?: Hero, cause?: string): void {
  const key = `${inv}|${msg}`;
  if (w.seen.has(key)) return;
  w.seen.add(key);
  w.violations.push({ inv, msg: `${msg}${w.events.length ? ` [кластер: ${w.events.slice(-4).join(', ')}]` : ''}`, op: w.op, seed: w.seed, faults: db.consumed, cause: cause ?? causeOf(w, inv, h) });
}
/**
 * ⭐ Перепрогон R18 (модель): ИНЦИДЕНТ слива `s` — дописка ждала СВОД забега, а свод не принимался (`ledgerDown`) до конца бюджета слива (или
 * вернулся меньше чем за круг дописки до него — как база после раздела): сам свод и строка героя, что его несёт (K2: строка не обгоняет свод,
 * иначе продолжение другим собрало бы узел без взятого), — для того, что слив обязан дописать, это раздел с базой дольше аренды ноды
 * (`ENV-drain-db-outage`). Сбой свода меряется операциями, а слив — одна операция: до сотни секунд поддельного времени. Героя, чья строка свода
 * не ждёт (свод его забега весь в базе), сбой свода не объясняет.
 */
function drainLedgerDown(w: W, s: string): boolean {
  const inc = als.getStore();
  if (!inc?.draining || inc.dead) return false;
  // ⭐ R20-01: пачка свода этого процесса висела в базе (`ledgerSlow`) до конца бюджета слива (или кончилась меньше чем за круг дописки до него).
  const slow = Date.now() < (db.slowUntil.get(inc) ?? -Infinity) + DRAIN_LAST_TRY_MS;
  if (!slow && db.opNow >= db.ledgerDownUntil && Date.now() >= db.ledgerUpAt + DRAIN_LAST_TRY_MS) return false;
  if (/свод записей забега/.test(s)) return true;
  const id = /героя (\S+)/.exec(s)?.[1];
  const cfg = w.heroes.find((h) => h.charId === id)?.lastSave?.run?.config;
  return !!cfg && inc.ledgerOwed(inc.runLedgerKey(cfg));
}
/** Нарушения, которые окно простоя дольше `NODE_DEAD_SEC` объясняет по дизайну (R7-09: реестр отдаёт героев и забеги молчащей ноды). */
const ENVELOPE_INV = /^(a-|b-|7-|1-|2-revived|3-double|8-node|8-run|8-progress|4-free|6-internal|5-)/;
function causeOf(w: W, inv: string, h: Hero | undefined): string | undefined {
  // ⭐ R19-05: строку живого героя обогнал администратор (`adminBump`) — копия в памяти проиграла строке (по дизайну, см. `KNOWN`).
  if (h && db.bumped.has(h.charId) && ADMIN_ROW_WINS.has(inv)) return 'ADMIN-row-wins';
  if (w.envelope && ENVELOPE_INV.test(inv)) return 'ENV-outage-over-dead-sec';
  if (w.drainLost && /^(1-|2-revived|3-double|8-node|4-free)/.test(inv)) return 'ENV-drain-db-outage';
  // ⭐ D1 (большой прогон с `DM_FUZZ_OUTAGE_LONG`, сид 221290; так же и на снимке 397980a): и пропажа записанного (`c-durable-item-lost`) — две
  // ноды держат героя (`a-live-two-nodes` того же окна): смерть и штраф его копии на оттаявшей ноде, чью запись отказала проверка владения, и
  // её выход по аренде — модель откатывает «правду» героя к строке, которую тем временем вела другая нода. Вещи этого окна (`1-`) — уже здесь.
  if (w.thawSilent && (ENVELOPE_INV.test(inv) || inv === 'c-durable-item-lost')) return 'ENV-thaw-registry-silent';
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

  // a (R18-03): ЗАПИСЬ ПО СТРОКЕ БАЗЫ — ТОЛЬКО НОДОЙ, ЧТО ДЕРЖИТ ГЕРОЯ. Действие над свежей строкой (штраф брошенного забега, снятие забега) ложится
  // поверх любой версии — и после паузы машины нода хоронила героя, который уже играл тот же забег на другой ноде.
  for (const x of db.writes) {
    if (x.ok && x.byRow && x.node && x.owner && x.owner !== x.node) {
      violate(w, 'a-stored-foreign-write', `${x.charId}: ${x.node} записала действие по строке базы (${x.reason}), а героя держит ${x.owner}; операция ${op ? fmt(op) : 'эпилог'}`, heroBy(w, x.charId));
    }
  }

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
  // ⭐ Перепрогон R20 (как R15-02 фаззера одной ноды): и копия сессии, чья транзакция «сейв + сундук» ещё в пути (сейв на удержании, R1-05) —
  // её запись ждёт свод (K2), а медленная пачка свода (`ledgerSlow`) держит её секунды. Действие уже в памяти, а сундук базы — ещё до него.
  // Решит запись: ляжет — с сундуком своей записи, нет — откат к «до». Дюп, переживший её, увидит следующая проверка (удержание снято) и
  // `1-dup-item-db` в конце. Тело в бою (`lingering`) держит сейв иначе — оно не в `clients`.
  for (const room of allRooms(w)) {
    for (const pid of room.clients.keys()) {
      const p = room.session.saveHeld.has(pid) ? room.session.world.players[pid] : undefined;
      if (p) pendingChars.add(p.save.charId);
    }
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
  // последним местом вещи числилась сумка выбросившего. ⭐ Перепрогон Z4: и подъём снятой комнаты, ещё не кончившийся (`carryRoom`: запись ждёт
  // свод в комнате, процесс жив), — место вещи, пока не кончился: легла запись — вещь в строке поднявшего, нет — сток.
  const carried = (uid: string): boolean => {
    const room = w.carryRoom.get(uid);
    const inc = room && incOfRoom(w, room);
    return !!room && !!inc && !inc.dead && [...(room.carrying ?? [])].some((d) => d.item?.uid === uid);
  };
  for (const uid of [...w.carryGone]) {
    const ls = where.get(uid);
    if (ls?.some((l) => l.startsWith('ground:'))) continue;
    if (!ls && ([...db.rows.values()].some((r) => r.json.includes(uid)) || carried(uid))) continue;
    w.carryGone.delete(uid);
    w.carryRoom.delete(uid);
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
  // ⭐ Перепрогон Z2 (сид 51100587): штраф лёг В СТРОКУ (не копией-правдой), а правда героя — копия в памяти, что ещё держит взятое им (проигравшая
  // копия ждёт дописки): вещь уйдёт, когда копию снимут, — стоком этого штрафа, а не пропажей.
  for (const pn of took) {
    if (truth.get(pn.charId) === pn.save) continue;
    for (const u of pn.removed) if (where.get(u)?.includes(`hero:${pn.charId}`)) w.sinkLater.set(u, pn.charId);
  }
  const sinkLater = (uid: string, loc: string): boolean => loc.startsWith('hero:') && w.sinkLater.get(uid) === loc.slice(5);
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
      if (removedNow.has(uid) || w.sold.has(uid) || sinkLater(uid, loc)) continue;   // взято легшим стоком (в этой операции или в строку раньше) — сток (ниже)
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
      // ⭐ R19-05: вещь вернула строка героя, которого обогнал администратор (штраф его памяти строка не видела), — корень у него, где бы вещь ни была.
      const sinker = w.heroes.find((x) => x.charId === w.sunkBy.get(uid));
      // ⭐ D1 (большой прогон, сид 130083): и строка, откуда вещь вернулась, — у обогнанного: его копия проиграла, выброшенное ею снято с земли
      // (`forfeitHeld`: вещь — в строке), а вернувшийся («Продолжить») принёс её из строки и выбросил снова — сток «ушло с земли» тут ни при чём.
      const rowOwner = w.heroes.find((x) => db.bumped.has(x.charId) && !!db.rows.get(x.charId)?.json.includes(uid));
      violate(w, '1-sunk-item-back', `вещь ${uid}, взятая стоком (штраф/продажа/земля ушедшего этажа), снова в игре: ${ls.join(', ')}`, sinker && db.bumped.has(sinker.charId) ? sinker : rowOwner ?? holder);
    }
  }
  // Поднимаемое с ушедшей земли (`carryGone`) решает конец записи поднимающего (выше), а не «последний раз на земле» (⭐ Z4, как у фаззера одной ноды).
  for (const [uid, loc] of [...w.lastLoc]) {
    if (where.has(uid) || w.carryGone.has(uid)) continue;
    if (loc.startsWith('ground:') || removedNow.has(uid) || w.sold.has(uid) || sinkLater(uid, loc)) { w.sinks.add(uid); w.lastLoc.delete(uid); w.sinkLater.delete(uid); }
  }
  w.sold.clear();
  for (const uid of trackedUid) w.lastLoc.set(uid, where.get(uid)![0]!);

  const perHero = new Map<string, Penalty[]>();
  for (const pn of took) { let a = perHero.get(pn.charId); if (!a) perHero.set(pn.charId, (a = [])); a.push(pn); }
  for (const [charId, ps] of perHero) {
    const h = w.heroes.find((x) => x.charId === charId);
    if (!h) continue;
    const st = pre.get(charId) ?? { kind: 'off' };
    // ⭐ Перепрогон R20: «Завершить» в силе и когда его соединение уже закрыто, а кадр ещё исполняется (или кончился за эту операцию): медленная
    // база держит выселение и штраф секундами, а закрытая вкладка начатого не отменяет.
    const asked = (t: 'join' | 'abandon'): boolean => w.pending.some((p) => p.charId === charId && p.t === t)
      || (t === 'abandon' && (w.abandonDone.has(charId) || w.nodes.some((i) => !i.dead && i.abandonBusy.has(charId))));
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
      if (p.src === 'abandonStored' && !asked('abandon')) violate(w, '3-unjustified-penalty', `штраф по строке базы без «Завершить»: ${why}`, h);
      if (p.src === 'abandonAsDead') {
        // ⭐ R16-01: забег за штраф бросает только «Завершить»; вход, чей бросок стоил бы штрафа, — отказ `run` (страховка — без штрафа).
        if (!asked('abandon')) violate(w, '3-unjustified-penalty', `«Завершить»-штраф без «Завершить» (вход забег за штраф не бросает — R16-01): ${why}`, h);
        if (st.kind === 'disc' && st.paid && !st.foreign && !revivedInOp(p)) violate(w, '3-double-penalty', `штраф с оплаченной смерти (paid): ${why}`, h);
      }
      if (p.src === 'bury' || p.src === 'buryFled' || p.src === 'stored') {
        // ⭐ Перепрогон R15: вход героя, шедший на начало операции (очередь за медленной записью, поздний ответ реестра), — держание: он дошёл,
        // и похороны его копии за операцию — по правилам, а не «чужие».
        if (st.kind === 'off' && p.src !== 'stored' && !asked('join')) violate(w, '3-unjustified-penalty', `похоронен тот, кого нода не держала: ${why}`, h);
        // ⭐ Перепрогон R15: комната на переходе (продолжение ждало позднего ответа реестра) за операцию дошла до подземелья — не «город».
        if (st.kind === 'live' && st.area !== 'dungeon' && !st.moving) violate(w, '3-safe-penalized', `похоронен стоящий в городе/на арене: ${why}`, h);
        if (st.kind === 'disc' && st.safe) violate(w, '3-safe-penalized', `похоронен тот, чей забег пати увела в город (safe): ${why}`, h);
        if (st.kind === 'disc' && st.paid && p.src !== 'stored' && !revivedInOp(p)) violate(w, '3-double-penalty', `похоронен со штрафом погибший (paid): ${why}`, h);
        if (p.src === 'buryFled' && st.kind === 'disc' && !st.fled && !st.fledDescend && !st.body) violate(w, '3-safe-penalized', `спокойно ушедший (не fled) похоронен уходом пати: ${why}`, h);
      }
    }
    if (counted.length) { h.penaltyEv = Math.max(h.penaltyEv, ...counted.map((p) => p.ev)); h.lastPen = counted.reduce((a, b) => (b.ev > a.ev ? b : a)); h.cap = null; }
  }
  w.penalties.length = 0;
  w.abandonDone.clear();

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
        if (bad.length) violate(w, '4-free-restore', `${h.charId} за ${dt.toFixed(1)} с (${lv!.room.area}, ${lv!.kind}, ${lv!.inc?.node}): ${bad.join('; ')}; операция ${op ? fmt(op) : 'конец'}`, h);
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
      if (d < was) violate(w, '8-progress-regress', `${h.charId}: глубина «${tier}» откатилась ${was} → ${d}`, h);   // ⭐ Z3: с героем — корень `ADMIN-row-wins` находится
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
  // Запись «свод лёг» живёт, пока нода держит ту же строку за сводом и он не должен снова (иначе следующий круг судился бы по старому часу).
  for (const [lk, x] of [...w.owedLanded]) {
    const at = lk.lastIndexOf('@');
    const [key, node] = [lk.slice(0, at), lk.slice(at + 1)];
    const inc = w.nodes.find((i) => i.node === node);
    if (!inc || inc.dead || inc.rm.runsOwed.get(key) !== x.room || inc.ledgerOwed(key)) w.owedLanded.delete(lk);
  }
  if (!w.lateInFlight) {
    for (const [key, l] of w.cluster.runLocks) {
      const at = w.runReleasedAt.get(`${key}@${l.node}@${l.room}`);
      if (at === undefined || l.liveAt <= at) continue;
      const inc = w.nodes.find((i) => i.node === l.node);
      if (!inc || inc.dead || Date.now() < inc.stallUntil || Date.now() < inc.partitionUntil) continue;
      const room = inc.rm.rooms.get(l.room);
      if (room && room.holdsRun(key)) continue;
      // ⭐ Перепрогон R19: строку держит нода за своим недолёгшим сводом (R18-02, `runsOwed` — за той же комнатой, что и строка) — по дизайну, пока
      // свод не ляжет: отказ «Продолжить» соседней ноды ведёт сюда (как у `5-resume-dead-end`). Какая ушедшая комната ноды в строке — всё равно.
      // Свод лёг — строку отпускает ближайший удар (`heldRuns`): до него законно, держание, пережившее дошедший удар, — сирота.
      if (inc.rm.runsOwed.get(key) === l.room) {
        if (inc.ledgerOwed(key)) { tally('b:orphan-ledger-owed'); continue; }
        let landed = w.owedLanded.get(`${key}@${l.node}`);
        if (landed?.room !== l.room) w.owedLanded.set(`${key}@${l.node}`, (landed = { room: l.room, since: Date.now() }));
        if (inc.lastBeatOk <= landed.since) { tally('b:orphan-ledger-landed-beat-pending'); continue; }
      }
      // ⭐ Перепрогон R15: повторный отпуск упал (раздел, сбой реестра) — его повторит ближайший удар ноды (`runsDue`): до него — законно.
      const failed = w.releaseFailedAt.get(`${key}@${l.node}@${l.room}`);
      if (failed !== undefined && inc.lastBeatOk <= failed) { tally('b:orphan-release-retry-pending'); continue; }
      // ⭐ Перепрогон Z4: позднее взятие ушедшей комнаты легло поверх строки держателя той же ноды, а переписать её на держателя (`settleRun`) не
      // дошло — чинит ближайший удар: держатель держит — продление (`touchRuns`: своя строка — за ним), отпустил — снятие (`runsStale`). До него
      // — законно; строка, пережившая дошедший удар, — сирота (зубы `z4stale`).
      const cf = w.claimFailedAt.get(`${key}@${l.node}`);
      if (cf !== undefined && inc.lastBeatOk <= cf) { tally('b:orphan-settle-retry-pending'); continue; }
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
  // 8 (R19-05, как у фаззера одной ноды): комната живого процесса не на тике (пауза грейса, ушла) не держит недолёгший свод без записи в пути или
  // повтора по таймеру — иначе нода продлевала бы строку забега за ушедшей комнатой без конца, а соседняя слала бы «Продолжить» к ней.
  for (const inc of w.nodes) {
    if (!inc || inc.dead) continue;
    for (const room of inc.ledgerOwing() as unknown as RoomIn[]) {
      if (!w.born.has(room) || w.ticking.has(room) || room.ledgerRetry != null || room.ledgerInflight > 0) continue;
      violate(w, '8-ledger-stranded', `комната ${room.code}/${inc.node} (${room.area}${inc.rm.rooms.get(room.code) === room ? ', на паузе' : ', ушла'}) должна базе свод забега, а записи в пути и повтора нет; операция ${op ? fmt(op) : 'эпилог'}`);
    }
  }

  // 5: кадр лобби без ответа. ⭐ Перепрогон R16: кадр к ноде, чья машина на паузе (`suspend`), ждёт её конца — процесс не отвечает ничего;
  // проснувшаяся уходит без записи, и её сокеты закрыты (а ожившая в самопроверке закрывает лобби сама, `thaw`). ⭐ Перепрогон R20: срок длиннее
  // на медленные пачки свода ноды за время ожидания (`slowSpans`): вход дописывает недолёгший свод (R18-02, до трёх кругов), и запись героя
  // ждёт свод (K2) — это ожидание базы, а не зависание; зависший кадр переживёт и их.
  for (const p of [...w.pending]) {
    const want = p.t === 'join' ? ['joined', 'error'] : p.t === 'runStatus' ? ['runStatus', 'error'] : ['abandoned', 'error'];
    if (p.conn.since(p.idx).some((f) => lobbyAnswer(f, want))) { w.pending.splice(w.pending.indexOf(p), 1); continue; }
    if (!p.conn.open) { w.pending.splice(w.pending.indexOf(p), 1); continue; }
    if (p.conn.inc?.frozenAt) continue;
    const slowMs = db.slowSpans.filter((x) => x.inc === p.conn.inc && x.to > p.at && x.from < now)
      .reduce((t, x) => t + Math.min(x.to, now) - Math.max(x.from, p.at), 0);
    if (now - p.at > 40_000 + slowMs) { violate(w, '5-lobby-unanswered', `кадр «${p.t}» (операция ${p.op}, ${p.conn.inc?.node}) без ответа ${((now - p.at) / 1000).toFixed(0)} с`); w.pending.splice(w.pending.indexOf(p), 1); }
  }
}
const heroBy = (w: W, charId: unknown): Hero | undefined => w.heroes.find((x) => x.charId === charId);

const stats = new Map<string, number>();
const tally = (k: string): void => { stats.set(k, (stats.get(k) ?? 0) + 1); };

function noteFrame(w: W, c: FakeConn, f: ServerFrame): void {
  if (c.run !== db.run || c.inc?.dead) return;
  if (f.t === 'joined') {
    c.roomCode = f.roomCode;
    // ⭐ R22-09: код с чужой буквой — ошибка самого прогона (имя ноды не того процесса), а не состояние игры: провал, а не счётчик.
    if (c.inc && f.roomCode[0] !== letterOf(c.inc.node)) violate(w, 'harness:letter-mismatch', `нода ${c.inc.node} выдала код ${f.roomCode} с буквой ${f.roomCode[0]} (её буква — ${letterOf(c.inc.node)})`);
  }
  // ⭐ D1: модель прав «Соло» — подсказка `solo` герою в его комнате даёт право; прошедшее голосование комнаты его снимает (пати пошла вместе).
  if (c.hero !== undefined && c.roomCode && c.inc) {
    const room = c.inc.rm.rooms.get(c.roomCode);
    if (room && f.t === 'error' && f.code === 'vote' && f.solo === true) {
      let set = w.soloHints.get(room);
      if (!set) w.soloHints.set(room, (set = new Set()));
      set.add(w.heroes[c.hero]!.charId);
    }
    if (room && f.t === 'voteEnd' && f.passed) w.soloHints.delete(room);
  }
  // 5 (R16 C-09): обещание экрана входа — в миг ответа статуса: что сказано (`dead`), жива ли сессия (на любой ноде) и есть ли забег у копии,
  // которую бросит «Завершить» этой ноды (её грейс-копия, нет её — строка базы; как решает сам кадр `abandon`).
  if (f.t === 'runStatus' && w.asked?.conn === c && !w.asked.st && c.inc) {
    const charId = w.asked.charId;
    const grace = c.inc.rm.graceByChar.get(charId);
    const hadRun = grace ? !!grace.disconnected.get(charId)?.save.run : !!rowSave(charId)?.run;
    w.asked.st = { dead: f.dead === true, hasRun: f.hasRun, live: alive(w).some((i) => i.rm.live.has(charId)), hadRun, grace: !!grace };
  }
  if (f.t === 'cmdResult') {
    const i = w.selling.findIndex((s) => s.conn === c && s.id === f.id);
    if (i >= 0) { if (f.ok) w.sold.add(w.selling[i]!.uid); w.selling.splice(i, 1); }
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
        // ⭐ R18-02: нода держит забег за своим недолёгшим сводом (`runsOwed`: комната ушла, записи узлов ждут повтора в базу) — отказ ведёт к ней,
        // и её вход сам дописывает свод или отвечает «занято»: временный, пока свод не ляжет.
        else if (inc && !inc.dead && inc.ledgerOwed(key!)) { ok = true; tally('d:resume-refused-ledger-owed'); }
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
  ws.solo = frame.t === 'join' && frame.solo === true;
  if (!conn) { ws.inc = inc; process.env.DM_NODE_ID = inc.node; inProc(inc, () => inc.rm.handleConnection(ws)); w.lobbies.push(ws); }
  const t = frame.t as 'join' | 'runStatus' | 'abandon';
  w.pending.push({ conn: ws, charId: h.charId, t, idx: ws.frames.length, at: Date.now(), op: w.op, solo: frame.t === 'join' && frame.solo === true });
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
/**
 * ⭐ Перепрогон Z3: ответ на кадр лобби — кадр из `want` (`joined`/`runStatus`/`abandoned` или `error`), но не отказ КОМАНДЫ комнаты
 * (`error{cmd}`): подъём или сделка, ждавшие базу, отвечают на тот же сокет, когда герой уже вышел в лобби (сид 61330229), — это ответ
 * комнаты, а не входа.
 */
const lobbyAnswer = (f: ServerFrame, want: readonly string[]): boolean => want.includes(f.t) && !(f.t === 'error' && f.code === 'cmd');
async function pause(w: W): Promise<void> { await stepAll(w, 48); }

/** ⭐ D1: ответ на кадр входа — первый `joined`/`error` сокета после отправки (`tap`); ход поддельного времени — если ждёт реестр (поздний ответ). */
async function answerOf(w: W, got: ServerFrame[], ws: FakeConn): Promise<ServerFrame | undefined> {
  for (let i = 0; i < 40; i++) {
    const f = got.find((x) => lobbyAnswer(x, ['joined', 'error']));
    if (f || !ws.open || cur !== w) return f;
    await drain(2);
    if (i % 10 === 9) await vi.advanceTimersByTimeAsync(500);
  }
  return undefined;
}
/**
 * ⭐ D1: «Продолжить» / «Продолжить без пати» веб-клиента: из игры — `leave`, статус и вход тем же сокетом (та же нода); вне игры — через
 * гейтвей. Отказ `run` с кодом держателя — к его ноде по коду и там тот же вход (`EntryFlow.runHeld`). Ответ — последний (или `undefined`).
 */
async function toRun(w: W, h: Hero, solo: boolean): Promise<ServerFrame | undefined> {
  const frame = { t: 'join', resume: true, ...(solo ? { solo: true } : {}) };
  const go = async (inc: Inc, conn?: FakeConn): Promise<ServerFrame | undefined> => {
    const got: ServerFrame[] = [];
    const tap = (f: ServerFrame): void => { got.push(f); };
    if (conn) {
      conn.tap = tap;
      send(w, h, { t: 'leave' });
      lobby(w, h, { t: 'runStatus' }, inc, conn);
      got.length = 0;   // кадры комнаты до выхода и ответ на статус — не ответ на вход
    }
    const ws = lobby(w, h, frame, inc, conn);
    ws.tap = tap;
    h.conn = ws;
    try { return await answerOf(w, got, ws); } finally { ws.tap = undefined; }
  };
  const at = liveAt(w, h);
  let f: ServerFrame | undefined;
  if (at) f = await go(at.inc, at.ws);
  else {
    const inc = routeOf(w, h, undefined, 'gw');
    if (!inc) return undefined;
    f = await go(inc);
  }
  if (f?.t === 'error' && f.code === 'run' && f.roomCode) {
    const inc = routeOf(w, h, f.roomCode, 'gw');
    if (inc) f = await go(inc);
  }
  return f;
}
/** ⭐ D1: забег героя по правде — ключ свода, погиб ли в нём (K1). */
function runOfHero(w: W, h: Hero): { key: string; dead: boolean } | null {
  const t = truthOf(w, h, locate(w));
  const r = t?.save.run;
  if (!r?.config) return null;
  const info = alive(w).map((i) => i.rm.graceByChar.get(h.charId)?.disconnected.get(h.charId)).find((x) => x);
  return { key: runLedgerKey(r.config), dead: r.deadAt !== undefined || !!info?.paid };
}
/** ⭐ D1: кластер здоров — ноды живы, без пауз машины, сливов, простоев и разделов, без сбоев реестра и базы в очереди (живость — не про сбои). */
function clusterHealthy(w: W): boolean {
  const now = Date.now();
  return w.nodes.every((i) => !i.dead && !i.frozenAt && !i.draining && i.stallUntil <= now && i.partitionUntil <= now && !i.crashAt)
    && !w.regFaults.length && !db.faults.length && db.ledgerDownUntil <= w.op && !db.ledgerSlow && !w.lateInFlight;
}
/**
 * ⭐ D1 ЖИВОСТЬ (как у фаззера одной ноды, `coopLifecycle.fuzz.test.ts`): герой хочет продолжить свой забег — клиент по правилу общего забега:
 * вне игры «Продолжить» через гейтвей (отказ `run` с кодом — к ноде держателя); в городе спуск (открыт чужой спуск — «за»), на арене «в город»;
 * голос не прошёл — «Продолжить без пати»; отказ `run` в игре — «Продолжить». Напарники отвечают `partner`. За `WANT_STEPS` шагов — в
 * подземелье своего забега (`5-run-stuck`), без штрафа за брошенный (`5-run-paid`); исключения — забег кончился, погиб в нём, пати без места.
 */
async function wantRun(w: W, h: Hero, partner: Partner): Promise<void> {
  const run = runOfHero(w, h);
  if (!run || run.dead) { tally(run ? 'want:dead' : 'want:none'); return; }
  // Он уже нажал «Завершить» (кадр в очереди или исполняется — сервер доводит начатое): продолжать он не хочет, и штраф — по его просьбе.
  if (w.pending.some((p) => p.charId === h.charId && p.t === 'abandon') || alive(w).some((i) => i.abandonBusy.has(h.charId))) { tally('want:abandoning'); return; }
  let solo = false;
  const paid0 = w.penalties.filter((p) => p.charId === h.charId && PAID_SRC.has(p.src)).length;
  const trace: string[] = [];
  const done = (): boolean => {
    const at = liveAt(w, h);
    return !!at && at.room.area === 'dungeon' && !!at.room.runConfig && runLedgerKey(at.room.runConfig) === run.key;
  };
  const paidCheck = (): void => {
    const paid = w.penalties.filter((p) => p.charId === h.charId && PAID_SRC.has(p.src));
    if (paid.length > paid0) violate(w, '5-run-paid', `${h.charId}: хотел продолжить забег ${run.key} — и заплатил за брошенный (${paid.slice(paid0).map((p) => p.src).join(', ')}); путь: ${trace.join(' → ')}`, h);
  };
  const retry = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(20_000); kickRetry(w); await drain(4); };
  for (let step = 0; step < WANT_STEPS; step++) {
    if (done()) { tally(`want:ok:${solo ? 'solo' : step ? 'party' : 'there'}`); paidCheck(); return; }
    const now = runOfHero(w, h);
    if (!now || now.key !== run.key || now.dead) { tally('want:ended'); paidCheck(); return; }
    const at = liveAt(w, h);
    if (!at) {
      const f = await toRun(w, h, false);
      trace.push(`«Продолжить» → ${f?.t === 'error' ? f.code : f ? 'вошёл' : '—'}`);
      if (f?.t === 'error' && f.code === 'full') { tally('want:full'); paidCheck(); return; }
      if (f?.t !== 'joined') await retry();
      continue;
    }
    if (at.room.area === 'dungeon') { trace.push(`подземелье ${at.room.code} без его забега — ждём`); await stepAll(w, 150); continue; }
    const got: ServerFrame[] = [];
    at.ws.tap = (f) => got.push(f);
    let next: 'solo' | 'resume' | null = null;
    try {
      const room = at.room;
      await pause(w);
      const at2 = liveAt(w, h);
      if (!at2 || at2.room !== room) continue;
      const v = room.vote;
      // ⭐ R23-01: открыт чужой «в город» на арене — «за» (окно голосования; свой зов — отказ «ответьте на него»), как чужой спуск в городе.
      if (room.area === 'arena' && v?.kind === 'town' && !v.yes.has(at2.pid)) { send(w, h, { t: 'vote', accept: true }); trace.push(`арена ${room.code}: «за» чужой «в город»`); }
      else if (room.area === 'arena') { send(w, h, { t: 'return' }); trace.push(`арена ${room.code}: «в город»`); }
      else if (v && v.kind === 'descend' && !v.yes.has(at2.pid)) { send(w, h, { t: 'vote', accept: true }); trace.push(`город ${room.code}: «за» чужой спуск`); }
      else { send(w, h, { t: 'descend' }); trace.push(`город ${room.code}: спуск`); }
      await drain(4);
      const mates = w.heroes.filter((x) => x !== h && liveAt(w, x)?.room === room);
      if (room.vote && partner !== 'idle') {
        mates.forEach((m, i) => { if (room.vote) send(w, m, { t: 'vote', accept: !(partner === 'no' && i === 0) }); });
        await drain(4);
      }
      if (room.vote && !room.frozen) {
        await vi.advanceTimersByTimeAsync(VOTE_TIMEOUT_MS + 1);
        await drain(4);
        await stepAll(w, 2);
      }
      await drain(4);
      if (got.some((f) => f.t === 'error' && f.code === 'vote' && f.solo === true)) next = 'solo';
      else if (got.some((f) => f.t === 'error' && f.code === 'run')) next = 'resume';
      else { const other = got.filter((f) => f.t === 'error').map((f) => (f as { code: string }).code); if (other.length) trace.push(`отказы ${other.join(',')}`); }
    } finally { at.ws.tap = undefined; }
    if (!next) continue;
    if (next === 'solo') solo = true;
    const f = await toRun(w, h, next === 'solo');
    trace.push(`${next === 'solo' ? '«Продолжить без пати»' : 'отказ run → «Продолжить»'} → ${f?.t === 'error' ? f.code : f ? 'вошёл' : '—'}`);
    if (f?.t === 'error' && f.code === 'full') { tally('want:full'); paidCheck(); return; }
    if (f?.t !== 'joined') await retry();
  }
  if (done()) { tally(`want:ok:${solo ? 'solo' : 'party'}`); paidCheck(); return; }
  const at = liveAt(w, h);
  violate(w, '5-run-stuck', `${h.charId} хочет продолжить забег ${run.key} (напарники: ${partner}) — за ${WANT_STEPS} шагов не в его подземелье (сейчас: ${at ? `${at.room.code}/${at.room.area}@${at.inc.node}` : 'вне игры'}); путь: ${trace.join(' → ')}; ${w.cluster.dump()}; операция ${w.opRef ? fmt(w.opRef) : 'эпилог'}`, h);
  paidCheck();
}

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
      // ⭐ Перепрогон Z2 (как R15-02 фаззера одной ноды): продано — по ответу, когда бы он ни пришёл (`noteFrame`): кадр ждёт в очереди
      // соединения за записью в пути (раздел с базой, медленная база).
      w.selling.push({ conn: at.ws, id: cmd(w, h, { cmd: 'sell', uid, minGold: 0 }), uid });
      await drain();
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
    case 'fault': {
      // ⭐ R18-02: свод не пишется до операции `w.op + ops` — сбой базы (счёт `consumed`: правила, смягчённые при сбоях, видят его).
      if (op.f === 'ledgerDown') { db.ledgerDownUntil = Math.max(db.ledgerDownUntil, w.op + (op.ops ?? 3)); db.consumed++; return; }
      // ⭐ R20-01: следующая пачка свода висит в базе `ms` (база медленная, моргнула при деплое), потом ложится или падает (`fail`).
      if (op.f === 'ledgerSlow') { db.ledgerSlow = { ms: op.ms ?? 5_000, fail: !!op.fail }; db.consumed++; return; }
      db.faults.push({ kind: op.f, ...(op.h !== null ? { charId: heroOf(w, op.h).charId } : {}) });
      return;
    }
    case 'retry': kickRetry(w); await drain(4); return;
    case 'obstruct': {
      // ⭐ R19-04: держатель в городе действует (кадр с движением; следом — стоя), на голосование другого — «нет» или молчит.
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || at.room.area !== 'town') return;
      send(w, h, { t: 'input', input: { ...idle(), move: { x: 1, y: 0 } } });
      send(w, h, { t: 'input', input: idle() });
      const v = at.room.vote;
      if (op.no && v && v.by !== at.pid) send(w, h, { t: 'vote', accept: false });
      await drain();
      return;
    }
    case 'solo': await toRun(w, heroOf(w, op.h), true); return;   // ⭐ D1: «Продолжить без пати»
    case 'want': await wantRun(w, heroOf(w, op.h), op.partner); return;
    case 'adminBump': {
      // ⭐ R19-05: автосейв героя в пути — строку обгоняет администратор, а в комнате тем временем открывают сундук узла.
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || at.room.area !== 'dungeon') return;
      const { room, pid, inc } = at;
      db.bump = {
        charId: h.charId,
        during: () => {
          const p = room.session.world.players[pid];
          const chest = room.session.world.chests.find((c) => !c.opened);
          if (!p?.alive || !chest || !room.clients.has(pid)) return;
          place(p, chest.pos);
          try { room.openChest(pid, chest.id); } catch (e) { violate(w, '6-cmd-threw', `сундук: ${String(e)}`); }
        },
      };
      process.env.DM_NODE_ID = inc.node;
      void inProc(inc, () => room.persist(pid)).catch(() => undefined);
      await drain(3);
      db.bump = null;
      return;
    }
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
    case 'frozenFrame': {
      // ⭐ R18-03: сокет героя — на ноде, стоящей на паузе машины: кадр ляжет в него и прочтётся, когда процесс оттает (`thaw`).
      const h = heroOf(w, op.h);
      const inc = w.nodes.find((i) => i.frozenAt && !i.dead && i.rm?.live.has(h.charId));
      const ws = inc?.rm.live.get(h.charId) as FakeConn | undefined;
      if (!inc || !ws) return;
      inc.queued.push({ ws, frame: op.t === 'return' ? { t: 'return' } : op.t === 'vote' ? { t: 'vote', accept: true } : { t: 'leave' } });
      w.events.push(`frozen-frame:${h.charId}:${op.t}@${inc.node}`);
      tally(`r1803:frozen-frame-${op.t}`);
      return;
    }
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
  // ⭐ R18-03: СТОЯЛИ ВСЕ ЧАСЫ — сомнения в аренде нет, удар по расписанию не раньше чем через `BEAT_MS`: процесс читает кадры, пришедшие в его
  // сокеты за паузу, ДО удара (и до сверки возраста удара с реестром, R16-02). Раньше это окно было вне модели («запись копии ложится только
  // поверх строки той же версии») — а запись по строке базы (`settleStored`, `abandonStored`) ложится поверх свежей строки: уход пати с этажа
  // хоронил героя, который уже играл тот же забег на другой ноде. Только кадры: часы комнат в модели — поддельные часы теста, паузой не
  // стоявшие (автосейв, сроки), — их шаг до удара был бы не про эту паузу. Пауза посреди удара (R17-01) — сперва сам удар (`resume`).
  if (!inc.frozenWall && !inc.resumeBeat) {
    for (const q of inc.queued.splice(0)) {
      inProc(inc, () => { try { q.ws.push(q.frame); } catch (e) { violate(w, '6-push-threw', `кадр ${String(q.frame.t)}: ${String(e)}`); } });
      await drain(3);
    }
    if (inc.dead) return;
  }
  inc.queued.length = 0;
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
    inc.writtenOff = false;   // реестру не достучаться — играет дальше своими копиями до конца аренды (корень `ENV-thaw-registry-silent`)
  }
  // ⭐ Перепрогон R18 (модель): иначе ОЖИЛ — только если реестр принял его удар (`beat`; самопроверка). Удар, упавший сбоем реестра (ответ
  // потерян), ноду не оживляет: для реестра она мертва, следующий удар её снимет, а записи до него отказаны проверкой владения (R18-03) —
  // ИНЦИДЕНТ списанного процесса, не пропажа копии.
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
      db.writer = inc.node;   // R18-03: запись ложится синхронно в вызове — кто её писал
      const call = fn(...a);
      db.writer = undefined;
      const r = await call;
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
      const p = call('claimRun', traced(`claimRun ${k.slice(-6)} ${r}`, () => {
        const held = FUZZ_SELFTEST === 'runlock' ? (c.runLocks.set(k, { node: n, room: r, liveAt: Date.now() }), null) : c.claimRun(k, n, r);
        if (held) w.claimSaw.set(`${k}@${held}`, Date.now());
        // ⭐ Перепрогон R16: комната взяла забег снова после своего отпуска — отпуск больше не судит её продления (`releasedSeq`).
        else if ((w.releasedSeq.get(`${k}@${n}@${r}`) ?? Infinity) < sent) { w.runReleasedAt.delete(`${k}@${n}@${r}`); w.releasedSeq.delete(`${k}@${n}@${r}`); }
        return held;
      }));
      p.catch(() => { if (cur === w) w.claimFailedAt.set(`${k}@${n}`, Date.now()); });   // ⭐ перепрогон Z4
      return p;
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
    // ⭐ Перепрогон R18: земля процесса, которого мир списал (пауза машины, `forget`; оттаяв, он до удара читает кадры, пришедшие за паузу), — не
    // мир: правда его героев откатилась к строкам базы ещё на паузе, и уход его этажа ничего не берёт в сток (записи списанного отказаны, R18-03).
    if (!mine(room) || inc.writtenOff) return;
    // ⭐ K3: поднимаемое (запись поднимающего в пути) с землёй не уходит — легла запись, вещь в его сумке; не легла — пропажа проверкой (сток).
    // ⭐ Перепрогон Z4: и чей это подъём (`carryRoom`) — снятая комната из проверки выпадает, а её запись ещё в пути.
    for (const d of room.session.world.drops) {
      if (d.kind !== 'item' || !d.item) continue;
      if (room.carrying?.has(d)) { w.carryGone.add(d.item.uid); w.carryRoom.set(d.item.uid, room); } else w.sinks.add(d.item.uid);
    }
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
  // Зубы Z3 (`teeth.z3lost`): ответ взятия «держит другая нода» судится, как до правки, — ИНЦИДЕНТ и о комнате, что забег уже отпустила.
  wrap(rmProto, 'runLost', (self, a, call) => {
    if (!teeth.z3lost || (self as { runHolder(key: string): unknown }).runHolder(a[0] as string)) return call();
    console.error(`[room] ИНЦИДЕНТ: забег ${String(a[0])} кластер числит за комнатой ${String(a[1])} другой ноды (зубы z3lost)`);
    return undefined;
  });
  // Зубы Z4 (`teeth.z4stale`): строку за ушедшей комнатой, которую не удалось вернуть держателю, удар не помнит (как до правки `runsStale`).
  wrap(rmProto, 'heldRuns', (self, _a, call) => {
    if (teeth.z4stale) (self as { runsStale: Map<string, string> }).runsStale.clear();
    return call();
  });
  // 6: кадр, погашенный отказом базы или реестра, заказанным фаззером, — штатный «занято» (R3-14), а не ошибка кода.
  // ⭐ Перепрогон R20: и «Завершить» — в силе, пока его кадр исполняется (`abandonBusy`): соединение могло закрыться раньше.
  wrap(rmProto, 'onFrame', (_self, a, call) => {
    const f = a[1] as { t?: unknown; charId?: unknown } | undefined;
    const busy = cur === w && f?.t === 'abandon' && typeof f.charId === 'string' ? f.charId : undefined;
    if (busy) inc.abandonBusy.set(busy, (inc.abandonBusy.get(busy) ?? 0) + 1);
    return (call() as Promise<unknown>).catch((e: unknown) => {
      if (cur === w && isInjected(e)) w.expectFrame++;
      throw e;
    }).finally(() => {
      if (!busy) return;
      const n = (inc.abandonBusy.get(busy) ?? 1) - 1;
      if (n > 0) inc.abandonBusy.set(busy, n); else inc.abandonBusy.delete(busy);
      if (cur === w && !inc.dead) w.abandonDone.add(busy);
    });
  });
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
  // ⭐ D1 (модель прав «Соло», как у фаззера одной ноды): возвращение героя в комнату, её вход в подземелье и отпуск забега право снимают.
  wrap(proto, 'attach', (self, a, call) => {
    const room = self as RoomIn;
    const save = a[2] as SaveState;
    const r = call();
    if (mine(room)) w.soloHints.get(room)?.delete(save.charId);
    return r;
  });
  after('takeRun', (room) => { if (mine(room)) w.soloHints.delete(room); });
  after('dropRun', (room) => { if (mine(room)) w.soloHints.delete(room); });
  // 5 (D1, правило 1): «Продолжить» не собирает забег в новой комнате, пока его держит другая комната ЭТОЙ ноды (держание по кластеру — строка
  // `run_locks`: соседняя нода отказывает `run` с кодом, это стережёт `5-resume-dead-end`).
  wrap(proto, 'addPlayerResumeRun', (self, a, call) => {
    const room = self as RoomIn;
    const save = a[2] as SaveState;
    if (mine(room) && save.run?.config) {
      const key = runLedgerKey(save.run.config);
      const other = [...inc.rm.rooms.values()].find((r) => r !== room && w.born.has(r) && r.holdsRun(key));
      if (other) violate(w, '5-resume-split', `${save.charId}: «Продолжить» на ${inc.node} собрал забег ${key} в новой комнате ${room.code}, а его держит ${other.code} (${other.area}, подключено ${other.clients.size}); операция ${opText()}`, heroBy(w, save.charId));
    }
    return call();
  });
  // 5 (D1, правило 3): держатель отпускает забег только заслуженному «Соло» (подсказка `solo` в этой комнате) на «Продолжить без пати», или
  // участнику, которому нет места (`5-solo-unearned`, `5-resume-split`). Зубы `d1solo` — не отпускает никогда.
  wrap(proto, 'handRun', (self, a, call) => {
    const room = self as RoomIn;
    const [key, charId] = a as [string, string];
    const full = room.seatsTaken(charId) >= 4;
    const hinted = !!w.soloHints.get(room)?.has(charId);
    const asked = w.pending.some((p) => p.charId === charId && p.t === 'join' && p.solo);
    const r = teeth.d1solo ? false : call();
    if (r === true && mine(room)) {
      if (!full && !hinted) violate(w, '5-solo-unearned', `${charId}: комната ${room.code}/${inc.node} (${room.area}) отпустила забег ${key} без права «Соло»; операция ${opText()}`, heroBy(w, charId));
      else if (!full && !asked) {
        const joins = w.pending.filter((p) => p.charId === charId && p.t === 'join').map((p) => `оп.${p.op}${p.solo ? ' соло' : ''}${p.conn.open ? '' : ' закрыт'}`);
        violate(w, '5-resume-split', `${charId}: комната ${room.code}/${inc.node} (${room.area}) отпустила забег ${key} простому «Продолжить» (входы в пути: ${joins.join(', ') || 'нет'}); операция ${opText()}`, heroBy(w, charId));
      }
      w.soloHints.get(room)?.delete(charId);
    }
    return r;
  });
  // 5 (⭐ R22-05): голос, за который все подключённые, не проваливается — ждёт транзакцию сундука (R1-05), а не отказан (`5-vote-consented-failed`).
  wrap(proto, 'failVote', (self, a, call) => {
    const room = self as RoomIn;
    const v = a[0] as { yes: Set<string>; kind: string };
    if (mine(room) && room.clients.size > 0 && v.yes.size >= room.clients.size) {
      violate(w, '5-vote-consented-failed', `комната ${room.code}/${inc.node} (${room.area}): голос «${v.kind}» провален, хотя «за» все подключённые (${v.yes.size}/${room.clients.size}); операция ${opText()}`);
    }
    return call();
  });
  // Зубы D1 `d1timeout`: голосование вне подземелья без срока.
  wrap(proto, 'voteExpired', (_self, _a, call) => (teeth.d1timeout ? undefined : call()));
  // Зубы R18-02 (`teeth.r1802`): недолёгший свод комнат процесса не виден ни входу, ни отпуску забега (`owes` — ложь).
  wrap(proto, 'owes', (_self, _a, call) => (teeth.r1802 ? false : call()));
  // Зубы R20-01 (`teeth.r2001`): учёт недолёгшего пачки в пути не видит, как до правки — снятая комната с пачкой в пути выпадает из слива.
  wrap(proto, 'noteOwing', (self, _a, call) => {
    if (!teeth.r2001) return call();
    const room = self as { ledgerInflight: number };
    const n = room.ledgerInflight;
    room.ledgerInflight = 0;
    try { return call(); } finally { room.ledgerInflight = n; }
  });
  // Зубы R19-05 (`teeth.r1905`): пауза и уход комнаты свод не дописывают.
  let teardown = false;
  for (const name of ['stop', 'enterGrace']) {
    wrap(proto, name, (_self, _a, call) => {
      teardown = teeth.r1905;
      try { return call(); } finally { teardown = false; }
    });
  }
  wrap(proto, 'flushLedger', (self, _a, call) => (teardown ? (self as { ledgerWriting: Promise<void> }).ledgerWriting : call()));
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
    node, n, gen: ++w.incSeq, dead: false, diedAt: 0, why: '', draining: false, stopped: false, ledgerInFlight: 0, ledgerIncident: false, abandonBusy: new Map(),
    stallUntil: 0, partitionUntil: prev?.partitionUntil ?? 0, lastBeatOk: Date.now(), crashAt: 0, ever: new Set(),
    frozenAt: 0, frozenUntil: 0, frozenLeft: 0, frozenWall: true, held: new Map(), sentAt: Date.now(), thawed: false, writtenOff: false, queued: [],
    rm: null as unknown as RmIn, hooks: null as unknown as ClusterHooksIn, reg: null as unknown as RegIn, runLedgerKey: () => '', ledgerOwed: () => false,
    ledgerOwing: () => [], lease: null as unknown as typeof import('../cluster/lease.js'),
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
  inc.ledgerOwed = (key) => roomMod.runLedgerOwed(key);
  inc.ledgerOwing = () => roomMod.ledgerOwingRooms();
  runLedgerKey = roomMod.runLedgerKey;
  VOTE_TIMEOUT_MS = roomMod.VOTE_TIMEOUT_MS;
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
    // ⭐ R18-03: запись по строке базы — только пока героя держит эта нода (`index.ts`). Самопроверка `r1803` — по версии, как до правки.
    roomMod.setRowOwner(teeth.r1803 ? null : { node, leased: true });
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
  inc.writtenOff = false;   // ⭐ R16-02: удар принят — процесс снова жив для мира (после паузы — только в самопроверке: иначе выше `a-…`), его копии — снова его
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
      // 8 (⭐ R20-01): СЛИВ ВЫШЕЛ — СВОД ПРОЦЕССА В БАЗЕ ИЛИ ИНЦИДЕНТ. Пачка свода ещё в пути (снятая комната: финал или вайп отправил свод, пати вышла
      // из города), а слив молчит — записи узлов уйдут с процессом без ИНЦИДЕНТА и счётчика, и продолжение забега соберёт их узлы свежими.
      if (cur === w && !inc.dead && inc.ledgerInFlight > 0 && !inc.ledgerIncident) {
        violate(w, '8-drain-ledger-silent', `слив ${inc.node} вышел, а пачка свода процесса ещё в базе (${inc.ledgerInFlight}) — ни записи, ни ИНЦИДЕНТА; операция ${w.opRef ? fmt(w.opRef) : 'эпилог'}`);
      }
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
  // ⭐ R18-02: свод забега не пишется (строки героев — пишутся) несколько операций — из своего потока (`ledgerF`).
  if (FUZZ_FAULTS && (dun.length || town.length) && w.ledgerF.chance(0.03)) return { k: 'fault', f: 'ledgerDown', h: null, ops: 2 + w.ledgerF.int(8) };
  // ⭐ R20-01: следующая пачка свода висит в базе (и ложится или падает) — из своего потока (`slowF`): слив и падение ноды ложатся на неё.
  if (FUZZ_FAULTS && (dun.length || town.length) && w.slowF.chance(0.03)) {
    return { k: 'fault', f: 'ledgerSlow', h: null, ms: w.slowF.pick([1_500, 6_000, 20_000]), ...(w.slowF.chance(0.5) ? { fail: true } : {}) };
  }
  // ⭐ R18-03: кадр героя, чей сокет на ноде, стоящей на паузе с остановленными часами, — из своего потока (`thawF`): прочтётся до её удара.
  const stuck = hs.filter((h) => w.nodes.some((i) => i.frozenAt && !i.dead && !i.frozenWall && i.rm?.live.has(h.charId)));
  if (stuck.length && w.thawF.chance(0.35)) return { k: 'frozenFrame', h: w.thawF.pick(stuck).i, t: w.thawF.pick(['return', 'return', 'vote', 'leave'] as const) };
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
  // ⭐ R19-04: держатель в городе действует и отвечает «нет» (или молчит) — из своего потока (`obstruct`).
  const crowd = town.filter((h) => liveAt(w, h)!.room.clients.size > 1);
  if (crowd.length && w.obstruct.chance(0.1)) return { k: 'obstruct', h: w.obstruct.pick(crowd).i, no: w.obstruct.chance(0.5) };
  // ⭐ D1: «Продолжить без пати» — из своего потока (`soloF`): чаще тем, у кого право (подсказка в его комнате), реже — без него.
  const hinted = live.filter((h) => w.soloHints.get(liveAt(w, h)!.room)?.has(h.charId));
  if (hinted.length && w.soloF.chance(0.5)) return { k: 'solo', h: w.soloF.pick(hinted).i };
  if (w.soloF.chance(0.01)) return { k: 'solo', h: w.soloF.pick(hs).i };
  // ⭐ D1 (живость): герой с забегом хочет его продолжить — из своего потока (`want`); только при здоровом кластере.
  const runners = clusterHealthy(w) ? hs.filter((h) => runOfHero(w, h)) : [];
  if (runners.length && w.want.chance(0.06)) return { k: 'want', h: w.want.pick(runners).i, partner: w.want.pick(['yes', 'no', 'idle'] as const) };
  // ⭐ R19-05: администратор обгоняет запись героя в подземелье — из своего потока (`bump`).
  if (FUZZ_ADMIN && dun.length && w.bump.chance(0.02)) return { k: 'adminBump', h: w.bump.pick(dun).i };
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
  // 5 (D1, ЖИВОСТЬ): каждый, у кого забег, его продолжает — кластер починен (сбои сняты, лежащая нода, если осталась, — за окном держания), комнаты
  // живы, напарники отвечают как выпало («нет», молчат, «за»): за `WANT_STEPS` шагов клиента по правилу — в подземелье своего забега (`wantRun`).
  const pr = fuzzRng(mixSeed(w.seed, 0xd1e));
  for (const h of w.heroes) {
    if (!runOfHero(w, h)) continue;
    const partner = pr.pick(['no', 'idle', 'yes'] as const);
    await phase({ k: 'want', h: h.i, partner }, () => wantRun(w, h, partner));
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
  db.ledgerDownUntil = 0; db.ledgerUpAt = 0; db.opNow = 0; db.foreignRefused = 0; db.bump = null; db.bumped.clear(); db.ledgerSlow = null; db.slowUntil.clear();
  db.slowSpans.length = 0;
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
    ask: fuzzRng(mixSeed(seed, 0xc09)), asked: null, lateReg: fuzzRng(mixSeed(seed, 0x1508)), pause: fuzzRng(mixSeed(seed, 0x1602)), midPause: fuzzRng(mixSeed(seed, 0x1701)), thawF: fuzzRng(mixSeed(seed, 0x1803)), ledgerF: fuzzRng(mixSeed(seed, 0x1802)), slowF: fuzzRng(mixSeed(seed, 0x2001)),
    obstruct: fuzzRng(mixSeed(seed, 0x1904)), bump: fuzzRng(mixSeed(seed, 0x1905)), soloF: fuzzRng(mixSeed(seed, 0xd150)), want: fuzzRng(mixSeed(seed, 0xd1a1)), soloHints: new WeakMap(), lateInFlight: 0, runReleasedAt: new Map(), regSeq: 0, releasedSeq: new Map(), releaseFailedAt: new Map(), claimSaw: new Map(), claimFailedAt: new Map(), owedLanded: new Map(), abandonDone: new Set(),
    penaltyCount: new Map(), ticking: new Set(), born: new WeakSet(), lobbies: [], pending: [], violations: [], seen: new Set(),
    penalties: [], sinks: new Set(), carryGone: new Set(), carryRoom: new Map(), lastLoc: new Map(), sunkBy: new Map(), sold: new Set(), selling: [], sinkLater: new Map(), durableSeen: new Set(), fromGround: new Set(), ev: 0, opEv0: 0, recs: new Map(), roomSeen: new WeakMap(), ids: new WeakMap(), idSeq: 0,
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
      w.op = i; w.opRef = op; db.opNow = i;
      if (db.ledgerDownUntil && i === db.ledgerDownUntil) db.ledgerUpAt = Date.now();   // ⭐ Перепрогон R18: свод снова принимается
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
    if (db.opNow < db.ledgerDownUntil) db.ledgerUpAt = Date.now();
    db.ledgerDownUntil = 0;   // ⭐ R18-02: эпилог — база здорова, и свод тоже
    db.ledgerSlow = null;   // ⭐ R20-01: и не медленна
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
  process.env = nodeEnv;   // ⭐ R22-09: имя ноды — у процесса, чей код исполняется
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
    // ⭐ R18-01: смерть тика оплачивается сразу за ним (`chargeDeath` из шага, снятия сессии или `onPlayerDeath`) — это штраф смерти (`death`).
    const src = ['abandonStored', 'endLinger', 'chargeDeath', 'onPlayerDeath', 'settleStored', 'abandonAsDead', 'buryFled', 'finalizeDisconnectedAsDead', 'buryDisconnected']
      .find((n) => stack.includes(n)) ?? '?';
    const map: Record<string, string> = {
      abandonStored: 'abandonStored', endLinger: 'linger', chargeDeath: 'death', onPlayerDeath: 'death', settleStored: 'stored', abandonAsDead: 'abandonAsDead',
      buryFled: 'buryFled', finalizeDisconnectedAsDead: 'bury', buryDisconnected: 'bury', '?': '?',
    };
    const run = save.run?.config ? runLedgerKey(save.run.config) : null;
    const room = map[src] === 'death' || src === 'endLinger' ? allRooms(cur).find((r) => Object.values(r.session.world.players).some((p) => p.save === save)) : undefined;
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
    const st = als.getStore();
    if (st && /ИНЦИДЕНТ: слив не дописал свод/.test(s)) st.ledgerIncident = true;   // R20-01: слив сказал, что свод уходит с процессом
    // b: сердцебиение нашло забег своей комнаты за другой нодой — один забег в двух местах.
    if (/ИНЦИДЕНТ: забеги комнат/.test(s)) violate(cur, 'b-run-lock-lost', s.slice(0, 300));
    else if (/ИНЦИДЕНТ: забег .* кластер числит/.test(s)) violate(cur, 'b-run-lock-lost', s.slice(0, 300));
    else if (/ИНЦИДЕНТ: слив не дописал/.test(s) && (cur.nodes.some((i) => i.draining && !i.dead && Date.now() < i.partitionUntil + DRAIN_LAST_TRY_MS) || drainLedgerDown(cur, s))) {
      // Слив во время раздела с базой: бюджет слива кончился раньше раздела — копии уходят с процессом (так и задумано: ИНЦИДЕНТ, R12-04).
      // ⭐ E2E 28.09 (сид 51245): и раздел, кончившийся меньше чем за круг дописки до конца бюджета, — у слива одна попытка, и её исход
      // (сбой, «неизвестен») проверить уже некогда: после аренды писать нельзя. ⭐ Перепрогон R18: и свод забега, не принимавшийся так же долго.
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
  process.env = realEnv;
  if (nodeIdBefore === undefined) delete process.env.DM_NODE_ID; else process.env.DM_NODE_ID = nodeIdBefore;
});
function onUnhandled(e: unknown): void { if (cur) violate(cur, '6-unhandled-rejection', e instanceof Error ? `${e.message} ${e.stack?.split('\n').slice(1, 3).join(' ')}` : String(e)); }

/** Корни, которые прогон считает, но на которых не падает: окно простоя за пределом дизайна (см. шапку) и известные, ещё не исправленные. */
const KNOWN: Record<string, string> = {
  // ENV1 исправлен: молчащая нода отгораживает себя сама до срока, после которого реестр отдаёт её героев и забеги (аренда, `lease.ts`), —
  // нарушения после длинного простоя (`ENV-outage-over-dead-sec`) больше не прощаются.
  // ⭐ Перепрогон R18: и слив, чья дописка ждала свод забега (K2), а свод не принимался так же долго (`drainLedgerDown`).
  'ENV-drain-db-outage': 'слив ноды во время раздела с базой дольше аренды ноды (бюджета слива; или кончившегося меньше чем за круг дописки до его конца; или только свода забега, которого ждёт строка героя) — копии уходят с процессом (ИНЦИДЕНТ по дизайну, R12-04)',
  // ⭐ Перепрогон R16 (только `DM_FUZZ_OUTAGE_LONG`): двойной сбой — пауза машины дольше срока смерти И реестр, недоступный ей и после паузы
  // (пауза сердцебиения или раздел с базой дольше самой паузы). Сверка R16-02 (давно ли реестр видел ноду) до реестра не доходит, а часы
  // процесса паузы не видели (стояли все часы — нода не отгорожена; настенные догнал chrony — отгорожена сомнением): до конца аренды нода держит
  // героев и забеги, которые реестр уже отдал другой (a, b), и копии, которые та уже переписала (ИНЦИДЕНТ R6-06). Узнать это ей не у кого;
  // конец аренды — выход без записи. Открытый вопрос владельцу — запись «по строке базы» в этом окне (см. отчёт перепрогона).
  // ⭐ R18-03: сужен до «до первой записи»: запись строки героя идёт только с проверкой владения тем же запросом, и первая же запись оттаявшей
  // ноды (автосейв — не реже 10 с, любое действие) отказана — сессия снята. Держать копию в памяти без записи до неё она ещё может.
  'ENV-thaw-registry-silent': 'нода вернулась с паузы машины дольше срока смерти, а реестр ей ещё недоступен — до первой записи (отказанной проверкой владения) не знает, что её героев и забеги отдали',
  // ⭐ R19-05, ПО ДИЗАЙНУ (как у фаззера одной ноды): действие администратора над строкой ЖИВОГО героя (отзыв вещи, откат — `adminBump`) обгоняет
  // его сессию — копия в памяти проиграла (R1-01), и что память держала с тех пор (пулы, смерть и штраф в ней, обещание экрана по копии), решает
  // строка базы. Игрок сам этого не вызывает. Вещи (1-dup, пропажа), свод, забег и кластер (2, 7, 8, a–d) сторожатся и тут.
  'ADMIN-row-wins': 'строку живого героя обогнал администратор — правда его строка, память сессии проиграла',
  // K1 (вход, который комната не помнит, читает «мёртв, оплачено» из сейва), K2 (свод забега — в базу раньше строки героя) и K3 (передача
  // через землю записана наполовину) исправлены: их нарушения — снова неизвестные. ⭐ K3 (проход правок 2): окно было шире «одной записи в
  // пути» — подъём клал вещь в сумку раньше записи поднявшего, а та могла не лечь вовсе (пауза C-07, сбой без повтора, исход неизвестен, копия
  // «на дописать», процесс умер на ней, аренда кончилась в простое базы). Теперь выброшенное переходит в сумку только после записи поднимающего
  // с ним (`Room.pickThrown`), а до неё лежит на земле: умер процесс — ушло с землёй его комнаты (сток по дизайну), а не из записанного.
};
/**
 * ⭐ R19-05: нарушения правил памяти героя, которые обгон администратором снимает (`ADMIN-row-wins`). ⭐ D1 (большие прогоны; оба — так же и на
 * снимке 397980a): `3-dungeon-foreign-run` (сид 101387) — одинокий герой погиб, вайп снял забег в памяти, а строку (со снимком ДО смерти, с
 * забегом) обогнал администратор; «Продолжить» возвращает его строкой в свою комнату, стоящую на паузе в окне вайпа: правда — строка с забегом;
 * `8-progress-regress` (сид 140882) — администратор обогнал строку снимком ДО спуска, и глубина сложности, набранная памятью после него, ушла
 * вместе с проигравшей копией: прогресс сложности — поле строки героя (свод и узлы забега — `8-node-*` — строкой не решаются и сторожатся).
 */
const ADMIN_ROW_WINS = new Set(['1-sunk-item-back', '3-double-penalty', '3-dungeon-foreign-run', '3-missing-penalty', '3-safe-penalized', '3-unjustified-penalty', '4-free-restore', '5-status-promise', '8-progress-regress']);
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
  // ⭐ R18-03: окно корня сужено — запись строки героя идёт только с проверкой владения тем же запросом (`putCharacterOwned`: закрепление за нодой
  // и её удар в реестре моложе аренды), и первая же запись оттаявшей ноды (автосейв — не реже 10 с, любое действие) отказана: сессия снята, копия
  // забыта. Держать копию в памяти до этой записи (здесь — вход героя на node-1 раньше неё) нода ещё может: записать её она уже не в силах.
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
    // ⭐ Перепрогон R18: окно дизайна — только без `DM_FUZZ_OUTAGE_LONG`: с ней простой не укорачивается до окна, и «короткий» повтор — тот же
    // длинный (большой прогон с длинными простоями падал на этом тесте файла, а не на сидах).
    if (OUTAGE_LONG) return;
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
  // ⭐ R18-03: ОКНО «ОТТАЯЛА, ДО ПЕРВОГО УДАРА». h0 и h1 в подземелье на node-0; h1 ушёл посреди боя (тело в бою, ждёт реконнекта — `fled`).
  // Машина node-0 стоит 130 с с остановленными часами (аренда цела, сомнения нет): реестр отдал h1 node-1, и там он продолжает ТОТ ЖЕ забег
  // (строка сдвинута). В сокет h0 на node-0 за паузу пришло «в город». Оттаяв, node-0 читает его ДО удара: пати уходит с этажа, сбежавший
  // хоронится — копия отклонена по версии, и штраф со снятием забега ложились по СВЕЖЕЙ строке (`settleStored`) на героя, играющего на node-1.
  // Теперь запись по строке — с проверкой владения тем же запросом (`putCharacterOwned`): отказ. Самопроверка `r1803` — запись по версии.
  const THAW_BURY: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false, via: 0 },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'move', h: 0, to: 'portal', r: 0 },
    { k: 'move', h: 1, to: 'monster', r: 0 },
    { k: 'attack', h: 1, r: 0, weaken: false },
    { k: 'step', n: 3 },
    { k: 'close', h: 1 },
    { k: 'suspend', n: 0, ms: 130_000, wall: false },
    { k: 'frozenFrame', h: 0, t: 'return' },
    { k: 'join', h: 1, mode: 'resume', r: 0, reuse: false, via: 'gw' },
    { k: 'step', n: 30 },
    { k: 'wait', ms: 12_000 },
    { k: 'step', n: 3 },
  ];
  fixedRoot('R18-03: оттаявшая до удара нода не хоронит по строке базы героя, которого держит другая', 7, THAW_BURY, 'a-stored-foreign-write');
  it('самопроверка R18-03: запись по строке базы — по версии, без владения — `a-stored-foreign-write`', async () => {
    teeth.r1803 = true;
    try {
      expect((await replay(7, THAW_BURY)).map((v) => v.inv)).toContain('a-stored-foreign-write');
    } finally { teeth.r1803 = FUZZ_SELFTEST === 'r1803'; }
  });
  // ⭐ R18-02 (кластер): свод перестал писаться (строки героев — пишутся); h0 один прошёл узел с h1-якорем, открыл сундуки и ушёл из города —
  // комната снята с недолёгшим сводом. «Продолжить» h1 на той же ноде собирал узел по базе — сундук закрыт снова. Теперь — «занято», строку забега
  // нода держит за недолёгшим сводом (`runsOwed`: отказ соседней ноды ведёт сюда), а когда свод лёг — продолжение со взятым. Самопроверка `r1802`.
  const LEDGER_DOWN_C: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false, via: 0 },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'leave', h: 1 },
    { k: 'fault', f: 'ledgerDown', h: null, ops: 10 },
    { k: 'descend', h: 0, r: 0, others: 'none', near: false, pause: true },
    { k: 'chest', h: 0, r: 0 },
    { k: 'chest', h: 0, r: 0.5 },
    { k: 'town', h: 0, others: 'none', near: true, pause: true },
    { k: 'leave', h: 0 },
    { k: 'join', h: 1, mode: 'resume', r: 0, reuse: false, via: 0 },
    { k: 'step', n: 3 },
    { k: 'join', h: 1, mode: 'resume', r: 0, reuse: false, via: 1 },
    { k: 'step', n: 3 },
  ];
  fixedRoot('R18-02 (кластер): недолёгший свод ушедшей комнаты — «Продолжить» не открывает взятый сундук снова', 7, LEDGER_DOWN_C, '8-node-refarmable');
  // ⭐ R20-01 (кластер): СЛИВ И ПАЧКА СВОДА СНЯТОЙ КОМНАТЫ В ПУТИ. h0 и h1 прошли узел и вернулись в город, h1 вышел (якорь с припаркованной
  // копией). h0 продолжил забег один, открыл сундук узла и погиб — вайп: `endRun` отправил свод, а пачка висит в базе (`ledgerSlow`: база медленная
  // при деплое). h0 вышел из города — комната снята с пачкой в пути, и слив node-0 её не видел: выход за миллисекунды, пачка ушла с процессом без
  // ИНЦИДЕНТА (`8-drain-ledger-silent`), а «Продолжить» h1 на node-1 собирал узел по неполному своду — сундук закрыт снова. Теперь слив ждёт пачку,
  // и она ложится до выхода: сундук у h1 открыт. Самопроверка `r2001` — учёт недолёгшего без пачек в пути.
  const LEDGER_SLOW_C: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false, via: 0 },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'leave', h: 1 },
    { k: 'descend', h: 0, r: 0, others: 'none', near: false, pause: true },
    { k: 'chest', h: 0, r: 0 },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 6_000 },
    { k: 'kill', h: 0, body: false },
    { k: 'wait', ms: 4_500 },
    { k: 'leave', h: 0 },
    { k: 'drain', n: 0 },
    { k: 'join', h: 1, mode: 'resume', r: 0, reuse: false, via: 1 },
    { k: 'step', n: 3 },
  ];
  fixedRoot('R20-01 (кластер): слив ждёт пачку свода снятой комнаты — она ложится до выхода, сундук у продолжившего открыт', 7, LEDGER_SLOW_C, '8-drain-ledger-silent');
  it('самопроверка R20-01 (кластер): пачка свода в пути не в учёте недолёгшего — `8-drain-ledger-silent`', async () => {
    teeth.r2001 = true;
    try {
      expect((await replay(7, LEDGER_SLOW_C)).map((v) => v.inv)).toContain('8-drain-ledger-silent');
    } finally { teeth.r2001 = FUZZ_SELFTEST === 'r2001'; }
  });
  // ⭐ D1 (кластер): ОДНО ПРАВИЛО ОБЩЕГО ЗАБЕГА — как у фаззера одной ноды, но B входит к держателю с чужой ноды: «Продолжить» через гейтвей, отказ
  // `run` с кодом держателя — к его ноде по коду (`EntryFlow.runHeld`), там спуск, «нет» или молчание A — «Продолжить без пати». Самопроверки `d1solo`
  // (держатель «Соло» не отпускает) и `d1timeout` (голосование без срока) — выхода нет: `5-run-stuck`.
  const PARTY_BACK_C: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false, via: 0 },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'leave', h: 1 },
    { k: 'obstruct', h: 0, no: false },
  ];
  const WANT_C = (partner: Partner): Op[] => [...PARTY_BACK_C, { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false, via: 1 }, { k: 'leave', h: 1 }, { k: 'want', h: 1, partner }];
  fixedRoot('D1 (кластер): напарник на другой ноде молчит — к нему по коду, голос по сроку не прошёл, «Соло» — в подземелье', 7, WANT_C('idle'), '5-run-stuck');
  fixedRoot('D1 (кластер): …и отвечает «нет»', 7, WANT_C('no'), '5-run-stuck');
  fixedRoot('D1 (кластер): …и «за» — вместе', 7, WANT_C('yes'), '5-run-stuck');
  it('самопроверка D1 (кластер): держатель «Соло» не отпускает, голосование без срока — `5-run-stuck`', async () => {
    teeth.d1solo = true;
    try {
      expect((await replay(7, WANT_C('no'))).map((v) => v.inv)).toContain('5-run-stuck');
    } finally { teeth.d1solo = FUZZ_SELFTEST === 'd1solo'; }
    teeth.d1timeout = true;
    try {
      expect((await replay(7, WANT_C('idle'))).map((v) => v.inv)).toContain('5-run-stuck');
    } finally { teeth.d1timeout = FUZZ_SELFTEST === 'd1timeout'; }
  });
  it('⭐ R22-09 самопроверка прогона: нода чеканит коды буквой соседней — провал `harness:letter-mismatch`, а не счётчик', async () => {
    teeth.wrongLetter = true;
    try {
      expect((await replay(7, WANT_C('yes'))).map((v) => v.inv)).toContain('harness:letter-mismatch');
    } finally { teeth.wrongLetter = FUZZ_SELFTEST === 'wrongLetter'; }
    expect((await replay(7, WANT_C('yes'))).map((v) => v.inv), 'без зубов — ни одного').not.toContain('harness:letter-mismatch');
  });
  // ⭐ R19-05 (кластер): запись героя, одного в подземелье, обогнал администратор, пока в комнате открывали сундук: сессия снята, комната на паузе,
  // «Завершить» её снимает. Раньше пауза и уход свод не дописывали: нода продлевала строку забега за ушедшей комнатой. Самопроверка `r1905`.
  const ADMIN_BUMP_C: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false, via: 0 },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'adminBump', h: 0 },
    { k: 'abandon', h: 0, via: 0 },
  ];
  fixedRoot('R19-05 (кластер): пауза и уход комнаты дописывают свод — строка забега не живёт за ушедшей комнатой', 7, ADMIN_BUMP_C, '8-ledger-stranded');
  it('самопроверка R19-05 (кластер): пауза и уход комнаты без дописки свода — `8-ledger-stranded`', async () => {
    teeth.r1905 = true;
    try {
      expect((await replay(7, ADMIN_BUMP_C)).map((v) => v.inv)).toContain('8-ledger-stranded');
    } finally { teeth.r1905 = FUZZ_SELFTEST === 'r1905'; }
  });
  it('самопроверка R18-02 (кластер): недолёгший свод не виден входу — `8-node-refarmable`', async () => {
    teeth.r1802 = true;
    try {
      const got = (await replay(7, LEDGER_DOWN_C)).map((v) => v.inv);
      expect(got.some((v) => v === '8-node-refarmable' || v === '8-node-double-loot'), JSON.stringify(got)).toBe(true);
    } finally { teeth.r1802 = FUZZ_SELFTEST === 'r1802'; }
  });
  // ── Перепрогон после правок раунда 18 (сиды 10 200 001…10 201 000), МОДЕЛЬ ФАЗЗЕРА — сервер прав. Машина node-1 встала сразу после ответа
  // сверки удара (R17-01, `suspend.mid`) на 130 с (стояли все часы). Проснувшись, она продолжает тот же удар, и продление забегов падает сбоем
  // реестра (ответ потерян, `regFault`): удар бросил, не дойдя до самого удара, — процесс жив до следующего (через `BEAT_MS`), где сверка
  // возраста удара его и снимает. В эти две секунды автосейв h0 отказан проверкой владения (R18-03: удар ноды в реестре старше аренды) — копия
  // забыта, ИНЦИДЕНТ. Это честный отказ записи СПИСАННОГО процесса (как ИНЦИДЕНТ продления у R17-01), а модель считала ноду ожившей, едва удар
  // после паузы вернулся без её смерти, — и читала ИНЦИДЕНТ пропажей копии (`7-copy-forgotten`). Ожил — только тот, чей удар реестр принял.
  // Сжато фаззером (сид 10200329).
  fixedRoot('перепрогон R18 (модель): удар проснувшейся ноды упал сбоем реестра — до следующего она списана, отказ её записи не пропажа', 10200329, [
    { k: 'regFault', op: 'touchRuns', kind: 'landed', n: null },
    { k: 'join', h: 0, mode: 'fresh', r: 0.9153311883565038, reuse: false, via: 'x' },
    { k: 'descend', h: 0, r: 0.47796079027466476, others: 'yes', near: true, pause: false, diff: 2 },
    { k: 'suspend', n: 1, ms: 130_000, wall: false, mid: 'claims' },
    { k: 'wait', ms: 4200 },
    { k: 'wait', ms: 4200 },
    { k: 'frozenFrame', h: 0, t: 'vote' },
  ], '7-copy-forgotten');
  // …и слив (R14-07, K2): h2 открыл сундук на узле забега, и свод перестал приниматься (`ledgerDown`) — строка h2 ждёт свода (K2: строка героя
  // не обгоняет свод, иначе продолжение другим открыло бы сундук снова). Сбой свода меряется операциями, а слив — одна операция: до конца аренды
  // (110 с поддельного времени) свод так и не лёг, и слив честно пишет ИНЦИДЕНТ за героя и за свод. Это раздел с базой — для того, что слив обязан
  // дописать, — дольше аренды ноды: корень `ENV-drain-db-outage`, как у раздела (классификатор знал только раздел). Героя, чья строка свода не
  // ждёт, сбой свода не объясняет: без сундука (свод весь в базе) слив дописывает h2 и под тем же сбоем. Сжато фаззером (сид 10200205).
  const DRAIN_LEDGER_DOWN: Op[] = [
    { k: 'join', h: 2, mode: 'fresh', r: 0.9276575525291264, reuse: false, via: 'gw' },
    { k: 'descend', h: 2, r: 0.809415856609121, others: 'no', near: true, pause: false },
    { k: 'crashAt', n: 0, calls: 7 },
    { k: 'join', h: 2, mode: 'resume', r: 0.8891481317114085, reuse: false, via: 'gw' },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 2, mode: 'resume', r: 0.24624690366908908, reuse: false, via: 'gw' },
    { k: 'chest', h: 2, r: 0.03862899332307279 },
    { k: 'fault', f: 'ledgerDown', h: null, ops: 5 },
    { k: 'drain', n: 1 },
  ];
  // …и земля СПИСАННОГО процесса (R18-03, `frozenFrame`): h3 и h1 в городе на node-0, её раздел с базой; h1 голосует за спуск, h3 бросает вещь —
  // запись выброса не легла (раздел), вещь в строке h3. Машина node-0 встаёт на 130 с (стояли все часы): мир списал её, правда h3 — строка
  // базы, вещь в ней. Оттаяв, node-0 до удара читает голос h3, пришедший за паузу: голосование решено, комната уходит в подземелье, и модель
  // писала землю города в сток («земля ушедшего этажа») — а потом строка h3 с той же вещью выглядела возвратом взятого стоком
  // (`1-sunk-item-back`). Земля процесса, которого мир списал, — не мир: её уход ничего не берёт (записи списанного отказаны, R18-03).
  // Сжато фаззером (сид 10210666, свежий диапазон 10 210 001…10 211 000).
  fixedRoot('перепрогон R18 (модель): списанная нода, оттаяв, уходит с этажа — её земля не сток, вещь в строке героя', 10210666, [
    { k: 'join', h: 3, mode: 'friend', r: 0.8129003304056823, reuse: false, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.6259384301956743, reuse: true, via: 'gw' },
    { k: 'partition', n: 0, ms: 105_000 },
    { k: 'descend', h: 1, r: 0.8043351990636438, others: 'none', near: false, pause: true, diff: 2 },
    { k: 'drop', h: 3, r: 0.46527853910811245 },
    { k: 'suspend', n: 0, ms: 130_000, wall: false },
    { k: 'frozenFrame', h: 3, t: 'vote' },
  ], '1-sunk-item-back');
  // ⭐ ПЕРЕПРОГОН R18, СЕРВЕР (сид 10250172, 300 операций, сжато до 14): ПРОДОЛЖЕНИЕ ИЗ ГОРОДА ЧИТАЛО СВОД ДО ВЗЯТИЯ ЗАБЕГА. h0 и h2 прошли узел
  // забега K вместе и разошлись по разным городским комнатам node-1 (h0 — к h1 по дружбе, h2 — в новую), обе с припаркованным K. h0 зовёт
  // спуск: продолжение прочитало свод (сундук закрыт) и ждёт взятия забега в реестре (поздний ответ, `regFault late`). В это окно h2 в своей
  // комнате продолжает K (его взятие быстрое), открывает сундук и гибнет — комната K отдаёт, свод с сундуком лёг. Ответ реестра приходит, и
  // комната h0 входит в узел по своду, прочитанному ДО этого: сундук закрыт снова — добыча второй раз (`8-node-refarmable`). Теперь свод
  // читается ПОСЛЕ взятия (соседняя нода забег уже не возьмёт), а взятие забега другой комнатой процесса, пока продолжение ждёт реестр и базу
  // (`watchRunTakes`), — отказ «позовите спуск снова»; повтор читает свод заново.
  fixedRoot('перепрогон R18: продолжение из города, чьё взятие забега опоздало, не собирает узел по своду, прочитанному до него', 10250172, [
    { k: 'suspend', n: 0, ms: 400_000, wall: true },
    { k: 'join', h: 1, mode: 'friend', r: 0.956013360992074, reuse: false, via: 1 },
    { k: 'join', h: 0, mode: 'fresh', r: 0.38925384264439344, reuse: false, via: 'gw' },
    { k: 'descend', h: 0, r: 0.36958921886980534, others: 'yes', near: false, pause: true, diff: 0 },
    { k: 'join', h: 2, mode: 'code', r: 0.8696950827725232, reuse: true, via: 'gw' },
    { k: 'close', h: 0 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'town', h: 2, others: 'no', near: true, pause: true },
    { k: 'join', h: 0, mode: 'friend', r: 0.14372026175260544, reuse: false, via: 'gw' },
    { k: 'join', h: 2, mode: 'fresh', r: 0.5229192208498716, reuse: true, via: 'gw' },
    { k: 'descend', h: 0, r: 0.13183538941666484, others: 'yes', near: true, pause: false },
    { k: 'descend', h: 2, r: 0.6340547748841345, others: 'yes', near: false, pause: false },
    { k: 'chest', h: 2, r: 0.42086904123425484 },
    { k: 'kill', h: 2, body: false },
  ], '8-node-refarmable');
  it('перепрогон R18 (модель): слив, пока свод не принимается до конца аренды, — корень за окном дизайна (`ENV-drain-db-outage`)', async () => {
    const vs = await replay(10200205, DRAIN_LEDGER_DOWN);
    expect(vs.map((v) => v.inv), 'слив не дописал героя и свод').toContain('7-copy-forgotten');
    expect(vs.filter((v) => v.cause !== 'ENV-drain-db-outage').map((v) => `${v.inv}: ${v.msg}`), 'и объяснён своим корнем').toEqual([]);
    const noChest = DRAIN_LEDGER_DOWN.filter((o) => o.k !== 'chest');
    expect((await replay(10200205, noChest)).map((v) => `${v.inv}${v.cause ? ` (${v.cause})` : ''}: ${v.msg}`), 'свод весь в базе — слив дописывает героя и под сбоем свода').toEqual([]);
  });
  // ── Перепрогон после правок раунда 19 (сиды 21 000 001…21 171 200), МОДЕЛЬ ФАЗЗЕРА — сервер прав. h1 в городе комнаты A (забег K держит она,
  // удар сердца с продлением «K за A» ждёт реестр — поздний ответ, `regFault late`); свод перестал приниматься (`ledgerDown`). «Продолжить» h1
  // уводит K в новую комнату B той же ноды (A отпустила K, отпуск лёг в реестр), h1 гибнет — B отдаёт K с недолёгшим сводом: нода держит строку
  // за сводом (R18-02, `runsOwed`, без отпуска в реестре). Тут ложится позднее продление «K за A» — строка снова за A, и удар отпускает A ещё
  // раз (R15-08, `releaseRuns`): свод должен — строка остаётся за нодой, теперь за A (`runsOwed` — по строке), удары продлевают её за A, пока
  // свод не ляжет, и отпускают. Модель `b-run-lock-orphan` знала отпуск A и видела продление за A после него — «сирота»; а держание за
  // недолёгшим сводом — по дизайну (отказ «Продолжить» соседней ноды ведёт сюда, R18-02; `5-resume-dead-end` его уже прощал), и за какой ушедшей
  // комнатой ноды строка — всё равно: вход сюда дописывает свод или отвечает «занято». Судим снова, когда свод лёг. Сжато фаззером (сид 21111021).
  fixedRoot('перепрогон R19 (модель): строка забега, которую нода держит за недолёгшим сводом, — не сирота, за какой бы ушедшей комнатой ни была', 21111021, [
    { k: 'recruit' },
    { k: 'crashAt', n: 0, calls: 12 },
    { k: 'join', h: 2, mode: 'friend', r: 0.05791195575147867, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'resume', r: 0.8091243479866534, reuse: false, via: 'x' },
    { k: 'regFault', op: 'touchRuns', kind: 'late', n: 0 },
    { k: 'join', h: 0, mode: 'friend', r: 0.010638345964252949, reuse: false, via: 'x' },
    { k: 'restart', n: 0 },
    { k: 'step', n: 3 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 4, mode: 'fresh', r: 0.3187134952750057, reuse: true, via: 'gw' },
    { k: 'step', n: 3 },
    { k: 'wait', ms: 61_000 },
    { k: 'descend', h: 4, r: 0.291704777861014, others: 'yes', near: false, pause: false, diff: 2 },
    { k: 'town', h: 4, others: 'yes', near: true, pause: true },
    { k: 'step', n: 3 },
    { k: 'fault', f: 'ledgerDown', h: null, ops: 8 },
    { k: 'join', h: 4, mode: 'resume', r: 0.981921826954931, reuse: false, via: 'gw' },
    { k: 'kill', h: 4, body: false },
  ], 'b-run-lock-orphan');
  // ── Перепрогон после правок раунда 20 (сиды 22 010 001…22 011 100). Все три находки — под медленной пачкой свода (`ledgerSlow`, R20-01):
  // запись свода висит секунды, и запись героя, которая его ждёт (K2), — тоже.
  // ⭐ СЕРВЕР (сид 22010446, 220 операций, сжато до 18): ПРОДОЛЖЕНИЕ ИЗ ГОРОДА, ЧЬЯ КОМНАТА УШЛА, ПОКА ВЗЯТИЕ ШЛО В РЕЕСТР, ЖДАЛО СВОД. h2 в узле
  // забега K (комната A, node-1), вышел; h0 вошёл по коду, увёл пати в город, и медленная база (20 с на пачку свода). h0 зовёт спуск — продолжение
  // из города шлёт взятие K (поздний ответ реестра), а тем временем h0 и h2 выходят: A ушла и отпустила K. h2 «Продолжить» — K берёт новая комната
  // B той же ноды. Тут ложится позднее взятие «K за A»: строка снова за ушедшей A. Продолжение, получив ответ, сперва ждало слива чужого свода
  // (`runLedgerDrain` — 20 с медленной базы) и только потом видело, что комнаты нет, и отдавало взятое (`runDropped`): строка всё это время стояла
  // за A, а без держателя на ноде (B) — не правил её и удар, и «Продолжить» соседней ноды получал отказ с кодом ушедшей комнаты. Теперь
  // комната, ушедшая (или замороженная сливом), пока взятие шло в реестр, отдаёт его сразу по ответу — свод ей уже не нужен.
  fixedRoot('перепрогон R20: продолжение из города, чья комната ушла, пока шло взятие забега, отдаёт его по ответу реестра, не дожидаясь свода', 22010446, [
    { k: 'recruit' },
    { k: 'step', n: 90 },
    { k: 'join', h: 4, mode: 'fresh', r: 0.9494657984469086, reuse: true, via: 'gw' },
    { k: 'descend', h: 4, r: 0.8997376796323806, others: 'yes', near: true, pause: true, diff: 2 },
    { k: 'join', h: 2, mode: 'fresh', r: 0.42053844733163714, reuse: false, via: 'gw' },
    { k: 'descend', h: 2, r: 0.3307783165946603, others: 'no', near: false, pause: true, diff: 3 },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: null },
    { k: 'leave', h: 2 },
    { k: 'join', h: 0, mode: 'code', r: 0.6478832990396768, reuse: false, via: 'x' },
    { k: 'town', h: 0, others: 'no', near: true, pause: true },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 20_000 },
    { k: 'descend', h: 0, r: 0.9221744081005454, others: 'no', near: false, pause: true, diff: 1 },
    { k: 'join', h: 2, mode: 'friend', r: 0.553939413279295, reuse: true, via: 'gw' },
    { k: 'leave', h: 0 },
    { k: 'leave', h: 2 },
    { k: 'step', n: 3 },
    { k: 'join', h: 2, mode: 'resume', r: 0.6577272217255086, reuse: true, via: 'x' },
    { k: 'attack', h: 2, r: 0.19048754777759314, weaken: true },
  ], 'b-run-lock-orphan');
  // МОДЕЛЬ ФАЗЗЕРА — сервер прав (сид 22010393, 220 операций, сжато до 10). h1 в городе node-1 (забег K припаркован после падения node-0),
  // медленная пачка свода (6 с, потом сбой), h0 «Продолжить» K. h1 вынимает вещь из сундука: транзакция «сейв + сундук» (R1-05, сейв на
  // удержании) ждёт свод (K2) — в памяти вещь уже в сумке, а сундук базы ещё с ней. Решит запись: ляжет — сундук её записи, нет — откат к «до».
  // Фаззер одной ноды это знает (R15-02: копия на удержании — под вопросом до конца транзакции), а фаззер кластера медленной записи не видел до
  // `ledgerSlow` — и читал это окно дюпом (`1-dup-item`). Дюп, переживший транзакцию, видит следующая проверка и `1-dup-item-db` в конце.
  fixedRoot('перепрогон R20 (модель): транзакция «сейв + сундук», ждущая медленный свод, — копия на удержании под вопросом, не дюп', 22010393, [
    { k: 'join', h: 0, mode: 'friend', r: 0.15156454220414162, reuse: false, via: 'gw' },
    { k: 'join', h: 1, mode: 'friend', r: 0.05906391050666571, reuse: true, via: 'x' },
    { k: 'stash', h: 1, r: 0.12146357167512178, out: false },
    { k: 'descend', h: 0, r: 0.46228274307213724, others: 'yes', near: false, pause: false, diff: 0 },
    { k: 'crash', n: 0 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 1, mode: 'fresh', r: 0.40504580782726407, reuse: true, via: 'x' },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 6_000, fail: true },
    { k: 'join', h: 0, mode: 'resume', r: 0.7942434602882713, reuse: false, via: 1 },
    { k: 'stash', h: 1, r: 0.8887566400226206, out: true },
  ], '1-dup-item');
  // МОДЕЛЬ ФАЗЗЕРА — сервер прав (сид 22010661, 140 операций, длинные простои, сжато до 7). h0 и h2 в узле забега, администратор обогнал строку
  // h2 (его сессию сняли), медленная пачка свода (6 с, потом сбой). h0 — статус и «Завершить»: выселение живой сессии пишет прощальную запись,
  // а она ждёт свод (K2), — «Завершить» ещё в пути, когда эпилог закрывает соединения лобби. Сервер доводит начатое: штраф ложится (игрок нажал
  // «Завершить» — закрытая вкладка его не отменяет). Модель помнила просьбу только пока открыто её соединение — и читала штраф «Завершить» без
  // «Завершить» (`3-unjustified-penalty`). Теперь просьба в силе, пока её кадр исполняется (`abandonBusy`).
  fixedRoot('перепрогон R20 (модель): «Завершить», чьё соединение закрылось, пока он ждал медленную базу, — штраф по просьбе', 22010661, [
    { k: 'join', h: 0, mode: 'friend', r: 0.2835320816375315, reuse: true, via: 'x' },
    { k: 'recruit' },
    { k: 'join', h: 2, mode: 'code', r: 0.16819585370831192, reuse: true, via: 1 },
    { k: 'descend', h: 2, r: 0.1561594547238201, others: 'yes', near: true, pause: true, diff: 2 },
    { k: 'adminBump', h: 2 },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 6_000, fail: true },
    { k: 'abandon', h: 0, via: 'gw', ask: true },
  ], '3-unjustified-penalty');
  // МОДЕЛЬ ФАЗЗЕРА — сервер прав (сид 22012244, свежий диапазон 22 012 001…22 012 300, 220 операций, сжато до 23). h0 и h3 в узле забега,
  // администратор обогнал строку h3 (его сессию сняли), и h3 — «Продолжить». Вход сперва дописывает недолёгший свод забега (R18-02,
  // `runLedgerDrain`: до трёх кругов пачек в пути), а h0 тем временем играет тот же забег, и база медленная: три пачки его комнаты подряд — 6 с,
  // 20 с и 20 с. Вход ответил, когда база ответила (46 с), а срок проверки 5 — 40 с: он про ожидание, которое не кончится, а не про медленную
  // базу. Теперь срок длиннее на медленные пачки свода ноды за время ожидания (`slowSpans`); зависший кадр переживёт и их.
  fixedRoot('перепрогон R20 (модель): «Продолжить», ждущий свод из медленной базы, — не «кадр лобби без ответа»', 22012244, [
    { k: 'join', h: 0, mode: 'friend', r: 0.8898846011143178, reuse: true, via: 'gw' },
    { k: 'join', h: 3, mode: 'friend', r: 0.10473448177799582, reuse: false, via: 'gw' },
    { k: 'descend', h: 3, r: 0.7884900448843837, others: 'yes', near: true, pause: true, diff: 1 },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 6_000 },
    { k: 'adminBump', h: 3 },
    { k: 'join', h: 3, mode: 'resume', r: 0.2599933482706547, reuse: false, via: 'gw' },
    { k: 'step', n: 10 },
    { k: 'step', n: 30 },
    { k: 'step', n: 30 },
    { k: 'step', n: 90 },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 20_000, fail: true },
    { k: 'attack', h: 0, r: 0.496530408738181, weaken: true },
    { k: 'descend', h: 0, r: 0.714398585492745, others: 'none', near: true, pause: false, diff: 1 },
    { k: 'wait', ms: 1600 },
    { k: 'descend', h: 0, r: 0.8112530612852424, others: 'none', near: true, pause: true },
    { k: 'attack', h: 0, r: 0.251665526535362, weaken: false },
    { k: 'wait', ms: 4200 },
    { k: 'attack', h: 0, r: 0.3390710740350187, weaken: false },
    { k: 'descend', h: 1, r: 0.10983841167762876, others: 'yes', near: false, pause: true },
    { k: 'descend', h: 1, r: 0.30297004128806293, others: 'none', near: true, pause: true, diff: 1 },
    { k: 'step', n: 90 },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 20_000, fail: true },
    { k: 'wait', ms: 16000 },
  ], '5-lobby-unanswered');
  // ── Перепрогон Z2 (30.09, свежие диапазоны 51 100 001…), МОДЕЛЬ ФАЗЗЕРА — сервер прав. Одиночный h0 погиб в подземелье, node-0 отрезана от
  // базы на 85 с (стоит вся очередь записей героя), в городе он кладёт вещь в сундук (транзакция ждёт базу и падает) и продаёт другую: кадр
  // продажи стоит в очереди соединения за транзакцией и исполняется, когда база ответила, — в следующей операции. Фаззер одной ноды это знает
  // (R15-02: продано — по ответу, когда бы он ни пришёл), а фаззер кластера смотрел ответ только в своей операции — проданное числилось
  // пропавшим без стока (`1-item-lost`). Теперь продажа ждёт ответа (`selling`). Сжато фаззером (сид 51100240).
  fixedRoot('перепрогон Z2 (модель): продажа, ждавшая в очереди за транзакцией до конца раздела с базой, — сток по ответу, не пропажа', 51100240, [
    { k: 'join', h: 0, mode: 'friend', r: 0.8935739824082702, reuse: true, via: 'gw' },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 20_000, fail: true },
    { k: 'descend', h: 0, r: 0.9031823319382966, others: 'none', near: false, pause: true, diff: 3 },
    { k: 'kill', h: 0, body: false },
    { k: 'partition', n: 0, ms: 85_000 },
    { k: 'step', n: 90 },
    { k: 'step', n: 30 },
    { k: 'stash', h: 0, r: 0.8540323958732188, out: false },
    { k: 'sell', h: 0, r: 0.5226002323906869 },
    { k: 'wait', ms: 61_000 },
  ], '1-item-lost');
  // МОДЕЛЬ ФАЗЗЕРА — сервер прав (сид 51100587, сжато до 13). h0 вошёл по коду в узел h1 на node-1, администратор обогнал его строку — копия в памяти
  // проиграла (сессию сняли, копия ждёт реконнекта). «Завершить»: штраф на копии, её запись падает; повтор — отказ по версии, и штраф ложится
  // ПО СТРОКЕ БАЗЫ (`settleStored`, свой бросок потери) — легла, а ответ потерян. Правда о вещах, взятых этим штрафом, — строка: копия проиграла, её
  // дописка ляжет по строке (штрафовать нечего) и отпустит её. Модель же считала правдой героя копию, которая «ещё дописывается», — взятые штрафом
  // строки вещи в ней лежали, штраф «лёг», а стоком они не стали; когда копию сняли (машина node-1 встала — откат к строке; или дописка), вещи
  // пропадали: `c-durable-item-lost` / `1-item-lost`. Теперь такие вещи — сток этого штрафа, когда копия уйдёт (`sinkLater`).
  const storedOverLost: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0.2173737483099103, reuse: true, via: 'gw' },
    { k: 'wait', ms: 16_000 },
    { k: 'close', h: 0 },
    { k: 'join', h: 1, mode: 'fresh', r: 0.37124025309458375, reuse: true, via: 'gw' },
    { k: 'descend', h: 1, r: 0.6651982290204614, others: 'no', near: false, pause: true },
    { k: 'join', h: 0, mode: 'code', r: 0.2168081388808787, reuse: false, via: 1 },
    { k: 'adminBump', h: 0 },
    { k: 'fault', f: 'fail', h: 0 },
    { k: 'fault', f: 'unknownLanded', h: 0 },
    { k: 'abandon', h: 0, via: 'gw', ask: true },
    { k: 'fault', f: 'unknownLanded', h: 0 },
    { k: 'retry' },
  ];
  fixedRoot('перепрогон Z2 (модель): штраф по строке базы лёг, а проигравшая копия ещё держит взятое им — машина встала, откат к строке: сток, не пропажа', 51100587, [
    ...storedOverLost,
    { k: 'suspend', n: 1, ms: 130_000, wall: true, mid: 'claims' },
  ], 'c-durable-item-lost', true);
  fixedRoot('перепрогон Z2 (модель): …и копию отпускает её дописка по строке — взятое штрафом строки не «пропало без стока»', 51100587, [
    ...storedOverLost,
    { k: 'wait', ms: 20_000 },
    { k: 'retry' },
    { k: 'wait', ms: 20_000 },
  ], '1-item-lost', true);
  // ── Перепрогон Z3 (30.09, свежие диапазоны 61 240 001…), СЕРВЕР — ложный ИНЦИДЕНТ. h1 «Продолжить без пати» (`join{resume, solo}`) на node-1:
  // новая комната B берёт забег (ожидаемое взятие `runClaim` легло), а повторное взятие `runTaken` отвечает поздно (сбой `late`). Пати забега
  // тем временем полегла — B сразу хоронит h1 (`abandonAsDead`) и отпускает забег, комнаты нет. h2 «Продолжить» на node-0 — забег законно берёт
  // комната A; и тут ложится позднее взятие B: реестр отвечает «держит A». Ответ судился как у держателя — «ИНЦИДЕНТ: забег комнаты B кластер
  // числит за A» (`b-run-lock-lost`), хотя B его давно отпустила и ни одна комната node-1 его не ведёт. Теперь, как у удара сердца (перепрогон
  // R15, `node.ts`): инцидент — только если нода держит забег и ПОСЛЕ ответа (`RoomManager.runLost`). Сжато фаззером (сид 61240168, 200 → 22).
  const lateClaimOfGoneRoom: Op[] = [
    { k: 'crashAt', n: 1, calls: 7 },
    { k: 'join', h: 0, mode: 'fresh', r: 0.45040593831799924, reuse: true, via: 'x' },
    { k: 'join', h: 2, mode: 'resume', r: 0.5666741114109755, reuse: false, via: 1 },
    { k: 'restart', n: 1 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'join', h: 4, mode: 'friend', r: 0.254159381845966, reuse: false, via: 'gw' },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'join', h: 3, mode: 'friend', r: 0.5351026188582182, reuse: true, via: 'gw' },
    { k: 'descend', h: 3, r: 0.03225226211361587, others: 'yes', near: true, pause: false, diff: 3 },
    { k: 'join', h: 2, mode: 'friend', r: 0.9077202095650136, reuse: false, via: 'gw' },
    { k: 'town', h: 2, others: 'yes', near: true, pause: true },
    { k: 'close', h: 2 },
    { k: 'join', h: 4, mode: 'resume', r: 0.893286477541551, reuse: true, via: 'gw' },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'descend', h: 3, r: 0.4563995716162026, others: 'none', near: false, pause: true },
    { k: 'leave', h: 4 },
    { k: 'kill', h: 3, body: false },
    { k: 'join', h: 4, mode: 'resume', r: 0.6593794876243919, reuse: false, via: 'gw' },
    { k: 'status', h: 2, via: 'gw' },
    { k: 'abandon', h: 4, via: 'gw', ask: true },
    { k: 'solo', h: 4 },
    { k: 'join', h: 2, mode: 'resume', r: 0.25555245485156775, reuse: false, via: 'x' },
  ];
  fixedRoot('перепрогон Z3: позднее взятие забега ушедшей комнатой, легшее после взятия другой нодой, — не «инцидент»', 61240168, lateClaimOfGoneRoom, 'b-run-lock-lost');
  // МОДЕЛЬ ФАЗЗЕРА — сервер прав (сид 61330229, `DM_FUZZ_ADMIN=0`, сжато до 14). В городе держателя h3 подбирает вещь, выброшенную соседом по
  // аккаунту (подъём ждёт записи поднявшего — K3, а та ждёт медленный свод — `ledgerSlow`, K2), и жмёт «Продолжить без пати» тем же сокетом
  // (`leave`, статус, `join{resume, solo}`) — вход тоже ждёт свод (R18-02). Отказ подъёма («Нет персонажа»: он уже вышел) долетает после кадра
  // входа, и модель сняла вход «отвеченным»: любой `error` на сокете после кадра лобби считался его ответом. Когда свод лёг, держатель
  // отпустил забег его «Соло» — входа в пути модель уже не видела: `5-resume-split` («отпустила простому «Продолжить»»). Отказ КОМАНДЫ
  // (`error{cmd}`) — ответ комнаты, а не лобби (`lobbyAnswer`).
  fixedRoot('перепрогон Z3 (модель): ответ на сделку, долетевший после «Продолжить без пати», — не ответ на вход', 61330229, [
    { k: 'recruit' },
    { k: 'recruit' },
    { k: 'join', h: 1, mode: 'friend', r: 0.3241847394965589, reuse: true, via: 'gw' },
    { k: 'join', h: 0, mode: 'friend', r: 0.7116336948238313, reuse: false, via: 'gw' },
    { k: 'join', h: 3, mode: 'friend', r: 0.5395600765477866, reuse: true, via: 'gw' },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 20_000 },
    { k: 'descend', h: 0, r: 0.04145006835460663, others: 'yes', near: false, pause: true },
    { k: 'town', h: 1, others: 'no', near: true, pause: true },
    { k: 'leave', h: 0 },
    { k: 'step', n: 10 },
    { k: 'town', h: 3, others: 'yes', near: true, pause: true },
    { k: 'trade', h: 1, r: 0.19964732602238655 },
    { k: 'descend', h: 3, r: 0.42145679076202214, others: 'no', near: false, pause: true, diff: 2 },
    { k: 'solo', h: 3 },
  ], '5-resume-split');
  it('самопроверка Z3: ответ взятия судится без держателя (как до правки) — `b-run-lock-lost`', async () => {
    teeth.z3lost = true;
    try {
      expect((await replay(61240168, lateClaimOfGoneRoom)).map((v) => v.inv)).toContain('b-run-lock-lost');
    } finally { teeth.z3lost = FUZZ_SELFTEST === 'z3lost'; }
  });
  // ── Перепрогон Z4 (30.09, свежие диапазоны 71 110 001…, длинные простои), МОДЕЛЬ ФАЗЗЕРА — сервер прав (сид 71110102, сжато до 19). В городе
  // h3 поднимает вещь, выброшенную h0 (K3: в сумку — только после записи поднимающего), а запись ждёт медленную пачку свода (`ledgerSlow`,
  // K2); h3 тут же уходит «Продолжить» (вход не удался), h0 и h2 закрывают вкладки — пустую комнату снимают, пока запись подъёма ещё в пути.
  // `groundGone` числил вещь поднимаемой (`carryGone`), но проверка по концу записи видела только живые комнаты и строки базы и списывала её
  // стоком («земля ушедшего этажа»); легла запись — вещь в строке h3 (`1-sunk-item-back`). Фаззер одной ноды это знает с перепрогона R16
  // (запись в пути — `db.pending`); у кластера запись ждёт свод ещё в комнате — место вещи, пока подъём снятой комнаты не кончился (`carrying`
  // у её живого процесса), — подъём. Умер процесс — ушла с землёй (сток), как и прежде.
  fixedRoot('перепрогон Z4 (модель): подъём, чья запись ждёт свод, пока пустую комнату сняли, — вещь в пути, а не сток', 71110102, [
    { k: 'join', h: 0, mode: 'friend', r: 0.6373772723600268, reuse: false, via: 'gw' },
    { k: 'recruit' },
    { k: 'descend', h: 0, r: 0.2757713492028415, others: 'no', near: true, pause: true },
    { k: 'join', h: 4, mode: 'code', r: 0.47176716290414333, reuse: true, via: 'gw' },
    { k: 'join', h: 3, mode: 'friend', r: 0.11850481573492289, reuse: true, via: 'x' },
    { k: 'town', h: 0, others: 'none', near: false, pause: true },
    { k: 'suspend', n: 1, ms: 200_000, wall: true, mid: 'claims' },
    { k: 'step', n: 90 },
    { k: 'drop', h: 0, r: 0.8634551672730595 },
    { k: 'fault', f: 'ledgerSlow', h: null, ms: 20_000, fail: true },
    { k: 'join', h: 2, mode: 'friend', r: 0.06534162536263466, reuse: true, via: 'gw' },
    { k: 'descend', h: 2, r: 0.33037478290498257, others: 'none', near: true, pause: false, diff: 2 },
    { k: 'descend', h: 0, r: 0.7996079311706126, others: 'yes', near: true, pause: true, diff: 2 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'solo', h: 4 },
    { k: 'pickup', h: 3, r: 0.4610639156308025 },
    { k: 'join', h: 3, mode: 'resume', r: 0.646229220321402, reuse: true, via: 'gw' },
    { k: 'close', h: 0 },
    { k: 'close', h: 2 },
  ], '1-sunk-item-back');
  // СЕРВЕР — сирота строки забега (сид 71220185, `DM_FUZZ_ADMIN=0`; ужато до 13). node-0 на паузе машины; h0 входит на node-1 (комната B) и
  // зовёт продолжение своего забега из города — взятие уходит в реестр и ляжет поздно (сбой `late`); h0 закрывает вкладку, пустая B забег
  // отпускает (отпуск ничего не снял — строка ещё за node-0). h1 «Продолжить» — комната C той же node-1 законно берёт забег. Тут ложится
  // позднее взятие B: реестр пишет строку той же ноды на ушедшую B; ответ будит продолжение B, та отдаёт взятое (`runDropped`), и менеджер
  // переписывает строку на держателя C (`settleRun`) — а эта вставка падает (сбой реестра `fail`). Держи C забег до удара — строку переписало бы
  // продление (`touchRuns`), но h1 погибает (вайп): отпуск C снимает строку только за СВОЕЙ комнатой, а строка за ушедшей B, никем не
  // продлеваемая, живёт до простоя — «Продолжить» соседней ноды ведёт в комнату, которой нет (`b-run-lock-orphan`, до конца прогона). Теперь
  // такую строку помнит менеджер (`RoomManager.runsStale`), и удар, когда забег здесь не держит никто, её снимает. Модель: упавшее взятие на
  // держателя чинит удар — до него строка не сирота (`claimFailedAt`, как повтор упавшего отпуска).
  const staleRow: Op[] = [
    { k: 'join', h: 1, mode: 'friend', r: 0.5087329656817019, reuse: false, via: 'x' },
    { k: 'descend', h: 1, r: 0.7573729315772653, others: 'none', near: false, pause: false },
    { k: 'join', h: 0, mode: 'friend', r: 0.4320579443592578, reuse: false, via: 'gw' },
    { k: 'regFault', op: 'claimRun', kind: 'late', n: 1 },
    { k: 'suspend', n: 0, ms: 200_000, wall: true, mid: 'claims' },
    { k: 'join', h: 0, mode: 'fresh', r: 0.9865288310684264, reuse: true, via: 'gw' },
    { k: 'descend', h: 0, r: 0.6933347114827484, others: 'no', near: true, pause: false },
    { k: 'close', h: 0 },
    { k: 'join', h: 1, mode: 'resume', r: 0.8009746540337801, reuse: true, via: 'gw' },
    { k: 'regFault', op: 'claimRun', kind: 'fail', n: 1 },
    { k: 'attack', h: 1, r: 0.9743402905296534, weaken: false },
    { k: 'attack', h: 1, r: 0.9577115040738136, weaken: false },
  ];
  fixedRoot('перепрогон Z4 (модель): строку, переписанную поздним взятием ушедшей комнаты, пока держатель держит, чинит удар — не сирота до него', 71220185, staleRow, 'b-run-lock-orphan');
  fixedRoot('перепрогон Z4: держатель отпустил забег раньше удара — строку за ушедшей комнатой снимает удар, а не простой', 71220185, [
    ...staleRow,
    { k: 'kill', h: 1, body: false },
  ], 'b-run-lock-orphan');
  it('самопроверка Z4: удар не помнит строку за ушедшей комнатой (как до правки) — `b-run-lock-orphan`', async () => {
    teeth.z4stale = true;
    try {
      expect((await replay(71220185, [...staleRow, { k: 'kill', h: 1, body: false }])).map((v) => v.inv)).toContain('b-run-lock-orphan');
    } finally { teeth.z4stale = FUZZ_SELFTEST === 'z4stale'; }
  });
});
