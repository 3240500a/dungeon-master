import type { DamagePacket, DamageType } from '../types/combat.js';
import type { WorldState } from '../world/state.js';
import type { DecorObject } from '../dungeon/floorCommon.js';
import type { FloorInit, WorldSnapshot, PeerInfo } from './netTypes.js';
import type { PlayerEntity } from '../world/state.js';
import { weapon3dKeyFromEquipment } from './weapon3d.js';

/**
 * Чистая сериализация мира в сетевые кадры (без Phaser/DOM). Снапшот — только
 * изменяемые поля сущностей по id; геометрия области (`FloorInit`) — один раз при входе.
 */

const DTYPES: DamageType[] = ['physical', 'fire', 'cold', 'lightning', 'poison'];

/** Мин. форма базы предмета для резолва 3D-модели (per-class). */
type ItemBaseLite = { id: string; modelId?: string; modelByClass?: Record<string, string> };
/** C7: slot→modelId надетой брони (helm/chest/gloves/boots) для КЛАССА носителя. Приоритет: per-class модель базы
 *  (modelByClass[класс]) → modelId инстанса → modelId базы. Только слоты с моделью; пусто → undefined (базы слотов). */
function armorModelsOf(eq: Record<string, { modelId?: string; baseId?: string } | undefined>, classId: string, itemsBase?: ItemBaseLite[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const slot of ['helm', 'chest', 'gloves', 'boots']) {
    const it = eq[slot]; if (!it) continue;
    const b = itemsBase?.find((x) => x.id === it.baseId);
    const id = b?.modelByClass?.[classId] ?? it.modelId ?? b?.modelId;
    if (id) out[slot] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

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
      id: p.id,
      x: p.pos.x, y: p.pos.y, facing: p.facing,
      hp: p.hp, mana: p.mana, stamina: p.stamina, alive: p.alive,
      debuffs: p.debuffs, toggles: p.toggles,
      inCombat: p.combatTimer > 0,
    })),
    monsters: w.monsters.map((m) => ({
      id: m.id, x: m.pos.x, y: m.pos.y, facing: m.facing,
      hp: m.hp, maxHp: m.maxHp, alive: m.alive,
      stun: m.stunTimer > 0, downed: m.downTimer > 0, debuffs: m.debuffs, r: m.radius, aiState: m.aiState,
    })),
    projectiles: w.projectiles.map((pr) => ({
      id: pr.id, x: pr.pos.x, y: pr.pos.y, owner: pr.owner, dom: dominantType(pr.packet), r: pr.radius,
    })),
    drops: w.drops.map((d) => ({ id: d.id, x: d.pos.x, y: d.pos.y, item: d.item })),
  };
}

/**
 * СТАТИКА игрока для кадра `peerInfo` (Ф1.1). Считается редко — на входе, экипировке, уровне
 * и смене области, — поэтому здесь не жалко линейного поиска по базам предметов, который
 * раньше делался на каждого игрока каждый тик.
 */
export function peerInfoOf(p: PlayerEntity, itemsBase?: ItemBaseLite[]): PeerInfo {
  return {
    id: p.id,
    classId: p.save.classId,
    name: p.save.name,
    maxHp: p.maxHp,
    r: p.radius,
    weaponKey: weapon3dKeyFromEquipment(p.save.equipment.weapon, p.save.equipment.offhand) ?? undefined,
    armorModels: armorModelsOf(p.save.equipment as Record<string, { modelId?: string; baseId?: string } | undefined>, p.save.classId, itemsBase),
  };
}

/** Геометрия текущей области для входящего игрока (грид/спавн/лестница/декор/монстры). */
export function floorInit(area: 'town' | 'dungeon', w: WorldState, decor: DecorObject[]): FloorInit {
  return {
    area,
    depth: w.depth,
    biomeId: w.biomeId,
    grid: w.grid,
    spawn: { ...w.spawn },
    stairs: w.stairs ? { ...w.stairs } : undefined,
    exits: w.exits ? w.exits.map((e) => ({ ...e })) : w.stairs ? [{ ...w.stairs }] : [],
    runNodeId: w.runNodeId,
    runNodeType: w.runNodeType,
    floorModifiers: w.floorModifiers,
    decor,
    doors: w.doors.map((d) => ({ id: d.id, cells: d.cells.map((c) => ({ ...c })) })),
    levers: w.levers.filter((l) => !l.used).map((l) => ({ id: l.id, x: l.pos.x, y: l.pos.y, doorId: l.doorId })),
  };
}
