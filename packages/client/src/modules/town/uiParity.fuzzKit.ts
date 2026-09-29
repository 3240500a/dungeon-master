import { vi } from 'vitest';
import {
  ATTRIBUTES, CRAFT_SLOT_LIST, PRICE_CHANGED, addToInventory, anatomyOf, availableMaterials, canEnchantItem, craftMissing, craftWeapon, createRng,
  defaultParts, enchantCost, enchantItem, equip, familiesOf, finalAttributes, forgeGold, forgeSalvage, fullJournal, keySlotOf, keyVariantsByBase,
  legacyStartAttributes, materialItem, modifiersFromItems, normalizeJournal, offhandRefusal, parseClientFrame, repairCost, respec, salvageRange, shopBuyPrice,
  shopSellPrice, unequip, upgradeCost, variantsFor,
  type AccountStash, type ConfigRegistry, type CraftInput, type CraftJournal, type CraftParts, type EquipSlot, type Item, type Rng,
  type SaveState, type ServerFrame, type TownCommand,
} from '@dm/shared';
import { foundItem, newWorld, pristineTables, regFrom, reloadTable } from '../../../../shared/src/economy/fuzz/economyFuzz.js';
import { App, REFUSAL_REPEAT_MS } from '../../core/app.js';
import { PROTOCOL_STALE } from '../../net/entryFlow.js';
import { GameState } from '../../core/gameState.js';
import { forgeBench } from './forgeBench.js';
import { benchActions, diffStrings, type BenchAction } from './forgeActions.js';
import { cardWith, craftWindow, initialCraftState, normalizeCraftState, type CraftWindowState } from './craftPanel.js';
import { gameCraftHost, type CraftMemo, type ForgeLink } from './craftHost.js';
import { shopPanel } from './shopPanel.js';
import { forgePanel } from './forgePanel.js';
import { inventoryPanel } from '../inventory/inventoryPanel.js';
import { salvageInField } from '../inventory/disposeConfirm.js';
import { itemDescLines } from '../inventory/itemView.js';
import { PITCH, beginHold, clearHeld, getHeld } from '../inventory/heldItem.js';
import { respecAttrsButton } from '../progression/respecAttrs.js';

/**
 * ⭐ B3: ФАЗЗЕР ПАРИТЕТА «ОКНО ≡ СЕРВЕР» — модель и прогон. Состояние героя (сейв, сундук аккаунта с кошельком сырья и журналом
 * кузнеца, прилавок, конфиг с живыми правками хозяина) катится случайными шагами; на каждом шаге-окне НАСТОЯЩИЕ модули клиента
 * (верстак `forgeBench`, окно ковки `craftWindow` с игровым хозяином `gameCraftHost`, лавка `shopPanel`, «🛒 Купить» кузницы
 * `forgePanel`, меню инвентаря `inventoryPanel` → `salvageInField`, пупсик `inventoryPanel` с вещью на курсоре — R16-08) рисуются в
 * DOM-заглушку, из неё читается ТО, ЧТО ВИДИТ ИГРОК (карточка горит или погашена и почему, цена построчно, вилка выхода, урон
 * «от–до», требования, ценник прилавка, «+N» скупки, вопросы перед утратой вещи, отказ пупсика), затем кликается — и команда уходит
 * НАСТОЯЩИМ `App` / `NetClient` по проводу (как через шлюз `roomManager.frameGate`) в НАСТОЯЩУЮ `Room.handleCmd` с маленькой честной
 * базой (мок `db.ts` у теста). Кадры сервера идут обратно в клиент тем же проводом. Погашенную карточку кликнуть нельзя — её команда
 * уходит напрямую, ровно такой, какой её собрал бы клик (так проверяется «погашено ⇒ сервер откажет»).
 *
 * Инварианты (ключ нарушения — `вид:код`):
 *  (1) горит ⇒ сервер исполняет; погашено ⇒ сервер отказывает, и причина — того же рода (`parity:*`);
 *  (2) списанное = показанному: золото и сырьё построчно; согласие на цену (`maxGold`, `maxMaterials`, `minYield`, `avgYield`,
 *      `minGold`) при устаревшем конфиге клиента даёт отказ «Цена изменилась», а не лишнюю трату (`price:*`, `stale:*`);
 *  (3) вилки «от–до» (выход разбора, урон и требования ковки, предпросмотр улучшения/починки) содержат исход сервера (`range:*`,
 *      `preview:*`);
 *  (4) ни одно окно не бросает ни на каком состоянии (`ui-throw:*`), сервер не падает (`server:*`), команда клиента проходит схему
 *      комнаты (`wire:*`), и после ответа клиент видит сейв и сундук сервера (`sync:*`);
 *  (5) ⭐ R18-08: деплой со сменой КОДА цен при том же конфиге (шаг `deploy`: сервер другой сборки, вкладка переподключилась со старым
 *      бандлом) — игроку «перезагрузите» на входе (`hint:deploy-untold`) и на каждый отказ «Цена изменилась», который перечитывание конфига
 *      не лечит (`hint:silent-price-loop`: не раньше `REFUSAL_REPEAT_MS` до отказа или сразу за ним), а без деплоя — ни разу (`hint:false-reload`).
 *      ⭐ R19-02: и у 2D-клиента — нечётные сиды идут через настоящую сцену `OnlineScene` (`SceneHook`) с её пере-подпиской на кадры.
 * ⭐ R19-07: (1) — и у кнопки «Сбросить атрибуты» мастера (шаг `respec`): горит ⇒ сервер сбросил, погашена ⇒ отказал, подсказка — его причина.
 * «Строго» проверяется, только когда клиент видит то же, что сервер (конфиг, сейв, сундук); иначе — только согласие на цену.
 *
 * Шаг хранится АБСТРАКТНО (`{k, s}`): что именно он берёт — решается по состоянию в момент исполнения, поэтому сжатие
 * (`shrinkSeq`) выбрасывает шаги, и оставшиеся осмысленны. Прогон детерминирован по сиду: `Math.random` (uuid вещей), `Date.now`
 * и бросок сервера (`node:crypto` `randomInt` — подмену ставит тест через `CryptoHook`) на время цепочки сеются от сида.
 * Только для тестов.
 */

// ── DOM-заглушка ──────────────────────────────────────────────────────────────────────────────────

type Listener = (e: DomEvent) => void;
interface DomEvent { clientX: number; clientY: number; target: El; preventDefault(): void; stopPropagation(): void }

/** Узел DOM ровно в тех свойствах, которыми пользуются окна города (как в `forgeLive.test.ts`, плюс события и меню). */
export class El {
  children: El[] = [];
  style: Record<string, string> = {};
  textContent = '';
  disabled = false;
  title = '';
  colSpan = 1;
  value = '';
  dataset: Record<string, string> = {};
  parent: El | null = null;
  readonly classList = { add: (): void => {}, remove: (): void => {}, toggle: (): void => {}, contains: (): boolean => false };
  private html = '';
  private on = new Map<string, Listener[]>();
  constructor(public tag: string) { }
  get isConnected(): boolean { return true; }
  set innerHTML(v: string) { for (const c of this.children) c.parent = null; this.children = []; this.html = v; }
  get innerHTML(): string { return this.html; }
  get lastChild(): El | null { return this.children[this.children.length - 1] ?? null; }
  get firstChild(): El | null { return this.children[0] ?? null; }
  get parentElement(): El | null { return this.parent; }
  get parentNode(): El | null { return this.parent; }
  addEventListener(t: string, f: Listener): void { this.on.set(t, [...(this.on.get(t) ?? []), f]); }
  removeEventListener(t: string, f: Listener): void { this.on.set(t, (this.on.get(t) ?? []).filter((x) => x !== f)); }
  listens(t: string): boolean { return (this.on.get(t)?.length ?? 0) > 0; }
  dispatch(t: string, ev: Partial<Pick<DomEvent, 'clientX' | 'clientY'>> = {}): void {
    const e: DomEvent = { clientX: 0, clientY: 0, target: this, preventDefault: () => {}, stopPropagation: () => {}, ...ev };
    for (const f of [...(this.on.get(t) ?? [])]) f(e);
  }
  /** Клик как у браузера: погашенная кнопка его не получает. */
  click(): void { if (!this.disabled) this.dispatch('click'); }
  append(...c: (El | string)[]): void {
    for (const x of c) {
      if (typeof x === 'string') { const t = new El('#text'); t.textContent = x; this.append(t); continue; }
      if (x.parent) x.parent.children = x.parent.children.filter((y) => y !== x);   // узел переезжает, а не копируется
      x.parent = this; this.children.push(x);
    }
  }
  appendChild(c: El): El { this.append(c); return c; }
  prepend(...c: El[]): void { const was = this.children; this.children = []; this.append(...c); this.children.push(...was); }
  insertBefore(c: El, ref: El | null): El {
    if (c.parent) c.parent.children = c.parent.children.filter((y) => y !== c);
    const i = ref ? this.children.indexOf(ref) : -1;
    c.parent = this;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  replaceChildren(...c: El[]): void { for (const x of this.children) x.parent = null; this.children = []; this.append(...c); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  contains(n: unknown): boolean { return n === this || this.all().includes(n as El); }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  setAttribute(): void {}
  focus(): void {}
  querySelector(): null { return null; }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  text(): string { return [this.textContent, ...this.all().map((c) => c.textContent)].join(' | '); }
  button(label: string): El | undefined { return this.all().find((e) => e.tag === 'button' && e.textContent.includes(label)); }
}

/** Глобальные `document` / `window` / `WebSocket` на время прогона. `confirm` — вопросы города (кузница, лавка). */
export function installDom(confirm: (msg: string) => boolean): { body: El; restore: () => void } {
  const G = globalThis as Record<string, unknown>;
  const saved = { document: G.document, window: G.window, WebSocket: G.WebSocket };
  const body = new El('body');
  G.document = { createElement: (t: string) => new El(t), body, getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {} };
  G.window = { confirm, addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1600, innerHeight: 900 };
  G.WebSocket = BrowserWs;
  return {
    body,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete G[k]; else G[k] = v; }
    },
  };
}

/** Сокет браузера: провод — вызов моста; сервер отвечает через `onmessage`. */
export class BrowserWs {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static last: BrowserWs | null = null;
  static sink: (raw: string) => void = () => {};
  readyState = BrowserWs.CONNECTING;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) { BrowserWs.last = this; }
  send(raw: string): void { BrowserWs.sink(raw); }
  close(): void { this.readyState = BrowserWs.CLOSED; }
}

// ── Сервер ────────────────────────────────────────────────────────────────────────────────────────

/** Мок базы (`vi.hoisted` у теста) — та же маленькая честная база, что у `room.economyFuzz.test.ts`. */
export interface FakeDb {
  saves: Map<string, number>;
  data: Map<string, SaveState>;
  stashes: Map<string, { data: AccountStash; version: number }>;
}
/** Подмена броска сервера (`node:crypto` `randomInt`) — ставит тест своим `vi.mock`. */
export interface CryptoHook { randomInt?: (a: number, b: number) => number }

type PlayerIn = { save: SaveState; hp: number; alive: boolean };
interface RoomIn {
  shop: Item[];
  consumables: Item[];
  session: { world: { players: Record<string, PlayerIn> } };
  addPlayer(ws: unknown, userId: string, save: SaveState, version: number): string;
  handleCmd(pid: string, command: unknown, id: unknown): Promise<void>;
  stop(): void;
}
type RoomCtor = new (code: string, cfg: ConfigRegistry, hooks: object) => RoomIn;
interface ServerApi { Room: RoomCtor; limits: Record<string, { reset(k: string): void }>; serverBuild: () => string }
let serverApi: ServerApi | null = null;
/**
 * Комната — ДИНАМИЧЕСКИМ импортом с путём из переменной: пакет клиента не тянет сервер в свою проверку типов (у сервера — node,
 * у клиента — DOM), а мок `db.ts` у теста уже стоит к моменту импорта.
 */
export async function loadServer(): Promise<ServerApi> {
  if (serverApi) return serverApi;
  const ROOM = '../../../../server/src/net/room.js';
  const LIMITS = '../../../../server/src/net/rateLimit.js';
  const BUILD = '../../../../server/src/buildStamp.js';
  const room = (await import(/* @vite-ignore */ ROOM)) as { Room: RoomCtor };
  const rl = (await import(/* @vite-ignore */ LIMITS)) as { limits: ServerApi['limits'] };
  const bs = (await import(/* @vite-ignore */ BUILD)) as { serverBuild: () => string };
  serverApi = { Room: room.Room, limits: rl.limits, serverBuild: bs.serverBuild };
  return serverApi;
}

/**
 * ⭐ R18-08: ДЕПЛОЙ СО СМЕНОЙ КОДА ЦЕН — подмены теста (`vi.mock`): `server` — штамп сборки сервера (`serverBuild` → `joined.build`; null — настоящий),
 * `drift` — формулы цен СТАРОГО бандла вкладки (`forgeGold` карточек верстака × `forge`, `shopSellPrice` «+N» лавки × `sell`; сервер считает их
 * внутри `townActions.ts`, мимо подмены), `stamp: false` — вкладка без штампа (как до правки: проверка зубов инварианта). Без подмен шаг
 * `deploy` не меняет ничего, и инвариант (5) молчит.
 */
export interface BuildHook { server: string | null; drift: { forge: number; sell: number } | null; stamp: boolean }
let buildHook: BuildHook = { server: null, drift: null, stamp: true };
export function setBuildHook(h: BuildHook): void { buildHook = h; }
const G_BUILD = globalThis as { __DM_BUILD__?: string };

/**
 * ⭐ R19-02: 2D-КЛИЕНТ — настоящая сцена `OnlineScene` поверх `App` прогона (подмены Phaser и спрайтов — у теста, `vi.mock`): её обработчики кадров,
 * пере-подписка на входе в сцену и поток входа (`EntryFlow`) — те же, что в браузере. Нечётные сиды идут через неё, чётные — голым `App` (как веб-3D,
 * у которого свои обработчики). Раньше прогон знал только голый `App` — и не видел, что 2D-сцена на входе снимала подписку `App` на штамп сборки.
 * `mount` — показать сцену (вернуть выход из неё); нет — все цепочки голым `App`.
 */
export interface SceneHook { mount: ((app: App) => () => void) | null }
let sceneHook: SceneHook = { mount: null };
export function setSceneHook(h: SceneHook): void { sceneHook = h; }

class ServerWs {
  open = true;
  readonly ip = '127.0.0.1';
  constructor(private readonly onFrame: (raw: string) => void) { }
  send(raw: string | Uint8Array): void { if (typeof raw === 'string') this.onFrame(raw); }
  close(): void { this.open = false; }
  onMessage(): void {}
  onClose(): void {}
}

// ── Шаги ──────────────────────────────────────────────────────────────────────────────────────────

export type OpKind =
  // окна (проверки паритета); ⭐ R19-07: и кнопка «Сбросить атрибуты» мастера
  | 'bench' | 'craft' | 'windowEnchant' | 'sketch' | 'buy' | 'sell' | 'field' | 'paperdoll' | 'respec'
  // состояние (сервер меняет, клиент узнаёт кадрами)
  | 'loot' | 'lootCrafted' | 'mats' | 'gold' | 'goldEdge' | 'matsEdge' | 'journal' | 'config' | 'clientSync' | 'shopRefresh'
  | 'breakItem' | 'bagFill' | 'equip' | 'unequip' | 'wear' | 'fund' | 'stashDrift'
  // ⭐ R18-08: деплой со сменой кода цен (вкладка переподключается со старым бандлом) — и перезагрузка страницы игроком (следующий такой шаг)
  | 'deploy';
export interface Op { k: OpKind; s: number }

export const OP_WEIGHTS: Record<OpKind, number> = {
  bench: 16, craft: 12, windowEnchant: 5, sketch: 5, buy: 7, sell: 6, field: 6, paperdoll: 6, respec: 4,
  loot: 8, lootCrafted: 6, mats: 6, gold: 3, goldEdge: 7, matsEdge: 6, journal: 5, config: 7, clientSync: 2, shopRefresh: 2,
  breakItem: 3, bagFill: 2, equip: 2, unequip: 1, wear: 3, fund: 8, stashDrift: 2, deploy: 2,
};
export const UI_OPS: ReadonlySet<OpKind> = new Set(['bench', 'craft', 'windowEnchant', 'sketch', 'buy', 'sell', 'field', 'paperdoll', 'respec']);

/** Цепочка шагов из сида: виды по весам, от состояния не зависит (сжатие это и требует). */
export function genOps(seed: number, len: number, weights: Partial<Record<OpKind, number>> = OP_WEIGHTS): Op[] {
  const r = createRng((seed * 2246822519) >>> 0 || 1);
  const kinds = Object.entries(weights).filter(([, w]) => (w ?? 0) > 0) as [OpKind, number][];
  const total = kinds.reduce((s, [, w]) => s + w, 0);
  const out: Op[] = [];
  for (let i = 0; i < len; i++) {
    let roll = r.next() * total;
    let k = kinds[kinds.length - 1]![0];
    for (const [kind, w] of kinds) { roll -= w; if (roll < 0) { k = kind; break; } }
    out.push({ k, s: r.int(1, 2 ** 31 - 1) });
  }
  return out;
}

// ── Нарушения ─────────────────────────────────────────────────────────────────────────────────────

export interface Violation { key: string; msg: string }
export interface Hit { key: string; at: number; msg: string; log: string[] }
export interface RunOut { hits: Hit[]; log: string[]; stats: Record<string, number> }

/** Род причины отказа — для «погашено ⇒ отказ того же рода». */
export function reasonClass(reason: string | undefined): string {
  const s = reason ?? '';
  if (s.startsWith(PRICE_CHANGED)) return 'price';
  if (/Слишком часто/.test(s)) return 'rate';
  if (/Нет места|Сумка полна|не поместится/.test(s)) return 'space';
  if (/^Кузнец ещё не куёт|не зачаровывает/.test(s)) return 'closed';
  if (/Недостаточно золота/.test(s)) return 'gold';
  if (/Не хватает/.test(s)) return 'short';
  if (/Ошибка сервера/.test(s)) return 'crash';
  return 'rule';
}
const normReason = (s: string): string => s.replace(/\d+/g, '#').trim();

// ── Прогон одной цепочки ──────────────────────────────────────────────────────────────────────────

type Tables = Record<string, unknown>;
const tablesOf = (r: ConfigRegistry): Tables => (r as unknown as { data: Tables }).data;
type CmdResult = Extract<ServerFrame, { t: 'cmdResult' }>;
const tick = (): Promise<void> => new Promise((res) => setImmediate(res));
const canonKeys = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : v);
const canon = (x: unknown): string => JSON.stringify(x, (_k, v: unknown) => canonKeys(v));
const canonMats = (m: Record<string, number> | undefined): string =>
  canon(Object.fromEntries(Object.entries(m ?? {}).filter(([, n]) => n > 0)));
const noPos = (it: Item): string => { const { pos: _p, ...rest } = it; return canon(rest); };

interface Snap { gold: number; avail: Record<string, number>; bag: Item[]; eq: Item[]; journal: CraftJournal; stash: AccountStash }

let RUN_NO = 0;

export class Rig {
  app!: App;
  room!: RoomIn;
  pid = '';
  userId = '';
  charId = '';
  /** Конфиг сервера (живой). */
  reg!: ConfigRegistry;
  cfgVer = 0;
  clientCfgVer = 0;
  /** Поколение конфига, при котором клиент получил последний кадр прилавка. */
  shopFrameVer = -1;
  sent: { id: number; command: TownCommand }[] = [];
  replies = new Map<number, CmdResult>();
  outbox: string[] = [];
  pending: Promise<unknown>[] = [];
  hits: Hit[] = [];
  keys = new Set<string>();
  log: string[] = [];
  step = 0;
  memo: CraftMemo = { open: new Map(), busy: false };
  /**
   * Команда ПОГАШЕННОГО окна уходит напрямую (проверка «погашено ⇒ сервер откажет») — окно её не шлёт. Её кадр, отвергнутый схемой
   * сервера, — не нарушение провода (так бывает у сборки с пустой деталью), а тот же отказ: считаем, не сигналим.
   */
  probe = false;
  /** На этом шаге ушла команда погашенного окна: «Неверная команда» комнаты на неё — не нарушение провода. */
  stepProbe = false;
  /** Сундук в базе менял другой герой (`stashDrift`), и кадра сундука с тех пор не было: слепок клиента законно устарел. */
  drift = false;
  /** ⭐ R18-08: штамп сборки сервера, с которым вкладка открылась; строк «перезагрузите» в логе игры и время последней. */
  stamp = '';
  hints = 0;
  hintAt = -Infinity;
  /** ⭐ R18-08: отказы «Цена изменилась» этого шага, которые перечитывание не лечит (время отказа): за каждым — «перезагрузите». */
  owed: number[] = [];
  deploys = 0;
  /** ⭐ R19-02: клиент — 2D-сцена `OnlineScene` (`SceneHook`), а не голый `App`; выход из сцены — на разборе прогона. */
  scene2d = false;
  private unmount: (() => void) | null = null;
  /** Часы прогона (`Date.now`): +7 мс на каждый вызов, от сида. */
  clock = 0;
  /** Сборка, на которую последний раз «накопили» (`fund`): ковка чаще берёт её. */
  funded?: CraftWindowState;
  prompts: string[] = [];
  confirmAnswer = true;
  body!: El;
  stats: Record<string, number> = {};
  serverErrors: string[] = [];
  private cws: BrowserWs | null = null;
  private restoreDom: (() => void) | null = null;
  private spies: { mockRestore(): void }[] = [];

  constructor(readonly db: FakeDb, readonly crypto: CryptoHook, readonly seed: number, readonly stopAt?: string) { }

  // ── Учёт ──
  count(k: string): void { this.stats[k] = (this.stats[k] ?? 0) + 1; }
  /**
   * Конфиг клиента устарел (правка хозяина живьём), окно горит, а сервер отказал НЕ ценой: «Цена изменилась» перечитывает конфиг
   * (`App.syncConfig`), любой другой отказ — нет, и окно так и предлагает то, в чём сервер откажет, до перезахода.
   */
  staleRefusal(op: string, on: boolean, rep: { ok: boolean; reason?: string }, res: string, sy: { cfg: boolean; save: boolean; stash: boolean }): void {
    const c = reasonClass(rep.reason);
    if (!sy.cfg && sy.save && sy.stash && on && !rep.ok && c !== 'price' && c !== 'space' && c !== 'rate') {
      this.violate(`stale:enabled-refused:${op}:${c === 'rule' ? normReason(rep.reason ?? '').slice(0, 40) : c}`, `${res} — конфиг клиента устарел, отказ не «Цена изменилась»: окно не перечитает конфиг`);
    }
  }
  /** Исход клика в счётчики: горело/серое × исполнено/отказ (и род отказа). */
  tally(op: string, on: boolean, rep: { ok: boolean; reason?: string }): void {
    const sy = this.synced();
    this.count(`mode:${op.split(':')[0]}:${sy.all ? 'strict' : 'stale'}`);
    this.count(`${op}:${on ? 'on' : 'off'}:${rep.ok ? 'ok' : 'no'}`);
    if (!rep.ok) this.count(`why:${op}:${on ? 'on' : 'off'}:${reasonClass(rep.reason)}`);
  }
  violate(key: string, msg: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.hits.push({ key, at: this.step, msg, log: this.log.slice(-14) });
  }
  get stopped(): boolean { return !!this.stopAt && this.keys.has(this.stopAt); }

  // ── Состояние ──
  srv(): SaveState { return this.room.session.world.players[this.pid]!.save; }
  cli(): SaveState { return this.app.state!.save; }
  dbStash(): AccountStash { return this.db.stashes.get(this.userId)!.data; }
  snap(): Snap {
    const s = this.srv(), st = this.dbStash();
    return {
      gold: s.gold, avail: availableMaterials(s.inventory, st.materials ?? {}), bag: structuredClone(s.inventory),
      eq: structuredClone(Object.values(s.equipment).filter(Boolean) as Item[]), journal: normalizeJournal(st.forgeJournal),
      stash: structuredClone(st),
    };
  }
  /** Код вкладки — не той сборки, что у сервера (шаг `deploy`, R18-08): её цены — старые формулы, строгие сверки уступают согласию на цену. */
  get codeDrift(): boolean { return buildHook.drift !== null; }
  /** Видит ли клиент то же, что сервер: конфиг, сейв, сундук (и тот же код цен — R18-08). */
  synced(): { cfg: boolean; save: boolean; stash: boolean; all: boolean } {
    const cfg = this.cfgVer === this.clientCfgVer;
    const s = this.srv(), c = this.cli();
    const save = s.gold === c.gold && canon(s.inventory) === canon(c.inventory) && canon(s.equipment) === canon(c.equipment);
    const st = this.dbStash(), cs = this.app.stash;
    const stash = !!cs && canonMats(st.materials) === canonMats(cs.materials)
      && canon(normalizeJournal(st.forgeJournal)) === canon(normalizeJournal(cs.forgeJournal));
    return { cfg, save, stash, all: cfg && save && stash && !this.codeDrift };
  }

  // ── Провод ──
  /**
   * Кадр клиента — как его принимает шлюз (`roomManager.frameGate`): команда (`cmd`) идёт в комнату «как есть», её форму проверяет
   * схема комнаты (D11, ответ «Неверная команда» и шум в лог — `wire:invalid-command`), прочие кадры — строгая схема
   * (`parseClientFrame`, отвергнутый — `wire:client-frame-rejected`).
   */
  private fromClient(raw: string): void {
    type Frame = { t?: unknown; command?: { cmd?: unknown }; id?: unknown };
    const json = ((): Frame | null => { try { return JSON.parse(raw) as Frame; } catch { return null; } })();
    if (json?.t === 'cmd') {
      this.sent.push({ id: json.id as number, command: json.command as TownCommand });
      const { limits } = serverApi!;
      for (const l of Object.values(limits)) l.reset(this.userId);   // частоту здесь не меряем: это не паритет окна
      if (this.probe) this.stepProbe = true;
      this.pending.push(this.room.handleCmd(this.pid, json.command, json.id));
      return;
    }
    if (!parseClientFrame(raw)) this.violate(`wire:client-frame-rejected:${String(json?.t ?? '?')}`, `кадр клиента не прошёл схему сервера: ${raw.slice(0, 300)}`);
  }
  private fromServer(raw: string): void { this.outbox.push(raw); }
  private deliver(raw: string): void {
    const f = JSON.parse(raw) as ServerFrame;
    if (f.t === 'cmdResult' && typeof f.id === 'number') this.replies.set(f.id, f);
    if (f.t === 'shop') this.shopFrameVer = this.cfgVer;
    if (f.t === 'stash') this.drift = false;
    this.cws?.onmessage?.({ data: raw });
    // Клиент на «Цена изменилась» перечитывает конфиг (`App.syncConfig` → `/api/config`); у `App` без сервера это делает прогон.
    if (f.t === 'cmdResult' && !f.ok && f.reason?.startsWith(PRICE_CHANGED)) {
      // ⭐ R18-08: конфиг клиента и так серверный, а код цен — старой сборки: перечитывание не поможет, игроку обязано прозвучать «перезагрузите».
      if (this.codeDrift && this.cfgVer === this.clientCfgVer) { this.owed.push(Date.now()); this.count('hint:owed'); }
      this.syncClientConfig();
    }
  }
  /** Дождаться, пока команды исполнятся и все кадры дойдут до клиента. */
  async flush(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (this.pending.length) { await Promise.allSettled(this.pending.splice(0)); continue; }
      await tick();
      if (this.outbox.length) { for (const raw of this.outbox.splice(0)) this.deliver(raw); continue; }
      await tick();
      if (!this.pending.length && !this.outbox.length) return;
    }
    this.violate('harness:flush-stuck', 'очередь кадров не опустела');
  }
  /** Команда так, как её шлёт `App.request` (с ожиданием ответа). */
  async request(command: TownCommand): Promise<CmdResult | undefined> {
    const at = this.sent.length;
    void this.app.request(command).catch(() => null);
    await this.flush();
    const s = this.sent[at];
    return s ? this.replies.get(s.id) : undefined;
  }
  syncClientConfig(): void {
    (this.app.config as unknown as { data: Tables }).data = { ...tablesOf(this.reg) };
    this.clientCfgVer = this.cfgVer;
  }
  /** Сервер изменил сейв (добыча, золото) — клиенту кадр `saveUpdate`, как после подбора. */
  async pushSave(): Promise<void> {
    (this.room as unknown as { sendSave(pid: string): void }).sendSave(this.pid);
    await this.flush();
  }
  /** Сундук в базе поменялся — клиент открывает кузницу заново (`stashOpen`) и видит новый слепок. */
  async pushStash(): Promise<void> { await this.request({ cmd: 'stashOpen' }); }

  /** Отрисовать окно; бросок — нарушение (4). */
  render(surface: string, f: () => unknown): El | null {
    try {
      return f() as El;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.violate(`ui-throw:${surface}:${msg.slice(0, 50)}`, `${surface}: ${e instanceof Error ? e.stack?.split('\n').slice(0, 6).join(' ⏎ ') : msg}`);
      return null;
    }
  }
  matIdByName(): Map<string, string> { return new Map(this.app.config.get('craft-materials').map((m) => [m.name, m.id])); }

  /**
   * ⭐ R18-08: связь оборвалась (деплой перезапустил сервер) — вкладка переподключается сама: та же комната, тот же герой (сейв и версия — как
   * у записи), кадр `joined` заново (с ним — штамп сборки сервера), за ним сундук и прилавок.
   */
  async reconnect(): Promise<void> {
    await this.flush();
    clearHeld();
    this.pid = this.room.addPlayer(new ServerWs((raw) => this.fromServer(raw)), this.userId, structuredClone(this.srv()), this.db.saves.get(this.charId) ?? 1);
    await this.flush();
    this.room.stop();
    await this.flush();
  }

  // ── Жизненный цикл ──
  async setup(): Promise<void> {
    // Детерминизм: uuid вещей (`Math.random`, `Date.now`) и бросок сервера (`randomInt`) — от сида.
    const rnd = createRng((this.seed * 1597334677) >>> 0 || 5);
    this.clock = 1_760_000_000_000;
    const crnd = createRng((this.seed * 3812015801) >>> 0 || 9);
    this.spies.push(vi.spyOn(Math, 'random').mockImplementation(() => rnd.next()));
    this.spies.push(vi.spyOn(Date, 'now').mockImplementation(() => (this.clock += 7)));
    this.crypto.randomInt = (a, b) => a + Math.floor(crnd.next() * Math.max(1, b - a));
    const dom = installDom((m) => { this.prompts.push(m); return this.confirmAnswer; });
    this.body = dom.body as El;
    this.restoreDom = dom.restore;

    const n = ++RUN_NO;
    const w = newWorld(this.seed);
    this.reg = w.reg;
    const hero = w.heroes[0];
    this.charId = hero.charId = `ui${this.seed}-${n}`;
    this.userId = `u-ui${this.seed}-${n}`;
    this.db.saves.set(this.charId, 1);
    this.db.data.set(this.charId, structuredClone(hero));
    this.db.stashes.set(this.userId, { data: structuredClone(w.stash), version: 1 });

    // ⭐ R18-08: вкладка открыта с той же сборки, что сервер (штамп бандла = штамп сервера); `stamp: false` — вкладка без штампа (до правки).
    buildHook.server = null;
    buildHook.drift = null;
    this.stamp = serverApi!.serverBuild();
    G_BUILD.__DM_BUILD__ = buildHook.stamp ? this.stamp : '';

    // Клиент: настоящий `App` без сервера конфига; конфиг — тот же, что у сервера (как после `/api/config`).
    const app = new App({ offline: true });
    this.app = app;
    app.bus.on('log:message', (m) => { if (m.text === PROTOCOL_STALE) { this.hints++; this.hintAt = Date.now(); } });
    this.syncClientConfig();
    // Сейв с сервера — как у драйвера сцены (`NetDriver.applySave`); вход в мир — сцена 2D (R19-02) или свой обработчик.
    app.net.on('saveUpdate', (f) => { if (app.state) app.state.save = f.save; app.bus.emit('state:changed', {}); });
    BrowserWs.sink = (raw) => this.fromClient(raw);
    app.net.connect('ws://fuzz/ws');
    this.cws = BrowserWs.last;
    this.cws!.readyState = BrowserWs.OPEN;
    this.cws!.onopen?.();
    this.scene2d = !!sceneHook.mount && this.seed % 2 === 1;
    if (this.scene2d) {
      // Вход в аккаунт и выбор героя — как у 2D до `scene.start('Online')`; сцена вешает свои обработчики поверх подписок `App` и спрашивает статус.
      app.auth = { token: 'ab'.repeat(32), userId: this.userId, username: this.charId };
      app.pendingCharId = this.charId;
      this.unmount = sceneHook.mount!(app);
      this.count('client:2d');
      this.log.push('клиент: 2D-сцена OnlineScene');
    } else {
      app.net.on('joined', (f) => { const gs = new GameState(f.save); gs.restoreFull(); app.state = gs; });
    }

    const { Room } = serverApi!;
    this.room = new Room(`UI${this.seed}-${n}`, this.reg, { onEmpty: () => {}, onGrace: () => {}, onUngrace: () => {} });
    this.pid = this.room.addPlayer(new ServerWs((raw) => this.fromServer(raw)), this.userId, structuredClone(hero), 1);
    await this.flush();
    this.room.stop();   // тика нет: мир города стоит, автосейв не вмешивается
    await this.flush();
    if (!app.state) this.violate('harness:no-joined', 'клиент не получил кадр joined');
  }
  teardown(): void {
    try { this.unmount?.(); } catch { /* уже */ }   // R19-02: выход из сцены — до закрытия сокета: поток входа не переподключается
    this.unmount = null;
    try { this.room?.stop(); } catch { /* уже */ }
    try { this.cws?.onclose?.({ code: 1000 }); } catch { /* уже */ }
    try { this.app?.replies.dropAll(); } catch { /* уже */ }
    BrowserWs.sink = () => {};
    this.crypto.randomInt = undefined;
    buildHook.server = null;
    buildHook.drift = null;
    delete G_BUILD.__DM_BUILD__;
    for (const s of this.spies.splice(0)) s.mockRestore();
    this.restoreDom?.();
  }
}

/** Прогон одной цепочки. `stopAt` — ключ, на котором остановиться (сжатие). */
export async function runSeq(db: FakeDb, crypto: CryptoHook, seed: number, ops: readonly Op[], stopAt?: string): Promise<RunOut> {
  await loadServer();
  const g = new Rig(db, crypto, seed, stopAt);
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { g.serverErrors.push(a.map(String).join(' ').slice(0, 400)); });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { g.serverErrors.push(`warn: ${a.map(String).join(' ').slice(0, 400)}`); });
  try {
    await g.setup();
    for (let i = 0; i < ops.length && !g.stopped; i++) {
      const op = ops[i]!;
      g.step = i;
      const r = createRng(op.s);
      let desc = '';
      g.serverErrors = [];
      g.stepProbe = false;
      const hints = g.hints;
      // ⭐ R18-08: со старым кодом цен игрок между кликами думает дольше повтора подсказки — каждый отказ ценой обязан сказать «перезагрузите» сам,
      // а не за счёт строки входа или прошлого клика.
      if (g.codeDrift) g.clock += REFUSAL_REPEAT_MS;
      try {
        desc = await EXEC[op.k](g, r);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        g.violate(`harness-throw:${op.k}:${msg.slice(0, 50)}`, `${op.k}: ${e instanceof Error ? e.stack?.split('\n').slice(0, 6).join(' ⏎ ') : msg}`);
        desc = `${op.k}: БРОСОК ${msg}`;
      }
      // (5) ⭐ R18-08: отказ ценой, который перечитывание не лечит, — «перезагрузите» сразу за ним или не раньше `REFUSAL_REPEAT_MS` до него (повтор
      // гасится, как повтор отказа); без деплоя — ни одной такой строки.
      for (const at of g.owed.splice(0)) {
        if (!(g.hintAt > at - REFUSAL_REPEAT_MS)) g.violate(`hint:silent-price-loop:${op.k}`, `«${desc}»: отказ «Цена изменилась» при серверном конфиге и старом коде цен — «перезагрузите» не сказано (последний раз ${g.hintAt === -Infinity ? 'никогда' : `${at - g.hintAt} мс назад`})`);
      }
      if (!g.codeDrift && g.hints > hints) g.violate(`hint:false-reload:${op.k}`, `«${desc}»: сборки вкладки и сервера одни, а игроку «перезагрузите страницу»`);
      g.log.push(`#${i} ${desc}`);
      for (const h of g.hits) if (h.at === i && h.log.at(-1) !== g.log.at(-1)) h.log.push(g.log.at(-1)!);
      g.count(`op:${op.k}`);
      for (const e of g.serverErrors) {
        if (/невалидная команда/.test(e)) { if (!g.stepProbe) g.violate(`wire:invalid-command:${op.k}`, e); }
        else if (/упала/.test(e)) g.violate(`server:crash:${op.k}`, e);
        else if (/изменил сейв/.test(e)) g.violate(`server:refusal-changed-save:${op.k}`, e);
        else if (/^\[forge\]/.test(e)) g.violate(`ui-throw:forge-log:${op.k}`, e);
      }
      // После каждого шага клиент видит сейв сервера (свой шаг окна кончился ответом и кадрами).
      const sy = g.synced();
      if (!sy.save) g.violate(`sync:client-save:${op.k}`, `после «${desc}» сейв клиента разошёлся с сейвом сервера`);
      if (!sy.stash && !g.drift && UI_OPS.has(op.k)) g.violate(`sync:client-stash:${op.k}`, `после «${desc}» сундук клиента разошёлся с базой`);
    }
  } finally {
    g.teardown();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  }
  return { hits: g.hits, log: g.log, stats: g.stats };
}

/** Сжатие: выбрасывать шаги (кусками, потом по одному), пока нарушение с тем же ключом воспроизводится. */
export async function shrinkSeq(db: FakeDb, crypto: CryptoHook, seed: number, ops: readonly Op[], key: string, budget = 160): Promise<{ ops: Op[]; out: RunOut }> {
  const hits = async (o: readonly Op[]): Promise<RunOut | null> => {
    const out = await runSeq(db, crypto, seed, o, key);
    return out.hits.some((h) => h.key === key) ? out : null;
  };
  let cur = [...ops];
  // Хвост после первого срабатывания не нужен.
  let best = await hits(cur);
  if (!best) return { ops: cur, out: { hits: [], log: [], stats: {} } };
  const at = best.hits.find((h) => h.key === key)!.at;
  cur = cur.slice(0, at + 1);
  let tries = 0;
  for (let chunk = Math.max(1, Math.floor(cur.length / 2)); chunk >= 1 && tries < budget; chunk = Math.floor(chunk / 2)) {
    for (let i = 0; i + chunk <= cur.length - 1 && tries < budget;) {   // последний шаг — сам срабатывающий — не трогаем
      const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      tries++;
      const out = await hits(cand);
      if (out) { cur = cand; best = out; } else i += chunk;
    }
  }
  return { ops: cur, out: best };
}

// ── Помощники выбора ──────────────────────────────────────────────────────────────────────────────

const isCrafted = (it: Item): boolean => !!it.parts;
const nonMat = (it: Item): boolean => it.kind !== 'material';
/** Вещь сумки с уклоном в интересное: скованное, сломанное, найденное оружие; изредка сырьё и зелья. */
function pickBagItem(items: readonly Item[], r: Rng): Item | undefined {
  if (!items.length) return undefined;
  const x = r.next();
  const by = (f: (it: Item) => boolean): Item | undefined => { const p = items.filter(f); return p.length ? r.pick(p) : undefined; };
  return (x < 0.3 ? by(isCrafted) : x < 0.48 ? by((i) => !!i.broken) : x < 0.7 ? by((i) => i.kind === 'weapon' && !i.parts)
    : x < 0.75 ? by((i) => !nonMat(i)) : by(nonMat)) ?? r.pick(items);
}

/** Карточки верстака из DOM: заголовок, подпись, строки, горит ли (у погашенной обработчика клика нет). */
interface CardView { el: El; title: string; sub: string; lines: string[]; enabled: boolean }
function benchCards(root: El): CardView[] {
  const box = root.all().find((e) => e.tag === 'div' && (e.style.cssText ?? '').startsWith('display:flex;flex-wrap:wrap;gap:10px;margin-top:10px'));
  return (box?.children ?? []).map((c) => ({
    el: c, title: c.children[0]?.textContent ?? '', sub: c.children[1]?.textContent ?? '',
    lines: c.children.slice(2).map((x) => x.textContent), enabled: c.listens('click'),
  }));
}
interface BenchShown { gold?: number; mats: Record<string, number>; yields: Record<string, [number, number]>; dim: string[]; missGold: boolean; missMats: boolean }
function parseBench(lines: readonly string[], ids: Map<string, string>): BenchShown {
  const out: BenchShown = { mats: {}, yields: {}, dim: [], missGold: false, missMats: false };
  for (const l of lines) {
    let m = /^(✓ |✕ )(\d+) золота$/.exec(l);
    if (m) { out.gold = Number(m[2]); if (m[1] === '✕ ') out.missGold = true; continue; }
    m = /^(✓ |✕ )(.+) (\d+)(?: \(есть \d+\))?$/.exec(l);
    if (m && ids.has(m[2]!)) { out.mats[ids.get(m[2]!)!] = (out.mats[ids.get(m[2]!)!] ?? 0) + Number(m[3]); if (m[1] === '✕ ') out.missMats = true; continue; }
    m = /^\+ (.+) (\d+)(?:–(\d+))?$/.exec(l);
    if (m && ids.has(m[1]!)) { out.yields[ids.get(m[1]!)!] = [Number(m[2]), Number(m[3] ?? m[2])]; continue; }
    out.dim.push(l);
  }
  return out;
}
/** Строки предпросмотра верстака «было → станет». */
function previewRows(root: El): { was: string; will: string }[] {
  return root.all().filter((e) => e.tag === 'div' && e.children.length === 3 && e.children[1]!.textContent === '→')
    .map((e) => ({ was: e.children[0]!.textContent, will: e.children[2]!.textContent }));
}
const baseLines = (item: Item): string[] => itemDescLines(item).filter((l) => !l.affix).map((l) => l.text);

/** Команда карточки — ровно та, что собирает клик (`forgeBench.runAction`). */
function benchCommand(a: BenchAction, uid: string): TownCommand {
  const price = a.gold !== undefined ? { maxGold: a.gold } : {};
  const mats = a.materials !== undefined ? { maxMaterials: a.materials } : {};
  return a.cmd === 'forgeEnchant' ? { cmd: 'forgeEnchant', uid, rarity: a.rarity ?? 'magic', ...price }
    : a.cmd === 'forgeSalvage' ? { cmd: 'forgeSalvage', uid, ...(a.minYield !== undefined ? { minYield: a.minYield } : {}), ...(a.avgYield !== undefined ? { avgYield: a.avgYield } : {}) }
    : a.cmd === 'forgeReroll' ? { cmd: 'forgeReroll', uid, ...price }
    : { cmd: a.cmd, uid, ...price, ...mats } as TownCommand;
}

/** Разность сырья «после − до» по id (без нулей). */
function matDelta(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[id] ?? 0) - (a[id] ?? 0); if (d !== 0) out[id] = d; }
  return out;
}

/**
 * Что журналу засчитал бы разбор у кузнеца — ИСХОДОМ СЕРВЕРА: `forgeSalvage` на копии сейва и сундука базы, строки открытий
 * (`unlocked`) — те же, что пишет верстак после разбора. Сверяются с вопросом перед продажей и разбором в поле (`disposePrompts`).
 */
function serverUnlocks(g: Rig, item: Item): string[] {
  const s = structuredClone(g.srv()), st = structuredClone(g.dbStash());
  if (!s.inventory.some((i) => i.uid === item.uid)) return [];
  const r = forgeSalvage(g.reg, s, st, item.uid, { int: (a) => a, chance: () => false });
  return r.ok ? r.unlocked ?? [] : [];
}
/** Сверка вопроса «журнал это не засчитает» с исходом сервера. `prompt` — текст вопроса (или undefined — вопроса не было). */
function checkJournalPrompt(g: Rig, op: string, item: Item, prompt: string | undefined, truth: string[], strict: boolean): void {
  const pre = strict ? 'warn' : 'stale:warn';
  const listed = prompt ? (/\n\((.*)\)\n/s.exec(prompt)?.[1] ?? '') : '';
  // Строки открытий сервера (`unlockLabels`) → как их называет вопрос (`journalGainsOf`). Имена деталей бывают с запятой —
  // поэтому сверка по подстрокам, а не по разбиению списка.
  const asPrompt = (t: string): string | undefined => {
    let m = /^Тип (.+)$/.exec(t); if (m) return `тип ${m[1]}`;
    m = /^Деталь (.+)$/.exec(t); if (m) return `деталь ${m[1]}`;
    m = /^Кодекс: (.+)$/.exec(t); if (m) return `кодекс ${m[1]}`;
    m = /^Ступень (.+)$/.exec(t); if (m) return `ступень ${m[1]}`;
    return undefined;
  };
  // Сервер → вопрос: тип, деталь, кодекс и ступень обязаны быть названы (иначе тихая ловушка).
  const want = truth.map(asPrompt).filter((x): x is string => !!x);
  const missing = want.filter((w) => !listed.includes(w));
  if (missing.length) g.violate(`${pre}:prompt-missing:${op}`, `«${item.name}»: разбор у кузнеца открыл бы ${missing.join(', ')}, а вопрос ${prompt ? `называет только (${listed})` : 'не задан'}`);
  // Вопрос → сервер: названное обязано открыться (мифик и эскиз — только если сервер их засчитал).
  // Имена бывают с кавычками внутри («Булава с «горошками»») — вычёркиваем названное сервером и ищем остаток.
  let rest = listed;
  for (const w of [...want].sort((a, b) => b.length - a.length)) rest = rest.replace(w, '');
  const extra = [...rest.matchAll(/(тип|деталь|кодекс|ступень) «[^,]*/g)].map((m) => m[0]);
  if (/мифик к воротам/.test(listed) && !truth.some((x) => x.startsWith('Мифических'))) extra.push('мифик');
  if (/эскиз — деталь на выбор/.test(listed) && !truth.some((x) => x.startsWith('Эскиз'))) extra.push('эскиз');
  if (extra.length) g.violate(`${pre}:prompt-false:${op}`, `«${item.name}»: вопрос обещает ${extra.join(', ')}, а разбор у кузнеца этого не открыл бы (${truth.join(', ') || 'ничего'})`);
}

// ── Окна ──────────────────────────────────────────────────────────────────────────────────────────

async function opBench(g: Rig, r: Rng): Promise<string> {
  const save = g.cli();
  const item = pickBagItem(save.inventory, r);
  if (!item) return 'верстак: сумка пуста';
  const sy = g.synced();
  let note = '';
  const opts = { uid: item.uid as string | null, setUid: (u: string | null) => { opts.uid = u; }, get note() { return note; }, setNote: (n: string) => { note = n; } };
  const root = g.render('bench', () => forgeBench(g.app, opts));
  if (!root) return `верстак «${item.name}»: окно бросило`;
  const cards = benchCards(root);
  let acts: BenchAction[];
  try { acts = benchActions(g.app.config, item, save.gold, save.inventory, g.app.stash?.materials ?? {}); } catch (e) {
    g.violate(`ui-throw:benchActions:${String((e as Error)?.message).slice(0, 50)}`, String((e as Error)?.stack));
    return `верстак «${item.name}»: карточки бросили`;
  }
  if (cards.length !== acts.length || cards.some((c, i) => !c.title.includes(acts[i]!.title) || c.enabled !== acts[i]!.enabled)) {
    g.violate('ui:bench-dom-model', `карточки DOM (${cards.map((c) => `${c.title}${c.enabled ? '' : '·серая'}`).join(', ')}) ≠ модели (${acts.map((a) => `${a.title}${a.enabled ? '' : '·серая'}`).join(', ')})`);
    return `верстак «${item.name}»: DOM ≠ модель`;
  }
  const i = r.int(0, acts.length - 1);
  const a = acts[i]!, card = cards[i]!;
  const shown = parseBench(card.lines, g.matIdByName());
  const prev = previewRows(root);
  const before = g.snap();
  const at = g.sent.length;
  g.prompts = [];
  g.confirmAnswer = true;
  if (card.enabled) card.el.click();
  else { g.probe = true; void g.app.request(benchCommand(a, item.uid)).catch(() => null); }
  await g.flush();
  g.probe = false;
  const sent = g.sent.slice(at).filter((s) => s.command.cmd === a.cmd);
  const tag = `${a.id}${a.rarity ? `:${a.rarity}` : ''}`;
  const desc = `верстак «${item.name}»${item.parts ? ' (скованная)' : ''}${item.broken ? ' (сломана)' : ''} → ${card.title}${card.enabled ? '' : ' [серая]'} ${card.lines.join(' · ')}`;
  if (sent.length !== 1) { g.violate(`ui:no-command:bench:${tag}`, `${desc}: клик не послал команду (послано ${sent.length})`); return desc; }
  const rep = g.replies.get(sent[0]!.id);
  if (!rep) { g.violate(`ui:no-reply:bench:${tag}`, `${desc}: ответа нет`); return desc; }
  const after = g.snap();
  const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
  g.tally(`bench:${tag}`, card.enabled, rep);
  g.staleRefusal(`bench:${tag}`, card.enabled, rep, res, sy);
  // Окно говорит исход: отказ — строкой «⚠» над верстаком, успех её не оставляет.
  if (card.enabled && rep.ok === note.startsWith('⚠')) g.violate(`ui:note:bench:${tag}`, `${res}: строка над верстаком «${note}»`);
  // Вопросы перед разбором: скованное — дважды, прочее у кузнеца — ни разу.
  if (card.enabled && a.id === 'salvage' && g.prompts.length !== (item.parts ? 2 : 0)) {
    g.violate(`warn:forge-salvage-prompts`, `${res}: вопросов ${g.prompts.length}, ожидалось ${item.parts ? 2 : 0}`);
  }
  const strict = sy.all;
  if (strict) {
    if (card.enabled && !rep.ok) g.violate(`parity:enabled-refused:bench:${tag}:${reasonClass(rep.reason)}`, res);
    if (!card.enabled && rep.ok) g.violate(`parity:disabled-accepted:bench:${tag}`, res);
    if (!card.enabled && !rep.ok && rep.reason !== 'Неверная команда') {
      const ui = shown.dim.length && shown.gold === undefined ? `rule:${normReason(shown.dim.join(' '))}` : shown.missGold ? 'gold' : shown.missMats ? 'short' : 'rule';
      const sc = reasonClass(rep.reason);
      const srv = sc === 'rule' ? `rule:${normReason(rep.reason ?? '')}` : sc;
      const same = ui === srv || (ui.startsWith('rule:') && sc === 'closed' && /не зачаровывает/.test(ui));
      if (!same) g.violate(`parity:reason-class:bench:${tag}:${ui.split(':')[0]}/${sc}`, `${res}: окно — «${ui}», сервер — «${srv}»`);
    }
  }
  if (!rep.ok) return res;
  const dGold = after.gold - before.gold;
  const dMats = matDelta(before.avail, after.avail);
  const paid = -dGold;
  if (a.id === 'salvage') {
    if (dGold !== 0) g.violate('price:gold-mismatch:bench:salvage', `${res}: золото ${dGold}`);
    const gains = item.kind === 'material' ? {} : dMats;
    for (const [id, n] of Object.entries(gains)) {
      const y = shown.yields[id];
      if (!y || n < y[0] || n > y[1]) {
        // Устаревший конфиг: меньше низа — провал согласия (`minYield`), больше верха — сервер щедрее показанного (согласие одностороннее).
        const key = strict ? 'range:yield-out:bench:salvage' : !y || n > y[1] ? 'stale:yield-above:bench:salvage' : 'price:yield-under-consent:bench:salvage';
        g.violate(key, `${res}: выход ${id} ${n}, на карточке ${y ? `${y[0]}–${y[1]}` : 'нет'}`);
      }
    }
    if (strict) for (const [id, y] of Object.entries(shown.yields)) if (y[0] > 0 && !(gains[id]! >= y[0])) g.violate('range:yield-under:bench:salvage', `${res}: ${id} ${gains[id] ?? 0} ниже низа ${y[0]}`);
    if (after.bag.some((it) => it.uid === item.uid)) g.violate('range:salvage-kept-item', `${res}: вещь осталась в сумке`);
    return res;
  }
  // Платные: золото — строкой карточки, сырьё — строками карточки.
  const wantGold = shown.gold ?? 0;
  if (strict ? paid !== wantGold : paid > wantGold) g.violate(`${strict ? 'price:gold-mismatch' : 'price:overcharge'}:bench:${tag}`, `${res}: списано ${paid}, на карточке ${wantGold}`);
  const spentPos = Object.fromEntries(Object.entries(dMats).filter(([, n]) => n < 0).map(([id, n]) => [id, -n]));
  if (strict) {
    if (canonMats(spentPos) !== canonMats(shown.mats)) g.violate(`price:mats-mismatch:bench:${tag}`, `${res}: списано ${canon(spentPos)}, на карточке ${canon(shown.mats)}`);
    for (const [id, n] of Object.entries(dMats)) if (n > 0) g.violate(`price:mats-gain:bench:${tag}`, `${res}: сырьё ${id} +${n}`);
  } else {
    for (const [id, n] of Object.entries(spentPos)) if (n > (shown.mats[id] ?? 0)) g.violate(`price:overcharge-mats:bench:${tag}`, `${res}: ${id} списано ${n}, на карточке ${shown.mats[id] ?? 0}`);
  }
  const was = before.bag.find((x) => x.uid === item.uid)!;
  const now = after.bag.find((x) => x.uid === item.uid);
  if (!now) { g.violate(`range:item-gone:bench:${tag}`, `${res}: вещи нет в сумке`); return res; }
  if (a.id === 'upgrade' || a.id === 'repair') {
    // Предпросмотр «было → станет» — тот же дифф описаний, что у вещи сервера.
    const want = diffStrings(baseLines(was), baseLines(now)).map((x) => ({ was: x.was || '—', will: x.will || '—' }));
    if (canon(want) !== canon(prev)) {
      g.violate(`${strict ? 'preview' : 'stale:preview'}:${a.id}`, `${res}: окно обещало ${prev.map((x) => `${x.was} → ${x.will}`).join('; ') || '(ничего)'}, вышло ${want.map((x) => `${x.was} → ${x.will}`).join('; ') || '(ничего)'}`);
    }
    if (a.id === 'repair' && (now.broken || noPos({ ...now, broken: undefined }) !== noPos({ ...was, broken: undefined }))) {
      g.violate('range:repair-changed', `${res}: починка поменяла не только «сломано»`);
    }
  }
  if (a.id === 'enchant' && now.rarity !== a.rarity) g.violate('range:enchant-rarity', `${res}: редкость ${now.rarity}`);
  if (a.id === 'reroll' && (now.rerolls ?? 0) !== (was.rerolls ?? 0) + 1) g.violate('range:reroll-count', `${res}: перекаток ${now.rerolls}`);
  return res;
}

/** Случайное состояние окна ковки: как открылось, случайные детали и материалы, «Вся вещь из», доводка. */
function randomWindow(reg: ConfigRegistry, j: CraftJournal, r: Rng): CraftWindowState {
  const classes = reg.get('weapon-anatomy').map((a) => a.id);
  // Чаще — класс, у которого в журнале есть открытая база: игрок смотрит то, что может сковать.
  const open = classes.filter((c) => familiesOf(reg, c).some((h) => keyVariantsByBase(reg, c, h).some((x) => j.bases.includes(x.baseId))));
  const cls = open.length && r.chance(0.75) ? r.pick(open) : r.pick(classes);
  const fams = familiesOf(reg, cls);
  const hands = fams.length ? r.pick(fams) : 1;
  const st = initialCraftState(reg, cls, hands);
  const mode = r.int(0, 3);
  const keySlot = keySlotOf(reg, cls);
  if (mode === 1 || mode === 2) {
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = slot === keySlot ? keyVariantsByBase(reg, cls, hands).flatMap((x) => x.variants) : variantsFor(reg, cls, slot, hands);
      const open = pool.filter((p) => j.variants.includes(p.id));
      const from = mode === 1 && open.length ? open : pool;
      if (from.length && st.parts) st.parts[slot] = { id: r.pick(from).id, step: r.int(1, 5) };
    }
  } else if (mode === 3 && st.parts) {
    const k = r.int(1, 5);
    for (const slot of CRAFT_SLOT_LIST) st.parts[slot] = { ...st.parts[slot], step: k };
  }
  const fin = reg.get('balance').craft.finish.length;
  st.finish = r.chance(0.5) ? 0 : r.int(0, Math.max(0, fin - 1));
  return st;
}

type Preview = ReturnType<typeof craftWeapon>;
const inputOf = (st: CraftWindowState): CraftInput => ({ weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 });
/**
 * Окно, которое игрок, скорее всего, и откроет: из нескольких случайных — собирающееся (`ok`) или ещё и по карману (`afford`);
 * не нашлось — первое. Состояние приведено тем же `normalizeCraftState`, что делает окно (бросок — окну и достанется).
 */
function pickWindow(g: Rig, r: Rng, want: 'any' | 'ok' | 'afford'): { st: CraftWindowState; pv?: Preview } | null {
  const reg = g.app.config;
  const j = g.app.stash?.forgeJournal;
  if (!j) return null;
  let first: { st: CraftWindowState; pv?: Preview } | null = null;
  for (let k = 0; k < 10; k++) {
    const st = randomWindow(reg, j, r);
    let pv: Preview | undefined;
    try { normalizeCraftState(reg, st, j); pv = craftWeapon(reg, inputOf(st), { journal: j, materialsOn: true }); } catch { return first ?? { st }; }
    first ??= { st, pv };
    if (want === 'any') return first;
    if (!pv.ok || !pv.cost) continue;
    if (want === 'ok') return { st, pv };
    const save = g.cli();
    const lack = craftMissing(availableMaterials(save.inventory, g.app.stash?.materials ?? {}), save.gold, pv.cost);
    if (!Object.keys(lack.materials).length && lack.gold <= 0) return { st, pv };
  }
  return first;
}

/** Что окно ковки показывает: кнопка, цена построчно, имя, ступень, требования и разброс «от–до» в сравнении. */
interface CraftShown {
  btn?: El; gold?: number; mats: Record<string, number>; name: string; tier: string; tip: string;
  req: Record<string, number>; hit?: { min: [number, number]; max: [number, number] };
}
function craftShown(root: El, ids: Map<string, string>): CraftShown {
  const all = root.all();
  const out: CraftShown = { mats: {}, name: '', tier: '', tip: '', req: {} };
  out.btn = all.find((e) => e.tag === 'button' && /Ковать|куём/.test(e.textContent));
  for (const e of all) {
    if (e.tag !== 'div') continue;
    const t = e.textContent;
    let m = /^Золото — (\d+) {2}\(есть -?\d+\)$/.exec(t);
    if (m) { out.gold = Number(m[1]); continue; }
    m = /^.+: (.+) — (\d+) {2}\(всего \d+, есть -?\d+\)$/.exec(t);
    if (m && ids.has(m[1]!)) { const id = ids.get(m[1]!)!; out.mats[id] = (out.mats[id] ?? 0) + Number(m[2]); continue; }
    m = /^.+: (.+) — (\d+) {2}\(есть -?\d+\)$/.exec(t);
    if (m && ids.has(m[1]!)) { const id = ids.get(m[1]!)!; out.mats[id] = (out.mats[id] ?? 0) + Number(m[2]); continue; }
    if (t === 'Получилось') out.name = e.parent?.children[1]?.textContent ?? '';
    if (t === 'Ступень из деталей') out.tier = e.parent?.children[1]?.textContent ?? '';
  }
  const tipEl = all.find((e) => e.tag === 'div' && e.innerHTML.length > 0 && e.children.length === 0 && /Урон|Уровень предмета/.test(e.innerHTML));
  out.tip = tipEl?.innerHTML ?? '';
  const table = all.find((e) => e.tag === 'table');
  for (const tr of table?.children ?? []) {
    if (tr.children.length !== 4) continue;
    const label = tr.children[0]!.textContent, b = tr.children[2]!.textContent;
    const attr = label === 'сила' ? 'strength' : label === 'ловкость' ? 'dexterity' : label === 'интеллект' ? 'intelligence' : undefined;
    if (attr && /^\d+$/.test(b)) out.req[attr] = Number(b);
    if (label === 'разброс') {
      const sp = (s: string): [number, number] => { const q = /^\((\d+)–(\d+)\)$/.exec(s); return q ? [Number(q[1]), Number(q[2])] : [Number(s), Number(s)]; };
      const q = /^(\(\d+–\d+\)|\d+)–(\(\d+–\d+\)|\d+)$/.exec(b);
      if (q) out.hit = { min: sp(q[1]!), max: sp(q[2]!) };
    }
  }
  return out;
}
/** Строка описания с вилками «(a–b)» ⇒ регулярка: каждое число вещи — в своей вилке. */
function lineFits(shown: string, actual: string): boolean {
  if (shown === actual) return true;
  const ranges: [number, number][] = [];
  const src = shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\((\d+)–(\d+)\\\)/g, (_m, a: string, b: string) => { ranges.push([Number(a), Number(b)]); return '(\\d+)'; });
  if (!ranges.length) return false;
  let m: RegExpExecArray | null;
  try { m = new RegExp(`^${src}$`).exec(actual); } catch { return false; }
  if (!m) return false;
  return ranges.every(([a, b], i) => { const v = Number(m![i + 1]); return v >= a && v <= b; });
}

async function opCraft(g: Rig, r: Rng): Promise<string> {
  const reg = g.app.config;
  if (!reg.get('balance').craft.live) return 'ковка: у клиента кузнец закрыт — окна нет';
  const w = g.funded && r.chance(0.6) ? { st: structuredClone(g.funded) } : pickWindow(g, r, r.chance(0.5) ? 'afford' : r.chance(0.5) ? 'ok' : 'any');
  if (!w) return 'ковка: журнала нет';
  const st = w.st;
  const host = gameCraftHost(g.app as unknown as ForgeLink, g.memo);
  const sy = g.synced();
  const root = g.render('craftWindow', () => craftWindow(g.app, host, st));
  if (!root) return `ковка ${st.weaponClass}/${st.hands}: окно бросило`;
  const sh = craftShown(root, g.matIdByName());
  if (!sh.btn) { g.violate('ui:craft-no-button', `окно ковки ${st.weaponClass}/${st.hands} без кнопки «Ковать»`); return 'ковка: нет кнопки'; }
  const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };
  const pv = craftWeapon(reg, input, { journal: host.journal(), materialsOn: true });
  const saveBefore = structuredClone(g.cli());
  const before = g.snap();
  const at = g.sent.length;
  const enabled = !sh.btn.disabled;
  if (enabled) sh.btn.click();
  else { g.probe = true; void Promise.resolve(host.craft(input, pv.cost?.gold, pv.cost?.materials)).catch(() => null); }
  await g.flush();
  g.probe = false;
  const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'craft');
  const parts = CRAFT_SLOT_LIST.map((s) => `${st.parts[s]?.id}@${st.parts[s]?.step}`).join(' ');
  const desc = `ковка ${st.weaponClass}/${st.hands} [${parts}] доводка ${st.finish ?? 0} «${sh.name}» ${sh.tier} — ${sh.gold ?? '?'} з. ${canon(sh.mats)}${enabled ? '' : ` [серая: ${sh.btn.title}]`}`;
  if (sent.length !== 1) {
    g.violate('ui:no-command:craft', `${desc}: команда не ушла (послано ${sent.length})`);
    return desc;
  }
  const rep = g.replies.get(sent[0]!.id);
  if (!rep) { g.violate('ui:no-reply:craft', `${desc}: ответа нет`); return desc; }
  const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
  g.tally('craft', enabled, rep);
  g.staleRefusal('craft', enabled, rep, res, sy);
  if (enabled) {
    const okMsg = st.message.startsWith('Скована');
    if (okMsg !== rep.ok) g.violate('ui:note:craft', `${res}: окно пишет «${st.message}»`);
  }
  const strict = sy.all;
  if (strict) {
    if (enabled && !rep.ok) g.violate(`parity:enabled-refused:craft:${reasonClass(rep.reason)}`, res);
    if (!enabled && rep.ok) g.violate('parity:disabled-accepted:craft', res);
    if (!enabled && !rep.ok && rep.reason !== 'Неверная команда') {
      // Погашено: «Не хватает: …» (цена), «Нет места в сумке» (V-B3-03, `craftFits`) или правило сборки (строкой сервера).
      const ui = /^Не хватает/.test(sh.btn.title) ? 'short' : reasonClass(sh.btn.title) === 'space' ? 'space' : 'rule';
      const sc = reasonClass(rep.reason);
      const same = ui === 'short' ? sc === 'short' || sc === 'gold' : ui === 'space' ? sc === 'space'
        : sc === 'rule' && normReason(rep.reason ?? '') === normReason(sh.btn.title);
      if (!same) g.violate(`parity:reason-class:craft:${ui}/${sc}`, `${res}: окно — «${sh.btn.title}», сервер — «${rep.reason}»`);
    }
  }
  if (!rep.ok) return res;
  const after = g.snap();
  const item = after.bag.find((x) => x.uid === rep.uid) ?? after.eq.find((x) => x.uid === rep.uid);
  if (!item) { g.violate('range:craft-no-item', `${res}: скованной вещи нет`); return res; }
  const paid = before.gold - after.gold;
  const dMats = matDelta(before.avail, after.avail);
  const spent: Record<string, number> = {};
  for (const [id, n] of Object.entries(dMats)) if (n < 0) spent[id] = -n; else g.violate('price:mats-gain:craft', `${res}: сырьё ${id} +${n}`);
  if (strict) {
    if (paid !== sh.gold) g.violate('price:gold-mismatch:craft', `${res}: списано ${paid}, в окне ${sh.gold}`);
    if (canonMats(spent) !== canonMats(sh.mats)) g.violate('price:mats-mismatch:craft', `${res}: списано ${canon(spent)}, в окне ${canon(sh.mats)}`);
  } else {
    if (sh.gold !== undefined && paid > sh.gold) g.violate('price:overcharge:craft', `${res}: списано ${paid} > ${sh.gold}`);
    for (const [id, n] of Object.entries(spent)) if (n > (sh.mats[id] ?? 0)) g.violate('price:overcharge-mats:craft', `${res}: ${id} списано ${n} > ${sh.mats[id] ?? 0}`);
  }
  // (3) Вещь сервера ≡ предпросмотру: имя, ступень, требования, урон в вилке.
  const pre = strict ? 'range' : 'stale:range';
  if (sh.tier && item.tier !== sh.tier.split(' ')[0]) g.violate(`${pre}:craft-tier`, `${res}: ступень вещи ${item.tier}, в окне «${sh.tier}»`);
  if (sh.tip && !sh.tip.includes(item.name)) g.violate(`${pre}:craft-name`, `${res}: имя вещи «${item.name}», в окне другое`);
  for (const [k, v] of Object.entries(sh.req)) {
    if ((item.requirements as Record<string, number | undefined>)[k] !== v) g.violate(`${pre}:craft-req`, `${res}: требование ${k} ${item.requirements[k as 'strength']}, в окне ${v}`);
  }
  if (sh.hit) {
    const card = cardWith(reg, saveBefore, item);
    const hmn = Number(card.hitMin.toFixed(0)), hmx = Number(card.hitMax.toFixed(0));
    if (hmn < sh.hit.min[0] || hmn > sh.hit.min[1] || hmx < sh.hit.max[0] || hmx > sh.hit.max[1]) {
      g.violate(`${pre}:craft-hit`, `${res}: разброс вещи ${hmn}–${hmx}, в окне (${sh.hit.min.join('–')})–(${sh.hit.max.join('–')})`);
    }
  }
  // Описание: каждая строка предпросмотра — та же у вещи, а вилка «(a–b)» содержит её число.
  if (pv.item) {
    const a = itemDescLines(pv.item).filter((l) => !l.affix).map((l) => l.text);
    const b = itemDescLines(item).filter((l) => !l.affix).map((l) => l.text);
    for (const s of a) {
      const head = s.split(':')[0]!;
      const got = b.find((x) => x.split(':')[0] === head);
      if (got === undefined) { if (!b.includes(s)) g.violate(`${pre}:craft-line-missing:${head.slice(0, 24)}`, `${res}: строка окна «${s}» — у вещи её нет`); continue; }
      if (!lineFits(s, got)) g.violate(`${pre}:craft-line:${head.slice(0, 24)}`, `${res}: окно «${s}», у вещи «${got}»`);
    }
  }
  // Сообщение «Скована: … урон X–Y из вилки … бросок N %».
  if (enabled) {
    const m = /урон (\d+)–(\d+) из вилки (\(\d+–\d+\)|\d+)–(\(\d+–\d+\)|\d+) · бросок (-?\d+) %/.exec(st.message);
    if (m) {
      const sp = (s: string): [number, number] => { const q = /^\((\d+)–(\d+)\)$/.exec(s); return q ? [Number(q[1]), Number(q[2])] : [Number(s), Number(s)]; };
      const [a0, a1] = sp(m[3]!), [b0, b1] = sp(m[4]!);
      const x = Number(m[1]), y = Number(m[2]), q = Number(m[5]);
      if (x < a0 || x > a1 || y < b0 || y > b1 || q < 0 || q > 100) g.violate(`${pre}:craft-verdict`, `${res}: «${st.message}»`);
    }
  }
  if (canon(item.craftPaid ?? []) !== canon((pv.cost?.lines ?? []).filter((l) => l.n > 0).map((l) => ({ id: l.id, n: l.n }))) && strict) {
    g.violate('range:craft-paid', `${res}: craftPaid ${canon(item.craftPaid)} ≠ строкам цены окна`);
  }
  return res;
}

async function opWindowEnchant(g: Rig, r: Rng): Promise<string> {
  const reg = g.app.config;
  if (!reg.get('balance').craft.live) return 'зачарование в окне: кузнец закрыт у клиента';
  const save = g.cli();
  const pool = [...save.inventory.filter(isCrafted), ...(Object.values(save.equipment).filter((x): x is Item => !!x && isCrafted(x)))];
  if (!pool.length) return 'зачарование в окне: скованного нет';
  const item = r.pick(pool);
  const st = initialCraftState(reg, item.weaponClass && anatomyOf(reg, item.weaponClass) ? item.weaponClass : 'sword', item.hands);
  st.crafted = item;
  const host = gameCraftHost(g.app as unknown as ForgeLink, g.memo);
  const sy = g.synced();
  const root = g.render('craftWindow:enchant', () => craftWindow(g.app, host, st));
  if (!root) return `зачарование «${item.name}»: окно бросило`;
  const rarity = r.chance(0.5) ? 'magic' as const : 'rare' as const;
  const btn = root.all().find((e) => e.tag === 'button' && e.textContent.startsWith(rarity === 'magic' ? '✦ Магический' : '✦ Редкий'));
  if (!btn) { g.violate('ui:enchant-no-button', `у скованной «${item.name}» нет кнопки ${rarity}`); return 'зачарование: нет кнопки'; }
  const cost = Number(/· (\d+) з\.$/.exec(btn.textContent)?.[1] ?? NaN);
  const before = g.snap();
  const at = g.sent.length;
  const enabled = !btn.disabled;
  const inBag = save.inventory.some((x) => x.uid === item.uid);
  if (enabled) btn.click();
  else { g.probe = true; void Promise.resolve(host.enchant(item, rarity, cost)).catch(() => null); }
  await g.flush();
  g.probe = false;
  const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'forgeEnchant');
  const desc = `окно: зачаровать «${item.name}»${inBag ? '' : ' (надета)'} до ${rarity} за ${cost}${enabled ? '' : ` [серая: ${btn.title}]`}`;
  if (sent.length !== 1) { g.violate('ui:no-command:windowEnchant', `${desc}: команда не ушла`); return desc; }
  const rep = g.replies.get(sent[0]!.id);
  if (!rep) return `${desc}: ответа нет`;
  const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
  g.tally('windowEnchant', enabled, rep);
  g.staleRefusal('windowEnchant', enabled, rep, res, sy);
  if (sy.all) {
    if (enabled && !rep.ok) g.violate(`parity:enabled-refused:windowEnchant:${reasonClass(rep.reason)}`, res);
    if (!enabled && rep.ok) g.violate('parity:disabled-accepted:windowEnchant', res);
  }
  if (rep.ok) {
    const paid = before.gold - g.srv().gold;
    if (sy.all ? paid !== cost : paid > cost) g.violate(`price:${sy.all ? 'gold-mismatch' : 'overcharge'}:windowEnchant`, `${res}: списано ${paid}`);
    if (enabled && !st.message.startsWith('Зачарована')) g.violate('ui:note:windowEnchant', `${res}: окно пишет «${st.message}»`);
  }
  return res;
}

async function opSketch(g: Rig, r: Rng): Promise<string> {
  const reg = g.app.config;
  if (!reg.get('balance').craft.live) return 'эскиз: у клиента кузнец закрыт — окна нет';
  const j = g.app.stash?.forgeJournal;
  if (!j) return 'эскиз: журнала нет';
  const classes = reg.get('weapon-anatomy').map((a) => a.id);
  const cls = r.pick(classes);
  const fams = familiesOf(reg, cls);
  const hands = fams.length ? r.pick(fams) : 1;
  const st = initialCraftState(reg, cls, hands);
  const host = gameCraftHost(g.app as unknown as ForgeLink, g.memo);
  const sy = g.synced();
  const root = g.render('craftWindow:sketch', () => craftWindow(g.app, host, st));
  if (!root) return `эскиз ${cls}/${hands}: окно бросило`;
  // Строки деталей по гнёздам в порядке окна: ключ первым, у ключа — по базам.
  const keySlot = keySlotOf(reg, cls);
  const order = [keySlot, ...CRAFT_SLOT_LIST.filter((s) => s !== keySlot)];
  const grid = root.all().find((e) => (e.style.cssText ?? '').startsWith('display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))'));
  const rows: { id: string; name: string; el: El; kind: 'offer' | 'locked' | 'open' }[] = [];
  order.forEach((slot, k) => {
    const list = grid?.children[k]?.children.find((c) => (c.style.cssText ?? '').includes('max-height:250px'));
    const btns = (list?.children ?? []).filter((c) => c.tag === 'button');
    const parts = slot === keySlot ? keyVariantsByBase(reg, cls, st.hands).flatMap((x) => x.variants) : variantsFor(reg, cls, slot, st.hands);
    parts.forEach((p, i) => {
      const el = btns[i];
      if (!el) return;
      const kind = el.innerHTML.includes('✦ ') ? 'offer' : el.innerHTML.includes('🔒 ') ? 'locked' : 'open';
      rows.push({ id: p.id, name: p.name, el, kind });
    });
  });
  if (!rows.length) return `эскиз ${cls}/${hands}: строк нет`;
  const offers = rows.filter((x) => x.kind === 'offer');
  const locked = rows.filter((x) => x.kind === 'locked');
  const pick = offers.length && r.chance(0.6) ? r.pick(offers) : locked.length && r.chance(0.8) ? r.pick(locked) : r.pick(rows);
  const before = g.snap();
  const at = g.sent.length;
  if (pick.kind === 'offer') {
    pick.el.click();
    const go = root.button('Открыть эскизом');
    if (!go) { g.violate('ui:sketch-no-confirm', `эскиз «${pick.name}»: после выбора нет кнопки «Открыть эскизом»`); return 'эскиз: нет подтверждения'; }
    go.click();
  } else { g.probe = true; void Promise.resolve(host.sketch!(pick.id)).catch(() => null); }
  await g.flush();
  g.probe = false;
  const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'forgeSketch');
  const desc = `эскиз ${cls}/${st.hands}: «${pick.name}» (${pick.id}) [${pick.kind === 'offer' ? 'предложена ✦' : pick.kind === 'locked' ? '🔒' : 'открыта'}], эскизов ${j.sketches}`;
  if (sent.length !== 1) { g.violate(`ui:no-command:sketch:${pick.kind}`, `${desc}: команда не ушла`); return desc; }
  const rep = g.replies.get(sent[0]!.id);
  if (!rep) return `${desc}: ответа нет`;
  const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
  g.tally(`sketch:${pick.kind}`, pick.kind === 'offer', rep);
  g.staleRefusal('sketch', pick.kind === 'offer', rep, res, sy);
  if (sy.all) {
    if (pick.kind === 'offer' && !rep.ok) g.violate(`parity:enabled-refused:sketch:${reasonClass(rep.reason)}`, res);
    if (pick.kind !== 'offer' && rep.ok) g.violate(`parity:disabled-accepted:sketch:${pick.kind}`, res);
  }
  if (rep.ok) {
    const a = normalizeJournal(g.dbStash().forgeJournal);
    if (!a.variants.includes(pick.id) || a.sketches !== before.journal.sketches - 1) g.violate('range:sketch-journal', `${res}: журнал ${a.sketches} эскизов, деталь ${a.variants.includes(pick.id) ? 'открыта' : 'закрыта'}`);
    if (pick.kind === 'offer' && !st.message.startsWith('Открыто эскизом')) g.violate('ui:note:sketch', `${res}: окно пишет «${st.message}»`);
  }
  return res;
}

/** Сетка прилавка из DOM: обёртка с кликом и вещи с позицией, ценником и «по карману». */
function shopGridItems(root: El): { wrap: El; cells: { x: number; y: number; price: string; affordable: boolean }[] } | null {
  const wrap = root.all().find((e) => e.tag === 'div' && e.style.cssText === 'position:relative' && e.listens('click'));
  if (!wrap) return null;
  const layer = wrap.children[1];
  const cells = (layer?.children ?? []).map((el) => {
    const m = /grid-column:(\d+) \/ span \d+;grid-row:(\d+) \/ span \d+/.exec(el.style.cssText ?? '');
    const badge = el.children.find((c) => (c.style.cssText ?? '').includes('bottom:0'));
    return { x: Number(m?.[1] ?? 0) - 1, y: Number(m?.[2] ?? 0) - 1, price: badge?.textContent ?? '', affordable: el.style.opacity !== '0.6' };
  });
  return { wrap, cells };
}
const uiStub = { openPanel: (): void => {}, closePanel: (): void => {}, refresh: (): void => {} };

async function opBuy(g: Rig, r: Rng): Promise<string> {
  const potions = r.chance(0.3);
  const body = new El('div');
  const sy = g.synced();
  if (potions) {
    const panel = g.render('shopPanel', () => shopPanel(g.app, uiStub as never)) as unknown as { render(b: El): void } | null;
    if (!panel || !g.render('shopPanel.render', () => { panel.render(body); return body; })) return 'лавка: окно бросило';
  } else {
    const panel = g.render('forgePanel', () => forgePanel(g.app, uiStub as never)) as unknown as { render(b: El): void } | null;
    if (!panel) return 'кузница: окно бросило';
    await g.flush();   // кузница при открытии спрашивает сундук (`stashOpen`)
    if (!g.render('forgePanel.render', () => { panel.render(body); return body; })) return 'кузница: окно бросило';
    body.button('Купить')?.click();
    const cat = r.pick(['Ближний бой', 'Дальний бой', 'Броня']);
    body.button(cat)?.click();
  }
  const grid = shopGridItems(body);
  if (!grid || !grid.cells.length) return `${potions ? 'лавка' : 'кузница'}: прилавок пуст`;
  const cell = r.pick(grid.cells);
  const fresh = g.shopFrameVer === g.cfgVer && sy.save;
  const stock = [...g.app.shopStock, ...g.room.shop];   // до покупки: после неё вещи на прилавке уже нет
  const before = g.snap();
  const at = g.sent.length;
  grid.wrap.dispatch('click', { clientX: cell.x * PITCH + 2, clientY: cell.y * PITCH + 2 });
  await g.flush();
  const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'buy');
  if (sent.length !== 1) { g.violate('ui:no-command:buy', `клик по вещи прилавка (${cell.x},${cell.y}) не послал покупку`); return 'купить: команда не ушла'; }
  const cmd = sent[0]!.command as Extract<TownCommand, { cmd: 'buy' }>;
  const it = stock.find((x) => x.uid === cmd.uid);
  const rep = g.replies.get(sent[0]!.id);
  const desc = `купить «${it?.name ?? cmd.uid}» за ${cell.price}${cell.affordable ? '' : ' [не по карману]'} (золото ${before.gold}${fresh ? '' : ', ценник устарел'})`;
  if (!rep) return `${desc}: ответа нет`;
  const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
  g.tally('buy', cell.affordable, rep);
  if (String(cmd.maxGold) !== cell.price) g.violate('ui:buy-consent', `${res}: ценник ${cell.price}, в команде maxGold ${cmd.maxGold}`);
  const serverPrice = it ? shopBuyPrice(g.reg, it) : NaN;
  if (fresh && it && String(serverPrice) !== cell.price) g.violate('parity:buy-price-frame', `${res}: сервер берёт ${serverPrice}`);
  if (fresh) {
    if (cell.affordable && !rep.ok) g.violate(`parity:enabled-refused:buy:${reasonClass(rep.reason)}`, res);
    if (!cell.affordable && rep.ok) g.violate('parity:disabled-accepted:buy', res);
  }
  if (rep.ok) {
    const paid = before.gold - g.srv().gold;
    if (fresh ? String(paid) !== cell.price : paid > Number(cell.price)) g.violate(`price:${fresh ? 'gold-mismatch' : 'overcharge'}:buy`, `${res}: списано ${paid}`);
    const got = g.srv().inventory.find((x) => x.uid === cmd.uid);
    if (!got || (it && noPos(got) !== noPos(it))) g.violate('range:buy-item', `${res}: в сумке ${got ? 'другая вещь' : 'пусто'}`);
  }
  return res;
}

async function opSell(g: Rig, r: Rng): Promise<string> {
  const panel = g.render('shopPanel', () => shopPanel(g.app, uiStub as never)) as unknown as { render(b: El): void } | null;
  const body = new El('div');
  if (!panel || !g.render('shopPanel.render', () => { panel.render(body); return body; })) return 'лавка: окно бросило';
  const head = body.all().find((e) => e.tag === 'h4' && e.textContent.startsWith('Продать'));
  const cols = head?.parent?.children[1]?.children ?? [];
  const inv = g.cli().inventory;
  if (!cols.length || !inv.length) return 'продать: сумка пуста';
  if (cols.length !== inv.length) { g.violate('ui:sell-cells', `ячеек скупки ${cols.length}, вещей ${inv.length}`); return 'продать: ячейки ≠ сумке'; }
  const item = pickBagItem(inv, r)!;
  const idx = inv.indexOf(item);
  const col = cols[idx]!;
  const priceText = col.children[1]?.textContent ?? '';
  const shown = Number(/^\+(\d+)$/.exec(priceText)?.[1] ?? NaN);
  const sy = g.synced();
  const before = g.snap();
  const truth = serverUnlocks(g, item);   // до продажи: после неё вещи уже нет
  const at = g.sent.length;
  g.prompts = [];
  g.confirmAnswer = r.chance(0.92);
  col.children[0]!.click();
  await g.flush();
  const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'sell');
  const desc = `продать «${item.name}»${item.parts ? ' (скованная)' : ''} за ${priceText}${g.prompts.length ? ` (вопросов ${g.prompts.length}${g.confirmAnswer ? '' : ', ответ «нет»'})` : ''}`;
  // Вопросы: скованное — дважды; найденное, которое кузнец засчитал бы журналу, — ещё один со списком.
  const jp = g.prompts.find((p) => p.startsWith('Продажа журнал кузнеца не пополняет'));
  // Вопрос про журнал при УСТАРЕВШЕМ конфиге — по старым правилам, и такую продажу сервер отказывает «Цена изменилась» (согласие на конфиг,
  // `cfgRev`, V-B3-07): игрок ничего не теряет, а вопрос перечитается с конфигом. Сверка вопроса — строго сразу, а при устаревшем — только
  // если продажа всё же прошла (иначе это артефакт фаззера: `stale:warn:prompt-*` на отказанной команде).
  const journalCheck = (): void => { if (!item.parts) checkJournalPrompt(g, 'sell', item, jp, truth, sy.all); };
  if (sy.all) journalCheck();
  const crafted = g.prompts.filter((p) => /скованн/.test(p)).length;
  if (g.confirmAnswer && crafted !== (item.parts ? 2 : 0)) g.violate('warn:sell-crafted-prompts', `${desc}: вопросов о скованной ${crafted}`);
  for (const p of g.prompts) if (/за \d+ золота/.test(p) && !p.includes(`за ${shown} золота`)) g.violate('warn:sell-prompt-price', `${desc}: вопрос называет другую цену: «${p.slice(0, 120)}»`);
  if (!g.confirmAnswer && g.prompts.length) {
    if (sent.length) g.violate('ui:sell-despite-no', `${desc}: «нет» на вопрос, а продажа ушла`);
    return `${desc} → отменено`;
  }
  if (sent.length !== 1) { g.violate('ui:no-command:sell', `${desc}: команда не ушла`); return desc; }
  const rep = g.replies.get(sent[0]!.id);
  if (!rep) return `${desc}: ответа нет`;
  if (!sy.all && rep.ok) journalCheck();
  const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
  g.tally('sell', true, rep);
  if (sy.all && !rep.ok) g.violate(`parity:enabled-refused:sell:${reasonClass(rep.reason)}`, res);
  if (rep.ok) {
    const got = g.srv().gold - before.gold;
    if (sy.all ? got !== shown : got < shown) g.violate(`price:${sy.all ? 'gold-mismatch' : 'undergive'}:sell`, `${res}: получено ${got}`);
    if (sy.all && shopSellPrice(g.reg, item) !== shown) g.violate('parity:sell-price', `${res}: сервер оценивает ${shopSellPrice(g.reg, item)}`);
  }
  return res;
}

async function opField(g: Rig, r: Rng): Promise<string> {
  const inv = g.cli().inventory.filter((x) => x.pos);
  const item = pickBagItem(inv, r);
  if (!item) return 'поле: сумка пуста';
  const sy = g.synced();
  g.app.state!.area = 'dungeon';
  try {
    const panel = g.render('inventoryPanel', () => inventoryPanel(g.app, uiStub as never)) as unknown as { render(b: El): void } | null;
    const body = new El('div');
    if (!panel || !g.render('inventoryPanel.render', () => { panel.render(body); return body; })) return 'поле: инвентарь бросил';
    const el = body.all().find((e) => e.listens('contextmenu') && (e.style.cssText ?? '').startsWith(`grid-column:${item.pos!.x + 1} / span`) && (e.style.cssText ?? '').includes(`grid-row:${item.pos!.y + 1} / span`));
    if (!el) { g.violate('ui:field-no-cell', `«${item.name}» не нарисована в сетке`); return 'поле: нет клетки'; }
    g.body.children = [];
    el.dispatch('contextmenu', { clientX: 10, clientY: 10 });
    const menu = g.body.children.at(-1);
    const opts = (menu?.children ?? []).map((c) => ({ el: c, label: c.textContent }));
    const salv = opts.find((o) => o.label.startsWith('Разобрать здесь'));
    const before = g.snap();
    const truth = serverUnlocks(g, item);   // до разбора: после него вещи уже нет
    const at = g.sent.length;
    g.prompts = [];
    let promise: Promise<unknown>;
    if (salv) { salv.el.click(); promise = Promise.resolve(); }
    else { g.probe = true; promise = salvageInField(g.app, item, (m) => { g.prompts.push(m); return Promise.resolve(true); }); }
    // Вопросы в игре (`askInGame`) — отвечаем «Да», запоминая текст.
    for (let k = 0; k < 8; k++) {
      await tick();
      const box = g.body.children.find((b) => b.button('Да'));
      if (!box) { if (k > 2) break; continue; }
      g.prompts.push(box.children[0]?.textContent ?? '');
      box.button('Да')!.click();
    }
    await promise;
    await g.flush();
    g.probe = false;
    const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'salvage');
    const desc = `поле: разобрать «${item.name}»${item.parts ? ' (скованная)' : ''}${salv ? '' : ' [пункта нет]'}`;
    const jp = g.prompts.find((p) => p.startsWith('Разбор в поле журнал кузнеца не пополняет'));
    // Как у продажи: при устаревшем конфиге вопрос сверяется, только если разбор прошёл (иначе — отказ «Цена изменилась», потерь нет).
    const journalCheck = (): void => { if (!item.parts && salv) checkJournalPrompt(g, 'field', item, jp, truth, sy.all); };
    if (sy.all) journalCheck();
    if (salv && g.prompts.filter((p) => /скованн/.test(p)).length !== (item.parts ? 2 : 0)) g.violate('warn:field-crafted-prompts', `${desc}: вопросов ${g.prompts.length}`);
    if (sent.length !== 1) { g.violate(`ui:no-command:field:${salv ? 'on' : 'off'}`, `${desc}: команда не ушла`); return desc; }
    const cmd = sent[0]!.command as Extract<TownCommand, { cmd: 'salvage' }>;
    const rep = g.replies.get(sent[0]!.id);
    if (!rep) return `${desc}: ответа нет`;
    if (!sy.all && rep.ok) journalCheck();
    const res = `${desc} → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
    g.tally('field', !!salv, rep);
    g.staleRefusal('field', !!salv, rep, res, sy);
    if (sy.all) {
      if (salv && !rep.ok) g.violate(`parity:enabled-refused:field:${reasonClass(rep.reason)}`, res);
      if (!salv && rep.ok) g.violate('parity:disabled-accepted:field', res);
    }
    if (rep.ok) {
      const after = g.snap();
      const gains = matDelta(before.avail, after.avail);
      if (item.kind === 'material') return res;
      const range = salvageRange(g.app.config, item, true).range;
      for (const [id, n] of Object.entries(gains)) {
        const y = range[id];
        if (n < 0) { g.violate('price:field-lost-mats', `${res}: сырьё ${id} ${n}`); continue; }
        if (!y || n < y.min || n > y.max) {
          const key = sy.all ? 'range:yield-out:field' : !y || n > y.max ? 'stale:yield-above:field' : 'price:yield-under-consent:field';
          g.violate(key, `${res}: выход ${id} ${n}, вилка ${y ? `${y.min}–${y.max}` : 'нет'}`);
        }
      }
      for (const [id, lo] of Object.entries(cmd.minYield ?? {})) if ((gains[id] ?? 0) < lo) g.violate('price:field-under-consent', `${res}: ${id} ${gains[id] ?? 0} < ${lo}`);
    }
    return res;
  } finally {
    if (g.app.state) g.app.state.area = 'town';
    g.body.children = [];
  }
}

const DOLL: readonly EquipSlot[] = ['helm', 'amulet', 'weapon', 'chest', 'offhand', 'gloves', 'belt', 'ring', 'boots'];
/**
 * Герой — на грани одного требования: база атрибута подогнана так, что требование держится ровно (±1). Грань — из тех, где правила
 * «что будет надето после смены» расходятся с наивными: требование брошенной вещи без вещи целевой ячейки (прежняя пред-проверка пупсика),
 * оно же без снятой второй руки (двуручник снимает щит), требование надетой вещи сейчас (смена снимет вещь, что её подпирала). Чаще —
 * грань, где снимаемое прибавляет к тому же атрибуту (там правила и расходились бы). Сервер меняет сейв, клиент узнаёт кадром.
 */
function edgeAttributes(g: Rig, item: Item, cell: EquipSlot, r: Rng): string {
  const s = g.srv();
  const worn = Object.values(s.equipment).filter(Boolean) as Item[];
  const without = (...gone: (Item | undefined)[]): Item[] => worn.filter((i) => !gone.includes(i));
  const prev = s.equipment[cell];
  const off = s.equipment.offhand;
  const twoH = cell === 'weapon' && (item.hands ?? 1) >= 2 && !item.versatile;
  const boosted = (it: Item | undefined): Set<string> =>
    new Set(it ? modifiersFromItems([it]).filter((m) => m.kind === 'flat' && m.value > 0).map((m) => m.stat) : []);
  const offUp = twoH ? boosted(off) : new Set<string>(), prevUp = boosted(prev);
  const edges: { who: Item; wearing: Item[]; hot: Set<string> }[] = [
    { who: item, wearing: without(prev), hot: offUp },
    ...(twoH && off ? [{ who: item, wearing: without(prev, off), hot: new Set<string>() }] : []),
    ...without(prev).map((w) => ({ who: w, wearing: without(w), hot: prevUp })),
  ];
  const cand = edges.flatMap((e) => Object.entries(e.who.requirements ?? {}).filter(([, v]) => (v ?? 0) > 0)
    .map(([a, v]) => ({ ...e, a: a as keyof SaveState['attributes'], v: v! })));
  if (!cand.length) return '';
  const hot = cand.filter((c) => c.hot.has(c.a));
  const c = hot.length && r.chance(0.75) ? r.pick(hot) : r.pick(cand);
  // Прочие требования брошенной вещи закрыты базой с запасом: держит (или нет) ровно выбранная грань.
  for (const [a, v] of Object.entries(item.requirements ?? {})) {
    const k = a as keyof SaveState['attributes'];
    if (k !== c.a && (v ?? 0) > s.attributes[k]) s.attributes[k] = v!;
  }
  const have = finalAttributes(s.attributes, modifiersFromItems(c.wearing))[c.a];
  const base = Math.max(0, s.attributes[c.a] + Math.ceil(c.v - have) + r.pick([0, 0, 1, -1]));
  s.attributes[c.a] = base;
  return `, ${c.a} = ${base} (грань «${c.who.name}» ${c.v})`;
}

/**
 * ⭐ R16-08: ПУПСИК. Вещь сумки — на курсор (`beginHold`), клик по ячейке пупсика настоящего `inventoryPanel`: чаще своя ячейка вещи,
 * иногда вторая рука или чужая; часто герой — на грани требования (`edgeAttributes`). Инварианты: ушла команда ⇒ сервер надел, и туда,
 * куда бросили (`parity:enabled-refused:paperdoll`); не ушла, а ячейка своя или вторая рука ⇒ сервер отказывает и сам (проба той же
 * командой, `parity:disabled-accepted:paperdoll`); отказ — строкой в окне, вещь остаётся на курсоре.
 */
async function opPaperdoll(g: Rig, r: Rng): Promise<string> {
  const pool = g.cli().inventory.filter((it) => it.pos && it.slot && nonMat(it) && it.kind !== 'consumable');
  if (!pool.length) return 'пупсик: надеть нечего';
  // Вторая рука занята — чаще двуручник на курсоре: он её снимет (правило ядра, которое пупсик обязан повторить).
  const twoHanders = g.cli().equipment.offhand ? pool.filter((it) => it.slot === 'weapon' && (it.hands ?? 1) >= 2) : [];
  const pick = twoHanders.length && r.chance(0.35) ? r.pick(twoHanders) : r.pick(pool);
  const x = r.next();
  const cell: EquipSlot = x < 0.65 ? pick.slot! : x < 0.9 ? 'offhand' : r.pick(DOLL);
  let edge = '';
  if (r.chance(0.6)) {
    edge = edgeAttributes(g, g.srv().inventory.find((i) => i.uid === pick.uid) ?? pick, cell, r);
    if (edge) await g.pushSave();
  }
  const item = g.cli().inventory.find((i) => i.uid === pick.uid);
  if (!item) return `пупсик: «${pick.name}» пропала из сумки клиента`;
  const sy = g.synced();
  const body = new El('div');
  const panel = g.render('inventoryPanel', () => inventoryPanel(g.app, uiStub as never)) as unknown as { render(b: El): void } | null;
  if (!panel || !g.render('inventoryPanel.render', () => { panel.render(body); return body; })) return 'пупсик: инвентарь бросил';
  const texts = (): string[] => body.all().map((e) => e.textContent).filter(Boolean);
  const shown = new Set(texts());
  const target = body.all().find((e) => e.dataset.eqslot === cell);
  if (!target) { g.violate('ui:paperdoll-no-cell', `ячейка ${cell} не нарисована`); return 'пупсик: нет ячейки'; }
  const at = g.sent.length;
  try {
    beginHold(g.app, item, 0, 0, 'inv');
    target.dispatch('click', { clientX: 5, clientY: 5 });
    await g.flush();
    const sent = g.sent.slice(at).filter((s) => s.command.cmd === 'equip');
    const held = getHeld() !== null;
    const note = texts().filter((t) => !shown.has(t)).join(' | ');
    const desc = `пупсик: «${item.name}»${item.broken ? ' (сломана)' : ''} → ${cell}${edge}`;
    if (sent.length > 1) { g.violate('ui:paperdoll-double', `${desc}: ушло ${sent.length} команды`); return desc; }
    if (sent.length === 1) {
      const rep = g.replies.get(sent[0]!.id);
      if (!rep) return `${desc}: ответа нет`;
      const res = `${desc} → ${rep.ok ? 'надета' : `отказ «${rep.reason}»`}`;
      g.tally('paperdoll', true, rep);
      if (held) g.violate('ui:paperdoll-held-after-send', `${res}: команда ушла, а вещь осталась на курсоре`);
      // Род отказа правила — по тексту (без имени вещи): «сломано», «недостаточно атрибутов», «не хватит на надетое» — разные корни.
      const code = reasonClass(rep.reason) === 'rule' ? normReason(rep.reason ?? '').replace(/«.*$/, '').trim().slice(0, 40) : reasonClass(rep.reason);
      if (sy.all && !rep.ok) g.violate(`parity:enabled-refused:paperdoll:${code}`, `${res}: пупсик пустил`);
      if (rep.ok && g.srv().equipment[cell]?.uid !== item.uid) g.violate('parity:paperdoll-wrong-cell', `${res}: сервер надел не в ${cell}`);
      return res;
    }
    // Не ушла: отказ — строкой в окне, вещь на курсоре; где сервер надел бы брошенное (своя ячейка, вторая рука с целью), — проба той же командой.
    if (!note) g.violate('ui:paperdoll-silent', `${desc}: команда не ушла, а окно молчит`);
    if (!held) g.violate('ui:paperdoll-dropped', `${desc}: команда не ушла, а вещь слетела с курсора`);
    if (cell !== 'offhand' && cell !== item.slot) return `${desc} → ячейка чужая: «${note}»`;
    g.probe = true;
    const rep = await g.request({ cmd: 'equip', uid: item.uid, ...(cell === 'offhand' ? { slot: 'offhand' as const } : {}) });
    g.probe = false;
    if (!rep) return `${desc}: проба без ответа`;
    const res = `${desc} → пупсик «${note}», сервер ${rep.ok ? 'надел' : `отказал «${rep.reason}»`}`;
    g.tally('paperdoll', false, rep);
    if (sy.all && rep.ok) g.violate('parity:disabled-accepted:paperdoll', res);
    return res;
  } finally {
    clearHeld();
    g.probe = false;
    g.body.children = [];
  }
}

/**
 * ⭐ R19-07: «СБРОСИТЬ АТРИБУТЫ» МАСТЕРА — настоящая кнопка `respecAttrsButton`. Часто герой в вещи, которая держится на вложенных очках (её
 * требование выше старта героя, атрибут поднят ровно под него — как очки, вложенные ради неё), иногда золото у края цены. Инвариант (1): горит ⇒
 * сервер сбросил (`parity:enabled-refused:respec`); погашена ⇒ сервер отказывает и сам (проба той же командой, `parity:disabled-accepted:respec`),
 * а подсказка кнопки — его причина (`ui:respec-title`).
 */
async function opRespec(g: Rig, r: Rng): Promise<string> {
  const s = g.srv();
  const cost = g.reg.get('balance').respecCost;
  const notes: string[] = [];
  const start = s.startAttributes ?? legacyStartAttributes(g.reg, s);
  const worn = (Object.values(s.equipment).filter(Boolean) as Item[]).filter((it) => !it.parts);
  if (start && worn.length && r.chance(0.4)) {
    const it = r.pick(worn);
    const a = r.pick(ATTRIBUTES);
    const need = Math.max(s.attributes[a], start[a] + r.int(1, 8));
    it.requirements = { ...it.requirements, [a]: need };
    s.attributes[a] = need + r.pick([0, 0, 1]);
    notes.push(`«${it.name}» требует ${a} ${need}`);
  }
  // Игрок послушал подсказку «сперва сними её»: снял мешающее ядром (как команда `unequip`) — иначе вещь, раз надетая на вложенные очки, гасит
  // кнопку до конца цепочки, и горящих почти нет.
  if (r.chance(0.4)) {
    for (let k = 0; k < 4; k++) {
      const name = /^После сброса.*«(.+)»/.exec(respec(g.reg, structuredClone(s), cost).reason ?? '')?.[1];   // отказ ядра — на копии
      const slot = name ? (Object.keys(s.equipment) as EquipSlot[]).find((sl) => s.equipment[sl]?.name === name) : undefined;
      if (!slot || !unequip(g.reg, s, slot).ok) break;
      notes.push(`снял «${name}»`);
    }
  }
  // Золото — у края цены или накоплено на сброс (иначе погашенных «не хватает золота» больше, чем горящих).
  const gold0 = s.gold;
  if (r.chance(0.25)) s.gold = Math.max(0, cost + r.pick([-1, 0, 1]));
  else if (s.gold < cost && r.chance(0.7)) s.gold = cost + r.int(0, 5000);
  if (s.gold !== gold0) notes.push(`золота было ${gold0}`);
  if (notes.length) await g.pushSave();
  const sy = g.synced();
  const strict = sy.cfg && sy.save;   // сброс не зависит ни от сундука, ни от кода цен кузницы и лавки
  const b = g.render('respecAttrs', () => respecAttrsButton(g.app)) as unknown as El | null;
  if (!b) return 'сброс: кнопка бросила';
  const on = !b.disabled;
  const desc = `сброс атрибутов (${cost} зол., золото ${s.gold}${notes.length ? `; ${notes.join(', ')}` : ''}) — кнопка ${on ? 'горит' : `погашена «${b.title}»`}`;
  const at = g.sent.length;
  g.prompts = [];
  g.confirmAnswer = r.chance(0.92);
  try {
    b.click();
    await g.flush();
    const sent = g.sent.slice(at).filter((x) => x.command.cmd === 'respec');
    if (!on) {
      if (sent.length) g.violate('ui:respec-disabled-sent', `${desc}: погашенная кнопка послала команду`);
      g.probe = true;
      const rep = await g.request({ cmd: 'respec', maxGold: cost });
      g.probe = false;
      if (!rep) return `${desc}: проба без ответа`;
      const res = `${desc} → сервер ${rep.ok ? 'сбросил' : `отказал «${rep.reason}»`}`;
      g.tally('respec', false, rep);
      if (!rep.ok) g.count(`respec:off:${normReason(rep.reason ?? '').replace(/«.*$/, '').trim().slice(0, 30)}`);
      if (strict && rep.ok) g.violate('parity:disabled-accepted:respec', res);
      if (strict && !rep.ok && !b.title.startsWith(rep.reason ?? '')) g.violate('ui:respec-title', `${res}: подсказка кнопки «${b.title}»`);
      return res;
    }
    if (!g.confirmAnswer) {
      if (sent.length) g.violate('ui:respec-despite-no', `${desc}: «нет» на вопрос, а сброс ушёл`);
      return `${desc} → отменено`;
    }
    if (sent.length !== 1) { g.violate('ui:no-command:respec', `${desc}: ушло команд ${sent.length}`); return desc; }
    const rep = g.replies.get(sent[0]!.id);
    if (!rep) return `${desc}: ответа нет`;
    const res = `${desc} → ${rep.ok ? 'сброшено' : `отказ «${rep.reason}»`}`;
    g.tally('respec', true, rep);
    const code = reasonClass(rep.reason) === 'rule' ? normReason(rep.reason ?? '').replace(/«.*$/, '').trim().slice(0, 40) : reasonClass(rep.reason);
    if (strict && !rep.ok) g.violate(`parity:enabled-refused:respec:${code}`, res);
    return res;
  } finally {
    g.probe = false;
  }
}

// ── Состояние ─────────────────────────────────────────────────────────────────────────────────────

async function opLoot(g: Rig, r: Rng): Promise<string> {
  const s = g.srv();
  const it = foundItem(g.reg, r, { weapon: r.chance(0.45), near: s.level });
  if (!addToInventory(s.inventory, it, g.reg.get('balance').inventory)) return 'добыча: сумка полна';
  await g.pushSave();
  return `добыча: «${it.name}» ${it.rarity}${it.broken ? ' сломана' : ''} ${it.tier ?? ''}`;
}

/** Скованная вещь «из прошлого» — ТЕМ ЖЕ ядром ковки, ступень и форма случайны; бывает зачарована, с перекатками (сломанной — нет: ломается только трофей с пола). */
async function opLootCrafted(g: Rig, r: Rng): Promise<string> {
  const reg = g.reg;
  const classes = reg.get('weapon-anatomy').map((a) => a.id);
  const cls = r.pick(classes);
  const fams = familiesOf(reg, cls);
  const hands = fams.length ? r.pick(fams) : 1;
  const parts: CraftParts | null = defaultParts(reg, cls, hands, r.int(1, 5));
  if (!parts) return `скованное: у ${cls}/${hands} нет сборки`;
  if (r.chance(0.5)) {
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = variantsFor(reg, cls, slot, hands);
      if (slot !== keySlotOf(reg, cls) && pool.length) parts[slot] = { id: r.pick(pool).id, step: parts[slot].step };
    }
  }
  const input: CraftInput = { weaponClass: cls, hands, parts, finish: r.int(0, Math.max(0, reg.get('balance').craft.finish.length - 1)) };
  const pv = craftWeapon(reg, input, { rng: r, materialsOn: true });
  if (!pv.ok || !pv.item) return `скованное: ${cls}/${hands} не куётся (${pv.reason})`;
  let it: Item = pv.item;
  if (r.chance(0.35)) {
    const rar = r.chance(0.5) ? 'magic' : 'rare';
    if (canEnchantItem(reg, it, rar).ok) it = enchantItem(reg, it, rar, r) ?? it;
  }
  if (r.chance(0.1)) it.rerolls = r.int(1, reg.get('balance').forgePrices.rerollLimit);
  const s = g.srv();
  if (!addToInventory(s.inventory, it, reg.get('balance').inventory)) return 'скованное: сумка полна';
  await g.pushSave();
  return `скованное: «${it.name}» ${it.rarity}${it.broken ? ' сломана' : ''}`;
}

async function opMats(g: Rig, r: Rng): Promise<string> {
  const mats = g.reg.get('craft-materials');
  const pick = r.chance(0.6) ? mats.filter((m) => m.tier <= 3) : mats;
  const lines: string[] = [];
  const toBag = r.chance(0.4);
  const s = g.srv();
  const st = g.dbStash();
  for (let n = r.int(1, 6); n > 0; n--) {
    const m = r.pick(pick);
    const k = r.chance(0.2) ? r.int(100, 900) : r.int(1, 60);
    if (toBag) {
      const stack = materialItem(m, Math.min(k, g.reg.get('balance').inventory.materialStack), `mat-${g.seed}-${g.step}-${n}-${m.id}`);
      if (addToInventory(s.inventory, stack, g.reg.get('balance').inventory)) lines.push(`${m.id}×${stack.count} в сумку`);
    } else {
      (st.materials ??= {})[m.id] = (st.materials[m.id] ?? 0) + k;
      lines.push(`${m.id}×${k} в сундук`);
    }
  }
  if (toBag) await g.pushSave(); else await g.pushStash();
  return `сырьё: ${lines.join(', ') || 'не влезло'}`;
}

async function opGold(g: Rig, r: Rng): Promise<string> {
  const s = g.srv();
  s.gold = r.pick([0, r.int(1, 400), r.int(400, 6000), r.int(6000, 90_000), 10_000_000]);
  await g.pushSave();
  return `золото: ${s.gold}`;
}

/** Цена, которую окно показывает сейчас (бенч, ковка, прилавок, зачарование) — для шагов «ровно на цене». */
function someShownPrice(g: Rig, r: Rng, craftBias = 0): { gold?: number; mats?: Record<string, number>; what: string; st?: CraftWindowState } {
  const reg = g.app.config;
  const save = g.cli();
  const x = r.chance(craftBias) ? 1 : r.int(0, 3);
  if (x === 0 && save.inventory.length) {
    const it = pickBagItem(save.inventory, r)!;
    const acts = benchActions(reg, it, save.gold, save.inventory, g.app.stash?.materials ?? {}).filter((a) => a.gold !== undefined || a.materials);
    if (acts.length) { const a = r.pick(acts); return { gold: a.gold, mats: a.materials, what: `${a.title} «${it.name}»` }; }
  }
  if (x === 1) {
    const w = pickWindow(g, r, 'ok');
    if (w?.pv?.cost) return { gold: w.pv.cost.gold, mats: w.pv.cost.materials, what: `ковка ${w.st.weaponClass}/${w.st.hands} «${w.pv.item?.name ?? '?'}»`, st: w.st };
  }
  if (x === 2 && g.app.shopStock.length) {
    const it = r.pick(g.app.shopStock);
    return { gold: g.app.shopPrice(it), what: `прилавок «${it.name}»` };
  }
  const crafted = save.inventory.filter(isCrafted);
  if (crafted.length) {
    const it = r.pick(crafted);
    const rar = r.chance(0.5) ? 'magic' : 'rare';
    return { gold: enchantCost(reg, it, rar), what: `зачарование «${it.name}»` };
  }
  const it = save.inventory.find(nonMat);
  if (it) return { gold: forgeGold(reg, it, it.broken ? 'repair' : 'upgrade'), mats: it.broken ? repairCost(reg, it) : upgradeCost(reg, it), what: `кузница «${it.name}»` };
  return { what: 'нечего' };
}

async function opGoldEdge(g: Rig, r: Rng): Promise<string> {
  const p = someShownPrice(g, r);
  if (p.gold === undefined) return `золото на грани: ${p.what}`;
  const s = g.srv();
  s.gold = Math.max(0, p.gold + r.pick([-1, 0, 0, 1]));
  await g.pushSave();
  return `золото на грани: ${s.gold} (цена ${p.gold}: ${p.what})`;
}

async function opMatsEdge(g: Rig, r: Rng): Promise<string> {
  const p = someShownPrice(g, r);
  const ids = Object.keys(p.mats ?? {});
  if (!ids.length) return `сырьё на грани: ${p.what} без сырья`;
  const id = r.pick(ids);
  const target = Math.max(0, p.mats![id]! + r.pick([-1, 0, 0, 1]));
  const s = g.srv(), st = g.dbStash();
  const bag = s.inventory.filter((it) => it.kind === 'material' && it.materialId === id).reduce((n, it) => n + (it.count ?? 1), 0);
  const w = st.materials ?? (st.materials = {});
  let touchedBag = false;
  if (target >= bag) w[id] = target - bag;
  else { s.inventory = s.inventory.filter((it) => !(it.kind === 'material' && it.materialId === id)); touchedBag = true; w[id] = target; }
  if (w[id] === 0) delete w[id];
  if (touchedBag) await g.pushSave();
  await g.pushStash();
  return `сырьё на грани: ${id} = ${target} (надо ${p.mats![id]}: ${p.what})`;
}

/** Хватает на то, что окно показывает: золото и всё сырьё — с запасом или ровно (одна строка на грани). */
async function opFund(g: Rig, r: Rng): Promise<string> {
  const p = someShownPrice(g, r, 0.5);
  if (p.st) g.funded = structuredClone(p.st);   // игрок копит на то, что хочет сковать
  const s = g.srv(), st = g.dbStash();
  const lines: string[] = [];
  if (p.gold !== undefined) { s.gold = Math.max(s.gold, p.gold + r.pick([0, 0, 1, 50, 5000])); lines.push(`золото ${s.gold}`); }
  const w = st.materials ?? (st.materials = {});
  for (const [id, need] of Object.entries(p.mats ?? {})) {
    const bag = s.inventory.filter((it) => it.kind === 'material' && it.materialId === id).reduce((n, it) => n + (it.count ?? 1), 0);
    const target = need + r.pick([0, 0, 1, 7, 100]);
    if (bag + (w[id] ?? 0) < target) w[id] = Math.max(0, target - bag);
    lines.push(`${id} ≥ ${target}`);
  }
  await g.pushSave();
  await g.pushStash();
  return `хватает на ${p.what}: ${lines.join(', ') || '—'}`;
}

async function opJournal(g: Rig, r: Rng): Promise<string> {
  const st = g.dbStash();
  const j = normalizeJournal(st.forgeJournal);
  const x = r.next();
  let what: string;
  if (x < 0.35) {
    const full = fullJournal(g.reg);
    st.forgeJournal = { ...j, bases: full.bases, variants: r.chance(0.7) ? full.variants : full.variants.filter(() => r.chance(0.7)), tierHi: Math.max(j.tierHi, r.int(2, full.tierHi)) };
    what = 'почти всё открыто';
  } else if (x < 0.6) {
    const bases = g.reg.get('items.base').filter((b) => b.kind === 'weapon');
    for (let n = r.int(1, 4); n > 0; n--) { const b = r.pick(bases); if (!j.bases.includes(b.id)) j.bases.push(b.id); }
    const parts = g.reg.get('weapon-parts');
    for (let n = r.int(2, 12); n > 0; n--) { const p = r.pick(parts); if (!j.variants.includes(p.id)) j.variants.push(p.id); }
    st.forgeJournal = j;
    what = 'пара баз и деталей';
  } else if (x < 0.85) {
    j.sketches += r.int(1, 3);
    st.forgeJournal = j;
    what = `эскизов ${j.sketches}`;
  } else {
    j.tierHi = r.int(0, 6);
    j.mythic = r.int(0, g.reg.get('balance').craft.journal.mythicSalvages);
    st.forgeJournal = j;
    what = `потолок t${j.tierHi}, мификов ${j.mythic}`;
  }
  await g.pushStash();
  return `журнал: ${what}`;
}

/**
 * ПРАВКА КОНФИГА ЖИВЬЁМ — как хозяин из редактора, в ОБЕ стороны (игроку и лучше, и хуже): галки сырья, деталей, баз, ступеней,
 * аффиксов и `craft.live`; цены кузницы, ковки, зачарования, скупки; выход разбора и переплавки; доводка; ёмкость; вилка броска;
 * множители ступени и редкости; потолок требований; откат к умолчанию. Негодное отвергает схема (как и в игре). Клиент
 * перечитывает конфиг не всегда: иначе окно видит прежний, и строгие проверки уступают согласию на цену.
 */
function editConfig(reg: ConfigRegistry, r: Rng): string {
  const f = (x: number): number => Math.max(0, Math.round(x * r.pick([0.5, 0.8, 1.25, 1.5, 2])));
  type Row = { id: string; enabled?: boolean };
  const flip = (key: 'craft-materials' | 'weapon-parts' | 'items.base' | 'item-tiers' | 'affixes', n = 1): string => {
    const ids: string[] = [];
    reloadTable(reg, key, (t) => {
      for (let k = 0; k < n; k++) {
        const row = r.pick(t as readonly Row[]) as Row | undefined;
        if (row) { row.enabled = row.enabled === false; ids.push(`${row.id}→${row.enabled ? 'вкл' : 'выкл'}`); }
      }
    });
    return `${key}: ${ids.join(', ')}`;
  };
  const x = r.int(0, 23);
  switch (x) {
    case 0: { let v = false; reloadTable(reg, 'balance', (b) => { b.craft.live = v = !b.craft.live; }); return `craft.live → ${v}`; }
    case 1: case 2: return flip('craft-materials');
    case 3: return flip('weapon-parts', r.int(1, 4));
    case 4: return flip('items.base');
    case 5: return flip('item-tiers');
    case 6: return flip('affixes', r.int(1, 30));
    case 7: { let d = ''; reloadTable(reg, 'craft-materials', (t) => { const m = r.pick(t); m.sellPrice = Math.max(1, f(m.sellPrice)); d = `${m.id}.sellPrice → ${m.sellPrice}`; }); return d; }
    case 8: {
      let d = '';
      reloadTable(reg, 'balance', (b) => {
        const fp = b.forgePrices;
        const k = r.pick(['upgradeTier', 'repairBroken', 'rerollAffix'] as const);
        fp[k] = Math.max(1, f(fp[k]));
        d = `forgePrices.${k} → ${fp[k]}`;
      });
      return d;
    }
    case 9: {
      let d = '';
      reloadTable(reg, 'balance', (b) => {
        const fp = b.forgePrices;
        const which = r.pick(['upgradeMaterials', 'repairMaterials'] as const);
        const t = r.pick(['tier1', 'tier2', 'tier3'] as const);
        fp[which][t] = Math.max(0, fp[which][t] + r.int(-2, 4));
        d = `forgePrices.${which}.${t} → ${fp[which][t]}`;
      });
      return d;
    }
    case 10: { let d = ''; reloadTable(reg, 'balance', (b) => { b.forgePrices.rerollLimit = Math.max(0, b.forgePrices.rerollLimit + r.int(-1, 1)); b.forgePrices.upgradeReqDiscount = r.pick([0, 0.1, 0.2, 0.35]); d = `rerollLimit ${b.forgePrices.rerollLimit}, скидка требований ${b.forgePrices.upgradeReqDiscount}`; }); return d; }
    case 11: {
      let d = '';
      reloadTable(reg, 'balance', (b) => {
        const c = b.craft;
        const y = r.int(0, 2);
        if (y === 0) { const sl = r.pick(['strike', 'grip', 'bind', 'head'] as const); c.cost.units[sl] = Math.max(0, c.cost.units[sl] + r.int(-3, 6)); d = `craft.cost.units.${sl} → ${c.cost.units[sl]}`; }
        else if (y === 1) { c.cost.goldPerReqMult = Math.max(1, f(c.cost.goldPerReqMult)); d = `craft.cost.goldPerReqMult → ${c.cost.goldPerReqMult}`; }
        else { c.cost.enchantGold = Math.max(1, f(c.cost.enchantGold)); d = `craft.cost.enchantGold → ${c.cost.enchantGold}`; }
      });
      return d;
    }
    case 12: {
      let d = '';
      reloadTable(reg, 'balance', (b) => {
        const row = r.pick(b.craft.finish);
        if (row.floor > 0 || row.strikeUnits > 0) {
          row.floor = Math.min(0.95, Math.max(0.05, Math.round((row.floor + r.pick([-0.15, 0.1, 0.2])) * 100) / 100));
          row.strikeUnits = Math.max(0, row.strikeUnits + r.int(-2, 4));
          row.goldMult = Math.max(1, Math.round((row.goldMult + r.pick([-0.25, 0.25, 0.5])) * 100) / 100);
        }
        d = `доводка ${row.id} → пол ${row.floor}, +${row.strikeUnits}, ×${row.goldMult}`;
      });
      return d;
    }
    case 13: {
      let d = '';
      reloadTable(reg, 'balance', (b) => {
        const c = b.craft;
        const y = r.int(0, 3);
        if (y === 0) { const sl = r.pick(['strike', 'grip', 'bind', 'head'] as const); c.salvage.units[sl] = Math.max(0, c.salvage.units[sl] + r.int(-1, 2)); d = `разбор: ${sl} → ${c.salvage.units[sl]}`; }
        else if (y === 1) { c.melt.share = r.pick([0.2, 0.4, 0.6, 0.8]); d = `переплавка → ${c.melt.share}`; }
        else if (y === 2) { b.salvage.fieldYield = r.pick([0.05, 0.15, 0.3, 0.5]); d = `поле → ${b.salvage.fieldYield}`; }
        else { c.journal.sketchAfter = Math.max(1, c.journal.sketchAfter + r.int(-6, 4)); c.journal.mythicSalvages = Math.max(1, c.journal.mythicSalvages + r.int(-3, 3)); d = `журнал: эскиз каждые ${c.journal.sketchAfter}, мификов ${c.journal.mythicSalvages}`; }
      });
      return d;
    }
    case 14: { let d = ''; reloadTable(reg, 'balance', (b) => { const k = r.int(0, b.craft.capacityByTier.length - 1); b.craft.capacityByTier[k] = Math.max(0, Math.min(5, b.craft.capacityByTier[k]! + r.int(-2, 2))); d = `ёмкость t${k} → ${b.craft.capacityByTier[k]}`; }); return d; }
    case 15: { let d = ''; reloadTable(reg, 'balance', (b) => { b.loot.baseRoll.weapon = r.pick([0, 0.05, 0.15, 0.3]); b.loot.baseRoll.armor = r.pick([0, 0.1, 0.2, 0.35]); d = `вилка броска ${b.loot.baseRoll.weapon}/${b.loot.baseRoll.armor}`; }); return d; }
    case 16: { let d = ''; reloadTable(reg, 'item-tiers', (t) => { const tt = r.pick(t); tt.statMult = Math.max(0.3, Math.round(tt.statMult * r.pick([0.8, 1.2]) * 100) / 100); tt.reqMult = Math.max(0.3, Math.round(tt.reqMult * r.pick([0.8, 1, 1.25]) * 100) / 100); d = `${tt.id}: statMult ${tt.statMult}, reqMult ${tt.reqMult}`; }); return d; }
    case 17: { let d = ''; reloadTable(reg, 'rarities', (t) => { const rr = r.pick(t); rr.priceMult = Math.max(0.5, Math.round(rr.priceMult * r.pick([0.5, 1.5, 2]) * 100) / 100); d = `${rr.id}.priceMult → ${rr.priceMult}`; }); return d; }
    case 18: { let d = ''; reloadTable(reg, 'balance', (b) => { b.maxTotalRequirement = Math.max(40, b.maxTotalRequirement + r.pick([-60, -30, 30])); d = `потолок требований → ${b.maxTotalRequirement}`; }); return d; }
    case 19: {
      let d = '';
      reloadTable(reg, 'salvage-rules', (t) => {
        const rule = r.pick(t as unknown as { id?: string; yields?: { min: number; max: number }[] }[]);
        const y = rule.yields?.length ? r.pick(rule.yields) : undefined;
        if (y) { y.min = Math.max(0, y.min + r.int(-1, 1)); y.max = Math.max(y.min, y.max + r.int(-1, 2)); d = `правило разбора ${rule.id ?? '?'}: ${y.min}–${y.max}`; }
      });
      return d || 'правило разбора: без строк';
    }
    case 20: { let d = ''; reloadTable(reg, 'rarities', (t) => { const rr = r.pick(t.filter((q) => q.id === 'magic' || q.id === 'rare')); if (rr) { rr.maxAffixes = Math.max(rr.minAffixes, rr.maxAffixes + r.int(-1, 1)); d = `${rr.id}.maxAffixes → ${rr.maxAffixes}`; } }); return d; }
    case 21: {
      // Хозяин снял с игры целое гнездо класса («копья — позже»): все его варианты выключены.
      const cls = r.pick(reg.get('weapon-anatomy').map((a) => a.id));
      const slot = r.pick(CRAFT_SLOT_LIST);
      let n = 0;
      reloadTable(reg, 'weapon-parts', (t) => { for (const p of t) if (p.slot === slot && (p.classes as string[]).includes(cls)) { p.enabled = false; n++; } });
      return `weapon-parts: всё гнездо ${slot} класса ${cls} выключено (${n})`;
    }
    case 22: {
      // Доводка: строку убрали или добавили (индексы окна и заявки сдвигаются).
      let d = '';
      reloadTable(reg, 'balance', (b) => {
        const f = b.craft.finish;
        if (f.length > 1 && r.chance(0.5)) { const gone = f.pop()!; d = `доводка: строка ${gone.id} убрана (${f.length})`; }
        else if (f.length < 6) { f.push({ id: `fz-${f.length}`, name: `Доводка ${f.length}`, floor: r.pick([0.2, 0.5, 0.9]), strikeUnits: r.int(0, 12), goldMult: r.pick([1, 1.3, 2.5]) }); d = `доводка: добавлена строка (${f.length})`; }
      });
      return d || 'доводка: без правки';
    }
    default: {
      (reg as unknown as { data: Tables }).data = { ...pristineTables() };
      return 'конфиг — по умолчанию';
    }
  }
}

async function opConfig(g: Rig, r: Rng): Promise<string> {
  let d: string;
  try { d = editConfig(g.reg, r); } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!/валидаци|invalid|Expected|Number must|too_small|too_big/i.test(msg)) throw e;
    return `конфиг: правка отвергнута схемой (${msg.slice(0, 60)})`;
  }
  g.cfgVer++;
  const sync = r.chance(0.6);
  if (sync) g.syncClientConfig();
  return `конфиг: ${d}${sync ? ' (клиент перечитал)' : ' (клиент НЕ перечитал)'}`;
}

/**
 * Сундук аккаунта поменял ДРУГОЙ герой (второе окно, другая нода): кошелёк или журнал в базе уже другие, а кадра этому клиенту нет —
 * его кузница видит прежний слепок до следующего открытия. Строгие проверки уступают согласию на цену.
 */
async function opStashDrift(g: Rig, r: Rng): Promise<string> {
  const st = g.dbStash();
  const w = st.materials ?? (st.materials = {});
  const ids = Object.keys(w);
  g.drift = true;
  if (ids.length && r.chance(0.7)) {
    const id = r.pick(ids);
    w[id] = Math.max(0, (w[id] ?? 0) - r.int(1, Math.max(1, w[id] ?? 1)));
    if (!w[id]) delete w[id];
    return `сундук: другой герой взял ${id} (осталось ${w[id] ?? 0}) — кадра нет`;
  }
  const m = r.pick(g.reg.get('craft-materials'));
  w[m.id] = (w[m.id] ?? 0) + r.int(1, 80);
  return `сундук: другой герой положил ${m.id} — кадра нет`;
}

async function opClientSync(g: Rig): Promise<string> { g.syncClientConfig(); return 'клиент перечитал конфиг'; }
async function opShopRefresh(g: Rig): Promise<string> {
  (g.room as unknown as { showShop(): void }).showShop();
  await g.flush();
  return 'прилавок разослан заново';
}
/**
 * Сломанный трофей с тела. Сломанным вещь бывает ТОЛЬКО с пола (`GameSession.killMonster`: трофей, не уник) — ни скованная, ни
 * купленная, ни надетая не ломаются; поэтому ломать вещи сумки задним числом прогон не вправе.
 */
async function opBreak(g: Rig, r: Rng): Promise<string> {
  const s = g.srv();
  let it: Item | undefined;
  for (let k = 0; k < 12 && !it; k++) { const x = foundItem(g.reg, r, { weapon: r.chance(0.6), near: s.level }); if (x.rarity !== 'unique' && x.kind !== 'consumable') it = x; }
  if (!it) return 'сломанный трофей: не выпал';
  it.broken = true;
  if (!addToInventory(s.inventory, it, g.reg.get('balance').inventory)) return 'сломанный трофей: сумка полна';
  await g.pushSave();
  return `сломанный трофей «${it.name}» ${it.rarity} ${it.tier ?? ''}`;
}
async function opBagFill(g: Rig, r: Rng): Promise<string> {
  const s = g.srv();
  const dims = g.reg.get('balance').inventory;
  let n = 0;
  for (let k = 0; k < 40; k++) {
    const it = foundItem(g.reg, r, { near: s.level });
    if (addToInventory(s.inventory, it, dims)) n++;
    else if (r.chance(0.5)) break;
  }
  await g.pushSave();
  return `сумка забита: +${n}`;
}
async function opEquip(g: Rig, r: Rng): Promise<string> {
  const pool = g.cli().inventory.filter((it) => nonMat(it) && it.kind !== 'consumable' && !it.broken);
  if (!pool.length) return 'надеть: нечего';
  const it = pool.find(isCrafted) && r.chance(0.6) ? r.pick(pool.filter(isCrafted)) : r.pick(pool);
  const rep = await g.request({ cmd: 'equip', uid: it.uid });
  return `надеть «${it.name}» → ${rep?.ok ? 'ок' : `отказ «${rep?.reason}»`}`;
}
/**
 * ⭐ R16-08: ГЕРОЙ В ВЕЩАХ С ПРИБАВКОЙ К АТРИБУТАМ. Находка с «+Сила» (и т. п.) надета законным путём — ядром `equip` по сейву сервера
 * (атрибуты под её требования — как вложенные очки); оружие — иногда во вторую руку. Без таких вещей грани пупсика не встречаются:
 * вторая рука, которую снимет двуручник, подпирает требование, а смена вещи оставляет другую надетую без опоры.
 */
async function opWear(g: Rig, r: Rng): Promise<string> {
  const s = g.srv();
  // Прибавка — чаще к тому, что требует оружие (Сила, Ловкость, Интеллект): иначе она ни одной грани не подпирает.
  const want = r.pick(['strength', 'strength', 'dexterity', 'intelligence', 'vitality']);
  const boosts = (it: Item): boolean => modifiersFromItems([it]).some((m) => m.kind === 'flat' && m.value > 0 && m.stat === want);
  // Чаще — вторая рука (щит или одноручное оружие): её снимает двуручник, и её прибавку пупсик обязан не считать.
  const offhand = r.chance(0.5);
  const fits = (x: Item): boolean => !offhand || x.slot === 'offhand' || (x.slot === 'weapon' && (x.hands ?? 1) < 2 && !x.versatile);
  let it: Item | undefined;
  for (let k = 0; k < 150 && !it; k++) {
    const x = foundItem(g.reg, r, { near: s.level, weapon: !offhand && r.chance(0.3) });
    if (x.slot && !x.broken && x.kind !== 'consumable' && boosts(x) && fits(x)) it = x;
  }
  if (!it) return 'надел с прибавкой: не выпало';
  if (!addToInventory(s.inventory, it, g.reg.get('balance').inventory)) return 'надел с прибавкой: сумка полна';
  for (const a of ATTRIBUTES) s.attributes[a] = Math.max(s.attributes[a], it.requirements?.[a] ?? 0);
  // Вторую руку запирает двуручник в основной — сперва снять его (ядром, как игрок).
  if (offhand && offhandRefusal(it, s.equipment.weapon) === 'Занято двумя руками') unequip(g.reg, s, 'weapon');
  const rep = equip(g.reg, s, it.uid, offhand && it.slot === 'weapon' ? 'offhand' : undefined);
  await g.pushSave();
  return `надел с прибавкой «${it.name}» (${it.slot}) → ${rep.ok ? 'ок' : `отказ «${rep.reason}»`}`;
}
async function opUnequip(g: Rig, r: Rng): Promise<string> {
  const slots = Object.entries(g.cli().equipment).filter(([, v]) => v).map(([k]) => k);
  if (!slots.length) return 'снять: нечего';
  const slot = r.pick(slots);
  const rep = await g.request({ cmd: 'unequip', slot } as TownCommand);
  return `снять ${slot} → ${rep?.ok ? 'ок' : `отказ «${rep?.reason}»`}`;
}

/**
 * ⭐ R18-08: ДЕПЛОЙ СО СМЕНОЙ КОДА ЦЕН при том же теле конфига. Сервер — новой сборки (свой штамп в `joined.build`) и считает цену кузницы и
 * скупки по-новому, вкладка переподключилась САМА (L2 / R3-25) со старым бандлом: её карточки считают старой формулой (дешевле ковку, щедрее
 * скупку — такую сервер отказывает «Цена изменилась»). Инвариант (5): игроку «перезагрузите» на входе и на каждый такой отказ. Следующий шаг
 * `deploy` — игрок перезагрузил страницу: бандл новой сборки, формулы те же, что у сервера.
 */
async function opDeploy(g: Rig, r: Rng): Promise<string> {
  if (!g.codeDrift) {
    buildHook.server = `${g.stamp}+deploy${++g.deploys}`;
    buildHook.drift = { forge: 0.5 + r.next() * 0.4, sell: 1.15 + r.next() * 0.85 };
    const hints = g.hints;
    await g.reconnect();
    if (buildHook.stamp && g.hints === hints) g.violate('hint:deploy-untold', 'деплой сменил код цен, вкладка переподключилась со старым бандлом — «перезагрузите» не сказано');
    if (!buildHook.stamp && g.hints === hints) g.violate('hint:deploy-untold', 'вкладка без штампа (до правки R18-08): деплой, сменивший код цен, прошёл молча');
    return `деплой: код цен сервера другой (кузница ×${(1 / buildHook.drift.forge).toFixed(2)}, скупка ×${(1 / buildHook.drift.sell).toFixed(2)}), конфиг тот же; вкладка переподключилась со старым бандлом`;
  }
  buildHook.drift = null;
  G_BUILD.__DM_BUILD__ = buildHook.stamp ? buildHook.server ?? g.stamp : '';
  await g.reconnect();
  return 'игрок перезагрузил страницу: бандл той же сборки, что сервер';
}

const EXEC: Record<OpKind, (g: Rig, r: Rng) => Promise<string>> = {
  bench: opBench, craft: opCraft, windowEnchant: opWindowEnchant, sketch: opSketch, buy: opBuy, sell: opSell, field: opField, paperdoll: opPaperdoll, respec: opRespec,
  loot: opLoot, lootCrafted: opLootCrafted, mats: opMats, gold: opGold, goldEdge: opGoldEdge, matsEdge: opMatsEdge, journal: opJournal,
  config: opConfig, clientSync: opClientSync, shopRefresh: opShopRefresh, breakItem: opBreak, bagFill: opBagFill, equip: opEquip, unequip: opUnequip, fund: opFund,
  wear: opWear, stashDrift: opStashDrift, deploy: opDeploy,
};

/** Для отчёта: подписи шагов сжатой цепочки (прогон с журналом). */
export function describeOps(ops: readonly Op[]): string { return ops.map((o) => `${o.k}#${o.s}`).join(' '); }
export { regFrom };
