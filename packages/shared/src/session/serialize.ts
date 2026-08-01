import type { DamagePacket, DamageType } from '../types/combat.js';
import type { WorldState } from '../world/state.js';
import type { DecorObject } from '../dungeon/floorCommon.js';
import type { FloorInit, WorldSnapshot } from './netTypes.js';

/**
 * Чистая сериализация мира в сетевые кадры (без Phaser/DOM). Снапшот — только
 * изменяемые поля сущностей по id; геометрия области (`FloorInit`) — один раз при входе.
 */

const DTYPES: DamageType[] = ['physical', 'fire', 'cold', 'lightning', 'poison'];

/** Доминирующая стихия пакета урона (для цвета вида снаряда). */
export function dominantType(pk: DamagePacket): DamageType {
  let dom: DamageType = 'physical';
  let best = -Infinity;
  for (const t of DTYPES) if (pk[t] > best) { best = pk[t]; dom = t; }
  return dom;
}

/** Снапшот мира за тик: игроки/монстры/снаряды/дропы (по id, только рантайм-поля). */
export function serializeWorld(w: WorldState): WorldSnapshot {
  return {
    tick: w.tick,
    players: Object.values(w.players).map((p) => ({
      id: p.id, classId: p.save.classId,
      x: p.pos.x, y: p.pos.y, facing: p.facing,
      hp: p.hp, mana: p.mana, stamina: p.stamina, alive: p.alive,
      debuffs: p.debuffs, toggles: p.toggles, r: p.radius,
    })),
    monsters: w.monsters.map((m) => ({
      id: m.id, x: m.pos.x, y: m.pos.y, facing: m.facing,
      hp: m.hp, maxHp: m.maxHp, alive: m.alive,
      stun: m.stunTimer > 0, debuffs: m.debuffs, r: m.radius, aiState: m.aiState,
    })),
    projectiles: w.projectiles.map((pr) => ({
      id: pr.id, x: pr.pos.x, y: pr.pos.y, owner: pr.owner, dom: dominantType(pr.packet), r: pr.radius,
    })),
    drops: w.drops.map((d) => ({ id: d.id, x: d.pos.x, y: d.pos.y, item: d.item })),
  };
}

/** Геометрия текущей области для входящего игрока (грид/спавн/лестница/декор/монстры). */
export function floorInit(area: 'town' | 'dungeon', w: WorldState, decor: DecorObject[]): FloorInit {
  return {
    area,
    depth: w.depth,
    grid: w.grid,
    spawn: { ...w.spawn },
    stairs: w.stairs ? { ...w.stairs } : undefined,
    exits: w.exits ? w.exits.map((e) => ({ ...e })) : w.stairs ? [{ ...w.stairs }] : [],
    runNodeId: w.runNodeId,
    runNodeType: w.runNodeType,
    floorModifiers: w.floorModifiers,
    decor,
    monsters: w.monsters.map((m) => ({ id: m.id, def: m.def, x: m.pos.x, y: m.pos.y })),
    doors: w.doors.map((d) => ({ id: d.id, cells: d.cells.map((c) => ({ ...c })) })),
    levers: w.levers.filter((l) => !l.used).map((l) => ({ id: l.id, x: l.pos.x, y: l.pos.y, doorId: l.doorId })),
  };
}
