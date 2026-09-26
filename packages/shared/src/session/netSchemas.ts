import { z } from 'zod';
import { CRAFT_NONCE_RE, MATERIAL_STEPS } from '../formulas/craft.js';
import type { ClientFrame, TownCommand } from './netTypes.js';
import type { PlayerInput } from './session.js';
import {
  ALLOC_ATTR_MAX, WIRE_BELT_SLOTS, WIRE_CELL_MAX, WIRE_DIFFICULTY_ID_MAX, WIRE_FINISH_ROWS, WIRE_ID_MAX,
  WIRE_RUN_MODIFIERS_MAX, WIRE_SOCKETS, WIRE_STASH_TABS, WIRE_TOKEN_RE, WIRE_CHAR_ID_RE, ROOM_CODE_LEN, isWireText,
} from './wireLimits.js';

/**
 * Валидация кадров клиента на сетевой границе (задача Ф0.6 плана доработки сервера).
 *
 * ЗАЧЕМ. Раньше кадр просто ПРИВОДИЛСЯ типом: `JSON.parse(raw) as ClientFrame`. Приведение
 * ничего не проверяет, поэтому в игровое ядро свободно уезжали `NaN`, `Infinity`, отрицательные
 * индексы и строки любой длины. `NaN` в координате разъедается по всему миру: сравнения с ним
 * всегда ложны, и сущность просто перестаёт существовать для логики, оставаясь в снапшоте.
 *
 * ДВА ПУТИ, И ЭТО ОСОЗНАННО.
 *
 * `input` — единственный кадр высокой частоты: 30 раз в секунду на игрока, то есть при тысяче
 * игроков это 30 000 разборов в секунду. Для него написан ручной проверяльщик: он не создаёт
 * объектов, не бросает исключений и стоит десятки наносекунд. Он же самый важный с точки
 * зрения безопасности — именно через него в симуляцию попадают числа.
 *
 * Все остальные кадры (`join`, `cmd`, `descend`, `vote`…) приходят по действию человека, то есть
 * единицы раз в минуту. Для них zod: он даёт точную схему, понятные ошибки и не требует
 * поддерживать проверки руками. Так дорогая проверка стоит там, где она дёшева по частоте.
 */

const vec2 = z.object({ x: z.number().finite(), y: z.number().finite() });
/**
 * ⭐ R3-02: СТРОКА С ПРОВОДА — без управляющих символов и непарных суррогатов (`isWireText`). Длину zod проверял, а
 * содержимое — нет: бинд `"x\u0000"` ложился в сейв, и Postgres отвергал КАЖДУЮ следующую запись героя. Так
 * строится КАЖДОЕ строковое поле кадра: `min`/`max` — до проверки, как у обычной строки.
 */
const wireText = (min: number, max: number) => z.string().min(min).max(max).refine(isWireText, 'управляющий символ или непарный суррогат');
/**
 * id из конфига на проводе. ⚠ Потолки — из `wireLimits.ts`, и ТЕ ЖЕ числа держит схема конфига (R2-27):
 * иначе дизайнер заводил бы id, который сервер молча отвергает.
 */
const cfgId = wireText(1, WIRE_ID_MAX);

/** Схема ввода — для полноты и для тестов; в рантайме `input` идёт через `validateInput`. */
export const playerInputSchema = z.object({
  move: vec2,
  facing: z.number().finite(),
  attack: z.boolean(),
  cast: z.string().max(WIRE_ID_MAX).nullable(),
  interact: z.boolean(),
  dodge: z.boolean().optional(),
  useBelt: z.number().int().min(0).max(WIRE_BELT_SLOTS - 1).optional(),
});

/**
 * ⭐ КОМАНДЫ ГОРОДА — СТРОГИЕ объекты (`.strict()`): лишний ключ делает команду невалидной целиком.
 *
 * Зачем строгость, если лишнее поле обработчик всё равно не читает. Сегодня не читает — а завтра в
 * команду добавят поле с тем же именем, и старый изменённый клиент, который давно шлёт туда мусор,
 * внезапно начнёт им управлять. Строгая схема закрывает это заранее и заодно ловит опечатки клиента.
 *
 * Сервер разбирает команду ЭТОЙ схемой перед исполнением (`Room.handleCmd`), поэтому она обязана
 * совпадать с типом `TownCommand` один в один — это проверяет сторож ниже на этапе сборки и тест.
 */
const uid = wireText(1, 64);
const cell = z.number().int().min(0).max(WIRE_CELL_MAX);
/**
 * ⭐ R5-15: цена, которую видел игрок, — у платных команд. Целое ≥ 0 (`int` отсекает и `Infinity`); выше неё сервер не
 * берёт (`priceRaised`). Необязательное: Unity и старые вкладки его не шлют.
 */
const maxGold = z.number().int().min(0).optional();
/** ⭐ R6-16: у продажи — НИЖНЯЯ граница, «+N» подписи: лавка даёт меньше — отказ (`priceDropped`). Та же рамка числа. */
const minGold = maxGold;

/**
 * ⭐ ЗАЯВКА НА КОВКУ (D2). Строгая на КАЖДОМ уровне вложенности: лишний ключ в заявке, в наборе деталей
 * или в самой детали — отказ целиком. Гнёзд РОВНО четыре, у детали ровно `id` и `step`, ступень — целое
 * в пределах лестницы материалов. Это первая линия; вторая — `parseCraftInput` в ядре: она пересобирает
 * заявку заново и сверяет доводку с конфигом (схема конфига не знает, поэтому держит только грубую рамку).
 * Есть ли такая деталь, её гнездо, класс, окно ступеней и журнал — решает `craftWeapon`.
 */
const craftPick = z.object({
  id: cfgId,
  step: z.number().int().min(1).max(MATERIAL_STEPS),
}).strict();
export const craftInputSchema = z.object({
  weaponClass: cfgId,
  hands: z.number().int().min(1).max(2),
  parts: z.object({ strike: craftPick, grip: craftPick, bind: craftPick, head: craftPick }).strict(),
  finish: z.number().int().min(0).max(WIRE_FINISH_ROWS - 1).optional(),
}).strict();

export const townCommandSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('buy'), uid, maxGold }).strict(),
  z.object({ cmd: z.literal('sell'), uid, minGold }).strict(),
  z.object({ cmd: z.literal('forgeUpgrade'), uid, maxGold }).strict(),
  z.object({ cmd: z.literal('forgeReroll'), uid, maxGold }).strict(),
  z.object({ cmd: z.literal('forgeSalvage'), uid }).strict(),
  z.object({ cmd: z.literal('forgeRepair'), uid, maxGold }).strict(),
  // Ключ заявки — тот же алфавит и длина, что проверяет ядро (`CRAFT_NONCE_RE`): 8–64 символа [A-Za-z0-9_-].
  z.object({ cmd: z.literal('craft'), nonce: z.string().regex(CRAFT_NONCE_RE), input: craftInputSchema, maxGold }).strict(),
  z.object({ cmd: z.literal('forgeEnchant'), uid, rarity: z.enum(['magic', 'rare']), maxGold }).strict(),
  // R3-11: эскиз — на деталь по id конфига; можно ли, решает ядро (`sketchAction`).
  z.object({ cmd: z.literal('forgeSketch'), variantId: cfgId }).strict(),
  z.object({ cmd: z.literal('depositMaterials') }).strict(),
  z.object({ cmd: z.literal('salvage'), uid }).strict(),
  z.object({ cmd: z.literal('equip'), uid }).strict(),
  z.object({ cmd: z.literal('unequip'), slot: wireText(1, 32) }).strict(),
  // R2-15: `n` — сколько очков разом (нет — одно, как шлёт Unity и «+»). Пачка очков — одна команда, а не n кадров.
  z.object({ cmd: z.literal('allocAttr'), attr: wireText(1, 32), n: z.number().int().min(1).max(ALLOC_ATTR_MAX).optional() }).strict(),
  z.object({ cmd: z.literal('respec'), maxGold }).strict(),
  z.object({ cmd: z.literal('respecPassives'), maxGold }).strict(),
  z.object({ cmd: z.literal('respecSkills'), maxGold }).strict(),
  z.object({ cmd: z.literal('allocPassive'), nodeId: cfgId, maxGold }).strict(),
  z.object({ cmd: z.literal('allocSkill'), nodeId: cfgId }).strict(),
  z.object({ cmd: z.literal('socketInsert'), nodeId: cfgId, slot: z.number().int().min(0).max(WIRE_SOCKETS - 1), insertId: cfgId }).strict(),
  z.object({ cmd: z.literal('socketClear'), nodeId: cfgId, slot: z.number().int().min(0).max(WIRE_SOCKETS - 1) }).strict(),
  z.object({ cmd: z.literal('useConsumable'), uid }).strict(),
  z.object({ cmd: z.literal('moveBelt'), uid }).strict(),
  z.object({ cmd: z.literal('moveItem'), uid, x: cell, y: cell }).strict(),
  z.object({ cmd: z.literal('stashOpen') }).strict(),
  z.object({
    cmd: z.literal('stashMove'), uid,
    dst: z.union([z.literal('inv'), z.number().int().min(0).max(WIRE_STASH_TABS - 1)]),
    x: cell, y: cell,
  }).strict(),
  // Что именно можно привязать (атака, выученная активка), решает ядро (`setBinding`, R3-02); схема — только форму.
  z.object({ cmd: z.literal('bind'), slot: z.number().int().min(0).max(15), value: wireText(0, WIRE_ID_MAX).nullable() }).strict(),
  z.object({ cmd: z.literal('pickup'), dropId: z.number().int().min(0) }).strict(),
  z.object({ cmd: z.literal('drop'), uid }).strict(),
  // R6-13: `replace` — игрок согласился, что начатое задание того же вида пропадёт (клиент спросил). Только `true`.
  z.object({ cmd: z.literal('acceptQuest'), questId: cfgId, replace: z.literal(true).optional() }).strict(),
  z.object({ cmd: z.literal('turnInQuest'), questId: cfgId }).strict(),
]);

/**
 * СТОРОЖ НА ЭТАПЕ СБОРКИ: схема и `TownCommand` описывают одно и то же. Новая команда, добавленная
 * в тип и забытая здесь (или наоборот), валит `tsc` — иначе сервер молча отвергал бы её как
 * невалидную, а честный клиент получал бы «Неверная команда» на каждую попытку.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesTownCommand: Same<z.infer<typeof townCommandSchema>, TownCommand> = true;
void schemaMatchesTownCommand;

/** Имена всех команд, которые знает схема, — для теста полноты. */
export const TOWN_COMMAND_NAMES: readonly string[] = townCommandSchema.options.map((o) => o.shape.cmd.value);

/**
 * Разбор команды города. Ошибка — текст ПЕРВОЙ проблемы с путём к полю: он для лога сервера,
 * клиенту уходит общее «Неверная команда» (подробности подсказывали бы, как обойти проверку).
 */
export function parseTownCommand(raw: unknown): { ok: true; command: TownCommand } | { ok: false; error: string } {
  const r = townCommandSchema.safeParse(raw);
  if (r.success) return { ok: true, command: r.data as TownCommand };
  const i = r.error.issues[0];
  return { ok: false, error: i ? `${i.path.join('.') || '(команда)'}: ${i.message}` : 'неверная команда' };
}

/**
 * ⭐ R3-14: ТОКЕН И CHARID — ИХ НАСТОЯЩИЙ ВИД, а не «строка до 256». Токен — `randomBytes(32).toString('hex')`
 * (`db.createSession`), charId — `randomUUID()` (`/api/characters`; буквы, цифры, дефис и подчёркивание — и для
 * старых id). Раньше `"a\u0000"` проходил схему, и КАЖДЫЙ такой кадр без входа шёл в базу (Postgres отвечал 22021)
 * и в лог стеком, без ответа клиенту. Кривой токен теперь — отказ на границе, до базы.
 */
const token = z.string().regex(WIRE_TOKEN_RE);   // тот же вид проверяет HTTP (R4-02)
const charId = z.string().regex(WIRE_CHAR_ID_RE);
/** Прочие строки кадров (код комнаты, сложность, узел, выбор алтаря) — те же правила провода (R3-02). */
const frameText = (max: number) => wireText(0, max);

/** Схемы всех кадров, КРОМЕ `input` (он проверяется вручную — см. заголовок файла). */
export const clientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('join'), token, charId, roomCode: frameText(ROOM_CODE_LEN).optional(), fresh: z.boolean().optional(), resume: z.boolean().optional() }),
  z.object({ t: z.literal('runStatus'), token, charId }),
  z.object({ t: z.literal('abandon'), token, charId }),
  z.object({ t: z.literal('cmd'), command: townCommandSchema, id: z.number().int().nonnegative().optional() }),
  z.object({
    t: z.literal('descend'),
    difficultyId: frameText(WIRE_DIFFICULTY_ID_MAX).optional(),
    targetNodeId: frameText(64).optional(),
    runConfig: z.object({
      biomeId: frameText(WIRE_ID_MAX).optional(),
      templateId: frameText(WIRE_ID_MAX).optional(),
      modifiers: z.array(frameText(WIRE_ID_MAX)).max(WIRE_RUN_MODIFIERS_MAX).optional(),
    }).optional(),
  }),
  z.object({ t: z.literal('arena') }),
  z.object({ t: z.literal('return') }),
  z.object({ t: z.literal('lever'), leverId: z.number().int().min(0) }),
  z.object({ t: z.literal('chest'), chestId: z.number().int().min(0) }),
  z.object({ t: z.literal('vote'), accept: z.boolean() }),
  z.object({ t: z.literal('leave') }),
  z.object({ t: z.literal('ping'), id: z.number().int() }),
]);

/**
 * Ручная проверка кадра ввода. Возвращает НОВЫЙ объект с приведёнными значениями либо `null`,
 * если кадр непригоден. Ключевое: любое нечисло (`NaN`, `Infinity`, строка) отбрасывается
 * до попадания в симуляцию, а вектор движения ограничивается единичной длиной — скорость
 * всё равно берётся из серверных статов, но нечего пускать в математику величины произвольного
 * масштаба.
 */
export function validateInput(v: unknown): PlayerInput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;

  const move = o.move;
  if (typeof move !== 'object' || move === null) return null;
  const m = move as Record<string, unknown>;
  const mx = m.x, my = m.y;
  if (typeof mx !== 'number' || typeof my !== 'number' || !Number.isFinite(mx) || !Number.isFinite(my)) return null;

  const facing = o.facing;
  if (typeof facing !== 'number' || !Number.isFinite(facing)) return null;

  if (typeof o.attack !== 'boolean' || typeof o.interact !== 'boolean') return null;
  if (o.cast !== null && typeof o.cast !== 'string') return null;
  if (typeof o.cast === 'string' && o.cast.length > WIRE_ID_MAX) return null;
  if (o.dodge !== undefined && typeof o.dodge !== 'boolean') return null;

  let useBelt: number | undefined;
  if (o.useBelt !== undefined) {
    if (typeof o.useBelt !== 'number' || !Number.isInteger(o.useBelt) || o.useBelt < 0 || o.useBelt >= WIRE_BELT_SLOTS) return null;
    useBelt = o.useBelt;
  }

  // Длину вектора движения ограничиваем единицей: сервер его нормализует, но пускать в
  // тригонометрию значения любого масштаба незачем.
  const len = Math.sqrt(mx * mx + my * my);
  const k = len > 1 ? 1 / len : 1;

  return {
    move: { x: mx * k, y: my * k },
    facing,
    attack: o.attack,
    cast: (o.cast as string | null) ?? null,
    interact: o.interact,
    ...(o.dodge !== undefined ? { dodge: o.dodge as boolean } : {}),
    ...(useBelt !== undefined ? { useBelt } : {}),
  };
}

/**
 * Разбор и проверка кадра клиента. `null` — кадр невалиден и должен быть отброшен
 * (с записью нарушения на соединение).
 */
export function parseClientFrame(raw: string): ClientFrame | null {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return null; }
  if (typeof json !== 'object' || json === null) return null;
  const t = (json as { t?: unknown }).t;

  // Горячий путь: ввод проверяем вручную, не создавая схем и не бросая исключений.
  if (t === 'input') {
    const o = json as { seq?: unknown; input?: unknown };
    if (typeof o.seq !== 'number' || !Number.isFinite(o.seq)) return null;
    const input = validateInput(o.input);
    return input ? { t: 'input', seq: o.seq, input } : null;
  }

  const r = clientFrameSchema.safeParse(json);
  return r.success ? (r.data as ClientFrame) : null;
}
