/**
 * ⭐ 17.10 (Артбук): страницы РОСТЕРОВ ПО ЯРУСАМ (v2, решения владельца 16–17.10) в «💀 Монстрах»:
 *  • раздел «Ярусы (v2)» на странице подтипа — сетка ярусов, по ярусу таблица карточек (3 ближника + 2 стрелка), три босса, особые,
 *    пачки, переход ярусов по кругу, комплект моделей, статусы, куда ушли прежние карточки, вопросы, банк идей (свёрнут);
 *  • страница карточки `card:<подтип>:<id>` — боец яруса, босс или особый: слоты `v2:<подтип>:<id>:<слот>` и все поля;
 *  • вид «Ярусы × подтипы» (`tiers`) — имена карточек по ярусам шести подтипов и строка боссов;
 *  • вид «Ростер и очерёдность» (`roster`) — очереди 1 · сначала / 2 · следом / 3 · потом / Р, Европа первой, счёты.
 *
 * Данные — `seed/v2/*.json`, ЛЕНИВО (`ctx.roster`, `ctx.rosterIndex`): пока грузится — «Загрузка…», по загрузке страница
 * перерисуется сама. Все тексты правятся на месте по пути `v2/<подтип>/…` (`v2/index/…`); в кликабельных строках таблиц текст
 * только для чтения — правка на странице карточки. Числа (вес, скорость, доли ярусов, множители) — из сида, не правятся.
 * Живые числа монстров конфига у карточек v2 — заглушка: нынешние 19 зомби тестовые, карточки делаем заново (решение 17.10).
 */
import type { ArtbookCtx, TextOpts } from './ctx.js';
import { SLOT_SETS, slotImages, slotKey, slotState } from './model.js';
import {
  ARMOR_RU, BOSS_LABEL, COMBAT_RU, STATUS_RU, TIER_IDS, TIER_POWER, TIER_RU, TIER_TITLE, armorMix, entryMech, fmtMult, queueCell,
  queueCounts, queueTotalCell, resistText, rosterEntries, rosterEntry, statusMult, type MechSummary, type RosterEntry,
} from './roster.js';
import { rosterQueue, type RosterIndex, type RosterRules, type RosterTier, type RosterV2, type Subtype, type TierId } from './seed.js';
import { C, btn, chip, el, h2, h3, kv, markColor, muted, section, swatches, table, type Cell } from './ui.js';
import { fieldValue, hasField } from './widgets.js';

// ── Общие куски ──────────────────────────────────────────────────────────────────────────────────

/** Путь правки поля ростера подтипа и сводки. */
const V = (sub: string, p: string): string => `v2/${sub}/${p}`;
const I = (p: string): string => `v2/index/${p}`;
/** Правимый текст строкой (в некликабельных местах). */
const T = (ctx: ArtbookCtx, path: string, o: TextOpts = {}): HTMLElement => ctx.text(path, { tag: 'span', ...o });
/** Текст только для чтения (в кликабельной строке или карточке). */
const RO = (ctx: ArtbookCtx, path: string, css = ''): HTMLElement => ctx.text(path, { tag: 'span', readonly: true, css });
const mono = (s: string, css = ''): HTMLElement => el('span', `font-family:ui-monospace,monospace;font-size:11.5px;color:${C.dim};${css}`, s);
const dim = (s: string, css = ''): HTMLElement => el('div', `font-size:11.5px;color:${C.faint};line-height:1.35;${css}`, s);
const conceptKey = (sub: string, id: string): string => slotKey('v2', sub, id, 'concept');
const isApproved = (ctx: ArtbookCtx, sub: string, id: string): boolean => slotState(slotImages(ctx.doc(), conceptKey(sub, id))) === 'approved';
const subOf = (ctx: ArtbookCtx, id: string): Subtype | undefined => ctx.view.crypt.subtypes.find((s) => s.id === id);
/** «Европа XII–XV вв.» — прототип подтипа из колонок черновика. */
const protoOf = (ctx: ArtbookCtx, id: string): string => ctx.view.crypt.matrix.columns.find((c) => c.id === id)?.proto ?? '';

/** Сколько карточек подтипа (бойцы ярусов, боссы, особые) с утверждённым концептом — по ключам слотов, без загрузки ростера. */
export function v2ConceptsApproved(ctx: ArtbookCtx, sub: string): number {
  const pre = `v2:${slotKey(sub)}:`;
  return Object.entries(ctx.doc().slots).filter(([k, l]) => k.startsWith(pre) && k.endsWith(':concept') && slotState(l) === 'approved').length;
}

/** Ростер ещё грузится — или не загрузился (с «повторить»). */
function pending(ctx: ArtbookCtx, keys: readonly string[]): HTMLElement {
  const errs = keys.map((k) => [k, ctx.rosterError(k)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  if (!errs.length) return muted('Загрузка ростера по ярусам…', 'padding:6px 0');
  const box = el('div', `color:${C.bad};font-size:12.5px;margin:4px 0 8px`, '⚠ Ростер не загрузился: ' + errs.map(([k, e]) => `${k} — ${e}`).join('; ') + ' ');
  box.append(btn('повторить', () => { for (const [k] of errs) ctx.rosterRetry(k); }, 'padding:1px 8px;font-size:11.5px'));
  return box;
}

/** Все шесть ростеров и сводка — или `null` (загрузка начата для всех сразу, а не по очереди). */
function allRosters(ctx: ArtbookCtx): { idx: RosterIndex; R: Map<string, RosterV2>; order: string[] } | null {
  const ids = ctx.view.crypt.subtypes.map((s) => s.id);
  const rs = ids.map((id) => ctx.roster(id));
  const idx = ctx.rosterIndex();
  if (!idx || rs.some((x) => !x)) return null;
  const R = new Map(ids.map((id, i) => [id, rs[i]!]));
  return { idx, R, order: idx.order.filter((id) => R.has(id)) };
}

/** Полоса переходов «Монстров»: ярусы × подтипы, ростер, архивная матрица, конфиг. */
export function navBar(ctx: ArtbookCtx, ...extra: HTMLElement[]): HTMLElement {
  const top = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap');
  top.append(...extra,
    btn('▦ Ярусы × подтипы', () => ctx.go('tiers'), `color:${C.dim}`),
    btn('☰ Ростер и очерёдность', () => ctx.go('roster'), `color:${C.dim}`),
    btn('▦ Архив: «архетип × подтип»', () => ctx.go('matrix'), `color:${C.faint}`),
    btn('монстры в конфиге →', () => ctx.gotoConfig('monsters'), `color:${C.dim}`));
  return top;
}

/** Статус удара с силой у подтипа: родной — золото, второй — обычный, чужой — серый. */
function statusChip(r: RosterV2, name: string, mult = statusMult(r, name)): HTMLElement {
  const st = r.rules.statuses;
  const kind = name === st.native.status ? 'родной статус подтипа' : name === st.second.status ? 'второй статус подтипа' : 'чужой статус';
  return chip(`${name} ${fmtMult(mult)}`, name === st.native.status ? C.gold : name === st.second.status ? C.soft : C.faint, kind);
}

/** «Механика держится на»: есть / легко / на будущее — бейджами (переносятся, а не тянут ячейку вбок). */
function mechChips(m: MechSummary): HTMLElement {
  const box = el('span', 'display:inline-flex;gap:3px;flex-wrap:wrap');
  const add = (t: string, mark: string): void => { const c = chip(t, markColor(mark)); c.style.whiteSpace = 'normal'; box.append(c); };
  if (m.have) add('есть', 'есть');
  if (m.easy.length) add('легко: ' + m.easy.join(', ').replace(/`/g, ''), 'легко');
  if (m.future.length) add('на будущее: ' + m.future.join(', '), 'на будущее');
  if (!m.have && !m.easy.length && !m.future.length) add('данные', 'данные');
  box.title = 'механика держится на: ' + m.text.replace(/`/g, '');
  return box;
}

/** Имя карточки ссылкой на её страницу (✓ — концепт утверждён). */
function nameLink(ctx: ArtbookCtx, sub: string, e: RosterEntry, label = fieldValue(ctx, V(sub, `${e.path}/name`))): HTMLElement {
  const a = el('span', `cursor:pointer;color:${C.text};border-bottom:1px dotted ${C.edge}`);
  if (isApproved(ctx, sub, e.id)) a.append(el('span', `color:${C.ok}`, '✓ '));
  a.append(label);
  a.title = 'карточка: концепты и все поля';
  a.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.go(`card:${sub}:${e.id}`); });
  return a;
}

/** Ссылки через разделитель (`·`). */
function links(ctx: ArtbookCtx, sub: string, list: readonly RosterEntry[], sep = ' · '): HTMLElement {
  const box = el('span', 'line-height:1.6');
  list.forEach((e, i) => { if (i) box.append(sep); box.append(nameLink(ctx, sub, e)); });
  if (!list.length) box.append('—');
  return box;
}

const tierOfEntry = (e: RosterEntry): string =>
  e.kind === 'card' ? `${TIER_RU[e.tier]} (${TIER_POWER[e.tier]})`
    : e.kind === 'boss' ? `${TIER_RU[e.tier]}${e.boss.floor === 19 ? ' (актовый)' : ''} · тир boss`
      : `${TIER_RU[e.tier]} (${e.special.powerTier})`;

const combatOfEntry = (idx: RosterIndex, e: RosterEntry): string =>
  e.kind === 'card' ? COMBAT_RU[e.card.combat] : e.kind === 'boss' ? (idx.bosses.short[e.id]?.combat ?? '—') : COMBAT_RU[e.special.combat];

// ── Раздел «Ярусы (v2)» на странице подтипа ──────────────────────────────────────────────────────

export function renderRosterSection(body: HTMLElement, ctx: ArtbookCtx, s: Subtype): void {
  const r = ctx.roster(s.id), idx = ctx.rosterIndex();
  if (!r || !idx) { body.append(pending(ctx, [s.id, 'index'])); return; }
  const sub = s.id;
  const P = (p: string): string => V(sub, p);
  const st = r.rules.statuses;
  const cards = r.tiers.flatMap((t) => t.cards);

  const head = el('div', 'display:flex;gap:4px 6px;flex-wrap:wrap;align-items:center;margin:2px 0 6px');
  head.append(
    chip(`карточек ${cards.length}: ${cards.filter((c) => c.combat === 'melee').length} ближних + ${cards.filter((c) => c.combat === 'ranged').length} стрелков`, C.text),
    chip(`боссов ${r.bosses.length}`, C.text),
    chip(`особых ${r.specials.length} (1-я волна — ${r.specials.filter((x) => x.wave === 1).length})`, C.text),
    chip(`пачек ${r.packs.length}`, C.dim), chip(`новых вещей гира ${r.newGear.length}`, C.dim),
    chip(`концептов ${v2ConceptsApproved(ctx, sub)}/${cards.length + r.bosses.length + r.specials.length}`, v2ConceptsApproved(ctx, sub) ? C.ok : C.faint),
  );
  body.append(head);
  const sts = el('div', 'display:flex;gap:4px 6px;flex-wrap:wrap;align-items:center;margin:0 0 6px');
  sts.append(el('span', `font-size:12px;color:${C.dim}`, 'Статусы:'), statusChip(r, st.native.status, st.native.mult), statusChip(r, st.second.status, st.second.mult),
    chip(`чужие ${fmtMult(st.foreign.mult)}: ${st.foreign.list.join(', ')}`, C.faint));
  body.append(sts);
  body.append(muted('Нынешние 19 зомби конфига — тестовые: карточки ниже делаем заново (решение владельца 17.10). Клик по карточке, боссу или особому — его страница: концепты и все поля.', 'margin-bottom:6px;line-height:1.5'));

  body.append(section('Как устроен ростер подтипа и его правила', `v2:${sub}:intro`, (b) => {
    b.append(ctx.list(P('intro'), { paragraphs: true }));
    b.append(h3('Правила подтипа'), rulesBlock(ctx, r));
  }, { level: 2 }));

  body.append(h3('Сетка ярусов'));
  body.append(table(['Ярус', 'Эпоха', 'Броня · шлем · щит', 'Руки и ноги (от нагрудника)', 'Стойкость яруса', 'Тир силы'], r.tiers.map((t) => {
    const TP = (f: string): string => P(`tiers/${t.id}/${f}`);
    const era = el('div', '');
    era.append(T(ctx, TP('era')));
    if (hasField(ctx, TP('eraText'))) era.append(el('br'), T(ctx, TP('eraText'), { css: `font-size:11.5px;color:${C.dim}` }));
    const gear = el('div', '');
    for (const [k, f] of [['броня', 'armor'], ['шлем', 'helms'], ['щит', 'shields']] as const) {
      const line = el('div', 'margin:0 0 3px');
      line.append(el('span', `color:${C.faint};font-size:11.5px`, k + ': '), T(ctx, TP(f)));
      gear.append(line);
    }
    const res = el('div', '');
    res.append(T(ctx, TP('resist')), dim(resistText(idx.tierResistMult[t.id]), 'margin-top:2px'));
    const pw = el('div', 'display:flex;flex-direction:column;gap:3px;align-items:flex-start');
    pw.append(chip(t.powerTier, C.gold, 'ярус = тир силы'), dim(armorMix(t.cards)));
    return [el('b', `color:${C.text}`, TIER_TITLE[t.id]), era, gear, T(ctx, TP('limbs')), res, pw];
  }), { widths: ['80px', '130px', '34%'] }));
  body.append(ctx.list(P('gridNotes')));

  for (const t of r.tiers) {
    body.append(section(`${TIER_TITLE[t.id]} ярус · ${t.powerTier} · ${fieldValue(ctx, P(`tiers/${t.id}/era`))}`, `v2:${sub}:tier:${t.id}`, (b) => tierBlock(b, ctx, r, t), { open: true, level: 2, note: `${t.cards.length} карточек` }));
  }
  body.append(section('Боссы: 5 · 14 · 19', `v2:${sub}:bosses`, (b) => bossesBlock(b, ctx, r, idx), { open: true, level: 2, note: 'лёгкий, средний, актовый — разные по бою' }));
  body.append(section('Особые', `v2:${sub}:specials`, (b) => specialsBlock(b, ctx, r, idx), { open: true, level: 2, note: `${r.specials.length}, не больше одного на пачку` }));
  body.append(section('Пачки', `v2:${sub}:packs`, (b) => packsBlock(b, ctx, r), { open: true, level: 2, note: String(r.packs.length) }));
  body.append(section('Переход ярусов по кругу', `v2:${sub}:circle`, (b) => circleBlock(b, ctx, r), { open: true, level: 2, note: 'ярус — по месту этажа в круге из 20' }));
  body.append(section('Комплект моделей по ярусам', `v2:${sub}:kit`, (b) => kitBlock(b, ctx, r), { open: true, level: 2, note: `новых вещей гира ${r.newGear.length}` }));
  body.append(section('Статусы и стойкость', `v2:${sub}:statuses`, (b) => statusesBlock(b, ctx, r, idx), { open: true, level: 2 }));
  body.append(section('Куда ушли прежние карточки', `v2:${sub}:migration`, (b) => {
    b.append(T(ctx, P('migrationIntro'), { tag: 'div' }));
    b.append(table(['Было', 'Архетип (архив)', 'Стало', 'Заметка'], r.migration.map((m) => [
      T(ctx, P(`migration/${m.id}/was`)), T(ctx, P(`migration/${m.id}/archetype`)), T(ctx, P(`migration/${m.id}/became`)), T(ctx, P(`migration/${m.id}/note`)),
    ]), { widths: ['150px', '150px', '150px'] }));
    if (hasField(ctx, P('migrationNote'))) b.append(T(ctx, P('migrationNote'), { tag: 'div' }));
  }, { level: 2, note: `${r.migration.length} прежних карточек` }));
  body.append(section('Вольности', `v2:${sub}:liberties`, (b) => b.append(ctx.list(P('liberties'))), { level: 2, note: String(r.liberties.length) }));
  body.append(section('Вопросы по подтипу', `v2:${sub}:questions`, (b) => {
    b.append(T(ctx, P('openQuestionsNote'), { tag: 'div' }));
    if (r.openQuestions.length) b.append(ctx.list(P('openQuestions'), { ordered: true }));
    if (r.decided.length) b.append(h3(fieldValue(ctx, P('decidedNote')) || 'Решено'), ctx.list(P('decided')));
  }, { level: 2, note: r.openQuestions.length ? `открытых ${r.openQuestions.length}` : 'открытых нет' }));
  body.append(section('Банк идей', `v2:${sub}:bank`, (b) => bankBlock(b, ctx, r), { level: 2, note: `${r.ideaBank.bosses.length} вар. боссов + ${r.ideaBank.ideas.length} идей — не в работе` }));
}

/** Подписи правил подтипа (строковые поля `rules`), в порядке важности. */
const RULE_LABEL: [keyof RosterRules, string][] = [
  ['tiers', 'Ярусы'], ['perTier', 'На ярусе'], ['circle', 'Круг'], ['subtypeRoll', 'Подтип при спуске'], ['cuirass', 'Кираса'], ['brigandine', 'Бригантина'],
  ['limbs', 'Руки и ноги'], ['friendlyFire', 'Удар по своим'], ['ladder', 'Лестница'], ['armorAnswer', 'Броня-ответ'], ['colorRule', 'Цвет'], ['scale', 'Шкала'],
  ['subtypeResist', 'Стойкость подтипа'], ['resistCombine', 'Как складываются'], ['decay', 'Разложение'], ['hole', 'Чего нет'], ['cult', 'Культ'], ['cults', 'Культы'],
  ['names', 'Имена'],
];
const PER_TIER_RULES: [keyof RosterRules, string][] = [['burialGrade', 'Разряд погребения'], ['decayByTier', 'Разложение по ярусам'], ['decayStages', 'Стадии разложения']];

function rulesBlock(ctx: ArtbookCtx, r: RosterV2): HTMLElement {
  const P = (p: string): string => V(r.id, `rules/${p}`);
  const box = el('div', '');
  box.append(kv('Пласты ярусов', TIER_IDS.map((t) => `${TIER_RU[t]} — ${r.rules.eras[t] ?? '—'}`).join('; ')));
  for (const [k, label] of RULE_LABEL) if (typeof r.rules[k] === 'string') box.append(kv(label, T(ctx, P(k))));
  for (const [k, label] of PER_TIER_RULES) {
    const v = r.rules[k] as Partial<Record<TierId, string>> | undefined;
    if (!v) continue;
    const list = el('div', '');
    for (const t of TIER_IDS) if (v[t] !== undefined) { const l = el('div', ''); l.append(el('span', `color:${C.faint}`, TIER_RU[t] + ': '), T(ctx, P(`${k}/${t}`))); list.append(l); }
    box.append(kv(label, list));
  }
  const sig = r.rules.signatures ?? [];
  if (sig.length) {
    box.append(h3('Подписи подтипа'));
    sig.forEach((x, i) => box.append(typeof x === 'string' ? kv('•', T(ctx, P(`signatures/${i}`))) : kv(x.name, T(ctx, P(`signatures/${x.id}/text`)))));
  }
  const pal = Object.entries(r.rules.palette ?? {});
  if (pal.length) {
    box.append(h3('Палитра'), swatches(pal.filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v)).map(([role, hex]) => ({ role, hex }))));
    for (const [role, v] of pal) if (!/^#[0-9a-f]{3,8}$/i.test(v)) box.append(kv(role, v));
  }
  return box;
}

function tierBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2, t: RosterTier): void {
  const sub = r.id;
  const TP = (f: string): string => V(sub, `tiers/${t.id}/${f}`);
  for (const [label, f] of [['Разряд погребения', 'burialGrade'], ['Сила', 'force'], ['Разложение', 'decay'], ['Кто это', 'lead'], ['Ближний бой', 'melee'], ['Стрелки', 'ranged'],
    ['Вес и скорость', 'weightSpeed'], ['Статусы', 'statuses'], ['Силуэт яруса', 'silhouette']] as const) {
    if (hasField(ctx, TP(f))) b.append(kv(label, T(ctx, TP(f))));
  }
  const wrap = el('div', '');
  wrap.dataset.v2Tier = t.id;
  wrap.append(table(['Карточка', 'Бой', 'Роль', 'Оружие и статус', 'Приём', 'Силуэт'], t.cards.map((c): Cell[] => {
    const CP = (f: string): string => TP(`cards/${c.id}/${f}`);
    const e = rosterEntry(r, c.id)!;
    const name = el('div', 'display:flex;gap:8px;align-items:flex-start;min-width:0');
    name.append(ctx.thumb(conceptKey(sub, c.id), { w: 44, h: 44, empty: 'нет' }));
    const nm = el('div', 'min-width:0');
    nm.append(RO(ctx, CP('name'), `font-weight:700;color:${C.text}`), dim(`вес ${c.weight} · скор. ${c.speed}`));
    name.append(nm);
    const combat = el('div', '');
    combat.append(el('div', '', COMBAT_RU[c.combat]), dim(ARMOR_RU[c.armorClass] ?? c.armorClass));
    const weapon = el('div', '');
    weapon.append(RO(ctx, CP('weapon/text')));
    const wl = el('div', 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:3px');
    wl.append(statusChip(r, c.weapon.statusName, c.weapon.mult), mono(c.weapon.gear));
    weapon.append(wl);
    if (c.weapon.fallback) weapon.append(dim(`пока нет — ${c.weapon.fallback.replace(/`/g, '')}`));
    const move = el('div', ''), mech = el('div', 'margin-top:3px');
    mech.append(mechChips(entryMech(e, ctx.view.crypt.engine.codes)));
    move.append(RO(ctx, CP('move')), mech);
    return [name, combat, RO(ctx, CP('role')), weapon, move, RO(ctx, CP('silhouette'))];
  }), { widths: ['170px', '78px', '15%', '19%', '24%'], onRow: (i) => ctx.go(`card:${sub}:${t.cards[i]!.id}`) }));
  b.append(wrap);
}

function bossesBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2, idx: RosterIndex): void {
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;margin:4px 0 8px');
  for (const boss of [...r.bosses].sort((x, y) => x.floor - y.floor)) {
    const BP = (f: string): string => V(r.id, `bosses/${boss.id}/${f}`);
    const card = el('div', `border:1px solid ${C.edge};border-radius:8px;background:${C.bg};padding:8px 10px;cursor:pointer;min-width:0`);
    card.dataset.v2Boss = boss.id;
    card.addEventListener('click', () => ctx.go(`card:${r.id}:${boss.id}`));
    card.addEventListener('mouseenter', () => { card.style.borderColor = C.active; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = C.edge; });
    const top = el('div', 'display:flex;gap:10px;align-items:flex-start');
    top.append(ctx.thumb(conceptKey(r.id, boss.id), { w: 76, h: 96 }));
    const info = el('div', 'min-width:0;flex:1');
    info.append(RO(ctx, BP('name'), `font-weight:700;font-size:14px;color:${C.text}`));
    const tags = el('div', 'display:flex;gap:4px;flex-wrap:wrap;margin:3px 0');
    tags.append(chip(`этаж ${boss.floor} · ${BOSS_LABEL[boss.floor] ?? TIER_RU[boss.tier]}`, C.gold), chip('тир boss', C.dim), chip(ARMOR_RU[boss.armorClass] ?? boss.armorClass, C.faint));
    const sh = idx.bosses.short[boss.id];
    if (sh) tags.append(chip(sh.combat, C.accent));
    info.append(tags);
    if (hasField(ctx, BP('title'))) info.append(RO(ctx, BP('title'), `font-size:12px;color:${C.dim};font-style:italic`));
    if (sh) info.append(RO(ctx, I(`bosses/short/${boss.id}/short`), 'display:block;margin-top:3px;font-size:12px'));
    top.append(info);
    card.append(top);
    card.append(h3('Облик'), ctx.list(BP('look'), { readonly: true, css: 'font-size:12px' }));
    card.append(h3('Бой по фазам'), ctx.list(BP('fight'), { ordered: true, readonly: true, css: 'font-size:12px' }));
    grid.append(card);
  }
  b.append(grid);
  b.append(T(ctx, V(r.id, 'bossesNote'), { tag: 'div' }));
}

function specialsBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2, idx: RosterIndex): void {
  if (idx.specials.flavor[r.id] !== undefined) b.append(kv('Колорит', T(ctx, I(`specials/flavor/${r.id}`))));
  const list = [...r.specials].sort((x, y) => x.wave - y.wave);
  const wrap = el('div', '');
  wrap.dataset.v2Specials = r.id;
  wrap.append(table(['Особый', 'Ярус · тир', 'Волна', 'Бой', 'Статус', 'Механика'], list.map((sp): Cell[] => {
    const name = el('div', 'display:flex;gap:8px;align-items:flex-start;min-width:0');
    name.append(ctx.thumb(conceptKey(r.id, sp.id), { w: 40, h: 40, empty: 'нет' }));
    const nm = el('div', 'min-width:0');
    nm.append(RO(ctx, V(r.id, `specials/${sp.id}/name`), `font-weight:700;color:${C.text}`), dim(`вес ${sp.weight} · скор. ${sp.speed}`));
    if (sp.tierNote) nm.append(dim(sp.tierNote));
    name.append(nm);
    const status = sp.status ? statusChip(r, STATUS_RU[sp.status] ?? sp.status) : el('span', `color:${C.faint}`, 'без удара');
    const mech = idx.specials.short[sp.id] !== undefined ? RO(ctx, I(`specials/short/${sp.id}`)) : RO(ctx, V(r.id, `specials/${sp.id}/mechanic`));
    return [name, `${TIER_RU[sp.tier]} · ${sp.powerTier}`, `${sp.wave}-я`, COMBAT_RU[sp.combat], status, mech];
  }), { widths: ['190px', '110px', '56px', '80px', '120px'], onRow: (i) => ctx.go(`card:${r.id}:${list[i]!.id}`) }));
  b.append(wrap);
  b.append(ctx.list(V(r.id, 'specialsNote'), { paragraphs: true }));
}

function packsBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2): void {
  const P = (p: string): string => V(r.id, p);
  b.append(table(['Пачка', 'Этажи', 'Ярусы', 'Состав', 'Ближ. / стрел. / подд.', 'Статусы в пачке', 'Что проверяет'], r.packs.map((p): Cell[] => {
    const PP = (f: string): string => P(`packs/${p.id}/${f}`);
    const comp = el('div', 'line-height:1.6');
    const member = (m: { id: string; card: string; count: number }): HTMLElement => {
      const line = el('div', '');
      const e = rosterEntry(r, m.id);
      line.append(`${m.count} × `, e ? nameLink(ctx, r.id, e) : m.card);
      return line;
    };
    for (const m of p.members) comp.append(member(m));
    if (p.optional.length) { comp.append(dim('по желанию:', 'margin-top:2px')); for (const m of p.optional) comp.append(member(m)); }
    if (hasField(ctx, PP('optionalText'))) comp.append(T(ctx, PP('optionalText'), { tag: 'div', css: `font-size:11.5px;color:${C.dim}` }));
    p.extra.forEach((_, i) => comp.append(T(ctx, PP(`extra/${i}`), { tag: 'div', css: `font-size:11.5px;color:${C.dim}` })));
    const sts = Object.entries(p.statusCount).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    return [T(ctx, PP('name'), { css: `font-weight:700;color:${C.text}` }), p.floors, p.tiers, comp, `${p.melee} / ${p.ranged} / ${p.support}`, sts, T(ctx, PP('checks'))];
  }), { widths: ['130px', '60px', '90px', '24%', '70px', '120px'] }));
  b.append(T(ctx, P('packRule'), { tag: 'div' }));
}

function circleBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2): void {
  const P = (p: string): string => V(r.id, `transition/${p}`);
  b.append(T(ctx, I('transition/intro'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));
  b.append(table(['Этажи', 'Лёгкий', 'Средний', 'Тяжёлый', 'Сейчас в игре (weak / medium / strong / boss)', 'Боссы и порталы', 'Особые', 'Что видит игрок'], r.transition.bands.map((x) => [
    el('b', `color:${C.text}`, x.floors), `${x.light} %`, `${x.medium} %`, `${x.heavy} %`, mono(x.now), T(ctx, P(`bands/${x.id}/bosses`)), T(ctx, P(`bands/${x.id}/specials`)), T(ctx, P(`bands/${x.id}/player`)),
  ]), { widths: ['54px', '58px', '62px', '64px', '110px'] }));
  b.append(ctx.list(P('notes')));
}

function kitBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2): void {
  const P = (p: string): string => V(r.id, p);
  b.append(table(['Ярус', 'Торс', 'Шлем', 'Руки и ноги (от нагрудника)', 'Щиты', 'Оружие', 'Насадки'], r.kit.map((k) => {
    const KP = (f: string): string => P(`kit/${k.id}/${f}`);
    return [T(ctx, KP('tier'), { css: `font-weight:700;color:${C.text}` }), T(ctx, KP('torso')), T(ctx, KP('helm')), T(ctx, KP('limbs')), T(ctx, KP('shields')), T(ctx, KP('weapons')), T(ctx, KP('extra'))];
  }), { widths: ['100px'] }));
  b.append(ctx.list(P('kitNotes')));
  b.append(h3(`Новые вещи гира (${r.newGear.length})`));
  b.append(muted('Таких предметов ещё нет в гире монстров (`monster-gear`); в тексте карточек они со звёздочкой.', 'margin-bottom:2px'));
  b.append(table(['id', 'Вещь', 'Что это', 'Кому'], r.newGear.map((g) => [
    mono(g.id, `color:${C.text}`), T(ctx, P(`newGear/${g.id}/name`)), T(ctx, P(`newGear/${g.id}/spec`)), T(ctx, P(`newGear/${g.id}/for`)),
  ]), { widths: ['150px', '150px'] }));
}

function statusesBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2, idx: RosterIndex): void {
  const st = r.rules.statuses;
  b.append(kv('Родной', statusChip(r, st.native.status, st.native.mult)), kv('Второй', statusChip(r, st.second.status, st.second.mult)),
    kv('Чужие', `${fmtMult(st.foreign.mult)}: ${st.foreign.list.join(', ')}`));
  const sc = r.statusCount;
  const cols = [...new Set([...Object.keys(sc.cards), ...Object.keys(sc.cardsWithoutNewGear), ...Object.keys(sc.specials), ...Object.keys(sc.packs)])]
    .sort((x, y) => (sc.cards[y] ?? 0) - (sc.cards[x] ?? 0));
  const row = (label: string, m: Record<string, number>): Cell[] => [label, ...cols.map((c) => (m[c] ? String(m[c]) : '—'))];
  b.append(h3('Счёт статусов'));
  b.append(table(['', ...cols], [row('по карточкам ярусов', sc.cards), row('без новых вещей гира', sc.cardsWithoutNewGear), row('у особых', sc.specials), row('в пачках', sc.packs)], { widths: ['170px'] }));
  b.append(muted(`В пачках: ближних ${sc.packsMeleeRanged.melee}, стрелков ${sc.packsMeleeRanged.ranged}, поддержки ${sc.packsMeleeRanged.support}. Главный статус — самый частый по составу, а не единственный (решение владельца 16.10).`, 'margin:-4px 0 6px'));
  if (idx.statuses.rows.some((x) => x.subtype === r.id)) {
    b.append(kv('Броня-ответ', T(ctx, I(`statuses/rows/${r.id}/armor`))), kv('Лестница разложения', T(ctx, I(`statuses/rows/${r.id}/ladder`))));
  }
  b.append(T(ctx, I('statuses/note'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));
  b.append(h3('Стойкость по ярусу (одна на все подтипы)'));
  b.append(table(['Ярус', 'Множители урона по монстру', 'Что значит'], TIER_IDS.map((t) => [
    el('b', `color:${C.text}`, `${TIER_TITLE[t]} (${TIER_POWER[t]})`), resistText(idx.tierResistMult[t]),
    idx.tierResist.rows.some((x) => x.id === t) ? T(ctx, I(`tierResist/rows/${t}/meaning`)) : '—',
  ]), { widths: ['140px', '40%'] }));
  if (hasField(ctx, V(r.id, 'rules/tierResist/note'))) b.append(T(ctx, V(r.id, 'rules/tierResist/note'), { tag: 'div' }));
}

function bankBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2): void {
  const P = (p: string): string => V(r.id, `ideaBank/${p}`);
  b.append(T(ctx, P('note'), { tag: 'div' }));
  b.append(h3(`Варианты боссов (${r.ideaBank.bosses.length})`));
  for (const x of r.ideaBank.bosses) {
    const BP = (f: string): string => P(`bosses/${x.id}/${f}`);
    const box = el('div', `border:1px solid ${C.edgeSoft};border-radius:8px;padding:8px 10px;margin:0 0 8px;background:${C.bg}`);
    const head = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
    head.append(T(ctx, BP('name'), { css: `font-weight:700;color:${C.text}` }), chip(`вариант ${x.key}`, C.faint), T(ctx, BP('origin'), { css: `font-size:12px;color:${C.dim}` }));
    box.append(head);
    box.append(h3('Облик'), ctx.list(BP('look'), { css: 'font-size:12px' }));
    box.append(kv('Чем отличается', T(ctx, BP('differs'))));
    box.append(h3('Бой'), ctx.list(BP('fight'), { ordered: true, css: 'font-size:12px' }));
    box.append(kv('Без кода', T(ctx, BP('mvp'))), kv('За', T(ctx, BP('pro'))), kv('Против', T(ctx, BP('con'))), kv('Прототип (скрыто)', T(ctx, BP('prototype'))));
    b.append(box);
  }
  b.append(h3(`Идеи (${r.ideaBank.ideas.length})`));
  b.append(table(['Идея', 'Откуда', 'Что', 'Почему в банке', 'Что нужно'], r.ideaBank.ideas.map((x) => {
    const XP = (f: string): string => P(`ideas/${x.id}/${f}`);
    return [T(ctx, XP('name'), { css: `font-weight:600;color:${C.text}` }), T(ctx, XP('origin')), T(ctx, XP('what')), T(ctx, XP('why')), T(ctx, XP('needs'))];
  }), { widths: ['170px', '130px', '34%'] }));
}

// ── Страница карточки ────────────────────────────────────────────────────────────────────────────

const KIND_LABEL = (e: RosterEntry): string =>
  e.kind === 'card' ? 'боец яруса' : e.kind === 'boss' ? `босс ${e.boss.floor} · ${BOSS_LABEL[e.boss.floor] ?? ''}` : `особый, ${e.special.wave}-я волна`;

export function renderRosterCard(host: HTMLElement, ctx: ArtbookCtx, s: Subtype, id: string): void {
  const back = btn(`← ${s.name}`, () => ctx.go('sub:' + s.id));
  const r = ctx.roster(s.id), idx = ctx.rosterIndex();
  if (!r || !idx) { host.append(navBar(ctx, back), pending(ctx, [s.id, 'index'])); return; }
  const e = rosterEntry(r, id);
  if (!e) {
    host.append(navBar(ctx, back), muted(`В ростере подтипа «${s.name}» нет карточки «${id}» — её могли переименовать или убрать из сида.`, 'margin-top:8px'));
    return;
  }
  const E = (f: string): string => V(s.id, `${e.path}/${f}`);

  // Соседи: бойцы того же яруса, прочие боссы, прочие особые.
  const sibs = rosterEntries(r).filter((x) => x.id !== e.id && x.kind === e.kind && (e.kind !== 'card' || x.tier === e.tier));
  const sw = el('span', 'display:flex;gap:4px;align-items:center;flex-wrap:wrap');
  if (sibs.length) {
    sw.append(el('span', `font-size:12px;color:${C.faint};margin-left:6px`, e.kind === 'card' ? `${TIER_RU[e.tier]} ярус:` : e.kind === 'boss' ? 'боссы:' : 'особые:'));
    for (const x of sibs) sw.append(btn(fieldValue(ctx, V(s.id, `${x.path}/name`)), () => ctx.go(`card:${s.id}:${x.id}`), 'padding:2px 8px;font-size:11.5px'));
  }
  host.append(navBar(ctx, back, sw));

  const title = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
  title.append(ctx.text(E('name'), { tag: 'span', single: true, plain: true, css: `font-size:18px;font-weight:700;color:${C.text}` }));
  title.append(chip(KIND_LABEL(e), e.kind === 'card' ? C.dim : C.gold), chip(tierOfEntry(e), C.dim), chip(combatOfEntry(idx, e), C.accent));
  const armor = e.kind === 'card' ? e.card.armorClass : e.kind === 'boss' ? e.boss.armorClass : e.special.armorClass;
  title.append(chip(ARMOR_RU[armor] ?? armor, C.faint, 'класс брони игры'), chip(s.name, C.dim));
  host.append(title);
  host.append(kv('Прототип (скрыто от игрока)', T(ctx, E('prototype')), 'margin-top:2px'));

  const cols = el('div', 'display:grid;grid-template-columns:minmax(320px,1.1fr) minmax(300px,1fr);gap:14px;align-items:start;margin-top:8px');
  const left = el('div', 'min-width:0'), right = el('div', 'min-width:0');
  cols.append(left, right);
  host.append(cols);
  left.append(ctx.slots(['v2', s.id, e.id], SLOT_SETS.card));

  if (e.kind === 'card') {
    const c = e.card, w = c.weapon;
    right.append(kv('Роль', T(ctx, E('role'))), kv('Роль движка', mono(c.engineRole, `color:${C.text}`)), kv('Вес / скорость', `${c.weight} / ${c.speed}`));
    right.append(h3('Броня'), ctx.text(E('armor')), kv('Класс брони', ARMOR_RU[c.armorClass] ?? c.armorClass));
    right.append(h3('Шлем'), ctx.text(E('helm')), h3('Щит'), ctx.text(E('shield')));
    right.append(h3('Оружие'), ctx.text(E('weapon/text')));
    right.append(kv('Хват', w.hands === 2 ? 'двуручное' : 'одноручное'), kv('Статус удара', statusChip(r, w.statusName, w.mult)), kv('Вещь гира', mono(w.gear, `color:${C.text}`)));
    if (w.gear.endsWith('*')) right.append(dim('звёздочка — такого предмета в гире монстров ещё нет (новая вещь)', 'margin:-2px 0 4px'));
    if (w.fallback) right.append(kv('Пока вещи нет', T(ctx, E('weapon/fallback'))));
    if (w.fallbackStatus) right.append(kv('Статус замены', T(ctx, E('weapon/fallbackStatus'))));
    if (w.view) right.append(kv('Вид оружия', T(ctx, E('weapon/view'))));
    right.append(h3('Приём'), ctx.text(E('move')), h3('Силуэт сверху'), ctx.text(E('silhouette')));
    const tp = (f: string): string => V(s.id, `tiers/${e.tier}/${f}`);
    right.append(h3(`${TIER_TITLE[e.tier]} ярус`), kv('Пласт', T(ctx, tp('era'))), kv('Руки и ноги', T(ctx, tp('limbs'))), kv('Стойкость яруса', resistText(idx.tierResistMult[e.tier])));
  } else if (e.kind === 'boss') {
    const bo = e.boss;
    if (hasField(ctx, E('title'))) right.append(kv('Подпись', T(ctx, E('title'))));
    if (hasField(ctx, E('style'))) right.append(kv('Как с ним биться', T(ctx, E('style'))));
    if (idx.bosses.short[bo.id]) right.append(kv('Бой коротко', T(ctx, I(`bosses/short/${bo.id}/short`))));
    right.append(h3('Облик'), ctx.list(E('look')));
    right.append(h3('Зал и свита'), ctx.text(E('hall')), h3('Чем отличается'), ctx.text(E('differs')));
    right.append(h3('Бой по фазам'), ctx.list(E('fight'), { ordered: true }));
    right.append(h3('Базовая версия без кода'), ctx.text(E('mvp')));
  } else {
    const sp = e.special;
    right.append(kv('Волна', `${sp.wave}-я`), kv('Вес / скорость', `${sp.weight} / ${sp.speed}`),
      kv('Статус удара', sp.status ? statusChip(r, STATUS_RU[sp.status] ?? sp.status) : 'без удара'));
    if (sp.engineRole) right.append(kv('Роль движка', mono(sp.engineRole, `color:${C.text}`)));
    if (hasField(ctx, E('tierNote'))) right.append(kv('Заметка', T(ctx, E('tierNote'))));
    if (idx.specials.short[sp.id] !== undefined) right.append(kv('Коротко', T(ctx, I(`specials/short/${sp.id}`))));
    right.append(h3('Облик'), ctx.text(E('look')), h3('Механика'), ctx.text(E('mechanic')), h3('Телеграф'), ctx.text(E('telegraph')), h3('Контригра'), ctx.text(E('counter')));
  }
  right.append(h3('Механика держится на'), mechChips(entryMech(e, ctx.view.crypt.engine.codes)));
  right.append(dim('есть — работает сейчас; легко — данные, новые вещи гира и коды ценой «мелко»; на будущее — коды ценой «средне» и «крупно» («Рычаги движка» Некрополя). Код сейчас не пишем.', 'margin-top:4px'));

  if (e.kind !== 'boss') {
    const inPacks = r.packs.filter((p) => [...p.members, ...p.optional].some((m) => m.id === e.id));
    host.append(section(`В пачках (${inPacks.length})`, `v2card:packs`, (b) => {
      if (!inPacks.length) { b.append(muted(e.kind === 'special' ? 'В пачки подтипа не расписан (особый — не больше одного на пачку).' : 'В пачках подтипа не встречается.')); return; }
      b.append(table(['Пачка', 'Этажи', 'Сколько', 'Что проверяет'], inPacks.map((p) => {
        const m = [...p.members, ...p.optional].find((x) => x.id === e.id)!;
        return [T(ctx, V(s.id, `packs/${p.id}/name`), { css: `font-weight:600;color:${C.text}` }), p.floors, `${m.count}${p.optional.includes(m) ? ' (по желанию)' : ''}`, T(ctx, V(s.id, `packs/${p.id}/checks`))];
      }), { widths: ['160px', '70px', '90px'] }));
    }, { open: true }));
  }
  host.append(section('Живые числа', `v2card:numbers`, (b) => liveStub(b, ctx, s, e), { open: true }));
}

function liveStub(body: HTMLElement, ctx: ArtbookCtx, s: Subtype, e: RosterEntry): void {
  const box = el('div', `padding:10px 12px;border:1.5px dashed ${C.edge};border-radius:8px;color:${C.dim};font-size:12.5px;line-height:1.5`);
  box.append(el('div', `color:${C.faint};font-style:italic;font-size:13px`, 'Ещё нет в конфиге: делаем заново.'));
  const power = e.kind === 'card' ? TIER_POWER[e.tier] : e.kind === 'boss' ? 'boss' : e.special.powerTier;
  box.append(el('div', '', `Нынешние 19 зомби конфига — тестовые (решение владельца 17.10): на них не опираемся, карточки ростера по ярусам заводим заново. Эта встанет монстром подтипа «${s.name}» с тиром ${power}; числа появятся здесь тем же кодом, что игра, когда монстр будет в конфиге.`));
  if (e.kind === 'card') {
    const w = e.card.weapon;
    box.append(el('div', '', `Гир: оружие ${w.gear}${w.fallback ? ` (пока вещи нет — ${w.fallback.replace(/`/g, '')})` : ''}, броня — ${ARMOR_RU[e.card.armorClass] ?? e.card.armorClass}; вес ${e.card.weight}, скорость ${e.card.speed}.`));
  } else if (e.kind === 'boss') box.append(el('div', '', fieldValue(ctx, V(s.id, `${e.path}/mvp`))));
  const add = btn('＋ Завести монстра', () => { /* заглушка: строки конфига заводим отдельной задачей */ }, 'margin-top:6px;opacity:.6;cursor:not-allowed');
  add.title = 'появится позже: заводить строки конфига («Игра → Монстры») будем отдельно — код сейчас не пишем';
  box.append(add);
  body.append(box);
}

// ── «Ярусы × подтипы» ────────────────────────────────────────────────────────────────────────────

export function renderTierMatrix(host: HTMLElement, ctx: ArtbookCtx): void {
  const top = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap');
  top.append(btn('← все подтипы', () => ctx.go('')), btn('☰ Ростер и очерёдность', () => ctx.go('roster'), `color:${C.dim}`), btn('▦ Архив: «архетип × подтип»', () => ctx.go('matrix'), `color:${C.faint}`));
  host.append(top);
  host.append(h2('Ярусы × подтипы'));
  const all = allRosters(ctx);
  if (!all) { host.append(pending(ctx, [...ctx.view.crypt.subtypes.map((s) => s.id), 'index'])); return; }
  const { idx, R, order } = all;
  host.append(T(ctx, I('matrix/intro'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));
  host.append(muted('Клик по имени — страница карточки (концепты и все поля); ✓ — главный концепт утверждён.', 'margin:2px 0 4px'));

  const head = ['Ярус', ...order.map((id) => { const s = subOf(ctx, id); return `${s?.name ?? id} (№${s?.ownerNo ?? '?'})`; })];
  const rows: Cell[][] = [];
  const cardsOf = (id: string, t: TierId, combat?: string): RosterEntry[] =>
    rosterEntries(R.get(id)!).filter((e) => e.kind === 'card' && e.tier === t && (!combat || e.card.combat === combat));
  for (const t of TIER_IDS) {
    const lbl = el('div', '');
    lbl.append(el('b', `color:${C.text}`, TIER_TITLE[t]), ` (${TIER_POWER[t]}) · пласт`);
    rows.push([lbl, ...order.map((id): Cell => (R.get(id)!.tiers.some((x) => x.id === t) ? T(ctx, V(id, `tiers/${t}/era`)) : '—'))]);
    for (const [combat, word] of [['melee', 'ближний бой'], ['ranged', 'стрелки']] as const) {
      const n = Math.max(...order.map((id) => cardsOf(id, t, combat).length));
      rows.push([`${TIER_TITLE[t]} · ${word} (${n})`, ...order.map((id) => links(ctx, id, cardsOf(id, t, combat)))]);
    }
    rows.push([`${TIER_TITLE[t]} · броня (карточек)`, ...order.map((id) => { const tr = R.get(id)!.tiers.find((x) => x.id === t); return tr ? armorMix(tr.cards) : '—'; })]);
  }
  rows.push([el('b', `color:${C.text}`, 'Боссы 5 · 14 · 19'), ...order.map((id) => {
    const box = el('div', 'display:flex;flex-direction:column;gap:3px');
    for (const e of rosterEntries(R.get(id)!)) if (e.kind === 'boss') { const l = el('div', ''); l.append(el('span', `color:${C.gold}`, `${e.boss.floor} · `), nameLink(ctx, id, e)); box.append(l); }
    return box;
  })]);
  rows.push(['Особые (1-я волна, затем 2-я)', ...order.map((id) => links(ctx, id, rosterEntries(R.get(id)!).filter((e) => e.kind === 'special')))]);
  host.append(table(head, rows, { widths: ['150px'] }));
  host.append(T(ctx, I('matrix/armorNote'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));
  host.append(T(ctx, I('countsNote'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));

  host.append(section(fieldValue(ctx, I('title')) || 'Как читать', 'mon:tiers:howto', (b) => {
    b.append(T(ctx, I('intro'), { tag: 'div' }));
    for (const x of idx.howTo) b.append(kv(x.title, T(ctx, I(`howTo/${x.id}/text`))));
    b.append(T(ctx, I('archiveNote'), { tag: 'div', css: `font-size:12px;color:${C.faint}` }));
  }));
  host.append(section('Переход ярусов по кругу', 'mon:tiers:circle', (b) => {
    b.append(T(ctx, I('transition/intro'), { tag: 'div' }));
    b.append(table(['Этажи', 'Лёгкий', 'Средний', 'Тяжёлый', 'Боссы и порталы'], idx.transition.bands.map((x) => [el('b', `color:${C.text}`, x.floors), `${x.light} %`, `${x.medium} %`, `${x.heavy} %`, T(ctx, I(`transition/bands/${x.id}/bosses`))]), { widths: ['60px', '70px', '70px', '70px'] }));
    b.append(ctx.list(I('transition/notes')));
  }));
  host.append(section('Стойкость по ярусу', 'mon:tiers:resist', (b) => {
    b.append(T(ctx, I('tierResist/intro'), { tag: 'div' }));
    b.append(table(['Ярус', 'Множители', 'Что значит'], idx.tierResist.rows.map((x) => [T(ctx, I(`tierResist/rows/${x.id}/name`), { css: `font-weight:600;color:${C.text}` }), resistText(idx.tierResistMult[x.id]), T(ctx, I(`tierResist/rows/${x.id}/meaning`))]), { widths: ['150px', '40%'] }));
    b.append(T(ctx, I('tierResist/note'), { tag: 'div' }));
  }));
  host.append(section('Боссы: типы боя', 'mon:tiers:bosses', (b) => {
    b.append(T(ctx, I('bosses/intro'), { tag: 'div' }));
    b.append(table(['Тип боя', 'Где'], idx.bosses.types.map((x) => [T(ctx, I(`bosses/types/${x.id}/type`)), T(ctx, I(`bosses/types/${x.id}/where`))]), { widths: ['45%'] }));
    b.append(T(ctx, I('bosses/note'), { tag: 'div' }));
  }));
  host.append(section('Особые по подтипам', 'mon:tiers:specials', (b) => {
    b.append(table(['Подтип', 'Колорит'], order.map((id) => [subOf(ctx, id)?.name ?? id, idx.specials.flavor[id] !== undefined ? T(ctx, I(`specials/flavor/${id}`)) : '—']), { widths: ['180px'] }));
    b.append(T(ctx, I('specials/note'), { tag: 'div' }));
  }));
  host.append(section('Открыто после сверки (17.10)', 'mon:tiers:open', (b) => {
    b.append(T(ctx, I('openAfterCheck/intro'), { tag: 'div' }));
    for (const x of idx.openAfterCheck.items) b.append(kv(x.title, T(ctx, I(`openAfterCheck/items/${x.id}/text`))));
  }));
}

// ── «Ростер и очерёдность» ───────────────────────────────────────────────────────────────────────

export function renderRosterView(host: HTMLElement, ctx: ArtbookCtx): void {
  const top = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap');
  top.append(btn('← все подтипы', () => ctx.go('')), btn('▦ Ярусы × подтипы', () => ctx.go('tiers'), `color:${C.dim}`));
  host.append(top);
  host.append(h2('Ростер и очерёдность'));
  const all = allRosters(ctx);
  if (!all) { host.append(pending(ctx, [...ctx.view.crypt.subtypes.map((s) => s.id), 'index'])); return; }
  const { idx, R } = all;
  const queues = idx.roster.queues;
  host.append(T(ctx, I('roster/intro'), { tag: 'div' }));
  const ul = el('ul', 'margin:2px 0 8px;padding-left:20px');
  for (const q of queues) {
    const li = el('li', `margin:3px 0;color:${C.soft}`);
    li.append(el('b', `color:${C.text}`, q.label), ' — ', T(ctx, I(`roster/queues/${q.id}/text`)));
    ul.append(li);
  }
  host.append(ul);
  host.append(T(ctx, I('roster/orderNote'), { tag: 'div' }));
  host.append(T(ctx, I('roster/mechNote'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));

  const prod = idx.roster.productionOrder.filter((id) => R.has(id));
  const label = (id: string, first: boolean): string => { const s = subOf(ctx, id); return `${s?.name ?? id} (${protoOf(ctx, id)}, №${s?.ownerNo ?? '?'})${first ? ' — первый' : ''}`; };
  const counts = prod.map((id) => queueCounts(R.get(id)!, queues));
  const rows: Cell[][] = prod.map((id, i) => [el('b', `color:${C.text}`, label(id, i === 0)), ...queues.map((q) => queueCell(counts[i]!, q)), String(counts[i]!.inWork)]);
  rows.push([el('b', `color:${C.text}`, 'Итого'), ...queues.map((q) => el('b', `color:${C.text}`, queueTotalCell(counts, q))), el('b', `color:${C.gold}`, String(counts.reduce((n, c) => n + c.inWork, 0)))]);
  host.append(h3('Счёты по подтипам (порядок производства — Европа первой)'));
  host.append(table(['Подтип', ...queues.map((q) => q.label), 'Всего в работе (1–3)'], rows, { widths: ['240px'], onRow: (i) => { if (prod[i]) ctx.go('sub:' + prod[i]); } }));
  host.append(T(ctx, I('roster/countsNote'), { tag: 'div', css: `font-size:12.5px;color:${C.dim}` }));

  prod.forEach((id, i) => {
    const r = R.get(id)!;
    host.append(section(`${label(id, false)}${i === 0 ? ' — с неё начинаем' : ''}`, `mon:roster:${id}`, (b) => rosterSubBlock(b, ctx, r, idx), { open: i === 0, note: `в работе ${counts[i]!.inWork}` }));
  });
}

function rosterSubBlock(b: HTMLElement, ctx: ArtbookCtx, r: RosterV2, idx: RosterIndex): void {
  const st = r.rules.statuses;
  const head = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px');
  head.append(muted(`Родной статус — ${st.native.status} ${fmtMult(st.native.mult)}, второй — ${st.second.status} ${fmtMult(st.second.mult)}, чужие ${fmtMult(st.foreign.mult)}. Карточки целиком, пачки (${r.packs.length}), комплект моделей и новые вещи гира (${r.newGear.length}) — на странице подтипа.`),
    btn('открыть подтип →', () => ctx.go('sub:' + r.id), 'padding:2px 8px;font-size:11.5px'));
  b.append(head);
  const queues = idx.roster.queues;
  const qLabel = new Map(queues.map((q) => [q.id, q.label]));
  const bank = new Set(queues.filter((q) => q.bank).map((q) => q.id));
  const rows = rosterQueue(r, queues).filter((x) => !bank.has(x.queue)).map((x) => ({ x, e: rosterEntry(r, x.id)! })).filter((y) => y.e);
  const codes = ctx.view.crypt.engine.codes;
  b.append(table(['Очередь', 'Карточка', 'Ярус', 'Бой', 'Роль', 'Механика держится на'], rows.map(({ x, e }): Cell[] => {
    const nm = fieldValue(ctx, V(r.id, `${e.path}/name`));
    const name = e.kind === 'card' ? el('b', `color:${C.text}`, nm) : e.kind === 'boss' ? el('b', `color:${C.gold}`, `Босс ${e.boss.floor} «${nm}»`) : el('b', `color:${C.text}`, `${nm} (особый, ${e.special.wave}-я волна)`);
    const role = e.kind === 'card' ? RO(ctx, V(r.id, `${e.path}/role`))
      : e.kind === 'boss' ? (idx.bosses.short[e.id] ? RO(ctx, I(`bosses/short/${e.id}/short`)) : '—')
        : (idx.specials.short[e.id] !== undefined ? RO(ctx, I(`specials/short/${e.id}`)) : RO(ctx, V(r.id, `${e.path}/mechanic`)));
    return [qLabel.get(x.queue) ?? x.queue, name, tierOfEntry(e), combatOfEntry(idx, e), role, mechChips(entryMech(e, codes))];
  }), { widths: ['90px', '190px', '130px', '80px'], onRow: (i) => ctx.go(`card:${r.id}:${rows[i]!.e.id}`) }));
  const bb = r.ideaBank.bosses, ni = r.ideaBank.ideas.length, oq = r.openQuestions.length;
  b.append(muted(`Р · банк идей: ${bb.length} вар. босса (${bb.map((x) => `«${x.name}»`).join(', ')}) и ${ni} идей — раздел «Банк идей» на странице подтипа. По подтипу ${oq ? `открытых вопросов — ${oq}` : 'открытых вопросов нет'}.`, 'margin-top:-4px'));
}
