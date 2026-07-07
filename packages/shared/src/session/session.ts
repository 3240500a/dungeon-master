import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { Item, WeaponType } from '../types/items.js';
import type { ScaledMonster, MonsterFaction } from '../types/world.js';
import type { CombatStats, DamagePacket, DamageType } from '../types/combat.js';
import type { StatModifier } from '../types/attributes.js';
import { emptyPacket, packetTotal } from '../types/combat.js';
import type { Difficulty } from '../formulas/power.js';
import { createRng, type Rng } from '../formulas/rng.js';
import { resolveAttack, abilityCooldown, abilityRankMult } from '../formulas/combat.js';
import { buildAttackPacket, attackWeaponsOf } from '../formulas/playerCombat.js';
import { buildMonsterPacket, monsterCombatStats, monsterDebuffs } from '../formulas/monstergen.js';
import { weaponDebuffs } from '../formulas/resolveWeapon.js';
import { armorPoise, armorNoise } from '../formulas/resolveArmor.js';
import { generateItem } from '../formulas/itemgen.js';
import { gainXp } from '../economy/progression.js';
import { resolvePlayerHit, type HitTarget, type PlayerHitOptions } from '../world/combat.js';
import { debuffMods, addDebuffStack, tickDebuffs, newDebuffState, type DebuffApply } from '../world/debuffs.js';
import type { ConfigShapes } from '../config/schemas.js';
import { moveWithCollision, type Vec2 } from '../world/movement.js';
import { activeAbilityOf, reservedManaFrac, effectiveMaxMana, toggleBuffMods } from './toggles.js';
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

/** Спецификация активной способности (из конфига, новая модель). */
type ActiveAbility = NonNullable<ConfigShapes['skills-active'][number]['nodes'][number]['effect']['active']>;
/** Опции применения удара (оружие/скилл): к PlayerHitOptions добавлены отброс и гарант. стан. */
type HitOpts = PlayerHitOptions & { knockback?: number; stunSec?: number };
/** Типы-удары (тайминг от скорости атаки). Остальные — утилити (по мане). */
const ATTACK_SKILL = new Set<ActiveAbility['type']>(['strike', 'cleave', 'projectile', 'boomerang', 'dash']);

export class GameSession {
  readonly world: WorldState;
  private cfg: ConfigRegistry;
  private rng: Rng;
  private primaryPlayerId?: string;
  private events: SessionEvent[] = [];
  /** Кэш боевого снимка каждого игрока на текущий тик. */
  private snaps = new Map<string, PlayerSnapshot>();
  private floorCleared = false;
  /**
   * Начисляет ли сессия золото/XP/дроп при смерти монстра. true — сим (авторитетно).
   * false — клиент: сессия только детектит смерть и эмитит событие, а лут/XP делают
   * существующие обработчики шины (LootController/Progression), чтобы не задвоить.
   */
  private rewards: boolean;

  constructor(cfg: ConfigRegistry, seed: number, difficultyId: string, opts: { rewards?: boolean } = {}) {
    this.cfg = cfg;
    this.rng = createRng((seed >>> 0) || 1);
    this.world = newWorldState([], seed, 0, difficultyId);
    this.rewards = opts.rewards ?? true;
  }

  /** Добавляет игрока (один раз за забег); HP/мана — полные. */
  addPlayer(id: string, save: SaveState, spawnAt?: Vec2): PlayerEntity {
    const snap = playerSnapshot(save, this.cfg);
    // Обычно спавним в точке входа мира (центр города/этажа); при реконнекте — в заданной
    // точке (та же позиция). Кооп-присоединение происходит ПОСЛЕ enterFloor.
    const p = makePlayerEntity(id, save, spawnAt ? { ...spawnAt } : { ...this.world.spawn }, snap.derived.maxHp, snap.derived.maxMana);
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
        const hpRegenMult = debuffMods(p.debuffs).hpRegenMult;
        if (p.hp < d.maxHp) p.hp = Math.min(d.maxHp, p.hp + d.hpRegen * hpRegenMult * dt);
        // Тоглы/ауры резервируют долю маны — эффективный максимум ниже, регенерируем до него.
        const effMaxMana = effectiveMaxMana(d.maxMana, this.reservedFrac(p));
        if (p.mana > effMaxMana) p.mana = effMaxMana; // подрезка при включении тогла
        else if (p.mana < effMaxMana) p.mana = Math.min(effMaxMana, p.mana + d.manaRegen * dt);
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
    for (const m of w.monsters) {
      if (!m.alive) continue;
      // DoT кровотечения + реген (у чемпионов; «увечье» режет реген).
      const dm = debuffMods(m.debuffs);
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
      const losClear = this.hasLos(m.pos, target.pos);
      const action = stepMonsterAi(m, target.pos, losClear, noiseMult, dt);
      m.pos = moveWithCollision(m.pos, m.vel, m.radius, w.grid, dt);
      if (action === 'attack') this.monsterMelee(m, target);
      else if (action === 'shoot') this.monsterShoot(m, target);
    }

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
    const pm = debuffMods(p.debuffs);
    const stunned = p.stunTimer > 0;
    // Замах и стан «укореняют» — движение блокируется; стан вдобавок глушит действия.
    const rooted = stunned || !!p.windup;
    if (input && !stunned) p.facing = input.facing;
    if (input && !rooted) {
      const len = Math.hypot(input.move.x, input.move.y);
      if (len > 0) {
        const speed = snap.derived.moveSpeed * pm.moveMult;
        p.vel = { x: (input.move.x / len) * speed, y: (input.move.y / len) * speed };
      } else {
        p.vel = { x: 0, y: 0 };
      }
    } else {
      p.vel = { x: 0, y: 0 };
    }
    p.pos = moveWithCollision(p.pos, p.vel, p.radius, this.world.grid, dt);

    if (stunned) return; // оглушён — ни атаки, ни каста
    if (input?.attack) this.tryPlayerAttack(p, snap);
    if (input?.cast != null) this.castSkill(p, snap, input.cast);
    if (input?.interact) this.tryPickup(p);
  }

  /** Базовая атака игрока (по типу оружия; дуал-вилд бьёт руками по очереди). */
  private tryPlayerAttack(p: PlayerEntity, snap: PlayerSnapshot): void {
    if (p.attackCd > 0) return;
    const save = p.save;
    const hands = attackWeaponsOf(save);
    const dual = hands.length > 1;
    const weapon = hands[p.swingHand % hands.length];
    p.swingHand++;
    const speedBonus = dual ? 1.2 : 1;
    const pm = debuffMods(p.debuffs);
    p.attackCd = 1 / Math.max(0.2, snap.derived.attackSpeed * speedBonus * pm.atkSpeedMult);
    this.makeNoise(p, 220);

    const wt: WeaponType = weapon?.weaponType ?? 'melee';
    if (wt === 'magic') {
      if (p.mana < 4) return;
      p.mana -= 4;
    }
    const scaling = this.cfg.get('balance').weaponAttrScaling;
    const packet = buildAttackPacket(snap.derived, snap.attrs, weapon, scaling, this.weights(), this.rng);
    if (pm.outDamageMult !== 1) for (const t of Object.keys(packet) as DamageType[]) packet[t] *= pm.outDamageMult;
    const attacker = pm.accuracyMult !== 1 ? { ...snap.combat, accuracy: snap.combat.accuracy * pm.accuracyMult } : snap.combat;

    if (wt === 'melee') this.meleeSwing(p, packet, attacker, weapon);
    else this.spawnProjectile(p, packet, attacker, wt === 'ranged' ? PLAYER_PROJ_SPEED : ABILITY_PROJ_SPEED, p.facing);
  }

  /** Взмах: дальность/дуга по оружию (копьё длиннее, топор шире). */
  private meleeSwing(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, weapon?: Item): void {
    const range = 52 * (weapon?.reachMult ?? 1);
    const arc = 0.8 * (weapon?.arcMult ?? 1);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      const dx = m.pos.x - p.pos.x;
      const dy = m.pos.y - p.pos.y;
      if (Math.hypot(dx, dy) > range) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(this.wrap(ang - p.facing)) > arc) continue;
      this.hitMonster(p, m, packet, attacker, this.weaponHitOpts(weapon));
    }
  }

  /** Опции удара из сигнатур оружия (броне-пробитие/добивание/стан/дебаффы/отброс). */
  private weaponHitOpts(weapon?: Item): HitOpts {
    return {
      armorPen: weapon?.armorPenPct,
      lowHpBonusPct: weapon?.lowHpBonusPct,
      stunChance: weapon?.stunChance,
      onHit: weapon ? weaponDebuffs(weapon, this.cfg.get('phys-subtypes'), this.weights(), this.cfg.get('balance').twoHandedPowerMult) : [],
      knockback: weapon?.knockback,
    };
  }

  // ── Активные скиллы ───────────────────────────────────────
  /** Активная способность узла в дереве класса игрока (или undefined). */
  private activeById(save: SaveState, nodeId: string): ActiveAbility | undefined {
    return activeAbilityOf(this.cfg, save.classId, nodeId);
  }

  private castSkill(p: PlayerEntity, snap: PlayerSnapshot, nodeId: string): void {
    const active = this.activeById(p.save, nodeId);
    if (!active) return;
    const rank = p.save.activeSkills[nodeId] ?? 1;

    // Легаси (без type): КД-модель + старое поведение по имени.
    if (!active.type) {
      if ((p.skillCd[nodeId] ?? 0) > 0) return;
      if (p.mana < active.manaCost) return;
      p.mana -= active.manaCost;
      if (active.cooldown > 0) p.skillCd[nodeId] = abilityCooldown(active.cooldown, rank);
      this.executeLegacy(p, snap, active.abilityId, rank);
      return;
    }

    // Тоглы/стойки/ауры: вкл/выкл, эксклюзив-группа, резерв маны. Без маны за каст.
    if (active.type === 'toggle') { this.toggleStance(p, snap, nodeId, active); return; }

    // Баффы: временные стат-моды за ману, без КД; не рефрешим, пока активны.
    if (active.type === 'buff') {
      if ((p.skillBuffs[nodeId] ?? 0) > 0) return; // уже активен
      if (p.mana < active.manaCost) return;
      p.mana -= active.manaCost;
      p.skillBuffs[nodeId] = active.durationSec ?? 10;
      return;
    }

    // Удары — тайминг от скорости атаки; прочая утилити — по мане, без КД.
    if (ATTACK_SKILL.has(active.type)) {
      if (p.attackCd > 0 || p.windup) return; // делит тайминг с базовой атакой; занят замахом
      if (p.mana < active.manaCost) return;
      p.mana -= active.manaCost;
      const pm = debuffMods(p.debuffs);
      p.attackCd = 1 / Math.max(0.2, snap.derived.attackSpeed * active.speed * pm.atkSpeedMult);
      // Тяжёлый удар с замахом: сработает по завершении (может быть прерван станом).
      if (active.windupSec > 0) { p.windup = { nodeId, rank, remaining: active.windupSec }; return; }
      this.executeAbility(p, snap, active, rank);
      return;
    }
    if (p.mana < active.manaCost) return;
    p.mana -= active.manaCost;
    this.executeAbility(p, snap, active, rank);
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
      const a = this.activeById(p.save, wu.nodeId);
      if (a) this.executeAbility(p, snap, a, wu.rank);
    }
  }

  /** Включает/выключает тогл: гасит другие в его эксклюзив-группе, резервирует ману. */
  private toggleStance(p: PlayerEntity, snap: PlayerSnapshot, nodeId: string, active: ActiveAbility): void {
    if (p.toggles.includes(nodeId)) { p.toggles = p.toggles.filter((t) => t !== nodeId); return; } // выкл
    // Эксклюзив-группа: одновременно активна только одна стойка группы.
    if (active.toggleGroup) {
      p.toggles = p.toggles.filter((t) => this.activeById(p.save, t)?.toggleGroup !== active.toggleGroup);
    }
    const reserveFrac = this.reservedFrac(p) + (active.reservePct ?? 0);
    if (reserveFrac >= 1) return; // нельзя зарезервировать всю ману
    p.toggles.push(nodeId);
    const effMax = effectiveMaxMana(snap.derived.maxMana, reserveFrac);
    if (p.mana > effMax) p.mana = effMax; // сразу подрезать под новый резерв
  }

  /** Суммарная доля зарезервированной маны от активных тоглов (кап 0.9). */
  private reservedFrac(p: PlayerEntity): number {
    return reservedManaFrac(this.cfg, p.save.classId, p.toggles);
  }

  /** Рантайм-стат-моды поверх сейва: buffMods активных тоглов + временных баффов. */
  private runtimeMods(p: PlayerEntity): StatModifier[] {
    if (p.toggles.length === 0 && Object.keys(p.skillBuffs).length === 0) return [];
    const mods = toggleBuffMods(this.cfg, p.save.classId, p.toggles);
    for (const id of Object.keys(p.skillBuffs)) { const a = this.activeById(p.save, id); if (a?.buffMods) mods.push(...a.buffMods); }
    return mods;
  }

  private scaling(): Record<WeaponType, number> {
    return this.cfg.get('balance').weaponAttrScaling;
  }

  private weights(): ConfigShapes['weapon-weights'] {
    return this.cfg.get('weapon-weights');
  }

  /** Старое поведение (нова/веер по имени) — для скиллов без active.type. */
  private executeLegacy(p: PlayerEntity, snap: PlayerSnapshot, abilityId: string, rank: number): void {
    const attacker = snap.combat;
    const elem = abilityElementOf(abilityId);
    const rankMult = abilityRankMult(rank);
    const base = packetTotal(buildAttackPacket(snap.derived, snap.attrs, p.save.equipment.weapon, this.scaling(), this.weights(), this.rng));
    const mkPacket = (mult: number): DamagePacket => { const pk = emptyPacket(); pk[elem] = base * mult * rankMult; return pk; };
    if (isAoeAbility(abilityId)) {
      for (const m of this.world.monsters) {
        if (!m.alive) continue;
        if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= ABILITY_AOE_RADIUS) this.hitMonster(p, m, mkPacket(1.5), attacker);
      }
    } else {
      for (const off of [-0.2, 0, 0.2]) this.spawnProjectile(p, mkPacket(1.4), attacker, ABILITY_PROJ_SPEED, p.facing + off);
    }
  }

  /** Новая модель: диспетчеризация по active.type. */
  private executeAbility(p: PlayerEntity, snap: PlayerSnapshot, active: ActiveAbility, rank: number): void {
    const element = active.element ?? abilityElementOf(active.abilityId);
    const base = packetTotal(buildAttackPacket(snap.derived, snap.attrs, p.save.equipment.weapon, this.scaling(), this.weights(), this.rng));
    const dmg = base * active.damageMult * abilityRankMult(rank);
    const packet = (): DamagePacket => { const pk = emptyPacket(); pk[element] = dmg; return pk; };
    const attacker = snap.combat;
    const opts = this.skillHitOpts(active, element, p.save.equipment.weapon);
    switch (active.type) {
      case 'strike': this.skillStrike(p, packet(), attacker, active, opts); break;
      case 'cleave': this.skillCleave(p, packet(), attacker, active, opts); break;
      case 'nova': this.skillNova(p, packet(), attacker, active, opts); break;
      case 'projectile': this.skillProjectile(p, packet(), attacker, active, opts); break;
      case 'boomerang': this.skillBoomerang(p, packet(), attacker, active, opts); break;
      case 'dash': this.skillDash(p, packet(), attacker, active, opts); break;
      case 'curse': this.skillCurse(p, active); break;
      default: break; // toggle/buff/ground/meteor — фазы B/C
    }
  }

  /** Опции удара скилла: отброс, гарант. стан, наложение стих. статуса по стихии. */
  private skillHitOpts(active: ActiveAbility, element: DamageType, weapon?: Item): HitOpts {
    // База — свойства оружия (armorPen/lowHp/stunChance + физ. дебаффы, напр. ошеломление
    // от булавы), поверх — эффекты скилла (гарант. стан, отброс, стих. статус).
    const opts: HitOpts = weapon ? this.weaponHitOpts(weapon) : {};
    if (active.knockback) opts.knockback = active.knockback;
    if (active.stunSec) opts.stunSec = active.stunSec;
    if (active.ailment) {
      const kind = this.cfg.get('damage-types').find((d) => d.id === element)?.ailment;
      if (kind) {
        const ail: DebuffApply = { kind, chance: active.ailment.chance, mag: active.ailment.mag, mag2: active.ailment.mag2, maxStacks: active.ailment.maxStacks, durationMs: active.ailment.durationMs };
        opts.onHit = [...(opts.onHit ?? []), ail];
      }
    }
    return opts;
  }

  /** Одиночный удар: ближайший монстр в дуге/дальности перед игроком. */
  private skillStrike(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: ActiveAbility, opts: HitOpts): void {
    const range = 60 * active.rangeMult;
    const arc = 0.6 * active.arcMult;
    let best: MonsterEntity | undefined; let bd = Infinity;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      const dx = m.pos.x - p.pos.x, dy = m.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > range || d >= bd) continue;
      if (Math.abs(this.wrap(Math.atan2(dy, dx) - p.facing)) > arc) continue;
      bd = d; best = m;
    }
    if (best) this.hitMonster(p, best, packet, attacker, opts);
  }

  /** Дуга: все монстры в конусе перед игроком. */
  private skillCleave(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: ActiveAbility, opts: HitOpts): void {
    const range = 52 * active.rangeMult;
    const arc = 0.8 * active.arcMult;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      const dx = m.pos.x - p.pos.x, dy = m.pos.y - p.pos.y;
      if (Math.hypot(dx, dy) > range) continue;
      if (Math.abs(this.wrap(Math.atan2(dy, dx) - p.facing)) > arc) continue;
      this.hitMonster(p, m, packet, attacker, opts);
    }
  }

  /** Нова: AoE вокруг игрока. */
  private skillNova(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: ActiveAbility, opts: HitOpts): void {
    const radius = active.radius || ABILITY_AOE_RADIUS;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= radius) this.hitMonster(p, m, packet, attacker, opts);
    }
  }

  /** Снаряды: веер count с разбросом spread; опц. пробитие. */
  private skillProjectile(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: ActiveAbility, opts: HitOpts): void {
    const n = active.count, spread = active.spread;
    for (let i = 0; i < n; i++) {
      const off = n > 1 ? -spread / 2 + (spread * i) / (n - 1) : 0;
      this.spawnProjectile(p, packet, attacker, PLAYER_PROJ_SPEED, p.facing + off, { pierce: active.pierce, hitOpts: opts });
    }
  }

  /** Бумеранг: летит вперёд, разворачивается к владельцу, бьёт на лету в обе стороны. */
  private skillBoomerang(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: ActiveAbility, opts: HitOpts): void {
    const dir = p.facing;
    this.world.projectiles.push({
      id: this.world.nextId++, pos: { ...p.pos },
      vel: { x: Math.cos(dir) * ABILITY_PROJ_SPEED, y: Math.sin(dir) * ABILITY_PROJ_SPEED },
      radius: PROJ_HIT_RADIUS, ttl: 4, owner: 'player', ownerId: p.id,
      packet, attacker, hitOpts: opts,
      boomerang: true, origin: { ...p.pos }, returning: false, maxRange: active.radius || 320, hitIds: [],
    });
  }

  /** Рывок: игрок прыгает вперёд, расталкивая и раня монстров на пути. */
  private skillDash(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, active: ActiveAbility, opts: HitOpts): void {
    const dir = p.facing;
    const dist = 130 * active.rangeMult;
    const from = { ...p.pos };
    const to = moveWithCollision(p.pos, { x: Math.cos(dir) * dist, y: Math.sin(dir) * dist }, p.radius, this.world.grid, 1);
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (this.distToSegment(m.pos, from, to) <= 42) this.hitMonster(p, m, packet, attacker, opts);
    }
    p.pos = to;
  }

  /** Проклятие/провокация: агро всех в радиусе (доп. эффекты — фаза C). */
  private skillCurse(p: PlayerEntity, active: ActiveAbility): void {
    const radius = active.radius || 200;
    for (const m of this.world.monsters) {
      if (!m.alive) continue;
      if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= radius) m.alertTimer = ALERT_TIME;
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
    const res = resolvePlayerHit(target, attacker, pk, opts, this.rng, this.world.timeMs);

    this.events.push({ type: 'hit', target: 'monster', id: m.id, by: killer.id, x: m.pos.x, y: m.pos.y, hit: res.hit, blocked: res.blocked, crit: res.crit, amount: res.damage, byType: res.byType });
    m.alertTimer = ALERT_TIME; // получил внимание/удар — в погоню
    if (!res.hit || res.blocked) return;

    m.hp = target.hp;
    if (!res.died) {
      // Гарантированный стан скилла приоритетнее случайного от оружия/ошеломления.
      if (opts.stunSec && opts.stunSec > 0) { m.stunTimer = Math.max(m.stunTimer, opts.stunSec); this.events.push({ type: 'stun', id: m.id }); }
      else if (res.stunned) { m.stunTimer = Math.max(m.stunTimer, 1.2); this.events.push({ type: 'stun', id: m.id }); }
      if (opts.knockback) m.pos = moveWithCollision(m.pos, this.awayDir(killer.pos, m.pos, opts.knockback), m.radius, this.world.grid, 1);
    } else {
      this.killMonster(m, killer);
    }
  }

  private hitPlayer(p: PlayerEntity, packet: DamagePacket, attacker: CombatStats, onHit: DebuffApply[], by: string, source?: MonsterEntity): void {
    const snap = this.snaps.get(p.id);
    if (!snap) return;
    const pm = debuffMods(p.debuffs);
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

    if (onHit.length) {
      const equipped = equippedItems(p.save);
      for (const a of onHit) {
        const poise = armorPoise(equipped, a.kind, this.cfg.get('armor-classes'));
        if (this.rng.chance(a.chance * (1 - poise))) {
          addDebuffStack(p.debuffs, { ...a, durationMs: a.durationMs * (1 - poise) }, this.world.timeMs);
        }
      }
    }
  }

  // ── Монстр атакует ────────────────────────────────────────
  private monsterPacket(m: MonsterEntity): { packet: DamagePacket; attacker: CombatStats; debuffs: DebuffApply[] } {
    const dm = debuffMods(m.debuffs);
    const packet = buildMonsterPacket(m.def, this.rng);
    if (dm.outDamageMult !== 1) for (const t of Object.keys(packet) as DamageType[]) packet[t] *= dm.outDamageMult;
    const base = monsterCombatStats(m.def);
    const attacker = dm.accuracyMult !== 1 ? { ...base, accuracy: base.accuracy * dm.accuracyMult } : base;
    return { packet, attacker, debuffs: monsterDebuffs(m.def, this.cfg.get('phys-subtypes')) };
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
    if (!this.rewards) return; // клиент: золото/XP/дроп делают обработчики шины
    const reward = killer ?? this.primaryPlayer();
    if (!reward) return;

    const diff = this.currentDifficulty();
    const level = m.def.level;
    const gold = Math.max(1, Math.round(this.rng.int(1, 5 + level * 2) * diff.goldMult));
    reward.save.gold += gold;
    this.events.push({ type: 'gold', playerId: reward.id, amount: gold, total: reward.save.gold });

    const loot = this.cfg.get('balance').loot;
    if (this.rng.chance(loot.dropChance)) {
      const theme = this.cfg.get('dungeons')[0]!;
      const item = generateItem(
        this.cfg.get('items.base'),
        this.cfg.get('affixes'),
        this.cfg.get('uniques'),
        { dropBias: theme.dropBias * diff.magicFind, itemLevel: Math.max(1, level + diff.ilvlBonus), tiers: this.cfg.get('item-tiers'), rarities: this.cfg.get('rarities'), categoryWeights: loot.categoryWeights },
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
      // Мана — только до эффективного максимума: активные ауры/стойки резервируют часть пула.
      p.mana = effectiveMaxMana(snap.derived.maxMana, this.reservedFrac(p));
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

  private wrap(a: number): number {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  private awayDir(from: Vec2, to: Vec2, force: number): Vec2 {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    return { x: Math.cos(ang) * force, y: Math.sin(ang) * force };
  }
}
