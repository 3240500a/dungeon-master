import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCatalog, catalogProblems, findByUrl, migrateActive, normUrl, prepareHtml, slugify, stripFrameRuntime,
  titleFromMarkdown, type CatalogSection,
} from './docsCatalog.js';

const DOCS = join(__dirname, '..', 'docs');
const CATALOG = JSON.parse(readFileSync(join(DOCS, 'sections.json'), 'utf8')) as CatalogSection[];
const FILES = [
  ...readdirSync(DOCS).filter((f) => /\.(md|html?)$/i.test(f)),
  ...readdirSync(join(DOCS, 'library')).map((f) => `library/${f}`),
];
const read = (f: string): string => readFileSync(join(DOCS, f), 'utf8');

/**
 * Сторож вкладки «Документация»: файл, положенный в docs/ без строки в каталоге, вкладка молча не
 * покажет — а строка каталога без файла откроет пустой документ. Оба случая краснеют здесь.
 */
describe('каталог документации = файлы на диске', () => {
  it('каждый файл docs/ стоит ровно в одном разделе, и каждая строка каталога указывает на файл', () => {
    expect(catalogProblems(CATALOG, FILES)).toEqual([]);
  });

  it('у каждого снимка библиотеки есть заголовок, дата и оригинал; у справки — свой H1', () => {
    for (const s of buildCatalog(CATALOG, (f) => (f.startsWith('library/') ? undefined : read(f)))) {
      for (const d of s.docs) expect(d.title, d.file).not.toBe(d.file);
    }
  });

  it('в снимках нет служебного блока хостинга артефактов (он только шумит вне claude.ai)', () => {
    for (const f of FILES.filter((x) => x.startsWith('library/') && x.endsWith('.html'))) {
      expect(read(f), f).not.toMatch(/frame-runtime/);
    }
  });

  it('якоря внутри markdown-снимков ведут на существующие заголовки', () => {
    for (const f of FILES.filter((x) => x.startsWith('library/') && x.endsWith('.md'))) {
      const text = read(f);
      const ids = new Set([...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => slugify(m[1]!)));
      for (const m of text.matchAll(/\]\(#([^)]+)\)/g)) expect(ids.has(decodeURIComponent(m[1]!)), `${f}: #${m[1]}`).toBe(true);
    }
  });

  it('ссылки из одного документа на другой находят его по оригиналу, в любом написании адреса', () => {
    const sections = buildCatalog(CATALOG, () => '# x');
    for (const d of sections.flatMap((s) => s.docs).filter((x) => x.library)) {
      expect(findByUrl(sections, d.source!)?.file).toBe(d.file);
      for (const a of d.aliases) expect(findByUrl(sections, `${a}/?x=1#y`)?.file).toBe(d.file);
    }
    // Серия о сервере ссылается на части по uuid-адресам — обе обязаны открываться в редакторе.
    for (const f of FILES.filter((x) => x.startsWith('library/'))) {
      for (const m of read(f).matchAll(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g)) {
        expect(findByUrl(sections, m[0]), `${f} → ${m[0]}`).toBeDefined();
      }
    }
  });
});

describe('ядро каталога', () => {
  const cat: CatalogSection[] = [
    { id: 'combat', title: 'Бой', docs: [{ file: '01-combat.md' }] },
    { id: 'craft', title: 'Ковка', docs: [{ file: 'library/a.html', title: 'А', date: '2026-09-20', source: 'https://claude.ai/artifact/AAA' }] },
  ];

  it('заголовок справки — из первого H1, если каталог не задал свой', () => {
    const s = buildCatalog(cat, () => 'текст\n# Бой и урон\n## Детали');
    expect(s[0]!.docs[0]!.title).toBe('Бой и урон');
    expect(s[1]!.docs[0]!.kind).toBe('html');
    expect(s[1]!.docs[0]!.library).toBe(true);
    expect(titleFromMarkdown('без заголовка')).toBeUndefined();
  });

  it('сторож ловит лишний файл, пропавший файл, двойную строку и снимок без даты', () => {
    const bad: CatalogSection[] = [
      { id: 'x', title: 'X', docs: [{ file: 'a.md' }, { file: 'gone.md' }, { file: 'library/b.html', title: 'B', source: 's' }] },
      { id: 'x', title: 'Y', docs: [{ file: 'a.md' }] },
    ];
    const p = catalogProblems(bad, ['a.md', 'library/b.html', 'lost.md']).join('\n');
    expect(p).toMatch(/gone\.md.*нет на диске/);
    expect(p).toMatch(/lost\.md.*ни в одном разделе/);
    expect(p).toMatch(/a\.md.*и в «x», и в «x»/);
    expect(p).toMatch(/раздел «x» повторяется/);
    expect(p).toMatch(/library\/b\.html.*date/);
  });

  it('старое значение «открытой вкладки» (slug) переводится в путь файла', () => {
    const s = buildCatalog(cat, () => '# Бой');
    expect(migrateActive('combat', s)).toBe('01-combat.md');
    expect(migrateActive('01-combat.md', s)).toBe('01-combat.md');
    expect(migrateActive('section:craft', s)).toBe('section:craft');
    expect(migrateActive('нет-такого', s)).toBe('');
  });

  it('адреса сравниваются без схемы, хвостового слэша, запроса и регистра', () => {
    expect(normUrl('https://claude.ai/Artifact/AbC/?q=1#h')).toBe(normUrl('http://www.claude.ai/artifact/abc'));
  });

  it('слаг заголовка: кириллица остаётся, знаки уходят', () => {
    expect(slugify('Сравнение с игрой: что поменять')).toBe('сравнение-с-игрой-что-поменять');
    expect(slugify('  XI–XII, «длинные»  ')).toBe('xixii-длинные');
  });
});

describe('HTML-снимок в рамке', () => {
  const served = '<!doctype html><html><head><!-- frame-runtime --><script>boot()</script><!-- /frame-runtime --><meta charset=utf8></head><body><p>Текст</p></body></html>';

  it('служебный блок хостинга вырезается, содержимое остаётся', () => {
    const out = stripFrameRuntime(served);
    expect(out).not.toMatch(/boot\(\)/);
    expect(out).toMatch(/<p>Текст<\/p>/);
  });

  it('тема ставится атрибутом на <html> и перебивает прежнюю', () => {
    expect(prepareHtml(served, 'dark')).toMatch(/<html data-theme="dark" style="color-scheme:dark">/);
    const again = prepareHtml('<html lang="ru" data-theme="light"><body>x</body></html>', 'dark');
    expect(again).toMatch(/<html data-theme="dark" style="color-scheme:dark" lang="ru">/);
    expect(again).not.toMatch(/data-theme="light"/);
  });

  it('скрипт рамки перехватывает якоря #… (у srcdoc они резолвятся от адреса редактора) и принимает тему сообщением', () => {
    const out = prepareHtml(served, 'dark');
    expect(out).toMatch(/charAt\(0\)==="#"[\s\S]*preventDefault[\s\S]*scrollIntoView/);
    expect(out).toMatch(/e\.source!==parent[\s\S]*dmDocTheme[\s\S]*setAttribute\("data-theme"/);
  });

  it('страница без обёртки получает скелет, а скрипт ссылок встаёт перед </body>', () => {
    const out = prepareHtml('<title>Док</title><p>x</p>', 'light');
    expect(out).toMatch(/^<!doctype html><html data-theme="light"/);
    expect(out).toMatch(/dmDocLink[\s\S]*<\/script><\/body><\/html>$/);
  });
});
