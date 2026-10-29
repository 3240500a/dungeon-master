import type { ConfigRegistry } from '../config/registry.js';
import type { CraftParts, Item, Rarity } from '../types/items.js';
import {
  CRAFT_SLOT_ROLE, FORM_UNPRICED, anatomyOf, baseTierRange, clampStep, craftMissing, craftTiers, craftWeapon, defaultParts, enchantCost,
  enchantSlots, finishOf, keyVariantsByBase, partById, rolledFormMult, sketchable, statusKindOf, stepLabel, tierOfSteps, variantsFor,
  type CraftInput, type CraftJournal,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, baseOfKeyPart, familiesOf, keySlotOf, slotName, type CraftSlot, type WeaponPart } from '../formulas/craftType.js';
import { axisOf, balanceAxisOf, bladeCaption, bladeStats } from '../formulas/bladeStats.js';
import { describeItem, rangeLabel, slotSuffix } from '../formulas/itemDescribe.js';
import { craftFits, describeCost, enchantMaterials } from '../economy/townActions.js';
import { itemLabels } from './townItem.js';

/**
 * ⭐ С5 (29.10): ОКНО КОВКИ — СЕРВЕРОМ. Модель окна целиком (классы, семейство, шапка с типом и ступенью, эскизы, «Вся вещь из», четыре
 * карточки гнёзд со строками деталей и материалами, вещь-предпросмотр, доводка, цена против кошелька, «Ковать» с причиной, зачарование
 * скованной), посчитанная ядром ковки (`craftWeapon`, `tierOfSteps`, `enchantSlots`…) от того, что знает сервер: журнал кузнеца, сырьё
 * сумки и сундука, золото и сумка героя.
 *
 * Заменяет C# `DmTown.CraftViewModel` / `CraftViewOf` / `InitialCraftState` / `CraftState` / подписи окна (`DmTownCraftView.cs`) и под ними
 * ядро ковки (`DmTownCraft.cs`, `DmTownCraftWeapon.cs`). Источник — разметка веб-окна `client/modules/town/craftPanel.ts` (`craftWindow`),
 * переписанная в данные генератором эталона Unity (`unityCraftGolden.gen.test.ts` раздел `views`): генератор теперь зовёт ЭТУ функцию,
 * и эталон, по которому сверен порт Unity, байт в байт её выход.
 *
 * ⚠ Чего вид НЕ знает: что в полёте (`busy`) и итог последнего действия (`message`) — это состояние окна у клиента (кнопка «⏳ куём…»
 * пока ждём `cmdResult`). Сервер получает их пустыми; строку «Скована: … бросок N % вилки» он кладёт сам (`left.verdict`) — по скованной
 * вещи и предпросмотру той сборки, что выбрана в окне.
 */

/** Состояние окна (`CraftWindowState` веба): класс, семейство, детали со ступенями, доводка, скованная вещь, эскиз к открытию. */
export interface CraftWindowState {
  weaponClass: string;
  /** Семейство: 1 — одноручное, 2 — двуручное. */
  hands: number;
  parts: CraftParts;
  crafted: Item | null;
  /** Доводка — индекс в `balance.craft.finish`. */
  finish?: number;
  message: string;
  busy?: 'craft' | 'enchant' | 'equip' | 'sketch';
  sketchPick?: string;
}

/** Порядок классов в окне. */
export const CRAFT_CLASS_ORDER: readonly string[] = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];
const RARITY_NAME: Record<string, string> = { common: 'обычная', uncommon: 'нечастая', rare: 'редкая' };
const FORM_NAME: Record<string, string> = { falchion: 'фальшион', sabre: 'сабля' };
export const CRAFT_IDLE_CLASS = 'Кузнец сейчас не куёт этот класс';
export const CRAFT_IDLE_FAMILY = 'Кузнец сейчас не куёт это семейство';
const pct = (x: number, d = 0): string => `${(x * 100).toFixed(d)} %`;
const fx = (x: number, d = 1): string => x.toFixed(d);
const signed = (x: number, unit = '', d = 0): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;
const axisLabel = (x: number): string => `${x > 0 ? '+' : ''}${Math.round(x * 100) / 100}`;
/** NaN и бесконечность — `null` (JSON их не держит). */
const num = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** Семейства класса, которые кузнец сейчас куёт: в каждом гнезде есть включённая деталь (V-B3-06). */
export function forgeableFamilies(reg: ConfigRegistry, weaponClass: string): number[] {
  return familiesOf(reg, weaponClass).filter((h) => defaultParts(reg, weaponClass, h, 2) !== null);
}
/** Почему семейство окна не куётся; пусто — куётся. */
export function craftIdleReason(reg: ConfigRegistry, weaponClass: string, hands: number): string {
  if (defaultParts(reg, weaponClass, hands, 2)) return '';
  return forgeableFamilies(reg, weaponClass).length ? CRAFT_IDLE_FAMILY : CRAFT_IDLE_CLASS;
}
function blankParts(): CraftParts {
  const out = {} as CraftParts;
  for (const s of CRAFT_SLOT_LIST) out[s] = { id: '', step: 2 };
  return out;
}
/** Начальное состояние: эталонные детали ступени 2 первого семейства, которое кузнец куёт. */
export function initialCraftState(reg: ConfigRegistry, weaponClass = 'sword', hands?: number): CraftWindowState {
  const h = hands ?? forgeableFamilies(reg, weaponClass)[0] ?? familiesOf(reg, weaponClass)[0] ?? 1;
  return { weaponClass, hands: h, parts: defaultParts(reg, weaponClass, h, 2) ?? blankParts(), crafted: null, message: '' };
}
/**
 * Приводит выбор к допустимому (правит на месте): семейство есть у класса, ключевая деталь — открытой базы, детали своего семейства и
 * открытые, ступени — внутри окна материалов формы, доводка — существующая строка.
 */
export function normalizeCraftState(reg: ConfigRegistry, st: CraftWindowState, j: CraftJournal): void {
  st.finish = finishOf(reg, st.finish).index;
  const fams = familiesOf(reg, st.weaponClass);
  if (!fams.includes(st.hands)) st.hands = forgeableFamilies(reg, st.weaponClass)[0] ?? fams[0] ?? 1;
  const keySlot = keySlotOf(reg, st.weaponClass);
  const def = defaultParts(reg, st.weaponClass, st.hands, 2);
  if (!st.parts) st.parts = def ?? blankParts();
  const closest = (pool: WeaponPart[]): WeaponPart | undefined => [...pool].sort((a, b) => Math.abs(axisOf(reg, a)) - Math.abs(axisOf(reg, b)))[0];
  for (const slot of CRAFT_SLOT_LIST) {
    let pool: WeaponPart[];
    if (slot === keySlot) {
      const groups = keyVariantsByBase(reg, st.weaponClass, st.hands).filter((g) => j.bases.includes(g.baseId));
      pool = groups.flatMap((g) => g.variants).filter((p) => j.variants.includes(p.id));
      const cur = st.parts[slot] && pool.find((p) => p.id === st.parts[slot].id);
      if (!cur) {
        const rank = (id: string): number => { const b = reg.get('items.base').find((x) => x.id === id); return b ? baseTierRange(reg, b).hi : -1; };
        const g = [...groups].sort((a, b) => rank(b.baseId) - rank(a.baseId)).find((x) => x.variants.some((p) => j.variants.includes(p.id)));
        const p = g ? closest(g.variants.filter((v) => j.variants.includes(v.id)))
          : closest(keyVariantsByBase(reg, st.weaponClass, st.hands).find((x) => x.variants.length)?.variants ?? []);
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

type Ranges = NonNullable<ReturnType<typeof craftWeapon>['ranges']>;
/** « · урон 9–15 из вилки … · бросок 40 % вилки» — где в вилке выпал урон скованной вещи. */
export function craftRollVerdict(item: Item, ranges: Ranges | undefined, floor: number): string {
  const mn = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat')?.value;
  const mx = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat')?.value;
  if (mn === undefined || mx === undefined || !ranges?.minDamage || !ranges.maxDamage) return '';
  const k = item.damageMult ?? 1, r = (v: number): number => Math.round(v * k);
  const q = item.baseRoll ? ((item.baseRoll.minDamage ?? 0.5) + (item.baseRoll.maxDamage ?? 0.5)) / 2 : 0.5;
  const pos = floor >= 1 ? 100 : Math.round((Math.max(0, q - floor) / (1 - floor)) * 100);
  return ` · урон ${r(mn)}–${r(mx)} из вилки ${rangeLabel(ranges.minDamage, k)}–${rangeLabel(ranges.maxDamage, k)} · бросок ${pos} % вилки`;
}
function partCaption(reg: ConfigRegistry, p: WeaponPart): string {
  const b = bladeStats(reg, p);
  return b ? bladeCaption(b) : p.caption;
}
function bladeMeasureLine(reg: ConfigRegistry, p: WeaponPart): string {
  const b = bladeStats(reg, p), g = p.geom;
  if (!b || !g) return '';
  const br = b.bracket;
  const fk = b.form ? reg.get('balance').craft.blade.forms[b.form] : undefined;
  return [
    `клинок ${g.len} см${br ? ` · вилка «${br.name}» ${br.lo}–${br.hi} см` : ' · вне вилок'}${b.outOfBracket && br ? ' (вне вилки — ось в упоре)' : ''} → место ${signed(b.place, '', 2)}, ось ${signed(b.axis, '', 2)}`,
    `ширина ${g.width} см${br ? ` (эталон ${br.width})` : ''} → разброс ×${fx(b.spread, 2)}`,
    `центр тяжести ${pct(g.bal)} длины → баланс клинка ${signed(b.balance, '', 2)}`,
    fk && b.form ? `${FORM_NAME[b.form]}: длина ${signed(fk.length, '', 2)}, баланс ${signed(fk.balance, '', 2)}` : '',
  ].filter(Boolean).join('\n');
}
function partEffect(reg: ConfigRegistry, slot: CraftSlot, part: WeaponPart, st: CraftWindowState, baseId: string | undefined): string {
  const k = reg.get('balance').craft;
  const weaponClass = st.weaponClass;
  if (slot === 'strike') {
    const b = bladeStats(reg, part);
    const axis = b?.axis ?? part.axis;
    const out = [`урон ×${fx(1 + k.strike.damagePct * axis, 2)}`, `скорость ×${fx(1 - k.strike.attackSpeed * axis, 2)}`];
    if (b) out.push(`разброс ×${fx(b.spread, 2)}`);
    if (b?.form) out.push(FORM_NAME[b.form]!);
    return out.join(' · ');
  }
  const axis = part.axis;
  if (slot === 'grip') {
    const r = k.gripK ** axis, a = k.gripK ** (-2 * axis);
    return ['bow', 'crossbow', 'wand', 'staff'].includes(weaponClass) ? 'только вид (§5.2)' : `дальность ×${fx(r, 2)} · дуга ×${fx(a, 2)}`;
  }
  if (slot === 'bind') return axis > 0 ? 'больше префиксов' : axis < 0 ? 'больше суффиксов' : 'поровну';
  const strike = partById(reg, st.parts.strike.id);
  const bal = strike ? balanceAxisOf(reg, strike, part) : axis;
  const lead = strike && bladeStats(reg, strike) ? `баланс ${signed(bal, '', 2)}: ` : '';
  const base = reg.get('items.base').find((b) => b.id === baseId);
  const own = base?.baseStats.filter((m) => m.stat === 'blockChance' && m.kind === 'flat').reduce((s, m) => s + m.value, 0) ?? 0;
  const floor = weaponClass === 'bow' ? (bal < 0 ? ' (в ноль)' : '') : base && own + k.headBlock * bal < 0 ? ` (у базы ${fx(own * 100, 0)} % — в ноль)` : '';
  const brace = (weaponClass === 'bow' ? `стойкость ${signed(k.headInterrupt * bal * 100, ' п.п.', 1)}` : `блок ${signed(k.headBlock * bal * 100, ' п.п.', 1)}`) + floor;
  const kind = base?.kind === 'weapon' ? statusKindOf(reg, base) : undefined;
  if (base && !(kind && k.bite[kind])) return `${lead}${brace}`;
  const name = kind ? reg.get('debuffs').find((d) => d.id === kind)?.name.toLowerCase() ?? kind : 'статус';
  return `${lead}${brace} · ${name} ${bal < 0 ? 'чаще' : bal > 0 ? 'реже' : 'как есть'}`;
}
function sketchElsewhere(reg: ConfigRegistry, j: CraftJournal, p: WeaponPart, weaponClass: string, hands: number): string {
  if (p.slot !== keySlotOf(reg, weaponClass)) return '';
  const here = baseOfKeyPart(reg, weaponClass, hands, p);
  if (here && j.bases.includes(here)) return '';
  const where = new Set<string>();
  for (const cls of p.classes as string[]) {
    if (p.slot !== keySlotOf(reg, cls)) { where.add(reg.get('weapon-anatomy').find((a) => a.id === cls)?.name ?? cls); continue; }
    for (const h of [1, 2]) {
      const b = baseOfKeyPart(reg, cls, h, p);
      if (b && j.bases.includes(b)) where.add(`«${reg.get('items.base').find((x) => x.id === b)?.name ?? b}»`);
    }
  }
  return [...where].join(', ');
}
function baseLine(reg: ConfigRegistry, baseId: string | undefined): string {
  const base = reg.get('items.base').find((b) => b.id === baseId);
  if (!base || base.kind !== 'weapon') return '';
  const flat = (s: string): number | undefined => base.baseStats.find((m) => m.stat === s && m.kind === 'flat')?.value;
  const w = reg.get('weapon-weights').find((x) => x.id === base.weight);
  const edge = base.physSub ? reg.get('phys-subtypes').find((p) => p.id === base.physSub)?.name.toLowerCase() : reg.get('magic-subtypes').find((m) => m.id === base.damageType)?.name?.toLowerCase();
  const dmg = flat('minDamage') !== undefined ? `${flat('minDamage')}–${flat('maxDamage')}` : '';
  return [base.name, dmg, base.hands === 2 ? 'двуручное' : 'одноручное', edge ?? 'без грани', w ? `вес: ${w.name.toLowerCase()}` : ''].filter(Boolean).join(' · ');
}
/** Тултип вещи окна: имя с подписью слота и строки `describeItem` с признаком аффикса. */
function craftTip(reg: ConfigRegistry, it: Item) {
  return { name: `${it.name}${slotSuffix(it)}`, rarity: it.rarity, lines: describeItem(it, itemLabels(reg)) };
}

/** Что известно окну (у сервера — всё своё): журнал, сырьё (сумка + сундук), золото, сумка (null — место не проверяется). */
export interface CraftViewIn {
  st: CraftWindowState;
  journal: CraftJournal;
  wallet: Readonly<Record<string, number>>;
  gold: number;
  bag: readonly Item[] | null;
  /** Предлагает ли окно эскизы (у игры — да: команда `forgeSketch`). */
  sketch: boolean;
  /** Скованная вещь лежит в сумке (надетую не зачаровать); нет поля — в сумке. */
  craftedInBag?: boolean;
}

/** ⭐ С5: модель окна ковки. Приводит `v.st` к допустимому НА МЕСТЕ (`normalizeCraftState`), как веб-окно. */
export function craftView(reg: ConfigRegistry, v: CraftViewIn) {
  const st = v.st;
  const j = v.journal;
  normalizeCraftState(reg, st, j);
  const anat = anatomyOf(reg, st.weaponClass);
  const tiers = craftTiers(reg);
  const mats = reg.get('craft-materials');
  const matName = (id: string): string => mats.find((m) => m.id === id)?.name ?? id;
  const matOn = (id: string): boolean => mats.find((m) => m.id === id)?.enabled !== false;
  const keySlot = keySlotOf(reg, st.weaponClass);
  const busy = !!st.busy;
  const sketches = v.sketch ? j.sketches : 0;
  if (st.sketchPick && (sketches <= 0 || !sketchable(reg, j, st.sketchPick))) st.sketchPick = undefined;
  const wallet = v.wallet;
  const craftedInBag = v.craftedInBag ?? true;

  const classes = [...reg.get('weapon-anatomy')].sort((x, y) => CRAFT_CLASS_ORDER.indexOf(x.id) - CRAFT_CLASS_ORDER.indexOf(y.id)).map((a) => {
    const idle = !forgeableFamilies(reg, a.id).length;
    return { id: a.id, name: a.name, on: a.id === st.weaponClass, idle, disabled: busy };
  });
  const fams = familiesOf(reg, st.weaponClass);
  const family = fams.length > 1
    ? { chips: fams.map((h) => ({ h, label: h === 2 ? 'Двуручное' : 'Одноручное', on: h === st.hands, idle: !defaultParts(reg, st.weaponClass, h, 2), disabled: busy })) }
    : { text: fams[0] === 2 ? 'Семейство одно: двуручное' : 'Семейство одно: одноручное' };

  const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };
  const pv = craftWeapon(reg, input, { journal: j, materialsOn: true });
  const idle = craftIdleReason(reg, st.weaponClass, st.hands);
  const why = idle || pv.reason;
  const type = pv.type;
  const { q, tier } = tierOfSteps(reg, st.parts);
  const w = reg.get('balance').craft.tierFromParts.weights;
  const head = {
    name: type?.ok ? type.name : '—',
    tier: `${tiers[tier]?.id} ${tiers[tier]?.name}`, tierOk: pv.ok,
    tierTitle: `Средний уровень материала по массе: Q = (${w.strike}·${st.parts.strike.step} + ${st.parts.grip.step} + ${st.parts.bind.step} + ${st.parts.head.step}) / ${w.strike + w.grip + w.bind + w.head} = ${q}`,
    q: `Q = ${fx(q, 2)}`,
    subtitle: type?.ok && type.subtitle ? type.subtitle : null,
    formula: type?.ok && type.formula ? type.formula : null,
    mech: type?.ok ? `механика: ${baseLine(reg, type.baseId)}` : null,
    why: !pv.ok && why ? `⚠ ${why}` : null,
  };

  let sketch: { text: string; confirm?: string; disabled?: boolean } | null = null;
  if (sketches > 0) {
    const pk = st.sketchPick ? partById(reg, st.sketchPick) : undefined;
    if (!pk) sketch = { text: `✦ Эскизов: ${sketches} — открой закрытую деталь на выбор: нажми на неё в списке (✦). Ключевую форму неоткрытого типа эскиз не открывает — тип открывает разбор.` };
    else {
      const where = sketchElsewhere(reg, j, pk, st.weaponClass, st.hands);
      sketch = {
        text: `✦ Открыть «${pk.name}» эскизом? Эскизов останется ${sketches - 1} — вернуть эскиз нельзя.` + (where ? ` Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: ${where}.` : ''),
        confirm: st.busy === 'sketch' ? '⏳ открываю…' : '✦ Открыть эскизом', disabled: !!st.busy,
      };
    }
  }

  const all = anat ? [1, 2, 3, 4, 5].map((k) => ({ label: `ст. ${k} · ${matName(`${anat[keySlot].family}-${k}`)}`, on: CRAFT_SLOT_LIST.every((s) => st.parts[s].step === k) })) : null;

  const order: CraftSlot[] = [keySlot, ...CRAFT_SLOT_LIST.filter((s) => s !== keySlot)];
  const slots = order.map((slot) => {
    const isKey = slot === keySlot;
    const rows: unknown[] = [];
    const row = (p: WeaponPart, baseOpen = true) => {
      const known = j.variants.includes(p.id);
      const open = known && baseOpen;
      const bySketch = !known && sketches > 0 && sketchable(reg, j, p.id);
      const elsewhere = bySketch && !baseOpen ? sketchElsewhere(reg, j, p, st.weaponClass, st.hands) : '';
      const on = p.id === st.parts[slot].id || (bySketch && st.sketchPick === p.id);
      rows.push({
        id: p.id, text: `${open ? '' : bySketch ? '✦ ' : '🔒 '}${p.name}`, open, bySketch, on, rarity: p.rarity,
        range: `ст.${p.stepMin}–${p.stepMax}`, axis: axisLabel(axisOf(reg, p)),
        title: [partCaption(reg, p), p.lore, bladeMeasureLine(reg, p), `${RARITY_NAME[p.rarity]} · материал: ступени ${p.stepMin}–${p.stepMax}`,
          bySketch ? `✦ Открыть эскизом (эскизов: ${sketches})` : '',
          elsewhere ? `Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: ${elsewhere}` : ''].filter(Boolean).join('\n'),
        disabled: (!open && !bySketch) || busy,
      });
    };
    if (isKey) {
      for (const g of keyVariantsByBase(reg, st.weaponClass, st.hands)) {
        const baseOpen = j.bases.includes(g.baseId);
        const b = reg.get('items.base').find((x) => x.id === g.baseId);
        const hr = b ? baseTierRange(reg, b) : { lo: 0, hi: 6 };
        const cap = hr.hi < tiers.length - 1 ? ` · до ${tiers[hr.hi]?.id}` : '';
        rows.push({ head: `${baseOpen ? '' : '🔒 '}${baseLine(reg, g.baseId)}${cap}`, open: baseOpen });
        for (const p of g.variants) row(p, baseOpen);
      }
    } else for (const p of variantsFor(reg, st.weaponClass, slot, st.hands)) row(p);
    const sel = partById(reg, st.parts[slot].id);
    let mat: unknown = null;
    if (sel && anat) {
      const chips = [1, 2, 3, 4, 5].map((k) => {
        const inWin = k >= sel.stepMin && k <= sel.stepMax;
        const id = `${sel.family || anat[slot].family}-${k}`;
        return {
          label: stepLabel(reg, anat, slot, sel, k), on: st.parts[slot].step === k, disabled: !inWin || busy,
          title: inWin ? `${matName(id)} (${id})${matOn(id) ? '' : ' — ещё нет в игре'}` : `«${sel.name}» из этого не куётся: только ступени ${sel.stepMin}–${sel.stepMax}`,
          dashed: inWin && !matOn(id),
        };
      });
      const strikeSel = partById(reg, st.parts.strike.id);
      const measure = bladeMeasureLine(reg, sel);
      const bk = reg.get('balance').craft.blade.balance;
      mat = {
        label: `Материал · ${anat[slot].stepNames.length && !sel.family ? 'обработка' : matName(`${sel.family || anat[slot].family}-${st.parts[slot].step}`)}`,
        chips, caption: partCaption(reg, sel), effect: partEffect(reg, slot, sel, st, type?.baseId),
        effectTitle: measure || (slot === 'head' && strikeSel && bladeStats(reg, strikeSel)
          ? `Точка баланса вещи: ${Math.round(bk.bladeShare * 100)} % — клинок, ${Math.round((1 - bk.bladeShare) * 100)} % — оголовье (+ поправка формы), в ±1.\nВес у руки — упор (блок), вес к концу — укус (статус грани).`
          : null),
      };
    }
    return { slot, title: anat ? slotName(anat, slot, st.hands) : slot, key: isKey, role: CRAFT_SLOT_ROLE[slot], rows, mat };
  });

  const shown = st.crafted ?? pv.item;
  const left: Record<string, unknown> = {
    tip: shown ? craftTip(reg, shown) : null,
    cap: shown?.affixCap ? `Ёмкость: ${shown.affixCap.prefix} преф. + ${shown.affixCap.suffix} суф. — примет при зачаровании` : null,
    noItem: shown ? null : why || 'Не собирается',
    notes: (pv.bake?.notes ?? []).map((n) => `⚠ ${n}`),
  };
  const finishes = reg.get('balance').craft.finish;
  if (finishes.length > 1 && pv.cost && anat) {
    const strikeMat = pv.cost.lines.find((l) => l.slot === 'strike');
    left.finish = {
      head: `Доводка: ${slotName(anat, 'strike', st.hands)} — поднимает нижнюю границу урона, верх вилки не растёт`,
      chips: finishes.map((f, i) => {
        const extra = f.strikeUnits <= 0 && f.goldMult === 1 ? 'без надбавки' : `+${f.strikeUnits} ${strikeMat ? matName(strikeMat.id) : ''} · золото ×${fx(f.goldMult, 2)}`;
        return { label: f.name, on: (st.finish ?? 0) === i, title: `${extra}\nНиже ${Math.round(f.floor * 100)} % вилки урон не выпадет` };
      }),
    };
  }
  if (pv.cost && anat) {
    const lines = pv.cost.lines.map((l) => {
      const need = pv.cost!.materials[l.id] ?? 0, have = wallet[l.id] ?? 0;
      return { text: `${slotName(anat, l.slot, st.hands)}: ${matName(l.id)} — ${l.n}  (есть ${have})`, ok: have >= need };
    });
    const fc = pv.cost.finish;
    let fin: unknown = null;
    if (fc && fc.n > 0) {
      const need = pv.cost.materials[fc.id] ?? 0, have = wallet[fc.id] ?? 0;
      fin = { text: `${fc.name}: ${matName(fc.id)} — ${fc.n}  (всего ${need}, есть ${have})`, ok: have >= need };
    }
    left.cost = {
      head: `Цена: каждая деталь своим материалом (форма ×${fx(pv.cost.mult, 2)})`, lines, finish: fin,
      gold: { text: `Золото — ${pv.cost.gold}  (есть ${v.gold})`, ok: v.gold >= pv.cost.gold },
    };
  }
  const lack = pv.cost ? craftMissing(wallet, v.gold, pv.cost) : null;
  const short = lack ? [...(Object.keys(lack.materials).length ? [describeCost(reg, lack.materials)] : []), ...(lack.gold > 0 ? [`${lack.gold} золота`] : [])] : [];
  const bag = v.bag ?? undefined;
  const noRoom = pv.ok && !short.length && !!pv.item && !!pv.cost && !!bag && !craftFits(reg, bag, pv.cost.materials, pv.item);
  left.craft = {
    label: st.busy === 'craft' ? '⏳ куём…' : '🔨 Ковать', disabled: !pv.ok || busy || short.length > 0 || noRoom,
    title: !pv.ok && why ? why : short.length ? `Не хватает: ${short.join(' · ')}` : noRoom ? 'Нет места в сумке' : null,
  };
  if (st.crafted) {
    const item = st.crafted;
    left.enchant = (['magic', 'rare'] as const).map((r: Rarity) => {
      const cost = enchantCost(reg, item, r);
      const ess = enchantMaterials(reg, item, r);
      const essLack = Object.fromEntries(Object.entries(ess).filter(([id, n]) => (wallet[id] ?? 0) < n).map(([id, n]) => [id, n - (wallet[id] ?? 0)]));
      const essN = Object.values(ess)[0] ?? 0;
      const essHave = wallet[Object.keys(ess)[0] ?? ''] ?? 0;
      const fit = enchantSlots(reg, item, r);
      const why = item.rarity !== 'normal' ? 'Вещь уже зачарована'
        : !craftedInBag ? 'Надетую не зачаровать: сперва сними её в сумку'
        : item.broken ? 'Сперва почини'
        : !fit ? 'Кузнец не знает такой вещи'
        : Math.min(fit.slots.maxAffixes, fit.slots.maxPrefix + fit.slots.maxSuffix) <= 0 ? 'Этой вещи некуда принять свойства'
        : !fit.fillable ? 'Кузнецу не хватит свойств на форму этой вещи'
        : rolledFormMult(reg, item, r) === undefined ? FORM_UNPRICED
        : v.gold < cost ? `Недостаточно золота: нужно ${cost}`
        : Object.keys(essLack).length ? `Не хватает материалов: ${describeCost(reg, essLack)}` : '';
      return {
        label: st.busy === 'enchant' ? '⏳ зачаровываю…' : `✦ ${r === 'magic' ? 'Магический' : 'Редкий'}${essN > 0 ? ` · эссенция ${essN} (есть ${essHave})` : ''}${Number.isFinite(cost) ? ` · ${cost} з.` : ''}`,
        disabled: !!why || busy, title: why || null, cost: num(cost), essence: ess,
      };
    });
    left.equip = craftedInBag ? { label: st.busy === 'equip' ? '⏳ надеваю…' : 'Надеть', disabled: busy } : null;
    left.fresh = { disabled: busy };
  }
  left.message = st.message ? { text: st.message, bad: st.message.startsWith('Не') } : null;
  return { classes, family, head, sketch, all, slots, left, sketchPick: st.sketchPick ?? null };
}

/** ⭐ С5: строка итога ковки «Скована: имя · урон … · бросок N % вилки» — по скованной вещи и предпросмотру выбранной в окне сборки. */
export function craftVerdict(reg: ConfigRegistry, st: CraftWindowState, journal: CraftJournal, item: Item): string {
  const pv = craftWeapon(reg, { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 }, { journal, materialsOn: true });
  return `Скована: ${item.name}${craftRollVerdict(item, pv.ranges, pv.cost?.finish?.floor ?? 0)}`;
}
