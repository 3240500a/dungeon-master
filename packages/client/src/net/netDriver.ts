import Phaser from 'phaser';
import type { App } from '../core/app.js';
import type { Player } from '../modules/movement/player.js';
import { Monster } from '../modules/combat/monster.js';
import { Projectile } from '../modules/combat/projectile.js';
import { DroppedItem } from '../modules/loot/droppedItem.js';
import { dmgColorNum } from '../core/damageTypes.js';
import { monsterCombatStats } from '@dm/shared';
import type { DamagePacket, DamageType, FloorInit, SaveState, SessionEvent, WorldSnapshot } from '@dm/shared';

/** Текст лога по типу квестового события с сервера. */
function questText(kind: 'accepted' | 'progress' | 'completed' | 'turned-in', name: string): string {
  if (kind === 'accepted') return `Квест принят: ${name}`;
  if (kind === 'completed') return `Квест выполнен: ${name}`;
  if (kind === 'turned-in') return `Квест сдан: ${name}`;
  return `Квест: ${name}`;
}

/** Рисует «нос»-указатель взгляда (общий для пиров и мобов). */
function drawNose(g: Phaser.GameObjects.Graphics, x: number, y: number, facing: number, color: number): void {
  const nx = x + Math.cos(facing) * 18;
  const ny = y + Math.sin(facing) * 18;
  g.clear();
  g.lineStyle(3, color, 0.9);
  g.lineBetween(x, y, nx, ny);
  g.fillStyle(color, 0.9);
  g.fillCircle(nx, ny, 3);
}

/**
 * Клиентский драйвер ОНЛАЙН-мира: кормит сервер вводом (WASD/мышь/скиллы) и РИСУЕТ
 * мир из авторитетных снапшотов (свой игрок + пиры + монстры + снаряды + дропы). Бой/
 * движение/награды считает сервер; клиент — чистый вью. Заменяет локальный
 * `SessionController` в онлайн-сценах.
 */
export class NetDriver {
  private scene: Phaser.Scene;
  private app: App;
  private player: Player;
  private myId = '';
  private monsters = new Map<number, Monster>();
  private projs = new Map<number, Projectile>();
  private remotes = new Map<string, { sprite: Phaser.GameObjects.Image; nose: Phaser.GameObjects.Graphics }>();
  private drops = new Map<number, DroppedItem>();
  private keys: Record<'w' | 'a' | 's' | 'd' | 'shift' | 'space' | 'alt' | 'e', Phaser.Input.Keyboard.Key>;
  private leftHeld = false;
  private rightHeld = false;
  private seq = 0;
  private latest?: WorldSnapshot;

  constructor(scene: Phaser.Scene, app: App, player: Player) {
    this.scene = scene;
    this.app = app;
    this.player = player;
    const kb = scene.input.keyboard!;
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      w: kb.addKey(K.W), a: kb.addKey(K.A), s: kb.addKey(K.S), d: kb.addKey(K.D),
      shift: kb.addKey(K.SHIFT), space: kb.addKey(K.SPACE), alt: kb.addKey(K.ALT), e: kb.addKey(K.E),
    };
    kb.addCapture(['SPACE', 'SHIFT', 'ALT']);
    scene.input.mouse?.disableContextMenu();
    scene.input.on('pointerdown', this.onDown);
    scene.input.on('pointerup', this.onUp);

    app.net.on('snapshot', (f) => { this.latest = f.snap; });
    app.net.on('events', (f) => this.onEvents(f.events));
    app.net.on('saveUpdate', (f) => this.applySave(f.save));
    app.net.on('peerLeft', (f) => { const r = this.remotes.get(f.id); r?.sprite.destroy(); r?.nose.destroy(); this.remotes.delete(f.id); });
  }

  setMyId(id: string): void { this.myId = id; }

  /** Пересоздаёт монстров текущей области по FloorInit (id→def). Вызывать при входе/смене этажа. */
  buildMonsters(floor: FloorInit): void {
    for (const m of this.monsters.values()) m.destroy();
    this.monsters.clear();
    for (const m of floor.monsters) this.monsters.set(m.id, new Monster(this.scene, m.x, m.y, m.def));
  }

  private onDown = (p: Phaser.Input.Pointer): void => {
    // Клик по предмету на земле — не атака, а ТОЧЕЧНАЯ команда подбора (надёжно, без гонки ввода).
    const drop = this.scene.input.hitTestPointer(p).find((o) => o.getData?.('drop') === true);
    if (drop) { this.app.sendCmd({ cmd: 'pickup', dropId: drop.getData('dropId') as number }); return; }
    if (p.leftButtonDown()) this.leftHeld = true;
    if (p.rightButtonDown()) this.rightHeld = true;
  };
  private onUp = (p: Phaser.Input.Pointer): void => {
    this.leftHeld = p.leftButtonDown();
    this.rightHeld = p.rightButtonDown();
  };

  /** Каждый кадр: шлём ввод и применяем последний снапшот. */
  update(): void {
    const save = this.app.state!.save;
    let attack = false;
    let cast: string | null = null;
    const consider = (b: string | null | undefined, held: boolean): void => {
      if (!held || !b) return;
      if (b === 'attack') attack = true; else if (cast == null) cast = b;
    };
    consider(save.mouseLeft, this.leftHeld);
    consider(save.mouseRight, this.rightHeld);
    consider(save.hotbar[0], this.keys.shift.isDown);
    consider(save.hotbar[1], this.keys.space.isDown);
    consider(save.hotbar[2], this.keys.alt.isDown);

    const move = {
      x: (this.keys.d.isDown ? 1 : 0) - (this.keys.a.isDown ? 1 : 0),
      y: (this.keys.s.isDown ? 1 : 0) - (this.keys.w.isDown ? 1 : 0),
    };
    // Клавиша E — подбор ближайшего дропа (удержание надёжно: сервер сэмплит каждый тик). Клик по предмету — точечно (onDown).
    this.app.net.send({ t: 'input', seq: this.seq++, input: { move, facing: this.player.facing, attack, cast, interact: this.keys.e.isDown } });

    if (this.latest) this.render(this.latest);
  }

  private render(snap: WorldSnapshot): void {
    const state = this.app.state!;
    // Свой игрок (авторитетная позиция/HP/мана/дебаффы) + пиры.
    for (const pv of snap.players) {
      if (pv.id === this.myId) {
        this.player.setPos(pv.x, pv.y);
        state.hp = pv.hp; state.mana = pv.mana; state.debuffs = pv.debuffs; state.toggles = pv.toggles;
        continue;
      }
      let r = this.remotes.get(pv.id);
      if (!r) {
        const tex = this.scene.textures.exists(`player-${pv.classId}`) ? `player-${pv.classId}` : 'player-warrior';
        r = { sprite: this.scene.add.image(pv.x, pv.y, tex).setDepth(5), nose: this.scene.add.graphics().setDepth(6) };
        this.remotes.set(pv.id, r);
      }
      r.sprite.setPosition(pv.x, pv.y).setAlpha(pv.alive ? 1 : 0.3);
      drawNose(r.nose, pv.x, pv.y, pv.facing, 0x9fd0ff); // видно, куда смотрит пир
    }
    // Монстры.
    const seenM = new Set<number>();
    for (const mv of snap.monsters) {
      seenM.add(mv.id);
      const v = this.monsters.get(mv.id);
      if (!v) continue;
      if (mv.alive) { v.syncView(mv); v.drawStatus(); }
      else { v.destroy(); this.monsters.delete(mv.id); }
    }
    // Снаряды.
    const seenP = new Set<number>();
    for (const pr of snap.projectiles) {
      seenP.add(pr.id);
      let v = this.projs.get(pr.id);
      if (!v) {
        const tint = pr.owner === 'monster' ? 0xff8080 : pr.dom === 'physical' ? 0xffe680 : dmgColorNum(pr.dom);
        v = new Projectile(this.scene, pr.x, pr.y, 0, 0, 0, pr.owner, tint);
        this.projs.set(pr.id, v);
      }
      v.sprite.setPosition(pr.x, pr.y);
    }
    for (const [id, v] of this.projs) if (!seenP.has(id)) { v.destroy(); this.projs.delete(id); }
    // Дропы на земле.
    const seenD = new Set<number>();
    for (const d of snap.drops) {
      seenD.add(d.id);
      if (!this.drops.has(d.id)) {
        const obj = new DroppedItem(this.scene, d.x, d.y, d.item);
        obj.sprite.setData('dropId', d.id); // клик по спрайту → точечная команда подбора
        this.drops.set(d.id, obj);
      }
    }
    for (const [id, v] of this.drops) if (!seenD.has(id)) { v.destroy(); this.drops.delete(id); }
  }

  /** Заменяет сейв авторитетным серверным. Раскладка инвентаря (item.pos) тоже серверная —
   * перекладка идёт командой `moveItem`, клиент только рисует. Единая истина, без расхождения. */
  private applySave(save: SaveState): void {
    this.app.state!.save = save;
    this.app.bus.emit('state:changed', {});
  }

  private onEvents(events: SessionEvent[]): void {
    const bus = this.app.bus;
    for (const e of events) {
      if (e.type === 'hit') {
        const onPlayer = e.target === 'player';
        this.feedback(e.x, e.y, e, onPlayer); // числа видят все
        if (e.target === 'monster') {
          const view = this.monsters.get(e.id as number);
          if (view && e.hit && !e.blocked) view.flash();
          // Свой чат: только МОИ удары (by === мой id).
          if (e.by === this.myId && view) {
            if (!e.hit) bus.emit('log:message', { text: `Промах по ${view.def.name}`, kind: 'system' });
            else if (e.blocked) bus.emit('log:message', { text: `${view.def.name} блокировал удар`, kind: 'system' });
            else if (e.amount > 0) bus.emit('log:message', { text: `Нанёс ${e.amount}${e.crit ? ' крит!' : ''} — ${view.def.name}`, kind: 'dmg-out' });
          }
          if (view) { const cs = monsterCombatStats(view.def); this.app.lastTarget = { name: view.def.name, accuracy: cs.accuracy, evade: cs.evade }; }
        } else if (e.id === this.myId) {
          // Свой чат: удары ПО МНЕ.
          const by = e.by ?? 'Враг';
          if (!e.hit) bus.emit('log:message', { text: `Уворот от: ${by}`, kind: 'system' });
          else if (e.blocked) bus.emit('log:message', { text: `Блок удара: ${by}`, kind: 'system' });
          else if (e.amount > 0) bus.emit('log:message', { text: `Получил ${e.amount}${e.crit ? ' крит!' : ''} от: ${by}`, kind: 'dmg-in' });
        }
      } else if (e.type === 'monster-died') {
        this.monsters.get(e.id)?.destroy();
        this.monsters.delete(e.id);
        if (e.by === this.myId) bus.emit('log:message', { text: `Убит ${e.def.name}`, kind: 'kill' });
      } else if (e.type === 'item-picked') {
        if (e.playerId === this.myId) { bus.emit('log:message', { text: `Поднято: ${e.item.name}`, kind: 'loot' }); bus.emit('item:picked', { item: e.item }); }
      } else if (e.type === 'gold') {
        if (e.playerId === this.myId) bus.emit('gold:changed', { gold: e.total }); // звук + обновление золота в UI
      } else if (e.type === 'xp') {
        if (e.playerId === this.myId) bus.emit('log:message', { text: `Опыт +${e.amount}`, kind: 'xp' });
      } else if (e.type === 'levelup') {
        if (e.playerId === this.myId) { bus.emit('log:message', { text: `Новый уровень: ${e.level}!`, kind: 'kill' }); bus.emit('player:levelup', { level: e.level, attributePoints: 0, skillPoints: 0 }); }
      } else if (e.type === 'quest') {
        if (e.playerId === this.myId) bus.emit('log:message', { text: questText(e.kind, e.name), kind: 'system' });
      } else if (e.type === 'player-died') {
        if (e.playerId === this.myId) bus.emit('player:died', { depth: this.app.state!.depth });
      }
    }
  }

  private feedback(x: number, y: number, e: { hit: boolean; blocked: boolean; crit: boolean; byType: DamagePacket; amount: number }, onPlayer: boolean): void {
    let text: string; let color: number; let big = false;
    if (!e.hit) { text = 'промах'; color = 0x9a9a9a; }
    else if (e.blocked) { text = 'блок'; color = 0x8fd0ff; }
    else {
      let dom: DamageType = 'physical'; let best = -1;
      for (const t of ['physical', 'fire', 'cold', 'lightning', 'poison'] as const) if (e.byType[t] > best) { best = e.byType[t]; dom = t; }
      color = onPlayer ? 0xff5b5b : dmgColorNum(dom);
      text = e.crit ? `${e.amount}!` : `${e.amount}`; big = e.crit;
    }
    const t = this.scene.add.text(x, y - 10, text, { fontSize: big ? '18px' : '13px', color: '#' + color.toString(16).padStart(6, '0'), fontStyle: big ? 'bold' : 'normal' }).setOrigin(0.5).setDepth(20);
    this.scene.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 600, onComplete: () => t.destroy() });
  }

  destroy(): void {
    this.scene.input.off('pointerdown', this.onDown);
    this.scene.input.off('pointerup', this.onUp);
    for (const m of this.monsters.values()) m.destroy();
    for (const p of this.projs.values()) p.destroy();
    for (const r of this.remotes.values()) { r.sprite.destroy(); r.nose.destroy(); }
    for (const d of this.drops.values()) d.destroy();
    this.monsters.clear(); this.projs.clear(); this.remotes.clear(); this.drops.clear();
  }
}
