import type { CombatStats, DamagePacket } from '../types/combat.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';
import type { ScaledMonster } from '../types/world.js';
import type { DebuffApply, DebuffState } from './debuffs.js';
import { newDebuffState } from './debuffs.js';
import type { PlayerHitOptions } from './combat.js';
import { gridSize, TILE, type Grid, type Cell } from './grid.js';
import type { Vec2 } from './movement.js';

/**
 * Модель мира — чистые сериализуемые данные (никаких Phaser-объектов), пригодные
 * для сети/сейва/сима. Сессия (Этап 2) мутирует это состояние в `tick`, клиент
 * (Этап 3) его рисует. Здесь — только типы + фабрики; поведение (движение/бой/ИИ)
 * живёт в чистых функциях `world/*` и будущем `session/*`.
 */

/** Активный рывок игрока (быстрое движение с временной добавкой к весу — расталкивает монстров). */
export interface DashState {
  /** Единичное направление рывка. */
  dx: number;
  dy: number;
  /** Скорость, px/сек. */
  speed: number;
  /** Остаток длительности, сек. */
  remaining: number;
  /** Множитель массы игрока на время рывка (расталкивание). */
  weightMult: number;
  /** Уже задетые монстры (без двойного удара за рывок). */
  hitIds: number[];
}

/** Игрок в мире (runtime), поверх персистентного `save`. */
export interface PlayerEntity {
  id: string;
  pos: Vec2;
  vel: Vec2;
  /** Угол взгляда (к цели/курсору) в радианах. */
  facing: number;
  hp: number;
  mana: number;
  /** Выносливость — ресурс боевых активок (реген как мана; стойки резервируют). */
  stamina: number;
  radius: number;
  debuffs: DebuffState;
  /** Секунд до следующей базовой атаки. */
  attackCd: number;
  /** Счётчик взмахов для чередования рук при дуал-вилде. */
  swingHand: number;
  /** Кулдаун по id скилла, сек (общий для всех биндов этого скилла). */
  skillCd: Record<string, number>;
  /** Активные тоглы/стойки/ауры (id узлов) — резервируют ману, дают стат-моды. */
  toggles: string[];
  /** Временные баффы: id узла → остаток длительности, сек. */
  skillBuffs: Record<string, number>;
  /** Идёт замах удара (базовой атаки ИЛИ скилла): сработает по завершении, прерывается станом. */
  windup: ({ kind: 'attack' } | { kind: 'skill'; nodeId: string; rank: number }) & { remaining: number } | null;
  /** Активный рывок (движение) — пока не null, ввод игнорируется, масса ×weightMult. */
  dash: DashState | null;
  /** Остаток стана (сек); >0 — управление/атака заблокированы. */
  stunTimer: number;
  alive: boolean;
  /** Персистентный персонаж (уровень, атрибуты, экипировка, инвентарь...). */
  save: SaveState;
}

/** Замах монстра: задержка между решением атаковать и уроном (как у игрока, `p.windup`). */
export interface MonsterWindup {
  /** Остаток замаха, сек. */
  remaining: number;
  /** Что сработает по завершении: ближний удар или выстрел. */
  action: 'attack' | 'shoot';
}

/** Монстр в мире (runtime), поверх определения `def`. */
export interface MonsterEntity {
  id: number;
  def: ScaledMonster;
  pos: Vec2;
  vel: Vec2;
  facing: number;
  hp: number;
  maxHp: number;
  radius: number;
  debuffs: DebuffState;
  /** Секунд до следующей атаки. */
  attackCd: number;
  /** Активный замах (укоренён, готовит удар) или null. */
  windup: MonsterWindup | null;
  stunTimer: number;
  /** Восприятие: покой (сканирует) / погоня (поводок). */
  aiState: 'idle' | 'chase';
  /** Остаток «поводка» преследования, сек. */
  leash: number;
  /** Остаток аггро от шума (атака игрока рядом), сек. */
  alertTimer: number;
  /** Точка спавна — для возврата при потере агро (leash-return). */
  home: Vec2;
  /** Троттл пересчёта пути обхода стен, сек. */
  pathCd: number;
  /** Кэш следующей путевой точки обхода (null — идти напрямую). */
  waypoint: Vec2 | null;
  alive: boolean;
}

/** Лежащий на полу предмет. */
export interface DropEntity {
  id: number;
  pos: Vec2;
  item: Item;
}

/** Летящий снаряд (базовая атака дальнобойного оружия или скилл). */
export interface ProjectileEntity {
  id: number;
  pos: Vec2;
  vel: Vec2;
  radius: number;
  /** Остаток жизни, сек. */
  ttl: number;
  owner: 'player' | 'monster';
  ownerId: string | number;
  packet: DamagePacket;
  attacker: CombatStats;
  /** Дебаффы, накладываемые при попадании. */
  onHit?: DebuffApply[];
  /** Имя источника (для лога «получил урон от …») — у снарядов монстров. */
  attackerName?: string;
  /** Пробивает всех (не гаснет о первую цель); id уже задетых — чтобы не бить дважды. */
  pierce?: boolean;
  hitIds?: number[];
  /** Бумеранг: летит до maxRange, разворачивается к владельцу и гаснет у него. */
  boomerang?: boolean;
  origin?: Vec2;
  returning?: boolean;
  maxRange?: number;
  /** Множитель урона за один сплэш при попадании (скиллы задают явно). */
  hitOpts?: PlayerHitOptions;
}

/** Полное состояние одного этажа/забега. */
export interface WorldState {
  seed: number;
  depth: number;
  difficultyId: string;
  /** Накопленное игровое время, мс. */
  timeMs: number;
  /** Счётчик тиков. */
  tick: number;
  grid: Grid;
  widthPx: number;
  heightPx: number;
  players: Record<string, PlayerEntity>;
  monsters: MonsterEntity[];
  drops: DropEntity[];
  projectiles: ProjectileEntity[];
  /** Монотонный источник id для сущностей этажа. */
  nextId: number;
  /** Точка входа (спавн игроков). */
  spawn: Vec2;
  /** Лестница вниз (переход на следующий этаж). */
  stairs?: Vec2;
  /** Все выходы на следующие этажи (v2 развилка). exits[0] совместим со `stairs`. */
  exits?: Vec2[];
  /** id/тип текущего узла забега (v2) и активные модификаторы этажа. */
  runNodeId?: string;
  runNodeType?: string;
  floorModifiers?: string[];
  /** Запертые ворота этажа (группы клеток `Cell.Door`); открываются своим рычагом. */
  doors: WorldDoor[];
  /** Рычаги этажа — каждый открывает свою дверь (по `doorId`), `used` после нажатия. */
  levers: WorldLever[];
}

/** Дверь этажа: группа клеток, открывается рычагом с тем же `doorId`. */
export interface WorldDoor { id: number; cells: { cx: number; cy: number }[]; }
/** Рычаг этажа: открывает свою дверь; после нажатия `used=true`. */
export interface WorldLever { id: number; pos: Vec2; doorId: number; used: boolean; }

/** Пустой мир для заданной сетки (без сущностей). */
export function newWorldState(grid: Grid, seed: number, depth: number, difficultyId: string): WorldState {
  const { cols, rows } = gridSize(grid);
  return {
    seed,
    depth,
    difficultyId,
    timeMs: 0,
    tick: 0,
    grid,
    widthPx: cols * TILE,
    heightPx: rows * TILE,
    players: {},
    monsters: [],
    drops: [],
    projectiles: [],
    nextId: 1,
    spawn: { x: 0, y: 0 },
    doors: [],
    levers: [],
  };
}

/** Создаёт runtime-монстра из отскейленного определения в заданной позиции. */
export function makeMonsterEntity(id: number, def: ScaledMonster, pos: Vec2, facing: number): MonsterEntity {
  return {
    id,
    def,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    facing,
    hp: def.hp,
    maxHp: def.hp,
    radius: def.rarity === 'champion' ? 15 : 12, // чемпион ~+25% (не настолько большой, чтобы не дотягиваться до удара)
    debuffs: newDebuffState(),
    attackCd: 0,
    windup: null,
    stunTimer: 0,
    aiState: 'idle',
    leash: 0,
    alertTimer: 0,
    home: { x: pos.x, y: pos.y },
    pathCd: 0,
    waypoint: null,
    alive: true,
  };
}

/** Создаёт runtime-игрока из сейва в заданной позиции. */
export function makePlayerEntity(id: string, save: SaveState, pos: Vec2, hp: number, mana: number, stamina: number): PlayerEntity {
  return {
    id,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    facing: 0,
    hp,
    mana,
    stamina,
    radius: 14,
    debuffs: newDebuffState(),
    attackCd: 0,
    swingHand: 0,
    skillCd: {},
    toggles: [],
    skillBuffs: {},
    windup: null,
    dash: null,
    stunTimer: 0,
    alive: true,
    save,
  };
}

// Реэкспорт для удобства потребителей модели.
export type { Cell };
