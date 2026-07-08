import { EventBus, ConfigRegistry, DEBUFF_LABEL, DEFAULT_HP_MANA_SCALING, toggleBuffMods, reservedManaFrac, type TownCommand, type Item, type QuestDef } from '@dm/shared';
import type { GameState } from './gameState.js';
import { passiveModifiers } from '../modules/skills-passive/passiveStats.js';
import { activeModifiers } from '../modules/skills-active/activeStats.js';
import { setItemLabelResolvers } from '../modules/inventory/itemView.js';
import { setDamageTypeMeta } from './damageTypes.js';
import { setRarityMeta } from '../modules/loot/rarity.js';
import { NetClient } from '../net/netClient.js';
import type { AuthSession } from '../modules/auth/authApi.js';

/** Читает сохранённую сессию аккаунта из localStorage (`dm:auth`). */
function loadAuth(): AuthSession | null {
  try { const raw = localStorage.getItem('dm:auth'); return raw ? (JSON.parse(raw) as AuthSession) : null; } catch { return null; }
}

/**
 * Глобальные сервисы клиента, живущие всё время работы приложения.
 * Сцены получают доступ через game.registry (см. main.ts): `App.from(scene)`.
 */
export class App {
  readonly bus = new EventBus();
  readonly config = new ConfigRegistry(this.bus);
  /** Сетевой клиент авторитетного сервера (вся игра онлайн). */
  readonly net = new NetClient();
  /** Ассортимент магазина — авторитетный, приходит с сервера (кадр `shop`). */
  shopStock: Item[] = [];
  /** Доска случайных квестов — авторитетная, приходит с сервера (кадр `questBoard`). */
  questBoard: QuestDef[] = [];
  /** Общий (на аккаунт) сундук — авторитетный слепок с сервера (кадр `stash`); null = ещё не пришёл. */
  stash: { tabs: Item[][]; cols: number; rows: number; tabCount: number } | null = null;
  /** Сессия аккаунта (токен+userId); null = не вошёл. Персистится в localStorage `dm:auth`. */
  auth: AuthSession | null = loadAuth();
  /** charId выбранного персонажа для входа в мир (OnlineScene шлёт его в join). */
  pendingCharId: string | null = null;
  private _state: GameState | null = null;
  /** Оставшиеся доли КД скиллов по id (0..1) — для панели биндов. Обновляет combat. */
  skillCooldowns: Record<string, number> = {};
  /** Последний атакованный монстр (для реального шанса попасть/увернуться в листе). */
  lastTarget?: { name: string; accuracy: number; evade: number };

  /** Отправляет команду города на авторитетный сервер (магазин/экип/распределение). */
  sendCmd(command: TownCommand): void {
    this.net.send({ t: 'cmd', command });
  }

  /** Сохраняет сессию аккаунта (после входа/регистрации). */
  setAuth(a: AuthSession): void {
    this.auth = a;
    try { localStorage.setItem('dm:auth', JSON.stringify(a)); } catch { /* приватный режим */ }
  }
  /** Забывает сессию (выход/протухший токен). */
  clearAuth(): void {
    this.auth = null;
    this.pendingCharId = null;
    try { localStorage.removeItem('dm:auth'); } catch { /* приватный режим */ }
  }

  constructor() {
    this.config.loadAll(); // встроенные дефолты — мгновенный фолбэк до ответа сервера
    void this.fetchServerConfig(); // единая истина: эффективный конфиг с сервера
    this.listenConfigChannel();
    this.refreshLabelResolvers();
    // Авторитетный сток магазина с сервера → перерисовать открытую панель.
    this.net.on('shop', (f) => { this.shopStock = f.items; this.bus.emit('state:changed', {}); });
    // Авторитетная доска квестов с сервера → перерисовать журнал.
    this.net.on('questBoard', (f) => { this.questBoard = f.quests; this.bus.emit('state:changed', {}); });
    // Авторитетный слепок общего сундука с сервера → перерисовать панель сундука.
    this.net.on('stash', (f) => { this.stash = { tabs: f.tabs, cols: f.cols, rows: f.rows, tabCount: f.tabCount }; this.bus.emit('state:changed', {}); });
  }

  /**
   * Заполняет резолверы UI-меток (брони/веса/физ-подтипа, типов урона, редкости)
   * из ЖИВОГО конфига — единый источник с JSON, без хардкода/задвоений. Вызывается
   * при старте и после каждой перезагрузки конфига (live-apply из редактора).
   */
  private refreshLabelResolvers(): void {
    // Тултипы берут имена классов брони / весов / физ-подтипов из ЖИВЫХ конфигов.
    // Подтип показывает и накладываемый статус.
    setItemLabelResolvers({
      armorClass: (id) => this.config.get('armor-classes').find((c) => c.id === id)?.name ?? id,
      weight: (id) => (this.config.get('weapon-weights').find((w) => w.id === id)?.name ?? id).toLowerCase(),
      physSub: (id) => {
        const sub = this.config.get('phys-subtypes').find((s) => s.id === id);
        return sub ? `${sub.name.toLowerCase()} → ${DEBUFF_LABEL[sub.kind].toLowerCase()}` : id;
      },
    });
    setDamageTypeMeta(Object.fromEntries(
      this.config.get('damage-types').map((d) => [d.id, { name: d.name, short: d.short, color: d.color, ailment: d.ailment }]),
    ));
    // Цвета/имена редкости — из конфига `rarities` (единый источник с rarities.json).
    setRarityMeta(Object.fromEntries(
      this.config.get('rarities').map((r) => [r.id, { name: r.name, color: r.color }]),
    ));
  }

  /**
   * Единая истина — серверный конфиг (дефолты + сохранённые правки редактора, персист в БД).
   * Тянем его при старте и накатываем поверх встроенных дефолтов. Сервер недоступен — молча
   * остаёмся на дефолтах (клиентский конфиг влияет только на отображение; игру считает сервер).
   */
  private async fetchServerConfig(): Promise<void> {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) return;
      const snapshot = (await res.json()) as Parameters<ConfigRegistry['reload']>[0];
      this.config.reload(snapshot);
      this.refreshLabelResolvers();
      this.bus.emit('state:changed', {});
    } catch {
      /* сервер недоступен — остаёмся на встроенных дефолтах */
    }
  }

  /** Живой приём изменений из HTML-редактора (BroadcastChannel). */
  private listenConfigChannel(): void {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const bc = new BroadcastChannel('dm-config');
    bc.onmessage = (e: MessageEvent) => {
      const { key, value } = (e.data ?? {}) as { key?: string; value?: unknown };
      if (!key) return;
      try {
        this.config.reload({ [key]: value } as Record<string, unknown>);
        this.refreshLabelResolvers();
        this.bus.emit('state:changed', {});
      } catch {
        /* невалидный конфиг — пропускаем */
      }
    };
  }

  /** Текущее состояние игры (null пока не выбран класс / не загружен сейв). */
  get state(): GameState | null {
    return this._state;
  }

  set state(value: GameState | null) {
    this._state = value;
    if (value) {
      // Подключаем поставщиков модификаторов от деревьев скиллов.
      value.passiveModsProvider = () =>
        passiveModifiers(this.config, value.save.passiveSkills);
      value.activeModsProvider = () =>
        activeModifiers(this.config, value.save.classId, value.save.activeSkills);
      value.armorClassesProvider = () => this.config.get('armor-classes');
      value.derivedScalingProvider = () =>
        this.config.get('classes').find((c) => c.id === value.save.classId)?.derived
        ?? DEFAULT_HP_MANA_SCALING;
      // Ауры/стойки: активные бонусы в статы + доля резерва маны (единый расчёт с сервером).
      value.toggleModsProvider = () => toggleBuffMods(this.config, value.save.classId, value.toggles);
      value.reservedManaFracProvider = () => reservedManaFrac(this.config, value.save.classId, value.toggles);
    }
  }

  static from(scene: Phaser.Scene): App {
    return scene.game.registry.get('app') as App;
  }
}
