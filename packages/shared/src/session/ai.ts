import { debuffMods } from '../world/debuffs.js';
import type { MonsterEntity } from '../world/state.js';
import type { Vec2 } from '../world/movement.js';

/**
 * Чистый шаг ИИ монстра (headless-порт `client/.../monster.ts`). Мутирует
 * восприятие/скорость/взгляд/КД сущности и возвращает боевое действие для сессии:
 * 'attack' | 'shoot' | null. НЕ двигает монстра — только выставляет `m.vel`
 * (сессия применяет движение с коллизией). LoS считает сессия и передаёт сюда.
 */

const SCAN_SPEED = 0.8; // рад/с — вращение взгляда в покое
const LEASH_TIME = 3.5; // сколько секунд преследует после потери контакта
export const ALERT_TIME = 2.5; // длительность аггро от «шума» (атака игрока рядом)
const LEASH_RADIUS = 560; // дальше этого преследование обрывается

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function perceive(m: MonsterEntity, target: Vec2, losClear: boolean, noiseMult: number, dt: number): number {
  const dx = target.x - m.pos.x;
  const dy = target.y - m.pos.y;
  const dist = Math.hypot(dx, dy);
  const angleToPlayer = Math.atan2(dy, dx);
  const halfCone = ((m.def.visionAngle * Math.PI) / 180) / 2;
  const inCone = Math.abs(wrapAngle(angleToPlayer - m.facing)) <= halfCone;

  const seeing = dist <= m.def.vision && inCone && losClear;
  const hearing = dist <= m.def.hearing * noiseMult; // тяжёлая броня игрока — слышно дальше

  m.alertTimer = Math.max(0, m.alertTimer - dt);

  if (seeing || hearing || m.alertTimer > 0) {
    m.aiState = 'chase';
    m.leash = LEASH_TIME;
  } else if (m.aiState === 'chase') {
    m.leash -= dt;
    if (m.leash <= 0 || dist > LEASH_RADIUS) m.aiState = 'idle';
  }
  return dist;
}

export function stepMonsterAi(
  m: MonsterEntity,
  target: Vec2,
  losClear: boolean,
  noiseMult: number,
  dt: number,
): 'attack' | 'shoot' | null {
  if (!m.alive) return null;
  m.attackCd = Math.max(0, m.attackCd - dt);

  // Оглушён — стоит на месте, не действует (восприятие продолжается — не «слепнет»).
  if (m.stunTimer > 0) {
    m.stunTimer = Math.max(0, m.stunTimer - dt);
    m.vel.x = 0;
    m.vel.y = 0;
    perceive(m, target, losClear, noiseMult, dt);
    return null;
  }

  perceive(m, target, losClear, noiseMult, dt);

  if (m.aiState === 'idle') {
    m.vel.x = 0;
    m.vel.y = 0;
    m.facing = wrapAngle(m.facing + SCAN_SPEED * dt);
    return null;
  }

  // ── Погоня ──────────────────────────────────────────────
  const dx = target.x - m.pos.x;
  const dy = target.y - m.pos.y;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  m.facing = angle; // в погоне смотрит на игрока
  const dm = debuffMods(m.debuffs); // рана замедляет, ошеломление — скор. атаки

  switch (m.def.ai) {
    case 'stationary': {
      m.vel.x = 0;
      m.vel.y = 0;
      if (dist < 36 && m.attackCd <= 0) {
        m.attackCd = 1 / (m.def.attackSpeed * dm.atkSpeedMult);
        return 'attack';
      }
      return null;
    }
    case 'ranged-kiter': {
      const speed = m.def.moveSpeed * dm.moveMult;
      if (dist < 140) { m.vel.x = -Math.cos(angle) * speed; m.vel.y = -Math.sin(angle) * speed; }
      else if (dist > 220) { m.vel.x = Math.cos(angle) * speed; m.vel.y = Math.sin(angle) * speed; }
      else { m.vel.x = 0; m.vel.y = 0; }
      if (dist < 260 && m.attackCd <= 0) {
        m.attackCd = 1 / (m.def.attackSpeed * dm.atkSpeedMult);
        return 'shoot';
      }
      return null;
    }
    case 'melee-chaser':
    default: {
      const speed = m.def.moveSpeed * dm.moveMult;
      if (dist > 30) {
        m.vel.x = Math.cos(angle) * speed;
        m.vel.y = Math.sin(angle) * speed;
      } else {
        m.vel.x = 0;
        m.vel.y = 0;
        if (m.attackCd <= 0) {
          m.attackCd = 1 / (m.def.attackSpeed * dm.atkSpeedMult);
          return 'attack';
        }
      }
      return null;
    }
  }
}
