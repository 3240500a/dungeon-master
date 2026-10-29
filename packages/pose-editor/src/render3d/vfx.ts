/**
 * Лёгкая система VFX для 3D-клиента: партикл-вспышки (удары/магия/смерть), кольца-новы,
 * дуга-взмах, всплывающие числа урона (спрайты). Мир (x,y) → 3D (x, h, z=y).
 */
import * as THREE from 'three';

function softSprite(inner: string, outer: string): THREE.Texture {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, inner); grad.addColorStop(0.45, outer); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
const SPARK = softSprite('rgba(255,255,255,1)', 'rgba(255,210,150,0.6)');

interface Fx { obj: THREE.Object3D; upd: (dt: number) => boolean }
// Плавающий боевой текст из ПУЛА (число урона/промах/блок): спрайт+канвас+текстура переиспользуются (перерисовка
// + needsUpdate вместо new CanvasTexture на каждое число) → ноль аллокаций/GC и создания GL-текстур в бою.
interface Floater { spr: THREE.Sprite; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mat: THREE.SpriteMaterial; t: number; life: number; y0: number; active: boolean }
const MAX_FLOATERS = 28;

export class Vfx {
  private list: Fx[] = [];
  private floaters: Floater[] = [];
  private floatersOff = false;   // debug-тумблер: не показывать плавающий боевой текст (числа/промах/блок)
  constructor(private root: THREE.Object3D) {}

  /** Debug: отключить плавающие числа урона (текстур-аплоады в бою). */
  setFloatersOff(off: boolean): void { this.floatersOff = off; }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.list[i]!.upd(dt)) {
        const o = this.list[i]!.obj; this.root.remove(o);
        o.traverse((x) => { const m = x as THREE.Mesh; m.geometry?.dispose?.(); });
        this.list.splice(i, 1);
      }
    }
    for (const f of this.floaters) {   // плавающие числа — из пула (двигаем/гасим, не пересоздаём)
      if (!f.active) continue;
      f.t += dt; const k = f.t / f.life;
      if (k >= 1) { f.active = false; f.spr.visible = false; continue; }
      f.spr.position.y = f.y0 + k * 40; f.mat.opacity = 1 - k * k;
    }
  }

  /** Взять свободный флоатер из пула (или создать до лимита, иначе переиспользовать самый старый). */
  private acquireFloater(): Floater {
    let f = this.floaters.find((q) => !q.active);
    if (f) return f;
    if (this.floaters.length < MAX_FLOATERS) {
      const canvas = document.createElement('canvas'); canvas.width = 224; canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
      const spr = new THREE.Sprite(mat); spr.visible = false; this.root.add(spr);
      f = { spr, canvas, ctx, tex, mat, t: 0, life: 0, y0: 46, active: false };
      this.floaters.push(f);
      return f;
    }
    return this.floaters.reduce((a, b) => (b.t / b.life > a.t / a.life ? b : a));   // все заняты — самый старый
  }
  private add(obj: THREE.Object3D, upd: (dt: number) => boolean): void { this.root.add(obj); this.list.push({ obj, upd }); }

  /** Партикл-вспышка: N спрайтов разлетаются, поднимаются, гаснут. */
  burst(x: number, z: number, color: number, n = 14, speed = 90, life = 0.5, size = 10, y = 20): void {
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, up = 0.3 + Math.random() * 0.9, sp = speed * (0.5 + Math.random());
      vel[i * 3] = Math.cos(a) * sp; vel[i * 3 + 1] = up * sp; vel[i * 3 + 2] = Math.sin(a) * sp;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ map: SPARK, color, size, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat); pts.position.set(x, y, z);
    let t = 0;
    this.add(pts, (dt) => {
      t += dt; const k = t / life; if (k >= 1) return false;
      for (let i = 0; i < n; i++) {
        const b = i * 3;
        vel[b + 1] = (vel[b + 1] ?? 0) - 260 * dt;
        pos[b] = (pos[b] ?? 0) + (vel[b] ?? 0) * dt;
        pos[b + 1] = (pos[b + 1] ?? 0) + (vel[b + 1] ?? 0) * dt;
        pos[b + 2] = (pos[b + 2] ?? 0) + (vel[b + 2] ?? 0) * dt;
      }
      geo.attributes.position!.needsUpdate = true; mat.opacity = 1 - k; mat.size = size * (1 - k * 0.4);
      return true;
    });
  }

  /** Кольцо-нова на земле: расширяется и гаснет (для каста/новы/смерти). */
  ring(x: number, z: number, color: number, rMax = 90, life = 0.5, y = 3): void {
    const geo = new THREE.RingGeometry(1, 6, 32);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
    let t = 0;
    this.add(m, (dt) => { t += dt; const k = t / life; if (k >= 1) return false; m.scale.setScalar(1 + (rMax / 6) * k); mat.opacity = 0.9 * (1 - k); return true; });
  }

  /** Дуга-взмах перед персонажем (быстрая вспышка в направлении facing). */
  slash(x: number, z: number, facing: number, color: number, reach = 40): void {
    const geo = new THREE.RingGeometry(reach * 0.5, reach, 16, 1, -0.9, 1.8);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.rotation.z = -facing; m.position.set(x, 14, z);
    let t = 0; const life = 0.2;
    this.add(m, (dt) => { t += dt; const k = t / life; if (k >= 1) return false; mat.opacity = 0.85 * (1 - k); m.scale.setScalar(1 + k * 0.3); return true; });
  }

  /** Восходящие магические партиклы (каст). */
  cast(x: number, z: number, color: number): void { this.burst(x, z, color, 18, 60, 0.6, 9, 8); this.ring(x, z, color, 70, 0.45); }

  /** Всплывающий боевой текст (спрайт из ПУЛА), поднимается и гаснет. big — крупнее (крит). Канвас фикс. 224×64, текст по центру. */
  floatText(x: number, z: number, text: string, color: number, big = false): void {
    if (this.floatersOff) return;
    const f = this.acquireFloater();
    const fs = big ? 46 : 34, font = `bold ${fs}px system-ui, sans-serif`;
    const g = f.ctx, W = f.canvas.width, H = f.canvas.height;
    g.clearRect(0, 0, W, H);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(text, W / 2, H / 2);
    g.fillStyle = `#${color.toString(16).padStart(6, '0')}`; g.fillText(text, W / 2, H / 2);
    f.tex.needsUpdate = true;   // перезалить в ту же GL-текстуру (без создания новой)
    const s = fs / 128; f.spr.scale.set(W * s, H * s, 1);
    f.y0 = 46; f.spr.position.set(x + (Math.random() - 0.5) * 10, f.y0, z);
    f.mat.opacity = 1; f.t = 0; f.life = 0.9; f.active = true; f.spr.visible = true;
  }

  /** Всплывающее число урона. Crit — крупнее/жёлтое. */
  damage(x: number, z: number, amount: number, color: number, crit = false): void {
    this.floatText(x, z, String(amount), crit ? 0xffd24a : color, crit);
  }
}
