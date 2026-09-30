import { vecLen, wrapAngle, normalizeAngle } from '../world/fastMath.js';
import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item, AttackType, ConsumableUse } from '../types/items.js';
import type { DropPayload, ScaledMonster, MonsterFaction } from '../types/world.js';
import type { CombatStats, DamagePacket, DamageType } from '../types/combat.js';
import type { StatModifier } from '../types/attributes.js';
import { emptyPacket, packetTotal } from '../types/combat.js';
import type { Difficulty } from '../formulas/power.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { resolveAttack, abilityCooldown, abilityRankMult, swingHalfWidth } from '../formulas/combat.js';
import { buffNodeCooldown, clampBuffCooldown } from '../formulas/buffTiming.js';
import { hitMaterialOf, type HitMaterial } from '../formulas/hitMaterial.js';
import { buildAttackPacket, attackWeaponsOf } from '../formulas/playerCombat.js';
import { buildMonsterPacket, monsterCombatStats, monsterDebuffs } from '../formulas/monstergen.js';
import { weaponDebuffs, mergeElementOnHit, shapeSkillPacket } from '../formulas/resolveWeapon.js';
import { skillWeaponAllowed } from '../formulas/skills.js';
import { asHeld, gripOf, type GripTuning } from '../formulas/versatile.js';
import { armorPoise, armorNoise } from '../formulas/resolveArmor.js';
import { generateItem, itemFromBase, rollTierLevel } from '../formulas/itemgen.js';
import { shapeFoundWeapon } from '../formulas/craft.js';
import { salvageFromMonster } from '../formulas/salvage.js';
import { monsterTrophyBase } from '../formulas/trophy.js';
import { giveMaterials } from '../economy/materials.js';
import { uuidv7 } from '../formulas/uuid.js';
import { gainXp } from '../economy/progression.js';
import { resolvePlayerHit, type HitTarget, type PlayerHitOptions } from '../world/combat.js';
import { debuffMods, addDebuffStack, tickDebuffs, newDebuffState, isDotKind, statusChance, type DebuffApply, type DebuffKind, type DebuffState } from '../world/debuffs.js';
import type { ConfigShapes } from '../config/schemas.js';
import { moveWithCollision, type Vec2 } from '../world/movement.js';
import { resolveEntityCollisions, type CollisionBody } from '../world/separation.js';
import { playerWeight, type WeightTables } from '../formulas/stats.js';
import { activeAbilityOf, reservedFrac, effectivePool, toggleBuffMods } from './toggles.js';
import { resolveActive, type InsertProc, type ResolvedActive, type ResourcePool } from './inserts.js';
/** Цена способности и вторая цена (надбавка вставок в чужой пул) — короткие имена для платежа. */
type Cost = { manaCost: number; resource: ResourcePool };
type Extra = { pool: ResourcePool; amount: number };
import { diagonalSealed, isBlockedCell, worldToCell, Cell } from '../world/grid.js';
import type { Grid } from '../world/grid.js';
import { hasLineOfSight, sightBlockedByObstacles } from '../world/lineOfSight.js';
import { addToInventory } from '../inventory/grid.js';
import {
  newWorldState,
  makeMonsterEntity,
  makePlayerEntity,
  type WorldState,
  type PlayerEntity,
  type MonsterEntity,
  type ProjectileEntity,
  type Obstacle,
  type AttackSeries,
  type DropEntity,
} from '../world/state.js';
import { playerSnapshot, equippedItems, type PlayerSnapshot } from './derive.js';
import { stepMonsterAi, ALERT_TIME } from './ai.js';
import { behaviorFor, type MonsterBehavior } from './behavior.js';
import { findPath } from '../world/pathfind.js';
import { applyConsumable } from '../economy/townActions.js';

/**
 * Безголовое авторитетное ядро игрового цикла (Этап 2). Держит `WorldState` как
 * чистые данные и продвигает его в `tick(dt, inputs)`, прогоняя весь бой/ИИ/скиллы/
 * лут через формулы `shared` — 1-в-1 с клиентским `CombatController` (клиент станет
 * вью на Этапе 3, сим — ботом на Этапе 4). Генерация этажа инъектируется извне
 * (`FloorLayout`) — общий шов и для клиента, и для сима.
 */

/** Ввод одного игрока за тик (в клиенте — клава/мышь, в симе — бот, в кооп — сеть). */
export interface PlayerInput {
  /** Направление движения (сырое, нормализуется внутри). */
  move: Vec2;
  /** Угол взгляда (радианы). */
  facing: number;
  /** Базовая атака оружием. */
  attack: boolean;
  /** id скилла для каста в этот тик, или null. */
  cast: string | null;
  /** Действие/подбор (E). */
  interact: boolean;
  /** Уклонение (dodge-рывок) в этот тик — эджевый (клиент шлёт только в кадр нажатия пробела). */
  dodge?: boolean;
  /** Слот пояса для расходника в этот тик (индекс в save.belt), или undefined. */
  useBelt?: number;
}

/** Монстр к спавну (из генератора этажа). */
export interface MonsterSpawn {
  def: ScaledMonster;
  x: number;
  y: number;
}

/** Расклад этажа от генератора (клиент/сим готовят его снаружи). */
export interface FloorLayout {
  grid: Grid;
  spawn: Vec2;
  stairs?: Vec2;
  /** Все выходы на следующие этажи (v2 развилка). */
  exits?: Vec2[];
  /** Мета узла забега (v2) — для рендера/карты. */
  runNodeId?: string;
  runNodeType?: string;
  floorModifiers?: string[];
  /** id биома этажа (v2) — клиент выбирает по нему набор окружения. */
  biomeId?: string;
  monsters: MonsterSpawn[];
  /**
   * Запертые ворота + рычаги (по модели «дверь ↔ рычаг»). `used` — рычаг уже дёрнут (продолжение узла, R4-01):
   * его дверь открывается сразу.
   */
  doors?: { id: number; cells: { cx: number; cy: number }[] }[];
  levers?: { id: number; x: number; y: number; doorId: number; used?: boolean }[];
  /** Сундуки этажа (Ч6). `opened` — уже открыт (продолжение узла, R4-01): второй раз не открывается. */
  chests?: { id: number; x: number; y: number; tier: string; opened?: boolean }[];
  /**
   * Уровень этажа, если монстры переданы не все (продолжение узла без убитых, R4-01): сундук берёт ступень от
   * ПОЛНОГО заселения, а не от оставшихся — иначе убитый босс опускал бы добычу нетронутых сундуков.
   */
  floorLevel?: number;
  /** Суб-тайловые препятствия напольного декора (круг/бокс) — коллизия по форме меша. */
  obstacles?: Obstacle[];
  /** PvP-арена: атаки игроков бьют друг друга (иначе — обычный этаж/город). */
  pvp?: boolean;
}

/** Материал цели для звука удара: монстр — по надетой броне (нагрудник, иначе шлем). */
const monsterMat = (m: MonsterEntity): HitMaterial => hitMaterialOf(m.def.armorClass);
/** …игрок — по своему нагруднику, иначе шлему. */
const playerMat = (p: PlayerEntity): HitMaterial =>
  hitMaterialOf(p.save.equipment.chest?.armorClass, p.save.equipment.helm?.armorClass);
/**
 * Дроп выбросил игрок ДРУГОГО аккаунта (R2-02) — этому игроку его не поднять. Без владельца — общий. ⭐ V-B2-04: и выброшенное другим
 * героем, чья строка в базе вещь ещё держит (`heldBy`), — только ему самому, пока сервер не снимет метку.
 */
const foreignDrop = (p: PlayerEntity, d: { owner?: string; heldBy?: string }): boolean =>
  (d.owner !== undefined && d.owner !== p.account) || (d.heldBy !== undefined && d.heldBy !== p.save.charId);
/**
 * ⚠ R6-02: С ЧЕМ НАЧАТ ЗАМАХ — надетое (uid по слотам) и включённые ауры/стойки. Замах запоминает подпись на старте; на ударе
 * она другая — удар пропадает. Иначе темп брался бы от одного (кинжал, кольцо или аура на скорость), а урон, дальность, вес
 * и проки — от другого: команды экипировки ходят где угодно и приходят между тиками, а тогл ауры — вводом в любой кадр.
 */
const loadoutSig = (p: PlayerEntity): string =>
  Object.entries(p.save.equipment).filter(([, it]) => it).map(([slot, it]) => `${slot}:${it!.uid}`).sort().join('|')
  + '#' + [...p.toggles].sort().join('|');
/** Событие подбора вещи; выброшенное игроком — с пометкой `thrown` (R4-26). */
const pickedEvent = (playerId: string, t: { item?: Item; x: number; y: number; thrown?: true }): SessionEvent =>
  ({ type: 'item-picked', playerId, item: t.item!, x: t.x, y: t.y, ...(t.thrown ? { thrown: true as const } : {}) });

/** События тика — для вью (числа/эффекты) и статистики. */
export type SessionEvent =
  // `mat` — ВО ЧТО попали (класс брони цели, `flesh` = тела). Звук удара берётся отсюда, а не из метки
  // клипа: метка не знает ни попал ли ты, ни во что. Промах приходит тем же событием с `hit: false`.
  | { type: 'hit'; target: 'monster' | 'player'; id: string | number; by?: string; x: number; y: number; hit: boolean; blocked: boolean; crit: boolean; amount: number; byType: DamagePacket; mat: HitMaterial }
  | { type: 'monster-died'; id: number; def: ScaledMonster; x: number; y: number; by?: string }
  | { type: 'quest'; playerId: string; kind: 'accepted' | 'progress' | 'completed' | 'turned-in'; questId: string; name: string }
  /** `from` — с трупа или из сундука. Без него в отчёте не отличить два потока добычи. */
  | { type: 'item-dropped'; item: Item; x: number; y: number; from: 'monster' | 'chest' }
  /** Сундук открыт — клиент гасит меш (состояние живёт в мире, а FloorInit шлётся один раз). */
  | { type: 'chest-opened'; id: number; x: number; y: number }
  /**
   * `thrown` (R4-26) — вещь выбросил игрок (у дропа есть владелец): «собрать предмет» такую не засчитывает, иначе «собрать N»
   * закрывался одной вещью — выбросил, поднял, и так N раз. Добыча с монстров и из сундуков — без пометки.
   */
  | { type: 'item-picked'; playerId: string; item: Item; x: number; y: number; thrown?: true }
  | { type: 'gold'; playerId: string; amount: number; total: number }
  /** Материалы с убитого монстра: id → количество. `x`/`y` — место смерти, чтобы клиент показал их там. */
  | { type: 'materials'; playerId: string; gains: Record<string, number>; x: number; y: number }
  | { type: 'xp'; playerId: string; amount: number }
  | { type: 'levelup'; playerId: string; level: number }
  | { type: 'player-died'; playerId: string }
  | { type: 'stun'; id: number }
  | { type: 'knockdown'; id: number; dx: number; dy: number }   // монстр сбит с ног: клиент валит рагдолл в направлении (dx,dy) и потом поднимает
  // Реальный свинг игрока (принят: мана/КД/оружие прошли) — для клиентского VFX (форма удара) и
  // заливки-отката слота бинда. ability = nodeId скилла или 'attack'. windupMs — замах, cooldownMs — откат
  // использованного действия, lockMs — общий attack-таймер (блокирует ВСЕ удары/attack-cast-скиллы).
  // `chain` — это НЕ новое применение, а очередной взмах уже идущей серии (`hits`>1): клиент играет
  // ему свою анимацию и звук, но заливку-откат слота НЕ перезапускает (иначе она дёргалась бы назад
  // на каждом взмахе, хотя откат идёт себе с первого).
  | { type: 'swing'; playerId: string; ability: string; windupMs: number; cooldownMs: number; lockMs: number; x: number; y: number; facing: number; chain?: boolean }
  // ⭐ R8-15: применено действие БЕЗ удара (бафф) — клиенту только залить откат слота `ability` на cooldownMs. Не свинг:
  // свинг клиенты играют ударом оружия (кукла, «слэш», свист) и ставят им общий attack-лок — бафф посреди замаха обнулял лок.
  | { type: 'cooldown'; playerId: string; ability: string; cooldownMs: number }
  // Старт замаха монстра — клиент рисует телеграф-вспышку на время windupMs в сторону facing.
  | { type: 'monster-swing'; id: number; windupMs: number; x: number; y: number; facing: number }
  // Уклонение игрока (dodge-рывок) — клиент проигрывает VFX/SFX рывка в сторону dir.
  | { type: 'dodge'; playerId: string; x: number; y: number; dir: number }
  | { type: 'floor-cleared' };

/**
 * ⭐ R21-05: откаты героя для кадра входа (`joined.cooldowns`) — ключ как у события `cooldown`/`swing` (узел скила; `ins:<вставка>` — печать):
 * `leftMs` — остаток, `fullMs` — полный откат (доля заливки слота). Событие каста о них клиенту не придёт: их вернул сервер (`GameSession.cooldownsOf`).
 */
export type HeroCooldowns = Record<string, { leftMs: number; fullMs: number }>;

/** AoE-способность (бьёт по площади вокруг игрока), по abilityId — как в боевом контроллере. */
export function isAoeAbility(id: string): boolean {
  return /nova|shout|taunt|caltrops|berserk|wolf|horn|rally|blizzard|meteor|trap|rain|skin|wall/.test(id);
}

/** Стихия способности по abilityId (для перекраски пакета урона). */
export function abilityElementOf(id: string): DamageType {
  if (/fire|flame|meteor/.test(id)) return 'fire';
  if (/frost|ice|cold|blizzard|nova/.test(id)) return 'cold';
  if (/shock|lightning|storm/.test(id)) return 'lightning';
  if (/poison|venom/.test(id)) return 'poison';
  return 'physical';
}

/** Копия пакета урона со всеми компонентами, умноженными на m (не мутирует исходник). */
function scalePacket(pk: DamagePacket, m: number): DamagePacket {
  const out = emptyPacket();
  for (const t of Object.keys(pk) as DamageType[]) out[t] = pk[t] * m;
  return out;
}

/** Радиус AoE-способности (совпадает с executeAbility). */
export const ABILITY_AOE_RADIUS = 130;

const PLAYER_PROJ_SPEED = 440;
const MONSTER_PROJ_SPEED = 260;
const ABILITY_PROJ_SPEED = 460;
const PROJ_TTL = 2.5;
const PROJ_HIT_RADIUS = 16;
/**
 * ⚠ C-11 (бафф-зелья): ключ временного баффа зелья в `skillBuffs` — `pot:<база>`, как печать вставки `ins:<вставка>`. Моды и
 * длительность — из определения базы в конфиге (`potionBuff`), таймер — общий с баффами скилов (истекает в тике, снимается смертью).
 */
const POTION_BUFF = 'pot:';
/** Запас к сумме радиусов, в пределах которого ближний удар монстра засчитывается по завершении
 *  замаха. Если игрок за время замаха отошёл дальше — удар вхолостую (замах даёт окно на уклонение). */
const MONSTER_MELEE_WHIFF_SLACK = 8;
/** Сколько мс труп монстра держится в w.monsters после смерти, прежде чем удаляется из мира/снапшота. Клиенты снимают
 *  спрайт/куклу по первому alive=false (+ событию monster-died) и отыгрывают коллапс (~1.1с в 3D) — линга с запасом хватает. */
const CORPSE_LINGER_MS = 3000;
/**
 * ⚠ R10-02: сторож застревания погони (`navChase`). Окно, за которое погоня к цели обязана сдвинуть монстра хотя бы на
 * STALL_SHARE пути, положенного ему по скорости; не сдвинула — DETOUR_SEC он идёт по пути в обход, даже видя цель.
 */
const STALL_SEC = 0.5;
const STALL_SHARE = 0.25;
const DETOUR_SEC = 1;
/** Сторож смотрит только погоню «на цель» (косинус с направлением на неё не ниже): стрейф стрелка вбок у стены — манёвр. */
const STALL_COS = 0.7;

/** Спецификация активной способности (v2: дискриминирована по `category`). */
type ActiveAbility = NonNullable<ConfigShapes['skill-tree']['nodes'][number]['effect']['active']>;
type AttackAbility = Extract<ActiveAbility, { category: 'attack' }>;
type CastAbility = Extract<ActiveAbility, { category: 'cast' }>;
type CurseAbility = Extract<ActiveAbility, { category: 'curse' }>;
type ToggleAbility = Extract<ActiveAbility, { category: 'aura' | 'stance' }>;
type OffensiveAbility = AttackAbility | CastAbility;
/** Опции применения удара (оружие/скилл): к PlayerHitOptions добавлены отброс и гарант. стан. */
type HitOpts = PlayerHitOptions & { knockback?: number; stunSec?: number; shoveChance?: number; knockdownChance?: number; knockdownSec?: number };
/** Опорный вес для масштаба отброса: knockback (px) калиброван под монстра ~этого веса. */
const KNOCKBACK_REF_WEIGHT = 100;

export class GameSession {
  readonly world: WorldState;
  private cfg: ConfigRegistry;
  private rng: Rng;
  private events: SessionEvent[] = [];
  /** Кэш боевого снимка каждого игрока на текущий тик. */
  private snaps = new Map<string, PlayerSnapshot>();
  private floorCleared = false;
  /** Идёт исполнение прок-скилла — не рекурсим прок от его же ударов. */
  private procActive = false;
  /**
   * `rewards` — совместимый общий флаг: задаёт дефолт для обоих под-флагов ниже.
   * Разбит на две НЕЗАВИСИМЫЕ грани, чтобы сим-микробой мерил чистый TTK:
   *  • `sustain` — боевой сустейн: вампиризм (лич), проки «при ударе/получении», лич-за-килл,
   *    overload-взрыв конструктов при смерти. Это часть боевой мощи игрока И угрозы моба.
   *  • `economy` — начисление золота/XP/дропа при смерти монстра (и левелап через awardXp,
   *    который ПОЛНОСТЬЮ лечит — потому в микробое economy=false, иначе левелап испортит TTK).
   * Дефолты: оба берут значение `rewards`. Сервер/сим-забег: rewards=true → оба true.
   * Клиент-вид: rewards=false → оба false (лут/XP/лич делают обработчики шины, чтобы не задвоить).
   * Сим-микробой: sustain=true, economy=false — реальный сустейн, но без наград/левелап-хила.
   */
  private rewards: boolean;
  private sustain: boolean;
  private economy: boolean;
  /**
   * ⭐ СЕЙВ ПОД ТРАНЗАКЦИЕЙ СЕРВЕРА (R1-05): id игроков, чья запись «сейв + сундук» сейчас ждёт базу.
   * Тик их сейв НЕ трогает — ни автоподбора, ни подбора по [E], ни зелий пояса. Неудачная запись
   * откатывает сейв к снимку, и всё, что тик успел бы в него положить за время ожидания, пропало бы
   * (поднятая с земли вещь — ни на земле, ни в сумке) или вернулось бы вторым разом (выпитое зелье).
   * Окно — одна запись в базу; клиенты сюда не пишут, набор ведёт только сервер.
   */
  readonly saveHeld = new Set<string>();
  /**
   * ⭐ K3: ПОДЪЁМ ВЫБРОШЕННОГО ИГРОКОМ — ДЕЛО ХОЗЯИНА СЕССИИ. Вещь, выброшенную игроком (`owner`), сервер кладёт в сумку только ПОСЛЕ
   * записи поднимающего (`Room.pickThrown`): её строка в базе уже отпустила вещь, и подъём одной памятью оставлял её ни в одной строке до
   * записи — падение процесса в этом окне теряло уже записанную вещь. Тик ([E], автоподбор) такую вещь сам не берёт, а зовёт этот крючок;
   * нет крючка (клиент, сим, оффлайн) — берёт сам, как прежде.
   */
  pickThrown?: (playerId: string, dropId: number) => void;

  /**
   * ⭐ R9-02: `rng` — источник бросков сессии; нет — сидовый mulberry32 (`seed`), как у сима, ботов, тестов и клиента. Сервер
   * даёт криптоисточник (`sessionRng`): у mulberry32 состояние — 32 бита, и выход потока виден с первого снимка (взгляд каждого
   * монстра заселения — `rng.float(0, 2π)`, урон и криты в событиях), так что состояние подбиралось перебором за секунды, а
   * дальше изменённый клиент считал сундук и дроп наперёд этим же кодом и крутил их ударами в воздух (удар — один бросок).
   * Непредсказуемый сид (D10) этого не закрывал: утекал сам поток.
   */
  constructor(cfg: ConfigRegistry, seed: number, difficultyId: string, opts: { rewards?: boolean; sustain?: boolean; economy?: boolean; rng?: Rng } = {}) {
    this.cfg = cfg;
    this.rng = opts.rng ?? createRng((seed >>> 0) || 1);
    this.world = newWorldState([], seed, 0, difficultyId);
    this.rewards = opts.rewards ?? true;
    this.sustain = opts.sustain ?? this.rewards;
    this.economy = opts.economy ?? this.rewards;
  }

  /** Эффекты дебаффов с тюн-коэффициентами из живого конфига `debuffs`. */
  private dmods(state: DebuffState) {
    return debuffMods(state, this.cfg.get('debuffs'));
  }

  /** Добавляет игрока (один раз за забег); HP/мана — полные. `account` — аккаунт игрока на сервере (R2-02). */
  addPlayer(id: string, save: SaveState, spawnAt?: Vec2, account?: string): PlayerEntity {
    const snap = playerSnapshot(save, this.cfg);
    // Обычно спавним в точке входа мира (центр города/этажа); при реконнекте — в заданной
    // точке (та же позиция). Кооп-присоединение происходит ПОСЛЕ enterFloor.
    const p = makePlayerEntity(id, save, spawnAt ? { ...spawnAt } : { ...this.world.spawn }, snap.derived.maxHp, snap.derived.maxMana, snap.derived.maxStamina);
    if (account !== undefined) p.account = account;
    this.world.players[id] = p;
    return p;
  }

  /** Удаляет игрока (выход/дисконнект в кооп). */
  removePlayer(id: string): void {
    delete this.world.players[id];
    this.snaps.delete(id);
  }

  /** Загружает новый этаж: сетка + монстры + сброс снарядов/дропа; игроки — на вход. */
  enterFloor(depth: number, layout: FloorLayout): void {
    const w = this.world;
    w.depth = depth;
    w.grid = layout.grid;
    w.spawn = { ...layout.spawn };
    w.stairs = layout.stairs ? { ...layout.stairs } : undefined;
    w.exits = layout.exits ? layout.exits.map((e) => ({ ...e })) : undefined;
    w.runNodeId = layout.runNodeId;
    w.runNodeType = layout.runNodeType;
    w.floorModifiers = layout.floorModifiers;
    w.biomeId = layout.biomeId;
    w.doors = (layout.doors ?? []).map((d) => ({ id: d.id, cells: d.cells.map((c) => ({ ...c })) }));
    w.levers = (layout.levers ?? []).map((l) => ({ id: l.id, pos: { x: l.x, y: l.y }, doorId: l.doorId, used: false }));
    // R4-01: рычаг, дёрнутый до продолжения узла, — его дверь открыта сразу (тем же путём, что рычагом).
    for (const l of layout.levers ?? []) if (l.used) { const lv = w.levers.find((x) => x.id === l.id); if (lv) this.openDoorOf(lv); }
    w.chests = (layout.chests ?? []).map((c) => ({ id: c.id, pos: { x: c.x, y: c.y }, tier: c.tier, opened: c.opened === true }));
    w.obstacles = (layout.obstacles ?? []).map((o) => ({ ...o }));   // суб-тайл-препятствия декора (коллизия/LoS)
    w.pvp = layout.pvp ?? false;   // арена включает урон игрок↔игрок; обычный этаж/город — сбрасывает
    w.monsters = [];
    w.drops = [];
    w.projectiles = [];
    w.tick = 0;
    this.floorCleared = false;
    // ⭐ Уровень ЭТАЖА = уровень самого сильного монстра на нём. Нужен сундуку: он стоит на
    // этаже, а не «на глубине», и брать сырую глубину значило выдавать ступень ниже соседнего
    // зомби. Считается ЗДЕСЬ, потому что дальше монстров убьют и спросить будет некого.
    w.floorLevel = Math.max(0, layout.floorLevel ?? 0);
    for (const s of layout.monsters) {
      w.floorLevel = Math.max(w.floorLevel, s.def.level);
      w.monsters.push(makeMonsterEntity(w.nextId++, s.def, { x: s.x, y: s.y }, this.rng.float(0, Math.PI * 2)));
    }
    for (const id of Object.keys(w.players)) {
      const p = w.players[id]!;
      if (!p.alive) { this.respawnPlayer(id); continue; } // мёртвые оживают на новом этаже (кооп-возврат)
      p.pos = { ...layout.spawn };
      p.vel = { x: 0, y: 0 };
      if (depth === 0) this.cleanse(p);
    }
  }

  /**
   * ⚠ R4-09: ГОРОД (глубина 0; арену сверх того оживляет сама комната) — БЕЗОПАСЕН. Живые переходили этаж со своими
   * дебаффами, и кровотечение, повешенное на арене (выход оттуда — голосованием из любого места), или яд монстра при
   * возврате порталом добивали героя уже в городе: комната тогда не арена — полный штраф смерти, а гибель всех разом
   * (`allDead` → `endRun`) стирала припаркованный забег. Снимаются дебаффы, стан, замах и рывок; ауры и баффы — нет.
   */
  private cleanse(p: PlayerEntity): void {
    p.debuffs = newDebuffState();
    p.stunTimer = 0;
    p.windup = null;
    p.dash = null;
  }

  /** Число живых монстров на этаже. */
  get monstersAlive(): number {
    let n = 0;
    for (const m of this.world.monsters) if (m.alive) n++;
    return n;
  }

  /** Боевой снимок игрока за текущий тик (для HUD/тестов); undefined до первого тика. */
  snapshotOf(id: string): PlayerSnapshot | undefined {
    return this.snaps.get(id);
  }

  /**
   * ⭐ D4: СНИМОК ГЕРОЯ ЗАНОВО — как в начале тика (с тоглами и баффами), после смены тела между тиками (конец арены — `arenaReturn`). Без
   * этого до следующего тика жил снимок арены (без стоек, аур и баффов тела города), и команда в этом окне (зелье: потолок здоровья и маны)
   * мерилась им — R15-09 («по герою города, а не по снимку арены») держал это только для самого возврата. Здоровье здесь не подрезается —
   * это делает тик (R5-02), как у любого снятия бонуса.
   */
  refreshSnapshot(id: string): void {
    const p = this.world.players[id];
    if (!p?.alive) return;
    this.dropUnlearned(p);
    const s = playerSnapshot(p.save, this.cfg, this.runtimeMods(p));
    this.snaps.set(id, s);
    p.maxHp = s.derived.maxHp;
  }

  /**
   * ⭐ R21-05: ОТКАТЫ ГЕРОЯ ДЛЯ КАДРА ВХОДА (`joined.cooldowns`). Реконнект (запись ухода, R4-06), вход в другую комнату (D4: `vitals.cd`) и вторая
   * вкладка ставят герою откаты, о которых событие каста клиенту не придёт: раньше новая страница рисовала слот готовым, а каст сервер молча
   * отбрасывал до конца скрытого отката. Остаток — как держит сервер; полный — откат узла на его ранге сейчас, по тому же правилу, что кладёт каст
   * (`nodeCooldown`), и не короче остатка (ранг или вставки могли смениться с каста; у печати вставки `ins:` — остаток). Откатов нет — `undefined`.
   */
  cooldownsOf(id: string): HeroCooldowns | undefined {
    const p = this.world.players[id];
    if (!p) return undefined;
    let out: HeroCooldowns | undefined;
    for (const [key, left] of Object.entries(p.skillCd)) {
      if (!(left > 0)) continue;
      const leftMs = Math.round(left * 1000);
      const rank = p.save.skills[key] ?? 0;
      const res = rank > 0 ? resolveActive(this.cfg, p.save, key) : undefined;
      const fullMs = res ? Math.round(this.nodeCooldown(res.active, key, rank) * 1000) : 0;
      (out ??= {})[key] = { leftMs, fullMs: Math.max(leftMs, fullMs) };
    }
    return out;
  }

  /**
   * Полный откат узла на ранге — ровно то, что каст кладёт в `skillCd`: бафф — по правилу времени баффа (D4: ранг выше потолка узла откат не режет,
   * не короче действия с отдыхом `buffMinRest`), прочие — `abilityCooldown`. ⭐ R21-05: одно место для каста и кадра входа (`cooldownsOf`).
   */
  private nodeCooldown(active: ActiveAbility, nodeId: string, rank: number): number {
    if (active.category === 'buff') {
      const maxRank = this.cfg.get('skill-tree').nodes.find((n) => n.id === nodeId)?.maxRank ?? rank;
      return clampBuffCooldown(buffNodeCooldown(active.cooldown, rank, maxRank), active.durationSec, this.cfg.get('balance').buffMinRest, nodeId);
    }
    return active.cooldown > 0 ? abilityCooldown(active.cooldown, rank) : 0;
  }

  // ── Главный тик ───────────────────────────────────────────
  tick(dt: number, inputs: Record<string, PlayerInput>): SessionEvent[] {
    const w = this.world;
    this.events = [];
    w.timeMs += dt * 1000;
    w.tick++;
    const now = w.timeMs;

    // Снимки игроков на тик (derived/attrs/combat) — один расчёт на игрока.
    // ⚠ R5-02: максимум упал (снял +жизнь, выключил стойку, сбросил Живучесть) — здоровье подрезается СРАЗУ, до боя этого
    // тика. Раньше максимум пересчитывался, а текущее только росло: надел, налился, снял — и «танковое» здоровье жило на
    // стеклянной пушке весь бой, через этажи и город. Мана и выносливость подрезаются ниже, в регене.
    this.snaps.clear();
    for (const id of Object.keys(w.players)) {
      const p = w.players[id]!;
      if (p.alive) {
        this.dropUnlearned(p);
        const s = playerSnapshot(p.save, this.cfg, this.runtimeMods(p));
        this.snaps.set(id, s);
        p.maxHp = s.derived.maxHp;
        if (p.hp > p.maxHp) p.hp = p.maxHp;
      }
    }

    // 1) Ввод игроков: движение + взгляд + атака/каст.
    for (const id of Object.keys(w.players)) {
      const p = w.players[id]!;
      if (!p.alive) continue;
      const snap = this.snaps.get(id)!;
      this.stepPlayerInput(p, snap, inputs[id], dt);
    }

    // 2) Дебаффы на игроках: DoT кровотечения + истечение; реген HP/маны.
    for (const id of Object.keys(w.players)) {
      const p = w.players[id]!;
      if (!p.alive) continue;
      // Стан игрока: тик таймера; во время стана/ошеломления замах может сбиться.
      if (p.stunTimer > 0) p.stunTimer = Math.max(0, p.stunTimer - dt);
      if (p.windup) this.stepWindup(p, this.snaps.get(id)!, dt);
      const pdot = tickDebuffs(p.debuffs, dt, now);
      if (pdot > 0) {
        p.hp = Math.max(0, p.hp - pdot);
        if (p.hp <= 0) { p.alive = false; this.events.push({ type: 'player-died', playerId: id }); }
      }
      // Пассивный реген из статов (как в клиенте GameScene.regen) — восстановление
      // HP/маны между пачками. «Увечье» режет реген HP.
      if (p.alive) {
        const d = this.snaps.get(id)!.derived;
        const hpRegenMult = this.dmods(p.debuffs).hpRegenMult;
        if (p.hp < d.maxHp) p.hp = Math.min(d.maxHp, p.hp + d.hpRegen * hpRegenMult * dt);
        // Тоглы/ауры резервируют долю маны — эффективный максимум ниже, регенерируем до него.
        const effMana = effectivePool(d.maxMana, this.reservedFrac(p, 'mana'));
        if (p.mana > effMana) p.mana = effMana; // подрезка при включении ауры
        else if (p.mana < effMana) p.mana = Math.min(effMana, p.mana + d.manaRegen * dt);
        // Выносливость — ресурс боевых активок; стойки резервируют её (эфф. максимум ниже).
        const effStam = effectivePool(d.maxStamina, this.reservedFrac(p, 'stamina'));
        if (p.stamina > effStam) p.stamina = effStam;
        else if (p.stamina < effStam) p.stamina = Math.min(effStam, p.stamina + d.staminaRegen * dt);
      }
      p.attackCd = Math.max(0, p.attackCd - dt);
      p.dodgeCd = Math.max(0, p.dodgeCd - dt);   // кулдаун уклонения
      // «В бою»: своя атака/скилл (windup) освежает линга-таймер; иначе он тает. Монстр-таргетинг стамп ниже.
      p.combatTimer = p.windup ? this.cfg.get('balance').melee.combatLingerSec : Math.max(0, p.combatTimer - dt);
      for (const k of Object.keys(p.skillCd)) {
        const left = (p.skillCd[k] ?? 0) - dt;
        if (left <= 0) delete p.skillCd[k];
        else p.skillCd[k] = left;
      }
      // Истечение временных баффов.
      for (const k of Object.keys(p.skillBuffs)) {
        const left = (p.skillBuffs[k] ?? 0) - dt;
        if (left <= 0) delete p.skillBuffs[k];
        else p.skillBuffs[k] = left;
      }
    }

    // 3) Монстры: тик статуса, ИИ, движение, атака/выстрел.
    // ⚠ R5-06: шум брони — ЦЕЛИ монстра (ближайшего игрока), а не первого в комнате: латы хозяина у входа делали слышным
    // тихого соседа в другом конце этажа, а тихий хозяин прятал латника. Считается раз на игрока за тик.
    const noise = new Map<string, number>();
    const noiseOf = (t: PlayerEntity): number => {
      let n = noise.get(t.id);
      if (n === undefined) { n = armorNoise(equippedItems(t.save), this.cfg.get('armor-classes')); noise.set(t.id, n); }
      return n;
    };
    const behaviors = this.cfg.get('monster-behaviors');
    for (const m of w.monsters) {
      if (!m.alive) continue;
      // DoT кровотечения + реген (у чемпионов; «увечье» режет реген).
      const dm = this.dmods(m.debuffs);
      const dot = tickDebuffs(m.debuffs, dt, now);
      if (dot > 0) {
        m.hp -= dot;
        if (m.hp <= 0) { this.killMonster(m, this.dotOwner(m)); continue; }   // R5-06: тому, кто повесил статус
      }
      // Нокдаун (сбит с ног): полностью беспомощен — не ходит/не атакует/не регенит, пока лежит и встаёт. DoT выше
      // всё равно тикает (лежачий уязвим). Флаг едет в снапшот (клиент проигрывает рагдолл-падение и подъём).
      if (m.downTimer > 0) {
        m.downTimer = Math.max(0, m.downTimer - dt); m.vel.x = 0; m.vel.y = 0; m.windup = null;
        if (m.knock) {   // авторитетный отлёт: сервер глайдит позицию ОТ атакующего (стены гасят); клиент ведёт рагдолл по ней же → без рассинхрона
          m.pos = moveWithCollision(m.pos, { x: m.knock.dx * m.knock.speed, y: m.knock.dy * m.knock.speed }, m.radius, this.world.grid, dt, this.world.obstacles);
          m.knock.remaining -= dt;
          if (m.knock.remaining <= 0) m.knock = null;
        }
        if (m.downTimer <= 0) m.knock = null;   // встал — снять отлёт (страховка при misconfig knockbackSec>downTimer)
        continue;
      }
      if (m.def.hpRegen > 0 && m.hp < m.maxHp) {
        m.hp = Math.min(m.maxHp, m.hp + m.def.hpRegen * dm.hpRegenMult * dt);
      }

      const target = this.nearestPlayer(m.pos);
      if (!target) { m.vel.x = 0; m.vel.y = 0; continue; }
      // Монстр аггрится/целится в ЭТОГО игрока → он «в бою» (боевой айдл). Стамп линга-таймера.
      if (m.aiState === 'chase' || m.windup) target.combatTimer = this.cfg.get('balance').melee.combatLingerSec;

      // Замах (как у игрока): между решением ударить и уроном — задержка. Монстр укоренён и смотрит
      // на цель; стан замах сбивает. По завершении — реальный удар/выстрел (у ближнего — если игрок
      // всё ещё в зоне, иначе вхолостую). Пока замах активен — ИИ/движение не трогаем.
      if (m.windup) {
        m.vel.x = 0; m.vel.y = 0;
        m.facing = Math.atan2(target.pos.y - m.pos.y, target.pos.x - m.pos.x);
        if (m.stunTimer > 0) { m.stunTimer = Math.max(0, m.stunTimer - dt); m.windup = null; continue; }
        m.windup.remaining -= dt;
        if (m.windup.remaining <= 0) {
          const act = m.windup.action;
          m.windup = null;
          // Перепроверка LoS на момент удара (как мили перепроверяет дистанцию) — не бьём сквозь стену,
          // если игрок ушёл за препятствие за время замаха.
          if (act === 'shoot') { if (this.hasLos(m.pos, target.pos)) this.monsterShoot(m, target); }
          else {
            const reach = m.radius + target.radius + MONSTER_MELEE_WHIFF_SLACK;
            if (vecLen(target.pos.x - m.pos.x, target.pos.y - m.pos.y) <= reach && this.hasLos(m.pos, target.pos)) this.monsterMelee(m, target);
          }
        }
        continue;
      }

      const behavior = behaviorFor(m.def.faction, behaviors);
      const losClear = this.hasLos(m.pos, target.pos);
      const action = stepMonsterAi(m, target.pos, behavior, losClear, noiseOf(target), dt);
      if (behavior.repositionMode === 'blink') this.tryBlink(m, target.pos, behavior, dt); // джинн-уклонение
      this.navChase(m, target.pos, w.grid, losClear, dt); // обход стен по BFS, когда не видит цель
      m.pos = moveWithCollision(m.pos, m.vel, m.radius, w.grid, dt, w.obstacles);
      if (action === 'attack' || action === 'shoot') {
        // attackCd только что выставлен ИИ = полный цикл атаки; замах — его доля (тот же baseWindupFrac, что у игрока).
        // windupMult >1 у конструктов — тяжёлый «телеграф» удара.
        const windupSec = m.attackCd * this.cfg.get('balance').melee.baseWindupFrac * behavior.windupMult;
        if (windupSec > 0) {
          m.windup = { remaining: windupSec, action };
          this.events.push({ type: 'monster-swing', id: m.id, windupMs: windupSec * 1000, x: m.pos.x, y: m.pos.y, facing: m.facing });
        } else if (action === 'attack') this.monsterMelee(m, target);
        else this.monsterShoot(m, target);
      }
    }

    // 3.5) Расталкивание сущностей по весу (монстры не слипаются, сквозь них не пройти).
    this.resolveCollisions();

    // 4) Снаряды: движение, стены, попадания.
    this.stepProjectiles(dt);

    // 5) Зачистка этажа (одноразовое событие).
    if (!this.floorCleared && this.monstersAlive === 0) {
      this.floorCleared = true;
      this.events.push({ type: 'floor-cleared' });
    }

    // 6) Чистка трупов: мёртвый монстр держится в w.monsters ещё CORPSE_LINGER_MS (клиенты успевают снять спрайт/куклу
    //    по alive=false + событию monster-died и отыграть коллапс), потом УДАЛЯЕТСЯ. Иначе снапшот растёт весь этаж →
    //    клиентский per-frame цикл по latest.monsters не сжимается (ms_world копится; критично для длинных/эндлес-забегов).
    for (let i = w.monsters.length - 1; i >= 0; i--) {
      const m = w.monsters[i]!;
      if (!m.alive && m.deadAt !== undefined && now - m.deadAt > CORPSE_LINGER_MS) w.monsters.splice(i, 1);
    }

    return this.events;
  }

  // ── Ввод/действия игрока ──────────────────────────────────
  private stepPlayerInput(p: PlayerEntity, snap: PlayerSnapshot, input: PlayerInput | undefined, dt: number): void {
    // Рывок: пока активен — быстрое движение вместо ввода (стан прерывает).
    if (p.dash) {
      if (p.stunTimer > 0) p.dash = null;
      else { this.stepDash(p, dt); return; }
    }
    const pm = this.dmods(p.debuffs);
    const stunned = p.stunTimer > 0;
    // Уклонение (dodge-рывок на пробел): универсальный рывок в направлении WASD (стоя — к прицелу), гейт
    // кулдауном/станом/ресурсом. Отменяет замах (выход из лока). Дальше — обычный stepDash (движение рывка).
    if (input?.dodge && !stunned && p.dodgeCd <= 0 && this.tryDodge(p, input)) { this.stepDash(p, dt); return; }
    // Стан полностью укореняет; во время удара/замаха/восстановления — идём МЕДЛЕННО (attackMoveMult),
    // а не колом («идти медленно и бить»). Facing обновляется в любом случае (целишься на ходу).
    const attacking = !!p.windup || p.attackCd > 0;
    const moveMult = stunned ? 0 : attacking ? snap.derived.attackMoveMult : 1;   // per-класс замедление при атаке (из класс-scaling)
    // ⚠ R7-01: взгляд — в [−π, π] и здесь, не только на проводе: боты и сим идут мимо `validateInput`, а `wrapAngle` конуса
    // удара на 1e17 отдаёт 0 для любого угла (взмах по кругу 360°).
    if (input && !stunned) p.facing = normalizeAngle(input.facing);
    const len = input ? vecLen(input.move.x, input.move.y) : 0;
    let want = { x: 0, y: 0 };
    if (input && moveMult > 0 && len > 0) {
      const speed = snap.derived.moveSpeed * pm.moveMult * moveMult;
      want = { x: (input.move.x / len) * speed, y: (input.move.y / len) * speed };
    }
    // ⭐ ИНЕРЦИЯ (`balance.moveInertia`): скорость едет к желаемой с ускорением, а не прыгает.
    // ⚠ СТАН УКОРЕНЯЕТ МГНОВЕННО и мимо инерции: «оглушён» не должен проезжать ещё полметра.
    const inr = this.cfg.get('balance').moveInertia;
    if (!inr.enabled || stunned) p.vel = want;
    else {
      const rate = (want.x !== 0 || want.y !== 0) ? inr.accel : inr.decel;   // трогаемся быстрее, чем тормозим
      const dx = want.x - p.vel.x, dy = want.y - p.vel.y, d = vecLen(dx, dy), step = rate * dt;
      p.vel = d <= step || d < 1e-6 ? want : { x: p.vel.x + (dx / d) * step, y: p.vel.y + (dy / d) * step };
    }
    p.pos = moveWithCollision(p.pos, p.vel, p.radius, this.world.grid, dt, this.world.obstacles);
    const held = this.saveHeld.has(p.id);   // сейв в транзакции сервера — не трогаем (R1-05)
    if (this.economy && !held) this.autoPickup(p); // прошёл над золотом — подобрал, клик не нужен

    if (stunned) return; // оглушён — ни атаки, ни каста, ни зелий
    if (input?.useBelt != null && !held) this.useBeltSlot(p, input.useBelt);
    if (input?.attack) this.tryPlayerAttack(p, snap);
    if (input?.cast != null) this.castSkill(p, snap, input.cast);
    // [E] сперва открывает сундук, и только потом подбирает: иначе, стоя над только что
    // высыпавшимся содержимым, второе нажатие открывало бы сундук, а не собирало добычу.
    if (input?.interact && !held && !this.openChest(p.id)) this.tryPickup(p);
  }

  /** Выпить расходник из слота пояса: единый эффект `drink`; расход ТОЛЬКО если сработал
   *  (полное HP чистым лечением не тратит зелье). Тот же путь, что серверный `useConsumable`. */
  private useBeltSlot(p: PlayerEntity, slot: number): void {
    const item = p.save.belt[slot];
    if (!item?.use) return;
    if (this.drink(p.id, item.use, item.baseId)) p.save.belt[slot] = null;
  }

  /**
   * ⭐ C-14: ЭФФЕКТ РАСХОДНИКА НА ГЕРОЯ — один для пояса ввода (`useBeltSlot`) и команды `useConsumable` комнаты. Мана — до
   * ЭФФЕКТИВНОГО потолка (ауры резервируют долю пула), как реген тика: у потолка зелье маны без эффекта и не тратится, и выше
   * потолка не наливает (иначе каст того же тика платил бы налитым сверх резерва). Правила «кто может пить» (жив, не оглушён) —
   * у вызывающего: тик не зовёт пояс у мёртвого и оглушённого, команда отказывает своим словом. `true` — было действие.
   * ⚠ C-11 (бафф-зелья): `baseId` — база выпитого; её бафф (`use.buffMods` на `buffDurationSec`) — тоже действие (`drinkBuff`).
   * Бафф отдавался «на сторону вызывающего», а серверный вызывающий его не вешал: зелье-бафф не выпивалось никогда (пояс молчал,
   * команда — «Нет эффекта»), «лечение + бафф» лечило и уходило без баффа, хотя подсказка обещает «Бафф на N сек».
   */
  drink(playerId: string, use: ConsumableUse, baseId?: string): boolean {
    const p = this.world.players[playerId];
    const snap = this.snaps.get(playerId);
    if (!p || !snap) return false;
    const d = snap.derived;
    const did = applyConsumable(p, use, d.maxHp, d.maxMana, effectivePool(d.maxMana, this.reservedFrac(p, 'mana')));
    const buffed = baseId !== undefined && this.drinkBuff(p, baseId);
    return did || buffed;
  }

  /**
   * ⚠ C-11 (бафф-зелья): бафф зелья — `skillBuffs['pot:<база>']` на полную длительность. Повтор ОСВЕЖАЕТ до полной (не прибавляет
   * сверху: 29 + 30 с растягивали бы бафф без предела); бафф и так полный — действия нет, зелье не тратится (R4-35).
   */
  private drinkBuff(p: PlayerEntity, baseId: string): boolean {
    const def = this.potionBuff(baseId);
    if (!def) return false;
    const key = POTION_BUFF + baseId;
    if ((p.skillBuffs[key] ?? 0) >= def.durationSec - 1e-6) return false;
    p.skillBuffs[key] = def.durationSec;
    return true;
  }

  /**
   * ⚠ C-11 (бафф-зелья): бафф зелья по определению базы в конфиге (`items.base`: `use.buffMods` + `use.buffDurationSec`) — живая
   * правка редактора сразу в игре, как у баффов скилов и печатей вставок. Нет модов или длительности — баффа нет.
   */
  private potionBuff(baseId: string): { mods: StatModifier[]; durationSec: number } | undefined {
    const b = this.cfg.get('items.base').find((x) => x.id === baseId);
    const u = b?.kind === 'consumable' ? b.use : undefined;
    const dur = u?.buffDurationSec ?? 0;
    return u?.buffMods?.length && dur > 0 ? { mods: u.buffMods, durationSec: dur } : undefined;
  }

  /** Замах удара/скилла как доля цикла атаки (масштабируется скоростью) + явный windup скилла. */
  private windupSec(attackCd: number, skillWindupSec: number): number {
    return attackCd * this.cfg.get('balance').melee.baseWindupFrac + skillWindupSec;
  }

  /** Событие реального свинга (принят: мана/КД/оружие прошли) — клиент рисует форму + льёт откат слота. */
  private emitSwing(p: PlayerEntity, ability: string, windupSec: number, cooldownSec: number, lockSec: number, chain = false): void {
    this.events.push({ type: 'swing', playerId: p.id, ability, windupMs: windupSec * 1000, cooldownMs: cooldownSec * 1000, lockMs: lockSec * 1000, x: p.pos.x, y: p.pos.y, facing: p.facing, ...(chain ? { chain: true } : {}) });
  }

  /**
   * Базовая атака игрока: СТАРТ — списание маны (маг. оружие), тайминг, замах + событие `swing`.
   * Само срабатывание (выбор руки/пакет/удар) — по завершении замаха (`executeBasicAttack`).
   */
  private tryPlayerAttack(p: PlayerEntity, snap: PlayerSnapshot): void {
    if (p.attackCd > 0 || p.windup) return;
    const hands = attackWeaponsOf(p.save, this.grip());
    const weapon = hands[p.swingHand % hands.length]; // рука этого свинга (инкремент — в исполнении)
    // Базовый удар магическим оружием (болт) — стоимость из конфига (деф. 0 = бесплатно, как физ.).
    if (weapon?.damageKind === 'magical') {
      const cost = this.cfg.get('balance').melee.basicManaCost;
      if (cost > 0) { if (p.mana < cost) return; p.mana -= cost; }
    }
    const pm = this.dmods(p.debuffs);
    const speedBonus = hands.length > 1 ? 1.2 : 1; // дуал-вилд бьёт чаще
    p.attackCd = 1 / Math.max(0.2, snap.derived.attackSpeed * speedBonus * pm.atkSpeedMult);
    this.makeNoise(p, 220);
    const windup = this.windupSec(p.attackCd, 0);
    this.emitSwing(p, 'attack', windup, p.attackCd, p.attackCd);
    if (windup > 0) { p.windup = { kind: 'attack', remaining: windup, loadout: loadoutSig(p) }; return; }
    this.executeBasicAttack(p, snap);
  }

  /** Срабатывание базовой атаки (по завершении замаха): выбор руки, пакет урона (крит здесь), удар/снаряд. */
  private executeBasicAttack(p: PlayerEntity, snap: PlayerSnapshot): void {
    const hands = attackWeaponsOf(p.save, this.grip());
    const weapon = hands[p.swingHand % hands.length];
    p.swingHand++;
    const pm = this.dmods(p.debuffs);
    const scaling = this.cfg.get('balance').weaponAttrScaling;
    const packet = buildAttackPacket(snap.derived, snap.attrs, weapon, scaling, this.weights(), this.rng);
    if (pm.outDamageMult !== 1) for (const t of Object.keys(packet) as DamageType[]) packet[t] *= pm.outDamageMult;
    const attacker = pm.accuracyMult !== 1 ? { ...snap.combat, accuracy: snap.combat.accuracy * pm.accuracyMult } : snap.combat;
    const at: AttackType = weapon?.attackType ?? 'melee';
    // onHit базовой атаки по составу пакета: физ-статус подтипа + стих-статусы по стихиям в ударе.
    const opts = this.packetOnHit(this.weaponHitOpts(weapon), packet);
    if (at === 'melee') this.meleeSwing(p, packet, attacker, weapon, opts);
    // Скорость снаряда: магический болт медленнее (ABILITY), физ. дальнобой — быстрый (PLAYER).
    else this.spawnProjectile(p, packet, attacker, weapon?.damageKind === 'magical' ? ABILITY_PROJ_SPEED : PLAYER_PROJ_SPEED, p.facing, { hitOpts: opts });
  }

  /** Взмах: дальность/дуга по оружию (копьё длиннее, топор шире). */
  private meleeSwing(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, weapon?: Item, opts?: HitOpts, rangeMult = 1, arcMult = 1): void {
    // Дальность/размах — базовые из конфига × оружие (копьё длиннее, топор шире) × множители скилла (attack).
    const mel = this.cfg.get('balance').melee;
    const range = mel.baseRange * (weapon?.reachMult ?? 1) * rangeMult;
    const arc = mel.baseArc * (weapon?.arcMult ?? 1) * arcMult;
    const hitOpts = opts ?? this.weaponHitOpts(weapon);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      const dx = m.pos.x - p.pos.x;
      const dy = m.pos.y - p.pos.y;
      if (vecLen(dx, dy) > range) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(this.wrap(ang - p.facing)) > arc) continue;
      if (!this.hasLos(p.pos, m.pos)) continue;   // R5-05: пика (×1.8) доставала сквозь стену в клетку
      this.hitMonster(p, m, packet, attacker, hitOpts);
    }
    this.hitEnemyPlayers(p, packet, attacker, hitOpts, (t) => {
      const dx = t.pos.x - p.pos.x, dy = t.pos.y - p.pos.y;
      if (vecLen(dx, dy) > range) return false;
      return Math.abs(this.wrap(Math.atan2(dy, dx) - p.facing)) <= arc && this.hasLos(p.pos, t.pos);
    });
  }

  /**
   * PvP-урон: атака игрока `p` бьёт ВРАЖЕСКИХ игроков, попавших в геометрический предикат `inRange`.
   * Вне арены (`world.pvp=false`) — no-op. Уважает спавн-иммунитет цели. Урон/смерть — через общий
   * `hitPlayer` (accuracy/evade/блок/броня/статусы), источник урона `by = p.id`.
   */
  private hitEnemyPlayers(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, opts: HitOpts, inRange: (t: PlayerEntity) => boolean): void {
    if (!this.world.pvp) return;
    const onHit = opts.onHit ?? [];
    for (const id of Object.keys(this.world.players)) {
      const t = this.world.players[id]!;
      if (t === p || !t.alive || t.spawnImmuneUntil > this.world.timeMs) continue;
      if (inRange(t)) this.hitPlayer(t, packet, attacker, onHit, p.id);
    }
  }

  /** Опции удара из сигнатур оружия (броне-пробитие/добивание/стан/дебаффы/отброс). */
  private weaponHitOpts(weapon?: Item): HitOpts {
    return {
      armorPen: weapon?.armorPenPct,
      lowHpBonusPct: weapon?.lowHpBonusPct,
      stunChance: weapon?.stunChance,
      onHit: weapon ? weaponDebuffs(weapon, this.cfg.get('phys-subtypes'), this.cfg.get('debuffs')) : [],
      knockback: weapon?.knockback,
      knockdownChance: this.weaponKnockdownChance(weapon),   // вклад веса оружия в шанс сбить с ног (тяжёлое роняет чаще)
    };
  }

  /** Вклад ОРУЖИЯ в шанс нокдауна: вес оружия × weaponWeightMult (кулаки/кинжал ~0, булава/молот — заметно). */
  private weaponKnockdownChance(weapon?: Item): number {
    const kd = this.cfg.get('balance').knockdown;
    if (!kd.enabled || !weapon) return 0;
    const w = this.weights().find((x) => x.id === weapon.weight)?.weight ?? 0;
    return w * kd.weaponWeightMult;
  }

  /** Форма урона скилла (общий шаг attack/cast) — см. `shapeSkillPacket`: множитель по scope + добавка стихии + конверсия. */
  private applySkillDamage(packet: DamagePacket, active: OffensiveAbility, rank: number, weapon: Item | undefined, element: DamageType): void {
    shapeSkillPacket(packet, {
      mult: active.damageMult * abilityRankMult(rank),
      multScope: active.multScope,
      addElementPct: active.addElementPct,
      convertPct: active.convertPct,
      baseType: weapon?.damageType ?? 'physical',
      element,
    });
  }

  /**
   * onHit по СОСТАВУ финального пакета (после конверсии): физ-статус подтипа держится только при наличии
   * физ. урона (при полной конверсии в стихию — гаснет, остаётся лишь стих-статус); + авто стих-проки по
   * стихиям в ударе, дедуп по виду (уже присутствующий вид не задваивается — им управляет явный статус скилла).
   */
  private packetOnHit(opts: HitOpts, packet: DamagePacket): HitOpts {
    return { ...opts, onHit: mergeElementOnHit(opts.onHit ?? [], packet, this.cfg.get('magic-subtypes'), this.cfg.get('debuffs')) };
  }

  // ── Активные скиллы ───────────────────────────────────────
  /** Способность узла ЕДИНОГО древа скилов по id (или undefined). */
  private activeById(_save: SaveState, nodeId: string): ActiveAbility | undefined {
    return activeAbilityOf(this.cfg, nodeId);
  }

  /** Узел доступен игроку: класс-ветка — только своему классу (без classId — всем). */
  private nodeUsable(save: SaveState, nodeId: string): boolean {
    const tree = this.cfg.get('skill-tree');
    const node = tree.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    const br = tree.branches.find((b) => b.id === node.branchId);
    return !br?.classId || br.classId === save.classId;
  }

  private pool(p: PlayerEntity, pool: ResourcePool): number {
    return pool === 'stamina' ? p.stamina : p.mana;
  }
  private take(p: PlayerEntity, pool: ResourcePool, amount: number): void {
    if (pool === 'stamina') p.stamina -= amount; else p.mana -= amount;
  }

  /**
   * Хватает ли ресурса под способность. Пулов ДВА: свой у носителя (`active.resource`) и чужой —
   * надбавка магических вставок (`extraCost`). Пулы по построению разные, поэтому проверяются
   * независимо: сложить их было бы неверно.
   */
  private canSpend(p: PlayerEntity, active: Cost, extra?: Extra): boolean {
    if (this.pool(p, active.resource) < active.manaCost) return false;
    return !extra || this.pool(p, extra.pool) >= extra.amount;
  }
  private spend(p: PlayerEntity, active: Cost, extra?: Extra): void {
    this.take(p, active.resource, active.manaCost);
    if (extra) this.take(p, extra.pool, extra.amount);
  }

  /**
   * ПОГАСШАЯ ВСТАВКА: маны не хватило на магическую часть — собираем ту же способность без неё.
   * Удар проходит физическим, вставка не применяется и не оплачивается. Решение юзера: билд не
   * должен вставать колом из-за пустого второго пула, а нехватка обязана читаться по урону сразу.
   */
  private affordableRes(p: PlayerEntity, nodeId: string, res: ResolvedActive): ResolvedActive {
    const ex = res.extraCost;
    if (!ex || this.pool(p, ex.pool) >= ex.amount) return res;
    return resolveActive(this.cfg, p.save, nodeId, { omitPools: [ex.pool] }) ?? res;
  }

  private castSkill(p: PlayerEntity, snap: PlayerSnapshot, nodeId: string): void {
    // ⚠ R4-05: КАСТУЕТСЯ ТОЛЬКО ВЫУЧЕННОЕ. `cast` приходит с провода как есть (сетевая схема проверяет лишь тип и
    // длину), а бинды к нему отношения не имеют. Прежнее `?? 1` исполняло ЛЮБОЙ узел своей ветки рангом 1 — без
    // уровня, смежности и очков: воин 1-го уровня бил, баффал и включал ауры 25-го и 40-го одним кадром с devtools.
    const rank = p.save.skills[nodeId] ?? 0;
    if (!(rank > 0) || !this.nodeUsable(p.save, nodeId)) return;   // не выучен / класс-ветка чужого класса
    // СО ВСТАВКАМИ: дальше всё (ресурс, КД, оружие, замах, исполнение) работает на ЭФФЕКТИВНОЙ
    // способности — именно поэтому вся система стоит на одном шве, а не на десятке правок.
    const full = resolveActive(this.cfg, p.save, nodeId);
    if (!full) return;
    const res = this.affordableRes(p, nodeId, full);
    // ⚠ R6-02: `res` — то, что ОПЛАЧИВАЕТСЯ здесь; замах уносит его с собой (`p.windup.res`), и удар бьёт именно им, а не
    // гнёздами сейва на момент удара: вставку, вставленную за замах, никто не оплатил, вынутую — уже оплатили.
    // Условная часть нужна УЖЕ ЗДЕСЬ: `active.speed` у атаки потребляется прямо в этом кадре —
    // из него считается `attackCd` (ниже). Надбавка к скорости, применённая только на ударе,
    // не доехала бы никуда. Поэтому правило такое: СКОРОСТЬ решается в начале замаха, а УРОН —
    // в момент попадания (`executeResolved` пересчитывает условие ещё раз, уже по свежему миру).
    const active = this.withConditional(p, res);

    switch (active.category) {
      // Ауры/стойки: вкл/выкл, эксклюзив-группа, резерв пула (мана/выносливость).
      case 'aura':
      case 'stance':
        this.toggleStance(p, snap, nodeId, active);
        return;
      // Временный бафф: стат-моды за ресурс на durationSec; не рефрешим, пока активен.
      // ⚠ R6-15: и свой ОТКАТ, как у прочих активок: без него повтор в кадр истечения держал бафф 100 % времени. ⭐ D4: откат — по
      // ОДНОМУ правилу (`buffTiming.ts`): по рангу (ранг выше потолка узла откат не режет), не короче действия с отдыхом баланса
      // (`buffMinRest`) — годные данные это держат сами (схема), зажим с предупреждением — для конфига мимо схемы. ⚠ R8-15: клиенту —
      // событие отката (залить слот), НЕ свинг: свинг — удар.
      case 'buff': {
        if ((p.skillBuffs[nodeId] ?? 0) > 0) return;
        if ((p.skillCd[nodeId] ?? 0) > 0) return;
        if (!this.canSpend(p, active, res.extraCost)) return;
        this.spend(p, active, res.extraCost);
        p.skillBuffs[nodeId] = active.durationSec;
        const cd = this.nodeCooldown(active, nodeId, rank);   // R21-05: то же правило — у кадра входа
        if (cd > 0) p.skillCd[nodeId] = cd;
        this.events.push({ type: 'cooldown', playerId: p.id, ability: nodeId, cooldownMs: (p.skillCd[nodeId] ?? 0) * 1000 });
        return;
      }
      // Атака: делит ОБЩИЙ attack-таймер (лок), тайминг от скорости атаки.
      case 'attack': {
        if (p.attackCd > 0 || p.windup) return;    // делит тайминг с базовой атакой; занят замахом
        if ((p.skillCd[nodeId] ?? 0) > 0) return;   // опц. персональный КД
        if (!this.weaponAllowed(p, active)) return; // не то оружие → скилл не срабатывает
        if (!this.canSpend(p, active, res.extraCost)) return;
        this.spend(p, active, res.extraCost);
        const pm = this.dmods(p.debuffs);
        // ⭐⭐ `speed` — СКОРОСТЬ ОДНОГО ВЗМАХА, а `hits` — СКОЛЬКО ИХ. Раньше и то и другое мерилось
        // целым скиллом: «3 удара, скорость ×2» ужимало ВСЮ способность в полцикла и выдавало три
        // урона одним кадром под одну анимацию. Теперь один взмах = `stepSec`, а серия = `hits` × `stepSec`.
        const stepSec = 1 / Math.max(0.2, snap.derived.attackSpeed * active.speed * pm.atkSpeedMult);
        const hits = Math.max(1, active.hits);
        p.attackCd = stepSec * hits;                 // общий attack-лок держит ВСЮ серию
        const cd = this.nodeCooldown(active, nodeId, rank);   // R21-05: то же правило — у кадра входа
        if (cd > 0) p.skillCd[nodeId] = cd;
        // ⚠ Замах считается от ОДНОГО взмаха (`stepSec`), а не от всей серии: иначе у трёхударного
        // скилла первый удар пришёлся бы на треть позже, чем у такого же одноударного.
        const windup = this.windupSec(stepSec, active.windupSec);
        // Окно свинга = ОДИН взмах: клиент ужимает клип под него, и каждый удар получает свою анимацию.
        this.emitSwing(p, nodeId, windup, Math.max(p.attackCd, p.skillCd[nodeId] ?? 0), stepSec);
        const series: AttackSeries = { hits, struck: 0, stepSec, windupSec: windup, recover: false };
        p.windup = { kind: 'skill', nodeId, rank, remaining: windup, series, res, loadout: loadoutSig(p) };
        if (windup <= 0) this.stepWindup(p, snap, 0);   // мгновенный замах: первый удар прямо сейчас, остаток серии — по таймеру
        return;
      }
      // Каст/проклятие: тайминг от скорости КАСТА (Интеллект), личный КД, НЕ делит attack-лок (lockMs=0).
      case 'cast':
      case 'curse': {
        if (p.windup) return;                       // занят замахом/каст-таймом
        if ((p.skillCd[nodeId] ?? 0) > 0) return;   // личный КД
        if (!this.weaponAllowed(p, active)) return;
        if (!this.canSpend(p, active, res.extraCost)) return;
        this.spend(p, active, res.extraCost);
        const cd = this.nodeCooldown(active, nodeId, rank);   // R21-05: то же правило — у кадра входа
        if (cd > 0) p.skillCd[nodeId] = cd;
        const castTime = active.castTimeSec / Math.max(0.2, snap.derived.castSpeed);
        this.emitSwing(p, nodeId, castTime, Math.max(castTime, p.skillCd[nodeId] ?? 0), 0);
        if (castTime > 0) { p.windup = { kind: 'skill', nodeId, rank, remaining: castTime, res, loadout: loadoutSig(p) }; return; }
        this.executeResolved(p, snap, res, rank);
        return;
      }
    }
  }

  /** Проверка ограничений оружия скилла (общая с клиентским UI — `skillWeaponAllowed`). */
  private weaponAllowed(p: PlayerEntity, active: OffensiveAbility | CurseAbility): boolean {
    return skillWeaponAllowed(active, p.save.equipment.weapon, p.save.equipment.offhand);
  }

  /** Тик замаха: стан/ошеломление сбивает удар (если не устоял), иначе — срабатывание. */
  private stepWindup(p: PlayerEntity, snap: PlayerSnapshot, dt: number): void {
    const wu = p.windup;
    if (!wu) return;
    const dazed = (p.debuffs.daze?.stacks ?? 0) > 0;
    if ((p.stunTimer > 0 || dazed) && !this.rng.chance(snap.derived.interruptResist)) {
      p.windup = null; // прерван — мана уже потрачена, эффект не сработал
      return;
    }
    wu.remaining -= dt;
    if (wu.remaining > 0) return;
    // ⚠ R6-02: снаряжение сменилось за замах (или между взмахами серии) — удар пропал, серия оборвана; цена и откат уже
    // списаны, как у сбитого станом. Скорость замаха бралась от прежнего, и урон нового к ней не приклеится.
    if (loadoutSig(p) !== wu.loadout) { p.windup = null; return; }
    if (wu.kind === 'attack') { p.windup = null; this.executeBasicAttack(p, snap); return; }
    const s = wu.series;
    // ДОБОЙ ЦИКЛА КОНЧИЛСЯ → НАЧИНАЕТСЯ СЛЕДУЮЩИЙ ВЗМАХ СЕРИИ: свой свинг (а значит своя анимация
    // и свой звук) и свой замах. Именно этого не было: сколько ударов написано — столько и должно быть.
    if (s?.recover) {
      s.recover = false;
      // ⚠ ПЕРЕНОС ОСТАТКА (`+=`, а не `=`): `remaining` здесь уже ушёл в минус на долю кадра, и если
      // её выбрасывать, каждый взмах опаздывает на полкадра, а серия копит эту ошибку. С переносом
      // темп серии точный: три взмаха ровно через `stepSec`, а не «через 0.517 вместо 0.5».
      wu.remaining += s.windupSec;
      this.emitSwing(p, wu.nodeId, s.windupSec, Math.max(p.attackCd, p.skillCd[wu.nodeId] ?? 0), s.stepSec, true);
      return;
    }
    // Способность — оплаченная на касте (R6-02), а не пересобранная по гнёздам сейва. Правило оружия скила — ещё раз на
    // КАЖДОМ взмахе: подпись снаряжения та же, но проверка не должна держаться на одной лишь подписи.
    const r = wu.res;
    const a = r.active;
    if ((a.category === 'attack' || a.category === 'cast' || a.category === 'curse') && !this.weaponAllowed(p, a)) { p.windup = null; return; }
    // ⚠ ПРОКИ ВСТАВОК — РОВНО ОДИН РАЗ ЗА ПРИМЕНЕНИЕ (на первом взмахе): цена и откат тоже списываются
    // один раз, и печать «при касте», сработавшая трижды за один каст, была бы скрытым ×3.
    this.executeResolved(p, snap, r, wu.rank, !s || s.struck === 0);
    if (!s) { p.windup = null; return; }
    s.struck++;
    if (s.struck >= s.hits) { p.windup = null; return; }
    s.recover = true;
    wu.remaining += Math.max(0, s.stepSec - s.windupSec);   // остаток цикла до следующего взмаха (с переносом кадровой доли)
  }

  /** Группа эксклюзива тогла (только у аур/стоек). */
  private toggleGroupOf(a: ActiveAbility | undefined): string | undefined {
    return a && (a.category === 'aura' || a.category === 'stance') ? a.toggleGroup : undefined;
  }

  /** Включает/выключает тогл (аура/стойка): гасит другие в его эксклюзив-группе, резервирует ману. */
  private toggleStance(p: PlayerEntity, snap: PlayerSnapshot, nodeId: string, active: ToggleAbility): void {
    if (p.toggles.includes(nodeId)) { p.toggles = p.toggles.filter((t) => t !== nodeId); return; } // выкл
    // Эксклюзив-группа: одновременно активна только одна стойка группы.
    if (active.toggleGroup) {
      p.toggles = p.toggles.filter((t) => this.toggleGroupOf(this.activeById(p.save, t)) !== active.toggleGroup);
    }
    const pool: 'mana' | 'stamina' = active.resource === 'stamina' ? 'stamina' : 'mana';
    const reserveFrac = this.reservedFrac(p, pool) + (active.reservePct ?? 0);
    if (reserveFrac >= 1) return; // нельзя зарезервировать весь пул
    p.toggles.push(nodeId);
    const max = pool === 'stamina' ? snap.derived.maxStamina : snap.derived.maxMana;
    const effMax = effectivePool(max, reserveFrac);
    if (pool === 'stamina') { if (p.stamina > effMax) p.stamina = effMax; }
    else if (p.mana > effMax) p.mana = effMax; // сразу подрезать под новый резерв
  }

  /** Доля зарезервированного пула (мана/выносливость) активными тоглами (кап 0.9). */
  private reservedFrac(p: PlayerEntity, pool: 'mana' | 'stamina'): number {
    return reservedFrac(this.cfg, p.toggles, pool);
  }

  /**
   * ⚠ V-RF-01: ПРИБАВКА К ПУЛУ — ДО ЭФФЕКТИВНОГО ПОТОЛКА (резерв аур/стоек), как у зелья (C-14) и регена. Вампиризм маны и
   * «мана за убийство» клали до ПОЛНОГО пула: реген подрезал лишнее лишь на следующем тике, а каст первого шага того тика
   * успевал заплатить маной, которую аура держит в резерве. Выносливость — тем же правилом (своих прибавок у неё пока нет).
   */
  private gainPool(p: PlayerEntity, pool: 'mana' | 'stamina', max: number, amount: number): void {
    const cap = effectivePool(max, this.reservedFrac(p, pool));
    const cur = pool === 'mana' ? p.mana : p.stamina;
    if (!(amount > 0) || cur >= cap) return;
    if (pool === 'mana') p.mana = Math.min(cap, cur + amount); else p.stamina = Math.min(cap, cur + amount);
  }

  /**
   * ⚠ R4-05: ТОГЛЫ И БАФФЫ ДЕРЖАТСЯ НА ВЫУЧЕННОМ. Сброс скилов (`respecSkills`) — команда города между тиками, сессию
   * она не зовёт: включённая до него аура жила бы в `toggles` дальше — с бонусами и резервом за возвращённые очки.
   * Баффы вставок (`ins:`) узла в дереве не имеют: они оплачены на касте и доживают свой срок.
   * ⚠ V-RF-02: и ЗАМАХ скила (с ним — вся серия взмахов) держится на ранге, которым оплачен: сброс посреди замаха вернул очки, а
   * замах доживал и бил узлом ранга 0 (подпись R6-02 — снаряжение и тоглы, скилы в неё не входят). Ранг упал ниже оплаченного —
   * замах пропал, как сбитый станом: цена и откат списаны. Докупленный ранг замаху не мешает — он бьёт оплаченным.
   */
  private dropUnlearned(p: PlayerEntity): void {
    const learned = (id: string): boolean => (p.save.skills[id] ?? 0) > 0;
    if (!p.toggles.every(learned)) p.toggles = p.toggles.filter(learned);
    // Печать вставки (`ins:`) и бафф зелья (`pot:`, C-11) — не узлы древа: сброс скилов их не снимает.
    for (const k of Object.keys(p.skillBuffs)) if (!k.startsWith('ins:') && !k.startsWith(POTION_BUFF) && !learned(k)) delete p.skillBuffs[k];
    const wu = p.windup;
    if (wu?.kind === 'skill' && (p.save.skills[wu.nodeId] ?? 0) < wu.rank) p.windup = null;
  }

  /** Рантайм-стат-моды поверх сейва: buffMods активных тоглов + временных баффов. */
  private runtimeMods(p: PlayerEntity): StatModifier[] {
    if (p.toggles.length === 0 && Object.keys(p.skillBuffs).length === 0) return [];
    const mods = toggleBuffMods(this.cfg, p.toggles);
    for (const id of Object.keys(p.skillBuffs)) {
      // Баффы вставок (тип «Печать») узла в дереве не имеют — ищем их в конфиге вставок.
      if (id.startsWith('ins:')) {
        const ab = this.cfg.get('skill-inserts').find((x) => x.id === id.slice(4))?.proc?.ability;
        if (ab?.category === 'buff') mods.push(...(ab.buffMods ?? []));
        continue;
      }
      // ⚠ C-11 (бафф-зелья): бафф выпитого зелья — моды его базы.
      if (id.startsWith(POTION_BUFF)) { mods.push(...(this.potionBuff(id.slice(POTION_BUFF.length))?.mods ?? [])); continue; }
      const a = this.activeById(p.save, id);
      if (a && (a.category === 'buff' || a.category === 'aura' || a.category === 'stance')) mods.push(...(a.buffMods ?? []));
    }
    return mods;
  }

  private scaling(): number {
    return this.cfg.get('balance').weaponAttrScaling;
  }

  /** Хват полуторного — живые ручки `balance.versatile`, тот же перевод, что у деривации (⚠ C-15: не зашитое умолчание). */
  private grip(): GripTuning {
    return gripOf(this.cfg.get('balance').versatile);
  }

  /**
   * ⭐ C-11: ОРУЖИЕ «КАК ЕГО ДЕРЖАТ» — для скилов (атака и каст), как `attackWeaponsOf` для базового удара: полуторное со щитом —
   * урезанная копия (`versatile.ts`). Раньше скилы брали сырое двуручное из сейва: «Рассечение» со щитом било полным двуручным уроном.
   */
  private heldWeapon(p: PlayerEntity): Item | undefined {
    return asHeld(p.save.equipment.weapon, p.save, this.grip());
  }

  private weights(): ConfigShapes['weapon-weights'] {
    return this.cfg.get('weapon-weights');
  }

  /**
   * Исполнить способность СО ВСТАВКАМИ: сперва сам скил, потом доп. эффекты вставок.
   * Порядок важен: волна холода должна добивать после удара, а не вместо него.
   */
  private executeResolved(p: PlayerEntity, snap: PlayerSnapshot, res: ResolvedActive, rank: number, withProcs = true): void {
    this.executeAbility(p, snap, this.withConditional(p, res), rank);
    if (withProcs && res.procs.length) this.fireInsertProcs(p, snap, res.procs, rank);
  }

  /**
   * УСЛОВНАЯ ЧАСТЬ ВСТАВОК. `resolveActive` — чистая функция и мира не видит, поэтому надбавку
   * вроде «скорость растёт с числом кровоточащих рядом» считаем здесь, в момент удара.
   *
   * Зовётся ДВАЖДЫ и намеренно: на касте (оттуда берётся `attackCd`, то есть скорость замаха)
   * и на ударе (там решается урон — за время замаха картина вокруг успевает поменяться).
   *
   * Цену и откат условие НЕ трогает: они списываются один раз на касте, и менять их задним
   * числом нечестно по отношению к игроку.
   */
  private withConditional(p: PlayerEntity, res: ResolvedActive): ActiveAbility {
    let out = res.active;
    for (const { insert, rank } of res.applied) {
      const w = insert.tune?.when;
      if (!w) continue;
      const stacks = Math.min(w.maxStacks, this.countCondition(p, w));
      if (stacks <= 0) continue;
      // Клонируем ТОЛЬКО когда условие сработало: иначе поехал бы инвариант «пустые гнёзда
      // возвращают тот же объект», на котором стоят все существующие активки.
      if (out === res.active) out = structuredClone(res.active) as ActiveAbility;
      const k = 1 + insert.perRank.gain * (Math.max(1, rank) - 1);   // ранг усиливает и условную часть
      if (out.category === 'attack' && w.speedPer) out.speed *= 1 + w.speedPer * k * stacks;
      if ((out.category === 'attack' || out.category === 'cast') && w.damagePer) {
        out.damageMult *= 1 + w.damagePer * k * stacks;
      }
    }
    return out;
  }

  /** Сколько «стаков» условия набралось прямо сейчас. */
  private countCondition(p: PlayerEntity, w: { kind: string; radius: number }): number {
    if (w.kind === 'lowHp') return p.hp / Math.max(1, this.snaps.get(p.id)?.derived.maxHp ?? 1) <= 0.35 ? 1 : 0;
    const kind = w.kind === 'burningNearby' ? 'burn' : 'bleed';
    let n = 0;
    for (const m of this.world.monsters) {
      if (!m.alive || !m.debuffs[kind]) continue;
      if (vecLen(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= w.radius) n++;
    }
    return n;
  }

  /**
   * ДОП. ЭФФЕКТЫ ВСТАВОК при использовании — тот же механизм и тот же гард, что у проков
   * аффиксов (`rollHitProcs`): без `procActive` волна с проком вызвала бы сама себя.
   *
   * `on: 'hit'` здесь НЕ срабатывает осознанно: снаряды бьют позже кадра запуска, и узел-источник
   * надо протаскивать через `world.projectiles` — это отдельный заход.
   */
  private fireInsertProcs(p: PlayerEntity, snap: PlayerSnapshot, procs: readonly InsertProc[], rank: number): void {
    if (this.procActive) return;
    this.procActive = true;
    try {
      for (const pr of procs) {
        if (pr.on !== 'cast') continue;
        if (pr.chance < 1 && !this.rng.chance(pr.chance)) continue;
        // ⚠ Прок отдельно НЕ оплачивается: у вставки один ценник на всё, что она делает, и он
        // списан на применении носителя. Не хватило — вставка вообще не применилась (погасла),
        // и прока в списке уже нет.
        // Печать (бафф на себя) не проходит через `executeAbility`: тот бьёт по миру, а бафф —
        // состояние игрока. Ключ с префиксом `ins:` — чтобы не столкнуться с id узлов дерева.
        // ⭐ D4: и у печати СВОЙ ОТКАТ (`skillCd['ins:<вставка>']`, один на все скилы с этой вставкой) — по правилу баффа: не короче её
        // действия на ранге донора с отдыхом. Раньше печать освежалась каждым применением носителя: на спамном ударе — 100 % времени.
        // Бросок шанса — выше, до отката: поток бросков мира тот же.
        if (pr.ability.category === 'buff') {
          const key = 'ins:' + pr.insertId;
          if ((p.skillCd[key] ?? 0) > 0) continue;
          p.skillBuffs[key] = pr.ability.durationSec;
          p.skillCd[key] = clampBuffCooldown(pr.ability.cooldown, pr.ability.durationSec, this.cfg.get('balance').buffMinRest, key);
          continue;
        }
        this.executeAbility(p, snap, pr.ability, rank);
      }
    } finally { this.procActive = false; }
  }

  /** Диспетчер активной способности по категории (после списания маны/КД/замаха). */
  private executeAbility(p: PlayerEntity, snap: PlayerSnapshot, active: ActiveAbility, rank: number): void {
    if (active.category === 'attack') { this.weaponAttack(p, snap, active, rank); return; }
    if (active.category === 'curse') { this.applyCurse(p, active); return; }
    if (active.category === 'cast') {
      const element = active.element ?? abilityElementOf(active.abilityId);
      const weapon = this.heldWeapon(p);   // ⚠ C-11: полуторное со щитом — урезанным, как у базового удара
      const pk = this.castPacket(snap, weapon, active, rank, element);
      const opts = this.skillOpts(active, element, weapon, pk);   // статусы по итоговому (конвертированному) составу
      const attacker = snap.combat;
      switch (active.shape) {
        case 'dash': this.doDashAttack(p, pk, attacker, active, rank, opts); break;
        case 'leap': this.doLeap(p, pk, attacker, active, rank, opts); break;
        case 'boomerang': this.skillBoomerang(p, pk, attacker, active, opts); break;
        case 'nova': case 'ground': case 'meteor': this.skillNova(p, pk, attacker, active, opts); break;
      }
    }
    // aura/stance/buff обрабатываются в castSkill, не здесь.
  }

  /**
   * Пакет урона каста: состав урона ОРУЖИЯ ×damageMult×ранг, затем доля `convertPct` всего урона
   * переносится в стихию каста, остальное — состав оружия. Совпал посох по стихии → весь урон в неё.
   */
  private castPacket(snap: PlayerSnapshot, weapon: Item | undefined, active: CastAbility, rank: number, element: DamageType): DamagePacket {
    const packet = buildAttackPacket(snap.derived, snap.attrs, weapon, this.scaling(), this.weights(), this.rng);
    this.applySkillDamage(packet, active, rank, weapon, element);
    return packet;
  }

  /**
   * АТАКА-СКИЛЛ = удар/выстрел ОРУЖИЕМ + моды скилла: геометрия и СОСТАВ урона — от оружия, урон
   * ×damageMult×ранг (состав сохраняется), эффекты (стан/отброс/статус) — из `opts`. Мили → взмах по
   * ВСЕМ в дуге; дальнобой/маг → 1..N снарядов (веер `count`/`spread`, урон каждой = damageMult).
   */
  private weaponAttack(p: PlayerEntity, snap: PlayerSnapshot, active: AttackAbility, rank: number): void {
    const weapon = this.heldWeapon(p);   // ⚠ C-11: полуторное со щитом — урезанным, как у базового удара
    const element = active.element ?? abilityElementOf(active.abilityId);
    const pm = this.dmods(p.debuffs);
    const packet = buildAttackPacket(snap.derived, snap.attrs, weapon, this.scaling(), this.weights(), this.rng);
    this.applySkillDamage(packet, active, rank, weapon, element);   // множитель по scope + доб.стихия + конверсия
    if (pm.outDamageMult !== 1) for (const t of Object.keys(packet) as DamageType[]) packet[t] *= pm.outDamageMult;   // дебафф раны — на весь урон
    const attacker = pm.accuracyMult !== 1 ? { ...snap.combat, accuracy: snap.combat.accuracy * pm.accuracyMult } : snap.combat;
    const opts = this.skillOpts(active, element, weapon, packet);   // статусы по итоговому составу + скилл-эффекты
    const at: AttackType = weapon?.attackType ?? 'melee';
    // ⚠ ОДИН ВЫЗОВ = ОДИН ВЗМАХ. `hits` здесь НЕ читается намеренно: серию ведёт таймер замаха
    // (`AttackSeries`), который зовёт эту функцию заново на каждый удар. Цикл в кадре, который тут
    // стоял раньше, давал три урона одной анимацией — и три КОПИИ одного броска урона: пакет-то один.
    if (at === 'melee') { this.meleeSwing(p, packet, attacker, weapon, opts, active.rangeMult, active.arcMult); return; }
    // Дальнобой/маг: веер из `count` снарядов со `spread`; урон каждой = damageMult (для веера ставь ниже).
    const n = Math.max(1, active.count), spread = active.spread;
    const speed = weapon?.damageKind === 'magical' ? ABILITY_PROJ_SPEED : PLAYER_PROJ_SPEED;
    for (let i = 0; i < n; i++) {
      const off = n > 1 ? -spread / 2 + (spread * i) / (n - 1) : 0;
      this.spawnProjectile(p, packet, attacker, speed, p.facing + off, { pierce: active.pierce, hitOpts: opts });
    }
  }

  /** Рывок (cast dash): урон монстрам вдоль траектории (коридор = размах оружия) + движение-рывок. */
  private doDashAttack(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: CastAbility, rank: number, opts: HitOpts): void {
    const dir = p.facing;
    const dist = active.dashDist > 0 ? active.dashDist : 130;
    const mel = this.cfg.get('balance').melee;
    const weapon = this.heldWeapon(p);
    const halfW = swingHalfWidth(mel.baseRange * (weapon?.reachMult ?? 1), mel.baseArc * (weapon?.arcMult ?? 1));
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(dir) * dist, y: Math.sin(dir) * dist }, p.radius, this.world.grid, 1, this.world.obstacles);
    // R5-05: коридор рывка шире стены в клетку — цель достаётся, только если видна с ближней точки пути.
    const reach = (at: Vec2): boolean => this.distToSegment(at, from, to) <= halfW && this.hasLos(this.closestOnSegment(at, from, to), at);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (reach(m.pos)) this.hitMonster(p, m, packet, attacker, opts);
    }
    this.hitEnemyPlayers(p, packet, attacker, opts, (t) => reach(t.pos));
    this.launchDash(p, dir, from, to, active, rank);
  }

  /** Прыжок (cast leap): перемещение вперёд БЕЗ урона по пути + AoE-удар в точке приземления. Уязвим. */
  private doLeap(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: CastAbility, rank: number, opts: HitOpts): void {
    const dir = p.facing;
    const dist = active.dashDist > 0 ? active.dashDist : 150;
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(dir) * dist, y: Math.sin(dir) * dist }, p.radius, this.world.grid, 1, this.world.obstacles);
    const r = active.radius > 0 ? active.radius : 60;
    // R5-05: удар приземления — от точки приземления и только по видимым из неё (прыжок в стену не бьёт за неё).
    const reach = (at: Vec2): boolean => vecLen(at.x - to.x, at.y - to.y) <= r && this.hasLos(to, at);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (reach(m.pos)) this.hitMonster(p, m, packet, attacker, opts);
    }
    this.hitEnemyPlayers(p, packet, attacker, opts, (t) => reach(t.pos));
    this.launchDash(p, dir, from, to, active, rank);
  }

  /**
   * Уклонение: универсальный dodge-рывок (пробел). Направление = WASD (`input.move`), стоя — прицел (`input.facing`).
   * Позиционное (без i-frames): уход из зоны удара + whiff-окно монстров. В рывке игрок «тяжёлый» (расталкивает).
   * `lockFacing`: НЕ разворачивает игрока по движению (в отличие от скилл-рывков) — держит прицел, чтобы кайтить
   * лицом к цели (прыжок назад = отскок, а не разворот спиной). Гейт КД + опц. выносливостью. Отменяет замах.
   */
  private tryDodge(p: PlayerEntity, input: PlayerInput): boolean {
    const cfg = this.cfg.get('balance').dodge;
    if (cfg.staminaCost > 0 && p.stamina < cfg.staminaCost) return false;   // не хватает выносливости
    const len = vecLen(input.move.x, input.move.y);
    const dir = len > 1e-4 ? Math.atan2(input.move.y, input.move.x) : input.facing;   // WASD или прицел (стоя)
    if (cfg.staminaCost > 0) p.stamina -= cfg.staminaCost;
    p.dodgeCd = cfg.cooldownSec;
    p.windup = null;   // отмена замаха — выход из анимационного лока
    const speed = Math.max(1, cfg.speed);
    p.dash = { dx: Math.cos(dir), dy: Math.sin(dir), speed, remaining: cfg.distance / speed, weightMult: cfg.weightMult, hitIds: [], lockFacing: true };
    this.events.push({ type: 'dodge', playerId: p.id, x: p.pos.x, y: p.pos.y, dir });
    return true;
  }

  /** Запуск движения рывка/прыжка к точке `to` (расталкивание весом, `weightMult`). */
  private launchDash(p: PlayerEntity, dir: number, from: Vec2, to: Vec2, active: CastAbility, rank: number): void {
    const travel = vecLen(to.x - from.x, to.y - from.y);
    const speed = active.dashSpeed * abilityRankMult(rank);
    p.dash = { dx: Math.cos(dir), dy: Math.sin(dir), speed, remaining: speed > 0 ? travel / speed : 0, weightMult: 1 + active.dashWeightBonus / 100, hitIds: [] };
  }

  /**
   * Полные опции удара скилла (attack/cast): оружейные сигнатуры → onHit по составу пакета (physSub-гейт +
   * стих-проки) → скилл-эффекты (гарант. стан/отброс + ЯВНЫЙ статус, переопределяющий авто того же вида).
   */
  private skillOpts(active: OffensiveAbility, element: DamageType, weapon: Item | undefined, packet: DamagePacket): HitOpts {
    const base: HitOpts = weapon ? this.weaponHitOpts(weapon) : {};
    return this.skillExtraOpts(this.packetOnHit(base, packet), active, element);
  }

  /** Скилл-эффекты поверх опций: отброс(шанс)/гарант. стан + ЯВНЫЙ статус (kind из ailment/стихии), переопределяющий авто того же вида. */
  private skillExtraOpts(opts: HitOpts, active: OffensiveAbility, element: DamageType): HitOpts {
    if (active.knockback) opts.knockback = active.knockback;
    opts.shoveChance = active.shoveChance;
    if (active.stunSec) opts.stunSec = active.stunSec;
    // Нокдаун: добавка к шансу (поверх веса оружия) + гарант скилла (knockdownSec>0 = 100%).
    if (active.knockdownChance) opts.knockdownChance = (opts.knockdownChance ?? 0) + active.knockdownChance;
    if (active.knockdownSec) opts.knockdownSec = active.knockdownSec;
    if (active.ailment) {
      const kind = active.ailment.kind ?? this.cfg.get('magic-subtypes').find((d) => d.id === element)?.ailment;
      if (kind) {
        const al = active.ailment;
        // DoT-статусы (поджиг/яд/кровотечение) — сила = доля от урона удара (magPerDamage); прочие — флэт.
        const ail: DebuffApply = { kind, chance: al.chance, mag2: al.mag2, maxStacks: al.maxStacks, durationMs: al.durationMs, ...(isDotKind(kind) ? { mag: 0, magPerDamage: al.mag } : { mag: al.mag }) };
        opts.onHit = [...(opts.onHit ?? []).filter((d) => d.kind !== kind), ail];  // явный переопределяет авто того же вида
      }
    }
    return opts;
  }

  /**
   * Нова/AoE (cast shape nova/ground/meteor): по всем в радиусе вокруг игрока, КОГО ОН ВИДИТ.
   * ⚠ R5-05: только радиус — и маг из коридора выжигал комнату босса за запертой дверью (радиус 150 — почти пять клеток):
   * монстр отвечает лишь по прямой видимости, дверь не даёт ему и пути. Видимость — та же, что у монстра (`hasLos`).
   */
  private skillNova(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: CastAbility, opts: HitOpts): void {
    const radius = active.radius || ABILITY_AOE_RADIUS;
    const reach = (at: Vec2): boolean => vecLen(at.x - p.pos.x, at.y - p.pos.y) <= radius && this.hasLos(p.pos, at);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (reach(m.pos)) this.hitMonster(p, m, packet, attacker, opts);
    }
    this.hitEnemyPlayers(p, packet, attacker, opts, (t) => reach(t.pos));
  }

  /** Бумеранг (cast boomerang): летит вперёд, разворачивается к владельцу, бьёт на лету в обе стороны. */
  private skillBoomerang(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: CastAbility, opts: HitOpts): void {
    const dir = p.facing;
    this.world.projectiles.push({
      id: this.world.nextId++, pos: { ...p.pos },
      vel: { x: Math.cos(dir) * ABILITY_PROJ_SPEED, y: Math.sin(dir) * ABILITY_PROJ_SPEED },
      radius: PROJ_HIT_RADIUS, ttl: 4, owner: 'player', ownerId: p.id,
      packet, attacker, hitOpts: opts,
      boomerang: true, origin: { ...p.pos }, returning: false, maxRange: active.radius || 320, hitIds: [],
    });
  }

  /** Шаг рывка: быстрое движение в направлении рывка; стены останавливают, урон уже нанесён в doDashAttack. */
  private stepDash(p: PlayerEntity, dt: number): void {
    const d = p.dash!;
    if (!d.lockFacing) p.facing = Math.atan2(d.dy, d.dx);   // скилл-рывок разворачивает по движению; уклонение (lockFacing) держит прицел
    const bx = p.pos.x, by = p.pos.y;
    p.vel = { x: d.dx * d.speed, y: d.dy * d.speed };
    p.pos = moveWithCollision(p.pos, p.vel, p.radius, this.world.grid, dt, this.world.obstacles);
    d.remaining -= dt;
    if (d.remaining <= 0 || vecLen(p.pos.x - bx, p.pos.y - by) < 0.5) p.dash = null; // конец или упор в стену
  }

  /** Вес (масса) монстра для расталкивания: базовый вес × множитель чемпиона. */
  private monsterMass(m: MonsterEntity): number {
    const mult = m.def.rarity === 'unique' ? this.cfg.get('balance').collision.uniqueWeightMult : 1;
    return m.def.weight * mult;
  }

  /**
   * Ролл нокдауна (сбить с ног) при попадании по монстру. Шанс аддитивный: база + вклад оружия/скилла
   * (`opts.knockdownChance`), под потолком `maxChance`, минус сопротивление по весу цели (тяжёлые устойчивее).
   * Гарант от скилла (`opts.knockdownSec>0`) — в обход шанса/сопротивления. Роняет: `downTimer` (лежит+встаёт),
   * снимает стан/замах, шлёт событие с направлением падения (ОТ атакующего). Возвращает true, если сбит.
   */
  private tryKnockdown(killer: PlayerEntity, m: MonsterEntity, opts: HitOpts, damage: number): boolean {
    const kd = this.cfg.get('balance').knockdown;
    if (!kd.enabled || m.downTimer > 0) return false;   // выкл. или уже лежит
    const guaranteed = (opts.knockdownSec ?? 0) > 0;
    let downSec: number;
    if (guaranteed) {
      downSec = opts.knockdownSec!;                      // скилл роняет гарантированно (в обход шанса/сопротивления)
    } else {
      const raw = Math.min(kd.maxChance, kd.chanceBase + (opts.knockdownChance ?? 0));   // база + оружие + скилл, под потолком
      const resist = Math.min(0.95, this.monsterMass(m) * kd.targetWeightResist);        // тяжёлые устойчивее
      if (!this.rng.chance(raw * (1 - resist))) return false;
      downSec = kd.downSec;
    }
    m.downTimer = downSec + kd.riseSec;   // лежит (downSec) + встаёт (riseSec) — весь период беспомощен
    m.stunTimer = 0; m.windup = null;     // нокдаун поглощает стан/замах
    const a = Math.atan2(m.pos.y - killer.pos.y, m.pos.x - killer.pos.x);   // валится ОТ атакующего
    // Отлёт от силы удара (как смерть): дистанция ×= масштаб урона (доля от maxHP × dmgScale), в клампе [0.4, 2].
    const frac = m.def.hp > 0 ? damage / m.def.hp : 0;
    const dist = kd.knockbackDist * Math.max(0.4, Math.min(1.5, 0.4 + frac * kd.knockbackDmgScale));   // множитель урона в клампе [0.4, 1.5] (не улетает за горизонт от сильного удара)
    const sec = Math.max(0.01, kd.knockbackSec);
    m.knock = dist > 0.5 ? { dx: Math.cos(a), dy: Math.sin(a), remaining: sec, speed: dist / sec } : null;   // авторитетный глайд (сервер двигает pos)
    this.events.push({ type: 'knockdown', id: m.id, dx: Math.cos(a), dy: Math.sin(a) });
    return true;
  }

  /** Расталкивает пересекающиеся сущности по массе (вес). Игрок в рывке тяжелее (weightMult). */
  private resolveCollisions(): void {
    const bal = this.cfg.get('balance');
    if (!bal.collision.enabled) return;
    const wt: WeightTables = {
      base: bal.weight.base,
      shield: bal.weight.shield,
      armorClasses: this.cfg.get('armor-classes'),
      weaponWeights: this.cfg.get('weapon-weights'),
    };
    const bodies: CollisionBody[] = [];
    for (const id of Object.keys(this.world.players)) {
      const p = this.world.players[id]!;
      if (!p.alive) continue;
      const mass = playerWeight(p.save, wt) * (p.dash ? p.dash.weightMult : 1);
      bodies.push({ pos: p.pos, radius: p.radius, mass });
    }
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      bodies.push({ pos: m.pos, radius: m.radius, mass: this.monsterMass(m) });
    }
    resolveEntityCollisions(bodies, this.world.grid, bal.collision.iterations, this.world.obstacles);
  }

  /** Проклятие (curse): врагам в радиусе, КОГО ВИДНО (R5-05, как нова), — статус-дебаф (по стихии) и/или притягивание агро (taunt). */
  private applyCurse(p: PlayerEntity, active: CurseAbility): void {
    const kind = active.ailment ? (active.ailment.kind ?? this.cfg.get('magic-subtypes').find((d) => d.id === (active.element ?? 'physical'))?.ailment) : undefined;
    const reach = (at: Vec2): boolean => vecLen(at.x - p.pos.x, at.y - p.pos.y) <= active.radius && this.hasLos(p.pos, at);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (!reach(m.pos)) continue;
      if (active.taunt) m.alertTimer = ALERT_TIME;
      if (kind && active.ailment) {
        addDebuffStack(m.debuffs, { kind, chance: active.ailment.chance, mag: active.ailment.mag, mag2: active.ailment.mag2, maxStacks: active.ailment.maxStacks, durationMs: active.ailment.durationMs }, this.world.timeMs);
        this.noteDot(m, kind, p);
      }
    }
    // PvP: проклятие вешает статус на вражеских игроков в радиусе (taunt для игроков смысла не имеет).
    if (this.world.pvp && kind && active.ailment) {
      for (const id of Object.keys(this.world.players)) {
        const t = this.world.players[id]!;
        if (t === p || !t.alive || t.spawnImmuneUntil > this.world.timeMs) continue;
        if (!reach(t.pos)) continue;
        addDebuffStack(t.debuffs, { kind, chance: active.ailment.chance, mag: active.ailment.mag, mag2: active.ailment.mag2, maxStacks: active.ailment.maxStacks, durationMs: active.ailment.durationMs }, this.world.timeMs);
      }
    }
  }

  private distToSegment(pt: Vec2, a: Vec2, b: Vec2): number {
    const c = this.closestOnSegment(pt, a, b);
    return vecLen(pt.x - c.x, pt.y - c.y);
  }

  /** Ближайшая к `pt` точка отрезка a→b. */
  private closestOnSegment(pt: Vec2, a: Vec2, b: Vec2): Vec2 {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2));
    return { x: a.x + abx * t, y: a.y + aby * t };
  }

  // ── Применение урона ──────────────────────────────────────
  /** Множитель урона за аффинити класса к фракции монстра (1 — нет бонуса). */
  private affinityMult(save: SaveState, faction: MonsterFaction): number {
    const cls = this.cfg.get('classes').find((c) => c.id === save.classId);
    return cls?.affinity.includes(faction) ? 1 + this.cfg.get('balance').affinityDamageBonus : 1;
  }

  /** Сумма +% урона от реактивных мастерств «hit-dealt» при выполнении условий по цели. */
  private hitDealtBonus(p: PlayerEntity, m: MonsterEntity): number {
    const snap = this.snaps.get(p.id);
    if (!snap) return 0;
    let bonus = 0;
    for (const tr of snap.triggers) {
      if (tr.on !== 'hit-dealt' || tr.bonusDamagePct == null) continue;
      const c = tr.condition;
      if (c?.targetBurning && !m.debuffs.burn) continue;
      if (c?.targetStunned && !(m.stunTimer > 0)) continue;
      if (c?.targetFaction && m.def.faction !== c.targetFaction) continue;
      if (c?.whileToggle && !p.toggles.includes(c.whileToggle)) continue;
      if (c?.selfHpBelowPct != null && p.hp / snap.derived.maxHp >= c.selfHpBelowPct) continue;
      bonus += tr.bonusDamagePct;
    }
    return bonus;
  }

  /** Реактивные эффекты «hit-taken»: суммарное снижение урона (кап 0.9) + отражение. */
  private hitTakenEffects(p: PlayerEntity, snap: PlayerSnapshot): { reduction: number; reflectPct: number; reflectElement: DamageType } {
    let reduction = 0, reflectPct = 0;
    let reflectElement: DamageType = 'physical';
    for (const tr of snap.triggers) {
      if (tr.on !== 'hit-taken') continue;
      const c = tr.condition;
      if (c?.whileToggle && !p.toggles.includes(c.whileToggle)) continue;
      if (c?.selfHpBelowPct != null && p.hp / snap.derived.maxHp >= c.selfHpBelowPct) continue;
      if (tr.damageTakenReductionPct) reduction += tr.damageTakenReductionPct;
      if (tr.reflectPct) { reflectPct += tr.reflectPct; if (tr.reflectElement) reflectElement = tr.reflectElement as DamageType; }
    }
    return { reduction: Math.min(0.9, reduction), reflectPct, reflectElement };
  }

  /** Наносит отражённый урон монстру-источнику (реталия). Может добить. */
  private reflectToMonster(p: PlayerEntity, m: MonsterEntity, amount: number, element: DamageType): void {
    if (amount <= 0 || !m.alive) return;
    const pk = emptyPacket();
    pk[element] = amount;
    m.hp = Math.max(0, m.hp - amount);
    m.alertTimer = ALERT_TIME;
    this.events.push({ type: 'hit', target: 'monster', id: m.id, by: p.id, x: m.pos.x, y: m.pos.y, hit: true, blocked: false, crit: false, amount, byType: pk, mat: monsterMat(m) });
    if (m.hp <= 0) this.killMonster(m, p);
  }

  private hitMonster(killer: PlayerEntity, m: MonsterEntity, packet: DamagePacket, attacker: CombatStats, opts: HitOpts = {}): void {
    const target: HitTarget = { hp: m.hp, maxHp: m.def.hp, stats: monsterCombatStats(m.def), debuffs: m.debuffs };
    // Аффинити + реактивные мастерства «hit-dealt» (по горящим/фракции/оглушённым) + уязвимость лежачего (нокдаун).
    const affMult = this.affinityMult(killer.save, m.def.faction);
    const kdCfg = this.cfg.get('balance').knockdown;
    const vulnMult = m.downTimer > 0 && kdCfg.enabled ? 1 + kdCfg.vulnBonusPct : 1;   // сбитый с ног получает +% урона (окно комбо)
    const mult = affMult * (1 + this.hitDealtBonus(killer, m)) * vulnMult;
    const pk = mult !== 1 ? scalePacket(packet, mult) : packet;
    const res = resolvePlayerHit(target, attacker, pk, { ...opts, debuffTuning: this.cfg.get('debuffs') }, this.rng, this.world.timeMs);

    this.events.push({ type: 'hit', target: 'monster', id: m.id, by: killer.id, x: m.pos.x, y: m.pos.y, hit: res.hit, blocked: res.blocked, crit: res.crit, amount: res.damage, byType: res.byType, mat: monsterMat(m) });
    m.alertTimer = ALERT_TIME; // получил внимание/удар — в погоню
    if (!res.hit || res.blocked) return;

    m.hp = target.hp;
    for (const k of res.appliedDebuffs) this.noteDot(m, k, killer);   // R5-06: чей статус — тому и добивание
    // Вампиризм: доля нанесённого урона → HP/мана атакующего (боевой сустейн, кламп по максимуму; мана — по резерву аур, V-RF-01).
    // ⚠ V-RF-04: отдача удара — ТОЛЬКО ЖИВОМУ: стрела в полёте и статус бьют и после смерти стрелка, но труп не лечится и не кастует.
    if (this.sustain && res.damage > 0 && killer.alive) {
      const d = this.snaps.get(killer.id)?.derived;
      if (d) {
        if (d.lifeLeechPct > 0) killer.hp = Math.min(d.maxHp, killer.hp + res.damage * d.lifeLeechPct);
        if (d.manaLeechPct > 0) this.gainPool(killer, 'mana', d.maxMana, res.damage * d.manaLeechPct);
      }
    }
    // Прок «шанс каста при ударе» (не от ударов самого прок-скилла — иначе рекурсия).
    if (this.sustain && !this.procActive && res.damage > 0 && killer.alive) this.rollHitProcs(killer, 'hit');
    if (!res.died) {
      // Нокдаун (сбить с ног) приоритетнее стана/отброса — если сработал, монстр падает рагдоллом (взаимоискл.).
      const knocked = this.tryKnockdown(killer, m, opts, res.damage);
      if (!knocked) {
        // Гарантированный стан скилла приоритетнее случайного от оружия/ошеломления.
        if (opts.stunSec && opts.stunSec > 0) { m.stunTimer = Math.max(m.stunTimer, opts.stunSec); this.events.push({ type: 'stun', id: m.id }); }
        else if (res.stunned) { m.stunTimer = Math.max(m.stunTimer, 1.2); this.events.push({ type: 'stun', id: m.id }); }
        // Отброс: по шансу (shoveChance) и масштабируем весом цели — тяжёлого толкает слабее. При нокдауне не нужен (своё падение).
        if (opts.knockback && this.rng.float(0, 1) < (opts.shoveChance ?? 1)) {
          const force = opts.knockback * (KNOCKBACK_REF_WEIGHT / Math.max(1, this.monsterMass(m)));
          m.pos = moveWithCollision(m.pos, this.awayDir(killer.pos, m.pos, force), m.radius, this.world.grid, 1, this.world.obstacles);
        }
      }
    } else {
      this.killMonster(m, killer);
    }
  }

  /** Прок «шанс каста при ударе»: по экипировке — аффиксы с proc; шанс → executeAbility(скилл, уровень)
   *  минуя ресурс/КД/оружие/замах. Реентранси-гард (procActive) не даёт проку рекурсить от своих ударов. */
  private rollHitProcs(p: PlayerEntity, trigger: 'hit' | 'struck'): void {
    const snap = this.snaps.get(p.id);
    if (!snap) return;
    for (const it of equippedItems(p.save)) {
      for (const a of it.affixes) {
        const proc = a.proc;
        if (!proc || (proc.trigger ?? 'hit') !== trigger || !this.rng.chance(proc.chance)) continue;
        const active = this.activeById(p.save, proc.skillId);
        if (!active) continue;
        this.procActive = true;
        try { this.executeAbility(p, snap, active, proc.level); } finally { this.procActive = false; }
      }
    }
  }

  private hitPlayer(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, onHit: DebuffApply[], by: string, source?: MonsterEntity): void {
    const snap = this.snaps.get(p.id);
    if (!snap) return;
    const pm = this.dmods(p.debuffs);
    const res = resolveAttack(attacker, snap.combat, packet, this.rng);
    if (!res.hit || res.blocked) {
      this.events.push({ type: 'hit', target: 'player', id: p.id, by, x: p.pos.x, y: p.pos.y, hit: res.hit, blocked: res.blocked, crit: false, amount: 0, byType: res.byType, mat: playerMat(p) });
      return;
    }
    // Реактивные мастерства «hit-taken»: снижение получаемого урона + отражение.
    const tk = this.hitTakenEffects(p, snap);
    const dmg = Math.round(res.total * pm.recvDamageMult * (1 - tk.reduction)); // увечье: +урон; мастерства: −урон
    this.events.push({ type: 'hit', target: 'player', id: p.id, by, x: p.pos.x, y: p.pos.y, hit: true, blocked: false, crit: res.crit, amount: dmg, byType: res.byType, mat: playerMat(p) });
    p.hp = Math.max(0, p.hp - dmg);
    // ⚠ V-RF-04: смерть — ДО отражения. Отражённое добивало монстра, пока смертельно раненый ещё числился живым: лечение и мана
    // за убийство, а на левелапе и полное здоровье, поднимали его с нуля — бесплатное воскрешение. Шипы бьют и павшего, но
    // награды убийцы павшему нет (`killMonster`).
    const died = p.hp <= 0;
    if (died) { p.alive = false; this.events.push({ type: 'player-died', playerId: p.id }); }
    if (source && tk.reflectPct > 0) this.reflectToMonster(p, source, Math.round(dmg * tk.reflectPct), tk.reflectElement);
    if (died) return;

    // Прок «шанс каста при ПОЛУЧЕНИИ удара» (игрок выжил; не рекурсим от прок-ударов).
    if (this.sustain && !this.procActive && dmg > 0) this.rollHitProcs(p, 'struck');

    if (onHit.length) {
      const equipped = equippedItems(p.save);
      for (const a of onHit) {
        const poise = armorPoise(equipped, a.kind, this.cfg.get('armor-classes'));
        // ⚠ D19: шанс зажат тем же потолком STATUS_CHANCE_CAP, что и удар игрока (`resolvePlayerHit`):
        // без него прок монстра или оружия соперника с шансом ≥ 1 вешал статус КАЖДЫМ ударом.
        if (this.rng.chance(statusChance(a.chance, 1 - poise))) {
          addDebuffStack(p.debuffs, { ...a, mag: a.mag + (a.magPerDamage ?? 0) * dmg, durationMs: a.durationMs * (1 - poise) }, this.world.timeMs);
        }
      }
    }
  }

  // ── Монстр атакует ────────────────────────────────────────
  private monsterPacket(m: MonsterEntity): { packet: DamagePacket; attacker: CombatStats; debuffs: DebuffApply[] } {
    const dm = this.dmods(m.debuffs);
    const packet = buildMonsterPacket(m.def, this.rng);
    if (dm.outDamageMult !== 1) for (const t of Object.keys(packet) as DamageType[]) packet[t] *= dm.outDamageMult;
    const base = monsterCombatStats(m.def);
    const attacker = dm.accuracyMult !== 1 ? { ...base, accuracy: base.accuracy * dm.accuracyMult } : base;
    return { packet, attacker, debuffs: monsterDebuffs(m.def, this.cfg.get('phys-subtypes'), this.cfg.get('magic-subtypes'), this.cfg.get('debuffs')) };
  }

  private monsterMelee(m: MonsterEntity, target: PlayerEntity): void {
    const a = this.monsterPacket(m);
    this.hitPlayer(target, a.packet, a.attacker, a.debuffs, m.def.name, m);
  }

  private monsterShoot(m: MonsterEntity, target: PlayerEntity): void {
    const a = this.monsterPacket(m);
    const ang = Math.atan2(target.pos.y - m.pos.y, target.pos.x - m.pos.x);
    this.world.projectiles.push({
      id: this.world.nextId++,
      pos: { ...m.pos },
      vel: { x: Math.cos(ang) * MONSTER_PROJ_SPEED, y: Math.sin(ang) * MONSTER_PROJ_SPEED },
      radius: PROJ_HIT_RADIUS,
      ttl: PROJ_TTL,
      owner: 'monster',
      ownerId: m.id,
      packet: a.packet,
      attacker: a.attacker,
      onHit: a.debuffs,
      attackerName: m.def.name,
    });
  }

  private spawnProjectile(
    p: PlayerEntity,
    packet: DamagePacket,
    attacker: CombatStats,
    speed: number,
    dir: number,
    extra: { pierce?: boolean; onHit?: DebuffApply[]; hitOpts?: HitOpts } = {},
  ): void {
    this.world.projectiles.push({
      id: this.world.nextId++,
      pos: { ...p.pos },
      vel: { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed },
      radius: PROJ_HIT_RADIUS,
      ttl: PROJ_TTL,
      owner: 'player',
      ownerId: p.id,
      packet,
      attacker,
      onHit: extra.onHit ?? extra.hitOpts?.onHit,
      hitOpts: extra.hitOpts,
      pierce: extra.pierce,
      hitIds: extra.pierce ? [] : undefined,
    });
  }

  private stepProjectiles(dt: number): void {
    const w = this.world;
    const keep: ProjectileEntity[] = [];
    for (const proj of w.projectiles) {
      proj.ttl -= dt;
      // Саб-степпинг: дробим смещение за тик на шаги ≤8px, чтобы снаряд не
      // «проскакивал» сквозь стены/цели при крупном dt (иначе дальний бой ломается).
      const dist = vecLen(proj.vel.x, proj.vel.y) * dt;
      const steps = Math.max(1, Math.ceil(dist / 8));
      const sub = dt / steps;
      let gone = false;
      for (let sIdx = 0; sIdx < steps; sIdx++) {
        const from = worldToCell(proj.pos.x, proj.pos.y);
        const fx = proj.pos.x, fy = proj.pos.y;
        proj.pos.x += proj.vel.x * sub;
        proj.pos.y += proj.vel.y * sub;
        // Бумеранг: у макс. дальности разворот к владельцу; гаснет, вернувшись к нему.
        if (proj.boomerang && proj.origin) {
          if (!proj.returning && vecLen(proj.pos.x - proj.origin.x, proj.pos.y - proj.origin.y) >= (proj.maxRange ?? 300)) {
            proj.returning = true;
            proj.hitIds = []; // на обратном пути бьёт цели заново
          }
          if (proj.returning) {
            const owner = w.players[proj.ownerId as string];
            if (owner) {
              this.aimAt(proj, owner.pos);
              if (vecLen(proj.pos.x - owner.pos.x, proj.pos.y - owner.pos.y) < 24) { gone = true; break; }
            }
          }
        }
        const cell = worldToCell(proj.pos.x, proj.pos.y);
        // ⚠ R10-02: подшаг, перескочивший угол «диагонального шва» (обе боковые клетки — стены), — тоже удар о стену: иначе
        // стрела из угла шва била того, кто ни видеть стрелка (`hasLineOfSight`), ни дойти до него напрямую не может.
        // ⚠ C-10: и подшаг сквозь преграду декора, закрывающую обзор (`blocksSight`, высокая колонна), — удар о неё. Смотрелась только
        // сетка: стрела и жезл били сквозь колонну монстра, который героя не видит и ответить не может, хотя удар, нова, проклятие,
        // прыжок и рывок её уважают (`hasLos`, R5-05), и снаряд монстра так же долетал до героя, зашедшего за неё. Низкий декор
        // (`blocksSight: false`) обзор не трогает — над ним снаряд летит, как и прежде.
        if (isBlockedCell(w.grid, cell.cx, cell.cy) || diagonalSealed(w.grid, from.cx, from.cy, cell.cx, cell.cy)
          || sightBlockedByObstacles(w.obstacles, fx, fy, proj.pos.x, proj.pos.y)) {
          // Обычный снаряд гаснет о стену. ⚠ R5-05: бумеранг летал «поверх препятствий» — и бил на лету монстров за
          // стеной и закрытой дверью, туда и обратно, а те ответить не могли. Теперь туда он от стены РАЗВОРАЧИВАЕТСЯ
          // к владельцу (шаг назад, в свою клетку, — как у дальности), обратно — гаснет о неё, как любой снаряд. Колонна (C-10) — так же.
          const owner = proj.boomerang && !proj.returning ? w.players[proj.ownerId as string] : undefined;
          if (!owner) { gone = true; break; }
          proj.pos.x -= proj.vel.x * sub;
          proj.pos.y -= proj.vel.y * sub;
          proj.returning = true;
          proj.hitIds = [];
          this.aimAt(proj, owner.pos);
          continue;
        }
        if (this.projectileHit(proj)) { gone = true; break; } // попал (true только у непробивающих)
      }
      if (!gone && proj.ttl > 0) keep.push(proj);
    }
    w.projectiles = keep;
  }

  /** Повернуть снаряд к точке, сохранив скорость (бумеранг на обратном пути). */
  private aimAt(proj: ProjectileEntity, at: Vec2): void {
    const a = Math.atan2(at.y - proj.pos.y, at.x - proj.pos.x);
    const sp = vecLen(proj.vel.x, proj.vel.y);
    proj.vel = { x: Math.cos(a) * sp, y: Math.sin(a) * sp };
  }

  /** Проверяет попадание снаряда в цель на текущей позиции; применяет урон. */
  private projectileHit(proj: ProjectileEntity): boolean {
    const w = this.world;
    if (proj.owner === 'player') {
      const killer = w.players[proj.ownerId as string];
      for (const m of w.monsters) {
        if (!m.alive) continue;
        if (proj.hitIds && proj.hitIds.includes(m.id)) continue; // пробивающий/бумеранг: не бить дважды
        if (vecLen(proj.pos.x - m.pos.x, proj.pos.y - m.pos.y) < proj.radius) {
          if (killer) this.hitMonster(killer, m, proj.packet, proj.attacker, proj.hitOpts ?? {});
          if (proj.pierce || proj.boomerang) { (proj.hitIds ??= []).push(m.id); continue; } // летит дальше
          return true; // обычный снаряд гаснет о первую цель
        }
      }
      // PvP: снаряд игрока попадает во вражеского игрока (гаснет о первую цель — пирс/бумеранг по игрокам не тянем).
      if (w.pvp && killer) {
        for (const id of Object.keys(w.players)) {
          const t = w.players[id]!;
          if (t === killer || !t.alive || t.spawnImmuneUntil > w.timeMs) continue;
          if (vecLen(proj.pos.x - t.pos.x, proj.pos.y - t.pos.y) < proj.radius) {
            this.hitPlayer(t, proj.packet, proj.attacker, proj.hitOpts?.onHit ?? [], killer.id);
            return true;
          }
        }
      }
    } else {
      for (const id of Object.keys(w.players)) {
        const p = w.players[id]!;
        if (!p.alive) continue;
        if (vecLen(proj.pos.x - p.pos.x, proj.pos.y - p.pos.y) < proj.radius) {
          const src = w.monsters.find((mm) => mm.id === proj.ownerId);
          this.hitPlayer(p, proj.packet, proj.attacker, proj.onHit ?? [], proj.attackerName ?? 'Враг', src);
          return true;
        }
      }
    }
    return false;
  }

  /** R5-06: запомнить, кто повесил урон-по-времени вида `kind` (прочие статусы не убивают — их не помним). R7-07: и чей он герой. */
  private noteDot(m: MonsterEntity, kind: DebuffKind, by: PlayerEntity): void {
    if (!isDotKind(kind)) return;
    (m.dotBy ??= {})[kind] = by.id;
    (m.dotHero ??= {})[kind] = by.save.charId;
  }

  /**
   * ⚠ R5-06: КОМУ ДОБИТОЕ СТАТУСОМ. Хозяин статуса, чей вклад в смертельный тик больше (стаки × сила), а если он ушёл из
   * комнаты — следующий по вкладу, кто ещё здесь. Никого — никому: убийство без награды честнее, чем подарок первому в
   * комнате (раньше так и было — опыт, «Уничтожить N» и лечение за убийство уходили простаивающему или мёртвому альту).
   * Добыча при этом падает (R9-06, `killMonster`): она не награда убийцы, а то, что с монстра достаётся партии.
   * ⚠ R7-07: «ещё здесь» — это ГЕРОЙ, а не id входа. Комната даёт каждому входу новый id, и вернувшийся реконнектом хозяин
   * статуса по старому id не находился: добитое уходило никому, а запись узла помечала монстра убитым навсегда. Сперва —
   * по id (при хозяине на месте ничего не меняется, и боты сима с общим charId «bot» не путаются), потом — по charId.
   * Ушедший насовсем в мире не значится ни под каким id — ему по-прежнему ничего.
   * ⚠ V-RF-04: и павший — как ушедший (награды убийцы только живому, `killMonster`): добитое уходит следующему по вкладу, кто жив.
   */
  private dotOwner(m: MonsterEntity): PlayerEntity | undefined {
    const kinds = (Object.keys(m.debuffs) as DebuffKind[]).filter(isDotKind);
    const part = (k: DebuffKind): number => (m.debuffs[k]?.stacks ?? 0) * (m.debuffs[k]?.mag ?? 0);
    kinds.sort((a, b) => part(b) - part(a));
    for (const k of kinds) {
      const id = m.dotBy?.[k];
      const p = id !== undefined ? this.world.players[id] : undefined;
      if (p) { if (p.alive) return p; continue; }
      const hero = m.dotHero?.[k];
      const back = hero !== undefined ? Object.values(this.world.players).find((x) => x.save.charId === hero) : undefined;
      if (back?.alive) return back;
    }
    return undefined;
  }

  // ── Смерть монстра: события + золото + дроп + XP ───────────
  /**
   * `killer` нет (статус того, кто ушёл из комнаты) — смерть без НАГРАД убийцы: ни опыта, ни лечения за убийство, ни
   * «Уничтожить N» (событие без `by`). ⚠ R9-06: но ДОБЫЧА падает — та же и тем же порядком бросков: раньше без убийцы не
   * падало ничего, а запись узла помечала монстра убитым навсегда — партия в комнате теряла добычу босса, и лишить её было
   * можно нарочно (повесил яд — вышел). Разлёт «прочь от убийцы» тогда — в случайную сторону (`spawnDrop`).
   */
  private killMonster(m: MonsterEntity, killer: PlayerEntity | undefined): void {
    if (!m.alive) return;
    m.alive = false;
    m.deadAt = this.world.timeMs;   // отметка времени смерти → труп чистится из w.monsters через CORPSE_LINGER_MS (см. tick)
    // ⚠ V-RF-04: МЁРТВЫЙ УБИЙЦА — КАК УШЕДШИЙ. Стрела в полёте, бумеранг и статус добивают и после смерти хозяина, но награды
    // убийцы (опыт, «Уничтожить N», лечение и мана за убийство) — только живому: раньше их получал труп, а левелап трупа ставил
    // ему полное здоровье при `alive = false` (R5-06 звал это «опытом мёртвому альту», но закрыл лишь для ушедших). Добыча
    // падает, как и без убийцы (R9-06). Воскрешение и так наполняет пулы.
    const reward = killer?.alive ? killer : undefined;
    this.events.push({ type: 'monster-died', id: m.id, def: m.def, x: m.pos.x, y: m.pos.y, by: reward?.id });
    this.killRewards(m, killer, reward);
    // ⚠ R21-06: сигнатура конструктов (взрыв при смерти) — ПОСЛЕ наград убийцы. Награда решалась до взрыва (живой убийца), а выдавалась
    // после: взрыв убивал убийцу, и лечение за убийство и левелап (полное здоровье) доставались трупу — `alive = false` при здоровье
    // выше нуля (V-RF-04). Награды — в миг убийства, живому; взрыв — следом, по тому, кто рядом и виден.
    this.overloadOnDeath(m);
  }

  /** Награды смерти монстра: убийце (`reward` — живой убийца или никто, V-RF-04) — лечение и мана за убийство, опыт; добыча — всегда (R9-06). */
  private killRewards(m: MonsterEntity, killer: PlayerEntity | undefined, reward: PlayerEntity | undefined): void {
    // Восстановление за убийство (лич-за-килл): плоско HP/мана убийце — боевой сустейн, ДО наград. Мана — по резерву аур (V-RF-01).
    if (this.sustain && reward) {
      const kd = this.snaps.get(reward.id)?.derived;
      if (kd) {
        if (kd.lifeOnKill > 0) reward.hp = Math.min(kd.maxHp, reward.hp + kd.lifeOnKill);
        if (kd.manaOnKill > 0) this.gainPool(reward, 'mana', kd.maxMana, kd.manaOnKill);
      }
    }
    if (!this.economy) return; // клиент: золото/XP/дроп делают обработчики шины; сим-микробой: не нужны (и левелап-хил испортил бы TTK)
    const away = killer?.pos;   // R9-06: убийцы нет — добыча всё равно падает, разлёт в случайную сторону (от павшего — как и прежде)

    const diff = this.currentDifficulty();
    const level = m.def.level;
    const loot = this.cfg.get('balance').loot;

    // ⭐ Золото ПАДАЕТ, а не начисляется телепортом: до этого монета не выпадала вовсе — число
    // в углу экрана просто росло. Физический дроп + автоподбор (`balance.autoPickup`) делают
    // награду видимой и дают смысл фильтру «что поднимать само, что оставлять лежать».
    // Золото падает НЕ С КАЖДОГО: ровный ручеёк мелочи читается хуже редкой кучи
    // и копится быстрее, чем тратится (`loot.goldChance`).
    if (this.rng.chance(loot.goldChance)) {
      const gold = Math.max(1, Math.round(this.rng.int(1, 5 + level * 2) * diff.goldMult));
      this.spawnDrop(m.pos, { kind: 'gold', gold }, away);
    }

    // ── Материалы: основной поток наград (docs/ECONOMY.md) ──
    // ⭐ ПРАВИЛО №1: суммарная частота наград не падает, меняется только их ВИД. Вещь роняется
    // редко (10 %), но материалы — часто, и берутся они из ТОГО, ЧТО НА МОНСТРЕ НАДЕТО.
    if (this.rng.chance(loot.materials.chance)) {
      const gains = salvageFromMonster(
        m.def.gearRolls,
        (id) => this.cfg.get('monster-gear').find((g) => g.id === id),
        this.rng,
        {
          rarity: m.def.rarity,
          rarityTier: this.cfg.get('balance').salvage.rarityTier,
          knownMaterial: (id) => this.cfg.get('craft-materials').some((c) => c.id === id && c.enabled),
        },
      );
      // ⭐ Реже, но КРУПНЕЕ: частота срезана с 0.6 до 0.35, а количество за дроп поднято
      // множителем — суммарный приход тот же (~50 единиц за зачищенный этаж), но событий
      // вдвое меньше. Тридцать подборов сырья за этаж читались как шум, а не как награда.
      // ⚠ Округление ВЕРОЯТНОСТНОЕ, как в `salvageFromItem`. Обычное `round` на типичном
      // выходе в 1-2 единицы превращает множитель в ступеньку: 1.35 не меняет ничего вовсе,
      // а 1.5 удваивает (замер: 38 против 55 единиц за этаж на соседних значениях ручки).
      const mult = loot.materials.mult;
      if (mult !== 1) {
        for (const id of Object.keys(gains)) {
          const raw = gains[id]! * mult;
          const whole = Math.floor(raw);
          const n = whole + (this.rng.chance(raw - whole) ? 1 : 0);
          if (n > 0) gains[id] = n; else delete gains[id];
        }
      }
      if (Object.keys(gains).length) this.spawnDrop(m.pos, { kind: 'materials', mats: gains }, away);
    }

    // ⭐ Расходники своим каналом: трофей с тела их исключает (`monsterTrophyBase`), а при
    // `trophyChance` = 1.0 трофеями становится ВЕСЬ дроп с монстров — колбам взяться было неоткуда.
    if (this.rng.chance(loot.potions.chance)) {
      const pots = this.cfg.get('items.base').filter((b) => b.kind === 'consumable' && b.enabled !== false);
      if (pots.length) {
        const item = itemFromBase(this.rng.pick(pots), undefined, 'drop');
        const { x, y } = this.spawnDrop(m.pos, { kind: 'item', item }, away);
        this.events.push({ type: 'item-dropped', item, x, y, from: 'monster' });
      }
    }

    if (this.rng.chance(loot.dropChance)) {
      // ⚠ Биом ЭТАЖА, а не первый из списка: до этого `biomes[0]` игнорировал, где мы находимся,
      // и магия дропа всюду считалась по крипте. Без этого «у каждого биома свои материалы» невозможно.
      const biomes = this.cfg.get('biomes');
      const theme = biomes.find((b) => b.id === this.world.biomeId) ?? biomes[0]!;
      // ⭐ ТРОФЕЙ С ТЕЛА: падает вещь ИГРОКА, похожая на то, что монстр НОСИЛ (`formulas/trophy.ts`).
      // У монстров свой маленький пул снаряжения, чтобы не плодить вторую гору предметов и моделей,
      // но надеть игрок может только своё — поэтому носимое переводится в ближайшую базу игрока.
      // Нечего зеркалить (монстр без гира) — падает обычный случайный дроп, а не ничего.
      // ⭐ Трофей покрывает ВСЕ слоты, а не только надетые: кольца, пояса, перчатки и сапоги
      // монстр не носит, но с трупа они падают — в ЕГО стиле брони (с кожаного не падают латные).
      const asTrophy = this.rng.chance(loot.trophyChance);
      const baseId = asTrophy
        ? monsterTrophyBase(
            m.def.gearRolls,
            (id) => this.cfg.get('monster-gear').find((g) => g.id === id),
            this.cfg.get('items.base'),
            this.rng,
            loot.categoryWeights,
          )
        : undefined;
      // ⭐ Меч с пола = меч из кузницы из тех же деталей: клинок несёт статы своей геометрии (§26).
      const item = shapeFoundWeapon(this.cfg, generateItem(
        this.cfg.get('items.base'),
        this.cfg.get('affixes'),
        this.cfg.get('uniques'),
        {
          dropBias: theme.dropBias * diff.magicFind,
          // ⚠ Сложность БОЛЬШЕ НЕ ПРИБАВЛЯЕТСЯ к уровню вещи напрямую (был `+ diff.ilvlBonus`).
          // Она и так поднимает уровень МОНСТРОВ (на кошмаре моб 1-й мощи идёт 14–17 против 2–5),
          // и дроп подтягивается оттуда. Второй прямой канал делал сложность двойной ручкой.
          itemLevel: Math.max(1, level),
          // ⭐ Ступень базы — БРОСОК в окне вокруг уровня монстра со смещением вниз; аффиксы
          // остаются на `itemLevel`. См. `rollTierLevel`.
          tierLevel: rollTierLevel(level, loot.tierWindow, this.rng),
          baseId, tiers: this.cfg.get('item-tiers'), rarities: this.cfg.get('rarities'),
          categoryWeights: loot.categoryWeights, rareNames: this.cfg.get('rare-names'),
          maxReqTotal: this.cfg.get('balance').maxTotalRequirement,
          baseRoll: loot.baseRoll,
          // Откуда (§12.4): с монстра уникальной редкости — «босс» (её форсят комнаты босса и уника), иначе дроп.
          // Для ворот t6 равноценны; лавка и награды туда не идут.
          origin: m.def.rarity === 'unique' ? 'boss' : 'drop',
        },
        this.rng,
      ));
      // Снято с трупа — значит в негодном виде: чинить у кузнеца или разбирать (docs/ECONOMY.md, Ч4).
      // Сломанными падают ТОЛЬКО трофеи: обычная находка не снята с тела и цела, иначе
      // надеть в забеге было бы нечего вовсе.
      // ⚠ R7-19: кроме УНИКА — он кузницу не проходит вовсе («нашёл — носи как есть»), и сломанным его не починить
      // (`canRepairItem`). Бросок — тот же и для уника: поток `rng` дальше не сдвигается.
      if (baseId && this.rng.chance(loot.brokenChance) && item.rarity !== 'unique') item.broken = true;
      const { x, y } = this.spawnDrop(m.pos, { kind: 'item', item }, away);
      this.events.push({ type: 'item-dropped', item, x, y, from: 'monster' });
    }

    if (reward) this.awardXp(reward, m.def.xp); // опыт монстра уже отскейлен по его уровню
  }

  /**
   * Кладёт награду НА ОТЛЁТЕ от точки смерти.
   *
   * ⚠ Раньше разброс был ±10 — треть клетки. Дерёшься вплотную, значит награда падает ровно
   * под ноги, а радиус автоподбора (56) снимает её в том же кадре: число в углу растёт, а что
   * именно выпало, игрок не видит вовсе. Поэтому бросок идёт НА ДИСТАНЦИЮ (`loot.scatter`)
   * и ПРОЧЬ от того, кто убил, — награда успевает полежать на виду.
   *
   * ⚠ Клетку проверяем: без этого половина добычи улетала бы в стену, где её не поднять.
   * ⚠ R6-26: и ПУТЬ ПОЛЁТА — прямая видимость от трупа (та же, что у удара и монстра): бросок до 84 px перемахивал стену в
   * клетку и закрытую дверь, и добыча убитого у стены ложилась в соседнюю комнату, а то и в запечатанную область.
   * Не нашли годного направления за несколько проб — кладём вплотную, как раньше.
   */
  private spawnDrop(at: Vec2, payload: DropPayload, awayFrom?: Vec2): { x: number; y: number } {
    const sc = this.cfg.get('balance').loot.scatter;
    // Направление «прочь от игрока»; игрок ровно в точке смерти (или его нет) — берём любое.
    let baseAng = this.rng.float(0, Math.PI * 2);
    if (awayFrom) {
      const dx = at.x - awayFrom.x, dy = at.y - awayFrom.y;
      if (dx * dx + dy * dy > 1) baseAng = Math.atan2(dy, dx);
    }
    let x = at.x, y = at.y;
    for (let i = 0; i < 6; i++) {
      // Разлёт в пределах полусферы «от игрока»: строго по лучу три награды легли бы стопкой.
      const ang = baseAng + this.rng.float(-Math.PI / 2, Math.PI / 2);
      const dist = this.rng.float(sc.min, Math.max(sc.min, sc.max));
      const nx = at.x + Math.cos(ang) * dist;
      const ny = at.y + Math.sin(ang) * dist;
      const c = worldToCell(nx, ny);
      if (!isBlockedCell(this.world.grid, c.cx, c.cy) && this.hasLos(at, { x: nx, y: ny })) { x = nx; y = ny; break; }
    }
    this.world.drops.push({ id: this.world.nextId++, pos: { x, y }, ...payload });
    return { x, y };
  }

  /**
   * АВТОПОДБОР при проходе рядом. Золото и материалы идут в кошелёк и клеток не занимают —
   * их незачем собирать руками; вещи по умолчанию НЕ подбираются (`rarities` пуст), потому что
   * выбор «взять или оставить» — это и есть добыча.
   * ⚠ До этой правки ключ `balance.autoPickup` не читала НИ ОДНА строка кода: автоподбора в игре
   * не было вовсе. Пустой список редкостей сохраняет то же наблюдаемое поведение для вещей.
   */
  private autoPickup(p: PlayerEntity): void {
    const f = this.cfg.get('balance').autoPickup;
    for (let i = this.world.drops.length - 1; i >= 0; i--) {
      const d = this.world.drops[i]!;
      if (vecLen(d.pos.x - p.pos.x, d.pos.y - p.pos.y) > f.radius) continue;
      const want = d.kind === 'gold' ? f.gold : d.kind === 'materials' ? f.materials : f.rarities.includes(d.item.rarity);
      if (!want || !this.hasLos(p.pos, d.pos)) continue;   // R6-26: не сквозь стену и закрытую дверь
      if (this.thrownToHost(p, d)) continue;   // ⭐ K3: выброшенное игроком — подъёмом с записью
      const took = this.takeDrop(p, i);
      if (took?.item) this.events.push(pickedEvent(p.id, took));
    }
  }

  /**
   * ⭐ ОТКРЫТЬ СУНДУК — второй источник добычи, с ритмом, противоположным монстрам.
   *
   * Монстры сыплют материалы постоянно и роняют СЛОМАННЫЕ трофеи только тех слотов, что носят.
   * Сундук даёт ЦЕЛУЮ вещь гарантированно и любого слота — отсюда приходят перчатки, сапоги,
   * пояс и украшения, и отсюда же берётся то, что можно надеть прямо в забеге.
   *
   * Возвращает true, если сундук был рядом и открылся (тогда подбор в этот тик не делаем).
   */
  openChest(playerId: string, chestId?: number): boolean {
    const p = this.world.players[playerId];
    if (!p || !this.canInteract(p) || !this.economy) return false;
    // Без id — ближайший (клавиша [E] у 2D-клиента и бота), с id — конкретный (команда веб-3D).
    // Проксимити проверяется В ОБОИХ случаях — анти-чит, как у рычага. R6-26: и видимость — сквозь стену не открыть.
    const near = (c: { pos: Vec2 }): boolean => this.within(p, c.pos, 56);
    const ch = this.world.chests.find((c) => !c.opened && near(c) && (chestId == null || c.id === chestId));
    if (!ch) return false;
    ch.opened = true;
    const tier = this.cfg.get('chests').find((t) => t.id === ch.tier);
    const diff = this.currentDifficulty();
    const biomes = this.cfg.get('biomes');
    const theme = biomes.find((b) => b.id === this.world.biomeId) ?? biomes[0]!;
    const bal = this.cfg.get('balance');
    const n = tier ? this.rng.int(tier.itemsMin, Math.max(tier.itemsMin, tier.itemsMax)) : 1;
    for (let i = 0; i < n; i++) {
      const item = shapeFoundWeapon(this.cfg, generateItem(
        this.cfg.get('items.base'),
        this.cfg.get('affixes'),
        this.cfg.get('uniques'),
        {
          dropBias: theme.dropBias * diff.magicFind * (tier?.dropBias ?? 1),
          // ⚠ Уровень МОНСТРОВ этажа, а не сырая глубина. Глубина — маленькое число (5 на пятом
          // этаже), а монстры там 6–9 уровня: сундук выдавал ступень НИЖЕ соседнего зомби, хотя он
          // и есть главное событие этажа и единственный источник целых вещей.
          itemLevel: Math.max(1, this.world.floorLevel || this.world.depth),
          tierLevel: rollTierLevel(Math.max(1, this.world.floorLevel || this.world.depth), bal.loot.tierWindow, this.rng),
          tiers: this.cfg.get('item-tiers'),
          rarities: this.cfg.get('rarities'),
          // ⚠ Сундук даёт СНАРЯЖЕНИЕ, а не расходники: он и так единственный источник целых
          // вещей и половины слотов (Ч6), и колба вместо них тратила бы впустую всё событие.
          // У расходников свой канал с монстров (`loot.potions`).
          categoryWeights: { ...bal.loot.categoryWeights, consumable: 0 },
          rareNames: this.cfg.get('rare-names'),
          maxReqTotal: bal.maxTotalRequirement,
          baseRoll: bal.loot.baseRoll,
          origin: 'chest',
        },
        this.rng,
      ));
      // ⚠ Содержимое сундука ЦЕЛОЕ: сломанным падает только снятое с тела (Ч4).
      const { x, y } = this.spawnDrop(ch.pos, { kind: 'item', item }, p.pos);
      this.events.push({ type: 'item-dropped', item, x, y, from: 'chest' });
    }
    this.events.push({ type: 'chest-opened', id: ch.id, x: ch.pos.x, y: ch.pos.y });
    return true;
  }

  /** Начисляет XP и обрабатывает левелапы (полностью лечит, выдаёт очки). */
  private awardXp(p: PlayerEntity, amount: number): void {
    if (amount <= 0) return;
    const save = p.save;
    this.events.push({ type: 'xp', playerId: p.id, amount });
    const { leveled } = gainXp(save, this.cfg.get('balance'), amount);
    if (leveled) {
      // ⚠ R15-10: снимок — с рантайм-модами, как у тика (аура/стойка/бафф/бафф зелья): голый сейв лечил стойку +15 % к жизни до
      // ~87 %, а до конца тика `snaps` держал его же — замах, удар монстра по броне/сопротивлениям/блоку и вампиризм шли без аур и стоек.
      // `p.maxHp` — сразу новый: старый жил до следующего тика, и кадр левелапа показывал здоровье выше максимума.
      // Возрождение (`respawnPlayer`) голым снимком обходится: тоглы и баффы оно снимает до расчёта.
      const snap = playerSnapshot(save, this.cfg, this.runtimeMods(p));
      p.maxHp = snap.derived.maxHp;
      p.hp = p.maxHp;
      // Мана/выносливость — до эффективного максимума: активные ауры/стойки резервируют часть пула.
      p.mana = effectivePool(snap.derived.maxMana, this.reservedFrac(p, 'mana'));
      p.stamina = effectivePool(snap.derived.maxStamina, this.reservedFrac(p, 'stamina'));
      p.debuffs = newDebuffState();
      this.snaps.set(p.id, snap);
      this.events.push({ type: 'levelup', playerId: p.id, level: save.level });
    }
  }

  // ── Подбор лута ───────────────────────────────────────────
  private tryPickup(p: PlayerEntity): void {
    // Подбор ближайшего дропа в радиусе (E-ключ/бот). Клик по предмету — точечно, см. pickupDropById.
    for (let i = 0; i < this.world.drops.length; i++) {
      const d = this.world.drops[i]!;
      if (foreignDrop(p, d)) continue;   // R2-02: выброшенное другим аккаунтом не берётся — и не заслоняет своё
      if (this.within(p, d.pos, 48)) {   // R6-26: за стеной — не «рядом», и не заслоняет доступное
        if (this.thrownToHost(p, d)) return;   // ⭐ K3: выброшенное игроком — подъёмом с записью (хозяин сессии)
        const took = this.takeDrop(p, i);
        if (took?.item) this.events.push(pickedEvent(p.id, took));
        return; // полон — не поднимаем (took === null), но и других в этот тик не берём
      }
    }
  }

  /**
   * Точечный подбор дропа по id (клиентская команда «клик по предмету» — надёжно, без гонки
   * сэмплирования ввода). Возвращает поднятое (item+координаты для лога/сейва) или null, если
   * дропа нет / далеко (>48) / за стеной (R6-26) / полный инвентарь / мёртв или оглушён (C-13, `canInteract`). Сервер по результату
   * шлёт SaveUpdate + событие.
   */
  pickupDropById(playerId: string, dropId: number): { item?: Item; x: number; y: number; thrown?: true } | null {
    const p = this.world.players[playerId];
    if (!p || !this.canInteract(p)) return null;
    const i = this.world.drops.findIndex((d) => d.id === dropId);
    if (i < 0) return null;
    const d = this.world.drops[i]!;
    if (!this.within(p, d.pos, 48)) return null;
    return this.takeDrop(p, i);
  }

  /**
   * ⭐ K3: МОЖНО ЛИ ПОДНЯТЬ дроп `dropId` — правила `pickupDropById` (жив и в силах, рядом и видно, не чужое), но без подъёма: выброшенное
   * игроком сервер кладёт в сумку только после записи поднимающего (`Room.pickThrown`). Нельзя — `null`.
   */
  pickable(playerId: string, dropId: number): DropEntity | null {
    const p = this.world.players[playerId];
    if (!p || !this.canInteract(p)) return null;
    const d = this.world.drops.find((x) => x.id === dropId);
    if (!d || foreignDrop(p, d) || !this.within(p, d.pos, 48)) return null;
    return d;
  }

  /**
   * ⭐ K3: выброшенное игроком (`owner`) при хозяине с крючком (`pickThrown`) тик не берёт — отдаёт хозяину (чужое не отдаёт вовсе).
   * `true` — дроп не для тика.
   */
  private thrownToHost(p: PlayerEntity, d: DropEntity): boolean {
    if (d.kind !== 'item' || d.owner === undefined || !this.pickThrown) return false;
    if (!foreignDrop(p, d)) this.pickThrown(p.id, d.id);
    return true;
  }

  /**
   * ⭐ C-13: МОЖЕТ ЛИ ГЕРОЙ ВЗАИМОДЕЙСТВОВАТЬ С МИРОМ — одно правило для [E] тика и команд по id (рычаг, сундук, подбор). Тик
   * пропускает мёртвых и после стана возвращается до взаимодействия; команды веб-3D шли мимо: труп у рычага открывал дверь пати,
   * оглушённый открывал сундук и подбирал вещь кликом. Рывок не гейтится: тик пропускает [E] в рывке лишь потому, что ввод ушёл в
   * движение, а правила «в рывке нельзя» нет.
   */
  private canInteract(p: PlayerEntity): boolean {
    return p.alive && !(p.stunTimer > 0);
  }

  /**
   * Возрождает игрока после смерти: полное HP/мана, сброс дебаффов/стана/тоглов.
   * `at` — точка спавна (по умолчанию вход мира); `immuneMs` — спавн-иммунитет в PvP (мс).
   */
  respawnPlayer(playerId: string, at?: Vec2, immuneMs = 0): void {
    const p = this.world.players[playerId];
    if (!p) return;
    p.toggles = [];
    p.skillBuffs = {};
    const snap = playerSnapshot(p.save, this.cfg);
    p.pos = at ? { ...at } : { ...this.world.spawn };
    p.vel = { x: 0, y: 0 };
    p.hp = snap.derived.maxHp;
    p.mana = snap.derived.maxMana;
    p.stamina = snap.derived.maxStamina;
    p.debuffs = newDebuffState();
    p.spawnImmuneUntil = immuneMs > 0 ? this.world.timeMs + immuneMs : 0;
    p.stunTimer = 0;
    p.windup = null;
    p.attackCd = 0;
    p.alive = true;
    this.snaps.set(playerId, snap);
  }

  /**
   * Игрок дёргает рычаг (по `leverId`), если он рядом и в силах (C-13, `canInteract`): открывает ТОЛЬКО его дверь
   * (`Cell.Door→Floor` в общем гриде). Возвращает `doorId` (для броадкаста) или null.
   * Мир общий → открытая дверь видна всей пати сразу.
   */
  openLever(playerId: string, leverId: number): number | null {
    const p = this.world.players[playerId];
    const lv = this.world.levers.find((l) => l.id === leverId);
    if (!p || !lv || lv.used || !this.canInteract(p)) return null;
    if (!this.within(p, lv.pos, 56)) return null; // проксимити (анти-чит); R6-26: и видимость — не сквозь стену
    return this.openDoorOf(lv);
  }

  /** Открыть дверь рычага (клетки → пол) и пометить рычаг. Нет двери — `null`, рычаг не тронут. */
  private openDoorOf(lv: WorldState['levers'][number]): number | null {
    const door = this.world.doors.find((d) => d.id === lv.doorId);
    if (!door) return null;
    for (const c of door.cells) { const row = this.world.grid[c.cy]; if (row) row[c.cx] = Cell.Floor; }
    lv.used = true;
    return door.id;
  }

  /**
   * ⭐ R4-01: ДЕЙСТВИЕ МЕЖДУ ТИКАМИ (команда игрока: сундук по id) — его события вызвавшему. Буфер событий живёт от тика
   * до тика и уже отдан тем тиком, что прошёл: события, положенные в него после, не видел никто — кадр «сундук открыт»
   * не доходил до клиента, и запись узла о сундуке тоже.
   */
  collectEvents(fn: () => void): SessionEvent[] {
    const outer = this.events;
    this.events = [];
    try {
      fn();
      return this.events;
    } finally {
      this.events = outer;
    }
  }

  /**
   * Выбрасывает предмет из инвентаря игрока на землю у его ног (команда drop). Возвращает предмет или null.
   * ⭐ R14-05: мёртвый не бросает — как не поднимает (`pickupDropById`) и не пьёт: брошенное трупом не поднять ни ему, ни чужому
   * аккаунту (R2-02), и смена этажа или вайп стирали его вместе с землёй — вещь с курсора, клик мимо окна смерти, и её нет.
   */
  dropToGround(playerId: string, uid: string): Item | null {
    const p = this.world.players[playerId];
    if (!p || !p.alive) return null;
    const i = p.save.inventory.findIndex((it) => it.uid === uid);
    if (i < 0) return null;
    const item = p.save.inventory.splice(i, 1)[0]!;
    item.pos = null;
    // R2-02: помечаем аккаунтом выбросившего — чужой аккаунт её не поднимет (торговли между аккаунтами нет).
    this.world.drops.push({ id: this.world.nextId++, kind: 'item', pos: { x: p.pos.x, y: p.pos.y }, item, ...(p.account !== undefined ? { owner: p.account } : {}) });
    return item;
  }

  /**
   * Забирает дроп[index] игроку: вещь — в авторитетную сетку инвентаря, золото и материалы —
   * в кошелёк. `null` только у вещи, которой не хватило места: кошелёк не переполняется никогда,
   * и в этом весь смысл кошелька (docs/ECONOMY.md, Ч1).
   */
  private takeDrop(p: PlayerEntity, index: number): { item?: Item; x: number; y: number; thrown?: true } | null {
    const d = this.world.drops[index]!;
    // ⭐ R2-02: выброшенное игроком ДРУГОГО аккаунта не поднять — ни кликом, ни по [E], ни автоподбором. Леджер такую
    // вещь не пускает: каждая следующая запись подобравшего падала бы на ней, а сама передача — торговля в обход.
    if (foreignDrop(p, d)) return null;
    const x = d.pos.x;
    const y = d.pos.y;
    if (d.kind === 'item') {
      if (!addToInventory(p.save.inventory, d.item, this.cfg.get('balance').inventory)) return null;
      this.world.drops.splice(index, 1);
      return { item: d.item, x, y, ...(d.owner !== undefined ? { thrown: true as const } : {}) };   // R4-26
    }
    if (d.kind === 'gold') {
      this.world.drops.splice(index, 1);
      p.save.gold += d.gold;
      this.events.push({ type: 'gold', playerId: p.id, amount: d.gold, total: p.save.gold });
      return { x, y };
    }
    // ⚠ Материалы теперь ЗАНИМАЮТ МЕСТО, поэтому splice только ПОСЛЕ успешной укладки: иначе
    // при полной сумке куча сырья исчезала бы в никуда. Влезло частично — остаток лежит дальше.
    const bal = this.cfg.get('balance');
    const left = giveMaterials(p.save, d.mats, this.cfg.get('craft-materials'), bal.inventory, bal.inventory.materialStack, uuidv7);
    const took: Record<string, number> = {};
    for (const [id, n] of Object.entries(d.mats)) {
      const rest = left[id] ?? 0;
      if (n - rest > 0) took[id] = n - rest;
    }
    if (!Object.keys(took).length) return null;            // не влезло НИЧЕГО — куча остаётся
    if (Object.keys(left).length) d.mats = left;
    else this.world.drops.splice(index, 1);
    this.events.push({ type: 'materials', playerId: p.id, gains: took, x, y });
    return { x, y };
  }

  // ── Помощники ─────────────────────────────────────────────
  private makeNoise(p: PlayerEntity, radius: number): void {
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (vecLen(p.pos.x - m.pos.x, p.pos.y - m.pos.y) <= radius) m.alertTimer = ALERT_TIME;
    }
  }

  private nearestPlayer(pos: Vec2): PlayerEntity | undefined {
    let best: PlayerEntity | undefined;
    let bestD = Infinity;
    for (const id of Object.keys(this.world.players)) {
      const p = this.world.players[id]!;
      if (!p.alive) continue;
      const d = vecLen(p.pos.x - pos.x, p.pos.y - pos.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private currentDifficulty(): Difficulty {
    const diffs = this.cfg.get('difficulties');
    return diffs.find((d) => d.id === this.world.difficultyId) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
  }

  private hasLos(a: Vec2, b: Vec2): boolean {
    return hasLineOfSight(this.world.grid, a.x, a.y, b.x, b.y, this.world.obstacles);
  }

  /**
   * ⚠ R6-26: «РЯДОМ» для подбора, сундука и рычага — в радиусе И в прямой видимости. Радиусы (48–56 px) длиннее стены в
   * клетку (32), и одно расстояние брало вещь, золото и сундук сквозь стену и закрытую дверь.
   */
  private within(p: PlayerEntity, at: Vec2, radius: number): boolean {
    return vecLen(at.x - p.pos.x, at.y - p.pos.y) <= radius && this.hasLos(p.pos, at);
  }

  /**
   * Патфайндинг-гибрид (блок B). Если монстр в погоне ДВИЖЕТСЯ К цели и прямой видимости нет —
   * ведём его по BFS-пути (обход стен), заменяя направление m.vel на вектор к следующей путевой
   * точке (скорость сохраняется). Видит цель или движется ОТ неё (кайт/флиа) — не трогаем.
   * Пересчёт пути троттлится (~0.3с) и при достижении точки — findPath дёшев, но не каждый тик.
   *
   * ⚠ R10-02: и ВИДЯ цель — пока идёт обход (`m.detour`), который включает сторож застревания (`watchStall`). Видимость
   * считается по клеткам, а тело — круг: у угла стены линия клеток проходит, а круг цепляет угол и сползает туда, где
   * видимости уже нет, — и путь ведёт его обратно. Монстр дрожал на границе клеток вне досягаемости своего удара.
   */
  private navChase(m: MonsterEntity, targetPos: Vec2, grid: Grid, losClear: boolean, dt: number): void {
    m.detour = Math.max(0, m.detour - dt);
    const speed = vecLen(m.vel.x, m.vel.y);
    if (speed < 1) { m.waypoint = null; m.stallAt = null; return; }
    const tx = targetPos.x - m.pos.x, ty = targetPos.y - m.pos.y;
    const dot = m.vel.x * tx + m.vel.y * ty;
    const toward = dot > 0;
    if (dot >= STALL_COS * speed * vecLen(tx, ty)) this.watchStall(m, speed, dt);
    else m.stallAt = null;
    if (toward && (!losClear || m.detour > 0)) {
      // Погоня без прямой видимости (или застрявшая, R10-02) → обход стен по BFS-пути.
      m.pathCd -= dt;
      const reached = !!m.waypoint && vecLen(m.waypoint.x - m.pos.x, m.waypoint.y - m.pos.y) < 16;
      if (!m.waypoint || reached || m.pathCd <= 0) {
        const path = findPath(grid, m.pos, targetPos);
        m.waypoint = path.length ? path[0]! : null;
        m.pathCd = 0.3;
      }
      if (m.waypoint) {
        const wx = m.waypoint.x - m.pos.x, wy = m.waypoint.y - m.pos.y;
        const d = vecLen(wx, wy) || 1;
        m.vel.x = (wx / d) * speed;
        m.vel.y = (wy / d) * speed;
      }
      return;
    }
    m.waypoint = null;
    if (!toward) this.avoidWallAhead(m, grid, speed); // кайт/флиа — не пятиться в угол
  }

  /**
   * ⚠ R10-02: СТОРОЖ ЗАСТРЕВАНИЯ ПОГОНИ. Окно в STALL_SEC: погоня к цели, которая за него не сдвинула монстра и на
   * STALL_SHARE пути, положенного по скорости, — застряла (угол стены, который линия клеток «видит», а круг не проходит).
   * Тогда DETOUR_SEC он идёт по BFS-пути (`navChase`), даже видя цель: 4-связный путь по центрам клеток круг (радиус ≤ 15,
   * меньше полклетки) не цепляет нигде. Идущий своим ходом, бьющий, оглушённый, отходящий и стрелок в стрейфе вбок
   * (`STALL_COS`) сюда не попадают.
   */
  private watchStall(m: MonsterEntity, speed: number, dt: number): void {
    if (!m.stallAt) { m.stallAt = { ...m.pos }; m.stallT = 0; return; }
    m.stallT += dt;
    if (m.stallT < STALL_SEC) return;
    if (vecLen(m.pos.x - m.stallAt.x, m.pos.y - m.stallAt.y) < speed * STALL_SEC * STALL_SHARE) {
      m.detour = DETOUR_SEC;
      m.waypoint = null;   // путь — сразу, с того места, где застрял
    }
    m.stallAt = { ...m.pos };
    m.stallT = 0;
  }

  /** Если впереди (по вектору скорости) стена — повернуть скорость к ближайшему открытому
   *  направлению (для кайта/отхода стрелков и флиа, чтобы не упираться в угол). */
  private avoidWallAhead(m: MonsterEntity, grid: Grid, speed: number): void {
    const probe = m.radius + 12;
    const open = (vx: number, vy: number): boolean => {
      const c = worldToCell(m.pos.x + (vx / speed) * probe, m.pos.y + (vy / speed) * probe);
      return !isBlockedCell(grid, c.cx, c.cy);
    };
    if (open(m.vel.x, m.vel.y)) return;
    const base = Math.atan2(m.vel.y, m.vel.x);
    for (const off of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (Math.PI * 3) / 4, -(Math.PI * 3) / 4]) {
      const a = base + off, vx = Math.cos(a) * speed, vy = Math.sin(a) * speed;
      if (open(vx, vy)) { m.vel.x = vx; m.vel.y = vy; return; }
    }
  }

  /** Джинн-уклонение (repositionMode=blink): при слишком близком игроке телепорт на среднюю дистанцию
   *  (открытая клетка с LoS к игроку), КД blinkCd. Ставит сессия (ИИ только выставляет vel). */
  private tryBlink(m: MonsterEntity, targetPos: Vec2, b: MonsterBehavior, dt: number): void {
    m.blinkCd = Math.max(0, m.blinkCd - dt);
    if (m.aiState !== 'chase' || m.blinkCd > 0) return;
    if (vecLen(targetPos.x - m.pos.x, targetPos.y - m.pos.y) >= b.keepDistMin) return; // не жмут — не блинкуем
    const r = (b.keepDistMin + b.keepDistMax) / 2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + this.rng.next() * 0.6;
      const nx = targetPos.x + Math.cos(a) * r, ny = targetPos.y + Math.sin(a) * r;
      const c = worldToCell(nx, ny);
      if (isBlockedCell(this.world.grid, c.cx, c.cy)) continue;
      if (!this.hasLos({ x: nx, y: ny }, targetPos)) continue;
      m.pos = { x: nx, y: ny };
      m.vel.x = 0; m.vel.y = 0; m.waypoint = null;
      m.blinkCd = 2.5;
      return;
    }
  }

  /**
   * Сигнатура конструктов (signature=overload): при смерти — AoE-урон по игрокам рядом (наказывает мили).
   * ⚠ R21-06: только по ВИДИМЫМ от монстра — та же видимость, что у его ближнего удара и снаряда (сетка, шов, преграды декора,
   * закрывающие обзор), и у площади героев (R5-05). По одному расстоянию взрыв бил сквозь стену в клетку и закрытую дверь рычага.
   */
  private overloadOnDeath(m: MonsterEntity): void {
    if (!this.sustain) return; // боевой эффект (угроза моба) — только когда сустейн включён
    if (behaviorFor(m.def.faction, this.cfg.get('monster-behaviors')).signature !== 'overload') return;
    const radius = m.radius + 48;
    const a = this.monsterPacket(m);
    for (const id of Object.keys(this.world.players)) {
      const p = this.world.players[id]!;
      if (!p.alive) continue;
      if (vecLen(p.pos.x - m.pos.x, p.pos.y - m.pos.y) <= radius + p.radius && this.hasLos(m.pos, p.pos)) {
        this.hitPlayer(p, a.packet, a.attacker, a.debuffs, `${m.def.name} (взрыв)`, m);
      }
    }
  }

  private wrap(a: number): number {
    return wrapAngle(a);
  }

  private awayDir(from: Vec2, to: Vec2, force: number): Vec2 {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    return { x: Math.cos(ang) * force, y: Math.sin(ang) * force };
  }
}
