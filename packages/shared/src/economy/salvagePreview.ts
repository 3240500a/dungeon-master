import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/items.js';
import {
  countsAsFind, craftTiers, emptyJournal, normalizeJournal, partById, salvageFullOrigin, salvageGrades, salvageIntoJournal, sketchable,
  typeOfItem, type CraftJournal,
} from '../formulas/craft.js';
import { ESSENCE_ID, type SalvageRng } from '../formulas/salvage.js';
import { STARTER_KNOWN, catalogGained, catalogLine, essenceOf, salvageRange, salvageYield } from './townActions.js';

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
    ...(u.newBase && base ? [`тип «${base.name}»`] : []),
    ...u.unlocked.map((id) => `деталь «${partById(reg, id)?.name ?? id}»`),
    ...(u.newType ? [`кодекс «${typeOfItem(reg, item)?.name ?? u.newType}»`] : []),
    ...(u.newGear && base ? [`снаряжение «${base.name}»`] : []),
    ...(sketch ? ['эскиз — деталь на выбор'] : []),
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
  if (!(n >= 2)) return 'больше';
  const w = n === 2 ? 'вдвое' : n === 3 ? 'втрое' : n === 4 ? 'вчетверо' : `в ${n} раз${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'а' : ''}`;
  return `${w} больше`;
}

/** Происхождение не-находки — словами для игрока. Чего нет в списке (поле из будущего) — «вещь не найдена». */
function notFoundWhy(item: Item): string {
  if (item.tierForged && !item.bornTier && item.origin && item.origin !== 'shop') return 'ступень поднята кузнецом до учёта исходной';
  switch (item.origin) {
    case undefined: return 'вещь из прежней версии';
    case 'shop': return 'вещь куплена';
    case 'start': return 'стартовый набор';
    case 'craft': return 'вещь скована';
    default: return 'вещь не найдена';
  }
}

/** «+ Уклад 3 · + Варёная кожа 2–3» — по вилке; `approx` — «≈» поля. Эссенция — отдельной строкой. */
function rangeText(reg: ConfigRegistry, range: Record<string, { min: number; max: number }>, approx: boolean): string {
  const defs = reg.get('craft-materials');
  return Object.entries(range)
    .filter(([id]) => id !== ESSENCE_ID)
    .map(([id, r]) => `${approx ? '≈ ' : '+ '}${defs.find((m) => m.id === id)?.name ?? id} ${r.min === r.max ? r.min : `${r.min}–${r.max}`}`)
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
  const title = inField ? `${melt ? 'Переплавить' : 'Разобрать'} здесь (${pct})` : `${melt ? 'Переплавить' : 'Разобрать'} — вещь исчезнет`;
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
  if (kit) materials = { label: 'Сырьё', text: 'сырья нет — стартовый набор бесплатный', tone: 'dim' };
  else if (melt) materials = { label: 'Сырьё', text: `${mats || 'ничего'} — вернётся доля заплаченного; эссенция и доводка не вернутся`, tone: mats ? 'gain' : 'dim' };
  else {
    const notes: string[] = [];
    if (!full) notes.push(`${why} — не выше ${gradeRoman(reg.get('balance').salvage.nonFindMaxGrade)} сорта`);
    if (item.bornTier) {
      const born = craftTiers(reg).find((t) => t.id === item.bornTier);
      if (born) notes.push(`как у вещи «${born.name}»: ступень поднята кузнецом`);
    }
    materials = { label: 'Сырьё', text: `${mats || 'ничего'}${notes.length ? ` (${notes.join('; ')})` : ''}`, tone: mats ? 'gain' : 'dim' };
  }

  // ── Эссенция ──
  const er = range[ESSENCE_ID];
  let essence: SalvageCardLine;
  if (er && er.max > 0) essence = { label: 'Эссенция', text: inField ? `≈ ${er.min}–${er.max}` : `+ ${er.min === er.max ? er.min : `${er.min}–${er.max}`}`, tone: 'gain' };
  else if (melt) essence = { label: 'Эссенция', text: 'нет — переплавка эссенцию не возвращает', tone: 'dim' };
  else if (kit) essence = { label: 'Эссенция', text: 'нет — стартовый набор', tone: 'dim' };
  else if (!full && (item.rarity === 'magic' || item.rarity === 'rare')) essence = { label: 'Эссенция', text: `нет — ${why}`, tone: 'warn' };
  else if (essenceOf(reg, item) > 0) essence = { label: 'Эссенция', text: 'нет — материал выключен', tone: 'dim' };
  else essence = { label: 'Эссенция', text: 'нет — у обычной вещи чар нет', tone: 'dim' };

  // ── Каталог: только у кузнеца (D2 — в поле строки нет) ──
  const catalog: SalvageCardLine | null = inField ? null
    : { label: 'Каталог', text: catalogLine(reg, item, u), tone: catalogGained(u) ? 'gain' : 'dim' };

  // ── Эскиз (жалость): только оружие, не скованное ──
  let sketch: SalvageCardLine | null = null;
  if (base?.kind === 'weapon' && !melt) {
    const k = reg.get('balance').craft.journal.sketchAfter;
    const cls = base.weaponClass;
    const label = (reg.get('weapon-anatomy').find((a) => a.id === cls)?.name ?? cls).toLowerCase();
    if (!countsAsFind(item)) sketch = { label: 'Эскиз', text: 'копят только находки', tone: 'dim' };
    else if (inField) sketch = { label: 'Эскиз', text: `копит только разбор у кузнеца (${label} ${j.classSalvages[cls] ?? 0}/${k})`, tone: 'dim' };
    else if (u.sketch) sketch = { label: 'Эскиз', text: `+ эскиз — деталь на выбор (${label} ${k}/${k})`, tone: 'gain' };
    else sketch = { label: 'Эскиз', text: `${label} ${u.journal.classSalvages[cls] ?? 0}/${k}`, tone: 'dim' };
  }

  // ── Можно ли ──
  let ok = path.ok;
  let reason = path.ok ? undefined : path.reason;
  if (ok && path.source === 'catalog' && !catalogGained(u)) { ok = false; reason = STARTER_KNOWN; }
  const tierIdx = salvageGrades(reg, item).tier;
  // Мягкая подсказка поля — где разница заметна: магическая, редкая (эссенция) и высокая ступень (дорогое сырьё); ⭐ и когда кузнец
  // добавил бы в каталог новое — в поле его не будет (D2).
  const hint = inField && ok && (er?.max || item.rarity === 'magic' || item.rarity === 'rare' || tierIdx >= 4 || gains.length > 0)
    ? `у кузнеца сырья и эссенции ${timesWord(Math.round(1 / Math.max(fy, 1e-9)))}`
      + (gains.length ? `, и в каталог легло бы: ${gains.join(', ')}` : ', и вещь попала бы в каталог')
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
  if (item.kind === 'material' || item.kind === 'consumable') return null;
  const head = item.origin === undefined ? 'Вещь из прежней версии'
    : item.origin === 'shop' ? 'Куплено в лавке'
    : item.origin === 'quest' ? 'Награда за задание'
    : item.origin === 'start' ? 'Стартовый набор'
    : item.origin === 'craft' ? 'Скована кузнецом'
    : '';
  const up = !item.tierForged ? ''
    : item.bornTier ? `ступень поднята кузнецом (была «${tierName(item.bornTier) ?? item.bornTier}»)` : 'ступень поднята кузнецом';
  const text = [head, up].filter(Boolean).join(' · ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : null;
}

/** Сорт сырья римской цифрой: 1 → I … 5 → V (подписи склада «I сорт», карточки «не выше III сорта»). */
export function gradeRoman(n: number): string {
  return ['', 'I', 'II', 'III', 'IV', 'V'][Math.max(0, Math.min(5, Math.floor(n)))] ?? String(n);
}
