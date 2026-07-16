import type { Attributes } from './attributes.js';
import type { Item, EquipSlot } from './items.js';
import type { QuestProgress, QuestDef } from './quest.js';

/** Прогресс скиллов: id узла → вложенный ранг. */
export type SkillAllocation = Record<string, number>;

/** Всё, что сохраняется между сессиями. */
export interface SaveState {
  version: number;
  /** Имя персонажа (задаётся при создании). */
  name: string;
  /** Уникальный id персонажа — ключ независимого серверного синка. */
  charId: string;
  /** Время создания (мс). */
  createdAt: number;
  classId: string;
  level: number;
  xp: number;
  gold: number;
  attributes: Attributes;
  unspentAttributePoints: number;
  unspentSkillPoints: number;
  /** Нераспределённые очки пассивных навыков (пассивы тратят их + золото). */
  unspentMasteryPoints: number;
  skills: SkillAllocation;
  masteries: SkillAllocation;
  /** Экипировка по слотам. */
  equipment: Partial<Record<EquipSlot, Item>>;
  inventory: Item[];
  stash: Item[];
  /** Быстрые слоты пояса (D2): расходники по клавишам 1-4. Длина = beltSlots пояса. */
  belt: (Item | null)[];
  /**
   * Бинды действий (D2-стиль). Значение: nodeId скилла, `'attack'` (базовая атака)
   * или null (пусто). `hotbar` — 3 доп. слота (клавиши Shift/Space/Alt).
   */
  mouseLeft: string | null;
  mouseRight: string | null;
  hotbar: (string | null)[];
  quests: QuestProgress[];
  /** Резолвнутые определения принятых квестов (main из конфига + сгенерированные). */
  activeQuestDefs: QuestDef[];
  /** Максимально достигнутая глубина (для статистики; текущая не сохраняется). */
  maxDepth: number;
  /** Глубже всего пройденный этаж по каждому тиру сложности (id → этаж) — для разблокировки. */
  difficultyProgress: Record<string, number>;
  /** Последняя выбранная сложность (id тира). */
  lastDifficulty: string;
}

export const SAVE_VERSION = 2;
