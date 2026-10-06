import { EventBus, ConfigRegistry, CONFIG_REV_HEADER, debuffLabel, DEFAULT_HP_MANA_SCALING, PRICE_CHANGED, toggleBuffMods, reservedFrac, shopBuyPrice, withConfigRev, type TownCommand, type Item, type QuestDef, type RunPlan, type CraftJournal, type ServerFrame, type HeroCooldowns } from '@dm/shared';
import type { GameState } from './gameState.js';
import { passiveModifiers } from '../modules/skills-passive/passiveStats.js';
import { activeModifiers } from '../modules/skills-active/activeStats.js';
import { setItemLabelResolvers } from '../modules/inventory/itemView.js';
import { materialNote } from '../modules/inventory/materialsModel.js';
import { setDamageTypeMeta } from './damageTypes.js';
import { setRarityMeta } from '../modules/loot/rarity.js';
import { NetClient } from '../net/netClient.js';
import { CmdReplies, type CmdReply } from '../net/cmdReplies.js';
import { clientBuild, onStaleBuild, watchChunkErrors } from '../net/staleBuild.js';
import { PROTOCOL_STALE, REFUSAL_REPEAT_MS, VersionGate, type ConfigRead } from '../net/versionGate.js';
import type { AuthSession } from '../modules/auth/authApi.js';
import type { GameLog } from '../ui/gameLog.js';

/** R4-24: предел повтора отказа в логе (и «перезагрузите» на отказ) — живёт у правила версий (`net/versionGate.ts`, D3). */
export { REFUSAL_REPEAT_MS };

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
   *  (performance.now). Пишется по событию `swing` с сервера (значит удар реально прошёл: мана/КД/оружие).
   *  ⭐ R21-05: и с кадра входа (`joined.cooldowns` — откаты, которые сервер вернул герою, `applyJoinCooldowns`); смена героя их забывает. */
  actionCooldowns: Record<string, { start: number; until: number }> = {};
  /** Общий attack-таймер (мс, performance.now): пока now<это — ВСЕ удары/attack-cast-скиллы залочены
   *  (серые в панели биндов). Ставится по каждому `swing`; вход в мир и смена героя его снимают (R21-05). */
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
   * ⭐ V-B3-07: команды кузницы, лавки и разбора уходят с ревизией конфига, по которому их нарисовали окна (`withConfigRev`): у
   * сервера другой — отказ «Цена изменилась», и конфиг перечитывается (обработчик `cmdResult` ниже). Одно место на все окна.
   * ⭐ R16 C-07: ревизия — СЕРВЕРНАЯ для тела конфига, легшего во вкладку (`configRevision`), а не посчитанная схемой вкладки.
   * ⭐ D3: и со штампом сборки вкладки (`clientBuild`) — согласие на КОД: у сервера другой — тот же отказ до исполнения (`buildChanged`), и
   * вкладка, чьи окна считали цену старой формулой, не платит не то, что показала.
   */
  sendCmd(command: TownCommand, id = this.nextCmdId()): number {
    this.net.send({ t: 'cmd', command: withConfigRev(this.configRevision(), command, clientBuild()), id });
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
  /**
   * ⭐ D3: ПРАВИЛО ВЕРСИЙ — одно на оба клиента (`net/versionGate.ts`): рукопожатие на каждом входе (`joined`: протокол, штамп сборки, ревизия
   * конфига), отказ «Цена изменилась» (перечитать конфиг один раз, потом решить), упавший кусок сборки. «Перезагрузите» — только отсюда.
   */
  readonly version = new VersionGate({
    reread: () => this.syncConfig(),
    configRevision: () => this.configRevision(),
    configUnreadable: () => this.configStale !== null || this.configDrift,
    tell: () => this.bus.emit('log:message', { text: PROTOCOL_STALE, kind: 'system' }),
  });

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
    this.applyJoinCooldowns(undefined);   // ⭐ R21-05: заливки слотов и общий лок прежнего героя — не этого
  }

  /**
   * ⭐ R21-05: ОТКАТЫ СЛОТОВ — С КАДРА ВХОДА, А НЕ С ПАМЯТИ СТРАНИЦЫ. Сервер на входе возвращает герою откаты (реконнект — запись ухода R4-06, другая
   * комната — D4, из `vitals.cd`, вторая вкладка) и шлёт их в `joined.cooldowns`: событие каста о них не придёт. Раньше новая страница (F5, другое
   * устройство, вход по коду) рисовала слот готовым, а каст сервер молча отбрасывал до конца скрытого отката; смена героя без перезагрузки оставляла
   * заливки и общий лок прежнего. Каждый вход (и смена героя — без откатов) начинает с того, что держит сервер: окно заливки — остаток до конца,
   * доля — от полного отката. Одно место на оба клиента: события каста (`swing`/`cooldown`) дальше пишут сюда же сцены.
   */
  applyJoinCooldowns(cd: HeroCooldowns | undefined): void {
    for (const id of Object.keys(this.actionCooldowns)) delete this.actionCooldowns[id];
    this.attackLockUntil = 0;
    const now = performance.now();
    for (const [id, c] of Object.entries(cd ?? {})) {
      if (!(c.leftMs > 0)) continue;
      this.actionCooldowns[id] = { start: now - Math.max(0, c.fullMs - c.leftMs), until: now + c.leftMs };
    }
  }

  /**
   * ⭐ R7-15: `App` БЕЗ СЕРВЕРА — мост редактора (`gameHarness`): калькулятор и песочница ковки строят его из своих данных
   * «что, если». Такой не тянет `/api/config` (ни в конструкторе, ни в `syncConfig`) и не слушает канал правок редактора:
   * раньше серверный конфиг через миллисекунды ложился поверх песочницы, а каждый мост держал свой канал навсегда.
   */
  private readonly offline: boolean;

  constructor(opts: { offline?: boolean } = {}) {
    this.offline = opts.offline === true;
    // Встроенные дефолты — мгновенный фолбэк до ответа сервера. ⭐ R22-01: ЧИТАТЕЛЕМ — схема каждой таблицы, без правила поверх таблиц (D4):
    // файлы данных, вместе его нарушающие (правка одного `data/*.json`, слияние двух годных правок), сервер собирает с зажимом и ИНЦИДЕНТОМ и
    // работает, а конструктор бросал раньше, чем `syncConfig` брал годный конфиг сервера, — пустая страница у обоих клиентов. Правило
    // принадлежит итоговому конфигу: его судят запись и сборка сервера (docs/CONFIG_SCHEMA.md «D4»), ядро держит зажим.
    this.config.loadAll(undefined, { cross: false });
    if (!this.offline) {
      void this.syncConfig(); // единая истина: эффективный конфиг с сервера (и на каждом входе в мир — R5-15)
      this.listenConfigChannel();
      // ⭐ R10-12: ленивый кусок сборки не загрузился (деплой сменил хэши, а вкладка его пережила без перезагрузки при том
      // же `PROTOCOL_VERSION`) — код вкладки старше: «перезагрузите страницу» (`net/staleBuild.ts` — раз на страницу), по правилу версий (D3).
      onStaleBuild(() => this.version.chunkFailed());
      watchChunkErrors();
    }
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
    // ⭐ D3: перечитывание — ОДНО, и только после него решение (`VersionGate.refused`): лёг новый конфиг — отказ объяснён; нет, а вкладка старше
    // сервера (код не той сборки, конфиг сервера не разобран или разобран «не в то же» — R18-08, R7-14, R16 C-07) — «перезагрузите страницу».
    this.net.on('cmdResult', (f) => {
      if (!f.ok && f.reason?.startsWith(PRICE_CHANGED)) void this.version.refused();
      if (!this.replies.settle(f) && !f.ok && f.reason) this.logRefusal(f.reason);
    });
    // ⭐ D3: РУКОПОЖАТИЕ ВЕРСИЙ — на каждом входе в мир, здесь, а не в обработчиках сцен: оба клиента строят один `App`, и сверка не зависит
    // от того, как сцена подписывается на кадры (R19-02). Протокол, штамп сборки и ревизия конфига — `VersionGate.joined`.
    this.net.on('joined', (f) => void this.version.joined(f));
    // ⭐ R21-05: откаты, с которыми сервер посадил героя, — заливкой слотов с первого кадра (новая страница о касте не знает), и здесь, а не в сценах.
    this.net.on('joined', (f) => this.applyJoinCooldowns(f.cooldowns));
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
      // §15.3–15.4: строка происхождения («была «Отличный»») и подсказка стопки сырья — из тех же живых конфигов.
      tierName: (id) => this.config.get('item-tiers').find((t) => t.id === id)?.name,
      materialNote: (item) => materialNote(this.config, item),
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
  /**
   * R7-14: ETag серверного конфига, который эта вкладка НЕ РАЗОБРАЛА (null — такого нет). Запрос условный по нему: тот же негодный — 304 без
   * тела. ⭐ D3: пока он есть, вкладка старше сервера — правило версий (`VersionGate`) говорит «перезагрузите» на входе и на отказ ценой.
   */
  private configStale: string | null = null;
  /** R5-15: номер запроса конфига — ответ, обогнанный следующим запросом, не применяется. */
  private configSeq = 0;
  /**
   * ⭐ R16 C-07: ревизия СЕРВЕРА для тела конфига, которое легло во вкладку (заголовок `CONFIG_REV_HEADER`); null — конфиг вкладки не тело
   * сервера (встроенные дефолты до первого ответа, правка из канала редактора) или сервер ревизию не прислал (старше заголовка).
   */
  private configRev: string | null = null;
  /**
   * ⭐ R16 C-07: легшее тело сервера разобрано «не в то же» — своя ревизия по разобранному не сошлась с серверной (схема вкладки старше). ⭐ D3:
   * пока так, вкладка старше сервера (`VersionGate`); сходит с годным телом той же формы или правкой из канала редактора (тело уже не серверное).
   */
  private configDrift = false;

  /**
   * ⭐ R16 C-07: РЕВИЗИЯ ДЛЯ СОГЛАСИЯ (`cfgRev` команд кузницы, лавки и разбора, V-B3-07) — «с какого конфига СЕРВЕРА нарисованы окна»: та,
   * что сервер прислал с телом, легшим во вкладку. Своя (`ConfigRegistry.revision`, по разобранному) — только если тела сервера во вкладке
   * нет. Раньше — всегда своя: деплой, сменивший форму любой таблицы (новое поле, другой порядок, убранное поле с умолчанием), при старой
   * вкладке (L2 / R3-25 — переподключается без перезагрузки, `PROTOCOL_VERSION` тот же) давал «удачный» разбор в ДРУГОЕ, её ревизия
   * расходилась с серверной навсегда, и каждая продажа, ковка и разбор — «Цена изменилась», а перечитывание — 304 с тем же ETag.
   */
  configRevision(): string {
    return this.configRev ?? this.config.revision();
  }

  /**
   * Единая истина — серверный конфиг (дефолты + сохранённые правки редактора, персист в БД). Тянем его при старте и
   * накатываем поверх встроенных дефолтов. Сервер недоступен — остаёмся на том, что есть (игру считает сервер).
   *
   * ⭐ R5-15: И НА КАЖДОМ ВХОДЕ В МИР (рукопожатие версий, `VersionGate.joined`), и на отказ «Цена изменилась». Раньше конфиг
   * брался один раз на страницу: с L2 / R3-25 деплой не перезагружает вкладку (она переподключается сама), и цены кузницы,
   * скупки и сбросов, гашение карточек, «аура ли это» оставались до деплоя, а сервер брал новые; неудача на старте
   * (страница открылась во время перезапуска) не повторялась никогда. Запрос условный (`If-None-Match` с ETag сервера,
   * `configEtag.ts`): неизменный конфиг — 304 без тела и без перерисовки.
   *
   * ⭐ R7-14: КОНФИГ, КОТОРЫЙ ВКЛАДКА НЕ РАЗБИРАЕТ (деплой со сменой схемы — новая таблица, переименованное поле, — а вкладка
   * старая), не ложится вовсе (`reload` — всё или ничего): раньше ложилась половина, а ошибка глоталась — карточки считали цену
   * по смеси двух конфигов, сервер отказывал «Цена изменилась», отказ звал сюда же, и игрок застревал на отказах молча. Теперь
   * прежний конфиг цел, а вкладка помнит, что она старше сервера (`configStale`).
   *
   * ⭐ D3: ИТОГ — `ConfigRead` (`net/versionGate.ts`): лёг новый конфиг (`fresh`), тот же (`same`, 304), новый негодный или разобранный «не в то
   * же» (`broken`), сервер не ответил или сети нет — мост редактора (`failed`), ответ обогнан следующим запросом (`overtaken`). Сам `syncConfig`
   * игроку не говорит НИЧЕГО: «перезагрузите» решает правило версий — одна строка на вход, на отказ — после перечитывания (раньше здесь
   * говорилось своё «раз на ETag», и на входе с чужим протоколом звучали две строки).
   */
  async syncConfig(): Promise<ConfigRead> {
    if (this.offline) return 'failed';
    const seq = ++this.configSeq;
    let res: Response;
    let snapshot: Parameters<ConfigRegistry['reload']>[0];
    try {
      const inm = this.configStale ?? this.configEtag;   // R7-14: негодный уже разобран — тот же вернётся 304-м
      res = await fetch('/api/config', { cache: 'no-cache', ...(inm ? { headers: { 'if-none-match': inm } } : {}) });
      if (seq !== this.configSeq) return 'overtaken';   // обогнал следующий запрос — применит он
      if (!res.ok) return res.status === 304 ? 'same' : 'failed';
      snapshot = (await res.json()) as Parameters<ConfigRegistry['reload']>[0];
    } catch {
      return 'failed';   // сервер недоступен (или прислал не JSON) — остаёмся на том, что есть; следующий вход спросит снова
    }
    if (seq !== this.configSeq) return 'overtaken';
    const etag = res.headers.get('etag') ?? '';
    try {
      // ⭐ R22-01: тело сервера — итоговый конфиг, правило поверх таблиц уже решено сервером (зажим с инцидентом; `crossLeft` — поставлен без
      // проверки с инцидентом): вкладка его не судит. «Не разобран» (`broken`) — только схема таблицы: вкладка старше сервера (D3).
      this.config.reload(snapshot, { cross: false });
    } catch (e) {
      if (etag !== this.configStale) console.warn('[config] конфиг сервера не разобран — вкладка старше сервера:', e instanceof Error ? e.message : e);
      this.configStale = etag;
      return 'broken';
    }
    this.configEtag = etag;
    this.configStale = null;
    // ⭐ R16 C-07: согласие — по ревизии сервера для этого тела (`configRevision`). Своя по разобранному с ней не сошлась — схема вкладки
    // старше (новое поле срезано, умолчание дописано, порядок полей свой): окна рисуют почти то же, но не то — вкладка старше сервера.
    const rev = res.headers.get(CONFIG_REV_HEADER);
    this.configRev = rev || null;
    const drift = !!rev && rev !== this.config.revision();
    if (drift && !this.configDrift) console.warn('[config] конфиг сервера разобран не в то же — схема вкладки старше сервера');
    this.configDrift = drift;
    this.refreshLabelResolvers();
    this.bus.emit('state:changed', {});
    return drift ? 'broken' : 'fresh';
  }

  /** Живой приём изменений из HTML-редактора (BroadcastChannel). */
  private listenConfigChannel(): void {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const bc = new BroadcastChannel('dm-config');
    bc.onmessage = (e: MessageEvent) => {
      const { key, value } = (e.data ?? {}) as { key?: string; value?: unknown };
      if (!key) return;
      try {
        // ⭐ R22-01: таблицу редактор шлёт ПОСЛЕ того, как сервер её принял (C-09), — правило поверх таблиц решено им, вкладка не судит (её прочие
        // таблицы могут быть старше: сервер не ответил на старте) — иначе принятая сервером правка молча отбрасывалась.
        this.config.reload({ [key]: value } as Record<string, unknown>, { cross: false });
        // ⭐ V-B3-07: конфиг вкладки уже не тело с ETag `configEtag` (правку сервер мог и не принять — 409, схема): следующий
        // `syncConfig` — безусловный, иначе 304 оставил бы таблицу, которой у сервера нет, и согласие на конфиг отказывало бы без конца.
        // ⭐ R16 C-07: и ревизия сервера — уже не про этот конфиг: согласие — по своей, пока тело сервера не ляжет снова.
        this.configEtag = '';
        this.configRev = null;
        this.configDrift = false;   // D3: тело уже не серверное — «разобрано не в то же» больше не про него
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
