import {
  CRAFT_SLOT_LIST, availableMaterials, emptyJournal,
  type ConfigRegistry, type CraftInput, type CraftJournal, type CraftParts, type Item, type Rarity, type SaveState, type TownCommand,
} from '@dm/shared';
import type { CmdReply } from '../../net/cmdReplies.js';
import type { CraftHost, CraftReply } from './craftPanel.js';

/**
 * ⭐ ИГРОВОЙ ХОЗЯИН ОКНА КОВКИ: то же окно (`craftPanel.ts`), что в песочнице редактора, но всё
 * настоящее — сырьё из сумки и кошелька аккаунта, золото и вещь из сейва, журнал из кадра `stash`,
 * а ковка и зачарование — КОМАНДАМИ серверу с ожиданием `cmdResult`. Сам хозяин ничего не решает и
 * ничего не пишет: истина — сервер, его сейв приходит раньше ответа (D3).
 *
 * ⚠ КЛЮЧ ЗАЯВКИ (`nonce`, D4). Сервер помнит последние ключи на АККАУНТЕ: повтор ключа отвечает
 * прежней вещью и ничего не списывает. Поэтому ключ живёт, пока итог заявки не ПОДТВЕРЖДЁН:
 * - ответа нет (обрыв, таймаут) или отказ — тот же ключ на повтор ТОЙ ЖЕ сборки: если первая
 *   заявка всё же прошла, повтор не скуёт вторую вещь и не спишет второй раз;
 * - подтверждённый успех — ключ сгорает, следующая ковка той же сборки — новая вещь;
 * - другая сборка — свой ключ: это другая заявка. ⚠ R2-33: ключи ждущих заявок помнятся ПО СБОРКЕ (до
 *   `CRAFT_OPEN_KEEP`), а не одним слотом: раньше проба сборки B после «нет ответа» по A сжигала ключ A, и
 *   возврат к A ковал вторую вещь за вторую цену — вопреки обещанию CRAFT_UNKNOWN. Ключ — ещё и по ГЕРОЮ:
 *   тот же ключ у другого героя аккаунта сервер счёл бы повтором и ответил бы чужой вещью.
 * ⚠ Вторую команду, пока первая в полёте, хозяин не шлёт вовсе (`busy`) — защита сверх погашенной
 * кнопки: окно могли закрыть и открыть заново, а ответ ещё не пришёл.
 *
 * Без DOM и без сети напрямую — только через `ForgeLink`: его гоняют node-тесты с поддельной связью.
 */

/** Что хозяину нужно от `App` — ровно это, чтобы тест подставил подделку. */
export interface ForgeLink {
  readonly config: ConfigRegistry;
  readonly state: { save: SaveState } | null;
  readonly stash: { materials: Record<string, number>; forgeJournal?: CraftJournal } | null;
  readonly net: { readonly connected: boolean };
  request(command: TownCommand, ms?: number): Promise<CmdReply | null>;
}

/**
 * Сколько заявок без подтверждённого успеха помним (R2-33). Старейшая вытесняется — её повтор получит новый ключ.
 * ⚠ Меньше, чем ключей помнит сервер (`CRAFT_NONCES_KEEP`): ключ, который он уже забыл, повтор не защитил бы.
 */
export const CRAFT_OPEN_KEEP = 8;

/** Память хозяина между открытиями окна: открытые заявки и «в полёте». Одна на страницу. */
export interface CraftMemo {
  /** Заявки без подтверждённого успеха: «герой + сборка» → ключ, уходящий на повтор той же сборки. Порядок — возраст. */
  open: Map<string, string>;
  busy: boolean;
}
const pageMemo: CraftMemo = { open: new Map(), busy: false };

/** Нет ответа на ковку — итог неизвестен, но повтор безопасен. */
export const CRAFT_UNKNOWN = 'Нет ответа от кузнеца. Нажми «Ковать» ещё раз: повтор той же заявки не скуёт вторую вещь и не спишет дважды';
const ENCHANT_UNKNOWN = 'Нет ответа от кузнеца. Посмотри вещь в сумке: если она уже зачарована, повтор ничего не спишет';
/** Нет ответа на эскиз: открылась ли деталь, покажет список (кадр сундука придёт с журналом), — повтор открытую не тронет. */
const SKETCH_UNKNOWN = 'Нет ответа от кузнеца. Посмотри список деталей: если деталь открылась, эскиз уже потрачен, а повтор её не тронет';
const OFFLINE = 'Нет связи с сервером';
const BUSY = 'Кузнец ещё работает — дождись ответа';

/**
 * Сборка одной строкой — чтобы узнать «ту же заявку». Порядок гнёзд фиксирован, лишних полей нет,
 * доводка без значения = 0 (так её поймёт и сервер).
 */
export function craftSig(input: CraftInput): string {
  return JSON.stringify([input.weaponClass, input.hands, CRAFT_SLOT_LIST.map((s) => [input.parts[s]?.id, input.parts[s]?.step]), input.finish ?? 0]);
}

/**
 * Заявка на провод — пересобранная из нужных полей: схема сервера строгая, и лишний ключ из состояния
 * окна отказал бы всю ковку «неверной командой».
 */
export function wireInput(input: CraftInput): CraftInput {
  const parts = {} as CraftParts;
  for (const s of CRAFT_SLOT_LIST) parts[s] = { id: input.parts[s].id, step: input.parts[s].step };
  return { weaponClass: input.weaponClass, hands: input.hands, parts, ...(input.finish !== undefined ? { finish: input.finish } : {}) };
}

/**
 * Новый ключ заявки: 32 шестнадцатеричных знака (под `CRAFT_NONCE_RE`). `getRandomValues`, а не
 * `randomUUID`: тот есть только в защищённом контексте, а игру открывают и по http из локальной сети.
 * Секретом ключ не является — он лишь отличает одну заявку аккаунта от другой.
 */
export function newCraftNonce(): string {
  const b = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256) ^ ((Date.now() >>> (i % 4) * 8) & 0xff);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Где вещь: в сумке или надета. */
export function findOwned(save: SaveState, uid: string): { item: Item; inBag: boolean } | null {
  const inBag = save.inventory.find((i) => i.uid === uid);
  if (inBag) return { item: inBag, inBag: true };
  const worn = Object.values(save.equipment).find((i) => i?.uid === uid);
  return worn ? { item: worn, inBag: false } : null;
}

export function gameCraftHost(link: ForgeLink, memo: CraftMemo = pageMemo): CraftHost {
  const save = (): SaveState => link.state!.save;
  /** Общая обвязка команды: одна в полёте, без связи не шлём, без ответа — «неизвестно». */
  const send = async (command: TownCommand, onReply: (r: CmdReply) => CraftReply, unknown: string): Promise<CraftReply> => {
    if (memo.busy) return { ok: false, reason: BUSY };
    if (!link.net.connected) return { ok: false, reason: OFFLINE };
    memo.busy = true;
    try {
      const r = await link.request(command);
      return r ? onReply(r) : { ok: false, unknown: true, reason: unknown };
    } finally {
      memo.busy = false;
    }
  };
  return {
    wallet: () => availableMaterials(save().inventory, link.stash?.materials ?? {}),
    gold: () => save().gold,
    // Журнала ещё нет (кадр `stash` не пришёл) — окно его и не открывает; пустой здесь — только страховка.
    journal: () => link.stash?.forgeJournal ?? emptyJournal(),
    save,
    find: (uid) => (link.state ? findOwned(save(), uid) : null),
    craft: (input, maxGold, maxMaterials) => {
      if (memo.busy) return { ok: false, reason: BUSY };
      // Без связи заявка не уйдёт — и ключа ей не заводим: пустой ключ только вытеснил бы ждущий (R2-33).
      if (!link.net.connected) return { ok: false, reason: OFFLINE };
      const sig = `${link.state?.save.charId ?? ''}|${craftSig(input)}`;
      let nonce = memo.open.get(sig);
      if (!nonce) {
        nonce = newCraftNonce();
        memo.open.set(sig, nonce);
        for (const old of memo.open.keys()) { if (memo.open.size <= CRAFT_OPEN_KEEP) break; memo.open.delete(old); }
      }
      const sent = nonce;
      // R5-15: цена окна — в заявку: дороже сервер не скуёт, а ответит «Цена изменилась: N золота». R8-14: и сырьё окна.
      // Повтор ключа (он не платит) проходит при любой цене.
      return send({ cmd: 'craft', nonce: sent, input: wireInput(input), ...(maxGold !== undefined ? { maxGold } : {}),
        ...(maxMaterials !== undefined ? { maxMaterials } : {}) }, (r) => {
        if (!r.ok) return { ok: false, reason: r.reason ?? 'Кузнец отказал' };
        // ⚠ Ключ сгорает ТОЛЬКО на подтверждённом успехе — и только СВОЙ: ключи других ждущих сборок живут дальше.
        if (memo.open.get(sig) === sent) memo.open.delete(sig);
        const got = r.uid ? findOwned(save(), r.uid) : null;
        // Повтор ключа отвечает прежней вещью — её могли уже продать или разобрать.
        return got ? { ok: true, item: got.item } : { ok: true, reason: 'Скована раньше: этой вещи уже нет в сумке' };
      }, CRAFT_UNKNOWN);
    },
    enchant: (item, rarity: Rarity, maxGold) => {
      if (rarity !== 'magic' && rarity !== 'rare') return { ok: false, reason: 'Зачаровать можно до магической или редкой' };
      return send({ cmd: 'forgeEnchant', uid: item.uid, rarity, ...(maxGold !== undefined ? { maxGold } : {}) }, (r) => {
        if (!r.ok) return { ok: false, reason: r.reason ?? 'Кузнец отказал' };
        const got = findOwned(save(), r.uid ?? item.uid);
        return { ok: true, item: got?.item };
      }, ENCHANT_UNKNOWN);
    },
    // R3-11: эскиз — командой `forgeSketch`; можно ли, решает сервер (`sketchAction`), журнал приходит кадром сундука.
    sketch: (variantId) => send({ cmd: 'forgeSketch', variantId },
      (r) => (r.ok ? { ok: true, reason: r.unlocked?.join(' · ') } : { ok: false, reason: r.reason ?? 'Кузнец отказал' }),
      SKETCH_UNKNOWN),
    // Надеть — обычной командой экипировки, как из инвентаря: требования и занятость рук решает сервер.
    equip: (item) => send({ cmd: 'equip', uid: item.uid },
      (r) => (r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'Не надевается' }),
      'Нет ответа: посмотри экипировку'),
  };
}
