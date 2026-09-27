import { z } from 'zod';
import { randomInt } from 'node:crypto';
import type { GameConn } from './conn.js';
import {
  packInventory, applyDeathPenalty, validateInput, clientFrameSchema, ROOM_CODE_LEN, ROOM_CODE_ALPHABET, mendBrokenUniques,
  foldRunRecords, runRecords, putRunRecords,
  type ConfigRegistry, type ClientFrame, type SaveState, type RunNodeState,
} from '@dm/shared';
import { getSession, getCharacter, putCharacter, getRunLedger } from '../db/db.js';
import { Room, townRng, runLedgerKey, runLedgerSettled, type Farewell } from './room.js';
import { limits, ipBucket } from './rateLimit.js';
import { counters, setGaugeProvider } from './metrics.js';
import { tickScheduler } from './scheduler.js';
import { migrateLegacyWallet } from './accountStash.js';
import { releaseChar, claimForJoin, claimOwner } from '../cluster/registry.js';
import { isDraining } from '../cluster/node.js';

/**
 * Ф4.1: ПЕРВАЯ БУКВА КОДА — это нода, на которой живёт комната. Благодаря ей «зайти к другу
 * по коду» не требует ни одного запроса в реестр: гейтвей смотрит на букву и отправляет
 * клиента к нужному процессу. Дешевле любой таблицы соответствий и не может протухнуть.
 */
function nodeLetter(): string {
  return String.fromCharCode(65 + (nodeIndex() % 26));
}
/** Номер этой ноды из `DM_NODE_ID` (`node-<N>`). */
function nodeIndex(): number {
  return Number(/(\d+)$/.exec(process.env.DM_NODE_ID ?? 'node-0')?.[1] ?? 0);
}
/** ⭐ R5-14: букв в коде комнаты 26 — нода с номером 26 и дальше делила бы букву с нодой номер N−26. */
const MAX_NODE_INDEX = 25;
/**
 * ⭐ R4-18: код комнаты — буква ноды и `ROOM_CODE_LEN − 1` знаков из криптографического источника. Раньше — четыре знака
 * `Math.random`: 1,68 млн кодов на ноду, и скрипт находил чужую пати перебором (а вошедший брал общую добычу и сносил
 * любое голосование «против»).
 */
function newCode(): string {
  let code = nodeLetter();
  while (code.length < ROOM_CODE_LEN) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** Глубина этажа по id узла забега ('start'=0, 'n<depth>_<lane>'). Для подписи модалки без регенерации графа. */
function runDepthOf(nodeId: string): number {
  const m = /^n(\d+)_/.exec(nodeId);
  return m ? Number(m[1]) : 0;
}

/**
 * Управление комнатами. Вход по явному намерению:
 *  • `runStatus` — есть ли незавершённый забег (грейс-комната из подземелья); комнату не создаёт;
 *  • `join { resume }` — вернуться в грейс-комнату (та же точка); без грейса → error 'no-run';
 *  • `join { roomCode }` — к другу по коду; `join { fresh }`/без кода — новая комната (соло/хост).
 * Осознанный вход в НОВУЮ комнату при висящем забеге = бросок забега (штраф смерти) как страховка.
 * Реконнект-грейс возникает ТОЛЬКО при выходе из подземелья (в городе выход = чистый разрыв).
 * Роутит кадры клиента в его комнату; ws → {playerId, room}; пустая комната самоуничтожается.
 */
/**
 * Ф0.8: потолок частоты кадров `input` на соединение. Боевой клиент шлёт ввод из рендер-цикла,
 * то есть 60–144 Гц, а полезны из них только 30: `setInput` просто перезаписывает последний.
 * Приём кадра стоит ~13 мкс, то есть столько же, сколько отправка, — лишние кадры это чистая
 * потеря. Лимит с запасом на джиттер клиента; сверх лимита кадр молча отбрасывается.
 *
 * ⭐ R4-19: потолок — БАКЕТ (`INPUT_BURST` подряд, дальше `INPUT_HZ_LIMIT` в секунду), а не окно секунды часов. Окно
 * пропускало первые 40 кадров и глушило остаток: клиент на 60 Гц (Unity) не слышался треть каждой секунды — отпущенная
 * клавиша и удар применялись ещё ~350 мс, прицел замирал, рывок пропадал. Бакет режет лишнее равномерно: провал между
 * принятыми кадрами — не длиннее двух их периодов.
 */
const INPUT_HZ_LIMIT = 40;
const INPUT_BURST = 3;
/** R4-18: сколько героев в одной комнате (подключённых и ждущих реконнекта) — чужой не набьёт пати под завязку. */
const MAX_PARTY = 4;
/**
 * R3-08: так начинается кадр ввода у всех клиентов (`JSON.stringify({ t: 'input', … })`). По нему кадр платит из
 * своего потолка (`limits.wsInput`) ещё ДО разбора JSON; кадр, чей тип после разбора не `input`, отбрасывается.
 */
const INPUT_PREFIX = '{"t":"input"';
/**
 * ⭐ R6-05: ПОТОЛОК КАДРА ВВОДА, знаков. Честный ввод веба, Unity и стенда — около 200 знаков (с id каста в 64 — меньше
 * 300). Кадр, оплаченный как ввод, разбирается до проверки входа и типа, а ввод дешевле прочих кадров (250/с против 80/с):
 * 64 КБ вложенных скобок под видом ввода стоили ~3 мс главного потока каждый, и один анонимный сокет съедал больше
 * половины цикла ноды. Больше потолка — не ввод: соединение закрывается (4008).
 */
const INPUT_FRAME_MAX = 1024;
/**
 * ⭐ R6-05: СКОБОК `[` и `{` в кадре — не больше. У честного кадра их меньше десятка (ковка — 8, спуск — 3), а цена
 * `JSON.parse` растёт с вложенностью: кадр из сплошных скобок — миллисекунды главного потока. Счёт — до разбора.
 */
const FRAME_BRACKETS_MAX = 64;
/**
 * ⭐ R8-09: ДВОЕТОЧИЙ (а значит, и ключей объектов: у каждого ключа — своё) в кадре — не больше. У честного кадра их меньше
 * шестидесяти: больше всех у ковки — 24 и до 32 строк согласия по сырью (`WIRE_MATERIALS_MAX`). Потолок скобок держал глубину,
 * но не ширину: плоский объект из 2600 ключей влезал в 16 КБ одной скобкой и стоил 0,5–1,2 мс главного потока — разбор в
 * словарь, обход массивов (`overLong`), строгая схема с перечнем лишних ключей в сообщении и чистка сообщения для лога. Счёт — до
 * разбора, тем же проходом, что скобки.
 */
const FRAME_KEYS_MAX = 128;
/**
 * ⭐ R8-09: ПОТОЛОК КАДРА ДО ВХОДА, знаков: честные кадры лобби (вход, статус забега, «Завершить», пинг) — около 200 знаков. До
 * входа кадр 16 КБ никому не нужен, а разбирать его — время ноды без сессии и без лимита команд. Кадры вдогонку `join` (вход ещё
 * в очереди) — под общим потолком, как и прежде.
 */
const LOBBY_FRAME_MAX = 1024;
/**
 * ⭐ R6-09: сколько раз соединение может предъявить сессию, которой нет, — дальше оно закрывается (4008). Поток кадров лобби
 * с чужими токенами стоит сокетов, а не общего бакета адреса, в котором стоят и соседи по NAT.
 */
const LOBBY_AUTH_FAILS_MAX = 3;
/** Имя этой ноды в кластере (Ф4). В одиночном режиме — `node-0`. */
const NODE_ID = process.env.DM_NODE_ID ?? 'node-0';
/**
 * R1-15: сколько вход (и «Завершить», и статус забега) ждёт прощальную запись персонажа. Без потолка зависшая
 * запись (полуоткрытое соединение с базой) навсегда закрывала персонажу вход.
 * ⚠ R2-08: потолок — это НЕ «запись закончилась». Не дождались — вход отвечает «сохраняем, повторите», а не
 * читает сейв ДО неё: иначе опоздавшая запись проигрывала версию новой сессии, и в базе оставалась старая копия
 * (выброшенное соседу по аккаунту — у обоих).
 */
const LEAVE_WAIT_MS = 15_000;
/** Ответ входу, пока прощальная запись героя не легла в базу (R2-08). */
const SAVING_ERROR = { t: 'error', code: 'busy', msg: 'Сохраняем прогресс героя — повторите вход через несколько секунд' } as const;
/** Ответ кадру лобби, обработку которого оборвал сбой (база не ответила), — R3-14. */
const BUSY_ERROR = { t: 'error', code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' } as const;
/** Комнаты с таким кодом нет. */
const NO_ROOM = { t: 'error', code: 'no-room', msg: 'Комната не найдена' } as const;
/** R4-17, R4-18: слишком часто входите по коду (или промахиваетесь кодом). */
const JOIN_RATE = { t: 'error', code: 'rate', msg: 'Слишком часто — подождите немного' } as const;
/** R4-18: пати полна. */
const ROOM_FULL = { t: 'error', code: 'full', msg: 'В комнате нет мест' } as const;
/**
 * R3-12: нода сливается (SIGTERM, `/internal/drain`) — новых сессий и штрафов не заводим: запись сейвов слива уже идёт,
 * а начатое после неё процесс оборвал бы выходом. Клиент повторит вход — гейтвей уведёт его на живую ноду.
 */
const DRAINING_ERROR = { t: 'error', code: 'busy', msg: 'Сервер перезапускается — войдите через несколько секунд' } as const;
/** R5-12: кадров лобби (статус забега, «Завершить», вход) с аккаунта или адреса слишком много. */
const LOBBY_RATE = { t: 'error', code: 'rate', msg: 'Слишком много запросов — подождите немного' } as const;
/** R5-13: нода на потолке игроков — новых комнат не заводит. */
const NODE_FULL = { t: 'error', code: 'busy', msg: 'Сервер заполнен — войдите через несколько минут' } as const;
/**
 * ⭐ R5-13: ПОТОЛОК ЖИВЫХ ИГРОКОВ НОДЫ (0 — без потолка). Очередь на вход держит гейтвей (`DM_MAX_PLAYERS`), но ноду знает
 * любой, кто получил её адрес, — и вход без кода заводил комнату мимо очереди. Супервизор задаёт нодам их долю
 * (`DM_NODE_MAX_PLAYERS`), одиночный процесс — весь `DM_MAX_PLAYERS`. Вход к другу по коду и «Продолжить» — в пределах
 * запаса сверху (`admits`): пати не разрывается на потолке.
 */
const NODE_MAX_PLAYERS = Math.max(0, Number(process.env.DM_NODE_MAX_PLAYERS ?? process.env.DM_MAX_PLAYERS ?? 0) || 0);
/**
 * R3-19: как часто фон пробует дописать копии, которые база не приняла на выходе, и потолок паузы между попытками
 * одного героя (пауза растёт вдвое с каждой неудачей: лежащую базу не долбим каждые пять секунд).
 */
const UNSAVED_RETRY_MS = 5_000;
const UNSAVED_RETRY_MAX_MS = 60_000;

/**
 * ⭐ R1-19: СХЕМА КАДРА ДО ВСЕГО. Раньше кадр только приводился типом (`JSON.parse(raw) as ClientFrame`), и в
 * комнату ехало что угодно: `{t:'descend', runConfig:{modifiers:'x'}}` проходил голосование и падал уже ПОСЛЕ
 * «голосование прошло» — пати видела успех, а спуска не было (и так сколько угодно раз), `roomCode: 123` ронял
 * вход. Команда (`cmd`) проходит здесь «как есть»: её форму проверяет схема комнаты (D11) — и отвечает на
 * кривую «Неверная команда», а не молчанием. `input` и `ping` проверяются раньше, вручную (горячий путь).
 */
const frameGate = z.discriminatedUnion('t', [
  z.object({ t: z.literal('cmd'), command: z.unknown(), id: z.unknown() }),
  ...clientFrameSchema.options.filter((o) => o.shape.t.value !== 'cmd'),
]);
/** Кадры лобби: клиент ждёт на них ответа — кривой получает `error`, а не вечное «Подключение…». */
const LOBBY_FRAMES: ReadonlySet<unknown> = new Set(['join', 'runStatus', 'abandon']);

/**
 * ⭐ R7-04: МАССИВ В КАДРЕ — НЕ ДЛИННЕЕ. Самый длинный честный — модификаторы алтаря (`WIRE_RUN_MODIFIERS_MAX`, 32). Схема
 * (zod) разбирает КАЖДЫЙ элемент массива и на каждый кривой заводит запись об ошибке, даже когда длина уже сверх потолка:
 * плоский массив из тысяч нулей в 16 КБ стоил ~8 мс главного потока за кадр — и не платил ни скобками (`overBracketed`),
 * ни потолком ввода, и до проверки входа. Длина — до схемы.
 */
const FRAME_ARRAY_MAX = 64;

/** ⭐ R7-04: где-то в кадре массив длиннее `FRAME_ARRAY_MAX`. Глубину кадра уже держит `overBracketed`. */
function overLong(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > FRAME_ARRAY_MAX || v.some(overLong);
  if (v && typeof v === 'object') for (const k in v) if (overLong((v as Record<string, unknown>)[k])) return true;
  return false;
}

/**
 * ⭐ R6-05: скобок в кадре больше `FRAME_BRACKETS_MAX` — разбирать его не стоит (см. там). ⭐ R8-09: и двоеточий больше
 * `FRAME_KEYS_MAX` — ключей в нём больше, чем бывает у честного кадра.
 */
function overBracketed(raw: string): boolean {
  let n = 0;
  let keys = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if ((ch === 91 || ch === 123) && ++n > FRAME_BRACKETS_MAX) return true;   // '[' и '{'
    if (ch === 58 && ++keys > FRAME_KEYS_MAX) return true;                    // ':'
  }
  return false;
}

/**
 * Доступ кластера к менеджеру комнат этого процесса (Ф4): сердцебиению нужны имена живых
 * персонажей, чтобы продлить их закрепление за нодой, а сливу — дописать прогресс.
 * Менеджер в процессе один, поэтому ссылку держим здесь, а не тащим её через пять слоёв.
 */
let current: RoomManager | null = null;
export const clusterHooks = {
  /**
   * Персонажи, которых держит эта нода: живые сессии И ждущие реконнекта в грейс-комнатах. R1-08: закрепление
   * протухает через 300 с, а грейс длится час — продлевай только живых, и вход через другую ноду обходил бы
   * штраф брошенного забега (грейс-комната со штрафом осталась бы здесь, а её запись потом отклонила бы версия).
   * R2-08: и тех, чья прощальная запись ещё в полёте или не легла: их правда — здесь, в памяти этой ноды.
   */
  liveCharIds(): string[] { return current ? [...new Set([...current.liveChars(), ...current.graceChars(), ...current.savingChars()])] : []; },
  /** Дописать прогресс всех комнат — для слива ноды. */
  flushAll(): Promise<unknown> { return current ? current.flushAll() : Promise.resolve(); },
  /** R2-05: закрепление этих героев — у чужой ноды: здешние копии проиграли (см. `RoomManager.fenceLost`). */
  fenceLost(charIds: readonly string[]): void { current?.fenceLost(charIds); },
  /** R4-28: сердцебиение продлило закрепления тех, кого нода уже не держит, — снять (см. `RoomManager.releaseIdle`). */
  releaseIdle(charIds: readonly string[]): void { current?.releaseIdle(charIds); },
};

export class RoomManager {
  private rooms = new Map<string, Room>();
  /** Бакет кадров ввода на соединение (R4-19): токены и момент последнего пополнения (монотонные мс). */
  private inputRate = new Map<GameConn, { tokens: number; at: number }>();
  private conns = new Map<GameConn, { pid: string; room: Room }>();
  /** charId → комната, ждущая его реконнекта (заморожена/активна). Реконнект возвращает в ту же точку. */
  private graceByChar = new Map<string, Room>();
  /**
   * Ф0.3: РЕЕСТР ЖИВЫХ СЕССИЙ, `charId → соединение`. Инвариант: у персонажа во всём процессе
   * ровно одна живая сессия. Раньше дедуп был только ВНУТРИ комнаты, поэтому второй `join`
   * без кода просто создавал вторую комнату — обе держали свою копию сейва и писали её раз
   * в 10 секунд (last-writer-wins). Это и есть подтверждённый дюп; PoC — `loadtest/dupe.ts`.
   */
  private live = new Map<string, GameConn>();
  /**
   * ПРОЩАЛЬНЫЕ ЗАПИСИ, `charId → промис`: выход, выселение и «Завершить забег» пишут сейв асинхронно.
   * Вход того же персонажа читает сейв из базы только ПОСЛЕ них — иначе он прочитал бы копию до
   * записи, и та тут же обогнала бы его версию: все записи новой сессии получали бы отказ (прогресс
   * не сохранялся), а после «Завершить» новая сессия стартовала бы ещё без штрафа.
   */
  private leaving = new Map<string, Promise<void>>();
  /** R2-08: прощальные записи, ещё не закончившиеся (без потолка ожидания, в отличие от `leaving`). */
  private inflight = new Map<string, Promise<void>>();
  /**
   * R2-08: КОПИИ, КОТОРЫЕ БАЗА НЕ ПРИНЯЛА (упала, ответ на фиксацию потерян) — `charId → дописать`. Вход, «Завершить»
   * и статус забега сперва дописывают копию и только потом читают сейв из базы: копия и есть правда о герое.
   */
  private unsaved = new Map<string, () => Promise<Farewell>>();
  /** R3-19: фоновая дописка `unsaved` — когда пробовать героя снова и сколько раз подряд не вышло; кого дописывают сейчас. */
  private unsavedBackoff = new Map<string, { at: number; fails: number }>();
  private unsavedRetrying = new Set<string>();
  /** Потолок ожидания прощальной записи (R1-15). Поле, а не константа, — тест ставит короткий. */
  private leaveWaitMs = LEAVE_WAIT_MS;
  /** R5-13: потолок живых игроков ноды (см. `NODE_MAX_PLAYERS`). Поле — тест ставит свой. */
  private nodeMaxPlayers = NODE_MAX_PLAYERS;
  /** ⭐ R5-07: слив начался (`flushAll`) — комнаты заморожены, новых входов и штрафов нет до выхода процесса. */
  private frozen = false;
  /**
   * ⭐ ОЧЕРЕДЬ НА ПЕРСОНАЖА (R1-01, R1-08): вход, «Завершить», статус забега и снятие закрепления после выхода
   * идут строго друг за другом. Кадры одного соединения и так идут по очереди, но у персонажа соединений может
   * быть несколько (вкладки, реконнект): без общей очереди «Завершить» из второй вкладки писал штраф, пока первая
   * ещё играла, а снятие закрепления после выхода обгоняло повторный вход — и герой оставался живым без него.
   */
  private charOps = new Map<string, Promise<void>>();
  /** Ключи соединений для лимитеров частоты (Ф0.5). */
  private connKeys = new WeakMap<GameConn, string>();
  private connSeq = 0;
  /** ⭐ R6-09: сколько раз соединение предъявило сессию, которой нет (`authOwner`, `lobbyIpOk`). */
  private authFails = new WeakMap<GameConn, number>();
  /** ⭐ R7-04: сколько кадров входа соединения стоит в его очереди (кадры игры без входа до схемы не доходят, см. `onMessage`). */
  private joinsQueued = new WeakMap<GameConn, number>();

  /** Имена персонажей с живой сессией — для продления закрепления в реестре (Ф4). */
  liveChars(): IterableIterator<string> { return this.live.keys(); }
  /** Имена персонажей, чью грейс-комнату держит эта нода — их закрепление тоже продлевается (R1-08). */
  graceChars(): IterableIterator<string> { return this.graceByChar.keys(); }
  /** Персонажи, чья прощальная запись в полёте или не легла (R2-08): закрепление держится, пока их правда здесь. */
  savingChars(): string[] { return [...this.inflight.keys(), ...this.unsaved.keys()]; }

  constructor(private cfg: ConfigRegistry) {
    // ⭐ R5-14: нода с номером больше 25 выдавала бы коды с буквой чужой ноды — вход к другу вёл бы не туда. Падаем громко.
    if (nodeIndex() > MAX_NODE_INDEX) {
      throw new Error(`DM_NODE_ID=${process.env.DM_NODE_ID}: номер ноды не больше ${MAX_NODE_INDEX} — первая буква кода комнаты называет ноду (A–Z)`);
    }
    current = this;
    // Ф1.7: показатели считаются в момент запроса метрик — состав комнат знает только менеджер.
    setGaugeProvider(() => {
      let players = 0;
      for (const room of this.rooms.values()) players += room.size;
      return { rooms: this.rooms.size, ticking: tickScheduler.size, players, connections: this.conns.size };
    });
    // R3-19: недописанные копии дописывает фон — процесс из-за таймера не задерживается.
    setInterval(() => { void this.retryUnsaved(); }, UNSAVED_RETRY_MS).unref();
  }

  /**
   * Сброс прогресса всех комнат в БД — для graceful shutdown (рестарт/остановка сервера).
   * R1-18: и прощальные записи тех, кто УЖЕ вышел (выход, «Завершить», штраф истёкшего грейса): их комнаты
   * могли и закрыться, а выход процесса посреди транзакции — это её откат и потерянный прогресс или штраф.
   * Всё под общим предохранителем слива (8 с).
   */
  flushAll(): Promise<unknown> {
    // ⭐ R5-07: СПЕРВА ЗАМОРОЗИТЬ, ПОТОМ ПИСАТЬ. Слив был снимком: сейвы дописаны, а комнаты тикали и исполняли команды
    // дальше — вещь, переданная соседу по аккаунту после записи слива, но до выхода процесса, оставалась у обоих.
    this.frozen = true;
    for (const room of this.rooms.values()) room.freeze();
    // R2-08: и копии, которые база не приняла, — последняя попытка перед выходом процесса (R6-06: кроме героев чужой ноды).
    const retries = [...this.unsaved.keys()].map((id) => this.settleOwned(id));
    return Promise.all([...[...this.rooms.values()].map((room) => room.flush()), ...this.leaving.values(), ...retries]);
  }

  /**
   * Ф2: ОЧЕРЕДЬ КАДРОВ НА СОЕДИНЕНИЕ. Обработка кадра стала асинхронной (доступ к базе), а
   * значит два кадра одного игрока могли бы выполняться внахлёст: второй `join` начал бы
   * работу, пока первый ещё читает сейв, и оба записали бы игрока в разные комнаты. Кадры
   * одного соединения идут строго друг за другом.
   *
   * Мимо очереди пропущены `ping` и `input` — они не ходят в базу, зато идут десятками в
   * секунду: ставить их в очередь значило бы добавлять задержку самому горячему пути.
   */
  handleConnection(ws: GameConn): void {
    let chain: Promise<void> = Promise.resolve();
    ws.onMessage((raw) => {
      // ⭐ R2-01: НИ ОДИН КАДР НЕ БРОСАЕТ ИЗ ОБРАБОТЧИКА. Бросок здесь — это исключение внутри события сокета, то есть
      // выход процесса со всеми комнатами. Кадр `{"t":"ping","id":[[[…6000 уровней…]]]}` (12 КБ, без входа) так и
      // ронял ноду: `JSON.parse` вложенность держит, а `JSON.stringify` понга — нет. Любой такой бросок гасит кадр.
      try {
        this.onMessage(ws, raw, (clean) => {
          // R7-04: вход в очереди — кадры игры, пришедшие за ним, ждут его, а не отбрасываются до схемы (см. `onMessage`).
          const join = clean.t === 'join';
          if (join) this.joinsQueued.set(ws, (this.joinsQueued.get(ws) ?? 0) + 1);
          chain = chain.then(() => this.onFrame(ws, clean)).catch((e: unknown) => {
            // ⭐ R3-14: сбой ПОСЛЕ схемы (база не ответила на сессию, персонажа, закрепление) — лог через общий глушитель,
            // а не стеком на каждый кадр: поток кадров лобби без входа раньше топил лог и не получал ответа вовсе.
            // Кадр лобби ждёт ответа — «занято», а не вечное «Подключение…».
            counters.frameErrors++;
            this.warnFrame(e);
            if (LOBBY_FRAMES.has(clean.t)) {
              try { ws.send(JSON.stringify(BUSY_ERROR)); } catch { /* сокет уже закрыт */ }
            }
          }).finally(() => {
            if (!join) return;
            const n = (this.joinsQueued.get(ws) ?? 1) - 1;
            if (n > 0) this.joinsQueued.set(ws, n); else this.joinsQueued.delete(ws);
          });
        });
      } catch (e) {
        counters.frameErrors++;
        this.warnFrame(e);
      }
    });
    // Закрытие тоже ловим: отказ здесь без обработчика стал бы необработанным отказом промиса,
    // а он по умолчанию роняет процесс со всеми комнатами.
    ws.onClose(() => {
      chain = chain.then(() => { this.onClose(ws); }).catch((e: unknown) => {
        console.error('[room] отказ при закрытии соединения:', e);
      }).finally(() => { this.forgetConn(ws); });
    });
  }

  /**
   * ⭐ R9-11: СОЕДИНЕНИЕ ЗАКРЫТО — ЕГО БАКЕТЫ ЧАСТОТЫ СНИМАЮТСЯ. Ключ соединения (`connKey`) одноразовый: новый сокет — новый
   * ключ, закрытый больше не придёт. А бакеты под ним (потолок кадров и ввода, кадры лобби, промахи кода `conn:`) жили до
   * подметания — десять минут простоя: поток анонимных «открыл — кадр — закрыл» копил их (≈290 Б на соединение в каждой карте),
   * и раз в минуту главный поток обходил их все. Сбросить бакет ЗАКРЫТОГО соединения — не подарок: ключ больше не предъявит
   * никто. Зовётся только настоящим закрытием и в конце очереди кадров: кадры, стоявшие в ней, бакеты ещё трогают (выход кадром
   * `leave` и отказ по лимиту — не здесь: сокет ещё открыт, и его кадры платят свой потолок дальше).
   */
  private forgetConn(ws: GameConn): void {
    const k = this.connKeys.get(ws);
    this.inputRate.delete(ws);
    if (!k) return;
    limits.wsFrames.reset(k);
    limits.wsInput.reset(k);
    limits.lobbyConn.reset(k);
    limits.roomCodeMiss.reset(`conn:${k}`);
    // Адреса нет — «сеть адреса» соединения и есть его ключ (`netOf`): такие бакеты тоже одноразовые.
    if (!ws.ip) { limits.lobbyIp.reset(`ip:${k}`); limits.roomCodeMissIp.reset(`ip:${k}`); }
  }

  /** Лог кадров, погашенных исключением, — не чаще раза в 10 с (R2-01): поток таких кадров не топит лог. */
  private frameWarnAt = 0;
  private frameWarnMuted = 0;
  private warnFrame(e: unknown): void {
    const now = Date.now();
    if (now - this.frameWarnAt < 10_000) { this.frameWarnMuted++; return; }
    const muted = this.frameWarnMuted ? ` (и ещё ${this.frameWarnMuted} с прошлого сообщения)` : '';
    this.frameWarnAt = now; this.frameWarnMuted = 0;
    console.error(`[room] кадр погашен исключением${muted}:`, e);
  }

  /** Синхронная часть приёма кадра: разбор, пинг, ввод, схема. Кадры, которым нужна база, уходят в `enqueue`. */
  private onMessage(ws: GameConn, raw: string, enqueue: (frame: ClientFrame) => void): void {
    const frame = this.accept(ws, raw);
    if (!frame) return;
    if (frame.t === 'ping') {
      // R2-01: эхом — только целый номер. Чужое значение в `JSON.stringify` — это глубина стека и время процесса.
      const id = (frame as { id?: unknown }).id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) { counters.framesInvalid++; return; }
      ws.send(JSON.stringify({ t: 'pong', id }));
      return;
    }
    if (frame.t === 'input') {
      const conn = this.conns.get(ws);
      if (!conn) return;
      // Горячий путь: не zod, а ручная проверка (десятки наносекунд, без исключений). Без неё
      // `input: {}` или строка вместо числа доезжали до `session.tick` — он бросал на каждом шаге,
      // и комната замирала для всей пати (планировщик ловит исключение, но шаг не делается).
      const input = validateInput((frame as { input?: unknown }).input);
      if (!input) { counters.framesInvalid++; return; }
      // R4-19: кадр с нажатием (рывок, каст, пояс — они уходят только в кадре нажатия) мягкий лимит не глушит: брошенный,
      // он пропал бы совсем. Поток таких кадров держит общий потолок ввода (`limits.wsInput`).
      const press = input.dodge === true || input.cast != null || input.useBelt !== undefined;
      if (!this.allowInput(ws) && !press) return;
      conn.room.setInput(conn.pid, input);
      return;
    }
    // ⭐ R7-04: кадр игры (не лобби) без входа — никому не нужен (`onFrame` его и так отбросит), и схему ради него не зовём. Вход
    // ещё в очереди — ждём его: кадр, посланный вдогонку `join`, исполняется после входа, как и прежде.
    const lobby = LOBBY_FRAMES.has((frame as { t?: unknown }).t);
    if (!lobby && !this.conns.has(ws) && !this.joinsQueued.has(ws)) return;
    // R1-19: остальное — через схему (см. `frameGate`). Кривой кадр — счётчик, и всё: он ничего не сделал.
    // R7-04: массив длиннее честного — кривой ДО схемы (см. `FRAME_ARRAY_MAX`).
    const gated = overLong(frame) ? null : frameGate.safeParse(frame);
    if (!gated?.success) {
      counters.framesInvalid++;
      if (lobby) ws.send(JSON.stringify({ t: 'error', code: 'bad-frame', msg: 'Неверный запрос' }));
      return;
    }
    enqueue(gated.data as ClientFrame);
  }

  /**
   * Общий вход кадра: лимит частоты и разбор. Возвращает кадр либо undefined, если кадр
   * отброшен (и тогда соединение уже могло быть закрыто).
   */
  private accept(ws: GameConn, raw: string): ClientFrame | undefined {
    // Ф0.5: общий потолок кадров на соединение — проверяем ДО разбора JSON, иначе флудер
    // заставляет нас парсить его мусор. Превышение потолка это уже не «высокий FPS»
    // (тот отсекается мягким лимитом ввода), а поведение, которого у клиента быть не должно.
    // ⭐ R3-08: ввод платит из СВОЕГО потолка. Из общего (80/с) он рвал 2D-клиент на мониторе 90+ Гц раньше, чем до
    // мягкого лимита ввода вообще доходило дело.
    counters.framesIn++;
    const asInput = raw.startsWith(INPUT_PREFIX);
    if (!(asInput ? limits.wsInput : limits.wsFrames).take(this.connKey(ws))) {
      counters.rateLimited++;
      ws.close(4008, 'rate limit');
      this.onClose(ws);
      return undefined;
    }
    // ⭐ R6-05: ВВОД — ТОЛЬКО ВОШЕДШЕМУ И ТОЛЬКО МАЛЕНЬКИЙ, И ВСЁ ЭТО ДО РАЗБОРА. Раньше кадр «ввода» разбирался целиком и лишь
    // потом отбрасывался за отсутствием входа. Ввод до входа — не нарушение (честный клиент шлёт его вдогонку `join`), он
    // просто никому не нужен; большой ввод не шлёт никто — соединение закрывается.
    if (asInput) {
      if (!this.conns.has(ws)) return undefined;
      if (raw.length > INPUT_FRAME_MAX) {
        counters.framesInvalid++;
        ws.close(4008, 'bad input');
        this.onClose(ws);
        return undefined;
      }
    }
    if (overBracketed(raw)) { counters.framesInvalid++; return undefined; }   // R6-05: вложенность, R8-09: ширина — до разбора
    // ⭐ R8-09: до входа (и без входа в очереди) — только кадр размера лобби: большой отбрасывается, не разбирая. Молча, как кадр
    // игры без входа (R7-04): честный клиент такого не шлёт, а ответ на каждый стоил бы исходящего трафика.
    if (raw.length > LOBBY_FRAME_MAX && !this.conns.has(ws) && !this.joinsQueued.has(ws)) return undefined;
    let frame: ClientFrame;
    try { frame = JSON.parse(raw) as ClientFrame; } catch { return undefined; }
    // Оплачен как ввод — обязан им быть: JSON берёт последний из повторённых ключей, и `{"t":"input","t":"join",…}`
    // иначе провёл бы кадр лобби (база на каждый) мимо общего потолка.
    if (asInput && frame.t !== 'input') { counters.framesInvalid++; return undefined; }
    return frame;
  }

  /** Кадры, которым нужна база: идут по очереди соединения (см. `handleConnection`). */
  private async onFrame(ws: GameConn, frame: ClientFrame): Promise<void> {

    // Есть ли незавершённый забег? Грейс-комната (из подземелья, ещё жива) ИЛИ сохранённый `save.run`
    // (город-разрыв / истёкший грейс / реконнект). Модалка «Продолжить/Завершить» появляется ВСЕГДА,
    // пока забег не завершён. (После рестарта сервера save.run уже сброшен clearAllRuns → hasRun=false.)
    if (frame.t === 'runStatus') {
      if (!this.lobbyIpOk(ws)) return;
      const userId = await this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      await this.serial(frame.charId, async () => {
        // Комната сама по себе НЕ значит «есть забег»: она живёт и когда игрок просто стоит
        // в городе — в том числе сразу после гибели. Спрашиваем комнату, идёт ли забег на самом деле.
        const graceRoom = this.graceByChar.get(frame.charId);
        const room = graceRoom?.inRun ? graceRoom : undefined;
        // R2-08: копию, которую база не приняла, — дописать до чтения. Не вышло — модалка по базе: это только
        // подсказка, а вход и «Завершить» сами не пойдут дальше без записанной копии. R6-06: копию героя, которого держит
        // чужая нода, — не дописывать (`settleOwned`).
        await this.settleOwned(frame.charId);
        const owned = room ? undefined : await this.ownedSave(userId, frame.charId);
        const run = owned?.save.run;
        const hasRun = !!room || !!run;
        const depth = room?.currentDepth ?? (run ? runDepthOf(run.currentNodeId) : 0);
        ws.send(JSON.stringify({ t: 'runStatus', hasRun, roomCode: room?.code, depth }));
      });
      return;
    }

    // Завершить забег: персонаж гибнет со штрафом. Грейс-комната → её abandonAsDead; иначе (грейс истёк /
    // город-разрыв, но save.run цел) — применяем штраф и чистим `run` прямо в сейве.
    if (frame.t === 'abandon') {
      if (isDraining() || this.frozen) { ws.send(JSON.stringify(DRAINING_ERROR)); return; }
      if (!this.lobbyIpOk(ws)) return;
      const userId = await this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      await this.serial(frame.charId, async () => {
        if (!(await this.claimHere(ws, frame.charId))) return;
        // ⭐ R1-01: ЖИВАЯ СЕССИЯ — СПЕРВА ВЫСЕЛЯЕМ. Раньше штраф читал сейв из базы и писал его поверх, а живая
        // сессия (из другой вкладки или второго соединения того же аккаунта) продолжала играть копией, которую
        // уже нельзя записать: снимала оружие, бросала соседу по пати — и вещь оказывалась у обоих. Выселение
        // пишет её прогресс прощальной записью; из подземелья она уходит в грейс, и штраф ляжет через него.
        await this.evictLive(frame.charId);
        // R2-08: копия на выходе не легла — штраф поверх сейва из базы обошёл бы её (старая копия + штраф).
        if (!(await this.settleFarewell(frame.charId))) { ws.send(JSON.stringify(SAVING_ERROR)); await this.releaseIfIdle(frame.charId); return; }
        // R5-07: слив начался, пока «Завершить» ждал базу, — штрафа после записи слива не пишем.
        if (this.frozen) { ws.send(JSON.stringify(DRAINING_ERROR)); return; }
        const graceRoom = this.graceByChar.get(frame.charId);
        // Ждём запись штрафа: ответ «abandoned» обязан означать, что штраф уже в базе. Запись — прощальная
        // (`track`): вход того же героя из другого соединения читает сейв только ПОСЛЕ неё.
        // ⭐ R4-15: и правда в базе — не «завершено» при штрафе, который не лёг (база упала, строку обогнали): тогда
        // «сохраняем, повторите», а повтор допишет копию со штрафом (или штраф по строке базы).
        let landed = true;
        const write = (graceRoom ? graceRoom.abandonAsDead(frame.charId) : this.abandonStored(userId, frame.charId))
          .then((f) => { landed = f.saved; return f; }, (e: unknown) => { landed = false; throw e; });
        await this.track(frame.charId, write);
        if (!landed || this.inflight.has(frame.charId) || this.unsaved.has(frame.charId)) {
          ws.send(JSON.stringify(SAVING_ERROR));
          await this.releaseIfIdle(frame.charId);
          return;
        }
        ws.send(JSON.stringify({ t: 'abandoned' }));
        // R2-17: сессии здесь не осталось — закрепление снимаем, а не держим пять минут против входа на другой ноде.
        await this.releaseIfIdle(frame.charId);
      });
      return;
    }

    if (frame.t === 'join') {
      if (this.conns.has(ws)) return;
      if (isDraining() || this.frozen) { ws.send(JSON.stringify(DRAINING_ERROR)); return; }
      if (!this.lobbyIpOk(ws)) return;
      // ⭐ R4-18: промах кода платит лимит, и пока он исчерпан, по коду не входят вовсе (иначе ответ «вошёл» против «лимит»
      // остался бы подсказкой). Исчерпанный лимит соединения или сети адреса — отказ ещё до базы.
      // ⭐ R6-09: сеть адреса — своим, широким потолком (`roomCodeMissIp`): с общим аккаунту потолком один аккаунт с
      // промахом раз в 2 с закрывал вход по коду всем за тем же NAT.
      const ipKey = `ip:${this.netOf(ws)}`;
      const connKey = `conn:${this.connKey(ws)}`;
      if (frame.roomCode && (!limits.roomCodeMissIp.peek(ipKey) || !limits.roomCodeMiss.peek(connKey))) { ws.send(JSON.stringify(JOIN_RATE)); return; }
      // ⭐ R5-25: ЕСТЬ ЛИ КОМНАТА С ТАКИМ КОДОМ — ТОЛЬКО ВОШЕДШЕМУ. Поиск кода шёл до сессии: «no-room» против «auth»/«full»
      // отвечал на вопрос любому, без аккаунта. Теперь сперва сессия (под лимитами лобби, R5-12), и промах платит аккаунт,
      // соединение и сеть адреса (IPv6 — /64, `ipBucket`).
      const userId = await this.authOwner(ws, frame.token, frame.charId);
      if (!userId) return;
      if (frame.roomCode) {
        const userKey = `user:${userId}`;
        if (!limits.roomCodeMissIp.peek(ipKey) || !limits.roomCodeMiss.peek(userKey)) { ws.send(JSON.stringify(JOIN_RATE)); return; }
        const room = this.rooms.get(frame.roomCode.toUpperCase());
        if (!room) {
          limits.roomCodeMissIp.take(ipKey); limits.roomCodeMiss.take(userKey); limits.roomCodeMiss.take(connKey);
          ws.send(JSON.stringify(NO_ROOM));
          return;
        }
        // ⭐ R7-16: своя грейс-комната — возвращение, а не вход: мест оно не спрашивает (как `join`, `home`). Раньше проверка мест
        // шла и ему: пати ушла в город (его место свободно, R6-14), пятый вошёл — и свой код отвечал «нет мест».
        if (this.graceByChar.get(frame.charId) !== room && room.seatsTaken(frame.charId) >= MAX_PARTY) { ws.send(JSON.stringify(ROOM_FULL)); return; }
      }
      await this.serial(frame.charId, async () => {
        await this.join(ws, userId, frame);
        // R2-17: вход сорвался после закрепления (нет комнаты, нет забега, лимит…) — не держим закрепление без сессии.
        await this.releaseIfIdle(frame.charId);
      });
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    switch (frame.t) {
      // D11: форму команды и номера проверяет сама комната (схемой, до исполнения) — сюда кадр
      // приходит лишь разобранным JSON, и `command`/`id` в нём могут быть чем угодно.
      case 'cmd': await conn.room.handleCmd(conn.pid, (frame as { command?: unknown }).command, (frame as { id?: unknown }).id); break;
      case 'descend': conn.room.descend(conn.pid, frame.difficultyId, frame.targetNodeId, frame.runConfig); break;
      case 'arena': conn.room.enterArena(conn.pid); break;
      case 'return': conn.room.returnTown(conn.pid); break;
      case 'lever': conn.room.pullLever(conn.pid, frame.leverId); break;
      case 'chest': conn.room.openChest(conn.pid, frame.chestId); break;
      case 'vote': conn.room.castVote(conn.pid, frame.accept); break;
      case 'leave': this.onClose(ws); break;
    }
  }

  /** Вход персонажа — внутри очереди персонажа (`serial`). */
  private async join(ws: GameConn, userId: string, frame: Extract<ClientFrame, { t: 'join' }>): Promise<void> {
    const code = frame.roomCode ? frame.roomCode.toUpperCase() : undefined;
    const fresh = !code && !frame.resume;
    // ⭐ R4-17: вход в СУЩЕСТВУЮЩУЮ комнату (по коду, «Продолжить») — под лимитом аккаунта. Раньше платило только
    // создание комнаты, и круг «выйти — войти по коду» шёл без предела: каждый — прощальная запись сейва в базу.
    if (!fresh && !limits.roomJoin.take(userId)) { ws.send(JSON.stringify(JOIN_RATE)); return; }
    // Ф0.5: каждая новая комната — это свой тик в планировщике. Без лимита тысяча join'ов кладёт процесс. Ключ —
    // пользователь: он уже проверен на владение персонажем. ⭐ R5-12: лимит — ДО работы: отказанный им вход раньше уже
    // закрепил героя, выселил его живую сессию (с прощальной записью) и прочитал сейв.
    if (fresh && !limits.roomCreate.take(userId)) {
      ws.send(JSON.stringify({ t: 'error', code: 'rate', msg: 'Слишком часто создаёте комнаты' }));
      return;
    }
    if (!this.admits(frame.charId, fresh)) { ws.send(JSON.stringify(NODE_FULL)); return; }   // R5-13
    if (!(await this.claimHere(ws, frame.charId))) return;
    // Ф0.3: этот персонаж уже где-то играет — выселяем старую сессию ДО чтения сейва из БД,
    // чтобы новая прочитала уже зафиксированный прогресс, а не обогнала его.
    await this.evictLive(frame.charId);
    // ⭐ R2-08: прощальная запись не легла (упала, висит дольше потолка) — НЕ входим со старой копией из базы.
    if (!(await this.settleFarewell(frame.charId))) { ws.send(JSON.stringify(SAVING_ERROR)); return; }
    if (this.frozen) { ws.send(JSON.stringify(DRAINING_ERROR)); return; }   // R5-07: слив начался, пока вход ждал базу

    // Продолжить забег: грейс-комната → возврат в ту же точку; иначе (грейс истёк / город-разрыв,
    // но save.run цел) → пересобираем забег в НОВОЙ комнате из save.run.config (тот же узел).
    // ⭐ R4-06: вход по коду СВОЕЙ грейс-комнаты — тоже возвращение, а не новый вход: раньше он шёл через «бросок забега»
    // (у погибшего в коопе — без штрафа, со снятием забега) и новую сущность — погибший вставал живым.
    // ⭐ R5-27: комната по коду могла исчезнуть, пока вход ждал базу (проверка в `onFrame` — до ожиданий): тогда «Комната
    // не найдена», а не `undefined === undefined` — «Продолжить» своего забега вместо входа к другу.
    const target = code ? this.rooms.get(code) : undefined;
    if (code && !target) { ws.send(JSON.stringify(NO_ROOM)); return; }
    const graceBefore = this.graceByChar.get(frame.charId);
    const home = !!target && graceBefore === target;
    if (frame.resume || home) {
      const owned = await this.ownedSave(userId, frame.charId);
      if (!owned) { ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return; }
      const { save, version } = await migrateLegacyWallet(userId, owned.save, owned.version, this.cfg);   // R1-06
      await this.foldRunLedger(save);   // R9-01: что взято на узлах забега без него — из свода в базе
      if (this.farewellMoved(frame.charId, graceBefore)) { ws.send(JSON.stringify(SAVING_ERROR)); return; }   // R5-10
      if (this.frozen) { ws.send(JSON.stringify(DRAINING_ERROR)); return; }   // R5-07: слив начался, пока вход ждал базу
      const graceRoom = this.graceByChar.get(frame.charId);
      if (graceRoom) {
        const pid = graceRoom.reconnect(ws, userId, save, version);
        this.conns.set(ws, { pid, room: graceRoom });
        this.live.set(save.charId, ws);
        return;
      }
      if (save.run) {
        const room = this.createRoom();
        const pid = room.addPlayerResumeRun(ws, userId, save, version);
        this.conns.set(ws, { pid, room });
        this.live.set(save.charId, ws);
        return;
      }
      ws.send(JSON.stringify({ t: 'error', code: 'no-run', msg: 'Забег не найден' }));
      return;
    }

    // Осознанный вход в НОВУЮ комнату (соло/хост/по коду): висел незавершённый забег — считаем
    // его брошенным (штраф) ДО чтения сейва, чтобы новый вход взял уже урезанный сейв из БД.
    const graceRoom = this.graceByChar.get(frame.charId);
    if (graceRoom) {
      // R7-03: страховка — забег, который пати уже увела в город, она отпускает без штрафа (`abandonAsDead`, `insurance`).
      await this.track(frame.charId, graceRoom.abandonAsDead(frame.charId, true));
      // R2-08: штраф не лёг — вход по сейву из базы начал бы новую комнату с тем же забегом и без штрафа.
      if (!(await this.settleFarewell(frame.charId))) { ws.send(JSON.stringify(SAVING_ERROR)); return; }
    }
    const graceNow = this.graceByChar.get(frame.charId);
    const owned = await this.ownedSave(userId, frame.charId);
    if (!owned) { ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return; }
    // ⚠ R1-06: переезд старого кошелька — ДО входа в комнату, пока сейв ещё ничей (см. `migrateLegacyWallet`).
    const { save, version } = await migrateLegacyWallet(userId, owned.save, owned.version, this.cfg);
    await this.foldRunLedger(save);   // R9-01: припаркованный забег — с тем, что взято на его узлах без героя
    if (this.farewellMoved(frame.charId, graceNow)) { ws.send(JSON.stringify(SAVING_ERROR)); return; }   // R5-10
    if (this.frozen) { ws.send(JSON.stringify(DRAINING_ERROR)); return; }   // R5-07: слив начался, пока вход ждал базу
    let room: Room;
    if (code) {
      const existing = this.rooms.get(code);
      if (!existing) { ws.send(JSON.stringify(NO_ROOM)); return; }
      // R4-18: мест могло не стать, пока вход ждал базу — проверка перед самым входом.
      if (existing.seatsTaken(frame.charId) >= MAX_PARTY) { ws.send(JSON.stringify(ROOM_FULL)); return; }
      room = existing;
    } else {
      room = this.createRoom();
    }
    const pid = room.addPlayer(ws, userId, save, version);
    this.conns.set(ws, { pid, room });
    this.live.set(save.charId, ws);
  }

  /**
   * ⭐ R9-01: ЗАБЕГ ГЕРОЯ — СО ВСЕМ, ЧТО ВЗЯТО НА ЕГО УЗЛАХ, ГДЕ БЫ ЭТО НИ ВЗЯЛИ. Записи узлов жили только в сейвах участников, и
   * копия, выброшенная одним (финал, «Завершить», вайп), уносила взятое на узлах, куда другой не доходил: «якорь» (второй герой
   * пати, альт, друг) выходил из города на глубине d, напарник один проходил d+1…финал и бросал копию, — а «Продолжить» якоря и
   * вход напарника по коду давали те же узлы свежими: сундуки, боссы, опыт, глубина сложности — по кругу, пока жива старая
   * копия. Теперь каждый вход сейва с забегом вливает в него свод этого забега из базы (`run_ledger`, пишут комнаты,
   * `Room.flushLedger`), ДО комнаты: продолжение, вход по коду и возврат собирают такие узлы взятыми (и как «не новые» — ни
   * глубины, ни квестов этажа, R8-02, R3-10). Записи, которые этот процесс ещё несёт в базу, вход дожидается
   * (`runLedgerSettled`). База не ответила — вход отказывает «занято» (кадр лобби ждёт ответа), а не входит со старой копией.
   */
  private async foldRunLedger(save: SaveState): Promise<void> {
    const run = save.run;
    if (!run?.config) return;
    const key = runLedgerKey(run.config);
    await runLedgerSettled(key);
    const stored = await getRunLedger(key);
    if (!stored.length) return;
    const all = new Map<string, RunNodeState>();
    foldRunRecords(all, runRecords(run, run.config));
    if (foldRunRecords(all, stored)) putRunRecords(run, all.values());
  }

  /**
   * ⭐ R5-10: ПОКА ВХОД ЧИТАЛ СЕЙВ, КОМНАТА НАЧАЛА ПРОЩАНИЕ С ЭТИМ ЖЕ ГЕРОЕМ — истёк грейс, пати ушла в город или финалом,
   * вайп (штраф или снятие забега; `onFarewell` — мимо очереди героя). Вход проверял прощальные записи только ДО чтения и
   * собирал сессию из копии до штрафа: забег цел, золото цело, а живая сессия держала неоштрафованную копию до автосейва.
   * `graceBefore` — грейс-комната героя до чтения. Сдвинулось — «сохраняем, повторите»: повтор дождётся записи
   * (`settleFarewell`) и прочитает правду.
   */
  private farewellMoved(charId: string, graceBefore: Room | undefined): boolean {
    return this.inflight.has(charId) || this.unsaved.has(charId) || this.graceByChar.get(charId) !== graceBefore;
  }

  /**
   * ⭐ R5-13: пускает ли нода ещё одного героя. Новый вход без кода — до потолка; вход к другу по коду и «Продолжить» — с
   * запасом сверху (пати на потолке не разрывается). Свой же герой (вторая вкладка) — на своё место, не в счёт.
   */
  private admits(charId: string, fresh: boolean): boolean {
    const cap = this.nodeMaxPlayers;
    if (cap <= 0) return true;
    const others = this.live.size - (this.live.has(charId) ? 1 : 0);
    return others < (fresh ? cap : cap + Math.max(MAX_PARTY, Math.ceil(cap / 4)));
  }

  /** R5-12, R5-25: сеть адреса соединения — ключ лимитов (IPv6 — /64). */
  private netOf(ws: GameConn): string {
    return ws.ip ? ipBucket(ws.ip) : this.connKey(ws);
  }

  /**
   * ⭐ R5-12, R6-09: кадр лобби — под потолками ДО поиска сессии. Отказ шлёт сам.
   *  • соединение — `limits.lobbyConn` (кадры с живой сессией держит он и потолок аккаунта `limits.lobby`);
   *  • сеть адреса (`limits.lobbyIp`) — только соединению, которое уже предъявляло чужую сессию: бакет адреса платят неудачи
   *    (`authOwner`). Раньше его платил каждый кадр, и поток с чужими токенами из-за общего NAT запирал соседей по адресу;
   *  • соединение, закрытое за неудачи (`LOBBY_AUTH_FAILS_MAX`), — молча: кадры в его очереди уже никому не ответят.
   */
  private lobbyIpOk(ws: GameConn): boolean {
    const fails = this.authFails.get(ws) ?? 0;
    if (fails >= LOBBY_AUTH_FAILS_MAX) return false;
    if (limits.lobbyConn.take(this.connKey(ws)) && (fails === 0 || limits.lobbyIp.peek(`ip:${this.netOf(ws)}`))) return true;
    ws.send(JSON.stringify(LOBBY_RATE));
    return false;
  }

  /**
   * «Завершить» без грейс-комнаты (грейс истёк / город-разрыв, но `save.run` цел): штраф и снятие забега прямо
   * в сейве базы. Звать внутри очереди персонажа, после выселения живой сессии (R1-01) и после того, как её
   * прощальная копия легла в базу (R2-08, `settleFarewell`).
   */
  private async abandonStored(userId: string, charId: string): Promise<Farewell> {
    // R4-15: строку обогнали между чтением и записью — ещё раз по свежей; не легло и так — «сохраняем, повторите».
    for (let attempt = 0; attempt < 2; attempt++) {
      const owned = await this.ownedSave(userId, charId);
      if (!owned?.save.run) return { saved: true };
      applyDeathPenalty(owned.save, this.cfg.get('balance').deathPenalty, townRng());   // D10: не по часам
      owned.save.run = undefined;
      if (await putCharacter(charId, userId, owned.save, owned.version) !== null) return { saved: true };
      console.warn(`[room] отклонён устаревший сейв при abandon ${charId}`);
    }
    return { saved: false };
  }

  /**
   * ⭐ R1-08: закрепить персонажа за ЭТОЙ нодой перед входом и «Завершить». Гейтвей закрепляет на маршрутизации,
   * но вход по коду комнаты идёт по букве кода мимо закрепления — и герой, живой на ноде A, заходил ещё и на ноду B
   * к другу: две живые сессии одного персонажа, проигравшая пишет устаревшей копией (дюп через соседа по пати).
   * Чужое живое закрепление — отказ: клиент заново спросит маршрут у гейтвея и попадёт к своей ноде.
   */
  private async claimHere(ws: GameConn, charId: string): Promise<boolean> {
    let owner: string;
    try {
      owner = await claimForJoin(charId, NODE_ID);
    } catch (e) {
      console.error(`[room] закрепление ${charId} за ${NODE_ID} не удалось:`, e);
      ws.send(JSON.stringify({ t: 'error', code: 'busy', msg: 'Сервер занят, попробуйте ещё раз' }));
      return false;
    }
    if (owner === NODE_ID) return true;
    ws.send(JSON.stringify({ t: 'error', code: 'wrong-node', msg: 'Персонаж в игре на другом узле — войдите заново' }));
    return false;
  }

  /** Стабильный ключ соединения для лимитеров: сокет живёт ровно одну сессию. */
  private connKey(ws: GameConn): string {
    let k = this.connKeys.get(ws);
    if (!k) { k = `c${++this.connSeq}`; this.connKeys.set(ws, k); }
    return k;
  }

  /**
   * Выселяет живую сессию персонажа, если она есть: закрывает её соединение и снимает игрока
   * с комнаты (это же персистит его прогресс). Выселяем, а не отказываем новому входу: чаще
   * всего вторая сессия — это реконнект после обрыва, и держать игрока снаружи до таймаута хуже.
   */
  private async evictLive(charId: string): Promise<void> {
    const old = this.live.get(charId);
    if (!old) return;
    this.live.delete(charId);
    counters.sessionsEvicted++;
    const conn = this.conns.get(old);
    let done: Promise<void> = Promise.resolve();
    if (conn) { done = this.track(charId, conn.room.removePlayer(conn.pid)); this.conns.delete(old); }
    this.inputRate.delete(old);
    try { old.close(4001, 'replaced'); } catch { /* уже закрыт */ }
    await done;
  }

  /**
   * Запомнить прощальную запись персонажа, пока она не закончится (см. `leaving`). R1-15: ожидание ограничено
   * `leaveWaitMs` — зависшая запись (база молчит) больше не закрывает персонажу вход навсегда.
   * R2-08: итог записи запоминается — не легла, копия остаётся в `unsaved` до следующей попытки (`settleFarewell`).
   */
  private track(charId: string, write: Promise<Farewell | void>): Promise<void> {
    const raw: Promise<void> = write.then(
      (f) => {
        if (f && !f.saved && f.retry) this.unsaved.set(charId, f.retry);
        else this.unsaved.delete(charId);
      },
      (e: unknown) => { console.error(`[room] прощальная запись ${charId} упала:`, e); },
    ).finally(() => { if (this.inflight.get(charId) === raw) this.inflight.delete(charId); });
    this.inflight.set(charId, raw);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[room] прощальная запись ${charId} не закончилась за ${this.leaveWaitMs} мс — вход ответит «сохраняем» и подождёт её`);
        resolve();
      }, this.leaveWaitMs);
      timer.unref?.();
    });
    const p = Promise.race([raw, cap]).finally(() => clearTimeout(timer));
    this.leaving.set(charId, p);
    void p.then(() => { if (this.leaving.get(charId) === p) this.leaving.delete(charId); });
    return p;
  }

  /**
   * ⭐ R2-08: ПРАВДА О ГЕРОЕ ЛЕГЛА В БАЗУ? Дождаться прощальной записи (с потолком, R1-15) и, если база копию не
   * приняла, дописать её. `false` — не легла (запись ещё в полёте после потолка, база снова отказала): читать сейв
   * из базы НЕЛЬЗЯ — вход отвечает «сохраняем, повторите». Звать внутри очереди персонажа.
   */
  private async settleFarewell(charId: string): Promise<boolean> {
    await this.leaving.get(charId);
    if (this.inflight.has(charId)) return false;
    const retry = this.unsaved.get(charId);
    if (!retry) return true;
    await this.track(charId, retry());
    return !this.inflight.has(charId) && !this.unsaved.has(charId);
  }

  /**
   * ⭐ R6-06: ГЕРОЯ ДЕРЖИТ ЧУЖАЯ НОДА — здешняя копия, которую база не приняла, проиграла: забыть её, не дописывая. Пока база
   * лежала дольше срока живости ноды, героя закрепила другая нода, он играет там, его строка ушла вперёд. Дописка копии
   * получала отказ по версии, и запись «по строке базы» (R4-15) клала штраф брошенного здесь забега на строку живого там
   * героя: золото и вещи за забег, который идёт, снятый забег, а его сессия там — 4009 на ближайшем автосейве. Это обещание
   * R2-05: проигравшая копия забывается без штрафа. `true` — забыта; `false` — закрепление наше (или ничьё: сердцебиение
   * вернёт его этой ноде, и копия — правда о герое); `null` — не выяснили (база молчит), копия ждёт. Звать в очереди героя.
   */
  private async claimLost(charId: string): Promise<boolean | null> {
    let owner: string | null;
    try { owner = await claimOwner(charId); } catch { return null; }
    if (owner === null || owner === NODE_ID) return false;
    this.forgetUnsaved(charId, owner);
    return true;
  }

  /**
   * R6-06: забыть копию героя, которого держит нода `owner` (см. `claimLost`). ⭐ R7-09: это ИНЦИДЕНТ, а не штатный случай.
   * Копия — единственная запись того, что герой успел отдать (выбросил соседу по аккаунту, запись соседа легла): забытая, она
   * оставляет вещь и в строке героя, и у соседа. Штатно закрепление не уходит от ноды, пока её сердцебиение моложе
   * `NODE_DEAD_SEC` (`registry.ts`: база лежала, нода молчала — её героев не забирают); сюда доходит только отказ базы
   * дольше этого срока. Счётчик `dm_farewell_forgotten_total` и строка «ИНЦИДЕНТ» — разбор человеком (дюп найдёт и аудит).
   */
  private forgetUnsaved(charId: string, owner: string): void {
    if (this.unsaved.delete(charId)) {
      counters.farewellForgotten++;
      console.error(`[room] ИНЦИДЕНТ: героя ${charId} держит нода ${owner} — недописанная копия здесь забыта; отданное ею могло остаться у двоих`);
    }
    this.unsavedBackoff.delete(charId);
  }

  /**
   * `settleFarewell` для копии, которую нода не закрепляла сама перед этим (статус забега, слив): копию героя чужой ноды не
   * дописывает (R6-06, `claimLost`). Вход и «Завершить» закрепляют героя (`claimHere`) и зовут `settleFarewell` сами.
   */
  private async settleOwned(charId: string): Promise<boolean> {
    if (this.unsaved.has(charId) && await this.claimLost(charId) !== false) return false;
    return this.settleFarewell(charId);
  }

  /**
   * ⭐ R3-19: ФОН ДОПИСЫВАЕТ КОПИИ, КОТОРЫЕ БАЗА НЕ ПРИНЯЛА. Раньше копия из `unsaved` дописывалась только тогда, когда
   * ЭТОТ герой снова приходил на ЭТУ ноду (вход, «Завершить», статус забега), да на сливе. Не пришёл до падения ноды —
   * копия пропадала, в базе оставался сейв до выхода, а выброшенное соседу по аккаунту (его-то сейв записался)
   * оказывалось у обоих: тот самый дюп, который закрывал R2-08. Заодно сердцебиение держало закрепление такого героя
   * бессрочно. Теперь каждые `UNSAVED_RETRY_MS` — попытка в очереди персонажа (вход и «Завершить» её не обгонят);
   * неудача — пауза вдвое дольше (до минуты), счётчик и строка в логе; удача — закрепление снимается, если героя
   * здесь больше ничто не держит.
   */
  retryUnsaved(now = Date.now()): Promise<void> {
    for (const id of this.unsavedBackoff.keys()) if (!this.unsaved.has(id)) this.unsavedBackoff.delete(id);
    const runs: Promise<void>[] = [];
    for (const charId of this.unsaved.keys()) {
      if (this.live.has(charId) || this.unsavedRetrying.has(charId)) continue;
      const wait = this.unsavedBackoff.get(charId);
      if (wait && now < wait.at) continue;
      this.unsavedRetrying.add(charId);
      runs.push(this.serial(charId, async () => {
        if (!this.unsaved.has(charId) || this.live.has(charId)) return;
        // ⭐ R6-06: героя держит чужая нода — копия проиграла, дописывать её нельзя; не выяснили — как неудача, позже.
        const lost = await this.claimLost(charId);
        if (lost) return;
        if (lost === false && await this.settleFarewell(charId)) {
          this.unsavedBackoff.delete(charId);
          console.log(`[room] копия ${charId}, не принятая базой на выходе, дописана`);
          await this.releaseIfIdle(charId);
          return;
        }
        const fails = (this.unsavedBackoff.get(charId)?.fails ?? 0) + 1;
        this.unsavedBackoff.set(charId, { at: Date.now() + Math.min(UNSAVED_RETRY_MAX_MS, UNSAVED_RETRY_MS * 2 ** fails), fails });
        counters.farewellRetryFailed++;
        console.warn(`[room] копия ${charId} всё ещё не записана (попытка ${fails}) — повторю позже`);
      }).catch((e: unknown) => console.error(`[room] фоновая дописка копии ${charId}:`, e))
        .finally(() => this.unsavedRetrying.delete(charId)));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /**
   * R2-17: сессии героя на этой ноде нет — ни живой, ни в грейсе, ни прощальной записи в полёте или копии,
   * которую база не приняла, — снимаем его закрепление. Звать внутри очереди персонажа.
   */
  private async releaseIfIdle(charId: string): Promise<void> {
    if (this.live.has(charId) || this.graceByChar.has(charId) || this.inflight.has(charId) || this.unsaved.has(charId)) return;
    await releaseChar(charId, NODE_ID).catch(() => undefined);
  }

  /**
   * ⭐ R2-05: ЗАКРЕПЛЕНИЕ ГЕРОЯ — У ЧУЖОЙ НОДЫ (сердцебиение его не продлило). Значит там уже живой герой, а здесь
   * проигравшая копия (нода подвисла дольше срока, и закрепление забрали). Живую сессию снимаем без записи — как
   * устаревшую (4009), ждущего в грейсе забываем без штрафа. В очереди персонажа и перепроверив владельца: за время
   * сердцебиения герой мог вернуться сюда же.
   */
  fenceLost(charIds: readonly string[]): void {
    for (const id of charIds) {
      void this.serial(id, async () => {
        const owner = await claimOwner(id);
        if (owner === null || owner === NODE_ID) return;
        const ws = this.live.get(id);
        const conn = ws ? this.conns.get(ws) : undefined;
        const grace = this.graceByChar.get(id);
        if ((ws && conn) || grace) console.warn(`[room] закрепление ${id} у ноды ${owner} — здешняя копия снята`);
        if (ws && conn) {
          this.live.delete(id);
          this.conns.delete(ws);
          this.inputRate.delete(ws);
          conn.room.fence(id);
        }
        grace?.fence(id);
        // ⭐ R6-06: и копия, которую база не приняла, — тоже проигравшая: забыть, не дописывая. Раньше здесь была ещё попытка,
        // и её отказ по версии клал штраф брошенного здесь забега на строку героя, живого на ноде-владельце (R4-15).
        this.forgetUnsaved(id, owner);
      }).catch((e: unknown) => console.error(`[room] снятие проигравшей копии ${id}:`, e));
    }
  }

  /**
   * ⭐ R4-28: СЕРДЦЕБИЕНИЕ ПРОДЛИЛО ЗАКРЕПЛЕНИЕ ТОГО, КОГО НОДА УЖЕ НЕ ДЕРЖИТ. Продление берёт список героев, а пишет в базу
   * позже; герой, вышедший между ними (прощальная запись, снятие закрепления), получал закрепление обратно — без сессии, и
   * вход по коду на другой ноде ему отказывал до 30 с. Снимаем снова — в очереди героя и заново спросив, не вернулся ли.
   */
  releaseIdle(charIds: readonly string[]): void {
    for (const id of charIds) void this.serial(id, () => this.releaseIfIdle(id)).catch(() => undefined);
  }

  /** Поставить дело в очередь персонажа (см. `charOps`). Отказ прошлого дела очередь не рвёт. */
  private serial(charId: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.charOps.get(charId) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.charOps.set(charId, tail);
    void tail.then(() => { if (this.charOps.get(charId) === tail) this.charOps.delete(charId); });
    return run;
  }

  private onClose(ws: GameConn): void {
    this.inputRate.delete(ws);
    const conn = this.conns.get(ws);
    if (!conn) return;
    let charId: string | undefined;
    for (const [id, sock] of this.live) {
      if (sock !== ws) continue;
      this.live.delete(id);
      charId = id;
      break;
    }
    // Сперва снять игрока: именно `removePlayer` заводит грейс (из подземелья). Раньше проверка
    // грейса шла ДО него и всегда видела «ждать нечего» — закрепление снималось и у того, кого ждут.
    const done = conn.room.removePlayer(conn.pid);
    this.conns.delete(ws);
    if (charId) {
      const id = charId;
      const farewell = this.track(id, done);
      // Ф4: закрепление снимаем ТОЛЬКО если ждать нечего. Если у персонажа осталась
      // грейс-комната, он обязан вернуться на эту же ноду — иначе забег потеряется.
      // ⭐ R1-08: и только ПОСЛЕ прощальной записи, в очереди персонажа, заново спросив, не вернулся ли он.
      // Раньше закрепление снималось сразу: гейтвей мог увести повторный вход на другую ноду, где сейв
      // прочитан ДО прощальной записи (её потом затирала эта нода), — а снятие, опоздавшее к повторному
      // входу сюда же, оставляло живого героя без закрепления, и второй вход уходил на соседнюю ноду.
      // R2-08: прощальная запись не легла — тоже держим: вход обязан вернуться сюда, к копии.
      void this.serial(id, async () => {
        await farewell;
        await this.releaseIfIdle(id);
      }).catch(() => undefined);
    }
  }

  private createRoom(): Room {
    let code = newCode();
    while (this.rooms.has(code)) code = newCode();
    const room = new Room(code, this.cfg, {
      onEmpty: (c) => this.rooms.delete(c),
      onGrace: (charId) => this.graceByChar.set(charId, room),
      onUngrace: (charId) => this.graceByChar.delete(charId),
      // R1-07: штраф истёкшего грейса и вайпа пати — прощальная запись: вход того же героя её дождётся.
      onFarewell: (charId, write) => { void this.track(charId, write); },
    });
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Пропускать ли этот кадр ввода: бакет соединения (R4-19) — `INPUT_BURST` подряд, дальше `INPUT_HZ_LIMIT` в секунду,
   * время монотонное (шаг настенных часов его не сбивает, R3-15). Лишнее отбрасывается РАВНОМЕРНО, а не хвостом секунды.
   * Соединение не рвём: лишняя частота это почти всегда высокий FPS клиента, а не злонамеренность (злонамеренность ловит
   * общий лимит кадров ws, задача Ф0.5).
   */
  private allowInput(ws: GameConn): boolean {
    const now = performance.now();
    let r = this.inputRate.get(ws);
    if (!r) { r = { tokens: INPUT_BURST, at: now }; this.inputRate.set(ws, r); }
    r.tokens = Math.min(INPUT_BURST, r.tokens + (Math.max(0, now - r.at) / 1000) * INPUT_HZ_LIMIT);
    r.at = Math.max(r.at, now);
    if (r.tokens < 1) { counters.inputThrottled++; return false; }
    r.tokens -= 1;
    return true;
  }

  /**
   * Проверка сессии + владения персонажем. Ошибку шлёт сама; возвращает userId или undefined. ⭐ R5-12: кадр лобби платит
   * потолок АККАУНТА (`limits.lobby`) сразу после сессии — до чтения сейва: с N сокетов один аккаунт больше не множит
   * чтения базы.
   */
  private async authOwner(ws: GameConn, token: string, charId: string): Promise<string | undefined> {
    const userId = await getSession(token);
    if (!userId) {
      // ⭐ R6-09: неудача платит бакет сети адреса и считается соединению; третья — соединение закрыто (см. `lobbyIpOk`).
      limits.lobbyIp.take(`ip:${this.netOf(ws)}`);
      const fails = (this.authFails.get(ws) ?? 0) + 1;
      this.authFails.set(ws, fails);
      ws.send(JSON.stringify({ t: 'error', code: 'auth', msg: 'Требуется вход' }));
      if (fails >= LOBBY_AUTH_FAILS_MAX) {
        counters.rateLimited++;
        ws.close(4008, 'auth');
        this.onClose(ws);
      }
      return undefined;
    }
    if (!limits.lobby.take(userId)) { ws.send(JSON.stringify(LOBBY_RATE)); return undefined; }
    const character = await getCharacter(charId);
    if (!character || character.userId !== userId) {
      ws.send(JSON.stringify({ t: 'error', code: 'forbidden', msg: 'Персонаж недоступен' })); return undefined;
    }
    return userId;
  }

  /**
   * Свежий сейв персонажа из БД + его версия (Ф0.3) + лёгкий анти-чит. Версия едет в комнату
   * и предъявляется при каждой записи: устаревшая копия не сможет затереть свежую.
   */
  private async ownedSave(userId: string, charId: string): Promise<{ save: SaveState; version: number } | undefined> {
    const character = await getCharacter(charId);
    if (!character || character.userId !== userId) return undefined;
    return { save: this.sanitize(character.data), version: character.version };
  }

  /**
   * Лёгкий анти-чит поверх сохранённого сейва: уровень — целый и не ниже первого, золото ≥0 (полный объект, без стрипа).
   *
   * ⭐ R9-05: УРОВЕНЬ ИЗ ОПЫТА БОЛЬШЕ НЕ ПЕРЕСЧИТЫВАЕТСЯ ВНИЗ. Это было против сейва, который писал клиент (до Ф0); теперь сейв
   * пишет только сервер, а уровень растёт только в `gainXp` — вместе с очками за каждый уровень. Пересчёт же опускал героя при
   * КАЖДОМ входе после правки баланса: кривая опыта медленнее (`xpTable` — ручка темпа, docs/BALANCE.md) или потолок уровня
   * ниже — и герой 50-го входил 48-м с очками за 50, а добирая опыт до 50-го, получал очки двух уровней второй раз (срезать
   * потолок и вернуть — то же для верхних уровней). Опыт ниже порога своего уровня — просто нет нового уровня, пока опыт не
   * догонит (`gainXp` поднимает только выше текущего).
   */
  private sanitize(save: SaveState): SaveState {
    save.level = Math.max(1, Math.floor(save.level) || 1);
    save.gold = Math.max(0, Math.floor(save.gold));
    // Одноразовое лечение битой/налагающейся раскладки старых сейвов: сохраняет валидные
    // позиции, переставляет только сломанные. Дальше раскладку держит валидной сервер (moveItem).
    packInventory(save.inventory, this.cfg.get('balance').inventory);
    // R7-19: сломанный уник старого сейва — цел (уник кузнец не чинит; сундук аккаунта лечит `sanitizeStash`).
    mendBrokenUniques([...Object.values(save.equipment ?? {}), ...save.inventory, ...(save.belt ?? []), ...(save.stash ?? [])]);
    return save;
  }
}
