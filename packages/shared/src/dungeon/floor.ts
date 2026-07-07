import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { effectiveLevel, startChallenge, challengeAtFloor } from '../formulas/power.js';
import { Cell, cellToWorld } from '../world/grid.js';
import type { FloorLayout, MonsterSpawn } from '../session/session.js';
import { generateDungeon, type DungeonLayout } from './generate.js';

/**
 * Строит полный `FloorLayout` для сессии: генерирует этаж и расставляет пачки
 * монстров из packs-конфига по комнатам — headless-порт `DungeonScene.spawnPacks`.
 * Уровень вызова считается от мощи игрока и тира (как в клиенте). Общий провайдер
 * этажа для сима (Этап 4) и будущего перевода клиента (Этап 3).
 */
/**
 * Расставляет пачки монстров по комнатам этажа (порт `DungeonScene.spawnPacks`).
 * Уровень вызова — от мощи игрока и тира. Клиент вызывает поверх своего
 * `generateDungeon` (чтобы отрисовать полный layout), сим — через `buildFloor`.
 */
export function spawnPacks(
  reg: ConfigRegistry,
  save: SaveState,
  layout: DungeonLayout,
  depth: number,
  difficultyId: string,
  rng: Rng,
): MonsterSpawn[] {
  const theme = reg.get('dungeons')[0]!;
  const monsters = reg.get('monsters');
  const monAffixes = reg.get('monster-affixes');
  const packs = reg.get('packs');

  const diffs = reg.get('difficulties');
  const diff = diffs.find((d) => d.id === difficultyId) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
  const balance = reg.get('balance');
  const el = effectiveLevel(save, balance.power).total;
  const floorCL = challengeAtFloor(startChallenge(el, diff), diff, depth);
  const xpGrowth = balance.monsterXpGrowth;
  const championXpMult = balance.championXpMult;
  const scaling = balance.monsterScaling;

  const spawns: MonsterSpawn[] = [];
  for (const room of layout.rooms) {
    if (room.type === 'entrance') continue;
    const spec = packs.find((p) => p.roomType === room.type) ?? packs.find((p) => p.roomType === 'small');
    if (!spec) continue;
    const count = rng.int(spec.min, spec.max) + Math.floor(depth / 3);
    // Комната босса — сложнее этажа: число подаём в генератор вместо сырой глубины.
    const mDepth = room.type === 'boss' ? floorCL + 3 : floorCL;
    for (let i = 0; i < count; i++) {
      const cx = rng.int(room.x + 1, room.x + room.w - 2);
      const cy = rng.int(room.y + 1, room.y + room.h - 2);
      const w = cellToWorld(cx, cy);
      const id = rng.pick(theme.monsterPool);
      const def = generateMonster(monsters, monAffixes, { baseId: id, depth: mDepth, xpGrowth, championXpMult, scaling }, rng);
      spawns.push({ def, x: w.x, y: w.y });
    }
  }
  return spawns;
}

/** Полный `FloorLayout` для сима: генерация этажа + открытые двери + пачки. */
export function buildFloor(
  reg: ConfigRegistry,
  save: SaveState,
  seed: number,
  depth: number,
  difficultyId: string,
  rng?: Rng,
): FloorLayout {
  const layout = generateDungeon(seed, depth);
  // Сим-бот не дёргает рычаги — открываем все двери, чтобы этаж был полностью проходим
  // (замки — навигационный гиммик, не ось баланса).
  for (const d of layout.doors) for (const dc of d.cells) {
    const row = layout.grid[dc.cy];
    if (row) row[dc.cx] = Cell.Floor;
  }
  const prng = rng ?? createRng(((seed ^ (depth * 0x9e3779b1)) >>> 0) || 1);
  const monsters = spawnPacks(reg, save, layout, depth, difficultyId, prng);
  return { grid: layout.grid, spawn: layout.spawn, stairs: layout.stairsDown, monsters };
}
