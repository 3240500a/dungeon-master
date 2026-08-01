import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { effectiveLevel, startChallenge, challengeAtFloor } from '../formulas/power.js';
import { Cell, cellToWorld } from '../world/grid.js';
import type { FloorLayout, MonsterSpawn } from '../session/session.js';
import { generateDungeon } from './generate.js';
import { type DungeonLayout } from './floorCommon.js';

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
  poolOverride?: string[],
): MonsterSpawn[] {
  const el = effectiveLevel(save, reg.get('balance').power).total;
  return spawnPacksEl(reg, layout, depth, difficultyId, rng, el, poolOverride);
}

/**
 * Ядро спавна пачек по ЭФФ. УРОВНЮ игрока (`el` = «мощь»: уровень + гир + пассивы) — без `SaveState`.
 * Позволяет редактору/симу задать мощь напрямую (слайдер), а `spawnPacks` считает `el` из сейва.
 * Пул монстров по умолчанию — из первого биома (`biomes[0]`); `poolOverride` перекрывает (биом узла).
 */
export function spawnPacksEl(
  reg: ConfigRegistry,
  layout: DungeonLayout,
  depth: number,
  difficultyId: string,
  rng: Rng,
  el: number,
  poolOverride?: string[],
  packDensity = 1,
): MonsterSpawn[] {
  const monsters = reg.get('monsters');
  const enabledIds = new Set(monsters.filter((m) => m.enabled !== false).map((m) => m.id));
  const pool0 = poolOverride && poolOverride.length ? poolOverride : reg.get('biomes')[0]!.monsterPool;
  const pool = pool0.filter((id) => enabledIds.has(id)); // выключенные монстры не спавнятся
  if (!pool.length) return [];
  const monAffixes = reg.get('monster-affixes');
  const packs = reg.get('packs');

  const diffs = reg.get('difficulties');
  const diff = diffs.find((d) => d.id === difficultyId) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
  const balance = reg.get('balance');
  const floorCL = challengeAtFloor(startChallenge(el, diff), diff, depth);
  const xpGrowth = balance.monsterXpGrowth;
  const championXpMult = balance.championXpMult;
  const scaling = balance.monsterScaling;

  // Монстры пула, сгруппированные по РОЛИ (для состава пачки); фолбэк — любой из пула.
  const roleOf = new Map(monsters.map((m) => [m.id, m.role]));
  const poolByRole = new Map<string, string[]>();
  for (const id of pool) { const r = roleOf.get(id) ?? ''; (poolByRole.get(r) ?? poolByRole.set(r, []).get(r)!).push(id); }
  const pickByRole = (role: string): string => {
    const c = poolByRole.get(role);
    return c && c.length ? rng.pick(c) : rng.pick(pool);
  };

  const spawns: MonsterSpawn[] = [];
  for (const room of layout.rooms) {
    if (room.type === 'entrance') continue;
    const spec = packs.find((p) => p.roomType === room.type) ?? packs.find((p) => p.roomType === 'small');
    if (!spec) continue;
    // Состав по ролям; фолбэк-состав, если entries пуст (устаревший конфиг).
    const entries = spec.entries.length ? spec.entries : [{ role: '', min: 2, max: 4 }];
    // Спец-содержимое комнаты (фичи этажа): чемпионы/босс форсируют чемпиона; босс — сложнее.
    const content = room.content;
    const forceChampion = content === 'champion' || content === 'boss';
    const mDepth = room.type === 'boss' || content === 'boss' ? floorCL + 3 : floorCL;
    for (const entry of entries) {
      const count = Math.round(rng.int(entry.min, entry.max) * packDensity);
      for (let i = 0; i < count; i++) {
        const cx = rng.int(room.x + 1, room.x + room.w - 2);
        const cy = rng.int(room.y + 1, room.y + room.h - 2);
        const w = cellToWorld(cx, cy);
        const id = entry.role ? pickByRole(entry.role) : rng.pick(pool);
        const def = generateMonster(monsters, monAffixes, { baseId: id, depth: mDepth, xpGrowth, championXpMult, scaling, forceChampion }, rng);
        spawns.push({ def, x: w.x, y: w.y });
      }
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
