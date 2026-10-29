/**
 * ⭐ КАРТОЧКА ОРУЖИЯ И ТАБЛИЦА «В РУКАХ → СКУЮ» окна ковки — виды для клиента (C# `DmStats.CardWith` / `DmStats.CompareTable`, веб
 * `town/craftPanel.ts` cardWith / compareTable). Карточка — `weaponCard` (formulas/craftCard.ts) героя с подменённым оружием; таблица —
 * строки ячейками с цветами разницы (`c4`) и несбыточного требования (`c3`). Ключи = поля C# `WeaponCard`/`WeaponStatus`/`CompareRow`.
 *
 * ⚠ ГЕРОЙ КАРТОЧКИ. По умолчанию (`model: 'server'`) — тот, кем бьёт сервер: `playerSnapshot` (класс брони, сет-бонус древа, ауры и
 * стойки) и оружие «как держат» (`attackWeaponsOf` с живыми ручками `balance.versatile`: полуторное со щитом — одноручным хватом), темп
 * дуала ×1.2 — ровно `tryPlayerAttack`; вторая рука, которую новое оружие не терпит, снята, как её снимет `equip` (двуручник — щит и
 * второе оружие, полуторное — второе оружие). `model: 'sim'` — модель симулятора (`makePlayerModel`: гир + мастерства + древо, без класса
 * брони, сет-бонуса, аур и хвата) — так считал веб и C#; оставлена для сверки с эталоном и для прогонов баланса.
 */
import type { ConfigRegistry } from '../config/registry.js';
import type { SaveState } from '../types/save.js';
import type { StatModifier } from '../types/attributes.js';
import type { Item } from '../types/items.js';
import { playerSnapshot } from '../session/derive.js';
import { toggleBuffMods } from '../session/toggles.js';
import { attackWeaponsOf } from '../formulas/playerCombat.js';
import { gripOf } from '../formulas/versatile.js';
import { weaponCard, type WeaponCard } from '../formulas/craftCard.js';
import { makePlayerModel } from '../sim/playerBot.js';
import { offhandRefusal } from '../economy/townActions.js';

/** Чей герой держит оружие карточки: `server` — боевой снимок сервера (умолчание), `sim` — модель симулятора (прежний веб / C#). */
export type CardModel = 'server' | 'sim';
export interface CardOpts {
  /** Включённые ауры и стойки (их моды — в героя карточки). */
  toggles?: readonly string[];
  /** Рантайм-моды сессии целиком (тоглы + баффы) — вместо модов `toggles`. */
  runtimeMods?: StatModifier[];
  model?: CardModel;
}

/** ⭐ Замена `DmStats.CardWith`: карточка героя из сейва, в основной руке — `weapon` (нет — что надето). */
export function cardWith(cfg: ConfigRegistry, save: SaveState, weapon: Item | undefined, opts: CardOpts = {}): WeaponCard {
  const weights = cfg.get('weapon-weights');
  const scaling = cfg.get('balance').weaponAttrScaling;
  if (opts.model === 'sim') {
    const s: SaveState = weapon ? { ...save, equipment: { ...save.equipment, weapon } } : save;
    const m = makePlayerModel(cfg, s);
    return weaponCard(cfg, { derived: m.derived, attrs: m.attrs, weapon: s.equipment.weapon, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval });
  }
  const s = equippedWith(save, weapon);
  const snap = playerSnapshot(s, cfg, opts.runtimeMods ?? toggleBuffMods(cfg, opts.toggles ?? []));
  const hands = attackWeaponsOf(s, gripOf(cfg.get('balance').versatile));
  const attackInterval = 1 / Math.max(0.2, snap.derived.attackSpeed * (hands.length > 1 ? 1.2 : 1));
  return weaponCard(cfg, { derived: snap.derived, attrs: snap.attrs, weapon: hands[0], scaling, weights, attackInterval });
}

/**
 * Сейв «как после `equip`» оружия в основную руку: вторая рука, которую новое оружие не терпит (`offhandRefusal` — то же правило, что у
 * ядра: настоящий двуручник снимает и щит, полуторное — второе оружие), снимается. Нет `weapon` — сейв как есть.
 */
function equippedWith(save: SaveState, weapon: Item | undefined): SaveState {
  if (!weapon) return save;
  const equipment = { ...save.equipment, weapon };
  if (equipment.offhand && offhandRefusal(equipment.offhand, weapon) !== null) delete equipment.offhand;
  return { ...save, equipment };
}

// ── таблица «в руках → скую» ──────────────────────────────────────────────────────────────────────

/** = C# `DmStats.CompareRow`: ячейки (шапка/строка — 4, раздел и оговорка — 1); `c3` — цвет третьей, `c4` — четвёртой (разница). */
export interface CompareRow { cells: string[]; c3?: string; c4?: string }

/** Цвета окна (`ui/kit.ts` COLORS) — те же, что C# `DmStats.Good/Bad/Dim/Accent`. */
const COMPARE_COLORS = { good: '#8aa84a', bad: '#c85a48', dim: '#8f897c', accent: '#e39a3c' } as const;

const pct = (x: number, d = 0): string => `${(x * 100).toFixed(d)} %`;
const fx = (x: number, d = 1): string => x.toFixed(d);
const signed = (x: number, unit = '', d = 0): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;

/**
 * ⭐ Замена `DmStats.CompareTable`: шапка, «Удар» (у несделанной вещи — вилкой `range` низ…верх), геометрия взмаха (ближний бой), защита и
 * контроль, статусы граней, требования (не закрытое атрибутами сейва — `c3` красным).
 */
export function compareTable(a: WeaponCard, b: WeaponCard, aName: string, bName: string, save: SaveState, range?: { lo: WeaponCard; hi: WeaponCard }): CompareRow[] {
  const C = COMPARE_COLORS;
  const rows: CompareRow[] = [{ cells: ['', aName, bName, 'разница'], c3: C.accent, c4: C.dim }];
  const sec = (title: string): void => { rows.push({ cells: [title] }); };
  const line = (label: string, x: number | undefined, y: number | undefined, fmt: (v: number) => string, rel = true, better: 'up' | 'down' | 'none' = 'up', dfmt?: (d: number) => string): CompareRow => {
    let diff = '';
    let col: string = C.dim;
    if (x !== undefined && y !== undefined && Math.abs(y - x) > 1e-9) {
      diff = rel && Math.abs(x) > 1e-9 ? signed(((y - x) / Math.abs(x)) * 100, ' %') : dfmt ? dfmt(y - x) : signed(y - x, '', 2);
      if (better !== 'none') col = (y > x) === (better === 'up') ? C.good : C.bad;
    }
    const r: CompareRow = { cells: [label, x === undefined ? '—' : fmt(x), y === undefined ? '—' : fmt(y), diff], c4: col };
    rows.push(r);
    return r;
  };
  const rangeLine = (label: string, x: number, lo: number, hi: number, fmt: (v: number) => string): void => {
    const d = (y: number): number => (Math.abs(x) > 1e-9 ? ((y - x) / Math.abs(x)) * 100 : 0);
    rows.push({ cells: [label, fmt(x), `${fmt(lo)}–${fmt(hi)}`, `${signed(d(lo), '')}…${signed(d(hi), ' %')}`], c4: d(lo) > 0 ? C.good : d(hi) < 0 ? C.bad : C.dim });
  };
  const mid = (c: WeaponCard): number => (c.hitMin + c.hitMax) / 2;
  sec('Удар');
  if (range) rangeLine('урон за удар', mid(a), mid(range.lo), mid(range.hi), (v) => fx(v, 1));
  else line('урон за удар', mid(a), mid(b), (v) => fx(v, 1));
  const spread = line('разброс', undefined, undefined, fx);
  spread.cells[1] = `${fx(a.hitMin, 0)}–${fx(a.hitMax, 0)}`;
  const span = (lo: number, hi: number): string => (fx(lo, 0) === fx(hi, 0) ? fx(lo, 0) : `(${fx(lo, 0)}–${fx(hi, 0)})`);
  spread.cells[2] = range ? `${span(range.lo.hitMin, range.hi.hitMin)}–${span(range.lo.hitMax, range.hi.hitMax)}` : `${fx(b.hitMin, 0)}–${fx(b.hitMax, 0)}`;
  line('ударов в секунду', a.aps, b.aps, (v) => fx(v, 2));
  line('шанс крита', a.critChance, b.critChance, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  if (range) rangeLine('ДПС (формула)', a.dps, range.lo.dps, range.hi.dps, (v) => fx(v, 1));
  else line('ДПС (формула)', a.dps, b.dps, (v) => fx(v, 1));
  line('вклад атрибутов', a.attrBonus, b.attrBonus, (v) => fx(v, 1));
  if (a.attackType === 'melee' || b.attackType === 'melee') {
    sec('Геометрия взмаха');
    line('дальность, px', a.rangePx, b.rangePx, (v) => fx(v, 0), true, 'none');
    line('дуга, °', a.arcDeg, b.arcDeg, (v) => fx(v, 0), true, 'none');
    line('площадь сектора', a.area, b.area, (v) => `×${fx(v, 3)}`, true, 'none');
  }
  sec('Защита и контроль');
  line('блок', a.block, b.block, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  line('стойкость к прерыванию', a.interruptResist, b.interruptResist, (v) => pct(v, 0), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
  line('сбить с ног (цель 100)', a.knockdown, b.knockdown, (v) => pct(v, 2), false, 'up', (d) => signed(d * 100, ' п.п.', 2));
  line('масса оружия', a.mass, b.mass, (v) => fx(v, 0), false, 'none', (d) => signed(d, '', 0));
  const statusRows = (x: WeaponCard['status'], y: WeaponCard['status']): void => {
    const s = (y ?? x)!;
    sec(`Статус: ${s.name}`);
    line('шанс за попадание', x?.chance, y?.chance, (v) => pct(v, 1), false, 'up', (d) => signed(d * 100, ' п.п.', 1));
    line('средних стаков', x?.avgStacks, y?.avgStacks, (v) => `${fx(v, 2)} / ${s.maxStacks}`);
    if (s.capped) rows.push({ cells: [`⚠ шанс упёрся в потолок ${pct(s.chance, 0)}: прибавка к шансу сверх него не работает`] });
  };
  if (a.status && b.status && a.status.kind !== b.status.kind) { statusRows(a.status, undefined); statusRows(undefined, b.status); }
  else if (a.status || b.status) statusRows(a.status, b.status);
  sec('Требования');
  const reqLine = (k: 'strength' | 'dexterity' | 'intelligence', label: string): void => {
    const x = a.requirements[k], y = b.requirements[k];
    if (x === undefined && y === undefined) return;
    const r = line(label, x, y, (v) => `${v}`, false, 'down', (d) => signed(d, '', 0));
    if (y !== undefined && (save.attributes[k] ?? 0) < y) r.c3 = C.bad;
  };
  reqLine('strength', 'сила');
  reqLine('dexterity', 'ловкость');
  reqLine('intelligence', 'интеллект');
  line('сумма', a.reqTotal, b.reqTotal, (v) => `${v}`, false, 'down', (d) => signed(d, '', 0));
  return rows;
}

/** Блок «в руках → скую» целиком: карточки надетого (`a`) и показанного (`b`), края вилки несделанной вещи и строки таблицы. */
export interface CompareView { a: WeaponCard; b: WeaponCard; lo?: WeaponCard; hi?: WeaponCard; rows: CompareRow[] }

/**
 * ⭐ Замена `CraftPanel.CompareBox` (без вёрстки): `shown` — скованная или предпросмотр; `edges` — вещи краёв вилки при этой доводке
 * (`craftWeapon(..., { at: 'lo' | 'hi' })`; у уже скованной — нет).
 */
export function compareView(cfg: ConfigRegistry, save: SaveState, shown: Item, opts: CardOpts & { edges?: { lo?: Item; hi?: Item } } = {}): CompareView {
  const now = save.equipment.weapon;
  const a = cardWith(cfg, save, now, opts), b = cardWith(cfg, save, shown, opts);
  const lo = opts.edges?.lo ? cardWith(cfg, save, opts.edges.lo, opts) : undefined;
  const hi = opts.edges?.hi ? cardWith(cfg, save, opts.edges.hi, opts) : undefined;
  const range = lo && hi ? { lo, hi } : undefined;
  return { a, b, ...(range ?? {}), rows: compareTable(a, b, now?.name ?? 'без оружия', shown.name, save, range) };
}
