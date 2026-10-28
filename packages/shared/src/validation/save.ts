import { z } from 'zod';
import { RUN_NODES_MAX, RUN_VISITED_MAX } from '../dungeon/run/nodeState.js';

/**
 * zod-схема SaveState для валидации на сервере (базовый анти-чит). Вложенные
 * предметы валидируются структурно; критичные величины сервер дополнительно
 * нормализует (см. sanitizeSave).
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
  // ⭐ РЕЦЕПТ РАРНОГО ИМЕНИ (`NameRoll`): основа и эпитет выбраны случайно при рождении вещи и из неё
  // не выводятся. Схема СРЕЗАЕТ незаявленные ключи (об этом ниже два шрама), а тут срез означал бы,
  // что после перезахода имя рарной вещи больше нечем собрать на другом языке — молча и навсегда.
  nameRoll: z.object({ noun: z.string().optional(), epithet: z.string().optional() }).optional(),
  // ⚠ Слот ЕСТЬ НЕ У ВСЕХ: его нет у расходников и у материалов — схема их отвергала.
  slot: z.string().optional(),
  kind: z.string().optional(),
  // ⚠ zod СРЕЗАЕТ неизвестные ключи: без этих полей стек материала молча
  // превратился бы в одну безымянную штуку при первой же валидации сейва.
  count: z.number().int().min(1).optional(),
  materialId: z.string().optional(),
  // ⭐⭐ Ф5-1: ТО ЖЕ О ПЕЧАТИ. Без двух строк ниже печать в сумке при первой же валидации сейва
  // превратилась бы в бессмысленный стек без вида и ступени — то есть топливо отрезка пропадало бы МОЛЧА, на ровном месте.
  sealId: z.string().optional(),
  sealTier: z.string().optional(),
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
  // R18-07: старт, с которым герой создан, — от него сброс атрибутов считает вложенное (нет — сейв старше правки).
  startAttributes: z.object({
    strength: z.number().int().min(0),
    dexterity: z.number().int().min(0),
    intelligence: z.number().int().min(0),
    vitality: z.number().int().min(0),
  }).optional(),
  // D2: книга заработанного — очки, выданные за всё время (нет — сейв старше правила; вход выводит её один раз).
  earned: z.object({
    attributePoints: z.number().int().min(0),
    skillPoints: z.number().int().min(0),
    masteryPoints: z.number().int().min(0),
  }).optional(),
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
  vitals: z.object({
    // ⭐ R22-04: у погибшего пулов нет (оживёт полным) — только откаты и метка.
    hp: z.number().min(0).optional(), mana: z.number().min(0).optional(), stamina: z.number().min(0).optional(), at: z.number().optional(),
    // ⭐ D4: откаты умений героя на миг `at` (пишет только сервер) — вход в другую комнату не делает их готовыми даром.
    cd: z.record(z.string().max(128), z.number().finite().min(0).max(86_400)).optional(),
  }).optional(),
  maxDepth: z.number().int().min(0),
  // ⭐ 14.10 (Г3, правка 7): РЕКОРД ГЛУБИНЫ ТИРА — ЦЕЛОЕ ≥ 0, и это ПЕРВАЯ линия. Здесь стоял просто `z.number()`:
  // дробь, минус и `1e9` схему проходили, а из рекорда считаются и список меток алтаря, и стартовая глубина забега
  // (`openWaypoints`/`waypointStart`). Потолка схема НЕ ставит намеренно — спуск бесконечен, и любой потолок стал бы
  // запретом играть глубже; предохранитель от порченого числа — вторая линия, в `depthRecordOf`
  // (`WAYPOINT_DEPTH_LIMIT`). ⚠ Эта линия работает ТОЛЬКО там, где схему зовут (кадр `save`, сим, сторожа): сейв,
  // прочитанный из Postgres, через неё не идёт вовсе — см. `openQuestions` правки 7.
  difficultyProgress: z.record(z.string(), z.number().int().min(0)).default({}),
  lastDifficulty: z.string().default('normal'),
  // Активный забег v2 (сервер-авторитетно; граф регенерится из config.seed). Отсутствует — забега нет.
  // ⭐ Ф6: показанные один раз объяснения. Границы здесь — против роста сейва: подсказок десятки, а не тысячи.
  seen: z.array(z.string().max(48)).max(64).optional(),
  run: z
    .object({
      // ⚠⚠ Ф1 (16.10): `templateId` СНЯТ (и у забега, и у его конфига) — шаблонов забега больше нет. В старых
      // сейвах поле лежит: схема его молча отбрасывает, читателя у него нет — как у `length`/`returnEvery` ниже.
      // ⭐⭐ Ф4 (16.10): ОТРЕЗОК — модификаторы алтаря действуют до следующей метки. Поля нет — идём на
      // умолчаниях; старый сейв без него читается как «отрезок не оплачен», миграции не нужно.
      // ⭐⭐ Ф5-3: отрезок несёт СВЯЗКУ ПЕЧАТЕЙ («вид@ступень» → штук), а не список id. Старые сейвы Ф4
      // несли `modifiers` — схема отбрасывает их молча: отрезок без печатей = «идём как есть», и миграция не нужна.
      // ⚠⚠ ГРАНИЦЫ СВЯЗКИ — ТЕ ЖЕ, ЧТО У КАДРА (правка по ревизии 17.10): сейв — такой же недоверенный вход,
      // как провод, только медленнее. Без потолков строка `{"a@b": 1e9}` из порченого сейва обошла бы счёт гнёзд
      // (его считает только оплата) и ездила бы в каждом `saveUpdate`.
      // ⭐ Решение владельца 17.10: кто начал забег (его `charId`) — только он настраивает отрезок на алтаре.
      starter: z.string().max(64).optional(),
      segment: z.object({
        runId: z.string().max(64).optional(),
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        seals: z.record(z.string().min(3).max(130), z.number().int().min(1).max(9)).refine(
          (r) => Object.keys(r).length <= 32, 'связка отрезка длиннее потолка',
        ).default({}),
      }).optional(),
      config: z.object({
        biomeId: z.string(),
        tier: z.string(),
        seed: z.number(),
        // R9-01: личность забега — ключ свода записей в базе (пишет только сервер).
        id: z.string().optional(),
        // ⚠⚠ 13.10 (Г2, Р3): `length` и `returnEvery` сняты — у забега нет длины (спуск бесконечен, слои строятся
        // окном по глубине), а каденция привала живёт одним числом баланса (`dungeonAccess.waypointStep`). У старых
        // забегов поля в сейве лежат: схема их молча отбрасывает — читателя у них всё равно нет.
        widthMax: z.number().optional(),
        branching: z.number().optional(),
        // ⚠⚠ 15.10 (Г8-2): `bossEvery` СНЯТ (боссы — лестницей полосы, `balance.dungeonAccess.bossLadder`).
        // У старых забегов поле в сейве лежит: схема молча отбрасывает, читателя нет — как `length`/`returnEvery` выше.
        bosses: z.boolean().optional(),
        nodeTypeWeights: z.record(z.string(), z.number()).optional(),
        power: z.number().optional(),
        modifiers: z.array(z.string()).default([]),
      }),
      currentNodeId: z.string(),
      // ⭐⭐ 13.10 (Г2, Р5): ПОТОЛОК — ОКНО самых глубоких (`RUN_VISITED_MAX`, 64). Список был без потолка, а спуск стал
      // бесконечным: запись за этаж, навсегда, в каждой записи сейва. Окно держит `noteVisited` (сервер), здесь — контракт:
      // сейв длиннее потолка сервер писать не вправе. Длинный сейв от ПРЕЖНЕГО сервера сюда не попадает — живой вход его
      // этой схемой не разбирает (`RoomManager.sanitize`), а первая же запись забега обрежет список окном.
      visited: z.array(z.string()).max(RUN_VISITED_MAX).default([]),
      // R4-01: что взято на текущем узле (открытые сундуки, убитые монстры, рычаги) — без неё продолжение фармило узел.
      node: runNodeStateSchema.optional(),
      // R4-04: и на каждом пройденном узле — отмотанный назад указатель не давал пройденный узел свежим.
      // ⭐⭐ Г2 (Р5): тот же потолок окном (`RUN_NODES_MAX`) — переполнение вытесняет самую мелкую запись, а не отказывает новой.
      nodes: z.array(runNodeStateSchema).max(RUN_NODES_MAX).optional(),
      // R8-04: наибольшая мощь героя в этом забеге (пишет только сервер). ⚠ 13.10 (Г1): «новый узел заселяется не слабее» —
      // история: заселение мощь не читает; число не даёт занизить записанную мощь ВХОДА в узел (`RunNodeState.el`, см. types.ts).
      peak: z.number().optional(),
      // V1: погиб в коопе на этом узле и с тех пор не жил — штраф за эту смерть уже в сейве (пишет только сервер).
      deadAt: z.string().optional(),
    })
    .optional(),
}).passthrough();

export type ValidatedSave = z.infer<typeof saveStateSchema>;

/**
 * Базовый анти-чит: уровень — целый и не ниже первого, золото — целое не ниже нуля. Возвращает нормализованный объект.
 *
 * ⚠ D2 (R9-05): УРОВЕНЬ ПО ОПЫТУ ВНИЗ НЕ ПЕРЕСЧИТЫВАЕТСЯ. Раньше здесь `min(уровень, levelForXp(опыт, xpTable))` — против сейва, который
 * писал клиент (до Ф0). Сейв пишет только сервер, уровень растёт только в `gainXp` — с очками за каждый уровень, — а пересчёт по ЖИВОЙ кривой
 * опускал героя после правки баланса (медленнее или потолок ниже), и добор опыта платил очки тех же уровней второй раз. Правка конфига
 * уровней не отнимает (как вход, `RoomManager.sanitize`).
 */
export function sanitizeSave(save: ValidatedSave): ValidatedSave {
  return {
    ...save,
    level: Math.max(1, Math.floor(save.level) || 1),
    gold: Math.max(0, Math.floor(save.gold)),
  };
}
