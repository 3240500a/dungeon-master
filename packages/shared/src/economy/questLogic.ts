import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { QuestDef, QuestProgress, RandomQuestTemplate } from '../types/quest.js';
import type { Rng } from '../formulas/rng.js';
import { xpForLevel } from '../formulas/xp.js';
import { baseInGame, itemFromBaseId } from '../formulas/itemgen.js';
import { isSafeKey, shapeFoundWeapon } from '../formulas/craft.js';
import { addToInventory, hasSpace } from '../inventory/grid.js';
import { gainXp } from './progression.js';
import type { ActionResult } from './townActions.js';

/**
 * АВТОРИТЕТНАЯ логика квестов над `SaveState` — чистая, для сервера (клиент лишь
 * отображает `save.quests`/`save.activeQuestDefs` и шлёт команды accept/turnIn). Трекинг
 * прогресса — по событиям сессии (убийство/сбор/этаж) в `Room`. Награда сдачи (золото/
 * опыт-доля/очки/предмет) применяется здесь же. Раньше это делал клиентский QuestController.
 */

/** Опыт за квест как доля уровня: permille — промилле опыта до следующего уровня (80 = 8%). */
export function questXp(level: number, xpTable: number[], permille: number): number {
  const delta = xpForLevel(level + 1, xpTable) - xpForLevel(level, xpTable);
  return Math.round((delta * permille) / 1000);
}

/**
 * Строит конкретный квест из шаблона доски (`uid` — уникальный суффикс id). `inGame` — есть ли база в игре (`baseInGame`):
 * вещь награды берётся только из таких, не осталось ни одной — награда без вещи. Не передан — весь пул.
 */
export function questFromTemplate(tpl: RandomQuestTemplate, rng: Rng, uid: string, inGame?: (baseId: string) => boolean): QuestDef {
  const amount = rng.int(tpl.amountRange[0], tpl.amountRange[1]);
  const target = tpl.targetPool.length ? rng.pick(tpl.targetPool) : undefined;
  const items = inGame ? tpl.rewardItemPool?.filter(inGame) : tpl.rewardItemPool;
  const reward = {
    gold: rng.int(tpl.rewardGoldRange[0], tpl.rewardGoldRange[1]),
    xp: rng.int(tpl.rewardXpRange[0], tpl.rewardXpRange[1]),
    itemBaseId: items?.length ? rng.pick(items) : undefined,
  };
  const label =
    tpl.objectiveType === 'kill' ? `Уничтожить ${amount} (${target})`
      : tpl.objectiveType === 'reach-floor' ? `Достичь этажа ${amount}`
        : `Собрать ${amount} (${target})`;
  return {
    id: `rnd_${tpl.id}_${uid}`,
    name: label,
    description: 'Случайное задание с доски.',
    objectives: [{ id: 'o1', type: tpl.objectiveType, target, amount }],
    reward,
  };
}

/**
 * Генерирует доску случайных квестов (по одному на ВКЛЮЧЁННЫЙ шаблон). ⭐ R9-13: `stamp` — метка в id заданий (сервер даёт
 * поколение доски, `townStock.at`): тот же сид и та же метка собирают ту же доску с теми же id на любой ноде. Нет — часы.
 * ⚠ R13-12: вещь награды — только из баз в игре (`baseInGame`). Пул брался целиком: выключи хозяин кольцо и шапку — каждая
 * «зачистка» всё равно выдавала одну из них (200 сдач из 200).
 */
export function generateBoard(reg: ConfigRegistry, rng: Rng, stamp: number = Date.now()): QuestDef[] {
  const templates = (reg.get('quests.random') as RandomQuestTemplate[]).filter((t) => (t as { enabled?: boolean }).enabled !== false);
  const tag = Math.max(0, Math.floor(stamp)).toString(36);
  const inGame = baseInGame(reg.get('items.base'));
  return templates.map((t, i) => questFromTemplate(t, rng, `${tag}${i}`, inGame));
}

/** Шаблон, из которого собран квест доски (`rnd_<шаблон>_<метка>`, `questFromTemplate`); не с доски — `undefined`. */
export function boardTemplateOf(questId: string): string | undefined {
  return /^rnd_(.+)_[0-9a-z]+$/.exec(questId)?.[1];
}

/**
 * Квота доски (R3-10): `now` — часы сервера, `windowMs` — срок доски (`balance.townRestockSec`). Передаёт её только
 * принятие С ДОСКИ; квесты цепочки (`ensureMainQuest`, `turnInQuest`) идут без неё. `boardAt` — когда катали доску,
 * с которой берут (`stock.at` комнаты, R4-33); нет — `now`.
 */
export interface BoardQuota { now: number; windowMs: number; boardAt?: number }

/**
 * ПОКОЛЕНИЕ ДОСКИ (R4-33) — время, когда её катали. Доска, пережившая свой срок (в город с тех пор не заходили), или
 * метка «из будущего» — как катанная сейчас: иначе открытые старые доски альтов копили бы поколения «в запас».
 */
function boardTime(q: BoardQuota): number {
  const at = q.boardAt;
  return typeof at === 'number' && Number.isFinite(at) && at <= q.now && q.now - at < q.windowMs ? at : q.now;
}

/**
 * Принимает квест: кладёт def в activeQuestDefs и создаёт запись прогресса.
 *
 * ⚠ R3-10: С ДОСКИ — НЕ БОЛЬШЕ ОДНОГО ЗАДАНИЯ ШАБЛОНА ЗА СРОК ДОСКИ (`quota`). Доска — сток героя-хозяина комнаты
 * (R1-03), и герой ходил по комнатам своих же альтов (до четырёх онлайн), беря «достичь этажа» с каждой доски: одно
 * достижение закрывало все разом, опыт — по уровню берущего (на 80-м — 11–24 % уровня за штуку). Квота живёт в
 * сейве (`boardAt`/`acceptedAt`), а не в памяти комнаты: её не обойти ни новой комнатой, ни другой нодой, ни рестартом.
 *
 * ⚠ R4-33: срок меряется между ПОКОЛЕНИЯМИ ДОСОК (`boardTime`), а не от момента принятия. От принятия выходило так:
 * взял на 9-й минуте доски — на 10-й она честно обновилась, а то же задание с неё отказывалось ещё девять минут
 * («доска обновится позже» — уже обновилась). Честно обновлённая доска всегда на срок новее прежней; доски альтов,
 * катанные в пределах срока друг от друга, по-прежнему дают одно задание шаблона на всех.
 */
export function acceptQuest(save: SaveState, def: QuestDef, quota?: BoardQuota, replace = false): ActionResult {
  if (save.quests.some((q) => q.questId === def.id)) return { ok: false, reason: 'Уже принят' };
  const board = boardTemplateOf(def.id);
  const tpl = quota ? board : undefined;
  const at = quota ? boardTime(quota) : 0;
  if (quota && tpl !== undefined) {
    // По модулю: часы нод расходятся, и метка «из будущего» не должна открывать квоту раньше срока.
    // Прогресс до R4-33 поколения не знает — за него время принятия (тем строже). R5-20: сданное убрано из журнала —
    // его поколение в `boardQuota`.
    const near = (t: number | undefined): boolean => typeof t === 'number' && Math.abs(at - t) < quota.windowMs;
    const recent = near(save.boardQuota?.[tpl])
      || save.quests.some((q) => boardTemplateOf(q.questId) === tpl && near(q.boardAt ?? q.acceptedAt));
    if (recent) return { ok: false, reason: 'Такое задание уже взято — доска обновится позже' };
  }
  // ⚠ R5-20: от шаблона в журнале — ОДНО задание. Выполненное, но не сданное, держит место: новое поколение его бы
  // вытеснило вместе с наградой.
  const done = board !== undefined ? save.quests.find((q) => q.status === 'completed' && boardTemplateOf(q.questId) === board) : undefined;
  if (done) {
    const name = save.activeQuestDefs.find((d) => d.id === done.questId)?.name ?? done.questId;
    return { ok: false, reason: `Сначала сдай «${name}» — задание этого вида уже выполнено` };
  }
  // ⚠ R6-13: НАЧАТОЕ задание того же вида вытесняется только с согласия игрока (`replace` — клиент спросил): R5-20 стирало
  // его молча, вместе с прогрессом и наградой («11 из 12» — и нет). Не начатое вытесняется, как и прежде: терять нечего.
  const rival = replace ? undefined : questRival(save, def);
  if (rival) return { ok: false, reason: `У тебя уже есть задание этого вида: «${rival.name}» (${rival.progress}) — его прогресс пропал бы` };
  // ── Проверки позади ──
  pruneBoardQuests(save);
  if (board !== undefined) supersede(save, board);
  save.activeQuestDefs.push(def);
  save.quests.push({
    questId: def.id,
    status: 'active',
    counters: Object.fromEntries(def.objectives.map((o) => [o.id, 0])),
    ...(quota && tpl !== undefined ? { acceptedAt: quota.now, boardAt: at } : {}),
  });
  return { ok: true };
}

/**
 * ⚠ R6-13: НАЧАТОЕ задание доски, которое вытеснило бы принятие `def`: того же шаблона, активное, хоть один счётчик > 0.
 * Не начатое вытесняется молча (R5-20: терять нечего), начатое — только с согласия (`acceptQuest(…, replace)`). По нему
 * клиент спрашивает перед «Взять»; `undefined` — спрашивать не о чем. `progress` — «11/12» по целям задания.
 */
export function questRival(save: SaveState, def: QuestDef): { questId: string; name: string; progress: string } | undefined {
  const tpl = boardTemplateOf(def.id);
  if (tpl === undefined) return undefined;
  const q = save.quests.find((x) => x.status === 'active' && x.questId !== def.id && boardTemplateOf(x.questId) === tpl
    && Object.values(x.counters).some((n) => n > 0));
  if (!q) return undefined;
  const d = defOf(save, q.questId);
  const progress = d ? d.objectives.map((o) => `${q.counters[o.id] ?? 0}/${o.amount}`).join(', ') : '';
  return { questId: q.questId, name: d?.name ?? q.questId, progress };
}

/** Поколение доски убранного задания шаблона — в квоту (наибольшее). Кривое время или ключ — не пишем. */
function noteGeneration(save: SaveState, tpl: string, at: number | undefined): void {
  if (typeof at !== 'number' || !Number.isFinite(at) || !isSafeKey(tpl)) return;
  const quota = (save.boardQuota ??= {});
  const cur = quota[tpl];
  if (cur === undefined || at > cur) quota[tpl] = at;
}

/** Убрать из журнала строки `drop` и определения доски, оставшиеся без строки. */
function dropQuests(save: SaveState, drop: ReadonlySet<string>): void {
  if (drop.size) save.quests = save.quests.filter((q) => !drop.has(q.questId));
  const live = new Set(save.quests.map((q) => q.questId));
  const defs = save.activeQuestDefs.filter((d) => boardTemplateOf(d.id) === undefined || live.has(d.id));
  if (defs.length !== save.activeQuestDefs.length) save.activeQuestDefs = defs;
}

/**
 * ⚠ R5-20: ЖУРНАЛ ДОСКИ НЕ РАСТЁТ БЕЗ КОНЦА. Принятое с доски клало в сейв полное определение и строку прогресса, а сдача
 * лишь меняла статус: за сотни часов — тысячи строк (2–3 МБ), и весь сейв писался в базу каждым автосейвом и уходил
 * клиенту каждым `saveUpdate`, а каждое убийство перебирало его целиком. Сданное с доски убирается (поколение — в
 * `boardQuota`, квоте его хватает); определение доски без строки — тоже. Цепочку не трогаем: по ней `ensureMainQuest`
 * решает, начата ли она. Зовут приём, сдача и вход в комнату (старые сейвы). Возвращает число убранных строк.
 */
export function pruneBoardQuests(save: SaveState): number {
  const drop = new Set<string>();
  for (const q of save.quests) {
    const tpl = q.status === 'turned-in' ? boardTemplateOf(q.questId) : undefined;
    if (tpl === undefined) continue;
    noteGeneration(save, tpl, q.boardAt ?? q.acceptedAt);
    drop.add(q.questId);
  }
  dropQuests(save, drop);
  return drop.size;
}

/**
 * Новое поколение шаблона ВЫТЕСНЯЕТ невыполненное прежнее (R5-20). Иначе «достичь этажа» копились бы с каждой доски, и
 * один спуск закрывал все разом — та же дыра, что закрывала квота R3-10, только растянутая во времени.
 * ⚠ R6-13: начатое сюда доходит только с согласия игрока — `acceptQuest` отказывает раньше (`questRival`).
 */
function supersede(save: SaveState, tpl: string): void {
  const drop = new Set<string>();
  for (const q of save.quests) {
    if (q.status !== 'active' || boardTemplateOf(q.questId) !== tpl) continue;
    noteGeneration(save, tpl, q.boardAt ?? q.acceptedAt);
    drop.add(q.questId);
  }
  dropQuests(save, drop);
}

/** Выдаёт первый ВКЛЮЧЁННЫЙ main-квест, если цепочка ещё не начата. Возвращает выданный def или null. */
export function ensureMainQuest(reg: ConfigRegistry, save: SaveState): QuestDef | null {
  if (save.quests.some((q) => q.questId.startsWith('main-'))) return null;
  const main = reg.get('quests.main').find((q) => q.enabled !== false) as QuestDef | undefined;
  if (main && acceptQuest(save, main).ok) return main;
  return null;
}

export interface TrackResult {
  /** Сдвинулся ли счётчик (нужен ли SaveUpdate). */
  changed: boolean;
  /** Квесты, ставшие «выполнено» этим событием. */
  completed: string[];
}

function defOf(save: SaveState, questId: string): QuestDef | undefined {
  return save.activeQuestDefs.find((d) => d.id === questId);
}

function markComplete(def: QuestDef, prog: QuestProgress, completed: string[]): void {
  if (prog.status === 'active' && def.objectives.every((o) => (prog.counters[o.id] ?? 0) >= o.amount)) {
    prog.status = 'completed';
    completed.push(def.id);
  }
}

/** Трекинг убийства/сбора по цели (id монстра / базы предмета). */
export function trackObjective(save: SaveState, type: 'kill' | 'collect-item', target: string): TrackResult {
  const completed: string[] = [];
  let changed = false;
  for (const prog of save.quests) {
    if (prog.status !== 'active') continue;
    const def = defOf(save, prog.questId);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== type || obj.target !== target) continue;
      const cur = prog.counters[obj.id] ?? 0;
      if (cur < obj.amount) { prog.counters[obj.id] = cur + 1; changed = true; }
    }
    if (changed) markComplete(def, prog, completed);
  }
  return { changed, completed };
}

/**
 * Трекинг достижения этажа (общий для пати).
 * ⚠ R3-10: звать только на НОВЫЙ вход в узел. Продолжение забега (`Room.resumeRun`) возвращает на уже пройденный
 * узел — это не достижение: иначе «достичь этажа 2–4», принятое с припаркованным глубоким забегом, закрывалось
 * спуском из города мгновенно.
 */
export function trackFloor(save: SaveState, depth: number): TrackResult {
  const completed: string[] = [];
  let changed = false;
  for (const prog of save.quests) {
    if (prog.status !== 'active') continue;
    const def = defOf(save, prog.questId);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== 'reach-floor') continue;
      if (depth >= obj.amount && prog.counters[obj.id] !== obj.amount) { prog.counters[obj.id] = obj.amount; changed = true; }
    }
    if (changed) markComplete(def, prog, completed);
  }
  return { changed, completed };
}

export interface TurnInResult extends ActionResult {
  leveled?: boolean;
  /** Следующий квест цепочки, если авто-принят. */
  nextAccepted?: QuestDef | null;
}

/** Сдаёт выполненный квест: выдаёт награду (золото/опыт-доля/очки/предмет), двигает цепочку. */
export function turnInQuest(reg: ConfigRegistry, save: SaveState, questId: string): TurnInResult {
  const prog = save.quests.find((q) => q.questId === questId);
  const def = defOf(save, questId);
  if (!prog || !def) return { ok: false, reason: 'Квест не найден' };
  if (prog.status !== 'completed') return { ok: false, reason: 'Ещё не выполнен' };

  const r = def.reward;
  // Вещь награды — ДО любой выдачи: нет места, значит отказ целиком, и квест ждёт сдачи. Раньше результат
  // `addToInventory` не читался: при полной сумке награда молча пропадала, а квест закрывался.
  // Оружие — как найденное (§12.1): детали записаны на вещь, клинок с геометрией несёт свои статы.
  // ⚠ R13-12: базу, которой нет в игре (`baseInGame`), награда не выдаёт — ни с доски, принятой до выключения, ни из цепочки;
  // остальная награда та же, и места в сумке под невыдаваемую вещь не нужно.
  const raw = r.itemBaseId && baseInGame(reg.get('items.base'))(r.itemBaseId)
    ? itemFromBaseId(reg.get('items.base'), r.itemBaseId, reg.get('item-tiers'), 'quest') : null;
  const item = raw ? shapeFoundWeapon(reg, raw) : null;
  const dims = reg.get('balance').inventory;
  if (item && !hasSpace(save.inventory, item.gridW, item.gridH, dims)) return { ok: false, reason: 'Нет места для награды' };
  if (r.gold) save.gold += r.gold;
  if (r.skillPoints) save.unspentSkillPoints += r.skillPoints;
  if (item) addToInventory(save.inventory, item, dims);
  const leveled = r.xp
    ? gainXp(save, reg.get('balance'), questXp(save.level, reg.get('balance').xpTable, r.xp)).leveled
    : false;
  prog.status = 'turned-in';

  let nextAccepted: QuestDef | null = null;
  if (def.next) {
    // Идём по цепочке, ПЕРЕПРЫГИВАЯ выключенные квесты (на их `next`), пока не встретим включённый.
    const chain = reg.get('quests.main');
    const seen = new Set<string>();
    let nextId: string | undefined = def.next;
    let next: (typeof chain)[number] | undefined;
    while (nextId && !seen.has(nextId)) {
      seen.add(nextId);
      const q = chain.find((x) => x.id === nextId);
      if (!q) break;
      if (q.enabled !== false) { next = q; break; }
      nextId = q.next;
    }
    if (next && acceptQuest(save, next as QuestDef).ok) nextAccepted = next as QuestDef;
  }
  pruneBoardQuests(save);   // R5-20: сданное с доски уходит из журнала сразу
  return { ok: true, leveled, nextAccepted };
}
