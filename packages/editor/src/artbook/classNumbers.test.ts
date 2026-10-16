import { describe, it, expect } from 'vitest';
import { defaultConfigData, ConfigRegistry, deriveStats, newCharacterSave, playerSnapshot } from '@dm/shared';
import { classNumbers, regFromData } from './classNumbers.js';

/**
 * ⭐ 16.10 (Артбук): числа страницы класса — ТЕ ЖЕ, что у игры. Сторож от «своей арифметики» во вкладке: если кто-то
 * заменит вызов `newCharacterSave`/`playerSnapshot` на прикидку, расхождение со снимком сессии вылезет здесь.
 */
const reg = (): ConfigRegistry => regFromData(defaultConfigData);

describe('artbook: числа класса', () => {
  it('все семь классов конфига считаются, жизнь/мана/выносливость — как снимок сессии игры', () => {
    const r = reg();
    const ids = r.get('classes').map((c) => c.id);
    expect(ids.length).toBe(7);
    for (const id of ids) {
      const cn = classNumbers(r, id, 20)!;
      expect(cn, id).toBeTruthy();
      const save = newCharacterSave(r, id, 'x', 'y');
      const d1 = playerSnapshot(save, r).derived;
      expect(cn.pools[0]!.hp, id).toBe(Math.round(d1.maxHp));
      expect(cn.pools[0]!.mana, id).toBe(Math.round(d1.maxMana));
      expect(cn.pools[0]!.stamina, id).toBe(Math.round(d1.maxStamina));
      const d20 = playerSnapshot({ ...save, level: 20 }, r).derived;
      expect(cn.pools[1]!.level).toBe(20);
      expect(cn.pools[1]!.hp, id).toBe(Math.round(d20.maxHp));
      expect(cn.startAttributes).toEqual(save.attributes);
    }
  });

  it('прибавка за уровень — по формуле класса (hpPerLevel × (N−1)), очки уровня — из баланса', () => {
    const r = reg();
    const cls = r.get('classes')[0]!;
    const cn = classNumbers(r, cls.id, 11)!;
    const gain = cn.pools[1]!.hp - cn.pools[0]!.hp;
    const bare = deriveStats(cls.startAttributes, [], cls.derived, 11).maxHp - deriveStats(cls.startAttributes, [], cls.derived, 1).maxHp;
    expect(gain).toBeCloseTo(bare, 0);
    expect(cn.pointsAt.attribute).toBe(r.get('balance').attributePointsPerLevel * 10);
  });

  it('стартовый комплект = сейв нового героя: оружие класса надето, кожаный комплект', () => {
    const r = reg();
    for (const c of r.get('classes')) {
      const cn = classNumbers(r, c.id, 1)!;
      const save = newCharacterSave(r, c.id, 'x', 'y');
      const eq = Object.values(save.equipment).filter(Boolean).map((i) => i!.baseId).sort();
      expect(cn.kit.filter((k) => k.equipped).map((k) => k.baseId).sort(), c.id).toEqual(eq);
      expect(cn.pools.length, 'уровень 1 — одна строка').toBe(1);
      if (cn.weaponIssued) expect(cn.kit.find((k) => k.baseId === cn.weaponIssued)?.damage, c.id).toMatch(/^\d+–\d+$/);
    }
  });

  it('класса нет — null, а не падение', () => {
    expect(classNumbers(reg(), 'нет-такого', 5)).toBeNull();
  });

  it('правка конфига видна сразу: hpPerVitality ×2 — жизнь растёт', () => {
    const data = defaultConfigData;
    const before = classNumbers(regFromData(data), 'zastupnik', 1)!.pools[0]!.hp;
    const classes = JSON.parse(JSON.stringify(data.classes)) as { id: string; derived: { hpPerVitality: number } }[];
    const z = classes.find((c) => c.id === 'zastupnik')!;
    z.derived.hpPerVitality *= 2;
    const after = classNumbers(regFromData({ ...data, classes }), 'zastupnik', 1)!.pools[0]!.hp;
    expect(after).toBeGreaterThan(before);
  });
});
