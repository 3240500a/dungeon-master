import type { WorldSnapshot } from '@dm/shared';

/**
 * Буфер снапшотов для интерполяции чужих сущностей. Сервер шлёт мир 30 Гц; чтобы пиры/монстры/
 * снаряды двигались плавно на 60 fps и не дёргались от сетевого джиттера, рисуем их с небольшой
 * ЗАДЕРЖКОЙ (`renderTime = now - INTERP_DELAY`) и лерпим позицию/поворот между двумя снапшотами,
 * окружающими `renderTime`. Свой игрок интерполяцией НЕ рисуется (он сглаживается к «сейчас» в
 * NetDriver — иначе своё движение ощущалось бы с лагом). Чистый вид, авторитет — на сервере.
 */

interface Stamped { t: number; snap: WorldSnapshot; }

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Интерполяция угла по кратчайшей дуге (через ±π). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // нормируем в (−π, π]
  return a + d * t;
}

export class SnapshotBuffer {
  private buf: Stamped[] = [];
  private readonly maxAgeMs = 1000; // держим ~1с истории (с запасом на джиттер)

  /** Добавить полученный снапшот с временем приёма (performance.now()). */
  push(snap: WorldSnapshot, t: number): void {
    this.buf.push({ t, snap });
    const cutoff = t - this.maxAgeMs;
    while (this.buf.length > 2 && this.buf[0]!.t < cutoff) this.buf.shift();
  }

  clear(): void { this.buf = []; }

  /**
   * Интерполированный снапшот на момент `renderTime` (ms в шкале performance.now()).
   * До/после диапазона — ближайший крайний снапшот (без экстраполяции). undefined — буфер пуст.
   */
  sample(renderTime: number): WorldSnapshot | undefined {
    const n = this.buf.length;
    if (n === 0) return undefined;
    if (n === 1) return this.buf[0]!.snap;
    if (renderTime <= this.buf[0]!.t) return this.buf[0]!.snap;
    if (renderTime >= this.buf[n - 1]!.t) return this.buf[n - 1]!.snap; // starved → новейший
    for (let i = 0; i < n - 1; i++) {
      const a = this.buf[i]!, b = this.buf[i + 1]!;
      if (a.t <= renderTime && renderTime < b.t) {
        const span = b.t - a.t;
        return lerpSnapshot(a.snap, b.snap, span > 0 ? (renderTime - a.t) / span : 0);
      }
    }
    return this.buf[n - 1]!.snap;
  }
}

/** Позиции/повороты лерпятся a→b; остальные поля (hp/alive/…) берутся из b (целевого). */
function lerpSnapshot(a: WorldSnapshot, b: WorldSnapshot, t: number): WorldSnapshot {
  const ap = new Map(a.players.map((p) => [p.id, p]));
  const am = new Map(a.monsters.map((m) => [m.id, m]));
  const aj = new Map(a.projectiles.map((p) => [p.id, p]));
  return {
    tick: b.tick,
    players: b.players.map((p) => {
      const s = ap.get(p.id);
      return s ? { ...p, x: lerp(s.x, p.x, t), y: lerp(s.y, p.y, t), facing: lerpAngle(s.facing, p.facing, t) } : p;
    }),
    monsters: b.monsters.map((m) => {
      const s = am.get(m.id);
      return s ? { ...m, x: lerp(s.x, m.x, t), y: lerp(s.y, m.y, t), facing: lerpAngle(s.facing, m.facing, t) } : m;
    }),
    projectiles: b.projectiles.map((pr) => {
      const s = aj.get(pr.id);
      return s ? { ...pr, x: lerp(s.x, pr.x, t), y: lerp(s.y, pr.y, t) } : pr;
    }),
    drops: b.drops, // статичны на земле — без интерполяции
  };
}
