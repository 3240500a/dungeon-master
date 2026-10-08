import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { clientGate, parseCount, parsePercent, pickRelease, rolloutBucket, type Rollout } from './channelRules.js';

/**
 * ⭐ 08.10 (Д3): ПРАВИЛА КАНАЛОВ без базы — корзина раскатки (формула контракта), выбор релиза устройству, флаги версии клиента.
 */
const M = (c: string): string => c.repeat(64).slice(0, 64);
const R = (rollout: number, prev = true): Rollout => ({
  seq: 12, manifest: M('b'), manifestSize: 200, rollout, prev: prev ? { seq: 10, manifest: M('a'), manifestSize: 100 } : null,
});

describe('⭐ Д3: корзина раскатки', () => {
  it('формула контракта: первые 4 байта sha256("id|channel|seq") big-endian по модулю 100', () => {
    const want = createHash('sha256').update('dev-7f3a|live|12').digest().readUInt32BE(0) % 100;
    expect(rolloutBucket('dev-7f3a', 'live', 12)).toBe(want);
    expect(rolloutBucket('dev-7f3a', 'live', 12)).toBe(rolloutBucket('dev-7f3a', 'live', 12));
  });

  it('корзины ровные: на 4000 устройств доля «в 10%» — около десятой', () => {
    let hit = 0;
    for (let i = 0; i < 4000; i++) if (rolloutBucket(`u${i}`, 'live', 12) < 10) hit++;
    expect(hit).toBeGreaterThan(300);
    expect(hit).toBeLessThan(500);
  });

  it('раскатка только растёт: попавший в 10% остаётся с новым на 50%; новая раскатка тасует заново', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `d${i}`);
    const at = (p: number, seq = 12): Set<string> => new Set(ids.filter((id) => pickRelease({ ...R(p), seq }, 'live', id).seq === seq));
    const ten = at(10), fifty = at(50);
    for (const id of ten) expect(fifty.has(id)).toBe(true);
    expect(fifty.size).toBeGreaterThan(ten.size);
    const other = at(10, 13);
    expect([...other].filter((id) => ten.has(id)).length).toBeLessThan(ten.size);
  });
});

describe('⭐ Д3: какой релиз отдать устройству', () => {
  it('100% — новый всем, и без id; 0% — прежний всем', () => {
    expect(pickRelease(R(100), 'live', undefined).seq).toBe(12);
    expect(pickRelease(R(100), 'live', 'x').seq).toBe(12);
    for (let i = 0; i < 50; i++) expect(pickRelease(R(0), 'live', `x${i}`).seq).toBe(10);
  });

  it('без id при раскатке — прежний; прежнего нет — новый', () => {
    expect(pickRelease(R(99), 'live', undefined)).toEqual({ seq: 10, manifest: M('a'), manifestSize: 100 });
    expect(pickRelease(R(10, false), 'live', undefined).seq).toBe(12);
  });
});

describe('⭐ Д3: версия клиента', () => {
  it('ниже minClient — нужен новый; ниже latestClient — доступно обновление; 0 — не задано; без build — 0', () => {
    expect(clientGate(117, 118, 121)).toEqual({ required: true, outdated: true });
    expect(clientGate(118, 118, 121)).toEqual({ required: false, outdated: true });
    expect(clientGate(121, 118, 121)).toEqual({ required: false, outdated: false });
    expect(clientGate(0, 0, 0)).toEqual({ required: false, outdated: false });
    expect(clientGate(0, 1, 0)).toEqual({ required: true, outdated: false });
  });

  it('разбор процента и номеров', () => {
    expect(parsePercent(0)).toBe(0);
    expect(parsePercent(100)).toBe(100);
    expect(parsePercent(101)).toBeNull();
    expect(parsePercent(10.5)).toBeNull();
    expect(parsePercent('10')).toBeNull();
    expect(parseCount(5)).toBe(5);
    expect(parseCount(-1)).toBeNull();
    expect(parseCount(2 ** 60)).toBeNull();
  });
});
