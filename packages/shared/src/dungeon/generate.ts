import { type DungeonLayout } from './floorCommon.js';
import { generateFloorParams } from './generateFloor.js';

/**
 * Legacy-точка входа: этаж по (seed, depth). Тонкая обёртка над `generateFloor` с алгоритмом
 * `rooms` и depth-масштабированием числа комнат — сохранена ради совместимости живого сервера
 * (`room.ts enterDungeon`) и симулятора. Геометрия теперь ЕДИНА (generateFloor), дублирования нет.
 * Полноценная генерация по биому/забегу — `generateFloor(FloorSpec)` (v2).
 */
export function generateDungeon(seed: number, depth: number, opts: { cols?: number; rows?: number } = {}): DungeonLayout {
  const cols = opts.cols ?? 56;
  const rows = opts.rows ?? 42;
  const roomCount = Math.min(12, 6 + Math.floor(depth / 2));
  return generateFloorParams({ algorithm: 'rooms', cols, rows, roomCount, bigChance: 0.3 }, ((seed + depth * 7919) >>> 0) || 1);
}
