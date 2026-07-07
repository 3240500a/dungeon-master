import { ConfigRegistry } from '../config/registry.js';
import { generateMonster } from '../formulas/monstergen.js';
import { generateItem } from '../formulas/itemgen.js';
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
  const theme = reg.get('dungeons')[0]!;
  const pool = theme.monsterPool;
  const packsCfg = reg.get('packs');
  const monsters = reg.get('monsters');
  const monAffixes = reg.get('monster-affixes');
  const itemsBase = reg.get('items.base');
  const affixes = reg.get('affixes');
  const uniques = reg.get('uniques');

  const el = effectiveLevel(save, reg.get('balance').power).total;
  const cl = challengeAtFloor(startChallenge(el, diff), diff, floor);
  const model = makePlayerModel(reg, save, { useSkills: policy.useSkills });

  let xp = 0, drops = 0, packsCleared = 0, minHpFrac = 1;
  let timeSec = floorOverheadSec;
  let hp = model.maxHp;
  let died = false;
  const goldBefore = save.gold; // золото/лут оседают прямо в save; считаем дельту

  for (const roomType of floorRoomTypes(floor, rng)) {
    const spec = packsCfg.find((p) => p.roomType === roomType) ?? packsCfg.find((p) => p.roomType === 'small');
    if (!spec) continue;
    const count = rng.int(spec.min, spec.max) + Math.floor(floor / 3);
    const mDepth = roomType === 'boss' ? cl + 3 : cl;
    const pack = Array.from({ length: Math.max(1, count) }, () =>
      generateMonster(monsters, monAffixes, { baseId: rng.pick(pool), depth: mDepth }, rng));

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
        const item = generateItem(itemsBase, affixes, uniques,
          { dropBias: theme.dropBias * diff.magicFind, itemLevel: Math.max(1, cl + diff.ilvlBonus), tiers: reg.get('item-tiers'), rarities: reg.get('rarities') }, rng);
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
