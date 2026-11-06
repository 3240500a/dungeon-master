import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/items.js';
import {
  countsAsFind, craftTiers, emptyJournal, normalizeJournal, partById, salvageFullOrigin, salvageGrades, salvageIntoJournal, sketchable,
  typeNameOfItem, type CraftJournal,
} from '../formulas/craft.js';
import { ESSENCE_ID, type SalvageRng } from '../formulas/salvage.js';
import { catalogGained, catalogLine, essenceOf, salvageRange, salvageYield, starterKnownText } from './townActions.js';
import { cfgRowText, tr, trn } from '../i18n/tr.js';

/** Бросок «путь, без выхода»: путь разбора от кубика не зависит, выход здесь не нужен. */
const NO_ROLL: SalvageRng = { int: (a) => a, chance: () => false };

/**
 * ⭐ ЧТО ДОБАВИЛ БЫ В КАТАЛОГ РАЗБОР У КУЗНЕЦА — строками; пусто — нового нет (предложение «Разбор, сырьё и чары» §9).
 *
 * Сама проверка — ТА ЖЕ функция, которой кузнец пополняет каталог (`salvageIntoJournal`), над копией журнала: своих правил здесь нет.
 * ЛЮБАЯ вещь, которую кузнец разберёт (найденная, купленная, награда, без происхождения, стартовая, скованная, броня), пополняет каталог
 * (решение владельца D1): тип, детали, кодекс, снаряжение; эскиз — только у находок и только когда разбор ДОВОДИТ счёт жалости до него и
 * эскиз есть на что потратить. ⚠ Ступени ковки и мификов здесь нет: ковку держит только сырьё (решение D3), а не «потолок» журнала.
 * Журнала нет (кадр сундука не пришёл) — как пустой: лишнее обещание дешевле ловушки.
 * Вопросы перед разбором в поле и продажей (`journalGainsOf` клиента: в поле и в лавке каталог не пополнится, D2) и карточка разбора —
 * отсюда.
 */
export function salvageJournalGains(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined): string[] {
  if (!salvageYield(reg, item, NO_ROLL, false).ok) return [];
  const j = normalizeJournal(journal ?? emptyJournal());
  const u = salvageIntoJournal(reg, j, item);
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const sketch = u.sketch && reg.get('weapon-parts').some((p) => p.enabled !== false && sketchable(reg, u.journal, p.id));
  return [
    ...(u.newBase && base ? [tr('srv:salvage.gainType', 'тип «{name}»', { name: cfgRowText(reg, 'items.base', base) })] : []),
    ...u.unlocked.map((id) => tr('srv:salvage.gainPart', 'деталь «{name}»', { name: cfgRowText(reg, 'weapon-parts', partById(reg, id)) ?? id })),
    ...(u.newType ? [tr('srv:salvage.gainCodex', 'кодекс «{name}»', { name: typeNameOfItem(reg, item) ?? u.newType })] : []),
    ...(u.newGear && base ? [tr('srv:salvage.gainGear', 'снаряжение «{name}»', { name: cfgRowText(reg, 'items.base', base) })] : []),
    ...(sketch ? [tr('srv:salvage.gainSketch', 'эскиз — деталь на выбор')] : []),
  ];
}

/** Строка карточки разбора: подпись, текст и тон (`gain` — прибавка, `dim` — пояснение, `warn` — чего не будет и почему). */
export interface SalvageCardLine { label: string; text: string; tone: 'gain' | 'dim' | 'warn' }

/**
 * ⭐ КАРТОЧКА РАЗБОРА — ЧЕТЫРЕ СТРОКИ ВСЕГДА (предложение «Разбор, сырьё и чары» §15.2): сырьё, эссенция, каталог, эскиз — и у каждой
 * нулевой строки причина («Эссенция: нет — вещь куплена»). Без неё правила происхождения невидимы: две одинаковые с виду сабли
 * разбирались бы по-разному без объяснения. Всё — из тех же функций, что и сам разбор (`salvageYield`, `salvageRange`, `essenceOf`,
 * `salvageIntoJournal`, `catalogLine`): своих правил здесь нет. Веб и Unity (эталон `unity_salvage.json`) показывают это одинаково.
 */
export interface SalvageCard {
  /** Можно ли разобрать здесь. Нет — `reason`, строки всё равно заполнены (что было бы и почему нельзя). */
  ok: boolean;
  reason?: string;
  /** Глагол: скованное ПЕРЕПЛАВЛЯЮТ. */
  verb: 'salvage' | 'melt';
  /** Заголовок: «Разобрать — вещь исчезнет», «Переплавить — вещь исчезнет», «Разобрать здесь (30 %)». */
  title: string;
  /** Вилка выхода «от и до» (сырьё и эссенция) — та же, что у согласия `minYield` (`salvageRange`). */
  range: Record<string, { min: number; max: number }>;
  materials: SalvageCardLine;
  essence: SalvageCardLine;
  /**
   * Каталог — только у кузнеца: разбор в поле каталог не пишет вовсе (решение владельца D2), и строки в полевой карточке НЕТ (`null`) —
   * о том, что потеряешь, говорит подсказка (`hint`) и вопрос перед разбором (`disposePrompts`).
   */
  catalog: SalvageCardLine | null;
  /** Эскиз — только у оружия (не скованного); у прочего строки нет. */
  sketch: SalvageCardLine | null;
  /** Что добавил бы в каталог разбор у кузнеца (`salvageJournalGains`) — для вопроса перед полем и продажей. */
  gains: string[];
  /** Подсказка поля: у кузнеца выход больше и каталог. */
  hint?: string;
}

/** «вдвое больше», «втрое больше», «вчетверо больше» — во сколько раз у кузнеца больше, чем в поле; дальше — числом; меньше двух — «больше». */
function timesWord(n: number): string {
  if (!(n >= 2)) return tr('srv:salvage.timesMore', 'больше');
  if (n === 2) return tr('srv:salvage.times2', 'вдвое больше');
  if (n === 3) return tr('srv:salvage.times3', 'втрое больше');
  if (n === 4) return tr('srv:salvage.times4', 'вчетверо больше');
  // ⭐ i18n Ф1 (06.11): «раз/раза» — категория числа (`Intl.PluralRules`: 2–4 кроме 12–14 — `few`), а не своя арифметика окончаний
  return trn('srv:salvage.timesN', n, { one: 'в {n} раз больше', few: 'в {n} раза больше', many: 'в {n} раз больше', other: 'в {n} раза больше' });
}

/** Происхождение не-находки — словами для игрока. Чего нет в списке (поле из будущего) — «вещь не найдена». */
function notFoundWhy(item: Item): string {
  if (item.tierForged && !item.bornTier && item.origin && item.origin !== 'shop') return tr('srv:salvage.whyTierForged', 'ступень поднята кузнецом до учёта исходной');
  switch (item.origin) {
    case undefined: return tr('srv:salvage.whyLegacy', 'вещь из прежней версии');
    case 'shop': return tr('srv:salvage.whyBought', 'вещь куплена');
    case 'start': return tr('srv:salvage.whyStarter', 'стартовый набор');
    case 'craft': return tr('srv:salvage.whyCrafted', 'вещь скована');
    default: return tr('srv:salvage.whyNotFound', 'вещь не найдена');
  }
}

/** «+ Уклад 3 · + Варёная кожа 2–3» — по вилке; `approx` — «≈» поля. Эссенция — отдельной строкой. */
function rangeText(reg: ConfigRegistry, range: Record<string, { min: number; max: number }>, approx: boolean): string {
  const defs = reg.get('craft-materials');
  return Object.entries(range)
    .filter(([id]) => id !== ESSENCE_ID)
    .map(([id, r]) => `${approx ? '≈ ' : '+ '}${cfgRowText(reg, 'craft-materials', defs.find((m) => m.id === id)) ?? id} ${r.min === r.max ? r.min : `${r.min}–${r.max}`}`)
    .join(' · ');
}

/**
 * ⭐ ЧТО ДАСТ РАЗБОР ЭТОЙ ВЕЩИ — у кузнеца (`inField = false`) или здесь, в поле. `journal` — журнал кузнеца аккаунта (нет кадра — как
 * пустой). Карточка верстака кузницы, меню разбора в поле и вопрос перед продажей строятся отсюда.
 */
export function salvagePreview(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined, inField: boolean): SalvageCard {
  const fy = reg.get('balance').salvage.fieldYield;
  const melt = !!item.parts;
  const verb: SalvageCard['verb'] = melt ? 'melt' : 'salvage';
  const pct = `${Math.round(fy * 100)} %`;
  const title = inField
    ? (melt ? tr('srv:salvage.titleMeltHere', 'Переплавить здесь ({pct})', { pct }) : tr('srv:salvage.titleHere', 'Разобрать здесь ({pct})', { pct }))
    : (melt ? tr('srv:salvage.titleMelt', 'Переплавить — вещь исчезнет') : tr('srv:salvage.title', 'Разобрать — вещь исчезнет'));
  const path = salvageYield(reg, item, NO_ROLL, inField);
  const rng = salvageRange(reg, item, inField);
  const range = rng.ok ? rng.range : {};
  const j = normalizeJournal(journal ?? emptyJournal());
  const u = salvageIntoJournal(reg, j, item);
  const gains = salvageJournalGains(reg, item, j);
  const base = reg.get('items.base').find((b) => b.id === item.baseId);
  const kit = path.source === 'catalog' || (item.origin === 'start' && !item.tierForged);
  const full = salvageFullOrigin(item);
  const why = notFoundWhy(item);

  // ── Сырьё ──
  let materials: SalvageCardLine;
  const mats = rangeText(reg, range, inField);
  if (kit) materials = { label: tr('srv:salvage.cardMaterials', 'Сырьё'), text: tr('srv:salvage.matsStarter', 'сырья нет — стартовый набор бесплатный'), tone: 'dim' };
  else if (melt) materials = { label: tr('srv:salvage.cardMaterials', 'Сырьё'), text: tr('srv:salvage.matsMelt', '{mats} — вернётся доля заплаченного; эссенция и доводка не вернутся', { mats: mats || tr('srv:salvage.nothing', 'ничего') }), tone: mats ? 'gain' : 'dim' };
  else {
    const notes: string[] = [];
    if (!full) notes.push(tr('srv:salvage.matsGradeCap', '{why} — не выше {nonFindMaxGrade} сорта', { why, nonFindMaxGrade: gradeRoman(reg.get('balance').salvage.nonFindMaxGrade) }));
    if (item.bornTier) {
      const born = craftTiers(reg).find((t) => t.id === item.bornTier);
      if (born) notes.push(tr('srv:salvage.matsBornTier', 'как у вещи «{name}»: ступень поднята кузнецом', { name: cfgRowText(reg, 'item-tiers', born) }));
    }
    materials = { label: tr('srv:salvage.cardMaterials', 'Сырьё'), text: `${mats || tr('srv:salvage.nothing', 'ничего')}${notes.length ? ` (${notes.join('; ')})` : ''}`, tone: mats ? 'gain' : 'dim' };
  }

  // ── Эссенция ──
  const er = range[ESSENCE_ID];
  let essence: SalvageCardLine;
  if (er && er.max > 0) essence = { label: tr('srv:salvage.cardEssence', 'Эссенция'), text: inField ? `≈ ${er.min}–${er.max}` : `+ ${er.min === er.max ? er.min : `${er.min}–${er.max}`}`, tone: 'gain' };
  else if (melt) essence = { label: tr('srv:salvage.cardEssence', 'Эссенция'), text: tr('srv:salvage.essMelt', 'нет — переплавка эссенцию не возвращает'), tone: 'dim' };
  else if (kit) essence = { label: tr('srv:salvage.cardEssence', 'Эссенция'), text: tr('srv:salvage.essStarter', 'нет — стартовый набор'), tone: 'dim' };
  else if (!full && (item.rarity === 'magic' || item.rarity === 'rare')) essence = { label: tr('srv:salvage.cardEssence', 'Эссенция'), text: tr('srv:salvage.essNo', 'нет — {why}', { why }), tone: 'warn' };
  else if (essenceOf(reg, item) > 0) essence = { label: tr('srv:salvage.cardEssence', 'Эссенция'), text: tr('srv:salvage.essDisabled', 'нет — материал выключен'), tone: 'dim' };
  else essence = { label: tr('srv:salvage.cardEssence', 'Эссенция'), text: tr('srv:salvage.essNormal', 'нет — у обычной вещи чар нет'), tone: 'dim' };

  // ── Каталог: только у кузнеца (D2 — в поле строки нет) ──
  const catalog: SalvageCardLine | null = inField ? null
    : { label: tr('srv:salvage.cardCatalog', 'Каталог'), text: catalogLine(reg, item, u), tone: catalogGained(u) ? 'gain' : 'dim' };

  // ── Эскиз (жалость): только оружие, не скованное ──
  let sketch: SalvageCardLine | null = null;
  if (base?.kind === 'weapon' && !melt) {
    const k = reg.get('balance').craft.journal.sketchAfter;
    const cls = base.weaponClass;
    const label = (cfgRowText(reg, 'weapon-anatomy', reg.get('weapon-anatomy').find((a) => a.id === cls)) ?? cls).toLowerCase();
    if (!countsAsFind(item)) sketch = { label: tr('srv:salvage.cardSketch', 'Эскиз'), text: tr('srv:salvage.sketchFindsOnly', 'копят только находки'), tone: 'dim' };
    else if (inField) sketch = { label: tr('srv:salvage.cardSketch', 'Эскиз'), text: tr('srv:salvage.sketchForgeOnly', 'копит только разбор у кузнеца ({label} {classSalvages}/{k})', { label, classSalvages: j.classSalvages[cls] ?? 0, k }), tone: 'dim' };
    else if (u.sketch) sketch = { label: tr('srv:salvage.cardSketch', 'Эскиз'), text: tr('srv:salvage.sketchGain', '+ эскиз — деталь на выбор ({label} {k}/{k})', { label, k }), tone: 'gain' };
    else sketch = { label: tr('srv:salvage.cardSketch', 'Эскиз'), text: `${label} ${u.journal.classSalvages[cls] ?? 0}/${k}`, tone: 'dim' };
  }

  // ── Можно ли ──
  let ok = path.ok;
  let reason = path.ok ? undefined : path.reason;
  if (ok && path.source === 'catalog' && !catalogGained(u)) { ok = false; reason = starterKnownText(); }
  const tierIdx = salvageGrades(reg, item).tier;
  // Мягкая подсказка поля — где разница заметна: магическая, редкая (эссенция) и высокая ступень (дорогое сырьё); ⭐ и когда кузнец
  // добавил бы в каталог новое — в поле его не будет (D2).
  const hint = inField && ok && (er?.max || item.rarity === 'magic' || item.rarity === 'rare' || tierIdx >= 4 || gains.length > 0)
    ? (gains.length
      ? tr('srv:salvage.hintGains', 'у кузнеца сырья и эссенции {times}, и в каталог легло бы: {gains}', { times: timesWord(Math.round(1 / Math.max(fy, 1e-9))), gains: gains.join(', ') })
      : tr('srv:salvage.hintCatalog', 'у кузнеца сырья и эссенции {times}, и вещь попала бы в каталог', { times: timesWord(Math.round(1 / Math.max(fy, 1e-9))) }))
    : undefined;
  return { ok, ...(reason ? { reason } : {}), verb, title, range, materials, essence, catalog, sketch, gains, ...(hint ? { hint } : {}) };
}

/**
 * ⭐ СТРОКА ПРОИСХОЖДЕНИЯ В ПОДСКАЗКЕ ВЕЩИ (предложение «Разбор, сырьё и чары» §15.3) — для всего, что НЕ находка: «Куплено в лавке»,
 * «Награда за задание», «Стартовый набор», «Скована кузнецом», «Вещь из прежней версии» и «ступень поднята кузнецом (была «Отличный»)».
 * Без неё правила происхождения невидимы: две одинаковые с виду магические сабли разбирались бы по-разному (купленная — не выше III сорта
 * и без эссенции) без объяснения. Находка (дроп, сундук, босс) и происхождение из будущего, которого здесь нет, — `null`: молчим.
 * Сырьё и расходники — `null`: у стопки и зелья происхождения для игрока нет. `tierName` — имя ступени по id (`item-tiers`), нет — id.
 */
export function itemOriginNote(
  item: Pick<Item, 'kind' | 'origin' | 'tierForged' | 'bornTier'>, tierName: (id: string) => string | undefined,
): string | null {
  // Ф5-1: печать не разбирается на сырьё — она не вещь и не из сырья сделана (перековка 3→1 — Ф5-6′).
  if (item.kind === 'material' || item.kind === 'consumable' || item.kind === 'seal') return null;
  const head = item.origin === undefined ? tr('srv:salvage.originLegacy', 'Вещь из прежней версии')
    : item.origin === 'shop' ? tr('srv:salvage.originShop', 'Куплено в лавке')
    : item.origin === 'quest' ? tr('srv:salvage.originQuest', 'Награда за задание')
    : item.origin === 'start' ? tr('srv:salvage.originStart', 'Стартовый набор')
    : item.origin === 'craft' ? tr('srv:salvage.originCraft', 'Скована кузнецом')
    : '';
  const up = !item.tierForged ? ''
    : item.bornTier ? tr('srv:salvage.originTierUpWas', 'ступень поднята кузнецом (была «{bornTier}»)', { bornTier: tierName(item.bornTier) ?? item.bornTier }) : tr('srv:salvage.originTierUp', 'ступень поднята кузнецом');
  const text = [head, up].filter(Boolean).join(' · ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : null;
}

/** Сорт сырья римской цифрой: 1 → I … 5 → V (подписи склада «I сорт», карточки «не выше III сорта»). */
export function gradeRoman(n: number): string {
  return ['', 'I', 'II', 'III', 'IV', 'V'][Math.max(0, Math.min(5, Math.floor(n)))] ?? String(n);
}
