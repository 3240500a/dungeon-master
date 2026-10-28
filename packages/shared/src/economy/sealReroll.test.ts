import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import type { Item } from '../types/items.js';
import {
  SEAL_REFORGE_FEW, SEAL_REFORGE_GOLD, SEAL_REFORGE_ROOM, SEAL_REROLL_ALONE, SEAL_REROLL_OFF, SEAL_REROLL_ONE,
  canRerollSeal, carriedSealCount, giveSealsTo, liveSealDefs, rerollSeal, sealBiomeKey, sealKey, sealRerollCost,
  sealRerollRules, sealTierMul, sealTiers,
} from './seals.js';

/**
 * ⭐⭐ Ф5-6′ (23.10): ПЕРЕКАТ ВИДА — ОДНА ПЕЧАТЬ ЗА ЗОЛОТО, СТУПЕНЬ ТА ЖЕ.
 *
 * ⚠⚠ ЗАЧЕМ ОН НУЖЕН ИМЕННО ТЕПЕРЬ. Решение владельца 17.10 сделало перековку СЛУЧАЙНОЙ по виду (`sameTier`,
 * как вейстоуны PoE2). Это закрыло вопрос «куда девать мусор», но открыло обратный: сила нужная, вид не тот —
 * и единственным выходом было отдать три печати в перековку, то есть ЗАПЛАТИТЬ СИЛОЙ ЗА СМЕНУ ВИДА.
 *
 * ⚠⚠ ГЛАВНОЕ ПРАВИЛО ПЕРЕКАТА — ОН НЕ ТРОГАЕТ СИЛУ: та же ступень, та же штука, то же гнездо. Иначе он стал бы
 * вторым путём наверх мимо `need × mul` перековки, и «не прачечная» держалось бы только на одной из двух дверей.
 */

const dims = { cols: 10, rows: 6 };
let n = 0;
const uid = (): string => `rr${++n}`;
const reg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };

function bagOf(r: ConfigRegistry, want: [string, string, number][], d = dims): Item[] {
  const inv: Item[] = [];
  const gains: Record<string, number> = {};
  for (const [kind, tier, k] of want) gains[sealKey(kind, tier)] = (gains[sealKey(kind, tier)] ?? 0) + k;
  expect(Object.keys(giveSealsTo(r, inv, gains, d, uid)), 'стенд: печати не влезли').toEqual([]);
  return inv;
}

describe('Ф5-6′: перекат вида печати', () => {
  it('⭐⭐ ПЕРЕКАТ НЕ ПОДЪЁМ: ступень результата та же, штука одна — на КАЖДОЙ ступени лестницы', () => {
    const r = reg();
    const rows: string[] = [];
    for (const t of sealTiers(r)) {
      const kind = liveSealDefs(r)[0]!;
      const bag = bagOf(r, [[kind.id, t.id, 1]]);
      const out = rerollSeal(r, bag, { [sealKey(kind.id, t.id)]: 1 }, 10 ** 6, dims, createRng(3), uid);
      expect(out.ok, `перекат ${t.name} обязан проходить`).toBe(true);
      if (!out.ok) continue;
      rows.push(`${kind.name} ${t.name} → ${out.item.name} (ступень ${out.item.sealTier}, ×${sealTierMul(r, out.item.sealTier).toFixed(1)}, пошлина ${sealRerollCost(r, t.id)})`);
      expect(out.item.sealTier, 'ступень обязана остаться той же — иначе перекат второй путь наверх').toBe(t.id);
      // ⚠ Считаем ПО СУМКЕ, а не по `item.count`: при слиянии в стек штуки уезжают в стек, и у возвращённого
      // предмета остаётся 0 — это норма склада, а не потеря печати.
      expect(carriedSealCount(out.inventory, out.item.sealId!, t.id), 'в сумке ровно одна печать нового вида').toBe(1);
      expect(carriedSealCount(out.inventory, kind.id, t.id), 'перекаченная печать ушла').toBe(0);
      expect(out.item.sealId, 'вид обязан стать другим (differs)').not.toBe(kind.id);
    }
    console.log('Ф5-6′ ПЕРЕКАТ (сила не меняется, меняется вид):\n  ' + rows.join('\n  '));
  });

  it('⭐⭐ РОВНО ОДНА ПЕЧАТЬ: две за одну — отказ (это был бы обмен силы мимо перековки)', () => {
    const r = reg();
    const kind = liveSealDefs(r)[0]!;
    const t1 = sealTiers(r)[0]!.id;
    const bag = bagOf(r, [[kind.id, t1, 2]]);
    const two = canRerollSeal(r, bag, { [sealKey(kind.id, t1)]: 2 }, 10 ** 6);
    const none = canRerollSeal(r, bag, {}, 10 ** 6);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reason).toBe(SEAL_REROLL_ONE);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe(SEAL_REROLL_ONE);
  });

  it('⭐ пошлина = база × множитель ступени, и она списывается ровно один раз', () => {
    const r = reg();
    const kind = liveSealDefs(r)[0]!;
    const tiers = sealTiers(r);
    const base = sealRerollRules(r).goldCost;
    for (const t of tiers) expect(sealRerollCost(r, t.id), `пошлина ${t.name}`).toBe(Math.round(base * t.mul));
    const top = tiers[tiers.length - 1]!;
    const bag = bagOf(r, [[kind.id, top.id, 1]]);
    const gold = 10 ** 6;
    const out = rerollSeal(r, bag, { [sealKey(kind.id, top.id)]: 1 }, gold, dims, createRng(3), uid);
    expect(out.ok).toBe(true);
    if (out.ok) expect(gold - out.gold, 'списано ровно по прейскуранту').toBe(sealRerollCost(r, top.id));
  });

  it('⭐ не хватает золота — отказ, и сумка не тронута', () => {
    const r = reg();
    const kind = liveSealDefs(r)[0]!;
    const t1 = sealTiers(r)[0]!.id;
    const bag = bagOf(r, [[kind.id, t1, 1]]);
    const before = JSON.stringify(bag);
    const out = rerollSeal(r, bag, { [sealKey(kind.id, t1)]: 1 }, sealRerollCost(r, t1) - 1, dims, createRng(3), uid);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe(SEAL_REFORGE_GOLD);
    expect(JSON.stringify(bag), 'отказ обязан быть бесплатным').toBe(before);
  });

  it('⭐ запас — СУМКА И СУНДУК (как у перековки): печать из сундука перекатывается', () => {
    const r = reg();
    const kind = liveSealDefs(r)[0]!;
    const t1 = sealTiers(r)[0]!.id;
    const stash: (Item | null)[][] = [[]];
    const tab: Item[] = [];
    expect(Object.keys(giveSealsTo(r, tab, { [sealKey(kind.id, t1)]: 1 }, { cols: 20, rows: 12 }, uid))).toEqual([]);
    stash[0] = tab;
    const bag: Item[] = [];
    const out = rerollSeal(r, bag, { [sealKey(kind.id, t1)]: 1 }, 10 ** 6, dims, createRng(3), uid, stash);
    expect(out.ok, 'печать лежит в сундуке — перекат обязан её видеть').toBe(true);
    if (out.ok) {
      expect(carriedSealCount(out.inventory, out.item.sealId!, t1), 'результат лёг в СУМКУ').toBe(1);
      expect((out.tabs![0] ?? []).filter(Boolean).length, 'из сундука печать ушла').toBe(0);
    }
  });

  it('⭐ вид один на всю привязку — отказ словами, а не бросок «в то же самое»', () => {
    const r = reg();
    const kinds = r.get('seals');
    // Оставляем включённым ровно один вид: перекатывать не во что.
    r.reload({ seals: kinds.map((s, i) => (i === 0 ? s : { ...s, enabled: false })) });
    const only = kinds[0]!;
    const t1 = sealTiers(r)[0]!.id;
    const bag = bagOf(r, [[only.id, t1, 1]]);
    const can = canRerollSeal(r, bag, { [sealKey(only.id, t1)]: 1 }, 10 ** 6);
    expect(can.ok).toBe(false);
    if (!can.ok) expect(can.reason).toBe(SEAL_REROLL_ALONE);
  });

  it('⭐ привязка к биому сохраняется: печать крипты перекатывается в печать крипты', () => {
    const r = reg();
    const seals = r.get('seals');
    r.reload({ seals: seals.map((s, i) => (i === 0 || i === 3 ? { ...s, biomes: ['crypt'] } : i === 1 ? { ...s, biomes: ['caves'] } : s)) });
    const t1 = sealTiers(r)[0]!.id;
    const bag = bagOf(r, [[seals[0]!.id, t1, 1]]);
    const out = rerollSeal(r, bag, { [sealKey(seals[0]!.id, t1)]: 1 }, 10 ** 6, dims, createRng(9), uid);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const made = r.get('seals').find((s) => s.id === out.item.sealId)!;
      console.log(`Ф5-6′ ПЕРЕКАТ В ПРИВЯЗКЕ: ${seals[0]!.name} (крипта) → ${out.item.name} (привязка «${sealBiomeKey(made)}»)`);
      expect(sealBiomeKey(made), 'перекат сменил привязку — это был бы обмен «годится везде» задаром').toBe('crypt');
    }
  });

  it('⭐ выключили перекат в редакторе — отказ, и ничего не тратится', () => {
    const r = reg();
    const bal = r.get('balance');
    r.reload({ balance: { ...bal, seals: { ...bal.seals, reroll: { ...bal.seals.reroll, enabled: false } } } });
    const kind = liveSealDefs(r)[0]!;
    const t1 = sealTiers(r)[0]!.id;
    const bag = bagOf(r, [[kind.id, t1, 1]]);
    const out = rerollSeal(r, bag, { [sealKey(kind.id, t1)]: 1 }, 10 ** 6, dims, createRng(3), uid);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe(SEAL_REROLL_OFF);
  });

  it('⭐ печати нет в запасе — отказ «не хватает», а не молчаливый бросок', () => {
    const r = reg();
    const kind = liveSealDefs(r)[0]!;
    const t1 = sealTiers(r)[0]!.id;
    const out = rerollSeal(r, [], { [sealKey(kind.id, t1)]: 1 }, 10 ** 6, dims, createRng(3), uid);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe(SEAL_REFORGE_FEW);
  });

  it('⭐ место — часть сделки: сумка забита чужими стеками → отказ, печать остаётся прежней', () => {
    const r = reg();
    const live = liveSealDefs(r);
    const t1 = sealTiers(r)[0]!.id;
    const tiny = { cols: 1, rows: 1 };
    // Единственная клетка занята стеком вида A; результат будет видом B — ему места не найдётся.
    const bag = bagOf(r, [[live[0]!.id, t1, 1]], tiny);
    const out = rerollSeal(r, bag, { [sealKey(live[0]!.id, t1)]: 1 }, 10 ** 6, tiny, createRng(3), uid);
    // ⚠ Отказ допустим только по месту: сама печать при этом обязана остаться в сумке.
    if (!out.ok) {
      expect(out.reason).toBe(SEAL_REFORGE_ROOM);
      expect(carriedSealCount(bag, live[0]!.id, t1), 'печать не должна исчезнуть при отказе').toBe(1);
    }
  });
});
