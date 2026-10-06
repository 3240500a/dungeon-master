import { ATTRIBUTES } from '../types/attributes.js';
import { buffTimingIssues } from '../formulas/buffTiming.js';
import { ESSENCE_ID } from '../formulas/salvage.js';
import { RETIRED_FAMILIES, liveFamily, retiredSuccessor } from '../economy/retiredMaterials.js';
import { configSchemas, type ConfigKey, type ConfigShapes } from './schemas.js';
import { defaultConfigData } from './defaults.js';

/**
 * ⭐ D4: конфиг, поверх которого ложится оверрайд (для правил поверх нескольких таблиц). ⭐ R21-01: это ИТОГОВЫЙ кандидат сборки (файлы + все
 * оверрайды базы, `server/configCandidate.ts`), а не полусобранный реестр: иначе годный вместе набор «приводился» в зависимости от порядка строк.
 */
export interface StoredOverrideLive { get<K extends ConfigKey>(key: K): ConfigShapes[K] }

/**
 * ⚠ R20-08: ОВЕРРАЙД ИЗ БАЗЫ, СОХРАНЁННЫЙ ПОД ПРЕЖНЕЙ СХЕМОЙ, — ПРИВЕСТИ, А НЕ ВЫБРОСИТЬ.
 *
 * Оверрайд редактора ложится таблицей целиком (`reload({[key]: value})`), и таблица, не прошедшая схему, пропускается вся. Когда схема
 * строже той, под которой оверрайд сохранён, одно старое значение выбрасывает ВСЕ правки хозяина в этой таблице. Так R18-07 (старт класса —
 * целые ≥ 0; до него редактор пускал дробь: «Ловкость + 0.5») делал с оверрайдом `classes`: одна дробь — и имена, галки, стартовое оружие
 * и старты прочих классов при каждой пересборке молча откатывались к файлу, а вход героя старше R18-07 (R19-01) писал ему старт со строки
 * файла.
 *
 * Здесь приводится только то, что новая схема сузила: старт класса — вниз до целого, не ниже нуля (дробную долю очка не вложить никогда,
 * минус — не атрибут); ⭐ D2 — кривая опыта `balance.xpTable`, сохранённая до R20-05 (`upgradeXpTable`); ⭐ D4 — откат баффа (узел древа,
 * печать вставки), короче правила времени баффа (`upgradeBuffTiming`: поверх `live` — итогового кандидата сборки, R21-01); ⭐ сырьё
 * `craft-materials`, сохранённое до эссенции и цен D4 (`upgradeCraftMaterials`); ⭐ снятые 06.10 семьи «Плечи» и «Фокус» в `craft-materials`,
 * `weapon-anatomy`, `weapon-parts`, `salvage-rules`, `monster-gear` (`dropRetiredMaterials` и соседи). Прочее не трогается — не прошедшее
 * схему пропускается, как прежде (инцидентом). Зовёт
 * только сборка живого конфига из базы (`server/configLive.ts`) и починка базы (`db:repair`): новая запись из редактора и файл данных
 * идут строгой схемой, мимо этого, — дробь там по-прежнему отказ.
 *
 * Возвращает приведённую копию (исходное не трогается) и список приведённого — вслух в лог; ничего не приведено — то же значение.
 */
export function upgradeStoredOverride(key: string, value: unknown, live?: StoredOverrideLive): { value: unknown; fixes: string[] } {
  if (key === 'balance') return upgradeBalance(value);
  if (key === 'skill-tree' || key === 'skill-inserts') return upgradeBuffTiming(key, value, live);
  if (key === 'craft-materials') {
    const a = upgradeCraftMaterials(value);
    const b = dropRetiredMaterials(a.value);
    return b.fixes.length ? { value: b.value, fixes: [...a.fixes, ...b.fixes] } : a;
  }
  if (key === 'weapon-anatomy') return upgradeRetiredAnatomy(value);
  if (key === 'weapon-parts') return upgradeRetiredParts(value);
  if (key === 'salvage-rules') return upgradeRetiredYields(value, 'yields', true);
  if (key === 'monster-gear') return upgradeRetiredYields(value, 'salvageTo', false);
  if (key !== 'classes' || !Array.isArray(value)) return { value, fixes: [] };
  const fixes: string[] = [];
  const rows = value.map((row: unknown, i) => {
    if (!row || typeof row !== 'object') return row;
    const st = (row as { startAttributes?: unknown }).startAttributes;
    if (!st || typeof st !== 'object') return row;
    let next: Record<string, unknown> | undefined;
    for (const a of ATTRIBUTES) {
      const v = (st as Record<string, unknown>)[a];
      if (typeof v !== 'number' || !Number.isFinite(v) || (Number.isInteger(v) && v >= 0)) continue;
      const n = Math.max(0, Math.floor(v));
      (next ??= { ...(st as Record<string, unknown>) })[a] = n;
      const id = (row as { id?: unknown }).id;
      fixes.push(`${typeof id === 'string' ? id : `#${i}`}.startAttributes.${a}: ${v} → ${n}`);
    }
    return next ? { ...(row as Record<string, unknown>), startAttributes: next } : row;
  });
  return fixes.length ? { value: rows, fixes } : { value, fixes };
}

/**
 * ⭐ ОВЕРРАЙД `craft-materials`, СОХРАНЁННЫЙ ДО ЭССЕНЦИИ И ЦЕН D4 (предложение «Разбор, сырьё и чары» §14.4). Оверрайд — таблица ЦЕЛИКОМ:
 * любая правка сырья в редакторе до этих правил (галка «булат — позже», R2-28) сохранила все 40 строк со старыми ценами I–V = 1/4/12/36/108
 * и без строки эссенции. Схема такую таблицу пропускает, и старая экономика жила молча: эссенция не падала, чары и перекатка шли без неё, а
 * пол цены лавки (`shopSellPrice` ≥ `salvageWorth`) превращал старые цены сырья в цены самих вещей (длинный меч t6 за 756 вместо 134).
 * Признак старой таблицы — нет строки эссенции (`ESSENCE_ID`): таблица, сохранённая после правила, несёт её всегда (редактор пишет таблицу
 * целиком). Тогда: недостающие строки файла дописываются, а цена продажи (`sellPrice`) каждой строки — цена файла. Галки (`enabled`), имена,
 * заметки и значки хозяина остаются. Таблица с эссенцией — правило уже знала, не трогается: цены в ней — решение хозяина (их держит
 * правило поверх таблиц). `db:repair -- --fix` записывает приведённое в базу.
 */
function upgradeCraftMaterials(value: unknown): { value: unknown; fixes: string[] } {
  if (!Array.isArray(value)) return { value, fixes: [] };
  const rowId = (r: unknown): unknown => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined);
  if (value.some((r) => rowId(r) === ESSENCE_ID)) return { value, fixes: [] };
  const file = (defaultConfigData as Record<string, unknown>)['craft-materials'];
  if (!Array.isArray(file)) return { value, fixes: [] };
  const fileRow = new Map<unknown, Record<string, unknown>>(file.map((r) => [rowId(r), r as Record<string, unknown>]));
  const fixes: string[] = [];
  const rows = value.map((row: unknown) => {
    if (!row || typeof row !== 'object') return row;
    const own = row as Record<string, unknown>;
    const f = fileRow.get(own.id);
    if (!f || f.sellPrice === undefined || own.sellPrice === f.sellPrice) return row;
    fixes.push(`craft-materials.${String(own.id)}.sellPrice: ${String(own.sellPrice)} → ${String(f.sellPrice)} (цены D4)`);
    return { ...own, sellPrice: f.sellPrice };
  });
  const have = new Set(rows.map(rowId));
  for (const f of file) {
    if (have.has(rowId(f))) continue;
    rows.push(structuredClone(f));
    fixes.push(`craft-materials: + «${String(rowId(f))}» из файла (таблица сохранена до него)`);
  }
  return fixes.length ? { value: rows, fixes } : { value, fixes: [] };
}

/**
 * ⭐ СНЯТЫЕ СЕМЬИ «ПЛЕЧИ» И «ФОКУС» (06.10, `economy/retiredMaterials.ts`) В ОВЕРРАЙДАХ БАЗЫ. Оверрайд — таблица целиком, и сохранённая до
 * снятия держит их строки: сырьё `stave-*` / `focus-*` (у игроков его больше нет — переехало в Дерево и Прибор), гнёзда анатомии из этих
 * семей (лук, арбалет, жезл и посох просили бы сырьё, которого нет ни у кого, — класс не куётся), выход разбора и тел монстров в них
 * (единицы пропадали бы молча). Приводится к правилу файла, вслух в лог; `db:repair -- --fix` записывает в базу. Сервер хозяина стартует
 * без ручных шагов. Таблица без снятых семей — как есть (второй проход ничего не находит).
 */
const isRetiredFamily = (f: unknown): f is string => typeof f === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_FAMILIES, f);
const rowIdOf = (r: unknown): unknown => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined);
const fileRows = (key: string): Record<string, unknown>[] => {
  const f = (defaultConfigData as Record<string, unknown>)[key];
  return Array.isArray(f) ? (f as Record<string, unknown>[]) : [];
};

/** `craft-materials`: строки снятых семей — долой (их сырьё у игроков уже в преемнике того же сорта). */
function dropRetiredMaterials(value: unknown): { value: unknown; fixes: string[] } {
  if (!Array.isArray(value)) return { value, fixes: [] };
  const fixes: string[] = [];
  const rows = value.filter((row: unknown) => {
    const id = rowIdOf(row);
    const fam = row && typeof row === 'object' ? (row as { family?: unknown }).family : undefined;
    const to = typeof id === 'string' ? retiredSuccessor(id) : undefined;
    if (!to && !isRetiredFamily(fam)) return true;
    fixes.push(`craft-materials: − «${String(id)}» (семья «${String(fam)}» снята — сырьё игроков переехало в «${to ?? liveFamily(String(fam))}» того же сорта)`);
    return false;
  });
  return fixes.length ? { value: rows, fixes } : { value, fixes: [] };
}

/** `weapon-anatomy`: семья гнезда из снятых — семья того же гнезда в файле (лук — Дерево, арбалет — Железо, жезл и посох — Прибор). */
function upgradeRetiredAnatomy(value: unknown): { value: unknown; fixes: string[] } {
  if (!Array.isArray(value)) return { value, fixes: [] };
  const file = new Map(fileRows('weapon-anatomy').map((r) => [rowIdOf(r), r]));
  const fixes: string[] = [];
  const rows = value.map((row: unknown) => {
    if (!row || typeof row !== 'object') return row;
    let next: Record<string, unknown> | undefined;
    for (const slot of ['strike', 'grip', 'bind', 'head'] as const) {
      const g = (row as Record<string, unknown>)[slot];
      const fam = g && typeof g === 'object' ? (g as { family?: unknown }).family : undefined;
      if (!isRetiredFamily(fam)) continue;
      const fg = file.get(rowIdOf(row))?.[slot] as { family?: unknown } | undefined;
      const to = typeof fg?.family === 'string' && fg.family && !isRetiredFamily(fg.family) ? fg.family : liveFamily(fam);
      (next ??= { ...(row as Record<string, unknown>) })[slot] = { ...(g as Record<string, unknown>), family: to };
      fixes.push(`weapon-anatomy.${String(rowIdOf(row))}.${slot}.family: ${fam} → ${to} (семья снята)`);
    }
    return next ?? row;
  });
  return fixes.length ? { value: rows, fixes } : { value, fixes: [] };
}

/**
 * `weapon-parts`: своя семья детали из снятых — как у той же детали в файле (или преемник). ⭐ И КОНЦЫ ЛУКА: снятие Плеч дало концам и
 * накладкам лука выбор «Дерево или Прибор по детали» (в файле роговые ноки и накладки сиях — Прибор). Таблица, сохранённая ДО этого, не
 * знает своей семьи ни у одной детали концов лука — тогда детали, которым файл дал семью, берут её из файла (иначе у хозяина концы лука
 * только деревянные). Хозяину, которому нужны деревянные, достаточно поставить детали явное `wood`: таблица со своей семьёй хоть у одной
 * детали концов лука считается сохранённой после правила и не трогается.
 */
function upgradeRetiredParts(value: unknown): { value: unknown; fixes: string[] } {
  if (!Array.isArray(value)) return { value, fixes: [] };
  const file = new Map(fileRows('weapon-parts').map((r) => [rowIdOf(r), r]));
  const famOf = (r: unknown): unknown => (r && typeof r === 'object' ? (r as { family?: unknown }).family : undefined);
  const bowHead = (r: unknown): boolean => {
    const x = r as { slot?: unknown; classes?: unknown } | null | undefined;
    return !!x && typeof x === 'object' && x.slot === 'head' && Array.isArray(x.classes) && x.classes.includes('bow');
  };
  const preRule = !value.some((r: unknown) => bowHead(r) && typeof famOf(r) === 'string' && famOf(r) !== '');
  const fixes: string[] = [];
  const rows = value.map((row: unknown) => {
    if (!row || typeof row !== 'object') return row;
    const fam = famOf(row);
    const f = file.get(rowIdOf(row));
    const ff = famOf(f);
    if (isRetiredFamily(fam)) {
      const to = typeof ff === 'string' && ff && !isRetiredFamily(ff) ? ff : liveFamily(fam);
      fixes.push(`weapon-parts.${String(rowIdOf(row))}.family: ${fam} → ${to} (семья снята)`);
      return { ...(row as Record<string, unknown>), family: to };
    }
    if (preRule && bowHead(row) && bowHead(f) && (fam === undefined || fam === '') && typeof ff === 'string' && ff) {
      fixes.push(`weapon-parts.${String(rowIdOf(row))}.family: «» → ${ff} (концы и накладки лука — Дерево или Прибор по детали, как в файле)`);
      return { ...(row as Record<string, unknown>), family: ff };
    }
    return row;
  });
  return fixes.length ? { value: rows, fixes } : { value, fixes: [] };
}

/**
 * `salvage-rules` (`yields`) и `monster-gear` (`salvageTo`): выход в снятое сырьё — в преемника того же сорта (кольцо и амулет: Фокус →
 * Прибор; тела с луками и арбалетами: Плечи → Дерево; с жезлами и посохами: Фокус → Прибор). У брони (правило `kind: armor`) побочные
 * Плечи 0–1 сняты вовсе, как в файле: кожа и стёганка Дерева не дают.
 */
function upgradeRetiredYields(value: unknown, field: 'yields' | 'salvageTo', dropArmorStave: boolean): { value: unknown; fixes: string[] } {
  if (!Array.isArray(value)) return { value, fixes: [] };
  const key = field === 'yields' ? 'salvage-rules' : 'monster-gear';
  const fixes: string[] = [];
  const rows = value.map((row: unknown) => {
    if (!row || typeof row !== 'object') return row;
    const ys = (row as Record<string, unknown>)[field];
    if (!Array.isArray(ys)) return row;
    const armor = dropArmorStave && (row as { kind?: unknown }).kind === 'armor';
    let touched = false;
    const next: unknown[] = [];
    for (const y of ys) {
      const id = y && typeof y === 'object' ? (y as { materialId?: unknown }).materialId : undefined;
      const to = typeof id === 'string' ? retiredSuccessor(id) : undefined;
      if (!to) { next.push(y); continue; }
      touched = true;
      if (armor && String(id).startsWith('stave-')) { fixes.push(`${key}.${String(rowIdOf(row))}: − ${String(id)} (побочные Плечи брони сняты)`); continue; }
      fixes.push(`${key}.${String(rowIdOf(row))}: ${String(id)} → ${to} (семья снята)`);
      next.push({ ...(y as Record<string, unknown>), materialId: to });
    }
    return touched ? { ...(row as Record<string, unknown>), [field]: next } : row;
  });
  return fixes.length ? { value: rows, fixes } : { value, fixes: [] };
}

/**
 * ⭐ D2: ОВЕРРАЙД `balance` С КРИВОЙ ОПЫТА СТАРШЕ R20-05. До R20-05 схема пускала любой массив чисел, теперь — «0, 0, дальше строго
 * растёт»; одна ступенька в сохранённой кривой выбрасывала бы при каждой пересборке ВСЕ правки баланса хозяина (цены, очки за уровень,
 * сброс, кузница). Приводится только кривая, прочие поля — как есть.
 */
function upgradeBalance(value: unknown): { value: unknown; fixes: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, fixes: [] };
  const got = upgradeXpTable((value as { xpTable?: unknown }).xpTable);
  return got ? { value: { ...(value as Record<string, unknown>), xpTable: got.table }, fixes: got.fixes } : { value, fixes: [] };
}

/**
 * ⭐ D2: КРИВАЯ ОПЫТА, СОХРАНЁННАЯ ДО R20-05, — К «0, 0, ДАЛЬШЕ СТРОГО РАСТЁТ». Годная (или не массив конечных чисел — такую не пускала и
 * прежняя схема) — `null`, не трогается. Иначе: пороги первых двух уровней — 0; из прочих остаётся НАИБОЛЬШИЙ набор, который и так растёт
 * (с запасом хотя бы в очко опыта на уровень — чтобы между ними встали целые), а выпавшие (ступенька, повтор, пропущенная или лишняя цифра,
 * минус) встают на прямую между соседями, что остались, — округлённо, строго по возрастанию. Хвост, за которым не осталось ни одного порога,
 * отрезается: потолок уровня ниже — герои выше него своих уровней не теряют (R9-05), а поднять одним очком опыта через участок не
 * выше прежних (R20-05) не может никого. Не осталось ни одного порога после первого уровня — `null` (пропуск инцидентом: угадывать нечего).
 */
export function upgradeXpTable(t: unknown): { table: number[]; fixes: string[] } | null {
  if (!Array.isArray(t) || t.length < 2 || t.length > 5000 || !t.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const xs = t as number[];
  const good = xs.every((v, i) => v >= 0 && (i < 2 ? v === 0 : v > xs[i - 1]!));
  if (good) return null;
  // Наибольшая цепочка индексов ≥ 2, где `v − i` не убывает, от точки (1, 0) — ключ −1: между соседями цепочки хватает места под целые.
  const key = (i: number): number => xs[i]! - i;
  const len: number[] = [], prev: number[] = [];
  let end = -1;
  for (let i = 2; i < xs.length; i++) {
    len[i] = 0; prev[i] = -1;
    if (!(xs[i]! >= 0) || key(i) < -1) continue;
    len[i] = 1;
    for (let j = 2; j < i; j++) if (len[j]! > 0 && key(j) <= key(i) && len[j]! + 1 > len[i]!) { len[i] = len[j]! + 1; prev[i] = j; }
    if (end < 0 || len[i]! >= len[end]!) end = i;   // равные — дальний конец: потолок выше
  }
  if (end < 0) return null;
  const kept = new Set<number>();
  for (let i = end; i >= 0; i = prev[i]!) kept.add(i);
  const table: number[] = [0, 0];
  let from = 1;
  for (let i = 2; i <= end; i++) {
    if (kept.has(i)) { table[i] = xs[i]!; from = i; continue; }
    let to = i + 1;
    while (!kept.has(to)) to++;
    const a = table[from]!, b = xs[to]!;
    table[i] = Math.round(a + ((b - a) * (i - from)) / (to - from));
  }
  const fixes: string[] = [];
  for (let i = 0; i <= end; i++) if (table[i] !== xs[i]) fixes.push(`balance.xpTable[${i}]: ${xs[i]} → ${table[i]}`);
  if (end < xs.length - 1) fixes.push(`balance.xpTable: потолок уровня ${xs.length - 1} → ${end} (дальше порогов выше прежних нет)`);
  return { table, fixes };
}

/**
 * ⭐ D4: ОВЕРРАЙД ДРЕВА ИЛИ ВСТАВОК, СОХРАНЁННЫЙ ДО ПРАВИЛА ВРЕМЕНИ БАФФА (`formulas/buffTiming.ts`). Схема теперь не пускает бафф, чей откат
 * хоть на одном ранге короче действия с отдыхом (`balance.buffMinRest`): одна такая строка (например, «Огненные чары» 12 с на 12 с из
 * R19-03, клич воина до 20-го ранга или печать с откатом 0) выбрасывала бы при каждой пересборке ВСЕ правки хозяина в древе. Нарушитель
 * приводится ЗАЖИМОМ, как делал R19-03 в ядре, только в данных и вслух в лог (`BuffTimingIssue.repair`): узел — потолок ранга до последнего
 * годного (вложенные выше ранги откат дальше не режут — `buffNodeCooldown`), а если короче правила и первый ранг — сперва его откат до правила;
 * печать — откат до правила на высшем ранге донора. Прочие таблицы правила — из `live` (итоговый кандидат сборки, R21-01; нет — файлы данных). Не
 * прошедшее схему таблицы — не трогается.
 */
function upgradeBuffTiming(key: 'skill-tree' | 'skill-inserts', value: unknown, live?: StoredOverrideLive): { value: unknown; fixes: string[] } {
  const parsed = configSchemas[key].safeParse(value);
  if (!parsed.success) return { value, fixes: [] };
  const other = <K extends 'balance' | 'skill-tree' | 'skill-inserts'>(k: K): ConfigShapes[K] => {
    if (live) return live.get(k);
    return configSchemas[k].parse((defaultConfigData as Record<string, unknown>)[k]) as ConfigShapes[K];
  };
  const tables = {
    balance: other('balance'),
    'skill-tree': key === 'skill-tree' ? (parsed.data as ConfigShapes['skill-tree']) : other('skill-tree'),
    'skill-inserts': key === 'skill-inserts' ? (parsed.data as ConfigShapes['skill-inserts']) : other('skill-inserts'),
  };
  const bad = buffTimingIssues(tables).filter((i) => i.table === key);
  if (!bad.length) return { value, fixes: [] };
  const out = structuredClone(value) as Record<string, unknown> | unknown[];
  const rows = (key === 'skill-tree' ? (out as { nodes?: unknown }).nodes : out) as unknown;
  if (!Array.isArray(rows)) return { value, fixes: [] };
  const fixes: string[] = [];
  for (const i of bad) {
    const row = rows.find((r: unknown) => !!r && typeof r === 'object' && (r as { id?: unknown }).id === i.id) as Record<string, unknown> | undefined;
    const ab = (key === 'skill-tree'
      ? (row?.effect as { active?: unknown } | undefined)?.active
      : (row?.proc as { ability?: unknown } | undefined)?.ability) as Record<string, unknown> | undefined;
    if (!ab) continue;
    const why = `правило баффа D4: на ранге ${i.rank} откат ${i.cooldown} с при действии ${i.duration} с, а не короче ${i.floor} с`;
    const was = typeof ab.cooldown === 'number' ? ab.cooldown : 0;
    if (i.repair.cooldown !== was) {
      ab.cooldown = i.repair.cooldown;
      fixes.push(`${key}.${i.id}${key === 'skill-tree' ? '.effect.active' : '.proc.ability'}.cooldown: ${was} → ${i.repair.cooldown} (${why})`);
    }
    if (i.repair.maxRank !== undefined && row && row.maxRank !== i.repair.maxRank) {
      fixes.push(`${key}.${i.id}.maxRank: ${String(row.maxRank)} → ${i.repair.maxRank} (${why}; вложенные выше ранги откат дальше не режут)`);
      row.maxRank = i.repair.maxRank;
    }
  }
  return fixes.length ? { value: out, fixes } : { value, fixes: [] };
}
