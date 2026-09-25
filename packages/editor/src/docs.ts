/**
 * Секция «Документация» редактора: РАЗДЕЛЫ по механикам, в каждом — справка механики и проектные
 * документы, которые мы по ней готовили (ГДД, планы, исследования). Каталог разделов —
 * `packages/editor/docs/sections.json`, логика каталога — `docsCatalog.ts` (без DOM, под тестами).
 *
 * Два рода файлов:
 *  - справки `docs/NN-slug.md` — втянуты сразу (eager), рендер `marked`;
 *  - библиотека `docs/library/*.md|html` — снимки документов, грузятся ЛЕНИВО отдельными чанками:
 *    они крупные (до сотен КБ), и открывать редактор ради них дольше незачем. HTML-снимок показывается
 *    как есть — в рамке `iframe srcdoc` с песочницей: у страниц свои стили, таблицы, схемы и фильтры,
 *    и пересказ в markdown их бы потерял. Своих стилей в редактор такая страница не протечёт.
 *
 * Deep-link на конфиг: в markdown ссылка `[текст](config:balance)` или `[текст](config:balance/Урон)`
 * (после `/` — подветка balance) → переход в секцию «Игра» (см. `gotoConfig` в main.ts).
 * Ссылка на другой документ: `[текст](doc:library/kovka-oruzhiya.html)` или `(doc:section:craft)`.
 */
import { marked } from 'marked';
import {
  buildCatalog, DOC_LINK_MSG, DOC_THEME_MSG, findByUrl, fmtDate, migrateActive, prepareHtml, slugify,
  type CatalogSection, type DocEntry, type SectionEntry,
} from './docsCatalog.js';

// Справки — сразу строками (маленькие). Ключ — путь файла относительно этого модуля.
const MD_EAGER = import.meta.glob('../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// Библиотека — лениво: загрузчик на файл, Vite режет каждый в свой чанк.
const LIBRARY = import.meta.glob('../docs/library/*.{md,html}', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const CATALOG_RAW = import.meta.glob('../docs/sections.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const rel = (key: string): string => key.replace(/^\.\.\/docs\//, '');
const MD: Record<string, string> = Object.fromEntries(Object.entries(MD_EAGER).map(([k, v]) => [rel(k), v]));
const LIB: Record<string, () => Promise<string>> = Object.fromEntries(Object.entries(LIBRARY).map(([k, v]) => [rel(k), v]));

const SECTIONS: SectionEntry[] = (() => {
  const raw = Object.values(CATALOG_RAW)[0];
  const cat = raw ? (JSON.parse(raw) as CatalogSection[]) : [];
  return buildCatalog(cat, (f) => MD[f]);
})();
const ALL_DOCS: DocEntry[] = SECTIONS.flatMap((s) => s.docs);

marked.setOptions({ gfm: true, breaks: false });

const LS = { active: 'editor_doc', open: 'editor_doc_open', theme: 'editor_doc_theme' } as const;
const lsGet = (k: string): string => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* приватное окно */ } };

/** Что открыто: путь файла или `section:<id>` (страница раздела со списком документов). */
let active = migrateActive(lsGet(LS.active), SECTIONS);
let openSections = new Set<string>(lsGet(LS.open).split(',').filter(Boolean));
let theme: 'dark' | 'light' = lsGet(LS.theme) === 'light' ? 'light' : 'dark';
/** Номер отрисовки: ленивая загрузка, пришедшая после смены документа, не должна его перетереть. */
let renderSeq = 0;
/** Прокрутка левой навигации: перерисовка строит её заново, и без этого каждый клик уводил список к началу. */
let navScroll = 0;
/** Открытая рамка HTML-снимка и куда вести её ссылки: сообщения принимаются только от неё. */
let frameLink: { frame: HTMLIFrameElement; host: HTMLElement; opts: DocsOpts } | null = null;

/**
 * Внешняя ссылка: документ с этим оригиналом есть в каталоге — открыть его здесь же (части серии
 * ссылаются друг на друга), иначе — новая вкладка браузера.
 */
function followLink(url: string, host: HTMLElement, opts: DocsOpts): void {
  const doc = findByUrl(SECTIONS, url);
  if (doc) select(doc.file, host, opts);
  else window.open(url, '_blank', 'noopener');
}

addEventListener('message', (e: MessageEvent) => {
  const cur = frameLink;
  if (!cur || e.source !== cur.frame.contentWindow || !cur.frame.isConnected) return;
  const url = (e.data as Record<string, unknown> | null)?.[DOC_LINK_MSG];
  if (typeof url === 'string' && /^https?:/i.test(url)) followLink(url, cur.host, cur.opts);
});

const C = {
  navBg: '#1c1c26', navActive: '#3a3a4c', border: '#2c2c3a', text: '#e8e8f0', muted: '#9a9ab0', accent: '#8fb7ff',
} as const;

function sectionOf(file: string): SectionEntry | undefined {
  return SECTIONS.find((s) => s.docs.some((d) => d.file === file));
}

function select(target: string, host: HTMLElement, opts: DocsOpts): void {
  if (target === active && host.isConnected && host.childElementCount) return; // уже открыт: не сбрасывать прокрутку и состояние рамки
  active = target;
  lsSet(LS.active, target);
  const sec = target.startsWith('section:') ? SECTIONS.find((s) => `section:${s.id}` === target) : sectionOf(target);
  if (sec && sec.docs.length > 1) { openSections.add(sec.id); lsSet(LS.open, [...openSections].join(',')); }
  renderDocs(host, opts);
}

interface DocsOpts { gotoConfig: (key: string, group?: string) => void }

/** Отрисовать секцию документации: слева разделы с документами, справа — открытый документ. */
export function renderDocs(host: HTMLElement, opts: DocsOpts): void {
  host.innerHTML = '';
  if (!ALL_DOCS.length) {
    const empty = document.createElement('div');
    empty.style.cssText = `color:${C.muted};padding:20px`;
    empty.textContent = 'Документов пока нет. Добавь markdown в packages/editor/docs/ и строку в docs/sections.json.';
    host.appendChild(empty);
    return;
  }
  if (!active) active = ALL_DOCS[0]!.file;
  const cur = active.startsWith('section:') ? undefined : ALL_DOCS.find((d) => d.file === active);
  const curSec = active.startsWith('section:') ? SECTIONS.find((s) => `section:${s.id}` === active) : undefined;
  if (!cur && !curSec) active = ALL_DOCS[0]!.file;
  // Раскрыть раздел ОТКРЫТОГО ДОКУМЕНТА. Страницу раздела сюда не брать: иначе повторный клик по
  // заголовку (свернуть) тут же раскрывал бы раздел обратно, и свернуть его было нельзя вовсе.
  const ownSec = cur ? sectionOf(cur.file) : undefined;
  if (ownSec && ownSec.docs.length > 1) openSections.add(ownSec.id);

  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;gap:16px;flex:1;min-height:0';
  const nav = buildNav(host, opts);
  layout.append(nav, buildPage(host, opts));
  host.appendChild(layout);
  restoreNavScroll(nav);
}

/** Вернуть прокрутку навигации и, если открытый пункт за краем, подтянуть его — только внутри навигации. */
function restoreNavScroll(nav: HTMLElement): void {
  nav.scrollTop = navScroll;
  const cur = nav.querySelector<HTMLElement>('[data-active="1"]');
  if (cur) {
    const top = cur.offsetTop, bottom = top + cur.offsetHeight;
    if (top < nav.scrollTop) nav.scrollTop = Math.max(0, top - 8);
    else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight + 8;
  }
  navScroll = nav.scrollTop;
  nav.addEventListener('scroll', () => { navScroll = nav.scrollTop; }, { passive: true });
}

function navButton(label: string, isActive: boolean, indent: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.style.cssText = `text-align:left;padding:${indent ? '6px 10px 6px 22px' : '8px 12px'};cursor:pointer;border-radius:6px;`
    + `border:1px solid ${indent ? 'transparent' : C.border};background:${isActive ? C.navActive : (indent ? 'transparent' : C.navBg)};`
    + `color:${C.text};font-size:${indent ? 12.5 : 13}px;display:flex;gap:8px;align-items:baseline;width:100%`;
  const t = document.createElement('span');
  t.textContent = label;
  t.style.cssText = 'flex:1;min-width:0';
  b.appendChild(t);
  if (isActive) b.dataset.active = '1';
  return b;
}

function buildNav(host: HTMLElement, opts: DocsOpts): HTMLElement {
  const nav = document.createElement('div');
  nav.style.cssText = 'position:relative;flex:0 0 250px;display:flex;flex-direction:column;gap:4px;min-height:0;overflow-y:auto;padding-right:4px';
  for (const s of SECTIONS) {
    if (s.docs.length === 1) {
      // Раздел из одной справки — одна кнопка, как раньше: раскрывать нечего.
      const d = s.docs[0]!;
      const b = navButton(s.title, active === d.file, false);
      if (s.about) b.title = s.about;
      b.addEventListener('click', () => select(d.file, host, opts));
      nav.appendChild(b);
      continue;
    }
    const open = openSections.has(s.id);
    const head = navButton(s.title, active === `section:${s.id}`, false);
    const caret = document.createElement('span');
    caret.textContent = open ? '▾' : '▸';
    caret.style.cssText = `color:${C.muted};width:10px`;
    head.prepend(caret);
    const n = document.createElement('span');
    n.textContent = String(s.docs.length);
    n.style.cssText = `color:${C.muted};font-size:11.5px`;
    head.appendChild(n);
    head.addEventListener('click', () => {
      // Клик по заголовку открывает страницу раздела; повторный по уже открытой — сворачивает/раскрывает.
      if (active === `section:${s.id}`) {
        if (open) openSections.delete(s.id); else openSections.add(s.id);
        lsSet(LS.open, [...openSections].join(','));
        renderDocs(host, opts);
        return;
      }
      select(`section:${s.id}`, host, opts);
    });
    nav.appendChild(head);
    if (!open) continue;
    for (const d of s.docs) {
      const b = navButton(d.title, active === d.file, true);
      if (d.date) {
        const dt = document.createElement('span');
        dt.textContent = fmtDate(d.date).slice(0, 5);
        dt.style.cssText = `color:${C.muted};font-size:11px`;
        b.appendChild(dt);
      }
      b.title = d.about ?? d.title;
      b.addEventListener('click', () => select(d.file, host, opts));
      nav.appendChild(b);
    }
  }
  return nav;
}

function buildPage(host: HTMLElement, opts: DocsOpts): HTMLElement {
  const page = document.createElement('div');
  page.style.cssText = 'flex:1;min-width:0;min-height:0;display:flex;flex-direction:column';
  const seq = ++renderSeq;

  if (active.startsWith('section:')) {
    page.appendChild(sectionPage(SECTIONS.find((s) => `section:${s.id}` === active)!, host, opts));
    return page;
  }
  const doc = ALL_DOCS.find((d) => d.file === active)!;
  if (doc.library) page.appendChild(docHeader(doc, host, opts));

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
  page.appendChild(body);

  const show = (text: string): void => {
    if (seq !== renderSeq) return; // пока грузилось, открыли другой документ
    body.innerHTML = '';
    if (doc.kind === 'html') {
      const f = htmlFrame(text);
      frameLink = { frame: f, host, opts };
      body.appendChild(f);
    }
    else body.appendChild(markdownView(text, host, opts));
  };
  if (!doc.library) { show(MD[doc.file] ?? ''); return page; }
  const load = LIB[doc.file];
  if (!load) { show(`# ${doc.title}\n\nФайл \`docs/${doc.file}\` не найден.`); return page; }
  const wait = document.createElement('div');
  wait.textContent = 'Загрузка…';
  wait.style.cssText = `color:${C.muted};padding:20px`;
  body.appendChild(wait);
  load().then(show, (e: unknown) => { if (seq === renderSeq) wait.textContent = `Не загрузился: ${String(e)}`; });
  return page;
}

/** Полоса над документом библиотеки: что это за снимок, откуда, и переключатель темы у HTML. */
function docHeader(doc: DocEntry, host: HTMLElement, opts: DocsOpts): HTMLElement {
  const bar = document.createElement('div');
  bar.style.cssText = `display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;padding:0 4px 10px;border-bottom:1px solid ${C.border};margin-bottom:10px;font-size:12.5px;color:${C.muted}`;
  const sec = sectionOf(doc.file);
  // Назад — только из раздела с несколькими документами: у одиночного его страница пустее самого документа.
  if (sec && sec.docs.length > 1) {
    const back = document.createElement('a');
    back.href = '#';
    back.textContent = `← ${sec.title}`;
    back.style.color = C.accent;
    back.addEventListener('click', (e) => { e.preventDefault(); select(`section:${sec.id}`, host, opts); });
    bar.appendChild(back);
  }
  const t = document.createElement('strong');
  t.textContent = doc.title;
  t.style.cssText = `color:${C.text};font-size:14px`;
  bar.appendChild(t);
  if (doc.date) bar.append(`снимок от ${fmtDate(doc.date)}`);
  if (doc.source) {
    const a = document.createElement('a');
    a.href = doc.source;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'оригинал ↗';
    a.style.color = C.accent;
    a.title = 'Живая версия документа: могла уйти вперёд от снимка';
    bar.appendChild(a);
  }
  if (doc.kind === 'html') {
    const tg = document.createElement('button');
    const label = (): string => (theme === 'dark' ? '☀ светлая' : '☾ тёмная');
    tg.textContent = label();
    tg.title = 'Тема документа';
    tg.style.cssText = `margin-left:auto;padding:3px 10px;border-radius:6px;border:1px solid ${C.border};background:${C.navBg};color:${C.text};cursor:pointer;font-size:12px`;
    tg.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      lsSet(LS.theme, theme);
      tg.textContent = label();
      // Тема меняется В ОТКРЫТОЙ рамке сообщением — без пересоздания: прокрутка и фильтры страницы целы.
      const f = frameLink?.frame;
      if (f?.isConnected) {
        f.style.background = FRAME_BG[theme];
        f.contentWindow?.postMessage({ [DOC_THEME_MSG]: theme }, '*');
      }
    });
    bar.appendChild(tg);
  }
  // У раздела из одного документа нет своей страницы в навигации — его пояснение показываем здесь.
  if (sec && sec.docs.length === 1 && sec.about) {
    const about = document.createElement('div');
    about.textContent = sec.about;
    about.style.cssText = `flex-basis:100%;color:${C.muted};font-size:12.5px;line-height:1.45`;
    bar.appendChild(about);
  }
  return bar;
}

const FRAME_BG = { dark: '#14130f', light: '#fff' } as const;

/** HTML-снимок в рамке. Песочница без `allow-same-origin`: скрипты страницы работают, до редактора не дотянутся. */
function htmlFrame(raw: string): HTMLIFrameElement {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  f.setAttribute('allow', 'clipboard-write');
  f.style.cssText = `flex:1;min-height:0;width:100%;border:1px solid ${C.border};border-radius:8px;background:${FRAME_BG[theme]}`;
  f.srcdoc = prepareHtml(raw, theme);
  return f;
}

function markdownView(text: string, host: HTMLElement, opts: DocsOpts): HTMLElement {
  const page = document.createElement('div');
  page.className = 'doc-body';
  page.style.cssText = 'flex:1;min-width:0;min-height:0;overflow-y:auto;padding:0 20px 40px;line-height:1.55';
  page.innerHTML = marked.parse(text) as string;

  // Якоря заголовков: `[…](#слаг)` листает внутри справки, а не меняет адрес редактора.
  page.querySelectorAll<HTMLElement>('h1,h2,h3,h4').forEach((h) => { if (!h.id) h.id = slugify(h.textContent ?? ''); });
  page.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href')!;
    if (href.startsWith('#')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        (page.querySelector(`[id="${CSS.escape(id)}"]`) ?? page.querySelector(`[id="${CSS.escape(slugify(id))}"]`))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } else if (href.startsWith('config:')) {
      // marked кодирует кириллицу в href (`config:balance/%D0%A3…`) — без раскодирования группа не находилась.
      const [key, group] = href.slice('config:'.length).split('/').map(decodePart);
      a.setAttribute('href', '#');
      a.addEventListener('click', (e) => { e.preventDefault(); opts.gotoConfig(key!, group); });
    } else if (href.startsWith('doc:')) {
      const target = decodePart(href.slice('doc:'.length));
      a.setAttribute('href', '#');
      a.addEventListener('click', (e) => { e.preventDefault(); select(target, host, opts); });
    } else if (/^https?:/i.test(href)) {
      a.addEventListener('click', (e) => { e.preventDefault(); followLink(a.href, host, opts); });
    }
  });
  return page;
}

function decodePart(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Страница раздела: о чём раздел и карточки его документов. */
function sectionPage(s: SectionEntry, host: HTMLElement, opts: DocsOpts): HTMLElement {
  const page = document.createElement('div');
  page.className = 'doc-body';
  page.style.cssText = 'flex:1;min-width:0;min-height:0;overflow-y:auto;padding:0 20px 40px;line-height:1.55';
  const h = document.createElement('h1');
  h.textContent = s.title;
  page.appendChild(h);
  if (s.about) {
    const p = document.createElement('p');
    p.textContent = s.about;
    page.appendChild(p);
  }
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:14px;max-width:860px';
  for (const d of s.docs) {
    const card = document.createElement('button');
    card.style.cssText = `text-align:left;cursor:pointer;padding:12px 16px;border-radius:8px;border:1px solid ${C.border};background:${C.navBg};color:${C.text};display:flex;flex-direction:column;gap:4px`;
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap';
    const t = document.createElement('strong');
    t.textContent = d.title;
    t.style.fontSize = '14.5px';
    const kind = document.createElement('span');
    kind.textContent = d.library ? 'документ' : 'справка механики';
    kind.style.cssText = `font-size:11px;color:${d.library ? '#e8c98a' : C.accent};border:1px solid ${C.border};border-radius:4px;padding:0 6px`;
    top.append(t, kind);
    if (d.date) {
      const dt = document.createElement('span');
      dt.textContent = fmtDate(d.date);
      dt.style.cssText = `font-size:12px;color:${C.muted};margin-left:auto`;
      top.appendChild(dt);
    }
    card.appendChild(top);
    if (d.about) {
      const a = document.createElement('div');
      a.textContent = d.about;
      a.style.cssText = `font-size:13px;color:${C.muted};line-height:1.45`;
      card.appendChild(a);
    }
    card.addEventListener('click', () => select(d.file, host, opts));
    list.appendChild(card);
  }
  page.appendChild(list);
  return page;
}
