/**
 * ⭐ 16.10 (Артбук): страницы «💀 Монстров» — ПОДТИП (концепты, текст разделами, переключатели и таблица архетипов с живыми
 * числами) и КАРТОЧКА АРХЕТИПА в подтипе (концепты, текст, рычаги движка, числа монстров конфига: бой, атрибуты, гир, умения).
 * Числа — `monsterNumbers.ts` (тем же кодом, что игра); здесь только DOM.
 *
 * ⭐ 17.10: главный раздел страницы подтипа — «Ярусы (v2)» (ростер по ярусам, `rosterPages.ts`, грузится лениво). Таблица
 * архетипов с живыми числами и карточки архетипов — АРХИВ прежней раскладки по ролям (до 17.10): раздел свёрнут, маршрут
 * `arch:<архетип>:<подтип>` работает как раньше (нынешние 19 зомби конфига — тестовые).
 *
 * Переключатели «этаж / сложность / редкость / бросок / сравнить с» общие для подтипа и карточки, помнятся (localStorage).
 */
import { STAT_LABEL } from '@dm/shared';
import type { ArtbookCtx } from './ctx.js';
import { SLOT_SETS } from './model.js';
import {
  LEGACY_SUBTYPE, RARITIES, RARITY_LABEL, archetypesOf, bindArchetypes, floorMonsterLevel, monsterCard, protoOf, subtypeTable,
  type ArchRow, type MonsterCard, type MonsterNumbers, type MonsterRarity, type SubtypeTable,
} from './monsterNumbers.js';
import { navBar, renderRosterSection } from './rosterPages.js';
import type { Archetype, Subtype } from './seed.js';
import { C, btn, chip, el, h2, h3, kv, muted, section, sourcesList, swatches, table, type Cell } from './ui.js';
import { hasField as has } from './widgets.js';

// ── Переключатели (общие для страниц) ────────────────────────────────────────────────────────────

const LS = { floor: 'artbook_mon_floor', diff: 'artbook_mon_diff', rarity: 'artbook_mon_rarity', seed: 'artbook_mon_seed', cmp: 'artbook_mon_cmp' } as const;
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* приватное окно */ } };

export const mon = {
  floor: Math.max(1, Math.floor(Number(lsGet(LS.floor))) || 1),
  difficulty: lsGet(LS.diff) || 'normal',
  rarity: (RARITIES as readonly string[]).includes(lsGet(LS.rarity) ?? '') ? lsGet(LS.rarity) as MonsterRarity : 'normal' as MonsterRarity,
  seed: Math.max(1, Math.floor(Number(lsGet(LS.seed))) || 1),
  cmp: lsGet(LS.cmp) ?? '',
};
const save = (): void => {
  lsSet(LS.floor, String(mon.floor)); lsSet(LS.diff, mon.difficulty); lsSet(LS.rarity, mon.rarity); lsSet(LS.seed, String(mon.seed)); lsSet(LS.cmp, mon.cmp);
};

const FLOORS = [1, 5, 10, 20, 40, 80];
const DMG_SHORT: Record<string, string> = { physical: 'физ.', fire: 'огонь', cold: 'холод', lightning: 'молния', poison: 'яд' };
const ATTRS = ['str', 'dex', 'int', 'vit'] as const;
const ATTR_STAT: Record<(typeof ATTRS)[number], string> = { str: 'strength', dex: 'dexterity', int: 'intelligence', vit: 'vitality' };

interface DiffRow { id: string; name: string; enabled?: boolean }
const diffsOf = (ctx: ArtbookCtx): DiffRow[] => (Array.isArray(ctx.data.difficulties) ? ctx.data.difficulties as DiffRow[] : []);
const rarityColor = (ctx: ArtbookCtx, r: string): string =>
  (Array.isArray(ctx.data.rarities) ? (ctx.data.rarities as { id: string; color?: string }[]).find((x) => x.id === r)?.color : undefined) ?? C.soft;

const inputCss = `padding:4px 6px;background:${C.input};color:${C.text};border:1px solid ${C.edge};border-radius:4px;font-size:12.5px`;

/** Полоса переключателей; справа — уровень монстров выбранного этажа (как его считает заселение). `compareOf` — показать «сравнить с». */
function controls(ctx: ArtbookCtx, opts: { compareOf?: string } = {}): HTMLElement {
  const bar = el('div', `display:flex;gap:6px 14px;align-items:center;flex-wrap:wrap;margin:4px 0 8px;padding:7px 10px;border:1px solid ${C.edgeSoft};border-radius:8px;background:${C.bg}`);
  const group = (label: string): HTMLElement => { const g = el('div', 'display:flex;gap:4px;align-items:center;flex-wrap:wrap'); g.append(el('span', `font-size:12px;color:${C.dim}`, label)); bar.append(g); return g; };
  const set = (fn: () => void): void => { fn(); save(); ctx.rerender(); };

  const fl = group('Этаж');
  const inp = el('input', `${inputCss};width:58px`);
  inp.type = 'number'; inp.min = '1'; inp.max = '999'; inp.value = String(mon.floor);
  inp.title = 'этаж спуска (1 — верхний); уровень монстра считает заселение этажа';
  inp.addEventListener('change', () => set(() => { mon.floor = Math.max(1, Math.min(999, Math.floor(Number(inp.value)) || 1)); }));
  fl.append(inp);
  for (const f of FLOORS) fl.append(btn(String(f), () => set(() => { mon.floor = f; }), `padding:2px 7px;${f === mon.floor ? `background:${C.active}` : ''}`));

  const dg = group('Сложность');
  const sel = el('select', inputCss);
  for (const d of diffsOf(ctx)) {
    const o = el('option', '', d.name + (d.enabled === false ? ' (выкл.)' : ''));
    o.value = d.id; if (d.id === mon.difficulty) o.selected = true;
    sel.append(o);
  }
  sel.value = mon.difficulty;
  sel.addEventListener('change', () => set(() => { mon.difficulty = sel.value; }));
  dg.append(sel);

  const rg = group('Редкость');
  for (const r of RARITIES) {
    const col = rarityColor(ctx, r);
    rg.append(btn(RARITY_LABEL[r], () => set(() => { mon.rarity = r; }), `padding:2px 8px;color:${col};${r === mon.rarity ? `background:${C.active};border-color:${col}88` : ''}`));
  }
  const dice = btn(`🎲 ${mon.seed}`, () => set(() => { mon.seed = (mon.seed % 9999) + 1; }), 'padding:2px 8px');
  dice.title = 'бросок свойств магического / редкого / уникального (сид); у обычного числа от броска не зависят';
  rg.append(dice);

  if (opts.compareOf) {
    const cg = group('Сравнить с');
    const cs = el('select', inputCss);
    const none = el('option', '', '—'); none.value = ''; cs.append(none);
    for (const s of ctx.view.crypt.subtypes) {
      if (s.id === opts.compareOf) continue;
      const o = el('option', '', s.name); o.value = s.id; if (s.id === mon.cmp) o.selected = true;
      cs.append(o);
    }
    cs.value = mon.cmp === opts.compareOf ? '' : mon.cmp;
    cs.addEventListener('change', () => set(() => { mon.cmp = cs.value; }));
    cg.append(cs);
  }

  const lv = el('span', `font-size:12px;color:${C.dim};margin-left:auto`);
  try { lv.append('уровень монстров: ', el('b', `color:${C.gold}`, String(floorMonsterLevel(ctx.reg(), mon.difficulty, mon.floor)))); } catch { lv.textContent = ''; }
  lv.title = 'обычная комната соло; в боссовой комнате монстры глубже, в коопе — толще';
  bar.append(lv);
  return bar;
}

const regFail = (ctx: ArtbookCtx, e: unknown): HTMLElement =>
  el('div', `color:${C.bad};font-size:12.5px;margin:4px 0 8px`, '⚠ Конфиг не разобрался — чисел нет: ' + (ctx.regError() ?? (e instanceof Error ? e.message : String(e))));

// ── Общие куски ──────────────────────────────────────────────────────────────────────────────────

const subOf = (ctx: ArtbookCtx, id: string): Subtype | undefined => ctx.view.crypt.subtypes.find((s) => s.id === id);
const archOf = (ctx: ArtbookCtx, id: string): Archetype | undefined => ctx.view.crypt.archetypes.find((a) => a.id === id);
const mono = (s: string, css = ''): HTMLElement => el('span', `font-family:ui-monospace,monospace;font-size:11.5px;color:${C.dim};${css}`, s);
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/**
 * Цвет бейджа разложения по месту подтипа на лестнице — ⭐ 17.10 на шесть подтипов, в порядке документа (снизу вверх по слоям):
 * ил и битум (Дом Праха) → лён и смола (Двор Тростника) → голая кость (Посеянные) → кожа-пергамент (легион) → мёрзлая плоть
 * (дружина) → мокрая гниль (Присяжные Короны).
 */
const DECAY_COLORS = ['#a3916f', '#d0aa62', '#d8d2c2', '#c49a74', '#82aac4', '#8fbf73'];
/** Бейдж разложения подтипа: начало строки лестницы до двоеточия («зомби», «мумии»…), подсказка — строка целиком. */
export function decayBadge(ctx: ArtbookCtx, subId: string): HTMLElement | null {
  const rows = ctx.view.crypt.decayLadder.rows;
  const i = rows.findIndex((r) => r.subtype === subId);
  if (i < 0) return null;
  const body = rows[i]!.body;
  const word = body.split(':')[0]!.trim();
  return chip(word.length > 24 ? word.slice(0, 22) + '…' : word, DECAY_COLORS[i % DECAY_COLORS.length], body);
}


// ── Страница подтипа ─────────────────────────────────────────────────────────────────────────────

export function renderSubtype(host: HTMLElement, ctx: ArtbookCtx, subId: string): void {
  const s = subOf(ctx, subId)!;
  const P = (f: string): string => `crypt/subtypes/${s.id}/${f}`;
  host.append(navBar(ctx, btn('← все подтипы', () => ctx.go(''))));

  const title = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
  title.append(ctx.text(P('name'), { tag: 'span', single: true, plain: true, css: `font-size:18px;font-weight:700;color:${C.text}` }), chip(`№ ${s.ownerNo}`, C.dim));
  const db = decayBadge(ctx, s.id);
  if (db) title.append(db);
  title.append(ctx.text(P('eraText'), { tag: 'span', single: true, plain: true, css: `font-size:12px;color:${C.dim}` }));
  host.append(title);
  if (s.altNames.length) host.append(muted('Ещё зовут: ' + s.altNames.join(' · '), 'margin:2px 0 4px'));
  host.append(kv('Справка (игроку не видна)', ctx.text(P('ref'), { tag: 'span' })));

  const cols = el('div', 'display:grid;grid-template-columns:minmax(320px,1.15fr) minmax(300px,1fr);gap:14px;align-items:start;margin-top:8px');
  const left = el('div', 'min-width:0'), right = el('div', 'min-width:0');
  cols.append(left, right);
  host.append(cols);
  left.append(ctx.slots(['sub', s.id], SLOT_SETS.subtype));
  right.append(h3('Коротко'), ctx.text(P('short')));
  right.append(h3('Палитра'), swatches(s.palette));
  right.append(h3('Свечение'), ctx.text(P('glow')));
  right.append(h3('Подпись подтипа'), ctx.text(P('gameplay/signature')));

  // ⭐ 17.10: главный раздел — ростер по ярусам (решения владельца 16–17.10), грузится лениво своим чанком.
  host.append(section('Ярусы (v2)', `sub:${s.id}:v2`, (b) => renderRosterSection(b, ctx, s), { open: true, note: 'три яруса × (3 ближника + 2 стрелка), три босса, особые — решения владельца 17.10' }));

  // Прежняя раскладка по ролям — архив: таблица архетипов на живых числах нынешних (тестовых) монстров конфига.
  host.append(section('Архив: прежняя раскладка по ролям (до 17.10)', `sub:${s.id}:archive`, (b) => {
    b.append(ctx.text('crypt/archiveNote', { css: `font-size:12.5px;color:${C.dim}` }));
    b.append(h3('Архетипы подтипа — живые числа (тем же кодом, что игра)'));
    b.append(controls(ctx, { compareOf: s.id }));
    let tbl: SubtypeTable | null = null;
    try { tbl = subtypeTable(ctx.reg(), ctx.view.crypt, s.id, { floor: mon.floor, difficulty: mon.difficulty, rarity: mon.rarity, seed: mon.seed }); } catch (e) { b.append(regFail(ctx, e)); }
    if (tbl) {
      b.append(archTable(ctx, s.id, tbl));
      if (tbl.extra.length) {
        b.append(h3(`Монстры подтипа без архетипа (${tbl.extra.length})`));
        b.append(muted('В конфиге они относятся к этому подтипу, но ни один архетип черновика их не берёт. Привязать — именем архетипа в подтипе или строкой черновика.', 'margin-bottom:2px'));
        b.append(table(['Монстр конфига', ...NUM_HEAD], tbl.extra.map((x) => [monCell(x.n, !!x.off), ...numCells(ctx, x.n)])));
      }
      const other = mon.cmp && mon.cmp !== s.id ? subOf(ctx, mon.cmp) : undefined;
      if (other) b.append(compareTable(ctx, s, other, tbl));
    }
  }, { note: 'общие архетипы + особые; живые числа нынешних (тестовых) монстров конфига' }));

  host.append(section('Лор', `sub:${s.id}:lore`, (b) => {
    b.append(ctx.text(P('lore')));
    if (s.houses?.length) {
      b.append(h3('Дома'));
      b.append(table(['Дом', 'Справка', 'Как выглядит', 'Где'], s.houses.map((h) => [el('b', `color:${C.text}`, h.name), ctx.text(P(`houses/${h.id}/ref`), { tag: 'span' }), ctx.text(P(`houses/${h.id}/look`), { tag: 'span' }), ctx.text(P(`houses/${h.id}/where`), { tag: 'span' })]), { widths: ['130px'] }));
    }
  }, { open: true }));
  host.append(section('Разложение', `sub:${s.id}:decay`, (b) => {
    b.append(ctx.text(P('decay')));
    const r = ctx.view.crypt.decayLadder.rows.find((x) => x.subtype === s.id);
    if (r) {
      const L = (f: string): HTMLElement => ctx.text(`crypt/decayLadder/rows/${s.id}/${f}`, { tag: 'span' });
      b.append(h3('На лестнице разложения'), kv('Тело', L('body')), kv('Вес', L('weight')), kv('Скорость', L('speed')), kv('Что берёт сильнее', L('takes')), kv('Что держит', L('holds')), kv('Что накладывает', L('gives')));
    }
  }));
  host.append(section('Палитра и материалы', `sub:${s.id}:palette`, (b) => {
    b.append(swatches(s.palette));
    b.append(table(['Цвет', 'Роль'], s.palette.map((c, i) => [mono(c.hex, `color:${C.text}`), ctx.text(P(`palette/${i}/role`), { tag: 'span' })]), { widths: ['90px'] }));
    b.append(h3('Свечение'), ctx.text(P('glow')), h3('Материалы'), ctx.text(P('materials')));
  }));
  host.append(section('Силуэт сверху', `sub:${s.id}:silhouette`, (b) => b.append(ctx.list(P('silhouette')))));
  host.append(section('Движение и звук', `sub:${s.id}:motion`, (b) => b.append(ctx.text(P('motion')))));
  host.append(section('Мотивы', `sub:${s.id}:motifs`, (b) => b.append(ctx.list(P('motifs')))));
  host.append(section('Геймплей', `sub:${s.id}:gameplay`, (b) => {
    b.append(h3('Черты'), ctx.list(P('gameplay/traits')));
    b.append(h3('Подписи'));
    s.gameplay.signatures.forEach((g, i) => b.append(kv(g.name, ctx.text(P(`gameplay/signatures/${i}/text`), { tag: 'span' }))));
    b.append(kv('Слабость', ctx.text(P('gameplay/weakness'), { tag: 'span' })), kv('Держит', ctx.text(P('gameplay/resist'), { tag: 'span' })), kv('Чего нет', ctx.text(P('gameplay/hole'), { tag: 'span' })));
    b.append(h3('Как с ними биться'), ctx.list(P('gameplay/counter')));
    const st = ctx.view.crypt.statuses.rows.find((x) => x.subtype === s.id);
    if (st) {
      const T = (f: string): HTMLElement => ctx.text(`crypt/statuses/rows/${s.id}/${f}`, { tag: 'span' });
      b.append(h3('Статусы'), kv('Главный', T('main')), kv('Второй', T('second')), kv('Броня-ответ', T('armor')), kv('Слабость', T('weak')), kv('Сопротивление', T('resist')));
    }
  }));
  host.append(section('Где встречается', `sub:${s.id}:depth`, (b) => {
    // ⭐ 17.10: слоёв по этажам больше нет — подтип выпадает на отрезок до вейпоинта (раздел «Выбор подтипа при спуске»).
    b.append(ctx.text(P('depth')));
    b.append(muted('Первая волна по ярусам — очередь «1 · сначала»: лёгкий и средний ярус, 10 карточек (раздел «Ярусы (v2)», вид «☰ Ростер и очерёдность»).', 'margin:2px 0 4px'));
    b.append(h3('Первая волна прежней раскладки (архив до 17.10)'), ctx.list(P('firstWave'), { ordered: true }));
  }));
  host.append(section('Заметки художнику', `sub:${s.id}:art`, (b) => {
    b.append(ctx.list(P('artNotes')));
    if (has(ctx, P('notToDraw'))) {
      b.append(h3('Не рисовать'));
      b.append(Array.isArray(s.notToDraw) ? ctx.list(P('notToDraw')) : ctx.text(P('notToDraw')));
    }
    if (s.mergeNotes?.length) b.append(h3('Что слито из других подтипов'), ctx.list(P('mergeNotes')));
    if (s.splitNotes?.length) b.append(h3('Что разделено (Двор Тростника и Дом Праха, 16.10)'), ctx.list(P('splitNotes')));
    if (s.reserve?.length) {
      b.append(h3('В запасе'));
      b.append(table(['Кто', 'Справка', 'Зачем держим'], s.reserve.map((r, i) => [el('b', `color:${C.text}`, r.name), ctx.text(P(`reserve/${i}/ref`), { tag: 'span' }), ctx.text(P(`reserve/${i}/why`), { tag: 'span' })]), { widths: ['150px'] }));
    }
  }));
  host.append(section('Источники', `sub:${s.id}:sources`, (b) => b.append(sourcesList(s.sources))));
}

const NUM_HEAD = ['Ур.', 'Жизнь', 'Урон', 'Атак/с', 'Броня', 'Блок', 'Скорость', 'Оружие', 'Доспех / шлем / щит'];

function monCell(n: MonsterNumbers, off = false): HTMLElement {
  const c = el('span', '');
  c.append(el('span', `color:${C.text}`, n.shownName), el('br'), mono(n.id));
  if (off) c.append(' ', chip('выкл.', C.bad, 'выключен в конфиге — в игре не заселяется'));
  return c;
}

function numCells(ctx: ArtbookCtx, n: MonsterNumbers): Cell[] {
  const dmg = el('span', 'white-space:nowrap', `${n.minDamage}–${n.maxDamage}`);
  if (n.damageType !== 'physical') dmg.append(el('span', `color:${C.dim};font-size:11px`, ' ' + (DMG_SHORT[n.damageType] ?? n.damageType)));
  const hp = el('b', `color:${rarityColor(ctx, n.rarity)}`, String(n.hp));
  return [
    String(n.level), hp, dmg, String(n.attackSpeed), String(n.armor), n.blockChance ? pct(n.blockChance) : '—', String(n.moveSpeed),
    n.weapon || '—', [n.armorName, n.helm, n.shield].map((x) => x || '—').join(' / '),
  ];
}

/** Таблица архетипов подтипа: строка — монстр конфига (вариант — двойник); архетип без монстра — серая строка. Клик — карточка. */
function archTable(ctx: ArtbookCtx, subId: string, t: SubtypeTable): HTMLElement {
  const rows: Cell[][] = t.rows.map((r) => {
    const name = el('span', '');
    if (r.variant) name.append(el('span', `color:${C.faint}`, '↳ вариант'));
    else {
      name.append(el('b', `color:${C.text}`, r.name));
      if (r.general !== r.name) name.append(el('span', `color:${C.faint};font-size:11px`, ' · ' + r.general));
      if (r.kind === 'unique') name.append(' ', chip('особый', C.gold));
    }
    const role = r.variant ? '' : r.role;
    if (!r.n) {
      const miss = el('span', `color:${C.faint};font-style:italic`, 'ещё нет в конфиге');
      if (r.proto) { miss.append(el('br'), el('span', 'font-style:normal;font-size:11px', 'прообраз: ' + r.proto.name)); miss.title = `в черновике — ${r.proto.id} (сейчас другого подтипа)`; }
      return [name, role, miss, ...NUM_HEAD.map(() => '')];
    }
    return [name, role, monCell(r.n, !!r.off), ...numCells(ctx, r.n)];
  });
  const filled = t.rows.filter((r) => r.n).length;
  const box = el('div', '');
  box.append(muted(`${archetypesOf(ctx.view.crypt, subId).length} архетипов · строк с монстром конфига ${filled} · уровень ${t.level} · ${RARITY_LABEL[mon.rarity]}. Клик по строке — карточка архетипа.`, 'margin-bottom:2px'));
  box.append(table(['Архетип', 'Роль', 'Монстр конфига', ...NUM_HEAD], rows, {
    widths: ['170px', '150px', '150px'],
    onRow: (i) => ctx.go(`arch:${t.rows[i]!.archId}:${subId}`),
    rowCss: (i) => (t.rows[i]!.n ? '' : 'opacity:.6;'),
  }));
  return box;
}

/** «Сравнить с»: общие архетипы бок о бок (имя в подтипе и основной монстр), особые — числом и списком. */
function compareTable(ctx: ArtbookCtx, a: Subtype, b: Subtype, ta: SubtypeTable): HTMLElement {
  const box = el('div', `margin:6px 0 12px;padding:8px 10px;border:1px solid ${C.edgeSoft};border-radius:8px;background:${C.panel}`);
  box.append(el('div', `font-weight:600;color:${C.text};font-size:13.5px;margin-bottom:4px`, `Сравнение: ${a.name} ↔ ${b.name}`));
  let tb: SubtypeTable;
  try { tb = subtypeTable(ctx.reg(), ctx.view.crypt, b.id, { floor: mon.floor, difficulty: mon.difficulty, rarity: mon.rarity, seed: mon.seed }); } catch (e) { box.append(regFail(ctx, e)); return box; }
  const first = (t: SubtypeTable, id: string): ArchRow | undefined => t.rows.find((r) => r.archId === id && !r.variant);
  const sideCells = (r: ArchRow | undefined): Cell[] => {
    if (!r) return ['—', '', ''];
    const nm = el('b', `color:${C.text}`, r.name);
    if (!r.n) return [nm, el('span', `color:${C.faint};font-style:italic`, 'нет в конфиге'), ''];
    return [nm, el('span', `color:${rarityColor(ctx, r.n.rarity)}`, String(r.n.hp)), `${r.n.minDamage}–${r.n.maxDamage}`];
  };
  const common = ctx.view.crypt.archetypes.filter((x) => x.kind === 'common' && x.subtypes.includes(a.id) && x.subtypes.includes(b.id));
  box.append(table(['Архетип', a.name, 'жизнь', 'урон', b.name, 'жизнь', 'урон'],
    common.map((x) => [el('span', `color:${C.dim}`, x.name), ...sideCells(first(ta, x.id)), ...sideCells(first(tb, x.id))]),
    { widths: ['120px'], onRow: (i) => ctx.go(`arch:${common[i]!.id}:${a.id}`) }));
  const uniq = (s: Subtype): HTMLElement => {
    const list = archetypesOf(ctx.view.crypt, s.id).filter((x) => x.kind === 'unique');
    const d = el('div', 'min-width:0');
    d.append(el('div', `font-size:12px;color:${C.dim};margin-bottom:2px`, `${s.name}: особых ${list.length}`));
    d.append(el('div', `font-size:12.5px;color:${C.soft};line-height:1.5`, list.map((x) => x.perSubtype[s.id]?.name ?? x.name).join(' · ') || '—'));
    return d;
  };
  const two = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:12px');
  two.append(uniq(a), uniq(b));
  box.append(two);
  return box;
}

// ── Карточка архетипа в подтипе ──────────────────────────────────────────────────────────────────

export function renderArchetype(host: HTMLElement, ctx: ArtbookCtx, archId: string, subId: string): void {
  const a = archOf(ctx, archId)!;
  const s = subOf(ctx, subId)!;
  const A = (f: string): string => `crypt/archetypes/${a.id}/${f}`;
  const S = (f: string): string => A(`perSubtype/${s.id}/${f}`);
  const ps = a.perSubtype[s.id];

  const others = a.subtypes.filter((x) => x !== s.id).map((x) => subOf(ctx, x)).filter((x): x is Subtype => !!x);
  const switcher = el('span', 'display:flex;gap:4px;align-items:center;flex-wrap:wrap');
  if (others.length) {
    switcher.append(el('span', `font-size:12px;color:${C.faint};margin-left:6px`, 'в других подтипах:'));
    for (const o of others) switcher.append(btn(a.perSubtype[o.id]?.name ?? o.name, () => ctx.go(`arch:${a.id}:${o.id}`), 'padding:2px 8px;font-size:11.5px'));
  }
  host.append(navBar(ctx, btn(`← ${s.name}`, () => ctx.go('sub:' + s.id)), switcher));

  const title = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap');
  if (ps) title.append(ctx.text(S('name'), { tag: 'span', single: true, plain: true, css: `font-size:18px;font-weight:700;color:${C.text}` }));
  else title.append(h2(a.name));
  if (ps && ps.name !== a.name) title.append(chip(a.name, C.accent));
  title.append(chip(a.kind === 'unique' ? 'особый' : 'общий', a.kind === 'unique' ? C.gold : C.dim), chip(s.name, C.dim));
  if (a.waveBySubtype[s.id]) title.append(chip(a.waveBySubtype[s.id]!, C.faint, 'очередь производства'));
  host.append(title);
  host.append(kv('Канон ролей', a.canon, 'margin-top:2px'));

  const cols = el('div', 'display:grid;grid-template-columns:minmax(320px,1.1fr) minmax(300px,1fr);gap:14px;align-items:start;margin-top:8px');
  const left = el('div', 'min-width:0'), right = el('div', 'min-width:0');
  cols.append(left, right);
  host.append(cols);
  left.append(ctx.slots(['arch', a.id, s.id], SLOT_SETS.archetype));

  if (ps) {
    right.append(el('div', `font-size:13px;font-weight:600;color:${C.text};margin:2px 0 4px`, `В подтипе «${s.name}»`));
    right.append(kv('Справка (скрыта от игрока)', ctx.text(S('ref'), { tag: 'span' })));
    right.append(h3('Снаряжение'), ctx.text(S('gear')));
    right.append(h3('Особенность подтипа'), ctx.text(S('twist')));
    if (has(ctx, S('telegraph'))) right.append(h3('Телеграф'), ctx.text(S('telegraph')));
    if (has(ctx, S('elite'))) right.append(h3('Элита'), ctx.text(S('elite')));
    if (has(ctx, S('silhouette'))) right.append(h3('Силуэт'), ctx.text(S('silhouette')));
  }
  const general = el('div', `margin-top:8px;padding-top:6px;border-top:1px solid ${C.edgeSoft}`);
  general.append(el('div', `font-size:13px;font-weight:600;color:${C.text};margin:2px 0 4px`, `Архетип «${a.name}» в целом`));
  general.append(kv('Роль', ctx.text(A('role'), { tag: 'span' })), kv('Вопрос игроку', ctx.text(A('question'), { tag: 'span' })), kv('Угроза', ctx.text(A('threat'), { tag: 'span' })));
  for (const [label, f] of [['Поведение', 'behavior'], ['Механика', 'mechanic'], ['Телеграф', 'telegraph'], ['Элита', 'elite'], ['Контригра', 'counter'], ['Силуэт', 'silhouette'], ['Очередь', 'queue']] as const) {
    if (has(ctx, A(f))) general.append(h3(label), ctx.text(A(f)));
  }
  right.append(general);

  host.append(section('Рычаги движка', `arch:${a.id}:engine`, (b) => {
    const two = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:4px 18px');
    const x = el('div'), y = el('div');
    x.append(h3('Есть в движке'), a.engine.have.length ? ctx.list(A('engine/have')) : muted('—'));
    y.append(h3('Нужно сделать'), a.engine.need.length ? ctx.list(A('engine/need')) : muted('—'));
    two.append(x, y);
    b.append(two);
  }, { open: true }));

  host.append(section('Живые числа монстров конфига (тем же кодом, что игра)', `arch:${a.id}:numbers`, (b) => renderLive(b, ctx, a, s), { open: true }));
}

function renderLive(body: HTMLElement, ctx: ArtbookCtx, a: Archetype, s: Subtype): void {
  body.append(controls(ctx));
  let ids: string[] = [];
  let level = 1;
  try {
    const reg = ctx.reg();
    ids = bindArchetypes(ctx.view.crypt, s.id, reg.get('monsters')).byArch.get(a.id) ?? [];
    level = floorMonsterLevel(reg, mon.difficulty, mon.floor);
    if (!ids.length) {
      const p = protoOf(a, reg.get('monsters'));
      const box = el('div', `padding:10px 12px;border:1.5px dashed ${C.edge};border-radius:8px;color:${C.dim};font-size:12.5px;line-height:1.5`);
      box.append(el('div', `color:${C.faint};font-style:italic;font-size:13px`, 'Ещё нет в конфиге.'));
      const nm = a.perSubtype[s.id]?.name ?? a.name;
      if (s.id === LEGACY_SUBTYPE) box.append(el('div', '', `Монстр конфига встанет сюда сам по имени «${nm}»: нежить без подфракции и так относится к подтипу «${s.name}».`));
      else {
        box.append(el('div', '', `Монстр конфига встанет сюда сам, когда у него будет подтип «${s.name}» (поле «подфракция» = ${s.id}) и имя «${nm}».`));
        // ⚠ 16.10: подфракция — не только подтип артбука. Это выпадашка из «Монстры: подфракции» (строки подтипа там пока нет) и КЛЮЧ
        // 3D-АТЛАСА монстра (`atlasKey = subfaction || faction`, поиск строгий): без атласа с этим ключом игра рисует процедурную фигуру.
        box.append(el('div', `color:${C.warn};font-size:12px;margin-top:2px`, `⚠ Подфракция у монстра — это ещё и ключ его 3D-атласа: пока атласа «${s.id}» нет, в игре он будет процедурной фигурой; и строки «${s.id}» в выпадашке подфракций пока нет (раздел «Монстры: подфракции»).`));
      }
      if (p) box.append(el('div', '', `Прообраз в черновике: «${p.name}» (${p.id}) — сейчас он в подтипе другой эпохи.`));
      const add = btn('＋ Завести монстра', () => { /* заглушка: строки конфига заводим отдельной задачей */ }, `margin-top:6px;opacity:.6;cursor:not-allowed`);
      add.title = 'появится позже: заводить строки конфига («Игра → Монстры») будем отдельно — пока заведи монстра там руками';
      box.append(add);
      body.append(box);
      return;
    }
    for (const id of ids) {
      const c = monsterCard(reg, id, level, mon.rarity, mon.seed);
      if (c) body.append(monsterBlock(ctx, c, ids.length > 1 && id !== ids[0]));
    }
  } catch (e) { body.append(regFail(ctx, e)); }
}

function monsterBlock(ctx: ArtbookCtx, c: MonsterCard, variant: boolean): HTMLElement {
  const n = c.n;
  const box = el('div', `border:1px solid ${rarityColor(ctx, n.rarity)}55;border-radius:8px;padding:9px 12px;margin:0 0 10px;background:${C.bg}`);
  const head = el('div', 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px');
  head.append(el('span', `font-weight:700;font-size:14.5px;color:${rarityColor(ctx, n.rarity)}`, n.shownName));
  if (n.shownName !== n.name) head.append(el('span', `color:${C.dim};font-size:12px`, n.name));
  head.append(mono(n.id), chip(`ур. ${n.level}`, C.gold), chip(c.tierLabel, C.dim), chip(c.roleName, C.accent));
  if (variant) head.append(chip('вариант', C.faint));
  if (!c.enabled) head.append(chip('выключен в конфиге', C.bad));
  head.append(btn('в конфиге →', () => ctx.gotoConfig('monsters'), `margin-left:auto;padding:2px 8px;color:${C.dim}`));
  box.append(head);

  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 18px');
  const col1 = el('div'), col2 = el('div');
  const dmg = `${n.minDamage}–${n.maxDamage} ${DMG_SHORT[n.damageType] ?? n.damageType}`;
  col1.append(
    kv('Жизнь', `${n.hp}${n.hpRegen ? ` (+${n.hpRegen}/с)` : ''}`), kv('Урон', dmg), kv('Атак в секунду', String(n.attackSpeed)),
    kv('Броня', String(n.armor)), kv('Блок', n.blockChance ? pct(n.blockChance) : '—'), kv('Скорость', String(n.moveSpeed)),
  );
  col2.append(
    kv('Меткость / уклонение', `${n.accuracy} / ${n.evade}`), kv('Крит', `${pct(n.critChance)} ×${n.critMultiplier}`),
    kv('Сопротивления', `огонь ${pct(n.resFire)} · холод ${pct(n.resCold)} · молния ${pct(n.resLightning)} · яд ${pct(n.resPoison)}`),
    kv('Опыт', String(n.xp)),
  );
  grid.append(col1, col2);
  box.append(grid);

  box.append(h3('Атрибуты заготовки'));
  box.append(table(ATTRS.map((k) => STAT_LABEL[ATTR_STAT[k]] ?? k), [ATTRS.map((k) => String(c.attrs[k]))]));
  box.append(muted('Растут с уровнем по коэффициентам «Деривации монстров» — из них игра и выводит числа выше.', 'margin:-6px 0 4px'));

  box.append(h3('Снаряжение'));
  box.append(table(['Слот', 'Вещь', 'id', 'Класс', 'Урон / защита', 'Атак/с', 'Блок', 'Модель', 'Свойства'], c.gear.map((g) => {
    const name = el('span', `color:${rarityColor(ctx, g.rarity)}`, g.name);
    if (g.tier) name.append(el('span', `color:${C.faint};font-size:11px`, ` · ступень ${g.tier}`));
    const stat = g.damage ? `${g.damage} ${DMG_SHORT[g.damageType ?? 'physical'] ?? ''}${g.hands === 2 ? ' · двуручное' : ''}` : g.defense ? `защита ${g.defense}` : '—';
    const props = [...(g.physSub ? [g.physSub.toLowerCase()] : []), ...g.mods].join(', ');
    return [g.slotLabel, name, mono(g.id), g.cls || '—', stat, g.attackSpeed !== undefined ? String(g.attackSpeed) : '—', g.block !== undefined ? pct(g.block) : '—',
      g.modelId ? mono(g.modelId, `color:${C.text}`) : el('span', `color:${C.faint}`, 'база слота'), props || (g.rarity === 'normal' ? el('span', `color:${C.faint}`, 'обычная') : '—')];
  }), { widths: ['70px'] }));

  box.append(h3('Умения'));
  const ul = el('ul', 'margin:2px 0 4px;padding-left:18px;font-size:12.5px');
  for (const sk of c.skills) {
    const li = el('li', `color:${C.soft};margin:2px 0`);
    li.append(el('b', `color:${C.text}`, sk.name + ': '), sk.text);
    ul.append(li);
  }
  box.append(ul);
  return box;
}
