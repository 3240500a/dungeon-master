/**
 * ⭐ 16.10 (Артбук): подвкладка «💀 Монстры» — ТОЧКА ВХОДА. Подтипы нежити крипты из черновика (карточки), страница подтипа и
 * карточка архетипа (`monsterPages.ts`), сводная матрица «архетип × подтип». Числа — тем же кодом, что игра (`monsterNumbers.ts`).
 *
 * ⭐ 17.10: шесть подтипов (Двор Тростника и Дом Праха — два, решение 16.10) и РОСТЕРЫ ПО ЯРУСАМ (`rosterPages.ts`): страница
 * карточки `card:<подтип>:<id>` (боец яруса, босс, особый), виды «Ярусы × подтипы» (`tiers`) и «Ростер и очерёдность» (`roster`).
 * Архетипы по ролям и матрица `matrix` — архив прежней раскладки (до 17.10).
 *
 * Маршруты: `''` — подтипы, `sub:<подтип>`, `card:<подтип>:<карточка>`, `tiers`, `roster`, `arch:<архетип>:<подтип>`, `matrix`.
 * Неизвестный маршрут (подтип убрали из сида) — список подтипов.
 */
import type { ArtbookCtx } from './ctx.js';
import { coverOf, slotImages, slotKey } from './model.js';
import { monstersOfSubtype, type MonsterLite } from './monsterNumbers.js';
import { decayBadge, renderArchetype, renderSubtype } from './monsterPages.js';
import { fmtMult, plural } from './roster.js';
import { navBar, renderRosterCard, renderRosterView, renderTierMatrix, v2ConceptsApproved } from './rosterPages.js';
import type { Subtype } from './seed.js';
import { C, btn, chip, el, h2, muted, section, table, type Cell } from './ui.js';

const LS_BARE = 'artbook_mon_bare';
let bareOnly = (() => { try { return localStorage.getItem(LS_BARE) === '1'; } catch { return false; } })();

const monstersRaw = (ctx: ArtbookCtx): MonsterLite[] => (Array.isArray(ctx.data.monsters) ? ctx.data.monsters as MonsterLite[] : []);
/** Подтипы в порядке владельца (№ 1 — Греция … № 5 — Двор Тростника, № 6 — Дом Праха). */
const ordered = (ctx: ArtbookCtx): Subtype[] => [...ctx.view.crypt.subtypes].sort((a, b) => a.ownerNo - b.ownerNo);
const conceptKey = (archId: string, subId: string): string => slotKey('arch', archId, subId, 'concept');

export function renderMonsters(host: HTMLElement, ctx: ArtbookCtx): void {
  const d = ctx.view.crypt;
  const [kind, a, b] = ctx.route.split(':');
  const sub = (id: string | undefined): Subtype | undefined => (id ? d.subtypes.find((s) => s.id === id) : undefined);
  if (kind === 'sub' && sub(a)) return renderSubtype(host, ctx, a!);
  if (kind === 'card' && sub(a) && b) return renderRosterCard(host, ctx, sub(a)!, b);
  if (kind === 'tiers') return renderTierMatrix(host, ctx);
  if (kind === 'roster') return renderRosterView(host, ctx);
  if (kind === 'arch' && a && b && d.archetypes.some((x) => x.id === a && x.subtypes.includes(b)) && sub(b)) return renderArchetype(host, ctx, a, b);
  if (kind === 'matrix') return renderMatrix(host, ctx);
  renderList(host, ctx);
}

function renderList(host: HTMLElement, ctx: ArtbookCtx): void {
  const d = ctx.view.crypt;
  const head = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
  head.append(h2('Монстры'), navBar(ctx));
  host.append(head);
  host.append(muted('Нежить крипты — шесть подтипов, народов мертвецов Некрополя (Двор Тростника и Дом Праха делят архаичную эпоху). У каждого — три яруса снаряжения (лёгкий, средний, тяжёлый; ярус = тир силы), на ярусе 3 бойца ближнего боя и 2 стрелка, три босса (5-й, 14-й и 19-й этаж круга) и 4–6 особых. Подтип выпадает на отрезок до вейпоинта, печать его форсит. Нажми на подтип: концепты, ярусы и карточки, текст.', 'max-width:900px;line-height:1.5;margin-bottom:10px'));

  const subIds = d.subtypes.map((s) => s.id);
  const mons = monstersRaw(ctx);
  const idx = ctx.rosterIndex();
  // ⭐ 23.10: заглавная картинка подтипа (групповой арт, широкий кадр) — крупно сверху карточки, текст под ней.
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px');
  for (const s of ordered(ctx)) {
    const sum = idx?.subtypes.find((x) => x.id === s.id);
    const inCfg = monstersOfSubtype(mons, subIds, s.id).length;
    const approved = v2ConceptsApproved(ctx, s.id);

    const card = el('div', `display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid ${C.edge};border-radius:8px;background:${C.bg};cursor:pointer`);
    card.addEventListener('click', () => ctx.go('sub:' + s.id));
    card.addEventListener('mouseenter', () => { card.style.borderColor = C.active; });
    card.addEventListener('mouseleave', () => { card.style.borderColor = C.edge; });
    card.append(ctx.thumb(slotKey('sub', s.id, 'concept'), { w: 400, h: 225, empty: 'нет заглавной картинки' }));
    const info = el('div', 'min-width:0;flex:1');
    info.append(el('div', `font-weight:700;font-size:14.5px;color:${C.text}`, s.name));
    const tags = el('div', 'display:flex;gap:4px;flex-wrap:wrap;margin:3px 0 5px');
    tags.append(chip(`№ ${s.ownerNo}`, C.dim));
    const db = decayBadge(ctx, s.id);
    if (db) tags.append(db);
    tags.append(chip(s.eraText.length > 34 ? s.eraText.slice(0, 32) + '…' : s.eraText, C.faint, s.eraText));
    if (sum) tags.append(chip(`${sum.native.status} ${fmtMult(sum.native.mult)}`, C.gold, 'родной статус подтипа — самый частый по составу'));
    info.append(tags);
    info.append(ctx.text(`crypt/subtypes/${s.id}/short`, { readonly: true, css: 'font-size:12px;margin:0 0 5px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden' }));
    const facts = el('div', `font-size:11.5px;color:${C.dim};display:flex;gap:4px 10px;flex-wrap:wrap`);
    if (sum) {
      const total = sum.counts.cards + sum.counts.bosses + sum.counts.specials;
      facts.append(
        el('span', '', `ярусы: ${sum.counts.cards} карточек · ${sum.counts.bosses} ${plural(sum.counts.bosses, 'босс', 'босса', 'боссов')} · ${sum.counts.specials} ${plural(sum.counts.specials, 'особый', 'особых', 'особых')}`),
        el('span', `color:${approved ? C.ok : C.faint}`, `концептов ${approved}/${total}`),
      );
    } else facts.append(el('span', `color:${C.faint}`, ctx.rosterError('index') ? '⚠ ростер не загрузился' : 'ростер загружается…'));
    const cfg = el('span', `color:${inCfg ? C.ok : C.faint}`, inCfg ? `в конфиге ${inCfg} монстр.` : 'в конфиге пока нет');
    if (inCfg) cfg.title = 'нынешние монстры конфига — тестовые (решение владельца 17.10): карточки ярусов делаем заново';
    facts.append(cfg);
    info.append(facts);
    card.append(info);
    grid.append(card);
  }
  host.append(grid);
}

// ── Матрица «архетип × подтип» (архив прежней раскладки по ролям, до 17.10) ───────────────────────

function renderMatrix(host: HTMLElement, ctx: ArtbookCtx): void {
  const d = ctx.view.crypt;
  const m = d.matrix;
  const cols = m.columns;
  const has = (archId: string, subId: string): boolean => !!coverOf(slotImages(ctx.doc(), conceptKey(archId, subId)));

  const top = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap');
  top.append(btn('← все подтипы', () => ctx.go('')), btn('▦ Ярусы × подтипы', () => ctx.go('tiers'), `color:${C.dim}`));
  const lbl = el('label', `display:flex;gap:5px;align-items:center;color:${C.dim};font-size:12.5px;cursor:pointer;user-select:none`);
  const box = el('input'); box.type = 'checkbox'; box.checked = bareOnly;
  box.addEventListener('change', () => { bareOnly = box.checked; try { localStorage.setItem(LS_BARE, bareOnly ? '1' : '0'); } catch { /* */ } ctx.rerender(); });
  lbl.append(box, document.createTextNode('только без концепта'));
  top.append(lbl);
  host.append(top);
  host.append(h2('Архив: матрица «архетип × подтип»'));
  host.append(ctx.text('crypt/archiveNote', { css: `font-size:12.5px;color:${C.dim};max-width:900px` }));

  // Сводка: сколько ячеек с утверждённым концептом.
  const cells: [string, string][] = [];
  for (const r of m.common) for (const c of cols) if (r.cells[c.id] !== undefined) cells.push([r.id, c.id]);
  for (const c of cols) for (const u of m.uniqueBySubtype[c.id] ?? []) cells.push([u.id, c.id]);
  const done = cells.filter(([a, s]) => has(a, s)).length;
  host.append(muted(`Концепт утверждён в ${done} из ${cells.length} ячеек. Миниатюра — утверждённый главный концепт архетипа в подтипе, пунктир — концепта нет (или он черновик). Клик по ячейке — карточка архетипа.`, 'margin-bottom:8px;max-width:900px;line-height:1.5'));

  const cell = (archId: string, subId: string, path: string): HTMLElement => {
    const c = el('div', 'display:flex;gap:6px;align-items:center;cursor:pointer;min-width:0');
    c.append(ctx.thumb(conceptKey(archId, subId), { w: 48, h: 48, empty: 'нет' }));
    c.append(ctx.text(path, { tag: 'span', readonly: true, css: `font-size:12px;color:${C.text};line-height:1.3` }));
    c.addEventListener('click', () => ctx.go(`arch:${archId}:${subId}`));
    return c;
  };
  const head = ['Архетип', ...cols.map((c) => `${c.name} · №${c.ownerNo}`)];

  host.append(el('div', `font-weight:600;color:${C.text};font-size:14px;margin:6px 0 2px`, 'Общие архетипы'));
  const rowsC = m.common.filter((r) => !bareOnly || cols.some((c) => r.cells[c.id] !== undefined && !has(r.id, c.id)));
  host.append(table(head, rowsC.map((r) => {
    const name = el('div', '');
    name.append(el('b', `color:${C.text}`, r.name), el('div', `font-size:11px;color:${C.faint};line-height:1.3`, r.role));
    return [name, ...cols.map((c): Cell => (r.cells[c.id] === undefined ? '—' : bareOnly && has(r.id, c.id) ? el('span', `color:${C.ok}`, '✓ есть') : cell(r.id, c.id, `crypt/matrix/common/${r.id}/cells/${c.id}`)))];
  }), { widths: ['150px'] }));
  if (!rowsC.length) host.append(muted('У всех общих архетипов концепт уже есть.', 'margin:-4px 0 8px'));

  host.append(el('div', `font-weight:600;color:${C.text};font-size:14px;margin:10px 0 2px`, 'Особые архетипы подтипа'));
  const uniqRow: Cell[] = ['', ...cols.map((c): Cell => {
    const list = (m.uniqueBySubtype[c.id] ?? []).filter((u) => !bareOnly || !has(u.id, c.id));
    if (!list.length) return '—';
    const box2 = el('div', 'display:flex;flex-direction:column;gap:5px');
    for (const u of list) {
      const a = d.archetypes.find((x) => x.id === u.id);
      box2.append(a?.perSubtype[c.id] ? cell(u.id, c.id, `crypt/archetypes/${u.id}/perSubtype/${c.id}/name`) : el('span', `color:${C.faint}`, u.name));
    }
    return box2;
  })];
  host.append(table(head, [uniqRow], { widths: ['150px'] }));
  host.append(table(['', ...cols.map((c) => c.name)], [['Всего', ...cols.map((c) => { const k = m.counts[c.id]; return k ? `${k.common} общих + ${k.unique} особых = ${k.total}` : '—'; })]], { widths: ['150px'] }));

  host.append(section('Черты подтипов', 'mon:matrix:traits', (b) => {
    b.append(table(['', ...cols.map((c) => c.name)], m.traits.map((t, i) => [el('b', `color:${C.text}`, t.row), ...cols.map((c): Cell => (t.cells[c.id] !== undefined ? ctx.text(`crypt/matrix/traits/${i}/cells/${c.id}`, { tag: 'span' }) : '—'))]), { widths: ['150px'] }));
  }));
  host.append(section('Покрытие канона ролей', 'mon:matrix:canon', (b) => {
    b.append(muted('Номер канона — из списка ролей черновика; в ячейке — кто из особых архетипов подтипа закрывает роль.', 'margin-bottom:4px'));
    b.append(table(['№', 'Роль', ...cols.map((c) => c.name)], m.canonCoverage.map((r) => [String(r.canon), r.role, ...cols.map((c): Cell => (r.cells[c.id]?.length ? r.cells[c.id]!.join(', ') : el('span', `color:${C.faint}`, '—')))]), { widths: ['36px', '150px'] }));
  }));
}
