import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  GameSession, spawnPacksEl, townLayout, serializeWorld, floorInit,
  generateRunPlan, generateFloor, resolveMonsterPool, effectiveLevel,
  generateItem, itemFromBaseId, createRng,
  buyItem, sellItem, forgeUpgrade, forgeReroll, equip, unequip, allocAttr, respec, respecPassives, respecSkills, allocActive, allocPassive, applyConsumable, moveToBelt, moveInventoryItem, setBinding,
  stashMove, stashDims, stashTabCount,
  ensureMainQuest, generateBoard, acceptQuest, turnInQuest, trackObjective, trackFloor,
  isDifficultyUnlocked, applyDeathPenalty,
  PROTOCOL_VERSION,
  type ConfigRegistry, type PlayerInput, type Item, type SaveState, type SessionEvent,
  type FloorInit, type PeerLite, type ServerFrame, type TownCommand, type QuestDef,
  type DecorObject, type RunConfig, type RunPlan,
} from '@dm/shared';
import { putCharacter } from '../db/db.js';
import { loadAccountStash, saveAccountStash } from './accountStash.js';

const TICK_MS = 1000 / 30;
const TICK_DT = TICK_MS / 1000;
const AUTOSAVE_MS = 10_000; // периодический сброс прогресса в БД — рестарт/краш теряет ≤10с
const SHOP_CONSUMABLES = ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote'];

interface Client { pid: string; ws: WebSocket; input: PlayerInput; userId: string; }

/** Выбор «алтаря» при старте забега (биом/шаблон/модификаторы) — из кадра `descend` города. */
type AltarConfig = { biomeId?: string; templateId?: string; modifiers?: string[] };

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
  private vote: { kind: 'descend' | 'town'; diffId?: string; targetNodeId?: string; finish?: boolean; runCfg?: AltarConfig; yes: Set<string>; no: Set<string> } | null = null;
  // Активный забег v2: конфиг (сид/биом/шаблон/тир), регенерируемый граф и текущий узел.
  private runConfig: RunConfig | null = null;
  private runPlan: RunPlan | null = null;
  private runNodeId: string | null = null;
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

  /** Вход + немедленное ПРОДОЛЖЕНИЕ сохранённого забега (реконнект БЕЗ грейс-комнаты: комната истекла или
   *  разрыв был в городе, но `save.run` цел). Граф регенерится из `save.run.config`, входим в текущий узел. */
  addPlayerResumeRun(ws: WebSocket, userId: string, save: SaveState): string {
    const pid = this.attach(ws, userId, save);
    if (save.run) this.resumeRun(save);   // регенерит runPlan из config и enterNode(currentNodeId) → тот же этаж
    return pid;
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
    if (this.runPlan && this.runNodeId) this.send(ws, { t: 'runPlan', plan: this.runPlan, currentNodeId: this.runNodeId });
    this.send(ws, { t: 'questBoard', quests: this.questBoard });
    this.broadcastExcept(pid, { t: 'peerJoined', peer: this.peerLite(pid) });
    return pid;
  }

  removePlayer(pid: string): void {
    const p = this.session.world.players[pid];
    const c = this.clients.get(pid);
    if (p && c) {
      putCharacter(p.save.charId, c.userId, p.save); // персист прогресса
      // Грейс-реконнект — ТОЛЬКО из подземелья: тело убираем из мира (монстры не бьют «пустого»),
      // ждём возврата в ту же точку. В городе выход = чистый разрыв (реконнекта нет, ждать нечего).
      if (this.area === 'dungeon') {
        this.disconnected.set(p.save.charId, { save: p.save, userId: c.userId, lastPos: { ...p.pos }, floor: this.depth });
        this.hooks.onGrace(p.save.charId);
      }
    }
    this.session.removePlayer(pid);
    this.clients.delete(pid);
    this.broadcast({ t: 'peerLeft', id: pid });
    if (this.vote) { this.vote.yes.delete(pid); this.vote.no.delete(pid); this.checkVote(); }
    // Комната опустела: если есть кого ждать (данж-отключённые) → пауза+грейс; иначе (город) — уничтожаем.
    if (this.clients.size === 0) {
      if (this.disconnected.size > 0) this.enterGrace();
      else { this.stop(); this.hooks.onEmpty(this.code); }
    }
  }

  /**
   * Забросить забег отключённого игрока (charId): персонаж считается погибшим — полный штраф
   * смерти + персист + снятие из грейс-карты. Пустая после этого комната уничтожается.
   * Вызывается по кнопке «Забросить» и как страховка при осознанном входе в НОВУЮ комнату.
   */
  abandonAsDead(charId: string): void {
    const info = this.disconnected.get(charId);
    if (info) {
      applyDeathPenalty(info.save, this.cfg.get('balance').deathPenalty);
      putCharacter(charId, info.userId, info.save);
      this.disconnected.delete(charId);
    }
    this.hooks.onUngrace(charId);
    this.destroyIfEmpty();
  }

  /** Уничтожить комнату, если в ней никого (ни подключённых, ни ждущих реконнекта). */
  private destroyIfEmpty(): void {
    if (this.clients.size > 0 || this.disconnected.size > 0) return;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.stop();
    this.hooks.onEmpty(this.code);
  }

  /** Текущий этаж (0 = город) — для модалки «Продолжить/Забросить». */
  get currentDepth(): number { return this.depth; }

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
      case 'forgeUpgrade': r = forgeUpgrade(this.cfg, save, command.uid); break;
      case 'forgeReroll': r = forgeReroll(this.cfg, save, command.uid, createRng(((Date.now() & 0xffffff) >>> 0) || 1)); break;
      case 'equip': r = equip(this.cfg, save, command.uid); break;
      case 'unequip': r = unequip(this.cfg, save, command.slot); break;
      case 'allocAttr': r = allocAttr(save, command.attr); break;
      case 'respec': r = respec(this.cfg, save); break;
      case 'respecPassives': r = respecPassives(this.cfg, save); break;
      case 'respecSkills': r = respecSkills(this.cfg, save); break;
      case 'allocPassive': r = allocPassive(this.cfg, save, command.nodeId); break;
      case 'allocSkill': r = allocActive(this.cfg, save, command.nodeId); break;
      case 'moveBelt': r = moveToBelt(save, command.uid); break;
      case 'moveItem': r = moveInventoryItem(this.cfg, save, command.uid, command.x, command.y); break;
      case 'stashOpen': this.sendStash(pid); r = { ok: true }; break;
      case 'stashMove': {
        const stash = loadAccountStash(c.userId, this.cfg);
        r = stashMove(this.cfg, save, stash, command.uid, command.dst, command.x, command.y);
        if (r.ok) { saveAccountStash(c.userId, stash); this.sendStash(pid); } // инвентарь уедет в sendSave ниже
        break;
      }
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
  // Из города: старт/резюм забега (можно выбрать сложность-тир). В подземелье: спуск по РЕБРУ
  // графа (targetNodeId — выбор ветки на развилке); на финале (нет рёбер) — завершение забега.
  descend(pid: string, difficultyId?: string, targetNodeId?: string, runConfig?: AltarConfig): void {
    if (this.vote) return;
    if (this.area === 'town') {
      const diffId = this.validDifficulty(pid, difficultyId);
      this.vote = { kind: 'descend', diffId, runCfg: runConfig, yes: new Set([pid]), no: new Set() };
      this.broadcast({ t: 'voteStart', kind: 'descend', by: pid, needed: this.clients.size });
    } else {
      const node = this.currentNode();
      if (!node) return;
      if (node.edges.length === 0) {
        // Финал — «завершить забег» (портал в город).
        this.vote = { kind: 'descend', finish: true, yes: new Set([pid]), no: new Set() };
        this.broadcast({ t: 'voteStart', kind: 'descend', by: pid, needed: this.clients.size });
      } else {
        const target = targetNodeId && node.edges.some((e) => e.to === targetNodeId) ? targetNodeId : node.edges[0]!.to;
        const tnode = this.runPlan!.nodes.find((n) => n.id === target);
        this.vote = { kind: 'descend', targetNodeId: target, yes: new Set([pid]), no: new Set() };
        this.broadcast({ t: 'voteStart', kind: 'descend', by: pid, needed: this.clients.size, targetNodeId: target, targetNodeType: tnode?.type });
      }
    }
    this.broadcast({ t: 'voteUpdate', yes: 1, total: this.clients.size });
    this.checkVote();
  }
  /** Текущий узел забега (по runNodeId в runPlan). */
  private currentNode() {
    return this.runPlan && this.runNodeId ? this.runPlan.nodes.find((n) => n.id === this.runNodeId) : undefined;
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
    if (idx >= 0 && diffs[idx]!.enabled !== false && save && isDifficultyUnlocked(diffs, idx, save.difficultyProgress)) return id;
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
      // descend
      if (this.area === 'town') {
        if (v.diffId) this.difficultyId = v.diffId; // тир забега
        const host = this.firstSave();
        if (host?.run && this.resumeRun(host)) return; // продолжить незавершённый забег
        this.startRun(v.runCfg);
        return;
      }
      if (v.finish) { this.finishRun(); return; } // финал → город + завершение
      if (v.targetNodeId) { this.enterNode(v.targetNodeId); return; } // спуск по ветке
    }
  }

  // ── Жизненный цикл забега (v2) ───────────────────────────────────────────────
  /**
   * Стартовый RunConfig. По умолчанию — первый включённый биом/шаблон + текущий тир. Выбор алтаря
   * (`cfg`) переопределяет биом/шаблон/модификаторы, но ТОЛЬКО валидными включёнными значениями
   * (анти-чит: клиент не может подсунуть выключенный/несуществующий контент).
   */
  private buildRunConfig(cfg?: AltarConfig): RunConfig {
    const biomes = this.cfg.get('biomes').filter((b) => b.enabled !== false);
    const tpls = this.cfg.get('run-templates').filter((t) => t.enabled !== false);
    const biome = biomes.find((b) => b.id === cfg?.biomeId) ?? biomes[0] ?? this.cfg.get('biomes')[0]!;
    const tpl = tpls.find((t) => t.id === cfg?.templateId) ?? tpls[0] ?? this.cfg.get('run-templates')[0];
    // Модификаторы: только включённые, scope:'run', и (если шаблон ограничивает) из allowedModifiers.
    const runMods = this.cfg.get('run-modifiers');
    const allowed = tpl?.allowedModifiers ?? [];
    const modifiers = (cfg?.modifiers ?? []).filter((id) => {
      const m = runMods.find((r) => r.id === id);
      return !!m && m.enabled !== false && m.scope === 'run' && (allowed.length === 0 || allowed.includes(id));
    });
    // Свежий сид на КАЖДЫЙ новый забег (this.seed — сид РУМА/сима, один на сессию → все забеги были одинаковыми).
    const runSeed = ((Date.now() & 0xffffff) >>> 0) || 1;
    return { templateId: tpl?.id ?? 'default', biomeId: biome.id, tier: this.difficultyId, seed: runSeed, modifiers };
  }
  /** Начать новый забег: RunConfig (с выбором алтаря) → RunPlan → первый узел. */
  private startRun(cfg?: AltarConfig): void {
    this.runConfig = this.buildRunConfig(cfg);
    this.runPlan = generateRunPlan(this.cfg, this.runConfig);
    this.enterNode(this.runPlan.startId);
  }
  /** Продолжить забег из сейва (граф регенерится из config.seed). */
  private resumeRun(save: SaveState): boolean {
    if (!save.run) return false;
    this.runConfig = save.run.config;
    this.difficultyId = save.run.config.tier;
    this.runPlan = generateRunPlan(this.cfg, save.run.config);
    const nid = this.runPlan.nodes.some((n) => n.id === save.run!.currentNodeId) ? save.run.currentNodeId : this.runPlan.startId;
    this.enterNode(nid);
    return true;
  }
  /** Завершить забег: очистить run у всех, вернуться в город. */
  private finishRun(): void {
    for (const pid of this.clients.keys()) { const p = this.session.world.players[pid]; if (p) p.save.run = undefined; }
    this.runConfig = null; this.runPlan = null; this.runNodeId = null;
    this.enterTown();
  }
  /** Войти в узел забега: сгенерировать этаж по floorSpec, заселить по ролям/фичам, разослать кадры. */
  private enterNode(nodeId: string): void {
    if (!this.runPlan || !this.runConfig) { this.startRun(); return; }
    const node = this.runPlan.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    this.wipeAt = 0;
    this.area = 'dungeon'; this.runNodeId = nodeId; this.depth = node.depth;
    this.session.world.difficultyId = this.difficultyId;
    const layout = generateFloor(node.floorSpec, this.cfg.get('room-prefabs'));
    this.decor = layout.decor;
    const biomes = this.cfg.get('biomes');
    const biome = biomes.find((b) => b.id === node.biomeId) ?? biomes[0]!;
    const pool = resolveMonsterPool(biome, node.depth);
    const hostSave = this.firstSave();
    const el = hostSave ? effectiveLevel(hostSave, this.cfg.get('balance').power).total : 1;
    const rng = createRng((node.floorSpec.seed >>> 0) || 1);
    const monsters = spawnPacksEl(this.cfg, layout, node.depth, this.difficultyId, rng, el, pool, node.floorSpec.packDensity);
    this.session.enterFloor(node.depth, {
      grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters,
      doors: layout.doors, levers: layout.levers,
      runNodeId: nodeId, runNodeType: node.type, floorModifiers: node.floorSpec.modifiers,
    });
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcast({ t: 'runPlan', plan: this.runPlan, currentNodeId: nodeId });
    // Персист указателя забега + прогресс сложности/квестов.
    const qev: SessionEvent[] = [];
    for (const pid of this.clients.keys()) {
      const s = this.session.world.players[pid]!.save;
      const visited = [...(s.run?.visited ?? []), nodeId];
      s.run = { templateId: this.runConfig.templateId, config: this.runConfig, currentNodeId: nodeId, visited };
      s.difficultyProgress[this.difficultyId] = Math.max(s.difficultyProgress[this.difficultyId] ?? 0, node.depth);
      for (const qid of trackFloor(s, node.depth).completed) qev.push(this.questCompleted(pid, s, qid));
      this.sendSave(pid);
    }
    if (qev.length) this.broadcast({ t: 'events', events: qev });
    this.persistAll();
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
  private regenShop(): void {
    const itemsBase = this.cfg.get('items.base');
    const rarities = this.cfg.get('rarities');
    const tiers = this.cfg.get('item-tiers');
    const affixes = this.cfg.get('affixes');
    const uniques = this.cfg.get('uniques');
    const rng = createRng(((Date.now() & 0xffffff) >>> 0) || 1);
    const level = Math.max(1, this.firstSave()?.level ?? 1);
    this.shop = [];
    // Зелья/расходники — лавка (гарантированный сток, по 5 каждого).
    for (const id of SHOP_CONSUMABLES) for (let n = 0; n < 5; n++) { const p = itemFromBaseId(itemsBase, id); if (p) this.shop.push(p); }
    // Оружие/броня — кузница. Гарантируем товар в КАЖДОЙ вкладке магазина (ближний/дальний/броня):
    // N роллов на категорию по её базам (generateItem с baseId → полноценный ролл: тир/редкость/аффиксы).
    const meleeBases = itemsBase.filter((b) => b.kind === 'weapon' && b.attackType === 'melee');
    const rangedBases = itemsBase.filter((b) => b.kind === 'weapon' && b.attackType === 'ranged');
    const armorBases = itemsBase.filter((b) => b.kind === 'armor' || b.kind === 'shield' || b.kind === 'jewelry');
    const rollFrom = (pool: typeof itemsBase, count: number): void => {
      for (let i = 0; i < count && pool.length; i++) {
        this.shop.push(generateItem(itemsBase, affixes, uniques,
          { dropBias: 1.3, itemLevel: level + 1, baseId: rng.pick(pool).id, tiers, rarities, rareNames: this.cfg.get('rare-names'), maxReqTotal: this.cfg.get('balance').maxTotalRequirement }, rng));
      }
    };
    rollFrom(meleeBases, 9); rollFrom(rangedBases, 6); rollFrom(armorBases, 9);
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
  /** Шлёт клиенту полный слепок его аккаунт-сундука (на stashOpen и после stashMove). */
  private sendStash(pid: string): void {
    const c = this.clients.get(pid);
    if (!c) return;
    const stash = loadAccountStash(c.userId, this.cfg);
    const d = stashDims(this.cfg);
    this.send(c.ws, { t: 'stash', tabs: stash.tabs, cols: d.cols, rows: d.rows, tabCount: stashTabCount(this.cfg) });
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
