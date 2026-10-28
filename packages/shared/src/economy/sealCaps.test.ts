import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { generateMonster } from '../formulas/monstergen.js';
import { floorMonsterLevel } from '../formulas/power.js';
import { applyMonsterBuffs } from '../dungeon/floor.js';
import { NO_RUN_BUFFS, type RunModBuffs } from '../dungeon/run/runModEffects.js';
import { RUN_MOD_DANGER_STATS } from '../config/schemas.js';
import { monsterPicker } from '../sim/floor.js';
import { prepBot } from '../sim/run.js';
import { DEFAULT_BUILD } from '../sim/types.js';
import { microFightStats } from '../session/microFight.js';
import { sealBuffs, sealCapOf, sealDangerCapPerSeal, sealDangerOf, sealKey, sealSlots, sealTiers } from './seals.js';
import type { ScaledMonster } from '../types/world.js';
import type { SaveState } from '../types/save.js';

/**
 * ⭐⭐ 23.10: ЗАМЕР ttk → ПОТОЛКИ ПЕЧАТЕЙ. Открытый вопрос 4 плана («какой потолок считать дорогим, но
 * проходимым») закрывается не глазомером, а боем на настоящем `GameSession` (`session/microFight.ts` — тот же
 * оракул, которым мерят ttk оружия).
 *
 * ПОСТАНОВКА. Герой — `prepBot` (стипендия + магазин + скиллы/пассивы: один и тот же «честный боец», которым
 * сим мерит баланс), пачка — три монстра этажа, СОСТАВ ФИКСИРОВАН (клоны): иначе каждая точка развёртки мерила
 * бы ещё и состав. 20 прогонов на точку, ограничение боя 40 с.
 *
 * ⚠⚠ ПОЧЕМУ ТОЧКА ОДНА (этаж 10, уровень 34, а не 10/40/80/200 как планировалось). Замер показал, что
 * `prepBot` УРОВНЯ ЭТАЖА этаж не берёт вовсе: на 10-м ему нужен уровень 34, на 40-м калибровка уехала за 400 и
 * бой уходил в «стену» (монстра не добить за 40 с). Это про НЕЗАКРЫТУЮ кривую силы монстров
 * ([[monster-power-plan]]: 11 развилок ждут владельца), а не про печати, — поэтому числа взяты на единственной
 * точке, где база чистая (kill 1.00, death 0.00), и пересчитывать их придётся, когда кривая закроется.
 * ⚠ Бот слабее живого игрока (не пьёт зелья по уму, не уводит пачку), так что потолки получились
 * КОНСЕРВАТИВНЫЕ — для ПОТОЛКА это правильная сторона ошибки: он ограничивает худший случай.
 *
 * ЧТО ИМЕННО ИЗМЕРЕНО (линия «дорого, но проходимо» = kill ≥ 0.75 и death ≤ 0.15):
 *   packSize +80 % · monsterHp +80 % · monsterDamage +80 % · monsterAttackSpeed +60 % · monsterMoveSpeed +40 %
 * и СУММА по связке: +60 % — kill 0.90, +70 % — 0.50, +100 % — 0.35, +320 % (четыре печати III) — 0.00.
 * Последнее и есть находка замера: потолки по статам связку РАЗНЫХ видов не держали вовсе.
 */
const reg = new ConfigRegistry();
reg.loadAll();
const classId = reg.get('classes')[0]!.id;
const diff = reg.get('difficulties').find((d) => d.id === 'normal')!;
const DEPTH = 10;
const BASE_N = 3;
/** ⚠ Уровень КАЛИБРОВКИ: на нём база берётся чисто. Поехал баланс — случай «база чистая» падает первым. */
const LVL = 34;
const RUNS = 20;

const DEFS: ScaledMonster[] = (() => {
  const picker = monsterPicker(reg, DEPTH);
  const rng = createRng(DEPTH);
  const cl = floorMonsterLevel(diff, DEPTH);
  return Array.from({ length: BASE_N }, () => generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'), {
    baseId: picker.pick(rng), depth: cl - 1, uniqueXpMult: reg.get('balance').uniqueXpMult,
    mderive: reg.get('monster-derive'), gearTiers: reg.get('monster-gear-tiers'),
    itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'),
    monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques'),
  }, rng));
})();

const SAVE: SaveState = prepBot(reg, classId, LVL, DEFAULT_BUILD, createRng(7));

/** Пачка: размер — множителем `packSize` (клонами фиксированного состава), прочее — НАСТОЯЩИМ швом игры. */
function pack(buffs: RunModBuffs): ScaledMonster[] {
  const n = Math.max(1, Math.round(BASE_N * buffs.packSize));
  const out = Array.from({ length: n }, (_, i) => ({ ...DEFS[i % BASE_N]! }));
  for (const m of out) applyMonsterBuffs(m, { ...buffs, packSize: 1 });
  return out;
}

function fight(buffs: RunModBuffs): { kill: number; death: number; ttk: number; n: number } {
  const monsters = pack(buffs);
  const s = microFightStats(reg, { save: SAVE, monsters, timeCapSec: 40 }, RUNS, 4242);
  return { kill: s.killRate, death: s.deathRate, ttk: s.ttkSec.p50, n: monsters.length };
}

const base = fight(NO_RUN_BUFFS);

describe('⭐⭐ 23.10: потолки печатей — ИЗ ЗАМЕРА ttk', () => {
  it('⭐⭐ база чистая: герой калибровки берёт этаж без печатей (иначе весь замер мерит не то)', () => {
    console.log(`ЗАМЕР ПОТОЛКОВ, база: этаж ${DEPTH}, бот ур.${LVL}, ${BASE_N} монстра, ${RUNS} прогонов → kill ${base.kill.toFixed(2)}, death ${base.death.toFixed(2)}, ttk ${base.ttk.toFixed(1)} с`);
    expect(base.kill, 'база обязана браться ЧИСТО — иначе точка калибровки устарела (пересчитай LVL)').toBe(1);
    expect(base.death, 'на базе герой не умирает').toBe(0);
  });

  /**
   * ⚠ Линия проверяется НА САМОМ ПОТОЛКЕ: именно столько игрок может набрать стопкой одного вида. Слабее —
   * потолок косметический (его некому заметить), сильнее — этаж перестаёт браться, и печать становится не
   * выбором, а ловушкой.
   */
  it('⭐⭐ каждый потолок — «дорого, но проходимо»: на нём бой тяжелее, но ещё берётся', () => {
    const rows: string[] = [];
    for (const stat of ['packSize', 'monsterHp', 'monsterDamage', 'monsterAttackSpeed', 'monsterMoveSpeed'] as const) {
      const cap = sealCapOf(reg, stat);
      const r = fight({ ...NO_RUN_BUFFS, [stat]: 1 + cap });
      rows.push(`${stat.padEnd(19)} потолок +${(cap * 100).toFixed(0)} %: kill ${r.kill.toFixed(2)} death ${r.death.toFixed(2)} ttk ${r.ttk.toFixed(1)} с${stat === 'packSize' ? ` (монстров ${r.n})` : ''}`);
      expect(r.kill, `${stat}: на потолке этаж ещё берётся`).toBeGreaterThanOrEqual(0.7);
      expect(r.death, `${stat}: на потолке смерть не правило`).toBeLessThanOrEqual(0.2);
      expect(r.kill < 1 || r.death > 0 || r.ttk > base.ttk, `${stat}: потолок не косметика — бой обязан стать тяжелее`).toBe(true);
    }
    console.log('ПОТОЛКИ ПО СТАТАМ (на самом потолке)\n  ' + rows.join('\n  '));
  });

  /**
   * ⭐⭐ ГЛАВНАЯ НАХОДКА ЗАМЕРА: потолки по статам держат СТОПКУ ОДНОГО ВИДА и ничего не знают о связке РАЗНЫХ.
   * Поэтому допуск считается и на всю связку (`balance.seals.dangerCapPerSeal` × штук).
   */
  it('⭐⭐ допуск связки = измеренная линия: на нём бой берётся, на полтора допуска — нет', () => {
    /** Связка задана суммой опасности: раскидываем её по четырём статам, как сделали бы четыре разных вида. */
    const spread = (total: number): RunModBuffs => {
      const stats = ['packSize', 'monsterHp', 'monsterDamage', 'monsterMoveSpeed'] as const;
      const out: Record<string, number> = { ...NO_RUN_BUFFS };
      for (const s of stats) out[s] = 1 + total / stats.length;
      return out as RunModBuffs;
    };
    const allow = sealDangerCapPerSeal(reg);
    const at = fight(spread(allow));
    const over = fight(spread(allow * 1.5));
    console.log(`ДОПУСК СВЯЗКИ (на печать +${(allow * 100).toFixed(0)} %)\n  на допуске:        kill ${at.kill.toFixed(2)} death ${at.death.toFixed(2)} ttk ${at.ttk.toFixed(1)} с\n  полтора допуска:   kill ${over.kill.toFixed(2)} death ${over.death.toFixed(2)} ttk ${over.ttk.toFixed(1)} с`);
    expect(at.kill, 'на допуске этаж ещё берётся').toBeGreaterThanOrEqual(0.75);
    expect(over.kill, 'полтора допуска этаж уже НЕ берётся — иначе допуск занижен и печати пресные').toBeLessThan(at.kill);
  });

  it('⭐⭐ связка «по печати старшей ступени в каждое гнездо» зажата допуском, а не только статами', () => {
    const top = sealTiers(reg)[sealTiers(reg).length - 1]!;
    const kinds = reg.get('seals').filter((s) => s.enabled !== false).slice(0, 4);
    const slots = sealSlots(reg, 1000);
    const picks: Record<string, number> = {};
    for (const k of kinds.slice(0, slots)) picks[sealKey(k.id, top.id)] = 1;

    const danger = sealDangerOf(reg, picks);
    const allow = slots * sealDangerCapPerSeal(reg);
    // Без правила та же связка давала бы сумму потолков по статам — её и печатаем рядом, чтобы было видно разницу.
    const byStats = Object.keys(picks).reduce((sum, key) => {
      const def = kinds.find((k) => key.startsWith(`${k.id}@`))!;
      return sum + Math.min(def.danger.value * top.mul, sealCapOf(reg, def.danger.stat));
    }, 0);
    console.log(`СВЯЗКА ${slots}×${top.name}: опасность +${(danger * 100).toFixed(0)} % (допуск +${(allow * 100).toFixed(0)} %); только по статам было бы +${(byStats * 100).toFixed(0)} %`);
    expect(danger, 'связка не выше допуска').toBeLessThanOrEqual(allow + 1e-9);
    expect(byStats, 'замер: по статам порознь та же связка уезжала в непроходимое').toBeGreaterThan(allow);
  });

  it('⭐ награда едет вниз вместе со сжатой опасностью (парные потолки держатся и после допуска связки)', () => {
    const top = sealTiers(reg)[sealTiers(reg).length - 1]!;
    const pursuit = reg.get('seals').find((s) => s.reward.stat === 'gold')!;
    const one = sealBuffs(reg, { [sealKey(pursuit.id, top.id)]: 1 });
    const four = sealBuffs(reg, { [sealKey(pursuit.id, top.id)]: 4 });
    console.log(`ПАРНЫЕ ПОТОЛКИ: 1×${pursuit.name} ${top.name} → золото ×${one.gold.toFixed(2)}; 4× → ×${four.gold.toFixed(2)}`);
    expect(four.gold, 'стопка одного вида не растит благо даром').toBeLessThanOrEqual(one.gold * 1.5 + 1e-9);
  });

  /**
   * ⚠ `monsterRarity` боем в этой постановке не мерится: он множит ШАНСЫ состава, а не статы монстра. Его
   * потолок выведен ИЗ ЗАМЕРА СОСТАВОМ (те же 20 прогонов): один МАГИЧЕСКИЙ в пачке из трёх бесплатен
   * (kill 1.00), один РЕДКИЙ — ровно линия (kill 0.75), два редких — уже нет (kill 0.20). Значит ждать больше
   * ОДНОГО небычного монстра на пачку нельзя, и это проверяется арифметикой по данным пачек.
   */
  it('⭐ потолок редкости: на нём в пачке ждём не больше одного небычного монстра', () => {
    const cap = sealCapOf(reg, 'monsterRarity');
    const packs = reg.get('packs');
    const spec = packs.find((p) => p.roomType === 'small') ?? packs[0]!;
    let perPack = 0;
    for (const e of spec.entries) perPack += ((e.min + e.max) / 2) * ((e.magicChance ?? 0) + (e.rareChance ?? 0));
    const maxCap = 1 / perPack - 1;   // столько дают ДАННЫЕ пачек: выше — ждём больше одного небычного на пачку
    console.log(`ПОТОЛОК РЕДКОСТИ +${(cap * 100).toFixed(0)} %: небычных в пачке «${spec.roomType}» ждём ${(perPack * (1 + cap)).toFixed(2)}; данные пачек дают потолок до +${(maxCap * 100).toFixed(0)} % (замер: 1 редкий = линия, 2 = нет)`);
    expect(cap, 'на потолке редкости пачка не обязана быть из небычных').toBeLessThanOrEqual(maxCap);
  });

  /**
   * ⭐⭐ Ф5-6″ (23.10): ЦЕНА СОБЫТИЙ («Логово» и «Сторожевой») — ИЗ ЗАМЕРА МОЩИ, а не из боя.
   *
   * ⚠⚠ ПОЧЕМУ НЕ БОЕМ. Бот калибровки пачку элиты НЕ БЕРЁТ вовсе: 3 редких против него — 20 смертей из 20, и
   * отношение ttk в таком исходе не определено (делить не на что). Это то же ограничение, что и у потолков
   * выше — кривая силы монстров не закрыта, — поэтому цена события считается в МОЩИ: `hp × maxDamage ×
   * attackSpeed`, медианой (мощь — произведение, у катаного гира среднее гуляет втрое: ×22 против ×62).
   *
   * Валюта у печатей одна — «доля опасности этажа», и цена события = доля, на которую событие поднимает мощь
   * этажа: комната из R комнат с пачками и пачка из N монстров.
   */
  it('⭐⭐ цена событий (`perUnit`) сходится с замером мощи этажа', () => {
    const power = (m: ScaledMonster): number => m.hp * Math.max(1, m.maxDamage) * Math.max(0.1, m.attackSpeed);
    const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
    const sample = (rarity: 'normal' | 'rare' | 'unique', depthPlus = 0, hpMul = 1): number => median(
      Array.from({ length: 200 }, (_, i) => {
        const picker = monsterPicker(reg, DEPTH);
        const rng = createRng(100 + i);
        const cl = floorMonsterLevel(diff, DEPTH);
        const def = generateMonster(reg.get('monsters'), reg.get('monster-gear'), reg.get('monster-affixes'), {
          baseId: picker.pick(rng), depth: cl - 1 + depthPlus, uniqueXpMult: reg.get('balance').uniqueXpMult,
          mderive: reg.get('monster-derive'), gearTiers: reg.get('monster-gear-tiers'),
          itemAffixes: reg.get('monster-item-affixes'), rarities: reg.get('rarities'),
          monsterRarity: reg.get('monster-rarity'), monsterUniques: reg.get('monster-uniques'), rarity,
        }, rng);
        if (hpMul !== 1) def.hp = Math.max(1, Math.round(def.hp * hpMul));
        return power(def);
      }).map((v) => v),
    );
    const pn = sample('normal');
    const pr = sample('rare');
    const mini = reg.get('balance').dungeonAccess.bossRanks.mini;
    const cl = floorMonsterLevel(diff, DEPTH);
    const bonus = Math.max(Math.max(1, Math.round(mini.levelMult)), Math.round(cl * reg.get('monster-derive').bossRoomDepthPct * mini.levelMult));
    const pc = sample('unique', bonus, Math.max(1, mini.hpMult));

    // ⭐⭐ 23.10 (находка ревизии): СОСТАВ ЭТАЖА — ИЗ ДАННЫХ ПАЧЕК, А НЕ КРУГЛОЕ ЧИСЛО. Было «8 комнат × 3
    // монстра = 24», а живые этажи той же глубины несут 40–57: цена чемпиона выходила завышенной почти вдвое,
    // то есть печать получала награду за опасность, которой на этаже нет. Теперь обе величины — данные:
    // средний размер пачки по роли комнаты (`packs`) и модель комнат сима (мелкие/крупные/клад по глубине).
    const packs = reg.get('packs');
    const avgPack = (roomType: string): number => {
      const specs = packs.filter((p) => p.roomType === roomType);
      const use = specs.length ? specs : packs.filter((p) => p.roomType === 'small');
      const sum = use.reduce((s, p) => s + p.entries.reduce((n, e) => n + (e.min + e.max) / 2, 0), 0);
      return use.length ? sum / use.length : 3;
    };
    const smallRooms = 3 + Math.floor(DEPTH / 4) + 0.5;   // модель сима: + rng(0..1), ожидание 0.5
    const largeRooms = 1 + Math.floor(DEPTH / 6);
    const treasureRooms = 0.5;
    const R = smallRooms + largeRooms + treasureRooms;
    const floorMonsters = smallRooms * avgPack('small') + largeRooms * avgPack('large') + treasureRooms * avgPack('treasure');
    // ⚠ Логово забирает САМУЮ КРУПНУЮ комнату (шов сортирует кандидатов по площади) — значит и пачку крупной.
    const lairShare = ((pr / pn - 1) * avgPack('large')) / floorMonsters;
    const champShare = (pc / pn - 1) / floorMonsters;
    const rows = reg.get('run-mod-stats');
    const lairPer = rows.find((s) => s.id === 'elitePacks')!.perUnit;
    const champPer = rows.find((s) => s.id === 'miniBosses')!.perUnit;
    console.log(`ЦЕНА СОБЫТИЙ (медианы мощи, 200 монстров; комнат ${R.toFixed(1)}, монстров на этаже ${floorMonsters.toFixed(0)})\n`
      + `  редкий ×${(pr / pn).toFixed(2)} к обычному, чемпион «мини» ×${(pc / pn).toFixed(2)} (надбавка +${bonus} ур., жизнь ×${mini.hpMult})\n`
      + `  ЛОГОВО (комната редких): замер +${(lairShare * 100).toFixed(0)} % мощи этажа · в данных ${lairPer}\n`
      + `  СТОРОЖЕВОЙ (чемпион в пачке): замер +${(champShare * 100).toFixed(0)} % · в данных ${champPer}`);
    // ⚠ Допуск широкий (±35 %): мощь зависит от пула монстров биома и лестницы гира, и точность здесь не
    // главное — главное, чтобы цена не разошлась с замером В РАЗЫ (тогда событие станет даровым или неподъёмным).
    expect(Math.abs(lairPer - lairShare) / lairShare, `цена логова ${lairPer} против замера ${lairShare.toFixed(2)}`).toBeLessThan(0.35);
    expect(Math.abs(champPer - champShare) / champShare, `цена чемпиона ${champPer} против замера ${champShare.toFixed(2)}`).toBeLessThan(0.35);

    // И честная заметка боем: событие ДОРОГОЕ — бот калибровки его не держит. Это про кривую силы, не про цену.
    const elite = Array.from({ length: BASE_N }, (_, i) => ({ ...DEFS[i]! }));
    for (const m of elite) { m.hp = Math.max(1, Math.round(m.hp * (pr / pn))); }
    const hard = microFightStats(reg, { save: SAVE, monsters: elite, timeCapSec: 40 }, 8, 4242);
    console.log(`  ⚠ бот калибровки против пачки «как редкие» (жизнь ×${(pr / pn).toFixed(1)}): kill ${hard.killRate.toFixed(2)}, death ${hard.deathRate.toFixed(2)} — событие дорогое по построению`);
    expect(hard.killRate, 'событие обязано быть ТЯЖЕЛЕЕ обычной пачки').toBeLessThan(base.kill);
  });

  it('⭐ у каждого опасного стата потолок положительный — иначе печать стала бы чистой наградой', () => {
    for (const stat of RUN_MOD_DANGER_STATS) expect(sealCapOf(reg, stat), `${stat}: потолок 0 = печать без угрозы`).toBeGreaterThan(0);
    expect(sealDangerCapPerSeal(reg), 'допуск связки положителен').toBeGreaterThan(0);
  });
});
