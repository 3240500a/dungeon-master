import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item, AttackType } from '../types/items.js';
import type { ScaledMonster, MonsterFaction } from '../types/world.js';
import type { CombatStats, DamagePacket, DamageType } from '../types/combat.js';
import type { StatModifier } from '../types/attributes.js';
import { emptyPacket, packetTotal } from '../types/combat.js';
import type { Difficulty } from '../formulas/power.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { resolveAttack, abilityCooldown, abilityRankMult, swingHalfWidth } from '../formulas/combat.js';
import { buildAttackPacket, attackWeaponsOf } from '../formulas/playerCombat.js';
import { buildMonsterPacket, monsterCombatStats, monsterDebuffs } from '../formulas/monstergen.js';
import { weaponDebuffs, mergeElementOnHit, shapeSkillPacket } from '../formulas/resolveWeapon.js';
import { skillWeaponAllowed } from '../formulas/skills.js';
import { armorPoise, armorNoise } from '../formulas/resolveArmor.js';
import { generateItem } from '../formulas/itemgen.js';
import { gainXp } from '../economy/progression.js';
import { resolvePlayerHit, type HitTarget, type PlayerHitOptions } from '../world/combat.js';
import { debuffMods, addDebuffStack, tickDebuffs, newDebuffState, isDotKind, type DebuffApply, type DebuffState } from '../world/debuffs.js';
import type { ConfigShapes } from '../config/schemas.js';
import { moveWithCollision, type Vec2 } from '../world/movement.js';
import { resolveEntityCollisions, type CollisionBody } from '../world/separation.js';
import { playerWeight, type WeightTables } from '../formulas/stats.js';
import { activeAbilityOf, reservedFrac, effectivePool, toggleBuffMods } from './toggles.js';
import { isBlockedCell, worldToCell, Cell } from '../world/grid.js';
import type { Grid } from '../world/grid.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import { addToInventory } from '../inventory/grid.js';
import {
  newWorldState,
  makeMonsterEntity,
  makePlayerEntity,
  type WorldState,
  type PlayerEntity,
  type MonsterEntity,
  type ProjectileEntity,
} from '../world/state.js';
import { playerSnapshot, equippedItems, type PlayerSnapshot } from './derive.js';
import { stepMonsterAi, ALERT_TIME } from './ai.js';
import { behaviorFor, type MonsterBehavior } from './behavior.js';
import { findPath } from '../world/pathfind.js';

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
  monsters: MonsterSpawn[];
  /** Запертые ворота + рычаги (по модели «дверь ↔ рычаг»). */
  doors?: { id: number; cells: { cx: number; cy: number }[] }[];
  levers?: { id: number; x: number; y: number; doorId: number }[];
}

/** События тика — для вью (числа/эффекты) и статистики. */
export type SessionEvent =
  | { type: 'hit'; target: 'monster' | 'player'; id: string | number; by?: string; x: number; y: number; hit: boolean; blocked: boolean; crit: boolean; amount: number; byType: DamagePacket }
  | { type: 'monster-died'; id: number; def: ScaledMonster; x: number; y: number; by?: string }
  | { type: 'quest'; playerId: string; kind: 'accepted' | 'progress' | 'completed' | 'turned-in'; questId: string; name: string }
  | { type: 'item-dropped'; item: Item; x: number; y: number }
  | { type: 'item-picked'; playerId: string; item: Item; x: number; y: number }
  | { type: 'gold'; playerId: string; amount: number; total: number }
  | { type: 'xp'; playerId: string; amount: number }
  | { type: 'levelup'; playerId: string; level: number }
  | { type: 'player-died'; playerId: string }
  | { type: 'stun'; id: number }
  // Реальный свинг игрока (принят: мана/КД/оружие прошли) — для клиентского VFX (форма удара) и
  // заливки-отката слота бинда. ability = nodeId скилла или 'attack'. windupMs — замах, cooldownMs — откат
  // использованного действия, lockMs — общий attack-таймер (блокирует ВСЕ удары/attack-cast-скиллы).
  | { type: 'swing'; playerId: string; ability: string; windupMs: number; cooldownMs: number; lockMs: number; x: number; y: number; facing: number }
  // Старт замаха монстра — клиент рисует телеграф-вспышку на время windupMs в сторону facing.
  | { type: 'monster-swing'; id: number; windupMs: number; x: number; y: number; facing: number }
  | { type: 'floor-cleared' };

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
/** Запас к сумме радиусов, в пределах которого ближний удар монстра засчитывается по завершении
 *  замаха. Если игрок за время замаха отошёл дальше — удар вхолостую (замах даёт окно на уклонение). */
const MONSTER_MELEE_WHIFF_SLACK = 8;

/** Спецификация активной способности (v2: дискриминирована по `category`). */
type ActiveAbility = NonNullable<ConfigShapes['skill-tree']['nodes'][number]['effect']['active']>;
type AttackAbility = Extract<ActiveAbility, { category: 'attack' }>;
type CastAbility = Extract<ActiveAbility, { category: 'cast' }>;
type CurseAbility = Extract<ActiveAbility, { category: 'curse' }>;
type ToggleAbility = Extract<ActiveAbility, { category: 'aura' | 'stance' }>;
type OffensiveAbility = AttackAbility | CastAbility;
/** Опции применения удара (оружие/скилл): к PlayerHitOptions добавлены отброс и гарант. стан. */
type HitOpts = PlayerHitOptions & { knockback?: number; stunSec?: number; shoveChance?: number };
/** Опорный вес для масштаба отброса: knockback (px) калиброван под монстра ~этого веса. */
const KNOCKBACK_REF_WEIGHT = 100;

export class GameSession {
  readonly world: WorldState;
  private cfg: ConfigRegistry;
  private rng: Rng;
  private primaryPlayerId?: string;
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

  constructor(cfg: ConfigRegistry, seed: number, difficultyId: string, opts: { rewards?: boolean; sustain?: boolean; economy?: boolean } = {}) {
    this.cfg = cfg;
    this.rng = createRng((seed >>> 0) || 1);
    this.world = newWorldState([], seed, 0, difficultyId);
    this.rewards = opts.rewards ?? true;
    this.sustain = opts.sustain ?? this.rewards;
    this.economy = opts.economy ?? this.rewards;
  }

  /** Эффекты дебаффов с тюн-коэффициентами из живого конфига `debuffs`. */
  private dmods(state: DebuffState) {
    return debuffMods(state, this.cfg.get('debuffs'));
  }

  /** Добавляет игрока (один раз за забег); HP/мана — полные. */
  addPlayer(id: string, save: SaveState, spawnAt?: Vec2): PlayerEntity {
    const snap = playerSnapshot(save, this.cfg);
    // Обычно спавним в точке входа мира (центр города/этажа); при реконнекте — в заданной
    // точке (та же позиция). Кооп-присоединение происходит ПОСЛЕ enterFloor.
    const p = makePlayerEntity(id, save, spawnAt ? { ...spawnAt } : { ...this.world.spawn }, snap.derived.maxHp, snap.derived.maxMana, snap.derived.maxStamina);
    this.world.players[id] = p;
    if (!this.primaryPlayerId) this.primaryPlayerId = id;
    return p;
  }

  /** Удаляет игрока (выход/дисконнект в кооп). Переназначает primary, если ушёл он. */
  removePlayer(id: string): void {
    delete this.world.players[id];
    this.snaps.delete(id);
    if (this.primaryPlayerId === id) this.primaryPlayerId = Object.keys(this.world.players)[0];
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
    w.doors = (layout.doors ?? []).map((d) => ({ id: d.id, cells: d.cells.map((c) => ({ ...c })) }));
    w.levers = (layout.levers ?? []).map((l) => ({ id: l.id, pos: { x: l.x, y: l.y }, doorId: l.doorId, used: false }));
    w.monsters = [];
    w.drops = [];
    w.projectiles = [];
    w.tick = 0;
    this.floorCleared = false;
    for (const s of layout.monsters) {
      w.monsters.push(makeMonsterEntity(w.nextId++, s.def, { x: s.x, y: s.y }, this.rng.float(0, Math.PI * 2)));
    }
    for (const id of Object.keys(w.players)) {
      const p = w.players[id]!;
      if (!p.alive) { this.respawnPlayer(id); continue; } // мёртвые оживают на новом этаже (кооп-возврат)
      p.pos = { ...layout.spawn };
      p.vel = { x: 0, y: 0 };
    }
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

  // ── Главный тик ───────────────────────────────────────────
  tick(dt: number, inputs: Record<string, PlayerInput>): SessionEvent[] {
    const w = this.world;
    this.events = [];
    w.timeMs += dt * 1000;
    w.tick++;
    const now = w.timeMs;

    // Снимки игроков на тик (derived/attrs/combat) — один расчёт на игрока.
    this.snaps.clear();
    for (const id of Object.keys(w.players)) {
      const p = w.players[id]!;
      if (p.alive) this.snaps.set(id, playerSnapshot(p.save, this.cfg, this.runtimeMods(p)));
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
    const noiseMult = armorNoise(this.primaryEquipped(), this.cfg.get('armor-classes'));
    const behaviors = this.cfg.get('monster-behaviors');
    for (const m of w.monsters) {
      if (!m.alive) continue;
      // DoT кровотечения + реген (у чемпионов; «увечье» режет реген).
      const dm = this.dmods(m.debuffs);
      const dot = tickDebuffs(m.debuffs, dt, now);
      if (dot > 0) {
        m.hp -= dot;
        if (m.hp <= 0) { this.killMonster(m, this.primaryPlayer()); continue; }
      }
      if (m.def.hpRegen > 0 && m.hp < m.maxHp) {
        m.hp = Math.min(m.maxHp, m.hp + m.def.hpRegen * dm.hpRegenMult * dt);
      }

      const target = this.nearestPlayer(m.pos);
      if (!target) { m.vel.x = 0; m.vel.y = 0; continue; }

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
            if (Math.hypot(target.pos.x - m.pos.x, target.pos.y - m.pos.y) <= reach && this.hasLos(m.pos, target.pos)) this.monsterMelee(m, target);
          }
        }
        continue;
      }

      const behavior = behaviorFor(m.def.faction, behaviors);
      const losClear = this.hasLos(m.pos, target.pos);
      const action = stepMonsterAi(m, target.pos, behavior, losClear, noiseMult, dt);
      if (behavior.repositionMode === 'blink') this.tryBlink(m, target.pos, behavior, dt); // джинн-уклонение
      this.navChase(m, target.pos, w.grid, losClear, dt); // обход стен по BFS, когда не видит цель
      m.pos = moveWithCollision(m.pos, m.vel, m.radius, w.grid, dt);
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
    // Стан полностью укореняет; во время удара/замаха/восстановления — идём МЕДЛЕННО (attackMoveMult),
    // а не колом («идти медленно и бить»). Facing обновляется в любом случае (целишься на ходу).
    const attacking = !!p.windup || p.attackCd > 0;
    const moveMult = stunned ? 0 : attacking ? snap.derived.attackMoveMult : 1;   // per-класс замедление при атаке (из класс-scaling)
    if (input && !stunned) p.facing = input.facing;
    const len = input ? Math.hypot(input.move.x, input.move.y) : 0;
    if (input && moveMult > 0 && len > 0) {
      const speed = snap.derived.moveSpeed * pm.moveMult * moveMult;
      p.vel = { x: (input.move.x / len) * speed, y: (input.move.y / len) * speed };
    } else {
      p.vel = { x: 0, y: 0 };
    }
    p.pos = moveWithCollision(p.pos, p.vel, p.radius, this.world.grid, dt);

    if (stunned) return; // оглушён — ни атаки, ни каста
    if (input?.attack) this.tryPlayerAttack(p, snap);
    if (input?.cast != null) this.castSkill(p, snap, input.cast);
    if (input?.interact) this.tryPickup(p);
  }

  /** Замах удара/скилла как доля цикла атаки (масштабируется скоростью) + явный windup скилла. */
  private windupSec(attackCd: number, skillWindupSec: number): number {
    return attackCd * this.cfg.get('balance').melee.baseWindupFrac + skillWindupSec;
  }

  /** Событие реального свинга (принят: мана/КД/оружие прошли) — клиент рисует форму + льёт откат слота. */
  private emitSwing(p: PlayerEntity, ability: string, windupSec: number, cooldownSec: number, lockSec: number): void {
    this.events.push({ type: 'swing', playerId: p.id, ability, windupMs: windupSec * 1000, cooldownMs: cooldownSec * 1000, lockMs: lockSec * 1000, x: p.pos.x, y: p.pos.y, facing: p.facing });
  }

  /**
   * Базовая атака игрока: СТАРТ — списание маны (маг. оружие), тайминг, замах + событие `swing`.
   * Само срабатывание (выбор руки/пакет/удар) — по завершении замаха (`executeBasicAttack`).
   */
  private tryPlayerAttack(p: PlayerEntity, snap: PlayerSnapshot): void {
    if (p.attackCd > 0 || p.windup) return;
    const hands = attackWeaponsOf(p.save);
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
    if (windup > 0) { p.windup = { kind: 'attack', remaining: windup }; return; }
    this.executeBasicAttack(p, snap);
  }

  /** Срабатывание базовой атаки (по завершении замаха): выбор руки, пакет урона (крит здесь), удар/снаряд. */
  private executeBasicAttack(p: PlayerEntity, snap: PlayerSnapshot): void {
    const hands = attackWeaponsOf(p.save);
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
      if (Math.hypot(dx, dy) > range) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(this.wrap(ang - p.facing)) > arc) continue;
      this.hitMonster(p, m, packet, attacker, hitOpts);
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
    };
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

  /** Хватает ли ресурса под способность (мана/выносливость по active.resource). */
  private canSpend(p: PlayerEntity, active: { manaCost: number; resource: 'mana' | 'stamina' }): boolean {
    return (active.resource === 'stamina' ? p.stamina : p.mana) >= active.manaCost;
  }
  private spend(p: PlayerEntity, active: { manaCost: number; resource: 'mana' | 'stamina' }): void {
    if (active.resource === 'stamina') p.stamina -= active.manaCost;
    else p.mana -= active.manaCost;
  }

  private castSkill(p: PlayerEntity, snap: PlayerSnapshot, nodeId: string): void {
    const active = this.activeById(p.save, nodeId);
    if (!active) return;
    if (!this.nodeUsable(p.save, nodeId)) return;      // класс-ветка чужого класса — недоступна
    const rank = p.save.skills[nodeId] ?? 1;     // выученный ранг (клиент биндит только выученное)

    switch (active.category) {
      // Ауры/стойки: вкл/выкл, эксклюзив-группа, резерв пула (мана/выносливость).
      case 'aura':
      case 'stance':
        this.toggleStance(p, snap, nodeId, active);
        return;
      // Временный бафф: стат-моды за ресурс на durationSec; не рефрешим, пока активен.
      case 'buff': {
        if ((p.skillBuffs[nodeId] ?? 0) > 0) return;
        if (!this.canSpend(p, active)) return;
        this.spend(p, active);
        p.skillBuffs[nodeId] = active.durationSec;
        return;
      }
      // Атака: делит ОБЩИЙ attack-таймер (лок), тайминг от скорости атаки.
      case 'attack': {
        if (p.attackCd > 0 || p.windup) return;    // делит тайминг с базовой атакой; занят замахом
        if ((p.skillCd[nodeId] ?? 0) > 0) return;   // опц. персональный КД
        if (!this.weaponAllowed(p, active)) return; // не то оружие → скилл не срабатывает
        if (!this.canSpend(p, active)) return;
        this.spend(p, active);
        const pm = this.dmods(p.debuffs);
        p.attackCd = 1 / Math.max(0.2, snap.derived.attackSpeed * active.speed * pm.atkSpeedMult);
        if (active.cooldown > 0) p.skillCd[nodeId] = abilityCooldown(active.cooldown, rank);
        const windup = this.windupSec(p.attackCd, active.windupSec);
        this.emitSwing(p, nodeId, windup, Math.max(p.attackCd, p.skillCd[nodeId] ?? 0), p.attackCd);
        if (windup > 0) { p.windup = { kind: 'skill', nodeId, rank, remaining: windup }; return; }
        this.executeAbility(p, snap, active, rank);
        return;
      }
      // Каст/проклятие: тайминг от скорости КАСТА (Интеллект), личный КД, НЕ делит attack-лок (lockMs=0).
      case 'cast':
      case 'curse': {
        if (p.windup) return;                       // занят замахом/каст-таймом
        if ((p.skillCd[nodeId] ?? 0) > 0) return;   // личный КД
        if (!this.weaponAllowed(p, active)) return;
        if (!this.canSpend(p, active)) return;
        this.spend(p, active);
        if (active.cooldown > 0) p.skillCd[nodeId] = abilityCooldown(active.cooldown, rank);
        const castTime = active.castTimeSec / Math.max(0.2, snap.derived.castSpeed);
        this.emitSwing(p, nodeId, castTime, Math.max(castTime, p.skillCd[nodeId] ?? 0), 0);
        if (castTime > 0) { p.windup = { kind: 'skill', nodeId, rank, remaining: castTime }; return; }
        this.executeAbility(p, snap, active, rank);
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
    if (wu.remaining <= 0) {
      p.windup = null;
      if (wu.kind === 'attack') { this.executeBasicAttack(p, snap); return; }
      const a = this.activeById(p.save, wu.nodeId);
      if (a) this.executeAbility(p, snap, a, wu.rank);
    }
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

  /** Рантайм-стат-моды поверх сейва: buffMods активных тоглов + временных баффов. */
  private runtimeMods(p: PlayerEntity): StatModifier[] {
    if (p.toggles.length === 0 && Object.keys(p.skillBuffs).length === 0) return [];
    const mods = toggleBuffMods(this.cfg, p.toggles);
    for (const id of Object.keys(p.skillBuffs)) {
      const a = this.activeById(p.save, id);
      if (a && (a.category === 'buff' || a.category === 'aura' || a.category === 'stance')) mods.push(...(a.buffMods ?? []));
    }
    return mods;
  }

  private scaling(): number {
    return this.cfg.get('balance').weaponAttrScaling;
  }

  private weights(): ConfigShapes['weapon-weights'] {
    return this.cfg.get('weapon-weights');
  }

  /** Диспетчер активной способности по категории (после списания маны/КД/замаха). */
  private executeAbility(p: PlayerEntity, snap: PlayerSnapshot, active: ActiveAbility, rank: number): void {
    if (active.category === 'attack') { this.weaponAttack(p, snap, active, rank); return; }
    if (active.category === 'curse') { this.applyCurse(p, active); return; }
    if (active.category === 'cast') {
      const element = active.element ?? abilityElementOf(active.abilityId);
      const pk = this.castPacket(snap, p.save.equipment.weapon, active, rank, element);
      const opts = this.skillOpts(active, element, p.save.equipment.weapon, pk);   // статусы по итоговому (конвертированному) составу
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
    const weapon = p.save.equipment.weapon;
    const element = active.element ?? abilityElementOf(active.abilityId);
    const pm = this.dmods(p.debuffs);
    const packet = buildAttackPacket(snap.derived, snap.attrs, weapon, this.scaling(), this.weights(), this.rng);
    this.applySkillDamage(packet, active, rank, weapon, element);   // множитель по scope + доб.стихия + конверсия
    if (pm.outDamageMult !== 1) for (const t of Object.keys(packet) as DamageType[]) packet[t] *= pm.outDamageMult;   // дебафф раны — на весь урон
    const attacker = pm.accuracyMult !== 1 ? { ...snap.combat, accuracy: snap.combat.accuracy * pm.accuracyMult } : snap.combat;
    const opts = this.skillOpts(active, element, weapon, packet);   // статусы по итоговому составу + скилл-эффекты
    const at: AttackType = weapon?.attackType ?? 'melee';
    if (at === 'melee') {
      // Мили-мультиудар: `hits` последовательных взмахов за скилл (каждый = damageMult), напр. «серия уколов».
      const hits = Math.max(1, active.hits);
      for (let h = 0; h < hits; h++) this.meleeSwing(p, packet, attacker, weapon, opts, active.rangeMult, active.arcMult);
      return;
    }
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
    const weapon = p.save.equipment.weapon;
    const halfW = swingHalfWidth(mel.baseRange * (weapon?.reachMult ?? 1), mel.baseArc * (weapon?.arcMult ?? 1));
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(dir) * dist, y: Math.sin(dir) * dist }, p.radius, this.world.grid, 1);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (this.distToSegment(m.pos, from, to) <= halfW) this.hitMonster(p, m, packet, attacker, opts);
    }
    this.launchDash(p, dir, from, to, active, rank);
  }

  /** Прыжок (cast leap): перемещение вперёд БЕЗ урона по пути + AoE-удар в точке приземления. Уязвим. */
  private doLeap(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: CastAbility, rank: number, opts: HitOpts): void {
    const dir = p.facing;
    const dist = active.dashDist > 0 ? active.dashDist : 150;
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(dir) * dist, y: Math.sin(dir) * dist }, p.radius, this.world.grid, 1);
    const r = active.radius > 0 ? active.radius : 60;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (Math.hypot(m.pos.x - to.x, m.pos.y - to.y) <= r) this.hitMonster(p, m, packet, attacker, opts);
    }
    this.launchDash(p, dir, from, to, active, rank);
  }

  /** Запуск движения рывка/прыжка к точке `to` (расталкивание весом, `weightMult`). */
  private launchDash(p: PlayerEntity, dir: number, from: Vec2, to: Vec2, active: CastAbility, rank: number): void {
    const travel = Math.hypot(to.x - from.x, to.y - from.y);
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

  /** Нова/AoE (cast shape nova/ground/meteor): по всем в радиусе вокруг игрока. */
  private skillNova(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: CastAbility, opts: HitOpts): void {
    const radius = active.radius || ABILITY_AOE_RADIUS;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= radius) this.hitMonster(p, m, packet, attacker, opts);
    }
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
    p.facing = Math.atan2(d.dy, d.dx);
    const bx = p.pos.x, by = p.pos.y;
    p.vel = { x: d.dx * d.speed, y: d.dy * d.speed };
    p.pos = moveWithCollision(p.pos, p.vel, p.radius, this.world.grid, dt);
    d.remaining -= dt;
    if (d.remaining <= 0 || Math.hypot(p.pos.x - bx, p.pos.y - by) < 0.5) p.dash = null; // конец или упор в стену
  }

  /** Вес (масса) монстра для расталкивания: базовый вес × множитель чемпиона. */
  private monsterMass(m: MonsterEntity): number {
    const mult = m.def.rarity === 'champion' ? this.cfg.get('balance').collision.championWeightMult : 1;
    return m.def.weight * mult;
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
    resolveEntityCollisions(bodies, this.world.grid, bal.collision.iterations);
  }

  /** Проклятие (curse): врагам в радиусе — статус-дебаф (по стихии) и/или притягивание агро (taunt). */
  private applyCurse(p: PlayerEntity, active: CurseAbility): void {
    const kind = active.ailment ? (active.ailment.kind ?? this.cfg.get('magic-subtypes').find((d) => d.id === (active.element ?? 'physical'))?.ailment) : undefined;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) > active.radius) continue;
      if (active.taunt) m.alertTimer = ALERT_TIME;
      if (kind && active.ailment) {
        addDebuffStack(m.debuffs, { kind, chance: active.ailment.chance, mag: active.ailment.mag, mag2: active.ailment.mag2, maxStacks: active.ailment.maxStacks, durationMs: active.ailment.durationMs }, this.world.timeMs);
      }
    }
  }

  private distToSegment(pt: Vec2, a: Vec2, b: Vec2): number {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2));
    return Math.hypot(pt.x - (a.x + abx * t), pt.y - (a.y + aby * t));
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
    this.events.push({ type: 'hit', target: 'monster', id: m.id, by: p.id, x: m.pos.x, y: m.pos.y, hit: true, blocked: false, crit: false, amount, byType: pk });
    if (m.hp <= 0) this.killMonster(m, p);
  }

  private hitMonster(killer: PlayerEntity, m: MonsterEntity, packet: DamagePacket, attacker: CombatStats, opts: HitOpts = {}): void {
    const target: HitTarget = { hp: m.hp, maxHp: m.def.hp, stats: monsterCombatStats(m.def), debuffs: m.debuffs };
    // Аффинити + реактивные мастерства «hit-dealt» (по горящим/фракции/оглушённым).
    const affMult = this.affinityMult(killer.save, m.def.faction);
    const mult = affMult * (1 + this.hitDealtBonus(killer, m));
    const pk = mult !== 1 ? scalePacket(packet, mult) : packet;
    const res = resolvePlayerHit(target, attacker, pk, { ...opts, debuffTuning: this.cfg.get('debuffs') }, this.rng, this.world.timeMs);

    this.events.push({ type: 'hit', target: 'monster', id: m.id, by: killer.id, x: m.pos.x, y: m.pos.y, hit: res.hit, blocked: res.blocked, crit: res.crit, amount: res.damage, byType: res.byType });
    m.alertTimer = ALERT_TIME; // получил внимание/удар — в погоню
    if (!res.hit || res.blocked) return;

    m.hp = target.hp;
    // Вампиризм: доля нанесённого урона → HP/мана атакующего (боевой сустейн, кламп по максимуму).
    if (this.sustain && res.damage > 0) {
      const d = this.snaps.get(killer.id)?.derived;
      if (d) {
        if (d.lifeLeechPct > 0) killer.hp = Math.min(d.maxHp, killer.hp + res.damage * d.lifeLeechPct);
        if (d.manaLeechPct > 0) killer.mana = Math.min(d.maxMana, killer.mana + res.damage * d.manaLeechPct);
      }
    }
    // Прок «шанс каста при ударе» (не от ударов самого прок-скилла — иначе рекурсия).
    if (this.sustain && !this.procActive && res.damage > 0) this.rollHitProcs(killer, 'hit');
    if (!res.died) {
      // Гарантированный стан скилла приоритетнее случайного от оружия/ошеломления.
      if (opts.stunSec && opts.stunSec > 0) { m.stunTimer = Math.max(m.stunTimer, opts.stunSec); this.events.push({ type: 'stun', id: m.id }); }
      else if (res.stunned) { m.stunTimer = Math.max(m.stunTimer, 1.2); this.events.push({ type: 'stun', id: m.id }); }
      // Отброс: по шансу (shoveChance) и масштабируем весом цели — тяжёлого толкает слабее.
      if (opts.knockback && this.rng.float(0, 1) < (opts.shoveChance ?? 1)) {
        const force = opts.knockback * (KNOCKBACK_REF_WEIGHT / Math.max(1, this.monsterMass(m)));
        m.pos = moveWithCollision(m.pos, this.awayDir(killer.pos, m.pos, force), m.radius, this.world.grid, 1);
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
      this.events.push({ type: 'hit', target: 'player', id: p.id, by, x: p.pos.x, y: p.pos.y, hit: res.hit, blocked: res.blocked, crit: false, amount: 0, byType: res.byType });
      return;
    }
    // Реактивные мастерства «hit-taken»: снижение получаемого урона + отражение.
    const tk = this.hitTakenEffects(p, snap);
    const dmg = Math.round(res.total * pm.recvDamageMult * (1 - tk.reduction)); // увечье: +урон; мастерства: −урон
    this.events.push({ type: 'hit', target: 'player', id: p.id, by, x: p.pos.x, y: p.pos.y, hit: true, blocked: false, crit: res.crit, amount: dmg, byType: res.byType });
    p.hp = Math.max(0, p.hp - dmg);
    if (source && tk.reflectPct > 0) this.reflectToMonster(p, source, Math.round(dmg * tk.reflectPct), tk.reflectElement);
    if (p.hp <= 0) { p.alive = false; this.events.push({ type: 'player-died', playerId: p.id }); return; }

    // Прок «шанс каста при ПОЛУЧЕНИИ удара» (игрок выжил; не рекурсим от прок-ударов).
    if (this.sustain && !this.procActive && dmg > 0) this.rollHitProcs(p, 'struck');

    if (onHit.length) {
      const equipped = equippedItems(p.save);
      for (const a of onHit) {
        const poise = armorPoise(equipped, a.kind, this.cfg.get('armor-classes'));
        if (this.rng.chance(a.chance * (1 - poise))) {
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
      const dist = Math.hypot(proj.vel.x, proj.vel.y) * dt;
      const steps = Math.max(1, Math.ceil(dist / 8));
      const sub = dt / steps;
      let gone = false;
      for (let sIdx = 0; sIdx < steps; sIdx++) {
        proj.pos.x += proj.vel.x * sub;
        proj.pos.y += proj.vel.y * sub;
        // Бумеранг: у макс. дальности разворот к владельцу; гаснет, вернувшись к нему.
        if (proj.boomerang && proj.origin) {
          if (!proj.returning && Math.hypot(proj.pos.x - proj.origin.x, proj.pos.y - proj.origin.y) >= (proj.maxRange ?? 300)) {
            proj.returning = true;
            proj.hitIds = []; // на обратном пути бьёт цели заново
          }
          if (proj.returning) {
            const owner = w.players[proj.ownerId as string];
            if (owner) {
              const a = Math.atan2(owner.pos.y - proj.pos.y, owner.pos.x - proj.pos.x);
              const sp = Math.hypot(proj.vel.x, proj.vel.y);
              proj.vel = { x: Math.cos(a) * sp, y: Math.sin(a) * sp };
              if (Math.hypot(proj.pos.x - owner.pos.x, proj.pos.y - owner.pos.y) < 24) { gone = true; break; }
            }
          }
        }
        const cell = worldToCell(proj.pos.x, proj.pos.y);
        // Обычный снаряд гаснет о стену; бумеранг летит поверх препятствий.
        if (!proj.boomerang && isBlockedCell(w.grid, cell.cx, cell.cy)) { gone = true; break; }
        if (this.projectileHit(proj)) { gone = true; break; } // попал (true только у непробивающих)
      }
      if (!gone && proj.ttl > 0) keep.push(proj);
    }
    w.projectiles = keep;
  }

  /** Проверяет попадание снаряда в цель на текущей позиции; применяет урон. */
  private projectileHit(proj: ProjectileEntity): boolean {
    const w = this.world;
    if (proj.owner === 'player') {
      const killer = w.players[proj.ownerId as string];
      for (const m of w.monsters) {
        if (!m.alive) continue;
        if (proj.hitIds && proj.hitIds.includes(m.id)) continue; // пробивающий/бумеранг: не бить дважды
        if (Math.hypot(proj.pos.x - m.pos.x, proj.pos.y - m.pos.y) < proj.radius) {
          if (killer) this.hitMonster(killer, m, proj.packet, proj.attacker, proj.hitOpts ?? {});
          if (proj.pierce || proj.boomerang) { (proj.hitIds ??= []).push(m.id); continue; } // летит дальше
          return true; // обычный снаряд гаснет о первую цель
        }
      }
    } else {
      for (const id of Object.keys(w.players)) {
        const p = w.players[id]!;
        if (!p.alive) continue;
        if (Math.hypot(proj.pos.x - p.pos.x, proj.pos.y - p.pos.y) < proj.radius) {
          const src = w.monsters.find((mm) => mm.id === proj.ownerId);
          this.hitPlayer(p, proj.packet, proj.attacker, proj.onHit ?? [], proj.attackerName ?? 'Враг', src);
          return true;
        }
      }
    }
    return false;
  }

  // ── Смерть монстра: события + золото + дроп + XP ───────────
  private killMonster(m: MonsterEntity, killer: PlayerEntity | undefined): void {
    if (!m.alive) return;
    m.alive = false;
    this.events.push({ type: 'monster-died', id: m.id, def: m.def, x: m.pos.x, y: m.pos.y, by: killer?.id });
    this.overloadOnDeath(m); // сигнатура конструктов: взрыв при смерти
    const reward = killer ?? this.primaryPlayer();
    // Восстановление за убийство (лич-за-килл): плоско HP/мана убийце — боевой сустейн, ДО наград.
    if (this.sustain && reward) {
      const kd = this.snaps.get(reward.id)?.derived;
      if (kd) {
        if (kd.lifeOnKill > 0) reward.hp = Math.min(kd.maxHp, reward.hp + kd.lifeOnKill);
        if (kd.manaOnKill > 0) reward.mana = Math.min(kd.maxMana, reward.mana + kd.manaOnKill);
      }
    }
    if (!this.economy) return; // клиент: золото/XP/дроп делают обработчики шины; сим-микробой: не нужны (и левелап-хил испортил бы TTK)
    if (!reward) return;

    const diff = this.currentDifficulty();
    const level = m.def.level;
    const gold = Math.max(1, Math.round(this.rng.int(1, 5 + level * 2) * diff.goldMult));
    reward.save.gold += gold;
    this.events.push({ type: 'gold', playerId: reward.id, amount: gold, total: reward.save.gold });

    const loot = this.cfg.get('balance').loot;
    if (this.rng.chance(loot.dropChance)) {
      const theme = this.cfg.get('biomes')[0]!;
      const item = generateItem(
        this.cfg.get('items.base'),
        this.cfg.get('affixes'),
        this.cfg.get('uniques'),
        { dropBias: theme.dropBias * diff.magicFind, itemLevel: Math.max(1, level + diff.ilvlBonus), tiers: this.cfg.get('item-tiers'), rarities: this.cfg.get('rarities'), categoryWeights: loot.categoryWeights, rareNames: this.cfg.get('rare-names'), maxReqTotal: this.cfg.get('balance').maxTotalRequirement },
        this.rng,
      );
      const x = m.pos.x + this.rng.int(-8, 8);
      const y = m.pos.y + this.rng.int(-8, 8);
      this.world.drops.push({ id: this.world.nextId++, pos: { x, y }, item });
      this.events.push({ type: 'item-dropped', item, x, y });
    }

    this.awardXp(reward, m.def.xp); // опыт монстра уже отскейлен по его уровню
  }

  /** Начисляет XP и обрабатывает левелапы (полностью лечит, выдаёт очки). */
  private awardXp(p: PlayerEntity, amount: number): void {
    if (amount <= 0) return;
    const save = p.save;
    this.events.push({ type: 'xp', playerId: p.id, amount });
    const { leveled } = gainXp(save, this.cfg.get('balance'), amount);
    if (leveled) {
      const snap = playerSnapshot(save, this.cfg);
      p.hp = snap.derived.maxHp;
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
      if (Math.hypot(d.pos.x - p.pos.x, d.pos.y - p.pos.y) <= 48) {
        const took = this.takeDrop(p, i);
        if (took) this.events.push({ type: 'item-picked', playerId: p.id, item: took.item, x: took.x, y: took.y });
        return; // полон — не поднимаем (took === null), но и других в этот тик не берём
      }
    }
  }

  /**
   * Точечный подбор дропа по id (клиентская команда «клик по предмету» — надёжно, без гонки
   * сэмплирования ввода). Возвращает поднятое (item+координаты для лога/сейва) или null, если
   * дропа нет / далеко (>48) / полный инвентарь. Сервер по результату шлёт SaveUpdate + событие.
   */
  pickupDropById(playerId: string, dropId: number): { item: Item; x: number; y: number } | null {
    const p = this.world.players[playerId];
    if (!p || !p.alive) return null;
    const i = this.world.drops.findIndex((d) => d.id === dropId);
    if (i < 0) return null;
    const d = this.world.drops[i]!;
    if (Math.hypot(d.pos.x - p.pos.x, d.pos.y - p.pos.y) > 48) return null;
    return this.takeDrop(p, i);
  }

  /** Возрождает игрока у входа после смерти: полное HP/мана, сброс дебаффов/стана/тоглов. */
  respawnPlayer(playerId: string): void {
    const p = this.world.players[playerId];
    if (!p) return;
    p.toggles = [];
    p.skillBuffs = {};
    const snap = playerSnapshot(p.save, this.cfg);
    p.pos = { ...this.world.spawn };
    p.vel = { x: 0, y: 0 };
    p.hp = snap.derived.maxHp;
    p.mana = snap.derived.maxMana;
    p.stamina = snap.derived.maxStamina;
    p.debuffs = newDebuffState();
    p.stunTimer = 0;
    p.windup = null;
    p.attackCd = 0;
    p.alive = true;
    this.snaps.set(playerId, snap);
  }

  /**
   * Игрок дёргает рычаг (по `leverId`), если он рядом: открывает ТОЛЬКО его дверь
   * (`Cell.Door→Floor` в общем гриде). Возвращает `doorId` (для броадкаста) или null.
   * Мир общий → открытая дверь видна всей пати сразу.
   */
  openLever(playerId: string, leverId: number): number | null {
    const p = this.world.players[playerId];
    const lv = this.world.levers.find((l) => l.id === leverId);
    if (!p || !lv || lv.used) return null;
    if (Math.hypot(lv.pos.x - p.pos.x, lv.pos.y - p.pos.y) > 56) return null; // проксимити (анти-чит)
    const door = this.world.doors.find((d) => d.id === lv.doorId);
    if (!door) return null;
    for (const c of door.cells) { const row = this.world.grid[c.cy]; if (row) row[c.cx] = Cell.Floor; }
    lv.used = true;
    return door.id;
  }

  /** Выбрасывает предмет из инвентаря игрока на землю у его ног (команда drop). Возвращает предмет или null. */
  dropToGround(playerId: string, uid: string): Item | null {
    const p = this.world.players[playerId];
    if (!p) return null;
    const i = p.save.inventory.findIndex((it) => it.uid === uid);
    if (i < 0) return null;
    const item = p.save.inventory.splice(i, 1)[0]!;
    item.pos = null;
    this.world.drops.push({ id: this.world.nextId++, pos: { x: p.pos.x, y: p.pos.y }, item });
    return item;
  }

  /** Кладёт дроп[index] в авторитетную сетку инвентаря игрока. null — если места нет. */
  private takeDrop(p: PlayerEntity, index: number): { item: Item; x: number; y: number } | null {
    const d = this.world.drops[index]!;
    if (!addToInventory(p.save.inventory, d.item, this.cfg.get('balance').inventory)) return null;
    this.world.drops.splice(index, 1);
    return { item: d.item, x: d.pos.x, y: d.pos.y };
  }

  // ── Помощники ─────────────────────────────────────────────
  private makeNoise(p: PlayerEntity, radius: number): void {
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (Math.hypot(p.pos.x - m.pos.x, p.pos.y - m.pos.y) <= radius) m.alertTimer = ALERT_TIME;
    }
  }

  private nearestPlayer(pos: Vec2): PlayerEntity | undefined {
    let best: PlayerEntity | undefined;
    let bestD = Infinity;
    for (const id of Object.keys(this.world.players)) {
      const p = this.world.players[id]!;
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - pos.x, p.pos.y - pos.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  private primaryPlayer(): PlayerEntity | undefined {
    return this.primaryPlayerId ? this.world.players[this.primaryPlayerId] : undefined;
  }

  private primaryEquipped(): Item[] {
    const p = this.primaryPlayer();
    return p ? equippedItems(p.save) : [];
  }

  private currentDifficulty(): Difficulty {
    const diffs = this.cfg.get('difficulties');
    return diffs.find((d) => d.id === this.world.difficultyId) ?? diffs.find((d) => d.id === 'normal') ?? diffs[0]!;
  }

  private hasLos(a: Vec2, b: Vec2): boolean {
    return hasLineOfSight(this.world.grid, a.x, a.y, b.x, b.y);
  }

  /**
   * Патфайндинг-гибрид (блок B). Если монстр в погоне ДВИЖЕТСЯ К цели и прямой видимости нет —
   * ведём его по BFS-пути (обход стен), заменяя направление m.vel на вектор к следующей путевой
   * точке (скорость сохраняется). Видит цель или движется ОТ неё (кайт/флиа) — не трогаем.
   * Пересчёт пути троттлится (~0.3с) и при достижении точки — findPath дёшев, но не каждый тик.
   */
  private navChase(m: MonsterEntity, targetPos: Vec2, grid: Grid, losClear: boolean, dt: number): void {
    const speed = Math.hypot(m.vel.x, m.vel.y);
    if (speed < 1) { m.waypoint = null; return; }
    const toward = m.vel.x * (targetPos.x - m.pos.x) + m.vel.y * (targetPos.y - m.pos.y) > 0;
    if (toward && !losClear) {
      // Погоня без прямой видимости → обход стен по BFS-пути.
      m.pathCd -= dt;
      const reached = !!m.waypoint && Math.hypot(m.waypoint.x - m.pos.x, m.waypoint.y - m.pos.y) < 16;
      if (!m.waypoint || reached || m.pathCd <= 0) {
        const path = findPath(grid, m.pos, targetPos);
        m.waypoint = path.length ? path[0]! : null;
        m.pathCd = 0.3;
      }
      if (m.waypoint) {
        const wx = m.waypoint.x - m.pos.x, wy = m.waypoint.y - m.pos.y;
        const d = Math.hypot(wx, wy) || 1;
        m.vel.x = (wx / d) * speed;
        m.vel.y = (wy / d) * speed;
      }
      return;
    }
    m.waypoint = null;
    if (!toward) this.avoidWallAhead(m, grid, speed); // кайт/флиа — не пятиться в угол
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
    if (Math.hypot(targetPos.x - m.pos.x, targetPos.y - m.pos.y) >= b.keepDistMin) return; // не жмут — не блинкуем
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

  /** Сигнатура конструктов (signature=overload): при смерти — AoE-урон по игрокам рядом (наказывает мили). */
  private overloadOnDeath(m: MonsterEntity): void {
    if (!this.sustain) return; // боевой эффект (угроза моба) — только когда сустейн включён
    if (behaviorFor(m.def.faction, this.cfg.get('monster-behaviors')).signature !== 'overload') return;
    const radius = m.radius + 48;
    const a = this.monsterPacket(m);
    for (const id of Object.keys(this.world.players)) {
      const p = this.world.players[id]!;
      if (!p.alive) continue;
      if (Math.hypot(p.pos.x - m.pos.x, p.pos.y - m.pos.y) <= radius + p.radius) {
        this.hitPlayer(p, a.packet, a.attacker, a.debuffs, `${m.def.name} (взрыв)`, m);
      }
    }
  }

  private wrap(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  private awayDir(from: Vec2, to: Vec2, force: number): Vec2 {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    return { x: Math.cos(ang) * force, y: Math.sin(ang) * force };
  }
}
