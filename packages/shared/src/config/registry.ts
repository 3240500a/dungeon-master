import { configSchemas, type ConfigKey, type ConfigShapes } from './schemas.js';
import { defaultConfigData } from './defaults.js';
import type { EventBus } from '../events/index.js';

/**
 * Единая точка доступа ко всем конфигам игры. Валидирует данные zod-схемами.
 * Игра и HTML-редактор используют один и тот же реестр/схемы.
 */
export class ConfigRegistry {
  private data = {} as ConfigShapes;
  private bus?: EventBus;

  constructor(bus?: EventBus) {
    this.bus = bus;
  }

  /** Загружает и валидирует все конфиги из сырых данных (по умолчанию — встроенные). */
  loadAll(raw: Record<string, unknown> = defaultConfigData): void {
    const store = this.data as Record<string, unknown>;
    for (const key of Object.keys(configSchemas) as ConfigKey[]) {
      store[key] = this.parse(key, raw[key]);
    }
  }

  private parse<K extends ConfigKey>(key: K, value: unknown): ConfigShapes[K] {
    const result = configSchemas[key].safeParse(value);
    if (!result.success) {
      throw new Error(
        `Конфиг "${key}" не прошёл валидацию:\n${result.error.toString()}`,
      );
    }
    return result.data as ConfigShapes[K];
  }

  get<K extends ConfigKey>(key: K): ConfigShapes[K] {
    const value = this.data[key];
    if (value === undefined) {
      throw new Error(`Конфиг "${key}" не загружен. Вызовите loadAll() сначала.`);
    }
    return value;
  }

  /** Частичное обновление (для live-apply из редактора). Эмитит config:reloaded. */
  reload(partial: Partial<Record<ConfigKey, unknown>>): void {
    const store = this.data as Record<string, unknown>;
    const keys: string[] = [];
    for (const key of Object.keys(partial) as ConfigKey[]) {
      store[key] = this.parse(key, partial[key]);
      keys.push(key);
    }
    this.bus?.emit('config:reloaded', { keys });
  }

  /** Возвращает сырые данные (для экспорта из редактора). */
  snapshot(): ConfigShapes {
    return structuredClone(this.data);
  }
}
