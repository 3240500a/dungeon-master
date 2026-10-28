import { ConfigRegistry } from '../config/registry.js';
import { levelForXp } from '../formulas/xp.js';
import { isWaypoint, effectiveLevel, type Difficulty } from '../formulas/power.js';
import type { Rng } from '../formulas/rng.js';
import { newBotSave, classProfileAttr, allocateAttributes } from './playerBot.js';
import { allocateSkillsAndPassives, visitShop } from './economy.js';
import { simulateFloor } from './floor.js';
import type { SaveState } from '../types/save.js';
import type { BuildPolicy, ProgressionPoint, ProgressionResult, SimSettings } from './types.js';

const DIVE_HP_THRESHOLD = 0.3; // ныряем глубже, если остаток HP на этаже выше
const WALL_STAGNATION = 25;    // столько этаже-симов без прогресса → «стена»

function resolveDifficulty(reg: ConfigRegistry, id: string): Difficulty {
  const diffs = reg.get('difficulties');
  return diffs.find((d) => d.id === id) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
}

/** Начисляет XP, обрабатывает левелапы (очки + распределение). Возвращает, был ли левелап. */
function grantXpAndLevel(reg: ConfigRegistry, save: SaveState, xp: number, build: BuildPolicy, rng: Rng): boolean {
  const balance = reg.get('balance');
  save.xp += xp;
  const target = levelForXp(save.xp, balance.xpTable);
  if (target <= save.level) return false;
  const gained = target - save.level;
  save.unspentAttributePoints += gained * balance.attributePointsPerLevel;
  save.unspentSkillPoints += gained * balance.skillPointsPerLevel;
  save.unspentMasteryPoints += gained * balance.masteryPointsPerLevel;
  save.level = target;
  allocateAttributes(save, classProfileAttr(reg, save.classId), build, rng);
  allocateSkillsAndPassives(reg, save, build, rng);
  return true;
}

/**
 * Макро-прокачка: бот фармит этажи выбранного тира; ныряет глубже по выживаемости,
 * иначе фармит текущий. Лут/золото оседают в save (эконом-бот). На «городских»
 * этажах — магазин. Смерть — штраф золота + сброс глубины. Копит кривую часы→уровень.
 * startSave — необязательный старт (для сценария «реальный сейв»); иначе новый бот.
 */
export function simulateProgression(
  reg: ConfigRegistry,
  settings: SimSettings,
  rng: Rng,
  startSave?: SaveState,
): ProgressionResult {
  const build = settings.build;
  const balance = reg.get('balance');
  const access = balance.dungeonAccess;
  const diff = resolveDifficulty(reg, settings.difficultyId);
  const bot: SaveState = startSave ?? newBotSave(reg, settings.classId);

  let hours = 0, deaths = 0, floor = 1, stagnation = 0;
  let wallFloor: number | null = null;
  // ⭐⭐ 13.10 (Г2, Р4) + ⭐ Г8-3 (15.10): ГОРОД В СИМЕ — ТА ЖЕ МЕТКА, ЧТО В ИГРЕ. Привал стоит на МЕСТАХ ПОЛОСЫ
  // (`balance.dungeonAccess.portalsAt` = 3/6/9/12/15/18/20 из 20), и сим ходит ровно тем же швом (`isWaypoint`), а не
  // своим числом: прежние `townReturnEvery`/`townReturnJitter` были вторым, похожим, но своим — и сим считал экономику
  // по каденции, которой в подземелье не было. Джиттера нет: метка — чистая функция глубины.
  const townAt = (floor: number): boolean => isWaypoint(floor, access.portalsAt, access.contentCycle);

  const curve: ProgressionPoint[] = [];
  const record = () => curve.push({
    level: bot.level, hours, floor, power: effectiveLevel(bot, balance.power, undefined, reg.get('item-tiers')).total, deaths,
  });
  record();

  let guard = 0;
  while (bot.level < settings.targetLevel && hours < settings.maxHours && guard++ < 200000) {
    const res = simulateFloor(reg, bot, diff, floor, build, settings.floorOverheadSec, rng);
    hours += res.timeSec / 3600;
    const leveled = grantXpAndLevel(reg, bot, res.xp, build, rng);

    if (res.died) {
      deaths += 1;
      bot.gold = Math.floor(bot.gold * (1 - balance.deathPenalty.goldPercent));
      hours += 0.02; // возврат в город/восстановление
      floor = 1;
      stagnation = 0;
    } else if (res.minHpFrac > DIVE_HP_THRESHOLD) {
      floor += 1; // уверенно прошёл — ныряем глубже
      stagnation = 0;
    } else if (!leveled) {
      stagnation += 1; // фармим текущий, но прогресса нет
      if (stagnation >= WALL_STAGNATION && wallFloor === null) wallFloor = floor;
    } else {
      stagnation = 0;
    }

    // Городской этаж: магазин + пассивы на накопленное золото. ⭐ Г8-3: заход в город — РОВНО на метке (`townAt`),
    // тем же швом, что у игры; прежний счётчик «следующий городской этаж» был вторым, своим правилом каденции.
    if (townAt(floor)) {
      visitShop(reg, bot, bot.level, rng, build);
      allocateSkillsAndPassives(reg, bot, build, rng);
      hours += 0.01;
    }

    if (leveled) record();
  }

  return { reachedLevel: bot.level, totalHours: hours, deaths, curve, wallFloor };
}
