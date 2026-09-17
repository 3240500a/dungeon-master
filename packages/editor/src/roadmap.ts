/**
 * ВКЛАДКА «РОАДМАП» (Р2–Р5): лента вех + чеклист выбранной вехи + правка прямо в UI.
 *
 * Математика живёт в `roadmapModel.ts` (чистая, под тестами) — здесь только DOM и хранение.
 *
 * ХРАНЕНИЕ. Ключ `pe_roadmap` в `pose_store` (не в игровом конфиге — почему, см. `roadmapModel.ts`).
 * Пишем в localStorage СРАЗУ, на сервер шлём с задержкой. Отличие от Ф12 намеренное: сервер здесь просто
 * синхронизация между двумя машинами, кнопки «Опубликовать» нет. Роадмап ДЛЯ ИГРОКОВ сервером тоже не
 * публикуется — он выгружается файлом или текстом (HTML / Steam / Discord), см. `roadmapPublic.ts`. Правило Ф12 при этом соблюдается: сервер не затирает локальное
 * молча — при расхождении показываем, что серверная копия свежее, и забрать её можно кнопкой.
 */
import { devFetch } from '@dm/client/devAuth.js';
import {
  COUNTERS, WHO_LABEL, EMPTY_ROADMAP, newId, shortDate,
  itemProgress, remainingOf, milestoneProgress, totalProgress, statusOf, activeIndex, currentOf, isCounter,
  driftDays, autoClose, shiftTail, roadmapStats, shortDate as fmtDate,
  type RoadmapDoc, type Milestone, type Item, type Ctx, type AssetStats, type Who, type Source, type Status, type Snapshot,
} from './roadmapModel.js';
import { SEED, migrateRoadmap } from './roadmapSeed.js';
import { renderPublicView } from './roadmapPublicView.js';
import { replan, applyProposals } from './roadmapReplan.js';
import { byId } from './roadmapCalendar.js';

const LS_KEY = 'pe_roadmap';
const LS_SEEN = 'pe_roadmap_seen';   // ревизия сервера, на которой основана локальная копия
/** Какой роадмап открыт — личная настройка вкладки. Без префикса `pe_`: это не контент, его не синхронизируем. */
const LS_VIEW = 'roadmap_view';
type View = 'work' | 'public';
let view: View = (() => { try { return localStorage.getItem(LS_VIEW) === 'public' ? 'public' : 'work'; } catch { return 'work'; } })();

const C = {
  bg: '#1c1c26', edge: '#2c2c3a', text: '#e8e8f0', dim: '#9a9ab0', faint: '#6f6f88',
  done: '#5fbf7f', active: '#c79a44', over: '#d4634a', plan: '#4a4a5e', track: '#26262f',
};
const el = (tag: string, css = '', text = ''): HTMLElement => {
  const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e;
};
const btn = (label: string, fn: () => void, css = ''): HTMLButtonElement => {
  const b = document.createElement('button'); b.textContent = label;
  b.style.cssText = `padding:5px 10px;cursor:pointer;border-radius:6px;border:1px solid ${C.edge};background:${C.bg};color:${C.text};font-size:12px;${css}`;
  b.addEventListener('click', fn); return b;
};

// ── Состояние вкладки ────────────────────────────────────────────────────────────────────────────
let doc: RoadmapDoc = EMPTY_ROADMAP();
let assets: AssetStats | undefined;
let selected = 0;
let loaded = false;
let serverAhead = false;
let saveState: 'idle' | 'pending' | 'saved' | 'offline' = 'idle';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let redraw: () => void = () => { /* заполняется при первом рендере */ };

const readLocal = (): RoadmapDoc | null => {
  try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) as RoadmapDoc : null; } catch { return null; }
};
const writeLocal = (d: RoadmapDoc): void => { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch { /* приватный режим */ } };

/** Правка: пишем локально мгновенно, на сервер — с задержкой (правки идут очередями по одной галке). */
function scheduleSave(): void {
  saveState = 'pending';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void pushToServer(); }, 900);
}

function touch(): void {
  doc.updatedAt = Date.now();
  writeLocal(doc);
  scheduleSave();
  redraw();
}

async function pushToServer(): Promise<void> {
  try {
    const r = await devFetch('/api/dev/pose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pe_roadmap: doc }),
    });
    if (!r.ok) { saveState = 'offline'; redraw(); return; }
    const j = await r.json().catch(() => ({})) as { rev?: Record<string, number> };
    if (j.rev?.pe_roadmap) { try { localStorage.setItem(LS_SEEN, String(j.rev.pe_roadmap)); } catch { /* */ } }
    saveState = 'saved'; serverAhead = false; redraw();
  } catch { saveState = 'offline'; redraw(); }
}

/**
 * Загрузка. Локальная копия — истина (правило Ф12): серверную берём, только если локальной нет.
 * Если на сервере новее — не затираем молча, а показываем плашку с кнопкой «забрать».
 */
async function load(): Promise<void> {
  const local = readLocal();
  if (local) doc = local;
  else doc = SEED();   // первое открытие: показываем вехи из docs/ROADMAP.md, а не пустой экран
  try {
    const [bodies, revs] = await Promise.all([
      fetch('/api/pose').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/pose/rev').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const remote = (bodies as Record<string, RoadmapDoc> | null)?.pe_roadmap;
    const rev = (revs as Record<string, number> | null)?.pe_roadmap;
    if (remote && !local) { doc = remote; writeLocal(doc); }   // на сервере уже есть свой — он старше сида
    else if (remote && local) {
      const seen = Number(localStorage.getItem(LS_SEEN) ?? 0);
      serverAhead = !!rev && rev > seen && (remote.updatedAt ?? 0) > (local.updatedAt ?? 0);
    }
    if (rev && !local) { try { localStorage.setItem(LS_SEEN, String(rev)); } catch { /* */ } }
    // Серверной копии нет, а локальная есть — вернуть её на сервер. Так было после «чистого листа» 14.09:
    // он стёр `pe_roadmap` на сервере, и вторая машина открыла бы пустой сид вместо живого плана.
    if (!remote && local && bodies) scheduleSave();
  } catch { /* сервера нет — работаем на локальной копии */ }
  // Обновления наполнения из репозитория (отмеченное сделанным, роадмап для игроков) доезжают и до
  // уже правленой копии — точечными правками по id, не затирая остального.
  if (migrateRoadmap(doc)) { writeLocal(doc); scheduleSave(); }
  try { assets = await fetch('/api/assets/stats').then((r) => (r.ok ? r.json() : undefined)); } catch { /* */ }
  loaded = true;
  selected = activeIndex(doc, ctxOf(undefined));
  redraw();
}

async function pullFromServer(): Promise<void> {
  try {
    const bodies = await fetch('/api/pose').then((r) => (r.ok ? r.json() : null));
    const remote = (bodies as Record<string, RoadmapDoc> | null)?.pe_roadmap;
    if (remote) { doc = remote; writeLocal(doc); serverAhead = false; }
    const revs = await fetch('/api/pose/rev').then((r) => (r.ok ? r.json() : null)) as Record<string, number> | null;
    if (revs?.pe_roadmap) { try { localStorage.setItem(LS_SEEN, String(revs.pe_roadmap)); } catch { /* */ } }
  } catch { /* */ }
  redraw();
}

const ctxOf = (config: Snapshot | undefined): Ctx => ({ config, assets });

/** Ширина ячейки ленты — общая для строки фаз и строки вех, иначе группы разъезжаются. */
const CELL_W = 116;

// ── Отрисовка ────────────────────────────────────────────────────────────────────────────────────
const COLOR: Record<Status, string> = { done: C.done, active: C.active, overdue: C.over, planned: C.plan };
const pct = (r: number): string => Math.round(r * 100) + ' %';

/** Полоса прогресса — один вид на весь экран, чтобы взгляд не переучивался. */
function bar(ratio: number, color: string, w = '100%', h = 8): HTMLElement {
  const track = el('div', `width:${w};height:${h}px;background:${C.track};border-radius:${h}px;overflow:hidden`);
  track.appendChild(el('div', `width:${Math.round(ratio * 100)}%;height:100%;background:${color};border-radius:${h}px`));
  return track;
}

export function renderRoadmapPage(host: HTMLElement, config: Snapshot): void {
  host.innerHTML = '';
  // ЕДИНСТВЕННЫЙ вертикальный ползунок вкладки. Всё внутри прокручиваться по вертикали не должно —
  // иначе появляются вложенные полосы и теряешь, какая из них где.
  const root = el('div', 'display:flex;flex-direction:column;gap:12px;min-height:0;flex:1;overflow-y:auto;overflow-x:hidden;padding-right:8px');
  host.appendChild(root);
  redraw = () => renderRoadmapPage(host, config);
  if (!loaded) { void load(); root.appendChild(el('div', `color:${C.dim};padding:20px`, 'Загрузка роадмапа…')); return; }

  const ctx = ctxOf(config);
  // Веха, дошедшая до 100 %, штампуется датой закрытия — ОДИН раз. Отсюда берётся вся статистика сроков.
  if (autoClose(doc, ctx)) { writeLocal(doc); scheduleSave(); }
  const total = totalProgress(doc, ctx);

  // ── Шапка: общий прогресс и состояние сохранения ──
  const head = el('div', `border:1px solid ${C.edge};border-radius:10px;padding:14px 16px;background:#16161f`);
  const hrow = el('div', 'display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px');
  hrow.appendChild(el('div', 'font-size:15px;font-weight:700', '📍 Дорожная карта'));
  hrow.appendChild(el('div', `color:${C.faint};font-size:12px`, 'The Fourth Bequest'));
  // Два роадмапа на одних данных: рабочий (для команды) и для игроков (свои тексты, статусы — отсюда же).
  const seg = el('div', `display:flex;border:1px solid ${C.edge};border-radius:7px;overflow:hidden;margin-left:8px`);
  for (const [v, label] of [['work', '🔧 Рабочий'], ['public', '👁 Для игроков']] as [View, string][]) {
    const b = btn(label, () => {
      view = v; try { localStorage.setItem(LS_VIEW, v); } catch { /* приватный режим */ }
      redraw();
    }, `border:0;border-radius:0;${view === v ? `background:#2a2a38;color:${C.text};font-weight:600` : `color:${C.dim}`}`);
    seg.appendChild(b);
  }
  hrow.appendChild(seg);
  const spacer = el('div', 'flex:1'); hrow.appendChild(spacer);
  const replanBtn = btn('\u27f3 Пересчитать план', () => showReplan(ctx), `border-color:${C.active};color:${C.active}`);
  replanBtn.title = 'Подогнать даты под реальный календарь Steam: работа сдвигается на отставание, '
    + 'фестиваль перецепляется на ближайший доступный, запуск снапается на чистое окно между распродажами';
  hrow.appendChild(replanBtn);
  const stateLabel = { idle: '', pending: 'сохраняю…', saved: 'сохранено ✓', offline: '⚠ сервер недоступен — лежит локально' }[saveState];
  if (stateLabel) hrow.appendChild(el('div', `font-size:12px;color:${saveState === 'offline' ? C.active : C.dim}`, stateLabel));
  head.appendChild(hrow);

  const sum = el('div', 'display:flex;align-items:center;gap:12px');
  sum.appendChild(bar(total.ratio, C.active, '240px', 10));
  sum.appendChild(el('div', 'font-size:13px;font-weight:600;font-variant-numeric:tabular-nums', pct(total.ratio)));
  sum.appendChild(el('div', `color:${C.dim};font-size:13px`, `осталось ${total.remaining} из ${total.total}`));
  head.appendChild(sum);

  const st = roadmapStats(doc);
  if (st) {
    const line = el('div', `margin-top:12px;padding-top:10px;border-top:1px solid ${C.edge};display:flex;gap:20px;flex-wrap:wrap;font-size:12px`);
    const cell = (label: string, value: string, color = C.text): HTMLElement => {
      const c = el('div', 'display:flex;flex-direction:column;gap:2px');
      c.appendChild(el('div', `color:${C.faint};font-size:10px;text-transform:uppercase;letter-spacing:.06em`, label));
      c.appendChild(el('div', `color:${color};font-weight:600;font-variant-numeric:tabular-nums`, value));
      return c;
    };
    const sign = (n: number): string => (n > 0 ? '+' + n : String(n));
    line.appendChild(cell('вех закрыто', `${st.closed} из ${st.total}`));
    line.appendChild(cell('средний сдвиг', st.closed ? sign(st.avgDrift) + ' дн' : '—',
      st.avgDrift > 0 ? C.over : st.avgDrift < 0 ? C.done : C.text));
    line.appendChild(cell('релиз по плану', fmtDate(st.releasePlanned), C.dim));
    line.appendChild(cell('релиз сейчас', fmtDate(st.releaseNow), st.releaseDrift > 0 ? C.over : C.text));
    if (st.releaseDrift !== 0) line.appendChild(cell('отклонение', sign(st.releaseDrift) + ' дн', st.releaseDrift > 0 ? C.over : C.done));
    if (st.forecast !== st.releaseNow) {
      line.appendChild(cell('прогноз по темпу', fmtDate(st.forecast), C.over));
      const hint = el('div', `flex-basis:100%;color:${C.faint};font-size:11px;margin-top:4px`,
        'Прогноз наивный: текущая дата плюс средний сдвиг на каждую незакрытую веху. Нужен, чтобы систематическое отставание было видно заранее.');
      line.appendChild(hint);
    }
    head.appendChild(line);
  }

  if (serverAhead) {
    const warn = el('div', `margin-top:10px;padding:8px 10px;border:1px solid ${C.active};border-radius:6px;color:${C.text};font-size:12px;display:flex;gap:10px;align-items:center`);
    warn.appendChild(el('span', 'flex:1', 'На сервере более свежая версия — правил с другой машины.'));
    warn.appendChild(btn('⬇ Забрать серверную', () => { void pullFromServer(); }));
    head.appendChild(warn);
  }
  root.appendChild(head);

  if (view === 'public') { root.appendChild(renderPublicView(doc, ctx, touch)); return; }
  root.appendChild(renderTrack(ctx));
  if (doc.milestones[selected]) root.appendChild(renderMilestone(doc.milestones[selected]!, ctx, config));
  else root.appendChild(emptyState());
}

function emptyState(): HTMLElement {
  const box = el('div', `border:1px dashed ${C.edge};border-radius:10px;padding:28px;text-align:center;color:${C.dim}`);
  box.appendChild(el('div', 'margin-bottom:12px', 'Вех пока нет.'));
  box.appendChild(btn('+ Первая веха', () => { addMilestone(); }, `background:#25321f;border-color:#3f5a33`));
  return box;
}

/** Лента вех: узлы на линии, цвет = статус, под каждым — процент и дата. */
/**
 * Лента вех.
 * ⚠ `overflow-y: hidden` ОБЯЗАТЕЛЕН: по спецификации CSS, если одна ось не `visible`, вторая
 * вычисляется как `auto` — и один только `overflow-x` даёт ВТОРОЙ вертикальный ползунок внутри
 * страницы. Именно на нём и путаешься, поэтому вторая ось гасится явно, а высота ячейки фиксирована,
 * чтобы длинному названию было куда лечь и ничего не обрезалось.
 */
function renderTrack(ctx: Ctx): HTMLElement {
  // `position:relative` не для вида: без него `offsetLeft` ячейки считается от далёкого предка,
  // и автоскролл промахивается мимо выбранной вехи (поймано глазами).
  const wrap = el('div', `position:relative;border:1px solid ${C.edge};border-radius:10px;background:#16161f;overflow-x:auto;overflow-y:hidden;flex:none`);
  const inner = el('div', 'padding:14px 16px 10px;min-width:max-content');
  const act = activeIndex(doc, ctx);

  // Фазы отдельной строкой над лентой: 18 вех без группировки читаются как сплошная простыня.
  const phases = el('div', 'display:flex;align-items:flex-end;height:18px');
  let runStart = 0;
  const flushPhase = (end: number): void => {
    const name = doc.milestones[runStart]?.phase ?? '';
    const width = (end - runStart + 1) * CELL_W;
    const p = el('div', `width:${width}px;flex:none;display:flex;align-items:center;gap:6px;padding-right:8px`);
    if (name) {
      p.appendChild(el('div', `font-size:10px;color:${C.faint};text-transform:uppercase;letter-spacing:.07em;white-space:nowrap`, name));
      p.appendChild(el('div', `flex:1;height:1px;background:${C.track}`));
    }
    phases.appendChild(p);
  };
  doc.milestones.forEach((m, i) => {
    const next = doc.milestones[i + 1];
    if (!next || next.phase !== m.phase) { flushPhase(i); runStart = i + 1; }
  });
  inner.appendChild(phases);

  const row = el('div', 'display:flex;align-items:flex-start;gap:0');
  let activeCell: HTMLElement | null = null;

  doc.milestones.forEach((m, i) => {
    const p = milestoneProgress(m, ctx);
    const st = statusOf(m, ctx, i === act);
    const color = COLOR[st];
    const cell = el('div', `display:flex;flex-direction:column;align-items:center;width:${CELL_W}px;flex:none;cursor:pointer;border-radius:8px;padding:6px 2px 8px;background:${i === selected ? '#1e1e2b' : 'transparent'}`);
    cell.title = `${m.title} · ${shortDate(m.to)}`;
    cell.addEventListener('click', () => { selected = i; redraw(); });
    if (i === selected) activeCell = cell;

    // линия + узел
    const line = el('div', 'display:flex;align-items:center;width:100%;height:20px');
    line.appendChild(el('div', `flex:1;height:2px;background:${i === 0 ? 'transparent' : C.track}`));
    const size = i === selected ? 15 : 11;
    line.appendChild(el('div', `width:${size}px;height:${size}px;border-radius:50%;background:${st === 'planned' ? C.track : color};border:2px solid ${color};flex:none`));
    line.appendChild(el('div', `flex:1;height:2px;background:${i === doc.milestones.length - 1 ? 'transparent' : C.track}`));
    cell.appendChild(line);

    cell.appendChild(el('div', `margin-top:6px;font-size:11.5px;font-weight:700;color:${i === selected ? C.text : C.dim}`, m.id.toUpperCase()));
    // Название — ровно две строки: так все ячейки одной высоты и ничего не обрезается снизу.
    cell.appendChild(el('div',
      `font-size:10.5px;color:${C.faint};text-align:center;line-height:1.25;height:26px;overflow:hidden;padding:0 3px;`
      + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical', m.title));
    cell.appendChild(el('div', `margin-top:3px;font-size:11px;font-weight:600;color:${color};font-variant-numeric:tabular-nums`,
      st === 'done' ? '✓ готово' : st === 'overdue' ? `⚠ ${pct(p.ratio)}` : pct(p.ratio)));
    cell.appendChild(el('div', `font-size:10px;color:${C.faint};font-variant-numeric:tabular-nums`, shortDate(m.to)));
    row.appendChild(cell);
  });

  const add = el('div', `display:flex;flex-direction:column;justify-content:center;padding:0 4px 0 10px;flex:none`);
  add.appendChild(btn('+ веха', () => { addMilestone(); }));
  row.appendChild(add);
  inner.appendChild(row);
  wrap.appendChild(inner);

  // Текущая веха должна быть видна сразу: при 18 вехах лента шире экрана.
  // ⚠ Скроллим ТОЛЬКО если она реально вне кадра. Безусловное центрирование дёргало ленту и обрезало
  // выбранную ячейку у левого края, когда она и так была видна (поймано глазами).
  if (activeCell) requestAnimationFrame(() => {
    const c = activeCell as HTMLElement;
    const view = wrap.clientWidth;
    if (!view) return;                                  // разметка ещё не посчитана — не гадаем
    const left = c.offsetLeft - wrap.offsetLeft;
    const right = left + c.offsetWidth;
    if (left >= wrap.scrollLeft && right <= wrap.scrollLeft + view) return;   // уже в кадре
    wrap.scrollLeft = Math.max(0, left - view / 2 + c.offsetWidth / 2);
  });
  return wrap;
}

function addMilestone(): void {
  const n = doc.milestones.length;
  doc.milestones.push({ id: 'ф' + n, title: 'Новая веха', goal: '', to: new Date().toISOString().slice(0, 7), items: [] });
  selected = n;
  touch();
}

// ── Карточка вехи ────────────────────────────────────────────────────────────────────────────────
function renderMilestone(m: Milestone, ctx: Ctx, config: Snapshot): HTMLElement {
  const p = milestoneProgress(m, ctx);
  const st = statusOf(m, ctx, doc.milestones.indexOf(m) === activeIndex(doc, ctx));
  const box = el('div', `border:1px solid ${C.edge};border-left:3px solid ${COLOR[st]};border-radius:10px;padding:16px;background:#16161f`);

  // Фаза — группирующая подпись над названием
  if (m.phase) box.appendChild(el('div', `color:${C.faint};font-size:11px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px`, m.phase));

  // Заголовок: id · название · период — всё правится на месте
  const top = el('div', 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px');
  top.appendChild(inlineText(m.id, 'font-size:13px;font-weight:700;width:56px', (v) => { m.id = v; touch(); }));
  top.appendChild(inlineText(m.title, 'font-size:15px;font-weight:700;flex:1;min-width:180px', (v) => { m.title = v; touch(); }));
  top.appendChild(el('span', `color:${C.faint};font-size:11px`, 'с'));
  top.appendChild(inlineText(m.from ?? '', 'width:96px;font-size:12px', (v) => { m.from = v || undefined; touch(); }, 'ГГГГ-ММ'));
  top.appendChild(el('span', `color:${C.faint};font-size:11px`, 'по'));
  top.appendChild(inlineText(m.to, 'width:104px;font-size:12px', (v) => { m.to = v; touch(); }, 'ГГГГ-ММ-ДД'));
  // Удаление — самое опасное действие на экране, поэтому оно самое ТИХОЕ: краснеет только при наведении.
  const del = btn('✕', () => {
    if (!confirm(`Удалить веху «${m.title}» со всеми пунктами?`)) return;
    doc.milestones = doc.milestones.filter((x) => x !== m);
    selected = Math.max(0, selected - 1); touch();
  }, `color:${C.faint};border-color:transparent;background:transparent;margin-left:6px`);
  del.title = 'Удалить веху';
  del.addEventListener('mouseenter', () => { del.style.color = C.over; del.style.borderColor = '#5a3030'; });
  del.addEventListener('mouseleave', () => { del.style.color = C.faint; del.style.borderColor = 'transparent'; });
  top.appendChild(del);
  box.appendChild(top);

  box.appendChild(inlineText(m.goal, `width:100%;font-size:12px;color:${C.dim};margin-bottom:10px`, (v) => { m.goal = v; touch(); }, 'Цель вехи — одной строкой: зачем она нужна'));

  // Развёрнутое описание — нужно отправной точке и вехам, где одной строки мало
  if (m.desc !== undefined) {
    const ta = document.createElement('textarea');
    ta.value = m.desc;
    ta.rows = Math.min(24, m.desc.split('\n').length + 1);
    ta.style.cssText = `width:100%;background:#0f0f16;color:${C.dim};border:1px solid ${C.edge};border-radius:6px;padding:10px 12px;font:12px/1.6 inherit;margin-bottom:12px;resize:vertical`;
    ta.addEventListener('blur', () => { if (ta.value !== m.desc) { m.desc = ta.value; touch(); } });
    box.appendChild(ta);
  }

  // ── Сроки: изначальный план, факт, отклонение ──
  const drift = driftDays(m);
  const dates = el('div', `display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:12px;padding:8px 10px;background:#12121a;border-radius:6px;font-size:12px`);
  const dcell = (label: string, value: string, color = C.text): void => {
    const c = el('div', 'display:flex;gap:6px;align-items:baseline');
    c.appendChild(el('span', `color:${C.faint};font-size:11px`, label));
    c.appendChild(el('span', `color:${color};font-weight:600;font-variant-numeric:tabular-nums`, value));
    dates.appendChild(c);
  };
  dcell('изначально', fmtDate(m.planned ?? m.to), C.dim);
  if ((m.planned ?? m.to) !== m.to) dcell('сейчас', fmtDate(m.to), C.active);
  dcell('факт', m.closedAt ? fmtDate(m.closedAt) : '—', m.closedAt ? C.done : C.faint);
  if (drift !== 0) dcell('отклонение', (drift > 0 ? '+' : '') + drift + ' дн', drift > 0 ? C.over : C.done);

  // Веха-событие: дату назначаем не мы, и это должно быть видно прямо в строке сроков.
  const ev = m.kind === 'fest' && m.eventId ? byId(m.eventId) : undefined;
  if (ev) {
    dates.appendChild(el('div', `margin-left:auto;font-size:11px;color:${C.active}`,
      `⚑ ${ev.title}${ev.regDeadline ? ` · заявка до ${fmtDate(ev.regDeadline)}` : ''}${ev.demoDeadline ? ` · демо до ${fmtDate(ev.demoDeadline)}` : ''}${ev.confirmed ? '' : ' · дата не подтверждена Valve'}`));
  } else if (m.kind === 'launch') {
    dates.appendChild(el('div', `margin-left:auto;font-size:11px;color:${C.active}`,
      '⚑ окно запуска считается по календарю распродаж — кнопка «Пересчитать план»'));
  } else {
    // Плоский сдвиг оставлен только для РАБОЧИХ вех — у события и запуска свои правила.
    const idx = doc.milestones.indexOf(m);
    if (drift > 0 && idx < doc.milestones.length - 1) {
      dates.appendChild(btn(`⤳ сдвинуть следующие на ${drift} дн`, () => {
        const n = shiftTail(doc, idx, drift);
        touch();
        alert(`Сдвинуто вех: ${n}. Изначальный план у них сохранён — отклонение продолжит считаться от него.`);
      }, `margin-left:auto;border-color:${C.active};color:${C.active}`));
    }
  }
  box.appendChild(dates);

  // Прогресс + разбивка по исполнителям
  const prow = el('div', 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px');
  prow.appendChild(bar(p.ratio, COLOR[st], '200px', 9));
  prow.appendChild(el('div', 'font-size:13px;font-weight:600;font-variant-numeric:tabular-nums', pct(p.ratio)));
  prow.appendChild(el('div', `color:${C.dim};font-size:13px`, `осталось ${p.remaining} из ${p.total}`));
  const whoParts = (Object.keys(p.byWho) as Who[]).filter((w) => p.byWho[w] > 0).map((w) => `${WHO_LABEL[w]} ${p.byWho[w]}`);
  if (whoParts.length) prow.appendChild(el('div', `color:${C.faint};font-size:12px;margin-left:auto`, 'не закрыто: ' + whoParts.join(' · ')));
  box.appendChild(prow);

  const list = el('div', 'display:flex;flex-direction:column;gap:2px');
  for (const it of m.items) list.appendChild(renderItem(it, m, ctx));
  box.appendChild(list);

  const add = el('div', 'display:flex;gap:6px;margin-top:12px');
  add.appendChild(btn('+ пункт', () => { m.items.push({ id: newId('i'), title: 'Новый пункт' }); touch(); }, 'background:#25321f;border-color:#3f5a33'));
  add.appendChild(btn('+ счётчик', () => {
    m.items.push({ id: newId('i'), title: COUNTERS.monsters!.label, target: 10, source: { kind: 'config', counter: 'monsters' } });
    touch();
  }, 'background:#1f2a32;border-color:#33505a'));
  box.appendChild(add);
  void config;   // конфиг приходит через ctx; параметр оставлен для симметрии с прочими страницами редактора
  return box;
}

/** Поле, которое выглядит как текст, пока в него не ткнули: правка не должна требовать «режима редактирования». */
function inlineText(value: string, css: string, onChange: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.value = value; i.placeholder = placeholder;
  i.style.cssText = `background:transparent;border:1px solid transparent;border-radius:4px;color:${C.text};padding:3px 6px;font-family:inherit;${css}`;
  i.addEventListener('focus', () => { i.style.background = '#0f0f16'; i.style.borderColor = C.edge; });
  i.addEventListener('blur', () => { i.style.background = 'transparent'; i.style.borderColor = 'transparent'; if (i.value !== value) onChange(i.value); });
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
  return i;
}

function renderItem(it: Item, m: Milestone, ctx: Ctx): HTMLElement {
  const prog = itemProgress(it, ctx);
  const row = el('div', `display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:6px;background:${prog >= 1 ? '#191f19' : '#14141c'}`);

  if (isCounter(it)) {
    row.appendChild(el('div', `width:18px;text-align:center;color:${C.dim};flex:none`, '▤'));
    row.appendChild(inlineText(it.title, 'flex:1;min-width:120px;font-size:13px', (v) => { it.title = v; touch(); }));

    const cur = currentOf(it, ctx);
    const rem = remainingOf(it, ctx);
    const nums = el('div', `font-size:12px;font-variant-numeric:tabular-nums;color:${C.dim};min-width:86px;text-align:right`,
      cur === null ? '— / ' + it.target : `${cur} / ${it.target}`);
    row.appendChild(nums);
    row.appendChild(bar(prog, prog >= 1 ? C.done : C.active, '130px', 7));
    row.appendChild(el('div', `font-size:12px;color:${rem === 0 ? C.done : C.dim};min-width:104px;font-variant-numeric:tabular-nums`,
      rem === null ? '' : rem === 0 ? '✓ закрыто' : `осталось ${rem}`));
    row.appendChild(sourceControl(it));
  } else {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!it.done;
    cb.style.cssText = 'width:16px;height:16px;cursor:pointer;flex:none;accent-color:' + C.done;
    cb.addEventListener('change', () => { it.done = cb.checked; touch(); });
    row.appendChild(cb);
    row.appendChild(inlineText(it.title, `flex:1;min-width:120px;font-size:13px;${it.done ? 'color:' + C.dim + ';text-decoration:line-through' : ''}`, (v) => { it.title = v; touch(); }));
    row.appendChild(inlineText(it.est ?? '', `width:78px;font-size:11px;color:${C.faint};text-align:right`, (v) => { it.est = v || undefined; touch(); }, 'оценка'));
  }

  // Исполнитель — общий для обоих видов пунктов
  const who = document.createElement('select');
  who.style.cssText = `background:${C.bg};color:${C.dim};border:1px solid ${C.edge};border-radius:5px;padding:3px 5px;font-size:11px;flex:none`;
  for (const [v, label] of [['', '—'], ['art', WHO_LABEL.art], ['code', WHO_LABEL.code], ['design', WHO_LABEL.design]] as const) {
    const o = document.createElement('option'); o.value = v; o.textContent = label; who.appendChild(o);
  }
  who.value = it.who ?? '';
  who.addEventListener('change', () => { it.who = (who.value || undefined) as Who | undefined; touch(); });
  row.appendChild(who);

  row.appendChild(btn('✕', () => { m.items = m.items.filter((x) => x !== it); touch(); }, `padding:3px 7px;color:${C.faint};flex:none`));
  return row;
}

/** Выбор источника числа: конфиг (считает сам) · файлы на сервере (считает сам) · вручную. */
function sourceControl(it: Item): HTMLElement {
  const wrap = el('div', 'display:flex;align-items:center;gap:5px;flex:none');

  const kind = document.createElement('select');
  kind.style.cssText = `background:${C.bg};color:${C.dim};border:1px solid ${C.edge};border-radius:5px;padding:3px 5px;font-size:11px`;
  for (const [v, label] of [['config', 'конфиг'], ['assets', 'файлы'], ['manual', 'вручную']] as const) {
    const o = document.createElement('option'); o.value = v; o.textContent = label; kind.appendChild(o);
  }
  kind.value = it.source?.kind ?? 'config';
  kind.addEventListener('change', () => {
    it.source = kind.value === 'config' ? { kind: 'config', counter: 'monsters' }
      : kind.value === 'assets' ? { kind: 'assets', ext: 'glb' }
        : { kind: 'manual', value: 0 };
    touch();
  });
  wrap.appendChild(kind);

  const s: Source | undefined = it.source;
  if (s?.kind === 'config') {
    const sel = document.createElement('select');
    sel.style.cssText = `background:${C.bg};color:${C.dim};border:1px solid ${C.edge};border-radius:5px;padding:3px 5px;font-size:11px;max-width:150px`;
    for (const [key, def] of Object.entries(COUNTERS)) {
      const o = document.createElement('option'); o.value = key; o.textContent = def.label; sel.appendChild(o);
    }
    sel.value = s.counter;
    sel.addEventListener('change', () => { it.source = { kind: 'config', counter: sel.value }; touch(); });
    wrap.appendChild(sel);
  } else if (s?.kind === 'assets') {
    wrap.appendChild(inlineText(s.ext, `width:52px;font-size:11px;color:${C.dim}`, (v) => { it.source = { kind: 'assets', ext: v.trim().toLowerCase(), dir: s.dir }; touch(); }, 'glb'));
    wrap.appendChild(inlineText(s.dir ?? '', `width:96px;font-size:11px;color:${C.faint}`, (v) => { it.source = { kind: 'assets', ext: s.ext, dir: v.trim() || undefined }; touch(); }, 'папка'));
  } else if (s?.kind === 'manual') {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.value = String(s.value);
    inp.style.cssText = `width:72px;background:${C.bg};color:${C.text};border:1px solid ${C.edge};border-radius:5px;padding:3px 5px;font-size:11px`;
    inp.addEventListener('change', () => { it.source = { kind: 'manual', value: Number(inp.value) || 0 }; touch(); });
    wrap.appendChild(inp);
  }

  const tgt = document.createElement('input');
  tgt.type = 'number'; tgt.value = String(it.target ?? 0);
  tgt.title = 'Цель';
  tgt.style.cssText = `width:64px;background:${C.bg};color:${C.text};border:1px solid ${C.edge};border-radius:5px;padding:3px 5px;font-size:11px`;
  tgt.addEventListener('change', () => { it.target = Number(tgt.value) || 0; touch(); });
  wrap.appendChild(el('span', `color:${C.faint};font-size:11px`, 'цель'));
  wrap.appendChild(tgt);
  return wrap;
}

/**
 * Окно пересчёта. Показывает, ЧТО и ПОЧЕМУ изменится, и применяет только по кнопке: дата релиза не
 * должна меняться сама по себе, иначе теряется само понятие плана — остаётся лента, которая всегда
 * «успевает». Поэтому `replan` только считает, а решение принимает человек.
 */
function showReplan(ctx: Ctx): void {
  const { drift, proposals, notes } = replan(doc, ctx);
  const back = el('div', 'position:fixed;inset:0;background:#000a;z-index:80;display:flex;align-items:center;justify-content:center');
  const box = el('div', `min-width:min(720px,92vw);max-width:820px;max-height:78vh;overflow-y:auto;background:#171720;border:1px solid ${C.edge};border-radius:10px;padding:18px 20px`);
  back.appendChild(box);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });

  box.appendChild(el('div', 'font-size:15px;font-weight:700;margin-bottom:6px', '\u27f3 Пересчёт плана под календарь Steam'));
  box.appendChild(el('div', `color:${C.dim};font-size:12px;margin-bottom:14px;line-height:1.55`,
    drift === 0
      ? 'Идём ровно по плану. Проверяем только, не появилось ли более раннего фестиваля и не съехало ли окно запуска.'
      : drift > 0
        ? `Отставание ${drift} дн на последней закрытой вехе — на столько же едет вся оставшаяся работа.`
        : `Опережение ${-drift} дн на последней закрытой вехе — возможно, успеваем на более ранний фестиваль.`));

  if (!proposals.length) box.appendChild(el('div', `color:${C.done};font-size:13px;margin-bottom:10px`, '\u2713 Менять нечего — план уже согласован с календарём.'));

  for (const pr of proposals) {
    const row = el('div', 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:8px 10px;border-radius:6px;background:#12121a;margin-bottom:5px');
    row.appendChild(el('div', 'flex:1;min-width:180px;font-size:13px', pr.title));
    row.appendChild(el('div', `font-size:12px;color:${C.faint};font-variant-numeric:tabular-nums`, fmtDate(pr.from)));
    row.appendChild(el('div', `font-size:12px;color:${C.faint}`, '\u2192'));
    row.appendChild(el('div', `font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:${pr.later ? C.over : C.done}`, fmtDate(pr.to)));
    row.appendChild(el('div', `flex-basis:100%;font-size:11px;color:${C.dim}`, pr.why));
    box.appendChild(row);
  }

  if (notes.length) {
    box.appendChild(el('div', `margin-top:12px;color:${C.faint};font-size:10px;text-transform:uppercase;letter-spacing:.06em`, 'почему так'));
    for (const n of notes) box.appendChild(el('div', `font-size:12px;color:${C.dim};padding:3px 0;line-height:1.5`, '· ' + n));
  }

  const foot = el('div', 'margin-top:16px;display:flex;justify-content:flex-end;gap:6px');
  if (proposals.length) {
    foot.appendChild(btn(`Применить (${proposals.length})`, () => {
      const n = applyProposals(doc, proposals);
      back.remove(); touch();
      alert(`Изменено вех: ${n}. Изначальный план у каждой сохранён — отклонение продолжит считаться от него.`);
    }, 'background:#25321f;border-color:#3f5a33'));
  }
  foot.appendChild(btn('закрыть', () => back.remove()));
  box.appendChild(foot);
  document.body.appendChild(back);
}

/** Заменить содержимое роадмапа целиком (наполнение Р6 и импорт). */
export function setRoadmap(next: RoadmapDoc): void { doc = next; selected = 0; touch(); }
