/**
 * Каталог вкладки «Документация» — чистое ядро без DOM (под node-тесты).
 *
 * Документы разложены по РАЗДЕЛАМ механик (`docs/sections.json`). Два рода файлов:
 *  - справки механик — `docs/NN-slug.md` (формат «Что это → Как работает → Рычаги → Где в конфиге»);
 *  - библиотека — `docs/library/*.md|html`: снимки проектных документов, которые мы готовили
 *    артефактами (ГДД, планы, исследования). У снимка в каталоге есть `source` — ссылка на оригинал:
 *    оригинал мог уйти вперёд, а редактор хранит ту версию, что забрали в репозиторий.
 *
 * ⚠ Справки остаются на старых путях намеренно: на `editor/docs/NN-*.md` ссылаются README, MODULE_MAP
 * и память проекта — переезд в папки порвал бы эти ссылки ради одной только косметики.
 */

export interface CatalogDoc {
  /** Путь внутри `docs/`: `01-combat.md` или `library/kovka-oruzhiya.html`. */
  file: string;
  /** Заголовок. У справки по умолчанию берётся из первого `# H1`; у библиотеки обязателен (грузится лениво). */
  title?: string;
  /** Дата снимка, `YYYY-MM-DD`. */
  date?: string;
  /** Откуда снят: ссылка на оригинал. */
  source?: string;
  /** Другие адреса того же оригинала (у артефакта их два: короткий и с uuid) — по ним ссылка из другого документа открывается здесь же. */
  aliases?: string[];
  /** Одна-две фразы: о чём документ и что в нём решено. */
  about?: string;
}

export interface CatalogSection {
  id: string;
  title: string;
  about?: string;
  docs: CatalogDoc[];
}

export type DocKind = 'md' | 'html';

export interface DocEntry {
  file: string;
  kind: DocKind;
  title: string;
  date?: string;
  source?: string;
  aliases: string[];
  about?: string;
  sectionId: string;
  /** Файл из `library/` — снимок документа, а не справка механики. */
  library: boolean;
}

export interface SectionEntry {
  id: string;
  title: string;
  about?: string;
  docs: DocEntry[];
}

export function kindOf(file: string): DocKind {
  return /\.html?$/i.test(file) ? 'html' : 'md';
}

/** Первый `# H1` markdown-текста. */
export function titleFromMarkdown(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1]!.trim() : undefined;
}

/** Собрать разделы: порядок — как в каталоге; заголовок справки — из её H1, если каталог не задал свой. */
export function buildCatalog(sections: CatalogSection[], mdBody: (file: string) => string | undefined): SectionEntry[] {
  return sections.map((s) => ({
    id: s.id,
    title: s.title,
    about: s.about,
    docs: s.docs.map((d) => {
      const kind = kindOf(d.file);
      const body = kind === 'md' ? mdBody(d.file) : undefined;
      const title = d.title ?? (body !== undefined ? titleFromMarkdown(body) : undefined) ?? d.file;
      return {
        file: d.file, kind, title, date: d.date, source: d.source, aliases: d.aliases ?? [], about: d.about,
        sectionId: s.id, library: d.file.startsWith('library/'),
      };
    }),
  }));
}

/**
 * Что в каталоге не так — для сторожа. `files` — все файлы `docs/` относительными путями
 * (`01-combat.md`, `library/x.html`), кроме самого каталога.
 */
export function catalogProblems(sections: CatalogSection[], files: string[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const seen = new Map<string, string>();
  const onDisk = new Set(files);
  for (const s of sections) {
    if (!s.id || !s.title) out.push(`раздел без id или заголовка: ${JSON.stringify(s)}`);
    if (ids.has(s.id)) out.push(`раздел «${s.id}» повторяется`);
    ids.add(s.id);
    if (!s.docs.length) out.push(`раздел «${s.id}» пуст`);
    for (const d of s.docs) {
      const prev = seen.get(d.file);
      if (prev) out.push(`«${d.file}» стоит и в «${prev}», и в «${s.id}»`);
      seen.set(d.file, s.id);
      if (!onDisk.has(d.file)) out.push(`«${d.file}» есть в каталоге, но нет на диске`);
      if (d.file.startsWith('library/')) {
        if (!d.title) out.push(`«${d.file}»: у документа библиотеки нет title`);
        if (!d.date || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) out.push(`«${d.file}»: date не в формате YYYY-MM-DD`);
        if (!d.source) out.push(`«${d.file}»: нет source — ссылки на оригинал`);
      }
    }
  }
  for (const f of files) {
    if (!/\.(md|html?)$/i.test(f)) continue;
    if (!seen.has(f)) out.push(`«${f}» лежит в docs/, но ни в одном разделе — вкладка его не покажет`);
  }
  return out;
}

/** Адрес оригинала без хвостов: схема, `www.`, запрос, якорь и завершающий слэш не различают документы. */
export function normUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

/** Документ каталога, чей оригинал лежит по этому адресу (source или aliases), — чтобы ссылка открывалась в редакторе. */
export function findByUrl(sections: SectionEntry[], url: string): DocEntry | undefined {
  const u = normUrl(url);
  return sections.flatMap((s) => s.docs).find((d) => [d.source, ...d.aliases].some((x) => x !== undefined && normUrl(x) === u));
}

/** Раньше вкладка помнила slug справки (`combat`), теперь — путь файла. Перевести старое значение. */
export function migrateActive(saved: string, sections: SectionEntry[]): string {
  if (!saved) return '';
  const all = sections.flatMap((s) => s.docs);
  if (saved.startsWith('section:') ? sections.some((s) => `section:${s.id}` === saved) : all.some((d) => d.file === saved)) return saved;
  const legacy = all.find((d) => !d.library && d.file.replace(/^\d+[-_]/, '').replace(/\.md$/, '') === saved);
  return legacy?.file ?? '';
}

/** id заголовка для якорей внутри справки: «Сравнение с игрой: что поменять» → `сравнение-с-игрой-что-поменять`. */
export function slugify(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const FRAME_RUNTIME = /<!--\s*frame-runtime\s*-->[\s\S]*?<!--\s*\/frame-runtime\s*-->/g;

/** Убрать служебный блок хостинга артефактов: вне claude.ai он только шумит в консоль. */
export function stripFrameRuntime(html: string): string {
  return html.replace(FRAME_RUNTIME, '');
}

/**
 * Скрипт, который редактор дописывает в рамку.
 *
 * Ссылки. ⚠ Якорь `#…` сам по себе НЕ листает: у `srcdoc` адрес `about:srcdoc`, а относительные
 * ссылки разрешаются от адреса РОДИТЕЛЯ — клик по «#udar» грузил в рамку сам редактор
 * (`localhost:5174/#udar`), и документ пропадал. Поэтому якорь перехватывается и листается руками.
 * Внешняя ссылка не открывается ВНУТРИ рамки: её адрес уходит редактору сообщением `{dmDocLink}`,
 * и тот открывает у себя документ с этим оригиналом (серии ссылаются друг на друга) или новую вкладку.
 *
 * Тема. Сообщение `{dmDocTheme}` от редактора меняет `data-theme` на месте: пересоздать рамку значило
 * бы потерять прокрутку и состояние страницы (фильтры каталога деталей).
 */
export const DOC_LINK_MSG = 'dmDocLink';
export const DOC_THEME_MSG = 'dmDocTheme';
const LINK_SCRIPT = '<script>(function(){'
  + 'document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";'
  + 'if(h.charAt(0)==="#"){e.preventDefault();var id=h.slice(1);try{id=decodeURIComponent(id);}catch(_){}var el=id?document.getElementById(id):null;if(el)el.scrollIntoView({behavior:"smooth",block:"start"});else if(!id)window.scrollTo({top:0,behavior:"smooth"});return;}'
  + 'if(/^https?:/i.test(h)){e.preventDefault();try{parent.postMessage({' + DOC_LINK_MSG + ':a.href},"*");}catch(_){window.open(a.href,"_blank","noopener");}}},true);'
  + 'addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data,th=d&&d.' + DOC_THEME_MSG + ';if(th!=="dark"&&th!=="light")return;var r=document.documentElement;r.setAttribute("data-theme",th);r.style.colorScheme=th;});'
  + '})();</script>';

const SKELETON_HEAD = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<style>body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>';

/**
 * HTML-снимок → `srcdoc` рамки. Тема ставится атрибутом `data-theme` на `<html>`: так её понимают
 * все наши страницы (токены под `:root[data-theme="dark"]`), и выбор редактора перебивает системный.
 * Страница без обёртки (исходник, а не отданная хостингом) получает минимальный скелет.
 */
export function prepareHtml(raw: string, theme: 'dark' | 'light'): string {
  let html = stripFrameRuntime(raw);
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html><head>${SKELETON_HEAD}</head><body>${html}</body></html>`;
  html = html.replace(/<html(\s[^>]*)?>/i, (_m, attrs: string | undefined) => {
    const rest = (attrs ?? '').replace(/\sdata-theme="[^"]*"/i, '');
    return `<html data-theme="${theme}" style="color-scheme:${theme}"${rest}>`;
  });
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${LINK_SCRIPT}</body>`) : html + LINK_SCRIPT;
}

/** «2026-09-24» → «24.09.2026». */
export function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
