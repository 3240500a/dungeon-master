import { availableMaterials, forgeGold, type Item, type TownCommand } from '@dm/shared';
import type { App } from '../../core/app.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';
import { itemTooltipHtml, itemDescLines } from '../inventory/itemView.js';
import { rarityHex } from '../loot/rarity.js';
import { CELL, glyphOf, getHeld, clearHeld } from '../inventory/heldItem.js';
import { benchActions, benchTarget, diffStrings, type BenchAction } from './forgeActions.js';
import { confirmAll, disposePrompts } from '../inventory/disposeConfirm.js';
import type { CmdReply } from '../../net/cmdReplies.js';

/**
 * ВЕРСТАК КУЗНЕЦА: одна вещь в слоте вместо списка из пятнадцати строк с шестьюдесятью кнопками.
 *
 * Почему слот, а не список: решение всегда про ОДНУ вещь, а список заставлял искать её глазами
 * среди одинаковых рядов, где цена была втиснута в подпись кнопки. Освободившееся место ушло на
 * то, чего в списке не было вовсе, — предпросмотр результата и построчную цену с «чего не хватает».
 *
 * ⚠ ВЕЩЬ НЕ УХОДИТ ИЗ СУМКИ. Слот держит только `uid`: положить — это ВЫБРАТЬ, а не переложить.
 * Поэтому серверной команды на «положить» нет, откатывать нечего, и закрытое окно ничего не теряет.
 *
 * Здесь только отрисовка: что предлагать и что почём — решает чистый `forgeActions.ts`.
 */

/** Цвет «стало» — та же мшистая зелень, что у положительных строк в остальном UI. */
const GOOD = COLORS.good;

export interface BenchOpts {
  /** Выбранная вещь (по uid) и как её сменить. ⚠ Состояние живёт в ПАНЕЛИ: тело окна
   *  перерисовывается на каждое `state:changed`, и локальная переменная очищала бы слот сама. */
  uid: string | null;
  setUid: (uid: string | null) => void;
  /**
   * Строка над верстаком: что открыл в журнале кузнеца последний разбор (§17.1: «открыта новая деталь») или почему
   * последнее действие не вышло (R3-16). Текст — со своим значком: «📖 …» / «⚠ …».
   */
  note?: string;
  setNote?: (note: string) => void;
}

/**
 * ⭐ R3-16: ДЕЙСТВИЕ В ПОЛЁТЕ — одно на страницу. Карточка — div со слушателем, а верстак перерисовывается только кадром
 * сейва: двойной клик по «Реролл» уходил ДВУМЯ платными командами (двойная цена, две из трёх перекаток, первый итог
 * не виден), «Улучшить» — покупал две ступени. Теперь каждое действие ждёт ответа (`app.request`), а пока ждёт — все
 * карточки погашены, нажатая — «⏳». Признак живёт на уровне модуля, а не в `render`: тело кузницы перерисовывается
 * на каждое `state:changed`, и локальная переменная обнулялась бы сама (как `pageMemo.busy` у окна ковки).
 * Ответа нет дольше 8 с — `request` отвечает `null`, и карточки оживают.
 */
let inFlight: { uid: string; key: string } | null = null;
const actionKey = (a: BenchAction): string => `${a.id}${a.rarity ? `:${a.rarity}` : ''}`;
/** Нет ответа: итог неизвестен — действие могло пройти. Повтор безопасен: он уйдёт тем же номером (R4-23). */
const NO_REPLY = 'Нет ответа от кузнеца. Посмотри вещь: действие могло пройти — повтор того же действия второй раз не заплатит';
const OFFLINE = 'Нет связи с сервером';

/**
 * ⭐ R4-23: ДЕЙСТВИЯ БЕЗ ОТВЕТА — номер команды и вид вещи на момент отправки, по «вещь + действие». Ответ ждут 8 с, а
 * сервер при медленной базе держит команду дольше (очередь за автосейвом, чтение сундука, транзакция — до ~45 с): карточки
 * оживали, вещь ещё не изменилась, и второй клик уходил НОВЫМ номером мимо дедупа — после первой: две ступени, две
 * перекатки за двойную цену. Теперь повтор того же действия над той же, не изменившейся вещью идёт ТЕМ ЖЕ номером —
 * сервер (кадры соединения идут по очереди) ответит итогом первой. Вещь изменилась (первая прошла — пришёл сейв),
 * ответ на повтор пришёл или ⭐ R5-18 поздний ответ на саму первую (итог известен — повтор тем же номером был бы эхом)
 * — память снята: следующий клик — новая заявка.
 */
const unanswered = new Map<string, { id: number; look: string }>();
/** Сколько действий без ответа помним; старейшее вытесняется. */
const UNANSWERED_KEEP = 8;
/**
 * Вид вещи для «изменилась ли»: всё, кроме места в сумке (переложить — не изменить). Ключи — по алфавиту на каждом уровне:
 * та же вещь из другого кадра сейва с иным порядком полей — всё та же вещь.
 */
const itemLook = (item: Item): string => {
  const { pos: _pos, ...rest } = item;
  return JSON.stringify(rest, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
};

/**
 * Клик по карточке. Разбор — с вопросами (скованное дважды, §17). Любое действие — с ожиданием ответа: отказ
 * сервера («Слишком часто», «Не удалось сохранить…») виден строкой над верстаком, а не теряется (R3-16); разбор
 * показывает, что открыл в журнале кузнеца (`cmdResult.unlocked`).
 */
function runAction(app: App, o: BenchOpts, item: Item, a: BenchAction): void {
  if (inFlight) return;
  // Без связи команда не уйдёт (`send` мёртвого сокета молчит) — сказать это, а не «нет ответа… могло пройти» (R4-23).
  if (!app.net.connected) { o.setNote?.(`⚠ ${OFFLINE}`); app.bus.emit('state:changed', {}); return; }
  if (a.id === 'salvage' && !confirmAll(disposePrompts(app.config, item, 'forge', app.stash?.forgeJournal))) return;
  // ⭐ R5-15: цена карточки — в команду (`maxGold`): дороже неё сервер не возьмёт, а откажет с новой ценой.
  const price = a.gold !== undefined ? { maxGold: a.gold } : {};
  const command: TownCommand = a.cmd === 'forgeEnchant'
    ? { cmd: 'forgeEnchant', uid: item.uid, rarity: a.rarity ?? 'magic', ...price }
    : a.cmd === 'forgeSalvage' ? { cmd: 'forgeSalvage', uid: item.uid }
    : { cmd: a.cmd, uid: item.uid, ...price };
  const key = actionKey(a);
  const slot = `${item.uid}|${key}`;
  const look = itemLook(item);
  const prev = unanswered.get(slot);
  // R4-23: та же вещь, то же действие, первая заявка без ответа — повтор её номером; вещь уже другая — новая заявка.
  const id = prev && prev.look === look ? prev.id : app.nextCmdId();
  unanswered.delete(slot);
  inFlight = { uid: item.uid, key };
  o.setNote?.('');
  app.bus.emit('state:changed', {});   // карточки гаснут, нажатая — «⏳»
  /** Строка над верстаком по ответу сервера — своевременному или позднему (R5-18). */
  const noteOf = (r: CmdReply): string => (!r.ok ? `⚠ Не вышло: ${r.reason ?? 'кузнец отказал'}`
    : a.id === 'salvage' && r.unlocked?.length ? `📖 Открыто в журнале кузнеца: ${r.unlocked.join(' · ')}` : '');
  /**
   * ⭐ R5-18: ответ пришёл ПОСЛЕ «нет ответа» — итог известен, номер больше не повторяем: дедуп сервера ответил бы на
   * повтор эхом этого итога, не исполнив (после позднего «Не удалось сохранить…» повтор, о котором просит сообщение, не
   * делал ничего). Отказ — строкой над верстаком вместо «могло пройти»; успех снимает её.
   */
  const onLate = (r: CmdReply): void => {
    if (unanswered.get(slot)?.id === id) unanswered.delete(slot);
    o.setNote?.(noteOf(r));
    app.bus.emit('state:changed', {});
  };
  // Признак снимается на ЛЮБОМ исходе: бросок отправки или отказ промиса — «нет ответа», а не вечно погашенный верстак.
  let reply: Promise<CmdReply | null>;
  try { reply = app.request(command, undefined, id, onLate); } catch { reply = Promise.resolve(null); }
  void reply.catch(() => null).then((r) => {
    inFlight = null;
    if (!r) {
      unanswered.set(slot, { id, look });
      for (const old of unanswered.keys()) { if (unanswered.size <= UNANSWERED_KEEP) break; unanswered.delete(old); }
    }
    const note = r ? noteOf(r) : `⚠ ${NO_REPLY}`;
    if (note) o.setNote?.(note);
    app.bus.emit('state:changed', {});
  });
}

/** Строка над верстаком: что открыл разбор (📖) или почему действие не вышло (⚠). */
function noteLine(text: string): HTMLElement {
  return mk('div',
    `font-size:12px;color:${text.startsWith('⚠') ? COLORS.bad : GOOD};border:1px solid ${COLORS.border};border-radius:6px;` +
    `padding:8px 10px;margin-bottom:10px;background:${COLORS.panel2}`, text);
}

/** Строки описания без аффиксов: кузнечное улучшение их не трогает, в предпросмотре они шумят. */
const baseLines = (item: Item): string[] =>
  itemDescLines(item).filter((l) => !l.affix).map((l) => l.text);

function previewBlock(rows: { was: string; will: string }[]): HTMLElement {
  const box = mk('div', 'display:flex;flex-direction:column;gap:3px;margin-top:8px');
  for (const r of rows) {
    const line = mk('div', 'display:flex;align-items:baseline;gap:8px;font-size:12px');
    line.append(
      mk('div', `flex:1;min-width:0;color:${COLORS.dim}`, r.was || '—'),
      mk('div', `color:${COLORS.dim};font-size:11px`, '→'),
      mk('div', `flex:1;min-width:0;color:${GOOD}`, r.will || '—'),
    );
    box.append(line);
  }
  return box;
}

/**
 * Карточка действия: заголовок, подзаголовок и построчная цена — вместо цены внутри подписи.
 * `waiting` — эта карточка сейчас в полёте (R3-16): «⏳» вместо заголовка; `enabled` уже учёл, что в полёте что-то есть.
 */
function actionCard(a: BenchAction, onClick: () => void, enabled = a.enabled, waiting = false): HTMLElement {
  const border = a.primary && enabled ? COLORS.accent : COLORS.border;
  const card = mk('div',
    `flex:1 1 120px;min-width:0;box-sizing:border-box;border:${a.primary && enabled ? '2px' : '1px'} solid ${border};` +
    `border-radius:8px;padding:10px;background:${enabled ? COLORS.panel : COLORS.panel2};` +
    `cursor:${enabled ? 'pointer' : 'default'};${enabled || waiting ? '' : 'opacity:0.55'}`);
  card.append(mk('div', `font-size:13px;color:${enabled || waiting ? COLORS.text : COLORS.dim}`, waiting ? `⏳ ${a.title}…` : a.title));
  card.append(mk('div', `font-size:11px;color:${COLORS.dim};margin:2px 0 8px`, a.sub));
  for (const l of a.lines) {
    const color = l.state === 'miss' ? COLORS.bad : l.state === 'gain' ? GOOD : l.state === 'dim' ? COLORS.dim : COLORS.text;
    const mark = l.state === 'ok' ? '✓ ' : l.state === 'miss' ? '✕ ' : l.state === 'gain' ? '+ ' : '';
    card.append(mk('div', `font-size:12px;line-height:1.7;color:${color}`, `${mark}${l.text}`));
  }
  if (enabled) {
    card.addEventListener('click', onClick);
    card.addEventListener('mouseenter', () => { card.style.borderColor = COLORS.accent; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = border; });
  }
  if (a.tip) attachTooltip(card, () => a.tip!);
  return card;
}

/** Полоса сырья: сумка + сундук одним числом — цены выше считаются по тому же итогу. */
function materialsStrip(app: App): HTMLElement {
  const have = availableMaterials(app.state!.save.inventory, app.stash?.materials ?? {});
  const box = mk('div', `border-top:1px solid ${COLORS.border};padding-top:8px;margin-top:12px`);
  box.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:6px`, 'Сырьё — в сумке и сундуке'));
  const row = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
  for (const d of app.config.get('craft-materials').filter((m) => m.enabled)) {
    const n = have[d.id] ?? 0;
    row.append(mk('div',
      `font-size:12px;padding:2px 9px;border-radius:6px;border:1px solid ${n > 0 ? COLORS.borderHi : COLORS.border};` +
      `background:${COLORS.panel2};color:${n > 0 ? COLORS.text : '#4a4a4a'}`,
      `${d.name} ${n}`));
  }
  box.append(row);
  return box;
}

/** Взять держимый предмет на верстак: он остаётся в сумке, слот запоминает только выбор. */
function takeHeld(app: App, o: BenchOpts): boolean {
  const h = getHeld();
  if (!h) return false;
  o.setUid(h.item.uid);
  clearHeld();
  app.bus.emit('state:changed', {});
  return true;
}

function emptyBench(app: App, o: BenchOpts): HTMLElement {
  const box = mk('div', `border:1px dashed ${COLORS.border};border-radius:8px;padding:22px;text-align:center;cursor:pointer`);
  box.append(mk('div', `font-size:13px;color:${COLORS.dim}`, 'Положи вещь на верстак'));
  box.append(mk('div', 'font-size:11px;color:#5a5a5a;margin-top:4px',
    'Клик по вещи в инвентаре, затем клик сюда. Из сумки она не пропадёт.'));
  box.addEventListener('click', () => { takeHeld(app, o); });
  return box;
}

/** Верстак целиком — готовый блок для тела панели кузницы. */
export function forgeBench(app: App, o: BenchOpts): HTMLElement {
  const state = app.state!;
  const root = mk('div');
  const item = o.uid ? state.save.inventory.find((i) => i.uid === o.uid) ?? null : null;
  // Вещь могла исчезнуть (разобрали, продали, потеряли на смерти) — слот молча пустеет, иначе
  // окно показывало бы цену за то, чего уже нет.
  if (o.uid && !item) o.setUid(null);
  if (o.note) root.append(noteLine(o.note));
  if (!item) { root.append(emptyBench(app, o), materialsStrip(app)); return root; }

  // ── Шапка: слот + имя + предпросмотр ─────────────────────────────────────────
  const head = mk('div',
    `display:flex;gap:14px;align-items:flex-start;border:1px solid ${COLORS.border};` +
    `border-radius:8px;padding:12px;background:${COLORS.panel}`);

  const left = mk('div', 'text-align:center;flex:0 0 auto');
  const cell = mk('div',
    `width:${CELL + 16}px;height:${CELL + 16}px;box-sizing:border-box;border-radius:6px;cursor:pointer;` +
    `display:flex;align-items:center;justify-content:center;font-size:12px;` +
    `border:2px solid ${item.broken ? COLORS.bad : rarityHex(item.rarity)};` +
    `color:${item.broken ? COLORS.bad : rarityHex(item.rarity)};background:${COLORS.panel2}`,
    glyphOf(item));
  attachTooltip(cell, () => itemTooltipHtml(item));
  // Клик занятым слотом меняет вещь на держимую, а с пустым курсором — снимает с верстака.
  cell.addEventListener('click', () => {
    if (takeHeld(app, o)) return;
    o.setUid(null);
    app.bus.emit('state:changed', {});
  });
  left.append(cell, mk('div', `font-size:11px;margin-top:4px;color:${item.broken ? COLORS.bad : COLORS.dim}`,
    item.broken ? 'сломано' : 'снять'));

  const info = mk('div', 'flex:1;min-width:0');
  info.append(mk('div', `font-size:14px;color:${rarityHex(item.rarity)}`, item.name));
  const target = benchTarget(app.config, item);
  const rows = target ? diffStrings(baseLines(item), baseLines(target)) : [];
  info.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-top:2px`,
    item.broken ? 'после починки' : target ? 'после улучшения'
    : item.parts ? 'скованную поднимает замена детали' : 'улучшать больше некуда'));
  info.append(rows.length
    ? previewBlock(rows)
    : mk('div', `font-size:12px;color:${COLORS.dim};margin-top:8px`, 'Кузнец эту вещь не меняет.'));

  head.append(left, info);
  root.append(head);

  // ── Карточки действий ────────────────────────────────────────────────────────
  const actions = benchActions(app.config, item, state.save.gold, state.save.inventory, app.stash?.materials ?? {});
  // У скованной карточек пять (с зачарованием, R3-09) — в узком окне они переносятся, а не сжимаются в столбик букв.
  const cards = mk('div', 'display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;align-items:stretch');
  for (const a of actions) {
    const waiting = inFlight?.uid === item.uid && inFlight.key === actionKey(a);
    cards.append(actionCard(a, () => runAction(app, o, item, a), a.enabled && !inFlight, waiting));
  }
  root.append(cards);

  // Сделка, которую до этого игрок должен был додумать сам (docs/ECONOMY.md, Ч3/Ч4).
  if (item.broken && actions.some((a) => a.id === 'salvage' && a.enabled)) {
    const price = forgeGold(app.config, item, 'repair');
    root.append(mk('div',
      `font-size:12px;color:${COLORS.dim};border:1px solid ${COLORS.border};border-radius:6px;` +
      `padding:8px 10px;margin-top:10px;background:${COLORS.panel2}`,
      `Починить за ${price} и носить — или разобрать и забрать сырьё. Улучшать можно только починенное.`));
  }

  root.append(materialsStrip(app));
  return root;
}
