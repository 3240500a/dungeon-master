import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import {
  anatomyOf, bakeParts, baseTierRange, capacityOf, clampStep, craftCost, craftSalvageYield, craftTiers, craftWeapon,
  emptyJournal, enchantItem, finishOf, formOf, fullJournal, journalTierCap, keyVariantsByBase, meltReturn, partById,
  partsOf, resolveParts, salvageIntoJournal, sketchable, tierIndexOfItem, tierOfSteps, typeOfItem, useSketch,
  variantsFor, type CraftInput,
} from './craft.js';
import {
  CRAFT_SLOT_LIST, agree, baseOfKeyPart, familiesOf, keySlotOf, matchWhen, resolveType, tagValue,
  typesRow, type CraftSlot, type PartSet,
} from './craftType.js';
import {
  DEFAULT_ROLL_SPREAD, baseStatRange, fixedBaseRoll, generateItem, inferTierId, retierItem, rollBaseQ, scaleBaseStats, snapFloor,
} from './itemgen.js';
import { describeItem } from './itemDescribe.js';
import { weaponCard } from './craftCard.js';
import { makePlayerModel, newBotSave } from '../sim/playerBot.js';

const ITEM_LABELS = { armorClass: (id: string) => id, weight: (id: string) => id, physSub: (id: string) => id, skill: (id: string) => id, dmgShort: (dt: string) => dt };
import { createRng } from './rng.js';
import { forgeReroll, forgeUpgrade, upgradedItem } from '../economy/townActions.js';
import type { SaveState } from '../types/save.js';
import type { CraftParts } from '../types/items.js';

const reg = new ConfigRegistry();
reg.loadAll();
type WBase = Extract<ReturnType<typeof reg.get<'items.base'>>[number], { kind: 'weapon' }>;
const weapons = reg.get('items.base').filter((b): b is WBase => b.kind === 'weapon');
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

/** Сборка базы: в каждом гнезде ближайший к эталону вариант, чьё окно берёт нужную ступень. */
function buildFor(baseId: string, steps: Steps, pick: Partial<Record<CraftSlot, string>> = {}): CraftInput {
  const b = baseOf(baseId);
  const pools = poolsOf(baseId);
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const want = steps[slot];
    const p = pick[slot] ? partById(reg, pick[slot]!)! : [...pools[slot]].filter((v) => v.stepMin <= want && want <= v.stepMax).sort((x, y) => Math.abs(x.axis) - Math.abs(y.axis))[0] ?? pools[slot][0]!;
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
  it('покрытие оси: ключевые формы каждой базы (ключ — ударная часть) дотягиваются до −1 и +1', () => {
    for (const b of weapons) {
      if (keySlotOf(reg, b.weaponClass) !== 'strike') continue;
      const axes = poolsOf(b.id).strike.map((p) => p.axis);
      expect(Math.min(...axes), b.id).toBeLessThanOrEqual(-0.99);
      expect(Math.max(...axes), b.id).toBeGreaterThanOrEqual(0.99);
    }
  });
  it('⭐ на ЛЮБОЙ ступени материала у базы есть и тяжёлая, и лёгкая форма — ступень не выбирает стиль боя', () => {
    for (const b of weapons) {
      if (keySlotOf(reg, b.weaponClass) !== 'strike') continue;
      const pool = poolsOf(b.id).strike;
      for (let s = 1; s <= 5; s++) {
        const at = pool.filter((p) => p.stepMin <= s && s <= p.stepMax);
        if (!at.length) continue;
        expect(at.some((p) => p.axis > 0) && at.some((p) => p.axis < 0), `${b.id} ст.${s}`).toBe(true);
      }
    }
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
  it('каролингский меч узнаётся по деталям, формула — в духе Элмсли', () => {
    const input = buildFor('long-sword', uniform(2), { strike: 'sw-a-x', grip: 'sw-gr-one', bind: 'sw-gd-short', head: 'sw-pm-lobed' });
    const t = resolveType(reg, 'sword', 1, partsSet(input));
    expect(t.name).toBe('Каролингский меч');
    expect(t.typeId).toBe('sw-carolingian');
    expect(t.formula).toBe('Окшотт: клинок X · перекрестье 3 · навершие трёхчастное');
    const r = craftWeapon(reg, input);
    expect(r.item!.name).toBe('Крепкий каролингский меч');
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
    expect(t.name).toBe('Узкий меч позднего образца');
    const spear = buildFor('pike', uniform(3), { strike: 'sp-awl', grip: 'sp-gr2-heel' });
    expect(resolveType(reg, 'spear', 2, partsSet(spear)).name).toBe('Шиловидная пика');
    expect(agree('поздний', 'f')).toBe('поздняя');
    expect(agree('широкий', 'n')).toBe('широкое');
    expect(agree('каролингский', 'f')).toBe('каролингская');
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
    const light = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-xi' })).item!;
    const plain = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-xii' })).item!;
    const f = (it: typeof light, st: string) => it.baseStats.find((m) => m.stat === st && m.kind === 'flat')?.value ?? 0;
    const k = reg.get('balance').craft.strike;
    expect(light.damageMult).toBeCloseTo(1 - 0.6 * k.damagePct, 6);
    expect(plain.damageMult).toBeUndefined();
    expect(f(light, 'maxDamage')).toBe(f(plain, 'maxDamage')); // цифры базы в статах не трогаем
    expect(f(light, 'attackSpeed')).toBeCloseTo(0.6 * k.attackSpeed, 6);
    const lines = describeItem(light, ITEM_LABELS).map((l) => l.text);
    // Предпросмотр — вилкой, и она тоже умножена на форму клинка.
    const r = light.rollPreview!, dm = light.damageMult!, R = (v: number) => Math.round(v * dm);
    expect(lines.find((t) => t.startsWith('Урон:'))).toContain(`(${R(r.minDamage![0])}–${R(r.minDamage![1])})–(${R(r.maxDamage![0])}–${R(r.maxDamage![1])})`);
    // Скованная (бросок случился) — просто числа × форма клинка.
    const forged = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-xi' }), { rng: createRng(7) }).item!;
    const shown = describeItem(forged, ITEM_LABELS).map((l) => l.text).find((t) => t.startsWith('Урон:'))!;
    expect(shown).toContain(`${R(f(forged, 'minDamage'))}–${R(f(forged, 'maxDamage'))} (`);
    expect(lines.some((t) => t.startsWith('Скорость: ×1.05'))).toBe(true);
    expect(lines.some((t) => /Скор\. атаки|урон/i.test(t) && !t.startsWith('Урон:'))).toBe(false);
  });
  it('⭐ соотношение ДПС форм одинаково у любого героя: атрибуты и бонусы форму не размывают', () => {
    const heavy = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-x' })).item!;
    const light = craftWeapon(reg, buildFor('long-sword', uniform(3), { strike: 'sw-a-xix' })).item!;
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
    const expected = ((1 + k.damagePct) * (1 - k.attackSpeed)) / ((1 - k.damagePct) * (1 + k.attackSpeed));
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
        const e = enchantItem(reg, res.item!, 'rare', createRng(100 + i));
        const kinds = new Map(e.affixes.map((a) => [a.affixId, a.kind]));
        const p = [...kinds.values()].filter((k) => k === 'prefix').length;
        expect({ p, s: kinds.size - p }).toEqual({ p: cap.prefix, s: cap.suffix });
      }
    }
    const caro = craftWeapon(reg, buildFor('long-sword', uniform(2), { strike: 'sw-a-x', grip: 'sw-gr-one', bind: 'sw-gd-short', head: 'sw-pm-lobed' })).item!;
    expect(enchantItem(reg, caro, 'magic', createRng(7)).name.toLowerCase()).toContain('каролингск');
  });
  it('⚠ перекатка у кузнеца не сносит купленную форму', () => {
    const res = craftWeapon(reg, buildFor('long-sword', { strike: 4, grip: 4, bind: 4, head: 3 }));
    const item = enchantItem(reg, res.item!, 'rare', createRng(3));
    const save = { gold: 1e9, inventory: [item] } as unknown as SaveState;
    for (let i = 0; i < 3; i++) {
      expect(forgeReroll(reg, save, item.uid, createRng(50 + i)).ok).toBe(true);
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
      const flat = (it: typeof found, stat: string) => it.baseStats.find((m) => m.stat === stat && m.kind === 'flat')?.value;
      // ⭐ Найденная и скованная катаются в ОДНОЙ вилке: края вилки ковки = найденная вещь на долях 0 и 1
      // (пересборка тира дропа — та же, что у кузницы), середина = прежнее число без броска.
      const spread = reg.get('balance').loot.baseRoll;
      const at = (q: number) => retierItem(b, { ...found, baseRoll: fixedBaseRoll(b, q) }, tier, { maxReqTotal: reg.get('balance').maxTotalRequirement, spread });
      for (const st of ['minDamage', 'maxDamage'] as const) {
        expect(res.ranges![st], `${b.id} ${st}`).toEqual([flat(at(0), st), flat(at(1), st)]);
        expect(flat(res.item!, st), `${b.id} ${st}`).toBe(flat(at(0.5), st));
        expect(flat(found, st)!, `${b.id} ${st}`).toBeGreaterThanOrEqual(res.ranges![st]![0]);
        expect(flat(found, st)!, `${b.id} ${st}`).toBeLessThanOrEqual(res.ranges![st]![1]);
      }
      expect(res.item!.requirements, b.id).toEqual(found.requirements);
    }
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
    const input = buildFor('long-sword', uniform(3), { strike: 'sw-a-x' });
    input.parts.strike.step = 5; // клинок X — только ступени 1–3
    const r = craftWeapon(reg, input);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ступеней 1–3/);
  });
  it('потолок базы уважается: короткий меч (maxTier t3) не куётся выше t3, и окно говорит почему', () => {
    const r = craftWeapon(reg, buildFor('short-sword', { strike: 3, grip: 5, bind: 5, head: 5 }));
    expect(r.ok).toBe(false);
    expect(r.tier).toBeGreaterThan(3);
    expect(r.reason).toMatch(/не бывает выше/);
  });
  it('журнал режет ступень, а t6 требует mythicSalvages мифических разборов', () => {
    const j = { ...fullJournal(reg), mythic: 0 };
    const r = craftWeapon(reg, buildFor('long-sword', stepsForTierOf('long-sword', 6)!), { journal: j });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/мифических/);
    expect(craftWeapon(reg, buildFor('long-sword', stepsForTierOf('long-sword', 6)!), { journal: fullJournal(reg) }).ok).toBe(true);
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
    const item = retierItem(b, { ...craftWeapon(reg, buildFor('long-sword', uniform(1))).item!, rollPreview: undefined, parts: undefined, damageMult: undefined, affixCap: undefined, baseRoll: { minDamage: 0.9, maxDamage: 0.2 } }, lo, { spread });
    const up = upgradedItem(reg, item)!;
    expect(up.baseRoll).toEqual({ minDamage: 0.9, maxDamage: 0.2 });
    const next = tiers.find((x) => x.id === up.tier)!;
    expect(up.baseStats.filter((m) => m.stat !== 'attackSpeed')).toEqual(
      scaleBaseStats(b.baseStats, next.statMult, { minDamage: 0.9, maxDamage: 0.2 }, spread).filter((m) => m.stat !== 'attackSpeed'));
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
    forceRarity: 'normal', maxReqTotal: reg.get('balance').maxTotalRequirement,
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
  it('разбор отдаёт материалы деталей их ступеней; редкость добавляет единицы клинку', () => {
    const it1 = drop('long-sword', 40, 3);
    const picks = partsOf(reg, it1)!;
    const y = craftSalvageYield(reg, it1);
    expect(y[`iron-${picks.strike.step}`]).toBeGreaterThanOrEqual(3);
    const rare = craftSalvageYield(reg, { ...it1, rarity: 'rare' });
    expect(rare[`iron-${picks.strike.step}`]).toBe((y[`iron-${picks.strike.step}`] ?? 0) + 2);
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
    expect(sketchable(reg, j, 'sw-a-xv')).toBe(true);    // ключ открытой базы
    expect(sketchable(reg, j, 'sw-h-wavy')).toBe(false); // ключ неоткрытого огромного меча
    expect(sketchable(reg, j, 'sw-gd-rings')).toBe(true); // не ключ
    expect(useSketch(reg, j, 'sw-h-wavy')).toBe(j);
    expect(useSketch(reg, j, 'sw-gd-rings').variants).toContain('sw-gd-rings');
  });
  it('⭐ t6 не открывается одной мифической вещью — нужно mythicSalvages штук', () => {
    const j = { ...emptyJournal(), tierHi: 6, mythic: 1 };
    expect(journalTierCap(reg, j)).toBe(5);
    expect(journalTierCap(reg, { ...j, mythic: reg.get('balance').craft.journal.mythicSalvages })).toBe(6);
    expect(journalTierCap(reg, fullJournal(reg))).toBe(6);
  });
  it('скованное не открывает журнал — у него свой глагол «переплавить»', () => {
    const res = craftWeapon(reg, buildFor('long-sword', uniform(2)));
    const r = salvageIntoJournal(reg, emptyJournal(), res.item!);
    expect(r.unlocked).toEqual([]);
    expect(r.journal.bases).toEqual([]);
  });
  it('тег у варианта читается со словарным умолчанием', () => {
    const anat = anatomyOf(reg, 'sword')!;
    expect(tagValue(anat, 'strike', partById(reg, 'sw-a-x')!, 'edge')).toBe('double');
    expect(tagValue(anat, 'strike', partById(reg, 'sw-a-falchion')!, 'edge')).toBe('single');
  });
});
