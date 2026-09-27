import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { Item, Rarity } from '../types/items.js';
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
