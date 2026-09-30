import { configSchemas, configCrossIssues, CONFIG_CROSS_KEYS, type ConfigKey, type ConfigShapes } from './schemas.js';
import { defaultConfigData } from './defaults.js';
import { configSetRev } from './configRev.js';
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

  /**
   * Загружает и валидирует все конфиги из сырых данных (по умолчанию — встроенные). Негодное — прежнее цело (R7-14).
   * ⭐ R21-03: `cross: false` — без правил поверх нескольких таблиц (только схемы таблиц): так грузит основу СБОРКА живого конфига
   * (`server/configCandidate.ts`) — правило D4 принадлежит итоговому кандидату (файлы + оверрайды базы), а не файлам без оверрайдов.
   * ⭐ R22-01: и каждый ЧИТАТЕЛЬ готового конфига — клиенты (встроенные файлы, тело `/api/config`, правка из канала редактора), редактор и его
   * инструменты: правило судят запись (проба сервера, проверка редактора до отправки) и сборка сервера (зажим с инцидентом), не читатель.
   */
  loadAll(raw: Record<string, unknown> = defaultConfigData, opts?: { cross?: boolean }): void {
    const staged: Record<string, unknown> = {};
    for (const key of Object.keys(configSchemas) as ConfigKey[]) {
      staged[key] = this.parse(key, raw[key]);
    }
    if (opts?.cross !== false) this.crossCheck(staged, Object.keys(staged) as ConfigKey[]);
    Object.assign(this.data, staged);
  }

  /**
   * ⭐ D4: ПРАВИЛА ПОВЕРХ НЕСКОЛЬКИХ ТАБЛИЦ (`configCrossIssues`: время баффа) — над тем, что станет живым: разобранное в сторонке поверх
   * прежнего. Нарушение — та же ошибка валидации (всё или ничего, R7-14), с таблицей правки: `reload({ balance })`, поднявший отдых баффа
   * выше, чем держит древо, — отказ «balance», а не молча нарушенное правило в игре.
   */
  private crossCheck(staged: Record<string, unknown>, changed: readonly ConfigKey[]): void {
    const touched = changed.filter((k) => CONFIG_CROSS_KEYS.includes(k));
    if (!touched.length) return;
    const live = this.data as Record<string, unknown>;
    const issues = configCrossIssues((k) => (k in staged ? staged[k] : live[k]));
    if (!issues.length) return;
    const key = touched.length === 1 ? touched[0]! : issues[0]!.key;
    throw new Error(`Конфиг "${key}" не прошёл валидацию:\n${issues.map((i) => `${i.key}: ${i.msg}`).join('\n')}`);
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
  reload(partial: Partial<Record<ConfigKey, unknown>>, opts?: { cross?: boolean }): void {
    const staged: [ConfigKey, unknown][] = [];
    for (const key of Object.keys(partial) as ConfigKey[]) staged.push([key, this.parse(key, partial[key])]);
    if (opts?.cross !== false) this.crossCheck(Object.fromEntries(staged), staged.map(([key]) => key));   // R21-03: `cross: false` — как у `loadAll`
    const store = this.data as Record<string, unknown>;
    for (const [key, value] of staged) store[key] = value;
    this.bus?.emit('config:reloaded', { keys: staged.map(([key]) => key) });
  }

  /** Возвращает сырые данные (для экспорта из редактора). */
  snapshot(): ConfigShapes {
    return structuredClone(this.data);
  }

  /**
   * ⭐ V-B3-07: ревизия всего конфига по содержимому (`configSetRev`) — согласие окна кузницы и лавки: `cfgRev` команды ≠ ревизии
   * сервера — клиент рисовал со старого конфига, отказ «Цена изменилась» до исполнения, и клиент его перечитывает.
   */
  revision(): string {
    const data = this.data as Record<string, unknown>;
    return configSetRev(CONFIG_KEYS, (k) => data[k]);
  }
}

/** Таблицы реестра в порядке схемы — порядок ревизии (`revision`) у сервера и клиента один. */
const CONFIG_KEYS: readonly string[] = Object.keys(configSchemas);
