import Phaser from 'phaser';
import type { App } from '../core/app.js';
import type { Player } from '../modules/movement/player.js';
import { Monster } from '../modules/combat/monster.js';
import { Projectile } from '../modules/combat/projectile.js';
import { DroppedItem } from '../modules/loot/droppedItem.js';
import { PlayerVfx } from '../modules/combat/playerVfx.js';
import { SnapshotBuffer } from './snapshotBuffer.js';
import { InputSampler } from './inputSampler.js';
import { onFocusLost } from './focusRelease.js';
import { mergePeerStatics } from './peerStatics.js';
import { dmgColorNum } from '../core/damageTypes.js';
import { monsterCombatStats } from '@dm/shared';
import type { DamagePacket, DamageType, FloorInit, SaveState, SessionEvent, WorldSnapshot, WorldSnapshotFull, PeerInfo } from '@dm/shared';

/** Задержка интерполяции чужих сущностей (мс): рисуем их немного в прошлом, чтобы сгладить 30 Гц + джиттер. */
const INTERP_DELAY_MS = 100;
/** Пост. времени сглаживания СВОЕГО игрока к авторитетной позиции (мс): убирает 30 Гц-«ступеньки». */
const SELF_SMOOTH_TAU_MS = 45;
/** Рассинхрон больше — телепорт (респавн/смена этажа/рывок): не сглаживаем, ставим мгновенно. */
const SELF_SNAP_DIST = 120;
/**
 * ⭐ R6-03: клавиши, которые драйвер ПЕРЕХВАТЫВАЕТ (`preventDefault`), — только эти и только пока он жив: пробел (рывок)
 * не жмёт кнопку, оставшуюся в фокусе, и не листает страницу; отпускание Alt не уводит в меню браузера. Буквам перехват
 * не нужен вовсе: у Phaser он на всю страницу (слушатель на `window`, поле ввода не в счёт) и переживает сцену — после
 * ухода на вход (R4-22) w/a/s/d/e/q и пробел не набирались ни в ник, ни в пароль, а «a» — в код комнаты в лобби.
 */
const GAME_CAPTURES = ['SPACE', 'SHIFT', 'ALT'];

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
  private keys: Record<'w' | 'a' | 's' | 'd' | 'shift' | 'space' | 'alt' | 'e' | 'q', Phaser.Input.Keyboard.Key>;
  private leftHeld = false;
  private rightHeld = false;
  /** R4-20: отписка от потери фокуса окна. */
  private offFocus: () => void;
  /** R5-16: отписки от кадров сети — снимаются в `destroy`. */
  private offNet: (() => void)[];
  private seq = 0;
  /**
   * R3-08: ввод уходит с частотой тика сервера, а не кадров (иначе на 90+ Гц сервер рвал сокет кодом 4008); фронт
   * нажатия — в том же кадре. Сэмплер общий с веб-3D (L2): фронты и темп считаются одним кодом.
   */
  private input = new InputSampler();
  private latest?: WorldSnapshotFull;
  /** Буфер снапшотов для интерполяции чужих сущностей (пиры/монстры/снаряды). */
  private buffer = new SnapshotBuffer();
  /** Ф1.1: статика игроков (имя/класс/макс.HP/радиус/внешность) — приходит отдельно от снапшота. */
  private peerStatics = new Map<string, PeerInfo>();

  /** Слить динамику снапшота со статикой из реестра. */
  private mergeSnapshot(snap: WorldSnapshot): WorldSnapshotFull {
    return {
      ...snap,
      players: snap.players.map((pv) => {
        const st = this.peerStatics.get(pv.id);
        // Статики может не быть ровно один кадр — между входом и догоняющим peerInfo.
        // Тогда безопасные умолчания, чтобы не городить проверок по всему рендеру.
        return {
          ...pv,
          classId: st?.classId ?? 'warrior',
          name: st?.name ?? '',
          maxHp: st?.maxHp ?? Math.max(1, pv.hp),
          r: st?.r ?? 14,
          weaponKey: st?.weaponKey,
          armorModels: st?.armorModels,
          weaponLook: st?.weaponLook,   // D22: 2D его не рисует, но форма игрока та же, что у 3D-клиента
        };
      }),
    };
  }
  /** Сглаженная позиция СВОЕГО игрока (лерп к авторитетной); hasSmooth=false → первый кадр ставит точно. */
  private smoothX = 0;
  private smoothY = 0;
  private hasSmooth = false;
  /** VFX вокруг игрока: аура-кольцо, конус-прицел дальности/размаха, слэш при ударе. */
  private vfx: PlayerVfx;

  constructor(scene: Phaser.Scene, app: App, player: Player) {
    this.scene = scene;
    this.app = app;
    this.player = player;
    this.vfx = new PlayerVfx(scene);
    const kb = scene.input.keyboard!;
    const K = Phaser.Input.Keyboard.KeyCodes;
    // R6-03: `addKey(код, false)` — без перехвата (по умолчанию Phaser перехватывает каждую добавленную клавишу).
    this.keys = {
      w: kb.addKey(K.W, false), a: kb.addKey(K.A, false), s: kb.addKey(K.S, false), d: kb.addKey(K.D, false),
      shift: kb.addKey(K.SHIFT, false), space: kb.addKey(K.SPACE, false), alt: kb.addKey(K.ALT, false),
      e: kb.addKey(K.E, false), q: kb.addKey(K.Q, false),
    };
    kb.addCapture(GAME_CAPTURES);
    scene.input.mouse?.disableContextMenu();
    scene.input.on('pointerdown', this.onDown);
    scene.input.on('pointerup', this.onUp);
    // ⭐ R4-20: окно потеряло фокус — клавиши Phaser отпускает сам (BLUR игры), а кнопки мыши нет: pointerup достаётся
    // другому окну, и удар «залипал» до следующего клика. (Без окна — стенд в node — отпускать нечего.)
    this.offFocus = typeof window === 'undefined' ? () => undefined
      : onFocusLost(window, document, () => { this.leftHeld = false; this.rightHeld = false; });

    // Ф1.1: статика игроков приходит отдельным кадром; сливаем её со снапшотом на приёме,
    // чтобы остальной код работал с привычной формой.
    // ⭐ R5-16: подписки — с отписками: драйвер живёт одну сцену, а `NetClient` — всё приложение. Раньше снесённый
    // драйвер (выход на вход / выбор героя и новый вход) слушал кадры до перезагрузки страницы — рисовал в снесённую сцену.
    this.offNet = [
      app.net.on('peerInfo', (f) => mergePeerStatics(this.peerStatics, f.peers)),
      app.net.on('monsterInfo', (f) => {
        for (const m of f.monsters) {
          if (!this.monsters.has(m.id)) this.monsters.set(m.id, new Monster(this.scene, m.x, m.y, m.def));
        }
      }),
      app.net.on('peerJoined', (f) => { this.peerStatics.set(f.peer.id, f.peer); }),
      // Ф1.4: дельты применяет транспорт (`netClient`) — сюда приходит уже собранный мир.
      app.net.on('snapshot', (f) => {
        const merged = this.mergeSnapshot(f.snap);
        this.latest = merged;
        this.buffer.push(merged, performance.now());
      }),
      app.net.on('events', (f) => this.onEvents(f.events)),
      app.net.on('saveUpdate', (f) => this.applySave(f.save)),
      app.net.on('peerLeft', (f) => { const r = this.remotes.get(f.id); r?.sprite.destroy(); r?.nose.destroy(); this.remotes.delete(f.id); this.peerStatics.delete(f.id); }),
    ];
  }

  setMyId(id: string): void { this.myId = id; }

  /** Статика игроков из кадра `joined` (R2-03): те, кто уже в комнате, известны сразу, а не с их следующей экипировки. */
  seedPeers(peers: readonly PeerInfo[]): void { mergePeerStatics(this.peerStatics, peers); }

  /** Сброс интерполяции/сглаживания при смене области (иначе лерп «протянет» через границу этажа). */
  resetInterpolation(): void { this.buffer.clear(); this.hasSmooth = false; }

  /**
   * R3-25: соединение потеряно — снести всё, что рисовалось из прошлой сессии: пиров (их `peerLeft` уже не придёт, и
   * спрайты застыли бы на карте навсегда), монстров, снаряды, дропы и последний снапшот. Вход заново нарисует своё.
   */
  resetWorld(): void {
    for (const m of this.monsters.values()) m.destroy();
    for (const p of this.projs.values()) p.destroy();
    for (const r of this.remotes.values()) { r.sprite.destroy(); r.nose.destroy(); }
    for (const d of this.drops.values()) d.destroy();
    this.monsters.clear(); this.projs.clear(); this.remotes.clear(); this.drops.clear();
    this.peerStatics.clear();
    this.latest = undefined;
    this.resetInterpolation();
  }

  /** Тогл ли забинженный узел (аура/стойка) — для фронт-детекции нажатия (иначе удержание мигает тоглом). */
  private isToggleSkill(nodeId: string): boolean {
    const save = this.app.state?.save;
    if (!save) return false;
    const tree = this.app.config.get('skill-tree');
    const cat = tree?.nodes.find((n) => n.id === nodeId)?.effect.active?.category;
    return cat === 'aura' || cat === 'stance';
  }

  /** Пересоздаёт монстров текущей области по FloorInit (id→def). Вызывать при входе/смене этажа. */
  buildMonsters(floor: FloorInit): void {
    for (const m of this.monsters.values()) m.destroy();
    this.monsters.clear();
    // Ф1.2: монстры приходят кадром `monsterInfo` по мере входа в область интереса,
    // а не списком всего этажа в FloorInit.
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

  /**
   * Каждый кадр: собираем ввод, рисуем VFX, применяем последний снапшот. `dt` — мс с прошлого кадра.
   * ⚠ R3-08: ввод УХОДИТ не каждый кадр, а с частотой тика сервера; фронт нажатия — в том же кадре (`InputSampler`).
   * Удержания сэмплируются каждый кадр, поэтому фронт не теряется между отправками.
   */
  update(dt = 0): void {
    // ЛКМ/ПКМ + Shift/Q/Alt — по биндам сейва; тоглы (аура/стойка) — по фронту; пробел — рывок (фронт);
    // E — подбор ближайшего дропа (удержание: сервер сэмплит каждый тик). Клик по предмету — точечно (onDown).
    const s = this.input.frame(dt, this.app.state!.save, {
      L: this.leftHeld, R: this.rightHeld, S: this.keys.shift.isDown, Q: this.keys.q.isDown, A: this.keys.alt.isDown,
      dodge: this.keys.space.isDown, interact: this.keys.e.isDown,
    }, (id) => this.isToggleSkill(id));
    if (s.due) {
      const move = {
        x: (this.keys.d.isDown ? 1 : 0) - (this.keys.a.isDown ? 1 : 0),
        y: (this.keys.s.isDown ? 1 : 0) - (this.keys.w.isDown ? 1 : 0),
      };
      this.app.net.send({ t: 'input', seq: this.seq++, input: { move, facing: this.player.facing, attack: s.attack, cast: s.cast, interact: s.interact, dodge: s.dodge } });
    }

    // VFX: форма удара рисуется по СОБЫТИЮ `swing` с сервера (реальный удар, мана/КД учтены) — см.
    // onEvents; здесь только кольца аур + телеграф текущих свингов (позиция/поворот live).
    const st = this.app.state!;
    this.vfx.drawFrame(this.player, st, this.app.config, this.scene.time.now);

    if (this.latest) {
      // Чужие сущности — из интерполированного снапшота (в прошлом на INTERP_DELAY); свой игрок — из
      // latest (сглаживание к «сейчас»). Мало данных → интерполяция вернёт latest, поведение как раньше.
      const view = this.buffer.sample(performance.now() - INTERP_DELAY_MS) ?? this.latest;
      this.renderSelf(dt);
      this.render(view);
    }
  }

  /** Свой игрок: сглаживание к последней АВТОРИТЕТНОЙ позиции (без интерполяции — иначе своё движение с лагом). */
  private renderSelf(dt: number): void {
    const state = this.app.state!;
    const mine = this.latest?.players.find((p) => p.id === this.myId);
    if (!mine) return;
    if (!this.hasSmooth || Math.hypot(mine.x - this.smoothX, mine.y - this.smoothY) > SELF_SNAP_DIST) {
      this.smoothX = mine.x; this.smoothY = mine.y; this.hasSmooth = true; // первый кадр/телепорт → точно
    } else {
      const k = 1 - Math.exp(-dt / SELF_SMOOTH_TAU_MS); // экспоненциальное сглаживание, кадронезависимое
      this.smoothX += (mine.x - this.smoothX) * k;
      this.smoothY += (mine.y - this.smoothY) * k;
    }
    this.player.setPos(this.smoothX, this.smoothY);
    state.hp = mine.hp; state.mana = mine.mana; state.stamina = mine.stamina; state.debuffs = mine.debuffs;
    // Смена аур/стоек приходит в снапшоте — эмитим state:changed, чтобы открытый лист персонажа
    // перерисовался с бонусами ауры В МОМЕНТЕ (а не только после переоткрытия окна).
    if (state.toggles.join(',') !== mine.toggles.join(',')) { state.toggles = mine.toggles; this.app.bus.emit('state:changed', {}); }
    else state.toggles = mine.toggles;
  }

  private render(snap: WorldSnapshotFull): void {
    // Пиры (свой игрок нарисован в renderSelf — здесь пропускаем).
    for (const pv of snap.players) {
      if (pv.id === this.myId) continue;
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
        if (d.kind !== 'item') continue; // золото и материалы 2D-клиент не рисует (он заморожен)
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
      } else if (e.type === 'swing') {
        // Реальный удар своего игрока (мана/КД/оружие уже прошли): форма-телеграф + заливка-откат слота.
        if (e.playerId === this.myId) {
          const now = performance.now();
          // ⚠ Взмах СЕРИИ (`chain`) заливку не перезапускает — откат идёт с первого взмаха.
          if (!e.chain) this.app.actionCooldowns[e.ability] = { start: now, until: now + e.cooldownMs };
          this.app.attackLockUntil = now + e.lockMs; // общий лок → остальные атак-слоты серые
          this.vfx.startSwing(this.vfx.currentAttack(this.app.state!, this.app.config, e.ability), e.windupMs);
        }
      } else if (e.type === 'monster-swing') {
        this.monsters.get(e.id)?.telegraph(e.windupMs); // вспышка-телеграф замаха монстра
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
    for (const off of this.offNet) off();   // R5-16: кадры сети этому драйверу больше не нужны
    this.offNet = [];
    this.scene.input.keyboard?.removeCapture(GAME_CAPTURES);   // R6-03: выход сцены клавиши сносит, а перехват — нет
    this.vfx.destroy();
    this.scene.input.off('pointerdown', this.onDown);
    this.scene.input.off('pointerup', this.onUp);
    this.offFocus();
    for (const m of this.monsters.values()) m.destroy();
    for (const p of this.projs.values()) p.destroy();
    for (const r of this.remotes.values()) { r.sprite.destroy(); r.nose.destroy(); }
    for (const d of this.drops.values()) d.destroy();
    this.monsters.clear(); this.projs.clear(); this.remotes.clear(); this.drops.clear();
  }
}
