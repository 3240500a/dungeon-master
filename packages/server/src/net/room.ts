import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  GameSession, generateDungeon, spawnPacks, townLayout, serializeWorld, floorInit,
  generateItem, itemFromBaseId, createRng,
  buyItem, sellItem, equip, unequip, allocAttr, respec, allocActive, allocPassive, applyConsumable, moveToBelt, moveInventoryItem, setBinding,
  ensureMainQuest, generateBoard, acceptQuest, turnInQuest, trackObjective, trackFloor,
  isDifficultyUnlocked, applyDeathPenalty,
  PROTOCOL_VERSION,
  type ConfigRegistry, type PlayerInput, type Item, type SaveState, type SessionEvent,
  type FloorInit, type PeerLite, type ServerFrame, type TownCommand, type QuestDef,
  type DecorObject,
} from '@dm/shared';
import { putCharacter } from '../db/db.js';

const TICK_MS = 1000 / 30;
const TICK_DT = TICK_MS / 1000;
const AUTOSAVE_MS = 10_000; // периодический сброс прогресса в БД — рестарт/краш теряет ≤10с
const SHOP_CONSUMABLES = ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote'];

interface Client { pid: string; ws: WebSocket; input: PlayerInput; userId: string; }

/** Инфо об отключённом игроке — чтобы вернуть его на ту же точку при реконнекте. */
interface Disconnected { save: SaveState; userId: string; lastPos: { x: number; y: number }; floor: number; }

/** Хуки комнаты в RoomManager: уничтожение + регистрация/снятие грейс-реконнекта по charId. */
interface RoomHooks {
  onEmpty: (code: string) => void;
  onGrace: (charId: string) => void;
  onUngrace: (charId: string) => void;
}

function idleInput(): PlayerInput {
  return { move: { x: 0, y: 0 }, facing: 0, attack: false, cast: null, interact: false };
}

/**
 * Комната кооп-игры = один авторитетный `GameSession` (rewards:true). Луп 30 Гц: собрать
 * ввод игроков → tick → разослать снапшот+события. Город/данж — через `enterFloor`. Команды
 * города (магазин/экип/распределение) исполняет `townActions` над авторитетным сейвом. Спуск
 * по лестнице — по голосованию (переход когда все «за»).
 */
export class Room {
  readonly code: string;
  private cfg: ConfigRegistry;
  private session: GameSession;
  private seed: number;
  private difficultyId = 'normal';
  private area: 'town' | 'dungeon' = 'town';
  private depth = 0;
  private decor: DecorObject[] = [];
  private clients = new Map<string, Client>();
  private shop: Item[] = [];
  private questBoard: QuestDef[] = [];
  private wipeAt = 0; // serverTime авто-возврата в город после вайпа пати (0 = не запланирован)
  private lastSaveAt = 0; // serverTime последнего автосейва в БД (0 = ещё не было)
  private vote: { kind: 'descend' | 'town'; diffId?: string; yes: Set<string>; no: Set<string> } | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private hooks: RoomHooks;
  /** Отключённые игроки (charId → инфо) — ждут реконнекта в эту комнату. */
  private disconnected = new Map<string, Disconnected>();
  /** Таймер грейс-окна при полностью пустой комнате (0 подключённых); null = не запущен. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(code: string, cfg: ConfigRegistry, hooks: RoomHooks) {
    this.code = code;
    this.cfg = cfg;
    this.hooks = hooks;
    this.seed = ((Date.now() & 0xffffff) >>> 0) || 1;
    this.session = new GameSession(cfg, this.seed, this.difficultyId, { rewards: true });
    this.enterTown();
    this.loop = setInterval(() => this.step(), TICK_MS);
  }

  get size(): number { return this.clients.size; }

  // ── Игроки ──────────────────────────────────────────────────────────────────
  // Личность/владение персонажем проверяет `roomManager` (сессия+charId), сюда приходит уже
  // авторитетный сейв владельца `userId` — комната лишь ведёт игру и персистит.
  addPlayer(ws: WebSocket, userId: string, save: SaveState): string {
    return this.attach(ws, userId, save);
  }

  /**
   * Реконнект отключённого игрока (по charId) — возврат в ЭТУ комнату. Позиция: та же точка,
   * если пати ещё на том же этаже; если без него спустились дальше — начало текущего этажа.
   * Снимаем паузу (соло) и отменяем грейс-таймер.
   */
  reconnect(ws: WebSocket, userId: string, save: SaveState): string {
    const info = this.disconnected.get(save.charId);
    this.disconnected.delete(save.charId);
    this.hooks.onUngrace(save.charId);
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (!this.loop) this.loop = setInterval(() => this.step(), TICK_MS); // снять паузу (соло)
    const spawnAt = info && info.floor === this.depth ? info.lastPos : undefined; // тот же этаж → та же точка
    return this.attach(ws, userId, save, spawnAt);
  }

  /** Общий путь входа/реконнекта: добавить игрока (опц. в заданную точку) и разослать кадры. */
  private attach(ws: WebSocket, userId: string, save: SaveState, spawnAt?: { x: number; y: number }): string {
    const pid = `p_${randomUUID()}`;
    this.clients.set(pid, { pid, ws, input: idleInput(), userId });
    this.session.addPlayer(pid, save, spawnAt);
    ensureMainQuest(this.cfg, save); // свежему персонажу — первый квест цепочки (до кадра joined)
    putCharacter(save.charId, userId, save); // фиксируем на входе (reconnect найдёт запись)
    this.send(ws, {
      t: 'joined', v: PROTOCOL_VERSION, playerId: pid, roomCode: this.code,
      floor: this.currentFloorInit(), peers: this.peerList(pid), save,
    });
    if (this.area === 'town') this.send(ws, { t: 'shop', items: this.shop });
    this.send(ws, { t: 'questBoard', quests: this.questBoard });
    this.broadcastExcept(pid, { t: 'peerJoined', peer: this.peerLite(pid) });
    return pid;
  }

  removePlayer(pid: string): void {
    const p = this.session.world.players[pid];
    const c = this.clients.get(pid);
    if (p && c) {
      putCharacter(p.save.charId, c.userId, p.save); // персист прогресса
      // Запоминаем для реконнекта; тело убираем из мира, чтобы монстры не били «пустого» и он
      // не погиб оффлайн. Возврат в подземелье (не в город) — «дисконнект = портал в город» не работает.
      this.disconnected.set(p.save.charId, { save: p.save, userId: c.userId, lastPos: { ...p.pos }, floor: this.depth });
      this.hooks.onGrace(p.save.charId);
    }
    this.session.removePlayer(pid);
    this.clients.delete(pid);
    this.broadcast({ t: 'peerLeft', id: pid });
    if (this.vote) { this.vote.yes.delete(pid); this.vote.no.delete(pid); this.checkVote(); }
    if (this.clients.size === 0) this.enterGrace(); // все вышли → пауза + грейс-час
  }

  /** Комната опустела: пауза симуляции (мир замирает) + грейс-таймер. Возврат — через reconnect(). */
  private enterGrace(): void {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const ms = Math.max(0, this.cfg.get('balance').reconnectGraceSec) * 1000;
    this.graceTimer = setTimeout(() => this.expireGrace(), ms);
  }

  /** Грейс истёк (никто не вернулся за час): все отключённые погибли, комната уничтожается. */
  private expireGrace(): void {
    this.finalizeDisconnectedAsDead();
    this.stop();
    this.hooks.onEmpty(this.code);
  }

  /** Отключённые считаются погибшими: полный штраф смерти + персист + снятие из грейс-карты.
   *  (следующий вход = новая комната = город со штрафом). */
  private finalizeDisconnectedAsDead(): void {
    const penalty = this.cfg.get('balance').deathPenalty;
    for (const [charId, info] of this.disconnected) {
      applyDeathPenalty(info.save, penalty);
      putCharacter(charId, info.userId, info.save);
      this.hooks.onUngrace(charId);
    }
    this.disconnected.clear();
  }

  /**
   * Сброс прогресса ВСЕХ подключённых игроков в БД. Раньше сейв писался только на входе и
   * чистом выходе — рестарт/краш сервера (в dev — `tsx watch` на каждую правку кода) терял
   * весь прогресс забега (персонаж откатывался к последнему сохранённому уровню). Вызывается
   * периодически (автосейв) и на чекпойнтах (город/смена этажа/левелап).
   */
  private persistAll(): void {
    for (const [pid, c] of this.clients) {
      const p = this.session.world.players[pid];
      if (p) putCharacter(p.save.charId, c.userId, p.save);
    }
    this.lastSaveAt = Date.now();
  }

  /** Принудительно сохранить прогресс всех игроков — для graceful shutdown сервера. */
  flush(): void { this.persistAll(); }

  setInput(pid: string, input: PlayerInput): void {
    const c = this.clients.get(pid);
    if (c) c.input = input;
  }

  // ── Команды города ──────────────────────────────────────────────────────────
  handleCmd(pid: string, command: TownCommand): void {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (!c || !p) return;
    const save = p.save;
    let r: { ok: boolean; reason?: string } = { ok: false, reason: 'неизвестная команда' };
    switch (command.cmd) {
      case 'buy': {
        const item = this.shop.find((i) => i.uid === command.uid);
        r = item ? buyItem(this.cfg, save, item) : { ok: false, reason: 'нет в ассортименте' };
        if (r.ok) { this.shop = this.shop.filter((i) => i.uid !== command.uid); this.broadcast({ t: 'shop', items: this.shop }); }
        break;
      }
      case 'sell': r = sellItem(this.cfg, save, command.uid); break;
      case 'equip': r = equip(this.cfg, save, command.uid); break;
      case 'unequip': r = unequip(this.cfg, save, command.slot); break;
      case 'allocAttr': r = allocAttr(save, command.attr); break;
      case 'respec': r = respec(this.cfg, save); break;
      case 'allocPassive': r = allocPassive(this.cfg, save, command.nodeId); break;
      case 'allocSkill': r = allocActive(this.cfg, save, command.nodeId); break;
      case 'moveBelt': r = moveToBelt(save, command.uid); break;
      case 'moveItem': r = moveInventoryItem(this.cfg, save, command.uid, command.x, command.y); break;
      case 'bind': r = setBinding(save, command.slot, command.value); break;
      case 'drop': r = this.session.dropToGround(pid, command.uid) ? { ok: true } : { ok: false, reason: 'Нет предмета' }; break;
      case 'useConsumable': r = this.useConsumable(pid, command.uid); break;
      case 'pickup': {
        const got = this.session.pickupDropById(pid, command.dropId);
        if (got) this.broadcast({ t: 'events', events: [{ type: 'item-picked', playerId: pid, item: got.item, x: got.x, y: got.y }] });
        r = got ? { ok: true } : { ok: false, reason: 'Далеко или инвентарь полон' };
        break;
      }
      case 'acceptQuest': {
        const def = this.questBoard.find((q) => q.id === command.questId);
        r = def ? acceptQuest(save, def) : { ok: false, reason: 'Нет на доске' };
        if (r.ok && def) {
          this.questBoard = this.questBoard.filter((q) => q.id !== def.id);
          this.broadcastQuestBoard();
          this.questEvent(pid, 'accepted', def.id, def.name);
        }
        break;
      }
      case 'turnInQuest': {
        const name = save.activeQuestDefs.find((d) => d.id === command.questId)?.name ?? command.questId;
        r = turnInQuest(this.cfg, save, command.questId);
        if (r.ok) this.questEvent(pid, 'turned-in', command.questId, name);
        break;
      }
    }
    if (!r.ok) this.send(c.ws, { t: 'error', code: 'cmd', msg: r.reason ?? '' });
    this.sendSave(pid);
  }

  /** Пьёт зелье из инвентаря/пояса: применяет к сущности игрока, расходует из сейва. */
  private useConsumable(pid: string, uid: string): { ok: boolean; reason?: string } {
    const p = this.session.world.players[pid];
    const snap = this.session.snapshotOf(pid);
    if (!p || !snap) return { ok: false, reason: 'нет игрока' };
    const inBelt = p.save.belt.findIndex((it) => it?.uid === uid);
    const item = inBelt >= 0 ? p.save.belt[inBelt] : p.save.inventory.find((it) => it.uid === uid);
    if (!item?.use) return { ok: false, reason: 'не расходник' };
    applyConsumable(p, item.use, snap.derived.maxHp, snap.derived.maxMana); // единый эффект
    // расход
    if (inBelt >= 0) p.save.belt[inBelt] = null;
    else { const i = p.save.inventory.findIndex((it) => it.uid === uid); if (i >= 0) p.save.inventory.splice(i, 1); }
    return { ok: true };
  }

  // ── Голосование за спуск ────────────────────────────────────────────────────
  descend(pid: string, difficultyId?: string): void {
    if (this.vote) return;
    // Сложность выбирают только из города (портал), и лишь разблокированную для инициатора.
    const diffId = this.area === 'town' ? this.validDifficulty(pid, difficultyId) : undefined;
    this.vote = { kind: 'descend', diffId, yes: new Set([pid]), no: new Set() };
    this.broadcast({ t: 'voteStart', kind: 'descend', by: pid, needed: this.clients.size });
    this.broadcast({ t: 'voteUpdate', yes: 1, total: this.clients.size });
    this.checkVote();
  }
  /** Игрок дёрнул рычаг: сессия открывает его дверь (если рядом) → броадкаст всем. */
  pullLever(pid: string, leverId: number): void {
    const doorId = this.session.openLever(pid, leverId);
    if (doorId != null) this.broadcast({ t: 'doorOpened', doorId });
  }

  returnTown(pid: string): void {
    if (this.vote || this.area === 'town') return;
    this.vote = { kind: 'town', yes: new Set([pid]), no: new Set() };
    this.broadcast({ t: 'voteStart', kind: 'town', by: pid, needed: this.clients.size });
    this.broadcast({ t: 'voteUpdate', yes: 1, total: this.clients.size });
    this.checkVote();
  }
  /** Возвращает выбранную сложность, если она разблокирована для игрока, иначе текущую. */
  private validDifficulty(pid: string, id: string | undefined): string {
    if (!id || id === this.difficultyId) return this.difficultyId;
    const diffs = this.cfg.get('difficulties');
    const idx = diffs.findIndex((d) => d.id === id);
    const save = this.session.world.players[pid]?.save;
    if (idx >= 0 && save && isDifficultyUnlocked(diffs, idx, save.difficultyProgress)) return id;
    return this.difficultyId;
  }
  castVote(pid: string, accept: boolean): void {
    if (!this.vote) return;
    if (accept) this.vote.yes.add(pid); else this.vote.no.add(pid);
    if (this.vote.no.size > 0) { this.broadcast({ t: 'voteEnd', passed: false }); this.vote = null; return; }
    this.broadcast({ t: 'voteUpdate', yes: this.vote.yes.size, total: this.clients.size });
    this.checkVote();
  }
  private checkVote(): void {
    if (!this.vote || this.clients.size === 0) return;
    if (this.vote.yes.size >= this.clients.size) {
      const v = this.vote;
      this.vote = null;
      this.broadcast({ t: 'voteEnd', passed: true });
      if (v.kind === 'town') { this.enterTown(); return; }
      if (v.diffId) this.difficultyId = v.diffId; // применяем выбранную сложность к забегу
      this.enterDungeon(this.area === 'town' ? 1 : this.depth + 1);
    }
  }

  // ── Области ─────────────────────────────────────────────────────────────────
  private enterTown(): void {
    this.wipeAt = 0; // отменяем ожидающий вайп-таймер
    this.area = 'town'; this.depth = 0; this.decor = [];
    const t = townLayout();
    this.session.enterFloor(0, { grid: t.grid, spawn: t.spawn, monsters: [] });
    this.regenShop();
    this.questBoard = generateBoard(this.cfg, createRng(((Date.now() & 0xffffff) >>> 0) || 1));
    for (const pid of this.clients.keys()) ensureMainQuest(this.cfg, this.session.world.players[pid]!.save);
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcast({ t: 'shop', items: this.shop });
    this.broadcastQuestBoard();
    for (const pid of this.clients.keys()) this.sendSave(pid); // город мог выдать main-квест
    this.persistAll(); // чекпойнт: возврат в город
  }
  private enterDungeon(depth: number): void {
    this.wipeAt = 0;
    this.area = 'dungeon'; this.depth = depth;
    this.session.world.difficultyId = this.difficultyId; // множители наград — по выбранной сложности
    const layout = generateDungeon(this.seed, depth);
    this.decor = layout.decor;
    const hostSave = this.firstSave();
    const rng = createRng(((this.seed ^ (depth * 0x9e3779b1)) >>> 0) || 1);
    const monsters = hostSave ? spawnPacks(this.cfg, hostSave, layout, depth, this.difficultyId, rng) : [];
    this.session.enterFloor(depth, { grid: layout.grid, spawn: layout.spawn, stairs: layout.stairsDown, monsters, doors: layout.doors, levers: layout.levers });
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    // Прогресс сложности (разблокировка тиров) + квесты «достичь этажа N» (общий прогресс пати).
    const qev: SessionEvent[] = [];
    for (const pid of this.clients.keys()) {
      const s = this.session.world.players[pid]!.save;
      s.difficultyProgress[this.difficultyId] = Math.max(s.difficultyProgress[this.difficultyId] ?? 0, depth);
      for (const qid of trackFloor(s, depth).completed) qev.push(this.questCompleted(pid, s, qid));
      this.sendSave(pid);
    }
    if (qev.length) this.broadcast({ t: 'events', events: qev });
    this.persistAll(); // чекпойнт: смена этажа
  }
  private regenShop(): void {
    const itemsBase = this.cfg.get('items.base');
    const rarities = this.cfg.get('rarities');
    const tiers = this.cfg.get('item-tiers');
    const rng = createRng(((Date.now() & 0xffffff) >>> 0) || 1);
    const level = Math.max(1, this.firstSave()?.level ?? 1);
    // Случайные товары — экип по весам категорий (щиты появляются); колбы НЕ в случайных 8
    // (consumable:0), они идут гарантированным стоком SHOP_CONSUMABLES ниже.
    const shopWeights = { ...this.cfg.get('balance').loot.categoryWeights, consumable: 0 };
    this.shop = [];
    for (const id of SHOP_CONSUMABLES) for (let n = 0; n < 5; n++) { const p = itemFromBaseId(itemsBase, id); if (p) this.shop.push(p); }
    for (let i = 0; i < 8; i++) {
      this.shop.push(generateItem(itemsBase, this.cfg.get('affixes'), this.cfg.get('uniques'),
        { dropBias: 1.3, itemLevel: level + 1, tiers, rarities, categoryWeights: shopWeights }, rng));
    }
  }

  // ── Луп ─────────────────────────────────────────────────────────────────────
  private step(): void {
    const inputs: Record<string, PlayerInput> = {};
    for (const [pid, c] of this.clients) inputs[pid] = c.input;
    const events = this.session.tick(TICK_DT, inputs);
    this.broadcast({ t: 'snapshot', snap: serializeWorld(this.session.world) });
    if (Date.now() - this.lastSaveAt >= AUTOSAVE_MS) this.persistAll(); // периодический автосейв прогресса
    if (this.wipeAt && Date.now() >= this.wipeAt) this.enterTown(); // вайп → авто-возврат в город
    if (!events.length) return;

    const touched = new Set<string>();
    const quest: SessionEvent[] = [];
    for (const e of events) {
      if (e.type === 'gold' || e.type === 'xp' || e.type === 'levelup' || e.type === 'item-picked') touched.add(e.playerId);
      if (e.type === 'monster-died' && e.by) this.track(e.by, 'kill', e.def.id, touched, quest);
      else if (e.type === 'item-picked') this.track(e.playerId, 'collect-item', e.item.baseId, touched, quest);
      else if (e.type === 'player-died') this.onPlayerDeath(e.playerId, touched);
    }
    this.broadcast({ t: 'events', events: quest.length ? [...events, ...quest] : events });
    for (const pid of touched) this.sendSave(pid);
    if (events.some((e) => e.type === 'levelup')) this.persistAll(); // левелап — сразу фиксируем в БД
  }

  /**
   * Смерть игрока: штраф (часть золота + часть инвентаря), окно смерти клиенту.
   * СОЛО или вайп пати → возврат в город (все возрождаются). КООП → игрок ждёт мёртвым;
   * возродится на СЛЕДУЮЩЕМ этаже, когда пати спустится (`enterFloor` оживляет мёртвых).
   */
  private onPlayerDeath(pid: string, touched: Set<string>): void {
    const p = this.session.world.players[pid];
    const c = this.clients.get(pid);
    if (!p || !c) return;
    const summary = applyDeathPenalty(p.save, this.cfg.get('balance').deathPenalty);
    touched.add(pid); // отправить урезанные золото/инвентарь через saveUpdate

    // Соло = «вайп» на 1 игрока. Вайп → авто-возврат в город ЧЕРЕЗ таймер (окно смерти видно ~4с;
    // мгновенный enterTown закрыл бы окно тем же тиком). Кооп без вайпа → игрок ждёт, оживёт на след. этаже.
    const allDead = Object.values(this.session.world.players).every((pl) => !pl.alive);
    this.send(c.ws, { t: 'died', goldLost: summary.goldLost, itemsLost: summary.itemsLost, toTown: allDead });
    if (allDead) {
      this.wipeAt = Date.now() + 4000;
      this.finalizeDisconnectedAsDead(); // пати вайпнулась → отключённые тоже погибли, забег окончен
    }
  }

  /** Трекинг цели квеста для игрока: мутирует сейв, копит «выполнено»-события. */
  private track(pid: string, type: 'kill' | 'collect-item', target: string, touched: Set<string>, out: SessionEvent[]): void {
    const s = this.session.world.players[pid]?.save;
    if (!s) return;
    const res = trackObjective(s, type, target);
    if (!res.changed) return;
    touched.add(pid);
    for (const qid of res.completed) out.push(this.questCompleted(pid, s, qid));
  }

  stop(): void {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  // ── Хелперы отправки ────────────────────────────────────────────────────────
  private firstSave(): SaveState | undefined {
    const pid = this.clients.keys().next().value;
    return pid ? this.session.world.players[pid]?.save : undefined;
  }
  private currentFloorInit(): FloorInit {
    return floorInit(this.area, this.session.world, this.decor);
  }
  private peerLite(pid: string): PeerLite {
    const s = this.session.world.players[pid]!.save;
    return { id: pid, classId: s.classId, name: s.name };
  }
  private peerList(exclude: string): PeerLite[] {
    return [...this.clients.keys()].filter((id) => id !== exclude).map((id) => this.peerLite(id));
  }
  private sendSave(pid: string): void {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (c && p) this.send(c.ws, { t: 'saveUpdate', save: p.save });
  }
  private broadcastQuestBoard(): void {
    this.broadcast({ t: 'questBoard', quests: this.questBoard });
  }
  private questCompleted(pid: string, save: SaveState, qid: string): SessionEvent {
    const name = save.activeQuestDefs.find((d) => d.id === qid)?.name ?? qid;
    return { type: 'quest', playerId: pid, kind: 'completed', questId: qid, name };
  }
  private questEvent(pid: string, kind: 'accepted' | 'turned-in', questId: string, name: string): void {
    this.broadcast({ t: 'events', events: [{ type: 'quest', playerId: pid, kind, questId, name }] });
  }
  private send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }
  private broadcast(frame: ServerFrame): void {
    const msg = JSON.stringify(frame);
    for (const c of this.clients.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }
  private broadcastExcept(pid: string, frame: ServerFrame): void {
    const msg = JSON.stringify(frame);
    for (const [id, c] of this.clients) if (id !== pid && c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }
}
