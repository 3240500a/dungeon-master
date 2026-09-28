import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '@dm/shared';
import { dismissAsk } from '../ui/kit.js';
import type { RouteAnswer } from './netClient.js';

/**
 * ⭐ ВХОД В МИР И ПОТЕРЯ СВЯЗИ — ОДИН ПОТОК НА ОБА КЛИЕНТА (2D `OnlineScene` и веб-3D `online3d`).
 *
 * Путь входа: плашка «Подключение…» → сокет открылся → `runStatus` → лобби (Соло / Создать / Войти по коду) или
 * «Продолжить / Забросить» → `join` → кадр `joined` снимает экраны. Мир строит сам клиент — у каждого свой рендер.
 *
 * ⭐ R3-25 / L2: СЕРВЕР ЗАКРЫЛ ЖИВУЮ СЕССИЮ (4009 — устаревшая копия, сбой фиксации, чужая нода; 4001 — герой вошёл из
 * другого окна; 4008 — лимит частоты; обрыв сети). Окна прошлой области и мир прошлой сессии прочь (`onLost`), ждущие
 * ответа команды отпущены с «неизвестно» (`replies.dropAll` — ответ по мёртвому сокету не придёт никогда), плашка с
 * причиной (`netLostText`) и переподключение: `runStatus` → лобби или «Продолжить» с той же причиной, вход — заново из
 * базы. ⚠ Само переподключение героя НЕ входит (`runStatus` никого не выселяет): иначе два окна одного героя выселяли бы
 * друг друга по кругу — вход только кликом игрока.
 *
 * Раньше эта логика жила в 2D-сцене, а веб-3D на любое закрытие показывал «Сервер недоступен» и не переподключался, и
 * кнопки его лобби слали `join` в мёртвый сокет — после 4009 / 4001 / 4008 помогала только перезагрузка страницы.
 * Логика одна — и расходиться клиентам больше негде. DOM экранов — `ui/entryScreens.ts` (тоже общий).
 *
 * ⭐ R4-13: КЛАСТЕР. Перед КАЖДЫМ подключением (вход, переподключение, к другу по коду, «wrong-node») поток спрашивает
 * у гейтвея адрес ноды (`route` → `GET /api/route`) и подключается к ней; очередь на вход — местом на плашке и
 * переспросом с билетом. Раньше адрес не спрашивал никто: сокет шёл на origin, то есть к гейтвею без игрового сокета.
 *
 * ⭐ R4-22: ОТВЕТ-ОТКАЗ НА АВТОМАТИЧЕСКИЙ СТАТУС ЗАБЕГА. Плашка «Подключение…» — без кнопок, и отказ на статус
 * («занят» — база медленная, а 4009 шлётся как раз тогда) оставлял игрока на ней навсегда. Теперь «занят» — повтор с
 * паузой 2/4/8 с, потом лобби; «вход недействителен» / «герой недоступен» — к входу / выбору героя (`onRejected`);
 * прочее — лобби с причиной. На экране входа всегда есть что нажать.
 *
 * ⭐ C-05, C-08: «ПРОДОЛЖИТЬ», ОТКАЗАННЫЙ ИЗ-ЗА ЗАБЕГА В ДРУГОЙ КОМНАТЕ (`error{code:'run'|'full', roomCode}`, V2), — не строка на экране без поля
 * кода: к ноде держателя и там снова «Продолжить», а нет мест — лобби с его кодом в поле (`runHeld`). Выход без «Забросить» есть всегда.
 *
 * Чистый класс без DOM и сети напрямую — его гоняют node-тесты с поддельным сокетом.
 */

/**
 * R3-25: почему сервер закрыл сокет — строкой для игрока. 4009 — сессия устарела (сейв записал кто-то другой, сбой
 * фиксации, герой ушёл на другую ноду), 4001 — герой вошёл из другого окна, 4008 — лимит частоты кадров.
 */
export function netLostText(code?: number): string {
  if (code === 4009) return 'Сессия устарела — входим заново из сохранения';
  if (code === 4001) return 'Герой вошёл в игру в другом окне — здесь соединение закрыто';
  if (code === 4008) return 'Слишком много запросов — соединение сброшено сервером';
  return 'Соединение потеряно — входим заново';
}

/** Что входу нужно от `NetClient` — ровно это, чтобы тест подставил подделку. */
export interface EntryNet {
  readonly connected: boolean;
  on<T extends ServerFrame['t']>(t: T, cb: (frame: Extract<ServerFrame, { t: T }>) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (code?: number) => void): void;
  /** Подключиться; `url` — адрес ноды от гейтвея (R4-13), нет — адрес по умолчанию. */
  connect(url?: string): void;
  resetWorld(): void;
  send(frame: ClientFrame): void;
}

/** Как войти: новая комната (соло/хост), к другу по коду, продолжить незавершённый забег. */
export type JoinOpts = { fresh?: boolean; roomCode?: string; resume?: boolean };

/** Экраны входа. Показ экрана заменяет прежний: на экране всегда не больше одного. */
export interface EntryView {
  /** Плашка «Подключение к серверу…» — без кнопок (нечего нажать мимо). */
  showConnecting(): void;
  /** Лобби. `roomCode` — вписать в поле кода (C-05: пати забега, куда «Продолжить» не пустило). */
  showLobby(go: (o: JoinOpts) => void, roomCode?: string): void;
  showResume(roomCode: string, depth: number, act: { resume: () => void; abandon: () => void }): void;
  /** Снять экран входа (вход состоялся, выход из игры). */
  hide(): void;
  /** Строка состояния на показанном экране; экрана нет — ничего. */
  setStatus(text: string): void;
}

export interface EntryDeps {
  net: EntryNet;
  /** Кто входит: токен сессии аккаунта и герой. */
  who: () => { token: string; charId: string };
  view: EntryView;
  /** Связь потеряна: снести мир прошлой сессии и окна прошлой области (голосование, смерть). */
  onLost?: () => void;
  /** Ждущие ответа на команды (`App.replies`) — отпускаются с «неизвестно» при потере связи. */
  replies?: { dropAll(): void };
  /** Ошибка сервера в игре (экрана входа нет) — строкой в лог игры. */
  log?: (text: string) => void;
  /** Часы, мс (тесту — свои). */
  now?: () => number;
  /**
   * ⭐ R4-13: адрес игровой ноды у гейтвея (`routeToNode`) — перед каждым подключением. Не задан — сокет на адрес по
   * умолчанию (`NetClient`: `VITE_WS_URL` или тот же origin), как было в одиночном процессе.
   */
  route?: (token: string, charId: string, ticket?: string, roomCode?: string) => Promise<RouteAnswer>;
  /**
   * R4-22: сервер не принял вход — сессия аккаунта недействительна (`auth`: вышли в другой вкладке, срок истёк) или
   * героя нет у аккаунта (`forbidden`: удалён в другой вкладке). Лобби тут бессильно — его кнопки получат тот же отказ;
   * клиент уводит на вход / выбор героя. Поток перед вызовом отцеплен (`detach`). Не задан — лобби с причиной.
   */
  onRejected?: (code: 'auth' | 'forbidden', msg: string) => void;
  /**
   * ⭐ R5-15: вход состоялся (кадр `joined` — первый и КАЖДЫЙ новый после потери связи): клиент сверяет конфиг с сервером
   * (`App.syncConfig`). С L2 деплой не перезагружает страницу — без этого цены и правила оставались до деплоя.
   */
  onJoined?: () => void;
  /**
   * ⭐ R6-25: герой В МИРЕ (`true`) — с кадра `joined`; вне мира (`false`) — старт входа, потеря связи (раньше `onLost`),
   * отказ и выход из игры (`detach`). Клиенты кладут это в `App.setInWorld`: вне мира хоткеи окон и [E] у NPC молчат, а
   * смена закрывает окна. Раньше под плашкой и лобби вид героя, NPC и хоткеи жили — окна открывались под экраном входа.
   */
  inWorld?: (on: boolean) => void;
}

/** R5-15: сервер говорит на другой версии протокола (деплой без перезагрузки вкладки) — код страницы устарел. */
export const PROTOCOL_STALE = 'Сервер обновился — перезагрузите страницу (F5): часть действий в этой вкладке может не работать';

/**
 * Два самостоятельных переподключения подряд — не чаще этого, мс. Сервер (или прокси), который принимает сокет,
 * отвечает статусом и тут же закрывает снова, иначе гонял бы КАЖДОГО клиента по кругу без паузы. Вход игрока (клик)
 * счёт обнуляет: такая петля без его рук не крутится.
 */
export const AUTO_RECONNECT_GAP_MS = 5000;
/** R4-13: как часто стоящий в очереди на вход переспрашивает гейтвей, мс (потолок маршрута — 1 в секунду на аккаунт). */
export const QUEUE_POLL_MS = 3000;
/** R4-22: паузы перед повторами статуса забега, на который сервер ответил «занят», мс; кончились — лобби с кнопками. */
export const STATUS_RETRY_MS = [2000, 4000, 8000] as const;

/** ⭐ C-05: «Продолжить» не пустило — в пати забега (комната `code`) нет мест. Строка лобби, где код уже в поле. */
export function partyFullText(code: string): string {
  return `В пати забега нет мест (комната ${code}) — забег сохранён: «Войти» по коду, когда место освободится, или «Соло» — в город`;
}

type Phase = 'connecting' | 'lobby' | 'resume' | 'game';

export class EntryFlow {
  private phase: Phase = 'connecting';
  /** Почему прошлая сессия оборвалась — строкой на экранах входа, пока герой не вошёл снова. */
  private note = '';
  /** Поток жив (между `start` и `detach`): закрытие сокета после выхода из игры его не трогает. */
  private live = false;
  /** Когда поток последний раз переподключался САМ (не кнопкой). */
  private lastAuto = -Infinity;
  /** R4-13: номер подключения — ответ маршрута, пришедший к уже следующему (или после выхода), выбрасывается. */
  private dialSeq = 0;
  /** R4-13: вход кликом, который уйдёт, как только откроется сокет (к другу по коду — сперва к ноде его комнаты). */
  private openJoin: JoinOpts | null = null;
  /** R4-13: билет очереди на вход — с ним гейтвей держит место. */
  private ticket?: string;
  /** R4-13: после «wrong-node» маршрут уже спрошен заново — второй подряд без клика игрока не спрашиваем (не кружим). */
  private rerouted = false;
  /** R4-22: что спросили у открытого сокета — отказ на автоматический статус и на вход кликом разбираются по-разному. */
  private asked: 'status' | 'join' | null = null;
  /** ⭐ C-05: каким был последний вход — отказ «Продолжить» разбирается по-своему (забег ведёт другая комната). */
  private lastJoin: JoinOpts | null = null;
  /** ⭐ C-08: к ноде держателя забега уже шли после этого клика — второй отказ подряд ведёт в лобби, а не по кругу. */
  private followed = false;
  /** R4-22: сколько раз статус уже переспрошен после «занят». */
  private statusTries = 0;
  /** Отложенный шаг: переспрос очереди (R4-13) или статуса (R4-22). Один на поток, снимается любым переходом. */
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: EntryDeps) { }

  /** Причина прошлой потери связи ('' — не было или герой уже вошёл заново). */
  get lostNote(): string { return this.note; }

  /**
   * Подписаться на сокет: открылся — спросить статус забега; закрылся — `onClose`; кадры входа. Вешать ОДИН раз на
   * жизнь обработчиков сокета (2D снимает их на пере-вход в сцену `off`/`clearLifecycle` и вешает заново).
   */
  attach(): void {
    const { net, view } = this.deps;
    net.onOpen(() => {
      if (!this.live) return;
      // R4-13: к другу по коду поток подключился к ноде его комнаты — вход уходит сразу, статус забега там не нужен.
      const o = this.openJoin;
      this.openJoin = null;
      if (o) this.sendJoin(o); else this.askStatus();
    });
    net.onClose((code) => this.onClose(code));
    // Ответ на СВОЙ запрос. В игре лобби поверх мира не рисуем: его кнопки выселили бы собственную живую сессию.
    net.on('runStatus', (f) => {
      if (!this.live || this.phase === 'game') return;
      this.stopTimer();
      this.statusTries = 0;
      if (f.hasRun) this.toResume(f.roomCode ?? '', f.depth ?? 0); else this.toLobby();
    });
    net.on('abandoned', () => { if (this.live && this.phase !== 'game') this.toLobby(); });
    net.on('error', (f) => {
      if (!this.live) return;
      // В игре ошибка писалась в строку статуса снятого экрана — её не видел никто («подождите», «подойдите к
      // порталу», «вещь с чужого аккаунта изъята»). Отказ команды (`cmd`) — нет: его ждёт окно, пославшее команду.
      if (this.phase === 'game') { if (f.code !== 'cmd') this.deps.log?.(f.msg); return; }
      if (f.code === 'no-run') { this.toLobby(); return; }   // забег истёк за время раздумий
      // ⭐ C-05, C-08: «Продолжить» отказан — забег ведёт другая комната (V2): она на другой ноде (`run`) или в её пати нет мест (`full`).
      if ((f.code === 'run' || f.code === 'full') && this.asked === 'join' && this.lastJoin?.resume) { this.runHeld(f.code, f.msg, f.roomCode); return; }
      // R4-22: вход аккаунта или героя недействителен — кнопки лобби получили бы тот же отказ.
      if (f.code === 'auth' || f.code === 'forbidden') { this.rejected(f.code, f.msg); return; }
      // R4-13: герой закреплён за другой нодой — маршрут заново (гейтвей ведёт к ней). Один раз на действие игрока.
      if (f.code === 'wrong-node' && this.deps.route && !this.rerouted) {
        this.rerouted = true;
        this.note = f.msg;
        this.reconnect();
        return;
      }
      if (this.phase === 'connecting') { this.refused(f.code, f.msg); return; }
      view.setStatus(f.msg);
    });
    net.on('joined', (f) => {
      if (!this.live) return;
      this.phase = 'game';
      this.deps.inWorld?.(true);
      this.note = '';
      this.lastAuto = -Infinity;   // вошёл кликом игрока — следующая потеря связи снова переподключается сама
      this.stopTimer();
      this.asked = null;
      view.hide();
      // R5-15: вкладку не перезагружали, а сервер уже новый — конфиг перечитать; другой протокол — сказать игроку.
      if (typeof f.v === 'number' && f.v !== PROTOCOL_VERSION) this.deps.log?.(PROTOCOL_STALE);
      this.deps.onJoined?.();
    });
  }

  /** Начать вход: плашка «Подключение…»; сокет уже открыт — статус забега сразу, иначе подключиться. */
  start(): void {
    this.deps.inWorld?.(false);
    this.live = true;
    this.rerouted = false;
    this.followed = false;
    this.statusTries = 0;
    this.toConnecting();
    if (this.deps.net.connected) this.askStatus();
    else this.dial();
  }

  /** Выход из игры: поток больше ничего не показывает и не переподключает. */
  detach(): void {
    this.live = false;
    this.deps.inWorld?.(false);
    this.stopTimer();
    this.dialSeq++;   // R4-13: опоздавший ответ маршрута сокет уже не откроет
    this.openJoin = null;
    this.deps.view.hide();
  }

  /** Войти (кнопки лобби и «Продолжить»). Сокет умер, пока экран висел, — поднять связь, а не слать в пустоту. */
  join(o: JoinOpts): void {
    if (!this.live) return;
    this.rerouted = false;   // клик игрока: «wrong-node» снова вправе спросить маршрут
    this.followed = false;   // C-08: и отказ «забег в другой комнате» — снова вправе повести к держателю
    // ⭐ R4-13: комната друга живёт на ноде из ПЕРВОЙ БУКВЫ кода — туда и подключаемся, а не шлём код ноде лобби: там
    // этой комнаты нет («Комната не найдена»), а промах платит лимит адреса (R4-18).
    if (o.roomCode && this.deps.route) {
      this.deps.net.resetWorld();
      this.toConnecting();
      this.deps.view.setStatus('Подключение к комнате…');
      this.dial(o);
      return;
    }
    if (!this.deps.net.connected) { this.reconnect(); return; }
    this.deps.view.setStatus(o.resume ? 'Возврат в забег…' : 'Подключение…');
    this.sendJoin(o);
  }

  /** «Забросить прохождение»: герой гибнет со штрафом, дальше — лобби (кадр `abandoned`). */
  abandon(): void {
    if (!this.live) return;
    this.rerouted = false;
    if (!this.deps.net.connected) { this.reconnect(); return; }
    this.deps.view.setStatus('Забрасываем…');
    this.asked = null;
    this.deps.net.send({ t: 'abandon', ...this.deps.who() });
  }

  private askStatus(): void {
    this.asked = 'status';
    this.deps.net.send({ t: 'runStatus', ...this.deps.who() });
  }

  private sendJoin(o: JoinOpts): void {
    this.asked = 'join';
    this.lastJoin = o;
    this.deps.net.send({ t: 'join', ...this.deps.who(), ...o });
  }

  /**
   * ⭐ C-05, C-08: «ПРОДОЛЖИТЬ» ОТКАЗАН — ЗАБЕГ ВЕДЁТ КОМНАТА `roomCode` (V2: один забег — одна комната). Раньше отказ писался строкой на экран
   * «Продолжить / Забросить»: поля кода там нет, повтор давал тот же отказ (F5 — тот же экран), и выходом оставалось «Забросить» — штраф смерти.
   *  • `run` — комната на другой ноде: к её ноде (маршрут по коду) и там снова «Продолжить» (`join { resume }`, а не по коду: держатель мог
   *    отпустить забег, пока шли, — тогда продолжение соберёт его там же). Один раз на клик игрока: второй отказ подряд — лобби;
   *  • `full` (в её пати нет мест), второй отказ, нет маршрута или кода (одиночный процесс, старый сервер) — лобби с кодом в поле: «Войти» — к пати,
   *    когда место освободится, «Соло» — город (грейса у героя нет — вход в новую комнату забег не бросает и штрафа не берёт).
   */
  private runHeld(code: 'run' | 'full', msg: string, roomCode?: string): void {
    if (code === 'run' && roomCode && this.deps.route && !this.followed) {
      this.followed = true;
      this.deps.net.resetWorld();
      this.toConnecting();
      this.deps.view.setStatus(`Забег идёт в комнате ${roomCode} — переходим к пати…`);
      this.dial({ resume: true }, roomCode);
      return;
    }
    this.toLobby(roomCode);
    this.deps.view.setStatus(code === 'full' && roomCode ? partyFullText(roomCode) : msg);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
  }

  /**
   * ⭐ R4-13: подключиться — к ноде, которую назвал гейтвей (`route`), или по адресу по умолчанию. `o` — вход кликом:
   * уйдёт, как только сокет откроется. Очередь — место на плашке и переспрос с билетом; отказ гейтвея — лобби с причиной.
   * ⚠ `connect` — ПОСЛЕДНИМ (см. `reconnect`), и только через `open` (R10-17: бросок конструктора сокета — лобби).
   * ⭐ C-08: `via` — код комнаты только для маршрута (нода по его первой букве), сам вход — `o` («Продолжить» у ноды держателя забега).
   */
  private dial(o?: JoinOpts, via?: string): void {
    this.stopTimer();
    const seq = ++this.dialSeq;
    this.openJoin = o ?? null;
    const route = this.deps.route;
    if (!route) { this.open(); return; }
    const { token, charId } = this.deps.who();
    const fresh = (): boolean => seq === this.dialSeq && this.live;
    route(token, charId, this.ticket, o?.roomCode ?? via).then((r) => {
      if (!fresh()) return;   // поток ушёл дальше (новое подключение, выход из игры) — ответ устарел
      if ('queue' in r) {
        this.ticket = r.queue.ticket;
        this.deps.view.setStatus(`Очередь на вход: ${r.queue.position} из ${r.queue.total}`);
        this.timer = setTimeout(() => { this.timer = undefined; if (fresh()) this.dial(o, via); }, QUEUE_POLL_MS);
        return;
      }
      this.ticket = undefined;
      if ('error' in r) {
        this.openJoin = null;
        if (r.code) { this.rejected(r.code, r.error); return; }
        this.toLobby();
        this.deps.view.setStatus(r.error);
        return;
      }
      this.open(r.url);
    }, () => { if (fresh()) this.open(); });
  }

  /**
   * ⭐ R10-17: открыть сокет. Конструктор `WebSocket` бросает СИНХРОННО: страница по https и адрес `ws://` — смешанное
   * содержимое (`SecurityError`), негодный адрес — `SyntaxError`. Раньше бросок внутри ответа маршрута становился
   * необработанным отказом промиса, а игрок оставался на плашке «Подключение…» без кнопок, без таймера и без причины
   * (а без маршрута бросок уходил из `start` в код клиента). Теперь — лобби с причиной: кнопка лобби пробует снова.
   */
  private open(url?: string): void {
    try {
      this.deps.net.connect(url);
    } catch (e) {
      console.warn('[net] сокет не открылся:', url ?? '(адрес по умолчанию)', e);
      this.openJoin = null;
      this.toLobby();
      this.deps.view.setStatus('Не удалось подключиться к узлу игры');
    }
  }

  /**
   * ⭐ R4-22: сервер отказал на плашке «Подключение…» — на автоматический статус забега или на вход, ушедший с открытием
   * сокета. Кнопок на плашке нет: «занят» на статус — повтор с паузой (`STATUS_RETRY_MS`), кончились — лобби; любой
   * другой отказ — сразу лобби с причиной. Раньше причина писалась в строку плашки, и игрок оставался на ней навсегда.
   */
  private refused(code: string, msg: string): void {
    if (this.asked === 'status' && code === 'busy' && this.statusTries < STATUS_RETRY_MS.length) {
      const ms = STATUS_RETRY_MS[this.statusTries++]!;
      this.deps.view.setStatus(`${msg} · повтор через ${Math.round(ms / 1000)} с`);
      this.stopTimer();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.live && this.phase === 'connecting' && this.deps.net.connected) this.askStatus();
      }, ms);
      return;
    }
    this.toLobby();
    this.deps.view.setStatus(msg);
  }

  /** R4-22: вход аккаунта (`auth`) или героя (`forbidden`) недействителен — клиент уводит на вход / выбор героя. */
  private rejected(code: 'auth' | 'forbidden', msg: string): void {
    const exit = this.deps.onRejected;
    if (!exit) { this.toLobby(); this.deps.view.setStatus(msg); return; }
    this.detach();
    exit(code, msg);
  }

  /**
   * Сокет закрылся. До входа (плашка «Подключение…») — лобби с «Сервер недоступен», без переподключения по кругу:
   * кнопка лобби поднимет связь заново. Иначе — связь потеряна: см. шапку модуля. Сервер снова закрыл соединение
   * вскоре после того, как поток сам переподключился, а игрок никуда не входил (`AUTO_RECONNECT_GAP_MS`), — тоже лобби
   * с причиной и кнопкой, а не петля.
   */
  private onClose(code?: number): void {
    if (!this.live) return;
    this.stopTimer();
    this.asked = null;
    if (this.phase === 'connecting') {
      this.dialSeq++;   // R4-13: маршрут, ещё не ответивший, сокет уже не откроет — игрок на лобби с кнопкой
      this.openJoin = null;
      this.toLobby();
      this.deps.view.setStatus('Сервер недоступен');
      return;
    }
    this.note = netLostText(code);
    this.deps.inWorld?.(false);   // R6-25: раньше сноса мира — окна и хоткеи прошлой сессии прочь
    dismissAsk();   // R3-23: вопрос в поле («разобрать здесь?») не переживает потерю связи
    this.deps.replies?.dropAll();
    this.deps.onLost?.();
    const now = this.deps.now?.() ?? Date.now();
    if (now - this.lastAuto < AUTO_RECONNECT_GAP_MS) {
      this.toLobby();
      this.deps.view.setStatus(`${this.note} · сервер снова закрыл соединение — нажмите, чтобы подключиться`);
      return;
    }
    this.lastAuto = now;
    this.reconnect();
  }

  /**
   * Новое соединение: копия мира прошлого сокета прочь, плашка «Подключение…» (с причиной, если связь потеряна).
   * ⚠ `connect` — ПОСЛЕДНИМ: сокет может открыться и ответить статусом прямо внутри него, и плашка, показанная после,
   * легла бы поверх лобби. R4-13: адрес — заново у гейтвея (`dial`): нода могла уйти на перезапуск.
   */
  private reconnect(): void {
    this.deps.net.resetWorld();
    this.toConnecting();
    this.dial();
  }

  private toConnecting(): void {
    this.phase = 'connecting';
    this.deps.view.showConnecting();
    if (this.note) this.deps.view.setStatus(this.note);
  }

  private toLobby(roomCode?: string): void {
    this.phase = 'lobby';
    this.deps.view.showLobby((o) => this.join(o), roomCode);
    if (this.note) this.deps.view.setStatus(this.note);   // почему игрок снова здесь
  }

  private toResume(roomCode: string, depth: number): void {
    this.phase = 'resume';
    this.deps.view.showResume(roomCode, depth, { resume: () => this.join({ resume: true }), abandon: () => this.abandon() });
    if (this.note) this.deps.view.setStatus(this.note);
  }
}
