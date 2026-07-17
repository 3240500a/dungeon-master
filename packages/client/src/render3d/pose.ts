/**
 * GHOST-РИГ: процедурный генератор ЦЕЛЕВОЙ позы (углы суставов). Единый источник для обоих ригов:
 * - кинематический (`actor.ts`) — ставит углы напрямую (дешёвый LOD);
 * - физический (`ragdoll.ts`) — скармливает углы моторам суставов (active-ragdoll).
 * Все углы — маховые, вокруг локальной оси X кости (как и шарниры рига).
 * Знаки: колено гнётся НАЗАД (+), локоть — ВПЕРЁД (в риге применяется с минусом).
 */

export interface PoseTargets {
  hipL: number; hipR: number; knL: number; knR: number;
  shL: number; shR: number; elL: number; elR: number;
  lean: number; twist: number; bobY: number; splay: number;
}

const ATTACK_DUR = 0.42;

/** Взмах правой: замах назад → удар вперёд → возврат. */
function attackCurve(p: number): number {
  if (p < 0.28) return (p / 0.28) * -1.1;
  if (p < 0.62) return -1.1 + ((p - 0.28) / 0.34) * 2.8;
  return 1.7 - ((p - 0.62) / 0.38) * 1.55;
}

export class PoseDriver {
  private phase = Math.random() * 6.283;
  private move = 0;
  private attackT = 0;
  private attackPow = 1;
  private dead = false;
  readonly out: PoseTargets = { hipL: 0, hipR: 0, knL: 0, knR: 0, shL: 0, shR: 0, elL: 0, elR: 0, lean: 0, twist: 0, bobY: 0, splay: 0 };

  setMove(s: number): void { this.move = Math.max(0, Math.min(1.4, s)); }
  attack(power = 1): void { if (!this.dead) { this.attackT = ATTACK_DUR; this.attackPow = power; } }
  setDead(d: boolean): void { this.dead = d; }
  get isDead(): boolean { return this.dead; }
  /** Идёт ли взмах (для триггера VFX/звука). */
  get attacking(): boolean { return this.attackT > 0; }

  update(dt: number): PoseTargets {
    const o = this.out;
    if (this.dead) {
      o.splay = 1; o.bobY = -26; o.lean = 1.4; o.twist = 0;
      o.hipL = 0.7; o.hipR = -0.7; o.knL = 1.2; o.knR = 1.2; o.shL = 0.7; o.shR = -0.7; o.elL = 1.2; o.elR = 1.2;
      return o;
    }
    const walking = this.move > 0.05;
    this.phase += (walking ? 2.2 + this.move * 3.2 : 1.3) * dt;
    const s = Math.sin(this.phase), s2 = Math.sin(this.phase * 2);
    const amp = walking ? 0.45 + this.move * 0.4 : 0;

    o.hipL = s * amp; o.hipR = -s * amp;
    o.knL = Math.max(0, -s) * amp * 1.3 + (walking ? 0.12 : 0);
    o.knR = Math.max(0, s) * amp * 1.3 + (walking ? 0.12 : 0);
    o.bobY = walking ? Math.abs(s2) * 2.0 : Math.sin(this.phase) * 0.7;
    o.lean = walking ? 0.05 + this.move * 0.06 : 0.02;
    o.splay = 0;

    if (this.attackT <= 0) {
      o.shL = -s * amp * 0.85; o.shR = s * amp * 0.85;
      o.elL = 0.35 + amp * 0.2; o.elR = 0.35 + amp * 0.2;
      o.twist = s * amp * 0.15;
    } else {
      this.attackT -= dt;
      const p = 1 - this.attackT / ATTACK_DUR, sw = attackCurve(p) * this.attackPow;
      o.shR = sw; o.elR = 0.5 + Math.max(0, sw) * 0.7;
      o.shL = -sw * 0.3; o.elL = 0.35;
      o.twist = sw * 0.28; o.lean = 0.1 + Math.max(0, sw) * 0.1;
    }
    return o;
  }
}
