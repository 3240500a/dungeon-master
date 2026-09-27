import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { Item, Rarity } from '../types/items.js';
import { forgeUpgrade } from '../economy/townActions.js';
import { generateItem } from './itemgen.js';
import { shapeFoundWeapon } from './craft.js';
import { createRng } from './rng.js';
import type { SaveState } from '../types/save.js';
import {
  effectiveLevel,
  startChallenge,
  challengeAtFloor,
  runChallengeLevel,
  isDifficultyUnlocked,
  lockedDifficulties,
  type PowerConfig,
} from './power.js';

const reg = new ConfigRegistry();
reg.loadAll();
const powerCfg = reg.get('balance').power;
const diffs = reg.get('difficulties');
const easy = diffs[0]!;
const normal = diffs[1]!;
const hard = diffs[2]!;

function mkItem(rarity: Rarity, itemLevel: number): Item {
  return {
    uid: `u${Math.random()}`, baseId: 'b', name: 'x', slot: 'chest', rarity,
    itemLevel, requirements: {}, affixes: [], baseStats: [], gridW: 1, gridH: 1,
  };
}

function mkSave(over: Partial<SaveState>): SaveState {
  return {
    level: 10, equipment: {}, masteries: {}, attributes: {} as SaveState['attributes'],
    ...over,
  } as unknown as SaveState;
}

describe('effectiveLevel', () => {
  it('голый персонаж: EL = уровень', () => {
    const p = effectiveLevel(mkSave({ level: 20 }), powerCfg);
    expect(p.gearBonus).toBe(0);
    expect(p.passiveBonus).toBe(0);
    expect(p.total).toBe(20);
  });

  it('гир поднимает EL, но не выше каппа', () => {
    const equipment = { chest: mkItem('rare', 20), helm: mkItem('unique', 20) } as SaveState['equipment'];
    const p = effectiveLevel(mkSave({ level: 20, equipment }), powerCfg);
    expect(p.gearBonus).toBeGreaterThan(0);

    const tiny: PowerConfig = { ...powerCfg, gearMax: 1 };
    expect(effectiveLevel(mkSave({ level: 20, equipment }), tiny).gearBonus).toBeLessThanOrEqual(1);
  });

  it('перерос уровня не даёт сверх номинала (currency ≤ 1)', () => {
    const low = effectiveLevel(mkSave({ level: 5, equipment: { chest: mkItem('rare', 5) } as SaveState['equipment'] }), powerCfg);
    const over = effectiveLevel(mkSave({ level: 5, equipment: { chest: mkItem('rare', 99) } as SaveState['equipment'] }), powerCfg);
    expect(over.gearBonus).toBe(low.gearBonus);
  });

  it('⭐ R7-02: запас (сумка) — по лучшему в слот; без запаса и с худшим запасом — ровно надетое', () => {
    const worn = { chest: mkItem('normal', 20), helm: mkItem('magic', 20) } as SaveState['equipment'];
    const base = effectiveLevel(mkSave({ level: 20, equipment: worn }), powerCfg);
    expect(effectiveLevel(mkSave({ level: 20, equipment: worn }), powerCfg, []), 'пустой запас').toEqual(base);
    expect(effectiveLevel(mkSave({ level: 20, equipment: worn }), powerCfg, [mkItem('normal', 5)]), 'хуже надетого').toEqual(base);
    // Снял всё в сумку — мощь та же, что в надетом.
    const bare = mkSave({ level: 20, equipment: {} });
    expect(effectiveLevel(bare, powerCfg, Object.values(worn)).total).toBe(base.total);
    // Две вещи на один слот не складываются: в слот — лучшая.
    const twoChests = [mkItem('unique', 20), mkItem('unique', 20)];
    const one = effectiveLevel(bare, powerCfg, [twoChests[0]!]);
    expect(effectiveLevel(bare, powerCfg, twoChests).gearBonus).toBe(one.gearBonus);
    // Сломанное из запаса не надеть.
    expect(effectiveLevel(bare, powerCfg, [{ ...mkItem('unique', 20), broken: true } as Item]).gearBonus).toBe(0);
  });

  it('⭐ R7-02: двуручник запирает вторую руку — руки по лучшему из «двуручник» и «оружие + щит»', () => {
    const w = (hands: number, rarity: Rarity): Item => ({ ...mkItem(rarity, 20), slot: 'weapon', hands } as Item);
    const shield = { ...mkItem('unique', 20), slot: 'offhand' } as Item;
    const bare = mkSave({ level: 20, equipment: {} });
    const cfg: PowerConfig = { ...powerCfg, gearDivisor: 1, gearMax: 99 };
    expect(effectiveLevel(bare, cfg, [w(2, 'unique'), shield]).gearBonus, 'двуручник со щитом не носят').toBe(5);
    expect(effectiveLevel(bare, cfg, [w(2, 'unique'), w(1, 'rare'), shield]).gearBonus, 'одноручник + щит сильнее').toBe(8);
  });

  /**
   * ⭐ R11-02: одноручное оружие встаёт и во вторую руку (дуал-вилд). Мера запаса, считавшая оружие только по основной руке,
   * прятала второй одноручник: «в городе один меч в руке, уникальный кинжал в сумке — спустился — надел в левую руку»
   * заселяло узел на вклад кинжала слабее (R7-02). Полуторный одной рукой носят только со щитом — с оружием не складывается.
   */
  it('⭐ R11-02: два одноручника из запаса — обе руки; полуторный с оружием не складывается, со щитом — да', () => {
    const w = (hands: number, rarity: Rarity, versatile = false): Item => ({ ...mkItem(rarity, 20), slot: 'weapon', hands, ...(versatile ? { versatile } : {}) } as Item);
    const shield = (rarity: Rarity): Item => ({ ...mkItem(rarity, 20), slot: 'offhand' } as Item);
    const cfg: PowerConfig = { ...powerCfg, gearDivisor: 1, gearMax: 99 };
    const bare = mkSave({ level: 20, equipment: {} });
    expect(effectiveLevel(bare, cfg, [w(1, 'rare'), w(1, 'unique')]).gearBonus, 'было 5: второй одноручник не в счёте').toBe(8);
    // Надет меч, кинжал в сумке — то же, что надетые оба (дуал надевается и в подземелье).
    const sword = w(1, 'rare'), dagger = w(1, 'unique');
    const worn = mkSave({ level: 20, equipment: { weapon: sword, offhand: dagger } as SaveState['equipment'] });
    const armed = mkSave({ level: 20, equipment: { weapon: sword } as SaveState['equipment'] });
    expect(effectiveLevel(armed, cfg, [dagger]).gearBonus).toBe(effectiveLevel(worn, cfg, []).gearBonus);
    expect(effectiveLevel(worn, cfg, []).gearBonus, 'надетый дуал — ровно сумма надетого').toBe(8);
    expect(effectiveLevel(bare, cfg, [w(2, 'unique', true), w(1, 'rare')]).gearBonus, 'полуторный + оружие — не носят').toBe(5);
    expect(effectiveLevel(bare, cfg, [w(2, 'unique', true), w(1, 'rare'), shield('magic')]).gearBonus, 'полуторный + щит').toBe(7);
    expect(effectiveLevel(bare, cfg, [w(1, 'unique'), w(1, 'magic'), shield('rare')]).gearBonus, 'щит лучше второго оружия').toBe(8);
    expect(effectiveLevel(bare, cfg, [w(1, 'unique')]).gearBonus, 'одна вещь в две руки не встаёт').toBe(5);
  });

  describe('⭐ R8-10: запас — только то, что герой может надеть сейчас', () => {
    const cfg1: PowerConfig = { ...powerCfg, gearDivisor: 1, gearMax: 99 };
    const attrs = (strength: number): SaveState['attributes'] => ({ strength, dexterity: 10, intelligence: 10, vitality: 10 });
    const needs = (it: Item, strength: number): Item => ({ ...it, requirements: { strength } });
    const strRing = (value: number): Item => ({ ...mkItem('magic', 12), slot: 'ring', baseStats: [{ stat: 'strength', kind: 'flat', value }] });
    /** Герой 12-го уровня в магическом (как в R8-10: несёт находки этажа в город), Сила 20. */
    const hero = (over: Partial<SaveState> = {}): SaveState => mkSave({
      level: 12, attributes: attrs(20), unspentAttributePoints: 0, equipment: { chest: mkItem('magic', 12) } as SaveState['equipment'], ...over,
    });

    it('редкая вещь с требованиями выше атрибутов героя мощь не поднимает — её не надеть, как и честным `equip`', () => {
      const s = hero();
      const rare = needs(mkItem('rare', 13), 45);
      expect(effectiveLevel(s, powerCfg, [rare]).total, 'боевой конфиг').toBe(effectiveLevel(s, powerCfg).total);
      expect(effectiveLevel(s, cfg1, [rare]).gearBonus).toBe(effectiveLevel(s, cfg1).gearBonus);
      // Контроль: по силам — в счёте, как в R7-02.
      expect(effectiveLevel(s, cfg1, [needs(mkItem('rare', 13), 20)]).gearBonus).toBe(effectiveLevel(s, cfg1).gearBonus + 1);
    });

    it('нераспределённые очки — в счёте: вложить их и надеть можно где угодно (`allocAttr` не только в городе)', () => {
      const rare = needs(mkItem('rare', 13), 45);
      expect(effectiveLevel(hero({ unspentAttributePoints: 24 }), cfg1, [rare]).gearBonus, 'не хватает одного').toBe(1 * 2);
      expect(effectiveLevel(hero({ unspentAttributePoints: 25 }), cfg1, [rare]).gearBonus).toBe(3);
    });

    it('сброс атрибутов не прячет снаряжение: требования — и по атрибутам до сброса (`respecPeak`)', () => {
      const rare = needs(mkItem('rare', 13), 45);
      expect(effectiveLevel(hero({ respecPeak: attrs(45) }), cfg1, [rare]).gearBonus).toBe(3);
    });

    it('опора из запаса: кольцо +Сила в сумке закрывает требования — в счёте; надетое, переданное и запасом, не опирает дважды', () => {
      const rare = needs(mkItem('rare', 13), 45);
      expect(effectiveLevel(hero(), cfg1, [strRing(25), rare]).gearBonus, 'кольцо, затем вещь').toBe(3 + 2);
      // Сервер кладёт в запас и надетое самим героем (`gearPool`): то же кольцо дважды — всё ещё +25, а не +50.
      const ring = strRing(15);
      const s = hero({ equipment: { chest: mkItem('magic', 12), ring } as SaveState['equipment'] });
      expect(effectiveLevel(s, cfg1, [ring, rare]).gearBonus).toBe(effectiveLevel(s, cfg1).gearBonus);
    });
  });

  it('пассивы дают бонус в пределах каппа', () => {
    const p = effectiveLevel(mkSave({ level: 10, masteries: { a: 8, b: 8 } }), powerCfg);
    expect(p.passiveBonus).toBeGreaterThan(0);
    const capped: PowerConfig = { ...powerCfg, passiveMax: 1 };
    expect(effectiveLevel(mkSave({ level: 10, masteries: { a: 999 } }), capped).passiveBonus).toBe(1);
  });
});

describe('startChallenge', () => {
  it('flat: EL + offset', () => {
    expect(startChallenge(20, normal)).toBe(20);
    expect(startChallenge(20, hard)).toBe(25);
  });
  it('percent: EL × (1 + offset)', () => {
    expect(startChallenge(20, easy)).toBe(18); // -10%
  });
  it('не опускается ниже 1', () => {
    expect(startChallenge(1, easy)).toBe(1);
  });
});

describe('challengeAtFloor', () => {
  it('этаж 1 = стартовый CL, глубже — растёт', () => {
    expect(challengeAtFloor(20, normal, 1)).toBe(20);
    expect(challengeAtFloor(20, normal, 5)).toBe(24);
  });
  it('дробный floorStep округляется', () => {
    expect(challengeAtFloor(25, hard, 3)).toBe(28); // 25 + 2*1.5
  });
});

describe('runChallengeLevel', () => {
  it('голый персонаж на средней, этаж 1 = уровень', () => {
    expect(runChallengeLevel(mkSave({ level: 10 }), normal, 1, powerCfg)).toBe(10);
  });
});

describe('isDifficultyUnlocked', () => {
  it('первый тир открыт сразу; следующий — только если его unlockFloor 0', () => {
    expect(isDifficultyUnlocked(diffs, 0, {})).toBe(true); // первый всегда открыт
    // Второй тир открыт на старте ТОЛЬКО если его порог 0 (устойчиво к тюнингу гейта сложностей).
    expect(isDifficultyUnlocked(diffs, 1, {})).toBe(diffs[1]!.unlockFloor === 0);
  });
  it('следующий тир требует глубину на предыдущем', () => {
    expect(isDifficultyUnlocked(diffs, 2, { [normal.id]: 5 })).toBe(false);
    expect(isDifficultyUnlocked(diffs, 2, { [normal.id]: hard.unlockFloor })).toBe(true);
  });
});

describe('lockedDifficulties — R8-13: тир, который не откроется никогда', () => {
  const tier = (id: string, unlockFloor: number, enabled = true) => ({ ...normal, id, unlockFloor, enabled });
  const chain = [tier('a', 0), tier('b', 5), tier('c', 10), tier('d', 20)];

  it('порог глубже самого глубокого узла — замок (прежний «Кошмар»: 20 при забеге до 15)', () => {
    expect(lockedDifficulties(chain, 15)).toEqual([{ id: 'd', unlockFloor: 20, prevId: 'c', cause: 'depth' }]);
    expect(lockedDifficulties(chain, 20)).toEqual([]);   // ровно порог — открывается (`>=` в isDifficultyUnlocked)
  });

  it('выключенный предыдущий тир запирает следующий: прогресс на нём не набрать', () => {
    const off = [tier('a', 0), tier('b', 5), tier('c', 10, false), tier('d', 12)];
    expect(lockedDifficulties(off, 15)).toEqual([{ id: 'd', unlockFloor: 12, prevId: 'c', cause: 'prev' }]);
  });

  it('замок тянется по цепочке, а тир с порогом 0 открыт при любом предыдущем', () => {
    const deep = [tier('a', 0), tier('b', 30), tier('c', 5), tier('d', 0)];
    expect(lockedDifficulties(deep, 15).map((l) => `${l.id}:${l.cause}`)).toEqual(['b:depth', 'c:prev']);
  });

  it('выключенный тир сам не в отчёте — его выключили намеренно', () => {
    expect(lockedDifficulties([tier('a', 0), tier('b', 99, false)], 15)).toEqual([]);
  });
});

describe('⭐ R12-09: поднятое у кузнеца меряется ступенью, а не уровнем находки', () => {
  const tiers = reg.get('item-tiers');
  const t4 = tiers.find((t) => t.id === 't4')!;
  const KIT = { weapon: 'long-sword', offhand: 'buckler', helm: 'leather-cap', chest: 'leather-armor', gloves: 'leather-gloves', boots: 'leather-boots', belt: 'leather-belt' } as const;
  const rich = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 99_999]));
  const drop = (baseId: string, itemLevel: number, tierLevel: number, rarity: Rarity): Item => shapeFoundWeapon(reg, generateItem(
    reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel, tierLevel, baseId, tiers, rarities: reg.get('rarities'), rareNames: reg.get('rare-names'), forceRarity: rarity,
      maxReqTotal: reg.get('balance').maxTotalRequirement, baseRoll: reg.get('balance').loot.baseRoll, origin: 'drop',
    }, createRng(itemLevel * 7 + baseId.length)));

  /** Найдена на 5-м уровне (t0) — и поднята до t4 НАСТОЯЩИМ подъёмом у кузнеца (как главный путь к высоким ступеням). */
  function forgedUp(baseId: string): Item {
    const it = { ...drop(baseId, 5, 5, 'rare'), pos: { x: 0, y: 0 } };
    const save = { gold: 1e9, inventory: [it] } as unknown as SaveState;
    const wallet = rich();
    while (save.inventory[0]!.tier !== t4.id) expect(forgeUpgrade(reg, save, it.uid, wallet).ok, baseId).toBe(true);
    const up = save.inventory[0]!;
    expect(up.itemLevel, 'уровень находки подъём не трогает').toBe(5);
    return up;
  }
  const kit = (): SaveState['equipment'] =>
    Object.fromEntries(Object.entries(KIT).map(([slot, id]) => [slot, forgedUp(id)])) as SaveState['equipment'];
  /** Та же вещь, но с уровнем порога своей ступени — как скованная этой ступени (`buildCraftShell`). */
  const atTierLevel = (eq: SaveState['equipment']): SaveState['equipment'] =>
    Object.fromEntries(Object.entries(eq).map(([slot, it]) => [slot, { ...it!, itemLevel: t4.minItemLevel }])) as SaveState['equipment'];

  it('надетое: мощь та же, что у той же вещи уровня t4 — и выше, чем по уровню находки', () => {
    const worn = kit();
    const up = mkSave({ level: 60, equipment: worn });
    const twin = mkSave({ level: 60, equipment: atTierLevel(worn) });
    const fine: PowerConfig = { ...powerCfg, gearDivisor: 1, gearMax: 99 };
    for (const cfg of [powerCfg, fine]) {
      expect(effectiveLevel(up, cfg, undefined, tiers)).toEqual(effectiveLevel(twin, cfg, undefined, tiers));
      expect(effectiveLevel(up, cfg, [], tiers)).toEqual(effectiveLevel(twin, cfg, [], tiers));
    }
    expect(effectiveLevel(up, powerCfg, [], tiers).total, 'было: 61 против 66 у найденного').toBeGreaterThan(effectiveLevel(up, powerCfg, []).total);
  });

  it('запас (сумка): поднятое меряется так же, как надетое', () => {
    // Требования сняты: вещь запаса, которую герою не надеть, в счёт не идёт (R8-10) — здесь мерим ступень, а не атрибуты.
    const bag = (Object.values(kit()) as Item[]).map((it) => ({ ...it, requirements: {} }));
    const bare = mkSave({ level: 60 });
    const twin = mkSave({ level: 60, equipment: atTierLevel(Object.fromEntries(bag.map((it) => [it.slot, it])) as SaveState['equipment']) });
    expect(effectiveLevel(bare, powerCfg, bag, tiers).total).toBe(effectiveLevel(twin, powerCfg, [], tiers).total);
  });

  it('кольцо и амулет: ступень их не меняет — и мощь по ней не растёт', () => {
    for (const id of ['simple-ring', 'simple-amulet']) {
      const lucky = drop(id, 40, 45, 'rare');   // бросок ступени выше уровня находки (окно `over`)
      expect(t4.minItemLevel).toBeGreaterThan(lucky.itemLevel);
      expect(lucky.tier).toBe(t4.id);
      const slot = lucky.slot as keyof SaveState['equipment'];
      const fine: PowerConfig = { ...powerCfg, gearDivisor: 1, gearMax: 99 };
      const s = (it: Item): SaveState => mkSave({ level: 60, equipment: { [slot]: it } as SaveState['equipment'] });
      expect(effectiveLevel(s(lucky), fine, [], tiers)).toEqual(effectiveLevel(s({ ...lucky, tier: 't0' }), fine, [], tiers));
    }
  });
});
