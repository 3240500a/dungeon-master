import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ⚠ R1-21: АНАЛИТИЧЕСКИЕ СИМЫ ВЫБИРАЮТ МОНСТРА ТАК ЖЕ, КАК ИГРА — по весу спавна на этаже
 * (`spawnWeightAt`: кривая глубины × доля слота `spawnShare`), а не поштучно.
 *
 * Двойники (та же заготовка с другим оружием) делят вес источника: в игре состав пачек по роли и тиру от
 * них не сдвинулся. Сим, выбиравший равномерно, раздул метателей в «Бое» с 1/13 до 4/19, а лорда в роли
 * воина — до 1/8 при нулевом весе на мелководье; числа TTK и выживания в редакторе ехали не от баланса.
 *
 * Бой подменён пустышкой: тест меряет СОСТАВ, а не исход, и так он быстрый. Выбор ловится на входе
 * `generateMonster` — ровно та точка, где сим называет монстра.
 */
const seen = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock('../formulas/monstergen.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../formulas/monstergen.js')>();
  return {
    ...orig,
    generateMonster: (...args: Parameters<typeof orig.generateMonster>) => {
      seen.ids.push(args[3].baseId ?? '');
      return orig.generateMonster(...args);
    },
  };
});

vi.mock('./fight.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./fight.js')>();
  const won = (startHp = 100) => ({
    win: true, timeSec: 1, playerHpFrac: 1, endHp: startHp, endMana: 0, dpsOut: 0, dpsIn: 0, monstersKilled: 0, xp: 0,
  });
  return {
    ...orig,
    simulateFight: (_m: unknown, _p: unknown, _r: unknown, opts: { startHp?: number } = {}) => won(opts.startHp),
    simulateFights: (make: (r: unknown) => unknown, _m: unknown, iterations: number, rng: unknown) => {
      for (let i = 0; i < iterations; i++) make(rng);
      return { winRate: 1, avgTimeSec: 1, avgHpFracOnWin: 1, avgDpsOut: 0, avgDpsIn: 0 };
    },
  };
});

import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { spawnWeightAt } from '../formulas/spawnWeight.js';
import { newBotSave } from './playerBot.js';
import { runSim } from './run.js';
import { simulateFloor } from './floor.js';
import { DEFAULT_BUILD, type SimSettings } from './types.js';

const reg = new ConfigRegistry();
reg.loadAll();
const monsters = reg.get('monsters');
const byId = new Map(monsters.map((m) => [m.id, m]));
const pool = reg.get('biomes')[0]!.monsterPool.filter((id) => byId.get(id)?.enabled !== false);
const weight = (id: string, floor: number): number => spawnWeightAt(byId.get(id)!, reg.get('depth-tiers'), floor);
const roleOf = (id: string): string => byId.get(id)?.role ?? '';

/** Частота каждого id среди `ids` (доля от всех). */
function freq(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1 / ids.length);
  return out;
}

/** Ожидаемая доля по весу игры среди кандидатов `ids` на этаже `floor`. */
function expected(ids: readonly string[], floor: number): Map<string, number> {
  const total = ids.reduce((s, id) => s + weight(id, floor), 0);
  return new Map(ids.map((id) => [id, weight(id, floor) / total]));
}

function expectClose(got: Map<string, number>, want: Map<string, number>, tol: number, tag: string): void {
  for (const id of new Set([...got.keys(), ...want.keys()])) {
    expect(Math.abs((got.get(id) ?? 0) - (want.get(id) ?? 0)), `${tag} ${id}: ${(got.get(id) ?? 0).toFixed(3)} против ${(want.get(id) ?? 0).toFixed(3)}`).toBeLessThan(tol);
  }
}

beforeEach(() => { seen.ids.length = 0; });

describe('⚠ R1-21: сим выбирает монстра по весу спавна игры, двойники делят вес источника', () => {
  it('в пуле крипты есть двойники — тесту есть что сторожить', () => {
    expect(pool.some((id) => (byId.get(id)?.spawnShare ?? 1) < 1)).toBe(true);
  });

  it('⭐ «Бой»: доля каждого монстра = его вес игры; метатели все вместе — как один источник, а не 4/19', () => {
    const floor = 5;
    const settings: SimSettings = {
      scenario: 'fight', classId: reg.get('classes')[0]!.id, difficultyId: 'normal', level: 10, floor,
      targetLevel: 10, maxHours: 1, iterations: 4000, seed: 77, build: DEFAULT_BUILD, floorOverheadSec: 20,
    };
    runSim(reg, settings);
    expect(seen.ids.length).toBe(settings.iterations * 3);
    const got = freq(seen.ids);
    const want = expected(pool, floor);
    expectClose(got, want, 0.015, 'бой');
    const throwers = pool.filter((id) => roleOf(id) === 'thrower');
    const share = (m: Map<string, number>): number => throwers.reduce((s, id) => s + (m.get(id) ?? 0), 0);
    expect(Math.abs(share(want) - throwers.length / pool.length), 'сторож видит разницу с равномерным').toBeGreaterThan(0.05);
    expect(Math.abs(share(got) - share(want))).toBeLessThan(0.015);
  });

  it('⭐ «Этаж»: внутри роли — по весу игры (лорд воинам не 1/8, а свой вес); фолбэк без роли — по всему пулу', () => {
    const floor = 12;
    const save = newBotSave(reg, reg.get('classes')[0]!.id);
    const diff = reg.get('difficulties').find((d) => d.id === 'normal') ?? reg.get('difficulties')[0]!;
    const rng = createRng(4242);
    for (let i = 0; i < 700; i++) simulateFloor(reg, save, diff, floor, DEFAULT_BUILD, 20, rng);
    const byRole = new Map<string, string[]>();
    for (const id of seen.ids) (byRole.get(roleOf(id)) ?? byRole.set(roleOf(id), []).get(roleOf(id))!).push(id);
    const warriors = byRole.get('warrior') ?? [];
    expect(warriors.length, 'воинов набралось на замер').toBeGreaterThan(3000);
    const cand = pool.filter((id) => roleOf(id) === 'warrior');
    expectClose(freq(warriors), expected(cand, floor), 0.025, 'воин');
    const lord = pool.find((id) => byId.get(id)?.tier === 'boss' && roleOf(id) === 'warrior');
    if (lord) expect(Math.abs((expected(cand, floor).get(lord) ?? 0) - 1 / cand.length), 'сторож видит разницу с равномерным').toBeGreaterThan(0.03);
  });
});
