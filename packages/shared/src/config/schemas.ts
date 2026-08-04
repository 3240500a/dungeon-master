import { z } from 'zod';

/**
 * zod-схемы всех конфигов — единственный источник истины по ФОРМЕ данных.
 * Их же использует HTML-редактор для авто-генерации форм. При добавлении поля
 * правь схему здесь и (при необходимости) соответствующий тип в ../types.
 */

const attributeEnum = z.enum([
  'strength',
  'dexterity',
  'intelligence',
  'vitality',
]);

const attributesSchema = z.object({
  strength: z.number(),
  dexterity: z.number(),
  intelligence: z.number(),
  vitality: z.number(),
});

const statModifierSchema = z.object({
  stat: z.string(),
  kind: z.enum(['flat', 'increased']),
  value: z.number(),
});

const requirementsSchema = z.record(attributeEnum, z.number()).default({});

// ── balance ───────────────────────────────────────────────────────────────
export const balanceSchema = z.object({
  /** xpTable[level] = требуемый суммарный опыт для достижения уровня. */
  xpTable: z.array(z.number()).min(2),
  attributePointsPerLevel: z.number().int().min(0),
  skillPointsPerLevel: z.number().int().min(0),
  /** Очки пассивных навыков за уровень (пассивы тратят и золото, и эти очки). */
  masteryPointsPerLevel: z.number().int().min(0).default(2),
  /** Базовая скорость перемещения игрока (u/с). Итог = moveSpeedBase × класс.moveSpeedMult (+ модификаторы гира). */
  moveSpeedBase: z.number().min(0).default(120),
  /** Прирост опыта монстра за уровень: xp = base.xp × (1 + level × growth). */
  monsterXpGrowth: z.number().min(0).default(0.2),
  /** Множитель опыта за чемпионов/уников. */
  championXpMult: z.number().min(1).default(3),
  /**
   * Прогрессивный рост стат-блока монстра по уровню (множитель роста = глубина).
   * hp/damage — множители (×(1+lvl×k)); остальное — плоская прибавка за уровень.
   * Скорости (move/attack) и critMult НЕ масштабируются намеренно (баланс).
   */
  monsterScaling: z.object({
    hpPerLevel: z.number().min(0).default(0.8),
    damagePerLevel: z.number().min(0).default(0.3),
    armorPerLevel: z.number().min(0).default(1),
    accuracyPerLevel: z.number().min(0).default(3),
    evadePerLevel: z.number().min(0).default(2),
    blockPerLevel: z.number().min(0).default(0.004),
    critPerLevel: z.number().min(0).default(0.003),
    resistPerLevel: z.number().min(0).default(0.005),
  }).default({}),
  /** Бонус урона класса по монстрам своей аффинити-фракции (доля, +20% по умолчанию). */
  affinityDamageBonus: z.number().min(0).default(0.2),
  deathPenalty: z.object({
    goldPercent: z.number().min(0).max(1),
    inventoryDropPercent: z.number().min(0).max(1),
  }),
  /** Окно реконнекта (сек): пока пусто, комната ждёт возврата игрока; истекло — все погибли. */
  reconnectGraceSec: z.number().int().min(0).default(3600),
  /** Лут: шанс дропа с убитого монстра + веса категорий (× per-item dropWeight). */
  loot: z
    .object({
      /** Шанс, что убитый монстр вообще что-то роняет. */
      dropChance: z.number().min(0).max(1).default(0.55),
      /** Вес категории при выборе типа дропа/товара магазина (0 — категория не выпадает). */
      categoryWeights: z
        .object({
          weapon: z.number().min(0).default(25),
          armor: z.number().min(0).default(25),
          shield: z.number().min(0).default(12),
          jewelry: z.number().min(0).default(12),
          consumable: z.number().min(0).default(26),
        })
        .default({}),
    })
    .default({}),
  /** Множитель урона на единицу вклада атрибутов (единый; сам скейл-профиль задаёт вес оружия). */
  weaponAttrScaling: z.number(),
  /** Доп. множитель силовых сигнатур двуручного оружия. */
  twoHandedPowerMult: z.number().min(1).default(1.3),
  forgePrices: z.object({
    upgradeTier: z.number().int().min(0),
    rerollAffix: z.number().int().min(0),
  }),
  respecCost: z.number().int().min(0),
  /** Сброс мастерства: комиссия = доля вложенного золота (растёт с прокачкой). */
  passiveRespecCostPct: z.number().min(0).default(0.5),
  /** Сброс дерева скилов: золото за каждое вложенное очко скилла. */
  skillRespecCostPerPoint: z.number().int().min(0).default(100),
  /** Размер сетки инвентаря в клетках. */
  inventory: z
    .object({ cols: z.number().int().min(4), rows: z.number().int().min(4) })
    .default({ cols: 10, rows: 6 }),
  /** Городской сундук (ОБЩИЙ на аккаунт): число вкладок и размер каждой вкладки в клетках. */
  stash: z
    .object({
      tabs: z.number().int().min(1).default(2),
      cols: z.number().int().min(4).default(20),
      rows: z.number().int().min(4).default(12),
    })
    .default({ tabs: 2, cols: 20, rows: 12 }),
  /** Расталкивание сущностей (по весу): вкл/выкл, число релаксаций за тик, множитель веса чемпиона. */
  collision: z
    .object({
      enabled: z.boolean().default(true),
      iterations: z.number().int().min(1).max(4).default(2),
      championWeightMult: z.number().min(1).default(2),
    })
    .default({ enabled: true, iterations: 2, championWeightMult: 2 }),
  /** Вес игрока для расталкивания: база тела + вклад щита по классу (броня/оружие — в их справочниках). */
  weight: z
    .object({
      base: z.number().min(0).default(100),
      shield: z
        .object({
          light: z.number().min(0).default(15),
          medium: z.number().min(0).default(35),
          heavy: z.number().min(0).default(60),
        })
        .default({ light: 15, medium: 35, heavy: 60 }),
    })
    .default({ base: 100, shield: { light: 15, medium: 35, heavy: 60 } }),
  /** Базовая геометрия взмаха мили-атаки (одна истина: сервер бьёт, клиент рисует прицел/слэш). */
  melee: z
    .object({
      baseRange: z.number().min(1).default(52),
      baseArc: z.number().min(0.1).default(0.8),
      // Замах всех ударов/скиллов как доля цикла атаки (attackCd × frac). Масштабируется скоростью
      // атаки: быстрее бьёшь — короче замах. Явный windupSec скилла добавляется сверху. 0 = мгновенно.
      baseWindupFrac: z.number().min(0).max(0.9).default(0.35),
      // Стоимость БАЗОВОЙ атаки МАГИЧЕСКИМ оружием (жезл/посох выпускают болт). 0 = бесплатно (как
      // melee/ranged). Мана у мага тратится на скиллы; базовый болт — бесплатный филлер.
      basicManaCost: z.number().min(0).default(0),
      // Доля скорости движения во время удара/замаха/восстановления (0 = стоит колом, 1 = без замедления).
      // Позволяет «идти медленно и бить». Стан всё равно полностью укореняет.
      attackMoveMult: z.number().min(0).max(1).default(0.2),
    })
    .default({ baseRange: 52, baseArc: 0.8, baseWindupFrac: 0.35, basicManaCost: 0, attackMoveMult: 0.2 }),
  /** Освещение (клиент-вид): тьма растёт с глубиной, свет от факелов и игрока. */
  lighting: z
    .object({
      /** Базовая тьма — альфа затемняющего слоя (город/1-й этаж). 0 = светло, 1 = чёрно. */
      ambient: z.number().min(0).max(1).default(0.8),
      /** Прибавка тьмы за уровень глубины (глубже — темнее). */
      perDepth: z.number().min(0).max(0.05).default(0.015),
      /** Кап тьмы (даже на дне не полностью чёрно). */
      ambientMax: z.number().min(0).max(1).default(0.92),
      /** Радиус света игрока, px (позже аффиксы/шлем меняют). */
      playerRadius: z.number().min(0).default(160),
      /** Радиус света факела, px. */
      torchRadius: z.number().min(0).default(140),
      /** 3D-клиент: тени и свет героя (регулируется тут; вкл/выкл — в настройках игры). */
      shadow3d: z
        .object({
          /** Разрешение теневой карты (px, степень 2). Больше — чётче/дороже. */
          mapSize: z.number().int().min(128).max(2048).default(1024),
          /** Сдвиг тени (борьба с «акне»). Обычно небольшой минус. */
          bias: z.number().min(-0.02).max(0).default(-0.004),
          /** Сколько БЛИЖАЙШИХ факелов отбрасывают тень (point-light shadow дорогой — 6 граней). */
          torchCasters: z.number().int().min(0).max(8).default(2),
          /** Яркость точечного света героя (3D). */
          playerLightIntensity: z.number().min(0).default(6000),
          /** Радиус/дальность света героя (3D, ед. мира). */
          playerLightDist: z.number().min(0).default(620),
        })
        .default({ mapSize: 1024, bias: -0.004, torchCasters: 2, playerLightIntensity: 6000, playerLightDist: 620 }),
    })
    .default({ ambient: 0.8, perDepth: 0.015, ambientMax: 0.92, playerRadius: 160, torchRadius: 140, shadow3d: { mapSize: 1024, bias: -0.004, torchCasters: 2, playerLightIntensity: 6000, playerLightDist: 620 } }),
  /** Редкости, которые поднимаются автоматически при проходе рядом. Остальное — по клику. */
  autoPickup: z
    .array(z.enum(['normal', 'magic', 'rare', 'unique']))
    .default(['rare', 'unique']),
  /** Геометрический рост цены пассивного узла за ранг: цена = base × mult^текущий_ранг
   *  (каждый следующий ранг дороже предыдущего в `mult` раз). */
  passiveRankCostMult: z.number().min(1).default(2),
  /** Веса метрики «Мощь персонажа» (эфф. уровень) для выбора сложности забега. */
  power: z
    .object({
      /** Вклад надетого предмета по редкости в «сырую» силу гира. */
      gearRarityWeight: z
        .object({
          normal: z.number(),
          magic: z.number(),
          rare: z.number(),
          unique: z.number(),
        })
        .default({ normal: 1, magic: 2, rare: 3, unique: 5 }),
      /** Делитель суммарной силы гира → бонус к эфф. уровню. */
      gearDivisor: z.number().min(0.1).default(4),
      /** Потолок бонуса за гир (в уровнях). */
      gearMax: z.number().min(0).default(12),
      /** Делитель суммы вложенных рангов пассивок → бонус к эфф. уровню. */
      passiveDivisor: z.number().min(0.1).default(8),
      /** Потолок бонуса за пассивы (в уровнях). */
      passiveMax: z.number().min(0).default(10),
    })
    .default({
      gearRarityWeight: { normal: 1, magic: 2, rare: 3, unique: 5 },
      gearDivisor: 4,
      gearMax: 12,
      passiveDivisor: 8,
      passiveMax: 10,
    }),
  /** Каденция доступа: возврат в город и сундук-стеш появляются раз в N этажей. */
  dungeonAccess: z
    .object({
      townReturnEvery: z.number().int().min(1).default(5),
      townReturnJitter: z.number().int().min(0).default(2),
      stashEvery: z.number().int().min(1).default(3),
      stashJitter: z.number().int().min(0).default(1),
    })
    .default({ townReturnEvery: 5, townReturnJitter: 2, stashEvery: 3, stashJitter: 1 }),
});

// ── classes ─────────────────────────────────────────────────────────────────
/** Per-класс масштаб пулов HP/маны: базы, прибавка за атрибут и за уровень. */
export const hpManaScalingSchema = z.object({
  /** База HP (при 0 вын., 1-й уровень). */
  hpBase: z.number().default(50),
  /** HP за 1 очко выносливости (vitality). */
  hpPerVitality: z.number().default(5),
  /** HP за каждый уровень после 1-го. */
  hpPerLevel: z.number().default(0),
  /** Базовый реген HP/сек (при 0 вын.). Почти нулевой — опора на зелья/вампиризм/гир. */
  hpRegenBase: z.number().default(0.1),
  /** Реген HP/сек за 1 очко выносливости. */
  hpRegenPerVitality: z.number().default(0.01),
  /** База маны (при 0 инт., 1-й уровень). */
  manaBase: z.number().default(20),
  /** Мана за 1 очко интеллекта. */
  manaPerIntelligence: z.number().default(3),
  /** Мана за 1 очко живучести (мана ← Интеллект + Живучесть). */
  manaPerVitality: z.number().default(1),
  /** Мана за каждый уровень после 1-го. */
  manaPerLevel: z.number().default(0),
  /** Базовый реген маны/сек (при 0 инт.). */
  manaRegenBase: z.number().default(0.5),
  /** Реген маны/сек за 1 очко интеллекта. */
  manaRegenPerIntelligence: z.number().default(0.05),
  manaRegenPerVitality: z.number().default(0.02),
  /** Выносливость (боевой ресурс): база + от Силы и Ловкости. */
  staminaBase: z.number().default(40),
  staminaPerStrength: z.number().default(2),
  staminaPerDexterity: z.number().default(1.5),
  staminaPerLevel: z.number().default(0),
  staminaRegenBase: z.number().default(3),
  staminaRegenPerStrength: z.number().default(0.08),
  staminaRegenPerDexterity: z.number().default(0.05),
  /** Меткость (рейтинг атаки) за каждый уровень после 1-го — чтобы не отставать от уклонения монстров. */
  accuracyPerLevel: z.number().default(2),
  /** Множитель базовой скорости перемещения этого класса (итог = balance.moveSpeedBase × это). */
  moveSpeedMult: z.number().min(0).default(1),
  /** Доля скорости движения во время удара/замаха/восстановления (0 = колом, 1 = без замедления). Per-класс. */
  attackMoveMult: z.number().min(0).max(1).default(0.2),
}).default({});

export const classesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли класс (выключенный не предлагается при создании персонажа). */
    enabled: z.boolean().default(true),
    startAttributes: attributesSchema,
    startWeaponId: z.string(),
    sprite: z.string(),
    /** Фракции, против которых класс силён (аффинити: +affinityDamageBonus урона). */
    affinity: z.array(z.enum(['undead', 'demon', 'beast', 'monster'])).default([]),
    /** Масштаб пулов HP/маны/выносливости этого класса (от атрибутов и уровня). */
    derived: hpManaScalingSchema,
  }),
);

// ── items.base ────────────────────────────────────────────────────────────
// Дискриминированная схема по `kind`: редактор и игра работают с одной моделью,
// у каждого вида — только свои поля (нельзя задать урон зелью и т.п.). Виды
// добавляются В СХЕМУ И В ИГРУ одновременно — редактор не показывает то, чего в игре нет.
/** Общие поля любого предмета (все виды). */
const itemBaseCommon = {
  id: z.string(),
  name: z.string(),
  /** Активен ли предмет в игре (выключенный не выпадает/не в магазине, но остаётся в редакторе). */
  enabled: z.boolean().default(true),
  /** Род названия (для согласования тир-префикса): м/ж/с/мн. */
  gender: z.enum(['m', 'f', 'n', 'p']).default('m'),
  /** Диапазон тиров, в котором предмет может появиться (id из item-tiers). Уровень
   * предмета выводится из minTier (не задаётся руками). */
  minTier: z.string().default('t0'),
  maxTier: z.string().default('t6'),
  baseStats: z.array(statModifierSchema),
  requirements: requirementsSchema,
  /** Размер в клетках инвентаря. */
  gridW: z.number().int().min(1).default(1),
  gridH: z.number().int().min(1).default(1),
  /** Относительный вес выпадения/появления в магазине внутри своей категории (тонкая
   *  настройка per-item; итоговый вес = balance.loot.categoryWeights[kind] × dropWeight). */
  dropWeight: z.number().min(0).default(1),
};

const weaponBaseSchema = z.object({
  kind: z.literal('weapon'),
  ...itemBaseCommon,
  slot: z.enum(['weapon', 'offhand']).default('weapon'),
  /** Тип атаки: ближний взмах / дальний снаряд. */
  attackType: z.enum(['melee', 'ranged']),
  /** Вид урона: физический (physSub, вес по Сила/Ловк) / магический (стихия, вес=Инт, болт тратит ману). */
  damageKind: z.enum(['physical', 'magical']),
  /** Класс оружия (ветвь дерева редактора). */
  weaponClass: z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff']),
  /** id веса (из конфига weapon-weights). */
  weight: z.string().default('medium'),
  /** id физ-подтипа (из конфига phys-subtypes). */
  physSub: z.string().optional(),
  damageType: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).default('physical'),
  hands: z.number().int().min(1).max(2).default(1),
  // Сигнатурные свойства (см. WeaponSignature). Скейл урона задаёт ТИП ВЕСА (weapon-weights), отдельного scaleAttr нет.
  stunChance: z.number().min(0).max(1).optional(),
  armorPenPct: z.number().min(0).max(1).optional(),
  arcMult: z.number().min(0).optional(),
  reachMult: z.number().min(0).optional(),
  lowHpBonusPct: z.number().min(0).optional(),
  knockback: z.number().min(0).optional(),
});

const armorBaseSchema = z.object({
  kind: z.literal('armor'),
  ...itemBaseCommon,
  slot: z.enum(['helm', 'chest', 'gloves', 'boots', 'belt']),
  /** id класса брони (из конфига armor-classes). */
  armorClass: z.string(),
  /** Кол-во быстрых слотов пояса (значимо только для slot='belt'; 0 — не пояс). */
  beltSlots: z.number().int().min(0).default(0),
});

/** Эффект применения расходника (зелья/колбы). */
const consumableUseSchema = z.object({
  /** Мгновенное лечение (плоское HP). */
  heal: z.number().min(0).default(0),
  /** Мгновенное лечение долей от макс. HP (0..1). */
  healPct: z.number().min(0).max(1).default(0),
  /** Мгновенное восстановление маны (плоское). */
  mana: z.number().min(0).default(0),
  /** Восстановление маны долей от макс. (0..1). */
  manaPct: z.number().min(0).max(1).default(0),
  /** Снять все дебаффы (противоядие/очищение). */
  cure: z.boolean().default(false),
  /** Временные стат-моды и их длительность (сек) — бафф-зелья. */
  buffMods: z.array(statModifierSchema).optional(),
  buffDurationSec: z.number().min(0).default(0),
});

const consumableBaseSchema = z.object({
  kind: z.literal('consumable'),
  ...itemBaseCommon,
  use: consumableUseSchema,
});

const shieldBaseSchema = z.object({
  kind: z.literal('shield'),
  ...itemBaseCommon,
  slot: z.literal('offhand').default('offhand'),
  /** Класс щита (вес): лёгкий(Ловк) / средний(Сил+Ловк) / тяжёлый(Сила). Профиль
   * требований — авторский (в requirements базы). */
  shieldClass: z.enum(['light', 'medium', 'heavy']),
});

const jewelryBaseSchema = z.object({
  kind: z.literal('jewelry'),
  ...itemBaseCommon,
  slot: z.enum(['ring', 'amulet']),
});

export const itemsBaseSchema = z.array(
  z.discriminatedUnion('kind', [weaponBaseSchema, armorBaseSchema, shieldBaseSchema, jewelryBaseSchema, consumableBaseSchema]),
);

// ── affixes ─────────────────────────────────────────────────────────────────
const affixTierSchema = z.object({
  min: z.number(),
  max: z.number(),
  ilvl: z.number().int().min(1),
});
/** Один стат-мод аффикса (для мультистатовых аффиксов; одностатовые задают stat+tiers на верхнем уровне). */
const affixModSchema = z.object({
  stat: z.string(),
  modKind: z.enum(['flat', 'increased']).default('flat'),
  tiers: z.array(affixTierSchema),
});
export const affixesSchema = z.array(
  z.object({
    id: z.string(),
    /** Активен ли аффикс (выключенный не роллится на предметах). */
    enabled: z.boolean().default(true),
    kind: z.enum(['prefix', 'suffix']),
    /** Слово-имя (D2: magic = слово-префикс + база + слово-суффикс; rare берёт из пула имён). */
    word: z.string().default(''),
    /** Типы предметов, на которых аффикс МОЖЕТ появиться (пусто = любой): вид `weapon|armor|shield|
     *  jewelry`, грань оружия `weapon.melee|weapon.ranged|weapon.physical|weapon.magical`, или слот
     *  `helm|chest|gloves|boots|belt|offhand|ring|amulet`. */
    appliesTo: z.array(z.string()).default([]),
    /** Типы-исключения (перебивают appliesTo). */
    exclude: z.array(z.string()).default([]),
    /** Группа взаимоисключения — на предмете не больше одного аффикса из группы (пусто = без группы). */
    group: z.string().default(''),
    /** Частота появления (вес взвешенного выбора). */
    weight: z.number().min(0).default(1),
    /** Может ли аффикс появляться на magic / rare. */
    onMagic: z.boolean().default(true),
    onRare: z.boolean().default(true),
    // Одностатовый аффикс: stat + modKind + tiers. Мультистатовый: mods[] (тогда stat/tiers не нужны).
    stat: z.string().optional(),
    modKind: z.enum(['flat', 'increased']).default('flat'),
    tiers: z.array(affixTierSchema).default([]),
    mods: z.array(affixModSchema).optional(),
    /** Прок «шанс каста при ударе» (D2 CtC): skillId (id активного узла), уровень скилла, шанс 0..1.
     *  Прок-аффикс обычно без stat/mods (несёт только этот эффект). */
    proc: z.object({
      skillId: z.string(),
      level: z.number().int().min(1).default(1),
      chance: z.number().min(0).max(1).default(0.1),
    }).optional(),
  }),
);

// ── uniques ─────────────────────────────────────────────────────────────────
export const uniquesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли уник (выключенный не выпадает). */
    enabled: z.boolean().default(true),
    baseId: z.string(),
    fixedAffixes: z.array(
      z.object({
        kind: z.enum(['prefix', 'suffix']),
        modifier: statModifierSchema,
      }),
    ),
  }),
);

// ── monsters ────────────────────────────────────────────────────────────────
export const monstersSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли монстр в игре (выключенный не спавнится, но остаётся в редакторе). */
    enabled: z.boolean().default(true),
    /** id роли монстра (из monster-roles) — для состава пачек. */
    role: z.string().default('warrior'),
    hp: z.number(),
    minDamage: z.number(),
    maxDamage: z.number(),
    damageType: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).default('physical'),
    /** Фракция монстра (аффинити классов). */
    faction: z.enum(['undead', 'demon', 'beast', 'monster']).default('monster'),
    /** id физ-подтипа (из конфига phys-subtypes). */
    physSub: z.string().optional(),
    attackSpeed: z.number(),
    moveSpeed: z.number(),
    armor: z.number(),
    accuracy: z.number().default(30),
    evade: z.number().default(10),
    blockChance: z.number().default(0),
    critChance: z.number().default(0.05),
    critMultiplier: z.number().default(1.5),
    hpRegen: z.number().default(0),
    resFire: z.number().default(0),
    resCold: z.number().default(0),
    resLightning: z.number().default(0),
    resPoison: z.number().default(0),
    xp: z.number(),
    ai: z.enum(['melee-chaser', 'ranged-kiter', 'stationary']),
    sprite: z.string(),
    vision: z.number().default(240),
    visionAngle: z.number().default(100),
    hearing: z.number().default(96),
    /** Вес (масса) для расталкивания: тяжёлого двигают меньше. Чемпион ×balance.collision.championWeightMult. */
    weight: z.number().min(0).default(100),
  }),
);

export const monsterAffixesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли аффикс монстра (выключенный не навешивается на чемпионов/рарников). */
    enabled: z.boolean().default(true),
    mult: z.record(z.string(), z.number()).default({}),
    add: z.record(z.string(), z.number()).default({}),
    damageType: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).optional(),
  }),
);

// ── item-tiers ────────────────────────────────────────────────────────────────
/** Лестница тиров баз (D2-стиль): по ilvl дропа берётся высший доступный тир. */
export const itemTiersSchema = z.array(
  z.object({
    id: z.string(),
    /** Активен ли тир (выключенный не выбирается при генерации предмета). */
    enabled: z.boolean().default(true),
    /** Префикс имени тира ('' — базовый). */
    name: z.string().default(''),
    /** Минимальный itemLevel дропа, с которого доступен тир. */
    minItemLevel: z.number().int().min(1),
    /** Множитель базового урона/брони. */
    statMult: z.number().min(0).default(1),
    /** Множитель требований по атрибутам. */
    reqMult: z.number().min(0).default(1),
  }),
);

// ── armor-classes ───────────────────────────────────────────────────────────
/** Справочник классов брони: штрафы подвижности, шум, выдержка к физ-статусам. */
export const armorClassesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Штраф скор. бега (increased, обычно ≤0). */
    move: z.number().default(0),
    /** Штраф скор. атаки (increased, обычно ≤0). */
    atk: z.number().default(0),
    /** Уворот (increased evade). */
    evade: z.number().default(0),
    /** Вклад в «громкость» (слух монстров). */
    noise: z.number().default(0),
    /** Вклад в вес игрока (расталкивание): тяжёлая броня — больше. */
    weight: z.number().min(0).default(20),
    /** Выдержка (доля снижения шанса/длит.) к физ-статусам. */
    poise: z
      .object({
        wound: z.number().default(0),
        bleed: z.number().default(0),
        sunder: z.number().default(0),
        daze: z.number().default(0),
      })
      .default({ wound: 0, bleed: 0, sunder: 0, daze: 0 }),
  }),
);

// ── rarities ──────────────────────────────────────────────────────────────────
/** Редкости: цвет, порог дропа (каскад rarest-first), число аффиксов, множитель цены.
 * Набор id — структурный (RARITY_ORDER), тут — метаданные. */
export const raritiesSchema = z.array(
  z.object({
    id: z.enum(['normal', 'magic', 'rare', 'unique']),
    name: z.string(),
    /** Активна ли редкость (выключенная не роллится в дропе; существующие предметы не трогаются). */
    enabled: z.boolean().default(true),
    color: z.string(),
    /** Кумулятивный порог r< (rarest-first): unique 0.02, rare 0.12, magic 0.40, normal 1.0. */
    threshold: z.number().min(0).max(1),
    minAffixes: z.number().int().min(0),
    maxAffixes: z.number().int().min(0),
    /** Лимиты префиксов/суффиксов (D2): magic 1/1, rare 3/3. Общее число аффиксов = rng(min,max),
     *  распределяется по префиксам/суффиксам в пределах этих капов. */
    maxPrefix: z.number().int().min(0).default(0),
    maxSuffix: z.number().int().min(0).default(0),
    /** Множитель цены покупки/продажи. */
    priceMult: z.number().min(0).default(1),
  }),
);

// ── rare-names ───────────────────────────────────────────────────────────────
/** Пул слов для имён rare-предметов (D2): имя = два случайных слова («Коготь Гибели»).
 * База показывается в тултипе отдельно. */
export const rareNamesSchema = z.array(z.string());

// ── damage-kinds ────────────────────────────────────────────────────────────
/** Метаданные ТИПА урона (верхний уровень таксономии): физический / магический.
 * Имя/короткая подпись/цвет — для всплывающих чисел, иконок, тултипов. */
export const damageKindsSchema = z.array(
  z.object({
    id: z.enum(['physical', 'magical']),
    name: z.string(),
    /** Короткая подпись (в строке урона). */
    short: z.string(),
    /** Цвет (hex) — всплывающие числа/иконки. */
    color: z.string(),
  }),
);

// ── magic-subtypes ──────────────────────────────────────────────────────────
/** Справочник МАГ. подтипов (стихии: огонь/холод/молния/яд) — симметрично phys-subtypes.
 * Имя/цвет/накладываемый статус. Параметры наложения статуса (прок оружия/монстра) —
 * в самом состоянии (`debuffs`, блоки `weapon`/`monster`), а не в подтипе урона. */
export const magicSubtypesSchema = z.array(
  z.object({
    id: z.enum(['fire', 'cold', 'lightning', 'poison']),
    name: z.string(),
    /** Короткая подпись (в строке урона). */
    short: z.string(),
    /** Цвет (hex) — всплывающие числа/иконки. */
    color: z.string(),
    /** Стих. статус, накладываемый этим подтипом. */
    ailment: z.enum(['burn', 'freeze', 'shock', 'poison']),
  }),
);

// ── debuffs ─────────────────────────────────────────────────────────────────
/** Параметры НАЛОЖЕНИЯ статуса от удара (шанс/стаки/длит./сила). Общая форма для прока
 * оружия (`weapon`) и прока монстра (`monster`). DoT (кровотечение/поджиг/яд) — `magPerDamage`
 * (доля от урона удара/сек); freeze/shock/wound/daze — `mag`/`mag2` флэт. */
const procSchema = z.object({
  chance: z.number().min(0),
  maxStacks: z.number().int().min(1),
  durationMs: z.number().min(0),
  mag: z.number().default(0),
  mag2: z.number().optional(),
  magPerDamage: z.number().optional(),
});

/** Справочник состояний (дебаффов): имя/иконка/описание/категория + тюн-коэффициенты
 * механики (пороги/множители, ранее захардкоженные в `debuffMods()`) + параметры наложения
 * (`weapon`/`monster` — прок от удара оружия/монстра, перенесённые из подтипов урона). Набор id —
 * структурный (DebuffKind); пустой `tuning` — у видов без интринсик-коэффициентов. */
export const debuffsSchema = z.array(
  z.object({
    id: z.enum(['wound', 'bleed', 'sunder', 'daze', 'burn', 'poison', 'shock', 'freeze']),
    name: z.string(),
    icon: z.string(),
    category: z.enum(['physical', 'elemental']),
    desc: z.string().default(''),
    /** Интринсик-коэффициенты механики дебаффа (смысл поля зависит от вида). */
    tuning: z
      .object({
        outDamageFloor: z.number().optional(),
        moveFloor: z.number().optional(),
        accuracyPerStack: z.number().optional(),
        accuracyFloor: z.number().optional(),
        hpRegenMult: z.number().optional(),
        atkSpeedBase: z.number().optional(),
        armorFloor: z.number().optional(),
        atkSpeedFactor: z.number().optional(),
        atkSpeedFloor: z.number().optional(),
      })
      .default({}),
    /** Прок статуса от УДАРА ОРУЖИЯ (если в пакете есть урон соответствующего подтипа). */
    weapon: procSchema,
    /** Прок статуса от УДАРА МОНСТРА (`magPerDamage` — доля от maxDamage монстра). */
    monster: procSchema,
  }),
);

// ── weapon-weights ────────────────────────────────────────────────────────────
/** Справочник весов оружия: множители сигнатур (power/finesse) + доли скейла урона. */
export const weaponWeightsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Доли скейла урона от атрибутов (Сила / Ловкость / Интеллект). Сумма ≈ 1. */
    strength: z.number().min(0),
    dexterity: z.number().min(0),
    intelligence: z.number().min(0).default(0),
    /** Вклад в вес игрока (расталкивание): тяжёлое оружие — больше. */
    weight: z.number().min(0).default(10),
  }),
);

// ── phys-subtypes ─────────────────────────────────────────────────────────────
/** Справочник подтипов физ. урона: какой статус вешают. Параметры наложения статуса
 * (прок оружия/монстра) — в самом состоянии (`debuffs`, блоки `weapon`/`monster`). */
export const physSubtypesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Физ-статус, который накладывает этот подтип. */
    kind: z.enum(['wound', 'bleed', 'sunder', 'daze']),
  }),
);

// ── monster-roles ─────────────────────────────────────────────────────────────
/** Настраиваемые РОЛИ монстров (разведчик/лучник/воин/шаман/…) — таксономия для состава пачек. */
export const monsterRolesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    desc: z.string().default(''),
    /** Подсказка поведения (для генерации/будущего ИИ). */
    ai: z.enum(['melee-chaser', 'ranged-kiter', 'stationary']).default('melee-chaser'),
    tags: z.array(z.string()).default([]),
  }),
);

// ── dungeons ────────────────────────────────────────────────────────────────
/** Запись состава пачки: сколько монстров указанной РОЛИ. */
const packEntrySchema = z.object({
  /** id роли монстра (из monster-roles). */
  role: z.string(),
  min: z.number().int().min(0),
  max: z.number().int().min(0),
});
export const packsSchema = z.array(
  z.object({
    roomType: z.enum(['entrance', 'small', 'large', 'treasure', 'boss']),
    /** Состав пачки по ролям («2–4 воина + 1–2 лучника»). */
    entries: z.array(packEntrySchema).default([]),
    /** Форсировать чемпиона (для босс-комнат). */
    champion: z.boolean().default(false),
  }),
);

// ── difficulties ──────────────────────────────────────────────────────────────
export const difficultiesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли тир сложности (выключенный не предлагается в алтаре и отвергается сервером). */
    enabled: z.boolean().default(true),
    /** Как считать старт: percent — EL×(1+offset); flat — EL+offset. */
    offsetMode: z.enum(['percent', 'flat']).default('flat'),
    /** Смещение старта от эфф. уровня игрока (доля для percent, уровни для flat). */
    offset: z.number().default(0),
    /** Прибавка сложности за каждый этаж глубже. */
    floorStep: z.number().min(0).default(1),
    /** Множители награды. Опыт задаётся уровнем монстра (через вызов), отдельного xpMult нет. */
    goldMult: z.number().min(0).default(1),
    /** Прибавка к itemLevel дропа. */
    ilvlBonus: z.number().int().default(0),
    /** Множитель шанса редкости (magic find). */
    magicFind: z.number().min(0).default(1),
    /** Разблокирован, если глубина на предыдущем тире ≥ этого этажа (0 — сразу). */
    unlockFloor: z.number().int().min(0).default(0),
  }),
);

// ── run generator v2 (биомы / модификаторы / шаблоны забега) ──────────────────
/**
 * Параметры поклеточного алгоритма этажа (дискр. по `algorithm`). Биом выбирает алгоритм.
 * Сейчас реализованы `rooms` (рефактор текущего генератора), `bsp`, `cellular`; `maze`/`prefab` —
 * задел (в реестре есть, геометрия — позже). Все алгоритмы держат один инвариант проходимости.
 */
const floorSizeCommon = {
  cols: z.number().int().min(20).max(200).default(56),
  rows: z.number().int().min(20).max(200).default(42),
};
const roomsParamsSchema = z.object({
  algorithm: z.literal('rooms'),
  ...floorSizeCommon,
  /** Целевое число комнат (rejection-sampling). */
  roomCount: z.number().int().min(3).max(30).default(9),
  /** Шанс «большой» комнаты. */
  bigChance: z.number().min(0).max(1).default(0.3),
  /** Braid: доля доп. коридоров-петель сверх дерева (0 — только дерево/один путь; выше — больше
   *  альтернативных путей старт↔финиш). Число петель ≈ loops × число комнат. */
  loops: z.number().min(0).max(1.5).default(0.5),
  /** Размещение спавна/выхода: farthest — самая дальняя пара (не в углу); random — спавн случайный; corner — старое. */
  spawnMode: z.enum(['farthest', 'random', 'corner']).default('farthest'),
  /** Веса форм комнат (rect по умолчанию доминирует). ell=L/T, blob=«укусы», round=октагон, hall=колонны. */
  shapes: z.object({
    rect: z.number().min(0).default(4),
    ell: z.number().min(0).default(2),
    blob: z.number().min(0).default(2),
    round: z.number().min(0).default(2),
    hall: z.number().min(0).default(2),
  }).default({}),
  /** Шанс поставить рукотворный префаб-комнату (room-scope, подходящий по размеру) вместо процедурной. 0 — выкл. */
  prefabChance: z.number().min(0).max(1).default(0),
});
const bspParamsSchema = z.object({
  algorithm: z.literal('bsp'),
  ...floorSizeCommon,
  /** Глубина рекурсивного разбиения (2^depth ≈ листьев/комнат). */
  splitDepth: z.number().int().min(1).max(7).default(4),
  /** Минимальный размер листа (клеток), ниже которого не делим. */
  minLeaf: z.number().int().min(6).max(40).default(9),
  /** Отступ комнаты от границ листа (клеток). */
  roomPad: z.number().int().min(1).max(6).default(1),
  /** Braid: доля доп. коридоров-петель сверх дерева (несколько путей старт↔финиш). ≈ loops × комнат. */
  loops: z.number().min(0).max(1.5).default(0.45),
  /** Размещение спавна/выхода: farthest — самая дальняя пара (не в углу); random — спавн случайный; corner — старое. */
  spawnMode: z.enum(['farthest', 'random', 'corner']).default('farthest'),
  /** Веса форм комнат (rect по умолчанию доминирует). ell=L/T, blob=«укусы», round=октагон, hall=колонны. */
  shapes: z.object({
    rect: z.number().min(0).default(4),
    ell: z.number().min(0).default(2),
    blob: z.number().min(0).default(2),
    round: z.number().min(0).default(2),
    hall: z.number().min(0).default(2),
  }).default({}),
  /** Шанс поставить рукотворный префаб-комнату (room-scope, подходящий по размеру) вместо процедурной. 0 — выкл. */
  prefabChance: z.number().min(0).max(1).default(0),
});
/** Диапазон числа рукотворных room-префаб-камер, врезаемых в органику (пещеры/лабиринт).
 *  Ролл `int(min..max)` за этаж; ставится столько, сколько влезло подходящих префабов (нужны
 *  префабы, нацеленные на этот биом+алгоритм). Пусто/0..0 = без камер. */
const prefabRoomsRange = z
  .object({
    min: z.number().int().min(0).max(20).default(0),
    max: z.number().int().min(0).max(20).default(0),
  })
  .default({});
const cellularParamsSchema = z.object({
  algorithm: z.literal('cellular'),
  ...floorSizeCommon,
  /** Доля стен в начальном шуме (0..1). */
  fillProb: z.number().min(0.2).max(0.7).default(0.45),
  /** Шагов сглаживания. */
  steps: z.number().int().min(1).max(10).default(5),
  /** born: клетка-пол становится стеной, если соседей-стен ≥ born. */
  born: z.number().int().min(1).max(8).default(5),
  /** survive: стена остаётся стеной, если соседей-стен ≥ survive. */
  survive: z.number().int().min(0).max(8).default(4),
  /** Сколько room-префаб-камер врезать (от..до). */
  prefabRooms: prefabRoomsRange,
});
const mazeParamsSchema = z.object({
  algorithm: z.literal('maze'),
  ...floorSizeCommon,
  /** Доля тупиков, которые «расплетаются» (braid): 0 — идеальный лабиринт, 1 — без тупиков. */
  braid: z.number().min(0).max(1).default(0.3),
  /** Ширина коридоров в клетках (стена между коридорами всегда 1). 1 = классический тонкий лабиринт. */
  width: z.number().int().min(1).max(4).default(1),
  /** Сколько room-префаб-камер врезать (от..до). */
  prefabRooms: prefabRoomsRange,
});
const prefabParamsSchema = z.object({
  algorithm: z.literal('prefab'),
  ...floorSizeCommon,
});
const floorAlgoParamsSchema = z.discriminatedUnion('algorithm', [
  roomsParamsSchema, bspParamsSchema, cellularParamsSchema, mazeParamsSchema, prefabParamsSchema,
]);

/**
 * Этаж = конфиг геометрии: биом-тема + тип генерации (алгоритм+параметры+размер) + окно глубины,
 * на котором этаж может появиться (minDepth..maxDepth) + вес выбора. Генератор для узла на глубине D
 * и биома B подбирает подходящий этаж (biomeId===B && minDepth≤D≤maxDepth, по весу). Это позволяет
 * одному биому иметь разные этажи на разных глубинах («мрачнее с глубиной»).
 */
/** Роль этажа = какой слот забега он заполняет. start/finale — структурные позиции. */
const floorRoleEnum = z.enum(['combat', 'elite', 'boss', 'treasure', 'event', 'shop', 'rest', 'finale']);
/** Фичи этажа: что на нём размещается (декор/спец-комнаты). */
const floorFeaturesSchema = z
  .object({
    /** Портал возврата в город. */
    portal: z.boolean().default(false),
    /** Общий сундук аккаунта. */
    stash: z.boolean().default(false),
    /** Лавка (торговец). */
    shop: z.boolean().default(false),
    /** Запертая арена с боссом (замок дверь↔рычаг на дальней комнате). */
    bossRoom: z.boolean().default(false),
    /** Сколько комнат населить чемпионами. */
    championRooms: z.number().int().min(0).default(0),
    /** Сколько комнат-сокровищниц (сундук). */
    treasureRooms: z.number().int().min(0).default(0),
  })
  .default({});

export const floorsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли этаж в игре (выключенный не попадает в генерацию, но остаётся в редакторе). */
    enabled: z.boolean().default(true),
    desc: z.string().default(''),
    /** Роль — какой слот забега заполняет (combat/elite/boss/treasure/event/shop/rest/finale). */
    role: floorRoleEnum.default('combat'),
    /** id биома-темы (тайлсет/монстры/лор). */
    biomeId: z.string(),
    /** id шаблонов забега, где этаж доступен (пусто = во всех). */
    templates: z.array(z.string()).default([]),
    /** Тип генерации + параметры (включая размер cols/rows). */
    algoParams: floorAlgoParamsSchema,
    /** Фичи: портал/сундук/лавка/босс-комната/комнаты чемпионов/сокровищницы. */
    features: floorFeaturesSchema,
    /** Множитель плотности пачек монстров (D2-like). */
    packDensity: z.number().min(0).default(1),
    /** Минимальная глубина, с которой этаж может появиться. */
    minDepth: z.number().int().min(1).default(1),
    /** Максимальная глубина, до которой этаж может появиться. */
    maxDepth: z.number().int().min(1).default(99),
    /** Вес выбора среди подходящих этажей. */
    weight: z.number().min(0).default(1),
  }),
);

/** Биом = ТЕМА локации (тайлсет/монстры/фракция/лор), выбирается на ВЕСЬ забег. Геометрия — в `floors`. */
export const biomesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли биом (выключенный не предлагается в алтаре забега). */
    enabled: z.boolean().default(true),
    tileset: z.string(),
    /** Тематическое описание/лор биома (многострочный). */
    desc: z.string().default(''),
    /** Лорная фраза-девиз биома. */
    tagline: z.string().default(''),
    /** Доминирующая фракция монстров (аффинити классов; server-ready hook). */
    faction: z.enum(['undead', 'demon', 'beast', 'monster']).default('monster'),
    /** Флейвор-список врагов из лора (для описания; НЕ id монстров). */
    enemies: z.array(z.string()).default([]),
    monsterPool: z.array(z.string()),
    dropBias: z.number().min(0).default(1),
    /** id модификаторов, всегда активных в этом биоме (задел). */
    modifiers: z.array(z.string()).default([]),
    /**
     * Задел: под-варианты биома, включающиеся с достигнутой глубины (мрачнее — другие текстуры/монстры).
     * Пусто — биом однороден. Выбор варианта — по максимальному `fromDepth ≤ depth`.
     */
    variants: z
      .array(
        z.object({
          fromDepth: z.number().int().min(1),
          tileset: z.string(),
          monsterPool: z.array(z.string()).optional(),
        }),
      )
      .default([]),
  }),
);

/** Эффект модификатора: op к стат-ключу баланса/лута/монстров. Применение в бою — Ф4 (сейчас — генерация/статистика). */
const modEffectSchema = z.object({
  stat: z.string(),
  op: z.enum(['add', 'mul']),
  value: z.number(),
});
/**
 * Реестр модификаторов забега (Relics/Afflictions/Boons + waystone-mods PoE2). Основа расширения:
 * новый модификатор = запись в JSON. `scope:'run'` — на весь забег (выбирается в алтаре),
 * `scope:'node'` — навешивается генератором на отдельный узел (реклама вперёд).
 */
export const runModifiersSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли модификатор (выключенный не навешивается/не в алтаре). */
    enabled: z.boolean().default(true),
    kind: z.enum(['prefix', 'suffix', 'relic', 'affliction', 'boon']),
    /** Тир силы (как у waystone-mod); необязателен. */
    tier: z.number().int().min(1).optional(),
    tags: z.array(z.string()).default([]),
    scope: z.enum(['run', 'node']),
    /** Вес выбора генератором (для scope:'node'). */
    weight: z.number().min(0).default(1),
    desc: z.string().default(''),
    effects: z.array(modEffectSchema).default([]),
  }),
);

const runNodeTypeEnum = z.enum(['combat', 'elite', 'boss', 'treasure', 'event', 'shop', 'rest']);
/**
 * Шаблон забега (пресет «алтаря»): дефолты параметров, которые игрок тюнит перед генерацией.
 * Тир — id из `difficulties`. Точная поэтажная раскладка НЕ задаётся — только параметры + сид.
 */
export const runTemplatesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли шаблон (выключенный не предлагается в алтаре). */
    enabled: z.boolean().default(true),
    /** Тир сложности (id из difficulties). */
    tier: z.string().default('normal'),
    /** Длина забега (число слоёв графа) — диапазон, из которого сид выбирает. */
    length: z
      .object({ min: z.number().int().min(1).default(6), max: z.number().int().min(1).default(10) })
      .default({ min: 6, max: 10 }),
    /** Ширина слоя (число параллельных узлов) — управляет развилками. */
    width: z
      .object({ min: z.number().int().min(1).default(1), max: z.number().int().min(1).default(3) })
      .default({ min: 1, max: 3 }),
    /** Степень ветвления 0..1 (шанс развилок/схождений). */
    branching: z.number().min(0).max(1).default(0.5),
    /** Точка возврата (rest) каждые N слоёв (+jitter). 0 — нет rest-узлов. */
    returnEvery: z.number().int().min(0).default(4),
    returnJitter: z.number().int().min(0).default(1),
    /** Босс каждые N слоёв (0 — только финальный). */
    bossEvery: z.number().int().min(0).default(5),
    /** Есть ли финальный узел (finale). */
    finale: z.boolean().default(true),
    /** Веса типов узлов (start/finale/boss/rest назначаются структурно, не по весам). */
    nodeTypeWeights: z
      .record(runNodeTypeEnum, z.number())
      .default({ combat: 6, elite: 2, treasure: 1, event: 1, shop: 1 }),
    /** id модификаторов, доступных в алтаре этого шаблона (пусто — все scope:'run'). */
    allowedModifiers: z.array(z.string()).default([]),
  }),
);

export type FloorAlgoParams = z.infer<typeof floorAlgoParamsSchema>;
export type Floor = z.infer<typeof floorsSchema>[number];
export type FloorRole = z.infer<typeof floorRoleEnum>;
export type FloorFeatures = z.infer<typeof floorFeaturesSchema>;
export type Biome = z.infer<typeof biomesSchema>[number];
export type RunModifier = z.infer<typeof runModifiersSchema>[number];
export type MonsterRole = z.infer<typeof monsterRolesSchema>[number];
export type RunTemplate = z.infer<typeof runTemplatesSchema>[number];
export type RunNodeType = z.infer<typeof runNodeTypeEnum> | 'start' | 'finale';

// ── skills ──────────────────────────────────────────────────────────────────
const skillCostSchema = z.object({
  type: z.enum(['points', 'gold']),
  amount: z.number().min(0),
});

/**
 * Реактивный триггер мастерства: срабатывает на боевое событие при условии.
 * `hit-dealt` — при ударе игрока (усиление по горящим/фракции/оглушённым);
 * `hit-taken` — при получении урона (реталия-отражение, снижение урона).
 * Числовые эффекты масштабируются рангом узла.
 */
const triggerSchema = z.object({
  on: z.enum(['hit-dealt', 'hit-taken']),
  condition: z
    .object({
      targetBurning: z.boolean().optional(),
      targetStunned: z.boolean().optional(),
      targetFaction: z.enum(['undead', 'demon', 'beast', 'monster']).optional(),
      selfHpBelowPct: z.number().min(0).max(1).optional(),
      /** Активен только пока включён этот тогл (id узла). */
      whileToggle: z.string().optional(),
    })
    .optional(),
  effect: z.object({
    /** hit-dealt: +доля к пакету урона (за ранг). */
    bonusDamagePct: z.number().optional(),
    /** hit-taken: доля полученного урона обратно атакующему (за ранг). */
    reflectPct: z.number().optional(),
    reflectElement: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).optional(),
    /** hit-taken: −доля получаемого урона (за ранг, суммарно капится). */
    damageTakenReductionPct: z.number().min(0).max(1).optional(),
  }),
});

// ── Активная способность (v2): категория-дискриминатор + ограничения оружия ──
const damageTypeEnum = z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']);
const debuffKindEnum = z.enum(['wound', 'bleed', 'sunder', 'daze', 'burn', 'poison', 'shock', 'freeze']);
const ailmentApplySchema = z.object({
  /**
   * Явный вид статуса (переопределяет вывод из `element`). Нужен физ. дебафам скиллов
   * (рана/увечье/кровотечение/оглушение) и проклятиям (слабость=wound, −броня=sunder, ослепление=bleed):
   * из `element` физика даёт null. Стихийные (burn/freeze/shock/poison) можно не указывать — выведутся.
   */
  kind: debuffKindEnum.optional(),
  chance: z.number().min(0).max(1),
  mag: z.number(),
  mag2: z.number().optional(),
  maxStacks: z.number().int().min(1),
  durationMs: z.number().min(0),
});
/** Ограничения оружия скилла (пусто → любое). Тип атаки + вид урона + класс + число рук + требование дуала. */
const weaponRestrict = {
  attackTypes: z.array(z.enum(['melee', 'ranged'])).optional(),
  damageKinds: z.array(z.enum(['physical', 'magical'])).optional(),
  weaponClasses: z.array(z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'])).optional(),
  hands: z.enum(['any', 'one', 'two']).default('any'),
  /** Требует два оружия в руках (оба слота — оружие, не щит). Для ветки «дуал». */
  requiresDual: z.boolean().default(false),
};
const activeCommon = {
  abilityId: z.string(),
  manaCost: z.number().min(0).default(0),
  /** Из какого пула списывается стоимость (боевые — выносливость, магические — мана).
   *  Для аур/стоек — какой пул резервируется. */
  resource: z.enum(['mana', 'stamina']).default('mana'),
  /** КД, сек. 0 = без КД (тайминг от attackSpeed×speed). */
  cooldown: z.number().min(0).default(0),
  /** Имена сохранённых поз-клипов из редактора поз (напр. `s_hit_sword`, `hit_axe`) для АНИМАЦИИ этого скила/атаки в 3D.
   *  Несколько → чередуются по кругу при каждом срабатывании (замах справа, затем слева, …). Пусто/нет — удар по оружию. */
  poseClips: z.array(z.string()).optional(),
};
/** Форма урона скилла (attack/cast): к чему применять множитель + добавка стихии. Вместе с `convertPct`/`element`
 *  задаёт 3 режима: обычный удар (multScope=base — бонус только на баз. тип, стихии гира не раздуваются),
 *  «всё в стихию» (convertPct=1), «добавить стихию сверху» (addElementPct>0). */
const damageShape = {
  /** Множитель урона применяется к: `base` — только базовый тип оружия (стихии гира — плоско), `all` — весь пакет. */
  multScope: z.enum(['base', 'all']).default('base'),
  /** Добавить эту долю базового (пост-множитель) урона как стихию `element` сверх состава (прочие типы не трогает). */
  addElementPct: z.number().min(0).default(0),
};

/** Атака: удар/выстрел ОРУЖИЕМ (геометрия/состав от оружия) + моды скилла. Мили ИЛИ снаряд(ы). */
const attackAbilitySchema = z.object({
  category: z.literal('attack'),
  ...activeCommon,
  ...weaponRestrict,
  ...damageShape,
  speed: z.number().min(0.1).default(1),
  damageMult: z.number().min(0).default(1),
  /** Множители дуги/дальности ПОВЕРХ геометрии оружия. */
  arcMult: z.number().min(0).default(1),
  rangeMult: z.number().min(0).default(1),
  windupSec: z.number().min(0).default(0),
  knockback: z.number().min(0).default(0),
  shoveChance: z.number().min(0).max(1).default(1),
  stunSec: z.number().min(0).default(0),
  /** Стихия конверсии/статуса (сам урон — состав оружия, если convertPct=0). */
  element: damageTypeEnum.optional(),
  /** Доля урона (0..1), сливаемая в `element` (как у каста): 0 = сохранить состав гира (обычный усиленный удар),
   *  1 = весь урон в одну стихию (спец «ледяной удар» — статус только от неё), между — частичная конверсия. */
  convertPct: z.number().min(0).max(1).default(0),
  ailment: ailmentApplySchema.optional(),
  /** Веер снарядов (дальнобой/маг): count>1 стрел со spread; урон каждой = damageMult (ставь ниже для веера).
   *  Для мили игнорируется. */
  count: z.number().int().min(1).default(1),
  spread: z.number().min(0).default(0),
  pierce: z.boolean().default(false),
  /** Мили: число последовательных ударов за один скилл (каждый = damageMult). 1 = обычный одиночный. */
  hits: z.number().int().min(1).default(1),
});

/** Каст: особая механика (рывок/прыжок/нова/лужа/метеор/бумеранг). Тайминг — от скорости каста (INT). */
const castAbilitySchema = z.object({
  category: z.literal('cast'),
  ...activeCommon,
  ...weaponRestrict,
  ...damageShape,
  shape: z.enum(['dash', 'leap', 'nova', 'ground', 'meteor', 'boomerang']),
  element: damageTypeEnum.optional(),
  /** Каст-тайм, сек (делится на castSpeed от Интеллекта) — замах-рут перед срабатыванием. */
  castTimeSec: z.number().min(0).default(0.4),
  /** Доля урона оружия, конвертируемая в стихию каста (0..1). Совпал посох по стихии → весь урон в неё. */
  convertPct: z.number().min(0).max(1).default(0.5),
  damageMult: z.number().min(0).default(1),
  radius: z.number().min(0).default(0),
  knockback: z.number().min(0).default(0),
  shoveChance: z.number().min(0).max(1).default(1),
  stunSec: z.number().min(0).default(0),
  ailment: ailmentApplySchema.optional(),
  /** Рывок/прыжок (shape dash/leap): дальность перемещения, скорость, добавка к весу для расталкивания. */
  dashDist: z.number().min(0).default(130),
  dashSpeed: z.number().min(1).default(700),
  dashWeightBonus: z.number().min(0).default(200),
});

/** Проклятие: накладывает дебафы/статусы на врагов в радиусе. Тайминг — от скорости каста (INT). */
const curseAbilitySchema = z.object({
  category: z.literal('curse'),
  ...activeCommon,
  ...weaponRestrict,
  /** Каст-тайм, сек (делится на castSpeed от Интеллекта). */
  castTimeSec: z.number().min(0).default(0.3),
  radius: z.number().min(0).default(200),
  element: damageTypeEnum.optional(),
  /** Накладываемый статус-дебаф врагам в радиусе (ожог/озноб/…). */
  ailment: ailmentApplySchema.optional(),
  /** Притянуть агро (как прежний taunt). */
  taunt: z.boolean().default(false),
});

/** Аура: тогл, резервирует ману, даёт стат-моды (пати-радиус — задел). */
const auraAbilitySchema = z.object({
  category: z.literal('aura'),
  ...activeCommon,
  toggleGroup: z.string().optional(),
  reservePct: z.number().min(0).max(1).optional(),
  buffMods: z.array(statModifierSchema).optional(),
  radius: z.number().min(0).optional(),
});

/** Стойка: личный тогл-эксклюзив, резерв маны + стат-моды. */
const stanceAbilitySchema = z.object({
  category: z.literal('stance'),
  ...activeCommon,
  toggleGroup: z.string().optional(),
  reservePct: z.number().min(0).max(1).optional(),
  buffMods: z.array(statModifierSchema).optional(),
});

/** Временный бафф: стат-моды за ману на durationSec. */
const buffAbilitySchema = z.object({
  category: z.literal('buff'),
  ...activeCommon,
  durationSec: z.number().min(0).default(10),
  buffMods: z.array(statModifierSchema).optional(),
});

export const activeAbilitySchema = z.discriminatedUnion('category', [
  attackAbilitySchema, castAbilitySchema, curseAbilitySchema, auraAbilitySchema, stanceAbilitySchema, buffAbilitySchema,
]);

const skillEffectSchema = z.object({
  modifiers: z.array(statModifierSchema).optional(),
  /** Реактивные триггеры мастерства (условные эффекты на удар/получение урона). */
  triggers: z.array(triggerSchema).optional(),
  /** Условный «сет»-бонус: моды даются, только если экипирован комплект брони одного класса. */
  setBonus: z
    .object({
      /** Требуемый класс всей брони (напр. plate — «полный латный доспех»). */
      requireArmorClass: z.string(),
      /** Сколько частей брони одного класса должно быть надето. */
      minPieces: z.number().int().min(1).default(4),
      /** Моды за ранг узла при выполнении условия. */
      mods: z.array(statModifierSchema),
    })
    .optional(),
  /** Активная способность (v2): дискриминированная по `category` (attack/cast/aura/stance/buff). */
  active: activeAbilitySchema.optional(),
});

const skillNodeBase = {
  id: z.string(),
  name: z.string(),
  description: z.string(),
  cost: skillCostSchema,
  requires: z.array(z.string()),
  maxRank: z.number().int().min(1),
  levelReq: z.number().int().min(1).default(1),
  effect: skillEffectSchema,
  x: z.number(),
  y: z.number(),
};

export const skillsActiveSchema = z.array(
  z.object({
    classId: z.string(),
    branches: z.array(z.object({ id: z.string(), name: z.string() })),
    nodes: z.array(
      z.object({
        ...skillNodeBase,
        kind: z.literal('active'),
        branchId: z.string(),
      }),
    ),
  }),
);

export const skillsPassiveSchema = z.object({
  entryNodes: z.array(z.string()),
  /** Неориентированные связи между узлами (для правила смежности и отрисовки графа). */
  edges: z.array(z.tuple([z.string(), z.string()])).default([]),
  nodes: z.array(
    z.object({
      ...skillNodeBase,
      kind: z.literal('passive'),
      /** Усиленный узел («нотабль») — крупнее в графе. */
      notable: z.boolean().default(false),
    }),
  ),
});

/** Группа ветки древа скилов (для UI/генератора/иконки). */
const skillGroupEnum = z.enum([
  'melee1h', 'melee2h', 'ranged', 'dual', 'weapon-magic',
  'element', 'curse', 'aura', 'stance', 'armor', 'shield', 'class',
]);

/**
 * Единое ДРЕВО СКИЛОВ (актив + пассив), общее для всех классов. Ветки по типу оружия / стихии / проклятьям /
 * аурам / стойкам / броне / щиту. Прокачка — по смежности от входа ветки (как древо мастерства), за очки скилла.
 * Использование активок гейтится надетым оружием (`weaponRestrict` берётся из ветки → `weaponAllowed`).
 */
export const skillTreeSchema = z.object({
  branches: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      group: skillGroupEnum,
      /** Класс-гейт: если задан — ветка (её вход/узлы) доступна только этому classId. Пусто → всем. */
      classId: z.string().optional(),
      /** Пул ресурса активок ветки: spend (атаки/каст) или reserve (ауры/стойки — по category узла). */
      resource: z.enum(['stamina', 'mana', 'none']).default('none'),
      // Гейт использования (пусто → без ограничения); проставляется узлам ветки в weaponRestrict.
      weaponClasses: z.array(z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'])).optional(),
      attackType: z.enum(['melee', 'ranged']).optional(),
      damageKind: z.enum(['physical', 'magical']).optional(),
      hands: z.enum(['any', 'one', 'two']).optional(),
      element: damageTypeEnum.optional(),
      armorClasses: z.array(z.string()).optional(),
      requiresDual: z.boolean().optional(),
      entryNode: z.string(),
    }),
  ),
  entryNodes: z.array(z.string()).default([]),
  edges: z.array(z.tuple([z.string(), z.string()])).default([]),
  nodes: z.array(
    z.object({
      ...skillNodeBase,
      /** Активный (биндится, effect.active) или пассивный (тематический %-стат ветки). */
      kind: z.enum(['active', 'passive']),
      branchId: z.string(),
      notable: z.boolean().default(false),
    }),
  ),
});
export type SkillTree = z.infer<typeof skillTreeSchema>;
export type SkillTreeNode = SkillTree['nodes'][number];
export type SkillTreeBranch = SkillTree['branches'][number];

// ── quests ──────────────────────────────────────────────────────────────────
const objectiveTypeEnum = z.enum([
  'kill',
  'reach-floor',
  'collect-item',
  'talk-npc',
]);

const questRewardSchema = z.object({
  gold: z.number().optional(),
  xp: z.number().optional(),
  skillPoints: z.number().optional(),
  itemBaseId: z.string().optional(),
});

export const questsMainSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли квест (выключенный пропускается в цепочке основных квестов). */
    enabled: z.boolean().default(true),
    description: z.string(),
    objectives: z.array(
      z.object({
        id: z.string(),
        type: objectiveTypeEnum,
        target: z.string().optional(),
        amount: z.number().int().min(1),
      }),
    ),
    reward: questRewardSchema,
    next: z.string().optional(),
  }),
);

export const questsRandomSchema = z.array(
  z.object({
    id: z.string(),
    /** Активен ли шаблон случайного квеста (выключенный не попадает на доску). */
    enabled: z.boolean().default(true),
    objectiveType: objectiveTypeEnum,
    amountRange: z.tuple([z.number(), z.number()]),
    targetPool: z.array(z.string()),
    rewardGoldRange: z.tuple([z.number(), z.number()]),
    rewardXpRange: z.tuple([z.number(), z.number()]),
    rewardItemPool: z.array(z.string()).optional(),
  }),
);

// ── room-prefabs (рукотворные комнаты/этажи, рисуются по клеткам в редакторе) ──
/**
 * Префаб комнаты/этажа: рисуется по клеткам. `terrain` — h строк по w символов
 * (`.`пол `#`стена `o`колонна `+`дверь-проём); `zones` — параллельная сетка меток контента
 * (` `нет `d`декор `m`монстр `c`сундук `e`вход `x`выход) — генератор при генерации ставит туда
 * ПОДХОДЯЩИЙ контент (по типу/размеру; задел под 3D-библиотеку). `scope`: room = часть этажа
 * (генератор вставляет вместо процедурной комнаты), floor = целый этаж (алгоритм prefab).
 */
export const roomPrefabsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean().default(true),
    scope: z.enum(['room', 'floor']).default('room'),
    /** В каких биомах может появляться (id из `biomes`). Пусто = во всех биомах. */
    biomes: z.array(z.string()).default([]),
    /** В каких типах генерации участвует (rooms/bsp/cellular/maze/prefab). Пусто = во всех. */
    algorithms: z.array(z.string()).default([]),
    w: z.number().int().min(3).max(80).default(12),
    h: z.number().int().min(3).max(80).default(9),
    /** Террейн: h строк по w символов ('.'пол '#'стена 'o'колонна '+'дверь-проём). */
    terrain: z.array(z.string()).default([]),
    /** Зоны контента: h строк по w символов (' 'нет 'd'декор 'm'монстр 'c'сундук 'e'вход 'x'выход). */
    zones: z.array(z.string()).default([]),
    /** Теги (биом/тема/роль) — для будущего подбора генератором. */
    tags: z.array(z.string()).default([]),
    /** Вес выбора генератором. */
    weight: z.number().min(0).default(1),
  }),
);
export type RoomPrefab = z.infer<typeof roomPrefabsSchema>[number];

/** Реестр всех схем: ключ конфига → схема. */
export const configSchemas = {
  balance: balanceSchema,
  classes: classesSchema,
  'items.base': itemsBaseSchema,
  affixes: affixesSchema,
  uniques: uniquesSchema,
  monsters: monstersSchema,
  'monster-affixes': monsterAffixesSchema,
  'monster-roles': monsterRolesSchema,
  packs: packsSchema,
  difficulties: difficultiesSchema,
  biomes: biomesSchema,
  floors: floorsSchema,
  'run-modifiers': runModifiersSchema,
  'run-templates': runTemplatesSchema,
  'item-tiers': itemTiersSchema,
  'armor-classes': armorClassesSchema,
  'phys-subtypes': physSubtypesSchema,
  'weapon-weights': weaponWeightsSchema,
  'damage-kinds': damageKindsSchema,
  'magic-subtypes': magicSubtypesSchema,
  debuffs: debuffsSchema,
  rarities: raritiesSchema,
  'rare-names': rareNamesSchema,
  'mastery-tree': skillsPassiveSchema,
  'skill-tree': skillTreeSchema,
  'quests.main': questsMainSchema,
  'quests.random': questsRandomSchema,
  'room-prefabs': roomPrefabsSchema,
} as const;

export type ConfigKey = keyof typeof configSchemas;

export type ConfigShapes = {
  [K in ConfigKey]: z.infer<(typeof configSchemas)[K]>;
};
