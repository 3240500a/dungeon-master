import { randomUUID } from 'node:crypto';
import type { GameConn } from './conn.js';
import {
  GameSession, spawnPacksEl, townLayout, arenaLayout, serializeWorld, floorInit, peerInfoOf, SnapshotDelta, worldChecksum, encodeWorldFrame, snapshotToDelta, WIRE_FULL, WIRE_DELTA,
  generateRunPlan, generateFloor, decorSpecsFor, obstaclesFromDecor, resolveMonsterPool, effectiveLevel,
  generateItem, itemFromBaseId, createRng,
  buyItem, sellItem, forgeUpgrade, forgeReroll, equip, unequip, allocAttr, respec, respecPassives, respecSkills, allocActive, allocPassive, applyConsumable, moveToBelt, moveInventoryItem, setBinding,
  stashMove, stashDims, stashTabCount,
  ensureMainQuest, generateBoard, acceptQuest, turnInQuest, trackObjective, trackFloor,
  isDifficultyUnlocked, applyDeathPenalty,
  PROTOCOL_VERSION,
  type ConfigRegistry, type PlayerInput, type Item, type SaveState, type SessionEvent,
  type FloorInit, type PeerInfo, type ServerFrame, type TownCommand, type QuestDef,
  type DecorObject, type RunConfig, type RunPlan, type AccountStash,
} from '@dm/shared';
import { putCharacter, putCharacterWithStash } from '../db/db.js';
import { tickScheduler, TICK_MS, type Tickable } from './scheduler.js';
import { counters } from './metrics.js';
import { loadAccountStash, saveAccountStash } from './accountStash.js';
import { cmdAllowedIn, CommandDedup } from './guard.js';

const TICK_DT = TICK_MS / 1000;
/**
 * Ф1.5: частота СНАПШОТОВ развязана с частотой симуляции. Мир считается 30 раз в секунду
 * (иначе меняется физика боя), а состояние рассылается 20 — цена кадра не зависит от его
 * размера, поэтому расход транспорта линеен по числу отправок, и треть из них лишняя:
 * клиент всё равно рисует чужие сущности с интерполяцией в прошлом (INTERP_DELAY 100 мс,
 * то есть два интервала при 20 Гц — запаса хватает).
 *
 * Меняется переменной `DM_SNAPSHOT_HZ` — на случай, если понадобится вернуть 30 Гц без сборки.
 */
const SNAPSHOT_HZ = Math.max(5, Math.min(30, Number(process.env.DM_SNAPSHOT_HZ ?? 20)));
const SNAPSHOT_DT = 1 / SNAPSHOT_HZ;
/** Как часто слать ПОЛНЫЙ кадр вместо дельты — страховка от расхождения (Ф1.3). */
const FULL_SNAPSHOT_MS = 5_000;
/**
 * Ф1.2: РАДИУС ОБЛАСТИ ИНТЕРЕСА в игровых пикселях (TILE=32, то есть 1000 ≈ 31 клетка).
 * Клиент получает только то, что рядом. Это одновременно трафик и античит: сегодня клиент
 * знает про ВСЕХ монстров этажа, и никакой обфускацией это не закрыть — веб-клиент открыт.
 *
 * Значение подобрано с запасом относительно экрана; уменьшать — только с проверкой глазами,
 * иначе монстры начнут появляться на виду. `DM_AOI_RADIUS=0` выключает фильтрацию целиком.
 */
const AOI_RADIUS = Math.max(0, Number(process.env.DM_AOI_RADIUS ?? 1000));
/** Выход из области шире входа: без гистерезиса сущности на кромке мигали бы каждый кадр. */
const AOI_EXIT_MULT = 1.2;
/** Отладка провода (Ф1.4): дублировать кадр текстом для точной сверки. Только для стенда. */
const WIRE_VERIFY = process.env.DM_WIRE_VERIFY === '1';
const AUTOSAVE_MS = 10_000; // периодический сброс прогресса в БД — рестарт/краш теряет ≤10с
const SHOP_CONSUMABLES = ['minor-healing-potion', 'healing-potion', 'mana-potion', 'antidote'];
const ARENA_SIZE = 20;              // круглый PvP-зал ARENA_SIZE×ARENA_SIZE клеток
const ARENA_IMMUNE_MS = 2_000;      // спавн-иммунитет игрока в арене (мс)
const ARENA_RESPAWN_MS = 3_000;     // задержка авто-возрождения после гибели в арене (мс)

interface Client {
  /** Получил ли клиент полный кадр (Ф1.3). До этого дельты ему бессмысленны. */
  baselined: boolean;
  /** Базис дельт ЭТОГО клиента (Ф1.2: у каждого свой вид мира, значит и свой базис). */
  delta: SnapshotDelta;
  /** Монстры в его поле зрения: вход в набор = отправка определения (Ф1.2). */
  visible: Set<number>;
  pid: string;
  ws: GameConn;
  input: PlayerInput;
  userId: string;
  /** Версия сейва в БД, которую держит эта сессия (Ф0.3). Растёт после каждой успешной записи. */
  saveVersion: number;
  /** Хвост очереди записей сейва (Ф2): записи одного персонажа идут строго друг за другом. */
  saving: Promise<void>;
  /** Номера уже выполненных команд (Ф2.5) — повтор после обрыва связи не выполняется дважды. */
  dedup: CommandDedup;
}

/** Выбор «алтаря» при старте забега (биом/шаблон/модификаторы) — из кадра `descend` города. */
type AltarConfig = { biomeId?: string; templateId?: string; modifiers?: string[] };

/** Инфо об отключённом игроке — чтобы вернуть его на ту же точку при реконнекте. */
interface Disconnected { save: SaveState; userId: string; lastPos: { x: number; y: number }; floor: number; saveVersion: number; }

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
export class Room implements Tickable {
  readonly code: string;
  private cfg: ConfigRegistry;
  private session: GameSession;
  private seed: number;
  private difficultyId = 'normal';
  private area: 'town' | 'dungeon' | 'arena' = 'town';
  private depth = 0;
  /** PvP-арена: точки спавна (противоположные концы) + возрождения по pid, deadline'ы возрождения (serverTime). */
  private arenaSpawns: { x: number; y: number }[] = [];
  private arenaSpawnByPid = new Map<string, { x: number; y: number }>();
  private arenaRespawns = new Map<string, number>();
  private decor: DecorObject[] = [];
  private clients = new Map<string, Client>();
  private shop: Item[] = [];
  private questBoard: QuestDef[] = [];
  private wipeAt = 0; // serverTime авто-возврата в город после вайпа пати (0 = не запланирован)
  // Ф0.10: у каждой комнаты своя фаза автосейва. Иначе все комнаты, созданные примерно
  // одновременно, сохраняются в один и тот же оборот цикла — сотня синхронных записей подряд.
  private lastSaveAt = Date.now() - Math.floor(Math.random() * AUTOSAVE_MS);
  /** Накопитель времени до следующего снапшота (Ф1.5). Стартовая фаза случайна — как у автосейва. */
  private snapAcc = Math.random() * SNAPSHOT_DT;
  /** Когда в последний раз слали ПОЛНЫЙ кадр — страховка от расхождения (Ф1.3). */
  private lastFullAt = 0;
  private vote: { kind: 'descend' | 'town' | 'arena'; diffId?: string; targetNodeId?: string; finish?: boolean; runCfg?: AltarConfig; yes: Set<string>; no: Set<string> } | null = null;
  // Активный забег v2: конфиг (сид/биом/шаблон/тир), регенерируемый граф и текущий узел.
  private runConfig: RunConfig | null = null;
  private runPlan: RunPlan | null = null;
  private runNodeId: string | null = null;
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
    tickScheduler.add(this);
  }

  get size(): number { return this.clients.size; }

  // ── Игроки ──────────────────────────────────────────────────────────────────
  // Личность/владение персонажем проверяет `roomManager` (сессия+charId), сюда приходит уже
  // авторитетный сейв владельца `userId` — комната лишь ведёт игру и персистит.
  addPlayer(ws: GameConn, userId: string, save: SaveState, version: number): string {
    return this.attach(ws, userId, save, version);
  }

  /** Вход + немедленное ПРОДОЛЖЕНИЕ сохранённого забега (реконнект БЕЗ грейс-комнаты: комната истекла или
   *  разрыв был в городе, но `save.run` цел). Граф регенерится из `save.run.config`, входим в текущий узел. */
  addPlayerResumeRun(ws: GameConn, userId: string, save: SaveState, version: number): string {
    const pid = this.attach(ws, userId, save, version);
    if (save.run) this.resumeRun(save);   // регенерит runPlan из config и enterNode(currentNodeId) → тот же этаж
    return pid;
  }

  /**
   * Реконнект отключённого игрока (по charId) — возврат в ЭТУ комнату. Позиция: та же точка,
   * если пати ещё на том же этаже; если без него спустились дальше — начало текущего этажа.
   * Снимаем паузу (соло) и отменяем грейс-таймер.
   */
  reconnect(ws: GameConn, userId: string, save: SaveState, version: number): string {
    const info = this.disconnected.get(save.charId);
    this.disconnected.delete(save.charId);
    this.hooks.onUngrace(save.charId);
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    tickScheduler.add(this); // снять паузу (соло) — планировщик игнорит повторный add
    const spawnAt = info && info.floor === this.depth ? info.lastPos : undefined; // тот же этаж → та же точка
    return this.attach(ws, userId, save, version, spawnAt);
  }

  /** Общий путь входа/реконнекта: добавить игрока (опц. в заданную точку) и разослать кадры. */
  private attach(ws: GameConn, userId: string, save: SaveState, version: number, spawnAt?: { x: number; y: number }): string {
    // Дедуп по charId: если этот персонаж уже активен (реконнект при ещё не разорванном старом ws —
    // TCP держит мёртвый коннект до heartbeat/таймаута), выселяем СТАРУЮ сущность БЕЗ грейса — иначе
    // в комнате два «меня» (тот самый баг «игра думает что нас трое»). Ровно один энтити на charId.
    for (const [oldPid, oc] of this.clients) {
      const op = this.session.world.players[oldPid];
      if (!op || op.save.charId !== save.charId) continue;
      oc.ws.close(4001, 'replaced');
      this.session.removePlayer(oldPid);
      this.clients.delete(oldPid);
      this.broadcast({ t: 'peerLeft', id: oldPid });
      if (this.vote) { this.vote.yes.delete(oldPid); this.vote.no.delete(oldPid); }
      break; // на charId максимум один активный
    }
    if (this.disconnected.has(save.charId)) { this.disconnected.delete(save.charId); this.hooks.onUngrace(save.charId); }

    const pid = `p_${randomUUID()}`;
    this.clients.set(pid, { pid, ws, input: idleInput(), userId, saveVersion: version, saving: Promise.resolve(), dedup: new CommandDedup(), baselined: false, delta: new SnapshotDelta(), visible: new Set() });
    this.session.addPlayer(pid, save, spawnAt);
    ensureMainQuest(this.cfg, save); // свежему персонажу — первый квест цепочки (до кадра joined)
    void this.persist(pid); // фиксируем на входе (reconnect найдёт запись)
    this.send(ws, {
      t: 'joined', v: PROTOCOL_VERSION, playerId: pid, roomCode: this.code,
      floor: this.currentFloorInit(), peers: this.peerList(), save,
    });
    if (this.area === 'town') this.send(ws, { t: 'shop', items: this.shop });
    if (this.runPlan && this.runNodeId) this.send(ws, { t: 'runPlan', plan: this.runPlan, currentNodeId: this.runNodeId });
    this.send(ws, { t: 'questBoard', quests: this.questBoard });
    this.broadcastExcept(pid, { t: 'peerJoined', peer: this.peerInfo(pid) });
    return pid;
  }

  removePlayer(pid: string): void {
    const p = this.session.world.players[pid];
    const c = this.clients.get(pid);
    if (p && c) {
      void this.persist(pid); // персист прогресса
      // Грейс-реконнект — ТОЛЬКО из подземелья: тело убираем из мира (монстры не бьют «пустого»),
      // ждём возврата в ту же точку. В городе выход = чистый разрыв (реконнекта нет, ждать нечего).
      if (this.area === 'dungeon') {
        this.disconnected.set(p.save.charId, { save: p.save, userId: c.userId, lastPos: { ...p.pos }, floor: this.depth, saveVersion: c.saveVersion });
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
      void this.persistDisconnected(charId, info);
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
    tickScheduler.remove(this);
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
      void this.persistDisconnected(charId, info);
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
  private persistAll(): Promise<unknown> {
    const all: Promise<boolean>[] = [];
    for (const [pid, c] of this.clients) {
      const p = this.session.world.players[pid];
      if (p) all.push(this.persist(c.pid));
    }
    this.lastSaveAt = Date.now();
    return Promise.all(all);
  }

  /**
   * Принудительно сохранить прогресс всех игроков — для graceful shutdown сервера.
   * Ф2: ЖДАТЬ ОБЯЗАТЕЛЬНО. Раньше запись была синхронной и `process.exit` сразу после вызова
   * был безопасен; с Postgres выход без ожидания просто выбросил бы незаписанные сейвы.
   */
  flush(): Promise<unknown> { return this.persistAll(); }

  setInput(pid: string, input: PlayerInput): void {
    const c = this.clients.get(pid);
    if (c) c.input = input;
  }

  // ── Команды города ──────────────────────────────────────────────────────────
  async handleCmd(pid: string, command: TownCommand, id?: number): Promise<void> {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (!c || !p) return;

    // Ф2.5: повтор уже выполненной команды. Молча пропускаем, но сейв клиенту дошлём —
    // повтор случается как раз тогда, когда клиент не уверен, что дошло, и ему нужен ответ.
    if (!c.dedup.accept(id)) {
      counters.cmdDuplicate++;
      this.sendSave(pid);
      return;
    }

    // Ф3.1: городская команда, присланная не из города. Честный клиент такого не шлёт —
    // лавка, кузница и сундук открываются только подходом к объекту города.
    if (!cmdAllowedIn(command.cmd, this.area)) {
      counters.cmdOutOfPlace++;
      console.warn(`[room ${this.code}] команда «${command.cmd}» вне города (область ${this.area}), игрок ${p.save.charId}`);
      this.send(c.ws, { t: 'error', code: 'cmd', msg: 'Это доступно только в городе' });
      return;
    }

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
      case 'stashOpen': await this.sendStash(pid); r = { ok: true }; break;
      case 'stashMove': {
        // Ф0.4: сейв и сундук пишутся ОДНОЙ транзакцией прямо здесь. Раньше сундук уходил в базу
        // сразу, а инвентарь — только следующим автосейвом (до 10 с): падение в этом окне давало
        // предмет и там, и там. Если транзакция не прошла — откатываем перенос в памяти тоже,
        // иначе разъедется уже оперативное состояние.
        const stash = await loadAccountStash(c.userId, this.cfg);
        const before = JSON.stringify(save.inventory);
        r = stashMove(this.cfg, save, stash, command.uid, command.dst, command.x, command.y);
        if (r.ok) {
          if (await this.persist(pid, stash)) await this.sendStash(pid);
          else {
            save.inventory = JSON.parse(before) as typeof save.inventory;
            r = { ok: false, reason: 'Не удалось сохранить перемещение, попробуйте ещё раз' };
          }
        }
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
    // Ф1.1: успешная команда города могла сменить экипировку/уровень/максимум HP — значит
    // статика устарела. Команды редки, поэтому шлём без всякой хитрости.
    else this.broadcastPeerInfo();
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
  /** Вход в PvP-арену из города (через алтарь) — голосование, затем круглый зал с уроном игрок↔игрок. */
  enterArena(pid: string): void {
    if (this.vote || this.area !== 'town') return; // арена только из города
    this.vote = { kind: 'arena', yes: new Set([pid]), no: new Set() };
    this.broadcast({ t: 'voteStart', kind: 'arena', by: pid, needed: this.clients.size });
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
      if (v.kind === 'arena') { this.enterArenaFloor(); return; }
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
    const biomes = this.cfg.get('biomes');
    const biome = biomes.find((b) => b.id === node.biomeId) ?? biomes[0]!;
    const decorSpecs = decorSpecsFor(this.cfg.get('objects'), this.cfg.get('models'), biome.id);   // напольный декор биома (role decor/prop)
    const layout = generateFloor(node.floorSpec, this.cfg.get('room-prefabs'), decorSpecs);
    this.decor = layout.decor;
    const obstacles = obstaclesFromDecor(layout.decor, new Map(decorSpecs.map((s) => [s.id, s])));   // суб-тайл-коллизия
    const pool = resolveMonsterPool(biome, node.depth);
    const hostSave = this.firstSave();
    const el = hostSave ? effectiveLevel(hostSave, this.cfg.get('balance').power).total : 1;
    const rng = createRng((node.floorSpec.seed >>> 0) || 1);
    const monsters = spawnPacksEl(this.cfg, layout, node.depth, this.difficultyId, rng, el, pool, node.floorSpec.packDensity, node.floorSpec.floorId);
    this.session.enterFloor(node.depth, {
      grid: layout.grid, spawn: layout.spawn, exits: layout.exits, monsters, obstacles,
      doors: layout.doors, levers: layout.levers,
      runNodeId: nodeId, runNodeType: node.type, floorModifiers: node.floorSpec.modifiers, biomeId: biome.id,
    });
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcastPeerInfo();
    this.resetDeltaBaseline(); // Ф1.3: мир заменён — прошлый базис к нему не применим
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
    this.broadcastPeerInfo();
    this.resetDeltaBaseline(); // Ф1.3: мир заменён — прошлый базис к нему не применим
    this.broadcast({ t: 'shop', items: this.shop });
    this.broadcastQuestBoard();
    for (const pid of this.clients.keys()) this.sendSave(pid); // город мог выдать main-квест
    this.persistAll(); // чекпойнт: возврат в город
  }
  /**
   * PvP-арена: круглый зал, урон игрок↔игрок, монстров нет. Игроки расставлены по
   * противоположным концам со спавн-иммунитетом; смерть без штрафа + авто-возрождение.
   * Выход — «В город» (returnTown), как из подземелья.
   */
  private enterArenaFloor(): void {
    this.wipeAt = 0;
    this.area = 'arena'; this.depth = 0; this.decor = [];
    this.arenaRespawns.clear(); this.arenaSpawnByPid.clear();
    const a = arenaLayout(ARENA_SIZE);
    this.arenaSpawns = a.spawns;
    this.session.enterFloor(0, { grid: a.grid, spawn: a.spawns[0]!, monsters: [], pvp: true });
    let i = 0;
    for (const pid of this.clients.keys()) {                 // по противоположным концам + иммунитет
      const at = a.spawns[i % a.spawns.length]!;
      this.arenaSpawnByPid.set(pid, at);
      this.session.respawnPlayer(pid, at, ARENA_IMMUNE_MS);
      i++;
    }
    this.broadcast({ t: 'areaChanged', floor: this.currentFloorInit() });
    this.broadcastPeerInfo();
    this.resetDeltaBaseline(); // Ф1.3: мир заменён — прошлый базис к нему не применим
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
  /**
   * Один фиксированный шаг симуляции. Зовёт `tickScheduler`; `emit=false` на промежуточных
   * шагах догона — тогда мир продвигается, но снапшот не рассылается (клиенту нужно актуальное
   * состояние, а не история промежуточных шагов). События рассылаются всегда: они редкие,
   * мелкие и терять их нельзя.
   */
  step(emit = true): void {
    const inputs: Record<string, PlayerInput> = {};
    for (const [pid, c] of this.clients) inputs[pid] = c.input;
    const events = this.session.tick(TICK_DT, inputs);
    counters.ticks++;
    // Снапшот шлём по СВОЕЙ частоте (Ф1.5) и только на последнем шаге пачки догона (Ф0.2):
    // промежуточные состояния клиенту не нужны, ему нужно актуальное.
    this.snapAcc += TICK_DT;
    if (this.snapAcc >= SNAPSHOT_DT) {
      this.snapAcc -= SNAPSHOT_DT;
      if (this.snapAcc > SNAPSHOT_DT) this.snapAcc = 0; // сильно отстали — не копим долг кадров
      if (emit) this.emitWorld();
    }
    if (Date.now() - this.lastSaveAt >= AUTOSAVE_MS) this.persistAll(); // периодический автосейв прогресса
    if (this.wipeAt && Date.now() >= this.wipeAt) this.enterTown(); // вайп → авто-возврат в город
    if (this.area === 'arena' && this.arenaRespawns.size) this.tickArenaRespawns(); // авто-возрождение в PvP
    if (!events.length) return;

    const touched = new Set<string>();
    const quest: SessionEvent[] = [];
    for (const e of events) {
      if (e.type === 'gold' || e.type === 'xp' || e.type === 'levelup' || e.type === 'item-picked') touched.add(e.playerId);
      if (e.type === 'monster-died' && e.by) this.track(e.by, 'kill', e.def.id, touched, quest);
      else if (e.type === 'item-picked') this.track(e.playerId, 'collect-item', e.item.baseId, touched, quest);
      else if (e.type === 'player-died') { if (this.area === 'arena') this.onArenaDeath(e.playerId); else this.onPlayerDeath(e.playerId, touched); }
    }
    this.broadcast({ t: 'events', events: quest.length ? [...events, ...quest] : events });
    for (const pid of touched) this.sendSave(pid);
    if (events.some((e) => e.type === 'levelup')) { this.persistAll(); this.broadcastPeerInfo(); } // левелап — фиксируем в БД и обновляем статику (макс. HP)
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

  /** Гибель в PvP-арене: без штрафа, окно «наблюдения» + авто-возрождение через ARENA_RESPAWN_MS. */
  private onArenaDeath(pid: string): void {
    const c = this.clients.get(pid);
    if (!c) return;
    this.send(c.ws, { t: 'died', goldLost: 0, itemsLost: 0, toTown: false, pvp: true });
    this.arenaRespawns.set(pid, Date.now() + ARENA_RESPAWN_MS);
  }
  /** Тик авто-возрождений арены: воскрешает игроков, чей таймер истёк, на их конце со спавн-иммунитетом. */
  private tickArenaRespawns(): void {
    const now = Date.now();
    for (const [pid, at] of [...this.arenaRespawns]) {
      if (now < at) continue;
      this.arenaRespawns.delete(pid);
      const p = this.session.world.players[pid];
      if (!p) continue;                          // игрок вышел — просто снимаем таймер
      const spawn = this.arenaSpawnByPid.get(pid) ?? this.arenaSpawns[0];
      if (spawn) this.session.respawnPlayer(pid, spawn, ARENA_IMMUNE_MS);
    }
  }

  /**
   * ЕДИНСТВЕННАЯ точка записи сейва живого игрока (Ф0.3). Предъявляет версию, которую держит
   * эта сессия, и запоминает новую. Отказ означает, что нашу копию кто-то обогнал — на исправном
   * сервере такого быть не может (реестр живых сессий это исключает), поэтому шумим в лог.
   *
   * `stash` — если передан, сейв и сундук пишутся ОДНОЙ транзакцией (Ф0.4).
   */
  private persist(pid: string, stash?: AccountStash): Promise<boolean> {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (!c || !p) return Promise.resolve(false);
    // ОЧЕРЕДЬ НА ПЕРСОНАЖА. Запись стала асинхронной (Ф2), а версия сейва — это счётчик,
    // который надо прочитать, предъявить и обновить. Две записи внахлёст предъявили бы одну
    // и ту же версию: вторая гарантированно получила бы отказ и потеряла бы свои изменения.
    // Поэтому записи одного клиента идут строго друг за другом.
    const run = async (): Promise<boolean> => {
      const next = stash
        ? await putCharacterWithStash(p.save.charId, c.userId, p.save, c.saveVersion, stash)
        : await putCharacter(p.save.charId, c.userId, p.save, c.saveVersion);
      if (next === null) {
        counters.saveConflicts++;
        console.error(`[room ${this.code}] ОТКЛОНЁН устаревший сейв ${p.save.charId} (версия ${c.saveVersion}) — этот процесс держит копию, которую кто-то обогнал`);
        return false;
      }
      c.saveVersion = next;
      return true;
    };
    const next = c.saving.then(run, run);   // отказ прошлой записи не должен рвать очередь
    c.saving = next.then(() => undefined, () => undefined);
    return next;
  }

  /** То же для отключённого игрока (грейс): у него своя копия сейва и своя версия. */
  private async persistDisconnected(charId: string, info: Disconnected): Promise<boolean> {
    const next = await putCharacter(charId, info.userId, info.save, info.saveVersion);
    if (next === null) {
      counters.saveConflicts++;
      console.error(`[room ${this.code}] ОТКЛОНЁН устаревший сейв отключённого ${charId} (версия ${info.saveVersion})`);
      return false;
    }
    info.saveVersion = next;
    return true;
  }

  /**
   * Сбросить базисы дельт (Ф1.3): следующий кадр уйдёт ПОЛНЫМ всем клиентам.
   * Заодно забываем, кого клиент видел — на новом этаже монстры другие.
   */
  private resetDeltaBaseline(): void {
    for (const c of this.clients.values()) {
      c.delta.reset();
      c.baselined = false;
      c.visible.clear();
    }
  }

  /**
   * Разослать состояние мира. С Ф1.2 вид у каждого клиента СВОЙ: сущности за радиусом
   * области интереса ему не отправляются вовсе. Значит и базис дельт (Ф1.3) персональный.
   *
   * Порядок на клиента: сначала определения монстров, ВОШЕДШИХ в поле зрения (`monsterInfo`),
   * потом сам кадр — иначе клиент получит id монстра, про которого ничего не знает, и молча
   * его пропустит.
   */
  private emitWorld(): void {
    if (this.clients.size === 0) return;
    const snap = serializeWorld(this.session.world);
    const now = Date.now();
    const forceFull = now - this.lastFullAt >= FULL_SNAPSHOT_MS;
    if (forceFull) this.lastFullAt = now;

    let bytes = 0;
    let sent = 0;
    for (const c of this.clients.values()) {
      if (!c.ws.open) continue;
      const view = this.viewFor(snap, c);

      // Определения монстров, вошедших в поле зрения (и повторно вошедших: клиент сносит куклу,
      // когда монстр пропадает из кадра, поэтому при возврате определение нужно снова).
      const fresh = view.monsters.filter((m) => !c.visible.has(m.id));
      if (fresh.length) {
        const live = new Map(this.session.world.monsters.map((m) => [m.id, m]));
        const info = fresh
          .map((m) => live.get(m.id))
          .filter((m): m is NonNullable<typeof m> => !!m)
          .map((m) => ({ id: m.id, def: m.def, x: m.pos.x, y: m.pos.y }));
        if (info.length) { const msg = JSON.stringify({ t: 'monsterInfo', monsters: info } satisfies ServerFrame); c.ws.send(msg); bytes += msg.length; }
      }
      c.visible = new Set(view.monsters.map((m) => m.id));

      // Ф1.4: кадры мира уходят ДВОИЧНЫМИ. GameConn сам различает текст и бинарь, поэтому
      // управляющие кадры остаются JSON и своего поля типа не требуют.
      const sum = worldChecksum(view);
      // Отладка провода: рядом с двоичным кадром шлём эталон ТОГО ЖЕ тика текстом, чтобы
      // диагностика могла сравнить поле за полем. Только по явной переменной окружения.
      if (WIRE_VERIFY) c.ws.send(JSON.stringify({ t: 'snapshot', snap: view } satisfies ServerFrame));
      if (!c.baselined || forceFull) {
        const buf = encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(view), sum });
        c.ws.send(buf);
        c.delta.prime(view);
        c.baselined = true;
        bytes += buf.length;
      } else {
        const buf = encodeWorldFrame({ kind: WIRE_DELTA, delta: c.delta.next(view)!, sum });
        c.ws.send(buf);
        bytes += buf.length;
      }
      sent++;
    }
    counters.snapshotFrames += sent;
    counters.snapshotBytes += bytes;
  }

  /**
   * Персональный вид мира для клиента (Ф1.2). Игроки видны всегда — они нужны интерфейсу пати
   * и их единицы; монстры, дропы и снаряды режутся по радиусу. У монстров гистерезис: вход
   * по `AOI_RADIUS`, выход по нему же с запасом, иначе сущность на кромке мигала бы каждый кадр
   * и гоняла бы определения туда-сюда.
   */
  private viewFor(snap: ReturnType<typeof serializeWorld>, c: Client): ReturnType<typeof serializeWorld> {
    const p = this.session.world.players[c.pid];
    if (!p || AOI_RADIUS <= 0) return snap;
    const px = p.pos.x, py = p.pos.y;
    const rIn2 = AOI_RADIUS * AOI_RADIUS;
    const rOut2 = (AOI_RADIUS * AOI_EXIT_MULT) * (AOI_RADIUS * AOI_EXIT_MULT);
    const near = (x: number, y: number, r2: number): boolean => {
      const dx = x - px, dy = y - py;
      return dx * dx + dy * dy <= r2;
    };
    return {
      tick: snap.tick,
      players: snap.players,
      monsters: snap.monsters.filter((m) => near(m.x, m.y, c.visible.has(m.id) ? rOut2 : rIn2)),
      projectiles: snap.projectiles.filter((r) => near(r.x, r.y, rIn2)),
      drops: snap.drops.filter((d) => near(d.x, d.y, rIn2)),
    };
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
    tickScheduler.remove(this);
  }

  // ── Хелперы отправки ────────────────────────────────────────────────────────
  private firstSave(): SaveState | undefined {
    const pid = this.clients.keys().next().value;
    return pid ? this.session.world.players[pid]?.save : undefined;
  }
  private currentFloorInit(): FloorInit {
    // Арена рендерится клиентом как обычный этаж (грид+спавн), поэтому area → 'dungeon'.
    return floorInit(this.area === 'town' ? 'town' : 'dungeon', this.session.world, this.decor);
  }
  /** Статика игрока для кадра `peerInfo` (Ф1.1). */
  private peerInfo(pid: string): PeerInfo {
    return peerInfoOf(this.session.world.players[pid]!, this.cfg.get('items.base'));
  }
  /**
   * Статика ВСЕХ игроков комнаты, включая самого получателя: клиент сливает её со снапшотом,
   * и своя запись ему нужна ровно так же, как чужие.
   */
  private peerList(): PeerInfo[] {
    return [...this.clients.keys()].map((id) => this.peerInfo(id));
  }
  /**
   * Разослать обновлённую статику (Ф1.1). Зовётся редко: вход, успешная команда города
   * (экипировка/уровень/распределение), смена области. Держать это в каждом кадре было
   * тем же, что слать имя игрока тридцать раз в секунду.
   */
  private broadcastPeerInfo(): void {
    if (this.clients.size === 0) return;
    this.broadcast({ t: 'peerInfo', peers: this.peerList() });
  }
  private sendSave(pid: string): void {
    const c = this.clients.get(pid);
    const p = this.session.world.players[pid];
    if (c && p) this.send(c.ws, { t: 'saveUpdate', save: p.save });
  }
  /** Шлёт клиенту полный слепок его аккаунт-сундука (на stashOpen и после stashMove). */
  private async sendStash(pid: string): Promise<void> {
    const c = this.clients.get(pid);
    if (!c) return;
    const stash = await loadAccountStash(c.userId, this.cfg);
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
  private send(ws: GameConn, frame: ServerFrame): void {
    if (ws.open) ws.send(JSON.stringify(frame));
  }
  private broadcast(frame: ServerFrame): void {
    const msg = JSON.stringify(frame);
    let sent = 0;
    for (const c of this.clients.values()) if (c.ws.open) { c.ws.send(msg); sent++; }
    if (frame.t === 'snapshot') { counters.snapshotFrames += sent; counters.snapshotBytes += msg.length * sent; }
  }
  private broadcastExcept(pid: string, frame: ServerFrame): void {
    const msg = JSON.stringify(frame);
    for (const [id, c] of this.clients) if (id !== pid && c.ws.open) c.ws.send(msg);
  }
}
