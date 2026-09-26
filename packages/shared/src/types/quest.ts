import type { Item } from './items.js';

export type ObjectiveType =
  | 'kill'
  | 'reach-floor'
  | 'collect-item'
  | 'talk-npc';

export interface QuestObjective {
  id: string;
  type: ObjectiveType;
  /** Целевой id: id монстра / id базы предмета / id npc. Пусто для reach-floor. */
  target?: string;
  /** Требуемое количество / номер этажа. */
  amount: number;
}

export interface QuestReward {
  gold?: number;
  xp?: number;
  skillPoints?: number;
  itemBaseId?: string;
}

/** Определение квеста (основного или сгенерированного из шаблона). */
export interface QuestDef {
  id: string;
  name: string;
  description: string;
  objectives: QuestObjective[];
  reward: QuestReward;
  /** Для цепочек: id следующего квеста. */
  next?: string;
}

/** Шаблон случайного квеста. */
export interface RandomQuestTemplate {
  id: string;
  objectiveType: ObjectiveType;
  amountRange: [number, number];
  /** Пул целей (id монстров/предметов), из которого выбирается target. */
  targetPool: string[];
  rewardGoldRange: [number, number];
  rewardXpRange: [number, number];
  rewardItemPool?: string[];
}

/** Runtime-состояние прогресса квеста. */
export interface QuestProgress {
  questId: string;
  status: 'active' | 'completed' | 'turned-in';
  counters: Record<string, number>;
  /**
   * Когда квест С ДОСКИ принят (мс, часы сервера) — R3-10: квота «одно задание шаблона за срок доски» считается по
   * нему. Нет поля — квест цепочки или принят до правки: в квоту не идёт.
   */
  acceptedAt?: number;
  /**
   * Когда катали доску, с которой квест принят (мс, часы сервера) — R4-33: квота меряется между поколениями досок,
   * а не от принятия. Нет поля — квест цепочки или принят до правки: за поколение берётся `acceptedAt`.
   */
  boardAt?: number;
}

export interface GeneratedQuest extends QuestDef {
  fromTemplate: string;
  rewardItem?: Item;
}
