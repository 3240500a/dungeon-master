import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { AttackType } from '../types/items.js';
import type { MonsterEntity, PlayerEntity, DropEntity, WorldState } from '../world/state.js';
import type { Vec2 } from '../world/movement.js';
import { findPath } from '../world/pathfind.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import { playerSnapshot } from './derive.js';
import { isAoeAbility, ABILITY_AOE_RADIUS, type PlayerInput } from './session.js';

/**
 * Бот-мозг: превращает состояние мира в `PlayerInput` — как играл бы человек, но без
 * картинки. Навигация по сетке (BFS, обход стен), липкость цели, AoE-скиллы по
 * кластерам, кайт/отход от центроида пачки на низком HP. Даёт «сим = игра»: тот же
 * `GameSession.tick`, только вход от ИИ, а не от мыши.
 */
const REPATH_TICKS = 6; // как часто пересчитывать путь (в тиках)
const WAYPOINT_REACHED = 18; // px до путевой точки, чтобы перейти к следующей
const AOE_TRIGGER = 3; // столько монстров в радиусе AoE, чтобы швырнуть площадную
const POTION_HP = 0.5; // пьём зелье ниже этой доли HP
const POTION_COOLDOWN_TICKS = 30; // ~1с между зельями (не выхлебать пояс за тик)

/**
 * Лестница мастерства бота (для калибровки TTK «по уровню игры»): каждый тир добавляет умение.
 *  basic — только автоатака (фейстанк); kite — +кайт/отход; potions — +зелья; rotation — +скиллы (полная игра).
 */
export type BotTier = 'basic' | 'kite' | 'potions' | 'rotation';
const TIER_RANK: Record<BotTier, number> = { basic: 0, kite: 1, potions: 2, rotation: 3 };

/**
 * Стиль прохождения этажа (радиус преследования → когда идём к выходу):
 *  clear — зачищаем ВЕСЬ этаж (гонимся за любым мобом; выход только после зачистки; больше XP/лута, дольше/рискованнее);
 *  balanced — чистим по пути и вокруг, затем к выходу (дефолт);
 *  rush — почти сразу к выходу, бьём только то, что вплотную (быстро, мало XP/лута).
 */
export type BotStyle = 'clear' | 'balanced' | 'rush';
const AGGRO_BY_STYLE: Record<BotStyle, number> = { clear: Infinity, balanced: 300, rush: 140 };

export class BotController {
  private path: Vec2[] = [];
  private goalKey = '';
  private lastRepathTick = -999;
  private retreating = false;
  private targetId: number | null = null;
  private lastPotionTick = -999;
  /** Выученные активки бота (id + AoE-флаг), обновляются в syncHotbar. */
  private skills: { id: string; aoe: boolean }[] = [];

  private readonly aggro: number;
  constructor(private cfg: ConfigRegistry, private tier: BotTier = 'rotation', style: BotStyle = 'balanced') {
    this.aggro = AGGRO_BY_STYLE[style];
  }

  private attackType(save: SaveState): AttackType {
    return save.equipment.weapon?.attackType ?? 'melee';
  }

  /** Собирает до 4 выученных активок (с AoE-пометкой) как арсенал бота. */
  syncHotbar(save: SaveState): void {
    const tree = this.cfg.get('skill-tree');
    const learned = Object.keys(save.skills).filter((id) => (save.skills[id] ?? 0) > 0);
    this.skills = learned.slice(0, 4).map((id) => {
      const aid = tree.nodes.find((n) => n.id === id)?.effect.active?.abilityId;
      return { id, aoe: aid ? isAoeAbility(aid) : false };
    });
  }

  private readySkill(p: PlayerEntity, aoe: boolean): string | null {
    for (const s of this.skills) if (s.aoe === aoe && (p.skillCd[s.id] ?? 0) <= 0) return s.id;
    return null;
  }

  /** Шаг навигации к цели: ведёт по кэш-пути (с пересчётом), возвращает вектор движения. */
  private navigate(world: WorldState, p: PlayerEntity, goal: Vec2, goalKey: string): Vec2 {
    const stale = world.tick - this.lastRepathTick >= REPATH_TICKS;
    if (goalKey !== this.goalKey || stale || this.path.length === 0) {
      this.path = findPath(world.grid, p.pos, goal);
      this.goalKey = goalKey;
      this.lastRepathTick = world.tick;
    }
    while (this.path.length && Math.hypot(this.path[0]!.x - p.pos.x, this.path[0]!.y - p.pos.y) <= WAYPOINT_REACHED) {
      this.path.shift();
    }
    const wp = this.path[0] ?? goal;
    return { x: wp.x - p.pos.x, y: wp.y - p.pos.y };
  }

  input(world: WorldState, p: PlayerEntity): PlayerInput {
    const at = this.attackType(p.save);
    const useKite = TIER_RANK[this.tier] >= 1;
    const usePotions = TIER_RANK[this.tier] >= 2;
    const useSkills = TIER_RANK[this.tier] >= 3;
    const maxHp = playerSnapshot(p.save, this.cfg).derived.maxHp;
    const hpFrac = p.hp / Math.max(1, maxHp);
    // Гистерезис: уходим в защиту ниже 40% HP, возвращаемся в бой только выше 70% (тир ≥ kite).
    if (hpFrac < 0.4) this.retreating = true;
    else if (hpFrac > 0.7) this.retreating = false;
    const lowHp = useKite && this.retreating;

    // Зелье: ниже порога HP и не чаще КД — берём первый лечащий расходник пояса (тир ≥ potions).
    let useBelt: number | undefined;
    if (usePotions && hpFrac < POTION_HP && world.tick - this.lastPotionTick >= POTION_COOLDOWN_TICKS) {
      const slot = p.save.belt.findIndex((it) => !!it?.use && ((it.use.heal ?? 0) > 0 || (it.use.healPct ?? 0) > 0));
      if (slot >= 0) { useBelt = slot; this.lastPotionTick = world.tick; }
    }

    // Сбор монстров: ближайший, «липкая» цель, центроид и кластер вокруг игрока.
    let nearest: MonsterEntity | undefined;
    let nd = Infinity;
    let sticky: MonsterEntity | undefined;
    let cx = 0;
    let cy = 0;
    let cn = 0;
    let cluster = 0;
    for (const m of world.monsters) {
      if (!m.alive) continue;
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
      if (d < nd) { nd = d; nearest = m; }
      if (m.id === this.targetId) sticky = m;
      if (d <= 220) { cx += m.pos.x; cy += m.pos.y; cn++; }
      if (d <= ABILITY_AOE_RADIUS) cluster++;
    }
    // Липкость в пределах aggro; за aggro цель бросаем (пойдём к выходу), не гоняясь через весь этаж.
    const near = nearest && nd <= this.aggro ? nearest : undefined;
    const target = sticky && Math.hypot(sticky.pos.x - p.pos.x, sticky.pos.y - p.pos.y) <= this.aggro ? sticky : near;
    this.targetId = target ? target.id : null;

    let drop: DropEntity | undefined;
    let dd = Infinity;
    for (const dr of world.drops) {
      const d = Math.hypot(dr.pos.x - p.pos.x, dr.pos.y - p.pos.y);
      if (d < dd) { dd = d; drop = dr; }
    }

    let move: Vec2 = { x: 0, y: 0 };
    let facing = p.facing;
    let attack = false;
    let cast: string | null = null;
    let interact = false;

    // Паник/клир: AoE по кластеру — в любом состоянии (в т.ч. отступая — расчистить).
    if (useSkills && cluster >= AOE_TRIGGER) cast = this.readySkill(p, true);

    if (target) {
      const dx = target.pos.x - p.pos.x;
      const dy = target.pos.y - p.pos.y;
      facing = Math.atan2(dy, dx);
      const engage = at === 'melee' ? 46 : 300;
      const kite = useKite && at !== 'melee' && nd < 70;
      const los = hasLineOfSight(world.grid, p.pos.x, p.pos.y, target.pos.x, target.pos.y);

      if (lowHp || kite) {
        // Отходим от центроида пачки (не пятимся в другой пак), иначе — от цели.
        move = cn > 0 ? { x: p.pos.x - cx / cn, y: p.pos.y - cy / cn } : { x: -dx, y: -dy };
      } else if (Math.hypot(dx, dy) > engage || !los) {
        move = this.navigate(world, p, target.pos, `m${target.id}`);
      } else {
        this.path = [];
      }

      const tdist = Math.hypot(dx, dy);
      const atkRange = at === 'melee' ? 60 : 340;
      if (los && tdist <= atkRange) attack = true;
      // Одиночный скилл — только не в защите, по видимой цели в дальности.
      if (useSkills && cast == null && !lowHp && los && tdist <= (at === 'melee' ? 150 : 340)) {
        cast = this.readySkill(p, false);
      }
    } else if (drop && !lowHp && dd <= this.aggro) {
      facing = Math.atan2(drop.pos.y - p.pos.y, drop.pos.x - p.pos.x);
      if (dd > 24) move = this.navigate(world, p, drop.pos, `d${drop.id}`);
    } else if (world.exits && world.exits.length && !lowHp) {
      // рядом ни цели, ни лута — идём к ближайшему выходу (спуск), не зачищая весь этаж (как игрок).
      let ex = world.exits[0]!, ed = Infinity;
      for (const e of world.exits) { const d = Math.hypot(e.x - p.pos.x, e.y - p.pos.y); if (d < ed) { ed = d; ex = e; } }
      facing = Math.atan2(ex.y - p.pos.y, ex.x - p.pos.x);
      if (ed > 20) move = this.navigate(world, p, ex, 'exit');
    }

    if (drop && dd <= 44) interact = true;

    return { move, facing, attack, cast, interact, useBelt };
  }
}
