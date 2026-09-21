import {
  CRAFT_SLOT_LIST, CRAFT_SLOT_ROLE, anatomyOf, craftTierRange, craftTiers, craftWeapon, defaultParts,
  enchantCost, makePlayerModel, materialBand, partById, variantsFor, weaponCard,
  type ConfigRegistry, type CraftInput, type CraftJournal, type CraftParts, type CraftSlot, type Item,
  type Rarity, type SaveState, type WeaponCard,
} from '@dm/shared';
import type { App } from '../../core/app.js';
import { COLORS, FONT_TITLE, button, mk } from '../../ui/kit.js';
import { itemTooltipHtml } from '../inventory/itemView.js';

/**
 * ОКНО КОВКИ ОРУЖИЯ ИЗ ДЕТАЛЕЙ (docs/CRAFT_WEAPONS.md §17).
 *
 * ⭐ Это ИГРОВАЯ панель, а не макет. Сегодня её показывает песочница конфиг-редактора, завтра —
 * кузница города, и между ними меняется только ХОЗЯИН (`CraftHost`): в песочнице ковка идёт
 * локально тем же ядром (`craftWeapon`), в игре — командой серверу, который зовёт то же ядро.
 * Сама панель ни сети, ни сейва не трогает — поэтому переносится без правок.
 *
 * Всё, что окно показывает, считает ядро `@dm/shared`: вещь — `craftWeapon`, характеристики —
 * `weaponCard` на модели героя (`makePlayerModel`), те же функции, что у боя. Своих формул здесь нет.
 */

export interface CraftHost {
  /** Сырьё, доступное ковке: в игре — сумка и сундук, в песочнице — её кошелёк. */
  wallet(): Record<string, number>;
  gold(): number;
  journal(): CraftJournal;
  /** Сохранённый сейв героя: по нему считается «в руках → скую». */
  save(): SaveState;
  craft(input: CraftInput): { ok: boolean; reason?: string; item?: Item };
  enchant(item: Item, rarity: Rarity): { ok: boolean; reason?: string; item?: Item };
  /** Надеть скованное на героя (песочница — сразу, игра — командой экипировки). */
  equip?(item: Item): void;
  /** В песочнице можно смотреть материалы, которых ещё нет в игре (выключенные в конфиге). */
  allowDisabledMaterials?: boolean;
}

/** Состояние окна живёт у ВЫЗЫВАЮЩЕГО: тело перерисовывается часто, а выбор должен переживать это. */
export interface CraftWindowState {
  weaponClass: string;
  baseId: string;
  step: number;
  tier: number;
  parts: Omit<CraftParts, 'step'>;
  /** Последняя скованная вещь — её можно зачаровать и надеть. */
  crafted: Item | null;
  /** Итог последнего действия, одной строкой. */
  message: string;
}

const RARITY_DOT: Record<string, string> = { common: COLORS.dim, uncommon: COLORS.info, rare: COLORS.gold };
const RARITY_NAME: Record<string, string> = { common: 'обычная', uncommon: 'нечастая', rare: 'редкая' };
const ORDER = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];

const pct = (x: number, d = 0): string => `${(x * 100).toFixed(d)} %`;
const fx = (x: number, d = 1): string => x.toFixed(d);
const signed = (x: number, unit = '', d = 0): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;

/** Начальное состояние: первый класс, первая база, эталонные детали, лучшая доступная ступень. */
export function initialCraftState(reg: ConfigRegistry, weaponClass = 'sword'): CraftWindowState {
  const st: CraftWindowState = { weaponClass, baseId: '', step: 3, tier: 3, parts: defaultParts(reg, weaponClass)!, crafted: null, message: '' };
  return st;
}

/**
 * Приводит выбор к допустимому: база своего класса и открытая, ступень материала подходит базе,
 * ступень вещи внутри полосы, детали — своего класса и открытые. Правит состояние на месте.
 */
export function normalizeCraftState(reg: ConfigRegistry, st: CraftWindowState, j: CraftJournal): void {
  const bases = reg.get('items.base').filter((b) => b.kind === 'weapon' && (b as { weaponClass: string }).weaponClass === st.weaponClass);
  const open = bases.filter((b) => j.bases.includes(b.id));
  if (!open.some((b) => b.id === st.baseId)) {
    // По умолчанию — база с самым высоким потолком: иначе окно открывалось бы на коротком мече
    // (потолок t3), и дорогие материалы стояли бы серыми без объяснения.
    const rank = (b: (typeof bases)[number]): number => craftTiers(reg).findIndex((t) => t.id === (b.maxTier ?? 't6'));
    const best = [...open].sort((a, b) => rank(b) - rank(a))[0];
    st.baseId = best?.id ?? bases[0]?.id ?? '';
  }
  const base = bases.find((b) => b.id === st.baseId);
  if (base) {
    let range = craftTierRange(reg, base, st.step, j);
    if (!range) {
      for (let k = 5; k >= 1 && !range; k--) { range = craftTierRange(reg, base, k, j); if (range) st.step = k; }
    }
    if (range) st.tier = Math.max(range.lo, Math.min(range.hi, st.tier));
  }
  const def = defaultParts(reg, st.weaponClass);
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = variantsFor(reg, st.weaponClass, slot);
    const openPool = pool.filter((p) => j.variants.includes(p.id));
    const cur = pool.find((p) => p.id === st.parts[slot]);
    if (!cur || !j.variants.includes(cur.id)) {
      const pref = def && openPool.find((p) => p.id === def[slot]);
      st.parts[slot] = (pref ?? [...openPool].sort((a, b) => Math.abs(a.axis) - Math.abs(b.axis))[0] ?? pool[0])?.id ?? '';
    }
  }
}

/** Карточка «что будет в руках» — героем из сейва с подменённым оружием. Те же функции, что у боя. */
export function cardWith(reg: ConfigRegistry, save: SaveState, weapon: Item | undefined): WeaponCard {
  const s = structuredClone(save);
  if (weapon) s.equipment.weapon = weapon;
  const m = makePlayerModel(reg, s);
  return weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon: s.equipment.weapon, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval });
}

/** Что вариант даёт в своём гнезде — числом, для подписи под выбором. */
function partEffect(reg: ConfigRegistry, slot: CraftSlot, axis: number, weaponClass: string): string {
  const k = reg.get('balance').craft;
  if (slot === 'strike') return `урон ${signed(k.strike.damagePct * axis * 100, ' п.п.')} · скорость ${signed(-k.strike.attackSpeed * axis * 100, ' %')}`;
  if (slot === 'grip') {
    const r = k.gripK ** axis, a = k.gripK ** (-2 * axis);
    return ['bow', 'crossbow', 'wand', 'staff'].includes(weaponClass) ? 'только вид (§5.2)' : `дальность ×${fx(r, 2)} · дуга ×${fx(a, 2)}`;
  }
  if (slot === 'bind') return axis > 0 ? 'больше префиксов' : axis < 0 ? 'больше суффиксов' : 'поровну';
  const brace = weaponClass === 'bow' ? `стойкость ${signed(k.headInterrupt * axis * 100, ' п.п.')}` : `блок ${signed(k.headBlock * axis * 100, ' п.п.')}`;
  return `${brace} · статус ${axis < 0 ? 'чаще' : axis > 0 ? 'реже' : 'как есть'}`;
}

/**
 * ⭐ ОКНО КОВКИ. Возвращает корневой элемент; сам перерисовывается на любой выбор.
 * `onAfter` зовётся после ковки/зачарования — чтобы вызывающий пересчитал свои панели.
 */
export function craftWindow(app: App, host: CraftHost, st: CraftWindowState, onAfter?: () => void): HTMLElement {
  const root = mk('div', `color:${COLORS.text};font-size:13px`);
  const reg = app.config;

  const draw = (): void => {
    root.innerHTML = '';
    const j = host.journal();
    normalizeCraftState(reg, st, j);
    const anat = anatomyOf(reg, st.weaponClass);
    const tiers = craftTiers(reg);
    const mats = reg.get('craft-materials');
    const matName = (id: string): string => mats.find((m) => m.id === id)?.name ?? id;

    // ── Класс ──
    const clsRow = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px');
    for (const a of [...reg.get('weapon-anatomy')].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id))) {
      const on = a.id === st.weaponClass;
      const b = mk('button', `padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;border:1px solid ${on ? COLORS.accent : COLORS.borderHi};background:${on ? '#26221a' : COLORS.panel};color:${on ? COLORS.accent : COLORS.text}`, a.name);
      b.addEventListener('click', () => { st.weaponClass = a.id; st.parts = defaultParts(reg, a.id)!; st.crafted = null; st.message = ''; draw(); });
      clsRow.append(b);
    }
    root.append(clsRow);

    // ── Чертёж ──
    const bases = reg.get('items.base').filter((b) => b.kind === 'weapon' && (b as { weaponClass: string }).weaponClass === st.weaponClass);
    const base = bases.find((b) => b.id === st.baseId);
    const row = (label: string): HTMLElement => {
      const r = mk('div', 'display:grid;grid-template-columns:92px 1fr;gap:8px;align-items:center;margin-bottom:8px');
      r.append(mk('div', `color:${COLORS.dim};font-size:12px`, label));
      root.append(r);
      return r;
    };
    const baseSel = mk('select', `padding:5px 8px;background:${COLORS.panel2};color:${COLORS.text};border:1px solid ${COLORS.borderHi};border-radius:4px`);
    for (const b of bases) {
      const o = mk('option', '', `${b.name}${j.bases.includes(b.id) ? '' : ' — 🔒 не открыт'}`);
      o.value = b.id; o.disabled = !j.bases.includes(b.id); o.selected = b.id === st.baseId;
      baseSel.append(o);
    }
    baseSel.addEventListener('change', () => { st.baseId = baseSel.value; st.crafted = null; draw(); });
    const baseInfo = mk('span', `margin-left:10px;color:${COLORS.dim};font-size:12px`);
    if (base && base.kind === 'weapon') {
      const w = reg.get('weapon-weights').find((x) => x.id === base.weight);
      const edge = base.physSub ? reg.get('phys-subtypes').find((p) => p.id === base.physSub)?.name.toLowerCase() : base.damageType;
      baseInfo.textContent = `${base.hands === 2 ? 'двуручное' : 'одноручное'} · ${edge ?? 'без грани'} · вес: ${w?.name.toLowerCase() ?? base.weight}`;
    }
    const baseCell = mk('div'); baseCell.append(baseSel, baseInfo);
    row('Чертёж').append(baseCell);

    // ── Материал (ступень) ──
    const matRow = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
    for (let k = 1; k <= 5; k++) {
      const range = base ? craftTierRange(reg, base, k, j) : null;
      const band = materialBand(k);
      const on = k === st.step;
      const disabled = !range;
      const main = anat ? matName(`${anat.strike.family}-${k}`) : `ступень ${k}`;
      const off = anat && !host.allowDisabledMaterials && CRAFT_SLOT_LIST.some((s) => mats.find((m) => m.id === `${anat[s].family}-${k}`)?.enabled === false);
      const b = mk('button',
        `padding:5px 9px;border-radius:5px;cursor:${disabled ? 'default' : 'pointer'};font-size:12px;text-align:left;line-height:1.25;` +
        `border:1px solid ${on ? COLORS.accent : COLORS.borderHi};background:${on ? '#26221a' : COLORS.panel};color:${disabled ? '#555' : on ? COLORS.accent : COLORS.text}`);
      b.innerHTML = `<b>${main}</b><br><span style="font-size:10.5px;color:${COLORS.dim}">ст. ${k} · ${tiers[band.lo]?.id}–${tiers[band.hi]?.id}${off ? ' · нет в игре' : ''}</span>`;
      b.disabled = disabled;
      b.title = anat ? CRAFT_SLOT_LIST.map((s) => `${anat[s].name}: ${matName(`${anat[s].family}-${k}`)}`).join('\n') : '';
      b.addEventListener('click', () => { st.step = k; st.crafted = null; draw(); });
      matRow.append(b);
    }
    row('Материал').append(matRow);

    // ── Ступень вещи ──
    const range = base ? craftTierRange(reg, base, st.step, j) : null;
    const tierRow = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;align-items:center');
    tiers.forEach((t, i) => {
      const ok = !!range && i >= range.lo && i <= range.hi;
      const on = i === st.tier;
      const b = mk('button', `padding:4px 9px;border-radius:5px;font-size:12px;cursor:${ok ? 'pointer' : 'default'};border:1px solid ${on ? COLORS.accent : COLORS.borderHi};background:${on ? '#26221a' : COLORS.panel};color:${!ok ? '#4a4a4a' : on ? COLORS.accent : COLORS.text}`, `${t.id} ${t.name}`);
      b.disabled = !ok;
      b.addEventListener('click', () => { st.tier = i; st.crafted = null; draw(); });
      tierRow.append(b);
    });
    if (range && st.tier === range.hi && range.hi < 6 && materialBand(st.step).hi === range.hi) {
      tierRow.append(mk('span', `color:${COLORS.bad};font-size:11px;margin-left:6px`, `⚠ потолок материала: выше ${tiers[range.hi]?.id} эту вещь уже не поднять`));
    }
    row('Ступень').append(tierRow);

    // ── Четыре гнезда ──
    const slotsGrid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin:6px 0 10px');
    for (const slot of CRAFT_SLOT_LIST) {
      const card = mk('div', `border:1px solid ${COLORS.border};background:${COLORS.panel2};border-radius:6px;padding:8px`);
      const nm = anat ? anat[slot].name : slot;
      const fam = anat ? matName(`${anat[slot].family}-${st.step}`) : '';
      card.append(mk('div', `font-family:${FONT_TITLE};color:${COLORS.accent};font-size:14px`, nm));
      card.append(mk('div', `color:${COLORS.dim};font-size:11px;margin-bottom:6px`, `${CRAFT_SLOT_ROLE[slot]} · ${fam}`));
      const list = mk('div', 'display:flex;flex-direction:column;gap:3px');
      for (const p of variantsFor(reg, st.weaponClass, slot)) {
        const open = j.variants.includes(p.id);
        const on = p.id === st.parts[slot];
        const b = mk('button', `display:flex;align-items:center;gap:6px;text-align:left;padding:3px 6px;border-radius:4px;font-size:12px;cursor:${open ? 'pointer' : 'default'};` +
          `border:1px solid ${on ? COLORS.accent : 'transparent'};background:${on ? '#26221a' : 'transparent'};color:${!open ? '#4d4d4d' : on ? COLORS.accent : COLORS.text}`);
        b.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:${open ? RARITY_DOT[p.rarity] : '#333'};flex:none"></span>` +
          `<span style="flex:1">${open ? '' : '🔒 '}${p.name}</span><span style="font-size:10px;color:${COLORS.dim};font-family:monospace">${p.axis > 0 ? '+' : ''}${p.axis}</span>`;
        b.title = `${p.caption} · ${RARITY_NAME[p.rarity]}`;
        b.disabled = !open;
        b.addEventListener('click', () => { st.parts[slot] = p.id; st.crafted = null; draw(); });
        list.append(b);
      }
      card.append(list);
      const sel = partById(reg, st.parts[slot]);
      if (sel) {
        card.append(mk('div', `margin-top:6px;font-size:11.5px;color:${COLORS.text}`, sel.caption));
        card.append(mk('div', `font-size:11px;color:${COLORS.gold};font-family:monospace`, partEffect(reg, slot, sel.axis, st.weaponClass)));
      }
      slotsGrid.append(card);
    }
    root.append(slotsGrid);

    // ── Предпросмотр ──
    const input: CraftInput = { baseId: st.baseId, tier: st.tier, step: st.step, parts: { ...st.parts } };
    const pv = craftWeapon(reg, input, { journal: j, materialsOn: !host.allowDisabledMaterials });
    const out = mk('div', 'display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1.3fr);gap:12px;align-items:start');

    const left = mk('div', `border:1px solid ${COLORS.border};border-radius:6px;padding:10px;background:${COLORS.panel2}`);
    const shown = st.crafted ?? pv.item;
    if (shown) {
      const tip = mk('div'); tip.innerHTML = itemTooltipHtml(shown);
      left.append(tip);
      if (shown.affixCap) left.append(mk('div', `margin-top:6px;font-size:12px;color:${COLORS.info}`, `Ёмкость: ${shown.affixCap.prefix} преф. + ${shown.affixCap.suffix} суф. — примет при зачаровании`));
      if (pv.ceiling !== undefined && !st.crafted) left.append(mk('div', `font-size:11.5px;color:${COLORS.dim}`, `Потолок вещи: ${tiers[pv.ceiling]?.id} ${tiers[pv.ceiling]?.name}`));
    } else {
      left.append(mk('div', `color:${COLORS.bad}`, pv.reason ?? 'Не собирается'));
    }
    for (const n of pv.bake?.notes ?? []) left.append(mk('div', `margin-top:6px;font-size:11.5px;color:${COLORS.gold}`, `⚠ ${n}`));

    // Цена
    if (pv.cost) {
      const wallet = host.wallet();
      const costBox = mk('div', `margin-top:10px;border-top:1px solid ${COLORS.border};padding-top:8px`);
      costBox.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, `Цена (форма ×${fx(pv.cost.mult, 2)})`));
      for (const [id, n] of Object.entries(pv.cost.materials)) {
        const have = wallet[id] ?? 0;
        costBox.append(mk('div', `font-size:12px;color:${have >= n ? COLORS.text : COLORS.bad}`, `${matName(id)} — ${n}  (есть ${have})`));
      }
      costBox.append(mk('div', `font-size:12px;color:${host.gold() >= pv.cost.gold ? COLORS.gold : COLORS.bad}`, `Золото — ${pv.cost.gold}  (есть ${host.gold()})`));
      left.append(costBox);
    }

    // Кнопки
    const btns = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px');
    const doCraft = (): void => {
      const r = host.craft(input);
      st.crafted = r.ok ? r.item ?? null : st.crafted;
      st.message = r.ok ? `Скована: ${r.item?.name}` : `Не вышло: ${r.reason}`;
      onAfter?.(); draw();
    };
    btns.append(button('🔨 Ковать', doCraft, 'primary', !pv.ok));
    if (st.crafted) {
      for (const r of ['magic', 'rare'] as const) {
        const cost = enchantCost(reg, st.crafted, r);
        btns.append(button(`✦ ${r === 'magic' ? 'Магический' : 'Редкий'} · ${cost} з.`, () => {
          const res = host.enchant(st.crafted!, r);
          if (res.ok && res.item) st.crafted = res.item;
          st.message = res.ok ? `Зачарована: ${res.item?.name}` : `Не вышло: ${res.reason}`;
          onAfter?.(); draw();
        }, 'default', host.gold() < cost));
      }
      if (host.equip) btns.append(button('Надеть', () => { host.equip!(st.crafted!); st.message = 'Надето'; onAfter?.(); draw(); }));
      btns.append(button('Новая заготовка', () => { st.crafted = null; st.message = ''; draw(); }));
    }
    left.append(btns);
    if (st.message) left.append(mk('div', `margin-top:6px;font-size:12px;color:${st.message.startsWith('Не') ? COLORS.bad : COLORS.good}`, st.message));
    out.append(left);

    // ── Справа: «в руках → скую» ──
    const right = mk('div', `border:1px solid ${COLORS.border};border-radius:6px;padding:10px;background:${COLORS.panel2}`);
    const save = host.save();
    const now = save.equipment.weapon;
    if (shown) {
      const a = cardWith(reg, save, now), b = cardWith(reg, save, shown);
      right.append(compareTable(a, b, now?.name ?? 'без оружия', shown.name, save));
    }
    out.append(right);
    root.append(out);
  };

  draw();
  return root;
}

/** Таблица «в руках → скую»: все характеристики, которые у нас есть, с разницей. */
export function compareTable(a: WeaponCard, b: WeaponCard, aName: string, bName: string, save: SaveState): HTMLElement {
  const t = mk('table', 'width:100%;border-collapse:collapse;font-size:12px');
  const head = mk('tr');
  for (const [txt, css] of [['', ''], [aName, 'text-align:right'], [bName, `text-align:right;color:${COLORS.accent}`], ['разница', 'text-align:right']] as const) {
    head.append(mk('th', `padding:3px 6px;border-bottom:1px solid ${COLORS.borderHi};color:${COLORS.dim};font-weight:normal;font-size:11px;${css}`, txt));
  }
  t.append(head);
  const sec = (title: string): void => {
    const r = mk('tr'); const c = mk('td', `padding:8px 6px 2px;color:${COLORS.gold};font-size:11px;letter-spacing:.06em;text-transform:uppercase`, title);
    c.colSpan = 4; r.append(c); t.append(r);
  };
  const line = (label: string, x: number | undefined, y: number | undefined, fmt: (v: number) => string, rel = true, better: 'up' | 'down' | 'none' = 'up', dfmt?: (d: number) => string): void => {
    const r = mk('tr');
    r.append(mk('td', `padding:2px 6px;color:${COLORS.dim}`, label));
    r.append(mk('td', 'padding:2px 6px;text-align:right;font-family:monospace', x === undefined ? '—' : fmt(x)));
    r.append(mk('td', 'padding:2px 6px;text-align:right;font-family:monospace', y === undefined ? '—' : fmt(y)));
    let diff = '';
    let col: string = COLORS.dim;
    if (x !== undefined && y !== undefined && Math.abs(y - x) > 1e-9) {
      diff = rel && Math.abs(x) > 1e-9 ? signed(((y - x) / Math.abs(x)) * 100, ' %') : dfmt ? dfmt(y - x) : signed(y - x, '', 2);
      if (better !== 'none') col = (y > x) === (better === 'up') ? COLORS.good : COLORS.bad;
    }
    r.append(mk('td', `padding:2px 6px;text-align:right;font-family:monospace;color:${col}`, diff));
    t.append(r);
  };
  sec('Удар');
  line('урон за удар', (a.hitMin + a.hitMax) / 2, (b.hitMin + b.hitMax) / 2, (v) => fx(v, 1));
  line('разброс', undefined, undefined, fx);
  (t.lastChild as HTMLElement).children[1]!.textContent = `${fx(a.hitMin, 0)}–${fx(a.hitMax, 0)}`;
  (t.lastChild as HTMLElement).children[2]!.textContent = `${fx(b.hitMin, 0)}–${fx(b.hitMax, 0)}`;
  line('ударов в секунду', a.aps, b.aps, (v) => fx(v, 2));
  line('шанс крита', a.critChance, b.critChance, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  line('ДПС (формула)', a.dps, b.dps, (v) => fx(v, 1));
  line('вклад атрибутов', a.attrBonus, b.attrBonus, (v) => fx(v, 1));
  if (a.attackType === 'melee' || b.attackType === 'melee') {
    sec('Геометрия взмаха');
    line('дальность, px', a.rangePx, b.rangePx, (v) => fx(v, 0), true, 'none');
    line('дуга, °', a.arcDeg, b.arcDeg, (v) => fx(v, 0), true, 'none');
    line('площадь сектора', a.area, b.area, (v) => `×${fx(v, 3)}`, true, 'none');
  }
  sec('Защита и контроль');
  line('блок', a.block, b.block, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  line('стойкость к прерыванию', a.interruptResist, b.interruptResist, (v) => pct(v, 0), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  line('сбить с ног (цель 100)', a.knockdown, b.knockdown, (v) => pct(v, 2), false, 'up', (d) => signed(d * 100, ' п.п.', 2));
  line('масса оружия', a.mass, b.mass, (v) => fx(v, 0), false, 'none', (d) => signed(d, '', 0));
  const statusRows = (x: WeaponCard['status'], y: WeaponCard['status']): void => {
    const s = (y ?? x)!;
    sec(`Статус: ${s.name}`);
    line('шанс за попадание', x?.chance, y?.chance, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
    line('средних стаков', x?.avgStacks, y?.avgStacks, (v) => `${fx(v, 2)} / ${s.maxStacks}`);
    if (y?.over100 || (!y && x?.over100)) {
      const r = mk('tr'); const c = mk('td', `padding:2px 6px;color:${COLORS.bad};font-size:11px`, '⚠ шанс выше 100 %: в бою статус вешается каждым ударом — шанс не клампится (долг §20)');
      c.colSpan = 4; r.append(c); t.append(r);
    }
  };
  // Разные грани (топор рубит, меч режет) — это разные статусы: в одну строку их не сравнить.
  if (a.status && b.status && a.status.kind !== b.status.kind) { statusRows(a.status, undefined); statusRows(undefined, b.status); }
  else if (a.status || b.status) statusRows(a.status, b.status);
  sec('Требования');
  const attrs = save.attributes;
  const reqLine = (k: 'strength' | 'dexterity' | 'intelligence', label: string): void => {
    const x = a.requirements[k], y = b.requirements[k];
    if (x === undefined && y === undefined) return;
    line(label, x, y, (v) => `${v}`, false, 'down', (d) => signed(d, '', 0));
    const cell = (t.lastChild as HTMLElement).children[2] as HTMLElement;
    if (y !== undefined && (attrs[k] ?? 0) < y) cell.style.color = COLORS.bad;
  };
  reqLine('strength', 'сила');
  reqLine('dexterity', 'ловкость');
  reqLine('intelligence', 'интеллект');
  line('сумма', a.reqTotal, b.reqTotal, (v) => `${v}`, false, 'down', (d) => signed(d, '', 0));
  return t;
}
