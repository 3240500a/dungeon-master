import type { Item } from '../types/items.js';

/**
 * Карта событий: имя → тип payload. Единственный источник истины по контрактам
 * межмодульного общения. При добавлении события впиши строку и обнови docs/ARCHITECTURE.md.
 */
export interface GameEvents {
  'monster:died': {
    monsterId: string;
    x: number;
    y: number;
    level: number;
    xp: number;
  };
  'item:dropped': { item: Item; x: number; y: number };
  'item:picked': { item: Item };
  'player:levelup': {
    level: number;
    attributePoints: number;
    skillPoints: number;
  };
  'player:damaged': { current: number; max: number };
  'player:died': { depth: number };
  'config:reloaded': { keys: string[] };
  'gold:changed': { gold: number };
  /** Запрос открыть модальную DOM-панель (инвентарь/скиллы/магазин/…). */
  'ui:open': { panel: string };
  /** Состояние персонажа изменилось — панелям пора перерисоваться. */
  'state:changed': Record<string, never>;
  /** Системное сообщение в игровой лог/чат (урон/убийство/опыт/лут). */
  'log:message': { text: string; kind: LogKind };
}

/** Тип строки лога (для цвета). */
export type LogKind = 'dmg-out' | 'dmg-in' | 'kill' | 'xp' | 'gold' | 'loot' | 'system';

export type GameEventName = keyof GameEvents;
export type EventHandler<K extends GameEventName> = (payload: GameEvents[K]) => void;

/** Минималистичная типобезопасная шина событий (без внешних зависимостей). */
export class EventBus {
  private handlers = new Map<GameEventName, Set<(payload: unknown) => void>>();

  on<K extends GameEventName>(name: K, handler: EventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(name, handler);
  }

  off<K extends GameEventName>(name: K, handler: EventHandler<K>): void {
    this.handlers.get(name)?.delete(handler as (payload: unknown) => void);
  }

  emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of [...set]) handler(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
