import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { spawnWeightAt, weightedPickId } from '../formulas/spawnWeight.js';
import { effectiveLevel, startChallenge, challengeAtFloor } from '../formulas/power.js';
import { Cell, cellToWorld } from '../world/grid.js';
import type { FloorLayout, MonsterSpawn } from '../session/session.js';
import { generateDungeon } from './generate.js';
import { type DungeonLayout } from './floorCommon.js';

/** Первая клетка-ПОЛ в прямоугольнике комнаты (фолбэк, если случайные промахи по стене/пустоте нерегулярной комнаты). */
function firstFloorCell(grid: DungeonLayout['grid'], r: DungeonLayout['rooms'][number]): { cx: number; cy: number } | null {
  for (let cy = r.y; cy < r.y + r.h; cy++) for (let cx = r.x; cx < r.x + r.w; cx++) if (grid[cy]?.[cx] === Cell.Floor) return { cx, cy };
  return null;
}

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
  const monsterGear = reg.get('monster-gear');
  const packs = reg.get('packs');

  const diffs = reg.get('difficulties');
  const diff = diffs.find((d) => d.id === difficultyId) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
  const balance = reg.get('balance');
  const floorCL = challengeAtFloor(startChallenge(el, diff), diff, depth);
  const championXpMult = balance.championXpMult;

  // Монстры пула, сгруппированные по РОЛИ (для состава пачки); фолбэк — любой из пула.
  const roleOf = new Map(monsters.map((m) => [m.id, m.role]));
  const monById = new Map(monsters.map((m) => [m.id, m]));
  const poolByRole = new Map<string, string[]>();
  for (const id of pool) { const r = roleOf.get(id) ?? ''; (poolByRole.get(r) ?? poolByRole.set(r, []).get(r)!).push(id); }
  // Вес спавна по ГЛУБИНЕ (тиры глубины): на этаже `depth` weak доминирует на мелководье, boss копится
  // к бездне. Выбор монстра в пуле/по роли взвешен этим (роль-состав пачки из packs.json — сверху).
  const depthTiers = reg.get('depth-tiers');
  const mderive = reg.get('monster-derive');
  const weightAt = (id: string): number => { const m = monById.get(id); return m ? spawnWeightAt(m, depthTiers, depth) : 1; };
  const wpick = (ids: string[]): string => weightedPickId(ids, weightAt, rng.float(0, 1), (r) => ids[Math.floor(r * ids.length)] ?? pool[0]!);
  const pickByRole = (role: string): string => {
    const c = poolByRole.get(role);
    return c && c.length ? wpick(c) : wpick(pool);
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
        // Клетка спавна ДОЛЖНА быть полом: в нерегулярных комнатах (cellular/BSP) смещение в прямоугольнике комнаты
        // может попасть в стену/пустоту → монстр «за полом». Первый бросок — как раньше (детерминизм для прямоуг. комнат);
        // если не пол — перевыбираем, затем фолбэк на скан комнаты; нет пола вовсе → пропуск.
        let cx = rng.int(room.x + 1, room.x + room.w - 2);
        let cy = rng.int(room.y + 1, room.y + room.h - 2);
        for (let t = 0; t < 6 && layout.grid[cy]?.[cx] !== Cell.Floor; t++) { cx = rng.int(room.x + 1, room.x + room.w - 2); cy = rng.int(room.y + 1, room.y + room.h - 2); }
        if (layout.grid[cy]?.[cx] !== Cell.Floor) { const fc = firstFloorCell(layout.grid, room); if (!fc) continue; cx = fc.cx; cy = fc.cy; }
        const w = cellToWorld(cx, cy);
        const id = entry.role ? pickByRole(entry.role) : wpick(pool);
        const def = generateMonster(monsters, monsterGear, monAffixes, { baseId: id, depth: mDepth, championXpMult, forceChampion, mderive }, rng);
        spawns.push({ def, x: w.x, y: w.y });
      }
    }
  }
  return spawns;   // без капа: этаж = сколько нагенерилось. Перф на клиенте решает окно-culling монстров (online3d).
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
