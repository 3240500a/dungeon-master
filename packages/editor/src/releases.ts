/**
 * ⭐ 08.10 (Д3, план «Обновление контента без пересборки клиента»): ВКЛАДКА «📦 ВЫПУСКИ» — релизы контента и каналы dev / beta / live.
 *
 * Здесь только DOM и состояние вкладки; разбор ответов, правила и тексты подтверждений — `releasesModel.ts` (чистый, под тестами).
 * Сервер — ручки администратора `/api/admin/content/*` через `devFetch` (токен админа; на 401 — вход и повтор). Ручки открыты и на проде:
 * выпуск — это продвижение готового релиза под ролью админа, правки в обход релиза нет.
 *
 *  • Список релизов: номер, дата, хэш манифеста, на какие каналы указывает и с каким процентом. Щелчок по строке — выбор релиза.
 *  • Каналы: текущий релиз, прежний, раскатка, minClient / latestClient, кто и когда менял. `dev` — только просмотр (он сам).
 *  • Кнопки «В бету», «Выпустить» (процент 1..100), «Откатить», подъём раскатки, версии клиента — каждая через `window.confirm` с текстом
 *    «что будет» из плана; заведомый отказ (правило сервера) показывается сразу, без подтверждения. После действия список перечитывается.
 */
import { devFetch } from '@dm/client/devAuth.js';
import {
  AUTO_CHANNEL, LIST_LIMIT, actorText, badgesOf, buildModel, clientText, fmtTime, loadList, originOf, parsePercentInput, planClients,
  planPromote, planRollback, releaseLine, rolloutText, runPlan, short,
  type Badge, type ChannelView, type PageModel, type Plan, type ReleaseList,
} from './releasesModel.js';

const C = {
  bg: '#1c1c26', card: '#20202b', edge: '#2c2c3a', text: '#e8e8f0', dim: '#9a9ab0', faint: '#6f6f88',
  ok: '#5fbf7f', warn: '#c79a44', bad: '#d4634a', sel: '#2f2f40', accent: '#3a3a4c',
};
const BADGE: Record<Badge['kind'], string> = { current: '#2f5a3e', rollout: '#6a5426', prev: '#3a3a52', target: '#2a2a36' };

const el = (tag: string, css = '', text = ''): HTMLElement => {
  const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e;
};
const btn = (label: string, fn: () => void, opts: { disabled?: boolean; title?: string; strong?: boolean } = {}): HTMLButtonElement => {
  const b = document.createElement('button'); b.textContent = label;
  b.style.cssText = `padding:6px 12px;cursor:pointer;border-radius:6px;border:1px solid ${C.edge};background:${opts.strong ? C.accent : C.bg};color:${C.text};font-size:12px;${opts.strong ? 'font-weight:600;' : ''}`;
  if (opts.title) b.title = opts.title;
  if (opts.disabled) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'default'; }
  b.addEventListener('click', fn); return b;
};
const input = (value: string, onInput: (v: string) => void, width = 70, title = ''): HTMLInputElement => {
  const i = document.createElement('input');
  i.value = value; i.inputMode = 'numeric'; if (title) i.title = title;
  i.style.cssText = `width:${width}px;background:#11141c;color:${C.text};border:1px solid #39435a;border-radius:4px;padding:5px 7px;font:inherit;font-size:12px`;
  i.addEventListener('input', () => onInput(i.value));
  return i;
};

// ── Состояние вкладки (переживает перерисовку и переход между вкладками) ─────────────────────────────
let list: ReleaseList | null = null;
let abiSel: number | undefined;
let selected: number | undefined;
let loading = false;
let busy = false;
let loadError = '';
let actionError = '';
let notice = '';
let percentText = '100';
const raiseText: Record<string, string> = {};
/** Поля версий клиента по каналу; после перечитки — значения сервера. */
const clientInputs: Record<string, { min: string; latest: string }> = {};
let hostEl: HTMLElement | null = null;

export function renderReleasesPage(host: HTMLElement): void {
  hostEl = host;
  draw();
  if (!loading) void reload();
}

async function reload(): Promise<void> {
  loading = true; draw();
  const r = await loadList(devFetch, LIST_LIMIT);
  loading = false;
  if (r.ok) {
    list = r.value; loadError = '';
    const m = model();
    if (m) {
      for (const c of m.channels) if (c.state) clientInputs[c.name] = { min: String(c.state.minClient), latest: String(c.state.latestClient) };
      if (selected === undefined || !m.releases.some((x) => x.seq === selected)) selected = m.releases[0]?.seq;
    }
  } else loadError = list ? `${r.error} Ниже — список, прочитанный раньше: он мог устареть.` : r.error;
  draw();
}

const model = (): PageModel | null => {
  if (!list) return null;
  const abi = abiSel !== undefined && (abiSel === list.abi || list.releases.some((r) => r.abi === abiSel) || list.channels.some((c) => c.abi === abiSel)) ? abiSel : list.abi;
  return buildModel(list, abi);
};

/** Действие: заведомый отказ — сразу текстом; иначе подтверждение «что будет» → запрос → итог → перечитать список. */
async function act(plan: Plan): Promise<void> {
  if (!plan.ok) {
    if (plan.noop) { notice = `${plan.what}: ${plan.error}`; actionError = ''; } else { actionError = `${plan.what}: ${plan.error}`; notice = ''; }
    draw(); return;
  }
  if (!window.confirm(plan.confirm)) return;
  busy = true; actionError = ''; notice = ''; draw();
  const r = await runPlan(devFetch, plan);
  busy = false;
  if (r.ok) notice = r.text; else actionError = r.error;
  await reload();
}

// ── Отрисовка ────────────────────────────────────────────────────────────────────────────────────
function draw(): void {
  const host = hostEl;
  if (!host) return;
  host.innerHTML = '';
  const wrap = el('div', `flex:1 1 auto;min-height:0;overflow:auto;color:${C.text};font-size:13px;padding-right:6px`);
  host.appendChild(wrap);
  const m = model();

  const head = el('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px');
  head.appendChild(el('div', 'font-size:17px;font-weight:600', '📦 Выпуски контента'));
  if (m && m.abis.length > 1) {
    const s = document.createElement('select');
    s.style.cssText = `background:#11141c;color:${C.text};border:1px solid #39435a;border-radius:4px;padding:4px 6px`;
    for (const a of m.abis) { const o = document.createElement('option'); o.value = String(a); o.textContent = `ABI ${a}${a === m.serverAbi ? ' (сервера)' : ''}`; o.selected = a === m.abi; s.appendChild(o); }
    s.addEventListener('change', () => { abiSel = Number(s.value); selected = undefined; draw(); });
    head.appendChild(s);
  }
  head.appendChild(btn(loading ? '⟳ Читаю…' : '⟳ Обновить', () => { if (!loading) void reload(); }, { disabled: loading || busy }));
  if (busy) head.appendChild(el('span', `color:${C.warn}`, 'выполняю…'));
  wrap.appendChild(head);

  wrap.appendChild(el('div', `color:${C.dim};line-height:1.5;margin-bottom:8px;max-width:980px`,
    'Порядок: dev (сам, на каждой нарезке) → «В бету» → «Выпустить» в live, можно по процентам (10% → 50% → 100%). «Откатить» возвращает канал '
    + 'к прежнему содержимому под НОВЫМ номером — номер у клиента только растёт. Каждое действие спрашивает подтверждение. Справка — «📖 Документация → '
    + 'Unity: контент и доставка → Выпуски контента».'));

  const banner = (text: string, color: string): void => {
    wrap.appendChild(el('div', `border:1px solid ${color};color:${color};background:${C.bg};border-radius:6px;padding:8px 10px;margin-bottom:8px;white-space:pre-wrap;max-width:980px`, text));
  };
  if (loadError) banner(loadError, C.bad);
  if (actionError) banner(actionError, C.bad);
  if (notice) banner(`✓ ${notice}`, C.ok);
  if (!m) {
    if (loading) wrap.appendChild(el('div', `color:${C.dim}`, 'Читаю список релизов…'));
    return;
  }

  const info = el('div', `color:${C.faint};margin-bottom:10px;line-height:1.5`);
  info.textContent = `Сервер: ABI ${m.serverAbi} · подпись указателя — ключ ${m.keyId}${m.devKey ? ' (ДЕВ-ключ сервера)' : ''} · каналы без выпуска: `
    + (m.devFallback ? 'получают указатель dev (запасной путь включён)' : '404 «канал не выпущен» — клиент играет тем, что на диске');
  wrap.appendChild(info);
  if (m.devKey) {
    banner('⚠ Указатель подписан ДЕВ-ключом, который сервер завёл сам. Сборка игрока с зашитым боевым ключом такой указатель отвергнет и останется на старом '
      + 'контенте. Для беты и продакшена нужен свой ключ — DM_CONTENT_SIGN_KEY_FILE (docs/DEPLOY.md).', C.warn);
  }

  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-bottom:12px;max-width:1200px');
  for (const c of m.channels) grid.appendChild(channelCard(m, c));
  wrap.appendChild(grid);

  wrap.appendChild(actionBar(m));
  wrap.appendChild(releaseTable(m));
}

function kv(parent: HTMLElement, k: string, v: string, color: string = C.text): void {
  const row = el('div', 'display:flex;gap:8px;line-height:1.6');
  row.appendChild(el('span', `color:${C.dim};flex:0 0 92px`, k));
  row.appendChild(el('span', `color:${color};min-width:0;overflow-wrap:anywhere`, v));
  parent.appendChild(row);
}

function channelCard(m: PageModel, c: ChannelView): HTMLElement {
  const card = el('div', `background:${C.card};border:1px solid ${C.edge};border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px`);
  const title = el('div', 'display:flex;align-items:baseline;gap:8px;margin-bottom:4px');
  title.appendChild(el('span', 'font-size:15px;font-weight:600', c.name));
  title.appendChild(el('span', `color:${C.faint};font-size:12px`, c.auto ? 'сам, на каждой нарезке' : 'кнопкой администратора'));
  card.appendChild(title);
  const s = c.state;
  if (!s) {
    card.appendChild(el('div', `color:${C.dim};line-height:1.5`, c.name === AUTO_CHANNEL
      ? 'Релиза ещё нет — указатель отвечает 503 «повтори». Нарезчик выпустит dev сам после первой правки контента.'
      : `Не выпущен. ${m.devFallback ? `Клиенты ${c.name} пока получают указатель dev (запасной путь).` : `Клиенты ${c.name} получают 404 «канал не выпущен» и играют тем, что на диске.`} `
        + 'Первый выпуск — только на 100%.'));
  } else {
    kv(card, 'Раздаёт', c.current ? releaseLine(c.current) : `#${s.seq}`);
    kv(card, 'Раскатка', rolloutText(c), s.rollout < 100 ? C.warn : C.text);
    kv(card, 'Прежний', s.prev === null ? 'нет' : c.previous ? releaseLine(c.previous) : `#${s.prev}`, s.prev === null ? C.faint : C.text);
    kv(card, 'minClient', clientText(s.minClient), s.minClient > 0 ? C.warn : C.faint);
    kv(card, 'latestClient', clientText(s.latestClient), s.latestClient > 0 ? C.text : C.faint);
    kv(card, 'Изменён', `${fmtTime(s.updated)} · ${actorText(s.updatedBy)}`, C.faint);
  }
  if (c.auto) {
    card.appendChild(el('div', `color:${C.faint};margin-top:6px`, 'Только просмотр: dev переключается сам, кнопок у него нет.'));
    return card;
  }
  if (!s) return card;

  const row = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px');
  if (s.prev !== null) row.appendChild(btn(`↩ Откатить к #${s.prev}`, () => { void act(planRollback(m, c.name)); }, { disabled: busy, title: 'Вернуть канал к прежнему содержимому — под новым номером, на 100%' }));
  const sel = selected !== undefined ? m.bySeq.get(selected) : undefined;
  if (sel && sel.seq !== s.prev && (!c.current || c.current.manifest !== sel.manifest)) {
    row.appendChild(btn(`↩ Откатить к выбранному #${sel.seq}`, () => { void act(planRollback(m, c.name, sel.seq)); }, { disabled: busy, title: 'Вернуть канал к содержимому выбранного релиза' }));
  }
  if (s.prev === null && !(sel && (!c.current || c.current.manifest !== sel.manifest))) {
    row.appendChild(el('span', `color:${C.faint};font-size:12px;line-height:28px`, 'Откатывать некуда: прежнего нет — выбери релиз в списке.'));
  }
  card.appendChild(row);

  if (s.rollout < 100) {
    const r = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px');
    r.appendChild(el('span', `color:${C.dim}`, 'Поднять до'));
    r.appendChild(input(raiseText[c.name] ?? '100', (v) => { raiseText[c.name] = v; }, 50, '1..100, только вверх'));
    r.appendChild(el('span', `color:${C.dim}`, '%'));
    r.appendChild(btn('⬆ Поднять раскатку', () => {
      void act(planPromote(m, c.name, s.seq, parsePercentInput(raiseText[c.name] ?? '100') ?? NaN));
    }, { disabled: busy }));
    card.appendChild(r);
  }

  const ci = clientInputs[c.name] ?? { min: String(s.minClient), latest: String(s.latestClient) };
  clientInputs[c.name] = ci;
  const cl = el('div', `display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid ${C.edge}`);
  cl.appendChild(el('span', `color:${C.dim}`, 'min'));
  cl.appendChild(input(ci.min, (v) => { ci.min = v; }, 80, 'minClient: сборки ниже — экран «Обновите игру» (0 — не задан)'));
  cl.appendChild(el('span', `color:${C.dim}`, 'latest'));
  cl.appendChild(input(ci.latest, (v) => { ci.latest = v; }, 80, 'latestClient: сборки ниже — плашка «Доступно обновление» (0 — не задан)'));
  cl.appendChild(btn('Сохранить версии клиента', () => { void act(planClients(m, c.name, ci.min, ci.latest)); }, { disabled: busy }));
  card.appendChild(cl);
  return card;
}

function actionBar(m: PageModel): HTMLElement {
  const bar = el('div', `display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:${C.card};border:1px solid ${C.edge};border-radius:8px;padding:10px 12px;margin-bottom:10px;max-width:1200px`);
  const sel = selected !== undefined ? m.bySeq.get(selected) : undefined;
  bar.appendChild(el('span', `color:${C.dim}`, 'Выбран:'));
  bar.appendChild(el('span', 'font-weight:600;margin-right:8px', sel ? releaseLine(sel) : 'выбери релиз в списке ниже'));
  bar.appendChild(btn('⇢ В бету', () => { if (sel) void act(planPromote(m, 'beta', sel.seq, 100)); }, { disabled: busy || !sel, strong: true, title: 'Выбранный релиз → beta (100%)' }));
  bar.appendChild(el('span', `color:${C.faint};margin-left:10px`, 'live на'));
  bar.appendChild(input(percentText, (v) => { percentText = v; }, 50, 'процент раскатки 1..100'));
  bar.appendChild(el('span', `color:${C.faint}`, '%'));
  bar.appendChild(btn('🚀 Выпустить', () => {
    if (sel) void act(planPromote(m, 'live', sel.seq, parsePercentInput(percentText) ?? NaN));
  }, { disabled: busy || !sel, strong: true, title: 'Выбранный релиз → live на указанный процент' }));
  return bar;
}

function releaseTable(m: PageModel): HTMLElement {
  const box = el('div', 'max-width:1200px');
  box.appendChild(el('div', `color:${C.dim};margin:4px 0 6px`, `Релизы ABI ${m.abi}: ${m.releases.length} (последние ${LIST_LIMIT} и все, на которые смотрит канал). Щелчок по строке — выбрать.`));
  if (!m.releases.length) {
    box.appendChild(el('div', `color:${C.faint}`, 'Релизов ещё нет — нарезчик сервера заведёт первый после правки контента (или POST /api/dev/content/release).'));
    return box;
  }
  const t = document.createElement('table');
  t.style.cssText = `border-collapse:collapse;width:100%;font-size:12px`;
  const th = (s: string): HTMLElement => el('th', `text-align:left;color:${C.dim};font-weight:500;padding:5px 8px;border-bottom:1px solid ${C.edge};white-space:nowrap`, s);
  const hr = document.createElement('tr');
  for (const h of ['', '№', 'Дата', 'Манифест', 'Каналы', 'Ревизии (конфиг · игра)', 'Заметка']) hr.appendChild(th(h));
  t.appendChild(hr);
  for (const r of m.releases) {
    const tr = document.createElement('tr');
    const on = r.seq === selected;
    tr.style.cssText = `cursor:pointer;background:${on ? C.sel : 'transparent'}`;
    tr.addEventListener('click', () => { selected = r.seq; draw(); });
    const td = (child: HTMLElement | string, css = ''): void => {
      const c = el('td', `padding:5px 8px;border-bottom:1px solid ${C.edge};vertical-align:top;${css}`);
      if (typeof child === 'string') c.textContent = child; else c.appendChild(child);
      tr.appendChild(c);
    };
    const radio = document.createElement('input'); radio.type = 'radio'; radio.checked = on; radio.name = 'dm-release';
    td(radio);
    td(`#${r.seq}`, 'font-weight:600;white-space:nowrap');
    td(fmtTime(r.created), 'white-space:nowrap');
    td(`${short(r.manifest)} · ${kb(r.manifestSize)}`, 'font-family:ui-monospace,monospace;white-space:nowrap');
    const bs = el('div', 'display:flex;gap:4px;flex-wrap:wrap');
    for (const b of badgesOf(r)) bs.appendChild(el('span', `background:${BADGE[b.kind]};border-radius:10px;padding:1px 8px;white-space:nowrap`, b.text));
    if (r.origin !== null) bs.appendChild(el('span', `color:${C.faint};white-space:nowrap`, `перевыпуск #${originOf(r)}`));
    td(bs);
    td(`${r.configRev.slice(0, 12)} · ${r.gameRev.slice(0, 12)}`, `font-family:ui-monospace,monospace;color:${C.faint};white-space:nowrap`);
    td(r.note || '', `color:${C.dim}`);
    t.appendChild(tr);
  }
  box.appendChild(t);
  return box;
}

const kb = (n: number): string => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} КБ`);
