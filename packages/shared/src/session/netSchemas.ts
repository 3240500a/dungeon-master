import { z } from 'zod';
import type { ClientFrame } from './netTypes.js';
import type { PlayerInput } from './session.js';

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

/** Схема ввода — для полноты и для тестов; в рантайме `input` идёт через `validateInput`. */
export const playerInputSchema = z.object({
  move: vec2,
  facing: z.number().finite(),
  attack: z.boolean(),
  cast: z.string().max(64).nullable(),
  interact: z.boolean(),
  dodge: z.boolean().optional(),
  useBelt: z.number().int().min(0).max(15).optional(),
});

const townCommandSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('buy'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('sell'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('forgeUpgrade'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('forgeReroll'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('forgeSalvage'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('forgeRepair'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('salvage'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('equip'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('unequip'), slot: z.string().max(32) }),
  z.object({ cmd: z.literal('allocAttr'), attr: z.string().max(32) }),
  z.object({ cmd: z.literal('respec') }),
  z.object({ cmd: z.literal('respecPassives') }),
  z.object({ cmd: z.literal('respecSkills') }),
  z.object({ cmd: z.literal('allocPassive'), nodeId: z.string().max(64) }),
  z.object({ cmd: z.literal('allocSkill'), nodeId: z.string().max(64) }),
  z.object({ cmd: z.literal('socketInsert'), nodeId: z.string().max(64), slot: z.number().int().min(0).max(15), insertId: z.string().max(64) }),
  z.object({ cmd: z.literal('socketClear'), nodeId: z.string().max(64), slot: z.number().int().min(0).max(15) }),
  z.object({ cmd: z.literal('useConsumable'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('moveBelt'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('moveItem'), uid: z.string().max(64), x: z.number().int().min(0).max(64), y: z.number().int().min(0).max(64) }),
  z.object({ cmd: z.literal('stashOpen') }),
  z.object({
    cmd: z.literal('stashMove'), uid: z.string().max(64),
    dst: z.union([z.literal('inv'), z.number().int().min(0).max(31)]),
    x: z.number().int().min(0).max(64), y: z.number().int().min(0).max(64),
  }),
  z.object({ cmd: z.literal('bind'), slot: z.number().int().min(0).max(15), value: z.string().max(64).nullable() }),
  z.object({ cmd: z.literal('pickup'), dropId: z.number().int().min(0) }),
  z.object({ cmd: z.literal('drop'), uid: z.string().max(64) }),
  z.object({ cmd: z.literal('acceptQuest'), questId: z.string().max(64) }),
  z.object({ cmd: z.literal('turnInQuest'), questId: z.string().max(64) }),
]);

const token = z.string().min(1).max(256);
const charId = z.string().min(1).max(64);

/** Схемы всех кадров, КРОМЕ `input` (он проверяется вручную — см. заголовок файла). */
export const clientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('join'), token, charId, roomCode: z.string().max(8).optional(), fresh: z.boolean().optional(), resume: z.boolean().optional() }),
  z.object({ t: z.literal('runStatus'), token, charId }),
  z.object({ t: z.literal('abandon'), token, charId }),
  z.object({ t: z.literal('cmd'), command: townCommandSchema, id: z.number().int().nonnegative().optional() }),
  z.object({
    t: z.literal('descend'),
    difficultyId: z.string().max(32).optional(),
    targetNodeId: z.string().max(64).optional(),
    runConfig: z.object({
      biomeId: z.string().max(64).optional(),
      templateId: z.string().max(64).optional(),
      modifiers: z.array(z.string().max(64)).max(32).optional(),
    }).optional(),
  }),
  z.object({ t: z.literal('arena') }),
  z.object({ t: z.literal('return') }),
  z.object({ t: z.literal('lever'), leverId: z.number().int().min(0) }),
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
  if (typeof o.cast === 'string' && o.cast.length > 64) return null;
  if (o.dodge !== undefined && typeof o.dodge !== 'boolean') return null;

  let useBelt: number | undefined;
  if (o.useBelt !== undefined) {
    if (typeof o.useBelt !== 'number' || !Number.isInteger(o.useBelt) || o.useBelt < 0 || o.useBelt > 15) return null;
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
