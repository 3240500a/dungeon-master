/**
 * ⭐ 17.10 (Артбук): ЧИСТЫЕ ПОМОЩНИКИ РОСТЕРОВ ПО ЯРУСАМ (v2) — подписи ярусов и боя, поиск карточки по id, сводка пометок
 * «механика держится на» и счёты вида «Ростер и очерёдность». Без DOM → node-тесты (`roster.test.ts`).
 *
 * Сводка пометок — тем же правилом, что генератор документа (`gen_roster.py`, `mech_summary`): `[есть]` → «есть»; `[легко…]`,
 * новые вещи гира (`u-…`* — предмета ещё нет в `monster-gear`) и коды ценой «мелко» → «легко»; прочие коды К1–К23 → «на будущее»
 * с ценой. Цены — из «Рычагов движка» черновика (`crypt.engine.codes`), а не своей таблицей: правка цены там — правка сводки здесь.
 */
import { rosterQueue, type CombatKind, type PowerTier, type RosterBoss, type RosterCard, type RosterQueue, type RosterSpecial, type RosterTier, type RosterV2, type TierId, type DamageMults } from './seed.js';

export const TIER_IDS: readonly TierId[] = ['light', 'medium', 'heavy'];
export const TIER_RU: Record<TierId, string> = { light: 'лёгкий', medium: 'средний', heavy: 'тяжёлый' };
export const TIER_TITLE: Record<TierId, string> = { light: 'Лёгкий', medium: 'Средний', heavy: 'Тяжёлый' };
/** Ярус = тир силы (решение владельца 17.10). */
export const TIER_POWER: Record<TierId, PowerTier> = { light: 'weak', medium: 'medium', heavy: 'strong' };
export const COMBAT_RU: Record<CombatKind, string> = { melee: 'ближний', ranged: 'стрелок', support: 'поддержка' };
/** Классы брони игры (кираса — латы, бригантина и ламелляр — сегментная). */
export const ARMOR_RU: Record<string, string> = { quilted: 'стёганая', leather: 'кожа', chain: 'кольчуга', segmented: 'сегментная', plate: 'латы' };
export const ARMOR_ORDER = ['quilted', 'leather', 'chain', 'segmented', 'plate'] as const;
export const DMG_RU: Record<string, string> = { slashing: 'режущий', piercing: 'колющий', crushing: 'дробящий', lightning: 'молния' };
/** Статус удара по id физ-подтипа (у особого в ростере — id, у оружия карточки — ещё и имя). */
export const STATUS_RU: Record<string, string> = { daze: 'Ошеломление', wound: 'Рана', bleed: 'Кровотечение', sunder: 'Увечье', poison: 'Отравление', burn: 'Поджиг' };
/** Сила статуса у подтипа: родной ×1.25, второй ×1.0, чужой ×0.8 (решение владельца 16.10 — стартовые значения, живут в данных). */
export function statusMult(r: Pick<RosterV2, 'rules'>, statusName: string): number {
  const st = r.rules.statuses;
  return statusName === st.native.status ? st.native.mult : statusName === st.second.status ? st.second.mult : st.foreign.mult;
}
/** Множитель как в документе: ×1.25, ×1.0, ×0.8. */
export const fmtMult = (m: number): string => `×${Number.isInteger(m) ? m.toFixed(1) : String(m)}`;

/** Босс по этажу круга: лёгкий — 5, средний — 14, актовый — 19. */
export const BOSS_LABEL: Record<number, string> = { 5: 'лёгкий', 14: 'средний', 19: 'актовый' };

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n));
  if (a % 10 === 1 && a % 100 !== 11) return one;
  if (a % 10 >= 2 && a % 10 <= 4 && !(a % 100 >= 12 && a % 100 <= 14)) return few;
  return many;
}

/** Броня яруса по карточкам: «стёганая 3, кожа 2» (порядок — от лёгкой к латам). */
export function armorMix(cards: readonly Pick<RosterCard, 'armorClass'>[]): string {
  const cnt = new Map<string, number>();
  for (const c of cards) cnt.set(c.armorClass, (cnt.get(c.armorClass) ?? 0) + 1);
  const known = ARMOR_ORDER.filter((a) => cnt.has(a)).map((a) => `${ARMOR_RU[a]} ${cnt.get(a)}`);
  const other = [...cnt.keys()].filter((a) => !(ARMOR_ORDER as readonly string[]).includes(a)).map((a) => `${a} ${cnt.get(a)}`);
  return [...known, ...other].join(', ');
}

/** Стойкость яруса словами: «режущий ×0.75, колющий ×0.85…»; пусто — «без стойкости». */
export function resistText(m: DamageMults | undefined): string {
  const parts = Object.entries(m ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${DMG_RU[k] ?? k} ×${v}`);
  return parts.length ? parts.join(', ') : 'без стойкости';
}

// ── Карточка по id ───────────────────────────────────────────────────────────────────────────────

export type EntryKind = 'card' | 'boss' | 'special';

/** Карточка ростера: боец яруса, босс или особый. `path` — от корня ростера (`tiers/light/cards/<id>`), для путей правки. */
export type RosterEntry =
  | { kind: 'card'; id: string; name: string; tier: TierId; path: string; card: RosterCard; tierRow: RosterTier }
  | { kind: 'boss'; id: string; name: string; tier: TierId; path: string; boss: RosterBoss }
  | { kind: 'special'; id: string; name: string; tier: TierId; path: string; special: RosterSpecial };

/** Все карточки ростера по порядку: ярусы (по карточкам), боссы по этажу, особые (первая волна раньше второй). */
export function rosterEntries(r: RosterV2): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const t of r.tiers) for (const c of t.cards) out.push({ kind: 'card', id: c.id, name: c.name, tier: t.id, path: `tiers/${t.id}/cards/${c.id}`, card: c, tierRow: t });
  for (const b of [...r.bosses].sort((x, y) => x.floor - y.floor)) out.push({ kind: 'boss', id: b.id, name: b.name, tier: b.tier, path: `bosses/${b.id}`, boss: b });
  for (const s of [...r.specials].sort((x, y) => x.wave - y.wave)) out.push({ kind: 'special', id: s.id, name: s.name, tier: s.tier, path: `specials/${s.id}`, special: s });
  return out;
}

export const rosterEntry = (r: RosterV2, id: string): RosterEntry | undefined => rosterEntries(r).find((e) => e.id === id);

// ── «Механика держится на» ───────────────────────────────────────────────────────────────────────

export interface EngineCode { code: string; cost: string }
export interface MechSummary {
  /** Есть пометка `[есть]`. */
  have: boolean;
  /** «легко»: новые вещи гира, коды ценой «мелко», или просто «данные». */
  easy: string[];
  /** «на будущее»: коды с ценой — `К8 (крупно)`. */
  future: string[];
  /** Строкой, как в таблице документа: `есть · легко: новые вещи `u-buckler` · на будущее: К9 (крупно)`. */
  text: string;
}

const K_RE = /К(\d{1,2})/g;
const STAR_RE = /`(u-[a-z0-9-]+)`\*/g;
/** Цена кода коротко: «средне (дни)» → «средне». */
const shortCost = (cost: string): string => cost.replace(/\s*\([^)]*\)\s*$/, '').trim();

export function mechSummary(text: string, codes: readonly EngineCode[], extraNew: readonly string[] = []): MechSummary {
  const cost = new Map(codes.map((c) => [c.code, c.cost]));
  const have = /\[есть/.test(text);
  const hasEasy = /\[легко/.test(text);
  const ks = [...new Set([...text.matchAll(K_RE)].map((m) => Number(m[1])))].filter((k) => cost.has(`К${k}`)).sort((a, b) => a - b);
  const fresh: string[] = [];
  for (const g of [...extraNew, ...[...text.matchAll(STAR_RE)].map((m) => m[1]!)]) if (!fresh.includes(g)) fresh.push(g);
  const isEasy = (k: number): boolean => (cost.get(`К${k}`) ?? '').startsWith('мелко');
  const easy: string[] = [];
  if (fresh.length) easy.push('новые вещи ' + fresh.map((g) => `\`${g}\``).join(', '));
  easy.push(...ks.filter(isEasy).map((k) => `К${k}`));
  if (hasEasy && !easy.length) easy.push('данные');
  const future = ks.filter((k) => !isEasy(k)).map((k) => `К${k} (${shortCost(cost.get(`К${k}`)!)})`);
  const parts = [...(have ? ['есть'] : []), ...(easy.length ? ['легко: ' + easy.join(', ')] : []), ...(future.length ? ['на будущее: ' + future.join(', ')] : [])];
  return { have, easy, future, text: parts.length ? parts.join(' · ') : 'данные' };
}

/** Текст карточки, по которому собирается сводка: приём, броня, шлем, щит; новая вещь — оружие со звёздочкой. */
export const cardMechText = (c: RosterCard): string => [c.move, c.armor, c.helm, c.shield].join(' ');
export const cardNewGear = (c: RosterCard): string[] => (c.weapon.gear.endsWith('*') ? [c.weapon.gear.slice(0, -1)] : []);

export function entryMech(e: RosterEntry, codes: readonly EngineCode[]): MechSummary {
  if (e.kind === 'card') return mechSummary(cardMechText(e.card), codes, cardNewGear(e.card));
  if (e.kind === 'boss') return mechSummary([...e.boss.fight, e.boss.mvp, e.boss.hall].join(' '), codes);
  return mechSummary(`${e.special.mechanic} ${e.special.telegraph}`, codes);
}

// ── Счёты «Ростера и очерёдности» ────────────────────────────────────────────────────────────────

export interface QueueCounts {
  /** Строк в каждой очереди (`q1`, `q2`, `q3`, `bank`). */
  byQueue: Record<string, number>;
  /** Состав очередей: карточки ярусов, боссы (этажи), особые. */
  cards: Record<string, number>;
  bossFloors: Record<string, number[]>;
  specials: Record<string, number>;
  bankBosses: number;
  bankIdeas: number;
  /** В работе — всё, кроме банка идей. */
  inWork: number;
}

export function queueCounts(r: RosterV2, queues: readonly RosterQueue[]): QueueCounts {
  const rows = rosterQueue(r, queues);
  const out: QueueCounts = { byQueue: {}, cards: {}, bossFloors: {}, specials: {}, bankBosses: r.ideaBank.bosses.length, bankIdeas: r.ideaBank.ideas.length, inWork: 0 };
  for (const q of queues) { out.byQueue[q.id] = 0; out.cards[q.id] = 0; out.bossFloors[q.id] = []; out.specials[q.id] = 0; }
  for (const x of rows) {
    out.byQueue[x.queue] = (out.byQueue[x.queue] ?? 0) + 1;
    if (x.kind === 'card') out.cards[x.queue] = (out.cards[x.queue] ?? 0) + 1;
    else if (x.kind === 'special') out.specials[x.queue] = (out.specials[x.queue] ?? 0) + 1;
    else if (x.kind === 'boss') (out.bossFloors[x.queue] ??= []).push(r.bosses.find((b) => b.id === x.id)!.floor);
    if (!queues.find((q) => q.id === x.queue)?.bank) out.inWork++;
  }
  return out;
}

/**
 * Ячейка счёта очереди, как в документе: «10», «6 (5 + босс 5)», «8 (2 босса + 6 особых)», «13 (2 босса + 11 идей)».
 * Очередь из одних карточек ярусов — просто число.
 */
export function queueCell(c: QueueCounts, q: RosterQueue): string {
  const n = c.byQueue[q.id] ?? 0;
  if (q.bank) return `${n} (${c.bankBosses} ${plural(c.bankBosses, 'босс', 'босса', 'боссов')} + ${c.bankIdeas} ${plural(c.bankIdeas, 'идея', 'идеи', 'идей')})`;
  const cards = c.cards[q.id] ?? 0, floors = c.bossFloors[q.id] ?? [], sp = c.specials[q.id] ?? 0;
  if (!floors.length && !sp) return String(n);
  const parts: string[] = [];
  if (cards) parts.push(String(cards));
  if (floors.length === 1 && !sp) parts.push(`босс ${floors[0]}`);
  else if (floors.length) parts.push(`${floors.length} ${plural(floors.length, 'босс', 'босса', 'боссов')}`);
  if (sp) parts.push(`${sp} ${plural(sp, 'особый', 'особых', 'особых')}`);
  return `${n} (${parts.join(' + ')})`;
}

/** Итого по подтипам: сумма строк очереди; у «3 · потом» и банка — состав («47 (12 боссов + 35 особых)»). */
export function queueTotalCell(all: readonly QueueCounts[], q: RosterQueue): string {
  const n = all.reduce((s, c) => s + (c.byQueue[q.id] ?? 0), 0);
  if (q.bank) {
    const b = all.reduce((s, c) => s + c.bankBosses, 0), i = all.reduce((s, c) => s + c.bankIdeas, 0);
    return `${n} (${b} ${plural(b, 'босс', 'босса', 'боссов')} + ${i} ${plural(i, 'идея', 'идеи', 'идей')})`;
  }
  const sp = all.reduce((s, c) => s + (c.specials[q.id] ?? 0), 0);
  if (!sp) return String(n);
  const b = all.reduce((s, c) => s + (c.bossFloors[q.id]?.length ?? 0), 0);
  return `${n} (${b} ${plural(b, 'босс', 'босса', 'боссов')} + ${sp} ${plural(sp, 'особый', 'особых', 'особых')})`;
}

/**
 * ⭐ 22.10: промт Nano Banana карточки — первый абзац: общий стиль + фон подтипа; второй: описание карточки; последняя строка —
 * общая концовка. Пустые части пропускаются; нет описания карточки — `''` (копировать нечего). Формат и размер картинки в промт
 * не пишем — их ставят в настройках генератора (решение владельца 22.10).
 */
export function promptOf(parts: { style?: string; backdrop?: string; card?: string; close?: string }): string {
  const t = (s?: string): string => (s ?? '').trim();
  if (!t(parts.card)) return '';
  return [[t(parts.style), t(parts.backdrop)].filter(Boolean).join(' '), t(parts.card), t(parts.close)].filter(Boolean).join('\n\n');
}
