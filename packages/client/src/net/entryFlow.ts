import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '@dm/shared';
import { askInGame, dismissAsk } from '../ui/kit.js';
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
 * ⭐ R20-09: там «занят» (свод забега не дописан, взятие в пути, слив) — экран «Продолжить» у той же ноды с причиной, а не лобби без него.
 *
 * ⭐ R20-04: ИЗ МИРА — НА ЭКРАН ВХОДА. Пати не приняла просьбу продолжить общий забег — сервер отдаёт его просившему, и путь — «Продолжить» на
 * экране входа (R19-04). Меню в мире нет ни у одного клиента: подсказка (`error{solo}`) — вопрос в игре с кнопкой «Продолжить без пати» (`toEntry`).
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

/** Что входу нужно от `NetClient` — ровно это, чтобы тест подставил подделку. Подписки возвращают свою отписку (R19-02). */
export interface EntryNet {
  readonly connected: boolean;
  on<T extends ServerFrame['t']>(t: T, cb: (frame: Extract<ServerFrame, { t: T }>) => void): () => void;
  onOpen(cb: () => void): () => void;
  onClose(cb: (code?: number) => void): () => void;
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
  /**
   * «Незавершённое прохождение». ⭐ R16 C-09: `dead` — герой в этом забеге погиб, штраф взят (`runStatus.dead`): «Забросить» — без штрафа,
   * «Продолжить» — мёртвым ждать пати.
   */
  showResume(roomCode: string, depth: number, act: { resume: () => void; abandon: () => void }, dead?: boolean): void;
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

/** ⭐ R20-04: вопрос в игре на подсказку «пати не идёт» (`error{solo}`) и его кнопки. */
export const SOLO_ASK = 'Пати не идёт. Продолжить забег без неё? Вы выйдете из комнаты на экран «Продолжить / Забросить» — напарники придут к вам по коду комнаты';
export const SOLO_YES = 'Продолжить без пати';
export const SOLO_NO = 'Остаться';
/** ⭐ R20-04: строка экрана «Продолжить» после выхода кнопкой — почему игрок здесь и что сделает «Продолжить». */
export const SOLO_RESUME = 'Пати не пошла — «Продолжить» уведёт забег на его этаж без неё; напарники придут по коду комнаты';
/**
 * ⭐ R20-04: сколько кнопка «Продолжить без пати» висит, мс. Отказ пати сервер держит `RUN_ASK_MS` (60 с, `server/net/room.ts`) с того мига, как
 * сказал (R20-02): позже «Продолжить» садит к пати, и кнопка обещала бы то, чего не будет. Запас — на экран «Продолжить» и клик по нему.
 */
export const SOLO_OFFER_MS = 45_000;

/** ⭐ C-05: «Продолжить» не пустило — в пати забега (комната `code`) нет мест. Строка лобби, где код уже в поле. */
export function partyFullText(code: string): string {
  return `В пати забега нет мест (комната ${code}) — забег сохранён: «Войти» по коду, когда место освободится, или «Соло» — в город`;
}

type Phase = 'connecting' | 'lobby' | 'resume' | 'game';

export class EntryFlow {
  private phase: Phase = 'connecting';
  /** Почему прошлая сессия оборвалась — строкой на экранах входа, пока герой не вошёл снова (или не бросил забег). */
  private note = '';
  /**
   * ⭐ R16-01, R17-05: почему вход кликом отказан `run` (висит свой забег) — строкой ближайшего экрана «Продолжить / Забросить», РАЗОВО. Не `note`:
   * та живёт до входа, и лобби после «Забросить» твердило «у вас незавершённый забег», будто бросок не удался. Любой другой переход её снимает.
   */
  private hint = '';
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
  /** ⭐ R20-09: код комнаты держателя, к чьей ноде шли (`runHeld`), — в поле лобби, если и там не пустили. */
  private heldBy?: string;
  /**
   * ⭐ R20-04: вышли из комнаты по ЖИВОМУ сокету (`toEntry`). Кадры комнаты, посланные до того, как сервер разобрал `leave` (снапшоты,
   * голосование, смерть, смена области), ещё в пути и рисуют следы прошлой сессии поверх экрана входа; ответ на статус забега сервер шлёт после
   * выхода — с ним (и с любым ответом лобби) следы сносятся ещё раз.
   */
  private leaving = false;
  /** ⭐ R20-04: номер открытого вопроса «Продолжить без пати» (0 — нет) и его срок (`SOLO_OFFER_MS`). */
  private soloAsk = 0;
  private soloSeq = 0;
  private soloTimer?: ReturnType<typeof setTimeout>;
  /** R4-22: сколько раз статус уже переспрошен после «занят». */
  private statusTries = 0;
  /** Отложенный шаг: переспрос очереди (R4-13) или статуса (R4-22). Один на поток, снимается любым переходом. */
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: EntryDeps) { }

  /** Причина прошлой потери связи ('' — не было или герой уже вошёл заново). */
  get lostNote(): string { return this.note; }

  /**
   * Подписаться на сокет: открылся — спросить статус забега; закрылся — `onClose`; кадры входа. Вешать ОДИН раз на
   * жизнь потока. ⭐ R19-02: возвращает отписку — ровно этих подписок (2D снимает их на выходе из сцены и вешает новый поток
   * на новый вход). Раньше сцена снимала обработчики кадров оптом (`NetClient.off`) — и подписки `App` вместе с ними.
   */
  attach(): () => void {
    const { net, view } = this.deps;
    const offs: (() => void)[] = [];
    offs.push(net.onOpen(() => {
      if (!this.live) return;
      // R4-13: к другу по коду поток подключился к ноде его комнаты — вход уходит сразу, статус забега там не нужен.
      const o = this.openJoin;
      this.openJoin = null;
      if (o) this.sendJoin(o); else this.askStatus();
    }));
    offs.push(net.onClose((code) => this.onClose(code)));
    // Ответ на СВОЙ запрос. В игре лобби поверх мира не рисуем: его кнопки выселили бы собственную живую сессию.
    offs.push(net.on('runStatus', (f) => {
      if (!this.live || this.phase === 'game') return;
      this.swept(true);   // ⭐ R20-04: ответ после выхода из комнаты — её кадров в пути больше нет
      this.stopTimer();
      this.statusTries = 0;
      if (f.hasRun) this.toResume(f.roomCode ?? '', f.depth ?? 0, f.dead === true); else this.toLobby();
    }));
    // ⭐ R17-05: забег брошен — причина прошлой потери связи устарела: лобби — после броска, а не «после обрыва».
    offs.push(net.on('abandoned', () => { if (this.live && this.phase !== 'game') { this.note = ''; this.toLobby(); } }));
    offs.push(net.on('error', (f) => {
      if (!this.live) return;
      // В игре ошибка писалась в строку статуса снятого экрана — её не видел никто («подождите», «подойдите к
      // порталу», «вещь с чужого аккаунта изъята»). Отказ команды (`cmd`) — нет: его ждёт окно, пославшее команду.
      // ⭐ R20-04: подсказка «пати не идёт» (`solo`) — и кнопка «Продолжить без пати»: из мира на экран входа иначе не выйти.
      if (this.phase === 'game') { if (f.code !== 'cmd') this.deps.log?.(f.msg); if (f.solo === true) this.offerSolo(); return; }
      // ⭐ R20-04: отказ команды, посланной до выхода из комнаты, — ответ окну, которого уже нет, а не статусу забега (лобби им не отвечает).
      if (this.leaving && f.code === 'cmd') return;
      this.swept(false);   // ⭐ R20-04: отказ комнаты, посланный до выхода, или ответ лобби — следы комнаты прочь (флаг снимает ответ на статус)
      if (f.code === 'no-run') { this.toLobby(); return; }   // забег истёк за время раздумий
      // ⭐ C-05, C-08: «Продолжить» отказан — забег ведёт другая комната (V2): она на другой ноде (`run`) или в её пати нет мест (`full`).
      if ((f.code === 'run' || f.code === 'full') && this.asked === 'join' && this.lastJoin?.resume) { this.runHeld(f.code, f.msg, f.roomCode); return; }
      // ⭐ R16-01: «Соло»/«Создать» отказан `run` — у героя висит забег, чей бросок стоил бы штрафа (вход его больше не бросает молча), а лобби
      // этого не знало (забег появился, пока оно висело: вторая вкладка ушла в подземелье). Статус забега заново — экран «Продолжить / Забросить»
      // с причиной, а не строка «продолжите или завершите» в лобби без таких кнопок.
      // ⭐ R17-05: и ВХОД ПО КОДУ — тот же отказ без кода комнаты в кадре (грейс держит забег за штраф — `RUN_PARKED_JOIN`; комната кода в
      // подземелье чужого забега, а у героя свой — `RUN_CLASH_JOIN`). Условие — по кадру (`f.roomCode`), а не по входу: отказ «Продолжить» с кодом
      // держателя — ветка C-05/C-08 выше. Причина — разовой строкой экрана «Продолжить» (`hint`), а не `note`, что лобби повторяло до входа.
      if (f.code === 'run' && this.asked === 'join' && this.lastJoin && !this.lastJoin.resume && !f.roomCode) {
        this.hint = f.msg;
        this.askStatus();
        return;
      }
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
    }));
    offs.push(net.on('joined', (f) => {
      if (!this.live) return;
      this.phase = 'game';
      this.leaving = false;   // R20-04: без сноса — мир новой комнаты сцена уже строит (её обработчик `joined` — раньше этого)
      this.deps.inWorld?.(true);
      this.note = '';
      this.hint = '';
      this.lastAuto = -Infinity;   // вошёл кликом игрока — следующая потеря связи снова переподключается сама
      this.stopTimer();
      this.asked = null;
      view.hide();
      // R5-15: вкладку не перезагружали, а сервер уже новый — конфиг перечитать; другой протокол — сказать игроку.
      if (typeof f.v === 'number' && f.v !== PROTOCOL_VERSION) this.deps.log?.(PROTOCOL_STALE);
      this.deps.onJoined?.();
    }));
    return () => { for (const off of offs.splice(0)) off(); };
  }

  /** Начать вход: плашка «Подключение…»; сокет уже открыт — статус забега сразу, иначе подключиться. */
  start(): void {
    this.deps.inWorld?.(false);
    this.live = true;
    this.rerouted = false;
    this.followed = false;
    this.leaving = false;
    this.statusTries = 0;
    this.hint = '';
    this.toConnecting();
    if (this.deps.net.connected) this.askStatus();
    else this.dial();
  }

  /** Выход из игры: поток больше ничего не показывает и не переподключает. */
  detach(): void {
    this.live = false;
    this.deps.inWorld?.(false);
    this.stopTimer();
    this.stopSolo();   // R20-04: кнопка «Продолжить без пати» не переживает выход из игры
    this.leaving = false;
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

  /** «Забросить прохождение»: герой гибнет со штрафом (погибший в этом забеге — без второго, R16 C-09), дальше — лобби (кадр `abandoned`). */
  abandon(): void {
    if (!this.live) return;
    this.rerouted = false;
    if (!this.deps.net.connected) { this.reconnect(); return; }
    this.deps.view.setStatus('Забрасываем…');
    this.asked = null;
    this.deps.net.send({ t: 'abandon', ...this.deps.who() });
  }

  /**
   * ⭐ R20-04: ИЗ МИРА — НА ЭКРАН ВХОДА, НЕ РВЯ СВЯЗИ (кнопка «Продолжить без пати»). Пати не приняла просьбу продолжить общий забег («нет»
   * напарника или молчание `RUN_ASK_MS`) — забег отдан просившему, и путь к нему — «Продолжить» (R19-04). Подсказка звала «в меню входа», а в
   * мире меню нет ни у одного клиента и кадр `leave` не слал никто: повтор спуска снова ждал напарника, выходом оставалась перезагрузка.
   * Теперь — `leave` по живому сокету (комната отпускает героя, как на закрытии), мир и окна прошлой комнаты прочь, как при потере связи, и
   * статус забега тем же сокетом: экран «Продолжить / Забросить» с причиной, «Продолжить» — забег на его этаж (сервер: `runRefused`).
   * ⚠ Сокет и нода — те же: переподключение увело бы к гейтвею, а там, может быть, к другой ноде и снова к держателю (C-08).
   */
  toEntry(): void {
    if (!this.live || this.phase !== 'game') return;
    this.stopSolo();
    this.deps.inWorld?.(false);   // R6-25: раньше сноса мира — окна и хоткеи прошлой комнаты прочь
    dismissAsk();
    this.deps.onLost?.();
    this.deps.net.resetWorld();
    this.rerouted = false;
    this.followed = false;
    this.statusTries = 0;
    this.hint = SOLO_RESUME;   // строка ближайшего экрана «Продолжить» — разово (R17-05)
    if (!this.deps.net.connected) {   // сокет закрывается, а закрытие ещё не пришло: ответов по нему не будет
      this.deps.replies?.dropAll();
      this.reconnect();
      return;
    }
    // Ответы на команды, посланные до выхода, придут до него (сервер разбирает кадры соединения по очереди) — ждущих не отпускаем.
    this.deps.net.send({ t: 'leave' });
    this.leaving = true;
    this.toConnecting();
    this.askStatus();
  }

  /**
   * ⭐ R20-04: вопрос в игре «Продолжить без пати» на подсказку `error{solo}`. Сам поток никуда не уходит — только кнопкой. Новая подсказка —
   * новый вопрос и новый срок; срок `SOLO_OFFER_MS` снимает только СВОЙ вопрос (сменивший его чужой не трогает): позже отказ пати на сервере
   * истёк, и «Продолжить» посадило бы к пати.
   */
  private offerSolo(): void {
    const id = ++this.soloSeq;
    this.soloAsk = id;
    if (this.soloTimer !== undefined) clearTimeout(this.soloTimer);
    this.soloTimer = setTimeout(() => { this.soloTimer = undefined; if (this.soloAsk === id) dismissAsk(); }, SOLO_OFFER_MS);
    void askInGame(SOLO_ASK, { yes: SOLO_YES, no: SOLO_NO }).then((yes) => {
      if (this.soloAsk !== id) return;   // сменён следующей подсказкой
      this.soloAsk = 0;
      if (this.soloTimer !== undefined) { clearTimeout(this.soloTimer); this.soloTimer = undefined; }
      if (yes) this.toEntry();
    });
  }

  /** ⭐ R20-04: снять кнопку «Продолжить без пати» (выход из игры, уход на экран входа): срок — прочь, вопрос открыт — «нет». */
  private stopSolo(): void {
    if (this.soloTimer !== undefined) { clearTimeout(this.soloTimer); this.soloTimer = undefined; }
    if (this.soloAsk) { this.soloAsk = 0; dismissAsk(); }
  }

  /**
   * ⭐ R20-04: после выхода из комнаты по живому сокету (`leaving`) — ответ лобби: следы кадров комнаты, пришедших до него (окно голосования,
   * смерти, мир), прочь ещё раз. `done` — это ответ на статус забега (сервер шлёт его после выхода): кадров комнаты за ним нет, флаг снят.
   */
  private swept(done: boolean): void {
    if (!this.leaving) return;
    if (done) this.leaving = false;
    dismissAsk();
    this.deps.net.resetWorld();
    this.deps.onLost?.();
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
      this.heldBy = roomCode;
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
   * ⭐ R20-09: «Продолжить» у ноды держателя забега (переход C-08 — единственный вход `resume`, что уходит с плашки) ответили «занят» (свод забега
   * не дописан, взятие в пути, слив, нода полна — с R18-02 это «повторите»): статус забега у ТОЙ ЖЕ ноды и экран «Продолжить» с причиной — сам
   * не входит (вход — только кликом). Раньше — лобби без «Продолжить» и без кода: к забегу вели «Соло», отказ `run` и новый статус. Иной отказ
   * там — лобби с кодом держателя в поле («Войти» — к пати).
   */
  private refused(code: string, msg: string): void {
    const resumed = this.asked === 'join' && this.lastJoin?.resume === true;
    if (resumed && code === 'busy') {
      this.hint = msg;
      this.deps.view.setStatus(msg);
      this.askStatus();
      return;
    }
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
    this.toLobby(resumed && this.followed ? this.heldBy : undefined);
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
    this.swept(true);   // R20-04: вышли из комнаты, а ответа не дождались — следы её кадров прочь
    this.asked = null;
    this.hint = '';   // R17-05: отказ, к которому она, — ответ мёртвого сокета; экран «Продолжить» после — со своей причиной
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
    this.hint = '';   // R17-05: «продолжите или завершите» — строка экрана с такими кнопками, не лобби
    this.deps.view.showLobby((o) => this.join(o), roomCode);
    if (this.note) this.deps.view.setStatus(this.note);   // почему игрок снова здесь
  }

  private toResume(roomCode: string, depth: number, dead: boolean): void {
    this.phase = 'resume';
    const why = this.hint || this.note;   // R17-05: причина отказа входа — разово, свежее причины потери связи
    this.hint = '';
    this.deps.view.showResume(roomCode, depth, { resume: () => this.join({ resume: true }), abandon: () => this.abandon() }, dead);
    if (why) this.deps.view.setStatus(why);
  }
}
