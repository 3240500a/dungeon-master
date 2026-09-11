import type { Item } from '../types/items.js';
import type { QuestDef } from '../types/quest.js';
import type { DamageType } from '../types/combat.js';
import type { DropPayload, ScaledMonster } from '../types/world.js';
import type { SaveState } from '../types/save.js';
import type { DebuffState } from '../world/debuffs.js';
import type { Grid } from '../world/grid.js';
import type { DecorObject } from '../dungeon/floorCommon.js';
import type { RunPlan } from '../dungeon/run/types.js';
import type { PlayerInput, SessionEvent } from './session.js';
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
  decor: DecorObject[];
  /** Запертые ворота (клетки грида) — для рендера/открытия по `doorOpened`. */
  doors: { id: number; cells: { cx: number; cy: number }[] }[];
  /** Рычаги (мировые координаты) — спрайт + интерактив «[E] Рычаг», открывает свою дверь. */
  levers: { id: number; x: number; y: number; doorId: number }[];
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
export type TownCommand =
  | { cmd: 'buy'; uid: string }
  | { cmd: 'sell'; uid: string }
  | { cmd: 'forgeUpgrade'; uid: string }
  | { cmd: 'forgeReroll'; uid: string }
  /** Починка сломанного трофея: снимает флаг за золото и материалы. */
  | { cmd: 'forgeRepair'; uid: string }
  /** Разбор у кузнеца: полный выход материалов. */
  | { cmd: 'forgeSalvage'; uid: string }
  /** Разбор на месте, в подземелье: выход `balance.salvage.fieldYield`. */
  | { cmd: 'salvage'; uid: string }
  | { cmd: 'equip'; uid: string }
  | { cmd: 'unequip'; slot: string }
  | { cmd: 'allocAttr'; attr: string }
  | { cmd: 'respec' }
  | { cmd: 'respecPassives' }
  | { cmd: 'respecSkills' }
  | { cmd: 'allocPassive'; nodeId: string }
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
  | { cmd: 'acceptQuest'; questId: string }
  | { cmd: 'turnInQuest'; questId: string };

// ── Кадры клиент → сервер ───────────────────────────────────────────────────
export type ClientFrame =
  // Клиент аутентифицируется токеном сессии + charId. Сервер проверяет ВЛАДЕНИЕ персонажем и
  // грузит его сейв из БД (создание персонажа — по HTTP, см. `/api/characters`). Анти-чит.
  // fresh — осознанно новая комната (соло/хост); resume — вернуться в незавершённый забег
  // (грейс-комната из подземелья); roomCode — вход к другу. Реконнект — только явным resume.
  | { t: 'join'; roomCode?: string; token: string; charId: string; fresh?: boolean; resume?: boolean }
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
  | { t: 'vote'; accept: boolean }
  | { t: 'leave' }
  // Замер задержки: клиент шлёт ping с id, сервер сразу эхо-pong тем же id → клиент считает RTT.
  // Бонусом — keepalive (не даёт прокси уронить простаивающее соединение).
  | { t: 'ping'; id: number };

// ── Кадры сервер → клиент ───────────────────────────────────────────────────
export type ServerFrame =
  | { t: 'joined'; v: number; playerId: string; roomCode: string; floor: FloorInit; peers: PeerInfo[]; save: SaveState }
  // Ответ на runStatus: есть ли незавершённый забег (+ код комнаты и этаж для модалки).
  | { t: 'runStatus'; hasRun: boolean; roomCode?: string; depth?: number }
  // Подтверждение abandon: забег заброшен (персонаж погиб со штрафом) — клиент открывает лобби.
  | { t: 'abandoned' }
  | { t: 'snapshot'; snap: WorldSnapshot }
  // Ф1.3: дельта к прошлому кадру. Первый кадр клиента ВСЕГДА полный, дальше идут дельты;
  // WebSocket поверх TCP гарантирует порядок и доставку, поэтому подтверждений не нужно.
  | { t: 'snapDelta'; delta: WorldDelta; sum: number }
  | { t: 'events'; events: SessionEvent[] }
  | { t: 'saveUpdate'; save: SaveState }
  | { t: 'shop'; items: Item[] }
  // Полный слепок общего сундука (шлётся на stashOpen и после каждого stashMove).
  | { t: 'stash'; tabs: Item[][]; cols: number; rows: number; tabCount: number }
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
  | { t: 'died'; goldLost: number; itemsLost: number; toTown: boolean; pvp?: boolean }
  | { t: 'voteStart'; kind: 'descend' | 'town' | 'arena'; by: string; needed: number; targetNodeId?: string; targetNodeType?: string }
  | { t: 'voteUpdate'; yes: number; total: number }
  | { t: 'voteEnd'; passed: boolean }
  | { t: 'error'; code: string; msg: string }
  // Эхо на ping (тот же id) — клиент замеряет RTT.
  | { t: 'pong'; id: number };
