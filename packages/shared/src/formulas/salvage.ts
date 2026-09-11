import type { MonsterGearRoll } from '../types/world.js';
import type { MaterialCost } from '../economy/materials.js';

/**
 * ЧТО МОНСТР НОСИТ — ТО С НЕГО И ПАДАЕТ (docs/ECONOMY.md).
 *
 * Материалы берутся не из общей таблицы, а из КОНКРЕТНОГО снаряжения убитого: у зомби в
 * ржавой кольчуге падают пластины, у зомби с топором — железо и дерево. Связь описана
 * полем `salvageTo` прямо в записях `monster-gear`, поэтому «носит → даёт» видно в одном
 * месте, а модульный персонаж начинает работать как ПРЕДПРОСМОТР ЛУТА: видно, кого бить.
 *
 * ⚠ ПАДАЕТ НЕ ВЕСЬ ГИР. У зомби с мечом, щитом, бронёй и шлемом выпадает один предмет;
 * у редкого — один-два; у уникального — два. Иначе с жирного монстра сыпется всё разом
 * и трофей перестаёт быть событием.
 */

/** Что даёт одна вещь снаряжения при разборе: сколько какого материала. */
export interface SalvageYield {
  materialId: string;
  min: number;
  max: number;
}

/** Запись снаряжения монстра в части, важной для разбора (структурно ⊆ `monster-gear`). */
export interface SalvageableGear {
  id: string;
  salvageTo?: SalvageYield[];
}

/** Бросок целых чисел — совместим с `Rng.int` сессии. */
export interface IntRng { int(min: number, max: number): number }

/** Сколько ВЕЩЕЙ снаряжения роняется, по редкости монстра. */
export function piecesDropped(rarity: string | undefined, rng: IntRng): number {
  if (rarity === 'unique') return 2;
  if (rarity === 'rare') return rng.int(1, 2);
  return 1;
}

/**
 * Материалы с убитого монстра.
 *
 * Берём `count` вещей из надетых (по порядку `gearRolls`, который уже перемешан генератором,
 * поэтому дополнительного шаффла не надо), у каждой читаем её `salvageTo` и катаем количество.
 * Вещи без `salvageTo` пропускаются молча — это нормальный способ сказать «с этого ничего».
 *
 * `tierShift` поднимает ступень материала на глубине: на id вида `iron-1` прибавка даёт `iron-2`.
 * ⚠ Сдвиг применяется ТОЛЬКО если такой id есть в конфиге — иначе остаётся исходный. Без этой
 * проверки глубокий забег ронял бы несуществующие материалы, и они молча пропадали бы.
 */
export function salvageFromMonster(
  rolls: readonly MonsterGearRoll[] | undefined,
  gearById: (id: string) => SalvageableGear | undefined,
  rng: IntRng,
  opts: { rarity?: string; tierShift?: number; knownMaterial?: (id: string) => boolean } = {},
): MaterialCost {
  const out: MaterialCost = {};
  if (!rolls || !rolls.length) return out;
  const count = Math.min(piecesDropped(opts.rarity, rng), rolls.length);
  for (let i = 0; i < count; i++) {
    const gear = rolls[i]?.gearId ? gearById(rolls[i]!.gearId!) : undefined;
    for (const y of gear?.salvageTo ?? []) {
      const n = rng.int(Math.max(0, y.min), Math.max(0, y.max));
      if (n <= 0) continue;
      const id = shiftTier(y.materialId, opts.tierShift ?? 0, opts.knownMaterial);
      out[id] = (out[id] ?? 0) + n;
    }
  }
  return out;
}

/** `iron-1` + 1 → `iron-2`, если такой материал существует. Иначе исходный id. */
export function shiftTier(id: string, shift: number, known?: (id: string) => boolean): string {
  if (!shift) return id;
  const m = /^(.*)-(\d+)$/.exec(id);
  if (!m) return id;
  const next = `${m[1]}-${Number(m[2]) + shift}`;
  if (known && !known(next)) return id;
  return next;
}
