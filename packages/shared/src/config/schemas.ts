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
  passivePointsPerLevel: z.number().int().min(0).default(2),
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
  /** Множитель урона на единицу профильного атрибута по типу оружия. */
  weaponAttrScaling: z.object({
    melee: z.number(),
    ranged: z.number(),
    magic: z.number(),
  }),
  /** Доп. множитель силовых сигнатур двуручного оружия. */
  twoHandedPowerMult: z.number().min(1).default(1.3),
  forgePrices: z.object({
    upgradeTier: z.number().int().min(0),
    rerollAffix: z.number().int().min(0),
  }),
  respecCost: z.number().int().min(0),
  /** Сброс пассивов: комиссия = доля вложенного в пассивы золота (растёт с прокачкой). */
  passiveRespecCostPct: z.number().min(0).default(0.5),
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
    })
    .default({ ambient: 0.8, perDepth: 0.015, ambientMax: 0.92, playerRadius: 160, torchRadius: 140 }),
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
  /** База маны (при 0 инт., 1-й уровень). */
  manaBase: z.number().default(20),
  /** Мана за 1 очко интеллекта. */
  manaPerIntelligence: z.number().default(3),
  /** Мана за каждый уровень после 1-го. */
  manaPerLevel: z.number().default(0),
  /** Меткость (рейтинг атаки) за каждый уровень после 1-го — чтобы не отставать от уклонения монстров. */
  accuracyPerLevel: z.number().default(2),
}).default({});

export const classesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    startAttributes: attributesSchema,
    startWeaponId: z.string(),
    activeTreeId: z.string(),
    sprite: z.string(),
    /** Фракции, против которых класс силён (аффинити: +affinityDamageBonus урона). */
    affinity: z.array(z.enum(['undead', 'demon', 'beast', 'monster'])).default([]),
    /**
     * Доступные ВХОДЫ пассивного древа (id узлов-входов, обычно 2). Класс может начинать
     * прокачку только с них; остальное — по смежности (в т.ч. переходы в соседние ветви).
     * Пусто = доступны ВСЕ входы (без ограничения).
     */
    passiveEntries: z.array(z.string()).default([]),
    /** Масштаб пулов HP/маны этого класса (от выносливости/интеллекта и уровня). */
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
  /** Подтип (паттерн атаки/скейл): ближний/дальний/магический. */
  weaponType: z.enum(['melee', 'ranged', 'magic']),
  /** Класс оружия (ветвь дерева редактора). */
  weaponClass: z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'bow', 'crossbow', 'wand', 'staff']),
  /** id веса (из конфига weapon-weights). */
  weight: z.string().default('medium'),
  /** id физ-подтипа (из конфига phys-subtypes). */
  physSub: z.string().optional(),
  damageType: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).default('physical'),
  hands: z.number().int().min(1).max(2).default(1),
  // Сигнатурные свойства (см. WeaponSignature).
  scaleAttr: attributeEnum.optional(),
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
export const affixesSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(['prefix', 'suffix']),
    stat: z.string(),
    modKind: z.enum(['flat', 'increased']),
    tiers: z.array(
      z.object({
        min: z.number(),
        max: z.number(),
        ilvl: z.number().int().min(1),
      }),
    ),
  }),
);

// ── uniques ─────────────────────────────────────────────────────────────────
export const uniquesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
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
    color: z.string(),
    /** Кумулятивный порог r< (rarest-first): unique 0.02, rare 0.12, magic 0.40, normal 1.0. */
    threshold: z.number().min(0).max(1),
    minAffixes: z.number().int().min(0),
    maxAffixes: z.number().int().min(0),
    /** Множитель цены покупки/продажи. */
    priceMult: z.number().min(0).default(1),
  }),
);

// ── damage-types ──────────────────────────────────────────────────────────────
/** Метаданные типов урона (сам набор — структурный, ключи DamagePacket): имя, цвет,
 * какой стих. статус накладывает. */
export const damageTypesSchema = z.array(
  z.object({
    id: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']),
    name: z.string(),
    /** Короткая подпись (в строке урона). */
    short: z.string(),
    /** Цвет (hex) — всплывающие числа/иконки. */
    color: z.string(),
    /** Стих. статус, накладываемый этим типом (null у физического). */
    ailment: z.enum(['burn', 'freeze', 'shock', 'poison']).nullable().default(null),
  }),
);

// ── weapon-weights ────────────────────────────────────────────────────────────
/** Справочник весов оружия: множители сигнатур (power/finesse) + доли скейла урона. */
export const weaponWeightsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Множитель силовых сигнатур (стан/увечье/ошеломление): тяжелее — больше. */
    power: z.number().min(0),
    /** Множитель finesse-сигнатур (рана/кровотечение): легче — больше. */
    finesse: z.number().min(0),
    /** Доли скейла урона от атрибутов (Сила / Ловкость). */
    strength: z.number().min(0),
    dexterity: z.number().min(0),
    /** Вклад в вес игрока (расталкивание): тяжёлое оружие — больше. */
    weight: z.number().min(0).default(10),
  }),
);

// ── phys-subtypes ─────────────────────────────────────────────────────────────
/** Справочник подтипов физ. урона: какой статус вешают + параметры дебаффа. */
const debuffScaleEnum = z.enum(['power', 'finesse', 'none']).default('none');
export const physSubtypesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Физ-статус, который накладывает этот подтип. */
    kind: z.enum(['wound', 'bleed', 'sunder', 'daze']),
    /** Дебафф от УДАРА ОРУЖИЯ (шанс/сила масштабируются весом: power/finesse/none). */
    weapon: z.object({
      chance: z.number().min(0),
      maxStacks: z.number().int().min(1),
      durationMs: z.number().min(0),
      mag: z.number(),
      mag2: z.number().optional(),
      chanceScale: debuffScaleEnum,
      magScale: debuffScaleEnum,
      mag2Scale: debuffScaleEnum,
    }),
    /** Дебафф от УДАРА МОНСТРА (mag фикс; `magPerDamage` — доля от maxDamage монстра). */
    monster: z.object({
      chance: z.number().min(0),
      maxStacks: z.number().int().min(1),
      durationMs: z.number().min(0),
      mag: z.number().default(0),
      mag2: z.number().optional(),
      magPerDamage: z.number().optional(),
    }),
  }),
);

// ── dungeons ────────────────────────────────────────────────────────────────
export const packsSchema = z.array(
  z.object({
    roomType: z.enum(['entrance', 'small', 'large', 'treasure', 'boss']),
    min: z.number().int().min(0),
    max: z.number().int().min(0),
    /** Форсировать чемпиона (для босс-комнат). */
    champion: z.boolean().default(false),
  }),
);

export const dungeonsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    tileset: z.string(),
    monsterPool: z.array(z.string()),
    dropBias: z.number(),
    modifiers: z.array(z.string()),
  }),
);

// ── difficulties ──────────────────────────────────────────────────────────────
export const difficultiesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
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
/** Ограничения оружия скилла (пусто → любое). Тип + класс + число рук. */
const weaponRestrict = {
  weaponTypes: z.array(z.enum(['melee', 'ranged', 'magic'])).optional(),
  weaponClasses: z.array(z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'bow', 'crossbow', 'wand', 'staff'])).optional(),
  hands: z.enum(['any', 'one', 'two']).default('any'),
};
const activeCommon = {
  abilityId: z.string(),
  manaCost: z.number().min(0).default(0),
  /** КД, сек. 0 = без КД (тайминг от attackSpeed×speed). */
  cooldown: z.number().min(0).default(0),
};

/** Атака: удар/выстрел ОРУЖИЕМ (геометрия/состав от оружия) + моды скилла. Мили ИЛИ снаряд(ы). */
const attackAbilitySchema = z.object({
  category: z.literal('attack'),
  ...activeCommon,
  ...weaponRestrict,
  speed: z.number().min(0.1).default(1),
  damageMult: z.number().min(0).default(1),
  /** Множители дуги/дальности ПОВЕРХ геометрии оружия. */
  arcMult: z.number().min(0).default(1),
  rangeMult: z.number().min(0).default(1),
  windupSec: z.number().min(0).default(0),
  knockback: z.number().min(0).default(0),
  shoveChance: z.number().min(0).max(1).default(1),
  stunSec: z.number().min(0).default(0),
  /** Стихия для накладываемого статуса (сам урон — состав оружия). */
  element: damageTypeEnum.optional(),
  ailment: ailmentApplySchema.optional(),
  /** Веер снарядов (дальнобой/маг): count>1 стрел со spread; урон каждой = damageMult (ставь ниже для веера).
   *  Для мили игнорируется. */
  count: z.number().int().min(1).default(1),
  spread: z.number().min(0).default(0),
  pierce: z.boolean().default(false),
});

/** Каст: особая механика (рывок/прыжок/нова/лужа/метеор/бумеранг). Тайминг — от скорости каста (INT). */
const castAbilitySchema = z.object({
  category: z.literal('cast'),
  ...activeCommon,
  ...weaponRestrict,
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

const activeAbilitySchema = z.discriminatedUnion('category', [
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
    objectiveType: objectiveTypeEnum,
    amountRange: z.tuple([z.number(), z.number()]),
    targetPool: z.array(z.string()),
    rewardGoldRange: z.tuple([z.number(), z.number()]),
    rewardXpRange: z.tuple([z.number(), z.number()]),
    rewardItemPool: z.array(z.string()).optional(),
  }),
);

/** Реестр всех схем: ключ конфига → схема. */
export const configSchemas = {
  balance: balanceSchema,
  classes: classesSchema,
  'items.base': itemsBaseSchema,
  affixes: affixesSchema,
  uniques: uniquesSchema,
  monsters: monstersSchema,
  'monster-affixes': monsterAffixesSchema,
  packs: packsSchema,
  dungeons: dungeonsSchema,
  difficulties: difficultiesSchema,
  'item-tiers': itemTiersSchema,
  'armor-classes': armorClassesSchema,
  'phys-subtypes': physSubtypesSchema,
  'weapon-weights': weaponWeightsSchema,
  'damage-types': damageTypesSchema,
  rarities: raritiesSchema,
  'skills-active': skillsActiveSchema,
  'skills-passive': skillsPassiveSchema,
  'quests.main': questsMainSchema,
  'quests.random': questsRandomSchema,
} as const;

export type ConfigKey = keyof typeof configSchemas;

export type ConfigShapes = {
  [K in ConfigKey]: z.infer<(typeof configSchemas)[K]>;
};
