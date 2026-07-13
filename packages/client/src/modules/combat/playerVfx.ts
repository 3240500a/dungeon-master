import Phaser from 'phaser';
import { swingHalfWidth, type ConfigRegistry } from '@dm/shared';
import type { GameState } from '../../core/gameState.js';
import type { Player } from '../movement/player.js';
import { elementColor, elementOf } from '../skills/skillIcon.js';

/** hex-строка ('#rrggbb') → число для Phaser. */
function hexNum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

const STEEL = 0xcdd3dc; // нейтральный цвет базовой атаки
const FLASH_MS = 120; // длительность яркой вспышки после замаха

/** Геометрия действия для вспышки удара. `dash` → рисуем полосу вместо сектора. */
export interface AttackGeom { melee: boolean; range: number; arc: number; color: number; speed: number; dash?: { length: number; halfWidth: number }; }

/**
 * VFX вокруг СВОЕГО игрока (мировые координаты): пульсирующее кольцо активных аур и вспышка формы
 * удара В МОМЕНТ удара (по оружию×скиллу — та же геометрия, что бьёт сервер): сектор для обычного
 * удара/атаки-скилла, полоса — для рывка. Клиент — чистый вид; логику боя не трогает.
 */
export class PlayerVfx {
  private scene: Phaser.Scene;
  private aura: Phaser.GameObjects.Graphics;
  private telegraph: Phaser.GameObjects.Graphics;
  /** Активные свинги: форма «наливается» за windup, затем короткий флеш. Позиция/поворот — live (игрока). */
  private swings: { geom: AttackGeom; start: number; windupMs: number }[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.aura = scene.add.graphics().setDepth(3); // под игроком/монстрами
    this.telegraph = scene.add.graphics().setDepth(7); // форма удара — поверх
  }

  /** Запустить свинг по событию сервера: форма заряжается `windupMs`, затем короткая яркая вспышка. */
  startSwing(geom: AttackGeom, windupMs: number): void {
    if (!geom.melee && !geom.dash) return; // дальнобой/каст-нова — свои визуалы (снаряды/AoE)
    this.swings.push({ geom, start: this.scene.time.now, windupMs: Math.max(0, windupMs) });
  }

  /**
   * Геометрия действия `action` (id скилла или 'attack'/undefined = базовая атака оружием):
   * дальность/размах по оружию×мультам скилла (та же, что бьёт сервер), цвет по стихии; для
   * рывка — длина коридора и его полу-ширина (== размаху удара, вариант B на сервере).
   */
  currentAttack(state: GameState, cfg: ConfigRegistry, action?: string): AttackGeom {
    const save = state.save;
    const weapon = save.equipment.weapon;
    const weaponMelee = (weapon?.weaponType ?? 'melee') === 'melee';
    const mel = cfg.get('balance').melee;
    let rangeMult = 1, arcMult = 1, color = STEEL, speed = 1, melee = weaponMelee, dashLen = 0;

    if (action && action !== 'attack') {
      const tree = cfg.get('skills-active').find((t) => t.classId === save.classId);
      const node = tree?.nodes.find((n) => n.id === action);
      const a = node?.effect.active;
      if (a && a.category === 'attack' && node) {
        rangeMult = a.rangeMult; arcMult = a.arcMult; speed = a.speed;
        color = hexNum(elementColor(elementOf(node)));
        if (a.dash) dashLen = 130 * a.rangeMult; // == серверный dist в doDashAttack
      } else {
        melee = false; // каст/аура/бафф — свои визуалы (снаряды/нова), сектора нет
      }
    }
    const range = mel.baseRange * (weapon?.reachMult ?? 1) * rangeMult;
    const arc = mel.baseArc * (weapon?.arcMult ?? 1) * arcMult;
    return { melee, range, arc, color, speed, dash: dashLen > 0 ? { length: dashLen, halfWidth: swingHalfWidth(range, arc) } : undefined };
  }

  /** Каждый кадр: форма удара (зарядка за замах → флеш) + пульс-кольца активных аур. */
  drawFrame(player: Player, state: GameState, cfg: ConfigRegistry, timeMs: number): void {
    const px = player.x, py = player.y;
    // ── Форма удара: «наливается» за замах, затем короткая яркая вспышка (позиция/поворот — live) ──
    this.telegraph.clear();
    for (let k = this.swings.length - 1; k >= 0; k--) {
      const sw = this.swings[k]!;
      const t = timeMs - sw.start;
      if (t >= sw.windupMs + FLASH_MS) { this.swings.splice(k, 1); continue; }
      const charging = t < sw.windupMs;
      const p = sw.windupMs > 0 ? t / sw.windupMs : 1;
      const alpha = charging ? 0.08 + 0.24 * p : 0.5 * (1 - (t - sw.windupMs) / FLASH_MS);
      const scale = charging ? 0.6 + 0.4 * p : 1; // растёт до полного размера к моменту удара
      const g = sw.geom;
      if (g.dash) this.strip(this.telegraph, px, py, player.facing, g.dash.length * scale, g.dash.halfWidth, g.color, alpha);
      else this.sector(this.telegraph, px, py, player.facing, g.range * scale, g.arc, g.color, alpha);
    }

    // ── Кольца активных аур ──
    this.aura.clear();
    const tree = cfg.get('skills-active').find((t) => t.classId === state.save.classId);
    let i = 0;
    for (const id of state.toggles) {
      const node = tree?.nodes.find((n) => n.id === id);
      const a = node?.effect.active;
      if (!a || a.category !== 'aura' || !node) continue;
      const baseR = (a.radius && a.radius > 0 ? a.radius : 42) + i * 8;
      const pulse = 1 + 0.08 * Math.sin(timeMs / 320 + i);
      const col = hexNum(elementColor(elementOf(node)));
      this.aura.fillStyle(col, 0.10 + 0.05 * Math.sin(timeMs / 320 + i));
      this.aura.fillCircle(px, py, baseR * pulse);
      this.aura.lineStyle(2, col, 0.4);
      this.aura.strokeCircle(px, py, baseR * pulse);
      i++;
    }
  }

  /** Заливка полосы-коридора рывка: от (x,y) вперёд по facing на length, полу-ширина halfW. */
  private strip(g: Phaser.GameObjects.Graphics, x: number, y: number, facing: number, length: number, halfW: number, color: number, alpha: number): void {
    const cx = Math.cos(facing), cy = Math.sin(facing);
    const nx = -cy, ny = cx; // перпендикуляр
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x + nx * halfW, y + ny * halfW);
    g.lineTo(x - nx * halfW, y - ny * halfW);
    g.lineTo(x - nx * halfW + cx * length, y - ny * halfW + cy * length);
    g.lineTo(x + nx * halfW + cx * length, y + ny * halfW + cy * length);
    g.closePath();
    g.fillPath();
    g.lineStyle(2, color, Math.min(1, alpha * 2.4));
    g.strokePath();
  }

  /** Заливка сектора (пирог) с обводкой: центр в (x,y), радиус range, полу-угол arc, по facing. */
  private sector(g: Phaser.GameObjects.Graphics, x: number, y: number, facing: number, range: number, arc: number, color: number, alpha: number): void {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, range, facing - arc, facing + arc, false);
    g.closePath();
    g.fillPath();
    g.lineStyle(2, color, Math.min(1, alpha * 2.4));
    g.strokePath();
  }

  destroy(): void { this.aura.destroy(); this.telegraph.destroy(); }
}
