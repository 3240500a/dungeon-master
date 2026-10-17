/**
 * ⭐ 16.10 (Артбук): подвкладка «🏛 Локации». Список биомов из конфига (`data.biomes`) → страница биома: описание и девиз из
 * конфига (правятся в «Игра → Мир → Биомы»), заметки художнику и слоты концептов окружения. У крипты — страница «Некрополь»
 * из черновика: сводка решений владельца, вступление, эпохи мира, выбор подтипа при спуске (печать подтипа, слот концепта яруса
 * Некрополя у каждого подтипа — лор), лестница разложения, статусы, подписи подтипов, пачки, читаемость на камере, рычаги движка,
 * составные юниты, вопросы и решения, источники.
 *
 * ⭐ 17.10: решения владельца 16–17.10 — шесть подтипов, подтип выпадает на отрезок до вейпоинта (вместо слоёв по этажам круга),
 * код сейчас не пишем (пометки есть / легко / на будущее), у каждого вопроса — «Решение владельца» (правится кликом).
 *
 * Маршруты: `''` — список, `biome:<id>` — страница биома.
 */
import type { ArtbookCtx } from './ctx.js';
import { SLOT_SETS, slotKey } from './model.js';
import { FACTION_LABEL } from './classNumbers.js';
import { C, btn, chip, el, h2, h3, kv, markColor, muted, section, sourcesList, table, type Cell } from './ui.js';
import { hasField } from './widgets.js';

interface BiomeRow {
  id: string; name: string; enabled?: boolean; desc?: string; tagline?: string; faction?: string; tileset?: string;
  enemies?: string[]; monsterPool?: string[]; dropBias?: number; variants?: { fromDepth: number; tileset?: string }[];
}

const biomesOf = (ctx: ArtbookCtx): BiomeRow[] => (Array.isArray(ctx.data.biomes) ? ctx.data.biomes as BiomeRow[] : []);
const monsterName = (ctx: ArtbookCtx, id: string): string => {
  const m = Array.isArray(ctx.data.monsters) ? (ctx.data.monsters as { id: string; name?: string }[]).find((x) => x.id === id) : undefined;
  return m?.name ?? id;
};

export function renderLocations(host: HTMLElement, ctx: ArtbookCtx): void {
  const id = ctx.route.startsWith('biome:') ? ctx.route.slice(6) : '';
  const b = id ? biomesOf(ctx).find((x) => x.id === id) : undefined;
  if (b) renderBiome(host, ctx, b);
  else renderList(host, ctx);
}

function renderList(host: HTMLElement, ctx: ArtbookCtx): void {
  host.append(h2('Локации'));
  host.append(ctx.list('locations/intro', { paragraphs: true }));
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:10px');
  for (const b of biomesOf(ctx)) {
    const card = el('div', `display:flex;gap:12px;padding:10px;border:1px solid ${C.edge};border-radius:8px;background:${C.bg};cursor:pointer`);
    card.addEventListener('click', () => ctx.go('biome:' + b.id));
    card.addEventListener('mouseenter', () => { card.style.borderColor = C.active; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = C.edge; });
    card.append(ctx.thumb(slotKey('loc', b.id, 'env'), { w: 104, h: 104, empty: 'нет концепта окружения' }));
    const info = el('div', 'min-width:0;flex:1');
    const title = el('div', `font-weight:700;font-size:14.5px;color:${C.text};margin-bottom:2px`, b.name);
    info.append(title);
    const tags = el('div', 'display:flex;gap:4px;flex-wrap:wrap;margin:2px 0 6px');
    if (b.faction) tags.append(chip(FACTION_LABEL[b.faction] ?? b.faction, C.accent));
    if (b.enabled === false) tags.append(chip('выключен в конфиге', C.faint));
    if (b.id === 'crypt') tags.append(chip('артбук нежити', C.gold));
    info.append(tags);
    if (b.tagline) info.append(el('div', `font-size:12px;color:${C.dim};font-style:italic;margin-bottom:4px`, b.tagline.replace(/^"|"$/g, '')));
    if (b.desc) info.append(el('div', `font-size:12px;color:${C.soft};line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden`, b.desc));
    card.append(info);
    grid.append(card);
  }
  if (!biomesOf(ctx).length) grid.append(muted('В конфиге нет биомов (раздел «Мир → Биомы»).'));
  host.append(grid);
}

function renderBiome(host: HTMLElement, ctx: ArtbookCtx, b: BiomeRow): void {
  const top = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px');
  top.append(btn('← все локации', () => ctx.go('')), btn('открыть в конфиге →', () => ctx.gotoConfig('biomes'), `color:${C.dim}`));
  host.append(top);
  host.append(h2(b.name));
  if (b.tagline) host.append(el('div', `font-size:13px;color:${C.dim};font-style:italic;margin:-4px 0 8px`, b.tagline.replace(/^"|"$/g, '')));
  if (b.desc) host.append(el('div', `font-size:13px;color:${C.soft};line-height:1.55;max-width:900px;margin-bottom:8px`, b.desc));

  const facts = el('div', 'margin:6px 0 12px');
  if (b.faction) facts.append(kv('Фракция', FACTION_LABEL[b.faction] ?? b.faction));
  if (b.tileset) facts.append(kv('Набор тайлов', b.tileset + (b.variants?.length ? ' · ' + b.variants.map((v) => `с ${v.fromDepth}-го этажа — ${v.tileset ?? '—'}`).join(', ') : '')));
  if (b.monsterPool?.length) {
    const uniq = [...new Set(b.monsterPool)];
    facts.append(kv(`Монстры биома (${uniq.length})`, uniq.map((m) => monsterName(ctx, m)).join(', ')));
  }
  if (b.enemies?.length) facts.append(kv('Задуманные враги', b.enemies.join(', ')));
  if (b.enabled === false) facts.append(kv('В игре', 'выключен в конфиге'));
  host.append(facts);

  host.append(section('Вид локации и заметки художнику', `loc:${b.id}:look`, (body) => {
    body.append(ctx.list(`locations/biomes/${b.id}/look`, { paragraphs: true }));
    body.append(h3('Заметки художнику'));
    body.append(ctx.text(`locations/biomes/${b.id}/artNotes`, { placeholder: 'пусто — нажми, чтобы записать заметку для художника' }));
  }, { open: true }));

  host.append(section('Концепты окружения', `loc:${b.id}:slots`, (body) => {
    body.append(ctx.slots(['loc', b.id], SLOT_SETS.location));
  }, { open: true }));

  if (b.id === 'crypt') renderNecropolis(host, ctx);
}

// ── Некрополь (черновик «Артбук: нежить крипты») ─────────────────────────────────────────────────

/** Врезка-пометка («это лор, а не раскладка», «код сейчас не пишем»). */
function callout(n: Node): HTMLElement {
  const b = el('div', `border-left:3px solid ${C.gold}88;padding:4px 10px;margin:4px 0 8px;background:${C.bg};border-radius:0 6px 6px 0`);
  b.append(n);
  return b;
}

function renderNecropolis(host: HTMLElement, ctx: ArtbookCtx): void {
  const d = ctx.view.crypt;
  const P = (p: string): string => 'crypt/' + p;
  const t = (p: string, o: Parameters<ArtbookCtx['text']>[1] = {}): HTMLElement => ctx.text(P(p), { tag: 'span', ...o });
  const subName = (id: string): string => d.subtypes.find((s) => s.id === id)?.name ?? id;
  const subCell = (id: string): Cell => {
    const s = d.subtypes.find((x) => x.id === id);
    const c = el('span', `color:${C.text};font-weight:600`, s?.name ?? id);
    if (s) c.title = s.ref;
    return c;
  };

  host.append(el('div', `font-size:16px;font-weight:700;color:${C.text};margin:18px 0 2px`, '🏛 Некрополь: нежить крипты'));
  host.append(ctx.text(P('subtitle'), { css: `font-size:12.5px;color:${C.dim}` }));
  host.append(ctx.text(P('status'), { css: `font-size:12px;color:${C.faint}` }));

  // ⭐ 17.10: сводка решений владельца (16–17.10) — первым разделом: итог развилок, подробности — в вопросах ниже.
  host.append(section(d.decisionsTitle || 'Сводка решений владельца', 'crypt:decisions', (body) => {
    body.append(t('decisionsIntro', { tag: 'div' }));
    const nav = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 6px');
    nav.append(btn('▦ Ярусы × подтипы →', () => ctx.open('monsters', 'tiers')), btn('☰ Ростер и очерёдность →', () => ctx.open('monsters', 'roster')), btn('💀 Подтипы →', () => ctx.open('monsters', '')));
    body.append(nav);
    const ol = el('ol', 'margin:2px 0 8px;padding-left:22px');
    for (const x of d.decisions) {
      const li = el('li', `margin:3px 0;color:${C.soft}`);
      li.append(ctx.text(P(`decisions/${x.id}/text`), { css: 'margin:0', lead: x.title }));
      ol.append(li);
    }
    body.append(ol);
  }, { open: true, note: `${d.decisions.length} пунктов` }));

  host.append(section('Вступление: зачем документ, как работаем, имена, лор', 'crypt:intro', (body) => {
    body.append(h3('Зачем'), ctx.list(P('intro/purpose'), { paragraphs: true }));
    body.append(h3('Как работаем'), ctx.list(P('intro/workflow'), { ordered: true }));
    body.append(h3('Имена в мире'), ctx.list(P('intro/naming')));
    body.append(h3('Порядок подтипов'));
    body.append(table(['№ владельца', 'Подтип', 'Как выглядит'], d.intro.ownerOrder.owner.map((o, i) => [String(o.n), subCell(o.id), t(`intro/ownerOrder/owner/${i}/text`)]), { widths: ['90px', '200px'] }));
    body.append(t('intro/ownerOrder/doc', { tag: 'div' }));
    body.append(h3('Лор: почему мертвецы лежат слоями'), callout(t('intro/loreNote', { tag: 'div' })), ctx.list(P('intro/lore'), { paragraphs: true }));
    body.append(h3('Пометки движка в тексте'));
    body.append(table(['Пометка', 'Что значит'], d.intro.marks.map((m, i) => [el('span', `color:${C.gold}`, `[${m.mark}]`), t(`intro/marks/${i}/meaning`)]), { widths: ['130px'] }));
    body.append(h3('Как устроена вкладка'), ctx.list(P('intro/howTab')));
  }, { open: true }));

  host.append(section('Эпохи мира', 'crypt:eras', (body) => {
    body.append(muted('Видимый текст игры знает только четыре эпохи; «справка» — реальная привязка, игроку не печатается.', 'margin-bottom:4px'));
    body.append(table(['Эпоха', 'Справка (скрыта от игрока)', 'Подтипы', 'Заметка'],
      d.eras.map((e) => [el('b', `color:${C.text}`, e.name), t(`eras/${e.id}/ref`), e.subtypes.map(subName).join(', '), t(`eras/${e.id}/note`)]),
      { widths: ['110px', '24%', '150px'] }));
    body.append(t('eraNote', { tag: 'div' }));
  }));

  // ⭐ 17.10: вместо «слоёв по этажам круга» — выбор подтипа при спуске (решение владельца 16.10). Слот концепта яруса
  // Некрополя (`loc:crypt:layer:<подтип>`) остаётся у каждого подтипа — это лор, уже залитые картинки не теряются.
  host.append(section('Выбор подтипа при спуске', 'crypt:selection', (body) => {
    body.append(t('selection/intro', { tag: 'div' }));
    body.append(table(['Правило', 'Как работает'], d.selection.rules.map((r) => [el('b', `color:${C.text}`, r.rule), t(`selection/rules/${r.id}/how`)]), { widths: ['150px'] }));
    body.append(h3(d.selection.seal.title), t('selection/seal/intro', { tag: 'div' }));
    for (const s of d.selection.seal.items) body.append(kv(s.name, t(`selection/seal/items/${s.id}/text`)));
    body.append(t('selection/seal/note', { tag: 'div' }));
    body.append(h3('Порядок производства'), t('selection/productionOrder', { tag: 'div' }));
    body.append(h3('Если дойдём до кода (на будущее)'), t('selection/engine', { tag: 'div' }));
    body.append(h3('Ступени гира'), t('selection/gearNote', { tag: 'div' }));
    body.append(h3('Ярусы Некрополя — только лор'), callout(t('selection/loreNote', { tag: 'div' })));
    const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px');
    for (const s of d.subtypes) grid.append(ctx.slot(slotKey('loc', 'crypt', 'layer', s.id), { id: 'env', title: `Концепт яруса: ${s.name}`, hint: 'как выглядит ярус Некрополя этого подтипа (лор)' }));
    body.append(grid);
  }));

  host.append(section('Лестница разложения', 'crypt:decay', (body) => {
    body.append(t('decayLadder/intro', { tag: 'div' }));
    body.append(table(['Подтип', 'Тело', 'Вес', 'Скорость', 'Что берёт сильнее', 'Что держит', 'Что накладывает'],
      d.decayLadder.rows.map((r) => [subCell(r.subtype), t(`decayLadder/rows/${r.subtype}/body`), t(`decayLadder/rows/${r.subtype}/weight`), t(`decayLadder/rows/${r.subtype}/speed`), t(`decayLadder/rows/${r.subtype}/takes`), t(`decayLadder/rows/${r.subtype}/holds`), t(`decayLadder/rows/${r.subtype}/gives`)]),
      { widths: ['130px'] }));
    body.append(h3('Рычаги'), t('decayLadder/levers', { tag: 'div' }));
    body.append(h3('Читаемость'), t('decayLadder/readability', { tag: 'div' }));
    body.append(h3('Источники'), sourcesList(d.decayLadder.sources));
  }));

  host.append(section('Статусы по подтипам', 'crypt:statuses', (body) => {
    body.append(t('statuses/intro', { tag: 'div' }));
    body.append(table(['Подтип', 'Главный статус', 'Второй', 'Броня-ответ', 'Слабость', 'Сопротивление'],
      d.statuses.rows.map((r) => [subCell(r.subtype), t(`statuses/rows/${r.subtype}/main`), t(`statuses/rows/${r.subtype}/second`), t(`statuses/rows/${r.subtype}/armor`), t(`statuses/rows/${r.subtype}/weak`), t(`statuses/rows/${r.subtype}/resist`)]),
      { widths: ['130px'] }));
    body.append(t('statuses/note', { tag: 'div' }));
    // ⭐ 17.10: «Настройка» и «Не единственный, а самый частый» (решения владельца 16.10).
    for (const n of d.statuses.notes) {
      body.append(h3(n.title), t(`statuses/notes/${n.id}/text`, { tag: 'div' }), ctx.list(P(`statuses/notes/${n.id}/items`)));
      if (hasField(ctx, P(`statuses/notes/${n.id}/after`))) body.append(t(`statuses/notes/${n.id}/after`, { tag: 'div' }));
    }
    body.append(h3('Источники'), sourcesList(d.statuses.sources));
  }));

  host.append(section('Подписи подтипов', 'crypt:signatures', (body) => {
    body.append(t('signatures/intro', { tag: 'div' }));
    body.append(table(['Подтип', 'Чему учит игрока', 'Первая подпись', 'Вторая подпись', 'Подъём павших'],
      d.signatures.rows.map((r) => [subCell(r.subtype), t(`signatures/rows/${r.subtype}/habit`), t(`signatures/rows/${r.subtype}/first`), t(`signatures/rows/${r.subtype}/second`), t(`signatures/rows/${r.subtype}/raise`)]),
      { widths: ['130px'] }));
    body.append(h3('Знаменосцы по подтипам'), t('signatures/bannerSplit', { tag: 'div' }));
  }));

  host.append(section('Пачки', 'crypt:packs', (body) => {
    body.append(t('packs/intro', { tag: 'div' }));
    body.append(h3('Бюджет угрозы'));
    body.append(table(['Роль', 'Угроза'], d.packs.budget.map((r, i) => [t(`packs/budget/${i}/role`), t(`packs/budget/${i}/threat`)]), { widths: ['60%'] }));
    body.append(t('packs/roomBudget', { tag: 'div' }));
    body.append(h3('Правила сборки'), ctx.list(P('packs/rules')));
    body.append(h3('Шаблоны пачек'));
    const cols = d.matrix.columns;
    body.append(muted('Шаблоны по ролям — справочные (прежняя раскладка, до 17.10). Пачки ростеров по ярусам — на страницах подтипов (вкладка «Монстры», раздел «Ярусы (v2)»).', 'margin:2px 0 2px'));
    body.append(table(['Шаблон', 'Что проверяет', ...cols.map((c) => c.name)],
      d.packs.templates.map((p) => [el('b', `color:${C.text}`, p.name), t(`packs/templates/${p.id}/checks`), ...cols.map((c) => (p.perSubtype[c.id] !== undefined ? t(`packs/templates/${p.id}/perSubtype/${c.id}`) : '—'))]),
      { widths: ['130px', '150px'] }));
    const hall = d.packs.bossHall;
    if (hall) {
      body.append(h3('Босс-залы'), t('packs/bossHall/note', { tag: 'div' }));
      for (const c of cols) if (hall.perSubtype[c.id] !== undefined) body.append(kv(c.name, t(`packs/bossHall/perSubtype/${c.id}`)));
    }
  }));

  host.append(section('Читаемость на камере', 'crypt:readability', (body) => {
    body.append(h3('Числа камеры'), ctx.list(P('readability/numbers')));
    body.append(h3('Порядок чтения'), t('readability/hierarchy', { tag: 'div' }), t('readability/rule', { tag: 'div' }));
    const two = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:4px 18px');
    const a = el('div'), b = el('div');
    a.append(h3('Что читается'), ctx.list(P('readability/reads')));
    b.append(h3('Что теряется'), ctx.list(P('readability/lost')));
    two.append(a, b);
    body.append(two);
    body.append(h3('Ключи подтипа на камере'));
    body.append(table(['Подтип', 'Голова', 'Щит', 'Металл', 'Акцент', 'Свечение'],
      d.readability.keys.map((r) => [subCell(r.subtype), t(`readability/keys/${r.subtype}/head`), t(`readability/keys/${r.subtype}/shield`), t(`readability/keys/${r.subtype}/metal`), t(`readability/keys/${r.subtype}/accent`), t(`readability/keys/${r.subtype}/glow`)]),
      { widths: ['130px'] }));
    body.append(h3('Сигналы угрозы'));
    body.append(table(['Сигнал', 'Что значит'], d.readability.signals.map((s, i) => [t(`readability/signals/${i}/signal`), t(`readability/signals/${i}/meaning`)]), { widths: ['50%'] }));
    body.append(t('readability/threatColor', { tag: 'div' }));
    body.append(h3('Проверки концепта'), ctx.list(P('readability/checks'), { ordered: true }));
    body.append(h3('С чем легко спутать'));
    body.append(table(['Кто', 'С кем', 'Как развести'], d.readability.confusions.map((c, i) => [t(`readability/confusions/${i}/a`), t(`readability/confusions/${i}/b`), t(`readability/confusions/${i}/fix`)]), { widths: ['150px', '200px'] }));
  }));

  host.append(section('Рычаги движка', 'crypt:engine', (body) => {
    // ⭐ 17.10: код сейчас не пишем (решение владельца 16.10, вопрос 6) — пометки есть / легко / на будущее, всё ниже — справка.
    body.append(callout(t('engine/marksIntro', { tag: 'div' })));
    body.append(h3('Пометки в карточках'));
    body.append(table(['Пометка', 'Что значит'], d.engine.marks.map((m) => [chip(m.mark, markColor(m.mark)), t(`engine/marks/${m.id}/meaning`)]), { widths: ['130px'] }));
    body.append(muted('Коды К1–К23 — работа программиста (цена «мелко» — пометка [легко], «средне» и «крупно» — [на будущее]); Д — правки данных в редакторе. Пометки в тексте подтипов и карточек ссылаются сюда.', 'margin-bottom:4px'));
    body.append(table(['Код', 'Что', 'Цена', 'Заметка'], d.engine.codes.map((c) => [el('b', `color:${C.warn}`, c.code), t(`engine/codes/${c.code}/name`), t(`engine/codes/${c.code}/cost`), t(`engine/codes/${c.code}/note`)]), { widths: ['48px', '42%', '110px'] }));
    body.append(h3('Правки данных'), ctx.list(P('engine/dataFixes')));
    body.append(h3(d.engine.beforeDemoTitle || 'Если дойдём до кода'), ctx.list(P('engine/beforeDemo'), { ordered: true }));
    body.append(h3('Нынешние монстры конфига (тестовые) → архетипы архива'));
    if (hasField(ctx, P('engine/existingMapNote'))) body.append(t('engine/existingMapNote', { tag: 'div' }));
    const mons = Array.isArray(ctx.data.monsters) ? ctx.data.monsters as { id: string }[] : [];
    body.append(table(['Монстр конфига', 'Сейчас', 'Куда идёт'], d.engine.existingMap.map((m) => {
      const has = mons.some((x) => x.id === m.id);
      const id = el('span', `font-family:ui-monospace,monospace;font-size:12px;color:${has ? C.text : C.bad}`, m.id);
      if (!has) id.title = 'такого монстра в конфиге нет';
      return [id, t(`engine/existingMap/${m.id}/name`), t(`engine/existingMap/${m.id}/to`)];
    }), { widths: ['150px', '170px'] }));
  }));

  // ⭐ 17.10: составные юниты (К15) — как выглядят и как сделать (решение владельца 16.10).
  const comp = d.engine.composite;
  host.append(section(comp.title, 'crypt:composite', (body) => {
    body.append(t('engine/composite/intro', { tag: 'div' }));
    body.append(table(['Юнит', 'Как выглядит и как рвётся'], comp.units.map((u) => [t(`engine/composite/units/${u.id}/name`, { css: `font-weight:600;color:${C.text}` }), t(`engine/composite/units/${u.id}/text`)]), { widths: ['170px'] }));
    body.append(h3('Как сделать'), t('engine/composite/stepsIntro', { tag: 'div' }));
    for (const s of comp.steps) body.append(kv(s.name, t(`engine/composite/steps/${s.id}/text`)));
    body.append(h3('Пока кода нет'), t('engine/composite/fallback', { tag: 'div' }));
    body.append(h3('Художнику'), t('engine/composite/artist', { tag: 'div' }));
  }));

  // ⭐ 17.10: «Открытые вопросы» → «Вопросы и решения»: под каждым вопросом — «Решение владельца» (правится кликом).
  host.append(section('Вопросы и решения', 'crypt:questions', (body) => {
    body.append(muted('Развилки, которые закрыл владелец 16–17.10: варианты и рекомендация исследования, решение владельца и что поменялось в документе. Решение правится кликом, как любой текст.', 'margin-bottom:6px'));
    d.questions.forEach((q, i) => {
      const Q = (f: string): string => `questions/${i}/${f}`;
      const card = el('div', `border:1px solid ${C.edgeSoft};border-radius:8px;padding:8px 10px;margin:0 0 8px;background:${C.bg}`);
      const head = el('div', 'display:flex;gap:8px;align-items:baseline');
      head.append(el('span', `color:${C.gold};font-weight:700`, `${q.n}.`), t(Q('q'), { css: `color:${C.text};font-weight:600` }));
      card.append(head);
      if (hasField(ctx, P(Q('options')))) card.append(kv('Варианты', t(Q('options'))));
      if (hasField(ctx, P(Q('rec')))) card.append(kv(q.recTitle || 'Рекомендация', t(Q('rec'))));
      const dec = el('div', `margin:6px 0 2px;padding:6px 10px;border-left:3px solid ${C.ok};background:${C.panel};border-radius:0 6px 6px 0`);
      dec.append(el('div', `font-size:11.5px;font-weight:700;color:${C.ok};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px`, 'Решение владельца'));
      dec.append(ctx.text(P(Q('decision')), { css: 'margin:0', placeholder: 'решения ещё нет — нажми, чтобы записать' }));
      card.append(dec);
      if (hasField(ctx, P(Q('changed')))) card.append(kv('Что поменялось в документе', t(Q('changed'))));
      body.append(card);
    });
  }, { open: true }));

  host.append(section('Источники', 'crypt:sources', (body) => {
    body.append(sourcesList(d.sources));
    body.append(muted('Источники по подтипам — на страницах подтипов (вкладка «Монстры»).'));
  }));
}
