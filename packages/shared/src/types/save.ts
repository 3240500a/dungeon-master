import type { Attributes } from './attributes.js';
import type { Item, EquipSlot } from './items.js';
import type { QuestProgress, QuestDef } from './quest.js';
import type { RunState } from '../dungeon/run/types.js';

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
  /**
   * ⭐ R8-10: ПОКОМПОНЕНТНЫЙ МАКСИМУМ АТРИБУТОВ, С КОТОРЫХ ГЕРОЙ СБРАСЫВАЛ ОЧКИ (`respec`). Мощь (`effectiveLevel`) берёт
   * вещь запаса, только если требования закрыты — и сверяет их не ниже этого: иначе «снял, сбросил, вложил мимо — спустился —
   * сбросил и надел» заселял узел слабее за два сброса. Пишет только `respec`. Необязательное: нет поля — сброса не было.
   */
  respecPeak?: Attributes;
  unspentAttributePoints: number;
  unspentSkillPoints: number;
  /** Нераспределённые очки пассивных навыков (пассивы тратят их + золото). */
  unspentMasteryPoints: number;
  skills: SkillAllocation;
  /**
   * ВСТАВКИ В ГНЁЗДАХ активных скилов: id узла → вставки по гнёздам (`null` — гнездо пусто).
   * Необязательное намеренно: старые сейвы читаются как есть, без миграции — нет поля значит
   * «гнёзда пусты», а пустые гнёзда обязаны давать ровно прежнюю способность (`session/inserts.ts`).
   */
  sockets?: Record<string, (string | null)[]>;
  /**
   * КОШЕЛЁК МАТЕРИАЛОВ КРАФТА: id материала → количество. Сетку инвентаря НЕ занимает —
   * стекирования в игре нет нигде, и материалы забили бы 10×6 за один забег.
   * Необязательное по той же причине, что и `sockets`: старый сейв читается как есть,
   * отсутствие поля значит «кошелёк пуст». Работа с ним — `economy/materials.ts`.
   */
  materials?: Record<string, number>;
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
  /**
   * ⚠ R5-20: поколение доски (мс, часы сервера) последнего УБРАННОГО из журнала задания каждого шаблона: шаблон → время.
   * Сданное с доски уходит из `quests`/`activeQuestDefs` (иначе журнал рос без конца), а квота R3-10/R4-33 «одно задание
   * шаблона за срок доски» смотрит и сюда. Необязательное: нет поля — ничего не убиралось (`economy/questLogic.ts`).
   */
  boardQuota?: Record<string, number>;
  /**
   * ⭐ R5-22: ОПОЗНАНИЕ СТОКА КУЗНИЦЫ героя (R1-03) — чтобы любая нода и новый процесс собрали тот же прилавок. Пишет и
   * читает только сервер (`net/room.ts`, `restock`). Необязательное: нет поля (старый сейв) — сток катается заново.
   */
  townStock?: TownStockRef;
  /**
   * ⭐ R11-04: здоровье, мана и выносливость героя на момент последней записи (`at` — когда, часы сервера, мс). Пишет и читает только
   * сервер (`net/room.ts`): вход в новую комнату (выход из города и «Продолжить», другая нода, рестарт) берёт их отсюда — с регеном за
   * время вне игры, — а не заводит полное тело. Необязательное: нет поля (старый сейв, погиб) — полные пулы.
   */
  vitals?: { hp: number; mana: number; stamina: number; at?: number };
  /** Максимально достигнутая глубина (для статистики; текущая не сохраняется). */
  maxDepth: number;
  /** Глубже всего пройденный этаж по каждому тиру сложности (id → этаж) — для разблокировки. */
  difficultyProgress: Record<string, number>;
  /** Последняя выбранная сложность (id тира). */
  lastDifficulty: string;
  /** Активный забег v2 (структура/позиция). Отсутствует — забега нет (город/легаси-сейв). */
  run?: RunState;
}

/**
 * ⭐ R5-22: сток кузницы в сейве. `at` — когда катали (он же поколение доски, R4-33), `seed` — сид броска снаряжения,
 * `level` — уровень героя, под который катали (R3-17), `bought` — номера купленных вещей в списке броска.
 * ⭐ R9-13: `board` — сид доски квестов поколения. Нет — доска из `seed`; пишется, когда `seed` перекатывается по уровню
 * (R3-17): снаряжение новое, а доска и срок — прежние.
 */
export interface TownStockRef { at: number; seed: number; level: number; bought: number[]; board?: number }

export const SAVE_VERSION = 3;
