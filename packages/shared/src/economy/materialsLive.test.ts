import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { defaultConfigData } from '../config/defaults.js';
import { CRAFT_SLOT_LIST } from '../formulas/craftType.js';
import { anatomyOf, defaultParts, fullJournal, materialId, partFamily, shapeFoundWeapon, type CraftInput } from '../formulas/craft.js';
import { createRng } from '../formulas/rng.js';
import { ESSENCE_ID, salvageFromItem, salvageFromMonster, type SalvageRng } from '../formulas/salvage.js';
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
 * ⭐ D18 (К2): в игре все материалы — прибор и ступени 4–5 включены (с 06.10 их 30: «Плечи» и «Фокус» сняты). Сторож того, что
 * включение НИЧЕГО не сдвинуло у старых потребителей флага `enabled`:
 * - цена улучшения и починки (`materialLadder`) берёт ступени 1–3 по редкости — те же, что и раньше;
 * - разбор по правилу (броня, `salvageFromItem`) у вещи t0 — первый сорт, сырьё с монстров (`salvageFromMonster`) — только первый сорт
 *   (предложение «Разбор, сырьё и чары» §10: сорт = ступень вещи, у тела — I); дорогие сорта даёт лишь разбор вещей высоких ступеней;
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

describe('D18: все 30 материалов в игре, старые потребители не сдвинулись', () => {
  it('включены все 30 (и эссенция), у «старого» реестра — ровно прежние 15', () => {
    expect(live.get('craft-materials').filter((m) => m.enabled && m.id !== ESSENCE_ID)).toHaveLength(30);
    expect(live.get('craft-materials').find((m) => m.id === ESSENCE_ID)?.enabled).toBe(true);
    expect(old15.get('craft-materials').filter((m) => m.enabled)).toHaveLength(15);
  });

  it('цена улучшения и починки (§7: по ступени, семьями деталей): выключенное сырьё лишь выпадает из цены — включённое то же', () => {
    let n = 0;
    for (const base of live.get('items.base').filter((b) => b.kind !== 'consumable')) {
      for (const rarity of RARITIES) {
        const it = { ...itemFromBase(base, live.get('item-tiers')), rarity };
        for (const cost of [upgradeCost, repairCost]) {
          const a = cost(live, it), b = cost(old15, it);
          for (const [id, k] of Object.entries(b)) expect(a[id], `${base.id}/${rarity}: ${id}`).toBe(k);
          for (const id of Object.keys(a)) if (!(id in b)) expect(old15.get('craft-materials').find((m) => m.id === id)?.enabled, `${base.id}/${rarity}: ${id}`).toBe(false);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it('разбор по правилу (броня, щиты, украшения) — та же вилка старых семей у кузнеца и в поле', () => {
    // Новые семьи (прибор колец и щитов, фокус амулетов, плечи кожаной и стёганой брони — рецензия 06.10: узкие семьи ковки не только с
    // оружия своего класса) у «старого» реестра выключены — сравниваем старые семьи; украшения прежде давали железо, теперь прибор и фокус.
    const oldPart = (r: ReturnType<typeof salvageRange>): ReturnType<typeof salvageRange>['range'] =>
      Object.fromEntries(Object.entries(r.range).filter(([id]) => OLD_FAMILIES.includes(id.replace(/-\d+$/, ''))));
    for (const base of live.get('items.base').filter((b) => b.kind === 'armor' || b.kind === 'shield')) {
      for (const rarity of RARITIES) {
        const it = { ...itemFromBase(base, live.get('item-tiers')), rarity } as Item;
        for (const field of [false, true]) {
          expect(oldPart(salvageRange(live, it, field)), `${base.id}/${rarity}/${field}`).toEqual(oldPart(salvageRange(old15, it, field)));
        }
      }
    }
  });

  it('сырьё с монстров: только первый сорт, старые семьи — ровно как с 15 материалами', () => {
    const known = (r: ConfigRegistry) => (id: string): boolean => r.get('craft-materials').some((c) => c.id === id && c.enabled);
    // С F2 монстры роняют и прибор/плечи/фокус (у «старого» реестра их нет) — сравниваем старые семьи.
    const oldPart = (m: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(m).filter(([id]) => OLD_FAMILIES.includes(id.replace(/-\d+$/, ''))));
    for (const g of live.get('monster-gear')) {
      for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
        const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
        for (const rng of [MAX, MIN]) {
          const a = salvageFromMonster(rolls, (id) => live.get('monster-gear').find((x) => x.id === id), rng, { rarity, knownMaterial: known(live) });
          const b = salvageFromMonster(rolls, (id) => old15.get('monster-gear').find((x) => x.id === id), rng, { rarity, knownMaterial: known(old15) });
          expect(oldPart(a), `${g.id}/${rarity}`).toEqual(oldPart(b));
          for (const id of Object.keys(a)) expect(live.get('craft-materials').find((m) => m.id === id)!.tier, id).toBe(1);
        }
      }
    }
  });

  it('⭐ F2: с монстров падает сырьё ВЕРХНИХ гнёзд — семьи деталей его оружия, всегда I сорт', () => {
    // Семьи гнёзд классов — из анатомии (прибор; «Плечи» и «Фокус» сняты 06.10): что носит, то и даёт (docs/ECONOMY.md).
    const gear = live.get('monster-gear');
    const known = (id: string): boolean => live.get('craft-materials').some((c) => c.id === id && c.enabled);
    const UPPER = ['trim'];
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
      // ⭐ Сорт с тела — первый у любой редкости надетого (§10): сорт сырья = ступень вещи, а у тела исключений нет.
      for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
        const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
        const out = salvageFromMonster(rolls, (id) => gear.find((x) => x.id === id), MAX, { rarity, knownMaterial: known });
        for (const f of want) expect(out[`${f}-1`] ?? 0, `${g.id}/${rarity}: ${f}-1`).toBeGreaterThan(0);
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
    for (const m of live.get('craft-materials').filter((x) => ['iron', 'wood', 'trim'].includes(x.family))) {
      expect(used.has(m.id), m.id).toBe(true);
    }
  });
});

describe('⚠ R2-29: лестница улучшения и починки не голодает — расходник (I) с тел, основа с разбора находок', () => {
  /**
   * Лестница улучшения (`materialLadder`) берёт семью ПРАВИЛА разбора и сорта 1–3 по редкости (`forgePrices.ladderByRarity`). С 06.10
   * разбор отдаёт сорт по РЕЦЕПТУ СТУПЕНИ вещи (`balance.salvage.recipeByTier`), а тела — только I (предложение «Разбор, сырьё и чары» §10,
   * R2-29 переписан, §16): первый сорт лестницы кормят тела на любой глубине, II–III — разбор находок t1–t4 (и купленного — до III).
   * Держаться обязано: каждый материал лестницы откуда-то приходит, и весь приход лестницы за 100 убийств — не меньше 90 % прежнего
   * (прежний разбор — по правилу и редкости, его сорт — как у `rarityTier` до 06.10).
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
  /** Прежний сорт разбора — по редкости (`rarityTier` до 06.10). */
  const OLD_GRADE: Record<string, number> = { normal: 1, magic: 2, rare: 3 };
  /** Прежний разбор оружия у кузнеца — по правилу и редкости (до врезки ковки). */
  const byRule = (it: Item, rng: Rng): Record<string, number> =>
    salvageFromItem(it, classOf(it), reg.get('salvage-rules'), tuning, rng, { knownMaterial: known, grade: OLD_GRADE[it.rarity] ?? 1 });

  it('⭐ каждый материал цены улучшения и починки оружия приходит: I сорт — с тел, II–III — с разбора найденных вещей своей ступени', () => {
    const fromBodies = new Set<string>();
    for (const g of reg.get('monster-gear')) {
      for (const rarity of ['normal', 'magic', 'rare', 'unique'] as const) {
        const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
        const out = salvageFromMonster(rolls, (id) => reg.get('monster-gear').find((x) => x.id === id), MAX, { rarity, knownMaterial: known });
        for (const id of Object.keys(out)) fromBodies.add(id);
      }
    }
    // Разбор найденного у кузнеца — каждая база оружия на каждой своей ступени.
    const fromSalvage = new Set<string>();
    const tiers = [...reg.get('item-tiers')].sort((x, y) => x.minItemLevel - y.minItemLevel);
    for (const base of weaponBases) {
      for (const t of tiers) {
        const it = weaponDrop(base.id, t.minItemLevel, createRng(t.minItemLevel + 1));
        for (const id of Object.keys(salvageRange(reg, { ...it, tier: t.id }, false).range)) fromSalvage.add(id);
      }
    }
    let n = 0;
    for (const base of weaponBases) {
      for (const rarity of RARITIES) {
        const it = { ...itemFromBase(base, reg.get('item-tiers')), rarity } as Item;
        for (const id of Object.keys({ ...upgradeCost(reg, it), ...repairCost(reg, it) })) {
          if (/-1$/.test(id)) expect(fromBodies.has(id), `${base.id}/${rarity}: ${id} — расходник, обязан падать с тел`).toBe(true);
          else expect(fromSalvage.has(id), `${base.id}/${rarity}: ${id} — с разбора находок не приходит`).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(weaponBases.length * 3);
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
          if (rng.chance(loot.materials.chance) || s.def.rarity === 'unique') {
            bodies += loot.materials.mult * ladder(salvageFromMonster(s.def.gearRolls, (id) => gear.find((x) => x.id === id), rng,
              { rarity: s.def.rarity, knownMaterial: known }));
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
              { rarity: s.def.rarity, knownMaterial: known });
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
 * а тела — нет: `shiftTier` отдавал исходный id без проверки (сдвиг 0 у обычной вещи и откат, когда ступени выше нет). Тело теперь
 * даёт только I сорт (`gradeId`) — и выключенный первый сорт семьи с тела не падает вовсе.
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
    let n = 0;
    const bad: string[] = [];
    for (const g of off.get('monster-gear')) for (const rarity of RARITIES) for (const rng of [MAX, MIN]) {
      const rolls: MonsterGearRoll[] = [{ slot: 'weapon', gearId: g.id, name: g.id, rarity, affixes: [], mods: [], base: {} }];
      const got = salvageFromMonster(rolls, (id) => off.get('monster-gear').find((x) => x.id === id), rng, { rarity, knownMaterial: known });
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
      // Нечётные — кинжал (оба его материала выключены: тело даёт только I сорт), чётные — топор: его `wood-1` включён и падает.
      const rarity = seed % 4 < 2 ? 'normal' : 'magic';
      const gearId = seed % 2 ? 'u-dagger' : 'u-axe1h';
      def.hp = 1; def.armor = 0; def.evade = 0; def.rarity = rarity;
      def.gearRolls = [{ slot: 'weapon', gearId, name: gearId, rarity, affixes: [], mods: [], base: {} }];
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

/**
 * ⭐ ТЕЛО БОССА ДАЁТ СЫРЬЁ ВСЕГДА (предложение «Разбор, сырьё и чары» §10). Прежде с боссов не падало НИЧЕГО: все их вещи уникальные, а сорт
 * брался по редкости (`rarityTier.unique = 0` — «не разбирается»), — замер: 400 боссов, 0 сырья. Сторож — живой сессией с НАСТОЯЩЕЙ картой
 * конфига: шанс сырья с тела обнулён, а босс (монстр уникальной редкости) всё равно роняет I сорт; обычный при том же шансе — ничего.
 */
describe('⭐ §10: тело босса — сырьё всегда, I сорт', () => {
  const r = regWith();
  const field = () => {
    const g = makeGrid(14, 12, Cell.Floor);
    for (let x = 0; x < 14; x++) { g[0]![x] = Cell.Wall; g[11]![x] = Cell.Wall; }
    for (let y = 0; y < 12; y++) { g[y]![0] = Cell.Wall; g[y]![13] = Cell.Wall; }
    return g;
  };
  it('⭐ живая сессия: шанс сырья 0 — босс роняет сырьё I сорта каждый раз, обычный монстр — нет', () => {
    const loot = r.get('balance').loot as { dropChance: number; goldChance: number; potions: { chance: number }; materials: { chance: number } };
    loot.dropChance = 0; loot.goldChance = 0; loot.potions.chance = 0; loot.materials.chance = 0;
    let boss = 0, plain = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const rarity of ['unique', 'normal'] as const) {
        const s = new GameSession(r, seed, 'normal');
        const p = s.addPlayer('p1', newBotSave(r, 'warrior'));
        const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
          { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: 1 }, createRng(seed));
        def.hp = 1; def.armor = 0; def.evade = 0; def.rarity = rarity;
        def.gearRolls = [
          { slot: 'weapon', gearId: 'u-sword1h', name: 'u-sword1h', rarity, affixes: [], mods: [], base: {} },
          { slot: 'armor', gearId: 'u-chain', name: 'u-chain', rarity, affixes: [], mods: [], base: {} },
        ];
        const pp = cellToWorld(6, 6), mp = cellToWorld(7, 6);
        s.enterFloor(1, { grid: field(), spawn: pp, monsters: [{ def, x: mp.x, y: mp.y }] });
        const m = s.world.monsters[0]!;
        for (let i = 0; i < 300 && m.alive; i++) { m.pos = { ...mp }; p.pos = { ...pp }; s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing: 0, attack: true, cast: null, interact: false } }); }
        expect(m.alive, `сид ${seed} ${rarity}`).toBe(false);
        const piles = s.world.drops.filter((d) => d.kind === 'materials');
        for (const d of piles) for (const id of Object.keys(d.mats)) expect(id, `сид ${seed}: с тела — только I сорт`).toMatch(/-1$/);
        if (rarity === 'unique') { expect(piles.length, `сид ${seed}: босс без сырья`).toBeGreaterThan(0); boss++; }
        else { expect(piles, `сид ${seed}: обычный при шансе 0`).toEqual([]); plain++; }
      }
    }
    expect(boss).toBe(12);
    expect(plain).toBe(12);
  });
});
