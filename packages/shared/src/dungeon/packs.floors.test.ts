import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { createRng } from '../formulas/rng.js';
import { spawnPacksEl } from './floor.js';
import { Cell, makeGrid } from '../world/grid.js';
import type { DungeonLayout } from './floorCommon.js';

function reg(): ConfigRegistry { const r = new ConfigRegistry(); r.loadAll(); return r; }

/** Мини-этаж: одна small-комната на сплошном полу 20×20 (spawnPacksEl читает только rooms+grid). */
function oneSmallRoom(): DungeonLayout {
  const grid = makeGrid(20, 20, Cell.Floor);
  return { grid, rooms: [{ x: 2, y: 2, w: 8, h: 8, type: 'small', content: undefined }] } as unknown as DungeonLayout;
}

/** Пачка на N монстров роли-агностик (role:'' → любой из пула), редкость выключена (стабильный count = маркер пачки). */
const pack = (floors: string[], n: number) => ({
  roomType: 'small', floors, entries: [{ role: '', min: n, max: n, magicChance: 0, rareChance: 0 }],
});

/** Число заспавненных монстров = маркер выбранной пачки (её N). seed варьирует случайный выбор среди кандидатов. */
function spawnOn(packs: unknown[], floorId: string, seed = 1): number {
  const r = reg();
  r.reload({ packs });
  const pool = r.get('biomes')[0]!.monsterPool;
  return spawnPacksEl(r, oneSmallRoom(), 1, 'normal', createRng(seed), 10, pool, 1, floorId).length;
}

describe('spawnPacksEl — привязка пачки к этажам (packs[].floors)', () => {
  it('этаж берёт СВОЮ пачку (единственный кандидат = детерминизм): floor-a→A(5), floor-b→B(1)', () => {
    const packs = [pack(['floor-a'], 5), pack(['floor-b'], 1)];
    expect(spawnOn(packs, 'floor-a')).toBe(5); // на floor-a подходит только A
    expect(spawnOn(packs, 'floor-b')).toBe(1); // только B
  });

  it('пустой список floors = пачка на ВСЕХ этажах', () => {
    const packs = [pack([], 3)];
    expect(spawnOn(packs, 'any-floor')).toBe(3);
    expect(spawnOn(packs, 'other')).toBe(3);
  });

  it('пачка чужого этажа НЕ применяется, если есть подходящая (безымянная)', () => {
    const packs = [pack(['floor-a'], 5), pack([], 2)];
    for (let s = 0; s < 12; s++) expect(spawnOn(packs, 'floor-x', s)).toBe(2); // всегда B: A исключена этажом
  });

  it('этаж вне всех списков → фолбэк на пачки того же типа комнаты (обе, не пусто)', () => {
    const packs = [pack(['floor-a'], 5), pack(['floor-b'], 1)];
    const seen = new Set<number>();
    for (let s = 0; s < 30; s++) seen.add(spawnOn(packs, 'floor-zzz', s));
    expect([...seen].every((n) => n === 5 || n === 1)).toBe(true); // фолбэк использует roomType-пачки
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('spawnPacksEl — разнообразие: несколько пачек одного типа+этажа используются ВСЕ', () => {
  it('две small-пачки на floor-a → по сидам встречаются ОБЕ (не только первая)', () => {
    const packs = [pack(['floor-a'], 5), pack(['floor-a'], 1)]; // разные N = маркеры
    const seen = new Set<number>();
    for (let s = 0; s < 40; s++) seen.add(spawnOn(packs, 'floor-a', s));
    expect(seen.has(5), 'первая пачка используется').toBe(true);
    expect(seen.has(1), 'вторая пачка тоже используется (иначе была бы мертва)').toBe(true);
  });
});
