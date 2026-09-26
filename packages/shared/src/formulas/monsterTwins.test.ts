import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import type { ConfigShapes } from '../config/schemas.js';
import type { SaveState } from '../types/save.js';
import { deriveMonsterStats, type MonsterDeriveScaling, type MonsterTemplate } from './monsterDerive.js';
import { spawnShareOf, spawnWeightAt } from './spawnWeight.js';
import { generateMonster } from './monstergen.js';
import { itemFromBaseId } from './itemgen.js';
import { createRng } from './rng.js';
import { newBotSave, levelUpBotTo } from '../sim/playerBot.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { townLayout } from '../dungeon/town.js';
import { GameSession } from '../session/session.js';

/**
 * ⭐ ДВОЙНИКИ МОНСТРОВ (D20, docs/CRAFT_WEAPONS.md §20): копьё, алебарду, жезл — и булаву, посох, арбалет,
 * которые лежали в пуле крипты, но не спавнились (их роли нет ни в одной пачке), — носят ДВОЙНИКИ тех, кто
 * спавнится: та же заготовка (роль, тир, атрибуты, броня, щит, скорость, масса), другое оружие.
 *
 * Бой обязан остаться прежним. Сторожим пять вещей:
 * 1. доли слота группы дают в сумме целого монстра — состав пачек по роли и тиру не сдвинулся;
 * 2. ДПС оружия двойника = ДПС оружия источника ±5 % (урон × скорость, правило владельца);
 * 3. ДПС ПОСЛЕ деривации (атрибуты растут с уровнем, ведущий атрибут — по оружию) не уехал: ведущий
 *    атрибут выбирает вид и дальность оружия (магия — ИНТ, дальний физ — ЛОВК), и чужой бил бы иначе;
 * 4. вид урона двойника = вид урона источника: броня героя режет только физику. Монстровые жезл и посох —
 *    ФИЗИКА с подтипом метателя (R1-13): холодные, при равном ДПС оружия, били воина в латах на +40…+60 %;
 * 5. и главное — входящий урон по герою в НАСТОЯЩЕМ бою (`GameSession`) равен источнику ±10 % в среднем.
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
type Monster = ConfigShapes['monsters'][number];
type Gear = ConfigShapes['monster-gear'][number];
type GearWeapon = Extract<Gear, { kind: 'weapon' }>;

const monsters = reg.get('monsters').filter((m) => m.enabled !== false);
const weaponOf = (m: Monster): GearWeapon => {
  const g = reg.get('monster-gear').find((x) => x.kind === 'weapon' && x.id === m.weapon);
  if (!g || g.kind !== 'weapon') throw new Error(`${m.id}: нет оружия ${m.weapon}`);
  return g;
};
/** Всё, кроме этих полей, у двойников обязано совпадать (и атрибуты: вид урона у группы один, см. п. 4 шапки). */
const OWN = new Set(['id', 'name', 'weapon', 'spawnShare']);
const bodyKey = (m: Monster): string =>
  JSON.stringify(Object.keys(m).filter((k) => !OWN.has(k)).sort().map((k) => [k, (m as Record<string, unknown>)[k]]));

/** Группы двойников: монстры с долей слота < 1, собранные по одинаковой заготовке. */
const groups = (() => {
  const by = new Map<string, Monster[]>();
  for (const m of monsters) (by.get(bodyKey(m)) ?? by.set(bodyKey(m), []).get(bodyKey(m))!).push(m);
  return [...by.values()].filter((g) => g.some((m) => spawnShareOf(m) < 1));
})();

const gearDps = (w: GearWeapon): number => ((w.minDamage + w.maxDamage) / 2) * w.attackSpeed;
const derivedDps = (m: Monster, level: number): number => {
  const d = deriveMonsterStats(m as unknown as MonsterTemplate, weaponOf(m), null, null, level, (m.derive ?? undefined) as MonsterDeriveScaling | undefined);
  return ((d.minDamage + d.maxDamage) / 2) * d.attackSpeed;
};

/**
 * Настоящий бой: входящий урон в секунду по герою от ОДНОГО бессмертного монстра на настоящем `GameSession`
 * (удары + DoT статусов). Герой стоит: разница «физика против стихии» — это броня и сопротивления героя, а не его
 * беготня; бот `simulateMicroFight` на посильном числе сидов шумит ±20 % на клетку даже у физических двойников
 * (замер R1-13), и сторож тонул бы в шуме. HP героя прижимается высоко каждый тик — он не умирает, реген не идёт
 * (HP выше максимума), и весь снятый за тик HP — это урон.
 * Броня — по уровню (кожа / кольчуга / латы): голого героя стихия и физика бьют одинаково, и промах не виден.
 */
const FIGHT_CLASSES = ['warrior', 'mage', 'archer'] as const;
const FIGHT_LEVELS = [5, 10, 20] as const;
const FIGHT_KIT: Record<number, string[]> = {
  5: ['leather-armor', 'leather-cap', 'leather-gloves', 'leather-boots', 'leather-belt'],
  10: ['chain-mail', 'chain-coif', 'chain-gloves', 'chain-boots', 'studded-belt'],
  20: ['plate-armor', 'plate-helm', 'plate-gauntlets', 'plate-boots', 'plate-girdle'],
};
const FIGHT_SEC = 40;
const FIGHT_SEEDS = 3;
const heroes = new Map<string, SaveState>();
const heroAt = (classId: string, level: number): SaveState => {
  const key = `${classId}:${level}`;
  if (!heroes.has(key)) {
    const save = newBotSave(reg, classId);
    levelUpBotTo(reg, save, level, DEFAULT_BUILD, createRng(level * 7 + 1));
    for (const id of FIGHT_KIT[level] ?? []) {
      const it = itemFromBaseId(reg.get('items.base'), id, reg.get('item-tiers'), 'start');
      if (!it?.slot) throw new Error(`нет брони ${id}`);
      save.equipment[it.slot] = it;
    }
    heroes.set(key, save);
  }
  return structuredClone(heroes.get(key)!);
};
const incomingDps = (monsterId: string, classId: string, level: number, seed: number): number => {
  const def = generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'), { baseId: monsterId, depth: level - 1 }, createRng(seed));
  def.hp = 1e9; // бессмертный: бой идёт всё окно
  const s = new GameSession(reg, seed, 'normal', { sustain: true, economy: false });
  const p = s.addPlayer('p1', heroAt(classId, level));
  const { grid, spawn } = townLayout(41, 41);
  s.enterFloor(1, { grid, spawn, monsters: [{ def, x: spawn.x + 96, y: spawn.y }] });
  const ticks = FIGHT_SEC * 30;
  let dmg = 0;
  for (let i = 0; i < ticks; i++) {
    p.hp = 1e7;
    s.tick(1 / 30, {});
    dmg += 1e7 - p.hp;
  }
  return dmg / FIGHT_SEC;
};

describe('двойники монстров: носители новых классов оружия, бой прежний', () => {
  it('группы есть, и в каждой классы оружия разные', () => {
    expect(groups.length).toBeGreaterThanOrEqual(4);
    for (const g of groups) {
      const ids = g.map((m) => m.id).join(', ');
      expect(g.length, ids).toBeGreaterThanOrEqual(2);
      expect(new Set(g.map((m) => weaponOf(m).weaponClass)).size, ids).toBe(g.length);
    }
  });

  it('⭐ доли слота группы в сумме = 1: вес роли и тира в пачке тот же, что до двойников', () => {
    for (const g of groups) {
      const sum = g.reduce((s, m) => s + spawnShareOf(m), 0);
      expect(sum, g.map((m) => `${m.id}:${m.spawnShare}`).join(', ')).toBeCloseTo(1, 9);
    }
    // ...и значит вес группы на любой глубине равен весу одного монстра её тира.
    const tiers = reg.get('depth-tiers');
    for (const g of groups) {
      for (const floor of [1, 4, 7, 11, 16, 23, 40]) {
        const sum = g.reduce((s, m) => s + spawnWeightAt(m, tiers, floor), 0);
        expect(sum).toBeCloseTo(spawnWeightAt({ ...g[0]!, spawnShare: 1 }, tiers, floor), 9);
      }
    }
  });

  it('⭐ двойник живёт в тех же пулах, что его группа (иначе вес ушёл бы в другой биом)', () => {
    for (const b of reg.get('biomes')) {
      const pools = [b.monsterPool, ...b.variants.map((v) => v.monsterPool ?? [])];
      for (const pool of pools) {
        for (const g of groups) {
          const inPool = g.filter((m) => pool.includes(m.id)).length;
          expect(inPool === 0 || inPool === g.length, `${b.id}: группа ${g.map((m) => m.id).join('/')} в пуле не целиком`).toBe(true);
        }
      }
    }
  });

  it('⭐ ДПС оружия двойника = ДПС источника ±5 % (урон × скорость)', () => {
    for (const g of groups) {
      const ref = gearDps(weaponOf(g[0]!));
      for (const m of g) {
        const d = gearDps(weaponOf(m)) / ref - 1;
        expect(Math.abs(d), `${m.id} (${m.weapon}) против ${g[0]!.id}: ${(d * 100).toFixed(1)} %`).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('⭐ ДПС после деривации по уровням 1…60: в среднем ±2 %, на любом уровне ±8 % (округление малых чисел)', () => {
    for (const g of groups) {
      for (const m of g.slice(1)) {
        let sum = 0, worst = 0;
        for (let L = 1; L <= 60; L++) {
          const d = derivedDps(m, L) / derivedDps(g[0]!, L) - 1;
          sum += d;
          if (Math.abs(d) > Math.abs(worst)) worst = d;
        }
        expect(Math.abs(sum / 60), `${m.id}: среднее ${(sum / 60 * 100).toFixed(2)} %`).toBeLessThanOrEqual(0.02);
        expect(Math.abs(worst), `${m.id}: худший уровень ${(worst * 100).toFixed(1)} %`).toBeLessThanOrEqual(0.08);
      }
    }
  });

  it('⭐ вид урона двойника = вид урона источника: броня героя режет только физику, стихию — нет', () => {
    for (const g of groups) {
      const src = weaponOf(g[0]!);
      for (const m of g) {
        expect(weaponOf(m).damageType, `${m.id} (${m.weapon}) против ${g[0]!.id} (${src.id})`).toBe(src.damageType);
      }
    }
  });

  it('⭐ в НАСТОЯЩЕМ бою двойник бьёт героя как источник: ±10 % в среднем, ±30 % на любой клетке', () => {
    // Равный ДПС оружия — ещё не равный урон по герою: холодный жезл бил воина в латах на +40…+60 % сильнее
    // метателя (броня не режет стихию). Клетка = класс × уровень, у каждой клетки свои сиды — шум не складывается.
    const avg = (id: string, cls: string, level: number, cell: number): number => {
      let sum = 0;
      for (let i = 1; i <= FIGHT_SEEDS; i++) sum += incomingDps(id, cls, level, cell * 100 + i);
      return sum / FIGHT_SEEDS;
    };
    for (const g of groups) {
      const cells = FIGHT_CLASSES.flatMap((cls) => FIGHT_LEVELS.map((level) => ({ cls, level })));
      const ref = cells.map((c, i) => avg(g[0]!.id, c.cls, c.level, i));
      for (const m of g.slice(1)) {
        const d = cells.map((c, i) => avg(m.id, c.cls, c.level, i) / ref[i]! - 1);
        const mean = d.reduce((s, x) => s + x, 0) / d.length;
        const msg = `${m.id} против ${g[0]!.id}: ` + cells.map((c, i) => `${c.cls} ${c.level} ${(d[i]! * 100).toFixed(0)} %`).join(', ');
        expect(Math.abs(mean), `${msg}; среднее ${(mean * 100).toFixed(1)} %`).toBeLessThanOrEqual(0.1);
        for (const x of d) expect(Math.abs(x), msg).toBeLessThanOrEqual(0.3);
      }
    }
  }, 120_000);

  it('доля слота: нет поля — 1, мусор прижимается в [0, 1], вес масштабируется ровно на долю', () => {
    const tiers = reg.get('depth-tiers');
    const m = monsters.find((x) => x.id === 'zombie')!;
    expect(spawnShareOf({})).toBe(1);
    expect(spawnShareOf({ spawnShare: 0.25 })).toBe(0.25);
    expect(spawnShareOf({ spawnShare: 7 })).toBe(1);
    expect(spawnShareOf({ spawnShare: -1 })).toBe(0);
    expect(spawnShareOf({ spawnShare: Number.NaN })).toBe(0);
    for (const floor of [1, 5, 30]) {
      expect(spawnWeightAt({ ...m, spawnShare: 0.5 }, tiers, floor)).toBeCloseTo(spawnWeightAt({ ...m, spawnShare: 1 }, tiers, floor) / 2, 9);
    }
    expect(spawnWeightAt({ ...m, spawnShare: 0.5 }, [], 1)).toBe(0.5);
  });
});
