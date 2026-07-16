import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { WeaponType } from '../types/items.js';
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

export class BotController {
  private path: Vec2[] = [];
  private goalKey = '';
  private lastRepathTick = -999;
  private retreating = false;
  private targetId: number | null = null;
  /** Выученные активки бота (id + AoE-флаг), обновляются в syncHotbar. */
  private skills: { id: string; aoe: boolean }[] = [];

  constructor(private cfg: ConfigRegistry) {}

  private weaponType(save: SaveState): WeaponType {
    return save.equipment.weapon?.weaponType ?? 'melee';
  }

  /** Собирает до 4 выученных активок (с AoE-пометкой) как арсенал бота. */
  syncHotbar(save: SaveState): void {
    const tree = this.cfg.get('skill-tree');
    const learned = Object.keys(save.activeSkills).filter((id) => (save.activeSkills[id] ?? 0) > 0);
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
    const wt = this.weaponType(p.save);
    const maxHp = playerSnapshot(p.save, this.cfg).derived.maxHp;
    const hpFrac = p.hp / Math.max(1, maxHp);
    // Гистерезис: уходим в защиту ниже 40% HP, возвращаемся в бой только выше 70%.
    if (hpFrac < 0.4) this.retreating = true;
    else if (hpFrac > 0.7) this.retreating = false;
    const lowHp = this.retreating;

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
    // Липкость: держим текущую цель, пока жива и не слишком далеко, иначе — ближайшая.
    const target = sticky && Math.hypot(sticky.pos.x - p.pos.x, sticky.pos.y - p.pos.y) <= 360 ? sticky : nearest;
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
    if (cluster >= AOE_TRIGGER) cast = this.readySkill(p, true);

    if (target) {
      const dx = target.pos.x - p.pos.x;
      const dy = target.pos.y - p.pos.y;
      facing = Math.atan2(dy, dx);
      const engage = wt === 'melee' ? 46 : wt === 'ranged' ? 300 : 260;
      const kite = wt !== 'melee' && nd < 70;
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
      const atkRange = wt === 'melee' ? 60 : 340;
      if (los && tdist <= atkRange) attack = true;
      // Одиночный скилл — только не в защите, по видимой цели в дальности.
      if (cast == null && !lowHp && los && tdist <= (wt === 'melee' ? 150 : 340)) {
        cast = this.readySkill(p, false);
      }
    } else if (drop && !lowHp) {
      facing = Math.atan2(drop.pos.y - p.pos.y, drop.pos.x - p.pos.x);
      if (dd > 24) move = this.navigate(world, p, drop.pos, `d${drop.id}`);
    }

    if (drop && dd <= 44) interact = true;

    return { move, facing, attack, cast, interact };
  }
}
