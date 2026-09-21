import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  CRAFT_SLOT_LIST, anatomyOf, bakeParts, craftCost, craftTierRange, craftTiers, craftWeapon, defaultParts,
  emptyJournal, enchantItem, formOf, fullJournal, journalTierCap, materialBand, meltReturn, partsOf,
  resolveParts, salvageIntoJournal, salvageStep, stepsForTier, variantsFor, type CraftSlot,
} from './craft.js';
import { generateItem, itemFromBaseId } from './itemgen.js';
import { createRng } from './rng.js';
import { forgeReroll } from '../economy/townActions.js';
import type { SaveState } from '../types/save.js';

const reg = new ConfigRegistry();
reg.loadAll();
const weapons = reg.get('items.base').filter((b) => b.kind === 'weapon');
const CLASSES = [...new Set(weapons.map((w) => (w as { weaponClass: string }).weaponClass))];
const price = new Map(reg.get('craft-materials').map((m) => [m.id, m.sellPrice]));
const value = (c: Record<string, number>): number => Object.entries(c).reduce((s, [id, n]) => s + (price.get(id) ?? 0) * n, 0);

describe('материалы: одна полоса на все семьи (docs/CRAFT_WEAPONS.md §10.1)', () => {
  it('ступень k строит t(k)…t(k+1), первая — t0…t2', () => {
    expect([1, 2, 3, 4, 5].map(materialBand)).toEqual([
      { lo: 0, hi: 2 }, { lo: 2, hi: 3 }, { lo: 3, hi: 4 }, { lo: 4, hi: 5 }, { lo: 5, hi: 6 },
    ]);
  });
  it('на t2…t5 на выбор ровно два материала — дешёвый на потолке и дорогой на полу', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((t) => stepsForTier(t).length)).toEqual([1, 1, 2, 2, 2, 2, 1]);
  });
});

describe('анатомия: четыре гнезда у всех десяти классов', () => {
  it('у каждого класса оружия есть анатомия, и её семьи существуют в craft-materials', () => {
    const fams = new Set(reg.get('craft-materials').map((m) => m.family));
    for (const cls of CLASSES) {
      const a = anatomyOf(reg, cls);
      expect(a, cls).toBeTruthy();
      for (const s of CRAFT_SLOT_LIST) expect(fams.has(a![s].family), `${cls}.${s}`).toBe(true);
    }
  });
  it('⭐ ровно три семьи на вещь — не пятнадцать материалов ради одного меча (§10.7)', () => {
    for (const cls of CLASSES) {
      const a = anatomyOf(reg, cls)!;
      expect(new Set(CRAFT_SLOT_LIST.map((s) => a[s].family)).size, cls).toBe(3);
    }
  });
  it('в каждом гнезде каждого класса есть выбор — хотя бы три варианта с обеих сторон оси', () => {
    for (const cls of CLASSES) for (const s of CRAFT_SLOT_LIST) {
      const v = variantsFor(reg, cls, s);
      expect(v.length, `${cls}.${s}`).toBeGreaterThanOrEqual(3);
      expect(v.some((p) => p.axis > 0) && v.some((p) => p.axis < 0), `${cls}.${s}`).toBe(true);
    }
  });
  it('у каждого варианта есть подпись-следствие: строка без неё — незаконченная (§17)', () => {
    for (const p of reg.get('weapon-parts')) expect(p.caption.trim().length, p.id).toBeGreaterThan(0);
    const ids = reg.get('weapon-parts').map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/** Запечь сборку «все гнёзда эталон, кроме одного на заданной оси». */
function bakeWith(baseId: string, slot: CraftSlot, axisSign: 1 | -1) {
  const base = weapons.find((b) => b.id === baseId)! as Extract<(typeof weapons)[number], { kind: 'weapon' }>;
  const parts = defaultParts(reg, base.weaponClass)!;
  const pool = variantsFor(reg, base.weaponClass, slot);
  parts[slot] = (axisSign > 0 ? pool[0] : pool[pool.length - 1])!.id;
  const res = resolveParts(reg, base.weaponClass, parts);
  if (!res.ok) throw new Error(res.reason);
  return { base, bake: bakeParts(reg, base, 3, res.parts) };
}

describe('⭐ замок «одна ось ДПС»: вклад выводится из оси, а не пишется руками', () => {
  const DPS_STATS = new Set(['damagePct', 'attackSpeed']);
  it('ударная часть пишет ТОЛЬКО урон и скорость, остальные гнёзда — ни то ни другое', () => {
    for (const b of weapons) for (const slot of CRAFT_SLOT_LIST) for (const sign of [1, -1] as const) {
      const { bake } = bakeWith(b.id, slot, sign);
      const touchesDps = bake.mods.some((m) => DPS_STATS.has(m.stat));
      expect(touchesDps, `${b.id} ${slot} ${sign}`).toBe(slot === 'strike');
    }
  });
  it('урон и скорость ударной части зеркальны: +урон всегда платит скоростью', () => {
    const { bake: heavy } = bakeWith('long-sword', 'strike', 1);
    const dmg = heavy.mods.find((m) => m.stat === 'damagePct')!.value;
    const spd = heavy.mods.find((m) => m.stat === 'attackSpeed')!.value;
    expect(dmg).toBeGreaterThan(0);
    expect(spd).toBeLessThan(0);
  });
  it('разброс ДПС по оси ударной части ≤ 8 % во всём объявленном конверте (§4)', () => {
    const k = reg.get('balance').craft.strike;
    let worst = 0;
    for (let D = 0.3; D <= 1.5 + 1e-9; D += 0.1) for (let S = 0.05; S <= 0.6 + 1e-9; S += 0.05) {
      const dps = [-1, -0.5, 0, 0.5, 1].map((a) => (1 + D + k.damagePct * a) * (1 + S - k.attackSpeed * a));
      worst = Math.max(worst, Math.max(...dps) / Math.min(...dps) - 1);
    }
    expect(worst).toBeLessThanOrEqual(0.08);
  });
});

describe('⭐ держак площадь-нейтрален: `дуга × дальность²` постоянна (§5.1)', () => {
  it('у каждого варианта держака на каждой базе ближнего боя площадь = площади базы ± 0.5 %', () => {
    for (const b of weapons.filter((w) => w.attackType === 'melee')) for (const sign of [1, -1] as const) {
      const { base, bake } = bakeWith(b.id, 'grip', sign);
      const baseArea = (base.arcMult ?? 1) * (base.reachMult ?? 1) ** 2;
      const area = bake.arcMult! * bake.reachMult! ** 2;
      expect(Math.abs(area / baseArea - 1), `${b.id} ${sign}`).toBeLessThan(0.005);
    }
  });
  it('длинный держак действительно дальше, короткий — шире', () => {
    const long = bakeWith('long-sword', 'grip', 1).bake, short = bakeWith('long-sword', 'grip', -1).bake;
    expect(long.reachMult!).toBeGreaterThan(1);
    expect(short.arcMult!).toBeGreaterThan(1);
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
  it('⭐ зачарование до редкого ложится РОВНО в объявленную форму', () => {
    const base = weapons.find((b) => b.id === 'long-sword')!;
    const parts = defaultParts(reg, 'sword')!;
    for (const bindAxis of [1, -1]) {
      const pool = variantsFor(reg, 'sword', 'bind');
      parts.bind = (bindAxis > 0 ? pool[0] : pool[pool.length - 1])!.id;
      const res = craftWeapon(reg, { baseId: base.id, tier: 4, step: 4, parts });
      expect(res.ok, res.reason).toBe(true);
      const cap = res.item!.affixCap!;
      for (let i = 0; i < 60; i++) {
        const e = enchantItem(reg, res.item!, 'rare', createRng(100 + i));
        const kinds = new Map(e.affixes.map((a) => [a.affixId, a.kind]));
        const p = [...kinds.values()].filter((k) => k === 'prefix').length;
        expect({ p, s: kinds.size - p }).toEqual({ p: cap.prefix, s: cap.suffix });
      }
    }
  });
  it('⚠ перекатка у кузнеца не сносит купленную форму', () => {
    const res = craftWeapon(reg, { baseId: 'long-sword', tier: 4, step: 4, parts: defaultParts(reg, 'sword')! });
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
      const t = craftTiers(reg).findIndex((x) => x.id === (b.maxTier ?? 't6'));
      const step = t === 6 ? 5 : Math.max(1, Math.min(5, t));
      const res = craftWeapon(reg, { baseId: b.id, tier: t, step, parts: defaultParts(reg, (b as { weaponClass: string }).weaponClass)! });
      expect(res.ok, `${b.id}: ${res.reason}`).toBe(true);
      // Найденная — через ДРОП (generateItem), то есть другим путём, чем ковка.
      const tier = craftTiers(reg)[t]!;
      const found = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: tier.minItemLevel, tierLevel: tier.minItemLevel, baseId: b.id,
        tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), forceRarity: 'normal',
        maxReqTotal: reg.get('balance').maxTotalRequirement,
      }, createRng(1));
      expect(found.tier, b.id).toBe(tier.id);
      const flat = (it: typeof found, stat: string) => it.baseStats.find((m) => m.stat === stat && m.kind === 'flat')?.value;
      expect(flat(res.item!, 'minDamage'), b.id).toBe(flat(found, 'minDamage'));
      expect(flat(res.item!, 'maxDamage'), b.id).toBe(flat(found, 'maxDamage'));
      expect(res.item!.requirements, b.id).toEqual(found.requirements);
    }
  });
  it('вещь выходит ОБЫЧНОЙ, без аффиксов, с записанными деталями и ёмкостью', () => {
    const res = craftWeapon(reg, { baseId: 'battle-axe', tier: 3, step: 3, parts: defaultParts(reg, 'axe')! });
    expect(res.item!.rarity).toBe('normal');
    expect(res.item!.affixes).toEqual([]);
    expect(res.item!.parts?.step).toBe(3);
    expect(res.item!.affixCap).toEqual({ prefix: 2, suffix: 2 });
  });
  it('⭐ ступень вне полосы материала не куётся — «дешёвой t6» не существует (Р6)', () => {
    const parts = defaultParts(reg, 'sword')!;
    expect(craftWeapon(reg, { baseId: 'long-sword', tier: 6, step: 1, parts }).ok).toBe(false);
    expect(craftWeapon(reg, { baseId: 'long-sword', tier: 0, step: 5, parts }).ok).toBe(false);
    expect(craftWeapon(reg, { baseId: 'long-sword', tier: 6, step: 5, parts }).ok).toBe(true);
  });
  it('потолок базы уважается: короткий меч (maxTier t3) не куётся выше t3', () => {
    const r = craftTierRange(reg, weapons.find((b) => b.id === 'short-sword')!, 4);
    expect(r).toBeNull();
  });
});

describe('цена: относительная, и переплавка не печатает деньги (§13)', () => {
  it('тир X платится ступенью ниже выбранной и самой выбранной', () => {
    const base = weapons.find((b) => b.id === 'long-sword')! as Parameters<typeof craftCost>[1];
    const c = craftCost(reg, base, 5, 5, { prefix: 2, suffix: 2 });
    const steps = new Set(Object.keys(c.materials).map((id) => Number(id.split('-')[1])));
    expect([...steps].sort()).toEqual([4, 5]);
  });
  it('⭐ «сковать и переплавить» ни на одной паре ступеней не возвращает больше потраченного', () => {
    for (let step = 1; step <= 5; step++) {
      const band = materialBand(step);
      for (let t = band.lo; t <= band.hi; t++) {
        const res = craftWeapon(reg, { baseId: 'long-sword', tier: t, step, parts: defaultParts(reg, 'sword')! });
        if (!res.ok) continue;
        expect(value(meltReturn(reg, res.item!)), `t${t} ст.${step}`).toBeLessThan(value(res.cost!.materials));
      }
    }
  });
});

describe('журнал кузнеца: разобрал — открыл (§12)', () => {
  it('детали найденной вещи выводятся из неё самой — одна вещь всегда даёт одно и то же', () => {
    const it1 = itemFromBaseId(reg.get('items.base'), 'war-axe', reg.get('item-tiers'))!;
    expect(partsOf(reg, it1)).toEqual(partsOf(reg, { ...it1 }));
  });
  it('ступень сырья = та, из которой вещь и была бы собрана (§10.9)', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((t) => salvageStep(t, 'normal'))).toEqual([1, 1, 1, 2, 3, 4, 5]);
    expect([0, 1, 2, 3, 4, 5, 6].map((t) => salvageStep(t, 'rare'))).toEqual([1, 1, 2, 3, 4, 5, 5]);
    // Булат (5) ниже t5 физически недостижим.
    for (let t = 0; t < 5; t++) expect(salvageStep(t, 'rare')).toBeLessThan(5);
  });
  it('разбор открывает базу и четыре детали, а каждые N разборов класса дают эскиз', () => {
    let j = emptyJournal();
    const n = reg.get('balance').craft.journal.sketchAfter;
    let sketches = 0;
    for (let i = 0; i < n; i++) {
      const it1 = itemFromBaseId(reg.get('items.base'), 'war-axe', reg.get('item-tiers'))!;
      const r = salvageIntoJournal(reg, j, it1);
      if (i === 0) { expect(r.newBase).toBe(true); expect(r.unlocked.length).toBeGreaterThan(0); }
      if (r.sketch) sketches++;
      j = r.journal;
    }
    expect(j.bases).toContain('war-axe');
    expect(sketches).toBe(1);
  });
  it('⭐ t6 не открывается одной мифической вещью — нужно mythicSalvages штук', () => {
    const j = { ...emptyJournal(), tierHi: 6, mythic: 1 };
    expect(journalTierCap(reg, j)).toBe(5);
    expect(journalTierCap(reg, { ...j, mythic: reg.get('balance').craft.journal.mythicSalvages })).toBe(6);
    expect(journalTierCap(reg, fullJournal(reg))).toBe(6);
  });
  it('скованное не открывает журнал — у него свой глагол «переплавить»', () => {
    const res = craftWeapon(reg, { baseId: 'long-sword', tier: 2, step: 2, parts: defaultParts(reg, 'sword')! });
    const r = salvageIntoJournal(reg, emptyJournal(), res.item!);
    expect(r.unlocked).toEqual([]);
    expect(r.journal.bases).toEqual([]);
  });
});
