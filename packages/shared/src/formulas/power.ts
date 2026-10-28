import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { ATTRIBUTES, type Attributes } from '../types/attributes.js';
import { unmetWorn } from './stats.js';
import { tierMatters } from './itemgen.js';

/** Одна запись сложности (из конфига difficulties). */
export type Difficulty = ConfigShapes['difficulties'][number];
/** Веса метрики мощи (balance.power). */
export type PowerConfig = ConfigShapes['balance']['power'];

/** Разбор эффективного уровня персонажа: уровень + гир + пассивы. */
export interface PowerBreakdown {
  level: number;
  gearBonus: number;
  passiveBonus: number;
  /** Итоговый эффективный уровень (EL). */
  total: number;
}

/** Ступени вещей (`item-tiers`): мощи нужен только порог уровня ступени. */
export type PowerTiers = readonly { id: string; minItemLevel: number }[];

/**
 * ⭐ R12-09: УРОВЕНЬ ВЕЩИ ДЛЯ МОЩИ — уровень находки, но не ниже порога её ступени. Подъём у кузнеца (главный путь к высоким
 * ступеням до 80-го уровня) меняет ступень и статы, а `itemLevel` оставляет уровнем находки — и мощь мерила вещь по нему:
 * редкая, найденная на 5-м уровне и поднятая до t4 (порог 45), весила у героя 60-го уровня 5/60, комплект таких давал +1 EL
 * вместо +8, и узлы заселялись на ~7 уровней слабее, чем у героя с теми же статами из находок (⚠ то «заселялись» — ИСТОРИЯ 13.10/Г1: сегодня мощь решает запись узла и ворота прогресса, см. `effectiveLevel`). Скованная вещь рождается с
 * уровнем порога своей ступени (`buildCraftShell`) — поднятая меряется так же. `itemLevel` на подъёме НЕ поднимается: он
 * решает пул перекатки аффиксов и цену скупки. Вещь, которую ступень не меняет (кольцо, амулет — `tierMatters`), — по уровню
 * находки: её сила — аффиксы, а они от ступени не зависят.
 */
function gearLevel(item: Item, tiers: PowerTiers | undefined): number {
  const t = tiers && item.tier && tierMatters(item) ? tiers.find((x) => x.id === item.tier) : undefined;
  return t ? Math.max(item.itemLevel, t.minItemLevel) : item.itemLevel;
}

/** Вклад вещи в мощь: вес редкости × «в уровень» (перерос уровень не даёт сверх 1). */
function gearScore(item: Item, level: number, cfg: PowerConfig, tiers: PowerTiers | undefined): number {
  const weight = cfg.gearRarityWeight[item.rarity] ?? 1;
  return weight * Math.min(1, gearLevel(item, tiers) / level);
}

/**
 * ⭐ R8-10: АТРИБУТЫ, ДО КОТОРЫХ ГЕРОЙ ДОТЯНЕТСЯ ГДЕ УГОДНО: вложенные (не ниже атрибутов до сброса, `respecPeak`) плюс все
 * нераспределённые очки в КАЖДЫЙ атрибут — `allocAttr` и `respec` работают и в подземелье. Верхняя граница: занижать мощь
 * ею нельзя (очками, сбросом), завысить — только тому, кто держит очки нераспределёнными или сбрасывал.
 */
function reachableAttributes(save: SaveState): Attributes {
  const free = Math.max(0, save.unspentAttributePoints || 0);
  const out = {} as Attributes;
  for (const a of ATTRIBUTES) out[a] = Math.max(save.attributes?.[a] || 0, save.respecPeak?.[a] || 0) + free;
  return out;
}

/**
 * ⚠⚠ 13.10 (Г1): все «почему» ниже мотивированы ПРЕЖНИМ правилом «узел заселится слабее» — это ИСТОРИЯ правок
 * R7-02/R8-10/R11-02. Уровень монстра решает одна глубина; занижение мощи даёт дешёвую запись узла (и лишнюю глубину
 * в прогрессе сложности), поэтому честность замера нужна по-прежнему — подробнее у `effectiveLevel`.
 * ⭐ R7-02: гир, который герой МОЖЕТ надеть: в каждый слот — лучшая по вкладу вещь из надетого и `spare` (сумка, пояс;
 * на сервере — и то, что несут герои его аккаунта рядом). Двуручник запирает вторую руку: руки — лучшее из «двуручник»
 * и «оружие + вторая рука». Сломанное из запаса не в счёт — его не надеть, пока не починят. Надетое считается по слоту,
 * в котором надето: без запаса итог ровно сумма надетого.
 *
 * ⚠ R8-10: и вещь запаса, чьи требования герою НЕ ЗАКРЫТЬ, не в счёт — раньше честный герой, несущий находки этажа в город,
 * заселял узлы сильнее (до +3 EL), хотя `equip` их отвергал. Правило то же, что держит надетое (`unmetWorn`, R4-08): вещь
 * встаёт, если её требования закрыты атрибутами и прибавками вещей, вставших раньше, — значит кольцо +Сила из сумки опирает
 * меч из сумки. Атрибуты — `reachableAttributes`. Одна и та же вещь (сервер кладёт в запас и надетое) опирает один раз.
 * Опору дают и две вещи одного слота разом (надетое кольцо и кольцо в сумке) — это может лишь ЗАВЫСИТЬ мощь (замер: +1 у
 * 8 героев из 1200), занизить её снятием и перекладкой нельзя: всё, что надевается по одной в каком-то порядке, встаёт.
 *
 * ⭐ R11-02: одноручное оружие встаёт и во ВТОРУЮ руку (дуал-вилд): руки — лучшее из «двуручник», «оружие + щит» и «два
 * одноручника». Раньше оружие шло только в основную руку, и второй одноручник из сумки мощь не поднимал — «в городе меч в
 * руке, кинжал в сумке — надел в подземелье» заселяло узел слабее. Полуторный одной рукой — только со щитом (§25).
 */
function wearableGear(save: SaveState, spare: Iterable<Item | null | undefined>, level: number, cfg: PowerConfig, tiers: PowerTiers | undefined): number {
  const best = new Map<string, number>();
  let twoHanded = 0;
  const oneHanded: number[] = [];   // одноручное оружие: основная рука ИЛИ вторая
  const offer = (slot: string, item: Item): void => {
    const s = gearScore(item, level, cfg, tiers);
    if (slot === 'weapon' && (item.hands ?? 1) >= 2 && !item.versatile) { twoHanded = Math.max(twoHanded, s); return; }
    // Оружие, надетое во вторую руку, — всё равно оружие: в пару к основной, а не «щит».
    if (item.slot === 'weapon' && (item.hands ?? 1) < 2) { oneHanded.push(s); return; }
    if (s > (best.get(slot) ?? 0)) best.set(slot, s);
  };
  const worn = new Set<Item>();
  for (const [slot, item] of Object.entries(save.equipment)) if (item) { worn.add(item); offer(slot, item); }
  const extra = new Set<Item>();
  for (const item of spare) if (item?.slot && !item.broken && !worn.has(item)) extra.add(item);
  if (extra.size) {
    const unmet = new Set(unmetWorn(reachableAttributes(save), [...worn, ...extra]));
    for (const item of extra) if (!unmet.has(item)) offer(item.slot!, item);
  }
  const [first = 0, second = 0] = oneHanded.sort((a, b) => b - a);
  const main = Math.max(best.get('weapon') ?? 0, first);   // `weapon` здесь — только полуторное
  let raw = Math.max(twoHanded, main + (best.get('offhand') ?? 0), first + second);
  for (const [slot, s] of best) if (slot !== 'weapon' && slot !== 'offhand') raw += s;
  return raw;
}

/**
 * «Мощь персонажа» как эффективный уровень (EL) = уровень + бонус за надетый гир
 * (по itemLevel и редкости, с поправкой на актуальность уровню) + бонус за
 * вложенные пассивки. Оба бонуса ограничены каппами из конфига. Чистая функция:
 * используется и клиентом (выбор сложности/лист персонажа), и сервером (анти-чит).
 *
 * ⚠⚠ 13.10 (Г1): МОЩЬ БОЛЬШЕ НЕ РЕШАЕТ УРОВЕНЬ МОНСТРА — его решает одна глубина (`floorMonsterLevel`). Мощь осталась
 * мерой героя для листа персонажа и для записи мощи ВХОДА в узел
 * (`RunNodeState.el`), поэтому её честность по-прежнему важна. Но все «почему» ниже (и у `wearableGear`, `gearLevel`,
 * `carriedGear`) мотивированы прежним правилом «узел заселится слабее» — это ИСТОРИЯ правок R7-02/R8-10/R12-09, а не
 * действующее следствие: сегодня занижение мощи даёт не слабых монстров, а лишнюю глубину в прогрессе сложности.
 *
 * ⭐ R7-02: `spare` — вещи, которые герой может надеть в любой момент (сумка, пояс, снаряжение героев его аккаунта рядом):
 * гир считается по лучшему из надетого и запаса (`wearableGear`). Так сервер меряет мощь на входе в узел: раньше считалось
 * только надетое, и «снял всё в городе — спустился — надел в подземелье» занижало мощь узла на `gearMax` уровней.
 *
 * ⭐ R12-09: `tiers` — ступени (`item-tiers`): вещь меряется не ниже порога своей ступени (`gearLevel`), и поднятая у кузнеца
 * весит как скованная той же ступени. Сервер, клиент и сим передают их все; без них — по уровню находки, как раньше.
 */
export function effectiveLevel(
  save: SaveState, cfg: PowerConfig, spare?: Iterable<Item | null | undefined>, tiers?: PowerTiers,
): PowerBreakdown {
  const level = Math.max(1, save.level);

  let gearRaw = 0;
  if (spare) gearRaw = wearableGear(save, spare, level, cfg, tiers);
  else for (const item of Object.values(save.equipment)) if (item) gearRaw += gearScore(item, level, cfg, tiers);
  const gearBonus = Math.min(cfg.gearMax, Math.round(gearRaw / cfg.gearDivisor));

  let ranks = 0;
  for (const r of Object.values(save.masteries)) ranks += r;
  const passiveBonus = Math.min(cfg.passiveMax, Math.round(ranks / cfg.passiveDivisor));

  return { level, gearBonus, passiveBonus, total: level + gearBonus + passiveBonus };
}

/**
 * ⭐ R8-10: ЗАПАС ГЕРОЯ ДЛЯ МОЩИ — сумка и пояс. С ним клиент (алтарь, лист персонажа) показывает ту же мощь, по которой
 * сервер пишет в запись узла соло-героя; сервер к нему добавляет снаряжение героев того же аккаунта рядом (`gearPool`).
 */
export function carriedGear(save: SaveState): Item[] {
  return [...save.inventory, ...(save.belt ?? []).filter((i): i is Item => !!i)];
}

/**
 * ⭐⭐ 13.10 (Г1): УРОВЕНЬ МОНСТРА НА ЭТАЖЕ — ТОЛЬКО ОТ ГЛУБИНЫ (решение владельца). Число, которое возвращает эта
 * функция, — именно УРОВЕНЬ МОНСТРА, а не абстрактный «вызов»: по нему заселяется этаж, и за ним едут опыт
 * (`xpBase × уровень`), золото, уровень вещей с тел и из сундуков и ступень сырья.
 *
 * ⚠ ПОЧЕМУ МОЩЬ ГЕРОЯ (`el`) СЮДА БОЛЬШЕ НЕ ВХОДИТ. Раньше старт считался от неё (`startChallenge`), и герой сам
 * поднимал себе монстров: на 1-м этаже прокачанный встречал 81-й уровень, а свежий — 2-й, то есть глубина не значила
 * почти ничего, а поднятая с пола находка переводила весь следующий этаж через порог. Глубина — ЕДИНСТВЕННЫЙ источник
 * сложности; мощь осталась мерой героя (`effectiveLevel`) для анти-чита сервера и записи `RunNodeState.el`, но рычагом
 * уровня монстра она быть перестала.
 *
 * Потолков нет: вся кривая — `startLevel` (уровень монстров на 1-м этаже) и `floorStep` (+ уровней за этаж глубже).
 * При `normal` (1 и 1) этаж N даёт монстров N уровня, и на 200-м этаже это 200, а не кап.
 *
 * ⭐⭐ 13.10 (Г2, Р6): ПОТОЛКА НЕТ НИ У ФОРМУЛЫ, НИ У МИРА. Прежде достижимая глубина равнялась «длина шаблона + финал»
 * (15), и «этаж 200» в сторожах был проверкой формулы, в забеге не воспроизводимой. Длины и финала у забега больше нет,
 * слой адресуется своей глубиной (`generateRunPlan` — окно слоёв), поэтому этаж 200 — это ровно монстры 200-го уровня, и
 * кривую под бесконечный спуск менять не пришлось. ⚠ Награда за такую глубину ждёт перекалибровки (docs/BALANCE.md).
 */
export function floorMonsterLevel(diff: Difficulty, depth: number): number {
  return Math.max(1, Math.round(diff.startLevel + (Math.max(1, depth) - 1) * diff.floorStep));
}

// ── Метки спуска (вейпоинты): арифметика по рекорду ──────────────────────────
/**
 * ⭐⭐ 14.10 (Г3, В1): МЕТКА — АРИФМЕТИКА ПО РЕКОРДУ, НОВОГО ПОЛЯ В СЕЙВЕ НЕТ. Открытая метка — глубина `d`, кратная
 * каденции привала (`balance.dungeonAccess.waypointStep`) и не глубже рекорда тира (`save.difficultyProgress[tier]` —
 * его пишет один шов, `Room.enterNode`). Своего списка открытых меток сейв не держит НАМЕРЕННО: спуск бесконечен, и
 * список рос бы на запись за этаж — навсегда и в каждой записи сейва в Postgres (та же причина, по которой окно
 * `visited` режется, см. `noteVisited`). Рекорд — одно число, метки из него считаются.
 *
 * ⚠ ОДИН ШОВ НА ТРИ ЧИТАТЕЛЯ: сервер (анти-чит `descend`), алтарь клиента (список выбора) и порт Unity. Своя
 * арифметика у клиента показала бы метку, которой сервер не даст, — а это худший вид расхождения: игрок видит
 * обещание и получает отказ (или, хуже, молчаливый старт не там, где выбрал).
 */
/** Вход в спуск: 1-й этаж открыт ВСЕГДА, даже без рекорда (иначе свежему герою некуда войти). */
export const WAYPOINT_ENTRY_DEPTH = 1;
/**
 * ⚠ Сколько меток отдаёт `openWaypoints` без явного `limit`. Прицел владельца — 200–300 этажей: при шаге 3 это 100
 * меток, при шаге 1 — 300, то есть умолчание с запасом. Предохранитель нужен потому, что ПОТОЛКА ГЛУБИНЫ НЕТ:
 * рекорд `1e9` в порченом сейве дал бы список в треть миллиарда чисел — и список, и его JSON положили бы процесс.
 */
export const OPEN_WAYPOINTS_LIMIT = 512;
/**
 * ⭐⭐ 14.10 (Г3, правка 7): ПРЕДОХРАНИТЕЛЬ ГЛУБИНЫ — ОДНО ПРАВИЛО НА ВСЕ ЧИТАТЕЛИ РЕКОРДА. Прицел владельца —
 * 200–300 этажей, потолка прогресса в игре нет и не будет; это не правило игры, а предел ДОВЕРИЯ К ЧИСЛУ ИЗ СЕЙВА:
 * 10 000 — тридцать три прицела, в честной игре не достижимо, значит связать игрока не может.
 *
 * ⚠ ПОЧЕМУ ПОТОЛОК НУЖЕН ОБОИМ, А НЕ ТОЛЬКО СПИСКУ. У `openWaypoints` предохранитель был (`OPEN_WAYPOINTS_LIMIT` —
 * срезка ДЛИНЫ), а у `waypointStart` никакого: замер 14.10 — «рекорд 1000000000 → старт 999999999, область dungeon»,
 * то есть порченое число из сейва прямо уезжало в глубину узла (имя `n999999999_0`, генерация этажа, уровень монстров
 * 10⁹). Срезка длины от этого не спасала: она режет СКОЛЬКО меток показать, а не КАК ГЛУБОКО верить. Поэтому потолок
 * стоит в одном шве — `depthRecordOf`, единственном чтении рекорда, — и обе функции получили его разом: список
 * кончается на `WAYPOINT_DEPTH_LIMIT`, старт не глубже него. Срезка длины осталась второй мерой (при шаге 1 меток до
 * потолка было бы 10 000).
 */
export const WAYPOINT_DEPTH_LIMIT = 10_000;

/**
 * ⭐⭐ Г8 (15.10, решение владельца): МЕСТО ЭТАЖА В ПОЛОСЕ КОНТЕНТА — цикл длиной `cycle` (20 этажей).
 *
 * ЗАЧЕМ. Спуск бесконечен (Г2), а контента настроено на пару десятков этажей: за краем настройки подбор этажа и
 * мешанина монстров ЗАСТЫВАЛИ — на 500-м этаже игрок видел ровно то же, что на 23-м, и до конца времён. Владелец
 * выбрал полный цикл на 20 этажей: «весь контент посмотрел, с боссом и монстрами в сильных доспехах, и дальше
 * заново — опять слабые, и к 20-му снова сильные и босс».
 *
 * ⚠⚠ ЦИКЛИТСЯ ТОЛЬКО ВЫБОР КОНТЕНТА — НЕ СИЛА. Уровень монстра по-прежнему считает АБСОЛЮТНАЯ глубина
 * (`floorMonsterLevel`, Г1): на 21-м этаже та же сцена, что на 1-м, но монстры 21-го уровня. Иначе спуск потерял бы
 * смысл: за 20-м этажом игра стала бы вечным первым кругом.
 *
 * ⚠ `cycle ≤ 1` — ЦИКЛА НЕТ (глубина как есть): так выключается правило одним числом в конфиге, и так ведут себя
 * старые сохранённые оверрайды до правки.
 */
export function bandDepth(depth: number, cycle: number): number {
  const d = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : 1;
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  if (c <= 1) return d;
  return ((d - 1) % c) + 1;
}

/**
 * ⭐⭐ Г8-3 (15.10, схема владельца): МЕСТА ПОРТАЛОВ — ЭТО ДАННЫЕ, А НЕ ШАГ.
 *
 * Владелец довёл круг до ровного: «на 19-м уровне босс, 20-й портал, и 21-й по новой всё». Тогда места порталов в
 * полосе — 3, 6, 9, 12, 15, 18 И 20, то есть уже НЕ «каждое кратное трём»: после актового босса стоит свой портал,
 * чтобы круг закрывался (замер разрывов: 3, 3, 3, 3, 3, 3, 2, 3 … — максимум 3 этажа без портала против 5 в прежней
 * схеме, где на шве круга образовывалась дыра 18 → 23).
 *
 * ⚠ ПОЭТОМУ ПРАВИЛО МЕТКИ ПРИНИМАЕТ ДВА ВИДА ЗАПИСИ, и это не «две правды», а одна с короткой формой:
 *  • СПИСОК МЕСТ (`number[]`, штатный вид, `balance.dungeonAccess.portalsAt`) — ровно эти места полосы, как в схеме;
 *  • ЧИСЛО (`number`) — короткая форма «каждое место, кратное N». Она нужна старым настройкам и прежним таблицам
 *    сторожей (их числа — про правило до Г8-2 и остаются живой поддерживаемой настройкой при `cycle = 0`), и ею же
 *    удобно задавать ровную каденцию без перечисления.
 * Обе формы проходят через `portalPlaces`, то есть внутри правило ОДНО.
 */
export type WaypointPlaces = number | readonly number[];

/**
 * Места порталов в полосе — приведённые: целые 1…cycle, по возрастанию, без повторов. Число — короткая форма
 * «каждое кратное N» (при `cycle ≤ 1` — просто шаг, то есть прежнее правило «каждый N-й этаж»). Мусор → шаг 1.
 */
export function portalPlaces(places: WaypointPlaces, cycle: number): readonly number[] {
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  if (typeof places === 'number' || !Array.isArray(places)) {
    const s = waypointStepOf(typeof places === 'number' ? places : Number.NaN);
    if (c <= 1) return [s];                                  // прежнее правило: кратность шагу без полосы
    const out: number[] = [];
    for (let p = s; p <= c; p += s) out.push(p);
    return out.length ? out : [1];
  }
  const span = c > 1 ? c : Number.POSITIVE_INFINITY;
  const out = [...new Set(places.map((x) => Math.floor(Number(x))).filter((x) => Number.isFinite(x) && x >= 1 && x <= span))];
  out.sort((a, b) => a - b);
  return out.length ? out : [1];
}

/**
 * Шаг каденции — целое ≥ 1 (то же держит схема; здесь вторая линия: мусор → 1). Остался для КОРОТКОЙ ФОРМЫ записи
 * мест (число вместо списка) и для прежних настроек.
 */
export function waypointStepOf(step: number): number {
  return Number.isFinite(step) ? Math.max(1, Math.floor(step)) : 1;
}
/**
 * Рекорд глубины тира: целое от 0 до `WAYPOINT_DEPTH_LIMIT`. Нет записи (или не число) — 0, то есть «метки ещё не
 * открыты», кроме входа. Потолок — предохранитель от порченого сейва (см. `WAYPOINT_DEPTH_LIMIT`), и он ОДИН на
 * список меток и на старт забега: разойтись им нельзя, иначе алтарь показал бы метку, которой сервер не даст.
 */
/**
 * ⭐ 14.10 (Г3): ЕДИНСТВЕННЫЙ ШОВ ЧТЕНИЯ РЕКОРДА ГЛУБИНЫ — и его ЖЕ зовёт ЗАПИСЬ прогресса на сервере
 * (`Room.enterNode`). Без этого запись брала рекорд СЫРЫМ, и нечисловая строка из базы СНИМАЛА потолок прибавки:
 * замер — `was = '60'`, шаг 3 давали `'60' + 3 = '603'` (склейка строк), и `Math.min(500, '603')` пропускал всю глубину
 * за один вход. Зажим по `WAYPOINT_DEPTH_LIMIT` здесь же лечит и порченый рекорд 1e9: следующая запись
 * сводит его к доверенному потолку, а не хранит вечно (сейв из Postgres схему не проходит — см. `validation/save.ts`).
 */
export function depthRecordOf(progress: Record<string, number> | undefined | null, tierId: string): number {
  const d = progress?.[tierId];
  if (typeof d !== 'number' || !Number.isFinite(d)) return 0;
  return Math.min(WAYPOINT_DEPTH_LIMIT, Math.max(0, Math.floor(d)));
}

/**
 * ⭐⭐ Г8-2/Г8-3: МЕТКА — ЭТО МЕСТО В ПОЛОСЕ ИЗ СПИСКА МЕСТ. Схема владельца (15.10): места 3, 6, 9, 12, 15, 18, 20
 * из 20, боссы на 5, 14 и 19 — то есть портал стоит СРАЗУ ПОСЛЕ актового босса, и круг закрывается ровно.
 *
 * ⚠ `cycle` и `places` — ОБЯЗАТЕЛЬНЫЕ аргументы, а не поля с умолчанием. На этих функциях стоят три разные вещи
 * (список меток алтаря, стартовая глубина анти-чита и строка HUD «до метки N»), и забытый аргумент означал бы ДВА
 * РАЗНЫХ правила метки в одной игре — худший вид расхождения. Типом это невозможно: не передал — не собралось.
 * `cycle ≤ 1` — цикла нет, и тогда число в `places` значит прежнее «каждый N-й этаж».
 */
export function isWaypoint(depth: number, places: WaypointPlaces, cycle: number): boolean {
  if (!Number.isFinite(depth)) return false;
  const d = Math.floor(depth);
  if (d < 1) return false;
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  const list = portalPlaces(places, c);
  if (c <= 1) return d % Math.max(1, list[0]!) === 0;        // прежнее правило: кратность шагу
  return list.includes(bandDepth(d, c));
}

/**
 * ⭐ Г3 (В6) + Г8-2: СКОЛЬКО ЭТАЖЕЙ ОТ `depth` ДО СЛЕДУЮЩЕЙ МЕТКИ — 0, если стоим НА метке. Та же каденция, что у
 * `isWaypoint` и генератора, поэтому строка HUD «до метки N этажей» не может разойтись с тем, где привал встанет на
 * самом деле. Один шов на оба веб-клиента (`UIScene`, `hud3d`) и порт Unity.
 *
 * ⚠ С полосой ответ уже НЕ «остаток до кратного»: места стоят неровно (…18, 20, 23…), поэтому идём вперёд перебором,
 * не дальше круга плюс один шаг — метка в круге есть всегда.
 *
 * ⚠ Глубина вне спуска (город — 0, мусор) считается нулевой: ответ — до первой метки впереди.
 */
export function waypointGap(depth: number, places: WaypointPlaces, cycle: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  const list = portalPlaces(places, c);
  const span = (c > 1 ? c : Math.max(...list)) + Math.max(...list) + 1;
  for (let k = 0; k <= span; k++) if (isWaypoint(d + k, places, cycle)) return k;
  return Math.max(...list);
}

export interface OpenWaypointsOptions {
  /** Сколько меток вернуть максимум (умолчание `OPEN_WAYPOINTS_LIMIT`): оставляются САМЫЕ ГЛУБОКИЕ + вход. */
  limit?: number;
}

/**
 * Открытые метки тира `tierId` по рекорду `progress` — глубины по возрастанию, без повторов. ⚠ Ф3 (16.10): вход
 * (`WAYPOINT_ENTRY_DEPTH`) СЮДА НЕ ВХОДИТ — он не метка, а отдельная кнопка портала «начать сначала»; у свежего
 * героя список пуст. Срезка по `limit` оставляет самые глубокие: шаг назад игрок делает редко, а глубокие он
 * заработал ногами.
 *
 * ⚠ Г8-2: идём ВНИЗ от рекорда и проверяем каждое место полосы (`isWaypoint`) — так список верен и для списка мест, и
 * для прежней короткой формы. Обход дёшев: он кончается либо на `limit` (512), либо на первом этаже.
 */
export function openWaypoints(
  progress: Record<string, number> | undefined | null,
  tierId: string,
  places: WaypointPlaces,
  cycle: number,
  opts?: OpenWaypointsOptions,
): number[] {
  const limit = Math.max(1, Math.floor(opts?.limit ?? OPEN_WAYPOINTS_LIMIT) || 1);
  const record = depthRecordOf(progress, tierId);
  const out: number[] = [];
  for (let d = record; d >= 1 && out.length < limit; d--) if (isWaypoint(d, places, cycle)) out.push(d);
  // ⭐⭐ Ф3 (16.10): ВХОД БОЛЬШЕ НЕ МЕТКА. Решение владельца: «рест-этажи все стоят на своих местах, ничего не
  // подменяем». Раньше список всегда дописывал этаж 1, и свежий герой видел «метку», которой на круге нет —
  // место 1 порталом не бывает. Теперь список — ЧИСТЫЕ метки рекорда (у свежего героя он пуст), а «начать
  // сначала» живёт отдельной кнопкой портала города и упирается в тот же зажим сервера (`waypointStart`
  // возвращает `WAYPOINT_ENTRY_DEPTH`, когда ни одна метка не подошла).
  return out.sort((a, b) => a - b);
}

/**
 * ⭐⭐ Г8-3: СЛЕДУЮЩАЯ МЕТКА СТРОГО ГЛУБЖЕ `from` — шаг «ногами» для прогресса сложности (`Room.enterNode`).
 *
 * ⚠ ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ЧИСЛО `waypointStep`. Прибавка рекорда за один вход была «не больше шага
 * каденции», но места порталов стоят НЕРОВНО (…18, 20, 23…), и фиксированное число давало бы то половину шага, то
 * полтора. Правило одно и то же словами — «за вход открывается не больше ОДНОЙ метки», — и теперь оно так и считается.
 */
/**
 * ⭐⭐ Ф5-2 (17.10): РАНГ БОССА НА ГЛУБИНЕ — ЧИСТАЯ ФУНКЦИЯ, ОДНА НА ВСЕХ.
 *
 * Была замыканием внутри `generateRunPlan`, и второму спрашивающему (гарантия печати с босса) пришлось бы
 * считать то же самое вторым кодом — и две правды расходятся на первой же правке лестницы.
 *
 * ⚠ НА МЕТКЕ БОССА НЕТ (правило ГФ8-2): при совпадении уступает босс, а не метка — метку потерять
 * нельзя, на ней стоят старт спуска и счёт игрока «до метки N этажей».
 */
export function bossRankAt(depth: number, places: WaypointPlaces, cycle: number, ladder: readonly { at: number; rank: string }[]): string | undefined {
  if (!Number.isFinite(depth) || Math.floor(depth) < 1) return undefined;
  if (isWaypoint(depth, places, cycle)) return undefined;
  const at = bandDepth(depth, cycle);
  return ladder.find((x) => x.at === at)?.rank;
}

export function nextWaypointAfter(from: number, places: WaypointPlaces, cycle: number): number {
  const d = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  const list = portalPlaces(places, c);
  const span = (c > 1 ? c : Math.max(...list)) + Math.max(...list) + 1;
  for (let k = 1; k <= span; k++) if (isWaypoint(d + k, places, cycle)) return d + k;
  return d + Math.max(...list);
}

/**
 * ⭐⭐ 14.10 (Г3, В2/В3): С КАКОЙ ГЛУБИНЫ НАЧНЁТСЯ СПУСК. `records` — прогресс КАЖДОГО героя пати (по сейвам),
 * `want` — глубина из кадра `descend`. Результат: самая глубокая метка, открытая у ВСЕХ, но не глубже запрошенной;
 * ничего не подошло — `WAYPOINT_ENTRY_DEPTH`.
 *
 * ⚠ ПОЧЕМУ ЭТО НЕ «ПРОВЕРКА КАДРА», А ЗАЖИМ. Проверка отвечала бы «да/нет» на присланное число — и каждый отказ был
 * бы подсказкой, где граница, а каждая забытая форма мусора (`NaN`, `1.5`, `-5`, `1e9`, строка) — дыркой. Здесь
 * разрешение считает СЕРВЕР по сейвам, а кадр только ОГРАНИЧИВАЕТ сверху: подложить глубину нельзя в принципе, потому
 * что число из кадра нигде не становится стартом само — оно лишь одна из двух границ `min`. Негодное число — это
 * «границы нет», то есть вход (1), а не глубина читера.
 *
 * ⚠ КООП (решение владельца): граница — САМЫЙ СЛАБЫЙ рекорд пати. Отставшему метки открываются НОГАМИ: его
 * `difficultyProgress` растёт на каждом новом входе (`Room.enterNode`) — и не больше чем на ОДНУ метку за вход
 * (правка 7 + Г8-3), поэтому следующий раз пати стартует глубже, но протащенный далеко владеет метками не сразу.
 *
 * ⚠ 14.10 (правка 7): ПОТОЛОК ДОВЕРИЯ К РЕКОРДУ — `WAYPOINT_DEPTH_LIMIT`, тот же, что у `openWaypoints` (он стоит в
 * `depthRecordOf`, одном шве чтения рекорда). Без него порченый сейв с `1e9` давал старт 999999999 — не «глубину
 * читера», а узел, которого не бывает, с генерацией этажа на нём.
 */
export function waypointStart(
  records: Iterable<Record<string, number> | undefined | null>,
  tierId: string,
  places: WaypointPlaces,
  cycle: number,
  want?: number,
): number {
  let weakest = Number.POSITIVE_INFINITY;
  for (const p of records) weakest = Math.min(weakest, depthRecordOf(p, tierId));
  const record = Number.isFinite(weakest) ? weakest : 0;   // пустая пати — как без рекорда
  const asked = typeof want === 'number' && Number.isFinite(want) ? Math.floor(want) : WAYPOINT_ENTRY_DEPTH;
  const edge = Math.min(record, asked, WAYPOINT_DEPTH_LIMIT);
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  const list = portalPlaces(places, c);
  const span = (c > 1 ? c : Math.max(...list)) + Math.max(...list) + 1;
  for (let d = Math.floor(edge), k = 0; d >= WAYPOINT_ENTRY_DEPTH && k <= span; d--, k++) if (isWaypoint(d, places, cycle)) return d;
  return WAYPOINT_ENTRY_DEPTH;
}

/**
 * Разблокирована ли сложность: тир с unlockFloor > 0 требует, чтобы на предыдущем
 * тире была достигнута глубина ≥ unlockFloor. Тиры идут по порядку списка.
 */
export function isDifficultyUnlocked(
  diffs: Difficulty[],
  index: number,
  progress: Record<string, number>,
): boolean {
  const diff = diffs[index];
  if (!diff || diff.unlockFloor <= 0) return true;
  const prev = diffs[index - 1];
  if (!prev) return true;
  return (progress[prev.id] ?? 0) >= diff.unlockFloor;
}

/** Включённый тир, который не откроется никогда (см. `lockedDifficulties`). */
export interface LockedDifficulty {
  id: string;
  unlockFloor: number;
  /** Тир, на котором копится прогресс (предыдущий по списку). */
  prevId: string;
  /**
   * prev — предыдущий тир выключен или сам закрыт навсегда.
   * ⚠⚠ 13.10 (Г2, Р6): причина `'depth'` УДАЛЕНА вместе с потолком глубины — поле осталось перечислением из одного
   * значения осознанно: вторая причина (чем бы она ни была) снова ляжет сюда, а читатели (редактор, сторож) её печатают.
   */
  cause: 'prev';
}

/**
 * ⭐ R8-13: включённые тиры, которые НЕЛЬЗЯ открыть ни честно, ни читом: предыдущий тир выключен (его не выбрать,
 * прогресс на нём не набрать) или сам закрыт навсегда. Сторож данных (тест) и проверка редактора зовут это же.
 *
 * ⚠⚠ 13.10 (Г2, Р6): АРГУМЕНТ `maxDepth` И ПРИЧИНА `'depth'` СНЯТЫ — ПОТОЛКА ГЛУБИНЫ БОЛЬШЕ НЕТ. Прогресс сложности —
 * глубина узла забега (`Room.enterNode`), и прежде она не могла превысить «длина шаблона + финал» (15), поэтому порог
 * выше был замком навсегда: так и было с «Кошмаром» — 20-й этаж «Сложной» при дне мира 15. Теперь спуск бесконечен
 * (`generateRunPlan` — окно слоёв, адресуемое глубиной), ЛЮБОЙ порог достижим, и запереть тир глубиной нельзя ни при
 * каких данных. Доказательство живое, а не на слово: `config/difficultyReach.test.ts` строит узел на 500 и 5000 и на
 * пороге КАЖДОГО ТИРА ИЗ ДАННЫХ.
 *
 * ⚠ 14.10: ИМЕННО «ИЗ ДАННЫХ», А НЕ «ВКЛЮЧЁННОГО» — здесь стояло второе, и это была неправда: включённых тиров с
 * порогом сегодня НОЛЬ (порог есть у «Сложной» (10) и «Кошмара» (12), и оба выключены; у живой «Средней» он 0).
 * Поэтому сторож фильтрует `unlockFloor > 0` БЕЗ `enabled` — с фильтром по включённости его цикл шёл БЕЗ ЕДИНОГО
 * примера. Порог — датум самого тира, а не его выключателя: редактор включает тир одним кликом, и достижим порог
 * обязан быть ДО того.
 */
export function lockedDifficulties(diffs: readonly Difficulty[]): LockedDifficulty[] {
  const out: LockedDifficulty[] = [];
  let prevOpen = false;   // предыдущий тир можно играть (включён и открывается)
  diffs.forEach((diff, i) => {
    const prev = diffs[i - 1];
    let open = diff.enabled !== false;
    if (open && prev && diff.unlockFloor > 0 && !prevOpen) {
      out.push({ id: diff.id, unlockFloor: diff.unlockFloor, prevId: prev.id, cause: 'prev' });
      open = false;
    }
    prevOpen = open;
  });
  return out;
}
