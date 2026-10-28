import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { bossRankAt } from '../formulas/power.js';
import { GameSession } from '../session/session.js';
import { newBotSave } from '../sim/playerBot.js';
import { generateMonster } from '../formulas/monstergen.js';
import { Cell, makeGrid, cellToWorld } from '../world/grid.js';
import type { Item } from '../types/items.js';
import {
  rollSeal, rollSealTier, sealBossCount, sealChestChance, sealDropMul, sealKillChance, sealTiers,
} from './seals.js';

/**
 * ⭐⭐ Ф5-2 (17.10): ОТКУДА БЕРУТСЯ ПЕЧАТИ — ЗАМЕРОМ, А НЕ НА СЛОВО.
 *
 * Правила владельца 16.10, которые здесь сторожатся:
 *  • с РЯДОВЫХ убийств печати не падают никогда (это мусор, а не событие);
 *  • источники — элита/редкий/уник, сундук и ГАРАНТИЯ с босса по рангу;
 *  • множитель прихода — от суммарной опасности отрезка («риск оплачивает следующий риск»);
 *  • ступень растёт с глубиной: до первой метки игрок видит только I («первое знакомство»).
 *
 * ⚠⚠ И главное: ВКЛЮЧЕНИЕ ПЕЧАТЕЙ НЕ СДВИГАЕТ ПОТОК ЛУТА. Броски печати идут там же, где катается лут, поэтому у
 * них свой поток (`sealRng`): иначе те же сид и действия дали бы другие вещи — и каждый прежний замер экономики
 * стал бы врать молча.
 */

const reg = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };

describe('Ф5-2: шансы прихода', () => {
  it('⭐⭐ С РЯДОВОГО — НИКОГДА: строки для него нет в данных вовсе, не «ноль, который кто-то поднимет»', () => {
    const r = reg();
    expect(sealKillChance(r, undefined)).toBe(0);
    expect(sealKillChance(r, 'normal')).toBe(0);
    expect(Object.keys(r.get('balance').seals.drop.byRarity).sort()).toEqual(['magic', 'rare', 'unique']);
  });

  it('⭐ редкость решает шанс: уник > редкий > элита', () => {
    const r = reg();
    expect(sealKillChance(r, 'unique')).toBeGreaterThan(sealKillChance(r, 'rare'));
    expect(sealKillChance(r, 'rare')).toBeGreaterThan(sealKillChance(r, 'magic'));
  });

  it('⭐⭐ ТОПЛИВО ОТ ОПАСНОСТИ: при опасности 1.0 шанс выше ровно на `dangerBonus`', () => {
    const r = reg();
    const bonus = r.get('balance').seals.drop.dangerBonus;
    expect(sealDropMul(r, 0)).toBe(1);
    expect(sealDropMul(r, 1)).toBeCloseTo(1 + bonus, 10);
    expect(sealKillChance(r, 'rare', 1)).toBeCloseTo(sealKillChance(r, 'rare', 0) * (1 + bonus), 10);
    expect(sealChestChance(r, 1)).toBeCloseTo(sealChestChance(r, 0) * (1 + bonus), 10);
    expect(sealKillChance(r, 'unique', 99), 'шанс вылез за единицу').toBeLessThanOrEqual(1);
  });

  it('⭐⭐ ГАРАНТИЯ С БОССА — по рангу лестницы, и это не бросок', () => {
    const r = reg();
    const by = r.get('balance').seals.drop.bossByRank;
    expect(sealBossCount(r, 'mini')).toBe(by.mini);
    expect(sealBossCount(r, 'strong')).toBe(by.strong);
    expect(sealBossCount(r, 'act')).toBe(by.act);
    expect(sealBossCount(r, undefined), 'без ранга гарантии нет').toBe(0);
    expect(by.act, 'актовый босс даёт не больше крепкого — лестница бессмысленна').toBeGreaterThan(by.strong);
  });

  it('⭐ ранг босса — ОДНА чистая функция и для плана, и для гарантии (места 5/14/19, на метке босса нет)', () => {
    const r = reg();
    const a = r.get('balance').dungeonAccess;
    const rank = (d: number): string | undefined => bossRankAt(d, a.portalsAt, a.contentCycle, a.bossLadder);
    for (const row of a.bossLadder) expect(rank(row.at), `место ${row.at}`).toBe(row.rank);
    for (const p of a.portalsAt) expect(rank(p), `на метке ${p} босса быть не должно`).toBeUndefined();
    expect(rank(a.contentCycle + a.bossLadder[0]!.at), 'второй круг — та же лестница').toBe(a.bossLadder[0]!.rank);
  });
});

describe('Ф5-2: ступень растёт с глубиной', () => {
  it('⭐⭐ ПЕРВОЕ ЗНАКОМСТВО ЖИВЁТ В ДАННЫХ: до порога второй ступени падает только I', () => {
    const r = reg();
    const tiers = sealTiers(r);
    const second = tiers.find((x) => x.minDepth > 1)!;
    const rng = createRng(7);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(rollSealTier(r, second.minDepth - 1, rng)!);
    expect([...seen].sort(), `до глубины ${second.minDepth} видно больше одной ступени`).toEqual([tiers[0]!.id]);
  });

  it('⭐ глубже открываются старшие — и остаются реже младших (веса)', () => {
    const r = reg();
    const tiers = sealTiers(r);
    const deep = Math.max(...tiers.map((x) => x.minDepth));
    const rng = createRng(11);
    const cnt: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) { const id = rollSealTier(r, deep, rng)!; cnt[id] = (cnt[id] ?? 0) + 1; }
    for (const t of tiers) expect(cnt[t.id] ?? 0, `ступень ${t.id} не выпала ни разу на глубине ${deep}`).toBeGreaterThan(0);
    const sorted = [...tiers].sort((a, b) => b.weight - a.weight);
    expect(cnt[sorted[0]!.id]!, 'частота не следует весам').toBeGreaterThan(cnt[sorted[sorted.length - 1]!.id]!);
  });

  it('⚠ печати выключены — бросок не даёт ничего (и «выключено» не значит «ступень I»)', () => {
    const r = reg();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, enabled: false } } });
    expect(sealKillChance(r, 'unique')).toBe(0);
    expect(sealChestChance(r)).toBe(0);
    expect(sealBossCount(r, 'act')).toBe(0);
    expect(rollSeal(r, 40, createRng(1))).toBeNull();
  });
});

describe('Ф5-2: настоящая сессия', () => {
  const DEPTH = 12;

  /** Бой на этаже с монстрами ЗАДАННЫХ редкостей; возвращает упавшее. Один и тот же сид — один и тот же бой. */
  function fight(cfg: ConfigRegistry, rarities: string[]): { seals: Item[]; gear: string[]; inv: Item[]; s: GameSession } {
    const s = new GameSession(cfg, 4242, 'normal');
    const save = newBotSave(cfg, 'warrior');
    const p = s.addPlayer('p1', save);
    // Монстры рождаются СВОИМ потоком (как в сторожах Ф5-0): состав боя не зависит от потока сессии.
    const monsters = rarities.map((rar, i) => {
      const def = generateMonster(cfg.get('monsters'), cfg.get('monster-gear'), cfg.get('monster-affixes'),
        { baseId: cfg.get('biomes')[0]!.monsterPool[0]!, depth: DEPTH }, createRng(100 + i));
      def.hp = 1; def.armor = 0; def.rarity = rar as typeof def.rarity;
      const at = cellToWorld(7, 8);
      return { def, x: at.x, y: at.y };
    });
    const grid = makeGrid(24, 16, Cell.Floor);
    s.enterFloor(DEPTH, { grid, spawn: cellToWorld(6, 8), monsters } as never);
    for (let i = 0; i < 900 && s.monstersAlive > 0; i++) {
      const m = s.world.monsters[0]!;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing, attack: true, cast: null, interact: false } as never });
    }
    const items = s.world.drops.filter((d) => d.kind === 'item') as unknown as { item: Item }[];
    return {
      seals: items.filter((d) => d.item.kind === 'seal').map((d) => d.item),
      gear: items.filter((d) => d.item.kind !== 'seal')
        .map((d) => `${d.item.baseId}:${d.item.rarity}:${d.item.tier ?? ''}:${d.item.itemLevel}`),
      inv: p.save.inventory,
      s,
    };
  }

  /** Конфиг, в котором печати гарантированы с небелых (замер правила, а не удачи). */
  function sure(): ConfigRegistry {
    const r = reg();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, drop: { ...b.seals.drop, byRarity: { magic: 1, rare: 1, unique: 1 }, chestChance: 0 } } } });
    return r;
  }

  /** Конфиг с выключенными печатями. */
  function off(): ConfigRegistry {
    const r = reg();
    const b = r.get('balance');
    r.reload({ balance: { ...b, seals: { ...b.seals, enabled: false } } });
    return r;
  }

  const CAST = ['normal', 'normal', 'magic', 'rare'];

  it('⭐⭐ ВКЛЮЧЕНИЕ ПЕЧАТЕЙ НЕ СДВИГАЕТ ПОТОК ЛУТА: вещи с тех же убийств — БИТ В БИТ те же', () => {
    const on = fight(sure(), CAST);
    const no = fight(off(), CAST);
    expect(on.gear, 'лут поехал от самого наличия печатей — значит бросок взят из общего потока').toEqual(no.gear);
    expect(no.seals, 'при выключенных печатях печать всё равно упала').toEqual([]);
    expect(on.seals.length, 'при гарантированном шансе не упало ни одной печати').toBeGreaterThan(0);
  });

  it('⭐⭐ С РЯДОВЫХ НЕ ПАДАЕТ: печатей ровно столько, сколько небелых целей было в бою', () => {
    const r = sure();
    const res = fight(r, CAST);
    const notable = CAST.filter((x) => x !== 'normal').length;
    expect(res.seals.length, `небелых целей ${notable}, рядовых ${CAST.length - notable}`).toBe(notable);
    expect(res.seals.every((it) => !!it.sealId && !!it.sealTier), 'печать без вида или ступени').toBe(true);
    expect(fight(r, ['normal', 'normal', 'normal']).seals, 'с рядовых упало — правило нарушено').toEqual([]);
  });

  it('⭐ ступень упавшего — из доступных НА ЭТОЙ ГЛУБИНЕ (глубже первого порога старших ещё нет)', () => {
    const r = sure();
    const open = sealTiers(r).filter((x) => x.minDepth <= DEPTH).map((x) => x.id);
    const closed = sealTiers(r).filter((x) => x.minDepth > DEPTH).map((x) => x.id);
    const got = fight(r, ['rare', 'rare', 'magic', 'magic']).seals.map((it) => it.sealTier!);
    for (const id of got) {
      expect(open, `ступень ${id} не должна падать на глубине ${DEPTH}`).toContain(id);
      expect(closed).not.toContain(id);
    }
  });

  it('⭐ подобранные печати СЛИВАЮТСЯ В СТЕК, а не занимают клетку каждая', () => {
    const r = sure();
    // ⚠ Замер про СЛИЯНИЕ, а не про разнообразие: оставляем ОДИН вид и ОДНУ ступень, иначе пять
    // печатей законно легли бы в пять клеток (разные пары «вид+ступень» не смешиваются) и сторож ловил бы удачу.
    const b = r.get('balance');
    r.reload({
      seals: [r.get('seals')[0]!],
      balance: { ...b, seals: { ...b.seals, tiers: [b.seals.tiers[0]!] } },
    });
    const res = fight(r, ['rare', 'rare', 'rare', 'magic', 'magic']);
    const dropped = res.seals.length;
    expect(dropped, 'замер бессмыслен: печатей упало меньше двух').toBeGreaterThan(1);
    const inner = res.s as unknown as {
      world: { drops: { kind: string; item?: Item }[]; players: Record<string, unknown> };
      takeDrop(p: unknown, i: number): unknown;
    };
    const p = inner.world.players['p1']!;
    for (let i = inner.world.drops.length - 1; i >= 0; i--) {
      const d = inner.world.drops[i]!;
      if (d.kind === 'item' && d.item?.kind === 'seal') inner.takeDrop(p, i);
    }
    const cells = res.inv.filter((it) => it.kind === 'seal');
    const total = cells.reduce((n, it) => n + (it.count ?? 1), 0);
    expect(total, 'часть печатей при подборе потерялась').toBe(dropped);
    expect(cells.length, `печати заняли по клетке каждая (${cells.length} клеток под ${dropped} печатей)`).toBeLessThan(dropped);
  });
});

describe('Ф5-2: правки по ревизии 17.10', () => {
  const access = (() => { const r = new ConfigRegistry(); r.loadAll(); return r.get('balance').dungeonAccess; })();

  /** Этаж-заготовка: пол, стены по краю, опционально сундук в центре. */
  function floor(withChest: boolean): Record<string, unknown> {
    const g = makeGrid(20, 12, Cell.Floor);
    for (let x = 0; x < 20; x++) { g[0]![x] = Cell.Wall; g[11]![x] = Cell.Wall }
    for (let y = 0; y < 12; y++) { g[y]![0] = Cell.Wall; g[y]![19] = Cell.Wall }
    const c = cellToWorld(6, 7);
    return { grid: g, spawn: cellToWorld(6, 6), monsters: [], ...(withChest ? { chests: [{ id: 1, x: c.x, y: c.y, tier: 'rare' }] } : {}) };
  }

  it('⭐⭐ ГАРАНТИЯ БОССА — ОДИН РАЗ ЗА ЭТАЖ, а не за каждого монстра редкости unique', () => {
    const r = reg();
    const b = r.get('balance');
    // Бросок с убийств выключен нулями — остаётся ровно гарантия, и её видно числом.
    r.reload({ balance: { ...b, seals: { ...b.seals, drop: { ...b.seals.drop, byRarity: { magic: 0, rare: 0, unique: 0 }, chestChance: 0 } } } });
    const at = access.bossLadder[0]!;
    const rank = at.rank;
    const want = sealBossCount(r, rank);
    expect(want, 'стенд: у ранга нет гарантии — мерить нечего').toBeGreaterThan(0);

    const s = new GameSession(r, 4242, 'normal');
    const save = newBotSave(r, 'warrior');
    const p = s.addPlayer('p1', save);
    // ⚠ Боссовая комната форсит `unique` ВСЕЙ пачке — отсюда и бралась утечка: пять чемпионов давали пять гарантий.
    const champs = 5;
    const monsters = Array.from({ length: champs }, (_, i) => {
      const def = generateMonster(r.get('monsters'), r.get('monster-gear'), r.get('monster-affixes'),
        { baseId: r.get('biomes')[0]!.monsterPool[0]!, depth: at.at }, createRng(200 + i));
      def.hp = 1; def.armor = 0; def.rarity = 'unique';
      const pos = cellToWorld(7, 6);
      return { def, x: pos.x, y: pos.y };
    });
    s.enterFloor(at.at, { ...floor(false), monsters } as never);
    for (let i = 0; i < 1200 && s.monstersAlive > 0; i++) {
      const m = s.world.monsters[0]!;
      const facing = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
      s.tick(1 / 30, { p1: { move: { x: 0, y: 0 }, facing, attack: true, cast: null, interact: false } as never });
    }
    const got = s.world.drops.filter((d) => d.kind === 'item' && (d as unknown as { item: Item }).item.kind === 'seal').length;
    // eslint-disable-next-line no-console
    console.log(`Ф5-2 ГАРАНТИЯ: место ${at.at} (${rank}), чемпионов убито ${champs} → печатей ${got} (ранг даёт ${want})`);
    expect(got, `гарантия утекла на каждого чемпиона: ${got} печатей с ${champs} целей`).toBe(want);
  });

  it('⭐⭐ ВКЛЮЧЕНИЕ ПЕЧАТЕЙ НЕ СДВИГАЕТ ЛУТ — И НА ПУТИ СУНДУКА (прежний сторож этого не мерил)', () => {
    const chest = (on: boolean): string[] => {
      const r = reg();
      const b = r.get('balance');
      r.reload({
        balance: {
          ...b,
          seals: on
            ? { ...b.seals, drop: { ...b.seals.drop, byRarity: { magic: 0, rare: 0, unique: 0 }, chestChance: 1, dangerBonus: 0 } }
            : { ...b.seals, enabled: false },
        },
      });
      const s = new GameSession(r, 777, 'normal');
      s.addPlayer('p1', newBotSave(r, 'warrior'));
      s.enterFloor(7, floor(true) as never);
      expect(s.openChest('p1', 1), 'сундук не открылся').toBe(true);
      return s.world.drops
        .filter((d) => d.kind === 'item' && (d as unknown as { item: Item }).item.kind !== 'seal')
        .map((d) => { const it = (d as unknown as { item: Item }).item; return `${it.baseId}:${it.rarity}:${it.tier ?? ''}:${it.itemLevel}` });
    };
    const withSeals = chest(true);
    const without = chest(false);
    expect(withSeals.length, 'сундук не дал вещей — замер бессмыслен').toBeGreaterThan(0);
    expect(withSeals, 'раскладка печати сдвинула содержимое сундука (брала броски из общего потока)').toEqual(without);
  });
});
