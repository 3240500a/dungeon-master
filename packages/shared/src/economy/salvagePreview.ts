import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/items.js';
import {
  countsAsFind, craftTiers, emptyJournal, partById, salvageIntoJournal, sketchable, typeOfItem, type CraftJournal,
} from '../formulas/craft.js';
import type { SalvageRng } from '../formulas/salvage.js';
import { salvageYield } from './townActions.js';

/** Бросок «путь, без выхода»: путь разбора от кубика не зависит, выход здесь не нужен. */
const NO_ROLL: SalvageRng = { int: (a) => a, chance: () => false };

/**
 * ⭐ ЧТО ЗАСЧИТАЛ БЫ ЖУРНАЛУ РАЗБОР У КУЗНЕЦА — строками; пусто — нового нет (docs/CRAFT_WEAPONS.md §12.2–12.4).
 *
 * Сама проверка — ТА ЖЕ функция, которой кузнец пополняет журнал (`salvageIntoJournal`), над копией журнала: своих правил здесь нет.
 * ⚠ R2-07: ВСЁ, что она возвращает, а не только тип и детали: кодекс, потолок ступени (первая вещь новой ступени — частый случай в
 * начале), мифик к воротам t6, эскиз. Две оговорки — чтобы не звать зря: мифик — только пока ворота закрыты (сверх `mythicSalvages`
 * счёт ничего не даёт); эскиз — только когда разбор ДОВОДИТ счёт жалости до него и эскиз есть на что потратить.
 * Журнала нет (кадр сундука не пришёл) — как пустой: лишнее обещание дешевле ловушки.
 * Вопросы перед разбором в поле и продажей (`journalGainsOf` клиента) и карточка разбора у кузнеца (`salvageJournalPreview`) — отсюда.
 */
export function salvageJournalGains(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined): string[] {
  // Скованное журнал знает (его сковали из открытого), уникальное кузнец не разбирает вовсе.
  if (item.parts || item.kind !== 'weapon' || item.rarity === 'unique') return [];
  // Журнал пополняет только разбор ПО ДЕТАЛЯМ — ровно то условие, по которому его зовёт `forgeSalvage`.
  if (salvageYield(reg, item, NO_ROLL, false).source !== 'parts') return [];
  const j = journal ?? emptyJournal();
  const u = salvageIntoJournal(reg, j, item);
  const base = u.newBase ? reg.get('items.base').find((b) => b.id === item.baseId) : undefined;
  const tiers = craftTiers(reg);
  const tier = u.tierUp ? tiers[u.journal.tierHi] : undefined;
  const need = reg.get('balance').craft.journal.mythicSalvages;
  const sketch = u.sketch && reg.get('weapon-parts').some((p) => p.enabled !== false && sketchable(reg, u.journal, p.id));
  return [
    ...(base ? [`тип «${base.name}»`] : []),
    ...u.unlocked.map((id) => `деталь «${partById(reg, id)?.name ?? id}»`),
    ...(u.newType ? [`кодекс «${typeOfItem(reg, item)?.name ?? u.newType}»`] : []),
    ...(tier ? [`ступень «${tier.name}» — потолок ковки`] : []),
    ...(u.mythic && j.mythic < need ? [`мифик к воротам ${tiers.at(-1)?.id ?? 't6'} (${j.mythic + 1} из ${need})`] : []),
    ...(sketch ? ['эскиз — деталь на выбор'] : []),
  ];
}

/**
 * Что карточка разбора у кузнеца говорит о журнале:
 * - `found` — найденное оружие откроет новое (строка «Откроет: …»);
 * - `known` — найденное, но из него всё уже открыто;
 * - `typeOnly` — детали не откроются: вещь не найдена (куплена, награда, без происхождения) — откроет разве что тип и ступень;
 * - `melt` — скованное: кузнец переплавляет, журнал не учит;
 * - `rules` — оружие без деталей кузнеца (база вне ковки): разбор по редкости, журнал не учит;
 * - `none` — молчать: не оружие, уникальное, стартовое, разобрать нельзя (причину говорит сама карточка).
 */
export type SalvagePreviewKind = 'found' | 'known' | 'typeOnly' | 'melt' | 'rules' | 'none';

export interface SalvageJournalPreview {
  kind: SalvagePreviewKind;
  /** Что откроет (`salvageJournalGains`): у `found` — всё, у `typeOnly` — разве что тип и ступень. */
  gains: string[];
  /** Почему детали не откроются (`typeOnly`): «вещь куплена», «вещь без происхождения (из старого сейва)»… */
  why?: string;
  /** Строка карточки; пусто — молчать. */
  line: string;
  /** Тон строки: `gain` — откроет новое, `warn` — детали не откроются, `dim` — пояснение. */
  tone: 'gain' | 'warn' | 'dim';
}

/** Происхождение не-находки — словами для игрока. Чего нет в списке (поле из будущего) — «вещь не найдена». */
function notFoundWhy(origin: string): string {
  switch (origin) {
    case 'shop': return 'вещь куплена';
    case 'quest': return 'вещь — награда за задание';
    case 'start': return 'вещь из стартового набора';
    case 'craft': return 'вещь скована';
    default: return 'вещь не найдена';
  }
}
const NO_ORIGIN_WHY = 'вещь без происхождения (из старого сейва)';
/** Откуда вещи, чьи детали открываются (`FIND_ORIGINS`), — словами. */
const FOUND_WHERE = 'а детали открывает только найденное (с монстра, из сундука, с босса)';

/**
 * ⭐ РАЗБЕРЁШЬ — ЧТО ОТКРОЕТСЯ: строка карточки «♻ Разобрать» у кузнеца, ДО разбора (§12.2–12.4).
 *
 * Правило журнала (`salvageIntoJournal`): детали, кодекс, жалость-эскиз и ворота t6 учит только НАЙДЕННОЕ (`countsAsFind`: дроп, сундук,
 * босс). Купленное, выданное и вещь без происхождения (сейв старше поля) открывают только тип и потолок ступени, скованное — только
 * переплавляется. Без строки правило невидимо: игрок разбирает купленный топор, ждёт его детали во вкладке «Ковка» и не находит их.
 * Всё — из тех же функций, что разбор (`salvageYield` — путь, `salvageJournalGains` — что откроет): своих правил здесь нет.
 */
export function salvageJournalPreview(reg: ConfigRegistry, item: Item, journal: CraftJournal | null | undefined): SalvageJournalPreview {
  const quiet: SalvageJournalPreview = { kind: 'none', gains: [], line: '', tone: 'dim' };
  if (item.kind !== 'weapon') return quiet;
  const path = salvageYield(reg, item, NO_ROLL, false);
  if (!path.ok) return quiet;
  if (path.source === 'melt') return { kind: 'melt', gains: [], line: 'Журнал не пополнится: скованную вещь кузнец переплавляет', tone: 'dim' };
  if (path.source !== 'parts') return { kind: 'rules', gains: [], line: 'Журнал не пополнится: у этой вещи нет деталей кузнеца', tone: 'dim' };
  const gains = salvageJournalGains(reg, item, journal);
  if (countsAsFind(item)) {
    return gains.length
      ? { kind: 'found', gains, line: `Откроет: ${gains.join(', ')}`, tone: 'gain' }
      : { kind: 'known', gains, line: 'Журнал: всё из этой вещи уже открыто', tone: 'dim' };
  }
  const why = item.origin ? notFoundWhy(item.origin) : NO_ORIGIN_WHY;
  return {
    kind: 'typeOnly', gains, why,
    line: `Детали не откроются: ${why}, ${FOUND_WHERE}.${gains.length ? ` Откроется только ${gains.join(', ')}.` : ''}`,
    tone: 'warn',
  };
}
