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

/** Пачка на N монстров роли-агностик (role:'' → любой из пула), редкость выключена (стабильный count). */
const pack = (floors: string[], n: number) => ({
  roomType: 'small', floors, entries: [{ role: '', min: n, max: n, magicChance: 0, rareChance: 0 }],
});

describe('spawnPacksEl — привязка пачки к этажам (packs[].floors)', () => {
  const spawnOn = (packs: unknown[], floorId: string): number => {
    const r = reg();
    r.reload({ packs });
    const pool = r.get('biomes')[0]!.monsterPool;
    return spawnPacksEl(r, oneSmallRoom(), 1, 'normal', createRng(1), 10, pool, 1, floorId).length;
  };

  it('этаж берёт СВОЮ пачку: floor-a→A(5), floor-b→B(1)', () => {
    const packs = [pack(['floor-a'], 5), pack(['floor-b'], 1)];
    expect(spawnOn(packs, 'floor-a')).toBe(5);
    expect(spawnOn(packs, 'floor-b')).toBe(1);
  });

  it('этаж вне всех списков → фолбэк на первую пачку того же типа комнаты (A)', () => {
    const packs = [pack(['floor-a'], 5), pack(['floor-b'], 1)];
    expect(spawnOn(packs, 'floor-zzz')).toBe(5);
  });

  it('пустой список floors = пачка на ВСЕХ этажах', () => {
    const packs = [pack([], 3)];
    expect(spawnOn(packs, 'any-floor')).toBe(3);
    expect(spawnOn(packs, 'other')).toBe(3);
  });

  it('пачка, привязанная к чужому этажу, НЕ применяется, если есть безымянная (все этажи)', () => {
    // A привязана к floor-a; B — на всех этажах. На floor-x первой подходит только B.
    const packs = [pack(['floor-a'], 5), pack([], 2)];
    expect(spawnOn(packs, 'floor-x')).toBe(2);   // A не подходит (не тот этаж) → B (все этажи)
    expect(spawnOn(packs, 'floor-a')).toBe(5);   // на floor-a первой стоит A
  });
});
