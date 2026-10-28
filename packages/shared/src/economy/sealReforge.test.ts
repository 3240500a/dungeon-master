import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { countsAsFind } from '../formulas/craft.js';
import type { Item } from '../types/items.js';
import {
  SEAL_REFORGE_FEW, SEAL_REFORGE_MIX, SEAL_REFORGE_OFF, SEAL_REFORGE_ROOM, SEAL_REFORGE_TIER, SEAL_REFORGE_TOP,
  canReforgeSeals, carriedSealCount, carriedSeals, giveSealsTo, liveSealDefs, reforgeSeals, sealBuffs, sealKey,
  sealNextTier, sealReforgeRules, sealTierMul, sealTiers,
} from './seals.js';

/**
 * ⭐⭐ Ф5-6 (17.10): ПЕРЕКОВКА ПЕЧАТЕЙ 3→1 — приём PoE2 (Reforging Bench), и он здесь не ради удобства.
 *
 * ⚠⚠ ЗАЧЕМ ОНА ВООБЩЕ. Замер круга (`sealYield.test.ts`) даёт ≈37 печатей прихода на 14 расхода: излишек
 * копится, и без двери игрок с десятком ненужных печатей I сидит и молится на дроп нужной. Перековка —
 * единственное место, где НАКОПЛЕННЫЙ МУСОР превращается в ВЫБОР.
 *
 * ⚠⚠ И ровно поэтому она обязана быть УБЫТОЧНОЙ ПО СИЛЕ: `need × mul(ступень) ≥ mul(следующая)`. Иначе это
 * конвейер «нафармил мусора — получил силы больше, чем отдал», то есть прачечная, которой в этой экономике
 * уже закрыты продажа и разбор печатей.
 */

const reg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };
const dims = { cols: 10, rows: 6 };
let n = 0;
const uid = (): string => `r${++n}`;
const rng = (): { int(a: number, b: number): number; float(a: number, b: number): number } => createRng(7);

/** Сумка с печатями: список пар «вид/ступень/штук». */
function bagOf(r: ConfigRegistry, want: [string, string, number][], d = dims): Item[] {
  const inv: Item[] = [];
  const gains: Record<string, number> = {};
  for (const [kind, tier, k] of want) gains[sealKey(kind, tier)] = (gains[sealKey(kind, tier)] ?? 0) + k;
  const left = giveSealsTo(r, inv, gains, d, uid);
  expect(Object.keys(left), 'стенд: печати не влезли в сумку').toEqual([]);
  return inv;
}

describe('Ф5-6: правила перековки — из данных', () => {
  it('⭐⭐ ПЕРЕКОВКА НЕ ПРАЧЕЧНАЯ: отдаёшь силы не меньше, чем получаешь, на КАЖДОЙ ступени лестницы', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const tiers = sealTiers(r);
    const rows: string[] = [];
    for (let i = 0; i + 1 < tiers.length; i++) {
      const from = tiers[i]!;
      const to = tiers[i + 1]!;
      rows.push(`${need} × ${from.name} (${(need * from.mul).toFixed(1)}) → ${to.name} (${to.mul})`);
      expect(need * from.mul, `прачечная: ${need} × ${from.name} = ${need * from.mul} < ${to.name} ${to.mul}`)
        .toBeGreaterThanOrEqual(to.mul);
    }
    expect(rows.length, 'лестница из одной ступени — перековывать нечего').toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('Ф5-6 ПЕРЕКОВКА (убыток по силе — плата за сгущение в одно гнездо):\n  ' + rows.join('\n  '));
  });

  it('⭐ следующая ступень — по ПОРЯДКУ в данных, у старшей её нет', () => {
    const r = reg();
    const tiers = sealTiers(r);
    for (let i = 0; i + 1 < tiers.length; i++) expect(sealNextTier(r, tiers[i]!.id)?.id).toBe(tiers[i + 1]!.id);
    expect(sealNextTier(r, tiers[tiers.length - 1]!.id), 'у старшей ступени есть следующая').toBeUndefined();
    expect(sealNextTier(r, 'нет-такой'), 'выдуманная ступень').toBeUndefined();
  });
});

describe('Ф5-6: перековка одного вида (режим sameKind)', () => {
  /**
   * ⚠ Режим ставится ЯВНО: решением владельца 17.10 умолчание данных — `sameTier` (как вейстоуны GGG,
   * вид решает кузнец). Этот блок сторожит именно ЦЕЛЕВУЮ перековку, и без явного режима он сторожил бы
   * умолчание, а не правило.
   */
  const kindMode = (): ConfigRegistry => {
    const r = reg();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, mode: 'sameKind' } } } });
    return r;
  };
  it('⭐⭐ три «Кишащих I» → один «Кишащий II»: три ушли, один пришёл, ступень выше', () => {
    const r = kindMode();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const t2 = sealTiers(r)[1]!.id;
    const inv = bagOf(r, [['swarming', t1, need + 2]]);
    const res = reforgeSeals(r, inv, { [sealKey('swarming', t1)]: need }, 1000, dims, rng(), uid);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    expect(carriedSealCount(res.inventory, 'swarming', t1), 'списано ровно need').toBe(2);
    expect(carriedSealCount(res.inventory, 'swarming', t2), 'пришла одна ступенью выше').toBe(1);
    expect(res.item.sealId).toBe('swarming');
    expect(res.item.sealTier).toBe(t2);
    expect(sealTierMul(r, res.item.sealTier)).toBeGreaterThan(sealTierMul(r, t1));
  });

  it('⚠ РЕЗУЛЬТАТ — НЕ НАХОДКА: `origin: craft`, счёт находок его не считает', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const res = reforgeSeals(r, bagOf(r, [['swarming', t1, need]]), { [sealKey('swarming', t1)]: need }, 0, dims, rng(), uid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.item.origin).toBe('craft');
    expect(countsAsFind(res.item), 'перековка попала в счёт находок').toBe(false);
  });

  it('⚠ СМЕСЬ ВИДОВ в режиме sameKind — отказ, и сумка не тронута', () => {
    const r = kindMode();
    const t1 = sealTiers(r)[0]!.id;
    const inv = bagOf(r, [['swarming', t1, 2], ['enduring', t1, 2]]);
    const before = JSON.stringify(inv);
    const picks = { [sealKey('swarming', t1)]: 2, [sealKey('enduring', t1)]: 1 };
    const can = canReforgeSeals(r, inv, picks, 1000);
    expect(can.ok).toBe(false);
    if (!can.ok) expect(can.reason).toBe(SEAL_REFORGE_MIX);
    const res = reforgeSeals(r, inv, picks, 1000, dims, rng(), uid);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(inv), 'сумка изменилась при отказе').toBe(before);
  });

  it('⚠ СМЕСЬ СТУПЕНЕЙ — отказ в любом режиме: лестница идёт по ступеням', () => {
    const r = reg();
    const [t1, t2] = [sealTiers(r)[0]!.id, sealTiers(r)[1]!.id];
    const inv = bagOf(r, [['swarming', t1, 2], ['swarming', t2, 2]]);
    for (const mode of ['sameKind', 'sameTier'] as const) {
      const b = r.get('balance');
      r.reload({ balance: { ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, mode } } } });
      const can = canReforgeSeals(r, inv, { [sealKey('swarming', t1)]: 2, [sealKey('swarming', t2)]: 1 }, 1000);
      expect(can.ok, `режим ${mode}`).toBe(false);
      if (!can.ok) expect(can.reason).toBe(SEAL_REFORGE_TIER);
    }
  });

  it('⚠ НЕ ТО ЧИСЛО — отказ: ни меньше, ни больше (иначе «отдал пять, получил одну» молча)', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const inv = bagOf(r, [['swarming', t1, need + 3]]);
    for (const k of [need - 1, need + 1]) {
      const can = canReforgeSeals(r, inv, { [sealKey('swarming', t1)]: k }, 1000);
      expect(can.ok, `штук ${k}`).toBe(false);
      if (!can.ok) expect(can.reason).toContain(SEAL_REFORGE_FEW);
    }
  });

  it('⚠ СТАРШАЯ СТУПЕНЬ — перековывать некуда', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const top = sealTiers(r)[sealTiers(r).length - 1]!.id;
    const can = canReforgeSeals(r, bagOf(r, [['swarming', top, need]]), { [sealKey('swarming', top)]: need }, 1000);
    expect(can.ok).toBe(false);
    if (!can.ok) expect(can.reason).toBe(SEAL_REFORGE_TOP);
  });

  it('⚠ ПЕЧАТЕЙ НЕТ В СУМКЕ — отказ, и сумка не тронута', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const inv = bagOf(r, [['swarming', t1, need - 1]]);
    const before = JSON.stringify(inv);
    const res = reforgeSeals(r, inv, { [sealKey('swarming', t1)]: need }, 1000, dims, rng(), uid);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(inv)).toBe(before);
  });

  it('⚠⚠ МЕСТО — ЧАСТЬ СДЕЛКИ: некуда положить — отказ, печати остались', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const [t1, t2] = [sealTiers(r)[0]!.id, sealTiers(r)[1]!.id];
    const b = r.get('balance');
    // Стек в одну штуку + сетка 2×1: две клетки заняты, одна печать остаётся в стеке, свободной клетки нет.
    r.reload({ balance: { ...b, seals: { ...b.seals, stackMax: 1, reforge: { ...b.seals.reforge, need: 2 } } } });
    const tiny = { cols: 2, rows: 1 };
    const inv = bagOf(r, [['swarming', t1, 2]], tiny);
    expect(inv.length, 'стенд: два стека по одной').toBe(2);
    const res = reforgeSeals(r, inv, { [sealKey('swarming', t1)]: 2 }, 0, tiny, rng(), uid);
    // Два стека уходят целиком — клетки освободились, значит сделка ПРОХОДИТ: проверяем, что результат лёг.
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (res.ok) expect(carriedSealCount(res.inventory, 'swarming', t2)).toBe(1);

    // А теперь клетки НЕ освобождаются: берём 2 из стека в 3 при сетке 1×1 — места под новую ступень нет.
    r.reload({ balance: { ...b, seals: { ...b.seals, stackMax: 9, reforge: { ...b.seals.reforge, need: 2 } } } });
    const one = { cols: 1, rows: 1 };
    const inv2 = bagOf(r, [['swarming', t1, 3]], one);
    const before = JSON.stringify(inv2);
    const res2 = reforgeSeals(r, inv2, { [sealKey('swarming', t1)]: 2 }, 0, one, rng(), uid);
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe(SEAL_REFORGE_ROOM);
    expect(JSON.stringify(inv2), 'сумка изменилась при отказе по месту').toBe(before);
  });

  it('⚠ выключенная перековка — отказ (и это тумблер данных, а не кода)', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const inv = bagOf(r, [['swarming', t1, need]]);
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, enabled: false } } } });
    const can = canReforgeSeals(r, inv, { [sealKey('swarming', t1)]: need }, 1000);
    expect(can.ok).toBe(false);
    if (!can.ok) expect(can.reason).toBe(SEAL_REFORGE_OFF);
  });

  it('⚠ пошлина: не хватило золота — отказ; хватило — золото списано ровно на пошлину', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, goldCost: 250 } } } });
    const inv = bagOf(r, [['swarming', t1, need]]);
    expect(canReforgeSeals(r, inv, { [sealKey('swarming', t1)]: need }, 249).ok).toBe(false);
    const res = reforgeSeals(r, inv, { [sealKey('swarming', t1)]: need }, 1000, dims, rng(), uid);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.gold).toBe(750);
  });
});

describe('Ф5-6: режим sameTier (любые виды одной ступени)', () => {
  const tierMode = (): ConfigRegistry => {
    const r = reg();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, mode: 'sameTier' } } } });
    return r;
  };

  it('⭐ смесь видов одной ступени ПРОХОДИТ, вид результата решает бросок — и он детерминирован', () => {
    const r = tierMode();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const picks = { [sealKey('swarming', t1)]: need - 1, [sealKey('enduring', t1)]: 1 };
    const a = reforgeSeals(r, bagOf(r, [['swarming', t1, need], ['enduring', t1, 2]]), picks, 0, dims, rng(), uid);
    const b2 = reforgeSeals(r, bagOf(r, [['swarming', t1, need], ['enduring', t1, 2]]), picks, 0, dims, rng(), uid);
    expect(a.ok, a.ok ? '' : a.reason).toBe(true);
    expect(b2.ok).toBe(true);
    if (!a.ok || !b2.ok) return;
    expect(a.item.sealTier, 'ступень выше').toBe(sealTiers(r)[1]!.id);
    expect(a.item.sealId, 'один и тот же бросок — один и тот же вид').toBe(b2.item.sealId);
    // Суммарно печатей стало меньше ровно на (need − 1).
    const was = need + 2;
    const now = Object.values(carriedSeals(a.inventory)).reduce((s, k) => s + k, 0);
    expect(now).toBe(was - need + 1);
  });

  it('⚠ в этом режиме один вид тоже можно — ограничение только по ступени', () => {
    const r = tierMode();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!.id;
    const res = reforgeSeals(r, bagOf(r, [['swarming', t1, need]]), { [sealKey('swarming', t1)]: need }, 0, dims, rng(), uid);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
  });
});

describe('Ф5-6: один ответ на вопрос «можно ли»', () => {
  it('⭐⭐ canReforgeSeals и reforgeSeals НЕ РАСХОДЯТСЯ на матрице входов', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const [t1, t2, t3] = sealTiers(r).map((x) => x.id);
    const cases: { picks: Record<string, number>; bag: [string, string, number][]; gold: number }[] = [
      { picks: { [sealKey('swarming', t1!)]: need }, bag: [['swarming', t1!, need]], gold: 0 },
      { picks: { [sealKey('swarming', t1!)]: need }, bag: [['swarming', t1!, need - 1]], gold: 0 },
      { picks: { [sealKey('swarming', t2!)]: need }, bag: [['swarming', t2!, need]], gold: 0 },
      { picks: { [sealKey('swarming', t3 ?? t2!)]: need }, bag: [['swarming', t3 ?? t2!, need]], gold: 0 },
      { picks: { [sealKey('swarming', t1!)]: 1, [sealKey('enduring', t1!)]: 1 }, bag: [['swarming', t1!, 2], ['enduring', t1!, 2]], gold: 0 },
      { picks: { 'мусор': need }, bag: [['swarming', t1!, need]], gold: 0 },
      { picks: {}, bag: [['swarming', t1!, need]], gold: 0 },
    ];
    for (const c of cases) {
      const inv = bagOf(r, c.bag);
      const can = canReforgeSeals(r, inv, c.picks, c.gold);
      const res = reforgeSeals(r, inv, c.picks, c.gold, dims, rng(), uid);
      expect(res.ok, `расхождение на ${JSON.stringify(c.picks)}: can=${can.ok}, reforge=${res.ok}`).toBe(can.ok);
      if (!can.ok && !res.ok) expect(res.reason, 'причина отказа разная').toBe(can.reason);
    }
  });
});

describe('Ф5-6: правки по ревизии 17.10', () => {
  it('⭐⭐ НЕ ПРАЧЕЧНАЯ В РЕАЛИЗОВАННЫХ ЕДИНИЦАХ: одна печать выше в ОДНОМ гнезде не сильнее need печатей в need гнёздах', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const tiers = sealTiers(r);
    const rows: string[] = [];
    for (const def of liveSealDefs(r)) {
      for (let i = 0; i + 1 < tiers.length; i++) {
        const low = { [sealKey(def.id, tiers[i]!.id)]: need };
        const high = { [sealKey(def.id, tiers[i + 1]!.id)]: 1 };
        const bl = sealBuffs(r, low) as Record<string, number>;
        const bh = sealBuffs(r, high) as Record<string, number>;
        const dl = bl[def.danger.stat]! - 1, dh = bh[def.danger.stat]! - 1;
        const rl = bl[def.reward.stat]! - 1, rh = bh[def.reward.stat]! - 1;
        rows.push(`${def.name} ${tiers[i]!.name}×${need} → опасность ${dl.toFixed(2)} / награда ${rl.toFixed(2)}`
          + ` | ${tiers[i + 1]!.name}×1 → ${dh.toFixed(2)} / ${rh.toFixed(2)}`);
        // ⚠⚠ Критик ревизии: инвариант «не прачечная» обязан мериться ТЕМ, ЧТО ИГРА ПРИМЕНЯЕТ (прибавки с
        // потолками), а не множителями ступеней. Иначе перековка — чистое благо: экономишь гнёзда И получаешь
        // больше награды при той же опасности (замер до парных потолков: 4×t1 → gold ×2.00, 4×t3 → ×3.00).
        expect(rh, `${def.name}: перековка подняла НАГРАДУ при экономии гнёзд — это прачечная\n  ${rows[rows.length - 1]}`)
          .toBeLessThanOrEqual(rl + 1e-9);
      }
    }
    // eslint-disable-next-line no-console
    console.log('Ф5-6 ПЕРЕКОВКА В РЕАЛИЗОВАННЫХ ЕДИНИЦАХ (need гнёзд против одного):\n  ' + rows.join('\n  '));
  });

  it('⭐ ВОРОТА СТУПЕНИ ПО РЕКОРДУ: ступень, которой игрок не видел в подземелье, кузнец не даёт', () => {
    const r = reg();
    const need = sealReforgeRules(r).need;
    const t1 = sealTiers(r)[0]!;
    const t2 = sealTiers(r)[1]!;
    const inv = bagOf(r, [['swarming', t1.id, need]]);
    const picks = { [sealKey('swarming', t1.id)]: need };
    expect(canReforgeSeals(r, inv, picks, 0, t2.minDepth - 1).ok, `рекорд ${t2.minDepth - 1} против порога ${t2.minDepth}`).toBe(false);
    expect(canReforgeSeals(r, inv, picks, 0, t2.minDepth).ok, 'ровно на пороге — уже можно').toBe(true);
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, reforge: { ...b.seals.reforge, gateByRecord: false } } } });
    expect(canReforgeSeals(r, inv, picks, 0, 0).ok, 'ручка выключена — ворот нет').toBe(true);
  });

  it('⚠ потолок кадра не меньше `need`: иначе провод отбивал бы законную перековку', () => {
    const r = reg();
    // Тот же потолок, что объявлен в схеме кадров (`WIRE_SEAL_REFORGE_MAX`): связь держится числом здесь.
    expect(sealReforgeRules(r).need).toBeLessThanOrEqual(9);
  });
});
