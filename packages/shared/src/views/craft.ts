import type { ConfigRegistry } from '../config/registry.js';
import type { CraftParts, Item, Rarity } from '../types/items.js';
import {
  CRAFT_SLOT_ROLE, FORM_UNPRICED, anatomyOf, baseTierRange, clampStep, craftMissing, craftTiers, craftWeapon, defaultParts, enchantCost,
  enchantSlots, finishOf, keyVariantsByBase, partById, resolveParts, rolledFormMult, sketchable, statusKindOf, stepLabel, tierOfSteps, variantsFor,
  type CraftInput, type CraftJournal,
} from '../formulas/craft.js';
import { CRAFT_SLOT_LIST, baseOfKeyPart, familiesOf, keySlotOf, slotName, typeDisplay, type CraftSlot, type WeaponPart } from '../formulas/craftType.js';
import { itemDisplayName } from '../formulas/itemDisplay.js';
import { axisOf, balanceAxisOf, bladeCaption, bladeStats } from '../formulas/bladeStats.js';
import { describeItem, rangeLabel, slotSuffix } from '../formulas/itemDescribe.js';
import { craftFits, describeCost, enchantMaterials } from '../economy/townActions.js';
import { itemLabels } from './townItem.js';
import { compareView } from './heroCard.js';
import { weaponLookSig } from '../session/weapon3d.js';
import type { SaveState } from '../types/save.js';
import { cfgRowText, tr } from '../i18n/tr.js';

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
  /**
   * ⭐ i18n Ф3 (07.11): итог — отказ (красным). Флаг ставит тот, кто пишет `message`: прежде цвет угадывался по русскому тексту
   * (`startsWith('Не')`), и на ином языке отказ кузницы вышел бы «удачей». Сервер итога не знает (`message` пуст → `left.message` null),
   * Unity держит свой флаг (`CraftPanel._messageBad`).
   */
  messageBad?: boolean;
  busy?: 'craft' | 'enchant' | 'equip' | 'sketch';
  sketchPick?: string;
}

/** Порядок классов в окне. */
export const CRAFT_CLASS_ORDER: readonly string[] = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];
const RARITY_NAME: Record<string, string> = { get common() { return tr('srv:partRarity.common', 'обычная'); }, get uncommon() { return tr('srv:partRarity.uncommon', 'нечастая'); }, get rare() { return tr('srv:partRarity.rare', 'редкая'); } };
const FORM_NAME: Record<string, string> = { get falchion() { return tr('srv:bladeFormName.falchion', 'фальшион'); }, get sabre() { return tr('srv:bladeFormName.sabre', 'сабля'); } };
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
  return forgeableFamilies(reg, weaponClass).length ? tr('srv:craft.idleFamily', CRAFT_IDLE_FAMILY) : tr('srv:craft.idleClass', CRAFT_IDLE_CLASS);
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
  return tr('srv:craft.rollVerdict', ' · урон {mn}–{mx} из вилки {rangeMin}–{rangeMax} · бросок {pos} % вилки', { mn: r(mn), mx: r(mx), rangeMin: rangeLabel(ranges.minDamage, k), rangeMax: rangeLabel(ranges.maxDamage, k), pos });
}
function partCaption(reg: ConfigRegistry, p: WeaponPart): string {
  const b = bladeStats(reg, p);
  return b ? bladeCaption(b) : cfgRowText(reg, 'weapon-parts', p, 'caption');
}
function bladeMeasureLine(reg: ConfigRegistry, p: WeaponPart): string {
  const b = bladeStats(reg, p), g = p.geom;
  if (!b || !g) return '';
  const br = b.bracket;
  const fk = b.form ? reg.get('balance').craft.blade.forms[b.form] : undefined;
  return [
    tr('srv:craft.bladeLen', 'клинок {len} см{bracket}{out} → место {place}, ось {axis}', { len: g.len, bracket: br ? tr('srv:craft.bladeBracket', ' · вилка «{name}» {lo}–{hi} см', { name: cfgRowText(reg, 'balance', br), lo: br.lo, hi: br.hi }) : tr('srv:craft.bladeNoBracket', ' · вне вилок'), out: b.outOfBracket && br ? tr('srv:craft.bladeOut', ' (вне вилки — ось в упоре)') : '', place: signed(b.place, '', 2), axis: signed(b.axis, '', 2) }),
    tr('srv:craft.bladeWidth', 'ширина {width} см{ref} → разброс ×{spread}', { width: g.width, ref: br ? tr('srv:craft.bladeWidthRef', ' (эталон {width})', { width: br.width }) : '', spread: fx(b.spread, 2) }),
    tr('srv:craft.bladeCenter', 'центр тяжести {pct} длины → баланс клинка {balance}', { pct: pct(g.bal), balance: signed(b.balance, '', 2) }),
    fk && b.form ? tr('srv:craft.bladeForm', '{form}: длина {length}, баланс {balance}', { form: FORM_NAME[b.form], length: signed(fk.length, '', 2), balance: signed(fk.balance, '', 2) }) : '',
  ].filter(Boolean).join('\n');
}
function partEffect(reg: ConfigRegistry, slot: CraftSlot, part: WeaponPart, st: CraftWindowState, baseId: string | undefined): string {
  const k = reg.get('balance').craft;
  const weaponClass = st.weaponClass;
  if (slot === 'strike') {
    const b = bladeStats(reg, part);
    const axis = b?.axis ?? part.axis;
    const out = [tr('srv:craft.effDamage', 'урон ×{mult}', { mult: fx(1 + k.strike.damagePct * axis, 2) }), tr('srv:craft.effSpeed', 'скорость ×{mult}', { mult: fx(1 - k.strike.attackSpeed * axis, 2) })];
    if (b) out.push(tr('srv:craft.effSpread', 'разброс ×{spread}', { spread: fx(b.spread, 2) }));
    if (b?.form) out.push(FORM_NAME[b.form]!);
    return out.join(' · ');
  }
  const axis = part.axis;
  if (slot === 'grip') {
    const r = k.gripK ** axis, a = k.gripK ** (-2 * axis);
    return ['bow', 'crossbow', 'wand', 'staff'].includes(weaponClass) ? tr('srv:craft.effLookOnly', 'только для вида') : tr('srv:craft.effReachArc', 'дальность ×{reach} · дуга ×{arc}', { reach: fx(r, 2), arc: fx(a, 2) });
  }
  if (slot === 'bind') return axis > 0 ? tr('srv:craft.effPrefixes', 'больше префиксов') : axis < 0 ? tr('srv:craft.effSuffixes', 'больше суффиксов') : tr('srv:craft.effEven', 'поровну');
  const strike = partById(reg, st.parts.strike.id);
  const bal = strike ? balanceAxisOf(reg, strike, part) : axis;
  const lead = strike && bladeStats(reg, strike) ? tr('srv:craft.effBalance', 'баланс {bal}: ', { bal: signed(bal, '', 2) }) : '';
  const base = reg.get('items.base').find((b) => b.id === baseId);
  const own = base?.baseStats.filter((m) => m.stat === 'blockChance' && m.kind === 'flat').reduce((s, m) => s + m.value, 0) ?? 0;
  const floor = weaponClass === 'bow' ? (bal < 0 ? tr('srv:craft.effZero', ' (в ноль)') : '') : base && own + k.headBlock * bal < 0 ? tr('srv:craft.effBaseZero', ' (у базы {own} % — в ноль)', { own: fx(own * 100, 0) }) : '';
  const brace = (weaponClass === 'bow' ? tr('srv:craft.effInterrupt', 'стойкость {v}', { v: signed(k.headInterrupt * bal * 100, tr('srv:compare.pp', ' п.п.'), 1) }) : tr('srv:craft.effBlock', 'блок {v}', { v: signed(k.headBlock * bal * 100, tr('srv:compare.pp', ' п.п.'), 1) })) + floor;
  const kind = base?.kind === 'weapon' ? statusKindOf(reg, base) : undefined;
  if (base && !(kind && k.bite[kind])) return `${lead}${brace}`;
  const name = kind ? cfgRowText(reg, 'debuffs', reg.get('debuffs').find((d) => d.id === kind))?.toLowerCase() ?? kind : tr('srv:craft.effStatus', 'статус');
  return `${lead}${brace} · ${name} ${bal < 0 ? tr('srv:craft.effMore', 'чаще') : bal > 0 ? tr('srv:craft.effLess', 'реже') : tr('srv:craft.effSame', 'как есть')}`;
}
function sketchElsewhere(reg: ConfigRegistry, j: CraftJournal, p: WeaponPart, weaponClass: string, hands: number): string {
  if (p.slot !== keySlotOf(reg, weaponClass)) return '';
  const here = baseOfKeyPart(reg, weaponClass, hands, p);
  if (here && j.bases.includes(here)) return '';
  const where = new Set<string>();
  for (const cls of p.classes as string[]) {
    if (p.slot !== keySlotOf(reg, cls)) { where.add(cfgRowText(reg, 'weapon-anatomy', reg.get('weapon-anatomy').find((a) => a.id === cls)) ?? cls); continue; }
    for (const h of [1, 2]) {
      const b = baseOfKeyPart(reg, cls, h, p);
      if (b && j.bases.includes(b)) where.add(`«${cfgRowText(reg, 'items.base', reg.get('items.base').find((x) => x.id === b)) ?? b}»`);
    }
  }
  return [...where].join(', ');
}
function baseLine(reg: ConfigRegistry, baseId: string | undefined): string {
  const base = reg.get('items.base').find((b) => b.id === baseId);
  if (!base || base.kind !== 'weapon') return '';
  const flat = (s: string): number | undefined => base.baseStats.find((m) => m.stat === s && m.kind === 'flat')?.value;
  const w = reg.get('weapon-weights').find((x) => x.id === base.weight);
  const edge = base.physSub ? cfgRowText(reg, 'phys-subtypes', reg.get('phys-subtypes').find((p) => p.id === base.physSub))?.toLowerCase() : cfgRowText(reg, 'magic-subtypes', reg.get('magic-subtypes').find((m) => m.id === base.damageType))?.toLowerCase();
  const dmg = flat('minDamage') !== undefined ? `${flat('minDamage')}–${flat('maxDamage')}` : '';
  return [cfgRowText(reg, 'items.base', base), dmg, base.hands === 2 ? tr('srv:craft.twoHanded', 'двуручное') : tr('srv:craft.oneHanded', 'одноручное'), edge ?? tr('srv:craft.noEdge', 'без грани'), w ? tr('srv:craft.weight', 'вес: {weight}', { weight: cfgRowText(reg, 'weapon-weights', w).toLowerCase() }) : ''].filter(Boolean).join(' · ');
}
/** Тултип вещи окна: имя с подписью слота и строки `describeItem` с признаком аффикса. */
function craftTip(reg: ConfigRegistry, it: Item) {
  return { name: `${itemDisplayName(reg, it)}${slotSuffix(it)}`, rarity: it.rarity, lines: describeItem(it, itemLabels(reg)) };   // ⭐ i18n Ф2: имя — на языке игрока
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
  const matName = (id: string): string => cfgRowText(reg, 'craft-materials', mats.find((m) => m.id === id)) ?? id;
  const matOn = (id: string): boolean => mats.find((m) => m.id === id)?.enabled !== false;
  const keySlot = keySlotOf(reg, st.weaponClass);
  const busy = !!st.busy;
  const sketches = v.sketch ? j.sketches : 0;
  if (st.sketchPick && (sketches <= 0 || !sketchable(reg, j, st.sketchPick))) st.sketchPick = undefined;
  const wallet = v.wallet;
  const craftedInBag = v.craftedInBag ?? true;

  const classes = [...reg.get('weapon-anatomy')].sort((x, y) => CRAFT_CLASS_ORDER.indexOf(x.id) - CRAFT_CLASS_ORDER.indexOf(y.id)).map((a) => {
    const idle = !forgeableFamilies(reg, a.id).length;
    return { id: a.id, name: cfgRowText(reg, 'weapon-anatomy', a), on: a.id === st.weaponClass, idle, disabled: busy };
  });
  const fams = familiesOf(reg, st.weaponClass);
  const family = fams.length > 1
    ? { chips: fams.map((h) => ({ h, label: h === 2 ? tr('srv:craft.famTwo', 'Двуручное') : tr('srv:craft.famOne', 'Одноручное'), on: h === st.hands, idle: !defaultParts(reg, st.weaponClass, h, 2), disabled: busy })) }
    : { text: fams[0] === 2 ? tr('srv:craft.famOnlyTwo', 'Семейство одно: двуручное') : tr('srv:craft.famOnlyOne', 'Семейство одно: одноручное') };

  const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };
  const pv = craftWeapon(reg, input, { journal: j, materialsOn: true });
  const idle = craftIdleReason(reg, st.weaponClass, st.hands);
  const why = idle || pv.reason;
  const type = pv.type;
  // ⭐ i18n Ф2 (06.11): имя, подзаголовок и формула типа — на языке игрока (`typeDisplay`); в имя вещи тип печётся источником (`craftedName`)
  const rp = type?.ok ? resolveParts(reg, st.weaponClass, st.hands, st.parts) : undefined;
  const typeShown = type?.ok && rp?.ok ? typeDisplay(reg, st.weaponClass, st.hands, rp.parts, type) : type;
  const { q, tier } = tierOfSteps(reg, st.parts);
  const w = reg.get('balance').craft.tierFromParts.weights;
  const head = {
    name: type?.ok ? typeShown!.name : '—',
    tier: `${tiers[tier]?.id} ${cfgRowText(reg, 'item-tiers', tiers[tier])}`, tierOk: pv.ok,
    tierTitle: tr('srv:craft.tierTitle', 'Средний уровень материала по массе: Q = ({ws}·{s1} + {s2} + {s3} + {s4}) / {wsum} = {q}', { ws: w.strike, s1: st.parts.strike.step, s2: st.parts.grip.step, s3: st.parts.bind.step, s4: st.parts.head.step, wsum: w.strike + w.grip + w.bind + w.head, q }),
    q: `Q = ${fx(q, 2)}`,
    subtitle: type?.ok && typeShown!.subtitle ? typeShown!.subtitle : null,
    formula: type?.ok && typeShown!.formula ? typeShown!.formula : null,
    mech: type?.ok ? tr('srv:craft.mech', 'механика: {baseLine}', { baseLine: baseLine(reg, type.baseId) }) : null,
    why: !pv.ok && why ? `⚠ ${why}` : null,
  };

  let sketch: { text: string; confirm?: string; disabled?: boolean } | null = null;
  if (sketches > 0) {
    const pk = st.sketchPick ? partById(reg, st.sketchPick) : undefined;
    if (!pk) sketch = { text: tr('srv:craft.sketchHint', '✦ Эскизов: {sketches} — открой закрытую деталь на выбор: нажми на неё в списке (✦). Ключевую форму неоткрытого типа эскиз не открывает — тип открывает разбор.', { sketches }) };
    else {
      const where = sketchElsewhere(reg, j, pk, st.weaponClass, st.hands);
      sketch = {
        // ⭐ i18n Ф1 (06.11): два предложения целиком (с «где ковать» и без), а не хвост-приставка
        text: where
          ? tr('srv:craft.sketchConfirmWhere', '✦ Открыть «{name}» эскизом? Эскизов останется {left} — вернуть эскиз нельзя. Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: {where}.', { name: cfgRowText(reg, 'weapon-parts', pk), left: sketches - 1, where })
          : tr('srv:craft.sketchConfirm', '✦ Открыть «{name}» эскизом? Эскизов останется {left} — вернуть эскиз нельзя.', { name: cfgRowText(reg, 'weapon-parts', pk), left: sketches - 1 }),
        confirm: st.busy === 'sketch' ? tr('srv:craft.sketchBusy', '⏳ открываю…') : tr('srv:craft.sketchConfirmBtn', '✦ Открыть эскизом'), disabled: !!st.busy,
      };
    }
  }

  const all = anat ? [1, 2, 3, 4, 5].map((k) => ({ label: tr('srv:craft.allSteps', 'ст. {k} · {mat}', { k, mat: matName(`${anat[keySlot].family}-${k}`) }), on: CRAFT_SLOT_LIST.every((s) => st.parts[s].step === k) })) : null;

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
        id: p.id, text: `${open ? '' : bySketch ? '✦ ' : '🔒 '}${cfgRowText(reg, 'weapon-parts', p)}`, open, bySketch, on, rarity: p.rarity,
        range: tr('srv:craft.stepRange', 'ст.{stepMin}–{stepMax}', { stepMin: p.stepMin, stepMax: p.stepMax }), axis: axisLabel(axisOf(reg, p)),
        title: [partCaption(reg, p), cfgRowText(reg, 'weapon-parts', p, 'lore'), bladeMeasureLine(reg, p), tr('srv:craft.partRarityLine', '{rarity} · материал: ступени {stepMin}–{stepMax}', { rarity: RARITY_NAME[p.rarity], stepMin: p.stepMin, stepMax: p.stepMax }),
          bySketch ? tr('srv:craft.sketchOpen', '✦ Открыть эскизом (эскизов: {sketches})', { sketches }) : '',
          elsewhere ? tr('srv:craft.sketchElsewhere', 'Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: {elsewhere}', { elsewhere }) : ''].filter(Boolean).join('\n'),
        disabled: (!open && !bySketch) || busy,
        // ⭐ i18n (07.11, хвосты Ф1): имя детали БЕЗ знака закрытой («✦ » / «🔒 » в `text`) — окно снимало знак разбором начала строки
        // (`CraftPanel.PartName`)
        name: cfgRowText(reg, 'weapon-parts', p),
      });
    };
    if (isKey) {
      for (const g of keyVariantsByBase(reg, st.weaponClass, st.hands)) {
        const baseOpen = j.bases.includes(g.baseId);
        const b = reg.get('items.base').find((x) => x.id === g.baseId);
        const hr = b ? baseTierRange(reg, b) : { lo: 0, hi: 6 };
        const cap = hr.hi < tiers.length - 1 ? tr('srv:craft.tierCap', ' · до {id}', { id: tiers[hr.hi]?.id }) : '';
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
          title: inWin ? `${matName(id)} (${id})${matOn(id) ? '' : tr('srv:craft.matNotLive', ' — ещё нет в игре')}` : tr('srv:craft.partStepOut', '«{name}» из этого не куётся: только ступени {stepMin}–{stepMax}', { name: cfgRowText(reg, 'weapon-parts', sel), stepMin: sel.stepMin, stepMax: sel.stepMax }),
          dashed: inWin && !matOn(id),
        };
      });
      const strikeSel = partById(reg, st.parts.strike.id);
      const measure = bladeMeasureLine(reg, sel);
      const bk = reg.get('balance').craft.blade.balance;
      mat = {
        label: tr('srv:craft.matLabel', 'Материал · {mat}', { mat: anat[slot].stepNames.length && !sel.family ? tr('srv:craft.matProcessing', 'обработка') : matName(`${sel.family || anat[slot].family}-${st.parts[slot].step}`) }),
        chips, caption: partCaption(reg, sel), effect: partEffect(reg, slot, sel, st, type?.baseId),
        effectTitle: measure || (slot === 'head' && strikeSel && bladeStats(reg, strikeSel)
          ? tr('srv:craft.balanceTitle', 'Точка баланса вещи: {blade} % — клинок, {head} % — оголовье (+ поправка формы), в ±1.\nВес у руки — упор (блок), вес к концу — укус (статус грани).', { blade: Math.round(bk.bladeShare * 100), head: Math.round((1 - bk.bladeShare) * 100) })
          : null),
      };
    }
    return { slot, title: anat ? slotName(anat, slot, st.hands, reg) : slot, key: isKey, role: CRAFT_SLOT_ROLE[slot], rows, mat };
  });

  const shown = st.crafted ?? pv.item;
  const left: Record<string, unknown> = {
    tip: shown ? craftTip(reg, shown) : null,
    cap: shown?.affixCap ? tr('srv:craft.capacity', 'Ёмкость: {prefix} преф. + {suffix} суф. — примет при зачаровании', { prefix: shown.affixCap.prefix, suffix: shown.affixCap.suffix }) : null,
    noItem: shown ? null : why || tr('srv:craft.notAssembled', 'Не собирается'),
    notes: (pv.bake?.notes ?? []).map((n) => `⚠ ${n}`),
  };
  const finishes = reg.get('balance').craft.finish;
  if (finishes.length > 1 && pv.cost && anat) {
    const strikeMat = pv.cost.lines.find((l) => l.slot === 'strike');
    left.finish = {
      head: tr('srv:craft.finishHead', 'Доводка: {slot} — поднимает нижнюю границу урона, верх вилки не растёт', { slot: slotName(anat, 'strike', st.hands, reg) }),
      chips: finishes.map((f, i) => {
        const extra = f.strikeUnits <= 0 && f.goldMult === 1 ? tr('srv:craft.finishNone', 'без надбавки') : tr('srv:craft.finishExtra', '+{strikeUnits} {mat} · золото ×{goldMult}', { strikeUnits: f.strikeUnits, mat: strikeMat ? matName(strikeMat.id) : '', goldMult: fx(f.goldMult, 2) });
        return { label: cfgRowText(reg, 'balance', f), on: (st.finish ?? 0) === i, title: tr('srv:craft.finishFloor', '{extra}\nНиже {floor} % вилки урон не выпадет', { extra, floor: Math.round(f.floor * 100) }) };
      }),
    };
  }
  if (pv.cost && anat) {
    const lines = pv.cost.lines.map((l) => {
      const need = pv.cost!.materials[l.id] ?? 0, have = wallet[l.id] ?? 0;
      return { text: tr('srv:craft.costLine', '{slot}: {mat} — {n}  (есть {have})', { slot: slotName(anat, l.slot, st.hands, reg), mat: matName(l.id), n: l.n, have }), ok: have >= need };
    });
    const fc = pv.cost.finish;
    let fin: unknown = null;
    if (fc && fc.n > 0) {
      const need = pv.cost.materials[fc.id] ?? 0, have = wallet[fc.id] ?? 0;
      fin = { text: tr('srv:craft.costFinish', '{name}: {mat} — {n}  (всего {need}, есть {have})', { name: fc.name, mat: matName(fc.id), n: fc.n, need, have }), ok: have >= need };
    }
    left.cost = {
      head: tr('srv:craft.costHead', 'Цена: каждая деталь своим материалом (форма ×{mult})', { mult: fx(pv.cost.mult, 2) }), lines, finish: fin,
      gold: { text: tr('srv:craft.costGold', 'Золото — {gold}  (есть {have})', { gold: pv.cost.gold, have: v.gold }), ok: v.gold >= pv.cost.gold },
    };
  }
  const lack = pv.cost ? craftMissing(wallet, v.gold, pv.cost) : null;
  const short = lack ? [...(Object.keys(lack.materials).length ? [describeCost(reg, lack.materials)] : []), ...(lack.gold > 0 ? [tr('srv:forge.goldAmount', '{gold} золота', { gold: lack.gold })] : [])] : [];
  const bag = v.bag ?? undefined;
  const noRoom = pv.ok && !short.length && !!pv.item && !!pv.cost && !!bag && !craftFits(reg, bag, pv.cost.materials, pv.item);
  left.craft = {
    label: st.busy === 'craft' ? tr('srv:craft.crafting', '⏳ куём…') : tr('srv:craft.craftBtn', '🔨 Ковать'), disabled: !pv.ok || busy || short.length > 0 || noRoom,
    title: !pv.ok && why ? why : short.length ? tr('srv:forge.lacking', 'Не хватает: {parts}', { parts: short.join(' · ') }) : noRoom ? tr('srv:town.noRoomInBag', 'Нет места в сумке') : null,
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
      const why = item.rarity !== 'normal' ? tr('srv:forge.alreadyEnchanted', 'Вещь уже зачарована')
        : !craftedInBag ? tr('srv:craft.enchantWorn', 'Надетую не зачаровать: сперва сними её в сумку')
        : item.broken ? tr('srv:forge.repairFirst', 'Сперва почини')
        : !fit ? tr('srv:forge.unknownItem', 'Кузнец не знает такой вещи')
        : Math.min(fit.slots.maxAffixes, fit.slots.maxPrefix + fit.slots.maxSuffix) <= 0 ? tr('srv:forge.noAffixRoom', 'Этой вещи некуда принять свойства')
        : !fit.fillable ? tr('srv:forge.formTooBig', 'Кузнецу не хватит свойств на форму этой вещи')
        : rolledFormMult(reg, item, r) === undefined ? tr('srv:forge.formUnpriced', FORM_UNPRICED)
        : v.gold < cost ? tr('srv:town.noGoldNeed', 'Недостаточно золота: нужно {cost}', { cost })
        : Object.keys(essLack).length ? tr('srv:town.noMaterials', 'Не хватает материалов: {cost}', { cost: describeCost(reg, essLack) }) : '';
      return {
        label: st.busy === 'enchant' ? tr('srv:craft.enchanting', '⏳ зачаровываю…') : `✦ ${r === 'magic' ? tr('srv:craft.enchantMagic', 'Магический') : tr('srv:craft.enchantRare', 'Редкий')}${essN > 0 ? tr('srv:craft.enchantEssence', ' · эссенция {essN} (есть {essHave})', { essN, essHave }) : ''}${Number.isFinite(cost) ? tr('srv:craft.enchantGold', ' · {cost} з.', { cost }) : ''}`,
        disabled: !!why || busy, title: why || null, cost: num(cost), essence: ess,
      };
    });
    left.equip = craftedInBag ? { label: st.busy === 'equip' ? tr('srv:craft.equipping', '⏳ надеваю…') : tr('srv:craft.equip', 'Надеть'), disabled: busy } : null;
    left.fresh = { disabled: busy };
  }
  left.message = st.message ? { text: st.message, bad: st.messageBad === true } : null;
  return { classes, family, head, sketch, all, slots, left, sketchPick: st.sketchPick ?? null };
}

/** ⭐ С5: строка итога ковки «Скована: имя · урон … · бросок N % вилки» — по скованной вещи и предпросмотру выбранной в окне сборки. */
export function craftVerdict(reg: ConfigRegistry, st: CraftWindowState, journal: CraftJournal, item: Item): string {
  const pv = craftWeapon(reg, { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 }, { journal, materialsOn: true });
  return tr('srv:craft.verdict', 'Скована: {name}{roll}', { name: itemDisplayName(reg, item), roll: craftRollVerdict(item, pv.ranges, pv.cost?.finish?.floor ?? 0) });
}

/**
 * ⭐ С5: ОКНО КОВКИ, КАК ЕГО ОТДАЁТ СЕРВЕР (кадр `view` → `craft`): модель `craftView` плюс то, чего веб-окно не клало в данные, а
 * считало у себя: строка итога (`verdict`), приведённый выбор (`state` — его окно и рисует, и шлёт), сравнение «в руках → скую»
 * (`compareView` — до ковки с КРАЯМИ вилки, низ и верх при этой доводке; после — со скованной), подпись вида сборки (`look` — по ней
 * 3D-стенд берёт меш) и согласие ковки в строке цены (`left.cost.maxGold` / `maxMaterials` — дороже сервер не возьмёт).
 */
export function craftWindowView(reg: ConfigRegistry, v: CraftViewIn & { save: SaveState; toggles: readonly string[] }) {
  const view = craftView(reg, v);
  const st = v.st;
  const verdict = st.crafted ? craftVerdict(reg, st, v.journal, st.crafted) : null;
  const state = { weaponClass: st.weaponClass, hands: st.hands, parts: st.parts, finish: st.finish ?? 0, sketchPick: st.sketchPick ?? null, crafted: st.crafted?.uid ?? null };
  const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };
  const pv = craftWeapon(reg, input, { journal: v.journal, materialsOn: true });
  const shown = st.crafted ?? pv.item;
  const edge = (at: 'lo' | 'hi'): Item | undefined => craftWeapon(reg, input, { journal: v.journal, materialsOn: true, at }).item;
  const compare = shown ? compareView(reg, v.save, shown, { toggles: [...v.toggles], edges: st.crafted ? {} : { lo: edge('lo'), hi: edge('hi') } }) : null;
  const look = pv.type?.ok && pv.type.baseId ? weaponLookSig({ baseId: pv.type.baseId, parts: st.parts }) : null;
  const cost = (view.left as { cost?: Record<string, unknown> }).cost;
  if (cost && pv.cost) { cost.maxGold = pv.cost.gold; cost.maxMaterials = pv.cost.materials; }
  return { ...view, verdict, state, compare, look };
}
