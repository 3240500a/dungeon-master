/**
 * СТОРОЖ ВИДОВ ГЕРОЯ против эталона Unity (`unity_stats.json`, генерит веб `progression/unityStatsGolden.gen.test.ts` с вывода настоящих
 * окон; та же копия — Unity `Assets/DM/UI/Tests/unity_stats_golden.json`, её читает `StatsCheck`). Разделы: derive, xp, hud, master,
 * sheet, tree, compare (bench — не наш). Сверка — как у `StatsCheck`: числа точно, объекты — множествами ключей (null ≡ нет), тексты листа
 * и подсказок — после той же нормализации (теги прочь, пробелы одним, края строк подрезаны, пустые строки выпадают).
 *
 * ⚠ ОТКЛОНЕНИЯ — правила сервера против веб-`GameState`/симулятора, с которых снят эталон. Каждое перечислено ниже поимённо и доказано:
 * тот же вид с прежним героем (`legacyHero` — веб `GameState`, карточка `model: 'sim'`) сходится с эталоном бит в бит, то есть расходится
 * ТОЛЬКО правило героя. Лишнее или пропавшее отклонение — провал.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConfigRegistry } from '../config/registry.js';
import type { ConfigKey } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import type { Item } from '../types/items.js';
import { DEFAULT_HP_MANA_SCALING } from '../types/attributes.js';
import { xpProgress } from '../formulas/xp.js';
import { craftWeapon, fullJournal, type CraftInput } from '../formulas/craft.js';
import { deriveStats, finalAttributes, modifiersFromItems } from '../formulas/stats.js';
import { armorClassModifiers } from '../formulas/resolveArmor.js';
import { passiveTreeModifiers, skillTreeModifiers } from '../formulas/skills.js';
import { reservedFrac, toggleBuffMods } from '../session/toggles.js';
import { gripOf, oneHandGrip } from '../formulas/versatile.js';
import { attackByType, attackWeaponsOf } from '../formulas/playerCombat.js';
import { playerSnapshot } from '../session/derive.js';
import type { DamageType } from '../types/combat.js';
import { offhandRefusal } from '../economy/townActions.js';
import {
  compareView, heroCalc, heroNumbers, hudView, masterBlock, sheetView, skillTreeView,
  type CardModel, type HeroCalc, type HeroFloor, type LastTarget, type PendingAttrs,
} from './hero.js';
import type { WeaponCard } from '../formulas/craftCard.js';

// ── эталон ─────────────────────────────────────────────────────────────────────────────────────────
type J = unknown;
interface GCase {
  name: string; save: SaveState; toggles: string[]; hp: number; mana: number; stamina: number;
  lastTarget?: LastTarget; area: 'town' | 'dungeon'; depth: number; difficultyId: string; challengeLevel: number | null;
  pending?: PendingAttrs; patch?: Record<string, unknown>;
}
interface Golden {
  config: Record<string, unknown>; cases: GCase[];
  derive: Record<string, J>[]; xp: { level: number; xp: number | null; table?: number[]; out: J }[];
  hud: Record<string, string>[]; master: string[]; sheet: { title?: string; rows: { cells: string[]; tip?: string }[] }[][];
  compare: { case: number; input: CraftInput; ok: boolean; crafted?: boolean; item?: Item; cards?: Record<string, J>; rows?: J[] }[];
  tree: { case: number; nodes: Record<string, J>[]; edges: Record<string, J>[]; labels: Record<string, J>[]; header: string }[];
}
// ⭐ С11: эталон листа героя заморожен рядом (выход веб-клиента на теге `web-client-final`) — регрессия вида сервера
const G = JSON.parse(readFileSync(new URL('./__fixtures__/unity_stats.json', import.meta.url), 'utf8')) as Golden;

/** Реестр конфига эталона (поверх встроенного) + таблицы случая (`patch` — капы класса брони и т.п.). */
function registry(patch?: Record<string, unknown>): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  r.reload({ ...G.config, ...(patch ?? {}) } as Partial<Record<ConfigKey, unknown>>, { cross: false });
  return r;
}
const BASE = registry();
const regs = G.cases.map((c) => (c.patch ? registry(c.patch) : BASE));
const floorOf = (c: GCase): HeroFloor => ({ area: c.area, depth: c.depth, difficultyId: c.difficultyId, challengeLevel: c.challengeLevel ?? null });

// ── сверка как у StatsCheck ────────────────────────────────────────────────────────────────────────
const isNull = (v: J): boolean => v === null || v === undefined;
function same(a: J, b: J): boolean {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  if (typeof a === 'number' || typeof b === 'number') return typeof a === 'number' && typeof b === 'number' && a === b;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const ka = Object.keys(a as object).filter((k) => !isNull((a as Record<string, J>)[k])).sort();
    const kb = Object.keys(b as object).filter((k) => !isNull((b as Record<string, J>)[k])).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, J>)[k], (b as Record<string, J>)[k]));
  }
  return a === b;
}
/** Текст для сверки: теги прочь, пробелы одним, строки подрезаны, пустые выпадают (`StatsCheck.Norm`). */
const norm = (s: string | undefined | null): string | undefined =>
  s == null ? undefined : s.replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l.length > 0).join('\n');
const normRow = (r: { cells: string[]; tip?: string }): { cells: (string | undefined)[]; tip?: string } =>
  ({ cells: r.cells.map(norm), ...(r.tip != null ? { tip: norm(r.tip) } : {}) });
const pct100 = (f: number): string => `${f * 100}%`;
const vitals = (c: GCase, h: HeroCalc): { hp: number; mana: number; stamina: number } =>
  ({ hp: Math.min(c.hp, h.derived.maxHp), mana: Math.min(c.mana, h.derived.maxMana), stamina: Math.min(c.stamina, h.derived.maxStamina) });

/**
 * Прежний герой — веб `GameState` с провайдерами `App` (с него снят эталон): сырое надетое (без `asHeld`), класс брони, мастерства, древо,
 * тоглы; без `skillTreeSetBonus`. Только оракул отклонений — сами виды считают героя сервера (`heroCalc`).
 */
function legacyHero(reg: ConfigRegistry, save: SaveState, toggles: string[]): HeroCalc {
  const eq = Object.values(save.equipment).filter(Boolean) as Item[];
  const passive = passiveTreeModifiers(reg.get('mastery-tree'), save.masteries), active = skillTreeModifiers(reg.get('skill-tree'), save.skills);
  const mods = [...modifiersFromItems(eq), ...armorClassModifiers(eq, reg.get('armor-classes')), ...passive, ...active, ...toggleBuffMods(reg, toggles)];
  const scaling = reg.get('classes').find((c) => c.id === save.classId)?.derived ?? DEFAULT_HP_MANA_SCALING;
  return {
    derived: deriveStats(save.attributes, mods, scaling, save.level, reg.get('balance').moveSpeedBase),
    effective: finalAttributes(save.attributes, mods), permanent: finalAttributes(save.attributes, [...passive, ...active]),
    reserveMana: reservedFrac(reg, toggles, 'mana'), reserveStamina: reservedFrac(reg, toggles, 'stamina'),
    mods, scaling, held: save.equipment.weapon,
  };
}

// ── виды случая → то, что сверяется ────────────────────────────────────────────────────────────────
function deriveOf(i: number, hero?: HeroCalc): J {
  const c = G.cases[i]!;
  return heroNumbers(regs[i]!, c.save, c.toggles, hero ? { hero } : {});
}
function hudOf(i: number, hero: HeroCalc): J {
  const c = G.cases[i]!;
  const m = hudView(regs[i]!, c.save, c.toggles, vitals(c, hero), floorOf(c), { hero });
  return { ...m, hp: pct100(m.hp), mana: pct100(m.mana), stam: pct100(m.stam), xp: pct100(m.xp), manaReserve: pct100(m.manaReserve), stamReserve: pct100(m.stamReserve) };
}
function masterOf(i: number, hero: HeroCalc): J {
  const c = G.cases[i]!;
  return norm(masterBlock(regs[i]!, c.save, c.toggles, { hero }));
}
function sheetOf(i: number, hero: HeroCalc): J {
  const c = G.cases[i]!;
  return sheetView(regs[i]!, c.save, c.toggles, vitals(c, hero), { hero, lastTarget: c.lastTarget ?? null, pending: c.pending })
    .map((b) => ({ title: b.title, rows: b.rows.map(normRow) }));
}
const goldenSheet = (i: number): J => G.sheet[i]!.map((b) => ({ title: b.title, rows: b.rows.map(normRow) }));

/** Карточки и строки «в руках → скую» записи эталона `x` героем `model` (`compareView`; края вилки — у несделанной вещи). */
function compareOf(x: Golden['compare'][number], model: CardModel): { cards: Record<string, WeaponCard | undefined>; rows: J } {
  const c = G.cases[x.case]!;
  const j = fullJournal(BASE);
  const edge = (at: 'lo' | 'hi'): Item | undefined => craftWeapon(BASE, x.input, { journal: j, materialsOn: true, at }).item;
  const v = compareView(BASE, c.save, x.item!, { toggles: c.toggles, model, ...(x.crafted ? {} : { edges: { lo: edge('lo'), hi: edge('hi') } }) });
  return { cards: { a: v.a, b: v.b, lo: v.lo, hi: v.hi }, rows: v.rows };
}
const compareWho = (x: Golden['compare'][number]): string => `${G.cases[x.case]!.name} ${x.input.weaponClass}/${x.input.hands}`;

// ── ожидаемые отклонения (правило сервера ≠ правило эталона) ──────────────────────────────────────────
/**
 * Карточки ковки: эталон считал героя МОДЕЛЬЮ СИМУЛЯТОРА (`makePlayerModel`) и клал оружие в руку, не трогая вторую. Сервер бьёт героем
 * `playerSnapshot` + рантайм-моды и оружием `attackWeaponsOf` (хват), а `equip` снимает вторую руку, которую новое оружие не терпит.
 * Причины (каждая — проверяемый факт записи, `reasonsOf`):
 *  • `тоглы` — включены ауры/стойки с модами (`toggleBuffMods`): сервер бьёт с ними, симулятор — без;
 *  • `класс брони` — надета броня со штрафом темпа (`armorClassModifiers` attackSpeed): симулятор его не знает;
 *  • `хват` — показано полуторное при щите: сервер держит его одной рукой (`asHeld`: урон ×0.88, темп ×0.92), эталон — двумя;
 *  • `вторая рука` — показан двуручник, а во второй руке щит/оружие: `equip` его снимет (`offhandRefusal`), эталон считал с ним (блок щита,
 *    темп дуала ×1.2).
 * Значение — `поля карточек и таблицы, что разошлись | причины`.
 */
const COMPARE_DEVIATIONS: Record<string, string> = {
  'warrior-geared sword/1': 'a,b,lo,hi,rows | тоглы,класс брони',
  'warrior-geared sword/2': 'a,b,rows | тоглы,класс брони,хват',
  'warrior-geared axe/1': 'a,b,lo,hi,rows | тоглы,класс брони',
  'warrior-geared axe/2': 'a,b,rows | тоглы,класс брони,вторая рука',
  'warrior-nocl staff/2': 'a,b,rows | тоглы,класс брони,вторая рука',
  'warrior-pending sword/1': 'a,b,lo,hi,rows | тоглы,класс брони',
  'warrior-pending sword/2': 'a,b,rows | тоглы,класс брони,хват',
  'mage bow/2': 'a,b,rows | тоглы',
  'vyuga-dual crossbow/2': 'b,rows | вторая рука',
};
/** Причины, по которым герой сервера в записи эталона `x` не равен модели симулятора (пусто — обязан сойтись бит в бит). */
function reasonsOf(x: Golden['compare'][number]): string[] {
  const c = G.cases[x.case]!, save = c.save, shown = x.item!;
  const eq = Object.values(save.equipment).filter(Boolean) as Item[];
  const off = save.equipment.offhand;
  const out: string[] = [];
  if (toggleBuffMods(BASE, c.toggles).length) out.push('тоглы');
  if (armorClassModifiers(eq, BASE.get('armor-classes')).some((m) => m.stat === 'attackSpeed')) out.push('класс брони');
  if (oneHandGrip({ ...save, equipment: { ...save.equipment, weapon: shown } }, shown) || oneHandGrip(save)) out.push('хват');
  if (off && offhandRefusal(off, shown) !== null) out.push('вторая рука');
  return out;
}

// ── тесты ──────────────────────────────────────────────────────────────────────────────────────────
describe('виды героя ≡ эталон unity_stats (правила сервера)', () => {
  it('derive: деривы, итоговые и свои атрибуты, резерв — бит в бит', () => {
    const bad: string[] = [];
    G.cases.forEach((c, i) => {
      const got = deriveOf(i) as Record<string, J>, want = G.derive[i]!;
      for (const k of Object.keys(want)) if (!same(got[k], want[k])) bad.push(`${c.name} ${k}`);
      expect(Object.keys((got.derived ?? {}) as object).length).toBe(Object.keys(want.derived as object).length);
    });
    expect(bad).toEqual([]);
  });

  it('xp: полоса опыта — xpProgress shared', () => {
    const bad = G.xp.filter((x) => !same(xpProgress(x.level, x.xp ?? Number.NaN, x.table ?? BASE.get('balance').xpTable), x.out));
    expect(bad).toEqual([]);
    expect(G.xp.length).toBeGreaterThan(30);
  });

  it('hud / master / sheet — бит в бит (после нормализации текста)', () => {
    const bad: string[] = [];
    G.cases.forEach((c, i) => {
      const hero = heroCalc(regs[i]!, c.save, c.toggles);
      if (!same(hudOf(i, hero), G.hud[i])) bad.push(`${c.name} hud: ${JSON.stringify(hudOf(i, hero))} ≠ ${JSON.stringify(G.hud[i])}`);
      if (!same(masterOf(i, hero), norm(G.master[i]))) bad.push(`${c.name} master`);
      const mine = sheetOf(i, hero) as { title?: string; rows: J[] }[], want = goldenSheet(i) as { title?: string; rows: J[] }[];
      if (mine.length !== want.length) bad.push(`${c.name} sheet: блоков ${mine.length} ≠ ${want.length}`);
      for (let b = 0; b < Math.min(mine.length, want.length); b++) {
        if (!same(mine[b]!.title, want[b]!.title)) bad.push(`${c.name} sheet[${b}] title ${mine[b]!.title} ≠ ${want[b]!.title}`);
        if (mine[b]!.rows.length !== want[b]!.rows.length) bad.push(`${c.name} sheet «${want[b]!.title}»: строк ${mine[b]!.rows.length} ≠ ${want[b]!.rows.length}`);
        for (let r = 0; r < Math.min(mine[b]!.rows.length, want[b]!.rows.length); r++) {
          if (!same(mine[b]!.rows[r], want[b]!.rows[r])) bad.push(`${c.name} sheet «${want[b]!.title}»[${r}]: ${JSON.stringify(mine[b]!.rows[r])} ≠ ${JSON.stringify(want[b]!.rows[r])}`);
        }
      }
    });
    expect(bad).toEqual([]);
  });

  it('tree: узлы, рёбра, подписи веток, шапка — бит в бит', () => {
    const bad: string[] = [];
    for (const x of G.tree) {
      const c = G.cases[x.case]!, who = `tree ${c.name}`;
      const m = skillTreeView(regs[x.case]!, c.save);
      if (m.header !== x.header) bad.push(`${who} header`);
      if (m.nodes.length !== x.nodes.length) bad.push(`${who}: узлов ${m.nodes.length} ≠ ${x.nodes.length}`);
      for (const w of x.nodes) {
        const mine = m.nodes.find((v) => v.x === w.x && v.y === w.y);
        if (!mine) { bad.push(`${who}: нет узла (${String(w.x)}, ${String(w.y)})`); continue; }
        const mj = { x: mine.x, y: mine.y, shape: mine.shape, size: mine.size, fill: mine.fill, stroke: mine.stroke, sw: mine.sw, tip: norm(mine.tip), rx: mine.rx };
        if (!same(mj, { ...w, tip: norm(w.tip as string) })) bad.push(`${who} node ${mine.id}: ${JSON.stringify(mj)} ≠ ${JSON.stringify(w)}`);
      }
      if (m.edges.length !== x.edges.length) bad.push(`${who}: рёбер ${m.edges.length} ≠ ${x.edges.length}`);
      m.edges.forEach((e, k) => { if (!same({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: e.stroke, sw: e.sw, op: e.op }, x.edges[k])) bad.push(`${who} edge[${k}]`); });
      if (m.labels.length !== x.labels.length) bad.push(`${who}: подписей ${m.labels.length} ≠ ${x.labels.length}`);
      m.labels.forEach((l, k) => { if (!same(l, x.labels[k])) bad.push(`${who} label[${k}]: ${JSON.stringify(l)} ≠ ${JSON.stringify(x.labels[k])}`); });
    }
    expect(bad).toEqual([]);
    expect(G.tree.length).toBe(6);
  });

  it('compare: карточки и таблица героем сервера — бит в бит, кроме перечисленных отклонений (с причинами)', () => {
    const got: Record<string, string> = {};
    for (const x of G.compare) {
      if (!x.ok) continue;
      const mine = compareOf(x, 'server');
      const diff = [...['a', 'b', 'lo', 'hi'].filter((k) => !same(mine.cards[k], x.cards![k])), ...(same(mine.rows, x.rows) ? [] : ['rows'])];
      const why = reasonsOf(x);
      if (diff.length || why.length) got[compareWho(x)] = `${diff.join(',')} | ${why.join(',')}`;
    }
    expect(got).toEqual(COMPARE_DEVIATIONS);
  });

  it('compare: отклонения — только правило героя (модель симулятора сходится с эталоном бит в бит)', () => {
    const bad: string[] = [];
    for (const x of G.compare) {
      if (!x.ok) continue;
      const mine = compareOf(x, 'sim');
      for (const k of ['a', 'b', 'lo', 'hi']) if (!same(mine.cards[k], x.cards![k])) bad.push(`${compareWho(x)} card ${k}: ${JSON.stringify(mine.cards[k])} ≠ ${JSON.stringify(x.cards![k])}`);
      if (!same(mine.rows, x.rows)) bad.push(`${compareWho(x)} rows: ${JSON.stringify(mine.rows)} ≠ ${JSON.stringify(x.rows)}`);
    }
    expect(bad).toEqual([]);
    expect(G.compare.filter((x) => x.ok).length).toBeGreaterThan(5);
  });

  it('прежний герой (веб GameState) тоже сходится — оракул отклонений цел', () => {
    const bad: string[] = [];
    G.cases.forEach((c, i) => {
      const hero = legacyHero(regs[i]!, c.save, c.toggles);
      if (!same(deriveOf(i, hero), G.derive[i])) bad.push(`${c.name} derive`);
      if (!same(hudOf(i, hero), G.hud[i])) bad.push(`${c.name} hud`);
      if (!same(sheetOf(i, hero), goldenSheet(i))) bad.push(`${c.name} sheet`);
    });
    expect(bad).toEqual([]);
  });
});

describe('правила сервера, которых эталон не задевает (ни один случай эталона их не включает)', () => {
  const c = G.cases.find((x) => x.name === 'warrior-geared')!;   // щит, латы ×5, аура + стойка, ЛКМ — базовый удар
  const scaling = BASE.get('balance').weaponAttrScaling, weights = BASE.get('weapon-weights');
  const lmb = (save: SaveState, h: HeroCalc): string =>
    sheetView(BASE, save, c.toggles, vitals(c, h), { hero: h }).find((b) => b.title === 'Наступление')!.rows[0]!.cells[1]!;

  it('полуторное со щитом: герой и удар листа — одноручным хватом (asHeld), как бьёт сервер', () => {
    const versatile = G.compare.find((x) => x.ok && x.item?.versatile)!.item!;
    const save: SaveState = { ...c.save, equipment: { ...c.save.equipment, weapon: versatile } };
    const srv = heroCalc(BASE, save, c.toggles), old = legacyHero(BASE, save, c.toggles);
    expect(srv.derived).toEqual(playerSnapshot(save, BASE, toggleBuffMods(BASE, c.toggles)).derived);
    expect(srv.derived.attackSpeed).toBeLessThan(old.derived.attackSpeed);
    expect(srv.held).toEqual(attackWeaponsOf(save, gripOf(BASE.get('balance').versatile))[0]);
    const bt = attackByType(srv.derived, srv.effective, srv.held, scaling, weights);
    const sum = (k: 'min' | 'max'): number => (Object.keys(bt) as DamageType[]).reduce((a, t) => a + bt[t][k], 0);
    expect(lmb(save, srv).startsWith(`${Math.round(sum('min'))}–${Math.round(sum('max'))} `)).toBe(true);
    expect(lmb(save, srv)).not.toBe(lmb(save, old));
  });

  it('сет-бонус древа (skillTreeSetBonus) — в итоговых и деривах, но не в «своих» атрибутах (он от гира)', () => {
    const tree = structuredClone(BASE.get('skill-tree'));
    const node = tree.nodes.find((n) => (c.save.skills[n.id] ?? 0) > 0 && !n.effect.active)!;
    node.effect.setBonus = { requireArmorClass: 'plate', minPieces: 4, mods: [{ stat: 'vitality', kind: 'flat', value: 2 }] };
    const reg = registry({ 'skill-tree': tree });
    const srv = heroNumbers(reg, c.save, c.toggles), old = legacyHero(reg, c.save, c.toggles);
    expect(srv.derived).toEqual(playerSnapshot(c.save, reg, toggleBuffMods(reg, c.toggles)).derived);
    expect(srv.effective.vitality).toBeGreaterThan(old.effective.vitality);
    expect(srv.derived.maxHp).toBeGreaterThan(old.derived.maxHp);
    expect(srv.permanent).toEqual(old.permanent);
  });

  it('рантайм-моды сессии (`runtimeMods`) заменяют моды тоглов, а не добавляются к ним', () => {
    const same1 = heroNumbers(BASE, c.save, c.toggles, { runtimeMods: toggleBuffMods(BASE, c.toggles) });
    expect(same1).toEqual(heroNumbers(BASE, c.save, c.toggles));
    const buffed = heroNumbers(BASE, c.save, c.toggles, { runtimeMods: [...toggleBuffMods(BASE, c.toggles), { stat: 'maxHp', kind: 'flat', value: 50 }] });
    expect(buffed.derived.maxHp).toBeGreaterThan(same1.derived.maxHp);
    expect(buffed.reserveMana).toBe(same1.reserveMana);
  });
});

describe('JSON видов = публичные поля C#-моделей (Newtonsoft, настройки по умолчанию)', () => {
  const FIELDS: Record<string, string[]> = {
    'DmStats.Hero': ['derived', 'effective', 'permanent', 'reserveMana', 'reserveStamina'],
    'DmSheet.HudModel': ['hp', 'mana', 'stam', 'xp', 'manaReserve', 'stamReserve', 'hpText', 'manaText', 'stamText', 'info'],
    'DmSheet.Block': ['title', 'rows'],
    'DmSheet.Row': ['cells', 'tip'],
    'DmStats.WeaponCard': ['hitMin', 'hitMax', 'hitAvg', 'aps', 'critChance', 'critMult', 'dps', 'attrBonus', 'block', 'interruptResist', 'knockdown', 'mass',
      'reqTotal', 'attackType', 'rangePx', 'arcDeg', 'area', 'status', 'requirements'],
    'DmStats.WeaponStatus': ['kind', 'name', 'baseChance', 'chance', 'rawChance', 'maxStacks', 'durationSec', 'avgStacks', 'capped'],
    'DmStats.CompareRow': ['cells', 'c3', 'c4'],
    'DmSkillTree.Model': ['nodes', 'edges', 'labels', 'header'],
    'DmSkillTree.NodeV': ['id', 'x', 'y', 'size', 'sw', 'rx', 'shape', 'fill', 'stroke', 'tip', 'alloc', 'avail', 'notable'],
    'DmSkillTree.EdgeV': ['a', 'b', 'x1', 'y1', 'x2', 'y2', 'sw', 'op', 'stroke'],
    'DmSkillTree.LabelV': ['x', 'y', 'anchor', 'fill', 'text'],
  };
  /** Ключи объекта ⊆ полей модели; чисел-не-чисел нет (NaN/∞ уйдут в провод как null — в `double` C# не встанут). */
  const check = (model: string, o: object, bad: string[]): void => {
    for (const [k, v] of Object.entries(o)) {
      if (!FIELDS[model]!.includes(k)) bad.push(`${model}.${k} — нет такого поля`);
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${model}.${k} = ${v}`);
    }
  };
  it('ключи и числа всех видов по всем случаям эталона', () => {
    const bad: string[] = [];
    G.cases.forEach((c, i) => {
      const reg = regs[i]!, hero = heroCalc(reg, c.save, c.toggles), live = vitals(c, hero);
      check('DmStats.Hero', heroNumbers(reg, c.save, c.toggles), bad);
      check('DmSheet.HudModel', hudView(reg, c.save, c.toggles, live, floorOf(c)), bad);
      for (const b of sheetView(reg, c.save, c.toggles, live, { lastTarget: c.lastTarget, pending: c.pending })) {
        check('DmSheet.Block', b, bad);
        for (const r of b.rows) check('DmSheet.Row', r, bad);
      }
      const t = skillTreeView(reg, c.save);
      check('DmSkillTree.Model', t, bad);
      t.nodes.forEach((n) => check('DmSkillTree.NodeV', n, bad));
      t.edges.forEach((e) => check('DmSkillTree.EdgeV', e, bad));
      t.labels.forEach((l) => check('DmSkillTree.LabelV', l, bad));
    });
    for (const x of G.compare) {
      if (!x.ok) continue;
      const v = compareOf(x, 'server');
      for (const card of Object.values(v.cards)) {
        if (!card) continue;
        check('DmStats.WeaponCard', card, bad);
        if (card.status) check('DmStats.WeaponStatus', card.status, bad);
      }
      for (const r of v.rows as object[]) check('DmStats.CompareRow', r, bad);
    }
    expect(bad).toEqual([]);
  });
});
