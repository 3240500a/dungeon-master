import { describe, it, expect } from 'vitest';
import type { WorldSnapshot, PlayerView, MonsterView, ProjView } from '@dm/shared';
import { SnapshotBuffer } from './snapshotBuffer.js';

function player(id: string, x: number, y: number, facing: number): PlayerView {
  return { id, classId: 'warrior', name: id, x, y, facing, hp: 10, maxHp: 10, mana: 5, stamina: 5, alive: true, debuffs: {}, toggles: [], r: 14 };
}
function monster(id: number, x: number, y: number, facing: number): MonsterView {
  return { id, x, y, facing, hp: 10, maxHp: 10, alive: true, stun: false, debuffs: {}, r: 12, aiState: 'idle' };
}
function proj(id: number, x: number, y: number): ProjView {
  return { id, x, y, owner: 'player', dom: 'physical', r: 3 };
}
function snap(tick: number, x: number, facing = 0): WorldSnapshot {
  return { tick, players: [player('me', x, x, facing)], monsters: [monster(1, x, x, facing)], projectiles: [proj(1, x, x)], drops: [] };
}

describe('SnapshotBuffer — интерполяция чужих сущностей', () => {
  it('лерпит позицию/поворот в середине между двумя снапшотами', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0, 0), 0);
    b.push(snap(1, 100, 1), 100);
    const s = b.sample(50)!;
    expect(s.players[0]!.x).toBeCloseTo(50);
    expect(s.players[0]!.y).toBeCloseTo(50);
    expect(s.players[0]!.facing).toBeCloseTo(0.5);
    expect(s.monsters[0]!.x).toBeCloseTo(50);
    expect(s.projectiles[0]!.x).toBeCloseTo(50);
  });

  it('интерполяция угла идёт по кратчайшей дуге (через ±π, не через 0)', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0, 3.0), 0);       // ~172°
    b.push(snap(1, 0, -3.0), 100);    // ~-172°: короткий путь через π (≈3.14/-3.14), а не через 0
    const f = b.sample(50)!.players[0]!.facing;
    expect(Math.abs(f)).toBeGreaterThan(3.0); // прошли около ±π, а не свалились к 0
  });

  it('до диапазона → старейший, после (starved) → новейший (без экстраполяции)', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0), 100);
    b.push(snap(1, 100), 200);
    expect(b.sample(50)!.players[0]!.x).toBeCloseTo(0);   // раньше первого
    expect(b.sample(999)!.players[0]!.x).toBeCloseTo(100); // позже последнего → новейший, не экстраполируем
  });

  it('пустой буфер → undefined; один снапшот → он сам', () => {
    const b = new SnapshotBuffer();
    expect(b.sample(0)).toBeUndefined();
    b.push(snap(0, 42), 0);
    expect(b.sample(123)!.players[0]!.x).toBe(42);
  });

  it('нефизические поля берутся из целевого снапшота (b), позиции лерпятся', () => {
    const b = new SnapshotBuffer();
    const a = snap(0, 0); a.players[0]!.hp = 10;
    const c = snap(1, 100); c.players[0]!.hp = 4; // «to» = b: hp должен быть его
    b.push(a, 0);
    b.push(c, 100);
    const s = b.sample(50)!;
    expect(s.players[0]!.hp).toBe(4);
    expect(s.players[0]!.x).toBeCloseTo(50);
  });
});
