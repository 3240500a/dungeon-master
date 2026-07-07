import type Phaser from 'phaser';
import type { EventBus, ConfigRegistry } from '@dm/shared';
import type { GameState } from './gameState.js';

/**
 * Контракт модуля. Каждая фича в src/modules/<name> экспортирует объект,
 * реализующий GameModule. Модуль общается наружу ТОЛЬКО через ctx (шина +
 * конфиг + состояние) — прямые импорты между модулями запрещены.
 */
export interface ModuleContext {
  bus: EventBus;
  config: ConfigRegistry;
  state: GameState;
  /** Текущая активная игровая сцена (Town/Dungeon), если модуль клиентский. */
  scene?: Phaser.Scene;
}

export interface GameModule {
  readonly name: string;
  init(ctx: ModuleContext): void;
  /** Вызывается при смене сцены/выгрузке — снять подписки, удалить объекты. */
  destroy?(): void;
}

/** Простой реестр модулей: регистрирует и инициализирует с общим ctx. */
export class ModuleRegistry {
  private modules = new Map<string, GameModule>();

  register(module: GameModule): void {
    if (this.modules.has(module.name)) {
      throw new Error(`Модуль "${module.name}" уже зарегистрирован.`);
    }
    this.modules.set(module.name, module);
  }

  initAll(ctx: ModuleContext): void {
    for (const module of this.modules.values()) module.init(ctx);
  }

  destroyAll(): void {
    for (const module of this.modules.values()) module.destroy?.();
  }

  get(name: string): GameModule | undefined {
    return this.modules.get(name);
  }
}
