import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { generateMonster } from './monstergen.js';
import { createRng } from './rng.js';
import { DEFAULT_MDERIVE } from './monsterDerive.js';
import type { ConfigShapes } from '../config/schemas.js';

/**
 * ⭐⭐ 13.10 КРИВАЯ СИЛЫ МОНСТРА — ПРОВЕРКА ФОРМЫ, А НЕ АБСОЛЮТА (шаг 6 плана «Монстры: план по силе»).
 *
 * Решение владельца: ПОТОЛКОВ НЕТ — чем глубже, тем сложнее, без плато и без капа уровня. Значит сторожить
 * «разумный максимум hp» нельзя: любой такой порог либо врёт, либо запрещает глубину. Сторожим ФОРМУ:
 *  · монотонность — глубже никогда не легче;
 *  · нет NaN/Infinity и нет дробей там, где поле целое;
 *  · вилка урона не выворачивается (min ≤ max);
 *  · порядок тиров не инвертируется ни на одном уровне (слабый < средний < сильный < босс);
 *  · РАЗДЕЛЕНИЕ РЫЧАГОВ: `hpVitPower` двигает только жизнь, ступени оружия — только урон и броню,
 *    `levelGrowth` — и то и то (это и есть решение владельца о трёх рычагах);
 *  · числа доживают до клиента: снапшот кладёт hp в u32 — проверяем, что на рабочей глубине не рвётся,
 *    и ЗНАЕМ, где рвётся (это документированный предел протокола, а не баланса).
 *
 * ⚠ Сторожей с абсолютным потолком hp в проекте не нашлось (искали по фаззерам и серверным инвариантам
 * 13.10): все проверки hp — относительные (`hp ≤ maxHp`, `hp ≥ 0`). Этот файл закрывает дыру с другой
 * стороны: раньше ФОРМУ кривой не стерёг никто.
 */
const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const monsters = reg.get('monsters');
const gear = reg.get('monster-gear');
const affixes = reg.get('monster-affixes');
const mderive = reg.get('monster-derive');
const gearTiers = reg.get('monster-gear-tiers');

type Mon = ReturnType<typeof generateMonster>;
const at = (baseId: string, level: number, opts: { md?: ConfigShapes['monster-derive']; ladder?: ConfigShapes['monster-gear-tiers'] } = {}): Mon =>
  generateMonster(monsters, gear, affixes,
    { baseId, depth: level - 1, mderive: opts.md ?? mderive, gearTiers: 'ladder' in opts ? opts.ladder : gearTiers },
    createRng(7));

/** Уровни до 1000: забег не ограничен, и форма обязана держаться там, куда игрок в принципе может дойти. */
const LEVELS = [1, 2, 5, 10, 20, 40, 60, 80, 100, 150, 200, 300, 500, 1000];
const INT_FIELDS = ['hp', 'minDamage', 'maxDamage', 'armor', 'accuracy', 'evade', 'xp'] as const;
const GROWS = ['hp', 'minDamage', 'maxDamage', 'armor', 'accuracy', 'xp'] as const;

describe('⭐⭐ кривая силы монстра: форма держится на любой глубине (потолков нет)', () => {
  it('⭐ монотонность: глубже — никогда не слабее (hp, урон, броня, точность, опыт)', () => {
    const bad: string[] = [];
    for (const b of monsters) {
      let prev: Mon | undefined;
      for (const lv of LEVELS) {
        const m = at(b.id, lv);
        if (prev) for (const k of GROWS) if (m[k] < prev[k]) bad.push(`${b.id}.${k}: ур.${lv} ${m[k]} < прежнего ${prev[k]}`);
        prev = m;
      }
    }
    expect(bad, 'глубже стало легче').toEqual([]);
  });

  it('⭐ нет NaN/Infinity, целые поля — целые, вилка урона не вывернута', () => {
    const bad: string[] = [];
    for (const b of monsters) {
      for (const lv of LEVELS) {
        const m = at(b.id, lv);
        for (const k of INT_FIELDS) {
          if (!Number.isFinite(m[k])) bad.push(`${b.id}.${k} ур.${lv}: ${m[k]}`);
          else if (!Number.isInteger(m[k])) bad.push(`${b.id}.${k} ур.${lv}: дробное ${m[k]}`);
        }
        for (const k of ['attackSpeed', 'critChance', 'blockChance', 'resFire', 'resCold', 'resLightning', 'resPoison'] as const) {
          if (!Number.isFinite(m[k])) bad.push(`${b.id}.${k} ур.${lv}: ${m[k]}`);
        }
        if (m.minDamage > m.maxDamage) bad.push(`${b.id} ур.${lv}: вилка ${m.minDamage}–${m.maxDamage}`);
        if (m.hp <= 0) bad.push(`${b.id} ур.${lv}: hp ${m.hp}`);
      }
    }
    expect(bad, 'число испорчено').toEqual([]);
  });

  it('⭐ порядок тиров не инвертируется: слабый < средний < сильный < босс на КАЖДОМ уровне', () => {
    const order = ['weak', 'medium', 'strong', 'boss'] as const;
    const bad: string[] = [];
    for (const lv of LEVELS) {
      const med = (t: string): number => {
        const v = monsters.filter((b) => ((b as { tier?: string }).tier ?? 'medium') === t).map((b) => at(b.id, lv).hp).sort((x, y) => x - y);
        return v[Math.floor(v.length / 2)] ?? 0;
      };
      const vals = order.map(med);
      for (let i = 1; i < vals.length; i++) if (vals[i]! <= vals[i - 1]!) bad.push(`ур.${lv}: ${order[i]} ${vals[i]} ≤ ${order[i - 1]} ${vals[i - 1]}`);
    }
    expect(bad, 'разброс по тирам сломан').toEqual([]);
  });

  /**
   * ⭐ ТРИ РЫЧАГА (решение владельца 13.10): «поднял урон оружия — вырос урон; поднял `hpVitPower` — выросли
   * жизни; надо и то и то — крутим `levelGrowth`». Сторож на каждую из трёх связей отдельно: без него правка
   * одного тихо двигала бы другое (так и было до плана — всё ехало на одной `levelGrowth`).
   */
  it('⭐⭐ `hpVitPower` двигает ТОЛЬКО жизнь', () => {
    const steeper = { ...mderive, hpVitPower: mderive.hpVitPower + 0.3 };
    for (const b of monsters) {
      const a = at(b.id, 60), c = at(b.id, 60, { md: steeper });
      expect(c.hp, `${b.id}: жизнь не выросла`).toBeGreaterThan(a.hp);
      expect(c.minDamage, `${b.id}: урон поехал`).toBe(a.minDamage);
      expect(c.maxDamage, `${b.id}: урон поехал`).toBe(a.maxDamage);
      expect(c.armor, `${b.id}: броня поехала`).toBe(a.armor);
      expect(c.xp, `${b.id}: опыт поехал`).toBe(a.xp);
    }
  });

  it('⭐⭐ ступени снаряжения двигают урон и броню, но НЕ жизнь и НЕ опыт', () => {
    for (const b of monsters) {
      const a = at(b.id, 60), c = at(b.id, 60, { ladder: undefined });
      expect(c.hp, `${b.id}: жизнь поехала от ступени`).toBe(a.hp);
      expect(c.xp, `${b.id}: опыт поехал от ступени`).toBe(a.xp);
      expect(a.maxDamage, `${b.id}: ступень не подняла урон`).toBeGreaterThan(c.maxDamage);
    }
  });

  it('⭐⭐ `levelGrowth` двигает И жизнь, И урон (рычаг всей прогрессии)', () => {
    const faster = { ...mderive, levelGrowth: mderive.levelGrowth * 1.2 };
    let hpUp = 0, dmgUp = 0;
    for (const b of monsters) {
      const a = at(b.id, 60), c = at(b.id, 60, { md: faster });
      if (c.hp > a.hp) hpUp++;
      if (c.maxDamage > a.maxDamage) dmgUp++;
    }
    expect(hpUp, 'жизнь выросла у всех').toBe(monsters.length);
    expect(dmgUp, 'урон вырос у всех').toBe(monsters.length);
  });

  /**
   * ⚠ ПЛАТО МЕРИТЬ НА УДВОЕНИИ УРОВНЯ, А НЕ «каждые 10 уровней на X %». Кривая степенная
   * (hp ≈ L^2.76), и доля за +10 уровней ЕСТЕСТВЕННО уменьшается с глубиной (×1.33 на 20-м, ×1.09 на 300-м) —
   * первая версия сторожа ловила именно это и была неверна. Настоящее свойство «потолка нет» — СВЕРХЛИНЕЙНОСТЬ:
   * удвоил глубину — жизнь выросла больше, чем вдвое. Плато или кап сломают именно его.
   */
  it('⭐ без плато: удвоение глубины более чем удваивает жизнь (нет капа по уровню)', () => {
    const bad: string[] = [];
    for (const b of monsters) {
      for (const lv of [10, 20, 40, 80, 150, 300, 500]) {
        const a = at(b.id, lv).hp, c = at(b.id, lv * 2).hp;
        if (c / a < 2) bad.push(`${b.id}: ур.${lv}→${lv * 2} всего ×${(c / a).toFixed(2)}`);
      }
    }
    expect(bad, 'кривая вышла на плато — это и есть скрытый потолок').toEqual([]);
    // И сама степень держится: на удвоении жизнь растёт как 2^(1+hpVitPower) ±15 % (вит тоже растёт линейно).
    const want = Math.pow(2, 1 + mderive.hpVitPower);
    const got = at('zombie-fighter', 160).hp / at('zombie-fighter', 80).hp;
    expect(Math.abs(got / want - 1), `удвоение 80→160: ×${got.toFixed(2)} против ожидаемых ×${want.toFixed(2)}`).toBeLessThan(0.15);
  });

  /**
   * ⚠ ПРЕДЕЛ ПРОТОКОЛА, А НЕ БАЛАНСА. Снапшот кладёт hp монстра в u32 (`wire.ts`), то есть ровно до
   * 4 294 967 295. На рабочей глубине (до 1000 ур.) самый толстый монстр в него укладывается с огромным
   * запасом; где именно кончится — считает сам сторож и печатает. Если кривую поднимут так, что упрётся,
   * это осознанная правка ПРОТОКОЛА (u32 → что-то шире), а не повод ставить потолок балансу.
   */
  it('⭐ hp доживает до клиента: u32 снапшота хватает на всю рабочую глубину', () => {
    const U32 = 4_294_967_295;
    let worst = 0, worstAt = 0, worstId = '';
    for (const b of monsters) {
      for (const lv of LEVELS) {
        const hp = at(b.id, lv).hp;
        if (hp > worst) { worst = hp; worstAt = lv; worstId = b.id; }
      }
    }
    expect(worst, `${worstId} на ур.${worstAt}: hp ${worst} не влезает в u32 снапшота`).toBeLessThanOrEqual(U32);
    // Где кончится: ищем уровень, на котором самый толстый перестаёт влезать (для документации предела).
    let lv = 1000;
    while (lv < 100_000 && at(worstId, lv).hp <= U32) lv *= 2;
    console.log(`самый толстый — ${worstId}: hp ${worst} на ур.${worstAt}; u32 снапшота кончится между ур. ${lv / 2} и ${lv}`);
    expect(lv, 'предел протокола достижим ближе рабочей глубины').toBeGreaterThan(1000);
  });

  /**
   * ⭐ 13.10 (шаг 7 плана): СТАТЫ РЕДКОСТИ — ИЗ КОНФИГА. Было вшито в `eliteBoost` (×2.5 hp / ×1.5 урона)
   * и работало только для `unique`: чемпион (rare) статов не получал вовсе. Сторож держит и то, что числа берутся
   * из `monster-rarity` (правка конфига двигает чемпиона), и порядок «обычный < чемпион < уник».
   */
  it('⭐ статы редкости берутся из `monster-rarity`, а не из кода', () => {
    const mk = (rarity: 'normal' | 'magic' | 'rare' | 'unique', cfg = reg.get('monster-rarity')): Mon =>
      generateMonster(monsters, gear, affixes, {
        baseId: 'zombie-fighter', depth: 59, mderive, gearTiers, rarity,
        itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'),
        monsterRarity: cfg, monsterUniques: reg.get('monster-uniques'),
      }, createRng(7));
    const plain = mk('normal'), champ = mk('rare'), uniq = mk('unique');
    expect(champ.hp, 'чемпион толще обычного').toBeGreaterThan(plain.hp);
    expect(uniq.hp, 'уник толще чемпиона').toBeGreaterThan(champ.hp);
    expect(champ.maxDamage, 'чемпион бьёт сильнее').toBeGreaterThan(plain.maxDamage);
    expect(champ.accuracy, 'чемпион меткее').toBeGreaterThan(plain.accuracy);
    expect(champ.level, 'уровень редкости — ДО деривации').toBeGreaterThan(plain.level);
    // Правка конфига двигает числа — значит они точно не из кода.
    const weaker = reg.get('monster-rarity').map((r) => (r.id === 'rare' ? { ...r, hpMult: 1, dmgMult: 1, accMult: 1, levelBonus: 0 } : r));
    const flat = mk('rare', weaker);
    expect(flat.hp, 'обнулённые множители должны убрать буст').toBeLessThan(champ.hp);
  });

  it('дефолт кода и живой конфиг дают одну кривую (сторож «дефолт ≡ данные» — в monsterDerive.test.ts)', () => {
    for (const b of monsters.slice(0, 5)) {
      expect(at(b.id, 50, { md: DEFAULT_MDERIVE as unknown as ConfigShapes['monster-derive'] }).hp).toBe(at(b.id, 50).hp);
    }
  });
});
