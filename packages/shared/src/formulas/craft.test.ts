import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import {
  anatomyOf, bakeParts, baseTierRange, capacityOf, clampStep, craftCost, craftSalvageYield, craftTiers, craftWeapon,
  emptyJournal, enchantCost, enchantItem, finishOf, formOf, fullJournal, keyVariantsByBase, meltReturn, partById, partFamily,
  partsOf, resolveParts, salvageIntoJournal, shapeFoundWeapon, sketchable, tierIndexOfItem, tierOfSteps, typeOfItem, useSketch,
  variantsFor, type CraftInput,
} from './craft.js';
import {
  CRAFT_SLOT_LIST, agree, baseOfKeyPart, familiesOf, keySlotOf, matchWhen, resolveType, tagValue,
  typesRow, type CraftSlot, type PartSet,
} from './craftType.js';
import {
  DEFAULT_ROLL_SPREAD, bakedExtras, baseStatRange, fixedBaseRoll, generateItem, inferTierId, retierItem, rollBaseQ, scaleBaseStats,
  shapeOfItem, snapFloor,
} from './itemgen.js';
import { axisOf, bladeStats, strikeAxisOf } from './bladeStats.js';
import { describeItem } from './itemDescribe.js';
import { weaponCard } from './craftCard.js';
import { makePlayerModel, newBotSave } from '../sim/playerBot.js';

const ITEM_LABELS = { armorClass: (id: string) => id, weight: (id: string) => id, physSub: (id: string) => id, skill: (id: string) => id, dmgShort: (dt: string) => dt };
import { createRng } from './rng.js';
import { canEnchantItem, canRerollItem, enchantAction, forgeGold, forgeReroll, forgeUpgrade, upgradedItem } from '../economy/townActions.js';
import type { SaveState } from '../types/save.js';
import type { CraftParts, Item } from '../types/items.js';
import { ESSENCE_ID } from './salvage.js';
/** §6.2: зачарование и перекатка тратят эссенцию — кошелёк сундука с запасом (тесту важно не это). */
const essWallet = (): Record<string, number> => ({ [ESSENCE_ID]: 1_000_000 });

const reg = new ConfigRegistry();
reg.loadAll();
type WBase = Extract<ReturnType<typeof reg.get<'items.base'>>[number], { kind: 'weapon' }>;
// Выключенная база (гладиус с 25.09: архаичный — эпоха, а не класс) из игры ушла и в тотальность не входит.
const weapons = reg.get('items.base').filter((b): b is WBase => b.kind === 'weapon' && b.enabled !== false);
const CLASSES = [...new Set(weapons.map((w) => w.weaponClass))];
const price = new Map(reg.get('craft-materials').map((m) => [m.id, m.sellPrice]));
const value = (c: Record<string, number>): number => Object.entries(c).reduce((s, [id, n]) => s + (price.get(id) ?? 0) * n, 0);
const baseOf = (id: string): WBase => weapons.find((b) => b.id === id)!;

type Steps = Record<CraftSlot, number>;
const uniform = (k: number): Steps => ({ strike: k, grip: k, bind: k, head: k });

/** Пулы семейства базы: ключ — только варианты этой базы. */
function poolsOf(baseId: string): Record<CraftSlot, ReturnType<typeof variantsFor>> {
  const b = baseOf(baseId);
  const keySlot = keySlotOf(reg, b.weaponClass);
  const out = {} as Record<CraftSlot, ReturnType<typeof variantsFor>>;
  for (const slot of CRAFT_SLOT_LIST) {
    out[slot] = slot === keySlot
      ? keyVariantsByBase(reg, b.weaponClass, b.hands ?? 1).find((g) => g.baseId === baseId)?.variants ?? []
      : variantsFor(reg, b.weaponClass, slot, b.hands ?? 1);
  }
  return out;
}

/**
 * Сборка базы: в каждом гнезде ближайший к эталону вариант, чьё окно берёт нужную ступень. Эталон — по
 * ВЫВЕДЕННОЙ оси (`axisOf`), как у окна ковки: у клинка с геометрией ручное число больше ничего не значит (§26).
 */
function buildFor(baseId: string, steps: Steps, pick: Partial<Record<CraftSlot, string>> = {}): CraftInput {
  const b = baseOf(baseId);
  const pools = poolsOf(baseId);
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const want = steps[slot];
    const p = pick[slot] ? partById(reg, pick[slot]!)! : [...pools[slot]].filter((v) => v.stepMin <= want && want <= v.stepMax).sort((x, y) => Math.abs(axisOf(reg, x)) - Math.abs(axisOf(reg, y)))[0] ?? pools[slot][0]!;
    parts[slot] = { id: p.id, step: clampStep(p, want) };
  }
  return { weaponClass: b.weaponClass, hands: b.hands ?? 1, parts };
}

/** Ступени, из которых эта база куётся ровно в ступень t (ровные предпочтительнее), или null. */
function stepsForTierOf(baseId: string, t: number): Steps | null {
  const pools = poolsOf(baseId);
  const has = (slot: CraftSlot, s: number): boolean => pools[slot].some((p) => p.stepMin <= s && s <= p.stepMax);
  let best: { s: Steps; spread: number } | null = null;
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
    const s: Steps = { strike: a, grip: b, bind: c, head: d };
    if (!CRAFT_SLOT_LIST.every((sl) => has(sl, s[sl]))) continue;
    if (tierOfSteps(reg, { strike: { step: a }, grip: { step: b }, bind: { step: c }, head: { step: d } }).tier !== t) continue;
    const spread = Math.max(a, b, c, d) - Math.min(a, b, c, d);
    if (!best || spread < best.spread) best = { s, spread };
  }
  return best?.s ?? null;
}

const partsSet = (input: CraftInput): PartSet => {
  const r = resolveParts(reg, input.weaponClass, input.hands, input.parts);
  if (!r.ok) throw new Error(r.reason);
  return r.parts;
};
const stepsObj = (s: Steps) => ({ strike: { step: s.strike }, grip: { step: s.grip }, bind: { step: s.bind }, head: { step: s.head } });

describe('⭐ ступень вещи из материалов деталей (docs/CRAFT_WEAPONS.md §11)', () => {
  it('вещь целиком из одной ступени k даёт t0, t2, t3, t5, t6 — полы прежних полос', () => {
    expect([1, 2, 3, 4, 5].map((k) => tierOfSteps(reg, stepsObj(uniform(k))).tier)).toEqual([0, 2, 3, 5, 6]);
  });
  it('каждая ступень t0…t6 достижима смешением материалов', () => {
    const seen = new Set<number>();
    for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
      seen.add(tierOfSteps(reg, stepsObj({ strike: a, grip: b, bind: c, head: d })).tier);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('булатный клинок при болотном прочем — t2, а не мифик: клинок весит две пятых', () => {
    expect(tierOfSteps(reg, stepsObj({ strike: 5, grip: 1, bind: 1, head: 1 })).tier).toBe(2);
    expect(tierOfSteps(reg, stepsObj({ strike: 1, grip: 5, bind: 5, head: 5 })).tier).toBe(4);
  });
  it('мифик требует булатного клинка: без ступени 5 в ударной части t6 не собрать', () => {
    expect(tierOfSteps(reg, stepsObj({ strike: 4, grip: 5, bind: 5, head: 5 })).tier).toBe(5);
  });
});

describe('анатомия и варианты', () => {
  it('у каждого класса есть анатомия и классификатор, семьи существуют в craft-materials', () => {
    const fams = new Set(reg.get('craft-materials').map((m) => m.family));
    for (const cls of CLASSES) {
      const a = anatomyOf(reg, cls);
      expect(a, cls).toBeTruthy();
      expect(typesRow(reg, cls), cls).toBeTruthy();
      for (const s of CRAFT_SLOT_LIST) expect(fams.has(a![s].family), `${cls}.${s}`).toBe(true);
    }
    for (const p of reg.get('weapon-parts')) if (p.family) expect(fams.has(p.family), p.id).toBe(true);
  });
  it('⭐ не больше трёх семей материала на вещь — не пятнадцать материалов ради одного меча (§10.7)', () => {
    for (const cls of CLASSES) {
      const a = anatomyOf(reg, cls)!;
      expect(new Set(CRAFT_SLOT_LIST.map((s) => a[s].family)).size, cls).toBeLessThanOrEqual(3);
    }
  });
  it('в каждом неключевом гнезде каждого семейства есть выбор по обе стороны оси', () => {
    for (const cls of CLASSES) for (const h of familiesOf(reg, cls)) for (const s of CRAFT_SLOT_LIST) {
      if (s === keySlotOf(reg, cls)) continue;
      const v = variantsFor(reg, cls, s, h);
      expect(v.length, `${cls}/${h}.${s}`).toBeGreaterThanOrEqual(3);
      expect(v.some((p) => p.axis > 0) && v.some((p) => p.axis < 0), `${cls}/${h}.${s}`).toBe(true);
    }
  });
  it('у каждого варианта есть подпись-следствие, id уникальны, окно материалов корректно', () => {
    const ids = reg.get('weapon-parts').map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of reg.get('weapon-parts')) {
      expect(p.caption.trim().length, p.id).toBeGreaterThan(0);
      expect(p.stepMin <= p.stepMax && p.stepMin >= 1 && p.stepMax <= 5, p.id).toBe(true);
    }
  });
  it('⭐ словарь тегов: у каждого варианта есть все теги гнезда без умолчания, значения — из словаря', () => {
    for (const p of reg.get('weapon-parts')) for (const cls of p.classes) {
      const tags = anatomyOf(reg, cls)![p.slot].tags;
      for (const [k, v] of Object.entries(p.tags)) {
        const def = tags.find((t) => t.key === k);
        expect(def, `${p.id}: тег ${k} не в словаре ${cls}.${p.slot}`).toBeTruthy();
        expect(def!.values.some((x) => x.id === v), `${p.id}: ${k}=${v}`).toBe(true);
      }
      for (const t of tags) if (!t.default) expect(p.tags[t.key], `${p.id}: нет тега ${t.key}`).toBeTruthy();
    }
  });
});

describe('⭐ классификатор: тип из ключевой детали (§3.3)', () => {
  it('тотальность: семейство × значение ключа → ровно одна включённая база своего класса и хвата; каждая база достижима', () => {
    const reached = new Set<string>();
    for (const cls of CLASSES) {
      const row = typesRow(reg, cls)!;
      const pairs = row.bases.map((b) => `${b.hands}|${b.key}`);
      expect(new Set(pairs).size, `${cls}: дубли`).toBe(pairs.length);
      for (const b of row.bases) {
        const base = baseOf(b.base);
        expect(base, `${cls}: нет базы ${b.base}`).toBeTruthy();
        expect(base.weaponClass, b.base).toBe(cls);
        expect(base.hands ?? 1, b.base).toBe(b.hands);
      }
      for (const h of familiesOf(reg, cls)) for (const g of keyVariantsByBase(reg, cls, h)) {
        expect(g.variants.length, `${cls}/${h}: у базы ${g.baseId} нет ключевых вариантов`).toBeGreaterThan(0);
        reached.add(g.baseId);
      }
      // Каждый ключевой вариант куда-то ведёт.
      for (const h of familiesOf(reg, cls)) for (const p of variantsFor(reg, cls, keySlotOf(reg, cls), h)) {
        expect(baseOfKeyPart(reg, cls, h, p), `${p.id} в семействе ${cls}/${h}`).toBeTruthy();
      }
    }
    expect([...reached].sort()).toEqual(weapons.map((w) => w.id).sort());
  });
  it('каждая база куётся в каждой своей ступени — от minTier до maxTier', () => {
    for (const b of weapons) {
      const r = baseTierRange(reg, b);
      for (let t = r.lo; t <= r.hi; t++) expect(stepsForTierOf(b.id, t), `${b.id} t${t}`).not.toBeNull();
    }
  });
  // ⚠ У клинков с измеренной геометрией ось ВЫВЕДЕНА из длины (§26), и не каждая вилка сегодня закрыта
  // моделями от края до края: заглушки полуторного и двуручного не дотягивают, у короткого нет самого
  // короткого клинка. Это известный долг контента — владелец докидывает ~40 настоящих моделей клинков.
  // Список ниже — ровно сегодняшние дыры: НОВАЯ дыра валит тест, закрытая — просто пропадает из замера.
  // С 25.09 классы — только по длине, и длины заглушек сняты с оригиналов: у полуторных и двуручных клинков
  // исторические длины не тянутся к верху класса, а длинный класс кончается на 90 НЕ включительно — самый
  // длинный рыцарский (XIX, 89 см) даёт +0.83.
  const KNOWN_AXIS_GAPS = new Set(['long-sword +1', 'greatsword −1', 'greatsword +1', 'claymore −1', 'claymore +1']);
  const KNOWN_STEP_GAPS = new Set<string>();
  const hasGeom = (baseId: string): boolean => poolsOf(baseId).strike.some((p) => !!bladeStats(reg, p));

  it('покрытие оси: ключевые формы каждой базы (ключ — ударная часть) дотягиваются до −1 и +1', () => {
    const gaps: string[] = [];
    for (const b of weapons) {
      if (keySlotOf(reg, b.weaponClass) !== 'strike') continue;
      const axes = poolsOf(b.id).strike.map((p) => axisOf(reg, p));
      if (!hasGeom(b.id)) {
        // Ручная ось — прежнее строгое правило.
        expect(Math.min(...axes), b.id).toBeLessThanOrEqual(-0.99);
        expect(Math.max(...axes), b.id).toBeGreaterThanOrEqual(0.99);
        continue;
      }
      if (Math.min(...axes) > -0.99) gaps.push(`${b.id} −1`);
      if (Math.max(...axes) < 0.99) gaps.push(`${b.id} +1`);
    }
    expect(gaps.filter((g) => !KNOWN_AXIS_GAPS.has(g)), 'новая дыра в оси клинков').toEqual([]);
  });
  it('⭐ на ЛЮБОЙ ступени материала у базы есть и тяжёлая, и лёгкая форма — ступень не выбирает стиль боя', () => {
    const gaps: string[] = [];
    for (const b of weapons) {
      if (keySlotOf(reg, b.weaponClass) !== 'strike') continue;
      const pool = poolsOf(b.id).strike;
      const geom = hasGeom(b.id);
      for (let s = 1; s <= 5; s++) {
        const at = pool.filter((p) => p.stepMin <= s && s <= p.stepMax).map((p) => axisOf(reg, p));
        if (!at.length) continue;
        if (!geom) { expect(at.some((a) => a > 0) && at.some((a) => a < 0), `${b.id} ст.${s}`).toBe(true); continue; }
        if (!at.some((a) => a > 0)) gaps.push(`${b.id} ст.${s} тяжёлой`);
        if (!at.some((a) => a < 0)) gaps.push(`${b.id} ст.${s} лёгкой`);
      }
    }
    expect(gaps.filter((g) => !KNOWN_STEP_GAPS.has(g)), 'новая ступень без тяжёлого или лёгкого клинка').toEqual([]);
  });
  it('замена НЕключевой детали никогда не меняет базу', () => {
    for (const b of weapons) {
      const input = buildFor(b.id, uniform(3));
      const keySlot = keySlotOf(reg, b.weaponClass);
      for (const slot of CRAFT_SLOT_LIST) {
        if (slot === keySlot) continue;
        for (const v of variantsFor(reg, b.weaponClass, slot, b.hands ?? 1)) {
          const ps = { ...partsSet(input), [slot]: v } as PartSet;
          expect(resolveType(reg, b.weaponClass, b.hands ?? 1, ps).baseId, `${b.id} ${v.id}`).toBe(b.id);
        }
      }
    }
  });
  it('⭐ мёртвых правил нет: каждое имя срабатывает первым хотя бы на одной сборке', () => {
    for (const cls of CLASSES) {
      const row = typesRow(reg, cls)!;
      const anat = anatomyOf(reg, cls)!;
      const first = new Set<string>();
      for (const h of familiesOf(reg, cls)) {
        const pools = CRAFT_SLOT_LIST.map((s) => variantsFor(reg, cls, s, h));
        for (const a of pools[0]!) for (const b of pools[1]!) for (const c of pools[2]!) for (const d of pools[3]!) {
          const ps: PartSet = { strike: a, grip: b, bind: c, head: d };
          const r = row.names.find((x) => x.enabled !== false && matchWhen(anat, x.when, h, ps));
          if (r) first.add(r.id);
        }
      }
      for (const r of row.names) if (r.enabled !== false) expect(first.has(r.id), `${cls}: правило ${r.id} ни разу не первое`).toBe(true);
    }
  });
  it('у каждого имени есть источник или пометка «фэнтези»; условия ссылаются на существующие теги', () => {
    for (const cls of CLASSES) {
      const anat = anatomyOf(reg, cls)!;
      for (const r of typesRow(reg, cls)!.names) {
        expect(r.source.trim().length > 0 || r.fantasy, `${cls}: ${r.id}`).toBe(true);
        for (const [k, vals] of Object.entries(r.when)) {
          if (k === 'hands') continue;
          const [slot, key] = k.split('.') as [CraftSlot, string];
          if (key === 'id') continue;
          const def = anat[slot].tags.find((t) => t.key === key);
          expect(def, `${r.id}: ${k}`).toBeTruthy();
          for (const v of vals) expect(def!.values.some((x) => x.id === v), `${r.id}: ${k}=${v}`).toBe(true);
        }
      }
    }
  });
  it('⭐ имя не несёт статов: выключение всех правил имён не меняет ни одного числа', () => {
    const data = structuredClone(defaultConfigData) as Record<string, unknown>;
    for (const row of data['weapon-types'] as { names: { enabled: boolean }[] }[]) for (const n of row.names) n.enabled = false;
    const bare = new ConfigRegistry();
    bare.loadAll(data);
    for (const b of weapons) {
      const input = buildFor(b.id, uniform(3));
      const x = craftWeapon(reg, input).item!, y = craftWeapon(bare, input).item!;
      expect(y.baseStats, b.id).toEqual(x.baseStats);
      expect(y.requirements, b.id).toEqual(x.requirements);
      expect(y.affixCap, b.id).toEqual(x.affixCap);
      expect(y.baseId, b.id).toBe(x.baseId);
    }
  });
  it('ранний меч узнаётся по деталям, формула — по своду', () => {
    const input = buildFor('long-sword', uniform(2), { strike: 'sw-a-x', grip: 'sw-gr-one', bind: 'sw-gd-short', head: 'sw-pm-lobed' });
    const t = resolveType(reg, 'sword', 1, partsSet(input));
    expect(t.name).toBe('Ранний меч');
    expect(t.typeId).toBe('sw-carolingian');
    expect(t.formula).toBe('Свод: клинок X · перекрестье 3 · навершие трёхчастное');
    const r = craftWeapon(reg, input);
    expect(r.item!.name).toBe('Крепкий ранний меч');
    expect(r.item!.typeId).toBe('sw-carolingian');
  });
  it('⭐ вольная сборка никогда не зовётся именем правила, которого не выполнила', () => {
    for (const cls of CLASSES) {
      const row = typesRow(reg, cls)!;
      const canon = new Set(row.names.map((r) => r.name.toLowerCase()));
      for (const h of familiesOf(reg, cls)) {
        const pools = CRAFT_SLOT_LIST.map((s) => variantsFor(reg, cls, s, h));
        for (const a of pools[0]!) for (const b of pools[1]!) for (const c of pools[2]!) for (const d of pools[3]!) {
          const t = resolveType(reg, cls, h, { strike: a, grip: b, bind: c, head: d });
          if (t.ok && t.fallback) expect(canon.has(t.name.toLowerCase()), `${cls}: «${t.name}»`).toBe(false);
        }
      }
    }
  });
  it('без правила имя собирается шаблоном и согласуется по роду', () => {
    const input = buildFor('long-sword', uniform(3), { strike: 'sw-a-xi', grip: 'sw-gr-one', bind: 'sw-gd-long', head: 'sw-pm-pear' });
    const t = resolveType(reg, 'sword', 1, partsSet(input));
    expect(t.fallback).toBe(true);
    // Эпоху задаёт КЛИНОК (решение 24.09): XI — классический, хоть навершие-груша и имперское.
    expect(t.name).toBe('Узкий меч классической эпохи');
    // Шипастое навершие (фэнтези) эпохи не несёт — оно дописывает себя оборотом «с …».
    const spiked = buildFor('long-sword', uniform(3), { strike: 'sw-a-xi', grip: 'sw-gr-one', bind: 'sw-gd-long', head: 'sw-pm-spiked' });
    expect(resolveType(reg, 'sword', 1, partsSet(spiked)).name).toBe('Узкий меч классической эпохи с шипастым навершием');
    const spear = buildFor('pike', uniform(3), { strike: 'sp-awl', grip: 'sp-gr2-heel' });
    expect(resolveType(reg, 'spear', 2, partsSet(spear)).name).toBe('Шиловидная пика');
    expect(agree('поздний', 'f')).toBe('поздняя');
    expect(agree('широкий', 'n')).toBe('широкое');
    expect(agree('ранний', 'f')).toBe('ранняя');
    expect(agree('большой', 'p')).toBe('большие');
    expect(agree('с долом', 'f')).toBe('с долом');
  });
});

/** Запечь сборку «все гнёзда эталон, кроме одного на заданной оси» (база фиксирована). */
function bakeWith(baseId: string, slot: CraftSlot, axisSign: 1 | -1) {
  const base = baseOf(baseId);
  const pools = poolsOf(baseId);
  const pool = pools[slot];
  const pick = (axisSign > 0 ? pool[0] : pool[pool.length - 1])!;
  const input = buildFor(baseId, uniform(3), { [slot]: pick.id });
  input.parts[slot].step = clampStep(pick, 3);
  return { base, bake: bakeParts(reg, base, 3, partsSet(input)) };
}

describe('⭐ замок «одна ось ДПС внутри типа»: вклад выводится из оси, а не пишется руками', () => {
  const DPS_STATS = new Set(['damagePct', 'attackSpeed']);
  it('урон и скорость двигает ТОЛЬКО ударная часть: остальные гнёзда их не трогают вовсе', () => {
    const dps = (b: { damageMult: number; mods: { stat: string; value: number }[] }) =>
      [`dmg:${b.damageMult}`, ...b.mods.filter((m) => DPS_STATS.has(m.stat)).map((m) => `${m.stat}:${m.value}`)].sort();
    for (const b of weapons) {
      const ref = dps(bakeParts(reg, b, 3, partsSet(buildFor(b.id, uniform(3)))));
      for (const slot of CRAFT_SLOT_LIST) for (const sign of [1, -1] as const) {
        const { bake } = bakeWith(b.id, slot, sign);
        if (slot !== 'strike') expect(dps(bake), `${b.id} ${slot} ${sign}`).toEqual(ref);
      }
    }
  });
  it('урон и скорость ударной части зеркальны: тяжёлая форма — урон больше, скорость меньше', () => {
    const { bake: heavy } = bakeWith('long-sword', 'strike', 1);
    expect(heavy.damageMult).toBeGreaterThan(1);
    expect(heavy.mods.find((m) => m.stat === 'attackSpeed')!.value).toBeLessThan(0);
    expect(heavy.mods.some((m) => m.stat === 'damagePct')).toBe(false); // урон — в цифрах, не строкой «+10 %»
  });
  it('⭐ форма клинка — множитель удара вещи и плоская часть скорости оружия; в подсказке без приписок', () => {
    // Ось клинка с геометрией ВЫВЕДЕНА из длины (§26): ожидания — от `strikeAxisOf`, а не от ручного числа.
    const res = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-x' }));
    const light = res.item!;
    const a = strikeAxisOf(reg, partById(reg, 'sw-a-x')!);
    expect(a).toBeLessThan(0); // X (80 см) — короткий для длинного класса 78–90: лёгкая сторона
    const f = (it: { baseStats: { stat: string; kind: string; value: number }[] }, st: string) => it.baseStats.find((m) => m.stat === st && m.kind === 'flat')?.value ?? 0;
    const k = reg.get('balance').craft.strike;
    // Множитель и плоская скорость пишутся в вещь с 4 знаками: у оси −0.6667 точнее не сойдётся.
    expect(light.damageMult).toBeCloseTo(1 + a * k.damagePct, 4);
    expect(f(light, 'attackSpeed')).toBeCloseTo(-a * k.attackSpeed, 4);
    // Цифры урона в статах — числа базы на тире (с разбросом ширины клинка), БЕЗ множителя удара: он живёт в `damageMult`.
    const base = baseOf('long-sword');
    const numbers = scaleBaseStats(base.baseStats, craftTiers(reg)[res.tier!]!.statMult, undefined, reg.get('balance').loot.baseRoll, shapeOfItem(light));
    expect(f(light, 'minDamage')).toBe(f({ baseStats: numbers }, 'minDamage'));
    expect(f(light, 'maxDamage')).toBe(f({ baseStats: numbers }, 'maxDamage'));
    // Клинок ровно на середине вилки множителя не несёт вовсе (поле не пишется).
    const zero = reg.get('weapon-parts').find((p) => p.slot === 'strike' && !!bladeStats(reg, p) && strikeAxisOf(reg, p) === 0)!;
    expect(zero, 'нужен клинок с выведенной осью 0').toBeTruthy();
    const zeroBase = baseOfKeyPart(reg, 'sword', zero.hands[0] ?? 1, zero)!;
    const plain = craftWeapon(reg, buildFor(zeroBase, uniform(zero.stepMin), { strike: zero.id }));
    expect(plain.ok, plain.reason).toBe(true);
    expect(plain.item!.damageMult).toBeUndefined();
    expect(plain.item!.baseStats.some((m) => m.stat === 'attackSpeed' && m.kind === 'flat')).toBe(false);
    const lines = describeItem(light, ITEM_LABELS).map((l) => l.text);
    // Предпросмотр — вилкой, и она тоже умножена на форму клинка.
    const r = light.rollPreview!, dm = light.damageMult!, R = (v: number) => Math.round(v * dm);
    expect(lines.find((t) => t.startsWith('Урон:'))).toContain(`(${R(r.minDamage![0])}–${R(r.minDamage![1])})–(${R(r.maxDamage![0])}–${R(r.maxDamage![1])})`);
    // Скованная (бросок случился) — просто числа × форма клинка.
    const forged = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-x' }), { rng: createRng(7) }).item!;
    const shown = describeItem(forged, ITEM_LABELS).map((l) => l.text).find((t) => t.startsWith('Урон:'))!;
    expect(shown).toContain(`${R(f(forged, 'minDamage'))}–${R(f(forged, 'maxDamage'))} (`);
    // Скорость — множителем от эталона: собственная скорость базы × плоская часть клинка.
    const own = (kind: string) => base.baseStats.filter((m) => m.stat === 'attackSpeed' && m.kind === kind).reduce((s, m) => s + m.value, 0);
    const speed = (1 + own('flat') - a * k.attackSpeed) * (1 + own('increased'));
    expect(lines.some((t) => t.startsWith(`Скорость: ×${speed.toFixed(2)}`)), lines.join(' | ')).toBe(true);
    expect(lines.some((t) => /Скор\. атаки|урон/i.test(t) && !t.startsWith('Урон:'))).toBe(false);
  });
  it('⭐ соотношение ДПС форм одинаково у любого героя: атрибуты и бонусы форму не размывают', () => {
    // Крайние клинки базы по ВЫВЕДЕННОЙ оси (§26): пул уже отсортирован окном ковки от «+1» к «−1».
    const pool = poolsOf('long-sword').strike;
    const hi = pool[0]!, lo = pool[pool.length - 1]!;
    const a1 = strikeAxisOf(reg, hi), a2 = strikeAxisOf(reg, lo);
    expect(a1).toBeGreaterThan(a2);
    const heavy = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: hi.id }), { atTier: 3 }).item!;
    const light = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: lo.id }), { atTier: 3 }).item!;
    const ratios: number[] = [];
    for (const [cls, lvl, pts] of [['warrior', 1, 0], ['warrior', 40, 120], ['warrior', 80, 300]] as const) {
      const save = newBotSave(reg, cls);
      save.level = lvl;
      const a = save.attributes as unknown as Record<string, number>;
      a.strength = (a.strength ?? 0) + pts; a.dexterity = (a.dexterity ?? 0) + pts / 2;
      const dps = (w: typeof heavy): number => {
        const s = structuredClone(save); s.equipment.weapon = w;
        const m = makePlayerModel(reg, s);
        return weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon: w, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval }).dps;
      };
      ratios.push(dps(heavy) / dps(light));
    }
    const k = reg.get('balance').craft.strike;
    const expected = ((1 + k.damagePct * a1) * (1 - k.attackSpeed * a1)) / ((1 + k.damagePct * a2) * (1 - k.attackSpeed * a2));
    for (const r of ratios) expect(r).toBeCloseTo(expected, 2);
  });
  it('⭐ ДПС формы не зависит ни от базы, ни от билда: (1+0.1a)(1−0.08a), разброс ≤ 5 % везде', () => {
    const k = reg.get('balance').craft.strike;
    // Бой: урон оружия × (1 + D) × (1 + flat) × (1 + S). Форма множит урон и flat — D и S сокращаются.
    let worst = 0;
    for (let D = 0; D <= 2 + 1e-9; D += 0.25) for (let S = -0.3; S <= 1 + 1e-9; S += 0.1) {
      const dps = [-1, -0.5, 0, 0.5, 1].map((a) => (1 + k.damagePct * a) * (1 + D) * (1 - k.attackSpeed * a) * (1 + S));
      worst = Math.max(worst, Math.max(...dps) / Math.min(...dps) - 1);
    }
    expect(worst).toBeLessThanOrEqual(0.05);
  });
  it('вес вещи = вес базы: деталь не пишет в вес, урон и требования поверх типа', () => {
    for (const b of weapons) {
      const r = craftWeapon(reg, buildFor(b.id, uniform(3)));
      expect(r.ok, `${b.id}: ${r.reason}`).toBe(true);
      expect(r.item!.weight, b.id).toBe(b.weight);
      for (const m of r.item!.baseStats.filter((x) => x.stat === 'minDamage' || x.stat === 'maxDamage')) expect(m.kind, b.id).toBe('flat');
    }
  });
});

describe('⭐ держак площадь-нейтрален: `дуга × дальность²` постоянна (§5.1)', () => {
  it('у каждого крайнего держака на каждой базе ближнего боя площадь = площади базы ± 0.5 %', () => {
    for (const b of weapons.filter((w) => w.attackType === 'melee')) for (const sign of [1, -1] as const) {
      const { base, bake } = bakeWith(b.id, 'grip', sign);
      const baseArea = (base.arcMult ?? 1) * (base.reachMult ?? 1) ** 2;
      expect(Math.abs((bake.arcMult! * bake.reachMult! ** 2) / baseArea - 1), `${b.id} ${sign}`).toBeLessThan(0.005);
    }
  });
  it('длинный держак действительно дальше, короткий — шире', () => {
    expect(bakeWith('long-sword', 'grip', 1).bake.reachMult!).toBeGreaterThan(1);
    expect(bakeWith('long-sword', 'grip', -1).bake.arcMult!).toBeGreaterThan(1);
  });
});

describe('ёмкость аффиксов: потолок выведен из дропа (§6)', () => {
  it('ни одна форма не даёт больше трёх на сторону — 3+3 дроп не даёт, значит и ковка', () => {
    for (let s = 0; s <= 5; s++) for (let a = -1; a <= 1; a += 0.25) {
      const f = formOf(s, a);
      expect(f.prefix + f.suffix).toBe(s);
      expect(f.prefix).toBeLessThanOrEqual(3);
      expect(f.suffix).toBeLessThanOrEqual(3);
    }
  });
  it('на Σ=5 существуют только 3+2 и 2+3', () => {
    const forms = new Set([-1, -0.5, 0, 0.5, 1].map((a) => { const f = formOf(5, a); return `${f.prefix}+${f.suffix}`; }));
    expect([...forms].sort()).toEqual(['2+3', '3+2']);
  });
  it('⭐ зачарование до редкого ложится РОВНО в объявленную форму, имя строится от типа', () => {
    for (const bindId of ['sw-gd-short', 'sw-gd-rings']) {
      const input = buildFor('long-sword', { strike: 4, grip: 4, bind: 4, head: 3 }, { bind: bindId });
      const res = craftWeapon(reg, input);
      expect(res.ok, res.reason).toBe(true);
      const cap = res.item!.affixCap!;
      for (let i = 0; i < 40; i++) {
        const e = enchantItem(reg, res.item!, 'rare', createRng(100 + i))!;
        const kinds = new Map(e.affixes.map((a) => [a.affixId, a.kind]));
        const p = [...kinds.values()].filter((k) => k === 'prefix').length;
        expect({ p, s: kinds.size - p }).toEqual({ p: cap.prefix, s: cap.suffix });
      }
    }
    const caro = craftWeapon(reg, buildFor('long-sword', uniform(2), { strike: 'sw-a-x', grip: 'sw-gr-one', bind: 'sw-gd-short', head: 'sw-pm-lobed' })).item!;
    expect(enchantItem(reg, caro, 'magic', createRng(7))!.name.toLowerCase()).toContain('ранний меч');
  });
  it('⚠ перекатка у кузнеца не сносит купленную форму', () => {
    const res = craftWeapon(reg, buildFor('long-sword', { strike: 4, grip: 4, bind: 4, head: 3 }));
    const item = enchantItem(reg, res.item!, 'rare', createRng(3))!;
    const save = { gold: 1e9, inventory: [item] } as unknown as SaveState;
    for (let i = 0; i < 3; i++) {
      expect(forgeReroll(reg, save, item.uid, createRng(50 + i), undefined, essWallet()).ok).toBe(true);
      const kinds = new Map(item.affixes.map((a) => [a.affixId, a.kind]));
      const p = [...kinds.values()].filter((k) => k === 'prefix').length;
      expect({ p, s: kinds.size - p }).toEqual({ p: item.affixCap!.prefix, s: item.affixCap!.suffix });
    }
  });
});

describe('ковка: каркас — существующая база (правило Р1)', () => {
  it('скованная вещь по урону и требованиям равна найденной той же базы и ступени', () => {
    for (const b of weapons) {
      const t = baseTierRange(reg, b).hi;
      const steps = stepsForTierOf(b.id, t)!;
      const res = craftWeapon(reg, buildFor(b.id, steps));
      expect(res.ok, `${b.id}: ${res.reason}`).toBe(true);
      expect(res.tier, b.id).toBe(t);
      const tier = craftTiers(reg)[t]!;
      const found = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: tier.minItemLevel, tierLevel: tier.minItemLevel, baseId: b.id,
        tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal',
        maxReqTotal: reg.get('balance').maxTotalRequirement,
      }, createRng(1));
      expect(found.tier, b.id).toBe(tier.id);
      // ⭐ §26: у меча числа несёт и клинок (разброс ширины, ось длины, точка баланса), поэтому «та же вещь с
      // пола» — найденная из ТЕХ ЖЕ деталей: `shapeFoundWeapon` с `foundParts` = детали ковки. Это строже, чем
      // сравнивать только средний урон: совпадать обязаны и края вилки, и статы целиком, и множитель удара.
      // У баз без геометрии клинка форма ничего не меняет — сравнение то же, что было до §26.
      const probe = { ...found, foundParts: structuredClone(res.item!.parts!) };
      const same = shapeFoundWeapon(reg, probe);
      const geom = !!bladeStats(reg, partById(reg, res.item!.parts!.strike.id)!);
      if (geom) {
        expect(same.foundParts, b.id).toEqual(res.item!.parts);
        expect(same.spreadMult, b.id).toBe(res.item!.spreadMult);
        expect(same.damageMult, b.id).toBe(res.item!.damageMult);
      } else expect(same, b.id).toEqual(probe);   // без геометрии форма ничего не меняет (D17: детали уже записаны)
      const flat = (it: typeof found, stat: string) => it.baseStats.find((m) => m.stat === stat && m.kind === 'flat')?.value;
      // ⭐ Найденная и скованная катаются в ОДНОЙ вилке: края вилки ковки = найденная вещь на долях 0 и 1
      // (пересборка тира дропа — та же, что у кузницы), середина = прежнее число без броска.
      const spread = reg.get('balance').loot.baseRoll;
      // Найденная на доле q: тир пересобирается от базы (с формой клинка), вклад клинка — заново от деталей.
      const at = (q: number) => {
        const x = retierItem(b, { ...same, baseRoll: fixedBaseRoll(b, q) }, tier, { maxReqTotal: reg.get('balance').maxTotalRequirement, spread });
        return geom ? shapeFoundWeapon(reg, x) : x;
      };
      for (const st of ['minDamage', 'maxDamage'] as const) {
        expect(res.ranges![st], `${b.id} ${st}`).toEqual([flat(at(0), st), flat(at(1), st)]);
        expect(flat(res.item!, st), `${b.id} ${st}`).toBe(flat(at(0.5), st));
        expect(flat(same, st)!, `${b.id} ${st}`).toBeGreaterThanOrEqual(res.ranges![st]![0]);
        expect(flat(same, st)!, `${b.id} ${st}`).toBeLessThanOrEqual(res.ranges![st]![1]);
      }
      // Статы целиком (урон, блок базы, вклад клинка и оголовья) — те же, что у найденной на середине вилки.
      // Найденная вещь без геометрии клинка вклада деталей пока не несёт (перейдёт с моделями своих частей).
      if (geom) expect(res.item!.baseStats, b.id).toEqual(at(0.5).baseStats);
      // Требования — НЕ как у найденной: у скованной кузнечная скидка, та же, что у подъёма тира (F2, ниже).
      const bal = reg.get('balance');
      expect(res.item!.requirements, b.id).toEqual(
        retierItem(b, found, tier, { reqDiscount: bal.forgePrices.upgradeReqDiscount, maxReqTotal: bal.maxTotalRequirement, spread }).requirements);
    }
  });

  it('⭐ кузнечная вещь легче в требованиях: скованная = найденная × (1 − скидка), округление как у подъёма тира', () => {
    // Решение владельца: скидка `forgePrices.upgradeReqDiscount` — у ЛЮБОЙ кузнечной вещи, не только у поднятой.
    // Без неё скованная ступень надевалась позже поднятой находки той же ступени, и ковка проигрывала всегда
    // (замер К7, docs/CRAFT_WEAPONS.md §22).
    const bal = reg.get('balance');
    const d = bal.forgePrices.upgradeReqDiscount;
    expect(d).toBeGreaterThan(0);
    const cap = bal.maxTotalRequirement;
    const sum = (r: Record<string, number | undefined>): number => Object.values(r).reduce<number>((s, v) => s + (v ?? 0), 0);
    let checked = 0, viaUpgrade = 0, lighter = 0;
    for (const b of weapons) {
      const r = baseTierRange(reg, b);
      for (let t = r.lo; t <= r.hi; t++) {
        const steps = stepsForTierOf(b.id, t);
        if (!steps) continue;
        const res = craftWeapon(reg, buildFor(b.id, steps));
        expect(res.ok, `${b.id} t${t}: ${res.reason}`).toBe(true);
        const tier = craftTiers(reg)[t]!;
        const found = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
          dropBias: 1, itemLevel: tier.minItemLevel, tierLevel: tier.minItemLevel, baseId: b.id,
          tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal', maxReqTotal: cap,
        }, createRng(t + 1));
        const tag = `${b.id} t${t}`;
        const got = res.item!.requirements;
        // 1) ровно формула подъёма тира: множитель тира × (1 − скидка), затем кап и округление.
        expect(got, tag).toEqual(retierItem(b, found, tier, { reqDiscount: d, maxReqTotal: cap }).requirements);
        // 2) и ровно то, что даёт НАСТОЯЩИЙ подъём у кузнеца с соседней ступени (`upgradedItem`).
        if (t > r.lo) {
          const prev = craftTiers(reg)[t - 1]!;
          const lower = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
            dropBias: 1, itemLevel: prev.minItemLevel, tierLevel: prev.minItemLevel, baseId: b.id,
            tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal', maxReqTotal: cap,
          }, createRng(t + 7));
          const up = upgradedItem(reg, lower);
          expect(up?.tier, tag).toBe(tier.id);
          expect(got, `${tag}: как поднятая кузнецом`).toEqual(up!.requirements);
          viaUpgrade++;
        }
        // 3) без капа — каждое требование = найденное × (1 − скидка) с точностью до округления (±1).
        if (sum(found.requirements) < cap) {
          for (const [k, v] of Object.entries(found.requirements)) {
            const c = (got as Record<string, number>)[k] ?? 0;
            expect(Math.abs(c - v! * (1 - d)), `${tag} ${k}: ${c} против ${v}×${1 - d}`).toBeLessThanOrEqual(1);
          }
        }
        expect(sum(got), tag).toBeLessThanOrEqual(sum(found.requirements));
        if (sum(got) < sum(found.requirements)) lighter++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(viaUpgrade).toBeGreaterThan(50);
    expect(lighter, 'скидка работает, а не съедается капом везде').toBeGreaterThan(checked / 2);
  });

  it('скидку показывает предпросмотр и несёт вещь после зачарования (окно = сервер)', () => {
    const input = buildFor('long-sword', uniform(3));
    const preview = craftWeapon(reg, input).item!;
    const forged = craftWeapon(reg, input, { rng: createRng(4) }).item!;
    expect(forged.requirements).toEqual(preview.requirements);
    for (const at of ['lo', 'hi'] as const) expect(craftWeapon(reg, input, { at }).item!.requirements).toEqual(preview.requirements);
    const enchanted = enchantItem(reg, forged, 'rare', createRng(9))!;
    expect(enchanted.requirements).toEqual(forged.requirements);
  });
  it('⚠ ковка не портит базу в конфиге: сто ковок на t0 (множитель ×1) — статы базы те же', () => {
    const before = JSON.stringify(baseOf('long-sword').baseStats);
    const input = buildFor('long-sword', uniform(1), { strike: 'sw-a-x' });
    const first = craftWeapon(reg, input).item!.baseStats;
    for (let i = 0; i < 100; i++) craftWeapon(reg, input);
    expect(JSON.stringify(baseOf('long-sword').baseStats)).toBe(before);
    expect(craftWeapon(reg, input).item!.baseStats).toEqual(first);
  });
  it('вещь выходит ОБЫЧНОЙ, без аффиксов, с записанными деталями и ёмкостью', () => {
    const input = buildFor('battle-axe', uniform(3));
    const res = craftWeapon(reg, input);
    expect(res.item!.rarity).toBe('normal');
    expect(res.item!.affixes).toEqual([]);
    expect(res.item!.parts).toEqual(input.parts);
    expect(res.item!.affixCap!.prefix + res.item!.affixCap!.suffix).toBe(capacityOf(reg, res.tier!));
  });
  it('⭐ окно материалов: форма не куётся из чужой ступени, и причина названа', () => {
    const input = buildFor('long-sword', uniform(3), { strike: 'sw-a-xi' });
    input.parts.strike.step = 5; // узкий клинок XI — только ступени 1–3
    const r = craftWeapon(reg, input);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ступеней 1–3/);
  });
  it('потолок базы уважается: выше своего maxTier база не куётся, и окно говорит почему', () => {
    // ⚠ Потолок задаётся ДАННЫМИ, и сегодня все оружейные базы открыты до t6 (пять вилок мечей —
    // полноценные, а не «низкая ступень»). Поэтому механизм проверяем на копии конфига с потолком.
    const capped = new ConfigRegistry();
    const data = structuredClone(defaultConfigData) as Record<string, unknown>;
    const bases = data['items.base'] as { id: string; maxTier?: string }[];
    bases.find((b) => b.id === 'short-sword')!.maxTier = 't3';
    capped.loadAll(data);
    const r = craftWeapon(capped, buildFor('short-sword', { strike: 3, grip: 5, bind: 5, head: 5 }));
    expect(r.ok).toBe(false);
    expect(r.tier).toBeGreaterThan(3);
    expect(r.reason).toMatch(/не бывает выше/);
  });
  it('⭐ D3: журнал ступень НЕ режет — t6 куётся без счётчика мификов и при любом прежнем потолке (держит только сырьё)', () => {
    for (const legacy of [{ mythic: 0, tierHi: 6 }, { mythic: 0, tierHi: -1 }, { mythic: 3, tierHi: 2 }]) {
      const j = { ...fullJournal(reg), ...legacy };
      const r = craftWeapon(reg, buildFor('long-sword', stepsForTierOf('long-sword', 6)!), { journal: j });
      expect(r.ok, JSON.stringify(legacy)).toBe(true);
      expect(r.tier).toBe(6);
    }
  });
});

describe('⭐ вилка базы: урон и броня катаются, ковка двигает низ вилки (§13.1)', () => {
  const tiers = reg.get('item-tiers');
  const spread = reg.get('balance').loot.baseRoll;
  const flat = (it: { baseStats: { stat: string; kind: string; value: number }[] }, stat: string) =>
    it.baseStats.find((m) => m.stat === stat && m.kind === 'flat')?.value;

  it('вещь без броска = прежние числа: центр вилки — число тира, бросок 0.5 его не меняет', () => {
    for (const b of reg.get('items.base')) {
      for (const t of tiers) {
        const plain = scaleBaseStats(b.baseStats, t.statMult);
        const mid = scaleBaseStats(b.baseStats, t.statMult, fixedBaseRoll(b as never, 0.5), spread);
        expect(mid, `${b.id} ${t.id}`).toEqual(plain);
      }
    }
  });
  it('умолчание в коде совпадает с конфигом — вызов без вилки не расходится с игрой', () => {
    expect(DEFAULT_ROLL_SPREAD).toEqual(spread);
  });
  it('макс урона не бывает ниже мина: мин на верху вилки, макс на дне — на любой базе и ступени', () => {
    for (const b of weapons) {
      for (const t of tiers) {
        const st = scaleBaseStats(b.baseStats, t.statMult, { minDamage: 1, maxDamage: 0 }, spread);
        expect(flat({ baseStats: st }, 'maxDamage')!, `${b.id} ${t.id}`).toBeGreaterThanOrEqual(flat({ baseStats: st }, 'minDamage')!);
      }
    }
  });
  it('бросок — по доле на каждую катаемую стату, в [пол, 1], до сотых; кольцо не катается', () => {
    const rng = createRng(3);
    for (let i = 0; i < 200; i++) {
      const r = rollBaseQ(baseOf('long-sword'), rng, 0.6)!;
      expect(Object.keys(r).sort()).toEqual(['maxDamage', 'minDamage']);
      for (const q of Object.values(r)) {
        expect(q).toBeGreaterThanOrEqual(0.6);
        expect(q).toBeLessThanOrEqual(1);
        expect(Math.round(q! * 100) / 100).toBe(q);
      }
    }
    const ring = reg.get('items.base').find((b) => !b.baseStats.some((m) => ['minDamage', 'maxDamage', 'armor'].includes(m.stat)));
    if (ring) expect(rollBaseQ(ring, createRng(1))).toBeUndefined();
  });
  it('найденные вещи одного тира разбросаны по вилке и не выходят за неё', () => {
    const b = baseOf('long-sword');
    const t = tiers.find((x) => x.id === b.maxTier) ?? tiers[0]!;
    const range = baseStatRange(b, t.statMult, spread);
    const mins = new Set<number>(), maxs = new Set<number>();
    for (let s = 0; s < 300; s++) {
      const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: t.minItemLevel, tierLevel: t.minItemLevel, baseId: b.id, tiers,
        rarities: reg.get('rarities'), forceRarity: 'normal', baseRoll: spread,
      }, createRng(s));
      if (it.tier !== t.id) continue;
      const mn = flat(it, 'minDamage')!, mx = flat(it, 'maxDamage')!;
      mins.add(mn); maxs.add(mx);
      expect(mn).toBeGreaterThanOrEqual(range.minDamage![0]); expect(mn).toBeLessThanOrEqual(range.minDamage![1]);
      expect(mx).toBeGreaterThanOrEqual(range.maxDamage![0]); expect(mx).toBeLessThanOrEqual(range.maxDamage![1]);
    }
    expect(maxs.size).toBeGreaterThan(5); // вилка живая, а не одно число
  });
  it('⭐ подъём тира сохраняет место в вилке: удачный меч остаётся удачным', () => {
    const b = baseOf('long-sword');
    const lo = tiers.find((x) => x.id === b.minTier) ?? tiers[0]!;
    // Клинок нарочно широкий (XIII, 6.2 см при эталоне длинного класса 3.5): разброс ширины должен быть заметен в числах.
    const item = retierItem(b, { ...craftWeapon(reg, buildFor('long-sword', uniform(1), { strike: 'sw-a-xiii' })).item!, rollPreview: undefined, parts: undefined, damageMult: undefined, affixCap: undefined, baseRoll: { minDamage: 0.9, maxDamage: 0.2 } }, lo, { spread });
    const up = upgradedItem(reg, item)!;
    expect(up.baseRoll).toEqual({ minDamage: 0.9, maxDamage: 0.2 });
    const next = tiers.find((x) => x.id === up.tier)!;
    // §26: вещь несёт форму клинка (разброс ширины) — подъём её не теряет. Место в вилке — то же q в вилке
    // С ФОРМОЙ: числа нового тира = база × тир × бросок вокруг той же формы. Вклад деталей `retierItem` не
    // переносит (статы — от базы); найденному мечу его возвращает `upgradedItem` от записанных деталей.
    expect(item.spreadMult, 'у рыцарского клинка ширина не эталонная').toBeDefined();
    expect(up.spreadMult).toBe(item.spreadMult);
    expect(up.baseStats).toEqual(scaleBaseStats(b.baseStats, next.statMult, { minDamage: 0.9, maxDamage: 0.2 }, spread, shapeOfItem(item)));
    expect(bakedExtras(b.baseStats, up.baseStats)).toEqual([]);
    // Тот же бросок без формы дал бы другие числа — иначе проверка выше ничего бы не доказывала.
    expect(up.baseStats.find((m) => m.stat === 'minDamage')!.value).not.toBe(
      scaleBaseStats(b.baseStats, next.statMult, { minDamage: 0.9, maxDamage: 0.2 }, spread).find((m) => m.stat === 'minDamage')!.value);
  });
  it('тир восстанавливается по статам и на КРАЮ вилки (старый сейв без поля tier)', () => {
    for (const b of reg.get('items.base').filter((x) => x.baseStats.some((m) => ['minDamage', 'armor'].includes(m.stat)))) {
      for (const t of tiers) {
        for (const q of [0, 1]) {
          const baseRoll = fixedBaseRoll(b as never, q);
          const it = { baseStats: scaleBaseStats(b.baseStats, t.statMult, baseRoll, spread), itemLevel: t.minItemLevel, baseRoll };
          // На мелких числах (перчатки с бронёй 2) соседние тиры неотличимы округлением — тогда годится любой
          // тир, дающий ТЕ ЖЕ статы. Главное — край вилки не читается соседним тиром с другими числами.
          const got = tiers.find((x) => x.id === inferTierId(tiers, b as never, it, spread))!;
          expect(scaleBaseStats(b.baseStats, got.statMult, baseRoll, spread), `${b.id} ${t.id} q=${q} → ${got.id}`).toEqual(it.baseStats);
        }
      }
    }
  });
  it('⭐ доводка поднимает НИЗ вилки, верх не растёт никогда', () => {
    const input = buildFor('long-sword', uniform(3));
    const plain = craftWeapon(reg, { ...input, finish: 0 }).ranges!;
    const levels = reg.get('balance').craft.finish;
    expect(levels.length).toBeGreaterThan(1);
    let prevLo = -Infinity;
    for (let i = 0; i < levels.length; i++) {
      const r = craftWeapon(reg, { ...input, finish: i }).ranges!;
      expect(r.maxDamage![1], `ур.${i}`).toBe(plain.maxDamage![1]);
      expect(r.minDamage![1], `ур.${i}`).toBe(plain.minDamage![1]);
      expect(r.maxDamage![0], `ур.${i}`).toBeGreaterThanOrEqual(prevLo);
      prevLo = r.maxDamage![0];
    }
    expect(prevLo).toBeGreaterThan(plain.maxDamage![0]);
  });
  it('ковка катает бросок в вилке своей доводки; предпросмотр — детерминированная середина СВОЕЙ вилки', () => {
    const top = reg.get('balance').craft.finish.length - 1;
    const input = { ...buildFor('long-sword', uniform(3)), finish: top };
    const pv = craftWeapon(reg, input);
    const fl = snapFloor(finishOf(reg, top).floor);
    expect(pv.item!.baseRoll).toEqual(fixedBaseRoll(baseOf('long-sword'), (fl + 1) / 2));
    expect(craftWeapon(reg, { ...input, finish: 0 }).item!.baseRoll).toBeUndefined(); // без пола — прежние числа
    expect(pv.item!.rollPreview).toEqual(pv.ranges);
    // Вещь предпросмотра не несёт чисел, которых ковка не даст: на ВСЕХ базах, ступенях и доводках.
    for (const b of weapons) {
      for (let k = 1; k <= 5; k++) {
        for (let f = 0; f <= top; f++) {
          const p = craftWeapon(reg, { ...buildFor(b.id, uniform(k)), finish: f });
          if (!p.ok) continue;
          for (const st of ['minDamage', 'maxDamage'] as const) {
            const v = flat(p.item!, st)!, r = p.ranges![st]!;
            expect(v >= r[0] && v <= r[1], `${b.id} ст.${k} дов.${f} ${st}: ${v} вне ${r}`).toBe(true);
          }
        }
      }
    }
    for (let s = 0; s < 100; s++) {
      const it = craftWeapon(reg, input, { rng: createRng(s) }).item!;
      expect(it.rollPreview).toBeUndefined();
      for (const st of ['minDamage', 'maxDamage'] as const) {
        expect(it.baseRoll![st]!).toBeGreaterThanOrEqual(finishOf(reg, top).floor);
        expect(flat(it, st)!).toBeGreaterThanOrEqual(pv.ranges![st]![0]);
        expect(flat(it, st)!).toBeLessThanOrEqual(pv.ranges![st]![1]);
      }
    }
    // Края для окна сравнения — ровно края вилки.
    const lo = craftWeapon(reg, input, { at: 'lo' }).item!, hi = craftWeapon(reg, input, { at: 'hi' }).item!;
    expect([flat(lo, 'maxDamage'), flat(hi, 'maxDamage')]).toEqual(pv.ranges!.maxDamage);
  });
  it('пол вне сетки сотых не даёт броска ниже показанного края вилки', () => {
    expect(snapFloor(0.07)).toBe(0.07);
    expect(snapFloor(0.333)).toBe(0.34);
    const rng = createRng(11);
    for (let i = 0; i < 5000; i++) for (const q of Object.values(rollBaseQ(baseOf('long-sword'), rng, 0.333)!)) expect(q!).toBeGreaterThanOrEqual(0.34);
  });
  it('строка доводки действует своими числами, где бы ни стояла: «первая = без доводки» — только данные', () => {
    const rows = reg.get('balance').craft.finish;
    const cut = new ConfigRegistry();
    cut.loadAll({ ...defaultConfigData, balance: { ...(defaultConfigData.balance as object), craft: { ...reg.get('balance').craft, finish: rows.slice(1) } } });
    const input = buildFor('long-sword', uniform(3));
    const a = craftWeapon(cut, { ...input, finish: 0 }), z = craftWeapon(reg, { ...input, finish: 1 });
    expect(a.cost!.finish?.floor).toBe(rows[1]!.floor);
    expect(a.cost!.gold).toBe(z.cost!.gold);
    expect(a.ranges).toEqual(z.ranges);
  });
  it('⚠ скованную не поднимает кузнечный подъём тира: он стёр бы детали, а доводка доехала бы до мифика', () => {
    const forged = craftWeapon(reg, { ...buildFor('long-sword', uniform(1)), finish: 3 }, { rng: createRng(2) }).item!;
    expect(upgradedItem(reg, forged)).toBeUndefined();
    const save = newBotSave(reg, 'warrior');
    save.inventory.push(forged); save.gold = 1e9;
    const r = forgeUpgrade(reg, save, forged.uid, {});
    expect(r.ok).toBe(false);
    expect(forged.tier).toBe(craftTiers(reg)[0]!.id);
  });
  it('доводка стоит сырья ударной части и золота; переплавка её НЕ возвращает', () => {
    const input = buildFor('long-sword', uniform(3));
    const top = reg.get('balance').craft.finish.length - 1;
    const a = craftWeapon(reg, { ...input, finish: 0 }), z = craftWeapon(reg, { ...input, finish: top });
    const f = finishOf(reg, top);
    const strikeId = a.cost!.lines.find((l) => l.slot === 'strike')!.id;
    expect(z.cost!.materials[strikeId]).toBe(a.cost!.materials[strikeId]! + f.strikeUnits);
    expect(z.cost!.gold).toBe(Math.round(a.cost!.gold * f.goldMult));
    expect(z.cost!.lines).toEqual(a.cost!.lines);
    const forged = craftWeapon(reg, { ...input, finish: top }, { rng: createRng(1) }).item!;
    expect(meltReturn(reg, forged)).toEqual(meltReturn(reg, a.item!));
  });
});

describe('цена: каждая деталь своим материалом, по массе (§13)', () => {
  it('клинок — 16 единиц своего материала, остальные детали — по 8, всё × M формы', () => {
    const input = buildFor('long-sword', { strike: 3, grip: 2, bind: 3, head: 1 });
    const r = craftWeapon(reg, input);
    const M = r.cost!.mult;
    expect(r.cost!.materials['iron-3']).toBe(Math.ceil(16 * M));
    expect(r.cost!.materials['hide-2']).toBe(Math.ceil(8 * M));
    expect(r.cost!.materials['trim-3']).toBe(Math.ceil(8 * M));
    expect(r.cost!.materials['trim-1']).toBe(Math.ceil(8 * M));
  });
  it('⭐ «сковать и переплавить» ни на одной ступени не возвращает больше потраченного', () => {
    for (let k = 1; k <= 5; k++) {
      const res = craftWeapon(reg, buildFor('long-sword', uniform(k)));
      if (!res.ok) continue;
      expect(value(meltReturn(reg, res.item!)), `ст.${k}`).toBeLessThan(value(res.cost!.materials));
    }
  });
});

describe('журнал кузнеца: разобрал — открыл (§12)', () => {
  const drop = (baseId: string, level: number, seed: number) => generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: level, tierLevel: level, baseId, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
    forceRarity: 'normal', maxReqTotal: reg.get('balance').maxTotalRequirement, origin: 'drop',   // находка: журнал учит деталям только её
  }, createRng(seed));
  it('детали найденной вещи выводятся из неё самой — одна вещь всегда даёт одно и то же', () => {
    const it1 = drop('war-axe', 30, 5);
    expect(partsOf(reg, it1)).toEqual(partsOf(reg, { ...it1 }));
  });
  it('⭐ тождество разбора: тип найденной вещи = её база, а ступень из её деталей = её ступень', () => {
    let exact = 0, total = 0;
    for (const b of weapons) for (const lvl of [1, 12, 25, 40, 55, 70, 85]) {
      const it1 = drop(b.id, lvl, lvl * 7 + b.id.length);
      const picks = partsOf(reg, it1)!;
      expect(picks, `${b.id} ур.${lvl}`).toBeTruthy();
      expect(typeOfItem(reg, it1)?.baseId, `${b.id} ур.${lvl}`).toBe(b.id);
      total++;
      if (tierOfSteps(reg, picks).tier === tierIndexOfItem(reg, it1)) exact++;
    }
    expect(exact).toBe(total);
  });
  it('⭐ разбор отдаёт семьи деталей по РЕЦЕПТУ ступени вещи; редкость единиц не добавляет (за неё — эссенция)', () => {
    const recipe = reg.get('balance').salvage.recipeByTier;
    for (const lvl of [1, 8, 18, 30, 45, 62, 80]) {
      const it1 = drop('long-sword', lvl, 3);
      const t = tierIndexOfItem(reg, it1);
      const y = craftSalvageYield(reg, it1);
      // Семья — от детали (меч: клинок — железо, держак — кожа, обвязка и оголовье — прибор), единицы — 3/2/1/1, сорт — строка рецепта ступени.
      const anat = anatomyOf(reg, 'sword')!;
      const picks = partsOf(reg, it1)!;
      const units = reg.get('balance').craft.salvage.units;
      const want: Record<string, number> = {};
      CRAFT_SLOT_LIST.forEach((sl, i) => {
        const id = `${partFamily(anat, sl, partById(reg, picks[sl].id)!)}-${recipe[t]![i]}`;
        want[id] = (want[id] ?? 0) + units[sl];
      });
      expect(y, `ур.${lvl} t${t}`).toEqual(want);
      expect(craftSalvageYield(reg, { ...it1, rarity: 'rare' }), `ур.${lvl}: редкость не в счёт`).toEqual(y);
    }
    // ⭐ Неровные детали сорт не «протекают»: ступень клинка детали другая — сырьё то же (было: топор t4 5/3/3/3 давал Булат).
    const it1 = drop('long-sword', 45, 3);
    const parts = partsOf(reg, it1)!;
    const p = partById(reg, parts.strike.id)!;
    const odd = { ...it1, foundParts: { ...parts, strike: { ...parts.strike, step: p.stepMax } } };
    expect(craftSalvageYield(reg, odd)).toEqual(craftSalvageYield(reg, it1));
  });
  it('⭐ каждая строка рецепта куётся ровно в свою ступень (рецепт своей ступени, §4.1)', () => {
    const recipe = reg.get('balance').salvage.recipeByTier;
    expect(recipe).toHaveLength(craftTiers(reg).length);
    recipe.forEach((row, t) => {
      const picks = Object.fromEntries(CRAFT_SLOT_LIST.map((sl, i) => [sl, { step: row[i]! }])) as Record<CraftSlot, { step: number }>;
      expect(tierOfSteps(reg, picks).tier, `строка t${t}: ${row.join('/')}`).toBe(t);
    });
  });
  it('разбор открывает базу и четыре детали, а каждые N разборов класса дают эскиз', () => {
    let j = emptyJournal();
    const n = reg.get('balance').craft.journal.sketchAfter;
    let sketches = 0;
    for (let i = 0; i < n; i++) {
      const r = salvageIntoJournal(reg, j, drop('war-axe', 10, 100 + i));
      if (i === 0) { expect(r.newBase).toBe(true); expect(r.unlocked.length).toBeGreaterThan(0); }
      if (r.sketch) sketches++;
      j = r.journal;
    }
    expect(j.bases).toContain('war-axe');
    expect(sketches).toBe(1);
  });
  it('⚠ эскиз не открывает ключевую форму неоткрытой базы — базы открываются только разбором', () => {
    const j = { ...emptyJournal(), bases: ['long-sword'], sketches: 3 };
    expect(sketchable(reg, j, 'sw-a-xviii')).toBe(true); // ключ открытой базы
    expect(sketchable(reg, j, 'sw-h-wavy')).toBe(false); // ключ неоткрытого огромного меча
    expect(sketchable(reg, j, 'sw-gd-rings')).toBe(true); // не ключ
    expect(useSketch(reg, j, 'sw-h-wavy')).toBe(j);
    expect(useSketch(reg, j, 'sw-gd-rings').variants).toContain('sw-gd-rings');
  });
  it('⭐ D3: разбор не двигает прежние ворота — ни потолок ступени, ни счёт мификов (поля старого журнала — как были)', () => {
    const mythicFind = craftWeapon(reg, buildFor('long-sword', stepsForTierOf('long-sword', 6)!)).item!;
    const found = { ...mythicFind, parts: undefined, origin: 'drop' as const, foundParts: mythicFind.parts };
    for (const legacy of [{ tierHi: -1, mythic: 0 }, { tierHi: 3, mythic: 4 }]) {
      const r = salvageIntoJournal(reg, { ...emptyJournal(), ...legacy }, found);
      expect({ tierHi: r.journal.tierHi, mythic: r.journal.mythic }).toEqual(legacy);
      expect(r.journal.bases).toContain('long-sword');
    }
  });
  it('⭐ скованное (переплавка) журнал не пишет вовсе: его тип и детали известны по построению — ничего нового, ни кодекса, ни жалости', () => {
    const res = craftWeapon(reg, buildFor('long-sword', uniform(2)));
    // Даже с пустым журналом (скованное флагом стенда мимо журнала): запись копировала бы флаговые детали в настоящий журнал.
    const r = salvageIntoJournal(reg, emptyJournal(), res.item!);
    expect(r.journal).toEqual(emptyJournal());
    expect({ unlocked: r.unlocked, newBase: r.newBase, newType: r.newType, sketch: r.sketch }).toEqual({ unlocked: [], newBase: false, newType: undefined, sketch: false });
  });
  it('тег у варианта читается со словарным умолчанием', () => {
    const anat = anatomyOf(reg, 'sword')!;
    expect(tagValue(anat, 'strike', partById(reg, 'sw-a-x')!, 'edge')).toBe('double');
    expect(tagValue(anat, 'strike', partById(reg, 'sw-a-falchion')!, 'edge')).toBe('single');
  });
});

describe('⚠ R2-30: ступени деталей найденного — ровные вероятнее перекошенных НА ДЕЛЕ, а не на бумаге', () => {
  /**
   * Вес четвёрки `1/(1+Σ|s−q|)` предпочитал ровную ПО ОДНОЙ, но перекошенных четвёрок на ступень сотни — вместе
   * они перевешивали: у t2 ровная выпадала в 3 % случаев, ступень 5 была у 26 % находок, у t3 — у 48 %. Булат и
   * золочёный прибор (108 золота штука, верх лестницы §13) сыпались с обычных находок 18–30-го уровня. Меряем
   * НАСТОЯЩИМ путём дропа (`generateItem` → `shapeFoundWeapon`, детали замораживаются при рождении).
   */
  const k = reg.get('balance').craft.salvage;
  const UNITS: Record<CraftSlot, number> = { strike: k.units.strike, grip: k.units.grip, bind: k.units.bind, head: k.units.head };
  function measure(t: number, n: number): { seen: number; any5: number; tight: number; units5: number } {
    const tier = craftTiers(reg)[t]!;
    const rng = createRng(4200 + t);
    let seen = 0, any5 = 0, tight = 0, units5 = 0;
    for (let i = 0; i < n; i++) {
      const b = rng.pick(weapons);
      const it1 = shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: tier.minItemLevel, tierLevel: tier.minItemLevel, baseId: b.id, tiers: reg.get('item-tiers'),
        rarities: reg.get('rarities'), forceRarity: 'normal', baseRoll: reg.get('balance').loot.baseRoll, origin: 'drop',
      }, rng));
      if (it1.tier !== tier.id || !it1.foundParts) continue;
      seen++;
      const steps = CRAFT_SLOT_LIST.map((s) => it1.foundParts![s].step);
      if (Math.max(...steps) === 5) any5++;
      if (Math.max(...steps) - Math.min(...steps) <= 1) tight++;
      for (const s of CRAFT_SLOT_LIST) if (it1.foundParts[s].step === 5) units5 += UNITS[s];
    }
    return { seen, any5: any5 / seen, tight: tight / seen, units5: units5 / seen };
  }
  it('⭐ у t0–t3 ступень 5 — редкость (≤ 5 %), и на каждой ступени ≥ 70 % находок собраны в пределах одной ступени материала', () => {
    const bad: string[] = [];
    for (let t = 0; t < craftTiers(reg).length; t++) {
      const m = measure(t, 700);
      expect(m.seen, craftTiers(reg)[t]!.id).toBeGreaterThan(300);
      if (t <= 3 && m.any5 > 0.05) bad.push(`${craftTiers(reg)[t]!.id}: ступень 5 у ${(m.any5 * 100).toFixed(1)} % находок`);
      if (m.tight < 0.7) bad.push(`${craftTiers(reg)[t]!.id}: ровных (разброс ≤ 1) лишь ${(m.tight * 100).toFixed(0)} %`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('единиц ступени 5 за разбор обычной находки — таблица §10.9: до t3 почти ноль, t4 ≤ 0.5, t5 ≤ 1.2, у мифика — почти всё', () => {
    const cap = [0.05, 0.05, 0.05, 0.1, 0.5, 1.2, 7];
    for (let t = 0; t < craftTiers(reg).length; t++) {
      const m = measure(t, 700);
      expect(m.units5, craftTiers(reg)[t]!.id).toBeLessThanOrEqual(cap[t]!);
    }
    expect(measure(craftTiers(reg).length - 1, 300).units5, 'мифик сделан из булата').toBeGreaterThan(6);
  });
});

/**
 * ⚠ R17-03: ФОРМА ЁМКОСТИ БЕЗ ЦЕНЫ — ОТКАЗ ДО ПЛАТЫ, А НЕ ×1. `formMult` отдавал на форму, которой нет в `balance.craft.formMult`, ×1 —
 * цену самой бедной формы: 3+2 ковалась, зачаровывалась и перекатывалась вшестеро дешевле, молча. Схема теперь такую таблицу не
 * пропускает (сторож — `config/registry.test.ts`), но вещь без цены формы остаётся законно: хозяин опустил ёмкость до 4 и убрал
 * строки Σ5 — а мечи 3+2 уже в сумках. Правило R10-14: пустая цена — отказ, а не бесплатно.
 */
describe('⚠ R17-03: форма ёмкости без цены — отказ до платы, а не ×1', () => {
  const input = buildFor('long-sword', uniform(5));   // t6, форма 3+2 (M 5.97)
  /** Реестр, где у форм `keys` нет цены, — МИМО схемы: так выглядел конфиг до R17-03 (✕ в редакторе, старый оверрайд). */
  const unpriced = (...keys: string[]): ConfigRegistry => {
    const x = new ConfigRegistry();
    x.loadAll();
    const bal = structuredClone(x.get('balance'));
    for (const k of keys) delete bal.craft.formMult[k];
    (x as unknown as { data: Record<string, unknown> }).data.balance = bal;
    return x;
  };
  /** Законный путь к вещи без цены формы (схема его пускает): ёмкость опущена до 4, строки 3+2 и 2+3 убраны. */
  const lowered = (): ConfigRegistry => {
    const x = new ConfigRegistry();
    x.loadAll();
    const bal = structuredClone(x.get('balance'));
    bal.craft.capacityByTier = bal.craft.capacityByTier.map((n) => Math.min(n, 4));
    delete bal.craft.formMult['3+2'];
    delete bal.craft.formMult['2+3'];
    x.reload({ balance: bal });
    return x;
  };
  const bag = (it: Item): SaveState => ({ gold: 1e9, inventory: [it] }) as unknown as SaveState;

  it('ковка формы без цены — отказ, а не сырьё ×1; прочие формы — прежней ценой', () => {
    const live = craftWeapon(reg, input);
    expect(live.item?.affixCap, 'предусловие: t6 3+2').toEqual({ prefix: 3, suffix: 2 });
    const cut = unpriced('3+2');
    const r = craftWeapon(cut, input);
    expect(r.ok, `сырьё ${JSON.stringify(r.cost?.materials)} при ${JSON.stringify(live.cost?.materials)}`).toBe(false);
    expect(r.reason).toMatch(/без цены/);
    expect(r.item).toBeUndefined();
    const t3 = buildFor('long-sword', uniform(3));   // 2+2 — строка на месте
    expect(craftWeapon(cut, t3).cost).toEqual(craftWeapon(reg, t3).cost);
  });

  it('зачарование до редкого и перекатка редкой 3+2 — отказ до платы; магическая катает 1+1 и платит, как прежде', () => {
    const forged = craftWeapon(reg, input, { rng: createRng(5) }).item!;
    const rare = enchantItem(reg, forged, 'rare', createRng(3))!;
    for (const [how, x] of [['ёмкость до 4, строки Σ5 убраны', lowered()], ['строки 3+2 нет (мимо схемы)', unpriced('3+2')]] as const) {
      const can = canEnchantItem(x, forged, 'rare');
      expect(can.ok, `${how}: зачарование до редкого`).toBe(false);
      expect(can.reason).toMatch(/без цены/);
      const s1 = bag(structuredClone(forged));
      const was1 = JSON.stringify(s1);
      expect(enchantAction(x, s1, forged.uid, 'rare', createRng(1), undefined, essWallet()).ok).toBe(false);
      expect(JSON.stringify(s1), `${how}: отказ зачарования не тронул ни золото, ни вещь`).toBe(was1);

      const rr = canRerollItem(x, rare);
      expect(rr.ok, `${how}: перекатка редкой 3+2`).toBe(false);
      expect(rr.reason).toMatch(/без цены/);
      const s2 = bag(structuredClone(rare));
      const was2 = JSON.stringify(s2);
      expect(forgeReroll(x, s2, rare.uid, createRng(9), undefined, essWallet()).ok).toBe(false);
      expect(JSON.stringify(s2), `${how}: отказ перекатки не тронул ни золото, ни вещь`).toBe(was2);

      // Магическая у 3+2 катает 1+1 (R2-23) — у неё цена есть: зачарование и перекатка идут прежней ценой.
      expect(canEnchantItem(x, forged, 'magic').ok, `${how}: до магической`).toBe(true);
      expect(enchantCost(x, forged, 'magic')).toBe(enchantCost(reg, forged, 'magic'));
      const magic = enchantItem(reg, forged, 'magic', createRng(4))!;
      expect(canRerollItem(x, magic).ok, `${how}: перекатка магической`).toBe(true);
      expect(forgeGold(x, magic, 'reroll')).toBe(forgeGold(reg, magic, 'reroll'));
    }
  });

  it('переплавка старой вещи без записи оплаты формы без цены — не больше, чем по живой цене (застрять вещь не должна)', () => {
    const old = { ...craftWeapon(reg, input, { rng: createRng(6) }).item! };
    delete old.craftPaid;   // вещь старше записи оплаты — переплавка по нынешней цене
    const live = meltReturn(reg, old), cut = meltReturn(unpriced('3+2'), old);
    expect(Object.keys(cut).length, 'переплавка вернула сырьё').toBeGreaterThan(0);
    for (const [id, n] of Object.entries(cut)) expect(n, id).toBeLessThanOrEqual(live[id] ?? 0);
  });
});
