import { EventBus, ConfigRegistry, debuffLabel, DEFAULT_HP_MANA_SCALING, PRICE_CHANGED, toggleBuffMods, reservedFrac, shopBuyPrice, type TownCommand, type Item, type QuestDef, type RunPlan, type CraftJournal, type ServerFrame } from '@dm/shared';
import type { GameState } from './gameState.js';
import { passiveModifiers } from '../modules/skills-passive/passiveStats.js';
import { activeModifiers } from '../modules/skills-active/activeStats.js';
import { setItemLabelResolvers } from '../modules/inventory/itemView.js';
import { setDamageTypeMeta } from './damageTypes.js';
import { setRarityMeta } from '../modules/loot/rarity.js';
import { NetClient } from '../net/netClient.js';
import { CmdReplies, type CmdReply } from '../net/cmdReplies.js';
import type { AuthSession } from '../modules/auth/authApi.js';
import type { GameLog } from '../ui/gameLog.js';

/** R4-24: один и тот же отказ команды в лог — не чаще раза за это время, мс. */
const REFUSAL_REPEAT_MS = 2000;

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
  /** Цены прилавка по uid — авторитетные, из того же кадра (R2-36): ровно столько спишет `buy`. */
  shopPrices: Record<string, number> = {};
  /** Доска случайных квестов — авторитетная, приходит с сервера (кадр `questBoard`). */
  questBoard: QuestDef[] = [];
  /**
   * Общий (на аккаунт) сундук — авторитетный слепок с сервера (кадр `stash`); null = ещё не пришёл.
   * `forgeJournal` — журнал кузнеца аккаунта (§12): по нему окно ковки решает, что открыто, а полевой
   * разбор — предупреждать ли о неизвестной детали. Нет поля — сервер старше журнала.
   */
  stash: { tabs: Item[][]; cols: number; rows: number; tabCount: number; materials: Record<string, number>; forgeJournal?: CraftJournal } | null = null;
  /** Активный забег v2 (граф RunPlan + текущий узел) — авторитетно с сервера (кадр `runPlan`); null = забега нет (город). */
  run: { plan: RunPlan; currentNodeId: string } | null = null;
  /** Сессия аккаунта (токен+userId); null = не вошёл. Персистится в localStorage `dm:auth`. */
  auth: AuthSession | null = loadAuth();
  private _pendingCharId: string | null = null;
  /**
   * charId выбранного персонажа для входа в мир (OnlineScene шлёт его в join). ⭐ R5-17: другой герой (или «никакой» —
   * к выбору героя, R4-22) — состояние прежнего героя прочь (`forgetSession`): страница без перезагрузки входит другим.
   */
  get pendingCharId(): string | null { return this._pendingCharId; }
  set pendingCharId(id: string | null) {
    if (id === this._pendingCharId) return;
    this._pendingCharId = id;
    this.forgetSession();
  }
  private _state: GameState | null = null;
  /** Откаты действий для заливки слотов биндов: id действия ('attack'|nodeId) → окно [start,until] в мс
   *  (performance.now). Пишется по событию `swing` с сервера (значит удар реально прошёл: мана/КД/оружие). */
  actionCooldowns: Record<string, { start: number; until: number }> = {};
  /** Общий attack-таймер (мс, performance.now): пока now<это — ВСЕ удары/attack-cast-скиллы залочены
   *  (серые в панели биндов). Ставится по каждому `swing`. */
  attackLockUntil = 0;
  /** Последний атакованный монстр (для реального шанса попасть/увернуться в листе). */
  lastTarget?: { name: string; accuracy: number; evade: number };
  /** Игровой лог/чат (DOM снизу-слева). Показывается только в игре (OnlineScene). Ставится в main.ts. */
  gameLog?: GameLog;

  private _inWorld = false;
  /**
   * ⭐ R6-25: герой В МИРЕ — вход состоялся (кадр `joined`), и связь с тех пор не терялась. Ведёт поток входа
   * (`EntryFlow` → `setInWorld`, оба клиента). Вне мира — вход в аккаунт, выбор героя, плашка «Подключение…», лобби,
   * «Продолжить» — хоткеи окон и «открыть окно» по шине молчат (`DomUi`), [E] у NPC не срабатывает (2D). Раньше под
   * экраном входа вид героя, NPC и хоткеи жили: кузница открывалась под лобби, её команды уходили в сокет без сессии, а
   * окно переживало вход в новую сессию.
   */
  get inWorld(): boolean { return this._inWorld; }
  /** Вход в мир / выход из него (`EntryFlow`). Каждая смена закрывает все окна: ни прошлая сессия, ни экран входа — не мир. */
  setInWorld(on: boolean): void {
    if (on === this._inWorld) return;
    this._inWorld = on;
    this.bus.emit('ui:closeAll', {});
  }

  /** Сквозной номер команды (Ф2.5) — сервер по нему отсекает повтор после обрыва связи. */
  private cmdId = 0;
  /** Ждущие ответа `cmdResult` по номеру команды (D3). */
  readonly replies = new CmdReplies();

  /**
   * Отправляет команду города на авторитетный сервер (магазин/экип/распределение). Возвращает её
   * номер — по нему придёт `cmdResult`. ⚠ Мост редактора (`gameHarness`) подменяет этот метод и
   * исполняет команду на месте — поэтому `request` ходит через него, а не мимо.
   */
  sendCmd(command: TownCommand, id = this.nextCmdId()): number {
    this.net.send({ t: 'cmd', command, id });
    return id;
  }

  /** Следующий номер команды. */
  nextCmdId(): number { return ++this.cmdId; }

  /**
   * ⭐ R4-37: цена покупки вещи прилавка — та, что прислал сервер (`shopPrices`): её и спишет `buy`. Своя по конфигу —
   * только если сервер цену не прислал: конфиг клиента расходится с серверным (правка из редактора, оверрайд в базе,
   * `/api/config` не ответил на старте), и бейдж «по карману» кончался отказом «Недостаточно золота».
   */
  shopPrice(it: Item): number { return this.shopPrices[it.uid] ?? shopBuyPrice(this.config, it); }

  /**
   * Команда С ОЖИДАНИЕМ ОТВЕТА (ковка, зачарование, разбор у кузнеца): промис ответа сервера или
   * `null` — ответа нет (обрыв, таймаут). ⚠ `null` — не отказ: команда могла выполниться, истина —
   * сейв. Ждущего регистрируем ДО отправки: мост редактора отвечает синхронно, внутри `sendCmd`.
   * `id` — повтор команды, оставшейся без ответа, ТЕМ ЖЕ номером (R4-23): сервер не исполнит её второй раз, а
   * ответит итогом первой (дедуп по номеру, Ф2.5). `onLate` — ответ, пришедший уже после «неизвестно» (R5-18): итог
   * известен, и повторять ТОТ ЖЕ номер больше нельзя — дедуп ответил бы эхом, не исполнив.
   */
  request(command: TownCommand, ms?: number, id = this.nextCmdId(), onLate?: (r: CmdReply) => void): Promise<CmdReply | null> {
    const reply = this.replies.wait(id, ms, onLate);
    this.sendCmd(command, id);
    return reply;
  }

  /** R4-24: последний отказ в логе — тот же подряд (зажатый клик, «Слишком часто») идёт одной строкой, а не лентой. */
  private refusal = { text: '', at: -Infinity };
  private logRefusal(reason: string): void {
    const now = Date.now();
    if (reason === this.refusal.text && now - this.refusal.at < REFUSAL_REPEAT_MS) return;
    this.refusal = { text: reason, at: now };
    this.bus.emit('log:message', { text: `Не вышло: ${reason}`, kind: 'system' });
  }

  /** Слепок сундука из кадра `stash` — одно место и для 2D, и для веб-3D, чтобы журнал не терялся. */
  applyStash(f: Extract<ServerFrame, { t: 'stash' }>): void {
    this.stash = { tabs: f.tabs, cols: f.cols, rows: f.rows, tabCount: f.tabCount, materials: f.materials, forgeJournal: f.forgeJournal };
    this.bus.emit('state:changed', {});
  }

  /** Сохраняет сессию аккаунта (после входа/регистрации). Другой аккаунт — его сундук и прочее ещё не пришли (R5-17). */
  setAuth(a: AuthSession): void {
    if (a.userId !== this.auth?.userId) this.forgetSession();
    this.auth = a;
    try { localStorage.setItem('dm:auth', JSON.stringify(a)); } catch { /* приватный режим */ }
  }
  /** Забывает сессию (выход/протухший токен). */
  clearAuth(): void {
    this.auth = null;
    this.pendingCharId = null;
    this.forgetSession();
    try { localStorage.removeItem('dm:auth'); } catch { /* приватный режим */ }
  }

  /**
   * ⭐ R5-17: забыть авторитетные слепки прежнего аккаунта и героя — сундук (сырьё, журнал кузнеца), прилавок с ценами,
   * доску заданий, забег. После R4-22 страница без перезагрузки входит ДРУГИМ аккаунтом или героем, а эти поля жили от
   * прежнего: окно кузницы, не дождавшись нового кадра `stash`, считало чужое сырьё и чужой журнал. Новые придут кадрами.
   */
  private forgetSession(): void {
    this.stash = null;
    this.shopStock = [];
    this.shopPrices = {};
    this.questBoard = [];
    this.run = null;
  }

  constructor() {
    this.config.loadAll(); // встроенные дефолты — мгновенный фолбэк до ответа сервера
    void this.syncConfig(); // единая истина: эффективный конфиг с сервера (и на каждом входе в мир — R5-15)
    this.listenConfigChannel();
    this.refreshLabelResolvers();
    // Авторитетный сток магазина с сервера (и его цены, R4-37) → перерисовать открытую панель.
    this.net.on('shop', (f) => { this.shopStock = f.items; this.shopPrices = f.prices ?? {}; this.bus.emit('state:changed', {}); });
    // Авторитетная доска квестов с сервера → перерисовать журнал.
    this.net.on('questBoard', (f) => { this.questBoard = f.quests; this.bus.emit('state:changed', {}); });
    // Авторитетный слепок общего сундука с сервера (с журналом кузнеца) → перерисовать панели.
    this.net.on('stash', (f) => this.applyStash(f));
    // Ответ на команду (D3) — отпускает того, кто ждёт именно её (`request`). ⭐ R4-24: отказ команды, которую никто не
    // ждёт (купить, взять задание, забрать награду, надеть, переложить…), — строкой в лог игры: раньше клик молча не
    // делал ничего. Ждущему окну отказ показывает само окно — в лог он не дублируется.
    // ⭐ R5-15: «Цена изменилась» — сервер не взял больше показанного: конфиг клиента устарел (правка без переподключения),
    // перечитываем его — карточки покажут цену, которую сервер возьмёт.
    this.net.on('cmdResult', (f) => {
      if (!f.ok && f.reason?.startsWith(PRICE_CHANGED)) void this.syncConfig();
      if (!this.replies.settle(f) && !f.ok && f.reason) this.logRefusal(f.reason);
    });
    // Структура активного забега (v2): граф узлов + текущий узел — для карты забега и маппинга выходов на рёбра.
    this.net.on('runPlan', (f) => { this.run = { plan: f.plan, currentNodeId: f.currentNodeId }; this.bus.emit('state:changed', {}); });
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
        return sub ? `${sub.name.toLowerCase()} → ${debuffLabel(this.config.get('debuffs'), sub.kind).toLowerCase()}` : id;
      },
      skill: (id) => this.config.get('skill-tree').nodes.find((n) => n.id === id)?.name ?? id,
    });
    // Метаданные каналов урона из ДВУХ конфигов: 'physical' — из damage-kinds (тип урона),
    // стихии (fire/cold/lightning/poison) — из magic-subtypes (маг. подтипы, у них есть ailment).
    const phys = this.config.get('damage-kinds').find((k) => k.id === 'physical');
    setDamageTypeMeta({
      ...(phys ? { physical: { name: phys.name, short: phys.short, color: phys.color, ailment: null } } : {}),
      ...Object.fromEntries(
        this.config.get('magic-subtypes').map((s) => [s.id, { name: s.name, short: s.short, color: s.color, ailment: s.ailment }]),
      ),
    });
    // Цвета/имена редкости — из конфига `rarities` (единый источник с rarities.json).
    setRarityMeta(Object.fromEntries(
      this.config.get('rarities').map((r) => [r.id, { name: r.name, color: r.color }]),
    ));
  }

  /** R5-15: ETag применённого серверного конфига ('' — ещё ни одного): с ним запрос условный, неизменный — 304. */
  private configEtag = '';
  /** R5-15: номер запроса конфига — ответ, обогнанный следующим запросом, не применяется. */
  private configSeq = 0;

  /**
   * Единая истина — серверный конфиг (дефолты + сохранённые правки редактора, персист в БД). Тянем его при старте и
   * накатываем поверх встроенных дефолтов. Сервер недоступен — остаёмся на том, что есть (игру считает сервер).
   *
   * ⭐ R5-15: И НА КАЖДОМ ВХОДЕ В МИР (кадр `joined`, `EntryFlow.onJoined`), и на отказ «Цена изменилась». Раньше конфиг
   * брался один раз на страницу: с L2 / R3-25 деплой не перезагружает вкладку (она переподключается сама), и цены кузницы,
   * скупки и сбросов, гашение карточек, «аура ли это» оставались до деплоя, а сервер брал новые; неудача на старте
   * (страница открылась во время перезапуска) не повторялась никогда. Запрос условный (`If-None-Match` с ETag сервера,
   * `configEtag.ts`): неизменный конфиг — 304 без тела и без перерисовки.
   */
  async syncConfig(): Promise<void> {
    const seq = ++this.configSeq;
    try {
      const res = await fetch('/api/config', { cache: 'no-cache', ...(this.configEtag ? { headers: { 'if-none-match': this.configEtag } } : {}) });
      if (seq !== this.configSeq || !res.ok) return;   // 304 — тот же конфиг; обогнал следующий запрос — применит он
      const snapshot = (await res.json()) as Parameters<ConfigRegistry['reload']>[0];
      if (seq !== this.configSeq) return;
      this.config.reload(snapshot);
      this.configEtag = res.headers.get('etag') ?? '';
      this.refreshLabelResolvers();
      this.bus.emit('state:changed', {});
    } catch {
      /* сервер недоступен (или прислал негодное) — остаёмся на том, что есть; следующий вход спросит снова */
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
        passiveModifiers(this.config, value.save.masteries);
      value.activeModsProvider = () =>
        activeModifiers(this.config, value.save.skills);
      value.armorClassesProvider = () => this.config.get('armor-classes');
      value.derivedScalingProvider = () =>
        this.config.get('classes').find((c) => c.id === value.save.classId)?.derived
        ?? DEFAULT_HP_MANA_SCALING;
      value.moveSpeedBaseProvider = () => this.config.get('balance').moveSpeedBase;
      // Ауры/стойки: активные бонусы в статы + доля резерва пула (единый расчёт с сервером).
      value.toggleModsProvider = () => toggleBuffMods(this.config, value.toggles);
      value.reservedManaFracProvider = () => reservedFrac(this.config, value.toggles, 'mana');
      value.reservedStaminaFracProvider = () => reservedFrac(this.config, value.toggles, 'stamina');
    }
  }

  static from(scene: Phaser.Scene): App {
    return scene.game.registry.get('app') as App;
  }
}
