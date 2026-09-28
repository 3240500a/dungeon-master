import { z } from 'zod';
import { levelForXp } from '../formulas/xp.js';

/**
 * zod-схема SaveState для валидации на сервере (базовый анти-чит). Вложенные
 * предметы валидируются структурно; критичные величины сервер дополнительно
 * пересчитывает (см. sanitizeSave).
 *
 * ⭐ РАЗБОР НЕ РАЗРУШАЕТ: сейв, предмет и аффикс — `.passthrough()`. zod по умолчанию молча СРЕЗАЕТ
 * незнакомые ключи, а схема знает только то, что проверяет: без сквозного пропуска скованная вещь
 * теряла детали (`parts`), найденная — `foundParts`/`origin`/`tierForged`, клинок — `spreadMult`, сейв —
 * кошелёк материалов и гнёзда. Проверяем известное, остальное несём как есть (save.test.ts).
 */
const statModifier = z.object({
  stat: z.string(),
  kind: z.enum(['flat', 'increased']),
  value: z.number(),
});

/** Прок «шанс каста» (`ProcSpec`): шанс — доля [0, 1], как в конфиге аффиксов. */
const procSpec = z.object({
  skillId: z.string(),
  level: z.number(),
  chance: z.number().min(0).max(1),
  trigger: z.enum(['hit', 'struck']).optional(),
});

const item = z.object({
  uid: z.string(),
  baseId: z.string(),
  name: z.string(),
  // ⚠ Слот ЕСТЬ НЕ У ВСЕХ: его нет у расходников и у материалов — схема их отвергала.
  slot: z.string().optional(),
  kind: z.string().optional(),
  // ⚠ zod СРЕЗАЕТ неизвестные ключи: без этих полей стек материала молча
  // превратился бы в одну безымянную штуку при первой же валидации сейва.
  count: z.number().int().min(1).optional(),
  materialId: z.string().optional(),
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
      // У прок-аффикса (шанс каста) стат-мода нет — только `proc`; обязательный `modifier` валил весь сейв.
      modifier: statModifier.optional(),
      proc: procSpec.optional(),
    }).passthrough(),
  ),
  baseStats: z.array(statModifier),
  // Доля броска базы (урон/броня в вилке тира): без неё подъём тира вернул бы вещь в центр вилки.
  baseRoll: z.record(z.string(), z.number().min(0).max(1)).optional(),
  // Что заплачено сырьём за ковку: переплавка возвращает долю этого, а не нынешней цены (§16).
  craftPaid: z.array(z.object({ id: z.string().min(1), n: z.number().int().min(0) })).optional(),
  gridW: z.number().int().min(1).default(1),
  gridH: z.number().int().min(1).default(1),
  pos: z.object({ x: z.number(), y: z.number() }).nullish(),
}).passthrough();

/** R4-01: что взято на узле забега (`RunNodeState`). */
const runNodeStateSchema = z.object({
  id: z.string(),
  el: z.number().min(0),
  chests: z.array(z.number().int().min(0)),
  killed: z.array(z.number().int().min(0)),
  levers: z.array(z.number().int().min(0)),
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
      // R3-10: время принятия квеста с доски — по нему квота «одно задание шаблона за срок доски».
      acceptedAt: z.number().optional(),
      // R4-33: когда катали доску, с которой квест принят, — квота меряется между поколениями досок.
      boardAt: z.number().optional(),
    }),
  ),
  activeQuestDefs: z.array(z.unknown()),
  // R5-20: поколение доски убранного из журнала задания по шаблону — квота доски держится и без истории.
  boardQuota: z.record(z.string(), z.number()).optional(),
  // R5-22: опознание стока кузницы героя — любая нода собирает тот же прилавок (пишет только сервер).
  townStock: z.object({
    at: z.number(),
    seed: z.number().int(),
    level: z.number().int().min(0),
    bought: z.array(z.number().int().min(0)),
    // R9-13: сид доски квестов поколения (нет — из `seed`).
    board: z.number().int().optional(),
  }).optional(),
  // R11-04: здоровье, мана, выносливость на момент последней записи — вход в новую комнату не лечит (пишет только сервер).
  vitals: z.object({ hp: z.number().min(0), mana: z.number().min(0), stamina: z.number().min(0), at: z.number().optional() }).optional(),
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
        // R9-01: личность забега — ключ свода записей в базе (пишет только сервер).
        id: z.string().optional(),
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
      // R4-01: что взято на текущем узле (открытые сундуки, убитые монстры, рычаги) — без неё продолжение фармило узел.
      node: runNodeStateSchema.optional(),
      // R4-04: и на каждом пройденном узле — отмотанный назад указатель не давал пройденный узел свежим.
      nodes: z.array(runNodeStateSchema).optional(),
      // R8-04: наибольшая мощь героя в этом забеге — новый узел заселяется не слабее (пишет только сервер).
      peak: z.number().optional(),
      // V1: погиб в коопе на этом узле и с тех пор не жил — штраф за эту смерть уже в сейве (пишет только сервер).
      deadAt: z.string().optional(),
    })
    .optional(),
}).passthrough();

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
