import {
  type SaveState,
  type Attributes,
  type DerivedStats,
  type Item,
  type StatModifier,
  type HpManaScaling,
  deriveStats,
  finalAttributes,
  modifiersFromItems,
  armorClassModifiers,
  newDebuffState,
  DEFAULT_HP_MANA_SCALING,
  type DebuffState,
} from '@dm/shared';

/**
 * Единое состояние игры: то, что сохраняется (`save`), плюс runtime-поля
 * (текущая глубина, кэш производных статов, текущее HP/mana). Модули читают и
 * меняют его через ctx.state, значимые изменения сопровождают событиями на шине.
 */
export class GameState {
  save: SaveState;
  /** Текущая глубина активного подземелья (не сохраняется). */
  depth = 0;
  /** Сид текущего забега (не сохраняется); задаётся при входе из города. */
  seed = 1;
  /** Сложность текущего забега (id тира; не сохраняется). Ставится при входе из города. */
  difficultyId = 'normal';
  hp = 1;
  mana = 1;
  /** Выносливость — ресурс боевых активок (авторитетно из снапшота). */
  stamina = 1;
  /** Активные дебаффы на игроке (runtime; сбрасываются при входе в город). */
  debuffs: DebuffState = newDebuffState();
  /** Активные тоглы (ауры/стойки) — id узлов; авторитетно приходят с сервера в снапшоте. */
  toggles: string[] = [];
  /** Временные баффы от расходников (не сохраняются): моды + остаток сек. */
  potionBuffs: { mods: StatModifier[]; remaining: number }[] = [];
  /**
   * Поставщики модификаторов от деревьев скиллов. Инъектируются в App при
   * присвоении state (модули skills-*), чтобы GameState не зависел от config.
   */
  passiveModsProvider: () => StatModifier[] = () => [];
  activeModsProvider: () => StatModifier[] = () => [];
  /** Стат-моды активных тоглов (ауры/стойки) — из текущих `toggles` и конфига (инъектирует App). */
  toggleModsProvider: () => StatModifier[] = () => [];
  /** Доля зарезервированной аурами маны (0..0.9) — из `toggles` и конфига (инъектирует App). */
  reservedManaFracProvider: () => number = () => 0;
  /** Доля зарезервированной стойками выносливости (0..0.9) — из `toggles` и конфига (инъектирует App). */
  reservedStaminaFracProvider: () => number = () => 0;
  /** Справочник классов брони (data-driven) — инъектируется App, чтобы GameState не зависел от config. */
  armorClassesProvider: () => Parameters<typeof armorClassModifiers>[1] = () => [];
  /** Масштаб пулов HP/маны текущего класса (data-driven) — инъектируется App. */
  derivedScalingProvider: () => HpManaScaling = () => DEFAULT_HP_MANA_SCALING;

  constructor(save: SaveState) {
    this.save = save;
  }

  /** Все надетые предметы списком. */
  equippedItems(): Item[] {
    return Object.values(this.save.equipment).filter(Boolean) as Item[];
  }

  /** Все модификаторы: экипировка + класс брони (штрафы) + пассивки + мастерства + зелья. */
  allModifiers(): StatModifier[] {
    const equipped = this.equippedItems();
    const mods = modifiersFromItems(equipped);
    mods.push(...armorClassModifiers(equipped, this.armorClassesProvider()));
    mods.push(...this.passiveModsProvider());
    mods.push(...this.activeModsProvider());
    mods.push(...this.toggleModsProvider()); // ауры/стойки — активные бонусы отражаются в статах
    for (const b of this.potionBuffs) mods.push(...b.mods);
    return mods;
  }

  /** Эффективный максимум маны: пул минус зарезервированная аурами доля. */
  effectiveMaxMana(): number {
    return this.derived().maxMana * (1 - this.reservedManaFracProvider());
  }
  /** Эффективный максимум выносливости: пул минус зарезервированная стойками доля. */
  effectiveMaxStamina(): number {
    return this.derived().maxStamina * (1 - this.reservedStaminaFracProvider());
  }

  /** Тик временных бафф-зелий: убавляет остаток, снимает истёкшие. */
  tickPotionBuffs(dt: number): void {
    if (this.potionBuffs.length === 0) return;
    for (const b of this.potionBuffs) b.remaining -= dt;
    this.potionBuffs = this.potionBuffs.filter((b) => b.remaining > 0);
  }

  /** Пересчитывает производные характеристики от атрибутов + экипировки + скиллов. */
  derived(): DerivedStats {
    return deriveStats(this.save.attributes, this.allModifiers(), this.derivedScalingProvider(), this.save.level);
  }

  /** Итоговые атрибуты с учётом всех бонусов (для расчёта урона оружия). */
  effectiveAttributes(): Attributes {
    return finalAttributes(this.save.attributes, this.allModifiers());
  }

  /**
   * «Своя» часть атрибутов — база + пассивы + мастерства (всё, что прибавилось
   * НАВСЕГДА). Это то, что останется, если снять всю экипировку; разница с
   * `effectiveAttributes()` — вклад гира.
   */
  permanentAttributes(): Attributes {
    return finalAttributes(this.save.attributes, [...this.passiveModsProvider(), ...this.activeModsProvider()]);
  }

  /** Обновляет рекорд глубины по текущей. */
  maxDepthTouch(): void {
    this.save.maxDepth = Math.max(this.save.maxDepth, this.depth);
  }

  /** Восстанавливает HP/mana до максимума (при входе в город/новой игре). Мана — до эфф. максимума (учёт резерва). */
  restoreFull(): void {
    this.hp = this.derived().maxHp;
    this.mana = this.effectiveMaxMana();
    this.stamina = this.effectiveMaxStamina();
    this.debuffs = newDebuffState();
  }

}
