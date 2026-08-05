import { debuffMods } from '../world/debuffs.js';
import type { MonsterEntity } from '../world/state.js';
import type { Vec2 } from '../world/movement.js';
import type { MonsterBehavior } from './behavior.js';

/**
 * Чистый шаг ИИ монстра (headless). Мутирует восприятие/скорость/взгляд/КД и возвращает боевое
 * действие: 'attack' | 'shoot' | null. НЕ двигает монстра — только выставляет `m.vel` (движение с
 * коллизией/патфайндингом применяет сессия). LoS и профиль поведения (по фракции) передаёт сессия.
 * Профиль (`behavior`, session/behavior.ts) задаёт фракционные отличия:
 *  - `alertDelaySec` — задержка «заметил» перед первой атакой;
 *  - `fleeHpPct` — порог отхода (звери/демоны отступают; нежить/конструкты fearless = 0);
 *  - `keepDist*` / `repositionMode` — поведение стрелков (кайт + смена позиции между выстрелами).
 * Блок A: атака гейтится `losClear` — не бьём сквозь стену.
 */

const SCAN_SPEED = 0.8; // рад/с — вращение взгляда в покое
export const ALERT_TIME = 2.5; // длительность аггро от «шума» (атака игрока рядом)
const MELEE_REACH_GAP = 18; // мили-погоня: остановка/удар
const STATIONARY_REACH_GAP = 24; // стационарный: реакция/удар

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function perceive(m: MonsterEntity, target: Vec2, b: MonsterBehavior, losClear: boolean, noiseMult: number, dt: number): number {
  const dx = target.x - m.pos.x;
  const dy = target.y - m.pos.y;
  const dist = Math.hypot(dx, dy);
  const angleToPlayer = Math.atan2(dy, dx);
  const halfCone = ((m.def.visionAngle * Math.PI) / 180) / 2;
  const inCone = Math.abs(wrapAngle(angleToPlayer - m.facing)) <= halfCone;

  const seeing = dist <= m.def.vision && inCone && losClear;
  const hearing = dist <= m.def.hearing * noiseMult; // тяжёлая броня игрока — слышно дальше
  const wasChasing = m.aiState === 'chase';

  m.alertTimer = Math.max(0, m.alertTimer - dt);

  if (seeing || hearing || m.alertTimer > 0) {
    if (!wasChasing) m.noticeTimer = b.alertDelaySec; // только что заметил — задержка реакции
    m.aiState = 'chase';
    m.leash = b.leashTimeSec;
  } else if (m.aiState === 'chase') {
    m.leash -= dt;
    if (m.leash <= 0 || dist > b.leashRadius) m.aiState = 'idle';
  }
  return dist;
}

export function stepMonsterAi(
  m: MonsterEntity,
  target: Vec2,
  b: MonsterBehavior,
  losClear: boolean,
  noiseMult: number,
  dt: number,
): 'attack' | 'shoot' | null {
  if (!m.alive) return null;
  m.attackCd = Math.max(0, m.attackCd - dt);
  m.noticeTimer = Math.max(0, m.noticeTimer - dt);

  // Оглушён — стоит на месте, не действует (восприятие продолжается — не «слепнет»).
  if (m.stunTimer > 0) {
    m.stunTimer = Math.max(0, m.stunTimer - dt);
    m.vel.x = 0;
    m.vel.y = 0;
    perceive(m, target, b, losClear, noiseMult, dt);
    return null;
  }

  perceive(m, target, b, losClear, noiseMult, dt);

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
  const cos = Math.cos(angle), sin = Math.sin(angle);
  m.facing = angle; // в погоне смотрит на игрока
  const dm = debuffMods(m.debuffs); // рана замедляет, ошеломление — скор. атаки
  const speed = m.def.moveSpeed * dm.moveMult;
  const canAct = m.noticeTimer <= 0;                             // задержка «заметил» прошла
  const fleeing = b.fleeHpPct > 0 && m.hp < b.fleeHpPct * m.maxHp; // отход при низком HP

  switch (m.def.ai) {
    case 'stationary': {
      m.vel.x = 0;
      m.vel.y = 0;
      if (canAct && dist < m.radius + STATIONARY_REACH_GAP && m.attackCd <= 0 && losClear) {
        m.attackCd = 1 / (m.def.attackSpeed * dm.atkSpeedMult);
        return 'attack';
      }
      return null;
    }
    case 'ranged-kiter': {
      if (fleeing || dist < b.keepDistMin) { m.vel.x = -cos * speed; m.vel.y = -sin * speed; }
      else if (dist > b.keepDistMax) { m.vel.x = cos * speed; m.vel.y = sin * speed; }
      else if (b.repositionMode === 'strafe' && b.repositionAfterShot) {
        // держит дистанцию + смещается вбок между выстрелами (стрелок «меняет позицию»)
        const side = m.id % 2 === 0 ? 1 : -1;
        m.vel.x = Math.cos(angle + Math.PI / 2) * speed * side * 0.7;
        m.vel.y = Math.sin(angle + Math.PI / 2) * speed * side * 0.7;
      } else { m.vel.x = 0; m.vel.y = 0; }
      // LoS-гейт: не стрелять сквозь стену (блок A). Отступая, кастер всё ещё стреляет.
      if (canAct && losClear && dist <= b.keepDistMax + 40 && m.attackCd <= 0) {
        m.attackCd = 1 / (m.def.attackSpeed * dm.atkSpeedMult);
        return 'shoot';
      }
      return null;
    }
    case 'melee-chaser':
    default: {
      if (fleeing) { m.vel.x = -cos * speed; m.vel.y = -sin * speed; return null; } // отступает, не бьёт
      if (dist > m.radius + MELEE_REACH_GAP) {
        m.vel.x = cos * speed;
        m.vel.y = sin * speed;
      } else {
        m.vel.x = 0;
        m.vel.y = 0;
        if (canAct && m.attackCd <= 0 && losClear) {
          m.attackCd = 1 / (m.def.attackSpeed * dm.atkSpeedMult);
          return 'attack';
        }
      }
      return null;
    }
  }
}
