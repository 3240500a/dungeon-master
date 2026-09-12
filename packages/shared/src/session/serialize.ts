import type { DamagePacket, DamageType } from '../types/combat.js';
import { dropPayload } from '../types/world.js';
import type { WorldState } from '../world/state.js';
import type { DecorObject } from '../dungeon/floorCommon.js';
import type { FloorInit, WorldSnapshot, PeerInfo } from './netTypes.js';
import type { PlayerEntity } from '../world/state.js';
import { weapon3dKeyFromEquipment } from './weapon3d.js';
import { posQ, posU, angQ, angU } from './wire.js';

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
/**
 * Ф1.4: КВАНТОВАНИЕ делается здесь, при сборке снапшота, а не в кодеке. Смысл в том, чтобы
 * сервер оперировал ровно теми значениями, которые переживут провод: иначе контрольная сумма
 * (Ф1.3) считалась бы по одним числам, а клиент восстанавливал бы другие, и сверка ловила бы
 * расхождения, которых нет. Побочный выигрыш: дрожь ниже четверти пикселя больше не порождает
 * патчей в дельте.
 */
const qp = (v: number): number => posU(posQ(v));
const qa = (a: number): number => angU(angQ(a));
/**
 * Пул (HP/мана/выносливость) на провод: целое и НЕ отрицательное.
 *
 * Зажим именно здесь, а не в кодеке: при добивании HP уходит в минус (перебор урона), кодек
 * пишет пулы беззнаковыми и зажимал бы их у себя — тогда сервер считал бы контрольную сумму
 * по −2, а клиент восстанавливал 0, и сверка (Ф1.3) ловила бы расхождение. Отрицательное HP —
 * внутренняя деталь боя, клиенту она не нужна ни для полоски, ни для чего-то ещё.
 */
const qpool = (v: number): number => Math.max(0, Math.round(v));

export function serializeWorld(w: WorldState): WorldSnapshot {
  return {
    tick: w.tick,
    players: Object.values(w.players).map((p) => ({
      id: p.id,
      x: qp(p.pos.x), y: qp(p.pos.y), facing: qa(p.facing),
      hp: qpool(p.hp), mana: qpool(p.mana), stamina: qpool(p.stamina), alive: p.alive,
      debuffs: p.debuffs, toggles: p.toggles,
      inCombat: p.combatTimer > 0, stun: p.stunTimer > 0,
    })),
    monsters: w.monsters.map((m) => ({
      id: m.id, x: qp(m.pos.x), y: qp(m.pos.y), facing: qa(m.facing),
      hp: qpool(m.hp), maxHp: qpool(m.maxHp), alive: m.alive,
      stun: m.stunTimer > 0, downed: m.downTimer > 0, debuffs: m.debuffs, r: m.radius, aiState: m.aiState,
    })),
    projectiles: w.projectiles.map((pr) => ({
      id: pr.id, x: qp(pr.pos.x), y: qp(pr.pos.y), owner: pr.owner, dom: dominantType(pr.packet), r: pr.radius,
    })),
    drops: w.drops.map((d) => ({ ...dropPayload(d), id: d.id, x: qp(d.pos.x), y: qp(d.pos.y) })),
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
    chests: w.chests.filter((c) => !c.opened).map((c) => ({ id: c.id, x: c.pos.x, y: c.pos.y, tier: c.tier })),
  };
}
