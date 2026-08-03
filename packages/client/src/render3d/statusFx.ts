/**
 * Зацикленные партикл-эффекты статусов (дебаффов) на сущностях 3D-клиента: пока статус активен —
 * на монстре/игроке висит облачко партиклов (поджиг горит, яд пузырится, кровь капает, лёд/шок искрят).
 * Позиционируется по мировой позиции сущности каждый кадр (эффект в fxGroup, не парентится к мешу).
 */
import * as THREE from 'three';
import type { DebuffKind } from '@dm/shared';

function softTex(): THREE.Texture {
  const S = 32, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S); return new THREE.CanvasTexture(c);
}
const TEX = /* @__PURE__ */ softTex();

/** Параметры эмиттера по виду статуса. `grav` — ускорение вниз (px/с²); dir — направление старт-скорости. */
interface FxParams { color: number; n: number; dir: 'up' | 'down' | 'rand'; speed: number; y0: number; y1: number; size: number; life: number; grav: number; spread: number }
const FX: Record<DebuffKind, FxParams> = {
  burn:   { color: 0xff6a20, n: 22, dir: 'up',   speed: 26, y0: 4,  y1: 30, size: 10, life: 0.55, grav: -34, spread: 14 },
  poison: { color: 0x6cd028, n: 16, dir: 'up',   speed: 16, y0: 4,  y1: 36, size: 9,  life: 0.9,  grav: -10, spread: 14 },
  bleed:  { color: 0xd21f1f, n: 12, dir: 'down', speed: 8,  y0: 24, y1: 42, size: 7,  life: 0.5,  grav: 220, spread: 12 },
  freeze: { color: 0x86ccff, n: 14, dir: 'rand', speed: 10, y0: 6,  y1: 42, size: 9,  life: 1.2,  grav: 0,   spread: 15 },
  shock:  { color: 0xffe23a, n: 14, dir: 'rand', speed: 62, y0: 8,  y1: 42, size: 7,  life: 0.18, grav: 0,   spread: 16 },
  wound:  { color: 0xd06666, n: 6,  dir: 'up',   speed: 8,  y0: 8,  y1: 26, size: 6,  life: 0.6,  grav: 0,   spread: 12 },
  sunder: { color: 0xcaa878, n: 6,  dir: 'up',   speed: 8,  y0: 8,  y1: 26, size: 6,  life: 0.6,  grav: 0,   spread: 12 },
  daze:   { color: 0xffe27a, n: 6,  dir: 'rand', speed: 16, y0: 44, y1: 54, size: 7,  life: 0.5,  grav: 0,   spread: 10 },
};

interface Emitter { obj: THREE.Points; update: (dt: number) => void; dispose: () => void }

function makeEmitter(k: DebuffKind): Emitter {
  const p = FX[k];
  const pos = new Float32Array(p.n * 3), vel = new Float32Array(p.n * 3), age = new Float32Array(p.n), max = new Float32Array(p.n);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ map: TEX, color: p.color, size: p.size, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.92 });
  const pts = new THREE.Points(geo, mat);
  const respawn = (i: number): void => {
    const b = i * 3;
    pos[b] = (Math.random() - 0.5) * p.spread; pos[b + 2] = (Math.random() - 0.5) * p.spread;
    pos[b + 1] = p.y0 + Math.random() * (p.y1 - p.y0);
    const a = Math.random() * 6.283, s = p.speed * (0.5 + Math.random());
    if (p.dir === 'up') { vel[b] = Math.cos(a) * s * 0.3; vel[b + 1] = s; vel[b + 2] = Math.sin(a) * s * 0.3; }
    else if (p.dir === 'down') { vel[b] = Math.cos(a) * s * 0.2; vel[b + 1] = -s * 0.4; vel[b + 2] = Math.sin(a) * s * 0.2; }
    else { vel[b] = Math.cos(a) * s; vel[b + 1] = (Math.random() - 0.5) * s; vel[b + 2] = Math.sin(a) * s; }
    age[i] = 0; max[i] = p.life * (0.6 + Math.random() * 0.8);
  };
  for (let i = 0; i < p.n; i++) { respawn(i); age[i] = Math.random() * max[i]!; }   // рассинхрон старта
  return {
    obj: pts,
    update(dt: number): void {
      for (let i = 0; i < p.n; i++) {
        age[i] = (age[i] ?? 0) + dt;
        if (age[i]! >= max[i]!) { respawn(i); continue; }
        const b = i * 3;
        vel[b + 1] = (vel[b + 1] ?? 0) - p.grav * dt;
        pos[b] = (pos[b] ?? 0) + (vel[b] ?? 0) * dt;
        pos[b + 1] = (pos[b + 1] ?? 0) + (vel[b + 1] ?? 0) * dt;
        pos[b + 2] = (pos[b + 2] ?? 0) + (vel[b + 2] ?? 0) * dt;
      }
      geo.attributes.position!.needsUpdate = true;
    },
    dispose(): void { geo.dispose(); mat.dispose(); },
  };
}

/** Менеджер эффектов статусов: по id сущности держит эмиттеры активных дебаффов, позиционирует и анимирует. */
export class StatusFx {
  private ents = new Map<string, Map<DebuffKind, Emitter>>();
  private disabled = false;   // debug-тумблер: не спавнить партикл-статусы (по эмиттеру на дебафф на сущность)
  constructor(private root: THREE.Object3D) {}

  /** Debug: отключить партикл-статусы (много эмиттеров при массовых дебаффах). */
  setDisabled(on: boolean): void { this.disabled = on; if (on) this.clear(); }

  /** Синхронизировать эффекты сущности `id` в мировой (x,z) с её набором дебаффов (снапшот-состояние). */
  sync(id: string, x: number, z: number, debuffs: Partial<Record<DebuffKind, { stacks: number }>>): void {
    if (this.disabled) return;
    const active = (Object.keys(debuffs) as DebuffKind[]).filter((k) => debuffs[k]);
    let m = this.ents.get(id);
    if (!active.length) { if (m) this.remove(id); return; }
    if (!m) { m = new Map(); this.ents.set(id, m); }
    for (const k of active) {
      let e = m.get(k);
      if (!e) { e = makeEmitter(k); this.root.add(e.obj); m.set(k, e); }
      e.obj.position.set(x, 0, z);
    }
    for (const [k, e] of m) if (!debuffs[k]) { this.root.remove(e.obj); e.dispose(); m.delete(k); }
  }

  update(dt: number): void { for (const m of this.ents.values()) for (const e of m.values()) e.update(dt); }

  remove(id: string): void {
    const m = this.ents.get(id); if (!m) return;
    for (const e of m.values()) { this.root.remove(e.obj); e.dispose(); }
    this.ents.delete(id);
  }

  clear(): void { for (const id of [...this.ents.keys()]) this.remove(id); }
}
