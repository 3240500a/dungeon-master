import { z } from 'zod';
import { levelForXp } from '../formulas/xp.js';

/**
 * zod-схема SaveState для валидации на сервере (базовый анти-чит). Вложенные
 * предметы валидируются структурно; критичные величины сервер дополнительно
 * пересчитывает (см. sanitizeSave).
 */
const statModifier = z.object({
  stat: z.string(),
  kind: z.enum(['flat', 'increased']),
  value: z.number(),
});

const item = z.object({
  uid: z.string(),
  baseId: z.string(),
  name: z.string(),
  slot: z.string(),
  attackType: z.enum(['melee', 'ranged']).optional(),
  damageKind: z.enum(['physical', 'magical']).optional(),
  damageType: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).optional(),
  hands: z.number().int().optional(),
  rarity: z.enum(['normal', 'magic', 'rare', 'unique']),
  itemLevel: z.number(),
  requirements: z.record(z.string(), z.number()),
  affixes: z.array(
    z.object({
      affixId: z.string(),
      kind: z.enum(['prefix', 'suffix']),
      modifier: statModifier,
    }),
  ),
  baseStats: z.array(statModifier),
  gridW: z.number().int().min(1).default(1),
  gridH: z.number().int().min(1).default(1),
  pos: z.object({ x: z.number(), y: z.number() }).nullish(),
});

export const saveStateSchema = z.object({
  version: z.number().int(),
  name: z.string().default('Герой'),
  charId: z.string().default(''),
  createdAt: z.number().default(0),
  classId: z.string(),
  level: z.number().int().min(1),
  xp: z.number().min(0),
  gold: z.number().min(0),
  attributes: z.object({
    strength: z.number(),
    dexterity: z.number(),
    intelligence: z.number(),
    vitality: z.number(),
  }),
  unspentAttributePoints: z.number().int().min(0),
  unspentSkillPoints: z.number().int().min(0),
  unspentMasteryPoints: z.number().int().min(0).default(0),
  skills: z.record(z.string(), z.number()),
  masteries: z.record(z.string(), z.number()),
  equipment: z.record(z.string(), item),
  inventory: z.array(item),
  stash: z.array(item),
  belt: z.array(item.nullable()).default([]),
  mouseLeft: z.string().nullable().default('attack'),
  mouseRight: z.string().nullable().default(null),
  hotbar: z.array(z.string().nullable()),
  quests: z.array(
    z.object({
      questId: z.string(),
      status: z.enum(['active', 'completed', 'turned-in']),
      counters: z.record(z.string(), z.number()),
    }),
  ),
  activeQuestDefs: z.array(z.unknown()),
  maxDepth: z.number().int().min(0),
  difficultyProgress: z.record(z.string(), z.number()).default({}),
  lastDifficulty: z.string().default('normal'),
  // Активный забег v2 (сервер-авторитетно; граф регенерится из config.seed). Отсутствует — забега нет.
  run: z
    .object({
      templateId: z.string(),
      config: z.object({
        templateId: z.string(),
        biomeId: z.string(),
        tier: z.string(),
        seed: z.number(),
        length: z.number().optional(),
        widthMax: z.number().optional(),
        branching: z.number().optional(),
        returnEvery: z.number().optional(),
        bossEvery: z.number().optional(),
        nodeTypeWeights: z.record(z.string(), z.number()).optional(),
        power: z.number().optional(),
        modifiers: z.array(z.string()).default([]),
      }),
      currentNodeId: z.string(),
      visited: z.array(z.string()).default([]),
    })
    .optional(),
});

export type ValidatedSave = z.infer<typeof saveStateSchema>;

/**
 * Базовый анти-чит: пересчитывает уровень из опыта по таблице (не даёт завысить
 * уровень) и отсекает отрицательные величины. Возвращает нормализованный объект.
 */
export function sanitizeSave(
  save: ValidatedSave,
  xpTable: number[],
): ValidatedSave {
  const level = levelForXp(save.xp, xpTable);
  return {
    ...save,
    level: Math.min(save.level, level || 1),
    gold: Math.max(0, Math.floor(save.gold)),
  };
}
