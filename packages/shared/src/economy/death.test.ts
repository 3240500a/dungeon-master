import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { newBotSave } from '../sim/playerBot.js';
import { materialItem } from './materials.js';
import { applyDeathPenalty } from './death.js';
import type { Item } from '../types/items.js';
import type { SaveState } from '../types/save.js';

function reg(): ConfigRegistry {
  const r = new ConfigRegistry();
  r.loadAll();
  return r;
}
const PENALTY = { goldPercent: 0.25, inventoryDropPercent: 0.3, materialStackLossPercent: 0.5 };
const IRON = { id: 'iron-1', name: 'Ржавое железо', family: 'iron', tier: 1 };

describe('applyDeathPenalty (штраф смерти, авторитетно над save)', () => {
  it('списывает долю золота и часть инвентаря; экипировку сохраняет', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.gold = 1000;
    const weapon = save.equipment.weapon!;
    for (let i = 0; i < 10; i++) save.inventory.push({ ...weapon, uid: `inv${i}` });
    const equipBefore = { ...save.equipment };

    const res = applyDeathPenalty(save, PENALTY, createRng(1));

    expect(res.goldLost).toBe(250);
    expect(save.gold).toBe(750);
    expect(res.itemsLost).toBe(3); // floor(10 * 0.3)
    expect(save.inventory.length).toBe(7);
    expect(save.equipment).toEqual(equipBefore); // экипировка не теряется
  });

  it('0% штраф — ничего не теряется', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.gold = 500;
    const res = applyDeathPenalty(save, { ...PENALTY, goldPercent: 0, inventoryDropPercent: 0 }, createRng(1));
    expect(res).toEqual({ goldLost: 0, itemsLost: 0, materialsLost: 0 });
    expect(save.gold).toBe(500);
  });

  it('⭐ стек сырья теряет ПОЛОВИНУ, а не пропадает целиком', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.inventory = [materialItem(IRON, 800, 'm1')];
    const res = applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 1 }, createRng(1));
    expect(save.inventory).toHaveLength(1);          // стек остался
    expect(save.inventory[0]!.count).toBe(400);      // но похудел вдвое
    expect(res.materialsLost).toBe(400);
    expect(res.itemsLost).toBe(0);                   // стек — не «потерянный предмет»
  });

  it('⚠ жертвы выбираются СЛУЧАЙНО, а не «первые по списку»', () => {
    const r = reg();
    const survivors = new Set<string>();
    // Прежний `splice(0, N)` всегда съедал первые — тогда uid «i0» не выжил бы НИ РАЗУ.
    for (let seed = 1; seed <= 40; seed++) {
      const save = newBotSave(r, 'warrior');
      const weapon = save.equipment.weapon!;
      save.inventory = Array.from({ length: 6 }, (_, i) => ({ ...weapon, uid: `i${i}` } as Item));
      applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 0.5 }, createRng(seed));
      for (const it of save.inventory) survivors.add(it.uid);
    }
    expect(survivors.has('i0')).toBe(true);
    expect(survivors.size).toBe(6);                  // за 40 смертей выживал каждый
  });

  it('⚠ доля теряемого сырья настраивается и считается от КАЖДОГО стека', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.inventory = [materialItem(IRON, 100, 'a'), materialItem({ ...IRON, id: 'wood-1' }, 40, 'b')];
    const res = applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 1, materialStackLossPercent: 0.25 }, createRng(3));
    expect(res.materialsLost).toBe(35);              // 25 + 10
    expect(save.inventory.map((i) => i.count).sort((x, y) => (y ?? 0) - (x ?? 0))).toEqual([75, 30]);
  });

  // ⚠ R13-13: раньше здесь стерегли «не меньше единицы» (`max(1, round)`): одна единица под раздачей терялась ВСЕГДА — вдвое
  // против доли. Теперь дробная доля — броском: ноль от округления вниз по-прежнему не выходит (стек без риска), но и не всегда.
  it('⚠ маленький стек теряется с вероятностью своей доли — не «никогда» от округления и не «всегда»', () => {
    let gone = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      // Штрафу нужны только золото и сумка — полный сейв на две тысячи смертей не нужен.
      const save = { gold: 0, inventory: [materialItem(IRON, 1, 'a')] } as unknown as SaveState;
      const res = applyDeathPenalty(save, { ...PENALTY, inventoryDropPercent: 1 }, createRng(seed));
      expect(res.materialsLost + save.inventory.length).toBe(1);   // стек кончился — ушёл из сумки, иначе цел
      gone += res.materialsLost;
    }
    expect(gone / 2000).toBeGreaterThan(0.47);       // доля 0.5 от одной единицы
    expect(gone / 2000).toBeLessThan(0.53);
  });
});

/**
 * ⚠ R5-21: ДОЛЯ ПОТЕРЬ ОКРУГЛЯЕТСЯ БРОСКОМ, А НЕ ВНИЗ. `floor(n × доля)` при доле 0.5 оставлял сумку из одной вещи без
 * риска вовсе (0 потерь), из трёх — с потерей одной (33 %), из пяти — двух (40 %): нечётная сумка всегда теряла меньше
 * настроенного, а одна ценная находка в пустой сумке переносилась через смерть бесплатно.
 */
describe('⚠ R5-21: потери смерти — настроенная доля при любом размере сумки', () => {
  const r = reg();
  const PEN = { goldPercent: 0, inventoryDropPercent: 0.5, materialStackLossPercent: 0.5 };
  function bag(n: number) {
    const save = newBotSave(r, 'warrior');
    const weapon = save.equipment.weapon!;
    save.inventory = Array.from({ length: n }, (_, i) => ({ ...weapon, uid: `b${i}` } as Item));
    return save;
  }

  it('⭐ одна вещь в сумке теряется в половине смертей (±3 %), а не никогда', () => {
    let lost = 0;
    for (let seed = 1; seed <= 2000; seed++) lost += applyDeathPenalty(bag(1), PEN, createRng(seed)).itemsLost;
    expect(lost / 2000).toBeGreaterThan(0.47);
    expect(lost / 2000).toBeLessThan(0.53);
  });

  it('⭐ из трёх вещей в среднем теряется полторы (а не ровно одна); чётная сумка — ровно половина', () => {
    let lost = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const n = applyDeathPenalty(bag(3), PEN, createRng(seed)).itemsLost;
      expect([1, 2]).toContain(n);
      lost += n;
    }
    expect(lost / 2000).toBeGreaterThan(1.45);
    expect(lost / 2000).toBeLessThan(1.55);
    for (let seed = 1; seed <= 50; seed++) expect(applyDeathPenalty(bag(4), PEN, createRng(seed)).itemsLost).toBe(2);
  });

  it('тот же сид — те же потери (детерминизм для записи и сима)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const a = bag(5), b = bag(5);
      expect(applyDeathPenalty(a, PEN, createRng(seed))).toEqual(applyDeathPenalty(b, PEN, createRng(seed)));
      expect(a.inventory.map((i) => i.uid)).toEqual(b.inventory.map((i) => i.uid));
    }
  });
});

/**
 * ⚠ R13-13: И ДОЛЯ СТЕКА — БРОСКОМ. R5-21 сделал броском число жертв, а попавший под раздачу стек сырья по-прежнему терял
 * `max(1, round(n × доля))`: вверх от половины и не меньше единицы. При живых 0.5 × 0.5 цель — четверть любого стека, а выходило
 * 50 % у одной единицы (ценное сырьё высокой ступени), 33 % у трёх, 30 % у пяти — мелкий запас платил за смерть вдвое.
 */
describe('⚠ R13-13: стек сырья теряет в среднем настроенную долю при любом размере', () => {
  const live = reg().get('balance').deathPenalty;
  const PEN = { goldPercent: 0, inventoryDropPercent: live.inventoryDropPercent, materialStackLossPercent: live.materialStackLossPercent };
  const target = PEN.inventoryDropPercent * PEN.materialStackLossPercent;
  /** Сумка из одного стека: штрафу нужны только золото и сумка — полный сейв на 100 тысяч смертей не нужен. */
  const stackBag = (have: number): SaveState => ({ gold: 0, inventory: [materialItem(IRON, have, 'm')] }) as unknown as SaveState;

  it('цель живого штрафа — дробная доля (иначе мерить нечего)', () => {
    expect(target).toBeGreaterThan(0);
    expect(target).toBeLessThan(1);
  });

  for (const have of [1, 2, 3, 5, 200]) {
    it(`стек из ${have}: доля потерь ≈ ${Math.round(target * 100)} % (±1 %) за 20 000 смертей`, () => {
      const N = 20_000;
      let lost = 0;
      for (let seed = 1; seed <= N; seed++) {
        const save = stackBag(have);
        const res = applyDeathPenalty(save, PEN, createRng(seed));
        const left = save.inventory.reduce((s, it) => s + (it.count ?? 1), 0);
        expect(res.materialsLost + left).toBe(have);     // потеряно + осталось = было
        expect(res.itemsLost).toBe(0);
        lost += res.materialsLost;
      }
      const share = lost / (N * have);
      expect(Math.abs(share - target), `доля ${share.toFixed(4)} против ${target}`).toBeLessThan(0.01);
    });
  }

  it('стек, которому бросок оставил всё, лежит в сумке нетронутым', () => {
    let spared = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const save = stackBag(1);
      const res = applyDeathPenalty(save, { ...PEN, inventoryDropPercent: 1 }, createRng(seed));
      if (res.materialsLost === 0) { spared++; expect(save.inventory).toHaveLength(1); expect(save.inventory[0]!.count).toBe(1); }
      else expect(save.inventory).toHaveLength(0);
    }
    expect(spared).toBeGreaterThan(0);
    expect(spared).toBeLessThan(200);
  });
});

/**
 * ⭐ R22-04: СМЕРТЬ СНИМАЕТ ПУЛЫ, А НЕ ОТКАТЫ. Штраф смерти снимал `vitals` целиком (следующая жизнь — с полными пулами), а с ними — и откаты
 * умений (`vitals.cd`, D4): погибший, ушедший в новую комнату (оборвался и вернулся после смены этажа, «Завершить» в город), входил с готовым
 * кличем. Откат — время героя, не тела.
 */
describe('⭐ R22-04: штраф смерти — пулы долой, откаты героя остаются', () => {
  it('в записи пулы и откаты: после штрафа — только откаты с их меткой; без откатов — записи нет', () => {
    const r = reg();
    const save = newBotSave(r, 'warrior');
    save.vitals = { hp: 12, mana: 3, stamina: 40, at: 1_000, cd: { 'b-class-warrior-a5': 11.5 } };
    applyDeathPenalty(save, PENALTY, createRng(1));
    expect(save.vitals, 'было — undefined: клич готов в новой комнате').toEqual({ at: 1_000, cd: { 'b-class-warrior-a5': 11.5 } });
    const bare = newBotSave(r, 'warrior');
    bare.vitals = { hp: 12, mana: 3, stamina: 40, at: 1_000 };
    applyDeathPenalty(bare, PENALTY, createRng(1));
    expect(bare.vitals).toBeUndefined();
  });
});
