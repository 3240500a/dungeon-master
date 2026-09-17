/**
 * РОАДМАП — ЧИСТОЕ ЯДРО (Р1): типы вех, счётчики и математика прогресса. Без DOM → node-тесты.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ТРЕКЕР. `docs/ROADMAP.md` — документ РЕШЕНИЙ (почему такие даты, почему такая ниша).
 * Вести им работу нельзя: там нет состояния «сделано / осталось», и он устаревает в день, когда что-то
 * сделано. Здесь — состояние.
 *
 * ⭐ ГЛАВНАЯ ИДЕЯ: часть пунктов СЧИТАЕТ СЕБЯ САМА. Редактор при старте уже держит весь снапшот конфига,
 * а модели, текстуры и звуки лежат на сервере — значит «монстров 13 из 35» и «звуков 0 из 200» не надо
 * отмечать руками, они меряются. Роадмап перестаёт врать, потому что половина его — замер, а не декларация.
 *
 * ⚠ ПОЧЕМУ ДАННЫЕ НЕ В ИГРОВОМ КОНФИГЕ: `ConfigRegistry.loadAll()` БРОСАЕТ исключение на невалидном
 * ключе, то есть опечатка в задаче проекта уронила бы игровой сервер. Роадмап живёт в `pose_store`
 * под ключом `pe_roadmap` — там запись и так DEV-only, а связи с игрой нет вовсе.
 */
import type { PublicRoadmap } from './roadmapPublic.js';

/**
 * Снапшот конфига, каким его держит редактор, — СЫРОЙ (`Record<string, unknown>`), а не `ConfigShapes`.
 * Это не лень типизации: сервер может отдать неполный конфиг (или не отдать вовсе — тогда встроенные
 * дефолты), и счётчик обязан вернуть «не знаю» вместо падения вкладки. Отсюда защитные `arr`/`num`.
 */
export type Snapshot = Record<string, unknown>;
const arr = (d: Snapshot, key: string): unknown[] => (Array.isArray(d[key]) ? d[key] as unknown[] : []);
const has = (d: Snapshot, key: string): boolean => Array.isArray(d[key]);
/** Массив внутри объекта: `skill-tree.nodes`. */
const nested = (d: Snapshot, key: string, field: string): unknown[] => {
  const o = d[key] as Record<string, unknown> | undefined;
  return o && Array.isArray(o[field]) ? o[field] as unknown[] : [];
};
const byField = (d: Snapshot, key: string, field: string, value: unknown): number =>
  arr(d, key).filter((x) => (x as Record<string, unknown>)?.[field] === value).length;

/** Кто закрывает пункт. При команде из двоих это главный вопрос: у кого критический путь. */
export type Who = 'code' | 'art' | 'design';
export const WHO_LABEL: Record<Who, string> = { code: 'код', art: 'графика', design: 'дизайн' };

/** Откуда берётся ТЕКУЩЕЕ число у пункта-счётчика. */
export type Source =
  /** Считаем по снапшоту конфига, который редактор уже загрузил (см. `COUNTERS`). */
  | { kind: 'config'; counter: string }
  /** Считаем файлы на сервере: `GET /api/assets/stats`. Закрывает модели, текстуры и звуки. */
  | { kind: 'assets'; ext: string; dir?: string }
  /** Вбито руками — для того, чего на сервере нет (вишлисты Steam). */
  | { kind: 'manual'; value: number };

export interface Item {
  id: string;
  title: string;
  who?: Who;
  /** Оценка трудоёмкости — свободный текст («2–3 нед»), нужен только глазам. */
  est?: string;
  note?: string;
  /** Пункт-галка: отмечается вручную. Игнорируется, если задан `target`. */
  done?: boolean;
  /** Есть `target` + `source` → пункт становится СЧЁТЧИКОМ с частичным зачётом. */
  target?: number;
  source?: Source;
}

export interface Milestone {
  id: string;
  /** Группировка: к какой крупной фазе относится месячная веха («Ф1»). */
  phase?: string;
  title: string;
  /** Цель одной строкой — что эта веха даёт проекту. */
  goal: string;
  /** Развёрнутое описание (многострочное). Нужно отправной точке: где проект стоит на старте отсчёта. */
  desc?: string;
  /** `YYYY-MM` или `YYYY-MM-DD`. По `to` считается просрочка. */
  from?: string;
  /** ТЕКУЩИЙ срок. Двигается, когда сдвигаем хвост из-за отставания. */
  to: string;
  /**
   * ИЗНАЧАЛЬНЫЙ план — записывается один раз и НЕ меняется никогда. Без него отклонение считать не от чего:
   * если двигать только `to`, план всегда «выполняется», потому что подгоняется под факт.
   */
  planned?: string;
  /** Фактическая дата закрытия, `YYYY-MM-DD`. Ставится один раз, когда веха дошла до 100 %. */
  closedAt?: string;
  /**
   * Отправная точка — снимок состояния, а не работа. В статистику сроков НЕ входит: иначе её «закрытие»
   * задним числом попадает в средний сдвиг и портит его (первый прогон дал −20 дней из ниоткуда).
   */
  baseline?: boolean;
  /**
   * Чем веха является для планирования:
   *  • `work` (умолчание) — наша работа, двигается вместе с отставанием;
   *  • `fest` — привязана к ВНЕШНЕМУ событию (Next Fest). Оно не подстраивается под нас: обогнали план —
   *    можно перецепиться на более ранний фестиваль, отстали — на более поздний, но не «на месяц вперёд»;
   *  • `launch` — дата запуска. Не сдвигается произвольно, а СНАПАЕТСЯ на чистое окно между распродажами.
   */
  kind?: 'work' | 'fest' | 'launch';
  /** Для `fest`: id события из календаря (`roadmapCalendar.STEAM_EVENTS`). */
  eventId?: string;
  /**
   * Веха, после которой демо МОЖНО ПОДАВАТЬ на фестиваль. Заявку принимают по демо, а не по всей игре,
   * поэтому гейт стоит на публикации демо, а не на последней работе перед фестивалем: контент, который
   * делается уже ПОСЛЕ подачи, срок заявки не двигает. Без явной метки пересчёт считал бы, что демо
   * готово в сентябре, и выкидывал бы нас с октябрьского фестиваля на февральский.
   */
  gatesFest?: boolean;
  /**
   * Веха, которой демо доводится до СДАЧИ НА ПРОВЕРКУ. Это ВТОРОЙ срок фестиваля и он на месяц позже
   * заявки: страницу открывают заранее, а билд досылают потом. Флаг нужен по той же причине, что и
   * `gatesFest` — «последняя работа перед фестивалем» неверный ориентир, потому что контент, который
   * в демо не входит, срок сдачи не двигает.
   */
  gatesDemo?: boolean;
  items: Item[];
}

export interface RoadmapDoc {
  milestones: Milestone[];
  /** Когда правили последний раз (для «сохранено ✓» и разбора конфликтов между машинами). */
  updatedAt?: number;
  /**
   * До какой правки наполнения (`roadmapSeed.SEED_PATCHES`) документ доведён. Нет поля — ревизия 1.
   * Нужен, чтобы обновления роадмапа из репозитория доезжали и до уже открытой, правленой копии.
   */
  seedRev?: number;
  /** Роадмап для игроков: свой текст, статусы и сроки — из вех этого документа (`roadmapPublic.ts`). */
  public?: PublicRoadmap;
}

/** Файловая статистика с сервера: `{ byExt: {glb: 9}, byDir: {'tiles/crypt': 6} }`. */
export interface AssetStats {
  byExt: Record<string, number>;
  byDir: Record<string, number>;
  bytes: number;
}

// ── Счётчики по конфигу ──────────────────────────────────────────────────────────────────────────
/**
 * Реестр ИМЕНОВАННЫХ счётчиков, а не язык путей-запросов. Так типобезопаснее, переживает переименования
 * полей, и каждый счётчик умеет свой фильтр (модели персонажей ≠ модели оружия).
 *
 * ⚠ ПРАВИЛО ВЫБОРА СЧЁТЧИКА, куплённое живой проверкой: **счётчик годится только там, где САМА СТРОКА
 * КОНФИГА и есть работа** — монстр, уник, модель, звуковой файл. Где «готово» это СУЖДЕНИЕ (биом готов,
 * класс готов), счётчик врёт: объявить биом стоит одной строки, а построить — месяцы. На первом же прогоне
 * веха «Релиз 1.0» показала 50 % готовности только потому, что в конфиге объявлены 4 биома и 7 классов,
 * хотя не сделано ничего. Для таких вещей — обычная галка.
 * Поэтому счётчики ниже названы по тому, ЧТО ОНИ РЕАЛЬНО МЕРЯЮТ, а не по тому, чего от них хочется.
 */
export const COUNTERS: Record<string, { label: string; count: (d: Snapshot) => number | null }> = {
  monsters: { label: 'Типы монстров', count: (d) => (has(d, 'monsters') ? arr(d, 'monsters').length : null) },
  uniques: { label: 'Уникальные предметы', count: (d) => (has(d, 'uniques') ? arr(d, 'uniques').length : null) },
  itemsBase: { label: 'Базовые предметы', count: (d) => (has(d, 'items.base') ? arr(d, 'items.base').length : null) },
  affixes: { label: 'Аффиксы', count: (d) => (has(d, 'affixes') ? arr(d, 'affixes').length : null) },
  charModels: { label: 'Модели персонажей', count: (d) => (has(d, 'models') ? byField(d, 'models', 'kind', 'character') : null) },
  weaponModels: { label: 'Модели оружия', count: (d) => (has(d, 'models') ? byField(d, 'models', 'kind', 'weapon') : null) },
  partModels: { label: 'Модели-детали', count: (d) => (has(d, 'models') ? byField(d, 'models', 'kind', 'part') : null) },
  cryptTiles: {
    // Отдельно от `partModels`: деталями станут и куски модульного персонажа, и тогда общий счётчик
    // начнёт врать про тайлсет. Правило то же — строка конфига обязана БЫТЬ работой этой вехи.
    label: 'Детали крипты (models kind=part, id crypt_*)',
    count: (d) => (has(d, 'models')
      ? arr(d, 'models').filter((x) => {
        const mm = x as { kind?: string; id?: string };
        return mm?.kind === 'part' && typeof mm.id === 'string' && mm.id.startsWith('crypt');
      }).length
      : null),
  },
  craftMaterials: {
    // Секции ещё нет — счётчик вернёт null и пункт поведёт себя как галка (это уже под тестом).
    label: 'Виды материалов крафта',
    count: (d) => (has(d, 'craft-materials') ? arr(d, 'craft-materials').length : null),
  },
  recipes: { label: 'Рецепты крафта', count: (d) => (has(d, 'recipes') ? arr(d, 'recipes').length : null) },
  materials: { label: 'Материалы', count: (d) => (has(d, 'materials') ? arr(d, 'materials').length : null) },
  texturesCfg: { label: 'Текстуры (в конфиге)', count: (d) => (has(d, 'textures') ? arr(d, 'textures').length : null) },
  biomesDeclared: {
    label: '⚠ Биомы ОБЪЯВЛЕНЫ (не построены)',
    count: (d) => (has(d, 'biomes') ? arr(d, 'biomes').filter((b) => (b as { enabled?: boolean })?.enabled !== false).length : null),
  },
  skillNodes: { label: 'Узлы древа навыков', count: (d) => (d['skill-tree'] ? nested(d, 'skill-tree', 'nodes').length : null) },
  masteryNodes: { label: 'Узлы древа мастерства', count: (d) => (d['mastery-tree'] ? nested(d, 'mastery-tree', 'nodes').length : null) },
  runModifiers: { label: 'Модификаторы забега', count: (d) => (has(d, 'run-modifiers') ? arr(d, 'run-modifiers').length : null) },
  debuffs: { label: 'Дебаффы', count: (d) => (has(d, 'debuffs') ? arr(d, 'debuffs').length : null) },
  classesDeclared: { label: '⚠ Классы ОБЪЯВЛЕНЫ (не сделаны)', count: (d) => (has(d, 'classes') ? arr(d, 'classes').length : null) },
};

/** Всё, что нужно счётчикам, одним объектом — чтобы математика оставалась чистой функцией. */
export interface Ctx {
  config?: Snapshot;
  assets?: AssetStats;
  /** «Сегодня» — параметр, а не `Date.now()`: иначе тесты на просрочку зависели бы от календаря. */
  now?: number;
}

/** Текущее число пункта-счётчика. `null` — источник недоступен (нет конфига/статистики). */
export function currentOf(item: Item, ctx: Ctx): number | null {
  const s = item.source;
  if (!s) return null;
  if (s.kind === 'manual') return s.value;
  if (s.kind === 'config') {
    if (!ctx.config) return null;
    const c = COUNTERS[s.counter];
    if (!c) return null;
    try { return c.count(ctx.config); } catch { return null; }   // конфиг мог приехать неполным — счётчик не должен ронять вкладку
  }
  // assets: либо весь тип файлов, либо только внутри папки
  if (!ctx.assets) return null;
  if (s.dir) return ctx.assets.byDir[s.dir] ?? 0;
  return ctx.assets.byExt[s.ext] ?? 0;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Счётчик или галка? Один предикат на весь модуль, чтобы правило жило в одном месте. */
export const isCounter = (item: Item): boolean => typeof item.target === 'number' && !!item.source;

/**
 * Готовность пункта 0..1.
 * ⭐ ЧАСТИЧНЫЙ ЗАЧЁТ — суть всей затеи: 13 из 35 даёт 0.37, а не ноль, поэтому полоса вехи ползёт
 * по мере того, как контент реально появляется, без единой ручной отметки.
 */
export function itemProgress(item: Item, ctx: Ctx): number {
  if (!isCounter(item)) return item.done ? 1 : 0;
  const target = item.target!;
  if (target <= 0) return 1;                       // цель 0 — «ничего не требуется», а не деление на ноль
  const cur = currentOf(item, ctx);
  if (cur === null) return item.done ? 1 : 0;      // источник молчит → ведём себя как галка
  return clamp01(cur / target);
}

/** Сколько ещё нужно по этому пункту. `null` — если это галка или источник недоступен. */
export function remainingOf(item: Item, ctx: Ctx): number | null {
  if (!isCounter(item)) return null;
  const cur = currentOf(item, ctx);
  if (cur === null) return null;
  return Math.max(0, item.target! - cur);
}

export interface Progress {
  /** 0..1 — среднее по пунктам. */
  ratio: number;
  /** Сколько пунктов ещё не закрыто полностью. Это и есть «осталось N». */
  remaining: number;
  total: number;
  /** Разбивка незакрытого по исполнителям — показывает, у кого критический путь. */
  byWho: Record<Who, number>;
}

export function milestoneProgress(m: Milestone, ctx: Ctx): Progress {
  const byWho: Record<Who, number> = { code: 0, art: 0, design: 0 };
  if (!m.items.length) return { ratio: 0, remaining: 0, total: 0, byWho };   // пустая веха НЕ готова: делать в ней нечего, но и хвалиться нечем
  let sum = 0, remaining = 0;
  for (const it of m.items) {
    const p = itemProgress(it, ctx);
    sum += p;
    if (p < 1) { remaining++; if (it.who) byWho[it.who]++; }
  }
  return { ratio: sum / m.items.length, remaining, total: m.items.length, byWho };
}

/** Прогресс по всему роадмапу — среднее по ПУНКТАМ, а не по вехам: веха из двух задач не должна весить как веха из двадцати. */
export function totalProgress(doc: RoadmapDoc, ctx: Ctx): Progress {
  const all: Milestone = { id: '__all', title: '', goal: '', to: '', items: doc.milestones.flatMap((m) => m.items) };
  return milestoneProgress(all, ctx);
}

const DAY = 86_400_000;
export const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Отклонение вехи в днях относительно ИЗНАЧАЛЬНОГО плана. Плюс — опоздание.
 * Закрыта → считаем по факту закрытия; открыта → по текущему сроку (то есть по уже накопленному сдвигу).
 */
export function driftDays(m: Milestone): number {
  const base = deadlineOf({ ...m, to: m.planned ?? m.to });
  const actual = m.closedAt ? Date.parse(m.closedAt + 'T23:59:59Z') : deadlineOf(m);
  return Math.round((actual - base) / DAY);
}

/**
 * Пометить веху закрытой, если она дошла до 100 % и ещё не помечена. Дата ставится ОДИН раз:
 * пересчитывать её каждый раз нельзя — тогда факт поедет вслед за конфигом и статистика станет ложью.
 * Возвращает true, если что-то изменилось (вызывающий сохранит документ).
 */
export function autoClose(doc: RoadmapDoc, ctx: Ctx): boolean {
  let changed = false;
  for (const m of doc.milestones) {
    const { ratio, total } = milestoneProgress(m, ctx);
    if (total > 0 && ratio >= 1 && !m.closedAt) { m.closedAt = toDay(ctx.now ?? Date.now()); changed = true; }
    if ((total === 0 || ratio < 1) && m.closedAt) { delete m.closedAt; changed = true; }   // веху переоткрыли (сняли галку) — факт снимаем
  }
  return changed;
}

/** Сдвинуть срок вехи на N дней, сохранив вид записи (`YYYY-MM` остаётся месяцем). */
export function shiftDate(iso: string, days: number): string {
  const isMonth = iso.split('-').length === 2;
  const p = iso.split('-').map(Number);
  const base = isMonth ? Date.UTC(p[0]!, p[1]!, 0) : Date.UTC(p[0]!, p[1]! - 1, p[2]!);
  const moved = new Date(base + days * DAY);
  return isMonth ? moved.toISOString().slice(0, 7) : moved.toISOString().slice(0, 10);
}

/**
 * Сдвинуть ВСЕ вехи после указанной на `days` дней. Трогаем только `to`, `planned` остаётся нетронутым —
 * иначе отклонение обнулялось бы каждым сдвигом и мы бы никогда не узнали, что систематически опаздываем.
 */
export function shiftTail(doc: RoadmapDoc, afterIndex: number, days: number): number {
  let n = 0;
  for (let i = afterIndex + 1; i < doc.milestones.length; i++) {
    const m = doc.milestones[i]!;
    if (m.closedAt) continue;                      // уже закрытые не двигаем: это история, а не план
    m.planned ??= m.to;                            // зафиксировать базу до первого сдвига
    m.to = shiftDate(m.to, days);
    if (m.from) m.from = shiftDate(m.from, days);
    n++;
  }
  return n;
}

/** Одно предложение пересчёта: что и почему меняется. Применяется только по кнопке. */
export interface Proposal {
  milestoneId: string;
  title: string;
  from: string;
  to: string;
  why: string;
  /** true — веха ушла ВПЕРЁД по сравнению с текущим сроком (опоздание), false — назад (выигрыш). */
  later: boolean;
  /** Для вехи-фестиваля: на какое событие календаря она перецепляется (проставится при применении). */
  eventId?: string;
}

export interface Stats {
  closed: number;
  total: number;
  /** Среднее отклонение закрытых вех, дней. Плюс — в среднем опаздываем. */
  avgDrift: number;
  /** Отклонение последней вехи графика (обычно релиз) от изначального плана, дней. */
  releaseDrift: number;
  /** Изначальная и текущая дата последней вехи. */
  releasePlanned: string;
  releaseNow: string;
  /**
   * Наивный прогноз: текущая дата релиза плюс среднее отклонение на каждую ещё не закрытую веху.
   * Именно наивный — линейная экстраполяция темпа, а не модель. Нужен, чтобы систематическое
   * отставание было ВИДНО заранее, а не всплыло за месяц до даты.
   */
  forecast: string;
}

export function roadmapStats(doc: RoadmapDoc): Stats | null {
  const work = doc.milestones.filter((m) => !m.baseline);   // отправная точка — не работа, в сроки не входит
  if (!work.length) return null;
  /**
   * Какая веха считается «релизом». Правило: ТОЧНАЯ ДАТА (день) — это обязательство, месяц — ориентир.
   * Поэтому берём последнюю веху с датой до дня; её и отслеживаем. Так статистика смотрит на запуск
   * раннего доступа, а не на 1.0 в далёком «по обстоятельствам».
   */
  const exact = [...work].reverse().find((m) => m.to.split('-').length === 3);
  const target = exact ?? work[work.length - 1]!;
  const closed = work.filter((m) => m.closedAt);
  const avgDrift = closed.length ? Math.round(closed.reduce((a, m) => a + driftDays(m), 0) / closed.length) : 0;
  const openBefore = work.slice(0, work.indexOf(target) + 1).filter((m) => !m.closedAt).length;
  return {
    closed: closed.length,
    total: work.length,
    avgDrift,
    releaseDrift: driftDays(target),
    releasePlanned: target.planned ?? target.to,
    releaseNow: target.to,
    forecast: avgDrift > 0 ? shiftDate(target.to, avgDrift * openBefore) : target.to,
  };
}

export type Status = 'done' | 'overdue' | 'active' | 'planned';

/** Конец периода вехи в миллисекундах: `YYYY-MM` → последний день месяца, `YYYY-MM-DD` → конец дня. */
export function deadlineOf(m: Milestone): number {
  const p = m.to.split('-').map(Number);
  const [y, mo, d] = [p[0] ?? 0, p[1] ?? 1, p[2]];
  return d ? Date.UTC(y, mo - 1, d, 23, 59, 59) : Date.UTC(y, mo, 0, 23, 59, 59);   // день 0 следующего месяца = последний день текущего
}

/**
 * Статус вехи. `active` — та, чей срок ещё не вышел и которая ближайшая среди незакрытых;
 * определяется на уровне списка, поэтому индекс передаётся снаружи.
 */
export function statusOf(m: Milestone, ctx: Ctx, isNext = false): Status {
  const { ratio, total } = milestoneProgress(m, ctx);
  if (total > 0 && ratio >= 1) return 'done';
  const now = ctx.now ?? Date.now();
  if (deadlineOf(m) < now) return 'overdue';
  return isNext ? 'active' : 'planned';
}

/** Индекс вехи, которая идёт сейчас: первая незакрытая. Ею подсвечиваем ленту и открываем вкладку. */
export function activeIndex(doc: RoadmapDoc, ctx: Ctx): number {
  const i = doc.milestones.findIndex((m) => {
    const { ratio, total } = milestoneProgress(m, ctx);
    return !(total > 0 && ratio >= 1);
  });
  return i < 0 ? Math.max(0, doc.milestones.length - 1) : i;
}

/** Подпись даты для ленты: `2026-11` → «ноя 26», `2028-01-24` → «24.01.28». */
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function shortDate(iso: string): string {
  const p = iso.split('-');
  const y = (p[0] ?? '').slice(2), mo = Number(p[1] ?? 1), d = p[2];
  if (d) return `${d}.${String(mo).padStart(2, '0')}.${y}`;
  return `${MONTHS[mo - 1] ?? '?'} ${y}`;
}

/** Уникальный id для новой вехи/пункта. Времени хватает: правки идут руками, не пачками. */
export const newId = (prefix: string): string => prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export const EMPTY_ROADMAP = (): RoadmapDoc => ({ milestones: [] });
