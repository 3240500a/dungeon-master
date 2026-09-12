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
  uniqueXpMult: z.number().min(1).default(3),
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
      /**
       * Шанс, что убитый монстр роняет ГОТОВУЮ ВЕЩЬ.
       * ⚠ 0.10, а не прежние 0.55: основной поток наград теперь материалы (`materials` ниже).
       * ⭐ ПРАВИЛО №1 экономики: суммарная частота НАГРАД не падает, меняется только их ВИД.
       * Уронить это число, не подняв материалы, — значит повторить ошибку PoE 2 (docs/ECONOMY.md).
       */
      dropChance: z.number().min(0).max(1).default(0.1),
      /**
       * Доля дропа, которая СНИМАЕТСЯ С ТЕЛА: вещь игрока, похожая на надетое на монстре
       * (`formulas/trophy.ts`). Остальное — обычная находка со случайной базой.
       *
       * ⚠ НЕ 1.0, и это не недоделка. Монстры носят только оружие, нагрудник, щит и шлем —
       * сделай весь дроп трофейным, и перчатки, сапоги, пояс и украшения перестанут падать
       * вовсе (замерено: 5 из 9 слотов остаются без источника). Поднимать до 1.0 можно
       * только когда сундуки (Ч6) закроют остальные слоты.
       */
      trophyChance: z.number().min(0).max(1).default(0.7),
      /**
       * Доля ТРОФЕЕВ, падающих СЛОМАННЫМИ. 1.0 — все: вещь с трупа зомби целой не бывает.
       * Обычные находки целы всегда — иначе надеть в забеге было бы нечего вовсе.
       */
      brokenChance: z.number().min(0).max(1).default(1),
      /** Материалы с убитого монстра: считаются по ЕГО снаряжению (`monster-gear.salvageTo`). */
      materials: z
        .object({
          /** Доля убийств, дающих материалы. Держим высокой — это замена ушедшему потоку вещей. */
          chance: z.number().min(0).max(1).default(0.6),
        })
        .default({}),
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
  /** Множитель ТРЕБОВАНИЙ двуручного оружия при авто-заполнении по весу (магнитуда ×это). */
  twoHandReqMult: z.number().min(0).default(1.6),
  /** Кап СУММЫ требуемых атрибутов предмета (после тира). Превышение ужимается пропорционально
   *  (только сила → кап силы; сила+ловк → делится по доле). 0 = без капа. */
  maxTotalRequirement: z.number().min(0).default(180),
  forgePrices: z.object({
    upgradeTier: z.number().int().min(0),
    rerollAffix: z.number().int().min(0),
    /**
     * ⭐ ЦЕНА УЛУЧШЕНИЯ В МАТЕРИАЛАХ — лестница по редкости вещи.
     *
     * Обычная просит только первую ступень, магическая — первую И вторую, редкая — все три.
     * Каждая следующая редкость ДОБАВЛЯЕТ ступень, ничего не убирая: иначе чистое железо
     * стало бы мусором ровно тогда, когда игрок перерос магические вещи, а приходить бы
     * не перестало.
     *
     * Семья материала берётся из ПРАВИЛА РАЗБОРА той же вещи (`salvage-rules`): меч чинится
     * железом, лук — деревом, латы — пластинами. Одна таблица описывает и что вещь даёт,
     * и что она стоит, поэтому разойтись они не могут.
     */
    /**
     * ⭐ КУЗНЕЧНАЯ СКИДКА НА ТРЕБОВАНИЯ при подъёме тира (доля, 0.2 = −20 %).
     * Найденный «Мастерский» меч сильнее, кузнечный — доступнее раньше. Это и есть причина
     * возиться с крафтом, а не ждать удачного дропа.
     */
    upgradeReqDiscount: z.number().min(0).max(0.9).default(0.2),
    /**
     * Сколько раз ОДНУ вещь можно перекатить. Подъём тира ограничен `maxTier` базы сам по себе,
     * а перекатка крутит случайность: без предела её жмут, пока не выпадет идеал, и редкость
     * аффиксов перестаёт что-либо значить.
     */
    rerollLimit: z.number().int().min(0).default(3),
    /** Починка сломанного трофея: золото. */
    repairBroken: z.number().int().min(0).default(60),
    /**
     * Починка в материалах — та же лестница по редкости, что у улучшения, но дешевле.
     * ⚠ Дороже, чем даёт разбор той же вещи: иначе чинить было бы выгоднее всегда, и выбор
     * «починить или разобрать» исчез бы. Платим за ВЕЩЬ, а не за материалы в ней.
     */
    repairMaterials: z
      .object({
        tier1: z.number().int().min(0).default(6),
        tier2: z.number().int().min(0).default(2),
        tier3: z.number().int().min(0).default(1),
      })
      .default({}),
    upgradeMaterials: z
      .object({
        /** Сколько материала ПЕРВОЙ ступени. Нужен всем редкостям — это базовая валюта крафта. */
        tier1: z.number().int().min(0).default(20),
        /** Второй ступени — только магическим и выше. */
        tier2: z.number().int().min(0).default(5),
        /** Третьей — только редким. Самый дефицитный вход, он и гейтит топовый крафт. */
        tier3: z.number().int().min(0).default(2),
      })
      .default({}),
  }),
  respecCost: z.number().int().min(0),
  /** Сброс мастерства: комиссия = доля вложенного золота (растёт с прокачкой). */
  passiveRespecCostPct: z.number().min(0).default(0.5),
  /** Сброс дерева скилов: золото за каждое вложенное очко скилла. */
  skillRespecCostPerPoint: z.number().int().min(0).default(100),
  /**
   * ГНЁЗДА АКТИВНОГО СКИЛА — на каких рангах открывается очередное. Длина массива = потолок гнёзд.
   * В конфиге, а не в коде: это главная ручка глубины сборки, её крутит дизайнер.
   */
  skillSocketRanks: z.array(z.number().int().min(1)).default([1, 6, 12]),
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
      uniqueWeightMult: z.number().min(1).default(2),
    })
    .default({ enabled: true, iterations: 2, uniqueWeightMult: 2 }),
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
      // «В бою» линга (сек): столько держим боевую стойку после последнего боевого события (своя атака /
      // монстр целится). Клиент-вид (боевой айдл), баланс не трогает.
      combatLingerSec: z.number().min(0).max(30).default(3),
    })
    .default({ baseRange: 52, baseArc: 0.8, baseWindupFrac: 0.35, basicManaCost: 0, attackMoveMult: 0.2, combatLingerSec: 3 }),
  /** Уклонение (dodge-рывок на пробел): быстрый рывок в направлении движения (WASD; стоя — к прицелу),
   *  фикс. дистанция, кулдаун. Универсальное действие для кайта и сокращения дистанции. Позиционное
   *  (без i-frames) — уход из зоны удара; в рывке игрок «тяжёлый» (weightMult), расталкивает монстров. */
  dodge: z
    .object({
      distance: z.number().min(0).default(55),       // на сколько юнитов бросает (короткий шаг-уклон)
      speed: z.number().min(1).default(200),         // скорость рывка (юн/с) — длительность = distance/speed
      cooldownSec: z.number().min(0).default(1.2),   // кулдаун между уклонениями
      weightMult: z.number().min(1).default(3),      // масса игрока в рывке (расталкивание монстров)
      staminaCost: z.number().min(0).default(0),     // стоимость выносливости (0 = бесплатно, только КД)
    })
    .default({ distance: 55, speed: 200, cooldownSec: 1.2, weightMult: 3, staminaCost: 0 }),
  /** Нокдаун (сбить с ног): по шансу удар роняет монстра — он падает рагдоллом, лежит и встаёт, всё это время
   *  беспомощен и уязвим (+урон). Шанс ГИБКИЙ и аддитивный: база + вес оружия + добавка скилла (+стат гира позже),
   *  минус сопротивление по весу цели, с потолком (не «каждый удар»). Гарантированный нокдаун — у скилла (knockdownSec). */
  knockdown: z
    .object({
      enabled: z.boolean().default(true),
      chanceBase: z.number().min(0).max(1).default(0.85),      // ⚠ ВРЕМЕННО ДЛЯ ТЕСТА (боевой 0) (0 = роняет только вес оружия/скилл/стат)
      weaponWeightMult: z.number().min(0).default(0.004),      // вклад веса оружия в шанс (weaponWeight × это): булава роняет, кинжал ~0
      targetWeightResist: z.number().min(0).default(0.01),     // сопротивление цели по её весу (mass × это снижает шанс)
      maxChance: z.number().min(0).max(1).default(1),          // ⚠ ВРЕМЕННО ДЛЯ ТЕСТА (боевой 0.5) потолок шанса от НЕ-гарантированных источников (никогда не «каждый удар»)
      downSec: z.number().min(0).default(1.1),                 // сколько лежит на земле (рут), сек
      riseSec: z.number().min(0).default(0.8),                 // сколько встаёт (клиент — анимация подъёма; сервер держит рут весь период), сек
      vulnBonusPct: z.number().min(0).default(0.25),           // +доля урона по лежачему/встающему (окно для добива/комбо)
      knockbackDist: z.number().min(0).default(45),            // база отлёта ОТ атакующего (px) при типовом ударе (~1.5 м); авторитетный глайд позиции
      knockbackDmgScale: z.number().min(0).default(2),         // масштаб отлёта от силы удара: dist ×= clamp(0.4 + урон/maxHP × это, 0.4, 1.5) — сильнее бьёшь дальше летит
      knockbackSec: z.number().min(0.01).default(0.18),        // за сколько сек проезжает отлёт (глайд позиции сервером; клиент ведёт рагдолл по ней)
    })
    .default({ enabled: true, chanceBase: 0.85, weaponWeightMult: 0.004, targetWeightResist: 0.01, maxChance: 1, downSec: 1.1, riseSec: 0.8, vulnBonusPct: 0.25, knockbackDist: 45, knockbackDmgScale: 2, knockbackSec: 0.18 }),   // ⚠ ВРЕМЕННО chanceBase/maxChance (боевые 0/0.5) — объектный дефолт применяется, т.к. блока нет в balance.json
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
          // РАЗРЕШЕНИЕ теней (mapSize) вынесено в КЛИЕНТСКИЕ настройки (⚙, localStorage) — это перф-настройка ПК, не контент.
          /** Сдвиг тени (борьба с «акне»). Обычно небольшой минус. */
          bias: z.number().min(-0.02).max(0).default(-0.004),
          /** Сколько БЛИЖАЙШИХ факелов отбрасывают тень (point-light shadow дорогой — 6 граней). */
          torchCasters: z.number().int().min(0).max(8).default(2),
          /** Яркость точечного света факела (3D; вокруг неё мерцание). */
          torchIntensity: z.number().min(0).default(1500),
          /** Радиус/дальность света факела (3D, ед. мира; = дальность теневой камеры факела). */
          torchDist: z.number().min(0).default(380),
          /** Яркость точечного света героя (3D). */
          playerLightIntensity: z.number().min(0).default(6000),
          /** Радиус/дальность света героя (3D, ед. мира). */
          playerLightDist: z.number().min(0).default(620),
        })
        .default({ bias: -0.004, torchCasters: 2, torchIntensity: 1500, torchDist: 380, playerLightIntensity: 6000, playerLightDist: 620 }),
    })
    .default({ ambient: 0.8, perDepth: 0.015, ambientMax: 0.92, playerRadius: 160, torchRadius: 140, shadow3d: { bias: -0.004, torchCasters: 2, torchIntensity: 1500, torchDist: 380, playerLightIntensity: 6000, playerLightDist: 620 } }),
  /** Разбор вещей на материалы: где сколько выходит (docs/ECONOMY.md, Ч3). */
  salvage: z
    .object({
      /**
       * ⭐ ДОЛЯ ВЫХОДА ПРИ РАЗБОРЕ В ПОЛЕ. У кузнеца выход полный (1.0), в подземелье — эта доля.
       * Здесь весь смысл части Ч3: переработал на месте — гарантировал себе меньшее и ничего
       * не несёшь; донёс целиком — получил всё, но рискуешь половиной сумки при смерти.
       * ⚠ 0.3, а не 0.6: при 0.6 проще ВСЕГДА разбирать сразу, чем возиться с упаковкой сумки,
       * и выбор исчезает вместе со смыслом смерти (docs/ECONOMY.md, правило Р4).
       */
      fieldYield: z.number().min(0).max(1).default(0.3),
      /**
       * ⭐ РЕДКОСТЬ → СТУПЕНЬ МАТЕРИАЛА. Обычная вещь даёт ржавое, магическая — чистое,
       * редкая — калёное. Это ЕДИНАЯ истина и для разбора вещей, и для дропа с монстров.
       *
       * Почему редкость, а не глубина: цвет вещи и цвет имени монстра видно сразу, а глубину
       * игрок в голове не держит. И это наш единственный сигнал — пул снаряжения монстров один
       * и тот же на всех этажах, «ржавый топор» на двадцатом не выглядит лучше, чем на первом.
       *
       * ⚠ 0 = «не разбирается вовсе» — так выключены уникальные (решение В2).
       */
      rarityTier: z
        .object({
          normal: z.number().int().min(0).default(1),
          magic: z.number().int().min(0).default(2),
          rare: z.number().int().min(0).default(3),
          unique: z.number().int().min(0).default(0),
        })
        .default({}),
      /** Множитель выхода по слоту брони: нагрудник целый, перчатки — мелочь. */
      armorSlotMult: z
        .object({
          chest: z.number().min(0).default(1),
          helm: z.number().min(0).default(0.6),
          boots: z.number().min(0).default(0.6),
          gloves: z.number().min(0).default(0.4),
          belt: z.number().min(0).default(0.4),
        })
        .default({}),
    })
    .default({}),
  /**
   * ЧТО ПОДБИРАЕТСЯ САМО при проходе рядом; остальное лежит и берётся по клику или [E].
   * ⚠ Раньше это был массив редкостей, который НЕ ЧИТАЛА НИ ОДНА СТРОКА КОДА. Ключ ожил вместе
   * с физическим дропом золота и материалов: без автоподбора каждая монета требовала бы клика.
   */
  autoPickup: z
    .object({
      /** Радиус автоподбора, ед. мира (клетка = 32). Чуть шире ручного подбора (48). */
      radius: z.number().min(0).default(56),
      /** Золото поднимается само. */
      gold: z.boolean().default(true),
      /** Материалы поднимаются сами: они идут в кошелёк и места в сумке не занимают. */
      materials: z.boolean().default(true),
      /**
       * Редкости ВЕЩЕЙ, которые поднимаются сами. Пусто — ни одна, и это сознательный дефолт:
       * автоподбора вещей в игре не было никогда (ключ был мёртв), а «взять или оставить» —
       * это и есть добыча. Кто хочет прежнюю задумку — ставит сюда rare/unique.
       */
      rarities: z.array(z.enum(['normal', 'magic', 'rare', 'unique'])).default([]),
    })
    .default({}),
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
    /** Базовый 3D-вид класса (атлас), когда слот ПУСТ (нет экипировки): submesh-вариант по умолчанию.
     *  Ключи — логические части тела → слоты атласа: hair→helm (причёска без шлема), head→head, hands→gloves,
     *  body→chest, feet→boots. Пусто/нет → показать все submesh слота (как раньше). Надетый предмет (modelId) перекрывает. */
    baseAppearance: z.object({
      hair: z.string().optional(), head: z.string().optional(), hands: z.string().optional(),
      body: z.string().optional(), feet: z.string().optional(),
    }).optional(),
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
  /** id 3D-модели (конфиг models) для рендера меша оружия в руке. Нет → процедурный меш по weaponClass. */
  modelId: z.string().optional(),
});

const armorBaseSchema = z.object({
  kind: z.literal('armor'),
  ...itemBaseCommon,
  slot: z.enum(['helm', 'chest', 'gloves', 'boots', 'belt']),
  /** id класса брони (из конфига armor-classes). */
  armorClass: z.string(),
  /** Кол-во быстрых слотов пояса (значимо только для slot='belt'; 0 — не пояс). */
  beltSlots: z.number().int().min(0).default(0),
  /** id 3D-модели (конфиг models) для меша брони в этом слоте — ОБЩАЯ на все классы (дефолт). Нет → базовый меш слота. */
  modelId: z.string().optional(),
  /** 3D-модель брони ПО КЛАССУ (id класса → modelId submesh-варианта). Перекрывает общий modelId для этого класса —
   *  так у каждого класса СВОЯ 3D-броня для этого предмета. Класса нет в карте → берётся общий modelId. */
  modelByClass: z.record(z.string(), z.string()).optional(),
  /** Материал брони ПО КЛАССУ (id класса → materialId из конфига materials). Накладывается на меш этого предмета у
   *  данного класса при экипировке (перекрывает материал сабмеша атласа). Класса нет в карте → материал сабмеша/дефолт. */
  materialByClass: z.record(z.string(), z.string()).optional(),
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
  /** id 3D-модели (конфиг models) для меша щита. Нет → процедурный. */
  modelId: z.string().optional(),
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
    /** Веса по ТЕГАМ базы (PoE2): для каждого токена базы (kind/слот/грань оружия, напр.
     *  `weapon.magical`, `weapon.physical`, `armor`) множитель к `weight`. Так магическое оружие
     *  чаще катает стихии/ману, физическое — физ-аффиксы. Пусто = вес не зависит от базы. */
    tagWeights: z.array(z.object({ tag: z.string(), mult: z.number().positive() })).default([]),
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
      /** Триггер: 'hit' — когда бьёшь сам; 'struck' — когда бьют тебя. */
      trigger: z.enum(['hit', 'struck']).default('hit'),
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
/** Авторская заготовка монстра: АТРИБУТЫ (STR/DEX/INT/VIT) + ЭКИПИРОВКА (id из monster-gear) —
 * зеркально игроку. Боевой стат-блок (hp/урон/меткость/армор/резисты/xp/ai/тип урона) НЕ хранится,
 * а деривится генератором (`generateMonster`→`deriveMonsterStats`) из атрибутов+гира по уровню.
 * Так масштабирование/баланс задаётся 4 числами + шмотом, а не два десятка полей руками. */
export const monstersSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активен ли монстр в игре (выключенный не спавнится, но остаётся в редакторе). */
    enabled: z.boolean().default(true),
    /** Фракция монстра (аффинити классов, профиль поведения, пул гира). */
    faction: z.enum(['undead', 'demon', 'beast', 'monster']).default('monster'),
    /** Подфракция (чисто визуал + тема аффиксов на магич./рарных, напр. «культ огня»). Пусто = базовая. */
    subfaction: z.string().default(''),
    /** id роли монстра (из monster-roles) — для состава пачек. */
    role: z.string().default('warrior'),
    /** Тир силы — множит xp и помогает подбору пачек (weak/medium/strong/boss). */
    tier: z.enum(['weak', 'medium', 'strong', 'boss']).default('medium'),
    // ── Атрибуты (как у игрока) ──
    str: z.number().min(0).default(10),
    dex: z.number().min(0).default(10),
    int: z.number().min(0).default(10),
    vit: z.number().min(0).default(10),
    // ── Экипировка (id из monster-gear своей фракции) ──
    /** Оружие (id monster-gear kind:weapon). Пусто/не найдено → «кулаки». Задаёт урон/тип/AI/скорость. */
    weapon: z.string().default(''),
    /** Броня тела (id monster-gear kind:armor, slot:chest). Пусто = без брони. */
    armor: z.string().default(''),
    /** Шлем (id monster-gear kind:armor, slot:helm). Пусто = без шлема. */
    helm: z.string().default(''),
    /** Левая рука — щит (id monster-gear kind:shield). Пусто = без щита. */
    offhand: z.string().default(''),
    /** Явный AI (иначе выводится из оружия: дальний→kiter, мили→chaser). */
    ai: z.enum(['melee-chaser', 'ranged-kiter', 'stationary']).optional(),
    /** Ручная кривая веса спавна по тирам глубины (0 чисел = авто из силового тира; иначе по числу
     *  тиров в depth-tiers). Гибрид: авто-заполнение по тиру + ручной дотюн в редакторе (график). */
    spawnCurve: z.array(z.number().min(0)).default([]),
    /** Переопределение коэффициентов деривации ДЛЯ ЭТОГО моба (пусто/null = берёт из общей `monster-derive`).
     *  z.lazy — monsterDeriveSchema объявлена ниже; резолвится при парсинге. nullable — редактор кладёт null
     *  для «не переопределено» (defaultValue не разворачивает lazy). В редакторе — кастом-рендер. */
    derive: z.lazy(() => monsterDeriveSchema).nullable().optional(),
    /** Скорость перемещения (px/с). */
    moveSpeed: z.number().default(50),
    sprite: z.string(),
    // ── Восприятие ──
    vision: z.number().default(240),
    visionAngle: z.number().default(100),
    hearing: z.number().default(96),
    /** Вес (масса) для расталкивания: тяжёлого двигают меньше. Уник ×balance.collision.uniqueWeightMult. */
    weight: z.number().min(0).default(100),
  }),
);

// ── depth-tiers ───────────────────────────────────────────────────────────────
/** Тиры глубины: 6 бэндов этажей, задающих ВЕС спавна по силовому тиру монстра (weak/medium/strong/boss)
 *  на этой глубине. Кривая монстра = столбец его `tier` по 6 рядам (авто) или его `spawnCurve` (ручной
 *  оверрайд). Контроль спавна по глубине СВЕРХ скейла от уровня/гира: «этажи 1–3 = почти только weak». */
export const depthTiersSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Первый этаж бэнда (1-based; = контрольная точка кривой для интерполяции). */
    fromFloor: z.number().int().min(1).default(1),
    /** Последний этаж бэнда (последний тир — большим числом = «и глубже»). */
    toFloor: z.number().int().min(1).default(999),
    /** Вес спавна (0..100) для каждого силового тира монстра на этом тире глубины. */
    weights: z.object({
      weak: z.number().min(0).default(0),
      medium: z.number().min(0).default(0),
      strong: z.number().min(0).default(0),
      boss: z.number().min(0).default(0),
    }),
  }),
);

// ── monster-derive ──────────────────────────────────────────────────────────
/** Коэффициенты деривации стат-блока монстра из атрибутов+гира (как деривация статов игрока):
 *  прирост атрибутов за уровень + сколько hp за VIT / урона за атрибут / меткости за DEX и т.д. Один
 *  объект (не массив). Крутизна кривых HP/урона задаётся здесь → тюн в калькуляторе. */
export const monsterDeriveSchema = z.object({
  /** Прирост атрибутов за уровень (доля от базы): A = base × (1 + (L-1)×levelGrowth). */
  levelGrowth: z.number().min(0).default(0.1),
  hpBase: z.number().default(6),
  hpPerVit: z.number().default(1.2),
  hpPerLevel: z.number().default(1),
  /** +доля урона оружия за ед. ведущего атрибута. */
  dmgPerAttr: z.number().default(0.02),
  armorPerStr: z.number().default(0.15),
  accBase: z.number().default(20),
  accPerLevel: z.number().default(3),
  evadeBase: z.number().default(5),
  evadePerDex: z.number().default(1.5),
  iasPerDex: z.number().default(0.001),
  critPerDex: z.number().default(0.0015),
  resistPerLevel: z.number().default(0.005),
  xpBase: z.number().default(12),
  xpPerLevel: z.number().default(5),
  /** Множитель xp по силовому тиру. */
  tierXp: z.object({
    weak: z.number().default(0.7),
    medium: z.number().default(1),
    strong: z.number().default(1.8),
    boss: z.number().default(4),
  }),
});

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

// ── monster-behaviors ─────────────────────────────────────────────────────────
/** Профиль поведения ИИ по ФРАКЦИИ (data-driven FSM). `ai` (melee/ranged/stationary) на монстре —
 * это КАК он атакует; профиль — КАК себя ведёт. Монстр берёт профиль по своей `faction`.
 * Ядро одинаково (мясить толпы), фракции дают небольшие отличия (главный рычаг мили — `fleeHpPct`). */
export const monsterBehaviorsSchema = z.array(
  z.object({
    faction: z.enum(['undead', 'demon', 'beast', 'monster']),
    // ── Восприятие / агро ──
    /** Задержка «заметил» перед первой атакой, сек (0 = мгновенно). */
    alertDelaySec: z.number().min(0).default(0),
    /** Реакция на шум: chase — сразу в погоню; investigate — идти к точке шума, атаковать лишь увидев. */
    hearingMode: z.enum(['chase', 'investigate']).default('chase'),
    /** Погоня после потери контакта, сек. */
    leashTimeSec: z.number().min(0).default(3.5),
    /** Дальше этого преследование обрывается. */
    leashRadius: z.number().min(0).default(560),
    /** Возврат на точку спавна при деагро. */
    returnHome: z.boolean().default(false),
    // ── Ближний бой ──
    /** advance — обычный подход; juggernaut — медленный тяжёлый (большие конструкты). */
    engageStyle: z.enum(['advance', 'juggernaut']).default('advance'),
    /** Порог отхода: отступает при HP ниже доли (0 = бесстрашный). ГЛАВНЫЙ per-faction рычаг мили. */
    fleeHpPct: z.number().min(0).max(1).default(0),
    /** Множитель замаха (тяжёлый телеграф; >1 у конструктов). */
    windupMult: z.number().min(0.1).default(1),
    /** Сопротивление прерыванию/оглушению 0..1 («поза»). */
    poise: z.number().min(0).max(1).default(0),
    /** Когезия стаи (звери) — тянуться к центру группы, 0 = нет. */
    packCohesion: z.number().min(0).default(0),
    // ── Дальний бой ──
    /** Ближняя граница «держать дистанцию» (ближе — отходит). */
    keepDistMin: z.number().min(0).default(140),
    /** Дальняя граница (дальше — сближается). */
    keepDistMax: z.number().min(0).default(220),
    /** Смена позиции стрелка: none — стоять; strafe — боковой сдвиг; blink — телепорт (джинны). */
    repositionMode: z.enum(['none', 'strafe', 'blink']).default('none'),
    /** Менять позицию после каждого выстрела. */
    repositionAfterShot: z.boolean().default(false),
    // ── Сигнатура ──
    /** Особая способность: overload — взрыв при смерти (конструкты). */
    signature: z.enum(['none', 'overload']).default('none'),
  }),
);

// ── monster-gear ──────────────────────────────────────────────────────────────
// Отдельная библиотека экипировки монстров по ФРАКЦИЯМ (те же параметры, что у items.base, но не
// дропается в общий пул). Монстр в дефе ссылается на гир по id (weapon/armor/offhand); статы
// деривятся из атрибутов монстра + этого гира (deriveMonsterStats). Афиксы элиток катаются на гир.
const mgFaction = z.enum(['undead', 'demon', 'beast', 'monster']);
/** Явная замена трофея: id базы ИГРОКА, если автоподбор по сходству промахнулся (`formulas/trophy.ts`). */
const trophyBaseSchema = z.string().optional();

/** Что даёт вещь снаряжения при разборе: сколько какого материала (docs/ECONOMY.md). */
// ⚠ `.optional()`, а НЕ `.default([])`: с дефолтом поле становится обязательным в выходном типе,
// и каждый литерал снаряжения в коде и тестах пришлось бы дописывать. Отсутствие поля читается
// как «с этой вещи ничего не падает» — ровно тот смысл, который нужен.
const salvageToSchema = z
  .array(z.object({ materialId: z.string(), min: z.number().int().min(0), max: z.number().int().min(0) }))
  .optional();

export const monsterGearSchema = z.array(
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('weapon'),
      id: z.string(),
      name: z.string(),
      faction: mgFaction,
      enabled: z.boolean().default(true),
      weaponClass: z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff']),
      /** Вес оружия — задаёт долю скейла по атрибуту (STR/DEX/INT). */
      weight: z.enum(['superlight', 'light', 'medium', 'heavy', 'magical']).default('medium'),
      attackType: z.enum(['melee', 'ranged']).default('melee'),
      hands: z.number().int().min(1).max(2).default(1),
      damageType: z.enum(['physical', 'fire', 'cold', 'lightning', 'poison']).default('physical'),
      /** Базовый урон оружия (до скейла по атрибуту). */
      minDamage: z.number().min(0).default(1),
      maxDamage: z.number().min(0).default(3),
      attackSpeed: z.number().min(0.05).default(1),
      physSub: z.string().optional(),
      /** id 3D-модели (конфиг models, kind='weapon' с weaponType===weaponClass) для меша оружия монстра. Нет → процедурка. */
      modelId: z.string().optional(),
      /** Что даёт при разборе — материалы ЭТОЙ вещи (docs/ECONOMY.md, «что носит, то и падает»). */
      salvageTo: salvageToSchema,
    trophyBase: trophyBaseSchema,
    }),
    z.object({
      kind: z.literal('armor'),
      id: z.string(),
      name: z.string(),
      faction: mgFaction,
      enabled: z.boolean().default(true),
      armorClass: z.enum(['quilted', 'leather', 'chain', 'segmented', 'plate']).default('leather'),
      /** Слот брони: тело (грудь) или шлем — оба дают defense, но занимают разные слоты монстра. */
      slot: z.enum(['chest', 'helm']).default('chest'),
      /** Базовая защита брони (до вклада STR). */
      defense: z.number().min(0).default(0),
      /** id 3D-модели (submesh-вариант атласа монстра для этого слота). Нет → базовый вид слота. */
      modelId: z.string().optional(),
      /** Что даёт при разборе — материалы ЭТОЙ вещи (docs/ECONOMY.md, «что носит, то и падает»). */
      salvageTo: salvageToSchema,
    trophyBase: trophyBaseSchema,
    }),
    z.object({
      kind: z.literal('shield'),
      id: z.string(),
      name: z.string(),
      faction: mgFaction,
      enabled: z.boolean().default(true),
      block: z.number().min(0).max(1).default(0.12),
      defense: z.number().min(0).default(0),
      /** id 3D-модели (конфиг models, kind='weapon' weaponType='shield') для меша щита монстра. Нет → процедурка. */
      modelId: z.string().optional(),
      /** Что даёт при разборе — материалы ЭТОЙ вещи (docs/ECONOMY.md, «что носит, то и падает»). */
      salvageTo: salvageToSchema,
    trophyBase: trophyBaseSchema,
    }),
  ]),
);

// ── salvage-rules ─────────────────────────────────────────────────────────────
/**
 * ИЗ ЧЕГО СДЕЛАНА ВЕЩЬ — то и получишь при разборе (docs/ECONOMY.md, Ч3).
 *
 * Правила, а не таблица на каждую из 84 баз: совпадение ищется сверху вниз, первое подошедшее
 * и работает. Пустое поле условия не проверяется вовсе, поэтому «все щиты» — это одна строка.
 * ⚠ Количество здесь — для НАГРУДНИКА и обычной редкости; слот и редкость домножают его
 * (`balance.salvage`), иначе пришлось бы держать 25 строк только на броню.
 */
export const salvageRulesSchema = z.array(
  z.object({
    id: z.string(),
    /** Выключенное правило пропускается, будто его нет. */
    enabled: z.boolean().default(true),
    name: z.string(),
    /** Условие: вид предмета. Пусто — любой. */
    kind: z.enum(['weapon', 'armor', 'shield', 'jewelry', 'consumable']).optional(),
    /** Условие: класс оружия (берётся с БАЗЫ предмета — в самом предмете его нет). */
    weaponClass: z.string().optional(),
    /** Условие: класс брони. */
    armorClass: z.string().optional(),
    /** Условие: слот экипировки. */
    slot: z.string().optional(),
    /** Что и сколько выходит. Ступень материала поднимает уровень предмета (`balance.salvage`). */
    yields: z
      .array(z.object({ materialId: z.string(), min: z.number().int().min(0), max: z.number().int().min(0) }))
      .default([]),
  }),
);

// ── craft-materials ───────────────────────────────────────────────────────────
/**
 * МАТЕРИАЛЫ КРАФТА — то, что сыплется с монстров вместо хлама (docs/ECONOMY.md).
 *
 * ⚠ Ключ `materials` в конфиге ЗАНЯТ PBR-материалами рендера, поэтому секция называется
 * `craft-materials`. Хранятся материалы КОШЕЛЬКОМ в сейве (`SaveState.materials`), а не
 * предметами в сетке: стекирования в игре нет нигде, и сетка 10×6 забилась бы за забег.
 */
export const craftMaterialsSchema = z.array(
  z.object({
    id: z.string(),
    /** Выключенный материал не падает и не участвует в рецептах. */
    enabled: z.boolean().default(true),
    name: z.string(),
    /** Семья: iron / wood / cloth / hide / plate. Внутри семьи материалы взаимозаменяемы по смыслу. */
    family: z.string(),
    /** Ступень качества 1..3. Чем глубже забег, тем выше ступень в дропе. */
    tier: z.number().int().min(1).max(3),
    /** Куда идёт: оружие и щиты, броня, или и туда и туда. */
    usedFor: z.enum(['weapon', 'armor', 'any']).default('any'),
    /** id иконки (файл в /assets, папка icons). Пусто — рисуем заглушку по семье. */
    icon: z.string().default(''),
    /**
     * Цена продажи торговцу за единицу. ⚠ Держим НИЗКОЙ намеренно: продажа материалов —
     * главный кран, которым можно случайно обесценить золото, а цель обратная —
     * золото должно оставаться дефицитным всю игру (docs/ECONOMY.md §1).
     */
    sellPrice: z.number().int().min(0).default(0),
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
    /** СКОЛЬКО требования (магнитуда, грудь; ×множитель слота) у этого класса брони. Делится долями
     *  reqStr/reqDex ниже. Влияет на авто-заполнение требований (кнопка «Заполнить по весу»). */
    reqBase: z.number().min(0).default(0),
    /** Доли требования Сила/Ловкость (лёгкая броня → ловкость, тяжёлая → сила; напр. кольчуга 0.5/0.5,
     *  сегментная 0.75/0.25). */
    reqStr: z.number().min(0).max(1).default(1),
    reqDex: z.number().min(0).max(1).default(0),
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
// Имя рарного предмета «говорящее»: ОСНОВА отражает тип урона (стихия/физика), ЭПИТЕТ — ключевое
// вторичное свойство (вампиризм/крит/защита/…). Оба выводятся из роллнутых аффиксов (см. itemgen).
/** Тема ОСНОВЫ — тип урона предмета. Основа берётся из пула этой темы (молния → «Гроза/Искра»).
 * Пустой список = нейтральная основа (когда у предмета нет урона/резиста). */
export const rareThemeSchema = z.enum(['fire', 'cold', 'lightning', 'poison', 'physical']);
/** Группа ЭПИТЕТА — категория вторичного свойства: вампиризм (leech), крит, добивание (onkill),
 * защита, жизнь, мана, сила (might), ловкость (finesse), скорость (haste), резисты (ward). */
export const rareGroupSchema = z.enum(['leech', 'crit', 'onkill', 'defense', 'life', 'mana', 'might', 'finesse', 'haste', 'ward']);
/** Основа: текст + темы урона (мультивыбор; пусто = нейтральная). */
export const rareNounSchema = z.object({
  t: z.string(),
  themes: z.array(rareThemeSchema).default([]),
});
/** Эпитет: текст + группы свойств (мультивыбор; пусто = нейтральный, фолбэк-заполнитель). */
export const rareEpithetSchema = z.object({
  t: z.string(),
  groups: z.array(rareGroupSchema).default([]),
});
/** Пулы для имён rare-предметов. Имя = база + «основа эпитет»: основа по типу урона, эпитет по
 * главному вторичному свойству («Искра жажды» = молния + вампиризм). См. rareItemName в itemgen. */
export const rareNamesSchema = z.object({
  nouns: z.array(rareNounSchema),
  epithets: z.array(rareEpithetSchema),
});

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
    /** Доли скейла урона от атрибутов (Сила / Ловкость / Интеллект). Сумма ≈ 1. Эти же доли задают,
     *  В КАКОЙ атрибут идёт требование (авто-заполнение по весу). */
    strength: z.number().min(0),
    dexterity: z.number().min(0),
    intelligence: z.number().min(0).default(0),
    /** Вклад в вес игрока (расталкивание): тяжёлое оружие — больше. */
    weight: z.number().min(0).default(10),
    /** СКОЛЬКО требования (магнитуда, 1H) у этого веса; для 2H ×`balance.twoHandReqMult`. Делится по долям
     *  str/dex/int выше. Влияет на авто-заполнение требований (кнопка «Заполнить по весу»). */
    reqBase: z.number().min(0).default(0),
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
  /** Шанс, что монстр этой роли будет МАГИЧЕСКИМ (гир-афиксы, 1–2). Редкость «около роли» (D2). */
  magicChance: z.number().min(0).max(1).default(0.12),
  /** Шанс РЕДКОГО монстра (гир-афиксы, 3–4). Проверяется до magic; остаток — обычный. */
  rareChance: z.number().min(0).max(1).default(0.03),
});
// ── monster-rarity (сколько предметов монстра «прокачано» по редкости, растёт с уровнем) ──────────
/**
 * По редкости монстра — сколько его СЛОТОВ гира становятся magic/rare (с афиксами), и как это растёт
 * с уровнем. `#предметов = clamp(minItems + ⌊(ур−1)/levelsPerItem⌋, minItems, maxItems)`, но не больше
 * числа надетых слотов. Афиксов НА предмет — по `rarities` (magic 1–2, rare 3–5). Тир афиксов = уровень монстра.
 */
export const monsterRaritySchema = z.array(
  z.object({
    id: z.enum(['magic', 'rare', 'unique']),
    name: z.string().default(''),
    /** Минимум «прокачанных» предметов (на низком уровне). */
    minItems: z.number().int().min(1).max(4).default(1),
    /** Максимум «прокачанных» предметов (на глубине). */
    maxItems: z.number().int().min(1).max(4).default(4),
    /** Каждые N уровней монстра — +1 предмет (до maxItems). */
    levelsPerItem: z.number().int().min(1).default(12),
  }),
);

// ── monster-uniques (имена уникальных монстров — как uniques.json для предметов) ──────────────────
/** Пул имён УНИКАЛЬНЫХ монстров (боссов): при редкости unique берётся имя отсюда (по фракции). */
export const monsterUniquesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean().default(true),
    faction: z.enum(['undead', 'demon', 'beast', 'monster']).default('undead'),
  }),
);

export const packsSchema = z.array(
  z.object({
    roomType: z.enum(['entrance', 'small', 'large', 'treasure', 'boss']),
    /** id этажей (из floors), на которых применима эта пачка. ПУСТО = на всех этажах.
     *  Так одну и ту же комнату (small/large) можно населять по-разному в зависимости от этажа. */
    floors: z.array(z.string()).default([]),
    /** Состав пачки по ролям («2–4 воина + 1–2 лучника»). */
    entries: z.array(packEntrySchema).default([]),
  }),
);

// ── subfactions (подфракции: визуал-тинт + тема аффиксов) ──────────────────────
/**
 * Подфракция = визуальный скин (tint) + тема аффиксов для magic/rare-монстров. Забег = одна
 * подфракция. Тема (`affixTheme`) — теги стихий (fire/cold/…): при ролле гир-аффиксов на монстре
 * этой подфракции подходящие по стихии аффиксы падают чаще. Пустая тема = без смещения (базовая).
 */
export const subfactionsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    /** Активна ли подфракция (выключенная не предлагается в забеге/редакторе-выпадашке). */
    enabled: z.boolean().default(true),
    /** Родительская фракция (группировка/фильтр выпадашки у монстра). */
    faction: z.enum(['undead', 'demon', 'beast', 'monster']).default('undead'),
    /** Оттенок скина (hex) — визуальный тинт билборда/модели монстра. */
    tint: z.string().default('#ffffff'),
    /** Тема аффиксов: теги стихий (fire/cold/lightning/poison), усиливающие подходящий гир-аффикс. */
    affixTheme: z.array(z.string()).default([]),
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
  /** Ширина коридоров в клетках (для rooms/bsp — проёмы/связки между комнатами). Пусто = 4 (просторно). */
  corridorWidth: z.number().int().min(1).max(8).optional(),
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
  /** Порог площади комнаты (w×h, клеток), с которого она считается «большой» (тип `large` → подбор large-пачек монстров). */
  largeRoomArea: z.number().int().min(4).max(2000).default(80),
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
  /** Порог площади комнаты (w×h, клеток), с которого она считается «большой» (тип `large` → подбор large-пачек монстров). */
  largeRoomArea: z.number().int().min(4).max(2000).default(80),
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
    /** Сколько комнат населить уникальными монстрами (топ-редкость). */
    uniqueRooms: z.number().int().min(0).default(0),
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
  /** Добавка к шансу нокдауна (сбить с ног) поверх базы/веса оружия. 0 = только общие источники. */
  knockdownChance: z.number().min(0).max(1).default(0),
  /** Гарантированный нокдаун этим скиллом: >0 = 100% роняет (в обход шанса/сопротивления), задаёт длительность лежания, сек. */
  knockdownSec: z.number().min(0).default(0),
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
  /** Добавка к шансу нокдауна (сбить с ног) поверх базы/веса оружия. 0 = только общие источники. */
  knockdownChance: z.number().min(0).max(1).default(0),
  /** Гарантированный нокдаун этим скиллом: >0 = 100% роняет (в обход шанса/сопротивления), задаёт длительность лежания, сек. */
  knockdownSec: z.number().min(0).default(0),
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

// ── ВСТАВКИ В АКТИВНЫЕ СКИЛЫ (модульные скилы) ──────────────────────────────────────────────
/**
 * ЗАЧЕМ. Вместо того чтобы выдумывать отдельный скил на каждую идею, игрок собирает скил сам:
 * у активного узла есть ГНЁЗДА (открываются рангом), в них ставятся ВСТАВКИ, открытые в ветках.
 * Разнообразие берётся из комбинаций, а не из нового контента.
 *
 * ТИП — ОСЬ ВЫБОРА, а не ярлык: в одном скиле не больше одной вставки каждого типа. Гнёзд три,
 * типов больше, поэтому взять всё нельзя и сборка становится решением. Гнёзда СВОБОДНЫЕ —
 * какие типы занять, решает игрок.
 *
 * Типы — ДАННЫЕ, а не enum в коде: движку от типа нужно ровно одно правило (исключение),
 * поэтому новый тип заводится в редакторе, без правки кода.
 */
export const skillInsertTypesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    /** Цвет метки в интерфейсе (гнездо/значок вставки). */
    color: z.string().default('#8fb7ff'),
    /** Порядок в списках редактора и панели скилов. */
    order: z.number().int().default(0),
    enabled: z.boolean().default(true),
  }),
);

/**
 * Куда вставка влезает. Пусто → куда угодно. Отсекает бессмыслицу («веер снарядов» в мили-удар,
 * «волна вокруг» в ауру) ДО того, как игрок потратит на это гнездо.
 */
const insertFitsSchema = z.object({
  categories: z.array(z.enum(['attack', 'cast', 'curse'])).optional(),
  shapes: z.array(z.enum(['dash', 'leap', 'nova', 'ground', 'meteor', 'boomerang'])).optional(),
  /** Только для этих классов оружия у носителя (пусто — любое). */
  weaponClasses: z.array(z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'])).optional(),
}).default({});

/**
 * ПРАВКА ПОЛЕЙ НОСИТЕЛЯ. Всё необязательное: заданное — применяется, незаданное — не трогается.
 * Множители перемножаются с полем носителя, добавки складываются, «жёсткие» значения (стихия,
 * статус) заменяют. Разделение важно: `damageMult` у скила уже есть, и вставка должна его
 * УСИЛИВАТЬ, а не затирать.
 */
const insertTuneSchema = z.object({
  damageMultMul: z.number().min(0).optional(),
  speedMul: z.number().min(0).optional(),
  arcMultMul: z.number().min(0).optional(),
  rangeMultMul: z.number().min(0).optional(),
  radiusMul: z.number().min(0).optional(),
  /** Стихия скила: задаётся вместе с конверсией/добавкой, иначе менять состав нечем. */
  element: damageTypeEnum.optional(),
  /** Абсолютные значения долей 0..1 — их складывать бессмысленно, поэтому заменяют. */
  convertPct: z.number().min(0).max(1).optional(),
  addElementPct: z.number().min(0).optional(),
  multScope: z.enum(['base', 'all']).optional(),
  /** Добавки к контролю (складываются с полем носителя). */
  knockbackAdd: z.number().optional(),
  stunSecAdd: z.number().optional(),
  knockdownChanceAdd: z.number().optional(),
  /** Охват: +снаряды/+удары/пробитие. */
  countAdd: z.number().int().optional(),
  spreadAdd: z.number().optional(),
  hitsAdd: z.number().int().optional(),
  pierce: z.boolean().optional(),
  /** Накладываемый статус — заменяет статус носителя целиком (складывать шансы нечестно). */
  ailment: ailmentApplySchema.optional(),
  /**
   * УСЛОВНАЯ НАДБАВКА — то, ради чего заведён тип «Охота». Считается НЕ в резолве, а в момент
   * удара: резолв — чистая функция без мира, а условие смотрит именно на мир («сколько рядом
   * кровоточащих»). Прибавка идёт ЗА КАЖДЫЙ засчитанный стак и упирается в `maxStacks`.
   */
  when: z.object({
    kind: z.enum(['bleedingNearby', 'burningNearby', 'lowHp']),
    radius: z.number().min(0).default(260),
    maxStacks: z.number().int().min(1).default(5),
    /** Прибавки за стак: скорость и урон — множителями (`поле *= 1 + per·стаки`). */
    speedPer: z.number().default(0),
    damagePer: z.number().default(0),
  }).optional(),
});

/**
 * ДОПОЛНИТЕЛЬНЫЙ ЭФФЕКТ при событии. Способность встроена ЦЕЛИКОМ, а не ссылкой на узел дерева:
 * иначе на каждую вставку пришлось бы заводить узел-призрак, которого нет в интерфейсе.
 *
 * `on: 'cast'` — при использовании носителя. `on: 'hit'` пока НЕ реализован: снаряды бьют позже
 * кадра запуска, и узел-источник надо протаскивать через `world.projectiles`. Поле оставлено,
 * чтобы формат не переделывать, когда дойдут руки.
 */
const insertProcSchema = z.object({
  on: z.enum(['cast', 'hit']).default('cast'),
  chance: z.number().min(0).max(1).default(1),
  ability: activeAbilitySchema,
});

/**
 * РОСТ ОТ РАНГА УЗЛА-ДОНОРА. Вставка — не тумблер «есть/нет», а прокачиваемый узел дерева:
 * вложенные в него очки усиливают прибавку. Цена растёт вместе с ней, а вот НАДБАВКА К ОТКАТУ
 * УБЫВАЕТ — на высоком ранге вставка почти не удлиняет носителя. Это и делает прокачку желанной:
 * иначе качать вставку было бы невыгодно, раз она дорожает.
 */
const insertPerRankSchema = z.object({
  /** Прибавка × (1 + gain·(ранг−1)). 0.12 — та же цифра, что у `abilityRankMult` для активок. */
  gain: z.number().min(0).default(0.12),
  /** Надбавка к стоимости × (1 + cost·(ранг−1)). */
  cost: z.number().min(0).default(0.06),
  /** Надбавка к откату × (1 − cooldownDecay·(ранг−1)), не ниже нуля. */
  cooldownDecay: z.number().min(0).max(1).default(0.10),
}).default({});

export const skillInsertsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    /** id из `skill-insert-types`. Одна вставка каждого типа на скил. */
    type: z.string(),
    fits: insertFitsSchema,
    perRank: insertPerRankSchema,
    /**
     * ЦЕНА СБОРКИ. Множители перемножаются по всем вставкам скила: три вставки ≈ ×2.2 к стоимости.
     * Без этого «ставь всё» было бы единственной стратегией — голый скил обязан оставаться
     * дешёвым и спамным, а собранный бить реже и дороже.
     */
    costMult: z.number().min(0.1).default(1.3),
    cooldownMult: z.number().min(0.1).default(1.15),
    tune: insertTuneSchema.optional(),
    proc: insertProcSchema.optional(),
    enabled: z.boolean().default(true),
  }),
);

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
  /**
   * Узел ОТКРЫВАЕТ вставку (id из `skill-inserts`). Ранг узла = сила вставки — так ранги
   * перестают быть только цифрами урона. Проверка «открыта ли вставка» идёт по этому полю,
   * поэтому чужую вставку в гнездо не положить.
   */
  grantsInsert: z.string().optional(),
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

// ── 3D-АССЕТЫ (текстуры/материалы/модели) — импорт в поз-редакторе; бинари GLB/PNG на диске /assets по url ──
const rgb = z.tuple([z.number(), z.number(), z.number()]);
const rgba = z.tuple([z.number(), z.number(), z.number(), z.number()]);
/** Текстура = картинка (/assets/<id>.png) + НАСТРОЙКИ ИМПОРТА, один-в-один как в Unity. Переиспользуется материалами.
 *  КАНОН — Unity: `type` заменяет угадывание «это нормалмап» по имени файла (галка Texture Type), `sRGB` — цветовое
 *  пространство (albedo/emission — true; normal/mask — false). Веб переводит это в three.js, Unity берёт как есть. */
export const texturesSchema = z.array(z.object({
  id: z.string(),
  name: z.string().default(''),
  url: z.string(),                                       // /assets/<id>.png|jpg (сервер /assets)
  type: z.enum(['default', 'normalMap']).default('default'),          // Unity Texture Type: обычная / нормалмап
  sRGB: z.boolean().default(true),                                    // Unity «sRGB (Color Texture)»; данные (normal/mask) — false
  flipGreenChannel: z.boolean().default(false),                       // Unity «Flip Green Channel» (только type='normalMap'): DirectX/3ds Max (−Y) → OpenGL (+Y)
  wrapMode: z.enum(['repeat', 'clamp']).default('repeat'),
  filterMode: z.enum(['point', 'bilinear', 'trilinear']).default('bilinear'),
  aniso: z.number().int().min(0).max(16).default(1),                  // анизотропия (косые углы: пол/стены)
  mipmaps: z.boolean().default(true),
  compression: z.enum(['none', 'normal', 'high']).default('normal'),  // подсказка Editor-бейкеру Unity (BC7/BC5)
}));
/** Материал = инспектор URP Lit 1:1 (КАНОН — Unity; веб переводит это в three.js, Unity ставит на сток URP/Lit).
 *  МАСКА (`maskMap`) — раскладка URP: **R = metallic, G = AO, B = —, A = smoothness**.
 *  ⚠ Если AO не рисуется — канал G должен быть БЕЛЫМ (URP читает окклюзию из G; чёрный G = всё чёрное).
 *  ⚠ Альфа обязана быть в файле (PNG-32/TGA): «Alpha From Grayscale» даёт A = яркость(RGB), т.е. smoothness=metallic. */
export const materialsSchema = z.array(z.object({
  id: z.string(),
  name: z.string().default(''),
  // ── Surface Options ──
  surface: z.enum(['opaque', 'transparent']).default('opaque'),
  blend: z.enum(['alpha', 'premultiply', 'additive', 'multiply']).default('alpha'),   // только при surface='transparent'
  alphaClip: z.boolean().default(false),                              // alpha-cutout (glTF MASK)
  cutoff: z.number().min(0).max(1).default(0.5),
  cull: z.enum(['back', 'front', 'off']).default('back'),             // 'off' = двусторонний
  // ── Surface Inputs ──
  baseMap: z.string().optional(),                                     // textureId (albedo), sRGB
  baseColor: rgba.default([1, 1, 1, 1]),                              // множитель baseMap; A = прозрачность
  maskMap: z.string().optional(),                                     // textureId: R=metallic, G=AO, A=smoothness
  metallic: z.number().min(0).max(1).default(0),                      // скаляр; при maskMap металл берётся из R карты
  smoothness: z.number().min(0).max(1).default(0.5),                  // скаляр; при maskMap — МНОЖИТЕЛЬ канала A
  occlusionMap: z.string().optional(),                                // обычно = maskMap (URP читает канал G)
  occlusionStrength: z.number().min(0).max(1).default(1),
  bumpMap: z.string().optional(),                                     // нормалмап (textures[].type='normalMap')
  bumpScale: z.number().default(1),
  emissionMap: z.string().optional(),
  emissionColor: rgb.default([0, 0, 0]),
  emissionIntensity: z.number().min(0).default(1),                    // итог: _EmissionColor = emissionColor × intensity
  // ── UV (URP: ОДНА трансформация _BaseMap_ST на ВСЕ карты) ──
  tiling: z.tuple([z.number(), z.number()]).default([1, 1]),
  offset: z.tuple([z.number(), z.number()]).default([0, 0]),
}));
/** 3D-модель: `character` = ОДИН GLB-атлас персонажа (скелет + все сабмеши-части, тумблер по слоту),
 *  `part` = отдельный меш слота (легаси), `weapon` = оружие. GLB на /assets + карта ретаргета + материалы. */
export const modelsSchema = z.array(z.object({
  id: z.string(),
  name: z.string().default(''),
  url: z.string(),                                      // /assets/<id>.glb
  // ЯВНАЯ категория (задаётся при загрузке) — организация в редакторе: группа дерева, набор полей формы, подпапка
  //   аплоада. Отделяет тайл пола от персонажа, чтобы у тайла не было персонажных полей. Легаси без category —
  //   категория угадывается по kind/objectRef. character/monster → атлас (kind='character'); tile/decor → kind='part'
  //   (материал из «Объекта»); weapon → kind='weapon'.
  category: z.enum(['character', 'monster', 'tile', 'decor', 'weapon', 'misc']).optional(),
  kind: z.enum(['character', 'part', 'weapon']).default('part'),
  slot: z.enum(['helm', 'chest', 'gloves', 'boots', 'head']).optional(),   // kind='part': область тела
  weaponType: z.enum(['sword', 'axe', 'mace', 'dagger', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff', 'shield']).optional(),   // kind='weapon'
  // kind='character': КЛЮЧ АТЛАСА — за какой персонаж этот атлас. Для игрока = id класса; для монстра = семья
  //   (subfaction||faction, напр. 'undead'/'zombie'): «один FBX на всех зомби». У каждого свой атлас со своими
  //   submesh-вариантами (броня/причёска per-персонажны). Пусто = глобальный фолбэк (только для игрока; монстр без
  //   атласа = процедурка). Оружие (kind='weapon') ОБЩЕЕ на всех — classId не задаётся.
  classId: z.string().optional(),
  slots: z.record(z.string(), z.string()).default({}),  // kind='character': имя сабмеша → слот (helm/head/chest/gloves/boots; '' = скрыт). Авто-классификация при импорте, правится.
  // kind='character': БАЗОВЫЙ вид ПУСТЫХ слотов этого атласа (submesh-вариант по умолчанию, когда ничего не надето) —
  //   аналог classes.baseAppearance, но НА АТЛАСЕ. Для МОНСТРА: атлас семьи несёт свой дефолт-вид (клиент берёт по atlasKey).
  //   hair→helm(причёска без шлема)/head→head/hands→gloves/body→chest/feet→boots. Пусто → показать все submesh слота.
  baseAppearance: z.object({ hair: z.string().optional(), head: z.string().optional(), hands: z.string().optional(), body: z.string().optional(), feet: z.string().optional() }).optional(),
  // kind='character': модульные пропорции тела (слайдеры конструктора). Игра строит solid/target с ним, атлас конформится.
  body: z.object({ height: z.number(), arm: z.number(), leg: z.number(), torso: z.number(), girth: z.number() }).partial().optional(),
  // kind='character': пер-костные множители длины, снятые с ФБХ (measureBoneScales) → наш физ-скелет 1:1 повторяет модель.
  boneScale: z.record(z.string(), z.number()).optional(),
  // kind='character': ПОЛНЫЕ rest-офсеты костей ФБХ (вектор [x,y,z]) — приоритет над boneScale, повторяет геометрию 1:1
  // (направление+длина; чинит «раскоряку» ног, где скаляр искажал узкий-вниз хип ФБХ в широкий).
  boneOffsets: z.record(z.string(), z.array(z.number())).optional(),
  base: z.boolean().default(false),                     // базовый меш слота (нет надетого / нет modelId → показываем его)
  hideHair: z.boolean().default(false),                 // шлем скрывает базовые волосы (корона/тиара — false)
  scale: z.number().default(1),                         // нормализация размера (наш TILE=32u=1м)
  boneMap: z.record(z.string(), z.string()).default({}),   // наша кость → имя кости импорт-скелета (ретаргет)
  grip: z.object({ pos: rgb.default([0, 0, 0]), rot: rgb.default([0, 0, 0]) }).optional(),   // хват оружия на кисти
  submeshMaterials: z.record(z.string(), z.string()).default({}),   // имя сабмеша → materialId
  // decor/tile: коллайдер, ИЗВЛЕЧЁННЫЙ из невидимого меша `collider*` GLB (в ДОЛЯХ тайла, 100 ед=1 тайл) — источник
  //   для objects.collider (Ф3). Круг: r; бокс: полные w×h. Пусто → у меша нет collider* (объект задаёт коллайдер вручную).
  collider: z.object({ shape: z.enum(['circle', 'box']), r: z.number().optional(), w: z.number().optional(), h: z.number().optional() }).optional(),
}));

/** ОКРУЖЕНИЕ подземелья — per-biome НАСТРОЙКИ рендера (фейд стен-окклюдеров). Сами меши пола/стен задаются секцией
 *  `objects` (role floor/wall + biomes). Клиент по `FloorInit.biomeId` берёт enabled-запись → параметры фейда; нет
 *  записи → дефолты фейда. Тюнится во вкладке «Мир → Окружение (фейд)». */
export const environmentSchema = z.array(z.object({
  id: z.string(),
  name: z.string().default(''),
  biomeId: z.string(),                                  // к какому биому применяется (см. biomes[].id)
  enabled: z.boolean().default(true),
  fade: z.object({
    start: z.number().default(190),                     // радиус у игрока, где стены начинают таять
    end: z.number().default(460),                       // радиус, где снова целые
    kneeLow: z.number().default(20),                    // ниже (по колено) НЕ фейдим
    kneeHigh: z.number().default(46),                   // выше — полный фейд верха
    faceYaw: z.number().default(0),                     // доп. разворот GLB-стены (рад) — выставить лицо в комнату
  }).default({}),
}));

/** ОБЪЕКТЫ мира — библиотека размещаемых сущностей (пол/стена/колонна/декор). Каждый = роль + GLB-модель (из `models`,
 *  может содержать варианты-меши) + опц. материал-override (из `materials`) + к каким биомам относится (мультиселект).
 *  Клиент строит этаж: floor-объекты биома → тайлы пола (варианты мёржатся), wall-объекты → стены. pillar/decor — задел
 *  под размещение (колонны на углах и т.п.). Материал '' = из GLB. Пусто для биома → процедурные боксы (фолбэк). */
export const objectsSchema = z.array(z.object({
  id: z.string(),
  name: z.string().default(''),
  enabled: z.boolean().default(true),
  //   floor = тайл пола (1×1 тайлится по всем клеткам cellHash; footprint>1 = сервер расставляет «россыпью» ВМЕСТО базовых
  //   тайлов с частотой spawnChance). wall = тайл стены. pillar = стеновая колонна (клиент, без коллизии). prop = кладётся
  //   ПОВЕРХ готового пола/стены (см. surface), сервер расставляет. decor = отложено (отдельная история).
  role: z.enum(['floor', 'wall', 'pillar', 'decor', 'prop']).default('decor'),
  surface: z.enum(['floor', 'wall']).default('floor'),   // prop: на пол или на стену ставится
  modelId: z.string().default(''),                      // id модели из секции models (GLB)
  materialId: z.string().default(''),                   // '' = материал из GLB; иначе materials[id] (override, общий инстанс)
  biomes: z.array(z.string()).default([]),              // к каким биомам относится (biomes[].id; мультиселект)
  // ── Напольный декор (role decor/prop): расстановка + коллизия сервером ──
  blocks: z.boolean().default(false),                   // блокирует ли проход (суб-тайл-препятствие из коллайдера)
  blocksSight: z.boolean().default(false),              // перекрывает ли обзор монстров (LoS) — высокий декор прячет цель
  // Коллайдер препятствия в ДОЛЯХ тайла (круг r / бокс w×h). Пусто → берётся из меша collider* модели (Ф3),
  //   иначе дефолт-круг. Форму (круг/бокс) задаёт объект: круглый очаг → circle, длинный сундук → box.
  collider: z.object({ shape: z.enum(['circle', 'box']).default('circle'), r: z.number().optional(), w: z.number().optional(), h: z.number().optional() }).optional(),
  footprint: z.object({ w: z.number().int().min(1).max(8).default(1), h: z.number().int().min(1).max(8).default(1) }).default({}),   // занимаемые клетки (мульти-тайл), дефолт 1×1
  spawnChance: z.number().min(0).max(1).default(0.35),   // частота спавна: шанс поставить объект в клетку-кандидат (0=никогда, 1=часто)
  // Источник(и) света из меша(ей) light* модели (Ф4): параметры PointLight, ставится в позицию маркера.
  light: z.object({ color: z.string().default('#ffa860'), intensity: z.number().default(1500), distance: z.number().default(380), flicker: z.boolean().default(true) }).optional(),
}));

/** Реестр всех схем: ключ конфига → схема. */
export const configSchemas = {
  balance: balanceSchema,
  classes: classesSchema,
  'items.base': itemsBaseSchema,
  affixes: affixesSchema,
  uniques: uniquesSchema,
  monsters: monstersSchema,
  'monster-affixes': monsterAffixesSchema,
  /** Аффиксы ШМОТА монстров (item-движок, таргетинг по типу гира). Отдельный пул от плеерского `affixes` —
   *  чтобы тюнить редкость монстров независимо от лута. Та же схема, что у предметов игрока. */
  'monster-item-affixes': affixesSchema,
  'monster-behaviors': monsterBehaviorsSchema,
  'monster-gear': monsterGearSchema,
  'depth-tiers': depthTiersSchema,
  'monster-derive': monsterDeriveSchema,
  'monster-roles': monsterRolesSchema,
  subfactions: subfactionsSchema,
  'monster-rarity': monsterRaritySchema,
  'monster-uniques': monsterUniquesSchema,
  packs: packsSchema,
  difficulties: difficultiesSchema,
  biomes: biomesSchema,
  floors: floorsSchema,
  'run-modifiers': runModifiersSchema,
  'run-templates': runTemplatesSchema,
  'item-tiers': itemTiersSchema,
  'craft-materials': craftMaterialsSchema,
  'salvage-rules': salvageRulesSchema,
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
  'skill-insert-types': skillInsertTypesSchema,
  'skill-inserts': skillInsertsSchema,
  'quests.main': questsMainSchema,
  'quests.random': questsRandomSchema,
  'room-prefabs': roomPrefabsSchema,
  textures: texturesSchema,
  materials: materialsSchema,
  models: modelsSchema,
  environment: environmentSchema,
  objects: objectsSchema,
} as const;

export type ConfigKey = keyof typeof configSchemas;

export type ConfigShapes = {
  [K in ConfigKey]: z.infer<(typeof configSchemas)[K]>;
};
