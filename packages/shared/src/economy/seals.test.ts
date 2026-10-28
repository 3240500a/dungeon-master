import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { RUN_MOD_DANGER_STATS, RUN_MOD_REWARD_STATS, RUN_MOD_STAT_SEAMS } from '../config/schemas.js';
import { addToInventory, stackKeyOf } from '../inventory/grid.js';
import type { Item } from '../types/items.js';
import { applyDeathPenalty } from './death.js';
import { canSalvageItem, shopSellPrice, sellItem } from './townActions.js';
import { SEAL_NO_SALVAGE } from '../formulas/salvage.js';
import {
  buildSeal, carriedSealCount, carriedSeals, giveSealsTo, liveSealDefs, sameSeal, sealBundleLine,
  sealBuffs, sealCapOf, sealDangerOf, sealDef, sealKey, sealLines, sealLive, sealSlots, sealStackMax,
  sealTierMul, sealTiers, sealsEnabled, spendSeals,
} from './seals.js';
import { runModCount } from '../dungeon/run/runModEffects.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐⭐ Ф5-1 (17.10): ПЕЧАТЬ — ПРЕДМЕТ. Сторож держит ровно те правила, из-за которых катаная схема была отвергнута:
 * двусоставность (опасность + награда), стек по паре «вид + ступень», живость от конфига, и ЗАКРЫТЫЕ пути —
 * лавка и разбор. Печать, которую можно продать, — это награда без боя, то есть та самая дыра фундамента.
 */

const reg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };

const dims = { cols: 10, rows: 6 };
let n = 0;
const uid = (): string => `u${++n}`;

const bag = (): Item[] => [];

describe('Ф5-1: виды печатей — данные и живость', () => {
  it('⭐⭐ ДВУСОСТАВНОСТЬ ИНВАРИАНТОМ СХЕМЫ: у каждой печати есть и опасность, и награда, каждая из своего списка', () => {
    const r = reg();
    const rows = r.get('seals');
    expect(rows.length, 'печатей в данных нет вовсе').toBeGreaterThan(0);
    for (const s of rows) {
      expect(RUN_MOD_DANGER_STATS as readonly string[], `${s.id}: опасность не из опасных швов`).toContain(s.danger.stat);
      expect(RUN_MOD_REWARD_STATS as readonly string[], `${s.id}: награда не из наградных швов`).toContain(s.reward.stat);
      expect(s.danger.value, `${s.id}: опасность ничего не меняет`).toBeGreaterThan(0);
      expect(s.reward.value, `${s.id}: награда ничего не меняет`).toBeGreaterThan(0);
    }
  });

  it('⭐ разбиение швов ПОЛНОЕ и без пересечений — новый шов не может остаться печатям недоступным', () => {
    const d = new Set<string>(RUN_MOD_DANGER_STATS);
    const w = new Set<string>(RUN_MOD_REWARD_STATS);
    for (const s of RUN_MOD_STAT_SEAMS) {
      expect(d.has(s) || w.has(s), `шов ${s} не отнесён ни к опасности, ни к награде`).toBe(true);
      expect(d.has(s) && w.has(s), `шов ${s} отнесён сразу к обеим сторонам`).toBe(false);
    }
    expect(d.size + w.size).toBe(RUN_MOD_STAT_SEAMS.length);
  });

  it('⭐⭐ КОНФИГ РЕШАЕТ: выключил стат в `run-mod-stats` — печать, которая им живёт, исчезает ЦЕЛИКОМ', () => {
    const r = reg();
    const def = r.get('seals')[0]!;
    expect(sealLive(r, def)).toBe(true);
    const off = new ConfigRegistry();
    off.loadAll();
    off.reload({ 'run-mod-stats': r.get('run-mod-stats').map((s) => (s.id === def.reward.stat ? { ...s, enabled: false } : s)) });
    expect(sealLive(off, def), 'мёртвая награда — печать осталась бы половиной обещания').toBe(false);
    expect(liveSealDefs(off).some((s) => s.id === def.id)).toBe(false);
    expect(buildSeal(off, def.id, 't1', 1, uid()), 'такую печать нельзя даже собрать').toBeNull();
  });

  it('⚠ тумблер всей механики: `balance.seals.enabled = false` — живых видов нет', () => {
    const r = reg();
    expect(sealsEnabled(r)).toBe(true);
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, enabled: false } } });
    expect(sealsEnabled(r)).toBe(false);
    expect(liveSealDefs(r)).toEqual([]);
    expect(buildSeal(r, 'swarming', 't1', 1, uid())).toBeNull();
  });

  it('⚠ НЕИЗВЕСТНАЯ СТУПЕНЬ НЕ РАБОТАЕТ КАК ПЕРВАЯ: множитель 0, печать не собирается', () => {
    const r = reg();
    expect(sealTierMul(r, 't1')).toBeGreaterThan(0);
    expect(sealTierMul(r, 't9'), 'подделанная ступень действовала бы как настоящая').toBe(0);
    expect(buildSeal(r, 'swarming', 't9', 1, uid())).toBeNull();
    expect(buildSeal(r, 'нет-такого-вида', 't1', 1, uid())).toBeNull();
  });

  it('ступень решает силу: вторая сильнее первой ровно во столько, во сколько сказано в балансе', () => {
    const r = reg();
    const tiers = r.get('balance').seals.tiers;
    const def = sealDef(r, 'swarming')!;
    const pct = (tier: string): number => {
      const line = sealLines(r, buildSeal(r, def.id, tier, 1, uid())!)[0]!;
      return Number(line.replace(/[^\d]/g, ''));
    };
    expect(pct('t1')).toBe(Math.round(def.danger.value * tiers[0]!.mul * 100));
    expect(pct('t2')).toBe(Math.round(def.danger.value * tiers[1]!.mul * 100));
    expect(pct('t2')).toBeGreaterThan(pct('t1'));
  });

  it('⭐ имена статов в тултипе — ИЗ таблицы `run-mod-stats`, а не свои (одно имя стата на всю игру)', () => {
    const r = reg();
    const def = sealDef(r, 'enduring')!;
    const label = r.get('run-mod-stats').find((s) => s.id === def.danger.stat)!.name;
    expect(sealLines(r, buildSeal(r, def.id, 't1', 1, uid())!)[0]).toContain(label);
  });
});

describe('Ф5-1: стек по паре «вид + ступень»', () => {
  it('⭐⭐ один шов стека: ключ печати несёт И вид, И ступень — разные ступени не смешиваются', () => {
    const r = reg();
    const a = buildSeal(r, 'swarming', 't1', 3, uid())!;
    const b = buildSeal(r, 'swarming', 't1', 2, uid())!;
    const c = buildSeal(r, 'swarming', 't2', 1, uid())!;
    const d = buildSeal(r, 'enduring', 't1', 1, uid())!;
    expect(stackKeyOf(a)).toBe(stackKeyOf(b));
    expect(stackKeyOf(a)).not.toBe(stackKeyOf(c));
    expect(stackKeyOf(a)).not.toBe(stackKeyOf(d));
    expect(sameSeal(a, b)).toBe(true);
    expect(sameSeal(a, c), 'разные ступени слились бы в один стек и потеряли силу').toBe(false);
  });

  it('⭐ копии доливаются в существующий стек, а чужая ступень занимает СВОЮ клетку', () => {
    const r = reg();
    const inv = bag();
    const cap = sealStackMax(r);
    addToInventory(inv, buildSeal(r, 'swarming', 't1', 3, uid())!, dims, cap);
    addToInventory(inv, buildSeal(r, 'swarming', 't1', 2, uid())!, dims, cap);
    expect(inv.length, 'вторая печать того же вида и ступени заняла новую клетку').toBe(1);
    expect(inv[0]!.count).toBe(5);
    addToInventory(inv, buildSeal(r, 'swarming', 't2', 1, uid())!, dims, cap);
    expect(inv.length).toBe(2);
  });

  it('⚠ стек НЕ ПЕРЕПОЛНЯЕТСЯ: сверх `stackMax` уходит в новую клетку, остаток не исчезает молча', () => {
    const r = reg();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, stackMax: 4 } } });
    const inv = bag();
    const left = giveSealsTo(r, inv, { [sealKey('swarming', 't1')]: 10 }, dims, uid);
    expect(Object.keys(left), 'места в сумке хватало — остатка быть не должно').toEqual([]);
    expect(inv.every((it) => (it.count ?? 1) <= 4)).toBe(true);
    expect(carriedSealCount(inv, 'swarming', 't1')).toBe(10);
  });

  it('⚠ полная сумка возвращает ОСТАТОК, а не теряет награду', () => {
    const r = reg();
    const tiny = { cols: 1, rows: 1 };
    const inv = bag();
    const left = giveSealsTo(r, inv, { [sealKey('swarming', 't1')]: 999 }, tiny, uid);
    expect(carriedSealCount(inv, 'swarming', 't1')).toBe(sealStackMax(r));
    expect(left[sealKey('swarming', 't1')]).toBe(999 - sealStackMax(r));
  });

  it('связка читается словами владельца: «вид ступень ×сколько», а пусто — «идти как есть»', () => {
    const r = reg();
    const line = sealBundleLine(r, { [sealKey('enduring', 't2')]: 3, [sealKey('swarming', 't1')]: 5 });
    expect(line).toBe('Стойкие II ×3, Кишащий I ×5');
    expect(sealBundleLine(r, {})).toBe('Идти как есть');
    expect(sealBundleLine(r, { [sealKey('нет-вида', 't1')]: 2 }), 'выдуманный вид не попадает в связку').toBe('Идти как есть');
  });

  it('учёт в сумке считает ВСЕ стеки, а не первый', () => {
    const r = reg();
    const inv = bag();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, stackMax: 2 } } });
    giveSealsTo(r, inv, { [sealKey('swarming', 't1')]: 5 }, dims, uid);
    expect(inv.length).toBeGreaterThan(1);
    expect(carriedSeals(inv)[sealKey('swarming', 't1')]).toBe(5);
  });
});

describe('Ф5-1: закрытые пути — печать не товар и не сырьё', () => {
  const save = (inv: Item[]): SaveState => ({
    name: 't', classId: 'warrior', level: 10, xp: 0, gold: 100,
    attributes: {}, inventory: inv, equipment: {},
  } as unknown as SaveState);

  it('⭐⭐ ЛАВКА НЕ ПОКУПАЕТ ПЕЧАТЬ: цена 0 и отказ СЛОВАМИ (иначе топливо отрезка стало бы золотом без боя)', () => {
    const r = reg();
    const it = buildSeal(r, 'swarming', 't1', 7, uid())!;
    expect(shopSellPrice(r, it)).toBe(0);
    const s = save([it]);
    const res = sellItem(r, s, it.uid);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('не продаётся');
    expect(s.inventory.length, 'отказ, а печать всё равно исчезла').toBe(1);
    expect(s.gold).toBe(100);
  });

  it('⭐ РАЗБОР НЕ БЕРЁТ ПЕЧАТЬ — одним швом: и у кузнеца, и в поле, и отказом сервера', () => {
    const r = reg();
    const it = buildSeal(r, 'swarming', 't1', 1, uid())!;
    for (const inField of [false, true]) {
      const can = canSalvageItem(r, it, inField);
      expect(can.ok, `разбор печати открыт (inField=${inField})`).toBe(false);
      expect(can.reason).toBe(SEAL_NO_SALVAGE);
    }
  });

  it('⚠ печать нельзя надеть: слота у неё нет вовсе', () => {
    const r = reg();
    const it = buildSeal(r, 'swarming', 't1', 1, uid())!;
    expect(it.slot).toBeUndefined();
    expect(it.affixes).toEqual([]);
    expect(it.baseStats).toEqual([]);
  });

  it('⭐ СМЕРТЬ: стек печатей в сумке теряет ДОЛЮ, как стек сырья, а не пропадает целиком', () => {
    const r = reg();
    // Все клетки под удар (`inventoryDropPercent = 1`), с каждого стека — половина: так случай детерминирован.
    const penalty = { ...r.get('balance').deathPenalty, inventoryDropPercent: 1, materialStackLossPercent: 0.5, goldPercent: 0 };
    const inv = bag();
    giveSealsTo(r, inv, { [sealKey('swarming', 't1')]: 10 }, dims, uid);
    const s = save(inv);
    const sum = applyDeathPenalty(s, penalty);
    const leftN = carriedSealCount(s.inventory, 'swarming', 't1');
    expect(leftN, 'вся связка пропала — это читается как поломка, а не как цена смерти').toBeGreaterThan(0);
    expect(leftN, 'смерть не взяла с печатей ничего').toBeLessThan(10);
    expect(sum.itemsLost, 'стек печатей посчитан как потерянная ВЕЩЬ — тогда он исчез бы целиком').toBe(0);
  });
});

describe('Ф5-3: связка, потолки и гнёзда', () => {
  it('⭐⭐ СТОПКА НАСЫЩАЕТСЯ: прибавка одного типа растёт до потолка стата и дальше НЕ растёт', () => {
    const r = reg();
    const def = sealDef(r, 'swarming')!;
    const cap = sealCapOf(r, def.danger.stat);
    const k = sealKey(def.id, 't1');
    const at = (n: number): number => (sealBuffs(r, { [k]: n }) as Record<string, number>)[def.danger.stat]!;
    const need = Math.ceil(cap / def.danger.value);
    expect(at(1), 'одна печать уже на потолке — замер бессмыслен').toBeLessThan(1 + cap);
    expect(at(need), 'потолок не достигается вовсе').toBeCloseTo(1 + cap, 10);
    expect(at(need + 5), 'сверх потолка прибавка продолжила расти').toBeCloseTo(1 + cap, 10);
    expect(at(100)).toBeCloseTo(at(need), 10);
    console.log(`Ф5-3 ПОТОЛОК ${def.danger.stat}: ×${at(1).toFixed(2)} (1 шт) → ×${at(need).toFixed(2)} (${need}) → ×${at(100).toFixed(2)} (100)`);
  });

  it('⭐ ступень множит обе стороны, а не одну', () => {
    const r = reg();
    const def = sealDef(r, 'swarming')!;
    const one = sealBuffs(r, { [sealKey(def.id, 't1')]: 1 }) as Record<string, number>;
    const two = sealBuffs(r, { [sealKey(def.id, 't2')]: 1 }) as Record<string, number>;
    expect(two[def.danger.stat]! - 1).toBeGreaterThan(one[def.danger.stat]! - 1);
    expect(two[def.reward.stat]! - 1).toBeGreaterThan(one[def.reward.stat]! - 1);
  });

  it('⭐ опасность связки — топливо прихода: она растёт со связкой и ноль у «идти как есть»', () => {
    const r = reg();
    const k = sealKey('swarming', 't1');
    expect(sealDangerOf(r, {})).toBe(0);
    expect(sealDangerOf(r, { [k]: 1 })).toBeGreaterThan(0);
    expect(sealDangerOf(r, { [k]: 3 })).toBeGreaterThan(sealDangerOf(r, { [k]: 1 }));
  });

  it('⭐⭐ ГНЁЗДА — ЛЕСТНИЦЕЙ ПО РЕКОРДУ, и рекорд новым забегом не отбирается', () => {
    const r = reg();
    const rows = r.get('balance').seals.slots;
    expect(sealSlots(r, 0), 'с нуля гнёзд нет вовсе').toBeGreaterThan(0);
    for (const row of rows) expect(sealSlots(r, row.fromRecord), `рекорд ${row.fromRecord}`).toBeGreaterThanOrEqual(row.count);
    const top = Math.max(...rows.map((x) => x.count));
    expect(sealSlots(r, 10_000), 'потолок гнёзд').toBe(top);
    const seq = rows.map((x) => sealSlots(r, x.fromRecord));
    expect([...seq].sort((a, b) => a - b), 'лестница не монотонна').toEqual(seq);
  });

  it('⚠⚠ ТРАТА — ВСЁ ИЛИ НИЧЕГО: не хватило — сумка не тронута', () => {
    const r = reg();
    const inv = bag();
    giveSealsTo(r, inv, { [sealKey('swarming', 't1')]: 2 }, dims, uid);
    const before = JSON.stringify(inv);
    expect(spendSeals(inv, { [sealKey('swarming', 't1')]: 3 }), 'списало то, чего нет').toBeNull();
    expect(JSON.stringify(inv), 'сумка изменилась при отказе').toBe(before);
    const left = spendSeals(inv, { [sealKey('swarming', 't1')]: 2 })!;
    expect(left.filter((it) => it.kind === 'seal'), 'пустой стек остался в сумке').toEqual([]);
  });

  it('⚠ связка в сейве пережила правку конфига: выключенный стат = «не действует», а не «по старому»', () => {
    const r = reg();
    const def = sealDef(r, 'swarming')!;
    const k = sealKey(def.id, 't1');
    expect((sealBuffs(r, { [k]: 2 }) as Record<string, number>)[def.danger.stat]).toBeGreaterThan(1);
    r.reload({ 'run-mod-stats': r.get('run-mod-stats').map((s) => (s.id === def.reward.stat ? { ...s, enabled: false } : s)) });
    expect(sealBuffs(r, { [k]: 2 }), 'мёртвый вид всё ещё действует').toEqual(sealBuffs(r, {}));
  });
});

/**
 * ⭐⭐ 23.10: СТРОКИ ПЕЧАТИ НЕ ОБЕЩАЮТ СВЕРХ ИГРЫ.
 *
 * ⚠⚠ Было: тултип считал `value × mul` сырыми процентами — мимо потолка стата, мимо допуска связки и
 * мимо парной доли награды. С потолком связки (23.10) разрыв стал грубым: старшая печать обещала втрое
 * больше, чем даёт. Теперь строка берёт числа ИЗ `sealBuffs` для связки «одна эта печать».
 */
describe('⭐⭐ 23.10: тултип печати = то, что применит сервер', () => {
  it('⭐⭐ числа строк совпадают со сводом одной печати — у ВСЕХ видов и всех ступеней', () => {
    const r = reg();
    const rows = new Map(r.get('run-mod-stats').map((s) => [s.id, s]));
    const lines: string[] = [];
    for (const def of liveSealDefs(r)) {
      for (const tier of sealTiers(r)) {
        const item = buildSeal(r, def.id, tier.id, 1, uid())!;
        const text = sealLines(r, item).join(' | ');
        const solo = sealBuffs(r, { [sealKey(def.id, tier.id)]: 1 }) as unknown as Record<string, number>;
        for (const side of [def.danger, def.reward]) {
          const row = rows.get(side.stat)!;
          const got = solo[side.stat] ?? 1;
          const want = row.unit === 'count'
            ? `+${runModCount(1 + (got - 1) / row.perUnit)}`
            : `+${Math.round((got - 1) * 100)} %`;
          expect(text, `${def.name} ${tier.name}: ${side.stat} обещает не то, что даёт`).toContain(want);
        }
        if (tier.id === sealTiers(r)[sealTiers(r).length - 1]!.id) lines.push(`${def.name} ${tier.name}: ${text.split(' | ').slice(0, 2).join(' | ')}`);
      }
    }
    console.log('СТРОКИ СТАРШЕЙ СТУПЕНИ (столько даёт ОДНА такая печать)\n  ' + lines.join('\n  '));
  });
});
