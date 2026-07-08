import { moveWithCollision, type Vec2 } from './movement.js';
import type { Grid } from './grid.js';

/**
 * Пост-проходное расталкивание сущностей (soft-body, headless): пересекающиеся круги
 * раздвигаются вдоль оси центров ОБРАТНО ПРОПОРЦИОНАЛЬНО массам — тяжёлого двигают меньше
 * («вес решает, кто кого толкает»). Единое правило для всех пар (монстр/монстр, игрок/монстр,
 * игрок/игрок). Каждый сдвиг применяется через `moveWithCollision` (vel=сдвиг, dt=1) — толчок
 * не загоняет в стену. `iterations` релаксаций разводят кластеры. Детерминировано (порядок пар
 * по индексу; совпавшие центры — фикс. ось). Мутирует `pos` тел.
 */
export interface CollisionBody {
  pos: Vec2;
  radius: number;
  mass: number;
}

export function resolveEntityCollisions(bodies: CollisionBody[], grid: Grid, iterations: number): void {
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        separatePair(bodies[i]!, bodies[j]!, grid);
      }
    }
  }
}

function separatePair(a: CollisionBody, b: CollisionBody, grid: Grid): void {
  let dx = b.pos.x - a.pos.x;
  let dy = b.pos.y - a.pos.y;
  const minDist = a.radius + b.radius;
  let dist = Math.hypot(dx, dy);
  if (dist >= minDist) return; // не пересекаются
  if (dist < 1e-6) { dx = 1; dy = 0; dist = 1; } // центры совпали — детерм. ось (без NaN)

  const overlap = minDist - dist;
  const nx = dx / dist;
  const ny = dy / dist;
  const total = a.mass + b.mass;
  // Доля сдвига обратно пропорц. массе: лёгкого двигаем больше, тяжёлого — меньше.
  const shareA = total > 0 ? b.mass / total : 0.5;
  const shareB = total > 0 ? a.mass / total : 0.5;
  push(a, -nx * overlap * shareA, -ny * overlap * shareA, grid);
  push(b, nx * overlap * shareB, ny * overlap * shareB, grid);
}

function push(body: CollisionBody, dx: number, dy: number, grid: Grid): void {
  if (dx === 0 && dy === 0) return;
  // Мутируем pos ВНУТРИ объекта (а не переприсваиваем): `pos` — это ссылка на Vec2 сущности,
  // так сдвиг доходит до самого игрока/монстра. moveWithCollision клампит о стены.
  const np = moveWithCollision(body.pos, { x: dx, y: dy }, body.radius, grid, 1);
  body.pos.x = np.x;
  body.pos.y = np.y;
}
