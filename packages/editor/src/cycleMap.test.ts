/**
 * ⭐⭐ Г8-3 (15.10, просьба владельца): СТОРОЖ ВКЛАДКИ «КРУГ ЗАБЕГА» — «в конфиг редактор вынесем настройку этой
 * таблицы, чтобы можно было всё настраивать и тюнить».
 *
 * Что файл обязан валить:
 *  • карту этажей, посчитанную СВОИМИ формулами, а не теми же, что в игре (вторая правда о числах, по которым
 *    владелец тюнит баланс, — ровно то, из-за чего правило «редактор ≡ игра» и появилось);
 *  • настройку, в которой место круга стало И порталом, И боссом (генератор потеряет босса) — без предупреждения;
 *  • круг, у которого после актового босса нет портала (схема владельца: «на 19-м босс, 20-й портал, 21-й по
 *    новой») — тоже без предупреждения;
 *  • молчание на круге вовсе без порталов (игрок не выйдет в город и не выберет старт).
 */
import { describe, it, expect } from 'vitest';
import { ConfigRegistry, bandDepth, isWaypoint, floorMonsterLevel, pickGearTier, type BossRank } from '@dm/shared';
import { bundledWorkingCopy } from './liveConfig.js';
import { cycleWarnings, cycleMapRows } from './cycleMap.js';

type Access = {
  portalsAt: number[]; lookahead: number; contentCycle: number;
  bossLadder: { at: number; rank: BossRank }[];
  bossRanks: Record<BossRank, { levelMult: number; hpMult: number; floorScale: number }>;
  stashEvery: number; stashJitter: number;
};
function copy(): { data: Record<string, unknown>; access: Access } {
  const data = bundledWorkingCopy();
  const access = (data['balance'] as { dungeonAccess: Access }).dungeonAccess;
  return { data, access };
}

describe('⭐⭐ Г8-3: вкладка «Круг забега» редактора', () => {
  it('⭐⭐ КАРТА ЭТАЖЕЙ = ТЕ ЖЕ ФУНКЦИИ, ЧТО В ИГРЕ: место, метка, уровень и ступень снаряжения совпадают до числа', () => {
    const { data, access } = copy();
    const reg = new ConfigRegistry();
    reg.loadAll(data, { cross: false });
    const diff = reg.get('difficulties')[0]!;
    const mg = reg.get('monster-gear-tiers');
    const ladder = new Map(access.bossLadder.map((x) => [x.at, x.rank]));
    const rows = cycleMapRows(data, 100, diff.id);
    expect(rows.length, 'сто этажей').toBe(100);
    for (const r of rows) {
      expect(r.place, `этаж ${r.depth}: место круга`).toBe(bandDepth(r.depth, access.contentCycle));
      const wp = isWaypoint(r.depth, access.portalsAt, access.contentCycle);
      expect(r.kind === 'portal', `этаж ${r.depth}: портал?`).toBe(wp);
      const rank = wp ? undefined : ladder.get(r.place);
      expect(r.kind === 'portal' || r.kind === 'plain' ? undefined : r.kind, `этаж ${r.depth}: ранг`).toBe(rank);
      // Уровень: глубина + надбавка ранга — ровно как кладёт заселение.
      const want = floorMonsterLevel(diff, r.depth) + (rank ? Math.round(access.bossRanks[rank].levelMult) : 0);
      expect(r.level, `этаж ${r.depth}: уровень монстров`).toBe(want);
      expect(r.mGear, `этаж ${r.depth}: ступень снаряжения монстра`).toBe(pickGearTier(mg, {}, want)?.id ?? '—');
    }
  });

  it('⭐ СТУПЕНЬ СНАРЯЖЕНИЯ МЕНЯЕТСЯ НА 11/21/31 — и подсветка стоит ровно там', () => {
    const { data } = copy();
    const shifts = cycleMapRows(data, 100, 'normal').filter((r) => r.gearShift).map((r) => r.depth);
    // ⭐⭐ Решение владельца 15.10: ступени сдвинуты на +1, чтобы круг (и босс в его конце) ЗАМЫКАЛ прежнюю ступень.
    expect(shifts.slice(0, 4), 'первые четыре смены гира').toEqual([11, 21, 31, 41]);
    for (const d of shifts) expect(d % 10, `смена гира на ${d}-м — на первом этаже десятка`).toBe(1);
  });

  it('⚠⚠ ПРОТИВОРЕЧИЕ В ТАБЛИЦЕ ВИДНО СРАЗУ: портал и босс на одном месте — предупреждение про ПОТЕРЯННОГО босса', () => {
    const { access } = copy();
    expect(cycleWarnings(access), 'штатная настройка чиста').toEqual([]);
    const bad = { ...access, bossLadder: [...access.bossLadder, { at: access.portalsAt[0]!, rank: 'mini' as BossRank }] };
    const w = cycleWarnings(bad);
    expect(w.some((x) => x.includes('БОСС ПОТЕРЯН')), 'сказано, что босса не будет').toBe(true);
  });

  it('⚠ КРУГ БЕЗ ПОРТАЛА ЗА АКТОВЫМ БОССОМ И БЕЗ ПОРТАЛОВ ВОВСЕ — оба случая названы словами', () => {
    const { access } = copy();
    const act = access.bossLadder.find((x) => x.rank === 'act')!;
    // Убираем портал, который стоял сразу за актовым боссом (место 20 при цикле 20).
    const noSeam = { ...access, portalsAt: access.portalsAt.filter((p) => p !== act.at + 1) };
    expect(cycleWarnings(noSeam).some((x) => x.includes('сразу портала нет')), 'шов круга назван').toBe(true);
    expect(cycleWarnings({ ...access, portalsAt: [] }).some((x) => x.includes('Порталов НЕТ')), 'круг без порталов').toBe(true);
    expect(cycleWarnings({ ...access, bossLadder: access.bossLadder.filter((x) => x.rank !== 'act') })
      .some((x) => x.includes('Актового босса в круге нет')), 'круг нечем замкнуть').toBe(true);
  });

  it('⚠ МЕСТО ВНЕ КРУГА И КРИВЫЕ РАНГИ: предупреждение на каждое — настройка переживёт, игрок почувствует', () => {
    const { access } = copy();
    expect(cycleWarnings({ ...access, portalsAt: [...access.portalsAt, access.contentCycle + 5] })
      .some((x) => x.includes('вне круга')), 'портал за краем круга').toBe(true);
    expect(cycleWarnings({ ...access, bossLadder: [{ at: 999, rank: 'act' }] })
      .some((x) => x.includes('вне круга')), 'босс за краем круга').toBe(true);
    const weak = { ...access, bossRanks: { ...access.bossRanks, act: { ...access.bossRanks.act, hpMult: 1 } } };
    expect(cycleWarnings(weak).some((x) => x.includes('не по возрастанию')), 'мини тяжелее актового').toBe(true);
    const huge = { ...access, bossRanks: { ...access.bossRanks, act: { ...access.bossRanks.act, floorScale: 2.5 } } };
    expect(cycleWarnings(huge).some((x) => x.includes('потолок схемы')), 'этаж упрётся в потолок').toBe(true);
  });

  it('⭐ БОЛЬШОЙ РАЗРЫВ МЕЖДУ МЕТКАМИ НАЗЫВАЕТСЯ ЧИСЛОМ (считая ШОВ КРУГА, а не только внутри него)', () => {
    const { access } = copy();
    // Только первое место круга: внутри разрывов нет вовсе, а на шве — почти весь круг.
    const w = cycleWarnings({ ...access, portalsAt: [3], bossLadder: [] });
    const gap = w.find((x) => x.includes('разрыв между метками'));
    expect(gap, 'разрыв назван').toBeTruthy();
    expect(gap, 'и назван именно шов круга').toContain('следующего круга');
  });
});
