import type { CraftParts, Item } from '../types/items.js';
import type { QuestDef } from '../types/quest.js';
import type { DamageType } from '../types/combat.js';
import type { DropPayload, ScaledMonster } from '../types/world.js';
import type { SaveState } from '../types/save.js';
import type { DebuffState } from '../world/debuffs.js';
import type { Grid } from '../world/grid.js';
import type { DecorObject } from '../dungeon/floorCommon.js';
import type { RunPlan } from '../dungeon/run/types.js';
import type { CraftInput, CraftJournal } from '../formulas/craft.js';
import type { HeroCooldowns, PlayerInput, SessionEvent } from './session.js';
import type { WorldDelta } from './delta.js';

/**
 * Сетевой протокол кооп-сервера (MP-2). Кадры JSON, авторитет — сервер: клиент шлёт
 * ввод/команды, получает снапшоты мира + события + свой авторитетный сейв. View-типы
 * несут ТОЛЬКО изменяемые поля сущностей (без тяжёлого `save`), грид/декор — один раз
 * при входе в область (`FloorInit`). Общие типы для клиента и сервера.
 */

/** Версия протокола (несовместимые правки — инкремент). */
export const PROTOCOL_VERSION = 1;

// ── View-типы (то, что едет в снапшоте, по id) ──────────────────────────────
/**
 * ДИНАМИКА игрока — то, что действительно меняется от кадра к кадру. Ф1.1: статика (имя,
 * класс, максимум HP, радиус, ключ оружия, модели брони) отсюда УБРАНА и едет отдельным
 * кадром `peerInfo` — она менялась раз в сессию, а платили за неё каждый кадр каждому.
 * Заодно ушёл линейный поиск по базам предметов, который делался на каждого игрока каждый тик.
 */
export interface PlayerView {
  id: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  mana: number;
  stamina: number;
  alive: boolean;
  debuffs: DebuffState;
  toggles: string[];
  /**
   * «В бою» (боевой айдл): своя атака ИЛИ на игрока целится монстр. Клиент → боевая стойка.
   *
   * Поле ОБЯЗАТЕЛЬНОЕ, и это важно для дельт (Ф1.3): `undefined` не переживает JSON, поэтому
   * «флаг погас» через отсутствие ключа не передаётся — клиент навсегда остался бы в бою.
   * Проверено стендом: 594 расхождения из 602 сверок, пока поле было опциональным.
   */
  inCombat: boolean;
  /**
   * Оглушён (`stunTimer > 0`): ввод не проходит, кукле нужна реакция-стаггер.
   *
   * У монстров такое поле было с самого начала, у игрока — нет, поэтому СВОЙ стан анимация не видела
   * вовсе. Поле ОБЯЗАТЕЛЬНОЕ по той же причине, что и `inCombat`: `undefined` не переживает JSON,
   * и «флаг погас» через отсутствие ключа до клиента не дойдёт — он навсегда остался бы оглушённым.
   */
  stun: boolean;
}

/**
 * СТАТИКА игрока (Ф1.1). Шлётся при входе (`joined.peers`, `peerJoined`) и при изменении
 * (`peerInfo`) — то есть на экипировку, уровень и смену области, а не каждый кадр.
 */
export interface PeerInfo {
  id: string;
  classId: string;
  /** Имя персонажа — для неймплейта пира. */
  name: string;
  /** Максимум HP — для полоски здоровья пира. */
  maxHp: number;
  /** Радиус коллизии (debug-draw и попадания на клиенте). */
  r: number;
  /** 3D-ключ экипированного оружия (меш + адаптация поз). Нет оружия — клиент берёт класс-дефолт. */
  weaponKey?: string;
  /** Внешность брони по слотам (C7): slot→modelId. Пусто — базы слотов. */
  armorModels?: Record<string, string>;
  /**
   * ИЗ ЧЕГО СДЕЛАНО ОРУЖИЕ В РУКАХ (D22, К6): база и четыре детали по рукам — ровно то, из чего клиент
   * собирает модель (`craftMesh`), и НИЧЕГО больше из предмета (ни статов, ни аффиксов, ни uid). Нет руки —
   * клиент рисует процедурный меш по `weaponKey`, как раньше. Собирает `weaponLookOf` (`session/weapon3d.ts`).
   */
  weaponLook?: WeaponLook;
}

/** Одна рука (D22): база и детали. Руки те же, что у `weaponKey`: `main` — главная, `off` — второе оружие. */
export interface WeaponLookHand {
  baseId: string;
  parts: CraftParts;
}
export interface WeaponLook {
  main?: WeaponLookHand;
  off?: WeaponLookHand;
}

/** Игрок глазами клиента: динамика из снапшота, слитая со статикой из реестра пиров. */
export type PlayerViewFull = PlayerView & PeerInfo;
export interface MonsterView {
  id: number;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  stun: boolean;
  /** Сбит с ног (нокдаун): лежит/встаёт, беспомощен. Клиент → рагдолл-падение + подъём. */
  downed: boolean;
  debuffs: DebuffState;
  /** Радиус коллизии (debug-draw). */
  r: number;
  /** Состояние ИИ (debug-draw: покой/погоня). */
  aiState: 'idle' | 'chase';
}
export interface ProjView {
  id: number;
  x: number;
  y: number;
  owner: 'player' | 'monster';
  /** Доминирующая стихия пакета — для цвета вида. */
  dom: DamageType;
  /** Радиус коллизии (debug-draw). */
  r: number;
}
export type DropView = { id: number; x: number; y: number } & DropPayload;


/** Область комнаты и её геометрия (шлётся один раз при входе). */
export interface FloorInit {
  area: 'town' | 'dungeon';
  depth: number;
  /** id биома этажа (v2 забег) — клиент выбирает по нему набор окружения (config `environment`). Город — не задан. */
  biomeId?: string;
  grid: Grid;
  spawn: { x: number; y: number };
  stairs?: { x: number; y: number };
  /** Все выходы на следующие этажи (v2 развилка). exits[0] совместим со `stairs`. */
  exits?: { x: number; y: number }[];
  /** id текущего узла забега (v2) и его роль/тип — для карты и рендера. */
  runNodeId?: string;
  runNodeType?: string;
  /** id активных модификаторов этажа (v2). */
  floorModifiers?: string[];
  /**
   * ⭐ R8-10: тир сложности и УРОВЕНЬ ВЫЗОВА узла — ровно то, по чему сервер его заселил (`floorChallengeLevel` от мощи
   * узла). Клиент показывает их в строке «этаж · тир · вызов ур.»: своей мерой он не знает ни снаряжения напарников, ни
   * мощи, с которой узел заселили раньше. Только в подземелье; нет поля (старый сервер) — клиент считает сам, как прежде.
   */
  difficultyId?: string;
  challengeLevel?: number;
  decor: DecorObject[];
  /** Запертые ворота (клетки грида) — для рендера/открытия по `doorOpened`. */
  doors: { id: number; cells: { cx: number; cy: number }[] }[];
  /** Рычаги (мировые координаты) — спрайт + интерактив «[E] Рычаг», открывает свою дверь. */
  levers: { id: number; x: number; y: number; doorId: number }[];
  /** Сундуки этажа: id, где стоит и какого тира (цвет меша). Открытые не шлём. */
  chests: { id: number; x: number; y: number; tier: string }[];
}

/** Снапшот, слитый со статикой пиров — то, с чем работает клиент (Ф1.1). */
export interface WorldSnapshotFull extends Omit<WorldSnapshot, 'players'> {
  players: PlayerViewFull[];
}

/** Полный снапшот мира за тик. */
export interface WorldSnapshot {
  tick: number;
  players: PlayerView[];
  monsters: MonsterView[];
  projectiles: ProjView[];
  drops: DropView[];
}

// ── Команды города (авторитетно исполняет сервер) ───────────────────────────
// ⭐ R5-15: `maxGold` у платных команд — цена в золоте, которую показала игроку карточка. Сервер берёт по СВОЕМУ конфигу
// и при цене выше показанной отказывает до траты («Цена изменилась: N золота», `priceRaised`). Нет поля — как раньше.
// R6-16: и у покупки в лавке, и у узла мастерства; у продажи — `minGold`: лавка даёт меньше показанного — отказ.
// ⭐ R8-14: и сырьё — `maxMaterials` (ковка, улучшение, починка: больше показанного — отказ), и выход разбора — `minYield`
// (нижняя граница вилки «от–до»: меньше — отказ, вещь цела). id материала → число; нет поля — как раньше.
// R9-04: у разборов ещё `avgYield` — средний выход карточки (`salvageMean`): низ дробной доли — 0 при любой правке выхода.
// ⭐ V-B3-07: у команд кузницы, скупки и разбора (`CONFIG_CONSENT_CMDS`) — `cfgRev`, ревизия конфига, с которого нарисовано окно
// (`ConfigRegistry.revision`): у сервера другая — отказ «Цена изменилась» до исполнения, клиент перечитывает конфиг. Нет поля — как раньше.
// ⭐ D3: и `build` — штамп сборки вкладки (согласие на КОД, `buildChanged`): у сервера другой — тот же отказ до исполнения. Нет поля — как раньше.
export type TownCommand =
  | { cmd: 'buy'; uid: string; maxGold?: number }
  | { cmd: 'sell'; uid: string; minGold?: number; cfgRev?: string; build?: string }
  | { cmd: 'forgeUpgrade'; uid: string; maxGold?: number; maxMaterials?: Record<string, number>; cfgRev?: string; build?: string }
  | { cmd: 'forgeReroll'; uid: string; maxGold?: number; cfgRev?: string; build?: string }
  /** Починка сломанного трофея: снимает флаг за золото и материалы. */
  | { cmd: 'forgeRepair'; uid: string; maxGold?: number; maxMaterials?: Record<string, number>; cfgRev?: string; build?: string }
  /** Сдать всё сырьё из сумки в общий сундук аккаунта. */
  | { cmd: 'depositMaterials' }
  /** Разбор у кузнеца: полный выход материалов; найденное оружие открывает журнал кузнеца (§12). */
  | { cmd: 'forgeSalvage'; uid: string; minYield?: Record<string, number>; avgYield?: Record<string, number>; cfgRev?: string; build?: string }
  /**
   * ⭐ Сковать оружие из деталей (docs/CRAFT_WEAPONS.md). `nonce` — ключ идемпотентности заявки (D4):
   * придумывает клиент, сервер помнит его на АККАУНТЕ вместе с вещью. Повтор того же ключа — даже
   * после реконнекта или на другой ноде — отвечает прежней вещью, а не кует вторую. Заявка — только
   * `{id, step}` четырёх гнёзд, хват и доводка: базу, имя, ступень и цену сервер выводит сам.
   */
  | { cmd: 'craft'; nonce: string; input: CraftInput; maxGold?: number; maxMaterials?: Record<string, number>; cfgRev?: string; build?: string }
  /** Зачаровать СКОВАННУЮ обычную вещь из сумки до магической или редкой — за золото (§13). */
  | { cmd: 'forgeEnchant'; uid: string; rarity: 'magic' | 'rare'; maxGold?: number; cfgRev?: string; build?: string }
  /**
   * Потратить эскиз (жалость разбора, §12): открыть в журнале аккаунта выбранную деталь `variantId`. Ключевую форму
   * НЕОТКРЫТОГО типа эскиз не открывает (`sketchable`). R3-11: раньше эскизы копились, а потратить их было нечем.
   */
  | { cmd: 'forgeSketch'; variantId: string; cfgRev?: string; build?: string }
  /** Разбор на месте, в подземелье: выход `balance.salvage.fieldYield`. */
  | { cmd: 'salvage'; uid: string; minYield?: Record<string, number>; avgYield?: Record<string, number>; cfgRev?: string; build?: string }
  /**
   * Надеть вещь из сумки. `slot` нет — в родной слот вещи; `'offhand'` — во вторую руку (R11-02: пупсик, брошено на ячейку
   * «Левая рука»; так одноручное оружие встаёт вторым — дуал-вилд). Можно ли — решает ядро (`equip`, `offhandRefusal`).
   */
  | { cmd: 'equip'; uid: string; slot?: 'offhand' }
  | { cmd: 'unequip'; slot: string }
  /** Вложить `n` очков в атрибут (нет — одно). Пачка очков — одна команда, а не `n` кадров (R2-15). */
  | { cmd: 'allocAttr'; attr: string; n?: number }
  | { cmd: 'respec'; maxGold?: number }
  | { cmd: 'respecPassives'; maxGold?: number }
  | { cmd: 'respecSkills'; maxGold?: number }
  | { cmd: 'allocPassive'; nodeId: string; maxGold?: number }
  | { cmd: 'allocSkill'; nodeId: string }
  // Гнёзда модульных скилов: вставить/вынуть. Слот — индекс гнезда, открытость считает сервер по рангу.
  | { cmd: 'socketInsert'; nodeId: string; slot: number; insertId: string }
  | { cmd: 'socketClear'; nodeId: string; slot: number }
  | { cmd: 'useConsumable'; uid: string }
  | { cmd: 'moveBelt'; uid: string }
  | { cmd: 'moveItem'; uid: string; x: number; y: number }
  // Общий (на аккаунт) городской сундук: запрос текущего слепка и перекладка предмета
  // инвентарь↔вкладка/внутри вкладки (dst: 'inv' — в инвентарь, число — индекс вкладки).
  | { cmd: 'stashOpen' }
  | { cmd: 'stashMove'; uid: string; dst: 'inv' | number; x: number; y: number }
  | { cmd: 'bind'; slot: number; value: string | null }
  | { cmd: 'pickup'; dropId: number }
  | { cmd: 'drop'; uid: string }
  /** `replace` (R6-13): игрок согласился, что начатое задание того же вида доски пропадёт. Без него начатое держит место. */
  | { cmd: 'acceptQuest'; questId: string; replace?: true }
  | { cmd: 'turnInQuest'; questId: string };

// ── Кадры клиент → сервер ───────────────────────────────────────────────────
export type ClientFrame =
  // Клиент аутентифицируется токеном сессии + charId. Сервер проверяет ВЛАДЕНИЕ персонажем и
  // грузит его сейв из БД (создание персонажа — по HTTP, см. `/api/characters`). Анти-чит.
  // fresh — осознанно новая комната (соло/хост); resume — вернуться в незавершённый забег
  // (грейс-комната из подземелья); roomCode — вход к другу. Реконнект — только явным resume.
  // ⭐ D1: solo (с resume) — «Продолжить без пати»: голос за продолжение забега в комнате, что его держит вне подземелья, не прошёл (кадр
  // `error{code:'vote', solo:true}`) — держатель забег отпускает, герой продолжает его в своей комнате (docs/MULTIPLAYER.md, правило общего забега).
  | { t: 'join'; roomCode?: string; token: string; charId: string; fresh?: boolean; resume?: boolean; solo?: boolean }
  // Есть ли у персонажа незавершённый забег (грейс-комната)? Ответ решает: модалка «Продолжить/
  // Забросить» или обычное лобби. Комнату не создаёт.
  | { t: 'runStatus'; token: string; charId: string }
  // Забросить незавершённый забег: персонаж считается погибшим (штраф смерти), грейс-комната чистится.
  | { t: 'abandon'; token: string; charId: string }
  | { t: 'input'; seq: number; input: PlayerInput }
  // `id` — номер команды (Ф2.5). Клиент нумерует, сервер пропускает повтор уже выполненной:
  // при обрыве связи честный клиент повторяет последнюю команду, а повтор «купить» — это
  // лишняя вещь за лишнее золото. Поле необязательное: старые вкладки продолжают работать.
  | { t: 'cmd'; command: TownCommand; id?: number }
  // Спуск: из города — старт забега (difficultyId=тир; runConfig=выбор алтаря: биом/шаблон/модификаторы);
  // в подземелье — спуск по ребру графа (targetNodeId).
  | { t: 'descend'; difficultyId?: string; targetNodeId?: string; runConfig?: { biomeId?: string; templateId?: string; modifiers?: string[] } }
  // Вход в PvP-арену из города (через алтарь) — голосование, затем круглый зал с уроном игрок↔игрок.
  | { t: 'arena' }
  | { t: 'return' }
  | { t: 'lever'; leverId: number }
  | { t: 'chest'; chestId: number }
  | { t: 'vote'; accept: boolean }
  | { t: 'leave' }
  // Замер задержки: клиент шлёт ping с id, сервер сразу эхо-pong тем же id → клиент считает RTT.
  // Бонусом — keepalive (не даёт прокси уронить простаивающее соединение).
  | { t: 'ping'; id: number };

// ── Кадры сервер → клиент ───────────────────────────────────────────────────
export type ServerFrame =
  // ⭐ D3: РУКОПОЖАТИЕ ВЕРСИЙ — на каждом входе: `v` — версия протокола, `build` — штамп сборки сервера (`buildStampOf` исходников shared, концы
  // строк не в счёт), `cfgRev` — ревизия конфига комнаты (с ней сверяется согласие команд кузницы и лавки). Веб-клиент сверяет их ОДИН раз на вход
  // в одном месте (`client/net/versionGate.ts`): код не тот — «перезагрузите», ревизия не та — перечитать конфиг. Нет поля — сервер старше его.
  // ⭐ R21-05: `cooldowns` — откаты умений, с которыми сервер посадил героя (реконнект R4-06, другая комната D4 — из `vitals.cd`, вторая вкладка):
  // ключ — как у события `cooldown`/`swing` (узел скила; `ins:<вставка>` — печать), `leftMs` — остаток, `fullMs` — полный откат (заливка слота).
  // Событие каста о них не придёт — без поля новая страница рисовала слот готовым, а каст сервер молча отбрасывал. Нет откатов — поля нет.
  | { t: 'joined'; v: number; playerId: string; roomCode: string; floor: FloorInit; peers: PeerInfo[]; save: SaveState; build?: string; cfgRev?: string; cooldowns?: HeroCooldowns }
  // Ответ на runStatus: есть ли незавершённый забег (+ код комнаты и этаж для модалки).
  // ⭐ R16 C-09: `dead` — герой в этом забеге погиб и штраф за смерть взят: «Завершить» — без штрафа (V1), «Продолжить» — мёртвым ждать пати
  // (K1). Нет поля — сервер старше его: экран говорит, как раньше.
  | { t: 'runStatus'; hasRun: boolean; roomCode?: string; depth?: number; dead?: boolean }
  // Подтверждение abandon: забег заброшен (персонаж погиб со штрафом) — клиент открывает лобби.
  | { t: 'abandoned' }
  // ⚠ R16-05: ТЕКСТОМ сервер этот кадр шлёт только под отладочным `DM_WIRE_VERIFY=1`. С Ф1.4 мир уходит ДВОИЧНЫМ кадром
  // (`wire.ts`: полный, дальше дельты), и веб-клиент (`NetClient`) отдаёт сцене собранный мир в этом же виде. Чужой клиент,
  // читающий мир только отсюда, мира не видит (Unity — docs/CRAFT_WEAPONS.md §21.1, К8; эталон `client/net/__golden__/unity_wire.json`).
  | { t: 'snapshot'; snap: WorldSnapshot }
  // Ф1.3: дельта к прошлому кадру. Первый кадр клиента ВСЕГДА полный, дальше идут дельты;
  // WebSocket поверх TCP гарантирует порядок и доставку, поэтому подтверждений не нужно.
  // С Ф1.4 текстом не ходит вовсе: дельта едет в двоичном кадре (`WIRE_DELTA`).
  | { t: 'snapDelta'; delta: WorldDelta; sum: number }
  | { t: 'events'; events: SessionEvent[] }
  | { t: 'saveUpdate'; save: SaveState }
  /**
   * Прилавок. `prices` — АВТОРИТЕТНАЯ цена покупки каждой вещи (uid → `shopBuyPrice`, ровно то, что спишет `buy`):
   * веб считает её той же функцией `@dm/shared`, а Unity-клиенту своей копии формулы (надбавка ступени, пол по
   * сырью разбора) не держать — она уже разъехалась с сервером однажды (R2-36).
   */
  | { t: 'shop'; items: Item[]; prices: Record<string, number> }
  // Полный слепок общего сундука (шлётся на входе, на stashOpen и после каждой транзакции над аккаунтом).
  /**
   * `materials` — сырьё АККАУНТА (общее для всех героев), не вкладка: это счётчики, не предметы.
   * `forgeJournal` — журнал кузнеца аккаунта (§12): по нему окно ковки решает, что открыто. Это журнал,
   * которым сервер ГЕЙТИТ ковку, — с флагом разработчика `DM_CRAFT_FULL_JOURNAL` ворота в нём открыты
   * (только вне продакшена: при `NODE_ENV=production` сервер флаг игнорирует).
   * Ключи заявок на ковку (`craftNonces`) клиенту не шлются: ему они ни к чему.
   */
  | { t: 'stash'; tabs: Item[][]; cols: number; rows: number; tabCount: number; materials: Record<string, number>; forgeJournal: CraftJournal }
  | { t: 'questBoard'; quests: QuestDef[] }
  | { t: 'peerJoined'; peer: PeerInfo }
  // Ф1.1: обновление СТАТИКИ игроков — экипировка, уровень, смена области.
  | { t: 'peerInfo'; peers: PeerInfo[] }
  /**
   * Ф1.2: определения монстров, ВОШЕДШИХ в поле зрения этого клиента. Раньше весь список
   * этажа приезжал в `FloorInit` — это и лишний килобайт на входе, и готовый maphack:
   * клиент знал про всех монстров карты, включая тех, кого не видит.
   */
  | { t: 'monsterInfo'; monsters: { id: number; def: ScaledMonster; x: number; y: number }[] }
  | { t: 'peerLeft'; id: string }
  | { t: 'areaChanged'; floor: FloorInit }
  // Структура текущего забега (v2) — данные для панели-карты (граф узлов, «видно вперёд»).
  | { t: 'runPlan'; plan: RunPlan; currentNodeId: string }
  | { t: 'doorOpened'; doorId: number }
  // Смерть игрока: потери + режим возрождения (город=соло/вайп, иначе ждать пати на след. этаже).
  // pvp=true — гибель в PvP-арене: без штрафа, авто-возрождение через пару секунд (клиент → иной текст).
  // ⭐ R13-05: status=true — НЕ новая смерть, а новый режим окна той же (живых в пати не осталось — «в город», вернулся живой — «ждите»;
  // вернулся в комнату мёртвым). Потерь в нём нет (0/0): клиент берёт их из кадра самой смерти, закрытое «Смотреть» окно не открывает
  // (а без окна — после входа — открывает без строки потерь). canLeave=true — живых подключённых нет, пати ждёт отвалившегося посреди
  // боя: мёртвый может увести её в город сам (`return`; сбежавших из боя это хоронит, R4-14).
  | { t: 'died'; goldLost: number; itemsLost: number; toTown: boolean; pvp?: boolean; status?: boolean; canLeave?: boolean }
  /**
   * Голосование за переход. ⭐ R9-08: СПУСК ИЗ ГОРОДА — С ТЕМ, ЧТО НАЧНЁТСЯ: тир (`difficultyId`), шаблон, биом и модификаторы
   * забега, а `resume` — продолжение припаркованного забега героя `host` с глубины `depth` (тир и прочее тогда — его забега).
   * Раньше окно знало только «спуск»: принявший входил в тир, которого не открывал и не выбирал. Начнётся ровно показанное:
   * сменилось, пока голосовали (вошёл хозяин другого забега), — голосование отменяется (`error` с кодом `vote`).
   * ⭐ R16-04: В ПОДЗЕМЕЛЬЕ — КУДА ВЕДЁТ: спуск по ребру несёт узел цели (`targetNodeId`) и его тип (`targetNodeType` — ветку
   * развилки, которую выбрал зовущий), а голосование финала (узел без рёбер) — `finish`: принятое ЗАВЕРШАЕТ забег (в город).
   * Раньше окно напарника и там спрашивало «Спуск на след. этаж?».
   */
  | {
    t: 'voteStart'; kind: 'descend' | 'town' | 'arena'; by: string; needed: number; targetNodeId?: string; targetNodeType?: string;
    finish?: true;
    difficultyId?: string; templateId?: string; biomeId?: string; modifiers?: string[]; resume?: { host: string; depth: number };
  }
  | { t: 'voteUpdate'; yes: number; total: number }
  | { t: 'voteEnd'; passed: boolean }
  /**
   * ⭐ ОТВЕТ НА КОМАНДУ ГОРОДА — на КАЖДУЮ обработанную: выполненную, отклонённую, повтор по номеру
   * (Ф2.5), присланную не из того места (Ф3.1), слишком частую и невалидную. Идёт ПОСЛЕ `saveUpdate`,
   * поэтому к приходу ответа у клиента уже новый сейв. `id` — номер из кадра `cmd` (если он был и
   * валиден); `cmd` — имя команды (у невалидной — как прислали, обрезанное); `uid` — вещь, которую
   * команда создала (ковка; на повтор ключа заявки — та же, что в первый раз) или переделала
   * (зачарование); `unlocked` — что открылось в журнале кузнеца (разбор найденного у кузнеца).
   * Старый кадр `error` на отказ остаётся — его читают прежние клиенты.
   */
  | { t: 'cmdResult'; id?: number; cmd: string; ok: boolean; reason?: string; uid?: string; unlocked?: string[] }
  /**
   * Отказ. ⭐ C-05, C-08: `roomCode` — у отказа «Продолжить», чей забег ведёт другая комната (V2): `run` — она на другой ноде кластера, `full` —
   * в её пати нет мест. Клиент идёт по нему к ноде держателя (`join { resume }` там) или показывает лобби с этим кодом, а не только строку.
   * ⭐ D1: `solo` — у подсказки «пати не идёт» (`vote`: голос за продолжение своего забега не прошёл — «нет» другого или срок голосования; у героя
   * право «Соло»): клиент предлагает кнопку «Продолжить без пати» — `leave` по живому сокету и `join{resume, solo}`. Нет поля — только строка.
   * Отказ `run` в игре (спуск: забег ведёт другая комната — с `roomCode`; у героя свой забег — без него) — клиент предлагает «Продолжить»
   * (`leave` и `join{resume}`): к держателю его забега. ⭐ R21-04: отказ с `roomCode` получает и герой БЕЗ своего забега (гость в городе хозяина) —
   * ему после `leave` и статуса «забега нет» вход по коду (`join{roomCode}`): «Продолжить» не участника к пати не ведёт.
   */
  | { t: 'error'; code: string; msg: string; roomCode?: string; solo?: boolean }
  // Эхо на ping (тот же id) — клиент замеряет RTT.
  | { t: 'pong'; id: number };
