import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { CRAFT_SLOT_LIST } from '../formulas/craftType.js';
import { anatomyOf, defaultParts, fullJournal, materialId, partFamily, shapeFoundWeapon, type CraftInput } from '../formulas/craft.js';
import { createRng } from '../formulas/rng.js';
import { salvageFromItem, salvageFromMonster, type SalvageRng } from '../formulas/salvage.js';
import { craftAction, repairCost, salvageRange, salvageYield, sellItem, upgradeCost } from './townActions.js';
import { emptyStash } from './stashActions.js';
import { giveMaterialsTo } from './materials.js';
import type { Item, Rarity } from '../types/items.js';
import type { MonsterGearRoll } from '../types/world.js';
import type { SaveState } from '../types/save.js';
import { generateItem, itemFromBase, rollTierLevel } from '../formulas/itemgen.js';
import { monsterTrophyBase } from '../formulas/trophy.js';
import { spawnPacksEl } from '../dungeon/floor.js';
import { resolveMonsterPool } from '../dungeon/floorSpec.js';
import type { DungeonLayout } from '../dungeon/floorCommon.js';
import { Cell, cellToWorld, makeGrid } from '../world/grid.js';
import { GameSession } from '../session/session.js';
import { newBotSave } from '../sim/playerBot.js';
import { generateMonster } from '../formulas/monstergen.js';

/**
 * ⭐ D18 (К2): в игре все 40 материалов — прибор, плечи, фокус и ступени 4–5 включены. Сторож того, что
 * включение НИЧЕГО не сдвинуло у старых потребителей флага `enabled`:
 * - цена улучшения и починки (`materialLadder`) берёт ступени 1–3 по редкости — те же, что и раньше;
 * - разбор по редкости (броня, `salvageFromItem`) и сырьё с монстров (`salvageFromMonster`) поднимают ступень
 *   не выше `rarityTier` (3) — дорогие ступени оттуда не падают;
 * - ковке есть из чего ковать каждое семейство (без D18 она отказывала всем: «Материал ещё не в игре»).
 * Сравнение — с реестром, где включены ровно прежние 15.
 */

type Data = Record<string, unknown> & typeof defaultConfigData;
type MatRow = { id: string; enabled: boolean; family: string; tier: number };
function regWith(patch: (d: Data) => void = () => {}): ConfigRegistry {
  const d = structuredClone(defaultConfigData) as Data;
  patch(d);
  const r = new ConfigRegistry();
  r.loadAll(d);
  return r;
}
const OLD_FAMILIES = ['iron', 'wood', 'cloth', 'hide', 'plate'];
const live = regWith();
/** Реестр «до К2»: живы только ступени 1–3 пяти старых семей. */
const old15 = regWith((d) => {
  for (const m of d['craft-materials'] as MatRow[]) m.enabled = m.tier <= 3 && OLD_FAMILIES.includes(m.family);
});

const MAX: SalvageRng = { int: (_a, b) => b, chance: () => true };
const MIN: SalvageRng = { int: (a) => a, chance: () => false };
const RARITIES: Rarity[] = ['normal', 'magic', 'rare'];

describe('D18: все 40 материалов в игре, старые потребители не сдвинулись', () => {
  it('включены все 40, у «старого» реестра — ровно прежние 15', () => {
    expect(live.get('craft-materials').filter((m) => m.enabled)).toHaveLength(40);
    expect(old15.get('craft-materials').filter((m) => m.enabled)).toHaveLength(15);
  });

  it('цена улучшения и починки — та же у каждой базы и редкости (лестница ступеней 1–3)', () => {
    let n = 0;
    for (const base of live.get('items.base').filter((b) => b.kind !== 'consumable')) {
      for (const rarity of RARITIES) {
        const it = { ...itemFromBase(base, live.get('item-tiers')), rarity };
        expect(upgradeCost(live, it), `${base.id}/${rarity}`).toEqual(upgradeCost(old15, it));
        expect(repairCost(live, it), `${base.id}/${rarity}`).toEqual(repairCost(old15, it));
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it('разбор по редкости (броня, щиты, украшения) — та же вилка у кузнеца и в поле', () => {
    for (const base of live.get('items.base').filter((b) => b.kind === 'armor' || b.kind === 'shield' || b.kind === 'jewelry')) {
      for (const rarity of RARITIES) {
        const it = { ...itemFromBase(base, live.get('item-tiers')), rarity } as Item;
        for (const field of [false, true]) {
          expect(salvageRange(live, it, field), `${base.id}/${rarity}/${field}`).toEqual(salvageRange(old15, it, field));
        }
      }
    }
  });

  it('сырьё с монстров: ступень не выше третьей, старые семьи — ровно как с 15 материалами', () => {
    const known = (r: ConfigRegistry) => (id: string): boolean => r.get('craft-materials').some((c) => c.id === id && c.enabled);
    const rarityTier = live.get('balance').salvage.rarityTier;
    // С F2 монстры роняют и прибор/плечи/фокус (у «старого» реестра их нет) — сравниваем старые семьи.
    const oldPart = (m: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(m).filter(([id]) => OLD_FAMILIES.includes(id.replace(/-\d+$/, ''))));
    for (const g of live.get('monster-gear')) {
      for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
        const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
        for (const rng of [MAX, MIN]) {
          const a = salvageFromMonster(rolls, (id) => live.get('monster-gear').find((x) => x.id === id), rng, { rarity, rarityTier, knownMaterial: known(live) });
          const b = salvageFromMonster(rolls, (id) => old15.get('monster-gear').find((x) => x.id === id), rng, { rarity, rarityTier, knownMaterial: known(old15) });
          expect(oldPart(a), `${g.id}/${rarity}`).toEqual(oldPart(b));
          for (const id of Object.keys(a)) expect(live.get('craft-materials').find((m) => m.id === id)!.tier, id).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it('⭐ F2: с монстров падает сырьё ВЕРХНИХ гнёзд — семьи деталей его оружия, ступень = редкость надетой вещи', () => {
    // Семьи гнёзд классов — из анатомии (прибор, плечи, фокус): что носит, то и даёт (docs/ECONOMY.md).
    const gear = live.get('monster-gear');
    const rarityTier = live.get('balance').salvage.rarityTier;
    const known = (id: string): boolean => live.get('craft-materials').some((c) => c.id === id && c.enabled);
    const UPPER = ['trim', 'stave', 'focus'];
    let carriers = 0;
    for (const g of gear) {
      if (g.kind !== 'weapon') continue;
      const anat = anatomyOf(live, g.weaponClass);
      expect(anat, g.id).toBeTruthy();
      const want = new Set(CRAFT_SLOT_LIST.map((s) => anat![s].family).filter((f) => UPPER.includes(f)));
      const got = new Set((g.salvageTo ?? []).map((y) => y.materialId.replace(/-\d+$/, '')).filter((f) => UPPER.includes(f)));
      expect([...got].sort(), `${g.id}: семьи верхних гнёзд`).toEqual([...want].sort());
      for (const y of g.salvageTo ?? []) if (UPPER.some((f) => y.materialId.startsWith(`${f}-`))) expect(y.materialId, g.id).toMatch(/-1$/);
      if (want.size) carriers++;
      // ⭐ Ступень поднимает редкость вещи — как у железа: магическая → 2, редкая → 3, обычная → 1.
      for (const rarity of ['normal', 'magic', 'rare'] as const) {
        const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
        const out = salvageFromMonster(rolls, (id) => gear.find((x) => x.id === id), MAX, { rarity, rarityTier, knownMaterial: known });
        const step = rarityTier[rarity];
        for (const f of want) expect(out[`${f}-${step}`] ?? 0, `${g.id}/${rarity}: ${f}-${step}`).toBeGreaterThan(0);
      }
    }
    expect(carriers).toBeGreaterThan(10);
  });

  it('⭐ каждое семейство куётся: материалы всех гнёзд живы (раньше — отказ «Материал ещё не в игре» всем)', () => {
    const types = live.get('weapon-types').filter((t) => t.enabled !== false);
    let crafted = 0;
    for (const t of types) {
      for (const hands of [...new Set(t.bases.map((b) => b.hands))]) {
        for (const step of [1, 3, 5]) {
          const parts = defaultParts(live, t.id, hands, step);
          if (!parts) continue;
          const input: CraftInput = { weaponClass: t.id, hands, parts };
          const save = { gold: 10_000_000, inventory: [] } as unknown as SaveState;
          const stash = { ...emptyStash(live), materials: Object.fromEntries(live.get('craft-materials').map((m) => [m.id, 999])) };
          const r = craftAction(live, save, stash, `n-${t.id}-${hands}-${step}`, input, createRng(step), { fullJournal: true });
          if (!r.ok) {
            // Ступень, которую база не берёт, — законный отказ; «не в игре» — нет.
            expect(r.reason, `${t.id}/${hands}/${step}`).not.toMatch(/не в игре/);
            continue;
          }
          crafted++;
        }
      }
    }
    expect(crafted).toBeGreaterThan(types.length);
  });

  it('полки не пусты: каждая ступень каждой семьи оружия встречается в окне хотя бы одной детали', () => {
    // Разбор найденного оружия отдаёт материал детали её ступени (§10.9): ступень, которой нет ни в одном
    // окне, не упала бы ниоткуда и не тратилась бы ничем — мёртвая полка на складе.
    const used = new Set<string>();
    const anyJournal = fullJournal(live);
    for (const p of live.get('weapon-parts').filter((x) => x.enabled !== false && anyJournal.variants.includes(x.id))) {
      for (const cls of p.classes) {
        const anat = anatomyOf(live, cls);
        if (!anat || !CRAFT_SLOT_LIST.includes(p.slot)) continue;
        for (let s = p.stepMin; s <= p.stepMax; s++) used.add(materialId(partFamily(anat, p.slot, p), s));
      }
    }
    for (const m of live.get('craft-materials').filter((x) => ['iron', 'wood', 'stave', 'trim', 'focus'].includes(x.family))) {
      expect(used.has(m.id), m.id).toBe(true);
    }
  });
});

describe('⚠ R2-29: оружие разбирается ПО ДЕТАЛЯМ, а лестница улучшения и починки не голодает', () => {
  /**
   * Лестница улучшения (`materialLadder`) берёт семью ПРАВИЛА разбора и ступени 1–3 по редкости, а найденное оружие
   * с врезки ковки разбирается по ДЕТАЛЯМ (§10.9): материалы их ступеней. Тождество «что даёт = что стоит» для
   * оружия больше не держится поштучно — t5-меч отдаёт сварочный дамаск (ступень 4), а не болотное железо, дубина
   * (семья булавы — железо) — дерево и прибор. Держаться обязано другое: лестницу кормит сырьё С ТЕЛ, не зависящее
   * от уровня, а разбор по деталям до t3 даёт ей не меньше прежнего. Сравнение — с прежним путём разбора оружия
   * (`salvageFromItem`, как до врезки). ⚠ До R2-30 (перекошенные ступени найденного) на 50-м уровне разбор давал
   * лестнице 2.05 единицы против прежних 2.39: ступени 4–5 сыпались уже с t2–t3.
   */
  const reg = live;
  const loot = reg.get('balance').loot;
  const tuning = reg.get('balance').salvage;
  const mats = reg.get('craft-materials');
  const known = (id: string): boolean => mats.some((c) => c.id === id && c.enabled);
  const weaponBases = reg.get('items.base').filter((b) => b.kind === 'weapon' && b.enabled !== false);
  type Rng = ReturnType<typeof createRng>;
  const classOf = (it: Item): string | undefined => {
    const b = reg.get('items.base').find((x) => x.id === it.baseId);
    return b?.kind === 'weapon' ? b.weaponClass : undefined;
  };
  /** Находка оружия ровно как у тела: уровень вещи = уровень монстра, ступень — бросок в окне. */
  const weaponDrop = (baseId: string, level: number, rng: Rng): Item => shapeFoundWeapon(reg, generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias: 1, itemLevel: Math.max(1, level), tierLevel: rollTierLevel(level, loot.tierWindow, rng), baseId,
    tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), categoryWeights: loot.categoryWeights, baseRoll: loot.baseRoll, origin: 'drop',
  }, rng));
  /** Сырьё лестницы: семья цены улучшения этой вещи (семья правила), ступени 1–3. */
  const ladderUnits = (it: Item, gains: Record<string, number>): number => {
    const fam = Object.keys(upgradeCost(reg, it))[0]?.replace(/-\d+$/, '');
    return Object.entries(gains).reduce((s, [id, n]) => s + (fam && new RegExp(`^${fam}-[123]$`).test(id) ? n : 0), 0);
  };
  /** Прежний разбор оружия у кузнеца — по правилу и редкости (до врезки ковки). */
  const byRule = (it: Item, rng: Rng): Record<string, number> =>
    salvageFromItem(it, classOf(it), reg.get('salvage-rules'), tuning, rng, { knownMaterial: known });

  it('каждый материал цены улучшения и починки оружия падает с тел — источник, не зависящий от разбора', () => {
    const fromBodies = new Set<string>();
    for (const g of reg.get('monster-gear')) {
      for (const rarity of ['normal', 'magic', 'rare'] as const) {
        const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
        const out = salvageFromMonster(rolls, (id) => reg.get('monster-gear').find((x) => x.id === id), MAX, { rarity, rarityTier: tuning.rarityTier, knownMaterial: known });
        for (const id of Object.keys(out)) fromBodies.add(id);
      }
    }
    let n = 0;
    for (const base of weaponBases) {
      for (const rarity of RARITIES) {
        const it = { ...itemFromBase(base, reg.get('item-tiers')), rarity } as Item;
        for (const id of Object.keys({ ...upgradeCost(reg, it), ...repairCost(reg, it) })) {
          expect(fromBodies.has(id), `${base.id}/${rarity}: ${id} с тел не падает`).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(weaponBases.length * 3);
  });

  it('⭐ до 50-го уровня разбор по деталям даёт лестнице не меньше прежнего разбора по правилу (было 2.05 против 2.39 на 50-м)', () => {
    for (const level of [10, 30, 50]) {
      const rng = createRng(level * 17 + 3);
      let n = 0, parts = 0, rule = 0;
      for (let i = 0; i < 2000; i++) {
        const it = weaponDrop(rng.pick(weaponBases).id, level, rng);
        if (it.rarity === 'unique') continue;
        const now = salvageYield(reg, it, rng, false);
        expect(now.source, it.baseId).toBe('parts');
        parts += ladderUnits(it, now.gains);
        rule += ladderUnits(it, byRule(it, rng));
        n++;
      }
      expect(n).toBeGreaterThan(1500);
      expect(parts / rule, `ур.${level}: ${(parts / n).toFixed(2)} против ${(rule / n).toFixed(2)} за разбор`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('⭐ весь приход лестницы за 100 убийств (тела + разбор оружейных находок) — не меньше 90 % прежнего на любой глубине', () => {
    // НАСТОЯЩИЙ спавн (тот же, что у сервера): гир и редкость монстров, трофей по надетому.
    const rooms = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 2 + (i % 4) * 16, y: 2 + Math.floor(i / 4) * 16, w: 12, h: 12, type: i % 2 ? 'large' : 'small' }));
    const layout = { grid: makeGrid(68, 36, Cell.Floor), rooms } as unknown as DungeonLayout;
    const biome = reg.get('biomes').find((b) => b.enabled !== false)!;
    const gear = reg.get('monster-gear');
    const LADDER = /^(iron|wood)-[123]$/;
    const ladder = (g: Record<string, number>): number => Object.entries(g).reduce((s, [id, k]) => s + (LADDER.test(id) ? k : 0), 0);
    for (const el of [10, 50, 90]) {
      const rng = createRng(el * 13 + 1);
      let kills = 0, bodies = 0, parts = 0, rule = 0;
      for (let seed = 1; kills < 4000; seed++) {
        const depth = Math.max(1, Math.round(el / 4));
        for (const s of spawnPacksEl(reg, layout, depth, 'normal', createRng(seed * 7919 + el), el, resolveMonsterPool(biome, depth), 1, '')) {
          kills++;
          if (rng.chance(loot.materials.chance)) {
            bodies += loot.materials.mult * ladder(salvageFromMonster(s.def.gearRolls, (id) => gear.find((x) => x.id === id), rng,
              { rarity: s.def.rarity, rarityTier: tuning.rarityTier, knownMaterial: known }));
          }
          if (!rng.chance(loot.dropChance)) continue;
          const baseId = monsterTrophyBase(s.def.gearRolls, (id) => gear.find((x) => x.id === id), reg.get('items.base'), rng, loot.categoryWeights);
          if (!weaponBases.some((b) => b.id === baseId)) continue;
          const it = weaponDrop(baseId!, s.def.level, rng);
          if (it.rarity === 'unique') continue;
          parts += ladder(salvageYield(reg, it, rng, false).gains);
          rule += ladder(byRule(it, rng));
        }
      }
      expect(bodies / kills * 100, `мощь ${el}: с тел за 100 убийств`).toBeGreaterThan(40);
      expect((bodies + parts) / (bodies + rule), `мощь ${el}: тела ${(bodies / kills * 100).toFixed(1)}, разбор ${(parts / kills * 100).toFixed(1)} против ${(rule / kills * 100).toFixed(1)}`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('⚠ R3-20: сданное в лавку сырьё с тел — не кран золота', () => {
  /**
   * С врезки ковки лавка платит за сырьё ПОШТУЧНО (`shopSellPrice`: 1 · 4 · 12 · 36 · 108 по ступеням), а до того
   * брала стек любой длины за 7 золота. Сырьё с тел подбирается само, и сданный стек — новый доход. Бот прогона
   * баланса сырьё не продаёт (копит на кузницу), поэтому отчёт показывает этот кран отдельно — `craft.materials.sellWorth`.
   * Замер на настоящем спавне, 4000 убийств на точку, за 100 убийств (монеты / сырьё с тел в лавку / доля):
   * мощь 10 — 822 / 217 / 26.4 %, мощь 50 — 3 267 / 233 / 7.1 %, мощь 90 — 5 747 / 343 / 6.0 % (при 7 золота
   * за стек было бы ≈ 80–100 на любой глубине). Потолок — замер с запасом: 30 % на 10-й мощи, 10 % глубже.
   * Решение R3-20 — цены не трогаем: первая ступень и так стоит минимальный целый золотой, а ступени 2–3 — мерка
   * лестницы улучшения, пола цены покупки (`salvageWorth`) и инвариантов «не прачечная». Продажа съедает сырьё
   * лестницы (20 единиц первой ступени на подъём тира), то есть это выбор, а не дармовой приход. Сторож держит
   * потолок доли от монет: правка `sellPrice`, `salvageTo` или `loot.materials` не превратит сырьё в кран тихо.
   */
  const CEIL: Record<number, number> = { 10: 0.3, 50: 0.1, 90: 0.1 };

  it('⭐ за 100 убийств сырьё с тел в лавку — не больше потолка доли от монет (мощь 10 / 50 / 90)', () => {
    const reg = live;
    const bal = reg.get('balance');
    const loot = bal.loot;
    const gear = reg.get('monster-gear');
    const mats = reg.get('craft-materials');
    const known = (id: string): boolean => mats.some((c) => c.id === id && c.enabled);
    const goldMult = reg.get('difficulties').find((d) => d.id === 'normal')!.goldMult;
    const rooms = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 2 + (i % 4) * 16, y: 2 + Math.floor(i / 4) * 16, w: 12, h: 12, type: i % 2 ? 'large' : 'small' }));
    const layout = { grid: makeGrid(68, 36, Cell.Floor), rooms } as unknown as DungeonLayout;
    const biome = reg.get('biomes').find((b) => b.enabled !== false)!;
    // Сумка без тесноты: мерим цену сырья, а не то, сколько его не влезло.
    const dims = { ...bal.inventory, cols: 40, rows: 40 };
    for (const el of [10, 50, 90]) {
      const rng = createRng(el * 101 + 3);
      let kills = 0, coins = 0, sold = 0, uid = 0;
      const save = { gold: 0, inventory: [] } as unknown as SaveState;
      // Город — каждые 100 убийств: каждый стек сырья из сумки — настоящей продажей, как у сервера (`sellItem`).
      const town = (): void => {
        const g0 = save.gold;
        for (const it of save.inventory.filter((i) => i.kind === 'material')) expect(sellItem(reg, save, it.uid).ok).toBe(true);
        sold += save.gold - g0;
      };
      for (let seed = 1; kills < 4000; seed++) {
        const depth = Math.max(1, Math.round(el / 4));
        for (const s of spawnPacksEl(reg, layout, depth, 'normal', createRng(seed * 7919 + el), el, resolveMonsterPool(biome, depth), 1, '')) {
          // Награды тела — как `GameSession.killMonster`: монета, затем сырьё × `loot.materials.mult`, округление броском.
          if (rng.chance(loot.goldChance)) coins += Math.max(1, Math.round(rng.int(1, 5 + s.def.level * 2) * goldMult));
          if (rng.chance(loot.materials.chance)) {
            const g = salvageFromMonster(s.def.gearRolls, (id) => gear.find((x) => x.id === id), rng,
              { rarity: s.def.rarity, rarityTier: bal.salvage.rarityTier, knownMaterial: known });
            for (const id of Object.keys(g)) {
              const raw = g[id]! * loot.materials.mult;
              const n = Math.floor(raw) + (rng.chance(raw - Math.floor(raw)) ? 1 : 0);
              if (n > 0) g[id] = n; else delete g[id];
            }
            expect(giveMaterialsTo(save.inventory, g, mats, dims, bal.inventory.materialStack, () => `m${uid++}`)).toEqual({});
          }
          if (++kills % 100 === 0) town();
        }
      }
      town();
      const share = sold / coins;
      expect(share, `мощь ${el}: за 100 убийств монет ${Math.round(coins / kills * 100)}, сырьё с тел в лавку ${Math.round(sold / kills * 100)}`
        + ` (${(share * 100).toFixed(1)} % от монет)`).toBeLessThanOrEqual(CEIL[el]!);
      expect(sold, `мощь ${el}: сырьё продаётся`).toBeGreaterThan(0);
    }
  });
});

/**
 * ⚠ R6-22: ВЫКЛЮЧЕННОЕ СЫРЬЁ НЕ ПАДАЕТ И С ТЕЛ. Разбор у кузнеца, в поле и переплавка фильтровали выключенное (`knownOnly`),
 * а тела — нет: `shiftTier` отдавал исходный id без проверки (сдвиг 0 у обычной вещи и откат, когда ступени выше нет).
 * Выключил дизайнер семью «прибор» — и `trim-1` сыпался с каждого, кто носит кинжал или меч, копился в сумках и продавался.
 */
describe('⚠ R6-22: с тел не падает выключенное сырьё', () => {
  const off = regWith((d) => {
    for (const m of d['craft-materials'] as MatRow[]) if (m.family === 'trim' || m.id === 'iron-1') m.enabled = false;
  });
  const known = (id: string): boolean => off.get('craft-materials').some((c) => c.id === id && c.enabled);
  const disabled = new Set(off.get('craft-materials').filter((c) => !c.enabled).map((c) => c.id));
  /** Поле 14×12 с бордюром-стеной. */
  const field = () => {
    const g = makeGrid(14, 12, Cell.Floor);
    for (let x = 0; x < 14; x++) { g[0]![x] = Cell.Wall; g[11]![x] = Cell.Wall; }
    for (let y = 0; y < 12; y++) { g[y]![0] = Cell.Wall; g[y]![13] = Cell.Wall; }
    return g;
  };

  it('⭐ семья выключена целиком, у другой — первая ступень: каждая вещь монстров × редкость × крайний бросок — без выключенного', () => {
    expect(disabled.has('trim-1') && disabled.has('iron-1'), 'предпосылка').toBe(true);
    const rarityTier = off.get('balance').salvage.rarityTier;
    let n = 0;
    const bad: string[] = [];
    for (const g of off.get('monster-gear')) for (const rarity of RARITIES) for (const rng of [MAX, MIN]) {
      const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
      const got = salvageFromMonster(rolls, (id) => off.get('monster-gear').find((x) => x.id === id), rng, { rarity, rarityTier, knownMaterial: known });
      for (const id of Object.keys(got)) { n++; if (disabled.has(id)) bad.push(`${g.id}/${rarity}: ${id}`); }
    }
    expect(bad.slice(0, 10), `${bad.length} выдач выключенного`).toEqual([]);
    expect(n, 'сторож не выродился: включённое падает').toBeGreaterThan(50);
  });

  it('⭐ живая сессия: убитые в ржавых кинжалах не роняют выключенного (выдача сырья с тела — только включённое)', () => {
    const loot = off.get('balance').loot as { dropChance: number; goldChance: number; potions: { chance: number }; materials: { chance: number } };
    loot.dropChance = 0; loot.goldChance = 0; loot.potions.chance = 0; loot.materials.chance = 1;
    let piles = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = new GameSession(off, seed, 'normal');
      const p = s.addPlayer('p1', newBotSave(off, 'warrior'));
      const def = generateMonster(off.get('monsters'), off.get('monster-gear'), off.get('monster-affixes'),
        { baseId: off.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(seed));
      // Нечётные — обычный кинжал (оба его материала выключены), чётные — магический: `iron-2` включён и падает.
      const rarity = seed % 2 ? 'normal' : 'magic';
      def.hp = 1; def.armor = 0; def.evade = 0; def.rarity = rarity;
      def.gearRolls = [{ slot: 'weapon', gearId: 'u-dagger', name: 'u-dagger', rarity, affixes: [], mods: [], base: {} }];
      const pp = cellToWorld(6, 6), mp = cellToWorld(7, 6);
      s.enterFloor(1, { grid: field(), spawn: pp, monsters: [{ def, x: mp.x, y: mp.y }] });
      const m = s.world.monsters[0]!;
      for (let i = 0; i < 300 && m.alive; i++) { m.pos = { ...mp }; p.pos = { ...pp }; s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing: 0, attack: true, cast: null, interact: false } }); }
      expect(m.alive, `сид ${seed}`).toBe(false);
      for (const d of s.world.drops) {
        if (d.kind !== 'materials') continue;
        piles++;
        for (const id of Object.keys(d.mats)) expect(disabled.has(id), `сид ${seed}: ${id}`).toBe(false);
      }
    }
    expect(piles, 'сторож не выродился: кучи были').toBeGreaterThan(0);
  });
});
