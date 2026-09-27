import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import {
  bakeParts, baseTierRange, craftWeapon, defaultParts, emptyJournal, enchantCost, enchantItem, fullJournal, keyVariantsByBase, resolveParts, salvageIntoJournal,
  shapeFoundWeapon, tierIndex, variantsFor, type CraftInput,
} from './craft.js';
import { generateItem, itemFromBaseId, pickTierClamped, rollTierLevel } from './itemgen.js';
import { createRng } from './rng.js';
import { canUpgradeItem, forgeGold, forgeUpgrade, upgradedItem } from '../economy/townActions.js';
import { newCharacterSave } from '../economy/newCharacter.js';
import { CRAFT_SLOT_LIST, keySlotOf } from './craftType.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐ R12-08: ВЫКЛЮЧЕННАЯ СТУПЕНЬ НЕ ДВИГАЕТ ТЕ, ЧТО УЖЕ ЕСТЬ. Хозяин выключает ступень в редакторе («выключенный не выбирается
 * при генерации»), а вещи этой ступени у игроков остаются. Раньше ступени считались по лестнице ВКЛЮЧЁННЫХ: своей ступени вещь
 * там не находила — и «улучшение» у кузнеца за золото и сырьё роняло её на t0 (t5-меч 30–53 → 7–12), зачарование скованной
 * t5 стоило как t0 (1 433 вместо 9 743), а выключенная средняя ступень сдвигала все индексы ковки: ёмкость аффиксов, потолок
 * журнала (хранится ИНДЕКСОМ в базе) и ступень из материалов уезжали на соседнюю. Теперь индекс — по ПОЛНОЙ лестнице, а
 * выключенная ступень лишь не рождается заново: подъём её перешагивает, ковка на неё — отказ.
 */

const live = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const ladder = [...live.get('item-tiers')].sort((a, b) => a.minItemLevel - b.minItemLevel);
const statMult = (id: string | undefined): number => ladder.find((t) => t.id === id)?.statMult ?? Number.NaN;
const minLevel = (id: string | undefined): number => ladder.find((t) => t.id === id)?.minItemLevel ?? Number.NaN;

const offCache = new Map<string, ConfigRegistry>();
/** Живой конфиг, где ступени `ids` выключены — ровно та правка, что делает галка редактора (`/api/dev/config` → `reload`). */
function tiersOff(...ids: string[]): ConfigRegistry {
  const key = [...ids].sort().join(',');
  const hit = offCache.get(key);
  if (hit) return hit;
  const r = new ConfigRegistry();
  r.loadAll();
  r.reload({ 'item-tiers': r.get('item-tiers').map((t) => (ids.includes(t.id) ? { ...t, enabled: false } : t)) });
  offCache.set(key, r);
  return r;
}

/** Найденная вещь базы на ступени `tierId` (бросок ступени — ровно её порог), как её кладёт дроп сервера. */
function found(baseId: string, tierId: string, rarity: Item['rarity'] = 'rare'): Item {
  const bal = live.get('balance');
  const lvl = minLevel(tierId);
  const it = shapeFoundWeapon(live, generateItem(live.get('items.base'), live.get('affixes'), live.get('uniques'), {
    dropBias: 1, itemLevel: lvl, tierLevel: lvl, baseId, tiers: live.get('item-tiers'), rarities: live.get('rarities'),
    rareNames: live.get('rare-names'), forceRarity: rarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
  }, createRng(lvl * 31 + baseId.length)));
  expect(it.tier).toBe(tierId);
  return { ...it, pos: { x: 0, y: 0 } };
}
const rich = (r: ConfigRegistry): Record<string, number> => Object.fromEntries(r.get('craft-materials').map((m) => [m.id, 99_999]));

const byTier = new Map<number, CraftInput>();
/**
 * Сборка меча, из которой живая ковка даёт ступень `t` (индекс полной лестницы). Детали — с самым широким окном материалов в
 * каждом гнезде: у эталонных окно кончается раньше пятой ступени, и мифик из них не собрать.
 */
function inputAt(t: number): CraftInput {
  const known = byTier.get(t);
  if (known) return structuredClone(known);
  const base = defaultParts(live, 'sword', 1, 1)!;
  for (const s of CRAFT_SLOT_LIST) {
    const pool = s === keySlotOf(live, 'sword')
      ? keyVariantsByBase(live, 'sword', 1).flatMap((g) => g.variants)
      : variantsFor(live, 'sword', s, 1);
    const wide = [...pool].sort((a, b) => (b.stepMax - b.stepMin) - (a.stepMax - a.stepMin) || a.id.localeCompare(b.id))[0];
    if (wide) base[s] = { id: wide.id, step: wide.stepMin };
  }
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) for (let c = 1; c <= 5; c++) for (let d = 1; d <= 5; d++) {
    const steps = [a, b, c, d];
    const parts = structuredClone(base);
    CRAFT_SLOT_LIST.forEach((s, i) => { parts[s].step = steps[i]!; });
    const input: CraftInput = { weaponClass: 'sword', hands: 1, parts };
    const pv = craftWeapon(live, input, { journal: fullJournal(live) });
    // Перебор один на все ступени: первая сборка каждой запоминается (иначе шесть переборов по 625 ковок на тест).
    if (pv.ok && pv.tier !== undefined && !byTier.has(pv.tier)) byTier.set(pv.tier, structuredClone(input));
  }
  const hit = byTier.get(t);
  if (!hit) throw new Error(`нет сборки ступени ${t}`);
  return structuredClone(hit);
}

describe('⭐ R12-08: выключенная ступень — подъём у кузнеца', () => {
  it('своя ступень вещи выключена: подъём только ВВЕРХ (или отказ), statMult не падает никогда', () => {
    for (const baseId of ['long-sword', 'leather-armor', 'short-bow']) {
      for (const cur of ladder) {
        const off = tiersOff(cur.id);
        const item = found(baseId, cur.id);
        const next = upgradedItem(off, item);
        const why = `${baseId} ${cur.id}`;
        if (next) expect(minLevel(next.tier), why).toBeGreaterThan(cur.minItemLevel);
        const save = { gold: 10_000_000, inventory: [structuredClone(item)] } as unknown as SaveState;
        const r = forgeUpgrade(off, save, item.uid, rich(off));
        const after = save.inventory.find((i) => i.uid === item.uid)!;
        expect(statMult(after.tier), why).toBeGreaterThanOrEqual(cur.statMult);
        if (!r.ok) expect(save.gold, `${why}: отказ — без оплаты`).toBe(10_000_000);
        else expect(statMult(after.tier), why).toBeGreaterThan(cur.statMult);
      }
    }
  });

  it('t6 выключен — мифические латы «улучшить» некуда (было: на t0 за золото)', () => {
    const off = tiersOff('t6');
    const item = found('leather-armor', 't6');
    expect(canUpgradeItem(off, item).ok).toBe(false);
    expect(upgradedItem(off, item)).toBeUndefined();
  });

  it('выключенную СЛЕДУЮЩУЮ ступень подъём перешагивает — и платит за ту, на которую встаёт', () => {
    const off = tiersOff('t4');
    const item = found('long-sword', 't3');
    const next = upgradedItem(off, item)!;
    expect(next.tier).toBe('t5');
    const t5 = ladder.find((t) => t.id === 't5')!;
    const rarity = live.get('rarities').find((r) => r.id === item.rarity)!;
    expect(forgeGold(off, item, 'upgrade')).toBe(Math.max(1, Math.round(live.get('balance').forgePrices.upgradeTier * t5.reqMult * rarity.priceMult)));
  });

  it('выключен потолок базы — выше него подъёма нет (было: потолок пропадал, и база шла до верха лестницы)', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    r.reload({
      'items.base': r.get('items.base').map((b) => (b.id === 'leather-armor' ? { ...b, maxTier: 't3' } : b)),
      'item-tiers': r.get('item-tiers').map((t) => (t.id === 't3' ? { ...t, enabled: false } : t)),
    });
    const item = found('leather-armor', 't2');
    expect(upgradedItem(r, item)).toBeUndefined();
    expect(canUpgradeItem(r, item).ok).toBe(false);
  });
});

describe('⭐ R12-08: выключенная ступень — ковка и зачарование', () => {
  it('зачарование скованной вещи стоит одинаково, выключена её ступень или нет — и имя с её приставкой', () => {
    for (let t = 1; t < ladder.length; t++) {
      const pv = craftWeapon(live, inputAt(t), { journal: fullJournal(live), rng: createRng(t) });
      const item = pv.item!;
      const off = tiersOff(item.tier!);
      for (const rarity of ['magic', 'rare'] as const) {
        expect(enchantCost(off, item, rarity), `${item.tier} ${rarity}`).toBe(enchantCost(live, item, rarity));
      }
      const liveName = enchantItem(live, item, 'magic', createRng(7))!.name;
      expect(enchantItem(off, item, 'magic', createRng(7))!.name, item.tier).toBe(liveName);
    }
  });

  it('выключенная средняя ступень не сдвигает ёмкость аффиксов (t4 выключен → у t5 ёмкость t5)', () => {
    const off = tiersOff('t4');
    const input = inputAt(5);
    const base = live.get('items.base').find((b) => b.id === craftWeapon(live, input).item!.baseId)!;
    const res = resolveParts(live, 'sword', 1, input.parts);
    if (!res.ok || base.kind !== 'weapon') throw new Error(res.ok ? 'не оружие' : res.reason);
    expect(bakeParts(off, base, tierIndex(off, 't5'), res.parts).affixCap).toEqual(bakeParts(live, base, tierIndex(live, 't5'), res.parts).affixCap);
    // И настоящая ковка: те же материалы — та же ступень и та же ёмкость, а не соседняя.
    const a = craftWeapon(live, input, { journal: fullJournal(live) });
    const b = craftWeapon(off, input, { journal: fullJournal(off) });
    expect(b.item?.tier).toBe('t5');
    expect(b.item?.affixCap).toEqual(a.item?.affixCap);
  });

  it('ковка на выключенную ступень — отказ, а не вещь соседней ступени', () => {
    const off = tiersOff('t4');
    const pv = craftWeapon(off, inputAt(4), { journal: fullJournal(off), materialsOn: true });
    expect(pv.ok).toBe(false);
    expect(pv.reason).toMatch(/не куёт/);
  });

  it('потолок журнала (индекс в базе) не переезжает: знал t4 — t5 не открылся от того, что t4 выключили', () => {
    const off = tiersOff('t4');
    const knewT4 = { ...fullJournal(live), tierHi: tierIndex(live, 't4') };
    expect(craftWeapon(live, inputAt(5), { journal: knewT4 }).ok, 'живой конфиг: t5 закрыт').toBe(false);
    for (const t of [4, 5]) {
      const pv = craftWeapon(off, inputAt(t), { journal: knewT4 });
      expect(pv.ok && pv.item?.tier === 't5', `сборка ступени ${t}`).toBe(false);
    }
  });

  it('разбор найденной вещи выключенной ступени поднимает потолок журнала до НЕЁ, а не до t0', () => {
    const item = found('long-sword', 't5');
    const off = tiersOff('t5');
    expect(salvageIntoJournal(off, emptyJournal(), item).journal.tierHi).toBe(salvageIntoJournal(live, emptyJournal(), item).journal.tierHi);
  });
});

/**
 * ⚠ R14-06: ВЫКЛЮЧЕННАЯ ГРАНИЦА БАЗЫ ДЕРЖИТ И ГЕНЕРАТОР. R12-08 перевёл кузницу на полную лестницу (`nextTier`, `baseTierRange`),
 * а выбор ступени при рождении вещи (`pickTierClamped`) остался на лестнице ВКЛЮЧЁННЫХ: выключенный `maxTier` базы там не
 * находился (−1), и потолок пропадал — кожаный доспех с потолком t3 падал t5 (все 500 бросков на 70-м уровне), кузнец же
 * отвечал «лучше не сделать»; выключенный `minTier` ронял пол на t0. Этим путём идут тела, сундуки, прилавок кузницы,
 * награды квестов и стартовый комплект. В живых данных у всех баз t0…t6 — дыру открывает правка хозяина.
 */
describe('⚠ R14-06: выключенная граница базы — генератор держит диапазон, как кузница', () => {
  const bal = live.get('balance');
  const idx = (r: ConfigRegistry, id: string | undefined): number => tierIndex(r, id);

  /** Живой конфиг: у баз `baseIds` граница `field` = `tierId`, и эта ступень выключена. Без `baseIds` — у всего снаряжения. */
  function boundOff(field: 'minTier' | 'maxTier', tierId: string, baseIds?: string[]): ConfigRegistry {
    const r = new ConfigRegistry();
    r.loadAll();
    r.reload({
      'items.base': r.get('items.base').map((b) => (b.kind !== 'consumable' && (!baseIds || baseIds.includes(b.id)) ? { ...b, [field]: tierId } : b)),
      'item-tiers': r.get('item-tiers').map((t) => (t.id === tierId ? { ...t, enabled: false } : t)),
    });
    return r;
  }

  /** Три живых вызова генератора: тело монстра (сессия), сундук, прилавок кузницы (`Room.rollGear`: уников не продаёт). */
  const SHAPES: { origin: Item['origin']; dropBias: number; noUnique?: boolean }[] = [
    { origin: 'drop', dropBias: 1 }, { origin: 'chest', dropBias: 1 }, { origin: 'shop', dropBias: 1.3, noUnique: true },
  ];
  /** `n` бросков каждого вида на уровне `level` (ступень — бросок окна, как у живых вызовов). */
  function rolls(r: ConfigRegistry, level: number, n: number, opts: { baseId?: string; forceRarity?: Item['rarity'] } = {}): Item[] {
    const out: Item[] = [];
    for (const sh of SHAPES) {
      for (let s = 1; s <= n; s++) {
        const rng = createRng(level * 7919 + s * 31 + sh.dropBias * 1000);
        out.push(generateItem(r.get('items.base'), r.get('affixes'), r.get('uniques'), {
          dropBias: sh.dropBias, itemLevel: level, tierLevel: rollTierLevel(level, bal.loot.tierWindow, rng), baseId: opts.baseId,
          tiers: r.get('item-tiers'), rarities: r.get('rarities'), categoryWeights: opts.baseId ? undefined : bal.loot.categoryWeights,
          rareNames: r.get('rare-names'), forceRarity: opts.forceRarity, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll,
          origin: sh.origin, noUnique: sh.noUnique,
        }, rng));
      }
    }
    return out;
  }
  /** Ступень вещи — в диапазоне её базы по ПОЛНОЙ лестнице (тот, что показывает и держит кузница). */
  function inRange(r: ConfigRegistry, it: Item, why: string): void {
    if (it.kind === 'consumable') return;
    const base = r.get('items.base').find((b) => b.id === it.baseId)!;
    const br = baseTierRange(r, base);
    const t = idx(r, it.tier);
    expect(t, `${why}: ${it.baseId} ${it.tier}`).toBeGreaterThanOrEqual(br.lo);
    expect(t, `${why}: ${it.baseId} ${it.tier}`).toBeLessThanOrEqual(br.hi);
  }

  it('сама функция: выключенный потолок t3 → высшая включённая под ним (t2); выключенный пол t4 → низшая включённая над ним (t5)', () => {
    const t3off = tiersOff('t3').get('item-tiers');
    expect(pickTierClamped(t3off, 80, 't0', 't3')?.id).toBe('t2');
    expect(pickTierClamped(t3off, 1, 't0', 't3')?.id).toBe('t0');
    const t4off = tiersOff('t4').get('item-tiers');
    expect(pickTierClamped(t4off, 1, 't4', 't6')?.id).toBe('t5');
    expect(pickTierClamped(t4off, 90, 't4', 't6')?.id).toBe('t6');
  });

  it('⭐ потолок кожаного доспеха t3 выключен: 2100 бросков с тела, из сундука и с прилавка на 80-м — не выше t3, и t3 не рождается', () => {
    const r = boundOff('maxTier', 't3', ['leather-armor']);
    const base = r.get('items.base').find((b) => b.id === 'leather-armor')!;
    expect(baseTierRange(r, base)).toEqual({ lo: 0, hi: 3 });
    const got = rolls(r, 80, 700, { baseId: 'leather-armor' });
    expect(got).toHaveLength(2100);
    let top = 0;
    for (const it of got) {
      inRange(r, it, it.origin!);
      // Бросок «уник» с тела и из сундука даёт уник СВОЕЙ базы (просящая база ему не указ) — он мерится своим диапазоном выше.
      if (it.baseId !== 'leather-armor') continue;
      expect(it.tier, it.origin).not.toBe('t3');
      top = Math.max(top, idx(r, it.tier));
    }
    // Верх — высшая ВКЛЮЧЁННАЯ ступень диапазона, и кузнец с ней согласен: выше некуда.
    expect(top).toBe(idx(r, 't2'));
    const best = got.find((it) => it.tier === 't2')!;
    expect(upgradedItem(r, { ...best, pos: { x: 0, y: 0 } })).toBeUndefined();
  });

  it('⭐ пол кожаного доспеха t4 выключен: броски на 1-м уровне, награда и стартовый комплект — не ниже t4, и t4 не рождается', () => {
    const r = boundOff('minTier', 't4', ['leather-armor']);
    const base = r.get('items.base').find((b) => b.id === 'leather-armor')!;
    expect(baseTierRange(r, base)).toEqual({ lo: 4, hi: 6 });
    for (const it of rolls(r, 1, 300, { baseId: 'leather-armor' })) {
      inRange(r, it, it.origin!);
      expect(it.tier).not.toBe('t4');
    }
    const quest = itemFromBaseId(r.get('items.base'), 'leather-armor', r.get('item-tiers'), 'quest')!;
    inRange(r, quest, 'награда');
    expect(quest.tier).toBe('t5');
    const hero = newCharacterSave(r, 'warrior', 'Альт', 'r14-06');
    const kitArmor = [...Object.values(hero.equipment), ...hero.inventory].find((i) => i?.baseId === 'leather-armor')!;
    inRange(r, kitArmor, 'стартовый комплект');
  });

  it('потолок t3 выключен у ВСЕГО снаряжения: случайный дроп и уники на 80-м — все в диапазоне своей базы', () => {
    const r = boundOff('maxTier', 't3');
    for (const it of rolls(r, 80, 400)) inRange(r, it, `${it.origin} ${it.rarity}`);
    const uniq = rolls(r, 80, 150, { forceRarity: 'unique' }).filter((it) => it.rarity === 'unique');
    expect(uniq.length).toBeGreaterThan(0);
    for (const it of uniq) inRange(r, it, 'уник');
  });

  it('весь диапазон базы выключен — ступень всё равно из диапазона (как «всё выключено = все в игре», но внутри базы)', () => {
    const r = new ConfigRegistry();
    r.loadAll();
    r.reload({
      'items.base': r.get('items.base').map((b) => (b.id === 'leather-armor' ? { ...b, minTier: 't3', maxTier: 't4' } : b)),
      'item-tiers': r.get('item-tiers').map((t) => (t.id === 't3' || t.id === 't4' ? { ...t, enabled: false } : t)),
    });
    for (const it of rolls(r, 80, 100, { baseId: 'leather-armor' })) inRange(r, it, it.origin!);
    for (const it of rolls(r, 1, 100, { baseId: 'leather-armor' })) inRange(r, it, it.origin!);
  });

  it('честная игра не изменилась: на живых базах (t0…t6) выбор тот же, что был, при любой одной выключенной ступени и при всех', () => {
    /** Прежний выбор — по лестнице включённых (копия кода до R14-06): на живых базах граница не бывает выключенной «внутри». */
    const legacy = (tiers: typeof ladder, lvl: number, minId: string, maxId: string) => {
      const usable = tiers.filter((t) => t.enabled !== false);
      const sorted = [...(usable.length ? usable : tiers)].sort((a, b) => a.minItemLevel - b.minItemLevel);
      const idOf = (id: string): number => sorted.findIndex((t) => t.id === id);
      let byLevel = 0;
      for (let i = 0; i < sorted.length; i++) if (sorted[i]!.minItemLevel <= lvl) byLevel = i;
      const loRaw = idOf(minId), hiRaw = idOf(maxId);
      const lo = loRaw < 0 ? 0 : loRaw, hi = hiRaw < 0 ? sorted.length - 1 : hiRaw;
      return sorted[Math.min(Math.max(byLevel, Math.min(lo, hi)), Math.max(lo, hi))];
    };
    const variants = [[], ...ladder.map((t) => [t.id]), ladder.map((t) => t.id)];
    const ranges = new Set(live.get('items.base').map((b) => `${b.minTier}|${b.maxTier}`));
    expect([...ranges]).toEqual(['t0|t6']);
    let n = 0;
    for (const off of variants) {
      const tiers = live.get('item-tiers').map((t) => (off.includes(t.id) ? { ...t, enabled: false } : t));
      for (let lvl = 1; lvl <= 130; lvl++) {
        expect(pickTierClamped(tiers, lvl, 't0', 't6')?.id, `выкл ${off.join(',') || '—'}, ур. ${lvl}`).toBe(legacy(tiers, lvl, 't0', 't6')?.id);
        n++;
      }
    }
    expect(n).toBe(variants.length * 130);
  });
});
