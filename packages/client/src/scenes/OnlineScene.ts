import Phaser from 'phaser';
import { App } from '../core/app.js';
import { Player } from '../modules/movement/player.js';
import { NetDriver } from '../net/netDriver.js';
import { renderGrid } from '../world/tileWorld.js';
import { FogOfWar } from '../world/fogOfWar.js';
import { GameState } from '../core/gameState.js';
import { TILE, Cell, gridSize, type FloorInit, type Grid } from '@dm/shared';

interface Interactable { x: number; y: number; radius: number; label: string; run: () => void; doorId?: number }

/** NPC/портал города — клиентский декор (позиции-константы); авторитет — сервер. */
const TOWN_NPCS: { cx: number; cy: number; label: string; panel: string; tint?: number }[] = [
  { cx: 4, cy: 4, label: 'Магазин', panel: 'shop', tint: 0x9fd0ff },
  { cx: 7, cy: 4, label: 'Кузница', panel: 'forge', tint: 0xffa060 },
  { cx: 10, cy: 4, label: 'Мастер прокачки', panel: 'master', tint: 0xb090ff },
  { cx: 14, cy: 4, label: 'Доска квестов', panel: 'quests', tint: 0xd0c060 },
  { cx: 17, cy: 4, label: 'Сундук', panel: 'stash', tint: 0xc99a48 },
];

/**
 * Единая ОНЛАЙН-сцена: и город, и подземелье. Мир строится из авторитетных кадров
 * сервера (`joined`/`areaChanged`), рисуется по снапшотам через `NetDriver`. Спуск по
 * лестнице/портал — запрос голосования. Лобби (Хост/Войти/Соло) — DOM-оверлей на входе.
 */
export class OnlineScene extends Phaser.Scene {
  private app!: App;
  private driver?: NetDriver;
  private player?: Player;
  private fog?: FogOfWar;
  private worldObjs: Phaser.GameObjects.GameObject[] = [];
  private walls?: Phaser.Physics.Arcade.StaticGroup;
  private interactables: Interactable[] = [];
  /** Спрайты дверей/рычагов по doorId — чтобы убрать на `doorOpened`. */
  private doorSprites = new Map<number, Phaser.GameObjects.GameObject[]>();
  private leverSprites = new Map<number, Phaser.GameObjects.GameObject>();
  private floorGrid?: Grid;
  private floorDoors: FloorInit['doors'] = [];
  private area: 'town' | 'dungeon' = 'town';
  private eKey!: Phaser.Input.Keyboard.Key;
  private prompt?: Phaser.GameObjects.Text;
  private lobby?: HTMLElement;
  private resumeBox?: HTMLElement;
  private connectingBox?: HTMLElement;
  private statusEl?: HTMLElement;
  private voteBox?: HTMLElement;
  private deathBox?: HTMLElement;
  private codeLabel?: HTMLElement;
  private myId = '';

  constructor() { super('Online'); }

  create(): void {
    this.app = App.from(this);
    if (!this.app.auth || !this.app.pendingCharId) { this.scene.start('MainMenu'); return; }
    this.eKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.prompt = this.add.text(0, 0, '', { fontSize: '14px', color: '#f0d9a8', backgroundColor: '#000000aa', padding: { x: 6, y: 3 } }).setDepth(100).setVisible(false);

    // Сцена пере-подписывается при каждом входе — снимаем прошлые обработчики (net живёт в App).
    for (const t of ['joined', 'areaChanged', 'doorOpened', 'died', 'voteStart', 'voteUpdate', 'voteEnd', 'runStatus', 'abandoned', 'error'] as const) this.app.net.off(t);
    this.app.net.clearLifecycle();

    // Сетевые обработчики области/голосования.
    this.app.net.on('joined', (f) => {
      this.hideConnecting(); this.hideResumePrompt(); this.hideLobby();
      this.myId = f.playerId; // ВАЖНО до buildArea: иначе свой игрок рисуется как чужой
      const state = new GameState(f.save); // авторитетный сейв с сервера — истина
      state.restoreFull();
      this.app.state = state; // сеттер App.state подключает провайдеры модов
      this.buildArea(f.floor);
      this.showRoomCode(f.roomCode);
    });
    this.app.net.on('areaChanged', (f) => { this.closeDeathModal(); this.buildArea(f.floor); }); // возрождение = смена области
    this.app.net.on('doorOpened', (f) => this.openDoor(f.doorId));
    this.app.net.on('died', (f) => this.showDeathModal(f)); // окно смерти (потери + режим возрождения)
    this.app.net.on('voteStart', (f) => this.showVote(f.kind, f.by));
    this.app.net.on('voteUpdate', (f) => { if (this.voteBox) this.voteBox.querySelector('.tally')!.textContent = `${f.yes}/${f.total}`; });
    this.app.net.on('voteEnd', () => this.closeVote());
    // Вход: сервер сообщил, есть ли незавершённый забег → модалка «Продолжить/Забросить» либо лобби.
    this.app.net.on('runStatus', (f) => { this.hideConnecting(); if (f.hasRun) this.showResumePrompt(f.roomCode ?? '', f.depth ?? 0); else this.showLobby(); });
    this.app.net.on('abandoned', () => { this.hideResumePrompt(); this.showLobby(); });
    this.app.net.on('error', (f) => {
      if (f.code === 'no-run') { this.hideResumePrompt(); this.showLobby(); return; } // забег истёк за время раздумий
      if (this.statusEl) this.statusEl.textContent = f.msg;
    });

    // Ещё не в игре → подключаемся и спрашиваем статус забега (плашка «Подключение…» до ответа).
    if (!this.app.net.connected) {
      this.showConnecting();
      this.app.net.onOpen(() => this.app.net.send({ t: 'runStatus', token: this.app.auth!.token, charId: this.app.pendingCharId! }));
      this.app.net.onClose(() => { if (this.connectingBox) { this.hideConnecting(); this.showLobby(); if (this.statusEl) this.statusEl.textContent = 'Сервер недоступен'; } });
      this.app.net.connect();
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  // ── Лобби / вход ──────────────────────────────────────────────────────────────
  /** Единый способ отправить join по уже открытому сокету (соединение поднято в create). */
  private sendJoin(opts: { fresh?: boolean; roomCode?: string; resume?: boolean }): void {
    this.app.net.send({ t: 'join', token: this.app.auth!.token, charId: this.app.pendingCharId!, ...opts });
  }

  /** Плашка «Подключение к серверу…» до ответа runStatus (кнопок нет — исключаем misclick). */
  private showConnecting(): void {
    if (this.connectingBox) return;
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);z-index:90';
    box.innerHTML = `<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px 30px;color:#e6ddc9;text-align:center">
      <div style="font-size:16px">Подключение к серверу…</div>
      <div class="status" style="margin-top:8px;font-size:12px;color:#8f897c"></div></div>`;
    root.appendChild(box);
    this.connectingBox = box;
    this.statusEl = box.querySelector('.status') as HTMLElement;
  }
  private hideConnecting(): void { this.connectingBox?.remove(); this.connectingBox = undefined; this.statusEl = undefined; }

  /** Незавершённый забег (вышли из подземелья): продолжить или забросить (персонаж гибнет со штрафом). */
  private showResumePrompt(roomCode: string, depth: number): void {
    if (this.resumeBox) return;
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);z-index:90';
    const where = depth > 0 ? `этаж ${depth}` : 'подземелье';
    box.innerHTML = `<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px;min-width:300px;color:#e6ddc9;text-align:center">
      <div style="font-size:18px;margin-bottom:8px">Незавершённое прохождение</div>
      <div style="font-size:13px;color:#a8a090;margin-bottom:16px">Вы вышли из подземелья (${where}, комната ${roomCode}). Продолжить забег или забросить?</div>
      <button data-a="resume" style="display:block;width:100%;margin:6px 0;padding:9px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Продолжить</button>
      <button data-a="abandon" style="display:block;width:100%;margin:6px 0;padding:9px;background:#3a1c1c;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Забросить прохождение</button>
      <div style="font-size:11px;color:#8f7a72;margin-top:6px">«Забросить» — персонаж считается погибшим (штраф золота и части предметов).</div>
      <div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div></div>`;
    root.appendChild(box);
    this.resumeBox = box;
    this.statusEl = box.querySelector('.status') as HTMLElement;
    box.querySelector('[data-a="resume"]')!.addEventListener('click', () => { this.statusEl!.textContent = 'Возврат в забег…'; this.sendJoin({ resume: true }); });
    box.querySelector('[data-a="abandon"]')!.addEventListener('click', () => {
      this.statusEl!.textContent = 'Забрасываем…';
      this.app.net.send({ t: 'abandon', token: this.app.auth!.token, charId: this.app.pendingCharId! });
    });
  }
  private hideResumePrompt(): void { this.resumeBox?.remove(); this.resumeBox = undefined; this.statusEl = undefined; }

  private showLobby(): void {
    if (this.lobby) return;
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);z-index:90';
    box.innerHTML = `<div style="background:#171b24;border:1px solid #2b323f;border-radius:10px;padding:24px;min-width:280px;color:#e6ddc9;text-align:center">
      <div style="font-size:18px;margin-bottom:14px">Кооп</div>
      <button data-a="solo" style="display:block;width:100%;margin:6px 0;padding:8px;background:#1e2a3a;color:#cfe0f2;border:1px solid #6f9bcf;border-radius:6px;cursor:pointer">Соло (комната на 1)</button>
      <button data-a="host" style="display:block;width:100%;margin:6px 0;padding:8px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Создать комнату</button>
      <div style="display:flex;gap:6px;margin-top:6px"><input class="code" placeholder="КОД" maxlength="4" style="flex:1;text-transform:uppercase;padding:8px;background:#0f131a;color:#e6ddc9;border:1px solid #2b323f;border-radius:6px"><button data-a="join" style="padding:8px 12px;background:#3a2c15;color:#f0d9a8;border:1px solid #e39a3c;border-radius:6px;cursor:pointer">Войти</button></div>
      <div class="status" style="margin-top:10px;font-size:12px;color:#8f897c"></div></div>`;
    root.appendChild(box);
    this.lobby = box;
    this.statusEl = box.querySelector('.status') as HTMLElement;
    const go = (opts: { fresh?: boolean; roomCode?: string }): void => { this.statusEl!.textContent = 'Подключение…'; this.sendJoin(opts); };
    box.querySelector('[data-a="solo"]')!.addEventListener('click', () => go({ fresh: true }));
    box.querySelector('[data-a="host"]')!.addEventListener('click', () => go({ fresh: true }));
    box.querySelector('[data-a="join"]')!.addEventListener('click', () => {
      const code = (box.querySelector('.code') as HTMLInputElement).value.trim().toUpperCase();
      if (code) go({ roomCode: code });
    });
  }
  private hideLobby(): void { this.lobby?.remove(); this.lobby = undefined; this.statusEl = undefined; }

  /** Показывает код комнаты (для приглашения друзей) — фикс-плашка справа сверху. */
  private showRoomCode(code: string): void {
    if (!this.codeLabel) {
      const root = document.getElementById('ui-root') ?? document.body;
      this.codeLabel = document.createElement('div');
      this.codeLabel.style.cssText = 'position:fixed;top:8px;right:12px;z-index:60;background:#171b24;border:1px solid #6f9bcf;border-radius:6px;padding:6px 10px;color:#cfe0f2;font-size:13px;pointer-events:none';
      root.appendChild(this.codeLabel);
    }
    this.codeLabel.innerHTML = `Комната: <b style="color:#dca94b;letter-spacing:2px">${code}</b>`;
  }

  // ── Постройка области (город/этаж) ──────────────────────────────────────────
  private buildArea(floor: FloorInit): void {
    for (const o of this.worldObjs) o.destroy();
    this.worldObjs = [];
    this.walls?.destroy(false); // старую группу стен (её тайлы уже были в worldObjs)
    this.fog?.destroy(); this.fog = undefined;
    this.interactables = [];
    this.doorSprites.clear(); this.leverSprites.clear();
    this.floorGrid = floor.grid;
    this.floorDoors = floor.doors;

    const rendered = renderGrid(this, floor.grid);
    this.walls = rendered.walls;
    this.worldObjs.push(...rendered.objects); // тайлы пола/стен — уничтожатся при следующей пересборке
    this.area = floor.area;

    // Декор.
    for (const d of floor.decor) {
      const img = this.add.image(d.x, d.y, `decor-${d.kind}`).setDepth(d.kind === 'arena' ? -8 : 1);
      if (d.kind === 'arena') img.setAlpha(0.4);
      this.worldObjs.push(img);
    }

    // Игрок-вид (создаём один раз).
    if (!this.player) {
      const cls = this.app.state!.save.classId;
      const tex = this.textures.exists(`player-${cls}`) ? `player-${cls}` : 'player-warrior';
      this.player = new Player(this, floor.spawn.x, floor.spawn.y, tex);
      this.driver = new NetDriver(this, this.app, this.player);
      this.driver.setMyId(this.myId); // свой id — чтобы свой игрок не рисовался как «чужой»
      this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
      this.cameras.main.setZoom(1.5);
      if (!this.scene.isActive('UI')) this.scene.launch('UI');
    } else {
      this.player.setPos(floor.spawn.x, floor.spawn.y);
    }
    this.driver!.buildMonsters(floor);
    this.driver!.resetInterpolation(); // новая область: сбросить буфер интерполяции и сглаживание своего игрока

    if (floor.area === 'dungeon') {
      const { cols, rows } = gridSize(floor.grid);
      this.fog = new FogOfWar(this, floor.grid, cols * TILE, rows * TILE);
      this.fog.revealSpawn(floor.spawn.x, floor.spawn.y);
      if (floor.stairs) {
        const st = this.add.image(floor.stairs.x, floor.stairs.y, 'tile-stairs').setDepth(1);
        this.worldObjs.push(st);
        this.interactables.push({ x: floor.stairs.x, y: floor.stairs.y, radius: 34, label: 'Спуститься глубже (голосование)', run: () => this.app.net.send({ t: 'descend' }) });
      }
      // Портал возврата в город у точки входа (голосование пати).
      const back = this.add.image(floor.spawn.x, floor.spawn.y, 'portal').setDepth(1).setAlpha(0.85);
      this.worldObjs.push(back);
      this.interactables.push({ x: floor.spawn.x, y: floor.spawn.y, radius: 40, label: 'Вернуться в город (голосование)', run: () => this.app.net.send({ t: 'return' }) });
      // Запертые двери (спрайты поверх пола) + рычаги (интерактив «[E] Рычаг», открывает свою дверь).
      for (const door of floor.doors) {
        const parts: Phaser.GameObjects.GameObject[] = [];
        for (const c of door.cells) {
          const dw = this.add.image(c.cx * TILE + TILE / 2, c.cy * TILE + TILE / 2, 'tile-door').setDepth(2);
          this.worldObjs.push(dw); parts.push(dw);
        }
        this.doorSprites.set(door.id, parts);
      }
      for (const lv of floor.levers) {
        const marker = this.add.rectangle(lv.x, lv.y, 12, 22, 0xdca94b).setStrokeStyle(2, 0x1a1a1a).setDepth(2);
        this.worldObjs.push(marker);
        this.leverSprites.set(lv.doorId, marker);
        this.interactables.push({ x: lv.x, y: lv.y, radius: 40, label: 'Рычаг (открыть дверь)', run: () => this.app.net.send({ t: 'lever', leverId: lv.id }), doorId: lv.doorId });
      }
      this.app.state!.depth = floor.depth;
    } else {
      this.addTownDecor(floor);
      this.app.state!.depth = 0;
    }
  }

  private addTownDecor(floor: FloorInit): void {
    const cell = (cx: number, cy: number) => ({ x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 });
    for (const n of TOWN_NPCS) {
      const p = cell(n.cx, n.cy);
      const img = this.add.image(p.x, p.y, 'npc').setDepth(2);
      if (n.tint) img.setTint(n.tint);
      const txt = this.add.text(p.x - 26, p.y + 16, n.label, { fontSize: '11px', color: '#e6ddc9' }).setDepth(2);
      this.worldObjs.push(img, txt);
      this.interactables.push({ x: p.x, y: p.y, radius: 40, label: n.label, run: () => this.app.bus.emit('ui:open', { panel: n.panel }) });
    }
    // Портал в подземелье (спуск = голосование за вход в данж).
    const cols = gridSize(floor.grid).cols;
    const rows = gridSize(floor.grid).rows;
    const pp = cell(cols - 4, rows - 4);
    const portal = this.add.image(pp.x, pp.y, 'portal').setDepth(2);
    this.worldObjs.push(portal);
    // Портал открывает выбор сложности; уже он шлёт `descend` с выбранным тиром.
    this.interactables.push({ x: pp.x, y: pp.y, radius: 44, label: 'В подземелье (выбор сложности)', run: () => this.app.bus.emit('ui:open', { panel: 'difficulty' }) });
  }

  /**
   * Окно смерти: потери (золото/предметы) + режим возрождения. Соло/вайп → «возврат в город»
   * (окно закроется на areaChanged). Кооп → «ждите пати» + кнопка «Смотреть» (спектейт до спуска).
   */
  private showDeathModal(f: { goldLost: number; itemsLost: number; toTown: boolean }): void {
    this.closeDeathModal();
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:96;background:rgba(30,8,10,0.96);border:1px solid #c85a48;border-radius:12px;padding:22px 30px;color:#e6c8bd;text-align:center;min-width:280px';
    const status = f.toTown ? 'Возвращаетесь в город…' : 'Ожидайте: пати зачистит этаж и спустится — там вы возродитесь.';
    box.innerHTML = `<div style="font-size:24px;margin-bottom:10px">Вы погибли</div>
      <div style="font-size:14px;color:#d9a898">Потеряно: <b>${f.goldLost}</b> золота, <b>${f.itemsLost}</b> предм.</div>
      <div style="font-size:13px;color:#b09088;margin-top:10px">${status}</div>`;
    if (!f.toTown) {
      const btn = document.createElement('button');
      btn.textContent = 'Смотреть за пати';
      btn.style.cssText = 'margin-top:14px;padding:8px 16px;background:#3a2030;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer';
      btn.addEventListener('click', () => this.closeDeathModal());
      box.appendChild(btn);
    }
    root.appendChild(box);
    this.deathBox = box;
  }
  private closeDeathModal(): void { this.deathBox?.remove(); this.deathBox = undefined; }

  /** Сервер открыл дверь: убрать её спрайты + рычаг + интерактив, открыть клетки (для тумана). */
  private openDoor(doorId: number): void {
    for (const s of this.doorSprites.get(doorId) ?? []) s.destroy();
    this.doorSprites.delete(doorId);
    this.leverSprites.get(doorId)?.destroy();
    this.leverSprites.delete(doorId);
    this.interactables = this.interactables.filter((it) => it.doorId !== doorId);
    const door = this.floorDoors.find((d) => d.id === doorId);
    if (door && this.floorGrid) for (const c of door.cells) { const row = this.floorGrid[c.cy]; if (row) row[c.cx] = Cell.Floor; }
  }

  // ── Голосование ─────────────────────────────────────────────────────────────
  private showVote(kind: 'descend' | 'town', by: string): void {
    if (this.voteBox) return;
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:88;background:#171b24;border:1px solid #6f9bcf;border-radius:8px;padding:12px 16px;color:#e6ddc9;text-align:center';
    const q = kind === 'town' ? 'Вернуться в город?' : 'Спуск на след. этаж?';
    box.innerHTML = `<div style="margin-bottom:8px">${q} <b class="tally">1/1</b></div>
      <button data-v="1" style="margin:0 4px;padding:6px 14px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Принять</button>
      <button data-v="0" style="margin:0 4px;padding:6px 14px;background:#421;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Отмена</button>`;
    root.appendChild(box);
    this.voteBox = box;
    void by;
    box.querySelector('[data-v="1"]')!.addEventListener('click', () => this.app.net.send({ t: 'vote', accept: true }));
    box.querySelector('[data-v="0"]')!.addEventListener('click', () => this.app.net.send({ t: 'vote', accept: false }));
  }
  private closeVote(): void { this.voteBox?.remove(); this.voteBox = undefined; }

  override update(_t: number, delta: number): void {
    if (!this.player || !this.driver) return;
    this.player.update(this.input.activePointer, this.cameras.main);
    this.driver.update(delta);
    if (this.area === 'dungeon' && this.fog) this.fog.update(this.player.x, this.player.y, delta);
    this.updateInteractions();
  }

  private updateInteractions(): void {
    let near: Interactable | undefined; let best = Infinity;
    for (const it of this.interactables) {
      const d = Phaser.Math.Distance.Between(this.player!.x, this.player!.y, it.x, it.y);
      if (d <= it.radius && d < best) { near = it; best = d; }
    }
    if (near && this.prompt) {
      this.prompt.setText(`[E] ${near.label}`).setPosition(near.x - 30, near.y - 40).setVisible(true);
      if (Phaser.Input.Keyboard.JustDown(this.eKey)) near.run();
    } else this.prompt?.setVisible(false);
  }

  private cleanup(): void {
    this.driver?.destroy();
    this.fog?.destroy();
    this.hideLobby();
    this.hideResumePrompt();
    this.hideConnecting();
    this.closeVote();
    this.closeDeathModal();
    this.codeLabel?.remove();
    this.codeLabel = undefined;
  }
}
