import type { App } from '../../core/app.js';
import { COLORS, button, mk, attachTooltip } from '../../ui/kit.js';
import type { CmdReply } from '../../net/cmdReplies.js';
import { defaultGive, exchangeModel, type ExchangeSel } from './forgeExchange.js';

/**
 * ВКЛАДКА «⇄ ОБМЕН» КУЗНИЦЫ — только DOM; что предлагать и почём — чистая модель `forgeExchange.ts` (тот же расчёт, что у сервера).
 * Слева сверху — стопки сырья (сумка + сундук) по семьям и сортам, ниже — во что менять (другие семьи того же сорта), сколько отдать,
 * итог «отдашь / получишь / золото» с «есть N» и кнопка. Команда уходит с согласием и ЖДЁТ ответа (`app.request`): пока ждёт — кнопка
 * «⏳», повтор после «нет ответа» над тем же, не изменившимся выбором идёт ТЕМ ЖЕ номером (дедуп сервера, как у верстака R4-23).
 */

export interface ExchangeOpts {
  sel: ExchangeSel;
  setSel: (s: ExchangeSel) => void;
  note: string;
  setNote: (n: string) => void;
}

/** Обмен в полёте — один на страницу (тело окна перерисовывается на каждое `state:changed`). */
let inFlight = false;
/** Последняя заявка без ответа: ключ команды + вид запасов → её номер (повтор тем же номером). */
let unanswered: { key: string; look: string; id: number } | null = null;
const NO_REPLY = 'Нет ответа от кузнеца. Посмотри сундук: обмен мог пройти — повтор того же обмена второй раз не заплатит';

function send(app: App, o: ExchangeOpts, command: NonNullable<ReturnType<typeof exchangeModel>['command']>, look: string): void {
  if (inFlight) return;
  if (!app.net.connected) { o.setNote('⚠ Нет связи с сервером'); app.bus.emit('state:changed', {}); return; }
  const key = JSON.stringify(command);
  const id = unanswered && unanswered.key === key && unanswered.look === look ? unanswered.id : app.nextCmdId();
  unanswered = null;
  inFlight = true;
  o.setNote('');
  app.bus.emit('state:changed', {});
  const noteOf = (r: CmdReply): string => (r.ok ? `⇄ ${r.summary ?? 'Обмен сделан'}` : `⚠ Не вышло: ${r.reason ?? 'кузнец отказал'}`);
  const onLate = (r: CmdReply): void => {
    if (unanswered?.id === id) unanswered = null;
    o.setNote(noteOf(r));
    app.bus.emit('state:changed', {});
  };
  let reply: Promise<CmdReply | null>;
  try { reply = app.request(command, undefined, id, onLate); } catch { reply = Promise.resolve(null); }
  void reply.catch(() => null).then((r) => {
    inFlight = false;
    if (!r) unanswered = { key, look, id };
    o.setNote(r ? noteOf(r) : `⚠ ${NO_REPLY}`);
    app.bus.emit('state:changed', {});
  });
}

const chip = (text: string, on: boolean, enabled: boolean, color: string): HTMLElement => mk('div',
  `padding:4px 8px;border-radius:6px;font-size:12px;white-space:nowrap;cursor:${enabled ? 'pointer' : 'default'};` +
  `border:1px solid ${on ? COLORS.accent : COLORS.border};background:${on ? '#26221a' : COLORS.panel2};color:${enabled ? color : COLORS.dim};` +
  `${enabled ? '' : 'opacity:0.55'}`, text);

/** Вкладка целиком — блок для тела окна кузницы. */
export function forgeExchangeView(app: App, o: ExchangeOpts): HTMLElement {
  const state = app.state!;
  const wallet = app.stash?.materials ?? {};
  const m = exchangeModel(app.config, state.save.inventory, wallet, state.save.gold, o.sel);
  const root = mk('div');
  if (o.note) {
    root.append(mk('div', `font-size:12px;color:${o.note.startsWith('⚠') ? COLORS.bad : COLORS.good};border:1px solid ${COLORS.border};` +
      `border-radius:6px;padding:8px 10px;margin-bottom:10px;background:${COLORS.panel2}`, o.note));
  }
  if (m.closed) {
    root.append(mk('div', `border:1px dashed ${COLORS.border};border-radius:8px;padding:22px;text-align:center;color:${COLORS.text}`, m.closed));
    return root;
  }
  root.append(mk('div', `font-size:12px;color:${COLORS.text}`, m.rate));
  root.append(mk('div', `font-size:11px;color:${COLORS.dim};margin:2px 0 10px`,
    `${m.goldLine}. Сорт не меняется; эссенцию не меняют; полученное — в сундук.`));

  // ── Что отдаёшь: стопки по семьям ──
  root.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, 'Отдаёшь (сумка + сундук):'));
  const srcBox = mk('div', 'display:flex;flex-direction:column;gap:4px;margin-bottom:10px');
  if (!m.sources.length) srcBox.append(mk('div', `font-size:12px;color:${COLORS.dim}`, m.reason ?? 'Сырья нет'));
  const families = [...new Set(m.sources.map((s) => s.family))];
  for (const fam of families) {
    const row = mk('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap');
    const rows = m.sources.filter((s) => s.family === fam);
    row.append(mk('div', `width:72px;flex:0 0 auto;font-size:11px;color:${COLORS.dim};text-align:right;padding-right:4px`, rows[0]!.familyLabel));
    for (const s of rows) {
      const c = chip(`${s.name} ×${s.have}`, s.selected, !inFlight, s.color);
      attachTooltip(c, () => `<b style="color:${s.color}">${s.name}</b><br>${s.familyLabel} · ${s.gradeLabel}<br>В сундуке ${s.stash}${s.bag ? `<br>В сумке ${s.bag} — берётся первой` : ''}`);
      if (!inFlight) c.addEventListener('click', () => {
        o.setSel({ from: s.id, to: o.sel.from === s.id ? o.sel.to : null, n: o.sel.from === s.id ? o.sel.n : defaultGive(app.config, s.have) });
        app.bus.emit('state:changed', {});
      });
      row.append(c);
    }
    srcBox.append(row);
  }
  root.append(srcBox);

  // ── Во что: другие семьи того же сорта ──
  if (m.targets.length) {
    root.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, 'Во что (тот же сорт):'));
    const tBox = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px');
    for (const t of m.targets) {
      const c = chip(`${t.label}: ${t.name}${t.ok ? ` (есть ${t.have})` : ''}`, t.selected, t.ok && !inFlight, COLORS.text);
      if (!t.ok && t.reason) attachTooltip(c, () => `Нельзя: ${t.reason}`);
      if (t.ok && !inFlight) c.addEventListener('click', () => { o.setSel({ ...o.sel, to: t.family }); app.bus.emit('state:changed', {}); });
      tBox.append(c);
    }
    root.append(tBox);
  }

  // ── Сколько ──
  if (m.sources.some((s) => s.selected)) {
    const amount = mk('div', 'display:flex;align-items:center;gap:6px;margin-bottom:10px');
    const set = (n: number): void => { o.setSel({ ...o.sel, n: Math.max(0, Math.min(m.max, Math.floor(n))) }); app.bus.emit('state:changed', {}); };
    amount.append(mk('div', `font-size:12px;color:${COLORS.dim}`, 'Сколько отдать:'));
    amount.append(button(`−${m.step}`, () => set(m.n - m.step), 'default', inFlight || m.n <= 0));
    const input = mk('input', `width:72px;padding:4px 6px;background:${COLORS.panel2};color:${COLORS.text};border:1px solid ${COLORS.borderHi};border-radius:6px`);
    input.type = 'number'; input.min = '0'; input.max = String(m.max); input.value = String(m.n);
    input.disabled = inFlight;
    input.addEventListener('change', () => set(Number(input.value) || 0));
    amount.append(input);
    amount.append(button(`+${m.step}`, () => set(m.n + m.step), 'default', inFlight || m.n >= m.max));
    amount.append(button(`Всё (${m.max})`, () => set(m.max), 'default', inFlight || m.n >= m.max));
    root.append(amount);
  }

  // ── Итог и кнопка ──
  if (m.lines.length) {
    const card = mk('div', `border:1px solid ${m.canSend ? COLORS.accent : COLORS.border};border-radius:8px;padding:10px;background:${COLORS.panel}`);
    for (const l of m.lines) {
      const color = l.state === 'miss' ? COLORS.bad : l.state === 'gain' ? COLORS.good : l.state === 'dim' ? COLORS.dim : COLORS.text;
      card.append(mk('div', `font-size:12px;line-height:1.7;color:${color}`, `${l.label}: ${l.text}`));
    }
    root.append(card);
  }
  if (m.reason && (m.sources.length || m.lines.length)) root.append(mk('div', `font-size:12px;color:${m.lines.length ? COLORS.bad : COLORS.dim};margin-top:8px`, m.reason));
  const look = JSON.stringify([state.save.gold, m.quote ? wallet[m.quote.from] ?? 0 : 0, m.quote ? wallet[m.quote.to] ?? 0 : 0, m.quote?.spend ?? 0]);
  const go = button(inFlight ? '⏳ Кузнец меняет…' : '⇄ Обменять', () => { if (m.command) send(app, o, m.command, look); }, 'primary', inFlight || !m.canSend);
  const row = mk('div', 'margin-top:10px');
  row.append(go);
  root.append(row);
  return root;
}
