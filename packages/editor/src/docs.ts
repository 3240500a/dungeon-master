/**
 * Секция «Документация» редактора: вкладки-описания основных механик (что это / как работает /
 * ключевые рычаги / где в конфиге настраивается). Контент — markdown-файлы в `packages/editor/docs/*.md`,
 * втянутые через Vite raw-glob (без серверного эндпоинта, работает в dev и в сборке). Рендер — `marked`.
 *
 * Deep-link на конфиг: в тексте markdown ссылка вида `[текст](config:balance)` или
 * `[текст](config:balance/Урон)` (после `/` — подветка balance) → после рендера навешиваем клик,
 * который переводит редактор в секцию «Игра» на нужную конфиг-страницу (см. `gotoConfig` в main.ts).
 */
import { marked } from 'marked';

// Vite втягивает содержимое всех доков как строки на этапе сборки (eager). Ключ — путь файла.
const RAW = import.meta.glob('../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

interface Doc { slug: string; order: number; title: string; body: string }

/** Разобрать имя файла `NN-slug.md` → {order, slug}; заголовок = первый H1 (`# …`); тело — markdown как есть. */
function parseDocs(): Doc[] {
  const docs: Doc[] = [];
  for (const [path, body] of Object.entries(RAW)) {
    const file = path.split('/').pop() ?? path;                 // `01-combat.md`
    const base = file.replace(/\.md$/, '');
    const m = /^(\d+)[-_](.+)$/.exec(base);
    const order = m ? parseInt(m[1]!, 10) : 999;
    const slug = m ? m[2]! : base;
    const h1 = /^#\s+(.+)$/m.exec(body);
    const title = h1 ? h1[1]!.trim() : slug;
    docs.push({ slug, order, title, body });
  }
  return docs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

const DOCS = parseDocs();

marked.setOptions({ gfm: true, breaks: false });

let activeSlug: string = (() => { try { return localStorage.getItem('editor_doc') ?? ''; } catch { return ''; } })();

/** Отрисовать секцию документации: слева суб-навигация механик, справа — отрендеренный markdown. */
export function renderDocs(host: HTMLElement, opts: { gotoConfig: (key: string, group?: string) => void }): void {
  host.innerHTML = '';
  if (!DOCS.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9a9ab0;padding:20px';
    empty.textContent = 'Документов пока нет. Добавь markdown-файлы в packages/editor/docs/ (напр. 01-combat.md).';
    host.appendChild(empty);
    return;
  }
  if (!DOCS.some((d) => d.slug === activeSlug)) activeSlug = DOCS[0]!.slug;

  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;gap:16px;flex:1;min-height:0';

  // Левая суб-навигация: список механик.
  const nav = document.createElement('div');
  nav.style.cssText = 'flex:0 0 220px;display:flex;flex-direction:column;gap:4px;min-height:0;overflow-y:auto;padding-right:4px';
  for (const d of DOCS) {
    const b = document.createElement('button');
    b.textContent = d.title;
    const active = d.slug === activeSlug;
    b.style.cssText = `text-align:left;padding:8px 12px;cursor:pointer;border-radius:6px;border:1px solid #2c2c3a;background:${active ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;font-size:13px`;
    b.addEventListener('click', () => { activeSlug = d.slug; try { localStorage.setItem('editor_doc', d.slug); } catch { /* */ } renderDocs(host, opts); });
    nav.appendChild(b);
  }

  // Правая панель: отрендеренный markdown активного дока.
  const page = document.createElement('div');
  page.className = 'doc-body';
  page.style.cssText = 'flex:1;min-width:0;min-height:0;overflow-y:auto;padding:0 20px 40px;line-height:1.55';
  const doc = DOCS.find((d) => d.slug === activeSlug)!;
  page.innerHTML = marked.parse(doc.body) as string;

  // Deep-link на конфиг: перехватываем ссылки `config:<key>[/<group>]`.
  page.querySelectorAll<HTMLAnchorElement>('a[href^="config:"]').forEach((a) => {
    const spec = a.getAttribute('href')!.slice('config:'.length);
    const [key, group] = spec.split('/');
    a.setAttribute('href', '#');
    a.style.color = '#8fb7ff';
    a.addEventListener('click', (e) => { e.preventDefault(); opts.gotoConfig(key!, group); });
  });

  layout.append(nav, page);
  host.appendChild(layout);
}
