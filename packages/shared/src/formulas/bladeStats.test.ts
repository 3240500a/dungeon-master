import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  axisOf, balanceAxisOf, balanceOfBlade, bladeCaption, bladeFormOf, bladeStats, bladeStatsOf, bracketOf, lengthPlace,
  spreadOfWidth, strikeAxisOf, suggestBracket, suggestForm, type BladeBracket, type BladeTuning,
} from './bladeStats.js';
import {
  anatomyOf, bakeParts, clampStep, craftSalvageYield, craftTiers, craftWeapon, defaultParts, emptyJournal, keyVariantsByBase,
  materialId, partById, partFamily, partsOf, salvageIntoJournal, shapeFoundWeapon, shapeOfBake, statusKindOf, tierIndexOfItem,
  tierIndex, tierOfSteps, typeOfItem, variantsFor, type CraftInput,
} from './craft.js';
import { CRAFT_SLOT_LIST, baseOfKeyPart, tagValue, type PartSet, type WeaponPart } from './craftType.js';
import { bakedExtras, fixedBaseRoll, generateItem, retierItem, rollBaseQ, scaleBaseStats, shapedBaseStats, shapeOfItem } from './itemgen.js';
import { weaponSpeedOf } from './itemDescribe.js';
import { weaponCard } from './craftCard.js';
import { makePlayerModel, newBotSave } from '../sim/playerBot.js';
import { upgradedItem } from '../economy/townActions.js';
import { scoreItem } from '../sim/economy.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { createRng } from './rng.js';
import type { CraftParts, Item, Rarity } from '../types/items.js';

/**
 * ⭐ КЛИНОК ИЗ ГЕОМЕТРИИ (docs/CRAFT_WEAPONS.md §26) — сторожа дизайна:
 * длина двигает ТОЛЬКО ось удар ↔ скорость (ДПС в узком коридоре), ширина — ТОЛЬКО разброс вокруг той же
 * середины (ДПС не двигает), центр тяжести вместе с оголовьем — ОДНА точка баланса в ±1 (не два продавца
 * блока и статуса), а найденный меч несёт те же статы клинка, что скованный из тех же деталей.
 */

const reg = new ConfigRegistry();
reg.loadAll();
const K: BladeTuning = reg.get('balance').craft.blade;
const CK = reg.get('balance').craft;
const ROLL = reg.get('balance').loot.baseRoll;
type WBase = Extract<ReturnType<typeof reg.get<'items.base'>>[number], { kind: 'weapon' }>;
// Выключенная база (гладиус с 25.09: архаичный — эпоха, а не класс) из игры ушла.
const weapons = reg.get('items.base').filter((b): b is WBase => b.kind === 'weapon' && b.enabled !== false);
const baseOf = (id: string): WBase => weapons.find((b) => b.id === id)!;
const swordBases = weapons.filter((b) => b.weaponClass === 'sword');
const blades = reg.get('weapon-parts').filter((p) => p.slot === 'strike' && !!p.geom);
const tiers = craftTiers(reg);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
type Stats = { baseStats: { stat: string; kind: string; value: number }[] };
const flat = (it: Stats, st: string): number => it.baseStats.filter((m) => m.stat === st && m.kind === 'flat').reduce((s, m) => s + m.value, 0);
const first = (it: Stats, st: string): number => it.baseStats.find((m) => m.stat === st && m.kind === 'flat')!.value;
const mean = (it: Stats): number => (first(it, 'minDamage') + first(it, 'maxDamage')) / 2;

/** Все ступени вещи, какие вообще собираются из этих вариантов в их окнах материалов. */
function allStepTiers(parts: CraftParts): number[] {
  const win = CRAFT_SLOT_LIST.map((slot) => { const p = partById(reg, parts[slot].id)!; const a: number[] = []; for (let x = p.stepMin; x <= p.stepMax; x++) a.push(x); return a; });
  const out = new Set<number>();
  for (const a of win[0]!) for (const b of win[1]!) for (const c of win[2]!) for (const d of win[3]!) {
    out.add(tierOfSteps(reg, { strike: { step: a }, grip: { step: b }, bind: { step: c }, head: { step: d } }).tier);
  }
  return [...out];
}

/** Ключевые клинки базы — пул окна ковки. */
const keyPool = (baseId: string): WeaponPart[] =>
  keyVariantsByBase(reg, 'sword', baseOf(baseId).hands ?? 1).find((g) => g.baseId === baseId)?.variants ?? [];
/** База, которую даёт клинок (по его хвату). */
const baseOfBlade = (p: WeaponPart): WBase => baseOf(baseOfKeyPart(reg, 'sword', p.hands[0] ?? 1, p)!);

/** Сборка меча: заданный клинок, в остальных гнёздах — ближайший к эталону вариант на ступени k. */
function buildWith(p: WeaponPart, k = 3): CraftInput {
  const h = p.hands[0] ?? 1;
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === 'strike' ? [p] : variantsFor(reg, 'sword', slot, h);
    const q = [...pool].filter((v) => v.stepMin <= k && k <= v.stepMax).sort((x, y) => Math.abs(axisOf(reg, x)) - Math.abs(axisOf(reg, y)))[0] ?? pool[0]!;
    parts[slot] = { id: q.id, step: clampStep(q, k) };
  }
  return { weaponClass: 'sword', hands: h, parts };
}

/** Набор деталей для запекания напрямую: клинок (можно подменённый), оголовье, эталоны в остальных гнёздах. */
function setWith(strike: WeaponPart, head: WeaponPart): PartSet {
  const h = strike.hands[0] ?? 1;
  const ref = (slot: 'grip' | 'bind'): WeaponPart => [...variantsFor(reg, 'sword', slot, h)].sort((a, b) => Math.abs(a.axis) - Math.abs(b.axis))[0]!;
  return { strike, grip: ref('grip'), bind: ref('bind'), head };
}
const headsOf = (h: number): WeaponPart[] => variantsFor(reg, 'sword', 'head', h);
const zeroHead = (h: number): WeaponPart => headsOf(h).find((p) => p.axis === 0)!;
/** Стат укуса мечей (кровотечение) и его шаг. */
const biteOf = (b: WBase) => CK.bite[statusKindOf(reg, b)!]!;

describe('⭐ §26: единицы — длина, ширина, центр тяжести', () => {
  const br = (tag: string): BladeBracket => K.brackets.find((b) => b.tag === tag)!;

  it('место по длине: нижняя граница −1, верхняя +1, середина 0, вне вилки — упор в край', () => {
    for (const b of K.brackets) {
      expect(lengthPlace(b, b.lo), b.tag).toBe(-1);
      expect(lengthPlace(b, b.hi), b.tag).toBe(1);
      expect(lengthPlace(b, (b.lo + b.hi) / 2), b.tag).toBeCloseTo(0, 12);
      expect(lengthPlace(b, b.lo - 20), b.tag).toBe(-1);
      expect(lengthPlace(b, b.hi + 20), b.tag).toBe(1);
      expect(lengthPlace(b, b.lo + (b.hi - b.lo) / 4), b.tag).toBeCloseTo(-0.5, 12);
    }
    // Вырожденная вилка (lo = hi) — не делит на ноль, ось нейтральна.
    expect(lengthPlace({ tag: 'x', name: 'x', lo: 90, hi: 90, width: 3 }, 95)).toBe(0);
  });
  it('разброс от ширины: эталон ×1, «в e раз шире» упирается в пол, шаги по логарифму симметричны', () => {
    const b = br('arming');
    expect(spreadOfWidth(K, b, b.width)).toBe(1);
    expect(spreadOfWidth(K, b, b.width * Math.E)).toBe(K.spread.min);
    expect(spreadOfWidth(K, b, b.width / Math.E)).toBe(K.spread.max);
    const up = spreadOfWidth(K, b, b.width * 1.5), down = spreadOfWidth(K, b, b.width / 1.5);
    expect(up).toBeCloseTo(1 - K.spread.k * Math.log(1.5), 4);
    expect(up - 1).toBeCloseTo(1 - down, 4); // «в полтора шире» и «в полтора уже» — равные шаги
    // Мусор на входе — нейтрально, а не NaN в числах урона.
    for (const w of [0, -1, Number.NaN]) expect(spreadOfWidth(K, b, w)).toBe(1);
  });
  it('баланс клинка: ЦТ в центре — 0, на пролёт ближе к руке — +1, к концу — −1, дальше — упор', () => {
    const { center, span } = K.balance;
    expect(balanceOfBlade(K, center)).toBe(0);
    expect(balanceOfBlade(K, center - span)).toBeCloseTo(1, 12);
    expect(balanceOfBlade(K, center + span)).toBeCloseTo(-1, 12);
    expect(balanceOfBlade(K, center - span / 2)).toBeCloseTo(0.5, 12);
    expect(balanceOfBlade(K, 0)).toBe(1);
    expect(balanceOfBlade(K, 1)).toBe(-1);
  });
  it('вилка — по тегу `blade`; нет тега или геометрии — клинок живёт по-старому', () => {
    expect(bracketOf(K, { tags: { blade: 'arming' } })?.name).toBe(br('arming').name);
    expect(bracketOf(K, { tags: {} })).toBeUndefined();
    const xi = partById(reg, 'sw-a-xi')!;
    expect(bladeStatsOf(K, { ...xi, geom: undefined })).toBeUndefined();
    expect(bladeStatsOf(K, { ...xi, slot: 'head' as const })).toBeUndefined();
    expect(strikeAxisOf(reg, { ...xi, geom: undefined })).toBe(xi.axis);
    // Без вилки: длина и ширина не считаются, и это видно (`outOfBracket`), а не молча.
    const lone = bladeStatsOf(K, { ...xi, tags: { ...xi.tags, blade: 'нет-такой' } })!;
    expect(lone).toMatchObject({ bracket: undefined, place: 0, spread: 1, outOfBracket: true });
  });
  it('клинок вне своей вилки упирается в край, помечен, и окно ковки получает оговорку', () => {
    const xi = partById(reg, 'sw-a-xi')!;
    const long = { ...xi, geom: { ...xi.geom!, len: br('arming').hi + 3 } };
    const s = bladeStatsOf(K, long)!;
    expect(s.place).toBe(1);
    expect(s.outOfBracket).toBe(true);
    expect(bladeStatsOf(K, xi)!.outOfBracket).toBe(false);
    const bake = bakeParts(reg, baseOf('long-sword'), 3, setWith(long, zeroHead(1)));
    expect(bake.notes.some((n) => /вне вилки/.test(n)), bake.notes.join(' | ')).toBe(true);
  });
  it('форма детали: только фальшион и сабля, пустое — нет формы', () => {
    expect(bladeFormOf({ form: 'falchion' })).toBe('falchion');
    expect(bladeFormOf({ form: 'sabre' })).toBe('sabre');
    expect(bladeFormOf({ form: '' })).toBeUndefined();
    expect(bladeFormOf({})).toBeUndefined();
  });
});

describe('⭐ §26: подсказки измерителя', () => {
  it('⭐ класс клинка = его длина: тег `blade` у каждого клинка с замером совпадает с классом по длине (решение 24.09)', () => {
    // Класс задаёт ТОЛЬКО длина, эпоха живёт у типа клинка. Разошлись — клинок куётся не на той базе:
    // поправь длину заглушки (blades.ts) и перемерь, либо «Записать geom» в редакторе — он ставит тег сам.
    const wrong = blades.filter((p) => p.classes.includes('sword'))
      .map((p) => ({ id: p.id, tag: p.tags.blade, len: p.geom!.len, by: suggestBracket(K, p.geom!.len) }))
      .filter((x) => x.by.gap || x.by.bracket?.tag !== x.tag)
      .map((x) => `${x.id}: ${x.len} см в «${x.tag}», по длине «${x.by.bracket?.tag}»`);
    expect(wrong).toEqual([]);
    // Эпоха — у каждого типа клинка меча: имя «… архаичной эпохи» берётся от клинка, а не от навершия.
    const types = anatomyOf(reg, 'sword')!.strike.tags.find((t) => t.key === 'type')!.values;
    expect(types.filter((v) => !(v as { epoch?: string }).epoch).map((v) => v.id)).toEqual([]);
  });
  it('класс по длине: до 78 короткий, 78–90 длинный, 90–110 полуторный, от 110 двуручный; в зазоре — ближайшая', () => {
    const inside = suggestBracket(K, 87);
    expect(inside.gap).toBe(false);
    expect(inside.dist).toBe(0);
    expect(inside.bracket?.tag).toBe('arming');
    // Границы полуоткрытые (решение 24.09: «до 78 — короткие, 78–90 — длинные»): край — уже следующий класс.
    const tag = (len: number): string | undefined => suggestBracket(K, len).bracket?.tag;
    expect([tag(77.9), tag(78), tag(89.9), tag(90), tag(109.9), tag(110)]).toEqual(['short', 'arming', 'arming', 'great', 'great', 'huge']);
    // Крайние классы открыты наружу: 30 см — всё ещё короткий, 200 — всё ещё двуручный, без «зазора».
    expect(suggestBracket(K, 30)).toMatchObject({ gap: false, bracket: { tag: 'short' } });
    expect(suggestBracket(K, 200)).toMatchObject({ gap: false, bracket: { tag: 'huge' } });
    // Зазор между вилками (в данных их нет, но ручки редактора их позволяют): ближайшая и сколько не хватает.
    const holes = { ...K, brackets: [{ tag: 'a', name: 'a', lo: 45, hi: 70, width: 4 }, { tag: 'b', name: 'b', lo: 75, hi: 90, width: 4 }] };
    expect(suggestBracket(holes, 72)).toMatchObject({ gap: true, dist: 2, bracket: { tag: 'a' } });
    // Вилок нет вовсе — клинок никуда не лёг: зазор без подсказки, а не «всё в порядке».
    expect(suggestBracket({ ...K, brackets: [] }, 90)).toEqual({ bracket: undefined, gap: true, dist: 0 });
  });
  it('форма по замеру: однолезвийность — от человека; расширение к концу — фальшион, изгиб спинки — сабля', () => {
    const f = K.detect.flare, s = K.detect.spine;
    expect(suggestForm(K, { flare: f + 0.5, spine: 0 }, 'double')).toBeUndefined();
    expect(suggestForm(K, { flare: f + 0.5, spine: 0 }, undefined)).toBeUndefined();
    expect(suggestForm(K, { flare: f, spine: 0 }, 'single')).toBe('falchion');
    expect(suggestForm(K, { flare: f - 0.01, spine: s }, 'single')).toBe('sabre');
    expect(suggestForm(K, { flare: f, spine: s + 1 }, 'single')).toBe('falchion'); // расширение важнее изгиба
    expect(suggestForm(K, { flare: f - 0.01, spine: s - 0.01 }, 'single')).toBeUndefined();
    expect(suggestForm(K, {} as never, 'single')).toBeUndefined();
  });
  it('данные: подсказка по замеру не спорит с объявленной формой, форма — только у однолезвийных', () => {
    const anat = anatomyOf(reg, 'sword')!;
    for (const p of blades) {
      const edge = tagValue(anat, 'strike', p, 'edge');
      const hint = suggestForm(K, p.geom!, edge);
      if (hint) expect(p.form, `${p.id}: замер просит «${hint}»`).toBe(hint);
      if (p.form) expect(edge, `${p.id}: форма «${p.form}» у двулезвийного`).toBe('single');
    }
  });
  it('подпись клинка — из его чисел: форма, длина в вилке, ширина, баланс', () => {
    // Хопеш — фальшион по форме: 45 см из короткого класса 45–78 — самый короткий, хоть форма и тянет к тяжёлому.
    const fal = bladeStats(reg, partById(reg, 'sw-r-sickle')!)!;
    expect(bladeCaption(fal)).toMatch(/^фальшион: тяжелее прямого/);
    // Длина — по НАСТОЯЩЕМУ месту в вилке, форма — своей фразой.
    expect(fal.place).toBeLessThan(-0.35);
    expect(fal.axis).toBeGreaterThan(fal.place);
    expect(bladeCaption(fal)).toContain('короткий для вилки');
    const sabre = bladeStats(reg, partById(reg, 'sw-a-sabre')!)!;
    expect(bladeCaption(sabre)).toMatch(/^сабля: легче прямой/);
    expect(bladeCaption(sabre)).not.toContain('короткий для вилки'); // 83 см из 78–90 — середина класса
    const wide = bladeStats(reg, partById(reg, 'sw-a-xiii')!)!;
    expect(wide.spread).toBeLessThanOrEqual(0.8);
    expect(bladeCaption(wide)).toContain('широкий');
    // XI — самый длинный рыцарский (87 см из 78–90), как и у оригиналов.
    const xi = bladeStats(reg, partById(reg, 'sw-a-xi')!)!;
    expect(bladeCaption(xi)).toContain('длинный для вилки');
  });
});

describe('⭐ §26: окно ковки сортирует и выбирает эталон по ВЫВЕДЕННОЙ оси', () => {
  it('пул клинков — от «+1» к «−1» по оси из длины; эталон по умолчанию — ближайший к нулю в своей базе', () => {
    for (const h of [1, 2]) {
      const axes = variantsFor(reg, 'sword', 'strike', h).map((p) => axisOf(reg, p));
      expect(axes, `хват ${h}`).toEqual([...axes].sort((a, b) => b - a));
      const d = defaultParts(reg, 'sword', h)!;
      const key = partById(reg, d.strike.id)!;
      const pool = keyPool(baseOfBlade(key).id);
      expect(Math.abs(axisOf(reg, key)), `хват ${h}`).toBe(Math.min(...pool.map((p) => Math.abs(axisOf(reg, p)))));
    }
  });
});

describe('⭐ §26 сторож 1–2: ширина не двигает середину, разброс в своих пределах', () => {
  it('у каждого клинка на каждой ступени (мин+макс)/2 = середина без формы ±1 — и у числа, и у краёв вилки', () => {
    for (const b of swordBases) for (const p of keyPool(b.id)) for (let t = 0; t < tiers.length; t++) {
      const r = craftWeapon(reg, buildWith(p), { atTier: t });
      expect(r.ok, `${p.id} t${t}: ${r.reason}`).toBe(true);
      const plain = { baseStats: scaleBaseStats(b.baseStats, tiers[t]!.statMult) };
      expect(Math.abs(mean(r.item!) - mean(plain)), `${p.id} t${t}`).toBeLessThanOrEqual(1);
      // Края вилки броска: форма ложится ДО тира и броска, поэтому и края стоят вокруг той же середины.
      for (const at of ['lo', 'hi'] as const) {
        const edge = craftWeapon(reg, buildWith(p), { atTier: t, at }).item!;
        const plainEdge = { baseStats: scaleBaseStats(b.baseStats, tiers[t]!.statMult, fixedBaseRoll(b, at === 'lo' ? 0 : 1), ROLL) };
        expect(Math.abs(mean(edge) - mean(plainEdge)), `${p.id} t${t} край вилки ${at}`).toBeLessThanOrEqual(1);
      }
    }
  }, 30_000);
  it('разброс ширины всегда в [min, max] на любой ширине 0.5…15 см и не растёт с шириной', () => {
    for (const b of K.brackets) {
      let prev = Infinity;
      for (let w = 0.5; w <= 15 + 1e-9; w += 0.05) {
        const s = spreadOfWidth(K, b, w);
        expect(s, `${b.tag} ${w.toFixed(2)} см`).toBeGreaterThanOrEqual(K.spread.min);
        expect(s, `${b.tag} ${w.toFixed(2)} см`).toBeLessThanOrEqual(K.spread.max);
        expect(s, `${b.tag} ${w.toFixed(2)} см`).toBeLessThanOrEqual(prev);
        prev = s;
      }
    }
    for (const p of blades) {
      const s = bladeStats(reg, p)!.spread;
      expect(s >= K.spread.min && s <= K.spread.max, `${p.id}: ${s}`).toBe(true);
    }
  });
  it('⭐ широкий клинок (×0.4) за 20 000 бросков ни разу не разбросан шире узкого (×1.6) той же базы', () => {
    const wide = { spread: 0.4 }, narrow = { spread: 1.6 };
    const width = (st: ReturnType<typeof scaleBaseStats>): number => first({ baseStats: st }, 'maxDamage') - first({ baseStats: st }, 'minDamage');
    for (const b of swordBases) {
      const rng = createRng(20260924 + b.id.length);
      const maxWide = new Array<number>(tiers.length).fill(-Infinity), minNarrow = new Array<number>(tiers.length).fill(Infinity);
      for (let i = 0; i < 20000; i++) {
        const t = i % tiers.length;
        const roll = rollBaseQ(b, rng)!;
        const w = width(scaleBaseStats(b.baseStats, tiers[t]!.statMult, roll, ROLL, wide));
        const n = width(scaleBaseStats(b.baseStats, tiers[t]!.statMult, roll, ROLL, narrow));
        expect(w, `${b.id} t${t} бросок ${JSON.stringify(roll)}`).toBeLessThanOrEqual(n);
        maxWide[t] = Math.max(maxWide[t]!, w);
        minNarrow[t] = Math.min(minNarrow[t]!, n);
      }
      // И сильнее: самый разбросанный широкий не шире самого ровного узкого — на каждой ступени.
      for (let t = 0; t < tiers.length; t++) expect(maxWide[t]!, `${b.id} t${t}`).toBeLessThanOrEqual(minNarrow[t]!);
    }
  }, 60_000);
});

describe('⭐ §26 сторож 3: одна точка баланса вещи — блок и укус не больше, чем давало одно оголовье', () => {
  it('любой клинок × любое оголовье семейства (и с любой формой): точка баланса в ±1, вклад в пределах шага', () => {
    let reached = 0;
    for (const p of blades) for (const h of p.hands) for (const head of headsOf(h)) {
      const base = baseOfBlade(p);
      const bite = biteOf(base);
      for (const form of ['', 'falchion', 'sabre'] as const) {
        const strike = { ...p, form };
        const a = balanceAxisOf(reg, strike, head);
        expect(Math.abs(a), `${p.id}/${form || '—'} + ${head.id}`).toBeLessThanOrEqual(1);
        reached = Math.max(reached, Math.abs(a));
        const bake = bakeParts(reg, base, 3, setWith(strike, head));
        expect(bake.balance).toBe(a);
        const block = bake.mods.filter((m) => m.stat === 'blockChance').reduce((s, m) => s + m.value, 0);
        const bleed = bake.mods.filter((m) => m.stat === bite.stat).reduce((s, m) => s + m.value, 0);
        expect(Math.abs(block), `${p.id}/${form || '—'} + ${head.id}: блок`).toBeLessThanOrEqual(CK.headBlock + 1e-9);
        expect(Math.abs(bleed), `${p.id}/${form || '—'} + ${head.id}: укус`).toBeLessThanOrEqual(bite.value + 1e-9);
        // Рычаг один: блок и укус — две стороны одного числа, а не два независимых вклада.
        expect(block).toBeCloseTo(CK.headBlock * a, 4);
        expect(bleed).toBeCloseTo(-bite.value * a, 4);
      }
    }
    expect(reached).toBe(1); // крайние детали вместе дают ровно потолок одного оголовья — не больше и не меньше
  });
  it('доля клинка в точке баланса — ручка: крайние клинок и оголовье вместе дают ±1, вразнобой гасят друг друга', () => {
    const s = K.balance.bladeShare;
    const xv = partById(reg, 'sw-a-xv')!; // вес у руки: баланс клинка +1
    expect(bladeStats(reg, xv)!.balance).toBe(1);
    const disc = headsOf(1).find((h) => h.axis === 1)!, spiked = headsOf(1).find((h) => h.axis === -1)!;
    expect(balanceAxisOf(reg, xv, disc)).toBe(1);
    expect(balanceAxisOf(reg, xv, spiked)).toBeCloseTo(s - (1 - s), 4);
    // Клинок без геометрии — ось оголовья, как было до §26.
    expect(balanceAxisOf(reg, { ...xv, geom: undefined }, spiked)).toBe(-1);
  });
});

describe('⭐ §26 сторож 4: ДПС клинка — в коридоре своей вилки', () => {
  it('ДПС на бумаге (без округления): каждый клинок против эталона своей вилки — в [0.97, 1.02]', () => {
    for (const p of blades) {
      const base = baseOfBlade(p);
      const br = bladeStats(reg, p)!.bracket!;
      const head = zeroHead(p.hands[0] ?? 1);
      const paper = (strike: WeaponPart): number => {
        const bake = bakeParts(reg, base, 3, setWith(strike, head));
        const shaped = { baseStats: shapedBaseStats(base.baseStats, shapeOfBake(bake)) };
        return bake.damageMult * (weaponSpeedOf({ baseStats: [...base.baseStats, ...bake.mods] }) / weaponSpeedOf(base)) * (mean(shaped) / mean(base));
      };
      // Эталон вилки: середина по длине, эталонная ширина, без формы — ось 0 и разброс ×1.
      const ref = { ...p, form: '' as const, geom: { ...p.geom!, len: (br.lo + br.hi) / 2, width: br.width } };
      expect(paper(ref), `${p.id}: эталон`).toBeCloseTo(1, 9);
      const x = paper(p) / paper(ref);
      expect(x, `${p.id}`).toBeGreaterThanOrEqual(0.97);
      expect(x, `${p.id}`).toBeLessThanOrEqual(1.02);
      // И это ровно (1+0.1a)(1−0.08a): ширина в ДПС не входит.
      const a = strikeAxisOf(reg, p);
      expect(x, p.id).toBeCloseTo((1 + CK.strike.damagePct * a) * (1 - CK.strike.attackSpeed * a), 3); // множитель и скорость хранятся до 4 знаков
    }
  });

  // ДПС в модели героя: все клинки базы × все ступени × герои 1/40/80. Считается один раз на оба теста ниже.
  const HEROES = [[1, 0], [40, 120], [80, 300]] as const;
  let spreads: Map<string, number> | undefined;
  const dpsSpreads = (): Map<string, number> => {
    if (spreads) return spreads;
    spreads = new Map();
    const saves = HEROES.map(([lvl, pts]) => {
      const save = newBotSave(reg, 'warrior');
      save.level = lvl;
      const a = save.attributes as unknown as Record<string, number>;
      a.strength = (a.strength ?? 0) + pts; a.dexterity = (a.dexterity ?? 0) + pts / 2;
      return save;
    });
    for (const b of swordBases) for (let t = 0; t < tiers.length; t++) {
      const items = keyPool(b.id).map((p) => craftWeapon(reg, buildWith(p), { atTier: t }).item!);
      HEROES.forEach(([lvl], i) => {
        const dps = items.map((w) => {
          const s = structuredClone(saves[i]!); s.equipment.weapon = w;
          const m = makePlayerModel(reg, s);
          return weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon: w, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval }).dps;
        });
        spreads!.set(`${b.id} t${t} L${lvl}`, Math.max(...dps) / Math.min(...dps) - 1);
      });
    }
    return spreads;
  };

  // ⚠ ШУМ ОКРУГЛЕНИЯ, а не дефект: мин и макс формы округляются ПОРОЗНЬ (`scaleBaseStats`) — иначе вещь
  // выкатывалась бы за показанную вилку «от и до» (мин зависел бы от броска макса). Середина клинка поэтому
  // уезжает до полединицы. У короткого меча числа мелкие (6–11), а ось длины уже съела 4.1 % из 5; с 25.09 в
  // его класс вошли и архаичные клинки (архаичный — эпоха, а не класс), и у самого узкого из них разброс
  // ширины самый крупный. Герою 1-го уровня (урон почти весь — оружие) это до 8 %; с 40-го уровня и на
  // остальных базах — в пределах 5 %. (До 25.09 тот же шум жил у гладиуса — теперь его клинки здесь.)
  it('⭐ ДПС в модели героя: ≤ 5 % везде, кроме шума округления короткого меча у героя 1-го уровня (новый случай валит тест)', () => {
    const KNOWN_ROUNDING = new Set(['short-sword t0 L1', 'short-sword t1 L1', 'short-sword t2 L1', 'short-sword t3 L1', 'short-sword t5 L1']);
    const over = [...dpsSpreads()].filter(([, s]) => s > 0.05).map(([k]) => k);
    expect(over.filter((k) => !KNOWN_ROUNDING.has(k)), 'новый разброс ДПС сверх 5 %').toEqual([]);
    // Даже в известных случаях — не больше оси длины (4.1 %) плюс полединицы середины на мелких числах.
    for (const k of over) expect(dpsSpreads().get(k)!, k).toBeLessThanOrEqual(0.08);
  }, 120_000);
});

describe('⭐ §26 сторож 6: формы — сдвиг по обоим рычагам, в ±1', () => {
  const bladeLevers = (strike: WeaponPart, head: WeaponPart) => {
    const base = baseOfBlade(strike);
    const bake = bakeParts(reg, base, 3, setWith(strike, head));
    return {
      dmg: bake.damageMult,
      speed: flat({ baseStats: bake.mods }, 'attackSpeed'),
      block: flat({ baseStats: bake.mods }, 'blockChance'),
      bite: flat({ baseStats: bake.mods }, biteOf(base).stat),
    };
  };
  it('форма сдвигает ось и баланс ровно на свои ручки, с упором в ±1, у любого клинка', () => {
    for (const p of blades) {
      const bare = bladeStatsOf(K, { ...p, form: '' as const })!;
      for (const form of ['falchion', 'sabre'] as const) {
        const s = bladeStatsOf(K, { ...p, form })!;
        expect(s.axis, `${p.id}/${form}`).toBeCloseTo(clamp(bare.place + K.forms[form].length, -1, 1), 4);
        expect(s.formBalance).toBe(K.forms[form].balance);
        expect(Math.abs(s.axis)).toBeLessThanOrEqual(1);
      }
    }
  });
  it('фальшион против того же клинка без формы: удар крупнее, медленнее, блока меньше, крови больше; сабля — зеркально', () => {
    for (const [id, sign] of [['sw-a-falchion', 1], ['sw-a-sabre', -1]] as const) {
      const p = partById(reg, id)!;
      expect(bladeFormOf(p)).toBe(sign > 0 ? 'falchion' : 'sabre');
      const h = p.hands[0] ?? 1;
      for (const head of headsOf(h)) {
        const withForm = bladeLevers(p, head), bare = bladeLevers({ ...p, form: '' as const }, head);
        const strict = head.axis === 0; // на крайнем оголовье точка баланса может упереться в ±1
        const cmp = (x: number, y: number, what: string): void => {
          const d = sign * (x - y);
          if (strict) expect(d, `${id} + ${head.id}: ${what}`).toBeGreaterThan(0);
          else expect(d, `${id} + ${head.id}: ${what}`).toBeGreaterThanOrEqual(0);
        };
        cmp(withForm.dmg, bare.dmg, 'урон');
        cmp(bare.speed, withForm.speed, 'скорость');
        cmp(bare.block, withForm.block, 'блок');
        cmp(withForm.bite, bare.bite, 'кровотечение');
      }
    }
  });
});

describe('⭐ §26 найденный меч = скованный из тех же деталей (`shapeFoundWeapon`)', () => {
  const drop = (baseId: string, level: number, seed: number, forceRarity: Rarity = 'normal', uniques = reg.get('uniques')): Item =>
    generateItem(reg.get('items.base'), reg.get('affixes'), uniques, {
      dropBias: 1, itemLevel: level, tierLevel: level, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
      forceRarity, maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: ROLL, origin: 'drop',   // находка: журнал учит деталям только её
    }, createRng(seed));

  it('детали замораживаются на вещи, статы — от клинка: ось, разброс, точка баланса; остальное не трогается', () => {
    for (const b of swordBases) for (const lvl of [1, 30, 62]) for (const rar of ['normal', 'magic', 'rare'] as const) {
      const raw = drop(b.id, lvl, lvl * 13 + b.id.length, rar);
      const it = shapeFoundWeapon(reg, raw);
      const tag = `${b.id} ур.${lvl} ${rar}`;
      expect(raw.foundParts, tag).toBeUndefined(); // исходная вещь не мутирует
      expect(it.foundParts, tag).toBeTruthy();
      const strike = partById(reg, it.foundParts!.strike.id)!;
      const head = partById(reg, it.foundParts!.head.id)!;
      const bs = bladeStats(reg, strike)!;
      expect(bs, tag).toBeTruthy();
      const a = strikeAxisOf(reg, strike);
      if (a === 0) expect(it.damageMult, tag).toBeUndefined();
      // Множитель пишется с 4 знаками: 1.01515 хранится как 1.0152 — сравнение до трёх.
      else expect(it.damageMult!, tag).toBeCloseTo(1 + CK.strike.damagePct * a, 3);
      if (bs.spread === 1) expect(it.spreadMult, tag).toBeUndefined();
      else expect(it.spreadMult, tag).toBe(bs.spread);
      // Числа базы — на тире вещи, её бросок, вокруг формы клинка.
      const tier = reg.get('item-tiers').find((t) => t.id === it.tier)!;
      const nums = { baseStats: scaleBaseStats(b.baseStats, tier.statMult, it.baseRoll, ROLL, shapeOfItem(it)) };
      expect(first(it, 'minDamage'), tag).toBe(first(nums, 'minDamage'));
      expect(first(it, 'maxDamage'), tag).toBe(first(nums, 'maxDamage'));
      // Вклад клинка: скорость от оси, блок и укус от ОДНОЙ точки баланса клинка с оголовьем.
      const extras = { baseStats: bakedExtras(b.baseStats, it.baseStats) };
      const bal = balanceAxisOf(reg, strike, head);
      expect(flat(extras, 'attackSpeed'), tag).toBeCloseTo(-CK.strike.attackSpeed * a, 4);
      expect(flat(extras, 'blockChance'), tag).toBeCloseTo(CK.headBlock * bal, 4);
      expect(flat(extras, biteOf(b).stat), tag).toBeCloseTo(-biteOf(b).value * bal, 4);
      // Держак и обвязка у найденной не трогаются: дальность, дуга, аффиксы, имя, требования — как выпали.
      for (const key of ['reachMult', 'arcMult', 'affixes', 'name', 'requirements', 'tier', 'baseRoll', 'rarity', 'itemLevel'] as const) {
        expect(it[key], `${tag}: ${key}`).toEqual(raw[key]);
      }
      expect(it.affixCap, tag).toBeUndefined();
      // Тождество разбора держится и у замороженных деталей: тип = база, ступень деталей = ступень вещи.
      expect(typeOfItem(reg, it)?.baseId, tag).toBe(b.id);
      expect(tierOfSteps(reg, it.foundParts!).tier, tag).toBe(tierIndexOfItem(reg, it));
      // Идемпотентна: статы пересобираются от базы, вклад клинка не копится.
      expect(shapeFoundWeapon(reg, it), tag).toEqual(it);
    }
  });
  it('детерминирована по содержимому вещи, а не по uid: одинаковый дроп — одинаковые детали', () => {
    for (const b of swordBases) for (const seed of [1, 2, 3, 4, 5]) {
      const x = drop(b.id, 40, seed, 'rare'), y = drop(b.id, 40, seed, 'rare');
      expect(x.uid).not.toBe(y.uid);
      const sx = shapeFoundWeapon(reg, x), sy = shapeFoundWeapon(reg, y);
      expect(sy.foundParts, `${b.id} #${seed}`).toEqual(sx.foundParts);
      expect({ ...sy, uid: '' }, `${b.id} #${seed}`).toEqual({ ...sx, uid: '' });
      expect(shapeFoundWeapon(reg, { ...x, uid: 'другой' }).foundParts).toEqual(sx.foundParts);
    }
  });
  it('не трогает уникальные, скованные и не-оружие; прочим классам (без геометрии) только записывает детали', () => {
    const gore = reg.get('uniques').filter((u) => baseOf(u.baseId)?.weaponClass === 'sword');
    expect(gore.length).toBeGreaterThan(0);
    const u = drop('short-sword', 30, 7, 'unique', gore);
    expect(u.rarity).toBe('unique');
    expect(shapeFoundWeapon(reg, u)).toBe(u);
    const crafted = craftWeapon(reg, buildWith(partById(reg, 'sw-a-xii')!)).item!;
    expect(shapeFoundWeapon(reg, crafted)).toBe(crafted);
    // D17 (§12.1): детали замораживаются у ЛЮБОГО найденного оружия, но без геометрии клинка ни одно число
    // вещи не меняется — вещь та же, плюс `foundParts`. Повторная форма ничего не сдвигает.
    for (const id of ['war-axe', 'mace', 'spear', 'long-bow']) {
      const x = drop(id, 30, 11);
      const s = shapeFoundWeapon(reg, x);
      expect(s.foundParts, id).toBeTruthy();
      const { foundParts: _fp, ...rest } = s;
      expect(rest, id).toEqual(x);
      expect(shapeFoundWeapon(reg, s), id).toEqual(s);
    }
    const armor = reg.get('items.base').find((b) => b.kind === 'armor')!;
    const worn = drop(armor.id, 30, 3);
    expect(shapeFoundWeapon(reg, worn)).toBe(worn);
  });
  it('старый сейв без поля tier: форма ложится, повторная форма сходится с первой', () => {
    for (const b of swordBases) {
      const raw = { ...drop(b.id, 45, 5), tier: undefined };
      const it = shapeFoundWeapon(reg, raw);
      expect(it.foundParts, b.id).toBeTruthy();
      expect(shapeFoundWeapon(reg, it), b.id).toEqual(it);
    }
  });
  it('partsOf отдаёт замороженные детали; разбор и журнал берут их, а не вывод по uid', () => {
    const it = shapeFoundWeapon(reg, drop('long-sword', 30, 21));
    expect(partsOf(reg, it)).toBe(it.foundParts);
    expect(partsOf(reg, { ...it, uid: 'совсем-другой' })).toEqual(it.foundParts);
    // Сырьё — ровно из замороженных деталей их ступеней.
    const anat = anatomyOf(reg, 'sword')!;
    const k = CK.salvage;
    const want = (parts: CraftParts): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const slot of CRAFT_SLOT_LIST) {
        const p = partById(reg, parts[slot].id)!;
        const id = materialId(partFamily(anat, slot, p), parts[slot].step);
        const n = k.units[slot] + (slot === 'strike' ? (k.rarityBonus[it.rarity as keyof typeof k.rarityBonus] ?? 0) : 0);
        if (n > 0) out[id] = (out[id] ?? 0) + n;
      }
      return out;
    };
    expect(craftSalvageYield(reg, it)).toEqual(want(it.foundParts!));
    // Сдвинь ступень клинка в замороженных деталях — сырьё поедет за ней: читается именно `foundParts`.
    const s = partById(reg, it.foundParts!.strike.id)!;
    const other = [s.stepMin, s.stepMax].find((x) => x !== it.foundParts!.strike.step)!;
    const moved = { ...it, foundParts: { ...it.foundParts!, strike: { ...it.foundParts!.strike, step: other } } };
    expect(craftSalvageYield(reg, moved)).toEqual(want(moved.foundParts));
    expect(craftSalvageYield(reg, moved)).not.toEqual(craftSalvageYield(reg, it));
    const j = salvageIntoJournal(reg, emptyJournal(), it).journal;
    for (const slot of CRAFT_SLOT_LIST) expect(j.variants).toContain(it.foundParts![slot].id);
  });
  it('⭐ подъём тира сохраняет форму и вклад клинка; повторная форма после подъёма ничего не меняет', () => {
    for (const b of swordBases) {
      const it = shapeFoundWeapon(reg, drop(b.id, 30, 17));
      const up = upgradedItem(reg, it)!;
      expect(up, b.id).toBeTruthy();
      expect(up.tier, b.id).not.toBe(it.tier);
      expect(up.spreadMult, b.id).toBe(it.spreadMult);
      expect(up.damageMult, b.id).toBe(it.damageMult);
      // Детали те же (клинок не меняется вместе с тиром), ступени — под новый тир: разбор отдаёт то, из чего вещь
      // сделана (§10.9), а не материалы тира выпадения.
      for (const slot of CRAFT_SLOT_LIST) expect(up.foundParts![slot].id, `${b.id} ${slot}`).toBe(it.foundParts![slot].id);
      const want = tierIndex(reg, up.tier);
      const best = Math.min(...allStepTiers(up.foundParts!).map((x) => Math.abs(x - want)));
      expect(Math.abs(tierOfSteps(reg, up.foundParts!).tier - want), b.id).toBe(best);
      expect(bakedExtras(b.baseStats, up.baseStats), b.id).toEqual(bakedExtras(b.baseStats, it.baseStats));
      const next = reg.get('item-tiers').find((t) => t.id === up.tier)!;
      const nums = { baseStats: scaleBaseStats(b.baseStats, next.statMult, it.baseRoll, ROLL, shapeOfItem(it)) };
      expect(first(up, 'minDamage'), b.id).toBe(first(nums, 'minDamage'));
      expect(first(up, 'maxDamage'), b.id).toBe(first(nums, 'maxDamage'));
      expect(shapeFoundWeapon(reg, up), b.id).toEqual(up);
      // Прямой `retierItem` — только форма и числа базы; вклад клинка возвращает `upgradedItem` от деталей.
      const direct = retierItem(b, it, next, { spread: ROLL });
      expect(direct.baseStats, b.id).toEqual(nums.baseStats);
      expect(direct.spreadMult, b.id).toBe(it.spreadMult);
    }
  });
});

describe('§26: бот сима видит клинок так же, как бой', () => {
  it('⭐ длинный и короткий клинок одной базы: отношение оценок бота = отношению настоящего ДПС (плата скоростью учтена)', () => {
    const save = newBotSave(reg, 'warrior');
    save.level = 20;
    const dps = (w: Item): number => {
      const s = structuredClone(save); s.equipment.weapon = w;
      const m = makePlayerModel(reg, s);
      return weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon: w, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval }).dps;
    };
    for (const id of ['long-sword', 'short-sword', 'claymore']) {
      const pool = [...keyPool(id)].sort((a, b) => axisOf(reg, a) - axisOf(reg, b));
      const [short, long] = [pool[0]!, pool[pool.length - 1]!].map((p) => craftWeapon(reg, buildWith(p), { atTier: 3 }).item!);
      const botRatio = scoreItem(reg, save, long!, DEFAULT_BUILD) / scoreItem(reg, save, short!, DEFAULT_BUILD);
      // До правки бот видел +10 % урона длинного и не видел −8 % скорости: 1.22 против настоящих 1.04.
      expect(Math.abs(botRatio - dps(long!) / dps(short!)), id).toBeLessThan(0.03);
    }
  });
});
