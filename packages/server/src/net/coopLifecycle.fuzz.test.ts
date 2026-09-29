import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { GameConn } from './conn.js';
import {
  ConfigRegistry, newCharacterSave, generateItem, itemFromBaseId, createRng, playerSnapshot, packInventory, findFree, stashDims,
  isWalkableWorld, hasLineOfSight, isDifficultyUnlocked, Cell, TILE,
  type ServerFrame, type SaveState, type Item, type RunConfig, type RunPlan, type RunNodeState, type PlayerInput, type Grid, type AccountStash,
} from '@dm/shared';
import { counters } from './metrics.js';
import { limits } from './rateLimit.js';
import { tickScheduler, type Tickable } from './scheduler.js';
import { fuzzRng, mixSeed, shrinkOps, type FuzzRng } from './coopLifecycle.fuzzKit.js';

/**
 * ⭐ B1: ФАЗЗЕР ЖИЗНЕННОГО ЦИКЛА КООПА — модельный: настоящие `RoomManager` и `Room` (кадры строкой, как из сокета, весь путь менеджера),
 * маленькая честная база (версии сейва и сундука, исход фиксации неизвестен, сбой записи), поддельные часы. Сид даёт
 * последовательность операций (вход/возврат/по коду/«Продолжить»/«Завершить», выход и обрыв посреди боя, урон и смерть, зелья, бой,
 * голосования за спуск/город/арену, финал у портала, передача вещи соседу по аккаунту через землю, сундук, сбои записи, ход времени до
 * конца грейса), и после КАЖДОЙ операции (и в конце, когда все ушли и таймеры отработали) проверяются инварианты целостности:
 *  1 — вещь (uid) в одном месте: сейвы (правда героя — копия в памяти, если нода её держит, иначе строка базы), сундуки, земля; и не
 *      пропадает иначе, чем законным стоком (продажа, штраф смерти, земля ушедшего этажа); взятое стоком не возвращается;
 *  2 — мёртвый не оживает на том же экземпляре этажа (оживляют смена этажа, город, арена);
 *  3 — штраф смерти — один за смерть; без штрафа тому, кто ушёл спокойно (из города, припаркованный забег, спокойный уход из боя);
 *      ⭐ C-03: и НЕ МЕНЬШЕ — «Завершить» забега ожившего героя (пати увела его дальше или в город, вошёл живым) штраф берёт
 *      (`3-missing-penalty`); ⭐ C-04: похороны комнаты (вайп, грейс, уход пати с этажа) не штрафуют и не снимают чужой ей забег
 *      (`3-foreign-run-buried`); ⭐ R16 C-03: зато в подземелье — только участники его забега (`3-dungeon-foreign-run`: гость с чужим ей
 *      забегом был вне правил бегства), и сбежавшего посреди боя без штрафа не отпускает никто (`3-fled-released`); ⭐ R16-01: штраф за
 *      брошенный забег берёт только «Завершить» (и похороны — истёкший грейс, вайп, уход пати): вход, чей бросок стоил бы штрафа, — отказ
 *      (`3-unjustified-penalty`; операция `unity` — клиент Unity: статус забега и `join{fresh}` подряд после обрыва, из своего потока);
 *  4 — здоровье/мана/выносливость не выше максимума и не растут даром (выход/вход, код, арена, город) сверх регена и зелий; ⭐ R16-07: и
 *      временный бафф не живёт дольше своего срока по часам мира, пока герой в комнате (`4-buff-outlived`: арена — время города; операция
 *      `shout` — бафф живому, из своего потока);
 *  5 — никто не застревает: в конце каждый герой проходит «статус → Завершить (если забег) → вход» и стоит в городе; ⭐ C-04: «Продолжить»
 *      припаркованного не сажает в комнату, чей забег — не его (`5-resume-foreign-run`); ⭐ C-05: у забега в сейве всегда есть путь в игру без
 *      штрафа — «Продолжить» входит или отказывает С КОДОМ комнаты, что держит его забег, а на «нет мест» «Соло» — город, забег цел
 *      (`5-resume-dead-end`; проверяется и перед эпилогом, пока комнаты живы; пятый герой — операция `recruit`, из своего потока); ⭐ R17-02: и
 *      продолжить свой забег можно без голоса другого подключённого, если забег не в подземелье: «Продолжить» не сажает живого участника в
 *      город (арену) держателя, где его спуск ждал бы голоса напарника (`5-run-hostage`; раньше стоящий в городе держал чужой забег заложником
 *      до «Забросить»); ⭐ R16 C-09:
 *      экран «Продолжить / Забросить» не врёт о цене — статус забега сказал «погиб в нём, штраф взят» (`dead`) ⇔ «Завершить» с того же
 *      экрана штрафа не берёт (`5-status-promise`; «статус перед Завершить» — флаг `ask` операции `abandon`, из своего потока);
 *  6 — ничего не бросает (исключения команд и кадров, шага комнаты, необработанные отказы) и не виснет: операция и эпилог кончаются за
 *      30 и 120 с настоящего времени (`6-hang`, сторож — как у фаззера кластера);
 *  7 — у героя одна пишущая копия во всех комнатах; живая сессия держит версию базы (не зомби); ⭐ C-06: закрытое соединение — не
 *      сессия сразу, а не в конце очереди своих кадров (`7-closed-still-live`); ⭐ R15-02: прощальная запись — последняя запись сессии: после
 *      того как она легла, ни одна запись этой сессии не ложится (`7-write-after-farewell`; медленные записи — сбой `slow` и операция
 *      `dropLeave` «выброс в пути, автосейв ждёт, второй выброс за ним, обрыв посреди боя» — из своего потока `lag`);
 *  8 — прогресс забега: глубина сложности и указатель — только достигнутые узлы, не назад; записи узла (сундуки, убитые) не теряются
 *      на входе в узел и одно не берётся дважды; ⭐ C-12: новый забег — в тире, открытом хоть одному из подключённых (`8-tier-locked-start`;
 *      ветераны — операция `veteran`, тир спуска — поле `diff`: оба — из своего потока чисел, основной поток операций они не сдвигают);
 *  9 — ⭐ R16-04: окно голосования ≡ исход. Кадр `voteStart` спуска в подземелье говорит, куда ведёт (`finish` — завершение забега,
 *      иначе узел цели и его тип; `9-vote-blind`), и принятое голосование ведёт ровно туда (`9-vote-misleads`): окно напарника — текст
 *      из этого кадра (`client/ui/voteText.ts`), и раньше финал звал «спуском», а принявший уходил в город.
 *
 * Умолчание — фиксированные сиды (полный прогон — секунды). `DM_FUZZ_SEEDS=N` — N сидов подряд с `DM_FUZZ_SEED0` (по умолчанию 1),
 * `DM_FUZZ_OPS` — длина последовательности, `DM_FUZZ_FAULTS=0` — без сбоев базы, `DM_FUZZ_SHRINK=0` — без сжатия,
 * `DM_FUZZ_SHRINK_KNOWN=1` — сжимать и известные корни, `DM_FUZZ_TRACE=1` — печатать операции и состояние после каждой (с
 * `DM_FUZZ_TRACE_LOG=1` — и лог комнаты и менеджера за операцию), `DM_FUZZ_LOG=<файл>` — нарушения сразу в файл (большой прогон),
 * `DM_FUZZ_HEAP=N` — куча каждые N сидов, `DM_FUZZ_SELFTEST=v1|v2|c03|c04|c05|c06|c12|r16c03|c09|r1502|r1502tx|r1601|r1607|r1604|r1702` — самопроверка (вернуть исправленный корень —
 * фаззер обязан найти),
 * `DM_FUZZ_REPLAY='{"seed":…,"ops":[…]}'` — повтор последовательности. Нарушение печатается с сидом и СЖАТОЙ последовательностью
 * (выбрасываются куски, пока нарушение с той же меткой воспроизводится). Большой прогон — параллельно, диапазонами сидов:
 *   DM_FUZZ_SEEDS=200 DM_FUZZ_SEED0=10000 npx vitest run packages/server/src/net/coopLifecycle.fuzz.test.ts
 * Известные, ещё не исправленные корни — `KNOWN` и тесты `it.fails` в конце файла. Найденные этим фаззером V1, V2, V3 исправлены (проход
 * правок 1): их сжатые последовательности в конце файла — обычные тесты, а метки — снова под основным прогоном.
 *
 * Прогон детерминирован: сиды, коды, uid, поток бросков сессии — от сида (`node:crypto`, `Math.random`), часы поддельные, комнаты шагает
 * фаззер (`stepAll`), лимиты частоты сняты (операции идут быстрее живого клиента). Внутренности комнаты и менеджера — через приведение
 * типа (это тест), штраф смерти — через обёртку `applyDeathPenalty`, вход в узел и в комнату — обёртки методов `Room`.
 */

const FUZZ_SEEDS = Number(process.env.DM_FUZZ_SEEDS ?? 0) || 0;
const FUZZ_SEED0 = Number(process.env.DM_FUZZ_SEED0 ?? 1) || 1;
const FUZZ_OPS = Number(process.env.DM_FUZZ_OPS ?? 0) || 0;
const FUZZ_SHRINK = process.env.DM_FUZZ_SHRINK !== '0';
const FUZZ_TRACE = process.env.DM_FUZZ_TRACE === '1';
/** `DM_FUZZ_FAULTS=0` — без сбоев базы: весь бюджет операций — на игру (пути без сбоев глубже). */
const FUZZ_FAULTS = process.env.DM_FUZZ_FAULTS !== '0';
/**
 * `DM_FUZZ_LOG=<файл>` — строки нарушений (`@@V`) и сжатые отчёты ещё и в файл, СРАЗУ: вывод воркера vitest печатается только в конце теста,
 * и большой прогон, упавший посреди (память, таймаут), терял всё найденное. `DM_FUZZ_HEAP=N` — куча воркера каждые N сидов (с
 * `--expose-gc` — после сборки): рост от сида к сиду — утечка.
 */
const FUZZ_LOG = process.env.DM_FUZZ_LOG;
const FUZZ_HEAP = Number(process.env.DM_FUZZ_HEAP ?? 0) || 0;
/** `DM_FUZZ_SELFTEST=v1|v2` — вернуть исправленный корень (см. `beforeAll`): прогон обязан упасть на его метках. */
const FUZZ_SELFTEST = process.env.DM_FUZZ_SELFTEST ?? '';
/** ⭐ R17-02: самопроверка `r1702` (держатель в городе забег не отдаёт) — и из теста: зубы `5-run-hostage` идут в прогоне по умолчанию. */
const teeth = { r1702: FUZZ_SELFTEST === 'r1702' };
function logLine(s: string): void { if (FUZZ_LOG) appendFileSync(FUZZ_LOG, `${s}\n`); }
vi.setConfig({ testTimeout: FUZZ_SEEDS ? 24 * 3600_000 : 120_000 });
/** Прогон по умолчанию (полный прогон тестов): сиды и длина — секунды на машине разработчика, без сжатия известного. */
const DEFAULT_SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i);
const DEFAULT_OPS = 120;

// ── Детерминированные броски окружения ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * Комната берёт сиды, коды, ключи этажей и поток бросков сессии из криптоисточника, а uid вещей — из `Math.random`: для повтора и
 * сжатия они обязаны идти от сида прогона. Поток — mulberry32 (копия `coopLifecycle.fuzzKit.ts`: `vi.hoisted` не видит импортов).
 */
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

// ── Штраф смерти — под наблюдением ─────────────────────────────────────────────────────────────────────────────────────────────
/** Кто и откуда взял штраф смерти (стек — чтобы понять путь: смерть в мире, «Завершить», похороны, запись по строке базы). */
const spy = vi.hoisted(() => ({
  onPenalty: null as null | ((save: SaveState, removed: string[], goldLost: number, stack: string) => void),
}));
vi.mock('@dm/shared', async (importOriginal) => {
  const m = await importOriginal<typeof import('@dm/shared')>();
  return {
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
});

/** Невидимое поле сейва — номер прогона, в котором его прочитали из базы (`db.run`). */
const RUN_TAG = '__fuzzRun';
// ── Маленькая честная база ─────────────────────────────────────────────────────────────────────────────────────────────────────
type FaultKind = 'fail' | 'deadlock' | 'unknownLost' | 'unknownLanded' | 'stashConflict' | 'slow';
/**
 * Строка героя — JSON сейва и версия (как `characters.data`/`version`), сундук — JSON и версия (D8), свод забега — объединением
 * (`run_ledger`). Сбои записи — очередью (`faults`): следующая подходящая запись (любого героя или названного) упадёт так, как
 * названо: `fail` — до фиксации, `deadlock` — 40P01 (повторяемо), `unknownLost` — исход неизвестен и НЕ легла, `unknownLanded` —
 * исход неизвестен и ЛЕГЛА (чтение строки после тоже не ответило), `stashConflict` — сундук обогнали (только запись с сундуком).
 * ⭐ R15-02: `slow` — не сбой, а медленная база: запись ждёт до операции `until` (или хода времени `wait`/`retry`, эпилога) и ложится как
 * обычно; за ней в очередь героя встают выброс, разбор, автосейв и уход — порядок записей очереди, а не их исход.
 */
const db = vi.hoisted(() => ({
  rows: new Map<string, { userId: string; json: string; version: number }>(),
  stash: new Map<string, { json: string; version: number }>(),
  ledger: new Map<string, Map<string, { id: string; el: number; chests: number[]; killed: number[]; levers: number[] }>>(),
  sessions: new Map<string, string>(),
  faults: [] as { kind: FaultKind; charId?: string; until?: number }[],
  consumed: 0,
  /** ⭐ R15-02: записи, ждущие медленной базы (`slow`), — ворота и операция, в начале которой они открываются. */
  held: [] as { open: () => void; until: number }[],
  /** Номер прогона: сейвы, прочитанные из базы, помечены им (невидимым полем) — штраф на сейве прошлого прогона не его. */
  run: 0,
  /** Подряд записей героя с неизвестным исходом фиксации (без записи, прошедшей обычно, между ними) — и герои, у кого их было ≥ 2 (V3). */
  unknownStreak: new Map<string, number>(),
  doubleUnknown: new Set<string>(),
  /** Записи сейва с начала текущей операции (фаззер чистит перед каждой): легла ли запись штрафа. */
  writes: [] as { charId: string; v: number; ok: boolean; reason: string; stash: boolean; json?: string }[],
  /** ⭐ R15-02: снимки записей, ждущих медленную базу (`slow`), — они лягут: штраф такой записи взят, а не «не лёг». */
  pending: new Set<string>(),
}));
vi.mock('../db/db.js', async () => {
  const { CommitUnknown } = await import('../db/errors.js');
  const take = (charId: string, withStash: boolean): Promise<FaultKind | undefined> | FaultKind | undefined => {
    const i = db.faults.findIndex((f) => (f.charId === undefined || f.charId === charId) && (withStash || f.kind !== 'stashConflict'));
    if (i < 0) return undefined;
    const e = db.faults.splice(i, 1)[0]!;
    // ⭐ R15-02: медленная база — не сбой (счёт сбоев `consumed` не трогает): запись ждёт своих ворот и идёт дальше без сбоя.
    if (e.kind === 'slow') return new Promise<void>((open) => { db.held.push({ open, until: e.until ?? 0 }); }).then(() => undefined);
    db.consumed++;
    const kind = e.kind;
    if (kind === 'unknownLost' || kind === 'unknownLanded') {
      const n = (db.unknownStreak.get(charId) ?? 0) + 1;
      db.unknownStreak.set(charId, n);
      if (n >= 2) db.doubleUnknown.add(charId);
    }
    return kind;
  };
  const unknown = (json: string): Error => { const e = new CommitUnknown(new Error('Query read timeout')); e.sent = json; return e; };
  const uniq = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);
  return {
    getSession: async (token: string) => db.sessions.get(token) ?? null,
    getCharacter: async (charId: string) => {
      const r = db.rows.get(charId);
      if (!r) return null;
      const data = JSON.parse(r.json) as SaveState;
      Object.defineProperty(data, RUN_TAG, { value: db.run, enumerable: false });   // не пишется (JSON) и не копируется (structuredClone)
      return { userId: r.userId, data, version: r.version };
    },
    putCharacter: async (charId: string, userId: string, data: SaveState, v: number, reason = 'autosave') => {
      const json = JSON.stringify(data);
      const t = take(charId, false);
      if (t instanceof Promise) db.pending.add(json);
      const f = t instanceof Promise ? await t.finally(() => db.pending.delete(json)) : t;
      if (f === 'fail') throw new Error('база упала');
      if (f === 'deadlock') throw Object.assign(new Error('обнаружена взаимоблокировка'), { code: '40P01' });
      if (f === 'unknownLost') throw unknown(json);
      const r = db.rows.get(charId);
      if (!r || r.userId !== userId || r.version !== v) { db.writes.push({ charId, v, ok: false, reason, stash: false }); return null; }
      r.version = v + 1; r.json = json;
      db.writes.push({ charId, v, ok: true, reason, stash: false, json });
      if (f !== 'unknownLanded') db.unknownStreak.delete(charId);
      if (f === 'unknownLanded') throw unknown(json);
      return r.version;
    },
    putCharacterWithStash: async (charId: string, userId: string, data: SaveState, v: number, stash: AccountStash, sv: number, reason = 'stash') => {
      const json = JSON.stringify(data);
      const t = take(charId, true);
      if (t instanceof Promise) db.pending.add(json);
      const f = t instanceof Promise ? await t.finally(() => db.pending.delete(json)) : t;
      if (f === 'fail') throw new Error('база упала');
      if (f === 'deadlock') throw Object.assign(new Error('обнаружена взаимоблокировка'), { code: '40P01' });
      if (f === 'stashConflict') return { ok: false, conflict: 'stash' };
      if (f === 'unknownLost') throw unknown(json);
      const r = db.rows.get(charId);
      if (!r || r.userId !== userId || r.version !== v) { db.writes.push({ charId, v, ok: false, reason, stash: true }); return { ok: false, conflict: 'save' }; }
      const st = db.stash.get(userId);
      if (sv !== (st?.version ?? 0)) return { ok: false, conflict: 'stash' };
      r.version = v + 1; r.json = json;
      db.stash.set(userId, { json: JSON.stringify(stash), version: sv + 1 });
      db.writes.push({ charId, v, ok: true, reason, stash: true, json });
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
});
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve(process.env.DM_NODE_ID ?? 'node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

// ── Соединение ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class FakeConn implements GameConn {
  open = true;
  readonly ip = '127.0.0.1';
  frames: ServerFrame[] = [];
  closedWith?: number;
  /** Чей это сокет (номер героя) и в какую комнату он вошёл (кадр `joined`) — кадры смотрит прогон (`noteFrame`). */
  hero?: number;
  roomCode?: string;
  /** Прогон, заведший сокет: кадр сокету чужого (прошлого) прогона не его. */
  run?: number;
  /** ⭐ C-04: последний кадр лобби сокета — «Продолжить» (`join { resume }`). */
  resume?: boolean;
  /** ⭐ R16-04: открытое голосование, как его видит окно сокета: кадр, область комнаты в миг кадра, принято ли (`voteEnd`). */
  vote?: { f: Extract<ServerFrame, { t: 'voteStart' }>; area: string; passed: boolean };
  /** Наблюдатели прогона: кадр сокету и закрытие сокета сервером (4001 — вход из другого окна, 4009 — сессия устарела). */
  static onFrame: ((c: FakeConn, f: ServerFrame) => void) | null = null;
  static onServerClose: ((c: FakeConn, code?: number) => void) | null = null;
  private onMsg: (raw: string) => void = () => {};
  private onEnd: () => void = () => {};
  send(raw: string | Uint8Array): void {
    if (typeof raw !== 'string') return;
    const f = JSON.parse(raw) as ServerFrame;
    if (FUZZ_SELFTEST === 'c05' && f.t === 'error') delete f.roomCode;   // C-05: отказ без кода держателя — как до правки
    if (FUZZ_SELFTEST === 'c09' && f.t === 'runStatus') delete f.dead;   // R16 C-09: статус без «смерть оплачена» — как до правки
    if (FUZZ_SELFTEST === 'r1604' && f.t === 'voteStart') delete f.finish;   // R16-04: финал зовёт «спуском» — как до правки
    this.frames.push(f);
    FakeConn.onFrame?.(this, f);
    if (this.frames.length > 400) this.frames.splice(0, 200);
  }
  close(code?: number): void {
    if (!this.open) return;
    this.open = false; this.closedWith = code;
    FakeConn.onServerClose?.(this, code);
    this.onEnd();
  }
  onMessage(cb: (raw: string) => void): void { this.onMsg = cb; }
  onClose(cb: () => void): void { this.onEnd = cb; }
  push(frame: unknown): void { this.onMsg(JSON.stringify(frame)); }
  since(i: number): ServerFrame[] { return this.frames.slice(Math.max(0, i)); }
}

// ── Внутренности комнаты и менеджера, до которых дотягивается проверка (это тест) ────────────────────────────────────────────────
type Pt = { x: number; y: number };
type Derived = { maxHp: number; maxMana: number; maxStamina: number; hpRegen: number; manaRegen: number; staminaRegen: number };
type PlayerIn = {
  id: string; hp: number; maxHp: number; mana: number; stamina: number; alive: boolean; pos: Pt; vel: Pt; save: SaveState;
  debuffs: Record<string, unknown>; skillBuffs: Record<string, number>;
};
type MonIn = { id: number; alive: boolean; hp: number; pos: Pt; aiState: string };
type DropIn = { id: number; kind: string; item?: Item; pos: Pt; owner?: string };
type ClientIn = { pid: string; userId: string; saveVersion: number; stale: boolean; unsure: string[]; ws: GameConn };
type InfoIn = { save: SaveState; userId: string; saveVersion: number; paid: boolean; fled: boolean; fledDescend: boolean; safe?: boolean };
type RoomIn = Tickable & {
  code: string; area: 'town' | 'dungeon' | 'arena'; depth: number; difficultyId: string;
  clients: Map<string, ClientIn>; disconnected: Map<string, InfoIn>; lingering: Map<string, { pid: string; p: PlayerIn; info: InfoIn }>;
  staleFarewells: Map<string, { charId: string; farewell: { saved: boolean } }>;
  /** ⭐ K3: выброшенное, которое сейчас поднимают (`Room.pickThrown`: запись поднимающего в пути) — до её конца вещь не в сумке. */
  carrying: Set<DropIn>;
  runConfig: RunConfig | null; runPlan: RunPlan | null; runNodeId: string | null; nodeState: RunNodeState | null;
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
  /** V2: комната держит забег (ключ свода). */
  holdsRun(key: string): boolean;
};
type RmIn = {
  rooms: Map<string, RoomIn>; conns: Map<GameConn, { pid: string; room: RoomIn }>; live: Map<string, GameConn>;
  graceByChar: Map<string, RoomIn>; unsaved: Map<string, unknown>; inflight: Map<string, unknown>;
  retryUnsaved(now?: number): Promise<void>;
  handleConnection(ws: GameConn): void;
};

// ── Операции ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Where = 'entry' | 'exit' | 'portal' | 'away' | 'monster' | 'drop' | 'chest';
type Others = 'none' | 'yes' | 'no';
type Op =
  | { k: 'join'; h: number; mode: 'fresh' | 'resume' | 'code' | 'friend'; r: number; reuse: boolean }
  | { k: 'status'; h: number }
  /**
   * ⭐ R16 C-09: `ask` — экран входа: статус забега и «Завершить» с него же, одним соединением (кадры героя — по очереди), и что экран обещал
   * (`runStatus.dead` — «без штрафа»), то «Завершить» и сделало (`5-status-promise`). Флаг — из своего потока (`W.ask`).
   */
  | { k: 'abandon'; h: number; ask?: boolean }
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
  /** `ops` — у медленной записи (`slow`): сколько операций она ждёт базу (R15-02). */
  | { k: 'fault'; f: FaultKind; h: number | null; ops?: number }
  /**
   * ⭐ R15-02: выброс, чья запись в пути (медленная база), автосейв ждёт очереди, второй выброс встаёт за ним — и обрыв (`fight` — посреди
   * боя: рядом монстр в погоне, тело остаётся в бою). Прощальная запись обязана лечь последней. Из своего потока (`W.lag`).
   */
  | { k: 'dropLeave'; h: number; r: number; fight: boolean }
  | { k: 'retry' }
  /** ⭐ C-12: герой, которого нода ничем не держит, наиграл глубину тира `tier` где-то ещё (другая нода) — строка базы уже с ней. */
  | { k: 'veteran'; h: number; tier: number; depth: number }
  /**
   * ⭐ C-05: в мир приходит ещё один герой (до `HEROES_MAX`): пятый — это пати на потолке и один вне её. Без него отказ «нет мест»
   * «Продолжить» (пати забега полна, V2) был недостижим — героев в мире было не больше потолка пати.
   */
  | { k: 'recruit' }
  /**
   * ⭐ R16-01: клиент Unity (`NetClient.Connect`) — статус забега и `join{fresh}` подряд, одним соединением, ответа на статус не читая. Честный:
   * так он входит после любого обрыва (вылет, Wi-Fi, Alt+F4). Из своего потока (`W.unity`).
   */
  | { k: 'unity'; h: number }
  /** ⭐ R16-07: временный бафф (`FZ_BUFF_SEC`) живому в городе или подземелье — как клич; из своего потока (`W.shout`). */
  | { k: 'shout'; h: number };

/** `cause` — известный корень (см. `KNOWN`), если нарушение объясняется им; иначе нарушение — новое. */
interface Violation { inv: string; msg: string; op: number; seed: number; faults: number; cause?: string }
interface Hero {
  i: number; charId: string; userId: string; token: string;
  conn: FakeConn | null; cmd: number;
  /** Последняя виденная копия героя в памяти (сессии, ждущего реконнекта) — правда, пока менеджер её дописывает (`truthOf`). */
  lastSave?: SaveState;
  /** Пулы на прошлом наблюдении (null — следующий вправе быть любым: ожил, уровень, зелье, бой). */
  cap: { hp: number; mana: number; stamina: number; at: number } | null;
  level: number; xp: number;
  /** Экземпляры этажей, где его видели мёртвым. */
  deadOn: Set<string>;
  /**
   * 3: порядок событий героя (`W.ev`): последний засчитанный штраф и последнее оживление (жив в мире не на арене, забег увели в город).
   * Штраф позже оживления — «жизнь оплачена»: следующий штраф в неё — второй. Порядок — по событиям, а не по операциям: в одной операции
   * бывает и смерть, и спуск пати (оживление), и снятие сессии.
   */
  penaltyEv: number; revivedEv: number; revivals: number[];
  reached: Set<string>; depthMax: Map<string, number>; progMax: Map<string, number>;
  wasDead: boolean;
  /**
   * 2: погиб в забеге (`deadRun` — ключ свода) на экземпляре этажа `deadInst` комнаты `deadRoom` и с тех пор не оживал: эта комната этаж
   * не меняла (спуск, город, вайп оживляют — и тех, кто ждёт реконнекта). Войти живым в ТОТ ЖЕ забег в другой комнате — даровое воскрешение.
   */
  deadRun: string | null; deadRoom: RoomIn | null; deadInst: string | null;
  /** Сессию сняли «устаревшей» (4009), когда он был мёртв, и с тех пор он не оживал (см. `causeOf`, V1). */
  droppedDead: boolean;
  /** ⭐ C-03: последний засчитанный штраф (его забег и забег комнаты смерти — `guestDeath`). */
  lastPen: Penalty | null;
  /**
   * ⭐ C-03: когда (`W.ev`) его последний раз видели мёртвым не на арене. Мёртв — значит смерть уже оплачена (смерть в бою, или комната сочла
   * его погибшим — страховка, «Завершить», похороны, R13-04 — и вход к ней вернул его мёртвым): «Завершить» в эту смерть штрафа не должно.
   */
  deadSeenEv: number;
  /**
   * ⭐ R16-07: бафф операции `shout` — у какой сущности и в какой комнате, и к какому часу мира этой комнаты он обязан кончиться. Пока герой
   * этой же сущностью в этой комнате (арена — та же комната), бафф не живёт дольше; ушёл (запись ухода — время для него стоит, R4-06) — забыт.
   */
  buff: { room: RoomIn; p: PlayerIn; end: number } | null;
}
interface PreState {
  kind: 'live' | 'disc' | 'off'; area?: string; alive?: boolean; safe?: boolean; paid?: boolean; fled?: boolean; fledDescend?: boolean; body?: boolean;
  /** ⭐ C-03: забег копии ждущего — не забег комнаты (гость со своим): его смерть там забег не оплатила. */
  foreign?: boolean;
}
/**
 * Штраф, взятый с объекта сейва `save` (копия в памяти или строка, прочитанная из базы для записи по ней); `ev` — его место в порядке событий.
 * ⭐ C-03: `run` — забег сейва в миг штрафа (его бросают «Завершить» и похороны), `where` — у смерти (бой, тело) забег комнаты, где он погиб.
 */
interface Penalty { charId: string; removed: string[]; gold: number; src: string; op: number; save: SaveState; ev: number; run: string | null; where: string | null }
interface W {
  seed: number; heroes: Hero[]; rm: RmIn; rng: FuzzRng;
  /**
   * ⭐ C-12: свой поток чисел — ветераны (`veteran`) и тир спуска (`diff`). Основной (`rng`) они не трогают: последовательность
   * прежних операций та же, новые лишь вставлены между ними.
   */
  aux: FuzzRng;
  /** ⭐ C-05: свой поток и у новых героев (`recruit`) — прежние операции и ветераны идут как шли, новые лишь вставлены. */
  crew: FuzzRng;
  /** ⭐ R16 C-09: свой поток и у «статус перед Завершить» (`abandon.ask`) — последовательность операций та же. */
  ask: FuzzRng;
  /** ⭐ R15-02: свой поток и у медленных записей (`slow`, `dropLeave`) — последовательность прежних операций та же. */
  lag: FuzzRng;
  /** ⭐ R16-01: свой поток и у входа клиента Unity (`unity`) — последовательность прежних операций та же. */
  unity: FuzzRng;
  /** ⭐ R16-07: свой поток и у баффов (`shout`) — последовательность прежних операций та же. */
  shout: FuzzRng;
  /** ⭐ R15-02: сессии (клиенты комнат), чья прощальная запись легла, — их записи больше не ложатся (`7-write-after-farewell`). */
  saidBye: WeakSet<object>;
  /**
   * ⭐ R16 C-09: «Завершить» операции со статусом перед ним (`abandon.ask`): соединение, герой, чисто ли (ни его кадров лобби в очереди, ни
   * живой сессии, сбоев базы на начало — `faults`), и что сказал статус в миг ответа (`st`: `dead`, есть ли забег, жива ли сессия, и есть ли
   * забег у копии, которую «Завершить» бросит, — грейс-копия или строка базы).
   */
  asked: {
    conn: FakeConn; charId: string; quiet: boolean; faults: number;
    st?: { dead: boolean; hasRun: boolean; live: boolean; hadRun: boolean; grace: boolean };
  } | null;
  /** ⭐ C-03: штрафов, взятых с героя за прогон (не сбрасывается проверкой): «Завершить» ожившего обязано его сдвинуть. */
  penaltyCount: Map<string, number>;
  ticking: Set<RoomIn>; lobbies: FakeConn[];
  /** Комнаты этого прогона (конструктор ставит комнату на тик): обёртки методов комнаты смотрят только их. */
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
  /** Чей штраф взял вещь (для корня нарушения, если она вернётся уже не к нему — на землю, соседу). */
  sunkBy: Map<string, string>;
  /** Проданное за операцию (законный сток). */
  sold: Set<string>;
  /** ⭐ R15-02: продажи без ответа — ответ `ok` кладёт вещь в `sold` той операции, где он пришёл. */
  selling: { conn: FakeConn; id: number; uid: string }[];
  /** ⭐ R15-02: вещи, снятые штрафом, чья запись ждёт медленную базу, — сток, когда уйдут (запись дошла). */
  sinkLater: Set<string>;
  /** Один забег уже шёл в подземелье двух комнат сразу (см. `causeOf`, V2). */
  concurrent: boolean;
  /** Счётчик событий прогона (штраф, оживление) — их порядок внутри операции. */
  ev: number;
  /** ⭐ R16-09: счётчик событий на начало операции (`preState`): оживление после него и раньше штрафа — внутри операции, до штрафа. */
  opEv0: number;
  recs: Map<string, { chests: Set<number>; killed: Set<number> }>;
  roomSeen: WeakMap<RoomIn, { key: string; st: RunNodeState; chests: Set<number>; killed: Set<number> }>;
  ids: WeakMap<object, number>; idSeq: number;
  errors: string[]; cmdFailed0: number; frameErrors0: number;
  op: number; opRef: Op | null; stepped: boolean;
}

let RM: typeof import('./roomManager.js').RoomManager;
let forgetTownStocks: typeof import('./room.js').forgetTownStocks;
let runLedgerKey: typeof import('./room.js').runLedgerKey;
let cfg: ConfigRegistry;
/** Прогон, который сейчас идёт (спаи штрафа и планировщика пишут в него). */
let cur: W | null = null;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const drain = async (n = 2): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };
/** Настоящие часы (до подмены): сторож зависшей операции. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
class Hang extends Error {}
/**
 * ⭐ Сторож (как у фаззера кластера): операция (или эпилог) не закончилась за `ms` НАСТОЯЩЕГО времени — это ожидание, которое не кончится
 * (цепочка ждёт то, чего не будет: очередь записей героя, кадр, запись): нарушение `6-hang`, прогон обрывается. Без сторожа такой сид молча
 * вешал весь процесс большого прогона (перепрогон после правок раунда 15: три процесса из двенадцати).
 */
async function watchdog<T>(w: W, p: Promise<T>, what: string, ms = 30_000): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<never>((_, rej) => { t = realSetTimeout(() => rej(new Hang(what)), ms); });
  try { return await Promise.race([p, cap]); } catch (e) {
    if (e instanceof Hang) violate(w, '6-hang', `${what}: не закончилась за ${ms / 1000} с настоящего времени`);
    throw e;
  } finally { realClearTimeout(t); }
}
const rmOf = (w: W): RmIn => w.rm;
const tokenOf = (u: number): string => (u + 1).toString(16).padStart(2, '0').repeat(32);
const idOf = (w: W, o: object): number => { let v = w.ids.get(o); if (v === undefined) { v = ++w.idSeq; w.ids.set(o, v); } return v; };
const instOf = (w: W, room: RoomIn): string => `${idOf(w, room)}:${idOf(w, room.session.world.grid)}`;
const fmt = (op: Op): string => JSON.stringify(op);

function violate(w: W, inv: string, msg: string, h?: Hero): void {
  const key = `${inv}|${msg}`;
  if (w.seen.has(key)) return;
  w.seen.add(key);
  w.violations.push({ inv, msg, op: w.op, seed: w.seed, faults: db.consumed, cause: causeOf(w, inv, h) });
}
/**
 * Известный корень нарушения — по тому, что фаззер видел в этом прогоне:
 *  • `V1-dead-dropped` — погибшего (ждал пати мёртвым) сессию сняли «устаревшей» (4009: исход фиксации неизвестен, отказ по версии) —
 *    грейса нет, «мёртв и оплачено» нигде не записано, и вернулся он из базы живым (штраф второй раз на «Завершить», оживление на «Продолжить»);
 *  • `V2-run-in-two-rooms` — один забег шёл в подземелье двух комнат сразу: записи узла комнаты сверяются только на входе в узел;
 *  • `V3-unsure-overwritten` — у героя две записи подряд с неизвестным исходом фиксации (первая легла, вторая нет): снимок первой (R14-04,
 *    `unsure`) затёрт снимком второй, и копию, продолжающую первую, сочли устаревшей — её изменения (штраф смерти тела в бою) пропали.
 */
function causeOf(w: W, inv: string, h: Hero | undefined): string | undefined {
  if (inv === '8-run-in-two-rooms') return 'V2-run-in-two-rooms';
  // Две записи героя подряд с неизвестным исходом: память о первой (легла) затёрта второй (не легла) — копию сочли устаревшей.
  if (h && db.doubleUnknown.has(h.charId) && (inv === '1-sunk-item-back' || inv === '1-dup-item' || inv === '1-dup-item-db' || inv === '3-double-penalty')) return 'V3-unsure-overwritten';
  if (h?.droppedDead && (inv === '3-double-penalty' || inv === '2-revived-elsewhere')) return 'V1-dead-dropped';
  // «Живым в другой комнате того же забега» без снятия мёртвым — это и есть вторая комната забега (она могла уже и уйти из подземелья).
  if (inv === '2-revived-elsewhere') return 'V2-run-in-two-rooms';
  if ((w.concurrent || concurrentNow(w)) && (inv === '8-node-refarmable' || inv === '8-node-double-loot')) return 'V2-run-in-two-rooms';
  return undefined;
}
/** V2 прямо сейчас: один забег — в подземелье двух комнат (нарушение, пойманное посреди операции, до её проверки). */
function concurrentNow(w: W): boolean {
  const seen = new Set<string>();
  for (const room of allRooms(w)) {
    if (room.area !== 'dungeon' || !room.runConfig) continue;
    const k = runLedgerKey(room.runConfig);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

// ── Где герой ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function liveAt(w: W, h: Hero): { room: RoomIn; pid: string; p: PlayerIn; ws: FakeConn } | undefined {
  const ws = rmOf(w).live.get(h.charId);
  if (!ws) return undefined;
  const c = rmOf(w).conns.get(ws);
  if (!c) return undefined;
  const p = c.room.session.world.players[c.pid];
  return p ? { room: c.room, pid: c.pid, p, ws: ws as FakeConn } : undefined;
}
/** Все комнаты, до которых может дотянуться герой: живые, грейс, снятые, чьё закрытие сокета ещё идёт. */
function allRooms(w: W): RoomIn[] {
  const out = new Set<RoomIn>(rmOf(w).rooms.values());
  for (const c of rmOf(w).conns.values()) out.add(c.room);
  for (const r of rmOf(w).graceByChar.values()) out.add(r);
  for (const r of w.ticking) out.add(r);
  return [...out];
}
type Loc = { kind: 'live' | 'body' | 'disc'; room: RoomIn; pid?: string; p?: PlayerIn; info?: InfoIn; c?: ClientIn };
function locate(w: W): Map<string, Loc[]> {
  const out = new Map<string, Loc[]>();
  const add = (id: string, l: Loc): void => { let a = out.get(id); if (!a) out.set(id, (a = [])); a.push(l); };
  for (const room of allRooms(w)) {
    const players = room.session.world.players;
    const bodies = new Set([...room.lingering.values()].map((l) => l.pid));
    for (const [pid, c] of room.clients) {
      const p = players[pid];
      if (!p) { violate(w, '7-client-without-entity', `комната ${room.code}: клиент ${pid} без сущности`); continue; }
      add(p.save.charId, { kind: 'live', room, pid, p, c });
    }
    for (const [charId, l] of room.lingering) add(charId, { kind: 'body', room, pid: l.pid, p: l.p, info: l.info });
    for (const [charId, info] of room.disconnected) add(charId, { kind: 'disc', room, info });
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
    if (live) out.set(h.charId, { kind: 'live', area: live.room.area, alive: live.p!.alive });
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
/**
 * ПРАВДА О ГЕРОЕ: копия в памяти (сессия, тело, ждущий реконнекта); копия, которую менеджер или комната ещё дописывают (запись не
 * легла, исход неизвестен), — последняя виденная (⭐ перепрогон R16: и штраф по строке базы — см. `spy.onPenalty`); иначе строка базы.
 */
function truthOf(w: W, h: Hero, locs: Map<string, Loc[]>): { save: SaveState; mem: boolean; pending?: boolean } | undefined {
  const ls = locs.get(h.charId) ?? [];
  const mem = ls.find((l) => l.kind === 'live') ?? ls.find((l) => l.kind === 'disc') ?? ls.find((l) => l.kind === 'body');
  if (mem) { const s = mem.p?.save ?? mem.info!.save; h.lastSave = s; return { save: s, mem: true }; }
  const pendingCopy = rmOf(w).unsaved.has(h.charId) || rmOf(w).inflight.has(h.charId)
    || allRooms(w).some((r) => [...r.staleFarewells.values()].some((s) => s.charId === h.charId && !s.farewell.saved));
  if (pendingCopy && h.lastSave) return { save: h.lastSave, mem: true, pending: true };
  const row = rowSave(h.charId);
  return row ? { save: row, mem: false } : undefined;
}
const itemsOf = (s: SaveState): Item[] => [...Object.values(s.equipment ?? {}).filter((i): i is Item => !!i), ...s.inventory, ...(s.belt ?? []).filter((i): i is Item => !!i)];
/** Вещи, за пропажей которых следим: не расходники и не сырьё (стек сливается, зелье пьётся на поясе). */
const tracked = (it: Item): boolean => it.kind !== 'material' && it.kind !== 'consumable' && !it.use;

// ── Проверка после каждой операции ──────────────────────────────────────────────────────────────────────────────────────────────
function check(w: W, pre: Map<string, PreState>, op: Op | null): void {
  const locs = locate(w);
  const now = Date.now();

  // 6: исключения, погашенные внутри (команда, кадр) — ошибка кода, а не штатный отказ.
  if (counters.cmdFailed !== w.cmdFailed0) { violate(w, '6-cmd-threw', `команда упала исключением: ${w.errors.slice(-3).join(' | ')}`); w.cmdFailed0 = counters.cmdFailed; }
  if (counters.frameErrors !== w.frameErrors0) { violate(w, '6-frame-threw', `кадр упал исключением: ${w.errors.slice(-3).join(' | ')}`); w.frameErrors0 = counters.frameErrors; }

  // 7: одна пишущая копия героя на процесс.
  for (const [charId, ls] of locs) {
    const rooms = new Set(ls.map((l) => l.room));
    const kinds = ls.map((l) => l.kind).sort().join('+');
    if (rooms.size > 1) violate(w, '7-two-copies', `${charId} сразу в ${rooms.size} комнатах: ${ls.map((l) => `${l.kind}@${l.room.code}`).join(', ')}`);
    else if (kinds !== 'live' && kinds !== 'disc' && kinds !== 'body+disc') violate(w, '7-two-copies', `${charId} в комнате ${ls[0]!.room.code}: ${kinds}`);
    // 7: живая сессия — не зомби: её версия — версия строки в базе (кто-то другой записал героя — её записи не пройдут, а в памяти она ещё действует).
    for (const l of ls) {
      if (l.kind !== 'live' || !l.c || l.c.stale || l.c.unsure.length) continue;
      const row = db.rows.get(charId);
      if (row && row.version !== l.c.saveVersion) violate(w, '7-zombie-session', `живая сессия ${charId} держит версию ${l.c.saveVersion}, в базе ${row.version}`);
    }
  }

  // Правда о каждом герое.
  const truth = new Map<string, SaveState>();
  /**
   * Герои, чья правда — копия «на дописать» (запись не легла или исход неизвестен). Она ещё не решена: копия действия «сейв + сундук»
   * ляжет либо целиком (с сундуком своей записи), либо сейвом ДО действия (сундук обогнали — `keepUnknown`). Вещи в ней — под вопросом
   * до дописки: дюп с ней — только если останется в базе (`1-dup-item-db` в конце прогона).
   */
  const pendingChars = new Set<string>();
  for (const h of w.heroes) {
    const t = truthOf(w, h, locs);
    if (!t) continue;
    truth.set(h.charId, t.save);
    if (t.pending) pendingChars.add(h.charId);
  }
  // ⭐ R15-02 (медленная база): и копия сессии, чья транзакция «сейв + сундук» ещё в пути (сейв на удержании, R1-05): действие уже в памяти,
  // а сундук базы — ещё до него. Решит запись: ляжет — с сундуком своей записи, нет — откат к «до». Дюп, переживший её, увидит следующая
  // проверка (удержание снято) и `1-dup-item-db` в конце. Тело в бою (`lingering`) держит сейв иначе — оно не в `clients`.
  for (const room of allRooms(w)) {
    for (const pid of room.clients.keys()) {
      const p = room.session.saveHeld.has(pid) ? room.session.world.players[pid] : undefined;
      if (p) pendingChars.add(p.save.charId);
    }
  }

  // 1: вещь — в одном месте (правда героев, сундуки, земля).
  const where = new Map<string, string[]>();
  const put = (uid: string, loc: string): void => { let a = where.get(uid); if (!a) where.set(uid, (a = [])); a.push(loc); };
  const trackedUid = new Set<string>();
  for (const [charId, s] of truth) for (const it of itemsOf(s)) { put(it.uid, `hero:${charId}`); if (tracked(it)) trackedUid.add(it.uid); }
  for (const [userId, st] of db.stash) {
    const data = JSON.parse(st.json) as AccountStash;
    for (const it of data.tabs.flat()) { put(it.uid, `stash:${userId}`); if (tracked(it)) trackedUid.add(it.uid); }
  }
  const rooms = allRooms(w);
  // ⭐ K3: и поднимаемое с земли, ушедшей, пока запись поднимающего в пути (`carrying`): в сумку вещь переходит только после неё.
  for (const room of rooms) {
    const ds = room.session.world.drops;
    const ground = room.carrying?.size ? [...ds, ...[...room.carrying].filter((d) => !ds.includes(d))] : ds;
    for (const d of ground) if (d.kind === 'item' && d.item) { put(d.item.uid, `ground:${room.code}`); if (tracked(d.item)) trackedUid.add(d.item.uid); }
  }
  // ⭐ K3: поднимаемое, чья земля ушла, пока запись поднимающего была в пути (`carryGone`): легла — вещь в его сумке; ещё в пути — земля
  // (`carrying`); строка базы её держит (исход неизвестен, копию ещё дописывают) — судьбу решит дописка. Иначе ушло с землёй ушедшего этажа —
  // сток. Сама проверка его на земле могла и не видеть: выброс, подъём и смена этажа — одна операция (голосование решилось снятием соседа), и
  // последним местом вещи числилась сумка выбросившего. ⭐ Перепрогон R16: и запись поднимающего, ждущая медленную базу (`db.pending`), — её место,
  // пока не дошла: земля ушла вместе с комнатой (герой вошёл заново, пустую остановили), а легла запись — вещь в его строке.
  for (const uid of [...w.carryGone]) {
    const ls = where.get(uid);
    if (ls?.some((l) => l.startsWith('ground:'))) continue;
    if (!ls && [...db.rows.values(), ...[...db.pending].map((json) => ({ json }))].some((r) => r.json.includes(uid))) continue;
    w.carryGone.delete(uid);
    if (!ls) { w.sinks.add(uid); w.lastLoc.delete(uid); }
  }
  for (const [uid, ls] of where) {
    const settled = ls.filter((l) => !(l.startsWith('hero:') && pendingChars.has(l.slice(5))));
    if (settled.length > 1) violate(w, '1-dup-item', `вещь ${uid} сразу в: ${ls.join(', ')}`);
    if (w.sinks.has(uid)) {
      const holder = w.heroes.find((x) => ls.includes(`hero:${x.charId}`)) ?? w.heroes.find((x) => x.charId === w.sunkBy.get(uid));
      violate(w, '1-sunk-item-back', `вещь ${uid}, взятая стоком (штраф/продажа/земля ушедшего этажа), снова в игре: ${ls.join(', ')}`, holder);
    }
  }
  // Штрафы, взятые за операцию (3). ЛЁГ ли штраф: с копии в памяти, которая и есть правда героя, — да (её допишут); со строки базы,
  // прочитанной ради записи по ней («Завершить» без грейса, запись по строке при устаревшей копии), — только если эта запись легла
  // (строка базы — ровно она). Не лёг (база отказала, «сохраняем, повторите») — штрафа не было: его возьмёт повтор. ⭐ R15-02: запись, ждущая
  // медленную базу, — ляжет (медленная база не сбой): штраф взят этой операцией, а снятые им вещи уйдут из строки, когда она дойдёт (`sinkLater`).
  const inFlight = (pn: Penalty): boolean => db.pending.has(JSON.stringify(pn.save));
  const landed = (pn: Penalty): boolean => {
    if (truth.get(pn.charId) === pn.save) return true;
    const json = JSON.stringify(pn.save);
    return db.writes.some((x) => x.ok && x.charId === pn.charId && x.json === json) || inFlight(pn);
  };
  const took = w.penalties.filter(landed);
  const removedNow = new Set(took.flatMap((pn) => pn.removed));
  for (const pn of took) for (const u of pn.removed) w.sunkBy.set(u, pn.charId);
  for (const pn of took) if (inFlight(pn)) for (const u of pn.removed) w.sinkLater.add(u);
  // Пропавшие с прошлой проверки: сток — штраф этой операции, продажа, земля ушедшего этажа; иначе — пусть найдётся к концу прогона
  // (копия ещё дописывается). Взятое стоком не возвращается (`1-sunk-item-back` выше — на следующей проверке). Поднимаемое с ушедшей земли
  // (`carryGone`) решает конец записи поднимающего (выше), а не «последний раз на земле».
  for (const [uid, loc] of [...w.lastLoc]) {
    if (where.has(uid) || w.carryGone.has(uid)) continue;
    if (loc.startsWith('ground:') || removedNow.has(uid) || w.sold.has(uid) || w.sinkLater.has(uid)) {
      w.sinks.add(uid); w.lastLoc.delete(uid); w.sinkLater.delete(uid);
    }
  }
  w.sold.clear();
  for (const uid of trackedUid) w.lastLoc.set(uid, where.get(uid)![0]!);

  const perHero = new Map<string, Penalty[]>();
  for (const pn of took) { let a = perHero.get(pn.charId); if (!a) perHero.set(pn.charId, (a = [])); a.push(pn); }
  for (const [charId, ps] of perHero) {
    const h = w.heroes.find((x) => x.charId === charId);
    if (!h) continue;
    const st = pre.get(charId) ?? { kind: 'off' };
    // Кадр «Завершить» или вход этого героя — ещё в очереди или отвечен за эту операцию (кадры лобби исполняются, когда до них дойдёт очередь героя).
    const asked = (t: 'join' | 'abandon'): boolean => w.pending.some((p) => p.charId === charId && p.t === t);
    // Запись по строке базы (`stored`) — продолжение уже принятых похорон копии, а не новая смерть.
    const counted = ps.filter((p) => p.src !== 'stored');
    // 3a: второй штраф в ту же жизнь (и за одну операцию дважды — ⭐ перепрогон R15: подряд, без оживления между ними; кадры лобби героя,
    // стоявшие в очереди за медленной записью, исполняются одной операцией: вход к пати в подземелье — новая жизнь с её забегом, и его бросок
    // следующим входом — свой штраф).
    const byEv = [...counted].sort((a, b) => a.ev - b.ev);
    const sameLife = byEv.some((p, i) => i > 0 && !h.revivals.some((r) => r > byEv[i - 1]!.ev && r < p.ev));
    if (sameLife && !counted.every((p) => p.src === 'death' || p.src === 'linger')) violate(w, '3-double-penalty', `${charId}: за одну операцию штрафов ${counted.length} (${counted.map((p) => p.src).join(', ')})`, h);
    const firstEv = Math.min(...counted.map((p) => p.ev));
    const livedBetween = h.revivals.some((r) => r > h.penaltyEv && r < firstEv);
    // ⭐ C-03: погиб ГОСТЕМ (в забеге комнаты, чужом ему) — смерть оплатила её забег, а не его: бросить свой потом — отдельный штраф.
    const guest = !!h.lastPen && counted.every((p) => guestDeath(h.lastPen!, p));
    if (counted.length && h.penaltyEv > 0 && h.penaltyEv < firstEv && !livedBetween && !guest) violate(w, '3-double-penalty', `${charId}: штраф (${counted.map((p) => p.src).join(', ')}) — а прошлый ещё не «отжит» (живым не видели, пати забег не уводила); операция ${op ? fmt(op) : 'эпилог'}`, h);
    // ⭐ R16-09: ожил ЗА ЭТУ операцию и раньше этого штрафа — состояние до операции (`st`) уже не про эту жизнь. Кадры лобби героя, стоявшие в
    // очереди за медленной записью смерти, исполняются одной операцией: вход по коду к чужой пати в подземелье (оплаченный забег снят страховкой)
    // — новая жизнь с её забегом, и её бросок следующим кадром — свой штраф, а не второй за оплаченную смерть.
    const revivedInOp = (p: Penalty): boolean => h.revivals.some((r) => r > w.opEv0 && r < p.ev);
    for (const p of ps) {
      const why = `${charId} ${p.src}: до операции ${JSON.stringify(st)}, операция ${op ? fmt(op) : 'эпилог'}`;
      if (p.src === 'abandonStored' && !asked('abandon')) violate(w, '3-unjustified-penalty', `штраф по строке базы без «Завершить»: ${why}`);
      if (p.src === 'abandonAsDead') {
        // ⭐ R16-01: забег за штраф бросает только «Завершить». Вход (новая комната, по коду; Unity — `join{fresh}` сразу за статусом забега)
        // при грейсе, чей бросок стоил бы штрафа, — отказ `run`; страховка входа отпускает без штрафа (припаркован, чужой комнате, смерть
        // оплачена). Раньше «вход — тоже повод» (`asked('join')`), и молчаливый штраф за обрыв посреди подземелья проходил проверку.
        if (!asked('abandon')) violate(w, '3-unjustified-penalty', `«Завершить»-штраф без «Завершить» (вход забег за штраф не бросает — R16-01): ${why}`);
        if (st.kind === 'disc' && st.paid && !st.foreign && !revivedInOp(p)) violate(w, '3-double-penalty', `штраф с оплаченной смерти (paid): ${why}`, h);
      }
      if (p.src === 'bury' || p.src === 'buryFled' || p.src === 'stored') {
        // ⭐ Перепрогон R15: вход героя, шедший на начало операции (очередь за медленной записью, поздний ответ реестра), — держание: он дошёл,
        // и похороны его копии за операцию — по правилам, а не «чужие».
        if (st.kind === 'off' && p.src !== 'stored' && !asked('join')) violate(w, '3-unjustified-penalty', `похоронен тот, кого нода не держала: ${why}`);
        if (st.kind === 'live' && st.area !== 'dungeon') violate(w, '3-safe-penalized', `похоронен стоящий в городе/на арене: ${why}`);
        if (st.kind === 'disc' && st.safe) violate(w, '3-safe-penalized', `похоронен тот, чей забег пати увела в город (safe): ${why}`);
        if (st.kind === 'disc' && st.paid && p.src !== 'stored' && !revivedInOp(p)) violate(w, '3-double-penalty', `похоронен со штрафом погибший (paid): ${why}`, h);
        if (p.src === 'buryFled' && st.kind === 'disc' && !st.fled && !st.fledDescend && !st.body) violate(w, '3-safe-penalized', `спокойно ушедший (не fled) похоронен уходом пати: ${why}`);
      }
    }
    if (counted.length) { h.penaltyEv = Math.max(h.penaltyEv, ...counted.map((p) => p.ev)); h.lastPen = counted.reduce((a, b) => (b.ev > a.ev ? b : a)); h.cap = null; }
  }
  w.penalties.length = 0;

  // 5 (R16 C-09): ЭКРАН ВХОДА НЕ ВРЁТ О ЦЕНЕ «ЗАВЕРШИТЬ». Статус забега сказал `dead` («погиб в нём, штраф взят» — «Забросить» без штрафа) —
  // «Завершить» с того же экрана штрафа не берёт; не сказал — берёт. Раньше статус этого не знал, и экран погибшему твердил «штраф золота и
  // части предметов» за бесплатный выход, толкая к «Продолжить», которое вернёт его мёртвым. Сверка — только чистой пары: ни его кадров лобби в
  // очереди, ни живой сессии (её «Завершить» выселяет — правда уже её), ни сбоев базы за операцию; «Завершить» прошло, и забег было что бросать.
  const ask = w.asked;
  if (ask && op?.k === 'abandon') {
    w.asked = null;
    const st = ask.st;
    const h = w.heroes.find((x) => x.charId === ask.charId);
    const done = ask.conn.frames.some((f) => f.t === 'abandoned');
    if (h && st && done && ask.quiet && !st.live && st.hasRun && st.hadRun && db.consumed === ask.faults) {
      const charged = took.some((p) => p.charId === ask.charId && PROMISE_SRC.has(p.src));
      tally(`promise:${st.dead ? 'free' : 'cost'}:${st.grace ? 'grace' : 'row'}`);
      if (charged === st.dead) {
        violate(w, '5-status-promise', `${ask.charId}: экран «Продолжить / Забросить» ${st.dead ? 'обещал «без штрафа» (`dead`), а «Завершить» оштрафовал' : 'пугал штрафом, а «Завершить» его не взял (смерть оплачена — `dead` не сказан)'}; до операции ${JSON.stringify(pre.get(ask.charId))}, операция ${op ? fmt(op) : 'эпилог'}`, h);
      }
    }
  }

  // 4: зелье и бой (вампиризм, жизнь за убийство) лечат законно — и у снятого той же операцией (запись сессии упала): его следующее
  // наблюдение — с чистого листа.
  if (op && (op.k === 'potion' || op.k === 'attack')) heroOf(w, op.h).cap = null;
  // 2: комната, где герой погиб, сменила этаж (спуск, город, вайп) — это его оживление, где бы он ни был.
  for (const h of w.heroes) if (h.deadRoom && instOf(w, h.deadRoom) !== h.deadInst) { h.deadRun = null; h.deadRoom = null; h.deadInst = null; }
  // 2: забег, где он погиб, для него окончен — снят с его правды («Завершить», страховка входа в новую комнату, похороны, финал): смерть
  // закрыта. Войти потом по коду в комнату того же забега (её собрал из своей копии напарник, ушедший из города раньше) — это вход нового
  // участника, как любого друга, а не воскрешение: в ТУ ЖЕ комнату он вернулся бы мёртвым (R13-04), а держит забег одна комната (V2).
  for (const h of w.heroes) {
    const run = truth.get(h.charId)?.run;
    if (h.deadRun && (!run?.config || runLedgerKey(run.config) !== h.deadRun)) { h.deadRun = null; h.deadRoom = null; h.deadInst = null; }
  }
  // 2, 4: тела в мирах.
  for (const h of w.heroes) {
    for (const l of locs.get(h.charId) ?? []) {
      if (l.kind === 'disc' || !l.p) continue;
      const room = l.room;
      if (room.area === 'arena') continue;   // арена оживляет по своему правилу и тело на ней — не его
      const key = instOf(w, room);
      if (!l.p.alive) {
        h.deadOn.add(key); h.wasDead = true;
        h.deadSeenEv = ++w.ev;   // C-03: мёртв — смерть оплачена, пока не оживёт
        if (room.area === 'dungeon' && room.runConfig && h.deadInst !== key) { h.deadRun = runLedgerKey(room.runConfig); h.deadRoom = room; h.deadInst = key; }
        continue;
      }
      if (h.deadOn.has(key)) violate(w, '2-revived-same-floor', `${h.charId} погиб на этаже ${key} (${room.area}, узел ${room.runNodeId}) — и снова жив на нём же (${l.kind}); операция ${op ? fmt(op) : 'конец'}`);
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
        if (bad.length) violate(w, '4-free-restore', `${h.charId} за ${dt.toFixed(1)} с (${lv!.room.area}, ${lv!.kind}): ${bad.join('; ')}; операция ${op ? fmt(op) : 'конец'}`);
      }
      h.cap = { hp: s.hp, mana: s.mana, stamina: s.stamina, at: now };
      // 4: не выше максимума — после шага мира (первый тик подрезает то, что вход поставил выше).
      if (w.stepped && run) {
        const over: string[] = [];
        if (s.hp > run.maxHp + 1e-6) over.push(`здоровье ${s.hp} > ${run.maxHp}`);
        if (s.mana > run.maxMana + 1e-6) over.push(`мана ${s.mana} > ${run.maxMana}`);
        if (s.stamina > run.maxStamina + 1e-6) over.push(`выносливость ${s.stamina} > ${run.maxStamina}`);
        if (over.length) violate(w, '4-over-max', `${h.charId}: ${over.join('; ')}`);
      }
    }
    // Забег героя пати увела в город (safe) — это оживление: следующий штраф не второй.
    for (const l of locs.get(h.charId) ?? []) if (l.kind === 'disc' && l.info!.safe) { h.revivedEv = ++w.ev; h.revivals.push(h.revivedEv); h.droppedDead = false; }
    // 4 (⭐ R16-07): бафф не живёт дольше своего срока по часам мира, пока герой той же сущностью в той же комнате и жив (арена — время
    // города; у мёртвого таймеры стоят, как у ушедшего, — движок его не тикает). Раньше круг «город → арена → город» возвращал его полным:
    // запись арены хранила остаток, а время арены он не старел.
    if (h.buff) {
      if (!lv || lv.room !== h.buff.room || lv.p !== h.buff.p || !lv.p.alive) h.buff = null;
      else {
        const left = lv.p.skillBuffs[FZ_BUFF];
        const may = (h.buff.end - lv.room.session.world.timeMs) / 1000;
        if (left !== undefined && left > may + 0.05) {
          violate(w, '4-buff-outlived', `${h.charId}: бафф ещё ${left.toFixed(2)} с, а по часам мира ему осталось ${may.toFixed(2)} с (${lv.room.area}); операция ${op ? fmt(op) : 'конец'}`, h);
        }
      }
    }
  }

  // 8: прогресс забега. Достигнутое — узлы, где комната была, когда он в ней состоял (`noteReached`: вход в узел, вход героя в комнату).
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
  // 8: забег идёт в подземелье ОДНОЙ комнаты: записи узлов (сундуки, убитые) комнаты сверяют только на входе в узел, и две комнаты одного
  // забега берут одно и то же каждая (корень `8-node-refarmable`/`8-node-double-loot`).
  const byRun = new Map<string, string[]>();
  for (const room of rooms) {
    if (room.area !== 'dungeon' || !room.runConfig) continue;
    const k = runLedgerKey(room.runConfig);
    byRun.set(k, [...(byRun.get(k) ?? []), `${room.code}@${room.runNodeId}`]);
  }
  for (const [, rs] of byRun) if (rs.length > 1) w.concurrent = true;
  for (const [, rs] of byRun) if (rs.length > 1 && !w.violations.some((v) => v.inv === '8-run-in-two-rooms')) violate(w, '8-run-in-two-rooms', `один забег в подземелье двух комнат сразу: ${rs.join(', ')}; операция ${op ? fmt(op) : 'эпилог'}`);
  // 3 (R16 C-03): В ПОДЗЕМЕЛЬЕ — ТОЛЬКО УЧАСТНИКИ ЕГО ЗАБЕГА. Подключённый (сессия, тело в бою) и ждущий реконнекта не припаркованным — с забегом
  // комнаты: гость с ЧУЖИМ ей забегом вне правил бегства (похороны и страховка входа его забег не трогают, `foreignRun`) — уход из боя ему даром.
  // ⭐ E2E 28.09 (сид 60995): и подземелье без забега — окно вайпа (`wipe` снял забег комнаты, этаж с монстрами ещё стоит): любой свой забег
  // в нём чужой. Раньше проверка пропускала такие комнаты, и вход по коду в окно вайпа ловила только `3-fled-released` на эпилоге.
  for (const room of rooms) {
    if (room.area !== 'dungeon') continue;
    const key = room.runConfig ? runLedgerKey(room.runConfig) : '—';
    const foreign = (s: SaveState | undefined): string | null => (s?.run?.config && runLedgerKey(s.run.config) !== key ? runLedgerKey(s.run.config) : null);
    for (const pid of room.clients.keys()) {
      const s = room.session.world.players[pid]?.save;
      const own = foreign(s);
      if (own) violate(w, '3-dungeon-foreign-run', `${s!.charId} в подземелье комнаты ${room.code} (её забег ${key}) со своим забегом ${own}; операция ${op ? fmt(op) : 'эпилог'}`, w.heroes.find((x) => x.charId === s!.charId));
    }
    for (const [charId, info] of room.disconnected) {
      const own = info.safe ? null : foreign(info.save);
      if (own) violate(w, '3-dungeon-foreign-run', `${charId} ждёт реконнекта в подземелье комнаты ${room.code} (её забег ${key}) со своим забегом ${own}; операция ${op ? fmt(op) : 'эпилог'}`, w.heroes.find((x) => x.charId === charId));
    }
  }
  // 8: записи узлов — на входе не меньше известного, и одно не берётся дважды.
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
      if (lostC.length || lostK.length) violate(w, '8-node-refarmable', `комната ${room.code} вошла в узел ${st.id} без взятого: сундуки ${lostC.join(',') || '—'}, убитые ${lostK.join(',') || '—'}`);
    } else {
      const againC = st.chests.filter((c) => !prev.chests.has(c) && rec!.chests.has(c));
      const againK = st.killed.filter((c) => !prev.killed.has(c) && rec!.killed.has(c));
      if (againC.length || againK.length) violate(w, '8-node-double-loot', `узел ${st.id}: взято повторно — сундуки ${againC.join(',') || '—'}, убитые ${againK.join(',') || '—'} (комната ${room.code})`);
    }
    for (const c of st.chests) rec.chests.add(c);
    for (const c of st.killed) rec.killed.add(c);
    w.roomSeen.set(room, { key, st, chests: new Set(st.chests), killed: new Set(st.killed) });
  }

  // 5: кадр лобби без ответа (очередь героя встала).
  for (const p of [...w.pending]) {
    const want = p.t === 'join' ? ['joined', 'error'] : p.t === 'runStatus' ? ['runStatus', 'error'] : ['abandoned', 'error'];
    if (p.conn.since(p.idx).some((f) => want.includes(f.t))) { w.pending.splice(w.pending.indexOf(p), 1); continue; }
    if (!p.conn.open) { w.pending.splice(w.pending.indexOf(p), 1); continue; }
    if (now - p.at > 40_000) { violate(w, '5-lobby-unanswered', `кадр «${p.t}» (операция ${p.op}) без ответа ${((now - p.at) / 1000).toFixed(0)} с`); w.pending.splice(w.pending.indexOf(p), 1); }
  }
}

/** Покрытие прогона: что реально случилось (виды кадров, переходы, отказы, итоги команд, штрафы) — видно, не холостой ли фаззер. */
const stats = new Map<string, number>();
const tally = (k: string): void => { stats.set(k, (stats.get(k) ?? 0) + 1); };
/**
 * Кадр герою: учёт покрытия; ОЖИВЛЕНИЕ (жив в этот миг) и вход живым в забег, где погиб (2). Кадр — в момент перехода, а не снимок после
 * операции: запись со сбоем снимает сессию той же операцией.
 */
function noteFrame(w: W, c: FakeConn, f: ServerFrame): void {
  if (c.run !== db.run) return;
  if (f.t === 'joined') c.roomCode = f.roomCode;
  // 9 (R16-04): ОКНО ГОЛОСОВАНИЯ ≡ ИСХОД. Окно напарника — текст кадра `voteStart` (`client/ui/voteText.ts`): спуск в подземелье обязан
  // сказать, куда ведёт (финал — `finish`, ребро — узел и его тип), а принятое голосование — вести ровно туда. Раньше кадр финала был
  // без `finish`: окно звало «Спуск на след. этаж?», а принявший уходил в город (и лежавшее на полу финала пропадало).
  if (f.t === 'voteStart') {
    const room = c.roomCode ? rmOf(w).rooms.get(c.roomCode) : undefined;
    c.vote = { f, area: room?.area ?? '?', passed: false };
    if (f.kind === 'descend' && room?.area === 'dungeon' && !f.finish && !(f.targetNodeId && f.targetNodeType)) {
      violate(w, '9-vote-blind', `${c.roomCode}: голосование за спуск в подземелье не говорит, куда ведёт: ${JSON.stringify(f)}; операция ${w.opRef ? fmt(w.opRef) : 'эпилог'}`);
    }
  } else if (f.t === 'voteEnd') {
    if (c.vote && f.passed) c.vote.passed = true; else c.vote = undefined;
  } else if (f.t === 'joined') c.vote = undefined;
  else if (f.t === 'areaChanged' && c.vote) {
    const v = c.vote;
    c.vote = undefined;
    const floor = f.floor as { area?: string; runNodeId?: string };
    if (v.passed && v.f.kind === 'descend' && v.area === 'dungeon') {
      const room = c.roomCode ? rmOf(w).rooms.get(c.roomCode) : undefined;
      const type = room?.runPlan?.nodes.find((n) => n.id === floor.runNodeId)?.type;
      const ok = v.f.finish ? floor.area === 'town'
        : floor.area === 'dungeon' && floor.runNodeId === v.f.targetNodeId && type === v.f.targetNodeType;
      if (!ok) {
        violate(w, '9-vote-misleads', `${c.roomCode}: окно звало ${v.f.finish ? 'завершить забег' : `спуститься: ${v.f.targetNodeType ?? '?'} (${v.f.targetNodeId ?? '—'})`}, а принятое голосование увело в ${floor.area}${floor.runNodeId ? ` (${floor.runNodeId}, ${type ?? '?'})` : ''}; операция ${w.opRef ? fmt(w.opRef) : 'эпилог'}`);
      }
    }
  }
  // 5 (R16 C-09): обещание экрана входа — в миг ответа статуса: что сказано (`dead`), жива ли сессия и есть ли забег у копии, которую бросит
  // «Завершить» (грейс-копия, нет её — строка базы; как решает сам кадр `abandon`).
  if (f.t === 'runStatus' && w.asked?.conn === c && !w.asked.st) {
    const charId = w.asked.charId;
    const grace = rmOf(w).graceByChar.get(charId);
    const hadRun = grace ? !!grace.disconnected.get(charId)?.save.run : !!rowSave(charId)?.run;
    w.asked.st = { dead: f.dead === true, hasRun: f.hasRun, live: rmOf(w).live.has(charId), hadRun, grace: !!grace };
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
  // 5 (C-05): «ПРОДОЛЖИТЬ», ОТКАЗАННЫЙ ИЗ-ЗА ЗАБЕГА В ДРУГОЙ КОМНАТЕ (V2: в её пати нет мест — `full`, она на другой ноде — `run`), — С КОДОМ
  // ЭТОЙ КОМНАТЫ ПОЛЕМ КАДРА, и она держит его забег. Без кода клиенту некуда идти: на экране «Продолжить / Забросить» поля кода нет, повтор
  // даёт тот же отказ, и выходом оставалось «Забросить» — штраф смерти. Отказ лобби — соединению без сессии (в игре `run` — отказ спуску).
  if (f.t === 'error' && (f.code === 'full' || f.code === 'run') && c.resume && c.hero !== undefined && !rmOf(w).conns.has(c)) {
    const h = w.heroes[c.hero]!;
    const own = rowSave(h.charId)?.run?.config;
    const holder = f.roomCode ? rmOf(w).rooms.get(f.roomCode) : undefined;
    const names = f.code === 'run' ? !!f.roomCode : !!holder && !!own && holder.holdsRun(runLedgerKey(own));
    if (!names) violate(w, '5-resume-dead-end', `${h.charId}: «Продолжить» — отказ «${f.code}» (${f.msg}) ${f.roomCode ? `с кодом ${f.roomCode}, а эта комната его забег ${own ? runLedgerKey(own) : '—'} не держит` : 'без кода комнаты, что держит его забег'}; операция ${w.opRef ? fmt(w.opRef) : 'эпилог'}`, h);
  }
  if ((f.t !== 'joined' && f.t !== 'areaChanged') || c.hero === undefined || !c.roomCode) return;
  const room = rmOf(w).rooms.get(c.roomCode);
  if (!room) return;
  const h = w.heroes[c.hero]!;
  // Жив ли герой в этот миг (вход — после восстановления «каким ушёл», переход — после оживления этажом). Жив не на арене — новая жизнь:
  // следующий штраф не второй за ту же смерть, пулы — с чистого листа. Снимок после операции мог его не застать (сессию сняла запись).
  // Кадр этажа посреди входа (сборка узла продолжением сразу за `attach`) приходит раньше, чем менеджер запомнил соединение (`conns`), —
  // игрок по сокету в клиентах комнаты (как у фаззера кластера: иначе «встал на узле мёртвым», K1, проверка не видит).
  const pid = f.t === 'joined' ? f.playerId : rmOf(w).conns.get(c)?.pid ?? [...room.clients.values()].find((cl) => cl.ws === c)?.pid;
  const p = pid ? room.session.world.players[pid] : undefined;
  // 2: погибший (не оживавший) — живым в ТОМ ЖЕ забеге, но в другой комнате («Продолжить» в новую комнату, вход по коду).
  if (p?.alive && room.area === 'dungeon' && room.runConfig && h.deadRun && room !== h.deadRoom && runLedgerKey(room.runConfig) === h.deadRun) {
    violate(w, '2-revived-elsewhere', `${h.charId} погиб в забеге (комната ${h.deadRoom?.code}, этаж не менялся) — а живым встал на узел ${room.runNodeId} того же забега в комнате ${room.code} (${f.t}, операция ${w.opRef ? fmt(w.opRef) : 'эпилог'})`, h);
    h.deadRun = null; h.deadRoom = null; h.deadInst = null;
  }
  if (p?.alive && room.area !== 'arena') revived(w, h);
  if (p && !p.alive && room.area !== 'arena') h.deadSeenEv = ++w.ev;   // C-03: вошёл мёртвым (R3-06, R13-04) — та же оплаченная смерть
}

/**
 * Смена этажа оживила героев комнаты (сессии): новая жизнь — следующий штраф не второй, пулы — с чистого листа. ⭐ C-03: и ждущих
 * реконнекта — их мёртвые записи ухода смена этажа снимает так же (вернутся живыми), и «Завершить» их забега дальше — штраф, как у всех.
 */
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
/** Штраф за эту жизнь уже взят (с учётом штрафов текущей операции, ещё не разобранных проверкой). */
function lifePaid(w: W, h: Hero): boolean {
  const pending = w.penalties.filter((p) => p.charId === h.charId && p.src !== 'stored').map((p) => p.ev);
  return Math.max(h.penaltyEv, ...pending) > h.revivedEv;
}
/** ⭐ C-03: смерть оплачена — штраф этой жизни взят или с последнего оживления его видели мёртвым (`deadSeenEv`). */
function deathPaid(w: W, h: Hero): boolean {
  return lifePaid(w, h) || h.deadSeenEv > h.revivedEv;
}
/** ⭐ C-03: штрафы, бросающие забег сейва (`Penalty.run`): «Завершить», похороны копии и по строке базы. */
const ABANDON_SRC: ReadonlySet<string> = new Set(['abandonStored', 'abandonAsDead', 'stored', 'bury', 'buryFled']);
/**
 * ⭐ R16 C-09: штрафы, которые берёт «Завершить» (цена, о которой говорит экран входа): сам «Завершить» (из грейса и по строке базы), его
 * запись по строке (копию обогнали) и тело в бою, погибшее и ещё не оплаченное (`endLinger` — первым делом «Завершить»).
 */
const PROMISE_SRC: ReadonlySet<string> = new Set(['abandonStored', 'abandonAsDead', 'stored', 'linger']);
/** ⭐ C-03: `next` бросает забег, в котором смерть `prev` не случилась: погиб гостем в чужом ему забеге — свой эта смерть не оплатила. */
function guestDeath(prev: Penalty, next: Penalty): boolean {
  return (prev.src === 'death' || prev.src === 'linger') && ABANDON_SRC.has(next.src) && next.run !== null && prev.where !== next.run;
}
/** Герой жив (новая жизнь): следующий штраф — не второй за ту же смерть, пулы — с чистого листа, «снят мёртвым» (V1) — в прошлом. */
function revived(w: W, h: Hero): void {
  if (lifePaid(w, h) || h.wasDead) h.cap = null;
  h.revivedEv = ++w.ev;
  h.revivals.push(h.revivedEv);
  h.droppedDead = false;
}

/**
 * 8: ДОСТИГНУТЫЙ УЗЕЛ — герой в комнате (сессия) в тот миг, когда она входит в узел (`enterNode`), или входит в комнату, стоящую на узле
 * (`attach`). Это правда сервера: сокет, чьё закрытие ещё не дошло, — тоже в комнате. Смотрится обёрткой над методами комнаты.
 */
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
/** Проходимая точка рядом с `at`, видимая от неё. */
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
function lobby(w: W, h: Hero, frame: Record<string, unknown>, conn?: FakeConn): FakeConn {
  const ws = conn ?? new FakeConn();
  ws.hero = h.i;
  ws.run = db.run;
  ws.resume = frame.t === 'join' && frame.resume === true;
  if (!conn) { rmOf(w).handleConnection(ws); w.lobbies.push(ws); }
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
      try { room.step(false); } catch (e) { violate(w, '6-step-threw', `шаг комнаты ${room.code}: ${e instanceof Error ? e.stack?.split('\n').slice(0, 4).join(' ') : String(e)}`); }
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
/** Живой игрок между переходами идёт до выхода или алтаря — пауза голосований (R1-03, 1,5 с) у него проходит сама. */
async function pause(w: W): Promise<void> { await stepAll(w, 48); }

async function exec(w: W, op: Op): Promise<void> {
  w.stepped = false;
  switch (op.k) {
    case 'join': {
      const h = heroOf(w, op.h);
      const reuse = op.reuse && h.conn?.open && !rmOf(w).conns.has(h.conn) && !w.pending.some((p) => p.conn === h.conn);
      const frame: Record<string, unknown> = { t: 'join' };
      if (op.mode === 'fresh') frame.fresh = true;
      else if (op.mode === 'resume') frame.resume = true;
      else {
        const rooms = [...rmOf(w).rooms.values()];
        const friends = op.mode === 'friend'
          ? rooms.filter((r) => w.heroes.some((x) => x !== h && ([...r.clients.values()].some((c) => r.session.world.players[c.pid]?.save.charId === x.charId) || r.disconnected.has(x.charId))))
          : rooms;
        const pool = friends.length ? friends : rooms;
        if (pool.length) frame.roomCode = pool[Math.floor(op.r * pool.length) % pool.length]!.code;
        else frame.fresh = true;
      }
      h.conn = lobby(w, h, frame, reuse ? h.conn! : undefined);
      await drain();
      return;
    }
    case 'status': lobby(w, heroOf(w, op.h), { t: 'runStatus' }); await drain(); return;
    case 'shout': {
      // ⭐ R16-07: бафф ключом зелья без базы (`pot:` — модов нет, таймер общий с баффами скилов, сброс скилов его не снимает).
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at || !at.p.alive || at.room.area === 'arena') return;
      at.p.skillBuffs[FZ_BUFF] = FZ_BUFF_SEC;
      h.buff = { room: at.room, p: at.p, end: at.room.session.world.timeMs + FZ_BUFF_SEC * 1000 };
      return;
    }
    case 'unity': {
      // ⭐ R16-01: `NetClient.Connect` Unity — статус забега и вход «Соло» подряд, одним соединением; ответ на статус не читается.
      const h = heroOf(w, op.h);
      const ws = lobby(w, h, { t: 'runStatus' });
      h.conn = lobby(w, h, { t: 'join', fresh: true }, ws);
      await drain(3);
      return;
    }
    case 'abandon': {
      const h = heroOf(w, op.h);
      if (!op.ask) { lobby(w, h, { t: 'abandon' }); await drain(); return; }
      // ⭐ R16 C-09: экран входа — статус забега, и «Завершить» с него же (одно соединение: кадры по очереди). Обещание экрана записывает
      // `noteFrame` в миг ответа, сверяет — `check`.
      const quiet = !w.pending.some((p) => p.charId === h.charId) && !rmOf(w).live.has(h.charId);
      const ws = lobby(w, h, { t: 'runStatus' });
      w.asked = { conn: ws, charId: h.charId, quiet, faults: db.consumed };
      lobby(w, h, { t: 'abandon' }, ws);
      await drain(3);
      return;
    }
    case 'leave': send(w, heroOf(w, op.h), { t: 'leave' }); await drain(); return;
    case 'close': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (at) {
        at.ws.close();
        // ⭐ C-06 (7): закрытое соединение — не сессия СРАЗУ. Раньше снятие вставало в конец очереди кадров соединения: за кадром, ждущим
        // базу, закрытая вкладка оставалась игроком (место, голос, живая сессия), а её команды исполнялись уже после закрытия.
        if (rmOf(w).conns.has(at.ws) || rmOf(w).live.get(h.charId) === at.ws) violate(w, '7-closed-still-live', `${h.charId}: соединение закрыто, а сессия жива до конца очереди его кадров`);
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
      at.p.hp = Math.min(at.p.hp, Math.max(1, Math.floor(at.p.maxHp * op.frac)));   // урон только снижает
      // Урон — это бой, а бой идёт во времени: хотя бы тик. Без него часы стояли бы, и сейв «после боя» нёс бы ту же метку пулов, что запись
      // ухода «до боя» (R12-02 сравнивает их строго) — такого у живого клиента не бывает.
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
      // Смертельный яд — через саму симуляцию (как в `room.run.test.ts`): смерть идёт всем путём «событие → штраф → вайп/ожидание».
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
        try { at.room.setInput(at.pid, { ...idle(), useBelt: slots[Math.floor(op.r * slots.length) % slots.length] }); } catch (e) { violate(w, '6-input-threw', String(e)); }
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
      try { at.room.setInput(at.pid, { ...idle(facing), attack: true }); } catch (e) { violate(w, '6-input-threw', String(e)); }
      await stepAll(w, 8);
      const again = liveAt(w, heroOf(w, op.h));
      if (again) try { again.room.setInput(again.pid, idle(facing)); } catch (e) { violate(w, '6-input-threw', String(e)); }
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
      // ⭐ C-12: тир — по выбору (у ветерана — открытый ему; у прочих сервер откатит к открытому).
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
      // ⭐ R15-02: продано — по ответу, когда бы он ни пришёл (`noteFrame`): кадр ждёт в очереди соединения за записью в пути (медленная база).
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
      const until = op.f === 'slow' ? { until: w.op + (op.ops ?? 1) } : {};
      db.faults.push({ kind: op.f, ...(op.h !== null ? { charId: heroOf(w, op.h).charId } : {}), ...until });
      return;
    }
    case 'dropLeave': {
      const h = heroOf(w, op.h);
      const at = liveAt(w, h);
      if (!at) return;
      const loose = (): Item[] => at.p.save.inventory.filter((i) => !i.use);
      if (!loose().length) return;
      if (op.fight && at.room.area === 'dungeon' && at.p.alive) {
        const mons = at.room.session.world.monsters.filter((m) => m.alive);
        if (mons.length) {
          const m = mons.reduce((a, b) => (dist(b.pos, at.p.pos) < dist(a.pos, at.p.pos) ? b : a));
          const q = beside(at.room, m.pos, op.r);
          if (q) { place(at.p, q); m.aiState = 'chase'; }
        }
      }
      // Следующая запись героя (запись выброса) ждёт базу две операции; автосейв комнаты (тик 10 с) встаёт за ней и ждёт очереди.
      db.faults.unshift({ kind: 'slow', charId: h.charId, until: w.op + 2 });
      let inv = loose();
      cmd(w, h, { cmd: 'drop', uid: inv[Math.floor(op.r * inv.length) % inv.length]!.uid });
      await drain();
      void (at.room as unknown as { persistAll(): Promise<unknown> }).persistAll();
      await drain();
      inv = loose();
      if (inv.length) cmd(w, h, { cmd: 'drop', uid: inv[Math.floor(op.r * 7 * inv.length) % inv.length]!.uid });
      await drain();
      at.ws.close();
      await drain();
      return;
    }
    case 'retry': {
      // ⭐ R15-02: повтор — ход времени: медленная база отвечает и записям, которые начал он сам (ворота его операции уже пройдены, а
      // следующей не будет, пока он ждёт). Круги — с потолком: повтор, не кончившийся и так, ловит сторож (`6-hang`), а не вечный цикл.
      let done = false;
      const retried = rmOf(w).retryUnsaved(Date.now()).finally(() => { done = true; });
      for (let i = 0; i < 1000 && !done; i++) { openHeld(Infinity, true); await drain(); }
      await retried;
      await drain();
      return;
    }
    case 'veteran': {
      // Только герой, которого эта нода ничем не держит: его правда — строка базы, и её вправе сдвинуть другая нода.
      const h = heroOf(w, op.h);
      const rm = rmOf(w);
      const held = !!liveAt(w, h) || rm.unsaved.has(h.charId) || rm.inflight.has(h.charId) || rm.graceByChar.has(h.charId)
        || (rm as unknown as { charOps: Map<string, unknown> }).charOps.has(h.charId) || w.pending.some((p) => p.charId === h.charId)
        || allRooms(w).some((r) => r.disconnected.has(h.charId) || r.lingering.has(h.charId));
      const r = db.rows.get(h.charId);
      if (held || !r) return;
      const tier = tierIds()[op.tier % tierIds().length]!;
      const s = JSON.parse(r.json) as SaveState;
      s.difficultyProgress = { ...(s.difficultyProgress ?? {}), [tier]: Math.max(s.difficultyProgress?.[tier] ?? 0, op.depth) };
      r.json = JSON.stringify(s); r.version++;
      h.depthMax.set(tier, Math.max(h.depthMax.get(tier) ?? 0, op.depth));   // 8: наиграно там — достигнуто
      return;
    }
    case 'recruit': {
      // ⭐ C-05: сейв нового героя — из потока по сиду прогона и его номеру (повтор и сжатие видят того же); аккаунт — свой или одного из прежних.
      if (w.heroes.length >= HEROES_MAX) return;
      const i = w.heroes.length;
      const r = fuzzRng(mixSeed(w.seed, 0x4e0 + i));
      const accs = [...new Set(w.heroes.map((h) => Number(h.userId.slice('fz-u'.length))))];
      w.heroes.push(newHero(r, i, r.chance(0.5) ? r.pick(accs) : Math.max(...accs) + 1));
      return;
    }
  }
}
/**
 * ⭐ R16 C-09: герой вне игры, чья смерть в забеге оплачена по правде сервера: ждёт пати мёртвым в грейсе (`paid`) или «мёртв, оплачено» в
 * копии либо строке (`run.deadAt`). Только выбор героя для вставки — само обещание сверяет `check` с исходом «Завершить».
 */
function paidOut(w: W, h: Hero): boolean {
  const grace = rmOf(w).graceByChar.get(h.charId);
  const info = grace?.disconnected.get(h.charId);
  if (info) return !!info.save.run && (info.paid || info.save.run.deadAt !== undefined);
  return rowSave(h.charId)?.run?.deadAt !== undefined;
}
/** ⭐ C-12: тиры сложности по порядку (открытие — по глубине предыдущего). */
const tierIds = (): string[] => cfg.get('difficulties').map((d) => d.id);

// ── Генератор операций (смотрит на состояние: кто в игре, где) ──────────────────────────────────────────────────────────────────
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
  // ⭐ C-12: ветеран — из своего потока (`aux`): основной поток на эту операцию не тратится, прежние операции идут как шли.
  if (off.length && w.aux.chance(0.03)) {
    return { k: 'veteran', h: w.aux.pick(off).i, tier: w.aux.int(tierIds().length), depth: w.aux.pick([5, 10, 12, 20]) };
  }
  // ⭐ C-05: новый герой — из своего потока (`crew`): ни основной поток, ни поток ветеранов на эту операцию не тратятся.
  if (hs.length < HEROES_MAX && w.crew.chance(0.02)) return { k: 'recruit' };
  // ⭐ R16 C-09: погибший вне игры (ждёт пати мёртвым — `paid`, или «мёртв, оплачено» в сейве — `run.deadAt`) — экран входа: статус и
  // «Завершить» с него (`5-status-promise`). Из своего потока (`ask`): основной на эту операцию не тратится. Без вставки такая пара
  // случайным «Завершить» почти не выпадала — обещание «без штрафа» не проверялось вовсе.
  const deadOut = off.filter((h) => paidOut(w, h));
  if (deadOut.length && w.ask.chance(0.3)) return { k: 'abandon', h: w.ask.pick(deadOut).i, ask: true };
  // ⭐ R15-02: медленная база — из своего потока (`lag`): запись героя ждёт несколько операций, и выброс, разбор, автосейв и уход встают в
  // очередь за ней (`slow`), или всё это сразу с обрывом посреди боя (`dropLeave`). Основной поток на эту операцию не тратится.
  if (live.length && w.lag.chance(0.05)) {
    const h = w.lag.pick(live);
    if (w.lag.chance(0.4)) return { k: 'fault', f: 'slow', h: h.i, ops: 1 + w.lag.int(3) };
    return { k: 'dropLeave', h: h.i, r: w.lag.next(), fight: w.lag.chance(0.7) };
  }
  // ⭐ R16-07: бафф живому в городе или подземелье — из своего потока (`shout`): основной на эту операцию не тратится.
  if ((town.length || dun.length) && w.shout.chance(0.04)) return { k: 'shout', h: w.shout.pick([...town, ...dun]).i };
  // ⭐ R16-01: клиент Unity входит после обрыва посреди подземелья (герой ждёт в грейсе) или со второго устройства, пока первое в подземелье
  // (выселение — тоже в грейс): статус и `join{fresh}` подряд. Из своего потока (`unity`): основной на эту операцию не тратится.
  const dropped = off.filter((h) => rmOf(w).graceByChar.has(h.charId));
  if ((dropped.length || dun.length) && w.unity.chance(0.04)) return { k: 'unity', h: w.unity.pick(dropped.length && (!dun.length || w.unity.chance(0.8)) ? dropped : dun).i };
  const diff = (): number | undefined => (w.aux.chance(0.5) ? w.aux.int(tierIds().length) : undefined);
  const table: [number, () => Op][] = [
    [off.length ? 14 : 3, () => ({ k: 'join', h: rng.chance(0.75) ? pickFrom(off) : any(), mode: rng.pick(['fresh', 'resume', 'resume', 'code', 'friend', 'friend'] as const), r: rng.next(), reuse: rng.chance(0.5) })],
    [2, () => ({ k: 'status', h: any() })],
    [2.5, () => {
      const op: Op = { k: 'abandon', h: rng.chance(0.7) ? pickFrom(off) : any() };
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
    [rmOf(w).rooms.size ? 10 : 1, () => ({ k: 'step', n: rng.pick([1, 3, 10, 30, 90]) })],
    [rmOf(w).rooms.size || rmOf(w).unsaved.size ? 5 : 0.5, () => ({ k: 'wait', ms: rng.pick([1_600, 4_200, 16_000, 61_000, 3_601_000]) })],
    [3 * L, () => ({ k: 'drop', h: pickFrom(live), r: rng.next() })],
    [3 * L, () => ({ k: 'pickup', h: pickFrom(live), r: rng.next() })],
    [pairs.length ? 5 : 0, () => ({ k: 'trade', h: pickFrom(pairs), r: rng.next() })],
    [town.length ? 3 : 0, () => ({ k: 'stash', h: pickFrom(town), r: rng.next(), out: rng.chance(0.4) })],
    [town.length ? 1 : 0, () => ({ k: 'sell', h: pickFrom(town), r: rng.next() })],
    [dun.length ? 3 : 0, () => ({ k: 'chest', h: pickFrom(dun), r: rng.next() })],
    [FUZZ_FAULTS ? 4 : 0, () => ({ k: 'fault', f: rng.pick(['fail', 'deadlock', 'unknownLost', 'unknownLanded', 'stashConflict'] as const), h: rng.chance(0.6) ? any() : null })],
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
/** ⭐ C-05: героев в мире — не больше пати на потолке (4, `MAX_PARTY` менеджера) и одного сверх: пятому в полной пати места нет. */
const HEROES_MAX = 5;
/** ⭐ R16-07: бафф операции `shout` — ключ зелья без базы (модов нет) и срок клича воина (`b-class-warrior-a5`). */
const FZ_BUFF = 'pot:fz-shout';
const FZ_BUFF_SEC = 8;
/** Герой `i` аккаунта `acc`: сейв (класс, золото, три вещи, зелья — из потока `r`), строка базы и сессия аккаунта. */
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
    deadRun: null, deadRoom: null, deadInst: null, droppedDead: false, lastPen: null, deadSeenEv: 0, buff: null,
  };
}

/**
 * Эпилог: сбои выключены, все ушли, грейс и дописки отработали — каждый герой «статус → Завершить (если забег) → вход «Соло»» и
 * стоит в городе. Каждая фаза — как операция: состояние до неё, проверка после.
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
  await phase(null, async () => { openHeld(Infinity, true); await drain(3); });   // R15-02: медленная база отвечает
  // 5 (C-05): ЗАБЕГ В СЕЙВЕ — ВСЕГДА С ПУТЁМ В ИГРУ БЕЗ ШТРАФА, пока комнаты живы. Дальше эпилог всех выводит — и пати, держащие забеги, тоже, —
  // и отказ «нет мест» (пати забега полна) он прятал. Каждый вне игры с забегом в строке базы жмёт «Продолжить»: вход — или отказ с кодом
  // комнаты, что держит его забег (`noteFrame`); на «нет мест» — «Соло» из лобби: город, забег цел, без штрафа (3).
  for (const h of w.heroes) {
    if (liveAt(w, h) || !rowSave(h.charId)?.run) continue;
    let full = false;
    await phase({ k: 'join', h: h.i, mode: 'resume', r: 0, reuse: false }, async () => {
      const ws = lobby(w, h, { t: 'join', resume: true });
      await drain(3);
      full = ws.frames.some((f) => f.t === 'error' && f.code === 'full');
    });
    if (!full) continue;
    await phase({ k: 'join', h: h.i, mode: 'fresh', r: 0, reuse: false }, async () => {
      const ws = lobby(w, h, { t: 'join', fresh: true });
      await drain(3);
      const j = ws.frames.find((f) => f.t === 'joined') as Extract<ServerFrame, { t: 'joined' }> | undefined;
      if (!j) violate(w, '5-resume-dead-end', `${h.charId}: «Продолжить» — «нет мест», а «Соло» из лобби не входит: ${JSON.stringify(ws.frames.filter((f) => f.t === 'error').at(-1) ?? null)}`, h);
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
  for (let k = 0; k < 4; k++) await phase(null, async () => { await vi.advanceTimersByTimeAsync(65_000); await rmOf(w).retryUnsaved(Date.now()); await drain(3); });
  const rm = rmOf(w);
  if (rm.unsaved.size || rm.inflight.size) violate(w, '5-copy-never-lands', `база здорова, а копии не легли: ${[...rm.unsaved.keys(), ...rm.inflight.keys()].join(', ')}`);
  for (const room of allRooms(w)) if (room.disconnected.size) violate(w, '5-grace-forever', `комната ${room.code} ждёт реконнекта после грейса: ${[...room.disconnected.keys()].join(', ')}`);
  for (const h of w.heroes) {
    let hasRun: boolean | undefined;
    await phase({ k: 'status', h: h.i }, async () => {
      const ws = lobby(w, h, { t: 'runStatus' });
      await drain(3);
      hasRun = (ws.frames.filter((f) => f.t === 'runStatus').at(-1) as { hasRun?: boolean } | undefined)?.hasRun;
      if (hasRun === undefined) violate(w, '5-stuck-status', `${h.charId}: статус забега без ответа: ${JSON.stringify(ws.frames.at(-1))}`);
    });
    if (hasRun) {
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        await phase({ k: 'abandon', h: h.i }, async () => {
          const ws = lobby(w, h, { t: 'abandon' });
          await drain(3);
          ok = ws.frames.some((f) => f.t === 'abandoned');
        });
        if (!ok) await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
      }
      if (!ok) violate(w, '5-stuck-abandon', `${h.charId}: «Завершить» не проходит`);
    }
    let joined: FakeConn | undefined;
    let why = '';
    for (let a = 0; a < 3 && !joined; a++) {
      await phase({ k: 'join', h: h.i, mode: 'fresh', r: 0, reuse: false }, async () => {
        const ws = lobby(w, h, { t: 'join', fresh: true });
        await drain(3);
        const j = ws.frames.find((f) => f.t === 'joined') as { floor?: { area?: string } } | undefined;
        if (j) {
          joined = ws;
          if (j.floor?.area !== 'town') violate(w, '5-join-not-town', `${h.charId}: вход «Соло» не в город, а в ${j.floor?.area}`);
        } else why = JSON.stringify(ws.frames.filter((f) => f.t === 'error').at(-1) ?? null);
      });
      if (!joined) await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
    }
    if (!joined) violate(w, '5-stuck-join', `${h.charId}: вход «Соло» не проходит: ${why}`);
    await phase({ k: 'close', h: h.i }, async () => { joined?.close(); await drain(3); });
  }
  await phase(null, async () => { await vi.advanceTimersByTimeAsync(20_000); await drain(3); });
  // 5: все ушли — комнат не осталось (пустая комната уничтожается сама, ждущих реконнекта после грейса нет).
  if (rmOf(w).rooms.size) violate(w, '5-room-leak', `все ушли, а комнаты живы: ${[...rmOf(w).rooms.values()].map((r) => `${r.code}/${r.area} клиентов ${r.clients.size}, ждут ${r.disconnected.size}`).join('; ')}`);
  // 1: в базе у каждой вещи одно место, и ничего не пропало иначе, чем стоком.
  const final = new Map<string, string[]>();
  const at = (uid: string, loc: string): void => { let a = final.get(uid); if (!a) final.set(uid, (a = [])); a.push(loc); };
  for (const [charId, r] of db.rows) for (const it of itemsOf(JSON.parse(r.json) as SaveState)) at(it.uid, `hero:${charId}`);
  for (const [userId, st] of db.stash) for (const it of (JSON.parse(st.json) as AccountStash).tabs.flat()) at(it.uid, `stash:${userId}`);
  for (const [uid, ls] of final) if (ls.length > 1) violate(w, '1-dup-item-db', `в базе вещь ${uid} сразу в: ${ls.join(', ')}`);
  for (const [uid, loc] of w.lastLoc) if (!final.has(uid) && !w.sinks.has(uid)) violate(w, '1-item-lost', `вещь ${uid} (последний раз: ${loc}) пропала без стока`);
}

/** Строка состояния для трассировки: где каждый герой, живой ли, здоровье; комнаты и их области. */
function traceLine(w: W): string {
  const locs = locate(w);
  const hs = w.heroes.map((h) => {
    const ls = locs.get(h.charId) ?? [];
    const l = ls.find((x) => x.kind === 'live') ?? ls.find((x) => x.kind === 'body') ?? ls.find((x) => x.kind === 'disc');
    const flags = `${lifePaid(w, h) ? ' [штраф]' : ''}${h.droppedDead ? ' [снят мёртвым]' : ''}`;
    if (!l) return `h${h.i}:off${flags}`;
    const p = l.p;
    const where = `${l.room.code.slice(-3)}/${l.room.area}${l.room.runNodeId ? `@${l.room.runNodeId}` : ''}`;
    return `h${h.i}:${l.kind}${ls.length > 1 ? `+${ls.length - 1}` : ''} ${where}${p ? ` ${p.alive ? 'жив' : 'мёртв'} ${Math.round(p.hp)}/${Math.round(p.maxHp)}` : ''}${l.info?.safe ? ' safe' : ''}${l.info?.paid ? ' paid' : ''}${flags}`;
  });
  const vers = w.heroes.map((h) => { const r = db.rows.get(h.charId); return `h${h.i}:v${r?.version}/${r ? (JSON.parse(r.json) as SaveState).gold : '?'}з`; }).join(' ');
  const rmx = rmOf(w) as unknown as { charOps: Map<string, unknown>; unsavedBackoff: Map<string, unknown>; inflight: Map<string, unknown> };
  return `${hs.join(' | ')} || комнат ${rmOf(w).rooms.size}, тик ${w.ticking.size}, unsaved [${[...rmOf(w).unsaved.keys()].join(',')}] ops [${[...rmx.charOps.keys()].join(',')}] backoff ${JSON.stringify([...rmx.unsavedBackoff])} inflight [${[...rmx.inflight.keys()]}], сбоев ${db.faults.length}; база ${vers}`;
}

interface RunResult { violations: Violation[]; ops: Op[] }
/** ⭐ R15-02: открыть ворота медленных записей, чья операция настала (`all` — все: ход времени, эпилог, конец прогона). */
function openHeld(op: number, all: boolean): number {
  let n = 0;
  for (const g of [...db.held]) {
    if (!all && g.until > op) continue;
    db.held.splice(db.held.indexOf(g), 1);
    g.open();
    n++;
  }
  return n;
}
/** `stopAt` — остановиться на первом нарушении с этой меткой (сжатие); `null` — прогнать всё. */
async function run(seed: number, script: Op[] | null, nOps: number, stopAt: string | null): Promise<RunResult> {
  db.rows.clear(); db.stash.clear(); db.ledger.clear(); db.sessions.clear(); db.faults.length = 0; db.consumed = 0; db.writes.length = 0; db.pending.clear();
  openHeld(Infinity, true);
  db.unknownStreak.clear(); db.doubleUnknown.clear();
  db.run++;
  forgetTownStocks();
  env.reseed(mixSeed(seed, 0xe11));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: T0 });
  const ticking = new Set<RoomIn>();
  const w: W = {
    seed, heroes: [], rm: null as unknown as RmIn, rng: fuzzRng(mixSeed(seed, 0x0b5)), aux: fuzzRng(mixSeed(seed, 0xa11)), crew: fuzzRng(mixSeed(seed, 0xc4e)), penaltyCount: new Map(),
    ask: fuzzRng(mixSeed(seed, 0xc09)), asked: null, lag: fuzzRng(mixSeed(seed, 0x1502)), unity: fuzzRng(mixSeed(seed, 0x1601)), shout: fuzzRng(mixSeed(seed, 0x1607)), saidBye: new WeakSet(),
    ticking, born: new WeakSet(), lobbies: [], pending: [], violations: [], seen: new Set(),
    penalties: [], sinks: new Set(), carryGone: new Set(), lastLoc: new Map(), sunkBy: new Map(), sold: new Set(), selling: [], sinkLater: new Set(), concurrent: false, ev: 0, opEv0: 0, recs: new Map(), roomSeen: new WeakMap(), ids: new WeakMap(), idSeq: 0,
    errors: [], cmdFailed0: counters.cmdFailed, frameErrors0: counters.frameErrors, op: -1, opRef: null, stepped: false,
  };
  cur = w;
  FakeConn.onFrame = (c, f) => noteFrame(w, c, f);
  // V1: сессию сняли «устаревшей» (4009), а герой в комнате мёртв (запись ухода — мёртвая): так он и ушёл.
  FakeConn.onServerClose = (c, code) => {
    if (code !== 4009 || c.hero === undefined || c.run !== db.run) return;
    const h = w.heroes[c.hero]!;
    const conn = rmOf(w).conns.get(c);
    const left = (conn?.room as unknown as { left?: Map<string, { alive: boolean }> } | undefined)?.left?.get(h.charId);
    if ((left && !left.alive) || lifePaid(w, h)) h.droppedDead = true;
  };
  const ops: Op[] = [];
  try {
    w.heroes = seedWorld(seed).heroes;
    w.rm = new RM(cfg) as unknown as RmIn;
    const total = script ? script.length : nOps;
    for (let i = 0; i < total; i++) {
      const op = script ? script[i]! : genOp(w, w.rng);
      ops.push(op);
      w.op = i; w.opRef = op;
      if (FUZZ_TRACE) console.info(`[fuzz ${seed}] #${i} ${fmt(op)}`);
      const pre = preState(w);
      db.writes.length = 0;
      // R15-02: медленная база отвечает в начале своей операции (и до хода времени) — её записи и то, что ждало их (прощание, «Завершить»),
      // проверка видит, как любую запись операции.
      if (openHeld(i, op.k === 'wait' || op.k === 'retry')) await drain(3);
      await watchdog(w, exec(w, op), `операция ${fmt(op)}`);
      check(w, pre, op);
      if (FUZZ_TRACE) console.info(`[fuzz ${seed}]     ${traceLine(w)}`);
      if (FUZZ_TRACE && process.env.DM_FUZZ_TRACE_LOG === '1') { for (const e of w.errors) process.stdout.write(`[fuzz ${seed}]       лог: ${e.slice(0, 220)}
`); w.errors.length = 0; }
      if (stopAt && w.violations.some((v) => v.inv === stopAt)) return { violations: w.violations, ops };
    }
    w.op = total;
    await watchdog(w, quiesce(w), 'эпилог', 120_000);
    return { violations: w.violations, ops };
  } catch (e) {
    if (e instanceof Hang) return { violations: w.violations, ops };
    throw e;
  } finally {
    for (let i = 0; i < db.consumed; i++) tally('fault-consumed');
    // Прогон кончен (в том числе посреди — сжатие останавливается на нарушении): его менеджер и комнаты больше ничего не делают —
    // таймеры сняты, а цепочки промисов, ещё идущие к мок-базе, дорабатывают БЕЗ прогона (`cur = null`: наблюдатели их не видят).
    // Иначе недоделанный «Завершить» прошлого прогона писал штраф героя с тем же id уже в следующем.
    cur = null;
    FakeConn.onFrame = null;
    FakeConn.onServerClose = null;
    openHeld(Infinity, true);
    for (const room of allRooms(w)) room.stop();
    ticking.clear();
    vi.clearAllTimers();
    await drain(20);
    vi.clearAllTimers();
    vi.useRealTimers();
    // Шпионы (`Math.random`, `performance.now`, `console`, методы `Room`, лимиты) копят историю вызовов — с аргументами (сейвы, комнаты):
    // ~4 МБ на сид, и прогон в тысячи сидов кончался нехваткой кучи. История фаззеру не нужна — чистим (подмены остаются).
    vi.clearAllMocks();
  }
}

/** Сжать до минимальной последовательности, на которой нарушение с той же меткой ещё есть. */
async function shrink(seed: number, ops: Op[], v: Violation): Promise<Op[]> {
  const cut = ops.slice(0, Math.min(ops.length, v.op + 1));
  const same = async (cand: Op[]): Promise<boolean> => {
    const r = await run(seed, cand, 0, v.inv);
    return r.violations.some((x) => x.inv === v.inv);
  };
  if (!(await same(cut))) return ops;
  return (await shrinkOps(cut, same, 250)).ops;
}

function report(seed: number, v: Violation, ops: Op[]): string {
  return [
    `✗ [${v.inv}] сид ${seed}, операция ${v.op}: ${v.msg}`,
    `  минимальная последовательность (${ops.length} оп.; повтор: DM_FUZZ_REPLAY='${JSON.stringify({ seed, ops })}'):`,
    ...ops.map((o, i) => `    ${String(i).padStart(3)} ${fmt(o)}`),
  ].join('\n');
}

beforeAll(async () => {
  ({ RoomManager: RM } = await import('./roomManager.js'));
  const roomMod = await import('./room.js');
  ({ forgetTownStocks, runLedgerKey } = roomMod);
  // 8: вход комнаты в узел и вход героя в комнату — под наблюдением (достигнутые узлы, `noteReached`).
  const proto = roomMod.Room.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const after = (name: string, fn: (room: RoomIn, ret: unknown) => void, pre?: (room: RoomIn) => void): void => {
    const orig = proto[name]!;
    vi.spyOn(proto, name).mockImplementation(function (this: RoomIn, ...a: unknown[]) { pre?.(this); const r = orig.apply(this, a); fn(this, r); return r; });
  };
  // 1: земля, которая уходит (смена этажа, уход комнаты), — законный сток («земля ушедшего этажа»). Проверка после операции её уже не
  // видит, если вещь легла на неё в той же операции (V-B2-04: запись выброса — сразу; её сбой снимает героя, и пати тут же уходит с этажа,
  // а пустая комната — совсем): иначе такая вещь читалась бы пропажей без стока.
  const groundGone = (room: RoomIn): void => {
    if (!cur?.born.has(room)) return;
    // ⭐ K3: поднимаемое (запись поднимающего в пути) с землёй не уходит — легла запись, вещь в его сумке; не легла — пропажа проверкой (сток).
    for (const d of room.session.world.drops) if (d.kind === 'item' && d.item) (room.carrying?.has(d) ? cur.carryGone : cur.sinks).add(d.item.uid);
  };
  after('enterNode', (room) => { if (cur?.born.has(room)) { noteReached(cur, room, [...room.clients.keys()]); noteRevived(cur, room); } }, groundGone);
  // Город оживляет всех в комнате (и тех, чей сокет уже закрыт, но закрытие до комнаты ещё не дошло: кадр им не уйдёт).
  after('enterTown', (room) => { if (cur?.born.has(room)) noteRevived(cur, room); }, groundGone);
  after('enterArenaFloor', () => undefined, groundGone);
  after('stop', groundGone);   // `stop` зовут только уходы комнаты
  after('attach', (room, pid) => {
    if (!cur?.born.has(room)) return;
    noteReached(cur, room, [pid as string]);
    // Сейв новой сессии — последняя виденная копия героя: снятая той же операцией (исход записи неизвестен), она и ждёт дописки.
    const save = room.session.world.players[pid as string]?.save;
    const h = cur.heroes.find((x) => x.charId === save?.charId);
    if (h && save) h.lastSave = save;
    // R4-04: вошедший в комнату своего забега встаёт на её узел, даже стоящую в городе («отставший встаёт на узел пати», `joinRun`).
    if (h && room.runConfig && room.nodeState && save?.run?.config && runLedgerKey(save.run.config) === runLedgerKey(room.runConfig)) {
      h.reached.add(`${runLedgerKey(room.runConfig)}|${room.nodeState.id}`);
    }
  });
  /** Вокруг метода: вход вызова (аргументы) и сам вызов (`call`) — для инвариантов, которым нужно состояние ДО и ПОСЛЕ. */
  const around = (target: Record<string, (...a: unknown[]) => unknown>, name: string, fn: (self: unknown, a: unknown[], call: () => unknown) => unknown): void => {
    const orig = target[name]!;
    vi.spyOn(target, name).mockImplementation(function (this: unknown, ...a: unknown[]) { return fn(this, a, () => orig.apply(this, a)); });
  };
  const heroBy = (w: W, charId: unknown): Hero | undefined => w.heroes.find((x) => x.charId === charId);
  const taken = (w: W, charId: string): number => w.penaltyCount.get(charId) ?? 0;
  const opText = (w: W): string => (w.opRef ? fmt(w.opRef) : 'эпилог');
  // 3 (C-03): «ЗАВЕРШИТЬ» ОЖИВШЕГО — ШТРАФ. Забег у героя есть, а с последнего штрафа он оживал (смена этажа — и ждущих реконнекта, город, вход
  // живым): «мёртв, оплачено» — уже не про эту жизнь, и «Завершить» (из грейса и по строке базы) штраф берёт, как у любого.
  around(proto, 'abandonAsDead', (self, a, call) => {
    const room = self as RoomIn;
    const w = cur;
    const [charId, insurance] = a as [string, boolean | undefined];
    const info = room.disconnected.get(charId);
    const h = w?.born.has(room) ? heroBy(w, charId) : undefined;
    const need = !!w && !!h && !insurance && !!info?.save.run?.config && !deathPaid(w, h);
    const n0 = w ? taken(w, charId) : 0;
    const r = call();
    if (need && taken(w, charId) === n0) {
      violate(w, '3-missing-penalty', `${charId}: «Завершить» из грейса комнаты ${room.code} (${info!.safe ? 'забег припаркован' : 'ждал реконнекта'}${info!.paid ? ', paid' : ''}${info!.save.run?.deadAt !== undefined ? `, «мёртв» на ${info!.save.run.deadAt}` : ''}) — без штрафа, а он с тех пор оживал; операция ${opText(w)}`, h);
    }
    return r;
  });
  const rmProto = RM.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  around(rmProto, 'abandonStored', (_self, a, call) => {
    const w = cur;
    const charId = a[1] as string;
    const h = w ? heroBy(w, charId) : undefined;
    const row = rowSave(charId);
    const need = !!w && !!h && !!row?.run?.config && !deathPaid(w, h);
    const n0 = w ? taken(w, charId) : 0;
    return (call() as Promise<unknown>).then((r) => {
      if (need && w === cur && taken(w, charId) === n0) {
        violate(w, '3-missing-penalty', `${charId}: «Завершить» по строке базы (${row!.run!.deadAt !== undefined ? `«мёртв, оплачено» на ${row!.run!.deadAt}` : 'забег'}) — без штрафа, а он с тех пор оживал; операция ${opText(w)}`, h);
      }
      return r;
    });
  });
  // 3 (C-04): ПОХОРОНЫ КОМНАТЫ — ТОЛЬКО ЕЁ ЗАБЕГА. Вайп, истечение грейса и уход пати с этажа (сбежавшие) штрафуют и снимают забег только его
  // участникам: гость со своим припаркованным забегом (и припаркованный, чья комната начала другой) не проигрывал ничего.
  const BURY = new Set(['bury', 'buryFled']);
  for (const name of ['wipe', 'expireGrace', 'buryFled']) {
    around(proto, name, (self, _a, call) => {
      const room = self as RoomIn;
      const w = cur;
      if (!w?.born.has(room)) return call();
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
        violate(w, '3-foreign-run-buried', `${g.charId}: ${name} комнаты ${room.code} (её забег ${key ?? '—'}) — ${[paid ? 'штраф' : '', now !== g.run ? 'забег снят' : ''].filter(Boolean).join(' и ')}, а его забег ${g.run} ей чужой; операция ${opText(w)}`, heroBy(w, g.charId));
      }
      return r;
    });
  }
  // 3 (R16 C-03): БЕГСТВО ИЗ БОЯ ДАРОМ НЕ ОТПУСКАЕТСЯ. Отпустить ждущего без штрафа (`releaseParked`: страховка входа, похороны чужого забега,
  // комната ушла в другой) можно припаркованного (`safe`), погибшего (`paid`) или ушедшего спокойно — а не сбежавшего посреди боя (`fled`).
  around(proto, 'releaseParked', (self, a, call) => {
    const room = self as RoomIn;
    const w = cur;
    const [charId, info] = a as [string, InfoIn];
    if (w?.born.has(room) && !info.safe && !info.paid && info.fled) {
      violate(w, '3-fled-released', `${charId}: комната ${room.code} (${room.area}, забег ${room.runConfig ? runLedgerKey(room.runConfig) : '—'}) отпустила без штрафа сбежавшего из боя (его забег ${info.save.run?.config ? runLedgerKey(info.save.run.config) : '—'}); операция ${opText(w)}`, heroBy(w, charId));
    }
    return call();
  });
  // 7 (R15-02): ПОСЛЕ ПРОЩАНИЯ СЕССИЯ НЕ ПИШЕТ. Прощальная запись ухода (`removePlayer`) легла — ни одна запись этой сессии (`write` с её
  // клиентом) после неё не ложится: вход заново читает строку сразу после прощания, и легшая позже снимала его по версии (4009), а копия
  // ждущего реконнекта отставала от строки — штраф смерти тела в бою отклонялся по версии.
  around(proto, 'removePlayer', (self, a, call) => {
    const room = self as RoomIn;
    const w = cur;
    const c = room.clients.get(a[0] as string);
    const done = call() as Promise<{ saved: boolean }>;
    if (w?.born.has(room) && c) void done.then((f) => { if (f.saved && w === cur) w.saidBye.add(c); });
    return done;
  });
  around(proto, 'write', (self, a, call) => {
    const room = self as RoomIn;
    const w = cur;
    const [c, p] = a as [ClientIn, PlayerIn];
    return (call() as Promise<string>).then((r) => {
      if (r === 'ok' && w && w === cur && w.saidBye.has(c)) {
        violate(w, '7-write-after-farewell', `${p.save.charId}: запись сессии ${c.pid} (комната ${room.code}) легла после её прощальной; операция ${opText(w)}`, heroBy(w, p.save.charId));
      }
      return r;
    });
  });
  // 5 (C-04): «ПРОДОЛЖИТЬ» — В СВОЙ ЗАБЕГ. Припаркованный (`safe`) возвращается реконнектом только в комнату, которая ведёт его забег.
  around(proto, 'reconnect', (self, a, call) => {
    const room = self as RoomIn;
    const w = cur;
    const ws = a[0] as FakeConn, save = a[2] as SaveState;
    if (w?.born.has(room) && ws.resume) {
      const info = room.disconnected.get(save.charId);
      const own = info?.save.run?.config;
      if (info?.safe && own && (!room.runConfig || runLedgerKey(own) !== runLedgerKey(room.runConfig))) {
        violate(w, '5-resume-foreign-run', `${save.charId}: «Продолжить» — в комнату ${room.code} (${room.area}, забег ${room.runConfig ? runLedgerKey(room.runConfig) : '—'}), а его припаркованный забег — ${runLedgerKey(own)}; операция ${opText(w)}`, heroBy(w, save.charId));
      }
    }
    return call();
  });
  // 5 (R17-02): «ПРОДОЛЖИТЬ» ЖИВОГО УЧАСТНИКА — НЕ В ГОРОД ДЕРЖАТЕЛЯ, ГДЕ ЕГО СПУСК ЖДАЛ БЫ ЧУЖОГО ГОЛОСА. К держателю «Продолжить» сажает
  // обычным входом (`addPlayer`); с забегом в сейве (погибший, K1, входит без него) — только в подземелье: там узел забега и есть пати. В город
  // или на арену, где уже кто-то подключён, — заложник: спуск ждал голоса каждого (у голосования нет срока), а выход был «Забросить» — штраф.
  around(proto, 'addPlayer', (self, a, call) => {
    const room = self as RoomIn;
    const w = cur;
    const ws = a[0] as FakeConn, save = a[2] as SaveState;
    if (w?.born.has(room) && ws.resume && save.run?.config && room.area !== 'dungeon' && room.clients.size > 0) {
      violate(w, '5-run-hostage', `${save.charId}: «Продолжить» — в ${room.area === 'town' ? 'город' : room.area} комнаты ${room.code} (подключено ${room.clients.size}), чей забег ${runLedgerKey(save.run.config)} стоит не в подземелье: его спуск ждёт голоса других; операция ${opText(w)}`, heroBy(w, save.charId));
    }
    return call();
  });
  // Зубы R17-02 (`teeth.r1702`): держатель в городе забег не отдаёт — «Продолжить» снова садит в его город.
  around(proto, 'yieldRun', (_self, _a, call) => (teeth.r1702 ? false : call()));
  // 8 (C-12): НОВЫЙ ЗАБЕГ — В ТИРЕ, ОТКРЫТОМ ХОТЬ ОДНОМУ ИЗ ПОДКЛЮЧЁННЫХ (ветеран несёт пати в свой тир, R9-08; без него — нельзя).
  around(proto, 'startRun', (self, _a, call) => {
    const room = self as RoomIn;
    const w = cur;
    if (w?.born.has(room)) {
      const ds = cfg.get('difficulties');
      const i = ds.findIndex((d) => d.id === room.difficultyId);
      const heroes = [...room.clients.keys()].map((pid) => room.session.world.players[pid]?.save).filter((s): s is SaveState => !!s);
      if (!heroes.some((s) => isDifficultyUnlocked(ds, i, s.difficultyProgress ?? {}))) {
        violate(w, '8-tier-locked-start', `комната ${room.code} начала забег в тире «${room.difficultyId}», закрытом всем подключённым (${heroes.map((s) => `${s.charId} ${JSON.stringify(s.difficultyProgress ?? {})}`).join('; ')}); операция ${opText(w)}`);
      }
    }
    return call();
  });
  // ⭐ САМОПРОВЕРКА (`DM_FUZZ_SELFTEST`): вернуть исправленный корень подменой метода — фаззер обязан его найти (зелёный прогон без неё
  // значит «корня нет», а не «проверки ослепли»). `v1` — снятый записью в подземелье не ждёт реконнекта и смерть не метится в сейве;
  // `v2` — забег не держит ни одна комната; `c03` — смена этажа ждущих реконнекта не оживляет; `c04` — комната, взявшая другой забег,
  // припаркованных чужого не отпускает, похороны и «Продолжить» чужой забег не различают; `c06` — закрытие снимает сессию в конце очереди
  // кадров; `c12` — тир нового забега не сверяется с оставшимися; `c05` — отказы без кода комнаты-держателя (снимает `FakeConn.send`).
  if (FUZZ_SELFTEST === 'v1') { vi.spyOn(proto, 'parks').mockReturnValue(false); vi.spyOn(proto, 'markDead').mockReturnValue(undefined); }
  if (FUZZ_SELFTEST === 'v2') vi.spyOn(proto, 'holdsRun').mockReturnValue(false);
  if (FUZZ_SELFTEST === 'c03') vi.spyOn(proto, 'reviveAway').mockReturnValue(undefined);
  if (FUZZ_SELFTEST === 'c04') {
    vi.spyOn(proto, 'releaseForeign').mockReturnValue(undefined);
    vi.spyOn(proto, 'foreignRun').mockReturnValue(false);
    vi.spyOn(proto, 'parkedForeign').mockReturnValue(false);
  }
  if (FUZZ_SELFTEST === 'c06') {
    const onClose = rmProto.onClose!;
    vi.spyOn(rmProto, 'onClose').mockImplementation(function (this: unknown, ...a: unknown[]) { void Promise.resolve().then(() => onClose.apply(this, a)); });
  }
  if (FUZZ_SELFTEST === 'c12') vi.spyOn(proto, 'tierOpenHere').mockReturnValue(true);
  // ⭐ R15-02: прощальная снова склеивается с ждущим автосейвом, а запись выброса ушедшего снова пишет (фаззер обязан найти
  // `7-write-after-farewell`).
  if (FUZZ_SELFTEST === 'r1502') {
    const persist = proto.persist!;
    vi.spyOn(proto, 'persist').mockImplementation(function (this: unknown, ...a: unknown[]) { return persist.call(this, a[0], a[1], a[2]); });
    type Soon = { fieldWrite: boolean };
    vi.spyOn(proto, 'writeSoon').mockImplementation(function (this: { queued(c: Soon, fn: () => unknown): unknown; write(...a: unknown[]): unknown }, ...a: unknown[]) {
      const [c, p, why] = a as [Soon, unknown, string | undefined];
      if (c.fieldWrite) return;
      c.fieldWrite = true;
      void this.queued(c, () => { c.fieldWrite = false; return this.write(c, p, undefined, why); });
    });
  }
  // ⭐ R15-02 (модель): неудачная транзакция «сейв + сундук» (сундук обогнали, база упала) не откатывается — действие остаётся в памяти, а
  // сундук базы без него. Транзакция в пути (медленная база) дюпа не судит только до своего конца: фаззер обязан найти `1-dup-item` после.
  if (FUZZ_SELFTEST === 'r1502tx') {
    const write = proto.write!;
    vi.spyOn(proto, 'write').mockImplementation(async function (this: unknown, ...a: unknown[]) {
      const r = await write.apply(this, a);
      return a[2] && r !== 'ok' && !(a[0] as { stale?: boolean }).stale ? 'ok' : r;
    });
  }
  // ⭐ R16 C-03: вход по коду в подземелье чужого забега со своим припаркованным — снова пускается (фаззер обязан найти `3-dungeon-foreign-run`).
  if (FUZZ_SELFTEST === 'r16c03') vi.spyOn(proto, 'runClashOn').mockReturnValue(false);
  if (FUZZ_SELFTEST === 'r1601') vi.spyOn(proto, 'insuranceCharges').mockReturnValue(false);   // R16-01: вход снова бросает забег за штраф
  // ⭐ R16-07: баффы с арены — остатком на вход в неё, как до правки (фаззер обязан найти `4-buff-outlived`).
  if (FUZZ_SELFTEST === 'r1607') {
    const orig = proto.leaveArena!;
    vi.spyOn(proto, 'leaveArena').mockImplementation(function (this: RoomIn) {
      const homes = (this as unknown as { arenaHome: Map<string, { state: { skillBuffs: Record<string, number> } }> }).arenaHome;
      const keep = new Map([...homes].map(([id, h]) => [id, { ...h.state.skillBuffs }]));
      const r = orig.apply(this);
      for (const p of Object.values(this.session.world.players)) { const b = keep.get(p.save.charId); if (b) p.skillBuffs = b; }
      return r;
    });
  }
  cfg = new ConfigRegistry();
  cfg.loadAll();
  // Лимиты частоты — не предмет этого фаззера: операции идут быстрее живого клиента по поддельным часам.
  for (const l of Object.values(limits) as { take(k: string): boolean; peek(k: string): boolean }[]) {
    vi.spyOn(l, 'take').mockReturnValue(true);
    if (typeof l.peek === 'function') vi.spyOn(l, 'peek').mockReturnValue(true);
  }
  // Тик комнат ведёт фаззер (`stepAll`), а не планировщик: комната, снятая с тика (пауза грейса, уничтожение), не шагает.
  vi.spyOn(tickScheduler, 'add').mockImplementation((r) => { cur?.ticking.add(r as RoomIn); cur?.born.add(r as RoomIn); });
  vi.spyOn(tickScheduler, 'remove').mockImplementation((r) => { cur?.ticking.delete(r as RoomIn); });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  // Фаза автосейва и снимков комнаты, uid вещей (uuidv7) — из `Math.random`: и они от сида прогона, иначе повтор и сжатие не те же.
  vi.spyOn(Math, 'random').mockImplementation(() => env.next());
  spy.onPenalty = (save, removed, gold, stack) => {
    if (!cur || (save as unknown as Record<string, unknown>)[RUN_TAG] !== db.run) return;   // сейв прошлого прогона — не наш
    const src = ['abandonStored', 'endLinger', 'onPlayerDeath', 'settleStored', 'abandonAsDead', 'buryFled', 'finalizeDisconnectedAsDead', 'buryDisconnected']
      .find((n) => stack.includes(n)) ?? '?';
    const map: Record<string, string> = {
      abandonStored: 'abandonStored', endLinger: 'linger', onPlayerDeath: 'death', settleStored: 'stored', abandonAsDead: 'abandonAsDead',
      buryFled: 'buryFled', finalizeDisconnectedAsDead: 'bury', buryDisconnected: 'bury', '?': '?',
    };
    // C-03: забег сейва (его бросают) и, у смерти, забег комнаты, где он погиб (сущность с этим сейвом ещё в её мире).
    const run = save.run?.config ? runLedgerKey(save.run.config) : null;
    const room = src === 'onPlayerDeath' || src === 'endLinger' ? allRooms(cur).find((r) => Object.values(r.session.world.players).some((p) => p.save === save)) : undefined;
    const where = room?.runConfig ? runLedgerKey(room.runConfig) : null;
    cur.penalties.push({ charId: save.charId, removed, gold, src: map[src]!, op: cur.op, save, ev: ++cur.ev, run, where });
    cur.penaltyCount.set(save.charId, (cur.penaltyCount.get(save.charId) ?? 0) + 1);
    // ⭐ Перепрогон R16: штраф по строке базы («Завершить» без грейса, запись по строке при устаревшей копии) — эту копию менеджер или комната
    // сейчас и пишут: пока запись в пути (медленная база), правда героя — она, а не последняя копия из комнаты (строку тем временем могла
    // сдвинуть другая нода — `veteran`).
    if (src === 'abandonStored' || src === 'settleStored') { const h = cur.heroes.find((x) => x.charId === save.charId); if (h) h.lastSave = save; }
    tally(`pen:${map[src]}`);
    if (FUZZ_TRACE) process.stdout.write(`[fuzz ${cur.seed}]     штраф ${save.charId} (${map[src]}): золото −${gold}, вещи ${removed.join(',') || '—'}\n`);  };
  const keep = (lvl: 'error' | 'warn' | 'log' | 'info') => vi.spyOn(console, lvl).mockImplementation((...a: unknown[]) => {
    const s = a.map((x) => (x instanceof Error ? `${x.message}` : String(x))).join(' ');
    if (lvl === 'info' && s.startsWith('[fuzz')) { process.stdout.write(`${s}\n`); return; }
    if (!cur) return;
    cur.errors.push(s.slice(0, 300));
    if (cur.errors.length > 50) cur.errors.shift();
    // 6: сбои, которые код ловит сам, но которых быть не должно (падение продолжения, закрытия, фоновой дописки; отказ, тронувший сейв).
    if (/продолжение забега из города упало|отказ при закрытии соединения|фоновая дописка копии|сундук на входе|изменил сейв .* — откачено/.test(s)) violate(cur, '6-internal-error', s.slice(0, 300));
    // 7: инцидент — копия героя забыта (отданное ею у двоих).
    if (/ИНЦИДЕНТ/.test(s)) violate(cur, '7-copy-forgotten', s.slice(0, 300));
    // 7: база отклонила запись по версии, хотя база не сбоила ни разу — у героя был второй писатель.
    if (/ОТКЛОНЁН устаревший сейв|копия отключённого .* устарела/.test(s) && db.consumed === 0) violate(cur, '7-second-writer', s.slice(0, 300));
  });
  keep('error'); keep('warn'); keep('log'); keep('info');
  process.on('unhandledRejection', onUnhandled);
});
afterAll(() => { process.off('unhandledRejection', onUnhandled); vi.restoreAllMocks(); });
function onUnhandled(e: unknown): void { if (cur) violate(cur, '6-unhandled-rejection', e instanceof Error ? `${e.message} ${e.stack?.split('\n').slice(1, 3).join(' ')}` : String(e)); }

/**
 * Прогнать сиды. Каждое нарушение с НЕИЗВЕСТНЫМ корнем — со сжатой последовательностью (одна на метку); с известным (`KNOWN`) — счётом
 * (сжатие и для них — `DM_FUZZ_SHRINK_KNOWN=1`).
 */
async function sweep(seeds: number[], nOps: number, doShrink: boolean): Promise<{ found: Map<string, string>; counts: Map<string, number> }> {
  const found = new Map<string, string>();
  const counts = new Map<string, number>();
  const shrinkKnown = process.env.DM_FUZZ_SHRINK_KNOWN === '1';
  for (const [n, seed] of seeds.entries()) {
    if (FUZZ_HEAP && n % FUZZ_HEAP === 0) {
      (globalThis as { gc?: () => void }).gc?.();
      logLine(`@@H ${n} сидов: куча ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} МБ`);
    }
    const r = await run(seed, null, nOps, null);
    for (const v of r.violations) {
      const key = `${v.inv}${v.cause ? ` (${v.cause})` : ''}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      // Каждое нарушение — строкой (сид, метка, корень, сколько сбоев базы было к нему): разные корни под одной меткой видно по тексту.
      if (FUZZ_SEEDS) process.stdout.write(`@@V ${seed} ${key} сбоев=${v.faults} оп=${v.op} ${v.msg.slice(0, 240)}\n`);
      logLine(`@@V ${seed} ${key} сбоев=${v.faults} оп=${v.op} ${v.msg.slice(0, 240)}`);
    }
    const first = new Map<string, Violation>();
    for (const v of r.violations) {
      const key = knownCause(v.cause) && !shrinkKnown ? `known:${v.cause}` : `${v.inv}${v.cause ? ` (${v.cause})` : ''}`;
      if (!first.has(key)) first.set(key, v);
    }
    for (const [key, v] of first) {
      if (found.has(key)) continue;
      const shrinkIt = doShrink && (!knownCause(v.cause) || shrinkKnown);
      const ops = shrinkIt ? await shrink(seed, r.ops, v) : r.ops.slice(0, v.op + 1);
      const again = shrinkIt ? (await run(seed, ops, 0, null)).violations.find((x) => x.inv === v.inv) ?? v : v;
      const text = shrinkIt ? report(seed, again, ops) : `✗ [${v.inv}] (${v.cause ?? 'не сжато'}) сид ${seed}, операция ${v.op}: ${v.msg}`;
      found.set(key, text);
      if (!v.cause || shrinkKnown || FUZZ_SEEDS) process.stdout.write(`${text}\n`);
      logLine(text);
    }
  }
  return { found, counts };
}

/**
 * ИЗВЕСТНЫЕ КОРНИ, найденные этим фаззером и ещё не исправленные (см. `causeOf`): прогон их считает и печатает, но не падает — падает
 * всё, что они не объясняют. Шаг исправления снимает корень отсюда и `.fails` с его теста ниже — тогда фаззер держит его сам.
 * Проход правок 1 снял все три:
 *  • V1-dead-dropped — снятый записью в подземелье ждёт реконнекта в своей комнате (`Room.parkStale`), а оплаченная смерть — в сейве
 *    (`run.deadAt`): ни второго штрафа на «Завершить», ни оживления «Продолжить»/«Соло» со спуском;
 *  • V2-run-in-two-rooms — один забег держит одна комната (`Room.holdsRun`, `RoomManager.runRooms`, в кластере — `run_locks`): «Продолжить»
 *    ведёт в неё, спуск из другой комнаты — отказ с её кодом;
 *  • V3-unsure-overwritten — снимки ВСЕХ записей с неизвестным исходом от подтверждённой версии (`noteUnsure`, `landedOf`).
 * Метки, которые `causeOf` приписывает этим корням, теперь — нарушения: корень вернулся.
 */
const KNOWN: Record<string, string> = {};
/** Корень нарушения — известный и ещё не исправленный (`KNOWN`): такое считается, но прогон на нём не падает. */
function knownCause(c: string | undefined): boolean {
  return c !== undefined && Object.prototype.hasOwnProperty.call(KNOWN, c);
}

/** Повтор сжатой последовательности: какие метки нарушений она даёт. */
async function replay(seed: number, ops: Op[]): Promise<Violation[]> {
  return (await run(seed, ops, 0, null)).violations;
}

describe('⭐ B1: фаззер жизненного цикла коопа (RoomManager + Room, поддельные часы, честная база)', () => {
  if (process.env.DM_FUZZ_REPLAY) {
    it('повтор последовательности', async () => {
      const { seed, ops } = JSON.parse(process.env.DM_FUZZ_REPLAY!) as { seed: number; ops: Op[] };
      const r = await replay(seed, ops);
      for (const v of r) process.stdout.write(`✗ [${v.inv}]${v.cause ? ` (${v.cause})` : ''} операция ${v.op}: ${v.msg}\n`);
      expect(r.map((v) => v.inv)).toEqual([]);
    });
    return;
  }
  it(FUZZ_SEEDS ? `сиды ${FUZZ_SEED0}…${FUZZ_SEED0 + FUZZ_SEEDS - 1}` : 'фиксированные сиды: инварианты держатся (кроме известных корней)', async () => {
    const seeds = FUZZ_SEEDS ? Array.from({ length: FUZZ_SEEDS }, (_, i) => FUZZ_SEED0 + i) : DEFAULT_SEEDS;
    const { found, counts } = await sweep(seeds, FUZZ_OPS || (FUZZ_SEEDS ? 140 : DEFAULT_OPS), FUZZ_SHRINK);
    process.stdout.write(`[fuzz] сидов ${seeds.length}; нарушений: ${JSON.stringify(Object.fromEntries(counts))}\n`);
    if (FUZZ_SEEDS) process.stdout.write(`[fuzz] покрытие: ${JSON.stringify(Object.fromEntries([...stats].sort((a, b) => a[0].localeCompare(b[0]))))}\n`);
    const unknown = [...found.keys()].filter((k) => !k.startsWith('known:') && !Object.keys(KNOWN).some((c) => k.endsWith(`(${c})`)));
    expect(unknown, [...unknown.map((k) => found.get(k))].join('\n\n')).toEqual([]);
  });

  // Сжатие и повтор верны, только пока прогон детерминирован: тот же сид — те же операции, те же нарушения (коды комнат, uid — в тексте).
  it('детерминизм: тот же сид — та же последовательность и те же нарушения', async () => {
    const a = await run(11, null, 60, null);
    const b = await run(11, null, 60, null);
    expect(JSON.stringify(b.ops)).toBe(JSON.stringify(a.ops));
    expect(b.violations.map((v) => `${v.inv}@${v.op}:${v.msg}`)).toEqual(a.violations.map((v) => `${v.inv}@${v.op}:${v.msg}`));
  });

  /**
   * НАЙДЕННОЕ ФАЗЗЕРОМ И ИСПРАВЛЕННОЕ — сжатые фаззером последовательности (повтор одной: `DM_FUZZ_REPLAY`). Пока корень не был исправлен,
   * нарушение было — тест стоял `it.fails`; теперь он держит правку: повтор проходит без нарушения этой метки (и без любых других).
   */
  const fixedRoot = (name: string, seed: number, ops: Op[], inv: string): void => {
    it(name, async () => {
      const got = (await replay(seed, ops)).map((v) => `${v.inv}${v.cause ? ` (${v.cause})` : ''}: ${v.msg}`);
      expect(got.filter((v) => v.startsWith(inv)), 'нарушение корня вернулось').toEqual([]);
      expect(got, 'повтор без нарушений').toEqual([]);
    });
  };
  // V1: A и B в коопе, A погиб (штраф взят, ждёт мёртвым); автосейв A — исход фиксации неизвестен (не легла) → сессию A сняли
  // «устаревшей» (4009) без грейса, копия дописана с забегом — «мёртв, оплачено» нигде нет. «Завершить» (эпилог) — ВТОРОЙ штраф.
  fixedRoot('V1a: погибший, снятый «устаревшим», платит штраф второй раз на «Завершить»', 119, [
    { k: 'join', h: 2, mode: 'code', r: 0.2818888211622834, reuse: true },
    { k: 'descend', h: 2, r: 0.09167849086225033, others: 'no', near: true },
    { k: 'join', h: 3, mode: 'friend', r: 0.5081662330776453, reuse: true },
    { k: 'kill', h: 2, body: false },
    { k: 'fault', f: 'unknownLost', h: null },
    { k: 'wait', ms: 61000 },
  ], '3-double-penalty');
  // V1: A и B в коопе, B погиб; записи обоих — исход неизвестен → обе сессии сняты, комната пуста и уничтожена (грейса нет). Вход B
  // «Соло» и спуск — «Продолжить» его забега: B ЖИВЫМ на узле, где погиб (пати этаж не меняла).
  fixedRoot('V1b: погибший, снятый «устаревшим», оживает на своём узле спуском из новой комнаты', 1010, [
    { k: 'join', h: 0, mode: 'friend', r: 0.2928129539359361, reuse: true },
    { k: 'descend', h: 0, r: 0.4207423711195588, others: 'no', near: true },
    { k: 'join', h: 1, mode: 'friend', r: 0.21628837287425995, reuse: false },
    { k: 'kill', h: 1, body: false },
    { k: 'fault', f: 'unknownLanded', h: 1 },
    { k: 'fault', f: 'unknownLost', h: null },
    { k: 'wait', ms: 16000 },
    { k: 'join', h: 1, mode: 'code', r: 0.1616464799735695, reuse: true },
    { k: 'descend', h: 1, r: 0.655371532542631, others: 'no', near: true },
  ], '2-revived-elsewhere');
  // V2 БЕЗ СБОЕВ: два героя одного забега (здесь — одного аккаунта) в городе, B вышел; A продолжает забег в своей комнате, B — «Соло» и
  // спуск (его припаркованный забег) в новой: обе комнаты на одном узле, и один и тот же сундук открывается в каждой.
  fixedRoot('V2a: один забег в двух комнатах — сундук узла открывается дважды (без сбоев базы)', 7, [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'friend', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false },
    { k: 'wait', ms: 1600 },
    { k: 'town', h: 0, others: 'yes', near: true },
    { k: 'close', h: 1 },
    { k: 'wait', ms: 1600 },
    { k: 'descend', h: 0, r: 0, others: 'none', near: false },
    { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false },
    { k: 'descend', h: 1, r: 0, others: 'none', near: false },
    { k: 'chest', h: 0, r: 0.1 },
    { k: 'chest', h: 1, r: 0.1 },
  ], '8-node-double-loot');
  // V2 через сбой: спуск пати, запись B на входе в узел — исход неизвестен (легла) → сессию B сняли; A открыл сундук; B «Продолжить» —
  // грейса нет, и забег собирается в НОВОЙ комнате на том же узле: свод из базы ещё без сундука A (чекпойнт не наступил) — сундук снова закрыт.
  fixedRoot('V2b: снятый «устаревшим» продолжает забег пати в новой комнате — узел без взятого', 1371, [
    { k: 'join', h: 0, mode: 'friend', r: 0.7457588214892894, reuse: false },
    { k: 'join', h: 1, mode: 'friend', r: 0.9061467600986362, reuse: true },
    { k: 'fault', f: 'unknownLanded', h: 1 },
    { k: 'descend', h: 1, r: 0.10754031222313643, others: 'yes', near: true },
    { k: 'chest', h: 0, r: 0.5807084455154836 },
    { k: 'join', h: 1, mode: 'resume', r: 0.09966109460219741, reuse: false },
  ], '8-node-refarmable');
  // V3: A и B на узле, B у монстра; запись B на выходе — исход неизвестен, но ЛЕГЛА (снимок в `unsure`); тело B в бою погибло — штраф на
  // копии, её запись — исход неизвестен и НЕ легла, и её снимок затёр первый. Дописка: отказ по версии, сверка со снимком второй — «не
  // легла», копия устарела → отброшена. Грейс истёк: погиб оплачено (`paid`) — штрафа нет. Итог: смерть без штрафа, вещи и золото целы.
  fixedRoot('V3: две записи подряд с неизвестным исходом — штраф смерти тела в бою пропадает (вещи возвращаются)', 7, [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'friend', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false },
    { k: 'move', h: 1, to: 'monster', r: 0.3 },
    { k: 'step', n: 10 },
    { k: 'fault', f: 'unknownLanded', h: 1 },
    { k: 'fault', f: 'unknownLost', h: 1 },
    { k: 'close', h: 1 },
    { k: 'kill', h: 1, body: true },
    { k: 'step', n: 10 },
  ], '1-sunk-item-back');

  // ── Проход правок 2 (C-03, C-04, C-06, C-12): последовательности ревью — повтор без нарушений (самопроверка `DM_FUZZ_SELFTEST=c03|c04|c06|c12`
  // возвращает корень, и эти же повторы падают на его метке).
  // C-03: B погиб (штраф) и закрыл вкладку; A один увёл пати в город (B — припаркован) и вышел; грейс истёк — копия B легла с «мёртв,
  // оплачено»; «Завершить» B по строке базы — без штрафа. Город оживил и его: штраф обязателен (как у B, дождавшегося города подключённым).
  fixedRoot('C-03: погибший ушёл до возврата пати в город — «Завершить» после грейса берёт штраф', 7, [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'friend', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'step', n: 3 },
    { k: 'kill', h: 1, body: false },
    { k: 'close', h: 1 },
    { k: 'town', h: 0, others: 'none', near: true, pause: true },
    { k: 'close', h: 0 },
    { k: 'wait', ms: 3_601_000 },
    { k: 'status', h: 1 },
    { k: 'abandon', h: 1 },
    { k: 'step', n: 2 },
  ], '3-missing-penalty');
  // C-04: B спокойно вышел в подземелье, A увёл пати в город (B — припаркован с забегом X), завершил X и начал в той же комнате забег Y. «Продолжить»
  // B вело в подземелье Y (его голос — отказ `run`), а вайп Y хоронил его со штрафом и снимал X.
  const c04: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'friend', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'move', h: 1, to: 'entry', r: 0 },
    { k: 'close', h: 1 },
    { k: 'town', h: 0, others: 'none', near: true, pause: true },
    { k: 'abandon', h: 0 },
    { k: 'join', h: 0, mode: 'code', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'none', near: false, pause: true },
    { k: 'join', h: 1, mode: 'resume', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
  ];
  fixedRoot('C-04a: грейс-комната начала другой забег — «Продолжить» ведёт в свой', 7, c04, '5-resume-foreign-run');
  fixedRoot('C-04b: …и вайп чужого забега его не хоронит', 7, [
    ...c04, { k: 'move', h: 1, to: 'entry', r: 0 }, { k: 'close', h: 1 }, { k: 'kill', h: 0, body: false }, { k: 'step', n: 3 },
  ], '3-foreign-run-buried');
  // C-06: закрытая вкладка — не сессия сразу (раньше — в конце очереди кадров соединения).
  fixedRoot('C-06: закрытие снимает сессию сразу', 7, [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'close', h: 0 },
  ], '7-closed-still-live');
  // C-12: ветеран (открыта «сложная») позвал её и ушёл из города; свежий «за» один — и начинал «сложную» соло.
  fixedRoot('C-12: позвавший «сложную» ушёл — свежий её не начинает', 7, [
    { k: 'veteran', h: 0, tier: 1, depth: 20 },
    { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 0, mode: 'friend', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'none', near: false, pause: true, diff: 2 },
    { k: 'leave', h: 0 },
    { k: 'vote', h: 1, yes: true },
  ], '8-tier-locked-start');

  // ── Проход правок 2 (клиент): C-05 (самопроверка `DM_FUZZ_SELFTEST=c05` снимает код держателя с отказов — повтор падает на своей метке).
  // C-05: A и B прошли узел и вернулись в город, A вышел из города (забег припаркован, грейса нет); его место заняли трое по коду — пати забега
  // полна, и она продолжила забег (⭐ R17-02: держатель в городе забег живому участнику отдаёт — «нет мест» только у пати в подземелье). «Продолжить»
  // A — отказ «нет мест» без кода: на экране «Продолжить / Забросить» идти некуда, выход — «Забросить» (штраф смерти).
  fixedRoot('C-05: пати забега полна — «Продолжить» отказывает с её кодом, «Соло» — город, забег цел', 7, [
    { k: 'recruit' }, { k: 'recruit' }, { k: 'recruit' },   // до пяти героев (лишние — ничего)
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'close', h: 0 },
    { k: 'join', h: 2, mode: 'code', r: 0, reuse: false },
    { k: 'join', h: 3, mode: 'code', r: 0, reuse: false },
    { k: 'join', h: 4, mode: 'code', r: 0, reuse: false },
    { k: 'descend', h: 1, r: 0, others: 'yes', near: false, pause: true },
    { k: 'join', h: 0, mode: 'resume', r: 0, reuse: false },
  ], '5-resume-dead-end');
  // ⭐ R17-02: ЗАЛОЖНИК ЗАБЕГА. A и B прошли узел и вернулись в город, A вышел; B стоит в городе и ничего не делает. «Продолжить» A садило его в
  // город B (держатель забега, V2): спуск ждал голоса B (голосование без срока), «Соло» и спуск — отказ «забег идёт в комнате …», выход —
  // «Забросить» (штраф смерти). Теперь держатель в городе забег отдаёт: A — в новой комнате на узле забега. Самопроверка `r1702` — город снова держит.
  const HOSTAGE: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'yes', near: false, pause: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'leave', h: 0 },
    { k: 'join', h: 0, mode: 'resume', r: 0, reuse: false },
    { k: 'descend', h: 1, r: 0, others: 'none', near: false, pause: true },
  ];
  fixedRoot('R17-02: напарник стоит в городе — «Продолжить» вышедшего берёт забег в новую комнату, а не ждёт его голоса', 7, HOSTAGE, '5-run-hostage');
  it('самопроверка R17-02: держатель в городе забег не отдаёт — `5-run-hostage`', async () => {
    teeth.r1702 = true;
    try {
      expect((await replay(7, HOSTAGE)).map((v) => v.inv)).toContain('5-run-hostage');
    } finally { teeth.r1702 = FUZZ_SELFTEST === 'r1702'; }
  });

  // ── АРТЕФАКТ СТЕНДА (прогон после прохода правок 2, K3 `pickThrown`): вещь, чья земля ушла, пока запись поднимающего была в пути, `groundGone`
  // стоком не числил, а проверка на земле её не видела (выброс, подъём и уход с этажа — одна операция: голосование решилось снятием соседа,
  // чья запись — исход неизвестен), — и числила пропажей из сумки выбросившего. Теперь это решает проверка по концу записи (`carryGone`).
  // B поднимает брошенное A; его запись с вещью — исход неизвестен (легла), B снят, спуск A решён: вещь на земле города за B, дописка копии B
  // без неё легла — вещь ушла с землёй (сток по дизайну).
  fixedRoot('стенд: подъём соседа в пути, пока пати ушла с этажа, — вещь ушла с землёй, а не пропала без стока', 4001125, [
    { k: 'join', h: 2, mode: 'code', r: 0.25370119884610176, reuse: false },
    { k: 'fault', f: 'unknownLanded', h: 2 },
    { k: 'join', h: 3, mode: 'code', r: 0.8304552910849452, reuse: true },
    { k: 'descend', h: 3, r: 0.2834240226075053, others: 'none', near: true, pause: false, diff: 3 },
    { k: 'trade', h: 3, r: 0.6582428661640733 },
  ], '1-item-lost');
  // То же с арены: город с арены решён снятием соседа, пока его подъём брошенного в пути.
  fixedRoot('стенд: подъём соседа в пути, пока пати ушла с арены, — вещь ушла с землёй, а не пропала без стока', 4002646, [
    { k: 'recruit' },
    { k: 'join', h: 2, mode: 'friend', r: 0.7211114533711225, reuse: false },
    { k: 'join', h: 0, mode: 'code', r: 0.014242968522012234, reuse: false },
    { k: 'arena', h: 2, others: 'yes', pause: false },
    { k: 'town', h: 0, others: 'none', near: true, pause: true },
    { k: 'fault', f: 'unknownLanded', h: 2 },
    { k: 'trade', h: 0, r: 0.5909510210622102 },
  ], '1-item-lost');

  // ── НАЙДЕНО ПРОГОНОМ ПОСЛЕ ПРОХОДА ПРАВОК 2, ИСПРАВЛЕНО (проход правок 3).
  // A1-arena-home-regen: A и B на арене комнаты X (тело города каждого — `arenaHome` с меткой времени входа `at`). B уходит в свою комнату,
  // бьётся до 5% и возвращается в X по коду, пока арена идёт: `attach` освежал его тело города пулами сейва (`freshLeft`, R12-02), но метку `at`
  // оставлял прежней — и конец арены (`leaveArena`) начислял реген за ВСЁ время с первого входа, поверх пулов, где этот реген уже учтён,
  // а урон взят позже (1.4 → 25.5 из 30 за 1.6 с; арена дольше — полное здоровье, мана и выносливость даром). Теперь пулы сейва — вместе с
  // меткой «сейчас». Первый повтор — усиленный (арена 100 с), второй — сжатый фаззером (сид 4002867, 2.4 → 4.5 за 1.6 с).
  fixedRoot('A1: вернувшийся на идущую арену не получает реген за время, проведённое в другой комнате', 7, [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false },
    { k: 'arena', h: 0, others: 'yes', pause: true },
    { k: 'step', n: 3000 },
    { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false },
    { k: 'descend', h: 1, r: 0, others: 'none', near: true, pause: true },
    { k: 'hurt', h: 1, frac: 0.05 },
    { k: 'town', h: 1, others: 'none', near: true, pause: true },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
  ], '4-free-restore');
  fixedRoot('A1 (сид 4002867): реген конца арены — не за время в другой комнате', 4002867, [
    { k: 'join', h: 3, mode: 'friend', r: 0.7577773036900908, reuse: false },
    { k: 'arena', h: 3, others: 'yes', pause: true },
    { k: 'join', h: 1, mode: 'fresh', r: 0.39206379326060414, reuse: false },
    { k: 'join', h: 2, mode: 'friend', r: 0.4502187557518482, reuse: true },
    { k: 'descend', h: 2, r: 0.40180207462981343, others: 'none', near: false, pause: true },
    { k: 'join', h: 3, mode: 'friend', r: 0.659697197843343, reuse: true },
    { k: 'step', n: 90 },
    { k: 'descend', h: 3, r: 0.8251447721850127, others: 'yes', near: false, pause: true },
    { k: 'hurt', h: 3, frac: 0.1 },
    { k: 'join', h: 0, mode: 'friend', r: 0.1408002208918333, reuse: false },
    { k: 'town', h: 1, others: 'yes', near: true, pause: true },
    { k: 'leave', h: 2 },
    { k: 'join', h: 3, mode: 'friend', r: 0.34869159501977265, reuse: true },
    { k: 'close', h: 0 },
    { k: 'town', h: 3, others: 'none', near: true, pause: true },
  ], '4-free-restore');

  // ── R16 (ревью сервера), ИСПРАВЛЕНО. C-03: B паркует свой забег X (этаж соло, портал, закрыл вкладку в городе) и входит по коду к A в
  // подземелье забега Y: `joinRun` отдаёт забег комнаты только тому, у кого его нет, — B в бою со своим X. Ранен посреди боя, закрыл вкладку
  // (тело в бою, бегство) и ушёл «Соло»: страховка входа (`abandonAsDead`) и похороны (город, спуск пати) чужой забег отпускали без штрафа —
  // с добычей и 30 % здоровья. Теперь такой вход — отказ `run` (самопроверка `DM_FUZZ_SELFTEST=r16c03` его снимает: повтор падает).
  const r16c03 = (exit: Op[]): Op[] => [
    { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false },
    { k: 'descend', h: 1, r: 0, others: 'none', near: false, pause: true },
    { k: 'town', h: 1, others: 'none', near: true, pause: true },
    { k: 'close', h: 1 },
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0, others: 'none', near: false, pause: true },
    { k: 'join', h: 1, mode: 'code', r: 0, reuse: false },
    { k: 'move', h: 1, to: 'monster', r: 0.1 },
    { k: 'hurt', h: 1, frac: 0.3 },
    { k: 'close', h: 1 },
    ...exit,
  ];
  fixedRoot('R16 C-03a: гость с припаркованным забегом не входит в подземелье чужого — бегство «Соло» не даром', 7,
    r16c03([{ k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false }]), '3-dungeon-foreign-run');
  fixedRoot('R16 C-03b: …и пати, ушедшая в город, не уносит его из боя даром', 7,
    r16c03([{ k: 'wait', ms: 1600 }, { k: 'town', h: 0, others: 'none', near: true, pause: false }]), '3-dungeon-foreign-run');
  // ⭐ E2E 28.09 (большой прогон, сид 60995, сжато 140 → 9): ОКНО ВАЙПА. h0 и h1 прошли узел и вернулись в город (забег припаркован у обоих),
  // h0 вышел, h1 спустился один и погиб — вайп снял забег комнаты, до города 4 с (`WIPE_RETURN_MS`), этаж с монстрами стоит. h0 входит по коду
  // в это окно со своим припаркованным забегом — C-03 требовал забег у комнаты и пускал; h0 у монстра — и уход из боя отпускался даром
  // (`foreignRun` без забега комнаты). Теперь такой вход — отказ `run`.
  fixedRoot('E2E 28.09: вход по коду в окно вайпа со своим забегом — отказ, бегство из боя не даром', 60995, [
    { k: 'join', h: 0, mode: 'friend', r: 0.14394234027713537, reuse: false },
    { k: 'descend', h: 0, r: 0.3915926623158157, others: 'yes', near: true, pause: true },
    { k: 'join', h: 1, mode: 'code', r: 0.38067897595465183, reuse: false },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'close', h: 0 },
    { k: 'descend', h: 1, r: 0.8706523871514946, others: 'yes', near: false, pause: true },
    { k: 'kill', h: 1, body: false },
    { k: 'join', h: 0, mode: 'friend', r: 0.13522273022681475, reuse: false },
    { k: 'move', h: 0, to: 'monster', r: 0.6776168735232204 },
  ], '3-');

  // ── R16 (ревью клиента), ИСПРАВЛЕНО. C-09: трое в коопе спускаются, h1 гибнет на узле (штраф взят) и закрывает вкладку — ждёт пати мёртвым
  // (`paid`). Экран входа: статус забега не говорил, что смерть оплачена, и «Незавершённое прохождение» грозило «штраф золота и части
  // предметов», а «Завершить» с него штрафа (верно, V1) не брало — бесплатный выход выглядел платным. Теперь статус несёт `dead`
  // (самопроверка `DM_FUZZ_SELFTEST=c09` его снимает: повтор падает на `5-status-promise`). Сжато фаззером (сид 1, 40 сидов — 9 таких).
  fixedRoot('R16 C-09: погибший, ждущий пати, — экран «Продолжить / Забросить» говорит «без штрафа», и «Завершить» его не берёт', 1, [
    { k: 'join', h: 2, mode: 'friend', r: 0.6585034593008459, reuse: false },
    { k: 'fault', f: 'unknownLost', h: null },
    { k: 'join', h: 1, mode: 'code', r: 0.4984316201880574, reuse: true },
    { k: 'close', h: 2 },
    { k: 'join', h: 2, mode: 'friend', r: 0.46297631599009037, reuse: true },
    { k: 'leave', h: 2 },
    { k: 'join', h: 1, mode: 'code', r: 0.8807855825871229, reuse: false },
    { k: 'join', h: 0, mode: 'friend', r: 0.8267209047917277, reuse: false },
    { k: 'descend', h: 1, r: 0.9967779582366347, others: 'yes', near: false, pause: true },
    { k: 'descend', h: 1, r: 0.5323676853440702, others: 'yes', near: true, pause: true, diff: 1 },
    { k: 'descend', h: 1, r: 0.47436228673905134, others: 'yes', near: false, pause: false },
    { k: 'descend', h: 1, r: 0.7458896802272648, others: 'yes', near: true, pause: true },
    { k: 'close', h: 1 },
    { k: 'abandon', h: 1, ask: true },
  ], '5-status-promise');

  // ── Раунд 15 (сервер), ИСПРАВЛЕНО. R15-02: прощальная запись ушедшего склеивалась с ждущим автосейвом (R16 C-06), а запись выброса, вставшая
  // за ним, ложилась после прощания: вход заново читал строку до неё — и его первая запись получала отказ по версии (4009), а копия ждущего
  // реконнекта отставала от строки (штраф тела в бою отклонялся). Самопроверка `DM_FUZZ_SELFTEST=r1502` склейку возвращает — повторы падают
  // на своих метках. Сжато фаззером (40 сидов — во всех).
  fixedRoot('R15-02a: выброс в пути, автосейв ждёт, второй выброс за ним, обрыв — после прощальной сессия не пишет', 2, [
    { k: 'join', h: 1, mode: 'friend', r: 0.35151328053325415, reuse: false },
    { k: 'dropLeave', h: 1, r: 0.5487526264041662, fight: true },
  ], '7-write-after-farewell');
  fixedRoot('R15-02b: …и в подземелье копия ждущего реконнекта — на версии строки (её запись не отклоняется)', 11, [
    { k: 'join', h: 2, mode: 'fresh', r: 0.5666764681227505, reuse: true },
    { k: 'descend', h: 2, r: 0.9414858322124928, others: 'none', near: true, pause: true },
    { k: 'dropLeave', h: 2, r: 0.3268389622680843, fight: false },
    { k: 'wait', ms: 3601000 },
  ], '7-second-writer');

  // ── Перепрогон после правок раунда 15 (сиды 7 100 001…7 101 608), МОДЕЛЬ ФАЗЗЕРА — сервер прав. Медленная база (`slow`, R15-02) впервые
  // держит транзакцию «сейв + сундук» В ПУТИ на проверке: взятое из сундука уже в сумке копии в памяти (сейв на удержании, R1-05), а сундук
  // базы ещё с ним — это не дюп, а нерешённая копия (ляжет целиком или откатится к «до»), как копия «на дописать». И продажа, вставшая в
  // очередь кадров за этой транзакцией, исполняется операцией позже — сток тоже тогда, по её ответу, а не «продано в эту операцию».
  // Сжато фаззером (1600 сидов — 9 таких).
  fixedRoot('R15-02 (модель): взятое из сундука, пока его транзакция ждёт медленную базу, — не дюп', 7100949, [
    { k: 'join', h: 0, mode: 'fresh', r: 0.5328241274692118, reuse: false },
    { k: 'join', h: 0, mode: 'friend', r: 0.056991885183379054, reuse: false },
    { k: 'join', h: 0, mode: 'friend', r: 0.6732139943633229, reuse: false },
    { k: 'stash', h: 0, r: 0.5835583203006536, out: false },
    { k: 'fault', f: 'slow', h: 0, ops: 3 },
    { k: 'stash', h: 0, r: 0.8978843954391778, out: true },
  ], '1-dup-item');
  fixedRoot('R15-02 (модель): продажа, дождавшаяся транзакции сундука в очереди кадров, — законный сток', 7100903, [
    { k: 'join', h: 0, mode: 'friend', r: 0.4500343904364854, reuse: true },
    { k: 'stash', h: 0, r: 0.6567346500232816, out: false },
    { k: 'fault', f: 'slow', h: 0, ops: 3 },
    { k: 'stash', h: 0, r: 0.15683332551270723, out: true },
    { k: 'sell', h: 0, r: 0.6583681111223996 },
  ], '1-item-lost');
  // …и транзакция в пути, которую обогнал сосед по аккаунту (его перекладка в сундук легла раньше), откатывается целиком: взятое — снова
  // только в сундуке. Самопроверка `DM_FUZZ_SELFTEST=r1502tx` откат снимает — повтор падает на `1-dup-item` ПОСЛЕ записи (удержание
  // прощает дюп только в пути).
  fixedRoot('R15-02 (модель): транзакция сундука в пути, обогнанная соседом по аккаунту, откатывается — дюпа нет', 7, [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false },
    { k: 'stash', h: 0, r: 0.5, out: false },
    { k: 'stash', h: 1, r: 0.5, out: false },
    { k: 'fault', f: 'slow', h: 0, ops: 3 },
    { k: 'stash', h: 0, r: 0.1, out: true },
    { k: 'stash', h: 1, r: 0.9, out: true },
    { k: 'wait', ms: 1000 },
  ], '1-dup-item');
  // …и повтор недописанного (`retry`) при медленной базе: запись повтора, начатая самой операцией, ждала ворот, которые открывает лишь
  // операция ПОСЛЕ неё, — а операция ждала повтора: прогон висел (три процесса большого прогона из двенадцати). Повтор — ход времени, база
  // отвечает и ему (`6-hang` — сторож, которого у этого фаззера не было). Сжатые сиды 7100605, 7100646, 7100760, 7100804, 7101324 — все здесь.
  fixedRoot('R15-02 (модель): повтор недописанного при медленной базе не ждёт ворот следующей операции', 7, [
    { k: 'join', h: 1, mode: 'fresh', r: 0, reuse: false },
    { k: 'fault', f: 'fail', h: 1 },
    { k: 'close', h: 1 },
    { k: 'fault', f: 'slow', h: 1, ops: 3 },
    { k: 'retry' },
  ], '6-hang');
  // …и два входа героя, стоявшие в очереди за медленной прощальной записью, исполняются ОДНОЙ операцией: первый (он ушёл из боя — тело
  // в бою, бегство) бросает забег 64L страховкой — штраф — и входит к пати в подземелье (новая жизнь, её забег), второй выселяет его оттуда
  // и бросает уже её забег — свой штраф. Два штрафа за операцию — не второй за ту же жизнь: между ними он ожил. Сжато фаззером (сид 7110359).
  fixedRoot('R15-02 (модель): два входа из очереди — два брошенных забега, между штрафами герой ожил', 7110359, [
    { k: 'join', h: 4, mode: 'code', r: 0.5506606632843614, reuse: true },
    { k: 'descend', h: 4, r: 0.14832453336566687, others: 'yes', near: false, pause: true },
    { k: 'join', h: 3, mode: 'fresh', r: 0.6234184748027474, reuse: false },
    { k: 'join', h: 2, mode: 'code', r: 0.3615473983809352, reuse: false },
    { k: 'join', h: 1, mode: 'friend', r: 0.8639726364053786, reuse: true },
    { k: 'descend', h: 1, r: 0.2712139480281621, others: 'yes', near: false, pause: true, diff: 1 },
    { k: 'dropLeave', h: 2, r: 0.433450595010072, fight: true },
    { k: 'join', h: 2, mode: 'friend', r: 0.9343133282382041, reuse: false },
    { k: 'join', h: 2, mode: 'code', r: 0.2888940724078566, reuse: true },
  ], '3-double-penalty');
  // …и запись штрафа «Завершить», ждущая медленную базу: штраф не «не лёг» (медленная база — не сбой), а ляжет — его сток (снятые вещи) и
  // «жизнь с чистого листа» (здоровье на выходе после смерти) — с этой операции, а не пропажа и не даровое лечение, когда запись дойдёт.
  // Сжато фаззером (сиды 7121362 и 7120476, свежий диапазон 7 120 001…7 121 608).
  fixedRoot('R15-02 (модель): штраф «Завершить», чья запись ждёт медленную базу, — сток его вещей, а не пропажа', 7121362, [
    { k: 'join', h: 2, mode: 'friend', r: 0.6742810225114226, reuse: false },
    { k: 'descend', h: 2, r: 0.7533387125004083, others: 'none', near: true, pause: true },
    { k: 'town', h: 2, others: 'yes', near: false, pause: true },
    { k: 'fault', f: 'slow', h: 2, ops: 2 },
    { k: 'fault', f: 'slow', h: 2, ops: 1 },
    { k: 'leave', h: 2 },
    { k: 'abandon', h: 2, ask: true },
  ], '1-item-lost');
  fixedRoot('R15-02 (модель): …и здоровье вошедшего после такого «Завершить» — с чистого листа, а не даровое лечение', 7120476, [
    { k: 'join', h: 0, mode: 'friend', r: 0.26464441302232444, reuse: false },
    { k: 'descend', h: 0, r: 0.7235442008823156, others: 'yes', near: false, pause: true, diff: 0 },
    { k: 'attack', h: 0, r: 0.49606937705539167, weaken: true },
    { k: 'town', h: 0, others: 'yes', near: true, pause: true },
    { k: 'fault', f: 'slow', h: 0, ops: 1 },
    { k: 'fault', f: 'slow', h: 0, ops: 3 },
    { k: 'abandon', h: 0 },
    { k: 'join', h: 0, mode: 'code', r: 0.6797119043767452, reuse: false },
  ], '4-free-restore');
  // ⭐ R16-09 (модель): погибший (штраф взят, копия ждёт реконнекта `paid`), чей вход по коду в подземелье ЧУЖОЙ пати ждал медленную запись
  // смерти, — в одной операции с его следующим кадром лобби: вход по коду снимает оплаченный забег страховкой без штрафа и сажает его к пати
  // живым (новая жизнь, её забег), а следующий кадр выселяет его оттуда и бросает уже её забег. Проверка «штраф с оплаченной смерти» читала
  // состояние ДО операции («ждёт мёртвым, paid») и не видела оживления внутри неё — ложное `3-double-penalty` (1 из ~200 длинных сидов).
  // Сжато фаззером (сид 94110, 350 оп.): второй кадр — `join{fresh}`; ⭐ R16-01 — теперь отказ (бросок стоил бы штрафа), и «Завершить» —
  // тот же путь со штрафом по праву.
  const R1609: Op[] = [
    { k: 'join', h: 2, mode: 'friend', r: 0.3355903986375779, reuse: true },
    { k: 'descend', h: 2, r: 0.7325139560271055, others: 'yes', near: false, pause: false },
    { k: 'join', h: 4, mode: 'fresh', r: 0.3033936701249331, reuse: true },
    { k: 'join', h: 3, mode: 'friend', r: 0.49803508585318923, reuse: true },
    { k: 'descend', h: 4, r: 0.8253908094484359, others: 'yes', near: false, pause: true, diff: 0 },
    { k: 'fault', f: 'slow', h: 3, ops: 1 },
    { k: 'kill', h: 3, body: false },
    { k: 'join', h: 3, mode: 'code', r: 0.8142494626808912, reuse: true },
  ];
  fixedRoot('R16-09 (модель): погибший, чей вход по коду ждал медленную запись, ожил у чужой пати — её забег бросает `join{fresh}`', 94110,
    [...R1609, { k: 'join', h: 3, mode: 'fresh', r: 0.15576914721168578, reuse: true }], '3-double-penalty');
  fixedRoot('R16-09 (модель): …и «Завершить» — её брошенный забег платный, это не второй штраф за оплаченную смерть', 94110,
    [...R1609, { k: 'abandon', h: 3 }], '3-double-penalty');
  // Зубы R16-09: та же оплаченная смерть без оживления между штрафами — второй штраф с неё (подменён `paidOf`: «смерть не оплачена») по-прежнему
  // `3-double-penalty`. Без подмены — повтор чистый.
  it('самопроверка R16-09: второй штраф с оплаченной смерти без оживления между ними — ловится', async () => {
    const teeth: Op[] = [...R1609.slice(0, 5), { k: 'kill', h: 3, body: false }, { k: 'close', h: 3 }, { k: 'abandon', h: 3 }];
    expect((await replay(94110, teeth)).map((v) => v.inv), 'без подмены — чисто').toEqual([]);
    const roomProto = (await import('./room.js')).Room.prototype as unknown as { paidOf(info: unknown): boolean };
    const paid = vi.spyOn(roomProto, 'paidOf').mockReturnValue(false);
    try {
      expect((await replay(94110, teeth)).map((v) => v.inv)).toContain('3-double-penalty');
    } finally { paid.mockRestore(); }
  });
  // ⭐ R16-04: кадр голосования финала без `finish` (подмена `voteStartFrame` — как до правки): окно напарника звало «спуском», а принятое
  // голосование уводит в город — `9-vote-misleads` (и `9-vote-blind`). Без подмены — повтор чистый. Последовательность сжата фаззером
  // (`DM_FUZZ_SELFTEST=r1604`, сид 25 основного прогона).
  it('самопроверка R16-04: голосование финала, не сказавшее «завершить забег», — ловится', async () => {
    const r1604: Op[] = [
      { k: 'join', h: 1, mode: 'friend', r: 0.6766128141898662, reuse: false },
      { k: 'recruit' },
      { k: 'join', h: 1, mode: 'friend', r: 0.4675508155487478, reuse: false },
      { k: 'join', h: 1, mode: 'friend', r: 0.5284766510594636, reuse: true },
      { k: 'descend', h: 1, r: 0.607806365005672, others: 'yes', near: true, pause: true, diff: 2 },
      { k: 'descend', h: 1, r: 0.3827768163755536, others: 'yes', near: false, pause: true, diff: 1 },
      { k: 'join', h: 0, mode: 'code', r: 0.3337330736685544, reuse: false },
      { k: 'descend', h: 1, r: 0.6221849266439676, others: 'yes', near: false, pause: true },
      { k: 'descend', h: 0, r: 0.03911340679042041, others: 'yes', near: true, pause: true },
      { k: 'descend', h: 0, r: 0.10129569005221128, others: 'yes', near: false, pause: true },
    ];
    expect((await replay(25, r1604)).map((v) => v.inv), 'без подмены — чисто').toEqual([]);
    const roomProto = (await import('./room.js')).Room.prototype as unknown as { voteStartFrame(v: unknown): { finish?: true } };
    const real = roomProto.voteStartFrame;
    const blind = vi.spyOn(roomProto, 'voteStartFrame').mockImplementation(function (this: unknown, v: unknown) {
      const f = real.call(this, v);
      delete f.finish;
      return f;
    });
    try {
      expect((await replay(25, r1604)).map((v) => v.inv)).toContain('9-vote-misleads');
    } finally { blind.mockRestore(); }
  });
  // ⭐ R16-01: клиент Unity входит статусом забега и `join{fresh}` подряд, ответа не читая, — после обрыва посреди подземелья (герой ждёт в
  // грейсе) и со второго устройства, пока первое в подземелье (вход его выселяет — тоже в грейс). Раньше это молча бросало забег со штрафом
  // смерти; теперь — отказ `run`, штрафа нет (забег эпилог бросает «Завершить» — по праву). Самопроверка `DM_FUZZ_SELFTEST=r1601` (вход снова
  // бросает забег за штраф) — `3-unjustified-penalty`.
  const UNITY_DROP: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0.5, others: 'none', near: false, pause: true },
    { k: 'close', h: 0 },
    { k: 'unity', h: 0 },
  ];
  const UNITY_LIVE: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'descend', h: 0, r: 0.5, others: 'none', near: false, pause: true },
    { k: 'unity', h: 0 },
  ];
  fixedRoot('R16-01: Unity после обрыва посреди подземелья — статус и `join{fresh}` подряд не бросают забег за штраф', 7, UNITY_DROP, '3-unjustified-penalty');
  fixedRoot('R16-01: Unity со второго устройства, пока первое в подземелье, — тоже без штрафа', 7, UNITY_LIVE, '3-unjustified-penalty');
  it('самопроверка R16-01: вход, бросающий забег за штраф, — `3-unjustified-penalty`', async () => {
    const roomProto = (await import('./room.js')).Room.prototype as unknown as { insuranceCharges(charId: string): boolean };
    const charges = vi.spyOn(roomProto, 'insuranceCharges').mockReturnValue(false);
    try {
      for (const ops of [UNITY_DROP, UNITY_LIVE]) expect((await replay(7, ops)).map((v) => v.inv)).toContain('3-unjustified-penalty');
    } finally { charges.mockRestore(); }
  });
  // ⭐ R16-07: клич в городе, арена, назад — бафф постарел на время арены, как откаты (раньше возвращался полным, а откат — готовым: лишнее
  // окно баффа за круг). Зубы: `leaveArena` возвращает баффы остатком на вход в арену (как до правки) — `4-buff-outlived`.
  const SHOUT_ARENA: Op[] = [
    { k: 'join', h: 0, mode: 'fresh', r: 0, reuse: false },
    { k: 'shout', h: 0 },
    { k: 'arena', h: 0, others: 'none', pause: true },
    { k: 'step', n: 30 },
    { k: 'town', h: 0, others: 'none', near: false, pause: true },
  ];
  fixedRoot('R16-07: клич в городе, арена и назад — бафф постарел на время арены, как откаты', 7, SHOUT_ARENA, '4-buff-outlived');
  it('самопроверка R16-07: баффы с арены — остатком на вход в неё (как до правки) — `4-buff-outlived`', async () => {
    type Home = { state: { skillBuffs: Record<string, number> } };
    const roomProto = (await import('./room.js')).Room.prototype as unknown as { leaveArena(this: RoomIn): void };
    const orig = roomProto.leaveArena;
    const stale = vi.spyOn(roomProto, 'leaveArena').mockImplementation(function (this: RoomIn) {
      const homes = (this as unknown as { arenaHome: Map<string, Home> }).arenaHome;
      const keep = new Map([...homes].map(([id, h]) => [id, { ...h.state.skillBuffs }]));
      orig.call(this);
      for (const p of Object.values(this.session.world.players)) { const b = keep.get(p.save.charId); if (b) p.skillBuffs = b; }
    });
    try {
      expect((await replay(7, SHOUT_ARENA)).map((v) => v.inv)).toContain('4-buff-outlived');
    } finally { stale.mockRestore(); }
  });

  // ── Перепрогон после правок раунда 16 (сиды 8 100 001…8 101 500), МОДЕЛЬ ФАЗЗЕРА — сервер прав. Подъём своего выброшенного (K3: вещь в сумку —
  // только после записи поднимающего), чья запись ждёт медленную базу (`slow`), а комната тем временем ушла: герой вошёл заново вторым
  // соединением, прежнюю сессию сняли, пустая комната остановлена. `groundGone` числил вещь «поднимаемой» (`carryGone`), но проверка по концу
  // записи видела только живые комнаты и строки базы — ни ушедшей комнаты, ни записи в пути, — и списывала её стоком («земля ушедшего этажа»),
  // а легла запись — вещь в строке героя (`1-sunk-item-back`). Запись в пути (`db.pending`) — её место, как у строки: судьбу решит её конец.
  // Сжато фаззером (сид 8101334).
  fixedRoot('перепрогон R16 (модель): подъём, чья запись ждёт медленную базу, пока комната ушла, — вещь в пути, а не сток', 8101334, [
    { k: 'join', h: 0, mode: 'friend', r: 0.8253485602326691, reuse: false },
    { k: 'drop', h: 0, r: 0.3296015600208193 },
    { k: 'fault', f: 'slow', h: 0, ops: 3 },
    { k: 'pickup', h: 0, r: 0.555076670832932 },
    { k: 'join', h: 0, mode: 'friend', r: 0.3705517721828073, reuse: false },
  ], '1-sunk-item-back');
  // …и «Завершить» по строке базы (`abandonStored`), чья запись ждёт медленную базу: правдой героя, пока менеджер пишет, модель брала последнюю
  // копию, виденную в комнате, — а запись несёт строку базы, которую тем временем сдвинула другая нода (`veteran`: глубина 10). Выходило
  // «глубина откатилась 10 → 1» (`8-progress-regress`), хотя ляжет ровно строка со штрафом. Правда героя в пути — снимок его записи в пути.
  // Сжато фаззером (сид 8110858, 350 оп.; свежий диапазон 8 110 001…8 111 000).
  fixedRoot('перепрогон R16 (модель): «Завершить» по строке, сдвинутой другой нодой, чья запись ждёт медленную базу, — не откат прогресса', 8110858, [
    { k: 'join', h: 3, mode: 'fresh', r: 0.4380869781598449, reuse: true },
    { k: 'descend', h: 3, r: 0.10640690824948251, others: 'none', near: true, pause: true },
    { k: 'town', h: 3, others: 'yes', near: true, pause: true },
    { k: 'dropLeave', h: 3, r: 0.18801432475447655, fight: true },
    { k: 'close', h: 2 },
    { k: 'fault', f: 'slow', h: 3, ops: 1 },
    { k: 'veteran', h: 3, tier: 0, depth: 10 },
    { k: 'abandon', h: 3, ask: true },
  ], '8-progress-regress');
});
