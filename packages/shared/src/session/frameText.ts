/**
 * ⭐⭐ i18n Ф2 (06.11): ЗАПЕЧЁННЫЕ ИМЕНА В КАДРАХ — на языке получателя.
 *
 * Ф1 научила сервер собирать на языке игрока всё, что он СОБИРАЕТ (виды, отказы, подписи). Но часть текста кадров не собирается, а
 * ЛЕЖИТ: имя вещи (`Item.name` — испечено при рождении), имя монстра (`ScaledMonster.name` — при генерации), имя и описание задания
 * (`QuestDef` — при сборке доски, уезжает в сейв). Печать трогать нельзя — испечённое на английском уехало бы в сейв русского. Поэтому
 * переводится ПОКАЗ: кадр перед отправкой проходит здесь, и каждое такое имя пересобирается из данных на языке области — со сверкой с
 * испечённым (не сошлось — испечённое как есть, см. `itemDisplayName`).
 *
 * ⚠ Язык-источник — ТОТ ЖЕ объект кадра, без единой копии: русский провод побайтово прежний, и горячий путь русской комнаты не платит
 * ничего (сервер к тому же зовёт это только при иноязычном получателе).
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { Item } from '../types/items.js';
import type { QuestDef } from '../types/quest.js';
import { HIT_BY_BLAST, HIT_BY_ENEMY, type SessionEvent } from './session.js';
import type { ServerFrame } from './netTypes.js';
import type { WorldDelta } from './delta.js';
import { Localizer, SOURCE_LANG, cfgRowTextWith, textLocalizer, tr } from '../i18n/index.js';
import { isItemLike, localizeItem } from '../formulas/itemDisplay.js';
import { boardQuestText } from '../economy/questLogic.js';

const SRC = new Localizer(undefined, SOURCE_LANG);
/** Язык области, если он не источник; иначе `null` — переводить нечего. */
const foreign = (): Localizer | null => {
  const loc = textLocalizer();
  return loc && loc.lang !== SOURCE_LANG ? loc : null;
};

// ── монстры ─────────────────────────────────────────────────────────────────────────────────────

/** Что нужно от определения монстра, чтобы пересобрать имя: заготовка (`id`), испечённое имя, редкость, аффиксы. */
export interface MonsterNameSrc { id: string; name: string; rarity?: string; affixes?: readonly string[] }

/**
 * ⭐ ИМЯ МОНСТРА на языке области. Рецепты — те, которыми его печёт `generateMonster`: уник — имя из пула (`monster-uniques`) или
 * «Уникальный <база>»; магический и редкий — слово первого префикса + база + слово первого суффикса (`monsterAffixName`); иначе база.
 * Сверка с испечённым — как у вещей: не сошлось ни одно — испечённое.
 */
export function monsterDisplayName(reg: ConfigRegistry, def: MonsterNameSrc): string {
  const loc = foreign();
  if (!loc) return def.name;
  try {
    const row = reg.get('monsters').find((m) => m.id === def.id);
    if (!row) return def.name;
    const base = (L: Localizer): string => cfgRowTextWith(L, reg, 'monsters', row);
    const recipes: Array<(L: Localizer) => string> = [];
    if (def.rarity === 'unique') {
      const u = reg.get('monster-uniques').find((x) => x.name === def.name);
      if (u) recipes.push((L) => cfgRowTextWith(L, reg, 'monster-uniques', u));
      recipes.push((L) => (L === SRC ? `Уникальный ${base(L)}` : tr('srv:monster.uniqueOf', 'Уникальный {name}', { name: base(L) })));
    }
    if (def.affixes?.length) {
      const tables = [reg.get('monster-item-affixes'), reg.get('affixes')] as const;
      const word = (kind: 'prefix' | 'suffix'): { row: object; table: 'monster-item-affixes' | 'affixes'; word: string } | undefined => {
        for (const id of def.affixes!) {
          for (const [i, t] of tables.entries()) {
            const a = t.find((x) => x.id === id);
            if (a) { if (a.kind === kind) return a.word ? { row: a, table: i === 0 ? 'monster-item-affixes' : 'affixes', word: a.word } : undefined; break; }
          }
        }
        return undefined;
      };
      const pre = word('prefix'), suf = word('suffix');
      if (pre || suf) {
        recipes.push((L) => {
          const w = (x: typeof pre): string => (x ? cfgRowTextWith(L, reg, x.table, x.row, 'word') : '');
          // печать — склейка пробелом, как `monsterAffixName`; показ — шаблон D2-магии языка (порядок слов — данные языка)
          return L === SRC ? [w(pre), base(L), w(suf)].filter(Boolean).join(' ') : L.name('item.magic', { prefix: w(pre), base: base(L), suffix: w(suf) });
        });
      }
    }
    recipes.push(base);
    for (const r of recipes) if (r(SRC) === def.name) return r(loc) || def.name;
  } catch {
    /* показ имени не вправе уронить кадр */
  }
  return def.name;
}

/** Определение монстра по ИСПЕЧЁННОМУ имени (`by` удара): комната ищет среди монстров этажа; нет такого — `undefined`. */
export type MonsterByName = (name: string) => MonsterNameSrc | undefined;

/**
 * ⭐ i18n (07.11, хвосты Ф1): ИМЯ НАПАДАЮЩЕГО (`hit.by` удара по герою) на языке области. Сессия кладёт туда испечённое имя монстра, «Враг»
 * (снаряд без имени стрелка) или «<имя> (взрыв)» (конструкт), а в PvP — id игрока. Имя монстра узнаётся по определению (`lookup`: монстры,
 * умершие в той же пачке событий, и монстры этажа комнаты) и пересобирается `monsterDisplayName` (со сверкой); хвост взрыва — шаблоном
 * `srv:monster.blast`. Не узнано (id игрока, чужое имя) — как есть. Источник — как есть всегда.
 */
export function hitByDisplay(reg: ConfigRegistry, by: string, lookup: MonsterByName): string {
  if (!foreign()) return by;
  if (by === HIT_BY_ENEMY) return tr('srv:monster.enemy', HIT_BY_ENEMY);
  const def = lookup(by);
  if (def) return monsterDisplayName(reg, def);
  if (by.endsWith(HIT_BY_BLAST)) {
    const base = lookup(by.slice(0, -HIT_BY_BLAST.length));
    if (base) return tr('srv:monster.blast', '{name} (взрыв)', { name: monsterDisplayName(reg, base) });
  }
  return by;
}

/** Снаряжение монстра словами (`gearRolls[].name` — имя вещи `monster-gear`, у кулаков — своё). */
function gearName(reg: ConfigRegistry, g: { gearId?: string; name: string }): string {
  if (g.gearId === '__fists' && g.name === 'кулаки') return tr('srv:monster.fists', 'кулаки');
  const row = g.gearId !== undefined ? reg.get('monster-gear').find((x) => x.id === g.gearId) : undefined;
  return row && row.name === g.name ? cfgRowTextWith(foreign(), reg, 'monster-gear', row) : g.name;
}

/** Определение монстра для провода (`monsterInfo`, `monster-died`) на языке области: имя и снаряжение; источник — сам объект. */
export function localizeMonsterDef<T extends MonsterNameSrc & { gearRolls?: { slot: string; gearId?: string; name: string }[] }>(reg: ConfigRegistry, def: T): T {
  if (!foreign()) return def;
  const name = monsterDisplayName(reg, def);
  const gear = def.gearRolls?.map((g) => { const n = gearName(reg, g); return n === g.name ? g : { ...g, name: n }; });
  const gearChanged = !!gear && gear.some((g, i) => g !== def.gearRolls![i]);
  if (name === def.name && !gearChanged) return def;
  return { ...def, name, ...(gearChanged ? { gearRolls: gear } : {}) };
}

// ── задания ─────────────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ ЗАДАНИЕ на языке области: с доски — рецептом доски (`boardQuestText`), из цепочки — текстом строки `quests.main` (если испечённое
 * совпадает с данными). Прочее и источник — сам объект.
 */
export function questDisplay(reg: ConfigRegistry, def: QuestDef): QuestDef {
  const loc = foreign();
  if (!loc) return def;
  const board = boardQuestText(def);
  if (board) return board.name === def.name && board.description === def.description ? def : { ...def, ...board };
  const row = reg.get('quests.main').find((q) => q.id === def.id) as (QuestDef & object) | undefined;
  if (!row) return def;
  const name = row.name === def.name ? cfgRowTextWith(loc, reg, 'quests.main', row) : def.name;
  const description = row.description === def.description ? cfgRowTextWith(loc, reg, 'quests.main', row, 'description') : def.description;
  return name === def.name && description === def.description ? def : { ...def, name, description };
}

const isQuestDefLike = (v: Record<string, unknown>): boolean =>
  typeof v.id === 'string' && typeof v.name === 'string' && typeof v.description === 'string' && Array.isArray(v.objectives) && typeof v.reward === 'object';

// ── обход значения ──────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ ЛЮБОЕ ЗНАЧЕНИЕ КАДРА на языке области: каждая вещь (узнаётся по виду — `isItemLike`) и каждое определение задания внутри — с
 * показанным именем. Копируется только путь до изменённого; не изменилось ничего (и всегда на источнике) — тот же объект.
 */
export function localizeDeep<T>(reg: ConfigRegistry, value: T): T {
  if (!foreign()) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      for (let i = 0; i < v.length; i++) {
        const w = walk(v[i]);
        if (w !== v[i]) { out ??= v.slice(); out[i] = w; }
      }
      return out ?? v;
    }
    if (v === null || typeof v !== 'object') return v;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    if (isItemLike(v)) return localizeItem(reg, v as Item);
    const o = v as Record<string, unknown>;
    if (isQuestDefLike(o)) return questDisplay(reg, o as unknown as QuestDef);
    let out: Record<string, unknown> | undefined;
    for (const k of Object.keys(o)) {
      const w = walk(o[k]);
      if (w !== o[k]) { out ??= { ...o }; out[k] = w; }
    }
    return out ?? v;
  };
  return walk(value) as T;
}

/**
 * ⭐ СОБЫТИЯ ТИКА на языке области: вещь выпала/поднята — её имя, смерть монстра — его имя, задание — его имя (`questOf` — определение
 * по id: доска комнаты и журнал героя; нет — испечённое). ⭐ 07.11: удар по герою — имя нападающего (`hitByDisplay`): монстр узнаётся по
 * испечённому имени среди умерших в этой же пачке и через `monsterOf` (монстры этажа комнаты); id игрока (PvP) — как есть.
 */
export function localizeEvents(reg: ConfigRegistry, events: readonly SessionEvent[], questOf?: (questId: string) => QuestDef | undefined,
  monsterOf?: MonsterByName): SessionEvent[] {
  if (!foreign()) return events as SessionEvent[];
  let out: SessionEvent[] | undefined;
  let died: Map<string, MonsterNameSrc> | undefined;
  const lookup: MonsterByName = (name) => {
    if (!died) { died = new Map(); for (const x of events) if (x.type === 'monster-died' && !died.has(x.def.name)) died.set(x.def.name, x.def); }
    return died.get(name) ?? monsterOf?.(name);
  };
  events.forEach((e, i) => {
    let next: SessionEvent = e;
    if (e.type === 'item-dropped' || e.type === 'item-picked') { const it = localizeItem(reg, e.item); if (it !== e.item) next = { ...e, item: it }; }
    else if (e.type === 'monster-died') { const d = localizeMonsterDef(reg, e.def); if (d !== e.def) next = { ...e, def: d }; }
    else if (e.type === 'hit') { if (e.target === 'player' && e.by) { const by = hitByDisplay(reg, e.by, lookup); if (by !== e.by) next = { ...e, by }; } }
    else if (e.type === 'quest') {
      const def = questOf?.(e.questId);
      if (def && def.name === e.name) { const n = questDisplay(reg, def).name; if (n !== e.name) next = { ...e, name: n }; }
    }
    if (next !== e) { out ??= events.slice(); out[i] = next; }
  });
  return out ?? (events as SessionEvent[]);
}

/**
 * ⭐ ДЕЛЬТА / ПОЛНЫЙ КАДР МИРА на языке области: в нём текста нет, кроме вещей ВНОВЬ показанной добычи (`du`). Нет таких вещей — тот же
 * объект (кадр кодируется один раз на всю комнату); есть — копия с переименованными вещами (кодируется раз на язык).
 */
export function localizeDelta(reg: ConfigRegistry, delta: WorldDelta): WorldDelta {
  if (!foreign() || !delta.du?.length) return delta;
  let du: NonNullable<WorldDelta['du']> | undefined;
  delta.du.forEach((d, i) => {
    if (d.kind !== 'item') return;
    const it = localizeItem(reg, d.item);
    if (it !== d.item) { du ??= delta.du!.slice(); du[i] = { ...d, item: it }; }
  });
  return du ? { ...delta, du } : delta;
}

/** Кадры, в которых лежат запечённые имена (вещи, задания, монстры) — им нужен проход `localizeFrame` на иноязычного получателя. */
export const NAMED_FRAMES: ReadonlySet<ServerFrame['t']> = new Set<ServerFrame['t']>([
  'joined', 'saveUpdate', 'shop', 'stash', 'questBoard', 'events', 'monsterInfo', 'view', 'hero',
]);

/**
 * ⭐⭐ КАДР ДЛЯ ПОЛУЧАТЕЛЯ на языке области: вещи сейва, сундука, прилавка, видов и событий — с показанными именами, задания — с
 * переведёнными именами и описаниями, монстры — с именами. `questOf` — определение задания по id для событий, `monsterOf` — монстр по
 * испечённому имени (имя нападающего в ударе по герою). Источник — тот же кадр.
 */
export function localizeFrame(reg: ConfigRegistry, frame: ServerFrame, questOf?: (questId: string) => QuestDef | undefined,
  monsterOf?: MonsterByName): ServerFrame {
  if (!foreign() || !NAMED_FRAMES.has(frame.t)) return frame;
  switch (frame.t) {
    case 'events': { const events = localizeEvents(reg, frame.events, questOf, monsterOf); return events === frame.events ? frame : { ...frame, events }; }
    case 'monsterInfo': {
      let changed = false;
      const monsters = frame.monsters.map((m) => { const def = localizeMonsterDef(reg, m.def); if (def === m.def) return m; changed = true; return { ...m, def }; });
      return changed ? { ...frame, monsters } : frame;
    }
    default: return localizeDeep(reg, frame);
  }
}
