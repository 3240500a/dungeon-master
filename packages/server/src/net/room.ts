import { randomUUID, randomInt, randomFillSync, randomBytes, createHash, createHmac } from 'node:crypto';
import type { GameConn } from './conn.js';
import {
  GameSession, spawnPacksEl, floorChallengeLevel, townLayout, arenaLayout, serializeWorld, floorInit, peerInfoOf, SnapshotDelta, worldChecksum, encodeWorldFrame, snapshotToDelta, WIRE_FULL, WIRE_DELTA,
  generateRunPlan, pickRunModifiers, generateFloor, decorSpecsFor, obstaclesFromDecor, resolveMonsterPool, effectiveLevel,
  generateItem, itemFromBaseId, createRng, rngFrom, shapeFoundWeapon, rollTierLevel,
  buyItem, sellItem, forgeUpgrade, forgeReroll, forgeSalvage, forgeRepair, fieldSalvage, depositMaterials, equip, unequip, allocAttr, respec, respecPassives, respecSkills, allocActive, allocPassive, socketInsert, socketClear, moveToBelt, moveInventoryItem, setBinding,
  craftAction, enchantAction, sketchAction, fullJournal, normalizeJournal, normalizeCraftNonces, shopConsumableIds, SHOP_CONSUMABLE_STOCK, shopBuyPrice,
  stashMove, stashDims, stashTabCount,
  ensureMainQuest, generateBoard, acceptQuest, turnInQuest, trackObjective, trackFloor, pruneBoardQuests,
  isDifficultyUnlocked, applyDeathPenalty, parseTownCommand, PRICE_CHANGED,
  noteNodeId, sameRun, runRecords, visitedNode, foldRunRecords, putRunRecords, putRunRecord, mergeNodeState, isDotKind, activeAbilityOf,
  hasLineOfSight, findPath, worldToCell, playerSnapshot, PROTOCOL_VERSION,
  type ConfigRegistry, type PlayerInput, type Item, type SaveState, type SessionEvent,
  type FloorInit, type PeerInfo, type ServerFrame, type TownCommand, type QuestDef,
  type DecorObject, type RunConfig, type RunPlan, type RunNodeState, type AccountStash, type Rng, type CraftJournal,
  type PlayerEntity, type DebuffState, type DebuffKind, type TownStockRef,
} from '@dm/shared';
import { putCharacter, putCharacterWithStash, getCharacter, mergeRunLedger, getRunLedger, landedVersion } from '../db/db.js';
import { LedgerViolation, CommitUnknown, isDataException, isTxRetryable } from '../db/errors.js';
import { tickScheduler, TICK_MS, type Tickable } from './scheduler.js';
import { counters } from './metrics.js';
import { loadAccountStash, type LoadedStash } from './accountStash.js';
import { cmdAllowedIn, CommandDedup } from './guard.js';
import { limits } from './rateLimit.js';
import { SessionTelemetry, tallyForge } from './telemetry.js';
import { craftFullJournalOn, craftFullJournalNotice } from './devFlags.js';
import { upsertPlaySession } from '../db/telemetry.js';

/**
 * D10: СИД ИЗ КРИПТОГРАФИЧЕСКОГО ИСТОЧНИКА. Раньше каждый бросок сервера (перекатка, разбор,
 * прилавок, доска квестов, штраф смерти, сид забега) сеялся `Date.now() & 0xffffff` — это
 * 16,7 секунды по кругу, то есть сид угадывается по часам с точностью до миллисекунды, и бросок
 * можно посчитать заранее: «жать перекатку в ту миллисекунду, где выпадет лучшее». Mulberry32 для
 * самих бросков оставлен (он детерминирован и быстр); непредсказуемым сделан только сид.
 */
function randomSeed(): number { return randomInt(1, 2 ** 31 - 1); }
/** R7-20: дольше `setTimeout` Node не ждёт — срабатывает через 1 мс (`TimeoutOverflowWarning`). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Генератор для ОДНОГО городского броска (D10): свежий непредсказуемый сид на каждый вызов. */
export function townRng(): Rng { return createRng(randomSeed()); }

/**
 * ⭐ R9-02: ПОТОК БРОСКОВ СЕССИИ КОМНАТЫ — КАЖДОЕ ЧИСЛО ИЗ КРИПТОИСТОЧНИКА. Сессия жила на mulberry32 от сида (D10 сделал
 * непредсказуемым только сид), а у него всё состояние — 32 бита, и выход виден клиенту с первого снимка: взгляд каждого
 * монстра заселения — `rng.float(0, 2π)`, дальше урон, криты и дроп в событиях. Изменённый клиент подбирал состояние
 * перебором (секунды на JS) по трём-пяти стоящим монстрам, считал сундук наперёд тем же `GameSession`, что везёт с собой, и
 * «докручивал» его ударами в воздух (удар — ровно один бросок) до уника. Здесь состояния нет: 32 свежих бита на бросок,
 * буфер доливается из `randomFillSync` (килобайт на 256 бросков — копейки на тик). Городские броски — `townRng`: сид на
 * каждое действие, и поток одного действия следующему ничего не говорит.
 */
export function sessionRng(): Rng {
  const buf = new Uint32Array(256);
  let i = buf.length;
  return rngFrom(() => {
    if (i >= buf.length) { randomFillSync(buf); i = 0; }
    return buf[i++]! / 4294967296;
  });
}

/**
 * ⭐ R9-01: КЛЮЧ СВОДА ЗАПИСЕЙ ЗАБЕГА В БАЗЕ (`run_ledger`) — личность забега (`RunConfig.id`, сервер ставит её на старте). У
 * забега без неё (сейв старше R9-01) — отпечаток того, из чего пересобираются граф и этажи (`sameRun`): сид, шаблон, биом, тир,
 * модификаторы.
 */
export function runLedgerKey(cfg: RunConfig): string {
  if (typeof cfg.id === 'string' && cfg.id.length > 0 && cfg.id.length <= 64) return `id:${cfg.id}`;
  const mods = [...(Array.isArray(cfg.modifiers) ? cfg.modifiers : [])].sort().join('\u0001');
  return `seed:${createHash('sha1').update([cfg.seed, cfg.templateId, cfg.biomeId, cfg.tier, mods].join('\u0000')).digest('hex')}`;
}
/**
 * ⭐ R14-10: ПЛАН ЗАБЕГА НА СЕРВЕРЕ — ЭТАЖИ УЗЛОВ ОТ СЕКРЕТА ЗАБЕГА. `generateRunPlan` сеет этаж узла от сида забега (`nodeSeed`), а граф —
 * тем же генератором от него же: 31 бит, которые перебираются по графу, видимому клиенту, за секунды. Этаж решает раскладку, сундуки
 * (число и тир), рычаги, выход и заселение, — и изменённый клиент, зная сид (раньше он приходил готовым: план и сейв), собирал наперёд
 * каждый узел развилки и шёл туда, где сундуки богаче. У забега с ключом этажей (`RunConfig.floorKey`, 128 бит, только у сервера) сид
 * этажа — HMAC ключа и id узла: ни граф, ни свой этаж (его сид подбирается по раскладке) о соседнем не говорят ничего. Забег без ключа
 * (начат раньше) — прежние этажи: продолжение не меняет уже пройденное.
 */
export function runPlanOf(reg: ConfigRegistry, run: RunConfig): RunPlan {
  const plan = generateRunPlan(reg, run);
  const key = run.floorKey;
  if (typeof key === 'string' && key.length >= 16 && key.length <= 128) {
    for (const n of plan.nodes) n.floorSpec = { ...n.floorSpec, seed: (createHmac('sha256', key).update(n.id).digest().readUInt32BE(0) >>> 1) || 1 };
  }
  return plan;
}
/** ⭐ R14-10: план забега для клиента — без сидов забега и этажей: карте забега они не нужны, а по ним этажи собираются наперёд. */
function clientPlan(plan: RunPlan): RunPlan {
  const { seed: _seed, ...rest } = plan;
  const nodes = plan.nodes.map((n) => { const { seed: _s, ...floorSpec } = n.floorSpec; return { ...n, floorSpec }; });
  return { ...rest, nodes } as unknown as RunPlan;
}
/** ⭐ R14-10: сейв для клиента — забег без сида и ключа этажей (`run.config`): их знает только сервер. */
function clientSave(save: SaveState): SaveState {
  const run = save.run;
  if (!run?.config) return save;
  const { seed: _seed, floorKey: _key, ...config } = run.config;
  return { ...save, run: { ...run, config: config as RunConfig } };
}

/** ⭐ R9-01: записи сводов забегов этого процесса, ещё идущие в базу (ключ забега → записи в полёте). */
const ledgerWrites = new Map<string, Set<Promise<void>>>();
/**
 * ⭐ R9-01: дождаться записей свода забега `key`, которые этот процесс уже отправил: вход, читающий свод из базы
 * (`RoomManager`), не должен обогнать запись комнаты, где этот забег только что кончился (финал, вайп, выход).
 */
export function runLedgerSettled(key: string): Promise<void> {
  const inflight = ledgerWrites.get(key);
  return inflight ? Promise.all(inflight).then(() => undefined) : Promise.resolve();
}
/** Лог неудачных записей свода — не чаще раза в 10 с на процесс: лежащая база не топит лог. */
let ledgerWarnAt = 0;
let ledgerWarnMuted = 0;
function warnLedger(e: unknown): void {
  const now = Date.now();
  if (now - ledgerWarnAt < 10_000) { ledgerWarnMuted++; return; }
  const muted = ledgerWarnMuted ? ` (и ещё ${ledgerWarnMuted} с прошлого сообщения)` : '';
  ledgerWarnAt = now; ledgerWarnMuted = 0;
  console.error(`[room] свод записей забега не записан — повтор позже${muted}:`, e);
}
/** ⭐ R9-01: пауза перед повтором неудачной записи свода, мс. */
const LEDGER_RETRY_MS = 5_000;
/**
 * ⭐ C-07: СБОЙ ЗАПИСИ СЕЙВА — В ЛОГ НЕ ЧАЩЕ РАЗА В 10 С НА ПРОЦЕСС (живой сессии и копии ждущего реконнекта), с числом промолчанных; каждый
 * сбой — в счётчике `saveErrors`. Раньше строка со всей ошибкой базы и стеком шла на каждую упавшую запись, а записи при лежащей базе ставит
 * и игрок (выброс вещи — сразу, V-B2-04; в темпе команд города): несколько аккаунтов топили лог именно в тот инцидент, который по нему читают.
 */
let saveWarnAt = 0;
let saveWarnMuted = 0;
function warnSave(text: string, e: unknown): void {
  const now = Date.now();
  if (now - saveWarnAt < 10_000) { saveWarnMuted++; return; }
  const muted = saveWarnMuted ? ` (и ещё ${saveWarnMuted} с прошлого сообщения)` : '';
  saveWarnAt = now; saveWarnMuted = 0;
  console.error(`${text}${muted}:`, e);
}

/** Итог команды города — он же тело кадра `cmdResult` (D3). */
type CmdOutcome = { ok: boolean; reason?: string; uid?: string; unlocked?: string[] };
/**
 * Итог исполнения. `early` — отказ ДО исполнения (не то место, лимит частоты): сейв не трогали, и слать его
 * клиенту незачем (R1-11). Служебное поле — в кадр не уходит.
 */
type RunOutcome = CmdOutcome & { early?: boolean };
/**
 * Итог действия внутри транзакции. `unchanged` — действие заведомо ничего не изменило (повтор ключа
 * ковки): писать в базу нечего. Транзакция всё равно сверяет сейв со снимком и при расхождении пишет.
 */
type TxOutcome = CmdOutcome & { unchanged?: boolean };

/** D12: команды со своим лимитом частоты — каждая стоит броска, генерации и записи в базу (эскиз — чтения и записи сундука). */
const FORGE_RATE_CMDS: ReadonlySet<string> = new Set(['craft', 'forgeEnchant', 'forgeSalvage', 'salvage', 'forgeSketch']);
/**
 * ⭐ R12-13: команды, читающие сундук аккаунта из базы (`withAccount` и открыть сундук), — под потолком чтений сундука на аккаунт
 * (`limits.stashRead`). Новая команда через `withAccount` — сюда же.
 */
const STASH_READ_CMDS: ReadonlySet<string> = new Set([
  'stashOpen', 'stashMove', 'depositMaterials', 'forgeUpgrade', 'forgeRepair', 'forgeSalvage', 'craft', 'forgeEnchant', 'forgeSketch',
]);
/** D13: отказ ковки и зачарования, пока кузнец не открыт (`balance.craft.live`). Разбор работает и так. */
const CRAFT_CLOSED = 'Кузнец ещё не куёт';
/**
 * D1: флаг разработчика — ворота журнала кузнеца открыты для проверок ковки (в базу не пишется ничего:
 * журнал аккаунта остаётся своим). Читается на каждый вызов — стенд переключает его без пересборки.
 * ⚠ В продакшене (`NODE_ENV=production`) флаг игнорируется — решение в `devFlags.ts`.
 */
const craftFullJournal = (): boolean => craftFullJournalOn(process.env);
// Забытый на боевом сервере флаг открыл бы каталог ковки всем — пусть это будет видно в логе с первой секунды
// (в продакшене — что он проигнорирован).
const craftJournalNote = craftFullJournalNotice(process.env);
if (craftJournalNote) console.warn(`[room] ${craftJournalNote}`);
/**
 * Команды, которые сами держат атомарность (`withAccount` / `withSave`): их сейв откатывает
 * транзакция, а общий откат после исключения только затёр бы то, что тик сделал за время ожидания базы.
 * Разбор на месте (`salvage`) здесь больше не живёт (R2-14): он исполняется сразу и откатывается общим снимком.
 */
const TRANSACTED_CMDS: ReadonlySet<string> = new Set([
  'forgeUpgrade', 'forgeRepair', 'forgeReroll', 'forgeSalvage', 'depositMaterials', 'stashMove', 'stashOpen',
  'craft', 'forgeEnchant', 'forgeSketch',
]);
/**
 * Команды, которые меняют МИР рядом с сейвом (земля, сущность игрока). Откат одного сейва после
 * исключения в них дал бы вещь и на земле, и в сумке, — поэтому сейв им не откатываем вовсе.
 */
const WORLD_CMDS: ReadonlySet<string> = new Set(['drop', 'pickup', 'useConsumable']);
/** ⭐ R8-04: команды, после которых надетое может стать сильнее, — после них забег меряет мощь героя (`Room.notePeak`). */
const PEAK_CMDS: ReadonlySet<string> = new Set(['equip', 'forgeUpgrade', 'forgeReroll', 'forgeRepair', 'forgeEnchant']);
/** Как часто шуметь в лог о невалидных (и присланных не из того места) командах одного игрока: флудер не должен топить лог. */
const INVALID_WARN_MS = 10_000;
/**
 * R1-03: пауза между переходами по голосованию (спуск, арена, возврат в город). Честный игрок между ними
 * идёт до выхода или алтаря — секунды; без паузы «арена ↔ город» соло гонялось сорок раз в секунду, и каждый
 * круг — это новый этаж в памяти, рассылка кадров всем и запись сейвов в базу.
 */
const VOTE_COOLDOWN_MS = 1_500;
/**
 * R3-01: как близко к выходу (на финале — к порталу) должен стоять тот, кто зовёт спуск, в пикселях мира — два тайла.
 * Клиент зовёт спуск с 34 (выход) и 44 (портал); остальное — запас на то, что позиция сервера отстаёт от предсказанной
 * клиентом на время пути ввода (подбежал и сразу нажал, рывок). Рычагу и сундуку сервер даёт 56 при радиусах клиента 40 и 48.
 */
const EXIT_REACH_PX = 64;
/**
 * ⭐ R10-01: сколько шагов по сетке (клеток, 4-связно) от героя до точки перехода ещё «рядом». В два тайла влезает не больше
 * четырёх шагов (по два на ось) — запас на обход угла; стена в клетку между героем и выходом лабиринта — это десятки клеток.
 */
const EXIT_REACH_STEPS = 6;
/** Потолок обхода поиска пути к точке перехода: все клетки в `EXIT_REACH_STEPS` шагах (их не больше 85) — поиск не бежит по этажу. */
const EXIT_REACH_SEARCH = 128;
/** Что говорить тому, кто зовёт переход издалека (R3-01, R4-01): кадр `error` с кодом `far`. */
const FAR_EXIT = 'Подойдите к выходу';
const FAR_PORTAL = 'Подойдите к порталу';
/** R5-07: ответ на любое действие в комнате, замороженной сливом процесса. */
const FROZEN = 'Сервер перезапускается — войдите через несколько секунд';
/** ⭐ V-B2-04: подъём выброшенного соседом по аккаунту, чья запись без вещи ещё не легла (`holdThrown`). */
const HELD_DROP = 'Вещь ещё сохраняется у выбросившего — поднимите через мгновение';
/** ⭐ V-B2-04: сколько подъём ждёт запись выбросившего (честная — миллисекунды; дольше — база тонет, и кадры поднявшего за ней не стоят). */
const HELD_WAIT_MS = 3_000;
/** ⭐ C-07: пауза после сбоя записи сессии, в которую выброс вещи записи сразу не ставит (`holdThrown`). */
const DROP_WRITE_BACKOFF_MS = 5_000;
/** R5-19: взять задание с доски, пережившей свой срок, — сперва новая доска. */
const BOARD_RENEWED = 'Доска обновилась — выбери задание заново';
/** R7-18: купить с прилавка, чьё поколение сменилось, — сперва новый прилавок. */
const STOCK_RENEWED = 'Прилавок обновился — выбери вещь заново';
/** ⭐ R8-08: переход, позванный при открытом голосовании (кадр `error`, код `vote`). */
const VOTE_PENDING = 'Уже идёт голосование — ответьте на него';
/** ⭐ R9-01: продолжение из города не дождалось свода забега из базы (кадр `error`, код `busy`). */
const RESUME_FAILED = 'Не удалось продолжить забег — позовите спуск снова';
/** ⭐ R12-11: команда сундука, пока продолжение забега из города ждёт свод из базы (`transact`). */
const RESUMING = 'Пати уходит в забег — повторите через мгновение';
/** ⭐ R9-08: пока голосовали за спуск из города, сменилось, что он начнёт (кадр `error`, код `vote`). */
const VOTE_CHANGED = 'Пати изменилась — спуск начал бы не то, за что голосовали. Позовите заново';
/** R5-04: «за» спуск посреди боя, вдали от выхода (тот же код `far` — клиент показывает текст). */
const FAR_FIGHT = 'Сначала выйдите из боя — или подойдите к выходу';
/** ⭐ R14-02: спуск (завершение финала), позванный пати без живых подключённых (тот же код `far`). */
const DEAD_PARTY = 'Живых в пати нет — дальше идти некому: ждите напарника или уходите в город';
/** Код закрытия сокета, чья сессия потеряла право писать (R1-01): клиент уходит в лобби и входит заново — из базы. */
const WS_STALE = 4009;
/**
 * ⭐ R4-25: отказ голосу за спуск, который переписал бы ЧУЖОЙ припаркованный забег голосующего (кадр `error`, код `run`).
 * Раньше спуск молча ставил всем забег хозяина (или новый) — и «Завершить» со штрафом обходилось входом к другу.
 */
const RUN_CLASH = 'У вас незавершённый забег — продолжите или завершите его';
/** ⭐ V2: продолжение забега, который идёт в другой комнате (кадр `error`, код `run`). */
export function runElsewhereMsg(code: string): string {
  return `Этот забег идёт в комнате ${code} — войдите к пати по коду`;
}
/**
 * ⭐ R4-20: сколько тиков без кадров ввода (≈ треть секунды при 30 Гц) комната ещё применяет последний. Дальше — стоять:
 * скрытая вкладка кадров не шлёт, и раньше герой бежал и бил по последнему вводу, пока игрок не вернётся.
 */
const INPUT_STALE_TICKS = 10;
/** R4-06: сколько героев помнит комната «какими ушли» — карта не растёт от потока входов-выходов. */
const LEFT_MAX = 64;
/**
 * ⭐ R7-02: насколько герой может быть сильнее узла, заселённого раньше без него, чтобы глубина узла шла ему в прогресс
 * сложности. Меньше шага между тирами (5): честный напарник, чуть выросший, счёт получает; основной на узле альта — нет.
 */
const NODE_POWER_SLACK = 3;

/**
 * Итог записи сейва (R2-08, R2-09).
 *  • `ok` — записано;
 *  • `conflict` — база отказала: по версии сейва (сессию уже сняли, `dropStale`) или сундука (не записано НИЧЕГО), либо
 *    данные она не примет никогда — класс 22 (R3-02: сессию сняли, правда — последняя запись в базе);
 *  • `failed` — сбой базы ДО фиксации: не записано наверняка, правда — копия в памяти;
 *  • `unknown` — сбой на самой фиксации, и исход выяснить не удалось: живую сессию сняли (`dropStale`).
 */
type WriteResult = 'ok' | 'conflict' | 'failed' | 'unknown';

/**
 * ⭐ ИТОГ ПРОЩАЛЬНОЙ ЗАПИСИ (R2-08). Не записалась (база упала, ответ на фиксацию потерян) — у менеджера остаётся
 * `retry`: копия сейва на выходе, которую он ДОПИШЕТ, прежде чем читать сейв из базы для нового входа этого героя.
 * Раньше неудачная прощальная запись считалась «законченной»: вход читал сейв ДО неё, а соседу по аккаунту
 * выброшенная вещь уже записалась — вещь оказывалась у обоих. `retry` отвечает тем же `Farewell`.
 */
export interface Farewell { saved: boolean; retry?: () => Promise<Farewell> }
const SAVED: Farewell = { saved: true };

/**
 * ⭐ V3: СНИМКИ ЗАПИСЕЙ С НЕИЗВЕСТНЫМ ИСХОДОМ ФИКСАЦИИ — ВСЕ С ПОСЛЕДНЕЙ ПОДТВЕРЖДЁННОЙ ВЕРСИИ (R14-04: `CommitUnknown.sent`). Раньше помнился
 * один, и каждая следующая такая запись его затирала: запись легла (ответ потерян), за ней — не легла, и снимок легшей пропадал. Отказ по
 * версии уже не мог узнать легшую — копию, её продолжение, выбрасывали как устаревшую: штраф смерти тела в бою (и всё после первой записи)
 * пропадал, а отданное соседу по аккаунту в этом окне оставалось у двоих (R14-04). Все они отправлены с одной ожидаемой версией — лечь могла
 * одна. Одинаковые (повтор той же копии) не множатся; потолок — на базу, отвечающую так часами.
 */
const UNSURE_MAX = 16;
function noteUnsure(list: string[], sent: string | undefined): void {
  if (!sent || list.includes(sent)) return;
  list.push(sent);
  if (list.length > UNSURE_MAX) list.shift();
}
/**
 * ⭐ V3: отказ по версии после записей с неизвестным исходом (`list`, отправлены с версией `version`) — легла ли одна из них: да — её версия,
 * копия пишется поверх неё; нет — `null` (строку сдвинул кто-то другой). Выяснили — список пуст (дальше — другая версия); база молчит — бросок,
 * список цел.
 */
async function landedOf(charId: string, list: string[], version: number): Promise<number | null> {
  for (const sent of list) {
    const v = await landedVersion(charId, sent, version);
    if (v !== null) { list.length = 0; return v; }
  }
  list.length = 0;
  return null;
}

/**
 * Вынуть вещи из сейва и (если передан) сундука — на месте, объекты те же (сессия держит ссылку на сейв).
 * Возвращает, сколько вынуто.
 */
function stripItems(save: SaveState, stash: AccountStash | undefined, ids: ReadonlySet<string>): number {
  let n = 0;
  const keep = (it: Item | null | undefined): boolean => { if (it && ids.has(it.uid)) { n++; return false; } return true; };
  save.inventory = save.inventory.filter(keep);
  save.belt = save.belt.map((it) => (keep(it) ? it : null));
  for (const [slot, it] of Object.entries(save.equipment)) if (!keep(it)) delete save.equipment[slot as keyof typeof save.equipment];
  if (stash) stash.tabs = stash.tabs.map((tab) => tab.filter(keep));
  return n;
}

/** ⭐ V-B2-04: uid всех вещей сейва (надетое, сумка, пояс). */
function saveUids(save: SaveState): string[] {
  const out: string[] = [];
  for (const it of Object.values(save.equipment ?? {})) if (it) out.push(it.uid);
  for (const it of save.inventory ?? []) out.push(it.uid);
  for (const it of save.belt ?? []) if (it) out.push(it.uid);
  return out;
}

/**
 * Витрина и доска квестов героя-хозяина (R1-03). `at` — когда катали. `shop` — только СНАРЯЖЕНИЕ: зелья лавки
 * в сток не входят (R2-04) — бросать в них нечего, и катаются они на каждый заход в город. `level` — уровень хозяина,
 * под который катали снаряжение (R3-17). R5-22: `seed` — сид броска снаряжения, `rolled` — весь бросок по порядку (номер
 * вещи в нём — то, что сейв помнит купленным), `owner` — герой-хозяин (его сейв держит опознание стока).
 */
interface TownStock { at: number; shop: Item[]; board: QuestDef[]; level: number; seed: number; rolled: Item[]; owner: string }
/**
 * ⭐ R5-22: опознание стока из сейва — годное и не протухшее (метка «из будущего» дальше срока — порча, не опознание).
 * Купленное — только номера в пределах броска.
 */
function stockRef(v: SaveState['townStock'], now: number, ttlMs: number): TownStockRef | undefined {
  if (!v || typeof v !== 'object' || !Array.isArray(v.bought)) return undefined;
  if (![v.at, v.seed, v.level].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  if (now - v.at >= ttlMs || v.at - now > ttlMs) return undefined;
  v.bought = v.bought.filter((i) => Number.isInteger(i) && i >= 0 && i < 256).slice(0, 256);
  if (v.board !== undefined && !Number.isSafeInteger(v.board)) delete v.board;   // R9-13: кривой сид доски — из `seed`
  return v;
}

/** ⭐ R9-13: соль сида доски квестов: поток доски не повторяет поток снаряжения того же сида. */
const BOARD_SALT = 0x5bd1e995;
/** ⭐ R9-13: сид доски квестов поколения стока — свой (`board`, после перекатки снаряжения по уровню) или из сида стока. */
function boardSeedOf(ref: TownStockRef): number {
  return ref.board !== undefined ? ref.board : (ref.seed ^ BOARD_SALT) >>> 0;
}

/**
 * ⭐ ВИТРИНА ПРИНАДЛЕЖИТ ГЕРОЮ, А НЕ КОМНАТЕ (R1-03). Раньше прилавок и доска катались заново на КАЖДЫЙ вход
 * в город, а вход в город бесплатен: соло «арена → город» проходит голосованием мгновенно. Ступень на прилавке —
 * бросок (D21), и свободный перебросок делал его «лучшим из N»: t5 выше уровня героя, нужные детали, открытый
 * потолок ступени журнала. Новая комната (вышел — зашёл) — тот же перебросок, только медленнее.
 *
 * Теперь сток держится за героем-хозяином комнаты (первым в ней) и обновляется не чаще `balance.townRestockSec`:
 * ни круги по областям, ни новые комнаты его не перекатывают. Купленное и принятое с доски из стока убирается —
 * повторный вход их не вернёт. ⭐ R5-22: карта — лишь кэш процесса; истина — опознание стока в сейве героя
 * (`save.townStock`: когда, сид, уровень, купленное). Раньше на другой ноде (и после рестарта) снаряжение катилось заново —
 * в кластере «выйти из города и войти на соседнюю ноду» было бесплатным перебросом. ⭐ R9-13: доска квестов — тоже из
 * опознания (свой сид и поколение `at`): любая нода собирает ту же доску; квота шаблона — в сейве (R3-10, R4-33).
 *
 * ⚠ R2-04: ЗЕЛЬЯ ЛАВКИ — НЕ СТОК. Они — одинаковые вещи без броска, «перебросить» в них нечего, а в сток их
 * положили вместе со снаряжением: раскупил пять лечебных — и следующие десять минут, в любой комнате, зелий нет.
 * Лавка расходников катается на КАЖДЫЙ заход в город и в каждой комнате своя (`consumables`).
 */
const townStocks = new Map<string, TownStock>();
let townStocksSweptAt = 0;
/**
 * R5-22: забыть кэш стоков процесса — память станет как у свежего процесса (другая нода, рестарт). Стоки героев от этого не
 * меняются: их опознание — в сейве, и следующий заход в город соберёт ту же витрину заново. Игре не нужна: это шов для
 * тестов «другой ноды» (`room.round5.test.ts`) — перезагрузка модуля комнаты ради пустой карты под нагрузкой полного
 * прогона не укладывалась в потолок теста.
 */
export function forgetTownStocks(): void {
  townStocks.clear();
  townStocksSweptAt = 0;
}
/** Выбросить протухшие стоки — карта не должна расти вечно. Не чаще раза в минуту. */
function sweepTownStocks(now: number, ttlMs: number): void {
  if (now - townStocksSweptAt < 60_000) return;
  townStocksSweptAt = now;
  for (const [k, s] of townStocks) if (now - s.at >= ttlMs) townStocks.delete(k);
}
/**
 * R1-10: чужое значение для строки лога. `String(v)` на объекте из кадра зовёт ЕГО `toString`/`valueOf`, а
 * `{"toString":1}` из JSON делает их не функциями — и `String` бросает. Сюда — только то, что не бросает.
 */
function describeUntrusted(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
  try { return JSON.stringify(v) ?? typeof v; } catch { return typeof v; }
}

/**
 * Вернуть объект к снимку НА МЕСТЕ: сессия держит ссылку на сейв, подменять объект нельзя.
 * Ключи, появившиеся после снимка, удаляются — `Object.assign` их бы оставил.
 */
function restoreInPlace(target: object, snapshot: string): void {
  const src = JSON.parse(snapshot) as Record<string, unknown>;
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!(k in src)) delete t[k];
  Object.assign(t, src);
}

/**
 * ⭐ R8-01: ОТКАТ СЕЙВА ПОСЛЕ КОМАНДЫ — ТОЛЬКО ЕЁ САМОЙ. Сток кузницы (`townStock`) и забег (`run`: указатель и записи узлов) —
 * метаданные комнаты: их не трогает ни одна команда, зато пишут ЧУЖИЕ ходы, которые удержание сейва (R1-05) не держит, —
 * `restock` на покупке соседа или входе в комнату (R7-18), `noteBought`, записи узлов входящего по забегу (`joinRun`). Раньше
 * откат неудачной записи «сейв + сундук» возвращал сейв к снимку целиком — и их тоже: хозяин снова держал протухшее опознание
 * стока, и следующая покупка или вход катали ещё одно поколение (неудачу записи вызывает второй герой аккаунта, D8, — лучшее
 * из N за один срок, N любое); купленное за время удержания возвращалось на прилавок другой ноды; записи взятого на узлах
 * пропадали. Теперь они переживают откат такими, какими их оставила комната.
 */
function rollbackCmd(save: SaveState, snapshot: string): void {
  const { townStock, run } = save;
  restoreInPlace(save, snapshot);
  if (townStock) save.townStock = townStock; else delete save.townStock;
  if (run) save.run = run; else delete save.run;
}

/** Кошелёк сырья сундука; у сундука старого формата поля могло не быть. */
function walletOf(st: AccountStash): Record<string, number> { return (st.materials ??= {}); }

/**
 * Причина записи разбора для журнала вещей (D9): скованную вещь ПЕРЕПЛАВЛЯЮТ (`melt`), остальное
 * разбирают (`salvage`). Метка и только: какой путь выхода взять, решает ядро по самой вещи.
 */
function salvageReason(save: SaveState, uid: string): string {
  return save.inventory.find((i) => i.uid === uid)?.parts ? 'melt' : 'salvage';
}

/** Номер команды из кадра: `undefined` — не прислан, `null` — прислан, но негоден. */
function cmdIdOf(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
/** Имя команды для ответа — даже у невалидной (обрезанное: это эхо чужой строки). */
function cmdNameOf(raw: unknown): string {
  const c = typeof raw === 'object' && raw !== null ? (raw as { cmd?: unknown }).cmd : undefined;
  return typeof c === 'string' ? c.slice(0, 32) : '?';
}

const TICK_DT = TICK_MS / 1000;
/**
 * Ф1.5: частота СНАПШОТОВ развязана с частотой симуляции. Мир считается 30 раз в секунду
 * (иначе меняется физика боя), а состояние рассылается 20 — цена кадра не зависит от его
 * размера, поэтому расход транспорта линеен по числу отправок, и треть из них лишняя:
 * клиент всё равно рисует чужие сущности с интерполяцией в прошлом (INTERP_DELAY 100 мс,
 * то есть два интервала при 20 Гц — запаса хватает).
 *
 * Меняется переменной `DM_SNAPSHOT_HZ` — на случай, если понадобится вернуть 30 Гц без сборки.
 */
const SNAPSHOT_HZ = Math.max(5, Math.min(30, Number(process.env.DM_SNAPSHOT_HZ ?? 20)));
const SNAPSHOT_DT = 1 / SNAPSHOT_HZ;
/** Как часто слать ПОЛНЫЙ кадр вместо дельты — страховка от расхождения (Ф1.3). */
const FULL_SNAPSHOT_MS = 5_000;
/**
 * РАДИУС ОБЛАСТИ ИНТЕРЕСА в игровых пикселях (TILE=32, то есть 1000 ≈ 31 клетка).
 * По умолчанию ВЫКЛЮЧЕН — и это осознанное решение, а не откат Ф1.2.
 *
 * ПОЧЕМУ ВЫКЛЮЧЕН. В Ф1.2 область интереса решала две задачи: резала трафик и закрывала
 * maphack. Первая задача решена другими средствами (дельты + бинарный кадр: 6–9 КБ/с на
 * игрока), а вторая в НАШЕЙ игре не стоит:
 *   • подземелье — инстанс одной пати, все игроки заодно, и миникарта у них общая по замыслу.
 *     Прятать монстров от союзника не от кого: преимущество получают не над другим игроком,
 *     а над самой игрой;
 *   • арена PvP — зал размером примерно в два экрана, карта видна целиком и так;
 *   • город — тоже инстанс пати, посторонних там нет.
 *
 * ЧТО ЭТО ДАЁТ. Если у всех в комнате один и тот же вид мира, то снимок, дельта и бинарный
 * кадр считаются ОДИН РАЗ НА КОМНАТУ, а не по разу на каждого клиента. Замер части 4 показал,
 * что сборка кадра (22,5 мкс) дороже самой симуляции (19,0 мкс) — и вся она умножалась на
 * число игроков.
 *
 * КОГДА ВЕРНУТЬ. Как только появится место, где рядом оказываются НЕ союзники: публичная зона,
 * большая арена со стенами, открытый мир. Тогда `DM_AOI_RADIUS=1000` возвращает персональный
 * вид — механизм цел и покрыт тестами; политику удобнее держать здесь, а не разносить по коду.
 */
const AOI_RADIUS = Math.max(0, Number(process.env.DM_AOI_RADIUS ?? 0));
/** Выход из области шире входа: без гистерезиса сущности на кромке мигали бы каждый кадр. */
const AOI_EXIT_MULT = 1.2;
/** Отладка провода (Ф1.4): дублировать кадр текстом для точной сверки. Только для стенда. */
const WIRE_VERIFY = process.env.DM_WIRE_VERIFY === '1';
const AUTOSAVE_MS = 10_000; // периодический сброс прогресса в БД — рестарт/краш теряет ≤10с
/**
 * Ф3.2: как часто наблюдения о сессии уходят в базу. Реже автосейва: это не прогресс игрока,
 * потерять пять минут наблюдений не страшно. Но и «только при выходе» не годится — бот из игры
 * не выходит, и сигнатура «шестнадцать часов без пауз» не сработала бы никогда.
 */
const TELEMETRY_FLUSH_MS = Number(process.env.DM_TELEMETRY_FLUSH_MS ?? 5 * 60_000);
const ARENA_SIZE = 20;              // круглый PvP-зал ARENA_SIZE×ARENA_SIZE клеток
const ARENA_IMMUNE_MS = 2_000;      // спавн-иммунитет игрока в арене (мс)
const ARENA_RESPAWN_MS = 3_000;     // задержка авто-возрождения после гибели в арене (мс)
/** Возврат в город после вайпа (окно смерти видно ~4 с). */
const WIPE_RETURN_MS = 4_000;
/**
 * ⭐ R12-07: возврат в город пати, где подключены только мёртвые. Дольше вайпа: ушедший живой чаще всего просто перезагружает
 * страницу (загрузка, вход, маршрут, сокет — секунды), и вернувшись в срок, он возврат отменяет — пати остаётся на узле.
 */
const STRAND_RETURN_MS = 15_000;

interface Client {
  /** Получил ли клиент полный кадр (Ф1.3). До этого дельты ему бессмысленны. */
  baselined: boolean;
  /** Базис дельт ЭТОГО клиента (Ф1.2: у каждого свой вид мира, значит и свой базис). */
  delta: SnapshotDelta;
  /** Монстры в его поле зрения: вход в набор = отправка определения (Ф1.2). */
  visible: Set<number>;
  pid: string;
  ws: GameConn;
  input: PlayerInput;
  userId: string;
  /** Версия сейва в БД, которую держит эта сессия (Ф0.3). Растёт после каждой успешной записи. */
  saveVersion: number;
  /** Хвост очереди записей сейва (Ф2): записи одного персонажа идут строго друг за другом. */
  saving: Promise<void>;
  /** Номера уже выполненных команд (Ф2.5) и их итоги (D3) — повтор не выполняется дважды и получает тот же ответ. */
  dedup: CommandDedup<CmdOutcome>;
  /** Когда последний раз шумели в лог о невалидной (или не из того места) команде и сколько промолчали с тех пор (D11, R1-10). */
  invalidWarnAt: number;
  invalidMuted: number;
  /** Наблюдения за игрой этой сессии (Ф3.2). Не влияет на игру, только измеряет. */
  tm: SessionTelemetry;
  /** id строки телеметрии в базе: null, пока сессия ни разу не записывалась. */
  tmRow: string | null;
  /** Когда телеметрию сбрасывали в базу — длинная сессия должна быть видна ДО своего конца. */
  tmFlushedAt: number;
  /** Сессию сняли за устаревший сейв (R1-01, `dropStale`): её действия записывать уже некуда. */
  stale: boolean;
  /**
   * Причины для журнала вещей ПО ВЕЩИ (D9, R2-21): действие метит СВОЮ вещь (скованную, разобранную, перенесённую),
   * и та запись, что её застанет, подпишет её этой причиной; всё прочее в записи — автосейвом. Записанное снимается.
   */
  reasons: Map<string, string>;
  /** Запись сейва (разбор на месте R2-14, выброс V-B2-04) уже стоит в очереди и ещё не началась: следующая её не множит (`writeSoon`). */
  fieldWrite: boolean;
  /** ⭐ C-07: когда запись этой сессии последний раз упала сбоем базы (0 — с тех пор легла): выброс в эту паузу записи сразу не ставит. */
  writeFailedAt: number;
  /** R4-19: последний кадр ввода тик уже видел — нажатия из него стирать можно. */
  inputSeen: boolean;
  /** R4-20: тиков с последнего кадра ввода. */
  inputAge: number;
  /**
   * ⭐ R14-04: снимки записей с НЕИЗВЕСТНЫМ исходом фиксации (`CommitUnknown.sent`), пока копия в памяти — их продолжение. Отказ по версии
   * следующей записи сперва сверяется с ними (`landedOf`): легла одна из них — пишем поверх её версии. ⭐ V3: все с последней подтверждённой
   * версии, а не последний (`noteUnsure`).
   */
  unsure: string[];
}

/** Выбор «алтаря» при старте забега (биом/шаблон/модификаторы) — из кадра `descend` города. */
type AltarConfig = { biomeId?: string; templateId?: string; modifiers?: string[] };

/**
 * ⭐ R9-08: ЧТО НАЧНЁТ СПУСК ИЗ ГОРОДА — это видит окно голосования (`voteStart`), и начнётся ровно это (`checkVote`). `resume` —
 * продолжение припаркованного забега героя `charId` (имя — `name`) с глубины `depth`: тир, шаблон, биом и модификаторы — его
 * забега. Нет `resume` — новый забег: тир проверен зовущему (R7-06), остальное — решённый выбор алтаря (`altarOf`).
 */
interface DescendPlan {
  difficultyId: string; templateId: string; biomeId: string; modifiers: string[];
  resume?: { charId: string; name: string; depth: number };
}
/** R9-08: глубина узла забега по его id (`n<глубина>_<полоса>`, `generateRunPlan`) — без регенерации графа. */
function nodeDepthOf(nodeId: string | undefined): number {
  const m = /^n(\d+)_/.exec(nodeId ?? '');
  return m ? Number(m[1]) : 0;
}
/** R9-08: то же ли начнёт спуск, что показано в окне: всё, что окно называет. */
function planKey(p: DescendPlan): string {
  return JSON.stringify([p.difficultyId, p.templateId, p.biomeId, p.modifiers, p.resume?.charId ?? null, p.resume?.depth ?? null]);
}

/**
 * Инфо об отключённом игроке — чья копия сейва ждёт реконнекта (или штрафа). Где и каким он ушёл — `LeftState` (R4-06).
 * `saving` — хвост его записей: первой в нём стоит прощальная запись при выходе, и `saveVersion`
 * становится верной только после неё (см. `removePlayer`).
 * `paid` (R3-06, R4-16) — ушёл мёртвым (кооп: погиб и ждал следующего этажа): штраф за эту смерть уже взят. Не «мёртв
 * сейчас» — смерть живёт в `LeftState`. ⭐ C-03: снимается сменой этажа вместе с ней (`reviveAway`): пати увела его дальше или в город —
 * он ожил, и следующий штраф (брошенный забег, «Завершить») — уже не второй за ту же смерть.
 * `fled` (R4-14) — ушёл живым посреди боя, не у портала: пати, ушедшая в город, не уносит его из боя даром.
 * `fledDescend` (R8-07) — то же для СПУСКА пати по ветке: ушёл живым посреди боя не у выхода — там, где «за» спуск ему бы не
 * засчитали (`canDescend`). У выхода «за» спуск можно и в бою, а у портала входа — нельзя: правило своё, как у голоса.
 * Обе метки — про узел, с которого ушёл: пати унесла его спуском на новый — они снимаются (R9-07, `enterNode`).
 * `safe` (R7-03) — пати после его ухода вернулась в город: его забег припаркован, как у вышедшего из города, и штрафа за
 * брошенный забег с него больше нет (см. `buryDisconnected`).
 * ⭐ R13-10: `reasons` — причины по вещи (D9, R2-21), которые его сессия ещё не записала (та же карта, что у сессии): их везёт и
 * дописка копии (`persistDisconnected`). Раньше копия писалась без них — разобранное на месте, чья запись упала вместе с прощальной,
 * журнал вещей подписывал автосейвом, и план отката (R2-32) и аудит (R2-21) его не видели.
 */
interface Disconnected {
  save: SaveState; userId: string; saveVersion: number; saving: Promise<void>; paid: boolean; fled: boolean; fledDescend: boolean; safe?: boolean;
  reasons: Map<string, string>;
  /** ⭐ R14-04, V3: снимки записей этой копии с неизвестным исходом фиксации (как `Client.unsure`) — отказ по версии сверяется с ними. */
  unsure: string[];
}

/**
 * ⭐ R4-06: КАКИМ ГЕРОЙ УШЁЛ ИЗ КОМНАТЫ (по charId) — любой вход в неё (реконнект, по коду, выселение второй вкладкой)
 * возвращает его таким, а не свежим. Раньше сущность заводилась заново с полным здоровьем, маной и выносливостью, без
 * дебаффов, стана и откатов: F5 посреди боя лечил целиком, а погибший в коопе оживал входом по коду.
 *
 * Смена этажа делает с записью то же, что с присутствующими (`floorChanged`): мёртвые оживают (запись снимается), точка
 * ухода забывается (R4-16: «тот же этаж» — тот же ЭКЗЕМПЛЯР, а не та же глубина), город снимает дебаффы, арена
 * возрождает всех. Время для ушедшего стоит: дебаффы хранят остаток, а не момент истечения.
 */
interface LeftState {
  /** Точка ухода — только на том же экземпляре этажа. */
  pos?: { x: number; y: number };
  alive: boolean;
  hp: number; mana: number; stamina: number;
  /** Дебаффы с ОСТАТКОМ длительности в `expiresAt` (мс). */
  debuffs: DebuffState;
  stunTimer: number; attackCd: number; dodgeCd: number; combatTimer: number;
  skillCd: Record<string, number>; toggles: string[]; skillBuffs: Record<string, number>;
  /**
   * ⭐ R12-02: метка пулов сейва (`save.vitals.at`) в момент ухода отсюда. Сейв, пришедший со входом, помечен позже — героя с тех пор
   * писала другая комната (он там бился, отдыхал, пил зелья): запись ухода устарела, пулы — из сейва (`freshLeft`).
   */
  savedAt?: number;
}

/**
 * ⭐ R13-03: ТЕЛО ГЕРОЯ, ВЫШЕДШЕГО ПОСРЕДИ БОЯ, — ещё в мире (`Room.lingering`): `pid` — его сущность, `info` — его копия, ждущая
 * реконнекта, `until` — время мира, когда тело уйдёт само (раньше — бой кончился или он погиб). Ввода у тела нет, сейв на удержании:
 * не подбирает и не пьёт зелий (`session.saveHeld`).
 */
interface Linger { pid: string; p: PlayerEntity; info: Disconnected; until: number; sig: string }
/** R13-03: отпечаток сейва без пулов (`vitals` пишет каждый уход) — изменился ли сейв тела за бой (опыт за добитого его ядом и т. п.). */
function saveSig(s: SaveState): string {
  return JSON.stringify({ ...s, vitals: undefined });
}

/**
 * ⭐ R11-04: пулы героя из сейва (`save.vitals`) для свежей сущности `p` (полные пулы) — не выше полных, живой (здоровье ≥ 1). Время
 * вне игры (`v.at`, часы сервера) — реген по статам героя (`regen`), как если бы он стоял в городе: мгновенно пулы не полнятся, а
 * вернувшийся через полчаса (или завтра) — полон, как и простоявший их в игре. Нет записи (старый сейв, погиб) или она битая —
 * ничего: пулы остаются полными.
 */
function savedVitals(
  p: PlayerEntity, v: SaveState['vitals'], regen: { hpRegen: number; manaRegen: number; staminaRegen: number }, now: number,
): Partial<Pick<PlayerEntity, 'hp' | 'mana' | 'stamina'>> {
  if (!v || ![v.hp, v.mana, v.stamina].every(Number.isFinite)) return {};
  const dt = typeof v.at === 'number' && Number.isFinite(v.at) ? Math.max(0, now - v.at) / 1000 : 0;
  return {
    hp: Math.min(p.hp, Math.max(1, v.hp + regen.hpRegen * dt)),
    mana: Math.min(p.mana, Math.max(0, v.mana + regen.manaRegen * dt)),
    stamina: Math.min(p.stamina, Math.max(0, v.stamina + regen.staminaRegen * dt)),
  };
}

/** Хуки комнаты в RoomManager: уничтожение + регистрация/снятие грейс-реконнекта по charId. */
interface RoomHooks {
  onEmpty: (code: string) => void;
  onGrace: (charId: string) => void;
  onUngrace: (charId: string) => void;
  /**
   * R1-07: комната сама начала запись штрафа отключённого (истёк грейс, вайп пати). Менеджер обязан её
   * запомнить как прощальную — иначе вход в этом окне читал сейв ДО штрафа: забег цел, золото цело.
   */
  onFarewell?: (charId: string, write: Promise<Farewell>) => void;
  /**
   * ⭐ V2: ОДИН ЗАБЕГ — ОДНА КОМНАТА. Где идёт забег `key` на этой ноде, кроме `room`: код комнаты, которая его держит (`Room.holdsRun`), —
   * иначе `undefined`. Нет хуков (комната без менеджера, тесты комнаты) — забег ничей.
   */
  runBusy?: (key: string, room: Room) => string | undefined;
  /** ⭐ V2: взять забег `key` за этой нодой в кластере — код комнаты-держателя на ДРУГОЙ ноде или `null` (наш). Бросок — база молчит. */
  runClaim?: (key: string, room: Room) => Promise<string | null>;
  /** ⭐ V2: `room` взяла забег `key` — вошла с ним в подземелье (`takeRun`). */
  runTaken?: (key: string, room: Room) => void;
  /** ⭐ V2: `room` забег `key` больше не берёт (кончила, начала другой, продолжение сорвалось) — свободен, если его не держит никто здесь. */
  runDropped?: (key: string, room: Room) => void;
}

function idleInput(): PlayerInput {
  return { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
}

/**
 * R4-14: героя жжёт урон по времени (яд, горение, кровотечение). ⭐ R7-08: и он его ДОБЬЁТ — остаток урона (стаки × сила в
 * секунду × оставшиеся секунды) не меньше здоровья. Раньше в счёт шёл любой остаток: последний стак яда (2 с × 1 в секунду
 * при полном здоровье) делал спокойно вышедшего «сбежавшим из боя», и город напарника хоронил его со штрафом. `now` — время
 * мира (в нём считаются сроки дебаффов).
 */
function burning(p: PlayerEntity, now: number): boolean {
  let left = 0;
  for (const k of Object.keys(p.debuffs) as DebuffKind[]) {
    const d = p.debuffs[k];
    if (d && isDotKind(k)) left += (d.stacks * d.mag * Math.max(0, d.expiresAt - now)) / 1000;
  }
  return left > 0 && left >= p.hp;
}

/**
 * ⭐ R7-02: всё снаряжение, что несут герои каждого аккаунта здесь (надетое, сумка, пояс), — аккаунт → вещи. Передать вещь
 * своему герою можно (R2-02): снаряжение основного в сумке альта — всё равно снаряжение основного.
 */
function gearPool(heroes: readonly { save: SaveState; userId: string }[]): Map<string, Item[]> {
  const pool = new Map<string, Item[]>();
  for (const { save, userId } of heroes) {
    let list = pool.get(userId);
    if (!list) pool.set(userId, (list = []));
    for (const it of Object.values(save.equipment)) if (it) list.push(it);
    for (const it of save.inventory) list.push(it);
    for (const it of save.belt ?? []) if (it) list.push(it);
  }
  return pool;
}

/** ⭐ R8-04: наибольшая мощь героя в забеге `run` (`Room.notePeak`); из базы — только годное число. */
function runPeak(run: SaveState['run'] | undefined): number {
  const v = run?.peak;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Комната кооп-игры = один авторитетный `GameSession` (rewards:true). Луп 30 Гц: собрать
 * ввод игроков → tick → разослать снапшот+события. Город/данж — через `enterFloor`. Команды
 * города (магазин/экип/распределение) исполняет `townActions` над авторитетным сейвом. Спуск
 * по лестнице — по голосованию (переход когда все «за»).
 */
export class Room implements Tickable {
  readonly code: string;
  private cfg: ConfigRegistry;
  private session: GameSession;
  private seed: number;
  /** Тир текущего (или прошлого) забега. R7-06: сам по себе ничего не открывает — новый забег сверяет его с зовущим. */
  private difficultyId = 'normal';
  private area: 'town' | 'dungeon' | 'arena' = 'town';
  private depth = 0;
  /** PvP-арена: точки спавна (противоположные концы) + возрождения по pid, deadline'ы возрождения (serverTime). */
  private arenaSpawns: { x: number; y: number }[] = [];
  private arenaSpawnByPid = new Map<string, { x: number; y: number }>();
  private arenaRespawns = new Map<string, number>();
  private decor: DecorObject[] = [];
  private clients = new Map<string, Client>();
  /** Прилавок, как его видит клиент: зелья лавки этой комнаты + снаряжение из стока героя. */
  private shop: Item[] = [];
  /** Зелья лавки (R2-04): свои у комнаты, катаются на каждый заход в город — не сток. */
  private consumables: Item[] = [];
  private questBoard: QuestDef[] = [];
  /** Сток героя-хозяина, который сейчас на прилавке (R1-03): истина для покупки и доски, `shop`/`questBoard` — его вид. */
  private stock: TownStock | null = null;
  /** Когда голосование последний раз увело комнату в другую область/узел (R1-03). */
  private movedAt = 0;
  /** Статика игрока, разосланная последней (R1-11): неизменившуюся рассылать незачем. */
  private peerSent = new Map<string, string>();
  private wipeAt = 0; // serverTime авто-возврата в город после вайпа пати (0 = не запланирован)
  /** ⭐ R12-07: serverTime ухода в город пати, в которой подключены только мёртвые (`checkStranded`); 0 = не запланирован. */
  private strandAt = 0;
  /** ⭐ R13-01: назначенный возврат ждёт отвалившегося посреди боя — срок грейса, а не `STRAND_RETURN_MS` (`checkStranded`). */
  private strandWait = false;
  // Ф0.10: у каждой комнаты своя фаза автосейва. Иначе все комнаты, созданные примерно
  // одновременно, сохраняются в один и тот же оборот цикла — сотня синхронных записей подряд.
  private lastSaveAt = Date.now() - Math.floor(Math.random() * AUTOSAVE_MS);
  /** Накопитель времени до следующего снапшота (Ф1.5). Стартовая фаза случайна — как у автосейва. */
  private snapAcc = Math.random() * SNAPSHOT_DT;
  /** Когда в последний раз слали ПОЛНЫЙ кадр — страховка от расхождения (Ф1.3). */
  private lastFullAt = 0;
  /**
   * ОБЩАЯ дельта комнаты: когда область интереса выключена, вид мира у всех один, значит
   * и базис один. Персональные базисы (`Client.delta`) в этом режиме не используются.
   */
  private roomDelta = new SnapshotDelta();
  /** Монстры, чьи определения комната уже разослала. Сбрасывается на смене этажа. */
  private known = new Set<number>();
  /** R8-08: `by` и цель спуска (`targetNodeId`/`targetNodeType`) — чтобы вошедший посреди голосования получил его окно. */
  private vote: {
    kind: 'descend' | 'town' | 'arena'; by: string; diffId?: string; targetNodeId?: string; targetNodeType?: string; finish?: boolean;
    /** ⭐ R9-08: спуск из города — что он начнёт (показано в окне голосования). */
    runCfg?: AltarConfig; plan?: DescendPlan; yes: Set<string>; no: Set<string>;
  } | null = null;
  // Активный забег v2: конфиг (сид/биом/шаблон/тир), регенерируемый граф и текущий узел.
  private runConfig: RunConfig | null = null;
  private runPlan: RunPlan | null = null;
  private runNodeId: string | null = null;
  /**
   * ⭐ R4-01: ЧТО НА УЗЛЕ `runNodeId` УЖЕ ВЗЯТО (открытые сундуки, убитые монстры заселения, дёрнутые рычаги) — истина
   * комнаты. В сейвы участников уходит копией (`syncNodeState`): продолжить забег может любой из них. Живёт вместе с
   * забегом: переживает город, снимается `endRun`, новый узел начинает с чистого листа.
   */
  private nodeState: RunNodeState | null = null;
  /**
   * ⭐ R4-04: СВОД ЗАПИСЕЙ ЗАБЕГА — что взято на КАЖДОМ узле, где был кто-то из участников (`nodeState` — запись текущего
   * узла, тот же объект). Собирается из сейвов всех, кто в комнате этого забега, и раздаётся им же: любой узел, где уже
   * были, собирается по записи. Живёт вместе с забегом (`startRun`/`resumeRun` другого забега/`endRun` его очищают).
   */
  private ledger = new Map<string, RunNodeState>();
  /** ⭐ R9-01: id узлов свода текущего забега, изменившихся с последней записи в базу (`captureLedger`). */
  private ledgerDirty = new Set<string>();
  /** ⭐ R9-01: записи свода, снятые к записи в базу и ещё не легшие: ключ забега → id узла → запись (копия). */
  private ledgerOut = new Map<string, Map<string, RunNodeState>>();
  /** ⭐ R9-01: хвост записей свода этой комнаты — идут строго друг за другом. */
  private ledgerWriting: Promise<void> = Promise.resolve();
  private ledgerRetry: ReturnType<typeof setTimeout> | null = null;
  /** ⭐ R14-07: пачек свода в пути (`flushLedger`) — слив ноды ждёт и их (`ledgerPending`). */
  private ledgerInflight = 0;
  /** ⭐ R9-01: продолжение из города ждёт свод забега из базы (`resumeFromLedger`) — новых переходов до него нет. */
  private resuming = false;
  /** ⭐ V2: забег (ключ свода, `runLedgerKey`), который комната взяла (`takeRun`), — держит его, пока `holdsRun`. */
  private runLock: string | null = null;
  /** id сущности монстра → его номер в списке заселения узла (id сущностей — сквозной счётчик мира, а не номер). */
  private spawnIdx = new Map<number, number>();
  private hooks: RoomHooks;
  /** Отключённые игроки (charId → инфо) — ждут реконнекта в эту комнату. */
  private disconnected = new Map<string, Disconnected>();
  /** R4-06: какими герои ушли (charId → состояние сущности) — см. `LeftState`. */
  private left = new Map<string, LeftState>();
  /** ⭐ R13-03: тела вышедших посреди боя, ещё стоящие в бою (charId → тело), — см. `Linger`, `removePlayer`. */
  private lingering = new Map<string, Linger>();
  /**
   * ⭐ R11-04: КАКИМИ ГЕРОИ ВОШЛИ НА АРЕНУ (charId → состояние сущности, как `LeftState`): арена даёт всем полное тело на время боя
   * (`enterArenaFloor`), а возврат в город — это тело, а не арены (`enterTown`). `at` — время мира снимка: присутствующему город
   * отдаёт реген и откаты за время боя, как если бы он стоял в городе. Живёт, пока комната на арене.
   */
  private arenaHome = new Map<string, { state: LeftState; at: number }>();
  /**
   * ⭐ R11-03: СНЯТЫЕ С НЕИЗВЕСТНЫМ ИСХОДОМ ФИКСАЦИИ (`keepUnknown`) — pid → прощание «на дописать». Менеджер забирает его тем же
   * путём, что прощальную запись: закрытие сокета или выселение зовут `removePlayer`, и тот отдаёт его вместо «записано».
   */
  private staleFarewells = new Map<string, { charId: string; farewell: Farewell }>();
  /** Таймер грейс-окна при полностью пустой комнате (0 подключённых); null = не запущен. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** ⭐ R5-07: комната заморожена сливом процесса (`freeze`): мир и сейвы больше не меняются, только дописываются. */
  private frozen = false;
  /** ⭐ R12-04, R13-06: слив — присутствующие, чья запись слива легла (или писать нечего): следующий круг их не пишет. */
  private flushed = new Set<Client>();
  /** ⭐ R13-06: слив — записи присутствующих в пути (с повтором): круг, начатый поверх зависшей, вторую за ней не ставит. */
  private flushing = new Map<Client, Promise<void>>();
  /** ⭐ R13-06: дописки копий «исход неизвестен» в пути (pid → дописка) — следующий круг ждёт её, а не пишет вторую. */
  private staleRetries = new Map<string, Promise<void>>();

  constructor(code: string, cfg: ConfigRegistry, hooks: RoomHooks) {
    this.code = code;
    this.cfg = cfg;
    this.hooks = hooks;
    this.seed = randomSeed();   // D10: сид сессии решает дроп — угадываемым по часам ему быть нельзя
    // R9-02: и сам поток бросков — из криптоисточника: сидовый поток восстанавливался по взглядам монстров первого снимка.
    this.session = new GameSession(cfg, this.seed, this.difficultyId, { rewards: true, rng: sessionRng() });
    this.enterTown();
    tickScheduler.add(this);
  }

  get size(): number { return this.clients.size; }

  // ── Игроки ──────────────────────────────────────────────────────────────────
  // Личность/владение персонажем проверяет `roomManager` (сессия+charId), сюда приходит уже
  // авторитетный сейв владельца `userId` — комната лишь ведёт игру и персистит.
  addPlayer(ws: GameConn, userId: string, save: SaveState, version: number): string {
    return this.attach(ws, userId, save, version);
  }

  /** Вход + немедленное ПРОДОЛЖЕНИЕ сохранённого забега (реконнект БЕЗ грейс-комнаты: комната истекла или
   *  разрыв был в городе, но `save.run` цел). Граф регенерится из `save.run.config`, входим в текущий узел. */
  addPlayerResumeRun(ws: GameConn, userId: string, save: SaveState, version: number): string {
    const pid = this.attach(ws, userId, save, version);
    if (save.run) this.resumeRun(save);   // регенерит runPlan из config и enterNode(currentNodeId) → тот же этаж
    return pid;
  }

  /**
   * Реконнект отключённого игрока (по charId) — возврат в ЭТУ комнату. Где и каким — решает запись ухода (`LeftState`,
   * R4-06): тот же экземпляр этажа — та же точка, то же здоровье, дебаффы и откаты; этаж сменился — вход этажа.
   * Снимаем паузу (соло) и отменяем грейс-таймер.
   */
  reconnect(ws: GameConn, userId: string, save: SaveState, version: number): string {
    this.disconnected.delete(save.charId);
    this.hooks.onUngrace(save.charId);
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    tickScheduler.add(this); // снять паузу (соло) — планировщик игнорит повторный add
    return this.attach(ws, userId, save, version);
  }

  /**
   * R4-18: сколько мест в комнате занято, не считая этого героя (подключённые и ждущие реконнекта) — для потолка пати.
   * Свой же charId не в счёт: возвращается на своё место.
   * ⭐ R6-14: ждущий реконнекта держит место, только пока может вернуться на ТО ЖЕ место — запись ухода с точкой (тот же
   * экземпляр этажа, R4-06). Пати ушла с этажа (город, спуск, финал) — место свободно: раньше отвалившийся спокойно держал
   * его, пока жива комната, и три оставшихся не могли позвать четвёртого по коду. Вернуться он может всегда — возвращение
   * («Продолжить», свой код) мест не спрашивает.
   */
  seatsTaken(charId: string): number {
    let n = 0;
    for (const c of this.clients.values()) if (this.session.world.players[c.pid]?.save.charId !== charId) n++;
    for (const id of this.disconnected.keys()) if (id !== charId && this.left.get(id)?.pos) n++;
    return n;
  }

  /** Общий путь входа/реконнекта: добавить игрока (туда и таким, каким ушёл, — R4-06) и разослать кадры. */
  private attach(ws: GameConn, userId: string, save: SaveState, version: number): string {
    // Дедуп по charId: если этот персонаж уже активен (реконнект при ещё не разорванном старом ws —
    // TCP держит мёртвый коннект до heartbeat/таймаута), выселяем СТАРУЮ сущность БЕЗ грейса — иначе
    // в комнате два «меня» (тот самый баг «игра думает что нас трое»). Ровно один энтити на charId.
    for (const [oldPid, oc] of this.clients) {
      const op = this.session.world.players[oldPid];
      if (!op || op.save.charId !== save.charId) continue;
      this.noteLeft(op);   // R4-06: новая сущность продолжит эту, а не начнёт с полного здоровья
      oc.ws.close(4001, 'replaced');
      this.session.removePlayer(oldPid);
      this.clients.delete(oldPid);
      this.peerSent.delete(oldPid);
      this.broadcast({ t: 'peerLeft', id: oldPid });
      if (this.vote) { this.vote.yes.delete(oldPid); this.vote.no.delete(oldPid); }
      break; // на charId максимум один активный
    }
    // ⭐ R13-03: ТЕЛО, ОСТАВЛЕННОЕ В БОЮ, — ЭТО ОН: вернулся, пока оно стоит, — встаёт им (запись ухода — с тела: там же, с тем же
    // здоровьем, откатами, живым или мёртвым). Копия тела — тот же сейв той же версии, что прочитал вход, и новее его (опыт за
    // добитого его ядом): её и берём. Версия в базе другая — правда в базе.
    const ling = this.endLinger(save.charId, false);
    if (ling && ling.info.saveVersion === version) save = ling.info.save;
    if (this.disconnected.has(save.charId)) { this.disconnected.delete(save.charId); this.hooks.onUngrace(save.charId); }
    // ⭐ R2-19: вошли в комнату, стоящую в грейсе (по коду, а не реконнектом), — снять паузу, как `reconnect`.
    // Раньше вошедший сидел в замороженном мире без тиков, кадров и автосейва, а истечение грейса уничтожало
    // комнату вместе с ним. Отключённые ждут дальше — как ждут, пока в комнате играет кто-то ещё.
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; tickScheduler.add(this); }

    const pid = `p_${randomUUID()}`;
    const client: Client = { pid, ws, input: idleInput(), userId, saveVersion: version, saving: Promise.resolve(), dedup: new CommandDedup<CmdOutcome>(),
      invalidWarnAt: 0, invalidMuted: 0, stale: false, reasons: new Map(), fieldWrite: false, writeFailedAt: 0, inputSeen: true, inputAge: 0, unsure: [],
      tm: new SessionTelemetry(), tmRow: null, tmFlushedAt: Date.now(), baselined: false, delta: new SnapshotDelta(), visible: new Set() };
    this.clients.set(pid, client);
    // R2-02: аккаунт — в сущность игрока: выброшенное им помечается, и чужой аккаунт его не поднимет.
    // R4-06: ушёл с этого же экземпляра этажа — встаёт там же и таким же (здоровье, дебаффы, откаты, смерть).
    let left = this.takeLeft(save.charId);
    // ⭐ R11-04: пришёл на арену впервые за этот бой — тело арены полное (как у всех), а его тело вне арены (запись ухода или
    // пулы из сейва) ждёт возврата в город (`arenaHome`). Уже бился здесь и отключился — возвращается телом арены (R4-06).
    const arenaFirst = this.area === 'arena' && !this.arenaHome.has(save.charId);
    const home = arenaFirst ? left : undefined;
    if (arenaFirst) left = undefined;
    const pe = this.session.addPlayer(pid, save, left?.pos, userId);
    // R11-04: пулы из сейва (с регеном за время вне игры) — считаются по свежей сущности (полные пулы), до `restoreLeft`.
    let pools: ReturnType<typeof savedVitals> | undefined;
    const saved = (): ReturnType<typeof savedVitals> =>
      (pools ??= save.vitals ? savedVitals(pe, save.vitals, playerSnapshot(save, this.cfg).derived, Date.now()) : {});
    // ⭐ R12-02: запись ухода, которую с тех пор обогнал сейв другой комнаты, — с пулами из сейва (`freshLeft`).
    const fresh = (s: LeftState | undefined): LeftState | undefined => (s && this.staleLeft(s, save) ? this.freshLeft(s, pe, saved()) : s);
    left = fresh(left);
    // R12-02: вернулся на арену, с которой уходил, — и его тело города (`arenaHome`) проверяется тем же правилом.
    const arenaBack = this.area === 'arena' && !arenaFirst ? this.arenaHome.get(save.charId) : undefined;
    if (arenaBack) arenaBack.state = fresh(arenaBack.state)!;
    const deadAgain = left ? this.restoreLeft(pid, left) : false;
    if (arenaFirst || !left) {
      // R11-04: новая комната — пулы из сейва (с регеном за время вне игры), а не полные.
      if (arenaFirst) this.arenaHome.set(save.charId, { state: fresh(home) ?? { ...this.stateOf(pe), ...saved() }, at: this.session.world.timeMs });
      else Object.assign(pe, saved());
    }
    this.joinRun(save);
    pruneBoardQuests(save);          // R5-20: сданное с доски в старом сейве — из журнала (квота помнит поколения)
    ensureMainQuest(this.cfg, save); // свежему персонажу — первый квест цепочки (до кадра joined)
    // R1-03: первый в городской комнате — её хозяин: прилавок и доска — ЕГО сток. Раньше комната показывала
    // сток, скатанный конструктором без хозяина (уровень 1), а новая комната была бесплатным перебросом.
    // ⭐ R7-18: и вошедший не первым не видит поколения, которое уже сменилось (`stockStale`): прилавок — заново, всем.
    const restocked = this.area === 'town' && (this.clients.size === 1 || this.stockStale());
    if (restocked) this.restock();
    void this.persist(pid); // фиксируем на входе (reconnect найдёт запись)
    this.send(ws, {
      t: 'joined', v: PROTOCOL_VERSION, playerId: pid, roomCode: this.code,
      floor: this.currentFloorInit(), peers: this.peerList(), save: clientSave(save),   // R14-10: без сида забега
    });
    // Сундук с журналом — сразу: кузница по нему решает, что открыто. ⚠ Переезд старого кошелька сейва в
    // сундук аккаунта делает менеджер ДО входа (R1-06): здесь, уже в живой комнате, его откат после неудачной
    // записи возвращал бы и всё, что игрок успел сделать за время ожидания базы (бросил вещь — она и на земле,
    // и снова в сумке).
    void this.sendStash(pid).catch((e: unknown) => console.error(`[room ${this.code}] сундук на входе ${save.charId}:`, e));
    if (this.area === 'town') this.send(ws, this.shopFrame());
    if (this.runPlan && this.runNodeId) this.send(ws, { t: 'runPlan', plan: clientPlan(this.runPlan), currentNodeId: this.runNodeId });   // R14-10
    this.send(ws, { t: 'questBoard', quests: this.questBoard });
    // ⭐ R2-03: статика ВСЕХ, кто уже в комнате, — вошедшему отдельным кадром. Клиент берёт статику только из
    // `peerInfo`/`peerJoined`, а рассылка статики с R1-11 шлёт лишь изменившееся: тех, кто сидел здесь раньше,
    // вошедший (и вернувшийся реконнектом) не узнавал никогда — безымянный «воин» с полной полоской HP.
    this.send(ws, { t: 'peerInfo', peers: this.peerList() });
    const info = this.peerInfo(pid);
    this.peerSent.set(pid, JSON.stringify(info));
    this.broadcastExcept(pid, { t: 'peerJoined', peer: info });
    // ⭐ R8-08: ГОЛОСОВАНИЕ ОТКРЫТО — вошедшему его окно, всем — новый счёт: его «за» теперь тоже нужно (`checkVote`). Раньше окно
    // слалось только на старте: вошедший по коду (и вернувшийся «Продолжить») его не видел, счёт вставал на «2/3» без причины,
    // а его собственный портал и выход молчали — голосование уже идёт.
    if (this.vote) {
      this.send(ws, this.voteStartFrame(this.vote));
      this.broadcast({ t: 'voteUpdate', yes: this.vote.yes.size, total: this.clients.size });
    }
    if (restocked && this.clients.size > 1) {   // R7-18: прилавок сменился при входе не первого — остальным тоже
      this.broadcastExcept(pid, this.shopFrame());
      this.broadcastExcept(pid, { t: 'questBoard', quests: this.questBoard });
    }
    // ⭐ R3-06, R4-06: УШЁЛ МЁРТВЫМ — ВЕРНУЛСЯ МЁРТВЫМ, каким бы путём ни вернулся (реконнект, вход по коду, вторая вкладка).
    // Погибший в коопе ждёт следующего этажа (`enterFloor` оживляет мёртвых), а вход заводил ему свежую сущность с полным
    // здоровьем прямо на месте гибели. Окно смерти клиенту — заново, потерь в нём нет: штраф уже взят.
    // ⭐ R12-07: живых в пати не осталось — «возвращаетесь в город» (возврат назначен), а не вечное «ждите пати»; вошёл живой —
    // назначенный возврат снят. ⭐ R13-05: окно — статусом (`deathStatus`): это не новая смерть.
    if (!deadAgain) {
      if (save.run) delete save.run.deadAt;   // ⭐ V1: вошёл живым — смерть в забеге позади
      this.cancelStranded();
      return pid;
    }
    const strand = this.checkStranded();
    if (!strand) this.send(ws, this.deathStatus(false));
    else if (strand === 'quiet') this.send(ws, this.strandStatus());
    return pid;
  }

  /**
   * ⭐ R4-04: ГЕРОЙ ВХОДИТ В КОМНАТУ ЗАБЕГА. Его записи узлов — в свод комнаты (взятое им где-то ещё взято и здесь), свод —
   * ему и всем участникам. Указатель — ТОЛЬКО ВПЕРЁД: отставший встаёт на узел пати (как поставил бы `enterNode`), а
   * ушедший дальше остаётся на своём. Раньше указатель ставился на узел комнаты в любую сторону, и запись пройденного
   * узла заменялась записью узла комнаты: вошёл по коду к другу, стоящему раньше, вышел — «Продолжить» и спуск давали
   * пройденный узел свежим, по кругу (сундуки, босс, опыт).
   *
   * R4-06: в подземелье без указателя забега не бывает — иначе вошедший (или воскрешённый входом) уходил потом с добычей
   * без штрафа брошенного забега: «Завершить» штрафует только за `save.run`.
   */
  private joinRun(save: SaveState): void {
    const cfg = this.runConfig;
    if (!cfg) return;
    if (save.run?.config && sameRun(save.run.config, cfg)) {
      const spread = foldRunRecords(this.ledger, runRecords(save.run, cfg));
      const st = this.nodeState;
      if (st && this.depthOf(save.run.currentNodeId) < this.depthOf(st.id)) {
        save.run.currentNodeId = st.id;
        const was = Array.isArray(save.run.visited) ? save.run.visited : [];
        save.run.visited = was.includes(st.id) ? was : [...was, st.id];
      }
      putRunRecords(save.run, this.ledger.values());
      if (spread) {
        for (const s of this.runSaves()) if (s !== save) putRunRecords(s.run!, this.ledger.values());
        this.markLedger();   // R9-01: принесённое вошедшим — и в свод базы
      }
      return;
    }
    if (!save.run && this.area === 'dungeon' && this.runNodeId) {
      save.run = { templateId: cfg.templateId, config: cfg, currentNodeId: this.runNodeId, visited: [this.runNodeId] };
      putRunRecords(save.run, this.ledger.values());
    }
  }

  /** Глубина узла текущего забега (−1 — не узел этого плана). */
  private depthOf(nodeId: string | undefined): number {
    return this.runPlan?.nodes.find((n) => n.id === nodeId)?.depth ?? -1;
  }

  /** Сейвы участников ЭТОГО забега: подключённых и (`away`) ждущих реконнекта. */
  private *runSaves(away = false): Generator<SaveState & { run: NonNullable<SaveState['run']> }> {
    const cfg = this.runConfig;
    if (!cfg) return;
    const mine = (s: SaveState | undefined): s is SaveState & { run: NonNullable<SaveState['run']> } =>
      !!s?.run?.config && sameRun(s.run.config, cfg);
    for (const pid of this.clients.keys()) { const s = this.session.world.players[pid]?.save; if (mine(s)) yield s; }
    if (away) for (const info of this.disconnected.values()) if (mine(info.save)) yield info.save;
  }

  /**
   * R4-06: запомнить, каким герой уходит (выход, выселение, снятие сессии). Время для ушедшего стоит: дебаффы — остатком.
   * Самые давние записи вытесняются потолком `LEFT_MAX`.
   */
  private noteLeft(p: PlayerEntity): void {
    this.noteVitals(p);   // R11-04: и в сейв — пока сущность в мире (запись уйдёт позже, и комната к тому времени могла уйти с арены)
    const charId = p.save.charId;
    // ⭐ R12-02: запись ухода — с меткой пулов сейва, которые уходят с ним (`LeftState.savedAt`); и тело города на арене — тоже.
    const savedAt = p.save.vitals?.at;
    this.left.delete(charId);
    this.left.set(charId, { ...this.stateOf(p), savedAt });
    const home = this.arenaHome.get(charId);
    if (home) home.state.savedAt = savedAt;
    if (this.left.size > LEFT_MAX) this.left.delete(this.left.keys().next().value!);
  }

  /**
   * ⭐ R12-02: ЗАПИСЬ УХОДА УСТАРЕЛА — сейв, пришедший со входом, писала ПОСЛЕ ухода отсюда другая комната (метка `save.vitals.at`
   * новее `savedAt`). Раньше запись ухода побеждала всегда: друг (или вторая вкладка того же аккаунта) держит городскую комнату, герой
   * уходит из неё полным, бьётся где-то ещё до 5% и 0 маны — и вход к другу по коду возвращал его полным («больница», по кругу после
   * каждого боя); а честному наоборот — отдохнувшему возвращал старые раны и откаты. Мёртвый — по-прежнему мёртв (R3-06).
   */
  private staleLeft(s: LeftState, save: SaveState): boolean {
    const at = save.vitals?.at;
    return s.alive && typeof at === 'number' && Number.isFinite(at) && at > (s.savedAt ?? -Infinity);
  }

  /**
   * ⭐ R12-02: устаревшая запись ухода → пулы из сейва (`saved`, как у новой комнаты; битая запись пулов — полные, как там же), а
   * баффы, откаты умений и тоглы этой комнаты — не его: их с тех пор сменила другая комната. Точка ухода, дебаффы и стан — прежние
   * правила (R4-06, R4-16).
   */
  private freshLeft(s: LeftState, pe: PlayerEntity, saved: ReturnType<typeof savedVitals>): LeftState {
    // ⭐ R13-04: ТОТ ЖЕ ЭКЗЕМПЛЯР ПОДЗЕМЕЛЬЯ (точка ухода цела, R4-06) — не «больница» ни в какую сторону: пулы не выше записи ухода
    // (сейв другой комнаты их только опускает), откаты, баффы и тоглы — её. Раньше правило города шло и сюда: ушёл с 5% посреди боя,
    // отдохнул в другой комнате — и вход по коду ставил его на место боя полным, со всеми откатами готовыми.
    if (this.area === 'dungeon' && s.pos) {
      return {
        ...s, hp: Math.min(s.hp, saved.hp ?? s.hp), mana: Math.min(s.mana, saved.mana ?? s.mana),
        stamina: Math.min(s.stamina, saved.stamina ?? s.stamina), savedAt: undefined,
      };
    }
    return { ...s, hp: pe.hp, mana: pe.mana, stamina: pe.stamina, ...saved, skillCd: {}, toggles: [], skillBuffs: {}, savedAt: undefined };
  }

  /**
   * ⭐ R13-04: КОМНАТА СОЧЛА ГЕРОЯ ПОГИБШИМ («Завершить», страховка входа в новую комнату, истёк грейс, вайп, похороны сбежавшего из
   * боя) — погиб он и для записи ухода: вход в эту комнату по коду вернёт его мёртвым на месте (R3-06), а не живым. Раньше запись
   * ухода оставалась живой: штраф брошенного забега снимал с сейва пулы, новая комната писала полные — и вход по коду к напарнику
   * воскрешал на месте боя полным, с готовыми откатами, за цену обычной смерти. Смена этажа мёртвые записи и так снимает.
   */
  private leftDead(charId: string): void {
    const s = this.left.get(charId);
    if (s) { s.alive = false; s.hp = 0; }
  }

  /**
   * ⭐ V1: МЕТКА ОПЛАЧЕННОЙ СМЕРТИ — В СЕЙВ (`run.deadAt`, узел): штраф за эту смерть в нём же, и в базу они уходят одной записью. «Мёртв,
   * оплачено» переживает всё, что переживает сейв: снятие сессии записью, уход комнаты, «Завершить» по строке базы (`abandonStored`) —
   * второго штрафа за ту же смерть нет. Снимается жизнью (новый узел, город, вход живым — `enterNode`, `enterTown`, `attach`) — ⭐ C-03: и у
   * ждущих реконнекта.
   * ⭐ C-03: и только ЗАБЕГ КОМНАТЫ. Гость со своим припаркованным забегом (`joinRun` чужой забег не трогает) погибал в подземелье чужого — и его
   * забег метился «мёртв, оплачено», хотя в нём он не умирал: «Завершить» его потом шло без штрафа.
   */
  private markDead(save: SaveState): void {
    if (!save.run?.config || this.area !== 'dungeon' || !this.runNodeId || !this.runConfig || !sameRun(save.run.config, this.runConfig)) return;
    save.run.deadAt = this.runNodeId;
  }

  /**
   * ⭐ C-03: СМЕНА ЭТАЖА ОЖИВЛЯЕТ И ЖДУЩИХ РЕКОННЕКТА (`floorChanged` снимает их мёртвые записи ухода: вернётся — живым). «Мёртв, оплачено»
   * (`paid`, `run.deadAt`) с них снимается, как с присутствующих (`enterNode` переписывает им забег, `enterTown` снимает метку). Раньше — только
   * с подключённых: погибший, закрывший вкладку до ухода пати в город (или на новый узел), нёс оплаченную смерть дальше — и «Завершить»
   * (из грейса и по строке базы после него) и похороны его брошенного забега шли без штрафа: быть офлайн в этот миг стоило на штраф дешевле.
   */
  private reviveAway(): void {
    for (const info of this.disconnected.values()) {
      info.paid = false;
      if (info.save.run) delete info.save.run.deadAt;
    }
  }

  /** R4-06: состояние сущности героя — как запись ухода (`LeftState`); время для снятого стоит: дебаффы — остатком. */
  private stateOf(p: PlayerEntity): LeftState {
    const now = this.session.world.timeMs;
    const debuffs: DebuffState = {};
    for (const [k, d] of Object.entries(p.debuffs)) if (d) debuffs[k as DebuffKind] = { ...d, expiresAt: Math.max(0, d.expiresAt - now) };
    return {
      pos: { ...p.pos }, alive: p.alive, hp: p.hp, mana: p.mana, stamina: p.stamina, debuffs,
      stunTimer: p.stunTimer, attackCd: p.attackCd, dodgeCd: p.dodgeCd, combatTimer: p.combatTimer,
      skillCd: { ...p.skillCd }, toggles: [...p.toggles], skillBuffs: { ...p.skillBuffs },
    };
  }

  /** R4-06: запись ухода героя — только годная к возврату (мёртвый в арене возрождается свежим, как там и положено). */
  private takeLeft(charId: string): LeftState | undefined {
    const s = this.left.get(charId);
    if (!s) return undefined;
    this.left.delete(charId);
    return s.alive || (this.area === 'dungeon' && s.pos) ? s : undefined;
  }

  /** R4-06: вернуть сущности героя состояние ухода. `true` — ушёл мёртвым с этого же этажа: мёртв и сейчас. */
  private restoreLeft(pid: string, s: LeftState): boolean {
    const p = this.session.world.players[pid];
    if (!p) return false;
    const now = this.session.world.timeMs;
    p.debuffs = {};
    for (const [k, d] of Object.entries(s.debuffs)) if (d) p.debuffs[k as DebuffKind] = { ...d, expiresAt: now + d.expiresAt };
    p.stunTimer = s.stunTimer; p.attackCd = s.attackCd; p.dodgeCd = s.dodgeCd; p.combatTimer = s.combatTimer;
    p.skillCd = { ...s.skillCd }; p.toggles = [...s.toggles]; p.skillBuffs = { ...s.skillBuffs };
    // ⭐ R9-14: здоровье, мана, выносливость — КАКИМИ УШЁЛ. Раньше они подрезались по максимуму свежей сущности, а тот посчитан
    // без стойки и баффов (`playerSnapshot` без рантайм-модов): воин в стойке +15% жизни с полным здоровьем после F5, обрыва или
    // второй вкладки вставал на ~87% настоящего максимума — посреди боя. Выше честного максимума не встанет ничего: первый же
    // тик подрезает здоровье по максимуму со стойкой и баффами (R5-02; тогл, чьих очков больше нет, он снимет раньше — R4-05),
    // а ману и выносливость — в регене, по резерву тоглов. Бесплатного лечения тоже нет (R4-06): ушёл раненым — вернулся раненым.
    p.hp = s.hp; p.mana = s.mana; p.stamina = s.stamina;
    if (s.alive) return false;
    p.alive = false; p.hp = 0;
    return true;
  }

  /**
   * R4-06, R4-16: этаж сменился — записи ушедших живут дальше так же, как присутствующие: мёртвые оживают (записи нет —
   * вход свежим), точка ухода к новому этажу не относится, город снимает дебаффы и стан.
   * ⭐ R11-04: арена записи живых больше не стирает: её полное тело — только на время боя (`arenaHome`), и ушедший раньше вернётся
   * в город таким, каким ушёл, а не свежим.
   */
  private floorChanged(to: 'dungeon' | 'town' | 'arena'): void {
    for (const [id, s] of this.left) {
      if (!s.alive) { this.left.delete(id); continue; }
      delete s.pos;
      if (to === 'town') { s.debuffs = {}; s.stunTimer = 0; }
    }
  }

  /**
   * Возвращает промис ПРОЩАЛЬНОЙ записи сейва: новый вход того же персонажа обязан дождаться её,
   * прежде чем читать сейв из базы, — иначе прочитает копию до неё, и все его записи получат отказ
   * по версии (прогресс новой сессии молча не сохранялся бы).
   */
  removePlayer(pid: string): Promise<Farewell> {
    const p = this.session.world.players[pid];
    const c = this.clients.get(pid);
    // Уже снят (R1-01: сессию, потерявшую право писать, комната снимает сама, а закрытие её сокета доходит
    // до менеджера позже) — ни записи, ни второго `peerLeft`, ни второго уничтожения комнаты.
    // ⭐ R11-03: снят с неизвестным исходом фиксации — его прощание и есть копия «на дописать» (`keepUnknown`).
    if (!p && !c) {
      const stale = this.staleFarewells.get(pid);
      if (!stale) return Promise.resolve(SAVED);
      this.staleFarewells.delete(pid);
      return Promise.resolve(stale.farewell);
    }
    if (!c && this.lingerOf(pid)) return Promise.resolve(SAVED);   // R13-03: тело в бою — уже не сессия, прощание было
    this.peerSent.delete(pid);
    let done: Promise<Farewell> = Promise.resolve(SAVED);
    let linger: Linger | undefined;
    if (p) this.noteLeft(p);   // R4-06: вернётся — таким, каким ушёл
    void this.flushLedger();   // ⭐ R9-01: ушедший может выбросить свою копию забега (финал, «Завершить») — свод уже в базе
    if (p && c) {
      const last = this.persist(pid); // персист прогресса
      // R2-08: не записалось — копия на выходе (объект сейва тот же) и версия этой сессии остаются у менеджера.
      done = last.then((r) => this.farewellOf(r, () => this.queued(c, () => this.write(c, p, undefined))));
      void this.writeTelemetry(c, true);   // Ф3.2: закрываем наблюдение за этой сессией
      // Грейс-реконнект — ТОЛЬКО из подземелья: тело убираем из мира (монстры не бьют «пустого»),
      // ждём возврата в ту же точку. В городе выход = чистый разрыв (реконнекта нет, ждать нечего).
      if (this.area === 'dungeon') {
        // ⚠ ВЕРСИЯ — ПОСЛЕ прощальной записи. Раньше она бралась сразу, а запись выше её тут же
        // поднимала: штраф «Завершить забег» (и истечения грейса) предъявлял устаревшую версию,
        // база отказывала, и штраф вместе со снятием забега молча не записывался — бросить забег
        // было бесплатно, а «продолжить» потом возвращало на тот же этаж со всей добычей.
        // R4-14: ушёл живым посреди боя (не у портала, в бою или под ядом) — пати, ушедшая в город, не уносит его даром.
        // ⭐ R8-07: и для спуска пати — по правилу голоса за спуск (`canDescend`): у выхода — не бегство, у портала входа — бегство.
        const danger = p.alive && this.inDanger(p);
        const fled = danger && !this.canLeave(pid);
        const fledDescend = danger && !(this.session.world.exits ?? []).some((e) => this.stands(pid, e));
        const info: Disconnected = {
          save: p.save, userId: c.userId, saveVersion: c.saveVersion, saving: Promise.resolve(), paid: !p.alive, fled, fledDescend, reasons: c.reasons,
          unsure: [],
        };
        // R14-04: и снимки записей с неизвестным исходом — прощальная легла, а ответ потерян: следующая запись копии пишет поверх неё.
        info.saving = last.then(() => { info.saveVersion = c.saveVersion; info.unsure = [...c.unsure]; });
        this.disconnected.set(p.save.charId, info);
        this.hooks.onGrace(p.save.charId);
        // Копию отключённого пишет его собственная очередь — та же, что потом запишет штраф или вернёт героя.
        const charId = p.save.charId;
        done = last.then((r) => this.farewellOf(r, () => this.persistDisconnected(charId, info)));
        // ⭐ R13-03: УШЁЛ ПОСРЕДИ БОЯ — ТЕЛО ОСТАЁТСЯ В БОЮ (`balance.combatLogoutSec`). Раньше оно снималось сразу:
        // монстры переключались на ближайшего живого, начатые замахи уходили в пустоту, напарник добивал или уводил их — и возврат
        // («Продолжить», вход во второй вкладке, `leave` + `join` на одном сокете за пару кругов базы) ставил героя на то же место с
        // теми же 1 HP, без штрафа. Бегство (`fled`) наказывалось только уходом пати с этажа. Теперь тело стоит без ввода, пока бой не
        // кончится, срок не выйдет или оно не погибнет (штраф смерти — его копии).
        // ⭐ R14-01: ВСЕГДА, кто бы ни остался подключён, — а мир идёт, только пока подключён ЖИВОЙ (`halted`). Раньше тело оставалось лишь
        // при `clients.size > 1`: мёртвый напарник держал мир на ходу, и тело честного, нажавшего F5 посреди боя, гибло «вне игры» без
        // защиты — штраф и вайп (обратно R13-01); а ушедший последним уходил из-под удара целиком: вход альта по коду или «Продолжить»
        // ушедшего раньше напарника снимали паузу уже без тела — и он возвращался на то же место с теми же HP.
        const ms = Math.max(0, this.cfg.get('balance').combatLogoutSec) * 1000;
        if (danger && ms > 0 && !this.frozen) {
          linger = { pid, p, info, until: this.session.world.timeMs + ms, sig: saveSig(p.save) };
          this.lingering.set(charId, linger);
          this.session.saveHeld.add(pid);
        }
      }
    }
    this.clients.delete(pid);
    if (!linger) {
      this.session.removePlayer(pid);
      this.broadcast({ t: 'peerLeft', id: pid });
    }
    if (this.vote) { this.vote.yes.delete(pid); this.vote.no.delete(pid); this.checkVote(); }
    // Комната опустела: если есть кого ждать (данж-отключённые) → пауза+грейс; иначе (город) — уничтожаем.
    if (this.clients.size === 0) {
      if (this.disconnected.size > 0) this.enterGrace();
      else { this.stop(); this.hooks.onEmpty(this.code); }
    } else this.checkStranded();   // ⭐ R12-07: ушёл последний живой — мёртвые не ждут вечно
    return done;
  }

  /**
   * Итог прощальной записи (R2-08): записано или отменено базой (копию обогнали — писать её поздно) — готово;
   * сбой базы или неизвестный исход фиксации — копия ещё не в базе, `retry` допишет её (сам себе ответит тем же).
   */
  private farewellOf(r: WriteResult, retry: () => Promise<WriteResult>): Farewell {
    if (r === 'ok' || r === 'conflict') return SAVED;
    return { saved: false, retry: () => retry().then((n) => this.farewellOf(n, retry)) };
  }

  /**
   * Забросить забег отключённого игрока (charId): персонаж считается погибшим — полный штраф
   * смерти + персист + снятие из грейс-карты. Пустая после этого комната уничтожается.
   * Вызывается по кнопке «Забросить» и как страховка при осознанном входе в НОВУЮ комнату.
   * Промис — запись штрафа: вход после «Завершить» обязан читать сейв уже СО штрафом.
   */
  abandonAsDead(charId: string, insurance = false): Promise<Farewell> {
    this.endLinger(charId, false);   // R13-03: тело в бою — из мира (итог его боя уйдёт этой же записью)
    const info = this.disconnected.get(charId);
    let done: Promise<Farewell> = Promise.resolve(SAVED);
    // ⭐ R7-03: страховочный бросок (`insurance` — вход в НОВУЮ комнату) того, чей забег пати уже увела в город, — не смерть:
    // забег припаркован, как у вышедшего из города, и такой вход его не трогает. «Завершить» (не страховка) — штраф, как за
    // любой припаркованный забег (`abandonStored`).
    // ⭐ C-04: и гостя, чей забег — не забег комнаты: бросать здесь ему нечего, а свой забег он здесь не вёл.
    if (info && insurance && (info.safe || this.foreignRun(info))) {
      done = this.releaseParked(charId, info);
      this.destroyIfEmpty();
      return done;
    }
    if (info) {
      // ШТРАФ ТОЛЬКО ЗА БРОШЕННЫЙ ЗАБЕГ. Стоять в городе и отключиться — не преступление;
      // без этой проверки уже погибший игрок платил бы второй раз за ту же смерть.
      // R3-06: и погибший в коопе — у него забег цел (ждал следующего этажа), а штраф уже взят `onPlayerDeath`.
      const run = info.save.run?.config;
      // ⭐ V1: и смерть, оплаченная по сейву (`run.deadAt`), — второго штрафа нет.
      // ⭐ C-03: смерть здесь (`paid`) оплатила только забег КОМНАТЫ: гость, погибший в чужом ему забеге, свой припаркованный бросает за штраф,
      // как бросил бы, не погибнув (так же по строке базы — `abandonStored`, `markDead` метит только забег комнаты).
      const paid = info.paid && !this.foreignRun(info);
      if (info.save.run && !paid && info.save.run.deadAt === undefined) applyDeathPenalty(info.save, this.cfg.get('balance').deathPenalty, townRng());
      info.save.run = undefined;   // «Завершить» обязано завершать: иначе модалка выскакивала снова
      // R2-08: штраф не записался — копия со штрафом остаётся у менеджера, вход её допишет, а не обойдёт.
      // R4-15: копию обогнали (ответ на фиксацию прощальной записи потерян, версию подняли отзыв или откат) — штраф ляжет
      // на строку базы: там правда о герое, а копия устарела.
      const retry = (): Promise<WriteResult> => this.persistDisconnected(charId, info, this.buryOp(run));
      done = retry().then((r) => this.farewellOf(r, retry));
      this.disconnected.delete(charId);
      this.leftDead(charId);   // R13-04: и вход сюда по коду — мёртвым
    }
    this.hooks.onUngrace(charId);
    this.checkStranded();   // R13-01: ждать больше некого — возврат застрявших пересчитан
    this.destroyIfEmpty();
    return done;
  }

  /**
   * ⭐ R2-05: закрепление героя у ДРУГОЙ ноды — здесь проигравшая копия. Живую сессию снимаем без записи (как
   * устаревшую, сокет 4009: писать ей больше нельзя — правда теперь там), ждущего реконнекта забываем без штрафа
   * (его забег продолжится там, где он жив). Возвращает, было ли что снимать.
   */
  fence(charId: string): boolean {
    // R11-03: и копия «на дописать» сессии, снятой с неизвестным исходом фиксации, — тоже проигравшая (R6-06).
    for (const [pid, s] of this.staleFarewells) if (s.charId === charId) this.staleFarewells.delete(pid);
    this.forfeitHeld(charId);   // ⭐ V-B2-04: выброшенное проигравшей копией лежит в строке героя — с земли долой
    for (const c of this.clients.values()) {
      if (this.session.world.players[c.pid]?.save.charId !== charId) continue;
      this.dropStale(c);
      return true;
    }
    this.endLinger(charId, false);   // R13-03: тело проигравшей копии — из мира, без записи
    if (!this.disconnected.delete(charId)) return false;
    this.hooks.onUngrace(charId);
    this.checkStranded();   // R13-01
    this.destroyIfEmpty();
    return true;
  }

  /**
   * ⭐ V-B2-04: менеджер забыл недописанную копию героя (R6-06: героя держит чужая нода) — правда о нём там, в его строке, а выброшенное
   * копией ещё лежит в этой строке: с земли его долой (иначе вещь у двоих, а вернувшийся сюда поднял бы её второй раз).
   */
  copyLost(charId: string): void {
    this.forfeitHeld(charId);
  }

  /** Уничтожить комнату, если в ней никого (ни подключённых, ни ждущих реконнекта). */
  private destroyIfEmpty(): void {
    if (this.clients.size > 0 || this.disconnected.size > 0) return;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.stop();
    this.hooks.onEmpty(this.code);
  }

  /** Текущий этаж (0 = город) — для модалки «Продолжить/Забросить». */
  get currentDepth(): number { return this.depth; }
  /**
   * ИДЁТ ЛИ ЗАБЕГ в этой комнате. Раньше реконнект считал «забег есть» по САМОМУ ФАКТУ
   * существования грейс-комнаты — а комната живёт и когда игрок просто стоит в городе.
   * Поэтому после гибели модалка «Продолжить» выскакивала даже тогда, когда продолжать было нечего.
   * План существует ровно между стартом забега и `endRun()` — это и есть честный ответ.
   * В город можно выйти и ПОСРЕДИ забега — там план цел, и продолжить действительно есть что.
   */
  get inRun(): boolean { return !!this.runPlan; }

  /** Комната опустела: пауза симуляции (мир замирает) + грейс-таймер. Возврат — через reconnect(). */
  private enterGrace(): void {
    tickScheduler.remove(this);
    if (this.frozen) return;   // R5-07: процесс уходит — грейс-таймер (штраф через час) заводить незачем и нельзя
    if (this.graceTimer) clearTimeout(this.graceTimer);
    // ⚠ R7-20: не дольше предела таймера Node (2^31−1 мс): дольше `setTimeout` срабатывает через 1 мс — и отключённых хоронило
    // сразу. Потолок держит и схема (`reconnectGraceSec`), здесь — вторая линия.
    const ms = Math.min(Math.max(0, this.cfg.get('balance').reconnectGraceSec) * 1000, MAX_TIMER_MS);
    this.graceTimer = setTimeout(() => this.expireGrace(), ms);
  }

  /**
   * Грейс истёк (никто не вернулся за час): все отключённые погибли, пустая комната уничтожается.
   * R2-19: с живым игроком внутри — не уничтожается (он мог войти по коду в комнату, стоявшую в грейсе).
   */
  private expireGrace(): void {
    this.graceTimer = null;
    if (this.frozen) return;   // R5-07: после начала слива штрафов не пишем
    this.finalizeDisconnectedAsDead();
    if (this.clients.size > 0) return;
    this.stop();
    this.hooks.onEmpty(this.code);
  }

  /** Отключённые считаются погибшими: полный штраф смерти + персист + снятие из грейс-карты.
   *  (следующий вход = новая комната = город со штрафом). `run` — забег, который комната хоронит (вайп — снятый только что `endRun`). */
  private finalizeDisconnectedAsDead(run: RunConfig | null = this.runConfig): void {
    this.settleLingers();   // R13-03: тела в бою — из мира (их итог боя — в копию до похорон)
    for (const [charId, info] of [...this.disconnected]) this.buryDisconnected(charId, info, run);
  }

  /**
   * ⭐ C-04: забег копии — не забег комнаты (`run`): гость со своим припаркованным забегом (`joinRun` его не трогает) или забег, который
   * комната уже не ведёт. Хоронить, штрафовать и снимать его здесь не за что.
   */
  private foreignRun(info: Disconnected, run: RunConfig | null = this.runConfig): boolean {
    const own = info.save.run?.config;
    return !!own && !(run && sameRun(own, run));
  }

  /**
   * Отключённый считается погибшим: штраф смерти (только за брошенный забег и не второй раз, см. `abandonAsDead`), снятие
   * забега, прощальная запись и снятие из грейса. `roomRun` — забег комнаты, который он бросил (см. `finalizeDisconnectedAsDead`).
   */
  private buryDisconnected(charId: string, info: Disconnected, roomRun: RunConfig | null = this.runConfig): void {
    // ⭐ R7-03: пати вернулась в город после его ухода — его забег припаркован (`safe`): он «вышел из города», а не погиб.
    // Раньше такой герой оставался в грейсе как ушедший из подземелья: напарник выходил из города (грейс истекал) или нырял
    // один и погибал (вайп) — и спокойно вышедший у портала платил полный штраф смерти за забег, лежащий целым в базе.
    // ⭐ C-04: и забег копии — не этой комнаты: вайп и грейс чужого забега его не хоронят (раньше — штраф и снятие забега, который не
    // проигрывал).
    if (info.safe || this.foreignRun(info, roomRun)) {
      const write = this.releaseParked(charId, info);   // до вызова: `?.()` без хука аргументы не вычисляет
      this.hooks.onFarewell?.(charId, write);
      return;
    }
    const run = info.save.run?.config;
    if (info.save.run && !info.paid && info.save.run.deadAt === undefined) applyDeathPenalty(info.save, this.cfg.get('balance').deathPenalty, townRng());   // V1
    info.save.run = undefined;   // погиб → забег окончен; без этого следующий вход снова предлагал «продолжить»
    // R1-07: запись штрафа — ПРОЩАЛЬНАЯ, менеджер запоминает её ДО снятия грейса. Раньше она уходила
    // в пустоту: вход в этом окне не находил ни грейса, ни записи в полёте и читал сейв до штрафа —
    // забег цел, золото цело; а если штраф успевал первым, новая сессия становилась зомби.
    // R2-08: не записалась — копия со штрафом остаётся у менеджера до следующей попытки. R4-15: копию обогнали — штраф
    // ложится на строку базы.
    const retry = (): Promise<WriteResult> => this.persistDisconnected(charId, info, this.buryOp(run));
    const write = retry().then((r) => this.farewellOf(r, retry));
    this.hooks.onFarewell?.(charId, write);
    this.hooks.onUngrace(charId);
    this.disconnected.delete(charId);
    this.leftDead(charId);   // R13-04: и вход сюда по коду — мёртвым
  }

  /**
   * ⭐ R4-14: ПАТИ УШЛА С ЭТАЖА (в город, финалом, R6-01: и спуском на следующий узел) — отключившиеся посреди боя живыми
   * погибают. Раньше «закрыть вкладку за полшага до смерти, пока напарник у портала (у выхода)» уносило из любого боя:
   * реконнект — живым, без штрафа. Ушедший у портала, не в бою или мёртвым — ждёт дальше.
   * ⭐ R8-07: `move` — какой это уход. Спуск по ветке судит по правилу голоса за спуск (`fledDescend`): раньше он брал правило
   * города — загнанного у выхода (где «за» спуск ему засчитали бы) хоронил со штрафом, а загнанного у портала входа (где
   * «за» не засчитали бы) уносил живым на новый узел.
   */
  private buryFled(move: 'leave' | 'descend' = 'leave'): void {
    this.settleLingers();   // R13-03: тело в бою — из мира; бегство — по концу его боя
    for (const [charId, info] of [...this.disconnected]) {
      if ((move === 'descend' ? info.fledDescend : info.fled) && !info.paid && !info.safe) this.buryDisconnected(charId, info);
    }
  }

  /**
   * ⭐ R7-03: отпустить ждущего реконнекта, чей забег припаркован (`safe`), — как вышедшего из города: без штрафа, забег цел,
   * копия дописывается его очередью (записи узлов, пришедшие после его ухода). Вход героя дождётся этой записи: промис —
   * прощальная запись (менеджеру — через `onFarewell` или ответом «Завершить»-страховки). Продолжит он из лобби.
   */
  private releaseParked(charId: string, info: Disconnected): Promise<Farewell> {
    const retry = (): Promise<WriteResult> => this.persistDisconnected(charId, info);
    const write = retry().then((r) => this.farewellOf(r, retry));
    this.hooks.onUngrace(charId);
    this.disconnected.delete(charId);
    return write;
  }

  /**
   * ⭐ R4-15: штраф брошенного забега — ПО СТРОКЕ БАЗЫ (копия отключённого устарела: см. `persistDisconnected`). Забега в
   * строке нет — делать нечего (штраф уже лёг); оплаченная смерть (R3-06) снимает забег без второго штрафа.
   * ⭐ R6-06: и только ТОТ ЖЕ забег (`run` — конфиг брошенного забега из копии), как снятие забега на финале. Раньше штраф
   * ложился на любой забег строки: копия, проигравшая другой ноде, штрафовала героя за новый забег, начатый уже там.
   * ⭐ V1: «оплачено» — ПО САМОЙ СТРОКЕ (`run.deadAt`: штраф смерти лёг вместе с меткой), а не по копии. Раньше решала копия (`paid`): смерть,
   * оплаченная только в проигравшей копии, в строке не оплачена — и не бралась вовсе; а взятая в строке — бралась снова.
   */
  private buryOp(run: RunConfig | undefined): (s: SaveState) => boolean {
    return (s) => {
      if (!s.run?.config || !run || !sameRun(s.run.config, run)) return false;
      if (s.run.deadAt === undefined) applyDeathPenalty(s, this.cfg.get('balance').deathPenalty, townRng());
      s.run = undefined;
      return true;
    };
  }

  /**
   * Сброс прогресса ВСЕХ подключённых игроков в БД. Раньше сейв писался только на входе и
   * чистом выходе — рестарт/краш сервера (в dev — `tsx watch` на каждую правку кода) терял
   * весь прогресс забега (персонаж откатывался к последнему сохранённому уровню). Вызывается
   * периодически (автосейв) и на чекпойнтах (город/смена этажа/левелап).
   */
  private persistAll(): Promise<unknown> {
    void this.flushLedger();   // ⭐ R9-01: свод записей забега — в базу с каждым чекпойнтом (автосейв, узел, город)
    const all: Promise<WriteResult>[] = [];
    for (const [pid, c] of this.clients) {
      const p = this.session.world.players[pid];
      if (p) all.push(this.persist(c.pid));
    }
    this.lastSaveAt = Date.now();
    return Promise.all(all);
  }

  /**
   * Принудительно сохранить прогресс всех игроков — для graceful shutdown сервера.
   * Ф2: ЖДАТЬ ОБЯЗАТЕЛЬНО. Раньше запись была синхронной и `process.exit` сразу после вызова
   * был безопасен; с Postgres выход без ожидания просто выбросил бы незаписанные сейвы.
   * R1-18: и записи ОТКЛЮЧЁННЫХ (прощальная, штраф «Завершить») — они в своих очередях, `persistAll` их не видит.
   */
  /**
   * ⭐ R5-07: ЗАМОРОЗИТЬ КОМНАТУ ПЕРЕД СЛИВОМ ПРОЦЕССА — слив становится БАРЬЕРОМ, а не снимком. Раньше `flush` дописывал
   * сейвы и ждал записей, а комната жила дальше: тикала и исполняла команды. Сейв героя A (с мечом) записан сливом — A
   * бросил меч, сосед по аккаунту B поднял и положил в сундук, запись B легла до выхода процесса: меч и в последнем сейве A,
   * и в сундуке. Теперь после заморозки: тика нет (снята с планировщика), команды, ввод, голосования, рычаги и сундуки
   * отказывают «перезапускается» без изменений, транзакция, дождавшаяся базы, не исполняется, грейс-таймер снят; выход
   * игрока — только прощальная запись. Размораживания нет: процесс уходит.
   */
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    tickScheduler.remove(this);
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.settleLingers();   // R13-03: мир больше не идёт — тела в бою уходят с итогом боя (копию допишет слив)
  }

  /** R5-07: комната заморожена — игроку «перезапускается» (кадр `error`), действие не исполняется. */
  private refuseFrozen(pid: string): boolean {
    if (!this.frozen) return false;
    const c = this.clients.get(pid);
    if (c) this.send(c.ws, { t: 'error', code: 'busy', msg: FROZEN });
    return true;
  }

  /**
   * Запись слива (звать после `freeze`). ⭐ R12-04: слив зовёт её КРУГАМИ, пока всё не ляжет (`RoomManager.flushAll`): первый круг
   * пишет всех присутствующих, следующие — только тех, чья запись не легла; что не легло — `unflushed`.
   * ⭐ R13-06: ПО ГЕРОЮ, А НЕ ПО КРУГУ. Круг ждал записей всех присутствующих разом, и повтор упавших шёл только после них: одна
   * зависшая запись (блокировка строки умирающей транзакцией, полуоткрытое соединение до `query_timeout`) держала круг до конца
   * бюджета, и герой, чья запись упала сразу, а база через миг вернулась, не пробовался больше — ИНЦИДЕНТ, и отданное им соседу по
   * аккаунту оставалось у двоих. Теперь у каждого героя своя запись слива (с повтором); круг, который менеджер режет своим ломтём,
   * пробует тех, чья запись не легла и не в пути, а зависшую не множит.
   */
  flush(): Promise<unknown> {
    // ⭐ R4-10: запись, упавшая сбоем базы (взаимоблокировка, обрыв), — ещё одна попытка до выхода процесса. Раньше слив
    // выходил без неё: у героя-соседа по аккаунту вещь уже записалась, а у этого — нет, и она оставалась у обоих.
    const live = [...this.clients.values()].filter((c) => !this.flushed.has(c)).map((c) => this.flushOne(c));
    this.lastSaveAt = Date.now();
    // R11-03: и копии сессий, снятых с неизвестным исходом фиксации, которые менеджер ещё не забрал (закрытие сокета в пути).
    // ⭐ R12-04: и ПОСЛЕ записей присутствующих — «исход неизвестен» у записи самого слива тоже заводит такую копию (R13-06: после
    // записи своего героя, а не всех: зависшая чужая её не держит).
    const stale = [this.retryStale(), ...live.map((w) => w.then(() => this.retryStale()))];
    // R9-01: и свод записей забега — процесс уходит, а копии участников живут дальше.
    return Promise.all([...live, ...[...this.disconnected.values()].map((i) => i.saving), ...stale, this.flushLedger()]);
  }

  /** ⭐ R13-06: запись слива героя — одна на героя за раз (зависшая вторую за собой не ставит); легла или писать нечего — `flushed`. */
  private flushOne(c: Client): Promise<void> {
    const going = this.flushing.get(c);
    if (going) return going;
    const w = (async (): Promise<void> => {
      let r = await this.persist(c.pid);
      if (r === 'failed') r = await this.persist(c.pid);   // R4-10
      if (r !== 'failed') this.flushed.add(c);
    })().finally(() => { this.flushing.delete(c); });
    this.flushing.set(c, w);
    return w;
  }

  /** R11-03, R12-04: дописать копии снятых с неизвестным исходом фиксации; итог — вместо прощания (легла — `removePlayer` вернёт «записано»). */
  private retryStale(): Promise<unknown> {
    return Promise.all([...this.staleFarewells].map(([pid, s]) => {
      if (s.farewell.saved || !s.farewell.retry) return undefined;
      // R13-06: дописка этой копии уже в пути (прошлый круг) — ждём её, а не пишем вторую.
      let going = this.staleRetries.get(pid);
      if (!going) {
        going = s.farewell.retry().then((f) => {
          if (this.staleFarewells.get(pid) === s) this.staleFarewells.set(pid, { charId: s.charId, farewell: f });
        }).finally(() => { this.staleRetries.delete(pid); });
        this.staleRetries.set(pid, going);
      }
      return going;
    }));
  }

  /**
   * ⭐ R12-04: чьи сейвы этой комнаты слив ещё не записал: присутствующие, чья запись слива не легла (до первого круга — все), и
   * копии снятых с неизвестным исходом, которые менеджер ещё не забрал.
   */
  unflushed(): string[] {
    const out: string[] = [];
    for (const c of this.clients.values()) {
      if (this.flushed.has(c)) continue;
      const id = this.session.world.players[c.pid]?.save.charId;
      if (id) out.push(id);
    }
    for (const s of this.staleFarewells.values()) if (!s.farewell.saved) out.push(s.charId);
    return out;
  }

  /**
   * ⭐ R14-07: СВОД ЗАПИСЕЙ ЗАБЕГА ЭТОЙ КОМНАТЫ ЕЩЁ НЕ В БАЗЕ — снят и не лёг (упавшая запись вернула его в очередь), в пути или не снят.
   * Слив ноды (`RoomManager.flushAll`) дописывает его кругами, как сейвы: раньше он смотрел только на сейвы, и свод, чья запись на сливе
   * упала (блокировка строки другой нодой, обрыв), ждал повтора по таймеру процесса, который уже выходил. Продолжение забега на другой
   * ноде собирало узлы по неполному своду — сундук, босс и опыт заново.
   */
  ledgerPending(): boolean {
    return this.ledgerOut.size > 0 || this.ledgerDirty.size > 0 || this.ledgerInflight > 0;
  }

  /**
   * Кадр ввода. ⭐ R4-19: НАЖАТИЕ, КОТОРОЕ ТИК ЕЩЁ НЕ ВИДЕЛ, СЛЕДУЮЩИЙ КАДР НЕ СТИРАЕТ. Рывок и тогл уходят только в кадре
   * нажатия, а кадр перезаписывал ввод целиком: пришли два кадра между тиками — рывок пропал (у Unity с 60 Гц — каждый
   * второй). Удар, каст, [E] и пояс, нажатые между тиками, сработают раз; рывок и пояс тик потом снимает сам (`step`).
   */
  setInput(pid: string, input: PlayerInput): void {
    const c = this.clients.get(pid);
    if (!c || this.frozen) return;   // R5-07: заморожена — ввод не применяется
    const prev = c.input;
    let next = input;
    if (!c.inputSeen) {
      next = {
        ...input,
        attack: input.attack || prev.attack,
        interact: input.interact || prev.interact,
        cast: input.cast ?? prev.cast,
        ...(input.dodge || prev.dodge ? { dodge: true } : {}),
        ...((input.useBelt ?? prev.useBelt) !== undefined ? { useBelt: input.useBelt ?? prev.useBelt } : {}),
      };
    }
    c.input = next;
    c.inputSeen = false;
    c.inputAge = 0;
  }

  // ── Команды города ──────────────────────────────────────────────────────────
  /**
   * Команда города от клиента. `raw` и `rawId` — НЕПРОВЕРЕННЫЕ данные из кадра: форму команды
   * проверяет схема (D11) до всякого исполнения, лишний ключ или не тот тип — отказ целиком.
   *
   * ⭐ ОБРАБОТЧИК НЕ БРОСАЕТ НИКОГДА. Любое исключение внутри превращается в отказ с `cmdResult`
   * и считается (`dm_cmd_failed_total`). На каждую обработанную команду клиент получает ровно
   * один `cmdResult` (D3) — после `saveUpdate`, чтобы к ответу у него уже был новый сейв.
   */
  async handleCmd(pid: string, raw: unknown, rawId?: unknown): Promise<void> {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (!c || !p) return;
    // ⭐ R5-07: заморожена сливом — отказ ДО всего (в окно номеров не попадает: повтор после рестарта исполнится честно).
    if (this.frozen) {
      const fid = cmdIdOf(rawId);
      this.send(c.ws, { t: 'cmdResult', ...(typeof fid === 'number' ? { id: fid } : {}), cmd: cmdNameOf(raw), ok: false, reason: FROZEN });
      return;
    }
    let replied = false;
    const answer = (id: number | undefined, cmd: string, out: CmdOutcome): void => {
      replied = true;
      // Только поля протокола: итог действия может нести служебное (`moved` у сдачи сырья и т. п.).
      this.send(c.ws, {
        t: 'cmdResult', ...(id !== undefined ? { id } : {}), cmd, ok: out.ok,
        ...(out.reason !== undefined ? { reason: out.reason } : {}),
        ...(out.uid !== undefined ? { uid: out.uid } : {}),
        ...(out.unlocked !== undefined ? { unlocked: out.unlocked } : {}),
      });
    };
    try {
      // D11: СХЕМА ДО ИСПОЛНЕНИЯ. Номер тоже проверяем: `id: -1` или `"7"` честный клиент не пришлёт.
      const id = cmdIdOf(rawId);
      // R1-11: общий потолок частоты команд на соединение (кузница сверху держит свой, D12). Всплеск — как у
      // потолка кадров: пачка честного клиента его не задевает (очки атрибутов идут ОДНОЙ командой на атрибут
      // с числом, R2-15: по одному очку 195 кадров рвали соединение), а поток отказов
      // больше не умножает исходящий трафик на размер сейва. До окна номеров: отказ по частоте номер не съедает —
      // повтор с тем же номером позже исполнится честно.
      // R4-17: ключ — АККАУНТ, а не вход в комнату: `pid` новый на каждый вход, и «выйти — войти по коду» обнулял лимит.
      // ⭐ R8-09: и ДО СХЕМЫ — кривая команда платит его так же: раньше она отвечалась до него, и поток кривых команд (схема,
      // перечень лишних ключей, чистка сообщения для лога) шёл без предела, кроме потолка кадров соединения.
      if (!limits.townCmd.take(c.userId)) {
        counters.cmdTownRateLimited++;   // R2-25: свой счётчик — поток команд не выглядит злоупотреблением кузницей
        const out: CmdOutcome = { ok: false, reason: 'Слишком часто' };
        this.send(c.ws, { t: 'error', code: 'cmd', msg: out.reason! });
        answer(id ?? undefined, cmdNameOf(raw), out);
        return;
      }
      const parsed = parseTownCommand(raw);
      if (!parsed.ok || id === null) {
        counters.cmdInvalid++;
        // R1-10: номер — ЧУЖОЕ значение: `String()` на `{"toString":1}` бросает, и невалидная команда
        // превращалась в «ошибку сервера» с немым стеком в логе на каждый кадр.
        this.warnInvalid(c, p.save.charId, cmdNameOf(raw), parsed.ok ? `номер команды ${describeUntrusted(rawId).slice(0, 32)}` : parsed.error);
        const out: CmdOutcome = { ok: false, reason: 'Неверная команда' };
        this.send(c.ws, { t: 'error', code: 'cmd', msg: out.reason! });
        answer(id ?? undefined, cmdNameOf(raw), out);
        return;
      }
      const command = parsed.command;

      // Ф2.5: повтор уже выполненной команды. Не исполняем, но сейв и ИТОГ оригинала дошлём —
      // повтор случается как раз тогда, когда клиент не уверен, что дошло, и ему нужен ответ.
      if (!c.dedup.accept(id)) {
        counters.cmdDuplicate++;
        this.resync(pid);
        answer(id, command.cmd, c.dedup.outcome(id) ?? { ok: false, reason: 'Команда уже получена' });
        return;
      }

      let run: RunOutcome;
      try {
        run = await this.runCmd(c, pid, command);
      } catch (e) {
        counters.cmdFailed++;
        console.error(`[room ${this.code}] команда «${command.cmd}» игрока ${p.save.charId} упала:`, e);
        run = { ok: false, reason: 'Ошибка сервера, попробуйте ещё раз' };
      }
      const { early, ...out } = run;
      c.dedup.settle(id, out);
      if (!out.ok) {
        this.send(c.ws, { t: 'error', code: 'cmd', msg: out.reason ?? '' });
        // R1-11: отказ ДО исполнения сейв не трогал — слать нечего. Отказ ядра — сейв шлём: клиент мог
        // подвинуть вещь у себя заранее и обязан вернуться к правде; но в меру, а не на каждый из сотни.
        if (!early) this.resync(pid);
      } else {
        // Ф1.1: успешная команда города могла сменить экипировку/уровень/максимум HP — значит
        // статика устарела. Уходит только ИЗМЕНИВШАЯСЯ (R1-11): пустая команда пати не будит.
        this.broadcastPeerInfo();
        if (PEAK_CMDS.has(command.cmd)) this.notePeak(p.save);   // R8-04: надел (улучшил надетое) — забег это помнит
        this.sendSave(pid);
      }
      answer(id, command.cmd, out);
    } catch (e) {
      // Сюда доходит только сбой вокруг исполнения (рассылка, сериализация) — команда уже учтена.
      counters.cmdFailed++;
      console.error(`[room ${this.code}] обработка команды игрока ${p.save.charId} упала:`, e);
      if (!replied) {
        try { answer(undefined, cmdNameOf(raw), { ok: false, reason: 'Ошибка сервера, попробуйте ещё раз' }); } catch { /* сокет уже мёртв */ }
      }
    }
  }

  /** Шум о невалидной команде — через общий глушитель `warnClient`. */
  private warnInvalid(c: Client, charId: string, cmd: string, why: string): void {
    // Имя команды и текст ошибки несут ЧУЖИЕ строки (ключи из кадра): управляющие символы вырезаем,
    // иначе перевод строки в имени ключа подделал бы в логе целую запись. R2-26: и юникодные тоже — переводы
    // строки U+2028/U+2029/U+0085 (C1 входит в Cc) и символы формата (разворот текста U+202E и прочие Cf).
    // ⭐ R8-09: сперва обрезать, потом чистить — сообщение схемы перечисляет все лишние ключи кадра, и регулярка шла по всему.
    const clean = (s: string): string => s.slice(0, 200).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
    this.warnClient(c, `невалидная команда «${clean(cmd)}» от ${charId}: ${clean(why)}`);
  }

  /**
   * Шум в лог о командах игрока — не чаще раза в `INVALID_WARN_MS` на игрока, с числом промолчанных (D11).
   * R1-10: сюда же — команды не из того места: они тоже присылаются потоком, и лог топили так же.
   */
  private warnClient(c: Client, text: string): void {
    const now = Date.now();
    if (now - c.invalidWarnAt < INVALID_WARN_MS) { c.invalidMuted++; return; }
    const muted = c.invalidMuted ? ` (и ещё ${c.invalidMuted} с прошлого сообщения)` : '';
    c.invalidWarnAt = now; c.invalidMuted = 0;
    console.warn(`[room ${this.code}] ${text}${muted}`);
  }

  /**
   * Сейв клиенту после отказа или повтора (R1-11) — не чаще лимита `cmdResync`. Отказ сейв не меняет; сейв
   * нужен лишь клиенту, который успел поменять что-то у себя заранее. Поток отказов раньше получал полный сейв
   * на каждый кадр (в 260 раз больше, чем присылал).
   */
  private resync(pid: string): void {
    const c = this.clients.get(pid);
    if (c && limits.cmdResync.take(c.userId)) this.sendSave(pid);   // R4-17: по аккаунту, как и лимит команд
  }

  /**
   * Проверки места и частоты, затем исполнение. Отказ здесь — обычный итог, не исключение.
   * Команды без своей транзакции (`TRANSACTED_CMDS`) и не трогающие мир (`WORLD_CMDS`)
   * при исключении откатывают сейв к снимку: половина действия хуже, чем никакого.
   */
  private async runCmd(c: Client, pid: string, command: TownCommand): Promise<RunOutcome> {
    const save = this.session.world.players[pid]!.save;

    // Ф3.1: городская команда, присланная не из города. Честный клиент такого не шлёт —
    // лавка, кузница и сундук открываются только подходом к объекту города.
    if (!cmdAllowedIn(command.cmd, this.area)) {
      counters.cmdOutOfPlace++;
      this.warnClient(c, `команда «${command.cmd}» вне города (область ${this.area}), игрок ${save.charId}`);
      return { ok: false, reason: 'Это доступно только в городе', early: true };
    }
    // D12: тяжёлые команды кузницы — не чаще лимита. Токен списывается за ПОПЫТКУ, а не за
    // успех: иначе перебор несуществующих uid был бы бесплатным.
    if (FORGE_RATE_CMDS.has(command.cmd) && !limits.forgeCmd.take(c.userId)) {   // R4-17: по аккаунту
      counters.cmdRateLimited++;
      return { ok: false, reason: 'Слишком часто', early: true };
    }
    // ⭐ R12-13: и чтение сундука аккаунта — своим потолком: отказ и «открыть» платили полное чтение из базы, как успех.
    // ⭐ R14-13: и свой счётчик — перекладка у сундука не должна выглядеть злоупотреблением кузницей (R2-25).
    if (STASH_READ_CMDS.has(command.cmd) && !limits.stashRead.take(c.userId)) {
      counters.cmdStashRateLimited++;
      return { ok: false, reason: 'Слишком часто', early: true };
    }

    c.tm.action();   // Ф3.2: команда — намеренное действие, её ритм тоже о многом говорит

    const snap = TRANSACTED_CMDS.has(command.cmd) || WORLD_CMDS.has(command.cmd) ? null : JSON.stringify(save);
    try {
      return await this.dispatch(c, pid, save, command);
    } catch (e) {
      if (snap !== null) rollbackCmd(save, snap);   // R8-01: сток и забег — не команды, их не откатываем
      throw e;
    }
  }

  /** Само исполнение команды. Схема уже проверена — аргументы нужных типов и длин. */
  private async dispatch(c: Client, pid: string, save: SaveState, command: TownCommand): Promise<CmdOutcome> {
    switch (command.cmd) {
      case 'buy': {
        // ⭐ R6-16: `maxGold` — цена кадра лавки, которую видел игрок: дороже ядро не берёт. Отказ «цена изменилась» — кадр
        // лавки заново, с ценами СВОЕГО конфига: иначе клиент так и просил бы по старой (кадр шлётся на входе и после покупки).
        // ⭐ R10-06: только ЗОВУЩЕМУ и в меру пересылок после отказа (`cmdResync`, как сейв, R1-11) — прилавок не менялся. Раньше
        // кадр прилавка (десятки КБ) уходил всей комнате на каждый отказ: `buy{maxGold:0}` без золота отказывает всегда, и 92 байта
        // команды оборачивались кадром в ~27 КБ каждому в пати, 10 раз в секунду, — до разрыва медленного канала соседа.
        const refreshed = (r: CmdOutcome): CmdOutcome => {
          if (!r.ok && r.reason?.startsWith(PRICE_CHANGED) && limits.cmdResync.take(c.userId)) this.send(c.ws, this.shopFrame());
          return r;
        };
        // R2-04: зелья лавки — свои у комнаты (не сток героя): купленное уходит только отсюда.
        const potion = this.consumables.find((i) => i.uid === command.uid);
        if (potion) {
          // ⭐ R11-13: базу выключили в редакторе, пока прилавок стоит (правка живьём), — с прилавка долой, не продаётся.
          const on = shopConsumableIds(this.cfg);
          if (!on.includes(potion.baseId)) {
            this.consumables = this.consumables.filter((i) => on.includes(i.baseId));
            this.showShop();
            return refreshed({ ok: false, reason: 'нет в ассортименте' });
          }
          const r = buyItem(this.cfg, save, potion, command.maxGold);
          if (r.ok) { this.consumables = this.consumables.filter((i) => i !== potion); this.showShop(); }
          return refreshed(r);
        }
        const found = this.shop.find((i) => i.uid === command.uid);
        // ⭐ R7-18: поколение стока сменилось (срок вышел, хозяин вырос или скатал новый в другой комнате) — сперва новый прилавок.
        if (found && this.stock?.shop.includes(found) && this.stockStale()) {
          this.restock();
          this.showShop();
          this.broadcastQuestBoard();
          return { ok: false, reason: STOCK_RENEWED };
        }
        // ⭐ R14-09: базу вещи выключили в редакторе, пока сток стоит (правка живьём, как у зелий — R11-13), — не продаётся, и с прилавка
        // долой. Сток катается с проверкой включённости (`rollGear`), но живёт до срока (10 минут) — и хотфикс сломанной базы продавал её.
        if (found && !this.gearOn()(found)) {
          this.showShop();
          return refreshed({ ok: false, reason: 'нет в ассортименте' });
        }
        // R1-03: истина — сток героя. Его же могла показывать и другая комната (хозяин ушёл, в старой остался
        // сосед), и там вещь уже купили: одна и та же вещь (тот же uid) не продаётся дважды.
        const stock = this.stock;
        const item = found && (!stock || stock.shop.includes(found)) ? found : undefined;
        if (found && !item) this.showShop();
        const r = item ? buyItem(this.cfg, save, item, command.maxGold) : { ok: false, reason: 'нет в ассортименте' };
        if (r.ok) {
          if (stock) {
            stock.shop = stock.shop.filter((i) => i.uid !== command.uid);   // вышел-зашёл — не вернётся
            this.noteBought(stock, item!);                                  // R5-22: и на другой ноде — тоже
          }
          this.showShop();
        }
        return refreshed(r);
      }
      // R6-16: `minGold` — «+N» подписи: лавка даёт меньше — отказ до продажи (клиент по причине перечитает конфиг).
      case 'sell': return sellItem(this.cfg, save, command.uid, command.minGold);
      // ⚠ Улучшение и починка ТРАТЯТ сырьё, а оно в сундуке аккаунта — значит сейв и сундук пишутся
      // ОДНОЙ транзакцией, а при неудаче записи откатывается всё в памяти (`withAccount`).
      // `subject` — вещь действия: её событие журнал вещей подпишет причиной действия, прочее — автосейвом (R2-21).
      // ⭐ R5-15: `maxGold` — цена, которую видел игрок: выше неё ядро не берёт (`priceRaised`, отказ до траты). R8-14: и
      // `maxMaterials` — сырьё карточки (`materialsRaised`); у разборов — `minYield`, низ вилки выхода (`yieldDropped`), и R9-04
      // `avgYield` — средний выход карточки: низ дробной доли — 0 при любой правке.
      case 'forgeUpgrade': return this.withAccount(c, pid, 'forge', (st) => forgeUpgrade(this.cfg, save, command.uid, walletOf(st), command.maxGold, command.maxMaterials), { subject: command.uid });
      case 'forgeRepair': return this.withAccount(c, pid, 'forge', (st) => forgeRepair(this.cfg, save, command.uid, walletOf(st), command.maxGold, command.maxMaterials), { subject: command.uid });
      case 'depositMaterials': return this.withAccount(c, pid, 'stash', (st) => depositMaterials(save, walletOf(st)));
      // Перекатка трогает только сейв, но пишется сразу и со своей причиной (D9):
      // иначе журнал вещей записал бы её «автосейвом».
      case 'forgeReroll': return this.withSave(c, pid, 'forge', () => forgeReroll(this.cfg, save, command.uid, townRng(), command.maxGold), command.uid);
      // D6: разбор у кузнеца пишет журнал аккаунта и доливает не влезшее в сумку сырьё в сундук —
      // значит сейв и сундук одной транзакцией. Скованное переплавляется — в журнале вещей это `melt` (D9).
      case 'forgeSalvage': return this.withAccount(c, pid, salvageReason(save, command.uid), (st) => forgeSalvage(this.cfg, save, st, command.uid, townRng(), command.minYield, command.avgYield), { subject: command.uid });
      // Разбор на месте разрешён где угодно (`guard` не держит его в городе): смысл в том и есть —
      // переработать трофей, не возвращаясь. В городе им пользоваться незачем, кузница выгоднее.
      case 'salvage': return this.salvageInField(c, pid, save, command.uid, command.minYield, command.avgYield);
      // ⭐ КОВКА (D4). Сырьё — из сумки, недостающее — из кошелька сундука; золото — из сейва; вещь, списание,
      // журнал и ключ заявки уходят в базу ОДНОЙ транзакцией. Все отказы ядро делает до траты.
      case 'craft': {
        if (!this.cfg.get('balance').craft.live) return { ok: false, reason: CRAFT_CLOSED };
        const { nonce, input, maxGold, maxMaterials } = command;
        return this.withAccount(c, pid, 'craft', (st): TxOutcome => {
          // Повтор ключа (обрыв связи, реконнект, другая нода): вещь уже скована и записана той самой
          // транзакцией — отвечаем её uid и НЕ пишем ничего. Лишняя запись здесь только подписала бы
          // «ковкой» то, что сейв успел набрать с прошлой записи, и зря подняла бы версию сундука.
          const seen = normalizeCraftNonces(st.craftNonces).find((e) => e.n === nonce);
          if (seen) return { ok: true, uid: seen.uid, unchanged: true };
          return craftAction(this.cfg, save, st, nonce, input, townRng(), { fullJournal: craftFullJournal(), maxGold, maxMaterials });
        });
      }
      // D5: зачарование — только золото, но через транзакцию аккаунта, как вся кузница: при неудачной
      // записи вещь и золото откатываются в памяти, а журнал вещей видит причину `enchant`.
      case 'forgeEnchant': {
        if (!this.cfg.get('balance').craft.live) return { ok: false, reason: CRAFT_CLOSED };
        return this.withAccount(c, pid, 'enchant', () => enchantAction(this.cfg, save, command.uid, command.rarity, townRng(), command.maxGold), { subject: command.uid });
      }
      // ⭐ R3-11: эскиз (жалость разбора) открывает выбранную деталь в журнале аккаунта. Журнал — в сундуке, поэтому
      // транзакция сундука, как вся кузница; отказы ядра — до изменения. От `craft.live` не зависит: эскизы копит
      // разбор, который работает и при закрытой ковке, — потратить их на детали впрок можно и тогда.
      case 'forgeSketch': return this.withAccount(c, pid, 'craft', (st) => sketchAction(this.cfg, st, command.variantId));
      case 'equip': return equip(this.cfg, save, command.uid, command.slot);   // R11-02: цель — вторая рука (дуал-вилд)
      case 'unequip': return unequip(this.cfg, save, command.slot);
      case 'allocAttr': return allocAttr(save, command.attr, command.n);   // R2-15: пачка очков — одна команда
      case 'respec': return respec(this.cfg, save, command.maxGold);
      case 'respecPassives': return respecPassives(this.cfg, save, command.maxGold);
      case 'respecSkills': return respecSkills(this.cfg, save, command.maxGold);
      case 'allocPassive': return allocPassive(this.cfg, save, command.nodeId, command.maxGold);   // R6-16: «след. ранг: N зол.»
      case 'allocSkill': return allocActive(this.cfg, save, command.nodeId);
      case 'socketInsert': return socketInsert(this.cfg, save, command.nodeId, command.slot, command.insertId);
      case 'socketClear': return socketClear(this.cfg, save, command.nodeId, command.slot);
      case 'moveBelt': return moveToBelt(save, command.uid);
      case 'moveItem': return moveInventoryItem(this.cfg, save, command.uid, command.x, command.y);
      case 'stashOpen': await this.sendStash(pid); return { ok: true };
      // Ф0.4: сейв и сундук пишутся ОДНОЙ транзакцией. Раньше сундук уходил в базу сразу, а
      // инвентарь — только следующим автосейвом (до 10 с): падение в этом окне давало предмет
      // и там, и там. Если транзакция не прошла — перенос откатывается и в памяти.
      case 'stashMove': return this.withAccount(c, pid, 'stash', (st) => stashMove(this.cfg, save, st, command.uid, command.dst, command.x, command.y), { subject: command.uid });
      case 'bind': return setBinding(this.cfg, save, command.slot, command.value);
      // ⭐ R14-05: мёртвый не бросает (`dropToGround`) — отказ своим словом, как зелье мёртвому.
      case 'drop': {
        if (this.session.world.players[pid]?.alive === false) return { ok: false, reason: 'Мёртвые не бросают' };
        const thrown = this.session.dropToGround(pid, command.uid);
        if (!thrown) return { ok: false, reason: 'Нет предмета' };
        this.holdThrown(c, pid, thrown);   // ⭐ V-B2-04: чужой руке — после записи выбросившего без неё
        return { ok: true };
      }
      case 'useConsumable': return this.useConsumable(pid, command.uid);
      case 'pickup': {
        // ⭐ R2-02: выброшенное игроком ДРУГОГО аккаунта не поднять. Торговли между аккаунтами нет, и леджер такую
        // вещь не пустит: каждая следующая запись подобравшего падала бы на ней. Добыча с монстров — общая.
        const drop = this.session.world.drops.find((d) => d.id === command.dropId);
        if (drop?.owner !== undefined && drop.owner !== c.userId) {
          return { ok: false, reason: 'Это выбросил игрок другого аккаунта — передавать вещи между аккаунтами нельзя' };
        }
        // ⭐ V-B2-04: выброшенное соседом по аккаунту, чья строка в базе вещь ещё держит, — сперва его запись без неё (она уже в очереди,
        // `holdThrown`): поднятое раньше легло бы в строку поднявшего, пока лежит и в строке выбросившего, — падение процесса раздало бы его обоим.
        if (drop?.heldBy !== undefined && drop.heldBy !== save.charId) {
          await this.heldSettled(drop.heldBy);
          if (this.clients.get(pid) !== c) return { ok: false, reason: 'Нет персонажа' };
          if (this.frozen) return { ok: false, reason: FROZEN };
          if (drop.heldBy !== undefined) return { ok: false, reason: HELD_DROP };
        }
        const got = this.session.pickupDropById(pid, command.dropId);
        if (got?.item) this.broadcast({ t: 'events', events: [{ type: 'item-picked', playerId: pid, item: got.item, x: got.x, y: got.y }] });
        return got ? { ok: true } : { ok: false, reason: 'Далеко или инвентарь полон' };
      }
      case 'acceptQuest': {
        const windowMs = Math.max(0, this.cfg.get('balance').townRestockSec) * 1000;
        // ⭐ R5-19: ДОСКА ПЕРЕЖИЛА СВОЙ СРОК (катается она на заходе в город, а герой из города не выходил) — сперва новая
        // доска, взять — с неё. Раньше принятое со старой доски писало поколением «сейчас» (`boardTime`), и следующая,
        // честно скатанная доска отказывала в том же шаблоне весь свой срок. Теперь в квоте только настоящие поколения.
        if (this.stock && windowMs > 0 && Date.now() - this.stock.at >= windowMs) {
          this.restock();
          this.showShop();
          this.broadcastQuestBoard();
          return { ok: false, reason: BOARD_RENEWED };
        }
        const found = this.questBoard.find((q) => q.id === command.questId);
        // R1-03: как у прилавка — истина в стоке героя; принятое в другой комнате с той же доски не берётся дважды.
        const stock = this.stock;
        const def = found && (!stock || stock.board.includes(found)) ? found : undefined;
        if (found && !def && stock) { this.questBoard = stock.board; this.broadcastQuestBoard(); }
        // R3-10: одно задание шаблона за срок доски — по сейву берущего, а не по доске: доски альтов его не множат.
        // R4-33: срок — между поколениями досок (`stock.at`), а не от принятия: честно обновлённая доска даёт сразу.
        const quota = { now: Date.now(), windowMs, boardAt: stock?.at };
        // R6-13: начатое задание того же вида вытесняется только с согласия игрока (`replace` — клиент спросил).
        const r = def ? acceptQuest(save, def, quota, command.replace === true) : { ok: false, reason: 'Нет на доске' };
        if (r.ok && def) {
          if (stock) this.questBoard = stock.board = stock.board.filter((q) => q.id !== def.id);   // вышел-зашёл — не вернётся
          else this.questBoard = this.questBoard.filter((q) => q.id !== def.id);
          this.broadcastQuestBoard();
          this.questEvent(pid, 'accepted', def.id, def.name);
        }
        return r;
      }
      case 'turnInQuest': {
        const name = save.activeQuestDefs.find((d) => d.id === command.questId)?.name ?? command.questId;
        const r = turnInQuest(this.cfg, save, command.questId);
        if (r.ok) this.questEvent(pid, 'turned-in', command.questId, name);
        return r;
      }
      default: {
        // Схема пропускает только известные команды; сюда можно попасть, лишь забыв ветку.
        const never: never = command;
        return { ok: false, reason: `неизвестная команда ${String((never as { cmd?: unknown }).cmd)}` };
      }
    }
  }

  /**
   * Пьёт зелье из инвентаря/пояса: применяет к сущности игрока, расходует из сейва. ⭐ R4-35: по тем же правилам, что пояс
   * ввода (`useBeltSlot`): мёртвые и оглушённые не пьют, а зелье без эффекта (полное здоровье) не тратится. Раньше команда
   * лечила сквозь стан и съедала зелье впустую. ⭐ C-14: эффект — `session.drink`, тот же, что у пояса: мана — до потолка ауры
   * (у зарезервированного потолка зелье маны «без эффекта»), а не до полного пула.
   */
  private useConsumable(pid: string, uid: string): { ok: boolean; reason?: string } {
    const p = this.session.world.players[pid];
    if (!p || !this.session.snapshotOf(pid)) return { ok: false, reason: 'нет игрока' };
    if (!p.alive) return { ok: false, reason: 'Мёртвые не пьют' };
    if (p.stunTimer > 0) return { ok: false, reason: 'Оглушён' };
    const inBelt = p.save.belt.findIndex((it) => it?.uid === uid);
    const item = inBelt >= 0 ? p.save.belt[inBelt] : p.save.inventory.find((it) => it.uid === uid);
    if (!item?.use) return { ok: false, reason: 'не расходник' };
    if (!this.session.drink(pid, item.use)) return { ok: false, reason: 'Нет эффекта' }; // единый эффект (пояс ввода — тот же)
    // расход
    if (inBelt >= 0) p.save.belt[inBelt] = null;
    else { const i = p.save.inventory.findIndex((it) => it.uid === uid); if (i >= 0) p.save.inventory.splice(i, 1); }
    return { ok: true };
  }

  // ── Голосование за спуск ────────────────────────────────────────────────────
  // Из города: старт/резюм забега (можно выбрать сложность-тир). В подземелье: спуск по РЕБРУ
  // графа (targetNodeId — выбор ветки на развилке); на финале (нет рёбер) — завершение забега.
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: AltarConfig): void {
    if (this.refuseFrozen(pid) || this.votePending(pid) || !this.voteAllowed(pid)) return;
    if (this.area === 'town') {
      // R4-25: зовущий сам переписал бы свой припаркованный забег чужим — отказ до голосования.
      if (this.runClash(pid, false)) { this.tellBlocked(pid, 'run'); return; }
      // ⭐ V2: продолжение забега, который идёт в другой комнате, — тоже (окончательная сверка — перед входом, `resumeFromLedger`).
      const held = this.parkedRunBusy();
      if (held) { this.tellRunElsewhere(pid, held); return; }
      const diffId = this.validDifficulty(pid, difficultyId);
      // ⭐ R9-08: окно голосования говорит, что начнётся (тир, шаблон, биом, модификаторы, продолжение чьего забега).
      this.vote = { kind: 'descend', by: pid, diffId, runCfg: runConfig, plan: this.descendPlan(diffId, runConfig), yes: new Set([pid]), no: new Set() };
      this.broadcast(this.voteStartFrame(this.vote));
    } else {
      const node = this.currentNode();
      if (!node) return;
      // ⭐ R14-02: ПАТИ БЕЗ ЖИВЫХ ПОДКЛЮЧЁННЫХ ВПЕРЁД НЕ ИДЁТ. Мёртвый может звать спуск (его «за» ждёт согласия живых, R5-04), но живых нет —
      // и голос проходил сразу: труп у выхода, напарник закрыл вкладку при 1 HP — спуск хоронил только сбежавшего (R6-01), а мёртвого
      // `enterFloor` оживлял на новом узле полным (с финала — завершение забега): «штраф одной смерти, забег цел» вместо вайпа (R13-02).
      // Уход такой пати — в город (`return` мёртвого, R13-02) или возвратом застрявших по сроку (`checkStranded`).
      if (this.stranded()) { this.tellFar(pid, DEAD_PARTY); return; }
      // ⭐ R3-01: СПУСК — ОТ ВЫХОДА, ЗАВЕРШЕНИЕ — ОТ ПОРТАЛА ФИНАЛА. Раньше проверялись только голосование и пауза, и
      // модифицированный клиент спускался прямо с точки входа через полторы секунды после каждого этажа: двадцать этажей
      // за полминуты, ни одного рычага и двери, а `enterNode` писал прогресс сложности — тиры открывались без единого
      // пройденного этажа, квесты «достичь этажа» закрывались, глубокие сундуки сыпали добычу. Рядом с выходом должен
      // стоять тот, кто зовёт; остальные голосуют откуда угодно, если на них не идёт монстр (R5-04, `canDescend`), а
      // завершение финала — только у портала или мёртвыми (R5-04, как уход в город).
      const near = (at: { x: number; y: number } | undefined): boolean => this.stands(pid, at);
      if (node.edges.length === 0) {
        // Финал — «завершить забег» (портал в город).
        if (!this.decor.some((d) => d.kind === 'portal' && near(d))) { this.tellFar(pid, FAR_PORTAL); return; }
        this.vote = { kind: 'descend', by: pid, finish: true, yes: new Set([pid]), no: new Set() };
        this.broadcast(this.voteStartFrame(this.vote));
      } else {
        // Выход i ведёт по ребру i (контракт генератора: выходов столько же, сколько рёбер). Ветку выбрал — стоять у её
        // выхода; не выбрал (или прислал не ребро) — ребро того выхода, у которого стоит.
        const exits = this.session.world.exits ?? [];
        const chosen = targetNodeId ? node.edges.findIndex((e) => e.to === targetNodeId) : -1;
        const idx = chosen >= 0 ? (near(exits[chosen]) ? chosen : -1) : exits.findIndex((e, i) => i < node.edges.length && near(e));
        if (idx < 0) { this.tellFar(pid, FAR_EXIT); return; }
        const target = node.edges[idx]!.to;
        if (this.runClash(pid, false)) { this.tellBlocked(pid, 'run'); return; }   // R4-25
        const tnode = this.runPlan!.nodes.find((n) => n.id === target);
        this.vote = { kind: 'descend', by: pid, targetNodeId: target, targetNodeType: tnode?.type, yes: new Set([pid]), no: new Set() };
        this.broadcast(this.voteStartFrame(this.vote));
      }
    }
    this.broadcast({ t: 'voteUpdate', yes: 1, total: this.clients.size });
    this.checkVote();
  }
  /** Кадр начала голосования — тем, кто в комнате, и вошедшему посреди него (R8-08). */
  private voteStartFrame(v: NonNullable<Room['vote']>): Extract<ServerFrame, { t: 'voteStart' }> {
    const p = v.plan;
    return {
      t: 'voteStart', kind: v.kind, by: v.by, needed: this.clients.size,
      ...(v.targetNodeId !== undefined ? { targetNodeId: v.targetNodeId } : {}),
      ...(v.targetNodeType !== undefined ? { targetNodeType: v.targetNodeType } : {}),
      ...(p ? { difficultyId: p.difficultyId, templateId: p.templateId, biomeId: p.biomeId, modifiers: [...p.modifiers] } : {}),
      ...(p?.resume ? { resume: { host: p.resume.name, depth: p.resume.depth } } : {}),
    };
  }
  /**
   * ⭐ R9-08: что начнёт спуск из города сейчас: продолжение забега первого, у кого он припаркован (R4-25, как `checkVote`), —
   * с самого глубокого указателя этого забега в комнате (как `resumeRun`); иначе — новый забег в тире `diffId` по выбору алтаря.
   */
  private descendPlan(diffId: string | undefined, alt: AltarConfig | undefined): DescendPlan {
    const host = this.parkedHost();
    const run = host?.run;
    if (host && run?.config) {
      let depth = nodeDepthOf(run.currentNodeId);
      for (const c of this.clients.values()) {
        const r = this.session.world.players[c.pid]?.save.run;
        if (r?.config && sameRun(r.config, run.config)) depth = Math.max(depth, nodeDepthOf(r.currentNodeId));
      }
      const c = run.config;
      return {
        difficultyId: c.tier, templateId: c.templateId, biomeId: c.biomeId, modifiers: Array.isArray(c.modifiers) ? [...c.modifiers] : [],
        resume: { charId: host.charId, name: host.name, depth },
      };
    }
    return { difficultyId: diffId ?? this.difficultyId, ...this.altarOf(alt) };
  }
  /**
   * ⭐ R8-08: голосование уже идёт — новый переход не начинается, а зовущему, кто ещё не ответил, — кадр `error` с кодом `vote`.
   * Раньше отказ был молчаливым: вошедший посреди голосования окна не видел (оно шлётся только на старте), а его портал, выход и
   * арена «не нажимались» без объяснений. Зовущий повторно (его «за» уже учтено) — без шума.
   */
  private votePending(pid: string): boolean {
    const v = this.vote;
    if (!v) return false;
    const c = this.clients.get(pid);
    if (c && !v.yes.has(pid)) this.send(c.ws, { t: 'error', code: 'vote', msg: VOTE_PENDING });
    return true;
  }
  /** Текущий узел забега (по runNodeId в runPlan). */
  private currentNode() {
    return this.runPlan && this.runNodeId ? this.runPlan.nodes.find((n) => n.id === this.runNodeId) : undefined;
  }
  /**
   * Стоит ли игрок у точки перехода (выход, портал) — с запасом `EXIT_REACH_PX` на отставание позиции сервера от
   * предсказанной клиентом (R3-01).
   * ⭐ R10-01: И СО СВОЕЙ СТОРОНЫ СТЕНЫ — точку видно (сетка стен и закрытых дверей, как `GameSession.within`, R6-26), и дойти до
   * неё — пара шагов (`EXIT_REACH_STEPS`). Два тайла длиннее стены в клетку: в лабиринте архива выход (портал финала на боссе,
   * точку входа) звали из соседнего коридора сквозь стену — спуск, «забег пройден» с живым боссом, уход в город, — срезая
   * десятки клеток, а то и весь этаж. Путь — вторая мера: видимость по клеткам проходит и сквозь диагональный шов (R10-02),
   * а шаги по сетке — нет. Декор взгляд здесь не закрывает: этаж на стороны он не делит, а у выхода и входа его не ставят.
   */
  private stands(pid: string, at: { x: number; y: number } | undefined): boolean {
    const pos = this.session.world.players[pid]?.pos;
    if (!pos || !at || Math.hypot(at.x - pos.x, at.y - pos.y) > EXIT_REACH_PX) return false;
    const w = this.session.world;
    if (!hasLineOfSight(w.grid, pos.x, pos.y, at.x, at.y)) return false;
    const from = worldToCell(pos.x, pos.y), to = worldToCell(at.x, at.y);
    if (from.cx === to.cx && from.cy === to.cy) return true;
    const path = findPath(w.grid, pos, at, EXIT_REACH_SEARCH);
    return path.length > 0 && path.length <= EXIT_REACH_STEPS;
  }
  /** Отказ перехода издалека — инициатору кадр `error` с кодом `far` (честный клиент видит подсказку, а не молчание). */
  private tellFar(pid: string, msg: string): void {
    const c = this.clients.get(pid);
    if (c) this.send(c.ws, { t: 'error', code: 'far', msg });
  }
  /**
   * R4-14: может ли игрок уйти из подземелья в город — мёртв или стоит у точки входа (портал возврата) или у портала узла.
   * Ровно там, где уход предлагает клиент.
   */
  private canLeave(pid: string): boolean {
    const p = this.session.world.players[pid];
    if (!p) return false;
    if (!p.alive) return true;
    return this.stands(pid, this.session.world.spawn) || this.decor.some((d) => d.kind === 'portal' && this.stands(pid, d));
  }
  /**
   * ⭐ R4-25: спуск переписал бы ЧУЖОЙ припаркованный забег этого игрока. Из города продолжается забег первого, у кого он
   * припаркован (хозяина, если есть у него), — у остальных он обязан быть тем же или никаким; в подземелье — забег комнаты.
   * Завершение финала чужого забега не трогает (`endRun` снимает только забег комнаты). `finish` — это оно.
   */
  private runClash(pid: string, finish: boolean): boolean {
    const run = this.session.world.players[pid]?.save.run;
    if (!run?.config || finish) return false;
    const target = this.area === 'town' ? this.parkedHost()?.run?.config : this.runConfig ?? undefined;
    return !!target && !sameRun(run.config, target);
  }
  /** Первый (по входу) в комнате, у кого припаркован забег, — его забег продолжит спуск из города (R4-25). */
  private parkedHost(): SaveState | undefined {
    for (const pid of this.clients.keys()) { const s = this.session.world.players[pid]?.save; if (s?.run?.config) return s; }
    return undefined;
  }
  /**
   * ⭐ R5-04: может ли игрок спуститься с этажа голосом «за»: мёртв, стоит у выхода — или на него сейчас никто не идёт
   * (`inDanger`). Спуск уносит всю пати на следующий этаж, и «за» из гущи боя с 1 HP было бегством от смерти без штрафа.
   * Вне опасности голосуют откуда угодно — как и прежде: ждать всех у выхода незачем.
   */
  private canDescend(pid: string): boolean {
    const p = this.session.world.players[pid];
    if (!p) return false;
    if (!p.alive || !this.inDanger(p)) return true;
    return (this.session.world.exits ?? []).some((e) => this.stands(pid, e));
  }
  /**
   * ⭐ R4-14, R5-11: ГЕРОЙ В ОПАСНОСТИ — его ЦЕЛИТ живой монстр (гонится или замахивается; цель монстра — ближайший живой
   * игрок, ровно как в `GameSession`), или его жжёт урон по времени. Раньше мерой был `combatTimer` — окно боевого айдла
   * (`combatLingerSec`, 15 с), которое ставит и СВОЙ замах героя: добил последнего монстра, собрал добычу, спокойно закрыл
   * вкладку — и пати, ушедшая в город, хоронила его со штрафом как сбежавшего из боя.
   * ⭐ R7-08: угроза — настоящая: монстр до героя дойдёт (`reaches`), урон по времени его добьёт (`burning`). Та же мера и у
   * голоса за спуск (`canDescend`).
   */
  private inDanger(p: PlayerEntity): boolean {
    const w = this.session.world;
    if (burning(p, w.timeMs)) return true;
    const alive = Object.values(w.players).filter((o) => o.alive);
    for (const m of w.monsters) {
      if (!m.alive || (m.aiState !== 'chase' && !m.windup)) continue;
      let best: PlayerEntity | undefined;
      let bestD = Infinity;
      for (const o of alive) {
        const d = Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best === p && this.reaches(m.pos, p.pos)) return true;
    }
    return false;
  }
  /**
   * ⭐ R7-08: монстр ДОЙДЁТ до героя — видит его (та же видимость, что у монстра) или есть путь по сетке, где закрытая дверь —
   * стена (путь монстра строит тот же поиск, `navChase`). Слух стен не спрашивает: монстр за запертой рычагом дверью «гнался»
   * за ближайшим героем сквозь стену, и спокойно вышедший считался сбежавшим из боя.
   */
  private reaches(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
    const w = this.session.world;
    return hasLineOfSight(w.grid, from.x, from.y, to.x, to.y, w.obstacles) || findPath(w.grid, from, to).length > 0;
  }
  /** Почему голос «за» этого игрока сейчас не засчитывается (R4-14, R4-25, R5-04); `null` — засчитывается. */
  private voteBlock(v: NonNullable<Room['vote']>, pid: string): 'far' | 'fight' | 'run' | null {
    // R5-04: завершение финала — тот же уход в город, что и голос «в город» (R4-14): только у портала или мёртвым.
    if ((v.kind === 'town' || (v.kind === 'descend' && v.finish)) && this.area === 'dungeon' && !this.canLeave(pid)) return 'far';
    if (v.kind === 'descend' && !v.finish && this.area === 'dungeon' && !this.canDescend(pid)) return 'fight';
    if (v.kind === 'descend' && this.runClash(pid, !!v.finish)) return 'run';
    return null;
  }
  /**
   * Отказ голосу или переходу — игроку кадр `error` (`far` — подойти к порталу; R5-04: и «выйти из боя» тем же кодом —
   * клиент показывает текст; `run` — чужой забег под перезаписью).
   */
  private tellBlocked(pid: string, why: 'far' | 'fight' | 'run'): void {
    if (why === 'far') { this.tellFar(pid, FAR_PORTAL); return; }
    if (why === 'fight') { this.tellFar(pid, FAR_FIGHT); return; }
    const c = this.clients.get(pid);
    if (c) this.send(c.ws, { t: 'error', code: 'run', msg: RUN_CLASH });
  }
  /** Игрок дёрнул рычаг: сессия открывает его дверь (если рядом) → броадкаст всем. */
  pullLever(pid: string, leverId: number): void {
    if (this.refuseFrozen(pid)) return;
    const doorId = this.session.openLever(pid, leverId);
    if (doorId == null) return;
    this.broadcast({ t: 'doorOpened', doorId });
    // R4-01: дёрнутый рычаг — в запись узла: продолжение откроет его дверь сразу.
    if (this.nodeState && this.area === 'dungeon' && noteNodeId(this.nodeState.levers, leverId)) this.syncNodeState();
  }

  /**
   * ⭐ D7: ДЕЙСТВИЕ НАД СЕЙВОМ И СУНДУКОМ АККАУНТА — атомарно. Грузим сундук (с его версией, D8),
   * выполняем, пишем сейв и сундук ОДНОЙ транзакцией. Не прошла запись (сундук обогнал другой герой
   * этого аккаунта, база упала) — сейв откатывается к снимку в памяти, а загруженная копия сундука
   * просто выбрасывается: её в памяти больше никто не держит, значит откатывать там нечего.
   *
   * Сундук — объект города, поэтому по умолчанию действие отказывает вне города: пока ждали базу,
   * пати могла уйти в подземелье. `anywhere` — только для служебного вливания кошелька на входе.
   * `why` — причина для журнала вещей (D9).
   */
  private withAccount(
    c: Client, pid: string, why: string,
    act: (stash: AccountStash) => TxOutcome,
    opts: { anywhere?: boolean; subject?: string } = {},
  ): Promise<CmdOutcome> {
    return this.transact(c, pid, why, true, opts.anywhere ?? false, (st) => act(st!), opts.subject);
  }

  /**
   * Действие над ОДНИМ сейвом, записанное сразу и со своей причиной (D9). Сундука в деле нет,
   * поэтому неудачная запись действие НЕ откатывает: сейв в памяти целостен, его допишет
   * ближайший автосейв (как у любой команды без транзакции).
   */
  private withSave(c: Client, pid: string, why: string, act: () => CmdOutcome, subject?: string): Promise<CmdOutcome> {
    return this.transact(c, pid, why, false, true, () => act(), subject);
  }

  /**
   * ⭐ РАЗБОР НА МЕСТЕ (R2-14) — СРАЗУ, без ожидания базы. Раньше он шёл транзакцией (`withSave`) и ждал записи
   * внутри очереди кадров соединения: зелье, голос, рычаг и сундук, присланные после него посреди боя, стояли за
   * одной-двумя записями в базу — десятки миллисекунд, а под нагрузкой базы до 15 с. А ждать было нечего: запись
   * одного сейва при неудаче действие не откатывает. Вещь уничтожена в памяти сразу, запись встаёт в очередь
   * записей игрока и уходит со своей причиной — журнал вещей подпишет разобранную вещь разбором (R2-21), даже если
   * первой её застанет стоявший раньше автосейв. Лимит кузницы (D12) остаётся: отказ «Слишком часто» клиент видит.
   */
  private salvageInField(c: Client, pid: string, save: SaveState, uid: string, minYield?: Record<string, number>, avgYield?: Record<string, number>): CmdOutcome {
    const why = salvageReason(save, uid);   // ДО разбора: после него вещи в сумке уже нет
    const r = fieldSalvage(this.cfg, save, uid, townRng(), minYield, avgYield);
    if (!r.ok) return r;
    c.reasons.set(uid, why);
    // K7: действие стоит, как только совершено: запись одного сейва его не откатывает.
    tallyForge(c.tm, why);
    this.writeSoon(c, this.session.world.players[pid]!, why);
    return r;
  }

  /**
   * Запись сейва — СЕЙЧАС, в очередь записей игрока, не дожидаясь её (разбор на месте R2-14, выброс V-B2-04). Уже ждёт такая и ещё не
   * началась — новая её не множит: та, начавшись, снимет сейв со всем, что было до неё.
   */
  private writeSoon(c: Client, p: PlayerEntity, why?: string): void {
    if (c.fieldWrite) return;
    c.fieldWrite = true;
    void this.queued(c, () => { c.fieldWrite = false; return this.write(c, p, undefined, why); });
  }

  /**
   * ⭐ V-B2-04: ВЫБРОШЕННОЕ ЛЕЖИТ ЕЩЁ И В СТРОКЕ ВЫБРОСИВШЕГО, пока его запись без вещи не ляжет. `drop` — команда памяти, а подъём соседа
   * по аккаунту записывает ЛЮБАЯ его следующая запись (автосейв, перекладка в сундук, ковка, разбор): вещь ложилась в строку поднявшего, пока
   * строка выбросившего держала её до своего автосейва (до 10 с; при сбоях его записей и снятии сессии — и дольше) — падение процесса в
   * этом окне раздавало её обоим, а ночной аудит видел «одна вещь в двух местах» и без падения. Теперь вещь на земле помечена выбросившим
   * (`heldBy`: поднять её может только он сам), его запись встаёт в очередь сразу (`writeSoon`), и метку снимает её успех (`releaseHeld`);
   * копия выбросившего проиграла (правда — строка базы) — вещь уходит с земли (`forfeitHeld`): она в его строке.
   */
  private holdThrown(c: Client, pid: string, item: Item): void {
    const p = this.session.world.players[pid];
    const d = this.session.world.drops.find((x) => x.kind === 'item' && x.item === item);
    if (!p || !d) return;
    d.heldBy = p.save.charId;
    // ⭐ C-07: база только что отказала этой сессии (сбой, а не отказ по версии) — запись на каждый выброс её не поднимет, а поток «выбросил —
    // поднял» при лежащей базе ставил полную запись сейва (и её сбой в лог) на каждый кадр в темпе команд города. Вещь и так удержана
    // (`heldBy`): метку снимет ближайшая легшая запись — автосейв, выход, следующий выброс после паузы.
    if (Date.now() - c.writeFailedAt < DROP_WRITE_BACKOFF_MS) return;
    this.writeSoon(c, p);
  }

  /** ⭐ V-B2-04: дождаться записей героя `charId` (очередь сессии или копии, ждущей реконнекта) — не дольше `HELD_WAIT_MS`. */
  private async heldSettled(charId: string): Promise<void> {
    let tail = this.disconnected.get(charId)?.saving;
    for (const c of this.clients.values()) if (this.session.world.players[c.pid]?.save.charId === charId) tail = c.saving;
    if (!tail) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((r) => { timer = setTimeout(r, HELD_WAIT_MS); });
    try { await Promise.race([tail, cap]); } finally { clearTimeout(timer); }
  }

  /** ⭐ V-B2-04: выброшенное героем `charId` (на земле, с меткой), чего нет в сейве `save`, — метки, которые снимет успех его записи. */
  private heldOut(charId: string, save: SaveState): string[] {
    const drops = this.session.world.drops;
    if (!drops.some((d) => d.heldBy === charId)) return [];
    const has = new Set(saveUids(save));
    const out: string[] = [];
    for (const d of drops) if (d.heldBy === charId && d.kind === 'item' && !has.has(d.item.uid)) out.push(d.item.uid);
    return out;
  }

  /** ⭐ V-B2-04: запись героя `charId` без этих вещей легла — они больше не его строки: поднять может любой герой аккаунта. */
  private releaseHeld(charId: string, uids: readonly string[]): void {
    if (!uids.length) return;
    for (const d of this.session.world.drops) if (d.heldBy === charId && d.kind === 'item' && uids.includes(d.item.uid)) delete d.heldBy;
  }

  /**
   * ⭐ V-B2-04: копия героя `charId` проиграла — правда о нём в строке базы, а там выброшенное ещё лежит: с земли его долой. `row` — строка,
   * которую только что записали по базе (`settleStored`): чего в ней нет, то уже не его — метка снимается.
   */
  private forfeitHeld(charId: string, row?: SaveState): void {
    const drops = this.session.world.drops;
    if (!drops.some((d) => d.heldBy === charId)) return;
    const inRow = row ? new Set(saveUids(row)) : undefined;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i]!;
      if (d.heldBy !== charId || d.kind !== 'item') continue;
      if (inRow && !inRow.has(d.item.uid)) { delete d.heldBy; continue; }
      drops.splice(i, 1);
      console.warn(`[room ${this.code}] копия ${charId} проиграла — выброшенная вещь ${d.item.uid} осталась в его строке и убрана с земли`);
    }
  }

  /**
   * Общий путь транзакций. Всё — ВНУТРИ очереди записей игрока: пока действие ждёт базу, никакая
   * другая запись этого игрока (автосейв, выход) не начнётся и не запишет полуготовое состояние,
   * а начатая раньше — закончится до нашего снимка. `subject` — вещь действия для журнала вещей (R2-21).
   */
  private transact(
    c: Client, pid: string, why: string, account: boolean, anywhere: boolean,
    act: (stash: AccountStash | undefined) => TxOutcome, subject?: string,
  ): Promise<CmdOutcome> {
    return this.queued(c, async (): Promise<CmdOutcome> => {
      const p = this.session.world.players[pid];
      if (!p || this.clients.get(pid) !== c) return { ok: false, reason: 'Нет персонажа' };
      const loaded = account ? await loadAccountStash(c.userId, this.cfg) : undefined;
      // Пока ждали базу, игрок мог уйти (сокет закрыт, прощальная запись уже в очереди за нами) — тогда
      // действовать не над кем: его сейв сейчас пишут на выход, а ответ всё равно не дойдёт.
      if (this.clients.get(pid) !== c) return { ok: false, reason: 'Нет персонажа' };
      if (this.frozen) return { ok: false, reason: FROZEN };   // R5-07: пока ждали базу, начался слив — не исполняем
      // ⭐ R12-11: голос за продолжение забега прошёл, переход ждёт свод из базы (`resumeFromLedger`) — сейв на удержание не берём.
      // Барьер R1-05 (`checkVote` ждёт удержанных) стоит только до голоса: удержанный в этом окне сейв уезжал в подземелье, а неудача
      // его записи откатывала к городскому снимку всё, что случилось уже там (штраф смерти, опыт, квесты).
      if (loaded && this.resuming) return { ok: false, reason: RESUMING };
      if (!anywhere && this.area !== 'town') return { ok: false, reason: 'Это доступно только в городе' };
      const save = p.save;
      const before = JSON.stringify(save);
      let tx: TxOutcome;
      try {
        tx = act(loaded?.stash);
      } catch (e) {
        rollbackCmd(save, before);   // половина действия хуже, чем никакого (R8-01: сток и забег — не её)
        throw e;
      }
      const { unchanged, ...r } = tx;
      if (r.ok && unchanged && JSON.stringify(save) === before) {
        // Нечего писать (повтор ключа ковки). Сундук всё равно шлём: повтор приходит как раз после
        // реконнекта, и клиенту нужен свежий слепок, а не тот, что был до обрыва.
        if (loaded) this.sendStashOf(c, loaded.stash);
        return r;
      }
      if (!r.ok) {
        // Отказ обязан случаться ДО траты. Если функция всё же что-то тронула — это ошибка в ней:
        // откатываем и шумим, чтобы её нашли, а не молча отдаём игроку полдействия.
        if (JSON.stringify(save) !== before) {
          rollbackCmd(save, before);
          console.error(`[room ${this.code}] отказ «${r.reason ?? ''}» (${why}) изменил сейв ${save.charId} — откачено`);
        }
        return r;
      }
      // R2-21: вещь действия (скованная — по uid ответа) журнал вещей подпишет этим действием; прочее — автосейвом.
      const subjects = [...new Set([subject, r.uid].filter((u): u is string => !!u))];
      for (const u of subjects) c.reasons.set(u, why);
      // ⭐ R1-05: пока запись «сейв + сундук» ждёт базу, сейв игрока НЕ ТРОГАЕТ НИКТО: тик не подбирает ему
      // вещей и не пьёт зелий (`session.saveHeld`), а переход по голосованию ждёт (`checkVote`). Иначе откат
      // неудачной записи стёр бы и чужое: поднятая с земли вещь пропала бы совсем, выпитое зелье вернулось бы,
      // указатель забега, поставленный переходом, — снят. А неудачу записи с D8 можно вызвать нарочно: второй
      // герой аккаунта трогает сундук. Одиночный сейв (`withSave`) при неудаче не откатывается — держать его
      // незачем, а в бою зелье нужно сразу.
      if (loaded) this.session.saveHeld.add(pid);
      try {
        // K7: действие кузницы в телеметрию — только состоявшееся: записано, или запись одного сейва
        // не прошла, но действие стоит (его допишет автосейв). Откат и повтор ключа ковки — не считаются.
        const w = await this.write(c, p, loaded, why, before, subjects);
        if (w === 'ok') {
          tallyForge(c.tm, why);
          if (loaded) this.sendStashOf(c, loaded.stash);
          return r;
        }
        // R1-01, R2-09: база отказала по версии сейва или исход фиксации неизвестен — сессию уже сняли
        // (`dropStale`): дописывать действие некому, а откатывать память к «до» НЕЛЬЗЯ — в базе оно могло
        // остаться, и откат дал бы вещь и там, и в памяти (выбросить — и она у двоих).
        if (c.stale) return { ok: false, reason: 'Нет персонажа' };
        if (!loaded) {
          tallyForge(c.tm, why);
          return r;
        }
        // Откат после ожидания базы: не записано НАВЕРНЯКА (конфликт сундука, сбой до фиксации). Сейв всё это
        // время был на удержании — снимок ровно то, что было до действия. ⭐ R8-01: кроме стока и забега — их за время
        // ожидания писали чужие ходы (покупка соседа, вход в комнату), а действие их не трогало (`rollbackCmd`).
        rollbackCmd(save, before);
        for (const u of subjects) if (c.reasons.get(u) === why) c.reasons.delete(u);
        // ⭐ R14-04: откачена к «до действия» — снимку записи с неизвестным исходом (ушёл, пока она шла) копия уже не продолжение: легла та
        // запись — отказ по версии прощальной и есть правда (действие в базе), поверх неё «до действия» не пишется.
        c.unsure = [];
        return { ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' };
      } finally {
        if (loaded) {
          this.session.saveHeld.delete(pid);
          if (this.vote) this.checkVote();   // голосование, отложенное на время записи
        }
      }
    });
  }

  /**
   * Поставить работу в очередь записей игрока (Ф2): записи одного персонажа идут строго друг
   * за другом. Отказ прошлой работы очередь не рвёт.
   */
  private queued<T>(c: Client, fn: () => Promise<T>): Promise<T> {
    const next = c.saving.then(fn, fn);
    c.saving = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Игрок открыл сундук: сессия высыпает содержимое на землю (если рядом) → события всем. */
  openChest(pid: string, chestId: number): void {
    if (this.refuseFrozen(pid)) return;
    // ⭐ R4-01: команда пришла МЕЖДУ тиками — её события забираем сразу. Раньше они ложились в буфер уже прошедшего тика:
    // «сундук открыт» и «выпала вещь» не доходили ни до клиента (веб-3D не гасил меш сундука), ни до записи узла.
    const events = this.session.collectEvents(() => { this.session.openChest(pid, chestId); });
    if (!events.length) return;
    let changed = false;
    for (const e of events) if (this.noteNode(e)) changed = true;
    if (changed) this.syncNodeState();
    this.broadcast({ t: 'events', events });
  }

  /**
   * В город — голосованием. ⭐ R4-01: ИЗ ПОДЗЕМЕЛЬЯ — ОТ ПОРТАЛА: у точки входа (портал возврата) или у портала узла
   * (отдых, финал) — ровно там, где клиент его предлагает. Раньше кадр `return` принимался откуда угодно: модифицированный
   * клиент уходил из любого боя за полшага до смерти, без штрафа, и тут же продолжал узел. Из арены — откуда угодно:
   * там нет ни добычи, ни штрафа, а Unity-клиент зовёт выход у своего края зала.
   */
  returnTown(pid: string): void {
    if (this.refuseFrozen(pid) || this.area === 'town' || this.votePending(pid) || !this.voteAllowed(pid)) return;
    // R4-14: и звать, и голосовать «за» — только у портала (или мёртвым): см. `castVote`, `checkVote`.
    if (this.area === 'dungeon' && !this.canLeave(pid)) {
      this.tellFar(pid, FAR_PORTAL);
      return;
    }
    this.vote = { kind: 'town', by: pid, yes: new Set([pid]), no: new Set() };
    this.broadcast(this.voteStartFrame(this.vote));
    this.broadcast({ t: 'voteUpdate', yes: 1, total: this.clients.size });
    this.checkVote();
  }
  /** Вход в PvP-арену из города (через алтарь) — голосование, затем круглый зал с уроном игрок↔игрок. */
  enterArena(pid: string): void {
    if (this.refuseFrozen(pid) || this.area !== 'town' || this.votePending(pid) || !this.voteAllowed(pid)) return; // арена только из города
    this.vote = { kind: 'arena', by: pid, yes: new Set([pid]), no: new Set() };
    this.broadcast(this.voteStartFrame(this.vote));
    this.broadcast({ t: 'voteUpdate', yes: 1, total: this.clients.size });
    this.checkVote();
  }
  /**
   * Сложность нового забега: выбранная, если она включена и открыта ЗОВУЩЕМУ; иначе тир прошлого забега комнаты — тоже только
   * открытый ему; иначе первый открытый. ⭐ R7-06: проверка — всегда. Раньше тир, совпавший с тиром комнаты (или не
   * присланный вовсе), принимался без неё: комната стартует с «normal» (у свежего героя закрыт), а тир прошлого забега
   * переживает его конец — гость без открытий начинал «кошмар» комнаты сколько угодно раз и копил в нём прогресс.
   */
  private validDifficulty(pid: string, id: string | undefined): string {
    const diffs = this.cfg.get('difficulties');
    const progress = this.session.world.players[pid]?.save.difficultyProgress ?? {};
    const open = (i: number): boolean => i >= 0 && diffs[i]!.enabled !== false && isDifficultyUnlocked(diffs, i, progress);
    const picked = id === undefined ? -1 : diffs.findIndex((d) => d.id === id);
    if (open(picked)) return diffs[picked]!.id;
    if (open(diffs.findIndex((d) => d.id === this.difficultyId))) return this.difficultyId;
    const first = diffs.findIndex((_, i) => open(i));
    return first >= 0 ? diffs[first]!.id : this.difficultyId;
  }
  /** ⭐ C-12: тир `id` включён и открыт хоть одному герою, подключённому к комнате (все они голосовали «за» переход). */
  private tierOpenHere(id: string): boolean {
    const diffs = this.cfg.get('difficulties');
    const i = diffs.findIndex((d) => d.id === id);
    if (i < 0 || diffs[i]!.enabled === false) return false;
    for (const pid of this.clients.keys()) {
      if (isDifficultyUnlocked(diffs, i, this.session.world.players[pid]?.save.difficultyProgress ?? {})) return true;
    }
    return false;
  }
  castVote(pid: string, accept: boolean): void {
    // Голос только от игрока комнаты: сессия, снятая за устаревший сейв (R1-01), ещё может прислать кадр,
    // пока её сокет закрывается, — и «за» призрака провело бы переход без согласия живых.
    if (!this.vote || !this.clients.has(pid) || this.refuseFrozen(pid)) return;
    // ⭐ R4-14, R4-25, R5-04: «за» засчитывается только тому, кто может перейти: в город из подземелья и завершение финала —
    // у портала или мёртвым (иначе напарник у портала уводил из любого боя без штрафа), спуск — не из-под монстра вдали от
    // выхода и не переписывая свой чужой забег.
    const block = accept ? this.voteBlock(this.vote, pid) : null;
    if (block) { this.tellBlocked(pid, block); return; }
    if (accept) this.vote.yes.add(pid); else this.vote.no.add(pid);
    if (this.vote.no.size > 0) { this.broadcast({ t: 'voteEnd', passed: false }); this.vote = null; return; }
    this.broadcast({ t: 'voteUpdate', yes: this.vote.yes.size, total: this.clients.size });
    this.checkVote();
  }
  /**
   * ⭐ R8-03: ГОЛОСОВАНИЕ ЖИВЁТ ТОЛЬКО В ТОЙ ОБЛАСТИ, ГДЕ ЕГО ОТКРЫЛИ. Переход по нему закрывает его сам (`checkVote`), а смена
   * области без него (вайп и возврат в город таймером) голосование не трогала: «спуск», позванный у выхода, доживал до города и
   * проходил там «за» одного гостя, когда хозяин выходил, — новым забегом в тире комнаты без проверки сложности (R7-06), а в
   * окне вайпа голоса мёртвых запускали новый забег прямо из погибшей пати (все оживали, минуя город и паузу). Пока оно висело,
   * любой новый переход отказывал. Теперь смена области и вайп его закрывают — клиенту `voteEnd` без перехода.
   */
  private endVote(): void {
    if (!this.vote) return;
    this.vote = null;
    this.broadcast({ t: 'voteEnd', passed: false });
  }
  /**
   * Можно ли начать голосование за переход: только игроку комнаты (см. `castVote`) и не раньше паузы после
   * прошлого перехода (R1-03). Отказ паузой — кадр `error` инициатору: честный клиент видит «подождите», а не молчание.
   */
  private voteAllowed(pid: string): boolean {
    const c = this.clients.get(pid);
    if (!c) return false;
    if (Date.now() - this.movedAt < VOTE_COOLDOWN_MS || this.resuming) {   // R9-01: продолжение ещё ждёт базу
      this.send(c.ws, { t: 'error', code: 'rate', msg: 'Подождите немного' });
      return false;
    }
    return true;
  }
  private checkVote(): void {
    if (!this.vote || this.clients.size === 0 || this.frozen) return;   // R5-07: заморожена — переходов нет
    // ⭐ R14-02: живые ушли, пока голосовали за спуск (завершение), — голосование закрыто: без живых вперёд не идут (см. `descend`), а
    // открытое оно держало бы и уход мёртвых в город (`votePending`).
    if (this.vote.kind === 'descend' && this.area === 'dungeon' && this.stranded()) { this.endVote(); return; }
    if (this.vote.yes.size >= this.clients.size) {
      // R1-05: чей-то сейв сейчас в транзакции «сейв + сундук» — переход ждёт её конца (`transact` зовёт
      // проверку снова). Переход пишет в сейвы всех (указатель забега, прогресс сложности, квесты), а
      // неудачная запись откатила бы сейв к снимку ДО перехода: комната в подземелье, а забега у игрока
      // «нет» — и «Завершить» потом обходилось бы без штрафа.
      // ⭐ R13-03: тело в бою (`lingering`) держит свой сейв от подбора, а не транзакцию, — переход его не ждёт (уход с этажа его снимет).
      for (const held of this.session.saveHeld) if (!this.lingerOf(held)) return;
      // ⭐ R4-14, R4-25: «за», поданное раньше, ещё в силе? Голосовавший мог отойти от портала обратно в бой, а хозяин
      // комнаты — смениться (и с ним забег, который продолжит спуск). Голос, который уже не в силе, снимается.
      for (const pid of [...this.vote.yes]) {
        const block = this.voteBlock(this.vote, pid);
        if (!block) continue;
        this.vote.yes.delete(pid);
        this.tellBlocked(pid, block);
      }
      if (this.vote.yes.size < this.clients.size) {
        this.broadcast({ t: 'voteUpdate', yes: this.vote.yes.size, total: this.clients.size });
        return;
      }
      // ⭐ R9-08: НАЧНЁТСЯ РОВНО ТО, ЗА ЧТО ГОЛОСОВАЛИ. Пока голосовали, мог войти (или уйти) хозяин припаркованного забега — и
      // спуск продолжил бы ЕГО забег в ЕГО тире, а окно у всех говорило «новый забег» (или наоборот). Такое — не переход, а отмена:
      // позвать заново, и новое окно покажет правду.
      if (this.vote.kind === 'descend' && this.area === 'town' && this.vote.plan
        && planKey(this.vote.plan) !== planKey(this.descendPlan(this.vote.diffId, this.vote.runCfg))) {
        this.endVote();
        this.broadcast({ t: 'error', code: 'vote', msg: VOTE_CHANGED });
        return;
      }
      // ⭐ C-12: НОВЫЙ ЗАБЕГ — В ТИРЕ, ОТКРЫТОМ ХОТЬ ОДНОМУ ИЗ ТЕХ, КТО УХОДИТ. Тир сверялся только с позвавшим и только на старте голосования
      // (`validDifficulty`, R7-06), а ушедший из города позвавший голосования не закрывал: ветеран (альт того же аккаунта) звал «сложную» и
      // выходил — свежий «за» один начинал её соло и копил её глубину (`enterNode`), не открыв. Ветеран, который идёт сам, несёт пати в свой
      // тир, как и прежде (R9-08); продолжение припаркованного забега — в тире его забега (хозяин здесь, `parkedHost`).
      if (this.vote.kind === 'descend' && this.area === 'town' && this.vote.plan && !this.vote.plan.resume
        && !this.tierOpenHere(this.vote.plan.difficultyId)) {
        this.endVote();
        this.broadcast({ t: 'error', code: 'vote', msg: VOTE_CHANGED });
        return;
      }
      const v = this.vote;
      this.vote = null;
      this.movedAt = Date.now();
      this.broadcast({ t: 'voteEnd', passed: true });
      if (v.kind === 'town') {
        // ⭐ R13-02: «за» подали одни мёртвые (живых подключённых нет, «В город» из окна смерти) — уход пати без живых: вайп, если
        // спокойно ушедших с этажа нет (`leaveDead`).
        if (this.stranded()) { this.leaveDead(); return; }
        if (this.area === 'dungeon') this.buryFled();   // R4-14: сбежавшие из боя отключением в город не уходят даром
        this.enterTown();
        return;
      }
      if (v.kind === 'arena') { this.enterArenaFloor(); return; }
      // descend
      if (this.area === 'town') {
        if (v.diffId) this.difficultyId = v.diffId; // тир забега
        const host = this.parkedHost();   // R4-25: забег первого, у кого он припаркован, — не молча новый поверх
        if (host?.run?.config) { this.resumeFromLedger(host, v); return; } // продолжить незавершённый забег (R9-01: со сводом из базы)
        this.startRun(v.runCfg);
        return;
      }
      if (v.finish) { this.finishRun(); return; } // финал → город + завершение
      // ⭐ R6-01: и спуск по ветке — тоже уход с этажа: сбежавший из боя отключением погибает, как при уходе в город и на
      // финале. Раньше хоронил только город: напарник у выхода спускался, и сбежавший при 1 HP входил «Продолжить» живым у
      // входа нового узла, без штрафа и без монстра рядом.
      if (v.targetNodeId) { this.buryFled('descend'); this.enterNode(v.targetNodeId); return; } // спуск по ветке (R8-07: по правилу спуска)
    }
  }

  // ── Жизненный цикл забега (v2) ───────────────────────────────────────────────
  /**
   * Стартовый RunConfig. По умолчанию — первый включённый биом/шаблон + текущий тир. Выбор алтаря
   * (`cfg`) переопределяет биом/шаблон/модификаторы, но ТОЛЬКО валидными включёнными значениями
   * (анти-чит: клиент не может подсунуть выключенный/несуществующий контент).
   */
  private buildRunConfig(cfg?: AltarConfig): RunConfig {
    const { templateId, biomeId, modifiers } = this.altarOf(cfg);
    // Свежий сид на КАЖДЫЙ новый забег (this.seed — сид РУМА/сима, один на сессию → все забеги были одинаковыми).
    const runSeed = randomSeed();   // D10: сид забега решает этажи и дроп — не по часам
    // ⭐ R9-01: личность забега — ключ его свода записей в базе (`runLedgerKey`): копии участников она не делит, а объединяет.
    // ⭐ R14-10: ключ этажей — сиды этажей узлов (`runPlanOf`); клиенту не уходит, как и сид.
    return { templateId, biomeId, tier: this.difficultyId, seed: runSeed, modifiers, id: randomUUID(), floorKey: randomBytes(16).toString('hex') };
  }
  /**
   * Выбор алтаря → шаблон, биом и модификаторы нового забега — ТОЛЬКО валидными включёнными значениями (анти-чит: клиент не
   * может подсунуть выключенный/несуществующий контент). R9-08: то же решение видит окно голосования (`descendPlan`).
   */
  private altarOf(cfg?: AltarConfig): { templateId: string; biomeId: string; modifiers: string[] } {
    const biomes = this.cfg.get('biomes').filter((b) => b.enabled !== false);
    const tpls = this.cfg.get('run-templates').filter((t) => t.enabled !== false);
    const biome = biomes.find((b) => b.id === cfg?.biomeId) ?? biomes[0] ?? this.cfg.get('biomes')[0]!;
    const tpl = tpls.find((t) => t.id === cfg?.templateId) ?? tpls[0] ?? this.cfg.get('run-templates')[0];
    // Модификаторы: только включённые, scope:'run', (если шаблон ограничивает) из allowedModifiers — и ⭐ R8-12 действующие,
    // каждый один раз, благо — в паре с опасностью (`pickRunModifiers`, то же правило у плана). Кадр проверяет схема
    // менеджера (R1-19); здесь — вторая линия: выбор алтаря едет из кадра, и не-массив в нём ронял старт забега ПОСЛЕ
    // «голосование прошло» — пати видела успех, а спуска не было (правило отбрасывает не-массив и не-строки).
    const modifiers = pickRunModifiers(this.cfg.get('run-modifiers'), tpl?.allowedModifiers, cfg?.modifiers);
    return { templateId: tpl?.id ?? 'default', biomeId: biome.id, modifiers };
  }
  /** Начать новый забег: RunConfig (с выбором алтаря) → RunPlan → первый узел. */
  private startRun(cfg?: AltarConfig): void {
    this.captureLedger();   // R9-01: свод прошлого забега комнаты — в базу, прежде чем комната его забудет
    this.runConfig = this.buildRunConfig(cfg);
    this.runPlan = runPlanOf(this.cfg, this.runConfig);   // R14-10: этажи — от ключа забега
    this.ledger.clear();
    this.takeRun();   // ⭐ V2: новый забег (личность — свежая) — этой комнаты
    this.enterNode(this.runPlan.startId);
  }
  /**
   * Продолжить забег из сейва (граф регенерится из config.seed). ⭐ R4-04: с САМОГО ГЛУБОКОГО указателя этого забега среди
   * тех, кто в комнате: раньше продолжался узел хозяина, и `enterNode` ставил его всем — ушедшего вперёд тянуло назад, и
   * пройденный им узел потом вставал свежим.
   */
  private resumeRun(save: SaveState): boolean {
    if (!save.run) return false;
    if (!this.runConfig || !sameRun(this.runConfig, save.run.config)) { this.captureLedger(); this.ledger.clear(); }   // R9-01
    this.runConfig = save.run.config;
    this.difficultyId = save.run.config.tier;
    this.runPlan = runPlanOf(this.cfg, save.run.config);   // R14-10
    this.takeRun();   // ⭐ V2: зовущие сверили, что забег не идёт в другой комнате (`resumeFromLedger`, `RoomManager.join`)
    let nid = this.depthOf(save.run.currentNodeId) >= 0 ? save.run.currentNodeId : this.runPlan.startId;
    for (const s of this.runSaves()) if (this.depthOf(s.run.currentNodeId) > this.depthOf(nid)) nid = s.run.currentNodeId;
    this.enterNode(nid, true);
    return true;
  }
  /**
   * ⭐ R9-01: ПРОДОЛЖЕНИЕ ИЗ ГОРОДА — СО СВОДОМ ЗАБЕГА ИЗ БАЗЫ, ПРОЧИТАННЫМ СЕЙЧАС. Сейвы в городской комнате прочитаны на входе, а
   * пока их хозяева стояли в городе, забег мог пройти дальше без них — в другой комнате, где его потом бросили (финал, «Завершить»,
   * вайп). Каждый такой «якорь», дождавшись напарника по коду, давал пройденные без него узлы свежими — по повтору на якоря, а
   * якорей — сколько героев успело постоять в забеге. Теперь продолжение сперва читает свод из базы (`getRunLedger`, дождавшись
   * своих записей в полёте) и вливает его в копии этого забега в комнате; вход в узел — после. Переходов до того нет
   * (`resuming`, пауза R1-03 и так держит полторы секунды); пока ждали, комната ушла из города, хозяин забега сменился или вышел —
   * продолжения нет; база не ответила — тоже нет (`error{code:'busy'}`: позвать снова), а не продолжение старой копией.
   * ⭐ R10-07: и пока ждали, в комнату НИКТО НЕ ВОШЁЛ, а спуск начнёт ровно то, за что голосовали (`voted` — прошедшее голосование,
   * R9-08). Раньше после ожидания сверялись только хозяин и забег, а вход в комнату ожидание не держит: вошедший по коду в это окно
   * уносился в продолжение без голоса — и его СВОЙ припаркованный забег переписывался забегом хозяина без штрафа «Завершить»
   * (обход R4-25), а вошедший с тем же забегом и указателем глубже уводил продолжение глубже показанного в окне.
   */
  private resumeFromLedger(host: SaveState, voted: NonNullable<Room['vote']>): void {
    const run = host.run!.config;
    const key = runLedgerKey(run);
    const charId = host.charId;
    const voters = new Set(this.clients.keys());
    // ⭐ V2: забег идёт в другой комнате этой ноды — не продолжение, а отказ (голос мог пройти раньше, чем та вошла).
    const busyNow = this.hooks.runBusy?.(key, this);
    if (busyNow) { this.broadcast({ t: 'error', code: 'run', msg: runElsewhereMsg(busyNow) }); return; }
    this.resuming = true;
    void (async () => {
      let stored: RunNodeState[] | undefined;
      /** ⭐ V2: держатель забега на другой ноде (`null` — забег за этой нодой). */
      let elsewhere: string | null = null;
      try {
        await runLedgerSettled(key);
        stored = await getRunLedger(key);
        if (this.hooks.runClaim) elsewhere = await this.hooks.runClaim(key, this);
      } catch (e) {
        warnLedger(e);
        stored = undefined;
      }
      this.resuming = false;
      if (!this.resumeChecked(host, voted, key, charId, voters, stored, elsewhere)) this.hooks.runDropped?.(key, this);   // V2: взятое на ожидание — назад
    })().catch((e: unknown) => {
      // Бросок здесь — необработанный отказ промиса, то есть выход процесса со всеми комнатами: гасим и шумим.
      this.resuming = false;
      console.error(`[room ${this.code}] продолжение забега из города упало:`, e);
    });
  }
  /** Сверки продолжения из города после ожидания базы (R9-01, R10-07, V2) — и само продолжение. `true` — продолжено (комната в подземелье). */
  private resumeChecked(
    host: SaveState, voted: NonNullable<Room['vote']>, key: string, charId: string, voters: ReadonlySet<string>,
    stored: RunNodeState[] | undefined, elsewhere: string | null,
  ): boolean {
    if (this.frozen || this.area !== 'town' || this.clients.size === 0) return false;
    if (!stored) { this.broadcast({ t: 'error', code: 'busy', msg: RESUME_FAILED }); return false; }
    const run = host.run!.config;
    const h = this.parkedHost();
    if (!h?.run?.config || h.charId !== charId || runLedgerKey(h.run.config) !== key) {
      this.broadcast({ t: 'error', code: 'vote', msg: VOTE_CHANGED });   // хозяин забега ушёл, пока ждали, — не то, за что голосовали
      return false;
    }
    // R10-07: вошедший без голоса или спуск уже не тот (глубина, хозяин) — не переход, а отмена: позвать заново, окно покажет правду.
    const joined = [...this.clients.keys()].some((pid) => !voters.has(pid));
    if (joined || (voted.plan && planKey(voted.plan) !== planKey(this.descendPlan(voted.diffId, voted.runCfg)))) {
      this.broadcast({ t: 'error', code: 'vote', msg: VOTE_CHANGED });
      return false;
    }
    // ⭐ V2: пока ждали базу, забег взяла другая комната — этой ноды (сверка сейчас) или другой (кластер): к пати туда, а не второй раз здесь.
    const busy = this.hooks.runBusy?.(key, this) ?? elsewhere;
    if (busy) { this.broadcast({ t: 'error', code: 'run', msg: runElsewhereMsg(busy) }); return false; }
    if (stored.length) {
      for (const c of this.clients.values()) {
        const r = this.session.world.players[c.pid]?.save.run;
        if (!r?.config || !sameRun(r.config, run)) continue;
        const all = new Map<string, RunNodeState>();
        foldRunRecords(all, runRecords(r, r.config));
        if (foldRunRecords(all, stored)) putRunRecords(r, all.values());
      }
    }
    return this.resumeRun(h);
  }
  /**
   * ЗАБЕГ ОКОНЧЕН: снять указатель у всех игроков комнаты и обнулить план.
   *
   * Город сюда НЕ входит намеренно: финал возвращает порталом СРАЗУ, а вайп — таймером
   * через окно смерти. Общее у них ровно одно — забега больше нет, и продолжать нечего.
   */
  private endRun(): void {
    // ⭐ R9-01: СВОД ЗАБЕГА — В БАЗУ ДО ТОГО, КАК КОПИИ СНИМУТСЯ. Финал и вайп выбрасывают копии подключённых; у ушедших раньше
    // (вышел из города, друг, альт) копии остались — старые, без узлов, пройденных без них. Раньше их «Продолжить» собирало эти
    // узлы свежими (сундуки, босс, опыт, глубина) — и так по кругу, пока жива старая копия. Теперь вход читает свод из базы.
    void this.flushLedger();
    // R4-25: снимается только ЭТОТ забег — чужой припаркованный у гостя комнаты остаётся ему (завершить его — «Завершить»).
    const cfg = this.runConfig;
    for (const pid of this.clients.keys()) {
      const s = this.session.world.players[pid]?.save;
      if (s?.run && (!cfg || !s.run.config || sameRun(s.run.config, cfg))) s.run = undefined;
    }
    this.runConfig = null; this.runPlan = null; this.runNodeId = null;
    this.nodeState = null; this.spawnIdx.clear(); this.ledger.clear();
    this.dropRun();   // ⭐ V2: забег окончен — его больше никто не держит
  }

  /**
   * ⭐ V2: ДЕРЖИТ ЛИ КОМНАТА ЗАБЕГ `key` — взяла его (`takeRun`) и стоит с ним в подземелье, либо (город, арена) план жив и здесь есть
   * участник этого забега (подключён или ждёт реконнекта): пати ушла в город и вернётся продолжать. Участников не осталось — забег свободен:
   * продолжить его можно в другой комнате.
   *
   * Раньше один забег (одна личность `RunConfig.id`) мог идти в подземелье двух комнат сразу: взятое на узле (сундуки, убитые, босс, рычаги)
   * — у каждой комнаты своё (`ledger`), со сводом в базе (`run_ledger`) оно сверяется только на входе в узел. Двое из одного забега —
   * «якорь» ушёл из города, пати продолжила — «Соло» и спуск (или «Продолжить» без грейса) собирали тот же узел во второй комнате, и
   * сундук, босс и опыт узла брались дважды; а погибший в одной комнате вставал живым в другой.
   */
  holdsRun(key: string): boolean {
    if (this.runLock !== key || !this.runConfig || runLedgerKey(this.runConfig) !== key) return false;
    if (this.area === 'dungeon') return true;
    for (const _ of this.runSaves(true)) return true;
    return false;
  }

  /**
   * ⭐ V2: комната взяла свой забег (`runConfig`) — входит с ним в подземелье (`startRun`, `resumeRun`). Прошлый забег отпускается. Держателем
   * она объявляется и тогда, когда забег за ней уже числился: пока она стояла в городе, его могла взять и отпустить другая комната.
   */
  private takeRun(): void {
    const cfg = this.runConfig;
    if (!cfg) return;
    const key = runLedgerKey(cfg);
    if (this.runLock !== key) { this.dropRun(); this.runLock = key; }
    this.hooks.runTaken?.(key, this);
    this.releaseForeign(cfg);
  }

  /**
   * ⭐ C-04: КОМНАТА УХОДИТ В ЗАБЕГ `cfg` — ЖДУЩИЕ РЕКОННЕКТА С ДРУГИМ (или без забега) ЕЙ БОЛЬШЕ НЕ ПАТИ. Их забег припаркован (`safe`: здесь в
   * подземелье ждут только его участники, а из города в забег уходят все — `takeRun` зовут только оттуда), и отпускаются они, как вышедшие
   * из города (`releaseParked`): без штрафа, забег цел, «Продолжить» ведёт к нему (V2), а не сюда. Раньше они оставались в грейсе комнаты,
   * начавшей чужой забег: «Продолжить» сажало в её подземелье (голос за спуск — отказ `run`, пати без спуска), а её вайп и истечение грейса
   * хоронили их со штрафом и снимали забег, который не проигрывал.
   */
  private releaseForeign(cfg: RunConfig): void {
    for (const [charId, info] of [...this.disconnected]) {
      const run = info.save.run?.config;
      if (!info.safe || (run && sameRun(run, cfg))) continue;
      const write = this.releaseParked(charId, info);
      this.hooks.onFarewell?.(charId, write);
    }
  }

  /**
   * ⭐ C-04: ждущий реконнекта `charId` здесь припаркован (`safe`) со СВОИМ забегом, а комната — не в нём (другой забег или никакого):
   * «Продолжить» ведёт к его забегу (`RoomManager.join`), а не сюда.
   */
  parkedForeign(charId: string): boolean {
    const info = this.disconnected.get(charId);
    const run = info?.save.run?.config;
    return !!info?.safe && !!run && !(this.runConfig && sameRun(run, this.runConfig));
  }

  /** ⭐ V2: комната свой забег отпускает (`endRun`, другой забег). */
  private dropRun(): void {
    const key = this.runLock;
    if (!key) return;
    this.runLock = null;
    this.hooks.runDropped?.(key, this);
  }

  /** ⭐ V2: забег, который продолжит спуск из города (`parkedHost`), идёт в другой комнате — её код. */
  private parkedRunBusy(): string | undefined {
    const cfg = this.parkedHost()?.run?.config;
    return cfg ? this.hooks.runBusy?.(runLedgerKey(cfg), this) : undefined;
  }

  /** ⭐ V2: отказ продолжению забега, который идёт в другой комнате (кадр `error`, код `run`). */
  private tellRunElsewhere(pid: string, code: string): void {
    const c = this.clients.get(pid);
    if (c) this.send(c.ws, { t: 'error', code: 'run', msg: runElsewhereMsg(code) });
  }
  /** Финал забега: забег окончен + возврат в город. */
  private finishRun(): void {
    const cfg = this.runConfig;
    this.buryFled();   // R4-14: сбежавший из боя финала отключением не завершает забег даром
    this.endRun();
    // ⭐ R3-05: ЗАБЕГ ОКОНЧЕН И ДЛЯ ТЕХ, КТО ЖДЁТ РЕКОННЕКТА. `endRun` снимает указатель только у подключённых, и копия
    // партнёра, отвалившегося на финале, держала финал — в памяти и в базе (прощальная запись): «Завершить» и истечение
    // грейса брали с него штраф смерти за пройденный забег, а «Продолжить» высаживало обратно на финал. Финал — не смерть:
    // указатель снимается без штрафа, запись прощальная (`onFarewell`) — вход героя её дождётся. Вайп сюда не ходит:
    // там отключённые — погибшие (`finalizeDisconnectedAsDead`).
    // R4-25: только этот забег; R4-15: копию обогнали — забег снимается со строки базы (если он там этот же).
    const clear = (s: SaveState): boolean => {
      if (!s.run?.config || !cfg || !sameRun(s.run.config, cfg)) return false;
      s.run = undefined;
      return true;
    };
    for (const [charId, info] of this.disconnected) {
      if (!clear(info.save)) continue;
      const retry = (): Promise<WriteResult> => this.persistDisconnected(charId, info, clear);
      const write = retry().then((r) => this.farewellOf(r, retry));   // до вызова: `?.()` без хука аргументы не вычисляет
      this.hooks.onFarewell?.(charId, write);
    }
    this.enterTown();
  }
  /**
   * Войти в узел забега: сгенерировать этаж по floorSpec, заселить по ролям/фичам, разослать кадры.
   * `resumed` — продолжение забега на уже пройденном узле (`resumeRun`): квестам «достичь этажа» это не засчитывается,
   * а узел собирается КАК ЕГО ОСТАВИЛИ (R4-01): открытые сундуки открыты, убитые не встают, рычаги дёрнуты.
   * ⭐ R4-04: так же — ЛЮБОЙ узел, где кто-то из участников уже был (свод записей комнаты): указатель, отмотанный назад,
   * или пати, разошедшаяся по комнатам, узел свежим больше не получают. Пройденный без записи (сейв старше записей) —
   * взят целиком. И такой вход — тоже не новый для квестов (R3-10).
   */
  private enterNode(nodeId: string, resumed = false): void {
    this.endVote();   // R8-03: область сменилась — открытое голосование не про неё
    this.settleLingers();   // R13-03: тела ушедших посреди боя на новый этаж не переходят
    if (!this.runPlan || !this.runConfig) { this.startRun(); return; }
    const node = this.runPlan.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const runCfg = this.runConfig;
    // ⭐ R4-01, R4-04: записи — из сейвов ВСЕХ участников этого забега здесь (и ждущих реконнекта), до того, как цикл ниже
    // перепишет им указатель.
    let folded = false;
    for (const s of this.runSaves(true)) if (foldRunRecords(this.ledger, runRecords(s.run, runCfg))) folded = true;
    const kept = this.ledger.get(nodeId);
    let bare = false;
    if (!kept) for (const s of this.runSaves(true)) if (visitedNode(s.run, runCfg, nodeId)) { bare = true; break; }
    const revisit = resumed || !!kept || bare;
    this.floorChanged('dungeon');   // R4-06, R4-16: ушедшие с прошлого этажа сюда не «на то же место»
    // ⭐ R9-07: и не «из боя»: бегство (`fled`, `fledDescend`) — про узел, с которого ушёл, а пати уже здесь (сбежавших спуском
    // `buryFled('descend')` похоронил до входа). Раньше метка жила дальше: загнанного у выхода спуск честно уносил (R8-07), а
    // спокойный уход пати в город с НОВОГО узла (или финал) хоронил его со штрафом за бой, в котором его уже не было.
    for (const info of this.disconnected.values()) { info.fled = false; info.fledDescend = false; }
    this.reviveAway();   // ⭐ C-03: новый узел оживил и их — смерть в забеге позади
    this.wipeAt = 0; this.strandAt = 0;
    this.area = 'dungeon'; this.runNodeId = nodeId; this.depth = node.depth;
    for (const c of this.clients.values()) c.tm.floors++;   // Ф3.2: этажей за сессию
    this.session.world.difficultyId = this.difficultyId;
    const biomes = this.cfg.get('biomes');
    const biome = biomes.find((b) => b.id === node.biomeId) ?? biomes[0]!;
    const decorSpecs = decorSpecsFor(this.cfg.get('objects'), this.cfg.get('models'), biome.id);   // напольный декор биома (role decor/prop)
    const layout = generateFloor(node.floorSpec, this.cfg.get('room-prefabs'), decorSpecs, undefined,
      { tiers: this.cfg.get('chests'), perFloor: this.cfg.get('balance').loot.chestsPerFloor });
    this.decor = layout.decor;
    const obstacles = obstaclesFromDecor(layout.decor, new Map(decorSpecs.map((s) => [s.id, s])));   // суб-тайл-коллизия
    const pool = resolveMonsterPool(biome, node.depth);
    // Продолжение заселяет той же мощью, что первый вход: от неё зависят броски генератора, и номера убитых иначе
    // указывали бы на других монстров (вырос в городе — и босс «ожил» под чужим номером).
    const el = kept?.el ?? this.partyLevel();
    const rng = createRng((node.floorSpec.seed >>> 0) || 1);
    const spawned = spawnPacksEl(this.cfg, layout, node.depth, this.difficultyId, rng, el, pool, node.floorSpec.packDensity, node.floorSpec.floorId);
    // R4-04: пройденный без записи — взят целиком: ни заселения, ни сундуков; двери рычагов открыты.
    const killed = new Set(bare ? spawned.map((_, i) => i) : (kept?.killed ?? []).filter((i) => i < spawned.length));
    const alive: number[] = [];
    const monsters = spawned.filter((_, i) => { if (killed.has(i)) return false; alive.push(i); return true; });
    const opened = new Set(bare ? layout.chests.map((c) => c.id) : kept?.chests ?? []);
    const pulled = new Set(bare ? layout.levers.map((l) => l.id) : kept?.levers ?? []);
    this.session.enterFloor(node.depth, {
      // ⚠ `chests` ОБЯЗАТЕЛЬНО: этаж их генерил, но сессия их не получала — и сундуков в живой
      // игре не было вовсе (в симе были, он передавал их явно). Это же убивало и весь ЦЕЛЫЙ дроп:
      // с тела падают только сломанные трофеи, а надеть в забеге было нечего.
      grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters, obstacles,
      chests: layout.chests.map((c) => (opened.has(c.id) ? { ...c, opened: true } : c)),
      doors: layout.doors, levers: layout.levers.map((l) => (pulled.has(l.id) ? { ...l, used: true } : l)),
      // Уровень этажа — по ПОЛНОМУ заселению: убитый босс не опускает ступень нетронутых сундуков.
      floorLevel: spawned.reduce((m, sp) => Math.max(m, sp.def.level), 0),
      runNodeId: nodeId, runNodeType: node.type, floorModifiers: node.floorSpec.modifiers, biomeId: biome.id,
    });
    // Мир заселён ровно списком `monsters` и в его порядке — отсюда номер заселения каждой сущности.
    this.spawnIdx = new Map(this.session.world.monsters.map((m, k) => [m.id, alive[k]!]));
    this.nodeState = {
      id: nodeId, el,
      chests: layout.chests.filter((c) => opened.has(c.id)).map((c) => c.id).sort((a, b) => a - b),
      killed: [...killed].sort((a, b) => a - b),
      levers: layout.levers.filter((l) => pulled.has(l.id)).map((l) => l.id).sort((a, b) => a - b),
    };
    this.ledger.set(nodeId, this.nodeState);   // запись текущего узла — тот же объект в своде (её ведёт `noteNode`)
    // R9-01: запись узла (и принесённое из сейвов участников) — в свод базы; уходит с чекпойнтом ниже (`persistAll`).
    if (folded) this.markLedger();
    this.markLedger(nodeId);
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcastPeerInfo();
    this.resetDeltaBaseline(); // Ф1.3: мир заменён — прошлый базис к нему не применим
    this.broadcast({ t: 'runPlan', plan: clientPlan(this.runPlan), currentNodeId: nodeId });   // R14-10: без сидов
    // Персист указателя забега + прогресс сложности/квестов.
    const qev: SessionEvent[] = [];
    const gear = gearPool(this.runHeroes());   // R7-02: мощь каждого — по снаряжению, которое он может надеть
    for (const [pid, c] of this.clients) {
      const s = this.session.world.players[pid]!.save;
      // R4-25: чужой забег спуском не переписывается — голос с ним не засчитывается (`runClash`); здесь его нет.
      const prev = s.run?.config && sameRun(s.run.config, runCfg) ? s.run : undefined;
      const was = prev?.visited ?? [];
      const visited = was.includes(nodeId) ? was : [...was, nodeId];   // продолжение узла не множит его в списке
      // ⭐ R4-04: указатель НЕ УЕЗЖАЕТ НАЗАД — ушедший дальше (вошёл к пати, стоящей раньше) остаётся на своём узле.
      const ahead = !!prev && this.depthOf(prev.currentNodeId) > node.depth;
      // ⭐ R8-04: мощь героя в этом забеге — не ниже той, что он уже показывал в нём (`peak`, см. `notePeak`).
      const power = Math.max(this.heroPower(s, gear.get(c.userId)), runPeak(prev));
      s.run = { templateId: runCfg.templateId, config: runCfg, currentNodeId: ahead ? prev!.currentNodeId : nodeId, visited, peak: power };
      putRunRecords(s.run, this.ledger.values());
      // ⭐ R7-02: узел, заселённый раньше под героев слабее этого (альт один прошёл дальше, основной вошёл по коду), глубиной в
      // прогресс сложности ему не идёт: её открывают монстры по ЕГО мощи. Новый узел заселяется по сильнейшему (`partyLevel`) —
      // там запрет не срабатывает ни у кого; следующий новый узел откроет ему глубину честно.
      // ⭐ R8-02: и только НОВЫЙ вход — как квесты «достичь этажа» ниже (R3-10). Продолжение припаркованного забега возвращает на
      // пройденный узел, и глубину получали все, кто в комнате: свежий герой входил к хозяину глубокого забега, «Продолжить»
      // вдвоём, оба к порталу — и глубина 10 «normal» (а с ней «hard») открыта без единого боя, а забег хозяина цел для
      // следующего. Честному она уже засчитана первым входом.
      if (!revisit && power <= el + NODE_POWER_SLACK) {
        s.difficultyProgress[this.difficultyId] = Math.max(s.difficultyProgress[this.difficultyId] ?? 0, node.depth);
      }
      // ⚠ R3-10: «достичь этажа» — только НОВЫЙ вход. Продолжение припаркованного забега (свой или хозяина комнаты)
      // возвращает на пройденный узел, и квест с доски, принятый в городе, закрывался бы спуском мгновенно. R4-04: и узел,
      // где кто-то из участников уже был, — тоже не новый.
      if (!revisit) for (const qid of trackFloor(s, node.depth).completed) qev.push(this.questCompleted(pid, s, qid));
      this.sendSave(pid);
    }
    if (qev.length) this.broadcast({ t: 'events', events: qev });
    this.persistAll();
  }

  /**
   * ⭐ R4-01: событие сессии, меняющее узел: убит монстр ЗАСЕЛЕНИЯ (по номеру в списке), открыт сундук. `true` — запись
   * изменилась. Только в подземелье и только на узле записи.
   */
  private noteNode(e: SessionEvent): boolean {
    const st = this.nodeState;
    if (!st || this.area !== 'dungeon' || this.runNodeId !== st.id) return false;
    if (e.type === 'monster-died') {
      const i = this.spawnIdx.get(e.id);
      if (i === undefined) return false;
      this.spawnIdx.delete(e.id);
      return noteNodeId(st.killed, i);
    }
    if (e.type === 'chest-opened') return noteNodeId(st.chests, e.id);
    return false;
  }

  /**
   * ⭐ R4-01: запись узла — КОПИЕЙ в сейв каждого участника этого забега: и подключённых, и ждущих реконнекта (их копия
   * дописывается прощальной записью). R4-04: и тем, чей указатель на другом узле (ушёл дальше), — в `nodes`: запись есть у
   * каждого пройденного узла. Уходит в базу с ближайшей записью (автосейв, город).
   */
  private syncNodeState(): void {
    const st = this.nodeState;
    if (!st) return;
    for (const s of this.runSaves(true)) putRunRecord(s.run, st);
    this.markLedger(st.id);   // R9-01: и в свод базы — с ближайшим чекпойнтом (`flushLedger`)
  }

  /** ⭐ R9-01: запись узла `id` (без id — весь свод) изменилась — уйдёт в базу с ближайшей записью свода. */
  private markLedger(id?: string): void {
    if (!this.runConfig) return;
    if (id !== undefined) { this.ledgerDirty.add(id); return; }
    for (const k of this.ledger.keys()) this.ledgerDirty.add(k);
  }

  /**
   * ⭐ R9-01: снять изменившиеся записи свода ТЕКУЩЕГО забега к записи в базу (копиями, под его ключом). Зовётся и перед тем, как
   * комната забудет забег (`endRun`, другой забег): записи в очереди переживают смену забега.
   */
  private captureLedger(): void {
    const cfg = this.runConfig;
    if (cfg && this.ledgerDirty.size) {
      const key = runLedgerKey(cfg);
      let out = this.ledgerOut.get(key);
      if (!out) this.ledgerOut.set(key, (out = new Map()));
      for (const id of this.ledgerDirty) {
        const st = this.ledger.get(id);
        if (st) out.set(id, mergeNodeState(out.get(id), st)!);
      }
    }
    this.ledgerDirty.clear();
  }

  /**
   * ⭐ R9-01: ЗАПИСАТЬ СВОД В БАЗУ — всё снятое и ещё не легшее (`mergeRunLedger`: объединение, запись только добавляет). Записи
   * комнаты идут друг за другом; неудача (база) — записи возвращаются в очередь и пробуются снова через `LEDGER_RETRY_MS` и с
   * каждой следующей записью. Не отклоняется: промис — «отправленное легло или отложено».
   */
  private flushLedger(): Promise<void> {
    this.captureLedger();
    if (!this.ledgerOut.size) return this.ledgerWriting;
    const batch = this.ledgerOut;
    this.ledgerOut = new Map();
    const run = this.ledgerWriting.then(async () => {
      for (const [key, recs] of batch) {
        try {
          await mergeRunLedger(key, [...recs.values()]);
        } catch (e) {
          warnLedger(e);
          let out = this.ledgerOut.get(key);
          if (!out) this.ledgerOut.set(key, (out = new Map()));
          for (const [id, st] of recs) out.set(id, mergeNodeState(out.get(id), st)!);
          if (!this.ledgerRetry) {
            this.ledgerRetry = setTimeout(() => { this.ledgerRetry = null; void this.flushLedger(); }, LEDGER_RETRY_MS);
            this.ledgerRetry.unref?.();
          }
        }
      }
    });
    this.ledgerWriting = run;
    this.ledgerInflight++;
    void run.finally(() => { this.ledgerInflight--; });
    for (const key of batch.keys()) {
      let set = ledgerWrites.get(key);
      if (!set) ledgerWrites.set(key, (set = new Set()));
      set.add(run);
      void run.finally(() => { set!.delete(run); if (!set!.size && ledgerWrites.get(key) === set) ledgerWrites.delete(key); });
    }
    return run;
  }

  // ── Области ─────────────────────────────────────────────────────────────────
  private enterTown(): void {
    this.endVote();   // R8-03: вайп и финал возвращают в город — голосование подземелья сюда не переходит
    this.settleLingers();   // R13-03
    const from = this.area;
    this.floorChanged('town');   // R4-06, R4-16
    // ⭐ R7-03: кто ждёт реконнекта сейчас — пережил уход пати в город (сбежавших из боя `buryFled` похоронил до этого): его
    // забег припаркован, как у вышедшего из города. Дальше ни грейс, ни вайп следующего нырка штрафом его не касаются.
    for (const info of this.disconnected.values()) info.safe = true;
    this.reviveAway();   // ⭐ C-03: и оживил — «Завершить» его забега платит, как любой припаркованный
    this.wipeAt = 0; // отменяем ожидающий вайп-таймер
    this.strandAt = 0;   // R12-07: и возврат застрявших — уже в городе
    this.area = 'town'; this.depth = 0; this.decor = [];
    this.spawnIdx.clear();   // монстры узла ушли вместе с этажом; запись узла (`nodeState`) ждёт продолжения
    const t = townLayout();
    this.session.enterFloor(0, { grid: t.grid, spawn: t.spawn, monsters: [] });
    if (from === 'arena') this.leaveArena();   // R11-04: из арены — телом города, а не арены
    this.restock();   // R1-03: сток героя-хозяина — свежий, только если подошёл срок
    for (const pid of this.clients.keys()) {
      const save = this.session.world.players[pid]!.save;
      if (save.run) delete save.run.deadAt;   // ⭐ V1: город оживляет — смерть в забеге позади
      ensureMainQuest(this.cfg, save);
    }
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcastPeerInfo();
    this.resetDeltaBaseline(); // Ф1.3: мир заменён — прошлый базис к нему не применим
    this.broadcast(this.shopFrame());
    this.broadcastQuestBoard();
    for (const pid of this.clients.keys()) this.sendSave(pid); // город мог выдать main-квест
    // Чекпойнт: возврат в город. Из арены — без записи (R1-03): там нет ни добычи, ни штрафа, ни опыта,
    // а круг «город ↔ арена» гонялся десятки раз в секунду — и каждый писал сейвы всех в базу.
    // Если что-то всё же поменялось (выбросил вещь), это допишет ближайший автосейв.
    if (from !== 'arena') this.persistAll();
  }
  /**
   * PvP-арена: круглый зал, урон игрок↔игрок, монстров нет. Игроки расставлены по
   * противоположным концам со спавн-иммунитетом; смерть без штрафа + авто-возрождение.
   * Выход — «В город» (returnTown), как из подземелья.
   */
  private enterArenaFloor(): void {
    this.endVote();   // R8-03
    this.settleLingers();   // R13-03
    this.floorChanged('arena');   // R4-06; R11-04: ушедшие вернутся такими, какими ушли, — не свежими
    this.wipeAt = 0; this.strandAt = 0;
    this.area = 'arena'; this.depth = 0; this.decor = [];
    this.spawnIdx.clear();
    this.arenaRespawns.clear(); this.arenaSpawnByPid.clear();
    // ⭐ R11-04: тело каждого — до полного тела арены (`respawnPlayer` ниже): в город вернётся это (`leaveArena`). Раньше круг
    // «город → арена → город» (два голосования, ~3 с) лечил целиком: здоровье, мана и выносливость, — и так же посреди забега
    // (портал входа → город → арена → город → «Продолжить» того же узла). Зелья и реген между боями были не нужны.
    this.arenaHome.clear();
    const now = this.session.world.timeMs;
    for (const pid of this.clients.keys()) {
      const p = this.session.world.players[pid];
      if (p) this.arenaHome.set(p.save.charId, { state: this.stateOf(p), at: now });
    }
    const a = arenaLayout(ARENA_SIZE);
    this.arenaSpawns = a.spawns;
    this.session.enterFloor(0, { grid: a.grid, spawn: a.spawns[0]!, monsters: [], pvp: true });
    let i = 0;
    for (const pid of this.clients.keys()) {                 // по противоположным концам + иммунитет
      const at = a.spawns[i % a.spawns.length]!;
      this.arenaSpawnByPid.set(pid, at);
      this.session.respawnPlayer(pid, at, ARENA_IMMUNE_MS);
      i++;
    }
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcastPeerInfo();
    this.resetDeltaBaseline(); // Ф1.3: мир заменён — прошлый базис к нему не применим
  }
  /**
   * ⭐ R11-04: КОНЕЦ АРЕНЫ — ТЕЛА ГОРОДА (`arenaHome`). Присутствующий получает то, с чем вошёл на арену, плюс реген и откаты за время
   * боя, как если бы стоял в городе; урон арены (и её полное тело) в город не идёт. Ушедший с арены раньше — его запись ухода
   * теперь тело города, без регена (время для ушедшего стоит, R4-06): вход по коду вернёт его таким, а не полным телом арены.
   */
  private leaveArena(): void {
    const now = this.session.world.timeMs;
    for (const pid of this.clients.keys()) {
      const p = this.session.world.players[pid];
      const home = p && this.arenaHome.get(p.save.charId);
      if (!p || !home) continue;
      this.arenaHome.delete(p.save.charId);
      this.restoreLeft(pid, home.state);
      const dt = Math.max(0, now - home.at) / 1000;
      const d = this.session.snapshotOf(pid)?.derived;
      if (d) {
        p.hp = Math.min(d.maxHp, p.hp + d.hpRegen * dt);
        p.mana = Math.min(d.maxMana, p.mana + d.manaRegen * dt);
        p.stamina = Math.min(d.maxStamina, p.stamina + d.staminaRegen * dt);
      }
      p.attackCd = Math.max(0, p.attackCd - dt); p.dodgeCd = Math.max(0, p.dodgeCd - dt); p.combatTimer = Math.max(0, p.combatTimer - dt);
      for (const k of Object.keys(p.skillCd)) p.skillCd[k] = Math.max(0, (p.skillCd[k] ?? 0) - dt);
    }
    for (const [charId, home] of this.arenaHome) {
      const s = { ...home.state };
      delete s.pos;
      this.left.delete(charId);
      this.left.set(charId, s);
    }
    while (this.left.size > LEFT_MAX) this.left.delete(this.left.keys().next().value!);
    this.arenaHome.clear();
  }

  /** Зелья лавки (R2-04): гарантированный запас (`SHOP_CONSUMABLE_STOCK` каждого) — на каждый заход в город, в каждой комнате свой. */
  private freshConsumables(): Item[] {
    const itemsBase = this.cfg.get('items.base');
    const out: Item[] = [];
    // ⭐ R11-13: только включённые базы (`shopConsumableIds`), как снаряжение кузницы (`rollGear`) и дроп с монстров.
    for (const id of shopConsumableIds(this.cfg)) for (let n = 0; n < SHOP_CONSUMABLE_STOCK; n++) { const p = itemFromBaseId(itemsBase, id, undefined, 'shop'); if (p) out.push(p); }
    return out;
  }

  /**
   * Снаряжение кузницы для стока героя (R1-03): броски тира, редкости и аффиксов — поэтому оно и сток. ⭐ R5-22: бросок —
   * от сида стока (`seed`, из криптографического источника, D10): тот же сид и уровень дают те же вещи в том же порядке на
   * любой ноде. Личность вещи (`uid`) у каждого броска своя — купленная повтором броска не удвоится.
   */
  private rollGear(seed: number, heroLevel: number): Item[] {
    const itemsBase = this.cfg.get('items.base');
    const rarities = this.cfg.get('rarities');
    const tiers = this.cfg.get('item-tiers');
    const affixes = this.cfg.get('affixes');
    const uniques = this.cfg.get('uniques');
    const rng = createRng((seed >>> 0) || 1);
    const level = Math.max(1, heroLevel);
    const loot = this.cfg.get('balance').loot;
    const gear: Item[] = [];
    // Оружие/броня — кузница. Гарантируем товар в КАЖДОЙ вкладке магазина (ближний/дальний/броня):
    // N роллов на категорию по её базам (generateItem с baseId → полноценный ролл: тир/редкость/аффиксы).
    // ⚠ Только ВКЛЮЧЁННЫЕ базы: выключенная база (ещё не в игре) не падает с монстров — не должна и продаваться.
    const on = itemsBase.filter((b) => b.enabled !== false);
    const meleeBases = on.filter((b) => b.kind === 'weapon' && b.attackType === 'melee');
    const rangedBases = on.filter((b) => b.kind === 'weapon' && b.attackType === 'ranged');
    const armorBases = on.filter((b) => b.kind === 'armor' || b.kind === 'shield' || b.kind === 'jewelry');
    const rollFrom = (pool: typeof itemsBase, count: number): void => {
      for (let i = 0; i < count && pool.length; i++) {
        // Меч с прилавка — как с пола: клинок несёт статы своей геометрии (§26).
        gear.push(shapeFoundWeapon(this.cfg, generateItem(itemsBase, affixes, uniques, {
          dropBias: 1.3, itemLevel: level + 1, baseId: rng.pick(pool).id, tiers, rarities,
          // D21: ступень базы — БРОСОК в окне, ровно как у дропа (`rollTierLevel`). Без него прилавок
          // выставлял высшую ступень уровня каждый раз — надёжный кран верхних ступеней для разбора.
          tierLevel: rollTierLevel(level + 1, loot.tierWindow, rng),
          rareNames: this.cfg.get('rare-names'), maxReqTotal: this.cfg.get('balance').maxTotalRequirement, baseRoll: loot.baseRoll,
          // Происхождение (D16): купленное в счётчик мифических находок журнала не идёт.
          origin: 'shop',
          // ⭐ R13-09: УНИКОВ КУЗНИЦА НЕ ПРОДАЁТ («нашёл — носи как есть», ECONOMY.md). Бросок «уник» (2,6% на вещь, у половины
          // прилавков) ставил на полку уник по цене уровня хозяина — секира палача за 284 золота у альта 1-го уровня, её
          // фиксированные аффиксы от уровня не зависят, — и на чужой базе: вкладка теряла вещь. Теперь — редкая вещь этой базы.
          noUnique: true,
        }, rng)));
      }
    };
    rollFrom(meleeBases, 9); rollFrom(rangedBases, 6); rollFrom(armorBases, 9);
    return gear;
  }

  /**
   * Снаряжение и доска квестов — СТОК ГЕРОЯ-ХОЗЯИНА (первого в комнате), см. `townStocks` (R1-03). Пока срок
   * `balance.townRestockSec` не вышел, комната показывает тот же сток — после любых кругов по областям и в любой
   * новой комнате этого героя; вышел — катаем новый. Без хозяина (комната только создана) прилавок пуст: показать
   * его некому, а первый вошедший всё равно получит свой сток (`attach`). Зелья лавки — свежие на каждый вызов
   * (R2-04): зовётся на каждый заход в город и на вход хозяина в новую комнату.
   *
   * ⭐ R5-22: опознание стока — в сейве хозяина (`save.townStock`); карта процесса — кэш тех же вещей (чтобы uid на прилавке
   * не менялись от захода к заходу). Кэша нет или он другого поколения (другая нода, рестарт) — снаряжение собирается
   * заново из сида за вычетом купленного.
   */
  private restock(): void {
    const host = this.firstSave();
    const now = Date.now();
    const ttl = Math.max(0, this.cfg.get('balance').townRestockSec) * 1000;
    sweepTownStocks(now, ttl);
    if (!host) {
      this.stock = { at: now, shop: [], board: [], level: 0, seed: 0, rolled: [], owner: '' };
    } else {
      let ref = stockRef(host.townStock, now, ttl);
      let kept = townStocks.get(host.charId);
      if (kept && (!ref || kept.at !== ref.at)) kept = undefined;   // кэш другого поколения — не этот сток
      if (!ref) {
        ref = host.townStock = { at: now, seed: randomSeed(), level: host.level, bought: [] };
      } else if (host.level > ref.level) {
        // ⭐ R3-17: ХОЗЯИН ВЫРОС — СНАРЯЖЕНИЕ ПО НОВОМУ УРОВНЮ. Сток держит уровень, под который его катали, и новичок,
        // за забег выросший с первого до двадцатого, до конца срока видел в кузнице снаряжение первого уровня (до R1-03
        // прилавок катался заново на каждый заход в город). Перекатывается только снаряжение, доска и срок — прежние.
        // Бесплатным перебросом это не стало: `level` — наибольший уровень, под который катали, и растёт он раз на уровень.
        // ⭐ R9-13: доска — из сида стока, поэтому её сид запоминается ДО перекатки (`board`): доска поколения та же.
        ref.board = boardSeedOf(ref);
        ref.seed = randomSeed(); ref.level = host.level; ref.bought = [];
      }
      if (!kept || kept.seed !== ref.seed) {
        const rolled = this.rollGear(ref.seed, ref.level);
        // ⭐ R9-13: ДОСКА — ИЗ ОПОЗНАНИЯ СТОКА, как снаряжение (R5-22): тот же сид и то же поколение (`at` — метка в id заданий)
        // собирают ту же доску на любой ноде и после рестарта. Раньше на ноде без кэша доска катилась заново (`townRng`): вошёл к
        // альту по коду на соседней ноде, вернулся — и выбирай лучшую из N досок поколения (досягаемый этаж 2 вместо 4, золото
        // втрое); квота шаблона (R3-10) не давала взять шаблон дважды, но не мешала выбрать, какой бросок взять.
        const board = kept?.board ?? generateBoard(this.cfg, createRng(boardSeedOf(ref) || 1), ref.at);
        kept = { at: ref.at, seed: ref.seed, level: ref.level, rolled, shop: [...rolled], board, owner: host.charId };
        townStocks.set(host.charId, kept);
      }
      // Купленное на другой ноде (или в другой комнате) — с прилавка долой и здесь.
      const bought = new Set(ref.bought);
      if (bought.size) { const k = kept; k.shop = k.shop.filter((it) => !bought.has(k.rolled.indexOf(it))); }
      this.stock = kept;
    }
    this.consumables = host ? this.freshConsumables() : [];
    this.shop = [...this.consumables, ...this.stock.shop.filter(this.gearOn())];
    this.questBoard = this.stock.board;
  }

  /**
   * ⭐ R14-09: база вещи стока ещё включена. Выключенную живьём (редактор) сток не выставляет и не продаёт, но и не забывает: включат
   * обратно до срока — она снова на прилавке, как была (опознание стока в сейве её номер помнит, R5-22).
   */
  private gearOn(): (it: Item) => boolean {
    const on = new Set(this.cfg.get('items.base').filter((b) => b.enabled !== false).map((b) => b.id));
    return (it) => on.has(it.baseId);
  }

  /**
   * ⭐ R7-18: СТОК НА ПРИЛАВКЕ — УЖЕ НЕ ТЕКУЩЕЕ ПОКОЛЕНИЕ СВОЕГО ХОЗЯИНА. Сток меняет только `restock`, а он идёт на входе в
   * пустую комнату и на заходе в город: хозяин ушёл, в комнате остался сосед (его альт, друг), — и комната держала старый
   * сток, пока хозяин катал новый в другой комнате (вышел срок, вырос уровень, R3-17). Вернувшись по коду, он покупал и
   * со старого, и с нового: каждое лишнее соединение держало ещё одно поколение, и «один бросок за срок» становился лучшим
   * из N (в том числе бросок ступени, ради которого сток и заведён). Устарел, если: вышел срок; кэш процесса держит для
   * хозяина другое поколение (скатал здесь же, в другой комнате); хозяин в комнате, и его сейв опознаёт другое (другая нода).
   * Хозяин вышел и нового не катал — сток текущий: сосед покупает с него по полной цене, как прежде.
   */
  private stockStale(): boolean {
    const st = this.stock;
    if (!st?.owner) return false;
    const ttl = Math.max(0, this.cfg.get('balance').townRestockSec) * 1000;
    if (ttl <= 0) return false;   // срока нет — сток катается на каждый заход в город, «поколений» нет
    if (Date.now() - st.at >= ttl) return true;
    if (townStocks.get(st.owner) !== st) return true;
    for (const c of this.clients.values()) {
      const s = this.session.world.players[c.pid]?.save;
      if (s?.charId !== st.owner) continue;
      const ref = s.townStock;
      return !ref || ref.at !== st.at || ref.seed !== st.seed;
    }
    return false;
  }

  /**
   * ⭐ R5-22: куплено со стока — номер вещи в броске в опознание стока сейва хозяина: другая нода и новый процесс её уже не
   * выставят. Хозяина в комнате нет (ушёл, а в старой комнате купил сосед) — записать некуда: это покупка по полной цене,
   * а не перебросок, и повтор той же вещи будет уже другой вещью (свой `uid`).
   */
  private noteBought(stock: TownStock, item: Item): void {
    const i = stock.rolled.indexOf(item);
    if (i < 0) return;
    for (const c of this.clients.values()) {
      const s = this.session.world.players[c.pid]?.save;
      if (s?.charId !== stock.owner) continue;
      const ref = s.townStock;
      if (ref && ref.at === stock.at && ref.seed === stock.seed && !ref.bought.includes(i)) ref.bought.push(i);
      return;
    }
  }

  /**
   * Кадр прилавка — с АВТОРИТЕТНОЙ ценой покупки каждой вещи (`shopBuyPrice`, её же спишет `buyItem`). Unity-клиент
   * рисует ценник по ней, а не своей копией формулы: копия не знала надбавки ступени и пола по сырью разбора и
   * показывала «по карману» то, в чём сервер отказывал «Недостаточно золота» (R2-36).
   */
  private shopFrame(): Extract<ServerFrame, { t: 'shop' }> {
    return { t: 'shop', items: this.shop, prices: Object.fromEntries(this.shop.map((it) => [it.uid, shopBuyPrice(this.cfg, it)])) };
  }

  /** Прилавок пересобран (покупка, сток сменился в другой комнате) — показать всем в комнате. */
  private showShop(): void {
    this.shop = [...this.consumables, ...(this.stock?.shop ?? []).filter(this.gearOn())];   // R14-09: выключенная база — не на прилавке
    this.broadcast(this.shopFrame());
  }

  // ── Луп ─────────────────────────────────────────────────────────────────────
  /**
   * Один фиксированный шаг симуляции. Зовёт `tickScheduler`; `emit=false` на промежуточных
   * шагах догона — тогда мир продвигается, но снапшот не рассылается (клиенту нужно актуальное
   * состояние, а не история промежуточных шагов). События рассылаются всегда: они редкие,
   * мелкие и терять их нельзя.
   */
  step(emit = true): void {
    if (this.frozen) return;   // R5-07: снята с планировщика; и вызванный напрямую шаг мир не двигает
    const inputs: Record<string, PlayerInput> = {};
    for (const [pid, c] of this.clients) {
      // ⭐ R4-20: кадры ввода перестали приходить (скрытая вкладка, обрыв) — герой стоит и не бьёт, взгляд тот же. Раньше
      // последний ввод применялся вечно: бежал и махал в монстров, пока игрок не вернётся.
      inputs[pid] = c.inputAge >= INPUT_STALE_TICKS ? { ...idleInput(), facing: c.input.facing } : c.input;
      c.inputAge++;
    }
    // ⭐ R14-01: ТЕЛО В БОЮ ЗАЩИТИТЬ НЕКОМУ — МИР СТОИТ. Подключены одни мёртвые (или никто — шаг, позванный напрямую), а тело ушедшего
    // посреди боя в мире: бой продолжится, когда войдёт живой (он сам — вернётся телом, напарник, вход по коду). Срок тела — время мира:
    // он тоже стоит. Пустая комната и так снята с планировщика (`enterGrace`).
    const halted = this.lingering.size > 0 && !this.livingConnected();
    const events = halted ? [] : this.session.tick(TICK_DT, inputs);
    // R4-19: кадр увиден тиком — нажатия из него сработали; рывок и пояс — только в кадре нажатия, второй раз их нет.
    // ⭐ R5-03: и каст ТОГЛА (аура, стойка) — тоже нажатие: его переключение не «держится», а щёлкает. Он оставался во вводе,
    // и каждый тик без нового кадра (догон планировщика, кадры реже тиков, склейка нажатия с отпусканием) переключал
    // снова — аура включалась и тут же гасла. Удержанный каст атаки держится, как держался.
    for (const c of this.clients.values()) {
      if (c.inputSeen) continue;
      c.inputSeen = true;
      if (c.input.dodge || c.input.useBelt !== undefined) { const { dodge: _d, useBelt: _u, ...held } = c.input; c.input = held; }
      if (c.input.cast != null && this.isToggleNode(c.input.cast)) c.input = { ...c.input, cast: null };
    }
    counters.ticks++;
    if (this.lingering.size && !halted) this.tickLingers();   // R13-03: тела ушедших посреди боя — погибли, отбились, срок вышел
    // Снапшот шлём по СВОЕЙ частоте (Ф1.5) и только на последнем шаге пачки догона (Ф0.2):
    // промежуточные состояния клиенту не нужны, ему нужно актуальное.
    this.snapAcc += TICK_DT;
    if (this.snapAcc >= SNAPSHOT_DT) {
      this.snapAcc -= SNAPSHOT_DT;
      if (this.snapAcc > SNAPSHOT_DT) this.snapAcc = 0; // сильно отстали — не копим долг кадров
      if (emit) this.emitWorld();
    }
    if (Date.now() - this.lastSaveAt >= AUTOSAVE_MS) this.persistAll(); // периодический автосейв прогресса
    this.flushTelemetry();   // Ф3.2: длинная сессия должна быть видна ДО своего конца
    if (this.wipeAt && Date.now() >= this.wipeAt) this.enterTown(); // вайп → авто-возврат в город
    if (this.strandAt && Date.now() >= this.strandAt) this.leaveStranded();   // R12-07: живых в пати не осталось — в город
    if (this.area === 'arena' && this.arenaRespawns.size) this.tickArenaRespawns(); // авто-возрождение в PvP
    if (!events.length) return;

    const touched = new Set<string>();
    const quest: SessionEvent[] = [];
    let nodeChanged = false;
    for (const e of events) {
      if (e.type === 'gold' || e.type === 'xp' || e.type === 'levelup' || e.type === 'item-picked' || e.type === 'materials') touched.add(e.playerId);
      this.observe(e);   // Ф3.2: наблюдения о поведении, на саму игру не влияют
      if (this.noteNode(e)) nodeChanged = true;   // R4-01: убитые и открытое — в запись узла
      if (e.type === 'monster-died' && e.by) this.track(e.by, 'kill', e.def.id, touched, quest);
      // R4-26: своё выброшенное и поднятое снова «собранным» не считается — иначе «собрать N» закрывала одна вещь.
      else if (e.type === 'item-picked' && !e.thrown) this.track(e.playerId, 'collect-item', e.item.baseId, touched, quest);
      else if (e.type === 'player-died') { if (this.area === 'arena') this.onArenaDeath(e.playerId); else this.onPlayerDeath(e.playerId, touched); }
    }
    if (nodeChanged) this.syncNodeState();
    this.broadcast({ t: 'events', events: quest.length ? [...events, ...quest] : events });
    for (const pid of touched) this.sendSave(pid);
    if (events.some((e) => e.type === 'levelup')) { this.persistAll(); this.broadcastPeerInfo(); } // левелап — фиксируем в БД и обновляем статику (макс. HP)
  }

  /** R5-03: узел древа — тогл (аура, стойка): его каст срабатывает по нажатию, а не удержанием. Та же мера, что у клиента. */
  private isToggleNode(nodeId: string): boolean {
    const cat = activeAbilityOf(this.cfg, nodeId)?.category;
    return cat === 'aura' || cat === 'stance';
  }

  /**
   * Смерть игрока: штраф (часть золота + часть инвентаря), окно смерти клиенту.
   * СОЛО или вайп пати → возврат в город (все возрождаются). КООП → игрок ждёт мёртвым;
   * возродится на СЛЕДУЮЩЕМ этаже, когда пати спустится (`enterFloor` оживляет мёртвых).
   */
  private onPlayerDeath(pid: string, touched: Set<string>): void {
    const p = this.session.world.players[pid];
    const c = this.clients.get(pid);
    if (!p || !c) return;
    const summary = applyDeathPenalty(p.save, this.cfg.get('balance').deathPenalty, townRng());
    this.markDead(p.save);   // ⭐ V1: смерть оплачена — и в сейве, одной записью со штрафом
    touched.add(pid); // отправить урезанные золото/инвентарь через saveUpdate

    // Соло = «вайп» на 1 игрока. Вайп → авто-возврат в город ЧЕРЕЗ таймер (окно смерти видно ~4с;
    // мгновенный enterTown закрыл бы окно тем же тиком). Кооп без вайпа → игрок ждёт, оживёт на след. этаже.
    const allDead = Object.values(this.session.world.players).every((pl) => !pl.alive);
    this.send(c.ws, { t: 'died', goldLost: summary.goldLost, itemsLost: summary.itemsLost, toTown: allDead });
    if (allDead) this.wipe();
    // ⭐ R14-01: погиб последний живой подключённый, а в бою стоит тело ушедшего — мир встал (`halted`), и решать больше некому тику тел
    // (`tickLingers`): застрявшие ждут отвалившегося, как ждали бы после его ухода (`checkStranded`).
    else this.checkStranded();
  }

  /**
   * ВАЙП ПАТИ: возврат в город таймером (окно смерти видно ~4 с; мгновенный `enterTown` закрыл бы его тем же тиком).
   * ВАЙП = ЗАБЕГ ОКОНЧЕН. Раньше здесь чистились только отключённые, а `save.run` живых оставался со старым узлом: возврат в город
   * идёт через `enterTown`, а тот забег не трогает (его чистил только `finishRun` на финале). Из-за этого после гибели реконнект
   * предлагал «продолжить» и высаживал на том же этаже, где убили — со всем живым прогрессом этажа. Кооп без вайпа сюда не попадает:
   * там забег идёт дальше, а мёртвый оживает на следующем этаже.
   * ⭐ R8-03: и голосование закрывается — спуск, позванный до вайпа, «за» мёртвых начинал бы новый забег из окна смерти.
   */
  private wipe(): void {
    this.wipeAt = Date.now() + WIPE_RETURN_MS;
    this.strandAt = 0; this.strandWait = false;
    this.endVote();
    const run = this.runConfig;   // ⭐ C-04: хоронится участник ЭТОГО забега — `endRun` его сейчас снимет
    this.endRun();
    this.finalizeDisconnectedAsDead(run); // пати вайпнулась → отключённые тоже погибли
  }

  /** ⭐ R12-07: в подземелье подключены только мёртвые (и хоть кто-то), вайпа не ждём — пати застряла (см. `checkStranded`). */
  private stranded(): boolean {
    if (this.area !== 'dungeon' || this.wipeAt || this.clients.size === 0) return false;
    for (const pid of this.clients.keys()) if (this.session.world.players[pid]?.alive !== false) return false;
    return true;
  }

  /** ⭐ R14-01: подключён хоть один живой — мир с телами в бою идёт (`step`). */
  private livingConnected(): boolean {
    for (const pid of this.clients.keys()) if (this.session.world.players[pid]?.alive !== false) return true;
    return false;
  }

  /** ⭐ R13-01: ждёт реконнекта ушедший живым посреди боя (не у портала), чей уход пати ещё не решила. */
  private fledAway(): boolean {
    for (const i of this.disconnected.values()) if (i.fled && !i.paid && !i.safe) return true;
    return false;
  }

  /** ⭐ R13-02: ждёт реконнекта ушедший с ЭТОГО этажа живым и спокойно — забег пати без живых держится на нём. */
  private calmAway(): boolean {
    for (const i of this.disconnected.values()) if (!i.fled && !i.paid && !i.safe) return true;
    return false;
  }

  /**
   * ⭐ R13-05: СТАТУС ОКНА СМЕРТИ — `died` с `status`: потерь в нём нет (их нёс кадр самой смерти), клиент меняет только строку режима
   * и не открывает окно, закрытое «Смотреть». Раньше статусом служил сам `died {0, 0}` — оба клиента строили по нему окно заново:
   * настоящие потери подменялись нулями, закрытое окно вставало посреди экрана (у «возвращаетесь в город» — без кнопки), и так на
   * каждую перезагрузку напарника. `canLeave` — живых подключённых нет, а пати ждёт отвалившегося посреди боя: увести её в город
   * может и мёртвый (`return`).
   */
  private deathStatus(toTown: boolean, canLeave = false): ServerFrame {
    return { t: 'died', goldLost: 0, itemsLost: 0, toTown, status: true, ...(canLeave ? { canLeave: true } : {}) };
  }

  /**
   * ⭐ R12-07: ПОСЛЕДНИЙ ЖИВОЙ УШЁЛ — МЁРТВЫЕ НЕ ЖДУТ ВЕЧНО. Решение «вайп» принималось только на смерти (`onPlayerDeath`): A погиб
   * при живом B и ждёт пати, B закрыл вкладку (выход, выселение, снятие сессии) — и A стоял мёртвым в подземелье, пока жива комната:
   * до портала мёртвому не дойти, окно смерти предлагало только «Смотреть», а «Продолжить» возвращало в то же ожидание. Выход был
   * только «Завершить» (штраф за целый забег) — а модифицированному клиенту хватало `return` (мёртвому можно, `canLeave`): честный
   * оказывался хуже читера. Теперь пати уходит в город сама, как ушла бы голосованием (`leaveStranded`), а мёртвым — окно «возвращаетесь
   * в город».
   * ⭐ R13-01: НО ЧЕРЕЗ `STRAND_RETURN_MS` — ТОЛЬКО ЕСЛИ ХОРОНИТЬ НЕКОГО. Ушедший ПОСРЕДИ БОЯ (`fled`) ждёт весь грейс, как в пустой
   * комнате (R4-06: F5 — не бегство и не наказание): раньше 15 с возврата хоронили его со штрафом, стоило мёртвому напарнику держать
   * вкладку (или заглянуть «Продолжить»), — пока он перезагружал страницу. Мёртвым тогда — «ждите», и выход по своему решению: «В город»
   * (`canLeave`). `'told'` — возврат назначен (или пересчитан) сейчас и мёртвым разослан; `'quiet'` — назначен раньше; `false` — не застряли.
   */
  private checkStranded(): 'told' | 'quiet' | false {
    if (!this.stranded() || this.frozen) return false;
    const wait = this.fledAway();
    if (this.strandAt && this.strandWait === wait) return 'quiet';
    const graceMs = Math.min(Math.max(0, this.cfg.get('balance').reconnectGraceSec) * 1000, MAX_TIMER_MS);
    this.strandAt = Date.now() + (wait ? graceMs : STRAND_RETURN_MS);
    this.strandWait = wait;
    for (const c of this.clients.values()) this.send(c.ws, this.strandStatus());
    return 'told';
  }

  /** R12-07, R13-01: окно застрявших — «возвращаетесь в город» или (ждём отвалившегося посреди боя) «ждите — или в город сами». */
  private strandStatus(): ServerFrame {
    return this.deathStatus(!this.strandWait, this.strandWait);
  }

  /** R12-07: возврат застрявших отменён — вошёл живой. Мёртвым — снова «ждите пати». */
  private cancelStranded(): void {
    if (!this.strandAt || this.stranded()) return;
    this.strandAt = 0; this.strandWait = false;
    for (const c of this.clients.values()) {
      if (this.session.world.players[c.pid]?.alive === false) this.send(c.ws, this.deathStatus(false));
    }
  }

  /** R12-07: срок вышел — пати без живых уходит в город (`leaveDead`). */
  private leaveStranded(): void {
    this.strandAt = 0; this.strandWait = false;
    if (!this.stranded()) return;
    this.leaveDead();
  }

  /**
   * ⭐ R13-02: ПАТИ БЕЗ ЖИВЫХ УХОДИТ С ЭТАЖА (вышел срок возврата застрявших или мёртвые проголосовали «в город»). Сбежавшие из боя
   * похоронены (R4-14). Остался в пати хоть один ушедший с этажа спокойно — забег припаркован, как припарковал бы его уход порталом.
   * Не остался — это ВАЙП: забег окончен у всех, как если бы последний живой погиб, а не закрыл вкладку. Раньше пати, где все мертвы
   * или сбежали, уходила «голосованием»: сбежавший платил штраф, а забег мёртвого оставался припаркованным — закрыть вкладку при 1 HP
   * вместо смерти превращало вайп в «штраф смерти и забег цел» (вход к напарнику по коду — и оба снова на том же узле).
   */
  private leaveDead(): void {
    this.buryFled();   // R4-14: сбежавшие из боя отключением в город не уходят даром
    if (this.calmAway()) { this.enterTown(); return; }
    this.wipe();
    this.enterTown();
  }

  /** ⭐ R13-03: тело в бою с этим id сущности (`removePlayer`). */
  private lingerOf(pid: string): Linger | undefined {
    for (const l of this.lingering.values()) if (l.pid === pid) return l;
    return undefined;
  }

  /**
   * ⭐ R13-03: ТЕЛО УХОДИТ ИЗ МИРА. Погибло — штраф смерти его копии (раз: `paid`, R3-06), дальше он «ушёл мёртвым»; живое — бегство
   * (`fled`, `fledDescend`) — по концу боя: отбился (монстров на нём нет) — ушёл спокойно. Запись ухода (R4-06) — с тела: вернётся
   * таким. `write` — дописать копию прощальной записью (`onFarewell`), если бой её изменил (штраф, опыт за добитого его ядом); вернулся
   * он сам (`attach`) — не нужно: копию берёт его новая сессия.
   */
  private endLinger(charId: string, write = true): Linger | undefined {
    const l = this.lingering.get(charId);
    if (!l) return undefined;
    this.lingering.delete(charId);
    const { pid, p, info } = l;
    this.session.saveHeld.delete(pid);
    if (this.session.world.players[pid] === p) {
      if (!p.alive) {
        if (!info.paid) applyDeathPenalty(info.save, this.cfg.get('balance').deathPenalty, townRng());
        this.markDead(info.save);   // V1
        info.paid = true; info.fled = false; info.fledDescend = false;
      } else {
        const danger = this.inDanger(p);
        info.fled = danger && !this.canLeave(pid);
        info.fledDescend = danger && !(this.session.world.exits ?? []).some((e) => this.stands(pid, e));
      }
      this.noteLeft(p);
      this.session.removePlayer(pid);
      this.broadcast({ t: 'peerLeft', id: pid });
    }
    if (write && this.disconnected.get(charId) === info && saveSig(info.save) !== l.sig) {
      const retry = (): Promise<WriteResult> => this.persistDisconnected(charId, info);
      const farewell = retry().then((r) => this.farewellOf(r, retry));   // до вызова: `?.()` без хука аргументы не вычисляет
      this.hooks.onFarewell?.(charId, farewell);
    }
    return l;
  }

  /**
   * R13-03: шаг тел в бою — погибло, срок вышел или бой кончился (его никто не целит и ничто не жжёт) — тело уходит. Погибло, и живых в
   * мире не осталось, — вайп, как если бы он погиб подключённым; иначе — пересчёт возврата застрявших.
   */
  private tickLingers(): void {
    const now = this.session.world.timeMs;
    let died = false, ended = false;
    for (const [charId, l] of [...this.lingering]) {
      if (l.p.alive && now < l.until && this.inDanger(l.p)) continue;
      if (!l.p.alive) died = true;
      ended = true;
      this.endLinger(charId);
    }
    if (!ended || this.clients.size === 0) return;
    if (died && Object.values(this.session.world.players).every((pl) => !pl.alive)) {
      this.wipe();
      for (const c of this.clients.values()) this.send(c.ws, this.deathStatus(true));
      return;
    }
    this.checkStranded();
  }

  /**
   * R13-03: все тела в бою — из мира: пати уходит с этажа, отключённых хоронят, процесс уходит. Копию дописывает то, что идёт следом
   * (похороны, спуск, слив), — здесь только её итог боя (`endLinger`).
   */
  private settleLingers(): void {
    for (const charId of [...this.lingering.keys()]) this.endLinger(charId);
  }

  /** Гибель в PvP-арене: без штрафа, окно «наблюдения» + авто-возрождение через ARENA_RESPAWN_MS. */
  private onArenaDeath(pid: string): void {
    const c = this.clients.get(pid);
    if (!c) return;
    this.send(c.ws, { t: 'died', goldLost: 0, itemsLost: 0, toTown: false, pvp: true });
    this.arenaRespawns.set(pid, Date.now() + ARENA_RESPAWN_MS);
  }
  /** Тик авто-возрождений арены: воскрешает игроков, чей таймер истёк, на их конце со спавн-иммунитетом. */
  private tickArenaRespawns(): void {
    const now = Date.now();
    for (const [pid, at] of [...this.arenaRespawns]) {
      if (now < at) continue;
      this.arenaRespawns.delete(pid);
      const p = this.session.world.players[pid];
      if (!p) continue;                          // игрок вышел — просто снимаем таймер
      const spawn = this.arenaSpawnByPid.get(pid) ?? this.arenaSpawns[0];
      if (spawn) this.session.respawnPlayer(pid, spawn, ARENA_IMMUNE_MS);
    }
  }

  /**
   * ЕДИНСТВЕННАЯ точка записи сейва живого игрока (Ф0.3). Предъявляет версию, которую держит
   * эта сессия, и запоминает новую. Отказ по версии означает, что нашу копию кто-то обогнал — на исправном
   * сервере такого быть не может (реестр живых сессий это исключает), поэтому шумим в лог и СНИМАЕМ сессию
   * (R1-01, `dropStale`): играть копией, которую уже нельзя записать, — это зомби и дюп через соседа по пати.
   *
   * `account` — если передан, сейв и сундук пишутся ОДНОЙ транзакцией (Ф0.4) с проверкой версии
   * сундука (D8). `reason` — причина для журнала вещей (D9), по умолчанию `autosave`.
   *
   * Никогда не отклоняется: ошибка базы — это итог (`WriteResult`) и строка в логе, а не исключение. Иначе
   * `void this.persist(...)` превращал бы любой сбой базы в необработанный отказ промиса,
   * а тот по умолчанию роняет весь процесс вместе со всеми комнатами.
   */
  private persist(pid: string, account?: LoadedStash, reason?: string): Promise<WriteResult> {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (!c || !p) return Promise.resolve('conflict');
    // ОЧЕРЕДЬ НА ПЕРСОНАЖА. Запись стала асинхронной (Ф2), а версия сейва — это счётчик,
    // который надо прочитать, предъявить и обновить. Две записи внахлёст предъявили бы одну
    // и ту же версию: вторая гарантированно получила бы отказ и потеряла бы свои изменения.
    // Поэтому записи одного клиента идут строго друг за другом.
    return this.queued(c, () => this.write(c, p, account, reason));
  }

  /**
   * Сама запись — звать ТОЛЬКО изнутри очереди игрока (`persist` / `transact`).
   *
   * R2-02: леджер отклонил запись из-за вещи чужого аккаунта или отозванной — вещь изымается (`confiscate`), и
   * запись повторяется. R2-09: исход фиксации неизвестен (база записала, а ответ потерян, — слой базы уже сверил
   * строку и не смог решить) — живую сессию снимаем (`dropStale`), а не пишем и не откатываем её память наугад.
   * `subjects` — вещи действия транзакции (`transact`): дописке «до действия» (`keepUnknown`) их причина не нужна.
   */
  private async write(
    c: Client, p: PlayerEntity, account: LoadedStash | undefined, reason = 'autosave', before?: string, subjects: readonly string[] = [],
  ): Promise<WriteResult> {
    // Снятая сессия (R1-01, R2-05, R2-09) права писать не имеет — даже записью, вставшей в очередь до снятия.
    if (c.stale) return 'conflict';
    this.noteVitals(p);   // R11-04: здоровье, мана, выносливость — в сейв: новая комната (другая нода, рестарт) возьмёт их отсюда
    for (let attempt = 0; ; attempt++) {
      // Причины по вещи (D9, R2-21) — снимком: что успеют пометить, пока запись в пути, уйдёт следующей.
      const reasons = new Map(c.reasons);
      const out = this.heldOut(p.save.charId, p.save);   // ⭐ V-B2-04: выброшенное, которого в снимке этой записи нет
      try {
        if (account) {
          const res = await putCharacterWithStash(p.save.charId, c.userId, p.save, c.saveVersion, account.stash, account.version, reason, reasons);
          if (res.ok) {
            c.saveVersion = res.version; account.version = res.stashVersion; c.unsure = []; c.writeFailedAt = 0; this.settleReasons(c, reasons);
            this.releaseHeld(p.save.charId, out);
            return 'ok';
          }
          if (res.conflict === 'stash') {
            // Законный случай: другой герой этого аккаунта тронул сундук раньше. Не записано НИЧЕГО.
            counters.stashConflicts++;
            console.warn(`[room ${this.code}] сундук аккаунта ${c.userId} обогнали (версия ${account.version}), запись ${p.save.charId} (${reason}) откатывается`);
            return 'conflict';
          }
        } else {
          const next = await putCharacter(p.save.charId, c.userId, p.save, c.saveVersion, reason, reasons);
          if (next !== null) { c.saveVersion = next; c.unsure = []; c.writeFailedAt = 0; this.settleReasons(c, reasons); this.releaseHeld(p.save.charId, out); return 'ok'; }
        }
        // ⭐ R14-04: отказ по версии после записей с неизвестным исходом — легла ли одна из них (V3: любая)? Легла — версия её, пишем поверх
        // (копия — её продолжение).
        if (c.unsure.length) {
          const landed = await landedOf(p.save.charId, c.unsure, c.saveVersion);
          if (landed !== null) { c.saveVersion = landed; continue; }
        }
        counters.saveConflicts++;
        console.error(`[room ${this.code}] ОТКЛОНЁН устаревший сейв ${p.save.charId} (версия ${c.saveVersion}) — этот процесс держит копию, которую кто-то обогнал; сессия снята`);
        this.dropStale(c, 'lost');
        this.forfeitHeld(p.save.charId);   // V-B2-04: правда — строка базы, выброшенное — в ней
        return 'conflict';
      } catch (e) {
        if (e instanceof LedgerViolation && attempt < 2 && this.confiscate(c, p.save, account?.stash, e)) continue;
        // ⭐ R4-10: взаимоблокировка (40P01) или сбой сериализации (40001) — транзакция откатана целиком, повтор безопасен.
        // Раньше это был `failed` до следующего автосейва: слив ноды в этом окне оставлял переданную соседу по аккаунту
        // вещь у обоих, а полученную — ни у кого.
        if (isTxRetryable(e) && attempt < 2) continue;
        counters.saveErrors++;
        if (e instanceof CommitUnknown) {
          console.error(`[room ${this.code}] запись сейва ${p.save.charId} (${reason}): исход фиксации неизвестен — сессия снята, копия ждёт дописки`, e);
          noteUnsure(c.unsure, e.sent);   // ⭐ R14-04: снимок этой записи — следующая запись копии узнает по нему, что она легла (V3: к прежним)
          // R11-03: копию — менеджеру «на дописать», до снятия. ⭐ V1: в подземелье — копией ждущего реконнекта (`parkStale`): она и дописывается.
          if (!this.parks()) this.keepUnknown(c, p.save, account, reason, before, reasons, subjects);
          this.dropStale(c, 'unknown');
          return 'unknown';
        }
        // ⭐ R3-02: ДАННЫЕ, КОТОРЫЕ БАЗА НЕ ПРИМЕТ НИКОГДА (класс 22: U+0000 и непарный суррогат в jsonb, 0x00 в тексте).
        // Раньше это был обычный `failed`: сессия играла дальше копией, которую нельзя записать, — выбрасывала вещи соседу
        // по аккаунту, а прощальная копия оставалась у менеджера «на дописать» и каждый вход отвечал «сохраняем».
        // Рестарт терял копию — сейв до отравления возвращал выброшенное (дюп) и откатывал неудачные броски. Писать эту
        // копию нечем — снимаем сессию (4009), как устаревшую: вход прочитает последний записанный сейв. Не записано
        // ничего — значит и `conflict`: прощальной записи догонять нечего.
        if (isDataException(e)) {
          console.error(`[room ${this.code}] сейв ${p.save.charId} (${reason}) база не примет никогда — сессия снята, герой вернётся к последней записи:`, e);
          this.dropStale(c, 'lost');
          this.forfeitHeld(p.save.charId);   // V-B2-04
          return 'conflict';
        }
        warnSave(`[room ${this.code}] запись сейва ${p.save.charId} (${reason}) упала`, e);   // ⭐ C-07: в меру
        c.writeFailedAt = Date.now();
        return 'failed';
      }
    }
  }

  /**
   * ⭐ R11-03: ИСХОД ФИКСАЦИИ ЖИВОЙ СЕССИИ НЕИЗВЕСТЕН — КОПИЯ НЕ ВЫБРАСЫВАЕТСЯ, А ОСТАЁТСЯ МЕНЕДЖЕРУ «НА ДОПИСАТЬ». Раньше сессия
   * снималась (`dropStale`) вместе с единственной копией того, что герой успел отдать: A выбросил меч соседу по аккаунту B, запись B
   * легла, а фиксация A потерялась и не легла (база упала, переключение, обрыв) — вход A читал строку до выброса, и меч был у двоих
   * (прощальная запись с тем же исходом копию держала — R2-08, R3-19, а живая сессия — нет). Теперь прощание снятой сессии —
   * дописка этой копии с ТОЙ ЖЕ версией (`staleFarewells` → `removePlayer` → менеджер: `unsaved`, вход отвечает «сохраняем», пока
   * она не ляжет, фон дописывает, чужая нода — забывает). Легла прежняя фиксация — дописке отказ по версии: правда уже в базе.
   * Запись с сундуком: отказ по сундуку значит, что прежняя фиксация не легла (сейв и сундук — одна транзакция), а сундук обогнал
   * другой герой аккаунта, — дописывается сейв ДО действия (`before`): действие не состоялось, а всё до него — да.
   * ⭐ R12-12: ПРИЧИНЫ ПО ВЕЩИ (`reasons` — снимок той записи, R2-21) едут и в дописку. Раньше она шла одной причиной действия: купленное
   * и поднятое с прошлой записи журнал вещей подписывал ковкой (перекладкой, разбором) — аудит терял его из добычи и видел «кузнеца-
   * выброс», а проданное уходило «разбором» в план отката. Сейв «до действия» — без вещей самого действия (`subjects`): его не было.
   * ⭐ R14-04: «ЛЕГЛА ПРЕЖНЯЯ ФИКСАЦИЯ» — ЕЩЁ НЕ «ПРАВДА В БАЗЕ». Легла она со СНИМКОМ, снятым в начале записи, а копия — живой сейв на
   * миг снятия: пока фиксация висела (синхронная реплика, переключение), герой успел выбросить вещь соседу по аккаунту, и запись соседа
   * легла, — отказ по версии выбрасывал копию, и вещь оставалась в обеих строках. Теперь отказ по версии сверяет строку с отправленным
   * снимком (`sent`, `landedVersion`): легла именно она — копия пишется поверх её версии (сундук лёг с ней же — пишется только сейв);
   * строку сдвинул кто-то другой — отказ, как прежде.
   */
  private keepUnknown(
    c: Client, save: SaveState, account: LoadedStash | undefined, reason: string, before: string | undefined,
    reasons: ReadonlyMap<string, string>, subjects: readonly string[],
  ): void {
    if (this.clients.get(c.pid) !== c) return;   // уже снята (выход): её прощальная запись держит копию сама (R2-08)
    const charId = save.charId, userId = c.userId;
    let version = c.saveVersion;
    /**
     * Что дописывается: сейв и сундук записи (`tx`), сейв ДО действия (`pre`: сундук обогнал другой герой аккаунта — действие не
     * состоялось, сундук с тех пор чужой навсегда) или только сейв (`save`: запись без сундука — и поверх легшей записи с сундуком).
     */
    let mode: 'tx' | 'pre' | 'save' = account ? 'tx' : 'save';
    /**
     * ⭐ R14-04, V3: снимки записей с неизвестным исходом от версии `version` (`noteUnsure`) — копии целиком (`full`: сама запись и дописки
     * копии) и сейва «до действия» (`pres`). Легла копия целиком — действие в базе, дальше пишется сейв поверх её версии; легла «до
     * действия» — она и есть копия. Раньше снимок был один и их не различали: легший сейв «до действия» сходил за легшее действие, и поверх
     * писался сейв ПОСЛЕ действия без сундука — взятое из сундука оставалось и в сундуке, а положенное в него пропадало.
     */
    const full = [...c.unsure], pres: string[] = [];
    const preReasons = new Map(reasons);
    for (const u of subjects) preReasons.delete(u);
    const stash = account ? { data: account.stash, version: account.version } : undefined;
    const seized = new Set<string>();   // изъятое леджером (R2-02) — и из сейва до действия
    /** Отказ по версии — какая запись с неизвестным исходом легла: копия целиком (`full`, её версия — дальше только сейв) или «до действия». */
    const landed = async (): Promise<'full' | 'pre' | null> => {
      const v = await landedOf(charId, full, version);
      if (v !== null) { version = v; pres.length = 0; return 'full'; }
      const w = await landedOf(charId, pres, version);
      if (w !== null) { version = w; return 'pre'; }
      return null;
    };
    /** Выброшенное, которого нет в снимке последней отправленной записи (V-B2-04): её успех снимает метки. */
    let out: string[] = [];
    const put = async (): Promise<WriteResult> => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (mode === 'tx' && stash) {
            out = this.heldOut(charId, save);
            const res = await putCharacterWithStash(charId, userId, save, version, stash.data, stash.version, reason, reasons);
            if (res.ok) return 'ok';
            if (res.conflict === 'stash') { mode = 'pre'; continue; }
            if (await landed() === 'full') { mode = 'save'; continue; }   // легла сама запись — и сундук с ней: дальше только сейв
            return 'conflict';
          }
          if (mode === 'pre') {
            const pre = structuredClone(save);
            if (before) rollbackCmd(pre, before);
            stripItems(pre, undefined, seized);
            out = this.heldOut(charId, pre);
            if (await putCharacter(charId, userId, pre, version, 'autosave', preReasons) !== null) return 'ok';
            const got = await landed();
            if (got === 'full') { mode = 'save'; continue; }   // фиксация дошла, пока писали сейв «до действия», — действие легло: пишем его
            return got === 'pre' ? 'ok' : 'conflict';   // лёг сейв «до действия» — он и есть копия
          }
          out = this.heldOut(charId, save);
          if (await putCharacter(charId, userId, save, version, reason, reasons) !== null) return 'ok';
          if (await landed() === 'full') continue;
          return 'conflict';
        } catch (e) {
          if (isTxRetryable(e) && attempt < 2) continue;   // R4-10: откатано целиком, повтор безопасен
          if (e instanceof LedgerViolation && attempt < 2) {   // R2-02: вещь, которую леджер не пустит, — изъять и повторить
            for (const id of e.itemIds) seized.add(id);
            if (stripItems(save, stash?.data, seized) || stash) continue;
          }
          if (isDataException(e)) return 'conflict';        // R3-02: такую копию база не примет никогда — правда в базе
          console.error(`[room ${this.code}] дописка копии ${charId}, снятой с неизвестным исходом фиксации, упала:`, e);
          if (e instanceof CommitUnknown) noteUnsure(mode === 'pre' ? pres : full, e.sent);   // R14-04, V3: и у самой дописки — её снимок
          return e instanceof CommitUnknown ? 'unknown' : 'failed';
        }
      }
    };
    // ⭐ V-B2-04: копия легла — выброшенное без неё больше не её строки; проиграла — оно в строке базы, с земли его долой.
    const retry = async (): Promise<WriteResult> => {
      const r = await put();
      if (r === 'ok') this.releaseHeld(charId, out);
      else if (r === 'conflict') this.forfeitHeld(charId);
      return r;
    };
    this.staleFarewells.set(c.pid, { charId, farewell: this.farewellOf('unknown', retry) });
  }

  /**
   * ⭐ R11-04: ЗДОРОВЬЕ, МАНА, ВЫНОСЛИВОСТЬ — В СЕЙВ (`save.vitals`, пишет каждая запись). Запись ухода (`LeftState`, R4-06) живёт
   * в комнате, и вход в НОВУЮ (выйти из города и «Продолжить», вход на другой ноде, рестарт) заводил сущность с полными пулами — на
   * тот же узел забега: зелья и реген между боями не были нужны вовсе. Мёртвый — без записи (оживает полным, штраф уже взят).
   * На арене пишется тело ГОРОДА (`arenaHome`): полное тело арены из неё не уносится. Сущность, уже снятая с мира (прощальная запись
   * в очереди), — не трогается: её пулы записаны при уходе (`noteLeft`), пока комната ещё стояла там, откуда он ушёл.
   */
  private noteVitals(p: PlayerEntity): void {
    if (this.session.world.players[p.id] !== p) return;
    const home = this.area === 'arena' ? this.arenaHome.get(p.save.charId)?.state : undefined;
    const s = home ?? p;
    if (s.alive) p.save.vitals = { hp: s.hp, mana: s.mana, stamina: s.stamina, at: Date.now() };
    else delete p.save.vitals;
  }

  /** Записанные причины снимаются; помеченное заново, пока запись была в пути, ждёт следующей. */
  private settleReasons(c: Client, sent: ReadonlyMap<string, string>): void {
    for (const [uid, why] of sent) if (c.reasons.get(uid) === why) c.reasons.delete(uid);
  }

  /**
   * ⭐ R2-02: ВЕЩЬ, КОТОРУЮ ЛЕДЖЕР НЕ ПУСТИТ, ИЗЫМАЕТСЯ — из сейва (и сундука этой записи) на месте, игроку —
   * сообщение и свежий сейв, запись — повторяется. Раньше отказ леджера просто глотался: каждая следующая запись
   * игрока падала на той же вещи, и на выходе он терял всё с момента, как она появилась, — а продав её, снова
   * писался: канал «вещь чужого аккаунта → золото». Вещь остаётся за своим аккаунтом, дюпа нет.
   * Возвращает, было ли что изымать (нечего — повторять незачем).
   */
  private confiscate(c: Client, save: SaveState, stash: AccountStash | undefined, e: LedgerViolation): boolean {
    const n = stripItems(save, stash, new Set(e.itemIds));
    if (!n) return false;
    counters.ledgerConfiscated += n;
    console.error(`[room ${this.code}] леджер отклонил запись ${save.charId}: ${e.message} — изъято вещей: ${n}, запись повторяется`);
    if (this.clients.get(c.pid) === c) {
      this.send(c.ws, { t: 'error', code: 'ledger', msg: 'Вещь с чужого аккаунта изъята: передавать вещи между аккаунтами нельзя' });
      this.sendSave(c.pid);
    }
    return true;
  }

  /**
   * ⭐ СЕССИЯ ПОТЕРЯЛА ПРАВО ПИСАТЬ (R1-01). База отказала по версии сейва: этого героя записал кто-то другой
   * («Завершить» из другой вкладки, отзыв вещи или откат администратором, вход на другой ноде). Раньше сессия
   * лишь шумела в лог и играла дальше — ЗОМБИ: ни одна её запись больше не проходила, а в памяти она могла снять
   * оружие и бросить его соседу по пати, чей сейв писался честно, — вещь оказывалась у обоих. Теперь такая
   * сессия снимается сразу, без прощальной записи и без грейса (писать ей нечем), сокет закрывается кодом 4009,
   * и клиент входит заново — уже из базы. Закрытие сокета дойдёт до менеджера позже: `removePlayer` к тому
   * времени ничего не найдёт и ничего не запишет.
   * ⭐ V1: `keep` — сессию снимает ЕЁ ЗАПИСЬ (исход неизвестен — `unknown`; отказ по версии, класс 22 — `lost`): в подземелье герой остаётся
   * ждать реконнекта (`parkStale`). `fence` (правда о герое на чужой ноде) — без него.
   */
  private dropStale(c: Client, keep?: 'unknown' | 'lost'): void {
    if (this.clients.get(c.pid) !== c) return;   // уже снята (выход, выселение)
    c.stale = true;
    counters.sessionsStale++;
    void this.writeTelemetry(c, true);
    const p = this.session.world.players[c.pid];
    if (p) this.noteLeft(p);   // R4-06: вход заново (из базы) в эту же комнату — таким, каким сняли
    if (p && keep && this.parks()) this.parkStale(c, p, keep);
    this.session.removePlayer(c.pid);
    this.clients.delete(c.pid);
    this.peerSent.delete(c.pid);
    try { c.ws.close(WS_STALE, 'stale'); } catch { /* уже закрыт */ }
    this.broadcast({ t: 'peerLeft', id: c.pid });
    if (this.vote) { this.vote.yes.delete(c.pid); this.vote.no.delete(c.pid); this.checkVote(); }
    if (this.clients.size === 0) {
      if (this.disconnected.size > 0) this.enterGrace();
      else { this.stop(); this.hooks.onEmpty(this.code); }
    } else this.checkStranded();   // ⭐ R12-07: снят последний живой — мёртвые не ждут вечно
  }

  /** ⭐ V1: снятый записью ждёт реконнекта (`parkStale`) — только в подземелье и не на сливе (процесс уходит — грейс не нужен). */
  private parks(): boolean {
    return this.area === 'dungeon' && !this.frozen;
  }

  /**
   * ⭐ V1: СНЯТЫЙ ЗАПИСЬЮ В ПОДЗЕМЕЛЬЕ ЖДЁТ РЕКОННЕКТА — КАК УШЕДШИЙ (`removePlayer`), а не выпадает из комнаты. Раньше снятая сессия
   * (исход фиксации неизвестен, отказ по версии, класс 22) грейса не получала: «мёртв, штраф взят» жило только в записи ухода комнаты, и
   * погибший в коопе, снятый так, возвращался из базы как живой — «Завершить» брало второй штраф, а «Продолжить» и «Соло» со спуском (когда
   * комната пустела и уходила) ставили его ЖИВЫМ на узел, где он погиб; а «Продолжить» живого собирал забег пати в новой комнате рядом с
   * пати (V2). Теперь он в грейсе этой комнаты: «Продолжить» и свой код возвращают сюда (мёртвым, если этаж тот же, R4-06), вход в
   * другую комнату — страховка (R7-03), истёк грейс — похороны (оплаченная смерть — без штрафа). Копия с неизвестным исходом — правда о
   * герое, пока не ляжет: её прощание (`staleFarewells`, менеджер заберёт его закрытием сокета) — дописка ЭТОЙ ЖЕ копии через очередь
   * ждущего (`persistDisconnected`, со снимками записей — R14-04, V3), и штраф, похороны и возврат пишутся после неё. Проигравшая копия
   * (`lost`) — не правда: её записи упрутся в версию, и действие ляжет по строке базы (`settleStored`, метка смерти `run.deadAt` — там).
   * Снял его СЕРВЕР (сбой базы), а не игрок: это не бегство из боя (R4-14) — уход пати с этажа его не хоронит, — и тела в бою нет.
   */
  private parkStale(c: Client, p: PlayerEntity, keep: 'unknown' | 'lost'): void {
    const charId = p.save.charId;
    const info: Disconnected = {
      save: p.save, userId: c.userId, saveVersion: c.saveVersion, saving: c.saving, paid: !p.alive, fled: false, fledDescend: false,
      reasons: c.reasons, unsure: [...c.unsure],
    };
    this.disconnected.set(charId, info);
    this.hooks.onGrace(charId);
    if (keep === 'unknown') {
      const retry = (): Promise<WriteResult> => this.persistDisconnected(charId, info);
      this.staleFarewells.set(c.pid, { charId, farewell: this.farewellOf('unknown', retry) });
    }
  }

  /**
   * Ф3.2: разложить событие сессии по счётчикам наблюдений. Ничего не решает и ничего
   * не запрещает — только считает. Замах (`swing`) считается ДЕЙСТВИЕМ: именно по интервалам
   * между действиями видно машинный ритм.
   */
  private observe(e: SessionEvent): void {
    switch (e.type) {
      case 'monster-died': { const c = e.by ? this.clients.get(e.by) : undefined; if (c) c.tm.kills++; break; }
      case 'gold': { const c = this.clients.get(e.playerId); if (c) c.tm.gold += e.amount; break; }
      case 'xp': { const c = this.clients.get(e.playerId); if (c) c.tm.xp += e.amount; break; }
      case 'item-picked': { const c = this.clients.get(e.playerId); if (c) c.tm.items++; break; }
      case 'player-died': { const c = this.clients.get(e.playerId); if (c) c.tm.deaths++; break; }
      case 'swing': case 'cooldown': { const c = this.clients.get(e.playerId); if (c) c.tm.action(); break; }   // R8-15: бафф — тоже действие
      default: break;
    }
  }

  /** Сброс наблюдений в базу не чаще раза в пять минут — это не горячий путь. */
  private flushTelemetry(): void {
    const now = Date.now();
    for (const c of this.clients.values()) {
      if (now - c.tmFlushedAt < TELEMETRY_FLUSH_MS) continue;
      c.tmFlushedAt = now;
      void this.writeTelemetry(c, false);
    }
  }

  private async writeTelemetry(c: Client, ended: boolean): Promise<void> {
    const p = this.session.world.players[c.pid];
    if (!p) return;
    c.tmRow = await upsertPlaySession(c.tmRow, c.userId, p.save.charId, c.ws.ip, c.tm, ended);
  }

  /**
   * То же для отключённого игрока (грейс): у него своя копия сейва и своя версия. Встаёт в его
   * собственную очередь — первой в ней стоит прощальная запись `removePlayer`, и только после неё
   * версия отключённого верна. Не отклоняется: сбой базы — итог и строка в логе. Вещь, которую не пускает
   * леджер, изымается и здесь (R2-02): иначе штраф «Завершить» не записался бы никогда.
   */
  private persistDisconnected(charId: string, info: Disconnected, onStale?: (s: SaveState) => boolean): Promise<WriteResult> {
    const run = async (): Promise<WriteResult> => {
      for (let attempt = 0; ; attempt++) {
        // ⭐ R13-10: причины по вещи — снимком, как у живой записи (`write`); легло — записанные снимаются.
        const reasons = new Map(info.reasons);
        const out = this.heldOut(charId, info.save);   // ⭐ V-B2-04: выброшенное, которого в снимке этой записи нет
        try {
          const next = await putCharacter(charId, info.userId, info.save, info.saveVersion, undefined, reasons);
          // ⭐ R14-04: отказ по версии после записей с неизвестным исходом (прощальной, прошлых дописок) — легла одна из них (V3: любая, а не
          // последняя): копия — её продолжение (тело в бою погибло, штраф в копии) — пишем поверх её версии. Раньше отказ значил «правда в
          // базе», и штраф пропадал.
          if (next === null && info.unsure.length) {
            const landed = await landedOf(charId, info.unsure, info.saveVersion);
            if (landed !== null) { info.saveVersion = landed; continue; }
          }
          if (next === null) {
            counters.saveConflicts++;
            // ⭐ R4-15: КОПИЯ ОТКЛЮЧЁННОГО УСТАРЕЛА — правда в базе. Так бывает, когда прощальная запись легла, а ответ на
            // фиксацию потерян (версия копии осталась прежней), или строку героя переписали отзыв вещи и откат. Раньше
            // штраф «Завершить» и истечения грейса на этом молча пропадал: забег и золото в базе целы, «Продолжить» снова
            // предлагалось. Теперь действие (штраф, снятие забега) ложится на СВЕЖУЮ строку базы.
            const settled = onStale ? await this.settleStored(charId, info.userId, onStale) : 'conflict';
            if (settled === 'ok') {
              console.warn(`[room ${this.code}] копия отключённого ${charId} устарела (версия ${info.saveVersion}) — действие записано по строке базы`);
              return 'ok';
            }
            // ⭐ R5-10: строку обгоняли каждую попытку — действие (штраф, снятие забега) НЕ легло: копия остаётся у менеджера
            // на дописать (`failed`), а не «записано». Раньше здесь был `conflict`, и штраф пропадал молча.
            if (settled === 'failed') {
              console.warn(`[room ${this.code}] строку ${charId} обгоняли при записи по ней — действие допишется позже`);
              return 'failed';
            }
            console.error(`[room ${this.code}] ОТКЛОНЁН устаревший сейв отключённого ${charId} (версия ${info.saveVersion})`);
            this.forfeitHeld(charId);   // V-B2-04: правда — строка базы, выброшенное — в ней
            return 'conflict';
          }
          info.saveVersion = next;
          info.unsure = [];
          this.releaseHeld(charId, out);
          for (const [uid, why] of reasons) if (info.reasons.get(uid) === why) info.reasons.delete(uid);
          return 'ok';
        } catch (e) {
          if (isTxRetryable(e) && attempt < 2) continue;   // R4-10: взаимоблокировка — откатано целиком, повтор безопасен
          if (e instanceof LedgerViolation && attempt < 2) {
            const n = stripItems(info.save, undefined, new Set(e.itemIds));
            if (n) {
              counters.ledgerConfiscated += n;
              console.error(`[room ${this.code}] леджер отклонил запись отключённого ${charId}: ${e.message} — изъято вещей: ${n}`);
              continue;
            }
          }
          counters.saveErrors++;
          // R3-02: копию, которую база не примет никогда, держать «на дописать» бессмысленно — правда в базе.
          if (isDataException(e)) {
            console.error(`[room ${this.code}] сейв отключённого ${charId} база не примет никогда — копия отброшена, правда в базе:`, e);
            this.forfeitHeld(charId);   // V-B2-04
            return 'conflict';
          }
          warnSave(`[room ${this.code}] запись сейва отключённого ${charId} упала`, e);   // ⭐ C-07: в меру
          if (e instanceof CommitUnknown) noteUnsure(info.unsure, e.sent);   // R14-04, V3: следующая запись копии сверится и с её снимком
          return e instanceof CommitUnknown ? 'unknown' : 'failed';
        }
      }
    };
    const next = info.saving.then(run, run);
    info.saving = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * ⭐ R4-15: действие над СТРОКОЙ БАЗЫ героя (свежей, со своей версией) — когда копия в памяти устарела. `op` меняет сейв и
   * говорит, было ли что менять; нечего — уже лежит. Строку обогнали между чтением и записью — ещё раз.
   * ⭐ R5-10: обогнали и повтор — `failed` (не легло, попробовать позже), а не `conflict`: героя нет или он чужой — вот это
   * `conflict` (писать некуда).
   */
  private async settleStored(charId: string, userId: string, op: (s: SaveState) => boolean): Promise<WriteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await getCharacter(charId);
      if (!row || row.userId !== userId) { this.forfeitHeld(charId); return 'conflict'; }
      // ⭐ V-B2-04: копия проиграла, правда — эта строка: выброшенное, что в ней лежит, — с земли долой, чего нет — уже не её.
      if (!op(row.data)) { this.forfeitHeld(charId, row.data); return 'ok'; }
      if (await putCharacter(charId, userId, row.data, row.version) !== null) { this.forfeitHeld(charId, row.data); return 'ok'; }
    }
    return 'failed';
  }

  /**
   * Сбросить базисы дельт (Ф1.3): следующий кадр уйдёт ПОЛНЫМ всем клиентам.
   * Заодно забываем, кого клиент видел — на новом этаже монстры другие.
   */
  private resetDeltaBaseline(): void {
    // Общий базис комнаты и список знакомых монстров: на новом этаже монстры другие,
    // а идентификаторы продолжают расти — старые определения клиенту уже не нужны.
    this.roomDelta.reset();
    this.known.clear();
    for (const c of this.clients.values()) {
      c.delta.reset();
      c.baselined = false;
      c.visible.clear();
    }
  }

  /**
   * Разослать состояние мира. С Ф1.2 вид у каждого клиента СВОЙ: сущности за радиусом
   * области интереса ему не отправляются вовсе. Значит и базис дельт (Ф1.3) персональный.
   *
   * Порядок на клиента: сначала определения монстров, ВОШЕДШИХ в поле зрения (`monsterInfo`),
   * потом сам кадр — иначе клиент получит id монстра, про которого ничего не знает, и молча
   * его пропустит.
   */
  private emitWorld(): void {
    if (this.clients.size === 0) return;
    const snap = serializeWorld(this.session.world);
    const now = Date.now();
    const forceFull = now - this.lastFullAt >= FULL_SNAPSHOT_MS;
    if (forceFull) this.lastFullAt = now;

    if (AOI_RADIUS <= 0) { this.emitShared(snap, forceFull); return; }

    let bytes = 0;
    let sent = 0;
    for (const c of this.clients.values()) {
      if (!c.ws.open) continue;
      const view = this.viewFor(snap, c);

      // Определения монстров, вошедших в поле зрения (и повторно вошедших: клиент сносит куклу,
      // когда монстр пропадает из кадра, поэтому при возврате определение нужно снова).
      const fresh = view.monsters.filter((m) => !c.visible.has(m.id));
      if (fresh.length) {
        const live = new Map(this.session.world.monsters.map((m) => [m.id, m]));
        const info = fresh
          .map((m) => live.get(m.id))
          .filter((m): m is NonNullable<typeof m> => !!m)
          .map((m) => ({ id: m.id, def: m.def, x: m.pos.x, y: m.pos.y }));
        if (info.length) { const msg = JSON.stringify({ t: 'monsterInfo', monsters: info } satisfies ServerFrame); c.ws.send(msg); bytes += msg.length; }
      }
      c.visible = new Set(view.monsters.map((m) => m.id));

      // Ф1.4: кадры мира уходят ДВОИЧНЫМИ. GameConn сам различает текст и бинарь, поэтому
      // управляющие кадры остаются JSON и своего поля типа не требуют.
      const sum = worldChecksum(view);
      // Отладка провода: рядом с двоичным кадром шлём эталон ТОГО ЖЕ тика текстом, чтобы
      // диагностика могла сравнить поле за полем. Только по явной переменной окружения.
      if (WIRE_VERIFY) c.ws.send(JSON.stringify({ t: 'snapshot', snap: view } satisfies ServerFrame));
      if (!c.baselined || forceFull) {
        const buf = encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(view), sum });
        c.ws.send(buf);
        c.delta.prime(view);
        c.baselined = true;
        bytes += buf.length;
      } else {
        const buf = encodeWorldFrame({ kind: WIRE_DELTA, delta: c.delta.next(view)!, sum });
        c.ws.send(buf);
        bytes += buf.length;
      }
      sent++;
    }
    counters.snapshotFrames += sent;
    counters.snapshotBytes += bytes;
  }

  /**
   * ОБЩИЙ кадр на всю комнату — основной режим (см. `AOI_RADIUS`).
   *
   * Вид мира у всех в комнате один, поэтому контрольная сумма, дельта и бинарный кадр
   * считаются ОДИН РАЗ, а клиентам уходит один и тот же буфер. Раньше эта работа умножалась
   * на число игроков, и замер части 4 показал, что она дороже самой симуляции.
   *
   * Единственное, что остаётся персональным, — момент первого кадра: подключившийся посреди
   * забега должен получить ПОЛНЫЙ кадр того же тика, от которого посчитана общая дельта.
   * Тогда со следующего тика он идёт в общем потоке.
   */
  private emitShared(snap: ReturnType<typeof serializeWorld>, forceFull: boolean): void {
    const sum = worldChecksum(snap);

    // Определения новых монстров — один раз на комнату. Без области интереса монстр появляется
    // ровно однажды (на входе на этаж) и исчезает только со смертью, поэтому список знакомых
    // растёт монотонно и чистится сменой этажа.
    const fresh = snap.monsters.filter((m) => !this.known.has(m.id));
    if (fresh.length) {
      const live = new Map(this.session.world.monsters.map((m) => [m.id, m]));
      const info = fresh
        .map((m) => live.get(m.id))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({ id: m.id, def: m.def, x: m.pos.x, y: m.pos.y }));
      if (info.length) this.broadcast({ t: 'monsterInfo', monsters: info });
      for (const m of fresh) this.known.add(m.id);
    }

    // Полный кадр: по расписанию, при первом кадре комнаты — и лениво, если кто-то подключился
    // и ещё не имеет базиса.
    const roomFull = forceFull || !this.roomDelta.ready;
    let fullBuf: Uint8Array | undefined;
    let deltaBuf: Uint8Array | undefined;
    if (roomFull) {
      fullBuf = encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(snap), sum });
      this.roomDelta.prime(snap);
    } else {
      deltaBuf = encodeWorldFrame({ kind: WIRE_DELTA, delta: this.roomDelta.next(snap)!, sum });
    }

    let bytes = 0;
    let sent = 0;
    for (const c of this.clients.values()) {
      if (!c.ws.open) continue;
      if (WIRE_VERIFY) c.ws.send(JSON.stringify({ t: 'snapshot', snap } satisfies ServerFrame));
      if (roomFull || !c.baselined) {
        fullBuf ??= encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(snap), sum });
        c.ws.send(fullBuf);
        c.baselined = true;
        bytes += fullBuf.length;
      } else {
        c.ws.send(deltaBuf!);
        bytes += deltaBuf!.length;
      }
      sent++;
    }
    counters.snapshotFrames += sent;
    counters.snapshotBytes += bytes;
  }

  /**
   * Персональный вид мира для клиента (Ф1.2). Игроки видны всегда — они нужны интерфейсу пати
   * и их единицы; монстры, дропы и снаряды режутся по радиусу. У монстров гистерезис: вход
   * по `AOI_RADIUS`, выход по нему же с запасом, иначе сущность на кромке мигала бы каждый кадр
   * и гоняла бы определения туда-сюда.
   */
  private viewFor(snap: ReturnType<typeof serializeWorld>, c: Client): ReturnType<typeof serializeWorld> {
    const p = this.session.world.players[c.pid];
    if (!p || AOI_RADIUS <= 0) return snap;
    const px = p.pos.x, py = p.pos.y;
    const rIn2 = AOI_RADIUS * AOI_RADIUS;
    const rOut2 = (AOI_RADIUS * AOI_EXIT_MULT) * (AOI_RADIUS * AOI_EXIT_MULT);
    const near = (x: number, y: number, r2: number): boolean => {
      const dx = x - px, dy = y - py;
      return dx * dx + dy * dy <= r2;
    };
    return {
      tick: snap.tick,
      players: snap.players,
      monsters: snap.monsters.filter((m) => near(m.x, m.y, c.visible.has(m.id) ? rOut2 : rIn2)),
      projectiles: snap.projectiles.filter((r) => near(r.x, r.y, rIn2)),
      drops: snap.drops.filter((d) => near(d.x, d.y, rIn2)),
    };
  }

  /** Трекинг цели квеста для игрока: мутирует сейв, копит «выполнено»-события. */
  private track(pid: string, type: 'kill' | 'collect-item', target: string, touched: Set<string>, out: SessionEvent[]): void {
    const s = this.session.world.players[pid]?.save;
    if (!s) return;
    const res = trackObjective(s, type, target);
    if (!res.changed) return;
    touched.add(pid);
    for (const qid of res.completed) out.push(this.questCompleted(pid, s, qid));
  }

  stop(): void {
    tickScheduler.remove(this);
  }

  // ── Хелперы отправки ────────────────────────────────────────────────────────
  private firstSave(): SaveState | undefined {
    const pid = this.clients.keys().next().value;
    return pid ? this.session.world.players[pid]?.save : undefined;
  }
  /**
   * ⭐ R6-27: МОЩЬ УЗЛА — ПО СИЛЬНЕЙШЕМУ ГЕРОЮ ЗАБЕГА: подключённых и ждущих реконнекта этого же забега. Раньше — по первому
   * в комнате: комнату заводил свежий альт 1-го уровня, основной входил по коду — и проходил этажи открытия сложностей
   * (прогресс сложности растёт у всех) против монстров, заселённых под альта, собирая их множители золота и находок.
   * Ждущие реконнекта — в счёте: иначе основной отключался бы перед спуском и возвращался на узел, заселённый под альта.
   * ⭐ R7-02: и по тому, что герой МОЖЕТ надеть (`heroPower`), а не по надетому в эту секунду.
   */
  private partyLevel(): number {
    const heroes = this.runHeroes();
    const pool = gearPool(heroes);
    let el = 0;
    for (const h of heroes) el = Math.max(el, this.heroPower(h.save, pool.get(h.userId)), this.peakHere(h.save));
    return el || 1;
  }
  /** ⭐ R8-04: мощь, которую герой показывал в забеге этой комнаты (`peak`); у героя другого забега — ноль. */
  private peakHere(save: SaveState): number {
    const cfg = this.runConfig;
    return cfg && save.run?.config && sameRun(save.run.config, cfg) ? runPeak(save.run) : 0;
  }
  /**
   * ⭐ R8-04: ЗАМЕР МОЩИ ГЕРОЯ В ЕГО ЗАБЕГЕ — после каждой его успешной команды, которая могла её поднять (`PEAK_CMDS`: надел,
   * улучшил надетое). Узел заселяется по тому, что герои несут в момент входа (`partyLevel`), а снаряжение между узлами ходит
   * по героям аккаунта: основной отдавал его альту с другим припаркованным забегом, альт уходил в грейс (он не «этого забега» —
   * в счёт не шёл) или из комнаты вовсе, и каждый новый узел заселялся под голого основного — до `gearMax` уровней слабее, с
   * прогрессом сложности; а на узле альт возвращал снаряжение. Теперь забег помнит наибольшую мощь героя в нём (`run.peak`):
   * новый узел — не слабее неё. Мерка — надетое: воспользоваться снаряжением, не надев его, нельзя (сумку меряет вход в узел).
   * Новый забег начинает с нуля: честный герой, продавший снаряжение между забегами, ничего не замечает.
   */
  private notePeak(save: SaveState): void {
    const run = save.run;
    if (!run?.config) return;
    const p = this.heroPower(save, []);
    if (p > runPeak(run)) run.peak = p;
  }
  /**
   * Герои забега здесь: все подключённые и ждущие реконнекта этого же забега — с аккаунтом каждого (R6-27, R7-02).
   * ⭐ R10-08: кроме ждущих, чей забег пати уже увела в город (`safe`, R7-03): такой — «вышел из города», его забег припаркован, и
   * мощь новых узлов по нему не считается, как по любому вышедшему. Раньше он шёл в счёт весь грейс (умолчание — час): сильный
   * напарник спокойно закрыл вкладку, слабый вернулся в город — и его «Продолжить» (а оно идёт прежде нового забега) заселяло каждый
   * новый узел под отсутствующего. Вернётся — на узел, заселённый без него, ровно как вход по коду после выхода из города (R7-02:
   * глубины за такой узел ему нет); следующий новый узел — снова по нему. Отключившийся на ЭТОМ этаже (не `safe`) — в счёте (R6-27).
   */
  private runHeroes(): { save: SaveState; userId: string }[] {
    const out: { save: SaveState; userId: string }[] = [];
    for (const c of this.clients.values()) { const s = this.session.world.players[c.pid]?.save; if (s) out.push({ save: s, userId: c.userId }); }
    const cfg = this.runConfig;
    if (cfg) {
      for (const info of this.disconnected.values()) {
        if (!info.safe && info.save.run?.config && sameRun(info.save.run.config, cfg)) out.push({ save: info.save, userId: info.userId });
      }
    }
    return out;
  }
  /**
   * ⭐ R7-02: МОЩЬ ГЕРОЯ — ПО СНАРЯЖЕНИЮ, КОТОРОЕ ОН МОЖЕТ НАДЕТЬ: надетое, сумка и пояс, а также то, что несут герои его
   * аккаунта здесь (`pool`, передача вещей в своём аккаунте разрешена, R2-02). Раньше считалось надетое в эту секунду, а
   * снять и надеть можно где угодно: «снял всё в городе — спустился — надел в подземелье» заселяло узел до `gearMax` уровней
   * слабее (ровно запас «кошмара»), и так каждый новый узел.
   */
  private heroPower(save: SaveState, pool: readonly Item[] | undefined): number {
    return effectiveLevel(save, this.cfg.get('balance').power, pool ?? [], this.cfg.get('item-tiers')).total;   // R12-09: и ступень вещей
  }
  private currentFloorInit(): FloorInit {
    // Арена рендерится клиентом как обычный этаж (грид+спавн), поэтому area → 'dungeon'.
    const f = floorInit(this.area === 'town' ? 'town' : 'dungeon', this.session.world, this.decor);
    // ⭐ R8-10: строке «вызов ур.» — уровень, по которому узел заселён (мощь узла, а не мера клиента по своему надетому).
    const st = this.area === 'dungeon' ? this.nodeState : null;
    if (st) { f.difficultyId = this.difficultyId; f.challengeLevel = floorChallengeLevel(this.cfg, st.el, this.difficultyId, this.depth); }
    return f;
  }
  /** Статика игрока для кадра `peerInfo` (Ф1.1). */
  private peerInfo(pid: string): PeerInfo {
    return peerInfoOf(this.session.world.players[pid]!, this.cfg);   // весь реестр: вид оружия из деталей (D22)
  }
  /**
   * Статика ВСЕХ игроков комнаты, включая самого получателя: клиент сливает её со снапшотом,
   * и своя запись ему нужна ровно так же, как чужие.
   */
  private peerList(): PeerInfo[] {
    // R13-03: и тела ушедших посреди боя — они ещё в снимках мира (вошедший иначе видел бы безымянного «воина»).
    return [...this.clients.keys(), ...[...this.lingering.values()].map((l) => l.pid)].map((id) => this.peerInfo(id));
  }
  /**
   * Разослать обновлённую статику (Ф1.1). Зовётся редко: вход, успешная команда города
   * (экипировка/уровень/распределение), смена области. Держать это в каждом кадре было
   * тем же, что слать имя игрока тридцать раз в секунду.
   *
   * R1-11: уходит только статика, ИЗМЕНИВШАЯСЯ с прошлой рассылки. Клиент сливает кадр по id игрока
   * (`peerStatics.set`), поэтому неполный список ничего не стирает. Раньше любая успешная команда — хоть
   * пустая, «привязать то же, что привязано» — будила всю пати полным списком: восемьдесят кадров в секунду
   * на каждого, кто сидит рядом с флудером.
   */
  private broadcastPeerInfo(): void {
    if (this.clients.size === 0) return;
    const changed: PeerInfo[] = [];
    for (const id of this.clients.keys()) {
      const info = this.peerInfo(id);
      const key = JSON.stringify(info);
      if (this.peerSent.get(id) === key) continue;
      this.peerSent.set(id, key);
      changed.push(info);
    }
    if (changed.length) this.broadcast({ t: 'peerInfo', peers: changed });
  }
  private sendSave(pid: string): void {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (c && p) this.send(c.ws, { t: 'saveUpdate', save: clientSave(p.save) });   // R14-10: без сида забега
  }
  /** Шлёт клиенту полный слепок его аккаунт-сундука из базы (на stashOpen и на входе). */
  private async sendStash(pid: string): Promise<void> {
    const c = this.clients.get(pid);
    if (!c) return;
    const { stash } = await loadAccountStash(c.userId, this.cfg);
    this.sendStashOf(c, stash);
  }
  /**
   * Слепок сундука, который у нас уже в руках (только что записан транзакцией) — без похода в базу.
   * Вместе с журналом кузнеца: окно ковки решает по нему, что открыто. Ключи заявок не шлём.
   */
  private sendStashOf(c: Client, stash: AccountStash): void {
    const d = stashDims(this.cfg);
    this.send(c.ws, {
      t: 'stash', tabs: stash.tabs, cols: d.cols, rows: d.rows, tabCount: stashTabCount(this.cfg), materials: stash.materials ?? {},
      forgeJournal: this.journalView(stash),
    });
  }
  /**
   * Журнал для окна — ТОТ, которым сервер гейтит ковку. С флагом разработчика ворота открыты (базы,
   * детали, потолок ступени, мифики), а кодекс и счётчики остаются своими: иначе окно показывало бы
   * запертым то, что сервер скуёт. В базу это не пишется — только в кадр.
   */
  private journalView(stash: AccountStash): CraftJournal {
    const own = normalizeJournal(stash.forgeJournal);
    if (!craftFullJournal()) return own;
    const full = fullJournal(this.cfg);
    return { ...own, bases: full.bases, variants: full.variants, tierHi: Math.max(own.tierHi, full.tierHi), mythic: Math.max(own.mythic, full.mythic) };
  }
  private broadcastQuestBoard(): void {
    this.broadcast({ t: 'questBoard', quests: this.questBoard });
  }
  private questCompleted(pid: string, save: SaveState, qid: string): SessionEvent {
    const name = save.activeQuestDefs.find((d) => d.id === qid)?.name ?? qid;
    return { type: 'quest', playerId: pid, kind: 'completed', questId: qid, name };
  }
  private questEvent(pid: string, kind: 'accepted' | 'turned-in', questId: string, name: string): void {
    this.broadcast({ t: 'events', events: [{ type: 'quest', playerId: pid, kind, questId, name }] });
  }
  private send(ws: GameConn, frame: ServerFrame): void {
    if (ws.open) ws.send(JSON.stringify(frame));
  }
  private broadcast(frame: ServerFrame): void {
    const msg = JSON.stringify(frame);
    let sent = 0;
    for (const c of this.clients.values()) if (c.ws.open) { c.ws.send(msg); sent++; }
    if (frame.t === 'snapshot') { counters.snapshotFrames += sent; counters.snapshotBytes += msg.length * sent; }
  }
  private broadcastExcept(pid: string, frame: ServerFrame): void {
    const msg = JSON.stringify(frame);
    for (const [id, c] of this.clients) if (id !== pid && c.ws.open) c.ws.send(msg);
  }
}
