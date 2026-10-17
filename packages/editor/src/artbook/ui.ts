/**
 * ⭐ 16.10 (Артбук): мелкий UI-кит вкладки — цвета темы редактора, кнопки, бейджи, свёртываемые разделы, таблицы, образцы
 * палитры, лайтбокс. Только DOM, без состояния артбука (оно — в `widgets.ts` и `store.ts`).
 */
import { STATUS_LABEL, type ImgStatus, type SlotImage } from './model.js';

/** Цвета тёмной темы редактора (те же, что у «Роадмапа» и «Документации»). */
export const C = {
  page: '#14141a', bg: '#1c1c26', panel: '#17171f', input: '#0f0f16', edge: '#2c2c3a', edgeSoft: '#24242f', active: '#3a3a4c',
  text: '#e8e8f0', soft: '#d4d6e0', dim: '#9a9ab0', faint: '#6f6f88', accent: '#8fb7ff',
  ok: '#5fbf7f', warn: '#c79a44', bad: '#d4634a', gold: '#e8c98a',
} as const;

export const STATUS_COLOR: Record<ImgStatus, string> = { none: C.faint, draft: C.warn, approved: C.ok };

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
};

export const btn = (label: string, fn: (e: MouseEvent) => void, css = ''): HTMLButtonElement => {
  const b = el('button', `padding:5px 10px;cursor:pointer;border-radius:6px;border:1px solid ${C.edge};background:${C.bg};color:${C.text};font-size:12px;white-space:nowrap;${css}`, label);
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
  return b;
};

/** Бейдж-плашка. */
export const chip = (text: string, color: string = C.dim, title = ''): HTMLElement => {
  const c = el('span', `display:inline-block;padding:1px 7px;border-radius:9px;border:1px solid ${color}55;background:${color}1f;color:${color};font-size:11px;line-height:16px;white-space:nowrap;vertical-align:1px`, text);
  if (title) c.title = title;
  return c;
};

export const statusChip = (s: ImgStatus): HTMLElement => chip(STATUS_LABEL[s], STATUS_COLOR[s]);

/** Заголовок блока внутри страницы. */
export const h2 = (text: string): HTMLElement => el('div', `font-size:18px;font-weight:700;color:${C.text};margin:4px 0 8px`, text);
export const h3 = (text: string): HTMLElement => el('div', `font-size:12px;font-weight:600;color:#a7b0c8;text-transform:uppercase;letter-spacing:0.04em;margin:14px 0 6px`, text);
export const muted = (text: string, css = ''): HTMLElement => el('div', `font-size:12px;color:${C.dim};${css}`, text);

/**
 * Пометки движка в тексте черновика — `[есть]`, `[данные]`, `[код К13]`, `[К5 + К2]`, `[мёртвое поле]` — цветными бейджами:
 * программист видит их глазом, художник — пропускает. ⭐ 17.10: и пометки ростеров v2 — `[есть: ranged-kiter]`, `[легко: новый щит]`,
 * `[на будущее: К9]` (код сейчас не пишем — решение владельца 16.10).
 */
const MARK_RE = /\[(есть[^\]]*|данные[^\]]*|легко[^\]]*|на будущее[^\]]*|код[^\]]*|мёртвое поле[^\]]*|К\d+[^\]]*)\]/g;
/** Цвет пометки: есть — зелёный, данные / легко — голубой, мёртвое поле — серый, код / на будущее — охра. */
export const markColor = (t: string): string =>
  t.startsWith('есть') ? C.ok : t.startsWith('данные') || t.startsWith('легко') ? C.accent : t.startsWith('мёртвое') ? C.faint : C.warn;
/** ⭐ 17.10: `id` в обратных кавычках (`u-buckler`, `packs.json`) — моноширинным, без кавычек. */
const CODE_RE = /`([^`\n]+)`/g;
function appendPlain(frag: DocumentFragment, s: string): void {
  let last = 0;
  for (const m of s.matchAll(CODE_RE)) {
    if (m.index! > last) frag.append(s.slice(last, m.index));
    frag.append(el('code', `font-family:ui-monospace,monospace;font-size:0.92em;color:${C.text};background:${C.input};padding:0 3px;border-radius:3px`, m[1]!));
    last = m.index! + m[0].length;
  }
  if (last < s.length) frag.append(s.slice(last));
}
export function richText(s: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(MARK_RE)) {
    if (m.index! > last) appendPlain(frag, s.slice(last, m.index));
    const t = m[1]!;
    const color = markColor(t);
    frag.append(chip(t, color));
    last = m.index! + m[0].length;
  }
  if (last < s.length) appendPlain(frag, s.slice(last));
  return frag;
}

// ── Свёртываемые разделы ─────────────────────────────────────────────────────────────────────────

const LS_OPEN = 'artbook_open';
const openSet: Set<string> = (() => { try { return new Set((localStorage.getItem(LS_OPEN) ?? '').split('|').filter(Boolean)); } catch { return new Set<string>(); } })();
const closedSet: Set<string> = (() => { try { return new Set((localStorage.getItem(LS_OPEN + '_x') ?? '').split('|').filter(Boolean)); } catch { return new Set<string>(); } })();
const saveOpen = (): void => {
  try { localStorage.setItem(LS_OPEN, [...openSet].join('|')); localStorage.setItem(LS_OPEN + '_x', [...closedSet].join('|')); } catch { /* приватное окно */ }
};

/**
 * Свёртываемый раздел: заголовок ▸/▾ и тело, которое строится только раскрытым (большие разделы черновика не тормозят
 * страницу). Раскрытость помнится по `key` (localStorage). `open` — как раскрыт при первом показе.
 */
export function section(title: string, key: string, build: (body: HTMLElement) => void, opts: { open?: boolean; note?: string; level?: 1 | 2 } = {}): HTMLElement {
  const box = el('div', `border:1px solid ${C.edgeSoft};border-radius:8px;background:${C.panel};margin:0 0 10px`);
  const isOpen = (): boolean => (openSet.has(key) ? true : closedSet.has(key) ? false : !!opts.open);
  const head = el('div', `display:flex;align-items:baseline;gap:8px;padding:9px 12px;cursor:pointer;user-select:none`);
  const caret = el('span', `color:${C.dim};width:12px;flex:0 0 12px`, isOpen() ? '▾' : '▸');
  const t = el('span', `font-weight:600;font-size:${opts.level === 2 ? 13 : 14.5}px;color:${C.text}`, title);
  head.append(caret, t);
  if (opts.note) head.append(el('span', `font-size:12px;color:${C.faint}`, opts.note));
  const body = el('div', `padding:2px 14px 12px 32px`);
  box.append(head);
  const fill = (): void => { body.innerHTML = ''; build(body); box.append(body); };
  if (isOpen()) fill();
  head.addEventListener('click', () => {
    const now = !isOpen();
    if (now) { openSet.add(key); closedSet.delete(key); fill(); } else { openSet.delete(key); closedSet.add(key); body.remove(); }
    caret.textContent = now ? '▾' : '▸';
    saveOpen();
  });
  return box;
}

// ── Таблица ──────────────────────────────────────────────────────────────────────────────────────

export type Cell = string | Node | null | undefined;
/** Компактная таблица в стиле `.doc-body`: шапка, зебра, перенос строк в ячейках; узкий экран — прокрутка вбок. */
export function table(head: string[], rows: Cell[][], opts: { widths?: (string | undefined)[]; onRow?: (i: number) => void; rowCss?: (i: number) => string } = {}): HTMLElement {
  const wrap = el('div', 'overflow-x:auto;margin:6px 0 10px');
  const t = el('table', `border-collapse:collapse;font-size:12.5px;width:100%`);
  const tr = el('tr');
  head.forEach((h, i) => {
    const th = el('th', `border:1px solid ${C.edge};padding:5px 8px;text-align:left;background:${C.bg};color:#cdd3e6;font-weight:600;vertical-align:bottom;${opts.widths?.[i] ? 'width:' + opts.widths[i] : ''}`, h);
    tr.append(th);
  });
  const thead = el('thead'); thead.append(tr); t.append(thead);
  const tb = el('tbody');
  rows.forEach((r, i) => {
    const row = el('tr', `${i % 2 ? `background:${C.panel};` : ''}${opts.onRow ? 'cursor:pointer;' : ''}${opts.rowCss?.(i) ?? ''}`);
    for (const c of r) {
      const td = el('td', `border:1px solid ${C.edge};padding:5px 8px;vertical-align:top;color:${C.soft};line-height:1.45`);
      if (c instanceof Node) td.append(c); else if (c) td.textContent = c;
      row.append(td);
    }
    if (opts.onRow) {
      row.addEventListener('click', () => opts.onRow!(i));
      row.addEventListener('mouseenter', () => { row.style.background = C.active; });
      row.addEventListener('mouseleave', () => { row.style.background = i % 2 ? C.panel : ''; });
    }
    tb.append(row);
  });
  t.append(tb);
  wrap.append(t);
  return wrap;
}

/** Строка «ключ — значение» (числа, справки). */
export function kv(k: string, v: Cell, css = ''): HTMLElement {
  const r = el('div', `display:flex;gap:10px;font-size:12.5px;margin:2px 0;${css}`);
  const vv = el('div', `color:${C.soft};flex:1;min-width:0`);
  if (v instanceof Node) vv.append(v); else if (v) vv.textContent = v;
  r.append(el('div', `color:${C.dim};flex:0 0 auto;min-width:140px`, k), vv);
  return r;
}

/** Образцы палитры: квадрат цвета, hex, роль. */
export function swatches(colors: readonly { hex: string; role: string }[]): HTMLElement {
  const g = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px;margin:6px 0 10px');
  for (const c of colors) {
    const it = el('div', `display:flex;gap:8px;align-items:center;padding:4px;border:1px solid ${C.edgeSoft};border-radius:6px;background:${C.bg}`);
    const sw = el('div', `flex:0 0 34px;height:34px;border-radius:4px;border:1px solid #0006;background:${/^#[0-9a-f]{3,8}$/i.test(c.hex) ? c.hex : 'transparent'}`);
    const t = el('div', 'min-width:0;font-size:11.5px;line-height:1.3');
    t.append(el('div', `color:${C.text};font-family:ui-monospace,monospace`, c.hex), el('div', `color:${C.dim}`, c.role));
    it.append(sw, t);
    g.append(it);
  }
  return g;
}

/** Источники: «название ↗» новой вкладкой. */
export function sourcesList(list: readonly { title: string; url: string }[]): HTMLElement {
  const ul = el('ul', 'margin:4px 0 8px;padding-left:18px;font-size:12px');
  for (const s of list) {
    const li = el('li', `color:${C.dim};margin:2px 0`);
    const a = el('a', `color:${C.accent}`, s.title);
    a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
    li.append(a);
    ul.append(li);
  }
  return ul;
}

/** Пунктирная заглушка на месте картинки. */
export function placeholder(text: string, w: number | string, h: number | string, css = ''): HTMLElement {
  const W = typeof w === 'number' ? w + 'px' : w, H = typeof h === 'number' ? h + 'px' : h;
  return el('div', `width:${W};height:${H};box-sizing:border-box;border:1.5px dashed ${C.edge};border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center;padding:6px;color:${C.faint};font-size:11px;line-height:1.3;${css}`, text);
}

// ── Лайтбокс ─────────────────────────────────────────────────────────────────────────────────────

/** Крупный просмотр картинок слота: ← / → листают, Esc или клик мимо — закрыть. */
export function openLightbox(images: readonly SlotImage[], start: number, title = ''): void {
  if (!images.length) return;
  let i = Math.max(0, Math.min(images.length - 1, start));
  const ov = el('div', 'position:fixed;inset:0;z-index:10000;background:#000d;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;box-sizing:border-box');
  const img = el('img', 'max-width:92vw;max-height:80vh;object-fit:contain;border-radius:6px;box-shadow:0 8px 40px #000;background:#0b0b10');
  const cap = el('div', `display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;color:${C.text};font-size:13px;max-width:92vw`);
  const close = (): void => { ov.remove(); removeEventListener('keydown', onKey, true); };
  const show = (): void => {
    const x = images[i]!;
    img.src = x.url; img.alt = x.caption || x.name || '';
    cap.innerHTML = '';
    if (title) cap.append(el('span', `color:${C.dim}`, title));
    if (x.main) cap.append(chip('★ главный', C.gold));
    cap.append(statusChip(x.status));
    if (x.caption) cap.append(el('span', '', x.caption));
    if (x.name) cap.append(el('span', `color:${C.faint};font-size:11.5px`, x.name));
    if (images.length > 1) cap.append(el('span', `color:${C.faint}`, `${i + 1} / ${images.length}`));
    const a = el('a', `color:${C.accent};font-size:12px`, 'оригинал ↗'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener';
    a.addEventListener('click', (e) => e.stopPropagation());
    cap.append(a);
  };
  const step = (d: number): void => { i = (i + d + images.length) % images.length; show(); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  };
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  img.addEventListener('click', (e) => { e.stopPropagation(); if (images.length > 1) step(1); });
  addEventListener('keydown', onKey, true);
  ov.append(img, cap);
  if (images.length > 1) {
    const nav = el('div', 'display:flex;gap:8px');
    nav.append(btn('← назад', () => step(-1)), btn('вперёд →', () => step(1)), btn('✕ закрыть', close));
    ov.append(nav);
  } else ov.append(btn('✕ закрыть', close));
  show();
  document.body.append(ov);
}
