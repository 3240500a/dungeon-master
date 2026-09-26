import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { itemFromBase } from './itemgen.js';
import { avgStatusStacks, weaponCard } from './craftCard.js';
import { combatStatsOf } from './playerCombat.js';
import { mergeElementOnHit, weaponDebuffs } from './resolveWeapon.js';
import { makePlayerModel, newBotSave } from '../sim/playerBot.js';
import { resolvePlayerHit, type HitTarget } from '../world/combat.js';
import { STATUS_CHANCE_CAP, newDebuffState, statusChance } from '../world/debuffs.js';
import { emptyPacket, type CombatStats, type DamagePacket } from '../types/combat.js';
import type { DerivedStats } from '../types/attributes.js';
import type { Item } from '../types/items.js';
import type { Rng } from './rng.js';

/**
 * ⭐ ПОКАЗ ≡ СЕРВЕР для шанса статуса (docs/CRAFT_WEAPONS.md §20). Карточка оружия обязана обещать
 * РОВНО тот шанс, который катает бой (`resolvePlayerHit`), — и с тем же потолком 0.95. Сверяем не
 * формулу с формулой, а число карточки с числом, которое бой реально передал в бросок.
 */

const reg = new ConfigRegistry();
reg.loadAll();

const baseOf = (id: string) => reg.get('items.base').find((b) => b.id === id)!;
const make = (id: string): Item => itemFromBase(baseOf(id), reg.get('item-tiers'));

/** Цель-манекен: без уклонения и блока — удар доходит до бросков статуса. */
const dummy = (): HitTarget => ({
  hp: 1e9, maxHp: 1e9, debuffs: newDebuffState(),
  stats: {
    accuracy: 0, evade: 0, armor: 0, armorPen: 0, blockChance: 0, critChance: 0, critMultiplier: 1.5,
    resFire: 0, resCold: 0, resLightning: 0, resPoison: 0, ailmentPct: 0, level: 1,
  },
});

/** Rng-самописец: пишет шанс каждого броска и всегда «успешен» при p > 0. */
function recorder(): { log: number[]; rng: Rng } {
  const log: number[] = [];
  const rng: Rng = {
    next: () => 0, int: (a) => a, float: (a) => a, pick: (arr) => arr[0]!,
    chance: (p) => { log.push(p); return 0 < p; },
  };
  return { log, rng };
}

/** Шанс, который БОЙ передаёт в бросок статуса `kind` при базовой атаке этим оружием. */
function serverStatusChance(combat: CombatStats, weapon: Item, packet: DamagePacket, kind: string): number {
  // Тот же состав onHit, что у базовой атаки в сессии: статус подтипа + стихийные по пакету.
  const onHit = mergeElementOnHit(
    weaponDebuffs(weapon, reg.get('phys-subtypes'), reg.get('debuffs')),
    packet, reg.get('magic-subtypes'), reg.get('debuffs'),
  );
  const idx = onHit.findIndex((a) => a.kind === kind);
  expect(idx, `бой не вешает ${kind} этим оружием`).toBeGreaterThanOrEqual(0);
  // Сколько бросков делает сам удар (попадание/блок/крит) — статусы катаются следом, по порядку onHit.
  const pre = recorder();
  resolvePlayerHit(dummy(), combat, packet, {}, pre.rng, 0);
  const r = recorder();
  const res = resolvePlayerHit(dummy(), combat, packet, { onHit }, r.rng, 0);
  expect(res.hit).toBe(true);
  return r.log[pre.log.length + idx]!;
}

describe('⭐ шанс статуса: карточка ковки ≡ бой, с потолком 0.95', () => {
  // Булава (дробящий → ошеломление 0.60) — тот самый вид, что уходил за 100 %; меч — кровотечение;
  // жезл — стихийный статус (холод → заморозка) другой веткой боя.
  const cases: { id: string; packet: DamagePacket }[] = [
    { id: 'mace', packet: { ...emptyPacket(), physical: 100 } },
    { id: 'long-sword', packet: { ...emptyPacket(), physical: 100 } },
    { id: 'frost-wand', packet: { ...emptyPacket(), cold: 100 } },
  ];

  for (const { id, packet } of cases) {
    it(`${id}: число карточки = число броска боя при любых бонусах`, () => {
      const s = newBotSave(reg, 'warrior');
      s.level = 30;
      const weapon = make(id);
      s.equipment.weapon = weapon;
      const m = makePlayerModel(reg, s);
      let sawCap = false;
      for (const ap of [0, 0.5, 1.788, 4, 8]) {   // 8 — чтобы и заморозка (база 0.15) упёрлась в потолок
        for (const kc of [0, 0.6]) {
          const probe = weaponCard(reg, { derived: m.derived, attrs: m.attrs, weapon, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval });
          const kind = probe.status!.kind;
          const d = { ...m.derived, ailmentPct: ap, [`${kind}ChancePct`]: kc } as DerivedStats;
          const card = weaponCard(reg, { derived: d, attrs: m.attrs, weapon, scaling: m.scaling, weights: m.weights, attackInterval: m.attackInterval });
          const st = card.status!;
          const server = serverStatusChance(combatStatsOf(d, s.level), weapon, packet, kind);
          expect(st.chance, `${id}: ailmentPct ${ap}, шанс вида ${kc}`).toBe(server);
          expect(st.chance).toBeLessThanOrEqual(STATUS_CHANCE_CAP);
          expect(st.chance).toBe(statusChance(st.baseChance, 1 + ap + kc));
          expect(st.capped).toBe(st.rawChance > STATUS_CHANCE_CAP);
          if (st.capped) { sawCap = true; expect(st.chance).toBe(STATUS_CHANCE_CAP); }
        }
      }
      expect(sawCap, 'ни один набор бонусов не упёрся в потолок — тест не проверил главное').toBe(true);
    });
  }

  it('средние стаки считаются с потолком: «100 %» на входе = 95 %', () => {
    expect(avgStatusStacks(1, 1.2, 4, 5)).toBe(avgStatusStacks(STATUS_CHANCE_CAP, 1.2, 4, 5));
    expect(avgStatusStacks(3, 1.2, 4, 5)).toBe(avgStatusStacks(STATUS_CHANCE_CAP, 1.2, 4, 5));
  });
});
