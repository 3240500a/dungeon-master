import {
  CRAFT_SLOT_LIST, CRAFT_SLOT_ROLE, anatomyOf, baseTierRange, clampStep, craftTiers, craftWeapon, defaultParts,
  enchantCost, familiesOf, finishOf, keySlotOf, keyVariantsByBase, makePlayerModel, partById, rangeLabel, slotName, stepLabel,
  tierOfSteps, variantsFor, weaponCard,
  type ConfigRegistry, type CraftInput, type CraftJournal, type CraftParts, type CraftSlot, type Item,
  type Rarity, type SaveState, type WeaponCard, type WeaponPart,
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
 * Порядок — от деталей: семейство (класс × хват) → ключевая деталь, она «определяет тип» →
 * остальные детали, у каждой — свой материал. Тип, историческое имя и ступень вещи окно НЕ
 * спрашивает, а показывает: их выводит ядро (`craftWeapon`, `craftType.ts`). Своих формул здесь нет.
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
  /** Семейство: 1 — одноручное, 2 — двуручное. */
  hands: number;
  /** Четыре детали, у каждой — своя ступень материала. */
  parts: CraftParts;
  /** Последняя скованная вещь — её можно зачаровать и надеть. */
  crafted: Item | null;
  /** Доводка — индекс в `balance.craft.finish`; поднимает нижнюю границу вилки урона. */
  finish?: number;
  /** Итог последнего действия, одной строкой. */
  message: string;
}

const RARITY_DOT: Record<string, string> = { common: COLORS.dim, uncommon: COLORS.info, rare: COLORS.gold };
const RARITY_NAME: Record<string, string> = { common: 'обычная', uncommon: 'нечастая', rare: 'редкая' };
const ORDER = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];

const pct = (x: number, d = 0): string => `${(x * 100).toFixed(d)} %`;
const fx = (x: number, d = 1): string => x.toFixed(d);
const signed = (x: number, unit = '', d = 0): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;

/** Начальное состояние: первое семейство класса, эталонные детали из кричного железа (ступень 2). */
export function initialCraftState(reg: ConfigRegistry, weaponClass = 'sword', hands?: number): CraftWindowState {
  const h = hands ?? familiesOf(reg, weaponClass)[0] ?? 1;
  return { weaponClass, hands: h, parts: defaultParts(reg, weaponClass, h, 2)!, crafted: null, message: '' };
}

/**
 * Приводит выбор к допустимому: семейство есть у класса, ключевая деталь — открытой базы, детали
 * своего семейства и открытые, ступени — внутри окна материалов каждой формы. Правит на месте.
 */
export function normalizeCraftState(reg: ConfigRegistry, st: CraftWindowState, j: CraftJournal): void {
  // Индекс доводки — к существующей строке: список правится в редакторе, а чип, цена и ковка обязаны
  // видеть ОДНУ строку (иначе платишь за доводку, а выбранной не подсвечено ничего).
  st.finish = finishOf(reg, st.finish).index;
  const fams = familiesOf(reg, st.weaponClass);
  if (!fams.includes(st.hands)) st.hands = fams[0] ?? 1;
  const keySlot = keySlotOf(reg, st.weaponClass);
  const def = defaultParts(reg, st.weaponClass, st.hands, 2);
  if (!st.parts) st.parts = def!;
  const closest = (pool: WeaponPart[]): WeaponPart | undefined => [...pool].sort((a, b) => Math.abs(a.axis) - Math.abs(b.axis))[0];
  for (const slot of CRAFT_SLOT_LIST) {
    let pool: WeaponPart[];
    if (slot === keySlot) {
      const groups = keyVariantsByBase(reg, st.weaponClass, st.hands).filter((g) => j.bases.includes(g.baseId));
      pool = groups.flatMap((g) => g.variants).filter((p) => j.variants.includes(p.id));
      const cur = st.parts[slot] && pool.find((p) => p.id === st.parts[slot].id);
      if (!cur) {
        // По умолчанию — база с самым высоким потолком: иначе окно открывалось бы на коротком мече
        // (потолок t3), и дорогие материалы упирались бы в потолок без объяснения.
        const rank = (id: string): number => { const b = reg.get('items.base').find((x) => x.id === id); return b ? baseTierRange(reg, b).hi : -1; };
        const g = [...groups].sort((a, b) => rank(b.baseId) - rank(a.baseId)).find((x) => x.variants.some((p) => j.variants.includes(p.id)));
        const p = g ? closest(g.variants.filter((v) => j.variants.includes(v.id))) : closest(keyVariantsByBase(reg, st.weaponClass, st.hands)[0]?.variants ?? []);
        st.parts[slot] = { id: p?.id ?? '', step: st.parts[slot]?.step ?? 2 };
      }
    } else {
      pool = variantsFor(reg, st.weaponClass, slot, st.hands);
      const open = pool.filter((p) => j.variants.includes(p.id));
      if (!st.parts[slot] || !open.some((p) => p.id === st.parts[slot].id)) {
        const pref = def && open.find((p) => p.id === def[slot].id);
        st.parts[slot] = { id: (pref ?? closest(open) ?? pool[0])?.id ?? '', step: st.parts[slot]?.step ?? 2 };
      }
    }
    const p = partById(reg, st.parts[slot].id);
    if (p) st.parts[slot].step = clampStep(p, st.parts[slot].step);
  }
}

/** Карточка «что будет в руках» — героем из сейва с подменённым оружием. Те же функции, что у боя. */
export function cardWith(reg: ConfigRegistry, save: SaveState, weapon: Item | undefined): WeaponCard {
  const s = structuredClone(save);
  if (weapon) s.equipment.weapon = weapon;
  const m = makePlayerModel(reg, s);
  return weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon: s.equipment.weapon, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval });
}

/**
 * Куда лёг бросок скованной вещи — одной фразой к сообщению «Скована»: сколько вышло и из какой
 * вилки. До ковки игрок видел только вилку, это первое место, где он видит результат.
 */
function rollVerdict(item: Item, ranges: CraftPreviewRanges | undefined, floor: number): string {
  const mn = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat')?.value;
  const mx = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat')?.value;
  if (mn === undefined || mx === undefined || !ranges?.minDamage || !ranges.maxDamage) return '';
  const k = item.damageMult ?? 1, r = (v: number): number => Math.round(v * k);
  // Процент — место внутри ПОКАЗАННОЙ вилки (она уже сужена доводкой): 0 % — её низ, 100 % — верх.
  // Долю на всей вилке ступени не показываем: при ювелирной доводке худший бросок читался бы «80 %».
  const q = item.baseRoll ? ((item.baseRoll.minDamage ?? 0.5) + (item.baseRoll.maxDamage ?? 0.5)) / 2 : 0.5;
  const pos = floor >= 1 ? 100 : Math.round((Math.max(0, q - floor) / (1 - floor)) * 100);
  return ` · урон ${r(mn)}–${r(mx)} из вилки ${rangeLabel(ranges.minDamage, k)}–${rangeLabel(ranges.maxDamage, k)} · бросок ${pos} % вилки`;
}
type CraftPreviewRanges = NonNullable<ReturnType<typeof craftWeapon>['ranges']>;

/** Что вариант даёт в своём гнезде — числом, для подписи под выбором. */
function partEffect(reg: ConfigRegistry, slot: CraftSlot, axis: number, weaponClass: string): string {
  const k = reg.get('balance').craft;
  if (slot === 'strike') return `урон ×${fx(1 + k.strike.damagePct * axis, 2)} · скорость ×${fx(1 - k.strike.attackSpeed * axis, 2)}`;
  if (slot === 'grip') {
    const r = k.gripK ** axis, a = k.gripK ** (-2 * axis);
    return ['bow', 'crossbow', 'wand', 'staff'].includes(weaponClass) ? 'только вид (§5.2)' : `дальность ×${fx(r, 2)} · дуга ×${fx(a, 2)}`;
  }
  if (slot === 'bind') return axis > 0 ? 'больше префиксов' : axis < 0 ? 'больше суффиксов' : 'поровну';
  const brace = weaponClass === 'bow' ? `стойкость ${signed(k.headInterrupt * axis * 100, ' п.п.')}` : `блок ${signed(k.headBlock * axis * 100, ' п.п.')}`;
  return `${brace} · статус ${axis < 0 ? 'чаще' : axis > 0 ? 'реже' : 'как есть'}`;
}

/** Строка механики базы: урон, хват, грань, вес — чтобы тип читался как числа, а не только как имя. */
function baseLine(reg: ConfigRegistry, baseId: string | undefined): string {
  const base = reg.get('items.base').find((b) => b.id === baseId);
  if (!base || base.kind !== 'weapon') return '';
  const flat = (s: string): number | undefined => base.baseStats.find((m) => m.stat === s && m.kind === 'flat')?.value;
  const w = reg.get('weapon-weights').find((x) => x.id === base.weight);
  const edge = base.physSub ? reg.get('phys-subtypes').find((p) => p.id === base.physSub)?.name.toLowerCase() : reg.get('magic-subtypes').find((m) => m.id === base.damageType)?.name?.toLowerCase();
  const dmg = flat('minDamage') !== undefined ? `${flat('minDamage')}–${flat('maxDamage')}` : '';
  return [base.name, dmg, base.hands === 2 ? 'двуручное' : 'одноручное', edge ?? 'без грани', w ? `вес: ${w.name.toLowerCase()}` : ''].filter(Boolean).join(' · ');
}

/**
 * ⭐ ОКНО КОВКИ. Возвращает корневой элемент; сам перерисовывается на любой выбор.
 * `onAfter` зовётся после ковки/зачарования — чтобы вызывающий пересчитал свои панели.
 * `onChange` зовётся после КАЖДОЙ перерисовки (сменил деталь, материал, семейство) — чтобы
 * вызывающий сразу обновил то, что показывает сборку рядом с окном (3D-модель), не дожидаясь ковки.
 */
export function craftWindow(app: App, host: CraftHost, st: CraftWindowState, onAfter?: () => void, onChange?: (st: CraftWindowState) => void): HTMLElement {
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
    const matOn = (id: string): boolean => host.allowDisabledMaterials || mats.find((m) => m.id === id)?.enabled !== false;
    const keySlot = keySlotOf(reg, st.weaponClass);
    const chip = (on: boolean, disabled: boolean): string =>
      `padding:3px 8px;border-radius:5px;font-size:11.5px;cursor:${disabled ? 'default' : 'pointer'};border:1px solid ${on ? COLORS.accent : COLORS.borderHi};` +
      `background:${on ? '#26221a' : COLORS.panel};color:${disabled ? '#4a4a4a' : on ? COLORS.accent : COLORS.text}`;
    const reset = (): void => { st.crafted = null; st.message = ''; };

    // ── Класс и семейство ──
    const clsRow = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px');
    for (const a of [...reg.get('weapon-anatomy')].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id))) {
      const on = a.id === st.weaponClass;
      const b = mk('button', `padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;border:1px solid ${on ? COLORS.accent : COLORS.borderHi};background:${on ? '#26221a' : COLORS.panel};color:${on ? COLORS.accent : COLORS.text}`, a.name);
      b.addEventListener('click', () => { if (on) return; Object.assign(st, initialCraftState(reg, a.id)); draw(); });
      clsRow.append(b);
    }
    root.append(clsRow);
    const fams = familiesOf(reg, st.weaponClass);
    if (fams.length > 1) {
      const famRow = mk('div', 'display:flex;gap:6px;margin-bottom:10px;align-items:center');
      famRow.append(mk('span', `color:${COLORS.dim};font-size:12px;margin-right:4px`, 'Семейство'));
      for (const h of fams) {
        const b = mk('button', chip(h === st.hands, false), h === 2 ? 'Двуручное' : 'Одноручное');
        b.addEventListener('click', () => { if (h === st.hands) return; Object.assign(st, initialCraftState(reg, st.weaponClass, h)); draw(); });
        famRow.append(b);
      }
      root.append(famRow);
    } else {
      root.append(mk('div', `color:${COLORS.dim};font-size:11.5px;margin-bottom:10px`, fams[0] === 2 ? 'Семейство одно: двуручное' : 'Семейство одно: одноручное'));
    }

    // ── Предпросмотр: тип, имя, ступень ──
    const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };
    const pv = craftWeapon(reg, input, { journal: j, materialsOn: !host.allowDisabledMaterials });
    const type = pv.type;
    const head = mk('div', `border:1px solid ${COLORS.borderHi};border-radius:6px;padding:10px 12px;margin-bottom:10px;background:${COLORS.panel2}`);
    const top = mk('div', 'display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap');
    const nameBox = mk('div');
    nameBox.append(mk('div', `color:${COLORS.dim};font-size:11px;letter-spacing:.06em;text-transform:uppercase`, 'Получилось'));
    nameBox.append(mk('div', `font-family:${FONT_TITLE};color:${COLORS.accent};font-size:20px;line-height:1.2`, type?.ok ? type.name : '—'));
    top.append(nameBox);
    const { q, tier } = tierOfSteps(reg, st.parts);
    const tierBox = mk('div', 'text-align:right');
    tierBox.append(mk('div', `color:${COLORS.dim};font-size:11px`, 'Ступень из деталей'));
    tierBox.append(mk('div', `font-size:15px;color:${pv.ok ? COLORS.gold : COLORS.bad}`, `${tiers[tier]?.id} ${tiers[tier]?.name}`));
    const w = reg.get('balance').craft.tierFromParts.weights;
    tierBox.title = `Средний уровень материала по массе: Q = (${w.strike}·${st.parts.strike.step} + ${st.parts.grip.step} + ${st.parts.bind.step} + ${st.parts.head.step}) / ${w.strike + w.grip + w.bind + w.head} = ${q}`;
    tierBox.append(mk('div', `color:${COLORS.dim};font-size:10.5px;font-family:monospace`, `Q = ${fx(q, 2)}`));
    top.append(tierBox);
    head.append(top);
    if (type?.ok) {
      if (type.subtitle) head.append(mk('div', `font-size:12px;color:${COLORS.text};margin-top:2px`, type.subtitle));
      if (type.formula) head.append(mk('div', `font-size:11.5px;color:${COLORS.info};margin-top:4px`, type.formula));
      head.append(mk('div', `font-size:11.5px;color:${COLORS.dim};margin-top:2px`, `механика: ${baseLine(reg, type.baseId)}`));
      // ⚠ `source` игроку НЕ печатаем: там реальная типология («Окшотт XV»), а мир фэнтезийный.
      // Справка нужна нам и моделлеру — её видно в редакторе (каталог ковки).
    }
    if (!pv.ok && pv.reason) head.append(mk('div', `font-size:12px;color:${COLORS.bad};margin-top:6px`, `⚠ ${pv.reason}`));
    root.append(head);

    // ── Вся вещь из… ──
    if (anat) {
      const allRow = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px');
      allRow.append(mk('span', `color:${COLORS.dim};font-size:12px;margin-right:4px`, 'Вся вещь из'));
      for (let k = 1; k <= 5; k++) {
        const b = mk('button', chip(CRAFT_SLOT_LIST.every((s) => st.parts[s].step === k), false), `ст. ${k} · ${matName(`${anat[keySlot].family}-${k}`)}`);
        b.title = 'Каждой детали — эта ступень, прижатая к окну её формы';
        b.addEventListener('click', () => {
          for (const s of CRAFT_SLOT_LIST) { const p = partById(reg, st.parts[s].id); if (p) st.parts[s].step = clampStep(p, k); }
          reset(); draw();
        });
        allRow.append(b);
      }
      root.append(allRow);
    }

    // ── Четыре гнезда: ключ первым ──
    const slotsGrid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px;margin:6px 0 10px');
    const order: CraftSlot[] = [keySlot, ...CRAFT_SLOT_LIST.filter((s) => s !== keySlot)];
    for (const slot of order) {
      const isKey = slot === keySlot;
      const card = mk('div', `border:1px solid ${isKey ? COLORS.accent : COLORS.border};background:${COLORS.panel2};border-radius:6px;padding:8px;display:flex;flex-direction:column`);
      const title = mk('div', 'display:flex;justify-content:space-between;align-items:baseline;gap:6px');
      title.append(mk('div', `font-family:${FONT_TITLE};color:${COLORS.accent};font-size:14px`, anat ? slotName(anat, slot, st.hands) : slot));
      if (isKey) title.append(mk('span', `font-size:10.5px;color:${COLORS.gold};border:1px solid ${COLORS.gold};border-radius:3px;padding:0 4px`, 'определяет тип'));
      card.append(title);
      card.append(mk('div', `color:${COLORS.dim};font-size:11px;margin-bottom:6px`, CRAFT_SLOT_ROLE[slot]));

      const list = mk('div', 'display:flex;flex-direction:column;gap:2px;max-height:250px;overflow:auto;margin-bottom:6px');
      const row = (p: WeaponPart, baseOpen = true): HTMLElement => {
        const open = j.variants.includes(p.id) && baseOpen;
        const on = p.id === st.parts[slot].id;
        const b = mk('button', `display:flex;align-items:center;gap:6px;text-align:left;padding:3px 6px;border-radius:4px;font-size:12px;cursor:${open ? 'pointer' : 'default'};` +
          `border:1px solid ${on ? COLORS.accent : 'transparent'};background:${on ? '#26221a' : 'transparent'};color:${!open ? '#4d4d4d' : on ? COLORS.accent : COLORS.text}`);
        b.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:${open ? RARITY_DOT[p.rarity] : '#333'};flex:none"></span>` +
          `<span style="flex:1">${open ? '' : '🔒 '}${p.name}</span>` +
          `<span style="font-size:10px;color:${COLORS.dim};font-family:monospace">ст.${p.stepMin}–${p.stepMax}</span>` +
          `<span style="font-size:10px;color:${COLORS.dim};font-family:monospace;width:30px;text-align:right">${p.axis > 0 ? '+' : ''}${p.axis}</span>`;
        b.title = [p.caption, p.lore, `${RARITY_NAME[p.rarity]} · материал: ступени ${p.stepMin}–${p.stepMax}`].filter(Boolean).join('\n');
        b.disabled = !open;
        b.addEventListener('click', () => { st.parts[slot] = { id: p.id, step: clampStep(p, st.parts[slot].step) }; reset(); draw(); });
        return b;
      };
      if (isKey) {
        for (const g of keyVariantsByBase(reg, st.weaponClass, st.hands)) {
          const baseOpen = j.bases.includes(g.baseId);
          const b = reg.get('items.base').find((x) => x.id === g.baseId);
          const hr = b ? baseTierRange(reg, b) : { lo: 0, hi: 6 };
          const cap = hr.hi < tiers.length - 1 ? ` · до ${tiers[hr.hi]?.id}` : '';
          list.append(mk('div', `font-size:10.5px;color:${baseOpen ? COLORS.gold : '#555'};margin:4px 0 1px;border-bottom:1px solid ${COLORS.border}`, `${baseOpen ? '' : '🔒 '}${baseLine(reg, g.baseId)}${cap}`));
          for (const p of g.variants) list.append(row(p, baseOpen));
        }
      } else {
        for (const p of variantsFor(reg, st.weaponClass, slot, st.hands)) list.append(row(p));
      }
      card.append(list);

      // Материал этой детали — внутри окна формы.
      const sel = partById(reg, st.parts[slot].id);
      if (sel && anat) {
        const matRow = mk('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:auto');
        for (let k = 1; k <= 5; k++) {
          const inWin = k >= sel.stepMin && k <= sel.stepMax;
          const id = `${sel.family || anat[slot].family}-${k}`;
          const on = st.parts[slot].step === k;
          const b = mk('button', chip(on, !inWin), stepLabel(reg, anat, slot, sel, k));
          b.disabled = !inWin;
          b.title = inWin ? `${matName(id)} (${id})${matOn(id) ? '' : ' — ещё нет в игре'}` : `«${sel.name}» из этого не куётся: только ступени ${sel.stepMin}–${sel.stepMax}`;
          if (inWin && !matOn(id)) b.style.borderStyle = 'dashed';
          b.addEventListener('click', () => { st.parts[slot].step = k; reset(); draw(); });
          matRow.append(b);
        }
        card.append(mk('div', `font-size:10.5px;color:${COLORS.dim};margin:2px 0 3px`, `Материал · ${anat[slot].stepNames.length && !sel.family ? 'обработка' : matName(`${sel.family || anat[slot].family}-${st.parts[slot].step}`)}`));
        card.append(matRow);
        card.append(mk('div', `margin-top:6px;font-size:11.5px;color:${COLORS.text}`, sel.caption));
        card.append(mk('div', `font-size:11px;color:${COLORS.gold};font-family:monospace`, partEffect(reg, slot, sel.axis, st.weaponClass)));
      }
      slotsGrid.append(card);
    }
    root.append(slotsGrid);

    // ── Вещь, цена, кнопки ──
    const out = mk('div', 'display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1.3fr);gap:12px;align-items:start');
    const left = mk('div', `border:1px solid ${COLORS.border};border-radius:6px;padding:10px;background:${COLORS.panel2}`);
    const shown = st.crafted ?? pv.item;
    if (shown) {
      const tip = mk('div'); tip.innerHTML = itemTooltipHtml(shown);
      left.append(tip);
      if (shown.affixCap) left.append(mk('div', `margin-top:6px;font-size:12px;color:${COLORS.info}`, `Ёмкость: ${shown.affixCap.prefix} преф. + ${shown.affixCap.suffix} суф. — примет при зачаровании`));
    } else {
      left.append(mk('div', `color:${COLORS.bad}`, pv.reason ?? 'Не собирается'));
    }
    for (const n of pv.bake?.notes ?? []) left.append(mk('div', `margin-top:6px;font-size:11.5px;color:${COLORS.gold}`, `⚠ ${n}`));

    // ── Доводка: сдвигает НИЗ вилки, верх не трогает. Результат — только после ковки. ──
    const finishes = reg.get('balance').craft.finish;
    if (finishes.length > 1 && pv.cost && anat) {
      const fin = mk('div', `margin-top:10px;border-top:1px solid ${COLORS.border};padding-top:8px`);
      fin.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, `Доводка: ${slotName(anat, 'strike', st.hands)} — поднимает нижнюю границу урона, верх вилки не растёт`));
      const frow = mk('div', 'display:flex;flex-wrap:wrap;gap:4px');
      const strikeMat = pv.cost.lines.find((l) => l.slot === 'strike');
      finishes.forEach((f, i) => {
        const on = (st.finish ?? 0) === i;
        const extra = f.strikeUnits <= 0 && f.goldMult === 1 ? 'без надбавки' : `+${f.strikeUnits} ${strikeMat ? matName(strikeMat.id) : ''} · золото ×${fx(f.goldMult, 2)}`;
        const b = mk('button', chip(on, false), f.name);
        b.title = `${extra}\nНиже ${Math.round(f.floor * 100)} % вилки урон не выпадет`;
        b.addEventListener('click', () => { if (on) return; st.finish = i; reset(); draw(); });
        frow.append(b);
      });
      fin.append(frow);
      left.append(fin);
    }

    if (pv.cost && anat) {
      const wallet = host.wallet();
      const costBox = mk('div', `margin-top:10px;border-top:1px solid ${COLORS.border};padding-top:8px`);
      costBox.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, `Цена: каждая деталь своим материалом (форма ×${fx(pv.cost.mult, 2)})`));
      for (const l of pv.cost.lines) {
        const need = pv.cost.materials[l.id] ?? 0;
        const have = wallet[l.id] ?? 0;
        costBox.append(mk('div', `font-size:12px;color:${have >= need ? COLORS.text : COLORS.bad}`, `${slotName(anat, l.slot, st.hands)}: ${matName(l.id)} — ${l.n}  (есть ${have})`));
      }
      // Доводка — отдельной строкой: её сырьё уходит в клинок безвозвратно, переплавка его не вернёт.
      const fc = pv.cost.finish;
      if (fc && fc.n > 0) {
        const need = pv.cost.materials[fc.id] ?? 0, have = wallet[fc.id] ?? 0;
        costBox.append(mk('div', `font-size:12px;color:${have >= need ? COLORS.text : COLORS.bad}`, `${fc.name}: ${matName(fc.id)} — ${fc.n}  (всего ${need}, есть ${have})`));
      }
      costBox.append(mk('div', `font-size:12px;color:${host.gold() >= pv.cost.gold ? COLORS.gold : COLORS.bad}`, `Золото — ${pv.cost.gold}  (есть ${host.gold()})`));
      left.append(costBox);
    }

    const btns = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px');
    const doCraft = (): void => {
      const r = host.craft(input);
      st.crafted = r.ok ? r.item ?? null : st.crafted;
      st.message = r.ok ? `Скована: ${r.item?.name}${r.item ? rollVerdict(r.item, pv.ranges, pv.cost?.finish?.floor ?? 0) : ''}` : `Не вышло: ${r.reason}`;
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
      btns.append(button('Новая заготовка', () => { reset(); draw(); }));
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
      // До ковки чисел нет — сравниваем с КРАЯМИ вилки (низ при этой доводке и верх), а не с серединой.
      const edge = (at: 'lo' | 'hi'): WeaponCard | undefined => {
        const it = craftWeapon(reg, input, { journal: j, materialsOn: !host.allowDisabledMaterials, at }).item;
        return it ? cardWith(reg, save, it) : undefined;
      };
      const lo = st.crafted ? undefined : edge('lo'), hi = st.crafted ? undefined : edge('hi');
      right.append(compareTable(a, b, now?.name ?? 'без оружия', shown.name, save, lo && hi ? { lo, hi } : undefined));
    }
    out.append(right);
    root.append(out);
    onChange?.(st);
  };

  draw();
  return root;
}

/** Таблица «в руках → скую»: все характеристики, которые у нас есть, с разницей. */
export function compareTable(a: WeaponCard, b: WeaponCard, aName: string, bName: string, save: SaveState, bRange?: { lo: WeaponCard; hi: WeaponCard }): HTMLElement {
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
  /**
   * Строка-ВИЛКА: у ещё не скованной вещи числа нет — в колонке «от и до», в разнице тоже вилка.
   * Цвет — по середине: тусклый, если вилка захватывает ноль (может выйти и хуже, и лучше).
   */
  const rangeLine = (label: string, x: number, lo: number, hi: number, fmt: (v: number) => string): void => {
    const r = mk('tr');
    r.append(mk('td', `padding:2px 6px;color:${COLORS.dim}`, label));
    r.append(mk('td', 'padding:2px 6px;text-align:right;font-family:monospace', fmt(x)));
    r.append(mk('td', 'padding:2px 6px;text-align:right;font-family:monospace', `${fmt(lo)}–${fmt(hi)}`));
    const d = (y: number): number => (Math.abs(x) > 1e-9 ? ((y - x) / Math.abs(x)) * 100 : 0);
    const col = d(lo) > 0 ? COLORS.good : d(hi) < 0 ? COLORS.bad : COLORS.dim;
    r.append(mk('td', `padding:2px 6px;text-align:right;font-family:monospace;color:${col}`, `${signed(d(lo), '')}…${signed(d(hi), ' %')}`));
    t.append(r);
  };
  const mid = (c: WeaponCard): number => (c.hitMin + c.hitMax) / 2;
  sec('Удар');
  if (bRange) rangeLine('урон за удар', mid(a), mid(bRange.lo), mid(bRange.hi), (v) => fx(v, 1));
  else line('урон за удар', mid(a), mid(b), (v) => fx(v, 1));
  line('разброс', undefined, undefined, fx);
  (t.lastChild as HTMLElement).children[1]!.textContent = `${fx(a.hitMin, 0)}–${fx(a.hitMax, 0)}`;
  const span = (lo: number, hi: number): string => (fx(lo, 0) === fx(hi, 0) ? fx(lo, 0) : `(${fx(lo, 0)}–${fx(hi, 0)})`);
  (t.lastChild as HTMLElement).children[2]!.textContent = bRange
    ? `${span(bRange.lo.hitMin, bRange.hi.hitMin)}–${span(bRange.lo.hitMax, bRange.hi.hitMax)}`
    : `${fx(b.hitMin, 0)}–${fx(b.hitMax, 0)}`;
  line('ударов в секунду', a.aps, b.aps, (v) => fx(v, 2));
  line('шанс крита', a.critChance, b.critChance, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  if (bRange) rangeLine('ДПС (формула)', a.dps, bRange.lo.dps, bRange.hi.dps, (v) => fx(v, 1));
  else line('ДПС (формула)', a.dps, b.dps, (v) => fx(v, 1));
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
