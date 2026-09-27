import { ConfigRegistry } from '../config/registry.js';
import { generateMonster } from '../formulas/monstergen.js';
import { generateItem, rollTierLevel } from '../formulas/itemgen.js';
import { shapeFoundWeapon } from '../formulas/craft.js';
import { spawnWeightAt, weightedPickId } from '../formulas/spawnWeight.js';
import { effectiveLevel, startChallenge, challengeAtFloor, type Difficulty } from '../formulas/power.js';
import type { Rng } from '../formulas/rng.js';
import type { SaveState } from '../types/save.js';
import { makePlayerModel } from './playerBot.js';
import { considerDrop } from './economy.js';
import { simulateFight } from './fight.js';
import type { BuildPolicy, FloorResult } from './types.js';

const DROP_CHANCE = 0.55; // как в lootController
const REST_SEC_BETWEEN_PACKS = 6; // ходьба между пачками → реген

type RoomType = 'small' | 'large' | 'treasure' | 'boss';

/** Приблизительный состав этажа (типы комнат). Босс — на каждом 5-м этаже. */
function floorRoomTypes(floor: number, rng: Rng): RoomType[] {
  const rooms: RoomType[] = [];
  const small = 3 + Math.floor(floor / 4) + rng.int(0, 1);
  const large = 1 + Math.floor(floor / 6);
  for (let i = 0; i < small; i++) rooms.push('small');
  for (let i = 0; i < large; i++) rooms.push('large');
  if (rng.chance(0.5)) rooms.push('treasure');
  if (floor % 5 === 0) rooms.push('boss');
  return rooms;
}

/**
 * ВЫБОР МОНСТРА КАК В ИГРЕ (`dungeon/floor.ts` `spawnPacksEl`): пул первого биома без выключенных, внутри
 * роли и во всём пуле — по весу спавна на этаже (`spawnWeightAt`: кривая глубины × доля слота `spawnShare`).
 * ⚠ Равномерный выбор врал: двойники (та же заготовка с другим оружием) делят вес источника, а поштучно
 * каждый весил как источник — метатели в «Бое» раздулись с 1/13 до 4/19, лорд у воинов стал 1/8 и там,
 * где игра его не ставит вовсе. `pick('')` или роль без кандидатов — весь пул, как у игры.
 */
export function monsterPicker(reg: ConfigRegistry, floor: number): { pool: string[]; pick: (rng: Rng, role?: string) => string } {
  const monsters = reg.get('monsters');
  const monById = new Map(monsters.map((m) => [m.id, m]));
  const pool = reg.get('biomes')[0]!.monsterPool.filter((id) => monById.has(id) && monById.get(id)!.enabled !== false);
  const byRole = new Map<string, string[]>();
  for (const id of pool) { const r = monById.get(id)!.role ?? ''; (byRole.get(r) ?? byRole.set(r, []).get(r)!).push(id); }
  const depthTiers = reg.get('depth-tiers');
  const weightAt = (id: string): number => { const m = monById.get(id); return m ? spawnWeightAt(m, depthTiers, floor) : 1; };
  const wpick = (ids: string[], rng: Rng): string =>
    weightedPickId(ids, weightAt, rng.float(0, 1), (r) => ids[Math.floor(r * ids.length)] ?? pool[0]!);
  const pick = (rng: Rng, role = ''): string => {
    const c = role ? byRole.get(role) : undefined;
    return c && c.length ? wpick(c, rng) : wpick(pool, rng);
  };
  return { pool, pick };
}

/**
 * Симуляция зачистки этажа: собирает пачки по составу, бьёт их подряд с переносом
 * HP и регеном между (ходьба), копит XP/золото/лут (бот тут же экипирует находки).
 * Смерть в любой пачке → этаж не пройден. Множители награды — по тиру.
 */
export function simulateFloor(
  reg: ConfigRegistry,
  save: SaveState,
  diff: Difficulty,
  floor: number,
  policy: BuildPolicy,
  floorOverheadSec: number,
  rng: Rng,
): FloorResult {
  const theme = reg.get('biomes')[0]!;
  const monsters = reg.get('monsters');
  const packsCfg = reg.get('packs');
  const monAffixes = reg.get('monster-affixes');
  const monsterGear = reg.get('monster-gear');
  const mderive = reg.get('monster-derive');
  const itemsBase = reg.get('items.base');
  const affixes = reg.get('affixes');
  const uniques = reg.get('uniques');

  const el = effectiveLevel(save, reg.get('balance').power, undefined, reg.get('item-tiers')).total;
  const cl = challengeAtFloor(startChallenge(el, diff), diff, floor);
  const model = makePlayerModel(reg, save, { useSkills: policy.useSkills });

  // Монстр по РОЛИ из пула (для состава пачки), по весу спавна игры; фолбэк — любой из пула.
  const picker = monsterPicker(reg, floor);
  const pickId = (role = ''): string => picker.pick(rng, role);

  let xp = 0, drops = 0, packsCleared = 0, minHpFrac = 1;
  let timeSec = floorOverheadSec;
  let hp = model.maxHp;
  let died = false;
  const goldBefore = save.gold; // золото/лут оседают прямо в save; считаем дельту

  for (const roomType of floorRoomTypes(floor, rng)) {
    const spec = packsCfg.find((p) => p.roomType === roomType) ?? packsCfg.find((p) => p.roomType === 'small');
    if (!spec) continue;
    const mDepth = roomType === 'boss' ? cl + 3 : cl;
    const entries = spec.entries.length ? spec.entries : [{ role: '', min: 2, max: 4 }];
    const pack = entries.flatMap((e) =>
      Array.from({ length: rng.int(e.min, e.max) }, () =>
        generateMonster(monsters, monsterGear, monAffixes, { baseId: pickId(e.role), depth: mDepth, mderive }, rng)));
    if (!pack.length) pack.push(generateMonster(monsters, monsterGear, monAffixes, { baseId: pickId(), depth: mDepth, mderive }, rng));

    const r = simulateFight(model, pack, rng, { startHp: hp });
    timeSec += r.timeSec;
    minHpFrac = Math.min(minHpFrac, r.playerHpFrac);
    if (!r.win) { died = true; break; }

    hp = Math.min(model.maxHp, r.endHp + model.hpRegen * REST_SEC_BETWEEN_PACKS);
    timeSec += REST_SEC_BETWEEN_PACKS;
    packsCleared += 1;
    xp += r.xp; // опыт монстров уже отскейлен по их уровню

    for (const m of pack) {
      save.gold += Math.max(1, Math.round(rng.int(1, 5 + m.level * 2) * diff.goldMult));
      if (rng.chance(DROP_CHANCE)) {
        const item = shapeFoundWeapon(reg, generateItem(itemsBase, affixes, uniques,
          // Сложность двигает уровень МОНСТРОВ, а не уровень вещи напрямую (`ilvlBonus` вырезан).
          { dropBias: theme.dropBias * diff.magicFind, itemLevel: Math.max(1, cl),
            tierLevel: rollTierLevel(Math.max(1, cl), reg.get('balance').loot.tierWindow, rng),
            tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), baseRoll: reg.get('balance').loot.baseRoll, origin: 'drop' }, rng));
        drops += 1;
        // Лут сразу оседает: экип лучшего, остальное в золото (мутирует save).
        considerDrop(reg, save, item, policy);
      }
    }
  }

  return {
    cleared: !died,
    died,
    timeSec,
    xp,
    gold: save.gold - goldBefore,
    drops,
    packsCleared,
    challengeLevel: cl,
    minHpFrac,
  };
}
