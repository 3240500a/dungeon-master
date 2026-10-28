import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { bossRankAt, isWaypoint, portalPlaces } from '../formulas/power.js';
import { generateFloorFor } from '../dungeon/floorInputs.js';
import { spawnPacksEl } from '../dungeon/floor.js';
import { generateRunPlan, defaultRunConfig } from '../dungeon/run/generateRunPlan.js';
import { resolveMonsterPool } from '../dungeon/floorSpec.js';
import {
  liveSealDefs, sealBossCount, sealBuffs, sealChestChance, sealDangerOf, sealKey, sealKillChance, sealSlots, sealTiers,
} from './seals.js';

/**
 * ⭐⭐ Ф5-2/Ф5-6 (17.10): СКОЛЬКО ПЕЧАТЕЙ ДАЁТ КРУГ — ЗАМЕР ПУТЁМ СЕРВЕРА, А НЕ ПРИКИДКОЙ.
 *
 * ⚠⚠ ЗАЧЕМ. Ручки прихода (`balance.seals.drop`) и лестница гнёзд (`balance.seals.slots`) — ДВА РАЗНЫХ места
 * конфига, и ничто, кроме этого замера, не связывает их между собой. Поставь шанс поменьше — и алтари
 * голодают: игрок доходит до метки, а вставить нечего, то есть вся ветка «настрой отрезок» становится
 * декорацией. Поставь побольше — печати перестают быть событием и превращаются в сырьё, которое некуда деть
 * (ровно эту беду и лечит перековка 3→1).
 *
 * Поэтому сторож держит ОТНОШЕНИЕ, а не число: за круг приходит столько печатей, чтобы хватило заполнить
 * гнёзда на КАЖДОЙ метке круга, и не больше, чем в `GLUT` раз от этой нужды. Числа конфига можно двигать
 * свободно — упадёт он только там, где настройка ломает саму механику.
 *
 * Считается ОЖИДАНИЕМ (шанс × число цели), а не броском: бросок на 20 этажах даёт разброс в разы и сделал бы
 * сторож мигающим. Заселение при этом НАСТОЯЩЕЕ — тот же `generateRunPlan` + `generateFloorFor` + `spawnPacksEl`,
 * что у сервера, с теми же данными: редкость монстров, плотность пачек, размер этажа и сундуки — живые.
 */

/** Во сколько раз приход за круг может превышать нужду гнёзд, прежде чем печать перестанет быть событием. */
const GLUT = 8;

describe('Ф5: приход печатей за круг против лестницы гнёзд', () => {
  const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();

  it('⭐⭐ ЗАМЕР: за круг печатей хватает на гнёзда каждой метки и не кратно больше', () => {
    const bal = reg.get('balance');
    const access = bal.dungeonAccess;
    const cycle = access.contentCycle;
    const places = portalPlaces(access.portalsAt, cycle);
    const cfgRun = defaultRunConfig(reg, 4242);
    const plan = generateRunPlan(reg, cfgRun, undefined, { from: 1, to: cycle });
    const biome = reg.get('biomes').find((b) => b.id === cfgRun.biomeId) ?? reg.get('biomes')[0]!;

    // ⚠ `plan.nodes` — СПИСОК узлов окна, а не карта по id: берём ПЕРВЫЙ узел каждой глубины —
    // контент слоя один и тот же на всех его путях, различаются только рёбра.
    const first = new Map<number, (typeof plan.nodes)[number]>();
    for (const n of plan.nodes) if (!first.has(n.depth)) first.set(n.depth, n);
    const rows: string[] = [];
    let total = 0;
    let notableAll = 0;
    let monstersAll = 0;
    for (let depth = 1; depth <= cycle; depth++) {
      // Узел этой глубины: берём первый узел слоя (ширина слоя на разных путях одна и та же по контенту).
      const node = first.get(depth);
      if (!node) continue;
      const { layout } = generateFloorFor(reg, node.floorSpec, biome);
      const spawned = spawnPacksEl(reg, layout, depth, cfgRun.tier, createRng((node.floorSpec.seed >>> 0) || 1),
        resolveMonsterPool(biome, depth), node.floorSpec.packDensity, node.floorSpec.floorId, 1, node.bossRank);
      let kills = 0;
      const byRarity: Record<string, number> = {};
      for (const sp of spawned) {
        kills += 1;
        const rar = (sp.def.rarity ?? 'normal') as string;
        byRarity[rar] = (byRarity[rar] ?? 0) + 1;
      }
      // Ожидание печатей с этого этажа: убийства по редкости + сундуки + гарантия босса.
      let exp = 0;
      for (const [rar, n] of Object.entries(byRarity)) exp += n * sealKillChance(reg, rar);
      const chests = layout.chests?.length ?? 0;
      exp += chests * sealChestChance(reg);
      // ⚠⚠ ГАРАНТИЯ — ОДИН РАЗ ЗА ЭТАЖ, и это правка кода от 17.10: раньше `bossByRank` платился за КАЖДОГО
      // монстра редкости `unique`, а боссовая комната форсит `unique` ВСЕЙ своей пачке (3.5 / 6.6 / 11.0 на
      // местах 5 / 14 / 19) — замер давал 52.7 печати гарантий за круг вместо задуманных 1+2+3 = 6.
      const rank = bossRankAt(depth, access.portalsAt, cycle, access.bossLadder);
      const guar = rank ? sealBossCount(reg, rank) : 0;
      exp += guar;
      total += exp;
      const notable = kills - (byRarity.normal ?? 0);
      notableAll += notable;
      monstersAll += kills;
      rows.push(`${String(depth).padStart(2)}: монстров ${String(kills).padStart(3)} (небелых ${String(notable).padStart(2)})`
        + ` · сундуков ${chests}${rank ? ` · БОСС ${rank} +${guar}` : ''}${isWaypoint(depth, access.portalsAt, cycle) ? ' · МЕТКА' : ''}`
        + ` → печатей ${exp.toFixed(2)}`);
    }

    // Нужда — по ВСЕЙ лестнице гнёзд: у новичка одно гнездо, у ветерана все. Голод на любой ступени значит
    // «алтарь нечем настроить», перебор на ПОСЛЕДНЕЙ — «печать перестала быть событием».
    const ladder = [...new Set(reg.get('balance').seals.slots.map((s) => s.count))].sort((a, b) => a - b);
    const top = Math.max(...ladder);
    const needTop = places.length * top;
    const spare = ladder.map((n) => `${n} гн. → нужда ${places.length * n}, запас ×${(total / (places.length * n)).toFixed(2)}`);
    // eslint-disable-next-line no-console
    console.log('Ф5 ПРИХОД ПЕЧАТЕЙ ЗА КРУГ (путь сервера, биом ' + biome.id + ')\n  ' + rows.join('\n  ')
      + `\n  ИТОГО за круг: ${total.toFixed(1)} печатей; монстров ${monstersAll} (небелых ${notableAll}); меток ${places.length}`
      + `\n  ЗАПАС ПО ЛЕСТНИЦЕ ГНЁЗД: ${spare.join(' · ')}`
      + `\n  (излишек ветерана — топливо перековки 3→1: ${Math.max(0, total - needTop).toFixed(1)} печатей за круг`
      + ` ≈ ${((Math.max(0, total - needTop)) / reg.get('balance').seals.reforge.need).toFixed(1)} подъёмов ступени)`);

    expect(total, `алтари голодают у ВЕТЕРАНА: за круг ${total.toFixed(1)} против нужды ${needTop}`).toBeGreaterThanOrEqual(needTop);
    expect(total, `печать перестала быть событием: ${total.toFixed(1)} против нужды ${needTop} (потолок ×${GLUT})`)
      .toBeLessThanOrEqual(needTop * GLUT);
    // ⚠ И отдельно: приход не должен тонуть в гарантиях боссов — иначе рядовые этажи перестают быть источником.
    expect(sealBossCount(reg, 'act') + sealBossCount(reg, 'strong') + sealBossCount(reg, 'mini'))
      .toBeLessThan(total / 2);
  });

  /**
   * ⭐⭐ 23.10 (ПРОБЕЛ РЕВИЗИИ): ПРИХОД ПЕЧАТЕЙ ПОД СВЯЗКОЙ. Замер выше считает круг БЕЗ печатей, то есть петля
   * правила 4 («риск оплачивает следующий риск») оставалась вне наблюдения вовсе.
   *
   * ⚠ Здесь не инвариант, а ПЕЧАТЬ ЗАМЕРА с одним зубом: приход под связкой обязан быть БОЛЬШЕ, но не
   * бесконечно больше — иначе петля сама себя кормит и печати перестают быть решением. Балансное число
   * (`balance.seals.drop.dangerBonus`) двигает владелец, и ему нужен этот ряд перед глазами.
   */
  it('⭐⭐ ЗАМЕР: сколько печатей возвращает круг ПОД СВЯЗКОЙ (петля правила 4)', () => {
    const bal = reg.get('balance');
    const access = bal.dungeonAccess;
    const cycle = access.contentCycle;
    const cfgRun = defaultRunConfig(reg, 4242);
    const plan = generateRunPlan(reg, cfgRun, undefined, { from: 1, to: cycle });
    const biome = reg.get('biomes').find((b) => b.id === cfgRun.biomeId) ?? reg.get('biomes')[0]!;
    const first = new Map<number, (typeof plan.nodes)[number]>();
    for (const n of plan.nodes) if (!first.has(n.depth)) first.set(n.depth, n);

    /** Ожидание печатей за круг при заданной связке (её опасность множит шансы — `sealDropMul`). */
    const circle = (picks: Record<string, number>): { seals: number; danger: number; monsters: number } => {
      const buffs = sealBuffs(reg, picks, biome.id);
      const danger = sealDangerOf(reg, picks, biome.id);
      let seals = 0;
      let monsters = 0;
      for (let depth = 1; depth <= cycle; depth++) {
        const node = first.get(depth);
        if (!node) continue;
        const { layout } = generateFloorFor(reg, node.floorSpec, biome);
        const spawned = spawnPacksEl(reg, layout, depth, cfgRun.tier, createRng((node.floorSpec.seed >>> 0) || 1),
          resolveMonsterPool(biome, depth), node.floorSpec.packDensity, node.floorSpec.floorId, 1, node.bossRank, buffs);
        monsters += spawned.length;
        const byRarity: Record<string, number> = {};
        for (const sp of spawned) {
          const rar = (sp.def.rarity ?? 'normal') as string;
          byRarity[rar] = (byRarity[rar] ?? 0) + 1;
        }
        for (const [rar, n] of Object.entries(byRarity)) seals += n * sealKillChance(reg, rar, danger);
        seals += (layout.chests?.length ?? 0) * sealChestChance(reg, danger);
        const rank = bossRankAt(depth, access.portalsAt, cycle, access.bossLadder);
        if (rank) seals += sealBossCount(reg, rank);
      }
      return { seals, danger, monsters };
    };

    const tiers = sealTiers(reg);
    const top = tiers[tiers.length - 1]!;
    const kinds = liveSealDefs(reg);
    const bundles: [string, Record<string, number>][] = [['без печатей', {}]];
    for (const n of [1, 2, 4]) {
      const picks: Record<string, number> = {};
      for (const def of kinds.slice(0, n)) picks[sealKey(def.id, top.id)] = 1;
      bundles.push([`${n} разных вида ${top.name}`, picks]);
    }
    const stack: Record<string, number> = { [sealKey(kinds[0]!.id, top.id)]: 4 };
    bundles.push([`стопка 4 × ${kinds[0]!.name} ${top.name}`, stack]);

    const base = circle({});
    const rows: string[] = [];
    for (const [name, picks] of bundles) {
      const r = circle(picks);
      rows.push(`${name.padEnd(34)} опасность +${(r.danger * 100).toFixed(0).padStart(3)} % · монстров ${r.monsters.toString().padStart(4)} · печатей ${r.seals.toFixed(1).padStart(6)} (×${(r.seals / base.seals).toFixed(2)})`);
    }
    const slots = sealSlots(reg, 1000);
    const spend = slots * (access.portalsAt.length || 1);
    console.log(`ЗАМЕР: ПРИХОД ПЕЧАТЕЙ ПОД СВЯЗКОЙ (расход за круг при ${slots} гнёздах — ${spend})\n  ` + rows.join('\n  '));

    const four = circle(Object.fromEntries(kinds.slice(0, 4).map((d) => [sealKey(d.id, top.id), 1])));
    expect(four.seals, 'связка обязана ВОЗВРАЩАТЬ больше: риск оплачивает следующий риск (правило 4)').toBeGreaterThan(base.seals);
    // ⚠ Зуб: петля не должна кормить сама себя без предела. Потолок выбран с запасом к сегодняшним данным
    // (×2.4 при `dangerBonus` 0.6), и его срабатывание — сигнал владельцу, а не поломка кода.
    expect(four.seals / base.seals, 'приход под связкой вырос В РАЗЫ сверх задуманного — пересмотри `drop.dangerBonus`').toBeLessThan(6);
  });

  it('⚠ гарантия босса — заметная доля прихода: без неё сустейн висел бы на броске', () => {
    const access = reg.get('balance').dungeonAccess;
    let guar = 0;
    for (const row of access.bossLadder) guar += sealBossCount(reg, row.rank);
    expect(guar, 'боссы круга не дают ни одной печати — сустейн целиком на случайности').toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`Ф5 ГАРАНТИЯ БОССОВ ЗА КРУГ: ${guar} печатей с ${access.bossLadder.length} боссов`
      + ` (${access.bossLadder.map((b) => `${b.at}:${b.rank}`).join(', ')})`);
  });
});
