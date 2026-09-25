import * as THREE from 'three';
import {
  ConfigRegistry, baseOfKeyPart, baseTierRange, bladeCaption, bladeFormOf, bladeStatsOf, buildCraftShell, clampStep,
  craftTiers, craftWeapon, defaultParts, familiesOf, partById, suggestBracket, suggestForm, weaponSpeedOf,
  type BladeForm, type BladeStats, type BladeTuning, type Item, type WeaponPart,
} from '@dm/shared';
import { measureBlade, geomOf, type BladeMeasure } from '@dm/client/modules/town/craftMesh/bladeGeom.js';
import type { CraftIo } from './craft.js';

/**
 * «🗡 Клинки» — КЛИНОК ИЗ ГЕОМЕТРИИ (docs/CRAFT_WEAPONS.md §26) глазами хозяина: ручки, все клинки мечей
 * с их выведенными статами и замер загруженных моделей.
 *
 * ⭐ Ни одной своей формулы. Статы клинка — `bladeStatsOf`, вещь — `craftWeapon` с тем же набором деталей,
 * что собирает окно ковки (`defaultParts` + этот клинок), поэтому таблица не может разойтись с ковкой.
 * Замер — тот же `measureBlade`, что сторожит процедурные заглушки (`craftMesh/bladeGeom.test.ts`).
 *
 * Вкладка правит РАБОЧУЮ КОПИЮ конфига редактора (`data`): ручки — `balance.craft`, форма и замер —
 * строки `weapon-parts`. В игру правка уходит только кнопками сохранения сверху.
 */

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const INP = 'padding:3px 6px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:12px';
const BTN = 'padding:5px 10px;cursor:pointer;border-radius:5px;border:1px solid #3a3a4c;background:#1c1c26;color:#e8e8f0;font-size:12px';
const TD = 'padding:3px 6px;text-align:right;font-family:monospace;white-space:nowrap';
const CLS = 'sword';
const FORM_NAME: Record<BladeForm, string> = { falchion: 'фальшион', sabre: 'сабля' };
/** Порог «в пуле есть тяжёлый / лёгкий клинок» для лампочки палитры вилки. */
const PALETTE_EDGE = 0.5;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** Со знаком и настоящим минусом: «+0.40», «−1.00». */
const sg = (x: number, d = 2): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const pc = (x: number, d = 1): string => `${(x * 100).toFixed(d)} %`;
const pcShort = (x: number): string => `${Math.round(x * 1000) / 10} %`;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const flat = (it: Pick<Item, 'baseStats'>, stat: string): number =>
  it.baseStats.filter((m) => m.stat === stat && m.kind === 'flat').reduce((s, m) => s + m.value, 0);
const midDamage = (it: Pick<Item, 'baseStats'>): number => (flat(it, 'minDamage') + flat(it, 'maxDamage')) / 2;
const axisColor = (a: number): string => (a >= 0.35 ? '#e39a3c' : a <= -0.35 ? '#6f9bcf' : '#ddd');

const card = (parent: HTMLElement, title: string, hint = ''): HTMLElement => {
  const c = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px;margin-bottom:12px');
  c.append(h('div', 'color:#e39a3c;font-weight:600;margin-bottom:4px', title));
  if (hint) c.append(h('div', 'color:#888;font-size:11px;margin-bottom:8px;line-height:1.5', hint));
  parent.append(c);
  return c;
};
const chip = (text: string, title: string, warn = true): HTMLElement => {
  const c = h('span', `display:inline-block;padding:1px 7px;margin:1px 3px 1px 0;border-radius:9px;font-size:11px;white-space:nowrap;${warn ? 'background:#3a2a18;color:#e8b070;border:1px solid #5a4020' : 'background:#1f2a1f;color:#9cc08a;border:1px solid #2f4a2f'}`, esc(text));
  c.title = title;
  return c;
};
function select(options: [string, string][], value: string, onChange: (v: string) => void, css = ''): HTMLSelectElement {
  const s = document.createElement('select'); s.style.cssText = `${INP};${css}`;
  for (const [v, label] of options) { const o = document.createElement('option'); o.value = v; o.textContent = label; o.selected = v === value; s.append(o); }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Строка `weapon-parts` как она лежит в рабочей копии редактора (её и правим). */
interface RawPart {
  id: string; name: string; slot: string; classes?: string[]; enabled?: boolean;
  tags?: Record<string, string>; geom?: ReturnType<typeof geomOf>; form?: string;
}
interface RawCraft {
  blade?: BladeTuning;
  strike?: { damagePct: number; attackSpeed: number };
  headBlock?: number;
  bite?: Record<string, { stat: string; value: number }>;
}

// ── Состояние вкладки (переживает перерисовку) ───────────────────────────────────────────────────

type Units = 'auto' | 'cm' | 'm' | 'mm';
type FormPick = '' | BladeForm;
/** Одна загруженная модель: разобрана один раз, перемеряется только при смене единиц. */
interface Probe {
  id: number;
  file: string;
  obj?: THREE.Object3D;
  units: Units;
  unitNote: string;
  m?: BladeMeasure | null;
  err?: string;
  edge: 'double' | 'single';
  /** Выбор человека; `null` — по подсказке замера. */
  form: FormPick | null;
  /** Деталь, в которую записать замер (id или ''). */
  bind: string;
  note: string;
  /** Человек переставил пяту и остриё: форма клинка обманула замер (тупоконечный, с тяжёлым концом). */
  flip: boolean;
}

const st = {
  tier: 't2',
  probes: [] as Probe[],
  /** Какие ключи конфига правила ЭТА вкладка — только их и сохраняем (см. `persistBar`). */
  dirty: new Set<string>(),
  seq: 1,
  loading: 0,
  /** Перерисовка ТЕКУЩЕЙ страницы вкладки: долгий разбор FBX не должен рисовать в отсоединённый узел. */
  rerender: null as (() => void) | null,
};

export interface BladesCtx {
  rerender: () => void;
  /** Рабочая копия конфига изменилась — мост к игре во вкладке «Ковка» пересоберётся. */
  changed: () => void;
  io?: CraftIo;
}

// ── Страница ─────────────────────────────────────────────────────────────────────────────────────

export function renderCraftBlades(page: HTMLElement, data: Record<string, unknown>, ctx: BladesCtx): void {
  st.rerender = ctx.rerender;
  const touch = (key: string): void => { st.dirty.add(key); ctx.changed(); ctx.rerender(); };
  // Один реестр на перерисовку — он же проверка схемы: неверная ручка показывает ошибку, а не роняет вкладку.
  let reg: ConfigRegistry | null = null;
  let regErr = '';
  try { const r = new ConfigRegistry(); r.loadAll(data); reg = r; } catch (e) { regErr = e instanceof Error ? e.message : String(e); }
  const craft = (data.balance as { craft?: RawCraft } | undefined)?.craft;

  page.append(legend(craft));
  page.append(persistBar(ctx.io));
  // Вилок нет — почти наверняка старый оверрайд `balance` на сервере (снят до §26): zod дописал пустой список.
  if (!craft?.blade?.brackets?.length) page.append(noBrackets(data, touch));
  if (craft?.blade) page.append(knobs(craft, touch));
  if (regErr) {
    page.append(h('div', 'background:#2a1616;border:1px solid #6b2a2a;border-radius:8px;padding:10px;font-size:12px;color:#f0b0a8;white-space:pre-wrap;max-height:260px;overflow:auto;margin-bottom:12px',
      `Конфиг не проходит схему — таблица не считается, пока ручка не станет верной:\n\n${esc(regErr)}`));
  }
  if (reg) page.append(bladeTable(reg, data, ctx.rerender, touch));
  page.append(probePanel(reg, data, ctx.rerender, touch));
}

function legend(craft: RawCraft | undefined): HTMLElement {
  const d = craft?.strike?.damagePct ?? 0.1, s = craft?.strike?.attackSpeed ?? 0.08;
  return h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.6;color:#cfd0da;margin-bottom:12px',
    `<b style="color:#e39a3c">Клинок из геометрии</b> (docs/CRAFT_WEAPONS.md §26). У меча с измеренной моделью ударная часть берёт статы из самой модели — три рычага. `
    + `<b>Длина</b> ставит клинок на место внутри его вилки: самый короткий в вилке бьёт мельче, но чаще, самый длинный — крупнее, но реже (±${pcShort(d)} урона и ∓${pcShort(s)} скорости на краях, ДПС почти не двигается). `
    + `<b>Ширина</b> разводит мин и макс урона вокруг той же середины: широкий бьёт ровно, узкий вразнобой — среднее и ДПС те же. `
    + `<b>Центр тяжести</b> клинка вместе с навершием даёт одну точку баланса вещи: вес у руки прибавляет блок, вес к концу — шанс кровотечения. `
    + `Статы считаются только из замера (<code>geom</code>); ручная ось детали (<code>axis</code>) задаёт лишь вид процедурной заглушки, пока модели нет.`);
}

/**
 * Кнопки сохранения. Шлём только ключи, которые правила ЭТА вкладка: крутил ручки — уходит `balance`,
 * а `weapon-parts` не переписывается зря (сервер пишет файл целиком, со своим форматированием).
 */
/** Сервер подтвердил запись: эти ключи больше не «правки вкладки» (иначе следующее сохранение слало бы их снова). */
const saved = (keys: string[]) => (): void => { for (const k of keys) st.dirty.delete(k); st.rerender?.(); };

/** Вилок нет: объяснить почему и дать вернуть умолчания из встроенного конфига. */
function noBrackets(data: Record<string, unknown>, touch: (key: string) => void): HTMLElement {
  const box = h('div', 'background:#2a2216;border:1px solid #6b5a2a;border-radius:8px;padding:10px;font-size:12px;color:#e8c890;margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap');
  box.append(h('span', '', '⚠ В рабочей копии нет вилок клинка — длина и ширина ничего не значат. Скорее всего, на сервере лежит старый оверрайд <code>balance</code> (снят до §26): сбрось его или верни вилки и сохрани.'));
  const b = h('button', `${BTN};border-color:#e39a3c`, 'Вернуть вилки по умолчанию');
  b.addEventListener('click', () => {
    const def = new ConfigRegistry(); def.loadAll();
    const bal = data.balance as { craft?: Record<string, unknown> } | undefined;
    if (!bal) return;
    bal.craft = { ...(bal.craft ?? {}), blade: structuredClone(def.get('balance').craft.blade) };
    touch('balance');
  });
  box.append(b);
  return box;
}

function persistBar(io: CraftIo | undefined): HTMLElement {
  const bar = h('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px');
  const keys = [...st.dirty].sort();
  const mk = (text: string, bg: string, title: string, run: (io: CraftIo) => void): HTMLButtonElement => {
    const b = h('button', `${BTN};background:${bg}`, text) as HTMLButtonElement;
    b.title = title;
    b.disabled = !io || !keys.length;
    if (b.disabled) b.style.opacity = '0.5';
    b.addEventListener('click', () => { if (io) run(io); });

    return b;
  };
  bar.append(
    mk('✔ Сохранить на сервере (тест)', '#2a4a2a', 'Оверрайд в БД сервера: действует сразу и переживает рестарт, но в файлы data/*.json (git, деплой) НЕ попадёт.', (x) => x.push(keys, saved(keys))),
    mk('💾 Записать в файл (git)', '#26406a', 'То же плюс запись в data/*.json — правка попадёт в git и на деплой. weapon-parts.json остаётся в формате «строка на деталь»: меняются только строки правленых деталей.', (x) => x.toFile(keys, saved(keys))),
    h('span', 'color:#888;font-size:11px', !io ? 'сохранение недоступно в этом окне' : keys.length ? `правки вкладки: ${keys.join(' + ')}` : 'правок во вкладке нет'),
  );
  const status = h('div', 'min-height:18px;font-size:13px;flex-basis:100%');
  status.id = 'status';   // сюда пишет `setStatus` редактора (main.ts)
  bar.append(status);
  return bar;
}

// ── Ручки ────────────────────────────────────────────────────────────────────────────────────────

function knobs(craft: RawCraft, touch: (key: string) => void): HTMLElement {
  const wrap = h('div', '');
  const box = card(wrap, 'Ручки клинка', 'Любая правка сразу пересчитывает всё ниже — таблицу клинков и замеры. В игру уходит только кнопками сохранения сверху. Ключ `balance.craft.blade` (+ `strike` и `headBlock`).');
  const k = craft.blade!;
  const num = (val: number, step: number, set: (v: number) => void, w = 64): HTMLInputElement => {
    const i = document.createElement('input'); i.type = 'number'; i.step = String(step); i.value = String(val); i.style.cssText = `${INP};width:${w}px;text-align:right`;
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (i.value.trim() === '' || !Number.isFinite(v)) { i.value = String(val); return; }
      set(v); touch('balance');
    });
    return i;
  };

  // Вилки по длине.
  const bt = h('table', 'border-collapse:collapse;font-size:12px;margin-bottom:6px');
  bt.innerHTML = '<tr style="color:#888"><td style="padding:2px 6px">тег</td><td style="padding:2px 6px">вилка</td><td style="padding:2px 6px">от, см</td><td style="padding:2px 6px">до, см</td><td style="padding:2px 6px" title="Клинок этой рабочей ширины бьёт ровно числами базы (разброс ×1).">эталон ширины, см</td></tr>';
  for (const b of k.brackets) {
    const tr = h('tr', '');
    const name = document.createElement('input'); name.value = b.name; name.style.cssText = `${INP};width:110px`;
    name.addEventListener('change', () => { b.name = name.value.trim() || b.name; touch('balance'); });
    const cells: (HTMLElement | string)[] = [h('span', 'color:#9aa;font-family:monospace', esc(b.tag)), name, num(b.lo, 1, (v) => { b.lo = v; }), num(b.hi, 1, (v) => { b.hi = v; }), num(b.width, 0.1, (v) => { b.width = v; })];
    for (const c of cells) { const td = h('td', 'padding:2px 6px'); td.append(c); tr.append(td); }
    bt.append(tr);
  }
  box.append(bt);
  // Зазоры и нахлёсты — предупреждения, не отказ: решение по зазорам ждёт замера настоящих моделей.
  const sorted = [...k.brackets].sort((a, b) => a.lo - b.lo);
  const notes = h('div', 'margin-bottom:8px');
  for (const b of k.brackets) if (b.lo >= b.hi) notes.append(chip(`«${b.name}»: «от» не меньше «до»`, 'Вилка пустая: место по длине у всех её клинков будет 0.'));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    if (b.lo > a.hi) notes.append(chip(`зазор ${a.hi}–${b.lo} см`, `Между «${a.name}» и «${b.name}». Клинок такой длины упрётся в край ближайшей вилки. Решение отложено до замера настоящих моделей (§26).`));
    else if (b.lo < a.hi) notes.append(chip(`нахлёст ${b.lo}–${a.hi} см`, `«${a.name}» и «${b.name}» перекрываются: вилку клинка решает его тег blade, а подсказка замера возьмёт первую.`));
  }
  if (notes.childElementCount) box.append(notes);

  const grid = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px');
  const group = (title: string, foot: string): { add: (label: string, input: HTMLElement, hint?: string) => void } => {
    const g = h('div', 'border:1px solid #23232f;border-radius:6px;padding:7px 8px;display:flex;flex-direction:column;gap:4px');
    g.append(h('div', 'color:#cfd0da;font-weight:600', title));
    const body = h('div', 'display:flex;flex-direction:column;gap:4px');
    g.append(body);
    if (foot) g.append(h('div', 'color:#8a9;font-size:11px;line-height:1.5;margin-top:2px', foot));
    grid.append(g);
    return {
      add: (label, input, hint = '') => {
        const r = h('label', 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center');
        const l = h('span', 'color:#9aa', esc(label)); if (hint) l.title = hint;
        r.append(l, input); body.append(r);
      },
    };
  };

  if (craft.strike) {
    const s = craft.strike;
    const lo = (1 - s.damagePct) * (1 + s.attackSpeed), hi = (1 + s.damagePct) * (1 - s.attackSpeed);
    const g = group('Длина → урон ↔ скорость', `ДПС формы на краях вилки: ×${lo.toFixed(3)} (самый короткий) … ×${hi.toFixed(3)} (самый длинный).`);
    g.add('урон на краю, доля', num(s.damagePct, 0.01, (v) => { s.damagePct = v; }), 'strike.damagePct: множитель удара 1 + это × место в вилке. 0.10 = ±10 %.');
    g.add('скорость на краю, доля', num(s.attackSpeed, 0.01, (v) => { s.attackSpeed = v; }), 'strike.attackSpeed: плоская скорость оружия −это × место. 0.08 = ∓8 %.');
  }
  {
    const sp = k.spread;
    const s2 = clamp(1 - sp.k * Math.log(2), sp.min, sp.max), s05 = clamp(1 + sp.k * Math.log(2), sp.min, sp.max);
    const g = group('Ширина → разброс', `Вдвое шире эталона — разброс ×${s2.toFixed(2)}, вдвое уже — ×${s05.toFixed(2)}. Середина урона не меняется.`);
    g.add('крутизна k', num(sp.k, 0.05, (v) => { sp.k = v; }), 's = clamp(1 − k·ln(ширина / эталон), min, max)');
    g.add('разброс не меньше', num(sp.min, 0.05, (v) => { sp.min = v; }), 'Самый широкий клинок бьёт не ровнее этого.');
    g.add('разброс не больше', num(sp.max, 0.05, (v) => { sp.max = v; }), 'Самый узкий клинок бьёт не разнобойнее этого.');
  }
  {
    const b = k.balance;
    const bite = craft.bite?.bleed?.value;
    const g = group('Центр тяжести + навершие → блок ↔ кровотечение',
      `ЦТ ${(b.center - b.span).toFixed(2)} и ближе к руке — клинок +1 (упор), ${(b.center + b.span).toFixed(2)} и дальше — −1 (укус). Точка баланса вещи ±1 даёт блок ±${pcShort(craft.headBlock ?? 0)}${bite !== undefined ? ` и шанс кровотечения ×(1 ∓ ${bite})` : ''}.`);
    g.add('центр (ЦТ = 0)', num(b.center, 0.01, (v) => { b.center = v; }), 'Центр площади силуэта, при котором клинок нейтрален: 0 — у рукояти, 1 — у острия.');
    g.add('шаг до ±1', num(b.span, 0.01, (v) => { b.span = v; }), 'Насколько ЦТ должен уйти от центра, чтобы баланс клинка упёрся в ±1.');
    g.add('доля клинка', num(b.bladeShare, 0.05, (v) => { b.bladeShare = v; }), 'Точка баланса вещи = доля × клинок + (1 − доля) × ось навершия.');
    if (craft.headBlock !== undefined) g.add('блок на краю, доля', num(craft.headBlock, 0.005, (v) => { craft.headBlock = v; }), 'craft.headBlock: блок ± это × точка баланса вещи. 0.02 = ±2 %.');
  }
  {
    const f = k.forms;
    const g = group('Однолезвийные формы', 'Сдвиг места по длине (в шагах вилки) и баланса. Оба рычага зажаты в ±1.');
    g.add('фальшион: длина', num(f.falchion.length, 0.1, (v) => { f.falchion.length = v; }), 'Тяжелее: удар крупнее, взмахов меньше.');
    g.add('фальшион: баланс', num(f.falchion.balance, 0.1, (v) => { f.falchion.balance = v; }), 'Рубит концом: сдвиг к укусу.');
    g.add('сабля: длина', num(f.sabre.length, 0.1, (v) => { f.sabre.length = v; }), 'Легче: взмахов больше.');
    g.add('сабля: баланс', num(f.sabre.balance, 0.1, (v) => { f.sabre.balance = v; }), 'Ходит у руки: сдвиг к упору.');
  }
  {
    const dt = k.detect;
    const g = group('Подсказка формы при замере', 'Только у однолезвийных: заточку по сетке не видно, её называет человек.');
    g.add('расширение к концу ≥ (фальшион)', num(dt.flare, 0.01, (v) => { dt.flare = v; }), 'Наибольшая ширина на 67–87 % длины к медиане на 33–67 %.');
    g.add('изгиб спинки ≥, % (сабля)', num(dt.spine, 0.1, (v) => { dt.spine = v; }), 'Снос линии обуха от прямой, % длины.');
  }
  box.append(grid);
  return wrap;
}

// ── Таблица клинков ──────────────────────────────────────────────────────────────────────────────

interface BladeRow {
  p: WeaponPart;
  bs: BladeStats;
  item?: Item;
  ref?: Item;
  reason?: string;
  tierNote: string;
  balance: number;
  ownBlock: number;
  statusKind?: string;
}

/** Вещь из этого клинка и нейтральных деталей семейства — тем же ядром, что окно ковки. */
function craftRow(reg: ConfigRegistry, p: WeaponPart, bs: BladeStats, ti: number): BladeRow {
  const tiers = craftTiers(reg);
  const hands = p.hands[0] ?? familiesOf(reg, CLS)[0] ?? 1;
  const out: BladeRow = { p, bs, tierNote: '', balance: 0, ownBlock: 0 };
  const parts = defaultParts(reg, CLS, hands, 1);
  if (!parts) { out.reason = 'у семейства нет полного набора деталей'; return out; }
  parts.strike = { id: p.id, step: clampStep(p, 1) };
  const base = reg.get('items.base').find((b) => b.id === baseOfKeyPart(reg, CLS, hands, p));
  let t = ti;
  if (base) {
    const r = baseTierRange(reg, base);
    const c = clamp(ti, r.lo, r.hi);
    if (c !== ti) { t = c; out.tierNote = `${base.name} бывает только ${tiers[r.lo]?.id}–${tiers[r.hi]?.id}: посчитано на ${tiers[c]?.id}`; }
    out.ownBlock = flat(base, 'blockChance');
  }
  const pv = craftWeapon(reg, { weaponClass: CLS, hands, parts }, { atTier: t });
  if (!pv.ok || !pv.item) { out.reason = pv.reason ?? 'не куётся'; return out; }
  out.item = pv.item;
  out.balance = pv.bake?.balance ?? 0;
  out.statusKind = pv.bake?.statusKind;
  const tier = tiers[t];
  if (base && tier) out.ref = buildCraftShell(base, tier, reg.get('balance').maxTotalRequirement);
  return out;
}

function bladeTable(reg: ConfigRegistry, data: Record<string, unknown>, rerender: () => void, touch: (key: string) => void): HTMLElement {
  const kc = reg.get('balance').craft;
  const k = kc.blade;
  const tiers = craftTiers(reg);
  let ti = tiers.findIndex((t) => t.id === st.tier);
  if (ti < 0) ti = Math.min(2, tiers.length - 1);
  const fams = familiesOf(reg, CLS);
  const heads = [...new Set(fams.map((hh) => { const d = defaultParts(reg, CLS, hh, 1); return d ? partById(reg, d.head.id)?.name ?? d.head.id : ''; }).filter(Boolean))];

  const wrap = h('div', '');
  const box = card(wrap, 'Клинки мечей',
    `Каждая ударная часть меча с замером, по вилкам. Вещь собрана тем же ядром, что окно ковки (<code>craftWeapon</code>): этот клинок + нейтральные детали семейства (навершие ${heads.map((x) => `«${esc(x)}»`).join(' / ') || '—'}), материал ступени 1, ступень вещи — выбранная. `
    + 'Урон — середина вилки базы, уже с множителем удара. ДПС — на бумаге, к эталону вилки: середина урона × множитель × скорость оружия против чисел базы той же ступени.');

  const bar = h('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap');
  bar.append(h('span', 'color:#9aa', 'Ступень вещи'), select(tiers.map((t) => [t.id, `${t.id} ${t.name}`]), tiers[ti]?.id ?? '', (v) => { st.tier = v; rerender(); }));
  box.append(bar);

  const all = reg.get('weapon-parts').filter((p) => p.slot === 'strike' && (p.classes as string[]).includes(CLS));
  const off = all.filter((p) => p.enabled === false);
  const on = all.filter((p) => p.enabled !== false);
  const noGeom = on.filter((p) => !p.geom);

  // Группы по вилке: в порядке конфига, в конце — клинки без вилки.
  const groups = new Map<string, BladeRow[]>();
  for (const b of k.brackets) groups.set(b.tag, []);
  for (const p of on) {
    const bs = bladeStatsOf(k, p);
    if (!bs) continue;
    const key = bs.bracket?.tag ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(craftRow(reg, p, bs, ti));
  }

  const statusName = ((): string => {
    for (const rows of groups.values()) for (const r of rows) if (r.statusKind) { const d = reg.get('debuffs').find((x) => x.id === r.statusKind); if (d) return `${d.icon} ${d.name.toLowerCase()}`; }
    return 'статус';
  })();
  const COLS: [string, string][] = [
    ['клинок', 'Имя детали; подсказка — описание'], ['длина', 'Длина клинка, см'], ['ширина', 'Рабочая ширина: медиана на 25–87 % длины, см'], ['ЦТ', 'Центр площади силуэта: 0 — у рукояти, 1 — у острия'],
    ['расш.', 'Расширение к концу (фальшион от порога подсказки)'], ['спинка', 'Изгиб спинки, % длины (сабля от порога подсказки)'], ['форма', 'Однолезвийная форма детали: пишется в weapon-parts'],
    ['место', 'Место по длине в вилке, n_L: −1 самый короткий, +1 самый длинный'], ['ось', 'Ось удара после поправки формы: множитель удара и скорость'], ['разброс', 'Разброс мин–макс от ширины: ×1 — числа базы'],
    ['n_B', 'Баланс самого клинка по ЦТ: +1 вес у руки, −1 к концу'], ['баланс', 'Точка баланса вещи: клинок + навершие + форма, ±1'],
    ['урон', 'Мин–макс середины вилки базы, уже с множителем удара'], ['скорость', 'Собственная скорость оружия: (1 + плоская) × (1 + %)'], ['блок', 'Шанс блока вещи'],
    [statusName, 'Шанс статуса на удар: база прока × (1 + бонус шанса от баланса)'], ['ДПС', 'ДПС на бумаге к эталону вилки (числа базы, множитель 1)'], ['заметки', ''],
  ];

  const t = h('table', 'border-collapse:collapse;font-size:12px;width:100%');
  const hr = h('tr', 'color:#888');
  for (const [label, title] of COLS) { const c = h('td', `${TD};font-family:sans-serif;${label === 'клинок' || label === 'заметки' ? 'text-align:left' : ''}`, esc(label)); if (title) c.title = title; hr.append(c); }
  t.append(hr);
  const rawParts = (data['weapon-parts'] as RawPart[] | undefined) ?? [];
  const typeRow = reg.get('weapon-types').find((x) => x.id === CLS);

  for (const [tag, rows] of groups) {
    if (!rows.length) continue;
    rows.sort((a, b) => b.bs.axis - a.bs.axis || a.p.id.localeCompare(b.p.id));
    const br = k.brackets.find((b) => b.tag === tag);
    const baseName = br ? reg.get('items.base').find((b) => b.id === typeRow?.bases.find((x) => x.key === br.tag)?.base)?.name ?? '' : '';
    const axes = rows.map((r) => r.bs.axis);
    const lo = Math.min(...axes), hi = Math.max(...axes);
    const miss = [hi < PALETTE_EDGE ? 'тяжёлого' : '', lo > -PALETTE_EDGE ? 'лёгкого' : ''].filter(Boolean);
    const gh = h('tr', '');
    const gc = h('td', 'padding:8px 6px 3px;border-top:1px solid #2c2c3a');
    gc.setAttribute('colspan', String(COLS.length));
    gc.append(h('span', 'color:#e39a3c;font-weight:600', br ? `${esc(br.name)} · ${br.lo}–${br.hi} см · эталон ширины ${br.width} см` : 'Без вилки (тег blade не найден)'));
    if (baseName) gc.append(h('span', 'color:#777;margin-left:8px', `база: ${esc(baseName)} · клинков ${rows.length}`));
    const lamp = h('span', 'margin-left:12px;display:inline-flex;gap:5px;align-items:center');
    lamp.append(h('span', `width:9px;height:9px;border-radius:50%;background:${miss.length ? '#c8a048' : '#8aa84a'}`),
      h('span', `color:${miss.length ? '#e8b070' : '#9cc08a'}`, `палитра ${sg(lo)}…${sg(hi)}${miss.length ? `: нет ${miss.join(' и ')} клинка` : ''}`));
    lamp.title = `По оси удара (после формы). Есть тяжёлый — ось ≥ +${PALETTE_EDGE}, лёгкий — ≤ −${PALETTE_EDGE}.`;
    gc.append(lamp);
    gh.append(gc);
    t.append(gh);

    for (const r of rows) t.append(bladeRowEl(reg, r, rawParts, touch));
  }
  const scroll = h('div', 'overflow-x:auto');
  scroll.append(t);
  box.append(scroll);
  if (noGeom.length) box.append(h('div', 'color:#888;font-size:11px;margin-top:8px', `Без замера (живут на ручной оси): ${noGeom.map((p) => esc(p.name)).join(', ')}.`));
  if (off.length) box.append(h('div', 'color:#666;font-size:11px;margin-top:4px', `Выключены в конфиге и не показаны: ${off.map((p) => esc(p.name)).join(', ')}.`));
  return wrap;
}

function bladeRowEl(reg: ConfigRegistry, r: BladeRow, rawParts: RawPart[], touch: (key: string) => void): HTMLElement {
  const kc = reg.get('balance').craft;
  const k = kc.blade;
  const { p, bs } = r;
  const g = p.geom!;
  const tr = h('tr', 'border-top:1px solid #1f1f29');
  const td = (html: string, css = '', title = ''): HTMLElement => { const c = h('td', `${TD};${css}`, html); if (title) c.title = title; tr.append(c); return c; };

  const nm = td(`${esc(p.name)} <span style="color:#666;font-size:10.5px">${esc(p.id)}</span>`, 'text-align:left;font-family:sans-serif');
  nm.title = [p.lore, p.ref].filter(Boolean).join('\n');
  td(g.len.toFixed(0));
  td(g.width.toFixed(2), bs.bracket && g.width > bs.bracket.width ? 'color:#cfc3a0' : 'color:#a8b4c8', bs.bracket ? `эталон вилки ${bs.bracket.width}` : '');
  td(g.bal.toFixed(3));
  td(g.flare.toFixed(2), g.flare >= k.detect.flare ? 'color:#e39a3c' : '');
  td(g.spine.toFixed(2), g.spine >= k.detect.spine ? 'color:#e39a3c' : '');

  const fc = h('td', `${TD}`);
  fc.append(select([['', '—'], ['falchion', FORM_NAME.falchion], ['sabre', FORM_NAME.sabre]], bladeFormOf(p) ?? '', (v) => {
    const raw = rawParts.find((x) => x.id === p.id);
    if (!raw) return;
    raw.form = v;
    touch('weapon-parts');
  }, 'padding:1px 4px;font-size:11px'));
  tr.append(fc);

  td(sg(bs.place), `color:${axisColor(bs.place)}`);
  td(sg(bs.axis), `color:${axisColor(bs.axis)};font-weight:600`, bs.form ? `место ${sg(bs.place)} + форма ${FORM_NAME[bs.form]}` : '');
  td(`×${bs.spread.toFixed(2)}`, bs.spread <= 0.8 ? 'color:#9cc08a' : bs.spread >= 1.2 ? 'color:#e8b070' : '');
  td(sg(bs.balance), `color:${axisColor(bs.balance)}`);

  if (r.item) {
    const it = r.item;
    const dm = it.damageMult ?? 1;
    const mn = flat(it, 'minDamage'), mx = flat(it, 'maxDamage');
    const rp = it.rollPreview;
    const rl = (x: [number, number] | undefined): string => (x ? `${Math.round(x[0] * dm)}–${Math.round(x[1] * dm)}` : '—');
    td(sg(r.balance), `color:${axisColor(r.balance)}`, bs.formBalance ? `в т.ч. форма ${sg(bs.formBalance)}` : '');
    td(`${Math.round(mn * dm)}–${Math.round(mx * dm)}`, '', `множитель удара ×${dm.toFixed(3)}${r.tierNote ? `\n${r.tierNote}` : ''}\nбросок: мин ${rl(rp?.minDamage)}, макс ${rl(rp?.maxDamage)}`);
    td(`×${weaponSpeedOf(it).toFixed(3)}`);
    const block = flat(it, 'blockChance');
    td(pc(block), block <= 0 ? 'color:#c85a48' : '');
    const bite = r.statusKind ? kc.bite[r.statusKind] : undefined;
    const deb = r.statusKind ? reg.get('debuffs').find((d) => d.id === r.statusKind) : undefined;
    const chance = (deb?.weapon?.chance ?? 0) * (1 + (bite ? flat(it, bite.stat) : 0));
    td(deb ? pc(chance) : '—', '', deb ? `база прока ${pc(deb.weapon.chance)} × (1 ${sg(bite ? flat(it, bite.stat) : 0)})` : 'у базы нет грани');
    if (r.ref) {
      const d = (midDamage(it) * dm * weaponSpeedOf(it)) / Math.max(1e-9, midDamage(r.ref) * weaponSpeedOf(r.ref)) - 1;
      // Формула оси отдельно: разница с ней — округление урона на ступени (узкий клинок на мелких числах).
      const fx = (1 + kc.strike.damagePct * bs.axis) * (1 - kc.strike.attackSpeed * bs.axis) - 1;
      td(`${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} %`, `color:${Math.abs(d) <= 0.03 ? '#9cc08a' : '#e8b070'}`,
        `по формуле оси ${sg(fx * 100, 1)} %, остальное — округление урона ступени (середина ${midDamage(it)} против ${midDamage(r.ref)} у эталона)`);
    } else td('—');
  } else {
    const c = td(esc(r.reason ?? 'не куётся'), 'text-align:left;color:#c85a48;font-family:sans-serif;white-space:normal');
    c.setAttribute('colspan', '6');
  }

  // Заметки.
  const notes = h('td', 'padding:3px 6px');
  const sug = suggestBracket(k, g.len);
  if (bs.outOfBracket) {
    const where = sug.bracket && sug.bracket.tag !== p.tags.blade && !sug.gap ? ` Длина просится в «${sug.bracket.name}».` : '';
    notes.append(chip('вне вилки', bs.bracket ? `${g.len} см вне «${bs.bracket.name}» (${bs.bracket.lo}–${bs.bracket.hi}): место упёрлось в край.${where}` : `Тег blade «${p.tags.blade ?? ''}» не совпал ни с одной вилкой: длина и ширина не считаются.${where}`));
  }
  if (sug.gap) notes.append(chip('в зазоре между вилками', `Ни одна вилка не берёт ${g.len} см. Ближайшая — «${sug.bracket?.name ?? '—'}», ${sug.dist} см до края.`));
  const sf = suggestForm(k, g, p.tags.edge);
  if (sf !== bladeFormOf(p)) notes.append(chip(`подсказка формы: ${sf ? FORM_NAME[sf] : 'обычный'}`, `Замер: расширение ${g.flare}, изгиб спинки ${g.spine} %; лезвие ${p.tags.edge === 'single' ? 'одно' : 'двойное'} (тег edge). Форму решает человек.`));
  if (r.item && r.ownBlock + kc.headBlock * r.balance < 0) {
    notes.append(chip('блок упёрся в 0', `У базы ${pc(r.ownBlock)} блока, а баланс вещи ${sg(r.balance)} снимает ${pc(-kc.headBlock * r.balance)}: минус режется о ноль, и укус достаётся бесплатно.`));
  }
  if (r.tierNote) notes.append(chip('ступень прижата', r.tierNote, false));
  tr.append(notes);
  return tr;
}

// ── Замер моделей ────────────────────────────────────────────────────────────────────────────────

const UNIT: Record<Exclude<Units, 'auto'>, number> = { cm: 1, m: 100, mm: 0.1 };

/** Перемерить: единицы (авто — по самой длинной стороне), затем `measureBlade` с разворотом по длинной оси. */
function measureProbe(p: Probe): void {
  if (!p.obj) return;
  let f = 1;
  p.unitNote = '';
  if (p.units === 'auto') {
    const size = new THREE.Box3().setFromObject(p.obj).getSize(new THREE.Vector3());
    const L = Math.max(size.x, size.y, size.z);
    if (L > 0 && L < 5) { f = 100; p.unitNote = `длинная сторона ${L.toFixed(2)} — похоже на метры: ×100`; }
    // Самая длинная вилка — 150 см: «клинок» длиннее 2.5 м — это миллиметры (45-сантиметровый акинак = 450 мм).
    else if (L > 250) { f = 0.1; p.unitNote = `длинная сторона ${L.toFixed(0)} — похоже на миллиметры: ×0.1`; }
  } else f = UNIT[p.units];
  const wrap = new THREE.Group();
  wrap.scale.setScalar(f);
  wrap.add(p.obj);
  try {
    p.m = measureBlade(wrap, { orient: true, flip: p.flip });
    p.err = p.m ? undefined : 'в модели нет треугольников — мерить нечего';
  } catch (e) {
    p.m = null;
    p.err = `замер упал: ${e instanceof Error ? e.message : String(e)}`;
  }
  wrap.remove(p.obj);
}

/** Какую деталь привязать по имени файла: id, тег `type` или имя. Короткие — только целым словом, берём самое длинное совпадение. */
function guessBind(file: string, parts: RawPart[]): string {
  const base = file.toLowerCase().replace(/\.[^.]+$/, '');
  const words = new Set(base.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  let best = '', bestLen = 0;
  for (const p of parts) {
    for (const c of [p.id, p.tags?.type, p.name]) {
      if (!c) continue;
      const s = c.toLowerCase();
      const hit = s.length >= 4 ? base.includes(s) : words.has(s);
      if (hit && s.length > bestLen) { best = p.id; bestLen = s.length; }
    }
  }
  return best;
}

const swordStrikes = (data: Record<string, unknown>): RawPart[] =>
  ((data['weapon-parts'] as RawPart[] | undefined) ?? []).filter((p) => p.slot === 'strike' && (p.classes ?? []).includes(CLS));

async function loadFiles(files: File[], parts: RawPart[]): Promise<void> {
  const fresh: Probe[] = files.map((f) => {
    const bind = guessBind(f.name, parts);
    const bound = parts.find((x) => x.id === bind);
    // Форма, выставленная человеком в детали (сабля-заглушка почти прямая), не должна слететь при записи замера.
    return { id: st.seq++, file: f.name, units: 'auto', unitNote: '', edge: bound?.tags?.edge === 'single' ? 'single' : 'double', form: formOfPart(bound), bind, note: '', flip: false };
  });
  st.probes.push(...fresh);
  st.loading += files.length;
  st.rerender?.();
  // Загрузчик моделей (FBX тяжёлый) — только когда он понадобился, а не в стартовом бандле редактора.
  let parse: ((buf: ArrayBuffer, ext: string) => Promise<THREE.Object3D>) | null = null;
  let importErr = '';
  try { parse = (await import('@dm/client/render3d/modelAssets.js')).parseModel; } catch (e) { importErr = e instanceof Error ? e.message : String(e); }
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!, p = fresh[i]!;
    const ext = f.name.toLowerCase().split('.').pop() ?? '';
    try {
      if (!parse) throw new Error(`загрузчик моделей не поднялся: ${importErr}`);
      if (!['glb', 'gltf', 'fbx'].includes(ext)) throw new Error(`формат .${ext} не читаю — нужен .glb, .gltf или .fbx`);
      const buf = await f.arrayBuffer();
      if (ext === 'gltf' && externalBuffers(buf)) throw new Error('.gltf с отдельным .bin не читаю — экспортируй одним файлом .glb (или .gltf со встроенными буферами)');
      p.obj = await parse(buf, ext);
      measureProbe(p);
    } catch (e) {
      p.err = `не разобрал файл: ${e instanceof Error ? e.message : String(e)}`;
    }
    st.loading--;
  }
  st.rerender?.();
}

/** У .gltf буферы во внешних файлах (не data:)? Такой файл без соседей не разобрать — сразу честный отказ. */
function externalBuffers(buf: ArrayBuffer): boolean {
  try {
    const j = JSON.parse(new TextDecoder().decode(buf)) as { buffers?: { uri?: string }[] };
    return (j.buffers ?? []).some((b) => !!b.uri && !b.uri.startsWith('data:'));
  } catch { return false; }
}

/** Форма, записанная в детали (или «по подсказке», если её нет). */
const formOfPart = (p: RawPart | undefined): FormPick | null =>
  p?.form === 'falchion' || p?.form === 'sabre' ? p.form : null;

/** Силуэт по 24 станциям, пята слева. Масштаб один на все строки (длина 1.2 px/см, ширина 3 px/см) — чтобы сравнивать. */
function silhouette(m: BladeMeasure): string {
  const wMax = Math.max(1e-6, ...m.prof);
  const X = Math.min(1.2, 190 / Math.max(1, m.len)), Y = Math.min(3, 36 / wMax);
  const pad = 4, W = Math.round(m.len * X + 2 * pad), H = Math.round(wMax * Y + 2 * pad), cy = H / 2;
  const N = m.prof.length;
  const f1 = (x: number): string => x.toFixed(1);
  const top: string[] = [`${f1(pad)},${f1(cy - ((m.prof[0] ?? 0) / 2) * Y)}`];
  const bot: string[] = [`${f1(pad)},${f1(cy + ((m.prof[0] ?? 0) / 2) * Y)}`];
  m.prof.forEach((w, s) => {
    const x = pad + ((s + 0.5) / N) * m.len * X;
    top.push(`${f1(x)},${f1(cy - (w / 2) * Y)}`);
    bot.push(`${f1(x)},${f1(cy + (w / 2) * Y)}`);
  });
  const tip = `${f1(pad + m.len * X)},${f1(cy)}`;
  const bx = pad + m.bal * m.len * X;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block"><polygon points="${[...top, tip, ...bot.reverse()].join(' ')}" fill="#4d5770" stroke="#aab4c8" stroke-width="0.8"/>`
    + `<line x1="${f1(bx)}" y1="1" x2="${f1(bx)}" y2="${H - 1}" stroke="#e39a3c" stroke-width="1" stroke-dasharray="2 2"><title>ЦТ ${m.bal}</title></line></svg>`;
}

function probePanel(reg: ConfigRegistry | null, data: Record<string, unknown>, rerender: () => void, touch: (key: string) => void): HTMLElement {
  const wrap = h('div', '');
  const box = card(wrap, 'Замер моделей',
    'Договор модели: только клинок, сантиметры, пята у начала координат, клинок по −Y, полотно в плоскости XY, лезвие в +X. Не по договору — развернём по самой длинной оси (и предупредим). '
    + 'Метры и миллиметры угадываются по размеру, единицы можно задать руками. Однолезвийность по сетке не видна — её выбираешь ты.');
  const parts = swordStrikes(data);
  const bar = h('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px');
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true; inp.accept = '.glb,.gltf,.fbx'; inp.style.cssText = 'font-size:12px;color:#cfd0da';
  inp.addEventListener('change', () => {
    const files = [...(inp.files ?? [])];
    inp.value = '';
    if (files.length) void loadFiles(files, parts);
  });
  bar.append(inp);
  if (st.probes.length) {
    const clr = h('button', BTN, 'Убрать все замеры');
    clr.addEventListener('click', () => { st.probes = []; rerender(); });
    bar.append(clr);
  }
  if (st.loading > 0) bar.append(h('span', 'color:#9aa', `разбираю… (${st.loading})`));
  box.append(bar);
  for (const p of st.probes) box.append(probeRow(reg, data, parts, p, rerender, touch));
  return wrap;
}

function probeRow(reg: ConfigRegistry | null, data: Record<string, unknown>, parts: RawPart[], p: Probe, rerender: () => void, touch: (key: string) => void): HTMLElement {
  const row = h('div', 'border-top:1px solid #23232f;padding:8px 0;display:grid;grid-template-columns:minmax(170px,210px) minmax(200px,240px) minmax(0,1fr);gap:12px;align-items:start');

  // 1 · Файл: имя, треугольники, единицы, предупреждения.
  const c1 = h('div', 'display:flex;flex-direction:column;gap:4px;min-width:0');
  const title = h('div', 'display:flex;gap:6px;align-items:baseline');
  title.append(h('b', 'word-break:break-all', esc(p.file)));
  const rm = h('button', `${BTN};padding:0 6px;font-size:11px`, '✕'); rm.title = 'Убрать замер';
  rm.addEventListener('click', () => { st.probes = st.probes.filter((x) => x !== p); rerender(); });
  title.append(rm);
  c1.append(title);
  if (p.err) { c1.append(h('div', 'color:#c85a48', esc(p.err))); row.append(c1); return row; }
  if (!p.m) { c1.append(h('div', 'color:#9aa', 'разбираю…')); row.append(c1); return row; }
  const m = p.m;
  c1.append(h('div', 'color:#888', `треугольников: ${m.tris}`));
  const un = h('label', 'display:flex;gap:6px;align-items:center;color:#9aa');
  un.append('единицы', select([['auto', 'авто'], ['cm', 'см'], ['m', 'метры ×100'], ['mm', 'мм ×0.1']], p.units, (v) => { p.units = v as Units; measureProbe(p); rerender(); }, 'padding:1px 4px;font-size:11px'));
  c1.append(un);
  const fl = h('label', 'display:flex;gap:6px;align-items:center;color:#9aa;cursor:pointer');
  const fc = document.createElement('input'); fc.type = 'checkbox'; fc.checked = p.flip;
  fc.addEventListener('change', () => { p.flip = fc.checked; measureProbe(p); rerender(); });
  fl.title = 'Пята и остриё определяются по форме (узкий конец — остриё). Тупоконечный клинок или тяжёлый конец могут обмануть — тогда переставь руками и сверь силуэт.';
  fl.append(fc, 'перевернуть пяту и остриё');
  c1.append(fl);
  for (const w of [p.unitNote, ...m.warn].filter(Boolean)) c1.append(h('div', 'color:#e8b070;font-size:11px;line-height:1.4', `⚠ ${esc(w)}`));
  row.append(c1);

  // 2 · Силуэт и числа замера.
  const c2 = h('div', 'display:flex;flex-direction:column;gap:4px');
  c2.append(h('div', 'background:#0f0f16;border:1px solid #23232f;border-radius:4px;padding:4px;overflow:hidden', silhouette(m)));
  c2.append(h('div', 'font-family:monospace;font-size:11.5px;line-height:1.55;color:#cfd0da',
    `длина <b>${m.len}</b> см · ширина <b>${m.width}</b> (макс ${m.wMax})<br>ЦТ <b>${m.bal}</b> · расширение <b>${m.flare}</b> · спинка <b>${m.spine}</b> %<br><span style="color:#777">толщина ${m.thick} см</span>`));
  row.append(c2);

  // 3 · Что из этого выйдет и куда записать.
  const c3 = h('div', 'display:flex;flex-direction:column;gap:5px;min-width:0');
  row.append(c3);
  if (!reg) { c3.append(h('div', 'color:#c85a48', 'Конфиг не проходит схему — подсказки и статы появятся, когда ручки станут верными.')); return row; }
  const kc = reg.get('balance').craft;
  const k = kc.blade;
  const sug = suggestBracket(k, m.len);
  const bound = parts.find((x) => x.id === p.bind);
  const boundTag = bound?.tags?.blade;
  // Класс клинка — по ДЛИНЕ (решение 24.09); тег детали учитывается, только если длина вне всех вилок.
  const tag = (sug.bracket && !sug.gap ? sug.bracket.tag : boundTag || sug.bracket?.tag) || '';
  const sf = suggestForm(k, m, p.edge === 'single' ? 'single' : undefined);
  const form: FormPick = p.form ?? sf ?? '';
  const g = geomOf(m);
  const bs = bladeStatsOf(k, { slot: 'strike', tags: { blade: tag, ...(p.edge === 'single' ? { edge: 'single' } : {}) }, geom: g, form });

  const sugLine = h('div', '');
  sugLine.append(h('span', 'color:#9aa', 'Вилка: '));
  if (!sug.bracket) sugLine.append(h('span', 'color:#c85a48', 'вилок в конфиге нет'));
  else if (sug.gap) sugLine.append(chip(`зазор, ближайшая «${sug.bracket.name}» (${sug.bracket.lo}–${sug.bracket.hi}, ${sug.dist} см до края)`, 'Ни одна вилка не берёт такую длину: клинок упрётся в край ближайшей.'));
  else sugLine.append(h('b', '', `«${esc(sug.bracket.name)}» ${sug.bracket.lo}–${sug.bracket.hi} см`));
  if (boundTag && sug.bracket && !sug.gap && boundTag !== sug.bracket.tag) {
    const bn = k.brackets.find((b) => b.tag === boundTag)?.name ?? boundTag;
    sugLine.append(' ', chip(`сейчас «${bn}» → станет «${sug.bracket.name}»`, `Класс клинка задаёт длина. «Записать geom» переставит тег blade детали на «${sug.bracket.tag}», а с ним и базу, на которой деталь куётся.`));
  }
  c3.append(sugLine);

  const picks = h('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap');
  picks.append(h('span', 'color:#9aa', 'Лезвие'), select([['double', 'двулезвийный'], ['single', 'однолезвийный']], p.edge, (v) => { p.edge = v === 'single' ? 'single' : 'double'; rerender(); }, 'padding:1px 4px;font-size:11px'));
  picks.append(h('span', 'color:#9aa', 'Форма'), select([['auto', `по подсказке: ${sf ? FORM_NAME[sf] : 'обычный'}`], ['', 'обычный'], ['falchion', FORM_NAME.falchion], ['sabre', FORM_NAME.sabre]], p.form ?? 'auto', (v) => { p.form = v === 'auto' ? null : (v as FormPick); rerender(); }, 'padding:1px 4px;font-size:11px'));
  c3.append(picks);

  if (bs) {
    const dm = 1 + kc.strike.damagePct * bs.axis, spd = 1 - kc.strike.attackSpeed * bs.axis;
    c3.append(h('div', 'font-family:monospace;font-size:11.5px;line-height:1.55',
      `место <b style="color:${axisColor(bs.place)}">${sg(bs.place)}</b> · ось <b style="color:${axisColor(bs.axis)}">${sg(bs.axis)}</b> → урон ×${dm.toFixed(3)}, скорость ×${spd.toFixed(3)}<br>`
      + `разброс ×${bs.spread.toFixed(2)} · баланс клинка <b style="color:${axisColor(bs.balance)}">${sg(bs.balance)}</b>${bs.formBalance ? ` · форма ${sg(bs.formBalance)}` : ''}`));
    c3.append(h('div', 'color:#cfc3a0;font-size:11.5px', esc(bladeCaption(bs))));
    if (bs.outOfBracket && !sug.gap) c3.append(chip('вне вилки', 'Длина вне вилки детали: место упёрлось в край.'));
  }

  // Привязка и запись.
  const bindRow = h('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px');
  bindRow.append(h('span', 'color:#9aa', 'Привязать к детали'));
  bindRow.append(select([['', '— не привязан —'], ...parts.map((x): [string, string] => [x.id, `${x.name} (${x.id})${x.geom ? ' · есть замер' : ''}`])], p.bind, (v) => {
    p.bind = v;
    const np = parts.find((x) => x.id === v);
    if (np) { p.edge = np.tags?.edge === 'single' ? 'single' : 'double'; p.form = formOfPart(np); }
    rerender();
  }, 'max-width:260px;padding:1px 4px;font-size:11px'));
  const wr = h('button', `${BTN};border-color:#e39a3c`, 'Записать geom в деталь') as HTMLButtonElement;
  wr.disabled = !bound;
  if (!bound) wr.style.opacity = '0.5';
  wr.title = 'Кладёт замер (и выбранную форму) в строку weapon-parts рабочей копии и ставит класс клинка (тег blade) по длине. Сохранить — кнопками сверху.';
  wr.addEventListener('click', () => {
    const raw = ((data['weapon-parts'] as RawPart[] | undefined) ?? []).find((x) => x.id === p.bind);
    if (!raw) return;
    raw.geom = geomOf(m);
    raw.form = form;
    const tags = (raw.tags ??= {});
    const was = tags.blade;
    if (sug.bracket && (!sug.gap || !tags.blade)) tags.blade = sug.bracket.tag;
    if (p.edge === 'single') tags.edge = 'single';
    else if (tags.edge === 'single') delete tags.edge;
    const moved = was && was !== tags.blade ? ` · класс «${k.brackets.find((b) => b.tag === was)?.name ?? was}» → «${sug.bracket?.name ?? tags.blade}»` : '';
    p.note = `✓ записано в «${raw.name}»${moved} — сохрани кнопками сверху`;
    touch('weapon-parts');
  });
  bindRow.append(wr);
  c3.append(bindRow);
  if (bound?.geom) {
    const o = bound.geom;
    c3.append(h('div', 'color:#777;font-size:11px', `в детали сейчас: ${o.len} см · ширина ${o.width} · ЦТ ${o.bal} · расширение ${o.flare} · спинка ${o.spine} %${bound.form ? ` · ${FORM_NAME[bound.form as BladeForm] ?? bound.form}` : ''}`));
  }
  if (p.note) c3.append(h('div', 'color:#9cc08a;font-size:11.5px', esc(p.note)));
  return row;
}
