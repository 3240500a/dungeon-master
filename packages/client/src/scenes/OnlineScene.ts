import Phaser from 'phaser';
import { App } from '../core/app.js';
import { Player } from '../modules/movement/player.js';
import { NetDriver } from '../net/netDriver.js';
import { renderGrid } from '../world/tileWorld.js';
import { FogOfWar } from '../world/fogOfWar.js';
import { Torch } from '../world/torch.js';
import { Lighting } from '../world/lighting.js';
import { GameState } from '../core/gameState.js';
import { exitInteract } from '../modules/run/runExits.js';
import { dismissAsk } from '../ui/kit.js';
import { EntryFlow } from '../net/entryFlow.js';
import { routeToNode } from '../net/netClient.js';
import { entryScreens } from '../ui/entryScreens.js';
import { voteQuestion, type VoteStartFrame } from '../ui/voteText.js';
import { DeathWindow, type DeathDock, type DeathView } from '../ui/deathWindow.js';
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
  private torches: Torch[] = [];
  private lighting?: Lighting;
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
  /**
   * Вход в мир и потеря связи — общий с веб-3D поток (`net/entryFlow.ts`): лобби / «Продолжить», а на закрытие сокета
   * сервером (R3-25: 4009, 4001, обрыв) — плашка с причиной и переподключение без самовхода.
   */
  private entry?: EntryFlow;
  private voteBox?: HTMLElement;
  private deathBox?: HTMLElement;
  /** ⭐ R14-03: плашка «В город» вне окна смерти — окно закрыто «Смотреть», а выход у мёртвого есть (`canLeave`). */
  private deathDockBox?: HTMLElement;
  /** ⭐ R13-05: окно смерти — `ui/deathWindow.ts` (одно правило с 3D): статус той же смерти окно не строит заново. */
  private readonly deathWin = new DeathWindow({ show: (v) => this.showDeathModal(v), hide: () => this.closeDeathModal(), dock: (v) => this.showDeathDock(v) },
    { wait: 'Ожидайте: пати зачистит этаж и спустится — там вы возродитесь.', spectate: 'Смотреть за пати' });
  /** R13-14: отписка сцены от снапшотов (их же слушает драйвер — общий `off('snapshot')` снял бы и его). */
  private offSnap?: () => void;
  private codeLabel?: HTMLElement;
  private pingLabel?: HTMLElement;
  private lastPingShown = -2; // чтобы не трогать DOM каждый кадр (RTT меняется ~1/сек)
  private myId = '';

  constructor() { super('Online'); }

  create(): void {
    this.app = App.from(this);
    if (!this.app.auth || !this.app.pendingCharId) { this.scene.start('MainMenu'); return; }
    // ⭐ R6-03: без перехвата (`false`) — перехват Phaser на всю страницу и переживает сцену: E не набиралась бы в код
    // комнаты на лобби, а после ухода на вход (R4-22) — в ник и пароль.
    this.eKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E, false);
    this.prompt = this.add.text(0, 0, '', { fontSize: '14px', color: '#f0d9a8', backgroundColor: '#000000aa', padding: { x: 6, y: 3 } }).setDepth(100).setVisible(false);

    // Сцена пере-подписывается при каждом входе — снимаем прошлые обработчики (net живёт в App).
    for (const t of ['joined', 'areaChanged', 'doorOpened', 'died', 'voteStart', 'voteUpdate', 'voteEnd', 'runStatus', 'abandoned', 'error'] as const) this.app.net.off(t);
    this.app.net.clearLifecycle();

    // Сетевые обработчики области/голосования (экраны входа снимает поток входа — на тот же кадр `joined`).
    this.app.net.on('joined', (f) => {
      this.myId = f.playerId; // ВАЖНО до buildArea: иначе свой игрок рисуется как чужой
      const state = new GameState(f.save); // авторитетный сейв с сервера — истина
      state.restoreFull();
      this.app.state = state; // сеттер App.state подключает провайдеры модов
      this.buildArea(f.floor);
      this.driver?.seedPeers(f.peers);   // R2-03: статика тех, кто уже в комнате, — сразу (драйвер создаёт buildArea)
      this.showRoomCode(f.roomCode);
      this.deathWin.reset();   // R13-05: смерть прошлой сессии — не эта
    });
    this.app.net.on('areaChanged', (f) => { this.deathWin.reset(); this.buildArea(f.floor); }); // возрождение = смена области
    this.app.net.on('doorOpened', (f) => this.openDoor(f.doorId));
    this.app.net.on('died', (f) => this.deathWin.onDied(f)); // окно смерти (потери + режим возрождения); R13-05: статус — не новая смерть
    // ⭐ R13-14: ожил без смены области (авто-возрождение арены: `respawnPlayer` без `areaChanged`) — окно смерти прочь, как у 3D:
    // иначе «Вы повержены» висело над героем и глотало клики холста. ⚠ По ПРИШЕДШЕМУ снапшоту, не на кадре отрисовки: мир тикает
    // 30 Гц, снапшоты — 20, и на тике без рассылки `died` приходит раньше снапшота со смертью (последний принятый ещё «жив»).
    // Снапшоты и `died` идут одним сокетом по порядку — снапшот, пришедший после `died`, смерть уже видит.
    this.offSnap?.();
    this.offSnap = this.app.net.on('snapshot', (f) => {
      const me = f.snap.players.find((p) => p.id === this.myId);
      if (me?.alive && this.deathWin.state) this.deathWin.reset();
    });
    this.app.net.on('voteStart', (f) => this.showVote(f));
    this.app.net.on('voteUpdate', (f) => { if (this.voteBox) this.voteBox.querySelector('.tally')!.textContent = `${f.yes}/${f.total}`; });
    this.app.net.on('voteEnd', () => this.closeVote());

    // ⭐ ВХОД И ПОТЕРЯ СВЯЗИ — общий с веб-3D поток (`net/entryFlow.ts`, экраны `ui/entryScreens.ts`): открылся сокет —
    // статус забега → лобби или «Продолжить»; сервер закрыл живую сессию (R3-25: 4009, 4001, 4008, обрыв) — окна прошлой
    // области прочь, мир прошлой сессии снесён, плашка с причиной и переподключение без самовхода. Его обработчики
    // (`runStatus`/`abandoned`/`error`/`joined`, open/close) сняты строками выше и вешаются заново на КАЖДЫЙ вход в сцену.
    this.entry = new EntryFlow({
      net: this.app.net,
      who: () => ({ token: this.app.auth!.token, charId: this.app.pendingCharId! }),
      view: entryScreens(() => document.getElementById('ui-root') ?? document.body, () => this.app.gameLog?.setVisible(false)),
      // R4-36: и окна (инвентарь, кузница…) — их кнопки слали бы команды в сессию, которой нет, поверх лобби.
      onLost: () => { this.closeVote(); this.deathWin.reset(); this.driver?.resetWorld(); this.app.bus.emit('ui:closeAll', {}); },
      // ⭐ R6-25: герой в мире — только с кадра `joined` и до потери связи / выхода: вне мира хоткеи окон и [E] у NPC молчат.
      inWorld: (on) => this.app.setInWorld(on),
      replies: this.app.replies,
      log: (text) => this.app.bus.emit('log:message', { text, kind: 'system' }),
      route: routeToNode,   // R4-13: адрес ноды — у гейтвея, перед каждым подключением
      onJoined: () => void this.app.syncConfig(),   // ⭐ R5-15: деплой не перезагружает вкладку — конфиг сверяется на входе
      // R4-22: вход аккаунта недействителен — ко входу; героя нет у аккаунта — к выбору героя (лобби получило бы тот же отказ).
      // ⭐ R5-16: HUD (сцена 'UI') и окна прошлой сессии — прочь, как при выходе в меню: иначе полосы, пояс и хоткеи окон
      // (I/K/C — окна героя, которого уже нет) жили бы поверх экрана входа.
      onRejected: (code) => {
        if (this.scene.isActive('UI')) this.scene.stop('UI');
        this.app.bus.emit('ui:closeAll', {});
        if (code === 'auth') { this.app.clearAuth(); this.scene.start('Login'); return; }
        this.app.pendingCharId = null;
        this.scene.start('CharacterSelect');
      },
    });
    this.entry.attach();
    this.entry.start();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

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
    this.app.gameLog?.setVisible(true); // в мире → показать чат/лог (на экранах меню он скрыт)
    dismissAsk();   // R3-23: вопрос «разобрать здесь?» прошлой области — «нет», а не плашка над новой
    for (const o of this.worldObjs) o.destroy();
    this.worldObjs = [];
    for (const t of this.torches) t.destroy();
    this.torches = [];
    this.lighting?.destroy(); this.lighting = undefined;
    this.walls?.destroy(false); // старую группу стен (её тайлы уже были в worldObjs)
    this.fog?.destroy(); this.fog = undefined;
    this.interactables = [];
    this.doorSprites.clear(); this.leverSprites.clear();
    this.floorGrid = floor.grid;
    this.floorDoors = floor.doors;
    // ⭐ R3-24: область — и в состоянии игры: по ней инвентарь предлагает разбор в поле, а тот перепроверяет «не в
    // городе». Раньше её ставил только 3D-клиент, и в 2D-подземелье `area` навсегда оставалась 'town'.
    if (this.app.state) this.app.state.area = floor.area;
    // ⭐ R7-11: вне города окна объектов города (лавка, кузница, мастер, сундук, алтарь) закрываются (`DomUi`): открытые
    // в городе, пока хост вёл пати вниз, они слали из подземелья команды, которые сервер там не исполняет.
    this.app.bus.emit('area:entered', { area: floor.area });

    const rendered = renderGrid(this, floor.grid);
    this.walls = rendered.walls;
    this.worldObjs.push(...rendered.objects); // тайлы пола/стен — уничтожатся при следующей пересборке
    this.area = floor.area;

    // Декор (факелы — анимированные со светом; портал/лавка узла забега — интерактивные). Сундука аккаунта в подземелье
    // нет (R7-11): сервер открывает его только в городе, и генератор его на этаж не ставит.
    // Финальный узел (нет выходов) → портал завершает забег; иначе (rest) → возврат в город.
    const isFinale = floor.area === 'dungeon' && (floor.exits?.length ?? 0) === 0;
    for (const d of floor.decor) {
      if (d.kind === 'torch') { this.torches.push(new Torch(this, d.x, d.y)); continue; }
      const img = this.add.image(d.x, d.y, `decor-${d.kind}`).setDepth(d.kind === 'arena' ? -8 : 1);
      if (d.kind === 'arena') img.setAlpha(0.4);
      this.worldObjs.push(img);
      if (d.kind === 'shop') this.interactables.push({ x: d.x, y: d.y, radius: 40, label: 'Лавка', run: () => this.app.bus.emit('ui:open', { panel: 'shop' }) });
      else if (d.kind === 'portal') this.interactables.push(isFinale
        ? { x: d.x, y: d.y, radius: 44, label: 'Завершить забег (голосование)', run: () => this.app.net.send({ t: 'descend' }) }
        : { x: d.x, y: d.y, radius: 44, label: 'Вернуться в город (голосование)', run: () => this.app.net.send({ t: 'return' }) });
    }

    // Игрок-вид (создаём один раз).
    if (!this.player) {
      const cls = this.app.state!.save.classId;
      const spr = this.app.config.get('classes').find((c) => c.id === cls)?.sprite ?? `player-${cls}`;
      const tex = this.textures.exists(spr) ? spr : 'player-warrior';
      this.player = new Player(this, floor.spawn.x, floor.spawn.y, tex);
      this.driver = new NetDriver(this, this.app, this.player);
      this.cameras.main.startFollow(this.player.cameraTarget, true, 1, 1); // следим за ЯКОРЕМ (не за спрайтом): спрайт подпрыгивает при ходьбе, мир — нет. Позиция уже сглажена в netDriver
      this.cameras.main.setZoom(2.925); // ближе к игроку (было 1.95, +50%); спрайт игрока компенсирован в Player (SPRITE_SIZE), чтобы он остался прежнего размера
      if (!this.scene.isActive('UI')) this.scene.launch('UI');
    } else {
      this.player.setPos(floor.spawn.x, floor.spawn.y);
    }
    // Свой id — на КАЖДЫЙ вход: после переподключения (R3-25) он новый, и со старым свой игрок рисовался бы «чужим».
    this.driver!.setMyId(this.myId);
    this.driver!.buildMonsters(floor);
    this.driver!.resetInterpolation(); // новая область: сбросить буфер интерполяции и сглаживание своего игрока

    if (floor.area === 'dungeon') {
      const { cols, rows } = gridSize(floor.grid);
      this.fog = new FogOfWar(this, floor.grid, cols * TILE, rows * TILE);
      this.fog.revealSpawn(floor.spawn.x, floor.spawn.y);
      // Выходы на следующий узел (v2 развилка): каждый ведёт к своему ребру графа. На финале — нет выходов.
      // ⭐ C-10: подпись (see-ahead на развилке) — из плана забега в миг показа: `runPlan` приходит ПОСЛЕ этого этажа.
      const exits = floor.exits ?? (floor.stairs ? [floor.stairs] : []);
      exits.forEach((ex, i) => {
        const st = this.add.image(ex.x, ex.y, 'tile-stairs').setDepth(1);
        this.worldObjs.push(st);
        this.interactables.push(exitInteract(ex, floor, i, () => this.app.run?.plan, (k) => this.descendExit(k)));
      });
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
      this.app.state!.challengeLevel = floor.challengeLevel ?? null;   // R8-10: «вызов ур.» — как узел заселил сервер
      if (floor.difficultyId) this.app.state!.difficultyId = floor.difficultyId;
    } else {
      this.app.run = null; // город — забега нет (мог остаться от завершённого/бросенного)
      this.addTownDecor(floor);
      this.app.state!.depth = 0;
      this.app.state!.challengeLevel = null;
    }

    // Динамический свет (город и данж): тьма растёт с глубиной (конфиг balance.lighting).
    const lc = this.app.config.get('balance').lighting;
    const gs = gridSize(floor.grid);
    const ambient = Math.min(lc.ambientMax, lc.ambient + floor.depth * lc.perDepth);
    this.lighting = new Lighting(this, gs.cols * TILE, gs.rows * TILE, ambient);
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
    // Несколько факелов по общей схеме (свет + анимация), по краям площади города.
    for (const cy of [2, rows - 3]) {
      for (const cx of [Math.floor(cols * 0.2), Math.floor(cols * 0.5), Math.floor(cols * 0.8)]) {
        const p = cell(cx, cy);
        this.torches.push(new Torch(this, p.x, p.y));
      }
    }
    const pp = cell(cols - 4, rows - 4);
    const portal = this.add.image(pp.x, pp.y, 'portal').setDepth(2);
    this.worldObjs.push(portal);
    // Портал открывает выбор сложности; уже он шлёт `descend` с выбранным тиром.
    this.interactables.push({ x: pp.x, y: pp.y, radius: 44, label: 'В подземелье (выбор сложности)', run: () => this.app.bus.emit('ui:open', { panel: 'difficulty' }) });
  }

  /** Спуск через i-й выход: маппит выход на i-е ребро текущего узла (targetNodeId). Читается лениво — на момент клика граф уже актуален. */
  private descendExit(i: number): void {
    const run = this.app.run;
    const cur = run?.plan.nodes.find((n) => n.id === run.currentNodeId);
    this.app.net.send({ t: 'descend', targetNodeId: cur?.edges[i]?.to });
  }

  /**
   * Окно смерти: потери (золото/предметы) + режим возрождения. Соло/вайп → «возврат в город»
   * (окно закроется на areaChanged). Кооп → «ждите пати» + кнопка «Смотреть» (спектейт до спуска).
   * ⭐ R13-05: что показать, решает `DeathWindow` (статус той же смерти окно не строит заново); «В город» — живых подключённых нет,
   * пати ждёт отвалившегося посреди боя (`return`).
   */
  private showDeathModal(v: DeathView): void {
    this.closeDeathModal();
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:96;background:rgba(30,8,10,0.96);border:1px solid #c85a48;border-radius:12px;padding:22px 30px;color:#e6c8bd;text-align:center;min-width:280px;max-width:420px';
    box.innerHTML = `<div style="font-size:24px;margin-bottom:10px">${v.title}</div>
      ${v.loss ? `<div style="font-size:14px;color:#d9a898">${v.loss}</div>` : ''}
      <div style="font-size:13px;color:#b09088;margin-top:10px">${v.status}</div>`;
    const button = (label: string, run: () => void): void => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'margin:14px 4px 0;padding:8px 16px;background:#3a2030;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer';
      btn.addEventListener('click', run);
      box.appendChild(btn);
    };
    if (v.spectate) button(v.spectate, () => this.deathWin.dismiss());
    if (v.town) button(v.town, () => this.app.net.send({ t: 'return' }));
    root.appendChild(box);
    this.deathBox = box;
  }
  private closeDeathModal(): void { this.deathBox?.remove(); this.deathBox = undefined; }
  /**
   * ⭐ R14-03: плашка «В город» вне окна смерти (`deathDock`): окно закрыто «Смотреть», а пати ждёт отвалившегося посреди боя — статус
   * `canLeave` сервер шлёт один раз, и без плашки единственный выход не рисовался нигде (мёртвый ждал до часа). Не модалка: сверху,
   * наблюдению не мешает. `null` — убрать.
   */
  private showDeathDock(v: DeathDock | null): void {
    this.deathDockBox?.remove(); this.deathDockBox = undefined;
    if (!v) return;
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:90;background:rgba(30,8,10,0.9);border:1px solid #c85a48;border-radius:8px;padding:8px 14px;color:#e6c8bd;font-size:13px;text-align:center;max-width:420px';
    const text = document.createElement('div');
    text.textContent = v.status;
    const btn = document.createElement('button');
    btn.textContent = v.town;
    btn.style.cssText = 'margin-top:8px;padding:6px 16px;background:#3a2030;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer';
    btn.addEventListener('click', () => this.app.net.send({ t: 'return' }));
    box.append(text, btn);
    root.appendChild(box);
    this.deathDockBox = box;
  }

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
  private showVote(f: VoteStartFrame): void {
    if (this.voteBox) return;
    const root = document.getElementById('ui-root') ?? document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:88;background:#171b24;border:1px solid #6f9bcf;border-radius:8px;padding:12px 16px;color:#e6ddc9;text-align:center';
    // ⭐ R9-08: спуск из города — с тем, что начнётся (тир, шаблон, биом, модификаторы, чьё продолжение), `voteQuestion`.
    const q = voteQuestion(f, this.app.config, this.app.state?.save.difficultyProgress);
    box.innerHTML = `<div style="margin-bottom:8px">${q} <b class="tally">1/1</b></div>
      <button data-v="1" style="margin:0 4px;padding:6px 14px;background:#22301c;color:#cfe0c0;border:1px solid #8aa84a;border-radius:6px;cursor:pointer">Принять</button>
      <button data-v="0" style="margin:0 4px;padding:6px 14px;background:#421;color:#e6bcae;border:1px solid #c85a48;border-radius:6px;cursor:pointer">Отмена</button>`;
    root.appendChild(box);
    this.voteBox = box;
    box.querySelector('[data-v="1"]')!.addEventListener('click', () => this.app.net.send({ t: 'vote', accept: true }));
    box.querySelector('[data-v="0"]')!.addEventListener('click', () => this.app.net.send({ t: 'vote', accept: false }));
  }
  private closeVote(): void { this.voteBox?.remove(); this.voteBox = undefined; }

  override update(_t: number, delta: number): void {
    this.updatePing(); // индикатор RTT — до guard (виден и в лобби, как только есть соединение)
    if (!this.player || !this.driver) return;
    this.player.update(this.input.activePointer, this.cameras.main);
    this.driver.update(delta);
    if (this.area === 'dungeon' && this.fog) this.fog.update(this.player.x, this.player.y, delta);
    // Факелы (анимация) + динамический свет (лайтмап от игрока и факелов).
    const now = this.time.now;
    for (const t of this.torches) t.update(now);
    if (this.lighting) {
      const lc = this.app.config.get('balance').lighting;
      this.lighting.update(this.player.x, this.player.y, lc.playerRadius,
        this.torches.map((t) => ({ x: t.x, y: t.y, radius: lc.torchRadius * t.flicker })));
    }
    // ⭐ R6-25: под плашкой / лобби / «Продолжить» вид героя, драйвер и NPC прошлой сессии живы, а сессии нет — [E] у
    // кузницы открывал её под экраном входа, и её `stashOpen` уходил в сокет без сессии («Сундук не загрузился»).
    if (this.app.inWorld) this.updateInteractions();
    else this.prompt?.setVisible(false);
  }

  /** Индикатор пинга (RTT до сервера) — правый верх, под плашкой «Комната» (слева HUD-бар города).
   *  Перерисовываем DOM только при смене значения. */
  private updatePing(): void {
    const rtt = this.app.net.rtt;
    if (rtt === this.lastPingShown) return;
    this.lastPingShown = rtt;
    if (!this.pingLabel) {
      const root = document.getElementById('ui-root') ?? document.body;
      this.pingLabel = document.createElement('div');
      this.pingLabel.style.cssText = 'position:fixed;top:40px;right:12px;z-index:60;background:rgba(23,27,36,0.8);border:1px solid #2b323f;border-radius:6px;padding:4px 8px;color:#cfe0f2;font-size:12px;font-family:monospace;pointer-events:none';
      root.appendChild(this.pingLabel);
    }
    const c = rtt < 0 ? '#8f897c' : rtt < 60 ? '#7fdc7f' : rtt < 120 ? '#dcd07f' : rtt < 200 ? '#dcae7f' : '#dc7f7f';
    this.pingLabel.innerHTML = `ping <b style="color:${c}">${rtt < 0 ? '—' : rtt}</b> мс`;
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

  /**
   * Выход из сцены (SHUTDOWN). ⭐ R5-16: сцену запускают СНОВА (после R4-22 — вход / выбор героя → `scene.start('Online')`),
   * а Phaser на выходе уже снёс её спрайты, клавиши и камеру. Ссылки на вид героя, драйвер и область обязаны уйти вместе
   * с ними: иначе новый вход брал ветку «герой уже есть» — нового вида, драйвера, слежения камеры и зума не было, и
   * снесённый драйвер жил дальше с мёртвыми клавишами (герой невидим и не двигается до перезагрузки страницы).
   */
  private cleanup(): void {
    this.entry?.detach();   // закрытие сокета после выхода из сцены её не трогает; экраны входа сняты
    this.offSnap?.(); this.offSnap = undefined;   // R13-14: `NetClient` живёт всё приложение — снапшоты снесённой сцене не нужны
    dismissAsk();   // R3-23: вопрос в поле не переживает выход из игры
    this.app.gameLog?.setVisible(false); // выход из игры (в меню) — скрыть чат
    this.driver?.destroy(); this.driver = undefined;   // и его подписки на кадры сети (R5-16)
    this.player?.destroy(); this.player = undefined;
    this.fog?.destroy(); this.fog = undefined;
    this.walls = undefined;           // группу стен снёс физический мир сцены
    this.worldObjs = [];              // объекты сцены Phaser уже снёс
    this.interactables = [];
    this.doorSprites.clear(); this.leverSprites.clear();
    this.myId = '';
    for (const t of this.torches) t.destroy();
    this.torches = [];
    this.lighting?.destroy(); this.lighting = undefined;
    this.closeVote();
    this.deathWin.reset();
    this.codeLabel?.remove();
    this.codeLabel = undefined;
    this.pingLabel?.remove();
    this.pingLabel = undefined;
    this.lastPingShown = -2;
  }
}
