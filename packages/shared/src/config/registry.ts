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

  /** Загружает и валидирует все конфиги из сырых данных (по умолчанию — встроенные). Негодное — прежнее цело (R7-14). */
  loadAll(raw: Record<string, unknown> = defaultConfigData): void {
    const staged: Record<string, unknown> = {};
    for (const key of Object.keys(configSchemas) as ConfigKey[]) {
      staged[key] = this.parse(key, raw[key]);
    }
    Object.assign(this.data, staged);
  }

  private parse<K extends ConfigKey>(key: K, value: unknown): ConfigShapes[K] {
    const schema = configSchemas[key];
    if (!schema) throw new Error(`Неизвестный конфиг "${key}" — такой таблицы в схеме нет`);
    const result = schema.safeParse(value);
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

  /**
   * Частичное обновление (для live-apply из редактора). Эмитит config:reloaded.
   *
   * ⭐ R7-14: ВСЁ ИЛИ НИЧЕГО. Таблицы сперва разбираются в сторонке и кладутся, только если годны ВСЕ: раньше они клались по
   * одной, и первая негодная (неизвестная таблица, переименованное поле — деплой со сменой схемы при старой вкладке)
   * бросала, когда таблицы до неё уже стояли новые, — реестр оставался смесью двух конфигов. Ошибка — та же, с именем таблицы.
   */
  reload(partial: Partial<Record<ConfigKey, unknown>>): void {
    const staged: [ConfigKey, unknown][] = [];
    for (const key of Object.keys(partial) as ConfigKey[]) staged.push([key, this.parse(key, partial[key])]);
    const store = this.data as Record<string, unknown>;
    for (const [key, value] of staged) store[key] = value;
    this.bus?.emit('config:reloaded', { keys: staged.map(([key]) => key) });
  }

  /** Возвращает сырые данные (для экспорта из редактора). */
  snapshot(): ConfigShapes {
    return structuredClone(this.data);
  }
}
