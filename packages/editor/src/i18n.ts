import {
  ConfigRegistry, Localizer, SOURCE_LANG, composeItemName, localeCoverage, localeLangs,
  localesSchema, pickForm, walkConfigText,
  type ConfigText, type FormSet, type Lang, type Locales, type NameFragment, type NameShape,
} from '@dm/shared';
import type { CraftIo } from './craft.js';

/**
 * ⭐⭐ ВКЛАДКА «🌐 ЯЗЫКИ» — требование владельца 27.10 дословно: «когда мы будем создавать монстра его
 * имя должно сразу делаться в вариантах языков какие у нас будут», «чтобы не было расхождений никаких».
 *
 * Отсюда три вещи на одной странице, и ни одной «на потом»:
 *
 *  1. **ИМЯ СРАЗУ НА ВСЕХ ЯЗЫКАХ.** Предпросмотр собирает имя ТЕМ ЖЕ `composeItemName`, что игра и
 *     сервер, по одному разрешителю на язык. Поэтому «как будет называться» — это не макет и не
 *     обещание: это буквально то, что увидит игрок, включая порядок слов и согласование.
 *  2. **ТАБЛИЦА ПЕРЕВОДОВ С КОЛОНКОЙ НА ЯЗЫК.** Корпус набирается тем же `walkConfigText`, что и
 *     извлекатель (`npm run i18n`), так что страница не может показать «не те» строки.
 *  3. **ФОРМЫ У СОГЛАСУЕМЫХ ФРАГМЕНТОВ.** У прилагательного ступени или аффикса — четыре поля вместо
 *     одного (род и число), и это ЕДИНСТВЕННЫЙ способ получить «Кровавая секира» вместо «Кровавый
 *     секира» на языке, про который в коде ничего не знают.
 *
 * ⚠ ПОЧЕМУ НЕ АВТО-ФОРМА ПО СХЕМЕ. `locales` — это запись «язык → { грамматика, шаблоны, строки }», и
 * авто-форма показала бы её как вложенный словарь из 3 898 ключей без всякой связи с содержимым игры:
 * правя имя секиры, не видно ни самой секиры, ни того, что получится. А увидеть надо именно результат.
 *
 * ⚠ ПРАВКИ ИДУТ В РАБОЧУЮ КОПИЮ (`data`), как на всех страницах-инструментах: «Применить» на общей
 * шапке отправляет их на сервер одним ключом `locales`.
 */

const CSS = {
  card: 'border:1px solid #2c2c3a;border-radius:8px;padding:12px 14px;background:#15151d;margin-bottom:12px',
  h: 'font-size:14px;font-weight:600;color:#e8e8f0;margin:0 0 2px',
  sub: 'font-size:11px;color:#8a8a9a;margin:0 0 10px;line-height:1.45',
  th: 'padding:4px 8px;text-align:left;color:#8a8a9a;font-weight:500;font-size:11px;white-space:nowrap;border-bottom:1px solid #2c2c3a',
  td: 'padding:3px 8px;font-size:12px;vertical-align:top',
  src: 'padding:3px 8px;font-size:12px;color:#cfd0da;max-width:280px',
  key: 'padding:3px 8px;font-size:10px;color:#5f5f78;font-family:ui-monospace,monospace;white-space:nowrap',
  inp: 'width:100%;min-width:120px;background:#0e0e14;border:1px solid #2c2c3a;border-radius:4px;color:#e8e8f0;padding:3px 6px;font-size:12px',
  frm: 'width:100%;background:#0e0e14;border:1px solid #33334a;border-radius:4px;color:#e8e8f0;padding:2px 5px;font-size:11px',
  sel: 'background:#0e0e14;border:1px solid #2c2c3a;border-radius:4px;color:#e8e8f0;padding:4px 8px;font-size:12px',
  pill: 'display:inline-block;border:1px solid #2c2c3a;border-radius:10px;padding:2px 8px;font-size:11px;color:#9fb0c0;background:#101018;margin-right:6px',
  name: 'font-size:15px;color:#e8e8f0;font-weight:600',
  warn: 'border:1px solid #6a4a20;border-radius:6px;padding:8px 10px;background:#241c10;color:#e0b070;font-size:12px;margin-bottom:8px',
};

const el = (tag: string, css = '', text = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
};

/** Признаки, по которым правятся формы согласуемого фрагмента. Русскому хватает рода и числа. */
const FORM_KEYS: ReadonlyArray<[string, string]> = [
  ['m', 'муж.'], ['f', 'жен.'], ['n', 'ср.'], ['pl', 'мн.'],
];

/**
 * ПОЛЯ, ЧЕЙ ТЕКСТ СОГЛАСУЕТСЯ С ГОЛОВОЙ ИМЕНИ, — им нужны формы, а не одна строка.
 * `name` ступени — прилагательное («Кровавый»), `word` аффикса-префикса и `adj` детали — тоже.
 * Всё остальное (голова, родительный падеж суффикса, эпитет, описание) — одна строка.
 */
const AGREEING_FIELDS: ReadonlySet<string> = new Set(['adj']);
const AGREEING_TABLES: ReadonlySet<string> = new Set(['item-tiers']);
const isAgreeing = (row: ConfigText): boolean =>
  AGREEING_FIELDS.has(row.field)
  || (AGREEING_TABLES.has(row.table) && row.field === 'name')
  || (row.field === 'word' && /(ый|ий|ой)$/.test(row.source));

/** Состояние страницы (переживает перерисовку). */
let tab: 'preview' | 'strings' = 'preview';
let lang: Lang = 'en';
let table: string = 'items-base';
let filter = '';
let previewBaseId = '';
let previewTierId = '';
let previewShape: NameShape = 'tiered';
let previewAffixPre = '';
let previewAffixSuf = '';

/** Живая таблица языков рабочей копии: правим ЕЁ, а не копию — страница и игра смотрят в один объект. */
function localesOf(data: Record<string, unknown>): Locales {
  const raw = data.locales;
  const parsed = localesSchema.safeParse(raw ?? {});
  // ⚠ Разбор через схему, а не доверие полю: страница обязана работать и на сейве старше таблицы языков.
  const live = (parsed.success ? parsed.data : {}) as Locales;
  if (!parsed.success || raw === undefined) data.locales = live;
  else Object.assign(raw as object, live);
  return (data.locales ?? live) as Locales;
}

function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data, { cross: false });
  return reg;
}

/** Строки языка; создаёт карту, если её ещё нет (переводить начинают с пустого). */
function stringsOf(locales: Locales, l: Lang): Record<string, FormSet> {
  const pack = locales[l];
  if (!pack) return {};
  if (!pack.strings) pack.strings = {};
  return pack.strings as Record<string, FormSet>;
}

// ── Предпросмотр имени на всех языках ────────────────────────────────────────────────────────────

const frag = (key: string, source: string): NameFragment => ({ key, source });

/**
 * ⭐⭐ ОДНО ИМЯ, ВСЕ ЯЗЫКИ. Собирается `composeItemName` — тем же швом, что у игры и сервера. Если бы
 * здесь стояла своя склейка, страница стала бы вторым источником правды и разошлась бы с игрой ровно
 * в тот момент, когда по ней что-нибудь решают (память проекта: «редактор и игра видят одно и то же»).
 */
function renderPreview(host: HTMLElement, data: Record<string, unknown>, redraw: () => void): void {
  const locales = localesOf(data);
  const reg = regFromData(data);
  const bases = reg.get('items.base');
  const tiers = reg.get('item-tiers');
  const affixes = reg.get('affixes');
  const rare = reg.get('rare-names');
  const langs = localeLangs(locales);

  if (!bases.some((b) => b.id === previewBaseId)) previewBaseId = bases[0]?.id ?? '';
  if (!tiers.some((t) => t.id === previewTierId)) previewTierId = tiers[Math.min(3, tiers.length - 1)]?.id ?? '';
  const pre = affixes.filter((a) => a.kind === 'prefix' && a.word);
  const suf = affixes.filter((a) => a.kind === 'suffix' && a.word);
  if (!pre.some((a) => a.id === previewAffixPre)) previewAffixPre = pre[0]?.id ?? '';
  if (!suf.some((a) => a.id === previewAffixSuf)) previewAffixSuf = suf[0]?.id ?? '';

  const card = el('div', CSS.card);
  card.append(
    el('div', CSS.h, '🌐 Имя сразу на всех языках'),
    el('div', CSS.sub,
      'Выберите вещь — и увидите её имя на каждом языке таблицы. Имя собирается ТЕМ ЖЕ кодом, что в игре '
      + 'и на сервере, по шаблону каждого языка: порядок слов, связки и согласование — из данных языка, '
      + 'а не из кода. Поэтому строка ниже — это буквально то, что увидит игрок.'),
  );

  // ── выбор вещи ──
  const pick = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px');
  const sel = (opts: Array<[string, string]>, value: string, on: (v: string) => void): HTMLElement => {
    const s = document.createElement('select');
    s.style.cssText = CSS.sel;
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t; o.selected = v === value;
      s.appendChild(o);
    }
    s.addEventListener('change', () => { on(s.value); redraw(); });
    return s;
  };
  pick.append(
    el('span', CSS.pill, 'форма имени'),
    sel([['tiered', 'ступень + база'], ['magic', 'магия (D2)'], ['titled', 'титул'], ['rare', 'рар']],
      previewShape, (v) => { previewShape = v as NameShape; }),
    el('span', CSS.pill, 'база'),
    sel(bases.map((b) => [b.id, `${b.name} (${b.gender ?? 'm'})`]), previewBaseId, (v) => { previewBaseId = v; }),
  );
  if (previewShape === 'tiered') {
    pick.append(el('span', CSS.pill, 'ступень'),
      sel(tiers.map((t) => [t.id, t.name ?? t.id]), previewTierId, (v) => { previewTierId = v; }));
  }
  if (previewShape === 'magic') {
    pick.append(
      el('span', CSS.pill, 'префикс'), sel(pre.map((a) => [a.id, a.word!]), previewAffixPre, (v) => { previewAffixPre = v; }),
      el('span', CSS.pill, 'суффикс'), sel(suf.map((a) => [a.id, a.word!]), previewAffixSuf, (v) => { previewAffixSuf = v; }),
    );
  }
  card.appendChild(pick);

  const base = bases.find((b) => b.id === previewBaseId);
  if (!base) { card.appendChild(el('div', CSS.warn, 'В конфиге нет ни одной базы предметов.')); host.appendChild(card); return; }
  const tier = tiers.find((t) => t.id === previewTierId);
  const p = pre.find((a) => a.id === previewAffixPre);
  const s = suf.find((a) => a.id === previewAffixSuf);
  const noun = rare.nouns[0], ep = rare.epithets[0];

  const spec = {
    shape: previewShape,
    base: frag(`cfg:items-base/${base.id}/name`, base.name),
    agreement: base.gender,
    tier: previewShape === 'tiered' && tier?.name ? frag(`cfg:item-tiers/${tier.id}/name`, tier.name) : undefined,
    prefix: previewShape === 'magic' && p?.word ? frag(`cfg:affixes/${p.id}/word`, p.word) : undefined,
    suffix: previewShape === 'magic' && s?.word ? frag(`cfg:affixes/${s.id}/word`, s.word) : undefined,
    title: previewShape === 'titled' && ep ? frag(`cfg:rare-names/epithets/${ep.id}/t`, ep.t) : undefined,
    noun: previewShape === 'rare' && noun ? frag(`cfg:rare-names/nouns/${noun.id}/t`, noun.t) : undefined,
    epithet: previewShape === 'rare' && ep ? frag(`cfg:rare-names/epithets/${ep.id}/t`, ep.t) : undefined,
  };

  const tbl = document.createElement('table');
  tbl.style.cssText = 'border-collapse:collapse;width:100%';
  const hr = document.createElement('tr');
  for (const h of ['язык', 'имя', 'шаблон', 'склейка', 'согласование']) hr.appendChild(el('th', CSS.th, h));
  tbl.appendChild(hr);
  for (const l of langs) {
    const loc = new Localizer(locales, l);
    const g = loc.grammar();
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid #1e1e28';
    tr.append(
      el('td', CSS.td, `${locales[l]?.name ?? l}  ·  ${l}`),
      el('td', `${CSS.td};${CSS.name}`, composeItemName(loc, spec)),
      el('td', `${CSS.key}`, loc.template(`item.${previewShape}`)),
      el('td', CSS.td, g.join === '' ? 'без пробелов' : `«${g.join}»`),
      el('td', CSS.td, g.agrees ? (loc.agreementOf(spec.base.key, base.gender) ?? '—') : 'нет'),
    );
    tbl.appendChild(tr);
  }
  card.appendChild(tbl);
  card.appendChild(el('div', CSS.sub,
    '⚠ Имя всегда в ИМЕНИТЕЛЬНОМ падеже: ни одно игроцкое предложение не вставляет имя вещи внутрь себя, '
    + 'поэтому падежи в таблице форм не заводим — это ×6 работы переводчику без единого видимого следствия. '
    + 'Так же сделано в Grim Dawn.'));
  host.appendChild(card);
}

// ── Таблица строк ────────────────────────────────────────────────────────────────────────────────

function renderStrings(host: HTMLElement, data: Record<string, unknown>, redraw: () => void): void {
  const locales = localesOf(data);
  const langs = localeLangs(locales).filter((l) => l !== SOURCE_LANG);
  if (!langs.includes(lang)) lang = langs[0] ?? SOURCE_LANG;
  const corpus = walkConfigText(data);
  const tables = [...new Set(corpus.map((r) => r.table))].sort();
  if (!tables.includes(table)) table = tables[0] ?? '';
  const strings = stringsOf(locales, lang);

  const card = el('div', CSS.card);
  card.append(el('div', CSS.h, '📝 Строки под перевод'),
    el('div', CSS.sub,
      `Корпус набран тем же обходчиком, что и «npm run i18n», поэтому здесь ровно те строки, которые видит `
      + `игрок: ${corpus.length} на ${tables.length} таблиц. Русский не переводят — он лежит в самих данных `
      + `и служит запасом, если перевода нет.`));

  // ── шапка: язык, покрытие, таблица, поиск ──
  const bar = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px');
  const keys = corpus.map((r) => r.key);
  for (const l of localeLangs(locales)) {
    const cov = Math.round(localeCoverage(locales, l, keys) * 100);
    const b = document.createElement('button');
    b.textContent = `${locales[l]?.name ?? l} · ${cov}%`;
    const on = l === lang;
    b.style.cssText = `cursor:${l === SOURCE_LANG ? 'default' : 'pointer'};border:1px solid #2c2c3a;border-radius:6px;`
      + `padding:4px 10px;font-size:12px;background:${on ? '#3a3a4c' : '#161620'};color:${l === SOURCE_LANG ? '#71718a' : '#cfd0da'}`;
    if (l !== SOURCE_LANG) b.addEventListener('click', () => { lang = l; redraw(); });
    bar.appendChild(b);
  }
  card.appendChild(bar);

  const bar2 = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px');
  const tsel = document.createElement('select');
  tsel.style.cssText = CSS.sel;
  for (const t of tables) {
    const o = document.createElement('option');
    o.value = t; o.selected = t === table;
    o.textContent = `${t} (${corpus.filter((r) => r.table === t).length})`;
    tsel.appendChild(o);
  }
  tsel.addEventListener('change', () => { table = tsel.value; redraw(); });
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'поиск по тексту или ключу…';
  search.value = filter;
  search.style.cssText = `${CSS.inp};max-width:260px`;
  search.addEventListener('input', () => { filter = search.value; });
  search.addEventListener('change', redraw);
  bar2.append(el('span', CSS.pill, 'таблица'), tsel, search);
  card.appendChild(bar2);

  const f = filter.trim().toLowerCase();
  const rows = corpus.filter((r) => r.table === table
    && (!f || r.source.toLowerCase().includes(f) || r.key.toLowerCase().includes(f)));

  const tbl = document.createElement('table');
  tbl.style.cssText = 'border-collapse:collapse;width:100%';
  const hr = document.createElement('tr');
  for (const h of ['поле', 'русский (источник)', `перевод · ${lang}`, 'ключ']) hr.appendChild(el('th', CSS.th, h));
  tbl.appendChild(hr);

  for (const r of rows.slice(0, 400)) {
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid #1e1e28';
    const cell = el('td', CSS.td);
    if (isAgreeing(r)) {
      // ⭐ Согласуемому фрагменту нужны ФОРМЫ: одна строка дала бы «Кровавый секира».
      const box = el('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px');
      const cur = strings[r.key];
      const forms: Record<string, string> = typeof cur === 'string' ? { m: cur } : { ...(cur ?? {}) };
      for (const [fk, label] of FORM_KEYS) {
        const wrap = el('div');
        wrap.appendChild(el('div', 'font-size:9px;color:#5f5f78;padding-left:2px', label));
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = forms[fk] ?? '';
        inp.placeholder = label;
        inp.style.cssText = CSS.frm;
        inp.addEventListener('change', () => {
          const next: Record<string, string> = { ...forms };
          if (inp.value.trim()) next[fk] = inp.value.trim(); else delete next[fk];
          if (Object.keys(next).length) strings[r.key] = next; else delete strings[r.key];
          redraw();
        });
        wrap.appendChild(inp);
        box.appendChild(wrap);
      }
      cell.appendChild(box);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      const cur = strings[r.key];
      inp.value = typeof cur === 'string' ? cur : pickForm(cur);
      inp.style.cssText = CSS.inp;
      inp.addEventListener('change', () => {
        if (inp.value.trim()) strings[r.key] = inp.value.trim(); else delete strings[r.key];
        redraw();
      });
      cell.appendChild(inp);
    }
    tr.append(el('td', CSS.key, r.field), el('td', CSS.src, r.source), cell, el('td', CSS.key, r.key));
    tbl.appendChild(tr);
  }
  card.appendChild(tbl);
  if (rows.length > 400) {
    card.appendChild(el('div', CSS.sub, `Показаны первые 400 из ${rows.length} — сузьте поиском.`));
  }
  host.appendChild(card);
}

// ── Страница ─────────────────────────────────────────────────────────────────────────────────────

export function renderI18nPage(
  host: HTMLElement,
  data: Record<string, unknown>,
  onChange?: () => void,
  io?: CraftIo,
): void {
  host.innerHTML = '';
  const redraw = (): void => { onChange?.(); renderI18nPage(host, data, onChange, io); };
  const locales = localesOf(data);

  const head = el('div', CSS.card);
  head.append(el('div', CSS.h, '🌐 Языки и переводы'),
    el('div', CSS.sub,
      'Один язык — одна запись в таблице `locales`: самоназвание, грамматика (разделитель, согласует ли '
      + 'язык прилагательные), шаблоны порядка слов и строки. Новый язык — ПРАВКА ДАННЫХ, а не кода.'));

  const tabs = el('div', 'display:flex;gap:6px;margin-bottom:10px');
  for (const [id, label] of [['preview', '👁 Имя на всех языках'], ['strings', '📝 Строки']] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    const on = tab === id;
    b.style.cssText = `cursor:pointer;border:1px solid #2c2c3a;border-radius:6px;padding:5px 12px;font-size:12px;`
      + `background:${on ? '#3a3a4c' : '#161620'};color:#e8e8f0;font-weight:${on ? 600 : 400}`;
    b.addEventListener('click', () => { tab = id; redraw(); });
    tabs.appendChild(b);
  }
  head.appendChild(tabs);

  if (io) {
    const act = el('div', 'display:flex;gap:8px;flex-wrap:wrap');
    const mk = (text: string, bg: string, title: string, on: () => void): HTMLElement => {
      const b = document.createElement('button');
      b.textContent = text; b.title = title;
      b.style.cssText = `cursor:pointer;border:1px solid #2c2c3a;border-radius:6px;padding:5px 12px;font-size:12px;background:${bg};color:#e8e8f0`;
      b.addEventListener('click', on);
      return b;
    };
    act.append(
      mk('✔ Применить на сервере', '#2a4a2a', 'Оверрайд в БД: переводы действуют сразу, в файлы не попадут.',
        () => io.push(['locales'])),
      mk('💾 Применить и записать в файл', '#26406a', 'Плюс запись в data/locales.json — попадёт в git и на деплой.',
        () => io.toFile(['locales'])),
    );
    head.appendChild(act);
    head.appendChild(el('div', CSS.sub,
      '⚠ Перевод НЕ входит ни в `revision()`, ни в `gameRevision()`: иначе правка строки закрывала бы кузницу '
      + 'и лавку всем игрокам с «Цена изменилась» и заново резала релиз контента.'));
  }
  host.appendChild(head);

  if (!Object.keys(locales).length) {
    host.appendChild(el('div', CSS.warn, 'В конфиге нет ни одного языка — таблица `locales` пуста.'));
    return;
  }
  if (tab === 'preview') renderPreview(host, data, redraw);
  else renderStrings(host, data, redraw);
}
