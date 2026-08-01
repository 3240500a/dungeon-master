import type { Item } from '../types/items.js';
import type { QuestDef } from '../types/quest.js';
import type { DamageType } from '../types/combat.js';
import type { ScaledMonster } from '../types/world.js';
import type { SaveState } from '../types/save.js';
import type { DebuffState } from '../world/debuffs.js';
import type { Grid } from '../world/grid.js';
import type { DecorObject } from '../dungeon/floorCommon.js';
import type { RunPlan } from '../dungeon/run/types.js';
import type { PlayerInput, SessionEvent } from './session.js';

/**
 * Сетевой протокол кооп-сервера (MP-2). Кадры JSON, авторитет — сервер: клиент шлёт
 * ввод/команды, получает снапшоты мира + события + свой авторитетный сейв. View-типы
 * несут ТОЛЬКО изменяемые поля сущностей (без тяжёлого `save`), грид/декор — один раз
 * при входе в область (`FloorInit`). Общие типы для клиента и сервера.
 */

/** Версия протокола (несовместимые правки — инкремент). */
export const PROTOCOL_VERSION = 1;

// ── View-типы (то, что едет в снапшоте, по id) ──────────────────────────────
export interface PlayerView {
  id: string;
  classId: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  mana: number;
  stamina: number;
  alive: boolean;
  debuffs: DebuffState;
  toggles: string[];
  /** Радиус коллизии (для debug-draw коллайдеров). */
  r: number;
  /** 3D-ключ экипированного оружия (для рендера кукол пиров: меш + адаптация поз). Нет оружия — поле отсутствует (клиент → класс-дефолт). */
  weaponKey?: string;
}
export interface MonsterView {
  id: number;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  stun: boolean;
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
export interface DropView {
  id: number;
  x: number;
  y: number;
  item: Item;
}
export interface PeerLite {
  id: string;
  classId: string;
  name: string;
}

/** Область комнаты и её геометрия (шлётся один раз при входе). */
export interface FloorInit {
  area: 'town' | 'dungeon';
  depth: number;
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
  monsters: { id: number; def: ScaledMonster; x: number; y: number }[];
  /** Запертые ворота (клетки грида) — для рендера/открытия по `doorOpened`. */
  doors: { id: number; cells: { cx: number; cy: number }[] }[];
  /** Рычаги (мировые координаты) — спрайт + интерактив «[E] Рычаг», открывает свою дверь. */
  levers: { id: number; x: number; y: number; doorId: number }[];
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
  | { cmd: 'equip'; uid: string }
  | { cmd: 'unequip'; slot: string }
  | { cmd: 'allocAttr'; attr: string }
  | { cmd: 'respec' }
  | { cmd: 'respecPassives' }
  | { cmd: 'respecSkills' }
  | { cmd: 'allocPassive'; nodeId: string }
  | { cmd: 'allocSkill'; nodeId: string }
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
  | { t: 'cmd'; command: TownCommand }
  // Спуск: из города — старт забега (difficultyId=тир; runConfig=выбор алтаря: биом/шаблон/модификаторы);
  // в подземелье — спуск по ребру графа (targetNodeId).
  | { t: 'descend'; difficultyId?: string; targetNodeId?: string; runConfig?: { biomeId?: string; templateId?: string; modifiers?: string[] } }
  | { t: 'return' }
  | { t: 'lever'; leverId: number }
  | { t: 'vote'; accept: boolean }
  | { t: 'leave' }
  // Замер задержки: клиент шлёт ping с id, сервер сразу эхо-pong тем же id → клиент считает RTT.
  // Бонусом — keepalive (не даёт прокси уронить простаивающее соединение).
  | { t: 'ping'; id: number };

// ── Кадры сервер → клиент ───────────────────────────────────────────────────
export type ServerFrame =
  | { t: 'joined'; v: number; playerId: string; roomCode: string; floor: FloorInit; peers: PeerLite[]; save: SaveState }
  // Ответ на runStatus: есть ли незавершённый забег (+ код комнаты и этаж для модалки).
  | { t: 'runStatus'; hasRun: boolean; roomCode?: string; depth?: number }
  // Подтверждение abandon: забег заброшен (персонаж погиб со штрафом) — клиент открывает лобби.
  | { t: 'abandoned' }
  | { t: 'snapshot'; snap: WorldSnapshot }
  | { t: 'events'; events: SessionEvent[] }
  | { t: 'saveUpdate'; save: SaveState }
  | { t: 'shop'; items: Item[] }
  // Полный слепок общего сундука (шлётся на stashOpen и после каждого stashMove).
  | { t: 'stash'; tabs: Item[][]; cols: number; rows: number; tabCount: number }
  | { t: 'questBoard'; quests: QuestDef[] }
  | { t: 'peerJoined'; peer: PeerLite }
  | { t: 'peerLeft'; id: string }
  | { t: 'areaChanged'; floor: FloorInit }
  // Структура текущего забега (v2) — данные для панели-карты (граф узлов, «видно вперёд»).
  | { t: 'runPlan'; plan: RunPlan; currentNodeId: string }
  | { t: 'doorOpened'; doorId: number }
  // Смерть игрока: потери + режим возрождения (город=соло/вайп, иначе ждать пати на след. этаже).
  | { t: 'died'; goldLost: number; itemsLost: number; toTown: boolean }
  | { t: 'voteStart'; kind: 'descend' | 'town'; by: string; needed: number; targetNodeId?: string; targetNodeType?: string }
  | { t: 'voteUpdate'; yes: number; total: number }
  | { t: 'voteEnd'; passed: boolean }
  | { t: 'error'; code: string; msg: string }
  // Эхо на ping (тот же id) — клиент замеряет RTT.
  | { t: 'pong'; id: number };
