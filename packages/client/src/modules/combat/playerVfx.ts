import Phaser from 'phaser';
import type { ConfigRegistry } from '@dm/shared';
import type { GameState } from '../../core/gameState.js';
import type { Player } from '../movement/player.js';
import { elementColor, elementOf } from '../skills/skillIcon.js';

/** hex-строка ('#rrggbb') → число для Phaser. */
function hexNum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

const STEEL = 0xcdd3dc; // нейтральный цвет базовой атаки

/** Геометрия текущей ЛКМ-атаки для прицела/слэша. */
export interface AttackGeom { melee: boolean; range: number; arc: number; color: number; speed: number; }

/**
 * VFX вокруг СВОЕГО игрока (мировые координаты): пульсирующее кольцо активных аур, тусклый
 * конус-прицел дальности/размаха текущей мили-атаки (по оружию×скиллу — та же геометрия, что
 * бьёт сервер) и яркая дуга-слэш в момент удара. Клиент — чистый вид; логику боя не трогает.
 */
export class PlayerVfx {
  private scene: Phaser.Scene;
  private aura: Phaser.GameObjects.Graphics;
  private cone: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.aura = scene.add.graphics().setDepth(3); // под игроком/монстрами
    this.cone = scene.add.graphics().setDepth(3);
  }

  /** Геометрия ЛКМ-действия: базовая атака (оружие) или attack-скилл (оружие × мульты скилла). */
  currentAttack(state: GameState, cfg: ConfigRegistry): AttackGeom {
    const save = state.save;
    const weapon = save.equipment.weapon;
    const weaponMelee = (weapon?.weaponType ?? 'melee') === 'melee';
    const mel = cfg.get('balance').melee;
    let rangeMult = 1, arcMult = 1, color = STEEL, speed = 1, melee = weaponMelee;

    const lmb = save.mouseLeft;
    if (lmb && lmb !== 'attack') {
      const tree = cfg.get('skills-active').find((t) => t.classId === save.classId);
      const node = tree?.nodes.find((n) => n.id === lmb);
      const a = node?.effect.active;
      if (a && a.category === 'attack' && node) {
        rangeMult = a.rangeMult; arcMult = a.arcMult; speed = a.speed;
        color = hexNum(elementColor(elementOf(node)));
      } else {
        melee = false; // на ЛКМ каст/аура/бафф — мили-конуса нет
      }
    }
    return {
      melee,
      range: mel.baseRange * (weapon?.reachMult ?? 1) * rangeMult,
      arc: mel.baseArc * (weapon?.arcMult ?? 1) * arcMult,
      color,
      speed,
    };
  }

  /** Каждый кадр: конус-прицел (по ЛКМ-атаке) + пульс-кольца активных аур. */
  drawFrame(player: Player, state: GameState, cfg: ConfigRegistry, timeMs: number, attacking: boolean): void {
    const px = player.x, py = player.y;
    // ── Конус-прицел (тускло; ярче пока бьёшь) ──
    this.cone.clear();
    const g = this.currentAttack(state, cfg);
    if (g.melee) this.sector(this.cone, px, py, player.facing, g.range, g.arc, g.color, attacking ? 0.22 : 0.10);

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

  /** Яркая дуга-слэш в зоне удара — быстро гаснет (создаётся на удар, самоуничтожается). */
  flashSlash(px: number, py: number, facing: number, geom: AttackGeom): void {
    const s = this.scene.add.graphics().setDepth(7);
    this.sector(s, px, py, facing, geom.range, geom.arc, geom.color, 0.5);
    this.scene.tweens.add({ targets: s, alpha: 0, duration: 180, onComplete: () => s.destroy() });
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

  destroy(): void { this.aura.destroy(); this.cone.destroy(); }
}
